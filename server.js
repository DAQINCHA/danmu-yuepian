#!/usr/bin/env node
// 弹幕阅片 局域网服务器：静态站点（./public）+ 审片 API（/api/*）+ SSE 实时同步
// 零 npm 依赖，Node >= 18。  用法：node server.js   （PORT / HOST / DATA_DIR / MAX_UPLOAD_BYTES 见 README）
import { networkInterfaces } from 'node:os';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplicationServer } from './lib/app.js';
import { config, ROOT } from './lib/config.js';

export { createApplicationServer };

function lanAddresses() {
  const found = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (
        (item.family === 'IPv4' || item.family === 4)
        && !item.internal
        && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)
        && !found.includes(item.address)
      ) found.push(item.address);
    }
  }
  return found;
}

function startFromCommandLine() {
  const port = config.port;
  const host = config.host;
  const server = createApplicationServer();

  server.listen(port, host, () => {
    const bar = '='.repeat(60);
    const lines = [bar, '   弹幕阅片  DANMU YUEPIAN', bar, '', `  Node:    ${process.execPath}`, '', `  本机    http://127.0.0.1:${port}`];
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      for (const ip of lanAddresses().slice(0, 2)) lines.push(`  局域网  http://${ip}:${port}`);
    }
    const dataPath = relative(ROOT, config.dataDir);
    lines.push(`  数据    ${dataPath.startsWith('..') ? config.dataDir : dataPath}`);
    lines.push('', '  关闭这个窗口即停止服务。', '');
    console.log(lines.join('\n'));
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`端口 ${port} 已被占用：请关闭占用程序，或用 PORT=其它端口 node server.js`);
    else console.error(error);
    process.exit(1);
  });

  // 数据由 lib/app.js 注册的 exit 钩子落盘；SSE 长连接不会自己断，所以不等 server.close 回调
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startFromCommandLine();
