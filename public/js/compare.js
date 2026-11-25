/**
 * 同项目多版本对比仪（第 7 期，零后端改动）：
 *  · 复用主 <video> 为 Master，所有播放/倍速/逐帧/A-B循环/时间轴天然同步；
 *  · 内置第二路 <video> 为 Slave，支持 3 种模式：
 *      - wipe  ：中线拉杆卷帘对比（左对照版 / 右当前版）
 *      - split ：左右 50/50 并排同步对比
 *      - diff  ：mix-blend-mode: difference 像素差值检错（支持增益放大细微调色差异）
 *  · 支持 ± 逐帧时间偏移微调，以及一键切换听当前版/对照版声音。
 */

export function createCompareController({
  frame,
  videoWrap,
  masterVideo,
  layer,
  slaveVideo,
  handle,
  leftBadge,
  rightBadge,
  toolbar,
  selectEl,
  modeButtons,
  boostBtn,
  audioBtn,
  offsetLabel,
  offsetBackBtn,
  offsetFwdBtn,
  closeBtn,
  getSiblings,
  getCurrentVideo,
  getFps,
  onLayoutChange,
  onActiveChange,
  notify,
}) {
  let active = false;
  let mode = 'wipe'; // 'wipe' | 'split' | 'diff'
  let splitPct = 50;
  let boost = false;
  let listenSlave = false;
  let offsetFrames = 0;
  let targetVideo = null;
  let dragging = false;
  let lastHardSync = 0;

  function fps() {
    return getFps?.() || 25;
  }

  function offsetSec() {
    return offsetFrames / fps();
  }

  function versionLabel(video, versionMap) {
    if (!video) return '';
    const v = versionMap.get(video.id);
    return v ? `v${v}` : '';
  }

  function targetTimeFor(masterTime) {
    const raw = (masterTime || 0) + offsetSec();
    const dur = Number.isFinite(slaveVideo.duration) && slaveVideo.duration > 0
      ? slaveVideo.duration
      : null;
    if (dur !== null) return Math.min(Math.max(0, raw), Math.max(0, dur - 0.001));
    return Math.max(0, raw);
  }

  function applyAudioRouting() {
    if (!active) {
      slaveVideo.muted = true;
      return;
    }
    const masterMuted = masterVideo.muted;
    if (listenSlave) {
      slaveVideo.muted = masterMuted;
      // 用 volume=0 暂静主视频而不改 muted，避免触发 app.js 把全局静音偏好存成 on
      masterVideo.volume = 0;
      slaveVideo.volume = 1;
    } else {
      masterVideo.volume = 1;
      slaveVideo.muted = true;
    }
    if (audioBtn) {
      audioBtn.textContent = listenSlave ? '声音：对照版' : '声音：当前版';
      audioBtn.classList.toggle('active', listenSlave);
    }
  }

  function restoreAudio() {
    listenSlave = false;
    masterVideo.volume = 1;
    slaveVideo.muted = true;
    if (audioBtn) {
      audioBtn.textContent = '声音：当前版';
      audioBtn.classList.remove('active');
    }
  }

  function updateOffsetUI() {
    if (!offsetLabel) return;
    if (offsetFrames === 0) {
      offsetLabel.textContent = '0 帧';
      offsetLabel.classList.remove('shifted');
    } else {
      const sign = offsetFrames > 0 ? '+' : '';
      offsetLabel.textContent = `${sign}${offsetFrames} 帧`;
      offsetLabel.classList.add('shifted');
    }
  }

  function applyWipeVisual() {
    const p = Math.min(97, Math.max(3, splitPct));
    splitPct = p;
    if (handle) handle.style.left = `${p}%`;
    if (mode === 'wipe') {
      slaveVideo.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
    } else {
      slaveVideo.style.clipPath = '';
    }
  }

  function syncModeUI() {
    if (!layer || !frame || !videoWrap) return;
    layer.dataset.mode = mode;
    videoWrap.classList.toggle('compare-on', active);
    videoWrap.classList.toggle('compare-wipe', active && mode === 'wipe');
    videoWrap.classList.toggle('compare-split', active && mode === 'split');
    videoWrap.classList.toggle('compare-diff', active && mode === 'diff');
    videoWrap.classList.toggle('compare-boost', active && mode === 'diff' && boost);
    frame.classList.toggle('compare-split', active && mode === 'split');

    if (handle) handle.hidden = !active || mode !== 'wipe';
    if (boostBtn) {
      boostBtn.hidden = mode !== 'diff';
      boostBtn.classList.toggle('active', boost);
    }
    for (const btn of modeButtons) {
      btn.classList.toggle('active', btn.dataset.compareMode === mode);
    }
    applyWipeVisual();
  }

  function syncBadges() {
    const { versionMap } = getSiblings();
    const cur = getCurrentVideo();
    const curVer = versionLabel(cur, versionMap);
    const tgtVer = versionLabel(targetVideo, versionMap);
    if (leftBadge) {
      leftBadge.textContent = targetVideo
        ? `对照 ${tgtVer}${targetVideo.title ? ` · ${targetVideo.title}` : ''}`
        : '对照版';
    }
    if (rightBadge) {
      rightBadge.textContent = cur
        ? `当前 ${curVer}${cur.title ? ` · ${cur.title}` : ''}`
        : '当前版';
    }
  }

  function fillSelect() {
    if (!selectEl) return;
    const { others, versionMap } = getSiblings();
    selectEl.replaceChildren(...others.map((video) => {
      const opt = document.createElement('option');
      opt.value = video.id;
      const ver = versionLabel(video, versionMap);
      const title = video.title || video.filename || '未命名';
      opt.textContent = `${ver ? `${ver} · ` : ''}${title}`;
      return opt;
    }));
    if (targetVideo && others.some((v) => v.id === targetVideo.id)) {
      selectEl.value = targetVideo.id;
    }
  }

  function loadSlave(video) {
    targetVideo = video;
    offsetFrames = 0;
    updateOffsetUI();
    syncBadges();
    if (!video) return;
    slaveVideo.src = `/api/videos/${video.id}/file`;
    slaveVideo.load();
    slaveVideo.playbackRate = masterVideo.playbackRate || 1;
    applyAudioRouting();
    const syncOnce = () => {
      sync(true);
      if (!masterVideo.paused) slaveVideo.play().catch(() => {});
    };
    slaveVideo.addEventListener('loadedmetadata', syncOnce, { once: true });
  }

  function sync(force = false) {
    if (!active || !targetVideo) return;
    if (slaveVideo.readyState < 1) return;

    const rate = masterVideo.playbackRate || 1;
    if (Math.abs(slaveVideo.playbackRate - rate) > 0.005) {
      slaveVideo.playbackRate = rate;
    }
    const target = targetTimeFor(masterVideo.currentTime);
    const drift = Math.abs((slaveVideo.currentTime || 0) - target);

    if (masterVideo.paused) {
      if (!slaveVideo.paused) slaveVideo.pause();
      if (force || drift > 0.012) {
        try {
          slaveVideo.currentTime = target;
        } catch {
          /* 元数据尚未就绪 */
        }
      }
      return;
    }

    // 播放态：漂移超过 90ms 才纠正，避免频繁 seek 导致卡顿
    const now = performance.now();
    if (force || (drift > 0.09 && now - lastHardSync > 220)) {
      lastHardSync = now;
      try {
        slaveVideo.currentTime = target;
      } catch {
        /* 忽略 */
      }
    }
    if (slaveVideo.paused && target < (slaveVideo.duration || Infinity) - 0.04) {
      slaveVideo.play().catch(() => {});
    }
  }

  function pickDefaultTarget(others, cur) {
    if (!others.length) return null;
    // 默认选当前版本之前最近的一版（例如看 v2 就拿 v1 来比）；若当前就是最早版则选下一版
    const older = others.filter((v) => v.createdAt <= cur.createdAt);
    if (older.length) return older[older.length - 1];
    return others[0];
  }

  function open(preferredId) {
    const cur = getCurrentVideo();
    if (!cur) return false;
    const { others } = getSiblings();
    if (!others.length) {
      notify?.('当前项目里只有这一支片子，上传新版本后就能对比');
      return false;
    }

    const picked = (preferredId && others.find((v) => v.id === preferredId))
      || pickDefaultTarget(others, cur);
    if (!picked) return false;

    active = true;
    layer.hidden = false;
    toolbar.hidden = false;
    fillSelect();
    loadSlave(picked);
    if (selectEl) selectEl.value = picked.id;
    syncModeUI();
    onActiveChange?.(true);
    onLayoutChange?.();
    return true;
  }

  function close() {
    if (!active) return;
    active = false;
    targetVideo = null;
    offsetFrames = 0;
    restoreAudio();
    slaveVideo.pause();
    slaveVideo.removeAttribute('src');
    slaveVideo.load();
    layer.hidden = true;
    toolbar.hidden = true;
    syncModeUI();
    onActiveChange?.(false);
    onLayoutChange?.();
  }

  function setMode(next) {
    if (!['wipe', 'split', 'diff'].includes(next)) return;
    if (mode === next) return;
    mode = next;
    syncModeUI();
    onLayoutChange?.();
    sync(true);
  }

  function nudgeOffset(delta) {
    if (!active) return;
    offsetFrames = Math.max(-600, Math.min(600, offsetFrames + delta));
    updateOffsetUI();
    sync(true);
  }

  // ── 卷帘拉杆拖拽 ──
  if (handle && videoWrap) {
    const updateFromClientX = (clientX) => {
      const rect = videoWrap.getBoundingClientRect();
      if (rect.width < 20) return;
      splitPct = ((clientX - rect.left) / rect.width) * 100;
      applyWipeVisual();
    };
    handle.addEventListener('pointerdown', (event) => {
      if (!active || mode !== 'wipe') return;
      event.stopPropagation();
      event.preventDefault();
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      updateFromClientX(event.clientX);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      updateFromClientX(event.clientX);
    });
    const stopDrag = () => { dragging = false; };
    handle.addEventListener('pointerup', stopDrag);
    handle.addEventListener('pointercancel', stopDrag);
    handle.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      splitPct = 50;
      applyWipeVisual();
    });
  }

  // ── 工具栏控件绑定 ──
  for (const btn of modeButtons) {
    btn.addEventListener('click', () => setMode(btn.dataset.compareMode));
  }
  selectEl?.addEventListener('change', () => {
    const { others } = getSiblings();
    const found = others.find((v) => v.id === selectEl.value);
    if (found) loadSlave(found);
  });
  boostBtn?.addEventListener('click', () => {
    boost = !boost;
    syncModeUI();
  });
  audioBtn?.addEventListener('click', () => {
    if (!active) return;
    listenSlave = !listenSlave;
    applyAudioRouting();
    notify?.(listenSlave ? '已切到对照版声音' : '已切回当前版声音');
  });
  offsetBackBtn?.addEventListener('click', () => nudgeOffset(-1));
  offsetFwdBtn?.addEventListener('click', () => nudgeOffset(1));
  offsetLabel?.addEventListener('click', () => {
    if (offsetFrames === 0) return;
    offsetFrames = 0;
    updateOffsetUI();
    sync(true);
    notify?.('时间偏移已归零');
  });
  closeBtn?.addEventListener('click', close);

  // 主视频静音状态变更时同步声音路由
  masterVideo.addEventListener('volumechange', () => {
    if (active) applyAudioRouting();
  });
  masterVideo.addEventListener('ratechange', () => {
    if (active) sync(false);
  });

  return {
    get active() {
      return active;
    },
    get mode() {
      return mode;
    },
    open,
    close,
    toggle() {
      if (active) close();
      else open();
    },
    sync,
    refreshOptions() {
      if (!active) return;
      const { others } = getSiblings();
      if (!others.length) {
        close();
        return;
      }
      fillSelect();
      if (!targetVideo || !others.some((v) => v.id === targetVideo.id)) {
        loadSlave(others[0]);
        if (selectEl) selectEl.value = others[0].id;
      } else {
        syncBadges();
      }
    },
  };
}
