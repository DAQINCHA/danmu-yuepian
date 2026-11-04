import { api, uploadVideo, probeDuration } from './js/api.js';
import { timecode, clockTime, fileSize, relativeTime, authorColor, setAuthorRoster } from './js/format.js';
import { createDanmaku } from './js/danmaku.js';
import { createAnnotationView, createDrawPad, drawStrokes } from './js/annotations.js';
import { createReportView } from './js/report.js';
import { detectFrameRate } from './js/fps.js';
import { createFrameGrabber, drawOverlayBoxes, drawWatermark, downloadCanvas, safeFileName } from './js/capture.js';

const $ = (id) => document.getElementById(id);
const DRAW_COLORS = ['#ff5a4d', '#ffd166', '#4ec9a0', '#8ab4ff'];
const STORE = {
  author: 'danmu:author',
  danmaku: 'danmu:danmaku',
  intro: 'danmu:intro',
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
  projects: [],
  uncategorized: null,
  // home = 项目卡片；project = 某个项目或未分类
  libraryPage: 'home',
  libraryProjectId: null,
  // 片库里正在改名的视频 id 和输入草稿（SSE 刷新列表时保留）
  renameId: null,
  renameDraft: '',
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
  pendingFile: null,
};

const dom = {};
let danmaku;
let annView;
let pad;
let reportView;
let lastFitCheck = 0;

/* ── 启动 ─────────────────────────────────────────────────────────── */

/** 手机竖屏：播放器贴满两边，高度跟着视频比例走，上下不留黑边 */
const edgeToEdgeQuery = window.matchMedia('(max-width: 860px) and (orientation: portrait)');
/** 和隐藏筛选标签同一档宽度：窄屏列表固定看「全部」 */
const mobileListQuery = window.matchMedia('(max-width: 860px)');

let composerExpanded = false;
/** 后台上传任务。片名不在开传时读取，点「上传并审片」才落定。 */
let uploadJob = null;
let uploadEpoch = 0;
let uploadConfirming = false;

boot();

/** 多组 / 多部署：服务端算好「弹幕阅片 · 品牌组」或「弹幕阅片 · danmu2」，这里同步到标签栏和左上角 */
function applySiteTitle() {
  api.getConfig().then(({ title }) => {
    if (!title) return;
    document.title = title;
    const brand = document.getElementById('brand-name');
    if (brand) brand.textContent = title;
  }).catch(() => {
    /* 拿不到就保持默认名字 */
  });
}

function boot() {
  applySiteTitle();
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
  initLockDialogs();
  initAskDialog();
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
  window.addEventListener('resize', () => {
    fitVideoWrap();
    placeAuthorHint();
  });
  window.visualViewport?.addEventListener('resize', placeAuthorHint);
  window.visualViewport?.addEventListener('scroll', placeAuthorHint);
  edgeToEdgeQuery.addEventListener?.('change', () => {
    syncComposerCollapse();
    // 转成竖屏时署名框会被收起规则藏掉，没名字就维持聚光并回到输入框
    if (!state.author) syncAuthorSpotlight({ focus: true });
    setTimeout(() => {
      fitVideoWrap();
      placeAuthorHint();
    }, 60);
  });
  mobileListQuery.addEventListener?.('change', syncMobileListFilter);
  syncMobileListFilter();
  window.addEventListener('hashchange', applyHash);
  syncTopbarNav();
  syncComposerCollapse();
  // 没署名就先压暗，首页和带片地址都一样，不必等列表回来
  syncAuthorSpotlight({ focus: !state.author });

  requestAnimationFrame(tick);
  refreshVideos().finally(applyHash);
}

function cacheDom() {
  const ids = [
    'author-field', 'author-input', 'author-veil', 'author-hint', 'presence', 'presence-count', 'library-open', 'home-open', 'project-new', 'upload-open',
    'empty-state', 'frame', 'video-wrap', 'video', 'danmaku-layer', 'ann-layer', 'draw-layer', 'paused-badge',
    'draw-toolbar', 'range-in', 'range-out', 'range-summary', 'swatches', 'mark-in', 'mark-out',
    'preview-range', 'draw-undo', 'draw-clear', 'draw-cancel', 'draw-save',
    'play-btn', 'tc-now', 'timeline', 'timeline-fill', 'timeline-marks', 'timeline-head', 'tc-total',
    'transport', 'step-back', 'step-fwd', 'draw-toggle', 'fps-input', 'fps-badge', 'fps-field',
    'danmaku-toggle', 'snap-btn', 'fullscreen-btn',
    'composer', 'composer-time', 'composer-input', 'composer-reveal', 'composer-collapse',
    'overall-form', 'overall-input',
    'video-title', 'video-meta', 'tabs', 'list', 'count-all', 'count-comment', 'count-annotation',
    'report-open',
    'library-modal', 'library-grid', 'library-page', 'library-crumb', 'project-grid', 'version-list',
    'project-rename', 'project-delete', 'project-password', 'project-lock', 'intro-card', 'intro-close',
    'upload-modal', 'dropzone', 'file-input', 'title-label', 'title-input', 'upload-project', 'upload-project-select', 'upload-new-project',
    'upload-new-lock', 'upload-new-password', 'upload-new-random',
    'lock-modal', 'lock-title', 'lock-input', 'lock-hint', 'lock-error', 'lock-cancel', 'lock-ok', 'lock-close',
    'project-form-modal', 'pf-title', 'pf-name', 'pf-current-field', 'pf-current',
    'pf-password', 'pf-random', 'pf-hint', 'pf-error', 'pf-remove', 'pf-cancel', 'pf-ok', 'pf-close',
    'ask-modal', 'ask-title', 'ask-secret-field', 'ask-secret', 'ask-secret-label',
    'ask-error', 'ask-cancel', 'ask-ok', 'ask-close',
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
      maybeBeginUpload();
    });
  }

  initAuthorSpotlight();
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
  syncAuthorSpotlight();
}

/** 和 index.html 里弹簧箭头一致：尖端是开口 V 的顶点，尾端是线的起点 */
const HINT_TIP = { x: 256, y: 114 };
const HINT_TAIL = { x: 80, y: 205 };
const HINT_SVG = { w: 400, h: 260 };
/** 线本身占的宽高（不含画布留白），用来按屏幕空档缩放 */
const HINT_REACH_X = HINT_TIP.x - HINT_TAIL.x;
const HINT_REACH_Y = 225 - 110;

/**
 * 没署名时：整页压暗，署名框留在暗层上面并聚焦。首页和看片都一样。
 * 有非空名字（沿用 setAuthor 的 trim）立刻撤掉遮罩、箭头和文案。
 * 竖屏看片会先展开输入区，否则署名框被收成「发弹幕」后 display:none。
 */
