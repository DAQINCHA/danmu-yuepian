import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * 把请求体整段落到磁盘。前端用 XHR 直接把 File 作为 body 发上来，
 * 比在原生 Node 里手写 multipart 解析干净得多。
 */
export function saveRequestBody(req, destDir, ext, maxBytes) {
  const id = randomUUID();
  const dest = path.join(destDir, `${id}${ext}`);

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    let size = 0;
    let failed = false;

    const fail = (err) => {
      if (failed) return;
      failed = true;
      req.destroy();
      out.destroy();
      fs.unlink(dest, () => {});
      reject(err);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(Object.assign(new Error('视频超过大小上限'), { status: 413 }));
      }
    });
    req.on('aborted', () => fail(Object.assign(new Error('上传被中断'), { status: 499 })));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      if (size === 0) {
        fs.unlink(dest, () => {});
        reject(Object.assign(new Error('空文件'), { status: 400 }));
        return;
      }
      resolve({ id, file: `${id}${ext}`, size });
    });

    req.pipe(out);
  });
}
