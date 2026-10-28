import fs from 'node:fs';
import path from 'node:path';
import { config, uploadsDir } from './config.js';
import { sendJson, sendError, readJsonBody, headerText } from './http.js';
import { mimeFor, PLAYABLE_EXT } from './mime.js';
import { saveRequestBody } from './upload.js';

const ID = '([0-9a-fA-F-]{8,40})';

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 归一化画笔数据：坐标一律 0~1，宽高按视频宽度等比缩放 */
function cleanStrokes(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  let budget = 20000;
  const strokes = [];

  for (const raw of input.slice(0, 300)) {
    if (!raw || !Array.isArray(raw.points) || raw.points.length < 2) continue;
    const points = [];
    for (const point of raw.points) {
      if (budget <= 0) break;
      if (!Array.isArray(point) || point.length < 2) continue;
      const x = clampNumber(point[0], 0, 1);
      const y = clampNumber(point[1], 0, 1);
      if (x === null || y === null) continue;
      points.push([Number(x.toFixed(5)), Number(y.toFixed(5))]);
      budget -= 1;
    }
    if (points.length < 2) continue;
    strokes.push({
      color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '#ff5a4d',
      width: clampNumber(raw.width, 0.001, 0.03) || 0.004,
      points,
    });
  }

  return strokes.length ? strokes : null;
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { invalid: true };
  }
  return { start, end };
}

