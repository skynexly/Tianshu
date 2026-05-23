// ==========================================================
//  心动模拟·第二部钩子动画（epilogue）
//  触发：阶段3 事件结束关键词命中"触发TE动画"
//  视觉：复用开场动画的"线上消息"气泡形式，往主聊天界面贴 5 条客服气泡
//  规则：
//   - 气泡只贴 DOM，不入 messages 数组、不存数据库（无证据）
//   - 5 条播完后黑闪 3 次
//   - 闪屏结束气泡 DOM 全部移除
//   - 显示一个全屏遮罩 + 居中"到此结束"按钮（必须点击，无法跳过）
//   - 点击后写 phoneData.hsPostHomeMode = 'epilogue'，遮罩消失
//   - AI 完全不知道这段动画发生过（hsPostHomeMode 字段在 _buildApiContext 里走 epilogue 分支）
// ==========================================================
(function () {
  let _playing = false;

  // 5 条客服消息（callback 开场动画的语气）
  const MESSAGES = [
    { text: '你醒了。', delayBefore: 800 },
    { text: '感谢您使用心动模拟APP，为了回馈老用户，本司将随机抽取优质用户，体验心动模拟的全新项目。', delayBefore: 1400 },
    { text: '恭喜您被选中参与，您将获得由本司提供的大型公馆的永久使用权。', delayBefore: 2000 },
    { text: '无需携带任何物品，心动模拟会为您准备好一切。', delayBefore: 2400 },
    { text: '祝您体验愉快。', delayBefore: 2800 }
  ];

  async function play() {
    if (_playing) return;
    _playing = true;

    try {
      // 拿世界观 iconImage 当客服头像（和开场一致）
      let serviceAvatar = '';
      try {
        const conv = (typeof Conversations !== 'undefined') ? Conversations.getList()?.find(c => c.id === Conversations.getCurrent()) : null;
        const wvId = conv?.worldviewId || conv?.singleWorldviewId || 'wv_heartsim';
        const wv = await DB.get('worldviews', wvId);
        serviceAvatar = wv?.iconImage || '';
      } catch (_) {}

      // 1. 创建外层"线上消息"气泡容器（贴在主聊天界面）
      const block = _createChatBlock();
      if (!block) { _playing = false; return; }

      // 2. 逐条推送
      for (const m of MESSAGES) {
        await new Promise(r => setTimeout(r, m.delayBefore));
        if (!document.body.contains(block)) { _playing = false; return; }
        _appendBubble(block, m, serviceAvatar);
        // 滚动到底
        const cm = document.getElementById('chat-messages');
        if (cm) cm.scrollTop = cm.scrollHeight;
      }

      // 3. 最后一条停留 2s
      await new Promise(r => setTimeout(r, 2000));

      // 4. 黑闪 3 次（每次 200ms 黑 + 200ms 亮，共 1.2s）
      await _blackFlash(3);

      // 5. 移除整个气泡块（无证据）
      try {
        const wrapper = document.getElementById('hs-epilogue-wrapper');
        if (wrapper) wrapper.remove();
      } catch (_) {}

      // 6. 弹强制按钮遮罩
      await _showForcedButton();

      // 7. 写 phoneData
      try {
        const pd = (typeof Phone !== 'undefined' && Phone._getPhoneData) ? await Phone._getPhoneData() : null;
        if (pd) {
          pd.hsPostHomeMode = 'epilogue';
          await Conversations.saveList();
        }
      } catch (e) { console.warn('[HSEpilogue] commit epilogue failed', e); }

      _playing = false;
    } catch (e) {
      console.error('[HSEpilogue] play error', e);
      _playing = false;
    }
  }

  // ===== 创建主聊天里的"线上消息"气泡块（不入 messages） =====
  function _createChatBlock() {
    const container = document.getElementById('chat-messages');
    if (!container) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'chat-msg assistant';
    wrapper.id = 'hs-epilogue-wrapper';
    wrapper.style.cssText = 'animation:hsNotifIn 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
    wrapper.innerHTML = `
      <div class="msg-body md-content">
        <div class="online-chat-block" id="hs-epilogue-chat-block">
          <div class="online-chat-divider"><span>线上消息</span></div>
        </div>
      </div>
    `;
    container.appendChild(wrapper);

    const cm = container;
    if (cm) cm.scrollTop = cm.scrollHeight;

    return document.getElementById('hs-epilogue-chat-block');
  }

  function _appendBubble(block, msg, avatarUrl) {
    const name = '心动模拟客服';
    const initial = name[0] || '?';
    const timeStr = _currentClock();

    const avatarHtml = avatarUrl
      ? `<img src="${Utils.escapeHtml(avatarUrl)}" class="online-chat-avatar" style="object-fit:cover">`
      : `<div class="online-chat-avatar">${Utils.escapeHtml(initial)}</div>`;

    const bubble = document.createElement('div');
    bubble.className = 'online-chat-bubble';
    bubble.style.cssText = 'animation:onlineChatIn 0.35s ease-out both';
    bubble.innerHTML = `
      <div class="online-chat-header">
        ${avatarHtml}
        <div class="online-chat-meta">
          <div class="online-chat-name">${Utils.escapeHtml(name)}</div>
          <div class="online-chat-time">${Utils.escapeHtml(timeStr)}</div>
        </div>
      </div>
      <div class="online-chat-text">${Utils.escapeHtml(msg.text)}</div>
    `;
    block.appendChild(bubble);
  }

  // ===== 黑闪 =====
  async function _blackFlash(times) {
    for (let i = 0; i < times; i++) {
      const flash = document.createElement('div');
      flash.style.cssText = 'position:fixed;inset:0;background:#000;z-index:99995;pointer-events:none;animation:hsEpFlash 0.4s ease-in-out';
      document.body.appendChild(flash);
      await new Promise(r => setTimeout(r, 400));
      flash.remove();
      await new Promise(r => setTimeout(r, 80));
    }
  }

  // ===== 强制按钮遮罩（必须点击才能解除） =====
  function _showForcedButton() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'hs-epilogue-forced';
      overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:99996;display:flex;align-items:center;justify-content:center;animation:hsEpForcedIn 0.6s ease-out';
      overlay.innerHTML = `
        <button class="hs-epilogue-end-btn">到此结束</button>
      `;
      // 拦截一切除按钮以外的点击
      overlay.addEventListener('click', (e) => {
        if (!e.target.closest('.hs-epilogue-end-btn')) {
          e.stopPropagation();
          e.preventDefault();
        }
      }, true);
      overlay.addEventListener('touchstart', (e) => {
        if (!e.target.closest('.hs-epilogue-end-btn')) {
          e.stopPropagation();
          e.preventDefault();
        }
      }, true);

      document.body.appendChild(overlay);

      const btn = overlay.querySelector('.hs-epilogue-end-btn');
      btn.addEventListener('click', () => {
        btn.disabled = true;
        overlay.style.animation = 'hsEpForcedOut 0.4s ease-in forwards';
        setTimeout(() => {
          overlay.remove();
          resolve();
        }, 400);
      });
    });
  }

  function _currentClock() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function isPlaying() { return _playing; }

  window.HeartSimEpilogue = { play, isPlaying };
})();
