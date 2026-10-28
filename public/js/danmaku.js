const MAX_LANES = 8;
const TOP = 36; // 给左上角的「已暂停」角标和截图时间戳水印留出位置
const SIDE = 12;
const GAP = 14;
const LANE_GAP = 6; // 车道之间的竖向留白

/**
 * 弹幕层：播放到时间点时，评论直接钉在画面上方的车道里出现，停留几秒后淡出，
 * 不再从右侧慢慢划入——一眼能扫完，信息密度高。同一条车道里从左往右排，
 * 排满了才换下一条；所有车道都满了，就把最久没更新的那条整条让出来。
 * 暂停时在场的弹幕原地定住，画面下方再补上附近还没露面的评论。
 */
export function createDanmaku(layer, options = {}) {
  const colorOf = options.colorOf || (() => '#8ab4ff');
  const isMine = options.isMine || (() => false);
  /** node -> { id, lane, right, born } */
  const live = new Map();
  let enabled = true;

  const focus = document.createElement('div');
  focus.className = 'danmaku-focus';
  layer.appendChild(focus);

  /** 车道高度按弹幕实际渲染高度来算，字号怎么调都不会上下叠住 */
  function metrics(nodeHeight) {
    const height = layer.clientHeight || 360;
    const laneHeight = Math.max(24, Math.ceil(nodeHeight || 50)) + LANE_GAP;
    const fit = Math.floor((height * 0.7 - TOP) / laneHeight);
    return { laneHeight, count: Math.max(2, Math.min(MAX_LANES, fit)) };
  }

  function build(comment) {
    const node = document.createElement('div');
    node.className = 'dm';
    node.style.setProperty('--dm-color', colorOf(comment));
    if (isMine(comment)) node.classList.add('is-mine');

    const name = document.createElement('span');
    name.className = 'dm-name';
    name.textContent = comment.author || '匿名';

    const text = document.createElement('span');
    text.className = 'dm-text';
    text.textContent = comment.text;

    node.append(name, text);
    return node;
  }

  function retire(node) {
    node.remove();
    live.delete(node);
  }

  function laneItems(index) {
    const items = [];
    for (const info of live.values()) if (info.lane === index) items.push(info);
    return items;
  }

  /** 找一条放得下的车道，返回 { lane, x } */
  function place(width, count) {
    const maxRight = (layer.clientWidth || 640) - SIDE;
    for (let lane = 0; lane < count; lane += 1) {
      const items = laneItems(lane);
      if (!items.length) return { lane, x: SIDE };
      const x = Math.max(...items.map((i) => i.right)) + GAP;
      if (x + width <= maxRight) return { lane, x };
    }

    // 全满：让出最近一次写入最早的车道
    let victim = 0;
    let oldest = Infinity;
    for (let lane = 0; lane < count; lane += 1) {
      const newest = Math.max(0, ...laneItems(lane).map((i) => i.born));
      if (newest < oldest) {
        oldest = newest;
        victim = lane;
      }
    }
    for (const [node, info] of [...live]) if (info.lane === victim) retire(node);
    return { lane: victim, x: SIDE };
  }

  function isLive(id) {
    if (id === undefined || id === null) return false;
    for (const info of live.values()) if (info.id === id) return true;
    return false;
  }

  function pop(comment) {
    if (!enabled || isLive(comment.id)) return;
    const node = build(comment);
    const duration = Math.min(8, Math.max(4, 3.2 + (comment.text || '').length * 0.06));
    node.style.animationDuration = `${duration.toFixed(1)}s`;
    node.style.left = '0px';
    node.style.top = '0px';
    layer.appendChild(node);

    const { laneHeight, count } = metrics(node.offsetHeight);
    const width = node.offsetWidth;
    const { lane, x } = place(width, count);
    node.style.left = `${x}px`;
    node.style.top = `${TOP + lane * laneHeight}px`;
    live.set(node, { id: comment.id, lane, right: x + width, born: performance.now() });

    node.addEventListener('animationend', () => retire(node));
  }

  function liveIds() {
    const ids = new Set();
    for (const info of live.values()) ids.add(info.id);
    return ids;
  }

  function showFocus(comments) {
    // 已经在上方车道里定住的就不在下方重复列了
    const shown = liveIds();
    const list = enabled ? comments.filter((c) => !shown.has(c.id)).slice(-5) : [];
    if (!list.length) {
      focus.replaceChildren();
      focus.hidden = true;
      return;
    }
    const cards = list.map((comment) => {
      const card = document.createElement('div');
      card.className = 'dm-focus-card';
      card.style.setProperty('--dm-color', colorOf(comment));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = comment.author || '匿名';
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = comment.text;
      card.append(name, text);
      return card;
    });
    focus.replaceChildren(...cards);
    focus.hidden = false;
  }

  function clearLive() {
    for (const node of [...live.keys()]) retire(node);
  }

  function clear() {
    clearLive();
    showFocus([]);
  }

  /**
   * 把当前画面上看得见的弹幕读成绘制指令（坐标相对弹幕层，单位 CSS 像素），
   * 截图时按视频原始分辨率等比放大重画，所见即所得。
   */
  function snapshot() {
    if (!enabled) return [];
    const base = layer.getBoundingClientRect();
    const rel = (rect) => ({ x: rect.left - base.left, y: rect.top - base.top, w: rect.width, h: rect.height });
    const nodes = [...live.keys()];
    if (!focus.hidden) nodes.push(...focus.children);

    const boxes = [];
    for (const node of nodes) {
      const style = getComputedStyle(node);
      const opacity = Number(style.opacity);
      if (!(opacity > 0.02)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;

      const spans = [...node.children].map((span) => {
        const s = getComputedStyle(span);
        const size = parseFloat(s.fontSize) || 14;
        return {
          ...rel(span.getBoundingClientRect()),
          text: span.textContent || '',
          color: s.color,
          size,
          weight: s.fontWeight,
          family: s.fontFamily,
          lineHeight: parseFloat(s.lineHeight) || size * 1.4,
          wrap: s.whiteSpace !== 'nowrap',
        };
      });

      const borderWidth = parseFloat(style.borderTopWidth) || 0;
      boxes.push({
        ...rel(rect),
        opacity,
        radius: Math.min(parseFloat(style.borderTopLeftRadius) || 0, rect.height / 2),
        background: style.backgroundColor,
        border: borderWidth > 0 ? { width: borderWidth, color: style.borderTopColor } : null,
        spans,
      });
    }
    return boxes;
  }

  return {
    pop,
    isLive,
    showFocus,
    clear,
    clearLive,
    snapshot,
    get enabled() {
      return enabled;
    },
    setEnabled(next) {
      enabled = Boolean(next);
      layer.classList.toggle('off', !enabled);
      if (!enabled) clear();
    },
    /** 暂停时把在场弹幕原地定住，继续播放再接着淡出 */
    setPaused(paused) {
      layer.classList.toggle('paused', Boolean(paused));
    },
  };
}
