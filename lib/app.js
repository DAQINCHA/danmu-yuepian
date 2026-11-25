import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { config, uploadsDir, coversDir, waveformsDir, thumbsDir, dbFile, locksFile, sessionKeyFile } from './config.js';
import { createStore } from './store.js';
import { createEventHub } from './events.js';
import { createLocks } from './lock.js';
import { createApiRouter } from './api.js';
import { serveStatic } from './static.js';

let exitHookInstalled = false;

export function createApplicationServer() {
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(coversDir, { recursive: true });
  fs.mkdirSync(waveformsDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });
  // 封面 / 波形 / 缩略图写入均用临时文件再改名；上次如果写到一半就退出，把残留清掉
  for (const dir of [coversDir, waveformsDir, thumbsDir]) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.tmp')) fs.unlink(path.join(dir, name), () => {});
    }
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
    // 项目页 / 看片页是真路径，服务端能查到所属项目名，分享卡片的标题才带得上
    serveStatic(req, res, url, config.publicDir, (pathname) => {
      const project = /^\/p\/([\w-]+)\/?$/.exec(pathname);
      if (project) return store.findProject(project[1])?.name || '';
      // 看片页只报项目名，不报片名
      const video = /^\/v\/([\w-]+)\/?$/.exec(pathname);
      if (video) {
        const projectId = store.findVideo(video[1])?.projectId;
        return (projectId && store.findProject(projectId)?.name) || '';
      }
      return '';
    });
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
