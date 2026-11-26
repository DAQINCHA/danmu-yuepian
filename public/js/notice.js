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
  id: '2026-11-26-film-skin-mobile',
  badge: '更新公告',
  version: 'v2026.11.2',
  title: '新增「胶片剪辑台」皮肤，手机与平板体验升级',
  lead: '本次更新带来第二套暗房剪辑台皮肤，并对手机端与平板半屏布局做了细致打磨：',
  tip: '本公告在当前浏览器仅弹出一次',
  buttonText: '知道了',
  sections: [
    {
      tag: '新增',
      tone: 'gold',
      title: '「胶片剪辑台」暗房皮肤，一键换肤',
      items: [
        '点击顶栏署名框旁的**衣服图标**，可在「毛玻璃座舱」与「胶片剪辑台」之间即时切换，偏好自动记在本机、刷新零闪烁。',
        '采用阳极氧化炭黑暗房底色与柯达钨丝琥珀高亮，减少画面校色干扰；搭配封面 **35mm 微齿条**、时间轴**精密刻度尺与刀锋指针**。',
        '**全界面联动变色**：音频波形、弹幕热力山脉、画面在场弹幕与署名色板都会随皮肤实时刷新。',
      ],
    },
    {
      tag: '体验',
      title: '手机端底部悬浮胶囊导航',
      items: [
        '窄屏首页新增底部悬浮胶囊，单手即可在**「项目 / 个人」**间快速切换；进入项目页后依然保留胶囊，轻点即可回到对应主页。',
        '精简手机顶栏（隐藏新建与上传按钮、收紧署名框并保留品牌名），把更多视野留给看片与选片。',
      ],
    },
    {
      tag: '优化',
      title: '平板竖屏、半屏与分屏对比自适应',
      items: [
        '补齐平板竖屏与桌面半屏布局（视频在上、评论在下），拖动侧栏调宽或缩放窗口时，播放条会自动折行或横向滑动，不再裁切越界。',
        '多版本**「分屏」对比**可按舞台比例自动选择左右并排或上下堆叠；窄屏与上下布局下固定左右并排，避免把进度条挤出首屏。',
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
