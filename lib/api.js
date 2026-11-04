import fs from 'node:fs';
import path from 'node:path';
import { config, uploadsDir, coversDir } from './config.js';
import { sendJson, sendError, readJsonBody, readRawBody, headerText } from './http.js';
import { mimeFor, PLAYABLE_EXT } from './mime.js';
import { saveRequestBody } from './upload.js';

const ID = '([0-9a-fA-F-]{8,40})';
// 640 宽的 JPEG 一般几十 KB，留一点余量挡住误传的大文件
const COVER_MAX_BYTES = 512 * 1024;

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 弹幕正文保留换行；行内空白仍收成一个空格，首尾空行去掉 */
function cleanMultiline(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
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

export function createApiRouter({ store, hub, locks }) {
  function videoOr404(id, res) {
    const video = store.findVideo(id);
    if (!video) sendError(res, 404, '视频不存在');
    return video;
  }

  const ipOf = (req) => String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  // 密码按原样取，不能像名字那样把空格收掉（密码里可能有空格）
  const secretOf = (value) => (typeof value === 'string' ? value : '').slice(0, 64);

  function lockedPayload(projectId) {
    const project = store.findProject(projectId);
    return {
      error: '这个项目需要密码',
      locked: true,
      projectId,
      projectName: project?.name || '',
      hint: locks.info(projectId).hint || '',
    };
  }

  /** 项目上锁、这次请求又没带通行证 → 403。返回 true 表示放行。 */
  function allowProject(req, res, projectId) {
    if (!projectId) return true;
    if (!locks.isLocked(projectId)) return true;
    if (locks.unlocked(req).has(projectId)) return true;
    sendJson(res, 403, lockedPayload(projectId));
    return false;
  }

  function allowVideo(req, res, video) {
    if (!video) return false;
    return allowProject(req, res, video.projectId || null);
  }

  /** 谁能看这个项目：没上锁的谁都能看，上锁的要有通行证 */
  function canSeeFactory(req) {
    const ticket = locks.unlocked(req);
    return (projectId) => !projectId || !locks.isLocked(projectId) || ticket.has(projectId);
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

  /** 视频文件是直链：拿到 id 就能下整支片，所以这里必须校验通行证 */
  function gateFile(req, res, id) {
    const video = store.findVideo(id);
    if (!video) return sendError(res, 404, '视频不存在');
    if (!allowVideo(req, res, video)) return;
    streamVideo(req, res, id);
  }

  function gateCover(req, res, id) {
    const video = store.findVideo(id);
    if (!video) {
      req.resume();
      return sendError(res, 404, '视频不存在');
    }
    if (!allowVideo(req, res, video)) {
      req.resume();
      return;
    }
    return writeCover(req, res, id);
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
    const newProjectName = cleanText(headerText(req, 'x-new-project-name'), 40);
    const projectHeader = cleanText(headerText(req, 'x-project-id'), 40);
    if (!newProjectName && projectHeader && projectHeader !== 'uncategorized') {
      if (!store.findProject(projectHeader)) {
        req.resume();
        return sendError(res, 400, '项目不存在');
      }
      // 传进锁着的项目，得先有那个项目的通行证
      if (!allowProject(req, res, projectHeader)) {
        req.resume();
        return;
      }
    }

    let saved;
    try {
      saved = await saveRequestBody(req, uploadsDir, ext, config.maxUploadBytes);
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }

    const duration = clampNumber(headerText(req, 'x-duration'), 0, 60 * 60 * 12);
    const fps = clampNumber(headerText(req, 'x-fps'), 1, 240) || 25;
    let projectId = null;
    if (newProjectName) {
      projectId = store.createProject(newProjectName).id;
    } else if (projectHeader && projectHeader !== 'uncategorized') {
      projectId = projectHeader;
      store.touchProject(projectId);
    }
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
      projectId,
      createdAt: Date.now(),
    });

    hub.broadcast('video:added', { video: publicVideo(video), projectId: video.projectId || null });
    sendJson(res, 201, { video: publicVideo(video) });
  }

  function coverPath(id) {
    return path.join(coversDir, `${id}.jpg`);
  }

  function coverReady(id) {
    if (!id) return false;
    try {
      return fs.statSync(coverPath(id)).size > 0;
    } catch {
      return false;
    }
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
      projectId: video.projectId || null,
      createdAt: video.createdAt,
      hasCover: coverReady(video.id),
    };
  }

  function publicProject(project, videos) {
    const mine = videos.filter((video) => video.projectId === project.id);
    const latest = mine.reduce((best, video) => (!best || video.createdAt > best.createdAt ? video : best), null);
    const latestAt = Math.max(project.updatedAt || 0, latest?.createdAt || 0);
    // 最终版已经不在项目里（正常流程不会发生，防手改库）就当没定过稿
    const final = project.finalVideoId
      ? mine.find((video) => video.id === project.finalVideoId) || null
      : null;
    const cover = final || latest;
    return {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      videoCount: mine.length,
      latestAt,
      finalVideoId: final?.id || null,
      finalAt: final ? project.finalAt || null : null,
      coverVideoId: cover?.id || null,
      hasCover: coverReady(cover?.id),
    };
  }

  /** 项目卡片 / 项目页要的那几个字段，再加锁的状态 */
  function withLock(project, videos, ticket) {
    const hasPassword = locks.isLocked(project.id);
    return {
      ...publicProject(project, videos),
      hasPassword,
      locked: hasPassword && !ticket.has(project.id),
      hint: hasPassword ? locks.info(project.id).hint || '' : '',
    };
  }

  function projectCatalog(req) {
    const videos = store.listVideos();
    const ticket = locks.unlocked(req);
    const projects = store.listProjects()
      .map((project) => withLock(project, videos, ticket))
      .sort((a, b) => b.latestAt - a.latestAt || b.createdAt - a.createdAt);
    const loose = videos.filter((video) => !video.projectId);
    const latestLoose = loose.reduce((best, video) => (!best || video.createdAt > best.createdAt ? video : best), null);
    return {
      projects,
      uncategorized: loose.length ? {
        videoCount: loose.length,
        latestAt: latestLoose.createdAt,
        coverVideoId: latestLoose.id,
        hasCover: coverReady(latestLoose.id),
      } : null,
    };
  }

  /**
   * 弹幕和画笔标注共用的回复接口：
   *   POST   /api/{comments|annotations}/:id/replies
   *   DELETE /api/{comments|annotations}/:id/replies/:replyId?author=署名
   * 增删后复用 {kind}:updated 推送整条，客户端整条替换 replies。
   */
  function replyRoutes(kind) {
    const isComment = kind === 'comment';
    const base = isComment ? 'comments' : 'annotations';
    const find = (id) => (isComment ? store.findComment(id) : store.findAnnotation(id));
    const missing = isComment ? '评论不存在' : '标注不存在';
    const noun = isComment ? '弹幕' : '画笔标注';

    return [
      [
        'POST',
        new RegExp(`^/api/${base}/${ID}/replies$`),
        async (req, res, id) => {
          const existing = find(id);
          if (!existing) return sendError(res, 404, missing);
          const owner = store.findVideo(existing.videoId);
          if (!allowVideo(req, res, owner)) return;
          const body = await readJsonBody(req, 64 * 1024);
          const text = cleanText(body.text, config.maxCommentLength);
          if (!text) return sendError(res, 400, '回复内容为空');
          const author = cleanText(body.author, 16);
          if (!author) return sendError(res, 400, '回复前必须填写你的名字');
          if (existing.replies.length >= config.maxReplies) {
            return sendError(res, 400, `这条${noun}的回复已达上限 ${config.maxReplies} 条`);
          }

          const { item, reply } = store.addReply(kind, id, { author, text });
          hub.broadcast(`${kind}:updated`, { [kind]: item, projectId: owner?.projectId || null });
          sendJson(res, 201, { [kind]: item, reply });
        },
      ],
      [
        'DELETE',
        new RegExp(`^/api/${base}/${ID}/replies/[0-9a-fA-F-]{8,40}$`),
        (req, res, id, url) => {
          const replyId = url.pathname.split('/').pop();
          const existing = find(id);
          if (!existing) return sendError(res, 404, missing);
          const owner = store.findVideo(existing.videoId);
          if (!allowVideo(req, res, owner)) return;
          const reply = existing.replies.find((r) => r.id === replyId);
          if (!reply) return sendError(res, 404, '回复不存在');
          // 没有登录体系，只按署名核对：只能删自己署名的回复
          const author = cleanText(url.searchParams.get('author') || '', 16);
          if (author !== reply.author) return sendError(res, 403, '只能删除自己的回复');

          const item = store.deleteReply(kind, id, replyId);
          hub.broadcast(`${kind}:updated`, { [kind]: item, projectId: owner?.projectId || null });
          sendJson(res, 200, { [kind]: item });
        },
      ],
    ];
  }

  function coverEtag(stat) {
    const mtime = Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : 0;
    return `"${stat.size.toString(16)}-${mtime.toString(16)}"`;
  }

  function coverNotModified(req, stat, etag) {
    const inm = req.headers['if-none-match'];
    if (inm) {
      return inm.split(',').some((part) => {
        const token = part.trim().replace(/^W\//i, '');
        return token === '*' || token === etag;
      });
    }
    const since = Date.parse(req.headers['if-modified-since'] || '');
    return Number.isFinite(since) && stat.mtimeMs <= since + 1000;
  }

  function looksLikeJpeg(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 64) return false;
    if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return false;
    const start = Math.max(0, buf.length - 16);
    for (let i = buf.length - 2; i >= start; i -= 1) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd9) return true;
    }
    return false;
  }

  /** 同一卷上改名是原子的。Windows 上目标已存在会失败，这时沿用先写进去的那张。 */
  function placeCover(tmp, file) {
    try {
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'EPERM') throw err;
      try {
        if (fs.statSync(file).size > 0) return false;
      } catch { /* 目标还不在 */ }
      try { fs.unlinkSync(file); } catch { /* 清掉空文件再改名 */ }
      fs.renameSync(tmp, file);
      return true;
    }
  }

  function readCover(req, res, id) {
    if (!videoOr404(id, res)) return;
    fs.stat(coverPath(id), (err, stat) => {
      if (err || !stat.isFile() || stat.size <= 0) return sendError(res, 404, '还没有封面');
      const etag = coverEtag(stat);
      const cache = 'public, max-age=31536000, immutable';
      if (coverNotModified(req, stat, etag)) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': cache });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': stat.size,
        'Cache-Control': cache,
        ETag: etag,
        'Last-Modified': stat.mtime.toUTCString(),
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(coverPath(id));
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
  }

  async function writeCover(req, res, id) {
    if (!store.findVideo(id)) {
      req.resume();
      return sendError(res, 404, '视频不存在');
    }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'image/jpeg') {
      req.resume();
      return sendError(res, 415, '封面只接受 JPEG');
    }
    const file = coverPath(id);
    if (coverReady(id)) {
      req.resume();
      return sendJson(res, 200, { ok: true, stored: false });
    }

    const buf = await readRawBody(req, COVER_MAX_BYTES);
    if (!looksLikeJpeg(buf)) return sendError(res, 400, '不是有效的 JPEG');

    fs.mkdirSync(coversDir, { recursive: true });
    const tmp = path.join(coversDir, `${id}.${process.pid}.${Date.now()}.tmp`);
    let stored = true;
    try {
      fs.writeFileSync(tmp, buf);
      stored = placeCover(tmp, file);
    } finally {
      fs.unlink(tmp, () => {});
    }
    sendJson(res, stored ? 201 : 200, { ok: true, stored });
  }

  const routes = [
    [
      'GET',
      /^\/api\/health$/,
      (req, res) => sendJson(res, 200, { ok: true, groupName: config.groupName, ...store.stats() }),
    ],
    [
      'GET',
      /^\/api\/config$/,
      (req, res) => sendJson(res, 200, { groupName: config.groupName, title: config.siteTitle }),
    ],
    [
      'GET',
      /^\/api\/projects$/,
      (req, res) => sendJson(res, 200, projectCatalog(req)),
    ],
    [
      'POST',
      /^\/api\/projects$/,
      async (req, res) => {
        const body = await readJsonBody(req, 4096);
        const name = cleanText(body.name, 40);
        if (!name) return sendError(res, 400, '项目名称不能为空');
        const password = secretOf(body.password);
        if (password && (password.length < 4 || password.length > 64)) {
          return sendError(res, 400, '密码要 4–64 位');
        }
        const project = store.createProject(name);
        if (password) {
          locks.set(project.id, {
            name,
            password,
            hint: cleanText(body.hint, 60),
            setBy: cleanText(body.setBy, 16),
          });
          // 刚上锁就发通行证，不然创建的人自己反而进不去
          locks.grant(req, res, project.id);
        }
        hub.broadcast('projects:changed', {});
        // 刚发的通行证还没回到请求里，手动算一份，不然前端会以为创建失败
        const ticket = locks.unlocked(req);
        ticket.set(project.id, 1);
        sendJson(res, 201, { project: withLock(project, store.listVideos(), ticket) });
      },
    ],
    [
      'POST',
      new RegExp(`^/api/projects/${ID}/unlock$`),
      async (req, res, id) => {
        const project = store.findProject(id);
        if (!project) return sendError(res, 404, '项目不存在');
        if (!locks.isLocked(id)) {
          return sendJson(res, 200, { ok: true, expiresAt: locks.grant(req, res, id) });
        }
        const ip = ipOf(req);
        const gate = locks.throttle(ip, id);
        if (gate.blocked) return sendError(res, 429, `密码错太多次，请等 ${gate.wait} 秒再试`);

        const body = await readJsonBody(req, 4096);
        const password = secretOf(body.password);
        if (!password) return sendError(res, 400, '请输入密码');
        if (!locks.verify(id, password)) {
          const remaining = locks.noteFail(ip, id);
          return sendJson(res, 403, { error: '密码不对', locked: true, projectId: id, remaining });
        }
        locks.noteOk(ip, id);
        sendJson(res, 200, { ok: true, expiresAt: locks.grant(req, res, id) });
      },
    ],
    [
      'POST',
      new RegExp(`^/api/projects/${ID}/password$`),
      async (req, res, id) => {
        const project = store.findProject(id);
        if (!project) return sendError(res, 404, '项目不存在');
        const body = await readJsonBody(req, 4096);

        // 已经上锁的：改密码 / 取消密码都要先验当前密码
        if (locks.isLocked(id)) {
          const ip = ipOf(req);
          const gate = locks.throttle(ip, id);
          if (gate.blocked) return sendError(res, 429, `密码错太多次，请等 ${gate.wait} 秒再试`);
          const current = secretOf(body.currentPassword);
          if (!current) return sendError(res, 400, '请输入当前密码');
          if (!locks.verify(id, current)) {
            const remaining = locks.noteFail(ip, id);
            return sendJson(res, 403, { error: '当前密码不对', remaining });
          }
          locks.noteOk(ip, id);
        }

        const password = secretOf(body.password);
        if (password && (password.length < 4 || password.length > 64)) {
          return sendError(res, 400, '密码要 4–64 位');
        }
        locks.set(id, {
          name: project.name,
          password,
          hint: cleanText(body.hint, 60),
          setBy: cleanText(body.setBy, 16),
        });
        if (password) locks.grant(req, res, id);
        else locks.revoke(req, res, id);
        hub.broadcast('projects:changed', {});
        const ticket = locks.unlocked(req);
        if (password) ticket.set(id, 1);
        sendJson(res, 200, {
          project: withLock(store.findProject(id), store.listVideos(), ticket),
        });
      },
    ],
    [
      'PATCH',
      new RegExp(`^/api/projects/${ID}$`),
      async (req, res, id) => {
        if (!store.findProject(id)) return sendError(res, 404, '项目不存在');
        if (!allowProject(req, res, id)) return;
        const body = await readJsonBody(req, 4096);
        if (body.name !== undefined) {
          const name = cleanText(body.name, 40);
          if (!name) return sendError(res, 400, '项目名称不能为空');
          store.renameProject(id, name);
          locks.rename(id, name);
        }
        // 定稿：finalVideoId = 项目里某一版的 id；null / 空串取消
        if (body.finalVideoId !== undefined) {
          const raw = body.finalVideoId;
          if (raw === null || raw === '') {
            store.setProjectFinal(id, null);
          } else {
            const videoId = cleanText(String(raw), 40);
            const video = store.findVideo(videoId);
            if (!video) return sendError(res, 404, '视频不存在');
            if ((video.projectId || null) !== id) return sendError(res, 400, '这个版本不在该项目里');
            store.setProjectFinal(id, video.id);
          }
        }
        hub.broadcast('projects:changed', {});
        sendJson(res, 200, {
          project: withLock(store.findProject(id), store.listVideos(), locks.unlocked(req)),
        });
      },
    ],
    [
      'DELETE',
      new RegExp(`^/api/projects/${ID}$`),
      async (req, res, id) => {
        const project = store.findProject(id);
        if (!project) return sendError(res, 404, '项目不存在');
        // 删除会把片子退回未分类（= 自动解锁），所以即使刚进来也要再输一次密码
        if (locks.isLocked(id)) {
          const ip = ipOf(req);
          const gate = locks.throttle(ip, id);
          if (gate.blocked) return sendError(res, 429, `密码错太多次，请等 ${gate.wait} 秒再试`);
          const body = await readJsonBody(req, 4096);
          const password = secretOf(body.password);
          if (!password) return sendError(res, 400, '删除加锁的项目要输入密码');
          if (!locks.verify(id, password)) {
            const remaining = locks.noteFail(ip, id);
            return sendJson(res, 403, { error: '密码不对', remaining });
          }
          locks.noteOk(ip, id);
        }
        const result = store.deleteProject(id);
        locks.remove(id);
        hub.broadcast('projects:changed', {});
        sendJson(res, 200, { ok: true, moved: result.moved });
      },
    ],
    [
      'GET',
      /^\/api\/videos$/,
      (req, res) => {
        const canSee = canSeeFactory(req);
        sendJson(res, 200, {
          videos: store.listVideos().filter((video) => canSee(video.projectId)).map(publicVideo),
        });
      },
    ],
    ['POST', /^\/api\/videos$/, createVideo],
    [
      'GET',
      new RegExp(`^/api/videos/${ID}$`),
      (req, res, id) => {
        const video = videoOr404(id, res);
        if (!video) return;
        if (!allowVideo(req, res, video)) return;
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
        if (!allowVideo(req, res, video)) return;
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
        // 改名只改显示名称 video.title；id（UUID）、文件名、链接都不动
        if (body.title != null) {
          const title = cleanText(body.title, 80);
          if (!title) return sendError(res, 400, '名称不能为空');
          patch.title = title;
        }
        if (body.projectId !== undefined) {
          const raw = body.projectId;
          if (raw === null || raw === '' || raw === 'uncategorized') patch.projectId = null;
          else {
            const projectId = cleanText(String(raw), 40);
            if (!store.findProject(projectId)) return sendError(res, 400, '项目不存在');
            // 移进锁着的项目也要目标项目的通行证
            if (!allowProject(req, res, projectId)) return;
            patch.projectId = projectId;
          }
        }
        const prevProject = video.projectId || null;
        store.updateVideo(id, patch);
        if (patch.projectId !== undefined && patch.projectId !== prevProject) {
          if (patch.projectId) store.touchProject(patch.projectId);
          if (prevProject) {
            store.touchProject(prevProject);
            // 移走的是最终版：摘掉原项目的定稿标记
            if (store.clearProjectFinal(prevProject, id)) hub.broadcast('projects:changed', {});
          }
        }
        const updated = publicVideo(store.findVideo(id));
        if ((patch.title && patch.title !== video.title) || patch.projectId !== undefined) {
          hub.broadcast('video:updated', { video: updated, projectId: updated.projectId || null });
        }
        sendJson(res, 200, { video: updated });
      },
    ],
    [
      'DELETE',
      new RegExp(`^/api/videos/${ID}$`),
      (req, res, id) => {
        const video = videoOr404(id, res);
        if (!video) return;
        if (!allowVideo(req, res, video)) return;
        store.deleteVideo(id);
        fs.unlink(path.join(uploadsDir, video.file), () => {});
        fs.unlink(coverPath(id), () => {});
        hub.broadcast('video:removed', { videoId: id, projectId: video.projectId || null });
        // 删的是最终版时顺手把项目的定稿标记摘掉，别让卡片挂着死链接
        if (video.projectId && store.clearProjectFinal(video.projectId, id)) {
          hub.broadcast('projects:changed', {});
        }
        sendJson(res, 200, { ok: true });
      },
    ],
    ['GET', new RegExp(`^/api/videos/${ID}/file$`), gateFile],
    ['HEAD', new RegExp(`^/api/videos/${ID}/file$`), gateFile],
    // 封面不校验：锁着的项目在首页也要显示封面（代价是露了片子的一帧）
    ['GET', new RegExp(`^/api/videos/${ID}/cover$`), readCover],
    ['HEAD', new RegExp(`^/api/videos/${ID}/cover$`), readCover],
    ['PUT', new RegExp(`^/api/videos/${ID}/cover$`), gateCover],
    [
      'POST',
      new RegExp(`^/api/videos/${ID}/comments$`),
      async (req, res, id) => {
        const video = videoOr404(id, res);
        if (!video) return;
        if (!allowVideo(req, res, video)) return;
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
        hub.broadcast('comment:new', { comment, projectId: video.projectId || null });
        sendJson(res, 201, { comment });
      },
    ],
    [
      'PATCH',
      new RegExp(`^/api/comments/${ID}$`),
      async (req, res, id) => {
        const current = store.findComment(id);
        if (!current) return sendError(res, 404, '评论不存在');
        const owner = store.findVideo(current.videoId);
        if (!allowVideo(req, res, owner)) return;
        const body = await readJsonBody(req, 64 * 1024);
        const patch = {};
        if (body.done !== undefined) {
          if (typeof body.done !== 'boolean') return sendError(res, 400, 'done 字段无效');
          patch.done = body.done;
        }
        // 改弹幕文字：没有登录体系，只按署名核对，只能改自己署名的弹幕
        if (body.text !== undefined) {
          const author = cleanText(body.author, 16);
          if (!author || author !== current.author) return sendError(res, 403, '只能修改自己的弹幕');
          const text = cleanMultiline(body.text, config.maxCommentLength);
          if (!text) return sendError(res, 400, '弹幕内容为空');
          if (text !== current.text) {
            patch.text = text;
            patch.editedAt = Date.now();
          }
        }
        if (!Object.keys(patch).length) {
          if (body.text !== undefined) return sendJson(res, 200, { comment: current });
          return sendError(res, 400, '没有要修改的字段');
        }
        const comment = store.updateComment(id, patch);
        hub.broadcast('comment:updated', { comment, projectId: owner?.projectId || null });
        sendJson(res, 200, { comment });
      },
    ],
    [
      'DELETE',
      new RegExp(`^/api/comments/${ID}$`),
      (req, res, id) => {
        const comment = store.findComment(id);
        if (!comment) return sendError(res, 404, '评论不存在');
        const owner = store.findVideo(comment.videoId);
        if (!allowVideo(req, res, owner)) return;
        store.deleteComment(id);
        hub.broadcast('comment:removed', {
          commentId: id,
          videoId: comment.videoId,
          projectId: owner?.projectId || null,
        });
        sendJson(res, 200, { ok: true });
      },
    ],
    ...replyRoutes('comment'),
    ...replyRoutes('annotation'),
    [
      'POST',
      new RegExp(`^/api/videos/${ID}/annotations$`),
      async (req, res, id) => {
        const video = videoOr404(id, res);
        if (!video) return;
        if (!allowVideo(req, res, video)) return;
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
        hub.broadcast('annotation:new', { annotation, projectId: video.projectId || null });
        sendJson(res, 201, { annotation });
      },
    ],
    [
      'PATCH',
      new RegExp(`^/api/annotations/${ID}$`),
      async (req, res, id) => {
        const current = store.findAnnotation(id);
        if (!current) return sendError(res, 404, '标注不存在');
        const owner = store.findVideo(current.videoId);
        if (!allowVideo(req, res, owner)) return;
        const body = await readJsonBody(req, 4096);
        const patch = {};
        if (body.done !== undefined) {
          if (typeof body.done !== 'boolean') return sendError(res, 400, 'done 字段无效');
          patch.done = body.done;
        }
        // 在时间轴上拖入点/出点改持续时间。和删除、标记已改一样不校验作者（没有登录体系）
        if (body.start !== undefined || body.end !== undefined) {
          const raw = (v, fallback) => (v === undefined ? fallback : v);
          const startRaw = raw(body.start, current.start);
          const endRaw = raw(body.end, current.end);
          if (typeof startRaw !== 'number' || typeof endRaw !== 'number') {
            return sendError(res, 400, '入点/出点必须是数字');
          }
          if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw) || startRaw < 0) {
            return sendError(res, 400, '帧区间无效');
          }
          const video = store.findVideo(current.videoId);
          const limit = video?.duration ? video.duration + 0.5 : 60 * 60 * 12;
          if (endRaw <= startRaw || endRaw > limit) return sendError(res, 400, '帧区间无效');
          if (endRaw - startRaw > config.maxAnnotationSpan + 0.001) {
            return sendError(res, 400, `标注区间不能超过 ${config.maxAnnotationSpan} 秒`);
          }
          patch.start = startRaw;
          patch.end = endRaw;
        }
        if (!Object.keys(patch).length) return sendError(res, 400, '没有要修改的字段');
        const annotation = store.updateAnnotation(id, patch);
        hub.broadcast('annotation:updated', { annotation, projectId: owner?.projectId || null });
        sendJson(res, 200, { annotation });
      },
    ],
    [
      'DELETE',
      new RegExp(`^/api/annotations/${ID}$`),
      (req, res, id) => {
        const annotation = store.findAnnotation(id);
        if (!annotation) return sendError(res, 404, '标注不存在');
        const owner = store.findVideo(annotation.videoId);
        if (!allowVideo(req, res, owner)) return;
        store.deleteAnnotation(id);
        hub.broadcast('annotation:removed', {
          annotationId: id,
          videoId: annotation.videoId,
          projectId: owner?.projectId || null,
        });
        sendJson(res, 200, { ok: true });
      },
    ],
    [
      'GET',
      /^\/api\/events$/,
      (req, res, _id, url) => {
        const videoId = url.searchParams.get('video') || '';
        if (videoId) {
          const video = store.findVideo(videoId);
          if (!allowVideo(req, res, video)) return;
        }
        hub.handle(req, res, videoId, canSeeFactory(req));
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
