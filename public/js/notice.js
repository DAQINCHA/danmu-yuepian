/**
 * 可复用更新公告配置与弹窗控制器
 *
 * 使用说明：
 * - 平常不需要公告时：把 NOTICE.enabled 设为 false；
 * - 需要公布新更新时：
 *   1. 把 enabled 设为 true；
 *   2. 换一个新的 id（例如 '2026-12-01'），同一浏览器对同一 id 只会自动弹出一次；
 *   3. 按需修改 badge / version / title / lead / sections。
 *
 * 条目文案支持两种轻量标记（纯 DOM 节点渲染）：
 * - **加粗文字**
 * - `按键`（渲染为键盘键帽 <kbd>）
 */
export const NOTICE = {
  enabled: true,
  id: '2026-11-25-studio-upgrade',
  badge: '更新公告',
  version: 'v2026.11',
  title: '弹幕阅片迎来一次大升级',
  lead: '本次更新围绕「审片更准、操控更顺、界面更通透」做了全面打磨，以下是最新变化：',
  tip: '本公告在当前浏览器仅弹出一次',
  buttonText: '知道了',
  sections: [
    {
      tag: '新增',
      title: '多版本同步对比仪',
      items: [
        '同项目下有多个版本时，播放条出现**「对比」**按钮，支持**卷帘拖动 / 左右分屏 / 像素差值（Diff + 增益）**三种模式同步查看改动。',
        '支持**按帧微调偏移**（两版片头长短不同也能精准对齐）以及一键切换听当前版或对照版音轨。',
      ],
    },
    {
      tag: '新增',
      title: '时间轴三大可视化增强',
      items: [
        '**音频波形轨**：点击「波形」在时间轴居中铺出声波，节奏卡点与静音段一目了然（服务端共享缓存，全员首次打开秒出）。',
        '**弹幕热力山脉**：进度条上方自动绘出弹幕与标注密度曲线，一眼定位修改最集中的段落。',
        '**悬停缩略图预览**：鼠标划过进度条实时预览画面缩略图、时间码及附近修改提示（服务端雪碧图缓存，丝滑瞬出）。',
      ],
    },
    {
      tag: '新增',
      title: '画面参考线与平台安全框',
      items: [
        '点井字格图标或按 `G` 随时叠上**抖音 / 视频号 9:16 避让区**（横屏自动模拟竖屏裁切框）、**小红书避让区**、**2.35:1 电影遮幅**及**三分线与准星**，右键一键关闭。',
      ],
    },
    {
      tag: '提效',
      title: '剪辑级播控与快捷键体系',
      items: [
        '**变速与梭车**：`J` 减速 / `K` 暂停 / `L` 加速（0.25x–2x，右键点倍速按钮回 1x）。',
        '**I / O 区间循环**：`I` 定入点、`O` 定出点、`C` 清除循环（画笔入/出点快捷键同步改为 `A` / `B`）。',
        '**逐条核对与速查**：按 `[` / `]` 快速跳转上一条 / 下一条待改意见；点 `?` 随时打开快捷键速查卡。',
      ],
    },
    {
      tag: '视觉与体验',
      tone: 'gold',
      title: '悬浮毛玻璃座舱 & 交互精简',
      items: [
        '**全新毛玻璃质感**：顶栏、主舞台、控制舱、侧栏与弹窗全面升级为通透悬浮玻璃风格；片库封面放大且操作收进封面右上角。',
        '**单行智能弹幕栏**：「当前帧弹幕」与「整体意见」合为一行，点左侧时间码胶囊一键切换（整体意见模式整栏亮起暖金色）。',
        '**界面瘦身 & 流畅省电**：逐帧合并为「◀ 帧 ▶」、常用工具图标化；侧栏支持拖动左边缘自由调宽并记忆；播放时按需刷帧并暂停背景动效，明显降低显卡占用。',
      ],
    },
  ],
};

function appendRichText(parent, text) {
  const token = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const match of String(text || '').matchAll(token)) {
    const start = match.index ?? 0;
    if (start > last) parent.append(document.createTextNode(text.slice(last, start)));
    if (match[1] !== undefined) {
      const strong = document.createElement('strong');
      strong.textContent = match[1];
      parent.append(strong);
    } else if (match[2] !== undefined) {
      const kbd = document.createElement('kbd');
      kbd.textContent = match[2];
      parent.append(kbd);
    }
    last = start + match[0].length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function renderNoticeContent(els, config) {
  if (els.badge) {
    els.badge.textContent = config.badge || '更新公告';
    els.badge.hidden = !config.badge;
  }
  if (els.version) {
    els.version.textContent = config.version || '';
    els.version.hidden = !config.version;
  }
  if (els.title) els.title.textContent = config.title || '更新公告';
  if (els.lead) {
    els.lead.textContent = config.lead || '';
    els.lead.hidden = !config.lead;
  }
  if (els.tip) {
    els.tip.textContent = config.tip || '本公告在当前浏览器仅弹出一次';
  }
  if (els.ok) {
    els.ok.textContent = config.buttonText || '知道了';
  }
  if (!els.body) return;

  const frag = document.createDocumentFragment();
  for (const section of config.sections || []) {
    const card = document.createElement('section');
    card.className = 'notice-card';

    const head = document.createElement('div');
    head.className = 'notice-card-head';
    if (section.tag) {
      const tag = document.createElement('span');
      tag.className = `notice-tag${section.tone === 'gold' ? ' gold' : ''}`;
      tag.textContent = section.tag;
      head.append(tag);
    }
    if (section.title) {
      const h3 = document.createElement('h3');
      h3.textContent = section.title;
      head.append(h3);
    }
    card.append(head);

    if (Array.isArray(section.items) && section.items.length) {
      const ul = document.createElement('ul');
      ul.className = 'notice-list';
      for (const line of section.items) {
        const li = document.createElement('li');
        appendRichText(li, line);
        ul.append(li);
      }
      card.append(ul);
    }
    frag.append(card);
  }
  els.body.replaceChildren(frag);
}

export function createNoticeController(els, { storeKey = 'danmu:seen-notice', config = NOTICE } = {}) {
  let rendered = false;

  function readSeen() {
    try {
      return localStorage.getItem(storeKey) || '';
    } catch {
      return '';
    }
  }

  function markSeen() {
    if (!config?.id) return;
    try {
      localStorage.setItem(storeKey, config.id);
    } catch {
      // 隐私模式等禁用存储时静默忽略
    }
  }

  function isPending() {
    return Boolean(config?.enabled && config?.id && readSeen() !== config.id);
  }

  function hasOtherOpenModal() {
    for (const modal of document.querySelectorAll('.modal')) {
      if (modal !== els.modal && !modal.hidden) return true;
    }
    return false;
  }

  function open() {
    if (!els.modal || !config?.id) return false;
    if (!rendered) {
      renderNoticeContent(els, config);
      rendered = true;
    }
    els.modal.hidden = false;
    // 弹出即记为本浏览器已阅，刷新或直接关页也不会重复弹出
    markSeen();
    requestAnimationFrame(() => els.ok?.focus?.());
    return true;
  }

  function maybeShow() {
    if (!isPending()) return false;
    if (hasOtherOpenModal()) return false;
    return open();
  }

  function dismiss() {
    if (!els.modal || els.modal.hidden) return;
    els.modal.hidden = true;
    markSeen();
  }

  els.ok?.addEventListener('click', dismiss);

  return { maybeShow, open, dismiss, isPending };
}