function syncAuthorSpotlight({ focus = false } = {}) {
  const on = !state.author;
  const was = document.body.classList.contains('author-spotlight');
  document.body.classList.toggle('author-spotlight', on);
  if (dom.authorVeil) dom.authorVeil.hidden = !on;
  if (dom.authorHint) dom.authorHint.hidden = !on;
  if (!on) return;

  // 全屏只显示画面，署名框在顶栏外面，先退出才能看见
  if (state.video && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  if (state.video && edgeToEdgeQuery.matches && !composerExpanded && !state.draw) expandComposer();
  requestAnimationFrame(() => {
    if (state.author) return;
    if (focus || !was) focusAuthorInput();
    placeAuthorHint();
  });
}

/** 箭头尖端对准署名框，文案放在尾端外侧；转屏和键盘弹出时重算，避免挤出屏幕 */
function placeAuthorHint() {
  const hint = dom.authorHint;
  const arrow = hint?.querySelector('.author-hint-arrow');
  const text = hint?.querySelector('.author-hint-text');
  if (!hint || !arrow || !text || hint.hidden) return;
  if (!document.body.classList.contains('author-spotlight')) return;

  const field = dom.authorField.getBoundingClientRect();
  if (field.width < 2 || field.height < 2) return;

  const vv = window.visualViewport;
  const vw = vv?.width || window.innerWidth;
  const vh = vv?.height || window.innerHeight;
  const ox = vv?.offsetLeft || 0;
  const oy = vv?.offsetTop || 0;
  const margin = 8;

  const spaceBelow = vh - field.bottom - margin;
  const spaceAbove = field.top - margin;
  const pointUp = spaceBelow >= 88 || spaceBelow >= spaceAbove;
  const tipX = Math.min(vw - margin, Math.max(margin, field.left + field.width / 2));
  const tipY = pointUp
    ? Math.min(vh - margin, field.bottom + 4)
    : Math.max(margin, field.top - 4);

  const along = Math.max(36, pointUp ? vh - tipY - margin : tipY - margin);
  const spaceLeft = tipX - margin;
  const spaceRight = vw - margin - tipX;
  const extendLeft = spaceLeft >= spaceRight;
  const across = Math.max(36, extendLeft ? spaceLeft : spaceRight);
  // 给文案留一行高度，线条按空档缩小，再收到约 85%，避免手机上画出屏幕
  const scale = Math.min(1, across / HINT_REACH_X, Math.max(48, along - 46) / HINT_REACH_Y) * 0.85;
  const sx = extendLeft ? 1 : -1;
  const sy = pointUp ? 1 : -1;

  const left = tipX - sx * scale * HINT_TIP.x;
  const top = tipY - sy * scale * HINT_TIP.y;
  arrow.style.left = `${left + ox}px`;
  arrow.style.top = `${top + oy}px`;
  arrow.style.width = `${HINT_SVG.w * scale}px`;
  arrow.style.height = `${HINT_SVG.h * scale}px`;
  arrow.style.transformOrigin = '0 0';
  arrow.style.transform = `scale(${sx}, ${sy})`;

  const tailX = tipX + sx * scale * (HINT_TAIL.x - HINT_TIP.x);
  const tw = text.offsetWidth;
  const th = text.offsetHeight;
  // 线圈最低落到画布 y=225，比线的起点更靠外。文字从这圈外缘再隔开约 14px
  const coilY = (y) => tipY + sy * scale * (y - HINT_TIP.y);
  const inkTop = Math.min(coilY(110), coilY(225)) - 2;
  const inkBottom = Math.max(coilY(110), coilY(225)) + 2;
  const tailGap = 14;
  let textX = tailX - tw / 2;
  let textY = pointUp ? inkBottom + tailGap : inkTop - tailGap - th;
  textX = Math.max(margin, Math.min(textX, vw - margin - tw));
  textY = Math.max(margin, Math.min(textY, vh - margin - th));
  const textBox = { left: textX, right: textX + tw, top: textY, bottom: textY + th };
  const hitsField = textBox.left < field.right && textBox.right > field.left
    && textBox.top < field.bottom && textBox.bottom > field.top;
  if (hitsField) {
    const below = field.bottom + 8;
    const above = field.top - th - 8;
    textY = below + th <= vh - margin ? below : Math.max(margin, above);
  }
  text.style.left = `${textX + ox}px`;
  text.style.top = `${textY + oy}px`;
}

function focusAuthorInput() {
  if (document.activeElement === dom.authorInput) return;
  dom.authorInput.focus();
}

function initAuthorSpotlight() {
  // 点暗处不要把焦点移走，也不要挡住署名框里的点击（框在暗层上面，事件到不了这里）
  const keepFocus = (event) => {
    if (!document.body.classList.contains('author-spotlight')) return;
    if (dom.authorField.contains(event.target)) return;
    event.preventDefault();
    focusAuthorInput();
  };
  dom.authorVeil.addEventListener('pointerdown', keepFocus);
  dom.authorField.closest('.topbar')?.addEventListener('pointerdown', keepFocus);

  document.addEventListener('focusin', (event) => {
    if (!document.body.classList.contains('author-spotlight')) return;
    if (dom.authorField.contains(event.target)) return;
    focusAuthorInput();
  });

  // Esc 会主动 blur。名字还空着时把焦点拉回来，暗层不撤。
  dom.authorInput.addEventListener('blur', () => {
    if (state.author) return;
    requestAnimationFrame(() => {
      if (!state.author) focusAuthorInput();
    });
  });
}

function requireName(message, preferUpload = false) {
  if (state.author) return true;
  toast(message || '先写上你的名字，同事才知道这条意见是谁提的', true);
  focusAuthor(preferUpload);
  return false;
}

function focusAuthor(preferUpload = false) {
  dom.authorField.classList.add('need');
  // 没署名时整页都压暗，只把顶栏署名框留出来（上传弹窗里的同名输入在暗层下面）
  if (!state.author) {
    syncAuthorSpotlight({ focus: true });
    return;
  }
  const target = preferUpload && !dom.uploadModal.hidden ? dom.uploadAuthor : dom.authorInput;
  if (target === dom.authorInput && state.video && edgeToEdgeQuery.matches && !composerExpanded) {
    expandComposer();
  }
  target.focus();
}

/* ── 路由 ─────────────────────────────────────────────────────────── */

function applyHash() {
  const videoMatch = /^#\/v\/([\w-]+)/.exec(location.hash);
  if (videoMatch) {
    openVideo(videoMatch[1]);
    syncTopbarNav();
    return;
  }
  leaveVideo();
  const projectMatch = /^#\/p\/([\w-]+)/.exec(location.hash);
  if (projectMatch) showProjectPage(projectMatch[1]);
  else showProjectHome();
  syncTopbarNav();
}

/** 返回主页紧跟署名：项目页和看片页共用；返回项目只在看片页、排在它后面。 */
function syncTopbarNav() {
  const onProject = /^#\/p\/[\w-]+/.test(location.hash);
  const onVideo = /^#\/v\/[\w-]+/.test(location.hash);
  const onHome = !onProject && !onVideo;
  dom.libraryOpen.hidden = onHome;
  dom.libraryOpen.textContent = '返回主页';
  dom.homeOpen.hidden = !onVideo;
  dom.homeOpen.textContent = '返回项目';
  dom.projectNew.hidden = !onHome;
  dom.uploadOpen.hidden = onVideo;
}

function leaveVideo() {
  if (!state.video && dom.frame.hidden) return;
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
  composerExpanded = false;
  syncComposerCollapse();
  syncAuthorSpotlight();
  reportView?.close();
  dom.videoTitle.textContent = '还没有打开片子';
  dom.videoMeta.textContent = '上传后在项目里选一支开始审。';
  dom.list.replaceChildren(emptyHint('还没有评论。打开一支片，暂停在任意一帧就能发弹幕。'));
  danmaku.clear();
  annView.clear();
  updateCounts();
  state.es?.close();
  state.es = null;
}

function showProjectHome() {
  state.libraryPage = 'home';
  state.libraryProjectId = null;
  dom.empty.hidden = false;
  dom.empty.classList.add('library-view');
  renderLibraryView();
}

async function showProjectPage(id) {
  const hash = location.hash;
  const projectId = id === 'uncategorized' ? null : id;
  if (projectId) {
    let project = projectById(projectId);
    // 分享链接直接进来时列表可能还没拉过
    if (!project) {
      await refreshVideos();
      project = projectById(projectId);
    }
    if (!project) {
      toast('这个项目不存在', true);
      location.hash = '#/';
      return;
    }
    if (project.locked) {
      const ok = await askProjectPassword(project);
      if (location.hash !== hash) return;
      if (!ok) {
        location.hash = '#/';
        return;
      }
      await refreshVideos();
      if (location.hash !== hash) return;
    }
  }
  state.libraryPage = 'project';
  state.libraryProjectId = projectId;
  dom.empty.hidden = false;
  dom.empty.classList.add('library-view');
  renderLibraryView();
}

async function openVideo(id) {
  if (state.video?.id === id) return;
  // 片子还在加载时先压暗，直接打开链接不会先闪一屏
  if (!state.author) syncAuthorSpotlight({ focus: true });
  let data;
  try {
    data = await api.getVideo(id);
  } catch (err) {
    // 分享链接打开锁着的片子：先弹密码框，解开再重来一次
    if (err.locked && err.projectId) {
      const hash = location.hash;
      const project = projectById(err.projectId)
        || { id: err.projectId, name: err.projectName || '', hint: err.hint || '' };
      const ok = await askProjectPassword(project);
      // 等密码期间已经跳到别处了，就别再往回拽
      if (location.hash !== hash) return;
      if (ok) {
        await refreshVideos();
        if (location.hash !== hash) return;
        return openVideo(id);
      }
    }
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
  composerExpanded = false;
  syncComposerCollapse();
  syncAuthorSpotlight({ focus: true });
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

  if (edgeToEdgeQuery.matches && !document.fullscreenElement) {
    const fullW = dom.frame.clientWidth;
    if (fullW < 48) return null;
    const ratio = width / height;
    // 竖版片子按宽度撑满会太高，封顶到屏幕高度的 80%，超出才两边留一点
    const maxH = Math.round((window.innerHeight || fullW / ratio) * 0.8);
    let w = fullW;
    let h = w / ratio;
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }
    return { w: Math.round(w), h: Math.round(h) };
  }

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

/** 竖屏看片时，署名、弹幕输入、整体意见和画笔入口收成一颗「发弹幕」 */
function syncComposerCollapse() {
  // 没署名时署名框必须露在外面，不能收成「发弹幕」
  if (!state.author && state.video && edgeToEdgeQuery.matches && !composerExpanded && !state.draw) {
    composerExpanded = true;
  }
  // 正在画的时候不能收起，否则工具条被藏掉、画面却还停在画笔模式
  const collapse = edgeToEdgeQuery.matches && !!state.video && !composerExpanded && !state.draw;
  document.body.classList.toggle('composer-collapsed', collapse);
  if (dom.composerReveal) {
    dom.composerReveal.setAttribute('aria-expanded', collapse ? 'false' : 'true');
  }
}

function expandComposer({ focusInput = false } = {}) {
  if (!state.video) return;
  const changed = !composerExpanded;
  composerExpanded = true;
  syncComposerCollapse();
  if (changed) fitVideoWrap();
  if (focusInput) requestAnimationFrame(() => dom.composerInput.focus());
}

function blurComposerFields() {
  const active = document.activeElement;
  if (active === dom.composerInput || active === dom.overallInput || active === dom.authorInput) active.blur();
}

function collapseComposer() {
  if (!edgeToEdgeQuery.matches) return;
  if (!state.author) {
    dom.authorInput.focus();
    return;
  }
  if (state.draw && pad.strokes.length) {
    toast('先保存或取消画笔，再收起');
    return;
  }
  if (state.draw) exitDrawMode();
  blurComposerFields();
  composerExpanded = false;
  syncComposerCollapse();
  fitVideoWrap();
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
  // 自动识别出来的帧率不再挂「自动」字样，只显示数值；手动 / 默认照旧提示
  const labels = { auto: '', manual: '手动', default: '默认' };
  const label = labels[state.fpsSource] ?? '默认';
  dom.fpsBadge.textContent = label;
  dom.fpsBadge.hidden = !label;
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
  document.addEventListener('fullscreenchange', () => {
    syncComposerCollapse();
    setTimeout(fitVideoWrap, 60);
  });
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
    maybeSavePlayingCover();

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

/**
 * 窄屏没有筛选标签，没法切回「全部」。
 * 桌面选过「弹幕 / 画笔」，或这个选择被留在 state 里时，进到手机宽度就改回全部。
 */
function syncMobileListFilter() {
  if (!mobileListQuery.matches || state.tab === 'all') return;
  state.tab = 'all';
  if (dom.tabs) {
    for (const node of dom.tabs.querySelectorAll('.tab')) {
      node.classList.toggle('active', node.dataset.tab === 'all');
    }
  }
  renderSidebar();
}

function renderSidebar() {
  updateCounts();
  setAuthorRoster(state.comments, state.annotations);

  if (!state.video) return;

  // 手机宽度一律按「全部」画，避免标签被藏掉后列表仍停在上一次的筛选
  const tab = mobileListQuery.matches ? 'all' : state.tab;
  const items = [];
  if (tab !== 'annotation') {
    for (const comment of state.comments) items.push({ type: 'comment', time: comment.time, data: comment });
  }
  if (tab !== 'comment') {
    for (const annotation of state.annotations) items.push({ type: 'annotation', time: annotation.start, data: annotation });
  }
  items.sort((a, b) => a.time - b.time);

  if (!items.length) {
    const hint = tab === 'annotation'
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
    text.textContent = String(comment.text ?? '').replace(/\r\n?/g, '\n').trim();
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

  const input = document.createElement('textarea');
  input.className = 'reply-input edit-box';
  input.rows = 1;
  input.maxLength = 500;
  input.autocomplete = 'off';
  input.placeholder = '修改弹幕内容，Enter 换行';
  input.value = state.editDraft;
  const fitEditBox = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, Math.max(input.scrollHeight, 34))}px`;
  };
  input.addEventListener('input', () => {
    state.editDraft = input.value;
    fitEditBox();
  });
  input.addEventListener('focus', () => {
    state.editFocus = true;
  });
  input.addEventListener('blur', () => {
    state.editFocus = false;
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeEdit();
      return;
    }
    if (event.key !== 'Enter') return;
    // Enter 与 Shift+Enter 都换行，不保存；保存仍是按钮或 Ctrl/⌘+Enter
    if (event.shiftKey || (!event.ctrlKey && !event.metaKey)) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    form.requestSubmit();
  });

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn primary reply-send';
  save.textContent = '保存';
  save.title = 'Ctrl 或 ⌘ + Enter';

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

  requestAnimationFrame(() => {
    if (!input.isConnected) return;
    fitEditBox();
    if (!state.editFocus) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
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
  if (!await askConfirm('删除这条回复？', { danger: true })) return;
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
  if (!await askConfirm('删除这条弹幕？', { danger: true })) return;
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
  if (!await askConfirm('删除这个画笔标注？', { danger: true })) return;
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
      collapseComposer();
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
      collapseComposer();
    } catch (err) {
      dom.composerInput.value = text;
      lockComposeTime(time);
      toast(err.message, true);
    }
  });

  dom.composerReveal.addEventListener('click', () => expandComposer({ focusInput: true }));
  dom.composerCollapse.addEventListener('click', () => collapseComposer());
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
  if (!composerExpanded) expandComposer();

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
  fitVideoWrap();
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
  syncComposerCollapse();
  fitVideoWrap();
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
  on('video:updated', (data) => applyVideoUpdate(data.video));
  on('video:removed', (data) => {
    refreshVideos();
    if (state.video?.id === data.videoId) {
      toast('这支片被上传者删掉了');
      location.hash = '#/';
    }
  });
  // 项目变化：改名 / 删除 / 有人定稿或取消定稿，几秒内同步到所有人
  on('projects:changed', () => refreshVideos());

  es.addEventListener('error', () => {
    // EventSource 自带重连，这里只做提示
    if (es.readyState === EventSource.CLOSED) setTimeout(() => connectEvents(state.video?.id), 3000);
  });
}

/* ── 片库 / 上传 ──────────────────────────────────────────────────── */

/** 别处改了名：更新片库列表；如果正打开这支片，同步标题栏和审片报告 */
function applyVideoUpdate(video) {
  if (!video?.id) return;
  const index = state.videos.findIndex((v) => v.id === video.id);
  if (index >= 0) {
    state.videos[index] = {
      ...state.videos[index],
      title: video.title ?? state.videos[index].title,
      projectId: Object.prototype.hasOwnProperty.call(video, 'projectId')
        ? (video.projectId || null)
        : state.videos[index].projectId,
    };
  }
  if (!dom.libraryModal.hidden) renderLibrary();
  if (!state.video) renderLibraryView();
  if (state.video?.id === video.id) {
    if (video.title) state.video.title = video.title;
    if (Object.prototype.hasOwnProperty.call(video, 'projectId')) state.video.projectId = video.projectId || null;
    renderHeader();
    reportView.refresh();
  }
}

async function refreshVideos() {
  try {
    const [videos, projects] = await Promise.all([api.listVideos(), api.listProjects()]);
    state.videos = videos.videos || [];
    state.projects = projects.projects || [];
    state.uncategorized = projects.uncategorized || null;
  } catch {
    state.videos = [];
    state.projects = [];
    state.uncategorized = null;
  }
  if (!dom.libraryModal.hidden) renderLibrary();
  if (!state.video) renderLibraryView();
  fillUploadProjectSelect();
}

function initModals() {
  dom.libraryOpen.addEventListener('click', () => {
    location.hash = '#/';
  });
  dom.homeOpen.addEventListener('click', () => {
    if (state.video) {
      location.hash = state.video.projectId ? `#/p/${state.video.projectId}` : '#/p/uncategorized';
      return;
    }
    location.hash = '#/';
  });
  dom.projectNew.addEventListener('click', createProjectPrompt);
  dom.projectRename.addEventListener('click', renameCurrentProject);
  dom.projectPassword.addEventListener('click', changeProjectPassword);
  dom.projectLock.addEventListener('click', lockCurrentProject);
  dom.projectDelete.addEventListener('click', deleteCurrentProject);
  dom.uploadOpen.addEventListener('click', openUpload);
  dom.introClose.addEventListener('click', dismissIntro);
  dom.uploadNewProject.addEventListener('input', () => {
    updateUploadButton();
    syncUploadTitleCopy();
    syncUploadNewLock();
    if (!dom.uploadNewProject.value.trim()) maybeBeginUpload();
  });
  dom.uploadProjectSelect.addEventListener('change', () => {
    if (dom.uploadProjectSelect.value) dom.uploadNewProject.value = '';
    updateUploadButton();
    syncUploadTitleCopy();
    syncUploadNewLock();
    maybeBeginUpload();
  });
  dom.uploadNewRandom.addEventListener('click', () => fillRandomPassword(dom.uploadNewPassword));

  // 解锁框和项目表单自己管 Promise，别让通用关闭逻辑把框藏了却不 resolve
  const managed = (modal) => modal === dom.lockModal || modal === dom.projectFormModal;
  for (const button of document.querySelectorAll('[data-close-modal]')) {
    if (managed(button.closest('.modal'))) continue;
    button.addEventListener('click', () => {
      const modal = button.closest('.modal');
      if (modal === dom.uploadModal) dismissUpload();
      else modal.hidden = true;
    });
  }
  for (const modal of document.querySelectorAll('.modal')) {
    if (managed(modal)) continue;
    modal.addEventListener('click', (event) => {
      if (event.target !== modal) return;
      if (modal === dom.uploadModal) dismissUpload();
      else modal.hidden = true;
    });
  }

  dom.dropzone.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', () => {
    stageFile(dom.fileInput.files?.[0]);
    dom.fileInput.value = '';
  });
  dom.uploadStart.addEventListener('click', confirmUpload);
  dom.reportOpen.addEventListener('click', () => reportView.open());

  for (const tab of dom.tabs.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      // 窄屏标签已隐藏；就算点到了也保持「全部」
      if (mobileListQuery.matches) {
        syncMobileListFilter();
        return;
      }
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
  if (!dom.uploadModal.hidden) return;
  discardUploadJob({ deleteVideo: true });
  state.pendingFile = null;
  dom.titleInput.value = '';
  dom.uploadPending.hidden = true;
  dom.uploadProgress.hidden = true;
  dom.barFill.style.width = '0%';
  dom.uploadStatus.textContent = '';
  dom.uploadAuthor.value = state.author;
  dom.uploadNewProject.value = '';
  if (dom.uploadStart) dom.uploadStart.disabled = false;
  fillUploadProjectSelect();
  syncUploadProjectFields();
  syncUploadTitleCopy();
  syncUploadLock();
  openModal(dom.uploadModal);
  if (!state.author) setTimeout(() => dom.uploadAuthor.focus(), 60);
}

