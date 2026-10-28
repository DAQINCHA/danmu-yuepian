import { timecode, clockTime, authorColor } from './format.js';
import { drawStrokes } from './annotations.js';
import { createFrameGrabber } from './capture.js';

/**
 * 审片报告：把散在时间轴上的弹幕和画笔按时间码收成一张逐条清单，
 * 每条带「已改」勾选，进度存服务端，剪辑师可以分几次核对完。
 * 画笔标注会附上起始帧截图（画面 + 笔迹），打印和下载的 .md 里都带着。
 */

const SHOT_MAX_WIDTH = 1280;

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

/** shots：可选，annotationId -> 起始帧图片的 data URL；复制文本时不带图，免得剪贴板塞满 base64 */
export function buildMarkdown(data, shots = null) {
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

  entries.forEach((entry, index) => {
    const at = timecode(entry.time);
    const kind = entry.kind === 'comment' ? '弹幕' : '画笔';
    lines.push(`## ${index + 1}. ${at} · ${kind} · ${entry.data.author || '匿名'}`);
    lines.push('');
    lines.push(describe(entry, data.fps));
    lines.push('');
    const replies = entry.kind === 'comment' && Array.isArray(entry.data.replies) ? entry.data.replies : [];
    if (replies.length) {
      // 每条回复单独一段引用，免得在 Markdown 里糊成一行
      replies.forEach((reply, i) => {
        if (i) lines.push('>');
        lines.push(`> ↳ **${reply.author || '匿名'}**：${reply.text}`);
      });
      lines.push('');
    }
    const shot = entry.kind === 'annotation' ? shots?.get(entry.data.id) : null;
    if (shot) {
      lines.push(`![起始帧 ${at}](${shot})`);
      lines.push('');
    }
    lines.push(`- [${entry.data.done ? 'x' : ' '}] 已修改`);
    lines.push('');
  });

  if (!entries.length) lines.push('（这一版还没有任何意见）', '');
  return lines.join('\n');
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

function downloadMarkdown(data, shots) {
  const blob = new Blob([buildMarkdown(data, shots)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safeTitle = data.video.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  link.href = url;
  link.download = `审片报告-${safeTitle}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
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
  const grabber = createFrameGrabber();
  /** `${videoId}:${annotationId}:${start}` -> Promise<dataURL | null> */
  const shots = new Map();

  function shotKey(video, annotation) {
    return `${video.id}:${annotation.id}:${annotation.start}`;
  }

  /** 起始帧 = 入点那一帧的画面，再把这条标注的笔迹叠上去 */
  function shotFor(video, annotation) {
    const key = shotKey(video, annotation);
    if (!shots.has(key)) {
      const url = `/api/videos/${encodeURIComponent(video.id)}/file`;
      const job = grabber
        .grab(url, annotation.start + 0.001, { maxWidth: SHOT_MAX_WIDTH })
        .then((canvas) => {
          drawStrokes(canvas.getContext('2d'), annotation.strokes || [], canvas.width, canvas.height);
          return canvas.toDataURL('image/jpeg', 0.88);
        })
        .catch(() => {
          shots.delete(key); // 失败的下次打开报告再试
          return null;
        });
      shots.set(key, job);
    }
    return shots.get(key);
  }

  /** 等当前片子所有画笔的起始帧截完，返回 annotationId -> dataURL */
  async function collectShots(data) {
    const result = new Map();
    await Promise.all(data.annotations.map(async (annotation) => {
      const url = await shotFor(data.video, annotation);
      if (url) result.set(annotation.id, url);
    }));
    return result;
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
    const ok = await copyToClipboard(buildMarkdown(getData()));
    notify(ok ? '报告已复制到剪贴板' : '复制不了，用「下载 .md」吧', !ok);
  });

  document.getElementById('report-download').addEventListener('click', async () => {
    const data = getData();
    if (!data.video) return;
    if (data.annotations.length) notify('正在截取画笔标注的起始帧…');
    const images = await collectShots(data);
    downloadMarkdown(data, images);
    const missing = data.annotations.length - images.size;
    if (missing > 0) notify(`有 ${missing} 个标注的起始帧没截到，报告里只有文字`, true);
  });

  document.getElementById('report-print').addEventListener('click', async () => {
    const data = getData();
    if (data.video && data.annotations.length) {
      notify('正在截取画笔标注的起始帧…');
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

  function buildItem(entry, index) {
    const { data } = entry;

    const node = document.createElement('div');
    node.className = 'report-item' + (data.done ? ' done' : '');
    node.style.setProperty('--r-color', data.color || authorColor(data.author));

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

    head.append(timeButton, type, author);

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
    if (entry.kind === 'comment' && Array.isArray(data.replies) && data.replies.length) {
      main.append(buildReplies(data.replies));
    }
    node.append(indexEl);

    if (entry.kind === 'annotation') main.append(buildShot(data));

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

    const shown = filter === 'todo' ? entries.filter((e) => !e.data.done) : entries;
    if (!shown.length) {
      const hint = document.createElement('div');
      hint.className = 'list-empty';
      hint.textContent = entries.length ? '全部改完了，可以交片了。' : '这一版还没人提意见，先暂停在某一帧发条弹幕吧。';
      listEl.replaceChildren(hint);
      return;
    }
    listEl.replaceChildren(...shown.map((entry) => buildItem(entry, entries.indexOf(entry))));
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
