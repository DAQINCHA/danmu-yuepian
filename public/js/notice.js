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
  id: '2026-11-27-download-and-review',
  badge: '更新公告',
  version: 'v2026.11.3',
  title: '项目版本支持一键下载原片，审片协作体验升级',
  lead: '本次更新重点上线项目内版本原片下载功能，并围绕多人在线审片、边看边写与界面观感做了多项打磨：',
  tip: '本公告在当前浏览器仅弹出一次',
  buttonText: '知道了',
  sections: [
    {
      tag: '重点新增',
      tone: 'gold',
      title: '项目文件夹版本一键下载原片，操作栏更清爽',
      items: [
        '进入任意项目或未分类列表后，每个视频版本右侧常驻**「下载」**按钮，点击即可直接下载原视频文件，无需进片页或另行要片。',
        '下载自动沿用当前显示片名并保留原格式后缀（mp4 / mov / webm），浏览器原生流式传输大文件，并沿用项目密码保护。',
        '同步收敛版本行操作栏：**「改名」「删除」与「设为最终版」**均改为悬停该行时展开（触屏常显），默认仅展示「移动到…」与「下载」，界面更干净、防误触。',
      ],
    },
    {
      tag: '新增',
      title: '在线观众名单与「打字自动暂停」开关',
      items: [
        '**顶栏「X人观看」**：看片页实时统计在线人数（同一署名多开标签页自动合并为 1 人），**鼠标悬停**（触屏轻点胶囊）即可展开完整观众名单与彩色首字圆头像，改名后自动实时同步。',
        '**打字自动暂停**：边播边写弹幕时，开始敲字（含中文输入法拼音上屏前）不仅锁定当前帧时间码，还会**自动暂停画面**（默认开启）；时间码旁新增**双竖线暂停开关**，可随时切换并记住本机偏好。',
      ],
    },
    {
      tag: '优化',
      title: '弹幕左竖条气泡、8 色头像与界面减法',
      items: [
        '**弹幕与侧栏辨识度升级**：在场弹幕改为更克制清晰的**深底 + 左侧彩色竖条**样式（导出截图同步一致）；角色色板扩至 **8 色轮换**，侧栏意见补齐**首字圆头像**，多人讨论一眼分清。',
        '**默认皮肤视觉收敛**：移除多余外发光、流光动画与装饰性渐变，统一全局字号、圆角与过渡节奏，让审片视线更聚焦视频画面。',
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