/** 首页上传必须选已有项目、未分类，或填一个新项目名。项目页已定好去向，不再拦。 */
function uploadTargetChosen() {
  if (uploadContext().mode !== 'ask') return true;
  return Boolean(dom.uploadProjectSelect.value || dom.uploadNewProject.value.trim());
}

function updateUploadButton() {
  syncUploadLock();
  if (!dom.uploadStart || uploadConfirming) return;
  dom.uploadStart.disabled = false;
}

function syncUploadLock() {
  const lock = Boolean(uploadJob && (uploadJob.status === 'uploading' || uploadJob.status === 'done'));
  if (dom.uploadProjectSelect) dom.uploadProjectSelect.disabled = lock;
  if (dom.uploadNewProject) dom.uploadNewProject.disabled = lock;
  if (dom.uploadNewPassword) dom.uploadNewPassword.disabled = lock;
  if (dom.uploadNewRandom) dom.uploadNewRandom.disabled = lock;
  if (dom.uploadAuthor) dom.uploadAuthor.disabled = lock;
}

function resetUploadUi() {
  state.pendingFile = null;
  if (dom.titleInput) dom.titleInput.value = '';
  if (dom.uploadPending) dom.uploadPending.hidden = true;
  if (dom.uploadProgress) dom.uploadProgress.hidden = true;
  if (dom.barFill) dom.barFill.style.width = '0%';
  if (dom.uploadStatus) dom.uploadStatus.textContent = '';
  syncUploadLock();
}

