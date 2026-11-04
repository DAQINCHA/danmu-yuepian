import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { config, uploadsDir, coversDir, dbFile, locksFile, sessionKeyFile } from './config.js';
import { createStore } from './store.js';
import { createEventHub } from './events.js';
import { createLocks } from './lock.js';
import { createApiRouter } from './api.js';
import { serveStatic } from './static.js';

let exitHookInstalled = false;

export function createApplicationServer() {
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(coversDir, { recursive: true });
  // 封面写入用临时文件再改名；上次如果写到一半就退出，把残留清掉
  for (const name of fs.readdirSync(coversDir)) {
    if (name.endsWith('.tmp')) fs.unlink(path.join(coversDir, name), () => {});
  }

  const store = createStore(dbFile);
  store.load();

  const hub = createEventHub();
  const locks = createLocks({ file: locksFile, keyFile: sessionKeyFile, days: config.unlockDays });
  const route = createApiRouter({ store, hub, locks });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      route(req, res, url);
      return;
    }
    serveStatic(req, res, url, config.publicDir);
  });

  // 视频是大文件，默认的 keep-alive 超时对长传不友好
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 72_000;

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => store.flush());
    process.on('SIGINT', () => {
      store.flush();
      process.exit(0);
    });
  }

  return server;
}
