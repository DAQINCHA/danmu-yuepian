import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ROOT = root;

/** 项目文件夹名：这份代码所在的目录名（如 danmu2），用来区分同一份代码的多个部署 */
export const folderName = path.basename(root);

/** 组名（如「品牌组」）：显示在页面标题和左上角品牌里；不设就用项目文件夹名 */
const groupName = String(process.env.GROUP_NAME || '').replace(/\s+/g, ' ').trim().slice(0, 40);

/** 分享卡片、浏览器标签、左上角用的名字：组名优先，没设就退回文件夹名 */
const siteTitle = `弹幕阅片 · ${(groupName || folderName).slice(0, 40)}`;

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
  groupName,
  // 页面标题 / 分享卡片标题，服务端算好再注入，爬虫不跑 JS 也能看到
  siteTitle,
  // 分享预览图的站点根地址。不设就用请求里的 Host（含 X-Forwarded-Host / X-Forwarded-Proto）。
  // 反代没把 Host 传对时再设，例如 PUBLIC_ORIGIN=http://review.example.com:5280
  publicOrigin: normalizePublicOrigin(process.env.PUBLIC_ORIGIN),
  // 单支视频上限，默认 4GB。局域网内直接传原片，够用即可。
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES) || 4 * 1024 * 1024 * 1024,
  maxCommentLength: 500,
  // 每条弹幕最多挂多少条回复
  maxReplies: 100,
  // 项目密码解锁后，这台浏览器免密多少天
  unlockDays: Math.min(90, Math.max(1, Number(process.env.UNLOCK_DAYS) || 7)),
  // 一个画笔标注最长覆盖多少秒，防止误操作存下一个几分钟的区间
  maxAnnotationSpan: 12,
};

export const uploadsDir = path.join(config.dataDir, 'uploads');
export const coversDir = path.join(config.dataDir, 'covers');
export const dbFile = path.join(config.dataDir, 'db.json');
// 项目密码明文记录在这里：忘了密码就打开这个文件看，或者直接改 / 删掉某条
// （服务端每次校验都按文件内容来，改完立刻生效，不用重启）
export const locksFile = path.join(config.dataDir, 'project-locks.json');
// 通行证 Cookie 的签名密钥，首次启动自动生成
export const sessionKeyFile = path.join(config.dataDir, 'session.key');