/** 换文件或重开弹窗时丢掉上一次还没确认的上传。已入库的删掉，避免留下半套片子。 */
function discardUploadJob({ deleteVideo = false } = {}) {
  const job = uploadJob;
  uploadJob = null;
  uploadEpoch += 1;
  uploadConfirming = false;
  if (dom.uploadStart) dom.uploadStart.disabled = false;
  syncUploadLock();
  if (!job) return;
  if (job.status === 'uploading') {
    job.aborted = true;
    job.controller.abort();
    return;
  }
  if (deleteVideo && job.status === 'done' && job.video) {
    api.deleteVideo(job.video.id).catch(() => {});
  }
}

/**
 * 关掉弹窗：
 * 还在传就中止，服务端不会入库；
 * 已经传完则把片子留在项目里（标题框有字就改成这个片名），不跳转。
 */
function dismissUpload() {
  if (!dom.uploadModal || dom.uploadModal.hidden) return;
  const job = uploadJob;
  const title = dom.titleInput.value.trim().slice(0, 80);
  dom.uploadModal.hidden = true;
  uploadJob = null;
  uploadEpoch += 1;
  uploadConfirming = false;
  state.pendingFile = null;
  if (dom.uploadStart) dom.uploadStart.disabled = false;
  resetUploadUi();
  if (!job) return;
  if (job.status === 'uploading') {
    job.aborted = true;
    job.controller.abort();
    toast('已取消上传');
    return;
  }
  if (job.status === 'done' && job.video) void keepUploadedVideo(job.video, title);
}

async function keepUploadedVideo(video, title) {
  try {
    if (title && title !== video.title) await api.patchVideo(video.id, { title });
    await refreshVideos();
    toast('视频已留在项目里');
  } catch (err) {
    toast(err.message, true);
    refreshVideos().catch(() => {});
  }
}

function stageFile(file) {
  if (!file) return;

  const looksVideo = /^video\//.test(file.type) || /\.(mp4|m4v|webm|mov|ogv|mkv)$/i.test(file.name);
  if (!looksVideo) {
    toast('这看起来不是视频文件', true);
    return;
  }

  discardUploadJob({ deleteVideo: true });
  state.pendingFile = file;
  dom.pendingName.textContent = file.name;
  dom.pendingSize.textContent = fileSize(file.size);
  dom.uploadPending.hidden = false;
  dom.uploadProgress.hidden = true;
  dom.barFill.style.width = '0%';
  dom.uploadStatus.textContent = '';
  maybeBeginUpload();
}

/** 名字和去向都齐了才在后台开传。新项目名还在输入时不自动开传，免得每敲一个字建一次。 */
function canBackgroundUpload() {
  if (uploadContext().mode === 'fixed') return true;
  if (dom.uploadNewProject.value.trim()) return false;
  return Boolean(dom.uploadProjectSelect.value);
}

function maybeBeginUpload() {
  if (uploadJob || !state.pendingFile || !state.author) return false;
  if (!canBackgroundUpload()) return false;
  beginUpload();
  return true;
}

function uploadAbortError() {
  return Object.assign(new Error('上传已取消'), { name: 'AbortError' });
}

/** 先把文件传上去，标题留空，服务端用文件名兜底。最终片名等用户点按钮。 */
function beginUpload() {
  const file = state.pendingFile;
  if (!file || !state.author) return null;
  const uploader = state.author;
  const target = uploadPayload();
  const controller = new AbortController();
  const job = {
    status: 'uploading',
    file,
    video: null,
    error: null,
    aborted: false,
    controller,
    promise: null,
  };
  uploadJob = job;
  dom.uploadPending.hidden = false;
  dom.uploadProgress.hidden = false;
  dom.barFill.style.width = '0%';
  dom.uploadStatus.textContent = '读取视频信息…';
  syncUploadLock();

  job.promise = (async () => {
    const duration = await probeDuration(file);
    if (job.aborted) throw uploadAbortError();
    if (!duration && uploadJob === job) dom.uploadStatus.textContent = '浏览器读不出时长，仍然可以上传';
    const data = await uploadVideo(
      file,
      {
        title: '',
        uploader,
        duration,
        fps: state.fps,
        projectId: target.projectId,
        newProjectName: target.newProjectName,
      },
      (progress) => {
        if (uploadJob !== job) return;
        const percent = Math.round(progress * 100);
        dom.barFill.style.width = `${percent}%`;
        dom.uploadStatus.textContent = `上传中 ${percent}% · ${fileSize(file.size)}`;
      },
      controller.signal,
    );
    job.status = 'done';
    job.video = data.video;
    if (uploadJob === job && !uploadConfirming) {
      dom.barFill.style.width = '100%';
      dom.uploadStatus.textContent = '传完了，确认片名后点「上传并审片」';
    }
    return data;
  })();

  job.promise.catch((err) => {
    if (job.aborted || err?.name === 'AbortError') {
      job.status = 'aborted';
      return;
    }
    job.status = 'error';
    job.error = err;
    if (uploadJob === job) {
      dom.uploadStatus.textContent = err.message || '上传失败';
      if (!uploadConfirming) toast(err.message || '上传失败', true);
      syncUploadLock();
    }
  });

  return job;
}

async function applyDesiredTitle(video, title = dom.titleInput.value.trim().slice(0, 80)) {
  if (!title || title === video.title) return video;
  const data = await api.patchVideo(video.id, { title });
  return data.video;
}

async function confirmUpload() {
  if (uploadConfirming) return;
  if (!requireName('上传前必须写上你的名字', true)) return;
  if (!uploadTargetChosen()) {
    toast('选个项目再上传');
    return;
  }
  if (!state.pendingFile && !(uploadJob && uploadJob.file)) {
    toast('先选择一个视频');
    return;
  }
  // 新建项目时顺手设的密码，先验一遍再开传，别等传完 4GB 才发现不合格
  const newProjectName = uploadContext().mode === 'ask' ? dom.uploadNewProject.value.trim() : '';
  const newLockPassword = newProjectName ? dom.uploadNewPassword.value : '';
  if (newLockPassword && (newLockPassword.length < 4 || newLockPassword.length > 64)) {
    toast('密码要 4–64 位', true);
    return;
  }

  uploadConfirming = true;
  dom.uploadStart.disabled = true;
  const epoch = uploadEpoch;
  try {
    let job = uploadJob;
    if (!job || job.status === 'error' || job.status === 'aborted') job = beginUpload();
    if (!job) throw new Error('先选择一个视频');
    await job.promise;
    if (epoch !== uploadEpoch || uploadJob !== job) return;
    if (job.status !== 'done' || !job.video) throw job.error || new Error('上传失败');
    const video = await applyDesiredTitle(job.video);
    if (epoch !== uploadEpoch || uploadJob !== job) return;
    // 新项目 + 填了密码：传完顺手加上锁（服务端会同时发一张通行证给当前浏览器）
    if (newLockPassword && video.projectId) {
      await api.setProjectPassword(video.projectId, {
        password: newLockPassword,
        hint: '',
        setBy: state.author,
      });
    }
    uploadJob = null;
    state.pendingFile = null;
    dom.uploadModal.hidden = true;
    resetUploadUi();
    await refreshVideos();
    if (epoch !== uploadEpoch) return;
    location.hash = `#/v/${video.id}`;
    applyHash();
    toast('上传好了，把地址发给同事就能一起看');
  } catch (err) {
    if (epoch !== uploadEpoch) return;
    if (err?.name === 'AbortError') return;
    dom.uploadProgress.hidden = false;
    dom.uploadStatus.textContent = err.message || '上传失败';
    toast(err.message || '上传失败', true);
  } finally {
    if (epoch === uploadEpoch) {
      uploadConfirming = false;
      dom.uploadStart.disabled = false;
      syncUploadLock();
    }
  }
}

