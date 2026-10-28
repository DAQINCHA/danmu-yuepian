const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.txt': 'text/plain; charset=utf-8',
};

/** 浏览器能直接播放的容器；不在表里的上传直接拒绝 */
export const PLAYABLE_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv', '.mkv']);

export function mimeFor(filePath) {
  return TYPES[filePath.slice(filePath.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';
}
