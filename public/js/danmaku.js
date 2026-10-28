const LANES = 7;

/**
 * 弹幕层：播放时按时间点飘出，暂停时把当前附近的评论钉在画面下方，
 * 这样「指着这一帧说」的意见不用等整段播完才看得到。
 */
export function createDanmaku(layer, options = {}) {
  const colorOf = options.colorOf || (() => '#8ab4ff');
  const isMine = options.isMine || (() => false);
  const flying = new Set();
  let enabled = true;
  let laneCursor = 0;

  const focus = document.createElement('div');
  focus.className = 'danmaku-focus';
  layer.appendChild(focus);

  function laneTop() {
    const height = layer.clientHeight || 360;
    const laneHeight = Math.max(26, Math.min(46, Math.round(height / 9)));
    const top = 8 + (laneCursor % LANES) * laneHeight;
    laneCursor += 1;
    return Math.min(top, Math.max(8, height - 40));
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

  function fly(comment) {
    if (!enabled) return;
    const node = build(comment);
    node.style.top = `${laneTop()}px`;
    const duration = Math.min(14, Math.max(7, 6 + (comment.text || '').length * 0.14));
    node.style.animationDuration = `${duration.toFixed(1)}s`;
    layer.appendChild(node);
    node.style.setProperty('--travel', `${layer.clientWidth + node.offsetWidth + 24}px`);
    flying.add(node);
    node.addEventListener('animationend', () => {
      node.remove();
      flying.delete(node);
    });
  }

  function showFocus(comments) {
    const list = enabled ? comments.slice(-5) : [];
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

  function clear() {
    for (const node of flying) node.remove();
    flying.clear();
    showFocus([]);
  }

  return {
    fly,
    showFocus,
    clear,
    get enabled() {
      return enabled;
    },
    setEnabled(next) {
      enabled = Boolean(next);
      layer.classList.toggle('off', !enabled);
      if (!enabled) clear();
    },
  };
}