let introClosed = false;

function libraryHasVideos() {
  return state.videos.length > 0;
}

/** 还没有任何视频时介绍一直在，不看关闭记录。有视频之后才记住关掉。 */
function introDismissed() {
  if (!libraryHasVideos()) return false;
  if (introClosed) return true;
  try {
    return localStorage.getItem(STORE.intro) != null;
  } catch {
    return false;
  }
}

function dismissIntro() {
  if (!libraryHasVideos()) return;
  introClosed = true;
  try {
    localStorage.setItem(STORE.intro, '1');
  } catch {
    /* 写不进去也先在这次会话里关掉 */
  }
  if (dom.introCard) dom.introCard.hidden = true;
}

/** 首页要先选项目；已经在某个项目里（或正在看这个项目的片子）就直接传进去 */
function uploadContext() {
  if (state.video) return { mode: 'fixed', projectId: state.video.projectId || null };
  if (state.libraryPage === 'project') return { mode: 'fixed', projectId: state.libraryProjectId };
  return { mode: 'ask', projectId: null };
}

function uploadPayload() {
  const ctx = uploadContext();
  if (ctx.mode === 'fixed') return { projectId: ctx.projectId || '', newProjectName: '' };
  const fresh = dom.uploadNewProject.value.trim();
  if (fresh) return { projectId: '', newProjectName: fresh };
  const selected = dom.uploadProjectSelect.value;
  if (!selected || selected === 'uncategorized') return { projectId: '', newProjectName: '' };
  return { projectId: selected, newProjectName: '' };
}

function syncUploadProjectFields() {
  const ask = uploadContext().mode === 'ask';
  dom.uploadProject.hidden = !ask;
  syncUploadNewLock();
}

/** 只有「在首页输入一个新项目名」时才需要问密码；进项目之后上传沿用项目原来的锁 */
function syncUploadNewLock() {
  const ask = uploadContext().mode === 'ask';
  const fresh = Boolean(dom.uploadNewProject.value.trim());
  const show = ask && fresh;
  dom.uploadNewLock.hidden = !show;
  if (!show) {
    dom.uploadNewPassword.value = '';
    dom.uploadNewPassword.type = 'password';
  }
}

/** 放进某个项目时，标题框引导填写这一版改了什么；未分类仍用中性的「片名」。空着点「上传并审片」时沿用文件名。 */
function syncUploadTitleCopy() {
  const target = uploadPayload();
  const intoProject = Boolean(target.projectId || target.newProjectName);
  dom.titleLabel.textContent = intoProject ? '这版改了什么' : '片名';
  dom.titleInput.placeholder = intoProject ? '例如：换了片尾音乐、调色更暖' : '片名';
}

function fillUploadProjectSelect() {
  const select = dom.uploadProjectSelect;
  if (!select) return;
  const current = select.value;
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '选择已有项目';
  select.append(placeholder);
  const loose = document.createElement('option');
  loose.value = 'uncategorized';
  loose.textContent = '未分类';
  select.append(loose);
  for (const project of state.projects) {
    // 锁着的项目不列：要传进去，先进项目再从项目页传
    if (project.locked) continue;
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.name;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function videosIn(projectId) {
  return state.videos.filter((video) => (video.projectId || null) === (projectId || null));
}

function versionOf(videos) {
  const ordered = [...videos].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const map = new Map();
  ordered.forEach((video, index) => map.set(video.id, index + 1));
  return map;
}

// 封面是一张小 JPEG，存在 DATA_DIR/covers。有图就直接给 <img>（浏览器长期缓存）；
// 旧片子没有图时，进了可视区域再截一帧上传，同一支片子只截一次，截完立刻停掉视频下载。
const COVER_MAX_EDGE = 640;
const knownCovers = new Map();
const coverJobs = new Map();
const coverGrabber = createFrameGrabber();
let coverObserver = null;
let coverSeedFor = '';
let coverSeedFailed = '';

function coverUrl(id) {
  return `/api/videos/${id}/cover`;
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('生成封面失败'));
      else resolve(blob);
    }, 'image/jpeg', quality);
  });
}

async function coverBlob(canvas) {
  let blob = await canvasToJpeg(canvas, 0.72);
  if (blob.size > 480 * 1024) blob = await canvasToJpeg(canvas, 0.5);
  return blob;
}

function rememberCover(videoId, url) {
  knownCovers.set(videoId, url);
  const video = state.videos.find((item) => item.id === videoId);
  if (video) video.hasCover = true;
  if (state.video?.id === videoId) state.video.hasCover = true;
  for (const project of state.projects) {
    if (project.coverVideoId === videoId) project.hasCover = true;
  }
  if (state.uncategorized?.coverVideoId === videoId) state.uncategorized.hasCover = true;
}

function resolveCover(videoId) {
  const known = knownCovers.get(videoId);
  if (known) return Promise.resolve(known);
  const pending = coverJobs.get(videoId);
  if (pending) return pending;
  const job = createCover(videoId).then((url) => {
    knownCovers.set(videoId, url);
    return url;
  }).catch((err) => {
    coverJobs.delete(videoId);
    throw err;
  });
  coverJobs.set(videoId, job);
  return job;
}

async function createCover(videoId) {
  const res = await fetch(coverUrl(videoId));
  if (res.ok) {
    await res.blob();
    rememberCover(videoId, coverUrl(videoId));
    return coverUrl(videoId);
  }
  res.body?.cancel?.();
  if (res.status !== 404) throw new Error('封面读取失败');

  const frame = await coverGrabber.grab(`/api/videos/${videoId}/file`, 0.4, { maxWidth: COVER_MAX_EDGE, release: true });
  const blob = await coverBlob(frame);
  const put = await fetch(coverUrl(videoId), {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  if (!put.ok) throw new Error('封面保存失败');
  const url = URL.createObjectURL(blob);
  rememberCover(videoId, url);
  return url;
}

function ensureCoverObserver() {
  if (coverObserver || typeof IntersectionObserver !== 'function') return coverObserver;
  coverObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      coverObserver.unobserve(entry.target);
      const id = entry.target.dataset.cover;
      if (!id || !entry.target.isConnected) continue;
      loadMissingCover(entry.target, id);
    }
  }, { rootMargin: '240px' });
  return coverObserver;
}

function releaseCovers(root) {
  if (!coverObserver || !root) return;
  root.querySelectorAll('img[data-cover]').forEach((node) => coverObserver.unobserve(node));
}

function assignCover(img, videoId, url) {
  img.loading = 'lazy';
  img.addEventListener('error', () => {
    if (img.dataset.cover !== videoId || img.dataset.coverRetry === '1') return;
    img.dataset.coverRetry = '1';
    knownCovers.delete(videoId);
    coverJobs.delete(videoId);
    img.removeAttribute('src');
    watchMissingCover(img, videoId);
  }, { once: true });
  img.src = url;
}

function loadMissingCover(img, videoId) {
  if (!img.isConnected || img.dataset.cover !== videoId || img.dataset.coverBusy === '1') return;
  img.dataset.coverBusy = '1';
  resolveCover(videoId).then((url) => {
    if (!img.isConnected || img.dataset.cover !== videoId) return;
    assignCover(img, videoId, url);
  }).catch(() => {}).finally(() => {
    if (img.dataset.cover === videoId) delete img.dataset.coverBusy;
  });
}

function watchMissingCover(img, videoId) {
  const arm = () => {
    if (!img.isConnected || img.dataset.cover !== videoId) return;
    const observer = ensureCoverObserver();
    if (!observer) {
      loadMissingCover(img, videoId);
      return;
    }
    observer.observe(img);
  };
  // 卡片先组好再挂进文档。等这次渲染结束再观察，避免对还没进页面的节点漏掉回调
  if (img.isConnected) arm();
  else queueMicrotask(() => (img.isConnected ? arm() : requestAnimationFrame(arm)));
}

function mountCover(img, videoId, ready) {
  if (!videoId) return;
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  img.dataset.cover = videoId;
  const known = knownCovers.get(videoId);
  if (ready || known) {
    assignCover(img, videoId, known || coverUrl(videoId));
    return;
  }
  watchMissingCover(img, videoId);
}

