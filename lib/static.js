import fs from 'node:fs';
import path from 'node:path';
import { mimeFor } from './mime.js';

/**
 * 整目录托管 public/ → /，靠路径归一化 + 前缀校验挡穿越，
 * 不维护文件白名单。
 */
export function serveStatic(req, res, url, publicDir) {
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

  if (pathname.endsWith('/')) pathname += 'index.html';
  const target = path.resolve(publicDir, `.${path.posix.normalize(pathname)}`);

  if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      const fallback = path.join(publicDir, 'index.html');
      // 只有「没有扩展名」的路径才回落到 index.html，避免把写错的 js 路径吞成 HTML
      const looksLikeRoute = !path.posix.basename(pathname).includes('.');
      if (looksLikeRoute && pathname !== '/' && fs.existsSync(fallback)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(fallback).pipe(res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
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
