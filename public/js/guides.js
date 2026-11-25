/**
 * 画面参考线与安全框叠层（仅在本机叠加显示，不写入服务端，不进入截图）：
 *  · douyin —— 抖音 / 视频号 9:16 界面遮挡避让区（横屏片子自动居中套 9:16 裁切框）
 *  · xhs    —— 小红书顶部 / 底部文案与互动栏避让区
 *  · cinema —— 2.35:1 电影宽银幕遮幅参考线
 *  · thirds —— 三分构图九宫格 + 中心十字准星 + 90% 标题安全框
 */

export const GUIDE_MODES = [
  { id: 'off', label: '关闭参考线', short: '参考线', desc: '不叠加任何遮罩或辅助线' },
  { id: 'douyin', label: '抖音 / 视频号安全区', short: '抖音安全区', desc: '标出右侧点赞栏与底部文案遮挡区' },
  { id: 'xhs', label: '小红书安全区', short: '小红书', desc: '标出顶部导航与底部标题评论栏' },
  { id: 'cinema', label: '2.35:1 电影遮幅', short: '2.35:1', desc: '预览宽银幕上下遮幅构图' },
  { id: 'thirds', label: '三分线与中心准星', short: '三分线', desc: '九宫格 + 中心准星 + 90% 标题框' },
];

const MODE_IDS = new Set(GUIDE_MODES.map((m) => m.id));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 横屏片子套竖屏安全框时，先算出居中的 9:16 裁切容器；竖屏直接贴满 100% */
function createVerticalFrame(aspect) {
  const frame = el('div', 'guide-vframe');
  if (aspect > 0.72) {
    // 画面比竖屏宽：按高度撑满，宽度按 9:16 居中，两侧轻压暗提示裁切范围
    const widthPct = Math.min(100, ((9 / 16) / aspect) * 100);
    const sidePct = (100 - widthPct) / 2;
    frame.style.left = `${sidePct.toFixed(3)}%`;
    frame.style.width = `${widthPct.toFixed(3)}%`;
    frame.classList.add('is-cropped');
  } else {
    frame.style.left = '0%';
    frame.style.width = '100%';
  }
  return frame;
}

function buildDouyin(aspect) {
  const frag = document.createDocumentFragment();
  const frame = createVerticalFrame(aspect);

  if (frame.classList.contains('is-cropped')) {
    const sideW = parseFloat(frame.style.left) || 0;
    const leftMask = el('div', 'guide-crop-mask');
    leftMask.style.cssText = `left:0;width:${sideW}%;`;
    const rightMask = el('div', 'guide-crop-mask');
    rightMask.style.cssText = `right:0;width:${sideW}%;`;
    frag.append(leftMask, rightMask);
  }

  // 顶部状态栏 / 推荐关注栏（约 11%）
  const top = el('div', 'guide-zone warn guide-dy-top');
  top.append(el('span', 'guide-label', '顶部导航 / 状态栏'));

  // 右侧头像、点赞、评论、收藏、转发栏（宽约 17%，高度在底部 20%~66%）
  const right = el('div', 'guide-zone warn guide-dy-right');
  right.append(el('span', 'guide-label vertical', '右侧互动栏'));

  // 底部账号名、文案、话题与进度条（高约 22%）
  const bottom = el('div', 'guide-zone danger guide-dy-bottom');
  bottom.append(el('span', 'guide-label', '底部文案 / 进度条避让区（字幕勿入）'));

  // 中间核心安全区描边
  const safe = el('div', 'guide-safe-box guide-dy-safe');
  safe.append(el('span', 'guide-badge', '抖音 / 视频号安全区'));

  frame.append(top, right, bottom, safe);
  frag.append(frame);
  return frag;
}

function buildXhs(aspect) {
  const frag = document.createDocumentFragment();
  const frame = createVerticalFrame(aspect);

  if (frame.classList.contains('is-cropped')) {
    const sideW = parseFloat(frame.style.left) || 0;
    const leftMask = el('div', 'guide-crop-mask');
    leftMask.style.cssText = `left:0;width:${sideW}%;`;
    const rightMask = el('div', 'guide-crop-mask');
    rightMask.style.cssText = `right:0;width:${sideW}%;`;
    frag.append(leftMask, rightMask);
  }

  const top = el('div', 'guide-zone warn guide-xhs-top');
  top.append(el('span', 'guide-label', '顶部返回 / 搜同款'));

  const bottom = el('div', 'guide-zone danger guide-xhs-bottom');
  bottom.append(el('span', 'guide-label', '底部标题 / 评论与互动栏避让区'));

  const safe = el('div', 'guide-safe-box guide-xhs-safe');
  safe.append(el('span', 'guide-badge', '小红书安全区'));

  frame.append(top, bottom, safe);
  frag.append(frame);
  return frag;
}

function buildCinema(aspect) {
  const frag = document.createDocumentFragment();
  const target = 2.35;
  if (aspect >= target - 0.03) {
    // 视频本身已经是 2.35:1 或更宽
    const badge = el('span', 'guide-badge guide-corner', '当前片源已是宽银幕 (≥2.35:1)');
    frag.append(badge);
    return frag;
  }
  const activeHeightPct = (aspect / target) * 100;
  const barPct = Math.max(0, (100 - activeHeightPct) / 2);

  const topBar = el('div', 'guide-letterbox top');
  topBar.style.height = `${barPct.toFixed(3)}%`;
  const bottomBar = el('div', 'guide-letterbox bottom');
  bottomBar.style.height = `${barPct.toFixed(3)}%`;
  bottomBar.append(el('span', 'guide-badge guide-cinema-tag', '2.35:1 电影遮幅'));

  frag.append(topBar, bottomBar);
  return frag;
}

function buildThirds() {
  const frag = document.createDocumentFragment();
  const grid = el('div', 'guide-thirds');
  for (const cls of ['v1', 'v2', 'h1', 'h2']) grid.append(el('i', `guide-line ${cls}`));
  grid.append(el('div', 'guide-title-safe'));
  grid.append(el('div', 'guide-crosshair'));
  frag.append(grid);
  return frag;
}

export function createGuideOverlay(container) {
  let mode = 'off';
  let aspect = 16 / 9;

  function render() {
    if (!container) return;
    if (mode === 'off') {
      container.replaceChildren();
      container.hidden = true;
      container.dataset.mode = 'off';
      return;
    }
    container.hidden = false;
    container.dataset.mode = mode;
    if (mode === 'douyin') container.replaceChildren(buildDouyin(aspect));
    else if (mode === 'xhs') container.replaceChildren(buildXhs(aspect));
    else if (mode === 'cinema') container.replaceChildren(buildCinema(aspect));
    else if (mode === 'thirds') container.replaceChildren(buildThirds());
  }

  return {
    get mode() {
      return mode;
    },
    setMode(next) {
      mode = MODE_IDS.has(next) ? next : 'off';
      render();
    },
    setAspect(width, height) {
      if (!width || !height) return;
      const next = width / height;
      if (Math.abs(next - aspect) < 0.005) return;
      aspect = next;
      if (mode !== 'off') render();
    },
    clear() {
      if (container) {
        container.replaceChildren();
        container.hidden = true;
      }
    },
  };
}
