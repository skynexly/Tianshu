// ==========================================================
//  心动模拟·共同返航过场动画
//  触发：chat.js 检测到 parsed.homecomingCompanion 后 1.5s 调 play()
//  视觉：三阶段——心碎(粉色粒子) → 光隧道(金色汇聚) → 白光("欢迎回家。")
//  规则：
//   - 动画期间禁止任何点击/触摸
//   - 播完自动标记 hsPostHomeMode='companion' + 写 hidden 系统消息
//   - 整体约 10s
// ==========================================================
(function () {
  let _playing = false;
  const PARTICLE_COUNT = 36;

  async function play(companionName) {
    if (_playing) return;
    _playing = true;

    try {
      const overlay = _createOverlay();
      document.body.appendChild(overlay);

      // 阶段1：粉色心碎（~3s）
      await _phase1Shatter(overlay);

      // 阶段2：光隧道 + 同行者（~4s）
      await _phase2Tunnel(overlay, companionName);

      // 阶段3：白光 + 欢迎回家（~3s）
      await _phase3Home(overlay);

      // 标记 companion 模式
      try {
        if (typeof Phone !== 'undefined' && Phone.markHsHomecomingTriggered) {
          await Phone.markHsHomecomingTriggered([]);
        }
        const pd = (typeof Phone !== 'undefined' && Phone._getPhoneData)
          ? await Phone._getPhoneData() : null;
        if (pd) {
          pd.hsPostHomeMode = 'companion';
          pd.hsCompanion = companionName || '';
          await Conversations.saveList();
        }
      } catch (_) {}

      // hidden 系统消息
      try { await _appendHiddenMsg(companionName); } catch (_) {}

      // 淡出
      overlay.classList.add('hsc-leaving');
      await _wait(800);
      overlay.remove();
    } catch (e) {
      console.error('[HSCompanion] play error', e);
    } finally {
      _playing = false;
    }
  }

  // ── overlay ──
  function _createOverlay() {
    document.getElementById('hsc-overlay')?.remove();
    const el = document.createElement('div');
    el.id = 'hsc-overlay';
    el.className = 'hsc-overlay';
    const block = (e) => { e.stopPropagation(); e.preventDefault(); };
    el.addEventListener('click', block, true);
    el.addEventListener('touchstart', block, true);
    el.addEventListener('touchmove', block, true);
    el._blockHandlers = { block }; // 保存引用，供后续移除
    return el;
  }

  // ── 阶段1：心碎 ──
  async function _phase1Shatter(overlay) {
    // 粉色爱心浮现
    const heart = document.createElement('div');
    heart.className = 'hsc-heart';
    heart.innerHTML = '<svg viewBox="0 0 24 24" width="64" height="64"><path fill="#ff6b9d" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
    overlay.appendChild(heart);
    await _wait(1200);

    // 碎裂
    heart.classList.add('hsc-heart-shatter');
    const box = document.createElement('div');
    box.className = 'hsc-particle-box';
    overlay.appendChild(box);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = document.createElement('div');
      p.className = 'hsc-dot hsc-dot-burst';
      const angle = (Math.PI * 2 * i) / PARTICLE_COUNT + (Math.random() - 0.5) * 0.4;
      const dist = 100 + Math.random() * 220;
      p.style.setProperty('--tx', Math.cos(angle) * dist + 'px');
      p.style.setProperty('--ty', Math.sin(angle) * dist + 'px');
      p.style.animationDelay = (Math.random() * 0.25) + 's';
      p.style.animationDuration = (0.7 + Math.random() * 0.5) + 's';
      const h = 330 + Math.random() * 40, l = 65 + Math.random() * 25;
      p.style.background = `hsl(${h},80%,${l}%)`;
      p.style.boxShadow = `0 0 ${3 + Math.random() * 6}px hsl(${h},80%,${l}%)`;
      const sz = 3 + Math.random() * 5;
      p.style.width = p.style.height = sz + 'px';
      box.appendChild(p);
    }
    await _wait(1600);
    heart.remove();
    box.remove();
  }

  // ── 阶段2：光隧道 ──
  async function _phase2Tunnel(overlay, companionName) {
    const wrap = document.createElement('div');
    wrap.className = 'hsc-tunnel-wrap';
    overlay.appendChild(wrap);

    // 光点从四周汇聚到中心
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = document.createElement('div');
      p.className = 'hsc-dot hsc-dot-converge';
      const angle = (Math.PI * 2 * i) / PARTICLE_COUNT;
      const r = 280 + Math.random() * 180;
      p.style.setProperty('--sx', Math.cos(angle) * r + 'px');
      p.style.setProperty('--sy', Math.sin(angle) * r + 'px');
      p.style.animationDelay = (Math.random() * 1.2) + 's';
      p.style.animationDuration = (1.2 + Math.random() * 0.8) + 's';
      const h = 35 + Math.random() * 30, s = 60 + Math.random() * 40, l = 75 + Math.random() * 20;
      p.style.background = `hsl(${h},${s}%,${l}%)`;
      p.style.boxShadow = `0 0 ${4 + Math.random() * 8}px hsl(${h},${s}%,${l}%)`;
      const sz = 2 + Math.random() * 4;
      p.style.width = p.style.height = sz + 'px';
      wrap.appendChild(p);
    }

    // 径向光线（隧道感）
    const lines = document.createElement('div');
    lines.className = 'hsc-tunnel-rays';
    wrap.appendChild(lines);

    await _wait(1500);

    // 同行者文字
    const txt = document.createElement('div');
    txt.className = 'hsc-text';
    const cn = companionName || '???';
    txt.innerHTML = '检测到同行者：<span class="hsc-name">' + _esc(cn) + '</span>';
    overlay.appendChild(txt);

    await _wait(2500);

    wrap.classList.add('hsc-fade');
    txt.classList.add('hsc-fade');
    await _wait(600);
    wrap.remove();
    txt.remove();
  }

  // ── 阶段3：回家 ──
  async function _phase3Home(overlay) {
    const flash = document.createElement('div');
    flash.className = 'hsc-flash';
    overlay.appendChild(flash);

    await _wait(1000);

    const txt = document.createElement('div');
    txt.className = 'hsc-text hsc-text-final';
    txt.textContent = '欢迎回家。';
    overlay.appendChild(txt);

    await _wait(2000);

    // 点击确认才消失
    await new Promise((resolve) => {
      // 先移除阻止所有点击的 handler
      if (overlay._blockHandlers) {
        overlay.removeEventListener('click', overlay._blockHandlers.block, true);
        overlay.removeEventListener('touchstart', overlay._blockHandlers.block, true);
      }
      const hint = document.createElement('div');
      hint.className = 'hsc-tap-hint';
      hint.textContent = '点击继续';
      overlay.appendChild(hint);
      const handler = (e) => {
        e.stopPropagation();
        overlay.removeEventListener('click', handler, true);
        overlay.removeEventListener('touchstart', handler, true);
        resolve();
      };
      overlay.addEventListener('click', handler, true);
      overlay.addEventListener('touchstart', handler, true);
    });
  }

  // ── hidden 系统消息 ──
  async function _appendHiddenMsg(companionName) {
    const cn = companionName || '心动目标';
    const content = '[系统通知] 玩家已完成共同返航。前端刚刚为玩家展示了一段过场动画：心动模拟的图标碎裂成光点、光点汇聚成穿越隧道、画面显示「检测到同行者：' + cn + '」、最后白光中出现「欢迎回家。」\n玩家已带着' + cn + '一起回到了自己的世界。后续请将此事件视为已展示过，不需要重复描述动画过程。';
    const msg = {
      id: 'hscompanion_' + Utils.uuid().slice(0, 8),
      role: 'system',
      content,
      timestamp: Utils.timestamp(),
      hidden: true,
      _hsHomecoming: true,
      conversationId: Conversations.getCurrent()
    };
    try { await DB.put('messages', msg); } catch (_) {}
  }

  function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function _esc(s) { return typeof Utils !== 'undefined' && Utils.escapeHtml ? Utils.escapeHtml(s) : s; }
  function isPlaying() { return _playing; }

  window.HeartSimCompanion = { play, isPlaying };
})();
