/**
 * 虚拟手机系统 — 通用外壳 + App 路由 + 数据存储
 *
 * 通用 App：论坛（风闻搬家）、地图、好友圈、备忘录
 */
const Phone = (() => {
  // ===== 状态 =====
  let _isOpen = false;
  let _currentApp = null;
  let _hasNewNotif = false;
 let _batteryTimer = null;
 let _batteryRef = null;

  // ===== 操作日志（每轮发送时 flush 给 AI） =====
// 持久化策略：日志同步到当前对话的 conv.phoneData.pendingActionLog，
// 这样刷新页面 / 切换对话回来后还能保留未发送的操作记录。
// 后台频道独立维护一份 _actionLogForBackstage —— 上帝视角理应看到完整轨迹，
// 与主线消费/清空互不干扰。
let _actionLog = [];
let _actionLogForBackstage = [];

// 把内存 _actionLog 的当前快照持久化到当前对话的 phoneData
function _persistActionLog() {
  try {
    const convId = Conversations.getCurrent && Conversations.getCurrent();
    if (!convId) return;
    const conv = Conversations.getList().find(c => c.id === convId);
    if (!conv) return;
    conv.phoneData = conv.phoneData || {};
    conv.phoneData.pendingActionLog = _actionLog.slice();
    conv.phoneData.pendingActionLogForBackstage = _actionLogForBackstage.slice();
    // 注意：这里同步触发 Conversations.saveList()，phoneData 修改会一起落盘
    Conversations.saveList && Conversations.saveList();
  } catch(_) {}
}

// 切换对话或启动时从 phoneData 把未 flush 的日志读回来（供 chat.loadHistory 调用）
function reloadActionLog() {
  try {
    const convId = Conversations.getCurrent && Conversations.getCurrent();
    if (!convId) {
      _actionLog = [];
      _actionLogForBackstage = [];
      _chatRoundLog = {};
      _invalidateMomentsCache();
      return;
    }
    const conv = Conversations.getList().find(c => c.id === convId);
    const stored = conv?.phoneData?.pendingActionLog;
    const storedBs = conv?.phoneData?.pendingActionLogForBackstage;
    _actionLog = Array.isArray(stored) ? stored.slice() : [];
    _actionLogForBackstage = Array.isArray(storedBs) ? storedBs.slice() : [];
    reloadChatRoundLog();
    // 切对话时连带清空好友圈渲染缓存（mask/NPC 头像可能换了）
    _invalidateMomentsCache();
  } catch(_) {
    _actionLog = [];
    _actionLogForBackstage = [];
    _chatRoundLog = {};
    _invalidateMomentsCache();
  }
}
function _clipLogText(text, max = 42) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
function _summarizeListForLog(list, formatter, max = 4) {
  if (!Array.isArray(list) || list.length === 0) return '无返回结果';
  return list.slice(0, max).map((item, idx) => `${idx + 1}. ${formatter(item)}`).join('；');
}
function _log(action) {
  _actionLog.push(action);
  _actionLogForBackstage.push(action);
  _persistActionLog();
}
function pushLog(action) {
  _actionLog.push(action);
  _actionLogForBackstage.push(action);
  _persistActionLog();
} // 供外部模块调用
function flushActionLog() {
  _flushChatRoundLog();
  const log = _actionLog.slice();
  _actionLog = [];
  _persistActionLog();
  // 多笔购物时追加合计，帮 AI 直接扣款无需自己加总
  const priceRe = /，¥([\d.]+)/g;
  let total = 0, count = 0;
  for (const entry of log) {
    let m;
    while ((m = priceRe.exec(entry)) !== null) {
      const v = parseFloat(m[1]);
      if (!isNaN(v)) { total += v; count++; }
    }
  }
  if (count > 1) log.push(`本轮购物合计：¥${total % 1 === 0 ? total : total.toFixed(2)}；若存在货币/金钱类属性，请扣除此金额`);
  return log;
}
function peekActionLog() { return _actionLog.slice(); }
function flushActionLogForBackstage() {
  const log = _actionLogForBackstage.slice();
  _actionLogForBackstage = [];
  _persistActionLog();
  return log;
}

// 用户"待回复"轮次 ID（按联系人），连发多条共用同一 roundId，AI 回复后清掉
let _pendingMeRoundId = {};
// 手机聊天会话基准时间——任意联系人收到 AI 回复后更新，跨联系人共享
let _chatSessionBaseTime = '';
// 语音模式状态：{ contactId: true/false }
let _chatVoiceMode = {};
// 结构：{ contactId: { name: '联系人名', msgs: [{role, text, time}] } }
let _chatRoundLog = {};

function _persistChatRoundLog() {
  try {
    const convId = Conversations.getCurrent && Conversations.getCurrent();
    if (!convId) return;
    const conv = Conversations.getList().find(c => c.id === convId);
    if (!conv) return;
    conv.phoneData = conv.phoneData || {};
    conv.phoneData.pendingChatRoundLog = Object.keys(_chatRoundLog).length > 0 ? JSON.parse(JSON.stringify(_chatRoundLog)) : null;
    Conversations.saveList && Conversations.saveList();
  } catch(_) {}
}

function reloadChatRoundLog() {
  try {
    const convId = Conversations.getCurrent && Conversations.getCurrent();
    if (!convId) { _chatRoundLog = {}; return; }
    const conv = Conversations.getList().find(c => c.id === convId);
    _chatRoundLog = (conv?.phoneData?.pendingChatRoundLog && typeof conv.phoneData.pendingChatRoundLog === 'object')
      ? JSON.parse(JSON.stringify(conv.phoneData.pendingChatRoundLog))
      : {};
  } catch(_) { _chatRoundLog = {}; }
}

function _addChatMessageToRoundLog(contactId, role, text, time, contactName) {
  if (!contactId || !text) return;
  if (!_chatRoundLog[contactId]) {
    _chatRoundLog[contactId] = { name: contactName || contactId, msgs: [] };
  }
  _chatRoundLog[contactId].msgs.push({ role, text, time: (time || '').trim() });
  _persistChatRoundLog();
}

function _formatChatRoundLog() {
  if (Object.keys(_chatRoundLog).length === 0) return [];
  const lines = [];
  for (const contactId in _chatRoundLog) {
    const entry = _chatRoundLog[contactId];
    if (!entry || !entry.msgs || !entry.msgs.length) continue;
    const contactName = entry.name || contactId;
    lines.push(`在手机聊天APP与「${contactName}」新增以下对话：`);
    for (const m of entry.msgs) {
      const who = m.role === 'me' ? '{{user}}' : contactName;
      const timeStr = m.time ? `[${m.time}] ` : '';
      lines.push(`  ${who} ${timeStr}：${m.text}`);
    }
  }
  return lines;
}

function _flushChatRoundLog() {
  const chatLines = _formatChatRoundLog();
  if (chatLines.length > 0) {
    // 聊天日志作为一条完整 log 加入 action log
    _actionLog.push(chatLines.join('\n'));
    _actionLogForBackstage.push(chatLines.join('\n'));
  }
  _chatRoundLog = {};
  _persistChatRoundLog();
}

  // ===== 辅助 =====
  function _isAnyWorldview() {
    const wv = document.body.getAttribute('data-worldview');
    return !!wv && wv !== '';
  }

  // ===== 数据层 =====
  // phoneData 存在 conversation 对象上，按对话隔离
  async function _getPhoneData() {
    const convId = Conversations.getCurrent();
    if (!convId) return null;
    const conv = Conversations.getList().find(c => c.id === convId);
    if (!conv) return null;
    if (!conv.phoneData) {
      conv.phoneData = _defaultPhoneData();
      // 不 await——避免 saveList hang 住阻塞调用方
      Conversations.saveList().catch(() => {});
    } else {
      // 兼容旧 phoneData：补齐 _defaultPhoneData 里有但旧数据没有的字段
      // 防止旧版本对话升级后字段缺失导致 .push/.unshift 报错
      const defaults = _defaultPhoneData();
      let patched = false;
      for (const k in defaults) {
        if (conv.phoneData[k] === undefined) {
          conv.phoneData[k] = defaults[k];
          patched = true;
        }
      }
      if (patched) Conversations.saveList().catch(() => {});
    }
    return conv.phoneData;
  }

  async function _savePhoneData() {
    try { await Conversations.saveList(); } catch(_) {}
  }

  function _defaultPhoneData() {
    return {
      memos: [],                 // [{id, title, content, time, createdAt}]
      locationHistory: [],       // [{location, time, createdAt}]
      forumSearchHistory: [],    // [{query, time}]
      forumViewHistory: [],      // [{title, summary, content, time}]  最多保留10条
      mapSearchHistory: [],      // [{query, time}]  最多保留10条
      cachedForumPosts: [],      // 上一次刷新/搜索到的帖子列表，持久化
      myForumPosts: [],          // [{id, username, avatar_color, time, title, content, tags[], createdAt}] 用户发的帖子
      moments: [],               // [{id, text, image, imageDesc, visibleNpcs, time, comments, createdAt}]
      momentsCover: '',          // 好友圈顶部封面 DataURL
      npcMoments: [],            // [{npc, text, comments}] 刷新覆盖
 mapLastResults: [], // 上一次地图搜索结果，持久化
 mapLastQuery: '', // 上一次搜索关键词
 wallpaper: '', // 用户自定义手机壁纸 DataURL
wallpaperOverlay: false, // 壁纸遮罩（深色半透明层，适配深色壁纸）
wallpaperOpacity: 75, // 卡片/底栏/顶栏不透明度（0-100，仅有壁纸时生效）
sendActionLog: true, // v627：是否把本轮手机操作日志发送给 AI（默认开）
profile: {                // 主屏个人资料卡：用户可改的"网名 + 个性签名 + 头像"
  name: 'Polaris',
  bio: 'The still point where all worlds turn.',
  avatar: ''              // DataURL 或 URL
},
album: [],                // 相册：[{id, mode, text, imageId, location, time, createdAt}]
                          // mode: 'shoot' 用户拍/手写 | 'ai_text' AI 生成的文字 | 'ai_image' AI 生成的图片
                          // location: 拍照时地点快照（region·location 拼接）
                          // time: 拍照时游戏内时间快照
                          // imageId: 仅 ai_image 模式有，挂到 drawnImages 表
cameraTab: 'shoot',       // 相机内 tab 记忆：'shoot' | 'album'
cameraDraft: null,        // 拍摄页输入框草稿：{text, baseStatusText}
                          // baseStatusText = 写草稿时的状态栏拼接结果（主线没推进就保持，推进了就丢）
 // 外卖
 takeoutCachedItems: [],   // 上一次刷新/搜索的商品列表
 takeoutLastQuery: '',     // 上一次搜索关键词
 takeoutSearchHistory: [], // [{query, time}] 最多10条
 takeoutOrders: [],        // 订单 [{id, name, price, shop, desc, target, time}]
 // 网购
 shopCachedItems: [],
 shopLastQuery: '',
 shopSearchHistory: [],
 shopOrders: [],           // [{id, name, price, shop, desc, target, time}]
  // 心动模拟 APP — 用户对心动目标的私下好感度（仅本地娱乐数据，不影响游戏数值）
  hsAppFavor: { fsy: 0, yx: 0, lmy: 0, qe: 0 },
  // 心动模拟 APP — 上次注入到后台频道时的快照（用于计算"本轮变化"）
  hsAppFavorSnapshot: { fsy: 0, yx: 0, lmy: 0, qe: 0 },
  // 心动模拟 APP — 用户自定义心动目标列表（null = 用内置默认值；数组 = 用户已编辑过）
  // 元素：{ id, name, alias, age, role, relation, avatar }（avatar 为 dataURL）
  hsAppTargets: null,
 // 心动模拟 APP — 客服对话记录 [{role:'user'|'assistant', text, time}]
heartsimServiceMessages: [],
    // 心动模拟 APP — 客服对话同步进度（后台频道每次取走时记录，下次只用 ★ 标新增）
    heartsimServiceSyncIdx: 0,
    // 心动模拟 APP — 待注入主线的系统通知（"通关条件达成提醒" / "用户已发回家指令"）
    // 注入后清空，但是否曾通知过的全局标记（下面两个）保持 true
    hsPendingHomeNotice: '',
    // 心动模拟 — 返航动画是否已触发过（避免 AI 重复输出 marker 重复触发）
    hsHomecomingTriggered: false,
 hsHomeReadyNotified: false,  // 是否已因"通关条件达成"提醒过 AI 一次
 hsHomeRequestSent: false,    // 用户是否已成功通过客服发送过"回家"指令
 // 聊天 App（v689）
 chatContacts: [],   // 联系人 [{id, name, source:'worldview'|'single'|'mount', avatar, sig}]
 chatThreads: {},    // 聊天记录 { contactId: [{id, role:'me'|'them', text, time, fromMainline, createdAt}] }
 chatSyncIdx: 0,     // 主线收录进度：已收录到第几条主线消息
 };
   }

  

  function _renderBattery(level, charging) {
 const el = document.getElementById('phone-battery');
 if (!el) return;
 if (typeof level !== 'number' || !Number.isFinite(level)) {
 el.innerHTML = '<span class="phone-battery-text">--%</span><span class="phone-battery-shell"><span class="phone-battery-fill" style="width:45%"></span></span>';
 return;
 }
 const pct = Math.max(0, Math.min(100, Math.round(level *100)));
 el.classList.toggle('charging', !!charging);
 el.innerHTML = `<span class="phone-battery-text">${pct}%${charging ? ' ⚡' : ''}</span><span class="phone-battery-shell"><span class="phone-battery-fill" style="width:${pct}%"></span></span>`;
}
async function _refreshBattery() {
 try {
 if (navigator.getBattery) {
 const battery = await navigator.getBattery();
 _batteryRef = battery;
 _renderBattery(battery.level, battery.charging);
 if (!battery._phoneBound) {
 battery.addEventListener('levelchange', () => _renderBattery(battery.level, battery.charging));
 battery.addEventListener('chargingchange', () => _renderBattery(battery.level, battery.charging));
 battery._phoneBound = true;
 }
 } else {
 _renderBattery(null, false);
 }
 } catch(_) {
 _renderBattery(null, false);
 }
}
function _startBatteryTicker() {
 _refreshBattery();
 clearInterval(_batteryTimer);
 _batteryTimer = setInterval(_refreshBattery,60000);
}
function _stopBatteryTicker() {
 clearInterval(_batteryTimer);
 _batteryTimer = null;
}

function _applyWallpaper(pd) {
    const shell = document.querySelector('#phone-modal .phone-shell');
    if (!shell) return;
    const wallpaper = pd?.wallpaper || '';
    const useOverlay = !!pd?.wallpaperOverlay;
    const opacity = typeof pd?.wallpaperOpacity === 'number' ? Math.max(0, Math.min(100, pd.wallpaperOpacity)) : 75;
    if (wallpaper) {
      shell.style.backgroundImage = useOverlay
        ? `linear-gradient(rgba(0,0,0,0.18), rgba(0,0,0,0.32)), url("${wallpaper}")`
        : `url("${wallpaper}")`;
    } else {
      shell.style.backgroundImage = '';
    }
    shell.style.setProperty('--phone-card-opacity', String(opacity));
    shell.style.setProperty('--phone-card-opacity-pct', opacity + '%');
    // 深色适配 class：有壁纸 + 开了遮罩才启用（控制卡片黑底白字等 CSS）
    shell.classList.toggle('has-custom-wallpaper', !!wallpaper && useOverlay);
    // 壁纸存在 class：只要有壁纸就加（让底栏半透明）
    shell.classList.toggle('has-wallpaper', !!wallpaper);
  }

  // ===== 个人资料卡：渲染 + inline 编辑 + 头像 =====
  const PROFILE_DEFAULT = { name: 'Polaris', bio: 'The still point where all worlds turn.', avatar: '' };

  function _getProfile(pd) {
    const p = pd?.profile || {};
    return {
      name: typeof p.name === 'string' ? p.name : PROFILE_DEFAULT.name,
      bio: typeof p.bio === 'string' ? p.bio : PROFILE_DEFAULT.bio,
      avatar: typeof p.avatar === 'string' ? p.avatar : ''
    };
  }

  function _applyProfile(pd) {
    const profile = _getProfile(pd);
    const nameEl = document.getElementById('phone-profile-name');
    const bioEl = document.getElementById('phone-profile-bio');
    const avatarEl = document.getElementById('phone-profile-avatar');
    // 只在不在编辑状态时刷新文字（避免打字时被覆盖）
    if (nameEl && document.activeElement !== nameEl) nameEl.textContent = profile.name || '';
    if (bioEl && document.activeElement !== bioEl) bioEl.textContent = profile.bio || '';
    if (avatarEl) {
      if (profile.avatar) {
        avatarEl.style.backgroundImage = `url("${profile.avatar}")`;
        avatarEl.classList.add('has-avatar');
      } else {
        avatarEl.style.backgroundImage = '';
        avatarEl.classList.remove('has-avatar');
      }
    }
  }

  // 字数限制 —— input 时截断超出部分（保持光标在末尾）
  function _onProfileInput(field, el, maxLen) {
    const text = (el.textContent || '');
    if (text.length > maxLen) {
      el.textContent = text.slice(0, maxLen);
      // 把光标放到末尾
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch(_) {}
      UI.showToast(`已达字数上限（${maxLen}）`, 1200);
    }
  }

  function _onProfileFocus(field, el) {
    // 进入编辑：选中所有文字，方便整段替换
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch(_) {}
  }

  // 失焦保存
  async function _onProfileBlur(field, el) {
    const raw = (el.textContent || '').trim();
    const value = raw || PROFILE_DEFAULT[field];   // 清空时回落到默认
    if (raw !== value) el.textContent = value;     // 视觉同步
    try {
      const pd = await _getPhoneData();
      if (!pd) return;
      pd.profile = pd.profile || { ...PROFILE_DEFAULT };
      if (pd.profile[field] === value) return;     // 没变化不写
      pd.profile[field] = value;
      await _savePhoneData();
    } catch(e) { console.warn('[Profile] save failed', e); }
  }

  // 回车失焦（不允许换行）
  function _onProfileKeydown(e, field, el) {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
  }

  // 头像：调用通用图片输入弹窗（本地 + URL）
  async function _pickProfileAvatar() {
    if (typeof Utils === 'undefined' || !Utils.promptImageInput) {
      UI.showToast('图片输入组件未就绪', 1500); return;
    }
    try {
      const dataUrl = await Utils.promptImageInput({ maxSize: 256, quality: 0.85, outputFormat: 'jpeg' });
      if (!dataUrl) return;
      const pd = await _getPhoneData();
      if (!pd) return;
      pd.profile = pd.profile || { ...PROFILE_DEFAULT };
      pd.profile.avatar = dataUrl;
      await _savePhoneData();
      _applyProfile(pd);
    } catch(e) { console.warn('[Profile] avatar pick failed', e); UI.showToast('头像设置失败', 1500); }
  }

function _compressWallpaper(file, opts = {}) {
 return new Promise((resolve, reject) => {
 const reader = new FileReader();
 reader.onload = () => {
 const img = new Image();
 img.onload = () => {
 const maxW = opts.maxW || 900;
 const maxH = opts.maxH || 1600;
 let { width, height } = img;
 const scale = Math.min(1, maxW / width, maxH / height);
 width = Math.round(width * scale);
 height = Math.round(height * scale);
 const canvas = document.createElement('canvas');
 canvas.width = width;
 canvas.height = height;
 const ctx = canvas.getContext('2d');
 ctx.drawImage(img,0,0, width, height);
 resolve(canvas.toDataURL('image/jpeg', opts.quality || 0.82));
 };
 img.onerror = reject;
 img.src = reader.result;
 };
 reader.onerror = reject;
 reader.readAsDataURL(file);
 });
}

// ===== 外壳渲染 =====
  async function open() {
    if (!_isAnyWorldview()) { UI.showToast('请先选择一个世界观', 1500); return; }
    // 心动模拟：被 char 锁定时不允许打开
    try {
      if (typeof StatusBar !== 'undefined' && StatusBar.isPhoneLocked && StatusBar.isPhoneLocked()) {
        const info = StatusBar.getPhoneLockInfo?.();
        const by = info?.lockedBy || '心动目标';
        UI.showToast(`手机被${by}锁起来了，拿不到`, 2500);
        return;
      }
    } catch(_) {}
    let modal = document.getElementById('phone-modal');
    if (!modal) _createModal();
    modal = document.getElementById('phone-modal');
    _currentApp = null;
    // 加载世界观对商城 App 的自定义（影响首页图标名字和商城 prompt）
    try { await _loadShopMeta(); } catch(_) {}
    _renderHomeScreen();
    modal.classList.remove('hidden');
    _isOpen = true;
 _hasNewNotif = false;
 _startBatteryTicker();
 // 打开手机时隐藏悬浮按钮
    document.getElementById('phone-fab')?.classList.add('hidden');
  }

  function close() {
    const modal = document.getElementById('phone-modal');
    if (modal) modal.classList.add('hidden');
_isOpen = false;
 _currentApp = null;
 _stopBatteryTicker();
 //关闭后显示悬浮按钮（和风闻 minimize 一样的行为）
    const fab = document.getElementById('phone-fab');
    // 心动模拟锁机时也不显示悬浮按钮
    let _locked = false;
    try { _locked = !!(typeof StatusBar !== 'undefined' && StatusBar.isPhoneLocked && StatusBar.isPhoneLocked()); } catch(_) {}
    if (fab && _isAnyWorldview() && !_locked) {
      fab.classList.remove('hidden');
      _updateFab();
    } else if (fab && _locked) {
      fab.classList.add('hidden');
    }
  }

  function minimize() {
 close();
}

function isOpen() { return _isOpen; }

function _isAppStillActive(appId) {
 return _isOpen && _currentApp === appId && !!document.getElementById('phone-body');
}

  function _formatNpcMomentFullLog(m, operation) {
    const lines = [];
    lines.push(`用户${operation}了一条好友动态：`);
    lines.push(`发布者：${m?.npc || '未知'}`);
    if (m?.time) lines.push(`发布时间：${m.time}`);
    lines.push(`正文：${m?.text || ''}`);
    const comments = Array.isArray(m?.comments) ? m.comments : [];
    if (comments.length > 0) {
      lines.push('评论区：');
      comments.forEach(c => lines.push(`- ${c.name || '未知'}：${c.text || ''}`));
    } else {
      lines.push('评论区：暂无');
    }
    return lines.join('\n');
  }

  // ===== 构建完整上下文（供论坛/地图/好友圈 AI 调用共用） =====
  async function _buildFullContext() {
    const parts = [];

    // v687.33：心动模拟返航后，根据 hsPostHomeMode 决定如何构建世界观/NPC 数据
    //   - continue（继续日常）：完全替换为返航世界设定，屏蔽所有 NPC/节日，保留知识（钩子通道）
    //   - epilogue（第二部钩子已触发）：与 continue 一致——屏蔽所有 NPC，剧情已彻底结束
    //   - end（到此结束）/ 未选择：保留原版，方便复盘
    let _hsHomecomingActive = false;
    let _hsPostHomeMode = null;
    try {
      const pd = await _getPhoneData();
      _hsHomecomingActive = !!(pd && pd.hsHomecomingTriggered);
      _hsPostHomeMode = pd?.hsPostHomeMode || null;
    } catch(_) {}
    const _hsSkipNpc = _hsHomecomingActive && (_hsPostHomeMode === 'continue' || _hsPostHomeMode === 'epilogue' || _hsPostHomeMode === 'companion');

    // 1. 世界观基础设定
    if (_hsSkipNpc) {
      // 返航 continue/epilogue/companion 模式：替换为现实世界设定
      parts.push('【返航后·世界观设定】\n这是一个与现实世界几乎完全一致的当代世界。科技水平、社会制度、文化背景、地理格局均与当今现实相同。没有超自然现象，没有异世界，没有任何违反常识的事物存在。\n人们正常地生活、工作、社交。城市有便利店和地铁，手机能刷短视频和点外卖，天气预报偶尔不准，快递偶尔送错地址。一切都按照普通的现代社会运转。');
    } else {
      const wvPrompt = Chat.getWorldviewPrompt() || '';
      if (wvPrompt) parts.push('【世界观设定】\n' + wvPrompt);
    }

    // 1.5 当前游戏时间（统一给论坛 / 好友圈 / 地图等 AI 生成内容使用）
    try {
      const sb = Conversations.getStatusBar();
      if (sb?.time) parts.push('【当前游戏时间】\n' + _formatPhoneTime(sb.time));
    } catch(_) {}

    // 2. 世界观详细数据（NPC、节日、自定义设定）
    try {
      const wv = await Worldview.getCurrent();

      // v687.6：聚合所有绑定的世界书（按对话/卡/世界观/挂载角色）
      let bookExtra = { globalNpcs: [], festivals: [], knowledges: [] };
      try {
        if (typeof Lorebook !== 'undefined' && Lorebook.collectForChat) {
          const conv = (typeof Conversations !== 'undefined') ? Conversations.getList().find(c => c.id === Conversations.getCurrent()) : null;
          let card = null;
          if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
            try { card = await DB.get('singleCards', conv.singleCharId); } catch(_) {}
          }
          const lbs = await Lorebook.collectForChat({ conv, card, wv });
          for (const lb of (lbs || [])) {
            if (Array.isArray(lb.globalNpcs)) bookExtra.globalNpcs.push(...lb.globalNpcs);
            if (Array.isArray(lb.festivals)) bookExtra.festivals.push(...lb.festivals);
            if (Array.isArray(lb.knowledges)) bookExtra.knowledges.push(...lb.knowledges);
          }
        }
      } catch(_) {}

      if (wv) {
        // v687.33：返航 continue/epilogue 模式下屏蔽所有 NPC 和节日（那些角色和事件在这个世界不存在）
        if (_hsSkipNpc) {
          // 知识设定保留——是钩子通道
          const allKnowledges = [...(wv.knowledges || wv.customs || []), ...bookExtra.knowledges];
          if (allKnowledges.length > 0) {
            const enabledAll = allKnowledges.filter(c => c.enabled !== false);
            if (enabledAll.length > 0) {
              const custStr = enabledAll.map(c => `${c.name || ''}：${c.content || ''}`).join('\n');
              parts.push('【知识设定】\n' + custStr);
            }
          }
        } else {
        // 全图 NPC + 详细资料（世界观 + 世界书合并）
        const allNpcs = [];
        const collectNpc = (npc, regionName) => {
          let desc = `${npc.name || '未命名'}`;
          if (regionName) desc += `（所属：${regionName}）`;
          if (npc.aliases) desc += `（别名：${npc.aliases}）`;
          if (npc.detail) desc += `\n${npc.detail}`;
          allNpcs.push(desc);
        };
        if (wv.globalNpcs && wv.globalNpcs.length > 0) {
          for (const npc of wv.globalNpcs) collectNpc(npc, '');
        }
        // 地区/势力挂载 NPC
        if (wv.regions && wv.regions.length > 0) {
          for (const r of wv.regions) {
            if (r.npcs && r.npcs.length > 0) {
              for (const npc of r.npcs) collectNpc(npc, r.name || '未知');
            }
          }
        }
        // v687.6：世界书 NPC（合并到列表，去重按 id）
        if (bookExtra.globalNpcs.length > 0) {
          const seenIds = new Set();
          (wv.globalNpcs || []).forEach(n => { if (n.id) seenIds.add(n.id); });
          (wv.regions || []).forEach(r => (r.npcs || []).forEach(n => { if (n.id) seenIds.add(n.id); }));
          for (const npc of bookExtra.globalNpcs) {
            if (npc.id && seenIds.has(npc.id)) continue;
            collectNpc(npc, '');
          }
        }
        if (allNpcs.length > 0) parts.push('【NPC列表与详细资料】\n' + allNpcs.join('\n---\n'));

        // 节日设定（世界观 + 世界书合并）
        const allFest = [...(wv.festivals || []), ...bookExtra.festivals];
        if (allFest.length > 0) {
          const festStr = allFest.map(f => `${f.name || ''}（${f.date || ''}）：${f.desc || ''}`).join('\n');
          parts.push('【节日设定】\n' + festStr);
        }

        // 知识设定（世界观 + 世界书合并）— v687.6：所有启用条目都进，不再区分关键词触发
        const allKnowledges = [...(wv.knowledges || wv.customs || []), ...bookExtra.knowledges];
        if (allKnowledges.length > 0) {
          const enabledAll = allKnowledges.filter(c => c.enabled !== false);
          if (enabledAll.length > 0) {
            const custStr = enabledAll.map(c => `${c.name || ''}：${c.content || ''}`).join('\n');
            parts.push('【知识设定】\n' + custStr);
          }
        }
        } // v687.33: end of !_hsSkipNpc 分支
      } else if (bookExtra.globalNpcs.length || bookExtra.festivals.length || bookExtra.knowledges.length) {
        // 没世界观但有世界书（单人卡 + 世界书的场景）
        if (bookExtra.globalNpcs.length > 0) {
          const lines = bookExtra.globalNpcs.map(npc => {
            let d = npc.name || '未命名';
            if (npc.aliases) d += `（别名：${npc.aliases}）`;
            if (npc.detail) d += `\n${npc.detail}`;
            return d;
          });
          parts.push('【NPC列表与详细资料】\n' + lines.join('\n---\n'));
        }
        if (bookExtra.festivals.length > 0) {
          parts.push('【节日设定】\n' + bookExtra.festivals.map(f => `${f.name || ''}（${f.date || ''}）：${f.desc || ''}`).join('\n'));
        }
        const enabledAll = bookExtra.knowledges.filter(c => c.enabled !== false);
        if (enabledAll.length > 0) {
          parts.push('【知识设定】\n' + enabledAll.map(c => `${c.name || ''}：${c.content || ''}`).join('\n'));
        }
      }
    } catch(e) { console.warn('[Phone] 世界观/世界书数据获取失败', e); }

    // 3. 用户面具信息
    try {
      const mask = await Character.get();
      if (mask && mask.name) {
        let maskStr = `名字：${mask.name}`;
        if (mask.onlineName) maskStr += `\n网名：${mask.onlineName}`;
        // 兼容历史字段名：实际数据字段是 background；老代码写的 description/personality 实际从未存在
        const bg = mask.background || mask.description || '';
        if (bg) maskStr += `\n设定：${bg}`;
        parts.push('【⚠ 玩家角色基本设定（必须严格遵守，所有涉及玩家性别/外貌/身份的描写都以此为准）】\n' + maskStr);
      }
    } catch(_) {}

    // 3.5 v617：当前对话绑定的单人卡主角（AI 扮演角色）
    // v687.33：返航 continue/epilogue 模式下跳过（单人卡主角不属于返航后的现实世界）
    if (!_hsSkipNpc) try {
      const conv = (typeof Conversations !== 'undefined') ? Conversations.getList().find(c => c.id === Conversations.getCurrent()) : null;
      if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
        const card = await DB.get('singleCards', conv.singleCharId);
        if (card && card.name) {
          let cardStr = `姓名：${card.name}`;
          if (card.aliases) cardStr += `\n别名：${card.aliases}`;
          if (card.detail) cardStr += `\n设定：${card.detail}`;
          parts.push('【当前对话主角（AI 扮演角色）】\n' + cardStr);
        }
      } else if (conv && conv.isSingle && conv.singleCharType === 'npc' && conv.singleCharId) {
        // 单人·NPC 模式：从 worldviews 里查
        try {
          const wvs = await DB.getAll('worldviews');
          for (const wv of wvs) {
            if (!wv) continue;
            let found = null;
            (wv.globalNpcs || []).forEach(n => { if (n.id === conv.singleCharId) found = n; });
            (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(n => { if (n.id === conv.singleCharId) found = n; })));
            if (found) {
              let s = `姓名：${found.name || '未命名'}`;
              if (found.aliases) s += `\n别名：${found.aliases}`;
              if (found.detail) s += `\n设定：${found.detail}`;
              parts.push('【当前对话主角（AI 扮演角色）】\n' + s);
              break;
            }
          }
        } catch(_) {}
      }
    } catch(_) {}

    // 3.6 v617：对话级挂载角色（拉郎 / 客串 / 常驻）
    // v687.33：返航 continue/epilogue 模式下跳过（挂载角色也不属于返航后的现实世界）
    if (!_hsSkipNpc) try {
      if (typeof AttachedChars !== 'undefined' && AttachedChars.resolveAll) {
        const attached = await AttachedChars.resolveAll();
        if (attached && attached.length > 0) {
          const attStrs = attached.map(c => {
            let s = `${c.name || '未命名'}`;
            if (c.aliases) s += `（别名：${c.aliases}）`;
            if (c.detail) s += `\n${c.detail}`;
            return s;
          });
          parts.push('【临时加入的角色（挂载角色）】\n以下角色是玩家临时挂载到本对话的，和世界观 NPC 一样可以作为帖子/动态的发布者或评论者。玩家可能就是喜欢这几个角色才挂载进来的，按剧情需要自然安排他们出场。\n' + attStrs.join('\n---\n'));
        }
      }
    } catch(_) {}

    // 4. 最近10轮主线对话记录
    try {
      const msgs = Chat.getMessages() || [];
      const recent = msgs.filter(m => !m.hidden).slice(-20); // 取最后20条消息≈10轮
      if (recent.length > 0) {
        const histStr = recent.map(m => {
          const role = m.role === 'user' ? '玩家' : 'AI';
          const text = (m.content || '').substring(0, 300);
          return `[${role}] ${text}${(m.content || '').length > 300 ? '…' : ''}`;
        }).join('\n');
        parts.push('【最近主线剧情（供参考）】\n' + histStr);
      }
    } catch(_) {}

    return parts.join('\n\n');
  }

  // ===== 加载态跟踪（所有正在跑的任务共享这个计数） =====
  let _generatingCount = 0;
  function _setFabGenerating(on) {
    if (on) _generatingCount++;
    else _generatingCount = Math.max(0, _generatingCount - 1);
    const fab = document.getElementById('phone-fab');
    if (fab) fab.classList.toggle('generating', _generatingCount > 0);
  }
function _extractJsonArrayText(content) {
    const text = String(content || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const directStart = text.indexOf('[');
    if (directStart >= 0) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = directStart; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '[') depth++;
        else if (ch === ']') {
          depth--;
          if (depth === 0) return text.slice(directStart, i + 1);
        }
      }
    }
    const wrapped = text.match(/"(?:results|data|items)"\s*:\s*(\[[\s\S]*\])/i);
    return wrapped ? _extractJsonArrayText(wrapped[1]) : '';
  }

  function _parsePhoneJsonArray(content) {
    const arrText = _extractJsonArrayText(content);
    if (!arrText) throw new Error('返回格式不正确');
    let parsed;
    try {
      parsed = JSON.parse(arrText);
    } catch(e) {
      // 常见轻微漂移修复：尾逗号
      const repaired = arrText.replace(/,\s*([}\]])/g, '$1');
      parsed = JSON.parse(repaired);
    }
    if (!Array.isArray(parsed)) throw new Error('返回内容不是数组');
    return parsed;
  }

  async function _phoneJsonArrayWithRetry(opts) {
    const {
      label = '手机内容', url, key, model, messages,
      temperature = 0.9, max_tokens = 2048,
      onAttempt
    } = opts || {};
    // 默认最多重试 3 次；若对话设置关闭了自动重试则只跑一次
    const baseMax = (opts && Number.isFinite(opts.maxRetries)) ? opts.maxRetries : 3;
    const maxRetries = (typeof Chat !== 'undefined' && Chat.isRetryDisabled && Chat.isRetryDisabled()) ? 1 : baseMax;
    let lastError = '';
    let lastContent = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (typeof onAttempt === 'function') onAttempt(attempt, maxRetries);
        const strictMessages = attempt === 1 ? messages : [
          ...(messages || []),
          { role: 'system', content: '上一次返回无法解析。请立刻重新输出严格 JSON 数组：只能输出以 [ 开头、以 ] 结尾的 JSON；不要 Markdown；不要解释；不要代码块；字符串必须使用英文双引号。' }
        ];
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({ model, messages: strictMessages, stream: false, temperature, max_tokens })
        });
        if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
        const json = await resp.json();
        const content = json.choices?.[0]?.message?.content || '';
        lastContent = content;
        return _parsePhoneJsonArray(content);
      } catch(e) {
        lastError = e.message || String(e);
        console.error(`[Phone] ${label} attempt ${attempt} failed:`, e, lastContent ? { content: lastContent } : '');
        if (attempt < maxRetries) {
          UI.showToast(`${label}生成失败，正在重试…（${attempt + 1}/${maxRetries}）`, 1600);
          await new Promise(r => setTimeout(r, 900));
        }
      }
    }
    throw new Error(lastError || '生成失败');
  }
  // ===== 浮动按钮 =====
  function _updateFab() {
    const fab = document.getElementById('phone-fab');
    if (!fab) return;
    const dot = fab.querySelector('.phone-notif-dot');
    if (dot) dot.style.display = _hasNewNotif && !_isOpen ? '' : 'none';
  }

  function setNotification(flag) {
    _hasNewNotif = flag;
    _updateFab();
  }

  // ===== Modal 创建 =====
  function _createModal() {
    const modal = document.createElement('div');
    modal.id = 'phone-modal';
    modal.className = 'hidden';
    modal.style.cssText = 'position:fixed;inset:0;z-index:500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.38);backdrop-filter:blur(8px)';
    modal.onclick = (e) => { if (e.target === modal) close(); };
 modal.innerHTML = `
 <div class="phone-shell" onclick="event.stopPropagation()">
 <div class="phone-statusbar">
 <span id="phone-time"></span>
 <span class="phone-statusbar-right">
 <span class="phone-signal" aria-label="signal"><i></i><i></i><i></i><i></i></span>
 <span class="phone-wifi" aria-label="wifi"><i></i></span>
 <span id="phone-battery" class="phone-battery"></span>
 </span>
 </div>
 <div class="phone-header">
 <button id="phone-back-btn" class="hidden phone-nav-btn" onclick="Phone.goBack()">${_uiIcon('back', 18)}</button>
 <span id="phone-title">手机</span>
 <div id="phone-header-right" style="margin-left:auto;display:flex;align-items:center;gap:4px"></div>
 </div>
 <div id="phone-body" class="phone-body"></div>
 </div>
 `;
    // 不做点击外部关闭（移动端键盘收起会误触）—— 用 ✕ 按钮关闭
    // 阻止滑动手势穿透到底层（底层页面的侧栏/滚动会被误触发）
    modal.addEventListener('touchmove', (e) => {
      // 只允许 phone-shell 内部的可滚动容器滚动，其余位置禁止滑动冒泡
      const target = e.target;
      const shell = modal.querySelector('.phone-shell');
      if (!shell || !shell.contains(target)) {
        e.preventDefault();
        return;
      }
      // 内部元素：允许它自己滚，但不让事件冒到底层
      e.stopPropagation();
    }, { passive: false });
    modal.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: true });
    document.body.appendChild(modal);
  }

  function _phoneIcon(type) {
 const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
 const icons = {
 gear: `<svg ${common}><circle cx="12" cy="12" r="3"></circle><circle cx="12" cy="12" r="7"></circle><line x1="12" y1="2" x2="12" y2="5"></line><line x1="12" y1="19" x2="12" y2="22"></line><line x1="2" y1="12" x2="5" y2="12"></line><line x1="19" y1="12" x2="22" y2="12"></line></svg>`,
 'phone-down': `<svg ${common}><rect x="7" y="2" width="10" height="20" rx="2"></rect><line x1="11" y1="18" x2="13" y2="18"></line><polyline points="8 11 12 15 16 11"></polyline><line x1="12" y1="6" x2="12" y2="15"></line></svg>`,
 forum: `<svg ${common}><rect x="4" y="5" width="16" height="12" rx="3"></rect><polyline points="8 17 8 21 12 17"></polyline><line x1="8" y1="9" x2="16" y2="9"></line><line x1="8" y1="13" x2="13" y2="13"></line></svg>`,
 map: `<svg ${common}><path d="M18 8c0 3.613-3.869 7.429-5.393 8.795a1 1 0 0 1-1.214 0C9.87 15.429 6 11.613 6 8a6 6 0 0 1 12 0"/><circle cx="12" cy="8" r="2"/><path d="M8.714 14h-3.71a1 1 0 0 0-.948.683l-2.004 6A1 1 0 0 0 3 22h18a1 1 0 0 0 .948-1.316l-2-6a1 1 0 0 0-.949-.684h-3.712"/></svg>`,
 camera: `<svg ${common}><rect x="4" y="7" width="16" height="12" rx="3"></rect><circle cx="12" cy="13" r="3"></circle><path d="M9 7l1.5-2h3L15 7"></path></svg>`,
 aperture: `<svg ${common}><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="M14.31 16H2.83"/><path d="m16.62 12-5.74 9.94"/></svg>`,
 memo: `<svg ${common}><rect x="5" y="3" width="14" height="18" rx="2"></rect><line x1="8" y1="8" x2="16" y2="8"></line><line x1="8" y1="12" x2="16" y2="12"></line><line x1="8" y1="16" x2="13" y2="16"></line></svg>`,
 takeout: `<svg ${common}><path d="M5 9h14l-1 11H6L5 9z"></path><path d="M8 9V6a4 4 0 0 1 8 0v3"></path><line x1="9" y1="13" x2="9" y2="17"></line><line x1="15" y1="13" x2="15" y2="17"></line></svg>`,
 shop: `<svg ${common}><path d="M3 7h18l-2 13H5L3 7z"></path><path d="M8 7V5a4 4 0 0 1 8 0v2"></path></svg>`,
 polaroid: `<svg ${common}><rect x="3" y="5" width="18" height="16" rx="2.5"></rect><rect x="6" y="15" width="12" height="4" rx="0.5"></rect><circle cx="12" cy="10.5" r="3"></circle><circle cx="12" cy="10.5" r="1"></circle><circle cx="17.5" cy="7.8" r="0.6"></circle></svg>`,
  chat: `<svg ${common} stroke-linecap="round" stroke-linejoin="round"><path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"/></svg>`,
 wallet: `<svg ${common}><rect x="2" y="6" width="20" height="14" rx="2"></rect><path d="M16 12h2v2h-2z"></path><path d="M2 10h20"></path></svg>`
 };
 return `<span class="phone-icon-glyph phone-icon-${type}">${icons[type] || ''}</span>`;
}
function _uiIcon(type, size = 16) {
 const common = `viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
 const icons = {
 back: `<svg ${common}><path d="M15 18l-6-6 6-6"></path></svg>`,
 refresh: `<svg ${common}><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path><path d="M3 21v-5h5"></path></svg>`,
 pen: `<svg ${common}><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`,
 share: `<svg ${common}><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>`,
 star: `<svg ${common}><path d="m12 3.5 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.7l-5.56 2.92 1.06-6.2L3 10.03l6.22-.9L12 3.5z"></path></svg>`,
 trash: `<svg ${common}><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>`,
 search: `<svg ${common}><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>`,
 pin: `<svg ${common}><path d="M12 21s6-5.2 6-11a6 6 0 0 0-12 0c0 5.8 6 11 6 11Z"></path><circle cx="12" cy="10" r="2"></circle></svg>`,
 route: `<svg ${common}><circle cx="6" cy="19" r="2"></circle><circle cx="18" cy="5" r="2"></circle><path d="M8 19h4a4 4 0 0 0 0-8h-1a4 4 0 0 1 0-8h5"></path></svg>`,
 image: `<svg ${common}><rect x="3" y="5" width="18" height="14" rx="2"></rect><circle cx="8.5" cy="10" r="1.5"></circle><path d="m21 15-5-5L5 21"></path></svg>`,
 camera: `<svg ${common}><rect x="4" y="7" width="16" height="12" rx="3"></rect><circle cx="12" cy="13" r="3"></circle><path d="M9 7l1.5-2h3L15 7"></path></svg>`,
 heart: `<svg ${common}><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 6.67l-1.06-2.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z"></path></svg>`,
 comment: `<svg ${common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"></path></svg>`,
 download: `<svg ${common}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path></svg>`,
 settings: `<svg ${common}><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"></path></svg>`
 };
 return icons[type] || '';
}
function _renderHomeIcon(a) {
 // 占位图标：渲染成空白格子（无图标、无标签、不可点）
 if (a.icon === 'placeholder') {
   return `<div class="phone-app-icon phone-app-placeholder" aria-hidden="true">
     <div class="phone-app-icon-circle phone-app-icon-circle-placeholder"></div>
     <span class="phone-app-icon-label">&nbsp;</span>
   </div>`;
 }
 const action = a.id === 'minimize' ? 'Phone.minimize()' : `Phone.openApp('${a.id}')`;
 // 心动模拟 APP：用世界观图标 png 而非 SVG
 const iconHTML = a.icon === 'heartsim'
   ? `<img src="img/worldviews/heartsim.png" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block">`
   : _phoneIcon(a.icon);
 return `<div class="phone-app-icon phone-app-${a.id}" onclick="${action}">
 <div class="phone-app-icon-circle">${iconHTML}</div>
 <span class="phone-app-icon-label">${Utils.escapeHtml(a.name)}</span>
 </div>`;
}

// ===== 主屏幕 =====
  function _renderHomeScreen() {
    const body = document.getElementById('phone-body');
    if (!body) return;
document.getElementById('phone-back-btn')?.classList.add('hidden');
  document.querySelector('#phone-modal .phone-shell')?.classList.remove('phone-forum-detail-mode');
  document.querySelector('#phone-modal .phone-shell')?.classList.add('phone-home-mode');
  document.getElementById('phone-title').textContent = '';
  const headerRight = document.getElementById('phone-header-right');
  if (headerRight) headerRight.innerHTML = '';

    // 系统 App：饿了咪/桃宝 + 心动模拟（仅特定世界观）+ 占位
      const isHeartSim = document.body?.getAttribute('data-worldview') === '心动模拟';
      const slot3 = isHeartSim
        ? { id: 'heartsim_app', icon: 'heartsim', name: '心动模拟' }
        : { id: '__placeholder1__', icon: 'placeholder', name: '' };
      const slot4 = { id: '__placeholder2__', icon: 'placeholder', name: '' };
      const systemApps = [
        { id: 'takeout', icon: 'takeout', name: (_shopMeta?.takeout?.name || '饿了咪') },
        { id: 'shop', icon: 'shop', name: (_shopMeta?.shop?.name || '桃宝') },
        slot3,
        slot4,
      ];
      const apps = [
        { id: 'forum', icon: 'forum', name: _getForumName() },
 { id: 'map', icon: 'map', name: '地图' },
        { id: 'moments', icon: 'aperture', name: '好友圈' },
        { id: 'memo', icon: 'memo', name: '备忘录' },
      ];
      // 第二页 app
      const apps2 = [
        { id: 'wallet', icon: 'wallet', name: '钱包' },
        { id: 'settings', icon: 'gear', name: '设置' },
      ];
      // 底部 dock：相机、聊天、收起手机
      const dockApps = [
        { id: 'camera', icon: 'polaroid', name: '相机' },
        { id: 'chat', icon: 'chat', name: '聊天' },
        { id: 'minimize', icon: 'phone-down', name: '收起手机' },
            ];
 body.innerHTML = `
 <div class="phone-home">
 <div class="phone-pages" id="phone-pages" onscroll="Phone._onPagesScroll()">
 <div class="phone-page">
 <div class="phone-widget">
  <div class="phone-widget-time" id="phone-widget-time">--:--</div>
  <div class="phone-widget-subline">
    <div class="phone-widget-date" id="phone-widget-date"></div>
    <div class="phone-widget-weather" id="phone-widget-weather"></div>
  </div>
</div>
<div class="phone-home-spacer"></div>
<div class="phone-profile-card" id="phone-profile-card">
  <div class="phone-profile-text">
    <div class="phone-profile-name" id="phone-profile-name"
         contenteditable="true" spellcheck="false"
         data-placeholder="Polaris"
         onfocus="Phone._onProfileFocus('name', this)"
         onblur="Phone._onProfileBlur('name', this)"
         onkeydown="Phone._onProfileKeydown(event, 'name', this)"
         oninput="Phone._onProfileInput('name', this, 20)">Polaris</div>
    <div class="phone-profile-bio" id="phone-profile-bio"
         contenteditable="true" spellcheck="false"
         data-placeholder="The still point where all worlds turn."
         onfocus="Phone._onProfileFocus('bio', this)"
         onblur="Phone._onProfileBlur('bio', this)"
         onkeydown="Phone._onProfileKeydown(event, 'bio', this)"
         oninput="Phone._onProfileInput('bio', this, 60)">The still point where all worlds turn.</div>
  </div>
  <div class="phone-profile-avatar" id="phone-profile-avatar" onclick="Phone._pickProfileAvatar()"></div>
</div>
<div class="phone-system-grid">
${systemApps.map(a => _renderHomeIcon(a)).join('')}
</div>
<div class="phone-app-grid">
 ${apps.map(a => _renderHomeIcon(a)).join('')}
 </div>
 <div class="phone-home-bottom-spacer"></div>
 </div>
 <div class="phone-page">
 <div class="phone-app-grid" style="padding-top:40px">
 ${apps2.map(a => _renderHomeIcon(a)).join('')}
 </div>
 <div class="phone-home-spacer"></div>
 </div>
 </div>
 <div class="phone-page-indicator" id="phone-page-indicator">
   <div class="phone-page-dot active"></div>
   <div class="phone-page-dot"></div>
 </div>
 <div class="phone-dock">
   ${dockApps.map(a => _renderHomeIcon(a)).join('')}
 </div>
 </div>
 `;

 // 填充小组件数据（从 status 缓存拿）
 _refreshWidget();
 _getPhoneData().then(pd => { _applyWallpaper(pd); _applyProfile(pd); }).catch(() => {});
 _currentApp = null;
  }

  // 主屏分页滚动：更新页面指示器
  function _onPagesScroll() {
    const pages = document.getElementById('phone-pages');
    const indicator = document.getElementById('phone-page-indicator');
    if (!pages || !indicator) return;
    const pageW = pages.clientWidth || 1;
    const idx = Math.round(pages.scrollLeft / pageW);
    indicator.querySelectorAll('.phone-page-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === idx);
    });
  }

  let _navStack = []; // 导航栈：每一项是 function
  let _isNavBack = false; // 防止 goBack 触发的渲染再次 push

  function _pushNav(renderFn) {
    if (_isNavBack) return; // goBack 触发的渲染不 push
    _navStack.push(renderFn);
    document.getElementById('phone-back-btn')?.classList.remove('hidden');
  }

  async function goBack() {
    if (_navStack.length > 1) {
      _navStack.pop();
      const prev = _navStack[_navStack.length - 1];
      _isNavBack = true;
      try {
        // await：渲染函数可能是 async（内部有 await _getPhoneData()），
        // 必须等它完全执行完（含内部 _pushNav 被拦截）再重置标志，
        // 否则 async 让出执行后标志提前归位，导致重复 push、栈清不空、返回失效。
        await prev();
      } finally {
        _isNavBack = false;
      }
    } else {
      _navStack = [];
      _renderHomeScreen();
    }
    // 防 ghost click：返回按钮 touchend 后浏览器会再派发一次 click，
    // 此时新 DOM 已经在按钮下方位置，会误触新渲染元素的 onclick。
      try { document.querySelector('#phone-modal .phone-shell')?.classList.toggle('phone-forum-detail-mode', !!document.querySelector('#phone-body .phone-forum-detail-page')); } catch(_) {}
      _shieldGhostClick();
  }

  // 短暂禁用 phone-body 的点击，吃掉触摸返回后的鬼 click
  function _shieldGhostClick() {
    const body = document.getElementById('phone-body');
    if (!body) return;
    body.style.pointerEvents = 'none';
    setTimeout(() => { body.style.pointerEvents = ''; }, 320);
  }

  function goHome() {
    _navStack = [];
    _renderHomeScreen();
  }

  function _refreshWidget() {
    try {
      const s = Conversations.getStatusBar();
      const timeEl = document.getElementById('phone-widget-time');
 const topTimeEl = document.getElementById('phone-time');
 const dateEl = document.getElementById('phone-widget-date');
      const weatherEl = document.getElementById('phone-widget-weather');
      if (!s) {
 if (timeEl) timeEl.textContent = '--:--';
 if (topTimeEl) topTimeEl.textContent = '--:--';
 if (dateEl) dateEl.textContent = '';
        if (weatherEl) weatherEl.textContent = '';
        return;
      }
      // 从 time 字段里拆出钟点和日期
      const timeStr = s.time || '';
      const clockMatch = timeStr.match(/(\d{1,2}:\d{2})/);
      const clockText = clockMatch ? clockMatch[1] : '--:--';
 if (timeEl) timeEl.textContent = clockText;
 if (topTimeEl) topTimeEl.textContent = clockText;
      // 日期部分：去掉钟点剩下的
      const datePart = timeStr.replace(/\s*\d{1,2}:\d{2}\s*/, ' ').trim();
      if (dateEl) dateEl.textContent = datePart || '';
      if (weatherEl) weatherEl.textContent = s.weather || '';
    } catch(_) {}
  }

  // ===== App 路由 =====
async function openApp(appId) {
  // 心动模拟：被锁时拦截
  try {
    if (typeof StatusBar !== 'undefined' && StatusBar.isPhoneLocked && StatusBar.isPhoneLocked()) {
      const info = StatusBar.getPhoneLockInfo?.();
      const by = info?.lockedBy || '心动目标';
      UI.showToast(`手机被${by}锁起来了，拿不到`, 2500);
      try { close(); } catch(_) {}
      return;
    }
  } catch(_) {}
  _currentApp = appId;
 document.querySelector('#phone-modal .phone-shell')?.classList.remove('phone-forum-detail-mode');
 document.querySelector('#phone-modal .phone-shell')?.classList.remove('phone-home-mode');
 document.getElementById('phone-back-btn')?.classList.remove('hidden');

    const phoneData = await _getPhoneData();
    if (!phoneData) { UI.showToast('无法获取手机数据', 1500); return; }

    // push App 列表页到导航栈
    const renderApp = () => {
 switch (appId) {
 case 'settings': _renderSettings(phoneData); break;
 case 'wallet': _renderWallet(phoneData); break;
 case 'forum': _renderForum(phoneData); break;
 case 'map': _renderMap(phoneData); break;
 case 'moments': _renderMoments(phoneData); break;
 case 'memo': _renderMemo(phoneData); break;
 case 'chat': _renderChatApp(phoneData); break;
 case 'takeout': _renderShopping(phoneData, 'takeout'); break;
 case 'shop': _renderShopping(phoneData, 'shop'); break;
 case 'camera': _renderCamera(phoneData); break;
 case 'heartsim_app': _renderHeartSimApp(phoneData); break;
 }
 document.getElementById('phone-back-btn')?.classList.remove('hidden');
 };
    _navStack = [renderApp]; // 重置栈，App 列表页为栈底
    renderApp();
  }

// ===== 钱包 App =====
async function _renderWallet(pd) {
  const body = document.getElementById('phone-body');
  document.getElementById('phone-title').textContent = '钱包';
  _applyWallpaper(pd);

  // 读取当前对话的属性定义和值
  let globalAttrs = [];
  let statusAttrs = {};
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const gp = conv?.convGameplay || null;
    globalAttrs = (gp?.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim());
    const sb = Conversations.getStatusBar() || {};
    statusAttrs = sb?.customAttrs?.global || {};
  } catch(_) {}

  // 已绑定的货币列表
  pd.walletCurrencies = pd.walletCurrencies || [];
  // 过滤掉已不存在的属性
  pd.walletCurrencies = pd.walletCurrencies.filter(id => globalAttrs.some(a => a.id === id));

  if (!globalAttrs.length) {
    body.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:40px 20px;text-align:center">
        <div style="font-size:40px;margin-bottom:16px">💰</div>
        <div style="font-size:14px;color:var(--text-secondary);line-height:1.8">当前对话没有可用的自定义属性<br><span style="font-size:12px;opacity:0.7">请先在世界观中配置自定义属性</span></div>
      </div>`;
    return;
  }

  // 已绑定的卡片
  const boundCards = pd.walletCurrencies.map(id => {
    const def = globalAttrs.find(a => a.id === id);
    if (!def) return '';
    const val = statusAttrs[id] ?? def.initial ?? 0;
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px">
        <div style="width:36px;height:36px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#111" stroke-width="2"><rect x="2" y="6" width="20" height="14" rx="2"></rect><path d="M16 12h2v2h-2z"></path><path d="M2 10h20"></path></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(def.name)}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">余额</div>
        </div>
        <div style="font-size:18px;font-weight:700;color:var(--accent);flex-shrink:0">${Utils.escapeHtml(String(val))}</div>
        <button onclick="Phone._walletRemoveCurrency('${Utils.escapeHtml(id)}')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px;flex-shrink:0" title="移除">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>`;
  }).join('');

  // 可添加的属性（未绑定的）
  const unboundAttrs = globalAttrs.filter(a => !pd.walletCurrencies.includes(a.id));

  body.innerHTML = `
    <div style="padding:16px;display:flex;flex-direction:column;gap:12px;height:100%;overflow-y:auto">
      ${boundCards || '<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:20px 0">还没有绑定货币<br><span style="font-size:11px;opacity:0.7">点击下方按钮从属性中选择</span></div>'}
      ${unboundAttrs.length ? `<button onclick="Phone._walletAddCurrency()" style="width:100%;padding:12px;border-radius:10px;border:1px dashed var(--border);background:transparent;color:var(--text-secondary);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
        添加货币
      </button>` : ''}
    </div>`;
}

// 钱包：添加货币（弹出可选属性列表）
async function _walletAddCurrency() {
  const pd = await _getPhoneData();
  if (!pd) return;
  let globalAttrs = [];
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const gp = conv?.convGameplay || null;
    globalAttrs = (gp?.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim());
  } catch(_) {}

  pd.walletCurrencies = pd.walletCurrencies || [];
  const unboundAttrs = globalAttrs.filter(a => !pd.walletCurrencies.includes(a.id));
  if (!unboundAttrs.length) { UI.showToast('所有属性都已绑定', 1500); return; }

  const sb = Conversations.getStatusBar() || {};
  const statusAttrs = sb?.customAttrs?.global || {};

  // 弹底部选择面板
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center';
  const listHtml = unboundAttrs.map(a => {
    const val = statusAttrs[a.id] ?? a.initial ?? 0;
    return `<div data-id="${Utils.escapeHtml(a.id)}" style="padding:12px 16px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--bg-tertiary);display:flex;align-items:center;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;color:var(--text);font-weight:600">${Utils.escapeHtml(a.name)}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">当前值：${Utils.escapeHtml(String(val))}</div>
      </div>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
    </div>`;
  }).join('');
  mask.innerHTML = `<div style="background:var(--bg);border-radius:16px 16px 0 0;padding:20px 16px;max-height:60vh;overflow-y:auto;width:100%;max-width:400px">
    <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:12px">选择属性作为货币</div>
    <div style="display:flex;flex-direction:column;gap:8px">${listHtml}</div>
  </div>`;

  mask.querySelector('div').addEventListener('click', async (e) => {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    const attrId = item.dataset.id;
    pd.walletCurrencies.push(attrId);
    await _savePhoneData();
    document.body.removeChild(mask);
    _renderWallet(pd);
  });
  mask.addEventListener('click', (e) => {
    if (e.target === mask) document.body.removeChild(mask);
  });
  document.body.appendChild(mask);
}

// 钱包：移除货币
async function _walletRemoveCurrency(attrId) {
  const pd = await _getPhoneData();
  if (!pd) return;
  pd.walletCurrencies = (pd.walletCurrencies || []).filter(id => id !== attrId);
  await _savePhoneData();
  _renderWallet(pd);
}

// ===== 聊天转账功能 =====
async function _openChatTransfer(contactId) {
  // 隐藏加号菜单
  const menu = document.getElementById('phone-chat-plus-menu');
  if (menu) menu.classList.add('hidden');

  const pd = await _getPhoneData();
  if (!pd) return;
  pd.walletCurrencies = pd.walletCurrencies || [];

  // 获取可用货币
  let walletInfos = [];
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const gp = conv?.convGameplay || null;
    const globalAttrs = (gp?.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim());
    const sb = Conversations.getStatusBar() || {};
    const statusAttrs = sb?.customAttrs?.global || {};
    walletInfos = pd.walletCurrencies
      .map(id => {
        const def = globalAttrs.find(a => a.id === id);
        if (!def) return null;
        return { id, name: def.name, balance: statusAttrs[id] ?? def.initial ?? 0 };
      })
      .filter(Boolean);
  } catch(_) {}

  if (!walletInfos.length) {
    UI.showToast('请先在钱包中绑定货币', 2000);
    return;
  }

  // 弹转账弹窗
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:20px';

  const currencyOptions = walletInfos.map((w, i) =>
    `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--bg-tertiary)">
      <input type="radio" name="transfer-currency" value="${Utils.escapeHtml(w.id)}" ${i === 0 ? 'checked' : ''} style="accent-color:var(--accent)">
      <span style="flex:1;font-size:13px;color:var(--text)">${Utils.escapeHtml(w.name)}</span>
      <span style="font-size:12px;color:var(--text-secondary)">余额 ${Utils.escapeHtml(String(w.balance))}</span>
    </label>`
  ).join('');

  mask.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:20px;max-width:340px;width:100%;color:var(--text)">
      <div style="font-size:15px;font-weight:600;margin-bottom:14px">转账</div>
      <div style="font-size:12px;color:var(--text);font-weight:600;margin-bottom:8px">选择货币</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">${currencyOptions}</div>
      <div style="font-size:12px;color:var(--text);font-weight:600;margin-bottom:8px">转账金额</div>
      <input id="transfer-amount-input" type="number" placeholder="输入金额" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);color:var(--text);font-size:14px;outline:none;box-sizing:border-box;margin-bottom:16px">
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="transfer-cancel" style="padding:8px 18px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
        <button id="transfer-confirm" style="padding:8px 18px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">确认转账</button>
      </div>
    </div>`;

  mask.querySelector('#transfer-cancel').onclick = () => document.body.removeChild(mask);
  mask.querySelector('#transfer-confirm').onclick = async () => {
    const selected = mask.querySelector('input[name="transfer-currency"]:checked');
    const currencyId = selected?.value || walletInfos[0].id;
    const info = walletInfos.find(w => w.id === currencyId);
    const amountStr = mask.querySelector('#transfer-amount-input').value.trim();
    const amount = parseFloat(amountStr);

    if (!amountStr || !Number.isFinite(amount) || amount <= 0) {
      UI.showToast('请输入有效金额', 1500);
      return;
    }

    // 检查余额
    try {
      const sb = Conversations.getStatusBar() || {};
      sb.customAttrs = sb.customAttrs || {};
      sb.customAttrs.global = sb.customAttrs.global || {};
      const balance = Number(sb.customAttrs.global[currencyId]) || 0;
      if (balance < amount) {
        UI.showToast(`${info.name}余额不足（需要 ${amount}，当前 ${balance}）`, 2500);
        return;
      }
      // 扣款
      sb.customAttrs.global[currencyId] = balance - amount;
      await Conversations.setStatusBar(sb);
      if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(sb);
    } catch(e) {
      UI.showToast('扣款失败', 1500);
      return;
    }

    document.body.removeChild(mask);

    // 写入聊天记录
    let gameTime = '';
    try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}

    pd.chatThreads = pd.chatThreads || {};
    pd.chatThreads[contactId] = pd.chatThreads[contactId] || [];
    pd.chatThreads[contactId].push({
      id: 'msg_' + Utils.uuid().slice(0, 8),
      role: 'me',
      type: 'transfer',
      transferAmount: amount,
      transferCurrency: info.name,
      transferCurrencyId: currencyId,
      text: `[转账] ${amount} ${info.name}`,
      time: gameTime,
      createdAt: Date.now()
    });
    await _savePhoneData();

    // 操作日志
    const newBalance = (Number(Conversations.getStatusBar()?.customAttrs?.global?.[currencyId]) || 0);
    _log(`向聊天对象转账了 ${amount} ${info.name}（前端已自动扣除，余额 ${newBalance}，AI无需再处理此扣款）`);
    const _ctName = (pd.chatContacts || []).find(c => c.id === contactId)?.name || contactId;
    _addChatMessageToRoundLog(contactId, 'me', `[转账] ${amount} ${info.name}`, gameTime, _ctName);

    // 刷新聊天界面
    _openChatThread(contactId);
  };

  mask.addEventListener('click', (e) => {
    if (e.target === mask) document.body.removeChild(mask);
  });
  document.body.appendChild(mask);
}

  // ===== 设置 App =====
function _renderSettings(pd) {
 const body = document.getElementById('phone-body');
 document.getElementById('phone-title').textContent = '设置';
 _applyWallpaper(pd);
 body.innerHTML = `
 <div class="phone-settings-page">
 <div class="phone-settings-card">
 <div class="phone-settings-title">壁纸</div>
 <div class="phone-settings-desc">上传一张图片作为当前对话的手机桌面壁纸。</div>
 <button class="phone-settings-btn" onclick="Phone._onWallpaperPicked()">更换壁纸</button>
 <button class="phone-settings-btn secondary" onclick="Phone._resetWallpaper()">恢复默认壁纸</button>
 <label class="circle-check-label" style="margin-top:10px;padding:0">
   <span class="circle-check-text" style="font-size:13px">壁纸遮罩<br><span style="font-size:11px;color:var(--text-secondary)">为深色壁纸添加半透明遮罩，让文字更清晰</span></span>
   <span style="position:relative;display:inline-flex">
     <input type="checkbox" id="phone-wallpaper-overlay" class="circle-check" ${pd?.wallpaperOverlay ? 'checked' : ''} onchange="Phone._toggleWallpaperOverlay(this.checked)">
     <span class="circle-check-ui"></span>
   </span>
 </label>
 <div style="margin-top:14px">
   <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
     <span style="font-size:13px;color:var(--text)">卡片不透明度</span>
     <span id="phone-wallpaper-opacity-val" style="font-size:12px;color:var(--text-secondary)">${typeof pd?.wallpaperOpacity === 'number' ? pd.wallpaperOpacity : 75}%</span>
   </div>
   <input type="range" min="0" max="100" step="1" value="${typeof pd?.wallpaperOpacity === 'number' ? pd.wallpaperOpacity : 75}" oninput="Phone._onWallpaperOpacityChange(this.value)" onchange="Phone._saveWallpaperOpacity(this.value)" style="width:100%;accent-color:var(--accent)">
   <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;line-height:1.4">调节卡片、顶栏、底栏的不透明度，让壁纸透出来（仅在有壁纸时生效）</div>
 </div>
 </div>
 <div class="phone-settings-card">
 <div class="phone-settings-title">本轮操作发送</div>
 <div class="phone-settings-desc">把你在手机里的操作（发动态/下单/搜索等）作为背景行为告诉 AI，让剧情自然回应。关闭后本轮操作仅本地记录，不会发送给 AI。</div>
 <label class="circle-check-label" style="margin-top:0;padding:0">
   <span class="circle-check-text" style="font-size:13px">发送本轮手机操作</span>
   <span style="position:relative;display:inline-flex">
     <input type="checkbox" id="phone-send-actionlog" class="circle-check" ${pd?.sendActionLog !== false ? 'checked' : ''} onchange="Phone._toggleSendActionLog(this.checked)">
     <span class="circle-check-ui"></span>
   </span>
 </label>
 </div>
 </div>
 `;
}

async function _onWallpaperPicked() {
    const dataUrl = await Utils.promptImageInput({ maxSize: 1600, quality: 0.82 });
    if (!dataUrl) return;
    try {
      const pd = await _getPhoneData();
      if (!pd) return;
      pd.wallpaper = dataUrl;
      await _savePhoneData();
      _applyWallpaper(pd);
      _log('更换了手机壁纸');
      UI.showToast('壁纸已更新');
      _renderSettings(pd);
    } catch(err) {
      console.error('[Phone] 壁纸上传失败', err);
      UI.showToast('壁纸上传失败');
 }
}
async function _resetWallpaper() {
    const pd = await _getPhoneData();
    if (!pd) return;
    pd.wallpaper = '';
    await _savePhoneData();
    _applyWallpaper(pd);
    _log('恢复了默认手机壁纸');
    UI.showToast('已恢复默认壁纸');
    _renderSettings(pd);
  }

  async function _toggleWallpaperOverlay(checked) {
    const pd = await _getPhoneData();
    if (!pd) return;
    pd.wallpaperOverlay = !!checked;
    await _savePhoneData();
    _applyWallpaper(pd);
  }

  function _onWallpaperOpacityChange(val) {
    // 拖动实时预览：只更新 CSS 变量 + 显示数字，不写库
    const opacity = Math.max(0, Math.min(100, parseInt(val, 10) || 0));
    const shell = document.querySelector('#phone-modal .phone-shell');
    if (shell) {
      shell.style.setProperty('--phone-card-opacity', String(opacity));
      shell.style.setProperty('--phone-card-opacity-pct', opacity + '%');
    }
    const label = document.getElementById('phone-wallpaper-opacity-val');
    if (label) label.textContent = opacity + '%';
  }

  async function _saveWallpaperOpacity(val) {
const pd = await _getPhoneData();
if (!pd) return;
pd.wallpaperOpacity = Math.max(0, Math.min(100, parseInt(val, 10) || 0));
await _savePhoneData();
}

async function _toggleSendActionLog(checked) {
const pd = await _getPhoneData();
if (!pd) return;
pd.sendActionLog = !!checked;
await _savePhoneData();
}

async function _onMomentsCoverPicked() {
  const dataUrl = await Utils.promptImageInput({ maxSize: 1200, quality: 0.82 });
  if (!dataUrl) return;
  try {
  const pd = await _getPhoneData();
  if (!pd) return;
  pd.momentsCover = dataUrl;
  await _savePhoneData();
  UI.showToast('好友圈封面已更新');
  _renderMoments(pd);
  } catch(e) {
  console.error('[Phone] 好友圈封面上传失败', e);
  UI.showToast('封面上传失败');
  }
}

async function _clearMomentsCover() {
 const pd = await _getPhoneData();
 if (!pd) return;
 pd.momentsCover = '';
 await _savePhoneData();
 UI.showToast('已恢复默认封面');
 _renderMoments(pd);
}

// ===== 外壳渲染 =====
// ===== 各 App 占位渲染 =====
  let _forumTab = 'posts'; // 'posts' | 'history' | 'myposts'

  // 论坛头像匹配：根据用户名（本名/代号/网名）从 NPC 头像表中查找
  let _forumNpcAvatarMap = null; // 延迟初始化
  async function _ensureForumNpcAvatarMap() {
    // 每次进论坛都重建，确保最新头像数据
    const map = {};
    try {
      const avatarRows = await DB.getAll('npcAvatars');
      const avatarById = {};
      avatarRows.forEach(a => { if (a && a.id) avatarById[a.id] = a.avatar || ''; });
      const all = await DB.getAll('worldviews');
      all.forEach(wv => {
        const addNpc = (n) => {
          if (!n) return;
          const url = avatarById[n.id] || n.avatar || '';
          if (!url) return;
          const names = [n.name, ...(String(n.aliases || '').split(/[,，、\s]+/)), ...(String(n.onlineName || '').split(/[,，、\s]+/))].map(x => String(x || '').trim()).filter(Boolean);
          names.forEach(name => { if (!map[name]) map[name] = url; });
        };
        (wv.globalNpcs || []).forEach(addNpc);
        (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(addNpc)));
      });
      // 补充：单人卡头像
      const convId = Conversations.getCurrent();
      const conv = Conversations.getList().find(c => c.id === convId);
      try {
        if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
          const card = await DB.get('singleCards', conv.singleCharId);
          const scAvatar = avatarById[conv.singleCharId] || card?.avatar || '';
          if (card && scAvatar) {
            const names = [card.name, ...(String(card.aliases || '').split(/[,，、\s]+/)), ...(String(card.onlineName || '').split(/[,，、\s]+/))].map(x => String(x || '').trim()).filter(Boolean);
            names.forEach(name => { if (!map[name]) map[name] = scAvatar; });
          }
        }
      } catch(_) {}
      // 补充：当前对话生效的世界书 NPC
      try {
        if (typeof Lorebook !== 'undefined' && Lorebook.collectForChat) {
          let card = null;
          if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
            try { card = await DB.get('singleCards', conv.singleCharId); } catch(_) {}
          }
          const wvId = conv?.worldviewId || conv?.singleWorldviewId;
          const wv2 = wvId ? await DB.get('worldviews', wvId) : null;
          const lbs = await Lorebook.collectForChat({ conv, card, wv: wv2 });
          for (const lb of (lbs || [])) {
            (lb.globalNpcs || []).forEach(n => {
              if (!n) return;
              const url = avatarById[n.id] || n.avatar || '';
              if (!url) return;
              const names = [n.name, ...(String(n.aliases || '').split(/[,，、\s]+/)), ...(String(n.onlineName || '').split(/[,，、\s]+/))].map(x => String(x || '').trim()).filter(Boolean);
              names.forEach(name => { if (!map[name]) map[name] = url; });
            });
          }
        }
      } catch(_) {}
      // 补充：挂载角色
      try {
        if (typeof AttachedChars !== 'undefined' && AttachedChars.resolveAll) {
          const attached = await AttachedChars.resolveAll();
          (attached || []).forEach(c => {
            if (!c || !c.name) return;
            const url = (c.id && avatarById[c.id]) || c.avatar || '';
            if (!url) return;
            const names = [c.name, ...(String(c.aliases || '').split(/[,，、\s]+/)), ...(String(c.onlineName || '').split(/[,，、\s]+/))].map(x => String(x || '').trim()).filter(Boolean);
            names.forEach(name => { if (!map[name]) map[name] = url; });
          });
        }
      } catch(_) {}
    } catch(_) {}
    _forumNpcAvatarMap = map;
    return map;
  }

  let _forumDisplayNameMap = {}; // username → 优先显示名（网名 > 本名）

  // 构建显示名映射（在 _ensureForumNpcAvatarMap 之后紧接调用）
  async function _ensureForumDisplayNameMap() {
    const dmap = {};
    try {
      const all = await DB.getAll('worldviews');
      const addNpc = (n) => {
        if (!n || !n.name) return;
        const displayName = (n.onlineName || '').trim() || n.name;
        // 本名 → 显示名
        dmap[n.name] = displayName;
        // 代号/别称 → 显示名
        String(n.aliases || '').split(/[,，、\s]+/).map(x => x.trim()).filter(Boolean).forEach(a => { if (!dmap[a]) dmap[a] = displayName; });
      };
      all.forEach(wv => {
        (wv.globalNpcs || []).forEach(addNpc);
        (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(addNpc)));
      });
      // 世界书 NPC
      try {
        if (typeof Lorebook !== 'undefined' && Lorebook.collectForChat) {
          const convId = (typeof Conversations !== 'undefined') ? Conversations.getCurrent() : null;
          const conv = convId ? Conversations.getList().find(c => c.id === convId) : null;
          let card = null;
          if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
            try { card = await DB.get('singleCards', conv.singleCharId); } catch(_) {}
          }
          const wvId = conv?.worldviewId || conv?.singleWorldviewId;
          const wv2 = wvId ? await DB.get('worldviews', wvId) : null;
          const lbs = await Lorebook.collectForChat({ conv, card, wv: wv2 });
          for (const lb of (lbs || [])) { (lb.globalNpcs || []).forEach(addNpc); }
        }
      } catch(_) {}
      // 单人卡
      try {
        const convId = (typeof Conversations !== 'undefined') ? Conversations.getCurrent() : null;
        const conv = convId ? Conversations.getList().find(c => c.id === convId) : null;
        if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
          const card = await DB.get('singleCards', conv.singleCharId);
          if (card && card.name) addNpc(card);
        }
      } catch(_) {}
      // 挂载角色
      try {
        if (typeof AttachedChars !== 'undefined' && AttachedChars.resolveAll) {
          const attached = await AttachedChars.resolveAll();
          (attached || []).forEach(c => { if (c) addNpc(c); });
        }
      } catch(_) {}
    } catch(_) {}
    _forumDisplayNameMap = dmap;
  }

  // 给帖子/评论匹配 NPC 头像 + 显示名替换
  function _matchForumAvatar(item) {
    // 显示名替换：优先网名
    if (item.username && _forumDisplayNameMap[item.username]) {
      item.username = _forumDisplayNameMap[item.username];
    }
    // 头像匹配
    if (item.avatar) return;
    if (_forumNpcAvatarMap && _forumNpcAvatarMap[item.username]) {
      item.avatar = _forumNpcAvatarMap[item.username];
    }
  }

  async function _renderForum(pd) {
    const body = document.getElementById('phone-body');
    document.getElementById('phone-title').textContent = _getForumName();

    // 确保论坛头像映射已就绪
    await _ensureForumNpcAvatarMap();
    await _ensureForumDisplayNameMap();

    // 统一以 phoneData 缓存为准（WorldVoice 仅作为生成器）
    const posts = pd.cachedForumPosts || [];
    // 给帖子和评论匹配NPC头像
    posts.forEach(p => {
      _matchForumAvatar(p);
      (p._comments || []).forEach(c => _matchForumAvatar(c));
    });
    const searchHistory = pd.forumSearchHistory || [];

    const historyHtml = searchHistory.length > 0
      ? searchHistory.slice(-30).reverse().map((s, idx) => {
          const realIdx = searchHistory.length - 1 - idx;
          return `<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;display:flex;gap:8px;align-items:center">
            <span class="phone-search-history-item" style="flex:1;color:var(--text)">${_uiIcon('search', 13)} ${Utils.escapeHtml(s.query || '')}</span>
            <span style="color:var(--text-secondary);font-size:10px;white-space:nowrap">${Utils.escapeHtml(_fmtHistoryTime(s.time))}</span>
            <span onclick="Phone._shareForumSearch(${realIdx})" class="phone-share-mini" title="分享到主线">${_uiIcon('share', 13)}</span>
            <span onclick="Phone._deleteForumSearch(${realIdx})" class="phone-share-mini" style="color:var(--error)" title="删除">${_uiIcon('trash', 13)}</span>
          </div>`;
        }).join('')
      : '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">暂无搜索记录</p>';

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%">
        <div id="phone-forum-posts-panel" style="flex:1;overflow-y:auto;padding:10px 12px;display:${_forumTab === 'posts' ? 'block' : 'none'}">
          <div style="display:flex;gap:6px;margin-bottom:8px">
            <input id="phone-forum-search" type="text" placeholder="搜索…" style="flex:1;border:1px solid var(--border);border-radius:6px;padding:6px 10px;background:var(--bg-tertiary);color:var(--text);font-size:13px">
            <button onclick="Phone._forumSearch()" style="background:var(--accent);color:#111;border:none;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;white-space:nowrap">搜索</button>
          </div>
          <div style="display:flex;gap:6px;margin-bottom:10px">
            <button onclick="Phone._forumRefresh()" style="flex:1;display:flex;align-items:center;justify-content:center;gap:4px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;padding:6px 0;font-size:12px;cursor:pointer;color:var(--text)">${_uiIcon('refresh', 13)} 刷新</button>
            <button onclick="Phone._addForumPost()" style="flex:1;display:flex;align-items:center;justify-content:center;gap:4px;background:var(--accent);color:#111;border:none;border-radius:6px;padding:6px 0;font-size:12px;cursor:pointer;font-weight:600">+ 发帖</button>
          </div>
          <div id="phone-forum-posts" style="margin-top:4px">
            ${posts.length === 0 ? '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">点击刷新按钮获取推荐</p>' :
              _renderForumPosts(posts)}
          </div>
        </div>
        <div id="phone-forum-history-panel" style="flex:1;overflow-y:auto;padding:12px;display:${_forumTab === 'history' ? 'block' : 'none'}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-size:11px;color:var(--text-secondary)">共 ${searchHistory.length} 条搜索记录</span>
            ${searchHistory.length > 0 ? `<span onclick="Phone._shareAllForumSearches()" class="phone-share-text" title="全部分享到主线">${_uiIcon('share', 13)} 全部分享</span>` : ''}
          </div>
          ${historyHtml}
        </div>
        <div id="phone-forum-myposts-panel" style="flex:1;overflow-y:auto;padding:12px;display:${_forumTab === 'myposts' ? 'block' : 'none'}">
          ${_renderMyForumPosts(pd.myForumPosts || [])}
        </div>
        <div class="phone-tabbar">
          <div class="phone-tab ${_forumTab === 'posts' ? 'active' : ''}" onclick="Phone._switchForumTab('posts')">推荐</div>
          <div class="phone-tab ${_forumTab === 'history' ? 'active' : ''}" onclick="Phone._switchForumTab('history')">搜索记录</div>
          <div class="phone-tab ${_forumTab === 'myposts' ? 'active' : ''}" onclick="Phone._switchForumTab('myposts')">我的</div>
        </div>
      </div>
    `;
  }

  async function _switchForumTab(tab) {
    _forumTab = tab;
    const pd = await _getPhoneData();
    if (pd) _renderForum(pd);
  }

  function _shareForumSearch(index) {
    const pd = _getPhoneData; // 外层异步拿
    (async () => {
      const _pd = await _getPhoneData();
      const s = _pd?.forumSearchHistory?.[index];
      if (!s) return;
      _shareToMain('forum', `${_getForumName()}搜索`, `搜索关键词：${s.query || ''}\n时间：${s.time || ''}`);
    })();
  }

  async function _shareAllForumSearches() {
    const pd = await _getPhoneData();
    const list = pd?.forumSearchHistory || [];
    if (list.length === 0) return;
    const content = list.slice(-10).map(s => `- ${s.query || ''}`).join('\n');
    _shareToMain('forum', `${_getForumName()}搜索记录`, content);
  }

  async function _deleteForumSearch(index) {
    const pd = await _getPhoneData();
    const list = pd?.forumSearchHistory || [];
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    await _savePhoneData();
    _renderForum(pd);
  }

  function _renderForumPosts(posts) {
    return posts.map((p, i) => `
      <div onclick="Phone._forumViewDetail(${i})" style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          ${_forumAvatar(p, 24)}
          <span style="font-size:11px;font-weight:600">${Utils.escapeHtml(p.username || '匿名')}</span>
          <span style="font-size:10px;color:var(--text-secondary);margin-left:auto">${Utils.escapeHtml(_formatPhoneTime(p.time || ''))}</span>
        </div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">${Utils.escapeHtml(p.title || '')}</div>
        <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${Utils.escapeHtml(p.summary || '')}</div>
        ${(p.tags && p.tags.length) ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">${p.tags.map(t => `<span style="font-size:9px;padding:1px 6px;background:var(--bg-secondary);color:var(--accent);border-radius:8px">${Utils.escapeHtml(t)}</span>`).join('')}</div>` : ''}
        <div style="display:flex;justify-content:space-between;gap:8px;margin-top:8px;font-size:10px;color:var(--text-secondary);align-items:center">
          <div style="display:flex;gap:12px;align-items:center;min-width:0">
            <span style="display:flex;align-items:center;gap:3px"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>${p.views || 0}</span>
            <span style="display:flex;align-items:center;gap:3px"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${p.likes || 0}</span>
            <span style="display:flex;align-items:center;gap:3px"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${p.comments || 0}</span>
          </div>
          <button type="button" onclick="event.stopPropagation();Phone._shareForumPost(${i},'card')" class="phone-forum-preview-action-btn" title="分享">${_uiIcon('share', 12)} 分享</button>
        </div>
      </div>
    `).join('');
  }

  // ===== 发帖功能 =====
  // 头像渲染：有图片URL用图片，否则字母色块
  function _forumAvatar(p, size) {
    const sz = size || 24;
    const fontSz = Math.round(sz * 0.42);
    if (p && p.avatar) {
      return `<div style="width:${sz}px;height:${sz}px;border-radius:50%;overflow:hidden;flex-shrink:0"><img src="${Utils.escapeHtml(p.avatar)}" style="width:100%;height:100%;object-fit:cover"></div>`;
    }
    const color = (p && p.avatar_color) || '#888';
    const ch = Utils.escapeHtml(((p && p.username) || '?')[0]);
    return `<div style="width:${sz}px;height:${sz}px;border-radius:50%;background:${Utils.escapeHtml(color)};display:flex;align-items:center;justify-content:center;font-size:${fontSz}px;color:#fff;font-weight:bold;flex-shrink:0">${ch}</div>`;
  }

  // 获取当前面具信息（名字+头像），论坛/社交媒体优先网名
  async function _getMaskInfo() {
    let username = '我';
    let avatar = '';
    try {
      const mask = (typeof Character !== 'undefined' && Character.get) ? await Character.get() : null;
      username = (mask?.onlineName || '').trim() || mask?.name || '我';
      avatar = (typeof Character !== 'undefined' && Character.getAvatar ? Character.getAvatar() : '') || mask?.avatar || '';
    } catch(_) {}
    return { username, avatar };
  }

  function _renderMyForumPosts(posts) {
    if (!posts || posts.length === 0) {
      return '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">还没有发过帖子</p>';
    }
    return posts.map((p, i) => `
      <div onclick="Phone._viewMyForumPost(${i})" style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          ${_forumAvatar(p, 24)}
          <span style="font-size:11px;font-weight:600">${Utils.escapeHtml(p.username || '匿名')}</span>
          <span style="font-size:10px;color:var(--text-secondary);margin-left:auto">${Utils.escapeHtml(_formatPhoneTime(p.time || p.createdAt || ''))}</span>
        </div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">${Utils.escapeHtml(p.title || '无标题')}</div>
        <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${Utils.escapeHtml(p.content ? p.content.substring(0, 80) : '')}</div>
        ${(p.tags && p.tags.length) ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">${p.tags.map(t => `<span style="font-size:9px;padding:1px 6px;background:var(--bg-secondary);color:var(--accent);border-radius:8px">${Utils.escapeHtml(t)}</span>`).join('')}</div>` : ''}
      </div>
    `).join('');
  }

  async function _addForumPost() {
    const pd = await _getPhoneData();
    if (!pd) return;
    const { username, avatar } = await _getMaskInfo();
    let gameTime = '';
    try {
      const sb = Conversations.getStatusBar();
      gameTime = sb?.time || sb?.date || '';
    } catch(_) {}

    const post = {
      id: 'post_' + Utils.uuid().slice(0, 8),
      username,
      avatar,
      avatar_color: '#888',
      time: gameTime,
      title: '',
      content: '',
      tags: [],
      createdAt: new Date().toISOString()
    };
    pd.myForumPosts = pd.myForumPosts || [];
    pd.myForumPosts.unshift(post);
    await _savePhoneData();
    _editForumPost(0);
  }

  async function _editForumPost(index) {
    const pd = await _getPhoneData();
    if (!pd || !pd.myForumPosts || !pd.myForumPosts[index]) return;
    const p = pd.myForumPosts[index];
    // 刷新面具头像/名字（面具可能已切换）
    if (!p.title && !p.content) {
      const info = await _getMaskInfo();
      p.username = info.username;
      p.avatar = info.avatar;
    }
    _pushNav(() => _editForumPost(index));
    const body = document.getElementById('phone-body');
    document.getElementById('phone-title').textContent = p.title ? '编辑帖子' : '发帖';
    body.innerHTML = `
      <div style="padding:12px;display:flex;flex-direction:column;gap:8px;height:100%">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
          ${_forumAvatar(p, 30)}
          <span style="font-size:13px;font-weight:600;color:var(--text)">${Utils.escapeHtml(p.username || '我')}</span>
        </div>
        <input id="phone-forum-post-title" value="${Utils.escapeHtml(p.title || '')}" placeholder="标题" style="border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg-tertiary);color:var(--text);font-size:14px;font-weight:600">
        <input id="phone-forum-post-time" value="${Utils.escapeHtml(p.time || '')}" placeholder="时间" style="border:1px solid var(--border);border-radius:6px;padding:6px 8px;background:var(--bg-tertiary);color:var(--text);font-size:12px">
        <textarea id="phone-forum-post-content" placeholder="写点什么…" style="flex:1;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg-tertiary);color:var(--text);font-size:13px;resize:none;min-height:150px">${Utils.escapeHtml(p.content || '')}</textarea>
        <input id="phone-forum-post-tags" value="${Utils.escapeHtml((p.tags || []).join('、'))}" placeholder="标签（用顿号分隔）" style="border:1px solid var(--border);border-radius:6px;padding:6px 8px;background:var(--bg-tertiary);color:var(--text);font-size:12px">
        <div style="display:flex;gap:8px;margin-top:4px">
          <button onclick="Phone._saveForumPost(${index})" style="flex:1;background:var(--accent);color:#111;border:none;border-radius:6px;padding:8px 0;font-size:13px;cursor:pointer;font-weight:600">发布</button>
          <button onclick="Phone._deleteForumPost(${index})" style="background:none;border:1px solid var(--error);color:var(--error);border-radius:6px;padding:8px 12px;font-size:12px;cursor:pointer">删除</button>
        </div>
      </div>
    `;
  }

  async function _saveForumPost(index) {
    const pd = await _getPhoneData();
    if (!pd || !pd.myForumPosts || !pd.myForumPosts[index]) return;
    const title = document.getElementById('phone-forum-post-title')?.value.trim() || '';
    const content = document.getElementById('phone-forum-post-content')?.value.trim() || '';
    const time = document.getElementById('phone-forum-post-time')?.value.trim() || '';
    const tagsStr = document.getElementById('phone-forum-post-tags')?.value.trim() || '';
    const tags = tagsStr ? tagsStr.split(/[、,，]/).map(t => t.trim()).filter(Boolean) : [];

    if (!title && !content) {
      pd.myForumPosts.splice(index, 1);
      await _savePhoneData();
      UI.showToast('空帖子已自动删除', 1000);
      _forumTab = 'myposts';
      goBack();
      return;
    }

    const post = pd.myForumPosts[index];
    const isNew = !post.title && !post.content;
    post.title = title;
    post.content = content;
    post.time = time;
    post.tags = tags;
    // 让 summary 去掉 Markdown 的空行和换行符，并限制长度
    post.summary = content.replace(/\n/g, ' ').replace(/\s+/g, ' ').substring(0, 80);
    await _savePhoneData();

    const snippet = content.length > 30 ? content.substring(0, 30) + '…' : content;
    if (isNew) {
      _log(`在${_getForumName()}发布了帖子：「${title || '无标题'}」，内容摘要：${snippet || '（空）'}`);
    } else {
      _log(`更新了${_getForumName()}帖子：「${title || '无标题'}」`);
    }
    UI.showToast('已发布', 1000);
    _forumTab = 'myposts';
    // 返回上一页（详情页/列表），保持导航栈一致
    goBack();
  }

  async function _deleteForumPost(index) {
    const pd = await _getPhoneData();
    if (!pd || !pd.myForumPosts || !pd.myForumPosts[index]) return;
    if (!await UI.showConfirm('删除帖子', '确定删除这条帖子？')) return;
    pd.myForumPosts.splice(index, 1);
    _log('删除了一条帖子');
    await _savePhoneData();
    _forumTab = 'myposts';
    // 帖子已删，回到论坛列表页（栈底），避免回到已失效的详情/编辑页
    _navStack = [_navStack[0]];
    _isNavBack = true;
    try { _navStack[0](); } finally { _isNavBack = false; }
  }

  async function _viewMyForumPost(index) {
    const pd = await _getPhoneData();
    if (!pd || !pd.myForumPosts || !pd.myForumPosts[index]) return;
    const p = pd.myForumPosts[index];
    _pushNav(() => _viewMyForumPost(index));
    const body = document.getElementById('phone-body');
    document.querySelector('#phone-modal .phone-shell')?.classList.add('phone-forum-detail-mode');
    document.getElementById('phone-title').textContent = p.title || '帖子详情';

    const formatNum = n => { if (!n) return '0'; if (n >= 10000) return (n/10000).toFixed(1)+'w'; if (n >= 1000) return (n/1000).toFixed(1)+'k'; return String(n); };

    let html = '<div class="phone-forum-detail-page" style="display:flex;flex-direction:column;height:100%">';
    html += '<div class="phone-forum-detail-scroll" style="flex:1;overflow-y:auto;padding:12px">';
    // 发帖人 + 右侧操作图标
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
    html += _forumAvatar(p, 28);
    html += '<div style="flex:1;min-width:0">';
    html += '<div style="font-size:13px;font-weight:600;color:var(--text)">' + Utils.escapeHtml(p.username || '匿名') + '</div>';
    html += '<div style="font-size:10px;color:var(--text-secondary)">' + Utils.escapeHtml(_formatPhoneTime(p.time || p.createdAt || '')) + '</div>';
    html += '</div>';
    // 右侧操作按钮：编辑 / 刷新 / 删除（纯 SVG 图标，无边框）
    html += '<div style="display:flex;gap:6px;margin-left:auto;flex-shrink:0">';
    html += '<span onclick="event.stopPropagation();Phone._editForumPost(' + index + ')" style="cursor:pointer;color:var(--text-secondary);display:flex;align-items:center;padding:2px" title="编辑">' + _uiIcon('pen', 15) + '</span>';
    html += '<span onclick="event.stopPropagation();Phone._refreshMyForumPost(' + index + ')" style="cursor:pointer;color:var(--text-secondary);display:flex;align-items:center;padding:2px" title="刷新评论">' + _uiIcon('refresh', 15) + '</span>';
    html += '<span onclick="event.stopPropagation();Phone._deleteForumPost(' + index + ')" style="cursor:pointer;color:var(--error);display:flex;align-items:center;padding:2px" title="删除">' + _uiIcon('trash', 15) + '</span>';
    html += '</div>';
    html += '</div>';
    // 正文（支持 Markdown 渲染，和 AI 帖子一致）
    html += '<div class="md-content phone-forum-detail-md" style="font-size:13px;line-height:1.8;color:var(--text);padding:0 0 16px 0;margin-bottom:0">' + (window.Markdown ? Markdown.render(p.content || '') : Utils.escapeHtml(p.content || '')) + '</div>';
    // 标签
    if (p.tags?.length) {
      html += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px">' + p.tags.map(t => '<span style="font-size:10px;background:var(--bg-tertiary);color:var(--accent);padding:2px 8px;border-radius:10px">' + Utils.escapeHtml(t) + '</span>').join('') + '</div>';
    }
    // 浏览/点赞/评论数
    html += '<div style="display:flex;gap:12px;font-size:11px;color:var(--text-secondary);padding:8px 0;border-top:1px solid var(--border);margin-bottom:12px">';
    html += '<span style="display:flex;align-items:center;gap:3px"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> ' + formatNum(p.views || 0) + '</span>';
    html += '<span style="display:flex;align-items:center;gap:3px"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> ' + formatNum(p.likes || 0) + '</span>';
    html += '<span style="display:flex;align-items:center;gap:3px"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> ' + formatNum(p._comments?.length || 0) + '</span>';
    html += '</div>';
    // 评论区（预留）
    if (p._comments?.length) {
      html += '<div style="font-size:12px;font-weight:600;margin-bottom:8px">评论区</div>';
      p._comments.forEach(c => {
        html += '<div style="display:flex;gap:8px;margin-bottom:12px;padding-bottom:12px">';
        html += _forumAvatar(c, 24);
        html += '<div style="flex:1">';
        html += '<div style="display:flex;justify-content:space-between;margin-bottom:3px">';
        html += '<span style="font-size:12px;font-weight:600">' + Utils.escapeHtml(c.username || '匿名') + '</span>';
        html += '<span style="font-size:10px;color:var(--text-secondary)">' + Utils.escapeHtml(_formatPhoneTime(c.time || '')) + '</span>';
        html += '</div>';
        html += '<div class="md-content" style="font-size:12px;line-height:1.6">' + (window.Markdown ? Markdown.render(c.content || '') : Utils.escapeHtml(c.content || '')) + '</div>';
        html += '</div></div>';
      });
    }
    // 关闭滚动区
    html += '</div>';
    // 底栏：评论框包含发送按钮 + 操作图标组
    html += '<div class="phone-forum-detail-actions" style="display:flex;align-items:center;gap:6px;padding:8px;border-top:1px solid var(--border);flex-shrink:0;background:var(--bg-secondary);box-sizing:border-box;width:100%">';
    html += '<div style="flex:1;min-width:0;display:flex;align-items:center;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:20px;padding:2px 4px 2px 12px">';
    html += '<input id="phone-myforum-comment-input" placeholder="写评论…" style="flex:1;border:none;background:transparent;color:var(--text);font-size:13px;outline:none;min-width:0">';
    html += '<button onclick="Phone._sendMyForumComment(' + index + ')" style="background:var(--accent);color:#111;border:none;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>';
    html += '</button>';
    html += '</div>';
    html += '<div style="display:flex;gap:2px;flex-shrink:0;min-width:max-content;color:var(--text-secondary)">';
    html += '<span onclick="Phone._likeMyForumPost(' + index + ')" id="phone-myforum-like-btn" style="cursor:pointer;display:flex;align-items:center;padding:2px">' + _uiIcon('heart', 18) + '</span>';
    html += '<span onclick="Phone._collectMyForumPost(' + index + ')" id="phone-myforum-collect-btn" style="cursor:pointer;display:flex;align-items:center;padding:4px">' + _uiIcon('star', 18) + '</span>';
    html += '<span onclick="Phone._shareMyForumPost(' + index + ')" style="cursor:pointer;display:flex;align-items:center;padding:4px">' + _uiIcon('share', 18) + '</span>';
    html += '</div>';
    html += '</div>';
    // 外层 flex 容器关闭
    html += '</div>';
    body.innerHTML = html;
  }

  async function _likeMyForumPost(index) {
    const pd = await _getPhoneData();
    if (!pd || !pd.myForumPosts || !pd.myForumPosts[index]) return;
    pd.myForumPosts[index].likes = (pd.myForumPosts[index].likes || 0) + 1;
    await _savePhoneData();
    const btn = document.getElementById('phone-myforum-like-btn');
    if (btn) { btn.classList.add('active-like'); btn.querySelector('svg')?.setAttribute('fill', 'currentColor'); }
    const num = document.getElementById('phone-myforum-like-num');
    if (num) num.textContent = pd.myForumPosts[index].likes;
  }

  async function _shareMyForumPost(index) {
    const pd = await _getPhoneData();
    if (!pd || !pd.myForumPosts || !pd.myForumPosts[index]) return;
    const p = pd.myForumPosts[index];
    let content = '标题：' + (p.title || '') + '\n作者：' + (p.username || '匿名') + '\n\n' + (p.content || '');
    if (p.tags?.length) content += '\n标签：' + p.tags.join('、');

    const choice = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.45)';
      overlay.innerHTML = `
        <div style="width:100%;max-width:420px;background:var(--bg);border-radius:20px 20px 0 0;padding:20px 20px 32px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <span style="font-size:16px;font-weight:600;color:var(--text)">分享</span>
            <button id="share-myforum-cancel" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;line-height:1">×</button>
          </div>
          <button id="share-myforum-main" style="width:100%;padding:14px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;margin-bottom:10px;display:flex;align-items:center;gap:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>
            分享到主线
          </button>
          <button id="share-myforum-chat" style="width:100%;padding:14px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            分享到聊天
          </button>
        </div>
      `;
      const close = val => { document.body.removeChild(overlay); resolve(val); };
      overlay.querySelector('#share-myforum-cancel').onclick = () => close(null);
      overlay.querySelector('#share-myforum-main').onclick = () => close('main');
      overlay.querySelector('#share-myforum-chat').onclick = () => close('chat');
      overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
      document.body.appendChild(overlay);
    });

    if (choice === 'main') {
      _shareToMain('forum', (_getForumName() || '论坛') + '帖子', content);
    } else if (choice === 'chat') {
      await _forumShareToChat({
        title: p.title || '',
        summary: p.content ? p.content.substring(0, 80) : '',
        username: p.username || '匿名'
      }, 'detail');
    }
  }

  async function _sendMyForumComment(index) {
    const input = document.getElementById('phone-myforum-comment-input');
    const content = input?.value.trim();
    if (!content) { UI.showToast('评论内容不能为空', 1000); return; }

    const pd = await _getPhoneData();
    if (!pd || !pd.myForumPosts || !pd.myForumPosts[index]) return;
    const post = pd.myForumPosts[index];

    let username = '我';
    let avatar = '';
    try {
      const mask = (typeof Character !== 'undefined' && Character.get) ? await Character.get() : null;
      username = (mask?.onlineName || '').trim() || mask?.name || '我';
      avatar = (typeof Character !== 'undefined' && Character.getAvatar ? Character.getAvatar() : '') || mask?.avatar || '';
    } catch(_) {}

    const comment = {
      username,
      avatar,
      isNpc: false,
      content,
      time: _formatPhoneTime(Conversations.getStatusBar()?.time || new Date().toISOString()),
      likes: 0
    };
    
    post._comments = post._comments || [];
    post._comments.push(comment);
    await _savePhoneData();
    _log(`在${_getForumName() || '论坛'}评论了帖子「${post.title || '无标题'}」：${content}`);
    
    input.value = '';
    UI.showToast('评论已发送', 1000);
    
    // 刷新当前详情页
    _navStack.pop();
    _viewMyForumPost(index);
  }

  async function _sendForumComment(index) {
    const input = document.getElementById('phone-forum-comment-input');
    const content = input?.value.trim();
    if (!content) { UI.showToast('评论内容不能为空', 1000); return; }

    const pd = await _getPhoneData();
    let posts = [];
    if (pd && pd.cachedForumPosts) posts = pd.cachedForumPosts;
    if (posts.length === 0) posts = (window.WorldVoice && WorldVoice.getPosts()) || [];
    const post = posts[index];
    if (!post) return;

    let username = '我';
    let avatar = '';
    try {
      const mask = (typeof Character !== 'undefined' && Character.get) ? await Character.get() : null;
      username = (mask?.onlineName || '').trim() || mask?.name || '我';
      avatar = (typeof Character !== 'undefined' && Character.getAvatar ? Character.getAvatar() : '') || mask?.avatar || '';
    } catch(_) {}

    const comment = {
      username,
      avatar,
      isNpc: false,
      content,
      time: _formatPhoneTime(Conversations.getStatusBar()?.time || new Date().toISOString()),
      likes: 0
    };

    post._comments = post._comments || [];
    post._comments.push(comment);
    _log(`在${_getForumName() || '论坛'}评论了帖子「${post.title || '无标题'}」：${content}`);
    
    // 如果是 cachedForumPosts，需要保存回 phoneData
    if (pd && pd.cachedForumPosts && pd.cachedForumPosts[index] === post) {
      await _savePhoneData();
    }
    
    input.value = '';
    UI.showToast('评论已发送', 1000);
    
    // 刷新当前详情页
    _navStack.pop();
    _forumViewDetail(index);
  }

  async function _refreshMyForumPost(index) {
    if (window._myForumRefreshing) { UI.showToast('正在生成评论中…', 1000); return; }
    const pd = await _getPhoneData();
    if (!pd || !pd.myForumPosts || !pd.myForumPosts[index]) return;
    const post = pd.myForumPosts[index];

    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) { UI.showToast('请先配置功能模型'); return; }

    window._myForumRefreshing = true;
    _setFabGenerating(true);
    try {
      const wvPrompt = await _buildFullContext();
      const mt = _getForumName() || '论坛';
      const md = _getForumDesc();

      const sysPrompt = `你是一个"${mt}"评论/回复区生成器。用户给你一条由玩家角色发布的帖子/动态，以及当前已经存在的评论列表。请根据世界观、帖子内容、已有评论，生成一批新的追加评论。

${md ? `载体说明：${md}\n\n` : ''}要求：
1. 只生成评论/回复区，不要改写帖子正文，不要生成新的帖子标题。
2. 本次生成 8-12 条“新增评论”，用于追加到已有评论后面。
3. 大部分评论者应是符合世界观和"${mt}"氛围的普通路人用户；可以有少量 NPC 参与回复（0-3条）。
4. 如果评论者是 NPC，username 直接填该 NPC 在世界观资料中列出的名字（不要加括号或注释），并标记 "isNpc": true；不确定是否为 NPC 则作为路人处理并标记 "isNpc": false。如果楼主出现在评论区，必须是以作者身份回复读者，而不是路人视角。
5. 评论内容要自然多样：有赞同、反对、追问、吐槽、跑题、阴阳怪气等，长度错落有致。可以加入适量的“@某人”或引用前排回复的互动感，体现出网友间的楼中楼交流（例如“@XX 确实”或“回复 @XX：不对吧”），但不要每条都@。
6. 新评论应当参考已有评论，避免重复已有内容；可以接续已有讨论，也可以产生新分歧。
7. 评论时间必须依次晚于该帖子的发帖时间和已有的最新评论。请根据“当前游戏时间”智能安排回复节奏：
   - 若当前时间距离发帖/上一条评论很近，允许将新评论时间自然向后顺延（可合理超过当前游戏时间几分钟到几十分钟），模拟网友陆陆续续打字回复的过程。
   - 若当前时间比发帖/上一条评论晚了几个小时或几天，请将新评论散布在这段过去的空窗期内，并让最新几条紧贴当前游戏时间。
   - 严禁跳跃到不合逻辑的遥远未来。
8. 所有 time 都必须使用 "YYYY.MM.DD 星期X HH:mm" 格式，不要写成别的时间样式。
9. 不要让玩家角色（${post.username}）以评论者身份出现；不要冒充玩家说“我又补充一下”“楼主本人来了”等。
10. 返回纯 JSON 对象，不要包含任何解释、Markdown 代码块或多余文字。

JSON格式：
{
  "comments": [
    {
      "username": "评论者用户名或NPC姓名",
      "isNpc": false,
      "avatar_color": "#颜色",
      "content": "评论内容",
      "time": "YYYY.MM.DD 星期X HH:mm",
      "likes": 12
    }
  ]
}

${wvPrompt}`;

      let existingCommentsStr = '暂无';
      if (post._comments && post._comments.length > 0) {
        existingCommentsStr = post._comments.map(c => `用户名：${c.username} (${c.isNpc ? 'NPC' : '路人'})\n时间：${c.time}\n点赞：${c.likes}\n内容：${c.content}`).join('\n\n');
      }
      const gameTime = _getGameTime() || '';
      const userPrompt = `${gameTime ? `## 当前游戏时间\n${gameTime}\n\n` : ''}## 玩家发帖信息\n标题：${post.title || '无标题'}\n发帖人：${post.username || '匿名'}\n发帖时间：${post.time || '未知'}\n标签：${(post.tags || []).join('、')}\n\n## 帖子完整内容\n${post.content || '无正文'}\n\n## 已有评论\n${existingCommentsStr}\n\n请生成 8-12 条新的追加评论，只返回 JSON。注意：如果楼主（发帖人）出现在评论区，必须是以作者身份回复读者，而不是以路人视角评论自己的帖子。`;

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, stream: false, temperature: 0.85, max_tokens: 4000, messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }] })
      });
      if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
      const json = await resp.json();
      const content = json.choices?.[0]?.message?.content || '';
      let result = null;
      try {
        // 尝试剥离 Markdown 的 ```json 包裹
        let clean = content.replace(/^s*```(json)?s*/i, '').replace(/```s*$/i, '').trim();
        const match = clean.match(/{[\s\S]*}/);
        if (match) clean = match[0];
        result = JSON.parse(clean);
      } catch(e) {
        console.error('JSON parse fail:', content);
        throw new Error('解析AI数据失败');
      }

      if (result.comments && result.comments.length > 0) {
        post._comments = post._comments || [];
        // 匹配 NPC 头像
        const pdNow = await _getPhoneData();
        // 匹配 NPC 头像 + 显示名：单独走一遍全量提取（防止没进过朋友圈就没有缓存）
        let npcAvatarMap = {};
        let npcDisplayNameMap = {}; // NPC本名 → 优先显示名（网名 > 本名）
        if (_momentsRenderCache) {
          npcAvatarMap = _momentsRenderCache.npcAvatarMap || {};
        } else {
          // 临时构建一次映射
          try {
            const avatarRows = await DB.getAll('npcAvatars');
            const avatarById = {};
            avatarRows.forEach(a => { if (a && a.id) avatarById[a.id] = a.avatar || ''; });
            const all = await DB.getAll('worldviews');
            const addNpc = (n) => {
              if (!n) return;
              const url = avatarById[n.id] || n.avatar || '';
              const names = [n.name, ...(String(n.aliases || '').split(/[,，、\s]+/)), ...(String(n.onlineName || '').split(/[,，、\s]+/))].map(x => String(x || '').trim()).filter(Boolean);
              if (url) names.forEach(name => { if (!npcAvatarMap[name]) npcAvatarMap[name] = url; });
              // 显示名优先级：网名 > 本名
              if (n.name) {
                const displayName = (n.onlineName || '').trim() || n.name;
                npcDisplayNameMap[n.name] = displayName;
                // 别称也映射到同一个显示名
                String(n.aliases || '').split(/[,，、\s]+/).map(x => x.trim()).filter(Boolean).forEach(a => { if (!npcDisplayNameMap[a]) npcDisplayNameMap[a] = displayName; });
              }
            };
            all.forEach(wv => {
              (wv.globalNpcs || []).forEach(addNpc);
              (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(addNpc)));
            });
          } catch(_) {}
        }
        result.comments.forEach(c => {
          if (c.isNpc) {
            if (npcAvatarMap[c.username]) c.avatar = npcAvatarMap[c.username];
            if (npcDisplayNameMap[c.username]) c.username = npcDisplayNameMap[c.username];
          }
        });
        post._comments.push(...result.comments);
        await _savePhoneData();
        _log(`刷新了${mt}帖子「${post.title}」的评论，追加了 ${result.comments.length} 条`);
        UI.showToast('评论已刷新', 1000);
        // 如果还在当前详情页，触发重渲染
        const titleEl = document.getElementById('phone-title');
        if (titleEl && titleEl.textContent === (post.title || '帖子详情')) {
          _navStack.pop(); // 弹出当前旧的详情渲染
          _viewMyForumPost(index); // 重新压入并执行
        }
      } else {
        UI.showToast('没有生成新评论', 1000);
      }
    } catch (e) {
      console.error(e);
      window.__lastForumErr = e.message + "\n" + e.stack;
      UI.showToast('刷新评论失败: ' + e.message, 2000);
    } finally {
      window._myForumRefreshing = false;
      _setFabGenerating(false);
    }
  }
  async function _collectMyForumPost(index) {
    const pd = await _getPhoneData();
    if (!pd || !pd.myForumPosts || !pd.myForumPosts[index]) return;
    const p = pd.myForumPosts[index];
    let content = `标题：${p.title || ''}\n作者：${p.username || '匿名'}\n\n${p.content || ''}`;
    if (p.tags?.length) content += `\n标签：${p.tags.join('、')}`;
    await _addPhoneCollection('forum', p.title || '我的帖子', content);
  }

  async function _refreshForumComment(index) {
    if (window._myForumRefreshing) { UI.showToast('正在生成评论中…', 1000); return; }
    const pd = await _getPhoneData();
    let posts = [];
    if (pd && pd.cachedForumPosts) posts = pd.cachedForumPosts;
    if (posts.length === 0) posts = (window.WorldVoice && WorldVoice.getPosts()) || [];
    const post = posts[index];
    if (!post) return;

    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) { UI.showToast('请先配置功能模型'); return; }

    window._myForumRefreshing = true;
    _setFabGenerating(true);
    try {
      const wvPrompt = await _buildFullContext();
      const mt = _getForumName() || '论坛';
      const md = _getForumDesc();

      const sysPrompt = `你是一个"${mt}"评论/回复区生成器。用户给你一条由玩家角色发布的帖子/动态，以及当前已经存在的评论列表。请根据世界观、帖子内容、已有评论，生成一批新的追加评论。

${md ? `载体说明：${md}\n\n` : ''}要求：
1. 只生成评论/回复区，不要改写帖子正文，不要生成新的帖子标题。
2. 本次生成 8-12 条“新增评论”，用于追加到已有评论后面。
3. 大部分评论者应是符合世界观和"${mt}"氛围的普通路人用户；可以有少量 NPC 参与回复（0-3条）。
4. 如果评论者是 NPC，username 直接填该 NPC 在世界观资料中列出的名字（不要加括号或注释），并标记 "isNpc": true；不确定是否为 NPC 则作为路人处理并标记 "isNpc": false。如果楼主出现在评论区，必须是以作者身份回复读者，而不是路人视角。
5. 评论内容要自然多样：可以有赞同、反对、追问、吐槽、跑题、补充信息、阴阳怪气、认真分析等；长度不要整齐划一，有人一句话，有人写一小段。
6. 新评论应当参考已有评论，避免重复已有内容；可以接续已有讨论，也可以产生新分歧。
7. 评论时间必须依次晚于该帖子的发帖时间和已有的最新评论。请根据“当前游戏时间”智能安排回复节奏：
   - 若当前时间距离发帖/上一条评论很近，允许将新评论时间自然向后顺延（可合理超过当前游戏时间几分钟到几十分钟），模拟网友陆陆续续打字回复的过程。
   - 若当前时间比发帖/上一条评论晚了几个小时或几天，请将新评论散布在这段过去的空窗期内，并让最新几条紧贴当前游戏时间。
   - 严禁跳跃到不合逻辑的遥远未来。
8. 所有 time 都必须使用 "YYYY.MM.DD 星期X HH:mm" 格式，不要写成别的时间样式。
9. 返回纯 JSON 对象，不要包含任何解释、Markdown 代码块或多余文字。

JSON格式：
{
  "comments": [
    {
      "username": "评论者用户名或NPC姓名",
      "isNpc": false,
      "avatar_color": "#颜色",
      "content": "评论内容",
      "time": "YYYY.MM.DD 星期X HH:mm",
      "likes": 12
    }
  ]
}

${wvPrompt}`;

      let existingCommentsStr = '暂无';
      if (post._comments && post._comments.length > 0) {
        existingCommentsStr = post._comments.map(c => `用户名：${c.username} (${c.isNpc ? 'NPC' : '路人'})\n时间：${c.time}\n点赞：${c.likes}\n内容：${c.content}`).join('\n\n');
      }
      const gameTime = _getGameTime() || '';
      const userPrompt = `${gameTime ? `## 当前游戏时间\n${gameTime}\n\n` : ''}## 玩家发帖信息\n标题：${post.title || '无标题'}\n发帖人：${post.username || '匿名'}\n发帖时间：${post.time || '未知'}\n标签：${(post.tags || []).join('、')}\n\n## 帖子完整内容\n${post.fullContent || post.content || '无正文'}\n\n## 已有评论\n${existingCommentsStr}\n\n请生成 8-12 条新的追加评论，只返回 JSON。注意：如果楼主（发帖人）出现在评论区，必须是以作者身份回复读者，而不是以路人视角评论自己的帖子。`;

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, stream: false, temperature: 0.85, max_tokens: 4000, messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }] })
      });
      if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
      const json = await resp.json();
      const content = json.choices?.[0]?.message?.content || '';
      let result = null;
      try {
        // 尝试剥离 Markdown 的 ```json 包裹
        let clean = content.replace(/^s*```(json)?s*/i, '').replace(/```s*$/i, '').trim();
        const match = clean.match(/{[\s\S]*}/);
        if (match) clean = match[0];
        result = JSON.parse(clean);
      } catch(e) {
        console.error('JSON parse fail:', content);
        throw new Error('解析AI数据失败');
      }

      if (result.comments && result.comments.length > 0) {
        post._comments = post._comments || [];
        let npcAvatarMap = {};
        let npcDisplayNameMap = {};
        if (_momentsRenderCache) {
          npcAvatarMap = _momentsRenderCache.npcAvatarMap || {};
        } else {
          try {
            const avatarRows = await DB.getAll('npcAvatars');
            const avatarById = {};
            avatarRows.forEach(a => { if (a && a.id) avatarById[a.id] = a.avatar || ''; });
            const all = await DB.getAll('worldviews');
            const addNpc = (n) => {
              if (!n) return;
              const u = avatarById[n.id] || n.avatar || '';
              const names = [n.name, ...(String(n.aliases || '').split(/[,，、\s]+/)), ...(String(n.onlineName || '').split(/[,，、\s]+/))].map(x => String(x || '').trim()).filter(Boolean);
              if (u) names.forEach(name => { if (!npcAvatarMap[name]) npcAvatarMap[name] = u; });
              // 显示名优先级：网名 > 本名
              if (n.name) {
                const displayName = (n.onlineName || '').trim() || n.name;
                npcDisplayNameMap[n.name] = displayName;
                String(n.aliases || '').split(/[,，、\s]+/).map(x => x.trim()).filter(Boolean).forEach(a => { if (!npcDisplayNameMap[a]) npcDisplayNameMap[a] = displayName; });
              }
            };
            all.forEach(wv => {
              (wv.globalNpcs || []).forEach(addNpc);
              (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(addNpc)));
            });
          } catch(_) {}
        }
        result.comments.forEach(c => {
          if (c.isNpc) {
            if (npcAvatarMap[c.username]) c.avatar = npcAvatarMap[c.username];
            if (npcDisplayNameMap[c.username]) c.username = npcDisplayNameMap[c.username];
          }
        });
        post._comments.push(...result.comments);
        // 如果是 cachedForumPosts，保存回 phoneData
        if (pd && pd.cachedForumPosts && pd.cachedForumPosts[index] === post) {
          await _savePhoneData();
        }
        _log(`刷新了${mt}帖子「${post.title}」的评论，追加了 ${result.comments.length} 条`);
        UI.showToast('评论已刷新', 1000);
        // 重渲染详情页
        const titleEl = document.getElementById('phone-title');
        if (titleEl && titleEl.textContent === (post.title || '帖子详情')) {
          _navStack.pop();
          _forumViewDetail(index);
        }
      } else {
        UI.showToast('没有生成新评论', 1000);
      }
    } catch (e) {
      console.error(e);
      window.__lastForumErr = e.message + "\n" + e.stack;
      UI.showToast('刷新评论失败: ' + e.message, 2000);
    } finally {
      window._myForumRefreshing = false;
      _setFabGenerating(false);
    }
  }

  async function _forumRefresh() {
    if (WorldVoice.isRefreshing()) { UI.showToast('正在生成中…', 1000); return; }
    const container = document.getElementById('phone-forum-posts');
    if (container) container.innerHTML = Array.from({ length: 3 }).map(() => `
      <div class="wv-skeleton-card">
        <div class="wv-skeleton-row"><div class="wv-skeleton-avatar"></div><div class="wv-skeleton-line user"></div><div class="wv-skeleton-line time"></div></div>
        <div class="wv-skeleton-line title"></div>
        <div class="wv-skeleton-line summary-1"></div>
        <div class="wv-skeleton-line summary-2"></div>
        <div class="wv-skeleton-tags"><div class="wv-skeleton-pill"></div><div class="wv-skeleton-pill"></div></div>
        <div class="wv-skeleton-meta-row"><div class="wv-skeleton-meta"></div><div class="wv-skeleton-meta"></div><div class="wv-skeleton-meta"></div></div>
      </div>`).join('');

    // 调用 WorldVoice 的 refresh，完成后重新渲染
    await WorldVoice.refresh();
    const posts = WorldVoice.getPosts() || [];
    _log(`刷新了${_getForumName()}推荐；返回摘要：${_summarizeListForLog(posts, p => `《${_clipLogText(p.title || '无标题', 24)}》${p.summary ? '：' + _clipLogText(p.summary, 36) : ''}`)}`);

    // 持久化帖子缓存（并以缓存为唯一数据源）
    try {
      const pd = await _getPhoneData();
      if (pd && posts.length > 0) {
        pd.cachedForumPosts = posts;
        await _savePhoneData();
      }
    } catch(_) {}

    if (!_isAppStillActive('forum')) {
      const fn = _getForumName();
      UI.showToast(posts.length > 0 ? `${fn}已刷新，可回${fn}查看` : `${fn}刷新失败，请重试`, 1600);
      return;
    }
    const cont = document.getElementById('phone-forum-posts');
    if (cont) cont.innerHTML = posts.length > 0 ? _renderForumPosts(posts) : '<p style="text-align:center;color:var(--text-secondary);font-size:12px">生成失败，请重试</p>';
  }

  async function _forumSearch() {
    const input = document.getElementById('phone-forum-search');
    const query = input?.value.trim();
    if (!query) { UI.showToast('请输入搜索内容', 1000); return; }

    // 记录搜索历史
    try {
      const pd = await _getPhoneData();
      if (pd) {
        pd.forumSearchHistory.push({ query, time: _getGameTime() || new Date().toISOString() });
        _log(`搜索了${_getForumName()}：${query}`);
        if (pd.forumSearchHistory.length > 20) pd.forumSearchHistory = pd.forumSearchHistory.slice(-20);
        await _savePhoneData();
      }
    } catch(_) {}

    const container = document.getElementById('phone-forum-posts');
    if (container) container.innerHTML = Array.from({ length: 3 }).map(() => `
      <div class="wv-skeleton-card">
        <div class="wv-skeleton-row"><div class="wv-skeleton-avatar"></div><div class="wv-skeleton-line user"></div><div class="wv-skeleton-line time"></div></div>
        <div class="wv-skeleton-line title"></div>
        <div class="wv-skeleton-line summary-1"></div>
        <div class="wv-skeleton-line summary-2"></div>
        <div class="wv-skeleton-tags"><div class="wv-skeleton-pill"></div><div class="wv-skeleton-pill"></div></div>
        <div class="wv-skeleton-meta-row"><div class="wv-skeleton-meta"></div><div class="wv-skeleton-meta"></div><div class="wv-skeleton-meta"></div></div>
      </div>`).join('');

    // 用手机模型配置发搜索请求
    try {
      const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
      const mainConfig = await API.getConfig();
      const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
      const key = funcConfig.apiKey || mainConfig.apiKey;
      const model = funcConfig.model || mainConfig.model;
      if (!url || !key || !model) { UI.showToast('请先配置功能模型'); return; }

      const wvPrompt = await _buildFullContext();

      const results = await _phoneJsonArrayWithRetry({
        label: `${_getForumName()}搜索`, url, key, model,
        temperature: 0.9,
        max_tokens: 5000,
        messages: [
          { role: 'system', content: `你是一个"${_getForumName()}"搜索引擎。${_getForumDesc() ? `载体说明：${_getForumDesc()}。\n\n` : ''}用户搜索了"${query}"，请根据资料生成 6~8 条与搜索内容相关的帖子/动态。

要求：
1. 内容可以有：关键词相同但实际不沾边的、虚假信息、半真半假的消息、科普、吃瓜、求助、吐槽等
2. 发帖人以虚构的普通用户为主，用户名要符合世界观和${_getForumName()}的画风。NPC 偶尔出现（0-2 条即可），不要每条都是 NPC 发的
3. 帖子风格贴合${_getForumName()}的画风，长短皆可，摘要长度不要千篇一律
4. tags 风格也要贴合${_getForumName()}（论坛/贴吧偏普通词、微博偏"#话题#"、小红书偏"#标签"），无需统一形式
5. 时间分布：80% 在当前游戏时间附近 7 天内（最近热议），可以有 20% 是置顶/热门/挖坟的更早老帖，time 可以更靠前；time 永远不要超过当前游戏时间
6. 所有 time 都必须使用"YYYY.MM.DD 星期X HH:mm"格式，必须和当前游戏时间同一套写法
7. 返回纯JSON数组，不要包含任何其他文字

JSON格式：[{"id":"s1","username":"用户名","avatar_color":"#颜色","time":"YYYY.MM.DD 星期X HH:mm","title":"标题","summary":"摘要","tags":["标签"],"views":数字,"likes":数字,"comments":数字}]

${wvPrompt}` },
          { role: 'user', content: `搜索：${query}` }
        ]
      });
      // 搜索结果也缓存进 phoneData（用搜索关键词标记）
      try {
        const pd2 = await _getPhoneData();
        if (pd2 && results.length > 0) {
          pd2.cachedForumPosts = results;
          pd2.mapLastQuery = query; // 复用字段记搜索词（论坛也记）
          await _savePhoneData();
        }
      } catch(_) {}
      _log(`搜索了${_getForumName()}：${query}；返回摘要：${_summarizeListForLog(results, p => `《${_clipLogText(p.title || '无标题', 24)}》${p.summary ? '：' + _clipLogText(p.summary, 36) : ''}`)}`);
      if (!_isAppStillActive('forum')) {
        UI.showToast(`${_getForumName()}搜索完成，可回${_getForumName()}查看`, 1600);
        return;
      }
      const cont = document.getElementById('phone-forum-posts');
      if (cont) cont.innerHTML = results.length > 0 ? _renderForumPosts(results) : '<p style="text-align:center;color:var(--text-secondary);font-size:12px">没有找到相关内容</p>';
    } catch(e) {
      if (_isAppStillActive('forum')) {
        const cont = document.getElementById('phone-forum-posts');
        if (cont) cont.innerHTML = `<p style="text-align:center;color:var(--text-secondary);font-size:12px">搜索失败：${e.message}</p>`;
      } else {
        UI.showToast(`${_getForumName()}搜索失败：` + e.message, 2500);
      }
    }
  }

  async function _forumViewDetail(index) {
    // 统一从 phoneData.cachedForumPosts 取，与渲染一致
    let posts = [];
    try { const pd0 = await _getPhoneData(); posts = pd0?.cachedForumPosts || []; } catch(_) {}
    if (posts.length === 0) {
      // 兜底：从 WorldVoice 内存取
      posts = (window.WorldVoice && WorldVoice.getPosts()) || [];
    }
    const post = posts[index];
    if (!post) { UI.showToast('帖子不存在', 1000); return; }
    _log(`在${_getForumName()}查看了帖子：${post.title || '无标题'}`);

    // 记录详情浏览历史（标题+摘要+正文）
    try {
      const pdv = await _getPhoneData();
      if (pdv) {
        const content = post.fullContent || post.content || post.summary || '';
        pdv.forumViewHistory.push({
          title: post.title || '',
          summary: post.summary || '',
          content: content,
          time: post.time || ''
        });
        if (pdv.forumViewHistory.length > 10) pdv.forumViewHistory = pdv.forumViewHistory.slice(-10);
        await _savePhoneData();
      }
    } catch(_) {}

    const body = document.getElementById('phone-body');
    document.querySelector('#phone-modal .phone-shell')?.classList.add('phone-forum-detail-mode');
    document.getElementById('phone-title').textContent = post.title || '帖子详情';
    // 确保头像映射就绪并匹配
    await _ensureForumNpcAvatarMap();
    await _ensureForumDisplayNameMap();
    _matchForumAvatar(post);
    (post._comments || []).forEach(c => _matchForumAvatar(c));
    // push 详情页到导航栈
    _pushNav(() => _forumViewDetail(index));

    function _renderDetailInPhone(p) {
      const formatNum = n => { if (!n) return '0'; if (n >= 10000) return (n/10000).toFixed(1)+'w'; if (n >= 1000) return (n/1000).toFixed(1)+'k'; return String(n); };
      let html = `<div class="phone-forum-detail-page" style="display:flex;flex-direction:column;height:100%">`;
 html += `<div class="phone-forum-detail-scroll" style="flex:1;overflow-y:auto;padding:12px">`;
      // 发帖人 + 刷新图标
      html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        ${_forumAvatar(p, 28)}
        <div><div style="font-size:13px;font-weight:600;color:var(--text)">${Utils.escapeHtml(p.username||'匿名')}</div><div style="font-size:10px;color:var(--text-secondary)">${Utils.escapeHtml(_formatPhoneTime(p.time||''))}</div></div>
        ${p._detailLoaded ? `<div style="margin-left:auto;flex-shrink:0"><span onclick="event.stopPropagation();Phone._refreshForumComment(${index})" style="cursor:pointer;color:var(--text-secondary);display:flex;align-items:center;padding:2px" title="刷新评论">${_uiIcon('refresh', 15)}</span></div>` : ''}
      </div>`;
      // 正文或骨架屏
      if (p._detailLoaded) {
        html += `<div class="md-content phone-forum-detail-md" style="font-size:13px;line-height:1.8;color:var(--text);padding:0 0 16px 0;margin-bottom:0">${(window.Markdown ? Markdown.render(p.fullContent||'') : Utils.escapeHtml(p.fullContent||''))}</div>`;
        if (p.tags?.length) html += `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px">${p.tags.map(t=>`<span style="font-size:10px;background:var(--bg-tertiary);color:var(--accent);padding:2px 8px;border-radius:10px">${Utils.escapeHtml(t)}</span>`).join('')}</div>`;
html += `<div style="display:flex;gap:12px;font-size:11px;color:var(--text-secondary);padding:8px 0;border-top:1px solid var(--border);margin-bottom:12px">
        <span style="display:flex;align-items:center;gap:3px"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> ${formatNum(p.views)}</span>
        <span style="display:flex;align-items:center;gap:3px"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> ${formatNum(p.likes)}</span>
        <span style="display:flex;align-items:center;gap:3px"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> ${formatNum(p._comments?.length||0)}</span>
      </div>`;
        // 评论区（在滚动区内）
        if (p._comments?.length) {
          html += `<div style="font-size:12px;font-weight:600;margin-bottom:8px">评论区</div>`;
          p._comments.forEach(c => {
            html += `<div style="display:flex;gap:8px;margin-bottom:12px;padding-bottom:12px">
              ${_forumAvatar(c, 24)}
              <div style="flex:1">
                <div style="display:flex;justify-content:space-between;margin-bottom:3px">
                  <span style="font-size:12px;font-weight:600">${Utils.escapeHtml(c.username||'匿名')}</span>
                  <span style="font-size:10px;color:var(--text-secondary)">${Utils.escapeHtml(_formatPhoneTime(c.time||''))}</span>
                </div>
                <div class="md-content" style="font-size:12px;line-height:1.6">${window.Markdown ? Markdown.render(c.content||'') : Utils.escapeHtml(c.content||'')}</div>
              </div>
            </div>`;
          });
        }
        // 关闭内容滚动区域
        html += `</div>`;
        // 底栏：评论框包含发送按钮 + 操作图标组
        html += `<div class="phone-forum-detail-actions" style="display:flex;align-items:center;gap:6px;padding:8px;border-top:1px solid var(--border);flex-shrink:0;background:var(--bg-secondary);box-sizing:border-box;width:100%">
          <div style="flex:1;min-width:0;display:flex;align-items:center;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:20px;padding:2px 4px 2px 12px">
            <input id="phone-forum-comment-input" placeholder="写评论…" style="flex:1;border:none;background:transparent;color:var(--text);font-size:13px;outline:none;min-width:0">
            <button onclick="Phone._sendForumComment(${index})" style="background:var(--accent);color:#111;border:none;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>
            </button>
          </div>
          <div style="display:flex;gap:2px;flex-shrink:0;min-width:max-content;color:var(--text-secondary)">
            <span onclick="Phone._likeForumPost(${index})" id="phone-forum-like-btn" style="cursor:pointer;display:flex;align-items:center;padding:2px">${_uiIcon('heart', 18)}</span>
            <span onclick="Phone._collectForumPost(${index})" id="phone-forum-collect-btn" style="cursor:pointer;display:flex;align-items:center;padding:4px">${_uiIcon('star', 18)}</span>
            <span onclick="Phone._shareForumPost(${index},'detail')" style="cursor:pointer;display:flex;align-items:center;padding:4px">${_uiIcon('share', 18)}</span>
          </div>
        </div>`;
        // 外层 flex 容器关闭
        html += `</div>`;
        body.innerHTML = html;
      } else {
        // 骨架屏
        html += `<div class="wv-detail-skeleton" style="margin-bottom:12px">
          <div class="wv-detail-skeleton-line title"></div>
          <div class="wv-detail-skeleton-line body-1"></div>
          <div class="wv-detail-skeleton-line body-2"></div>
          <div class="wv-detail-skeleton-line body-3"></div>
          <div class="wv-detail-skeleton-line body-4"></div>
        </div>`;
        html += `</div></div>`;
        body.innerHTML = html;
      }
    }

    _renderDetailInPhone(post);

    // 如果没有详情缓存，用静默接口加载
    if (!post._detailLoaded) {
      _setFabGenerating(true);
      try {
        await WorldVoice.loadDetailSilent(post);
        if (!_isAppStillActive('forum')) { _setFabGenerating(false); return; }
        if (post._detailLoaded) {
          // 回写到 phoneData 缓存（保留其它字段）
          try {
            const _pd = await _getPhoneData();
            if (_pd && _pd.cachedForumPosts) {
              const target = _pd.cachedForumPosts[index];
              if (target) {
                target.fullContent = post.fullContent;
                target._comments = post._comments;
                target._detailLoaded = true;
                await _savePhoneData();
              }
            }
          } catch(_) {}
          // 加载完后对新评论匹配NPC头像
          _matchForumAvatar(post);
          (post._comments || []).forEach(c => _matchForumAvatar(c));
          if (_isAppStillActive('forum')) _renderDetailInPhone(post);
        } else {
          if (_isAppStillActive('forum')) body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--danger);font-size:12px">加载失败，请重试</div>`;
        }
      } catch(e) {
        console.error('[loadDetailSilent]', e);
        if (_isAppStillActive('forum')) body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--danger);font-size:12px">加载失败：${Utils.escapeHtml(e.message)}</div>`;
      } finally {
        _setFabGenerating(false);
      }
    }
  }
async function _likeForumPost(index) {
    const pd = await _getPhoneData();
    if (!pd) return;
    const post = pd.cachedForumPosts?.[index];
    if (!post) return;
    post.likes = (post.likes || 0) + 1;
    await _savePhoneData();
    const numEl = document.getElementById('phone-forum-like-num');
    if (numEl) numEl.textContent = post.likes > 9999 ? (post.likes/10000).toFixed(1)+'w' : (post.likes > 999 ? (post.likes/1000).toFixed(1)+'k' : String(post.likes));
    const btn = document.getElementById('phone-forum-like-btn');
    if (btn) {
      btn.classList.add('active-like');
      btn.querySelector('svg')?.setAttribute('fill', 'currentColor');
    }
  }

  async function _shareForumPost(index, mode) {
    const pd = await _getPhoneData();
    let posts = pd?.cachedForumPosts || [];
    if (posts.length === 0) posts = (window.WorldVoice && WorldVoice.getPosts()) || [];
    const p = posts[index];
    if (!p) { UI.showToast('帖子不存在', 1000); return; }

    const isDetail = mode === 'detail';

    // 主线内容
    let content = `标题：${p.title || ''}\n作者：${p.username || '匿名'}\n`;
    if (isDetail && p.fullContent) {
      content += `\n${p.fullContent}`;
    } else {
      content += `摘要：${p.summary || ''}`;
    }
    if (p.tags?.length) content += `\n标签：${p.tags.join('、')}`;
    if (isDetail && p._comments?.length) {
      content += '\n\n评论区：\n' + p._comments.map(c => `${c.username || '匿名'}：${c.content || ''}`).join('\n');
    }

    // 弹出分享选项面板
    const choice = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.45)';
      overlay.innerHTML = `
        <div style="width:100%;max-width:420px;background:var(--bg);border-radius:20px 20px 0 0;padding:20px 20px 32px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <span style="font-size:16px;font-weight:600;color:var(--text)">分享</span>
            <button id="share-forum-cancel" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;line-height:1">×</button>
          </div>
          <button id="share-forum-main" style="width:100%;padding:14px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;margin-bottom:10px;display:flex;align-items:center;gap:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>
            分享到主线
          </button>
          <button id="share-forum-chat" style="width:100%;padding:14px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            分享到聊天
          </button>
        </div>
      `;
      const close = val => { document.body.removeChild(overlay); resolve(val); };
      overlay.querySelector('#share-forum-cancel').onclick = () => close(null);
      overlay.querySelector('#share-forum-main').onclick = () => close('main');
      overlay.querySelector('#share-forum-chat').onclick = () => close('chat');
      overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
      document.body.appendChild(overlay);
    });

    if (choice === 'main') {
      _shareToMain('forum', p.title || `${_getForumName()}帖子`, content);
    } else if (choice === 'chat') {
      await _forumShareToChat(p, isDetail ? 'detail' : 'card');
    }
  }

  // 论坛帖子分享到聊天
  async function _forumShareToChat(post, mode) {
    const pd = await _getPhoneData();
    const contacts = pd?.chatContacts || [];
    if (!contacts.length) { UI.showToast('还没有聊天联系人', 1500); return; }

    const contactId = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)';
      const listHtml = contacts.map(c => {
        const displayName = c.nickname || c.name || '?';
        const avaUrl = _chatContactAvatar(c);
        const avatarEl = avaUrl
          ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0">`
          : `<div style="width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;flex-shrink:0">${Utils.escapeHtml(displayName[0])}</div>`;
        const thread = (pd.chatThreads && pd.chatThreads[c.id]) || [];
        const lastMsg = thread.length ? thread[thread.length - 1] : null;
        const lastText = lastMsg
          ? (lastMsg.type === 'location' ? '[位置]' : lastMsg.type === 'voice' ? '[语音]' : lastMsg.type === 'photo' ? '[图片]' : lastMsg.type === 'product' ? '[商品链接]' : lastMsg.type === 'forum_card' ? '[帖子摘要]' : lastMsg.type === 'forum_detail' ? '[帖子详情]' : (lastMsg.text || ''))
          : '暂无消息';
        return `<div class="share-chat-pick-item" data-cid="${Utils.escapeHtml(c.id)}" style="padding:10px 12px;border-radius:10px;margin-bottom:4px;cursor:pointer;background:var(--bg-tertiary);display:flex;align-items:center;gap:10px">
          ${avatarEl}
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(displayName)}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(lastText.substring(0, 28))}</div>
          </div>
        </div>`;
      }).join('');
      overlay.innerHTML = `<div style="width:min(320px,88vw);background:var(--bg);border-radius:18px;padding:20px;max-height:70vh;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-shrink:0">
          <span style="font-size:16px;font-weight:600;color:var(--text)">分享到</span>
          <button id="share-forum-chat-cancel" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;line-height:1">×</button>
        </div>
        <div style="flex:1;overflow-y:auto">${listHtml}</div>
      </div>`;
      const close = val => { document.body.removeChild(overlay); resolve(val); };
      overlay.querySelector('#share-forum-chat-cancel').onclick = () => close(null);
      overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
      overlay.querySelectorAll('.share-chat-pick-item').forEach(el => {
        el.addEventListener('click', () => close(el.dataset.cid));
      });
      document.body.appendChild(overlay);
    });

    if (!contactId) return;

    let gameTime = '';
    try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}
    if (!pd.chatThreads) pd.chatThreads = {};
    if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
    pd.chatThreads[contactId].push({
      id: 'forum_' + Date.now(),
      role: 'me',
      type: mode === 'detail' ? 'forum_detail' : 'forum_card',
      forumTitle: post.title || '',
      forumSummary: post.summary || '',
      forumAuthor: post.username || '匿名',
      forumPlatform: _getForumName() || '论坛',
      text: mode === 'detail' ? `[帖子详情链接]${post.title || ''}` : `[帖子摘要截图]${post.title || ''}`,
      time: gameTime,
      createdAt: Date.now()
    });
    await _savePhoneData();
    const _ctName3 = (pd.chatContacts || []).find(c => c.id === contactId)?.name || contactId;
    _addChatMessageToRoundLog(contactId, 'me', `分享了帖子（${post.title || '无标题'}）`, gameTime, _ctName3);
    UI.showToast('已发送', 1200);
  }

  let _mapTab = 'search'; // 'search' | 'history' | 'searchhist'

  function _renderMap(pd) {
    const body = document.getElementById('phone-body');
    document.getElementById('phone-title').textContent = '地图';
    const history = pd.locationHistory || [];
    const mapSearches = pd.mapSearchHistory || [];

    const historyHtml = history.length > 0
? history.slice(-30).reverse().map((h, idx) => {
    const realIdx = history.length - 1 - idx;
    return `
<div class="phone-map-track-card" style="position:relative">
 <div class="phone-map-track-time">${Utils.escapeHtml(h.time || '')}</div>
 <div class="phone-map-track-location">${Utils.escapeHtml(h.location || '')}</div>
 <span onclick="event.stopPropagation();Phone._deleteLocationHistory(${realIdx})" class="phone-share-mini" style="position:absolute;top:6px;right:8px;color:var(--error)" title="删除">${_uiIcon('trash', 13)}</span>
</div>`;
  }).join('')
: '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">暂无轨迹记录</p>';

    const searchHistHtml = mapSearches.length > 0
      ? mapSearches.slice(-30).reverse().map((s, idx) => {
          const realIdx = mapSearches.length - 1 - idx;
          return `<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;display:flex;gap:8px;align-items:center">
            <span class="phone-search-history-item" style="flex:1;color:var(--text)">${_uiIcon('search', 13)} ${Utils.escapeHtml(s.query || '')}</span>
            <span style="color:var(--text-secondary);font-size:10px;white-space:nowrap">${Utils.escapeHtml(_fmtHistoryTime(s.time))}</span>
            <span onclick="Phone._shareMapSearch(${realIdx})" class="phone-share-mini" title="分享到主线">${_uiIcon('share', 13)}</span>
            <span onclick="Phone._deleteMapSearch(${realIdx})" class="phone-share-mini" style="color:var(--error)" title="删除">${_uiIcon('trash', 13)}</span>
          </div>`;
        }).join('')
      : '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">暂无搜索记录</p>';

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%">
        <div id="phone-map-search-panel" style="flex:1;overflow-y:auto;padding:12px;display:${_mapTab === 'search' ? 'block' : 'none'}">
          <div class="phone-map-searchbar">
            <div class="phone-map-search-input-wrap">
              ${_uiIcon('search', 14)}
              <input id="phone-map-search" type="text" placeholder="搜索附近（如：美食、KTV…）" value="${Utils.escapeHtml(pd.mapLastQuery || '')}">
            </div>
            <button onclick="Phone._mapSearch()" class="phone-map-search-btn">搜索</button>
          </div>
          <div id="phone-map-results">${_renderMapResultsHtml(pd.mapLastResults || [])}</div>
        </div>
<div id="phone-map-history-panel" style="flex:1;overflow-y:auto;padding:12px;display:${_mapTab === 'history' ? 'block' : 'none'}">
            <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">共 ${history.length} 条轨迹</div>
            ${historyHtml}
          </div>
          <div id="phone-map-searchhist-panel" style="flex:1;overflow-y:auto;padding:12px;display:${_mapTab === 'searchhist' ? 'block' : 'none'}">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <span style="font-size:11px;color:var(--text-secondary)">共 ${mapSearches.length} 条搜索记录</span>
              ${mapSearches.length > 0 ? `<span onclick="Phone._shareAllMapSearches()" class="phone-share-text" title="全部分享到主线">${_uiIcon('share', 13)} 全部分享</span>` : ''}
            </div>
          ${searchHistHtml}
        </div>
        <div class="phone-tabbar">
          <div class="phone-tab ${_mapTab === 'search' ? 'active' : ''}" onclick="Phone._switchMapTab('search')">搜索</div>
          <div class="phone-tab ${_mapTab === 'searchhist' ? 'active' : ''}" onclick="Phone._switchMapTab('searchhist')">搜索记录</div>
          <div class="phone-tab ${_mapTab === 'history' ? 'active' : ''}" onclick="Phone._switchMapTab('history')">轨迹</div>
        </div>
      </div>
    `;
    // 同步内存缓存，供分享用
    if (pd.mapLastResults?.length) _mapSearchResults = pd.mapLastResults;
  }

  function _normalizeMapResults(results) {
    return (Array.isArray(results) ? results : [])
      .map((r, idx) => {
        if (!r || typeof r !== 'object') return null;
        const name = r.name || r.title || r.place || r.shop || r.poi || `地点${idx + 1}`;
        const address = r.address || r.location || r.addr || r.area || '';
        const desc = r.desc || r.description || r.summary || r.intro || r.reason || '';
        const distance = r.distance || r.range || r.dist || '';
        return {
          name: String(name || '').trim(),
          address: String(address || '').trim(),
          desc: String(desc || '').trim(),
          distance: String(distance || '').trim()
        };
      })
      .filter(r => r && r.name);
  }

  function _shareMapSearch(index) {
    (async () => {
      const _pd = await _getPhoneData();
      const s = _pd?.mapSearchHistory?.[index];
      if (!s) return;
      _shareToMain('map', '地图搜索', `搜索关键词：${s.query || ''}\n时间：${s.time || ''}`);
    })();
  }

  async function _shareAllMapSearches() {
    const pd = await _getPhoneData();
    const list = pd?.mapSearchHistory || [];
    if (list.length === 0) return;
    const content = list.slice(-10).map(s => `- ${s.query || ''}`).join('\n');
    _shareToMain('map', '地图搜索记录', content);
  }

  async function _deleteMapSearch(index) {
    const pd = await _getPhoneData();
    const list = pd?.mapSearchHistory || [];
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    await _savePhoneData();
    _renderMap(pd);
  }

  async function _deleteLocationHistory(index) {
    const pd = await _getPhoneData();
    const list = pd?.locationHistory || [];
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    await _savePhoneData();
    _renderMap(pd);
  }

  function _renderMapResultsHtml(results) {
    if (!results || results.length === 0) return '';
    return results.map((r, ri) => `
      <div class="phone-map-result-card">
        <div class="phone-map-result-head">
          <div class="phone-map-result-name">${Utils.escapeHtml(r.name || '')}</div>
        </div>
        ${r.address ? `<div class="phone-map-result-address">${_uiIcon('pin', 12)}<span>${Utils.escapeHtml(r.address || '')}</span></div>` : ''}
        ${r.desc ? `<div class="phone-map-result-desc">${Utils.escapeHtml(r.desc || '')}</div>` : ''}
        <div class="phone-map-result-foot">
          <div class="phone-map-result-foot-left">
            ${r.distance ? `<span class="phone-map-distance-pill">${_uiIcon('route', 11)} ${Utils.escapeHtml(r.distance)}</span>` : ''}
          </div>
          <div class="phone-map-result-actions">
            <button type="button" onclick="Phone._collectMapResult(${ri})" class="phone-map-action-btn" title="收藏">${_uiIcon('star', 12)} 收藏</button>
            <button type="button" onclick="Phone._shareMapResult(${ri})" class="phone-map-action-btn" title="分享到主线">${_uiIcon('share', 12)} 分享</button>
          </div>
        </div>
      </div>`).join('');
  }

  async function _switchMapTab(tab) {
    _mapTab = tab;
    const pd = await _getPhoneData();
    if (pd) _renderMap(pd);
  }

  let _mapSearchResults = []; // 缓存搜索结果用于分享

  async function _shareMapResult(index) {
    const r = _mapSearchResults[index];
    if (!r) return;
    const content = `地点：${r.name || ''}\n地址：${r.address || ''}\n描述：${r.desc || ''}${r.distance ? '\n距离：' + r.distance : ''}`;

    const choice = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.45)';
      overlay.innerHTML = `
        <div style="width:100%;max-width:420px;background:var(--bg);border-radius:20px 20px 0 0;padding:20px 20px 32px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <span style="font-size:16px;font-weight:600;color:var(--text)">分享</span>
            <button id="share-map-cancel" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;line-height:1">×</button>
          </div>
          <button id="share-map-main" style="width:100%;padding:14px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;margin-bottom:10px;display:flex;align-items:center;gap:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>
            分享到主线
          </button>
          <button id="share-map-chat" style="width:100%;padding:14px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            分享到聊天
          </button>
        </div>
      `;
      const close = val => { document.body.removeChild(overlay); resolve(val); };
      overlay.querySelector('#share-map-cancel').onclick = () => close(null);
      overlay.querySelector('#share-map-main').onclick = () => close('main');
      overlay.querySelector('#share-map-chat').onclick = () => close('chat');
      overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
      document.body.appendChild(overlay);
    });

    if (choice === 'main') {
      _shareToMain('map', r.name || '地点', content);
    } else if (choice === 'chat') {
      await _mapShareToChat(r);
    }
  }

  // 地图地点分享到聊天
  async function _mapShareToChat(place) {
    const pd = await _getPhoneData();
    const contacts = pd?.chatContacts || [];
    if (!contacts.length) { UI.showToast('还没有聊天联系人', 1500); return; }

    const contactId = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)';
      const listHtml = contacts.map(c => {
        const displayName = c.nickname || c.name || '?';
        const avaUrl = _chatContactAvatar(c);
        const avatarEl = avaUrl
          ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0">`
          : `<div style="width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;flex-shrink:0">${Utils.escapeHtml(displayName[0])}</div>`;
        const thread = (pd.chatThreads && pd.chatThreads[c.id]) || [];
        const lastMsg = thread.length ? thread[thread.length - 1] : null;
        const lastText = lastMsg
          ? (lastMsg.type === 'location' ? '[位置]' : lastMsg.type === 'voice' ? '[语音]' : lastMsg.type === 'photo' ? '[图片]' : lastMsg.type === 'product' ? '[商品链接]' : lastMsg.type === 'forum_card' ? '[帖子摘要]' : lastMsg.type === 'forum_detail' ? '[帖子详情]' : lastMsg.type === 'map_place' ? '[地点链接]' : (lastMsg.text || ''))
          : '暂无消息';
        return `<div class="share-chat-pick-item" data-cid="${Utils.escapeHtml(c.id)}" style="padding:10px 12px;border-radius:10px;margin-bottom:4px;cursor:pointer;background:var(--bg-tertiary);display:flex;align-items:center;gap:10px">
          ${avatarEl}
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(displayName)}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(lastText.substring(0, 28))}</div>
          </div>
        </div>`;
      }).join('');
      overlay.innerHTML = `<div style="width:min(320px,88vw);background:var(--bg);border-radius:18px;padding:20px;max-height:70vh;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-shrink:0">
          <span style="font-size:16px;font-weight:600;color:var(--text)">分享到</span>
          <button id="share-map-chat-cancel" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;line-height:1">×</button>
        </div>
        <div style="flex:1;overflow-y:auto">${listHtml}</div>
      </div>`;
      const close = val => { document.body.removeChild(overlay); resolve(val); };
      overlay.querySelector('#share-map-chat-cancel').onclick = () => close(null);
      overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
      overlay.querySelectorAll('.share-chat-pick-item').forEach(el => {
        el.addEventListener('click', () => close(el.dataset.cid));
      });
      document.body.appendChild(overlay);
    });

    if (!contactId) return;

    let gameTime = '';
    try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}
    if (!pd.chatThreads) pd.chatThreads = {};
    if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
    pd.chatThreads[contactId].push({
      id: 'map_' + Date.now(),
      role: 'me',
      type: 'map_place',
      placeName: place.name || '',
      placeAddress: place.address || '',
      placeDesc: place.desc || '',
      text: `[地点链接]${place.name || ''}`,
      time: gameTime,
      createdAt: Date.now()
    });
    await _savePhoneData();
    const _ctNameMap = (pd.chatContacts || []).find(c => c.id === contactId)?.name || contactId;
    _addChatMessageToRoundLog(contactId, 'me', `发送了地点链接（${place.name || ''}）`, gameTime, _ctNameMap);
    UI.showToast('已发送', 1200);
  }

  async function _mapSearch() {
    const query = document.getElementById('phone-map-search')?.value.trim();
    if (!query) { UI.showToast('请输入搜索内容', 1000); return; }
    const container = document.getElementById('phone-map-results');
    if (container) container.innerHTML = Array.from({ length: 3 }).map(() => `
      <div class="wv-skeleton-card" style="padding:10px 12px">
        <div class="wv-skeleton-line title" style="width:60%;margin-bottom:6px"></div>
        <div class="wv-skeleton-line summary-1" style="width:90%;margin-bottom:4px"></div>
        <div class="wv-skeleton-line summary-2" style="width:70%"></div>
      </div>`).join('');

    try {
      const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
      const mainConfig = await API.getConfig();
      const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
      const key = funcConfig.apiKey || mainConfig.apiKey;
      const model = funcConfig.model || mainConfig.model;
      if (!url || !key || !model) {
        UI.showToast('请先配置功能模型');
        if (container) container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);font-size:12px">请先配置功能模型</p>';
        return;
      }

      const wvPrompt = await _buildFullContext();
    let currentLoc = '';
    try { const sb = Conversations.getStatusBar(); currentLoc = [sb?.region, sb?.location].filter(Boolean).join('·'); } catch(_) {}

    const rawResults = await _phoneJsonArrayWithRetry({
        label: '地图搜索', url, key, model,
        temperature: 0.75,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: `你是世界观内的地图搜索引擎。用户当前位置：${currentLoc || '未知'}。

任务：根据世界观和地点设定，生成4-6个与“${query}”相关的地点/店铺。

必须严格返回 JSON 数组，不能返回 Markdown，不能返回代码块，不能解释。返回内容必须以 [ 开头，以 ] 结尾。
每个对象只能使用以下字段：
{"name":"地点名","address":"地址","desc":"一句话描述","distance":"距离描述"}

示例：
[{"name":"示例地点","address":"示例街区","desc":"适合当前搜索的一句话描述。","distance":"约800米"}]

${wvPrompt}` },
          { role: 'user', content: `搜索附近：${query}` }
        ]
      });
      const results = _normalizeMapResults(rawResults);
      if (results.length === 0) throw new Error('AI返回了空结果，请重试');
      _mapSearchResults = results;
      _log(`地图搜索了：${query}；返回摘要：${_summarizeListForLog(results, r => `${_clipLogText(r.name || '未知地点', 24)}${r.desc ? '：' + _clipLogText(r.desc, 36) : ''}${r.distance ? '（' + _clipLogText(r.distance, 14) + '）' : ''}`)}`);
      // 持久化到 phoneData
      try {
        const pd3 = await _getPhoneData();
        if (pd3) {
          pd3.mapLastResults = results;
          pd3.mapLastQuery = query;
          if (!pd3.mapSearchHistory) pd3.mapSearchHistory = [];
          pd3.mapSearchHistory.push({ query, time: _getGameTime() || new Date().toISOString() });
          if (pd3.mapSearchHistory.length > 10) pd3.mapSearchHistory = pd3.mapSearchHistory.slice(-10);
          await _savePhoneData();
        }
      } catch(_) {}
      if (!_isAppStillActive('map')) {
        UI.showToast('地图搜索完成，可回地图查看', 1600);
        return;
      }
      const cont = document.getElementById('phone-map-results');
      if (cont) cont.innerHTML = results.length > 0 ? _renderMapResultsHtml(results) : '<p style="text-align:center;color:var(--text-secondary);font-size:12px">没有找到结果</p>';
    } catch(e) {
      console.error('[地图搜索]', e);
      if (_isAppStillActive('map')) {
        const cont = document.getElementById('phone-map-results');
        if (cont) cont.innerHTML = `<p style="text-align:center;color:var(--text-secondary);font-size:12px">搜索失败: ${Utils.escapeHtml(e.message || '未知错误')}<br><span style="font-size:11px;opacity:0.7">请重新搜索</span></p>`;
      } else {
        UI.showToast('地图搜索失败：' + e.message, 2500);
      }
    }
  }

  let _momentsTab = 'mine'; // 'mine' | 'friends'
  // 好友圈渲染缓存：避免每次切 tab 都重跑 DB.getAll('npcAvatars') + DB.getAll('worldviews')
  // 失效时机：切对话/切世界观/NPC 头像变更/世界观保存
  let _momentsRenderCache = null; // { convId, maskName, maskAvatar, npcAvatarMap }
  function _invalidateMomentsCache() { _momentsRenderCache = null; }

  function _renderMoments(pd) {
    const body = document.getElementById('phone-body');
    document.getElementById('phone-title').textContent = '好友圈';
    const myMoments = pd.moments || [];
    const npcMoments = pd.npcMoments || [];

    const convId = (typeof Conversations !== 'undefined') ? Conversations.getCurrent() : null;
    const maskId = (typeof Character !== 'undefined' && Character.getCurrentId) ? Character.getCurrentId() : null;
    const cache = (_momentsRenderCache && _momentsRenderCache.convId === convId && _momentsRenderCache.maskId === maskId) ? _momentsRenderCache : null;
    const maskName = cache?.maskName || '我';
    const maskAvatar = cache?.maskAvatar || '';
    const npcAvatarMap = cache?.npcAvatarMap || {};

    const avatarHtml = (name, avatar, cls = '') => avatar
      ? `<img src="${Utils.escapeHtml(avatar)}" class="phone-moment-avatar ${cls}" alt="头像">`
      : `<div class="phone-moment-avatar ${cls}">${Utils.escapeHtml((name || '?')[0])}</div>`;

    const commentsHtml = (comments) => (comments && comments.length)
      ? `<div class="phone-moment-comments"><div class="phone-moment-comments-title">评论区</div>${comments.map(c => `
          <div class="phone-moment-comment-card">
            <span class="phone-moment-comment-name">${Utils.escapeHtml(c.name || '?')}</span>
            <span class="phone-moment-comment-text">${Utils.escapeHtml(c.text || '')}</span>
          </div>`).join('')}</div>`
      : '';

    const visibleHtml = (visibleNpcs) => {
      const list = visibleNpcs && visibleNpcs.length ? visibleNpcs : ['所有人'];
      return `<div class="phone-moment-visible">可见范围：${list.map(x => Utils.escapeHtml(x)).join('、')}</div>`;
    };

    const myHtml = myMoments.length > 0
      ? myMoments.slice(0, 20).map((m, i) => `
        <div class="phone-moment-card" id="phone-moment-card-${i}">
          <div class="phone-moment-main mine-full">
            <div class="phone-moment-head">
              <div class="phone-moment-name">${Utils.escapeHtml(maskName)}</div>
              <div class="phone-moment-time">${Utils.escapeHtml(_formatPhoneTime(m.time || ''))}</div>
            </div>
            <div class="phone-moment-text">${Utils.escapeHtml(m.text || '')}</div>
            ${m.image ? `<div class="phone-moment-image-wrap"><img src="${m.image}" class="phone-moment-image"></div>` : ''}
            ${m.imageDesc ? `<div class="phone-moment-image-desc">${_uiIcon('image', 13)}<span>${Utils.escapeHtml(m.imageDesc)}</span></div>` : ''}
            ${visibleHtml(m.visibleNpcs)}
          </div>
          <div class="phone-moment-actions">
  <button type="button" onclick="Phone._editMyMoment(${i})" class="phone-moment-action-btn" title="编辑">${_uiIcon('pen', 13)}</button>
  ${m.image ? `<button type="button" onclick="Phone._saveMomentImageToAlbum('my', ${i})" class="phone-moment-action-btn" title="存入相册">${_uiIcon('download', 13)}</button>` : ''}
  <button type="button" onclick="Phone._collectMyMoment(${i})" class="phone-moment-action-btn" title="收藏">${_uiIcon('star', 13)}</button>
  <button type="button" onclick="Phone._shareMoment(${i})" class="phone-moment-action-btn" title="分享">${_uiIcon('share', 13)}</button>
  <button type="button" onclick="Phone._deleteMyMoment(${i})" class="phone-moment-action-btn danger" title="删除">${_uiIcon('trash', 13)}</button>
  ${!(m.comments && m.comments.length) ? `<button type="button" onclick="Phone._refreshMomentComments(${i})" class="phone-moment-action-btn" title="刷新评论">${_uiIcon('refresh', 13)}</button>` : ''}
          </div>
          ${(m.comments && m.comments.length) ? commentsHtml(m.comments) : ''}
        </div>
      `).join('')
      : '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">还没有动态，点击"发动态"发一条</p>';

    const friendsHtml = npcMoments.length > 0
      ? npcMoments.map((m, i) => `
        <div class="phone-moment-card">
          <div class="phone-moment-layout">
            ${avatarHtml(m.npc || '?', npcAvatarMap[String(m.npc || '').trim()] || '', 'npc')}
            <div class="phone-moment-main">
              <div class="phone-moment-head">
                <div class="phone-moment-name">${Utils.escapeHtml(m.npc || '')}</div>
                <div class="phone-moment-time">${Utils.escapeHtml(_formatPhoneTime(m.time || '未知时间'))}</div>
              </div>
              <div class="phone-moment-text">${Utils.escapeHtml(m.text || '')}</div>
              ${m.image ? `<div class="phone-moment-image-wrap" style="margin-top:8px;border-radius:8px;overflow:hidden;max-width:100%"><img src="${Utils.escapeHtml(m.image)}" style="width:100%;display:block;object-fit:cover;max-height:200px" loading="lazy" onerror="this.parentElement.style.display='none'"></div>` : ''}
            </div>
          </div>
          <div class="phone-moment-actions">
            <button type="button" onclick="Phone._likeNpcMoment(${i})" class="phone-moment-action-btn ${m.likedByUser ? 'active-collect' : ''}" title="${m.likedByUser ? '已赞' : '点赞'}">${_uiIcon('heart', 13)}${m.userLikeCount ? `<span class="phone-moment-action-count">${m.userLikeCount}</span>` : ''}</button>
            <button type="button" onclick="Phone._commentNpcMoment(${i})" class="phone-moment-action-btn" title="评论">${_uiIcon('comment', 13)}</button>
            <button type="button" onclick="Phone._editNpcMoment(${i})" class="phone-moment-action-btn" title="编辑">${_uiIcon('pen', 13)}</button>
            ${m.image ? `<button type="button" onclick="Phone._saveMomentImageToAlbum('npc', ${i})" class="phone-moment-action-btn" title="存入相册">${_uiIcon('download', 13)}</button>` : ''}
            <button type="button" onclick="Phone._collectNpcMoment(${i})" class="phone-moment-action-btn" title="收藏">${_uiIcon('star', 13)}</button>
            <button type="button" onclick="Phone._shareNpcMoment(${i})" class="phone-moment-action-btn" title="分享">${_uiIcon('share', 13)}</button>
            <button type="button" onclick="Phone._deleteNpcMoment(${i})" class="phone-moment-action-btn danger" title="删除">${_uiIcon('trash', 13)}</button>
          </div>
          ${commentsHtml(m.comments)}
        </div>
      `).join('')
      : '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">点击"刷新动态"查看好友动态</p>';

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%">
        <div class="phone-moments-cover" onclick="Phone._onMomentsCoverPicked()" style="${pd.momentsCover ? `background-image:linear-gradient(180deg,rgba(0,0,0,0.10),rgba(0,0,0,0.46)),url('${pd.momentsCover}')` : ''}">
          ${_momentsTab !== 'config' ? `<button type="button" class="phone-moments-cover-action" onclick="event.stopPropagation();${_momentsTab === 'mine' ? 'Phone._postMoment()' : 'Phone._refreshNpcMoments()'}" title="${_momentsTab === 'mine' ? '发动态' : '刷新好友动态'}">
            ${_momentsTab === 'mine' ? _uiIcon('camera', 15) : _uiIcon('refresh', 15)}
          </button>` : ''}
          <div class="phone-moments-cover-hint">点击更换封面</div>
          <div class="phone-moments-profile">
            ${avatarHtml(maskName, maskAvatar, 'cover')}
            <div class="phone-moments-profile-text">
              <div class="phone-moments-profile-name">${Utils.escapeHtml(maskName)}</div>
              <div class="phone-moments-profile-sub">${_momentsTab === 'mine' ? '我的动态' : (_momentsTab === 'friends' ? '好友动态' : '设置')}</div>
            </div>
          </div>
        </div>
        <div id="phone-moments-mine-list" class="phone-moments-list" style="display:${_momentsTab === 'mine' ? 'block' : 'none'}">${myHtml}</div>
        <div id="phone-moments-npc-list" class="phone-moments-list" style="display:${_momentsTab === 'friends' ? 'block' : 'none'}">${friendsHtml}</div>
        <div id="phone-moments-config-list" class="phone-moments-list" style="display:${_momentsTab === 'config' ? 'block' : 'none'}">${_renderMomentsConfigPanel(pd)}</div>
        <div class="phone-tabbar">
  <div class="phone-tab ${_momentsTab === 'mine' ? 'active' : ''}" onclick="Phone._switchMomentsTab('mine')">我的动态</div>
  <div class="phone-tab ${_momentsTab === 'friends' ? 'active' : ''}" onclick="Phone._switchMomentsTab('friends')">好友动态</div>
  <div class="phone-tab ${_momentsTab === 'config' ? 'active' : ''}" onclick="Phone._switchMomentsTab('config')">设置</div>
</div>
      </div>
    `;

    // 缓存未命中：异步构建并回填头像/名字
    if (!cache) _buildMomentsCacheAndPatch(pd, convId);
  }

  // 异步构建好友圈渲染缓存（mask 名字/头像 + NPC 头像映射），完成后回填到当前已渲染的 DOM。
  async function _buildMomentsCacheAndPatch(pd, convId) {
    let maskName = '我';
    let maskAvatar = '';
    try {
      const mask = (typeof Character !== 'undefined' && Character.get) ? await Character.get() : null;
      maskName = (mask?.onlineName || '').trim() || mask?.name || '我';
      maskAvatar = (typeof Character !== 'undefined' && Character.getAvatar ? Character.getAvatar() : '') || mask?.avatar || '';
    } catch(_) {}

    const npcAvatarMap = {};
    try {
      const avatarRows = await DB.getAll('npcAvatars');
      const avatarById = {};
      avatarRows.forEach(a => { if (a && a.id) avatarById[a.id] = a.avatar || ''; });
      const conv = (typeof Conversations !== 'undefined') ? Conversations.getList().find(c => c.id === convId) : null;
      const wvIds = [conv?.worldviewId, conv?.singleWorldviewId, conv?.singleCharSourceWvId].filter(Boolean);
      const wvs = [];
      for (const id of wvIds) {
        try { const wv = await DB.get('worldviews', id); if (wv) wvs.push(wv); } catch(_) {}
      }
      try {
        const all = await DB.getAll('worldviews');
        all.forEach(wv => { if (wv && !wvs.find(x => x.id === wv.id)) wvs.push(wv); });
      } catch(_) {}
      const addNpc = (n) => {
        if (!n) return;
        const url = avatarById[n.id] || n.avatar || '';
        if (!url) return;
        const names = [n.name, ...(String(n.aliases || '').split(/[,，、\s]+/))]
          .map(x => String(x || '').trim()).filter(Boolean);
        names.forEach(name => { if (!npcAvatarMap[name]) npcAvatarMap[name] = url; });
      };
      wvs.forEach(wv => {
        (wv.globalNpcs || []).forEach(addNpc);
        (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(addNpc)));
      });
    } catch(_) {}

    _momentsRenderCache = { convId, maskId: (typeof Character !== 'undefined' && Character.getCurrentId) ? Character.getCurrentId() : null, maskName, maskAvatar, npcAvatarMap };

    // 当前还在好友圈页 + 同对话 → 重渲一次（这次会走缓存命中路径，DOM 同步即出）
    if (_currentApp === 'moments' && Conversations.getCurrent() === convId) {
      _renderMoments(pd);
    }
  }

  async function _switchMomentsTab(tab) {
    _momentsTab = tab;
    const pd = await _getPhoneData();
    if (pd) _renderMoments(pd);
  }

  // 统一的手机收藏写入函数
  async function _addPhoneCollection(phoneType, title, content, extras) {
    try {
      const data = await DB.get('gameState', 'gaidenList') || { key: 'gaidenList', value: [] };
      const list = data.value || [];
      const item = Object.assign({
        id: 'phone_' + Utils.uuid().slice(0, 8),
        type: 'phone',
        phoneType: phoneType, // 'forum' | 'map' | 'moments' | 'memo'
        title: title || '无标题',
        content: content || '',
        sourceConv: Conversations.getCurrent(),
        sourceConvName: (typeof Conversations.getCurrentName === 'function') ? Conversations.getCurrentName() : '',
        savedAt: Date.now(),
        createdAt: new Date().toISOString(),
      }, extras || {});
      list.unshift(item);
      await DB.put('gameState', { key: 'gaidenList', value: list });
      if (window.Gaiden && Gaiden.addToList) Gaiden.addToList(item);
      UI.showToast('已收藏到收藏库', 1500);
    } catch(e) {
      UI.showToast('收藏失败: ' + e.message, 2000);
    }
  }

  async function _likeNpcMoment(index) {
    const pd = await _getPhoneData();
    const m = pd?.npcMoments?.[index];
    if (!m) return;
    m.likedByUser = !m.likedByUser;
    m.userLikeCount = Math.max(0, (m.userLikeCount || 0) + (m.likedByUser ? 1 : -1));
    await _savePhoneData();
    _log(_formatNpcMomentFullLog(m, m.likedByUser ? '点赞' : '取消点赞'));
    UI.showToast(m.likedByUser ? '已点赞' : '已取消点赞', 900);
    _renderMoments(pd);
  }

  async function _commentNpcMoment(index) {
    const pd = await _getPhoneData();
    const m = pd?.npcMoments?.[index];
    if (!m) return;
    const text = await UI.showSimpleInput('评论好友动态', '');
    if (!text || !text.trim()) return;
    let maskName = '我';
    try { const mask = await Character.get(); maskName = (mask?.onlineName || '').trim() || mask?.name || '我'; } catch(_) {}
    if (!Array.isArray(m.comments)) m.comments = [];
    const comment = { name: maskName, text: text.trim(), byUser: true, time: new Date().toISOString() };
    m.comments.push(comment);
    await _savePhoneData();
    _log(_formatNpcMomentFullLog(m, `评论（${comment.text}）`));
    UI.showToast('评论已发布', 900);
    _renderMoments(pd);
  }

  async function _collectNpcMoment(index) {
    const pd = await _getPhoneData();
    const m = pd?.npcMoments?.[index];
    if (!m) return;
    const text = `【${m.npc}】${m.text}${(m.comments && m.comments.length) ? '\n\n评论：\n' + m.comments.map(c => `${c.name}：${c.text}`).join('\n') : ''}`;
    // 带上配图（dataURL）和配图描述，收藏库可显示图片
    const extras = { comments: m.comments || [] };
    if (m.image) extras.image = m.image;
    if (m.imageDesc) extras.imageDesc = m.imageDesc;
    await _addPhoneCollection('moments', `${m.npc}的动态`, text, extras);
  }

  async function _collectMyMoment(index) {
    const pd = await _getPhoneData();
    const m = pd?.moments?.[index];
    if (!m) return;
    let text = m.text || '';
    if (m.imageDesc) text += `\n[配图描述：${m.imageDesc}]`;
    // 带上配图（dataURL）和配图描述，收藏库可显示图片
    const extras = { comments: m.comments || [] };
    if (m.image) extras.image = m.image;
    if (m.imageDesc) extras.imageDesc = m.imageDesc;
    await _addPhoneCollection('moments', '我的动态：' + (m.text || '').substring(0, 20), text, extras);
  }

  // 把好友圈动态的配图存进手机相册（drawnImages 表 + album 条目）
  // type: 'my' 我的动态 | 'npc' 好友动态
  async function _saveMomentImageToAlbum(type, index) {
    const pd = await _getPhoneData();
    if (!pd) return;
    const m = type === 'npc' ? pd?.npcMoments?.[index] : pd?.moments?.[index];
    if (!m) return;
    if (!m.image) { UI.showToast('这条动态没有配图', 1500); return; }
    try {
      // 存进图库表
      const imageId = 'img_' + Utils.uuid();
      await DB.put('drawnImages', {
        id: imageId,
        dataUrl: m.image,
        prompt: m.imageDesc || '好友圈配图',
        createdAt: new Date().toISOString()
      });
      // 存进相册（mode='ai_image'，和相机生图同结构）
      if (!Array.isArray(pd.album)) pd.album = [];
      const who = type === 'npc' ? (m.npc || '好友') : '我';
      pd.album.push({
        id: 'photo_' + Utils.uuid().slice(0, 8),
        mode: 'ai_image',
        text: m.imageDesc ? `${who}的动态配图：${m.imageDesc}` : `${who}的动态配图`,
        imageId,
        location: '',
        time: m.time || '',
        createdAt: new Date().toISOString()
      });
      await _savePhoneData();
      _log(`把${who}的好友圈配图存进了相册`);
      UI.showToast('已存入相册', 1500);
    } catch(e) {
      UI.showToast('存入相册失败：' + (e.message || '未知错误'), 2000);
    }
  }

  async function _deleteMyMoment(index) {
    if (!await UI.showConfirm('删除动态', '确定删除这条动态？')) return;
    const pd = await _getPhoneData();
    if (!pd || !pd.moments?.[index]) return;
    pd.moments.splice(index, 1);
    await _savePhoneData();
    _log('删除了一条好友圈动态');
    UI.showToast('已删除', 1000);
    _renderMoments(pd);
  }

  // v687.34：编辑我的动态
  async function _editMyMoment(index) {
    const pd = await _getPhoneData();
    const m = pd?.moments?.[index];
    if (!m) return;
    const newText = await UI.showSimpleInput('编辑动态', m.text || '', { multiline: true, rows: 5, minHeight: '120px' });
    if (newText === null || newText === undefined) return; // 取消
    if (!newText.trim()) { UI.showToast('内容不能为空', 1200); return; }
    m.text = newText.trim();
    await _savePhoneData();
    _log('编辑了一条好友圈动态');
    UI.showToast('已保存', 900);
    _renderMoments(pd);
  }

  // v687.34：编辑好友动态（NPC）
  async function _editNpcMoment(index) {
    const pd = await _getPhoneData();
    const m = pd?.npcMoments?.[index];
    if (!m) return;
    const newText = await UI.showSimpleInput(`编辑 ${m.npc || 'NPC'} 的动态`, m.text || '', { multiline: true, rows: 5, minHeight: '120px' });
    if (newText === null || newText === undefined) return;
    if (!newText.trim()) { UI.showToast('内容不能为空', 1200); return; }
    m.text = newText.trim();
    await _savePhoneData();
    UI.showToast('已保存', 900);
    _renderMoments(pd);
  }

  // v687.34：删除好友动态（NPC）
  async function _deleteNpcMoment(index) {
    const pd = await _getPhoneData();
    const m = pd?.npcMoments?.[index];
    if (!m) return;
    if (!await UI.showConfirm('删除动态', `确定删除 ${m.npc || 'NPC'} 的这条动态？`)) return;
    pd.npcMoments.splice(index, 1);
    await _savePhoneData();
    UI.showToast('已删除', 1000);
    _renderMoments(pd);
  }

  async function _collectMapResult(index) {
    const r = _mapSearchResults[index];
    if (!r) return;
    const content = `地点：${r.name || ''}\n地址：${r.address || ''}\n描述：${r.desc || ''}${r.distance ? '\n距离：' + r.distance : ''}`;
    await _addPhoneCollection('map', r.name || '地点', content);
  }

  async function _collectMemo(index) {
    const pd = await _getPhoneData();
    const m = pd?.memos?.[index];
    if (!m) return;
    let content = '';
    if (m.time) content += `时间：${m.time}\n`;
    content += m.content || '';
    await _addPhoneCollection('memo', m.title || '无标题', content);
  }

  async function _collectForumPost(index) {
    // 防重复收藏
    const btn = document.getElementById('phone-forum-collect-btn');
    if (btn?.classList.contains('active-collect')) { UI.showToast('已收藏过了', 800); return; }
    const pd = await _getPhoneData();
    let posts = pd?.cachedForumPosts || [];
    if (posts.length === 0) posts = (window.WorldVoice && WorldVoice.getPosts()) || [];
    const p = posts[index];
    if (!p) { UI.showToast('帖子不存在', 1000); return; }
    const content = p.fullContent || p.summary || '';
    await _addPhoneCollection('forum', p.title || `${_getForumName()}帖子`, content, {
      username: p.username,
      avatar_color: p.avatar_color,
      time: p.time,
      tags: p.tags,
      views: p.views,
      likes: p.likes,
      comments: p._comments || []
    });
    // 收藏成功动画
    if (btn) {
      btn.classList.add('active-collect');
      const icon = document.getElementById('phone-forum-collect-icon');
      if (icon) icon.setAttribute('fill', 'currentColor');
    }
  }

  async function _collectMomentVisibleOptions() {
    const map = new Map();
    const add = (name, source, avatar) => {
      name = String(name || '').trim();
      if (!name) return;
      if (!map.has(name)) map.set(name, { name, sources: new Set(), avatar: '' });
      if (source) map.get(name).sources.add(source);
      if (avatar && !map.get(name).avatar) map.get(name).avatar = avatar;
    };
    // v621: 预加载 NPC 头像
    let avatarById = {};
    try {
      const avatarRows = await DB.getAll('npcAvatars').catch(() => []);
      (avatarRows || []).forEach(a => { if (a?.id) avatarById[a.id] = a.avatar || ''; });
    } catch(_) {}
    const addNpcFromWv = (wv, sourcePrefix = '世界观') => {
      if (!wv) return;
      (wv.globalNpcs || []).forEach(n => add(n.name, '常驻角色', avatarById[n.id] || n.avatar || ''));
      (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(n => add(n.name, sourcePrefix, avatarById[n.id] || n.avatar || ''))));
    };
    try {
      const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
      const wvIds = [conv?.worldviewId, conv?.singleWorldviewId, conv?.singleCharSourceWvId].filter(Boolean);
      for (const id of wvIds) {
        try { addNpcFromWv(await DB.get('worldviews', id), '世界观NPC'); } catch(_) {}
      }
      try { addNpcFromWv(await Worldview.getCurrent(), '世界观NPC'); } catch(_) {}

      if (typeof AttachedChars !== 'undefined' && AttachedChars.resolveAll) {
        const attached = await AttachedChars.resolveAll();
        attached.forEach(c => add(c.name, c.type === 'npc' ? '常驻NPC' : '常驻角色', c.avatar || ''));
      }

      if (conv?.isSingle && conv.singleCharId) {
        if (conv.singleCharType === 'card') {
          const card = await DB.get('singleCards', conv.singleCharId);
          add(card?.name, '角色', card?.avatar || '');
        } else if (conv.singleCharType === 'npc') {
          let found = '', foundAvatar = '';
          for (const id of wvIds) {
            const wv = await DB.get('worldviews', id).catch(() => null);
            if (!wv) continue;
            for (const n of (wv.globalNpcs || [])) if (n.id === conv.singleCharId) { found = n.name; foundAvatar = avatarById[n.id] || n.avatar || ''; }
            (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(n => { if (n.id === conv.singleCharId) { found = n.name; foundAvatar = avatarById[n.id] || n.avatar || ''; } })));
          }
          add(found, '单人NPC', foundAvatar);
        }
      }

      const pd = await _getPhoneData();
      if (pd?.relations) Object.values(pd.relations).forEach(r => add(r.name, '关系NPC', r.avatar || ''));
    } catch(_) {}
    return Array.from(map.values()).map(x => ({ name: x.name, source: Array.from(x.sources).join(' / ') || 'NPC', avatar: x.avatar || '' })).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  function _renderMomentVisibleLabel() {
    const label = document.getElementById('phone-moment-visible-label');
    if (!label) return;
    if (_momentVisibleSelected.has('__all__') || _momentVisibleSelected.size === 0) {
      label.textContent = '全部可见';
      return;
    }
    const names = Array.from(_momentVisibleSelected);
    label.textContent = names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 人可见` : `${names.join('、')} 可见`;
  }

  function _filterMomentVisibleOptions(q) {
    q = String(q || '').trim().toLowerCase();
    const list = document.getElementById('phone-moment-visible-list');
    if (!list) return;
    const opts = _momentVisibleOptions.filter(o => !q || o.name.toLowerCase().includes(q) || o.source.toLowerCase().includes(q));
    list.innerHTML = opts.length ? opts.map(o => {
      const checked = _momentVisibleSelected.has(o.name) && !_momentVisibleSelected.has('__all__');
      return `<label class="phone-visible-option circle-check-label">
<span class="phone-visible-name circle-check-text">${Utils.escapeHtml(o.name)}</span>
<span class="phone-visible-source">${Utils.escapeHtml(o.source)}</span>
<span style="position:relative;display:inline-flex"><input type="checkbox" class="circle-check" value="${Utils.escapeHtml(o.name)}" ${checked ? 'checked' : ''} onchange="Phone._toggleMomentVisibleOption(this)"><span class="circle-check-ui"></span></span>
</label>`;
    }).join('') : '<div style="text-align:center;color:var(--text-secondary);font-size:12px;padding:24px 0">没有匹配的 NPC</div>';
  }

  function _toggleMomentVisibleOption(input) {
    const name = input?.value || '';
    _momentVisibleSelected.delete('__all__');
    if (input.checked) _momentVisibleSelected.add(name);
    else _momentVisibleSelected.delete(name);
    if (_momentVisibleSelected.size === 0) _momentVisibleSelected.add('__all__');
    const all = document.getElementById('phone-visible-all');
    if (all) all.checked = _momentVisibleSelected.has('__all__');
    _renderMomentVisibleLabel();
  }

  function _setMomentVisibleAll(checked) {
    if (checked) _momentVisibleSelected = new Set(['__all__']);
    else if (_momentVisibleSelected.has('__all__')) _momentVisibleSelected = new Set();
    _filterMomentVisibleOptions(document.getElementById('phone-visible-search')?.value || '');
    _renderMomentVisibleLabel();
  }

  function _openMomentVisibleModal() {
    let modal = document.getElementById('phone-visible-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'phone-visible-modal';
      modal.className = 'phone-inner-modal hidden';
      modal.innerHTML = `<div class="modal-content phone-visible-modal-content">
<div class="phone-visible-header"><h3>对谁可见</h3><button onclick="Phone._closeMomentVisibleModal()" class="btn-icon modal-corner-btn close-btn">×</button></div>
<label class="phone-visible-all circle-check-label">
<span class="circle-check-text">全部可见</span>
<span style="position:relative;display:inline-flex"><input id="phone-visible-all" type="checkbox" class="circle-check" onchange="Phone._setMomentVisibleAll(this.checked)"><span class="circle-check-ui"></span></span>
</label>
<input id="phone-visible-search" class="phone-visible-search" placeholder="搜索角色…" oninput="Phone._filterMomentVisibleOptions(this.value)">
<div id="phone-moment-visible-list" class="phone-visible-list"></div>
<button type="button" class="phone-visible-done" onclick="Phone._closeMomentVisibleModal()">完成</button>
    </div>`;
      const shell = document.querySelector('#phone-modal .phone-shell');
      (shell || document.body).appendChild(modal);
    }
    document.getElementById('phone-visible-all').checked = _momentVisibleSelected.has('__all__');
    const search = document.getElementById('phone-visible-search');
    if (search) search.value = '';
    _filterMomentVisibleOptions('');
    modal.classList.remove('hidden');
    modal.classList.add('active');
  }

  function _closeMomentVisibleModal() {
    const modal = document.getElementById('phone-visible-modal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('active'); }
    _renderMomentVisibleLabel();
  }

  async function _postMoment(prefill) {
    _momentVisibleOptions = await _collectMomentVisibleOptions();
    _momentVisibleSelected = new Set(['__all__']);

    // 抓主线时间
    let gameTime = '';
    try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}

    // 预填值（来自相册"发到朋友圈"等场景）
    const prefillText = (prefill && prefill.text) || '';
    const prefillImgDesc = (prefill && prefill.imageDesc) || '';

    const body = document.getElementById('phone-body');
    document.getElementById('phone-title').textContent = '发动态';
    body.innerHTML = `
<div style="padding:12px;display:flex;flex-direction:column;gap:8px;height:100%">
                <textarea id="phone-moment-text" placeholder="说点什么…" style="height:140px;min-height:140px;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg-tertiary);color:var(--text);font-size:13px;resize:none">${Utils.escapeHtml(prefillText)}</textarea>
                <div id="phone-moment-imgdesc-wrap" style="display:flex;flex-direction:column;min-height:0">
                  <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;gap:4px">
                    <span style="display:flex;align-items:center;gap:4px">${_uiIcon('image', 12)} 描述配图（可选，AI 会根据描述生成评论）</span>
                    <button type="button" onclick="Phone._openAlbumPickerForMoment()" style="padding:3px 10px;font-size:11px;border-radius:10px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--accent);cursor:pointer">从相册选</button>
                  </div>
                  <textarea id="phone-moment-imgdesc" placeholder="用文字描述你想配的图片，例如：一张窗外的雨景照片" style="height:100px;min-height:100px;border:1px solid var(--border);border-radius:6px;padding:6px 8px;background:var(--bg-tertiary);color:var(--text);font-size:12px;resize:none;box-sizing:border-box">${Utils.escapeHtml(prefillImgDesc)}</textarea>
                </div>
        <input id="phone-moment-time" value="${Utils.escapeHtml(gameTime)}" placeholder="时间" style="border:1px solid var(--border);border-radius:6px;padding:6px 8px;background:var(--bg-tertiary);color:var(--text);font-size:12px">
        <button type="button" onclick="Phone._openMomentVisibleModal()" class="phone-visible-trigger"><span>对谁可见</span><strong id="phone-moment-visible-label">全部可见</strong></button>
        <button onclick="event.stopPropagation();Phone._submitMoment()" style="background:var(--accent);color:#111;border:none;border-radius:6px;padding:8px;font-size:13px;cursor:pointer;margin-top:4px">发布</button>
      </div>
    `;
  }

  let _momentImageBase64 = null;
  let _momentVisibleSelected = new Set(['__all__']);
  let _momentVisibleOptions = [];

  // ===== 通用分享到主线 =====
  async function _shareToMain(type, title, content) {
    // type: 'forum' | 'map' | 'moments' | 'memo' | 'shop'
    const typeLabel = type === 'forum' ? `${_getForumName()}内容`
      : type === 'map' ? '地点信息'
      : type === 'moments' ? '好友圈动态'
      : type === 'memo' ? '备忘录'
      : type === 'shop' ? '商品链接'
      : '手机内容';
    if (!await UI.showConfirm('分享到主线', `将这条${typeLabel}作为附件挂载，下次发送消息时会一并带入上下文。`)) return;
    Chat.setWorldVoiceAttach({
      mediaType: typeLabel,
      title: title || typeLabel,
      content: content || '',
      comments: []
    });
    UI.showToast('已挂载，发送消息时将带入', 1500);
  }

  function _toggleImageDesc() {
    // 已废弃：图片描述区域改为默认显示，此函数保留为空兼容旧调用
  }

  function _onMomentImagePicked(input) {
    // 已废弃：好友圈不再支持上传真图，仅用文字描述（imageDesc）
    if (input) input.value = '';
    UI.showToast?.('好友圈已改为「文字描述配图」，请在下方描述框填写图片内容', 2500);
  }

  async function _submitMoment() {
    try {
      const text = document.getElementById('phone-moment-text')?.value.trim();
      if (!text) { UI.showToast('请输入内容', 1000); return; }
      const time = document.getElementById('phone-moment-time')?.value.trim() || '';
      const visibleNpcs = (_momentVisibleSelected.has('__all__') || _momentVisibleSelected.size === 0) ? [] : Array.from(_momentVisibleSelected);

      const pd = await _getPhoneData();
      if (!pd) return;

      const moment = {
        id: 'mom_' + Utils.uuid().slice(0, 8),
        text,
        // image 字段已废弃（不再支持上传真图，节省内存）；旧档遗留的 image 仍能渲染
        imageDesc: document.getElementById('phone-moment-imgdesc')?.value.trim() || null,
        visibleNpcs,
        time,
        comments: [],
        createdAt: new Date().toISOString()
      };
      if (!Array.isArray(pd.moments)) pd.moments = [];
      pd.moments.unshift(moment);
      _momentImageBase64 = null;
      await _savePhoneData();
      // 日志：携带正文摘要 + 配图描述 + 可见范围，让 AI 知道用户发了什么
      const _logParts = [`发了一条好友圈动态：「${_clipLogText(text, 60)}」`];
      if (moment.imageDesc) _logParts.push(`配图描述：${_clipLogText(moment.imageDesc, 40)}`);
      if (visibleNpcs.length > 0) _logParts.push(`仅对 ${visibleNpcs.join('、')} 可见`);
      _log(_logParts.join('；'));
      UI.showToast('已发布', 1000);
      _renderMoments(pd);
    } catch(e) {
      console.error('[_submitMoment]', e);
      UI.showToast('发布失败：' + e.message, 2500);
    }
  }

  async function _shareMoment(index) {
    const pd = await _getPhoneData();
    const m = pd?.moments?.[index];
    if (!m) return;
    let content = m.text || '';
    if (m.imageDesc) content += `\n[配图描述：${m.imageDesc}]`;
    if (m.comments?.length) content += '\n评论：\n' + m.comments.map(c => `${c.name}: ${c.text}`).join('\n');
    _shareToMain('moments', '好友圈动态', content);
  }

  async function _shareNpcMoment(index) {
    const pd = await _getPhoneData();
    const m = pd?.npcMoments?.[index];
    if (!m) return;
    let content = `${m.npc || ''}：${m.text || ''}`;
    if (m.comments?.length) content += '\n评论：\n' + m.comments.map(c => `${c.name}: ${c.text}`).join('\n');
    _shareToMain('moments', `${m.npc || '好友'}的动态`, content);
  }

  async function _shareMemo(index) {
    const pd = await _getPhoneData();
    const m = pd?.memos?.[index];
    if (!m) return;
    let content = `标题：${m.title || '无标题'}`;
    if (m.time) content += `\n时间：${m.time}`;
    if (m.content) content += `\n内容：${m.content}`;
    _shareToMain('memo', m.title || '备忘录', content);
  }

  async function _refreshMomentComments(momentIndex) {
    const pd = await _getPhoneData();
    if (!pd || !pd.moments[momentIndex]) return;
    const m = pd.moments[momentIndex];
    UI.showToast('正在生成评论…', 1200);

    const card = document.getElementById(`phone-moment-card-${momentIndex}`);
    const oldLoading = card?.querySelector('.phone-moment-comment-loading');
    if (oldLoading) oldLoading.remove();
    if (card) {
      card.insertAdjacentHTML('beforeend', `
        <div class="phone-moment-comments phone-moment-comment-loading">
          <div class="phone-moment-comments-title">评论区生成中</div>
          ${Array.from({ length: 3 }).map(() => `
            <div class="wv-skeleton-card phone-comment-skeleton-card">
              <div class="wv-skeleton-row"><div class="wv-skeleton-avatar"></div><div class="wv-skeleton-line user"></div></div>
              <div class="wv-skeleton-line summary-1"></div>
            </div>`).join('')}
        </div>`);
    }

    try {
      const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
      const mainConfig = await API.getConfig();
      const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
      const key = funcConfig.apiKey || mainConfig.apiKey;
      const model = funcConfig.model || mainConfig.model;
      if (!url || !key || !model) { UI.showToast('请先配置功能模型'); return; }

      const wvPrompt = await _buildFullContext();
    const visibleStr = (m.visibleNpcs || []).join('、') || '所有人';
    const imgInfo = m.imageDesc ? `（配图描述：${m.imageDesc}）` : (m.image ? '（附带了一张图片）' : '');
    // v617：禁止冒充玩家
    let _userName = '';
    let _userOnlineName = '';
    try { const mask = await Character.get(); _userName = mask?.name || ''; _userOnlineName = (mask?.onlineName || '').trim(); } catch(_) {}
    const banNames = [_userName, _userOnlineName].filter(Boolean);
    const userBan = banNames.length > 0
      ? `\n【严格约束】评论者姓名绝对不能是"${banNames.join('"或"')}"（那是玩家本人），也不允许任何评论以"我"（指代玩家）的口吻发言。这条动态是玩家自己发的，不需要玩家自评。`
      : '\n【严格约束】评论者不能是玩家本人。';
    const prompt = `用户发了一条动态："${m.text}"${imgInfo}（对 ${visibleStr} 可见）。
请根据NPC列表中角色的性格和当前剧情，让可见的NPC评论这条动态。每个NPC最多评论一条，总评论数不超过15条。部分NPC可以选择不评论。${userBan}
返回纯JSON数组：[{"name":"NPC名","text":"评论内容"}]`;

    const comments = await _phoneJsonArrayWithRetry({
        label: '好友圈评论', url, key, model,
        temperature: 0.9,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: wvPrompt },
          { role: 'user', content: prompt }
        ]
      });
      m.comments = comments.slice(0, 15);
      await _savePhoneData();
      _log(`刷新了好友圈评论；动态摘要：「${_clipLogText(m.text, 36)}」；评论摘要：${_summarizeListForLog(m.comments, c => `${_clipLogText(c.name || '未知', 12)}：${_clipLogText(c.text, 36)}`, 5)}`);
      if (_isAppStillActive('moments')) {
        _renderMoments(pd);
      }
      UI.showToast(_isAppStillActive('moments') ? '评论已生成' : '评论已生成，可回好友圈查看', 1200);
    } catch(e) {
      card?.querySelector('.phone-moment-comment-loading')?.remove();
      if (card) {
        card.insertAdjacentHTML('beforeend', `<div class="phone-generation-error phone-moment-comment-error"><div>评论生成失败：${Utils.escapeHtml(e.message || '未知错误')}</div><div>已重试3次，可稍后再试</div></div>`);
      }
      UI.showToast('评论生成失败: ' + e.message, 2500);
    }
  }

  async function _refreshNpcMoments() {
    const pd = await _getPhoneData();
    if (!pd) return;

    // v687.6：读取好友圈配置
    const cfg = pd.momentsConfig || {};
    const wantCount = Math.max(1, Math.min(8, parseInt(cfg.count, 10) || 4));
    const imageLimit = Math.max(0, Math.min(wantCount, parseInt(cfg.imageLimit, 10) ?? wantCount));
    const storageMax = Math.max(20, Math.min(100, parseInt(cfg.storageMax, 10) || 30));

    // 自动切到"好友动态" tab
    _momentsTab = 'friends';
    _renderMoments(pd);

    // 显示骨架屏加载态
    const npcContainer = document.getElementById('phone-moments-npc-list');
    const setLoading = (attempt = 1, maxRetries = 3) => {
      const cur = document.getElementById('phone-moments-npc-list');
      if (!cur) return;
      cur.innerHTML = Array.from({ length: wantCount }).map((_, idx) => `
        <div class="phone-moment-skeleton-card phone-moment-generating-card">
          ${idx === 0 ? `<div class="phone-generation-inline-label">正在生成好友动态… ${attempt}/${maxRetries}</div>` : ''}
          <div class="phone-moment-skeleton-row"><div class="phone-moment-skeleton-avatar"></div><div class="phone-moment-skeleton-line user"></div><div class="phone-moment-skeleton-line time"></div></div>
          <div class="phone-moment-skeleton-line summary-1"></div>
          <div class="phone-moment-skeleton-line summary-2"></div>
        </div>`).join('');
    };
    setLoading(1, 3);
    UI.showToast('正在生成好友动态…', 1200);

    // fab 悬浮加载动画
    _setFabGenerating(true);

    // 收集 NPC 名字列表（优先从当前世界观 globalNpcs + 区域 NPC）
    let npcNames = [];
    // v617：用户名（用于禁止 AI 发言时冒充玩家）
    let userName = '';
    let userOnlineName = '';
    try {
      const convId = Conversations.getCurrent();
      const conv = Conversations.getList().find(c => c.id === convId);
      const wvId = conv?.worldviewId || conv?.singleWorldviewId;
      if (wvId) {
        const wv = await DB.get('worldviews', wvId);
        if (wv) {
          (wv.globalNpcs || []).forEach(n => { if (n.name) npcNames.push(n.name); });
          (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(n => {
            if (n.name && !npcNames.includes(n.name)) npcNames.push(n.name);
          })));
        }
      }
      // v687.6：世界书 globalNpcs 也加入候选
      try {
        if (typeof Lorebook !== 'undefined' && Lorebook.collectForChat) {
          let card = null;
          if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
            try { card = await DB.get('singleCards', conv.singleCharId); } catch(_) {}
          }
          const wv2 = wvId ? await DB.get('worldviews', wvId) : null;
          const lbs = await Lorebook.collectForChat({ conv, card, wv: wv2 });
          for (const lb of (lbs || [])) {
            (lb.globalNpcs || []).forEach(n => {
              if (n.name && !npcNames.includes(n.name)) npcNames.push(n.name);
            });
          }
        }
      } catch(_) {}
      // v617：挂载角色加入 NPC 候选
      try {
        if (typeof AttachedChars !== 'undefined' && AttachedChars.resolveAll) {
          const attached = await AttachedChars.resolveAll();
          attached.forEach(c => {
            if (c.name && !npcNames.includes(c.name)) npcNames.push(c.name);
          });
        }
      } catch(_) {}
      // v617：取用户名（面具 name）
      try {
        const mask = await Character.get();
        if (mask?.name) userName = mask.name;
        if (mask?.onlineName) userOnlineName = mask.onlineName.trim();
      } catch(_) {}
    } catch(_) {}

    try {
      const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
      const mainConfig = await API.getConfig();
      const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
      const key = funcConfig.apiKey || mainConfig.apiKey;
      const model = funcConfig.model || mainConfig.model;
      if (!url || !key || !model) {
        UI.showToast('请先配置功能模型');
        if (_isAppStillActive('moments')) _renderMoments(pd);
        return;
      }

      const fullCtx = await _buildFullContext();

      // v687.6：取最近 8 条历史动态作为"避免重复"参考
      const recentHist = (pd.npcMoments || []).slice(0, 8);
      const histRef = recentHist.length > 0
        ? `\n\n【最近的历史动态（仅供参考，避免重复同样的主题/场景/心情）】\n${recentHist.map(m => `- ${m.npc || '?'}（${m.time || '?'}）：${(m.text || '').slice(0, 50)}`).join('\n')}\n请生成不同的话题/场景/角度，避免和上面这些重复。`
        : '';

      const nameConstraint = npcNames.length > 0
      ? `\n\n【严格约束】动态发布者必须从以下NPC列表中选：${npcNames.join('、')}。评论者可以是列表中的NPC，也可以是虚构的路人账号（但路人名字要符合世界观风格）。禁止编造列表外的NPC。`
      : '';
    // v617：禁止冒充玩家
    const _momBanNames = [userName, userOnlineName].filter(Boolean);
    const userBan = _momBanNames.length > 0
      ? `\n\n【禁止冒充玩家】玩家角色"${_momBanNames.join('"和"')}"绝对不能作为动态发布者出现，也不能作为任何评论者出现（包括路人评论）。评论者 name 字段不允许是"${_momBanNames.join('"或"')}"，也不允许任何评论以"我"（指代玩家）的口吻发布。玩家会自己评论，不需要 AI 代劳。`
      : '\n\n【禁止冒充玩家】不要让玩家角色作为动态发布者或评论者，也不要让任何角色冒充用户/玩家发言。';
    
    const systemPrompt = `根据以下世界观、NPC资料和剧情，生成${wantCount}条NPC的社交媒体动态。从NPC列表中随机挑选，内容要贴合角色性格和当前剧情，可以是日常、心情、暗示、或和主角相关的。允许同一NPC发多条动态，但发布时间必须不同（互相错开至少几十分钟）。每条带1-3条路人或者与该NPC有关的其他NPC的评论，若NPC相互不认识或没有交集，可以仅路人评论。

【角色个性化要求】
发布内容必须符合该角色的人物个性、说话习惯和措辞风格。每条动态都要站在角色的角度考虑用词——好友圈是公开的社交空间，角色会展示愿意展示的一面，回避不愿意公开的部分。注意区分：
- 外向/话痨型角色可能发长段感想、分享日常细节
- 内敛/高冷型角色可能只发简短一句话、或只发图不说话
- 有秘密的角色会刻意回避某些话题、用暧昧的措辞一笔带过
- 角色之间的评论互动也要体现关系亲疏和各自的说话风格
不要让所有角色的语气都一样。${nameConstraint}${userBan}

时间要求：每条动态必须带发布时间 time，格式为“YYYY.MM.DD 星期X HH:mm”。发布时间必须在当前/截止剧情最新时间之前，且不早于该时间前7天；禁止生成未来时间。若能从上下文中的【当前游戏时间】读取到时间，就以它为基准生成；如果无法确定具体剧情日期，也要使用世界观/状态栏中能推断出的最新时间附近的过去7天内时间。

配图要求：每条动态可选填 imageQuery 字段（英文摄影关键词，1~3 个词），用于自动配图。仅当动态内容明显适合配图时填写（如美食、风景、宠物、天气、咖啡、夜景等具象意象），抽象情绪或对话类动态请省略该字段。imageQuery 必须是英文，禁止中文。例如：餐厅吃饭→"ramen bowl"、看星空→"starry night sky"、咖啡店→"coffee shop interior"。

返回纯JSON数组，不要任何额外文字：
[{"npc":"NPC名","time":"YYYY.MM.DD 星期X HH:mm","text":"动态内容","imageQuery":"english keywords (可选)","comments":[{"name":"评论者","text":"评论"}]}]
${histRef}
${fullCtx}`;

      const arr = await _phoneJsonArrayWithRetry({
        label: '好友动态', url, key, model,
        temperature: 0.9,
        max_tokens: 3000,
        maxRetries: 3,
        onAttempt: setLoading,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请生成${wantCount}条NPC动态，严格使用NPC列表中的名字，并为每条动态填写符合要求的发布时间 time。` }
        ]
      });
      // v687.6：追加在顶部 + 储存上限截断（旧的从尾巴砍）
      const fresh = arr.slice(0, wantCount);
      pd.npcMoments = [...fresh, ...(pd.npcMoments || [])].slice(0, storageMax);

      // v687.6：并行拉 Unsplash 配图（仅对本批次 fresh 拉图，按 imageLimit 截断；填几张拉几张）
      try {
        const hasKey = (typeof Settings !== 'undefined' && Settings.getUnsplashKey && Settings.getUnsplashKey());
        if (hasKey && imageLimit > 0) {
          // 仅扫描本批次新增的（在 pd.npcMoments 顶部 fresh.length 条），收集有效 imageQuery
          const candidates = [];
          for (let idx = 0; idx < fresh.length; idx++) {
            const m = pd.npcMoments[idx];
            const q = (m.imageQuery || '').trim();
            if (!q) continue;
            if (!/^[\x00-\x7F]+$/.test(q)) continue;
            candidates.push(idx);
          }
          const targets = candidates.slice(0, imageLimit);
          await Promise.all(targets.map(async (idx) => {
            const m = pd.npcMoments[idx];
            try {
              const imgUrl = await API.searchUnsplash(m.imageQuery.trim(), 3);
              if (imgUrl) m.image = imgUrl;
            } catch(_) {}
          }));
        }
      } catch(_) {}

      await _savePhoneData();
      _log(`刷新了好友动态；返回摘要：${_summarizeListForLog(pd.npcMoments, m => `${_clipLogText(m.npc || '未知', 12)}${m.time ? '（' + _clipLogText(m.time, 22) + '）' : ''}：${_clipLogText(m.text, 42)}`)}`);
      if (_isAppStillActive('moments')) {
        _renderMoments(pd);
      }
      UI.showToast(_isAppStillActive('moments') ? '好友动态已刷新' : '好友动态已刷新，可回好友圈查看', 1200);
    } catch(e) {
      UI.showToast('好友动态生成失败：' + e.message, 3500);
      console.error('[Phone] _refreshNpcMoments error:', e);
      if (_isAppStillActive('moments')) {
        const cur = document.getElementById('phone-moments-npc-list');
        if (cur) cur.innerHTML = `<div class="phone-generation-error"><div>生成失败：${Utils.escapeHtml(e.message || '未知错误')}</div><div>已重试3次，可稍后再试</div></div>`;
      }
    } finally {
      _setFabGenerating(false);
    }
  }

  // ===== v687.6：跟随剧情自动刷新好友圈（静默） =====
  function _rollAutoRefreshInterval() {
    return 10 + Math.floor(Math.random() * 11); // 10~20
  }
  function _rollAutoRefreshCount() {
    return 3 + Math.floor(Math.random() * 3); // 3~5
  }

  // 给 chat.js 在 onDone 调用——每"一问一答"完成后扣一次
  async function _tickMomentsAutoRefresh() {
    try {
      const pd = await _getPhoneData();
      if (!pd) return;
      if (!pd.momentsConfig || pd.momentsConfig.autoRefresh !== true) return;

      if (!pd.npcMomentsAuto || typeof pd.npcMomentsAuto.remaining !== 'number') {
        pd.npcMomentsAuto = { remaining: _rollAutoRefreshInterval() };
        await _savePhoneData();
        return;
      }
      pd.npcMomentsAuto.remaining = Math.max(0, pd.npcMomentsAuto.remaining - 1);

    GameLog.log('info', `[好友圈] 自动刷新倒计时=${pd.npcMomentsAuto.remaining}, ${pd.npcMomentsAuto.remaining === 0 ? '✓本轮触发' : `还剩${pd.npcMomentsAuto.remaining}轮`}`);

    if (pd.npcMomentsAuto.remaining > 0) {
        await _savePhoneData();
        return;
      }

      // remaining = 0，触发刷新并重 roll
      pd.npcMomentsAuto.remaining = _rollAutoRefreshInterval();
      await _savePhoneData();

      // 不 await，让对话流程不被阻塞
      _doSilentMomentsRefresh().catch(e => {
        console.warn('[Phone] 自动刷新好友圈失败（已用尽重试）:', e?.message || e);
      });
    } catch (e) {
      console.warn('[Phone] _tickMomentsAutoRefresh error:', e);
    }
  }

  // 静默刷新：无 UI、无 toast、无骨架屏、固定 3-5 条
  async function _doSilentMomentsRefresh() {
    const pd = await _getPhoneData();
    if (!pd) return;

    const cfg = pd.momentsConfig || {};
    const wantCount = _rollAutoRefreshCount();
    const imageLimit = Math.max(0, Math.min(wantCount, parseInt(cfg.imageLimit, 10) ?? wantCount));
    const storageMax = Math.max(20, Math.min(100, parseInt(cfg.storageMax, 10) || 30));

    // 收集 NPC 名字（同 _refreshNpcMoments）
    let npcNames = [];
    let userName = '';
    let userOnlineName = '';
    try {
      const convId = Conversations.getCurrent();
      const conv = Conversations.getList().find(c => c.id === convId);
      const wvId = conv?.worldviewId || conv?.singleWorldviewId;
      if (wvId) {
        const wv = await DB.get('worldviews', wvId);
        if (wv) {
          (wv.globalNpcs || []).forEach(n => { if (n.name) npcNames.push(n.name); });
          (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(n => {
            if (n.name && !npcNames.includes(n.name)) npcNames.push(n.name);
          })));
        }
      }
      try {
        if (typeof Lorebook !== 'undefined' && Lorebook.collectForChat) {
          let card = null;
          if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
            try { card = await DB.get('singleCards', conv.singleCharId); } catch(_) {}
          }
          const wv2 = wvId ? await DB.get('worldviews', wvId) : null;
          const lbs = await Lorebook.collectForChat({ conv, card, wv: wv2 });
          for (const lb of (lbs || [])) {
            (lb.globalNpcs || []).forEach(n => {
              if (n.name && !npcNames.includes(n.name)) npcNames.push(n.name);
            });
          }
        }
      } catch(_) {}
      try {
        if (typeof AttachedChars !== 'undefined' && AttachedChars.resolveAll) {
          const attached = await AttachedChars.resolveAll();
          attached.forEach(c => {
            if (c.name && !npcNames.includes(c.name)) npcNames.push(c.name);
          });
        }
      } catch(_) {}
      try {
        const mask = await Character.get();
        if (mask?.name) userName = mask.name;
        if (mask?.onlineName) userOnlineName = mask.onlineName.trim();
      } catch(_) {}
    } catch(_) {}

    if (npcNames.length === 0) {
      console.log('[Phone] 自动刷新跳过：无可用 NPC');
      return;
    }

    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) {
      console.log('[Phone] 自动刷新跳过：未配置功能模型');
      return;
    }

    const fullCtx = await _buildFullContext();

    const recentHist = (pd.npcMoments || []).slice(0, 8);
    const histRef = recentHist.length > 0
      ? `\n\n【最近的历史动态（仅供参考，避免重复同样的主题/场景/心情）】\n${recentHist.map(m => `- ${m.npc || '?'}（${m.time || '?'}）：${(m.text || '').slice(0, 50)}`).join('\n')}\n请生成不同的话题/场景/角度，避免和上面这些重复。`
      : '';

    const nameConstraint = `\n\n【严格约束】动态发布者必须从以下NPC列表中选：${npcNames.join('、')}。评论者可以是列表中的NPC，也可以是虚构的路人账号（但路人名字要符合世界观风格）。禁止编造列表外的NPC。`;
    const _autoBanNames = [userName, userOnlineName].filter(Boolean);
    const userBan = _autoBanNames.length > 0
      ? `\n\n【禁止冒充玩家】玩家角色"${_autoBanNames.join('"和"')}"绝对不能作为动态发布者出现，也不能作为任何评论者出现。`
      : '\n\n【禁止冒充玩家】不要让玩家角色作为动态发布者或评论者。';

    const systemPrompt = `根据以下世界观、NPC资料和剧情，生成${wantCount}条NPC的社交媒体动态。从NPC列表中随机挑选，内容要贴合角色性格和当前剧情，可以是日常、心情、暗示、或和主角相关的。允许同一NPC发多条动态，但发布时间必须不同（互相错开至少几十分钟）。每条带1-3条路人或者与该NPC有关的其他NPC的评论。

【角色个性化要求】
发布内容必须符合该角色的人物个性、说话习惯和措辞风格。好友圈是公开的社交空间，角色会展示愿意展示的一面，回避不愿意公开的部分。内敛角色可能只发一句话，话痨角色可能长篇大论，有秘密的角色会刻意回避。评论互动也要体现关系亲疏和各自说话风格。不要让所有角色语气一样。${nameConstraint}${userBan}

时间要求：每条动态必须带发布时间 time，格式为"YYYY.MM.DD 星期X HH:mm"。发布时间必须在当前/截止剧情最新时间之前，且不早于该时间前7天；禁止生成未来时间。

配图要求：每条动态可选填 imageQuery 字段（英文摄影关键词，1~3 个词），用于自动配图。仅当动态内容明显适合配图时填写。imageQuery 必须是英文。

返回纯JSON数组，不要任何额外文字：
[{"npc":"NPC名","time":"YYYY.MM.DD 星期X HH:mm","text":"动态内容","imageQuery":"english keywords (可选)","comments":[{"name":"评论者","text":"评论"}]}]
${histRef}
${fullCtx}`;

    const arr = await _phoneJsonArrayWithRetry({
      label: '自动刷新好友动态', url, key, model,
      temperature: 0.9,
      max_tokens: 2500,
      maxRetries: 3,
      onAttempt: null,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `请生成${wantCount}条NPC动态。` }
      ]
    });

    const pd2 = await _getPhoneData();
    if (!pd2) return;
    const fresh = arr.slice(0, wantCount);
    pd2.npcMoments = [...fresh, ...(pd2.npcMoments || [])].slice(0, storageMax);

    try {
      const hasKey = (typeof Settings !== 'undefined' && Settings.getUnsplashKey && Settings.getUnsplashKey());
      if (hasKey && imageLimit > 0) {
        const candidates = [];
        for (let idx = 0; idx < fresh.length; idx++) {
          const m = pd2.npcMoments[idx];
          const q = (m.imageQuery || '').trim();
          if (!q) continue;
          if (!/^[\x00-\x7F]+$/.test(q)) continue;
          candidates.push(idx);
        }
        const targets = candidates.slice(0, imageLimit);
        await Promise.all(targets.map(async (idx) => {
          const m = pd2.npcMoments[idx];
          try {
            const imgUrl = await API.searchUnsplash(m.imageQuery.trim(), 3);
            if (imgUrl) m.image = imgUrl;
          } catch(_) {}
        }));
      }
    } catch(_) {}

    await _savePhoneData();
    _log(`[自动刷新] 新增 ${fresh.length} 条好友动态`);

    // 若用户当前正在好友圈页 → 静默重渲（不切 tab）
    if (_currentApp === 'moments') {
      try { _renderMoments(pd2); } catch(_) {}
    }
  }

  // v687.6：好友圈动态配置面板（设置 tab 一屏直出，输入即保存）
  function _renderMomentsConfigPanel(pd) {
    const cfg = (pd && pd.momentsConfig) || {};
    const curCount = Math.max(1, Math.min(8, parseInt(cfg.count, 10) || 4));
    const curImgLimit = Math.max(0, Math.min(curCount, parseInt(cfg.imageLimit, 10) ?? curCount));
    const curStorage = Math.max(20, Math.min(100, parseInt(cfg.storageMax, 10) || 30));
    const autoOn = cfg.autoRefresh === true;
    const hasKey = (typeof Settings !== 'undefined' && Settings.getUnsplashKey && Settings.getUnsplashKey());
    const curStored = (pd && pd.npcMoments && pd.npcMoments.length) || 0;

    return `
      <div style="padding:16px 14px;display:flex;flex-direction:column;gap:20px">
        <div>
          <label class="circle-check-label" style="margin:0;padding:0">
            <span class="circle-check-text" style="font-size:13px">跟随剧情自动刷新</span>
            <span style="position:relative;display:inline-flex">
              <input type="checkbox" class="circle-check" ${autoOn ? 'checked' : ''} onchange="Phone._toggleMomentsAutoRefresh(this.checked)">
              <span class="circle-check-ui"></span>
            </span>
          </label>
          <p style="font-size:11px;color:var(--text-secondary);margin:6px 0 0;line-height:1.5">开启后每隔约 10-20 轮对话自动生成 3-5 条新动态，静默后台运行。会消耗 API 额度。</p>
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-size:13px;color:var(--text)">单次生成条数</span>
            <strong id="mc-count-val" style="font-size:14px;color:var(--accent)">${curCount} 条</strong>
          </div>
          <input id="mc-count" type="range" min="1" max="8" step="1" value="${curCount}" oninput="Phone._onMomentsConfigCountChange(this.value)" style="width:100%">
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-size:13px;color:var(--text)">配图张数上限</span>
            <strong id="mc-img-val" style="font-size:14px;color:var(--accent)">${curImgLimit} 张</strong>
          </div>
          <input id="mc-img-limit" type="range" min="0" max="${curCount}" step="1" value="${curImgLimit}" oninput="Phone._onMomentsConfigImgChange(this.value)" style="width:100%">
          <p style="font-size:11px;color:var(--text-secondary);margin:6px 0 0;line-height:1.5">${hasKey ? 'AI 标记需配图的动态里，按顺序取前 N 张拉 Unsplash。设 0 = 关闭配图。' : '<span style="color:#e0a050">⚠ 未配置 Unsplash Access Key（在 设置→功能模型 末尾填写）</span>'}</p>
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-size:13px;color:var(--text)">动态储存上限</span>
            <strong id="mc-storage-val" style="font-size:14px;color:var(--accent)">${curStorage} 条</strong>
          </div>
          <input id="mc-storage-max" type="range" min="20" max="100" step="10" value="${curStorage}" oninput="Phone._onMomentsConfigStorageChange(this.value)" style="width:100%">
          <p style="font-size:11px;color:var(--text-secondary);margin:6px 0 0;line-height:1.5">新刷的动态追加在顶部，超出上限时旧动态从尾部自动清理。当前已存 ${curStored} 条。</p>
        </div>
      </div>`;
  }

  async function _toggleMomentsAutoRefresh(checked) {
    const pd = await _getPhoneData();
    if (!pd) return;
    if (!pd.momentsConfig) pd.momentsConfig = {};
    pd.momentsConfig.autoRefresh = !!checked;
    // 开启时重 roll 一个新计数（避免直接命中触发）
    if (checked) {
      pd.npcMomentsAuto = { remaining: _rollAutoRefreshInterval() };
    }
    await _savePhoneData();
  }

  // 拖动条值变化：实时落库（一屏直出风格，没有"取消"按钮）
  async function _onMomentsConfigCountChange(val) {
    const n = Math.max(1, Math.min(8, parseInt(val, 10) || 1));
    const lbl = document.getElementById('mc-count-val');
    if (lbl) lbl.textContent = n + ' 条';
    // 配图上限不能超过动态数
    const imgInput = document.getElementById('mc-img-limit');
    const imgLbl = document.getElementById('mc-img-val');
    if (imgInput) {
      imgInput.max = String(n);
      if (parseInt(imgInput.value, 10) > n) {
        imgInput.value = String(n);
        if (imgLbl) imgLbl.textContent = n + ' 张';
      }
    }
    await _persistMomentsConfig();
  }

  async function _onMomentsConfigImgChange(val) {
    const n = Math.max(0, parseInt(val, 10) || 0);
    const lbl = document.getElementById('mc-img-val');
    if (lbl) lbl.textContent = n + ' 张';
    await _persistMomentsConfig();
  }

  async function _onMomentsConfigStorageChange(val) {
    const n = Math.max(20, Math.min(100, parseInt(val, 10) || 30));
    const lbl = document.getElementById('mc-storage-val');
    if (lbl) lbl.textContent = n + ' 条';
    await _persistMomentsConfig();
    // 调小上限时立即裁剪（防止旧动态卡在尾部）
    const pd = await _getPhoneData();
    if (pd && Array.isArray(pd.npcMoments) && pd.npcMoments.length > n) {
      pd.npcMoments = pd.npcMoments.slice(0, n);
      await _savePhoneData();
    }
  }

  async function _persistMomentsConfig() {
    const pd = await _getPhoneData();
    if (!pd) return;
    const c = Math.max(1, Math.min(8, parseInt(document.getElementById('mc-count')?.value, 10) || 4));
    const ilRaw = parseInt(document.getElementById('mc-img-limit')?.value, 10);
    const smRaw = parseInt(document.getElementById('mc-storage-max')?.value, 10);
    pd.momentsConfig = {
      count: c,
      imageLimit: Math.max(0, Math.min(c, isNaN(ilRaw) ? c : ilRaw)),
      storageMax: Math.max(20, Math.min(100, isNaN(smRaw) ? 30 : smRaw))
    };
    await _savePhoneData();
  }

  // ===== 相机 App =====
let _cameraTab = 'shoot'; // 'shoot' | 'album'

// 把当前状态栏拼成"基础描述"
async function _composeShootText() {
  let sb;
  try { sb = Conversations.getStatusBar() || {}; } catch(_) { sb = {}; }
  // 取玩家面具名，替换"你"为具名，避免发到朋友圈/分享给 AI 时产生歧义
  let playerName = '';
  try { const mask = await Character.get(); playerName = mask?.name || ''; } catch(_) {}
  const youLabel = playerName || '我';
  const lines = [];
  // 场景
  if (sb.scene && String(sb.scene).trim()) lines.push(String(sb.scene).trim());
  // 你（玩家）—— 显示为面具名
  const youParts = [];
  if (sb.playerOutfit && String(sb.playerOutfit).trim()) youParts.push(String(sb.playerOutfit).trim());
  if (sb.playerPosture && String(sb.playerPosture).trim()) youParts.push(String(sb.playerPosture).trim());
  if (youParts.length) lines.push(youLabel + '：' + youParts.join('，'));
  // NPC（全列）
  const npcs = Array.isArray(sb.npcs) ? sb.npcs : [];
  npcs.forEach(n => {
    if (!n || !n.name) return;
    const parts = [];
    if (n.outfit && String(n.outfit).trim()) parts.push(String(n.outfit).trim());
    if (n.posture && String(n.posture).trim()) parts.push(String(n.posture).trim());
    if (parts.length) lines.push(String(n.name) + '：' + parts.join('，'));
  });
   return lines.join('\n');
 }

// ============ 聊天 App（v689）============
let _chatTab = 'threads'; // 'threads' | 'contacts'
let _chatCurContactId = null;
let _chatAvatarMap = {}; // name -> 最新头像（渲染时优先用，保证改头像后同步）

// 刷新最新头像 map（按联系人名匹配当前世界观/卡/世界书/挂载的最新头像）
async function _refreshChatAvatarMap() {
  const map = {};
  try {
    (await _collectChatCandidates()).forEach(c => { if (c.name) map[c.name] = c.avatar || ''; });
  } catch(_) {}
  _chatAvatarMap = map;
}

// 取联系人当前应显示的头像：最新 map 优先，取不到用存的快照
function _chatContactAvatar(contact) {
  if (!contact) return '';
  const fresh = _chatAvatarMap[contact.name];
  if (fresh !== undefined && fresh !== '') return fresh;
  return contact.avatar || '';
}

// 收集可用联系人来源（世界观NPC + 单人卡 + 挂载角色），返回 [{name, source, avatar}]
async function _collectChatCandidates() {
  const out = [];
  const seen = new Set();
  // 头像表（按 NPC id 索引）
  let avatarById = {};
  try {
    const rows = await DB.getAll('npcAvatars');
    rows.forEach(a => { if (a && a.id) avatarById[a.id] = a.avatar || ''; });
  } catch(_) {}
  const add = (name, source, avatar, detail, aliases, onlineName) => {
    const nm = (name || '').trim();
    if (!nm || seen.has(nm)) return;
    seen.add(nm);
    out.push({ name: nm, source, avatar: avatar || '', detail: (detail || '').trim(), aliases: (aliases || '').trim(), onlineName: (onlineName || '').trim() });
  };
  // 拼一个 NPC/角色对象的人设描述文本
  const _detailOf = (o) => {
    if (!o) return '';
    const segs = [];
    if (o.aliases) segs.push('别名：' + o.aliases);
    if (o.onlineName) segs.push('网名：' + o.onlineName);
    if (o.identity) segs.push('身份：' + o.identity);
    if (o.personality) segs.push('性格：' + o.personality);
    if (o.appearance) segs.push('外貌：' + o.appearance);
    if (o.background) segs.push('背景：' + o.background);
    if (o.description) segs.push(o.description);
    if (o.setting) segs.push(o.setting);
    if (o.detail) segs.push(o.detail);
    if (o.relationship) segs.push('关系：' + o.relationship);
    return segs.join('\n');
  };
  try {
    const convId = Conversations.getCurrent();
    const conv = Conversations.getList().find(c => c.id === convId);
    const wvId = conv?.worldviewId || conv?.singleWorldviewId;
    if (wvId) {
      const wv = await DB.get('worldviews', wvId);
      if (wv) {
        (wv.globalNpcs || []).forEach(n => add(n.name, 'worldview', avatarById[n.id] || n.avatar || '', _detailOf(n), n.aliases || '', n.onlineName || ''));
        (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(n => add(n.name, 'worldview', avatarById[n.id] || n.avatar || '', _detailOf(n), n.aliases || '', n.onlineName || ''))));
      }
    }
    // 单人卡（卡本身作为联系人）
    if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
      try {
        const card = await DB.get('singleCards', conv.singleCharId);
        let scAvatar = avatarById[conv.singleCharId] || card?.avatar || '';
        if (card?.name) add(card.name, 'single', scAvatar, _detailOf(card));
      } catch(_) {}
    }
    // 当前对话绑定的世界书 NPC
    try {
      if (typeof Lorebook !== 'undefined' && Lorebook.collectForChat) {
        let card = null;
        if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
          try { card = await DB.get('singleCards', conv.singleCharId); } catch(_) {}
        }
        const wv2 = wvId ? await DB.get('worldviews', wvId) : null;
        const lbs = await Lorebook.collectForChat({ conv, card, wv: wv2 });
        for (const lb of (lbs || [])) {
          (lb.globalNpcs || []).forEach(n => add(n.name, 'lorebook', avatarById[n.id] || n.avatar || '', _detailOf(n)));
        }
      }
    } catch(_) {}
    // 挂载角色
    try {
      if (typeof AttachedChars !== 'undefined' && AttachedChars.resolveAll) {
        const attached = await AttachedChars.resolveAll();
        attached.forEach(c => add(c.name, 'mount', (c.id && avatarById[c.id]) || c.avatar || '', _detailOf(c)));
      }
    } catch(_) {}
  } catch(_) {}
  return out;
}

function _chatSourceLabel(s) {
  return s === 'single' ? '主角色' : (s === 'mount' ? '常驻' : (s === 'lorebook' ? '世界书' : '世界观'));
}

function _renderChatApp(pd) {
  const body = document.getElementById('phone-body');
  document.getElementById('phone-title').textContent = '聊天';
  _applyWallpaper(pd);
  _chatCurContactId = null;
  // 先用旧头像渲染，再异步刷新最新头像 map 后重绘
  const threadsHtml = _renderChatThreadList(pd);
  const contactsHtml = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:13px">加载中…</div>';
  body.innerHTML = `
    <div class="phone-chat-shell" style="display:flex;flex-direction:column;height:100%">
      <div id="phone-chat-threads" class="phone-chat-page" style="display:${_chatTab === 'threads' ? 'flex' : 'none'};flex-direction:column;flex:1;min-height:0;overflow-y:auto">${threadsHtml}</div>
      <div id="phone-chat-contacts" class="phone-chat-page" style="display:${_chatTab === 'contacts' ? 'flex' : 'none'};flex-direction:column;flex:1;min-height:0;overflow-y:auto">${contactsHtml}</div>
      <div class="phone-tabbar">
        <div class="phone-tab ${_chatTab === 'threads' ? 'active' : ''}" onclick="Phone._switchChatTab('threads')">聊天</div>
        <div class="phone-tab ${_chatTab === 'contacts' ? 'active' : ''}" onclick="Phone._switchChatTab('contacts')">联系人</div>
      </div>
    </div>
  `;
  if (_chatTab === 'contacts') _hydrateChatContacts(pd);
  // 进 app 自动从主线收录新气泡，刷新最新头像，收完刷新聊天列表
  (async () => {
    try {
      await _refreshChatAvatarMap();
      let messages = (typeof Chat !== 'undefined' && Chat.getMessages) ? (Chat.getMessages() || []) : [];
      await _ingestChatFromMessages(messages);
      if (_isAppStillActive && _isAppStillActive('chat')) {
        const pd2 = await _getPhoneData();
        const el = document.getElementById('phone-chat-threads');
        if (el && pd2) el.innerHTML = _renderChatThreadList(pd2);
        if (_chatTab === 'contacts' && pd2) _hydrateChatContacts(pd2);
      }
    } catch(_) {}
  })();
}

function _switchChatTab(tab) {
  _chatTab = tab;
  const t = document.getElementById('phone-chat-threads');
  const c = document.getElementById('phone-chat-contacts');
  if (t) t.style.display = tab === 'threads' ? 'flex' : 'none';
  if (c) c.style.display = tab === 'contacts' ? 'flex' : 'none';
  document.querySelectorAll('.phone-chat-shell .phone-tab').forEach((el, i) => {
    el.classList.toggle('active', (i === 0 && tab === 'threads') || (i === 1 && tab === 'contacts'));
  });
  if (tab === 'contacts') _getPhoneData().then(pd => _hydrateChatContacts(pd));
}

// 聊天列表（已有会话的联系人）
function _renderChatThreadList(pd) {
  const contacts = pd.chatContacts || [];
  const threads = pd.chatThreads || {};
  const withMsg = contacts.filter(c => (threads[c.id] || []).length > 0);
  if (!withMsg.length) {
    return '<div style="padding:40px 24px;text-align:center;color:var(--text-secondary);font-size:13px;line-height:1.8">还没有聊天记录<br><span style="font-size:11px">去「联系人」添加，或在聊天里收录主线消息</span></div>';
  }
  return withMsg.map(c => {
    const msgs = threads[c.id] || [];
    const last = msgs[msgs.length - 1];
    const preview = last ? Utils.escapeHtml((last.text || '').slice(0, 24)) : '';
    const displayName = c.nickname || c.name;
    const initial = Utils.escapeHtml((displayName || '?')[0]);
    const avaUrl = _chatContactAvatar(c);
    const avatar = avaUrl
      ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`
      : initial;
    return `<div class="phone-chat-thread-item" onclick="Phone._openChatThread('${c.id}')" style="display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer">
      <div style="width:46px;height:46px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;overflow:hidden">${avatar}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:2px">${Utils.escapeHtml(displayName)}</div>
        <div style="font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${preview}</div>
      </div>
    </div>`;
  }).join('');
}

// 联系人 tab（异步加载候选）
let _chatCandidatesCache = [];
async function _hydrateChatContacts(pd) {
  const box = document.getElementById('phone-chat-contacts');
  if (!box) return;
  const candidates = await _collectChatCandidates();
  _chatCandidatesCache = candidates;
  candidates.forEach(cc => { if (cc.name) _chatAvatarMap[cc.name] = cc.avatar || ''; });
  const added = pd.chatContacts || [];
  const addedNames = new Set(added.map(c => c.name));
  let html = '';
  // 已添加的联系人
  if (added.length) {
    html += '<div style="padding:10px 16px 4px;font-size:11px;color:var(--text-secondary)">已添加</div>';
    html += added.map(c => {
      const displayName = c.nickname || c.name;
      const initial = Utils.escapeHtml((displayName || '?')[0]);
      const avaUrl = _chatContactAvatar(c);
      const avatar = avaUrl ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">` : initial;
      return `<div class="phone-chat-contact-item" onclick="Phone._openChatThread('${c.id}')" style="display:flex;align-items:center;gap:12px;padding:10px 16px;cursor:pointer">
        <div style="width:40px;height:40px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;overflow:hidden">${avatar}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--text)">${Utils.escapeHtml(displayName)}</div>
          <div style="font-size:11px;color:var(--text-secondary)">${_chatSourceLabel(c.source)}</div>
        </div>
      </div>`;
    }).join('');
  }

  // 可添加的候选
  const toAdd = candidates.map((c, i) => ({ c, i })).filter(({ c }) => !addedNames.has(c.name));
  if (toAdd.length) {
    html += '<div style="padding:14px 16px 4px;font-size:11px;color:var(--text-secondary)">可添加</div>';
    html += toAdd.map(({ c, i }) => {
      const initial = Utils.escapeHtml((c.name || '?')[0]);
      const avatar = c.avatar ? `<img src="${Utils.escapeHtml(c.avatar)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">` : initial;
      return `<div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border)">
        <div style="width:40px;height:40px;border-radius:50%;flex-shrink:0;background:var(--bg-tertiary);color:var(--text-secondary);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;overflow:hidden">${avatar}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--text)">${Utils.escapeHtml(c.name)}</div>
          <div style="font-size:11px;color:var(--text-secondary)">${_chatSourceLabel(c.source)}</div>
        </div>
        <button onclick="Phone._addChatContactByIdx(${i})" style="padding:5px 14px;font-size:12px;background:var(--accent);color:#fff;border:none;border-radius:14px;cursor:pointer;flex-shrink:0">添加</button>
      </div>`;
    }).join('');
  }
  if (!html) html = '<div style="padding:40px 24px;text-align:center;color:var(--text-secondary);font-size:13px">当前世界观没有可添加的角色</div>';
  box.innerHTML = html;
}

async function _addChatContactByIdx(idx) {
  const c = _chatCandidatesCache[idx];
  if (!c) return;
  await _addChatContact(c.name, c.source, c.avatar);
}

async function _addChatContact(name, source, avatar) {
  const pd = await _getPhoneData();
  if (!pd) return;
  if (!Array.isArray(pd.chatContacts)) pd.chatContacts = [];
  if (pd.chatContacts.some(c => c.name === name)) { UI.showToast('已经添加过了', 1200); return; }
  const id = 'ct_' + Utils.uuid().slice(0, 8);
  pd.chatContacts.push({ id, name, source, avatar: avatar || '', sig: '' });
  if (!pd.chatThreads) pd.chatThreads = {};
  if (!pd.chatThreads[id]) pd.chatThreads[id] = [];
  await _savePhoneData();
  UI.showToast('已添加 ' + name, 1200);
  _hydrateChatContacts(pd);
}

// 打开聊天详情
async function _openChatThread(contactId) {
  const pd = await _getPhoneData();
  if (!pd) return;
  const contact = (pd.chatContacts || []).find(c => c.id === contactId);
  if (!contact) { UI.showToast('联系人不存在', 1200); return; }
  _chatCurContactId = contactId;
  try { await _refreshChatAvatarMap(); } catch(_) {}
  _pushNav(() => _renderChatThread(pd, contactId));
  _renderChatThread(pd, contactId);
}

function _renderChatThread(pd, contactId) {
  const body = document.getElementById('phone-body');
  const contact = (pd.chatContacts || []).find(c => c.id === contactId);
  if (!contact) return;
  document.getElementById('phone-title').textContent = contact.nickname || contact.name;
  const msgs = (pd.chatThreads && pd.chatThreads[contactId]) || [];
  const initial = Utils.escapeHtml((contact.name || '?')[0]);
  const avaUrl = _chatContactAvatar(contact);
  const avatarInner = avaUrl
    ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`
    : initial;
  // me 头像：当前面具头像
  let meAvaUrl = '';
  try { meAvaUrl = (typeof Character !== 'undefined' && Character.getAvatar) ? (Character.getAvatar() || '') : ''; } catch(_) {}
  let meName = '我';
  try { const mk = (typeof Character !== 'undefined' && Character.get) ? Character.get() : null; if (mk?.name) meName = mk.name; } catch(_) {}
  const meInitial = Utils.escapeHtml((meName || '我')[0]);
  const meAvatarInner = meAvaUrl
    ? `<img src="${Utils.escapeHtml(meAvaUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`
    : meInitial;
  const bubbles = msgs.length
    ? msgs.map(m => {
        // system role：撤回/提示（居中灰条，不加头像不加气泡框）
        if (m.role === 'system') {
          return `<div style="display:flex;justify-content:center;margin:4px 0 12px">
            <div style="font-size:12px;color:var(--text-secondary);background:var(--bg-tertiary);padding:3px 12px;border-radius:20px">${Utils.escapeHtml(m.text || '')}</div>
          </div>`;
        }
        const mine = m.role === 'me';
        const time = m.time ? `<div style="font-size:10px;color:var(--text-secondary);margin-top:2px">${Utils.escapeHtml(m.time)}</div>` : '';
        
        // 语音气泡
        if (m.type === 'voice') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="voice" style="cursor:pointer${mine ? ';align-items:flex-end' : ';align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0;max-width:70%">
              <div onclick="Phone._playVoice('${m.id}')" style="padding:10px 14px;border-radius:18px;background:${mine ? 'var(--accent);color:#fff' : 'var(--bg-tertiary);color:var(--text)'};display:flex;align-items:center;gap:10px;min-width:100px;cursor:pointer;${mine ? 'flex-direction:row-reverse' : ''}">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
                <div class="phone-chat-voice-wave" id="voice-wave-${m.id}" style="display:flex;align-items:center;gap:3px;opacity:0.7">
                  <div style="width:3px;height:4px;background:currentColor;border-radius:2px"></div>
                  <div style="width:3px;height:8px;background:currentColor;border-radius:2px"></div>
                  <div style="width:3px;height:12px;background:currentColor;border-radius:2px"></div>
                  <div style="width:3px;height:8px;background:currentColor;border-radius:2px"></div>
                  <div style="width:3px;height:5px;background:currentColor;border-radius:2px"></div>
                </div>
              </div>
              <div style="margin-top:4px;padding:6px 10px;border-radius:8px;background:var(--bg-tertiary);color:var(--text-secondary);font-size:12px;max-width:100%;word-break:break-word">${Utils.escapeHtml(m.voiceDesc || '')}</div>
              ${time}
            </div>
          </div>`;
        }

        // 转账气泡
        if (m.type === 'transfer') {
          const transferTitle = `向${Utils.escapeHtml(contact.nickname || contact.name)}转账`;
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="transfer" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="width:240px;border-radius:12px;overflow:hidden;border:1px solid var(--border);background:var(--bg-secondary)">
                <div style="background:linear-gradient(135deg,var(--accent),#e8a040);padding:12px 14px;display:flex;align-items:center;gap:8px">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
                  <span style="font-size:13px;font-weight:600;color:#fff">${transferTitle}</span>
                </div>
                <div style="padding:14px">
                  <div style="font-size:20px;font-weight:700;color:var(--text)">${Utils.escapeHtml(String(m.transferAmount || 0))} <span style="font-size:13px;font-weight:400;color:var(--text-secondary)">${Utils.escapeHtml(m.transferCurrency || '')}</span></div>
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        // 位置气泡
        if (m.type === 'location') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="location" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div onclick="Phone._showChatLocationDetail('${Utils.escapeHtml(m.location || '')}','${Utils.escapeHtml(m.address || '')}')" style="width:200px;border-radius:14px;overflow:hidden;cursor:pointer;background:var(--bg-tertiary)">
                <div style="padding:12px 14px 8px;display:flex;align-items:center;gap:10px">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                  <div style="min-width:0">
                    <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(m.location || '位置')}</div>
                    <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(m.address || '')}</div>
                  </div>
                </div>
                <div style="height:56px;background:linear-gradient(135deg,var(--accent-dim,#c8d8f0) 0%,var(--bg-secondary,#e8edf5) 100%);display:flex;align-items:center;justify-content:center;opacity:0.7">
                  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.5"><path d="M3 3h18M3 9h18M3 15h18M3 21h18M9 3v18M15 3v18"/></svg>
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        // 订单气泡
        if (m.type === 'order') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="order" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="width:210px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
                <div style="padding:10px 14px 8px;display:flex;align-items:center;gap:8px">
                  <svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='var(--accent)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z'/><line x1='3' x2='21' y1='6' y2='6'/><path d='M16 10a4 4 0 0 1-8 0'/></svg>
                  <div style="flex:1;min-width:0">
                    <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.orderName || '订单')}</div>
                    ${m.orderShop ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.orderShop)}</div>` : ''}
                  </div>
                  ${m.orderPrice ? `<span style="font-size:13px;font-weight:700;color:var(--accent);flex-shrink:0">¥${Utils.escapeHtml(String(m.orderPrice))}</span>` : ''}
                </div>
                <div style="padding:5px 14px 10px;border-top:1px solid var(--border);display:flex;align-items:center;gap:6px">
                  <span style="font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--text-secondary)">${Utils.escapeHtml(m.orderPlatform || '')}</span>
                  <span style="font-size:10px;color:var(--text-secondary)">已购</span>
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        // 订单气泡
    if (m.type === 'order') {
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="order" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
          <div style="width:210px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
            <div style="padding:10px 14px 8px;display:flex;align-items:center;gap:8px">
              <svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='var(--accent)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z'/><line x1='3' x2='21' y1='6' y2='6'/><path d='M16 10a4 4 0 0 1-8 0'/></svg>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.orderName || '订单')}</div>
                ${m.orderShop ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.orderShop)}</div>` : ''}
              </div>
              ${m.orderPrice ? `<span style="font-size:13px;font-weight:700;color:var(--accent);flex-shrink:0">¥${Utils.escapeHtml(String(m.orderPrice))}</span>` : ''}
            </div>
            <div style="padding:5px 14px 10px;border-top:1px solid var(--border);display:flex;align-items:center;gap:6px">
              <span style="font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--text-secondary)">${Utils.escapeHtml(m.orderPlatform || '')}</span>
              <span style="font-size:10px;color:var(--text-secondary)">已购</span>
            </div>
          </div>
          ${time}
        </div>
      </div>`;
    }

    // 地点链接气泡
        if (m.type === 'map_place') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="map_place" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="width:200px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
                <div style="height:52px;background:linear-gradient(135deg,var(--accent-dim,#c8d8f0) 0%,var(--bg-secondary,#e8edf5) 100%);display:flex;align-items:center;justify-content:center;opacity:0.8">
                  <svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24' fill='var(--accent)' stroke='none'><path d='M12 2a8 8 0 0 0-8 8c0 5.4 7.05 11.5 7.35 11.76a1 1 0 0 0 1.3 0C12.95 21.5 20 15.4 20 10a8 8 0 0 0-8-8Zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z'/></svg>
                </div>
                <div style="padding:10px 12px 10px">
                  <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.placeName || '地点')}</div>
                  ${m.placeAddress ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.placeAddress)}</div>` : ''}
                  ${m.placeDesc ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.placeDesc)}</div>` : ''}
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        // 商品卡片气泡
        if (m.type === 'product') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="product" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="width:210px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
                <div style="padding:12px 14px 10px;display:flex;gap:10px;align-items:flex-start">
                  <div style="width:44px;height:44px;border-radius:8px;background:var(--bg-secondary,#eee);flex-shrink:0;display:flex;align-items:center;justify-content:center">
                    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" x2="21" y1="6" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
                  </div>
                  <div style="flex:1;min-width:0">
                    <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${Utils.escapeHtml(m.productName || '商品')}</div>
                    ${m.productPrice ? `<div style="font-size:14px;font-weight:700;color:var(--accent);margin-top:4px">¥${Utils.escapeHtml(String(m.productPrice))}</div>` : ''}
                  </div>
                </div>
                <div style="padding:6px 14px 10px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
                  <span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(m.productPlatform || '')}</span>
                  ${m.productShop ? `<span style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px">${Utils.escapeHtml(m.productShop)}</span>` : ''}
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        // 论坛帖子气泡（摘要截图 / 详情链接）
        if (m.type === 'forum_card' || m.type === 'forum_detail') {
          const isDetail = m.type === 'forum_detail';
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="${m.type}" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="width:220px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
                <div style="padding:12px 14px 10px">
                  <div style="font-size:11px;color:var(--accent);margin-bottom:6px;display:flex;align-items:center;gap:4px">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    ${Utils.escapeHtml(m.forumPlatform || '论坛')} · ${isDetail ? '帖子详情' : '帖子摘要'}
                  </div>
                  <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${Utils.escapeHtml(m.forumTitle || '帖子')}</div>
                  ${m.forumSummary && !isDetail ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${Utils.escapeHtml(m.forumSummary)}</div>` : ''}
                </div>
                <div style="padding:6px 14px 10px;border-top:1px solid var(--border)">
                  <span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(m.forumAuthor || '匿名')}</span>
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        // 图片气泡（相册照片 / 本地真图）
        if (m.type === 'photo' || m.type === 'real_image') {
          const isAiImage = m.mode === 'ai_image' && m.imageId;
          const isRealImage = m.type === 'real_image' && m.imageBase64;
          const innerHtml = isRealImage
            ? `<img src="${Utils.escapeHtml(m.imageBase64)}" style="width:100%;height:100%;object-fit:cover;border-radius:4px" />`
            : isAiImage
              ? `<img class="phone-camera-polaroid-img" data-img-id="${Utils.escapeHtml(m.imageId)}" alt="生成的图片" />`
              : `<div class="phone-camera-polaroid-content">${Utils.escapeHtml(m.photoDesc || '(空)')}</div>`;
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="photo" style="cursor:pointer${mine ? ';align-items:flex-end' : ';align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div class="phone-camera-polaroid" onclick="Phone._showChatPhotoDetail('${contactId}', '${m.id}')" style="opacity:1;margin:0;width:150px;min-height:150px;transform:none;cursor:pointer">
                <div class="phone-camera-polaroid-frame" style="padding:8px 8px 28px">${innerHtml}</div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" style="cursor:pointer${mine ? ';align-items:flex-end' : ';align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
          <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
          <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
            <div style="max-width:100%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.5;background:${mine ? 'var(--accent);color:#fff' : 'var(--bg-tertiary);color:var(--text)'};word-break:break-word">${Utils.escapeHtml(m.text || '')}</div>
            ${time}
          </div>
        </div>`;
      }).join('')
    : '<div style="padding:40px 24px;text-align:center;color:var(--text-secondary);font-size:13px;line-height:1.8">还没有消息<br><span style="font-size:11px">下方输入框发消息，点刷新让对方回复</span></div>';
  // 刷新按钮注入右上角
  const headerRight = document.getElementById('phone-header-right');
  if (headerRight) {
    headerRight.innerHTML = `
    <button id="phone-chat-refresh-btn" onclick="Phone._chatRequestReply('${contactId}')" title="让对方回复" style="width:36px;height:36px;background:none;border:none;color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:0">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
    </button>
    <button onclick="Phone._openChatSettings('${contactId}')" title="聊天设置" style="width:36px;height:36px;background:none;border:none;color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:0">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
    </button>
  `;
  }

  body.innerHTML = `
    <div class="phone-chat-thread" style="display:flex;flex-direction:column;height:100%">
      <div id="phone-chat-msglist" onclick="Phone._closeChatPlusMenu()" style="flex:1;min-height:0;overflow-y:auto;padding:14px 14px 8px">${bubbles}</div>
<div style="flex-shrink:0;padding:8px 10px;display:flex;gap:8px;align-items:center">
        <button id="phone-chat-plus-btn" onclick="Phone._toggleChatPlusMenu()" title="更多" style="flex-shrink:0;width:34px;height:34px;background:none;border:none;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:0">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:24px;height:24px"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 9a.75.75 0 0 0-1.5 0v2.25H9a.75.75 0 0 0 0 1.5h2.25V15a.75.75 0 0 0 1.5 0v-2.25H15a.75.75 0 0 0 0-1.5h-2.25V9Z" clip-rule="evenodd" /></svg>
        </button>
        <input id="phone-chat-input" type="text" placeholder="输入消息…" onkeydown="if(event.key==='Enter'){Phone._chatDoSend('${contactId}')}" oninput="Phone._onChatInput()" style="flex:1;min-width:0;padding:9px 12px;font-size:14px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:10px;outline:none">
        <button id="phone-chat-send-btn" onclick="Phone._chatDoSend('${contactId}')" title="发送" style="flex-shrink:0;width:34px;height:34px;background:var(--accent);color:#fff;border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:0;box-shadow:0 2px 4px var(--accent-dim)">
          <svg id="phone-chat-send-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
         </button>
       </div>
       <div id="phone-chat-plus-menu" class="hidden" style="flex-shrink:0;background:transparent;padding:16px 20px;display:grid;grid-template-columns:repeat(4, 1fr);gap:16px 12px">
<!-- 图片 -->
        <button class="phone-plus-item" onclick="Phone._openImagePickerForChat('${contactId}')" style="display:flex;flex-direction:column;align-items:center;gap:6px;background:none;border:none;padding:0;cursor:pointer">
          <div style="width:50px;height:50px;border-radius:14px;background:var(--bg-tertiary);color:var(--text);display:flex;align-items:center;justify-content:center">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
          </div>
          <span style="font-size:11px;color:var(--text-secondary)">图片</span>
        </button>
        <!-- 相册 -->
        <button class="phone-plus-item" onclick="Phone._openAlbumPickerForChat('${contactId}')" style="display:flex;flex-direction:column;align-items:center;gap:6px;background:none;border:none;padding:0;cursor:pointer">
          <div style="width:50px;height:50px;border-radius:14px;background:var(--bg-tertiary);color:var(--text);display:flex;align-items:center;justify-content:center">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2.5"></rect><rect x="6" y="15" width="12" height="4" rx="0.5"></rect><circle cx="12" cy="10.5" r="3"></circle><circle cx="12" cy="10.5" r="1"></circle><circle cx="17.5" cy="7.8" r="0.6"></circle></svg>
          </div>
          <span style="font-size:11px;color:var(--text-secondary)">相册</span>
        </button>
<!-- 语音 -->
         <button class="phone-plus-item" onclick="Phone._toggleChatVoiceMode('${contactId}')" style="display:flex;flex-direction:column;align-items:center;gap:6px;background:none;border:none;padding:0;cursor:pointer">
          <div style="width:50px;height:50px;border-radius:14px;background:var(--bg-tertiary);color:var(--text);display:flex;align-items:center;justify-content:center">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
          </div>
          <span style="font-size:11px;color:var(--text-secondary)">语音</span>
        </button>
        <!-- 位置 -->
         <button class="phone-plus-item" onclick="Phone._openChatLocationPicker('${contactId}')" style="display:flex;flex-direction:column;align-items:center;gap:6px;background:none;border:none;padding:0;cursor:pointer">
           <div style="width:50px;height:50px;border-radius:14px;background:var(--bg-tertiary);color:var(--text);display:flex;align-items:center;justify-content:center">
             <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
           </div>
           <span style="font-size:11px;color:var(--text-secondary)">位置</span>
         </button>
<!-- 订单 -->
         <button class="phone-plus-item" onclick="Phone._openChatOrderPicker('${contactId}')" style="display:flex;flex-direction:column;align-items:center;gap:6px;background:none;border:none;padding:0;cursor:pointer">
           <div style="width:50px;height:50px;border-radius:14px;background:var(--bg-tertiary);color:var(--text);display:flex;align-items:center;justify-content:center">
             <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
           </div>
           <span style="font-size:11px;color:var(--text-secondary)">订单</span>
         </button>
        <!-- 转账 -->
        <button class="phone-plus-item" onclick="Phone._openChatTransfer('${contactId}')" style="display:flex;flex-direction:column;align-items:center;gap:6px;background:none;border:none;padding:0;cursor:pointer">
          <div style="width:50px;height:50px;border-radius:14px;background:var(--bg-tertiary);color:var(--text);display:flex;align-items:center;justify-content:center">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
          </div>
          <span style="font-size:11px;color:var(--text-secondary)">转账</span>
        </button>
      </div>
    </div>
  `;
  const list = document.getElementById('phone-chat-msglist');
  if (list) list.scrollTop = list.scrollHeight;
  // 绑定长按事件
  _bindChatThreadEvents(contactId);
}

let _voicePlayTimers = {};
async function _playVoice(msgId) {
  const waveEl = document.getElementById('voice-wave-' + msgId);

  // 如果 TTS 可用且当前联系人开启了角色语音，走 TTS
  if (typeof TTS !== 'undefined' && _chatCurContactId) {
    try {
      const pd = await _getPhoneData();
      const contact = (pd.chatContacts || []).find(c => c.id === _chatCurContactId);
      if (contact && contact.voiceEnabled) {
        const thread = (pd.chatThreads && pd.chatThreads[_chatCurContactId]) || [];
        const msg = thread.find(m => m.id === msgId);
        // 用户自己发的语音不播放
        if (msg && msg.role === 'me') return;
        const raw = (msg && (msg.voiceDesc || msg.text)) || '';
        const speakText = raw.replace(/^\[语音\]/, '').trim();
        if (!speakText) { UI.showToast('没有可播放的内容', 1200); return; }

        // 正在播放同一条 → 停止
        if (TTS.isPlaying(msgId)) {
          TTS.stop();
          if (waveEl) waveEl.classList.remove('playing');
          return;
        }
        // 停掉上一条
        TTS.stop();

        if (waveEl) waveEl.classList.add('playing');
        try {
          await TTS.speak(speakText, {
            msgId,
            voiceId: contact.voiceId || undefined,
          });
        } catch(e) {
          UI.showToast('语音播放失败：' + (e.message || '未知'), 2000);
        } finally {
          if (waveEl) waveEl.classList.remove('playing');
        }
        return;
      }
    } catch(_) {}
  }

  // fallback：纯动画模拟（无 TTS 或未开启角色语音），用户气泡不播放
  try {
    const pd = await _getPhoneData();
    const thread = (pd.chatThreads && pd.chatThreads[_chatCurContactId]) || [];
    const msg = thread.find(m => m.id === msgId);
    if (msg && msg.role === 'me') return;
  } catch(_) {}

  if (_voicePlayTimers[msgId]) {
    clearTimeout(_voicePlayTimers[msgId]);
    delete _voicePlayTimers[msgId];
    if (waveEl) waveEl.classList.remove('playing');
    return;
  }
  if (waveEl) waveEl.classList.add('playing');
  _voicePlayTimers[msgId] = setTimeout(() => {
    if (waveEl) waveEl.classList.remove('playing');
    delete _voicePlayTimers[msgId];
  }, 2000);
}

// 绑定手机聊天气泡长按事件
function _bindChatThreadEvents(contactId) {
  const list = document.getElementById('phone-chat-msglist');
  if (!list) return;
  
  let pressTarget = null, pressTimer = null;
  const cancelPress = () => {
    if (pressTimer) clearTimeout(pressTimer);
    if (pressTarget) pressTarget.style.opacity = '1';
    pressTarget = null;
    pressTimer = null;
  };

  list.addEventListener('touchstart', (e) => {
    const bubble = e.target.closest('.phone-chat-msg-bubble');
    if (!bubble) return;
    pressTarget = bubble;
    bubble.style.opacity = '0.6';
    pressTimer = setTimeout(() => {
      _showChatBubbleMenu(contactId, bubble.dataset.msgId, bubble.dataset.role);
      cancelPress();
    }, 500);
  }, { passive: true });

  list.addEventListener('touchend', cancelPress);
  list.addEventListener('touchmove', cancelPress);

  // 桌面右键
  list.addEventListener('contextmenu', (e) => {
    const bubble = e.target.closest('.phone-chat-msg-bubble');
    if (!bubble) return;
    e.preventDefault();
    _showChatBubbleMenu(contactId, bubble.dataset.msgId, bubble.dataset.role);
  });
}

// 显示气泡长按菜单
async function _showChatBubbleMenu(contactId, msgId, role) {
  const pd = await _getPhoneData();
  if (!pd?.chatThreads?.[contactId]) return;
  const thread = pd.chatThreads[contactId];
  const msg = thread.find(m => m.id === msgId);
  if (!msg) return;

  let actions = [];
  if (msg.type === 'photo') {
    actions = ['删除'];
  } else if (role === 'me') {
    actions = ['编辑', '撤回'];
  } else {
    actions = ['编辑', '删除'];
  }

  const choice = await _showActionMenu(actions);
  if (choice === '编辑') {
    const newText = await UI.showSimpleInput('编辑消息', msg.text || '');
    if (newText !== null && newText !== msg.text) {
      msg.text = newText;
      await _savePhoneData();
      _renderChatThread(pd, contactId);
    }
  } else if (choice === '撤回') {
    // me 气泡撤回：删除消息，在末尾插入灰条提示
    const idx = thread.findIndex(m => m.id === msgId);
    if (idx >= 0) {
      thread.splice(idx, 1);
      thread.push({
        id: 'm_' + Utils.uuid().slice(0, 8),
        role: 'system',
        text: '你撤回了一条消息',
        time: '',
        fromMainline: false,
      });
      await _savePhoneData();
      _renderChatThread(pd, contactId);
    }
  } else if (choice === '删除') {
    // 气泡删除：直接移除（不论是我发出的图片还是对方的气泡）
    const idx = thread.findIndex(m => m.id === msgId);
    if (idx >= 0) {
      thread.splice(idx, 1);
      await _savePhoneData();
      _renderChatThread(pd, contactId);
    }
  }
}

// 轻量级菜单：在顶部显示操作列表（简单实现：用弹窗）
async function _showActionMenu(actions) {
  if (!actions || !actions.length) return null;
  return new Promise(resolve => {
    const menu = document.createElement('div');
    menu.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
      background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);
      border-radius:12px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.15);
      min-width:160px;padding:0`;
    menu.innerHTML = actions.map((a, i) => 
      `<div style="padding:12px 16px;border-bottom:${i < actions.length - 1 ? '1px solid var(--border)' : 'none'};
        cursor:pointer;text-align:center;font-size:14px">${a}</div>`
    ).join('');
    
    const items = menu.querySelectorAll('div');
    items.forEach((item, i) => {
      item.onclick = () => {
        document.body.removeChild(menu);
        document.body.removeChild(mask);
        resolve(actions[i]);
      };
    });

    const mask = document.createElement('div');
    mask.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;z-index:9998;background:rgba(0,0,0,0.3)`;
    mask.onclick = () => {
      document.body.removeChild(menu);
      document.body.removeChild(mask);
      resolve(null);
    };

    document.body.appendChild(mask);
    document.body.appendChild(menu);
  });
}

// 重绘气泡时的 system role 处理（撤回提示等）
function _renderChatThreadWithSystem(pd, contactId) {
  const body = document.getElementById('phone-body');
  const contact = (pd.chatContacts || []).find(c => c.id === contactId);
  if (!contact) return;
  const msgs = (pd.chatThreads && pd.chatThreads[contactId]) || [];
  const initial = Utils.escapeHtml((contact.name || '?')[0]);
  const avaUrl = _chatContactAvatar(contact);
  const avatarInner = avaUrl
    ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`
    : initial;
  let meAvaUrl = '';
  try { meAvaUrl = (typeof Character !== 'undefined' && Character.getAvatar) ? (Character.getAvatar() || '') : ''; } catch(_) {}
  let meName = '我';
  try { const mk = (typeof Character !== 'undefined' && Character.get) ? Character.get() : null; if (mk?.name) meName = mk.name; } catch(_) {}
  const meInitial = Utils.escapeHtml((meName || '我')[0]);
  const meAvatarInner = meAvaUrl
    ? `<img src="${Utils.escapeHtml(meAvaUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`
    : meInitial;

  const bubbles = msgs.map(m => {
    // system role：撤回/提示消息
    if (m.role === 'system') {
      return `<div style="display:flex;justify-content:center;margin:8px 0">
        <div style="font-size:12px;color:var(--text-secondary);text-align:center">${Utils.escapeHtml(m.text || '')}</div>
      </div>`;
    }

    const mine = m.role === 'me';
    const time = m.time ? `<div style="font-size:10px;color:var(--text-secondary);margin-top:2px">${Utils.escapeHtml(m.time)}</div>` : '';
    
    // 语音气泡
    if (m.type === 'voice') {
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="voice" style="cursor:pointer${mine ? ';align-items:flex-end' : ';align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0;max-width:70%">
          <div onclick="Phone._playVoice('${m.id}')" style="padding:10px 14px;border-radius:18px;background:${mine ? 'var(--accent);color:#fff' : 'var(--bg-tertiary);color:var(--text)'};display:flex;align-items:center;gap:10px;min-width:100px;cursor:pointer;${mine ? 'flex-direction:row-reverse' : ''}">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
            <div class="phone-chat-voice-wave" id="voice-wave-${m.id}" style="display:flex;align-items:center;gap:3px;opacity:0.7">
              <div style="width:3px;height:4px;background:currentColor;border-radius:2px"></div>
              <div style="width:3px;height:8px;background:currentColor;border-radius:2px"></div>
              <div style="width:3px;height:12px;background:currentColor;border-radius:2px"></div>
              <div style="width:3px;height:8px;background:currentColor;border-radius:2px"></div>
              <div style="width:3px;height:5px;background:currentColor;border-radius:2px"></div>
            </div>
          </div>
          <div style="margin-top:4px;padding:6px 10px;border-radius:8px;background:var(--bg-tertiary);color:var(--text-secondary);font-size:12px;max-width:100%;word-break:break-word">${Utils.escapeHtml(m.voiceDesc || '')}</div>
          ${time}
        </div>
      </div>`;
    }

    // 转账气泡
    if (m.type === 'transfer') {
      const transferTitle = `向${Utils.escapeHtml(contact.nickname || contact.name)}转账`;
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="transfer" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
          <div style="width:240px;border-radius:12px;overflow:hidden;border:1px solid var(--border);background:var(--bg-secondary)">
            <div style="background:linear-gradient(135deg,var(--accent),#e8a040);padding:12px 14px;display:flex;align-items:center;gap:8px">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
              <span style="font-size:13px;font-weight:600;color:#fff">${transferTitle}</span>
            </div>
            <div style="padding:14px">
              <div style="font-size:20px;font-weight:700;color:var(--text)">${Utils.escapeHtml(String(m.transferAmount || 0))} <span style="font-size:13px;font-weight:400;color:var(--text-secondary)">${Utils.escapeHtml(m.transferCurrency || '')}</span></div>
            </div>
          </div>
          ${time}
        </div>
      </div>`;
    }

    // 位置气泡
    if (m.type === 'location') {
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="location" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
          <div onclick="Phone._showChatLocationDetail('${Utils.escapeHtml(m.location || '')}','${Utils.escapeHtml(m.address || '')}')" style="width:200px;border-radius:14px;overflow:hidden;cursor:pointer;background:var(--bg-tertiary)">
            <div style="padding:12px 14px 8px;display:flex;align-items:center;gap:10px">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
              <div style="min-width:0">
                <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(m.location || '位置')}</div>
                <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(m.address || '')}</div>
              </div>
            </div>
            <div style="height:56px;background:linear-gradient(135deg,var(--accent-dim,#c8d8f0) 0%,var(--bg-secondary,#e8edf5) 100%);display:flex;align-items:center;justify-content:center;opacity:0.7">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.5"><path d="M3 3h18M3 9h18M3 15h18M3 21h18M9 3v18M15 3v18"/></svg>
            </div>
          </div>
          ${time}
        </div>
      </div>`;
    }

    // 地点链接气泡
    if (m.type === 'map_place') {
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="map_place" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
          <div style="width:200px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
            <div style="height:52px;background:linear-gradient(135deg,var(--accent-dim,#c8d8f0) 0%,var(--bg-secondary,#e8edf5) 100%);display:flex;align-items:center;justify-content:center;opacity:0.8">
              <svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24' fill='var(--accent)' stroke='none'><path d='M12 2a8 8 0 0 0-8 8c0 5.4 7.05 11.5 7.35 11.76a1 1 0 0 0 1.3 0C12.95 21.5 20 15.4 20 10a8 8 0 0 0-8-8Zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z'/></svg>
            </div>
            <div style="padding:10px 12px 10px">
              <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.placeName || '地点')}</div>
              ${m.placeAddress ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.placeAddress)}</div>` : ''}
              ${m.placeDesc ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.placeDesc)}</div>` : ''}
            </div>
          </div>
          ${time}
        </div>
      </div>`;
    }

    // 商品卡片气泡
    if (m.type === 'product') {
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="product" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
          <div style="width:210px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
            <div style="padding:12px 14px 10px;display:flex;gap:10px;align-items:flex-start">
              <div style="width:44px;height:44px;border-radius:8px;background:var(--bg-secondary,#eee);flex-shrink:0;display:flex;align-items:center;justify-content:center">
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" x2="21" y1="6" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${Utils.escapeHtml(m.productName || '商品')}</div>
                ${m.productPrice ? `<div style="font-size:14px;font-weight:700;color:var(--accent);margin-top:4px">¥${Utils.escapeHtml(String(m.productPrice))}</div>` : ''}
              </div>
            </div>
            <div style="padding:6px 14px 10px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(m.productPlatform || '')}</span>
              ${m.productShop ? `<span style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px">${Utils.escapeHtml(m.productShop)}</span>` : ''}
            </div>
          </div>
          ${time}
        </div>
      </div>`;
    }

    // 商品卡片气泡
    if (m.type === 'product') {
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="product" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
          <div style="width:210px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
            <div style="padding:12px 14px 10px;display:flex;gap:10px;align-items:flex-start">
              <div style="width:44px;height:44px;border-radius:8px;background:var(--bg-secondary,#eee);flex-shrink:0;display:flex;align-items:center;justify-content:center">
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" x2="21" y1="6" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${Utils.escapeHtml(m.productName || '商品')}</div>
                ${m.productPrice ? `<div style="font-size:14px;font-weight:700;color:var(--accent);margin-top:4px">¥${Utils.escapeHtml(String(m.productPrice))}</div>` : ''}
              </div>
            </div>
            <div style="padding:6px 14px 10px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(m.productPlatform || '')}</span>
              ${m.productShop ? `<span style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px">${Utils.escapeHtml(m.productShop)}</span>` : ''}
            </div>
          </div>
          ${time}
        </div>
      </div>`;
    }

    // 论坛帖子气泡（摘要截图 / 详情链接）
    if (m.type === 'forum_card' || m.type === 'forum_detail') {
      const isDetail = m.type === 'forum_detail';
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="${m.type}" style="${mine ? 'align-items:flex-end' : 'align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
          <div style="width:220px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
            <div style="padding:12px 14px 10px">
              <div style="font-size:11px;color:var(--accent);margin-bottom:6px;display:flex;align-items:center;gap:4px">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                ${Utils.escapeHtml(m.forumPlatform || '论坛')} · ${isDetail ? '帖子详情' : '帖子摘要'}
              </div>
              <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${Utils.escapeHtml(m.forumTitle || '帖子')}</div>
              ${m.forumSummary && !isDetail ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${Utils.escapeHtml(m.forumSummary)}</div>` : ''}
            </div>
            <div style="padding:6px 14px 10px;border-top:1px solid var(--border)">
              <span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(m.forumAuthor || '匿名')}</span>
            </div>
          </div>
          ${time}
        </div>
      </div>`;
    }

    // 如果是照片气泡，渲染为图片样式
    if (m.type === 'photo') {
      const isImage = m.mode === 'ai_image' && m.imageId;
      const innerHtml = isImage
        ? `<img class="phone-camera-polaroid-img" data-img-id="${Utils.escapeHtml(m.imageId)}" alt="生成的图片" />`
        : `<div class="phone-camera-polaroid-content">${Utils.escapeHtml(m.photoDesc || '(空)')}</div>`;
      
      const photoHtml = `
        <div class="phone-camera-polaroid" onclick="Phone._showChatPhotoDetail('${contactId}', '${m.id}')" style="opacity:1;margin:0;width:160px;min-height:160px;transform:none">
          <div class="phone-camera-polaroid-frame" style="padding:10px 10px 30px">
            ${innerHtml}
          </div>
        </div>
      `;
      
      const bubbleHtml = `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="photo" style="cursor:pointer${mine ? ';align-items:flex-end' : ';align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
          ${photoHtml}
          ${time}
        </div>
      </div>`;
      return bubbleHtml;
    }
    
    const bubbleHtml = `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" style="cursor:pointer${mine ? ';align-items:flex-end' : ';align-items:flex-start'};display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
      <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
      <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
        <div style="max-width:100%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.5;background:${mine ? 'var(--accent);color:#fff' : 'var(--bg-tertiary);color:var(--text)'};word-break:break-word">${Utils.escapeHtml(m.text || '')}</div>
        ${time}
      </div>
    </div>`;
    return bubbleHtml;
  }).join('');

  const list = document.getElementById('phone-chat-msglist');
  if (list) {
    list.innerHTML = bubbles || '<div style="padding:40px 24px;text-align:center;color:var(--text-secondary);font-size:13px;line-height:1.8">还没有消息</div>';
    list.scrollTop = list.scrollHeight;
  }
  
  _bindChatThreadEvents(contactId);
}

// 从主线消息收录线上聊天气泡（核心函数）
// messages: [{id, role, content}]，自动建联系人，按游戏内时间存
// 返回收录的条数
async function _ingestChatFromMessages(messages) {
  const pd = await _getPhoneData();
  if (!pd) return 0;
  if (!Array.isArray(pd.chatContacts)) pd.chatContacts = [];
  if (!pd.chatThreads || typeof pd.chatThreads !== 'object') pd.chatThreads = {};
  // 头像表
  let avatarById = {};
  try { const rows = await DB.getAll('npcAvatars'); rows.forEach(a => { if (a && a.id) avatarById[a.id] = a.avatar || ''; }); } catch(_) {}
  // 当前候选（用于补头像）
  let candByName = {};
  // 代号→本名映射（aliases 字段，逗号/顿号分隔）
  let aliasToCand = {};
  try {
    (await _collectChatCandidates()).forEach(c => {
      candByName[c.name] = c;
      if (c.aliases) {
        String(c.aliases).split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean).forEach(alias => {
          if (!aliasToCand[alias]) aliasToCand[alias] = c;
        });
      }
      if (c.onlineName) {
        String(c.onlineName).split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean).forEach(oname => {
          if (!aliasToCand[oname]) aliasToCand[oname] = c;
        });
      }
    });
  } catch(_) {}

  // 查/建联系人（支持代号解析）
  const ensureContact = (npcName) => {
    // 先直接查本名
    let ct = pd.chatContacts.find(c => c.name === npcName);
    if (ct) return ct;
    // 再查代号映射，找到后用本名查/建联系人
    const realCand = aliasToCand[npcName];
    const realName = realCand ? realCand.name : npcName;
    ct = pd.chatContacts.find(c => c.name === realName);
    if (ct) return ct;
    const cand = candByName[realName] || realCand;
    const id = 'ct_' + Utils.uuid().slice(0, 8);
    ct = { id, name: realName, source: cand ? cand.source : 'auto', avatar: cand ? cand.avatar : '', sig: '' };
    pd.chatContacts.push(ct);
    if (!pd.chatThreads[id]) pd.chatThreads[id] = [];
    return ct;
  };

  // 已收录 key 集合（每个 thread 内）
  const seenKeyByContact = {};
  for (const ct of pd.chatContacts) {
    const arr = pd.chatThreads[ct.id] || [];
    seenKeyByContact[ct.id] = new Set(arr.filter(m => m._k).map(m => m._k));
  }

  let added = 0;
  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant' || !msg.content) continue;
    let parsed;
    try { parsed = Utils.parseAIOutput(msg.content); } catch(_) { continue; }
    if (!parsed || !Array.isArray(parsed.chat) || !parsed.chat.length) continue;
    for (const cm of parsed.chat) {
      const npc = (cm.npc || '').trim();
      const text = (cm.text || '').trim();
      if (!npc || !text) continue;
      const time = (cm.time || '').trim(); // 只用游戏内时间，没有就空
      const ct = ensureContact(npc);
      if (!pd.chatThreads[ct.id]) pd.chatThreads[ct.id] = [];
      if (!seenKeyByContact[ct.id]) seenKeyByContact[ct.id] = new Set();
      const key = `${npc}|${time}|${text}`;
      if (seenKeyByContact[ct.id].has(key)) continue;
      seenKeyByContact[ct.id].add(key);
      pd.chatThreads[ct.id].push({
        id: 'm_' + Utils.uuid().slice(0, 8),
        role: 'them',
        text,
        time,            // 游戏内时间，可能为空
        fromMainline: true,
        _k: key,
      });
      added++;
    }
  }
  if (added > 0) await _savePhoneData();
  return added;
}

// 对外：从主线收录（供 chat.js 总结前调用 / 进 app 时调用）
async function ingestChatMessages(messages) {
  try { return await _ingestChatFromMessages(messages || []); } catch(_) { return 0; }
}

// 对外：根据在场角色名返回聊天记录（最近 N 轮，按 roundId 分组）
async function getChatHistoryForNPCs(npcNames, rounds = 5) {
  if (!npcNames || !npcNames.length) return '';
  const pd = await _getPhoneData();
  if (!pd || !pd.chatContacts || !pd.chatThreads) return '';
  const parts = [];
  const matchedContacts = pd.chatContacts.filter(c => npcNames.some(n => c.name === n || c.name.includes(n) || n.includes(c.name)));
  for (const contact of matchedContacts.slice(0, 3)) {
    const thread = pd.chatThreads[contact.id] || [];
    if (!thread.length) continue;
    // 找 AI 回复的 roundId，取最近 N 个
    const aiRoundIds = [];
    const seenRids = new Set();
    for (let i = thread.length - 1; i >= 0; i--) {
      const m = thread[i];
      if (m.role === 'them' && m.roundId && !seenRids.has(m.roundId)) {
        seenRids.add(m.roundId);
        aiRoundIds.unshift(m.roundId);
        if (aiRoundIds.length >= rounds) break;
      }
    }
    // 如果没有 roundId（旧数据 / 主线收录），退回取最近20条
    if (aiRoundIds.length === 0) {
      const recent = thread.slice(-20);
      const lines = recent.map(m => {
        if (m.role === 'system') return `  [系统] ${m.text || ''}`;
        const who = m.role === 'me' ? '{{user}}' : contact.name;
        const t = m.time ? ` [${m.time}]` : '';
        return `  ${who}${t}：${m.text || ''}`;
      });
      parts.push(`与「${contact.name}」的聊天记录：\n${lines.join('\n')}`);
      continue;
    }
    // 找起始位置
    const firstAiRid = aiRoundIds[0];
    const firstAiIdx = thread.findIndex(m => m.role === 'them' && m.roundId === firstAiRid);
    let startIdx = firstAiIdx;
    for (let i = firstAiIdx - 1; i >= 0; i--) {
      if (thread[i].role === 'them') break;
      startIdx = i;
    }
    const relevant = thread.slice(startIdx);
    const lines = relevant.map(m => {
      if (m.role === 'system') return `  [系统] ${m.text || ''}`;
      const who = m.role === 'me' ? '{{user}}' : contact.name;
      const t = m.time ? ` [${m.time}]` : '';
      return `  ${who}${t}：${m.text || ''}`;
    });
    parts.push(`与「${contact.name}」的聊天记录（最近${aiRoundIds.length}轮）：\n${lines.join('\n')}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : '';
}

// 进入聊天详情时，从当前对话所有 AI 消息收录新气泡
async function _syncMainlineForContact(contactId) {
  try {
    let messages = [];
    if (typeof Chat !== 'undefined' && Chat.getMessages) {
      messages = Chat.getMessages() || [];
    }
    const n = await _ingestChatFromMessages(messages);
    UI.showToast(n > 0 ? `收录了 ${n} 条新消息` : '没有新的线上消息', 1500);
    const pd = await _getPhoneData();
    if (pd && _chatCurContactId) _renderChatThread(pd, _chatCurContactId);
  } catch(e) {
    UI.showToast('收录失败：' + (e.message || '未知'), 2000);
  }
}

// 发送一条自己的消息（纯 append，不请求 AI，可连发）
async function _chatSendMessage(contactId) {
  try {
    const input = document.getElementById('phone-chat-input');
    if (!input) return;
    const text = (input.value || '').trim();
    if (!text) return;
    const pd = await _getPhoneData();
    if (!pd.chatThreads) pd.chatThreads = {};
    if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
    // 获取联系人名字
    const contact = (pd.chatContacts || []).find(c => c.id === contactId);
    const contactName = contact?.name || contactId;
    // 时间戳：取状态栏、全局基准、thread最新消息三者中最新的
    let gameTime = '';
    try { gameTime = _getChatGameTime(contactId, pd); } catch(_) {}
    // 获取或创建本轮用户 roundId（连发共用）
    if (!_pendingMeRoundId[contactId]) {
      _pendingMeRoundId[contactId] = 'r_' + Utils.uuid().slice(0, 8);
    }
    const meRoundId = _pendingMeRoundId[contactId];
    pd.chatThreads[contactId].push({
      id: 'm_' + Utils.uuid().slice(0, 8),
      role: 'me',
      text,
      time: gameTime,
      fromMainline: false,
      roundId: meRoundId,
    });
    _addChatMessageToRoundLog(contactId, 'me', text, gameTime, contactName);
    await _savePhoneData();
    input.value = '';
    _renderChatThread(pd, contactId);
    const inp2 = document.getElementById('phone-chat-input');
    if (inp2) inp2.focus();
  } catch(e) {
    UI.showToast('发送失败：' + (e.message || '未知'), 2000);
  }
}

// 聊天设置面板
async function _openChatSettings(contactId) {
  const pd = await _getPhoneData();
  const contact = (pd.chatContacts || []).find(c => c.id === contactId);
  if (!contact) return;

  const body = document.getElementById('phone-body');
  if (!body) return;

  const nickname = contact.nickname || '';
  const voiceEnabled = !!contact.voiceEnabled;
  const voiceId = contact.voiceId || '';

  // 更新标题
  const title = document.getElementById('phone-header-title');
  if (title) title.textContent = '聊天设置';

  // 更新右上角按钮区为空
  const headerRight = document.getElementById('phone-header-right');
  if (headerRight) headerRight.innerHTML = '';

  // 替换 body 内容（和设置页一样，直接渲染进 phone-body，壁纸自然透出）
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;padding:16px 16px 32px;overflow-y:auto">

      <div style="margin-bottom:24px">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;font-weight:500;letter-spacing:.04em">备注昵称</div>
        <div style="background:var(--bg-tertiary);border-radius:12px;overflow:hidden">
          <div style="display:flex;align-items:center;padding:0 14px">
            <input id="chat-settings-nickname" type="text" value="${Utils.escapeHtml(nickname)}" placeholder="留空则显示原名" maxlength="20"
              style="flex:1;padding:13px 0;font-size:14px;background:none;border:none;color:var(--text);outline:none">
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;padding:0 4px">仅对你显示，不会发送给 AI</div>
      </div>

      <div style="margin-bottom:24px">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;font-weight:500;letter-spacing:.04em">角色语音</div>
        <div style="background:var(--bg-tertiary);border-radius:12px;overflow:hidden">
          <div style="display:flex;align-items:center;padding:13px 14px">
            <span style="flex:1;font-size:14px;color:var(--text)">启用角色语音</span>
            <label style="position:relative;width:44px;height:26px;cursor:pointer;flex-shrink:0">
              <input id="chat-settings-voice-enabled" type="checkbox" ${voiceEnabled ? 'checked' : ''} onchange="Phone._onChatSettingsVoiceToggle()"
                style="opacity:0;width:0;height:0;position:absolute">
              <span id="chat-settings-voice-track" style="position:absolute;inset:0;border-radius:13px;background:${voiceEnabled ? 'var(--accent)' : 'var(--border)'};transition:background .2s">
                <span style="position:absolute;top:3px;left:${voiceEnabled ? '21px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></span>
              </span>
            </label>
          </div>
          <div id="chat-settings-voice-id-row" style="padding:0 14px;display:${voiceEnabled ? 'flex' : 'none'};align-items:center">
            <span style="font-size:14px;color:var(--text);flex-shrink:0;margin-right:10px">音色 ID</span>
            <input id="chat-settings-voice-id" type="text" value="${Utils.escapeHtml(voiceId)}" placeholder="填写 TTS 音色 ID"
              style="flex:1;padding:13px 0;font-size:14px;background:none;border:none;color:var(--text);outline:none">
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;padding:0 4px">启用后 AI 回复将通过语音播放</div>
      </div>

      <div style="margin-top:auto;padding-top:16px">
        <button onclick="Phone._saveChatSettings('${contactId}')"
          style="width:100%;padding:13px;border-radius:12px;background:var(--accent);color:#fff;border:none;font-size:15px;font-weight:600;cursor:pointer">
          保存
        </button>
      </div>

    </div>
  `;

  // 把 phone-header-left 的返回箭头改成回到聊天
  const headerLeft = document.getElementById('phone-header-left');
  if (headerLeft) {
    headerLeft.innerHTML = '<button onclick="Phone._openChatThread(\'' + contactId + '\')" style="width:34px;height:34px;background:none;border:none;color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:0"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 5-7 7 7 7"/></svg></button>';
  }
}

// 语音开关联动显示音色 ID 输入框
function _onChatSettingsVoiceToggle() {
  const cb = document.getElementById('chat-settings-voice-enabled');
  const row = document.getElementById('chat-settings-voice-id-row');
  const track = document.getElementById('chat-settings-voice-track');
  const knob = track ? track.querySelector('span') : null;
  if (!cb) return;
  const on = cb.checked;
  if (row) row.style.display = on ? 'flex' : 'none';
  if (track) track.style.background = on ? 'var(--accent)' : 'var(--border)';
  if (knob) knob.style.left = on ? '21px' : '3px';
}

// 保存聊天设置
async function _saveChatSettings(contactId) {
  const nicknameEl = document.getElementById('chat-settings-nickname');
  const voiceEnabledEl = document.getElementById('chat-settings-voice-enabled');
  const voiceIdEl = document.getElementById('chat-settings-voice-id');
  const pd = await _getPhoneData();
  const contact = (pd.chatContacts || []).find(c => c.id === contactId);
  if (!contact) return;
  contact.nickname = (nicknameEl?.value || '').trim();
  contact.voiceEnabled = !!(voiceEnabledEl?.checked);
  contact.voiceId = (voiceIdEl?.value || '').trim();
  await _savePhoneData();
  UI.showToast('已保存', 1200);
  // 返回聊天界面
  _openChatThread(contactId);
}

// 加号菜单开关
function _closeChatPlusMenu() {
  const menu = document.getElementById('phone-chat-plus-menu');
  if (menu && !menu.classList.contains('hidden')) menu.classList.add('hidden');
}
function _toggleChatPlusMenu() {
  const menu = document.getElementById('phone-chat-plus-menu');
  if (!menu) return;
  const isHidden = menu.classList.contains('hidden');
  menu.classList.toggle('hidden');
  if (isHidden) {
    const list = document.getElementById('phone-chat-msglist');
    if (list) {
      setTimeout(() => {
        list.scrollTop = list.scrollHeight;
      }, 50);
    }
    // 点外部关闭
    setTimeout(() => {
      const close = (e) => {
        if (!menu.contains(e.target) && e.target.id !== 'phone-chat-plus-btn') {
          menu.classList.add('hidden');
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }
}

// 分发发送：语音模式走 _chatSendVoice，普通模式走 _chatSendMessage
function _chatDoSend(contactId) {
  if (_chatVoiceMode[contactId]) {
    _chatSendVoice(contactId);
  } else {
    _chatSendMessage(contactId);
  }
}

// 切换语音模式：发送按钮图标在箭头↑和话筒之间切换，左侧按钮在加号和叉叉之间切换
function _toggleChatVoiceMode(contactId) {
  _chatVoiceMode[contactId] = !_chatVoiceMode[contactId];
  const isVoice = !!_chatVoiceMode[contactId];
  // 切换发送按钮图标
  const icon = document.getElementById('phone-chat-send-icon');
  if (icon) {
    icon.innerHTML = isVoice
      ? '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>'
      : '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>';
  }
  // 切换左侧加号/叉叉按钮
  const plusBtn = document.getElementById('phone-chat-plus-btn');
  if (plusBtn) {
    if (isVoice) {
      plusBtn.onclick = () => Phone._toggleChatVoiceMode(contactId);
      plusBtn.title = '退出语音模式';
      plusBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:22px;height:22px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    } else {
      plusBtn.onclick = () => Phone._toggleChatPlusMenu();
      plusBtn.title = '更多';
      plusBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:24px;height:24px"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 9a.75.75 0 0 0-1.5 0v2.25H9a.75.75 0 0 0 0 1.5h2.25V15a.75.75 0 0 0 1.5 0v-2.25H15a.75.75 0 0 0 0-1.5h-2.25V9Z" clip-rule="evenodd" /></svg>`;
    }
  }
  // 切换输入框 placeholder
  const input = document.getElementById('phone-chat-input');
  if (input) {
    input.placeholder = isVoice ? '输入语音内容…' : '输入消息…';
    input.focus();
  }
  // 关闭加号菜单
  const menu = document.getElementById('phone-chat-plus-menu');
  if (menu) menu.classList.add('hidden');
}

// 聊天订单选择器：替换 phone-body 内容，避免透出聊天界面
async function _openChatOrderPicker(contactId) {
  const plusMenu = document.getElementById('phone-chat-plus-menu');
  if (plusMenu) plusMenu.classList.add('hidden');

  const pd = await _getPhoneData();
  const takeoutOrders = (pd?.takeoutOrders || []).slice().reverse();
  const shopOrders = (pd?.shopOrders || []).slice().reverse();
  const allOrders = [
    ...takeoutOrders.map(o => ({ ...o, _kind: 'takeout' })),
    ...shopOrders.map(o => ({ ...o, _kind: 'shop' }))
  ];

  const myName = (() => { try { const mk = Character.get(); return mk?.name || '我'; } catch(_) { return '我'; } })();

  const cardsHtml = allOrders.length > 0 ? allOrders.map(o => {
    const platform = o._kind === 'takeout' ? '饿了咪' : '桃宝';
    const targetLabel = o.target === '自己' ? `${myName}自己` : `→ ${o.target}`;
    return `
      <div onclick="Phone._sendChatOrder('${contactId}','${Utils.escapeHtml(o.id)}','${o._kind}')"
           style="padding:12px 14px;border-radius:12px;background:var(--bg-tertiary);margin-bottom:8px;cursor:pointer">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(o.name || '')}</span>
          ${o.price ? `<span style="font-size:13px;font-weight:700;color:var(--accent);margin-left:8px;flex-shrink:0">¥${Utils.escapeHtml(String(o.price))}</span>` : ''}
        </div>
        ${o.shop ? `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:3px">${Utils.escapeHtml(o.shop)}</div>` : ''}
        <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
          <span style="font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid var(--border);color:var(--text-secondary)">${Utils.escapeHtml(platform)}</span>
          <span style="font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid var(--border);color:var(--text-secondary)">${Utils.escapeHtml(targetLabel)}</span>
          <span style="font-size:10px;color:var(--text-secondary);margin-left:auto">${Utils.escapeHtml(o.time || '')}</span>
        </div>
      </div>
    `;
  }).join('') : '<div style="padding:40px;text-align:center;color:var(--text-secondary);font-size:13px">还没有订单记录</div>';

  const body = document.getElementById('phone-body');
  if (!body) return;
  const headerRight = document.getElementById('phone-header-right');
  if (headerRight) headerRight.innerHTML = '';
  document.getElementById('phone-title').textContent = '发送订单';
  _pushNav(() => _openChatThread(contactId));

  body.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%">
      <div style="flex:1;overflow-y:auto;padding:12px">${cardsHtml}</div>
    </div>
  `;
}

// 确认发送订单消息
async function _sendChatOrder(contactId, orderId, kind) {
  document.getElementById('phone-order-picker-overlay')?.remove();
  const pd = await _getPhoneData();
  const ordersField = kind === 'takeout' ? 'takeoutOrders' : 'shopOrders';
  const order = (pd?.[ordersField] || []).find(o => o.id === orderId);
  if (!order) { UI.showToast('订单不存在', 1200); return; }
  const platform = kind === 'takeout' ? '饿了咪' : '桃宝';
  let gameTime = '';
  try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}
  if (!pd.chatThreads) pd.chatThreads = {};
  if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
  pd.chatThreads[contactId].push({
    id: 'ord_' + Date.now(),
    role: 'me',
    type: 'order',
    orderName: order.name || '',
    orderShop: order.shop || '',
    orderPrice: order.price || '',
    orderDesc: order.desc || '',
    orderTarget: order.target || '自己',
    orderPlatform: platform,
    orderTime: order.time || '',
    text: `[订单信息]${order.name || ''}`,
    time: gameTime,
    createdAt: Date.now()
  });
  await _savePhoneData();
  const _ctNameOrd = (pd.chatContacts || []).find(c => c.id === contactId)?.name || contactId;
  _addChatMessageToRoundLog(contactId, 'me', `发送了已购订单（${order.name || ''}）`, gameTime, _ctNameOrd);
  _openChatThread(contactId);
}

// 打开位置选择器：从 StatusBar 提取当前位置预填，用户可编辑后确认发送
async function _openChatLocationPicker(contactId) {
  // 关闭加号菜单
  const plusMenu = document.getElementById('phone-chat-plus-menu');
  if (plusMenu) plusMenu.classList.add('hidden');

  // 从 StatusBar 拿当前位置（region·location 拼接，与轨迹记录一致）
  let defaultLocation = '';
  try {
    const sb = Conversations.getStatusBar();
    defaultLocation = [sb?.region, sb?.location].filter(Boolean).join('·');
  } catch(_) {}

  // 弹出编辑卡片
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.45)';
  overlay.innerHTML = `
    <div style="width:100%;max-width:420px;background:var(--bg);border-radius:20px 20px 0 0;padding:20px 20px 32px;box-shadow:0 -4px 24px rgba(0,0,0,0.18)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <span style="font-size:16px;font-weight:600;color:var(--text)">发送位置</span>
        <button id="loc-picker-cancel" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;line-height:1">×</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
        <span style="font-size:12px;color:var(--text-secondary)">当前位置</span>
      </div>
      <input id="loc-picker-name" type="text" value="${Utils.escapeHtml(defaultLocation)}" placeholder="输入位置名称…" style="width:100%;box-sizing:border-box;padding:10px 12px;font-size:14px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:10px;outline:none;margin-bottom:20px">
      <button id="loc-picker-confirm" style="width:100%;padding:12px;background:var(--accent);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer">发送位置</button>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#loc-picker-cancel').onclick = () => document.body.removeChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) document.body.removeChild(overlay); });
  overlay.querySelector('#loc-picker-confirm').onclick = () => {
    const loc = (overlay.querySelector('#loc-picker-name').value || '').trim();
    document.body.removeChild(overlay);
    if (loc) Phone._confirmChatLocation(contactId, loc, '');
    else UI.showToast('请输入位置名称', 1200);
  };
}

// 确认发送位置消息
async function _confirmChatLocation(contactId, location, address) {
  try {
    const pd = await _getPhoneData();
    if (!pd.chatThreads) pd.chatThreads = {};
    if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
    let gameTime = '';
    try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}
    pd.chatThreads[contactId].push({
      id: 'loc_' + Date.now(),
      role: 'me',
      type: 'location',
      location,
      address,
      text: `[位置]${location}`,
      time: gameTime,
      createdAt: Date.now()
    });
    await _savePhoneData();
    const _ctNameLoc = (pd.chatContacts || []).find(c => c.id === contactId)?.name || contactId;
    _addChatMessageToRoundLog(contactId, 'me', `发送了位置`, gameTime, _ctNameLoc);
    _openChatThread(contactId);
  } catch(e) {
    UI.showToast('发送失败：' + (e.message || '未知'), 2000);
  }
}

// 查看位置详情
function _showChatLocationDetail(location, address) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)';
  overlay.innerHTML = `
    <div style="width:min(320px,88vw);background:var(--bg);border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.25)">
      <div style="height:160px;background:linear-gradient(135deg,var(--accent-dim,#c8d8f0) 0%,var(--bg-secondary,#e8edf5) 100%);display:flex;align-items:center;justify-content:center;position:relative">
        <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1" opacity="0.3"><path d="M3 3h18M3 9h18M3 15h18M3 21h18M9 3v18M15 3v18"/></svg>
        <div style="position:absolute;display:flex;flex-direction:column;align-items:center;gap:4px">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="var(--accent)" stroke="none"><path d="M12 2a8 8 0 0 0-8 8c0 5.4 7.05 11.5 7.35 11.76a1 1 0 0 0 1.3 0C12.95 21.5 20 15.4 20 10a8 8 0 0 0-8-8Zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"/></svg>
          <div style="background:rgba(255,255,255,0.9);border-radius:8px;padding:4px 10px;font-size:13px;font-weight:600;color:var(--text)">${Utils.escapeHtml(location || '位置')}</div>
        </div>
      </div>
      <div style="padding:16px 20px 20px">
        <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px">${Utils.escapeHtml(location || '位置')}</div>
        ${address ? `<div style="font-size:13px;color:var(--text-secondary)">${Utils.escapeHtml(address)}</div>` : ''}
        <button onclick="this.closest('div[style*=fixed]').remove()" style="margin-top:16px;width:100%;padding:11px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:10px;font-size:14px;cursor:pointer">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// 发送语音消息：存 type=voice，不触发 AI，等刷新打包
async function _chatSendVoice(contactId) {
  try {
    const input = document.getElementById('phone-chat-input');
    if (!input) return;
    const text = (input.value || '').trim();
    if (!text) return;
    const pd = await _getPhoneData();
    if (!pd.chatThreads) pd.chatThreads = {};
    if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
    const contact = (pd.chatContacts || []).find(c => c.id === contactId);
    const contactName = contact?.name || contactId;
    let gameTime = '';
    try { gameTime = _getChatGameTime(contactId, pd); } catch(_) {}
    if (!_pendingMeRoundId[contactId]) {
      _pendingMeRoundId[contactId] = 'r_' + Utils.uuid().slice(0, 8);
    }
    const meRoundId = _pendingMeRoundId[contactId];
    const aiText = `{{user}}发送了一条语音，内容为：${text}`;
    pd.chatThreads[contactId].push({
      id: 'm_' + Utils.uuid().slice(0, 8),
      role: 'me',
      type: 'voice',
      voiceDesc: text,
      text: aiText,
      time: gameTime,
      fromMainline: false,
      roundId: meRoundId,
    });
    _addChatMessageToRoundLog(contactId, 'me', aiText, gameTime, contactName);
    await _savePhoneData();
    input.value = '';
    _renderChatThread(pd, contactId);
    const inp2 = document.getElementById('phone-chat-input');
    if (inp2) inp2.focus();
  } catch(e) {
    UI.showToast('发送失败：' + (e.message || '未知'), 2000);
  }
}

// 点刷新：把自己发的消息 + 角色人设 + 世界观 + 主线 + 手机聊天记录打包，请求 AI 回复
let _chatReplyBusy = false;
async function _chatRequestReply(contactId) {
  if (_chatReplyBusy) { UI.showToast('对方正在回复…', 1200); return; }
  const btn = document.getElementById('phone-chat-refresh-btn');
  try {
    const pd = await _getPhoneData();
    const contact = (pd.chatContacts || []).find(c => c.id === contactId);
    if (!contact) { UI.showToast('联系人不存在', 1500); return; }
    const thread = (pd.chatThreads && pd.chatThreads[contactId]) || [];
    if (!thread.length) { UI.showToast('先发条消息再让对方回复', 1500); return; }

    _chatReplyBusy = true;
    if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.74-8.74"/></svg>'; btn.style.pointerEvents = 'none'; }

    // 先识图：处理所有 needsVision=true 的气泡
    const visionPending = thread.filter(m => m.needsVision && m.type === 'real_image' && m.imageBase64);
    if (visionPending.length > 0) {
      UI.showToast('正在识别图片…', 1500);
      for (const m of visionPending) {
        try {
          const description = await API.describeImage(m.imageBase64, '请用中文详细描述这张图片的内容，包括画面主体、场景、颜色、氛围等。');
          if (description) {
            m.photoDesc = description;
            m.text = `{{user}}发送了一张图片，图片内容为：${description}`;
            m.needsVision = false;
          }
        } catch(e) {
          m.text = `{{user}}发送了一张图片（识图失败：${e.message || '未知'}）`;
          m.needsVision = false;
        }
      }
      await _savePhoneData();
      _renderChatThread(pd, contactId);
    }
    // 插入 typing 占位（对方头像 + 三点跳动）
    const _insertTyping = () => {
      const list = document.getElementById('phone-chat-msglist');
      if (!list) return null;
      const avaUrl = _chatContactAvatar(contact);
      const initial = Utils.escapeHtml((contact.name || '?')[0]);
      const avatarInner = avaUrl
        ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`
        : initial;
      const el = document.createElement('div');
      el.id = 'phone-chat-typing';
      el.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-bottom:12px';
      el.innerHTML = `<div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${avatarInner}</div><div style="padding:10px 14px;border-radius:14px;background:var(--bg-tertiary)"><div class="typing-indicator"><span></span><span></span><span></span></div></div>`;
      list.appendChild(el);
      list.scrollTop = list.scrollHeight;
      return el;
    };
    const typingEl = _insertTyping();

    // ① 当前角色详细人设
    let personaStr = contact.name || '未知';
    try {
      const cands = await _collectChatCandidates();
      const cand = cands.find(c => c.name === contact.name);
      if (cand && cand.detail) personaStr += '\n' + cand.detail;
    } catch(_) {}

    // ② 基础世界观 + 速查表 + ③ 主线最近10轮（_buildFullContext 已含）
    let fullCtx = '';
    try { fullCtx = await _buildFullContext(); } catch(_) {}

    // ④ 手机内最近20条聊天记录
    const recent = thread.slice(-20);
    const myName = (() => { try { const mk = Character.get(); return mk?.name || '我'; } catch(_) { return '我'; } })();
    const histStr = recent.map(m => {
      const who = m.role === 'me' ? `玩家（${myName}）` : contact.name;
      const t = m.time ? `[${m.time}] ` : '';
      if (m.type === 'location') return `${who}：${t}发送了一条位置信息：${m.location || ''}${m.address ? '（' + m.address + '）' : ''}`;
      if (m.type === 'voice') return `${who}：${t}${m.voiceDesc || m.text || ''}`;
      if (m.type === 'photo') return `${who}：${t}[发送了一张照片]`;
      if (m.type === 'product') return `${who}：${t}发送了一条商品链接：${m.productName || ''}${m.productPrice ? '（¥' + m.productPrice + '）' : ''}${m.productPlatform ? ' · ' + m.productPlatform : ''}`;
      if (m.type === 'forum_card') return `${who}：${t}发送了一条帖子摘要截图：${m.forumTitle || ''}`;
      if (m.type === 'forum_detail') return `${who}：${t}发送了一条帖子详情链接：${m.forumTitle || ''}`;
      if (m.type === 'map_place') return `${who}：${t}发送了一条地点链接：${m.placeName || ''}${m.placeAddress ? '（' + m.placeAddress + '）' : ''}`;
      if (m.type === 'order') return `${who}：${t}发送了一条订单信息（${who}已购）：${m.orderName || ''}${m.orderPrice ? '（¥' + m.orderPrice + '）' : ''}${m.orderPlatform ? ' · ' + m.orderPlatform : ''}`;
      if (m.type === 'transfer') return `${who}：${t}向你转账 ${m.transferAmount || 0} ${m.transferCurrency || ''}`;
      return `${who}：${t}${m.text}`;
    }).join('\n');

    // 当前游戏时间
    let gameTime = '';
    try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}

    const voiceInstruction = contact.voiceEnabled ? `
6. 你可以选择以语音形式发送某些消息（比如情绪饱满、语气强烈或亲近的话语）。语音消息使用以下格式：[语音]消息内容。例如：[语音]快来找我！。普通文字消息不需要任何前缀。` : '';

    const systemPrompt = `${fullCtx}

【正在私聊的角色】
你现在要扮演「${contact.name}」，通过手机和玩家进行**一对一私聊**。
${personaStr}

【手机私聊记录】（玩家＝${myName}，对方＝${contact.name}）
${histStr}

【当前游戏时间】${gameTime || '（未知）'}

【私聊规则】
1. 你是「${contact.name}」，正在用手机回复玩家的私聊消息。只写「${contact.name}」会发的内容，不要写旁白、不要写玩家的话。
2. 上面的主线剧情仅供参考，用来判断你和玩家此刻的关系与状态。**请先判断你（${contact.name}）在那些主线场景里是否在场**：如果你不在场，绝对不要主动提起主线里发生的事（你根本不知道）；只有你在场或事后理应知道的事，才能自然提及。
3. 回复要符合角色当下的状态：**先想这个角色此刻正在做什么**——可能在忙、在睡、在外面。据此决定回复的语气和"时机感"：可能秒回，也可能像是过了一阵才回（在内容里自然体现，比如"刚看到""在忙刚回来"），不要每次都热情秒回。
4. 你可以一次回复多条短消息（像真人发微信那样），也可以只回一条。
5. **必须用以下 JSON 格式输出**，放在 \`\`\`chat 代码块里，每条消息一个对象，time 用游戏内时间（"${gameTime || 'YYYY.MM.DD 星期X HH:mm'}"格式，可比玩家发消息的时间稍晚一点）：${voiceInstruction}
\`\`\`chat
[
  {"npc": "${contact.name}", "text": "消息内容", "time": "时间"},
  {"npc": "${contact.name}", "text": "第二条消息内容（可选）", "time": "时间"}
]
\`\`\`
只输出这个 chat 块，不要输出其它任何内容。`;

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `（请以「${contact.name}」的身份回复上面手机私聊记录里玩家最新发来的消息）` }
    ];

    let fullReply = '';
    await new Promise((resolve, reject) => {
      API.streamChat(
        apiMessages,
        (chunk) => { fullReply += chunk; },
        () => resolve(),
        (err) => reject(new Error(err || '请求失败')),
        null,
        { forceNoStream: true }
      );
    });
// 解析回复里的 chat 块
    let parsed = null;
    try { parsed = Utils.parseAIOutput(fullReply); } catch(_) {}
    let chatArr = (parsed && Array.isArray(parsed.chat)) ? parsed.chat : [];
    // 兜底1：parseAIOutput 没解析出（比如 AI 用了竖线格式），自己从 ```chat 块里抠
    if (!chatArr.length) {
      const m = fullReply.match(/```chat\s*\n?([\s\S]*?)```/i);
      if (m) {
        const inner = m[1].trim();
        // 先试 JSON
        try {
          const j = JSON.parse(inner);
          if (Array.isArray(j)) chatArr = j;
        } catch(_) {}
        // 再试竖线格式：角色名 | 时间 | 内容
        if (!chatArr.length) {
          inner.split('\n').forEach(line => {
            const t = line.trim();
            if (!t) return;
            const segs = t.split('|').map(s => s.trim());
            if (segs.length >= 3) {
              chatArr.push({ npc: segs[0], time: segs[1], text: segs.slice(2).join(' | ') });
            } else if (segs.length === 2) {
              chatArr.push({ npc: contact.name, time: segs[0], text: segs[1] });
            } else {
              chatArr.push({ npc: contact.name, time: '', text: t });
            }
          });
        }
      }
    }
    // 兜底2：连 chat 块都没有，但有正文 → 当成一条对方消息
    if (!chatArr.length) {
      const body = (parsed && parsed.body) ? parsed.body.trim() : fullReply.trim();
      if (body) chatArr = [{ npc: contact.name, text: body, time: '' }];
    }


    const pd2 = await _getPhoneData();
    if (!pd2.chatThreads) pd2.chatThreads = {};
    if (!pd2.chatThreads[contactId]) pd2.chatThreads[contactId] = [];
    let n = 0;
    
    // 删掉 typing 占位
    if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
    
    // 生成本次 AI 回复的 roundId，清掉用户待回复 roundId
    const aiRoundId = 'r_' + Utils.uuid().slice(0, 8);
    delete _pendingMeRoundId[contactId];
    let lastAiTime = '';
    
    // 逐条延迟 append 气泡
    for (let i = 0; i < chatArr.length; i++) {
      const cm = chatArr[i];
      let text = (cm.text || '').trim();
      if (!text) continue;

      // 解析语音格式：[语音]内容
      const voiceMatch = text.match(/^\[语音\](.+)$/s);
      const isVoiceMsg = !!voiceMatch;
      const voiceDesc = isVoiceMsg ? voiceMatch[1].trim() : '';

      // 存进 thread
      const msgId = 'm_' + Utils.uuid().slice(0, 8);
      const cmTime = (cm.time || '').trim();
      pd2.chatThreads[contactId].push({
        id: msgId,
        role: 'them',
        type: isVoiceMsg ? 'voice' : undefined,
        voiceDesc: isVoiceMsg ? voiceDesc : undefined,
        text,
        time: cmTime,
        fromMainline: false,
        roundId: aiRoundId,
      });
      if (cmTime) lastAiTime = cmTime;
      _addChatMessageToRoundLog(contactId, 'them', text, cmTime, contact.name);

      // 等 600ms 再显示，用淡入动画
      await new Promise(resolve => setTimeout(resolve, 600));

      const list = document.getElementById('phone-chat-msglist');
      if (list) {
        const avaUrl = _chatContactAvatar(contact);
        const initial = Utils.escapeHtml((contact.name || '?')[0]);
        const avatarInner = avaUrl
          ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`
          : initial;
        const el = document.createElement('div');
        el.className = 'phone-chat-msg-bubble';
        el.dataset.msgId = msgId;
        el.dataset.role = 'them';
        el.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-bottom:12px;animation:fadeIn 0.3s ease-in;cursor:pointer';
        if (isVoiceMsg) {
          const waveHtml = `<div class="phone-chat-voice-wave" id="voice-wave-${msgId}" style="display:flex;align-items:center;gap:3px;opacity:0.7"><div style="width:3px;height:4px;background:currentColor;border-radius:2px"></div><div style="width:3px;height:8px;background:currentColor;border-radius:2px"></div><div style="width:3px;height:12px;background:currentColor;border-radius:2px"></div><div style="width:3px;height:8px;background:currentColor;border-radius:2px"></div><div style="width:3px;height:5px;background:currentColor;border-radius:2px"></div></div>`;
          el.innerHTML = `<div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${avatarInner}</div><div style="display:flex;flex-direction:column;align-items:flex-start;min-width:0;max-width:70%"><div onclick="Phone._playVoice('${msgId}')" style="padding:10px 14px;border-radius:18px;background:var(--bg-tertiary);color:var(--text);display:flex;align-items:center;gap:10px;min-width:100px;cursor:pointer"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>${waveHtml}</div><div style="margin-top:4px;padding:6px 10px;border-radius:8px;background:var(--bg-tertiary);color:var(--text-secondary);font-size:12px;max-width:100%;word-break:break-word">${Utils.escapeHtml(voiceDesc)}</div>${cmTime ? `<div style="font-size:10px;color:var(--text-secondary);margin-top:2px">${Utils.escapeHtml(cmTime)}</div>` : ''}</div>`;
        } else {
          el.innerHTML = `<div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${avatarInner}</div><div style="display:flex;flex-direction:column;align-items:flex-start;min-width:0"><div style="max-width:100%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.5;background:var(--bg-tertiary);color:var(--text);word-break:break-word">${Utils.escapeHtml(text)}</div>${cmTime ? `<div style="font-size:10px;color:var(--text-secondary);margin-top:2px">${Utils.escapeHtml(cmTime)}</div>` : ''}</div>`;
        }
        list.appendChild(el);
        list.scrollTop = list.scrollHeight;
      }

      n++;
    }
    
    if (n > 0) {
      await _savePhoneData();
      if (lastAiTime) _chatSessionBaseTime = lastAiTime; // 更新跨联系人基准时间
    }
    // 重新绑定长按事件
    _bindChatThreadEvents(contactId);
    if (n === 0) UI.showToast('对方没有回复', 1500);
  } catch(e) {
    UI.showToast('回复失败：' + (e.message || '未知'), 2200);
  } finally {
    _chatReplyBusy = false;
    const b = document.getElementById('phone-chat-refresh-btn');
    if (b) { b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>'; b.style.pointerEvents = ''; }
  }
}

function _renderCamera(pd) {
  const body = document.getElementById('phone-body');
  document.getElementById('phone-title').textContent = '相机';
  _cameraTab = pd.cameraTab || 'shoot';

  const shootHtml = _renderCameraShoot(pd);
  const albumHtml = _renderCameraAlbum(pd);

  body.innerHTML = `
    <div class="phone-camera-shell">
      <div id="phone-camera-shoot" class="phone-camera-page" style="display:${_cameraTab === 'shoot' ? 'flex' : 'none'}">${shootHtml}</div>
      <div id="phone-camera-album" class="phone-camera-page" style="display:${_cameraTab === 'album' ? 'flex' : 'none'}">${albumHtml}</div>
      <div class="phone-tabbar">
        <div class="phone-tab ${_cameraTab === 'shoot' ? 'active' : ''}" onclick="Phone._switchCameraTab('shoot')">拍摄</div>
        <div class="phone-tab ${_cameraTab === 'album' ? 'active' : ''}" onclick="Phone._switchCameraTab('album')">相册</div>
      </div>
    </div>
  `;
  // 拍摄 tab 渲染完后异步填充文本（要 await Character.get()）
  if (_cameraTab === 'shoot') _hydrateCameraShoot(pd);
  // 相册 tab 渲染完后异步加载真图
  if (_cameraTab === 'album') _hydrateAlbumImages();
}

// 拍摄 tab —— 渲染时先放占位，再异步填充实际拼接结果（因为要 await Character.get()）
function _renderCameraShoot(pd) {
  // 草稿（如果有）：先用草稿的 text 占位，避免闪烁
  const draft = pd.cameraDraft;
  const initialText = draft ? draft.text : '';
  return `
    <div class="phone-camera-shoot-inner">
      <div class="phone-camera-hint">即将拍下当前画面</div>
      <textarea id="phone-camera-text" class="phone-camera-text" placeholder="（当前场景为空，可以自己写一段描述）" spellcheck="false" oninput="Phone._cameraOnTextInput()">${Utils.escapeHtml(initialText)}</textarea>
      <div class="phone-camera-actions">
        <button class="phone-camera-btn-secondary" onclick="Phone._cameraOpenAdjust()">调整镜头</button>
        <button class="phone-camera-shutter" onclick="Phone._cameraShoot()" aria-label="拍摄">
          <span class="phone-camera-shutter-inner"></span>
        </button>
        <button class="phone-camera-btn-secondary" onclick="Phone._cameraRefillFromStatus()">重置</button>
      </div>
    </div>
  `;
}

// 渲染完 DOM 后调一次：根据状态栏拼接 + 草稿对比，填入正确的初始文字
async function _hydrateCameraShoot(pd) {
  const el = document.getElementById('phone-camera-text');
  if (!el) return;
  const fresh = await _composeShootText();
  const draft = pd.cameraDraft;
  // 草稿仍然有效（主线没推进）→ 用草稿；否则用最新状态栏
  if (draft && draft.baseStatusText === fresh) {
    el.value = draft.text;
  } else {
    el.value = fresh;
    if (draft) { pd.cameraDraft = null; _savePhoneData(); }
  }
}

// 相册 tab
function _renderCameraAlbum(pd) {
  const album = Array.isArray(pd.album) ? pd.album : [];
  if (!album.length) {
    return `
      <div class="phone-camera-album-empty">
        <div class="phone-camera-album-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:60px;height:60px;opacity:.4">
            <rect x="3" y="5" width="18" height="16" rx="2.5"></rect>
            <rect x="6" y="15" width="12" height="4" rx="0.5"></rect>
            <circle cx="12" cy="10.5" r="3"></circle>
            <circle cx="12" cy="10.5" r="1"></circle>
            <circle cx="17.5" cy="7.8" r="0.6"></circle>
          </svg>
        </div>
        <div class="phone-camera-album-empty-text">还没有照片</div>
        <div class="phone-camera-album-empty-sub">去拍摄第一张吧</div>
      </div>
    `;
  }
  // 倒序排列（新的在前）
  const sorted = album.slice().reverse();
  return `
    <div class="phone-camera-album-grid">
      ${sorted.map(p => _renderAlbumCard(p)).join('')}
    </div>
  `;
}

function _renderAlbumCard(p) {
  const text = String(p.text || '').trim();
  const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
  const time = p.time || '';
  const location = p.location || '';
  const isImage = p.mode === 'ai_image' && p.imageId;
  // 图片照片：内框放 <img>（src 异步从 drawnImages 表读，先放占位 data-img-id）
  const innerHtml = isImage
    ? `<img class="phone-camera-polaroid-img" data-img-id="${Utils.escapeHtml(p.imageId)}" alt="生成的图片" />`
    : `<div class="phone-camera-polaroid-content">${Utils.escapeHtml(preview || '(空)')}</div>`;
  return `
    <div class="phone-camera-polaroid" onclick="Phone._cameraOpenPhoto('${p.id}')">
      <div class="phone-camera-polaroid-frame">
        ${innerHtml}
      </div>
      ${location ? `<div class="phone-camera-polaroid-loc">${Utils.escapeHtml(location)}</div>` : ''}
      ${time ? `<div class="phone-camera-polaroid-caption">${Utils.escapeHtml(time)}</div>` : ''}
    </div>
  `;
}

// 异步把相册里所有 img.data-img-id 加载真实 dataUrl
async function _hydrateAlbumImages() {
  const imgs = document.querySelectorAll('.phone-camera-polaroid-img[data-img-id]');
  for (const el of imgs) {
    const imgId = el.dataset.imgId;
    if (!imgId) continue;
    try {
      const rec = await DB.get('drawnImages', imgId);
      if (rec && rec.dataUrl) {
        el.src = rec.dataUrl;
      } else {
        // 图丢了：把 img 换成"图片已丢失"占位
        const placeholder = document.createElement('div');
        placeholder.className = 'phone-camera-polaroid-content';
        placeholder.style.cssText = 'opacity:0.5;font-style:italic';
        placeholder.textContent = '(图片已丢失)';
        el.replaceWith(placeholder);
      }
    } catch(_) {}
    el.removeAttribute('data-img-id');
  }
}

// tab 切换
function _switchCameraTab(tab) {
  if (_cameraTab === tab) return;
  _cameraTab = tab;
  _getPhoneData().then(pd => {
    pd.cameraTab = tab;
    _savePhoneData();
    _renderCamera(pd);
  });
}

// 重置：把状态栏内容重新拼回输入框（覆盖手动改的内容 + 丢弃草稿）
async function _cameraRefillFromStatus() {
  const el = document.getElementById('phone-camera-text');
  if (!el) return;
  el.value = await _composeShootText();
  // 同步丢草稿
  const pd = await _getPhoneData();
  if (pd) { pd.cameraDraft = null; _savePhoneData(); }
  UI.showToast('已根据当前画面重置', 1200);
}

// 输入时实时写入草稿（debounce 300ms，避免频繁 save）
let _cameraTextSaveTimer = null;
function _cameraOnTextInput() {
  const el = document.getElementById('phone-camera-text');
  if (!el) return;
  if (_cameraTextSaveTimer) clearTimeout(_cameraTextSaveTimer);
  _cameraTextSaveTimer = setTimeout(async () => {
    const pd = await _getPhoneData();
    if (!pd) return;
    const text = el.value || '';
    const fresh = await _composeShootText();
    if (text === fresh) {
      // 内容和状态栏一致 → 不需要存草稿
      pd.cameraDraft = null;
    } else {
      pd.cameraDraft = { text, baseStatusText: fresh };
    }
    _savePhoneData();
  }, 300);
}

// 调整镜头：弹出二级菜单（输入用户额外要求 + 尺寸 + AI 写 / AI 画）
async function _cameraOpenAdjust() {
  // 移除已有 overlay
  const old = document.getElementById('phone-camera-adjust-overlay');
  if (old) old.remove();

  // 读取上次的尺寸记忆（默认 1024x1024）
  const pd = await _getPhoneData();
  const lastSize = pd?.cameraLastSize || { w: 1024, h: 1024, ratio: '1:1' };

  const overlay = document.createElement('div');
  overlay.id = 'phone-camera-adjust-overlay';
  overlay.className = 'phone-inner-modal';
  overlay.innerHTML = `
    <div class="modal-content phone-camera-adjust-card">
      <div class="phone-camera-adjust-title">调整镜头</div>
      <div class="phone-camera-adjust-desc">让 AI 帮你重新组织一下画面</div>
      <textarea id="phone-camera-adjust-input" class="phone-camera-adjust-input" placeholder="想拍成什么感觉？（可选，例如：更暗一点 / 聚焦手部 / 黑白胶片）" spellcheck="false"></textarea>

      <div class="phone-camera-adjust-size-label">尺寸（仅 AI 画用）</div>
      <div class="phone-camera-adjust-ratios">
        <button type="button" class="phone-camera-ratio-btn" data-ratio="1:1" data-w="1024" data-h="1024">1:1</button>
        <button type="button" class="phone-camera-ratio-btn" data-ratio="3:4" data-w="768" data-h="1024">3:4</button>
        <button type="button" class="phone-camera-ratio-btn" data-ratio="4:3" data-w="1024" data-h="768">4:3</button>
        <button type="button" class="phone-camera-ratio-btn" data-ratio="9:16" data-w="720" data-h="1280">9:16</button>
        <button type="button" class="phone-camera-ratio-btn" data-ratio="16:9" data-w="1280" data-h="720">16:9</button>
      </div>
      <div class="phone-camera-adjust-size-row">
        <span class="phone-camera-adjust-size-prefix">自定义：</span>
        <input id="phone-camera-size-w" type="number" min="64" max="2048" step="1" class="phone-camera-adjust-size-input" value="${lastSize.w}" />
        <span class="phone-camera-adjust-size-x">×</span>
        <input id="phone-camera-size-h" type="number" min="64" max="2048" step="1" class="phone-camera-adjust-size-input" value="${lastSize.h}" />
      </div>

      <button class="phone-camera-adjust-btn phone-camera-adjust-btn-write" type="button">
        <div class="phone-camera-adjust-btn-name">AI 写</div>
        <div class="phone-camera-adjust-btn-sub">把当前文字改写成更有镜头感的描述</div>
      </button>
      <button class="phone-camera-adjust-btn phone-camera-adjust-btn-draw" type="button">
        <div class="phone-camera-adjust-btn-name">AI 画</div>
        <div class="phone-camera-adjust-btn-sub">根据当前文字画一张真图</div>
      </button>
      <button class="phone-camera-adjust-cancel" type="button">取消</button>
    </div>
  `;
  overlay.onclick = (e) => { if (e.target === overlay) _closeCameraAdjust(); };
  const shell = document.querySelector('#phone-modal .phone-shell');
  (shell || document.body).appendChild(overlay);

  // 高亮上次选中的比例按钮
  const initBtn = overlay.querySelector(`.phone-camera-ratio-btn[data-ratio="${lastSize.ratio}"]`);
  if (initBtn) initBtn.classList.add('active');

  // 比例按钮 → 填进输入框 + 高亮
  overlay.querySelectorAll('.phone-camera-ratio-btn').forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      overlay.querySelectorAll('.phone-camera-ratio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const w = btn.dataset.w, h = btn.dataset.h;
      const wEl = overlay.querySelector('#phone-camera-size-w');
      const hEl = overlay.querySelector('#phone-camera-size-h');
      if (wEl) wEl.value = w;
      if (hEl) hEl.value = h;
    });
  });

  // 输入框被手动修改时，清除比例高亮
  ['#phone-camera-size-w', '#phone-camera-size-h'].forEach(sel => {
    const el = overlay.querySelector(sel);
    if (el) el.addEventListener('input', () => {
      overlay.querySelectorAll('.phone-camera-ratio-btn').forEach(b => b.classList.remove('active'));
    });
  });

  // 关键:用 pointerdown 直接触发按钮（在 IME 收起、viewport 跳变之前就把动作落地）
  // 否则在移动端会出现：点AI写 → IME收起 → viewport变高 → click 落在AI画的位置
  const bindBtn = (sel, fn) => {
    const btn = overlay.querySelector(sel);
    if (!btn) return;
    let fired = false;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (fired) return;
      fired = true;
      try { fn(); } catch(err) { console.warn('[Camera Adjust] btn handler', err); }
    });
    // 兜底：如果 pointerdown 没支持（极少数老 webview），仍走 click
    btn.addEventListener('click', (e) => {
      if (fired) { e.preventDefault(); e.stopPropagation(); return; }
      fired = true;
      try { fn(); } catch(err) { console.warn('[Camera Adjust] btn handler', err); }
    });
  };
  bindBtn('.phone-camera-adjust-btn-write', () => _cameraAIWrite());
  bindBtn('.phone-camera-adjust-btn-draw', () => _cameraAIDraw());
  bindBtn('.phone-camera-adjust-cancel', () => _closeCameraAdjust());
}

function _closeCameraAdjust() {
  const overlay = document.getElementById('phone-camera-adjust-overlay');
  if (overlay) overlay.remove();
}

// AI 写：调用 worldvoice 模型，把当前文字 + 最近剧情拼起来，让 AI 改写成更有镜头感的描述
async function _cameraAIWrite() {
  const el = document.getElementById('phone-camera-text');
  if (!el) return;
  const currentText = (el.value || '').trim();
  if (!currentText) {
    UI.showToast('画面是空的，先随便写点什么', 1500);
    return;
  }

  // 抓用户的额外要求（关 overlay 前）
  const extraEl = document.getElementById('phone-camera-adjust-input');
  const extra = (extraEl?.value || '').trim();

  // 取功能模型配置（用 worldvoice 配置，和论坛/朋友圈一致）
  const funcConfig = (typeof Settings !== 'undefined' && Settings.getWorldvoiceConfig) ? Settings.getWorldvoiceConfig() : {};
  const mainConfig = await API.getConfig();
  const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
  const key = funcConfig.apiKey || mainConfig.apiKey;
  const model = funcConfig.model || mainConfig.model;
  if (!url || !key || !model) {
    UI.showToast('请先在设置→功能模型中配置手机模型', 2200);
    return;
  }

  // 关掉二级菜单 + 进入加载态
  _closeCameraAdjust();
  el.disabled = true;
  el.classList.add('phone-camera-text-loading');
  const originalText = el.value;
  el.value = '正在调整镜头…';
  UI.showToast('AI 正在重写画面…', 1500);

  try {
    const ctx = await _buildFullContext();
    let playerName = '';
    try { const mask = await Character.get(); playerName = mask?.name || ''; } catch(_) {}
    const youLabel = playerName || '玩家';

    const systemPrompt = `你是【${youLabel}】，正在用手机相机拍照。你要把一段简单的画面描述改写成"这张照片实际看起来的样子"。

## 视角设定（最重要）
- 这是【${youLabel}】举着手机拍出来的照片，所以画面是**${youLabel} 的拍摄视角**。
- 默认是**他拍**——拍场景、拍 NPC、拍眼前的东西，${youLabel} 自己不在画面里（${youLabel} 是拿手机的那个人）。
- **例外：当用户的额外要求里明确说"自拍"、"拍自己"、"镜子里的我"、"和XX合照"等暗示时**，才把 ${youLabel} 写进画面（举着手机的姿势、镜中倒影、与他人同框等）。
- 上下文里如果出现"${youLabel}：穿着xxx，姿势xxx"，那是 ${youLabel} 此刻的状态——他拍时不写进画面（拍的人不在画里），自拍时才写进画面。

## 改写要求
- 用景物、光线、构图、神情、氛围、距离（远景/特写/侧光/逆光等）等元素丰富画面。
- 不要新增原文里完全不存在的人物或事件。
- 不要写成对白、剧情、内心独白——只写"这张照片被拍下的那一瞬间被定格的东西"。
- 长度：120 - 250 字。
- 风格：克制、有质感、有氛围，像真的在朋友圈/小红书发图配的文案，但更有镜头语言一点。不要用网文夸张词。

## 输出格式（极其重要）
- **只输出纯文本叙事**。
- **绝对不要**输出代码块（不要 \`\`\`xxx）、JSON、关系数据、affinity/darkness/好感度等结构化内容。
- **绝对不要**输出标题、序号、Markdown 标记、引号包裹、"以下是改写："这类前言。
- 上下文里可能包含主线 AI 的输出规则（关系块、状态栏更新等），那些规则**不属于本次任务**。
- 回复从第一个汉字开始，到最后一个汉字/标点结束。

## 角色称谓
- 不要用"你"或"我"。
- 提到 ${youLabel} 时直接用名字或第三人称（她/他）。

## 上下文（仅供参考画面氛围，不要照抄剧情，不要套用主线输出格式）
${ctx}`;

    const userPrompt = `## 用户拍下的画面（原始描述）
${currentText}
${extra ? `\n## 用户的额外要求\n${extra}\n` : ''}
请改写成一段有镜头感的中文叙事${extra ? '，并贴合上述额外要求' : ''}。`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: false,
        temperature: 0.85,
        max_tokens: 600
      })
    });
    if (!resp.ok) throw new Error(`API 错误: ${resp.status}`);
    const json = await resp.json();
    let content = (json.choices?.[0]?.message?.content || '').trim();
    // 防御性清理：
    // 1) 去掉开头的代码块标记（如果有）
    content = content.replace(/^```\w*\n?/, '').trim();
    // 2) 截断到第一个 ``` 之前（AI 可能在叙事后跑出关系块/JSON）
    const codeFenceIdx = content.indexOf('```');
    if (codeFenceIdx > 0) content = content.slice(0, codeFenceIdx).trim();
    // 3) 去掉首尾引号包裹
    content = content.replace(/^["「『]+|["」』]+$/g, '').trim();
    // 4) 去掉常见前言："以下是改写："/"改写后："等
    content = content.replace(/^(以下是.*?[:：]|改写[:：])\s*/u, '').trim();
    if (!content) throw new Error('AI 没有返回内容');

    // 写入文本框 + 触发草稿保存
    el.value = content;
    _cameraOnTextInput();
    UI.showToast('已重写画面', 1200);
  } catch(e) {
    console.warn('[Camera AI Write] failed', e);
    el.value = originalText;
    UI.showToast(`AI 写失败：${e.message || '未知错误'}`, 2400);
  } finally {
    el.disabled = false;
    el.classList.remove('phone-camera-text-loading');
  }
}

// AI 画：根据当前文字 + 用户额外要求 + 剧情上下文，调生图 API 出一张真图
async function _cameraAIDraw() {
  const el = document.getElementById('phone-camera-text');
  if (!el) return;
  const currentText = (el.value || '').trim();
  if (!currentText) {
    UI.showToast('画面是空的，先随便写点什么', 1500);
    return;
  }

  // 抓用户的额外要求 + 尺寸（关 overlay 前）
  const extraEl = document.getElementById('phone-camera-adjust-input');
  const extra = (extraEl?.value || '').trim();
  const wEl = document.getElementById('phone-camera-size-w');
  const hEl = document.getElementById('phone-camera-size-h');
  let w = parseInt(wEl?.value, 10);
  let h = parseInt(hEl?.value, 10);
  if (!Number.isFinite(w) || w < 64 || w > 2048) w = 1024;
  if (!Number.isFinite(h) || h < 64 || h > 2048) h = 1024;
  const activeRatioBtn = document.querySelector('.phone-camera-ratio-btn.active');
  const ratioMark = activeRatioBtn?.dataset?.ratio || '';

  // 拼最终发送给生图模型的 prompt
  const drawPrompt = extra
    ? `${currentText}\n\n额外要求：${extra}`
    : currentText;

  // ⚠ 提示用户检查 prompt——生图模型不知道角色性别/外貌，画错责任在用户
  const previewMsg = `即将把以下内容发给生图模型（${w}×${h}）：\n\n${drawPrompt}\n\n———\n⚠ 注意：生图模型只看到这段文字，不知道角色性别/身材/外貌等信息。\n如有重要信息（性别、长相、关键服饰等），请取消后在"调整镜头"里补充。`;
  const ok = (typeof UI.showConfirm === 'function')
    ? await UI.showConfirm('确认生成', previewMsg)
    : confirm(previewMsg);
  if (!ok) return;

  _closeCameraAdjust();

  // 把当前状态栏快照保存下来
  let gameTime = '', location = '';
  try {
    const sb = Conversations.getStatusBar() || {};
    gameTime = sb.time || '';
    location = [sb.region, sb.location].filter(Boolean).join('·');
  } catch(_) {}

  // 保存尺寸到 phoneData
  try {
    const pd0 = await _getPhoneData();
    if (pd0) {
      pd0.cameraLastSize = { w, h, ratio: ratioMark };
      _savePhoneData();
    }
  } catch(_) {}

  // 进入"生成中"态：禁用输入框，显示提示
  el.disabled = true;
  el.classList.add('phone-camera-text-loading');
  const originalText = el.value;
  el.value = `[拍摄中（${w}×${h}）…\n这可能需要 20-60 秒，请耐心等待]`;

  try {
    // 直接把中文叙事 + 额外要求拼起来作为 prompt，喂给生图模型
    // 不做中转翻译——好的生图模型原生支持中文，多一道翻译反而丢信息
    // prompt 已在确认弹窗前拼好（drawPrompt）

    // 调生图 API
    el.value = `[拍摄中（${w}×${h}）…]`;
    const images = await API.generateImage(drawPrompt, { n: 1, size: `${w}x${h}` });
    if (!images || !images.length) throw new Error('没有返回图片');
    const dataUrl = images[0];

    // 存到 drawnImages 表（同步进收藏图库）
    const imageId = 'img_' + Utils.uuid();
    await DB.put('drawnImages', {
      id: imageId,
      dataUrl,
      prompt: drawPrompt,
      createdAt: new Date().toISOString()
    });

    // 存进相册（mode='ai_image'）
    const pd = await _getPhoneData();
    if (!pd) throw new Error('找不到手机数据');
    if (!Array.isArray(pd.album)) pd.album = [];
    const photo = {
      id: 'photo_' + Utils.uuid().slice(0, 8),
      mode: 'ai_image',
      text: currentText,   // 描述用 textarea 里那段（用户已经看过/编辑过）
      imageId,
      location,
      time: gameTime,
      createdAt: new Date().toISOString()
    };
    pd.album.push(photo);
    pd.cameraDraft = null;   // 出图后清草稿
    await _savePhoneData();

    // 记录手机操作日志（AI 视角：用户拍了一张照片）
    {
      const summary = currentText.length > 60 ? currentText.slice(0, 60) + '…' : currentText;
      const locPart = location ? `（${location}）` : '';
      _log(`拍了一张照片：${summary}${locPart}`);
    }

    // 恢复输入框 + toast + 切到相册
    el.value = currentText;
    UI.showToast('已存入相册', 1500);
    _cameraTab = 'album';
    const ppd = await _getPhoneData();
    if (ppd) { ppd.cameraTab = 'album'; _savePhoneData(); _renderCamera(ppd); }
  } catch(e) {
    console.warn('[Camera AI Draw] failed', e);
    el.value = originalText;
    UI.showToast(`拍摄失败：${e.message || '未知错误'}`, 2800);
  } finally {
    el.disabled = false;
    el.classList.remove('phone-camera-text-loading');
  }
}

// 快门：保存当前文本框内容到相册
async function _cameraShoot() {
  const el = document.getElementById('phone-camera-text');
  if (!el) return;
  const text = (el.value || '').trim();
  if (!text) { UI.showToast('画面是空的，写点什么再拍', 1500); return; }

  const pd = await _getPhoneData();
  if (!pd) return;
  if (!Array.isArray(pd.album)) pd.album = [];

  // 抓游戏内时间 + 地点作为快照
  let gameTime = '', location = '';
  try {
    const sb = Conversations.getStatusBar() || {};
    gameTime = sb.time || '';
    location = [sb.region, sb.location].filter(Boolean).join('·');
  } catch(_) {}

  const photo = {
    id: 'photo_' + Utils.uuid().slice(0, 8),
    mode: 'shoot',
    text,
    imageId: '',
    location,
    time: gameTime,
    createdAt: new Date().toISOString()
  };
  pd.album.push(photo);
  pd.cameraDraft = null;  // 拍完清草稿，下次进来会重新读最新状态栏
  await _savePhoneData();

  // 记录手机操作日志（AI 视角：用户拍了一张照片）
  {
    const summary = text.length > 60 ? text.slice(0, 60) + '…' : text;
    const locPart = location ? `（${location}）` : '';
    _log(`拍了一张照片：${summary}${locPart}`);
  }

  UI.showToast('已存入相册', 1200);
  // 闪一下快门动效（之后可以加）—— 这里轻量提示
}

// 点击相册中的某张照片：打开详情 overlay
async function _cameraOpenPhoto(id) {
  const pd = await _getPhoneData();
  if (!pd) return;
  const album = Array.isArray(pd.album) ? pd.album : [];
  const photo = album.find(p => p.id === id);
  if (!photo) { UI.showToast('照片已被删除', 1500); return; }
  _showPhotoDetail(photo);
}

// 朋友圈"从相册选"：弹一个相册图选择器，选中后把照片文字填进 imageDesc 框
async function _openAlbumPickerForMoment() {
  const pd = await _getPhoneData();
  const album = Array.isArray(pd?.album) ? pd.album : [];
  if (!album.length) {
    UI.showToast('相册还是空的，先去拍一张吧', 1800);
    return;
  }

  // 移除旧的 overlay
  const old = document.getElementById('phone-album-picker-overlay');
  if (old) old.remove();

  const sorted = album.slice().reverse();
  const cardsHtml = sorted.map(p => {
    const text = String(p.text || '').trim();
    const preview = text.length > 50 ? text.slice(0, 50) + '…' : text;
    const time = p.time || '';
    const location = p.location || '';
    return `
      <div class="phone-camera-polaroid" onclick="Phone._pickAlbumForMoment('${p.id}')" style="opacity:1">
        <div class="phone-camera-polaroid-frame">
          <div class="phone-camera-polaroid-content">${Utils.escapeHtml(preview || '(空)')}</div>
        </div>
        ${location ? `<div class="phone-camera-polaroid-loc">${Utils.escapeHtml(location)}</div>` : ''}
        ${time ? `<div class="phone-camera-polaroid-caption">${Utils.escapeHtml(time)}</div>` : ''}
      </div>
    `;
  }).join('');

  const overlay = document.createElement('div');
  overlay.id = 'phone-album-picker-overlay';
  overlay.className = 'phone-inner-modal';
  overlay.innerHTML = `
    <div class="modal-content phone-album-picker-card">
      <div class="phone-album-picker-header">
        <span style="font-size:14px;font-weight:600">从相册选一张</span>
        <button type="button" onclick="Phone._closeAlbumPicker()" class="phone-album-picker-close" aria-label="关闭">×</button>
      </div>
      <div class="phone-album-picker-grid">${cardsHtml}</div>
    </div>
  `;
  overlay.onclick = (e) => { if (e.target === overlay) _closeAlbumPicker(); };
  const shell = document.querySelector('#phone-modal .phone-shell');
  (shell || document.body).appendChild(overlay);
}

function _closeAlbumPicker() {
  const overlay = document.getElementById('phone-album-picker-overlay');
  if (overlay) overlay.remove();
}

async function _pickAlbumForMoment(id) {
  const pd = await _getPhoneData();
  const photo = pd?.album?.find(p => p.id === id);
  if (!photo) { UI.showToast('照片已被删除', 1500); return; }
  const el = document.getElementById('phone-moment-imgdesc');
  if (el) {
    el.value = photo.text || '';
    el.focus();
  }
  _closeAlbumPicker();
  UI.showToast('已填入', 1000);
}

// 聊天界面"图片"：调起本地文件选择器，选图后调识图模型，把描述发到聊天
function _openImagePickerForChat(contactId) {
  // 隐藏加号菜单
  const menu = document.getElementById('phone-chat-plus-menu');
  if (menu) menu.classList.add('hidden');

  // 创建隐藏的 file input
  let picker = document.getElementById('phone-chat-image-picker');
  if (!picker) {
    picker = document.createElement('input');
    picker.id = 'phone-chat-image-picker';
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.style.display = 'none';
    document.body.appendChild(picker);
  }
  picker.value = '';
  picker.onchange = () => _onChatImagePicked(contactId, picker);
  picker.click();
}

async function _onChatImagePicked(contactId, input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';

  try {
    // 读取为 base64 dataURL
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    let gameTime = '';
    const pd = await _getPhoneData();
    try { gameTime = _getChatGameTime(contactId, pd); } catch(_) {}
    if (!pd.chatThreads) pd.chatThreads = {};
    if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];

    // 存图片气泡，text 暂时为空占位，刷新时再调识图填充
    pd.chatThreads[contactId].push({
      id: 'm_' + Utils.uuid().slice(0, 8),
      role: 'me',
      text: '',          // 刷新时才填充
      type: 'real_image',
      imageBase64: base64,
      photoDesc: '',     // 刷新时才填充
      needsVision: true, // 标记：还未识图
      time: gameTime
    });

    await _savePhoneData();
    const _ctNameImg = (pd.chatContacts || []).find(c => c.id === contactId)?.name || contactId;
    _addChatMessageToRoundLog(contactId, 'me', `发送了图片`, gameTime, _ctNameImg);
    _renderChatThread(pd, contactId);
    UI.showToast('图片已添加，点刷新发送给对方', 1500);
  } catch(e) {
    UI.showToast('读取图片失败：' + (e.message || '未知'), 2500);
  }
}

// 聊天界面"相册"：弹一个相册图选择器，选中后发送图片到当前会话
async function _openAlbumPickerForChat(contactId) {
  const pd = await _getPhoneData();
  const album = Array.isArray(pd?.album) ? pd.album : [];
  if (!album.length) {
    UI.showToast('相册还是空的，先去拍一张吧', 1800);
    return;
  }

  // 移除旧的 overlay
  const old = document.getElementById('phone-album-picker-overlay');
  if (old) old.remove();

  const sorted = album.slice().reverse();
  const cardsHtml = sorted.map(p => {
    const text = String(p.text || '').trim();
    const preview = text.length > 50 ? text.slice(0, 50) + '…' : text;
    const time = p.time || '';
    const location = p.location || '';
    const isImage = p.mode === 'ai_image' && p.imageId;
    const innerHtml = isImage
      ? `<img class="phone-camera-polaroid-img" data-img-id="${Utils.escapeHtml(p.imageId)}" alt="生成的图片" />`
      : `<div class="phone-camera-polaroid-content">${Utils.escapeHtml(preview || '(空)')}</div>`;
    return `
      <div class="phone-camera-polaroid" onclick="Phone._pickAlbumForChat('${contactId}', '${p.id}')" style="opacity:1">
        <div class="phone-camera-polaroid-frame">
          ${innerHtml}
        </div>
        ${location ? `<div class="phone-camera-polaroid-loc">${Utils.escapeHtml(location)}</div>` : ''}
        ${time ? `<div class="phone-camera-polaroid-caption">${Utils.escapeHtml(time)}</div>` : ''}
      </div>
    `;
  }).join('');

  const overlay = document.createElement('div');
  overlay.id = 'phone-album-picker-overlay';
  overlay.className = 'phone-inner-modal';
  overlay.innerHTML = `
    <div class="modal-content phone-album-picker-card">
      <div class="phone-album-picker-header">
        <span style="font-size:14px;font-weight:600">发送相册图片</span>
        <button type="button" onclick="Phone._closeAlbumPicker()" class="phone-album-picker-close" aria-label="关闭">×</button>
      </div>
      <div class="phone-album-picker-grid">${cardsHtml}</div>
    </div>
  `;
  overlay.onclick = (e) => { if (e.target === overlay) _closeAlbumPicker(); };
  const shell = document.querySelector('#phone-modal .phone-shell');
  (shell || document.body).appendChild(overlay);
  
  // 处理异步图片加载
  setTimeout(() => {
    const imgs = overlay.querySelectorAll('img[data-img-id]');
    if (imgs.length > 0) {
      (async () => {
        for (const img of imgs) {
          const imgId = img.getAttribute('data-img-id');
          if (!imgId) continue;
          try {
            const doc = await DB.get('drawnImages', imgId);
            if (doc && doc.dataUrl) img.src = doc.dataUrl;
          } catch(e) {}
        }
      })();
    }
  }, 50);
}

async function _pickAlbumForChat(contactId, photoId) {
  const pd = await _getPhoneData();
  const photo = pd?.album?.find(p => p.id === photoId);
  if (!photo) { UI.showToast('照片已被删除', 1500); return; }
  
  _closeAlbumPicker();
  
  // 隐藏加号菜单
  const menu = document.getElementById('phone-chat-plus-menu');
  if (menu) menu.classList.add('hidden');
  
  // 构造发送到 AI 的文本和手机显示的特殊气泡类型
  const textDesc = photo.text || '(无描述)';
  const aiText = `{{user}}发送了一张图片，图片内容为：${textDesc}`;
  
  let gameTime = '';
  try { gameTime = _getChatGameTime(contactId, pd); } catch(_) {}

  // 保存到聊天记录
  if (!pd.chatThreads) pd.chatThreads = {};
  if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
  
  pd.chatThreads[contactId].push({
    id: 'm_' + Utils.uuid().slice(0, 8),
    role: 'me',
    text: aiText,
    type: 'photo',
    photoId: photoId,
    mode: photo.mode,
    imageId: photo.imageId,
    photoDesc: photo.text,
    time: gameTime
  });
  
  await _savePhoneData();
  const _ctNamePhoto = (pd.chatContacts || []).find(c => c.id === contactId)?.name || contactId;
  _addChatMessageToRoundLog(contactId, 'me', `发送了图片`, gameTime, _ctNamePhoto);
  
  // 只渲染气泡，不自动触发 AI 回复（等用户手动点刷新）
  _renderChatThread(pd, contactId);
}

// 聊天图片点击详情
async function _showChatPhotoDetail(contactId, msgId) {
  const pd = await _getPhoneData();
  if (!pd?.chatThreads?.[contactId]) return;
  const msg = pd.chatThreads[contactId].find(m => m.id === msgId);
  if (!msg) return;

  // 移除已有 overlay
  const old = document.getElementById('phone-photo-detail-overlay');
  if (old) old.remove();

  const isImage = msg.mode === 'ai_image';
  const text = msg.photoDesc || '';

  const bodyHtml = isImage
    ? `<div class="phone-photo-detail-image-wrap">
         <img class="phone-photo-detail-image" data-img-id="${Utils.escapeHtml(msg.imageId || '')}" alt="生成的图片" />
       </div>
       ${text ? `<div class="phone-photo-detail-img-caption">${Utils.escapeHtml(text)}</div>` : ''}`
    : `<div class="phone-photo-detail-text-immersive">${Utils.escapeHtml(text)}</div>`;

  const overlay = document.createElement('div');
  overlay.id = 'phone-photo-detail-overlay';
  overlay.className = 'phone-inner-modal';
  overlay.innerHTML = `
    <div class="modal-content phone-photo-detail-card">
      <button class="phone-photo-detail-close" onclick="Phone._closePhotoDetail()" aria-label="关闭">×</button>
      ${bodyHtml}
    </div>
  `;
  // 点蒙层关闭
  overlay.onclick = (e) => { if (e.target === overlay) _closePhotoDetail(); };

  const shell = document.querySelector('#phone-modal .phone-shell');
  (shell || document.body).appendChild(overlay);

  // 异步加载真图
  if (isImage && msg.imageId) {
    (async () => {
      try {
        const doc = await DB.get('drawnImages', msg.imageId);
        if (doc && doc.dataUrl) {
          const img = overlay.querySelector('img.phone-photo-detail-image');
          if (img) img.src = doc.dataUrl;
        }
      } catch(e) {}
    })();
  }
}

function _showPhotoDetail(photo) {
  // 移除已有 overlay
  const old = document.getElementById('phone-photo-detail-overlay');
  if (old) old.remove();

  const isImage = photo.mode === 'ai_image';
  const text = photo.text || '';
  const location = photo.location || '';
  const time = photo.time || '';

  // 操作按钮：文字照片 vs 图片照片
  const actionsHtml = isImage
    ? `
      <button class="phone-photo-action" onclick="Phone._photoEditText('${photo.id}')">编辑文字</button>
      <button class="phone-photo-action" onclick="Phone._photoCopyText('${photo.id}')">复制描述</button>
      <button class="phone-photo-action" onclick="Phone._photoDownloadImage('${photo.id}')">下载图片</button>
      <button class="phone-photo-action" onclick="Phone._photoShareMoment('${photo.id}')">发到朋友圈</button>
      <button class="phone-photo-action" onclick="Phone._photoShareMain('${photo.id}')">分享到主线</button>
      <button class="phone-photo-action phone-photo-action-danger" onclick="Phone._photoDelete('${photo.id}')">删除</button>
    `
    : `
      <button class="phone-photo-action" onclick="Phone._photoEditText('${photo.id}')">编辑文字</button>
      <button class="phone-photo-action" onclick="Phone._photoCopyText('${photo.id}')">复制文字</button>
      <button class="phone-photo-action" onclick="Phone._photoShareMoment('${photo.id}')">发到朋友圈</button>
      <button class="phone-photo-action" onclick="Phone._photoShareMain('${photo.id}')">分享到主线</button>
      <button class="phone-photo-action phone-photo-action-danger" onclick="Phone._photoDelete('${photo.id}')">删除</button>
    `;

  // 主体：图片或文字
  const bodyHtml = isImage
    ? `<div class="phone-photo-detail-image-wrap">
         <img class="phone-photo-detail-image" data-img-id="${Utils.escapeHtml(photo.imageId || '')}" alt="生成的图片" />
       </div>
       ${text ? `<div class="phone-photo-detail-img-caption">${Utils.escapeHtml(text)}</div>` : ''}`
    : `<div class="phone-photo-detail-text-immersive">${Utils.escapeHtml(text)}</div>`;

  const metaHtml = (location || time) ? `
    <div class="phone-photo-detail-meta">
      ${location ? `<div class="phone-photo-detail-meta-loc">${Utils.escapeHtml(location)}</div>` : ''}
      ${time ? `<div class="phone-photo-detail-meta-time">${Utils.escapeHtml(time)}</div>` : ''}
    </div>
  ` : '';

  const overlay = document.createElement('div');
  overlay.id = 'phone-photo-detail-overlay';
  overlay.className = 'phone-inner-modal';
  overlay.innerHTML = `
    <div class="modal-content phone-photo-detail-card">
      <button class="phone-photo-detail-close" onclick="Phone._closePhotoDetail()" aria-label="关闭">×</button>
      ${bodyHtml}
      ${metaHtml}
      <div class="phone-photo-detail-actions">
        ${actionsHtml}
      </div>
    </div>
  `;
  // 点蒙层关闭
  overlay.onclick = (e) => { if (e.target === overlay) _closePhotoDetail(); };

  const shell = document.querySelector('#phone-modal .phone-shell');
  (shell || document.body).appendChild(overlay);

  // 异步加载真图
  if (isImage && photo.imageId) {
    (async () => {
      try {
        const rec = await DB.get('drawnImages', photo.imageId);
        const imgEl = overlay.querySelector('.phone-photo-detail-image');
        if (!imgEl) return;
        if (rec && rec.dataUrl) {
          imgEl.src = rec.dataUrl;
        } else {
          imgEl.replaceWith(Object.assign(document.createElement('div'), {
            className: 'phone-photo-detail-img-missing',
            textContent: '图片已丢失'
          }));
        }
      } catch(_) {}
    })();
  }
}

function _closePhotoDetail() {
  const overlay = document.getElementById('phone-photo-detail-overlay');
  if (overlay) overlay.remove();
}

// 详情页操作 ——
async function _photoDownloadImage(id) {
  const pd = await _getPhoneData();
  const photo = pd?.album?.find(p => p.id === id);
  if (!photo || photo.mode !== 'ai_image' || !photo.imageId) {
    UI.showToast('这不是一张图片照片', 1500);
    return;
  }
  // 复用 chat.js 里现成的下载实现
  if (typeof Chat?.downloadImage === 'function') {
    Chat.downloadImage(photo.imageId);
    return;
  }
  // 兜底：自己写一遍
  try {
    const rec = await DB.get('drawnImages', photo.imageId);
    if (!rec || !rec.dataUrl) { UI.showToast('图片已丢失', 1500); return; }
    const ts = new Date(rec.createdAt || Date.now());
    const pad = n => String(n).padStart(2, '0');
    const fname = `tianshu_${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.png`;
    const a = document.createElement('a');
    a.href = rec.dataUrl;
    a.download = fname;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { document.body.removeChild(a); } catch(_) {} }, 100);
    UI.showToast('已保存到下载目录', 1500);
  } catch(e) {
    UI.showToast('保存失败：' + e.message, 2000);
  }
}

async function _photoEditText(id) {
  const pd = await _getPhoneData();
  const photo = pd?.album?.find(p => p.id === id);
  if (!photo) { UI.showToast('照片不存在', 1500); return; }
  const title = photo.mode === 'ai_image' ? '编辑图片描述' : '编辑照片文字';
  const newText = await UI.showSimpleInput(title, photo.text || '', {
    multiline: true,
    rows: 8,
    minHeight: '200px',
    allowEmpty: true
  });
  // 用户取消（null）
  if (newText === null) return;
  const trimmed = String(newText).trim();
  if (!trimmed) {
    if (typeof UI.showConfirm === 'function') {
      const ok = await UI.showConfirm('文字为空', '保存后这张照片将没有文字内容，确定要保存吗？');
      if (!ok) return;
    }
  }
  photo.text = trimmed;
  await _savePhoneData();
  // 重新渲染详情页 + 相册（如果在相册）
  _closePhotoDetail();
  _showPhotoDetail(photo);
  if (_cameraTab === 'album') {
    // 相册列表也要刷新 caption
    const albumEl = document.getElementById('phone-camera-album');
    if (albumEl) albumEl.innerHTML = _renderCameraAlbum(pd);
  }
  UI.showToast('已保存', 1000);
}

async function _photoCopyText(id) {
  const pd = await _getPhoneData();
  const photo = pd?.album?.find(p => p.id === id);
  if (!photo) return;
  try {
    await navigator.clipboard.writeText(photo.text || '');
    UI.showToast('已复制', 1000);
  } catch(_) { UI.showToast('复制失败', 1500); }
}

async function _photoDelete(id) {
  if (typeof UI.showConfirm === 'function') {
    const ok = await UI.showConfirm('删除这张照片？', '删除后无法恢复');
    if (!ok) return;
  }
  const pd = await _getPhoneData();
  if (!pd?.album) return;
  const photo = pd.album.find(p => p.id === id);
  // 如果是 ai_image 照片，顺手把 drawnImages 表里的图也删掉（节省 DB 空间）
  if (photo && photo.mode === 'ai_image' && photo.imageId) {
    try { await DB.del('drawnImages', photo.imageId); } catch(_) {}
  }
  pd.album = pd.album.filter(p => p.id !== id);
  await _savePhoneData();
  _closePhotoDetail();
  // 重新渲染相册页
  if (_cameraTab === 'album') _renderCamera(pd);
  UI.showToast('已删除', 1000);
}

// 发到朋友圈：跳转到 moments App + 调 _postMoment 预填
async function _photoShareMoment(id) {
  const pd = await _getPhoneData();
  const photo = pd?.album?.find(p => p.id === id);
  if (!photo) return;
  // 不管文字照片还是图片照片，都把内容填进"描述配图"，正文留空让用户写感想
  const prefill = { text: '', imageDesc: photo.text || '' };

  _closePhotoDetail();
  // 切到 moments App 并进入发动态页
  _currentApp = 'moments';
  document.querySelector('#phone-modal .phone-shell')?.classList.remove('phone-home-mode');
  document.getElementById('phone-back-btn')?.classList.remove('hidden');
  // 重置导航栈：以好友圈列表为底，发动态页推到栈上
  _navStack = [() => _renderMoments(pd)];
  await _postMoment(prefill);
}
function _photoShareMain(id) { UI.showToast('分享到主线功能开发中', 1500); }

function _renderMemo(pd) {
   const body = document.getElementById('phone-body');
   document.getElementById('phone-title').textContent = '备忘录';
   const memos = pd.memos || [];
    body.innerHTML = `
      <div style="padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <span style="font-size:13px;color:var(--text-secondary)">${memos.length} 条记录</span>
          <button onclick="Phone._addMemo()" style="background:var(--accent);color:#111;border:none;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer">+ 新建</button>
        </div>
        ${memos.length === 0 ? '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">还没有备忘录</p>' :
memos.map((m, i) => `
<div class="phone-memo-preview-card" onclick="Phone._editMemo(${i})">
  <div class="phone-memo-preview-title">${Utils.escapeHtml(m.title || '无标题')}</div>
  <div class="phone-memo-preview-meta">
  <span class="phone-memo-preview-line">${Utils.escapeHtml(m.time || '')}${m.time ? '　' : ''}${Utils.escapeHtml(m.content || '暂无正文')}</span>
</div>
</div>
`).join('')
}
      </div>
    `;
  }

  async function _addMemo() {
    const pd = await _getPhoneData();
    if (!pd) return;
    // 抓主线最近时间
    const msgs = Chat.getMessages();
    let gameTime = '';
    try {
      const sb = Conversations.getStatusBar();
      gameTime = sb?.time || sb?.date || '';
    } catch(e) {}
    const memo = {
      id: 'memo_' + Utils.uuid().slice(0, 8),
      title: '',
      content: '',
      time: gameTime,
      createdAt: new Date().toISOString()
    };
    pd.memos.unshift(memo);
    await _savePhoneData();
    _editMemo(0);
  }

  async function _editMemo(index) {
    const pd = await _getPhoneData();
    if (!pd || !pd.memos[index]) return;
    const m = pd.memos[index];
    // push 编辑页到导航栈
    _pushNav(() => _editMemo(index));
    const body = document.getElementById('phone-body');
    document.getElementById('phone-title').textContent = '编辑备忘录';
    body.innerHTML = `
      <div class="phone-memo-edit-page" style="padding:12px;display:flex;flex-direction:column;gap:8px;height:100%">
        <input id="phone-memo-title" value="${Utils.escapeHtml(m.title || '')}" placeholder="标题" style="border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg-tertiary);color:var(--text);font-size:14px">
        <input id="phone-memo-time" value="${Utils.escapeHtml(m.time || '')}" placeholder="时间" style="border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg-tertiary);color:var(--text);font-size:12px">
        <textarea id="phone-memo-content" placeholder="写点什么…" style="flex:1;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg-tertiary);color:var(--text);font-size:13px;resize:none;min-height:120px">${Utils.escapeHtml(m.content || '')}</textarea>
        <div class="phone-memo-edit-actions">
<button onclick="Phone._saveMemo(${index})" class="phone-memo-save-btn">保存</button>
<button onclick="Phone._collectMemo(${index})" class="phone-memo-action-btn">${_uiIcon('star', 14)} 收藏</button>
<button onclick="Phone._shareMemo(${index})" class="phone-memo-action-btn">${_uiIcon('share', 14)} 分享</button>
<button onclick="Phone._deleteMemo(${index})" class="phone-memo-action-btn danger">${_uiIcon('trash', 14)} 删除</button>
</div>
      </div>
    `;
  }

  async function _saveMemo(index) {
    const pd = await _getPhoneData();
    if (!pd || !pd.memos[index]) return;
    const title = document.getElementById('phone-memo-title')?.value.trim() || '';
    const content = document.getElementById('phone-memo-content')?.value.trim() || '';
    const time = document.getElementById('phone-memo-time')?.value.trim() || '';

    // 如果标题和正文都为空，自动删除这条
    if (!title && !content) {
      pd.memos.splice(index, 1);
      await _savePhoneData();
      UI.showToast('空备忘录已自动删除', 1000);
      _renderMemo(pd);
      return;
    }

    const isNew = !pd.memos[index].title && !pd.memos[index].content; // 之前是空的=新增
    pd.memos[index].title = title;
    pd.memos[index].content = content;
    pd.memos[index].time = time;
    await _savePhoneData();

    // 操作日志：标题 + 正文摘要
    const snippet = content.length > 30 ? content.substring(0, 30) + '…' : content;
    if (isNew) {
      _log(`新增了备忘录：标题「${title || '无标题'}」，内容摘要：${snippet || '（空）'}`);
    } else {
      _log(`更新了备忘录：标题「${title || '无标题'}」，内容摘要：${snippet || '（空）'}`);
    }
    UI.showToast('已保存', 1000);
    _renderMemo(pd);
  }

  async function _deleteMemo(index) {
const pd = await _getPhoneData();
if (!pd || !pd.memos[index]) return;
if (!await UI.showConfirm('删除备忘录', '确定删除这条备忘录？')) return;
_log('删除了一条备忘录');
pd.memos.splice(index, 1);
await _savePhoneData();
_renderMemo(pd);
}

  function _formatPhoneTime(t) {
    const s = String(t || '').trim();
    if (!s) return '';
    const m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(星期[一二三四五六日天])?\s*(\d{1,2}:\d{2})?/);
    if (m) {
      const mm = String(m[2]).padStart(2, '0');
      const dd = String(m[3]).padStart(2, '0');
      return `${m[1]}.${mm}.${dd}${m[4] ? ' ' + m[4] : ''}${m[5] ? ' ' + m[5] : ''}`.trim();
    }
    return s;
  }

  // 把游戏时间字符串解析为可比较的数字（yyyymmddHHMM），解析失败返回 0
  function _parsePhoneTimeScore(t) {
    const s = String(t || '').trim();
    if (!s) return 0;
    // 格式1：YYYY.MM.DD 星期X HH:mm
    let m = s.match(/(\d{4})\.(\d{2})\.(\d{2})(?:\s+星期[一二三四五六日天])?(?:\s+(\d{1,2}):(\d{2}))?/);
    if (m) {
      const hh = String(m[4] || '0').padStart(2, '0');
      const mm2 = String(m[5] || '0').padStart(2, '0');
      return parseInt(`${m[1]}${m[2]}${m[3]}${hh}${mm2}`, 10);
    }
    // 格式2：YYYY年MM月DD日 星期X HH:mm
    m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+星期[一二三四五六日天])?(?:\s+(\d{1,2}):(\d{2}))?/);
    if (m) {
      const mo = String(m[2]).padStart(2, '0');
      const dd = String(m[3]).padStart(2, '0');
      const hh = String(m[4] || '0').padStart(2, '0');
      const mm2 = String(m[5] || '0').padStart(2, '0');
      return parseInt(`${m[1]}${mo}${dd}${hh}${mm2}`, 10);
    }
    return 0;
  }

  // 获取当前聊天场景下最合适的游戏时间（取状态栏、thread最新消息、全局基准三者中最大）
  function _getChatGameTime(contactId, pd) {
    const candidates = [];

    // 1. 状态栏时间
    try {
      const sb = (typeof Conversations !== 'undefined') ? Conversations.getStatusBar() : null;
      if (sb?.time) candidates.push(_formatPhoneTime(sb.time));
    } catch(_) {}

    // 2. 全局基准时间
    if (_chatSessionBaseTime) candidates.push(_chatSessionBaseTime);

    // 3. thread 中最新一条有时间的消息
    try {
      const thread = pd?.chatThreads?.[contactId] || [];
      for (let i = thread.length - 1; i >= 0; i--) {
        if (thread[i].time) { candidates.push(thread[i].time); break; }
      }
    } catch(_) {}

    if (!candidates.length) return '';
    // 取分数最大（最新）的
    return candidates.reduce((best, t) =>
      _parsePhoneTimeScore(t) >= _parsePhoneTimeScore(best) ? t : best
    , candidates[0]);
  }

  // 抓当前游戏时间（来自状态栏；统一供搜索记录等使用）
  function _getGameTime() {
    try {
      const sb = (typeof Conversations !== 'undefined') ? Conversations.getStatusBar() : null;
      if (sb?.time) return _formatPhoneTime(sb.time);
    } catch(_) {}
    try {
      const msgs = (typeof Chat !== 'undefined' && Chat.getMessages) ? Chat.getMessages() : [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== 'assistant') continue;
        const m = String(msgs[i].content || '').match(/\d{4}年\d{1,2}月\d{1,2}日[^\n]*/);
        if (m) return _formatPhoneTime(m[0]);
      }
    } catch(_) {}
    return '';
  }

  // 搜索记录时间戳的友好显示：
  // - ISO 格式（2026-05-10T12:03:33.xxx）→ 裁成 "05-10 12:03"
  // - 游戏时间（2065年3月27日 星期五 19:06）→ 原样展示
  function _fmtHistoryTime(t) {
    if (!t) return '';
    if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return t.substring(5, 16).replace('T', ' ');
    return t;
  }

  // ===== 轨迹记录（由 statusBar 变化触发） =====
  async function recordLocation(location, time) {
    if (!location) return;
    const pd = await _getPhoneData();
    if (!pd) return;
    const last = pd.locationHistory[pd.locationHistory.length - 1];
    if (last && last.location === location) return; // 没变就不记
    pd.locationHistory.push({ location, time: time || '', createdAt: new Date().toISOString() });
    if (pd.locationHistory.length > 50) pd.locationHistory.shift(); // 保留最近50条
    await _savePhoneData();
  }

  // ===== 查手机数据打包 =====
  async function buildPhoneDataForAI(options = {}) {
    const { includeShopping = false } = options;
    const pd = await _getPhoneData();
    if (!pd) return '';
    const parts = [];

    // 1. 信息载体搜索记录（上限10条）
    const fSearches = (pd.forumSearchHistory || []).slice(-10);
    if (fSearches.length > 0) {
      parts.push(`【${_getForumName()}搜索记录】\n` + fSearches.map(s => `- ${s.query || ''}`).join('\n'));
    }

    // 2. 最近2条帖子详情浏览（标题+摘要+正文）
    const fViews = (pd.forumViewHistory || []).slice(-2);
    if (fViews.length > 0) {
      parts.push('【最近浏览的帖子详情】\n' + fViews.map(v => {
        let s = `标题：${v.title || '无标题'}`;
        if (v.summary) s += `\n摘要：${v.summary}`;
        if (v.content) s += `\n正文：${v.content}`;
        return s;
      }).join('\n---\n'));
    }

    // 3. 地图搜索记录（上限10条）
    const mSearches = (pd.mapSearchHistory || []).slice(-10);
    if (mSearches.length > 0) {
      parts.push('【地图搜索记录】\n' + mSearches.map(s => `- ${s.query || ''}`).join('\n'));
    }

    // 4. 行动轨迹（上限10条）
    const locs = (pd.locationHistory || []).slice(-10);
    if (locs.length > 0) {
      parts.push('【行动轨迹】\n' + locs.map(l => `${l.time || ''} → ${l.location || ''}`).join('\n'));
    }

    // 5. 最近2条用户好友圈动态（正文+配图描述+评论区）
    const myMoms = (pd.moments || []).slice(0, 2);
    if (myMoms.length > 0) {
      parts.push('【用户最近发的好友圈动态】\n' + myMoms.map(m => {
        let s = `[${m.time || ''}] ${m.text || ''}`;
        if (m.imageDesc) s += `\n（配图描述：${m.imageDesc}）`;
        else if (m.image) s += '\n（附带了一张图片）';
        if (m.visibleNpcs && m.visibleNpcs.length > 0) s += `\n（对 ${m.visibleNpcs.join('、')} 可见）`;
        if (m.comments && m.comments.length > 0) {
          s += '\n评论：\n' + m.comments.map(c => `  ${c.name || ''}：${c.text || ''}`).join('\n');
        }
        return s;
      }).join('\n---\n'));
    }

    // 6. 最新好友动态（最近一次刷新结果的全部）
    const npcMoms = pd.npcMoments || [];
    if (npcMoms.length > 0) {
      parts.push('【当前好友圈页面显示的好友动态】\n' + npcMoms.map(m => {
        let s = `${m.npc || ''}：${m.text || ''}`;
        if (m.comments && m.comments.length > 0) {
          s += '\n评论：\n' + m.comments.map(c => `  ${c.name || ''}：${c.text || ''}`).join('\n');
        }
        return s;
      }).join('\n---\n'));
    }

    // 7. 外卖/网购数据（仅 includeShopping=true 时输出，预留给"心动模拟·黑化值·强制查手机"剧情爆点）
    // 平时不输出，避免提前剧透"原来不光我有礼物"的爆点。
    if (includeShopping) {
      // 7a. 饿了咪（外卖）
      const tkSearches = (pd.takeoutSearchHistory || []).slice(0, 10); // unshift 入栈，最新在前
      const tkOrders = (pd.takeoutOrders || []).slice(-5).reverse();   // push 入栈，最新在末尾
      if (tkSearches.length > 0 || tkOrders.length > 0) {
        const subParts = [];
        if (tkSearches.length > 0) {
          subParts.push('搜索记录（最近10条）：\n' + tkSearches.map(s => `- ${s.query || ''}${s.time ? '（' + s.time + '）' : ''}`).join('\n'));
        }
        if (tkOrders.length > 0) {
          subParts.push('订单记录（最近5条）：\n' + tkOrders.map(o => {
            const forWho = o.target === '自己' ? '给自己' : `送给${o.target}`;
            const priceStr = o.price ? `¥${o.price}` : '';
            let s = `- ${o.name || ''}${priceStr ? '，' + priceStr : ''}，${forWho}`;
            if (o.shop) s += `，店铺：${o.shop}`;
            if (o.desc) s += `（${o.desc}）`;
            if (o.time) s += `；下单于 ${o.time}`;
            return s;
          }).join('\n'));
        }
        parts.push(`【${_getShopCfg('takeout').title}APP（外卖）】\n` + subParts.join('\n\n'));
      }

      // 7b. 桃宝（网购）
      const shSearches = (pd.shopSearchHistory || []).slice(0, 10);
      const shOrders = (pd.shopOrders || []).slice(-5).reverse();
      if (shSearches.length > 0 || shOrders.length > 0) {
        const subParts = [];
        if (shSearches.length > 0) {
          subParts.push('搜索记录（最近10条）：\n' + shSearches.map(s => `- ${s.query || ''}${s.time ? '（' + s.time + '）' : ''}`).join('\n'));
        }
        if (shOrders.length > 0) {
          subParts.push('订单记录（最近5条）：\n' + shOrders.map(o => {
            const forWho = o.target === '自己' ? '给自己' : `送给${o.target}`;
            const priceStr = o.price ? `¥${o.price}` : '';
            let s = `- ${o.name || ''}${priceStr ? '，' + priceStr : ''}，${forWho}`;
            if (o.shop) s += `，店铺：${o.shop}`;
            if (o.desc) s += `（${o.desc}）`;
            if (o.time) s += `；下单于 ${o.time}`;
            return s;
          }).join('\n'));
        }
        parts.push(`【${_getShopCfg('shop').title}APP（网购）】\n` + subParts.join('\n\n'));
      }
    }

    // 8. 最近的聊天记录（每个联系人最近5轮对话，按 AI 回复的 roundId 分组）
    const chatContacts = (pd.chatContacts || []).slice(0, 10);
    const chatRecords = [];
    for (const contact of chatContacts) {
      const thread = (pd.chatThreads && pd.chatThreads[contact.id]) || [];
      if (!thread.length) continue;

      // 找出所有 AI 回复的 roundId（them 消息），保留最近5个
      const aiRoundIds = [];
      const seenRids = new Set();
      for (let i = thread.length - 1; i >= 0; i--) {
        const m = thread[i];
        if (m.role === 'them' && m.roundId && !seenRids.has(m.roundId)) {
          seenRids.add(m.roundId);
          aiRoundIds.unshift(m.roundId);
          if (aiRoundIds.length >= 5) break;
        }
      }

      // 找第一个要显示的 roundId 对应的 me 消息起始位置
      let startIdx = 0;
      if (aiRoundIds.length > 0) {
        const firstAiRid = aiRoundIds[0];
        // 往前找：属于这个 AI roundId 的 me 消息（同一轮用户发的消息）
        // me 消息的 roundId 是独立的，所以找这条 AI 回复之前最近的 me 消息起点
        const firstAiIdx = thread.findIndex(m => m.role === 'them' && m.roundId === firstAiRid);
        // 往前取 me 消息（直到上一个 AI roundId 或开头）
        startIdx = firstAiIdx;
        for (let i = firstAiIdx - 1; i >= 0; i--) {
          if (thread[i].role === 'them') break; // 遇到上一轮 AI 回复就停
          startIdx = i;
        }
      }

      const relevant = thread.slice(startIdx);
      if (!relevant.length) continue;

      const lines = relevant.map(m => {
        if (m.role === 'system') return `  [系统] ${m.text || ''}`;
        const who = m.role === 'me' ? '{{user}}' : contact.name;
        const timeStr = m.time ? ` [${m.time}]` : '';
        return `  ${who}${timeStr}：${m.text || ''}`;
      });
      chatRecords.push(`【${contact.name}的聊天记录（最近${aiRoundIds.length}轮）】\n${lines.join('\n')}`);
    }
    if (chatRecords.length > 0) {
      parts.push('【手机聊天记录】\n' + chatRecords.join('\n\n'));
    }

    // 9. 最近2条备忘录（完整内容）
    const memos = (pd.memos || []).slice(0, 2);
    if (memos.length > 0) {
      parts.push('【最近的备忘录】\n' + memos.map(m => {
        let s = `标题：${m.title || '无标题'}`;
        if (m.time) s += `\n时间：${m.time}`;
        if (m.content) s += `\n内容：${m.content}`;
        return s;
      }).join('\n---\n'));
    }

    return parts.length > 0 ? '[以下是用户手机中的内容]\n\n' + parts.join('\n\n') : '';
  }

  // ===== 外卖 / 网购 共用模块 =====
  // 两者数据结构完全一致，仅提示词/时效/文案不同。通过 kind ('takeout'|'shop') 切换。
  // SHOP_CFG 为默认配置；世界观可以通过 phoneApps.{takeout,shop}.{name,desc} 覆盖 title/logPrefix/systemRole/extraFields。
  const DEFAULT_SHOP_CFG = {
    takeout: {
 title: '饿了咪',
 searchPlaceholder: '搜索商品（如：麻辣烫、奶茶…）',
 customHint: '自己写一单（比如店里没有但你就想要的）',
 emptyHint: '点击刷新按钮看推荐',
 logPrefix: '饿了咪',
 customBtnText: '自定义商品',
       // 数据字段
      cachedField: 'takeoutCachedItems',
      queryField: 'takeoutLastQuery',
      historyField: 'takeoutSearchHistory',
      ordersField: 'takeoutOrders',
      // AI prompt 用
       systemRole: '"饿了咪"外卖平台推荐引擎（"饿了么"的萌化山寨版，剧情中可直接称作饿了咪）',
       itemNoun: '商品',
       extraFields: '请生成符合当前世界观背景的外卖商品（一般是餐食/饮品/小吃等日常短时效商品）',
      priceHint: '价格合理（约 10~80）',
      currency: '¥',
    },
    shop: {
 title: '桃宝',
 searchPlaceholder: '搜索商品（如：衣服、手办…）',
 customHint: '自己写一单（比如店里没有但你就想要的）',
 emptyHint: '点击刷新按钮看推荐',
 logPrefix: '桃宝',
 customBtnText: '自定义商品',
       cachedField: 'shopCachedItems',
      queryField: 'shopLastQuery',
      historyField: 'shopSearchHistory',
      ordersField: 'shopOrders',
      systemRole: '"桃宝"网购平台推荐引擎（"淘宝"的萌化山寨版，剧情中可直接称作桃宝）',
      itemNoun: '商品',
      extraFields: '请生成符合当前世界观背景的网购商品（可以是服饰/日用/数码/周边/礼品等长时效物品）',
      priceHint: '价格合理（约 10~9999，注意日用便宜、数码贵一些）',
      currency: '¥',
    }
  };
  // 兼容旧引用
  const SHOP_CFG = DEFAULT_SHOP_CFG;

  // 当前世界观对商城/信息载体的覆写（名字/描述）；open() 时异步加载
  let _shopMeta = {
    takeout: { name: '', desc: '' },
    shop: { name: '', desc: '' },
    forum: { name: '', desc: '' }
  };

  async function _loadShopMeta() {
    try {
      const wv = (typeof Worldview !== 'undefined' && Worldview.getCurrent) ? await Worldview.getCurrent() : null;
      const pa = wv?.phoneApps || {};
      _shopMeta = {
        takeout: {
          name: ((pa.takeout?.name) || '').trim(),
          desc: ((pa.takeout?.desc) || '').trim()
        },
        shop: {
          name: ((pa.shop?.name) || '').trim(),
          desc: ((pa.shop?.desc) || '').trim()
        },
        forum: {
          name: ((pa.forum?.name) || '').trim(),
          desc: ((pa.forum?.desc) || '').trim()
        }
      };
    } catch(_) {
      _shopMeta = { takeout: { name: '', desc: '' }, shop: { name: '', desc: '' }, forum: { name: '', desc: '' } };
    }
  }

  // 信息载体（默认"论坛"，留空回落）
  function _getForumName() { return _shopMeta?.forum?.name || '论坛'; }
  function _getForumDesc() { return _shopMeta?.forum?.desc || ''; }

  function _getShopCfg(kind) {
    const def = DEFAULT_SHOP_CFG[kind];
    const meta = _shopMeta[kind] || {};
    if (!meta.name && !meta.desc) return def;
    const merged = { ...def };
    if (meta.name) {
      merged.title = meta.name;
      merged.logPrefix = meta.name;
      if (kind === 'takeout') {
        merged.systemRole = `"${meta.name}"外卖/餐饮/短时效美食推荐平台`;
      } else {
        merged.systemRole = `"${meta.name}"网购/长时效商品推荐平台`;
      }
      // UI 文案不动；默认 searchPlaceholder/customHint/customBtnText 两边已统一
    }
    if (meta.desc) {
      merged.extraFields = meta.desc;
    }
    return merged;
  }

  let _shopTab = 'items'; // 'items' | 'search' | 'orders'
  let _shopCurrentKind = 'takeout';

  function _renderShopping(pd, kind) {
    _shopCurrentKind = kind;
    const cfg = _getShopCfg(kind);
    const body = document.getElementById('phone-body');
    document.getElementById('phone-title').textContent = cfg.title;
    const items = pd[cfg.cachedField] || [];
    const searches = pd[cfg.historyField] || [];
    const orders = pd[cfg.ordersField] || [];

    const itemsHtml = items.length > 0 ? _renderShopItemsHtml(items, kind)
      : `<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">${cfg.emptyHint}</p>`;
    const searchHistoryHtml = searches.length > 0
? searches.map((s, i) => `
<div class="phone-map-track-card" onclick="Phone._shopRepeatSearch('${kind}', ${i})" style="cursor:pointer;position:relative">
<div class="phone-map-track-location">${Utils.escapeHtml(s.query || '')}</div>
<div class="phone-map-track-time">${Utils.escapeHtml(s.time || '')}</div>
<span onclick="event.stopPropagation();Phone._deleteShopSearch('${kind}', ${i})" class="phone-share-mini" style="position:absolute;top:6px;right:8px;color:var(--error)" title="删除">${_uiIcon('trash', 13)}</span>
</div>`).join('')
: '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">暂无搜索记录</p>';
    const ordersHtml = orders.length > 0 ? _renderShopOrdersHtml(orders, kind)
      : '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">暂无订单</p>';

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%">
        <div id="phone-shop-items-panel" style="flex:1;overflow-y:auto;padding:12px;display:${_shopTab === 'items' ? 'block' : 'none'}">
          <div class="phone-map-searchbar" style="margin-bottom:10px">
            <div class="phone-map-search-input-wrap">
              ${_uiIcon('search', 12)}
              <input id="phone-shop-search" type="text" placeholder="${Utils.escapeHtml(cfg.searchPlaceholder)}" value="${Utils.escapeHtml(pd[cfg.queryField] || '')}">
            </div>
            <button onclick="Phone._shopSearch('${kind}')" class="phone-map-search-btn">搜索</button>
          </div>
          <div style="display:flex;gap:6px;margin-bottom:10px">
            <button onclick="Phone._shopRefresh('${kind}')" style="flex:1;padding:7px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px">${_uiIcon('refresh', 12)} 刷新推荐</button>
            <button onclick="Phone._shopOpenCustomModal('${kind}')" style="flex:1;padding:7px;font-size:12px;background:var(--accent);color:#111;border:none;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px">+ ${Utils.escapeHtml(cfg.customBtnText)}</button>
          </div>
          <div id="phone-shop-items">${itemsHtml}</div>
        </div>
<div id="phone-shop-search-panel" style="flex:1;overflow-y:auto;padding:12px;display:${_shopTab === 'search' ? 'block' : 'none'}">
            <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">共 ${searches.length} 条搜索记录</div>
            ${searchHistoryHtml}
          </div>
        <div id="phone-shop-orders-panel" style="flex:1;overflow-y:auto;padding:12px;display:${_shopTab === 'orders' ? 'block' : 'none'}">
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">共 ${orders.length} 个订单</div>
          ${ordersHtml}
        </div>
        <div class="phone-tabbar">
          <div class="phone-tab ${_shopTab === 'items' ? 'active' : ''}" onclick="Phone._switchShopTab('items')">商品</div>
          <div class="phone-tab ${_shopTab === 'search' ? 'active' : ''}" onclick="Phone._switchShopTab('search')">搜索记录</div>
          <div class="phone-tab ${_shopTab === 'orders' ? 'active' : ''}" onclick="Phone._switchShopTab('orders')">订单</div>
        </div>
      </div>
    `;
  }

  function _renderShopLoadingHtml() {
    return Array.from({ length: 4 }).map(() => `
      <div class="wv-skeleton-card" style="padding:10px 12px">
        <div class="wv-skeleton-line title" style="width:58%;margin-bottom:8px"></div>
        <div class="wv-skeleton-line summary-1" style="width:82%;margin-bottom:5px"></div>
        <div class="wv-skeleton-line summary-2" style="width:64%;margin-bottom:10px"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div class="wv-skeleton-line time" style="width:52px;height:18px;border-radius:999px"></div>
          <div style="display:flex;gap:6px;flex:1;justify-content:flex-end">
            <div class="wv-skeleton-line time" style="width:56px;height:22px;border-radius:6px"></div>
            <div class="wv-skeleton-line time" style="width:56px;height:22px;border-radius:6px"></div>
          </div>
        </div>
      </div>`).join('');
  }

  function _renderShopItemsHtml(items, kind) {
    return items.map((it, idx) => `
      <div class="phone-map-result-card">
        <div class="phone-map-result-head">
          <div class="phone-map-result-name">${Utils.escapeHtml(it.name || '未命名')}</div>
        </div>
        ${it.shop ? `<div class="phone-map-result-address">${_uiIcon('pin', 12)}<span>${Utils.escapeHtml(it.shop)}</span></div>` : ''}
        ${it.desc ? `<div class="phone-map-result-desc">${Utils.escapeHtml(it.desc)}</div>` : ''}
        <div class="phone-map-result-foot">
          <div class="phone-map-result-foot-left">
            <span class="phone-map-distance-pill">¥ ${Utils.escapeHtml(String(it.price || '--'))}</span>
          </div>
          <div class="phone-map-result-actions">
        <button type="button" onclick="Phone._shopBuyForSelf('${kind}', ${idx})" class="phone-map-action-btn" title="给自己买">${_uiIcon('star', 12)} 给自己买</button>
        <button type="button" onclick="Phone._shopBuyForTarget('${kind}', ${idx})" class="phone-map-action-btn" title="给角色买">${_uiIcon('pen', 12)} 给TA买</button>
        <button type="button" onclick="Phone._shopShareItem('${kind}', ${idx})" class="phone-map-action-btn" title="分享到主线">${_uiIcon('share', 12)} 分享</button>
      </div>
        </div>
      </div>`).join('');
  }

  function _renderShopOrdersHtml(orders, kind) {
    return orders.slice().reverse().map(o => {
      const targetLabel = o.target === '自己' ? '自己' : `→ ${o.target}`;
      return `
        <div class="phone-map-result-card">
          <div class="phone-map-result-head">
            <div class="phone-map-result-name">${Utils.escapeHtml(o.name || '')}</div>
          </div>
          ${o.shop ? `<div class="phone-map-result-address">${_uiIcon('pin', 12)}<span>${Utils.escapeHtml(o.shop)}</span></div>` : ''}
          ${o.desc ? `<div class="phone-map-result-desc">${Utils.escapeHtml(o.desc)}</div>` : ''}
          <div class="phone-map-result-foot">
  <div class="phone-map-result-foot-left">
    <span class="phone-map-distance-pill">¥ ${Utils.escapeHtml(String(o.price || '--'))}</span>
    <span class="phone-map-distance-pill">${Utils.escapeHtml(targetLabel)}</span>
  </div>
</div>
<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
  <span style="font-size:10px;color:var(--text-secondary)">下单于 ${Utils.escapeHtml(o.time || '')}</span>
  <button type="button" onclick="Phone._shopDeleteOrder('${kind}','${o.id}')" class="phone-map-action-btn danger">${_uiIcon('trash', 12)} 删除</button>
</div>
        </div>`;
    }).join('');
  }

  async function _switchShopTab(tab) {
    _shopTab = tab;
    const pd = await _getPhoneData();
    if (pd) _renderShopping(pd, _shopCurrentKind);
  }

  

  // 刷新推荐
  async function _shopRefresh(kind) {
    const cfg = _getShopCfg(kind);
    const pd = await _getPhoneData();
    if (!pd) return;

    const mainConfig = await API.getConfig();
    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const url = (funcConfig.apiUrl || mainConfig.apiUrl).replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) { UI.showToast('请先配置功能模型'); return; }

    UI.showToast(`正在刷新${cfg.title}推荐…`, 1200);
    _shopTab = 'items';
    if (_isAppStillActive(kind)) {
      const container = document.getElementById('phone-shop-items');
      if (container) container.innerHTML = _renderShopLoadingHtml();
    }
    const fullCtx = await _buildFullContext();
    const systemPrompt = `你是${cfg.systemRole}。根据当前世界观设定、用户处境（所在地区/身份/消费水平）生成 6~10 个${cfg.itemNoun}推荐。${cfg.extraFields}。${cfg.priceHint}。

严格要求（这是一个客观的商品推荐页面，不是剧情内容）：
1. 商品名、店铺名、商品描述都必须是中立客观的商品信息，只描述商品本身的外观、材质、功能、卖点。
2. 禁止商品名/店铺/描述中出现任何角色姓名（包括 NPC 和用户角色）。
3. 禁止在描述中提及剧情事件、角色关系、用户处境的具体内容（例如“刚刚xx给你点了”“xx送的”“最近你心情不好”这类剧情化文案）。
4. 可以使用世界观的通用地名、通用流行语、通用职业/阶层词汇，让商品贴合世界观氛围（例如科幻世界观下的“合成蛋白”“星际咖啡”这类通用品类名）。
5. desc 只写商品本身（例如“手工慢烤的芝士面包，表皮酥脆”），不写购买建议或推荐理由。
6. price 必须是纯数字字符串，不带任何货币符号或单位；货币样式由前端统一处理。

返回纯JSON数组，不要任何额外文字：
[{"name":"商品名","shop":"店铺名","desc":"商品描述（写商品外观、材质、口味、效果、用途等本身相关信息）","price":"纯数字"}]

${fullCtx}`;

    try {
      const results = await _phoneJsonArrayWithRetry({
        label: `${cfg.title}刷新`, url, key, model,
        temperature: 0.85, max_tokens: 5000, maxRetries: 3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请生成 6~10 条${cfg.itemNoun}推荐。` }
        ]
      });
      pd[cfg.cachedField] = results.slice(0, 10);
      await _savePhoneData();
      _log(`在${cfg.title}APP刷新了推荐（${results.length}条）`);
      if (_isAppStillActive(kind)) _renderShopping(pd, kind);
      UI.showToast('已刷新推荐', 1200);
    } catch(e) {
      UI.showToast(`刷新失败：${e.message}`, 2500);
    }
  }

  // 搜索
  async function _shopSearch(kind) {
    const cfg = _getShopCfg(kind);
    const input = document.getElementById('phone-shop-search');
    const query = (input?.value || '').trim();
    if (!query) { UI.showToast('请输入搜索关键词', 1200); return; }

    const pd = await _getPhoneData();
    if (!pd) return;

    const mainConfig = await API.getConfig();
    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const url = (funcConfig.apiUrl || mainConfig.apiUrl).replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) { UI.showToast('请先配置功能模型'); return; }

    UI.showToast(`正在搜索「${query}」…`, 1500);
    _shopTab = 'items';
    if (_isAppStillActive(kind)) {
      const container = document.getElementById('phone-shop-items');
      if (container) container.innerHTML = _renderShopLoadingHtml();
    }
    const fullCtx = await _buildFullContext();
    const systemPrompt = `你是${cfg.systemRole}。根据用户搜索关键词和当前世界观设定、用户处境（所在地区/身份/消费水平）生成 6~10 个相关${cfg.itemNoun}。${cfg.extraFields}。${cfg.priceHint}。

严格要求（这是一个客观的商品搜索页面，不是剧情内容）：
1. 商品名、店铺名、商品描述都必须是中立客观的商品信息，只描述商品本身的外观、材质、功能、卖点。
2. 禁止商品名/店铺/描述中出现任何角色姓名（包括 NPC 和用户角色）。
3. 禁止在描述中提及剧情事件、角色关系、用户处境的具体内容（例如“刚刚xx给你点了”“xx送的”“最近你心情不好”这类剧情化文案）。
4. 可以使用世界观的通用地名、通用流行语、通用职业/阶层词汇，让商品贴合世界观氛围（例如科幻世界观下的“合成蛋白”“星际咖啡”这类通用品类名）。
5. desc 只写商品本身（例如“手工慢烤的芝士面包，表皮酥脆”），不写购买建议或推荐理由。
6. price 必须是纯数字字符串，不带任何货币符号或单位；货币样式由前端统一处理。

返回纯JSON数组，不要任何额外文字：
[{"name":"商品名","shop":"店铺名","desc":"商品描述（写商品外观、材质、口味、效果、用途等本身相关信息）","price":"纯数字"}]

${fullCtx}`;

    try {
      const results = await _phoneJsonArrayWithRetry({
        label: `${cfg.title}搜索`, url, key, model,
        temperature: 0.8, max_tokens: 5000, maxRetries: 3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `搜索关键词：${query}\n请生成 6~10 条相关${cfg.itemNoun}。` }
        ]
      });
      pd[cfg.cachedField] = results.slice(0, 10);
      pd[cfg.queryField] = query;
      // 写搜索历史
      pd[cfg.historyField] = pd[cfg.historyField] || [];
      pd[cfg.historyField].unshift({ query, time: _getGameTime() || new Date().toLocaleString() });
      pd[cfg.historyField] = pd[cfg.historyField].slice(0, 10);
      await _savePhoneData();
      _log(`在${cfg.title}APP搜索了「${query}」，得到 ${results.length} 条结果`);
      if (_isAppStillActive(kind)) _renderShopping(pd, kind);
      UI.showToast(`搜索完成，${results.length} 条结果`, 1200);
    } catch(e) {
      UI.showToast(`搜索失败：${e.message}`, 2500);
    }
  }

  // 单条删除搜索记录（外卖/网购通用）
  async function _deleteShopSearch(kind, index) {
    const cfg = _getShopCfg(kind);
    const pd = await _getPhoneData();
    const list = pd?.[cfg.historyField] || [];
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    await _savePhoneData();
    _renderShopping(pd, kind);
  }

  // 从历史记录重新搜索
  async function _shopRepeatSearch(kind, idx) {
    const cfg = _getShopCfg(kind);
    const pd = await _getPhoneData();
    const s = pd?.[cfg.historyField]?.[idx];
    if (!s) return;
    _shopTab = 'items';
    _renderShopping(pd, kind);
    setTimeout(() => {
      const input = document.getElementById('phone-shop-search');
      if (input) input.value = s.query;
      _shopSearch(kind);
    }, 100);
  }

  // 打开自定义商品弹窗
  function _shopOpenCustomModal(kind) {
    const cfg = _getShopCfg(kind);
    let modal = document.getElementById('phone-shop-custom-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'phone-shop-custom-modal';
      modal.className = 'phone-inner-modal hidden';
      const shell = document.querySelector('#phone-modal .phone-shell');
      (shell || document.body).appendChild(modal);
    }
    modal.innerHTML = `<div class="modal-content" style="max-width:360px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">${Utils.escapeHtml(cfg.customBtnText)}</h3>
        <button onclick="Phone._shopCloseCustomModal()" class="btn-icon modal-corner-btn close-btn">×</button>
      </div>
      <p style="font-size:11px;color:var(--text-secondary);margin:0 0 12px">${Utils.escapeHtml(cfg.customHint)}</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <input id="phone-shop-cust-name" placeholder="商品名（必填）" style="padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:13px">
        <input id="phone-shop-cust-shop" placeholder="店铺（可留空）" style="padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:13px">
        <input id="phone-shop-cust-price" placeholder="价格（数字）" type="number" style="padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:13px">
        <textarea id="phone-shop-cust-desc" placeholder="描述（可留空）" rows="3" style="padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:13px;resize:none"></textarea>
      </div>
      <div class="modal-actions" style="margin-top:12px">
        <button onclick="Phone._shopCloseCustomModal()" style="flex:1;background:none;border:1px solid var(--border);color:var(--text-secondary)">取消</button>
        <button onclick="Phone._shopConfirmCustom('${kind}')" style="flex:1">添加到列表</button>
      </div>
    </div>`;
    modal.classList.remove('hidden');
  }

  function _shopCloseCustomModal() {
    document.getElementById('phone-shop-custom-modal')?.classList.add('hidden');
  }

  async function _shopConfirmCustom(kind) {
    const cfg = _getShopCfg(kind);
    const name = document.getElementById('phone-shop-cust-name')?.value.trim() || '';
    const shop = document.getElementById('phone-shop-cust-shop')?.value.trim() || '';
    const price = document.getElementById('phone-shop-cust-price')?.value.trim() || '';
    const desc = document.getElementById('phone-shop-cust-desc')?.value.trim() || '';
    if (!name) { UI.showToast('商品名不能为空', 1500); return; }

    const pd = await _getPhoneData();
    if (!pd) return;
    pd[cfg.cachedField] = pd[cfg.cachedField] || [];
    pd[cfg.cachedField].unshift({ name, shop, price, desc, custom: true });
    pd[cfg.cachedField] = pd[cfg.cachedField].slice(0, 20);
    await _savePhoneData();
    _shopCloseCustomModal();
    _log(`在${cfg.title}APP自定义了一个商品：${name}${price ? `（¥${price}）` : ''}`);
    if (_isAppStillActive(kind)) _renderShopping(pd, kind);
    UI.showToast('已添加到列表顶部', 1200);
  }

  // 分享商品到主线（让 char 看到这条商品链接，自行决定要不要给 user 买）
  async function _shopShareItem(kind, idx) {
    const pd = await _getPhoneData();
    const it = pd?.[_getShopCfg(kind).cachedField]?.[idx];
    if (!it) return;
    const platform = _getShopCfg(kind).title;
    const title = `${platform}：${it.name || '商品'}`;
    const lines = [`平台：${platform}`, `商品：${it.name || ''}`];
    if (it.shop) lines.push(`店铺：${it.shop}`);
    if (it.price !== undefined && it.price !== null && String(it.price).trim() !== '') lines.push(`价格：¥${it.price}`);
    if (it.desc) lines.push(`描述：${it.desc}`);
    const content = lines.join('\n');

    // 弹出分享选项面板
    const choice = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.45)';
      overlay.innerHTML = `
        <div style="width:100%;max-width:420px;background:var(--bg);border-radius:20px 20px 0 0;padding:20px 20px 32px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <span style="font-size:16px;font-weight:600;color:var(--text)">分享</span>
            <button id="share-choice-cancel" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;line-height:1">×</button>
          </div>
          <button id="share-to-main" style="width:100%;padding:14px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;margin-bottom:10px;display:flex;align-items:center;gap:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>
            分享到主线
          </button>
          <button id="share-to-chat" style="width:100%;padding:14px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            分享到聊天
          </button>
        </div>
      `;
      const close = val => { document.body.removeChild(overlay); resolve(val); };
      overlay.querySelector('#share-choice-cancel').onclick = () => close(null);
      overlay.querySelector('#share-to-main').onclick = () => close('main');
      overlay.querySelector('#share-to-chat').onclick = () => close('chat');
      overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
      document.body.appendChild(overlay);
    });

    if (choice === 'main') {
      await _shareToMain('shop', title, content);
    } else if (choice === 'chat') {
      await _shopShareToChat(it, platform);
    }
  }

  // 分享商品到聊天：弹联系人选择，发送商品卡片
  async function _shopShareToChat(item, platform) {
    const pd = await _getPhoneData();
    const contacts = pd?.chatContacts || [];
    if (!contacts.length) { UI.showToast('还没有聊天联系人', 1500); return; }

    const contactId = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)';

      const listHtml = contacts.map(c => {
        const displayName = c.nickname || c.name || '?';
        const avaUrl = _chatContactAvatar(c);
        const avatarEl = avaUrl
          ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0">`
          : `<div style="width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;flex-shrink:0">${Utils.escapeHtml(displayName[0])}</div>`;
        const thread = (pd.chatThreads && pd.chatThreads[c.id]) || [];
        const lastMsg = thread.length ? thread[thread.length - 1] : null;
        const lastText = lastMsg
          ? (lastMsg.type === 'location' ? '[位置]' : lastMsg.type === 'voice' ? '[语音]' : lastMsg.type === 'photo' ? '[图片]' : lastMsg.type === 'product' ? '[商品链接]' : (lastMsg.text || ''))
          : '暂无消息';
        return `<div class="share-chat-pick-item" data-cid="${Utils.escapeHtml(c.id)}" style="padding:10px 12px;border-radius:10px;margin-bottom:4px;cursor:pointer;background:var(--bg-tertiary);display:flex;align-items:center;gap:10px">
          ${avatarEl}
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(displayName)}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(lastText.substring(0, 28))}</div>
          </div>
        </div>`;
      }).join('');

      overlay.innerHTML = `<div style="width:min(320px,88vw);background:var(--bg);border-radius:18px;padding:20px;max-height:70vh;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-shrink:0">
          <span style="font-size:16px;font-weight:600;color:var(--text)">分享到</span>
          <button id="share-chat-cancel" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;line-height:1">×</button>
        </div>
        <div style="flex:1;overflow-y:auto">${listHtml}</div>
      </div>`;

      const close = val => { document.body.removeChild(overlay); resolve(val); };
      overlay.querySelector('#share-chat-cancel').onclick = () => close(null);
      overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
      overlay.querySelectorAll('.share-chat-pick-item').forEach(el => {
        el.addEventListener('click', () => close(el.dataset.cid));
      });
      document.body.appendChild(overlay);
    });

    if (!contactId) return;

    let gameTime = '';
    try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}
    if (!pd.chatThreads) pd.chatThreads = {};
    if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
    pd.chatThreads[contactId].push({
      id: 'prod_' + Date.now(),
      role: 'me',
      type: 'product',
      productName: item.name || '',
      productShop: item.shop || '',
      productPrice: item.price || '',
      productDesc: item.desc || '',
      productPlatform: platform,
      text: `[商品链接]${item.name || ''}`,
      time: gameTime,
      createdAt: Date.now()
    });
    await _savePhoneData();
    const _ctNameProd = (pd.chatContacts || []).find(c => c.id === contactId)?.name || contactId;
    _addChatMessageToRoundLog(contactId, 'me', `发送了商品链接（${item.name || ''}）`, gameTime, _ctNameProd);
    UI.showToast('已发送', 1200);
  }

  // 给自己买
  async function _shopBuyForSelf(kind, idx) {
    const pd = await _getPhoneData();
    const it = pd?.[_getShopCfg(kind).cachedField]?.[idx];
    if (!it) return;
    const payResult = await _shopPaymentConfirm(pd, it, '自己');
    if (!payResult) return;
    await _shopCreateOrder(kind, idx, '自己', payResult);
  }

  // 给角色买：打开 NPC 选择弹窗
  async function _shopBuyForTarget(kind, idx) {
    const options = await _collectMomentVisibleOptions();
    if (!options.length) { UI.showToast('当前世界观没有可选角色', 1800); return; }

    let modal = document.getElementById('phone-shop-target-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'phone-shop-target-modal';
      modal.className = 'phone-inner-modal hidden';
      const shell = document.querySelector('#phone-modal .phone-shell');
      (shell || document.body).appendChild(modal);
    }
    const listHtml = options.map(o => {
      const avatarEl = o.avatar
        ? `<img src="${Utils.escapeHtml(o.avatar)}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0">`
        : `<div style="width:32px;height:32px;border-radius:50%;background:var(--accent-light, #f3e8e2);display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--accent);font-weight:600;flex-shrink:0">${Utils.escapeHtml((o.name || '?')[0])}</div>`;
      return `
      <div class="phone-shop-target-item" onclick="Phone._shopConfirmTarget('${kind}', ${idx}, '${Utils.escapeHtml(o.name).replaceAll("'","\\'")}')" style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer;background:var(--bg-tertiary);display:flex;align-items:center;gap:10px">
        ${avatarEl}
        <div style="flex:1;min-width:0;font-size:13px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(o.name)}</div>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.6"><rect x="3" y="8" width="18" height="4" rx="1" ry="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/></svg>
      </div>`;
    }).join('');
    modal.innerHTML = `<div class="modal-content" style="max-width:360px;max-height:70vh;display:flex;flex-direction:column">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-shrink:0">
        <h3 style="margin:0">送给谁</h3>
        <button onclick="Phone._shopCloseTargetModal()" class="btn-icon modal-corner-btn close-btn">×</button>
      </div>
      <div style="flex:1;overflow-y:auto;padding-right:2px">${listHtml}</div>
    </div>`;
    modal.classList.remove('hidden');
  }

  function _shopCloseTargetModal() {
    document.getElementById('phone-shop-target-modal')?.classList.add('hidden');
  }

  async function _shopConfirmTarget(kind, idx, target) {
    _shopCloseTargetModal();
    const pd = await _getPhoneData();
    const it = pd?.[_getShopCfg(kind).cachedField]?.[idx];
    if (!it) return;
    const payResult = await _shopPaymentConfirm(pd, it, target);
    if (!payResult) return;
    await _shopCreateOrder(kind, idx, target, payResult);
  }

  // 支付确认弹窗（含钱包货币选择）
  // 返回 { useCurrency: true/false, currencyId, currencyName } 或 null（取消）
  async function _shopPaymentConfirm(pd, item, target) {
    pd.walletCurrencies = pd.walletCurrencies || [];
    const priceStr = item.price ? `¥${item.price}` : '';
    const forWho = target === '自己' ? '给自己买' : `给 ${target} 买`;

    // 获取可用货币信息
    let walletInfos = [];
    try {
      const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
      const gp = conv?.convGameplay || null;
      const globalAttrs = (gp?.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim());
      const sb = Conversations.getStatusBar() || {};
      const statusAttrs = sb?.customAttrs?.global || {};
      walletInfos = pd.walletCurrencies
        .map(id => {
          const def = globalAttrs.find(a => a.id === id);
          if (!def) return null;
          return { id, name: def.name, balance: statusAttrs[id] ?? def.initial ?? 0 };
        })
        .filter(Boolean);
    } catch(_) {}

    // 没有绑定货币的情况
    if (!walletInfos.length) {
      const ok = await UI.showConfirm(
        '确认下单',
        `${forWho}：${item.name}${priceStr ? ' · ' + priceStr : ''}${item.shop ? '\n店铺：' + item.shop : ''}\n\n⚠️ 目前并没有在钱包中绑定货币，是否继续下单？`
      );
      return ok ? { useCurrency: false } : null;
    }

    // 有绑定货币：弹自定义确认弹窗（含货币选择）
    return new Promise(resolve => {
      const mask = document.createElement('div');
      mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:20px';
      const currencyOptions = walletInfos.map((w, i) =>
        `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--bg-tertiary)">
          <input type="radio" name="wallet-pay-currency" value="${Utils.escapeHtml(w.id)}" ${i === 0 ? 'checked' : ''} style="accent-color:var(--accent)">
          <span style="flex:1;font-size:13px;color:var(--text)">${Utils.escapeHtml(w.name)}</span>
          <span style="font-size:12px;color:var(--text-secondary)">余额 ${Utils.escapeHtml(String(w.balance))}</span>
        </label>`
      ).join('');

      mask.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:20px;max-width:340px;width:100%;color:var(--text)">
          <div style="font-size:15px;font-weight:600;margin-bottom:12px">确认下单</div>
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">${forWho}：${Utils.escapeHtml(item.name)}${priceStr ? ' · ' + priceStr : ''}${item.shop ? '<br>店铺：' + Utils.escapeHtml(item.shop) : ''}</div>
          <div style="font-size:12px;color:var(--text);font-weight:600;margin-bottom:8px">选择支付货币</div>
          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">${currencyOptions}</div>
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button id="wallet-pay-cancel" style="padding:8px 18px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
            <button id="wallet-pay-confirm" style="padding:8px 18px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">确认支付</button>
          </div>
        </div>`;

      mask.querySelector('#wallet-pay-cancel').onclick = () => {
        document.body.removeChild(mask);
        resolve(null);
      };
      mask.querySelector('#wallet-pay-confirm').onclick = () => {
        const selected = mask.querySelector('input[name="wallet-pay-currency"]:checked');
        const currencyId = selected?.value || walletInfos[0].id;
        const info = walletInfos.find(w => w.id === currencyId);
        document.body.removeChild(mask);
        resolve({ useCurrency: true, currencyId, currencyName: info?.name || '' });
      };
      mask.addEventListener('click', (e) => {
        if (e.target === mask) { document.body.removeChild(mask); resolve(null); }
      });
      document.body.appendChild(mask);
    });
  }

  // 创建订单（通用）
  async function _shopCreateOrder(kind, idx, target, payResult) {
    const cfg = _getShopCfg(kind);
    const pd = await _getPhoneData();
    if (!pd) return;
    const it = pd[cfg.cachedField]?.[idx];
    if (!it) return;

    // 扣款逻辑
    let deductMsg = '';
    if (payResult?.useCurrency && it.price) {
      const priceNum = parseFloat(String(it.price).replace(/[^0-9.]/g, ''));
      if (Number.isFinite(priceNum) && priceNum > 0) {
        try {
          const sb = Conversations.getStatusBar() || {};
          sb.customAttrs = sb.customAttrs || {};
          sb.customAttrs.global = sb.customAttrs.global || {};
          const balance = Number(sb.customAttrs.global[payResult.currencyId]) || 0;
          if (balance < priceNum) {
            UI.showToast(`${payResult.currencyName}余额不足（需要 ${priceNum}，当前 ${balance}）`, 2500);
            return;
          }
          sb.customAttrs.global[payResult.currencyId] = balance - priceNum;
          await Conversations.setStatusBar(sb);
          if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(sb);
          deductMsg = `；前端已自动扣除 ${priceNum} ${payResult.currencyName}（余额 ${balance - priceNum}），AI无需再处理此扣款`;
        } catch(e) {
          console.warn('[Wallet] 扣款失败', e);
        }
      }
    }

    const order = {
      id: 'order_' + Utils.uuid().slice(0, 8),
      name: it.name || '',
      shop: it.shop || '',
      price: it.price || '',
      desc: it.desc || '',
      target: target || '自己',
      time: new Date().toLocaleString(),
    };
    pd[cfg.ordersField] = pd[cfg.ordersField] || [];
    pd[cfg.ordersField].push(order);
    pd[cfg.ordersField] = pd[cfg.ordersField].slice(-30); // 最多保留30条
    await _savePhoneData();

    // 操作日志
    const priceStr = it.price ? `¥${it.price}` : '';
    const descStr = it.desc ? `（${_clipLogText(it.desc, 30)}）` : '';
    const forWho = target === '自己' ? '给自己' : `送给${target}`;
    _log(`在${cfg.title}APP下单了：${it.name}${priceStr ? '，' + priceStr : ''}${descStr}，${forWho}（配送时间由你在剧情中自然安排）${deductMsg}`);

    if (_isAppStillActive(kind)) _renderShopping(pd, kind);
    UI.showToast(`下单成功`, 1500);
  }

  // 删除订单
  async function _shopDeleteOrder(kind, orderId) {
    const cfg = _getShopCfg(kind);
    if (!await UI.showConfirm('删除订单', '确定删除这条订单记录？')) return;
    const pd = await _getPhoneData();
    if (!pd) return;
    pd[cfg.ordersField] = (pd[cfg.ordersField] || []).filter(o => o.id !== orderId);
    await _savePhoneData();
    _log(`删除了一条${cfg.title}订单`);
    if (_isAppStillActive(kind)) _renderShopping(pd, kind);
}

// ===== 心动模拟 APP =====
// 心动目标内置档案 + 用户私下好感度（仅本地娱乐数据，不影响游戏数值，不暴露给 AI）
// 顺序按用户指定：方赊云 → 易寻 → 路冥夜 → 奎恩
// 这是「内置默认列表」——首次打开时拷贝到 phoneData.hsAppTargets，后续可被用户增删改
const HEARTSIM_TARGETS_DEFAULT = [
  { id: 'fsy', name: '方赊云', alias: '流云', age: 31, role: '大学教授',         relation: '你的老师' },
  { id: 'yx',  name: '易寻',   alias: '寻',   age: 20, role: '心逸医学院学生', relation: '你的邻居' },
  { id: 'lmy', name: '路冥夜', alias: 'L',    age: 26, role: '黑客',           relation: '你的网友' },
  { id: 'qe',  name: '奎恩',   alias: 'Quinn', age: 25, role: '便利店店员',     relation: '你的熟人' },
];
// 内置档案的 npcId 映射（用于一次性迁移旧的 npcAvatars 头像）
const HEARTSIM_LEGACY_NPC_ID = { fsy: 'npc_fsy', yx: 'npc_yx', lmy: 'npc_lmy', qe: 'npc_qe' };

let _hsAppTab = 'profiles'; // 'profiles' | 'service'
let _hsEditingTargetId = null; // null = 新增；非空 = 编辑该 id

// 取当前用户的心动目标列表。null/未初始化时返回内置默认副本。
async function _ensureHsAppTargets(pd) {
  if (Array.isArray(pd.hsAppTargets)) return pd.hsAppTargets;
  // 首次打开：克隆内置 + 迁移旧的 npcAvatars 头像
  const targets = HEARTSIM_TARGETS_DEFAULT.map(t => ({ ...t, avatar: '' }));
  try {
    for (const t of targets) {
      const npcId = HEARTSIM_LEGACY_NPC_ID[t.id];
      if (!npcId) continue;
      const r = await DB.get('npcAvatars', npcId);
      if (r?.avatar) t.avatar = r.avatar;
    }
  } catch(_) {}
  pd.hsAppTargets = targets;
  return targets;
}

async function _renderHeartSimApp(pd) {
  document.getElementById('phone-title').textContent = '心动模拟';
  const body = document.getElementById('phone-body');
  if (!body) return;

  // v687.33：返航后心动模拟 APP 进入"已结束"状态——保留 APP 入口但内容只剩一句话
  if (pd && pd.hsHomecomingTriggered) {
    body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;padding:32px;text-align:center">
        <div style="color:var(--text-secondary);font-size:14px;letter-spacing:2px;line-height:1.8;opacity:0.75">
          本次服务已结束。
        </div>
      </div>
    `;
    return;
  }

  const targets = await _ensureHsAppTargets(pd);

  // 客服头像（来自世界观 iconImage）
  let serviceAvatar = '';
  try {
    const conv = Conversations.getList()?.find(c => c.id === Conversations.getCurrent());
    const wvId = conv?.worldviewId || conv?.singleWorldviewId || 'wv_heartsim';
    const wv = await DB.get('worldviews', wvId);
    serviceAvatar = wv?.iconImage || '';
  } catch(_) {}

  const profilesHtml = _renderHsProfilesPanel(pd, targets);
  const serviceHtml = await _renderHsServicePanel(pd, serviceAvatar);

  body.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;position:relative">
      <div id="phone-hs-profiles-panel" style="flex:1;overflow-y:auto;display:${_hsAppTab === 'profiles' ? 'flex' : 'none'};flex-direction:column">${profilesHtml}</div>
      <div id="phone-hs-service-panel" style="flex:1;overflow:hidden;display:${_hsAppTab === 'service' ? 'flex' : 'none'};flex-direction:column">${serviceHtml}</div>
      <div class="phone-tabbar">
        <div class="phone-tab ${_hsAppTab === 'profiles' ? 'active' : ''}" onclick="Phone._switchHsAppTab('profiles')">心动目标</div>
        <div class="phone-tab ${_hsAppTab === 'service' ? 'active' : ''}" onclick="Phone._switchHsAppTab('service')">心动模拟客服</div>
      </div>
      <div id="phone-hs-edit-overlay" class="hidden" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;border-radius:inherit;overflow:hidden"></div>
    </div>
  `;

  // 客服面板：滚动到底
  if (_hsAppTab === 'service') {
    const list = document.getElementById('phone-hs-service-list');
    if (list) list.scrollTop = list.scrollHeight;
  }
}

function _renderHsProfilesPanel(pd, targets) {
  const fav = pd.hsAppFavor || {};
  const cards = targets.map(t => {
    const v = Math.max(0, Math.min(100, Number(fav[t.id]) || 0));
    const avatar = t.avatar || '';
    const avatarHTML = avatar
      ? `<img src="${Utils.escapeHtml(avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
      : `<div style="font-size:24px;font-weight:600;color:var(--text-secondary)">${Utils.escapeHtml(t.name?.[0] || '?')}</div>`;
    return `
      <div style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;position:relative">
        <div style="position:absolute;top:8px;right:8px;display:flex;gap:4px">
          <button onclick="Phone._hsEditTarget('${t.id}')" title="编辑" style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:transparent;border:none;color:var(--text-secondary);border-radius:6px;cursor:pointer;padding:0">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button onclick="Phone._hsDeleteTarget('${t.id}')" title="删除" style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:transparent;border:none;color:var(--text-secondary);border-radius:6px;cursor:pointer;padding:0">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>
        <div style="display:flex;gap:12px;align-items:center;padding-right:60px">
          <div style="width:64px;height:64px;border-radius:50%;overflow:hidden;flex-shrink:0;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center">${avatarHTML}</div>
          <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">
            <div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap">
              <span style="font-size:16px;font-weight:600;color:var(--text);letter-spacing:0.02em">${Utils.escapeHtml(t.name || '')}</span>
              ${t.alias ? `<span style="font-size:12px;color:var(--text-secondary);opacity:0.7">@${Utils.escapeHtml(t.alias)}</span>` : ''}
            </div>
            <div style="font-size:12px;color:var(--text-secondary)">${t.age ? Utils.escapeHtml(String(t.age)) + ' · ' : ''}${Utils.escapeHtml(t.role || '')}</div>
            ${t.relation ? `<div style="font-size:12px;color:var(--text-secondary);opacity:0.85">${Utils.escapeHtml(t.relation)}</div>` : ''}
          </div>
        </div>
        <div style="height:1px;background:var(--border);margin:2px 0"></div>
        <div style="font-size:12px;color:var(--text-secondary);letter-spacing:0.02em">你对TA的好感度</div>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1;height:8px;background:var(--bg-secondary);border-radius:999px;overflow:hidden;border:1px solid var(--border)">
            <div class="hs-card-bar-fill" id="hs-bar-${t.id}" style="height:100%;width:${v}%;background:var(--accent);border-radius:999px"></div>
          </div>
          <span id="hs-num-${t.id}" style="font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums;min-width:48px;text-align:right">${v}/100</span>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button onclick="Phone._hsAppFavorChange('${t.id}', -1)" style="width:36px;padding:6px 0;font-size:16px;line-height:1;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);border-radius:8px;cursor:pointer">−</button>
          <button onclick="Phone._hsAppFavorChange('${t.id}', 1)" style="padding:6px 14px;font-size:13px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-weight:500;border-radius:8px;cursor:pointer">＋ 戳一下</button>
        </div>
      </div>
    `;
  }).join('');

  const addBtn = `
    <button onclick="Phone._hsAddTarget()" style="background:transparent;border:1.5px dashed var(--border);border-radius:12px;padding:18px;color:var(--text-secondary);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      添加心动目标
    </button>
  `;

  const emptyHint = targets.length === 0
    ? `<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:24px 12px;line-height:1.7">还没有心动目标。<br>点击下方按钮添加你想要心动的人。</div>`
    : '';

  return `
    <div style="display:flex;flex-direction:column;gap:12px;padding:12px;flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;box-sizing:border-box">
      ${emptyHint}
      <div style="display:flex;flex-direction:column;gap:12px">${cards}</div>
      ${addBtn}
      <div style="font-size:11px;color:var(--text-secondary);opacity:0.6;text-align:center;line-height:1.6;padding:8px 4px 12px">
        ※ 此数据仅供您把玩，无任何实际意义。<br>——心动模拟客服
      </div>
    </div>
  `;
}

// ===== 心动目标 编辑表单 =====
let _hsEditPendingAvatar = null; // 编辑表单内暂存的头像 dataURL

function _hsRenderEditOverlay(target) {
  const overlay = document.getElementById('phone-hs-edit-overlay');
  if (!overlay) return;
  const isNew = !target;
  const t = target || { name: '', alias: '', age: '', role: '', relation: '', avatar: '' };
  _hsEditPendingAvatar = null;
  const avatarSrc = t.avatar || '';
  overlay.innerHTML = `
    <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:14px;width:100%;max-width:340px;max-height:90%;display:flex;flex-direction:column;overflow:hidden" onclick="event.stopPropagation()">
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:15px;font-weight:600;color:var(--text)">${isNew ? '添加心动目标' : '编辑心动目标'}</span>
        <button onclick="Phone._hsCloseEdit()" style="background:transparent;border:none;color:var(--text-secondary);font-size:20px;line-height:1;cursor:pointer;padding:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center">×</button>
      </div>
      <div style="padding:14px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
          <div id="hs-edit-avatar-preview" style="width:80px;height:80px;border-radius:50%;overflow:hidden;background:var(--bg-tertiary);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;cursor:pointer" onclick="Phone._hsEditAvatarPicked()">
            ${avatarSrc
              ? `<img src="${Utils.escapeHtml(avatarSrc)}" alt="" style="width:100%;height:100%;object-fit:cover">`
              : `<span style="font-size:11px;color:var(--text-secondary)">点击上传</span>`}
          </div>
          <div style="font-size:11px;color:var(--text-secondary)">点击头像上传</div>
        </div>
        ${_hsEditField('hs-ed-name',     '名字',         t.name,     'TA 叫什么')}
        ${_hsEditField('hs-ed-alias',    '昵称 / @',     t.alias,    '可留空')}
        ${_hsEditField('hs-ed-age',      '年龄',         t.age,      '可填可不填', 'number')}
        ${_hsEditField('hs-ed-role',     '身份 / 职业',  t.role,     '比如：大学教授')}
        ${_hsEditField('hs-ed-relation', '与你的关系',   t.relation, '比如：你的老师')}
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px">
        <button onclick="Phone._hsCloseEdit()" style="flex:1;padding:10px 0;background:transparent;border:1px solid var(--border);color:var(--text-secondary);border-radius:8px;font-size:14px;cursor:pointer">取消</button>
        <button onclick="Phone._hsSaveEdit()" style="flex:1;padding:10px 0;background:var(--accent);border:none;color:#fff;border-radius:8px;font-size:14px;cursor:pointer;font-weight:500">保存</button>
      </div>
    </div>
  `;
  overlay.classList.remove('hidden');
}
function _hsEditField(id, label, value, placeholder, type) {
  const safeVal = Utils.escapeHtml(value == null ? '' : String(value));
  const safePh  = Utils.escapeHtml(placeholder || '');
  return `
    <div style="display:flex;flex-direction:column;gap:4px">
      <div style="font-size:12px;color:var(--text-secondary)">${Utils.escapeHtml(label)}</div>
      <input id="${id}" type="${type || 'text'}" value="${safeVal}" placeholder="${safePh}"
        style="padding:8px 10px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;font-size:13px">
    </div>
  `;
}

async function _hsAddTarget() {
  _hsEditingTargetId = null;
  _hsRenderEditOverlay(null);
}
async function _hsEditTarget(id) {
  const pd = await _getPhoneData();
  if (!pd) return;
  const targets = await _ensureHsAppTargets(pd);
  const t = targets.find(x => x.id === id);
  if (!t) return;
  _hsEditingTargetId = id;
  _hsRenderEditOverlay(t);
}
function _hsCloseEdit() {
  const overlay = document.getElementById('phone-hs-edit-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  }
  _hsEditingTargetId = null;
  _hsEditPendingAvatar = null;
}
async function _hsEditAvatarPicked() {
  const dataUrl = await Utils.promptImageInput({ maxSize: 200, quality: 0.85 });
  if (!dataUrl) return;
  _hsEditPendingAvatar = dataUrl;
  const preview = document.getElementById('hs-edit-avatar-preview');
  if (preview) {
    preview.innerHTML = `<img src="${Utils.escapeHtml(dataUrl)}" alt="" style="width:100%;height:100%;object-fit:cover">`;
  }
}
async function _hsSaveEdit() {
  const name = document.getElementById('hs-ed-name')?.value.trim() || '';
  if (!name) {
    UI.showToast('请填写名字', 1800);
    return;
  }
  const alias    = document.getElementById('hs-ed-alias')?.value.trim() || '';
  const ageRaw   = document.getElementById('hs-ed-age')?.value.trim() || '';
  const role     = document.getElementById('hs-ed-role')?.value.trim() || '';
  const relation = document.getElementById('hs-ed-relation')?.value.trim() || '';
  const age      = ageRaw === '' ? '' : (Number(ageRaw) || ageRaw);

  const pd = await _getPhoneData();
  if (!pd) return;
  const targets = await _ensureHsAppTargets(pd);

  if (_hsEditingTargetId) {
    // 编辑
    const t = targets.find(x => x.id === _hsEditingTargetId);
    if (t) {
      t.name = name; t.alias = alias; t.age = age; t.role = role; t.relation = relation;
      if (_hsEditPendingAvatar !== null) t.avatar = _hsEditPendingAvatar;
    }
  } else {
    // 新增
    const id = 'hs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    targets.push({
      id, name, alias, age, role, relation,
      avatar: _hsEditPendingAvatar || ''
    });
    if (!pd.hsAppFavor) pd.hsAppFavor = {};
    pd.hsAppFavor[id] = 0;
  }
  await _savePhoneData();
  _hsCloseEdit();
  if (_isAppStillActive('heartsim_app')) await _renderHeartSimApp(pd);
}
async function _hsDeleteTarget(id) {
  const pd = await _getPhoneData();
  if (!pd) return;
  const targets = await _ensureHsAppTargets(pd);
  const t = targets.find(x => x.id === id);
  if (!t) return;
  if (!await UI.showConfirm('删除心动目标', `确定删除「${t.name}」？此操作不可撤销。`)) return;
  pd.hsAppTargets = targets.filter(x => x.id !== id);
  if (pd.hsAppFavor) delete pd.hsAppFavor[id];
  if (pd.hsAppFavorSnapshot) delete pd.hsAppFavorSnapshot[id];
  await _savePhoneData();
  if (_isAppStillActive('heartsim_app')) await _renderHeartSimApp(pd);
}

async function _renderHsServicePanel(pd, serviceAvatar) {
  // 历史消息合集 = 开场动画的 phase1_lockscreen + phase3_rules + 用户与客服后续对话
  const introMessages = await _getHsIntroMessages();
  const userMessages = pd.heartsimServiceMessages || [];

  const allMessages = [
    ...introMessages.map(text => ({ role: 'assistant', text })),
    ...userMessages,
  ];

  const avatarHTML = serviceAvatar
    ? `<img src="${Utils.escapeHtml(serviceAvatar)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
    : `<div style="font-size:14px;font-weight:600;color:var(--text-secondary);text-align:center;line-height:36px">心</div>`;

  const messagesHtml = allMessages.map(m => {
    if (m.role === 'assistant') {
      const isBlack = !!m.blackAvatar;
      const thisAvatarHTML = isBlack
        ? `<div style="width:100%;height:100%;background:#000;display:block"></div>`
        : avatarHTML;
      const textStyle = isBlack
        ? 'border-radius:10px;padding:8px 12px;max-width:78%;font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap;color:#c0392b;background:rgba(192,57,43,0.08);border:1px solid rgba(192,57,43,0.25)'
        : 'border-radius:10px;padding:8px 12px;max-width:78%;font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap';
      const bubbleClass = isBlack ? '' : 'class="hs-bubble-ai"';
      return `
        <div style="display:flex;gap:8px;margin-bottom:10px;align-items:flex-start">
          <div style="width:36px;height:36px;border-radius:50%;overflow:hidden;flex-shrink:0;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center">${thisAvatarHTML}</div>
          <div ${bubbleClass} style="${textStyle}">${Utils.escapeHtml(m.text)}</div>
        </div>
      `;
    } else {
      return `
        <div style="display:flex;gap:8px;margin-bottom:10px;align-items:flex-start;justify-content:flex-end">
          <div class="hs-bubble-user" style="border-radius:10px;padding:8px 12px;max-width:78%;font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap">${Utils.escapeHtml(m.text)}</div>
        </div>
      `;
    }
  }).join('');

  return `
    <div style="flex-shrink:0;padding:10px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;background:var(--bg-secondary)">
      <div style="width:32px;height:32px;border-radius:50%;overflow:hidden;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center">${avatarHTML}</div>
      <div style="display:flex;flex-direction:column;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--text)">心动模拟客服</div>
        <div style="font-size:10px;color:var(--text-secondary);opacity:0.7">在线｜回复缓慢</div>
      </div>
    </div>
    <div id="phone-hs-service-list" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:12px;box-sizing:border-box">
      ${messagesHtml || '<div style="text-align:center;color:var(--text-secondary);font-size:12px;opacity:0.6;padding:20px 0">暂无消息</div>'}
    </div>
    <div style="flex-shrink:0;padding:8px 10px;border-top:1px solid var(--border);background:var(--bg-secondary);display:flex;gap:6px;align-items:center">
      <input id="phone-hs-service-input" type="text" placeholder="给客服发条消息…" style="flex:1;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:18px;padding:7px 12px;color:var(--text);font-size:13px;outline:none" onkeydown="if(event.key==='Enter'){Phone._hsServiceSend();event.preventDefault();}">
      <button onclick="Phone._hsServiceSend()" style="background:var(--accent);color:var(--bg);border:none;border-radius:16px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer">发送</button>
    </div>
  `;
}

// 取开场动画 = phase1_lockscreen + phase3_rules，用作客服对话框历史
async function _getHsIntroMessages() {
  try {
    const conv = Conversations.getList()?.find(c => c.id === Conversations.getCurrent());
    const wvId = conv?.worldviewId || conv?.singleWorldviewId || 'wv_heartsim';
    const wv = await DB.get('worldviews', wvId);
    if (!wv) return [];

    const messages = [];

    // phase1：startMessage 拆分（按空行/---）
    const startMsg = wv.startMessage || '';
    if (startMsg) {
      startMsg.split(/\n\s*\n|\n---+\n?/).forEach(seg => {
        const t = seg.trim();
        if (t) messages.push(t);
      });
    }

    // phase3_rules：直接读
    const rules = wv.heartSimIntro?.phase3_rules || [];
    rules.forEach(r => {
      if (typeof r === 'string') {
        const t = r.trim();
        if (t) messages.push(t);
      } else if (r && typeof r === 'object' && r.content) {
        const t = String(r.content).trim();
        if (t) messages.push(t);
      }
    });

    return messages;
  } catch(_) {
    return [];
  }
}

async function _switchHsAppTab(tab) {
  _hsAppTab = tab;
  const pd = await _getPhoneData();
  if (pd) _renderHeartSimApp(pd);
}

// 客服回复预设：从世界观 heartSimIntro.servicePresets 读取
// 数据格式（你来填）：[{ keywords: ['通关','回家'], reply: '...' }, ...]
async function _getHsServicePresets() {
  try {
    const conv = Conversations.getList()?.find(c => c.id === Conversations.getCurrent());
    const wvId = conv?.worldviewId || conv?.singleWorldviewId || 'wv_heartsim';
    const wv = await DB.get('worldviews', wvId);
    return Array.isArray(wv?.heartSimIntro?.servicePresets) ? wv.heartSimIntro.servicePresets : [];
  } catch(_) {
    return [];
  }
}

async function _hsServiceSend() {
  const input = document.getElementById('phone-hs-service-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const pd = await _getPhoneData();
  if (!pd) return;
  if (!Array.isArray(pd.heartsimServiceMessages)) pd.heartsimServiceMessages = [];

  // 推用户消息
  pd.heartsimServiceMessages.push({
    role: 'user',
    text,
    time: Date.now(),
  });

  let reply = '';

  // —— 优先级 1：用户发"回家"指令 ——
  if (text.includes('回家')) {
    reply = _resolveHsHomeRequest(pd);
  }

  // —— 优先级 2：预设关键词命中（大小写不敏感）——
  if (!reply) {
    const presets = await _getHsServicePresets();
    const lowerText = text.toLowerCase();
    for (const p of presets) {
      const keywords = Array.isArray(p?.keywords) ? p.keywords : [];
      if (keywords.some(k => k && lowerText.includes(String(k).toLowerCase()))) {
        reply = String(p.reply || '').trim();
        if (reply) break;
      }
    }
  }

  // 先保存用户消息（不含 reply）+ 清空输入框 + 立刻重渲让用户消息出现
  // 必须 await：_renderHeartSimApp 内部有 await，如果不等它完成，
  // 后面 _hsShowTypingIndicator 插入的指示器会在重渲完成时被 body.innerHTML 重写冲掉。
  await _savePhoneData();
  input.value = '';
  if (_isAppStillActive('heartsim_app')) await _renderHeartSimApp(pd);

  // 没有回复 → 客服已读不回，直接结束
  if (!reply) return;

  // 有回复 → 显示打字指示器 → 1.2s 后再 push 回复
  _hsShowTypingIndicator();
  setTimeout(async () => {
    _hsHideTypingIndicator();
    // 重新拿一次 phoneData（防止延迟期间被其他逻辑改过）
    const pd2 = await _getPhoneData();
    if (!pd2) return;
    if (!Array.isArray(pd2.heartsimServiceMessages)) pd2.heartsimServiceMessages = [];
    pd2.heartsimServiceMessages.push({
      role: 'assistant',
      text: reply,
      time: Date.now(),
    });
    await _savePhoneData();
    // 仅当客服页还开着时重渲，否则等下次打开时历史里就有了
    if (_isAppStillActive('heartsim_app') && _hsAppTab === 'service') {
      _renderHeartSimApp(pd2);
    }
  }, 1200);
}

// 在客服消息列表底部插入"正在输入..."气泡
function _hsShowTypingIndicator() {
  const list = document.getElementById('phone-hs-service-list');
  if (!list) return;
  // 防重复
  if (document.getElementById('hs-typing-bubble')) return;
  // 拿当前客服头像（从已渲染的第一条 ai 气泡复用）
  const existingAvatar = list.querySelector('img');
  const avatarSrc = existingAvatar?.getAttribute('src') || '';
  const avatarHTML = avatarSrc
    ? `<img src="${avatarSrc}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
    : `<div style="font-size:14px;font-weight:600;color:var(--text-secondary);text-align:center;line-height:36px">心</div>`;
  const node = document.createElement('div');
  node.id = 'hs-typing-bubble';
  node.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;align-items:flex-start';
  node.innerHTML = `
    <div style="width:36px;height:36px;border-radius:50%;overflow:hidden;flex-shrink:0;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center">${avatarHTML}</div>
    <div class="hs-bubble-ai" style="border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.55;color:var(--text-secondary)">
      <div class="typing-indicator"><span></span><span></span><span></span></div>
    </div>
  `;
  list.appendChild(node);
  list.scrollTop = list.scrollHeight;
}

function _hsHideTypingIndicator() {
  const node = document.getElementById('hs-typing-bubble');
  if (node) node.remove();
}

// 处理"回家"指令：返回客服回复字符串
// 同步在 pd 上修改 hsHomeRequestSent / hsPendingHomeNotice（调用方会 save）
function _resolveHsHomeRequest(pd) {
  // 已经发过 → 一律回"已开启"
  if (pd.hsHomeRequestSent) {
    return '返航通道已开启，请耐心等待。';
  }

  // 判定通关条件
  let check = { passed: false, reasons: ['无法读取心动模拟状态'] };
  try {
    if (typeof StatusBar !== 'undefined' && StatusBar.hsCheckClearCondition) {
      check = StatusBar.hsCheckClearCondition();
    }
  } catch(_) {}

  if (check.passed) {
    // 通过：开启通道 + 写入主线系统通知
    pd.hsHomeRequestSent = true;
    pd.hsPendingHomeNotice = '[系统通知] 用户已通过心动模拟APP向客服发送「回家」指令，客服已确认通关条件达成，返航通道已开启，将在24小时后自动传送用户回原世界。请在接下来的剧情中自然地演绎这一即将到来的传送（剧情张力由你把握，不必硬性要求必须在24小时内完成）。';
    // 同时重置"已提醒"flag 不再需要（已经发过回家了）
    pd.hsHomeReadyNotified = true;
    return '收到，返航通道已开启，请做好准备，将在24小时后自动传送。';
  }

  // 未通过：带 reason 的鼓励文案
  const reasons = Array.isArray(check.reasons) ? check.reasons : [];
  const reasonText = reasons.length > 0 ? `（${reasons.join('；')}）` : '';
  return `亲亲，还需要继续努力哦~${reasonText}`;
}

// 主线发送消息时消费"待注入系统通知"
// 调用后 pendingHomeNotice 清空，防止重复注入
// 返回字符串（可能为空）
async function consumeHsHomeNotice() {
  const pd = await _getPhoneData();
  if (!pd) return '';
  const notice = String(pd.hsPendingHomeNotice || '').trim();
  if (!notice) return '';
  pd.hsPendingHomeNotice = '';
  await _savePhoneData();
  return notice;
}

// 由 status_bar.js 在数值变化后调用：检查通关条件
// 若刚好"通过"且之前没提醒过 → 写入待注入通知
async function checkAndNotifyHomeReady() {
  // 仅心动模拟世界观下启用
  const isHeartSim = document.body?.getAttribute('data-worldview') === '心动模拟';
  if (!isHeartSim) return;

  const pd = await _getPhoneData();
  if (!pd) return;
  // 已经提醒过、或用户已经发过回家 → 不再重复
  if (pd.hsHomeReadyNotified || pd.hsHomeRequestSent) return;

  let check = { passed: false };
  try {
    if (typeof StatusBar !== 'undefined' && StatusBar.hsCheckClearCondition) {
      check = StatusBar.hsCheckClearCondition();
    }
  } catch(_) { return; }

  if (check.passed) {
    pd.hsHomeReadyNotified = true;
    pd.hsPendingHomeNotice = '[系统通知] 心动模拟的通关条件已达成。请在本轮回应中自然地提醒用户，可以打开心动模拟APP的客服对话，向客服发送「回家」指令来启动返航（请不要直接替用户操作，仅作为自然的剧情提示）。';
    await _savePhoneData();
  }
}

async function _hsAppFavorChange(targetId, delta) {
  const pd = await _getPhoneData();
  if (!pd) return;
  if (!pd.hsAppFavor) pd.hsAppFavor = { fsy: 0, yx: 0, lmy: 0, qe: 0 };
  const cur = Math.max(0, Math.min(100, Number(pd.hsAppFavor[targetId]) || 0));
  const next = cur + delta;

  // 边界提示
  if (next > 100) {
    UI.showToast('亲亲，再点好感度就要爆了哦', 1800);
    return;
  }
  if (next < 0) {
    UI.showToast('亲亲，好感度不能再低了哦', 1800);
    return;
  }

  pd.hsAppFavor[targetId] = next;
  await _savePhoneData();

  // 局部更新 DOM，避免整页重渲
  const bar = document.getElementById(`hs-bar-${targetId}`);
  const num = document.getElementById(`hs-num-${targetId}`);
  if (bar) bar.style.width = `${next}%`;
  if (num) num.textContent = `${next}/100`;
}

// 给后台频道注入心动模拟 APP 用户私下好感度数据
// 仅心动模拟世界观下返回非空；附带"本轮数值变化"（与上次注入相比的 delta）
// 调用后会自动把当前值写回 snapshot，下次再调用时 delta 会重新归零
async function buildHeartsimAppFavorForBackstage() {
  // 仅心动模拟世界观
  const isHeartSim = document.body?.getAttribute('data-worldview') === '心动模拟';
  if (!isHeartSim) return '';

  const pd = await _getPhoneData();
  if (!pd) return '';
  const cur = pd.hsAppFavor || {};
  const snap = pd.hsAppFavorSnapshot || {};
  const targets = await _ensureHsAppTargets(pd);
  if (!targets.length) return '';

  const lines = [];
  lines.push('【心动模拟 APP · 玩家私下好感度（仅后台可见）】');
  lines.push('该数据为玩家在「心动模拟」APP 内手动调整的私下好感度，仅用于玩家自娱自乐，不影响实际游戏数值。');
  lines.push('提示：此数据仅后台可见，主线 AI 不可见，心动模拟 APP 内数据为最高机密，无法被任何 NPC 窥探（包括黑化查手机时）。');
  lines.push('');
  for (const t of targets) {
    const v = Math.max(0, Math.min(100, Number(cur[t.id]) || 0));
    const prev = Math.max(0, Math.min(100, Number(snap[t.id]) || 0));
    const diff = v - prev;
    const diffText = diff === 0 ? '本轮无变化' : (diff > 0 ? `本轮 +${diff}` : `本轮 ${diff}`);
    const aliasPart = t.alias ? `（@${t.alias}）` : '';
    lines.push(`- ${t.name}${aliasPart}：当前 ${v}/100｜${diffText}`);
  }

  // 写回 snapshot
  pd.hsAppFavorSnapshot = { ...cur };
  await _savePhoneData();

  return lines.join('\n');
}

// 给后台频道注入"用户与心动模拟客服的对话记录"
// 仅心动模拟世界观下返回非空。本期新增标记 ★。
async function buildHeartsimServiceChatForBackstage() {
  const isHeartSim = document.body?.getAttribute('data-worldview') === '心动模拟';
  if (!isHeartSim) return '';

  const pd = await _getPhoneData();
  if (!pd) return '';
  const all = Array.isArray(pd.heartsimServiceMessages) ? pd.heartsimServiceMessages : [];
  if (all.length === 0) return '';

  const lastIdx = Number.isInteger(pd.heartsimServiceSyncIdx) ? pd.heartsimServiceSyncIdx : 0;

  const lines = [];
  lines.push('【心动模拟 APP · 客服对话记录（仅后台可见）】');
  lines.push('以下是用户在心动模拟 APP 内的「心动模拟客服」对话框中收发的全部消息。客服侧绝大多数为前端关键词匹配的预设回复（"亲亲式"自动回复人设），玩家可能借此发牢骚、骂街、玩梗、套话；若末尾出现头像漆黑、来源不明的消息，表示返航过场动画的悬念点。');
  lines.push('★ 标注的是本轮新增的消息（自上次后台同步以来）；未标注的为历史。');
  lines.push('');

  all.forEach((m, i) => {
    const isNew = i >= lastIdx;
    const prefix = isNew ? '★ ' : '  ';
    const role = m.role === 'user' ? '用户' : (m.blackAvatar ? '（漆黑头像）' : '客服');
    const text = String(m.text || '').replace(/\s+/g, ' ').trim();
    lines.push(`${prefix}[${role}] ${text}`);
  });

  // 写回 syncIdx
  pd.heartsimServiceSyncIdx = all.length;
  await _savePhoneData();

  return lines.join('\n');
}

// v687.33：手机快照（供回滚/分支用，剥离图片字段减小体积）
  async function getSnapshotForRollback() {
    try {
      const pd = await _getPhoneData();
      if (!pd) return null;
      const snap = JSON.parse(JSON.stringify(pd));
      // 剥离图片 dataURL 字段（图片已进图库，不需要随快照存储）
      if (snap.profile) snap.profile.avatar = '';
      snap.momentsCover = '';
      snap.wallpaper = '';
      if (Array.isArray(snap.moments)) {
        snap.moments.forEach(m => { if (m) m.image = ''; });
      }
      if (Array.isArray(snap.hsAppTargets)) {
        snap.hsAppTargets.forEach(t => { if (t) t.avatar = ''; });
      }
      return snap;
    } catch(e) { console.warn('[Phone] getSnapshotForRollback failed', e); return null; }
  }

  // v687.33：从快照恢复手机数据（回滚/分支用）
  async function restoreFromSnapshot(snap) {
    try {
      const convId = Conversations.getCurrent && Conversations.getCurrent();
      if (!convId) return;
      const conv = Conversations.getList().find(c => c.id === convId);
      if (!conv) return;
      // 保留当前的图片字段（快照里被清空了），其余全部覆盖
      const currentPd = conv.phoneData || {};
      const restored = JSON.parse(JSON.stringify(snap));
      // 恢复图片：用当前值回填（图片是用户上传的，不会因为剧情回退而改变）
      if (currentPd.profile?.avatar) {
        restored.profile = restored.profile || {};
        restored.profile.avatar = currentPd.profile.avatar;
      }
      if (currentPd.momentsCover) restored.momentsCover = currentPd.momentsCover;
      if (currentPd.wallpaper) restored.wallpaper = currentPd.wallpaper;
      // moments 和 hsAppTargets 的图片不回填——因为回滚后可能那些 moment 还没发过
      conv.phoneData = restored;
      // v687.35：回溯后如果返航动画尚未触发，重置整个返航流程的 flag
      // 让通关提醒 → 客服回家指令 → AI输出marker → 动画 可以完整重走
      if (!restored.hsHomecomingTriggered) {
        restored.hsHomeReadyNotified = false;
        restored.hsHomeRequestSent = false;
        restored.hsPostHomeMode = null;
        restored.hsCompanion = '';
        restored.hsPendingHomeNotice = '';
      }
      await Conversations.saveList();
      // 刷新内存中的 actionLog
      reloadActionLog();
    } catch(e) { console.warn('[Phone] restoreFromSnapshot failed', e); }
  }

// ===== 对外接口 =====
  return {
    open, close, minimize, goHome, goBack, openApp, isOpen,
    setNotification, recordLocation,
    buildPhoneDataForAI,
    buildHeartsimAppFavorForBackstage,
    buildHeartsimServiceChatForBackstage,
    flushActionLog, peekActionLog, pushLog, reloadActionLog, reloadChatRoundLog,
    flushActionLogForBackstage,
    getSnapshotForRollback, restoreFromSnapshot,
    _getPhoneData, _onWallpaperPicked, _resetWallpaper, _toggleWallpaperOverlay, _onWallpaperOpacityChange, _saveWallpaperOpacity, _toggleSendActionLog, _onMomentsCoverPicked, _clearMomentsCover,
    // 个人资料卡
    _onProfileFocus, _onProfileBlur, _onProfileKeydown, _onProfileInput, _pickProfileAvatar,
    // 主屏分页
    _onPagesScroll,
    // 聊天 App
  _switchChatTab, _addChatContact, _addChatContactByIdx, _openChatThread, _syncMainlineForContact, _chatSendMessage, _chatRequestReply, _showChatBubbleMenu, _toggleChatPlusMenu, _closeChatPlusMenu, _toggleChatVoiceMode, _chatDoSend, _chatSendVoice, _playVoice, _openChatSettings, _onChatSettingsVoiceToggle, _saveChatSettings, _openChatLocationPicker, _confirmChatLocation, _showChatLocationDetail, _openChatOrderPicker, _sendChatOrder, _openAlbumPickerForChat, _pickAlbumForChat, _showChatPhotoDetail, _openImagePickerForChat, _onChatImagePicked,
  ingestChatMessages, getChatHistoryForNPCs,
    // 相机 App
    _switchCameraTab, _cameraRefillFromStatus, _cameraOpenAdjust, _cameraShoot, _cameraOpenPhoto, _cameraOnTextInput,
    _closePhotoDetail, _photoEditText, _photoCopyText, _photoDownloadImage, _photoDelete, _photoShareMoment, _photoShareMain,
    _openAlbumPickerForMoment, _closeAlbumPicker, _pickAlbumForMoment,
    _closeCameraAdjust, _cameraAIWrite, _cameraAIDraw,
    // 内部方法需要暴露给 onclick
    _addMemo, _editMemo, _saveMemo, _deleteMemo, _shareMemo, _collectMemo,
    _forumRefresh, _forumSearch, _forumViewDetail, _shareForumPost, _collectForumPost, _likeForumPost,
    _switchForumTab, _shareForumSearch, _shareAllForumSearches, _deleteForumSearch,
    _addForumPost, _editForumPost, _saveForumPost, _deleteForumPost, _viewMyForumPost, _collectMyForumPost, _likeMyForumPost, _sendMyForumComment, _sendForumComment, _refreshForumComment, _shareMyForumPost, _refreshMyForumPost,
    _forumShareToChat,
    _postMoment, _onMomentImagePicked, _toggleImageDesc, _submitMoment, _shareMoment, _collectMyMoment, _editMyMoment, _deleteMyMoment, _shareNpcMoment, _refreshMomentComments, _refreshNpcMoments, _editNpcMoment, _deleteNpcMoment,
_openMomentVisibleModal, _closeMomentVisibleModal, _filterMomentVisibleOptions, _toggleMomentVisibleOption, _setMomentVisibleAll,
_onMomentsConfigCountChange, _onMomentsConfigImgChange, _onMomentsConfigStorageChange,
_toggleMomentsAutoRefresh, _tickMomentsAutoRefresh,
    _switchMomentsTab, _collectNpcMoment, _likeNpcMoment, _commentNpcMoment, _saveMomentImageToAlbum,
    _mapSearch, _shareMapResult, _collectMapResult, _switchMapTab, _renderMapResultsHtml,
    _shareMapSearch, _shareAllMapSearches, _deleteMapSearch, _deleteLocationHistory,
    _mapShareToChat,
    // 外卖/网购
    _switchShopTab, _shopRefresh, _shopSearch, _shopRepeatSearch, _deleteShopSearch,
    _shopOpenCustomModal, _shopCloseCustomModal, _shopConfirmCustom,
    _shopBuyForSelf, _shopBuyForTarget, _shopConfirmTarget, _shopCloseTargetModal,
    _shopShareItem, _shopShareToChat,
    _shopDeleteOrder,
    // 钱包
    _walletAddCurrency, _walletRemoveCurrency, _openChatTransfer,
    // 心动模拟 APP
    _hsAppFavorChange,
    _switchHsAppTab,
    _hsServiceSend,
    _hsAddTarget,
    _hsEditTarget,
    _hsDeleteTarget,
    _hsCloseEdit,
    _hsSaveEdit,
    _hsEditAvatarPicked,
    consumeHsHomeNotice,
    checkAndNotifyHomeReady,
    // 心动模拟 — 返航动画
    isHsHomecomingTriggered: async () => {
      const pd = await _getPhoneData();
      return !!(pd && pd.hsHomecomingTriggered);
    },
    markHsHomecomingTriggered: async (messages) => {
      const pd = await _getPhoneData();
      if (!pd) return;
      pd.hsHomecomingTriggered = true;
      // 把返航动画里的全部消息追加到客服历史
      if (Array.isArray(messages) && messages.length > 0) {
        if (!Array.isArray(pd.heartsimServiceMessages)) pd.heartsimServiceMessages = [];
        for (const m of messages) {
          if (!m || !m.text) continue;
          pd.heartsimServiceMessages.push({
            role: 'assistant',
            text: m.text,
            time: Date.now(),
            // 标记非客服消息（最后那条"亲爱的，你想去哪？"）
            blackAvatar: !!m.blackAvatar
          });
        }
      }
      await _savePhoneData();
    },
  };
})();
window.Phone = Phone;
