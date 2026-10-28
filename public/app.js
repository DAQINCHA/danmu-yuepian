import { api, uploadVideo, probeDuration } from './js/api.js';
import { timecode, clockTime, fileSize, relativeTime, authorColor, setAuthorRoster } from './js/format.js';
import { createDanmaku } from './js/danmaku.js';
import { createAnnotationView, createDrawPad, drawStrokes } from './js/annotations.js';
import { createReportView } from './js/report.js';
import { detectFrameRate } from './js/fps.js';
import { drawOverlayBoxes, drawWatermark, downloadCanvas, safeFileName } from './js/capture.js';

const $ = (id) => document.getElementById(id);
const DRAW_COLORS = ['#ff5a4d', '#ffd166', '#4ec9a0', '#8ab4ff'];
const STORE = {
  author: 'danmu:author',
  danmaku: 'danmu:danmaku',
};

// 和服务端 config.maxAnnotationSpan 保持一致
const MAX_ANN_SPAN = 12;

const state = {
  author: (localStorage.getItem(STORE.author) || '').trim(),
  fps: 25,
  // default = 还没识别过的猜测值；auto = 从视频里量出来的；manual = 用户手改过
  fpsSource: 'default',
  danmakuOn: localStorage.getItem(STORE.danmaku) !== 'off',
  videos: [],
  video: null,
  comments: [],
  annotations: [],
  tab: 'all',
  draw: null,
  color: DRAW_COLORS[0],
  es: null,
  lastTime: 0,
  lastTick: -1,
  // 开始输入弹幕那一刻的视频时间；发送时用它，而不是敲完回车时已经播过去的时间
  composeTime: null,
  // 这一段连续播放里已经弹过气泡的画笔标注，免得在区间内反复弹
  annShown: new Set(),
  // 时间轴上选中的画笔标注（只有它显示入点/出点手把，标注叠在一起时也不会抢）
  annSelected: null,
  // 正在拖手把：{ id, which }；拖动期间别的地方触发的 renderMarks 先攒着
  annDrag: null,
  marksPending: false,
  // 侧栏里正在回复哪一条（'comment:<id>' 或 'annotation:<id>'，全局只开一个）；
  // 列表会因为别人发弹幕整体重画，草稿和焦点要能接上
  replyOpen: null,
  replyDraft: '',
  replyFocus: false,
  // 侧栏里正在修改哪条自己的弹幕（comment id，全局只开一个），同样要扛住列表重画
  editOpen: null,
  editDraft: '',
  editFocus: false,
  uploading: false,
  pendingFile: null,
};

const dom = {};
let danmaku;
let annView;
let pad;
let reportView;
let lastFitCheck = 0;

/* ── 启动 ─────────────────────────────────────────────────────────── */

boot();

function boot() {
  cacheDom();
  danmaku = createDanmaku(dom.danmakuLayer, {
    colorOf: (c) => authorColor(c.author),
    isMine: (c) => c.author === authorName(),
  });
  danmaku.setEnabled(state.danmakuOn);
  annView = createAnnotationView(dom.annLayer);
  pad = createDrawPad(dom.drawLayer, { onChange: () => refreshDrawButtons() });
  reportView = createReportView({
    getData: () => ({
      video: state.video,
      comments: state.comments,
      annotations: state.annotations,
      fps: state.fps,
    }),
    onToggleDone: toggleDone,
    onJump: (time) => {
      reportView.close();
      jumpTo(time);
    },
    notify: toast,
  });

  initAuthor();
  initTransport();
  initTimeline();
  initComposer();
  initOverall();
  initDrawToolbar();
  initModals();
  initDrop();
  initKeyboard();
  initPresence();

  dom.video.addEventListener('loadedmetadata', onMetadata);
  dom.video.addEventListener('play', onPlay);
  dom.video.addEventListener('pause', onPause);
  dom.video.addEventListener('seeked', () => {
    // 输入中途拖了进度/逐帧，说明在找更准的那一帧，以新位置为准
    if (state.composeTime !== null) lockComposeTime(dom.video.currentTime || 0);
    state.annShown.clear();
    if (!dom.video.paused) return;
    // 暂停时换了位置，之前定住的弹幕已经不属于这一帧了
    danmaku.clearLive();
    updateFocus();
  });
  dom.video.addEventListener('error', () => {
    if (state.video) toast('视频解不开，可能是编码浏览器不支持（建议 H.264 的 mp4）', true);
  });
  dom.video.addEventListener('ended', onPause);

  new ResizeObserver(() => fitVideoWrap()).observe(dom.frame);
  window.addEventListener('resize', fitVideoWrap);
  window.addEventListener('hashchange', applyHash);

  requestAnimationFrame(tick);
  refreshVideos().finally(applyHash);
}

function cacheDom() {
  const ids = [
    'author-field', 'author-input', 'presence', 'presence-count', 'library-open', 'upload-open', 'upload-open-empty',
    'empty-state', 'frame', 'video-wrap', 'video', 'danmaku-layer', 'ann-layer', 'draw-layer', 'paused-badge',
    'draw-toolbar', 'range-in', 'range-out', 'range-summary', 'swatches', 'mark-in', 'mark-out',
    'preview-range', 'draw-undo', 'draw-clear', 'draw-cancel', 'draw-save',
    'play-btn', 'tc-now', 'timeline', 'timeline-fill', 'timeline-marks', 'timeline-head', 'tc-total',
    'transport', 'step-back', 'step-fwd', 'draw-toggle', 'fps-input', 'fps-badge', 'fps-field',
    'danmaku-toggle', 'snap-btn', 'fullscreen-btn',
    'composer', 'composer-time', 'composer-input', 'overall-form', 'overall-input',
    'video-title', 'video-meta', 'tabs', 'list', 'count-all', 'count-comment', 'count-annotation',
    'report-open',
    'library-modal', 'library-grid', 'upload-modal', 'dropzone', 'file-input', 'title-input',
    'upload-author', 'upload-pending', 'pending-name', 'pending-size', 'upload-start',
    'upload-progress', 'bar-fill', 'upload-status', 'toast',
  ];
  const camel = (s) => s.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  for (const id of ids) dom[camel(id)] = $(id);
  dom.empty = dom.emptyState;
  dom.stage = $('stage');
}

/* ── 身份 ─────────────────────────────────────────────────────────── */

function authorName() {
  return state.author || '匿名';
}

function initAuthor() {
  dom.authorInput.value = state.author;
  dom.uploadAuthor.value = state.author;
  dom.authorField.classList.toggle('need', !state.author);
  updateUploadButton();

  dom.authorInput.addEventListener('input', () => setAuthor(dom.authorInput.value, 'topbar'));
  dom.uploadAuthor.addEventListener('input', () => setAuthor(dom.uploadAuthor.value, 'upload'));
  for (const input of [dom.authorInput, dom.uploadAuthor]) {
    input.addEventListener('change', () => {
      setAuthor(input.value, input === dom.authorInput ? 'topbar' : 'upload');
      renderSidebar();
    });
  }
}

/** 两个入口共用一份署名；空值就是「还没署名」，不自动编一个假名字 */
function setAuthor(raw, source) {
  const name = String(raw || '').trim().slice(0, 16);
  state.author = name;

  if (name) localStorage.setItem(STORE.author, name);
  else localStorage.removeItem(STORE.author);

  if (source !== 'topbar') dom.authorInput.value = name;
  if (source !== 'upload') dom.uploadAuthor.value = name;

  dom.authorField.classList.toggle('need', !name);
  updateUploadButton();
}

function requireName(message, preferUpload = false) {
  if (state.author) return true;
  toast(message || '先写上你的名字，同事才知道这条意见是谁提的', true);
  focusAuthor(preferUpload);
  return false;
}

function focusAuthor(preferUpload = false) {
  dom.authorField.classList.add('need');
  const target = preferUpload && !dom.uploadModal.hidden ? dom.uploadAuthor : dom.authorInput;
  target.focus();
}

/* ── 路由 ─────────────────────────────────────────────────────────── */

function applyHash() {
  const match = /^#\/v\/([\w-]+)/.exec(location.hash);
  if (match) openVideo(match[1]);
  else showEmpty();
}

