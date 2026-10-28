/**
 * 审片报告 PDF（浏览器端，零依赖）。
 * PDF 自带的标准字体没有中文，嵌入中文字体又太大，所以这里把每一页先排版画到
 * A4 比例的画布上（版面按 150dpi 的 1240×1754 设计，实际按 RENDER_SCALE 倍绘制保证清晰），
 * 再把每页编码成 JPEG，用 /DCTDecode 图片铺满一页写进一个最小 PDF。
 * 代价：PDF 里的文字不能选中 / 搜索。
 *
 * model 结构（由 report.js 生成）：
 * {
 *   title, meta: string[], summary,
 *   sections: [{
 *     heading?: string,            // 「整体问题」「画面 1 · 00:12.040 · 3 条」；不分组模式下可省略
 *     image?: string,              // 截帧 data URL
 *     imageCaption?: string,
 *     items: [{ index, time?, kind, author, color, text, done, replies: [{ author, color, text }] }]
 *     // time 为空：整体问题或画面分组内（时间码只在组标题上）；表头不画「弹幕」「画笔」类型
 *   }],
 *   empty?: string,
 * }
 */

const PAGE_W = 1240;
const PAGE_H = 1754;
const RENDER_SCALE = 2;
const JPEG_QUALITY = 0.85;
const MARGIN_X = 96;
const MARGIN_TOP = 90;
const MARGIN_BOTTOM = 100;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BOTTOM = PAGE_H - MARGIN_BOTTOM;

