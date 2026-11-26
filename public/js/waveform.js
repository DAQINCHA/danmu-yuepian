/**
 * 音频波形轨（服务端单份共享缓存 + 纯前端零依赖解码）：
 *  · 打开片子优先 GET /api/videos/:id/waveform（仅 ~1KB JSON，全员首次打开 10ms 秒出）；
 *  · 上传新片时直接用本地 File 在本机瞬间解码并 PUT 存到服务端，零回传流量；
 *  · 旧片若服务端还没有缓存，先查本机 IndexedDB 并静默补传服务端；都没有时后台独立拉流
 *    （?purpose=waveform + cache:'no-store' 避开与 <video> 的 HTTP 缓存锁），用 OfflineAudioContext
 *    解码后写回服务端，之后全员秒出。
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

function waveformEndpoint(videoId) {
  return `/api/videos/${encodeURIComponent(videoId)}/waveform`;
}

async function fetchServerWaveform(videoId, signal) {
  try {
    const res = await fetch(waveformEndpoint(videoId), { signal });
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.status === 'no-audio') return { status: 'no-audio', peaks: null };
    if (Array.isArray(data?.peaks) && data.peaks.length >= 16) {
      return { status: 'ok', peaks: Uint8Array.from(data.peaks) };
    }
    return null;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return null;
  }
}

export function createTimelineWaveform(canvas, { onStatus } = {}) {
  if (!canvas) {
    return {
      load() {},
      seedFromFile() {},
      retry() {},
      setProgress() {},
      setEnabled() {},
      clear() {},
      get status() { return 'idle'; },
    };
  }

  const ctx = canvas.getContext('2d');
  const memCache = new Map();
  const uploadedIds = new Set();
  const seedJobs = new Map();
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

  function cacheKey(video) {
    return `${video.id}:${video.size || 0}`;
  }

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus?.(next);
  }

  function uploadServerWaveform(videoId, extracted) {
    if (!videoId || uploadedIds.has(videoId)) return;
    uploadedIds.add(videoId);
    const body = extracted && extracted.length
      ? { status: 'ok', peaks: Array.from(extracted) }
      : { status: 'no-audio', peaks: [] };
    fetch(waveformEndpoint(videoId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {
      uploadedIds.delete(videoId);
    });
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

    const stepPx = 3;
    const barW = 1.6;
    const drawCount = Math.max(12, Math.floor(w / stepPx));
    const midY = h / 2;
    const maxAmp = h * 0.46;

    const styles = getComputedStyle(canvas);
    const playedColor = styles.getPropertyValue('--wave-played').trim() || 'rgba(127, 240, 234, 0.56)';
    const restColor = styles.getPropertyValue('--wave-rest').trim() || 'rgba(127, 240, 234, 0.2)';

    for (let i = 0; i < drawCount; i += 1) {
      const ratio = drawCount === 1 ? 0 : i / (drawCount - 1);
      const srcIdx = Math.min(peaks.length - 1, Math.floor(ratio * peaks.length));
      const amp = Math.max(1.2, (peaks[srcIdx] / 255) * maxAmp);
      const x = i * stepPx + (stepPx - barW) / 2;
      const played = ratio <= progress;
      ctx.fillStyle = played ? playedColor : restColor;
      ctx.fillRect(x, midY - amp, barW, amp * 2);
    }
    hasDrawn = true;
  }

  function applyResult(extracted) {
    if (extracted && extracted.length) {
      peaks = extracted;
      setStatus('ready');
      draw(true);
    } else {
      peaks = null;
      setStatus('no-audio');
      canvas.hidden = true;
    }
  }

  function fetchAndDecode(video, key, epoch, attempt = 0) {
    if (epoch !== runEpoch || !enabled) return;
    const delayMs = attempt === 0 ? 150 : 900;
    delayTimer = setTimeout(async () => {
      delayTimer = 0;
      if (epoch !== runEpoch || !enabled) return;
      const ctrl = new AbortController();
      abortCtrl = ctrl;
      let stage = 'fetch';
      try {
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
        if (extracted) idbSet(key, extracted);
        uploadServerWaveform(video.id, extracted);
        applyResult(extracted);
      } catch (err) {
        if (err?.name === 'AbortError' || epoch !== runEpoch) return;
        if (stage === 'fetch' && attempt < 1) {
          fetchAndDecode(video, key, epoch, attempt + 1);
          return;
        }
        console.warn(`[waveform] ${stage} failed:`, err);
        peaks = null;
        canvas.hidden = true;
        if (stage === 'decode') {
          memCache.set(key, null);
          uploadServerWaveform(video.id, null);
          setStatus('no-audio');
        } else {
          setStatus('error');
        }
      } finally {
        if (abortCtrl === ctrl) abortCtrl = null;
      }
    }, delayMs);
  }

  async function startLoad(video) {
    if (!enabled || !video?.id) return;
    const epoch = ++runEpoch;
    cancelPending();

    const key = cacheKey(video);
    if (memCache.has(key)) {
      applyResult(memCache.get(key));
      return;
    }

    setStatus('loading');

    // 如果刚上传完正在用本地 File 预计算，直接等它完成，零网络回传
    const pendingSeed = seedJobs.get(video.id);
    if (pendingSeed) {
      await pendingSeed;
      if (epoch !== runEpoch || !enabled) return;
      if (memCache.has(key)) {
        applyResult(memCache.get(key));
        return;
      }
    }

    // 1. 优先查服务端共享缓存（~1KB，全员首次打开 10ms 秒出）
    const ctrl = new AbortController();
    abortCtrl = ctrl;
    let serverHit = null;
    try {
      serverHit = await fetchServerWaveform(video.id, ctrl.signal);
    } catch (err) {
      if (err?.name === 'AbortError' || epoch !== runEpoch) return;
    } finally {
      if (abortCtrl === ctrl) abortCtrl = null;
    }
    if (epoch !== runEpoch || !enabled) return;
    if (serverHit) {
      uploadedIds.add(video.id);
      memCache.set(key, serverHit.peaks);
      if (serverHit.peaks) idbSet(key, serverHit.peaks);
      applyResult(serverHit.peaks);
      return;
    }

    // 2. 服务端暂无时查本机 IndexedDB：命中直接画出，同时静默补传到服务端造福全员
    const cached = await idbGet(key);
    if (epoch !== runEpoch || !enabled) return;
    if (cached && cached.length) {
      const arr = cached instanceof Uint8Array ? cached : new Uint8Array(cached);
      memCache.set(key, arr);
      uploadServerWaveform(video.id, arr);
      applyResult(arr);
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

    // 3. 首次解码旧片：独立拉流解码并存到服务端
    fetchAndDecode(video, key, epoch, 0);
  }

  /** 上传完成后用本地 File 零流量提取波形并存服务端，全员首次打开直接秒出 */
  function seedFromFile(video, file) {
    if (!video?.id || !file || file.size > MAX_DECODE_BYTES) return Promise.resolve();
    if (seedJobs.has(video.id)) return seedJobs.get(video.id);
    if (!(window.OfflineAudioContext || window.webkitOfflineAudioContext || window.AudioContext || window.webkitAudioContext)) {
      return Promise.resolve();
    }

    const key = cacheKey(video);
    const job = (async () => {
      try {
        const buf = await file.arrayBuffer();
        let extracted = null;
        try {
          const decoded = await decodeAudioBuffer(buf);
          extracted = extractPeaks(decoded, WAVE_BARS);
        } catch {
          extracted = null;
        }
        memCache.set(key, extracted);
        if (extracted) idbSet(key, extracted);
        uploadServerWaveform(video.id, extracted);
        if (currentVideo?.id === video.id && enabled) {
          applyResult(extracted);
        }
      } catch (err) {
        console.warn('[waveform] local seed failed:', err);
      } finally {
        seedJobs.delete(video.id);
      }
    })();

    seedJobs.set(video.id, job);
    return job;
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
    seedFromFile,
    retry() {
      if (!enabled || !currentVideo) return;
      startLoad(currentVideo);
    },
    setProgress(nextRatio) {
      const clamped = Math.min(1, Math.max(0, Number(nextRatio) || 0));
      progress = clamped;
      if (enabled && peaks) draw(false);
    },
    redraw() {
      if (enabled && peaks) draw(true);
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