function showEmpty() {
  state.video = null;
  state.comments = [];
  state.annotations = [];
  setAuthorRoster();
  state.draw = null;
  dom.video.pause();
  dom.video.removeAttribute('src');
  dom.video.load();
  dom.empty.hidden = false;
  dom.frame.hidden = true;
  dom.transport.hidden = true;
  dom.composer.hidden = true;
  dom.overallForm.hidden = true;
  dom.drawToolbar.hidden = true;
  dom.videoWrap.classList.remove('drawing');
  dom.presence.hidden = true;
  dom.reportOpen.hidden = true;
  reportView?.close();
  dom.videoTitle.textContent = '还没有打开片子';
  dom.videoMeta.textContent = '上传后从片库里选一支开始审。';
  dom.list.replaceChildren(emptyHint('还没有评论。打开一支片，暂停在任意一帧就能发弹幕。'));
  danmaku.clear();
  annView.clear();
  updateCounts();
  state.es?.close();
  state.es = null;
}

async function openVideo(id) {
  if (state.video?.id === id) return;
  let data;
  try {
    data = await api.getVideo(id);
  } catch (err) {
    toast(err.message, true);
    location.hash = '#/';
    return;
  }

  state.video = data.video;
  state.comments = data.comments;
  for (const comment of state.comments) {
    if (!Array.isArray(comment.replies)) comment.replies = [];
  }
  state.replyOpen = null;
  state.replyDraft = '';
  state.editOpen = null;
  state.editDraft = '';
  state.editFocus = false;
  state.annotations = data.annotations;
  for (const annotation of state.annotations) {
    if (!Array.isArray(annotation.replies)) annotation.replies = [];
  }
  setAuthorRoster(state.comments, state.annotations);
  applyFps(data.video.fps || 25, data.video.fpsSource || 'default');
  state.draw = null;
  state.lastTime = 0;
  state.lastTick = -1;
  unlockComposeTime();

  dom.empty.hidden = true;
  dom.frame.hidden = false;
  dom.transport.hidden = false;
  dom.composer.hidden = false;
  dom.overallForm.hidden = false;
  dom.reportOpen.hidden = false;
  dom.drawToolbar.hidden = true;
  dom.videoWrap.classList.remove('drawing');
  dom.drawToggle.classList.remove('active');
  dom.tcTotal.textContent = timecode(data.video.duration || 0);

  danmaku.clear();
  annView.clear();
  renderHeader();
  renderSidebar();
  renderMarks();
  connectEvents(id);

  dom.video.src = `/api/videos/${id}/file`;
  dom.video.load();
  // 直接输地址进来时浏览器会拦掉带声音的自动播放，静默失败即可
  dom.video.play().catch(() => {
    dom.pausedBadge.hidden = false;
  });
  requestAnimationFrame(fitVideoWrap);
}

function onMetadata() {
  fitVideoWrap();
  dom.tcTotal.textContent = timecode(dom.video.duration || 0);
  renderMarks();

  if (!state.video) return;
  if (!state.video.duration && Number.isFinite(dom.video.duration)) {
    state.video.duration = dom.video.duration;
    api.patchVideo(state.video.id, { duration: dom.video.duration }).catch(() => {});
    renderHeader();
  }
}