/** 正在看的片子已经解码出画面时，顺手把封面存上，回片库就不用再下一遍原片 */
function maybeSavePlayingCover() {
  const meta = state.video;
  const el = dom.video;
  if (!meta || meta.hasCover || coverSeedFor === meta.id || coverSeedFailed === meta.id) return;
  if (knownCovers.has(meta.id) || coverJobs.has(meta.id)) return;
  const t = el.currentTime || 0;
  const total = el.duration;
  const nearEnd = Number.isFinite(total) && total > 0 && t >= Math.max(0, total - 0.05);
  if (t < 0.4 && !nearEnd) return;
  if (el.readyState < 2 || !el.videoWidth || !el.videoHeight) return;
  coverSeedFor = meta.id;
  const scale = Math.min(1, COVER_MAX_EDGE / el.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(el.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(el.videoHeight * scale));
  canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
  const job = coverBlob(canvas).then(async (blob) => {
    const put = await fetch(coverUrl(meta.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    });
    if (!put.ok) throw new Error('封面保存失败');
    const url = URL.createObjectURL(blob);
    rememberCover(meta.id, url);
    return url;
  }).catch((err) => {
    coverJobs.delete(meta.id);
    coverSeedFailed = meta.id;
    if (coverSeedFor === meta.id) coverSeedFor = '';
    throw err;
  });
  coverJobs.set(meta.id, job);
}

function renderLibraryView() {
  if (!dom.libraryPage) return;
  const home = state.libraryPage !== 'project';
  const showProject = !home;
  dom.libraryPage.hidden = false;
  dom.empty.classList.add('library-view');
  dom.projectGrid.hidden = !home;
  dom.versionList.hidden = !showProject;
  const project = state.libraryProjectId ? projectById(state.libraryProjectId) : null;
  dom.projectRename.hidden = home || !project;
  dom.projectDelete.hidden = home || !project;
  dom.projectPassword.hidden = home || !project;
  dom.projectPassword.textContent = project?.hasPassword ? '修改密码' : '设置密码';
  dom.projectLock.hidden = home || !project?.hasPassword || Boolean(project?.locked);
  if (dom.introCard) dom.introCard.hidden = !home || introDismissed();
  if (dom.introClose) dom.introClose.hidden = !libraryHasVideos();
  renderCrumb();
  if (home) renderProjectCards();
  if (showProject) renderVersionList();
}

function renderCrumb() {
  dom.libraryCrumb.replaceChildren();
  if (state.libraryPage !== 'project') {
    const title = document.createElement('span');
    title.textContent = '项目';
    dom.libraryCrumb.append(title);
    return;
  }
  const back = document.createElement('button');
  back.type = 'button';
  back.textContent = '项目';
  back.addEventListener('click', () => { location.hash = '#/'; });
  const sep = document.createElement('span');
  sep.className = 'crumb-sep';
  sep.textContent = '›';
  const name = document.createElement('span');
  name.className = 'crumb-name';
  const project = projectById(state.libraryProjectId);
  name.textContent = project ? project.name : '未分类';
  dom.libraryCrumb.append(back, sep, name);
  if (project?.hasPassword) {
    const chip = document.createElement('span');
    chip.className = 'lock-chip';
    chip.append(lockGlyph(12), '已加锁');
    dom.libraryCrumb.append(chip);
  }
}

function renderProjectCards() {
  releaseCovers(dom.projectGrid);
  const cards = [];
  const projects = [...state.projects].sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0));
  for (const project of projects) cards.push(projectCard(project));
  if (state.uncategorized?.videoCount) {
    cards.push(projectCard({
      id: 'uncategorized',
      name: '未分类',
      videoCount: state.uncategorized.videoCount,
      latestAt: state.uncategorized.latestAt,
      coverVideoId: state.uncategorized.coverVideoId,
      hasCover: state.uncategorized.hasCover,
    }));
  }
  cards.push(addProjectCard());
  dom.projectGrid.replaceChildren(...cards);
}

function addProjectCard() {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'project-card project-add';
  card.setAttribute('aria-label', '新建项目');
  card.append(projectAddMark());
  card.addEventListener('click', createProjectPrompt);
  return card;
}

function projectAddMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'project-add-mark');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const bar = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  bar.setAttribute('d', 'M32 14V50M14 32H50');
  bar.setAttribute('fill', 'none');
  bar.setAttribute('stroke', 'currentColor');
  bar.setAttribute('stroke-width', '5');
  bar.setAttribute('stroke-linecap', 'round');
  svg.append(bar);
  return svg;
}

/** 一把小锁：项目卡片、面包屑上都用它 */
function lockGlyph(size = 12) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS(ns, 'rect');
  body.setAttribute('x', '4');
  body.setAttribute('y', '10');
  body.setAttribute('width', '16');
  body.setAttribute('height', '10');
  body.setAttribute('rx', '2.5');
  const shackle = document.createElementNS(ns, 'path');
  shackle.setAttribute('d', 'M8 10V7a4 4 0 018 0v3');
  svg.append(body, shackle);
  return svg;
}

function lockBadge() {
  const badge = document.createElement('span');
  badge.className = 'project-lock-badge';
  badge.append(lockGlyph(11), '已加锁');
  return badge;
}

function projectIconButton(label, paths, tone) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `project-icon project-icon-${tone}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  button.append(svg);
  button.addEventListener('click', (event) => event.stopPropagation());
  return button;
}

function projectCard(project) {
  const loose = project.id === 'uncategorized';
  const card = document.createElement(loose ? 'button' : 'div');
  if (loose) card.type = 'button';
  else {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
  }
  card.className = 'project-card';
  // 锁着的卡片不虚化、不变灰：要靠封面认项目，只是多一把锁
  if (project.locked) card.classList.add('is-locked');
  const frame = document.createElement('div');
  frame.className = 'project-cover-frame';
  const cover = document.createElement('img');
  cover.className = 'project-cover';
  // 锁着又还没封面的，别去截帧（视频文件要通行证），先空着
  if (!project.locked || project.hasCover) mountCover(cover, project.coverVideoId, project.hasCover);
  frame.append(cover);
  if (project.locked) frame.append(lockBadge());
  const body = document.createElement('div');
  body.className = 'project-body';
  const copy = document.createElement('div');
  copy.className = 'project-copy';
  const title = document.createElement('div');
  title.className = 'project-name';
  title.textContent = project.name;
  if (project.locked) {
    const glyph = lockGlyph(12);
    glyph.classList.add('project-name-lock');
    title.append(glyph);
  }
  const meta = document.createElement('div');
  meta.className = 'project-meta';
  const when = project.latestAt ? relativeTime(project.latestAt) : '还没有更新';
  meta.textContent = `${project.videoCount || 0} 支 · ${when}`;
  // 定过稿的项目一眼可见；封面（coverVideoId）服务端已经换成了最终版
  if (project.finalVideoId) {
    const tag = document.createElement('span');
    tag.className = 'final-tag';
    const ver = versionOf(videosIn(project.id)).get(project.finalVideoId);
    tag.textContent = `已定稿 ${ver ? `v${ver}` : ''}`.trim();
    tag.title = '这一版是成片';
    meta.prepend(tag, ' · ');
  }
  copy.append(title, meta);
  body.append(copy);
  if (!loose) {
    const actions = document.createElement('div');
    actions.className = 'project-actions';
    // 锁着的项目在门口不能改名：改名是进项目之后的事
    if (!project.locked) {
      const edit = projectIconButton('修改项目', [
        'M12 20h8',
        'M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
      ], 'edit');
      edit.addEventListener('click', () => editProjectBy(project));
      actions.append(edit);
    }
    const del = projectIconButton('删除项目', [
      'M3 6h18',
      'M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2',
      'M5 6l1 14a1 1 0 001 1h10a1 1 0 001-1l1-14',
      'M10 11v6M14 11v6',
    ], 'delete');
    del.addEventListener('click', () => deleteProjectBy(project));
    actions.append(del);
    body.append(actions);
  }
  card.append(frame, body);
  const open = () => {
    location.hash = loose ? '#/p/uncategorized' : `#/p/${project.id}`;
  };
  card.addEventListener('click', open);
  if (!loose) {
    card.addEventListener('keydown', (event) => {
      if (event.target !== card) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  }
  return card;
}

function renderVersionList() {
  releaseCovers(dom.versionList);
  const projectId = state.libraryProjectId;
  const list = videosIn(projectId);
  if (!list.length) {
    dom.versionList.replaceChildren(emptyHint(projectId ? '这个项目还没有片子。' : '未分类里还没有片子。'));
    return;
  }
  const versions = versionOf(list);
  const project = projectId ? state.projects.find((item) => item.id === projectId) : null;
  const finalId = project?.finalVideoId || null;
  const rows = [...list]
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    .map((video) => versionRow(video, versions.get(video.id), finalId));
  dom.versionList.replaceChildren(...rows);
  const input = dom.versionList.querySelector('.rename-input');
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function versionRow(video, version, finalId) {
  const isFinal = Boolean(finalId) && finalId === video.id;
  const row = document.createElement('div');
  row.className = 'version-row';
  if (isFinal) row.classList.add('is-final');
  row.addEventListener('click', () => { location.hash = `#/v/${video.id}`; });
  const cover = document.createElement('img');
  cover.className = 'version-cover';
  mountCover(cover, video.id, video.hasCover);

  const main = document.createElement('div');
  main.className = 'version-main';
  const title = document.createElement('div');
  title.className = 'version-title';
  // 未分类页不标 v1、v2；项目里按上传顺序显示版本
  if (state.libraryProjectId) {
    const badge = document.createElement('span');
    badge.className = 'ver-badge';
    badge.textContent = `v${version}`;
    title.append(badge);
  }
  // 定稿的那版挂金色徽章，点徽章取消定稿
  if (isFinal) {
    const finalBadge = document.createElement('button');
    finalBadge.type = 'button';
    finalBadge.className = 'final-badge';
    finalBadge.textContent = '★ 最终版';
    finalBadge.title = '点击取消定稿';
    finalBadge.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await api.setProjectFinal(state.libraryProjectId, null);
        await refreshVideos();
        toast('已取消定稿');
      } catch (err) {
        toast(err.message, true);
      }
    });
    title.append(finalBadge);
  }
  const name = document.createElement('span');
  name.textContent = video.title;
  title.append(name);
  const meta = document.createElement('div');
  meta.className = 'version-meta';
  meta.textContent = [
    video.duration ? clockTime(video.duration) : '时长未知',
    fileSize(video.size),
    video.uploader ? `上传 ${video.uploader}` : '',
    relativeTime(video.createdAt),
  ].filter(Boolean).join(' · ');
  if (state.renameId === video.id) main.append(buildRenameForm(video), meta);
  else main.append(title, meta);

  const move = document.createElement('div');
  move.className = 'version-move';
  const select = document.createElement('select');
  select.setAttribute('aria-label', '移动到...');
  const current = document.createElement('option');
  current.value = '';
  current.textContent = '移动到...';
  select.append(current);
  if (video.projectId) {
    const loose = document.createElement('option');
    loose.value = 'uncategorized';
    loose.textContent = '未分类';
    select.append(loose);
  }
  for (const project of state.projects) {
    if (project.id === video.projectId) continue;
    // 锁着的项目移不进去（没通行证），干脆不列
    if (project.locked) continue;
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.name;
    select.append(option);
  }
  select.addEventListener('change', async () => {
    const target = select.value;
    if (!target) return;
    try {
      await api.moveVideo(video.id, target === 'uncategorized' ? null : target);
      await refreshVideos();
      toast('已移走');
    } catch (err) {
      toast(err.message, true);
      select.value = '';
    }
  });

  // 定稿按钮只出现在真项目里；未分类没有归属，定稿没有意义
  if (state.libraryProjectId && !isFinal) {
    const markFinal = document.createElement('button');
    markFinal.className = 'btn tiny ghost';
    markFinal.type = 'button';
    markFinal.textContent = '设为最终版';
    markFinal.title = '把这一版定为成片，首页卡片会跟着更新';
    markFinal.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await api.setProjectFinal(state.libraryProjectId, video.id);
        await refreshVideos();
        toast('已设为最终版');
      } catch (err) {
        toast(err.message, true);
      }
    });
    move.append(markFinal);
  }

  const rename = document.createElement('button');
  rename.className = 'btn tiny ghost';
  rename.type = 'button';
  rename.textContent = '改名';
  rename.title = '只改显示名称，链接和文件不变';
  rename.addEventListener('click', (event) => {
    event.stopPropagation();
    state.renameId = video.id;
    state.renameDraft = video.title;
    renderLibraryView();
  });

  const del = document.createElement('button');
  del.className = 'btn tiny ghost';
  del.type = 'button';
  del.textContent = '删除';
  del.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!await askConfirm(`删除《${video.title}》及其全部弹幕和标注？文件会被移除。`, { danger: true })) return;
    try {
      if (state.renameId === video.id) {
        state.renameId = null;
        state.renameDraft = '';
      }
      await api.deleteVideo(video.id);
      await refreshVideos();
      if (state.video?.id === video.id) location.hash = '#/';
    } catch (err) {
      toast(err.message, true);
    }
  });

  move.addEventListener('click', (event) => event.stopPropagation());
  move.append(select);
  if (state.renameId !== video.id) move.append(rename);
  move.append(del);
  row.append(cover, main, move);
  if (state.renameId === video.id) row.classList.add('renaming');
  return row;
}

