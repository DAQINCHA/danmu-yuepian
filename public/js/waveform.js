/**
 * 纯前端 Web Audio 音频波形轨（第 6 期）：
 *  · 后台独立请求（绕开与 <video> 同 URL 的 HTTP 缓存锁），用 OfflineAudioContext 离线解码音轨；
 *  · 抽取 220 根 Peak+RMS 混合包络柱并存入 IndexedDB，二次打开同一支片 0ms 秒出；
 *  · 超过 160MB 的超大原片自动跳过整片下载解码，避免占满浏览器内存；
 *  · 切视频/离开页面时立即 AbortController 掐断请求，绝不拖慢播放。
 */

const WAVE_BARS = 220;
const MAX_DECODE_BYTES = 160 * 1024 * 1024;
const WAVE_DB_NAME = 'danmu-yuepian-waveforms';
const WAVE_STORE = 'peaks';

let dbPromise = null;

function openWaveDb() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(WAVE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(WAVE_STORE)) {
          db.createObjectStore(WAVE_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function idbGet(key) {
  const db = await openWaveDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(WAVE_STORE, 'readonly');
      const req = tx.objectStore(WAVE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbSet(key, peaks) {
  const db = await openWaveDb();
  if (!db) return;
  try {
    const tx = db.transaction(WAVE_STORE, 'readwrite');
    tx.objectStore(WAVE_STORE).put(peaks, key);
  } catch {
    /* 空间不足或无痕模式，忽略 */
  }
}

/** 兼容现代 Promise 与旧版 Safari 回调式 decodeAudioData */
function decodeWithContext(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (val) => { if (!settled) { settled = true; resolve(val); } };
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    try {
      const ret = ctx.decodeAudioData(arrayBuffer, ok, fail);
      if (ret && typeof ret.then === 'function') ret.then(ok, fail);
    } catch (err) {
      fail(err);
    }
  });
}

/** 优先用 OfflineAudioContext 离线解码，不占声卡通道、不受自动播放挂起与并发上下文数限制 */
async function decodeAudioBuffer(arrayBuffer) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (OfflineCtx) {
    const offline = new OfflineCtx(1, 1, 44100);
    return decodeWithContext(offline, arrayBuffer);
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('Web Audio unavailable');
  const ctx = new AudioCtx();
  try {
    return await decodeWithContext(ctx, arrayBuffer);
  } finally {
    ctx.close?.().catch(() => {});
  }
}

/** 把解码后的 AudioBuffer 压缩成 0~255 的单字节峰值数组，存储极轻（仅 ~220 字节） */
function extractPeaks(audioBuffer, barCount = WAVE_BARS) {
  const channels = Math.min(2, audioBuffer.numberOfChannels || 0);
  if (!channels || !audioBuffer.length) return null;

  const totalSamples = audioBuffer.length;
  const blockSize = Math.max(1, Math.floor(totalSamples / barCount));
  // 大块时抽样步进，既精准又保证几十秒音频在几毫秒内算完
  const step = Math.max(1, Math.floor(blockSize / 512));
  const raw = new Float32Array(barCount);
  const chanData = [];
  for (let c = 0; c < channels; c += 1) chanData.push(audioBuffer.getChannelData(c));

  let maxVal = 0;
  for (let i = 0; i < barCount; i += 1) {
    const start = i * blockSize;
    const end = i === barCount - 1 ? totalSamples : Math.min(totalSamples, start + blockSize);
    let peak = 0;
    let sumSq = 0;
    let count = 0;
    for (let s = start; s < end; s += step) {
      let sample = 0;
      for (let c = 0; c < channels; c += 1) sample += Math.abs(chanData[c][s] || 0);
      sample /= channels;
      if (sample > peak) peak = sample;
      sumSq += sample * sample;
      count += 1;
    }
    const rms = count ? Math.sqrt(sumSq / count) : 0;
    // Peak + RMS 混合：既看得清鼓点瞬态，人声对话也不会被个别爆音压扁
    const val = peak * 0.62 + rms * 0.38;
    raw[i] = val;
    if (val > maxVal) maxVal = val;
  }

  if (!(maxVal > 0.0005)) return null;
  const out = new Uint8Array(barCount);
  for (let i = 0; i < barCount; i += 1) {
    const norm = Math.min(1, raw[i] / maxVal);
    out[i] = Math.round(Math.pow(norm, 0.78) * 255);
  }
  return out;
}

export function createTimelineWaveform(canvas, { onStatus } = {}) {
  if (!canvas) {
    return {
      load() {},
      retry() {},
      setProgress() {},
      setEnabled() {},
      clear() {},
      get status() { return 'idle'; },
    };
  }

  const ctx = canvas.getContext('2d');
  const memCache = new Map();
  let enabled = true;
  let currentVideo = null;
  let peaks = null;
  let progress = 0;
  let lastProgressPx = -1;
  let hasDrawn = false;
  let layoutRetryRaf = 0;
  let layoutRetryCount = 0;
  let abortCtrl = null;
  let delayTimer = 0;
  let runEpoch = 0;
  /** idle | loading | ready | too-large | no-audio | error */
  let status = 'idle';

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus?.(next);
  }

  function cancelPending() {
    clearTimeout(delayTimer);
    delayTimer = 0;
    if (layoutRetryRaf) {
      cancelAnimationFrame(layoutRetryRaf);
      layoutRetryRaf = 0;
    }
    layoutRetryCount = 0;
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }
  }

  function scheduleLayoutDraw() {
    if (layoutRetryRaf || layoutRetryCount >= 12) return;
    layoutRetryCount += 1;
    layoutRetryRaf = requestAnimationFrame(() => {
      layoutRetryRaf = 0;
      draw(true);
    });
  }

  function draw(force = false) {
    if (!enabled || !peaks || !peaks.length) {
      canvas.hidden = true;
      hasDrawn = false;
      return;
    }
    canvas.hidden = false;
    const rect = canvas.getBoundingClientRect();
    // 刚切入看片页时进度条可能尚未完成首帧排版，下一帧自动补画
    if (rect.width < 24 || rect.height < 6) {
      scheduleLayoutDraw();
      return;
    }
    layoutRetryCount = 0;

    const splitPx = Math.round(progress * rect.width);
    if (!force && hasDrawn && splitPx === lastProgressPx) return;
    lastProgressPx = splitPx;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = rect.width;
    const h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 根据实际宽度决定绘制根数，每根约 3px 步进，纤细清透不糊成一团
    const stepPx = 3;
    const barW = 1.6;
    const drawCount = Math.max(12, Math.floor(w / stepPx));
    const midY = h / 2;
    const maxAmp = h * 0.46;

    for (let i = 0; i < drawCount; i += 1) {
      const ratio = drawCount === 1 ? 0 : i / (drawCount - 1);
      const srcIdx = Math.min(peaks.length - 1, Math.floor(ratio * peaks.length));
      const amp = Math.max(1.2, (peaks[srcIdx] / 255) * maxAmp);
      const x = i * stepPx + (stepPx - barW) / 2;
      const played = ratio <= progress;
      ctx.fillStyle = played
        ? 'rgba(127, 240, 234, 0.56)'
        : 'rgba(127, 240, 234, 0.2)';
      ctx.fillRect(x, midY - amp, barW, amp * 2);
    }
    hasDrawn = true;
  }

  function fetchAndDecode(video, key, epoch, attempt = 0) {
    if (epoch !== runEpoch || !enabled) return;
    const delayMs = attempt === 0 ? 180 : 900;
    delayTimer = setTimeout(async () => {
      delayTimer = 0;
      if (epoch !== runEpoch || !enabled) return;
      const ctrl = new AbortController();
      abortCtrl = ctrl;
      let stage = 'fetch';
      try {
        // 带独立查询参数 + cache:'no-store'，彻底避开与 <video> 同 URL 的浏览器 HTTP 缓存排他锁
        const url = `/api/videos/${encodeURIComponent(video.id)}/file?purpose=waveform`;
        const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') || 0);
        if (len > MAX_DECODE_BYTES) {
          ctrl.abort();
          if (epoch === runEpoch) setStatus('too-large');
          return;
        }
        const buf = await res.arrayBuffer();
        if (epoch !== runEpoch || !enabled) return;
        if (buf.byteLength > MAX_DECODE_BYTES) {
          setStatus('too-large');
          return;
        }

        stage = 'decode';
        const decoded = await decodeAudioBuffer(buf);
        if (epoch !== runEpoch || !enabled) return;

        const extracted = extractPeaks(decoded, WAVE_BARS);
        memCache.set(key, extracted);
        if (extracted) {
          peaks = extracted;
          idbSet(key, extracted);
          setStatus('ready');
          draw(true);
        } else {
          peaks = null;
          setStatus('no-audio');
          canvas.hidden = true;
        }
      } catch (err) {
        if (err?.name === 'AbortError' || epoch !== runEpoch) return;
        // 拉流偶发失败时自动静默重试一次，避免误判为「无音轨」
        if (stage === 'fetch' && attempt < 1) {
          fetchAndDecode(video, key, epoch, attempt + 1);
          return;
        }
        console.warn(`[waveform] ${stage} failed:`, err);
        peaks = null;
        canvas.hidden = true;
        setStatus(stage === 'decode' ? 'no-audio' : 'error');
      } finally {
        if (abortCtrl === ctrl) abortCtrl = null;
      }
    }, delayMs);
  }

  async function startLoad(video) {
    if (!enabled || !video?.id) return;
    const epoch = ++runEpoch;
    cancelPending();

    const key = `${video.id}:${video.size || 0}`;
    if (memCache.has(key)) {
      peaks = memCache.get(key);
      setStatus(peaks ? 'ready' : 'no-audio');
      draw(true);
      return;
    }

    setStatus('loading');
    const cached = await idbGet(key);
    if (epoch !== runEpoch || !enabled) return;
    if (cached && cached.length) {
      peaks = cached instanceof Uint8Array ? cached : new Uint8Array(cached);
      memCache.set(key, peaks);
      setStatus('ready');
      draw(true);
      return;
    }

    if (video.size && video.size > MAX_DECODE_BYTES) {
      peaks = null;
      setStatus('too-large');
      canvas.hidden = true;
      return;
    }

    if (!(window.OfflineAudioContext || window.webkitOfflineAudioContext || window.AudioContext || window.webkitAudioContext)) {
      setStatus('no-audio');
      return;
    }

    fetchAndDecode(video, key, epoch, 0);
  }

  if (typeof ResizeObserver === 'function') {
    let raf = 0;
    const observer = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw(true);
      });
    });
    observer.observe(canvas.parentElement || canvas);
  }

  return {
    get status() {
      return status;
    },
    load(video) {
      currentVideo = video || null;
      peaks = null;
      lastProgressPx = -1;
      hasDrawn = false;
      canvas.hidden = true;
      cancelPending();
      if (!currentVideo) {
        setStatus('idle');
        return;
      }
      if (enabled) startLoad(currentVideo);
      else setStatus('idle');
    },
    retry() {
      if (!enabled || !currentVideo) return;
      startLoad(currentVideo);
    },
    setProgress(nextRatio) {
      const clamped = Math.min(1, Math.max(0, Number(nextRatio) || 0));
      progress = clamped;
      if (enabled && peaks) draw(false);
    },
    setEnabled(next) {
      const flag = Boolean(next);
      if (enabled === flag) return;
      enabled = flag;
      if (!enabled) {
        cancelPending();
        canvas.hidden = true;
        hasDrawn = false;
        return;
      }
      if (peaks) draw(true);
      else if (currentVideo) startLoad(currentVideo);
    },
    clear() {
      runEpoch += 1;
      cancelPending();
      currentVideo = null;
      peaks = null;
      progress = 0;
      lastProgressPx = -1;
      hasDrawn = false;
      setStatus('idle');
      canvas.hidden = true;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
