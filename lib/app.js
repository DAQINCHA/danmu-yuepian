import fs from 'node:fs';
import http from 'node:http';
import { config, uploadsDir, dbFile } from './config.js';
import { createStore } from './store.js';
import { createEventHub } from './events.js';
import { createApiRouter } from './api.js';
import { serveStatic } from './static.js';

let exitHookInstalled = false;

export function createApplicationServer() {
  fs.mkdirSync(uploadsDir, { recursive: true });

  const store = createStore(dbFile);
  store.load();

  const hub = createEventHub();
  const route = createApiRouter({ store, hub });

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
