import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { mimeFor } from './mime.js';

const OG_TOKEN = '{{OG_IMAGE}}';
const TITLE_TOKEN = '{{SITE_TITLE}}';

/**
 * 整目录托管 public/ → /，靠路径归一化 + 前缀校验挡穿越，
 * 不维护文件白名单。
 * projectNameFor(pathname) 给 /p/<id> 这类真路径返回项目名，用于页面标题。
 */
export function serveStatic(req, res, url, publicDir, projectNameFor) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  // 末尾斜杠先记住不带斜杠的路由（/p/<id>/ 也能打开），再当目录拼 index.html
  const routePath = pathname.replace(/\/+$/, '') || '/';
  if (pathname.endsWith('/')) pathname += 'index.html';
  const target = path.resolve(publicDir, `.${path.posix.normalize(pathname)}`);

  if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const indexFile = path.join(publicDir, 'index.html');

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      // 只有「没有扩展名」的路径才回落到 index.html，避免把写错的 js 路径吞成 HTML
      const looksLikeRoute = !path.posix.basename(routePath).includes('.');
      if (looksLikeRoute && routePath !== '/' && fs.existsSync(indexFile)) {
        sendIndex(req, res, indexFile, projectNameFor?.(routePath) || '');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    if (target === indexFile) {
      sendIndex(req, res, indexFile);
      return;
    }

    res.writeHead(200, {
      'Content-Type': mimeFor(target),
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

/** 首页 HTML 里的 og:image 换成这次请求对应的绝对地址，标题换成
 *  「弹幕阅片 · 项目名」（项目页）或「弹幕阅片 · 组名 / 文件夹名」（其余）。
 *  视频页还是井号路由，爬虫读到的也是首页。 */
function sendIndex(req, res, file, projectName = '') {
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html missing');
      return;
    }
    const origin = requestPublicOrigin(req);
    const image = origin ? `${origin}/assets/og.png` : '/assets/og.png';
    const title = projectName ? `弹幕阅片 · ${projectName.slice(0, 40)}` : config.siteTitle;
    const body = html
      .split(OG_TOKEN).join(escapeAttr(image))
      .split(TITLE_TOKEN).join(escapeAttr(title));
    const buf = Buffer.from(body);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(buf);
  });
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function firstHeader(req, name) {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').split(',')[0].trim();
}

function isPublicHost(host) {
  if (!host || host.length > 253) return false;
  return /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host)
    || /^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/.test(host);
}

/** PUBLIC_ORIGIN 优先；否则用 X-Forwarded-Host / Host，协议用 X-Forwarded-Proto。 */
export function requestPublicOrigin(req) {
  if (config.publicOrigin) return config.publicOrigin;
  const host = firstHeader(req, 'x-forwarded-host') || firstHeader(req, 'host');
  if (!isPublicHost(host)) return '';
  let proto = firstHeader(req, 'x-forwarded-proto').toLowerCase();
  if (proto !== 'http' && proto !== 'https') {
    proto = req.socket?.encrypted ? 'https' : 'http';
  }
  return `${proto}://${host}`;
}
