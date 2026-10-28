const MAX_LANES = 12; // 只上下叠、不左右并排，车道上限放宽，实际由画面上方 70% 的高度决定
const TOP = 36; // 给左上角的「已暂停」角标和截图时间戳水印留出位置
const SIDE = 12;
const LANE_GAP = 6; // 车道之间的竖向留白
const MAX_REPLY_LINES = 3; // 弹幕上最多带几条回复，再多就显示「还有 N 条」

/** 气泡第一行的署名：画笔标注的气泡前面加个 ✎，一眼和普通弹幕区分开 */
function headName(item) {
  const author = item.author || '匿名';
  return item.kind === 'annotation' ? `✎ ${author}` : author;
}

function replyRows(comment, classes, colorOf) {
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  const shown = replies.slice(-MAX_REPLY_LINES);
  const rows = shown.map((reply) => {
    const row = document.createElement('div');
    row.className = classes.row;
    row.style.setProperty('--dm-color', colorOf(reply));
    const name = document.createElement('span');
    name.className = classes.name;
    name.textContent = `↳ ${reply.author || '匿名'}`;
    const text = document.createElement('span');
    text.className = classes.text;
    text.textContent = reply.text;
    row.append(name, text);
    return row;
  });
  if (replies.length > shown.length) {
    const row = document.createElement('div');
    row.className = `${classes.row} more`;
    const text = document.createElement('span');
    text.className = classes.text;
    text.textContent = `…还有 ${replies.length - shown.length} 条回复`;
    row.append(text);
    rows.unshift(row);
  }
  return rows;
}

/**
 * 弹幕层：播放到时间点时，评论直接钉在画面上方的车道里出现，停留几秒后淡出，
 * 不再从右侧慢慢划入——一眼能扫完，信息密度高。同时在场的多条弹幕
 * 一律从上往下叠：左边对齐，每条占下一个空着的车道，绝不在同一行左右并排；
 * 所有车道都满了，就让出最早出现的那条（连同它占的整段车道）。
 * 暂停时在场的弹幕原地定住，画面下方再补上附近还没露面的评论。
 * 弹幕带着它的回复一起出现：回复缩进排在主文字下面、字号小一号，
 * 这种多行气泡会同时占住相邻的几条车道，不会和上下的弹幕叠住。
 */
export function createDanmaku(layer, options = {}) {
  const colorOf = options.colorOf || (() => '#8ab4ff');
  const isMine = options.isMine || (() => false);
  /** node -> { id, lane, span, born } —— span = 占几条车道 */
  const live = new Map();
  let enabled = true;

  const focus = document.createElement('div');
  focus.className = 'danmaku-focus';
  layer.appendChild(focus);

  /**
   * 车道高度 = 单行弹幕的实际渲染高度（主文字一行 + 上下内边距），字号怎么调都不会叠住；
   * 带回复的气泡更高，按它的实际高度算要占几条车道。
   */
  function metrics(node) {
    const height = layer.clientHeight || 360;
    const style = getComputedStyle(node);
    const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    // 用行高而不是首行实际高度：长弹幕换行后首行会变高，不能把车道一起撑高
    const single = Math.ceil((parseFloat(style.lineHeight) || 40) + pad);
    const laneHeight = Math.max(24, single) + LANE_GAP;
    const fit = Math.floor((height * 0.7 - TOP) / laneHeight);
    const count = Math.max(2, Math.min(MAX_LANES, fit));
    const span = Math.min(count, Math.max(1, Math.ceil((node.offsetHeight + LANE_GAP) / laneHeight)));
    return { laneHeight, count, span };
  }

  function build(comment) {
    const node = document.createElement('div');
    node.className = 'dm';
    node.style.setProperty('--dm-color', colorOf(comment));
    if (isMine(comment)) node.classList.add('is-mine');

    const line = document.createElement('div');
    line.className = 'dm-line';

    const name = document.createElement('span');
    name.className = 'dm-name';
    name.textContent = headName(comment);

    const text = document.createElement('span');
    text.className = 'dm-text';
    text.textContent = comment.text;

    line.append(name, text);
    const rows = replyRows(comment, { row: 'dm-reply', name: 'dm-reply-name', text: 'dm-reply-text' }, colorOf);
    if (rows.length) node.classList.add('has-replies');
    if (comment.kind === 'annotation') node.classList.add('is-annotation');
    node.append(line, ...rows);
    return node;
  }

  function retire(node) {
    node.remove();
    live.delete(node);
  }

  /** 和 [lane, lane + span) 这几条车道有交集的在场弹幕 */
  function bandItems(lane, span) {
    const items = [];
    for (const info of live.values()) {
      if (info.lane < lane + span && info.lane + info.span > lane) items.push(info);
    }
    return items;
  }

  /** 从上往下找连续 span 条空车道，返回起始车道；一条车道只放一条弹幕 */
  function place(count, span) {
    const last = Math.max(0, count - span);
    for (let lane = 0; lane <= last; lane += 1) {
      if (!bandItems(lane, span).length) return lane;
    }

    // 全满：让出最早出现的那一段车道（段内最新那条也是最老的）
    let victim = 0;
    let oldest = Infinity;
    for (let lane = 0; lane <= last; lane += 1) {
      const newest = Math.max(0, ...bandItems(lane, span).map((i) => i.born));
      if (newest < oldest) {
        oldest = newest;
        victim = lane;
      }
    }
    for (const [node, info] of [...live]) {
      if (info.lane < victim + span && info.lane + info.span > victim) retire(node);
    }
    return victim;
  }

  function isLive(id) {
    if (id === undefined || id === null) return false;
    for (const info of live.values()) if (info.id === id) return true;
    return false;
  }

  function pop(comment) {
    if (!enabled || isLive(comment.id)) return;
    const node = build(comment);
    const replyCount = Math.min(MAX_REPLY_LINES, Array.isArray(comment.replies) ? comment.replies.length : 0);
    const duration = Math.min(12, Math.max(4, 3.2 + (comment.text || '').length * 0.06) + replyCount * 1.2);
    node.style.animationDuration = `${duration.toFixed(1)}s`;
    node.style.left = '0px';
    node.style.top = '0px';
    layer.appendChild(node);

    const { laneHeight, count, span } = metrics(node);
    if (span > 1 || node.offsetHeight > laneHeight * 1.2) node.classList.add('is-wrapped');
    const lane = place(count, span);
    node.style.left = `${SIDE}px`;
    node.style.top = `${TOP + lane * laneHeight}px`;
    live.set(node, { id: comment.id, lane, span, born: performance.now() });

    node.addEventListener('animationend', () => retire(node));
  }

  /** 收掉某一条在场的气泡（回复变了要重画时用） */
  function drop(id) {
    for (const [node, info] of [...live]) if (info.id === id) retire(node);
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
      name.textContent = headName(comment);
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = comment.text;
      card.append(name, text);
      const rows = replyRows(comment, { row: 'reply', name: 'name', text: 'text' }, colorOf);
      if (rows.length) {
        const box = document.createElement('div');
        box.className = 'replies';
        box.append(...rows);
        card.append(box);
      }
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

      // 只取叶子 span（名字 / 正文 / 回复），外层行容器不画字
      const spans = [...node.querySelectorAll('span')].map((span) => {
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
    drop,
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
