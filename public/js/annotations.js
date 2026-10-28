/**
 * 画笔层分两块：
 *  · createAnnotationView —— 只读渲染别人的标注，跟随播放时间出现/消失
 *  · createDrawPad        —— 自己画，管理笔画、撤销、清空
 * 两者共用归一化坐标（0~1），所以视频缩放、换屏幕都画在同一个位置。
 */

function setupCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const size = { w: 0, h: 0 };

  function fit() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    size.w = rect.width;
    size.h = rect.height;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  return { ctx, size, fit };
}

export function drawStrokes(ctx, strokes, width, height) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    if (!stroke.points || stroke.points.length < 2) continue;
    ctx.beginPath();
    ctx.strokeStyle = stroke.color || '#ff5a4d';
    ctx.lineWidth = Math.max(1, (stroke.width || 0.004) * width);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = Math.max(2, ctx.lineWidth * 0.7);
    const points = stroke.points;
    ctx.moveTo(points[0][0] * width, points[0][1] * height);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i][0] * width, points[i][1] * height);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function createAnnotationView(canvas) {
  const { ctx, size, fit } = setupCanvas(canvas);
  let signature = '\u0000';

  function render(annotations, time) {
    const active = annotations.filter((a) => time >= a.start - 0.03 && time < a.end);
    const nextSignature = active.map((a) => a.id).join('|');
    if (nextSignature === signature) return;
    signature = nextSignature;

    ctx.clearRect(0, 0, size.w, size.h);
    if (!active.length) return;
    ctx.save();
    ctx.globalAlpha = 0.95;
    for (const annotation of active) drawStrokes(ctx, annotation.strokes, size.w, size.h);
    ctx.restore();
  }

  function clear() {
    signature = '\u0000';
    ctx.clearRect(0, 0, size.w, size.h);
  }

  return {
    fit() {
      fit();
      signature = '\u0000';
      if (size.w) ctx.clearRect(0, 0, size.w, size.h);
    },
    render,
    clear,
  };
}

export function createDrawPad(canvas, { onChange } = {}) {
  const { ctx, size, fit } = setupCanvas(canvas);
  let strokes = [];
  let active = null;
  let enabled = false;
  let color = '#ff5a4d';
  let width = 0.004;

  function redraw() {
    ctx.clearRect(0, 0, size.w, size.h);
    drawStrokes(ctx, strokes, size.w, size.h);
  }

  function pointFrom(event) {
    const rect = canvas.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    ];
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!enabled) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    active = { color, width, points: [pointFrom(event)] };
    strokes.push(active);
    redraw();
    onChange?.();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!enabled || !active) return;
    event.preventDefault();
    const next = pointFrom(event);
    const last = active.points[active.points.length - 1];
    if (Math.abs(next[0] - last[0]) < 0.0015 && Math.abs(next[1] - last[1]) < 0.0015) return;
    active.points.push(next);
    redraw();
  });

  const finish = () => {
    if (!active) return;
    if (active.points.length < 2) strokes.pop();
    active = null;
    redraw();
    onChange?.();
  };

  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('pointerleave', () => {
    if (active) finish();
  });

  return {
    fit() {
      fit();
      redraw();
    },
    setEnabled(next) {
      enabled = Boolean(next);
      if (!enabled) active = null;
    },
    setColor(next) {
      color = next;
    },
    undo() {
      strokes.pop();
      redraw();
      onChange?.();
    },
    clear() {
      strokes = [];
      active = null;
      redraw();
      onChange?.();
    },
    reset() {
      strokes = [];
      active = null;
      redraw();
      onChange?.();
    },
    get strokes() {
      return strokes;
    },
  };
}