export function createApiRouter({ store, hub }) {
  function videoOr404(id, res) {
    const video = store.findVideo(id);
    if (!video) sendError(res, 404, '视频不存在');
    return video;
  }

  function streamVideo(req, res, id) {
    const video = videoOr404(id, res);
    if (!video) return;
    const file = path.join(uploadsDir, video.file);

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return sendError(res, 410, '视频文件已丢失，请重新上传');

      const type = mimeFor(file);
      const range = parseRange(req.headers.range, stat.size);

      if (range?.invalid) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }

      if (range) {
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': range.end - range.start + 1,
          'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        });
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(file, { start: range.start, end: range.end });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }

      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
  }

  async function createVideo(req, res) {
    const originalName = headerText(req, 'x-filename');
    const ext = path.extname(originalName).toLowerCase();
    if (!PLAYABLE_EXT.has(ext)) {
      return sendError(res, 415, `不支持的格式 ${ext || '(无扩展名)'}，请上传 mp4 / webm / mov`);
    }
    // 上传者必须署名，否则整份报告的「谁提的」就断了
    const uploader = cleanText(headerText(req, 'x-uploader'), 16);
    if (!uploader) return sendError(res, 400, '上传前必须填写你的名字');

    let saved;
    try {
      saved = await saveRequestBody(req, uploadsDir, ext, config.maxUploadBytes);
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }

    const duration = clampNumber(headerText(req, 'x-duration'), 0, 60 * 60 * 12);
    const fps = clampNumber(headerText(req, 'x-fps'), 1, 240) || 25;
    const video = store.insertVideo({
      id: saved.id,
      title: cleanText(headerText(req, 'x-title'), 80) || path.basename(originalName, ext) || '未命名影片',
      originalName: originalName || `${saved.id}${ext}`,
      file: saved.file,
      size: saved.size,
      duration: duration || null,
      fps,
      fpsSource: 'default',
      uploader,
      createdAt: Date.now(),
    });

    hub.broadcast('video:added', { video: publicVideo(video) });
    sendJson(res, 201, { video: publicVideo(video) });
  }

  function publicVideo(video) {
    return {
      id: video.id,
      title: video.title,
      duration: video.duration,
      fps: video.fps,
      fpsSource: video.fpsSource || 'default',
      size: video.size,
      uploader: video.uploader,
      createdAt: video.createdAt,
    };
  }

  const routes = [
    [
      'GET',
      /^\/api\/health$/,
      (req, res) => sendJson(res, 200, { ok: true, ...store.stats() }),
    ],
    [
      'GET',
      /^\/api\/videos$/,
      (req, res) => sendJson(res, 200, { videos: store.listVideos().map(publicVideo) }),
    ],
    ['POST', /^\/api\/videos$/, createVideo],
    [
      'GET',
      new RegExp(`^/api/videos/${ID}$`),
      (req, res, id) => {
        const video = videoOr404(id, res);
        if (!video) return;
        sendJson(res, 200, {
          video: publicVideo(video),
          comments: store.listComments(id),
          annotations: store.listAnnotations(id),
          viewers: hub.count(id),
        });
      },
    ],
    [
      'PATCH',
      new RegExp(`^/api/videos/${ID}$`),
      async (req, res, id) => {
        const video = videoOr404(id, res);
        if (!video) return;
        const body = await readJsonBody(req, 4096);
        const patch = {};
        if (body.duration != null) {
          const duration = clampNumber(body.duration, 0, 60 * 60 * 12);
          if (duration) patch.duration = duration;
        }
        if (body.fps != null) {
          const fps = clampNumber(body.fps, 1, 240);
          if (fps) patch.fps = fps;
        }
        // auto = 客户端从视频里量出来的，manual = 用户手改过；
        // manual 之后不再被自动识别覆盖
        if (['auto', 'manual', 'default'].includes(body.fpsSource)) {
          patch.fpsSource = body.fpsSource;
        }
        if (typeof body.title === 'string') patch.title = cleanText(body.title, 80) || video.title;
        store.updateVideo(id, patch);
        sendJson(res, 200, { video: publicVideo(store.findVideo(id)) });
      },
    ],
    [
      'DELETE',
      new RegExp(`^/api/videos/${ID}$`),
      (req, res, id) => {
        const video = videoOr404(id, res);
        if (!video) return;
        store.deleteVideo(id);
        fs.unlink(path.join(uploadsDir, video.file), () => {});
        hub.broadcast('video:removed', { videoId: id });
        sendJson(res, 200, { ok: true });
      },
    ],
    ['GET', new RegExp(`^/api/videos/${ID}/file$`), streamVideo],
    ['HEAD', new RegExp(`^/api/videos/${ID}/file$`), streamVideo],
    [
      'POST',
      new RegExp(`^/api/videos/${ID}/comments$`),
      async (req, res, id) => {
        if (!videoOr404(id, res)) return;
        const body = await readJsonBody(req, 64 * 1024);
        const text = cleanText(body.text, config.maxCommentLength);
        if (!text) return sendError(res, 400, '评论内容为空');
        const author = cleanText(body.author, 16);
        if (!author) return sendError(res, 400, '发弹幕前必须填写你的名字');
        const time = clampNumber(body.time, 0, 60 * 60 * 12);
        if (time === null) return sendError(res, 400, '时间点无效');

        const comment = store.insertComment({
          videoId: id,
          time,
          text,
          author,
          done: false,
          color: /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : '#8ab4ff',
        });
        hub.broadcast('comment:new', { comment });
        sendJson(res, 201, { comment });
      },
    ],
    [
      'PATCH',
      new RegExp(`^/api/comments/${ID}$`),
      async (req, res, id) => {
        if (!store.findComment(id)) return sendError(res, 404, '评论不存在');
        const body = await readJsonBody(req, 4096);
        if (typeof body.done !== 'boolean') return sendError(res, 400, '缺少 done 字段');
        const comment = store.updateComment(id, { done: body.done });
        hub.broadcast('comment:updated', { comment });
        sendJson(res, 200, { comment });
      },
    ],
    [
      'DELETE',
      new RegExp(`^/api/comments/${ID}$`),
      (req, res, id) => {
        const comment = store.findComment(id);
        if (!comment) return sendError(res, 404, '评论不存在');
        store.deleteComment(id);
        hub.broadcast('comment:removed', { commentId: id, videoId: comment.videoId });
        sendJson(res, 200, { ok: true });
      },
    ],
    [
      'POST',
      new RegExp(`^/api/comments/${ID}/replies$`),
      async (req, res, id) => {
        const existing = store.findComment(id);
        if (!existing) return sendError(res, 404, '评论不存在');
        const body = await readJsonBody(req, 64 * 1024);
        const text = cleanText(body.text, config.maxCommentLength);
        if (!text) return sendError(res, 400, '回复内容为空');
        const author = cleanText(body.author, 16);
        if (!author) return sendError(res, 400, '回复前必须填写你的名字');
        if (existing.replies.length >= config.maxReplies) {
          return sendError(res, 400, `这条弹幕的回复已达上限 ${config.maxReplies} 条`);
        }

        const { comment, reply } = store.addReply(id, { author, text });
        // 复用 comment:updated，客户端整条替换 replies，其他人实时看到
        hub.broadcast('comment:updated', { comment });
        sendJson(res, 201, { comment, reply });
      },
    ],
    [
      'DELETE',
      new RegExp(`^/api/comments/${ID}/replies/[0-9a-fA-F-]{8,40}$`),
      (req, res, id, url) => {
        const replyId = url.pathname.split('/').pop();
        const existing = store.findComment(id);
        if (!existing) return sendError(res, 404, '评论不存在');
        const reply = existing.replies.find((r) => r.id === replyId);
        if (!reply) return sendError(res, 404, '回复不存在');
        // 没有登录体系，只按署名核对：只能删自己署名的回复
        const author = cleanText(url.searchParams.get('author') || '', 16);
        if (author !== reply.author) return sendError(res, 403, '只能删除自己的回复');

        const comment = store.deleteReply(id, replyId);
        hub.broadcast('comment:updated', { comment });
        sendJson(res, 200, { comment });
      },
    ],
    [
      'POST',
      new RegExp(`^/api/videos/${ID}/annotations$`),
      async (req, res, id) => {
        if (!videoOr404(id, res)) return;
        const body = await readJsonBody(req, 2 * 1024 * 1024);
        const strokes = cleanStrokes(body.strokes);
        if (!strokes) return sendError(res, 400, '没有可保存的笔迹');

        const start = clampNumber(body.start, 0, 60 * 60 * 12);
        const end = clampNumber(body.end, 0, 60 * 60 * 12);
        if (start === null || end === null || end <= start) return sendError(res, 400, '帧区间无效');
        if (end - start > config.maxAnnotationSpan) {
          return sendError(res, 400, `标注区间不能超过 ${config.maxAnnotationSpan} 秒`);
        }
        const author = cleanText(body.author, 16);
        if (!author) return sendError(res, 400, '画标注前必须填写你的名字');

        const annotation = store.insertAnnotation({
          videoId: id,
          start,
          end,
          strokes,
          author,
          done: false,
          createdAt: Date.now(),
        });
        hub.broadcast('annotation:new', { annotation });
        sendJson(res, 201, { annotation });
      },
    ],
    [
      'PATCH',
      new RegExp(`^/api/annotations/${ID}$`),
      async (req, res, id) => {
        if (!store.findAnnotation(id)) return sendError(res, 404, '标注不存在');
        const body = await readJsonBody(req, 4096);
        if (typeof body.done !== 'boolean') return sendError(res, 400, '缺少 done 字段');
        const annotation = store.updateAnnotation(id, { done: body.done });
        hub.broadcast('annotation:updated', { annotation });
        sendJson(res, 200, { annotation });
      },
    ],
    [
      'DELETE',
      new RegExp(`^/api/annotations/${ID}$`),
      (req, res, id) => {
        const annotation = store.findAnnotation(id);
        if (!annotation) return sendError(res, 404, '标注不存在');
        store.deleteAnnotation(id);
        hub.broadcast('annotation:removed', { annotationId: id, videoId: annotation.videoId });
        sendJson(res, 200, { ok: true });
      },
    ],
    [
      'GET',
      /^\/api\/events$/,
      (req, res, _id, url) => {
        const videoId = url.searchParams.get('video') || '';
        hub.handle(req, res, videoId);
      },
    ],
  ];

  return async function route(req, res, url) {
    const pathname = url.pathname;
    let pathMatched = false;

    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (method !== req.method) continue;
      try {
        await handler(req, res, match[1], url);
      } catch (err) {
        if (res.writableEnded || res.destroyed) return;
        sendError(res, err.status || 500, err.message || '服务端错误');
      }
      return;
    }

    if (pathMatched) return sendError(res, 405, '方法不允许');
    sendError(res, 404, '接口不存在');
  };
}
