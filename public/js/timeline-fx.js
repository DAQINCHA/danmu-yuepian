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

function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob || null), 'image/jpeg', THUMB_QUALITY);
  });
}

export function createTimelinePreview({
  timeline,
  popover,
  getContext,
}) {
  if (!timeline || !popover) {
    return { reset() {}, hide() {} };
  }

  // 构建浮卡 DOM
  const media = document.createElement('div');
  media.className = 'tl-preview-media';
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  const tcBadge = document.createElement('span');
  tcBadge.className = 'tl-preview-tc mono';
  media.append(img, tcBadge);

  const note = document.createElement('div');
  note.className = 'tl-preview-note';
  note.hidden = true;

  popover.replaceChildren(media, note);

  /** 当前视频的缩略图 URL 缓存：slotIndex -> objectUrl */
  const memUrls = new Map();
  let currentVideoId = '';
  let hiddenVideo = null;
  let hiddenSrc = '';
  let busy = false;
  let desiredSlot = null; // { videoId, url, slot, time }
  let activeSlot = -1;
  let lastShownUrl = '';

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

  function clearMemoryCache() {
    for (const url of memUrls.values()) URL.revokeObjectURL(url);
    memUrls.clear();
    lastShownUrl = '';
    img.removeAttribute('src');
    media.classList.remove('loaded');
  }

  function slotInfo(time, total) {
    const count = Math.max(8, Math.min(THUMB_MAX_SLOTS, Math.round(total * 1.2)));
    const idx = Math.min(count - 1, Math.max(0, Math.floor((time / total) * count)));
    const slotTime = Math.min(Math.max(0, total - 0.05), ((idx + 0.5) / count) * total);
    return { idx, count, slotTime };
  }

  function cacheKey(videoId, count, idx) {
    return `${videoId}:${count}:${idx}`;
  }

  function showImage(url) {
    if (lastShownUrl === url) return;
    lastShownUrl = url;
    img.src = url;
    media.classList.add('loaded');
  }

  async function processQueue() {
    if (busy) return;
    busy = true;
    try {
      while (desiredSlot) {
        const job = desiredSlot;
        desiredSlot = null;
        if (job.videoId !== currentVideoId) continue;

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

        // 实时从隐藏 <video> 抽一帧缩略图
        try {
          const v = ensureHiddenVideo(job.url);
          await waitMetadata(v);
          if (job.videoId !== currentVideoId) continue;
          // 如果期间鼠标已经划走去新槽位，跳过旧槽位直接抽最新的
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

    // 请求该槽位缩略图
    const slot = slotInfo(hoverTime, ctx.total);
    activeSlot = slot.idx;
    const key = cacheKey(ctx.video.id, slot.count, slot.idx);
    if (memUrls.has(key)) {
      showImage(memUrls.get(key));
    } else {
      desiredSlot = {
        videoId: ctx.video.id,
        url: `/api/videos/${ctx.video.id}/file`,
        idx: slot.idx,
        count: slot.count,
        slotTime: slot.slotTime,
      };
      processQueue();
    }
  }

  timeline.addEventListener('pointermove', (event) => {
    // 触摸设备上只在按住拖动时展示，避免点一下浮卡一直悬在屏幕上
    if (event.pointerType === 'touch' && event.buttons === 0) return;
    showAt(event.clientX);
  });
  timeline.addEventListener('pointerleave', hide);
  timeline.addEventListener('pointercancel', hide);
  window.addEventListener('blur', hide);
  document.addEventListener('fullscreenchange', hide);

  return {
    hide,
    reset() {
      hide();
      desiredSlot = null;
      currentVideoId = '';
      clearMemoryCache();
      releaseHiddenVideo();
    },
  };
}
