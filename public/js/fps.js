const COMMON = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 120];

/**
 * 把测出来的值归到常见帧率上。必须取「最接近的一个」而不是第一个落在容差内的：
 * 23.976 和 24 只差 0.1%，用宽松容差逐个试会把 24 判成 23.976。
 */
export function normalizeFps(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return null;

  let best = null;
  let bestGap = Infinity;
  for (const candidate of COMMON) {
    const gap = Math.abs(raw - candidate) / candidate;
    if (gap < bestGap) {
      bestGap = gap;
      best = candidate;
    }
  }
  if (best !== null && bestGap < 0.006) return best;
  return Math.round(raw * 100) / 100;
}

/**
 * 播放时用 requestVideoFrameCallback 采样相邻帧的 mediaTime 差值，
 * 取中位数换算出真实帧率。中位数能吃掉偶尔掉的帧（差值会翻倍）。
 * 视频没在播放、或浏览器不支持时返回 null，调用方保持原值即可。
 */
export function detectFrameRate(video, { samples = 24, timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback !== 'function') {
      resolve(null);
      return;
    }

    const deltas = [];
    let lastMediaTime = null;
    let handle = 0;
    let timer = 0;
    let settled = false;

    const conclude = () => {
      if (deltas.length < 4) return null;
      const sorted = [...deltas].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      return normalizeFps(1 / median);
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('pause', onInterrupt);
      video.removeEventListener('ended', onInterrupt);
      if (handle && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(handle);
      }
      resolve(value);
    };

    // 用户一暂停就没有新帧了，用已经采到的样本收尾，别干等超时
    const onInterrupt = () => finish(conclude());

    const step = (now, metadata) => {
      if (settled) return;
      const time = metadata?.mediaTime;
      if (Number.isFinite(time)) {
        if (lastMediaTime !== null) {
          const delta = time - lastMediaTime;
          if (delta > 0.0005 && delta < 0.6) deltas.push(delta);
        }
        lastMediaTime = time;
      }
      if (deltas.length >= samples) {
        finish(conclude());
        return;
      }
      handle = video.requestVideoFrameCallback(step);
    };

    video.addEventListener('pause', onInterrupt);
    video.addEventListener('ended', onInterrupt);
    handle = video.requestVideoFrameCallback(step);
    timer = setTimeout(() => finish(conclude()), timeout);
  });
}
