import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ROOT = root;

export const config = {
  port: Number(process.env.PORT) || 5280,
  host: process.env.HOST || '0.0.0.0',
  publicDir: path.join(root, 'public'),
  // 相对路径按项目根目录算（DATA_DIR=data/brand），不随启动时的当前目录变；不设就是原来的 data/
  dataDir: process.env.DATA_DIR ? path.resolve(root, process.env.DATA_DIR) : path.join(root, 'data'),
  // 组名（如「品牌组」）：显示在页面标题和左上角品牌里；不设就和以前一样
  groupName: String(process.env.GROUP_NAME || '').replace(/\s+/g, ' ').trim().slice(0, 40),
  // 单支视频上限，默认 4GB。局域网内直接传原片，够用即可。
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES) || 4 * 1024 * 1024 * 1024,
  maxCommentLength: 500,
  // 每条弹幕最多挂多少条回复
  maxReplies: 100,
  // 一个画笔标注最长覆盖多少秒，防止误操作存下一个几分钟的区间
  maxAnnotationSpan: 12,
};

export const uploadsDir = path.join(config.dataDir, 'uploads');
export const dbFile = path.join(config.dataDir, 'db.json');
