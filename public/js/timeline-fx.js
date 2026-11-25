import { timecode } from './format.js';

/**
 * 超级时间轴特效（第 5 期）：
 *  1. 弹幕争议密度「热力山脉」—— 用平滑高斯核密度把弹幕与画笔分布绘在时间轴正上方；
 *  2. 悬停缩略图预览 + 附近意见速览 —— 量化时间槽 + 内存 / IndexedDB 缓存，滑过即看且不重复拖带宽。
 */

const HEAT_BINS = 120;
const THUMB_MAX_EDGE = 240;
const THUMB_QUALITY = 0.72;
const THUMB_DB_NAME = 'danmu-yuepian-thumbs';
const THUMB_STORE = 'frames';
const THUMB_MAX_SLOTS = 48;
// 服务端雪碧图：单格最长边 160px（16:9 → 160×90，9:16 → 90×160），8 列网格，整支片约 120~350KB
const SPRITE_MAX_EDGE = 160;
const SPRITE_COLS = 8;
const SPRITE_QUALITY = 0.68;
const SPRITE_MAX_BYTES = 1800 * 1024;

/* ── IndexedDB 缩略图缓存（静默降级：无痕/禁用时只走内存） ──────────── */

let dbPromise = null;

function openThumbDb() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(THUMB_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(THUMB_STORE)) {
          db.createObjectStore(THUMB_STORE);
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
  const db = await openThumbDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(THUMB_STORE, 'readonly');
      const req = tx.objectStore(THUMB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbSet(key, blob) {
  const db = await openThumbDb();
  if (!db) return;
  try {
    const tx = db.transaction(THUMB_STORE, 'readwrite');
    tx.objectStore(THUMB_STORE).put(blob, key);
  } catch {
    /* 空间满了或无痕模式，忽略 */
  }
}

/* ── 1. 弹幕热力山脉 ───────────────────────────────────────────────── */

function computeHeatCurve(comments, annotations, total) {
  const bins = new Float32Array(HEAT_BINS);
  if (!(total > 0)) return { bins, max: 0 };

  // 带宽按采样点数自适应，保证短片和长片都能画出平滑山脉
  const sigma = 2.1;
  const radius = Math.ceil(sigma * 3);
  const inv2s2 = 1 / (2 * sigma * sigma);
  let hasAny = false;

  const splat = (time, weight) => {
    const center = (Math.min(total, Math.max(0, time)) / total) * (HEAT_BINS - 1);
    const lo = Math.max(0, Math.floor(center - radius));
    const hi = Math.min(HEAT_BINS - 1, Math.ceil(center + radius));
    for (let i = lo; i <= hi; i += 1) {
      const d = i - center;
      bins[i] += weight * Math.exp(-(d * d) * inv2s2);
    }
    hasAny = true;
  };

  for (const c of comments) {
    // 第 0 帧是「整体意见」，不计入局部热力峰，免得片头永远顶一根假尖峰
    if (!Number.isFinite(c.time) || c.time < 0.001) continue;
    const replies = Array.isArray(c.replies) ? c.replies.length : 0;
    splat(c.time, 1 + Math.min(replies, 5) * 0.35);
  }

  for (const a of annotations) {
    if (!Number.isFinite(a.start)) continue;
    const end = Number.isFinite(a.end) && a.end > a.start ? a.end : a.start;
    const replies = Array.isArray(a.replies) ? a.replies.length : 0;
    const weight = 1.35 + Math.min(replies, 5) * 0.35;
    const span = end - a.start;
    const steps = Math.max(1, Math.min(6, Math.ceil((span / total) * HEAT_BINS * 0.6)));
    for (let k = 0; k < steps; k += 1) {
      const t = steps === 1 ? (a.start + end) / 2 : a.start + (span * k) / (steps - 1);
      splat(t, weight / steps);
    }
  }

  if (!hasAny) return { bins, max: 0 };

  let max = 0;
  for (let i = 0; i < HEAT_BINS; i += 1) {
    if (bins[i] > max) max = bins[i];
  }
  return { bins, max };
}

export function createTimelineHeatmap(canvas) {
  if (!canvas) return { update() {}, clear() {} };
  const ctx = canvas.getContext('2d');
  let lastData = null;

  function draw() {
    if (!lastData) {
      canvas.hidden = true;
      return;
    }
    const { comments, annotations, total } = lastData;
    const { bins, max } = computeHeatCurve(comments, annotations, total);
    if (!(max > 0)) {
      canvas.hidden = true;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    canvas.hidden = false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 6) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = rect.width;
    const h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 轻微开方压缩动态范围，让小山丘也看得见、最高峰仍然最醒目
    const normMax = Math.max(max, 1.15);
    const baseY = h - 1;
    const peakH = h - 4;
    const pts = [];
    for (let i = 0; i < HEAT_BINS; i += 1) {
      const x = (i / (HEAT_BINS - 1)) * w;
      const ratio = Math.min(1, bins[i] / normMax);
      const shaped = Math.pow(ratio, 0.78);
      const y = baseY - shaped * peakH;
      pts.push([x, y]);
    }

    // 构造平滑二次贝塞尔路径
    const traceCurve = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i += 1) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last[0], last[1]);
    };

    // 填充渐变：高处暖金流光 → 中段青色 → 底部淡隐
    const fillGrad = ctx.createLinearGradient(0, 0, 0, baseY);
    fillGrad.addColorStop(0, 'rgba(240, 215, 154, 0.56)');
    fillGrad.addColorStop(0.45, 'rgba(34, 193, 195, 0.36)');
    fillGrad.addColorStop(1, 'rgba(34, 193, 195, 0.03)');

    traceCurve();
    ctx.lineTo(w, baseY);
    ctx.lineTo(0, baseY);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // 山脊流光描边
    const strokeGrad = ctx.createLinearGradient(0, 0, 0, baseY);
    strokeGrad.addColorStop(0, 'rgba(255, 232, 168, 0.95)');
    strokeGrad.addColorStop(0.55, 'rgba(127, 240, 234, 0.85)');
    strokeGrad.addColorStop(1, 'rgba(34, 193, 195, 0.25)');

    traceCurve();
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = strokeGrad;
    ctx.stroke();
  }

  if (typeof ResizeObserver === 'function') {
    let raf = 0;
    new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw();
      });
    }).observe(canvas);
  }

  return {
    update(comments, annotations, total) {
      lastData = { comments, annotations, total };
      draw();
    },
    clear() {
      lastData = null;
      canvas.hidden = true;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

/* ── 2. 悬停缩略图预览 + 附近弹幕速览 ─────────────────────────────── */

function waitSeek(video, timeout = 3500) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onOk);
      video.removeEventListener('error', onErr);
      fn(arg);
    };
    const onOk = () => finish(resolve);
    const onErr = () => finish(reject, new Error('seek error'));
    const timer = setTimeout(() => finish(reject, new Error('seek timeout')), timeout);
    video.addEventListener('seeked', onOk);
    video.addEventListener('error', onErr);
  });
}

