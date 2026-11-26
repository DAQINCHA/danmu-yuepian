/** 00:12.040 / 1:02:33.120 */
export function timecode(value, withMs = true) {
  const total = Math.max(0, Number(value) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const base = hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  if (!withMs) return base;
  return `${base}.${String(ms === 1000 ? 999 : ms).padStart(3, '0')}`;
}

export function clockTime(value) {
  const total = Math.max(0, Number(value) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function relativeTime(timestamp) {
  const diff = Date.now() - Number(timestamp || 0);
  if (!Number.isFinite(diff) || diff < 0) return '刚刚';
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  if (diff < 30 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
  return new Date(Number(timestamp)).toLocaleDateString('zh-CN');
}

// 同一支片里按署名先后轮着分八色，同名同色；气泡、侧栏、报告的署名色都跟着走。
// 切到「胶片剪辑台」皮肤时自动切为暖琥珀 / 银盐白 / 柔珊瑚等八色，保持暗房观感统一。
export const PALETTE = ['#7ff0e2', '#e0c46a', '#ff9b8f', '#9db8ff', '#c9a2ff', '#8fe39a', '#ffb36b', '#f58fc8'];
export const PALETTE_FILM = ['#e8b55f', '#dfd4c0', '#eb7d72', '#9fb8d8', '#c4a3d9', '#a8c98a', '#e09a5a', '#d98fb0'];

function activePalette() {
  if (typeof document !== 'undefined' && document.documentElement?.dataset.skin === 'film') {
    return PALETTE_FILM;
  }
  return PALETTE;
}

// 同一个视频内按署名先后分配颜色：同名同色，八色轮着来；不同视频互不影响。
const roster = new Map();

export function setAuthorRoster(comments = [], annotations = []) {
  const entries = [];
  const add = (author, at) => entries.push([String(author || '匿名'), Number(at) || 0]);
  for (const item of [...comments, ...annotations]) {
    add(item.author, item.createdAt);
    for (const reply of item.replies || []) add(reply.author, reply.createdAt);
  }
  entries.sort((a, b) => a[1] - b[1]);
  roster.clear();
  for (const [name] of entries) if (!roster.has(name)) roster.set(name, roster.size);
}

export function authorColor(name) {
  const key = String(name || '匿名');
  if (!roster.has(key)) roster.set(key, roster.size);
  const palette = activePalette();
  return palette[roster.get(key) % palette.length];
}