function computeFit() {
  const width = dom.video.videoWidth;
  const height = dom.video.videoHeight;
  if (!width || !height || dom.frame.hidden) return null;

  const style = getComputedStyle(dom.frame);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const boxW = dom.frame.clientWidth - padX;
  const boxH = dom.frame.clientHeight - padY;
  if (boxW < 48 || boxH < 48) return null;

  const ratio = width / height;
  let w = boxW;
  let h = w / ratio;
  if (h > boxH) {
    h = boxH;
    w = h * ratio;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

/**
 * 画布要跟视频内容严格 1:1，所以尺寸由 JS 算。tick 里定期调用一次，
 * 布局晚一步就绪（字体、侧栏回流、媒体查询切换）也能自己纠正回来。
 */
function fitVideoWrap() {
  const size = computeFit();
  if (!size) return;
  const w = `${size.w}px`;
  const h = `${size.h}px`;
  if (dom.videoWrap.style.width === w && dom.videoWrap.style.height === h) return;
  dom.videoWrap.style.width = w;
  dom.videoWrap.style.height = h;
  annView.fit();
  pad.fit();
}

function renderHeader() {
  if (!state.video) return;
  const video = state.video;
  dom.videoTitle.textContent = video.title;
  const bits = [];
  if (video.uploader) bits.push(`上传 ${video.uploader}`);
  if (video.duration) bits.push(clockTime(video.duration));
  bits.push(`${state.fps} fps`);
  if (video.size) bits.push(fileSize(video.size));
  bits.push(relativeTime(video.createdAt));
  dom.videoMeta.textContent = bits.join(' · ');
}

/* ── 帧率：默认自动识别，手改过就以手动值为准 ─────────────────────── */

function applyFps(fps, source) {
  state.fps = Number(fps) || 25;
  state.fpsSource = source || 'default';
  dom.fpsInput.value = Number.isInteger(state.fps) ? String(state.fps) : state.fps.toFixed(2);
  updateFpsBadge();
  if (state.draw) updateRangeUI();
  renderHeader();
  if (state.video) renderSidebar();
}

function updateFpsBadge() {
  const labels = { auto: '自动', manual: '手动', default: '默认' };
  dom.fpsBadge.textContent = labels[state.fpsSource] || '默认';
  dom.fpsBadge.className = `fps-badge ${state.fpsSource}`;
  dom.fpsField.title = state.fpsSource === 'auto'
    ? `帧率已自动识别为 ${state.fps}，识别不准可以手动改`
    : '帧率决定「一帧」有多长：逐帧步进和画笔区间都靠它';
}

let fpsSampling = false;
let fpsDetectedFor = null;

async function maybeDetectFrameRate() {
  if (!state.video || fpsSampling || state.fpsSource === 'manual') return;
  if (fpsDetectedFor === state.video.id) return;

  const targetId = state.video.id;
  fpsSampling = true;
  let detected = null;
  try {
    detected = await detectFrameRate(dom.video);
  } catch {
    detected = null;
  } finally {
    fpsSampling = false;
  }

  if (!detected || state.video?.id !== targetId || state.fpsSource === 'manual') return;
  fpsDetectedFor = targetId;

  const changed = Math.abs(detected - state.fps) > 0.05;
  if (!changed && state.fpsSource === 'auto') return;

  applyFps(detected, 'auto');
  api.patchVideo(targetId, { fps: detected, fpsSource: 'auto' }).catch(() => {});
  if (changed) toast(`帧率自动识别为 ${detected}`);
}

/* ── 播放控制 ─────────────────────────────────────────────────────── */

function duration() {
  const own = dom.video.duration;
  if (Number.isFinite(own) && own > 0) return own;
  return state.video?.duration || 0;
}

function seekTo(time) {
  const total = duration();
  const target = Math.min(Math.max(0, time), Math.max(0, total - 0.001));
  if (!Number.isFinite(target)) return;
  try {
    dom.video.currentTime = target;
  } catch {
    /* 元数据还没就绪，忽略 */
  }
  state.lastTime = target;
  state.lastTick = -1;
}

function togglePlay() {
  if (!state.video) return;
  if (dom.video.paused) dom.video.play().catch(() => toast('浏览器拦了自动播放，点一下播放键', true));
  else dom.video.pause();
}

function stepFrame(direction) {
  if (!state.video) return;
  dom.video.pause();
  const fps = state.fps || 25;
  seekTo(dom.video.currentTime + (direction / fps) * 1.0 + direction * 0.0008);
}

function initTransport() {
  dom.playBtn.addEventListener('click', togglePlay);
  dom.video.addEventListener('click', togglePlay);
  dom.stepBack.addEventListener('click', () => stepFrame(-1));
  dom.stepFwd.addEventListener('click', () => stepFrame(1));

  dom.drawToggle.addEventListener('click', () => (state.draw ? exitDrawMode() : enterDrawMode()));

  dom.danmakuToggle.classList.toggle('active', state.danmakuOn);
  dom.danmakuToggle.addEventListener('click', () => {
    state.danmakuOn = !state.danmakuOn;
    danmaku.setEnabled(state.danmakuOn);
    dom.danmakuToggle.classList.toggle('active', state.danmakuOn);
    localStorage.setItem(STORE.danmaku, state.danmakuOn ? 'on' : 'off');
    updateFocus();
  });

  dom.fpsInput.value = state.fps;
  dom.fpsInput.addEventListener('change', () => {
    const next = Math.min(240, Math.max(1, Number(dom.fpsInput.value) || 25));
    applyFps(next, 'manual');
    if (state.video) api.patchVideo(state.video.id, { fps: next, fpsSource: 'manual' }).catch(() => {});
    toast('帧率已改为手动值');
  });

  dom.snapBtn.addEventListener('click', captureCurrentFrame);

  dom.fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else dom.stage.requestFullscreen?.().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => setTimeout(fitVideoWrap, 60));
}

function initTimeline() {
  let dragging = false;

  const seekFromEvent = (event) => {
    const total = duration();
    if (!total) return;
    const rect = dom.timeline.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    seekTo(ratio * total);
  };

  dom.timeline.addEventListener('pointerdown', (event) => {
    if (!state.video) return;
    dragging = true;
    dom.timeline.setPointerCapture(event.pointerId);
    seekFromEvent(event);
  });
  dom.timeline.addEventListener('pointermove', (event) => {
    if (dragging) seekFromEvent(event);
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    if (dom.video.paused) updateFocus();
  };
  dom.timeline.addEventListener('pointerup', stop);
  dom.timeline.addEventListener('pointercancel', stop);
}

function onPlay() {
  dom.pausedBadge.hidden = true;
  // 暂停时定住的弹幕接着淡出就行；只收掉下方的暂停卡片
  danmaku.showFocus([]);
  danmaku.setPaused(false);
  // 正好停在弹幕时间点上再继续播放时，让这条也能出来（pop 自己会去重）
  state.lastTime = Math.max(0, (dom.video.currentTime || 0) - 0.05);
  updateTransport(true);
  // 只有真正在播才能量到帧间隔
  maybeDetectFrameRate();
}

function onPause() {
  danmaku.setPaused(true);
  dom.pausedBadge.hidden = Boolean(!state.video || state.draw);
  setTimeout(updateFocus, 50);
  updateTransport(true);
}

function updateTransport(force = false) {
  if (!state.video) return;
  const t = dom.video.currentTime || 0;
  if (!force && Math.abs(t - state.lastTick) < 0.016) return;
  state.lastTick = t;

  const total = duration() || 1;
  const percent = Math.min(100, (t / total) * 100);
  dom.timelineFill.style.width = `${percent}%`;
  dom.timelineHead.style.left = `${percent}%`;
  dom.tcNow.textContent = timecode(t);
  if (state.composeTime === null) dom.composerTime.textContent = timecode(t);
  dom.playBtn.textContent = dom.video.paused ? '▶' : '❚❚';
}

function tick() {
  if (state.video) {
    const t = dom.video.currentTime || 0;
    if (!dom.video.paused && !dom.video.seeking) {
      if (t < state.lastTime - 0.05) {
        state.lastTime = t;
        state.annShown.clear();
      }
      if (t > state.lastTime) {
        // 从片头起播时把第 0 帧的弹幕（含整体意见）也算进来
        const from = state.lastTime <= 0 ? -1 : state.lastTime;
        for (const comment of state.comments) {
          if (comment.time > from && comment.time <= t) danmaku.pop(comment);
        }
        // 画笔标注有回复的，播到它的区间也弹一个气泡（从区间中间开始播也算）
        for (const annotation of state.annotations) {
          if (state.annShown.has(annotation.id)) continue;
          const reached = annotation.start > from && annotation.start <= t;
          const inside = annotation.start <= t && t <= annotation.end;
          if (!reached && !inside) continue;
          const bubble = annotationBubble(annotation);
          if (!bubble) continue;
          state.annShown.add(annotation.id);
          danmaku.pop(bubble);
        }
        state.lastTime = t;
      }
    } else {
      state.lastTime = t;
    }
    annView.render(state.annotations, t);
    updateTransport();

    const now = performance.now();
    if (now - lastFitCheck > 400) {
      lastFitCheck = now;
      fitVideoWrap();
    }
  }
  requestAnimationFrame(tick);
}

function updateFocus() {
  if (!state.video || !dom.video.paused || state.draw) {
    danmaku.showFocus([]);
    return;
  }
  const now = dom.video.currentTime || 0;
  const near = state.comments.filter((c) => Math.abs(c.time - now) <= 1.2);
  // 停在画笔区间里（或刚过起点附近）时，带回复的标注也列出来
  for (const annotation of state.annotations) {
    if (!annotationInRange(annotation, now)) continue;
    const bubble = annotationBubble(annotation);
    if (bubble) near.push(bubble);
  }
  near.sort((a, b) => a.time - b.time);
  danmaku.showFocus(near);
}

/**
 * 画笔标注在画面上的气泡：「✎ 作者（画笔）」+ 下面挂回复。
 * 只有有回复（或将来有备注文字）时才弹，光有笔迹的标注不占弹幕位。
 */
function annotationBubble(annotation) {
  const replies = Array.isArray(annotation.replies) ? annotation.replies : [];
  const note = typeof annotation.note === 'string' ? annotation.note.trim() : '';
  if (!replies.length && !note) return null;
  return {
    id: annotation.id,
    kind: 'annotation',
    time: annotation.start,
    author: annotation.author,
    text: note || '（画笔）',
    replies,
    color: authorColor(annotation.author),
  };
}

function annotationInRange(annotation, t) {
  return t >= annotation.start - 0.05 && t <= Math.max(annotation.end, annotation.start + 1.2);
}

/** 回复变了：在场的气泡就地换成新内容；自己刚回复、播放头又在区间里的标注直接弹出来 */
function refreshBubble(kind, item, { fromSelf = false } = {}) {
  if (!state.video) return;
  const bubble = kind === 'comment' ? item : annotationBubble(item);
  const live = danmaku.isLive(item.id);
  if (live) danmaku.drop(item.id);
  if (!bubble) return;
  const inRange = kind === 'annotation' && annotationInRange(item, dom.video.currentTime || 0);
  if (live || (fromSelf && inRange)) {
    if (kind === 'annotation') state.annShown.add(item.id);
    showNow(bubble);
  }
}

/* ── 截取当前帧 ───────────────────────────────────────────────────── */

function frameNumber(time) {
  return Math.floor((time || 0) * (state.fps || 25) + 0.01);
}

/**
 * 按视频原始分辨率截一张：画面 → 弹幕 → 画笔笔迹（和播放器里的叠放顺序一致），
 * 左上角打时间戳水印，存成 PNG。叠加层的位置都按「原始宽 / 屏幕上的宽」等比放大。
 */
async function captureCurrentFrame() {
  if (!state.video) return;
  const video = dom.video;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height || video.readyState < 2) {
    toast('画面还没加载好，稍等再截', true);
    return;
  }

  const t = video.currentTime || 0;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  try {
    ctx.drawImage(video, 0, 0, width, height);
  } catch {
    toast('这一帧读不出来', true);
    return;
  }

  const scale = width / (dom.videoWrap.clientWidth || width);
  drawOverlayBoxes(ctx, danmaku.snapshot(), scale);

  const visible = state.annotations.filter((a) => t >= a.start - 0.03 && t < a.end);
  if (visible.length) {
    ctx.save();
    ctx.globalAlpha = 0.95;
    for (const annotation of visible) drawStrokes(ctx, annotation.strokes, width, height);
    ctx.restore();
  }
  if (state.draw && pad.strokes.length) drawStrokes(ctx, pad.strokes, width, height);

  const frame = frameNumber(t);
  drawWatermark(ctx, `${timecode(t)} · 第 ${frame} 帧`, scale);

  const stamp = timecode(t).replace(/:/g, '-').replace('.', '_');
  const filename = `${safeFileName(state.video.title)}_${stamp}_第${frame}帧.png`;
  try {
    await downloadCanvas(canvas, filename);
    toast(`已截取 ${timecode(t)}（${width}×${height}）`);
  } catch (err) {
    toast(err.message || '截图失败', true);
  }
}

/* ── 时间轴标记 ───────────────────────────────────────────────────── */

function renderMarks() {
  if (state.annDrag) {
    state.marksPending = true;
    return;
  }
  state.marksPending = false;
  const total = duration() || 1;
  const nodes = [];
  let selectedMark = null;

  for (const comment of state.comments) {
    const mark = document.createElement('div');
    mark.className = 'mark comment';
    mark.style.left = `${Math.min(100, (comment.time / total) * 100)}%`;
    nodes.push(mark);
  }

  for (const annotation of state.annotations) {
    const left = Math.min(100, (annotation.start / total) * 100);
    const widthPercent = Math.min(100 - left, ((annotation.end - annotation.start) / total) * 100);
    const mark = document.createElement('div');
    mark.className = 'mark annotation span';
    mark.style.left = `${left}%`;
    mark.style.width = `${Math.max(0.4, widthPercent)}%`;
    mark.title = `${annotation.author || '匿名'} 的画笔 · 点一下选中后可拖两端改入点/出点`;
    mark.addEventListener('pointerdown', (event) => {
      if (!state.video || state.draw || event.button > 0) return;
      // 别让时间轴把这一下当成拖进度
      event.stopPropagation();
      event.preventDefault();
      selectAnnotation(annotation.id);
      jumpTo(annotation.start);
    });
    if (annotation.id === state.annSelected && !state.draw) {
      mark.classList.add('selected');
      mark.append(annHandle(annotation, 'start'), annHandle(annotation, 'end'));
      selectedMark = mark;
      continue;
    }
    nodes.push(mark);
  }
  // 选中的放最后，叠在别的标注上面
  if (selectedMark) nodes.push(selectedMark);

  dom.timelineMarks.replaceChildren(...nodes);
}

function selectAnnotation(id) {
  if (state.annSelected === id) return;
  state.annSelected = id;
  renderMarks();
}

function annHandle(annotation, which) {
  const handle = document.createElement('div');
  handle.className = `ann-handle ${which}`;
  handle.title = which === 'start' ? '拖动修改入点' : '拖动修改出点';
  handle.addEventListener('pointerdown', (event) => startAnnDrag(event, annotation, which, handle));
  return handle;
}

/** 拖画笔标注的入点/出点：按帧吸附、实时预览，松手再存 */
function startAnnDrag(event, annotation, which, handle) {
  if (!state.video || state.draw || state.annDrag || event.button > 0) return;
  event.stopPropagation();
  event.preventDefault();
  const total = duration();
  if (!total) return;

  const fps = state.fps || 25;
  const frame = 1 / fps;
  const maxSpan = MAX_ANN_SPAN;
  const orig = { start: annotation.start, end: annotation.end };
  const mark = handle.parentElement;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const snap = (t) => Math.round(t * fps) / fps;

  dom.video.pause();
  state.annDrag = { id: annotation.id, which };
  handle.setPointerCapture(event.pointerId);
  mark.classList.add('dragging');

  const tip = document.createElement('div');
  tip.className = 'ann-tip mono';
  dom.timeline.append(tip);

  let sidebarQueued = false;
  const paint = () => {
    const left = (annotation.start / total) * 100;
    mark.style.left = `${Math.min(100, left)}%`;
    mark.style.width = `${Math.max(0.4, Math.min(100 - left, ((annotation.end - annotation.start) / total) * 100))}%`;
    const at = which === 'start' ? annotation.start : annotation.end;
    const frames = Math.max(1, Math.round((annotation.end - annotation.start) * fps));
    tip.textContent = `${which === 'start' ? '入点' : '出点'} ${timecode(at)} · 共 ${frames} 帧`;
    tip.style.left = `${Math.min(100, (at / total) * 100)}%`;
    if (!sidebarQueued) {
      sidebarQueued = true;
      requestAnimationFrame(() => {
        sidebarQueued = false;
        renderSidebar();
      });
    }
  };

  const move = (ev) => {
    const rect = dom.timeline.getBoundingClientRect();
    const raw = clamp((ev.clientX - rect.left) / rect.width, 0, 1) * total;
    if (which === 'start') {
      const lo = Math.max(0, annotation.end - maxSpan);
      annotation.start = clamp(snap(raw), lo, annotation.end - frame);
    } else {
      const hi = Math.min(total, annotation.start + maxSpan);
      annotation.end = clamp(snap(raw), annotation.start + frame, hi);
    }
    paint();
    // 画面跟着停到拖到的那一帧：入点看第一帧，出点看最后一帧（end 本身不含）
    const preview = which === 'start' ? annotation.start : Math.max(annotation.start, annotation.end - frame);
    seekTo(preview + 0.001);
  };

  const finish = async (ev, cancelled) => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onCancel);
    if (handle.hasPointerCapture?.(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
    tip.remove();
    state.annDrag = null;

    const changed = Math.abs(annotation.start - orig.start) > 1e-6 || Math.abs(annotation.end - orig.end) > 1e-6;
    if (cancelled || !changed) {
      Object.assign(annotation, orig);
      afterRangeChange();
      return;
    }
    afterRangeChange();
    try {
      const result = await api.setAnnotationRange(annotation.id, annotation.start, annotation.end);
      applyItemUpdate('annotation', result.annotation);
    } catch (err) {
      Object.assign(annotation, orig);
      afterRangeChange();
      toast(err.message, true);
    }
  };
  const onUp = (ev) => finish(ev, false);
  const onCancel = (ev) => finish(ev, true);

  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onCancel);
  paint();
}

