import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ROOT = root;

/** 只接受 http(s)://主机[:端口]，丢掉路径和账号，避免把非法值写进页面 */
function normalizePublicOrigin(raw) {
  const text = String(raw || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password || url.search || url.hash) return '';
    if (url.pathname && url.pathname !== '/') return '';
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

export const config = {
  port: Number(process.env.PORT) || 5280,
  host: process.env.HOST || '0.0.0.0',
  publicDir: path.join(root, 'public'),
  // 相对路径按项目根目录算（DATA_DIR=data/brand），不随启动时的当前目录变；不设就是原来的 data/
  dataDir: process.env.DATA_DIR ? path.resolve(root, process.env.DATA_DIR) : path.join(root, 'data'),
  // 组名（如「品牌组」）：显示在页面标题和左上角品牌里；不设就和以前一样
  groupName: String(process.env.GROUP_NAME || '').replace(/\s+/g, ' ').trim().slice(0, 40),
  // 分享预览图的站点根地址。不设就用请求里的 Host（含 X-Forwarded-Host / X-Forwarded-Proto）。
  // 反代没把 Host 传对时再设，例如 PUBLIC_ORIGIN=http://review.example.com:5280
  publicOrigin: normalizePublicOrigin(process.env.PUBLIC_ORIGIN),
  // 单支视频上限，默认 4GB。局域网内直接传原片，够用即可。
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES) || 4 * 1024 * 1024 * 1024,
  maxCommentLength: 500,
  // 每条弹幕最多挂多少条回复
  maxReplies: 100,
  // 一个画笔标注最长覆盖多少秒，防止误操作存下一个几分钟的区间
  maxAnnotationSpan: 12,
};

export const uploadsDir = path.join(config.dataDir, 'uploads');
export const coversDir = path.join(config.dataDir, 'covers');
export const dbFile = path.join(config.dataDir, 'db.json');