function waitMetadata(video, timeout = 5000) {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onOk);
      video.removeEventListener('error', onErr);
      fn(arg);
    };
    const onOk = () => finish(resolve);
    const onErr = () => finish(reject, new Error('meta error'));
    const timer = setTimeout(() => finish(reject, new Error('meta timeout')), timeout);
    video.addEventListener('loadedmetadata', onOk);
    video.addEventListener('error', onErr);
  });
}

function canvasToBlob(canvas, quality = THUMB_QUALITY) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob || null), 'image/jpeg', quality);
  });
}

function preloadImage(url) {
  return new Promise((resolve, reject) => {
    const pic = new Image();
    pic.decoding = 'async';
    pic.onload = () => resolve(url);
    pic.onerror = () => reject(new Error('sprite image load failed'));
    pic.src = url;
  });
}

function pauseMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function thumbsMetaEndpoint(videoId) {
  return `/api/videos/${encodeURIComponent(videoId)}/thumbs`;
}

function thumbsImageEndpoint(videoId) {
  return `/api/videos/${encodeURIComponent(videoId)}/thumbs.jpg`;
}

/**
 * 从本地 File（上传者零流量）或视频直链抽帧拼成一张 JPEG 雪碧图，
 * 供全员共享服务端单份缓存，悬停时间轴 0ms 瞬出。
 */