/** 标注区间改了之后：重新排序，时间轴、侧栏、报告一起刷新 */
function afterRangeChange() {
  state.annotations.sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
  renderMarks();
  renderSidebar();
  reportView.refresh();
  if (dom.video.paused) updateFocus();
}

/* ── 侧栏 ─────────────────────────────────────────────────────────── */

function emptyHint(text) {
  const div = document.createElement('div');
  div.className = 'list-empty';
  div.textContent = text;
  return div;
}

function updateCounts() {
  dom.countAll.textContent = String(state.comments.length + state.annotations.length);
  dom.countComment.textContent = String(state.comments.length);
  dom.countAnnotation.textContent = String(state.annotations.length);
}

function renderSidebar() {
  updateCounts();
  setAuthorRoster(state.comments, state.annotations);

  if (!state.video) return;

  const items = [];
  if (state.tab !== 'annotation') {
    for (const comment of state.comments) items.push({ type: 'comment', time: comment.time, data: comment });
  }
  if (state.tab !== 'comment') {
    for (const annotation of state.annotations) items.push({ type: 'annotation', time: annotation.start, data: annotation });
  }
  items.sort((a, b) => a.time - b.time);

  if (!items.length) {
    const hint = state.tab === 'annotation'
      ? '还没有画笔标注。点「画笔」框住一段连续帧，直接在画面上圈重点。'
      : '还没有弹幕。暂停在任意一帧，下面输入就能发。';
    dom.list.replaceChildren(emptyHint(hint));
    return;
  }

  dom.list.replaceChildren(...items.map((item) => (
    item.type === 'comment' ? buildCommentItem(item.data) : buildAnnotationItem(item.data)
  )));
}

function jumpTo(time) {
  dom.video.pause();
  seekTo(time + 0.001);
  setTimeout(updateFocus, 80);
}

function buildCommentItem(comment) {
  const item = document.createElement('div');
  item.className = 'item' + (comment.done ? ' done' : '');
  item.style.setProperty('--dm-color', authorColor(comment.author));

  const head = document.createElement('div');
  head.className = 'item-head';

  const author = document.createElement('span');
  author.className = 'item-author';
  author.textContent = comment.author || '匿名';

  const time = document.createElement('span');
  time.className = 'item-time mono';
  time.textContent = timecode(comment.time);

  const del = document.createElement('button');
  del.className = 'item-del';
  del.type = 'button';
  del.textContent = '✕';
  del.title = '删除这条弹幕';
  del.addEventListener('click', (event) => {
    event.stopPropagation();
    removeComment(comment);
  });

  const replyBtn = buildReplyButton('comment', comment);
  const mine = Boolean(state.author) && comment.author === state.author;
  const editing = mine && state.editOpen === comment.id;

  head.append(author, time);
  if (comment.editedAt) head.append(editedFlag(comment));
  if (comment.done) head.append(doneFlag());
  if (mine) head.append(buildEditButton(comment, editing));
  head.append(replyBtn, del);

  let text;
  if (editing) {
    text = buildEditForm(comment);
  } else {
    text = document.createElement('p');
    text.className = 'item-text';
    text.textContent = comment.text;
  }

  item.append(head, text, ...buildReplyParts('comment', comment));
  item.addEventListener('click', () => jumpTo(comment.time));
  return item;
}

/* ── 修改自己的弹幕 ─────────────────────────────────────────────── */