const SANS = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, ${SANS}`;

const COLORS = {
  text: '#16181d',
  dim: '#5b6270',
  faint: '#8a909c',
  line: '#dde1e7',
  accent: '#1f7f86',
  time: '#8a6100',
  ok: '#2f9e77',
  itemBg: '#f7f8fa',
};

/** 弹幕的署名色是给深色背景配的浅色，印在白纸上压暗一些 */
function inkColor(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!match) return COLORS.accent;
  const n = parseInt(match[1], 16);
  const mix = (v) => Math.round(v * 0.58);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `rgb(${r}, ${g}, ${b})`;
}

/** 中文按字断行；连续的英文 / 数字尽量整词换行，单词比一行还长时再按字断 */
function wrapText(ctx, text, width) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    const tokens = paragraph.match(/[A-Za-z0-9_\-.,:;!?'"()\[\]@#%&+=/\\]+\s*|\s+|./gsu) || [''];
    let line = '';
    for (const token of tokens) {
      if (ctx.measureText(line + token).width <= width) {
        line += token;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = '';
      if (ctx.measureText(token).width <= width) {
        line = token.trimStart();
        continue;
      }
      for (const ch of token) {
        if (line && ctx.measureText(line + ch).width > width) {
          lines.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function loadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('生成 PDF 页面失败'));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/jpeg', JPEG_QUALITY);
  });
}

/* ── 排版 ─────────────────────────────────────────────────────────── */

function createPager(footerText, onPage) {
  let canvas = null;
  let ctx = null;
  let pageNo = 0;
  let y = MARGIN_TOP;

  function start() {
    canvas = document.createElement('canvas');
    canvas.width = PAGE_W * RENDER_SCALE;
    canvas.height = PAGE_H * RENDER_SCALE;
    ctx = canvas.getContext('2d');
    ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    ctx.textBaseline = 'alphabetic';
    pageNo += 1;
    y = MARGIN_TOP;
  }

  async function finish() {
    if (!canvas) return;
    ctx.save();
    ctx.font = `15px ${SANS}`;
    ctx.fillStyle = COLORS.faint;
    ctx.textAlign = 'center';
    ctx.fillText(`${footerText} · 第 ${pageNo} 页`, PAGE_W / 2, PAGE_H - 50);
    ctx.restore();
    const jpeg = await canvasToJpeg(canvas);
    onPage({ jpeg, width: canvas.width, height: canvas.height });
    canvas.width = 0; // 尽快释放大画布
    canvas.height = 0;
    canvas = null;
  }

  return {
    get ctx() { return ctx; },
    get y() { return y; },
    set y(value) { y = value; },
    start,
    finish,
    /** 剩余空间不够 h 就翻页；本页一点都没画时不翻（避免超高内容死循环） */
    async ensure(h) {
      if (y + h <= BOTTOM || y <= MARGIN_TOP + 0.5) return;
      await finish();
      start();
    },
  };
}

function setFont(ctx, size, weight = 400, family = SANS) {
  ctx.font = `${weight} ${size}px ${family}`;
}

const ITEM = {
  padX: 18,
  padY: 14,
  head: 22,
  headGap: 8,
  text: 21,
  textLine: 32,
  reply: 18,
  replyLine: 27,
  replyIndent: 22,
  gap: 12,
};

/** 一条意见：先量出各行，再逐行画；超过一页的长文本按行分页 */
async function drawItem(pager, item) {
  const { ctx } = pager;
  const innerW = CONTENT_W - ITEM.padX * 2;
  const indexW = 44;
  const checkW = 90;
  const textW = innerW - indexW;

  setFont(ctx, ITEM.text);
  const textLines = wrapText(ctx, item.text, textW);
  setFont(ctx, ITEM.reply);
  const replyBlocks = (item.replies || []).map((reply) => {
    const label = `↳ ${reply.author || '匿名'}`;
    setFont(ctx, ITEM.reply, 650);
    const labelW = ctx.measureText(label).width + 10;
    setFont(ctx, ITEM.reply);
    const lines = wrapText(ctx, reply.text, Math.max(120, textW - ITEM.replyIndent - labelW));
    return { reply, label, labelW, lines };
  });

  // 待画的行：第一行是表头，之后正文、回复；每行自带高度
  const rows = [{ type: 'head', h: ITEM.head + ITEM.headGap }];
  for (const line of textLines) rows.push({ type: 'text', h: ITEM.textLine, line });
  if (replyBlocks.length) rows.push({ type: 'space', h: 6 });
  for (const block of replyBlocks) {
    block.lines.forEach((line, i) => rows.push({ type: 'reply', h: ITEM.replyLine, line, block, first: i === 0 }));
  }

  // 表头 + 至少两行正文放在一起，别把署名孤零零留在页尾
  const keep = ITEM.padY + rows.slice(0, 3).reduce((s, r) => s + r.h, 0);
  await pager.ensure(keep);

  const x0 = MARGIN_X + ITEM.padX;
  const tx = x0 + indexW;

  const drawBox = (c, top, bottom) => {
    c.save();
    c.fillStyle = COLORS.itemBg;
    c.strokeStyle = COLORS.line;
    c.lineWidth = 1.5;
    c.beginPath();
    if (c.roundRect) c.roundRect(MARGIN_X, top, CONTENT_W, bottom - top, 12);
    else c.rect(MARGIN_X, top, CONTENT_W, bottom - top);
    c.fill();
    c.stroke();
    // 左侧署名色细条
    c.fillStyle = inkColor(item.color);
    c.fillRect(MARGIN_X, top + 10, 4, Math.max(0, bottom - top - 20));
    c.restore();
  };

  let i = 0;
  let bottom = pager.y;
  while (i < rows.length) {
    if (i > 0) {
      // 上一段已画到页尾，剩下的行接到新页
      pager.y = BOTTOM + 1;
      await pager.ensure(Number.POSITIVE_INFINITY);
    }
    const top = pager.y;
    let y = top + ITEM.padY;
    // 先算出本页能放下的行，再画底框，最后画字
    let j = i;
    let h = 0;
    while (j < rows.length && (j === i || y + h + rows[j].h + ITEM.padY / 2 <= BOTTOM)) {
      h += rows[j].h;
      j += 1;
    }
    const c = pager.ctx;
    bottom = y + h + ITEM.padY / 2;
    drawBox(c, top, bottom);
    for (; i < j; i += 1) {
      const row = rows[i];
      if (row.type === 'head') {
        const base = y + ITEM.head - 4;
        setFont(c, 17, 500, MONO);
        c.fillStyle = COLORS.faint;
        c.fillText(String(item.index + 1).padStart(2, '0'), x0, base);
        let hx = tx;
        if (item.time) {
          setFont(c, 18, 600, MONO);
          c.fillStyle = COLORS.time;
          c.fillText(item.time, hx, base);
          hx += c.measureText(item.time).width + 14;
        }
        setFont(c, 18, 650);
        c.fillStyle = inkColor(item.color);
        c.fillText(item.author || '匿名', hx, base);
        hx += c.measureText(item.author || '匿名').width + 14;
        if (item.extra) {
          setFont(c, 16);
          c.fillStyle = COLORS.faint;
          c.fillText(item.extra, hx, base);
        }
        // 右侧勾选框
        const bx = MARGIN_X + CONTENT_W - ITEM.padX - checkW;
        c.strokeStyle = item.done ? COLORS.ok : '#9aa1ad';
        c.lineWidth = 2;
        c.strokeRect(bx, base - 16, 18, 18);
        if (item.done) {
          c.beginPath();
          c.moveTo(bx + 4, base - 7);
          c.lineTo(bx + 8, base - 2);
          c.lineTo(bx + 15, base - 13);
          c.stroke();
        }
        setFont(c, 16, 500);
        c.fillStyle = item.done ? COLORS.ok : COLORS.dim;
        c.fillText(item.done ? '已改' : '待改', bx + 26, base);
      } else if (row.type === 'text') {
        setFont(c, ITEM.text);
        c.fillStyle = item.done ? COLORS.faint : COLORS.text;
        const base = y + ITEM.textLine - 9;
        c.fillText(row.line, tx, base);
        if (item.done && row.line) {
          const w = c.measureText(row.line).width;
          c.fillRect(tx, base - 7, w, 1.5);
        }
      } else if (row.type === 'reply') {
        const base = y + ITEM.replyLine - 8;
        const rx = tx + ITEM.replyIndent;
        c.fillStyle = COLORS.line;
        c.fillRect(tx + 4, y, 3, row.h);
        if (row.first) {
          setFont(c, ITEM.reply, 650);
          c.fillStyle = inkColor(row.block.reply.color);
          c.fillText(row.block.label, rx, base);
        }
        setFont(c, ITEM.reply);
        c.fillStyle = '#3a3f48';
        c.fillText(row.line, rx + row.block.labelW, base);
      }
      y += row.h;
    }
  }
  pager.y = bottom + ITEM.gap;
}

async function drawSection(pager, section) {
  const { ctx } = pager;
  const headingH = section.heading ? 44 : 0;
  let img = null;
  let imgW = 0;
  let imgH = 0;
  const captionH = section.imageCaption ? 30 : 0;
  if (section.image) {
    img = await loadImage(section.image);
    if (img && img.naturalWidth) {
      imgW = Math.min(CONTENT_W * 0.82, img.naturalWidth);
      imgH = (img.naturalHeight / img.naturalWidth) * imgW;
      const maxH = 620;
      if (imgH > maxH) {
        imgW *= maxH / imgH;
        imgH = maxH;
      }
    } else {
      img = null;
    }
  }
  const imageBlock = img ? imgH + captionH + 14 : (section.image || section.imageCaption ? captionH : 0);

  // 标题和截帧放在同一页，再带上第一条意见的开头
  await pager.ensure(headingH + imageBlock + 110);
  let y = pager.y;
  const c = pager.ctx || ctx;

  if (section.heading) {
    c.fillStyle = COLORS.accent;
    c.fillRect(MARGIN_X, y + 6, 5, 26);
    setFont(c, 22, 700);
    c.fillText(section.heading, MARGIN_X + 18, y + 28);
    y += headingH;
  }
  if (img) {
    c.drawImage(img, MARGIN_X, y, imgW, imgH);
    c.strokeStyle = '#c9ced6';
    c.lineWidth = 1.5;
    c.strokeRect(MARGIN_X, y, imgW, imgH);
    y += imgH + 6;
  }
  if (section.imageCaption) {
    setFont(c, 15, 500, MONO);
    c.fillStyle = img ? COLORS.faint : '#c0392b';
    c.fillText(img ? section.imageCaption : `${section.imageCaption}（截帧失败）`, MARGIN_X, y + 18);
    y += captionH;
  }
  if (imageBlock) y += 8;
  pager.y = y;

  for (const item of section.items) await drawItem(pager, item);
  pager.y += section.heading ? 18 : 0;
}

async function drawHeader(pager, model) {
  const c = pager.ctx;
  let y = pager.y;
  setFont(c, 34, 700);
  c.fillStyle = COLORS.text;
  for (const line of wrapText(c, model.title, CONTENT_W)) {
    c.fillText(line, MARGIN_X, y + 36);
    y += 48;
  }
  setFont(c, 18);
  c.fillStyle = COLORS.dim;
  for (const line of model.meta || []) {
    for (const part of wrapText(c, line, CONTENT_W)) {
      c.fillText(part, MARGIN_X, y + 24);
      y += 30;
    }
  }
  if (model.summary) {
    setFont(c, 18, 600);
    c.fillStyle = COLORS.accent;
    c.fillText(model.summary, MARGIN_X, y + 26);
    y += 34;
  }
  // 表头和正文之间只留一条细分隔线（进度已经写在「意见」那一行）
  c.fillStyle = COLORS.line;
  c.fillRect(MARGIN_X, y + 14, CONTENT_W, 1.5);
  pager.y = y + 40;
}

/* ── PDF 封装 ─────────────────────────────────────────────────────── */

const encoder = new TextEncoder();

/** pages: { jpeg: Uint8Array, width, height }[] -> 一页一张图的 PDF（A4，595×842pt） */
export function buildImagePdf(pages, { title = '' } = {}) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (part) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const objStart = (n) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
  };

  // 对象编号：1 Catalog，2 Pages，3 Info，之后每页 3 个（Page、内容流、图片）
  const pageObj = (i) => 4 + i * 3;
  const W = 595.28;
  const H = 841.89;

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 二进制标记行

  objStart(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objStart(2);
  push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>\nendobj\n`);
  // Info 里的标题用 UTF-16BE 十六进制串，中文不乱码
  const hex = ['FEFF', ...[...String(title)].flatMap((ch) => {
    const code = ch.codePointAt(0);
    if (code <= 0xffff) return [code.toString(16).padStart(4, '0')];
    const v = code - 0x10000;
    return [(0xd800 + (v >> 10)).toString(16), (0xdc00 + (v & 0x3ff)).toString(16)];
  })].join('').toUpperCase();
  objStart(3);
  push(`<< /Title <${hex}> /Producer (danmu-yuepian) >>\nendobj\n`);

  pages.forEach((page, i) => {
    const p = pageObj(i);
    objStart(p);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im${i} ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>\nendobj\n`);
    const content = `q\n${W} 0 0 ${H} 0 0 cm\n/Im${i} Do\nQ\n`;
    objStart(p + 1);
    push(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);
    objStart(p + 2);
    push(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`);
    push(page.jpeg);
    push('\nendstream\nendobj\n');
  });

  const total = 4 + pages.length * 3;
  const xrefAt = length;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n += 1) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const part of chunks) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** 把报告 model 排成若干 A4 页，返回 PDF 的字节 */
export async function renderReportPdf(model) {
  const pages = [];
  const pager = createPager(model.footer || model.title, (page) => pages.push(page));
  pager.start();
  await drawHeader(pager, model);
  if (!model.sections.length && model.empty) {
    setFont(pager.ctx, 20);
    pager.ctx.fillStyle = COLORS.dim;
    pager.ctx.fillText(model.empty, MARGIN_X, pager.y + 24);
  }
  for (const section of model.sections) await drawSection(pager, section);
  await pager.finish();
  return buildImagePdf(pages, { title: model.title });
}