async function buildSpriteSheet(srcUrl, { isCancelled = () => false, yieldMs = 0 } = {}) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.setAttribute('aria-hidden', 'true');
  v.style.cssText = 'position:fixed;left:-8px;top:-8px;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.appendChild(v);

  try {
    v.src = srcUrl;
    v.load();
    await waitMetadata(v, 10000);
    if (isCancelled()) return null;

    const total = Number(v.duration);
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!(total > 0) || !vw || !vh) return null;

    const count = Math.max(8, Math.min(THUMB_MAX_SLOTS, Math.round(total * 1.2)));
    const cols = Math.min(SPRITE_COLS, count);
    const rows = Math.ceil(count / cols);
    const scale = Math.min(1, SPRITE_MAX_EDGE / Math.max(vw, vh));
    // 偶像素宽高，JPEG 采样更干净
    const cellW = Math.max(32, Math.round((vw * scale) / 2) * 2);
    const cellH = Math.max(32, Math.round((vh * scale) / 2) * 2);

    const canvas = document.createElement('canvas');
    canvas.width = cols * cellW;
    canvas.height = rows * cellH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#05080a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let drawn = 0;
    for (let i = 0; i < count; i += 1) {
      if (isCancelled()) return null;
      const t = Math.min(Math.max(0, total - 0.05), ((i + 0.5) / count) * total);
      try {
        if (Math.abs(v.currentTime - t) > 0.02 || v.readyState < 2) {
          const sought = waitSeek(v, 4000);
          v.currentTime = t;
          await sought;
        }
        if (isCancelled()) return null;
        const col = i % cols;
        const row = Math.floor(i / cols);
        ctx.drawImage(v, col * cellW, row * cellH, cellW, cellH);
        drawn += 1;
      } catch {
        // 单帧解码偶发超时跳过，不中断整张雪碧图
      }
      if (yieldMs > 0 && i < count - 1) await pauseMs(yieldMs);
    }

    if (drawn < Math.max(2, Math.floor(count * 0.5))) return null;

    let blob = await canvasToBlob(canvas, SPRITE_QUALITY);
    if (blob && blob.size > SPRITE_MAX_BYTES) {
      blob = await canvasToBlob(canvas, 0.52);
    }
    if (!blob || blob.size > SPRITE_MAX_BYTES || isCancelled()) return null;

    return {
      blob,
      meta: { count, cols, rows, cellW, cellH, duration: total },
    };
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.remove();
  }
}

async function uploadSpriteSheet(videoId, blob, meta) {
  const res = await fetch(thumbsMetaEndpoint(videoId), {
    method: 'PUT',
    headers: {
      'Content-Type': 'image/jpeg',
      'X-Thumb-Meta': encodeURIComponent(JSON.stringify(meta)),
    },
    body: blob,
  });
  return res.ok;
}