function editedFlag(comment) {
  const flag = document.createElement('span');
  flag.className = 'item-edited';
  flag.textContent = '已编辑';
  const at = new Date(comment.editedAt);
  if (!Number.isNaN(at.getTime())) flag.title = `修改于 ${at.toLocaleString()}`;
  return flag;
}

function buildEditButton(comment, editing) {
  const button = document.createElement('button');
  button.className = 'item-reply-btn item-edit-btn' + (editing ? ' active' : '');
  button.type = 'button';
  button.textContent = '编辑';
  button.title = '修改我的这条弹幕';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.editOpen === comment.id) closeEdit();
    else openEdit(comment);
  });
  return button;
}

function openEdit(comment) {
  state.replyOpen = null;
  state.replyDraft = '';
  state.replyFocus = false;
  state.editOpen = comment.id;
  state.editDraft = comment.text || '';
  state.editFocus = true;
  renderSidebar();
}

function closeEdit() {
  state.editOpen = null;
  state.editDraft = '';
  state.editFocus = false;
  renderSidebar();
}

function buildEditForm(comment) {
  const form = document.createElement('form');
  form.className = 'reply-form edit-form';
  form.addEventListener('click', (event) => event.stopPropagation());

  const input = document.createElement('input');
  input.className = 'reply-input';
  input.type = 'text';
  input.maxLength = 500;
  input.autocomplete = 'off';
  input.placeholder = '修改弹幕内容，回车保存';
  input.value = state.editDraft;
  input.addEventListener('input', () => {
    state.editDraft = input.value;
  });
  input.addEventListener('focus', () => {
    state.editFocus = true;
  });
  input.addEventListener('blur', () => {
    state.editFocus = false;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing) {
      event.stopPropagation();
      closeEdit();
    }
  });

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn primary reply-send';
  save.textContent = '保存';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn reply-cancel';
  cancel.textContent = '取消';
  cancel.addEventListener('click', (event) => {
    event.stopPropagation();
    closeEdit();
  });

  form.append(input, save, cancel);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      toast('弹幕内容不能为空', true);
      return;
    }
    if (text === comment.text) {
      closeEdit();
      return;
    }
    input.disabled = true;
    save.disabled = true;
    try {
      const result = await api.editComment(comment.id, text, state.author);
      state.editOpen = null;
      state.editDraft = '';
      state.editFocus = false;
      applyItemUpdate('comment', result.comment);
    } catch (err) {
      input.disabled = false;
      save.disabled = false;
      input.focus();
      toast(err.message, true);
    }
  });

  if (state.editFocus) {
    requestAnimationFrame(() => {
      if (!input.isConnected) return;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  }
  return form;
}

/* ── 回复（弹幕和画笔标注共用） ─────────────────────────────────── */

const REPLY_NOUN = { comment: '弹幕', annotation: '画笔标注' };

function replyKey(kind, id) {
  return `${kind}:${id}`;
}

function buildReplyButton(kind, target) {
  const replies = Array.isArray(target.replies) ? target.replies : [];
  const button = document.createElement('button');
  button.className = 'item-reply-btn' + (state.replyOpen === replyKey(kind, target.id) ? ' active' : '');
  button.type = 'button';
  button.textContent = replies.length ? `回复 ${replies.length}` : '回复';
  button.title = kind === 'comment'
    ? '在这条弹幕下补充意见，会和它一起出现'
    : '在这个画笔标注下补充意见';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleReply(kind, target.id);
  });
  return button;
}

/** 列表项下方：已有回复 + （如果正在回复这一条）输入框 */
function buildReplyParts(kind, target) {
  const parts = [];
  if (Array.isArray(target.replies) && target.replies.length) parts.push(buildReplyList(kind, target));
  if (state.replyOpen === replyKey(kind, target.id)) parts.push(buildReplyForm(kind, target));
  return parts;
}

function buildReplyList(kind, target) {
  const list = document.createElement('div');
  list.className = 'item-replies';
  for (const reply of target.replies) {
    const row = document.createElement('div');
    row.className = 'reply';
    row.style.setProperty('--dm-color', authorColor(reply.author));

    const author = document.createElement('span');
    author.className = 'reply-author';
    author.textContent = reply.author || '匿名';

    const text = document.createElement('span');
    text.className = 'reply-text';
    text.textContent = reply.text;

    row.append(author, text);
    if (state.author && reply.author === state.author) {
      const del = document.createElement('button');
      del.className = 'reply-del';
      del.type = 'button';
      del.textContent = '✕';
      del.title = '删除我的这条回复';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        removeReply(kind, target, reply);
      });
      row.append(del);
    }
    list.append(row);
  }
  return list;
}

