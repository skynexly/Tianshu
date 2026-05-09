/**
 * 心动模拟开场动画 — 三阶段
 * 阶段1: 锁屏推送（黑底 + 时间 + 通知卡片逐条滑入）
 * 阶段2: 解锁后聊天界面（通知变气泡），输入框禁用，点击 → 面具创建弹窗
 * 阶段3: 规则说明气泡，结束后输入框解锁，用户回复 → 真正发给 AI
 */
const HeartSimIntro = (() => {
  let _active = false;
  let _config = null;
  let _phase = 0;
  let _convId = null;
  let _maskModalMode = 'new';
  let _existingMasksCache = [];
  let _maskModalOpening = false;
  let _phase3Running = false;
  let _introTranscript = [];
  let _introNpcAvatarMap = {};
  let _introNarrationText = '';
  let _newMaskAvatar = '';

  function isActive() { return _active && _phase < 4; }
  // 开场流程从触发到用户发送第一条正式消息前，禁止底栏切换面具
  function isMaskSwitchLocked() { return _active; }

  // 检查是否需要触发开场动画
  async function shouldTrigger() {
    try {
      const conv = Conversations.getList()?.find(c => c.id === Conversations.getCurrent());
      const wvIdFromConv = conv?.worldviewId || conv?.singleWorldviewId;
      const wvIdGlobal = (typeof Worldview !== 'undefined' && Worldview.getCurrentId) ? Worldview.getCurrentId() : null;
      const isHS = wvIdFromConv === 'wv_heartsim' || wvIdGlobal === 'wv_heartsim';
      if (!isHS) return false;
      const msgs = (typeof Chat !== 'undefined' && Chat.getMessages) ? Chat.getMessages() : [];
      const userMsgs = msgs.filter(m => m.role === 'user' || m.role === 'assistant');
      if (userMsgs.length > 0) return false;
      const sb = Conversations.getStatusBar();
      if (sb?.heartSim?.introDone) return false;
      return true;
    } catch(_) { return false; }
  }

  async function start() {
    if (_active) return;
    let wv = null;
    // 优先按当前对话绑定的世界观读取，避免新建对话瞬间 Worldview.getCurrent() 未初始化而读到内置旧占位
    try {
      const conv = Conversations.getList()?.find(c => c.id === Conversations.getCurrent());
      const boundWvId = conv?.worldviewId || conv?.singleWorldviewId;
      if (boundWvId) wv = await DB.get('worldviews', boundWvId);
    } catch(_) {}
    if (!wv) {
      try { wv = await Worldview.getCurrent(); } catch(_) {}
    }
    if (!wv) {
      try { wv = await DB.get('worldviews', 'wv_heartsim'); } catch(_) {}
    }
    if (!wv) {
      console.warn('[HSIntro] 无法获取世界观');
      return;
    }

    // 把"开场第一条消息"拆成多条客服消息
    // 拆分规则：用空行（\n\n）或 --- 分段，每段一条气泡
    const introMessages = _splitStartMessage(wv.startMessage || '');

    // 默认配置（可被 wv.heartSimIntro 覆盖）
    const defaults = {
      phase1_lockscreen: introMessages.length > 0
        ? introMessages.map(t => ({ content: t }))
        : [{ content: '【请在世界观"开场第一条消息"里填写客服文案，用空行分段】' }],
      phase2_maskHint: '默认您已同意本平台信息采集协议，请如实填写。',
      phase3_rules: [
        '【占位规则】身份信息已录入。这里会继续显示心动模拟客服的规则说明；0号填写正式文案后替换。'
      ],
      phase3_openingToAI: '玩家身份信息：{{mask}}。请根据startPlot开始第一轮剧情。',
      phase4_narration: ''
    };
    
    const customCfg = wv.heartSimIntro || {};
    // phase1 前置通知：优先使用世界观编辑里的「开场第一条消息」；为空时才使用 heartSimIntro.phase1_lockscreen
    const phase1FromStartMessage = introMessages.length > 0
      ? introMessages.map(t => ({ content: t }))
      : null;
    _config = {
      phase1_lockscreen: phase1FromStartMessage || customCfg.phase1_lockscreen || defaults.phase1_lockscreen,
      phase2_maskHint: '默认您已同意本平台信息采集协议，请如实填写。',
      phase3_rules: customCfg.phase3_rules || defaults.phase3_rules,
      phase3_openingToAI: customCfg.phase3_openingToAI || defaults.phase3_openingToAI,
      phase4_narration: customCfg.phase4_narration || defaults.phase4_narration
    };

    _convId = Conversations.getCurrent();
    _introTranscript = [];
    _active = true;
    _phase = 1;
    _showLockscreen(wv);
  }

  // 拆分开场消息：用空行 / --- 做段落分隔
  function _splitStartMessage(text) {
    if (!text || typeof text !== 'string') return [];
    // 先按 --- 拆（支持显式分隔符）
    let segments = text.split(/\n\s*---+\s*\n/);
    // 再按空行拆
    const result = [];
    segments.forEach(seg => {
      seg.split(/\n\s*\n/).forEach(part => {
        const trimmed = part.trim();
        if (trimmed) result.push(trimmed);
      });
    });
    return result;
  }

  // ===== 阶段1: 锁屏推送 =====
  function _showLockscreen(wv) {
    const overlay = document.createElement('div');
    overlay.id = 'hs-intro-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:99990;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding-top:18%;color:#fff;animation:hsFadeIn 0.6s ease;cursor:pointer;overflow:hidden';

    // 时间显示
    const startTime = wv.startTime || '';
    const clockMatch = startTime.match(/(\d{1,2}):(\d{2})/);
    const dateMatch = startTime.match(/\d{4}年\d{1,2}月\d{1,2}日/);
    const weekdayMatch = startTime.match(/星期[一二三四五六日天]/);
    const clockStr = clockMatch ? clockMatch[0] : '07:00';
    const dateStr = dateMatch ? dateMatch[0] : '';
    const weekdayStr = weekdayMatch ? weekdayMatch[0] : '';

    overlay.innerHTML = `
      <div style="font-size:14px;opacity:0.85;letter-spacing:1px;margin-bottom:4px">${weekdayStr}　${dateStr}</div>
      <div style="font-size:80px;font-weight:200;letter-spacing:2px;margin-bottom:60px;line-height:1">${clockStr}</div>
      <div id="hs-intro-notifs" style="width:90%;max-width:380px;display:flex;flex-direction:column;gap:10px"></div>
      <div id="hs-intro-hint" style="position:absolute;bottom:36px;left:0;right:0;text-align:center;font-size:12px;opacity:0;animation:hsFadeIn 0.6s ease 0.4s forwards">↑ 上滑解锁</div>
    `;

    document.body.appendChild(overlay);

    // 防抖：至少显示 1.2 秒后才响应解锁
    let canUnlock = false;
    setTimeout(() => { canUnlock = true; }, 1200);

    // 监听点击 / 上滑
    let touchStartY = 0;
    overlay.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
    overlay.addEventListener('touchend', e => {
      if (!canUnlock) return;
      const dy = touchStartY - (e.changedTouches[0]?.clientY || touchStartY);
      if (dy > 30) _unlockScreen();
    }, { passive: true });
    overlay.addEventListener('click', () => {
      if (!canUnlock) return;
      _unlockScreen();
    });

    // 逐条推送通知
    const notifsEl = overlay.querySelector('#hs-intro-notifs');
    const list = _config.phase1_lockscreen || [];
    let pushedCount = 0;
    function pushNext() {
      if (!_active || pushedCount >= list.length) return;
      const item = list[pushedCount];
      pushedCount++;
      const card = document.createElement('div');
      card.style.cssText = 'background:rgba(255,255,255,0.12);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:14px;padding:10px 14px;animation:hsNotifIn 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);overflow:hidden';
      const iconImg = wv.iconImage ? `<img src="${wv.iconImage}" style="width:18px;height:18px;border-radius:4px;object-fit:cover">` : `<span style="width:18px;height:18px;border-radius:4px;background:var(--accent);display:inline-flex;align-items:center;justify-content:center;font-size:12px">${wv.icon || '♡'}</span>`;
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;opacity:0.7;margin-bottom:3px">
          ${iconImg}
          <span>心动模拟</span>
          <span style="margin-left:auto">现在</span>
        </div>
        <div style="font-size:13px;line-height:1.5">${Utils.escapeHtml(item.content || '')}</div>
      `;
      notifsEl.appendChild(card);
      setTimeout(pushNext, 1100);
    }
    setTimeout(pushNext, 600);
  }

  // ===== 阶段2: 解锁 + 通知变气泡 =====
  async function _unlockScreen() {
    if (_phase !== 1) return;
    _phase = 2;
    const overlay = document.getElementById('hs-intro-overlay');
    if (overlay) {
      overlay.style.animation = 'hsSlideUp 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards';
      setTimeout(() => overlay.remove(), 500);
    }
    // 把 phase1 的通知作为 AI 气泡渲染（hidden 消息存数据库，避免发给 AI）
    const list = _config.phase1_lockscreen || [];
    for (const item of list) {
      await _appendIntroBubble(item.content || '');
    }
    // 锁定输入框 + 点击拦截
    _lockInput('请先完成信息采集');
  }

  // 阶段3：规则说明气泡
  async function _phase3Rules() {
    if (_phase3Running) return;
    _phase3Running = true;
    try {
      const rules = Array.isArray(_config.phase3_rules) && _config.phase3_rules.length > 0
        ? _config.phase3_rules
        : ['【占位规则】身份信息已录入。这里会继续显示心动模拟客服的规则说明；0号填写正式文案后替换。'];
      await new Promise(r => setTimeout(r, 500));
      for (const item of rules) {
        await new Promise(r => setTimeout(r, 600));
        if (typeof item === 'string') {
          await _appendIntroBubble(item);
        } else {
          await _appendIntroBubble(item.content || item.text || '', item.npc, item.avatarChar, item.avatarImg);
        }
      }
      // 解锁输入
      _unlockInput();
      _phase = 4;
      // 阶段4：旁白（不解锁前会被锁住，所以放在解锁后）
      await _phase4Narration();
    } catch(e) {
      console.error('[HSIntro] phase3 rules failed', e);
      UI.showToast('开场规则气泡显示失败：' + e.message, 3000);
      _unlockInput();
      _phase = 4;
    } finally {
      _phase3Running = false;
    }
  }

  // 阶段4：旁白（不带气泡的"普通AI正文"，跟在线上消息块下方）
  async function _phase4Narration() {
    try {
      const raw = _config?.phase4_narration;
      if (!raw) return;
      const list = Array.isArray(raw) ? raw : [String(raw)];
      const lines = list.map(s => String(s || '').trim()).filter(Boolean);
      if (lines.length === 0) return;

      await new Promise(r => setTimeout(r, 800));

      // 找到大气泡的 msg-body，把旁白追加进去（同一气泡内）
      const bigBubble = document.getElementById('hs-intro-big-bubble');
      const msgBody = bigBubble?.querySelector('.msg-body');
      if (!msgBody) return;

      const narration = document.createElement('div');
      narration.className = 'hs-intro-narration md-content';
      narration.style.cssText = 'animation:hsNotifIn 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)';
      narration.innerHTML = lines.map(t => `<p>${Utils.escapeHtml(t)}</p>`).join('');
      msgBody.appendChild(narration);

      // 同步存一条 hidden 消息，供回看 + 给 AI 看
      try {
        await DB.put('messages', {
          id: 'hsintro_narration_' + Utils.uuid().slice(0, 8),
          role: 'assistant',
          content: '',
          timestamp: Utils.timestamp(),
          hidden: true,
          _hsIntro: true,
          _hsIntroNarration: lines.join('\n'),
          conversationId: _convId
        });
      } catch(_) {}

      // 记录到 transcript（onFirstUserMessage 会用）
      _introNarrationText = lines.join('\n');

      const cm = document.getElementById('chat-messages');
      if (cm) cm.scrollTop = cm.scrollHeight;
    } catch(e) {
      console.warn('[HSIntro] phase4 narration failed', e);
    }
  }

  // 添加一条客服消息（复用"线上消息"气泡：外层大气泡 + 内层小气泡）
  async function _appendIntroBubble(text, npcName, avatarChar, avatarImg) {
    const name = npcName || '心动模拟客服';
    const avatarUrl = avatarImg || await _getOnlineNpcAvatar(name);
    const initial = avatarChar || name[0] || '?';
    if (text) _introTranscript.push({ name, text });
    // 生成当前时间（基于世界观 startTime 递增）
    const timeStr = _nextIntroTime();

    let bigBubble = document.getElementById('hs-intro-big-bubble');
    const currentContainer = document.getElementById('chat-messages');
    if (bigBubble && currentContainer && !currentContainer.contains(bigBubble)) {
      bigBubble.remove();
      bigBubble = null;
    }
    if (!bigBubble) {
      // 首次：创建一条外层 AI 气泡
      const container = currentContainer;
      if (!container) return;

      const wrapper = document.createElement('div');
      wrapper.className = 'chat-msg assistant';
      wrapper.id = 'hs-intro-big-bubble';
      wrapper.style.cssText = 'animation:hsNotifIn 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
      wrapper.innerHTML = `
        <div class="msg-body md-content">
          <div class="online-chat-block" id="hs-intro-chat-block">
            <div class="online-chat-divider"><span>线上消息</span></div>
          </div>
        </div>
      `;
      container.appendChild(wrapper);
      bigBubble = wrapper;
    }

    const block = document.getElementById('hs-intro-chat-block');
    if (!block) return;

    const avatarHtml = avatarUrl
      ? `<img src="${Utils.escapeHtml(avatarUrl)}" class="online-chat-avatar" style="object-fit:cover">`
      : `<div class="online-chat-avatar">${Utils.escapeHtml(initial)}</div>`;

    const bubble = document.createElement('div');
    bubble.className = 'online-chat-bubble';
    bubble.dataset.npcName = name;
    bubble.dataset.avatarChar = initial;
    bubble.style.cssText = 'animation:onlineChatIn 0.35s ease-out both';
    bubble.innerHTML = `
      <div class="online-chat-header">
        ${avatarHtml}
        <div class="online-chat-meta">
          <div class="online-chat-name">${Utils.escapeHtml(name)}</div>
          ${timeStr ? `<div class="online-chat-time">${Utils.escapeHtml(timeStr)}</div>` : ''}
        </div>
      </div>
      <div class="online-chat-text">${Utils.escapeHtml(text || '')}</div>
    `;
    block.appendChild(bubble);

    // 存一条隐藏消息用于后续会话回看（可选）
    try {
      const aiMsg = {
        id: 'hsintro_' + Utils.uuid().slice(0, 8),
        role: 'assistant',
        content: '',
        timestamp: Utils.timestamp(),
        hidden: true,
        _hsIntro: true,
        _hsIntroBubble: { name, text, time: timeStr, avatarImg: avatarUrl },
        conversationId: _convId
      };
      await DB.put('messages', aiMsg);
    } catch(_) {}

    // 滚动到底
    const cm = document.getElementById('chat-messages');
    if (cm) cm.scrollTop = cm.scrollHeight;

    return new Promise(r => setTimeout(r, 100));
  }

  // 心动模拟开场线上气泡头像：优先使用角色管理里的 NPC 自定义头像
  async function _getOnlineNpcAvatar(name) {
    const key = String(name || '').trim();
    if (!key) return '';
    if (Object.prototype.hasOwnProperty.call(_introNpcAvatarMap, key)) return _introNpcAvatarMap[key] || '';
    let url = '';
    try {
      const conv = (typeof Conversations !== 'undefined') ? Conversations.getList()?.find(c => c.id === Conversations.getCurrent()) : null;
      const wvId = conv?.worldviewId || conv?.singleWorldviewId || 'wv_heartsim';
      const wv = await DB.get('worldviews', wvId);
      if (key === '心动模拟客服' && wv?.iconImage) {
        _introNpcAvatarMap[key] = wv.iconImage;
        return wv.iconImage;
      }
      const wvs = wv ? [wv] : [];
      try {
        const all = await DB.getAll('worldviews');
        all.forEach(x => { if (x && x.id !== wvId) wvs.push(x); });
      } catch(_) {}
      for (const wvItem of wvs) {
        let npcId = '';
        const aliasesMatch = (n) => {
          const aliases = String(n.aliases || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
          return aliases.includes(key);
        };
        for (const n of (wvItem.globalNpcs || [])) {
          if ((n.name || '').trim() === key || aliasesMatch(n)) { npcId = n.id; url = n.avatar || ''; break; }
        }
        if (!npcId) {
          outer: for (const r of (wvItem.regions || [])) {
            for (const f of (r.factions || [])) {
              for (const n of (f.npcs || [])) {
                if ((n.name || '').trim() === key || aliasesMatch(n)) { npcId = n.id; url = n.avatar || ''; break outer; }
              }
            }
          }
        }
        if (npcId) {
          try {
            const av = await DB.get('npcAvatars', npcId);
            if (av && av.avatar) url = av.avatar;
          } catch(_) {}
          if (url) break;
        }
      }
    } catch(_) {}
    _introNpcAvatarMap[key] = url || '';
    return url || '';
  }

  async function refreshNpcAvatars() {
    _introNpcAvatarMap = {};
    const bubbles = document.querySelectorAll('#hs-intro-chat-block .online-chat-bubble[data-npc-name]');
    for (const bubble of bubbles) {
      const name = bubble.dataset.npcName || '';
      const initial = bubble.dataset.avatarChar || (name[0] || '?');
      const header = bubble.querySelector('.online-chat-header');
      if (!header) continue;
      const oldAvatar = header.querySelector('.online-chat-avatar');
      const url = await _getOnlineNpcAvatar(name);
      const html = url
        ? `<img src="${Utils.escapeHtml(url)}" class="online-chat-avatar" style="object-fit:cover">`
        : `<div class="online-chat-avatar">${Utils.escapeHtml(initial)}</div>`;
      if (oldAvatar) oldAvatar.outerHTML = html;
      else header.insertAdjacentHTML('afterbegin', html);
    }
  }

  // 递增时间（基于世界观 startTime，每条 +1 分钟）
  let _introMinuteCursor = null;
  function _nextIntroTime() {
    try {
      if (_introMinuteCursor === null) {
        const wv = Worldview.getCurrent?.();
        const st = (wv && wv.startTime) || _config?._startTime || '';
        const m = st.match(/(\d{1,2}):(\d{2})/);
        if (m) {
          _introMinuteCursor = parseInt(m[1]) * 60 + parseInt(m[2]);
        } else {
          _introMinuteCursor = 7 * 60;
        }
      } else {
        _introMinuteCursor += 1;
      }
      const h = Math.floor(_introMinuteCursor / 60) % 24;
      const mm = _introMinuteCursor % 60;
      return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    } catch(_) { return ''; }
  }

  // 锁输入框 + 点击触发面具创建
  function _lockInput(hintText) {
    const input = document.getElementById('chat-input');
    if (!input) return;
    input.readOnly = true;
    input.placeholder = hintText || '请先完成信息采集';
    input.style.opacity = '0.6';
    input.addEventListener('click', _onInputClickLocked);
    input.addEventListener('focus', _onInputClickLocked);
  }

  function _unlockInput() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    input.readOnly = false;
    input.placeholder = '输入消息…';
    input.style.opacity = '';
    input.removeEventListener('click', _onInputClickLocked);
    input.removeEventListener('focus', _onInputClickLocked);
  }

  function _onInputClickLocked(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const input = document.getElementById('chat-input');
    if (input) input.blur();
    if (_phase === 2) _showMaskModal();
  }

  function _removeMaskModals() {
    document.querySelectorAll('#hs-intro-mask-modal, .hs-intro-mask-modal').forEach(el => el.remove());
  }

  // ===== 阶段2.5: 面具快捷创建 / 选择 =====
  async function _showMaskModal() {
    // click/focus 在移动端会连发，防止并发创建双弹窗
    if (_maskModalOpening) return;
    if (document.getElementById('hs-intro-mask-modal')) return;
    _maskModalOpening = true;

    try {
      _removeMaskModals();

      _maskModalMode = 'new';
      _existingMasksCache = [];
      try {
        const data = await DB.get('gameState', 'maskList');
        const list = data?.value || [];
        const masks = list.filter(m => m.id && m.id !== 'default');
        _existingMasksCache = await Promise.all(masks.map(async m => {
          let detail = null;
          try { detail = await DB.get('characters', m.id); } catch(_) {}
          return {
...m,
name: detail?.name || m.name,
avatar: detail?.avatar || '',
preview: detail?.background || detail?.detail || detail?.description || ''
};
        }));
      } catch(_) {}

    const modal = document.createElement('div');
    modal.id = 'hs-intro-mask-modal';
    modal.className = 'modal hs-intro-mask-modal';
    modal.style.zIndex = '99995';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:380px">
        <h3 style="margin:0 0 8px">身份信息</h3>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">${Utils.escapeHtml(_config.phase2_maskHint || '默认您已同意本平台信息采集协议，请如实填写。')}</div>

        <div style="display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid var(--border)">
          <button id="hs-mask-tab-new" onclick="HeartSimIntro._switchMaskTab('new')" style="flex:1;background:none;border:none;border-bottom:2px solid var(--accent);color:var(--accent);padding:8px;font-size:13px;cursor:pointer">+ 新建</button>
          <button id="hs-mask-tab-pick" onclick="HeartSimIntro._switchMaskTab('pick')" style="flex:1;background:none;border:none;border-bottom:2px solid transparent;color:var(--text-secondary);padding:8px;font-size:13px;cursor:pointer">选择已有 ${_existingMasksCache.length > 0 ? '(' + _existingMasksCache.length + ')' : ''}</button>
        </div>

        <div id="hs-mask-content"></div>

        <div class="modal-actions" style="margin-top:16px">
          <button id="hs-mask-confirm-new" onclick="HeartSimIntro._submitMask()" style="flex:1;background:var(--accent);color:#111;border:none;border-radius:6px;padding:10px;font-size:14px;cursor:pointer">确认</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
      _renderMaskModalContent('new');
      setTimeout(() => document.getElementById('hs-mask-name')?.focus(), 100);
    } finally {
      _maskModalOpening = false;
    }
  }

  function _renderMaskModalContent(mode) {
    _maskModalMode = mode;
    const content = document.getElementById('hs-mask-content');
    const tabNew = document.getElementById('hs-mask-tab-new');
    const tabPick = document.getElementById('hs-mask-tab-pick');
    const btnConfirm = document.getElementById('hs-mask-confirm-new');
    if (!content) return;

    if (tabNew && tabPick) {
      const isNew = mode === 'new';
      tabNew.style.color = isNew ? 'var(--accent)' : 'var(--text-secondary)';
      tabNew.style.borderBottomColor = isNew ? 'var(--accent)' : 'transparent';
      tabPick.style.color = !isNew ? 'var(--accent)' : 'var(--text-secondary)';
      tabPick.style.borderBottomColor = !isNew ? 'var(--accent)' : 'transparent';
    }

    if (mode === 'new') {
if (btnConfirm) btnConfirm.style.display = '';
_newMaskAvatar = '';
content.innerHTML = `
<div style="display:flex;flex-direction:column;gap:10px">
  <div style="display:flex;align-items:center;gap:12px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary)">
    <div id="hs-mask-avatar-preview" onclick="HeartSimIntro._pickNewMaskAvatar()" style="width:54px;height:54px;border-radius:50%;background:var(--accent);color:#111;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;cursor:pointer;overflow:hidden;flex-shrink:0">+</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;color:var(--text);font-weight:600">上传头像</div>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">可选，点击左侧头像上传</div>
    </div>
    <input id="hs-mask-avatar-input" type="file" accept="image/*" style="display:none" onchange="HeartSimIntro._onNewMaskAvatarPicked(this)">
  </div>
  <label style="font-size:12px;color:var(--text-secondary)">姓名
    <input id="hs-mask-name" type="text" placeholder="请输入姓名" style="width:100%;padding:8px;font-size:14px;margin-top:4px">
  </label>
          <label style="font-size:12px;color:var(--text-secondary)">性别
            <input id="hs-mask-gender" type="text" placeholder="例：男 / 女 / 其他" style="width:100%;padding:8px;font-size:14px;margin-top:4px">
          </label>
          <label style="font-size:12px;color:var(--text-secondary)">年龄
            <input id="hs-mask-age" type="text" placeholder="例：22" style="width:100%;padding:8px;font-size:14px;margin-top:4px">
          </label>
          <label style="font-size:12px;color:var(--text-secondary)">身份
            <input id="hs-mask-identity" type="text" placeholder="例：大学生 / 律师 / 自由职业" style="width:100%;padding:8px;font-size:14px;margin-top:4px">
          </label>
        </div>
      `;
      return;
    }

    if (btnConfirm) btnConfirm.style.display = 'none';
    content.innerHTML = `
      <div style="max-height:320px;overflow-y:auto">
        ${_existingMasksCache.length === 0
          ? '<div style="text-align:center;color:var(--text-secondary);font-size:12px;padding:24px 0">还没有已创建的面具</div>'
          : _existingMasksCache.map(m => {
              const avatarHtml = m.avatar
? `<img src="${Utils.escapeHtml(m.avatar)}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0">`
: `<div style="width:32px;height:32px;border-radius:50%;background:var(--accent);color:#111;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0">${Utils.escapeHtml((m.name||'?')[0])}</div>`;
const preview = String(m.preview || '').replace(/\s+/g, ' ').trim();
const previewText = preview ? (preview.length > 52 ? preview.slice(0, 52) + '…' : preview) : '暂无面具设定';
return `
              <div data-mask-id="${Utils.escapeHtml(m.id)}" onclick="HeartSimIntro._pickExistingMask(this.dataset.maskId)" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px;cursor:pointer;display:flex;align-items:center;gap:10px;transition:background 0.15s">
                ${avatarHtml}
                <div style="flex:1;min-width:0">
                  <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.name || '未命名')}</div>
<div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.35">${Utils.escapeHtml(previewText)}</div>
                </div>
              </div>
            `}).join('')
        }
      </div>
    `;
  }

  function _pickNewMaskAvatar() {
  document.getElementById('hs-mask-avatar-input')?.click();
}

function _onNewMaskAvatarPicked(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const size = 128;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const min = Math.min(img.width, img.height);
      const sx = (img.width - min) / 2;
      const sy = (img.height - min) / 2;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
      _newMaskAvatar = canvas.toDataURL('image/jpeg', 0.82);
      const preview = document.getElementById('hs-mask-avatar-preview');
      if (preview) {
        preview.innerHTML = '';
        preview.style.background = `url("${_newMaskAvatar}") center/cover no-repeat`;
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

// tab 切换
  function _switchMaskTab(tab) {
    _renderMaskModalContent(tab === 'pick' ? 'pick' : 'new');
  }

  // 选择已有面具
  async function _pickExistingMask(maskId) {
    if (!maskId) return;
    try {
      if (typeof Character !== 'undefined' && Character.load) {
        await Character.load(maskId);
      }
      const mask = await DB.get('characters', maskId);
      UI.showToast(`已使用面具：${mask?.name || maskId}`, 2000);
    } catch(e) {
      UI.showToast('加载面具失败: ' + e.message, 3000);
      return;
    }
    _removeMaskModals();
    _phase = 3;
    await _phase3Rules();
  }

  async function _submitMask() {
    const name = document.getElementById('hs-mask-name')?.value.trim();
    const gender = document.getElementById('hs-mask-gender')?.value.trim();
    const age = document.getElementById('hs-mask-age')?.value.trim();
    const identity = document.getElementById('hs-mask-identity')?.value.trim();
    if (!name) { UI.showToast('请填写姓名', 1500); return; }

    // 创建面具（面具走 characters 表 + maskList 索引）
    const maskId = 'mask_hs_' + Utils.uuid().slice(0, 8);
    const description = `${gender ? '性别：' + gender : ''}${age ? '\n年龄：' + age : ''}${identity ? '\n身份：' + identity : ''}`.trim();
    const newMask = {
      id: maskId,
      name,
      background: description,
      abilities: [],
      inventory: [],
      avatar: _newMaskAvatar || '',
      created: Date.now()
    };
    try {
      // 1. 存面具数据
      await DB.put('characters', newMask);
// 2. 加入面具列表（Character 模块管理的索引）
        const list = await DB.get('gameState', 'maskList');
        const maskList = list?.value || [{ id: 'default', name: '默认面具' }];
        maskList.push({ id: maskId, name, worldviewId: 'wv_heartsim' });
        await DB.put('gameState', { key: 'maskList', value: maskList });
      // 3. 切换为当前面具
      if (typeof Character !== 'undefined' && Character.load) {
        await Character.load(maskId);
      }
      UI.showToast(`已创建面具：${name}`, 2000);
    } catch(e) {
      console.error('[HSIntro] 创建面具失败', e);
      UI.showToast('创建面具失败: ' + e.message, 3000);
      return;
    }

    // 关闭弹窗
    _removeMaskModals();
    // 进入阶段3
    _phase = 3;
    await _phase3Rules();
  }

  // 用户首次发送消息时调用 — 标记 introDone，并把开场剧情提示词追加给 AI
  async function onFirstUserMessage(originalText) {
 if (_phase !== 4) return originalText;
 let extra = originalText;
 try {
 const sb0 = Conversations.getStatusBar() || {};
 if (sb0?.heartSim?.introPromptSent) {
 _active = false;
 return originalText;
 }
 // 取当前面具（Character 模块维护 currentMaskId）
      let maskInfo = '';
      if (typeof Character !== 'undefined' && Character.getCurrentId) {
        const maskId = Character.getCurrentId();
        if (maskId) {
          const mask = await DB.get('characters', maskId);
          if (mask) {
            maskInfo = `${mask.name || ''}${mask.background ? '\n' + mask.background : ''}`;
          }
        }
      }
      const opening = (_config?.phase3_openingToAI || '').replace(/\{\{mask\}\}/g, maskInfo);
      const introText = _introTranscript.length > 0
        ? _introTranscript.map(m => `${m.name}：${m.text}`).join('\n')
        : '';
      const narrationText = (_introNarrationText || '').trim();
      const parts = [];
      if (introText) parts.push(`[开场动画中已经展示给玩家的心动模拟客服消息]\n以下客服消息出现在用户手机里的「心动模拟APP」软件界面内，以线上聊天气泡/通知消息形式呈现；不是脑内声音、不是幻听、不是旁白，也不是现实中有人开口说话。后续剧情如需提及，应描述为用户在手机APP中看到过这些客服消息。\n${introText}`);
      if (narrationText) parts.push(`[开场动画末尾已展示给玩家的旁白正文]\n以下文字以普通正文形式紧接在客服消息之后展示给玩家，作为客服消息结束、剧情正式开启的过渡。第一轮剧情请以这段旁白为起点继续推进，不要重复输出这段内容。\n${narrationText}`);
      if (opening) parts.push(opening);
      if (parts.length > 0) {
        extra = `${originalText}\n\n[系统提示]\n${parts.join('\n\n')}`;
      }
    } catch(_) {}
    // 标记完成
    try {
      const sb = Conversations.getStatusBar() || {};
      if (!sb.heartSim) sb.heartSim = { score: 0, tasks: [], targets: [] };
sb.heartSim.introDone = true;
sb.heartSim.introPromptSent = true;
await Conversations.setStatusBar(sb);
    } catch(_) {}
    _active = false;
    return extra;
  }

  // 取消开场（用户主动跳过 / 切对话 / 调试）
  function cancel() {
    _active = false;
    _phase = 0;
    _convId = null;
    _config = null;
    _introTranscript = [];
    _introNpcAvatarMap = {};
    _introNarrationText = '';
    _introMinuteCursor = null;
    document.getElementById('hs-intro-overlay')?.remove();
    _removeMaskModals();
    document.getElementById('hs-intro-big-bubble')?.remove();
    _unlockInput();
  }

  return {
    isActive, isMaskSwitchLocked, shouldTrigger, start, cancel, onFirstUserMessage, refreshNpcAvatars,
    _submitMask, _switchMaskTab, _pickExistingMask, _pickNewMaskAvatar, _onNewMaskAvatarPicked
  };
})();
window.HeartSimIntro = HeartSimIntro;