import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ROOT = root;

export const config = {
  port: Number(process.env.PORT) || 5280,
  host: process.env.HOST || '0.0.0.0',
  publicDir: path.join(root, 'public'),
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data'),
  // 单支视频上限，默认 4GB。局域网内直接传原片，够用即可。
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES) || 4 * 1024 * 1024 * 1024,
  maxCommentLength: 500,
  // 一个画笔标注最长覆盖多少秒，防止误操作存下一个几分钟的区间
  maxAnnotationSpan: 12,
};

export const uploadsDir = path.join(config.dataDir, 'uploads');
export const dbFile = path.join(config.dataDir, 'db.json');