function buildReplyForm(kind, target) {
  const form = document.createElement('form');
  form.className = 'reply-form';
  form.addEventListener('click', (event) => event.stopPropagation());

  const input = document.createElement('input');
  input.className = 'reply-input';
  input.type = 'text';
  input.maxLength = 500;
  input.autocomplete = 'off';
  input.placeholder = `回复 ${target.author || '匿名'}，回车发送`;
  input.value = state.replyDraft;
  input.addEventListener('input', () => {
    state.replyDraft = input.value;
  });
  input.addEventListener('focus', () => {
    state.replyFocus = true;
  });
  input.addEventListener('blur', () => {
    state.replyFocus = false;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing) {
      event.stopPropagation();
      closeReply();
    }
  });

  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'btn primary reply-send';
  send.textContent = '回复';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn reply-cancel';
  cancel.textContent = '取消';
  cancel.addEventListener('click', (event) => {
    event.stopPropagation();
    closeReply();
  });

  form.append(input, send, cancel);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (!requireName(`先写上你的名字，再回复同事的${REPLY_NOUN[kind]}`)) return;
    input.disabled = true;
    send.disabled = true;
    try {
      const result = await api.addReply(kind, target.id, { author: authorName(), text });
      state.replyOpen = null;
      state.replyDraft = '';
      state.replyFocus = false;
      applyItemUpdate(kind, result[kind], { fromSelf: true });
    } catch (err) {
      input.disabled = false;
      send.disabled = false;
      input.focus();
      toast(err.message, true);
    }
  });

  // 列表重画前输入框是聚焦的（打字时别人发了弹幕），重画后把焦点还回去
  if (state.replyFocus) {
    requestAnimationFrame(() => {
      if (!input.isConnected) return;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  }
  return form;
}

/** 全局只开一个回复框：打开别的一条时，前一个直接收起 */
function toggleReply(kind, id) {
  const key = replyKey(kind, id);
  if (state.replyOpen === key) {
    closeReply();
    return;
  }
  state.replyOpen = key;
  state.replyDraft = '';
  state.replyFocus = true;
  state.editOpen = null;
  state.editDraft = '';
  state.editFocus = false;
  renderSidebar();
}

// 点回复框以外的地方，且没写内容时自动收起
document.addEventListener('pointerdown', (event) => {
  if (!state.replyOpen || state.replyDraft.trim()) return;
  if (event.target.closest('.reply-form, .item-reply-btn, .edit-form')) return;
  closeReply();
});

function closeReply() {
  state.replyOpen = null;
  state.replyDraft = '';
  state.replyFocus = false;
  renderSidebar();
}

/** 被回复的那一条已经删掉了，回复框跟着关 */
function dropReplyFor(kind, id) {
  if (state.replyOpen !== replyKey(kind, id)) return;
  state.replyOpen = null;
  state.replyDraft = '';
  state.replyFocus = false;
}

async function removeReply(kind, target, reply) {
  if (!window.confirm('删除这条回复？')) return;
  try {
    const result = await api.deleteReply(kind, target.id, reply.id, authorName());
    applyItemUpdate(kind, result[kind]);
  } catch (err) {
    toast(err.message, true);
  }
}

/** 服务端推来的整条弹幕 / 画笔标注（勾选已改 / 增删回复）合进本地 */
function applyItemUpdate(kind, data, { fromSelf = false } = {}) {
  const list = kind === 'comment' ? state.comments : state.annotations;
  const item = list.find((x) => x.id === data?.id);
  if (!item) return;
  if (typeof data.done === 'boolean') item.done = data.done;
  // 入点/出点被改了（自己松手保存，或同事拖的）；自己正拖着这条时不让推送打断
  let rangeChanged = false;
  if (kind === 'annotation' && typeof data.start === 'number' && typeof data.end === 'number'
    && state.annDrag?.id !== item.id && (item.start !== data.start || item.end !== data.end)) {
    item.start = data.start;
    item.end = data.end;
    rangeChanged = true;
  }
  let repliesChanged = false;
  if (Array.isArray(data.replies)) {
    const key = (arr) => (arr || []).map((r) => r.id).join(',');
    repliesChanged = key(item.replies) !== key(data.replies);
    item.replies = data.replies;
  }
  // 作者改了弹幕文字（自己保存，或 SSE 推来的同一次修改）
  let textChanged = false;
  if (kind === 'comment' && typeof data.text === 'string' && data.text !== item.text) {
    item.text = data.text;
    textChanged = true;
  }
  if (kind === 'comment' && data.editedAt) item.editedAt = data.editedAt;
  if (rangeChanged) {
    state.annotations.sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
    renderMarks();
  }
  renderSidebar();
  reportView.refresh();
  // 自己的请求和 SSE 会各来一次，回复没变就不重弹
  // 气泡在场就收掉重弹，显示新文字 / 新回复
  if (repliesChanged || textChanged) refreshBubble(kind, item, { fromSelf });
  if (dom.video.paused) updateFocus();
}

function doneFlag() {
  const flag = document.createElement('span');
  flag.className = 'item-flag';
  flag.textContent = '已改';
  return flag;
}

function buildAnnotationItem(annotation) {
  const item = document.createElement('div');
  item.className = 'item item-annotation' + (annotation.done ? ' done' : '');
  item.style.setProperty('--dm-color', authorColor(annotation.author));

  const thumb = document.createElement('canvas');
  const tw = 92;
  const th = 52;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  thumb.width = tw * dpr;
  thumb.height = th * dpr;
  thumb.style.width = `${tw}px`;
  thumb.style.height = `${th}px`;
  const ctx = thumb.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawStrokes(ctx, annotation.strokes, tw, th);

  const body = document.createElement('div');
  body.className = 'item-body';

  const head = document.createElement('div');
  head.className = 'item-head';

  const author = document.createElement('span');
  author.className = 'item-author';
  author.textContent = annotation.author || '匿名';

  const time = document.createElement('span');
  time.className = 'item-time mono';
  time.textContent = timecode(annotation.start);

  const del = document.createElement('button');
  del.className = 'item-del';
  del.type = 'button';
  del.textContent = '✕';
  del.title = '删除这个标注';
  del.addEventListener('click', (event) => {
    event.stopPropagation();
    removeAnnotation(annotation);
  });

  head.append(author, time);
  if (annotation.done) head.append(doneFlag());
  head.append(buildReplyButton('annotation', annotation), del);

  const sub = document.createElement('p');
  sub.className = 'item-sub';
  const frames = Math.max(1, Math.round((annotation.end - annotation.start) * state.fps));
  sub.textContent = `第 ${frames} 帧 · ${timecode(annotation.end)} 结束`;

  body.append(head, sub, ...buildReplyParts('annotation', annotation));
  item.append(thumb, body);
  item.addEventListener('click', () => {
    selectAnnotation(annotation.id);
    jumpTo(annotation.start);
  });
  return item;
}

async function removeComment(comment) {
  if (!window.confirm('删除这条弹幕？')) return;
  try {
    await api.deleteComment(comment.id);
    removeCommentLocal(comment.id);
  } catch (err) {
    toast(err.message, true);
  }
}

function removeCommentLocal(id) {
  state.comments = state.comments.filter((c) => c.id !== id);
  dropReplyFor('comment', id);
  if (state.editOpen === id) {
    state.editOpen = null;
    state.editDraft = '';
    state.editFocus = false;
  }
  renderSidebar();
  renderMarks();
  updateFocus();
}

async function removeAnnotation(annotation) {
  if (!window.confirm('删除这个画笔标注？')) return;
  try {
    await api.deleteAnnotation(annotation.id);
    removeAnnotationLocal(annotation.id);
  } catch (err) {
    toast(err.message, true);
  }
}

function removeAnnotationLocal(id) {
  state.annotations = state.annotations.filter((a) => a.id !== id);
  dropReplyFor('annotation', id);
  annView.fit();
  renderSidebar();
  renderMarks();
}

/* ── 弹幕输入 ─────────────────────────────────────────────────────── */

function lockComposeTime(time) {
  state.composeTime = time;
  dom.composerTime.textContent = timecode(time);
  dom.composerTime.classList.add('locked');
  dom.composerTime.title = '开始输入时的时间点，发出去的弹幕就挂在这一帧';
}

function unlockComposeTime() {
  state.composeTime = null;
  dom.composerTime.classList.remove('locked');
  dom.composerTime.title = '';
  dom.composerTime.textContent = timecode(dom.video.currentTime || 0);
}

/** 发一条弹幕：主输入框和整体意见共用，接口、数据结构完全一样 */
async function postComment(text, time) {
  const { comment } = await api.addComment(state.video.id, {
    text,
    time,
    author: authorName(),
    color: authorColor(authorName()),
  });
  upsertComment(comment);
  return comment;
}

/**
 * 整体意见 = 一条挂在第 0 帧的普通弹幕。不 seek、不碰主输入框锁定的时间；
 * 播放头就在片头附近时直接上屏，否则提示一下挂在哪了。
 */
function initOverall() {
  dom.overallForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.video) return;
    if (!requireName('发整体意见前先写个名字')) return;

    const text = dom.overallInput.value.trim();
    if (!text) {
      dom.overallInput.focus();
      return;
    }

    const button = dom.overallForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const comment = await postComment(text, 0);
      dom.overallInput.value = '';
      if ((dom.video.currentTime || 0) <= 3) showNow(comment);
      else toast('整体意见已记在第 0 帧');
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

function initComposer() {
  // 第一次按键就把时间钉住：边播边打字时，回车那一刻视频早已往后走了好几秒。
  // 中文输入法先触发 compositionstart，拼音还没上屏也算「开始输入」。
  const begin = () => {
    if (state.video && state.composeTime === null) lockComposeTime(dom.video.currentTime || 0);
  };
  dom.composerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === 'Escape' || event.key === 'Tab') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1 || event.key === 'Process') begin();
  });
  dom.composerInput.addEventListener('compositionstart', begin);
  dom.composerInput.addEventListener('paste', begin);
  dom.composerInput.addEventListener('input', () => {
    if (dom.composerInput.value) begin();
    else unlockComposeTime(); // 删光了重来，下次按键重新取时间
  });

  dom.composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.video) return;
    if (!requireName('发弹幕前先写个名字')) return;

    const text = dom.composerInput.value.trim();
    if (!text) {
      dom.composerInput.focus();
      return;
    }

    const time = state.composeTime ?? (dom.video.currentTime || 0);
    dom.composerInput.value = '';
    unlockComposeTime();

    try {
      const comment = await postComment(text, time);
      // 自己刚发的立刻上屏：它的时间点在输入那一刻，播放头早已越过，等时间轴触发就永远等不到
      showNow(comment);
    } catch (err) {
      dom.composerInput.value = text;
      lockComposeTime(time);
      toast(err.message, true);
    }
  });
}

function upsertComment(comment, { live = false } = {}) {
  if (state.comments.some((c) => c.id === comment.id)) return;
  if (!Array.isArray(comment.replies)) comment.replies = [];
  state.comments.push(comment);
  state.comments.sort((a, b) => a.time - b.time || a.createdAt - b.createdAt);
  renderSidebar();
  renderMarks();
  // 同事刚发、而且就在我播放头附近的，也直接上屏
  if (live) {
    const gap = (dom.video.currentTime || 0) - comment.time;
    if (gap >= -0.05 && gap <= 3) showNow(comment);
  }
  if (dom.video.paused) updateFocus();
}

/** 立刻在画面上方显示这条弹幕（暂停时会定住，继续播放再淡出） */
function showNow(comment) {
  if (!state.video || state.draw) return;
  danmaku.setPaused(dom.video.paused);
  danmaku.pop(comment);
  if (dom.video.paused) updateFocus();
}

function upsertAnnotation(annotation) {
  if (state.annotations.some((a) => a.id === annotation.id)) return;
  if (!Array.isArray(annotation.replies)) annotation.replies = [];
  state.annotations.push(annotation);
  state.annotations.sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
  renderSidebar();
  renderMarks();
}

