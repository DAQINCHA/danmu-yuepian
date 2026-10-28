/**
 * 截帧工具：
 *  · createFrameGrabber —— 用一个藏起来的 video 元素按时间点取帧，不打扰正在看的播放器
 *  · drawOverlayBoxes / drawWatermark —— 把弹幕、时间戳按视频原始分辨率重画到画布上
 *  · downloadCanvas —— 存成 PNG
 * 视频由本服务同源提供，画布不会被「污染」，toDataURL / toBlob 都能用。
 */

const WAIT_MS = 10_000;

function waitEvent(target, name, timeout = WAIT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('读取视频超时'));
    }, timeout);
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('视频读取失败'));
    };
    function cleanup() {
      clearTimeout(timer);
      target.removeEventListener(name, ok);
      target.removeEventListener('error', fail);
    }
    target.addEventListener(name, ok);
    target.addEventListener('error', fail);
  });
}

/** seeked 之后等新的一帧真正解码出来；不支持 rVFC 的浏览器等两帧动画 */
function frameReady(video, timeout = 400) {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === 'function') {
      const timer = setTimeout(resolve, timeout);
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }
  });
}

export function createFrameGrabber() {
  let video = null;
  let src = '';
  let chain = Promise.resolve();

  function ensure(url) {
    if (!video) {
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.setAttribute('aria-hidden', 'true');
      // 留在文档里（而不是 display:none），部分浏览器才会给它解码画面
      video.style.cssText = 'position:fixed;left:-4px;top:-4px;width:2px;height:2px;opacity:0;pointer-events:none;';
      document.body.appendChild(video);
    }
    if (src !== url) {
      src = url;
      video.src = url;
      video.load();
    }
  }

  function dropVideo() {
    if (!video) return;
    src = '';
    video.pause();
    video.removeAttribute('src');
    // load() 会掐掉还在飞的 Range，避免封面截完一帧后继续把整段片子下完
    video.load();
  }

  async function run(url, time, maxWidth, release) {
    try {
      ensure(url);
      if (video.readyState < 1) await waitEvent(video, 'loadedmetadata');

      const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : time + 1;
      const target = Math.min(Math.max(0, time), Math.max(0, total - 0.001));
      if (Math.abs(video.currentTime - target) > 0.0005 || video.readyState < 2) {
        const presented = frameReady(video);
        const seeked = waitEvent(video, 'seeked');
        video.currentTime = target;
        await seeked;
        await presented;
      }
      if (video.readyState < 2) await waitEvent(video, 'loadeddata');

      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) throw new Error('读不到画面尺寸');
      const scale = maxWidth ? Math.min(1, maxWidth / width) : 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      if (release) dropVideo();
    }
  }

  return {
    /**
     * 取 time 秒处的画面，返回画布；多次调用自动排队，同一时间只 seek 一次。
     * release：截完就卸掉 src，不再缓冲后面的片子。封面只要一帧，报告要连续截就别开。
     */
    grab(url, time, { maxWidth = 0, release = false } = {}) {
      const job = chain.catch(() => {}).then(() => run(url, time, maxWidth, release));
      chain = job;
      return job;
    },
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** 按字符折行（中文没有空格可断），超出宽度就换行 */
function wrapLines(ctx, text, width) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const ch of paragraph) {
      if (line && ctx.measureText(line + ch).width > width) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * 把 danmaku.snapshot() 读出来的弹幕框重画到画布上。
 * boxes 里的坐标是 CSS 像素，scale = 画布宽 / 弹幕层宽。
 */
export function drawOverlayBoxes(ctx, boxes, scale) {
  for (const box of boxes) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, box.opacity));
    const x = box.x * scale;
    const y = box.y * scale;
    const w = box.w * scale;
    const h = box.h * scale;

    roundRectPath(ctx, x, y, w, h, box.radius * scale);
    ctx.fillStyle = box.background || 'rgba(6, 8, 12, 0.55)';
    ctx.fill();
    if (box.border) {
      ctx.lineWidth = box.border.width * scale;
      ctx.strokeStyle = box.border.color;
      ctx.stroke();
    }

    for (const span of box.spans) {
      if (!span.text) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(span.x * scale, span.y * scale, span.w * scale, span.h * scale);
      ctx.clip();
      ctx.font = `${span.weight} ${span.size * scale}px ${span.family}`;
      ctx.fillStyle = span.color;
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 3 * scale;
      ctx.shadowOffsetY = 1 * scale;
      const lineHeight = span.lineHeight * scale;
      // 屏幕上只占一行的就别折，免得字体度量的细微差异多折出一行
      const multiLine = span.wrap && span.h > span.lineHeight * 1.5;
      const lines = multiLine ? wrapLines(ctx, span.text, span.w * scale * 1.01 + 1) : [span.text];
      lines.forEach((line, index) => {
        ctx.fillText(line, span.x * scale, span.y * scale + lineHeight * (index + 0.5));
      });
      ctx.restore();
    }
    ctx.restore();
  }
}

/** 左上角时间戳水印；scale 同上，保证和屏幕上看到的比例一致 */
export function drawWatermark(ctx, text, scale) {
  const size = Math.max(12, 13 * scale);
  const padX = 8 * scale;
  const padY = 5 * scale;
  ctx.save();
  ctx.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace`;
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + padX * 2;
  const h = size * 1.35 + padY * 2;
  const x = 10 * scale;
  const y = 8 * scale;
  roundRectPath(ctx, x, y, w, h, 6 * scale);
  ctx.fillStyle = 'rgba(8, 10, 14, 0.66)';
  ctx.fill();
  ctx.fillStyle = '#ffd166';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = 2 * scale;
  ctx.fillText(text, x + padX, y + h / 2);
  ctx.restore();
}

export function safeFileName(text, max = 60) {
  return String(text || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, max) || 'video';
}

export function downloadCanvas(canvas, filename) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('生成图片失败'));
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      resolve();
    }, 'image/png');
  });
}
