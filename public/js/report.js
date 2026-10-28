import { timecode, clockTime, authorColor } from './format.js';
import { drawStrokes } from './annotations.js';
import { createFrameGrabber } from './capture.js';
import { createZip, dataUrlToBytes } from './zip.js';
import { renderReportPdf } from './pdf.js';

/**
 * 审片报告：把散在时间轴上的弹幕和画笔按时间码收成一张逐条清单，
 * 每条带「已改」勾选，进度存服务端，剪辑师可以分几次核对完。
 * 画笔标注会附上起始帧截图（画面 + 笔迹），打印和下载的 .md 里都带着。
 */

const SHOT_MAX_WIDTH = 1280;
const PREFS_KEY = 'danmu:report';
/** 合并间隔（秒）；0 = 不合并，每条弹幕各截一帧 */
const GAPS = [0.5, 1, 2, 0];
const DEFAULT_PREFS = { frames: true, gap: 1 };

export function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return {
      frames: raw.frames !== false,
      gap: GAPS.includes(raw.gap) ? raw.gap : DEFAULT_PREFS.gap,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 无痕模式存不了就算了 */
  }
}

/** 第 0 帧的弹幕 = 整体意见，报告里单列为「整体问题」，不截帧、不写时间码 */
function isOverall(comment) {
  return comment.time < 0.001;
}

function byTime(a, b) {
  return a.time - b.time || (a.data.createdAt || 0) - (b.data.createdAt || 0);
}

/**
 * 截帧模式下的分组：相邻弹幕时间差 <= gap 的并成一组，只截组里第一条的那一帧；
 * 画笔标注的入点落在某组的时间范围内（前后放宽 gap）就并进去，这组改用标注入点那一帧并叠上笔迹。
 * 没并进任何组的画笔标注各自成组。gap = 0 时每条弹幕单独一组，标注只和同一帧的弹幕合并。
 * 返回 { overall: entry[], groups: { time, entries, annotations, key }[] }
 */
export function groupEntries(data, gap) {
  const fps = data.fps || 25;
  const overall = [];
  const comments = [];
  for (const comment of data.comments) {
    const entry = { kind: 'comment', time: comment.time, data: comment };
    (isOverall(comment) ? overall : comments).push(entry);
  }
  overall.sort(byTime);
  comments.sort(byTime);

  const groups = [];
  let current = null;
  for (const entry of comments) {
    if (!current || gap <= 0 || entry.time - current.last > gap + 1e-6) {
      current = { first: entry.time, last: entry.time, entries: [], annotations: [], hasComments: true };
      groups.push(current);
    }
    current.entries.push(entry);
    current.last = entry.time;
  }

  const tolerance = gap > 0 ? gap : 0.5 / fps;
  const annotations = data.annotations
    .map((annotation) => ({ kind: 'annotation', time: annotation.start, data: annotation }))
    .sort(byTime);
  for (const entry of annotations) {
    const host = groups.find((g) => g.hasComments
      && entry.time >= g.first - tolerance && entry.time <= g.last + tolerance);
    if (host) {
      host.entries.push(entry);
      host.annotations.push(entry.data);
    } else {
      groups.push({ first: entry.time, last: entry.time, entries: [entry], annotations: [entry.data], hasComments: false });
    }
  }

  for (const group of groups) {
    group.entries.sort(byTime);
    group.from = group.entries[0].time;
    group.time = group.annotations.length ? group.annotations[0].start : group.first;
    group.key = group.annotations.length
      ? `a:${group.annotations.map((a) => `${a.id}@${a.start}`).join(',')}`
      : `c:${group.time}`;
  }
  groups.sort((a, b) => a.from - b.from);
  return { overall, groups };
}

/** 单个画笔标注（不分组模式）的截帧 key，和只含这一条标注的组共用缓存 */
function annotationKey(annotation) {
  return `a:${annotation.id}@${annotation.start}`;
}

function collect(data) {
  const entries = [];
  for (const comment of data.comments) {
    entries.push({ kind: 'comment', time: comment.time, data: comment });
  }
  for (const annotation of data.annotations) {
    entries.push({ kind: 'annotation', time: annotation.start, data: annotation });
  }
  return entries.sort((a, b) => a.time - b.time || (a.data.createdAt || 0) - (b.data.createdAt || 0));
}

function framesOf(annotation, fps) {
  return Math.max(1, Math.round((annotation.end - annotation.start) * (fps || 25)));
}