export function createTimelinePreview({
  timeline,
  popover,
  getContext,
}) {
  if (!timeline || !popover) {
    return { load() {}, seedFromFile() {}, reset() {}, hide() {} };
  }

  // 构建浮卡 DOM（同时支持 0ms 雪碧图与单帧兜底）
  const media = document.createElement('div');
  media.className = 'tl-preview-media';
  const spriteEl = document.createElement('div');
  spriteEl.className = 'tl-preview-sprite';
  spriteEl.hidden = true;
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  const tcBadge = document.createElement('span');
  tcBadge.className = 'tl-preview-tc mono';
  media.append(spriteEl, img, tcBadge);

  const note = document.createElement('div');
  note.className = 'tl-preview-note';
  note.hidden = true;

  popover.replaceChildren(media, note);

  /** 当前视频的兜底单帧缩略图缓存：slotIndex -> objectUrl */
  const memUrls = new Map();
  /** 服务端雪碧图缓存：videoId -> { count, cols, rows, cellW, cellH, duration, imageUrl, isBlobUrl } */
  const spriteCache = new Map();
  /** 正在生成的雪碧图任务：videoId -> Promise */
  const spriteJobs = new Map();

  let currentVideoId = '';
  let loadEpoch = 0;
  let spriteTimer = 0;
  let spriteAbort = null;
  let bgCancelled = false;
  let hiddenVideo = null;
  let hiddenSrc = '';
  let busy = false;
  let desiredSlot = null; // { videoId, url, idx, count, slotTime }
  let activeSlot = -1;
  let lastShownUrl = '';
  let lastSpriteBg = '';

  function ensureHiddenVideo(url) {
    if (!hiddenVideo) {
      hiddenVideo = document.createElement('video');
      hiddenVideo.muted = true;
      hiddenVideo.playsInline = true;
      hiddenVideo.preload = 'metadata';
      hiddenVideo.setAttribute('aria-hidden', 'true');
      hiddenVideo.style.cssText = 'position:fixed;left:-8px;top:-8px;width:2px;height:2px;opacity:0;pointer-events:none;';
      document.body.appendChild(hiddenVideo);
    }
    if (hiddenSrc !== url) {
      hiddenSrc = url;
      hiddenVideo.src = url;
      hiddenVideo.load();
    }
    return hiddenVideo;
  }

  function releaseHiddenVideo() {
    if (!hiddenVideo) return;
    hiddenSrc = '';
    hiddenVideo.pause();
    hiddenVideo.removeAttribute('src');
    hiddenVideo.load();
  }

  function cancelSpriteWork() {
    clearTimeout(spriteTimer);
    spriteTimer = 0;
    bgCancelled = true;
    if (spriteAbort) {
      spriteAbort.abort();
      spriteAbort = null;
    }
  }

  function clearMemoryCache() {
    for (const url of memUrls.values()) URL.revokeObjectURL(url);
    memUrls.clear();
    lastShownUrl = '';
    lastSpriteBg = '';
    img.removeAttribute('src');
    img.hidden = false;
    spriteEl.hidden = true;
    spriteEl.style.backgroundImage = '';
    media.classList.remove('loaded');
  }

  function slotInfo(time, total, countOverride = 0) {
    const count = countOverride || Math.max(8, Math.min(THUMB_MAX_SLOTS, Math.round(total * 1.2)));
    const idx = Math.min(count - 1, Math.max(0, Math.floor((time / total) * count)));
    const slotTime = Math.min(Math.max(0, total - 0.05), ((idx + 0.5) / count) * total);
    return { idx, count, slotTime };
  }

  function cacheKey(videoId, count, idx) {
    return `${videoId}:${count}:${idx}`;
  }

  function showSpriteCell(sprite, idx) {
    const col = idx % sprite.cols;
    const row = Math.floor(idx / sprite.cols);
    const xPct = sprite.cols > 1 ? (col / (sprite.cols - 1)) * 100 : 0;
    const yPct = sprite.rows > 1 ? (row / (sprite.rows - 1)) * 100 : 0;
    if (lastSpriteBg !== sprite.imageUrl) {
      lastSpriteBg = sprite.imageUrl;
      spriteEl.style.backgroundImage = `url("${sprite.imageUrl}")`;
      spriteEl.style.backgroundSize = `${sprite.cols * 100}% ${sprite.rows * 100}%`;
    }
    spriteEl.style.backgroundPosition = `${xPct}% ${yPct}%`;
    spriteEl.hidden = false;
    img.hidden = true;
    media.classList.add('loaded');
  }

  function showImage(url) {
    spriteEl.hidden = true;
    img.hidden = false;
    if (lastShownUrl === url) return;
    lastShownUrl = url;
    img.src = url;
    media.classList.add('loaded');
  }

  function storeSprite(videoId, meta, imageUrl, isBlobUrl = false) {
    const prev = spriteCache.get(videoId);
    if (prev && prev.isBlobUrl && prev.imageUrl !== imageUrl) {
      URL.revokeObjectURL(prev.imageUrl);
    }
    const entry = { ...meta, imageUrl, isBlobUrl };
    spriteCache.set(videoId, entry);
    return entry;
  }

  /** 打开视频时优先加载服务端雪碧图；服务端暂无则低优先级后台生成并补传 */
  async function load(video) {
    cancelSpriteWork();
    const epoch = ++loadEpoch;
    if (!video?.id) {
      currentVideoId = '';
      clearMemoryCache();
      releaseHiddenVideo();
      return;
    }

    if (video.id !== currentVideoId) {
      clearMemoryCache();
      releaseHiddenVideo();
      currentVideoId = video.id;
    }

    if (spriteCache.has(video.id)) return;

    // 刚上传完正在用本地 File 生成雪碧图：直接等待即可
    if (spriteJobs.has(video.id)) {
      await spriteJobs.get(video.id);
      return;
    }

    const ctrl = new AbortController();
    spriteAbort = ctrl;
    try {
      const res = await fetch(thumbsMetaEndpoint(video.id), { signal: ctrl.signal });
      if (epoch !== loadEpoch) return;
      if (res.ok && res.status === 200) {
        const meta = await res.json();
        if (meta && meta.count > 0 && meta.cols > 0 && meta.rows > 0) {
          const imgUrl = thumbsImageEndpoint(video.id);
          await preloadImage(imgUrl);
          if (epoch !== loadEpoch) return;
          storeSprite(video.id, meta, imgUrl, false);
          return;
        }
      }
      if (res.status !== 204 && res.status !== 404) return;
    } catch (err) {
      if (err?.name === 'AbortError' || epoch !== loadEpoch) return;
      return;
    } finally {
      if (spriteAbort === ctrl) spriteAbort = null;
    }

    // 服务端还没有旧片雪碧图：延迟 1.5s 后低优先级后台抽帧并存到服务端（期间悬停照常走实时抽帧兜底）
    bgCancelled = false;
    const targetId = video.id;
    spriteTimer = setTimeout(() => {
      spriteTimer = 0;
      if (epoch !== loadEpoch || bgCancelled || spriteCache.has(targetId) || spriteJobs.has(targetId)) return;
      const job = (async () => {
        try {
          const built = await buildSpriteSheet(
            `/api/videos/${encodeURIComponent(targetId)}/file?purpose=thumbs-sprite`,
            { isCancelled: () => epoch !== loadEpoch || bgCancelled, yieldMs: 40 },
          );
          if (!built || epoch !== loadEpoch || bgCancelled) return;
          const objUrl = URL.createObjectURL(built.blob);
          storeSprite(targetId, built.meta, objUrl, true);
          uploadSpriteSheet(targetId, built.blob, built.meta).catch(() => {});
        } catch {
          /* 旧片后台补传失败静默降级为实时抽帧 */
        } finally {
          spriteJobs.delete(targetId);
        }
      })();
      spriteJobs.set(targetId, job);
    }, 1500);
  }

  /** 上传完成后用本地 File 零流量极速生成雪碧图并传服务端，全员首次打开 0ms 秒出 */
  function seedFromFile(videoId, file) {
    if (!videoId || !file || spriteCache.has(videoId) || spriteJobs.has(videoId)) return Promise.resolve();
    const job = (async () => {
      const localUrl = URL.createObjectURL(file);
      try {
        const built = await buildSpriteSheet(localUrl, { yieldMs: 0 });
        if (!built) return;
        const objUrl = URL.createObjectURL(built.blob);
        storeSprite(videoId, built.meta, objUrl, true);
        await uploadSpriteSheet(videoId, built.blob, built.meta).catch(() => {});
      } catch {
        /* 生成失败不影响正常看片，后续悬停会自动兜底 */
      } finally {
        URL.revokeObjectURL(localUrl);
        spriteJobs.delete(videoId);
      }
    })();
    spriteJobs.set(videoId, job);
    return job;
  }

  async function processQueue() {
    if (busy) return;
    busy = true;
    try {
      while (desiredSlot) {
        const job = desiredSlot;
        desiredSlot = null;
        if (job.videoId !== currentVideoId) continue;

        const sprite = spriteCache.get(job.videoId);
        if (sprite) {
          if (activeSlot === job.idx) showSpriteCell(sprite, Math.min(sprite.count - 1, job.idx));
          continue;
        }

        const key = cacheKey(job.videoId, job.count, job.idx);
        if (memUrls.has(key)) {
          if (activeSlot === job.idx) showImage(memUrls.get(key));
          continue;
        }

        // 先查 IndexedDB：二次打开同一支片秒出，不拉视频流
        const cachedBlob = await idbGet(key);
        if (job.videoId !== currentVideoId) continue;
        if (cachedBlob) {
          const objUrl = URL.createObjectURL(cachedBlob);
          memUrls.set(key, objUrl);
          if (activeSlot === job.idx) showImage(objUrl);
          continue;
        }

        // 实时从隐藏 <video> 抽一帧缩略图（仅在雪碧图尚未就绪时兜底）
        try {
          const v = ensureHiddenVideo(job.url);
          await waitMetadata(v);
          if (job.videoId !== currentVideoId) continue;
          if (desiredSlot && desiredSlot.idx !== job.idx) continue;

          if (Math.abs(v.currentTime - job.slotTime) > 0.02 || v.readyState < 2) {
            const sought = waitSeek(v);
            v.currentTime = job.slotTime;
            await sought;
          }
          if (job.videoId !== currentVideoId) continue;
          if (!v.videoWidth || !v.videoHeight) continue;

          const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(v.videoWidth, v.videoHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(2, Math.round(v.videoWidth * scale));
          canvas.height = Math.max(2, Math.round(v.videoHeight * scale));
          canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);

          const blob = await canvasToBlob(canvas);
          if (!blob || job.videoId !== currentVideoId) continue;
          const objUrl = URL.createObjectURL(blob);
          memUrls.set(key, objUrl);
          idbSet(key, blob);
          if (activeSlot === job.idx) showImage(objUrl);
        } catch {
          /* 单帧超时或编码暂未解码，静默跳过不影响下次悬停 */
        }
      }
    } finally {
      busy = false;
    }
  }

  function summarizeNearby(comments, annotations, time, total) {
    const windowSec = Math.max(0.75, Math.min(2.2, total * 0.022));
    const nearComments = [];
    for (const c of comments) {
      if (c.time < 0.001) continue;
      if (Math.abs(c.time - time) <= windowSec) nearComments.push(c);
    }
    const nearAnns = [];
    for (const a of annotations) {
      if (time >= a.start - windowSec * 0.5 && time <= a.end + windowSec * 0.5) nearAnns.push(a);
    }

    const totalHits = nearComments.length + nearAnns.length;
    if (!totalHits) return '';

    if (nearComments.length) {
      nearComments.sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time));
      const top = nearComments[0];
      const prefix = totalHits > 1 ? `🔥 ${totalHits} 条 · ` : '';
      return `${prefix}${top.author || '匿名'}：${top.text}`;
    }
    const firstAnn = nearAnns[0];
    const prefix = nearAnns.length > 1 ? `✎ ${nearAnns.length} 处画笔 · ` : '✎ ';
    return `${prefix}${firstAnn.author || '匿名'} 的画笔标注`;
  }

  function hide() {
    popover.hidden = true;
    activeSlot = -1;
  }

  function showAt(clientX) {
    const ctx = getContext();
    if (!ctx || !ctx.video || !ctx.total || ctx.blocked) {
      hide();
      return;
    }

    if (ctx.video.id !== currentVideoId) {
      clearMemoryCache();
      releaseHiddenVideo();
      currentVideoId = ctx.video.id;
    }

    const rect = timeline.getBoundingClientRect();
    if (rect.width < 20) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const hoverTime = ratio * ctx.total;

    // 尺寸自适应：横屏 192×108，竖屏自动按比例收窄，不拉变形
    const vw = ctx.videoWidth || 16;
    const vh = ctx.videoHeight || 9;
    const aspect = vw / vh;
    let boxW = 192;
    let boxH = Math.round(boxW / aspect);
    if (boxH > 132) {
      boxH = 132;
      boxW = Math.max(88, Math.round(boxH * aspect));
    }
    media.style.width = `${boxW}px`;
    media.style.height = `${boxH}px`;

    // 时间码 + 帧号
    const frame = Math.round(hoverTime * (ctx.fps || 25));
    tcBadge.textContent = `${timecode(hoverTime)} · F${frame}`;

    // 附近弹幕 / 画笔摘要
    const summary = summarizeNearby(ctx.comments, ctx.annotations, hoverTime, ctx.total);
    if (summary) {
      note.textContent = summary;
      note.hidden = false;
    } else {
      note.hidden = true;
    }

    // 挂到当前全屏容器或 body，防止全屏下被盖住
    const host = document.fullscreenElement || document.body;
    if (popover.parentNode !== host) host.appendChild(popover);
    popover.hidden = false;

    const popW = popover.offsetWidth || (boxW + 12);
    const popH = popover.offsetHeight || (boxH + 24);
    const left = Math.min(window.innerWidth - popW - 10, Math.max(10, clientX - popW / 2));
    const top = Math.max(10, rect.top - popH - 14);
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;

    // 优先走服务端雪碧图：0ms 瞬出、零 seek 延迟
    const sprite = spriteCache.get(ctx.video.id);
    if (sprite) {
      const slot = slotInfo(hoverTime, ctx.total, sprite.count);
      activeSlot = slot.idx;
      showSpriteCell(sprite, slot.idx);
      return;
    }

    // 雪碧图尚未就绪时走实时单帧兜底
    const slot = slotInfo(hoverTime, ctx.total);
    activeSlot = slot.idx;
    const key = cacheKey(ctx.video.id, slot.count, slot.idx);
    if (memUrls.has(key)) {
      showImage(memUrls.get(key));
    } else {
      desiredSlot = {
        videoId: ctx.video.id,
        url: `/api/videos/${encodeURIComponent(ctx.video.id)}/file?purpose=thumbs-live`,
        idx: slot.idx,
        count: slot.count,
        slotTime: slot.slotTime,
      };
      processQueue();
    }
  }

  timeline.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch' && event.buttons === 0) return;
    showAt(event.clientX);
  });
  timeline.addEventListener('pointerleave', hide);
  timeline.addEventListener('pointercancel', hide);
  window.addEventListener('blur', hide);
  document.addEventListener('fullscreenchange', hide);

  return {
    load,
    seedFromFile,
    hide,
    reset() {
      hide();
      cancelSpriteWork();
      desiredSlot = null;
      currentVideoId = '';
      clearMemoryCache();
      releaseHiddenVideo();
    },
  };
}