/** 报告里的「已改」勾选：先本地改，失败再回滚 */
async function toggleDone(kind, id, done) {
  const list = kind === 'comment' ? state.comments : state.annotations;
  const item = list.find((x) => x.id === id);
  if (!item) return;

  const previous = Boolean(item.done);
  item.done = done;
  renderSidebar();
  reportView.refresh();

  try {
    if (kind === 'comment') await api.setCommentDone(id, done);
    else await api.setAnnotationDone(id, done);
  } catch (err) {
    item.done = previous;
    renderSidebar();
    reportView.refresh();
    toast(err.message, true);
  }
}

/* ── 画笔 ─────────────────────────────────────────────────────────── */

function initDrawToolbar() {
  state.color = DRAW_COLORS[0];
  dom.swatches.replaceChildren(...DRAW_COLORS.map((color) => {
    const button = document.createElement('button');
    button.className = 'swatch' + (color === state.color ? ' on' : '');
    button.type = 'button';
    button.style.setProperty('--sw', color);
    button.title = `画笔颜色 ${color}`;
    button.addEventListener('click', () => {
      state.color = color;
      pad.setColor(color);
      for (const node of dom.swatches.children) node.classList.toggle('on', node === button);
    });
    return button;
  }));

  for (const button of document.querySelectorAll('[data-nudge]')) {
    button.addEventListener('click', () => {
      const [which, dir] = button.dataset.nudge.split(':');
      nudgeEndpoint(which, Number(dir));
    });
  }

  dom.markIn.addEventListener('click', () => setEndpoint('start'));
  dom.markOut.addEventListener('click', () => setEndpoint('end'));
  dom.previewRange.addEventListener('click', previewRange);
  dom.drawUndo.addEventListener('click', () => pad.undo());
  dom.drawClear.addEventListener('click', () => pad.clear());
  dom.drawCancel.addEventListener('click', () => exitDrawMode());
  dom.drawSave.addEventListener('click', saveAnnotation);
}

function enterDrawMode() {
  if (!state.video) return;
  const total = duration();
  if (!total) {
    toast('等视频加载完再标');
    return;
  }

  dom.video.pause();
  const start = Math.min(dom.video.currentTime || 0, Math.max(0, total - 0.05));
  const span = 6 / (state.fps || 25);
  state.draw = { start, end: Math.min(total, start + span) };
  if (state.draw.end - state.draw.start < 1 / state.fps) {
    state.draw.end = Math.min(total, state.draw.start + 2 / state.fps);
  }

  dom.pausedBadge.hidden = true;
  dom.drawToolbar.hidden = false;
  dom.drawToggle.classList.add('active');
  dom.videoWrap.classList.add('drawing');
  pad.setColor(state.color);
  pad.setEnabled(true);
  pad.reset();
  refreshDrawButtons();
  seekTo(state.draw.start);
  updateRangeUI();
  renderMarks(); // 画画时收起标注手把
  danmaku.showFocus([]);
  toast('框好帧区间，直接在画面上圈');
}

function exitDrawMode() {
  state.draw = null;
  renderMarks();
  dom.drawToolbar.hidden = true;
  dom.drawToggle.classList.remove('active');
  dom.videoWrap.classList.remove('drawing');
  pad.setEnabled(false);
  pad.reset();
  refreshDrawButtons();
  annView.fit();
  dom.pausedBadge.hidden = !dom.video.paused;
}

function refreshDrawButtons() {
  const has = pad.strokes.length > 0;
  dom.drawUndo.disabled = !has;
  dom.drawClear.disabled = !has;
  dom.drawSave.disabled = !has;
}

function clampEndpoint(which, value) {
  const total = duration();
  const minGap = 1 / (state.fps || 25);
  if (which === 'start') {
    state.draw.start = Math.max(0, Math.min(state.draw.end - minGap, value));
  } else {
    state.draw.end = Math.min(total, Math.max(state.draw.start + minGap, value));
  }
  updateRangeUI();
}

function nudgeEndpoint(which, direction) {
  if (!state.draw) return;
  const step = direction / (state.fps || 25);
  const current = which === 'start' ? state.draw.start : state.draw.end;
  clampEndpoint(which, current + step);
  seekTo(which === 'start' ? state.draw.start : state.draw.end);
  dom.video.pause();
}

function setEndpoint(which) {
  if (!state.draw) return;
  clampEndpoint(which, dom.video.currentTime || 0);
  toast(which === 'start' ? '已把当前这一帧设为入点' : '已把当前这一帧设为出点');
}

function updateRangeUI() {
  if (!state.draw) return;
  const { start, end } = state.draw;
  const fps = state.fps || 25;
  const frames = Math.max(1, Math.round((end - start) * fps));
  dom.rangeIn.textContent = timecode(start);
  dom.rangeOut.textContent = timecode(end);
  dom.rangeSummary.textContent = `${frames} 帧 · ${(end - start).toFixed(2)}s · ${fps}fps`;
}

function previewRange() {
  if (!state.draw) return;
  const { start, end } = state.draw;
  seekTo(start);
  dom.video.play().catch(() => {});

  const stopAtEnd = () => {
    if (dom.video.currentTime >= end - 0.004) {
      dom.video.pause();
      dom.video.removeEventListener('timeupdate', stopAtEnd);
    }
  };
  dom.video.addEventListener('timeupdate', stopAtEnd);
  setTimeout(() => dom.video.removeEventListener('timeupdate', stopAtEnd), 30_000);
}

async function saveAnnotation() {
  if (!state.draw || !state.video) return;
  if (!requireName('标注要署名才能保存，视频下方工具栏里就能填')) return;
  const strokes = pad.strokes;
  if (!strokes.length) {
    toast('先画两笔再保存');
    return;
  }

  const payload = {
    start: state.draw.start,
    end: state.draw.end,
    author: authorName(),
    color: state.color,
    strokes: strokes.map((stroke) => ({
      color: stroke.color,
      width: stroke.width,
      points: stroke.points.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]),
    })),
  };
  const keepStart = state.draw.start;

  try {
    const { annotation } = await api.addAnnotation(state.video.id, payload);
    upsertAnnotation(annotation);
    exitDrawMode();
    seekTo(keepStart);
    toast('标注已保存');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ── 实时同步 ─────────────────────────────────────────────────────── */

function initPresence() {
  dom.presence.hidden = true;
}

function setPresence(count) {
  const n = Number(count) || 0;
  dom.presence.hidden = !state.video;
  dom.presenceCount.textContent = String(n);
}

function connectEvents(videoId) {
  state.es?.close();
  const es = new EventSource(`/api/events?video=${encodeURIComponent(videoId || '')}`);
  state.es = es;

  const on = (name, handler) => es.addEventListener(name, (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    handler(data);
  });

  on('hello', (data) => setPresence(data.count));
  on('presence', (data) => {
    if (data.videoId === state.video?.id) setPresence(data.count);
  });
  on('comment:new', (data) => {
    if (data.comment?.videoId === state.video?.id) upsertComment(data.comment, { live: true });
  });
  on('comment:removed', (data) => {
    if (data.videoId === state.video?.id) removeCommentLocal(data.commentId);
  });
  on('annotation:new', (data) => {
    if (data.annotation?.videoId === state.video?.id) upsertAnnotation(data.annotation);
  });
  on('comment:updated', (data) => applyItemUpdate('comment', data.comment));
  on('annotation:updated', (data) => applyItemUpdate('annotation', data.annotation));
  on('annotation:removed', (data) => {
    if (data.videoId === state.video?.id) removeAnnotationLocal(data.annotationId);
  });
  on('video:added', () => refreshVideos());
  on('video:removed', (data) => {
    refreshVideos();
    if (state.video?.id === data.videoId) {
      toast('这支片被上传者删掉了');
      location.hash = '#/';
    }
  });

  es.addEventListener('error', () => {
    // EventSource 自带重连，这里只做提示
    if (es.readyState === EventSource.CLOSED) setTimeout(() => connectEvents(state.video?.id), 3000);
  });
}

/* ── 片库 / 上传 ──────────────────────────────────────────────────── */

async function refreshVideos() {
  try {
    const data = await api.listVideos();
    state.videos = data.videos;
  } catch {
    state.videos = [];
  }
  if (!dom.libraryModal.hidden) renderLibrary();
}

function initModals() {
  dom.libraryOpen.addEventListener('click', () => {
    renderLibrary();
    openModal(dom.libraryModal);
  });
  dom.uploadOpen.addEventListener('click', openUpload);
  dom.uploadOpenEmpty.addEventListener('click', openUpload);

  for (const button of document.querySelectorAll('[data-close-modal]')) {
    button.addEventListener('click', () => button.closest('.modal').hidden = true);
  }
  for (const modal of document.querySelectorAll('.modal')) {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) modal.hidden = true;
    });
  }

  dom.dropzone.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', () => {
    stageFile(dom.fileInput.files?.[0]);
    dom.fileInput.value = '';
  });
  dom.uploadStart.addEventListener('click', startUpload);
  dom.reportOpen.addEventListener('click', () => reportView.open());

  for (const tab of dom.tabs.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      for (const node of dom.tabs.querySelectorAll('.tab')) node.classList.toggle('active', node === tab);
      renderSidebar();
    });
  }
}

