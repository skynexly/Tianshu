/**
 * 天枢城账号系统 - 前端
 *
 * 流程：
 * 1. 启动时检查 localStorage 里是否有 token + device_id
 * 2. 有 → POST /check 验证；通过则放行，失败/被踢 → 弹登录页
 * 3. 没有 → 弹登录页
 * 4. 登录成功 → 存 token/device_id/email/nickname 到 localStorage
 * 5. 心跳：每 30 分钟 + 页面 visibilitychange 触发一次 check
 */
const Auth = (() => {
  const API = 'https://auth.skynexyl.com';
  const LS_KEY = 'tianshu_auth_v1';
  const HEARTBEAT_INTERVAL = 30 * 60 * 1000; // 30 min
  const MIN_HEARTBEAT_GAP = 5 * 60 * 1000; // 前台唤醒节流：距上次校验不足 5 分钟则跳过（省 KV 读）
  let _lastHeartbeatAt = 0;

  let _state = null;        // { token, device_id, email, nickname, devices }
  let _heartbeatTimer = null;

  // ===== localStorage =====
  function _loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch(_) { return null; }
  }
  function _saveState(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch(_) {}
  }
  function _clearState() {
    try { localStorage.removeItem(LS_KEY); } catch(_) {}
    _state = null;
  }

  // ===== 网络 =====
  async function _post(path, body) {
    const resp = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data;
    try { data = await resp.json(); } catch(_) { data = null; }
    return { status: resp.status, data };
  }

  // ===== 启动入口 =====
  async function init() {
    _state = _loadState();
    if (!_state || !_state.token || !_state.device_id) {
      _showLoginUI();
      return;
    }
    // 有缓存 → 验证一次
    try {
      const { status, data } = await _post('/check', { token: _state.token, device_id: _state.device_id });
      if (status === 200 && data?.ok) {
        // 通过，把最新设备列表更新到 state
        _state.devices = data.devices || [];
        // v683.3：以后端的 nickname 为准（覆盖本地缓存的）
        if (typeof data.nickname === 'string') _state.nickname = data.nickname;
        _saveState(_state);
        _onLoginSuccess();
        return;
      }
      // 没过 → 区分原因
      const reason = data?.reason || 'unknown';
      _clearState();
      if (reason === 'kicked') {
        _showLoginUI({ message: '你的账号已在另一台设备登录，本设备已被踢出。' });
      } else if (reason === 'token_invalid' || reason === 'account_gone') {
        _showLoginUI({ message: '登录已过期，请重新登录。' });
      } else {
        _showLoginUI();
      }
    } catch(e) {
      // 网络错误：网都没有页面也加载不出来，所以这里几乎不会触发。但兜底一下
      console.warn('[Auth] check failed', e);
      _showLoginUI({ message: '无法连接验证服务，请检查网络后刷新。' });
    }
  }

  function _onLoginSuccess() {
    _hideLoginUI();
    _startHeartbeat();
    _refreshAccountCard();
    // 派发自定义事件，让别处可以监听
    try { window.dispatchEvent(new CustomEvent('auth:ready', { detail: _state })); } catch(_) {}
  }

  // 同步设置页顶部那张账号入口卡片
  function _refreshAccountCard() {
    const nameEl = document.getElementById('auth-account-name');
    const emailEl = document.getElementById('auth-account-email');
    const avatarEl = document.getElementById('auth-account-avatar');
    if (!nameEl || !emailEl || !avatarEl) return;
    if (!_state) {
      nameEl.textContent = '未登录';
      emailEl.textContent = '—';
      avatarEl.textContent = '·';
      return;
    }
    nameEl.textContent = _state.nickname || _deriveNickname(_state.email) || '幽灵';
    emailEl.textContent = _state.email || '—';
    // 头像：优先 avatar dataUrl → 否则邮箱首字母
    if (_state.avatar) {
      avatarEl.innerHTML = `<img src="${_state.avatar}" alt="" />`;
    } else {
      const ch = (_state.nickname || _state.email || '·').trim().charAt(0);
      avatarEl.textContent = ch || '·';
    }
  }

  function _startHeartbeat() {
    if (_heartbeatTimer) clearInterval(_heartbeatTimer);
    _heartbeatTimer = setInterval(() => _heartbeat(), HEARTBEAT_INTERVAL);
    // 页面切回前台时 ping 一次（走节流，狂切窗口不会狂打后端）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') _heartbeat();
    });
  }

  // force=true 时跳过节流（登录成功、打开账号卡等需要立刻拿最新设备列表的场景）
  async function _heartbeat(force) {
    if (!_state?.token) return;
    // 前台唤醒节流：距上次校验不足 MIN_HEARTBEAT_GAP 就跳过，省 KV 读
    if (!force && Date.now() - _lastHeartbeatAt < MIN_HEARTBEAT_GAP) return;
    _lastHeartbeatAt = Date.now();
    try {
      const { status, data } = await _post('/check', { token: _state.token, device_id: _state.device_id });
      if (status === 200 && data?.ok) {
        _state.devices = data.devices || [];
        if (typeof data.nickname === 'string') _state.nickname = data.nickname;
        _saveState(_state);
        return;
      }
      // 被踢
      const reason = data?.reason || 'unknown';
      _clearState();
      if (_heartbeatTimer) clearInterval(_heartbeatTimer);
      const msg = reason === 'kicked'
        ? '你的账号在另一台设备登录，本设备已被踢出。'
        : '登录已过期，请重新登录。';
      _showKickedOverlay(msg);
    } catch(_) {}
  }

  // ===== UI =====
  function _ensureUI() {
    if (document.getElementById('auth-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.innerHTML = `
      <div class="auth-bg"></div>
      <div class="auth-card">
        <div class="auth-logo">
          <img src="logo.png" alt="The Skynex" />
        </div>
        <h1 class="auth-title">SKYNEX</h1>
        <div class="auth-quote">The still point where all worlds turn.</div>

        <div class="auth-tabs">
          <button type="button" class="auth-tab active" data-tab="login">登录</button>
          <button type="button" class="auth-tab" data-tab="register">注册</button>
        </div>

        <div class="auth-error" id="auth-error"></div>

        <div class="auth-form">
          <input id="auth-email" class="auth-input" type="email" placeholder="邮箱" autocomplete="email" spellcheck="false" />
          <div class="auth-input-wrap">
            <input id="auth-password" class="auth-input" type="password" placeholder="密码（至少 6 位）" autocomplete="current-password" />
            <button type="button" class="auth-pw-eye" id="auth-pw-eye" tabindex="-1" aria-label="显示/隐藏密码">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <input id="auth-nickname" class="auth-input auth-field-register" type="text" placeholder="昵称" maxlength="20" />
          <input id="auth-invite" class="auth-input auth-field-register" type="text" placeholder="邀请码" maxlength="20" autocapitalize="characters" />
          <input id="auth-device-name" class="auth-input" type="text" placeholder="本设备名称" maxlength="20" />
        </div>

        <button type="button" class="auth-submit" id="auth-submit">进入</button>
      </div>
    `;
    document.body.appendChild(overlay);

    // 默认设备名
    const ua = navigator.userAgent;
    let devName = 'Unknown';
    if (/iPhone/i.test(ua)) devName = 'iPhone';
    else if (/iPad/i.test(ua)) devName = 'iPad';
    else if (/Android/i.test(ua)) devName = 'Android';
    else if (/Mac/i.test(ua)) devName = 'Mac';
    else if (/Windows/i.test(ua)) devName = 'Windows';
    document.getElementById('auth-device-name').value = devName;

    // tab 切换
    overlay.querySelectorAll('.auth-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        overlay.classList.toggle('mode-register', btn.dataset.tab === 'register');
        _clearError();
      });
    });

    // 密码可见性切换
    const pwInput = document.getElementById('auth-password');
    const pwEye = document.getElementById('auth-pw-eye');
    const eyeOpen = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
    const eyeClosed = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';
    pwEye.addEventListener('click', () => {
      if (pwInput.type === 'password') {
        pwInput.type = 'text';
        pwEye.innerHTML = eyeClosed;
        pwEye.classList.add('on');
      } else {
        pwInput.type = 'password';
        pwEye.innerHTML = eyeOpen;
        pwEye.classList.remove('on');
      }
    });

    // 提交
    document.getElementById('auth-submit').addEventListener('click', _onSubmit);

    // 回车提交
    overlay.querySelectorAll('.auth-input').forEach(el => {
      el.addEventListener('keydown', e => { if (e.key === 'Enter') _onSubmit(); });
    });
  }

  function _showLoginUI(options) {
    _ensureUI();
    const overlay = document.getElementById('auth-overlay');
    overlay.classList.add('visible');
    if (options?.message) {
      _showError(options.message);
    } else {
      _clearError();
    }
    // 锁住背景滚动
    document.body.style.overflow = 'hidden';
  }

  function _hideLoginUI() {
    const overlay = document.getElementById('auth-overlay');
    if (!overlay) return;
    overlay.classList.add('fading-out');
    setTimeout(() => {
      overlay.classList.remove('visible', 'fading-out');
      document.body.style.overflow = '';
    }, 400);
  }

  function _showError(msg) {
    const el = document.getElementById('auth-error');
    if (el) { el.textContent = msg; el.classList.add('visible'); }
  }
  function _clearError() {
    const el = document.getElementById('auth-error');
    if (el) { el.textContent = ''; el.classList.remove('visible'); }
  }

  async function _onSubmit() {
    _clearError();
    const overlay = document.getElementById('auth-overlay');
    const isRegister = overlay.classList.contains('mode-register');
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const device_name = document.getElementById('auth-device-name').value.trim() || 'Unknown';
    const nickname = document.getElementById('auth-nickname').value.trim();
    const invite_code = document.getElementById('auth-invite').value.trim().toUpperCase();

    if (!email || !password) { _showError('请填写邮箱和密码'); return; }
    if (password.length < 6) { _showError('密码至少 6 位'); return; }
    if (isRegister) {
      if (!nickname) { _showError('请填写昵称'); return; }
      if (!invite_code) { _showError('请填写邀请码'); return; }
    }

    const btn = document.getElementById('auth-submit');
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = isRegister ? '正在注册…' : '正在登录…';

    try {
      const path = isRegister ? '/register' : '/login';
      const body = isRegister
        ? { invite_code, email, password, device_name, nickname }
        : { email, password, device_name };
      const { status, data } = await _post(path, body);

      if (status === 200 && data?.ok) {
        _state = {
          token: data.token,
          device_id: data.device_id,
          email: data.email,
          // v683.3：优先用后端返回的 nickname，没有再用本地缓存或 derive
          nickname: data.nickname || (isRegister ? nickname : (_state?.nickname || nickname || _deriveNickname(data.email))),
          devices: data.devices || [],
        };
        _saveState(_state);
        _onLoginSuccess();
        return;
      }

      // 409 → 需要踢人
      if (status === 409 && data?.need_kick) {
        _showKickPicker(data.devices, email, password, device_name);
        return;
      }

      _showError(data?.error || `${isRegister ? '注册' : '登录'}失败（${status}）`);
    } catch(e) {
      _showError('网络错误：' + (e.message || '请稍后再试'));
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  function _deriveNickname(email) {
    // 仅当邮箱前缀是合理的"看起来像名字"时才用作昵称
    // 纯数字（QQ邮箱）/ 过长 / 含特殊字符 → 返回空字符串，让上层回退到"欢迎回来"留空
    const local = (email || '').split('@')[0] || '';
    if (!local) return '';
    if (/^\d+$/.test(local)) return '';
    if (local.length > 12) return '';
    return local;
  }

  // ===== 设备满了：让用户挑一台踢 =====
  function _showKickPicker(devices, email, password, device_name) {
    let picker = document.getElementById('auth-kick-picker');
    if (picker) picker.remove();
    picker = document.createElement('div');
    picker.id = 'auth-kick-picker';
    picker.className = 'auth-kick-picker';

    const items = devices.map(d => {
      const lastSeen = _formatTime(d.last_seen);
      return `
        <button type="button" class="auth-kick-item" data-id="${d.id}">
          <div class="auth-kick-name">${_escape(d.name)}</div>
          <div class="auth-kick-meta">${_escape(d.ua_short || '')} · 上次活跃 ${lastSeen}</div>
        </button>
      `;
    }).join('');

    picker.innerHTML = `
      <div class="auth-kick-card">
        <div class="auth-kick-title">已达到设备上限</div>
        <div class="auth-kick-desc">每个账号最多在 2 台设备同时登录。请选择要踢出的设备：</div>
        ${items}
        <button type="button" class="auth-kick-cancel">取消</button>
      </div>
    `;
    document.body.appendChild(picker);

    picker.querySelectorAll('.auth-kick-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        const kick_device_id = btn.dataset.id;
        picker.remove();
        // 重新登录，附带 kick_device_id
        document.getElementById('auth-submit').disabled = true;
        document.getElementById('auth-submit').textContent = '正在登录…';
        try {
          const { status, data } = await _post('/login', { email, password, device_name, kick_device_id });
          if (status === 200 && data?.ok) {
            _state = {
              token: data.token,
              device_id: data.device_id,
              email: data.email,
              nickname: data.nickname || _state?.nickname || _deriveNickname(data.email),
              devices: data.devices || [],
            };
            _saveState(_state);
            _onLoginSuccess();
          } else {
            _showError(data?.error || '登录失败');
          }
        } catch(e) {
          _showError('网络错误：' + (e.message || '请稍后再试'));
        } finally {
          document.getElementById('auth-submit').disabled = false;
          document.getElementById('auth-submit').textContent = '进入';
        }
      });
    });
    picker.querySelector('.auth-kick-cancel').addEventListener('click', () => picker.remove());
  }

  function _formatTime(ts) {
    if (!ts) return '未知';
    const d = new Date(ts);
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return Math.floor(diff / 60_000) + ' 分钟前';
    if (diff < 86400_000) return Math.floor(diff / 3600_000) + ' 小时前';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function _formatLastExport() {
    const ts = (typeof DataMgr !== 'undefined' && DataMgr.getLastExportAt) ? DataMgr.getLastExportAt() : 0;
    if (!ts) return '从未导出';
    const diff = Date.now() - ts;
    if (diff < 60_000) return '上次：刚刚';
    if (diff < 3600_000) return '上次：' + Math.floor(diff / 60_000) + ' 分钟前';
    if (diff < 86400_000) return '上次：' + Math.floor(diff / 3600_000) + ' 小时前';
    if (diff < 30 * 86400_000) return '上次：' + Math.floor(diff / 86400_000) + ' 天前';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return '上次：' + `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '"', "'": '&#39;'
    }[c]));
  }

  // ===== 被踢的全屏蒙层 =====
  function _showKickedOverlay(msg) {
    let mask = document.getElementById('auth-kicked-mask');
    if (mask) mask.remove();
    mask = document.createElement('div');
    mask.id = 'auth-kicked-mask';
    mask.innerHTML = `
      <div class="auth-kicked-card">
        <div class="auth-kicked-icon">⌧</div>
        <div class="auth-kicked-title">已断开</div>
        <div class="auth-kicked-msg">${_escape(msg)}</div>
        <button type="button" id="auth-kicked-relogin">重新登录</button>
      </div>
    `;
    document.body.appendChild(mask);
    document.getElementById('auth-kicked-relogin').addEventListener('click', () => {
      mask.remove();
      _showLoginUI();
    });
  }

  // ===== 个人主页 =====
  function openProfile() {
    if (!_state) { _showLoginUI(); return; }
    let overlay = document.getElementById('auth-profile-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'auth-profile-overlay';
      overlay.innerHTML = `
        <div class="auth-bg"></div>
        <div class="auth-profile-scroll" id="auth-profile-scroll"></div>
      `;
      document.body.appendChild(overlay);
    }
    _renderProfile();
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
    // 静默刷一次最新设备列表（用户主动打开，force 跳过节流）
    _heartbeat(true);
  }

  function closeProfile() {
    const overlay = document.getElementById('auth-profile-overlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    document.body.style.overflow = '';
  }

  function _renderProfile() {
    const root = document.getElementById('auth-profile-scroll');
    if (!root || !_state) return;
    const nick = _state.nickname || _deriveNickname(_state.email) || '幽灵';
    const email = _state.email || '';
    const initial = (nick || email || '·').trim().charAt(0);
    const avatarInner = _state.avatar
      ? `<img src="${_state.avatar}" alt="" />`
      : _escape(initial);

    const devices = _state.devices || [];
    const thisId = _state.device_id;
    const devicesHtml = devices.length === 0
      ? `<div class="auth-profile-device"><div class="auth-profile-device-info"><div class="auth-profile-device-meta">无活跃设备</div></div></div>`
      : devices.map(d => {
          const isThis = d.id === thisId;
          return `
            <div class="auth-profile-device">
              <div class="auth-profile-device-info">
                <div class="auth-profile-device-name">
                  ${_escape(d.name || '未知设备')}
                  ${isThis ? '<span class="auth-profile-device-this">本机</span>' : ''}
                </div>
                <div class="auth-profile-device-meta">${_escape(d.ua_short || '')} · ${_formatTime(d.last_seen)}</div>
              </div>
              ${isThis ? '' : `<button class="auth-profile-device-kick" data-kick="${_escape(d.id)}">踢出</button>`}
            </div>
          `;
        }).join('');

    root.innerHTML = `
      <div class="auth-profile-top">
        <button class="auth-profile-back" id="auth-profile-back" aria-label="返回">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <div class="auth-profile-brand">SKYNEX</div>
      </div>

      <div class="auth-profile-hero">
        <div class="auth-profile-avatar" id="auth-profile-avatar" title="点击更换头像">${avatarInner}</div>
        <div class="auth-profile-name-block">
          <div class="auth-profile-name">
            <span id="auth-profile-name-text">${_escape(nick)}</span>
            <button class="auth-profile-name-edit" id="auth-profile-name-edit" aria-label="改昵称"${_isNicknameChanged() ? ' style="opacity:0.4"' : ''}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>
            </button>
          </div>
          <div class="auth-profile-email">${_escape(email)}</div>
        </div>
      </div>

      <div class="auth-profile-section-title">设备（${devices.length}/2）</div>
      <div class="auth-profile-list">
        ${devicesHtml}
      </div>

<div class="auth-profile-section-title">数据</div>
          <div class="auth-profile-list">
          <div class="auth-profile-item" id="auth-profile-storage" style="cursor:default;flex-direction:column;align-items:stretch">
            <div style="display:flex;align-items:center;width:100%">
              <div class="auth-profile-item-label">存储空间</div>
              <div class="auth-profile-item-value" id="auth-profile-storage-val" style="margin-right:0">统计中…</div>
            </div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">由浏览器估算，仅供参考</div>
          </div>
          <div class="auth-profile-item" id="auth-profile-export">
            <div class="auth-profile-item-label">导出存档</div>
            <div class="auth-profile-item-value" id="auth-profile-last-export">${_formatLastExport()}</div>
            <svg class="auth-profile-item-arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
          </div>
          <div class="auth-profile-item" id="auth-profile-export-text">
            <div class="auth-profile-item-label">导出存档（纯文字）</div>
            <div class="auth-profile-item-value">不含图片</div>
            <svg class="auth-profile-item-arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
          </div>
          <div class="auth-profile-item" id="auth-profile-export-lite">
            <div class="auth-profile-item-label">导出存档（轻量）</div>
            <div class="auth-profile-item-value">含头像·不含图库</div>
            <svg class="auth-profile-item-arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
          </div>
          <div class="auth-profile-item" id="auth-profile-image-mgr">
            <div class="auth-profile-item-label">图片存储管理</div>
            <div class="auth-profile-item-value" id="auth-profile-image-stat">查看占用</div>
            <svg class="auth-profile-item-arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
          <div class="auth-profile-item" id="auth-profile-import">
            <div class="auth-profile-item-label">导入存档</div>
            <svg class="auth-profile-item-arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
          </div>
          <div class="auth-profile-item" id="auth-profile-export-func">
            <div class="auth-profile-item-label">导出功能模型</div>
            <div class="auth-profile-item-value">仅 API 预设·防丢保险</div>
            <svg class="auth-profile-item-arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
          </div>
          <div class="auth-profile-item" id="auth-profile-import-func">
            <div class="auth-profile-item-label">导入功能模型</div>
            <div class="auth-profile-item-value">整组覆盖</div>
            <svg class="auth-profile-item-arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
          </div>
          <div class="auth-profile-item" id="auth-profile-restore-backup" style="display:none">
            <div class="auth-profile-item-label">恢复迁移前备份</div>
            <div class="auth-profile-item-value" id="auth-profile-restore-backup-info"></div>
            <svg class="auth-profile-item-arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          </div>
          <div class="auth-profile-item" id="auth-profile-cloud">
            <div class="auth-profile-item-label">云备份（Supabase）</div>
          <div class="auth-profile-item-value" id="auth-profile-cloud-status">${SupabaseBackup.isConfigured() ? '已配置' : '未配置'}</div>
          <svg class="auth-profile-item-arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>
      </div>

      <div class="auth-profile-section-title">账号</div>
      <div class="auth-profile-list">
        <div class="auth-profile-item" id="auth-profile-change-password">
          <div class="auth-profile-item-label">修改密码</div>
          ${_isPasswordChanged() ? '<div class="auth-profile-item-value">已修改</div>' : ''}
          <svg class="auth-profile-item-arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </div>
        <div class="auth-profile-item danger" id="auth-profile-logout">
          <div class="auth-profile-item-label">退出登录</div>
          <svg class="auth-profile-item-arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </div>
      </div>

      <div class="auth-profile-about">
        SKYNEX<br>
        The still point where all worlds turn.
      </div>
    `;

    // 事件绑定
    document.getElementById('auth-profile-back').addEventListener('click', closeProfile);
    document.getElementById('auth-profile-name-edit').addEventListener('click', _onEditNickname);
    document.getElementById('auth-profile-avatar').addEventListener('click', _onPickAvatar);
    document.getElementById('auth-profile-change-password').addEventListener('click', _onChangePassword);
    document.getElementById('auth-profile-logout').addEventListener('click', _onLogoutConfirm);
    document.getElementById('auth-profile-export').addEventListener('click', async () => {
      try {
        await DataMgr.exportAll();
        const el = document.getElementById('auth-profile-last-export');
        if (el) el.textContent = _formatLastExport();
      } catch(_) {}
    });
    document.getElementById('auth-profile-export-text').addEventListener('click', async () => {
      try {
        await DataMgr.exportTextOnly();
        const el = document.getElementById('auth-profile-last-export');
        if (el) el.textContent = _formatLastExport();
      } catch(_) {}
    });
    document.getElementById('auth-profile-export-lite').addEventListener('click', async () => {
      try {
        await DataMgr.exportLite();
        const el = document.getElementById('auth-profile-last-export');
        if (el) el.textContent = _formatLastExport();
      } catch(_) {}
    });
    document.getElementById('auth-profile-image-mgr').addEventListener('click', () => _openImageManager());
    _refreshImageStat();
    _refreshStorageEstimate();
    document.getElementById('auth-profile-import').addEventListener('click', () => DataMgr.importAll());
    document.getElementById('auth-profile-export-func')?.addEventListener('click', () => DataMgr.exportFuncModels());
    document.getElementById('auth-profile-import-func')?.addEventListener('click', () => DataMgr.importFuncModels());
    // 恢复迁移前备份：仅当存在备份时显示这一项
    (async () => {
      try {
        if (typeof Conversations === 'undefined' || !Conversations.getPreMigrationBackupInfo) return;
        const info = await Conversations.getPreMigrationBackupInfo();
        const row = document.getElementById('auth-profile-restore-backup');
        if (!info || !row) return;
        const infoEl = document.getElementById('auth-profile-restore-backup-info');
        const d = new Date(info.time || 0);
        const pad = n => String(n).padStart(2, '0');
        const timeStr = `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        if (infoEl) infoEl.textContent = `${timeStr}·${info.count}个对话`;
        row.style.display = '';
        row.addEventListener('click', async () => {
          const ok = await _modal({
            title: '恢复迁移前备份',
            desc: `将把对话列表还原到 ${timeStr} 的备份（共 ${info.count} 个对话）。\n当前的对话列表会被覆盖，聊天记录不受影响。确定恢复吗？`,
            okText: '恢复',
            danger: true,
          });
          if (!ok) return;
          const r = await Conversations.restorePreMigrationBackup();
          if (r && r.ok) {
            await _modal({ title: '恢复成功', desc: `已还原 ${r.count} 个对话。`, cancelText: false, okText: '好的' });
            try { location.reload(); } catch(_) {}
          } else {
            await _modal({ title: '恢复失败', desc: (r && r.error) || '未知错误', cancelText: false, okText: '好的' });
          }
        });
      } catch(_) {}
    })();
    document.getElementById('auth-profile-cloud').addEventListener('click', () => openCloudBackup());
    root.querySelectorAll('[data-kick]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.kick;
        const dev = (devices || []).find(d => d.id === id);
        const ok = await _modal({
          title: '踢出设备',
          desc: `确定踢出「${dev?.name || '该设备'}」吗？\n该设备会立刻被强制退出登录。`,
          okText: '踢出',
          danger: true,
        });
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = '踢出中…';
        const r = await kickDevice(id);
        if (r.ok) {
          _renderProfile();
          _refreshAccountCard();
        } else {
          await _modal({ title: '踢出失败', desc: r.error || '未知错误', cancelText: false, okText: '好的' });
          btn.disabled = false;
          btn.textContent = '踢出';
        }
      });
    });
  }

  // ===== 图片存储管理面板 =====
  function _fmtBytes(b) {
    if (!b) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function _fmtImgTime(t) {
    const ts = typeof t === 'string' ? Date.parse(t) || 0 : (t || 0);
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  let _imgMgrSelected = new Set();
  let _imgMgrNeedReload = false;

  async function _openImageManager() {
    let modal = document.querySelector('.auth-image-mgr');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.className = 'modal auth-image-mgr';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:none;width:100%;height:100%;max-height:100%;border-radius:0;display:flex;flex-direction:column;box-sizing:border-box">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-shrink:0">
          <h3 style="margin:0">图片存储管理</h3>
          <button type="button" data-act="close" style="background:none;border:none;color:var(--text-secondary);font-size:26px;line-height:1;cursor:pointer;padding:0 6px">×</button>
        </div>
        <div id="img-mgr-stat" style="font-size:12px;color:var(--text-secondary);line-height:1.7;margin-bottom:10px;flex-shrink:0">统计中…</div>
        <div id="img-mgr-scroll" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch">
          <div style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:8px">AI 生成图</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
            <button type="button" data-act="select-all" style="font-size:12px;padding:5px 10px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);cursor:pointer">全选</button>
            <button type="button" data-act="clear-sel" style="font-size:12px;padding:5px 10px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);cursor:pointer">取消选择</button>
            <button type="button" data-act="del-old" style="font-size:12px;padding:5px 10px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);cursor:pointer">删除30天前</button>
            <button type="button" data-act="del-sel" style="font-size:12px;padding:5px 10px;background:var(--danger);border:none;border-radius:6px;color:#fff;cursor:pointer;margin-left:auto">删除所选 (0)</button>
          </div>
          <div id="img-mgr-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;align-content:start">
            <p style="grid-column:1/-1;text-align:center;color:var(--text-secondary);padding:30px 0;font-size:13px">加载中…</p>
          </div>
          <div style="font-size:11px;color:var(--text-secondary);line-height:1.5;margin-top:8px">
            删除生成图只清理图库，聊天里的图会显示"图片已丢失"，不影响文字。
          </div>
          <div style="border-top:1px solid var(--border);margin:16px 0 8px;padding-top:14px">
            <div style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:4px">手机内联图片（按对话）</div>
            <div style="font-size:11px;color:var(--text-secondary);line-height:1.5;margin-bottom:10px">
              壁纸、头像、封面、卡背景、动态配图等直接存在各对话里。清理某项会清空该对话对应的图（恢复默认），无法恢复。仅统计上传的图片，外链 URL 不占空间。
            </div>
            <div id="img-mgr-phone">
              <p style="text-align:center;color:var(--text-secondary);padding:20px 0;font-size:13px">扫描中…</p>
            </div>
          </div>
          <div style="border-top:1px solid var(--border);margin:16px 0 8px;padding-top:14px">
            <div style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:4px">消息快照图片</div>
            <div style="font-size:11px;color:var(--text-secondary);line-height:1.5;margin-bottom:10px">
              每条 AI 回复会存一份手机数据快照用于回滚，旧版本快照可能把私聊原图固化进了消息里，导致存储膨胀。清理会遍历所有消息删除内联图片，<b>剧情正文、聊天记录全部保留，只删图</b>。消息多时会跑一会儿，别关页面。无法恢复。
            </div>
            <div id="img-mgr-msg-stat" style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">未扫描</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" data-act="msg-scan" style="font-size:12px;padding:6px 12px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text);cursor:pointer">扫描快照图片</button>
              <button type="button" data-act="msg-clean" disabled style="font-size:12px;padding:6px 12px;background:var(--danger);border:none;border-radius:6px;color:#fff;cursor:pointer;opacity:0.5">清理快照图片</button>
            </div>
          </div>
        </div>
      </div>
    `;
    const profileOverlay = document.getElementById('auth-profile-overlay');
    const host = (profileOverlay && profileOverlay.classList.contains('visible')) ? profileOverlay : document.body;
    host.appendChild(modal);

    _imgMgrSelected = new Set();
    _imgMgrNeedReload = false;

    const grid = modal.querySelector('#img-mgr-grid');
    const statEl = modal.querySelector('#img-mgr-stat');
    const delSelBtn = modal.querySelector('[data-act="del-sel"]');

    const refreshDelBtn = () => { delSelBtn.textContent = `删除所选 (${_imgMgrSelected.size})`; };

    const loadStats = async () => {
      try {
        const s = await DataMgr.getStorageStats();
        let phoneBytes = 0, phoneCount = 0;
        try {
          const ps = await DataMgr.scanPhoneImages();
          ps.forEach(c => { phoneBytes += c.total; phoneCount += Object.keys(c.cats).length; });
        } catch(_) {}
        const grand = s.total.bytes + phoneBytes;
        statEl.innerHTML =
          `生成图：${s.drawn.count} 张 · ${_fmtBytes(s.drawn.bytes)}<br>` +
          `头像（图库）：${s.avatars.count} 张 · ${_fmtBytes(s.avatars.bytes)}<br>` +
          `手机内联图：${_fmtBytes(phoneBytes)}<br>` +
          `<span style="color:var(--text);font-weight:600">合计：${_fmtBytes(grand)}</span>`;
      } catch(_) { statEl.textContent = '统计失败'; }
    };

    const renderGrid = async () => {
      let list = [];
      try { list = await DataMgr.listDrawnImages(); } catch(_) {}
      if (!list.length) {
        grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-secondary);padding:30px 0;font-size:13px">暂无生成图</p>';
        return;
      }
      grid.innerHTML = list.map(it => `
        <div class="img-mgr-cell" data-id="${_escape(it.id)}" style="position:relative;border-radius:8px;overflow:hidden;background:var(--bg-tertiary);cursor:pointer;aspect-ratio:1/1">
          <img data-imgid="${_escape(it.id)}" style="width:100%;height:100%;object-fit:cover;display:block" loading="lazy">
          <div class="img-mgr-check" style="position:absolute;top:4px;left:4px;width:18px;height:18px;border-radius:50%;border:2px solid #fff;background:rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center"></div>
          <div style="position:absolute;left:0;right:0;bottom:0;background:linear-gradient(transparent,rgba(0,0,0,0.7));color:#fff;font-size:9px;padding:8px 4px 3px;line-height:1.2">${_fmtBytes(it.bytes)}</div>
        </div>
      `).join('');
      // 懒加载缩略图：逐个取 dataUrl
      for (const img of grid.querySelectorAll('img[data-imgid]')) {
        const id = img.getAttribute('data-imgid');
        DataMgr.getDrawnImageData(id).then(url => { if (url) img.src = url; });
      }
      // 选择交互
      grid.querySelectorAll('.img-mgr-cell').forEach(cell => {
        cell.addEventListener('click', () => {
          const id = cell.getAttribute('data-id');
          const check = cell.querySelector('.img-mgr-check');
          if (_imgMgrSelected.has(id)) {
            _imgMgrSelected.delete(id);
            check.style.background = 'rgba(0,0,0,0.3)';
            check.innerHTML = '';
            cell.style.outline = '';
          } else {
            _imgMgrSelected.add(id);
            check.style.background = 'var(--accent)';
            check.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
            cell.style.outline = '2px solid var(--accent)';
          }
          refreshDelBtn();
        });
      });
    };

    modal.querySelector('[data-act="select-all"]').addEventListener('click', () => {
      grid.querySelectorAll('.img-mgr-cell').forEach(cell => {
        const id = cell.getAttribute('data-id');
        _imgMgrSelected.add(id);
        const check = cell.querySelector('.img-mgr-check');
        check.style.background = 'var(--accent)';
        check.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
        cell.style.outline = '2px solid var(--accent)';
      });
      refreshDelBtn();
    });
    modal.querySelector('[data-act="clear-sel"]').addEventListener('click', () => {
      _imgMgrSelected.clear();
      grid.querySelectorAll('.img-mgr-cell').forEach(cell => {
        const check = cell.querySelector('.img-mgr-check');
        check.style.background = 'rgba(0,0,0,0.3)';
        check.innerHTML = '';
        cell.style.outline = '';
      });
      refreshDelBtn();
    });
    delSelBtn.addEventListener('click', async () => {
      if (!_imgMgrSelected.size) { await _modal({ title: '提示', desc: '还没有选择图片', cancelText: false, okText: '好的' }); return; }
      const ok = await _modal({ title: '删除所选图片', desc: `确定删除 ${_imgMgrSelected.size} 张生成图？删除后聊天里这些图会显示"图片已丢失"，无法恢复。`, danger: true, okText: '删除' });
      if (!ok) return;
      const n = await DataMgr.deleteDrawnImages([..._imgMgrSelected]);
      _imgMgrSelected.clear();
      refreshDelBtn();
      await loadStats();
      await renderGrid();
      _refreshImageStat();
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast(`已删除 ${n} 张`, 1500);
    });
    modal.querySelector('[data-act="del-old"]').addEventListener('click', async () => {
      const ok = await _modal({ title: '删除30天前的生成图', desc: '确定删除 30 天前的所有生成图？无法恢复。', danger: true, okText: '删除' });
      if (!ok) return;
      const before = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const n = await DataMgr.deleteDrawnImagesBefore(before);
      _imgMgrSelected.clear();
      refreshDelBtn();
      await loadStats();
      await renderGrid();
      _refreshImageStat();
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast(`已删除 ${n} 张`, 1500);
    });

    // ---- 手机内联图片（按对话）----
    const phoneBox = modal.querySelector('#img-mgr-phone');
    const catLabels = {};
    try { (DataMgr.getPhoneImageCats() || []).forEach(c => { catLabels[c.key] = c.label; }); } catch(_) {}

    const renderPhone = async () => {
      let list = [];
      try { list = await DataMgr.scanPhoneImages(); } catch(_) {}
      if (!list.length) {
        phoneBox.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:20px 0;font-size:13px">没有内联图片占用</p>';
        return;
      }
      phoneBox.innerHTML = list.map(conv => {
        const catRows = Object.keys(conv.cats).map(k => `
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
            <span style="flex:1;font-size:12px;color:var(--text-secondary)">${_escape(catLabels[k] || k)} · ${_fmtBytes(conv.cats[k])}</span>
            <button type="button" data-clear-cat data-conv="${_escape(conv.convId)}" data-cat="${_escape(k)}" style="font-size:11px;padding:3px 9px;background:none;border:1px solid var(--border);border-radius:5px;color:var(--text-secondary);cursor:pointer">清理</button>
          </div>
        `).join('');
        return `
          <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="flex:1;font-size:13px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escape(conv.convName)}</span>
              <span style="font-size:12px;color:var(--accent)">${_fmtBytes(conv.total)}</span>
              <button type="button" data-clear-all data-conv="${_escape(conv.convId)}" style="font-size:11px;padding:3px 9px;background:var(--danger);border:none;border-radius:5px;color:#fff;cursor:pointer">全清</button>
            </div>
            ${catRows}
          </div>
        `;
      }).join('');

      // 单类别清理
      phoneBox.querySelectorAll('[data-clear-cat]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const convId = btn.getAttribute('data-conv');
          const cat = btn.getAttribute('data-cat');
          const ok = await _modal({ title: '清理图片', desc: `确定清理这个对话的「${catLabels[cat] || cat}」？该对话对应的图会被清空（恢复默认），无法恢复。`, danger: true, okText: '清理' });
          if (!ok) return;
          await DataMgr.clearPhoneImages(convId, [cat]);
          await loadStats(); _refreshImageStat();
          await renderPhone();
          _imgMgrNeedReload = true;
          if (typeof UI !== 'undefined' && UI.showToast) UI.showToast('已清理', 1500);
        });
      });
      // 整对话清理
      phoneBox.querySelectorAll('[data-clear-all]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const convId = btn.getAttribute('data-conv');
          const ok = await _modal({ title: '清理该对话全部内联图片', desc: '确定清空这个对话的所有壁纸/头像/封面/卡背景/动态配图？无法恢复。', danger: true, okText: '全部清理' });
          if (!ok) return;
          await DataMgr.clearPhoneImages(convId, null);
          await loadStats(); _refreshImageStat();
          await renderPhone();
          _imgMgrNeedReload = true;
          if (typeof UI !== 'undefined' && UI.showToast) UI.showToast('已清理', 1500);
        });
      });
    };

    // ---- 消息快照图片（messages 仓深度清理）----
    const msgStatEl = modal.querySelector('#img-mgr-msg-stat');
    const msgScanBtn = modal.querySelector('[data-act="msg-scan"]');
    const msgCleanBtn = modal.querySelector('[data-act="msg-clean"]');
    const setMsgClean = (on) => {
      msgCleanBtn.disabled = !on;
      msgCleanBtn.style.opacity = on ? '1' : '0.5';
    };
    msgScanBtn.addEventListener('click', async () => {
      msgScanBtn.disabled = true;
      const old = msgScanBtn.textContent;
      msgScanBtn.textContent = '扫描中…';
      msgStatEl.textContent = '扫描中，消息多时较久…';
      try {
        const r = await DataMgr.scanMessageImages();
        msgStatEl.innerHTML = `共 ${r.total} 条消息，其中 <b>${r.msgHit}</b> 条含内联图片，图片 <b>${r.count}</b> 处，约 <b>${_fmtBytes(r.freed)}</b>`;
        setMsgClean(r.count > 0);
      } catch (e) {
        msgStatEl.textContent = '扫描出错：' + (e.message || e);
      } finally {
        msgScanBtn.disabled = false;
        msgScanBtn.textContent = old;
      }
    });
    msgCleanBtn.addEventListener('click', async () => {
      const ok = await _modal({ title: '清理消息快照图片', desc: '确定清理所有消息里的内联图片？只删图片（主要是回滚快照里的图），剧情正文和聊天记录全部保留。无法恢复，建议先做过存档/云备份。', danger: true, okText: '清理' });
      if (!ok) return;
      setMsgClean(false);
      msgStatEl.textContent = '清理中，别关页面…';
      try {
        const r = await DataMgr.clearMessageImages();
        msgStatEl.innerHTML = `✅ 已清理 ${r.updated} 条消息共 ${r.count} 处图片，释放约 <b>${_fmtBytes(r.freed)}</b>`;
        await loadStats(); _refreshImageStat();
        _imgMgrNeedReload = true;
        if (typeof UI !== 'undefined' && UI.showToast) UI.showToast(`已清理 ${r.count} 处`, 1800);
      } catch (e) {
        msgStatEl.textContent = '清理出错：' + (e.message || e);
        setMsgClean(true);
      }
    });

    // 关闭面板时，如果清理过内联图，提示刷新（让 Conversations 内存 list 重新从 DB 加载，
    // 否则下次 saveList 会用内存里的旧数据覆盖，清理白做）
    const closeWithReload = () => {
      modal.remove();
      if (_imgMgrNeedReload) {
        _imgMgrNeedReload = false;
        _modal({ title: '清理完成', desc: '已清理手机内联图片。需要刷新页面让改动生效，是否现在刷新？', okText: '刷新', cancelText: '稍后' }).then(yes => {
          if (yes) location.reload();
        });
      }
    };
    modal.querySelector('[data-act="close"]').addEventListener('click', closeWithReload);
    modal.addEventListener('click', e => { if (e.target === modal) closeWithReload(); });

    await loadStats();
    await renderGrid();
    await renderPhone();
  }

  // 刷新数据区"图片存储管理"那行的占用文字
  async function _refreshImageStat() {
    const el = document.getElementById('auth-profile-image-stat');
    if (!el) return;
    try {
      const s = await DataMgr.getStorageStats();
      let phoneBytes = 0;
      try {
        const ps = await DataMgr.scanPhoneImages();
        ps.forEach(c => { phoneBytes += c.total; });
      } catch(_) {}
      el.textContent = _fmtBytes(s.total.bytes + phoneBytes);
    } catch(_) {}
  }

  // 刷新数据区"存储空间"那行：显示浏览器 IndexedDB 已用 / 配额
  async function _refreshStorageEstimate() {
    const el = document.getElementById('auth-profile-storage-val');
    if (!el) return;
    try {
      const e = await DataMgr.getStorageEstimate();
      if (!e.supported || !e.quota) { el.textContent = '无法获取'; return; }
      const pct = Math.round((e.usage / e.quota) * 100);
      el.textContent = `${_fmtBytes(e.usage)} / ${_fmtBytes(e.quota)}（${pct}%）`;
    } catch(_) { el.textContent = '无法获取'; }
  }


  // opts = { title, desc, input, defaultValue, placeholder, maxLength, validate,
  //          okText, cancelText, danger }
  // 返回 Promise：confirm/alert → resolve(true/false)；prompt → resolve(string|null)
  // ===== 云备份（Supabase）面板 =====
  function openCloudBackup() {
    const existing = document.getElementById('cloud-backup-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'cloud-backup-overlay';
    overlay.className = 'modal';
    overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:100000';

    const cfg = SupabaseBackup.getConfig();

    overlay.innerHTML = `
      <div class="modal-content" style="max-width:440px;max-height:88vh;overflow-y:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <h3 style="margin:0">云备份（Supabase）</h3>
          <button type="button" id="cb-close" style="background:none;border:none;color:var(--text-secondary);font-size:22px;line-height:1;cursor:pointer;padding:0 4px">×</button>
        </div>
        <p style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin:0 0 14px">
          用你自己的 Supabase 项目存/取存档。数据只保存在你自己的数据库里，skynex 不经手。
          <a href="#" id="cb-guide" style="color:var(--accent);text-decoration:none">查看配置教程 ›</a>
        </p>

        <div class="auth-profile-section-title" style="margin-top:0">连接配置</div>
        <div class="form-group" style="margin-bottom:8px">
          <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">Project URL</label>
          <input type="text" id="cb-url" placeholder="https://xxxx.supabase.co" value="${_escape(cfg.url)}" style="width:100%" />
        </div>
        <div class="form-group" style="margin-bottom:8px">
          <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">anon key（公开密钥）</label>
          <input type="password" id="cb-key" placeholder="eyJhbGci..." value="${_escape(cfg.key)}" style="width:100%" />
        </div>
        <div class="form-group" style="margin-bottom:8px">
          <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">备注（可选，标记这台设备/存档）</label>
          <input type="text" id="cb-device" maxlength="40" placeholder="如：主力机" value="${_escape(cfg.device)}" style="width:100%" />
        </div>
        <div style="display:flex;gap:8px;margin-bottom:6px">
          <button type="button" id="cb-test" style="flex:1;background:none;border:1px solid var(--border);color:var(--text);padding:9px;border-radius:8px;cursor:pointer;font-size:13px">测试连接</button>
          <button type="button" id="cb-save" style="flex:1;background:var(--accent);color:#111;border:none;padding:9px;border-radius:8px;cursor:pointer;font-size:13px">保存配置</button>
        </div>
        <div id="cb-conn-msg" style="font-size:12px;min-height:16px;margin-bottom:10px"></div>

        <div class="auth-profile-section-title">备份到云端</div>
        <p style="font-size:11px;color:var(--text-secondary);line-height:1.6;margin:0 0 8px">
          单个备份压缩后需小于 50MB（Supabase 免费版限制），超出会上传失败。完整存档含生成图库，图片多时容易超限；可先用上方「图片存储管理」清理，或改用「轻量」（含头像）/「纯文字」。超大存档建议用页面底部的本地导出保存。
        </p>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:6px">
          <button type="button" class="cb-backup-btn" data-mode="lite" style="width:100%;background:none;border:1px solid var(--border);color:var(--text);padding:10px;border-radius:8px;cursor:pointer;font-size:13px;text-align:left">备份·轻量（含头像，不含图库）<span style="float:right;color:var(--text-secondary)">推荐</span></button>
          <button type="button" class="cb-backup-btn" data-mode="text" style="width:100%;background:none;border:1px solid var(--border);color:var(--text);padding:10px;border-radius:8px;cursor:pointer;font-size:13px;text-align:left">备份·纯文字（不含任何图片）</button>
          <button type="button" class="cb-backup-btn" data-mode="full" style="width:100%;background:none;border:1px solid var(--border);color:var(--text);padding:10px;border-radius:8px;cursor:pointer;font-size:13px;text-align:left">备份·完整（含全部图片，可能很大）</button>
        </div>
        <div id="cb-backup-msg" style="font-size:12px;min-height:16px;margin-bottom:10px"></div>

        <div class="auth-profile-section-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>云端备份列表</span>
          <button type="button" id="cb-refresh" style="background:none;border:none;color:var(--accent);font-size:12px;cursor:pointer;padding:0">刷新</button>
        </div>
        <div id="cb-list" style="font-size:13px;color:var(--text-secondary);padding:6px 0">未加载</div>
      </div>
    `;

    const host = (function(){
      const po = document.getElementById('auth-profile-overlay');
      return (po && po.classList.contains('visible')) ? po : document.body;
    })();
    host.appendChild(overlay);

    const $ = (id) => overlay.querySelector(id);
    const setMsg = (el, text, ok) => {
      el.textContent = text || '';
      el.style.color = ok === true ? 'var(--accent)' : (ok === false ? 'var(--danger)' : 'var(--text-secondary)');
    };

    const close = () => overlay.remove();
    $('#cb-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    $('#cb-guide').addEventListener('click', (e) => { e.preventDefault(); _showSupabaseGuide(); });

    $('#cb-test').addEventListener('click', async () => {
      const url = $('#cb-url').value.trim();
      const key = $('#cb-key').value.trim();
      const msg = $('#cb-conn-msg');
      setMsg(msg, '测试中…', null);
      try {
        await SupabaseBackup.testConnection(url, key);
        setMsg(msg, '连接成功，表和权限都正常', true);
      } catch (err) {
        setMsg(msg, '失败：' + (err.message || err), false);
      }
    });

    $('#cb-save').addEventListener('click', () => {
      SupabaseBackup.setConfig($('#cb-url').value, $('#cb-key').value, $('#cb-device').value);
      setMsg($('#cb-conn-msg'), '已保存配置', true);
      const st = document.getElementById('auth-profile-cloud-status');
      if (st) st.textContent = SupabaseBackup.isConfigured() ? '已配置' : '未配置';
    });

    overlay.querySelectorAll('.cb-backup-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mode = btn.dataset.mode;
        const msg = $('#cb-backup-msg');
        // 备份前先把当前输入的配置存下来
        SupabaseBackup.setConfig($('#cb-url').value, $('#cb-key').value, $('#cb-device').value);
        if (!SupabaseBackup.isConfigured()) { setMsg(msg, '请先填写并保存配置', false); return; }
        overlay.querySelectorAll('.cb-backup-btn').forEach(b => b.disabled = true);
        setMsg(msg, '正在生成存档并上传…（完整存档可能较久）', null);
        try {
          const row = await SupabaseBackup.backup(mode, $('#cb-device').value.trim(), (stage) => setMsg(msg, stage, null));
          setMsg(msg, '备份成功' + (row && row.id ? '（#' + row.id + '）' : ''), true);
          _loadCloudList(overlay);
        } catch (err) {
          setMsg(msg, '备份失败：' + (err.message || err), false);
        } finally {
          overlay.querySelectorAll('.cb-backup-btn').forEach(b => b.disabled = false);
        }
      });
    });

    $('#cb-refresh').addEventListener('click', () => _loadCloudList(overlay));

    // 已配置则自动拉一次列表
    if (SupabaseBackup.isConfigured()) _loadCloudList(overlay);
  }

  async function _loadCloudList(overlay) {
    const listEl = overlay.querySelector('#cb-list');
    if (!listEl) return;
    listEl.textContent = '加载中…';
    let rows;
    try {
      rows = await SupabaseBackup.listBackups(20);
    } catch (err) {
      listEl.innerHTML = `<span style="color:var(--danger)">加载失败：${_escape(err.message || String(err))}</span>`;
      return;
    }
    if (!rows || !rows.length) {
      listEl.textContent = '还没有云端备份';
      return;
    }
    const modeLabel = { full: '完整', lite: '轻量', text: '纯文字' };
    listEl.innerHTML = rows.map(r => {
      const t = r.created_at ? new Date(r.created_at).toLocaleString() : '';
      const dev = r.device ? ('· ' + _escape(r.device)) : '';
      const sz = (typeof r.size === 'number' && r.size > 0) ? (' · ' + _fmtBytes(r.size)) : '';
      return `
        <div class="auth-profile-item" style="align-items:center" data-row-id="${r.id}">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--text)">${_escape(modeLabel[r.mode] || r.mode || '存档')}${_escape(sz)} ${dev}</div>
            <div style="font-size:11px;color:var(--text-secondary)">${_escape(t)} · #${r.id}</div>
          </div>
          <button type="button" class="cb-restore" data-id="${r.id}" style="background:var(--accent);color:#111;border:none;padding:6px 12px;border-radius:7px;cursor:pointer;font-size:12px;margin-right:6px">恢复</button>
          <button type="button" class="cb-del" data-id="${r.id}" style="background:none;border:1px solid var(--border);color:var(--text-secondary);padding:6px 10px;border-radius:7px;cursor:pointer;font-size:12px">删除</button>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.cb-restore').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const ok = await _modal({
          title: '从云端恢复',
          desc: '将用这份云端备份覆盖当前设备的数据（覆盖范围取决于备份类型）。此操作不可撤销，确定继续？',
          okText: '恢复', danger: true
        });
        if (!ok) return;
        btn.disabled = true; btn.textContent = '恢复中…';
        try {
          await SupabaseBackup.restoreBackup(id);
          await _modal({ title: '恢复成功', desc: '数据已从云端恢复，页面将自动刷新。', okText: '好', cancelText: false });
          // reload 前兜底等一小会，确保落盘（importFromData 内已有 DB.flush，这里双保险）
          await new Promise(r => setTimeout(r, 150));
          location.reload();
        } catch (err) {
          btn.disabled = false; btn.textContent = '恢复';
          await _modal({ title: '恢复失败', desc: err.message || String(err), okText: '好', cancelText: false });
        }
      });
    });

    listEl.querySelectorAll('.cb-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const ok = await _modal({ title: '删除备份', desc: '确定从云端删除这份备份吗？此操作不可撤销。', okText: '删除', danger: true });
        if (!ok) return;
        btn.disabled = true;
        try {
          await SupabaseBackup.deleteBackup(id);
          _loadCloudList(overlay);
        } catch (err) {
          btn.disabled = false;
          await _modal({ title: '删除失败', desc: err.message || String(err), okText: '好', cancelText: false });
        }
      });
    });
  }

  function _showSupabaseGuide() {
    const existing = document.getElementById('cb-guide-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'cb-guide-overlay';
    overlay.className = 'modal';
    overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:100001';
    const sql = `-- 1) 备份索引表（只存元信息，存档本体放 Storage）
create table if not exists tianshu_saves (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  device text,
  mode text,
  path text,
  size bigint
);
alter table tianshu_saves enable row level security;
create policy "anon full access"
  on tianshu_saves for all
  to anon
  using (true) with check (true);

-- 2) 存档文件桶（私有，存放存档本体，支持大文件）
insert into storage.buckets (id, name, public)
values ('tianshu-saves', 'tianshu-saves', false)
on conflict (id) do nothing;

-- 3) 让持 key 的人能读写这个桶
create policy "anon saves bucket"
  on storage.objects for all
  to anon
  using (bucket_id = 'tianshu-saves')
  with check (bucket_id = 'tianshu-saves');`;
    overlay.innerHTML = `
      <div class="modal-content" style="max-width:460px;max-height:88vh;overflow-y:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <h3 style="margin:0">Supabase 配置教程</h3>
          <button type="button" id="cbg-close" style="background:none;border:none;color:var(--text-secondary);font-size:22px;line-height:1;cursor:pointer;padding:0 4px">×</button>
        </div>
        <div style="font-size:13px;color:var(--text);line-height:1.75">
          <p style="margin:0 0 6px;color:var(--text-secondary);font-size:12px">Supabase 是免费的云数据库服务。下面每一步照做即可，全程约 5 分钟。</p>

          <p style="margin:10px 0 4px"><b>第 1 步 · 注册并建项目</b></p>
          <p style="margin:0 0 6px;font-size:12px">打开 <a href="https://supabase.com" target="_blank" style="color:var(--accent)">supabase.com</a>，用邮箱或 GitHub 注册登录。</p>
          <p style="margin:0 0 6px;font-size:12px">① 首次会让你建一个「组织（Organization）」：名字随便填，Type 选 <b>Personal</b>，套餐选 <b>Free（免费）</b>，点 Create。</p>
          <p style="margin:0 0 6px;font-size:12px">② 然后点 <b>New Project</b> 建项目：填项目名、设一个数据库密码（自己记着，后面用不到但别丢）、区域选离你近的（如 Southeast Asia / Northeast Asia）。</p>
          <p style="margin:0 0 10px;font-size:12px;color:var(--text-secondary)">建项目要等 1-2 分钟。状态先显示 Unhealthy（初始化中）是正常的，等它变绿（Healthy）再往下。</p>

          <p style="margin:10px 0 4px"><b>第 2 步 · 建表和存储桶</b></p>
          <p style="margin:0 0 6px;font-size:12px">项目变绿后，点左侧的 <b>SQL Editor</b>（图标像 <code>&gt;_</code>）。把下面这段整个复制粘贴进去，点右下角 <b>Run</b> 运行：</p>
          <pre id="cbg-sql" style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:11px;line-height:1.5;overflow-x:auto;white-space:pre;color:var(--text)">${_escape(sql)}</pre>
          <button type="button" id="cbg-copy" style="background:none;border:1px solid var(--border);color:var(--accent);padding:6px 12px;border-radius:7px;cursor:pointer;font-size:12px;margin-bottom:8px">复制 SQL</button>
          <p style="margin:0 0 6px;font-size:12px">看到 <b>Success. No rows returned</b> 就成功了。</p>
          <p style="margin:0 0 10px;font-size:12px;color:var(--text-secondary)">⚠ 手机上粘贴时，代码框有时会自动多补一个右括号 <code>)</code> 导致报错——若报错，检查末尾有没有多余的 <code>)</code> 删掉即可。若提示某项「already exists」，说明之前建过，忽略即可。</p>

          <p style="margin:10px 0 4px"><b>第 3 步 · 复制 URL 和 key</b></p>
          <p style="margin:0 0 6px;font-size:12px">点左下角 <b>Project Settings（齿轮）→ API Keys</b>。</p>
          <p style="margin:0 0 6px;font-size:12px">① <b>Project URL</b>：形如 <code>https://xxxx.supabase.co</code>，复制它。</p>
          <p style="margin:0 0 6px;font-size:12px">② <b>anon key</b>：新版界面若只看到 <code>sb_publishable_...</code>，请点页面上的 <b>「Legacy anon, service_role」</b>标签，复制里面 <b>anon</b> 那一长串（<code>eyJ...</code> 开头）。<b>不要</b>复制 service_role（那是超级权限，别外泄）。</p>
          <p style="margin:0 0 10px;font-size:12px">把这两个填回上一页，点「测试连接」，变绿就成功了。</p>

          <p style="margin:10px 0 4px;color:var(--danger)"><b>注意事项</b></p>
          <p style="margin:0 0 6px;font-size:12px;color:var(--text-secondary)">· 单个备份压缩后需小于 <b>50MB</b>（免费版限制）。带图存档容易超，可先清理图片、改用轻量/纯文字，或超大存档用本地导出。</p>
          <p style="margin:0 0 6px;font-size:12px;color:var(--text-secondary)">· 每个人的 URL 和 key 都不一样，各存各的，互相看不到。</p>
          <p style="margin:0 0 4px;font-size:12px;color:var(--text-secondary)">· <b>关于安全：</b>anon key 设计成可公开，配合上面的策略，只有持 key 的人能读写你的备份——不把 key 发出去就只有你能访问。存档桶为私有，不会被公开。key 若泄露，去 Supabase 后台轮换即可。</p>
          <p style="margin:0;font-size:12px;color:var(--text-secondary)">· <b>别误点删项目：</b>项目设置里的 Delete project 是删掉整个数据库，和这里的操作无关，不要点。</p>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#cbg-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#cbg-copy').addEventListener('click', async () => {
      const btn = overlay.querySelector('#cbg-copy');
      try {
        await navigator.clipboard.writeText(sql);
        btn.textContent = '已复制';
      } catch (_) {
        // 剪贴板不可用时选中文本兜底
        const pre = overlay.querySelector('#cbg-sql');
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = '已选中，请手动复制';
      }
      setTimeout(() => { btn.textContent = '复制 SQL'; }, 2000);
    });
  }

  function _modal(opts) {
    return new Promise(resolve => {
      const o = opts || {};
      const isInput = !!o.input;
      const okText = o.okText || '确认';
      const cancelText = o.cancelText;
      const showCancel = cancelText !== false;
      const cancelLabel = (typeof cancelText === 'string') ? cancelText : '取消';

      let modal = document.querySelector('.auth-modal-temp');
      if (modal) modal.remove();
      modal = document.createElement('div');
      modal.className = 'modal auth-modal-temp';
      // 确认弹窗要浮在云备份(100000)/教程(100001)等弹窗之上，否则会被盖住
      modal.style.zIndex = '100010';
      modal.innerHTML = `
        <div class="modal-content" style="max-width:420px">
          ${o.title ? `<h3>${_escape(o.title)}</h3>` : ''}
          ${o.desc ? `<p style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin:0 0 12px">${_escape(o.desc)}</p>` : ''}
          ${isInput ? `
            <div class="form-group">
              <input type="text" id="auth-modal-input"
                     placeholder="${_escape(o.placeholder || '')}"
                     value="${_escape(o.defaultValue || '')}"
                     ${o.maxLength ? `maxlength="${o.maxLength}"` : ''} />
            </div>
            <div id="auth-modal-err" style="font-size:12px;color:var(--danger);margin:-8px 0 8px;min-height:0;display:none"></div>
          ` : ''}
          <div class="modal-actions" style="margin-top:12px">
            ${showCancel ? `<button type="button" data-act="cancel" style="flex:1;background:none;border:1px solid var(--border);color:var(--text-secondary)">${_escape(cancelLabel)}</button>` : ''}
            <button type="button" data-act="ok" style="flex:1;${o.danger ? 'background:var(--danger);color:#fff;border:none' : 'background:var(--accent);color:#111;border:none'}">${_escape(okText)}</button>
          </div>
        </div>
      `;
      // host 选择：优先挂到当前打开的顶层弹窗内部，这样确认弹窗天然浮在其上，
      // 不受各弹窗自身 stacking context / overflow 影响（z-index 单独设不一定管用）。
      // 云备份 overlay(100000) / 教程 overlay(100001) 若存在，优先挂进去；
      // 否则回退到个人主页 overlay（华为 webview 兼容），再回退到 body。
      const cloudOverlay = document.getElementById('cloud-backup-overlay');
      const guideOverlay = document.getElementById('cb-guide-overlay');
      const profileOverlay = document.getElementById('auth-profile-overlay');
      const host = guideOverlay
        || cloudOverlay
        || ((profileOverlay && profileOverlay.classList.contains('visible')) ? profileOverlay : document.body);
      host.appendChild(modal);

      const input = modal.querySelector('#auth-modal-input');
      if (input) {
        setTimeout(() => { try { input.focus(); input.select(); } catch(_) {} }, 50);
      }

      const close = (val) => {
        modal.remove();
        resolve(val);
      };
      const ok = () => {
        if (isInput) {
          const v = (input?.value || '').trim();
          if (o.validate) {
            const err = o.validate(v);
            if (err) {
              const el = modal.querySelector('#auth-modal-err');
              if (el) { el.textContent = err; el.style.display = 'block'; }
              return;
            }
          }
          close(v);
        } else {
          close(true);
        }
      };
      const cancel = () => close(isInput ? null : false);

      modal.querySelector('[data-act="ok"]').addEventListener('click', ok);
      const cancelBtn = modal.querySelector('[data-act="cancel"]');
      if (cancelBtn) cancelBtn.addEventListener('click', cancel);
      modal.addEventListener('click', e => { if (e.target === modal) cancel(); });
      const keyHandler = e => {
        if (e.key === 'Enter') { e.preventDefault(); ok(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      };
      modal.addEventListener('keydown', keyHandler);
      if (input) input.addEventListener('keydown', keyHandler);
    });
  }

  // ===== 改昵称 =====
  async function _onEditNickname() {
    if (_isNicknameChanged()) {
      await _modal({ title: '昵称仅可修改一次', desc: '你已经改过昵称了，无法再次修改。', cancelText: false, okText: '好的' });
      return;
    }
    const cur = _state?.nickname || '';
    const v = await _modal({
      title: '昵称',
      input: true,
      defaultValue: cur,
      placeholder: '昵称',
      maxLength: 30,
      desc: '昵称仅可修改一次，请谨慎填写。',
      okText: '保存',
      validate: s => {
        if (!s) return '昵称不能为空';
        if (s.length > 30) return '昵称最长 30 个字符';
        return null;
      },
    });
    if (v === null) return;
  setNickname(v);
  _markNicknameChanged();
  _renderProfile();
  _refreshAccountCard();
  // v683.3：异步同步到后端，让其它设备也能拿到
  syncNicknameToServer(v).then(r => {
    if (!r.ok) {
      try { UI?.showToast?.('昵称已本地保存，但同步到云端失败：' + (r.error || ''), 3500); } catch(_) {}
    }
  });
}

  // 选头像（本地，存 dataUrl）
  function _onPickAvatar() {
    let inp = document.getElementById('auth-avatar-file');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.id = 'auth-avatar-file';
      inp.style.display = 'none';
      document.body.appendChild(inp);
    }
    inp.value = '';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const dataUrl = await _readImageCompressed(f, 256);
        if (!_state) return;
        _state.avatar = dataUrl;
        _saveState(_state);
        _renderProfile();
        _refreshAccountCard();
      } catch(e) {
        await _modal({ title: '头像处理失败', desc: e.message || '请换一张图片再试。', cancelText: false, okText: '好的' });
      }
    };
    inp.click();
  }

  // 把图片压到 maxSize×maxSize 内的正方形 dataUrl
  function _readImageCompressed(file, maxSize) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('解码失败'));
        img.onload = () => {
          // 中心裁剪到正方形，再缩到 maxSize
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2;
          const sy = (img.height - side) / 2;
          const canvas = document.createElement('canvas');
          canvas.width = maxSize;
          canvas.height = maxSize;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // 改密码
function _onChangePassword() {
  if (!_state) return;
  if (_isPasswordChanged()) {
    _modal({ title: '密码仅可修改一次', desc: '你已经改过密码了，无法再次修改。', cancelText: false, okText: '好的' });
    return;
  }
  let modal = document.getElementById('auth-pw-modal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'auth-pw-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:420px">
        <h3>修改密码</h3>
        <p style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin:0 0 12px">密码仅可修改一次，请谨慎设置。改密后将退出当前账号在其它设备的登录。</p>

        <div class="form-group">
          <span class="form-label">原密码</span>
          <div class="auth-pw-field">
            <input id="auth-pw-old" type="password" autocomplete="current-password" />
            <button type="button" class="auth-pw-eye-modal" data-target="auth-pw-old" tabindex="-1">${_eyeOpenSvg()}</button>
          </div>
        </div>
        <div class="form-group">
          <span class="form-label">新密码（至少 6 位）</span>
          <div class="auth-pw-field">
            <input id="auth-pw-new" type="password" autocomplete="new-password" />
            <button type="button" class="auth-pw-eye-modal" data-target="auth-pw-new" tabindex="-1">${_eyeOpenSvg()}</button>
          </div>
        </div>
        <div class="form-group">
          <span class="form-label">确认新密码</span>
          <div class="auth-pw-field">
            <input id="auth-pw-confirm" type="password" autocomplete="new-password" />
            <button type="button" class="auth-pw-eye-modal" data-target="auth-pw-confirm" tabindex="-1">${_eyeOpenSvg()}</button>
          </div>
        </div>

        <div id="auth-pw-error" style="font-size:12px;color:var(--danger);margin-bottom:8px;display:none"></div>

        <div class="modal-actions" style="margin-top:12px">
          <button type="button" id="auth-pw-cancel" style="flex:1;background:none;border:1px solid var(--border);color:var(--text-secondary)">取消</button>
          <button type="button" id="auth-pw-submit" style="flex:1;background:var(--accent);color:#111;border:none">确认</button>
        </div>
      </div>
    `;
    // 华为 webview 兼容：个人主页可见时，挂到 overlay 内部
    const profileOverlay = document.getElementById('auth-profile-overlay');
    const host = (profileOverlay && profileOverlay.classList.contains('visible'))
      ? profileOverlay : document.body;
    host.appendChild(modal);

    // 眼睛切换（三个独立）
    modal.querySelectorAll('.auth-pw-eye-modal').forEach(btn => {
      btn.addEventListener('click', () => {
        const inp = document.getElementById(btn.dataset.target);
        if (!inp) return;
        if (inp.type === 'password') {
          inp.type = 'text';
          btn.innerHTML = _eyeClosedSvg();
          btn.classList.add('on');
        } else {
          inp.type = 'password';
          btn.innerHTML = _eyeOpenSvg();
          btn.classList.remove('on');
        }
      });
    });

    const close = () => modal.remove();
    document.getElementById('auth-pw-cancel').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    const showErr = m => {
      const el = document.getElementById('auth-pw-error');
      if (el) { el.textContent = m; el.style.display = 'block'; }
    };
    const clearErr = () => {
      const el = document.getElementById('auth-pw-error');
      if (el) { el.textContent = ''; el.style.display = 'none'; }
    };

    const submit = async () => {
      clearErr();
      const oldPw = document.getElementById('auth-pw-old').value;
      const newPw = document.getElementById('auth-pw-new').value;
      const cfm = document.getElementById('auth-pw-confirm').value;
      if (!oldPw || !newPw || !cfm) { showErr('请填写所有字段'); return; }
      if (newPw.length < 6) { showErr('新密码至少 6 位'); return; }
      if (newPw === oldPw) { showErr('新密码不能与原密码相同'); return; }
      if (newPw !== cfm) { showErr('两次输入的新密码不一致'); return; }

      const btn = document.getElementById('auth-pw-submit');
      btn.disabled = true;
      btn.textContent = '提交中…';
      try {
        const { status, data } = await _post('/change-password', {
          token: _state.token,
          old_password: oldPw,
          new_password: newPw,
        });
        if (status === 200 && data?.ok) {
          _markPasswordChanged();
          if (data.devices) {
            _state.devices = data.devices;
            _saveState(_state);
          }
          close();
          await _modal({
            title: '密码已修改',
            desc: '其它设备已被踢出登录。密码仅可修改一次，无法再次修改。',
            cancelText: false,
            okText: '好的',
          });
          _renderProfile();
          _refreshAccountCard();
        } else {
          showErr(data?.error || `修改失败（${status}）`);
        }
      } catch(e) {
        showErr('网络错误：' + (e.message || '请稍后再试'));
      } finally {
        btn.disabled = false;
        btn.textContent = '确认';
      }
    };
    document.getElementById('auth-pw-submit').addEventListener('click', submit);
    modal.querySelectorAll('input').forEach(el => {
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter') submit();
        else if (e.key === 'Escape') close();
      });
    });
  }

  // 眼睛 SVG（复用，方便其它地方调）
  function _eyeOpenSvg() {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
  }
  function _eyeClosedSvg() {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';
  }

  function _onLogoutConfirm() {
    _modal({
      title: '退出登录',
      desc: '本地的对话/世界观/记忆等数据不会丢失，下次登录后还在。',
      okText: '退出',
      danger: true,
    }).then(ok => { if (ok) logout(); });
  }

  // ===== 退出登录（公开 API）=====
  async function logout() {
    if (_state?.token && _state?.device_id) {
      try {
        await _post('/kick', { token: _state.token, kick_device_id: _state.device_id });
      } catch(_) {}
    }
    _clearState();
    if (_heartbeatTimer) clearInterval(_heartbeatTimer);
    location.reload();
  }

  // ===== 踢掉指定设备（设置页用） =====
  async function kickDevice(deviceId) {
    if (!_state?.token) return { ok: false, error: '未登录' };
    try {
      const { status, data } = await _post('/kick', { token: _state.token, kick_device_id: deviceId });
      if (status === 200 && data?.ok) {
        _state.devices = data.devices || [];
        _saveState(_state);
        return { ok: true, devices: _state.devices };
      }
      return { ok: false, error: data?.error || '操作失败' };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  }

  // ===== 公开访问器 =====
  function getState() { return _state ? { ...(_state), devices: (_state.devices || []).slice() } : null; }
  function getNickname() { return _state?.nickname || ''; }
  function getEmail() { return _state?.email || ''; }
  // ===== 改名/改密次数限制（前端，按账号记标记）=====
  function _limitKey(kind) {
    const id = (_state?.email || '').trim().toLowerCase();
    return `tianshu_${kind}_changed::${id}`;
  }
  function _isNicknameChanged() {
    try { return localStorage.getItem(_limitKey('nick')) === '1'; } catch(_) { return false; }
  }
  function _markNicknameChanged() {
    try { localStorage.setItem(_limitKey('nick'), '1'); } catch(_) {}
  }
  function _isPasswordChanged() {
    try { return localStorage.getItem(_limitKey('pwd')) === '1'; } catch(_) { return false; }
  }
  function _markPasswordChanged() {
    try { localStorage.setItem(_limitKey('pwd'), '1'); } catch(_) {}
  }
function setNickname(n) {
  if (!_state) return;
  _state.nickname = String(n || '').trim().slice(0, 30);
  _saveState(_state);
}
// v683.3：异步上传昵称到后端，让别的设备也能拿到
async function syncNicknameToServer(n) {
  if (!_state?.token) return { ok: false, error: '未登录' };
  try {
    const { status, data } = await _post('/update-profile', {
      token: _state.token,
      nickname: String(n || '').trim().slice(0, 30),
    });
    if (status === 200 && data?.ok) {
      _state.nickname = data.nickname || '';
      _saveState(_state);
      return { ok: true };
    }
    return { ok: false, error: data?.error || `HTTP ${status}` };
  } catch (e) {
    return { ok: false, error: e.message || '网络错误' };
  }
}

  return {
    init,
    getState, getNickname, setNickname, getEmail,
    logout, kickDevice,
    openProfile, closeProfile,
  };
})();

// 自动启动：先用户协议，再 Auth.init()
function _boot() {
  try {
    if (typeof Agreement !== 'undefined' && Agreement.ensureAgreed) {
      Agreement.ensureAgreed().then(() => Auth.init());
      return;
    }
  } catch(_) {}
  Auth.init();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _boot);
} else {
  _boot();
}