let askSession = null;

function initLockDialogs() {
  dom.lockOk.addEventListener('click', submitLock);
  dom.lockCancel.addEventListener('click', () => settleLock(false));
  dom.lockClose.addEventListener('click', () => settleLock(false));
  dom.lockModal.addEventListener('click', (event) => {
    if (event.target === dom.lockModal) settleLock(false);
  });
  dom.lockInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    submitLock();
  });

  dom.pfOk.addEventListener('click', () => submitProjectForm());
  dom.pfRemove.addEventListener('click', () => submitProjectForm({ remove: true }));
  dom.pfCancel.addEventListener('click', () => settleProjectForm(null));
  dom.pfClose.addEventListener('click', () => settleProjectForm(null));
  dom.pfRandom.addEventListener('click', () => fillRandomPassword(dom.pfPassword));
  dom.projectFormModal.addEventListener('click', (event) => {
    if (event.target === dom.projectFormModal) settleProjectForm(null);
  });
  for (const input of [dom.pfName, dom.pfCurrent, dom.pfPassword, dom.pfHint]) {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      submitProjectForm();
    });
  }

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!dom.lockModal.hidden) {
      event.preventDefault();
      event.stopPropagation();
      settleLock(false);
      return;
    }
    if (!dom.projectFormModal.hidden) {
      event.preventDefault();
      event.stopPropagation();
      settleProjectForm(null);
    }
  }, true);
}

function initAskDialog() {
  dom.askCancel.addEventListener('click', () => cancelAsk());
  dom.askClose.addEventListener('click', () => cancelAsk());
  dom.askOk.addEventListener('click', () => submitAsk());
  dom.askModal.addEventListener('click', (event) => {
    if (event.target === dom.askModal) cancelAsk();
  });
  window.addEventListener('keydown', (event) => {
    if (!askSession || dom.askModal.hidden) return;
    if (event.key !== 'Escape' && event.key !== 'Enter') return;
    if (event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') cancelAsk();
    else submitAsk();
  }, true);
}

/** 确认。取消返回 false；danger 时确认按钮用红色。 */
function askConfirm(message, { danger = false } = {}) {
  return openAsk({
    kind: 'confirm',
    cancelValue: false,
    prepare() {
      dom.askTitle.textContent = message;
      dom.askOk.textContent = danger ? '删除' : '确定';
      dom.askOk.classList.toggle('primary', !danger);
      dom.askOk.classList.toggle('danger', danger);
    },
    focus() {
      dom.askOk.focus();
    },
  });
}

function openAsk(session) {
  if (askSession) cancelAsk();
  return new Promise((resolve) => {
    askSession = { resolve, ...session };
    dom.askSecretField.hidden = true;
    dom.askError.hidden = true;
    session.prepare();
    dom.askModal.hidden = false;
    setTimeout(session.focus, 30);
  });
}

function submitAsk() {
  if (!askSession) return;
  // 密码不 trim、不收空格，原样提交
  if (askSession.kind === 'secret') {
    const value = dom.askSecret.value;
    if (!value) return;
    settleAsk(value);
    return;
  }
  settleAsk(true);
}

function cancelAsk() {
  if (!askSession) return;
  settleAsk(askSession.cancelValue);
}

function settleAsk(value) {
  const resolve = askSession.resolve;
  askSession = null;
  dom.askModal.hidden = true;
  resolve(value);
}

/** 要密码的确认框：取消返回 null，确定返回输入的密码 */
function askSecret(title, { danger = false, okLabel = '确定', error = '', label = '项目密码' } = {}) {
  return openAsk({
    kind: 'secret',
    cancelValue: null,
    prepare() {
      dom.askTitle.textContent = title;
      dom.askSecretField.hidden = false;
      dom.askSecretLabel.textContent = label;
      dom.askSecret.value = '';
      dom.askOk.textContent = okLabel;
      dom.askOk.classList.toggle('primary', !danger);
      dom.askOk.classList.toggle('danger', danger);
      dom.askError.hidden = !error;
      dom.askError.textContent = error;
    },
    focus() {
      dom.askSecret.focus();
    },
  });
}

/* ── 项目密码 ─────────────────────────────────────────────────────── */

// 随机密码用无歧义字符：没有 0/o/1/i/l，口头念、手抄都不容易错
const PASSWORD_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

function randomPassword(length = 4) {
  const out = [];
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) out.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
  } else {
    for (let i = 0; i < length; i += 1) {
      out.push(PASSWORD_ALPHABET[Math.floor(Math.random() * PASSWORD_ALPHABET.length)]);
    }
  }
  return out.join('');
}

/** 随机生成的密码当场要能看见，不然没法记；手动输入时仍然是掩码 */
function fillRandomPassword(input) {
  if (!input) return;
  input.value = randomPassword(4);
  input.type = 'text';
  input.focus();
  input.setSelectionRange(0, input.value.length);
}

function projectById(id) {
  return state.projects.find((project) => project.id === id) || null;
}

/* 解锁框：进锁着的项目、打开锁着的片子时弹 */

let lockSession = null;

function askProjectPassword(project) {
  if (lockSession) settleLock(false);
  return new Promise((resolve) => {
    lockSession = { resolve, projectId: project.id };
    dom.lockTitle.textContent = project.name ? `🔒 ${project.name}` : '🔒 这个项目需要密码';
    const hint = project.hint || '';
    dom.lockHint.hidden = !hint;
    dom.lockHint.textContent = hint ? `提示：${hint}` : '';
    dom.lockError.hidden = true;
    dom.lockInput.value = '';
    dom.lockOk.disabled = false;
    dom.lockModal.hidden = false;
    setTimeout(() => dom.lockInput.focus(), 40);
  });
}