function describe(entry, fps) {
  if (entry.kind === 'comment') return entry.data.text;
  const annotation = entry.data;
  return `画面标注 · 第 ${framesOf(annotation, fps)} 帧 · ${timecode(annotation.start)} – ${timecode(annotation.end)}`;
}

function pushEntry(lines, entry, index, fps, { level = '##', shot = null, overall = false } = {}) {
  const at = timecode(entry.time);
  const kind = entry.kind === 'comment' ? '弹幕' : '画笔';
  lines.push(overall
    ? `${level} ${index + 1}. ${entry.data.author || '匿名'}`
    : `${level} ${index + 1}. ${at} · ${kind} · ${entry.data.author || '匿名'}`);
  lines.push('');
  lines.push(describe(entry, fps));
  lines.push('');
  if (shot) {
    lines.push(`![起始帧 ${at}](${shot})`);
    lines.push('');
  }
  // 弹幕和画笔标注的回复：放在正文 / 起始帧之后、「已修改」之前
  const replies = Array.isArray(entry.data.replies) ? entry.data.replies : [];
  if (replies.length) {
    // 每条回复单独一段引用，免得在 Markdown 里糊成一行
    replies.forEach((reply, i) => {
      if (i) lines.push('>');
      lines.push(`> ↳ **${reply.author || '匿名'}**：${reply.text}`);
    });
    lines.push('');
  }
  lines.push(`- [${entry.data.done ? 'x' : ' '}] 已修改`);
  lines.push('');
}

/**
 * shots：可选，截帧 key -> 图片地址（下载 zip 时是 images/frame-001.jpg 这样的相对路径）；
 * 复制文本时不带图。prefs.frames 打开时按画面分组输出；两种模式下「整体问题」都单列在最前。
 */
export function buildMarkdown(data, shots = null, prefs = loadPrefs()) {
  const entries = collect(data);
  const done = entries.filter((e) => e.data.done).length;
  const lines = [
    `# 审片报告 · ${data.video.title}`,
    '',
    `- 上传者：${data.video.uploader || '未署名'}`,
    `- 时长：${clockTime(data.video.duration)} · ${data.fps} fps`,
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 意见：共 ${entries.length} 条，已改 ${done} 条，待改 ${entries.length - done} 条`,
    '',
    '---',
    '',
  ];

  const overallEntries = entries.filter((e) => e.kind === 'comment' && isOverall(e.data));
  let index = 0;
  if (overallEntries.length) {
    lines.push('## 整体问题', '');
    for (const entry of overallEntries) pushEntry(lines, entry, index++, data.fps, { level: '###', overall: true });
  }

  if (prefs?.frames) {
    const { groups } = groupEntries(data, prefs.gap);
    groups.forEach((group, gi) => {
      const at = timecode(group.time);
      lines.push(`## 画面 ${gi + 1} · ${at} · ${group.entries.length} 条`, '');
      const shot = shots?.get(group.key);
      if (shot) lines.push(`![画面 ${at}](${shot})`, '');
      for (const entry of group.entries) pushEntry(lines, entry, index++, data.fps, { level: '###' });
    });
  } else {
    for (const entry of entries) {
      if (overallEntries.includes(entry)) continue;
      const shot = entry.kind === 'annotation' ? shots?.get(annotationKey(entry.data)) : null;
      pushEntry(lines, entry, index++, data.fps, { shot });
    }
  }

  if (!entries.length) lines.push('（这一版还没有任何意见）', '');
  return lines.join('\n');
}

function pdfItem(entry, index, fps, overall = false) {
  const author = entry.data.author || '匿名';
  const replies = Array.isArray(entry.data.replies) ? entry.data.replies : [];
  return {
    index,
    time: overall ? null : timecode(entry.time),
    kind: entry.kind,
    author,
    color: authorColor(author),
    text: describe(entry, fps),
    done: Boolean(entry.data.done),
    replies: replies.map((reply) => ({
      author: reply.author || '匿名',
      color: authorColor(reply.author || '匿名'),
      text: reply.text,
    })),
  };
}

