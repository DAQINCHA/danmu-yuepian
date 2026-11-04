import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 项目密码。没有账号体系，所以只有一把锁：进项目要密码，进了以后发一张通行证（Cookie）。
 *
 * 密码是**明文**存在 data/project-locks.json 里的 —— 这是有意的：忘了密码就打开那个文件
 * 看一眼，或者直接把某条记录改掉 / 删掉，保存即生效，不用重启服务。
 * 谁能读那个文件，谁就能看 data/uploads 里的所有视频，所以这条边界并没有变宽。
 */

const COOKIE = 'dy_lock';
const TICKET_VERSION = 1;
// 错几次开始冷却
const FREE_TRIES = 5;

/** 先各自 sha256 再定长比较：长度不同不会抛错，耗时上也漏不出密码长度 */
function sameSecret(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

export function createLocks({ file, keyFile, days = 7 }) {
  // 缓存按文件 mtime 失效：既不用每个请求都重读，又能让手工改文件立刻生效
  let cache = { mtimeMs: -1, size: -1, projects: {} };
  let key = null;
  // 失败计数按「IP + 项目」记，重启清零，内部工具够用
  const fails = new Map();

  function snapshot() {
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      if (cache.mtimeMs !== -1) cache = { mtimeMs: -1, size: -1, projects: {} };
      return cache.projects;
    }
    if (stat.mtimeMs === cache.mtimeMs && stat.size === cache.size) return cache.projects;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const projects = parsed && typeof parsed.projects === 'object' && parsed.projects ? parsed.projects : {};
      cache = { mtimeMs: stat.mtimeMs, size: stat.size, projects };
    } catch (err) {
      // 文件被改坏了：沿用上一份读成功的，别把所有人锁在门外
      console.warn(`[lock] 读取 ${file} 失败，沿用上一次的内容：${err.message}`);
      cache = { ...cache, mtimeMs: stat.mtimeMs, size: stat.size };
    }
    return cache.projects;
  }

  function save(projects) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2));
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* 有些文件系统不支持，不影响功能 */
    }
    fs.renameSync(tmp, file);
    // 让下一次 snapshot 重新读一遍，别和刚写的这份对不上
    cache = { mtimeMs: -1, size: -1, projects };
  }

  function recordOf(projectId) {
    return snapshot()[projectId] || null;
  }

  function isLocked(projectId) {
    const rec = recordOf(projectId);
    return Boolean(rec && typeof rec.password === 'string' && rec.password);
  }

  function info(projectId) {
    const rec = recordOf(projectId);
    if (!rec || !rec.password) return { locked: false, hint: '' };
    return { locked: true, hint: typeof rec.hint === 'string' ? rec.hint : '' };
  }

  /** 没上锁的项目一律放行；上锁的比密码 */
  function verify(projectId, password) {
    const rec = recordOf(projectId);
    if (!rec || !rec.password) return true;
    return sameSecret(rec.password, password ?? '');
  }

  /** password 为空就是取消密码（整条记录删掉） */
  function set(projectId, { name, password, hint, setBy }) {
    const projects = { ...snapshot() };
    if (!password) delete projects[projectId];
    else {
      projects[projectId] = {
        name: String(name || '').slice(0, 40),
        password,
        hint: hint ? String(hint).slice(0, 60) : '',
        setBy: setBy ? String(setBy).slice(0, 16) : '',
        updatedAt: Date.now(),
      };
    }
    save(projects);
    return projects[projectId] || null;
  }

  function remove(projectId) {
    const projects = { ...snapshot() };
    if (!projects[projectId]) return false;
    delete projects[projectId];
    save(projects);
    return true;
  }

  /** 项目改名时把文件里的 name 同步过去，方便你在文件里认项目 */
  function rename(projectId, name) {
    const projects = snapshot();
    const rec = projects[projectId];
    if (!rec || rec.name === name) return;
    save({ ...projects, [projectId]: { ...rec, name: String(name).slice(0, 40) } });
  }

  /* ── 通行证 ──────────────────────────────────────────────────────── */

  function sessionKey() {
    if (key) return key;
    try {
      const raw = fs.readFileSync(keyFile);
      if (raw.length >= 32) return (key = raw);
    } catch {
      /* 还没生成过 */
    }
    const fresh = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    try {
      fs.writeFileSync(keyFile, fresh, { flag: 'wx', mode: 0o600 });
      key = fresh;
    } catch {
      // 另一个进程抢先写了，用它的
      key = fs.readFileSync(keyFile);
    }
    return key;
  }

  function sign(payload) {
    return crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');
  }

  /** 读出这次请求带的通行证：Map<projectId, 到期毫秒>，过期的顺手丢掉 */
  function unlocked(req) {
    const value = readCookie(req, COOKIE);
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return new Map();
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const expect = sign(payload);
    if (sig.length !== expect.length) return new Map();
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return new Map();
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const map = new Map();
      const now = Date.now();
      for (const [id, exp] of Object.entries(data?.p || {})) {
        if (Number(exp) > now) map.set(id, Number(exp));
      }
      return map;
    } catch {
      return new Map();
    }
  }

  function writeTicket(res, map) {
    const p = {};
    for (const [id, exp] of map) p[id] = exp;
    const payload = Buffer.from(JSON.stringify({ v: TICKET_VERSION, p }), 'utf8').toString('base64url');
    const value = `${payload}.${sign(payload)}`;
    const maxAge = map.size ? days * 86400 : 0;
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
  }

  function grant(req, res, projectId) {
    const map = unlocked(req);
    const expiresAt = Date.now() + days * 86400000;
    map.set(projectId, expiresAt);
    writeTicket(res, map);
    return expiresAt;
  }

  function revoke(req, res, projectId) {
    const map = unlocked(req);
    map.delete(projectId);
    writeTicket(res, map);
  }

  /* ── 限速 ────────────────────────────────────────────────────────── */

  const keyOf = (ip, projectId) => `${ip}|${projectId}`;

  function throttle(ip, projectId) {
    const rec = fails.get(keyOf(ip, projectId));
    if (!rec || rec.until <= Date.now()) return { blocked: false, wait: 0 };
    return { blocked: true, wait: Math.ceil((rec.until - Date.now()) / 1000) };
  }

  /** 记一次失败，返回还能试几次 */
  function noteFail(ip, projectId) {
    if (fails.size > 2000) fails.clear();
    const k = keyOf(ip, projectId);
    const rec = fails.get(k) || { count: 0, until: 0 };
    rec.count += 1;
    // 前 5 次只记账，之后 60 秒起、每多错一次翻倍，最多 5 分钟
    if (rec.count >= FREE_TRIES) {
      rec.until = Date.now() + Math.min(60 * 2 ** (rec.count - FREE_TRIES), 300) * 1000;
    }
    fails.set(k, rec);
    return Math.max(0, FREE_TRIES - rec.count);
  }

  function noteOk(ip, projectId) {
    fails.delete(keyOf(ip, projectId));
  }

  return {
    file,
    days,
    snapshot,
    isLocked,
    info,
    verify,
    set,
    remove,
    rename,
    unlocked,
    grant,
    revoke,
    throttle,
    noteFail,
    noteOk,
  };
}
