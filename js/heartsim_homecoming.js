// ==========================================================
//  心动模拟·返航过场动画
//  触发：chat.js 流式完成后检测 parsed.homecoming，1.5s 后调 play()
//  视觉：复用开场动画 hs-intro-overlay 骨架，半屏锁屏 + 顶部下拉通知
//  规则：
//   - 动画期间禁止任何点击/上滑跳过
//   - 最后一条"亲爱的，你想去哪？"头像变纯黑剪影 + 文字深红 + 抖动
//   - 全部播完后等待用户点击或上滑，才滑出消失
//   - 关闭后：在主聊天区追加一条 hidden 系统消息，告诉 AI "返航动画已展示"
//   - 客服历史也会记录全部消息（含最后那条非客服）
// ==========================================================
(function () {
  let _playing = false;
  let _allowDismiss = false;

  // 动画消息序列（节奏从 600ms 一路拉到 5000ms，靠间隔放大死寂感）
  const MESSAGES = [
    { text: '恭喜你，你已经成功返航。', delayBefore: 600 },
    { text: '恭喜……',                 delayBefore: 1200 },
    { text: '……',                     delayBefore: 1800 },
    { text: '………',                    delayBefore: 2500 },
    { text: '…',                      delayBefore: 3500 },
    { text: '亲爱的，你想去哪？',       delayBefore: 5000, blackAvatar: true, warning: true }
  ];

  async function play() {
    if (_playing) return;
    _playing = true;
    _allowDismiss = false;

    try {
      // 拿世界观 iconImage 当客服头像
      let serviceAvatar = '';
      try {
        const conv = (typeof Conversations !== 'undefined') ? Conversations.getList()?.find(c => c.id === Conversations.getCurrent()) : null;
        const wvId = conv?.worldviewId || conv?.singleWorldviewId || 'wv_heartsim';
        const wv = await DB.get('worldviews', wvId);
        serviceAvatar = wv?.iconImage || '';
      } catch (_) {}

      _showOverlay(serviceAvatar);

      // 逐条推送
      const notifsEl = document.getElementById('hs-homecoming-notifs');
      if (!notifsEl) { _playing = false; return; }

      for (const m of MESSAGES) {
        await new Promise(r => setTimeout(r, m.delayBefore));
        if (!document.getElementById('hs-homecoming-overlay')) {
          // overlay 被外部移除（异常情况），中止
          _playing = false;
          return;
        }
        _appendNotif(notifsEl, m, serviceAvatar);
      }

      // 全部播完，允许用户点击/上滑关闭
      _allowDismiss = true;
      _bindDismissHandlers();

      // 标记已触发 + 把全部消息塞进客服历史
      try {
        if (typeof Phone !== 'undefined' && Phone.markHsHomecomingTriggered) {
          await Phone.markHsHomecomingTriggered(MESSAGES);
        }
      } catch (e) { console.warn('[HSHomecoming] mark failed', e); }

      // 给 AI 留一条 hidden 系统消息，告诉它玩家刚看到了什么
      try {
        await _appendHiddenSystemMsg();
      } catch (e) { console.warn('[HSHomecoming] hidden msg failed', e); }
    } catch (e) {
      console.error('[HSHomecoming] play error', e);
      _playing = false;
    }
  }

  function _showOverlay(serviceAvatar) {
    // 移除已有
    document.getElementById('hs-homecoming-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'hs-homecoming-overlay';
    overlay.className = 'hs-homecoming-overlay';
    overlay.innerHTML = `
      <div class="hs-homecoming-shade"></div>
      <div class="hs-homecoming-statusbar">
        <span class="hs-homecoming-time">${_currentClock()}</span>
        <span class="hs-homecoming-icons">··· 📶 🔋</span>
      </div>
      <div class="hs-homecoming-notifs" id="hs-homecoming-notifs"></div>
      <div class="hs-homecoming-hint" id="hs-homecoming-hint" style="display:none">点击或上滑关闭</div>
    `;
    document.body.appendChild(overlay);

    // 阻止任何冒泡到底层的点击/触摸：动画期间用户什么也做不了
    const blockEvent = (e) => {
      if (!_allowDismiss) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    overlay.addEventListener('click', blockEvent, true);
    overlay.addEventListener('touchstart', blockEvent, true);
    overlay.addEventListener('touchmove', blockEvent, true);
  }

  function _appendNotif(notifsEl, m, serviceAvatar) {
    const isBlack = !!m.blackAvatar;
    const warning = !!m.warning;
    const avatarHTML = isBlack
      ? `<div class="hs-homecoming-avatar hs-homecoming-avatar-black"></div>`
      : (serviceAvatar
        ? `<img class="hs-homecoming-avatar" src="${Utils.escapeHtml(serviceAvatar)}" alt="" />`
        : `<div class="hs-homecoming-avatar"></div>`);

    const node = document.createElement('div');
    node.className = 'hs-homecoming-notif' + (warning ? ' is-warning' : '');
    node.innerHTML = `
      <div class="hs-homecoming-notif-header">
        ${avatarHTML}
        <div class="hs-homecoming-notif-meta">
          <div class="hs-homecoming-notif-name">${isBlack ? '' : '心动模拟客服'}</div>
          <div class="hs-homecoming-notif-time">${_currentClock()}</div>
        </div>
      </div>
      <div class="hs-homecoming-notif-text">${Utils.escapeHtml(m.text)}</div>
    `;
    notifsEl.appendChild(node);
  }

  function _bindDismissHandlers() {
    const overlay = document.getElementById('hs-homecoming-overlay');
    if (!overlay) return;
    const hint = document.getElementById('hs-homecoming-hint');
    if (hint) hint.style.display = '';

    let touchStartY = null;
    const onClick = () => _dismiss();
    const onTouchStart = (e) => {
      touchStartY = e.touches?.[0]?.clientY ?? null;
    };
    const onTouchEnd = (e) => {
      if (touchStartY === null) return;
      const endY = e.changedTouches?.[0]?.clientY ?? touchStartY;
      // 上滑 60px 以上视为关闭
      if (touchStartY - endY > 60) _dismiss();
      touchStartY = null;
    };
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('touchstart', onTouchStart);
    overlay.addEventListener('touchend', onTouchEnd);
  }

  function _dismiss() {
    if (!_allowDismiss) return;
    const overlay = document.getElementById('hs-homecoming-overlay');
    if (!overlay) { _playing = false; return; }
    overlay.classList.add('hs-homecoming-leaving');
    setTimeout(() => {
      overlay.remove();
      _playing = false;
    }, 500);
  }

  // 写一条 hidden 系统消息，让 AI 知道玩家刚看到了什么
  async function _appendHiddenSystemMsg() {
    const lines = MESSAGES.map(m => {
      const sender = m.blackAvatar ? '（未知发件人，头像漆黑）' : '心动模拟客服';
      return `${sender}：${m.text}`;
    });
    const content = '[系统通知] 玩家已完成返航，前端刚刚为玩家展示了一段过场动画。该动画在玩家手机锁屏上以心动模拟客服推送通知的形式展开，节奏由急到缓再到死寂，依次推送以下消息：\n' +
      lines.map((l, i) => `${i + 1}. ${l}`).join('\n') +
      '\n\n注意：最后一条「亲爱的，你想去哪？」并不是心动模拟客服发出的——它的发件人头像是一片漆黑、来源不明，是悬念点。后续剧情请将此事件视为已对玩家展示过，不需要重复描述动画过程，但可以让玩家在剧情中保留这段印象。';

    const msg = {
      id: 'hshomecoming_' + Utils.uuid().slice(0, 8),
      role: 'system',
      content,
      timestamp: Utils.timestamp(),
      hidden: true,
      _hsHomecoming: true,
      conversationId: Conversations.getCurrent()
    };
    try {
      await DB.put('messages', msg);
      // 不调 appendMessage —— hidden 消息不应在 UI 显示
    } catch (_) {}
  }

  function _currentClock() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function isPlaying() { return _playing; }

  window.HeartSimHomecoming = { play, isPlaying };
})();