/** PDF 排版用的结构，内容和顺序与 buildMarkdown 一致；images：截帧 key -> data URL */
function buildPdfModel(data, images, prefs) {
  const entries = collect(data);
  const done = entries.filter((e) => e.data.done).length;
  const sections = [];
  const overallEntries = entries.filter((e) => e.kind === 'comment' && isOverall(e.data));
  let index = 0;
  if (overallEntries.length) {
    sections.push({
      heading: '整体问题',
      items: overallEntries.map((entry) => pdfItem(entry, index++, data.fps, true)),
    });
  }
  if (prefs?.frames) {
    const { groups } = groupEntries(data, prefs.gap);
    groups.forEach((group, gi) => {
      const at = timecode(group.time);
      const image = images.get(group.key) || null;
      sections.push({
        heading: `画面 ${gi + 1} · ${at} · ${group.entries.length} 条`,
        image,
        imageCaption: image ? `画面 ${at}` : '',
        items: group.entries.map((entry) => pdfItem(entry, index++, data.fps)),
      });
    });
  } else {
    let flat = null;
    for (const entry of entries) {
      if (overallEntries.includes(entry)) continue;
      const image = entry.kind === 'annotation' ? images.get(annotationKey(entry.data)) : null;
      if (image || !flat) {
        flat = { items: [] };
        sections.push(flat);
      }
      const item = pdfItem(entry, index++, data.fps);
      if (image) {
        // 带截帧的画笔单独成段：起始帧在上、意见在下，后面的弹幕另起一段
        flat.items.push(item);
        flat.image = image;
        flat.imageCaption = `起始帧 ${item.time}`;
        flat = null;
      } else {
        flat.items.push(item);
      }
    }
  }
  return {
    title: `审片报告 · ${data.video.title}`,
    footer: `审片报告 · ${data.video.title}`,
    meta: [
      `上传者：${data.video.uploader || '未署名'}    时长：${clockTime(data.video.duration)} · ${data.fps} fps`,
      `生成时间：${new Date().toLocaleString('zh-CN')}`,
    ],
    summary: `意见：共 ${entries.length} 条，已改 ${done} 条，待改 ${entries.length - done} 条`,
    progress: entries.length ? done / entries.length : undefined,
    sections,
    empty: '（这一版还没有任何意见）',
  };
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 局域网 http 不是安全上下文，会走到下面的兜底 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function dateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 打包下载：report.md + images/ 下的每张截帧，md 里按相对路径引用图片。
 * images：截帧 key -> data URL；order：key 的出现顺序（决定 frame-001、002… 的编号）
 */
async function downloadZip(data, images, order, prefs) {
  const now = new Date();
  const paths = new Map();
  const files = [];
  for (const key of order) {
    const url = images.get(key);
    if (!url || paths.has(key)) continue;
    let image;
    try {
      image = dataUrlToBytes(url);
    } catch {
      continue;
    }
    const name = `images/frame-${String(files.length + 1).padStart(3, '0')}.${image.ext}`;
    paths.set(key, name);
    files.push({ name, data: image.bytes });
  }
  const safeTitle = data.video.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const head = [{ name: 'report.md', data: buildMarkdown(data, paths, prefs) }];
  let pdfOk = true;
  try {
    const pdf = await renderReportPdf(buildPdfModel(data, images, prefs));
    head.push({ name: `审片报告-${safeTitle}-${dateStamp(now)}.pdf`, data: pdf });
  } catch (err) {
    console.error('生成 PDF 失败', err);
    pdfOk = false;
  }
  files.unshift(...head);

  const blob = createZip(files, { date: now });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `审片报告-${safeTitle}-${dateStamp(now)}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { pdfOk };
}

export function createReportView({ getData, onToggleDone, onJump, notify }) {
  const modal = document.getElementById('report-modal');
  const titleEl = document.getElementById('report-title');
  const subEl = document.getElementById('report-sub');
  const barEl = document.getElementById('report-bar');
  const countEl = document.getElementById('report-count');
  const listEl = document.getElementById('report-list');
  const filtersEl = document.getElementById('report-filters');

  let filter = 'all';
  let prefs = loadPrefs();
  const grabber = createFrameGrabber();
  /** `${videoId}:${截帧 key}` -> Promise<dataURL | null>；grabber 本身排队，同一帧只截一次 */
  const shots = new Map();

  const framesInput = document.getElementById('report-frames');
  const gapSelect = document.getElementById('report-gap');
  framesInput.checked = prefs.frames;
  gapSelect.value = String(prefs.gap);
  gapSelect.disabled = !prefs.frames;
  framesInput.addEventListener('change', () => {
    prefs = { ...prefs, frames: framesInput.checked };
    gapSelect.disabled = !prefs.frames;
    savePrefs(prefs);
    render();
  });
  gapSelect.addEventListener('change', () => {
    const gap = Number(gapSelect.value);
    prefs = { ...prefs, gap: GAPS.includes(gap) ? gap : DEFAULT_PREFS.gap };
    savePrefs(prefs);
    render();
  });

  /** 截 time 处的画面，叠上给定标注的笔迹（没有标注就是纯画面） */
  function shotAt(video, key, time, annotations = []) {
    const cacheKey = `${video.id}:${key}`;
    if (!shots.has(cacheKey)) {
      const url = `/api/videos/${encodeURIComponent(video.id)}/file`;
      const job = grabber
        .grab(url, time + 0.001, { maxWidth: SHOT_MAX_WIDTH })
        .then((canvas) => {
          const ctx = canvas.getContext('2d');
          for (const annotation of annotations) {
            drawStrokes(ctx, annotation.strokes || [], canvas.width, canvas.height);
          }
          return canvas.toDataURL('image/jpeg', 0.88);
        })
        .catch(() => {
          shots.delete(cacheKey); // 失败的下次打开报告再试
          return null;
        });
      shots.set(cacheKey, job);
    }
    return shots.get(cacheKey);
  }

  /** 起始帧 = 入点那一帧的画面，再把这条标注的笔迹叠上去 */
  function shotFor(video, annotation) {
    return shotAt(video, annotationKey(annotation), annotation.start, [annotation]);
  }

  function shotForGroup(video, group) {
    return shotAt(video, group.key, group.time, group.annotations);
  }

  /** 当前模式下要截的所有图：{ key, job }[] */
  function shotJobs(data) {
    if (prefs.frames) {
      return groupEntries(data, prefs.gap).groups.map((group) => ({ key: group.key, job: () => shotForGroup(data.video, group) }));
    }
    return data.annotations.map((annotation) => ({ key: annotationKey(annotation), job: () => shotFor(data.video, annotation) }));
  }

  /** 等当前模式下所有截帧完成，返回 key -> dataURL 和应截张数 */
  async function collectShots(data) {
    const result = new Map();
    const jobs = shotJobs(data);
    await Promise.all(jobs.map(async ({ key, job }) => {
      const url = await job();
      if (url) result.set(key, url);
    }));
    return { images: result, total: jobs.length, order: jobs.map((j) => j.key) };
  }

  async function waitImages() {
    const images = [...listEl.querySelectorAll('img')];
    await Promise.all(images.map((img) => (img.decode ? img.decode().catch(() => {}) : null)));
  }

  filtersEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    filter = button.dataset.filter;
    for (const node of filtersEl.children) node.classList.toggle('active', node === button);
    render();
  });

  document.getElementById('report-copy').addEventListener('click', async () => {
    const ok = await copyToClipboard(buildMarkdown(getData(), null, prefs));
    notify(ok ? '报告已复制到剪贴板' : '复制不了，用「下载报告」吧', !ok);
  });

  document.getElementById('report-download').addEventListener('click', async () => {
    const data = getData();
    if (!data.video) return;
    const expected = shotJobs(data).length;
    if (expected) notify(prefs.frames ? '正在截取各条意见的画面…' : '正在截取画笔标注的起始帧…');
    const { images, total, order } = await collectShots(data);
    notify('正在排版 PDF…');
    const { pdfOk } = await downloadZip(data, images, order, prefs);
    const missing = total - images.size;
    if (!pdfOk) notify('PDF 生成失败，压缩包里只有 report.md 和图片', true);
    else if (missing > 0) notify(`有 ${missing} 张画面没截到，报告里那部分只有文字`, true);
    else notify('报告已打包下载（PDF + report.md + images/）');
  });

  document.getElementById('report-print').addEventListener('click', async () => {
    const data = getData();
    if (data.video && shotJobs(data).length) {
      notify(prefs.frames ? '正在截取各条意见的画面…' : '正在截取画笔标注的起始帧…');
      await collectShots(data);
      await waitImages();
    }
    window.print();
  });

  function buildReplies(replies) {
    const list = document.createElement('div');
    list.className = 'r-replies';
    for (const reply of replies) {
      const row = document.createElement('div');
      row.className = 'r-reply';
      row.style.setProperty('--r-color', authorColor(reply.author));
      const author = document.createElement('span');
      author.className = 'r-reply-author';
      author.textContent = `↳ ${reply.author || '匿名'}`;
      const text = document.createElement('span');
      text.className = 'r-reply-text';
      text.textContent = reply.text;
      row.append(author, text);
      list.append(row);
    }
    return list;
  }

  function buildItem(entry, index, { withShot = true, overall = false } = {}) {
    const { data } = entry;

    const node = document.createElement('div');
    node.className = 'report-item' + (data.done ? ' done' : '');
    node.style.setProperty('--r-color', authorColor(data.author));

    const indexEl = document.createElement('span');
    indexEl.className = 'r-index mono';
    indexEl.textContent = String(index + 1).padStart(2, '0');

    const main = document.createElement('div');
    main.className = 'r-main';

    const head = document.createElement('div');
    head.className = 'r-head';

    const timeButton = document.createElement('button');
    timeButton.className = 'r-time mono';
    timeButton.type = 'button';
    timeButton.textContent = timecode(entry.time);
    timeButton.title = '跳到这一帧';
    timeButton.addEventListener('click', () => onJump(entry.time));

    const type = document.createElement('span');
    type.className = 'r-type';
    type.textContent = entry.kind === 'comment' ? '弹幕' : '画笔';

    const author = document.createElement('span');
    author.className = 'r-author';
    author.textContent = data.author || '匿名';

    // 整体问题不挂在某一帧上，不显示时间码和类型
    if (overall) head.append(author);
    else head.append(timeButton, type, author);

    if (entry.kind === 'annotation') {
      const frames = document.createElement('span');
      frames.className = 'r-frames';
      frames.textContent = `${framesOf(data, currentFps())} 帧`;
      head.append(frames);
    }

    const text = document.createElement('p');
    text.className = 'r-text';
    text.textContent = entry.kind === 'comment'
      ? data.text
      : `${timecode(data.start)} – ${timecode(data.end)} 的连续帧`;

    main.append(head, text);
    node.append(indexEl);

    if (entry.kind === 'annotation' && withShot) main.append(buildShot(data));
    if (Array.isArray(data.replies) && data.replies.length) main.append(buildReplies(data.replies));

    node.append(main);

    const check = document.createElement('label');
    check.className = 'r-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(data.done);
    input.addEventListener('change', () => onToggleDone(entry.kind, data.id, input.checked));
    const label = document.createElement('span');
    label.textContent = '已改';
    check.append(input, label);
    node.append(check);

    return node;
  }

  /** 起始帧截图：先占位，截到了换成图片；截不到就退回只画笔迹的小图 */
  function buildShot(annotation) {
    const figure = document.createElement('figure');
    figure.className = 'r-shot loading';
    const caption = document.createElement('figcaption');
    caption.className = 'mono';
    caption.textContent = `起始帧 ${timecode(annotation.start)} · 截取中…`;
    figure.append(caption);

    const video = getData().video;
    if (!video) return figure;

    shotFor(video, annotation).then((url) => {
      figure.classList.remove('loading');
      if (url) {
        const img = document.createElement('img');
        img.alt = `起始帧 ${timecode(annotation.start)}`;
        img.src = url;
        img.title = '点击跳到这一帧';
        img.addEventListener('click', () => onJump(annotation.start));
        caption.textContent = `起始帧 ${timecode(annotation.start)}`;
        figure.prepend(img);
        return;
      }
      figure.classList.add('failed');
      const thumb = document.createElement('canvas');
      const tw = 160;
      const th = 90;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      thumb.width = tw * dpr;
      thumb.height = th * dpr;
      thumb.style.width = `${tw}px`;
      thumb.style.height = `${th}px`;
      const ctx = thumb.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawStrokes(ctx, annotation.strokes || [], tw, th);
      caption.textContent = `起始帧没截到，只显示笔迹（${timecode(annotation.start)}）`;
      figure.prepend(thumb);
    });
    return figure;
  }

  /** 一组意见共用的画面：先占位，截到了换成图片；截不到时有笔迹就画笔迹，没有就只留提示 */
  function buildGroupShot(group) {
    const figure = document.createElement('figure');
    figure.className = 'r-shot loading';
    const caption = document.createElement('figcaption');
    caption.className = 'mono';
    const at = timecode(group.time);
    const strokesNote = group.annotations.length ? ' · 含画笔笔迹' : '';
    caption.textContent = `画面 ${at}${strokesNote} · 截取中…`;
    figure.append(caption);

    const video = getData().video;
    if (!video) return figure;

    shotForGroup(video, group).then((url) => {
      figure.classList.remove('loading');
      if (url) {
        const img = document.createElement('img');
        img.alt = `画面 ${at}`;
        img.src = url;
        img.title = '点击跳到这一帧';
        img.addEventListener('click', () => onJump(group.time));
        caption.textContent = `画面 ${at}${strokesNote}`;
        figure.prepend(img);
        return;
      }
      figure.classList.add('failed');
      caption.textContent = `画面没截到（${at}）`;
      if (!group.annotations.length) return;
      const thumb = document.createElement('canvas');
      const tw = 160;
      const th = 90;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      thumb.width = tw * dpr;
      thumb.height = th * dpr;
      thumb.style.width = `${tw}px`;
      thumb.style.height = `${th}px`;
      const ctx = thumb.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const annotation of group.annotations) drawStrokes(ctx, annotation.strokes || [], tw, th);
      caption.textContent = `画面没截到，只显示笔迹（${at}）`;
      figure.prepend(thumb);
    });
    return figure;
  }

  function groupHead(text) {
    const head = document.createElement('div');
    head.className = 'r-group-head';
    head.textContent = text;
    return head;
  }

  /** 截帧模式：整体问题在最前，之后每组「一张画面 + 组内各条意见」 */
  function renderGrouped(data, visible) {
    const { overall, groups } = groupEntries(data, prefs.gap);
    const nodes = [];
    let index = 0;

    const shownOverall = [];
    for (const entry of overall) {
      if (visible(entry)) shownOverall.push(buildItem(entry, index, { overall: true }));
      index += 1;
    }
    if (shownOverall.length) {
      const section = document.createElement('section');
      section.className = 'report-group overall';
      section.append(groupHead('整体问题'), ...shownOverall);
      nodes.push(section);
    }

    groups.forEach((group, gi) => {
      const items = [];
      for (const entry of group.entries) {
        if (visible(entry)) items.push(buildItem(entry, index, { withShot: false }));
        index += 1;
      }
      if (!items.length) return;
      const section = document.createElement('section');
      section.className = 'report-group';
      section.append(
        groupHead(`画面 ${gi + 1} · ${timecode(group.time)} · ${group.entries.length} 条`),
        buildGroupShot(group),
        ...items,
      );
      nodes.push(section);
    });
    return nodes;
  }

  function currentFps() {
    return getData().fps || 25;
  }

  function render() {
    const data = getData();
    if (!data.video) return;

    const entries = collect(data);
    const done = entries.filter((e) => e.data.done).length;
    const pending = entries.length - done;

    titleEl.textContent = `审片报告 · ${data.video.title}`;
    subEl.textContent = [
      `上传 ${data.video.uploader || '未署名'}`,
      `${clockTime(data.video.duration)} · ${data.fps} fps`,
      `生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ].join(' · ');

    barEl.style.width = entries.length ? `${(done / entries.length) * 100}%` : '0%';
    countEl.textContent = entries.length ? `${done} / ${entries.length} 已改 · 待改 ${pending}` : '还没有意见';

    const visible = (entry) => filter !== 'todo' || !entry.data.done;
    const shown = entries.filter(visible);
    if (!shown.length) {
      const hint = document.createElement('div');
      hint.className = 'list-empty';
      hint.textContent = entries.length ? '全部改完了，可以交片了。' : '这一版还没人提意见，先暂停在某一帧发条弹幕吧。';
      listEl.replaceChildren(hint);
      return;
    }
    if (prefs.frames) {
      listEl.replaceChildren(...renderGrouped(data, visible));
      return;
    }
    // 不截帧：整体问题照样单列在最前，其余按时间顺序
    const overallShown = shown.filter((e) => e.kind === 'comment' && isOverall(e.data));
    const restShown = shown.filter((e) => !overallShown.includes(e));
    const overallAll = entries.filter((e) => e.kind === 'comment' && isOverall(e.data));
    const restAll = entries.filter((e) => !overallAll.includes(e));
    const nodes = [];
    if (overallShown.length) {
      const section = document.createElement('section');
      section.className = 'report-group overall';
      section.append(
        groupHead('整体问题'),
        ...overallShown.map((e) => buildItem(e, overallAll.indexOf(e), { overall: true })),
      );
      nodes.push(section);
    }
    for (const entry of restShown) nodes.push(buildItem(entry, overallAll.length + restAll.indexOf(entry)));
    listEl.replaceChildren(...nodes);
  }

  return {
    open() {
      render();
      modal.hidden = false;
      listEl.scrollTop = 0;
    },
    close() {
      modal.hidden = true;
    },
    refresh() {
      if (!modal.hidden) render();
    },
  };
}