function settleLock(value) {
  if (!lockSession) return;
  const resolve = lockSession.resolve;
  lockSession = null;
  dom.lockModal.hidden = true;
  resolve(value);
}

async function submitLock() {
  if (!lockSession) return;
  const password = dom.lockInput.value;
  if (!password) return;
  dom.lockOk.disabled = true;
  dom.lockError.hidden = true;
  try {
    await api.unlockProject(lockSession.projectId, password);
    settleLock(true);
  } catch (err) {
    dom.lockOk.disabled = false;
    dom.lockError.hidden = false;
    dom.lockError.textContent = err.remaining === undefined
      ? err.message
      : `${err.message}，还可以试 ${Math.max(0, err.remaining)} 次`;
    dom.lockInput.select();
  }
}

/* 新建 / 修改项目：名称 + 密码 + 提示语共用一个框 */

let projectFormSession = null;

function openProjectForm({ mode = 'create', project = null } = {}) {
  if (projectFormSession) settleProjectForm(null);
  return new Promise((resolve) => {
    projectFormSession = { resolve, mode, project };
    const hasPassword = Boolean(project?.hasPassword);
    dom.pfTitle.textContent = mode === 'edit' ? '修改项目' : '新建项目';
    dom.pfName.value = project?.name || '';
    dom.pfCurrentField.hidden = !hasPassword;
    dom.pfCurrent.value = '';
    dom.pfPassword.value = '';
    dom.pfPassword.type = 'password';
    dom.pfHint.value = project?.hint || '';
    dom.pfRemove.hidden = !hasPassword;
    dom.pfError.hidden = true;
    dom.pfOk.disabled = false;
    dom.projectFormModal.hidden = false;
    setTimeout(() => dom.pfName.focus(), 40);
  });
}

function settleProjectForm(value) {
  if (!projectFormSession) return;
  const resolve = projectFormSession.resolve;
  projectFormSession = null;
  dom.projectFormModal.hidden = true;
  resolve(value);
}

function projectFormError(message) {
  dom.pfError.hidden = false;
  dom.pfError.textContent = message;
}

async function submitProjectForm({ remove = false } = {}) {
  const session = projectFormSession;
  if (!session) return;
  const name = dom.pfName.value.trim();
  if (!name) return projectFormError('项目名称不能为空');

  const password = remove ? '' : dom.pfPassword.value;
  if (password && (password.length < 4 || password.length > 64)) {
    return projectFormError('密码要 4–64 位');
  }
  const hint = dom.pfHint.value.trim();
  const currentPassword = dom.pfCurrent.value;
  const hasPassword = Boolean(session.project?.hasPassword);
  const hintChanged = hasPassword && hint !== (session.project?.hint || '');
  const lockChanged = remove || Boolean(password) || hintChanged;
  if (lockChanged && hasPassword && !currentPassword) {
    return projectFormError('请输入当前密码');
  }

  dom.pfOk.disabled = true;
  dom.pfError.hidden = true;
  try {
    if (session.mode === 'create') {
      const lock = password ? { password, hint, setBy: state.author } : null;
      const data = await api.createProject(name, lock);
      settleProjectForm(data.project);
      return;
    }
    const project = session.project;
    if (name !== project.name) await api.renameProject(project.id, name);
    if (lockChanged) {
      await api.setProjectPassword(project.id, {
        currentPassword,
        password,
        hint: password ? hint : '',
        setBy: state.author,
      });
    }
    settleProjectForm(true);
  } catch (err) {
    dom.pfOk.disabled = false;
    projectFormError(err.remaining === undefined
      ? err.message
      : `${err.message}，还可以试 ${Math.max(0, err.remaining)} 次`);
  }
}

async function createProjectPrompt() {
  const created = await openProjectForm({ mode: 'create' });
  if (!created) return;
  await refreshVideos();
  if (created.id) location.hash = `#/p/${created.id}`;
  if (created.hasPassword) toast('项目已加锁，忘了密码就去服务器的 project-locks.json 看');
}

async function editProjectBy(project) {
  if (!project) return;
  const saved = await openProjectForm({ mode: 'edit', project });
  if (!saved) return;
  await refreshVideos();
}

async function renameCurrentProject() {
  await editProjectBy(projectById(state.libraryProjectId));
}

async function changeProjectPassword() {
  await editProjectBy(projectById(state.libraryProjectId));
}

/** 上锁：清掉这台浏览器的通行证，下次进来要重新输密码 */
async function lockCurrentProject() {
  const project = projectById(state.libraryProjectId);
  if (!project) return;
  try {
    await api.lockProject(project.id);
    await refreshVideos();
    location.hash = '#/';
    toast('已上锁，下次进来要输密码');
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteProjectBy(project, { goHome = false } = {}) {
  if (!project) return;
  const message = `删除项目「${project.name}」？\n里面的视频会移回「未分类」，不会被删除。`;
  if (!project.hasPassword) {
    if (!(await askConfirm(message, { danger: true }))) return;
    try {
      await api.deleteProject(project.id);
    } catch (err) {
      toast(err.message, true);
      return;
    }
  } else {
    // 删除会把片子退回未分类（等于解锁），所以就算刚进来也要再输一次密码
    let error = '';
    for (;;) {
      const password = await askSecret(message, { danger: true, okLabel: '删除', error });
      if (password == null) return;
      try {
        await api.deleteProject(project.id, password);
        break;
      } catch (err) {
        if (err.remaining === undefined) {
          toast(err.message, true);
          return;
        }
        error = `${err.message}，还可以试 ${Math.max(0, err.remaining)} 次`;
      }
    }
  }
  await refreshVideos();
  if (goHome) location.hash = '#/';
  toast('项目已删除，片子回到未分类');
}

async function deleteCurrentProject() {
  await deleteProjectBy(projectById(state.libraryProjectId), { goHome: true });
}

function renderLibrary() {
  if (!state.videos.length) {
    dom.libraryGrid.replaceChildren(emptyHint('还没有片子，先上传一支。'));
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

    if (state.renameId === video.id) main.append(buildRenameForm(video), meta);
    else main.append(title, meta);

    const rename = document.createElement('button');
    rename.className = 'btn tiny ghost';
    rename.type = 'button';
    rename.textContent = '改名';
    rename.title = '只改显示名称，链接和文件不变';
    rename.addEventListener('click', (event) => {
      event.stopPropagation();
      state.renameId = video.id;
      state.renameDraft = video.title;
      renderLibrary();
    });

    const del = document.createElement('button');
    del.className = 'btn tiny ghost';
    del.type = 'button';
    del.textContent = '删除';
    del.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!await askConfirm(`删除《${video.title}》及其全部弹幕和标注？文件会被移除。`, { danger: true })) return;
      try {
        await api.deleteVideo(video.id);
        await refreshVideos();
        renderLibrary();
        if (state.video?.id === video.id) location.hash = '#/';
      } catch (err) {
        toast(err.message, true);
      }
    });

    const actions = document.createElement('div');
    actions.className = 'lib-actions';
    if (state.renameId !== video.id) actions.append(rename);
    actions.append(del);

    card.append(main, actions);
    if (state.renameId === video.id) card.classList.add('renaming');
    card.addEventListener('click', () => {
      if (state.renameId === video.id) return;
      dom.libraryModal.hidden = true;
      location.hash = `#/v/${video.id}`;
      applyHash();
    });
    return card;
  });

  dom.libraryGrid.replaceChildren(...cards);
  const input = dom.libraryGrid.querySelector('.rename-input');
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function closeRename() {
  state.renameId = null;
  state.renameDraft = '';
  renderLibrary();
  if (!state.video) renderLibraryView();
}

function buildRenameForm(video) {
  const form = document.createElement('form');
  form.className = 'reply-form rename-form';
  form.addEventListener('click', (event) => event.stopPropagation());

  const input = document.createElement('input');
  input.className = 'reply-input rename-input';
  input.type = 'text';
  input.maxLength = 80;
  input.autocomplete = 'off';
  input.placeholder = '新的显示名称，回车保存';
  input.value = state.renameDraft;
  input.addEventListener('input', () => {
    state.renameDraft = input.value;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // 不让全局 Esc 关掉片库；输入法选词时的 Esc 只交给输入法
    event.stopPropagation();
    if (!event.isComposing) closeRename();
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
    closeRename();
  });

  form.append(input, save, cancel);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const next = input.value.trim();
    if (!next) {
      toast('名称不能为空', true);
      input.focus();
      return;
    }
    if (next === video.title) {
      closeRename();
      return;
    }
    save.disabled = true;
    try {
      const data = await api.patchVideo(video.id, { title: next });
      state.renameId = null;
      state.renameDraft = '';
      applyVideoUpdate(data.video); // 会顺带重绘片库，表单随之收起
      toast('已改名');
    } catch (err) {
      save.disabled = false;
      toast(err.message, true);
    }
  });
  return form;
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
      // 自定义确认框在捕获阶段已经 preventDefault；输入法选词时对话框还开着，Esc 只交给输入法
      if (event.defaultPrevented || (dom.askModal && !dom.askModal.hidden)) return;
      if (dom.uploadModal && !dom.uploadModal.hidden) dismissUpload();
      for (const modal of document.querySelectorAll('.modal')) {
        if (modal !== dom.uploadModal) modal.hidden = true;
      }
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