function openModal(modal) {
  modal.hidden = false;
}

function openUpload() {
  state.pendingFile = null;
  dom.uploadPending.hidden = true;
  dom.uploadProgress.hidden = true;
  dom.barFill.style.width = '0%';
  dom.uploadStatus.textContent = '';
  dom.uploadAuthor.value = state.author;
  updateUploadButton();
  openModal(dom.uploadModal);
  if (!state.author) setTimeout(() => dom.uploadAuthor.focus(), 60);
}

function updateUploadButton() {
  if (!dom.uploadStart) return;
  const ready = Boolean(state.author && state.pendingFile);
  dom.uploadStart.disabled = !ready;
}

async function stageFile(file) {
  if (!file || state.uploading) return;

  const looksVideo = /^video\//.test(file.type) || /\.(mp4|m4v|webm|mov|ogv|mkv)$/i.test(file.name);
  if (!looksVideo) {
    toast('这看起来不是视频文件', true);
    return;
  }

  state.pendingFile = file;
  dom.pendingName.textContent = file.name;
  dom.pendingSize.textContent = fileSize(file.size);
  dom.uploadPending.hidden = false;
  dom.uploadProgress.hidden = true;
  updateUploadButton();

  if (state.author) {
    startUpload();
  } else {
    // 没有署名就停在这里，等填完名字再点开始
    focusAuthor(true);
    toast('先写上你的名字，再点「开始上传」');
  }
}

async function startUpload() {
  const file = state.pendingFile;
  if (!file || state.uploading) return;
  if (!requireName('上传前必须写上你的名字', true)) return;

  state.uploading = true;
  state.pendingFile = null;
  dom.uploadStart.disabled = true;
  dom.uploadProgress.hidden = false;
  dom.barFill.style.width = '0%';
  dom.uploadStatus.textContent = '读取视频信息…';

  const duration = await probeDuration(file);
  if (!duration) dom.uploadStatus.textContent = '浏览器读不出时长，仍然可以上传';

  try {
    const data = await uploadVideo(
      file,
      {
        title: dom.titleInput.value.trim(),
        uploader: state.author,
        duration,
        fps: state.fps,
      },
      (progress) => {
        const percent = Math.round(progress * 100);
        dom.barFill.style.width = `${percent}%`;
        dom.uploadStatus.textContent = `上传中 ${percent}% · ${fileSize(file.size)}`;
      },
    );

    dom.barFill.style.width = '100%';
    dom.uploadStatus.textContent = '上传完成';
    dom.uploadModal.hidden = true;
    dom.uploadPending.hidden = true;
    dom.titleInput.value = '';
    await refreshVideos();
    location.hash = `#/v/${data.video.id}`;
    applyHash();
    toast('上传好了，把地址发给同事就能一起看');
  } catch (err) {
    dom.uploadStatus.textContent = err.message;
    dom.uploadPending.hidden = true;
    toast(err.message, true);
  } finally {
    state.uploading = false;
    updateUploadButton();
  }
}

function renderLibrary() {
  if (!state.videos.length) {
    dom.libraryGrid.replaceChildren(emptyHint('片库还是空的，先上传一支。'));
    return;
  }

  const cards = state.videos.map((video) => {
    const card = document.createElement('div');
    card.className = 'lib-card';

    const main = document.createElement('div');
    main.className = 'lib-main';

    const title = document.createElement('div');
    title.className = 'lib-title';
    title.textContent = video.title;

    const meta = document.createElement('div');
    meta.className = 'lib-meta';
    meta.textContent = [
      video.duration ? clockTime(video.duration) : '时长未知',
      fileSize(video.size),
      video.uploader ? `上传 ${video.uploader}` : '',
      relativeTime(video.createdAt),
    ].filter(Boolean).join(' · ');

    main.append(title, meta);

    const del = document.createElement('button');
    del.className = 'btn tiny ghost';
    del.type = 'button';
    del.textContent = '删除';
    del.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!window.confirm(`删除《${video.title}》及其全部弹幕和标注？文件会被移除。`)) return;
      try {
        await api.deleteVideo(video.id);
        await refreshVideos();
        renderLibrary();
        if (state.video?.id === video.id) location.hash = '#/';
      } catch (err) {
        toast(err.message, true);
      }
    });

    card.append(main, del);
    card.addEventListener('click', () => {
      dom.libraryModal.hidden = true;
      location.hash = `#/v/${video.id}`;
      applyHash();
    });
    return card;
  });

  dom.libraryGrid.replaceChildren(...cards);
}

function initDrop() {
  let depth = 0;
  let fileDrag = false;
  let hideTimer = 0;

  const hint = (on) => {
    clearTimeout(hideTimer);
    if (!on) {
      depth = 0;
      fileDrag = false;
    }
    document.body.classList.toggle('dragging', on);
  };

  // 部分浏览器的 dragleave.relatedTarget 不可靠，离开时给一个很短的缓冲，
  // 期间只要还有 dragover/dragenter 就取消收起，既不闪烁也一定收得掉。
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hint(false), 150);
  };

  const hasFiles = (event) => {
    const types = event.dataTransfer?.types;
    return types ? Array.from(types).includes('Files') : false;
  };

  // 全部走捕获阶段：弹窗里的元素即使 stopPropagation，也挡不住这里的收尾逻辑
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    clearTimeout(hideTimer);
    fileDrag = true;
    depth += 1;
    hint(true);
  }, true);

  window.addEventListener('dragover', (event) => {
    if (!fileDrag) return;
    event.preventDefault();
    clearTimeout(hideTimer);
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, true);

  window.addEventListener('dragleave', (event) => {
    if (!fileDrag) return;
    depth -= 1;
    if (depth <= 0 || event.relatedTarget === null) scheduleHide();
  }, true);

  window.addEventListener('drop', (event) => {
    if (!fileDrag) return;
    hint(false);
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (dom.uploadModal.hidden) openUpload();
    stageFile(file);
  }, true);

  window.addEventListener('dragend', () => hint(false), true);
  window.addEventListener('blur', () => hint(false));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hint(false);
  });
  // 兜底：遮罩若因任何意外留在屏幕上，点一下页面就收掉
  document.addEventListener('pointerdown', () => {
    if (document.body.classList.contains('dragging')) hint(false);
  }, true);
}

/* ── 快捷键 / 提示 ────────────────────────────────────────────────── */

function initKeyboard() {
  window.addEventListener('keydown', (event) => {
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);

    if (event.key === 'Escape') {
      for (const modal of document.querySelectorAll('.modal')) modal.hidden = true;
      if (state.draw) exitDrawMode();
      if (typing) active.blur();
      return;
    }

    if (typing || !state.video) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (event.shiftKey) seekTo((dom.video.currentTime || 0) - 1);
        else stepFrame(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (event.shiftKey) seekTo((dom.video.currentTime || 0) + 1);
        else stepFrame(1);
        break;
      case 'd':
      case 'D':
        state.draw ? exitDrawMode() : enterDrawMode();
        break;
      case 'i':
      case 'I':
        setEndpoint('start');
        break;
      case 'o':
      case 'O':
        setEndpoint('end');
        break;
      case 'z':
      case 'Z':
        if (state.draw) pad.undo();
        break;
      case 'f':
      case 'F':
        dom.fullscreenBtn.click();
        break;
      case 's':
      case 'S':
        captureCurrentFrame();
        break;
      default:
        break;
    }
  });
}

let toastTimer = null;

function toast(message, isError = false) {
  dom.toast.textContent = message;
  dom.toast.classList.toggle('err', isError);
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
  }, isError ? 4200 : 2400);
}
