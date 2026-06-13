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
    // 切对话时重置日历状态
    _calViewYear = 0; _calViewMonth = 0; _calSelectedDay = 0;
    _wvFestivalsCache = []; _calRulesCache = null;
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
  // 进行中的通话：动态追加状态提示（不写入 _actionLog，避免被消费清空，每轮都能重新生成）
  if (_activeCall) {
    const cn = _activeCall.contactName || '某位联系人';
    const ml = _activeCall.mode === 'video' ? '视频' : '语音';
    log.push(`正在和${cn}进行${ml}通话，尚未结束，通话内容暂不可见。可以简单描述{{user}}的通话行为，但不要编造通话内容，请等待通话结束。`);
  }
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
// phoneDown：线上聊天触发收手机后的 pending 数据，供 chat.js 消费
let _pendingPhoneDown = null;
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
    lines.push(`在手机聊天APP与「${contactName}」新增以下对话（仅供了解上下文，不要在线下剧情中以对话格式复述这些内容）：`);
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

  // 同步读取（不补字段，仅用于渲染读数据）
  function _getPhoneDataSync() {
    const convId = Conversations.getCurrent();
    if (!convId) return null;
    const conv = Conversations.getList().find(c => c.id === convId);
    if (!conv || !conv.phoneData) return null;
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
    // 番茄钟
    tomatoHistory: [],        // [{id, goal, duration, companion, completedAt, interrupted}]
    tomatoSettings: { syncMainline: true, lockScreen: false },
    tomatoTotalMinutes: 0,    // 累计专注总分钟数
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
 // 游鱼小店 App
 shopListings: [],         // 在售商品 [{id, name, effect, price, currencyId, fromInventory, maskId, time}]
 // 记账 APP
  ledger: [],               // 账目 [{id, time, currencyId, amount(正收入/负支出), category, note, platform, counterparty, source, editable}]
  ledgerSnapshot: {},       // {currencyId: 上次余额快照} 用于 diff 兜底
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
  calendarEvents: [], // 日历事项 [{id, title, type, month, day, year, note, color}]
  // 一起听
  listenTogether: null, // 当前会话状态（null=未开启）
  // {
  //   active: true,
  //   mode: 'broadcast'|'earphone'|'online', // 公放/耳机共享/线上
  //   target: { name, avatar, contactId? },  // 对象（公放时 name='公放', avatar=''）
  //   startTime: '',     // 状态栏时间快照（进入时）
  //   playlist: [],      // [{title, artist, duration}] 本次播放过的歌
  //   messages: [],      // [{from, content, time}] 留言
  //   lastTrackId: null  // 上一首歌 id（用于切歌日志）
  // }
  listenTogetherHistory: [], // 历史记录 [{mode, target, startTime, endTime, duration, playlist, messages}]
  // 电台 App
  radioChannels: null,   // 频道列表（null=未初始化，首次打开填默认5个）[{id, name, desc, icon, djName, relatedNpcs:[], isDefault}]
  radioPrograms: {},     // 各频道的节目单缓存 { channelId: [{id, title, summary, dj, interact, time, content?}] }
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
    // 番茄钟锁屏：运行中不允许关闭手机
    if (_tomatoTimer && _tomatoIsLocked()) {
      UI.showToast('专注中，屏幕已锁定', 1500);
      return;
    }
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

    // phoneDown 入口A：手机关闭时，如果有 pending 且用户在聊天页且不在 streaming，直接触发
    if (_pendingPhoneDown) {
      try {
        const chatPanel = document.querySelector('#panel-chat.active');
        const canTrigger = chatPanel && typeof Chat !== 'undefined' && !Chat.isStreamingNow();
        if (canTrigger) {
          setTimeout(() => {
            try {
              if (!_pendingPhoneDown) return;
              const input = document.getElementById('chat-input');
              if (input && !Chat.isStreamingNow()) { input.value = '<PhoneDown/>'; Chat.send(); }
            } catch(_) {}
          }, 500);
        }
      } catch(_) {}
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
  async function _buildFullContext(opts) {
    const npcBrief = !!(opts && opts.npcBrief);
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
        if (npcBrief) {
          // brief 模式：世界观 NPC 只发速查表，不发详细资料
          try {
            const quickRef = NPC.formatQuickRef();
            if (quickRef) parts.push(quickRef);
          } catch(_) {}
          // 世界书 NPC brief 模式：只发名字+别名，不发 detail（避免串味）
          if (bookExtra.globalNpcs.length > 0) {
            const lines = bookExtra.globalNpcs.map(npc => {
              let d = npc.name || '未命名';
              if (npc.aliases) d += `（别名：${npc.aliases}）`;
              return d;
            });
            parts.push('【世界书角色索引】\n' + lines.join('\n'));
          }
        } else {
        // 完整模式：全图 NPC + 详细资料（世界观 + 世界书合并）
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
        }

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
  wallet: `<svg ${common}><rect x="2" y="6" width="20" height="14" rx="2"></rect><path d="M16 12h2v2h-2z"></path><path d="M2 10h20"></path></svg>`,
 ledger: `<svg ${common}><path d="M5 3h12a2 2 0 0 1 2 2v16l-3-2-3 2-3-2-3 2V5a2 2 0 0 1 2-2z"></path><line x1="9" y1="8" x2="14" y2="8"></line><line x1="9" y1="12" x2="14" y2="12"></line></svg>`,
  calendar: `<svg ${common}><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line><rect x="8" y="14" width="2" height="2"></rect><rect x="13" y="14" width="2" height="2"></rect></svg>`,
    mail: `<svg ${common}><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"></path></svg>`,
     radio: `<svg ${common}><path d="M16 3 7 7"></path><rect x="3" y="7" width="18" height="14" rx="2"></rect><circle cx="8" cy="14" r="3"></circle><line x1="16" y1="12" x2="18" y2="12"></line><line x1="16" y1="16" x2="18" y2="16"></line></svg>`,
   feiniao: `<svg ${common}><path d="M16 7h.01"></path><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"></path><path d="m20 7 2 .5-2 .5"></path><path d="M10 18v3"></path><path d="M14 17.75V21"></path><path d="M7 18a6 6 0 0 0 3.84-10.61"></path></svg>`,
   youyu: `<svg ${common}><path d="M2 16s9-15 20-4C11 23 2 8 2 8"/></svg>`
   };
 return `<span class="phone-icon-glyph phone-icon-${type}">${icons[type] || ''}</span>`;
}
function _uiIcon(type, size = 16) {
 const common = `viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
 const icons = {
 back: `<svg ${common}><path d="M15 18l-6-6 6-6"></path></svg>`,
 refresh: `<svg ${common}><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path><path d="M3 21v-5h5"></path></svg>`,
 pen: `<svg ${common}><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`,
 share: `<svg ${common}><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/></svg>`,
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
 settings: `<svg ${common}><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"></path></svg>`,
 check: `<svg ${common}><polyline points="20 6 9 17 4 12"></polyline></svg>`,
 box: `<svg ${common}><path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8Z"></path><path d="m3.3 7 8.7 5 8.7-5"></path><path d="M12 22V12"></path></svg>`
 };
 return icons[type] || '';
}
function _renderHomeIcon(a) {
// 占位图标：渲染成空白格子（无图标、可带名字、不可点）
    if (a.icon === 'placeholder') {
      return `<div class="phone-app-icon phone-app-placeholder" aria-hidden="true">
        <div class="phone-app-icon-circle phone-app-icon-circle-placeholder"></div>
        <span class="phone-app-icon-label">${Utils.escapeHtml(a.name || '')}</span>
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
  document.querySelector('#phone-modal .phone-shell')?.classList.remove('phone-tomato-mode');
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
      // 第二页（生活页）app
      const apps2 = [
        { id: 'calendar', icon: 'calendar', name: '日历' },
        { id: 'settings', icon: 'gear', name: '设置' },
        { id: 'email', icon: 'mail', name: '邮箱' },
        { id: 'radio', icon: 'radio', name: '电台' },
      ];
      // 小组件页底部 app
      const widgetApps = [
      { id: 'feiniao', icon: 'feiniao', name: '飞鸟快递' },
    { id: 'youyu', icon: 'youyu', name: '游鱼小铺' },
      { id: '_ph1', icon: 'placeholder', name: '未开放' },
      { id: '_ph2', icon: 'placeholder', name: '未开放' },
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
  <div class="phone-delivery-widget" id="phone-delivery-widget"></div>
  <div class="phone-page2-row">
    <div class="phone-page2-apps">
      ${widgetApps.map(a => _renderHomeIcon(a)).join('')}
    </div>
    <div class="phone-tomato-card" id="phone-tomato-card" onclick="Phone.openApp('tomato')"></div>
  </div>
  <div class="phone-home-spacer"></div>
 </div>
 <div class="phone-page">
 <div id="phone-cal-banner" class="phone-cal-banner" onclick="Phone.openApp('calendar')" style="display:none"></div>
  <div class="phone-page2-row">
    <div class="phone-page2-apps">
      ${apps2.map(a => _renderHomeIcon(a)).join('')}
    </div>
    <div class="phone-anniversary-card" id="phone-anniversary-card" onclick="Phone._openAnniversaryEditor()"></div>
  </div>
  <div class="phone-music-card" id="phone-music-card"></div>
  <div class="phone-home-spacer"></div>
 </div>
 </div>
<div class="phone-page-indicator" id="phone-page-indicator">
   <div class="phone-page-dot active"></div>
   <div class="phone-page-dot"></div>
   <div class="phone-page-dot"></div>
 </div>
 </div>
 <div class="phone-dock">
   ${dockApps.map(a => _renderHomeIcon(a)).join('')}
 </div>
 </div>
 `;

  // 填充小组件数据（从 status 缓存拿）
  _refreshWidget();
  _getPhoneData().then(pd => { _applyWallpaper(pd); _applyProfile(pd); }).catch(() => {});
  // 音乐卡片：绑监听 + 首次渲染（库异步加载完再刷一次）
  try {
    _bindMusicListeners();
    if (typeof Music !== 'undefined') {
      Music._ensureLoaded().then(() => { try { _refreshMusicCard(); } catch (_) {} });
    }
    _refreshMusicCard();
  } catch (_) {}
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
  let _lastPageScroll = 0; // 返回首页时恢复滚动位置

  function _pushNav(renderFn) {
    if (_isNavBack) return; // goBack 触发的渲染不 push
    _navStack.push(renderFn);
    document.getElementById('phone-back-btn')?.classList.remove('hidden');
  }

  async function goBack() {
    // 番茄钟锁屏：运行中不允许离开
    if (_tomatoTimer && _tomatoIsLocked() && _currentApp === 'tomato') {
      UI.showToast('专注中，屏幕已锁定', 1500);
      return;
    }
    // 一起听页面返回时：回音乐库但保持一起听模式
    const titleEl = document.getElementById('phone-title');
    if (titleEl && titleEl.textContent === '一起听' && _ltSession) {
      // 清除导航栈，回音乐库，但不关闭一起听会话
      _navStack = [];
      await _openMusicLibrary();
      return;
    }
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
      // 直接恢复之前所在的页面（无动画）
      requestAnimationFrame(() => {
        const pages = document.getElementById('phone-pages');
        if (pages && _lastPageScroll) {
          pages.style.scrollBehavior = 'auto';
          pages.scrollLeft = _lastPageScroll;
          pages.style.scrollBehavior = '';
        }
      });
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
    // 刷新第二页 banner
    try {
      if (!_calRulesCache && !_wvFestivalsCache.length) {
        // 缓存为空，异步刷新后再渲染 banner
        Promise.all([_refreshCalRulesCache(), _refreshWvFestivalsCache()]).then(() => _refreshCalBanner()).catch(() => {});
      } else {
        _refreshCalBanner();
      }
    } catch(_) {}
    // 刷新纪念日卡片
    try { _refreshAnniversaryCard(); } catch(_) {}
    // 刷新配送小组件
    try { _refreshDeliveryWidget(); } catch(_) {}
    // 刷新番茄钟卡片
    try { _refreshTomatoCard(); } catch(_) {}
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
// 未完成的APP：直接拦截，不进入APP模式
if (appId === 'email') { UI.showToast('邮箱开发中...', 1500); return; }
if (appId === 'radio') { UI.showToast('电台开发中...', 1500); return; }
  // 记住当前页面滚动位置，返回时恢复
  try {
    const pages = document.getElementById('phone-pages');
    if (pages) _lastPageScroll = pages.scrollLeft;
  } catch(_) {}
  _currentApp = appId;
 document.querySelector('#phone-modal .phone-shell')?.classList.remove('phone-forum-detail-mode');
 document.querySelector('#phone-modal .phone-shell')?.classList.remove('phone-home-mode');
 document.querySelector('#phone-modal .phone-shell')?.classList.remove('phone-tomato-mode');
 document.getElementById('phone-back-btn')?.classList.remove('hidden');
 // 清空标题栏右上角（各 App 自行按需重填，避免上一个 App 的按钮残留）
 { const _hr = document.getElementById('phone-header-right'); if (_hr) _hr.innerHTML = ''; }

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
  case 'calendar': _renderCalendar(phoneData); break;
 case 'takeout': _renderShopping(phoneData, 'takeout'); break;
 case 'shop': _renderShopping(phoneData, 'shop'); break;
 case 'camera': _renderCamera(phoneData); break;
 case 'heartsim_app': _renderHeartSimApp(phoneData); break;
 case 'ledger': _renderLedger(phoneData); break;
 case 'radio': _renderRadio(phoneData); break;
 case 'feiniao': _renderFeiniao(phoneData); break;
 case 'youyu': _renderYouyu(phoneData); break;
 case 'deliveries': _renderDeliveries(phoneData); break;
      case 'tomato': _renderTomato(phoneData); break;
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

// ===== 记账 App =====
let _ledgerCurTab = null; // 当前查看的货币 id（null=自动取第一个）
let _ledgerView = 'month'; // 'month' | 'calendar' | 'year'
let _ledgerCalDay = null; // 日历视图中选中的日（null=未选中）

// 余额 diff 兜底：对比当前余额和上次快照，差额补一条「未知变动」
async function _ledgerReconcile() {
  const pd = await _getPhoneData();
  if (!pd) return;
  const infos = _getWalletCurrencyInfos();
  if (!infos.length) return;
  pd.ledger = pd.ledger || [];
  pd.ledgerSnapshot = pd.ledgerSnapshot || {};
  let changed = false;
  for (const cur of infos) {
    const balance = Number(cur.balance) || 0;
    if (!(cur.id in pd.ledgerSnapshot)) {
      // 首次见到该货币：直接记基准，不补差额
      pd.ledgerSnapshot[cur.id] = balance;
      changed = true;
      continue;
    }
    const snap = Number(pd.ledgerSnapshot[cur.id]) || 0;
    // 已记账净额（快照之后的）：用全部账目净额无法精确切分区间，
    // 这里用「当前余额 - 快照」作为本区间总变动，再扣掉本区间已记账净额。
    // 简化：本区间已记账净额 = 自上次 reconcile 后新增账目的净额，
    // 用 _lastReconcileLedgerLen 记录长度切片。
    const lastLen = pd._lastReconcileLedgerLen?.[cur.id] || 0;
    let recorded = 0;
    for (let i = lastLen; i < pd.ledger.length; i++) {
      if (pd.ledger[i].currencyId === cur.id) recorded += (+pd.ledger[i].amount || 0);
    }
    const diff = balance - snap - recorded;
    if (Math.abs(diff) > 0.001) {
      pd.ledger.push({
        id: 'le_' + Utils.uuid().slice(0, 8),
        time: _getGameTime() || '',
        currencyId: cur.id,
        amount: diff,
        category: diff < 0 ? '其他支出' : '其他收入',
        note: '剧情变动（可补充）',
        platform: '',
        counterparty: '',
        source: 'unknown',
        editable: true,
      });
      changed = true;
    }
    pd.ledgerSnapshot[cur.id] = balance;
  }
  // 更新切片基准
  pd._lastReconcileLedgerLen = {};
  for (const cur of infos) pd._lastReconcileLedgerLen[cur.id] = pd.ledger.length;
  if (changed) {
    pd.ledger = pd.ledger.slice(-300);
    await _savePhoneData();
  }
}

async function _renderLedger(pd) {
  await _ledgerReconcile();
  pd = await _getPhoneData();
  const body = document.getElementById('phone-body');
  document.getElementById('phone-title').textContent = '记账';
  _applyWallpaper(pd);

  const infos = _getWalletCurrencyInfos();
  if (!infos.length) {
    body.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:40px 20px;text-align:center">
      <div style="font-size:14px;color:var(--text-secondary);line-height:1.8">还没有绑定货币<br><span style="font-size:12px;opacity:0.7">先去钱包绑定货币才能记账</span></div>
    </div>`;
    return;
  }

  // 当前货币 tab
  if (!_ledgerCurTab || !infos.some(c => c.id === _ledgerCurTab)) _ledgerCurTab = infos[0].id;
  const curInfo = infos.find(c => c.id === _ledgerCurTab);

  // 货币切换标签（多货币时显示）
  const curTabs = infos.length > 1 ? `
    <div class="phone-ledger-curtabs">
      ${infos.map(c => `<div class="phone-ledger-curtab ${c.id === _ledgerCurTab ? 'active' : ''}" onclick="Phone._ledgerSwitchCur('${Utils.escapeHtml(c.id)}')">${Utils.escapeHtml(c.name)}</div>`).join('')}
    </div>` : '';

  const ledger = (pd.ledger || []).filter(e => e.currencyId === _ledgerCurTab);

  // 右上角视图循环切换图标
  const viewIcon = { month: 'calendar', calendar: 'chartYear', year: 'chartMonth' };
  const viewTitle = { month: '月视图（点切日历）', calendar: '日历视图（点切年）', year: '年视图（点切月）' };
  const headerRight = document.getElementById('phone-header-right');
  if (headerRight) {
    headerRight.innerHTML = `<button class="phone-ledger-viewbtn" title="${viewTitle[_ledgerView]}" onclick="Phone._ledgerCycleView()">${_ledgerViewSvg(viewIcon[_ledgerView])}</button>`;
  }

  let viewHtml;
  if (_ledgerView === 'calendar') viewHtml = _ledgerRenderCalendarView(ledger, curInfo);
  else if (_ledgerView === 'year') viewHtml = _ledgerRenderYearView(ledger, curInfo);
  else viewHtml = _ledgerRenderMonthView(ledger, curInfo);

  body.innerHTML = `
    <div class="phone-ledger-wrap">
      ${curTabs}
      ${viewHtml}
      <button class="phone-ledger-add-btn" onclick="Phone._ledgerAddManual()">+ 手动记一笔</button>
    </div>`;
}

// 视图切换图标
function _ledgerViewSvg(name) {
  const c = 'viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const M = {
    calendar: `<svg ${c}><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`,
    chartYear: `<svg ${c}><line x1="12" y1="20" x2="12" y2="10"></line><line x1="18" y1="20" x2="18" y2="4"></line><line x1="6" y1="20" x2="6" y2="16"></line></svg>`,
    chartMonth: `<svg ${c}><path d="M3 3v18h18"></path><path d="M7 14l4-4 3 3 5-6"></path></svg>`,
  };
  return M[name] || '';
}

// 月视图（原逻辑）
function _ledgerRenderMonthView(ledger, curInfo) {
  const cur = _getGameTime();
  const curParsed = (cur && typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) ? Calendar.parseAbsoluteTime(cur) : null;
  let monthIn = 0, monthOut = 0;
  for (const e of ledger) {
    const p = (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) ? Calendar.parseAbsoluteTime(e.time) : null;
    if (!p || !curParsed) continue;
    if (p.year === curParsed.year && p.month === curParsed.month) {
      if (e.amount >= 0) monthIn += e.amount; else monthOut += -e.amount;
    }
  }
  const monthSurplus = monthIn - monthOut;

  // 本月账目列表（按时间倒序）
  const monthLedger = ledger.filter(e => {
    const p = (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) ? Calendar.parseAbsoluteTime(e.time) : null;
    return p && curParsed && p.year === curParsed.year && p.month === curParsed.month;
  });
  const sorted = monthLedger.slice().sort((a, b) => (_gameTimeToMinutes(b.time) || 0) - (_gameTimeToMinutes(a.time) || 0));
  const listHtml = sorted.length ? sorted.map(_ledgerItemHtml).join('')
    : '<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:30px 0;opacity:0.7">本月暂无账目</div>';

  return `
    <div class="phone-ledger-summary">
      <div class="phone-ledger-sum-title">${Utils.escapeHtml(curInfo.name)} · 本月</div>
      <div class="phone-ledger-sum-row">
        <div class="phone-ledger-sum-cell"><div class="phone-ledger-sum-label">收入</div><div class="phone-ledger-sum-val in">+${monthIn}</div></div>
        <div class="phone-ledger-sum-cell"><div class="phone-ledger-sum-label">支出</div><div class="phone-ledger-sum-val out">-${monthOut}</div></div>
        <div class="phone-ledger-sum-cell"><div class="phone-ledger-sum-label">结余</div><div class="phone-ledger-sum-val ${monthSurplus < 0 ? 'out' : 'in'}">${monthSurplus >= 0 ? '+' : ''}${monthSurplus}</div></div>
      </div>
      <div class="phone-ledger-sum-bal">当前余额 ${Utils.escapeHtml(String(curInfo.balance))}</div>
    </div>
    <div class="phone-ledger-list">${listHtml}</div>`;
}

// 单条账目 HTML
function _ledgerItemHtml(e) {
  const isIn = e.amount >= 0;
  const amtText = (isIn ? '+' : '') + e.amount;
  const head = e.platform ? `${Utils.escapeHtml(e.platform)} · ${Utils.escapeHtml(e.note || e.category)}`
    : (e.counterparty ? `${Utils.escapeHtml(e.category)} · ${Utils.escapeHtml(e.counterparty)}`
    : Utils.escapeHtml(e.note || e.category || '记录'));
  const sub = [e.category, _formatPhoneTime(e.time || '')].filter(Boolean).map(Utils.escapeHtml).join(' · ');
  return `<div class="phone-ledger-item" onclick="Phone._ledgerEditEntry('${e.id}')">
    <div class="phone-ledger-item-main">
      <div class="phone-ledger-item-title">${head}</div>
      <div class="phone-ledger-item-sub">${sub}</div>
    </div>
    <div class="phone-ledger-item-amt ${isIn ? 'in' : 'out'}">${Utils.escapeHtml(amtText)}</div>
  </div>`;
}

// 日历视图：复用历法格子，有消费的天打小点，点某天展开当天明细
function _ledgerRenderCalendarView(ledger, curInfo) {
  const cur = _getGameTime();
  const curParsed = (cur && typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) ? Calendar.parseAbsoluteTime(cur) : null;
  if (!curParsed) return '<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:30px 0;opacity:0.7">无法获取当前时间</div>';

  let rules = null;
  try { rules = _getCalRulesCached(); } catch(_) {}
  const monthsPerYear = rules?.monthsPerYear || 12;
  const dpm = rules?.daysPerMonth || [];
  const daysInMonth = dpm.length ? (dpm[(curParsed.month - 1) % dpm.length] || 30) : 30;
  const weekNames = (rules?.weekDayNames && rules.weekDayNames.length) ? rules.weekDayNames : ['一','二','三','四','五','六','日'];
  const daysPerWeek = weekNames.length;

  // 当月每天净额
  const dayNet = {};
  for (const e of ledger) {
    const p = (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) ? Calendar.parseAbsoluteTime(e.time) : null;
    if (!p) continue;
    if (p.year === curParsed.year && p.month === curParsed.month) {
      dayNet[p.day] = (dayNet[p.day] || 0) + (+e.amount || 0);
    }
  }

  // 当月第一天是星期几（用历法推算）
  let firstWeekIdx = 0;
  try {
    if (typeof Calendar !== 'undefined' && Calendar.getWeekDay) {
      const wd = Calendar.getWeekDay({ year: curParsed.year, month: curParsed.month, day: 1, hour: 0, minute: 0 }, rules);
      const idx = weekNames.indexOf(wd);
      if (idx >= 0) firstWeekIdx = idx;
    }
  } catch(_) {}

  const weekHead = weekNames.map(n => `<div class="phone-ledger-cal-wd">${Utils.escapeHtml(n)}</div>`).join('');
  let cells = '';
  for (let i = 0; i < firstWeekIdx; i++) cells += '<div class="phone-ledger-cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const net = dayNet[d];
    const hasData = net !== undefined;
    const isSel = _ledgerCalDay === d;
    const dot = hasData ? `<div class="phone-ledger-cal-dot ${net < 0 ? 'out' : 'in'}"></div>` : '';
    cells += `<div class="phone-ledger-cal-cell ${isSel ? 'sel' : ''}" onclick="Phone._ledgerCalPick(${d})">
      <span class="phone-ledger-cal-day">${d}</span>${dot}
    </div>`;
  }

  // 选中某天的明细
  let dayDetail = '';
  if (_ledgerCalDay) {
    const dayLedger = ledger.filter(e => {
      const p = (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) ? Calendar.parseAbsoluteTime(e.time) : null;
      return p && p.year === curParsed.year && p.month === curParsed.month && p.day === _ledgerCalDay;
    }).sort((a, b) => (_gameTimeToMinutes(b.time) || 0) - (_gameTimeToMinutes(a.time) || 0));
    const detailList = dayLedger.length ? dayLedger.map(_ledgerItemHtml).join('')
      : '<div style="text-align:center;color:var(--text-secondary);font-size:12px;padding:20px 0;opacity:0.7">这天没有消费记录</div>';
    dayDetail = `<div class="phone-ledger-cal-detail">
      <div class="phone-ledger-cal-detail-title">${curParsed.month}月${_ledgerCalDay}日</div>
      ${detailList}
    </div>`;
  }

  return `
    <div class="phone-ledger-cal-month">${curParsed.year}年 ${curParsed.month}月</div>
    <div class="phone-ledger-cal-grid" style="grid-template-columns:repeat(${daysPerWeek},1fr)">
      ${weekHead}
      ${cells}
    </div>
    ${dayDetail}`;
}

// 年视图：按历法每月一行，显示收支结余 + 年度总计
function _ledgerRenderYearView(ledger, curInfo) {
  const cur = _getGameTime();
  const curParsed = (cur && typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) ? Calendar.parseAbsoluteTime(cur) : null;
  if (!curParsed) return '<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:30px 0;opacity:0.7">无法获取当前时间</div>';

  let rules = null;
  try { rules = _getCalRulesCached(); } catch(_) {}
  const monthsPerYear = rules?.monthsPerYear || 12;

  // 每月统计
  const mIn = {}, mOut = {};
  let yearIn = 0, yearOut = 0;
  for (const e of ledger) {
    const p = (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) ? Calendar.parseAbsoluteTime(e.time) : null;
    if (!p || p.year !== curParsed.year) continue;
    if (e.amount >= 0) { mIn[p.month] = (mIn[p.month] || 0) + e.amount; yearIn += e.amount; }
    else { mOut[p.month] = (mOut[p.month] || 0) + (-e.amount); yearOut += (-e.amount); }
  }
  const yearSurplus = yearIn - yearOut;

  let rows = '';
  for (let m = 1; m <= monthsPerYear; m++) {
    const inc = mIn[m] || 0, out = mOut[m] || 0, sur = inc - out;
    const isCur = m === curParsed.month;
    rows += `<div class="phone-ledger-year-row ${isCur ? 'cur' : ''}">
      <div class="phone-ledger-year-m">${m}月</div>
      <div class="phone-ledger-year-io"><span class="in">+${inc}</span> / <span class="out">-${out}</span></div>
      <div class="phone-ledger-year-sur ${sur < 0 ? 'out' : 'in'}">${sur >= 0 ? '+' : ''}${sur}</div>
    </div>`;
  }

  return `
    <div class="phone-ledger-summary">
      <div class="phone-ledger-sum-title">${Utils.escapeHtml(curInfo.name)} · ${curParsed.year}年</div>
      <div class="phone-ledger-sum-row">
        <div class="phone-ledger-sum-cell"><div class="phone-ledger-sum-label">年收入</div><div class="phone-ledger-sum-val in">+${yearIn}</div></div>
        <div class="phone-ledger-sum-cell"><div class="phone-ledger-sum-label">年支出</div><div class="phone-ledger-sum-val out">-${yearOut}</div></div>
        <div class="phone-ledger-sum-cell"><div class="phone-ledger-sum-label">年结余</div><div class="phone-ledger-sum-val ${yearSurplus < 0 ? 'out' : 'in'}">${yearSurplus >= 0 ? '+' : ''}${yearSurplus}</div></div>
      </div>
    </div>
    <div class="phone-ledger-year-list">${rows}</div>`;
}

function _ledgerCycleView() {
  _ledgerView = _ledgerView === 'month' ? 'calendar' : (_ledgerView === 'calendar' ? 'year' : 'month');
  _ledgerCalDay = null;
  _getPhoneData().then(pd => _renderLedger(pd));
}

function _ledgerCalPick(day) {
  _ledgerCalDay = (_ledgerCalDay === day) ? null : day;
  _getPhoneData().then(pd => _renderLedger(pd));
}

function _ledgerSwitchCur(id) {
  _ledgerCurTab = id;
  _getPhoneData().then(pd => _renderLedger(pd));
}

// 编辑账目弹窗
async function _ledgerEditEntry(entryId) {
  const pd = await _getPhoneData();
  const e = (pd?.ledger || []).find(x => x.id === entryId);
  if (!e) return;
  const isShop = e.source === 'shop' || e.source === 'takeout';
  const isTransfer = e.source === 'transfer_out' || e.source === 'transfer_in';

  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:20px';

  // 按类型显示不同字段
  let typeFields = '';
  if (isShop) {
    typeFields = `
      <label class="phone-ledger-field">平台<input id="led-f-platform" type="text" value="${Utils.escapeHtml(e.platform || '')}"></label>
      <label class="phone-ledger-field">商品<input id="led-f-note" type="text" value="${Utils.escapeHtml(e.note || '')}"></label>`;
  } else if (isTransfer) {
    typeFields = `
      <label class="phone-ledger-field">对象<input id="led-f-counterparty" type="text" value="${Utils.escapeHtml(e.counterparty || '')}"></label>
      <label class="phone-ledger-field">备注<input id="led-f-note" type="text" value="${Utils.escapeHtml(e.note || '')}"></label>`;
  } else {
    typeFields = `
      <label class="phone-ledger-field">备注<input id="led-f-note" type="text" value="${Utils.escapeHtml(e.note || '')}"></label>`;
  }

  mask.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:20px;max-width:340px;width:100%;color:var(--text);max-height:80vh;overflow-y:auto">
      <div style="font-size:15px;font-weight:600;margin-bottom:14px">编辑账目</div>
      <label class="phone-ledger-field">分类<input id="led-f-category" type="text" value="${Utils.escapeHtml(e.category || '')}"></label>
      <label class="phone-ledger-field">金额（正收入/负支出）<input id="led-f-amount" type="number" value="${e.amount}"></label>
      ${typeFields}
      <div style="font-size:11px;color:var(--text-secondary);opacity:0.7;margin:6px 0 14px;line-height:1.5">修改账本不影响实际余额，仅作记录</div>
      <div style="display:flex;gap:10px;justify-content:space-between">
        <button id="led-del" style="padding:8px 16px;border-radius:8px;border:1px solid var(--error);background:transparent;color:var(--error);font-size:13px;cursor:pointer">删除</button>
        <div style="display:flex;gap:10px">
          <button id="led-cancel" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="led-save" style="padding:8px 16px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">保存</button>
        </div>
      </div>
    </div>`;

  mask.querySelector('#led-cancel').onclick = () => document.body.removeChild(mask);
  mask.addEventListener('click', (ev) => { if (ev.target === mask) document.body.removeChild(mask); });
  mask.querySelector('#led-del').onclick = async () => {
    if (!await UI.showConfirm('删除账目', '确定删除这条记录？')) return;
    const pd2 = await _getPhoneData();
    pd2.ledger = (pd2.ledger || []).filter(x => x.id !== entryId);
    await _savePhoneData();
    document.body.removeChild(mask);
    _renderLedger(pd2);
  };
  mask.querySelector('#led-save').onclick = async () => {
    const pd2 = await _getPhoneData();
    const e2 = (pd2.ledger || []).find(x => x.id === entryId);
    if (!e2) { document.body.removeChild(mask); return; }
    e2.category = mask.querySelector('#led-f-category')?.value.trim() || e2.category;
    const amtV = parseFloat(mask.querySelector('#led-f-amount')?.value);
    if (Number.isFinite(amtV)) e2.amount = amtV;
    const noteEl = mask.querySelector('#led-f-note'); if (noteEl) e2.note = noteEl.value.trim();
    const platEl = mask.querySelector('#led-f-platform'); if (platEl) e2.platform = platEl.value.trim();
    const cpEl = mask.querySelector('#led-f-counterparty'); if (cpEl) e2.counterparty = cpEl.value.trim();
    await _savePhoneData();
    document.body.removeChild(mask);
    _renderLedger(pd2);
  };
  document.body.appendChild(mask);
}

// 手动记一笔
async function _ledgerAddManual() {
  const infos = _getWalletCurrencyInfos();
  if (!infos.length) { UI.showToast('请先在钱包绑定货币', 1500); return; }
  const curId = _ledgerCurTab || infos[0].id;
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:20px';
  mask.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:20px;max-width:340px;width:100%;color:var(--text)">
      <div style="font-size:15px;font-weight:600;margin-bottom:14px">手动记一笔</div>
      <label class="phone-ledger-field">类型
        <select id="led-m-type" style="width:100%">
          <option value="out">支出</option>
          <option value="in">收入</option>
        </select>
      </label>
      <label class="phone-ledger-field">金额<input id="led-m-amount" type="number" placeholder="例如 50"></label>
      <label class="phone-ledger-field">分类<input id="led-m-category" type="text" placeholder="例如 餐饮"></label>
      <label class="phone-ledger-field">备注<input id="led-m-note" type="text" placeholder="可选"></label>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
        <button id="led-m-cancel" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
        <button id="led-m-save" style="padding:8px 16px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">保存</button>
      </div>
    </div>`;
  mask.querySelector('#led-m-cancel').onclick = () => document.body.removeChild(mask);
  mask.addEventListener('click', (ev) => { if (ev.target === mask) document.body.removeChild(mask); });
  mask.querySelector('#led-m-save').onclick = async () => {
    const type = mask.querySelector('#led-m-type').value;
    const amtV = parseFloat(mask.querySelector('#led-m-amount').value);
    if (!Number.isFinite(amtV) || amtV <= 0) { UI.showToast('请输入有效金额', 1500); return; }
    const pd2 = await _getPhoneData();
    pd2.ledger = pd2.ledger || [];
    pd2.ledger.push({
      id: 'le_' + Utils.uuid().slice(0, 8),
      time: _getGameTime() || '',
      currencyId: curId,
      amount: type === 'in' ? amtV : -amtV,
      category: mask.querySelector('#led-m-category').value.trim() || (type === 'in' ? '收入' : '支出'),
      note: mask.querySelector('#led-m-note').value.trim(),
      platform: '',
      counterparty: '',
      source: 'manual',
      editable: true,
    });
    pd2.ledger = pd2.ledger.slice(-300);
    await _savePhoneData();
    document.body.removeChild(mask);
    _renderLedger(pd2);
  };
  document.body.appendChild(mask);
}


// 订单详情弹窗
function _showOrderDetail(name, price, desc, platform) {
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;padding:20px';
  mask.onclick = e => { if (e.target === mask) mask.remove(); };
  mask.innerHTML = `<div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:20px;max-width:320px;width:100%;color:var(--text)">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='var(--accent)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z'/><line x1='3' x2='21' y1='6' y2='6'/><path d='M16 10a4 4 0 0 1-8 0'/></svg>
      <div style="font-size:16px;font-weight:600">${Utils.escapeHtml(name || '订单')}</div>
    </div>
    ${price ? `<div style="font-size:22px;font-weight:700;color:var(--accent);margin-bottom:12px">¥${Utils.escapeHtml(price)}</div>` : ''}
    ${desc ? `<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;word-break:break-word">${Utils.escapeHtml(desc)}</div>` : ''}
    ${platform ? `<div style="display:inline-block;font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--border);color:var(--text-secondary)">${Utils.escapeHtml(platform)}</div>` : ''}
    <div style="margin-top:16px;text-align:right">
      <button onclick="this.closest('[style*=fixed]').remove()" style="padding:8px 20px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-size:13px;cursor:pointer">关闭</button>
    </div>
  </div>`;
  document.body.appendChild(mask);
}

// 转账收取：对方转来的钱，用户点击后选择绑定的货币属性收入
async function _claimTransfer(contactId, msgId) {
  const pd = await _getPhoneData();
  if (!pd) return;
  const thread = pd.chatThreads?.[contactId];
  if (!thread) return;
  const msg = thread.find(m => m.id === msgId);
  if (!msg || msg.transferClaimed) { UI.showToast('已收取', 1200); return; }

  // 获取钱包绑定的货币列表
  pd.walletCurrencies = pd.walletCurrencies || [];
  let globalAttrs = [];
  let statusAttrs = {};
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const gp = conv?.convGameplay || null;
    globalAttrs = (gp?.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim());
    const sb = Conversations.getStatusBar() || {};
    statusAttrs = sb?.customAttrs?.global || {};
  } catch(_) {}

  const walletInfos = pd.walletCurrencies
    .map(id => { const def = globalAttrs.find(a => a.id === id); return def ? { id, name: def.name, balance: statusAttrs[id] ?? def.initial ?? 0 } : null; })
    .filter(Boolean);

  if (!walletInfos.length) {
    UI.showToast('请先在钱包中绑定货币', 2000);
    return;
  }

  // 只有一种货币直接收取，多种弹选择
  if (walletInfos.length === 1) {
    await _doClaimTransfer(contactId, msgId, walletInfos[0].id, msg.transferAmount);
    return;
  }

  // 弹底部货币选择面板
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center';
  mask.onclick = e => { if (e.target === mask) mask.remove(); };
  const listHtml = walletInfos.map(w => `
    <div data-id="${Utils.escapeHtml(w.id)}" style="padding:12px 16px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--bg-tertiary);display:flex;align-items:center;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;color:var(--text);font-weight:600">${Utils.escapeHtml(w.name)}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">当前余额：${Utils.escapeHtml(String(w.balance))}</div>
      </div>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
    </div>`).join('');
  mask.innerHTML = `<div style="background:var(--bg);border-radius:16px 16px 0 0;padding:20px 16px;max-height:60vh;overflow-y:auto;width:100%;max-width:400px">
    <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:12px">收取 ¥${msg.transferAmount} 到</div>
    <div style="display:flex;flex-direction:column;gap:8px">${listHtml}</div>
  </div>`;
  mask.querySelector('div').addEventListener('click', async (e) => {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    const attrId = item.dataset.id;
    mask.remove();
    await _doClaimTransfer(contactId, msgId, attrId, msg.transferAmount);
  });
  document.body.appendChild(mask);
}

// 实际执行收取：加余额 + 标记 + 重渲染
async function _doClaimTransfer(contactId, msgId, attrId, amount) {
  try {
    const sb = Conversations.getStatusBar() || {};
    if (!sb.customAttrs) sb.customAttrs = {};
    if (!sb.customAttrs.global) sb.customAttrs.global = {};
    const cur = parseFloat(sb.customAttrs.global[attrId] || 0);
    sb.customAttrs.global[attrId] = cur + (parseFloat(amount) || 0);
    await Conversations.setStatusBar(sb);
    if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(sb);
  } catch(e) {
    UI.showToast('收取失败：' + (e.message || ''), 2000);
    return;
  }
  // 标记已收取
  const pd = await _getPhoneData();
  const thread = pd?.chatThreads?.[contactId];
  if (thread) {
    const msg = thread.find(m => m.id === msgId);
    if (msg) msg.transferClaimed = true;
  }
  // 记账：收款（仅绑定货币）
  try {
    const infos = _getWalletCurrencyInfos();
    if (pd && infos.some(c => c.id === attrId)) {
      const _ctName = (pd.chatContacts || []).find(c => c.id === contactId)?.name || contactId;
      pd.ledger = pd.ledger || [];
      pd.ledger.push({
        id: 'le_' + Utils.uuid().slice(0, 8),
        time: _getGameTime() || '',
        currencyId: attrId,
        amount: Math.abs(parseFloat(amount) || 0),
        category: '收款',
        note: '',
        platform: '',
        counterparty: _ctName,
        source: 'transfer_in',
        editable: true,
      });
      pd.ledger = pd.ledger.slice(-300);
    }
  } catch(_) {}
  await _savePhoneData();
  UI.showToast('已收取', 1500);
  // 重渲染气泡
  try { _renderChatThread(pd, contactId); } catch(_) {}
}

// ===== 反向交易：char 卖货给 user，user 点击购买 =====
// 点击「购买」：校验→选货币付款→扣钱→记账→生成订单→标记已购
async function _sellBuy(contactId, msgId) {
  const pd = await _getPhoneData();
  if (!pd) return;
  const thread = pd.chatThreads?.[contactId];
  if (!thread) return;
  const msg = thread.find(m => m.id === msgId);
  if (!msg || msg.type !== 'sell_offer') return;
  if (msg.sellBought) { UI.showToast('已购买', 1200); return; }

  const price = parseFloat(msg.sellPrice) || 0;
  const infos = _getWalletCurrencyInfos();
  if (!infos.length) { UI.showToast('请先在钱包绑定货币', 2000); return; }

  // 选货币（单种直接用，多种弹面板）
  let chosen = null;
  if (infos.length === 1) {
    chosen = infos[0];
  } else {
    chosen = await new Promise(resolve => {
      const mask = document.createElement('div');
      mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center';
      mask.onclick = e => { if (e.target === mask) { mask.remove(); resolve(null); } };
      const listHtml = infos.map(w => `
        <div data-id="${Utils.escapeHtml(w.id)}" style="padding:12px 16px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--bg-tertiary);display:flex;align-items:center;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;color:var(--text);font-weight:600">${Utils.escapeHtml(w.name)}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">当前余额：${Utils.escapeHtml(String(w.balance))}</div>
          </div>
        </div>`).join('');
      mask.innerHTML = `<div style="background:var(--bg);border-radius:16px 16px 0 0;padding:20px 16px;max-height:60vh;overflow-y:auto;width:100%;max-width:400px">
        <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px">购买「${Utils.escapeHtml(msg.sellName || '商品')}」</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">需支付 ${price}，选择支付货币</div>
        <div style="display:flex;flex-direction:column;gap:8px">${listHtml}</div>
      </div>`;
      mask.querySelector('div').addEventListener('click', (e) => {
        const item = e.target.closest('[data-id]');
        if (!item) return;
        const id = item.dataset.id;
        mask.remove();
        resolve(infos.find(w => w.id === id) || null);
      });
      document.body.appendChild(mask);
    });
  }
  if (!chosen) return;

  // 余额校验
  if ((chosen.balance || 0) < price) {
    UI.showToast(`${chosen.name}余额不足（需 ${price}，当前 ${chosen.balance}）`, 2500);
    return;
  }

  // 扣款
  try {
    const sb = Conversations.getStatusBar() || {};
    if (!sb.customAttrs) sb.customAttrs = {};
    if (!sb.customAttrs.global) sb.customAttrs.global = {};
    const cur = parseFloat(sb.customAttrs.global[chosen.id] || 0);
    sb.customAttrs.global[chosen.id] = cur - price;
    await Conversations.setStatusBar(sb);
    if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(sb);
  } catch(e) {
    console.warn('[出售] 扣款失败', e);
    UI.showToast('扣款失败', 1800);
    return;
  }

  // 记账（支出）
  const sellerName = (msg.sellSeller || '').trim() || (pd.chatContacts || []).find(c => c.id === contactId)?.name || '对方';
  await _addLedgerEntry({
    currencyId: chosen.id,
    amount: -Math.abs(price),
    category: '购物',
    note: `向${sellerName}购买「${msg.sellName || '商品'}」`,
    platform: '聊天交易',
    counterparty: sellerName,
    source: 'sell_buy',
  });

  // 生成订单
  const orderTime = _getGameTime() || new Date().toLocaleString();
  const delivery = msg.sellDelivery || 'instant';
  const order = {
    id: 'order_' + Utils.uuid().slice(0, 8),
    name: msg.sellName || '商品',
    shop: sellerName,
    desc: msg.sellDesc || '',
    price: price,
    target: '自己',
    time: orderTime,
    orderGameTime: orderTime,
    items: [{ name: (msg.sellName || '商品').trim(), count: 1, effect: msg.sellDesc || '' }],
    sellBuy: true,
    sender: sellerName,
  };

  if (delivery === 'instant') {
    // 即刻交付：订单立即完成
    order.status = 'delivered';
    order.deliveryMinutes = 0;
    order.feiniaoReceive = true; // 视作收进来的，可在聚合页收入物品栏
    pd.shopOrders = pd.shopOrders || [];
    pd.shopOrders.push(order);
    pd.shopOrders = pd.shopOrders.slice(-30);
  } else {
    const minutes = (msg.sellEtaUnit === 'day') ? (msg.sellEta || 1) * 1440 : (msg.sellEta || 30);
    order.status = 'delivering';
    order.deliveryMinutes = minutes;
    order.feiniaoReceive = true;
    order.shipMode = delivery;
    const field = delivery === 'errand' ? 'takeoutOrders' : 'shopOrders';
    pd[field] = pd[field] || [];
    pd[field].push(order);
    pd[field] = pd[field].slice(-30);
  }

  // 标记已购
  msg.sellBought = true;
  await _savePhoneData();
  UI.showToast(`已购买，支付 ${price} ${chosen.name}`, 2200);
  try { _renderChatThread(pd, contactId); } catch(_) {}
}

// 出售卡片详情弹窗：展示商品信息，确认后才购买
async function _showSellDetail(contactId, msgId) {
  const pd = await _getPhoneData();
  if (!pd) return;
  const thread = pd.chatThreads?.[contactId];
  if (!thread) return;
  const msg = thread.find(m => m.id === msgId);
  if (!msg || msg.type !== 'sell_offer') return;

  const dLabel = msg.sellDelivery === 'express' ? '快递' : msg.sellDelivery === 'errand' ? '跑腿' : '即刻交付';
  const etaLabel = (msg.sellDelivery !== 'instant' && msg.sellEta) ? `，预计 ${msg.sellEta}${msg.sellEtaUnit === 'day' ? '天' : '分钟'}送达` : '';
  const sellerName = (msg.sellSeller || '').trim() || (pd.chatContacts || []).find(c => c.id === contactId)?.name || '对方';
  const bought = !!msg.sellBought;

  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;padding:20px';
  mask.onclick = e => { if (e.target === mask) mask.remove(); };
  mask.innerHTML = `<div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:20px;max-width:320px;width:100%;color:var(--text)">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='var(--accent)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 9l1-5h16l1 5'/><path d='M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9'/><path d='M9 13h6'/></svg>
      <div style="font-size:16px;font-weight:600">${Utils.escapeHtml(msg.sellName || '商品')}</div>
    </div>
    <div style="font-size:22px;font-weight:700;color:var(--accent);margin-bottom:12px">${Utils.escapeHtml(String(msg.sellPrice || 0))}</div>
    ${msg.sellDesc ? `<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;word-break:break-word">${Utils.escapeHtml(msg.sellDesc)}</div>` : ''}
    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">出售方：${Utils.escapeHtml(sellerName)}</div>
    <div style="display:inline-block;font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--border);color:var(--text-secondary)">${dLabel}${etaLabel}</div>
    <div style="margin-top:18px;display:flex;gap:10px;justify-content:flex-end">
      <button onclick="this.closest('[style*=fixed]').remove()" style="padding:8px 18px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:13px;cursor:pointer">关闭</button>
      ${bought
        ? `<button disabled style="padding:8px 18px;border-radius:8px;border:none;background:var(--bg-tertiary);color:var(--text-secondary);font-size:13px">已购买</button>`
        : `<button id="sell-detail-buy" style="padding:8px 20px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-size:13px;font-weight:600;cursor:pointer">确认购买</button>`}
    </div>
  </div>`;
  const buyBtn = mask.querySelector('#sell-detail-buy');
  if (buyBtn) buyBtn.onclick = async () => { mask.remove(); await _sellBuy(contactId, msgId); };
  document.body.appendChild(mask);
}
function _refreshAnniversaryCard() {
  const el = document.getElementById('phone-anniversary-card');
  if (!el) return;
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const pd = conv?.phoneData;
    const anni = pd?.anniversary;
    if (!anni || !anni.day || !anni.month) {
      // 没设置纪念日：显示占位
    el.style.backgroundImage = '';
        el.innerHTML = `<div class="phone-anniversary-card-text" style="color:var(--text);font-size:12px;opacity:0.55">点击设置<br>纪念日</div>`;
        return;
    }
    // 有背景图
    if (anni.image) {
      el.style.backgroundImage = `url("${anni.image}")`;
    } else {
      el.style.backgroundImage = '';
    }
    // 计算天数
    const rules = _getCalRulesCached();
    const sb = Conversations.getStatusBar() || {};
    const timeStr = sb.time || '';
    const parsed = (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime)
      ? Calendar.parseAbsoluteTime(timeStr) : null;
    let diffDays = 0;
    if (parsed && rules && typeof Calendar !== 'undefined') {
      const anniTime = { year: anni.year || parsed.year, month: anni.month, day: anni.day, hour: 0, minute: 0 };
      const curEpoch = Calendar._daysSinceEpoch(parsed, rules);
      const anniEpoch = Calendar._daysSinceEpoch(anniTime, rules);
      diffDays = curEpoch - anniEpoch;
    } else if (parsed) {
      const cur = new Date(parsed.year, parsed.month - 1, parsed.day);
      const anniD = new Date(anni.year || parsed.year, anni.month - 1, anni.day);
      diffDays = Math.round((cur - anniD) / 86400000);
    }
    const dayText = diffDays >= 0 ? `第 ${diffDays + 1} 天` : `还有 ${Math.abs(diffDays)} 天`;
    const titleText = anni.title ? Utils.escapeHtml(anni.title) : '';
    el.innerHTML = `<div class="phone-anniversary-card-text">${titleText ? `<div class="phone-anniversary-card-title">${titleText}</div>` : ''}${dayText}</div>`;
  } catch(_) {
    el.innerHTML = `<div class="phone-anniversary-card-text" style="color:var(--text);font-size:12px;opacity:0.55">点击设置<br>纪念日</div>`;
  }
}
// ===== 配送小组件（小组件页）=====
// 拿钱包绑定的货币信息 [{id, name, balance}]
function _getWalletCurrencyInfos() {
  let globalAttrs = [], statusAttrs = {}, walletCurrencies = [];
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const gp = conv?.convGameplay || null;
    globalAttrs = (gp?.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim());
    const sb = Conversations.getStatusBar() || {};
    statusAttrs = sb?.customAttrs?.global || {};
    walletCurrencies = (conv?.phoneData?.walletCurrencies || []).filter(id => globalAttrs.some(a => a.id === id));
  } catch(_) {}
  return walletCurrencies.map(id => {
    const def = globalAttrs.find(a => a.id === id);
    return { id, name: def?.name || id, balance: statusAttrs[id] ?? def?.initial ?? 0 };
  });
}

// 计算某货币的本月结余（游戏历法当前月：收入-支出）
function _ledgerMonthBalance(currencyId) {
  let pd = null;
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    pd = conv?.phoneData;
  } catch(_) {}
  const ledger = pd?.ledger || [];
  const cur = _getGameTime();
  const curParsed = (cur && typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime)
    ? Calendar.parseAbsoluteTime(cur) : null;
  if (!curParsed) return null;
  let sum = 0, has = false;
  for (const e of ledger) {
    if (e.currencyId !== currencyId) continue;
    const p = (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) ? Calendar.parseAbsoluteTime(e.time) : null;
    if (!p) continue;
    if (p.year === curParsed.year && p.month === curParsed.month) { sum += (+e.amount || 0); has = true; }
  }
  return has ? sum : 0;
}

// 追加一条账目（只记钱包绑定货币内的变动）
async function _addLedgerEntry(entry) {
  try {
    const infos = _getWalletCurrencyInfos();
    if (!infos.some(c => c.id === entry.currencyId)) return; // 非绑定货币不记
    const pd = await _getPhoneData();
    if (!pd) return;
    pd.ledger = pd.ledger || [];
    pd.ledger.push({
      id: 'le_' + Utils.uuid().slice(0, 8),
      time: entry.time || _getGameTime() || '',
      currencyId: entry.currencyId,
      amount: +entry.amount || 0,
      category: entry.category || '',
      note: entry.note || '',
      platform: entry.platform || '',
      counterparty: entry.counterparty || '',
      source: entry.source || 'manual',
      editable: true,
    });
    pd.ledger = pd.ledger.slice(-300); // 最多保留300条
    await _savePhoneData();
  } catch(e) { console.warn('[Ledger] 记账失败', e); }
}


// 找出最快到达的、仍在配送中的订单
function _nearestDelivering(orders) {
  if (!Array.isArray(orders)) return null;
  let best = null, bestRem = Infinity;
  for (const o of orders) {
    if (!o || o.status !== 'delivering' || !o.deliveryMinutes) continue;
    const rem = _getDeliveryRemaining(o);
    if (rem === null || rem <= 0) continue;
    if (rem < bestRem) { bestRem = rem; best = o; }
  }
  return best;
}

// 把剩余分钟拆成主数字 + 单位（用于快递卡片大数字展示）
function _deliveryNumUnit(minutes) {
  if (minutes >= 1440) return { num: Math.max(1, Math.floor(minutes / 1440)), unit: '天' };
  if (minutes >= 60) return { num: Math.floor(minutes / 60), unit: '小时' };
  return { num: Math.max(1, Math.ceil(minutes)), unit: '分钟' };
}

// 快递方卡背景图：通过 DOM 操作设置（避免 innerHTML 里塞 base64）
function _applyExpressBg(bg) {
  const card = document.getElementById('phone-dw-express-card');
  if (!card) return;
  if (bg) {
    card.style.setProperty('background', `url("${bg}") center/cover no-repeat`, 'important');
    card.classList.add('has-bg');
  } else {
    card.style.removeProperty('background');
    card.classList.remove('has-bg');
  }
}

function _refreshDeliveryWidget() {
  const el = document.getElementById('phone-delivery-widget');
  if (!el) return;
  let pd = null;
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    pd = conv?.phoneData;
  } catch(_) {}

  // 找最近在途的快递和外卖订单
  const shopOrder = _nearestDelivering(pd?.shopOrders);
  const tkOrder = _nearestDelivering(pd?.takeoutOrders);

  // 订单来源描述（文字，不用标签）
  function _srcLabel(o, field) {
    if (!o) return '';
    if (o.sellBuy) return `聊天交易·${Utils.escapeHtml(o.shop || '购入')}`;
    if (o.feiniaoReceive) return `飞鸟·来自${Utils.escapeHtml(o.sender || '某人')}`;
    if (o.feiniaoShip) return `飞鸟·寄给${Utils.escapeHtml(o.target || '某人')}`;
    if (o.youyuSell) return `游鱼·卖给${Utils.escapeHtml(o.buyer || '某人')}`;
    const tgt = (o.target || '自己').trim();
    const platform = field === 'takeoutOrders' ? (_shopMeta?.takeout?.name || '饿了咪') : (_shopMeta?.shop?.name || '桃宝');
    return `${platform}·${tgt === '自己' || !tgt ? '买给自己' : '买给' + Utils.escapeHtml(tgt)}`;
  }

  // 快递方卡（常驻，可设背景图，点击换图）
  const dwBg = pd?.dwExpressBg || '';
  let expressInner = '';
  if (shopOrder) {
    const nu = _deliveryNumUnit(_getDeliveryRemaining(shopOrder));
    const src = _srcLabel(shopOrder, 'shopOrders');
    expressInner = `
      <div class="phone-dw-express-name">${Utils.escapeHtml(shopOrder.name || '快递')}</div>
      <div class="phone-dw-express-num">${nu.num}<span class="phone-dw-express-unit">${nu.unit}</span></div>
      <div class="phone-dw-express-foot">${src} · 预计送达</div>`;
  } else {
    expressInner = `
      <div class="phone-dw-express-name">快递</div>
      <div class="phone-dw-express-empty">暂无在途</div>
      <div class="phone-dw-express-foot">点击更换背景</div>`;
  }
  const expressHtml = `
    <div class="phone-dw-express" id="phone-dw-express-card" onclick="Phone._dwPickExpressBg()">
      ${expressInner}
    </div>`;

  // 外卖长条进度条（常驻，聚合页入口）
  let takeoutHtml = '';
  if (tkOrder) {
    const rem = _getDeliveryRemaining(tkOrder);
    const total = tkOrder.deliveryMinutes || 1;
    const pct = Math.max(4, Math.min(100, Math.round((total - rem) / total * 100)));
    const src = _srcLabel(tkOrder, 'takeoutOrders');
    takeoutHtml = `
      <div class="phone-dw-takeout" onclick="Phone._openDeliveryOrders('takeout')">
        <div class="phone-dw-bar-head">
          <span class="phone-dw-bar-name">${Utils.escapeHtml(tkOrder.name || '外卖')}</span>
          <span class="phone-dw-bar-rem">${_formatDeliveryRemaining(rem)}后到</span>
        </div>
        <div class="phone-dw-bar-track"><div class="phone-dw-bar-fill" style="width:${pct}%"></div></div>
        <div class="phone-dw-bar-foot">${src} · 配送中</div>
      </div>`;
  } else {
    // 无在途外卖：空态入口（进度条灰底），点击进聚合页
    takeoutHtml = `
      <div class="phone-dw-takeout" onclick="Phone._openDeliveryOrders('takeout')">
        <div class="phone-dw-bar-head">
          <span class="phone-dw-bar-name">全部订单</span>
          <span class="phone-dw-bar-rem">暂无配送中</span>
        </div>
        <div class="phone-dw-bar-track"></div>
        <div class="phone-dw-bar-foot">点击查看全部订单</div>
      </div>`;
  }

  // 右上：两张横条小卡（主货币余额 + 本月结余）
  const curInfos = _getWalletCurrencyInfos();
  const mainCur = curInfos[0] || null;
  let balanceCardHtml, surplusCardHtml;
  if (mainCur) {
    balanceCardHtml = `
      <div class="phone-dw-mini-label">${Utils.escapeHtml(mainCur.name)}余额</div>
      <div class="phone-dw-mini-num">${Utils.escapeHtml(String(mainCur.balance))}</div>`;
    const ms = _ledgerMonthBalance(mainCur.id);
    const msText = ms === null ? '—' : (ms >= 0 ? '+' + ms : String(ms));
    surplusCardHtml = `
      <div class="phone-dw-mini-label">本月结余</div>
      <div class="phone-dw-mini-num ${ms < 0 ? 'phone-dw-neg' : ''}">${Utils.escapeHtml(msText)}</div>`;
  } else {
    balanceCardHtml = `
      <div class="phone-dw-mini-label">钱包</div>
      <div class="phone-dw-mini-empty">未绑定货币</div>`;
    surplusCardHtml = `
      <div class="phone-dw-mini-label">记账</div>
      <div class="phone-dw-mini-empty">查看账单</div>`;
  }

  // 快递方卡常驻（装饰），外卖进度条常驻（聚合页入口）
  el.innerHTML = `
    <div class="phone-dw-row">
      ${expressHtml}
      <div class="phone-dw-mini-col">
        <div class="phone-dw-mini" onclick="Phone.openApp('wallet')">${balanceCardHtml}</div>
        <div class="phone-dw-mini" onclick="Phone.openApp('ledger')">${surplusCardHtml}</div>
      </div>
    </div>
    ${takeoutHtml}`;
  _applyExpressBg(dwBg);
}

// 从小组件点击：进入「全部订单」聚合页
function _openDeliveryOrders(kind) {
  _deliveriesTab = 'all';
  openApp('deliveries');
}

// 快递方卡：点击弹出底部 sheet（上传/清除/取消）
function _dwPickExpressBg() {
  const overlay = document.createElement('div');
  overlay.id = 'dw-bg-sheet';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10010;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div style="width:100%;max-width:420px;background:var(--bg);border-radius:16px 16px 0 0;padding:8px 12px 16px;animation:sheetSlideUp 0.2s ease">
      <div style="text-align:center;font-size:13px;color:var(--text-secondary);padding:10px 0 6px">卡片背景</div>
      <button onclick="Phone._dwDoPickImage()" style="width:100%;display:flex;align-items:center;gap:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-top:8px;font-size:14px;color:var(--text);cursor:pointer;text-align:left">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg>
        <div><div style="font-weight:600">上传图片</div><div style="font-size:12px;color:var(--text-secondary);margin-top:2px">从相册选择背景图</div></div>
      </button>
      <button onclick="Phone._dwDoClearBg()" style="width:100%;display:flex;align-items:center;gap:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-top:8px;font-size:14px;color:var(--text);cursor:pointer;text-align:left">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
        <div><div style="font-weight:600">清除图片</div><div style="font-size:12px;color:var(--text-secondary);margin-top:2px">恢复默认背景</div></div>
      </button>
      <button onclick="document.getElementById('dw-bg-sheet')?.remove()" style="width:100%;background:transparent;border:none;border-radius:12px;padding:14px;margin-top:8px;font-size:14px;color:var(--text-secondary);cursor:pointer">取消</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

// 上传背景图
function _dwDoPickImage() {
  document.getElementById('dw-bg-sheet')?.remove();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const pd = await _getPhoneData();
      if (!pd) return;
      pd.dwExpressBg = reader.result;
      await _savePhoneData();
      _refreshDeliveryWidget();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

// 清除背景图
async function _dwDoClearBg() {
  document.getElementById('dw-bg-sheet')?.remove();
  const pd = await _getPhoneData();
  if (!pd) return;
  pd.dwExpressBg = '';
  await _savePhoneData();
  _refreshDeliveryWidget();
}

// ===== 音乐播放器卡片（第二页常驻小窗） =====
let _musicBound = false;

function _musicSvg(name) {
  const M = {
    heart: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 21s-7.5-4.9-10-9.2C.6 9 1.6 5.5 4.8 5.5c1.9 0 3.1 1.2 3.7 2.2.6-1 1.8-2.2 3.7-2.2 3.2 0 4.2 3.5 2.8 6.3C19.5 16.1 12 21 12 21z"/></svg>',
    heartOutline: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20s-6.8-4.4-9-8.2C1.7 9.2 2.6 6.5 5.2 6.5c1.7 0 2.8 1.1 3.3 2 .5-.9 1.6-2 3.3-2 2.6 0 3.5 2.7 2.2 5.3C18.8 15.6 12 20 12 20z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14l-11-7z"/></svg>',
    nextTrack: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M16 5h2v14h-2zM4 5l11 7-11 7z"/></svg>',
    playBig: '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>',
    pauseBig: '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M7 4h4v16H7zM13 4h4v16h-4z"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 6h12v2H3zM3 11h12v2H3zM3 16h8v2H3zM17 7l5 4-5 4z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    repeatList: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zM17 17H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
    repeatOne: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zM17 17H7v-3l-4 4 4 4v-3h12v-6h-2z"/><text x="9.5" y="15" font-size="8" fill="currentColor">1</text></svg>',
    shuffle: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M17 3l4 4-4 4V8h-2.5l-2 2.5-1.3-1.6L13 7h4V3zM3 7h3.5l8 9.5H17v-3l4 4-4 4v-3h-4l-8-9.5H3z"/></svg>'
  };
  return M[name] || '';
}

// 渲染卡片内部（被首页渲染调用）
function _renderMusicCardInner() {
  const t = (typeof Music !== 'undefined') ? Music.getCurrentTrack() : null;
  const tracks = (typeof Music !== 'undefined') ? Music.getTracks() : [];
  const playing = (typeof Music !== 'undefined') ? Music.isPlaying() : false;
  const prog = (typeof Music !== 'undefined') ? Music.getProgress() : { ratio: 0, curText: '0:00', durText: '0:00' };

  if (!tracks.length) {
    return `
    <div class="phone-music-top" onclick="Phone._openMusicLibrary()">
      <div class="phone-music-cover"><div class="phone-music-cover-ph">${_musicSvg('list')}</div></div>
      <div class="phone-music-meta">
        <div class="phone-music-title">未添加音乐</div>
        <div class="phone-music-artist">点击添加</div>
      </div>
    </div>
    <div class="phone-music-progress">
      <div class="phone-music-bar">
        <div class="phone-music-bar-fill" style="width:0%"></div>
        <div class="phone-music-bar-dot" style="left:0%"></div>
      </div>
    </div>
    <div class="phone-music-times">
      <span>0:00</span>
      <span>0:00</span>
    </div>
    <div class="phone-music-controls phone-music-controls-disabled">
      <button class="phone-music-ctrl" onclick="Phone._openMusicLibrary()">${_musicSvg('prev')}</button>
      <button class="phone-music-ctrl phone-music-play" onclick="Phone._openMusicLibrary()">${_musicSvg('playBig')}</button>
      <button class="phone-music-ctrl" onclick="Phone._openMusicLibrary()">${_musicSvg('nextTrack')}</button>
    </div>
  `;
  }

  const title = t ? Utils.escapeHtml(t.title || '未命名') : '未播放';
  const artist = t ? Utils.escapeHtml(t.artist || '未知歌手') : '';
  const cover = t && t.coverUrl
    ? `<img src="${Utils.escapeHtml(t.coverUrl)}" alt="" onerror="this.style.display='none'">`
    : `<div class="phone-music-cover-ph">${_musicSvg('list')}</div>`;
  const ratioPct = Math.round((prog.ratio || 0) * 100);

  return `
    <div class="phone-music-top">
      <div class="phone-music-cover">${cover}</div>
      <div class="phone-music-meta" onclick="Phone._openMusicLibrary()">
        <div class="phone-music-title">${title}</div>
        <div class="phone-music-artist">${artist}</div>
      </div>
    </div>
    <div class="phone-music-progress" id="phone-music-progress">
      <div class="phone-music-bar" id="phone-music-bar">
        <div class="phone-music-bar-fill" id="phone-music-bar-fill" style="width:${ratioPct}%"></div>
        <div class="phone-music-bar-dot" id="phone-music-bar-dot" style="left:${ratioPct}%"></div>
      </div>
    </div>
    <div class="phone-music-times">
      <span id="phone-music-cur">${prog.curText || '0:00'}</span>
      <span id="phone-music-dur">${prog.durText || '0:00'}</span>
    </div>
    <div class="phone-music-controls">
      <button class="phone-music-ctrl" onclick="Music.prev()">${_musicSvg('prev')}</button>
      <button class="phone-music-ctrl phone-music-play" onclick="Music.toggle()">${_musicSvg(playing ? 'pauseBig' : 'playBig')}</button>
      <button class="phone-music-ctrl" onclick="Music.next()">${_musicSvg('nextTrack')}</button>
    </div>
  `;
}

function _musicRepeatIcon() {
  const m = (typeof Music !== 'undefined') ? Music.getRepeatMode() : 'list';
  return m === 'one' ? 'repeatOne' : (m === 'shuffle' ? 'shuffle' : 'repeatList');
}

// 刷新整张卡片（结构变化时）
function _refreshMusicCard() {
  const el = document.getElementById('phone-music-card');
  if (!el) return;
  el.innerHTML = _renderMusicCardInner();
  _bindMusicProgressDrag();
}

// 轻量刷新：只更新播放按钮图标（不重建DOM，避免吞按钮事件）
// 切歌时需要完整重建（歌名封面变了）
let _lastCardTrackId = null;
function _refreshMusicCardState() {
  const el = document.getElementById('phone-music-card');
  if (!el) return;
  const t = (typeof Music !== 'undefined') ? Music.getCurrentTrack() : null;
  const curId = t ? t.id : null;
  if (curId !== _lastCardTrackId) {
    _lastCardTrackId = curId;
    _refreshMusicCard();
    return;
  }
  const playing = (typeof Music !== 'undefined') ? Music.isPlaying() : false;
  const playBtn = el.querySelector('.phone-music-play');
  if (playBtn) {
    playBtn.innerHTML = _musicSvg(playing ? 'pauseBig' : 'playBig');
  }

}

// 仅更新进度（高频，不重建 DOM）
function _updateMusicProgress() {
  const fill = document.getElementById('phone-music-bar-fill');
  const dot = document.getElementById('phone-music-bar-dot');
  const cur = document.getElementById('phone-music-cur');
  const dur = document.getElementById('phone-music-dur');
  if (!fill) return;
  const p = Music.getProgress();
  const pct = Math.round((p.ratio || 0) * 100);
  fill.style.width = pct + '%';
  if (dot) dot.style.left = pct + '%';
  if (cur) cur.textContent = p.curText || '0:00';
  if (dur) dur.textContent = p.durText || '0:00';
}

// 更新歌词单行（卡片里只显示当前行）
function _updateMusicLrc() {
  const el = document.getElementById('phone-music-lrc');
  if (!el) return;
  const st = Music.getLrcState();
  if (!st.parsed) { el.textContent = ''; return; }
  if (st.parsed.synced) {
    const line = st.lineIdx >= 0 ? st.parsed.lines[st.lineIdx] : null;
    el.textContent = line ? line.text : '';
  } else {
    el.textContent = st.parsed.lines[0] ? st.parsed.lines[0].text : '';
  }
}

// 进度条拖动/点击 seek
function _bindMusicProgressDrag() {
  const bar = document.getElementById('phone-music-bar');
  if (!bar || bar._seekBound) return;
  bar._seekBound = true;
  const seekTo = (clientX) => {
    const rect = bar.getBoundingClientRect();
    const ratio = (clientX - rect.left) / (rect.width || 1);
    Music.seek(ratio);
  };
  bar.addEventListener('click', (e) => seekTo(e.clientX));
  let dragging = false;
  bar.addEventListener('touchstart', () => { dragging = true; }, { passive: true });
  bar.addEventListener('touchmove', (e) => { if (dragging && e.touches[0]) seekTo(e.touches[0].clientX); }, { passive: true });
  bar.addEventListener('touchend', () => { dragging = false; });
}

// 订阅 Music 事件（只绑一次）
function _bindMusicListeners() {
  if (_musicBound || typeof Music === 'undefined') return;
  _musicBound = true;
  Music.on('state', () => { try { _refreshMusicCardState(); _refreshMusicDetail(); _refreshListenTogetherState(); _handleMusicStateLog(); _ltSyncOnState(); } catch (_) {} });
  Music.on('progress', () => { try { _updateMusicProgress(); } catch (_) {} });
  Music.on('lrc', () => { try { _updateDetailLrc(); } catch (_) {} });
}

async function _musicLike() {
  const t = Music.getCurrentTrack();
  if (!t) return;
  await Music.updateTrack(t.id, { liked: !t.liked });
  _refreshMusicCard();
}

function _musicCycleRepeat() {
  Music.cycleRepeatMode();
  _refreshMusicCard();
}

// ===== 音乐库管理页 =====
async function _openMusicLibrary() {
  await Music._ensureLoaded();
  // 记住当前页面滚动位置，返回时恢复到第二页
  try {
    const pages = document.getElementById('phone-pages');
    if (pages) _lastPageScroll = pages.scrollLeft;
  } catch(_) {}
  // 和其他 app 一样：去掉首页模式、显示返回按钮、设标题
  document.querySelector('#phone-modal .phone-shell')?.classList.remove('phone-home-mode');
  document.getElementById('phone-back-btn')?.classList.remove('hidden');
  document.getElementById('phone-title').textContent = '音乐库';
  const render = () => _renderMusicLibrary();
  _pushNav(render);
  render();
}

let _musicLibTab = 'lib'; // 'lib' 音乐库 | 'mine' 我的（一起听历史）
function _renderMusicLibrary() {
  const body = document.getElementById('phone-body');
  if (!body) return;
  const tracks = Music.getTracks();
  const curId = Music.getCurrentId();
  const playing = Music.isPlaying();

  const earphoneBtn = _musicEarphoneOn
    ? `<button class="phone-mlib-earphone-btn on" onclick="Phone._toggleMusicEarphone()" title="摘下耳机">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
      </button>`
    : `<button class="phone-mlib-earphone-btn off" onclick="Phone._toggleMusicEarphone()" title="戴上耳机">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
      </button>`;

  const rows = tracks.length ? tracks.map(t => {
    const active = t.id === curId;
    const cover = t.coverUrl
      ? `<img src="${Utils.escapeHtml(t.coverUrl)}" alt="" onerror="this.style.display='none'">`
      : `<div class="phone-mlib-cover-ph">${_musicSvg('list')}</div>`;
    const badge = t.source === 'external' ? '链接' : '本地';
    const lrcMark = t.lrc ? '词' : '';
    const titleClass = active ? 'phone-mlib-title active' : 'phone-mlib-title';
    return `<div class="phone-mlib-row ${active ? 'active' : ''}" onclick="Phone._musicLibRowClick('${t.id}')">
      <div class="phone-mlib-cover">${cover}</div>
      <div class="phone-mlib-info">
        <div class="${titleClass}">${Utils.escapeHtml(t.title || '未命名')}${active && playing ? ' <span class="phone-mlib-playing">♪</span>' : ''}</div>
        <div class="phone-mlib-sub">${Utils.escapeHtml(t.artist || '未知歌手')} · <span class="phone-mlib-badge">${badge}</span>${lrcMark ? ` · ${lrcMark}` : ''}</div>
      </div>
    </div>`;
  }).join('') : `<div class="phone-mlib-empty">还没有歌曲，点右上角添加</div>`;

  // 音乐库页头部按钮（仅 lib tab 显示耳机+添加）
  const libHeaderBtns = _musicLibTab === 'lib' ? `${earphoneBtn}
        <button class="phone-mlib-add-btn" onclick="Phone._musicAddMenu()" title="添加歌曲">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        </button>` : '';
  const headerTitle = _musicLibTab === 'lib' ? '音乐库' : '我的';
  const headerSub = _musicLibTab === 'lib' ? `${tracks.length} 首 · 全局共享` : '一起听记录';

  const libPageHtml = `<div class="phone-mlib-list">${rows}</div>`;
  const minePageHtml = _renderListenHistory();

  body.innerHTML = `
    <div class="phone-app-page phone-mlib-page" style="display:flex;flex-direction:column;height:100%">
      <div class="phone-mlib-header">
        <div class="phone-mlib-h-text">
          <div class="phone-mlib-h-title">${headerTitle}</div>
          <div class="phone-mlib-h-sub">${headerSub}</div>
        </div>
        ${libHeaderBtns}
      </div>
      <div style="flex:1;min-height:0;overflow-y:auto">${_musicLibTab === 'lib' ? libPageHtml : minePageHtml}</div>
      <div class="phone-tabbar">
        <div class="phone-tab ${_musicLibTab === 'lib' ? 'active' : ''}" onclick="Phone._switchMusicLibTab('lib')">音乐库</div>
        <div class="phone-tab ${_musicLibTab === 'mine' ? 'active' : ''}" onclick="Phone._switchMusicLibTab('mine')">我的</div>
      </div>
    </div>`;
}

// 切换音乐库底部 tab
function _switchMusicLibTab(tab) {
  if (_musicLibTab === tab) return;
  _musicLibTab = tab;
  _renderMusicLibrary();
}

// 渲染「我的」一起听历史卡片列表
function _renderListenHistory() {
  const pd = _getPhoneDataSync();
  const hist = (pd && Array.isArray(pd.listenTogetherHistory)) ? pd.listenTogetherHistory : [];
  if (!hist.length) {
    return `<div class="phone-mlib-empty">还没有一起听记录</div>`;
  }
  // 倒序：最新在前
  const cards = hist.slice().reverse().map(h => {
    const modeLabel = h.mode === 'broadcast' ? '公放' : h.mode === 'earphone' ? '共享耳机' : h.mode === 'online' ? '线上' : '';
    const objName = h.mode === 'broadcast' ? '大家' : (h.targetName || '对方');
    const songCount = Array.isArray(h.playlist) ? h.playlist.length : 0;
    const firstSong = (Array.isArray(h.playlist) && h.playlist[0]) ? h.playlist[0].title : '';
    const msgCount = Array.isArray(h.messages) ? h.messages.length : 0;
    return `<div class="phone-lt-hist-card" onclick="Phone._openListenHistoryDetail('${h.id}')">
      <div class="phone-lt-hist-top">
        <span class="phone-lt-hist-obj">和 ${Utils.escapeHtml(objName)} 一起听</span>
        <span class="phone-lt-hist-mode">${modeLabel}</span>
      </div>
      <div class="phone-lt-hist-meta">${songCount} 首${firstSong ? ' · ' + Utils.escapeHtml(firstSong) : ''}${msgCount ? ' · ' + msgCount + ' 条留言' : ''}</div>
      <div class="phone-lt-hist-time">${Utils.escapeHtml(_formatPhoneTime(h.startTime || '') || '')}${h.duration ? ' · 共 ' + Utils.escapeHtml(h.duration) : ''}</div>
    </div>`;
  }).join('');
  return `<div class="phone-lt-hist-list">${cards}</div>`;
}

// 打开一起听历史详情
function _openListenHistoryDetail(histId) {
  const render = () => _renderListenHistoryDetail(histId);
  _pushNav(render);
  render();
}

function _renderListenHistoryDetail(histId) {
  const body = document.getElementById('phone-body');
  if (!body) return;
  const pd = _getPhoneDataSync();
  const hist = (pd && Array.isArray(pd.listenTogetherHistory)) ? pd.listenTogetherHistory : [];
  const h = hist.find(x => x.id === histId);
  document.getElementById('phone-back-btn')?.classList.remove('hidden');
  const titleEl = document.getElementById('phone-title');
  if (titleEl) titleEl.textContent = '一起听记录';
  if (!h) { body.innerHTML = `<div class="phone-mlib-empty">记录不存在</div>`; return; }

  const modeLabel = h.mode === 'broadcast' ? '公放' : h.mode === 'earphone' ? '共享耳机' : h.mode === 'online' ? '线上' : '';
  const objName = h.mode === 'broadcast' ? '大家' : (h.targetName || '对方');

  const msgs = (Array.isArray(h.messages) ? h.messages : []).map(m =>
    `<div class="lt-msg-card">
      <div style="display:flex;align-items:baseline;gap:6px">
        <span style="font-size:12px;font-weight:600;color:var(--text)">${Utils.escapeHtml(m.name || '对方')}</span>
        <span style="font-size:10px;color:var(--text-secondary)">${Utils.escapeHtml(_formatPhoneTime(m.at || '') || '')}</span>
      </div>
      <div style="font-size:13px;color:var(--text);line-height:1.5;margin-top:4px;word-break:break-word">${Utils.escapeHtml(m.content || '')}</div>
    </div>`).join('') || '<div style="color:var(--text-secondary);font-size:12px;padding:8px 0;text-align:center">没有留言</div>';

  const songCards = (Array.isArray(h.playlist) ? h.playlist : []).map((s, i) =>
    `<div class="lt-msg-card" style="display:flex;align-items:center;gap:12px">
      <span style="font-size:14px;font-weight:700;color:var(--accent);min-width:20px;text-align:center">${i + 1}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(s.title || '未命名')}</div>
        ${s.artist ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${Utils.escapeHtml(s.artist)}</div>` : ''}
      </div>
    </div>`).join('') || '<div style="color:var(--text-secondary);font-size:12px;padding:8px 0;text-align:center">无歌曲记录</div>';

  const songCount = Array.isArray(h.playlist) ? h.playlist.length : 0;
  const msgCount = Array.isArray(h.messages) ? h.messages.length : 0;

  body.innerHTML = `
    <div class="phone-app-page" style="padding:16px;overflow-y:auto;height:100%">
      <div class="lt-detail-hero">
        <div class="lt-detail-hero-icon">${(() => {
          let ava = '';
          try {
            const mask = (typeof Character !== 'undefined' && Character.get) ? Character.get() : null;
            ava = (typeof Character !== 'undefined' && Character.getAvatar ? Character.getAvatar() : '') || (mask && mask.avatar) || '';
          } catch(_) {}
          return ava
            ? `<img src="${ava}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
            : `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
        })()}</div>
        <div style="font-size:18px;font-weight:700;color:var(--text);margin-top:8px">和 ${Utils.escapeHtml(objName)} 一起听</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
          <span class="lt-detail-mode-pill">${modeLabel}</span>
          ${h.duration ? `<span style="font-size:12px;color:var(--text-secondary)">共 ${Utils.escapeHtml(h.duration)}</span>` : ''}
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;opacity:0.7">${Utils.escapeHtml(_formatPhoneTime(h.startTime || '') || '')}${h.endTime ? ' — ' + Utils.escapeHtml(_formatPhoneTime(h.endTime || '') || '') : ''}</div>
      </div>

      <div style="margin-top:16px">
        <div class="lt-detail-section-title">
          <span class="lt-detail-section-bar"></span>
          听过的歌（${songCount}）
        </div>
        ${songCards}
      </div>

      <div style="margin-top:16px">
        <div class="lt-detail-section-title">
          <span class="lt-detail-section-bar"></span>
          留言（${msgCount}）
        </div>
        ${msgs}
      </div>

      <div style="text-align:center;margin-top:20px;padding-bottom:16px">
        <button onclick="Phone._ltShareHistory('${h.id}')" style="background:none;border:1px solid var(--border);border-radius:20px;padding:8px 20px;color:var(--text-secondary);font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          分享截图
        </button>
      </div>
    </div>`;
}

// ===== 歌曲详情页 =====

// 一起听历史分享截图
async function _ltShareHistory(histId) {
  if (typeof html2canvas === 'undefined') { UI.showToast('截图库未加载', 2000); return; }
  const pd = _getPhoneDataSync();
  const hist = (pd && Array.isArray(pd.listenTogetherHistory)) ? pd.listenTogetherHistory : [];
  const h = hist.find(x => x.id === histId);
  if (!h) { UI.showToast('记录不存在', 1500); return; }
  UI.showToast('正在生成截图…', 2500);

  const modeLabel = h.mode === 'broadcast' ? '公放' : h.mode === 'earphone' ? '共享耳机' : h.mode === 'online' ? '线上' : '';
  const objName = h.mode === 'broadcast' ? '大家' : (h.targetName || '对方');
  const songCount = Array.isArray(h.playlist) ? h.playlist.length : 0;
  const msgCount = Array.isArray(h.messages) ? h.messages.length : 0;

  // 获取头像
  let ava = '';
  try {
    const mask = (typeof Character !== 'undefined' && Character.get) ? Character.get() : null;
    ava = (typeof Character !== 'undefined' && Character.getAvatar ? Character.getAvatar() : '') || (mask && mask.avatar) || '';
  } catch(_) {}
  const avatarHtml = ava
    ? `<img src="${ava}" style="width:48px;height:48px;object-fit:cover;border-radius:50%">`
    : `<div style="width:48px;height:48px;border-radius:50%;background:rgba(0,0,0,0.05);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#888" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`;

  // 歌曲列表（最多显示 6 首）
  const playlist = Array.isArray(h.playlist) ? h.playlist : [];
  const showSongs = playlist.slice(0, 6);
  const songsHtml = showSongs.map((s, i) =>
    `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(0,0,0,0.03);border-radius:12px;margin-bottom:6px">
      <span style="font-size:13px;font-weight:700;color:#e8863c;min-width:18px;text-align:center">${i + 1}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;color:#222;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(s.title || '未命名')}</div>
        ${s.artist ? `<div style="font-size:10px;color:#888;margin-top:1px">${Utils.escapeHtml(s.artist)}</div>` : ''}
      </div>
    </div>`
  ).join('') + (songCount > 6 ? `<div style="text-align:center;font-size:11px;color:#aaa;padding:4px 0">还有 ${songCount - 6} 首…</div>` : '');

  // 留言（最多显示 3 条）
  const messages = Array.isArray(h.messages) ? h.messages : [];
  const showMsgs = messages.slice(0, 3);
  const msgsHtml = showMsgs.length ? showMsgs.map(m =>
    `<div style="background:rgba(0,0,0,0.03);border-radius:12px;padding:8px 12px;margin-bottom:6px">
      <div style="display:flex;align-items:baseline;gap:5px">
        <span style="font-size:11px;font-weight:600;color:#222">${Utils.escapeHtml(m.name || '对方')}</span>
        <span style="font-size:9px;color:#aaa">${Utils.escapeHtml(_formatPhoneTime(m.at || '') || '')}</span>
      </div>
      <div style="font-size:11px;color:#444;line-height:1.5;margin-top:3px">${Utils.escapeHtml(m.content || '')}</div>
    </div>`
  ).join('') + (msgCount > 3 ? `<div style="text-align:center;font-size:11px;color:#aaa;padding:4px 0">还有 ${msgCount - 3} 条留言…</div>` : '') : '';

  // 构建截图容器
  const temp = document.createElement('div');
  temp.style.cssText = 'position:fixed;top:0;left:-10000px;width:380px;padding:24px;background:#fff;border-radius:20px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  temp.innerHTML = `
    <div style="text-align:center;margin-bottom:16px">
      ${avatarHtml}
      <div style="font-size:18px;font-weight:700;color:#222;margin-top:10px">和 ${Utils.escapeHtml(objName)} 一起听</div>
      <div style="display:inline-flex;align-items:center;gap:8px;margin-top:8px">
        <span style="font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;background:rgba(232,134,60,0.12);color:#e8863c">${modeLabel}</span>
        ${h.duration ? `<span style="font-size:12px;color:#888">共 ${Utils.escapeHtml(h.duration)}</span>` : ''}
      </div>
      <div style="font-size:11px;color:#aaa;margin-top:6px">${Utils.escapeHtml(_formatPhoneTime(h.startTime || '') || '')}${h.endTime ? ' — ' + Utils.escapeHtml(_formatPhoneTime(h.endTime || '') || '') : ''}</div>
    </div>
    <div style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;font-weight:600;color:#888">
        <span style="width:3px;height:12px;border-radius:2px;background:#e8863c"></span>
        听过的歌（${songCount}）
      </div>
      ${songsHtml}
    </div>
    ${msgsHtml ? `<div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;font-weight:600;color:#888">
        <span style="width:3px;height:12px;border-radius:2px;background:#e8863c"></span>
        留言（${msgCount}）
      </div>
      ${msgsHtml}
    </div>` : ''}
    <div style="text-align:center;font-size:10px;color:#ccc;margin-top:16px;padding-top:10px;border-top:1px dashed #eee">— SKYNEX · 一起听 —</div>
  `;

  document.body.appendChild(temp);

  try {
    const canvas = await html2canvas(temp, {
      backgroundColor: '#fff',
      useCORS: true,
      scale: 2,
      logging: false
    });
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `listen-together-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    UI.showToast('截图已导出', 2000);
  } catch(e) {
    console.error('[LT-Share]', e);
    UI.showToast('截图失败：' + (e.message || '未知错误'), 3000);
  } finally {
    document.body.removeChild(temp);
  }
}
function _openMusicDetail(id) {
  const render = () => _renderMusicDetail(id);
  _pushNav(render);
  render();
}

// 详情页自动刷新（切歌时跟随，暂停/播放只更新按钮图标不重渲染）
let _lastDetailTrackId = null;
function _refreshMusicDetail() {
  const container = document.querySelector('.phone-mdetail-page');
  if (!container) return; // 详情页没打开，不做事
  // 如果当前是一起听页面，不走详情页刷新
  const titleEl = document.getElementById('phone-title');
  if (titleEl && titleEl.textContent === '一起听') return;
  const t = Music.getCurrentTrack();
  const curId = t ? t.id : null;
  // 切歌了：完整重渲染
  if (curId !== _lastDetailTrackId) {
    _lastDetailTrackId = curId;
    if (t) _renderMusicDetail(t.id);
    return;
  }
  // 只是暂停/播放状态变了：只更新播放按钮图标
  const playBtn = container.querySelector('.phone-mdetail-play');
  if (playBtn) {
    const playing = Music.isPlaying();
    playBtn.innerHTML = _musicSvg(playing ? 'pauseBig' : 'playBig');
  }
}

// 详情页歌词实时更新（高亮+滚动）
function _updateDetailLrc() {
  const container = document.getElementById('phone-mdetail-lrc');
  if (!container) return;
  const st = Music.getLrcState();
  if (!st.parsed || !st.parsed.synced) return;
  const lines = container.querySelectorAll('.phone-mdetail-lrc-line');
  lines.forEach((el, i) => {
    el.classList.toggle('active', i === st.lineIdx);
  });
  // 滚动到当前行
  if (st.lineIdx >= 0 && lines[st.lineIdx]) {
    lines[st.lineIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// 详情页歌词渲染
function _renderDetailLrc(t) {
  const parsed = Music.parseLrc(t.lrc);
  if (!parsed || !parsed.lines.length) {
    return `<div class="phone-mdetail-lrc-empty">暂无歌词</div>`;
  }
  const lrcState = Music.getLrcState();
  const activeIdx = (Music.getCurrentId() === t.id && parsed.synced) ? lrcState.lineIdx : -1;
  return parsed.lines.map((line, i) => {
    const cls = i === activeIdx ? 'phone-mdetail-lrc-line active' : 'phone-mdetail-lrc-line';
    return `<div class="${cls}" data-lrc-i="${i}">${Utils.escapeHtml(line.text || '')}</div>`;
  }).join('');
}

function _renderMusicDetail(id) {
  const body = document.getElementById('phone-body');
  if (!body) return;
  const t = Music.getTracks().find(x => x.id === id);
  if (!t) { UI.showToast('歌曲不存在', 1500); Phone.goBack(); return; }

  const curId = Music.getCurrentId();
  const playing = Music.isPlaying();
  const isThis = curId === id;
  const prog = isThis ? Music.getProgress() : { ratio: 0, curText: '0:00', durText: '0:00' };
  const ratioPct = Math.round((prog.ratio || 0) * 100);
  const repeatMode = Music.getRepeatMode();

  const cover = t.coverUrl
    ? `<img src="${Utils.escapeHtml(t.coverUrl)}" alt="" onerror="this.style.display='none'">`
    : `<div class="phone-mdetail-cover-ph">${_musicSvg('list')}</div>`;

  body.innerHTML = `
    <div class="phone-app-page phone-mdetail-page">
      <div class="phone-mdetail-header">
        <div class="phone-mdetail-h-text">
          <div class="phone-mdetail-title">${Utils.escapeHtml(t.title || '未命名')}</div>
          <div class="phone-mdetail-artist">${Utils.escapeHtml(t.artist || '未知歌手')}</div>
        </div>
        <button class="phone-mdetail-menu" onclick="Phone._editMusicTrack('${t.id}')">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>
      <div class="phone-mdetail-cover-wrap">
        <div class="phone-mdetail-cover">${cover}</div>
      </div>
      <div class="phone-mdetail-lrc" id="phone-mdetail-lrc">
        ${_renderDetailLrc(t)}
      </div>
      <div class="phone-mdetail-bottom">
        <div class="phone-mdetail-actions">
        <button class="phone-mdetail-action-btn" onclick="Phone._musicComment('${t.id}')" title="评论">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="phone-mdetail-action-btn" onclick="Phone._musicShare('${t.id}')" title="分享">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/></svg>
        </button>
      </div>
      <div class="phone-mdetail-progress">
        <div class="phone-music-bar" id="phone-music-bar">
          <div class="phone-music-bar-fill" id="phone-music-bar-fill" style="width:${ratioPct}%"></div>
          <div class="phone-music-bar-dot" id="phone-music-bar-dot" style="left:${ratioPct}%"></div>
        </div>
        <div class="phone-music-times">
          <span id="phone-music-cur">${prog.curText || '0:00'}</span>
          <span id="phone-music-dur">${prog.durText || '0:00'}</span>
        </div>
      </div>
      <div class="phone-mdetail-controls">
        <button class="phone-mdetail-ctrl" onclick="Phone._musicCycleRepeat();Phone._renderMusicDetail('${t.id}')" title="播放模式">${_musicSvg(_musicRepeatIcon())}</button>
        <button class="phone-mdetail-ctrl" onclick="Music.prev();setTimeout(()=>{const ct=Music.getCurrentTrack();if(ct)Phone._renderMusicDetail(ct.id)},150)">${_musicSvg('prev')}</button>
        <button class="phone-mdetail-ctrl phone-mdetail-play" onclick="Music.play('${t.id}');setTimeout(()=>Phone._renderMusicDetail('${t.id}'),150)">${_musicSvg(isThis && playing ? 'pauseBig' : 'playBig')}</button>
        <button class="phone-mdetail-ctrl" onclick="Music.next();setTimeout(()=>{const ct=Music.getCurrentTrack();if(ct)Phone._renderMusicDetail(ct.id)},150)">${_musicSvg('nextTrack')}</button>
        <button class="phone-mdetail-ctrl" onclick="Phone._musicListPopup('${t.id}')" title="播放列表">${_musicSvg('list')}</button>
      </div>
    </div>`;
  _bindMusicProgressDrag();
}

// ===== 歌曲评论功能 =====
function _musicComment(id) {
  const render = () => _renderMusicComments(id);
  _pushNav(render);
  render();
}

function _renderMusicComments(id) {
  const body = document.getElementById('phone-body');
  if (!body) return;
  const t = Music.getTracks().find(x => x.id === id);
  if (!t) { UI.showToast('歌曲不存在', 1500); Phone.goBack(); return; }

  // 评论存在 phoneData.musicComments[trackId]
  const pd = _getCachedPhoneData();
  const comments = (pd && pd.musicComments && pd.musicComments[id]) || [];

  const cover = t.coverUrl
    ? `<img src="${Utils.escapeHtml(t.coverUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-secondary);opacity:0.4">${_musicSvg('list')}</div>`;

  const commentRows = comments.length ? comments.map(c => {
    const nameClass = c.isNpc ? 'phone-mcomment-name npc' : 'phone-mcomment-name';
    return `<div class="phone-mcomment-row">
      <div class="${nameClass}">${Utils.escapeHtml(c.username || '匿名')}</div>
      <div class="phone-mcomment-content">${Utils.escapeHtml(c.content || '')}</div>
      <div class="phone-mcomment-meta">${Utils.escapeHtml(c.time || '')}${c.likes ? ` · ♡ ${c.likes}` : ''}</div>
    </div>`;
  }).join('') : `<div class="phone-mcomment-empty">暂无评论，点击刷新生成评论</div>`;

  const tip = (!t.desc && !t.lrc) ? `<div class="phone-mcomment-tip">💡 推荐先填写歌曲描述和歌词，评论质量会更好</div>` : '';

  body.innerHTML = `
    <div class="phone-app-page phone-mcomment-page">
      <div class="phone-mcomment-card" onclick="Phone._openMusicDetail('${t.id}')">
        <div class="phone-mcomment-card-cover">${cover}</div>
        <div class="phone-mcomment-card-info">
          <div class="phone-mcomment-card-title">${Utils.escapeHtml(t.title || '未命名')}</div>
          <div class="phone-mcomment-card-artist">${Utils.escapeHtml(t.artist || '未知歌手')}</div>
        </div>
      </div>
      ${tip}
      <div class="phone-mcomment-bar">
        <span class="phone-mcomment-bar-title">评论</span>
        <button class="phone-mcomment-refresh" onclick="Phone._refreshMusicComments('${t.id}')">
${_uiIcon('refresh', 16)}
</button>
      </div>
      <div class="phone-mcomment-list" id="phone-mcomment-list">${commentRows}</div>
      <div class="phone-mcomment-input-bar">
        <input id="phone-mcomment-input" placeholder="写评论…" style="flex:1;border:none;background:transparent;color:var(--text);font-size:13px;outline:none;min-width:0">
        <button class="phone-mcomment-send" onclick="Phone._sendMusicComment('${t.id}')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>
        </button>
      </div>
    </div>`;
}

// 获取缓存的 phoneData（同步，不 await）
function _getCachedPhoneData() {
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    return conv?.phoneData || null;
  } catch(_) { return null; }
}

// 用户发评论
async function _sendMusicComment(id) {
  const input = document.getElementById('phone-mcomment-input');
  const content = input?.value.trim();
  if (!content) { UI.showToast('评论内容不能为空', 1000); return; }

  const pd = await _getPhoneData();
  if (!pd) return;
  if (!pd.musicComments) pd.musicComments = {};
  if (!pd.musicComments[id]) pd.musicComments[id] = [];

  // 获取玩家名
  let playerName = '我';
  try {
    const mk = (typeof Character !== 'undefined' && Character.getMask) ? Character.getMask() : null;
    playerName = mk?.playerName || mk?.name || '我';
  } catch(_) {}

  const gameTime = _getGameTime() || '';
  pd.musicComments[id].push({
    username: playerName,
    content,
    time: gameTime,
    likes: 0,
    isNpc: false,
    isPlayer: true
  });
  await _savePhoneData();
  input.value = '';
  _renderMusicComments(id);
}

// AI 刷新评论
async function _refreshMusicComments(id) {
  const t = Music.getTracks().find(x => x.id === id);
  if (!t) return;

  const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
  const mainConfig = await API.getConfig();
  const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
  const key = funcConfig.apiKey || mainConfig.apiKey;
  const model = funcConfig.model || mainConfig.model;
  if (!url || !key || !model) { UI.showToast('请先配置功能模型', 2000); return; }

  const pd = await _getPhoneData();
  if (!pd) return;
  if (!pd.musicComments) pd.musicComments = {};
  if (!pd.musicComments[id]) pd.musicComments[id] = [];
  const comments = pd.musicComments[id];

  UI.showToast('正在生成评论…', 2000);

  try {
    const wvPrompt = await _buildFullContext();
    const gameTime = _getGameTime() || '';

    // 获取玩家名
    let playerName = '我';
    try {
      const mk = (typeof Character !== 'undefined' && Character.getMask) ? Character.getMask() : null;
      playerName = mk?.playerName || mk?.name || '我';
    } catch(_) {}

    const sysPrompt = `你是一个音乐评论区生成器。用户给你一首歌的信息和当前已有的评论列表。请根据世界观、歌曲信息、已有评论，生成8-12条新的追加评论。

要求：
1. 只生成评论，不要改写歌曲信息。
2. 每条评论必须包含：username（评论者网名/本名）、content（评论内容）、time（评论时间）、likes（初始点赞数0-50）、isNpc（布尔值）。
3. 评论者来源：绝大部分为路人，其中0-2条为NPC评论。
4. 如果评论者是 NPC，username 直接填该 NPC 的网名（如有）或本名，并标记 "isNpc": true；不确定是否为 NPC 则作为路人处理并标记 "isNpc": false。
5. 评论内容要贴合音乐场景：可以有共鸣感想、歌词解读、推荐类似曲目、吐槽、表白歌手、贬低歌手、专业乐评、联想个人经历、阴阳怪气、跑题、引战、纯路人水评（"好听""单曲循环了"）等；长度错落有致，有一两个字的也有写一小段的。
6. 评论区允许互相@回复。如果已有评论中存在玩家的评论，请生成3-4条@玩家并回复玩家评论内容的评论（在 content 里用"@用户名 "开头表示回复）。其他评论之间也可以互相@。
7. 新评论应当参考已有评论，避免重复已有内容；可以接续已有讨论，也可以产生新方向。
8. 评论时间安排：首批评论（已有评论为空时）可以从当前游戏时间往前追溯2-3天分布，模拟歌曲上线后陆续有人评论的过程；后续追加评论则从已有最新评论时间之后开始，最新几条紧贴当前游戏时间。严禁跳跃到不合逻辑的遥远未来。
9. 返回格式为纯 JSON：{"comments": [{"username":"...","content":"...","time":"...","likes":数字,"isNpc":布尔值}, ...]}
   只返回 JSON，不要包含其他内容。

${wvPrompt}`;

    let existingCommentsStr = '暂无';
    if (comments.length > 0) {
      existingCommentsStr = comments.map(c => `用户名：${c.username} (${c.isNpc ? 'NPC' : c.isPlayer ? '玩家' : '路人'})\n时间：${c.time}\n点赞：${c.likes}\n内容：${c.content}`).join('\n\n');
    }

    const lrcText = t.lrc ? t.lrc.substring(0, 2000) : '暂无歌词';

    const userPrompt = `${gameTime ? `## 当前游戏时间\n${gameTime}\n\n` : ''}## 歌曲信息\n歌曲名：${t.title || '未命名'}\n歌手：${t.artist || '未知'}\n歌曲描述：${t.desc || '无'}\n\n## 歌词\n${lrcText}\n\n## 已有评论\n${existingCommentsStr}\n\n请生成 8-12 条新的追加评论，只返回 JSON。注意：评论者绝对不能是玩家本人（玩家名：${playerName}）。`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, stream: false, temperature: 0.85, max_tokens: 4000, messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }] })
    });
    if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
    const json = await resp.json();
    const raw = json.choices?.[0]?.message?.content || '';
    let result = null;
    try {
      let clean = raw.replace(/^\s*```(json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) clean = match[0];
      result = JSON.parse(clean);
    } catch(e) {
      console.error('[MusicComment] JSON parse fail:', raw);
      throw new Error('解析AI数据失败');
    }

    if (result.comments && result.comments.length > 0) {
      // 匹配 NPC 头像
      try {
        await _ensureForumNpcAvatarMap();
        await _ensureForumDisplayNameMap();
        result.comments.forEach(c => _matchForumAvatar(c));
      } catch(_) {}
      pd.musicComments[id].push(...result.comments);
      await _savePhoneData();
      UI.showToast(`已生成 ${result.comments.length} 条评论`, 1200);
    } else {
      UI.showToast('AI 未返回有效评论', 2000);
    }
  } catch(e) {
    UI.showToast('刷新失败：' + (e.message || e), 2500);
  }
  _renderMusicComments(id);
}

// 分享按钮
async function _musicShare(id) {
  const t = Music.getTracks().find(x => x.id === id);
  if (!t) { UI.showToast('找不到歌曲', 1500); return; }

  // 构建分享内容
  const title = t.title || '未命名';
  const artist = t.artist || '未知歌手';
  const desc = t.desc || '';
  const lrcRaw = t.lrc || '';
  const lrcText = lrcRaw.replace(/\[\d{2}:\d{2}[\.\:]\d{2,3}\]/g, '').trim().substring(0, 500);

  // 最新10条评论
  const pd = await _getPhoneData();
  const comments = (pd?.musicComments?.[id] || []).slice(-10);
  const commentsText = comments.length
    ? comments.map(c => `${c.username}：${c.content}`).join('\n')
    : '';

  const shareContent = `{{user}}分享了一首歌曲链接：\n歌名：${title}\n歌手：${artist}${desc ? '\n歌曲描述：' + desc : ''}${lrcText ? '\n歌词：\n' + lrcText : ''}${commentsText ? '\n\n评论区最新：\n' + commentsText : ''}`;

  // 弹选项
  const choice = await new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.45)';
    overlay.innerHTML = `
      <div style="background:var(--bg);border-radius:20px 20px 0 0;padding:20px 16px 36px;width:100%;max-width:420px">
        <div style="width:36px;height:4px;border-radius:2px;background:var(--border);margin:0 auto 18px"></div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <span style="font-size:16px;font-weight:600;color:var(--text)">分享</span>
          <button id="share-music-cancel" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;line-height:1">×</button>
        </div>
        <button id="share-music-main" style="width:100%;padding:14px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;margin-bottom:10px;display:flex;align-items:center;gap:12px">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>
          分享到主线
        </button>
        <button id="share-music-chat" style="width:100%;padding:14px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;margin-bottom:10px;display:flex;align-items:center;gap:12px">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          分享到聊天
        </button>
        <button id="share-music-listen" style="width:100%;padding:14px;background:var(--bg-tertiary);color:var(--text);border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:12px">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          一起听
        </button>
      </div>
    `;
    const close = val => { document.body.removeChild(overlay); resolve(val); };
    overlay.querySelector('#share-music-cancel').onclick = () => close(null);
    overlay.querySelector('#share-music-main').onclick = () => close('main');
    overlay.querySelector('#share-music-chat').onclick = () => close('chat');
    overlay.querySelector('#share-music-listen').onclick = () => close('listen');
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
    document.body.appendChild(overlay);
  });

  if (choice === 'main') {
    _shareToMain('music', `🎵 ${title} - ${artist}`, shareContent);
  } else if (choice === 'chat') {
    await _musicShareToChat(t, shareContent);
  } else if (choice === 'listen') {
    _openListenTogether(id);
  }
}

// 音乐分享到聊天（选联系人 → 发卡片）
async function _musicShareToChat(track, shareContent) {
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
      return `<div class="share-chat-pick-item" data-cid="${Utils.escapeHtml(c.id)}" style="padding:10px 12px;border-radius:10px;margin-bottom:4px;cursor:pointer;background:var(--bg-tertiary);display:flex;align-items:center;gap:10px">
        ${avatarEl}
        <span style="font-size:14px;color:var(--text)">${Utils.escapeHtml(displayName)}</span>
      </div>`;
    }).join('');
    overlay.innerHTML = `
      <div style="background:var(--bg);border-radius:16px;padding:20px 16px;width:85%;max-width:340px;max-height:70vh;overflow-y:auto">
        <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:12px">选择联系人</div>
        ${listHtml}
      </div>
    `;
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { resolve(null); document.body.removeChild(overlay); return; }
      const item = e.target.closest('.share-chat-pick-item');
      if (item) { resolve(item.dataset.cid); document.body.removeChild(overlay); }
    });
    document.body.appendChild(overlay);
  });

  if (!contactId) return;

  let gameTime = '';
  try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}
  if (!pd.chatThreads) pd.chatThreads = {};
  if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
  pd.chatThreads[contactId].push({
    id: 'music_' + Date.now(),
    role: 'me',
    type: 'music_card',
    musicTitle: track.title || '未命名',
    musicArtist: track.artist || '未知歌手',
    musicCover: track.coverUrl || '',
    text: shareContent,
    time: gameTime || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    createdAt: Date.now()
  });
  await _savePhoneData();

  const contactName = contacts.find(c => c.id === contactId)?.nickname || contacts.find(c => c.id === contactId)?.name || '对方';
  _log(`分享了歌曲「${track.title || '未命名'}」给${contactName}`);
  UI.showToast(`已分享给${contactName}`, 1500);
}

// ===== 一起听页面 =====
async function _openListenTogether(id) {
  const t = Music.getTracks().find(x => x.id === id) || Music.getCurrentTrack();
  if (!t) { UI.showToast('找不到歌曲', 1500); return; }

  // 获取用户头像
  let userAvatar = '', userName = '我';
  try {
    const mask = (typeof Character !== 'undefined' && Character.get) ? await Character.get() : null;
    userName = (mask?.onlineName || '').trim() || mask?.name || '我';
    userAvatar = (typeof Character !== 'undefined' && Character.getAvatar ? Character.getAvatar() : '') || mask?.avatar || '';
  } catch(_) {}
  _ltUserAvatar = userAvatar;
  _ltUserName = userName;

  // 载入已有会话（持久化恢复）
  const pd = await _getPhoneData();
  _ltSession = (pd && pd.listenTogether) ? pd.listenTogether : null;
  _lastListenTrackId = t.id;

  const render = () => _renderListenTogether(t, userAvatar, userName);
  _pushNav(render);
  render();
}

// 退出一起听（结算入历史，清空会话，回音乐库）
async function _exitListenTogether() {
  // 只有真正激活过的会话才结算入历史
  if (_ltSession && _ltSession.active) {
    try {
      const pd = await _getPhoneData();
      if (pd) {
        if (!Array.isArray(pd.listenTogetherHistory)) pd.listenTogetherHistory = [];
        let endTime = '';
        try { endTime = Conversations.getStatusBar()?.time || ''; } catch(_) {}
        const startTime = _ltSession.startTime || '';
        // 时长：同日按 HH:mm 差，否则留空
        const duration = _ltCalcDuration(startTime, endTime);
        pd.listenTogetherHistory.push({
          id: 'lth_' + Date.now(),
          mode: _ltSession.mode,
          targetName: (_ltSession.target && _ltSession.target.name) || '',
          targetAvatar: (_ltSession.target && _ltSession.target.avatar) || '',
          startTime, endTime, duration,
          playlist: Array.isArray(_ltSession.playlist) ? _ltSession.playlist.slice() : [],
          messages: Array.isArray(_ltSession.messages) ? _ltSession.messages.slice() : []
        });
        // 退出提示
        if (_ltSession.mode === 'online') {
          // 线上：往该联系人私聊发一张「已结束一起听」卡片
          const cid = _ltSession.target && _ltSession.target.contactId;
          if (cid) {
            if (!pd.chatThreads) pd.chatThreads = {};
            if (!pd.chatThreads[cid]) pd.chatThreads[cid] = [];
            let gt = '';
            try { gt = _formatPhoneTime(Conversations.getStatusBar()?.time || ''); } catch(_) {}
            pd.chatThreads[cid].push({
              id: 'lt_end_' + Date.now(),
              role: 'me',
              type: 'listen_end',
              text: '已结束一起听',
              time: gt || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
              createdAt: Date.now()
            });
          }
        } else {
          // 线下/公放：写主线操作记录
          const objName = _ltSession.mode === 'broadcast' ? '公放' : ((_ltSession.target && _ltSession.target.name) || '对方');
          if (_ltSession.mode === 'broadcast') {
            _log('结束了公放一起听');
          } else {
            _log(`结束了和${objName}的一起听`);
          }
        }
        pd.listenTogether = null;
        await _savePhoneData();
      }
    } catch(_) {}
  }
  _ltSession = null;
  _lastListenTrackId = null;
  _ltLastSyncTrackId = null;
  await _persistLtSession();
  _openMusicLibrary();
}

// 计算一起听时长（同日 HH:mm 差返回"X小时Y分钟"/"Y分钟"，跨日或解析失败返回空）
function _ltCalcDuration(start, end) {
  try {
    const sm = String(start).match(/(\d{1,2}):(\d{2})/);
    const em = String(end).match(/(\d{1,2}):(\d{2})/);
    if (!sm || !em) return '';
    // 日期部分（去掉时分）比较，跨日不算
    const sDay = String(start).replace(/\s*\d{1,2}:\d{2}.*$/, '').trim();
    const eDay = String(end).replace(/\s*\d{1,2}:\d{2}.*$/, '').trim();
    if (sDay && eDay && sDay !== eDay) return '';
    let mins = (parseInt(em[1]) * 60 + parseInt(em[2])) - (parseInt(sm[1]) * 60 + parseInt(sm[2]));
    if (mins <= 0) return '';
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? `${h}小时${m ? m + '分钟' : ''}` : `${m}分钟`;
  } catch(_) { return ''; }
}

// 戴上/摘下耳机（快捷开关：等同设置里的"发送本轮操作"）
async function _toggleMusicEarphone() {
  if (!_musicEarphoneOn) {
    const ok = await UI.showConfirm('戴上耳机', '选择此选项后，你的听歌操作记录会被同步至主线，是否继续？');
    if (!ok) return;
    _musicEarphoneOn = true;
    // 如果正在播歌，立即记一条
    const t = Music.getCurrentTrack();
    if (t && Music.isPlaying()) {
      _log(`正在播放（歌名：${t.title || '未命名'}）（歌手：${t.artist || '未知歌手'}）`);
    }
  } else {
    _musicEarphoneOn = false;
    // 清掉已写入的音乐日志（不影响其他操作日志）
    const musicPatterns = ['正在播放（歌名：', '暂停了播放', '歌曲切换到了（歌名：'];
    _actionLog = _actionLog.filter(a => !musicPatterns.some(p => a.includes(p)));
    _actionLogForBackstage = _actionLogForBackstage.filter(a => !musicPatterns.some(p => a.includes(p)));
    _persistActionLog();
  }
  _renderMusicLibrary();
}

// 耳机模式下的音乐日志
let _lastLoggedTrackId = null;
let _lastLoggedPlaying = false;

function _handleMusicStateLog() {
  if (!_musicEarphoneOn) return;
  _ltEnsureSession();
  // 一起听激活时，仅线下（公放/耳机共享）跳过简版日志——由一起听提示词覆盖
  if (_ltSession && _ltSession.active && (_ltSession.mode === 'broadcast' || _ltSession.mode === 'earphone')) return;
  const t = Music.getCurrentTrack();
  const playing = Music.isPlaying();
  const curId = t ? t.id : null;

  // 切歌
  if (curId && curId !== _lastLoggedTrackId) {
    const oldT = _lastLoggedTrackId ? Music.getTracks().find(x => x.id === _lastLoggedTrackId) : null;
    _logMusicSwitch(t, oldT);
    _lastLoggedTrackId = curId;
    _lastLoggedPlaying = playing;
    return;
  }

  // 暂停
  if (!playing && _lastLoggedPlaying && curId) {
    _logMusicPause();
  }
  _lastLoggedPlaying = playing;
}

function _logMusicPlay(track) {
  if (!_musicEarphoneOn || !track) return;
  _lastLoggedTrackId = track.id;
  _lastLoggedPlaying = true;
  _log(`正在播放（歌名：${track.title || '未命名'}）（歌手：${track.artist || '未知歌手'}）`);
}
function _logMusicPause() {
  if (!_musicEarphoneOn) return;
  _log('暂停了播放');
}
function _logMusicSwitch(newTrack, oldTrack) {
  if (!_musicEarphoneOn || !newTrack) return;
  const oldName = oldTrack ? (oldTrack.title || '未命名') : '无';
  _log(`歌曲切换到了（歌名：${newTrack.title || '未命名'}）（歌手：${newTrack.artist || '未知歌手'}），上一首是：${oldName}`);
  _lastLoggedTrackId = newTrack.id;
}

// 音乐库列表点击行为：一起听模式下播放并回一起听页面，否则进详情
function _musicLibRowClick(id) {
  _ltEnsureSession();
  if (_ltSession) {
    Music.play(id);
    // 弹出列表页，回到一起听
    _navStack.pop(); // 移除列表页
    const t = Music.getTracks().find(x => x.id === id);
    if (t) _renderListenTogether(t, _ltUserAvatar, _ltUserName);
  } else {
    _openMusicDetail(id);
  }
}

function _renderListenTogether(track, userAvatar, userName) {
  const body = document.getElementById('phone-body');
  if (!body) return;
  // 恢复用户头像/网名（刷新后可能丢失）
  if (!userAvatar || userName === '我') {
    try {
      const mask = (typeof Character !== 'undefined' && Character.get) ? Character.get() : null;
      if (mask) {
        if (!userAvatar) userAvatar = (typeof Character !== 'undefined' && Character.getAvatar ? Character.getAvatar() : '') || mask.avatar || '';
        if (userName === '我') userName = (mask.onlineName || '').trim() || mask.name || '我';
        _ltUserAvatar = userAvatar;
        _ltUserName = userName;
      }
    } catch(_) {}
  }
  body.classList.remove('phone-home-mode');
  document.getElementById('phone-back-btn')?.classList.remove('hidden');
  const titleEl = document.getElementById('phone-title');
  if (titleEl) titleEl.textContent = '一起听';

  const playing = Music.isPlaying();
  const prog = Music.getProgress();
  const ratioPct = Math.round((prog.ratio || 0) * 100);

  // 用户头像
  const userAvaEl = userAvatar
    ? `<img src="${Utils.escapeHtml(userAvatar)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover">`
    : `<div style="width:56px;height:56px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600">${Utils.escapeHtml((userName || '我')[0])}</div>`;

  // 右侧头像区（根据会话状态）
  let rightEl = '';
  let rightLabel = '邀请';
  if (_ltSession && _ltSession.active) {
    // 已加入
    const tgt = _ltSession.target || {};
    if (_ltSession.mode === 'broadcast') {
      // 公放图标
      rightEl = `<div style="width:56px;height:56px;border-radius:50%;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.08"/></svg>
      </div>`;
      rightLabel = '所有人';
    } else {
      const tName = _ltGetDisplayName(tgt.name) || tgt.name || '?';
      rightEl = tgt.avatar
        ? `<img src="${Utils.escapeHtml(tgt.avatar)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover">`
        : `<div style="width:56px;height:56px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600">${Utils.escapeHtml(tName[0])}</div>`;
      rightLabel = tName;
    }
  } else if (_ltSession && _ltSession.pending) {
    // 等待对方接受（点击可取消）
    const tName = _ltGetDisplayName(_ltSession.target?.name) || _ltSession.target?.name || '?';
    rightEl = `<div onclick="Phone._ltCancelInvite()" style="width:56px;height:56px;border-radius:50%;border:2px dashed var(--accent);display:flex;align-items:center;justify-content:center;opacity:0.7;cursor:pointer" title="点击取消邀请">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    </div>`;
    rightLabel = `等待${tName}…`;
  } else if (_ltSession && _ltSession.rejected) {
    // 被拒绝
    const reason = _ltSession.rejectReason || '';
    rightEl = `<div onclick="Phone._ltRetryInvite()" style="width:56px;height:56px;border-radius:50%;border:2px dashed var(--border);display:flex;align-items:center;justify-content:center;cursor:pointer">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
    </div>`;
    rightLabel = reason ? `拒绝：${reason}` : '对方拒绝了';
  } else {
    // 未邀请
    rightEl = `<div onclick="Phone._listenTogetherInvite()" style="width:56px;height:56px;border-radius:50%;border:2px dashed var(--border);display:flex;align-items:center;justify-content:center;cursor:pointer">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </div>`;
    rightLabel = '邀请';
  }

  // 留言区（仅 active 时显示）
  let msgAreaHtml = '<div style="flex:1"></div>';
  if (_ltSession && _ltSession.active) {
    const msgs = Array.isArray(_ltSession.messages) ? _ltSession.messages : [];
    const rows = msgs.length
      ? msgs.map(m => `
        <div class="lt-msg-card">
          <div style="display:flex;align-items:baseline;gap:6px">
            <span style="font-size:12px;font-weight:600;color:var(--text)">${Utils.escapeHtml(m.name || '对方')}</span>
            <span style="font-size:10px;color:var(--text-secondary)">${Utils.escapeHtml(_formatPhoneTime(m.at || '') || '')}</span>
          </div>
          <div style="font-size:13px;color:var(--text);line-height:1.5;margin-top:4px;word-break:break-word">${Utils.escapeHtml(m.content || '')}</div>
        </div>`).join('')
      : '<div style="text-align:center;color:var(--text-secondary);font-size:12px;padding:16px 0">还没有留言</div>';
    msgAreaHtml = `
      <div style="flex:1;min-height:0;display:flex;flex-direction:column;margin-top:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:0 2px 8px">
          <span style="font-size:12px;font-weight:600;color:var(--text-secondary)">留言</span>
          <button onclick="Phone._ltWriteMessage()" title="写留言" style="background:none;border:none;color:var(--accent);cursor:pointer;padding:2px;display:flex;align-items:center;gap:3px;font-size:12px">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            写留言
          </button>
        </div>
        <div style="flex:1;min-height:0;overflow-y:auto;padding:4px 2px 0">${rows}</div>
      </div>`;
  }

  body.innerHTML = `
    <div class="phone-mdetail-page" style="padding:16px 16px 0;display:flex;flex-direction:column;height:100%">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px">
        <div>
          <div style="font-size:18px;font-weight:700;color:var(--text)">${Utils.escapeHtml(track.title || '未命名')}</div>
          <div style="font-size:13px;color:var(--text-secondary);margin-top:2px">${Utils.escapeHtml(track.artist || '未知歌手')}</div>
        </div>
        <button onclick="Phone._exitListenTogether()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px" title="退出一起听">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>

      <div style="display:flex;align-items:center;justify-content:center;gap:32px;padding:20px 0 12px">
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          ${userAvaEl}
          <span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(userName)}</span>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          ${rightEl}
          <span style="font-size:11px;color:var(--text-secondary);max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center">${Utils.escapeHtml(rightLabel)}</span>
        </div>
      </div>

      ${msgAreaHtml}

      <div class="phone-mdetail-bottom">
        <div class="phone-mdetail-progress">
          <div class="phone-music-bar" id="phone-music-bar">
            <div class="phone-music-bar-fill" id="phone-music-bar-fill" style="width:${ratioPct}%"></div>
            <div class="phone-music-bar-dot" id="phone-music-bar-dot" style="left:${ratioPct}%"></div>
          </div>
          <div class="phone-music-times">
            <span id="phone-music-cur">${prog.curText || '0:00'}</span>
            <span id="phone-music-dur">${prog.durText || '0:00'}</span>
          </div>
        </div>
        <div class="phone-mdetail-controls">
          <button class="phone-mdetail-ctrl" onclick="Phone._musicCycleRepeat();Phone._refreshListenTogether()">${_musicSvg(_musicRepeatIcon())}</button>
          <button class="phone-mdetail-ctrl" onclick="Music.prev();setTimeout(()=>Phone._refreshListenTogether(),150)">${_musicSvg('prev')}</button>
          <button class="phone-mdetail-ctrl phone-mdetail-play" onclick="Music.toggle()">${_musicSvg(playing ? 'pauseBig' : 'playBig')}</button>
          <button class="phone-mdetail-ctrl" onclick="Music.next();setTimeout(()=>Phone._refreshListenTogether(),150)">${_musicSvg('nextTrack')}</button>
          <button class="phone-mdetail-ctrl" onclick="Phone._musicListPopup('${track.id}')" title="播放列表">${_musicSvg('list')}</button>
        </div>
      </div>
    </div>
  `;
  _bindMusicProgressDrag();
}

// 被拒后重新邀请
async function _ltRetryInvite() {
  // 清掉拒绝状态
  _ltSession = null;
  await _persistLtSession();
  const t = Music.getCurrentTrack();
  if (t) _renderListenTogether(t, _ltUserAvatar, _ltUserName);
  // 重新弹邀请菜单
  _listenTogetherInvite();
}

// 取消待处理的邀请
async function _ltCancelInvite() {
  if (!_ltSession || !_ltSession.pending) return;
  const ok = await UI.showConfirm('取消邀请', `确定取消对${_ltSession.target?.name || '对方'}的邀请吗？`);
  if (!ok) return;
  _ltSession = null;
  await _persistLtSession();
  UI.showToast('已取消邀请', 1200);
  // 延迟渲染确保 confirm 弹窗完全移除
  setTimeout(() => {
    const t = Music.getCurrentTrack();
    if (t) _renderListenTogether(t, _ltUserAvatar, _ltUserName);
  }, 50);
}

// 一起听会话状态（内存镜像 = phoneData.listenTogether）
let _ltSession = null;     // { active, pending, rejected, mode, target:{name,avatar,contactId}, startTime, playlist, messages, lastTrackId, rejectReason }
let _ltUserAvatar = '';    // 用户头像缓存（渲染用）
let _ltUserName = '我';    // 用户网名缓存
let _lastListenTrackId = null;
let _musicEarphoneOn = false; // 是否戴上耳机（同步操作到主线）

function _ltIsActive() { return !!(_ltSession && _ltSession.active); }

// 按本名查网名/昵称（优先聊天联系人 nickname，其次 NPC onlineName）
function _ltGetDisplayName(name) {
  if (!name) return '';
  // 聊天联系人
  try {
    const pd = _getPhoneDataSync();
    if (pd && pd.chatContacts) {
      const c = pd.chatContacts.find(x => x.name === name);
      if (c && c.nickname) return c.nickname;
    }
  } catch(_) {}
  // NPC onlineName
  try {
    if (typeof NPC !== 'undefined' && NPC.getByNames) {
      const arr = NPC.getByNames([name]);
      if (arr.length && arr[0].onlineName) return arr[0].onlineName;
    }
  } catch(_) {}
  return '';
}

// 懒恢复：刷新后从 phoneData 读回会话状态（同步，不补字段）
let _ltSessionConvId = null; // 记录当前 _ltSession 对应的对话 ID
function _ltEnsureSession() {
  const curConvId = Conversations.getCurrent && Conversations.getCurrent();
  // 对话切换了 → 清空内存状态，重新从新对话的 phoneData 读
  if (_ltSessionConvId && curConvId && _ltSessionConvId !== curConvId) {
    _ltSession = null;
    _ltSessionConvId = null;
    _ltLastSyncTrackId = null;
  }
  if (_ltSession !== null) return; // 已有
  const pd = _getPhoneDataSync();
  if (pd && pd.listenTogether && (pd.listenTogether.active || pd.listenTogether.pending)) {
    _ltSession = pd.listenTogether;
    _ltSessionConvId = curConvId;
    if (_ltSession.lastTrackId) _ltLastSyncTrackId = _ltSession.lastTrackId;
  }
}

async function _persistLtSession() {
  const pd = await _getPhoneData();
  if (!pd) return;
  pd.listenTogether = _ltSession;
  await _savePhoneData();
}

function _refreshListenTogether() {
  const titleEl = document.getElementById('phone-title');
  if (!titleEl || titleEl.textContent !== '一起听') return;
  const t = Music.getCurrentTrack();
  if (!t) return;
  _lastListenTrackId = t.id;
  _renderListenTogether(t, _ltUserAvatar, _ltUserName);
}

// state 事件：暂停/播放只更新按钮图标，切歌时整页刷新
function _refreshListenTogetherState() {
  const titleEl = document.getElementById('phone-title');
  if (!titleEl || titleEl.textContent !== '一起听') return;
  const t = Music.getCurrentTrack();
  const curId = t ? t.id : null;
  if (curId !== _lastListenTrackId) {
    _lastListenTrackId = curId;
    if (t) _renderListenTogether(t, _ltUserAvatar, _ltUserName);
    return;
  }
  // 只更新播放按钮图标
  const playBtn = document.querySelector('.phone-mdetail-play');
  if (playBtn) {
    playBtn.innerHTML = _musicSvg(Music.isPlaying() ? 'pauseBig' : 'playBig');
  }
}

// ===== 一起听邀请 =====
async function _listenTogetherInvite() {
  const t = Music.getCurrentTrack();
  if (!t) { UI.showToast('先播放一首歌再邀请', 1500); return; }
  const choice = await _musicSheet('邀请方式', [
    { label: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>耳机分Ta一半', value: 'earphone', html: true },
    { label: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>线上一起听歌', value: 'online', html: true }
  ]);
  if (!choice) return;
  if (choice === 'earphone') {
    await _ltInviteOffline(t);
  } else if (choice === 'online') {
    await _ltInviteOnline(t);
  }
}

// 线下：选"所有人"(公放) 或 在场角色(耳机共享)
async function _ltInviteOffline(track) {
  // 从两个来源获取在场角色：NPC.getPresentNPCs() + statusBar.npcs
  let present = [];
  try {
    if (typeof NPC !== 'undefined' && NPC.getPresentNPCs) {
      present = NPC.getPresentNPCs() || [];
    }
  } catch(_) {}
  // fallback: statusBar.npcs
  if (!present.length) {
    try {
      const sb = (typeof Conversations !== 'undefined') ? Conversations.getStatusBar() : null;
      if (sb && Array.isArray(sb.npcs)) {
        present = sb.npcs.map(n => n.name).filter(Boolean);
      }
    } catch(_) {}
  }
const opts = [{ label: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:-2px;margin-right:4px"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.08"/></svg>所有人（公放）', value: '__all__', html: true }];
    present.forEach(name => opts.push({ label: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>' + Utils.escapeHtml(name), value: name, html: true }));
  const choice = await _musicSheet('和谁一起听', opts);
  if (!choice) return;

  if (choice === '__all__') {
    // 公放：无需接受，直接激活
    await _ltActivate({ mode: 'broadcast', target: { name: '所有人', avatar: '', contactId: '' } });
    UI.showToast('已开外放，大家一起听', 1500);
  } else {
    // 耳机共享：待对方接受（下一轮主线发操作记录，AI 回标记）
    // 尝试按名字找头像（从聊天联系人/头像 map）
    let choiceAvatar = _chatAvatarMap[choice] || '';
    if (!choiceAvatar) {
      try {
        const pd = await _getPhoneData();
        const c = (pd?.chatContacts || []).find(x => x.name === choice);
        if (c) choiceAvatar = _chatContactAvatar(c) || '';
      } catch(_) {}
    }
    _ltSessionConvId = Conversations.getCurrent && Conversations.getCurrent();
    _ltSession = {
      active: false, pending: true, rejected: false,
      mode: 'earphone',
      target: { name: choice, avatar: choiceAvatar, contactId: '' },
      startTime: '', playlist: [], messages: [],
      lastTrackId: track.id, rejectReason: '',
      invitePrompt: _ltBuildInvitePrompt(choice, 'offline')
    };
    await _persistLtSession();
    _renderListenTogether(track, _ltUserAvatar, _ltUserName);
    UI.showToast('已发出邀请，等待对方回应…', 1800);
  }
}

// 线上：选聊天联系人，发卡片邀请
async function _ltInviteOnline(track) {
  const pd = await _getPhoneData();
  const contacts = pd?.chatContacts || [];
  if (!contacts.length) { UI.showToast('还没有聊天联系人', 1500); return; }
  const contactId = await _ltPickContact(contacts);
  if (!contactId) return;
  const c = contacts.find(x => x.id === contactId);
  const cName = c?.nickname || c?.name || '对方';
  const cAvatar = _chatContactAvatar(c) || '';

  // 发一张邀请卡片到该联系人聊天（需用户在聊天里点刷新才打包发 AI）
  let gameTime = '';
  try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}
  if (!pd.chatThreads) pd.chatThreads = {};
  if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
  pd.chatThreads[contactId].push({
    id: 'lt_invite_' + Date.now(),
    role: 'me',
    type: 'listen_invite',
    musicTitle: track.title || '未命名',
    musicArtist: track.artist || '未知歌手',
    musicCover: track.coverUrl || '',
    text: `想和你一起听「${track.title || '未命名'}」`,
    time: gameTime || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    createdAt: Date.now()
  });

  _ltSessionConvId = Conversations.getCurrent && Conversations.getCurrent();
    _ltSession = {
    active: false, pending: true, rejected: false,
    mode: 'online',
    target: { name: cName, avatar: cAvatar, contactId },
    startTime: '', playlist: [], messages: [],
    lastTrackId: track.id, rejectReason: '',
    invitePrompt: _ltBuildInvitePrompt(cName, 'online')
  };
  pd.listenTogether = _ltSession;
  await _savePhoneData();
  _renderListenTogether(track, _ltUserAvatar, _ltUserName);
  UI.showToast(`已向${cName}发送邀请卡片`, 1800);
}

// 联系人选择器（复用分享到聊天的样式）
function _ltPickContact(contacts) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)';
    const listHtml = contacts.map(c => {
      const displayName = c.nickname || c.name || '?';
      const avaUrl = _chatContactAvatar(c);
      const avatarEl = avaUrl
        ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0">`
        : `<div style="width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;flex-shrink:0">${Utils.escapeHtml(displayName[0])}</div>`;
      return `<div class="lt-pick-item" data-cid="${Utils.escapeHtml(c.id)}" style="padding:10px 12px;border-radius:10px;margin-bottom:4px;cursor:pointer;background:var(--bg-tertiary);display:flex;align-items:center;gap:10px">
        ${avatarEl}
        <span style="font-size:14px;color:var(--text)">${Utils.escapeHtml(displayName)}</span>
      </div>`;
    }).join('');
    overlay.innerHTML = `
      <div style="background:var(--bg);border-radius:16px;padding:20px 16px;width:85%;max-width:340px;max-height:70vh;overflow-y:auto">
        <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:12px">邀请谁一起听</div>
        ${listHtml}
      </div>`;
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { resolve(null); document.body.removeChild(overlay); return; }
      const item = e.target.closest('.lt-pick-item');
      if (item) { resolve(item.dataset.cid); document.body.removeChild(overlay); }
    });
    document.body.appendChild(overlay);
  });
}

// 激活一起听会话（公放直接调 / 接受邀请后调）
async function _ltActivate(opts) {
  let startTime = '';
  try { const sb = Conversations.getStatusBar(); startTime = sb?.time || ''; } catch(_) {}
  const t = Music.getCurrentTrack();
  _ltSessionConvId = Conversations.getCurrent && Conversations.getCurrent();
    _ltSession = {
    active: true, pending: false, rejected: false,
    mode: opts.mode,
    target: opts.target,
    startTime,
    playlist: t ? [{ title: t.title || '未命名', artist: t.artist || '', at: startTime }] : [],
    messages: [],
    lastTrackId: t ? t.id : null,
    rejectReason: '',
    invitePrompt: ''
  };
  await _persistLtSession();
  // 线上激活：立即写一条操作记录
  if (opts.mode === 'online' && t) _ltLogOnline(t);
  if (t) _renderListenTogether(t, _ltUserAvatar, _ltUserName);
}

// 生成邀请提示词（供 chat.js 注入主线 / 线上聊天）
function _ltBuildInvitePrompt(targetName, scene) {
  const t = Music.getCurrentTrack();
  const songInfo = t ? `当前播放：《${t.title || '未命名'}》${t.artist ? ' - ' + t.artist : ''}。` : '';
  const shareLine = scene === 'online'
    ? '{{user}}通过线上"一起听"邀请' + targetName + '一起听歌。' + songInfo + '接受后会同步{{user}}正在听的音乐。'
    : '{{user}}想和' + targetName + '一起听歌（把一只耳机分给对方）。' + songInfo + '接受后会共享{{user}}正在听的音乐。';
  return [
    '【一起听·邀请】' + shareLine,
    '请' + targetName + '根据当前情境、人物关系和心情，决定是否接受。',
    '- 如果接受，在回复末尾输出：```listen_together',
    '{"accept":true}```',
    '- 如果拒绝，输出：```listen_together',
    '{"accept":false,"reason":"简短理由"}```',
    '请把这个动作自然融入剧情（接过耳机/表示同意/婉拒/其他），不要直接复述本提示。'
  ].join('\n');
}

// 生成「一起听·进行中」提示词（当前播放歌曲完整信息）
function _ltBuildNowPlayingPrompt() {
  if (!_ltSession || !_ltSession.active) return '';
  const t = Music.getCurrentTrack();
  if (!t) return ''; // 没有在播的歌就不发
  const tgt = _ltSession.target || {};
  const sceneLabel = _ltSession.mode === 'broadcast' ? '公放'
    : _ltSession.mode === 'earphone' ? '共享耳机'
    : '线上';
  const objName = _ltSession.mode === 'broadcast' ? '大家' : (tgt.name || '对方');

  const title = t.title || '未命名';
  const artist = t.artist || '未知歌手';
  const desc = t.desc || '';
  const lrcRaw = t.lrc || '';
  const lrcText = lrcRaw.replace(/\[\d{2}:\d{2}[\.\:]\d{2,3}\]/g, '').trim().substring(0, 300);
  let durText = '';
  try { durText = Music.getProgress().durText || ''; } catch(_) {}

  // 上一首
  const pl = _ltSession.playlist || [];
  const prev = pl.length >= 2 ? pl[pl.length - 2] : null;
  const prevText = prev ? `${prev.title}${prev.artist ? ' — ' + prev.artist : ''}` : '无';

  const lines = [
    `【一起听·进行中】{{user}}正在和${objName}一起听歌（${sceneLabel}）。`,
    '当前播放：',
    `歌名：${title}`,
    `歌手：${artist}`
  ];
  if (desc) lines.push(`描述：${desc}`);
  if (lrcText) lines.push(`歌词：${lrcText}`);
  if (durText) lines.push(`时长：${durText}`);
  lines.push(`上一首：${prevText}`);
  // 最近留言（让 AI 看到用户/其他人的留言并能回应）
  const recentMsgs = Array.isArray(_ltSession.messages) ? _ltSession.messages.slice(-5) : [];
  if (recentMsgs.length) {
    lines.push('最近留言：');
    recentMsgs.forEach(m => lines.push(`· ${m.name || '对方'}：${m.content || ''}`));
  }
  lines.push(`${objName === '大家' ? '在场角色' : objName}可以在剧情里自然回应这首歌带来的感受，可以用语言、肢体，或者就是单纯听着，当做背景音。可以描写反应，也可以用旁白描述气氛，无需每一轮都做出点评或者反应，将音乐融入环境中。`);
  if (_ltSession.mode === 'broadcast') {
    lines.push('如果某个在场角色想在一起听界面留言，在回复末尾输出代码块（一行一条，格式"角色名：留言内容"，可多条）：```listen_msg');
    lines.push('角色名：留言内容```');
    lines.push('注意：只允许以角色的身份留言，禁止使用{{user}}的身份留言，禁止复述{{user}}的留言内容。');
  } else {
    lines.push('如果想在一起听界面留言，可以在剧情中自然提到打开手机进行留言，留言正文写入末尾代码块：```listen_msg');
    lines.push('留言内容```');
    lines.push('注意：只允许以你扮演的角色身份留言，禁止使用{{user}}的身份留言，禁止复述{{user}}的留言内容。');
  }
  return lines.join('\n');
}

// 生成线上版「一起听·进行中」提示词（注入到该联系人的私聊请求里，无动作/气氛引导）
function _ltBuildOnlineNowPlaying() {
  if (!_ltSession || !_ltSession.active || _ltSession.mode !== 'online') return '';
  const t = Music.getCurrentTrack();
  if (!t) return '';
  const tgt = _ltSession.target || {};
  const objName = tgt.name || '对方';
  const title = t.title || '未命名';
  const artist = t.artist || '未知歌手';
  const desc = t.desc || '';
  const lrcRaw = t.lrc || '';
  const lrcText = lrcRaw.replace(/\[\d{2}:\d{2}[\.\:]\d{2,3}\]/g, '').trim().substring(0, 300);
  let durText = '';
  try { durText = Music.getProgress().durText || ''; } catch(_) {}
  const pl = _ltSession.playlist || [];
  const prev = pl.length >= 2 ? pl[pl.length - 2] : null;
  const prevText = prev ? `${prev.title}${prev.artist ? ' — ' + prev.artist : ''}` : '无';

  const lines = [
    `【一起听·进行中（线上）】{{user}}正在和你（${objName}）线上一起听歌。`,
    '当前播放：',
    `歌名：${title}`,
    `歌手：${artist}`
  ];
  if (desc) lines.push(`描述：${desc}`);
  if (lrcText) lines.push(`歌词：${lrcText}`);
  if (durText) lines.push(`时长：${durText}`);
  lines.push(`上一首：${prevText}`);
  const recentMsgsO = Array.isArray(_ltSession.messages) ? _ltSession.messages.slice(-5) : [];
  if (recentMsgsO.length) {
    lines.push('最近留言：');
    recentMsgsO.forEach(m => lines.push(`· ${m.name || '对方'}：${m.content || ''}`));
  }
  lines.push('你可以在私聊里自然回应这首歌（比如评价、说听后感、点歌），也可以只是安静听着。无需每轮都点评。');
  lines.push('如果想在一起听界面留言，在回复末尾输出代码块：```listen_msg');
    lines.push('留言内容```');
    lines.push('注意：只允许以你扮演的角色身份留言，禁止使用{{user}}的身份留言，禁止复述{{user}}的留言内容。');
    return lines.join('\n');
}
let _ltLastSyncTrackId = null;
function _ltSyncOnState() {
  _ltEnsureSession();
  if (!_ltSession || !_ltSession.active) { _ltLastSyncTrackId = null; return; }
  const t = Music.getCurrentTrack();
  const curId = t ? t.id : null;
  if (curId && curId !== _ltLastSyncTrackId) {
    // 切歌：追加到 playlist
    let at = '';
    try { at = Conversations.getStatusBar()?.time || ''; } catch(_) {}
    if (!Array.isArray(_ltSession.playlist)) _ltSession.playlist = [];
    const songTitle = t.title || '未命名';
    const songArtist = t.artist || '';
    // 去重：同名同歌手不重复记录
    const alreadyExists = _ltSession.playlist.some(s => s.title === songTitle && s.artist === songArtist);
    if (!alreadyExists) {
      _ltSession.playlist.push({ title: songTitle, artist: songArtist, at });
    }
    _ltSession.lastTrackId = curId;
    _ltLastSyncTrackId = curId;
    _persistLtSession();
    // 线上一起听：把"和谁在听什么"写进操作记录（不依赖耳机开关）
    if (_ltSession.mode === 'online') _ltLogOnline(t);
  }
}

// 线上一起听：写一条操作记录给主线
function _ltLogOnline(track) {
  if (!_ltSession || !_ltSession.active || _ltSession.mode !== 'online' || !track) return;
  const objName = (_ltSession.target && _ltSession.target.name) || '对方';
  _log(`正在和${objName}线上一起听（歌名：${track.title || '未命名'}）（歌手：${track.artist || '未知歌手'}）`);
}

// 添加一条一起听留言（去重后存入会话）
async function _ltAddMessage(name, content) {
  if (!_ltSession || !_ltSession.active) return;
  const text = (content || '').trim();
  if (!text) return;
  if (!Array.isArray(_ltSession.messages)) _ltSession.messages = [];
  // 去重：同名同内容且相邻不重复添加
  const last = _ltSession.messages[_ltSession.messages.length - 1];
  if (last && last.name === name && last.content === text) return;
  let at = '';
  try { at = Conversations.getStatusBar()?.time || ''; } catch(_) {}
  _ltSession.messages.push({ name: name || '对方', content: text, at });
  await _persistLtSession();
  // 如果用户正在看一起听页面，刷新（留言渲染在 Step 6 接入）
  const titleEl = document.getElementById('phone-title');
  if (titleEl && titleEl.textContent === '一起听') {
    const t = Music.getCurrentTrack();
    if (t) _renderListenTogether(t, _ltUserAvatar, _ltUserName);
  }
}

// 用户写留言（一起听界面小按钮）
async function _ltWriteMessage() {
  if (!_ltSession || !_ltSession.active) return;
  const res = await _musicForm('写留言', [
    { key: 'content', label: '留言内容', value: '', textarea: true }
  ]);
  if (!res || !(res.content || '').trim()) return;
  await _ltAddMessage(_ltUserName || '我', res.content.trim());
}

// 供 chat.js 主线调用：处理 listen_msg 标记（按模式决定留言名字）
async function _ltHandleMsg(rawMsg) {
  if (!_ltSession || !_ltSession.active) return;
  const raw = (rawMsg || '').trim();
  if (!raw) return;
  if (_ltSession.mode === 'broadcast') {
    // 公放：逐行解析"名字：内容"，名字用 AI 给的
    raw.split('\n').forEach(line => {
      const t = line.trim();
      if (!t) return;
      const idx = t.search(/[:：]/);
      if (idx > 0) {
        const nm = t.slice(0, idx).trim();
        const ct = t.slice(idx + 1).trim();
        if (nm && ct) _ltAddMessage(nm, ct);
      } else {
        // 没写名字，整行当内容，名字标"在场"
        _ltAddMessage('在场', t);
      }
    });
  } else {
    // 耳机共享/线上：名字固定跟对象走
    const nm = (_ltSession.target && _ltSession.target.name) || '对方';
    await _ltAddMessage(nm, raw);
  }
}

// 供 chat.js 调用：获取「进行中」提示词（active 状态、线下、有在播歌时返回）
function _ltGetActivePrompt() {
  _ltEnsureSession();
  if (!_ltSession || !_ltSession.active) return '';
  // 线上模式的进行中信息走聊天通道，不注入主线
  if (_ltSession.mode === 'online') return '';
  return _ltBuildNowPlayingPrompt();
}

// 供 chat.js 调用：获取待发送的邀请提示词（pending 状态时返回内容，否则空）
function _ltGetPendingPrompt() {
  _ltEnsureSession();
  if (!_ltSession || !_ltSession.pending || !_ltSession.invitePrompt) return '';
  return _ltSession.invitePrompt;
}

// 供 chat.js 调用：处理 AI 回复中的 listen_together 标记
async function _ltHandleAccept(data) {
  if (!_ltSession || !_ltSession.pending) return;
  if (data && data.accept) {
    // 接受邀请 → 激活
    await _ltActivate({ mode: _ltSession.mode, target: _ltSession.target });
  } else {
    // 拒绝
    _ltSession.pending = false;
    _ltSession.rejected = true;
    _ltSession.rejectReason = (data && data.reason) || '';
    _ltSession.invitePrompt = ''; // 不再重复发邀请
    await _persistLtSession();
    // 刷新一起听页面（如果用户正在看）
    const titleEl = document.getElementById('phone-title');
    if (titleEl && titleEl.textContent === '一起听') {
      const t = Music.getCurrentTrack();
      if (t) _renderListenTogether(t, _ltUserAvatar, _ltUserName);
    }
  }
}

// 详情页播放列表弹窗
function _musicListPopup(currentDetailId) {
  const tracks = Music.getTracks();
  const curId = Music.getCurrentId();
  const rows = tracks.map(t => {
    const active = t.id === curId;
    const cls = active ? 'phone-mlist-popup-row active' : 'phone-mlist-popup-row';
    return `<div class="${cls}" data-id="${t.id}">
      <span class="phone-mlist-popup-title">${Utils.escapeHtml(t.title || '未命名')}</span>
      <span class="phone-mlist-popup-artist">${Utils.escapeHtml(t.artist || '')}</span>
    </div>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'phone-music-sheet-overlay';
  overlay.innerHTML = `
    <div class="phone-mlist-popup">
      <div class="phone-mlist-popup-header">播放列表 · ${tracks.length} 首</div>
      <div class="phone-mlist-popup-list">${rows}</div>
      <button class="phone-music-sheet-btn cancel" data-act="close">关闭</button>
    </div>`;

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { close(); return; }
    if (e.target.closest('[data-act="close"]')) { close(); return; }
    const row = e.target.closest('.phone-mlist-popup-row');
    if (row) {
      const id = row.dataset.id;
      close();
      Music.play(id);
      // 根据当前页面决定刷新目标
      const titleEl = document.getElementById('phone-title');
      if (titleEl && titleEl.textContent === '一起听') {
        setTimeout(() => Phone._refreshListenTogether(), 150);
      } else {
        setTimeout(() => Phone._renderMusicDetail(id), 150);
      }
    }
  });

  const host = document.getElementById('phone-modal') || document.body;
  host.appendChild(overlay);
  // 滚动到当前播放的歌
  const activeEl = overlay.querySelector('.phone-mlist-popup-row.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'center' });
}

// 添加歌曲菜单（右上角 + 按钮）
async function _musicAddMenu() {
  const choice = await _musicSheet('添加歌曲', [
    { label: '上传本地音频', value: 'file' },
    { label: '添加链接', value: 'url' }
  ]);
  if (choice === 'file') _addMusicFile();
  else if (choice === 'url') _addMusicUrl();
}

// 上传本地音频
function _addMusicFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.style.display = 'none';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) { input.remove(); return; }
    const defName = file.name.replace(/\.[^.]+$/, '');
    const res = await _musicForm('添加本地音乐', [
      { key: 'title', label: '歌曲名', value: defName },
      { key: 'artist', label: '歌手（可留空）', value: '' }
    ]);
    if (!res) { input.remove(); return; }
    try {
      const rec = await Music.addLocalTrack({ title: res.title || defName || '未命名', artist: res.artist, file });
      try { GameLog.log('info', `[Music] 本地添加成功 id=${rec && rec.id} size=${file.size} type=${file.type}`); } catch(_) {}
      UI.showToast('已添加', 1200);
      _renderMusicLibrary();
      _refreshMusicCard();
    } catch (e) {
      try { GameLog.log('error', `[Music] 本地添加失败: ${e.message || e}`); } catch(_) {}
      UI.showToast('添加失败：' + (e.message || e), 2500);
    }
    input.remove();
  };
  document.body.appendChild(input);
  input.click();
}

// 添加外链
async function _addMusicUrl() {
  const res = await _musicForm('添加链接音乐', [
    { key: 'url', label: '音频链接（网易云分享链接含id / 数字ID / 音频直链）', value: '', textarea: true },
    { key: 'title', label: '歌曲名', value: '' },
    { key: 'artist', label: '歌手（可留空）', value: '' }
  ]);
  if (!res) return;
  const url = (res.url || '').trim();
  if (!url) { UI.showToast('请填写链接', 1800); return; }
  if (Music._isNeteaseShortLink(url)) {
    UI.showToast('网易云短链无法直接用，请在浏览器打开它，复制跳转后带 id= 的完整链接，或直接填歌曲数字 ID', 4500);
    return;
  }
  if (!Music._resolveExternalUrl(url)) {
    UI.showToast('无法识别：需网易云分享链接（含id）或音频直链', 3000);
    return;
  }
  try {
    await Music.addExternalTrack({ title: res.title || '未命名', artist: res.artist, url });
    UI.showToast('已添加', 1200);
    _renderMusicLibrary();
    _refreshMusicCard();
  } catch (e) {
    UI.showToast('添加失败：' + (e.message || e), 2500);
  }
}

// 自建多字段表单弹层（避免连续弹 showSimpleInput 的竞态）
// fields: [{key, label, value, textarea}]  返回 {key: value, ...} 或 null（取消）
function _musicForm(title, fields) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'phone-music-sheet-overlay';
    const rows = fields.map((f, i) => {
      const ctrl = f.textarea
        ? `<textarea class="phone-music-form-input" data-key="${f.key}" rows="2">${Utils.escapeHtml(f.value || '')}</textarea>`
        : `<input class="phone-music-form-input" data-key="${f.key}" type="text" value="${Utils.escapeHtml(f.value || '')}">`;
      return `<div class="phone-music-form-field">
        <div class="phone-music-form-label">${Utils.escapeHtml(f.label)}</div>
        ${ctrl}
      </div>`;
    }).join('');
    overlay.innerHTML = `
      <div class="phone-music-sheet phone-music-form">
        <div class="phone-music-sheet-title">${Utils.escapeHtml(title || '')}</div>
        ${rows}
        <div class="phone-music-form-btns">
          <button class="phone-music-sheet-btn cancel" data-act="cancel">取消</button>
          <button class="phone-music-sheet-btn confirm" data-act="ok">确定</button>
        </div>
      </div>`;
    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { close(null); return; }
      const b = e.target.closest('.phone-music-sheet-btn');
      if (!b) return;
      if (b.dataset.act === 'cancel') { close(null); return; }
      if (b.dataset.act === 'ok') {
        const out = {};
        overlay.querySelectorAll('.phone-music-form-input').forEach(el => {
          out[el.dataset.key] = el.value.trim();
        });
        close(out);
      }
    });
    const host = document.getElementById('phone-modal') || document.body;
    host.appendChild(overlay);
    const first = overlay.querySelector('.phone-music-form-input');
    if (first) setTimeout(() => first.focus(), 50);
  });
}

// 轻量底部选项弹层（项目无现成 actionSheet，这里自建）
function _musicSheet(title, options) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'phone-music-sheet-overlay';
    const btns = options.map((o, i) =>
      `<button class="phone-music-sheet-btn ${o.danger ? 'danger' : ''}" data-i="${i}">${o.html ? o.label : Utils.escapeHtml(o.label)}</button>`
    ).join('');
    overlay.innerHTML = `
      <div class="phone-music-sheet">
        <div class="phone-music-sheet-title">${Utils.escapeHtml(title || '')}</div>
        ${btns}
        <button class="phone-music-sheet-btn cancel" data-i="-1">取消</button>
      </div>`;
    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { close(null); return; }
      const b = e.target.closest('.phone-music-sheet-btn');
      if (!b) return;
      const idx = parseInt(b.dataset.i, 10);
      close(idx < 0 ? null : options[idx].value);
    });
    // 挂到手机外壳内，跟随手机层级
    const host = document.getElementById('phone-modal') || document.body;
    host.appendChild(overlay);
  });
}

// 编辑曲目菜单
async function _editMusicTrack(id) {
  const t = Music.getTracks().find(x => x.id === id);
  if (!t) return;
  const choice = await _musicSheet(t.title || '未命名', [
    { label: '编辑歌曲信息', value: 'info' },
    { label: '添加/编辑歌词', value: 'lrc' },
    { label: '设置封面', value: 'cover' },
    { label: '删除', value: 'del', danger: true }
  ]);
  if (!choice) return;
  if (choice === 'del') {
    const ok = await UI.showConfirm('删除歌曲', `确定删除《${t.title || '未命名'}》？`);
    if (!ok) return;
    await Music.removeTrack(id);
    UI.showToast('已删除', 1200);
    _renderMusicLibrary();
    _refreshMusicCard();
    Phone.goBack();
    return;
  }
  if (choice === 'info') {
    const res = await _musicForm('编辑歌曲信息', [
      { key: 'title', label: '歌曲名', value: t.title || '' },
      { key: 'artist', label: '歌手', value: t.artist || '' },
      { key: 'desc', label: '歌曲描述（告诉AI这是怎样的一首歌，什么风格和感受等）', value: t.desc || '', textarea: true }
    ]);
    if (!res) return;
    await Music.updateTrack(id, { title: res.title || t.title, artist: res.artist, desc: res.desc || '' });
    UI.showToast('已保存', 1200);
    _renderMusicDetail(id);
    _refreshMusicCard();
    return;
  }
  if (choice === 'lrc') {
    const sub = await _musicSheet('添加歌词', [
      { label: '粘贴歌词文本', value: 'paste' },
      { label: '上传 LRC 文件', value: 'file' },
      { label: '清除歌词', value: 'clear' }
    ]);
    if (!sub) return;
    if (sub === 'clear') {
      await Music.updateTrack(id, { lrc: '' });
      UI.showToast('歌词已清除', 1200);
      _renderMusicDetail(id);
      return;
    }
    if (sub === 'paste') {
      const lrc = await UI.showSimpleInput('粘贴歌词（LRC 或纯文本）', t.lrc || '', { multiline: true, rows: 8, allowEmpty: true });
      if (lrc === null) return;
      await Music.updateTrack(id, { lrc });
      UI.showToast('歌词已保存', 1200);
      _renderMusicDetail(id);
      return;
    }
    if (sub === 'file') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.lrc,.txt,text/plain';
      input.style.display = 'none';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) { input.remove(); return; }
        try {
          const text = await file.text();
          await Music.updateTrack(id, { lrc: text });
          UI.showToast('歌词已导入', 1200);
          _renderMusicDetail(id);
        } catch (e) {
          UI.showToast('导入失败：' + (e.message || e), 2500);
        }
        input.remove();
      };
      document.body.appendChild(input);
      input.click();
      return;
    }
    return;
  }
  if (choice === 'cover') {
    await _editMusicCover(id);
    _renderMusicDetail(id);
    return;
  }
}

// 封面编辑：支持 URL 或本地上传图片（转 base64 dataURL 存储）
async function _editMusicCover(id) {
  const sub = await _musicSheet('设置封面', [
    { label: '输入图片链接', value: 'url' },
    { label: '从相册上传', value: 'upload' },
    { label: '清除封面', value: 'clear' }
  ]);
  if (!sub) return;
  if (sub === 'clear') {
    await Music.updateTrack(id, { coverUrl: '' });
    UI.showToast('封面已清除', 1200);
    _renderMusicDetail(id);
    _refreshMusicCard();
    return;
  }
  if (sub === 'url') {
    const url = await UI.showSimpleInput('封面图片链接', '', { allowEmpty: true });
    if (url === null) return;
    await Music.updateTrack(id, { coverUrl: url });
    UI.showToast('封面已保存', 1200);
    _renderMusicDetail(id);
    _refreshMusicCard();
    return;
  }
  if (sub === 'upload') {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) { input.remove(); return; }
      try {
        const reader = new FileReader();
        const dataUrl = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        await Music.updateTrack(id, { coverUrl: dataUrl });
        UI.showToast('封面已保存', 1200);
        _renderMusicDetail(id);
        _refreshMusicCard();
      } catch (e) {
        UI.showToast('上传失败：' + (e.message || e), 2500);
      }
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  }
}

async function _openAnniversaryEditor() {
  const pd = await _getPhoneData();
  if (!pd) return;
  const anni = pd.anniversary || {};
  const mask = document.createElement('div');
  mask.className = 'phone-cal-modal-mask';
  mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:flex-end;justify-content:center';
  mask.onclick = e => { if (e.target === mask) mask.remove(); };
  mask.innerHTML = `
    <div style="background:var(--bg);border-radius:20px 20px 0 0;width:100%;max-width:400px;padding:20px 20px 28px;max-height:80vh;overflow-y:auto">
      <div style="width:36px;height:4px;background:var(--border);border-radius:2px;margin:0 auto 16px"></div>
      <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:16px">设置纪念日</div>

      <label style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;font-size:12px;color:var(--text-secondary)">标题
        <input type="text" id="anni-title" value="${Utils.escapeHtml(anni.title || '')}" placeholder="如：在一起" maxlength="20"
          style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);color:var(--text);font-size:13px">
      </label>

      <div style="display:flex;gap:10px;margin-bottom:12px">
        <label style="flex:1;display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)">年
          <input type="number" id="anni-year" value="${anni.year || ''}" placeholder="可选"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);color:var(--text);font-size:13px">
        </label>
        <label style="flex:1;display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)">月
          <input type="number" id="anni-month" value="${anni.month || ''}" min="1" max="99" placeholder="必填"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);color:var(--text);font-size:13px">
        </label>
        <label style="flex:1;display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary)">日
          <input type="number" id="anni-day" value="${anni.day || ''}" min="1" max="999" placeholder="必填"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);color:var(--text);font-size:13px">
        </label>
      </div>

      <div style="margin-bottom:16px">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">背景图片</div>
        <div style="display:flex;gap:8px;align-items:center">
          <div id="anni-img-preview" style="width:60px;height:60px;border-radius:10px;border:1px solid var(--border);background:var(--bg-tertiary);background-size:cover;background-position:center;${anni.image ? `background-image:url('${anni.image}')` : ''}"></div>
          <button type="button" onclick="Phone._anniPickImage()" style="padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text);font-size:12px;cursor:pointer">选择图片</button>
          <button type="button" onclick="document.getElementById('anni-img-preview').style.backgroundImage='';Phone._anniTempImage=''" style="padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text-secondary);font-size:12px;cursor:pointer">清除</button>
        </div>
      </div>

      <div style="display:flex;gap:8px">
        <button type="button" onclick="Phone._anniSave()" style="flex:1;padding:10px;border:none;border-radius:10px;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">保存</button>
        <button type="button" onclick="Phone._anniDelete()" style="padding:10px 16px;border:1px solid var(--border);border-radius:10px;background:none;color:var(--text-secondary);font-size:13px;cursor:pointer">删除</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  _anniTempImage = anni.image || '';
}

let _anniTempImage = '';

function _anniPickImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      _anniTempImage = reader.result;
      const prev = document.getElementById('anni-img-preview');
      if (prev) prev.style.backgroundImage = `url("${reader.result}")`;
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

async function _anniSave() {
  const month = parseInt(document.getElementById('anni-month')?.value, 10);
  const day = parseInt(document.getElementById('anni-day')?.value, 10);
  if (!month || !day) { UI.showToast('请填写月和日', 1500); return; }
  const title = document.getElementById('anni-title')?.value?.trim() || '';
  const yearVal = document.getElementById('anni-year')?.value?.trim();
  const year = yearVal ? parseInt(yearVal, 10) : 0;

  const pd = await _getPhoneData();
  if (!pd) return;
  pd.anniversary = { title, year, month, day, image: _anniTempImage || '' };

  // 同步到日历事项（type: holiday, repeat: yearly）
  pd.calendarEvents = pd.calendarEvents || [];
  // 先清掉旧的纪念日同步项
  pd.calendarEvents = pd.calendarEvents.filter(ev => ev.id !== 'anni-sync');
  pd.calendarEvents.push({
    id: 'anni-sync',
    title: title || '纪念日',
    type: 'holiday',
    color: '#f4a261',
    note: '',
    year: 0,
    month: month,
    day: day,
    repeat: 'yearly',
    duration: 1
  });

  await _savePhoneData();
  document.querySelector('.phone-cal-modal-mask')?.remove();
  _refreshAnniversaryCard();
  UI.showToast('纪念日已保存', 1200);
}

async function _anniDelete() {
  const pd = await _getPhoneData();
  if (!pd) return;
  delete pd.anniversary;
  // 清掉日历里的纪念日同步项
  pd.calendarEvents = (pd.calendarEvents || []).filter(ev => ev.id !== 'anni-sync');
  await _savePhoneData();
  document.querySelector('.phone-cal-modal-mask')?.remove();
  _refreshAnniversaryCard();
  UI.showToast('纪念日已删除', 1200);
}

// ===== 日历 Banner（第二页横条卡片）=====
// 历法规则缓存（在打开日历APP时异步刷新，Banner同步读）
let _calRulesCache = null;

async function _refreshCalRulesCache() {
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (conv?.convGameplay?.calendarSystem) { _calRulesCache = conv.convGameplay.calendarSystem; return; }
    const wvId = conv?.worldviewId || conv?.singleWorldviewId;
    if (wvId) {
      const wv = await DB.get('worldviews', wvId);
      if (wv?.gameplay?.calendarSystem) { _calRulesCache = wv.gameplay.calendarSystem; return; }
    }
    _calRulesCache = null;
  } catch(_) { _calRulesCache = null; }
}

function _getCalRulesCached() {
  return (typeof Calendar !== 'undefined') ? Calendar.getRules(_calRulesCache) : null;
}

function _refreshCalBanner() {
  const el = document.getElementById('phone-cal-banner');
  if (!el) return;
  try {
    const sb = Conversations.getStatusBar() || {};
    const timeStr = sb.time || '';
    if (!timeStr) { el.style.display = 'none'; return; }

    // 解析当前游戏时间
    const rules = _getCalRulesCached();
    const parsed = (typeof Calendar !== 'undefined') ? Calendar.parseAbsoluteTime(timeStr) : null;

    // 时间显示
    const clockMatch = timeStr.match(/(\d{1,2}:\d{2})/);
    const clock = clockMatch ? clockMatch[1] : '--:--';
    const datePart = timeStr.replace(/\s*\d{1,2}:\d{2}\s*/, ' ').trim();

    // 季节
    let seasonName = sb.season || '';
    if (!seasonName && parsed && rules) {
      const s = Calendar.getSeason(parsed.month, rules);
      if (s) seasonName = s.name;
    }

    // 天气
    const weather = sb.weather || '';

    // 下一个事件倒计时
    let countdownHtml = '';
    try {
      const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
      const pd = conv?.phoneData;
      const events = [...(pd?.calendarEvents || []), ..._getWvFestivalsAsEvents()];
      if (parsed && events.length) {
        // 找最近的未来事件
        let nearest = null, minDiff = Infinity;
        for (const ev of events) {
          // 计算到事件的天数差
          const evYear = ev.year || parsed.year;
          let diff = 0;
          if (rules && typeof Calendar !== 'undefined') {
            const evTime = { year: evYear, month: ev.month, day: ev.day, hour: 0, minute: 0 };
            const curEpoch = Calendar._daysSinceEpoch(parsed, rules);
            const evEpoch = Calendar._daysSinceEpoch(evTime, rules);
            diff = evEpoch - curEpoch;
          } else {
            const curD = new Date(parsed.year, parsed.month-1, parsed.day);
            const evD = new Date(evYear, ev.month-1, ev.day);
            diff = Math.round((evD - curD) / 86400000);
          }
          // 年重复事件：如果今年已过，看明年
          if (ev.repeat === 'yearly' && diff < 0) {
            const nextYear = { year: parsed.year + 1, month: ev.month, day: ev.day, hour: 0, minute: 0 };
            if (rules && typeof Calendar !== 'undefined') {
              diff = Calendar._daysSinceEpoch(nextYear, rules) - Calendar._daysSinceEpoch(parsed, rules);
            } else {
              const evD2 = new Date(parsed.year + 1, ev.month - 1, ev.day);
              diff = Math.round((evD2 - new Date(parsed.year, parsed.month-1, parsed.day)) / 86400000);
            }
          }
          if (diff >= 0 && diff < minDiff) { minDiff = diff; nearest = ev; }
        }
        if (nearest) {
          const label = minDiff === 0 ? '今天' : minDiff === 1 ? '明天' : `还有 ${minDiff} 天`;
          const dot = nearest.color ? `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${nearest.color};margin-right:4px;vertical-align:middle"></span>` : '';
          const titleTrunc = nearest.title.length > 10 ? nearest.title.slice(0, 10) + '…' : nearest.title;
          countdownHtml = `<div class="phone-cal-banner-countdown">${dot}${Utils.escapeHtml(titleTrunc)} · ${label}</div>`;
        } else {
          countdownHtml = `<div class="phone-cal-banner-countdown" style="opacity:0.5">当前还没有日程</div>`;
        }
      }
    } catch(_) {}
    if (!countdownHtml) countdownHtml = `<div class="phone-cal-banner-countdown" style="opacity:0.5">当前还没有日程</div>`;

    el.style.display = '';
    el.innerHTML = `
      <div class="phone-cal-banner-main">
        <div class="phone-cal-banner-left">
          <div class="phone-cal-banner-clock">${Utils.escapeHtml(clock)}</div>
          <div class="phone-cal-banner-date">${Utils.escapeHtml(datePart)}</div>
        </div>
        <div class="phone-cal-banner-right">
          ${seasonName ? `<span class="phone-cal-banner-tag">${Utils.escapeHtml(seasonName)}</span>` : ''}
          ${weather ? `<span class="phone-cal-banner-tag">${Utils.escapeHtml(weather)}</span>` : ''}
        </div>
      </div>
      ${countdownHtml}
    `;
  } catch(_) { el.style.display = 'none'; }
}

// ===== 电台 App =====
  // 默认预设分类（首次打开时写入 phoneData）
  // 分类决定整体基调和播出时间；台/节目在后续步骤生成
  const _RADIO_DEFAULT_CATEGORIES = [
    { id: 'news',    name: '晚间新闻', icon: 'news',    airStart: '18:30', airEnd: '21:00', allDay: false, desc: '时政、社会与本地动态。可生成国家级、地方级，乃至街头巷尾的社区级电台，方向多样。', isDefault: true },
    { id: 'emotion', name: '深夜情感', icon: 'emotion', airStart: '22:00', airEnd: '02:00', allDay: false, desc: '听众来信、情感倾诉与深夜陪伴。可生成治愈系、夜话系、犀利点评系等不同风格的台。', isDefault: true },
    { id: 'ghost',   name: '都市怪谈', icon: 'ghost',   airStart: '21:00', airEnd: '04:00', allDay: false, desc: '灵异志怪、都市传说与悬疑故事。可生成单元短篇、听众投稿、实地探访等方向。', isDefault: true },
    { id: 'chat',    name: '闲聊电台', icon: 'talk',    airStart: '', airEnd: '', allDay: true,  desc: '杂谈、吐槽与生活碎碎念。可生成脱口秀、播客闲聊、深夜碎语等各种轻松风格。', isDefault: true },
    { id: 'music',   name: '音乐漫谈', icon: 'music',   airStart: '', airEnd: '', allDay: true,  desc: '音乐推荐与歌曲背后的故事。可生成怀旧金曲、独立音乐、主题歌单等方向。', isDefault: true },
  ];

  // ===== 标签池（按分类隔离）=====
  // 每个标签是「写作指导 guide + 数据源 dataSource + 互动倾向 interactHint」三件套。
  // - name/desc：预览阶段喂给 AI（让它判断某个台该挂哪个标签）
  // - guide：详情阶段喂给 AI（怎么写这档节目，逐个精写，留空表示走通用写法）
  // - dataSource：详情阶段按此注入额外数据（'' = 无额外数据，纯生成）
  // - interactHint：互动倾向 none/vote/request/lottery/call
  const _RADIO_TAGS = {
    news: [
      { name: '时政要闻', desc: '国家大事、政策、经济、国际、灾害、领导人动向、国家级文化活动、反腐反黑', guide: `你正在生成「时政要闻」类电台节目。这是一档严肃正经的新闻播报，主播口吻沉稳、客观、字正腔圆，像正式的晚间新闻联播。

内容方向（任选其一或组合，符合当前世界观）：
- 政策法规变动、经济数据与发展动态
- 国际关系、外交动向、国际局势
- 重大灾害事故及救援、应急通报
- 重要人物（领导人、重要官员）的公开动向与讲话
- 国家级文化/体育大型活动（类比春晚、奥运会级别）
- 反腐倡廉、扫黑除恶等专项行动通报

写法要求：
- 用"播报"语气，不是闲聊。每条新闻简明扼要，可分条播报多则。
- 信息要具体：给出地点、机构、数字、时间等细节，营造真实感。
- 紧扣当前世界观设定：现代都市就是现实新闻质感，古风世界就是朝堂邸报/告示，赛博世界就是全息政务播报，自动适配。
- 不编造与主线角色相关的剧情新闻，除非世界观/剧情明确支持。
- 保持中立客观，不带主播个人情绪和吐槽。
- 生成 3-4 条，每条新闻 400-500 字
- 时长：30 分钟左右`, dataSource: '', interactHint: 'none' },
      { name: '地方快报', desc: '地方案件、本地政策、本地文娱、科教', guide: '', dataSource: 'region', interactHint: '' },
      { name: '社区简讯', desc: '街坊邻里、街头斗殴、家庭伦理、交通事故、社区通知', guide: '', dataSource: '', interactHint: '' },
      { name: '领域专线', desc: '垂直圈子新闻（学术/二次元/时尚/科技等）、技术、圈内八卦、派系论战', guide: '', dataSource: '', interactHint: '' },
      { name: '娱乐头条', desc: '明星网红八卦、狗仔爆料、粉圈吃瓜、影视进度、趣味新闻', guide: '', dataSource: '', interactHint: '' },
    ],
    emotion: [
      { name: '深夜来信', desc: '读听众来信、情感倾诉，主播温柔回应陪伴', guide: '', dataSource: '', interactHint: '' },
      { name: '连线夜话', desc: '与听众电话连线，倾听并对话，互动感强', guide: '', dataSource: '', interactHint: 'call' },
      { name: '狗血剧场', desc: '离奇情感纠葛、出轨劈腿、伦理大瓜，戏剧张力拉满', guide: '', dataSource: '', interactHint: '' },
      { name: '犀利锐评', desc: '主播一针见血点评情感问题，毒舌不留情', guide: '', dataSource: '', interactHint: '' },
      { name: '情感咨询', desc: '专业向情感答疑，给方法和建议', guide: '', dataSource: '', interactHint: '' },
      { name: '关系树洞', desc: '匿名倾诉树洞，不评判只倾听', guide: '', dataSource: '', interactHint: '' },
      { name: '成长电波', desc: '自我成长、治愈疗愈、温暖向上', guide: '', dataSource: '', interactHint: '' },
    ],
    ghost: [
      { name: '今夜鬼话', desc: '单元短篇灵异故事，一期一个', guide: '', dataSource: '', interactHint: '' },
      { name: '长夜连载', desc: '长篇怪谈连载，分集播出，留悬念', guide: '', dataSource: '', interactHint: '' },
      { name: '诡异夜话', desc: '主播闲谈式讲述怪事，氛围渗人', guide: '', dataSource: '', interactHint: '' },
      { name: '怪谈解密', desc: '拆解都市传说背后的真相/科学解释', guide: '', dataSource: '', interactHint: '' },
      { name: '悬案重启', desc: '重提悬而未决的案件/失踪/灵异事件', guide: '', dataSource: '', interactHint: '' },
      { name: '志怪录', desc: '古风志怪、山野奇谈、聊斋式故事', guide: '', dataSource: '', interactHint: '' },
      { name: '现场探险', desc: '实地探访凶宅/废墟/禁地的纪实', guide: '', dataSource: '', interactHint: '' },
      { name: '玄占阁', desc: '占卜、风水、玄学、塔罗等神秘话题', guide: '', dataSource: '', interactHint: '' },
    ],
    chat: [
      { name: '欢乐脱口秀', desc: '段子、吐槽、抖包袱，纯逗乐', guide: '', dataSource: '', interactHint: '' },
      { name: '热点圆桌', desc: '聊近期热点话题，多人讨论', guide: '', dataSource: 'forum', interactHint: '' },
      { name: '路况电台', desc: '播报天气、路况、出行提醒，贴合当下', guide: '', dataSource: 'status', interactHint: '' },
      { name: '领域杂谈', desc: '某个兴趣领域的轻松闲聊（游戏/影视/数码等）', guide: '', dataSource: '', interactHint: '' },
      { name: '生活吐槽', desc: '打工人日常、生活槽点、社会现象吐槽', guide: '', dataSource: '', interactHint: '' },
      { name: '连麦电波', desc: '与听众连麦闲聊，互动陪伴', guide: '', dataSource: '', interactHint: 'call' },
    ],
    music: [
      { name: '随心点播', desc: '听众点歌+主播播放，随机歌单', guide: '', dataSource: 'playlist', interactHint: 'request' },
      { name: '原声专题', desc: '影视/游戏原声带专题，配故事背景', guide: '', dataSource: '', interactHint: '' },
      { name: '音乐人志', desc: '聊某个音乐人/乐队的故事与作品', guide: '', dataSource: '', interactHint: '' },
      { name: '类别专栏', desc: '某音乐类别专题（摇滚/民谣等），推歌+讨论', guide: '', dataSource: '', interactHint: '' },
      { name: '乐评现场', desc: '乐迷推歌+专业/主观双视角点评，通常两人配合', guide: '', dataSource: '', interactHint: '' },
    ],
  };

  // 取某分类的标签池（预设分类返回 _RADIO_TAGS，自定义分类暂无标签）
  function _radioTagsOf(catId) { return _RADIO_TAGS[catId] || []; }

  // 生成一批互不重复的 FM 频率（87.0–108.0，保留一位小数）
  function _radioGenFmList(n) {
    const set = new Set();
    let guard = 0;
    while (set.size < n && guard < 2000) {
      guard++;
      const v = (Math.round((87 + Math.random() * 21) * 10) / 10).toFixed(1);
      set.add(v);
    }
    return Array.from(set);
  }

  // 圆点指示器：当前 idx 高亮。台数 >9 时用滑动窗口，两端用缩小点表示还有更多
  function _radioDotsHtml(idx, total) {
    if (!total || total <= 1) return '';
    const MAX = 9;
    let dots = [];
    if (total <= MAX) {
      for (let i = 0; i < total; i++) dots.push(i);
    } else {
      // 当前点居中的窗口
      let start = Math.max(0, Math.min(idx - Math.floor(MAX / 2), total - MAX));
      for (let i = start; i < start + MAX; i++) dots.push(i);
    }
    return dots.map(i => {
      let cls = 'phone-radio-dot';
      if (i === idx) cls += ' active';
      // 窗口边缘且不是真正的首尾时，缩小表示还有更多
      const isEdge = total > MAX && ((i === dots[0] && i !== 0) || (i === dots[dots.length - 1] && i !== total - 1));
      if (isEdge) cls += ' edge';
      return `<span class="${cls}"></span>`;
    }).join('');
  }

  // 可供自定义分类选择的图标清单
  const _RADIO_ICON_CHOICES = ['news','emotion','ghost','talk','music','mic','star','book','tower','clock','heart','coffee'];

  // 分类圆形图标的 SVG（白色描边）
  function _radioChannelSvg(icon) {
    const common = 'viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    const map = {
      news:    `<svg ${common}><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/></svg>`,
      emotion: `<svg ${common}><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/></svg>`,
      ghost:   `<svg ${common}><path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg>`,
      talk:    `<svg ${common}><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>`,
      music:   `<svg ${common}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
      mic:     `<svg ${common}><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
      star:    `<svg ${common}><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
      book:    `<svg ${common}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
      tower:   `<svg ${common}><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><circle cx="12" cy="12" r="2"/><path d="M12 14v8"/></svg>`,
      clock:   `<svg ${common}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
      heart:   `<svg ${common}><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/></svg>`,
      coffee:  `<svg ${common}><path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h12z"/><path d="M16 8h2a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-2"/></svg>`,
      random:  `<svg ${common}><path d="M18 4l3 3-3 3"/><path d="M18 20l3-3-3-3"/><path d="M3 7h3a5 5 0 0 1 5 5 5 5 0 0 0 5 5h5"/><path d="M3 17h3a5 5 0 0 0 5-5"/></svg>`,
    };
    return map[icon] || map.mic;
  }

  // 播出时间的可读文案
  function _radioAirTimeText(cat) {
    if (!cat || cat.allDay || (!cat.airStart && !cat.airEnd)) return '全天播出';
    return `${cat.airStart || '00:00'} - ${cat.airEnd || '24:00'} 播出`;
  }

  // 确保分类已初始化
  function _ensureRadioCategories(pd) {
    if (!Array.isArray(pd.radioCategories)) {
      pd.radioCategories = _RADIO_DEFAULT_CATEGORIES.map(c => ({ ...c }));
    }
    if (!pd.radioPrograms || typeof pd.radioPrograms !== 'object') pd.radioPrograms = {};
    return pd;
  }

  // 电台首页：两列分类卡片网格
  async function _renderRadio(pd) {
    const body = document.getElementById('phone-body');
    document.getElementById('phone-title').textContent = '电台';
    _applyWallpaper(pd);
    _ensureRadioCategories(pd);

    const cats = pd.radioCategories || [];
    const cards = cats.map(cat => `
      <div class="phone-radio-card" onclick="Phone._radioOpenCategory('${Utils.escapeHtml(cat.id)}')">
        <div class="phone-radio-card-icon">${_radioChannelSvg(cat.icon)}</div>
        <div class="phone-radio-card-name">${Utils.escapeHtml(cat.name)}</div>
        <div class="phone-radio-card-desc">${Utils.escapeHtml(_radioAirTimeText(cat))}</div>
      </div>`).join('');

    // 随机卡 + 添加分类卡
    const randomCard = `
      <div class="phone-radio-card" onclick="Phone._radioOpenRandom()">
        <div class="phone-radio-card-icon">${_radioChannelSvg('random')}</div>
        <div class="phone-radio-card-name">随机频道</div>
        <div class="phone-radio-card-desc">随便听听，今晚有什么</div>
      </div>`;
    const addCard = `
      <div class="phone-radio-card phone-radio-card-add" onclick="Phone._radioAddCategory()">
        <div class="phone-radio-card-icon phone-radio-card-icon-add">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </div>
        <div class="phone-radio-card-name">添加分类</div>
        <div class="phone-radio-card-desc">自定义一个新类别</div>
      </div>`;

    body.innerHTML = `
      <div class="phone-radio-home">
        <div class="phone-radio-grid">
          ${cards}
          ${randomCard}
          ${addCard}
        </div>
      </div>`;
  }

  // 打开某个分类（节目单页）
  async function _radioOpenCategory(catId) {
    const pd = await _getPhoneData();
    _ensureRadioCategories(pd);
    const cat = (pd.radioCategories || []).find(c => c.id === catId);
    if (!cat) { UI.showToast('分类不存在', 1500); return; }
    _pushNav(() => _renderRadioCategory(pd, catId));
    _renderRadioCategory(pd, catId);
  }

  async function _radioOpenRandom() {
    const pd = await _getPhoneData();
    _ensureRadioCategories(pd);
    const list = pd.radioCategories || [];
    if (!list.length) { UI.showToast('还没有分类', 1500); return; }
    const cat = list[Math.floor(Math.random() * list.length)];
    _radioOpenCategory(cat.id);
  }

  // 分类节目单页
  function _renderRadioCategory(pd, catId) {
    const body = document.getElementById('phone-body');
    const cat = (pd.radioCategories || []).find(c => c.id === catId);
    if (!cat) return;
    document.getElementById('phone-title').textContent = cat.name;

    // 标题栏右上角：自定义分类可编辑
    const hr = document.getElementById('phone-header-right');
    if (hr) {
      hr.innerHTML = cat.isDefault ? '' : `<span onclick="Phone._radioEditCategory('${Utils.escapeHtml(cat.id)}')" style="cursor:pointer;color:var(--text-secondary)" title="编辑分类">${_uiIcon('edit', 18)}</span>`;
    }

    const programs = (pd.radioPrograms && pd.radioPrograms[catId]) || [];

    if (programs.length === 0) {
      // 空状态：麦克风灯灭 + 刷新
      body.innerHTML = `
        <div class="phone-radio-empty">
          <div class="phone-radio-tuner" id="phone-radio-tuner">
            <svg class="phone-radio-tuner-ring" viewBox="0 0 120 120" width="220" height="220">
              <defs>
                <linearGradient id="radioTuneGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="var(--accent)"/>
                  <stop offset="100%" stop-color="var(--decoration)"/>
                </linearGradient>
              </defs>
              <circle class="phone-radio-tuner-track" cx="60" cy="60" r="52" fill="none" stroke-width="9"/>
              <circle id="phone-radio-tuner-prog" cx="60" cy="60" r="52" fill="none" stroke="url(#radioTuneGrad)" stroke-width="9" stroke-linecap="round" transform="rotate(-90 60 60)" stroke-dasharray="326.726" stroke-dashoffset="326.726"/>
            </svg>
          </div>
          <div class="phone-radio-tuner-icon" id="phone-radio-tuner-icon">${_radioChannelSvg('mic')}</div>
          <div class="phone-radio-tuner-hint" id="phone-radio-tuner-hint">长按调频</div>
          <div class="phone-radio-empty-desc">${Utils.escapeHtml(_radioAirTimeText(cat))}</div>
        </div>`;
      // 绑定长按蓄力
      _radioBindTuner(catId);
      return;
    }

    // 有节目单：杂志式封面卡片 + 底部播放器控制栏
    let _radioCardIdx = 0;
    const renderCard = (idx) => {
      const p = programs[idx];
      if (!p) return '';
      const tags = (p.tags || []).map(t => `<span class="phone-radio-card-tag">${Utils.escapeHtml(t)}</span>`).join('');
      const guest = p.guest ? ` · 嘉宾 ${Utils.escapeHtml(p.guest)}` : '';
      const fm = p.fm ? `<div class="phone-radio-fm">FM ${Utils.escapeHtml(String(p.fm))}</div>` : '';
      const cover = p.cover
        ? `<img src="${Utils.escapeHtml(p.cover)}" alt="">`
        : '';
      return `
        <div class="phone-radio-prog-card">
          ${fm}
          <div class="phone-radio-cover">${cover}</div>
          <div class="phone-radio-prog-head">
            <div class="phone-radio-prog-name">${Utils.escapeHtml(p.name || '未命名电台')}</div>
            <div class="phone-radio-prog-tags">${tags}</div>
          </div>
          <div class="phone-radio-prog-host">主播 ${Utils.escapeHtml(p.dj || '匿名')}${guest}</div>
        <div class="phone-radio-prog-desc">${Utils.escapeHtml(p.intro || '')}</div>
        ${p.showName ? `<div class="phone-radio-prog-now"><span class="phone-radio-now-tag">正在播</span>${Utils.escapeHtml(p.showName)}</div>` : ''}
      </div>`;
    };

    const hasNext = programs.length > 1;
    body.innerHTML = `
      <div class="phone-radio-deck">
        <div class="phone-radio-stack${hasNext ? ' has-next' : ''}" id="phone-radio-stack">
          ${renderCard(0)}
        </div>
        <div class="phone-radio-dots" id="phone-radio-dots">${_radioDotsHtml(0, programs.length)}</div>
        <button class="phone-radio-retune-btn" id="phone-radio-retune">
          <span class="phone-radio-retune-label">${_uiIcon('refresh', 15)} 重新调频</span>
          <span class="phone-radio-wave phone-radio-wave-inline" style="display:none">
            <span></span><span></span><span></span><span></span><span></span>
          </span>
        </button>
        <div class="phone-radio-ctrl-card">
          <div class="phone-radio-controls">
            <button class="phone-radio-ctrl-btn" id="phone-radio-prev" ${programs.length <= 1 ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button class="phone-radio-play-btn" id="phone-radio-play">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <button class="phone-radio-ctrl-btn" id="phone-radio-next" ${programs.length <= 1 ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>
        <button class="phone-radio-delete-btn" id="phone-radio-delete">
          ${_uiIcon('trash', 15)} 删除此频道
        </button>
      </div>`;

    // 控制栏事件
    const stack = document.getElementById('phone-radio-stack');
    const dots = document.getElementById('phone-radio-dots');
    const prevBtn = document.getElementById('phone-radio-prev');
    const nextBtn = document.getElementById('phone-radio-next');
    const playBtn = document.getElementById('phone-radio-play');
    const retuneBtn = document.getElementById('phone-radio-retune');

    const updateCard = () => {
      if (stack) { stack.innerHTML = renderCard(_radioCardIdx); stack.classList.toggle('has-next', _radioCardIdx < programs.length - 1); }
      if (dots) dots.innerHTML = _radioDotsHtml(_radioCardIdx, programs.length);
    };
    if (prevBtn) prevBtn.onclick = () => { if (_radioCardIdx > 0) { _radioCardIdx--; updateCard(); } };
    if (nextBtn) nextBtn.onclick = () => { if (_radioCardIdx < programs.length - 1) { _radioCardIdx++; updateCard(); } };
    if (playBtn) playBtn.onclick = async () => {
      const p = programs[_radioCardIdx];
      if (!p) return;
      const ok = await UI.showConfirm('开播', `即将收听「${p.name || '电台'}」，确认？`);
      if (ok) _radioOpenDetail(catId, _radioCardIdx);
    };
    if (retuneBtn) retuneBtn.onclick = async () => {
      const ok = await UI.showConfirm('重新调频', '将重新搜索这个分类的电台节目，确认？');
      if (!ok) return;
      // 按钮切换到加载态：文字隐藏，电波动画显示
      retuneBtn.classList.add('loading');
      const label = retuneBtn.querySelector('.phone-radio-retune-label');
      const wave = retuneBtn.querySelector('.phone-radio-wave-inline');
      if (label) label.style.display = 'none';
      if (wave) wave.style.display = 'flex';
      await _radioGenerate(catId);
    };
    const deleteBtn = document.getElementById('phone-radio-delete');
    if (deleteBtn) deleteBtn.onclick = async () => {
      const p = programs[_radioCardIdx];
      if (!p) return;
      const ok = await UI.showConfirm('删除频道', `确定删除「${p.name || '这个频道'}」吗？`);
      if (!ok) return;
      const pd2 = await _getPhoneData();
      const arr = (pd2.radioPrograms && pd2.radioPrograms[catId]) || [];
      arr.splice(_radioCardIdx, 1);
      if (_radioCardIdx >= arr.length) _radioCardIdx = Math.max(0, arr.length - 1);
      await _savePhoneData();
      _renderRadioCategory(pd2, catId);
    };
    // 标题栏右上角：仅自定义分类显示编辑按钮（刷新已移到卡片下方）
    const hr2 = document.getElementById('phone-header-right');
    if (hr2) {
      hr2.innerHTML = cat.isDefault ? '' : `<span onclick="Phone._radioEditCategory('${Utils.escapeHtml(cat.id)}')" style="cursor:pointer;color:var(--text-secondary)" title="编辑分类">${_uiIcon('edit', 18)}</span>`;
    }
  }

  // 长按蓄力调频：1.2s 填满圆环触发刷新，松手回弹
  function _radioBindTuner(catId) {
    const tuner = document.getElementById('phone-radio-tuner');
    const icon = document.getElementById('phone-radio-tuner-icon');
    const prog = document.getElementById('phone-radio-tuner-prog');
    const hint = document.getElementById('phone-radio-tuner-hint');
    if (!tuner || !prog) return;
    const CIRC = 326.726; // 2πr, r=52
    const DURATION = 1200;
    let rafId = null, startTs = 0, holding = false, fired = false;

    const setProgress = (p) => { prog.setAttribute('stroke-dashoffset', String(CIRC * (1 - p))); };

    const tick = (ts) => {
      if (!holding) return;
      if (!startTs) startTs = ts;
      const p = Math.min(1, (ts - startTs) / DURATION);
      setProgress(p);
      if (p >= 1) {
        if (!fired) { fired = true; holding = false; _radioRefresh(catId); }
        return;
      }
      rafId = requestAnimationFrame(tick);
    };

    const start = (e) => {
      if (fired) return;
      e.preventDefault();
      holding = true; startTs = 0;
      tuner.classList.add('holding');
      if (hint) hint.textContent = '调频中…';
      rafId = requestAnimationFrame(tick);
    };
    const cancel = () => {
      if (!holding || fired) return;
      holding = false;
      if (rafId) cancelAnimationFrame(rafId);
      tuner.classList.remove('holding');
      if (hint) hint.textContent = '长按调频';
      // 回弹归零
      prog.style.transition = 'stroke-dashoffset .25s ease';
      setProgress(0);
      setTimeout(() => { if (prog) prog.style.transition = ''; }, 280);
    };

    // 圆环和麦克风按钮都可触发
    [tuner, icon].forEach(el => {
      if (!el) return;
      el.addEventListener('mousedown', start);
      el.addEventListener('touchstart', start, { passive: false });
    });
    document.addEventListener('mouseup', cancel);
    document.addEventListener('touchend', cancel);
    document.addEventListener('touchcancel', cancel);
  }

  // 刷新分类节目单（空状态长按圆环触发）：先做圆环加载态，再生成
  async function _radioRefresh(catId) {
    // 切换到加载态：圆环中心显示电波动画
    const tuner = document.getElementById('phone-radio-tuner');
    if (tuner) {
      tuner.classList.add('loading');
      tuner.innerHTML = `
        <svg class="phone-radio-tuner-ring" viewBox="0 0 120 120" width="220" height="220">
          <defs>
            <linearGradient id="radioTuneGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="var(--accent)"/>
              <stop offset="100%" stop-color="var(--decoration)"/>
            </linearGradient>
          </defs>
          <circle class="phone-radio-tuner-track" cx="60" cy="60" r="52" fill="none" stroke-width="9"/>
          <circle cx="60" cy="60" r="52" fill="none" stroke="url(#radioTuneGrad)" stroke-width="9" stroke-linecap="round" transform="rotate(-90 60 60)" stroke-dasharray="326.726" stroke-dashoffset="0"/>
        </svg>
        <div class="phone-radio-wave">
          <span></span><span></span><span></span><span></span><span></span>
        </div>`;
    }
    const hint = document.getElementById('phone-radio-tuner-hint');
    if (hint) hint.textContent = '正在搜索电波…';
    await _radioGenerate(catId);
  }

  // 构建 NPC 索引：把每个 NPC 的 name/别称(aliases)/网名(onlineName) 所有写法都归一到其 id
  // 返回 { aliasToId: Map(马甲 -> id), idToName: Map(id -> 主名) }
  async function _radioBuildNpcIndex() {
    const aliasToId = new Map();
    const idToName = new Map();
    const splitNames = (s) => String(s || '').split(/[,，、\s]+/).map(t => t.trim()).filter(Boolean);
    const addNpc = (n) => {
      if (!n || !n.name) return;
      const id = n.id || n.name; // 没 id 退化用 name 当 key
      idToName.set(id, n.name);
      [n.name, ...splitNames(n.aliases), ...splitNames(n.onlineName)].forEach(nm => {
        const t = String(nm || '').trim();
        if (t && !aliasToId.has(t)) aliasToId.set(t, id);
      });
    };
    try {
      const wv = await Worldview.getCurrent();
      if (wv) {
        (wv.globalNpcs || []).forEach(addNpc);
        (wv.regions || []).forEach(r => {
          (r.npcs || []).forEach(addNpc);
          (r.factions || []).forEach(f => (f.npcs || []).forEach(addNpc));
        });
      }
    } catch(_) {}
    return { aliasToId, idToName };
  }

  // 生成分类节目单（核心逻辑，空状态与重新调频共用）
  async function _radioGenerate(catId) {
    const pd = await _getPhoneData();
    _ensureRadioCategories(pd);
    if (!pd.radioPrograms) pd.radioPrograms = {};
    const cat = (pd.radioCategories || []).find(c => c.id === catId);
    if (!cat) { UI.showToast('分类不存在', 1500); return; }

    // 功能模型配置
    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) {
      UI.showToast('请先配置功能模型', 1800);
      _renderRadioCategory(pd, catId);
      return;
    }

    // 标签池（随机分类则合并全部标签）
    const isRandom = !!cat.isRandom;
    let tagList = [];
    if (isRandom) {
      Object.keys(_RADIO_TAGS).forEach(k => { tagList = tagList.concat(_RADIO_TAGS[k]); });
    } else {
      tagList = _radioTagsOf(catId);
    }
    const tagNames = tagList.map(t => t.name);
    const tagLines = tagList.map(t => `- ${t.name}：${t.desc}`).join('\n');

    // 全量资料包（含世界观详细数据 + 主线最近10轮）
    let wvPrompt = '';
    try { wvPrompt = await _buildFullContext({ npcBrief: false }); } catch(_) {}

    // NPC 索引（别名归一）+ 避让名单：radioRecentNpcs 存的是 NPC id，展示时翻译成主名
    const npcIndex = await _radioBuildNpcIndex();
    const recentIds = Array.isArray(pd.radioRecentNpcs) ? pd.radioRecentNpcs : [];
    const recentNames = recentIds.map(id => npcIndex.idToName.get(id)).filter(Boolean);
    const avoidLine = recentNames.length
      ? `\n- 以下世界观角色近期已在其他电台频繁出场，若要安排真实角色，请优先选用名单之外的人，避免同一个人到处串台：${recentNames.join('、')}`
      : '';

    const sysPrompt = `你是电台节目策划系统。根据以下分类信息与世界观资料，生成 6-8 个风格各异的电台预览（数量你自己定）。

【分类】${cat.name}
【分类方向】${cat.desc || ''}
【可用标签】
${tagLines || '（无限定标签，自由发挥）'}

每个电台输出以下字段，严格使用 JSON 数组格式，不能返回 Markdown，不能返回代码块，不能解释，必须以 [ 开头、以 ] 结尾：
[
  {
    "name": "电台名称（简短有特色，2-6字）",
    "dj": "主播名（可自由虚构化名，2-3字，有个性）",
    "guest": "嘉宾名（可选，可自由虚构化名，没有就留空字符串）",
    "tags": ["标签名（从可用标签里选，1-2个）"],
    "concept": "频道核心概念（150字以上。描述这档节目的风格定位、内容方向、主播人设、目标受众。用户不可见，仅供后续生成详情使用）",
    "intro": "频道简介（1-2句话，面向听众的频道介绍/广告语，说明这个台长期是干嘛的，用户可见）",
    "showName": "当前节目名（本期主题，简短有钩子）",
    "coverKeyword": "封面关键词（1-3个英文词，用于搜索配图，如 city night / horror fog / coffee chat）"
  }
]

要求：
- 6-8 个电台之间风格差异要明显（不同主播调性、不同内容侧重）
- tags 只能从【可用标签】里选，每个电台选 1-2 个；标签可以重复，靠 concept 拉开差异
- 整批电台中，至多安排 1 个世界观里的真实角色出任某档节目的主持人或嘉宾，且必须贴合该角色的人设与身份；其余主持人/嘉宾一律用虚构化名，不要硬塞角色${avoidLine}
- concept 要足够详细，后续 AI 靠它来写完整节目
- coverKeyword 用能代表节目氛围的英文短词
- 只输出 JSON，不要多余解释

${wvPrompt}`;

    let raw;
    try {
      raw = await _phoneJsonArrayWithRetry({
        label: '电台预览', url, key, model,
        temperature: 0.95, max_tokens: 4096,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: `请为「${cat.name}」分类生成一批电台预览。` }
        ]
      });
    } catch (e) {
      console.error('[电台预览]', e);
      UI.showToast('生成失败，请重试', 1800);
      _renderRadioCategory(pd, catId);
      return;
    }

    // 规范化：过滤非法标签、补 FM、配封面
    const validNames = new Set(tagNames);
    const list = (Array.isArray(raw) ? raw : []).filter(p => p && p.name).map(p => {
      let tags = Array.isArray(p.tags) ? p.tags.filter(t => validNames.has(t)) : [];
      if (tags.length === 0 && tagNames.length) tags = [tagNames[0]];
      return {
        name: String(p.name).slice(0, 12),
        dj: String(p.dj || '匿名').slice(0, 8),
        guest: String(p.guest || '').slice(0, 8),
        tags: tags.slice(0, 2),
        concept: String(p.concept || ''),
        intro: String(p.intro || '').slice(0, 80),
        showName: String(p.showName || '').slice(0, 30),
        coverKeyword: String(p.coverKeyword || ''),
        cover: '',
        hook: ''
      };
    });
    if (list.length === 0) {
      UI.showToast('生成结果为空，请重试', 1800);
      _renderRadioCategory(pd, catId);
      return;
    }

    // FM 频率：前端生成，批内去重
    const fmList = _radioGenFmList(list.length);
    // 封面：暂用预设 base64 循环兜底（后续接 Unsplash 用 coverKeyword）
    const covers = (typeof _RADIO_COVERS !== 'undefined' && _RADIO_COVERS.length) ? _RADIO_COVERS : [];
    list.forEach((p, i) => {
      p.fm = fmList[i] || '';
      p.cover = covers.length ? covers[i % covers.length] : '';
    });

    // 更新避让名单：把这批里命中真实 NPC 的主播/嘉宾归一成 id，记进 radioRecentNpcs（去重，上限15）
    try {
      const usedIds = [];
      list.forEach(p => {
        [p.dj, p.guest].forEach(nm => {
          const n = (nm || '').trim();
          const id = n && npcIndex.aliasToId.get(n);
          if (id && !usedIds.includes(id)) usedIds.push(id);
        });
      });
      if (usedIds.length) {
        let recent = Array.isArray(pd.radioRecentNpcs) ? pd.radioRecentNpcs.slice() : [];
        recent = usedIds.concat(recent.filter(id => !usedIds.includes(id)));
        if (recent.length > 15) recent = recent.slice(0, 15);
        pd.radioRecentNpcs = recent;
      }
    } catch(_) {}

    pd.radioPrograms[catId] = list;
    await _savePhoneData();
    _log(`电台「${cat.name}」刷新了 ${list.length} 个台：${list.map(p => p.name).join('、')}`);
    if (!_isAppStillActive('radio')) {
      UI.showToast('电台刷新完成', 1500);
      return;
    }
    _renderRadioCategory(pd, catId);
  }

  // ===== 电台详情页（整页 overlay）=====
  // 临时假正文，用于先跑通详情 UI（后续替换为 AI 生成）
  const _RADIO_FAKE_BODY = `午夜的电波带着轻微的电流声，舒缓的钢琴垫乐缓缓淡入。
> 林岸：各位听众朋友晚上好，这里是晚间新闻，我是主播林岸。今天是个不太平静的夜晚。
垫乐渐渐收起，翻动稿纸的声音很轻。
> 林岸：先来看今天的头条。市政厅今晚发布通告，城东新区的规划调整方案正式进入公示阶段。
> 老王：补充一句，这次调整涉及三个街区的居民安置，我手头拿到的细则显示，补偿标准比上一轮提高了不少。
演播室里短暂的沉默，能听见杯子轻放在桌面的声音。
> 林岸：是的，这也是为什么今晚很多市民守在收音机前。我们会持续跟进这件事的后续。
> 老王：希望相关部门能把信息公开做得更透明一些，别让大家靠猜。
垫乐重新浮起，节目进入下一个环节。`;

  async function _radioOpenDetail(catId, idx) {
    const pd = await _getPhoneData();
    const programs = (pd.radioPrograms && pd.radioPrograms[catId]) || [];
    const p = programs[idx];
    if (!p) { UI.showToast('节目不存在', 1500); return; }

    // 头部圆形头像：有封面用封面，否则主题色底
    const avatarHtml = p.cover
      ? `<img src="${Utils.escapeHtml(p.cover)}" alt="">`
      : `<div class="phone-radio-detail-avatar-fallback">${Utils.escapeHtml((p.name || '电')[0])}</div>`;

    const fmText = p.fm ? `FM ${Utils.escapeHtml(String(p.fm))}` : '';
    const hostLine = `主播 ${Utils.escapeHtml(p.dj || '匿名')}${p.guest ? ` · 嘉宾 ${Utils.escapeHtml(p.guest)}` : ''}`;
    const tags = (p.tags || []).map(t => `<span class="phone-radio-card-tag">${Utils.escapeHtml(t)}</span>`).join('');

    // 正文：暂用假数据（后续接 AI）
    const bodyRaw = p._body || _RADIO_FAKE_BODY;
    const duration = p._duration || '约 30 分钟';
    const segHtml = _radioRenderSegments(bodyRaw, p);

    const overlay = document.createElement('div');
    overlay.className = 'phone-radio-detail';
    overlay.innerHTML = `
      <div class="phone-radio-detail-head">
        <button class="phone-radio-detail-back" id="phone-radio-detail-back">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 5-7 7 7 7"/></svg>
        </button>
        <div class="phone-radio-detail-headinfo">
          <div class="phone-radio-detail-name">${Utils.escapeHtml(p.name || '电台')}</div>
          <div class="phone-radio-detail-fm">${fmText}</div>
        </div>
        <div class="phone-radio-detail-avatar">${avatarHtml}</div>
      </div>
      <div class="phone-radio-detail-scroll">
        <div class="phone-radio-detail-meta">
          <div class="phone-radio-detail-show">${Utils.escapeHtml(p.showName || '本期节目')}</div>
          <div class="phone-radio-detail-tags">${tags}</div>
          <div class="phone-radio-detail-host">${hostLine}</div>
          <div class="phone-radio-detail-dur">⏱ ${Utils.escapeHtml(duration)}</div>
        </div>
        <div class="phone-radio-detail-body">${segHtml}</div>
        <div class="phone-radio-detail-interact" id="phone-radio-detail-interact">
          <!-- 互动玩法占位：投票/点歌/抽奖/连线 -->
        </div>
        <div class="phone-radio-detail-end">— 本期节目结束 —</div>
      </div>`;
    const shell = document.querySelector('#phone-modal .phone-shell') || document.body;
    shell.appendChild(overlay);
    const back = overlay.querySelector('#phone-radio-detail-back');
    if (back) back.onclick = () => overlay.remove();
  }

  // 把节目正文渲染成 叙述卡片 + 台词气泡（主播用封面头像，嘉宾用固定头像）
  function _radioRenderSegments(raw, prog) {
    const segs = _parseRadioReply(raw);
    const djName = (prog && prog.dj) || '';
    const coverImg = (prog && prog.cover) || '';
    let html = '';
    for (const seg of segs) {
      if (seg.kind === 'desc') {
        html += `<div class="phone-radio-narr">${Utils.escapeHtml(seg.text)}</div>`;
      } else {
        // 判断说话人是主播还是嘉宾
        const isHost = !seg.speaker || seg.speaker === djName;
        const avatar = isHost
          ? (coverImg ? `<img src="${Utils.escapeHtml(coverImg)}" alt="">` : `<div class="phone-radio-line-avatar-fallback">${Utils.escapeHtml((djName || '主')[0])}</div>`)
          : `<div class="phone-radio-line-avatar-guest">${_radioGuestAvatar()}</div>`;
        const name = seg.speaker || djName || '主播';
        html += `
          <div class="phone-radio-line ${isHost ? 'is-host' : 'is-guest'}">
            <div class="phone-radio-line-avatar">${avatar}</div>
            <div class="phone-radio-line-main">
              <div class="phone-radio-line-name">${Utils.escapeHtml(name)}</div>
              <div class="phone-radio-line-bubble">${Utils.escapeHtml(seg.text)}</div>
            </div>
          </div>`;
      }
    }
    return html;
  }

  // 添加自定义分类
  function _radioAddCategory() {
    _radioCategoryForm(null);
  }

  // 编辑自定义分类
  async function _radioEditCategory(catId) {
    const pd = await _getPhoneData();
    const cat = (pd.radioCategories || []).find(c => c.id === catId);
    if (!cat) { UI.showToast('分类不存在', 1500); return; }
    if (cat.isDefault) { UI.showToast('预设分类不可编辑', 1500); return; }
    _radioCategoryForm(cat);
  }

  // 分类编辑表单（新建/编辑共用）。cat 为 null 时为新建
  function _radioCategoryForm(cat) {
    const isEdit = !!cat;
    const cur = cat || { name: '', icon: 'mic', airStart: '', airEnd: '', allDay: true, desc: '' };
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:20px';

    const iconBtns = _RADIO_ICON_CHOICES.map(ic => `
      <div class="radio-cat-icon-pick${ic === cur.icon ? ' active' : ''}" data-icon="${ic}" onclick="(function(el){el.parentNode.querySelectorAll('.radio-cat-icon-pick').forEach(n=>n.classList.remove('active'));el.classList.add('active');})(this)">
        ${_radioChannelSvg(ic)}
      </div>`).join('');

    mask.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:20px;max-width:360px;width:100%;color:var(--text);max-height:84vh;overflow-y:auto">
        <div style="font-size:15px;font-weight:600;margin-bottom:16px">${isEdit ? '编辑分类' : '新建分类'}</div>

        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:5px">分类名称</label>
        <input id="radio-cat-name" type="text" maxlength="12" value="${Utils.escapeHtml(cur.name)}" placeholder="例如：午夜电波" style="width:100%;box-sizing:border-box;padding:9px 12px;font-size:14px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:10px;outline:none;margin-bottom:14px">

        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:5px">图标</label>
        <div id="radio-cat-icons" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">${iconBtns}</div>

        <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:10px;cursor:pointer">
          <input id="radio-cat-allday" type="checkbox" ${cur.allDay ? 'checked' : ''} style="accent-color:var(--accent)" onchange="document.getElementById('radio-cat-times').style.display=this.checked?'none':'flex'">
          全天播出
        </label>
        <div id="radio-cat-times" style="display:${cur.allDay ? 'none' : 'flex'};align-items:center;gap:8px;margin-bottom:14px">
          <input id="radio-cat-start" type="time" value="${Utils.escapeHtml(cur.airStart || '20:00')}" style="flex:1;padding:8px;font-size:14px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:10px">
          <span style="color:var(--text-secondary)">至</span>
          <input id="radio-cat-end" type="time" value="${Utils.escapeHtml(cur.airEnd || '23:00')}" style="flex:1;padding:8px;font-size:14px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:10px">
        </div>

        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:5px">分类描述</label>
        <textarea id="radio-cat-desc" rows="4" placeholder="描述这个分类大概播什么，给 AI 多样的生成方向" style="width:100%;box-sizing:border-box;padding:9px 12px;font-size:13px;line-height:1.5;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:10px;outline:none;resize:vertical;margin-bottom:18px">${Utils.escapeHtml(cur.desc || '')}</textarea>

        <div style="display:flex;gap:10px">
          <button id="radio-cat-cancel" style="flex:1;padding:10px;border:1px solid var(--border);border-radius:10px;background:none;color:var(--text);font-size:14px;cursor:pointer">取消</button>
          <button id="radio-cat-save" style="flex:1;padding:10px;border:none;border-radius:10px;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">${isEdit ? '保存' : '创建'}</button>
        </div>
        ${isEdit ? `<button id="radio-cat-delete" style="width:100%;margin-top:10px;padding:9px;border:none;border-radius:10px;background:none;color:#e0464b;font-size:13px;cursor:pointer">删除此分类</button>` : ''}
      </div>`;

    mask.querySelector('#radio-cat-cancel').onclick = () => document.body.removeChild(mask);
    mask.onclick = (e) => { if (e.target === mask) document.body.removeChild(mask); };

    mask.querySelector('#radio-cat-save').onclick = async () => {
      const name = mask.querySelector('#radio-cat-name').value.trim();
      if (!name) { UI.showToast('请填写分类名称', 1500); return; }
      const icon = (mask.querySelector('#radio-cat-icons .radio-cat-icon-pick.active') || {}).dataset?.icon || 'mic';
      const allDay = mask.querySelector('#radio-cat-allday').checked;
      const airStart = allDay ? '' : mask.querySelector('#radio-cat-start').value;
      const airEnd = allDay ? '' : mask.querySelector('#radio-cat-end').value;
      const desc = mask.querySelector('#radio-cat-desc').value.trim();

      const pd = await _getPhoneData();
      _ensureRadioCategories(pd);
      if (isEdit) {
        const target = pd.radioCategories.find(c => c.id === cat.id);
        if (target) { target.name = name; target.icon = icon; target.allDay = allDay; target.airStart = airStart; target.airEnd = airEnd; target.desc = desc; }
      } else {
        pd.radioCategories.push({ id: 'cat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, icon, allDay, airStart, airEnd, desc, isDefault: false });
      }
      await _savePhoneData();
      document.body.removeChild(mask);
      _renderRadio(pd);
    };

    if (isEdit) {
      mask.querySelector('#radio-cat-delete').onclick = async () => {
        const ok = await UI.showConfirm('删除分类', `确定删除「${cat.name}」分类吗？该分类下已生成的节目也会一并清除。`);
        if (!ok) return;
        const pd = await _getPhoneData();
        pd.radioCategories = (pd.radioCategories || []).filter(c => c.id !== cat.id);
        if (pd.radioPrograms) delete pd.radioPrograms[cat.id];
        await _savePhoneData();
        document.body.removeChild(mask);
        _renderRadio(pd);
      };
    }

    document.body.appendChild(mask);
  }

  // ===== 日历 App =====
let _calViewYear = 0, _calViewMonth = 0, _calSelectedDay = 0;

async function _renderCalendar(pd) {
  const body = document.getElementById('phone-body');
  document.getElementById('phone-title').textContent = '日历';
  _applyWallpaper(pd);

  // 异步刷新节日缓存
  await _refreshWvFestivalsCache();
  // 异步刷新历法规则缓存
  await _refreshCalRulesCache();

  // 读取当前游戏时间确定"今天"
  const sb = Conversations.getStatusBar() || {};
  const rules = _getCalRulesCached();
  const todayObj = (typeof Calendar !== 'undefined' && sb.time) ? Calendar.parseAbsoluteTime(sb.time) : null;

  // 初始化视图年月（第一次打开用"今天"，之后保持用户选择的）
  if (!_calViewYear) {
    _calViewYear = todayObj?.year || new Date().getFullYear();
    _calViewMonth = todayObj?.month || (new Date().getMonth() + 1);
    _calSelectedDay = todayObj?.day || new Date().getDate();
  }

  _renderCalBody(pd, rules, todayObj);
}

function _renderCalBody(pd, rules, todayObj) {
  const body = document.getElementById('phone-body');
  if (!body) return;

  const yr = _calViewYear, mo = _calViewMonth;
  const events = [...(pd?.calendarEvents || []), ..._getWvFestivalsAsEvents()];

  // 月份标题
  const monthsPerYear = rules?.monthsPerYear || 12;
  const prevMo = mo === 1 ? monthsPerYear : mo - 1;
  const prevYr = mo === 1 ? yr - 1 : yr;
  const nextMo = mo === monthsPerYear ? 1 : mo + 1;
  const nextYr = mo === monthsPerYear ? yr + 1 : yr;

  // 本月天数
  const daysInMonth = (rules && typeof Calendar !== 'undefined')
    ? Calendar._getDaysInMonth(mo, yr, rules)
    : new Date(yr, mo, 0).getDate();

  // 本月第一天的星期索引（0=第一天）
  const daysPerWeek = rules?.daysPerWeek || 7;
  let firstDayOffset = 0;
  if (rules && typeof Calendar !== 'undefined') {
    const firstDayEpoch = Calendar._daysSinceEpoch({ year: yr, month: mo, day: 1, hour: 0, minute: 0 }, rules);
    firstDayOffset = ((firstDayEpoch % daysPerWeek) + daysPerWeek) % daysPerWeek;
  } else {
    firstDayOffset = new Date(yr, mo - 1, 1).getDay();
    firstDayOffset = firstDayOffset === 0 ? 6 : firstDayOffset - 1; // 周一起始
  }

  // 星期表头
  const weekNames = rules?.weekDayNames || ['一','二','三','四','五','六','日'];
  const weekHeader = weekNames.map(n => `<div class="phone-cal-weekday">${Utils.escapeHtml(n.replace('星期',''))}</div>`).join('');
  const gridCols = `grid-template-columns:repeat(${daysPerWeek},1fr)`;

  // 有事件的日期 set（含持续天数范围）
  const eventDays = new Set();
  for (const ev of events) {
    let match = false;
    if (ev.repeat === 'monthly') {
      // 每月重复：任何月份都显示，只看日数
      match = true;
    } else if (ev.repeat === 'yearly') {
      // 每年重复：月匹配即可，不看年
      match = (ev.month === mo);
    } else {
      // 一次性：年月都要匹配
      match = (ev.month === mo && (!ev.year || ev.year === yr));
    }
    if (match) {
      const dur = Math.max(1, ev.duration || 1);
      for (let d = ev.day; d < ev.day + dur && d <= daysInMonth; d++) {
        eventDays.add(d);
      }
    }
  }

  // 日期格子
  let cells = '';
  // 空白占位
  for (let i = 0; i < firstDayOffset; i++) {
    cells += `<div class="phone-cal-cell phone-cal-cell-empty"></div>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = todayObj && todayObj.year === yr && todayObj.month === mo && todayObj.day === d;
    const isSel = _calSelectedDay === d;
    const hasDot = eventDays.has(d);
    cells += `<div class="phone-cal-cell${isToday ? ' phone-cal-today' : ''}${isSel ? ' phone-cal-selected' : ''}" onclick="Phone._calSelectDay(${yr},${mo},${d})">
      <span class="phone-cal-daynum">${d}</span>
      ${hasDot ? '<span class="phone-cal-dot"></span>' : ''}
    </div>`;
  }

  // 选中日的事项（含持续天数：ev.day ~ ev.day+duration-1 范围内的都显示）
  const selEvents = events.filter(ev => {
    let match = false;
    if (ev.repeat === 'monthly') {
      // 每月重复：任何月份，只看日数范围
      match = true;
    } else if (ev.repeat === 'yearly') {
      // 每年重复：月匹配即可
      if (ev.month !== mo) return false;
      match = true;
    } else {
      // 一次性：年月都要匹配
      if (ev.month !== mo || (ev.year && ev.year !== yr)) return false;
      match = true;
    }
    if (!match) return false;
    const dur = Math.max(1, ev.duration || 1);
    return _calSelectedDay >= ev.day && _calSelectedDay < ev.day + dur;
  });
  const evCards = selEvents.length
    ? selEvents.map(ev => {
        const svBtn = `viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
        const editSvg = `<svg ${svBtn}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
        const delSvg  = `<svg ${svBtn}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
        const typeSvg = _calTypeIconOnly(ev.type);
        const metaParts = [_calTypeName(ev.type)];
        if (ev.note) metaParts.push(ev.note);
        if (ev.repeat === 'yearly') metaParts.push('每年');
        else if (ev.repeat === 'monthly') metaParts.push('每月');
        if (ev.duration && ev.duration > 1) metaParts.push(`${ev.duration}天`);
        const metaText = metaParts.join(' · ');
        return `
        <div class="phone-cal-ev-card">
          <div class="phone-cal-ev-dot" style="background:${ev.color || 'var(--accent)'}"></div>
          <div class="phone-cal-ev-body">
            <div class="phone-cal-ev-title">${Utils.escapeHtml(ev.title || '无标题')}${ev.fromWv ? '<span class="phone-cal-ev-wv-tag">世界观</span>' : ''}</div>
            <div class="phone-cal-ev-meta"><span class="phone-cal-ev-type-icon">${typeSvg}</span>${Utils.escapeHtml(metaText)}</div>
          </div>
          ${!ev.fromWv ? `<div class="phone-cal-ev-actions">
            <button class="phone-cal-ev-icon-btn" onclick="Phone._calOpenEditEvent('${Utils.escapeHtml(ev.id)}')" title="编辑">${editSvg}</button>
            <button class="phone-cal-ev-icon-btn phone-cal-ev-del-btn" onclick="Phone._calDeleteEvent('${Utils.escapeHtml(ev.id)}')" title="删除">${delSvg}</button>
          </div>` : ''}
        </div>`;
      }).join('')
    : `<div class="phone-cal-ev-empty">这一天没有事项</div>`;

  body.innerHTML = `
    <div class="phone-cal-wrap">
      <div class="phone-cal-header">
        <button class="phone-cal-nav-btn" onclick="Phone._calNavMonth(${prevYr},${prevMo})">‹</button>
        <span class="phone-cal-title-text">${yr}年 ${mo}月</span>
        <button class="phone-cal-nav-btn" onclick="Phone._calNavMonth(${nextYr},${nextMo})">›</button>
        <button class="phone-cal-today-btn" onclick="Phone._calGoToday()">今天</button>
      </div>
      <div class="phone-cal-grid-wrap">
        <div class="phone-cal-week-header" style="${gridCols}">${weekHeader}</div>
        <div class="phone-cal-grid" style="${gridCols}">${cells}</div>
      </div>
      <div class="phone-cal-day-panel">
        <div class="phone-cal-day-title">
          <span>${mo}月${_calSelectedDay}日</span>
          <button class="phone-cal-add-btn" onclick="Phone._calOpenAddEvent()">＋ 添加事项</button>
        </div>
        <div class="phone-cal-ev-list">${evCards}</div>
      </div>
    </div>`;
}

function _calTypeLabel(type) {
  const sv = `viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px"`;
  const icons = {
    birthday: `<svg ${sv}><path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><line x1="2" y1="21" x2="22" y2="21"/><path d="M7 8v1M12 6v3M17 8v1"/></svg> 生日`,
    todo:     `<svg ${sv}><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> 待办`,
    period:   `<svg ${sv}><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg> 经期`,
    holiday:  `<svg ${sv}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> 节日`,
    note:     `<svg ${sv}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> 备忘`,
  };
  return icons[type] || `<svg ${sv}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> 事项`;
}

function _calTypeIconOnly(type) {
  const sv = `viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  const icons = {
    birthday: `<svg ${sv}><path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><line x1="2" y1="21" x2="22" y2="21"/></svg>`,
    todo:     `<svg ${sv}><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    period:   `<svg ${sv}><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>`,
    holiday:  `<svg ${sv}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    note:     `<svg ${sv}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  };
  return icons[type] || `<svg ${sv}><circle cx="12" cy="10" r="3"/></svg>`;
}

function _calTypeName(type) {
  const map = { birthday: '生日', todo: '待办', period: '经期', holiday: '节日', note: '备忘' };
  return map[type] || '事项';
}

async function _calNavMonth(yr, mo) {
  _calViewYear = yr; _calViewMonth = mo; _calSelectedDay = 1;
  const pd = await _getPhoneData();
  const sb = Conversations.getStatusBar() || {};
  const rules = _getCalRulesCached();
  const todayObj = (typeof Calendar !== 'undefined' && sb.time) ? Calendar.parseAbsoluteTime(sb.time) : null;
  _renderCalBody(pd, rules, todayObj);
}

async function _calGoToday() {
  const sb = Conversations.getStatusBar() || {};
  const todayObj = (typeof Calendar !== 'undefined' && sb.time) ? Calendar.parseAbsoluteTime(sb.time) : null;
  _calViewYear = todayObj?.year || new Date().getFullYear();
  _calViewMonth = todayObj?.month || (new Date().getMonth() + 1);
  _calSelectedDay = todayObj?.day || new Date().getDate();
  const pd = await _getPhoneData();
  const rules = _getCalRulesCached();
  _renderCalBody(pd, rules, todayObj);
}

async function _calSelectDay(yr, mo, day) {
  _calViewYear = yr; _calViewMonth = mo; _calSelectedDay = day;
  const pd = await _getPhoneData();
  const sb = Conversations.getStatusBar() || {};
  const rules = _getCalRulesCached();
  const todayObj = (typeof Calendar !== 'undefined' && sb.time) ? Calendar.parseAbsoluteTime(sb.time) : null;
  _renderCalBody(pd, rules, todayObj);
}

function _calOpenAddEvent() {
  const yr = _calViewYear, mo = _calViewMonth, day = _calSelectedDay;
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:flex-end;justify-content:center';
  mask.className = 'phone-cal-modal-mask';

  const sv = `viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
  const types = [
    { id:'note',    label:'备忘', svg:`<svg ${sv}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>` },
    { id:'birthday',label:'生日', svg:`<svg ${sv}><path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"></path><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"></path><line x1="2" y1="21" x2="22" y2="21"></line><path d="M7 8v2"></path><path d="M12 8v2"></path><path d="M17 8v2"></path><path d="M7 4 L 7 5"></path><path d="M12 3 L 12 5"></path><path d="M17 4 L 17 5"></path></svg>` },
    { id:'todo',    label:'待办', svg:`<svg ${sv}><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>` },
    { id:'period',  label:'经期', svg:`<svg ${sv}><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"></path></svg>` },
    { id:'holiday', label:'节日', svg:`<svg ${sv}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>` },
  ];
  const typeGrid = types.map(t => `
    <div class="cal-type-chip" data-type="${t.id}" onclick="Phone._calPickType(this)" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 6px;border-radius:12px;border:1.5px solid var(--border);cursor:pointer;flex:1;background:var(--bg-secondary);transition:all .15s;-webkit-tap-highlight-color:transparent">
      <span class="cal-type-icon" style="color:var(--text-secondary)">${t.svg}</span>
      <span style="font-size:11px;color:var(--text-secondary)">${t.label}</span>
    </div>`).join('');

  mask.innerHTML = `
    <div style="background:var(--bg);border-radius:20px 20px 0 0;padding:20px 16px 36px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
      <div style="width:36px;height:4px;border-radius:2px;background:var(--border);margin:0 auto 18px"></div>
      <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:18px">${mo}月${day}日 · 添加事项</div>

      <div style="display:flex;flex-direction:column;gap:14px">

        <!-- 名称 -->
        <input id="cal-ev-title" type="text" placeholder="事项名称（必填）" maxlength="30"
          style="width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box;outline:none">

        <!-- 类型 -->
        <div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">类型</div>
          <div style="display:flex;gap:6px">${typeGrid}</div>
        </div>

        <!-- 颜色 + 备注 -->
        <div style="display:flex;gap:10px;align-items:center">
          <div style="font-size:12px;color:var(--text-secondary);white-space:nowrap">颜色</div>
          <div id="cal-ev-color-swatch"
            onclick="Phone._calOpenColorPicker(this)"
            data-color="#7c9ef0"
            style="width:32px;height:32px;border-radius:10px;background:#7c9ef0;cursor:pointer;flex-shrink:0;border:2px solid rgba(255,255,255,0.15);box-shadow:0 2px 6px rgba(0,0,0,0.18);transition:all .15s;-webkit-tap-highlight-color:transparent"></div>
          <input id="cal-ev-note" type="text" placeholder="备注（可选）" maxlength="60"
            style="flex:1;padding:11px 14px;border-radius:12px;border:1.5px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box;outline:none">
        </div>

        <!-- 重复 -->
        <div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">重复</div>
          <div style="display:flex;gap:0;border-radius:12px;border:1.5px solid var(--border);overflow:hidden">
            <button id="cal-rep-once"    class="cal-rep-btn cal-rep-active" onclick="Phone._calPickRepeat('once')"    style="flex:1;padding:9px 0;border:none;font-size:13px;cursor:pointer;transition:all .15s;background:var(--accent);color:#fff;font-weight:600">不重复</button>
            <button id="cal-rep-monthly" class="cal-rep-btn"               onclick="Phone._calPickRepeat('monthly')" style="flex:1;padding:9px 0;border:none;font-size:13px;cursor:pointer;transition:all .15s;background:var(--bg-secondary);color:var(--text-secondary)">每月</button>
            <button id="cal-rep-yearly"  class="cal-rep-btn"               onclick="Phone._calPickRepeat('yearly')"  style="flex:1;padding:9px 0;border:none;font-size:13px;cursor:pointer;transition:all .15s;background:var(--bg-secondary);color:var(--text-secondary)">每年</button>
          </div>
        </div>

        <!-- 持续天数 -->
        <div style="display:flex;align-items:center;gap:10px">
          <div style="font-size:12px;color:var(--text-secondary);white-space:nowrap">持续天数</div>
          <input id="cal-ev-duration" type="number" min="1" max="365" value="1"
            style="width:72px;padding:9px 12px;border-radius:12px;border:1.5px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;text-align:center;box-sizing:border-box;outline:none">
          <div style="font-size:12px;color:var(--text-secondary)">天（默认1天）</div>
        </div>

        <!-- 按钮 -->
        <div style="display:flex;gap:8px;margin-top:4px">
          <button onclick="this.closest('div[style*=fixed]').remove()"
            style="flex:1;padding:12px;border-radius:12px;border:1.5px solid var(--border);background:transparent;color:var(--text-secondary);font-size:14px;cursor:pointer">取消</button>
          <button onclick="Phone._calSaveEvent(${yr},${mo},${day})"
            style="flex:2;padding:12px;border-radius:12px;border:none;background:var(--accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer">保存</button>
        </div>

      </div>
    </div>`;

  // 默认选中 note 类型
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);
  setTimeout(() => {
    const firstChip = mask.querySelector('.cal-type-chip[data-type="note"]');
    if (firstChip) Phone._calPickType(firstChip);
    document.getElementById('cal-ev-title')?.focus();
  }, 80);
}

// ===== 从世界观节日生成日历事项（只读，fromWv标记） =====
// 世界观/世界书节日缓存（异步刷新，同步读）
let _wvFestivalsCache = [];

// 异步刷新节日缓存（在打开日历APP时调用）
async function _refreshWvFestivalsCache() {
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) { _wvFestivalsCache = []; return; }

    // 1. 世界观节日（从对话绑定的世界观读DB）
    let allFestivals = [];
    const wvId = conv.worldviewId || conv.singleWorldviewId || '';
    let wv = null;
    if (wvId) {
      try { wv = await DB.get('worldviews', wvId); } catch(_) {}
    }
    if (wv?.festivals) allFestivals.push(...wv.festivals);

    // 2. 世界书节日
    try {
      if (typeof Lorebook !== 'undefined' && Lorebook.collectForChat) {
        let card = null;
        if (conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
          try { card = await DB.get('singleCards', conv.singleCharId); } catch(_) {}
        }
        const lbs = await Lorebook.collectForChat({ conv, card, wv });
        for (const lb of (lbs || [])) {
          if (Array.isArray(lb.festivals)) allFestivals.push(...lb.festivals);
        }
      }
    } catch(_) {}

    // 转成日历事项格式
    const result = [];
    for (const f of allFestivals) {
      if (f.enabled === false || !f.date) continue;
      const m1 = f.date.match(/(\d{4})[年\/\-.](\d{1,2})[月\/\-.](\d{1,2})/);
      const m2 = !m1 && f.date.match(/(\d{1,2})[月\/](\d{1,2})/);
      let month, day, year = 0;
      if (m1) { year = parseInt(m1[1]); month = parseInt(m1[2]); day = parseInt(m1[3]); }
      else if (m2) { month = parseInt(m2[1]); day = parseInt(m2[2]); }
      else continue;
      if (!month || !day) continue;
      result.push({
        id: f.id,
        title: f.name || '节日',
        type: 'holiday',
        color: '#e8a44a',
        note: f.content || '',
        year: f.yearly ? 0 : (year || 0),
        month, day,
        repeat: f.yearly ? 'yearly' : 'once',
        duration: 1,
        fromWv: true,
      });
    }
    _wvFestivalsCache = result;
  } catch(_) { _wvFestivalsCache = []; }
}

function _getWvFestivalsAsEvents() {
  return _wvFestivalsCache;
}

// 日历弹窗：调起色环
function _calOpenColorPicker(swatchEl) {
  if (typeof ColorPicker === 'undefined') return;
  const currentColor = swatchEl?.dataset.color || '#7c9ef0';
  ColorPicker.open(swatchEl, currentColor, 1, (hex) => {
    if (!hex) return;
    const el = document.getElementById('cal-ev-color-swatch');
    if (el) {
      el.dataset.color = hex;
      el.style.background = hex;
    }
  });
  // 色环 overlay 必须比弹窗 mask(99999) 更高
  requestAnimationFrame(() => {
    const ov = document.getElementById('cp-overlay');
    if (ov) ov.style.setProperty('z-index', '999999', 'important');
  });
}

// 日历弹窗：切换类型 chip
function _calPickType(el) {
  document.querySelectorAll('.cal-type-chip').forEach(c => {
    const isThis = c === el;
    c.dataset.selected = isThis ? '1' : '0';
    c.style.borderColor = isThis ? 'var(--accent)' : 'var(--border)';
    c.style.background = isThis ? 'color-mix(in srgb, var(--accent) 15%, var(--bg-secondary))' : 'var(--bg-secondary)';
    const icon = c.querySelector('.cal-type-icon');
    if (icon) icon.style.color = isThis ? 'var(--accent)' : 'var(--text-secondary)';
    const label = c.querySelector('span:last-child');
    if (label) label.style.color = isThis ? 'var(--accent)' : 'var(--text-secondary)';
  });
}

// 日历弹窗：切换重复选项
function _calPickRepeat(rep) {
  document.querySelectorAll('.cal-rep-btn').forEach(btn => {
    const isThis = btn.id === `cal-rep-${rep}`;
    btn.dataset.active = isThis ? '1' : '0';
    btn.dataset.rep = btn.id.replace('cal-rep-', '');
    btn.style.background = isThis ? 'var(--accent)' : 'var(--bg-secondary)';
    btn.style.color = isThis ? '#fff' : 'var(--text-secondary)';
    btn.style.fontWeight = isThis ? '600' : '400';
  });
}

async function _calSaveEvent(yr, mo, day) {
  const title = (document.getElementById('cal-ev-title')?.value || '').trim();
  if (!title) { UI.showToast('请填写事项名称', 1500); return; }
  // 从选中的 chip 读类型
  const activeChip = document.querySelector('.cal-type-chip[data-selected="1"]');
  const type = activeChip?.dataset.type || 'note';
  const color = document.getElementById('cal-ev-color-swatch')?.dataset.color || '#7c9ef0';
  const note = (document.getElementById('cal-ev-note')?.value || '').trim();
  // 从选中的重复按钮读重复方式
  const activeRep = document.querySelector('.cal-rep-btn[data-active="1"]');
  const repeat = activeRep?.dataset.rep || 'once';
  const duration = Math.max(1, parseInt(document.getElementById('cal-ev-duration')?.value || '1', 10) || 1);

  const pd = await _getPhoneData();
  if (!pd) return;
  pd.calendarEvents = pd.calendarEvents || [];
  pd.calendarEvents.push({
    id: Utils.uuid(),
    title, type, color, note,
    year: (repeat === 'yearly' || repeat === 'monthly') ? 0 : yr,
    month: mo, day,
    repeat: repeat || 'once',
    duration: duration,
    createdAt: Date.now()
  });
  await _savePhoneData();

  // 关闭弹窗
  document.querySelector('.phone-cal-modal-mask')?.remove();

  // 刷新视图
  const sb = Conversations.getStatusBar() || {};
  const rules = _getCalRulesCached();
  const todayObj = (typeof Calendar !== 'undefined' && sb.time) ? Calendar.parseAbsoluteTime(sb.time) : null;
  _renderCalBody(pd, rules, todayObj);
  _refreshCalBanner();
  UI.showToast('已添加', 1200);
}

async function _calOpenEditEvent(id) {
  const pd = await _getPhoneData();
  if (!pd) return;
  const ev = (pd.calendarEvents || []).find(e => e.id === id);
  if (!ev) { UI.showToast('找不到事项', 1500); return; }

  const yr = ev.year || _calViewYear, mo = ev.month, day = ev.day;
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:flex-end;justify-content:center';
  mask.className = 'phone-cal-modal-mask';

  const sv = `viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
  const types = [
    { id:'note',    label:'备忘', svg:`<svg ${sv}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>` },
    { id:'birthday',label:'生日', svg:`<svg ${sv}><path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"></path><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"></path><line x1="2" y1="21" x2="22" y2="21"></line><path d="M7 8v2M12 8v2M17 8v2"></path></svg>` },
    { id:'todo',    label:'待办', svg:`<svg ${sv}><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>` },
    { id:'period',  label:'经期', svg:`<svg ${sv}><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"></path></svg>` },
    { id:'holiday', label:'节日', svg:`<svg ${sv}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>` },
  ];
  const typeGrid = types.map(t => `
    <div class="cal-type-chip" data-type="${t.id}" onclick="Phone._calPickType(this)" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 6px;border-radius:12px;border:1.5px solid var(--border);cursor:pointer;flex:1;background:var(--bg-secondary);transition:all .15s;-webkit-tap-highlight-color:transparent">
      <span class="cal-type-icon" style="color:var(--text-secondary)">${t.svg}</span>
      <span style="font-size:11px;color:var(--text-secondary)">${t.label}</span>
    </div>`).join('');

  mask.innerHTML = `
    <div style="background:var(--bg);border-radius:20px 20px 0 0;padding:20px 16px 36px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
      <div style="width:36px;height:4px;border-radius:2px;background:var(--border);margin:0 auto 18px"></div>
      <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:18px">${mo}月${day}日 · 编辑事项</div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <input id="cal-ev-title" type="text" placeholder="事项名称（必填）" maxlength="30" value="${Utils.escapeHtml(ev.title || '')}"
          style="width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box;outline:none">
        <div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">类型</div>
          <div style="display:flex;gap:6px">${typeGrid}</div>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <div style="font-size:12px;color:var(--text-secondary);white-space:nowrap">颜色</div>
          <div id="cal-ev-color-swatch" onclick="Phone._calOpenColorPicker(this)" data-color="${ev.color || '#7c9ef0'}"
            style="width:32px;height:32px;border-radius:10px;background:${ev.color || '#7c9ef0'};cursor:pointer;flex-shrink:0;border:2px solid rgba(255,255,255,0.15);box-shadow:0 2px 6px rgba(0,0,0,0.18);transition:all .15s;-webkit-tap-highlight-color:transparent"></div>
          <input id="cal-ev-note" type="text" placeholder="备注（可选）" maxlength="60" value="${Utils.escapeHtml(ev.note || '')}"
            style="flex:1;padding:11px 14px;border-radius:12px;border:1.5px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box;outline:none">
        </div>
        <div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">重复</div>
          <div style="display:flex;gap:0;border-radius:12px;border:1.5px solid var(--border);overflow:hidden">
            <button id="cal-rep-once"    class="cal-rep-btn" onclick="Phone._calPickRepeat('once')"    style="flex:1;padding:9px 0;border:none;font-size:13px;cursor:pointer;transition:all .15s;background:var(--bg-secondary);color:var(--text-secondary)">不重复</button>
            <button id="cal-rep-monthly" class="cal-rep-btn" onclick="Phone._calPickRepeat('monthly')" style="flex:1;padding:9px 0;border:none;font-size:13px;cursor:pointer;transition:all .15s;background:var(--bg-secondary);color:var(--text-secondary)">每月</button>
            <button id="cal-rep-yearly"  class="cal-rep-btn" onclick="Phone._calPickRepeat('yearly')"  style="flex:1;padding:9px 0;border:none;font-size:13px;cursor:pointer;transition:all .15s;background:var(--bg-secondary);color:var(--text-secondary)">每年</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="font-size:12px;color:var(--text-secondary);white-space:nowrap">持续天数</div>
          <input id="cal-ev-duration" type="number" min="1" max="365" value="${ev.duration || 1}"
            style="width:72px;padding:9px 12px;border-radius:12px;border:1.5px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;text-align:center;box-sizing:border-box;outline:none">
          <div style="font-size:12px;color:var(--text-secondary)">天</div>
        </div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <button onclick="this.closest('div[style*=fixed]').remove()"
            style="flex:1;padding:12px;border-radius:12px;border:1.5px solid var(--border);background:transparent;color:var(--text-secondary);font-size:14px;cursor:pointer">取消</button>
          <button onclick="Phone._calSaveEditEvent('${id}')"
            style="flex:2;padding:12px;border-radius:12px;border:none;background:var(--accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer">保存</button>
        </div>
      </div>
    </div>`;

  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);
  setTimeout(() => {
    const chip = mask.querySelector(`.cal-type-chip[data-type="${ev.type || 'note'}"]`);
    if (chip) Phone._calPickType(chip);
    Phone._calPickRepeat(ev.repeat || 'once');
  }, 80);
}

async function _calSaveEditEvent(id) {
  const title = (document.getElementById('cal-ev-title')?.value || '').trim();
  if (!title) { UI.showToast('请填写事项名称', 1500); return; }
  const activeChip = document.querySelector('.cal-type-chip[data-selected="1"]');
  const type = activeChip?.dataset.type || 'note';
  const color = document.getElementById('cal-ev-color-swatch')?.dataset.color || '#7c9ef0';
  const note = (document.getElementById('cal-ev-note')?.value || '').trim();
  const activeRep = document.querySelector('.cal-rep-btn[data-active="1"]');
  const repeat = activeRep?.dataset.rep || 'once';
  const duration = Math.max(1, parseInt(document.getElementById('cal-ev-duration')?.value || '1', 10) || 1);

  const pd = await _getPhoneData();
  if (!pd) return;
  const ev = (pd.calendarEvents || []).find(e => e.id === id);
  if (!ev) return;
  ev.title = title; ev.type = type; ev.color = color; ev.note = note;
  ev.repeat = repeat; ev.duration = duration;
  if (repeat === 'yearly' || repeat === 'monthly') ev.year = 0;
  await _savePhoneData();

  document.querySelector('.phone-cal-modal-mask')?.remove();
  const sb = Conversations.getStatusBar() || {};
  const rules = _getCalRulesCached();
  const todayObj = (typeof Calendar !== 'undefined' && sb.time) ? Calendar.parseAbsoluteTime(sb.time) : null;
  _renderCalBody(pd, rules, todayObj);
  _refreshCalBanner();
  UI.showToast('已更新', 1200);
}

async function _calDeleteEvent(id) {
  const pd = await _getPhoneData();
  if (!pd) return;
  pd.calendarEvents = (pd.calendarEvents || []).filter(ev => ev.id !== id);
  await _savePhoneData();
  const sb = Conversations.getStatusBar() || {};
  const rules = _getCalRulesCached();
  const todayObj = (typeof Calendar !== 'undefined' && sb.time) ? Calendar.parseAbsoluteTime(sb.time) : null;
  _renderCalBody(pd, rules, todayObj);
  _refreshCalBanner();
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
    // 记账：转账支出
    {
      const _ctName = (pd.chatContacts || []).find(c => c.id === contactId)?.name || contactId;
      pd.ledger = pd.ledger || [];
      pd.ledger.push({
        id: 'le_' + Utils.uuid().slice(0, 8),
        time: _getGameTime() || '',
        currencyId: currencyId,
        amount: -amount,
        category: '转账',
        note: '',
        platform: '',
        counterparty: _ctName,
        source: 'transfer_out',
        editable: true,
      });
      pd.ledger = pd.ledger.slice(-300);
    }
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
        <div style="display:flex;flex-direction:column;min-height:0">
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;gap:4px">
            <span style="display:flex;align-items:center;gap:4px">${_uiIcon('image', 12)} 配图描述（可选）</span>
            <button type="button" onclick="Phone._openAlbumPickerForForum()" style="padding:3px 10px;font-size:11px;border-radius:10px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--accent);cursor:pointer">从相册选</button>
          </div>
          <textarea id="phone-forum-post-imgdesc" placeholder="用文字描述你想配的图片" style="height:70px;min-height:70px;border:1px solid var(--border);border-radius:6px;padding:6px 8px;background:var(--bg-tertiary);color:var(--text);font-size:12px;resize:none;box-sizing:border-box">${Utils.escapeHtml(p.imageDesc || '')}</textarea>
        </div>
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
    const imageDesc = document.getElementById('phone-forum-post-imgdesc')?.value.trim() || '';
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
    post.imageDesc = imageDesc;
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
    // 配图描述
    if (p.imageDesc) {
      html += '<div class="phone-moment-image-desc" style="margin-bottom:12px">' + _uiIcon('image', 13) + '<span>' + Utils.escapeHtml(p.imageDesc) + '</span></div>';
    }
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
2. 本次生成 8-12 条"新增评论"，用于追加到已有评论后面。
3. 绝大多数评论者应是符合世界观和"${mt}"氛围的普通路人用户；可以有少量 NPC 参与回复（0-3条）。
4. 如果评论者是 NPC，username 直接填该 NPC 的网名（如有）或本名（不要加括号或注释），并标记 "isNpc": true；不确定是否为 NPC 则作为路人处理并标记 "isNpc": false。
5. 评论内容要自然多样：有赞同、反对、追问、吐槽、跑题、阴阳怪气等，长度错落有致。可以加入适量的"@某人"或引用前排回复的互动感，但不要每条都@。如果已有评论中存在玩家的评论，请生成3-4条@玩家并回复玩家评论内容的评论。
6. 新评论应当参考已有评论，避免重复已有内容；可以接续已有讨论，也可以产生新分歧。
7. 评论时间必须依次晚于该帖子的发帖时间和已有的最新评论。请根据"当前游戏时间"智能安排回复节奏：
   - 若当前时间距离发帖/上一条评论很近，允许将新评论时间自然向后顺延（可合理超过当前游戏时间几分钟到几十分钟），模拟网友陆陆续续打字回复的过程。
   - 若当前时间比发帖/上一条评论晚了几个小时或几天，请将新评论散布在这段过去的空窗期内，并让最新几条紧贴当前游戏时间。
   - 严禁跳跃到不合逻辑的遥远未来。
8. 所有 time 都必须使用 "YYYY.MM.DD 星期X HH:mm" 格式，不要写成别的时间样式。
9. 【严禁】发帖人"${post.username}"是玩家本人。绝对不能让"${post.username}"出现在评论区——不能以楼主身份回复、不能以路人身份出现、不能以任何形式代替玩家发言。评论者只能是其他人。
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
      const userPrompt = `${gameTime ? `## 当前游戏时间\n${gameTime}\n\n` : ''}## 玩家发帖信息\n标题：${post.title || '无标题'}\n发帖人（玩家本人）：${post.username || '匿名'}\n发帖时间：${post.time || '未知'}\n标签：${(post.tags || []).join('、')}\n\n## 帖子完整内容\n${post.content || '无正文'}\n\n## 已有评论\n${existingCommentsStr}\n\n请生成 8-12 条新的追加评论，只返回 JSON。注意：发帖人"${post.username}"是玩家本人，绝对不能出现在评论区中。`;

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
        // 使用统一的论坛头像+显示名匹配
        await _ensureForumNpcAvatarMap();
        await _ensureForumDisplayNameMap();
        result.comments.forEach(c => _matchForumAvatar(c));
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

      const sysPrompt = `你是一个"${mt}"评论/回复区生成器。用户给你一条帖子/动态，以及当前已经存在的评论列表。请根据世界观、帖子内容、已有评论，生成一批新的追加评论。

${md ? `载体说明：${md}\n\n` : ''}要求：
1. 只生成评论/回复区，不要改写帖子正文，不要生成新的帖子标题。
2. 本次生成 8-12 条"新增评论"，用于追加到已有评论后面。
3. 绝大多数评论者应是符合世界观和"${mt}"氛围的普通路人用户；可以有少量 NPC 参与回复（0-3条）。
4. 如果评论者是 NPC，username 直接填该 NPC 的网名（如有）或本名（不要加括号或注释），并标记 "isNpc": true；不确定是否为 NPC 则作为路人处理并标记 "isNpc": false。
5. 如果楼主（发帖人）出现在评论区，必须是以作者/楼主身份回复读者（如答疑、补充），而不是以路人视角评论自己。
6. 评论内容要自然多样：可以有赞同、反对、追问、吐槽、跑题、补充信息、阴阳怪气、认真分析等；长度不要整齐划一，有人一句话，有人写一小段。如果已有评论中存在玩家的评论，请生成3-4条@玩家并回复玩家评论内容的评论。
7. 新评论应当参考已有评论，避免重复已有内容；可以接续已有讨论，也可以产生新分歧。
8. 评论时间必须依次晚于该帖子的发帖时间和已有的最新评论。请根据"当前游戏时间"智能安排回复节奏：
   - 若当前时间距离发帖/上一条评论很近，允许将新评论时间自然向后顺延（可合理超过当前游戏时间几分钟到几十分钟），模拟网友陆陆续续打字回复的过程。
   - 若当前时间比发帖/上一条评论晚了几个小时或几天，请将新评论散布在这段过去的空窗期内，并让最新几条紧贴当前游戏时间。
   - 严禁跳跃到不合逻辑的遥远未来。
9. 所有 time 都必须使用 "YYYY.MM.DD 星期X HH:mm" 格式，不要写成别的时间样式。
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
      const userPrompt = `${gameTime ? `## 当前游戏时间\n${gameTime}\n\n` : ''}## 帖子信息\n标题：${post.title || '无标题'}\n发帖人（楼主）：${post.username || '匿名'}\n发帖时间：${post.time || '未知'}\n标签：${(post.tags || []).join('、')}\n\n## 帖子完整内容\n${post.fullContent || post.content || '无正文'}\n\n## 已有评论\n${existingCommentsStr}\n\n请生成 8-12 条新的追加评论，只返回 JSON。注意：楼主如果出现在评论区，要以作者身份回复读者。评论者绝对不能是玩家本人。`;

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
        // 使用统一的论坛头像+显示名匹配
        await _ensureForumNpcAvatarMap();
        await _ensureForumDisplayNameMap();
        result.comments.forEach(c => _matchForumAvatar(c));
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
    // 匹配头像和显示名
    await _ensureForumNpcAvatarMap();
    await _ensureForumDisplayNameMap();
    posts.forEach(p => _matchForumAvatar(p));
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

      // 获取玩家名用于禁止冒充
      let _searchBanStr = '';
      try {
        const mask = await Character.get();
        const bn = [mask?.name, (mask?.onlineName || '').trim()].filter(Boolean);
        if (bn.length > 0) _searchBanStr = `\n【禁止冒充玩家】玩家角色"${bn.join('"和"')}"绝对不能作为帖子发布者出现。\n`;
      } catch(_) {}

      const results = await _phoneJsonArrayWithRetry({
        label: `${_getForumName()}搜索`, url, key, model,
        temperature: 0.9,
        max_tokens: 5000,
        messages: [
          { role: 'system', content: `你是一个"${_getForumName()}"搜索引擎。${_getForumDesc() ? `载体说明：${_getForumDesc()}。\n\n` : ''}用户搜索了"${query}"，请根据资料生成 6~8 条与搜索内容相关的帖子/动态。
${_searchBanStr}
要求：
1. 内容可以有：关键词相同但实际不沾边的、虚假信息、半真半假的消息、科普、吃瓜、求助、吐槽等
2. 发帖人以虚构的普通用户为主，用户名要符合世界观和${_getForumName()}的画风。NPC 偶尔出现（0-2 条即可），不要每条都是 NPC 发的
3. 帖子风格贴合${_getForumName()}的画风，长短皆可，摘要长度不要千篇一律
4. tags 风格也要贴合${_getForumName()}（论坛/贴吧偏普通词、微博偏"#话题#"、小红书偏"#标签"），无需统一形式
5. 每条帖子都是独立的原创帖/一楼，不是对其他帖子的回复。标题和摘要不能出现"回楼上""楼主""回复@"等评论区用语
6. 时间分布：80% 在当前游戏时间附近 7 天内（最近热议），可以有 20% 是置顶/热门/挖坟的更早老帖，time 可以更靠前；time 永远不要超过当前游戏时间
7. 所有 time 都必须使用"YYYY.MM.DD 星期X HH:mm"格式，必须和当前游戏时间同一套写法
8. 返回纯JSON数组，不要包含任何其他文字

JSON格式：[{"id":"s1","username":"用户名","avatar_color":"#颜色","time":"YYYY.MM.DD 星期X HH:mm","title":"标题","summary":"摘要","tags":["标签"],"views":数字,"likes":数字,"comments":数字}]

${wvPrompt}` },
          { role: 'user', content: `搜索：${query}${await (async () => { try { return (typeof WorldVoice !== 'undefined' && WorldVoice._getNpcListForForum) ? await WorldVoice._getNpcListForForum() : ''; } catch(_) { return ''; } })()}` }
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
      // 匹配头像和显示名
      await _ensureForumNpcAvatarMap();
      await _ensureForumDisplayNameMap();
      results.forEach(p => _matchForumAvatar(p));
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
? (lastMsg.type === 'location' ? '[位置]' : lastMsg.type === 'voice' ? '[语音]' : lastMsg.type === 'photo' ? '[图片]' : lastMsg.type === 'product' ? '[商品链接]' : lastMsg.type === 'forum_card' ? '[帖子摘要]' : lastMsg.type === 'forum_detail' ? '[帖子详情]' : lastMsg.type === 'music_card' ? '[音乐分享]' : lastMsg.type === 'listen_invite' ? '[一起听邀请]' : lastMsg.type === 'listen_end' ? '[已结束一起听]' : (lastMsg.text || ''))
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
          ? (lastMsg.type === 'location' ? '[位置]' : lastMsg.type === 'voice' ? '[语音]' : lastMsg.type === 'photo' ? '[图片]' : lastMsg.type === 'product' ? '[商品链接]' : lastMsg.type === 'shop_listing' ? '[商品]' : lastMsg.type === 'forum_card' ? '[帖子摘要]' : lastMsg.type === 'forum_detail' ? '[帖子详情]' : lastMsg.type === 'music_card' ? '[音乐分享]' : lastMsg.type === 'map_place' ? '[地点链接]' : lastMsg.type === 'listen_invite' ? '[一起听邀请]' : lastMsg.type === 'listen_end' ? '[已结束一起听]' : (lastMsg.text || ''))
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

    // 构建 NPC名→备注昵称 映射（好友圈熟人空间，优先显示用户设的备注）
    const nicknameMap = {};
    (pd.chatContacts || []).forEach(c => {
      if (c.name && c.nickname) nicknameMap[c.name] = c.nickname;
    });
    const aliasToName = cache?.aliasToName || {};
    // 网名/代号→本名→备注昵称，没有备注就显示本名
    const _dispName = (npcName) => {
      const realName = aliasToName[npcName] || npcName;
      return nicknameMap[realName] || realName || '?';
    };

    const avatarHtml = (name, avatar, cls = '') => avatar
      ? `<img src="${Utils.escapeHtml(avatar)}" class="phone-moment-avatar ${cls}" alt="头像">`
      : `<div class="phone-moment-avatar ${cls}">${Utils.escapeHtml((name || '?')[0])}</div>`;

    const commentsHtml = (comments) => (comments && comments.length)
      ? `<div class="phone-moment-comments"><div class="phone-moment-comments-title">评论区</div>${comments.map(c => `
          <div class="phone-moment-comment-card">
            <span class="phone-moment-comment-name">${Utils.escapeHtml(_dispName(c.name))}</span>
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
            ${avatarHtml(_dispName(m.npc), npcAvatarMap[String(m.npc || '').trim()] || '', 'npc')}
            <div class="phone-moment-main">
              <div class="phone-moment-head">
                <div class="phone-moment-name">${Utils.escapeHtml(_dispName(m.npc))}</div>
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
      // 优先从对话绑定的 maskId 读
      const conv = (typeof Conversations !== 'undefined') ? Conversations.getList().find(c => c.id === convId) : null;
      const convMaskId = conv?.maskId || conv?.branchMaskId || ((typeof Character !== 'undefined' && Character.getCurrentId) ? Character.getCurrentId() : null);
      if (convMaskId) {
        // 从 characters store 读详细数据
        const charData = await DB.get('characters', convMaskId);
        if (charData?.name) {
          maskName = charData.name;
          maskAvatar = charData.avatar || '';
        } else {
          // fallback: 从 maskList 读名字
          const listData = await DB.get('gameState', 'maskList');
          const entry = (listData?.value || []).find(m => m.id === convMaskId);
          if (entry?.name) maskName = entry.name;
        }
        // 头像再从 activeAvatar 补一次
        if (!maskAvatar && typeof Character !== 'undefined' && Character.getAvatar) {
          maskAvatar = Character.getAvatar() || '';
        }
      }
    } catch(_) {}

    const npcAvatarMap = {};
    const aliasToName = {};
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
        const names = [n.name, ...(String(n.aliases || '').split(/[,，、\s]+/)), ...(String(n.onlineName || '').split(/[,，、\s]+/))]
          .map(x => String(x || '').trim()).filter(Boolean);
        names.forEach(name => { if (!npcAvatarMap[name]) npcAvatarMap[name] = url; });
      };
      // 构建"网名/代号→本名"反向映射
      const addAlias = (n) => {
        if (!n || !n.name) return;
        const altNames = [...(String(n.aliases || '').split(/[,，、\s]+/)), ...(String(n.onlineName || '').split(/[,，、\s]+/))]
          .map(x => String(x || '').trim()).filter(Boolean);
        altNames.forEach(alt => { if (alt !== n.name && !aliasToName[alt]) aliasToName[alt] = n.name; });
      };
      wvs.forEach(wv => {
        (wv.globalNpcs || []).forEach(n => { addNpc(n); addAlias(n); });
        (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(n => { addNpc(n); addAlias(n); })));
      });
      // 单人卡头像
      try {
        if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
          const sCard = await DB.get('singleCards', conv.singleCharId);
          if (sCard) {
            addAlias(sCard);
            const url = avatarById[sCard.id] || sCard.avatar || '';
            if (url) {
              const names = [sCard.name, ...(String(sCard.aliases || '').split(/[,，、\s]+/)), ...(String(sCard.onlineName || '').split(/[,，、\s]+/))]
                .map(x => String(x || '').trim()).filter(Boolean);
              names.forEach(name => { if (!npcAvatarMap[name]) npcAvatarMap[name] = url; });
            }
          }
        }
      } catch(_) {}
      // 挂载角色头像
      try {
        if (typeof AttachedChars !== 'undefined' && AttachedChars.resolveAll) {
          const attached = await AttachedChars.resolveAll();
          attached.forEach(c => {
            if (!c) return;
            addAlias(c);
            const url = avatarById[c.id] || c.avatar || '';
            if (!url) return;
            const names = [c.name, ...(String(c.aliases || '').split(/[,，、\s]+/)), ...(String(c.onlineName || '').split(/[,，、\s]+/))]
              .map(x => String(x || '').trim()).filter(Boolean);
            names.forEach(name => { if (!npcAvatarMap[name]) npcAvatarMap[name] = url; });
          });
        }
      } catch(_) {}
      // 世界书 NPC 头像
      try {
        if (typeof Lorebook !== 'undefined' && Lorebook.collectForChat) {
          let card = null;
          if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
            try { card = await DB.get('singleCards', conv.singleCharId); } catch(_) {}
          }
          const wv2 = wvIds[0] ? await DB.get('worldviews', wvIds[0]) : null;
          const lbs = await Lorebook.collectForChat({ conv, card, wv: wv2 });
          for (const lb of (lbs || [])) {
            (lb.globalNpcs || []).forEach(n => { addNpc(n); addAlias(n); });
          }
        }
      } catch(_) {}
    } catch(_) {}

    _momentsRenderCache = { convId, maskId: (typeof Character !== 'undefined' && Character.getCurrentId) ? Character.getCurrentId() : null, maskName, maskAvatar, npcAvatarMap, aliasToName };

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
    try { const mask = await Character.get(); maskName = mask?.name || '我'; } catch(_) {}
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
    : type === 'music' ? '歌曲分享'
    : type === 'camera' ? '相机照片'
    : '手机内容';
    const hasPending = (typeof Chat !== 'undefined' && Chat.hasPendingWorldVoice) ? Chat.hasPendingWorldVoice() : false;
    const confirmMsg = hasPending
      ? `已有一条挂载内容尚未发送，一次只能分享一条。是否覆盖为这条${typeLabel}？`
      : `将这条${typeLabel}作为附件挂载，下次发送消息时会一并带入上下文。`;
    if (!await UI.showConfirm('分享到主线', confirmMsg)) return;
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
      // 单人卡角色加入 NPC 候选
      try {
        if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
          const sCard = await DB.get('singleCards', conv.singleCharId);
          if (sCard?.name && !npcNames.includes(sCard.name)) npcNames.push(sCard.name);
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

时间要求：每条动态必须带发布时间 time，格式为"YYYY.MM.DD 星期X HH:mm"。发布时间必须严格早于【当前游戏时间】，且不早于该时间前7天；绝对禁止生成等于或晚于当前游戏时间的时间。

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
          { role: 'user', content: (() => {
            let msg = `请生成${wantCount}条NPC动态，严格使用NPC列表中的名字，并为每条动态填写符合要求的发布时间 time。`;
            try {
              const sb = Conversations.getStatusBar();
              if (sb?.time) msg += `\n\n【再次强调】当前游戏时间是"${_formatPhoneTime(sb.time)}"，所有动态的 time 必须严格早于这个时间。`;
            } catch(_) {}
            return msg;
          })() }
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
      // 单人卡角色加入 NPC 候选
      try {
        if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
          const sCard = await DB.get('singleCards', conv.singleCharId);
          if (sCard?.name && !npcNames.includes(sCard.name)) npcNames.push(sCard.name);
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

时间要求：每条动态必须带发布时间 time，格式为"YYYY.MM.DD 星期X HH:mm"。发布时间必须严格早于【当前游戏时间】，且不早于该时间前7天；绝对禁止生成等于或晚于当前游戏时间的时间。

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
        { role: 'user', content: (() => {
          let msg = `请生成${wantCount}条NPC动态。`;
          try {
            const sb = Conversations.getStatusBar();
            if (sb?.time) msg += `\n\n【再次强调】当前游戏时间是"${_formatPhoneTime(sb.time)}"，所有动态的 time 必须严格早于这个时间。`;
          } catch(_) {}
          return msg;
        })() }
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
  if (youParts.length) lines.push(youLabel + '：' + youParts.join(' '));
  // NPC（全列）
  const npcs = Array.isArray(sb.npcs) ? sb.npcs : [];
  npcs.forEach(n => {
    if (!n || !n.name) return;
    const parts = [];
    if (n.outfit && String(n.outfit).trim()) parts.push(String(n.outfit).trim());
    if (n.posture && String(n.posture).trim()) parts.push(String(n.posture).trim());
    if (parts.length) lines.push(String(n.name) + '：' + parts.join(' '));
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
        
        // 通话记录卡片（点击查看完整记录）
        if (m.type === 'call_record') {
          const cm = m.callMode === 'video' ? '视频通话' : '语音通话';
          const callIcon = m.callMode === 'video'
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
          const rounds = Array.isArray(m.rounds) ? m.rounds.length : 0;
          const hangupByText = m.hangupBy === 'them' ? '对方挂断' : (m.hangupBy === 'me' ? '我方挂断' : '');
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="call_record" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${avatarInner}</div>
            <div style="display:flex;flex-direction:column;align-items:flex-start;min-width:0">
              <div onclick="Phone._showCallRecord('${contactId}','${m.id}')" style="display:flex;align-items:center;gap:10px;padding:11px 16px;border-radius:18px;border-bottom-left-radius:4px;background:var(--bg-tertiary);cursor:pointer;min-width:160px">
                ${callIcon}
                <div style="min-width:0">
                  <div style="font-size:14px;color:var(--text);font-weight:500">${cm}</div>
                  <div style="font-size:11px;color:var(--text-secondary);margin-top:1px">${Utils.escapeHtml(m.startTime || '')}${m.endTime ? ' — ' + Utils.escapeHtml(m.endTime) : ''} · ${rounds}段对话${hangupByText ? ' · ' + hangupByText : ''}</div>
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        // 语音气泡
        if (m.type === 'voice') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="voice" style="cursor:pointer;align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
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
          const transferTitle = mine ? `向${Utils.escapeHtml(contact.nickname || contact.name)}转账` : `${Utils.escapeHtml(contact.nickname || contact.name)}向你转账`;
          const claimed = !!m.transferClaimed;
          const claimBar = (!mine)
            ? `<div style="padding:8px 14px;border-top:1px solid var(--border);font-size:12px;color:${claimed ? 'var(--text-secondary)' : 'var(--accent)'};${claimed ? 'opacity:0.7' : 'cursor:pointer'}" ${claimed ? '' : `onclick="Phone._claimTransfer('${Utils.escapeHtml(contact.id)}','${m.id}')"`}>${claimed ? '已收取' : '点击收取'}</div>`
            : '';
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="transfer" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="width:240px;border-radius:12px;overflow:hidden;border:1px solid var(--border);background:var(--bg-secondary)">
                <div style="background:linear-gradient(135deg,var(--accent),#e8a040);padding:12px 14px;display:flex;align-items:center;gap:8px">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
                  <span style="font-size:13px;font-weight:600;color:#fff">${transferTitle}</span>
                </div>
                <div style="padding:14px">
                  <div style="font-size:20px;font-weight:700;color:var(--text)">¥${Utils.escapeHtml(String(m.transferAmount || 0))}</div>
                </div>
                ${claimBar}
              </div>
              ${time}
            </div>
          </div>`;
        }

        // 位置气泡
        if (m.type === 'location') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="location" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
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
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="order" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div onclick="Phone._showOrderDetail('${Utils.escapeHtml(m.orderName || '')}','${Utils.escapeHtml(String(m.orderPrice || ''))}','${Utils.escapeHtml(m.orderShop || '')}','${Utils.escapeHtml(m.orderPlatform || '')}')" style="width:210px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary);cursor:pointer">
                <div style="padding:10px 14px 8px;display:flex;align-items:center;gap:8px">
                  <svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='var(--accent)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z'/><line x1='3' x2='21' y1='6' y2='6'/><path d='M16 10a4 4 0 0 1-8 0'/></svg>
                  <div style="flex:1;min-width:0">
                    <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.orderName || '订单')}</div>
                    ${m.orderShop ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.orderShop)}</div>` : ''}
                  </div>
                  ${m.orderPrice ? `<span style="font-size:13px;font-weight:700;color:var(--accent);flex-shrink:0">¥${Utils.escapeHtml(String(m.orderPrice))}</span>` : ''}
                </div>
                <div style="padding:2px 14px 10px;display:flex;align-items:center;gap:6px">
                  ${m.orderPlatform ? `<span style="font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--text-secondary)">${Utils.escapeHtml(m.orderPlatform)}</span>` : ''}
                  <span style="font-size:10px;color:var(--text-secondary)">点击查看详情</span>
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

    // 商品卡片气泡
        if (m.type === 'shop_listing') {
          const deliveryLabel = m.listingDelivery === 'express' ? '快递' : m.listingDelivery === 'errand' ? '跑腿' : '直接交付';
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="shop_listing" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="width:210px;height:90px;box-sizing:border-box;border-radius:14px;overflow:hidden;background:var(--bg-tertiary);display:flex;flex-direction:column;justify-content:center">
                <div style="padding:0 14px 6px;display:flex;align-items:center;gap:8px">
                  <svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='var(--accent)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='8' cy='21' r='1'/><circle cx='19' cy='21' r='1'/><path d='M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12'/></svg>
                  <div style="flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.listingName || '商品')}</div>
                  <span style="font-size:13px;font-weight:700;color:var(--accent);flex-shrink:0">${Utils.escapeHtml(String(m.listingPrice || 0))} ${Utils.escapeHtml(m.listingCurName || '')}</span>
                </div>
                <div style="padding:0 14px">
                  ${m.listingEffect ? `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.listingEffect)}</div>` : ''}
                  <div style="display:flex;align-items:center;gap:6px">
                    <span style="font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--text-secondary)">游鱼小店</span>
                    <span style="font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--text-secondary)">${deliveryLabel}</span>
                  </div>
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

    // 出售卡片气泡（char 卖货给 user，可点击购买）
        if (m.type === 'sell_offer') {
          const dLabel = m.sellDelivery === 'express' ? '快递' : m.sellDelivery === 'errand' ? '跑腿' : '即刻交付';
          const etaLabel = (m.sellDelivery !== 'instant' && m.sellEta) ? `${m.sellEta}${m.sellEtaUnit === 'day' ? '天' : '分钟'}达` : '';
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="sell_offer" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div ${mine ? '' : `onclick="Phone._showSellDetail(\'${Utils.escapeHtml(contact.id)}\',\'${m.id}\')"`} style="width:218px;height:112px;box-sizing:border-box;border-radius:14px;overflow:hidden;background:var(--bg-tertiary);display:flex;flex-direction:column;justify-content:space-between;padding:12px 0${mine ? '' : ';cursor:pointer'}">
                <div style="padding:0 14px 6px;display:flex;align-items:center;gap:8px">
                  <svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='var(--accent)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 9l1-5h16l1 5'/><path d='M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9'/><path d='M9 13h6'/></svg>
                  <div style="flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.sellName || '商品')}</div>
                  <span style="font-size:13px;font-weight:700;color:var(--accent);flex-shrink:0">${Utils.escapeHtml(String(m.sellPrice || 0))}</span>
                </div>
                <div style="padding:0 14px 8px">
                  ${m.sellDesc ? `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.sellDesc)}</div>` : ''}
                  <div style="display:flex;align-items:center;gap:6px">
                    <span style="font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--text-secondary)">${dLabel}</span>
                    ${etaLabel ? `<span style="font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--text-secondary)">${etaLabel}</span>` : ''}
                  </div>
                </div>
                <div style="padding:0 14px;text-align:center;font-size:12px;color:${m.sellBought ? 'var(--text-secondary)' : 'var(--accent)'}">${m.sellBought ? '已购买' : (mine ? '出售商品' : '点击查看详情')}</div>
              </div>
              ${time}
            </div>
          </div>`;
        }

    // 地点链接气泡
    // 好友圈动态气泡
        if (m.type === 'moment') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="moment" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="max-width:220px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
                <div style="padding:10px 14px;display:flex;align-items:center;gap:8px">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                  <span style="font-size:12px;font-weight:600;color:var(--accent)">发了一条好友圈</span>
                </div>
                <div style="padding:4px 14px 10px;font-size:13px;color:var(--text);line-height:1.5;word-break:break-word">${Utils.escapeHtml(m.momentText || m.text || '')}</div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        if (m.type === 'map_place') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="map_place" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
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

        // 音乐卡片气泡
        if (m.type === 'music_card') {
          const coverEl = m.musicCover
            ? `<img src="${Utils.escapeHtml(m.musicCover)}" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0">`
            : `<div style="width:44px;height:44px;border-radius:8px;background:var(--bg-secondary);flex-shrink:0;display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="20" height="20" fill="var(--text-secondary)"><path d="M9 18V5l12-2v13M9 18c0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3 3 1.34 3 3zM21 16c0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3 3 1.34 3 3z"/></svg></div>`;
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="music_card" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="width:210px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
                <div style="padding:12px 14px 10px;display:flex;gap:10px;align-items:center">
                  ${coverEl}
                  <div style="min-width:0;flex:1">
                    <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.musicTitle || '歌曲')}</div>
                    <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.musicArtist || '')}</div>
                  </div>
                </div>
                <div style="padding:0 14px 10px;display:flex;align-items:center;gap:6px">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--accent)"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                  <span style="font-size:11px;color:var(--text-secondary)">音乐分享</span>
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        // 一起听·邀请卡片
        if (m.type === 'listen_invite') {
          const coverEl = m.musicCover
            ? `<img src="${Utils.escapeHtml(m.musicCover)}" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0">`
            : `<div style="width:44px;height:44px;border-radius:8px;background:var(--bg-secondary);flex-shrink:0;display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="20" height="20" fill="var(--text-secondary)"><path d="M9 18V5l12-2v13M9 18c0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3 3 1.34 3 3zM21 16c0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3 3 1.34 3 3z"/></svg></div>`;
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="listen_invite" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="width:210px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
                <div style="padding:10px 14px 8px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border)">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
                  <span style="font-size:11px;color:var(--accent);font-weight:600">一起听邀请</span>
                </div>
                <div style="padding:12px 14px 10px;display:flex;gap:10px;align-items:center">
                  ${coverEl}
                  <div style="min-width:0;flex:1">
                    <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.musicTitle || '歌曲')}</div>
                    <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.musicArtist || '')}</div>
                  </div>
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        // 一起听·结束卡片
        if (m.type === 'listen_end') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="listen_end" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="width:210px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
                <div style="padding:12px 14px;display:flex;align-items:center;gap:8px">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                  <span style="font-size:12px;color:var(--text-secondary)">已结束一起听</span>
                </div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        // 商品卡片气泡
        if (m.type === 'product') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="product" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
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
                <div style="padding:2px 14px 10px;display:flex;align-items:center;justify-content:space-between">
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
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="${m.type}" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
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
                <div style="padding:2px 14px 10px">
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
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="photo" style="cursor:pointer;align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div class="phone-camera-polaroid" onclick="Phone._showChatPhotoDetail('${contactId}', '${m.id}')" style="opacity:1;margin:0;width:150px;min-height:150px;transform:none;cursor:pointer">
                <div class="phone-camera-polaroid-frame" style="padding:8px 8px 28px">${innerHtml}</div>
              </div>
              ${time}
            </div>
          </div>`;
        }

        return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" style="cursor:pointer;align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
          <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
          <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
            <div style="max-width:100%;padding:8px 12px;border-radius:18px;${mine ? 'border-bottom-right-radius:4px' : 'border-bottom-left-radius:4px'};font-size:14px;line-height:1.5;background:${mine ? 'var(--accent);color:#fff' : 'var(--bg-tertiary);color:var(--text)'};word-break:break-word">${Utils.escapeHtml(m.text || '')}</div>
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
<!-- 转账 -->
        <button class="phone-plus-item" onclick="Phone._openChatTransfer('${contactId}')" style="display:flex;flex-direction:column;align-items:center;gap:6px;background:none;border:none;padding:0;cursor:pointer">
          <div style="width:50px;height:50px;border-radius:14px;background:var(--bg-tertiary);color:var(--text);display:flex;align-items:center;justify-content:center">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
          </div>
          <span style="font-size:11px;color:var(--text-secondary)">转账</span>
        </button>
        <!-- 语音通话 -->
        <button class="phone-plus-item" onclick="Phone._openCall('${contactId}','voice')" style="display:flex;flex-direction:column;align-items:center;gap:6px;background:none;border:none;padding:0;cursor:pointer">
          <div style="width:50px;height:50px;border-radius:14px;background:var(--bg-tertiary);color:var(--text);display:flex;align-items:center;justify-content:center">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          </div>
          <span style="font-size:11px;color:var(--text-secondary)">语音通话</span>
        </button>
        <!-- 视频通话 -->
        <button class="phone-plus-item" onclick="Phone._openCall('${contactId}','video')" style="display:flex;flex-direction:column;align-items:center;gap:6px;background:none;border:none;padding:0;cursor:pointer">
          <div style="width:50px;height:50px;border-radius:14px;background:var(--bg-tertiary);color:var(--text);display:flex;align-items:center;justify-content:center">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 2 5 5-5 5"/><path d="M21 7H9"/><path d="m8 22-5-5 5-5"/><path d="M3 17h12"/></svg>
          </div>
          <span style="font-size:11px;color:var(--text-secondary)">视频通话</span>
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
    const newText = await UI.showSimpleInput('编辑消息', msg.text || '', { multiline: true, rows: 4, minHeight: '100px' });
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
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="voice" style="cursor:pointer;align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
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
          const transferTitle = mine ? `向${Utils.escapeHtml(contact.nickname || contact.name)}转账` : `${Utils.escapeHtml(contact.nickname || contact.name)}向你转账`;
          const claimed = !!m.transferClaimed;
          const claimBar = (!mine)
            ? `<div style="padding:8px 14px;border-top:1px solid var(--border);font-size:12px;color:${claimed ? 'var(--text-secondary)' : 'var(--accent)'};${claimed ? 'opacity:0.7' : 'cursor:pointer'}" ${claimed ? '' : `onclick="Phone._claimTransfer('${Utils.escapeHtml(contact.id)}','${m.id}')"`}>${claimed ? '已收取' : '点击收取'}</div>`
            : '';
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="transfer" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="width:240px;border-radius:12px;overflow:hidden;border:1px solid var(--border);background:var(--bg-secondary)">
                <div style="background:linear-gradient(135deg,var(--accent),#e8a040);padding:12px 14px;display:flex;align-items:center;gap:8px">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
                  <span style="font-size:13px;font-weight:600;color:#fff">${transferTitle}</span>
                </div>
                <div style="padding:14px">
                  <div style="font-size:20px;font-weight:700;color:var(--text)">¥${Utils.escapeHtml(String(m.transferAmount || 0))}</div>
                </div>
                ${claimBar}
              </div>
              ${time}
            </div>
          </div>`;
        }

    // 位置气泡
    if (m.type === 'location') {
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="location" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
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
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="order" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
          <div onclick="Phone._showOrderDetail('${Utils.escapeHtml(m.orderName || '')}','${Utils.escapeHtml(String(m.orderPrice || ''))}','${Utils.escapeHtml(m.orderShop || '')}','${Utils.escapeHtml(m.orderPlatform || '')}')" style="width:210px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary);cursor:pointer">
            <div style="padding:10px 14px 8px;display:flex;align-items:center;gap:8px">
              <svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='var(--accent)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z'/><line x1='3' x2='21' y1='6' y2='6'/><path d='M16 10a4 4 0 0 1-8 0'/></svg>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.orderName || '订单')}</div>
                ${m.orderShop ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.orderShop)}</div>` : ''}
              </div>
              ${m.orderPrice ? `<span style="font-size:13px;font-weight:700;color:var(--accent);flex-shrink:0">¥${Utils.escapeHtml(String(m.orderPrice))}</span>` : ''}
            </div>
            <div style="padding:2px 14px 10px;display:flex;align-items:center;gap:6px">
              ${m.orderPlatform ? `<span style="font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--text-secondary)">${Utils.escapeHtml(m.orderPlatform)}</span>` : ''}
              <span style="font-size:10px;color:var(--text-secondary)">点击查看详情</span>
            </div>
          </div>
          ${time}
        </div>
      </div>`;
    }

    // 出售卡片气泡（char 卖货给 user，可点击购买）
    if (m.type === 'sell_offer') {
      const dLabel = m.sellDelivery === 'express' ? '快递' : m.sellDelivery === 'errand' ? '跑腿' : '即刻交付';
      const etaLabel = (m.sellDelivery !== 'instant' && m.sellEta) ? `${m.sellEta}${m.sellEtaUnit === 'day' ? '天' : '分钟'}达` : '';
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="sell_offer" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
          <div ${mine ? '' : `onclick="Phone._showSellDetail(\'${Utils.escapeHtml(contact.id)}\',\'${m.id}\')"`} style="width:218px;height:112px;box-sizing:border-box;border-radius:14px;overflow:hidden;background:var(--bg-tertiary);display:flex;flex-direction:column;justify-content:space-between;padding:12px 0${mine ? '' : ';cursor:pointer'}">
            <div style="padding:0 14px 6px;display:flex;align-items:center;gap:8px">
              <svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='var(--accent)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 9l1-5h16l1 5'/><path d='M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9'/><path d='M9 13h6'/></svg>
              <div style="flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.sellName || '商品')}</div>
              <span style="font-size:13px;font-weight:700;color:var(--accent);flex-shrink:0">${Utils.escapeHtml(String(m.sellPrice || 0))}</span>
            </div>
            <div style="padding:0 14px 8px">
              ${m.sellDesc ? `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.sellDesc)}</div>` : ''}
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--text-secondary)">${dLabel}</span>
                ${etaLabel ? `<span style="font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--text-secondary)">${etaLabel}</span>` : ''}
              </div>
            </div>
            <div style="padding:0 14px;text-align:center;font-size:12px;color:${m.sellBought ? 'var(--text-secondary)' : 'var(--accent)'}">${m.sellBought ? '已购买' : (mine ? '出售商品' : '点击查看详情')}</div>
          </div>
          ${time}
        </div>
      </div>`;
    }

    // 地点链接气泡
    // 好友圈动态气泡
        if (m.type === 'moment') {
          return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="moment" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
            <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
            <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
              <div style="max-width:220px;border-radius:14px;overflow:hidden;background:var(--bg-tertiary)">
                <div style="padding:10px 14px;display:flex;align-items:center;gap:8px">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                  <span style="font-size:12px;font-weight:600;color:var(--accent)">发了一条好友圈</span>
                </div>
                <div style="padding:4px 14px 10px;font-size:13px;color:var(--text);line-height:1.5;word-break:break-word">${Utils.escapeHtml(m.momentText || m.text || '')}</div>
              </div>
              ${time}
            </div>
          </div>`;
        }

    if (m.type === 'map_place') {
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="map_place" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
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
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="product" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
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
            <div style="padding:2px 14px 10px;display:flex;align-items:center;justify-content:space-between">
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
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="product" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
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
            <div style="padding:2px 14px 10px;display:flex;align-items:center;justify-content:space-between">
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
      return `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="${m.type}" style="align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
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
            <div style="padding:2px 14px 10px">
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
      
      const bubbleHtml = `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" data-type="photo" style="cursor:pointer;align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
        <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
        <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
          ${photoHtml}
          ${time}
        </div>
      </div>`;
      return bubbleHtml;
    }
    
const bubbleHtml = `<div class="phone-chat-msg-bubble" data-msg-id="${m.id}" data-role="${m.role}" style="cursor:pointer;align-items:flex-end;display:flex;gap:8px;margin-bottom:12px${mine ? ';flex-direction:row-reverse' : ''}">
          <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${mine ? meAvatarInner : avatarInner}</div>
          <div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end' : 'align-items:flex-start'};min-width:0">
            <div style="max-width:100%;padding:8px 12px;border-radius:18px;${mine ? 'border-bottom-right-radius:4px' : 'border-bottom-left-radius:4px'};font-size:14px;line-height:1.5;background:${mine ? 'var(--accent);color:#fff' : 'var(--bg-tertiary);color:var(--text)'};word-break:break-word">${Utils.escapeHtml(m.text || '')}</div>
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
      const keySet = new Set();
      for (const m of arr) {
        if (m._k) keySet.add(m._k);
        // 按名字+内容去重（忽略时间），防止主线复述被重复收录
        if (m.role === 'them' && m.text) keySet.add(`${ct.name || ct.id}||${m.text}`);
      }
      seenKeyByContact[ct.id] = keySet;
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
      let time = (cm.time || '').trim();
      // 如果AI只写了时分(如"15:02")，用消息对应的statusSnapshot或当前状态栏日期补全
      if (time && /^\d{1,2}:\d{2}$/.test(time)) {
        let datePart = '';
        try {
          const sbTime = msg.statusSnapshot?.time || Conversations.getStatusBar()?.time || '';
          // 从绝对时间里提取日期部分（去掉时分）
          const dateMatch = sbTime.match(/^(.+?)\s+\d{1,2}:\d{2}$/);
          if (dateMatch) datePart = dateMatch[1] + ' ';
        } catch(_) {}
        time = datePart + time;
      }
      // 去重 key 必须在格式化前生成（保持和旧数据的 _k 一致，避免格式变化导致重复收录）
      const key = `${npc}|${time}|${text}`;
      // 统一格式化：让主线收录的时间和手机AI回复的时间格式一致
      time = _formatPhoneTime(time) || time;
      const ct = ensureContact(npc);
      if (!pd.chatThreads[ct.id]) pd.chatThreads[ct.id] = [];
      if (!seenKeyByContact[ct.id]) seenKeyByContact[ct.id] = new Set();
      if (seenKeyByContact[ct.id].has(key)) continue;
      // 二次去重：按名字+内容（忽略时间），防止主线AI复述手机聊天内容被重复收录
      const contentKey = `${npc}||${text}`;
      if (seenKeyByContact[ct.id].has(contentKey)) continue;
      seenKeyByContact[ct.id].add(key);
      seenKeyByContact[ct.id].add(contentKey);
      pd.chatThreads[ct.id].push({
        id: 'm_' + Utils.uuid().slice(0, 8),
        role: 'them',
        text,
        time,            // 游戏内时间（已格式化）
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

  // 重置立绘临时态（null=本次未改动）
  _chatTempCallPortrait = null;

  const body = document.getElementById('phone-body');
  if (!body) return;

  const nickname = contact.nickname || '';
  const voiceEnabled = !!contact.voiceEnabled;
  const voiceId = contact.voiceId || '';
  const callAutoPlay = contact.callAutoPlay !== false; // 默认开

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
          <div id="chat-settings-call-autoplay-row" style="display:${voiceEnabled ? 'flex' : 'none'};align-items:center;padding:13px 14px;border-top:1px solid var(--border)">
            <span style="flex:1;font-size:14px;color:var(--text)">通话自动播放语音</span>
            <label style="position:relative;width:44px;height:26px;cursor:pointer;flex-shrink:0">
              <input id="chat-settings-call-autoplay" type="checkbox" ${callAutoPlay ? 'checked' : ''} onchange="Phone._onChatSettingsCallAutoPlayToggle()"
                style="opacity:0;width:0;height:0;position:absolute">
              <span id="chat-settings-call-autoplay-track" style="position:absolute;inset:0;border-radius:13px;background:${callAutoPlay ? 'var(--accent)' : 'var(--border)'};transition:background .2s">
                <span style="position:absolute;top:3px;left:${callAutoPlay ? '21px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></span>
              </span>
            </label>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;padding:0 4px">启用后 AI 回复将通过语音播放；通话自动播放开启后接通电话会自动朗读台词</div>
      </div>

      <div style="margin-bottom:24px">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;font-weight:500;letter-spacing:.04em">线下互动</div>
        <div style="background:var(--bg-tertiary);border-radius:12px;overflow:hidden">
          <div style="display:flex;align-items:center;padding:13px 14px">
            <span style="flex:1;font-size:14px;color:var(--text)">允许角色打断看手机</span>
            <label style="position:relative;width:44px;height:26px;cursor:pointer;flex-shrink:0">
              <input id="chat-settings-phone-down" type="checkbox" ${contact.allowPhoneDown !== false ? 'checked' : ''} onchange="Phone._onChatSettingsPhoneDownToggle()"
                style="opacity:0;width:0;height:0;position:absolute">
              <span id="chat-settings-phone-down-track" style="position:absolute;inset:0;border-radius:13px;background:${contact.allowPhoneDown !== false ? 'var(--accent)' : 'var(--border)'};transition:background .2s">
                <span style="position:absolute;top:3px;left:${contact.allowPhoneDown !== false ? '21px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></span>
              </span>
            </label>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;padding:0 4px">开启后，在场角色可在聊天中打断你看手机并触发线下剧情</div>
      </div>

      <div style="margin-bottom:24px">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;font-weight:500;letter-spacing:.04em">视频通话立绘</div>
        <div style="background:var(--bg-tertiary);border-radius:12px;overflow:hidden;padding:14px">
          <div style="display:flex;gap:12px;align-items:center">
            <div id="chat-settings-portrait-preview" style="width:54px;height:72px;border-radius:10px;border:1px solid var(--border);background:var(--bg-secondary);background-size:cover;background-position:center top;flex-shrink:0;${(contact.callPortrait || '') ? `background-image:url('${Utils.escapeHtml(contact.callPortrait)}')` : ''}"></div>
            <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:8px">
              <button type="button" onclick="Phone._chatPickCallPortrait()" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text);font-size:13px;cursor:pointer">选择立绘</button>
              <button type="button" onclick="Phone._chatClearCallPortrait()" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text-secondary);font-size:13px;cursor:pointer">清除</button>
            </div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;padding:0 4px">视频通话时铺满全屏作为背景，留空则用聊天头像</div>
      </div>

      <div style="margin-bottom:24px">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;font-weight:500;letter-spacing:.04em">上下文</div>
        <div style="background:var(--bg-tertiary);border-radius:12px;overflow:hidden">
          <div style="display:flex;align-items:center;padding:13px 14px">
            <span style="flex:1;font-size:14px;color:var(--text)">发送历史条数</span>
            <input id="chat-settings-history-limit" type="number" min="5" max="50" value="${contact.chatHistoryLimit || 20}"
              style="width:60px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text);font-size:14px;text-align:center;outline:none">
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;padding:0 4px">每次请求AI时发送的最近聊天记录条数（5-50，默认20）</div>
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

// phoneDown 开关联动
function _onChatSettingsPhoneDownToggle() {
  const cb = document.getElementById('chat-settings-phone-down');
  const track = document.getElementById('chat-settings-phone-down-track');
  const knob = track ? track.querySelector('span') : null;
  if (!cb) return;
  const on = cb.checked;
  if (track) track.style.background = on ? 'var(--accent)' : 'var(--border)';
  if (knob) knob.style.left = on ? '21px' : '3px';
}

// 语音开关联动显示音色 ID 输入框
function _onChatSettingsVoiceToggle() {
    const cb = document.getElementById('chat-settings-voice-enabled');
    const row = document.getElementById('chat-settings-voice-id-row');
    const callRow = document.getElementById('chat-settings-call-autoplay-row');
    const track = document.getElementById('chat-settings-voice-track');
    const knob = track ? track.querySelector('span') : null;
    if (!cb) return;
    const on = cb.checked;
    if (row) row.style.display = on ? 'flex' : 'none';
    if (callRow) callRow.style.display = on ? 'flex' : 'none';
    if (track) track.style.background = on ? 'var(--accent)' : 'var(--border)';
    if (knob) knob.style.left = on ? '21px' : '3px';
  }

  function _onChatSettingsCallAutoPlayToggle() {
    const cb = document.getElementById('chat-settings-call-autoplay');
    const track = document.getElementById('chat-settings-call-autoplay-track');
    const knob = track ? track.querySelector('span') : null;
    if (!cb) return;
    const on = cb.checked;
    if (track) track.style.background = on ? 'var(--accent)' : 'var(--border)';
    if (knob) knob.style.left = on ? '21px' : '3px';
  }

// 视频通话立绘：选择 / 清除（用临时变量暂存，保存时落库）
let _chatTempCallPortrait = null; // null=未改动，''=已清除，string=新图
function _chatPickCallPortrait() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      // 立绘要铺满竖屏，用较大尺寸压缩
      const dataUrl = await _compressWallpaper(file, { maxW: 900, maxH: 1600, quality: 0.85 });
      _chatTempCallPortrait = dataUrl;
      const prev = document.getElementById('chat-settings-portrait-preview');
      if (prev) prev.style.backgroundImage = `url("${dataUrl}")`;
    } catch (e) {
      UI.showToast('图片处理失败', 1500);
    }
  };
  input.click();
}
function _chatClearCallPortrait() {
  _chatTempCallPortrait = '';
  const prev = document.getElementById('chat-settings-portrait-preview');
  if (prev) prev.style.backgroundImage = '';
}

// 保存聊天设置
async function _saveChatSettings(contactId) {
  const nicknameEl = document.getElementById('chat-settings-nickname');
  const voiceEnabledEl = document.getElementById('chat-settings-voice-enabled');
  const voiceIdEl = document.getElementById('chat-settings-voice-id');
  const phoneDownEl = document.getElementById('chat-settings-phone-down');
  const pd = await _getPhoneData();
  const contact = (pd.chatContacts || []).find(c => c.id === contactId);
  if (!contact) return;
  contact.nickname = (nicknameEl?.value || '').trim();
  contact.voiceEnabled = !!(voiceEnabledEl?.checked);
  contact.voiceId = (voiceIdEl?.value || '').trim();
  contact.allowPhoneDown = phoneDownEl ? !!(phoneDownEl.checked) : true;
  const callAutoPlayEl = document.getElementById('chat-settings-call-autoplay');
  if (callAutoPlayEl) contact.callAutoPlay = !!(callAutoPlayEl.checked);
  // 视频通话立绘：仅在用户改动过时写入（null 表示未改动）
  if (_chatTempCallPortrait !== null) {
    contact.callPortrait = _chatTempCallPortrait;
  }
  const historyLimitEl = document.getElementById('chat-settings-history-limit');
  if (historyLimitEl) {
    let lim = parseInt(historyLimitEl.value, 10);
    if (isNaN(lim)) lim = 20;
    lim = Math.max(5, Math.min(50, lim)); // 钳到 5-50
    contact.chatHistoryLimit = lim;
  }
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
    try { fullCtx = await _buildFullContext({ npcBrief: true }); } catch(_) {}

    // ④ 手机内最近N条聊天记录（N 由联系人设置 chatHistoryLimit 控制，默认20）
    const _histLimit = Math.max(5, Math.min(50, parseInt(contact.chatHistoryLimit, 10) || 20));
    const recent = thread.slice(-_histLimit);
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
      if (m.type === 'shop_listing') return `${who}：${t}发送了一条商品链接：${m.listingName || ''}（${m.listingPrice || 0} ${m.listingCurName || ''}）`;
      if (m.type === 'order') return `${who}：${t}发送了一条订单信息（${who}已购）：${m.orderName || ''}${m.orderPrice ? '（¥' + m.orderPrice + '）' : ''}${m.orderPlatform ? ' · ' + m.orderPlatform : ''}`;
      if (m.type === 'transfer') {
        if (m.role === 'me') return `${who}：${t}向${contact.name}转账 ¥${m.transferAmount || 0}`;
        return `${who}：${t}向{{user}}转账 ¥${m.transferAmount || 0}，${m.transferClaimed ? '{{user}}已接收转账' : '{{user}}尚未接收转账'}`;
      }
      if (m.type === 'sell_offer') return `${who}：${t}向{{user}}出售商品「${m.sellName || ''}」（售价 ${m.sellPrice || 0}），${m.sellBought ? '{{user}}已购买该商品' : '{{user}}尚未购买'}`;
if (m.type === 'moment') return `${who}：${t}发了一条好友圈动态：${m.momentText || m.text || ''}`;
      return `${who}：${t}${m.text}`;
    }).join('\n');

    // 当前游戏时间
    let gameTime = '';
    try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}

    const voiceInstruction = contact.voiceEnabled ? `
6. 你可以选择以语音形式发送某些消息（比如情绪饱满、语气强烈或亲近的话语）。语音消息使用以下格式：[语音]消息内容。例如：[语音]快来找我！。普通文字消息不需要任何前缀。` : '';

    // phoneDown：仅当该联系人允许打断（allowPhoneDown !== false）且当前在场时，才告诉 AI 有这个选项。
    // 不在场的人无法物理打断玩家看手机，所以根本不提，AI 不会知道有这个能力。
    let canPhoneDown = false;
    try {
      if (contact.allowPhoneDown !== false) {
        // 检查两个来源：NPC.getPresentNPCs()（AI输出解析）和 statusBar.npcs（状态栏持久数据）
        let isPresent = false;
        if (typeof NPC !== 'undefined' && NPC.getPresentNPCs) {
          const present = NPC.getPresentNPCs() || [];
          if (present.includes(contact.name)) isPresent = true;
        }
        if (!isPresent) {
          try {
            const sb = (typeof Conversations !== 'undefined') ? Conversations.getStatusBar() : null;
            if (sb && Array.isArray(sb.npcs)) {
              if (sb.npcs.some(n => n.name === contact.name)) isPresent = true;
            }
          } catch(_) {}
        }
        canPhoneDown = isPresent;
      }
    } catch(_) {}
    const phoneDownInstruction = canPhoneDown ? `
7. 你（${contact.name}）此刻就在玩家身边。如果你有充分的理由让玩家放下手机面对面交流（比如想当面说话、有紧急或重要的事、觉得对方一直盯着手机该被打断了），可以在**最后一条消息**的对象里加上 "phoneDown": true 字段。这会让玩家收起手机，转入你和玩家面对面的线下剧情。注意：不要滥用，只在角色真的会这样做的时候才用；"phoneDown" 只能出现在最后一条消息上。` : '';

    const phoneDownExample = canPhoneDown ? `
  {"npc": "${contact.name}", "text": "别看手机了，看我", "time": "时间", "phoneDown": true}` : '';

    // 一起听：若该联系人正是线上一起听对象，注入邀请/进行中信息
    let ltOnlineBlock = '';
    try {
      if (_ltSession && _ltSession.mode === 'online' && _ltSession.target && _ltSession.target.contactId === contactId) {
        if (_ltSession.pending && _ltSession.invitePrompt) {
          ltOnlineBlock = '\n\n' + _ltSession.invitePrompt;
        } else if (_ltSession.active) {
          const np = _ltBuildOnlineNowPlaying();
          if (np) ltOnlineBlock = '\n\n' + np;
        }
      }
    } catch(_) {}

    // 记忆命中：用最近聊天文本 + 联系人名字检索相关记忆
    let memoryBlock = '';
    try {
      if (typeof Memory !== 'undefined' && Memory.retrieve) {
        const scanText = recent.slice(-6).map(m => m.text || '').join(' ');
        const currentLoc = (() => { try { return NPC.getRegion() || ''; } catch(_) { return ''; } })();
        const relatedMemories = await Memory.retrieve(scanText, [contact.name], currentLoc);
        const memPrompt = Memory.formatForPrompt(relatedMemories);
        if (memPrompt) memoryBlock = '\n\n' + memPrompt;
        // 永久小纸条
        const pinnedNotes = await Memory.getPinnedNotes();
        const pinnedPrompt = Memory.formatPinnedNotesForPrompt(pinnedNotes);
        if (pinnedPrompt) memoryBlock += '\n\n' + pinnedPrompt;
        // 小纸条（情绪记忆碎片）
        const lastMeMsg = [...recent].reverse().find(m => m.role === 'me');
        const notes = await Memory.retrieveNotes([contact.name], lastMeMsg?.text || '');
        const notesPrompt = Memory.formatNotesForPrompt(notes);
        if (notesPrompt) memoryBlock += '\n\n' + notesPrompt;
      }
    } catch(_) {}

    // 日历日程提醒（同款给线上联系人一份）：今日事项 + 明日生日/节日
    // 只读，不消费 calendarReminded 标记，避免干扰主线一次性提醒
    let calendarBlock = '';
    try {
      if (pd?.calendarEvents?.length) {
        const _calSb = Conversations.getStatusBar() || {};
        const _calTime = (typeof Calendar !== 'undefined' && _calSb.time) ? Calendar.parseAbsoluteTime(_calSb.time) : null;
        if (_calTime) {
          const _calRules = _getCalRulesCached();
          let _tomorrow = null;
          try {
            _tomorrow = Calendar.addDelta(_calTime, { days: 1 }, _calRules);
          } catch(_) {
            const _d = new Date(_calTime.year, _calTime.month - 1, _calTime.day + 1);
            _tomorrow = { year: _d.getFullYear(), month: _d.getMonth() + 1, day: _d.getDate() };
          }
          const _hitsDate = (ev, t) => {
            if (!t) return false;
            let match = false;
            if (ev.repeat === 'monthly') match = true;
            else if (ev.repeat === 'yearly') match = (ev.month === t.month);
            else match = (ev.month === t.month && (!ev.year || ev.year === t.year));
            if (!match) return false;
            const dur = Math.max(1, ev.duration || 1);
            return t.day >= ev.day && t.day < ev.day + dur;
          };
          const _calTypeNames = { birthday: '生日', todo: '待办', period: '经期', holiday: '节日', note: '备忘' };
          const _todayLines = [], _aheadLines = [];
          for (const ev of pd.calendarEvents) {
            if (ev.fromWv) continue;
            const _isBirthFest = (ev.type === 'birthday' || ev.type === 'holiday');
            const _tn = _calTypeNames[ev.type] || '事项';
            const _line = `· ${_tn}：${ev.title}${ev.note ? '（' + ev.note + '）' : ''}`;
            if (_hitsDate(ev, _calTime)) _todayLines.push(_line);
            else if (_isBirthFest && _hitsDate(ev, _tomorrow)) _aheadLines.push(`${_line}（明天）`);
          }
          const _calBlocks = [];
          if (_todayLines.length) _calBlocks.push(`【{{user}}的今日日程】\n${_todayLines.join('\n')}`);
          if (_aheadLines.length) _calBlocks.push(`【{{user}}的明日日程】\n${_aheadLines.join('\n')}`);
          if (_calBlocks.length) {
            calendarBlock = '\n\n' + _calBlocks.join('\n\n') + '\n以上是{{user}}手机日历里的日程，仅供参考。如果和你无关，无需特意提及；若与你相关（如你们的约定、对方的生日节日等），可以自然地在私聊里体现关心或互动，已经提过的不必重复强调。';
          }
        }
      }
    } catch(_) {}

    // 好友圈动态：玩家发的（该联系人可见）+ 联系人自己发的，各取最近2条
    let momentsBlock = '';
    try {
      const myMoments = pd.moments || [];
      const npcMoments = pd.npcMoments || [];
      const cName = contact.name;
      const myRecent = myMoments.filter(m => !m.visibleNpcs || m.visibleNpcs.length === 0 || m.visibleNpcs.includes(cName)).slice(-2).reverse();
      const npcRecent = npcMoments.filter(m => m.npc === cName).slice(-2).reverse();
      const lines = [];
      for (const m of myRecent) {
        const t = m.time ? `[${_formatPhoneTime(m.time)}] ` : '';
        const vis = m.visibleNpcs && m.visibleNpcs.length ? `（可见范围：${m.visibleNpcs.join('、')}）` : '';
        const cmt = (m.comments && m.comments.length) ? ` [${m.comments.length}条评论]` : '';
        lines.push(`· ${myName} 发了一条动态：${t}${Utils.escapeHtml(m.text || '')}${vis}${cmt}`);
      }
      for (const m of npcRecent) {
        const cmt = (m.comments && m.comments.length) ? ` [${m.comments.length}条评论]` : '';
        lines.push(`· ${cName} 发了一条动态：${Utils.escapeHtml(m.text || '')}${cmt}`);
      }
      if (lines.length) {
        momentsBlock = '\n\n【最近好友圈动态】\n' + lines.join('\n') + '\n你和玩家已经在私聊里聊过的朋友圈内容，不必重复提起。';
      }
    } catch(_) {}

    const systemPrompt = `${fullCtx}${memoryBlock}

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
5. **必须用以下 JSON 格式输出**，放在 \`\`\`chat 代码块里，每条消息一个对象，time 用游戏内时间（"${gameTime || 'YYYY.MM.DD 星期X HH:mm'}"格式，可比玩家发消息的时间稍晚一点）：${voiceInstruction}${phoneDownInstruction}
${voiceInstruction ? '8' : '7'}. 除了普通文字消息，你还可以发送以下特殊类型的消息（在对象里加 "type" 字段，**不要用纯文字描述这些行为**，必须使用 type 字段让前端渲染为卡片）：
   - **图片**：{"npc":"...", "type":"image", "desc":"对图片内容的描述（如：一张窗外的夕阳照片）", "time":"..."}
   - **位置**：{"npc":"...", "type":"location", "location":"地点名", "address":"详细地址（可选）", "time":"..."}
   - **订单**（为{{user}}购买物品时使用，如外卖、网购、跑腿代买等通过网络下单的内容）：{"npc":"...", "type":"order", "name":"商品名", "price":数字金额, "desc":"备注（可选）", "eta":数字, "etaUnit":"min或day", "time":"..."}
   · eta 是预计送达所需时间，etaUnit 为 "min"（分钟，用于跑腿/外卖等当天送达）或 "day"（天，用于网购快递）。例如外卖填 {"eta":30,"etaUnit":"min"}，快递填 {"eta":3,"etaUnit":"day"}。该物品会进入{{user}}手机里的物流系统，送达后系统会提示{{user}}收货，请勿在送达前描写{{user}}已收到。
   - **转账**：{"npc":"...", "type":"transfer", "amount":数字金额, "time":"..."}
 - **出售/兜售**（你（NPC）想把某件物品**卖给**{{user}}，需要{{user}}付钱购买时使用，区别于"订单"——订单是你帮{{user}}买东西，出售是你向{{user}}推销自己的东西）：{"npc":"...", "type":"sell", "name":"商品名", "price":数字金额, "desc":"商品描述（可选）", "delivery":"instant或errand或express", "eta":数字, "etaUnit":"min或day", "time":"..."}
 · delivery 为交付方式："instant"=当面/即刻交付（无需配送，{{user}}付款后立即到手）；"errand"=跑腿/同城速递（填 eta 分钟数，etaUnit:"min"）；"express"=快递（填 eta 天数，etaUnit:"day"）。{{user}}会看到一张商品卡片，**由{{user}}自行决定买不买**，点击「购买」后前端自动从其钱包扣款，你无需在台词里描写扣款或金额变动。付款后非即刻交付的会进入物流系统，送达后系统提示收货。
 注意：转账金额必须符合你的人设财力和世界观中的货币购买力，不要随意转大额。特殊消息不需要 "text" 字段。禁止用纯文字如"【转账】""[图片]"来代替，必须使用 type 字段。
   - **好友圈动态**：如果你觉得此刻角色会发一条朋友圈（比如心里有感触、想分享什么、记录当下的心情），可以在消息里加一条 type 为 "moment" 的对象：{"npc":"...", "type":"moment", "text":"动态文字内容", "time":"..."}
  · 这是纯文字动态，不需要图片。发出后会出现在玩家的好友圈里。
  · **不是每轮都要发**，只有在角色确实有想说的话、想记录的事时才发——比如心情波动、看到什么有趣的、深夜感慨、想卖萌之类。日常闲聊不需要额外发动态。如果你判断此刻角色不会特意去发朋友圈，就不要加。
  · 不要和聊天内容重复——动态是角色"公开说的话"，私聊是"一对一说的话"，语气和内容应该有区别。

   【打电话】如果此刻「${contact.name}」想直接给玩家打语音或视频电话（而不是发消息），可以在 \`\`\`chat 块之后、单独再附加一个 \`\`\`call 代码块来触发来电（玩家手机会响铃，可接听或拒接）：
\`\`\`call
{"mode":"voice 或 video","name":"${contact.name}","firstLine":"接通后的第一段内容。格式：台词行以 > 开头，描述行不加前缀；台词行尾标时间 [HH:MM]；可以描述+台词组合，如：电话那头传来低沉的笑声。\\n> 怎么这个点才回来？ [12:50]"}
\`\`\`
   - voice（语音）：日常联系、交代事、随口说两句、不方便露脸时，多数情况用语音。
   - video（视频）：很想见到玩家、思念、想确认玩家状态/安全/情绪、需要面对面说清楚时；更亲密郑重，别滥用。
   - 只有角色确实想打电话时才用；不想打就别加这个块。如果打了电话，可以只发一两条消息或干脆不发消息（chat 块留空数组），让电话来承载对话。
\`\`\`chat
[
  {"npc": "${contact.name}", "text": "消息内容", "time": "时间"},
  {"npc": "${contact.name}", "type": "image", "desc": "发的图的描述", "time": "时间"},
  {"npc": "${contact.name}", "text": "第二条消息内容（可选）", "time": "时间"}${phoneDownExample}
]
\`\`\`
只输出这个 chat 块（如需打电话可在其后附加一个 \`\`\`call 块），不要输出其它任何内容。${ltOnlineBlock}${calendarBlock}${momentsBlock}`;

    // 游鱼商品提示词注入（一次性消费）
    let youyuChatBlock = '';
    if (pd.youyuChatPrompts && pd.youyuChatPrompts[contactId]) {
      youyuChatBlock = '\n\n' + pd.youyuChatPrompts[contactId];
      delete pd.youyuChatPrompts[contactId];
      await _savePhoneData();
    }

    const apiMessages = [
      { role: 'system', content: systemPrompt + youyuChatBlock },
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

    // 来电：检测 fullReply 里有没有 ```call 块
    // 延迟到所有气泡渲染完（chatArr长度 × 600ms + 1000ms缓冲）后再弹来电
    const _hasCallTag = /```call[\s\S]*?```/.test(fullReply);
    if (_hasCallTag) {
      const _chatArrLen = (() => {
        try {
          const _p = Utils.parseAIOutput(fullReply);
          return (_p && Array.isArray(_p.chat)) ? _p.chat.length : 1;
        } catch(_) { return 1; }
      })();
      const _callDelay = Math.max(1200, _chatArrLen * 600 + 1000);
      setTimeout(() => {
        try { if (typeof handleMainlineCallTag !== 'undefined') handleMainlineCallTag(fullReply); } catch(_) {}
      }, _callDelay);
    }

    // 一起听：处理线上邀请的接受/拒绝标记
    try {
      if (parsed && parsed.listenAccept && _ltSession && _ltSession.mode === 'online'
          && _ltSession.target && _ltSession.target.contactId === contactId) {
        await _ltHandleAccept(parsed.listenAccept);
      }
    } catch(_) {}
    // 一起听：处理留言标记（线上对象）
    try {
      if (parsed && parsed.listenMsg && _ltSession && _ltSession.active
          && _ltSession.mode === 'online'
          && _ltSession.target && _ltSession.target.contactId === contactId) {
        await _ltAddMessage(_ltSession.target.name, parsed.listenMsg);
      }
    } catch(_) {}

    // 游鱼购买标记处理（聊天内购买）
    try {
      if (parsed && parsed.youyuBuy) {
        await _youyuHandleBuy(parsed.youyuBuy);
      }
    } catch(_) {}

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
    let _hasSpecialMsg = false; // 本轮是否出现了特殊卡片消息（图片/位置/订单/转账），用于全量重渲染
    for (let i = 0; i < chatArr.length; i++) {
      const cm = chatArr[i];
      const cmType = (cm.type || '').trim();
      let text = (cm.text || '').trim();

      // 特殊卡片消息（图片/位置/订单/转账/出售）：不依赖 text，单独构造 thread 消息
      if (cmType === 'image' || cmType === 'location' || cmType === 'order' || cmType === 'transfer' || cmType === 'sell' || cmType === 'moment') {
        const msgId = 'm_' + Utils.uuid().slice(0, 8);
        const cmTime = (cm.time || '').trim();
        const baseMsg = { id: msgId, role: 'them', time: cmTime, fromMainline: false, roundId: aiRoundId };
        let logText = '';
        if (cmType === 'image') {
          const desc = (cm.desc || cm.text || '').trim() || '(图片)';
          Object.assign(baseMsg, { type: 'photo', mode: 'ai_text', photoDesc: desc });
          logText = `发送了一张图片：${desc}`;
        } else if (cmType === 'location') {
          Object.assign(baseMsg, { type: 'location', location: (cm.location || '').trim(), address: (cm.address || '').trim() });
          logText = `发送了位置：${baseMsg.location}${baseMsg.address ? '（' + baseMsg.address + '）' : ''}`;
        } else if (cmType === 'order') {
          const amt = parseFloat(cm.price);
          Object.assign(baseMsg, { type: 'order', orderName: (cm.name || '订单').trim(), orderPrice: isNaN(amt) ? '' : amt, orderShop: (cm.desc || '').trim(), orderPlatform: '' });
          logText = `发送了订单：${baseMsg.orderName}${baseMsg.orderPrice !== '' ? '（¥' + baseMsg.orderPrice + '）' : ''}`;
          // 收件：把 char 寄给 {{user}} 的物品纳入物流系统（飞鸟收件），送达时提示收货
          try {
            const eta = parseInt(cm.eta, 10);
            const gameTime = _getGameTime();
            if (Number.isFinite(eta) && eta > 0 && gameTime) {
              const minutes = (cm.etaUnit === 'day') ? eta * 1440 : eta;
              const senderName = (cm.npc || '').trim()
                || (pd2.chatContacts || []).find(c => c.id === contactId)?.name
                || '某人';
              const recvOrder = {
                id: 'order_' + Utils.uuid().slice(0, 8),
                name: (cm.name || '物品').trim(),
                shop: '飞鸟',
                price: isNaN(amt) ? '' : amt,
                desc: (cm.desc || '').trim(),
                target: '自己',
                time: new Date().toLocaleString(),
                status: 'delivering',
                deliveryMinutes: minutes,
                orderGameTime: gameTime,
                feiniaoShip: true,
                feiniaoReceive: true,        // 收件方向：char 寄给 user
                shipMode: minutes < 1440 ? 'errand' : 'express',
                sender: senderName,
                shipItems: [{ name: (cm.name || '物品').trim(), count: 1, effect: (cm.desc || '').trim(), fromInventory: false }],
              };
              const recvField = minutes < 1440 ? 'takeoutOrders' : 'shopOrders';
              pd2[recvField] = pd2[recvField] || [];
              pd2[recvField].push(recvOrder);
              pd2[recvField] = pd2[recvField].slice(-30);
            }
          } catch(_) {}
        } else if (cmType === 'transfer') {
          const amt = parseFloat(cm.amount);
          Object.assign(baseMsg, { type: 'transfer', transferAmount: isNaN(amt) ? 0 : amt, transferClaimed: false });
          logText = `向你转账了 ${baseMsg.transferAmount}`;
        } else if (cmType === 'sell') {
          const amt = parseFloat(cm.price);
          const delivery = ['instant', 'errand', 'express'].includes(cm.delivery) ? cm.delivery : 'instant';
          const eta = parseInt(cm.eta, 10);
          Object.assign(baseMsg, {
            type: 'sell_offer',
            sellName: (cm.name || '商品').trim(),
            sellPrice: isNaN(amt) ? 0 : amt,
            sellDesc: (cm.desc || '').trim(),
            sellDelivery: delivery,
            sellEta: Number.isFinite(eta) && eta > 0 ? eta : 0,
            sellEtaUnit: cm.etaUnit === 'day' ? 'day' : 'min',
            sellSeller: (cm.npc || '').trim() || (pd2.chatContacts || []).find(c => c.id === contactId)?.name || '对方',
            sellBought: false,
          });
          logText = `向你出售「${baseMsg.sellName}」（售价 ${baseMsg.sellPrice}）`;
        } else if (cmType === 'moment') {
          const momentText = (cm.text || '').trim();
          Object.assign(baseMsg, { type: 'moment', momentText });
          logText = `发了一条好友圈动态：${momentText}`;
          // 存入 npcMoments
          try {
            const npcName = (cm.npc || '').trim() || contact.name;
            if (momentText) {
              if (!pd2.npcMoments) pd2.npcMoments = [];
              pd2.npcMoments.push({ npc: npcName, text: momentText, comments: [] });
              pd2.npcMoments = pd2.npcMoments.slice(-50); // 最多保留50条
            }
          } catch(_) {}
        }
        pd2.chatThreads[contactId].push(baseMsg);
        if (cmTime) lastAiTime = cmTime;
        _addChatMessageToRoundLog(contactId, 'them', logText, cmTime, contact.name);
        _hasSpecialMsg = true;
        n++;
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }

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
          el.innerHTML = `<div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${avatarInner}</div><div style="display:flex;flex-direction:column;align-items:flex-start;min-width:0"><div style="max-width:100%;padding:8px 12px;border-radius:18px;border-bottom-left-radius:4px;font-size:14px;line-height:1.5;background:var(--bg-tertiary);color:var(--text);word-break:break-word">${Utils.escapeHtml(text)}</div>${cmTime ? `<div style="font-size:10px;color:var(--text-secondary);margin-top:2px">${Utils.escapeHtml(cmTime)}</div>` : ''}</div>`;
        }
        list.appendChild(el);
        list.scrollTop = list.scrollHeight;
      }

      n++;

      // phoneDown 检测：渲染完这条后，如果带 phoneDown 标记，收手机并存 pending
      if (cm.phoneDown) {
        await new Promise(r => setTimeout(r, 800)); // 让用户看清最后这句
        // flush 操作日志（已含完整聊天记录）—— 直接调内部函数，不走 Phone.xxx（IIFE 内部 Phone 对象尚未暴露）
        let phoneActionLog = '';
        try {
          const flushed = flushActionLog();
          if (Array.isArray(flushed)) phoneActionLog = flushed.join('\n');
          else if (typeof flushed === 'string') phoneActionLog = flushed;
        } catch(_) {}
        // 先存 pending，再 close —— close 末尾会检测 pending 并触发主线回复
        _pendingPhoneDown = {
          contactName: contact.name,
          actionLog: phoneActionLog
        };
        if (_isOpen) close();
        break; // 后面的消息丢弃
      }
    }
    
    if (n > 0) {
      await _savePhoneData();
      // 本轮有特殊卡片消息（图片/位置/订单/转账）：全量重渲染让卡片正确显示（无淡入动画）
      if (_hasSpecialMsg) {
        try { _renderChatThread(pd2, contactId); } catch(_) {}
      }
      if (lastAiTime) _chatSessionBaseTime = lastAiTime; // 更新跨联系人基准时间
      // 线上聊天推进主线状态栏时间（只增不减）：
      // 把本轮 AI 给的最新聊天时间写回状态栏，让"在手机上聊天消耗了时间"反映到主线。
      // 只更新 time 字段，不动 timePeriod/season —— 留给下一次主线 AI 回复时检测跨段/跨季并注入过渡描写。
      try {
        if (lastAiTime && typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime && Calendar.format) {
          await _refreshCalRulesCache(); // 确保拿到当前历法规则（自定义周天名等）
          const sb = (typeof Conversations !== 'undefined') ? Conversations.getStatusBar() : null;
          const oldTimeStr = sb?.time || '';
          // 只增不减：新时间分数 > 当前状态栏时间分数才推进
          const newScore = _parsePhoneTimeScore(lastAiTime);
          const oldScore = _parsePhoneTimeScore(oldTimeStr);
          if (sb && newScore > 0 && newScore > oldScore) {
            const timeObj = Calendar.parseAbsoluteTime(lastAiTime);
            if (timeObj) {
              // 标准化成主线状态栏格式（YYYY年M月D日 周天名 HH:mm），供 chat.js 增量计算依赖
              const stdTime = Calendar.format(timeObj, _calRulesCache);
              if (stdTime) {
                sb.time = stdTime;
                await Conversations.setStatusBar(sb);
                if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(sb);
              }
            }
          }
        }
      } catch(e) { console.warn('[Phone] 聊天推进状态栏时间失败', e); }
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

// ===== 语音/视频通话 =====
let _activeCall = null; // { contactId, mode:'voice'|'video', startTime, rounds:[{role,text}] }
let _callReplyBusy = false;
let _callDialTimer = null;

function _clearCallDialTimer() {
  if (_callDialTimer) {
    clearTimeout(_callDialTimer);
    _callDialTimer = null;
  }
}

function _startCall(contactId, mode) {
  let gameTime = '';
  try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}
  let contactName = '';
  try {
    const convId = Conversations.getCurrent();
    const conv = convId && Conversations.getList().find(c => c.id === convId);
    const c = conv && conv.phoneData && (conv.phoneData.chatContacts || []).find(x => x.id === contactId);
    if (c) contactName = c.name || '';
  } catch(_) {}
  _activeCall = {
    contactId,
    contactName,
    mode: mode || 'voice',
    startTime: gameTime,
    rounds: []
  };
}

function _callSendMessage(text) {
  if (!_activeCall) return;
  if (!text || !text.trim()) return;
  _activeCall.rounds.push({ role: 'me', text: text.trim() });
}

async function _callRequestReply() {
  if (!_activeCall) { UI.showToast('没有进行中的通话', 1500); return; }
  if (_callReplyBusy) { UI.showToast('对方正在说话…', 1200); return; }
  const contactId = _activeCall.contactId;
  try {
    _callReplyBusy = true;
    const pd = await _getPhoneData();
    const contact = (pd.chatContacts || []).find(c => c.id === contactId);
    if (!contact) { UI.showToast('联系人不存在', 1500); return; }

    // ① 角色人设
    let personaStr = contact.name || '未知';
    try {
      const cands = await _collectChatCandidates();
      const cand = cands.find(c => c.name === contact.name);
      if (cand && cand.detail) personaStr += '\n' + cand.detail;
    } catch(_) {}

    // ② 世界观 + 主线上下文
    let fullCtx = '';
    try { fullCtx = await _buildFullContext({ npcBrief: true }); } catch(_) {}

    // ③ 记忆命中
    let memoryBlock = '';
    try {
      if (typeof Memory !== 'undefined' && Memory.retrieve) {
        const scanText = _activeCall.rounds.map(r => r.text).join(' ');
        const currentLoc = (() => { try { return NPC.getRegion() || ''; } catch(_) { return ''; } })();
        const relatedMemories = await Memory.retrieve(scanText, [contact.name], currentLoc);
        const memPrompt = Memory.formatForPrompt(relatedMemories);
        if (memPrompt) memoryBlock = '\n\n' + memPrompt;
        const pinnedNotes = await Memory.getPinnedNotes();
        const pinnedPrompt = Memory.formatPinnedNotesForPrompt(pinnedNotes);
        if (pinnedPrompt) memoryBlock += '\n\n' + pinnedPrompt;
        const lastMe = [..._activeCall.rounds].reverse().find(r => r.role === 'me');
        const notes = await Memory.retrieveNotes([contact.name], lastMe?.text || '');
        const notesPrompt = Memory.formatNotesForPrompt(notes);
        if (notesPrompt) memoryBlock += '\n\n' + notesPrompt;
      }
    } catch(_) {}
// ④ 通话历史
    const myName = (() => { try { const mk = Character.get(); return mk?.name || '我'; } catch(_) { return '我'; } })();
    const callHistStr = _activeCall.rounds.length > 0
      ? _activeCall.rounds.map(r => r.role === 'me' ? `${myName}：${r.text}` : `${contact.name}：\n${r.text}`).join('\n\n')
      : '（通话刚刚接通，尚无对话内容）';

    // ④b 往期通话记录（从 chatThreads 读历史 call_record，最近 2 通）
    // 不依赖主线消息窗口，确保连续打电话也记得之前通过话
    let pastCallsStr = '';
    try {
      const thread = (pd.chatThreads && pd.chatThreads[contactId]) || [];
      const pastCalls = thread.filter(m => m.type === 'call_record' && Array.isArray(m.rounds) && m.rounds.length > 0).slice(-2);
      if (pastCalls.length > 0) {
        pastCallsStr = pastCalls.map(c => {
          const label = c.callMode === 'video' ? '视频通话' : '语音通话';
          // 每通最多带 12 轮，过长截断
          const rs = c.rounds.slice(-12).map(r => r.role === 'me' ? `${myName}：${r.text}` : `${contact.name}：${r.text}`).join('\n');
          return `· ${label}（${c.startTime || '?'} — ${c.endTime || '?'}）\n${rs}`;
        }).join('\n\n');
      }
    } catch(_) {}


    // ⑤ 当前游戏时间
    let gameTime = '';
    try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}

    const isVideo = _activeCall.mode === 'video';
    const modeLabel = isVideo ? '视频通话' : '语音通话';

    // ⑥ 好友圈动态（通话时也注入）
    let callMomentsBlock = '';
    try {
      const myMoments = pd.moments || [];
      const npcMoments = pd.npcMoments || [];
      const cName = contact.name;
      const myRecent = myMoments.filter(m => !m.visibleNpcs || m.visibleNpcs.length === 0 || m.visibleNpcs.includes(cName)).slice(-2).reverse();
      const npcRecent = npcMoments.filter(m => m.npc === cName).slice(-2).reverse();
      const lines = [];
      for (const m of myRecent) {
        const t = m.time ? `[${_formatPhoneTime(m.time)}] ` : '';
        const vis = m.visibleNpcs && m.visibleNpcs.length ? `（可见范围：${m.visibleNpcs.join('、')}）` : '';
        const cmt = (m.comments && m.comments.length) ? ` [${m.comments.length}条评论]` : '';
        lines.push(`· ${myName} 发了一条动态：${t}${Utils.escapeHtml(m.text || '')}${vis}${cmt}`);
      }
      for (const m of npcRecent) {
        const cmt = (m.comments && m.comments.length) ? ` [${m.comments.length}条评论]` : '';
        lines.push(`· ${cName} 发了一条动态：${Utils.escapeHtml(m.text || '')}${cmt}`);
      }
      if (lines.length) {
        callMomentsBlock = '\n\n【最近好友圈动态】\n' + lines.join('\n') + '\n你和玩家已经在通话里聊过的朋友圈内容，不必重复提起。';
      }
    } catch(_) {}

    // ⑦ 视频通话：拼入玩家这侧的画面（场景 / 衣着 / 姿势），让 AI 能"看到"玩家
    let videoSceneStr = '';
    if (isVideo) {
      try {
        const sb = Conversations.getStatusBar() || {};
        const parts = [];
        if (sb.scene) parts.push(`· 玩家所处场景：${sb.scene}`);
        if (sb.playerOutfit) parts.push(`· 玩家此刻的衣着：${sb.playerOutfit}`);
        if (sb.playerPosture) parts.push(`· 玩家此刻的姿势/状态：${sb.playerPosture}`);
        if (parts.length > 0) {
          videoSceneStr = `\n【视频里玩家画面（参考）】（以下来自主线状态栏的最近快照，仅供参考，未必等于通话此刻的真实画面——玩家可能已经走动、换了姿势或环境有变化。请结合通话内容灵活判断，不要逐字照搬，也不要与对话内容明显冲突）\n${parts.join('\n')}\n`;
        }
      } catch(_) {}
    }

    // ⑦ 在场检测：NPC 此刻在玩家身边时，注入挂断进主线的规则提示
    // callDownInstruction 不再由系统自动检测在场，改为始终提供三种挂断标记让 AI 自行判断
    const callDownInstruction = (contact.allowPhoneDown !== false)
      ? `\n7. 【关于 HANGUP:PRESENT】如果你判断自己此刻就在玩家身边（同一空间/面对面/近距离），并且认为挂电话后应该转为线下互动，使用 [HANGUP:PRESENT]。前端会自动让玩家收起手机，转入你和玩家面对面的线下场景。如果你不在玩家身边、或者在身边但不需要转线下，使用普通的 [HANGUP] 即可。`
      : '';

    const sensoryRule = isVideo
      ? '1. 这是实时视频通话，你和玩家能互相看到对方、听到对方的声音。你可以描写声音（语气、呼吸、背景音）和画面（表情、动作、环境、光线），用叙述流呈现。'
      : '1. 这是实时语音通话，你和玩家用声音交流。你只能"听到"，看不到对方的样子、表情、动作和环境——绝对不要描写任何视觉信息（不写"你看他""画面""他穿着""他的表情"等）。只能写声音传达的东西：语气、鼻音、停顿、呼吸、笑声、叹气、衣物摩擦声、背景音等。';

    const systemPrompt = `${fullCtx}${memoryBlock}

【正在通话的角色】
你现在要扮演「${contact.name}」，正在和玩家进行一通【${modeLabel}】。
${personaStr}
${pastCallsStr ? `\n【你和玩家此前的通话记录】（仅供回忆参考，不是本次通话内容）\n${pastCallsStr}\n` : ''}
【本次通话记录】（玩家＝${myName}，对方＝${contact.name}）
${callHistStr}

【通话开始时间】${_activeCall.startTime || gameTime}
${videoSceneStr}
【${modeLabel}规则】
${sensoryRule}
2. 用【叙述流】格式输出，把内容拆成若干「段」，每段单独占一行，按发生先后排列：
   - 描述段：直接写描述文字，不加任何前缀（例：电话响了很久才接通，他的声音裹着浓浓的鼻音，像是刚睡醒）。
   - 台词段：行首加 > 符号，然后写角色说的话，行尾用方括号标注此刻的通话时间 [HH:MM]（例：> 喂？这个点找我。 [02:14]）。
   - 时间从【通话开始时间】起算，随对话自然推进（一般每段间隔几秒到一两分钟），台词段都要带时间标注。
   - 重要：描述段绝对不要加 > 前缀，台词段必须加 > 前缀，这是唯一的区分标识。
3. 你只演「${contact.name}」这一方，但可以一次连续输出多段——像真人打电话那样，一句话没说完接着说、停顿后又补一句、自问自答。可以「描述段→台词段→描述段→台词段」交替。绝对不要替玩家说话、不要描写玩家的任何反应。
4. 符合角色当下状态：先想这个角色此刻在哪、在做什么，据此决定接电话/视频的语气和反应（刚睡醒/在忙/在外面/独自一人）。
5. 不要输出 JSON、不要用代码块、不要加任何前后缀说明，直接输出这段通话叙述正文。绝对禁止输出主线剧情才有的结构化内容：不要出现 \`\`\`relation、\`\`\`task 等代码块或任何键值对数据，不要在台词或描述末尾加 [时间] 时间戳标注。这里只是一通电话，只有声音的描述段和台词段。
6. 如果角色想要主动结束这通电话，在回复的最末尾追加标记（仅标记，不要加其他文字）：
   - [HANGUP]：正常挂断（说了再见、聊到了自然结尾、或有充分的告别理由）。角色不在玩家身边，或在身边但不需要转为线下互动时使用。
   - [HANGUP:BUSY]：不方便接听而挂断（在开会、执行任务、在图书馆/安静场合、紧急情况等）。挂断后前端会自动触发一条线上消息，让角色补发文字解释原因（如"不好意思在开会，待会联系你"）。
   - [HANGUP:PRESENT]：角色此刻就在玩家身边（同一空间/面对面），并且挂断后要转为线下面对面互动。前端会自动让玩家收起手机，转入线下场景。
   三种标记前端都会在台词渲染完毕后自动挂断通话。${callDownInstruction}${callMomentsBlock}`;

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `（请以「${contact.name}」的身份回应玩家在这通${modeLabel}里最新说的话）` }
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

    const replyText = fullReply.trim();
    if (!replyText) { UI.showToast('对方没有回应', 1500); return; }
    _activeCall.rounds.push({ role: 'them', text: replyText });

  } catch(e) {
    UI.showToast('通话回复失败：' + (e.message || '未知'), 2200);
  } finally {
    _callReplyBusy = false;
  }
}

async function _endCall(hangupBy, aiPresent) {
  // hangupBy: 'me'（用户挂断）| 'them'（AI主动挂断）| undefined（默认视为用户）
  // aiPresent: boolean，仅当 AI 用了 [HANGUP:PRESENT] 时为 true
  if (!_activeCall) return;
  const contactId = _activeCall.contactId;
  const mode = _activeCall.mode;
  const startTime = _activeCall.startTime;
  const rounds = _activeCall.rounds;
  const whoHungUp = hangupBy || 'me';

  if (rounds.length === 0) { _activeCall = null; return; }

  const pd = await _getPhoneData();
  const contact = (pd.chatContacts || []).find(c => c.id === contactId);
  const contactName = contact?.name || contactId;
  const myName = (() => { try { const mk = Character.get(); return mk?.name || '我'; } catch(_) { return '我'; } })();

  // 当前游戏时间作为结束时间
  let endTime = '';
  try { const sb = Conversations.getStatusBar(); endTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}

  // 方案3：从通话记录里 AI 标注的台词时间戳 [HH:MM]，取最后一个作为通话实际结束时刻
  // startTime 形如 "YYYY-MM-DD HH:MM" 或带时段；时间戳只有 HH:MM，需要拼回日期
  let callEndStamp = '';
  try {
    for (const r of rounds) {
      if (r.role !== 'them') continue;
      const segs = _parseCallReply(r.text);
      for (const s of segs) { if (s.time) callEndStamp = s.time; }
    }
  } catch(_) {}
  // 用最后一个台词时间戳推回完整结束时间（沿用 startTime 的日期，替换时分）
  let advanceEndTime = '';
  if (callEndStamp) {
    const hm = callEndStamp.split(':');
    const hh = parseInt(hm[0], 10);
    const mm = parseInt(hm[1], 10);
    try {
      if (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime && Calendar.format) {
        await _refreshCalRulesCache();
        const baseObj = Calendar.parseAbsoluteTime(startTime || endTime);
        if (baseObj && !isNaN(hh) && !isNaN(mm)) {
          baseObj.hour = hh;
          baseObj.minute = mm;
          advanceEndTime = Calendar.format(baseObj, _calRulesCache) || '';
        }
      }
    } catch(_) {}
    // 历法解析失败的兜底：直接用 startTime 的日期段（支持 . - / 分隔）+ 时分
    if (!advanceEndTime) {
      const dateMatch = String(startTime || '').match(/^(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/);
      advanceEndTime = dateMatch ? `${dateMatch[1]} ${callEndStamp}` : callEndStamp;
    }
  }
  // 有 AI 标注的时间戳就用它作为结束时间（显示+推进），否则沿用当前状态栏时间
  if (advanceEndTime) endTime = advanceEndTime;

  // ① 写进 chatThreads（通话记录卡片）
  if (!pd.chatThreads) pd.chatThreads = {};
  if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
  pd.chatThreads[contactId].push({
    id: 'call_' + Utils.uuid().slice(0, 8),
    role: 'them',
    type: 'call_record',
    callMode: mode,
    startTime,
    endTime,
    rounds: rounds.slice(),
    time: endTime || startTime,
    hangupBy: whoHungUp,
    fromMainline: false
  });

  // ② 压成文本写进主线 messages
  const modeLabel = mode === 'video' ? '视频通话' : '语音通话';
  const transcript = rounds.map(r => {
    if (r.role === 'me') return `${myName}：${r.text}`;
    return `${contactName}：\n${r.text}`;
  }).join('\n\n');
  const hangupLabel = whoHungUp === 'them' ? `${contactName}挂断` : '我方挂断';
  const callContent = `【${modeLabel}·与「${contactName}」】（${startTime || '?'} — ${endTime || '?'}，${hangupLabel}）\n\n${transcript}\n\n（通话已挂断。本次通话时长及结束时间已由前端计算并推进状态栏，记录中的时间标注仅供参考，请勿据此再次推进游戏时间。）`;

  // ②b 线上 chatThreads 补一条"通话结束"系统气泡
  pd.chatThreads[contactId].push({
    id: 'callend_' + Utils.uuid().slice(0, 8),
    role: 'system',
    type: 'call_end',
    callMode: mode,
    text: `${modeLabel}已结束`,
    time: endTime || startTime,
    fromMainline: false
  });
  await _savePhoneData();

  try {
    if (typeof Chat !== 'undefined' && Chat.getMessages && typeof DB !== 'undefined') {
      const convId = Conversations.getCurrent();
      if (convId) {
        const callMsg = {
          id: 'msg_call_' + Utils.uuid().slice(0, 8),
          conversationId: convId,
          role: 'assistant',
          content: callContent,
          timestamp: Date.now(),
          callMode: mode,
          callContactId: contactId,
          callContactName: contactName,
          hidden: false
        };
        await DB.put('messages', callMsg);
        // 追加到当前消息列表（如果主线在前台）
        const messages = Chat.getMessages();
        if (messages) messages.push(callMsg);
      }
    }
  } catch(e) { console.warn('[Phone] 通话写入主线失败', e); }

  // ③ 推进状态栏时间（用结束时间）
  try {
    if (endTime && typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime && Calendar.format) {
      await _refreshCalRulesCache();
      const sb = Conversations.getStatusBar();
      const newScore = _parsePhoneTimeScore(endTime);
      const oldScore = _parsePhoneTimeScore(sb?.time || '');
      if (sb && newScore > 0 && newScore > oldScore) {
        const timeObj = Calendar.parseAbsoluteTime(endTime);
        if (timeObj) {
          const stdTime = Calendar.format(timeObj, _calRulesCache);
          if (stdTime) {
            sb.time = stdTime;
            await Conversations.setStatusBar(sb);
            if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(sb);
          }
        }
      }
    }
  } catch(e) { console.warn('[Phone] 通话推进时间失败', e); }

  // ④ 操作记录（让主线 AI 知道发生了通话）
  _log(`与「${contactName}」进行了一通${modeLabel}（${startTime || '?'} — ${endTime || '?'}，${hangupLabel}）`);

  // ⑤ PRESENT 标记：AI 明确表示在玩家身边，挂断后收手机进主线
  // 不再自动检测状态栏/NPC在场，完全由 AI 通过 [HANGUP:PRESENT] 标记决定
  try {
    if (aiPresent && whoHungUp === 'them' && contact && contact.allowPhoneDown !== false) {
      const myNameForLog = (() => { try { const mk = Character.get(); return mk?.name || '我'; } catch(_) { return '我'; } })();
      // 注意：完整通话记录已作为一条主线消息写入上下文（见上方 ②），这里不再重复塞摘要，
      // 仅注入"通话刚结束、对方在身边、描写线下场景"的指令，避免上下文出现两份重复的通话内容。
      const pdContext = `【通话结束事件】${myNameForLog}刚刚结束了与${contactName}的${modeLabel}（完整通话内容见上文通话记录），${contactName}就在${myNameForLog}身边，请描写挂断后两人面对面的线下场景。照常输出状态块。\n时间增量请从当前状态栏时间继续往前推进（通话时长已自动同步到状态栏）。`;
      _pendingPhoneDown = { contactName, actionLog: pdContext, fromCall: true };
    }
  } catch(_) {}

  _activeCall = null;
}

// 通话 UI 入口
async function _openCall(contactId, mode, opts) {
  opts = opts || {};
  const incoming = !!opts.incoming; // 对方主动呼入：跳过拨号动画，接通后 AI 先开口
  // 隐藏加号菜单
  const menu = document.getElementById('phone-chat-plus-menu');
  if (menu) menu.classList.add('hidden');

  const pd = await _getPhoneData();
  const contact = (pd.chatContacts || []).find(c => c.id === contactId);
  if (!contact) { UI.showToast('联系人不存在', 1500); return; }

  // 初始化通话
  _startCall(contactId, mode);

  const modeLabel = mode === 'video' ? '视频通话' : '语音通话';
  const contactName = Utils.escapeHtml(contact.name || '未知');
  const avaUrl = _chatContactAvatar(contact);
  const initial = Utils.escapeHtml((contact.name || '?')[0]);
  // 视频立绘：优先用聊天设置里配置的 callPortrait，没有则退回头像
  const portrait = (contact.callPortrait || '').trim() || avaUrl;

  // 背景层：视频用立绘铺满；语音用头像高斯模糊
  let bgHtml = '';
  if (mode === 'video') {
    bgHtml = portrait
      ? `<div class="phone-call-bg" style="background-image:url('${Utils.escapeHtml(portrait)}')"></div>`
      : `<div class="phone-call-bg" style="background:linear-gradient(160deg,#2a2d3a,#11131a)"></div>`;
  } else {
    bgHtml = avaUrl
      ? `<div class="phone-call-bg voice" style="background-image:url('${Utils.escapeHtml(avaUrl)}')"></div>`
      : `<div class="phone-call-bg" style="background:linear-gradient(160deg,#2a2d3a,#11131a)"></div>`;
  }

  // 语音通话顶部显示圆形头像；视频通话立绘已铺满，只显示文字
  const voiceAvatarHtml = (mode === 'voice')
    ? `<div class="phone-call-voice-avatar">${avaUrl
        ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:100%;height:100%;object-fit:cover">`
        : `<span style="font-size:32px;font-weight:600;color:#fff">${initial}</span>`}</div>`
    : '';

  // 通话覆盖层挂到 phone-shell 上，盖住状态栏和标题栏
  const shell = document.querySelector('#phone-modal .phone-shell');
  if (!shell) { UI.showToast('通话界面初始化失败', 1500); return; }
  // 移除可能残留的旧覆盖层
  document.getElementById('phone-call-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'phone-call-overlay';
  const dialAvatarHtml = (avaUrl || portrait)
    ? `<img src="${Utils.escapeHtml(avaUrl || portrait)}" style="width:100%;height:100%;object-fit:cover">`
    : `<span style="font-size:36px;font-weight:600;color:#fff">${initial}</span>`;
  const hangupSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272"/><path d="M22 2 2 22"/><path d="M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"/></svg>`;
  const renderConnectedCall = () => `
    ${bgHtml}
    <div class="phone-call-scrim"></div>
    <button id="phone-call-refresh-btn" class="phone-call-refresh-corner" onclick="Phone._callDoRefresh()" title="让对方说话">
      <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
    </button>
    <div class="phone-call-top">
      ${voiceAvatarHtml}
      <div class="phone-call-name">${contactName}</div>
      <div id="phone-call-status" class="phone-call-status">已接通 · ${mode === 'video' ? '视频通话' : '语音通话'}</div>
    </div>
    <div id="phone-call-messages" class="phone-call-msgs"></div>
    <div class="phone-call-bottom">
      <div class="phone-call-input-row">
        <input id="phone-call-input" type="text" placeholder="说些什么…" onkeydown="if(event.key==='Enter'){Phone._callDoSend()}">
        <button class="phone-call-send-btn" onclick="Phone._callDoSend()" title="发送">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
        </button>
      </div>
      <div class="phone-call-action-row">
        <button class="phone-call-action-btn hangup" onclick="Phone._callDoEnd()" title="挂断">${hangupSvg}</button>
      </div>
    </div>`;

  const renderDialingCall = () => `
    ${bgHtml}
    <div class="phone-call-scrim"></div>
    <div class="phone-call-dialing">
      <div class="phone-call-dial-avatar-wrap">
        <span class="phone-call-dial-ring r1"></span>
        <span class="phone-call-dial-ring r2"></span>
        <span class="phone-call-dial-ring r3"></span>
        <div class="phone-call-dial-avatar">${dialAvatarHtml}</div>
      </div>
      <div class="phone-call-name">${contactName}</div>
      <div class="phone-call-dial-status">正在呼叫</div>
    </div>
    <div class="phone-call-bottom">
      <div class="phone-call-action-row">
        <button class="phone-call-action-btn hangup" onclick="Phone._callDoEnd()" title="挂断">${hangupSvg}</button>
      </div>
    </div>`;

  overlay.innerHTML = renderDialingCall();
  shell.appendChild(overlay);
  _clearCallDialTimer();
  if (incoming) {
    // 对方主动呼入：来电界面已经响铃过了，这里直接接通
    overlay.innerHTML = renderConnectedCall();
    setTimeout(() => { try { document.getElementById('phone-call-input')?.focus(); } catch(_) {} }, 30);
// 渲染对方的第一句话（由标记携带，无需额外请求）
      if (opts.firstLine) {
        const rawFirstLine = opts.firstLine;
        // 检测 firstLine 是否带挂断标记
        const flHangup = /\[HANGUP(?::(?:BUSY|PRESENT))?\]/i.test(rawFirstLine);
        const flBusy = /\[HANGUP:BUSY\]/i.test(rawFirstLine);
        const flPresent = /\[HANGUP:PRESENT\]/i.test(rawFirstLine);
        const cleanFirstLine = rawFirstLine.replace(/\s*\[HANGUP(?::(?:BUSY|PRESENT))?\]\s*/gi, '').trim();
        _activeCall.rounds.push({ role: 'them', text: cleanFirstLine || rawFirstLine });
        setTimeout(() => {
          try { _renderCallSegments(cleanFirstLine || rawFirstLine); } catch(_) {}
          // firstLine 就带挂断标记：渲染完后自动挂断
          if (flHangup) {
            const segCount = cleanFirstLine ? cleanFirstLine.split(/\n+/).filter(Boolean).length : 0;
            const delay = Math.max(1200, segCount * 500 + 800);
            setTimeout(async () => {
              try {
                const callContactId = _activeCall && _activeCall.contactId;
                await _endCall('them', flPresent);
                UI.showToast('对方挂断了通话', 1800);
                document.getElementById('phone-call-overlay')?.remove();
                if (_pendingPhoneDown && _pendingPhoneDown.fromCall) {
                  close();
                } else {
                  const pd2 = await _getPhoneData();
                  _renderChatThread(pd2, callContactId);
                }
                if (flBusy && callContactId) {
                  setTimeout(() => {
                    try { _chatRequestReply(callContactId); } catch(_) {}
                  }, 1200);
                }
              } catch(_) {}
            }, delay);
          }
        }, 300);
      }
  } else {
    _callDialTimer = setTimeout(() => {
      _callDialTimer = null;
      const current = document.getElementById('phone-call-overlay');
      if (!current || !_activeCall || _activeCall.contactId !== contactId || _activeCall.mode !== (mode || 'voice')) return;
      current.innerHTML = renderConnectedCall();
      setTimeout(() => { try { document.getElementById('phone-call-input')?.focus(); } catch(_) {} }, 30);
    }, 2600);
  }
}

// ===== 来电（对方主动拨入） =====
let _incomingCallTimer = null;

// 显示来电响铃界面（手机自动弹出）
async function _showIncomingCall(contactId, mode, firstLine) {
  const pd = await _getPhoneData();
  const contact = (pd.chatContacts || []).find(c => c.id === contactId);
  if (!contact) return;

  // 确保手机打开
  let modal = document.getElementById('phone-modal');
  if (!modal || modal.classList.contains('hidden')) {
    await open();
    modal = document.getElementById('phone-modal');
  }

  const shell = modal?.querySelector('.phone-shell');
  if (!shell) return;

  // 移除可能残留的旧覆盖层
  document.getElementById('phone-call-overlay')?.remove();

  const contactName = Utils.escapeHtml(contact.name || '未知');
  const avaUrl = _chatContactAvatar(contact);
  const initial = Utils.escapeHtml((contact.name || '?')[0]);
  const portrait = (contact.callPortrait || '').trim() || avaUrl;
  const modeLabel = mode === 'video' ? '视频通话' : '语音通话';

  // 背景
  let bgHtml = '';
  if (mode === 'video') {
    bgHtml = portrait
      ? `<div class="phone-call-bg" style="background-image:url('${Utils.escapeHtml(portrait)}')"></div>`
      : `<div class="phone-call-bg" style="background:linear-gradient(160deg,#2a2d3a,#11131a)"></div>`;
  } else {
    bgHtml = avaUrl
      ? `<div class="phone-call-bg voice" style="background-image:url('${Utils.escapeHtml(avaUrl)}')"></div>`
      : `<div class="phone-call-bg" style="background:linear-gradient(160deg,#2a2d3a,#11131a)"></div>`;
  }

  const avatarHtml = (avaUrl || portrait)
    ? `<img src="${Utils.escapeHtml(avaUrl || portrait)}" style="width:100%;height:100%;object-fit:cover">`
    : `<span style="font-size:36px;font-weight:600;color:#fff">${initial}</span>`;

  const hangupSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272"/><path d="M22 2 2 22"/><path d="M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"/></svg>`;
  const answerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

  const overlay = document.createElement('div');
  overlay.id = 'phone-call-overlay';
  overlay.innerHTML = `
    ${bgHtml}
    <div class="phone-call-scrim"></div>
    <div class="phone-call-dialing">
      <div class="phone-call-dial-avatar-wrap">
        <span class="phone-call-dial-ring r1"></span>
        <span class="phone-call-dial-ring r2"></span>
        <span class="phone-call-dial-ring r3"></span>
        <div class="phone-call-dial-avatar">${avatarHtml}</div>
      </div>
      <div class="phone-call-name">${contactName}</div>
      <div class="phone-call-dial-status">来电 · ${modeLabel}</div>
    </div>
    <div class="phone-call-bottom">
      <div class="phone-call-action-row" style="gap:48px">
        <button class="phone-call-action-btn hangup" id="phone-incoming-reject" title="拒接">${hangupSvg}</button>
        <button class="phone-call-action-btn answer" id="phone-incoming-answer" title="接听">${answerSvg}</button>
      </div>
    </div>`;
  shell.appendChild(overlay);

  // 接听
  document.getElementById('phone-incoming-answer').onclick = () => {
    if (_incomingCallTimer) { clearTimeout(_incomingCallTimer); _incomingCallTimer = null; }
    overlay.remove();
    _openCall(contactId, mode, { incoming: true, firstLine });
  };

  // 拒接
  document.getElementById('phone-incoming-reject').onclick = () => {
    if (_incomingCallTimer) { clearTimeout(_incomingCallTimer); _incomingCallTimer = null; }
    overlay.remove();
    _missedCall(contactId, contact.name, mode);
  };
}

// 写入未接来电记录
async function _missedCall(contactId, contactName, mode) {
  document.getElementById('phone-call-overlay')?.remove();
  const pd = await _getPhoneData();
  if (!pd.chatThreads) pd.chatThreads = {};
  if (!pd.chatThreads[contactId]) pd.chatThreads[contactId] = [];
  let gameTime = '';
  try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}
  pd.chatThreads[contactId].push({
    id: 'call_missed_' + Date.now(),
    role: 'system',
    type: 'call_missed',
    callMode: mode,
    time: gameTime,
    text: `未接${mode === 'video' ? '视频' : '语音'}通话`
  });
  await _savePhoneData(pd);
  UI.showToast(`未接${contactName}的${mode === 'video' ? '视频' : '语音'}通话`, 2000);
}

// 主线标记处理：检测 ```call 代码块，触发来电
async function handleMainlineCallTag(content) {
  if (!content) return;
  const m = content.match(/```call\s*\n([\s\S]*?)\n```/);
  if (!m) return;
  try {
    const data = JSON.parse(m[1]);
    const mode = (data.mode === 'video') ? 'video' : 'voice';
    const name = (data.name || '').trim();
    if (!name) return;
    // 查/建联系人
    const pd = await _getPhoneData();
    if (!Array.isArray(pd.chatContacts)) pd.chatContacts = [];
    if (!pd.chatThreads || typeof pd.chatThreads !== 'object') pd.chatThreads = {};
    let contact = pd.chatContacts.find(c => c.name === name);
    if (!contact) {
      // 自动建联系人
      const id = 'ct_' + Utils.uuid().slice(0, 8);
      contact = { id, name, source: 'call', avatar: '', sig: '' };
      pd.chatContacts.push(contact);
      if (!pd.chatThreads[id]) pd.chatThreads[id] = [];
      await _savePhoneData(pd);
    }
    const firstLine = (data.firstLine || '').trim() || '';
    // 延迟一点触发，避免和流式渲染末尾冲突
    setTimeout(() => _showIncomingCall(contact.id, mode, firstLine), 800);
  } catch(e) {
    console.warn('[Phone] 来电标记解析失败', e);
  }
}

// 通话中用户发消息
function _callDoSend() {
  const input = document.getElementById('phone-call-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  _callSendMessage(text);

  // 渲染用户消息到通话区（右对齐纯文本，无气泡）
  const list = document.getElementById('phone-call-messages');
  if (list) {
    const el = document.createElement('div');
    el.className = 'phone-call-me-text';
    el.textContent = text;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
  }
}

// 解析 AI 通话回复：拆成「描述段」和「台词段（带时间）」
// 规则：以 > 开头的行 = 台词气泡，其他行 = 描述卡片
// 返回 [{ kind:'desc'|'line', text, time }]
// ===== 电台详情：解析 + 渲染 =====
  // 解析电台节目正文。规则：
  //   叙述行（不以 > 开头）= 描述卡片
  //   台词行（> 说话人：内容）= 台词气泡，提取说话人名
  //   兼容台词行只有 > 内容（无说话人）的情况，speaker 留空
  // 返回 [{ kind:'desc'|'line', speaker, text }]
  function _parseRadioReply(raw) {
    const segs = [];
    if (!raw) return segs;
    raw = _stripMainlineArtifacts(raw);
    if (!raw) return segs;
    // 非行首的 > 前插换行，确保能识别
    let normalized = String(raw).replace(/([^\n])(\s*>\s)/g, '$1\n>');
    const lines = normalized.split(/\n+/).map(s => s.trim()).filter(Boolean);
    for (let line of lines) {
      if (/^>\s*/.test(line)) {
        let body = line.replace(/^>\s*/, '').trim();
        let speaker = '';
        // 匹配「说话人：内容」（中英文冒号），说话人不含标点、不超过10字
        const m = body.match(/^([^：:，。！？\s]{1,10})\s*[：:]\s*(.+)$/);
        if (m) { speaker = m[1].trim(); body = m[2].trim(); }
        body = body.replace(/^[""\u201C]/, '').replace(/[""\u201D]$/, '').trim();
        if (body) segs.push({ kind: 'line', speaker, text: body });
      } else {
        let text = line.replace(/^[""\u201C]/, '').replace(/[""\u201D]$/, '').trim();
        segs.push({ kind: 'desc', speaker: '', text: text || line });
      }
    }
    return segs;
  }

  // 默认嘉宾头像（固定的圆形 SVG：话筒/访客感）
  function _radioGuestAvatar() {
    return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;
  }

// 清洗 AI 回复里混入的主线结构化产物（代码块/JSON 块/残留 marker）
  // 用于通话、电台等"纯叙述"场景，防止主线格式泄漏到正文
  function _stripMainlineArtifacts(raw) {
    if (!raw) return '';
    let s = String(raw);
    // 去掉 ```xxx ... ``` 代码块（relation/task/status 等，含未闭合的尾部块）
    s = s.replace(/```[\s\S]*?```/g, '');
    s = s.replace(/```[a-zA-Z]*[\s\S]*$/g, '');
    // 去掉裸露的 relation/task/status 等结构标签行
    s = s.replace(/^\s*(relation|task|status|tasks|affinity|darkness)\s*[:：]?\s*$/gim, '');
    // 去掉明显的 JSON 对象/数组块（整行就是 { } 或 [ ] 包裹的结构化数据）
    s = s.replace(/^\s*[\[{][\s\S]*?[\]}]\s*$/gm, (m) => (/["']?(affinity|darkness|task_|status|type)["']?\s*[:：]/.test(m) ? '' : m));
    return s.trim();
  }

  function _parseCallReply(raw) {
    const segs = [];
    if (!raw) return segs;
    raw = _stripMainlineArtifacts(raw);
    if (!raw) return segs;
  // 预处理：firstLine 可能是 JSON 单行字符串，> 出现在行中间
  // 在非行首的 > 前面插入换行，使其能被正确识别为台词行
  let normalized = raw.replace(/([^\n])(\s*>\s)/g, '$1\n>');
  const lines = normalized.split(/\n+/).map(s => s.trim()).filter(Boolean);
  for (let line of lines) {
    // 提取行尾时间标注 [HH:MM] 或 【HH:MM】
    let time = '';
    const tm = line.match(/[\[【]\s*(\d{1,2}[:：]\d{2})\s*[\]】]\s*$/);
    if (tm) { time = tm[1].replace('：', ':'); line = line.slice(0, tm.index).trim(); }
    if (!line) continue;
    // 判断是否是台词行（以 > 开头）
    if (/^>\s*/.test(line)) {
      let text = line.replace(/^>\s*/, '').trim();
      // 兼容：台词可能还套了引号，去掉首尾引号
      text = text.replace(/^[""\u201C]/, '').replace(/[""\u201D]$/, '').trim();
      if (text) segs.push({ kind: 'line', text, time });
    } else {
      // 描述段：去掉可能残留的首尾引号（AI 引号怪兼容）
      let text = line.replace(/^[""\u201C]/, '').replace(/[""\u201D]$/, '').trim();
      segs.push({ kind: 'desc', text: text || line, time: '' });
    }
  }
  return segs;
}

// 渲染一段 AI 通话内容（描述卡片 / 左对齐台词）到通话区
// 同一批段落逐条渐次浮上：用递增 animation-delay 实现
let _callLineSeq = 0;

// 播放单条通话台词（复用 TTS，依赖联系人 voiceId）
async function _playCallLine(btn, text) {
  if (typeof TTS === 'undefined') { UI.showToast('语音功能不可用', 1500); return; }
  if (!text) { UI.showToast('没有可播放的内容', 1200); return; }
  const playId = btn.id;
  // 正在播放同一条 → 停止
  if (TTS.isPlaying(playId)) {
    TTS.stop();
    btn.classList.remove('playing');
    return;
  }
  // 停掉上一条，清掉其它按钮的播放态
  TTS.stop();
  try {
    document.querySelectorAll('.phone-call-line-play.playing').forEach(b => b.classList.remove('playing'));
  } catch(_) {}
  // 取联系人 voiceId
  let voiceId;
  try {
    const pd = await _getPhoneData();
    const contact = (pd.chatContacts || []).find(c => c.id === (_activeCall && _activeCall.contactId));
    voiceId = contact && contact.voiceId ? contact.voiceId : undefined;
  } catch(_) {}
  btn.classList.add('playing');
  try {
    await TTS.speak(text, { msgId: playId, voiceId });
  } catch (e) {
    UI.showToast('播放失败：' + (e && e.message ? e.message : '未知错误'), 2000);
  } finally {
    btn.classList.remove('playing');
  }
}

function _renderCallSegments(raw) {
  const list = document.getElementById('phone-call-messages');
  if (!list) return;
  const segs = _parseCallReply(raw);
  const STEP = 500; // 每条间隔 ms
  let idx = 0;

  // 真正延时插入：元素进 DOM 那刻动画才开始，逐条自然出现
  const appendDelayed = (el) => {
    const delay = idx * STEP;
    setTimeout(() => {
      try {
        list.appendChild(el);
        list.scrollTop = list.scrollHeight;
      } catch(_) {}
    }, delay);
    idx++;
  };

  if (segs.length === 0) {
    // 解析不出结构就整段当描述卡片兜底
    const el = document.createElement('div');
    el.className = 'phone-call-desc-card';
    el.textContent = _stripMainlineArtifacts(raw) || raw.trim();
    appendDelayed(el);
  } else {
    // 找到最后一条台词段的索引，用于放编辑按钮
    let lastLineIdx = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].kind === 'line') { lastLineIdx = i; break; }
    }
    let segIdx = 0;
    for (const seg of segs) {
      if (seg.kind === 'desc') {
        const el = document.createElement('div');
        el.className = 'phone-call-desc-card';
        el.textContent = seg.text;
        appendDelayed(el);
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'phone-call-line them';
        const bubble = document.createElement('div');
        bubble.className = 'phone-call-line-text';
        bubble.textContent = seg.text;
        wrap.appendChild(bubble);
        // 播放 + 时间行
        const meta = document.createElement('div');
        meta.className = 'phone-call-line-meta';
        const playBtn = document.createElement('button');
        playBtn.className = 'phone-call-line-play';
        playBtn.id = 'call-line-' + (++_callLineSeq);
        playBtn.title = '播放语音';
        playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></svg>';
        const lineText = seg.text;
        playBtn.onclick = () => _playCallLine(playBtn, lineText);
        meta.appendChild(playBtn);
        if (seg.time) {
          const t = document.createElement('div');
          t.className = 'phone-call-line-time';
          t.textContent = seg.time;
          meta.appendChild(t);
        }
        // 编辑按钮：仅最后一条台词段显示
        if (segIdx === lastLineIdx) {
          const editBtn = document.createElement('button');
          editBtn.className = 'phone-call-line-edit';
          editBtn.title = '编辑本轮';
          editBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
          editBtn.onclick = () => _callEditRound();
          meta.appendChild(editBtn);
        }
        wrap.appendChild(meta);
        appendDelayed(wrap);
      }
      segIdx++;
    }
  }

  // 自动播放：如果联系人开了 voiceEnabled + callAutoPlay，渲染完后自动逐条朗读台词
  const lineSegs = segs.filter(s => s.kind === 'line');
  if (lineSegs.length > 0 && _activeCall) {
    const totalDelay = idx * STEP + 200; // 等所有元素渲染完
    setTimeout(async () => {
      try {
        if (typeof TTS === 'undefined') return;
        const pd = await _getPhoneData();
        const contact = (pd.chatContacts || []).find(c => c.id === (_activeCall && _activeCall.contactId));
        if (!contact || !contact.voiceEnabled || contact.callAutoPlay === false) return;
        const voiceId = contact.voiceId || undefined;
        for (const seg of lineSegs) {
          if (!_activeCall) break; // 通话已结束则停止
          await TTS.speak(seg.text, { msgId: 'call-auto-' + Date.now(), voiceId });
        }
      } catch(_) {}
    }, totalDelay);
  }
}

// 编辑本轮 AI 通话内容
function _callEditRound() {
  if (!_activeCall || _activeCall.rounds.length === 0) return;
  // 找最后一条 them
  let lastIdx = -1;
  for (let i = _activeCall.rounds.length - 1; i >= 0; i--) {
    if (_activeCall.rounds[i].role === 'them') { lastIdx = i; break; }
  }
  if (lastIdx < 0) { UI.showToast('没有可编辑的内容', 1200); return; }
  const original = _activeCall.rounds[lastIdx].text || '';
  const overlay = document.createElement('div');
  overlay.id = 'phone-call-edit-overlay';
  overlay.style.cssText = 'position:absolute;inset:0;z-index:65;display:flex;flex-direction:column;background:var(--bg);border-radius:inherit;padding:16px';
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <span style="font-size:15px;font-weight:600;color:var(--text)">编辑本轮</span>
      <button onclick="document.getElementById('phone-call-edit-overlay')?.remove()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <textarea id="phone-call-edit-textarea" style="flex:1;min-height:0;width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:13px;line-height:1.6;padding:12px;resize:none;outline:none;font-family:inherit">${Utils.escapeHtml(original)}</textarea>
    <div style="display:flex;gap:10px;margin-top:12px">
      <button onclick="document.getElementById('phone-call-edit-overlay')?.remove()" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">取消</button>
      <button onclick="Phone._callSaveEdit()" style="flex:1;padding:12px;border-radius:10px;border:none;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">保存</button>
    </div>`;
  const shell = document.querySelector('#phone-modal .phone-shell');
  if (shell) shell.appendChild(overlay);
  setTimeout(() => document.getElementById('phone-call-edit-textarea')?.focus(), 100);
}

// 保存编辑后的通话内容
function _callSaveEdit() {
  if (!_activeCall) return;
  const textarea = document.getElementById('phone-call-edit-textarea');
  const newText = (textarea?.value || '').trim();
  if (!newText) { UI.showToast('内容不能为空', 1200); return; }
  // 找最后一条 them 并替换
  for (let i = _activeCall.rounds.length - 1; i >= 0; i--) {
    if (_activeCall.rounds[i].role === 'them') {
      _activeCall.rounds[i].text = newText;
      break;
    }
  }
  document.getElementById('phone-call-edit-overlay')?.remove();
  // 清空消息区并重新渲染所有轮次
  const list = document.getElementById('phone-call-messages');
  if (list) list.innerHTML = '';
  _callLineSeq = 0;
  for (const round of _activeCall.rounds) {
    if (round.role === 'them') {
      _renderCallSegments(round.text);
    } else {
      // 玩家消息
      const el = document.createElement('div');
      el.className = 'phone-call-line me';
      el.innerHTML = `<div class="phone-call-line-text">${Utils.escapeHtml(round.text)}</div>`;
      list.appendChild(el);
    }
  }
  if (list) list.scrollTop = list.scrollHeight;
  UI.showToast('已保存修改', 1200);
}

// 通话中请求 AI 回复
const _callRefreshSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>`;
const _callLoadingSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.74-8.74"/></svg>`;
async function _callDoRefresh() {
  const btn = document.getElementById('phone-call-refresh-btn');
  if (btn) { btn.style.pointerEvents = 'none'; btn.innerHTML = _callLoadingSvg; }
  try {
    await _callRequestReply();
    // 渲染最新一条 AI 回复（分段）
    if (_activeCall && _activeCall.rounds.length > 0) {
      const lastRound = _activeCall.rounds[_activeCall.rounds.length - 1];
      if (lastRound.role === 'them') {
        const rawText = lastRound.text;
        // 检测 AI 是否主动挂断
        const aiHangup = /\[HANGUP(?::(?:BUSY|PRESENT))?\]/i.test(rawText);
        const aiBusy = /\[HANGUP:BUSY\]/i.test(rawText);
        const aiPresent = /\[HANGUP:PRESENT\]/i.test(rawText);
        const cleanText = rawText.replace(/\s*\[HANGUP(?::(?:BUSY|PRESENT))?\]\s*/gi, '').trim();
        // 先渲染（去掉标记后的）台词
        if (cleanText) {
          lastRound.text = cleanText; // 存干净版本
          _renderCallSegments(cleanText);
        }
        // AI 挂断：渲染完最后一条后延迟结束通话（独立于 cleanText 判断）
        if (aiHangup) {
          const segCount = cleanText ? cleanText.split(/\n+/).filter(Boolean).length : 0;
          const delay = Math.max(1200, segCount * 500 + 800);
          const _aiPresent = aiPresent; // 闭包捕获
          setTimeout(async () => {
            try {
              const callContactId = _activeCall && _activeCall.contactId;
              await _endCall('them', _aiPresent);
              UI.showToast('对方挂断了通话', 1800);
              document.getElementById('phone-call-overlay')?.remove();
              // PRESENT 时收手机进主线，否则回聊天列表
              if (_pendingPhoneDown && _pendingPhoneDown.fromCall) {
                close();
              } else {
                const pd2 = await _getPhoneData();
                _renderChatThread(pd2, callContactId);
              }
              // BUSY：触发线上回复，让角色补发一条文字说明原因
              if (aiBusy && callContactId) {
                setTimeout(() => {
                  try { _chatRequestReply(callContactId); } catch(_) {}
                }, 1200);
              }
            } catch(_) {}
          }, delay);
        }
      }
    }
  } finally {
    if (btn) { btn.style.pointerEvents = ''; btn.innerHTML = _callRefreshSvg; }
  }
}

// 挂断
async function _callDoEnd() {
  // 已接通且有对话内容时，二次确认避免误触（拨号中/无内容直接挂）
  const hasRounds = _activeCall && Array.isArray(_activeCall.rounds) && _activeCall.rounds.length > 0;
  if (hasRounds) {
    const ok = await UI.showConfirm('结束通话', '此操作将结束通话，确认继续？');
    if (!ok) return;
  }
  _clearCallDialTimer();
  const callContactId = _activeCall && _activeCall.contactId;
  await _endCall('me');
  document.getElementById('phone-call-overlay')?.remove();
  // 在场时收手机进主线，不在场时回聊天列表
  if (_pendingPhoneDown && _pendingPhoneDown.fromCall) {
    UI.showToast('通话已结束', 1200);
    close();
  } else {
    UI.showToast('通话已结束', 1500);
    const pd = await _getPhoneData();
    _renderChatThread(pd, callContactId);
  }
}

// 查看历史通话记录（弹出全屏覆盖层展示完整对话）
async function _showCallRecord(contactId, msgId) {
  const pd = await _getPhoneData();
  const thread = (pd.chatThreads && pd.chatThreads[contactId]) || [];
  const record = thread.find(m => m.id === msgId && m.type === 'call_record');
  if (!record || !Array.isArray(record.rounds)) { UI.showToast('找不到通话记录', 1500); return; }
  const contact = (pd.chatContacts || []).find(c => c.id === contactId);
  const contactName = contact?.name || contactId;
  const myName = (() => { try { const mk = Character.get(); return mk?.name || '我'; } catch(_) { return '我'; } })();
  const modeLabel = record.callMode === 'video' ? '视频通话' : '语音通话';

  // 渲染每一轮
  let contentHtml = '';
  for (const r of record.rounds) {
    if (r.role === 'me') {
      contentHtml += `<div style="align-self:flex-end;max-width:80%;padding:2px 4px;color:var(--text);font-size:14px;line-height:1.7;text-align:right;word-break:break-word;white-space:pre-wrap">${Utils.escapeHtml(r.text)}</div>`;
    } else {
      // AI 回复用解析
      const segs = _parseCallReply(r.text);
      if (segs.length === 0) {
        contentHtml += `<div style="align-self:center;max-width:90%;padding:8px 16px;border-radius:18px;background:var(--bg-tertiary);color:var(--text-secondary);font-size:12.5px;text-align:center;line-height:1.6;word-break:break-word;white-space:pre-wrap">${Utils.escapeHtml(_stripMainlineArtifacts(r.text) || (r.text || ''))}</div>`;
      } else {
        for (const seg of segs) {
          if (seg.kind === 'desc') {
            contentHtml += `<div style="align-self:center;max-width:90%;padding:8px 16px;border-radius:18px;background:var(--bg-tertiary);color:var(--text-secondary);font-size:12.5px;text-align:center;line-height:1.6;word-break:break-word;white-space:pre-wrap">${Utils.escapeHtml(seg.text)}</div>`;
          } else {
            contentHtml += `<div style="align-self:flex-start;max-width:80%;display:flex;flex-direction:column;gap:2px"><div style="padding:2px 4px;color:var(--text);font-size:14px;line-height:1.7;word-break:break-word;white-space:pre-wrap">${Utils.escapeHtml(seg.text)}</div>${seg.time ? `<div style="font-size:10px;color:var(--text-secondary);padding-left:4px">${Utils.escapeHtml(seg.time)}</div>` : ''}</div>`;
          }
        }
      }
    }
  }

  // 弹出全屏覆盖
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;background:var(--bg)';
  overlay.innerHTML = `
    <div style="flex-shrink:0;display:flex;align-items:center;padding:14px 16px;gap:12px;border-bottom:1px solid var(--border)">
      <button onclick="this.closest('div[style*=fixed]').remove()" style="background:none;border:none;color:var(--text);cursor:pointer;padding:4px;display:flex;align-items:center">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 5-7 7 7 7"/></svg>
      </button>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:600;color:var(--text)">${Utils.escapeHtml(contactName)} · ${modeLabel}</div>
        <div style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(record.startTime || '')}${record.endTime ? ' — ' + Utils.escapeHtml(record.endTime) : ''}</div>
      </div>
    </div>
    <div style="flex:1;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px">
      ${contentHtml}
    </div>`;
  document.body.appendChild(overlay);
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
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10015;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
  overlay.onclick = (e) => { if (e.target === overlay) _closeCameraAdjust(); };
  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:340px;width:100%;color:var(--text)">
      <div style="font-size:15px;font-weight:600;padding:18px 20px 4px">调整镜头</div>
      <div style="font-size:12px;color:var(--text-secondary);padding:0 20px 12px">让 AI 帮你重新组织一下画面</div>
      <div style="padding:0 20px">
        <textarea id="phone-camera-adjust-input" placeholder="想拍成什么感觉？（可选，例如：更暗一点 / 聚焦手部 / 黑白胶片）" spellcheck="false" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;resize:none;min-height:60px;margin-bottom:14px"></textarea>
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:6px">尺寸（仅 AI 画用）</label>
        <div class="phone-camera-adjust-ratios" style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">
          <button type="button" class="phone-camera-ratio-btn" data-ratio="1:1" data-w="1024" data-h="1024">1:1</button>
          <button type="button" class="phone-camera-ratio-btn" data-ratio="3:4" data-w="768" data-h="1024">3:4</button>
          <button type="button" class="phone-camera-ratio-btn" data-ratio="4:3" data-w="1024" data-h="768">4:3</button>
          <button type="button" class="phone-camera-ratio-btn" data-ratio="9:16" data-w="720" data-h="1280">9:16</button>
          <button type="button" class="phone-camera-ratio-btn" data-ratio="16:9" data-w="1280" data-h="720">16:9</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:14px">
          <span style="font-size:12px;color:var(--text-secondary)">自定义：</span>
          <input id="phone-camera-size-w" type="number" min="64" max="2048" step="1" value="${lastSize.w}" style="width:60px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:6px 8px;outline:none;text-align:center" />
          <span style="font-size:12px;color:var(--text-secondary)">×</span>
          <input id="phone-camera-size-h" type="number" min="64" max="2048" step="1" value="${lastSize.h}" style="width:60px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:6px 8px;outline:none;text-align:center" />
        </div>
      </div>
      <div style="padding:0 20px 18px;display:flex;flex-direction:column;gap:8px">
        <button class="phone-camera-adjust-btn-write" type="button" style="width:100%;display:flex;align-items:center;gap:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:14px 16px;font-size:14px;color:var(--text);cursor:pointer;text-align:left">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          <div><div style="font-weight:600">AI 写</div><div style="font-size:12px;color:var(--text-secondary);margin-top:2px">把当前文字改写成更有镜头感的描述</div></div>
        </button>
        <button class="phone-camera-adjust-btn-draw" type="button" style="width:100%;display:flex;align-items:center;gap:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:14px 16px;font-size:14px;color:var(--text);cursor:pointer;text-align:left">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
          <div><div style="font-weight:600">AI 画</div><div style="font-size:12px;color:var(--text-secondary);margin-top:2px">根据当前文字画一张真图</div></div>
        </button>
        <button class="phone-camera-adjust-cancel" type="button" style="width:100%;background:transparent;border:none;border-radius:12px;padding:12px;font-size:14px;color:var(--text-secondary);cursor:pointer">取消</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

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

// 论坛发帖"从相册选"：复用相册选择器，选中后填入论坛配图描述框
async function _openAlbumPickerForForum() {
  const pd = await _getPhoneData();
  const album = Array.isArray(pd?.album) ? pd.album : [];
  if (!album.length) {
    UI.showToast('相册还是空的，先去拍一张吧', 1800);
    return;
  }
  const old = document.getElementById('phone-album-picker-overlay');
  if (old) old.remove();

  const sorted = album.slice().reverse();
  const cardsHtml = sorted.map(p => {
    const text = String(p.text || '').trim();
    const preview = text.length > 50 ? text.slice(0, 50) + '…' : text;
    const time = p.time || '';
    const location = p.location || '';
    return `
      <div class="phone-camera-polaroid" onclick="Phone._pickAlbumForForum('${p.id}')" style="opacity:1">
        <div class="phone-camera-polaroid-frame">
          <div class="phone-camera-polaroid-content">${Utils.escapeHtml(preview || '(空)')}</div>
        </div>
        ${location ? `<div class="phone-camera-polaroid-loc">${Utils.escapeHtml(location)}</div>` : ''}
        ${time ? `<div class="phone-camera-polaroid-caption">${Utils.escapeHtml(time)}</div>` : ''}
      </div>`;
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

async function _pickAlbumForForum(id) {
  const pd = await _getPhoneData();
  const photo = pd?.album?.find(p => p.id === id);
  if (!photo) { UI.showToast('照片已被删除', 1500); return; }
  const el = document.getElementById('phone-forum-post-imgdesc');
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
async function _photoShareMain(id) {
  const pd = await _getPhoneData();
  if (!pd) return;
  const album = Array.isArray(pd.album) ? pd.album : [];
  const photo = album.find(p => p.id === id);
  if (!photo) { UI.showToast('照片不存在', 1500); return; }
  const text = photo.text || '';
  if (!text) { UI.showToast('照片内容为空', 1500); return; }
  const locPart = photo.location ? `\n地点：${photo.location}` : '';
  const timePart = photo.time ? `\n时间：${_formatPhoneTime(photo.time)}` : '';
  const modeLabel = photo.mode === 'ai_image' ? '📷 AI绘制照片' : '📷 拍摄照片';
  await _shareToMain('camera', modeLabel, `${text}${locPart}${timePart}`);
}

// ===== 番茄钟 =====
let _tomatoTimer = null;       // setInterval id
let _tomatoEndTime = 0;        // Date.now() + duration
let _tomatoDuration = 0;       // 剩余时长（ms），暂停时保存
let _tomatoOriginalDur = 0;    // 原始总时长（ms），用于计算进度百分比
let _tomatoGoal = '';          // 当前专注目标
let _tomatoCompanion = null;   // {name, avatar, lines:[], pending, shown:[]}
let _tomatoTab = 'focus';     // 'focus' | 'history'
let _tomatoCompLineIdx = 0;    // 当前已弹出的陪伴消息索引
let _tomatoCompTimers = [];    // 陪伴消息定时器 id 列表

// 解析时间字符串为指针角度
function _tomatoParseTime(str) {
  const m = (str || '').match(/(\d+):(\d+)/);
  const hour = m ? parseInt(m[1], 10) : 0;
  const min = m ? parseInt(m[2], 10) : 0;
  return {
    hourDeg: (hour % 12) * 30 + min * 0.5,
    minDeg: min * 6
  };
}

// 番茄钟桌面卡片渲染
function _refreshTomatoCard() {
  const el = document.getElementById('phone-tomato-card');
  if (!el) return;

  // 读游戏时间
  let gameTimeStr = '--:--';
  try {
    const sb = Conversations.getStatusBar() || {};
    if (sb.time) {
      const parsed = (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) ? Calendar.parseAbsoluteTime(sb.time) : null;
      if (parsed) {
        const hh = String(parsed.hour ?? 0).padStart(2, '0');
        const mm = String(parsed.minute ?? 0).padStart(2, '0');
        gameTimeStr = `${hh}:${mm}`;
      }
    }
  } catch(_) {}

  // 进度百分比：空闲=100%（满），专注中=剩余/总时长（逐渐归零）
  let pct = 100;
  let labelText = '番茄钟';
  if (_tomatoTimer) {
    const remaining = Math.max(0, _tomatoEndTime - Date.now());
    pct = Math.max(0, Math.min(100, (remaining / _tomatoDuration) * 100));
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    labelText = `${mins}:${secs < 10 ? '0' : ''}${secs} ${_tomatoGoal || '专注中'}`;
  }

  const r = 52, strokeW = 8;
  const size = (r + strokeW) * 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);

  // 如果 DOM 已存在，只更新数值，不重建（避免动画重置）
  const existingRing = el.querySelector('.phone-tomato-ring-progress');
  if (existingRing) {
    existingRing.style.strokeDashoffset = offset;
    // 更新指针角度
    const hourHand = el.querySelector('.tomato-clock-hour');
    const minHand = el.querySelector('.tomato-clock-min');
    if (hourHand && minHand) {
      const _t = _tomatoParseTime(gameTimeStr);
      hourHand.style.transform = `rotate(${_t.hourDeg}deg)`;
      minHand.style.transform = `rotate(${_t.minDeg}deg)`;
    }
    const labelEl = el.querySelector('.phone-tomato-label');
    if (labelEl) labelEl.textContent = labelText;
    return;
  }

  // 解析时间用于指针
  const _clock = _tomatoParseTime(gameTimeStr);

  el.innerHTML = `
    <div class="phone-tomato-ring" style="width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="transform:rotate(-90deg)">
        <defs>
          <linearGradient id="tomato-grad" x1="0%" y1="0%" x2="100%" y2="100%" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="var(--accent)"/>
            <stop offset="100%" stop-color="var(--border)"/>
            <animateTransform attributeName="gradientTransform" type="rotate" values="0 ${size/2} ${size/2};360 ${size/2} ${size/2}" dur="10s" repeatCount="indefinite"/>
          </linearGradient>
        </defs>
        <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="rgba(128,128,128,0.25)" stroke-width="${strokeW}"/>
        <circle class="phone-tomato-ring-progress" cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="url(#tomato-grad)" stroke-width="${strokeW}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}" style="transition:stroke-dashoffset 1.2s linear"/>
      </svg>
      <div class="phone-tomato-clock-face">
        <svg viewBox="0 0 60 60" width="80" height="80">
          <circle cx="30" cy="30" r="2" fill="var(--accent)" class="tomato-clock-center"/>
          <line class="tomato-clock-hour" x1="30" y1="30" x2="30" y2="17" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" style="transform-origin:30px 30px;transform:rotate(${_clock.hourDeg}deg);transition:transform 1s linear;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4))"/>
          <line class="tomato-clock-min" x1="30" y1="30" x2="30" y2="11" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" style="transform-origin:30px 30px;transform:rotate(${_clock.minDeg}deg);transition:transform 1s linear;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4))"/>
        </svg>
      </div>
    </div>
    <div class="phone-tomato-label">${Utils.escapeHtml(labelText)}</div>`;
}

// 每秒刷新卡片（专注中时）
function _tomatoTick() {
  const remaining = _tomatoEndTime - Date.now();
  if (remaining <= 0) {
    _tomatoComplete();
    return;
  }
  _refreshTomatoCard();
  // App 内专注页：平滑更新时间大字与进度条（不重建 DOM）
  if (_currentApp === 'tomato' && _tomatoTab === 'focus') {
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    const timeEl = document.getElementById('tomato-time-big');
    if (timeEl) timeEl.textContent = `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    const barEl = document.getElementById('tomato-bar-fill');
    if (barEl && _tomatoOriginalDur > 0) {
      const pct = Math.max(0, Math.min(100, (remaining / _tomatoOriginalDur) * 100));
      barEl.style.width = pct + '%';
    }
  }
}

// 开始番茄钟
async function _tomatoStart(duration, goal, companion) {
  _tomatoDuration = duration * 60000;
  _tomatoEndTime = Date.now() + _tomatoDuration;
  _tomatoGoal = goal || '';
  _tomatoCompanion = companion || null;
  if (_tomatoTimer) clearInterval(_tomatoTimer);
  _tomatoTimer = setInterval(_tomatoTick, 1000);
  _refreshTomatoCard();
  UI.showToast(`开始专注 ${duration} 分钟`, 1500);
}

// 番茄钟完成
async function _tomatoComplete() {
  if (_tomatoTimer) { clearInterval(_tomatoTimer); _tomatoTimer = null; }
  _tomatoClearCompanionTimers();
  const pd = await _getPhoneData();
  if (!pd) return;
  const duration = Math.round(_tomatoOriginalDur / 60000) || Math.round(_tomatoDuration / 60000);
  const goal = _tomatoGoal;
  const companionName = _tomatoCompanion?.name || '';
  const companionMsgs = (_tomatoCompanion?.shown || []).slice();
  const settings = pd.tomatoSettings || {};

  pd.tomatoHistory = pd.tomatoHistory || [];
  pd.tomatoHistory.push({
    id: 'tm_' + Utils.uuid().slice(0, 8),
    goal,
    duration,
    companion: companionName,
    companionMsgs,
    completedAt: new Date().toISOString(),
    interrupted: false
  });
  pd.tomatoTotalMinutes = (pd.tomatoTotalMinutes || 0) + duration;
  await _savePhoneData();

  // ① 同步主线
  if (settings.syncMainline !== false) {
    const compPart = companionName ? `，${companionName}陪伴` : '';
    _log(`完成了一个 ${duration} 分钟的番茄钟专注（目标：${goal || '无'}${compPart}）`);
  }

  // ② 同步给邀请的联系人（插入聊天记录卡片）
  if (settings.syncCompanion !== false && companionName && _tomatoCompanion) {
    try {
      const contact = (pd.chatContacts || []).find(c => c.name === companionName);
      if (contact) {
        if (!pd.chatThreads) pd.chatThreads = {};
        if (!pd.chatThreads[contact.id]) pd.chatThreads[contact.id] = [];
        pd.chatThreads[contact.id].push({
          id: 'tomato_' + Date.now(),
          role: 'system',
          type: 'tomato_result',
          text: `番茄钟结束：${goal || '无目标'} · ${duration}分钟`,
          goal,
          duration,
          companionMsgs,
          time: (() => { try { return _formatPhoneTime(Conversations.getStatusBar()?.time || ''); } catch(_) { return ''; } })(),
          createdAt: Date.now()
        });
        await _savePhoneData();
      }
    } catch(_) {}
  }

  _tomatoGoal = '';
  _tomatoCompanion = null;
  _tomatoOriginalDur = 0;
  _tomatoDuration = 0;
  _refreshTomatoCard();
  UI.showToast(`🍅 完成！已专注 ${duration} 分钟`, 2000);
}

// 中断番茄钟
async function _tomatoStop() {
  if (!_tomatoTimer) return;
  clearInterval(_tomatoTimer);
  _tomatoTimer = null;
  const elapsed = Math.round((_tomatoDuration - Math.max(0, _tomatoEndTime - Date.now())) / 60000);
  const pd = await _getPhoneData();
  if (pd && elapsed > 0) {
    pd.tomatoHistory = pd.tomatoHistory || [];
    pd.tomatoHistory.push({
      id: 'tm_' + Utils.uuid().slice(0, 8),
      goal: _tomatoGoal,
      duration: elapsed,
      companion: _tomatoCompanion?.name || '',
      completedAt: new Date().toISOString(),
      interrupted: true
    });
    pd.tomatoTotalMinutes = (pd.tomatoTotalMinutes || 0) + elapsed;
    await _savePhoneData();
  }
  _tomatoGoal = '';
  _tomatoCompanion = null;
  _refreshTomatoCard();
  UI.showToast('番茄钟已中断', 1500);
}

// 番茄钟 App 页面
function _renderTomato(pd) {
  const body = document.getElementById('phone-body');
  document.getElementById('phone-title').textContent = '番茄钟';
  // 全屏模式：隐藏标题栏
  document.querySelector('#phone-modal .phone-shell')?.classList.add('phone-tomato-mode');
  _applyWallpaper(pd);
  const settings = pd.tomatoSettings || { syncMainline: true, lockScreen: false };
  const history = pd.tomatoHistory || [];
  const totalMin = pd.tomatoTotalMinutes || 0;
  const totalH = (totalMin / 60).toFixed(1);

  // 当前时长 / 倒计时显示
  const isRunning = !!_tomatoTimer;
  const isPaused = !isRunning && _tomatoDuration > 0;
  let timeStr;
  let pct = 100; // 进度条：满 → 倒退归零
  if (isRunning) {
    const remaining = Math.max(0, _tomatoEndTime - Date.now());
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    timeStr = `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    pct = _tomatoOriginalDur > 0 ? Math.max(0, Math.min(100, (remaining / _tomatoOriginalDur) * 100)) : 0;
  } else if (isPaused) {
    const m = Math.floor(_tomatoDuration / 60000);
    const s = Math.floor((_tomatoDuration % 60000) / 1000);
    timeStr = `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    pct = _tomatoOriginalDur > 0 ? Math.max(0, Math.min(100, (_tomatoDuration / _tomatoOriginalDur) * 100)) : 100;
  } else {
    const durMin = _tomatoSetMinutes || 25;
    timeStr = `${durMin < 10 ? '0' : ''}${durMin}:00`;
    pct = 100;
  }
  const editable = !isRunning && !isPaused; // 仅未开始时可改时长/目标

  // 退出按钮（一起听同款 logout 图标）
  const exitBtn = `
    <button class="phone-tomato-exit" onclick="Phone._tomatoExit()" title="退出">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
    </button>`;

  // 播放器卡片：目标（左上）+ 退出（右上）+ 时间大字 + 进度条
  const playerHtml = `
    <div class="phone-tomato-player">
      <div class="phone-tomato-player-head">
        <div class="phone-tomato-player-goal ${editable ? '' : 'locked'}" ${editable ? 'onclick="Phone._tomatoEditGoal()"' : ''}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          <span>${Utils.escapeHtml(_tomatoGoal || (editable ? '点击设置目标' : '专注中'))}</span>
        </div>
        ${exitBtn}
      </div>
      <div class="phone-tomato-player-time locked" id="tomato-time-big">${timeStr}</div>
      <div class="phone-tomato-player-bar">
        <div class="phone-tomato-player-bar-fill" id="tomato-bar-fill" style="width:${pct}%"></div>
      </div>
    </div>`;

  // 邀请陪伴横条卡片：左侧虚线圆框（一起听同款）+ 文字
  const comp = _tomatoCompanion;
  const companionAvatarHtml = comp
    ? (comp.avatar
        ? `<img src="${Utils.escapeHtml(comp.avatar)}" class="phone-tomato-comp-avatar">`
        : `<div class="phone-tomato-comp-avatar phone-tomato-comp-avatar-fallback">${Utils.escapeHtml((comp.name || '?')[0])}</div>`)
    : `<div class="phone-tomato-comp-invite">
         <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
       </div>`;
  const companionText = comp
    ? (comp.pending
        ? `<div class="phone-tomato-comp-name">${Utils.escapeHtml(comp.name)}</div><div class="phone-tomato-comp-sub">等待加入中…</div>`
        : `<div class="phone-tomato-comp-name">${Utils.escapeHtml(comp.name)}</div><div class="phone-tomato-comp-sub">已加入</div>`)
    : `<div class="phone-tomato-comp-name">邀请陪伴</div><div class="phone-tomato-comp-sub">让 TA 陪你专注</div>`;
  const compPlayBtn = `
    <button class="phone-tomato-comp-play" onclick="event.stopPropagation();Phone._tomatoToggle()" title="${isRunning ? '暂停' : '开始'}">
      ${isRunning
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="6 3 20 12 6 21"/></svg>'}
    </button>`;
  const companionHtml = `
    <div class="phone-tomato-companion" onclick="Phone._tomatoInviteCompanion()">
      ${companionAvatarHtml}
      <div class="phone-tomato-comp-text">${companionText}</div>
      ${compPlayBtn}
    </div>`;

  // 专注 tab
  const focusHtml = `
    <div style="padding:18px 12px">
      ${playerHtml}
      ${companionHtml}
      <div class="phone-tomato-comp-msgs" id="tomato-companion-msgs"></div>
    </div>`;

  // 历史 tab 内容（卡片样式）
  const _tomatoSvg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const _pauseSvg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  const histHtml = history.length
    ? history.slice().reverse().slice(0, 30).map((h, i) => `
      <div class="phone-tomato-hist-card" onclick="Phone._tomatoShowDetail(${history.length - 1 - i})">
        <div class="phone-tomato-hist-icon">${h.interrupted ? _pauseSvg : _tomatoSvg}</div>
        <div class="phone-tomato-hist-info">
          <div class="phone-tomato-hist-goal">${Utils.escapeHtml(h.goal || '无目标')}</div>
          <div class="phone-tomato-hist-meta">${h.duration}分钟${h.companion ? ' · ' + Utils.escapeHtml(h.companion) : ''}${h.interrupted ? ' · 已中断' : ''}</div>
        </div>
        <div class="phone-tomato-hist-date">${new Date(h.completedAt).toLocaleDateString('zh-CN', {month:'numeric',day:'numeric'})}</div>
      </div>`).join('')
    : '<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:30px 0">还没有专注记录</div>';

  body.innerHTML = `
    <div class="phone-app-page phone-tomato-app" style="display:flex;flex-direction:column;height:100%">
      <div style="flex:1;min-height:0;overflow-y:auto;padding:12px">
        <div style="display:${_tomatoTab === 'focus' ? 'block' : 'none'}">${focusHtml}</div>
        <div style="display:${_tomatoTab === 'history' ? 'block' : 'none'}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-top:6px">
            <span style="font-size:12px;color:var(--text-secondary)">累计 ${totalH} 小时 · ${history.length} 次</span>
            <button class="phone-tomato-exit" onclick="Phone._tomatoExit()" title="退出">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
          </div>
          ${histHtml}
        </div>
      </div>
      <div class="phone-tabbar">
        <div class="phone-tab ${_tomatoTab === 'focus' ? 'active' : ''}" onclick="Phone._switchTomatoTab('focus')">专注</div>
        <div class="phone-tab ${_tomatoTab === 'history' ? 'active' : ''}" onclick="Phone._switchTomatoTab('history')">历史</div>
      </div>
    </div>`;
  // 恢复已显示的历史气泡
  if (_tomatoCompanion && _tomatoCompanion.shown && _tomatoCompanion.shown.length > 0) {
    requestAnimationFrame(() => {
      for (const msg of _tomatoCompanion.shown) {
        _tomatoAppendBubble(msg);
      }
    });
  }
}

// 退出番茄钟全屏，回主屏（计时不受影响）
function _tomatoExit() {
  // 锁屏模式：运行中不允许退出
  if (_tomatoTimer && _tomatoIsLocked()) {
    UI.showToast('专注中，屏幕已锁定', 1500);
    return;
  }
  document.querySelector('#phone-modal .phone-shell')?.classList.remove('phone-tomato-mode');
  goHome();
}

// 检测是否处于番茄钟锁屏状态
function _tomatoIsLocked() {
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const settings = conv?.phoneData?.tomatoSettings;
    return !!(settings && settings.lockScreen);
  } catch(_) { return false; }
}

// 启动陪伴消息定时弹出（开始时立刻弹第一条，每5分钟弹一条）
// 如果是恢复（已有 shown），从下一条开始继续
function _tomatoStartCompanionTimers() {
  _tomatoClearCompanionTimers();
  if (!_tomatoCompanion || !_tomatoCompanion.lines || _tomatoCompanion.lines.length === 0) return;
  const lines = _tomatoCompanion.lines;
  const startIdx = (_tomatoCompanion.shown && _tomatoCompanion.shown.length) || 0;
  if (startIdx >= lines.length) return; // 全部已弹完
  for (let i = startIdx; i < lines.length; i++) {
    const delay = (i - startIdx) * 5 * 60 * 1000; // 第一条立刻，之后每5分钟
    const tid = setTimeout(() => {
      _tomatoShowCompanionMsg(lines[i]);
      _tomatoCompLineIdx = i + 1;
    }, delay);
    _tomatoCompTimers.push(tid);
  }
}

// 清除所有陪伴消息定时器
function _tomatoClearCompanionTimers() {
  for (const tid of _tomatoCompTimers) clearTimeout(tid);
  _tomatoCompTimers = [];
}

// 显示一条陪伴消息（追加到番茄钟 App 内的消息区域）
function _tomatoShowCompanionMsg(text) {
  if (!text || !_tomatoCompanion) return;
  const name = _tomatoCompanion.name || '陪伴';
  // 存入已显示消息列表（用于退出再进来恢复）
  if (!_tomatoCompanion.shown) _tomatoCompanion.shown = [];
  _tomatoCompanion.shown.push(text);
  _tomatoAppendBubble(text);
}

// 往 DOM 追加一条气泡
function _tomatoAppendBubble(text) {
  const list = document.getElementById('tomato-companion-msgs');
  if (!list || !_tomatoCompanion) return;
  const name = _tomatoCompanion.name || '陪伴';
  const bubble = document.createElement('div');
  bubble.className = 'phone-tomato-comp-bubble';
  bubble.innerHTML = `<div class="phone-tomato-comp-bubble-name">${Utils.escapeHtml(name)}</div><div class="phone-tomato-comp-bubble-text">${Utils.escapeHtml(text)}</div>`;
  list.appendChild(bubble);
  list.scrollTop = list.scrollHeight;
}

// 查看历史详情
async function _tomatoShowDetail(idx) {
  const pd = await _getPhoneData();
  if (!pd) return;
  const h = (pd.tomatoHistory || [])[idx];
  if (!h) return;
  const date = new Date(h.completedAt);
  const dateStr = date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
  const timeStr = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10015;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const msgsHtml = (h.companionMsgs && h.companionMsgs.length)
    ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">陪伴留言</div>
        ${h.companionMsgs.map(m => `<div style="font-size:12px;color:var(--text);line-height:1.5;padding:3px 0">· ${Utils.escapeHtml(m)}</div>`).join('')}
      </div>` : '';

  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:300px;width:100%;color:var(--text);padding:20px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="${h.interrupted ? 'var(--text-secondary)' : 'var(--accent)'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        <div>
          <div style="font-size:15px;font-weight:600">${Utils.escapeHtml(h.goal || '无目标')}</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${h.interrupted ? '已中断' : '已完成'}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
        <div style="background:var(--bg-secondary);border-radius:8px;padding:8px 10px"><div style="color:var(--text-secondary);font-size:10px">时长</div><div style="font-weight:600;margin-top:2px">${h.duration} 分钟</div></div>
        <div style="background:var(--bg-secondary);border-radius:8px;padding:8px 10px"><div style="color:var(--text-secondary);font-size:10px">日期</div><div style="font-weight:600;margin-top:2px">${dateStr}</div></div>
        <div style="background:var(--bg-secondary);border-radius:8px;padding:8px 10px"><div style="color:var(--text-secondary);font-size:10px">时间</div><div style="font-weight:600;margin-top:2px">${timeStr}</div></div>
        <div style="background:var(--bg-secondary);border-radius:8px;padding:8px 10px"><div style="color:var(--text-secondary);font-size:10px">陪伴</div><div style="font-weight:600;margin-top:2px">${Utils.escapeHtml(h.companion || '无')}</div></div>
      </div>
      ${msgsHtml}
      <button onclick="this.closest('div[style*=fixed]').remove()" style="width:100%;margin-top:14px;padding:11px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">关闭</button>
    </div>`;
  document.body.appendChild(overlay);
}

// 邀请陪伴：弹出联系人选择
async function _tomatoInviteCompanion() {
  if (!_tomatoGoal) { UI.showToast('请先设置专注目标', 1500); return; }
  const pd = await _getPhoneData();
  if (!pd) return;
  const contacts = pd.chatContacts || [];
  if (contacts.length === 0) { UI.showToast('还没有联系人', 1500); return; }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10015;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const listHtml = contacts.map(c => {
    const ava = c.avatar
      ? `<img src="${Utils.escapeHtml(c.avatar)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover">`
      : `<div style="width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600">${Utils.escapeHtml((c.name || '?')[0])}</div>`;
    return `<div onclick="event.stopPropagation();Phone._tomatoSelectCompanion('${c.id}')" style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;cursor:pointer;transition:background .1s" onpointerdown="this.style.background='var(--bg-tertiary)'" onpointerup="this.style.background=''" onpointerleave="this.style.background=''">
      ${ava}
      <div style="font-size:14px;color:var(--text);font-weight:500">${Utils.escapeHtml(c.name || '未知')}</div>
    </div>`;
  }).join('');

  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:320px;width:100%;color:var(--text);max-height:70vh;display:flex;flex-direction:column">
      <div style="font-size:15px;font-weight:600;padding:18px 20px 12px;flex-shrink:0">邀请谁陪你？</div>
      <div style="flex:1;overflow-y:auto;padding:0 8px 14px">${listHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
}

// 选定陪伴角色 → 请求 AI 生成台词
async function _tomatoSelectCompanion(contactId) {
  document.querySelector('div[style*="fixed"][style*="10015"]')?.remove();
  const pd = await _getPhoneData();
  if (!pd) return;
  const contact = (pd.chatContacts || []).find(c => c.id === contactId);
  if (!contact) { UI.showToast('联系人不存在', 1500); return; }

  // 计算条数：每5分钟一条，包含0分钟那条
  const durMin = _tomatoSetMinutes || 25;
  const msgCount = Math.floor(durMin / 5) + 1;

  // 立刻显示头像 + "等待加入中"
  _tomatoCompanion = { name: contact.name, avatar: contact.avatar || '', lines: [], pending: true };
  if (_currentApp === 'tomato') _renderTomato(pd);

  // 获取角色人设
  let personaStr = contact.name || '未知';
  try {
    const cands = await _collectChatCandidates();
    const cand = cands.find(c => c.name === contact.name);
    if (cand && cand.detail) personaStr += '\n' + cand.detail;
  } catch(_) {}

  // 世界观上下文
  let fullCtx = '';
  try { fullCtx = await _buildFullContext({ npcBrief: true }); } catch(_) {}

  // 游戏时间
  let gameTime = '';
  try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}

  // 玩家名
  const myName = (() => { try { const mk = Character.get(); return mk?.name || '我'; } catch(_) { return '我'; } })();

  const systemPrompt = `${fullCtx}

【你的角色】
你是「${contact.name}」，${myName}邀请你通过番茄钟 App 陪伴 TA 专注。
${personaStr}

【基本信息】
- 玩家名：${myName}
- 专注目标：${_tomatoGoal || '（未设置）'}
- 专注时长：${durMin} 分钟
- 当前游戏时间：${gameTime || '（未知）'}
- 你需要生成 ${msgCount} 条消息（第 1 条在开始时发出，之后每 5 分钟一条，最后一条为收尾）

【你此刻的状态】
根据上方主线剧情和当前游戏时间，推断你此刻可能在做什么——也许正在工作、阅读、做饭、散步、甚至在洗澡。你有自己的生活节奏，被邀请进番茄钟时你不会停下手里的事，而是一边处理自己的事情，一边通过 App 给 TA 发消息陪伴。

【输出要求】
- 严格输出 ${msgCount} 条消息，每条一行，用序号标记（1. 2. 3. ...）
- 每条消息简短自然（1-2句话），符合你的性格和说话方式
- 第 1 条：你被邀请进来的第一反应（可以是打招呼、吐槽、随口一句、或者描述自己正在做什么）
- 中间几条：可以简单鼓励、分享你正在做的事、碎碎念、或者沉默许久后冒出一句话——自由发挥，不要每条都是"加油"
- 最后一条：收尾，可以是"时间到了"、"辛苦了"、或者跟你自己的状态呼应
- 不要使用 emoji，不要使用括号描述动作，只输出纯对话文字
- 不要输出其他任何内容，只输出编号列表`;

  try {
    // API 配置
    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) { UI.showToast('请先配置功能模型', 2000); _tomatoCompanion = null; return; }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model, stream: false, temperature: 0.8, max_tokens: 2000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请以「${contact.name}」的身份生成 ${msgCount} 条番茄钟陪伴消息。` }
        ]
      })
    });
    if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
    const json = await resp.json();
    const raw = json.choices?.[0]?.message?.content || '';

    // 解析编号列表
    const lines = (raw || '').split('\n')
      .map(l => l.replace(/^\d+[\.\)、]\s*/, '').trim())
      .filter(l => l.length > 0)
      .slice(0, msgCount);
    if (lines.length === 0) {
      UI.showToast('生成失败，请重试', 1500);
      _tomatoCompanion = null;
    } else {
      _tomatoCompanion = { name: contact.name, avatar: contact.avatar || '', lines, pending: false };
      UI.showToast(`${contact.name}已加入`, 1500);
    }
  } catch(e) {
    UI.showToast('请求失败：' + (e?.message || '未知错误'), 2000);
    _tomatoCompanion = null;
  }
  if (_currentApp === 'tomato') {
    const pd2 = await _getPhoneData();
    if (pd2) _renderTomato(pd2);
  }
}

// 番茄钟设定分钟数（未启动时的预设）
let _tomatoSetMinutes = 25;

// 编辑番茄钟设置（综合弹窗：目标+时长+选项）
async function _tomatoEditGoal() {
  if (_tomatoTimer) return; // 运行中不可改
  const pd = await _getPhoneData();
  const settings = pd?.tomatoSettings || { syncMainline: true, syncCompanion: true, lockScreen: false };
  const currentGoal = _tomatoGoal || '';
  const currentMin = _tomatoSetMinutes || 25;
  const presets = [15, 25, 45, 60];
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10015;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:320px;width:100%;color:var(--text);max-height:80vh;overflow-y:auto">
      <div style="font-size:15px;font-weight:600;padding:18px 20px 12px">专注设置</div>
      <div style="padding:0 20px">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">专注目标</div>
        <input id="tomato-goal-input" value="${Utils.escapeHtml(currentGoal)}" placeholder="在做什么？（可选）" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none">
      </div>
      <div style="padding:12px 20px 0">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">专注时长（分钟）</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${presets.map(p => `<button onpointerdown="event.preventDefault();document.getElementById('tomato-dur-input').value=${p};this.parentElement.querySelectorAll('button').forEach(b=>{b.style.background='transparent';b.style.color='var(--text)'});this.style.background='var(--accent)';this.style.color='#111'" style="flex:1;min-width:50px;padding:8px 0;border-radius:8px;border:1px solid var(--border);background:${p === currentMin ? 'var(--accent)' : 'transparent'};color:${p === currentMin ? '#111' : 'var(--text)'};font-size:13px;font-weight:600;cursor:pointer">${p}</button>`).join('')}
        </div>
        <input id="tomato-dur-input" type="number" min="1" max="120" value="${currentMin}" placeholder="自定义" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-top:8px">
      </div>
      <div style="padding:14px 20px 0">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">选项</div>
        <label style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;font-size:13px;color:var(--text)">
          <input id="tomato-opt-sync" type="checkbox" ${settings.syncMainline !== false ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--accent)">
          向主线同步番茄钟进度
        </label>
        <label style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;font-size:13px;color:var(--text)">
          <input id="tomato-opt-companion" type="checkbox" ${settings.syncCompanion !== false ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--accent)">
          专注结束后同步给邀请的联系人
        </label>
        <label style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;font-size:13px;color:var(--text)">
          <input id="tomato-opt-lock" type="checkbox" ${settings.lockScreen ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--accent)">
          专注时锁定屏幕
        </label>
      </div>
      <div style="display:flex;gap:10px;padding:14px 20px 18px">
        <button onpointerdown="event.preventDefault();this.closest('div[style*=fixed]').remove()" style="flex:1;padding:11px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">取消</button>
        <button onpointerdown="event.preventDefault();Phone._tomatoSaveSettings()" style="flex:1;padding:11px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">确定</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('tomato-goal-input')?.focus(), 100);
}

async function _tomatoSaveSettings() {
  const goal = (document.getElementById('tomato-goal-input')?.value || '').trim();
  const dur = parseInt(document.getElementById('tomato-dur-input')?.value, 10);
  const syncMainline = !!document.getElementById('tomato-opt-sync')?.checked;
  const syncCompanion = !!document.getElementById('tomato-opt-companion')?.checked;
  const lockScreen = !!document.getElementById('tomato-opt-lock')?.checked;
  _tomatoGoal = goal;
  if (dur && dur > 0) _tomatoSetMinutes = Math.max(1, Math.min(120, dur));
  document.querySelector('div[style*="fixed"][style*="10015"]')?.remove();
  const pd = await _getPhoneData();
  if (pd) {
    pd.tomatoSettings = { syncMainline, syncCompanion, lockScreen };
    await _savePhoneData();
  }
  if (pd && _currentApp === 'tomato') _renderTomato(pd);
  _refreshTomatoCard();
}

async function _tomatoSaveGoal() {
  // 保留旧接口兼容，实际走 _tomatoSaveSettings
  await _tomatoSaveSettings();
}

// 编辑预设时长（点击时间大字，仅未开始时）
function _tomatoEditDuration() {
  if (_tomatoTimer || _tomatoDuration > 0) return;
  const current = _tomatoSetMinutes || 25;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10015;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const presets = [15, 25, 45, 60];
  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:300px;width:100%;color:var(--text)">
      <div style="font-size:15px;font-weight:600;padding:18px 20px 12px">专注时长（分钟）</div>
      <div style="display:flex;gap:8px;padding:0 20px;flex-wrap:wrap">
        ${presets.map(p => `<button onpointerdown="event.preventDefault();Phone._tomatoSetDuration(${p})" style="flex:1;min-width:56px;padding:9px 0;border-radius:8px;border:1px solid var(--border);background:${p === current ? 'var(--accent)' : 'transparent'};color:${p === current ? '#111' : 'var(--text)'};font-size:13px;font-weight:600;cursor:pointer">${p}</button>`).join('')}
      </div>
      <div style="padding:12px 20px 4px">
        <input id="tomato-dur-input" type="number" min="1" max="120" value="${current}" placeholder="自定义（1-120）" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none">
      </div>
      <div style="display:flex;gap:10px;padding:14px 20px 18px">
        <button onpointerdown="event.preventDefault();this.closest('div[style*=fixed]').remove()" style="flex:1;padding:11px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">取消</button>
        <button onpointerdown="event.preventDefault();Phone._tomatoSaveDuration()" style="flex:1;padding:11px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">确定</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function _tomatoSetDuration(min) {
  _tomatoSetMinutes = Math.max(1, Math.min(120, min));
  document.querySelector('div[style*="fixed"][style*="10015"]')?.remove();
  const pd = await _getPhoneData();
  if (pd && _currentApp === 'tomato') _renderTomato(pd);
  _refreshTomatoCard();
}

async function _tomatoSaveDuration() {
  const v = parseInt(document.getElementById('tomato-dur-input')?.value, 10);
  if (v && v > 0) _tomatoSetMinutes = Math.max(1, Math.min(120, v));
  document.querySelector('div[style*="fixed"][style*="10015"]')?.remove();
  const pd = await _getPhoneData();
  if (pd && _currentApp === 'tomato') _renderTomato(pd);
  _refreshTomatoCard();
}

// 播放/暂停切换
async function _tomatoToggle() {
  if (_tomatoTimer) {
    // 暂停：停掉 timer，记住剩余时间
    clearInterval(_tomatoTimer);
    _tomatoTimer = null;
    _tomatoClearCompanionTimers();
    _tomatoDuration = Math.max(0, _tomatoEndTime - Date.now());
    _tomatoEndTime = 0;
    const pd = await _getPhoneData();
    if (pd && _currentApp === 'tomato') _renderTomato(pd);
    _refreshTomatoCard();
  } else {
    // 开始/恢复
    // 未开始且没目标 → 提示先设置
    if (_tomatoDuration <= 0 && !_tomatoGoal) {
      UI.showToast('请先设置专注目标', 1500);
      return;
    }
    const dur = _tomatoDuration > 0 ? _tomatoDuration : _tomatoSetMinutes * 60000;
    _tomatoDuration = dur;
    if (_tomatoOriginalDur <= 0) _tomatoOriginalDur = dur; // 首次开始记住原始总时长
    _tomatoEndTime = Date.now() + dur;
    _tomatoTimer = setInterval(_tomatoTick, 1000);
    // 启动陪伴消息定时弹出
    _tomatoStartCompanionTimers();
    const pd = await _getPhoneData();
    if (pd && _currentApp === 'tomato') _renderTomato(pd);
    _refreshTomatoCard();
  }
}

// 调整时间 ±5分钟
async function _tomatoAdjust(delta) {
  if (_tomatoTimer) {
    // 运行中：调整结束时间
    _tomatoEndTime += delta * 60000;
    if (_tomatoEndTime <= Date.now()) {
      _tomatoComplete();
      return;
    }
    _tomatoDuration += delta * 60000;
  } else if (_tomatoDuration > 0) {
    // 暂停中：调整剩余
    _tomatoDuration = Math.max(60000, _tomatoDuration + delta * 60000);
  } else {
    // 未开始：调整预设
    _tomatoSetMinutes = Math.max(1, Math.min(120, _tomatoSetMinutes + delta));
  }
  const pd = await _getPhoneData();
  if (pd && _currentApp === 'tomato') _renderTomato(pd);
  _refreshTomatoCard();
}

// 重置（清空计时，回到初始状态）
async function _tomatoReset() {
  if (_tomatoTimer) { clearInterval(_tomatoTimer); _tomatoTimer = null; }
  _tomatoClearCompanionTimers();
  _tomatoEndTime = 0;
  _tomatoDuration = 0;
  _tomatoOriginalDur = 0;
  _tomatoGoal = '';
  _tomatoCompanion = null;
  const pd = await _getPhoneData();
  if (pd && _currentApp === 'tomato') _renderTomato(pd);
  _refreshTomatoCard();
}

// 直接结束（记录为完成）
async function _tomatoFinish() {
  if (!_tomatoTimer && _tomatoDuration <= 0) { UI.showToast('还没有开始', 1200); return; }
  await _tomatoComplete();
  const pd = await _getPhoneData();
  if (pd && _currentApp === 'tomato') _renderTomato(pd);
}

function _switchTomatoTab(tab) {
  _tomatoTab = tab;
  (async () => { const pd = await _getPhoneData(); if (pd) _renderTomato(pd); })();
}

async function _tomatoStartFromUI() {
  const dur = parseInt(document.getElementById('tomato-dur')?.value, 10) || 25;
  const goal = (document.getElementById('tomato-goal')?.value || '').trim();
  await _tomatoStart(dur, goal, null);
  const pd = await _getPhoneData();
  if (pd && _currentApp === 'tomato') _renderTomato(pd);
}

// ===== 全部订单聚合页（飞鸟/游鱼/桃宝/饿了咪） =====
let _deliveriesTab = 'all'; // 'all' | 'delivering' | 'done'

// 判定订单来源 { label, kind }
function _deliveryOrderSource(o, field) {
  if (o.sellBuy) return { label: '聊天·交易', cls: 'youyu' };
  if (o.feiniaoReceive) return { label: '飞鸟·收件', cls: 'feiniao' };
  if (o.feiniaoShip) return { label: '飞鸟·寄件', cls: 'feiniao' };
  if (o.youyuSell) return { label: '游鱼·售出', cls: 'youyu' };
  if (field === 'takeoutOrders') return { label: (_shopMeta?.takeout?.name || '饿了咪'), cls: 'takeout' };
  return { label: (_shopMeta?.shop?.name || '桃宝'), cls: 'shop' };
}

// 判断订单是否可以「收入物品栏」：必须是「收进来给自己的」+ 已送达 + 未收取过
// 可收：飞鸟收件、桃宝/饿了咪给自己买的；不可收：飞鸟寄件、游鱼售出、给别人买的
function _deliveryClaimable(o, field) {
  if (!o || o.claimedToInv) return false;
  // 已送达判定
  let delivered = o.status === 'delivered';
  if (!delivered && o.status === 'delivering' && o.deliveryMinutes) {
    const rem = _getDeliveryRemaining(o);
    delivered = (rem !== null && rem <= 0);
  }
  if (!delivered) return false;
  // 用户寄出/卖出的，不收
  if (o.youyuSell) return false;
  if (o.feiniaoShip && !o.feiniaoReceive) return false;
  // 飞鸟收件：收进来给自己
  if (o.feiniaoReceive) return true;
  // 网购：仅「给自己买」才能收
  const tgt = (o.target || '自己').trim();
  return tgt === '自己' || tgt === '';
}

// 取订单内的物品列表（用于收入物品栏）
function _deliveryItemsOf(o) {
  if (Array.isArray(o.shipItems) && o.shipItems.length) {
    return o.shipItems.map(it => ({ name: (it.name || '').trim(), count: it.count || 1, effect: it.effect || '' }));
  }
  if (Array.isArray(o.items) && o.items.length) {
    return o.items.map(it => ({ name: (it.name || '').trim(), count: it.count || 1, effect: it.effect || '' }));
  }
  // 网购订单没有物品数组，用订单名 + desc
  return [{ name: (o.name || '物品').trim(), count: 1, effect: (o.desc || '').trim() }];
}

// 收入物品栏：把订单物品写入当前面具 inventory，标记 claimedToInv
async function _deliveryClaimToInv(field, orderId) {
  const pd = await _getPhoneData();
  if (!pd) return;
  const list = pd[field] || [];
  const o = list.find(x => x && x.id === orderId);
  if (!o) { UI.showToast('订单不存在', 1500); return; }
  if (!_deliveryClaimable(o, field)) { UI.showToast('该订单不可收取', 1500); return; }

  const items = _deliveryItemsOf(o).filter(it => it.name);
  if (!items.length) { UI.showToast('没有可收取的物品', 1500); return; }

  // 写入当前面具的物品栏
  let maskId = '';
  try { maskId = Character.getCurrentId(); } catch(_) {}
  if (!maskId) { UI.showToast('当前没有激活的面具', 1800); return; }
  try {
    const maskData = await DB.get('characters', maskId);
    if (!maskData) { UI.showToast('面具数据读取失败', 1800); return; }
    const inv = Array.isArray(maskData.inventory) ? maskData.inventory : [];
    items.forEach(it => {
      const idx = inv.findIndex(x => (x?.name || '').trim() === it.name);
      if (idx >= 0) {
        inv[idx].count = (inv[idx].count || 1) + (it.count || 1);
        if (it.effect && !inv[idx].effect) inv[idx].effect = it.effect;
      } else {
        inv.push({ name: it.name, count: it.count || 1, effect: it.effect || '' });
      }
    });
    maskData.inventory = inv;
    await DB.put('characters', maskData);
  } catch(e) {
    console.warn('[全部订单] 收入物品栏失败', e);
    UI.showToast('收取失败', 1500);
    return;
  }

  o.claimedToInv = true;
  await _savePhoneData();
  const itemNames = items.map(it => it.count > 1 ? `${it.name}×${it.count}` : it.name).join('、');
  UI.showToast(`已收入物品栏：${itemNames}`, 2200);
  if (_currentApp === 'deliveries') _renderDeliveries(pd);
}

function _renderDeliveries(pd) {
  const body = document.getElementById('phone-body');
  document.getElementById('phone-title').textContent = '全部订单';
  _applyWallpaper(pd);

  // 聚合两个订单数组，附带来源字段
  const all = []
    .concat((pd?.shopOrders || []).map(o => ({ o, field: 'shopOrders' })))
    .concat((pd?.takeoutOrders || []).map(o => ({ o, field: 'takeoutOrders' })))
    .filter(x => x.o);

  // 按下单游戏时间倒序（新→旧）；无时间的排最后
  all.sort((a, b) => {
    const ta = _gameTimeToMinutes(a.o.orderGameTime || '') ?? -1;
    const tb = _gameTimeToMinutes(b.o.orderGameTime || '') ?? -1;
    return tb - ta;
  });

  // tab 过滤
  const isDelivering = (o) => {
    if (o.status === 'delivered') return false;
    if (o.status === 'delivering') {
      const rem = _getDeliveryRemaining(o);
      return rem === null ? true : rem > 0;
    }
    return false;
  };
  let list = all;
  if (_deliveriesTab === 'delivering') list = all.filter(x => isDelivering(x.o));
  else if (_deliveriesTab === 'done') list = all.filter(x => !isDelivering(x.o));

  const cardsHtml = list.length > 0 ? list.map(({ o, field }) => {
    const src = _deliveryOrderSource(o, field);
    // 配送状态
    let statusHtml = '';
    if (o.status === 'delivered') {
      statusHtml = '<span style="font-size:11px;color:#22c55e;font-weight:600">已送达 ✓</span>';
    } else if (o.status === 'delivering' && o.deliveryMinutes) {
      const rem = _getDeliveryRemaining(o);
      if (rem !== null && rem <= 0) {
        statusHtml = '<span style="font-size:11px;color:#22c55e;font-weight:600">已送达 ✓</span>';
      } else if (rem !== null) {
        statusHtml = `<span style="font-size:11px;color:var(--accent);font-weight:600">配送中 · ${_formatDeliveryRemaining(rem)}后到达</span>`;
      }
    }
    // 副信息：收/寄件人或目标
    let metaPill = '';
    if (o.feiniaoReceive) metaPill = o.sender ? `来自 ${Utils.escapeHtml(o.sender)}` : '';
    else if (o.feiniaoShip) metaPill = o.target ? `寄给 ${Utils.escapeHtml(o.target)}` : '';
    else if (o.youyuSell) metaPill = o.buyer ? `买家 ${Utils.escapeHtml(o.buyer)}` : '';
    else metaPill = (o.target && o.target !== '自己') ? `→ ${Utils.escapeHtml(o.target)}` : '自己';
    // 价格
    let priceStr = '';
    if (o.youyuSell && o.youyuIncome) priceStr = `+${o.youyuIncome} ${Utils.escapeHtml(o.youyuCurName || '')}`;
    else if (o.price) priceStr = `¥ ${Utils.escapeHtml(String(o.price))}`;
    return `
      <div class="phone-map-result-card">
        <div class="phone-map-result-head">
          <div class="phone-map-result-name">${Utils.escapeHtml(o.name || '订单')}</div>
        </div>
        ${o.desc ? `<div class="phone-map-result-desc">${Utils.escapeHtml(o.desc)}</div>` : ''}
        <div class="phone-map-result-foot">
          <div class="phone-map-result-foot-left">
            <span class="phone-map-distance-pill phone-delivery-src-${src.cls}">${Utils.escapeHtml(src.label)}</span>
            ${priceStr ? `<span class="phone-map-distance-pill">${priceStr}</span>` : ''}
            ${metaPill ? `<span class="phone-map-distance-pill">${metaPill}</span>` : ''}
          </div>
        </div>
        ${statusHtml ? `<div style="margin-top:6px">${statusHtml}</div>` : ''}
        ${o.claimedToInv
          ? `<div style="margin-top:8px;font-size:11px;color:var(--text-secondary)">${_uiIcon('check', 11)} 已收入物品栏</div>`
          : (_deliveryClaimable(o, field)
            ? `<div style="margin-top:8px;display:flex;justify-content:flex-end"><button type="button" onclick="Phone._deliveryClaimToInv('${field}','${o.id}')" class="phone-map-action-btn">${_uiIcon('box', 12)} 收入物品栏</button></div>`
            : '')}
        <div style="font-size:10px;color:var(--text-secondary);margin-top:6px">${o.feiniaoReceive ? '收件于' : (o.youyuSell ? '售出于' : '下单于')} ${Utils.escapeHtml(o.time || o.orderGameTime || '')}</div>
      </div>`;
  }).join('') : '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:40px">暂无订单</p>';

  body.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%">
      <div style="flex:1;overflow-y:auto;padding:12px">
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">共 ${list.length} 个订单</div>
        ${cardsHtml}
      </div>
      <div class="phone-tabbar">
        <div class="phone-tab ${_deliveriesTab === 'all' ? 'active' : ''}" onclick="Phone._switchDeliveriesTab('all')">全部</div>
        <div class="phone-tab ${_deliveriesTab === 'delivering' ? 'active' : ''}" onclick="Phone._switchDeliveriesTab('delivering')">配送中</div>
        <div class="phone-tab ${_deliveriesTab === 'done' ? 'active' : ''}" onclick="Phone._switchDeliveriesTab('done')">已完成</div>
      </div>
    </div>
  `;
}

async function _switchDeliveriesTab(tab) {
  _deliveriesTab = tab;
  const pd = await _getPhoneData();
  if (pd) _renderDeliveries(pd);
}

// ===== 飞鸟（快递）App =====
let _feiniaoTab = 'send'; // 'send' | 'receive'

function _renderFeiniao(pd) {
 const body = document.getElementById('phone-body');
 document.getElementById('phone-title').textContent = '飞鸟';
 _applyWallpaper(pd);
 // 寄件：feiniaoShip 且非收件方向
 const shipOrders = []
   .concat((pd?.shopOrders || []).filter(o => o && o.feiniaoShip && !o.feiniaoReceive))
   .concat((pd?.takeoutOrders || []).filter(o => o && o.feiniaoShip && !o.feiniaoReceive));
 const sendListHtml = _renderFeiniaoOrdersHtml(shipOrders);
 // 收件：char 寄给 user 的
 const recvOrders = []
   .concat((pd?.shopOrders || []).filter(o => o && o.feiniaoReceive))
   .concat((pd?.takeoutOrders || []).filter(o => o && o.feiniaoReceive));
 const recvListHtml = _renderFeiniaoOrdersHtml(recvOrders, true);
 body.innerHTML = `
 <div style="display:flex;flex-direction:column;height:100%">
   <div id="phone-feiniao-send-panel" style="flex:1;overflow-y:auto;padding:16px;display:${_feiniaoTab === 'send' ? 'block' : 'none'}">
     <button onclick="Phone._feiniaoAddOrder()" style="width:100%;padding:12px;border-radius:10px;border:1px dashed var(--border);background:transparent;color:var(--text-secondary);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:12px">
       <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
       添加寄件订单
     </button>
     <div>${sendListHtml}</div>
   </div>
   <div id="phone-feiniao-receive-panel" style="flex:1;overflow-y:auto;padding:16px;display:${_feiniaoTab === 'receive' ? 'block' : 'none'}">
     <div>${recvListHtml}</div>
   </div>
   <div class="phone-tabbar">
     <div class="phone-tab ${_feiniaoTab === 'send' ? 'active' : ''}" onclick="Phone._switchFeiniaoTab('send')">寄件</div>
     <div class="phone-tab ${_feiniaoTab === 'receive' ? 'active' : ''}" onclick="Phone._switchFeiniaoTab('receive')">收件</div>
   </div>
 </div>
 `;
}

async function _switchFeiniaoTab(tab) {
 _feiniaoTab = tab;
 const pd = await _getPhoneData();
 if (pd) _renderFeiniao(pd);
}

// 飞鸟寄件订单列表卡片（仿商品订单卡片：订单名 / 配送状态 / 寄给谁 / 下单时间，点击看详情）
function _renderFeiniaoOrdersHtml(orders, isReceive) {
 if (!orders.length) return `<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">${isReceive ? '暂无收件' : '暂无寄件订单'}</p>`;
 return orders.slice().sort((a, b) => {
   const ta = _gameTimeToMinutes(a.orderGameTime) || 0;
   const tb = _gameTimeToMinutes(b.orderGameTime) || 0;
   return tb - ta;
 }).map(o => {
   // 配送状态
   let statusHtml = '';
   if (o.status === 'delivered') {
     statusHtml = '<span style="font-size:11px;color:#22c55e;font-weight:600">已送达 ✓</span>';
   } else if (o.status === 'delivering' && o.deliveryMinutes) {
     const remaining = _getDeliveryRemaining(o);
     if (remaining !== null && remaining <= 0) {
       statusHtml = '<span style="font-size:11px;color:#22c55e;font-weight:600">已送达 ✓</span>';
     } else if (remaining !== null) {
       statusHtml = `<span style="font-size:11px;color:var(--accent);font-weight:600">配送中 · ${_formatDeliveryRemaining(remaining)}后到达</span>`;
     }
   }
   const modeLabel = o.shipMode === 'errand' ? '跑腿' : '快递';
   const whoPill = isReceive ? `来自 ${Utils.escapeHtml(o.sender || '某人')}` : `→ ${Utils.escapeHtml(o.target || '')}`;
   return `
     <div class="phone-map-result-card" onclick="Phone._feiniaoShowOrderDetail('${o.id}')" style="cursor:pointer">
       <div class="phone-map-result-head">
         <div class="phone-map-result-name">${Utils.escapeHtml(o.name || (isReceive ? '收件' : '寄件'))}</div>
       </div>
       <div class="phone-map-result-foot">
         <div class="phone-map-result-foot-left">
           <span class="phone-map-distance-pill">${modeLabel}</span>
           <span class="phone-map-distance-pill">${whoPill}</span>
         </div>
       </div>
       ${statusHtml ? `<div style="margin-top:6px">${statusHtml}</div>` : ''}
       <div style="font-size:10px;color:var(--text-secondary);margin-top:6px">${isReceive ? '收到于' : '下单于'} ${Utils.escapeHtml(o.time || '')}</div>
     </div>`;
 }).join('');
}

// 飞鸟寄件订单详情弹窗（物品列表 / 收件人 / 时效等）
async function _feiniaoShowOrderDetail(orderId) {
 const pd = await _getPhoneData();
 const all = [].concat(pd?.shopOrders || [], pd?.takeoutOrders || []);
 const o = all.find(x => x && x.id === orderId);
 if (!o) { UI.showToast('订单不存在', 1200); return; }
 const modeLabel = o.shipMode === 'errand' ? '跑腿' : '快递';
 let statusText = '配送中';
 if (o.status === 'delivered') statusText = '已送达';
 else if (o.status === 'delivering' && o.deliveryMinutes) {
   const rem = _getDeliveryRemaining(o);
   if (rem !== null && rem <= 0) statusText = '已送达';
   else if (rem !== null) statusText = `配送中 · ${_formatDeliveryRemaining(rem)}后到达`;
 }
 const items = Array.isArray(o.shipItems) ? o.shipItems : [];
 const itemsHtml = items.length
   ? items.map(it => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0"><span style="font-size:13px;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(it.name || '')}${it.effect ? ` <span style='color:var(--text-secondary);font-size:11px'>${Utils.escapeHtml(it.effect)}</span>` : ''}</span><span style="font-size:13px;color:var(--text-secondary);flex-shrink:0">×${it.count || 1}</span></div>`).join('')
   : '<div style="font-size:12px;color:var(--text-secondary)">无</div>';
 const recips = Array.isArray(o.recipients) ? o.recipients : [];
 const recipHtml = recips.length
   ? recips.map(r => {
       const initial = Utils.escapeHtml((r.name || '?')[0]);
       const avaUrl = _chatAvatarMap[r.name] || '';
       const avatar = avaUrl ? `<img src="${Utils.escapeHtml(avaUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">` : initial;
       return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0"><div style="width:26px;height:26px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;overflow:hidden">${avatar}</div><span style="font-size:13px;color:var(--text)">${Utils.escapeHtml(r.name || '')}</span></div>`;
     }).join('')
   : `<div style="font-size:13px;color:var(--text)">${Utils.escapeHtml(o.target || '')}</div>`;
 const mask = document.createElement('div');
 mask.id = 'feiniao-order-detail-overlay';
 mask.style.cssText = 'position:fixed;inset:0;z-index:10015;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
 mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
 mask.innerHTML = `
   <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:360px;width:100%;max-height:86vh;display:flex;flex-direction:column;color:var(--text)">
     <div style="display:flex;align-items:center;gap:10px;padding:18px 20px 12px">
       <div style="font-size:16px;font-weight:600;flex:1;min-width:0">${Utils.escapeHtml(o.name || '寄件')}</div>
       <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0;padding:2px 8px;border:1px solid var(--border);border-radius:6px">${modeLabel}</span>
     </div>
<div style="flex:1;overflow-y:auto;padding:0 20px 4px">
        <div style="font-size:13px;color:var(--accent);font-weight:600;margin-bottom:12px">${statusText}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">物品列表</div>
        <div style="margin-bottom:14px">${itemsHtml}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">收件人</div>
        <div style="margin-bottom:14px">${o.feiniaoReceive ? '<div style="font-size:13px;color:var(--text)">自己</div>' : recipHtml}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">寄件人</div>
        <div style="font-size:13px;color:var(--text);margin-bottom:14px">${o.feiniaoReceive ? Utils.escapeHtml(o.sender || '某人') : (o.hideSender ? '匿名' : '自己')}</div>
        <div style="font-size:11px;color:var(--text-secondary)">${o.feiniaoReceive ? '收到于' : '下单于'} ${Utils.escapeHtml(o.time || '')}</div>
      </div>
     <div style="display:flex;gap:10px;padding:12px 20px 18px">
       <button onclick="Phone._feiniaoDeleteOrder('${o.id}')" style="flex:1;padding:11px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--error);font-size:14px;cursor:pointer">删除</button>
       <button onclick="document.getElementById('feiniao-order-detail-overlay').remove()" style="flex:1;padding:11px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">关闭</button>
     </div>
   </div>
 `;
 document.body.appendChild(mask);
}

// 删除飞鸟寄件订单
async function _feiniaoDeleteOrder(orderId) {
 const pd = await _getPhoneData();
 if (!pd) return;
 pd.shopOrders = (pd.shopOrders || []).filter(o => o.id !== orderId);
 pd.takeoutOrders = (pd.takeoutOrders || []).filter(o => o.id !== orderId);
 await _savePhoneData();
 document.getElementById('feiniao-order-detail-overlay')?.remove();
 if (_currentApp === 'feiniao') _renderFeiniao(pd);
 UI.showToast('已删除', 1000);
}

// ===== 游鱼（小店）App =====
let _youyuTab = 'shop'; // 'shop' | 'orders'
let _youyuListDraft = null; // 上架草稿

function _renderYouyu(pd) {
 const body = document.getElementById('phone-body');
 document.getElementById('phone-title').textContent = '游鱼';
 _applyWallpaper(pd);
 const listings = (pd?.shopListings || []);
 const shopHtml = _renderYouyuListingsHtml(listings);
 // 卖出订单（游鱼标记）
 const sellOrders = []
   .concat((pd?.shopOrders || []).filter(o => o && o.youyuSell))
   .concat((pd?.takeoutOrders || []).filter(o => o && o.youyuSell));
 const ordersHtml = _renderYouyuOrdersHtml(sellOrders);
 body.innerHTML = `
 <div style="display:flex;flex-direction:column;height:100%">
   <div id="phone-youyu-shop-panel" style="flex:1;overflow-y:auto;padding:16px;display:${_youyuTab === 'shop' ? 'block' : 'none'}">
     <button onclick="Phone._youyuAddListing()" style="width:100%;padding:12px;border-radius:10px;border:1px dashed var(--border);background:transparent;color:var(--text-secondary);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:12px">
       <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
       上架商品
     </button>
     <div>${shopHtml}</div>
   </div>
   <div id="phone-youyu-orders-panel" style="flex:1;overflow-y:auto;padding:16px;display:${_youyuTab === 'orders' ? 'block' : 'none'}">
     <div>${ordersHtml}</div>
   </div>
   <div class="phone-tabbar">
     <div class="phone-tab ${_youyuTab === 'shop' ? 'active' : ''}" onclick="Phone._switchYouyuTab('shop')">店铺</div>
     <div class="phone-tab ${_youyuTab === 'orders' ? 'active' : ''}" onclick="Phone._switchYouyuTab('orders')">订单</div>
   </div>
 </div>
 `;
}

async function _switchYouyuTab(tab) {
 _youyuTab = tab;
 const pd = await _getPhoneData();
 if (pd) _renderYouyu(pd);
}

// 在售商品卡片
function _renderYouyuListingsHtml(listings) {
 if (!listings.length) return '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">还没有上架商品</p>';
 const curInfos = _getWalletCurrencyInfos();
 return listings.slice().reverse().map(l => {
   const curName = (curInfos.find(c => c.id === l.currencyId)?.name) || '货币';
   return `
     <div class="phone-map-result-card">
       <div class="phone-map-result-head">
         <div class="phone-map-result-name">${Utils.escapeHtml(l.name || '商品')}</div>
       </div>
       ${l.effect ? `<div class="phone-map-result-desc">${Utils.escapeHtml(l.effect)}</div>` : ''}
       <div class="phone-map-result-foot">
         <div class="phone-map-result-foot-left">
           <span class="phone-map-distance-pill">${Utils.escapeHtml(String(l.price || 0))} ${Utils.escapeHtml(curName)}</span>
           ${l.fromInventory ? '<span class="phone-map-distance-pill">物品栏</span>' : ''}
         </div>
       </div>
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px;flex-wrap:wrap">
          ${l.sharedTo ? `<span style="font-size:11px;color:var(--accent);padding:4px 8px;border:1px solid var(--accent);border-radius:6px">已分享到${l.sharedTo === 'main' ? '主线' : '聊天'}</span>` : `<button type="button" onclick="Phone._youyuShareListing('${l.id}','main')" class="phone-map-action-btn">${_uiIcon('share', 12)} 主线</button><button type="button" onclick="Phone._youyuShareListing('${l.id}','chat')" class="phone-map-action-btn">${_uiIcon('share', 12)} 聊天</button>`}
          <button type="button" onclick="Phone._youyuRemoveListing('${l.id}')" class="phone-map-action-btn danger">${_uiIcon('trash', 12)} 下架</button>
        </div>
     </div>`;
 }).join('');
}

// 游鱼卖出订单详情弹窗
function _youyuShowOrderDetail(orderId) {
  let o = null;
  const pdRaw = (typeof Conversations !== 'undefined') ? Conversations.getList().find(c => c.id === Conversations.getCurrent())?.phoneData : null;
  const all = [].concat(pdRaw?.shopOrders || [], pdRaw?.takeoutOrders || []);
  o = all.find(x => x && x.id === orderId);
  if (!o) { UI.showToast('订单不存在', 1200); return; }

  const deliveryLabel = o.youyuDelivery === 'direct' ? '直接交付' : (o.shipMode === 'errand' ? '跑腿' : '快递');
  let statusText = '配送中';
  let statusColor = 'var(--accent)';
  if (o.status === 'delivered') { statusText = '已完成'; statusColor = '#22c55e'; }
  else if (o.status === 'delivering' && o.deliveryMinutes) {
    const rem = _getDeliveryRemaining(o);
    if (rem !== null && rem <= 0) { statusText = '已送达'; statusColor = '#22c55e'; }
    else if (rem !== null) statusText = `配送中 · ${_formatDeliveryRemaining(rem)}后到达`;
  }
  const items = Array.isArray(o.items) ? o.items : [];
  const itemsHtml = items.length
    ? items.map(it => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0"><span style="font-size:13px;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(it.name || '')}${it.effect ? ` <span style='color:var(--text-secondary);font-size:11px'>${Utils.escapeHtml(it.effect)}</span>` : ''}</span><span style="font-size:13px;color:var(--text-secondary);flex-shrink:0">×${it.count || 1}</span></div>`).join('')
    : `<div style="font-size:13px;color:var(--text)">${Utils.escapeHtml(o.name || '商品')}</div>`;

  const mask = document.createElement('div');
  mask.id = 'youyu-order-detail-overlay';
  mask.style.cssText = 'position:fixed;inset:0;z-index:10015;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
  mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
  mask.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:360px;width:100%;max-height:86vh;display:flex;flex-direction:column;color:var(--text)">
      <div style="display:flex;align-items:center;gap:10px;padding:18px 20px 12px">
        <div style="font-size:16px;font-weight:600;flex:1;min-width:0">${Utils.escapeHtml(o.name || '商品')}</div>
        <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0;padding:2px 8px;border:1px solid var(--border);border-radius:6px">${deliveryLabel}</span>
      </div>
      <div style="flex:1;overflow-y:auto;padding:0 20px 4px">
        <div style="font-size:13px;color:${statusColor};font-weight:600;margin-bottom:12px">${statusText}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">商品</div>
        <div style="margin-bottom:14px">${itemsHtml}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">买家</div>
        <div style="font-size:13px;color:var(--text);margin-bottom:14px">${Utils.escapeHtml(o.buyer || '未知')}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">收入</div>
        <div style="font-size:13px;color:var(--accent);font-weight:600;margin-bottom:14px">${o.youyuIncome ? '+' + Utils.escapeHtml(String(o.youyuIncome)) + ' ' + Utils.escapeHtml(o.youyuCurName || '') : '—'}</div>
        <div style="font-size:11px;color:var(--text-secondary)">售出于 ${Utils.escapeHtml(o.time || '')}</div>
      </div>
      <div style="display:flex;gap:10px;padding:12px 20px 18px">
        <button onclick="Phone._youyuDeleteOrder('${o.id}')" style="flex:1;padding:11px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--error);font-size:14px;cursor:pointer">删除</button>
        <button onclick="document.getElementById('youyu-order-detail-overlay').remove()" style="flex:1;padding:11px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
}

// 卖出订单卡片
function _renderYouyuOrdersHtml(orders) {
 if (!orders.length) return '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">暂无订单</p>';
   return orders.slice().sort((a, b) => {
    const ta = _gameTimeToMinutes(a.orderGameTime) || 0;
   const tb = _gameTimeToMinutes(b.orderGameTime) || 0;
   return tb - ta;
 }).map(o => {
   let statusHtml = '';
   if (o.status === 'delivered') {
     statusHtml = '<span style="font-size:11px;color:#22c55e;font-weight:600">已完成 ✓</span>';
   } else if (o.status === 'delivering' && o.deliveryMinutes) {
     const remaining = _getDeliveryRemaining(o);
     if (remaining !== null && remaining <= 0) {
       statusHtml = '<span style="font-size:11px;color:#22c55e;font-weight:600">已送达 ✓</span>';
     } else if (remaining !== null) {
       statusHtml = `<span style="font-size:11px;color:var(--accent);font-weight:600">配送中 · ${_formatDeliveryRemaining(remaining)}后到达</span>`;
     }
   }
   const deliveryLabel = o.youyuDelivery === 'direct' ? '直接交付' : (o.shipMode === 'errand' ? '跑腿' : '快递');
    return `
      <div class="phone-map-result-card" onclick="Phone._youyuShowOrderDetail('${o.id}')" style="cursor:pointer">
        <div class="phone-map-result-head">
          <div class="phone-map-result-name">${Utils.escapeHtml(o.name || '商品')}</div>
        </div>
       <div class="phone-map-result-foot">
         <div class="phone-map-result-foot-left">
           <span class="phone-map-distance-pill">${deliveryLabel}</span>
           <span class="phone-map-distance-pill">买家 ${Utils.escapeHtml(o.buyer || '')}</span>
           ${o.youyuIncome ? `<span class="phone-map-distance-pill">+${Utils.escapeHtml(String(o.youyuIncome))} ${Utils.escapeHtml(o.youyuCurName || '')}</span>` : ''}
         </div>
       </div>
       ${statusHtml ? `<div style="margin-top:6px">${statusHtml}</div>` : ''}
       <div style="font-size:10px;color:var(--text-secondary);margin-top:6px">售出于 ${Utils.escapeHtml(o.time || '')}</div>
     </div>`;
 }).join('');
}

// 「上架商品」：直接打开上架弹窗
function _youyuAddListing() {
  _youyuInvCtx = null;
  _youyuOpenListModal(-1);
}

// 从物品栏选一件：在同一个弹窗内切换到物品列表视图
async function _youyuPickFromInventory() {
  let maskId = '', inv = [];
  try {
    maskId = Character.getCurrentId();
    const maskData = maskId ? await DB.get('characters', maskId) : null;
    inv = Array.isArray(maskData?.inventory) ? maskData.inventory : [];
  } catch(_) {}
  if (!inv.length) { UI.showToast('当前面具物品栏是空的', 1800); return; }
  _youyuInvCtx = { maskId, inv };
  const mask = document.getElementById('youyu-list-overlay');
  if (!mask) return;
  const rows = inv.map((it, i) => `
    <div onclick="Phone._youyuPickInvItem(${i})" style="display:flex;align-items:center;gap:10px;padding:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;margin-top:8px;cursor:pointer">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(it.name || '未命名')}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">持有 ×${it.count || 1}${it.effect ? '　' + Utils.escapeHtml(it.effect) : ''}</div>
      </div>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
    </div>
  `).join('');
  mask.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:340px;width:100%;max-height:86vh;display:flex;flex-direction:column;color:var(--text)">
      <div style="font-size:15px;font-weight:600;padding:18px 20px 12px">选择物品</div>
      <div style="flex:1;overflow-y:auto;padding:0 20px 8px">${rows}</div>
      <div style="padding:10px 20px 18px">
        <button onpointerdown="event.preventDefault();Phone._youyuRenderListModal()" style="width:100%;padding:11px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">返回</button>
      </div>
    </div>
  `;
}

// 选中物品栏某件物品后，填入草稿并切回编辑视图
function _youyuPickInvItem(i) {
  if (!_youyuInvCtx) return;
  const it = _youyuInvCtx.inv[i];
  if (!it) return;
  if (!_youyuListDraft) _youyuListDraft = {};
  _youyuListDraft.name = it.name || '';
  _youyuListDraft.effect = it.effect || '';
  _youyuListDraft.maxCount = it.count || 1;
  _youyuListDraft.count = 1;
  _youyuListDraft.fromInventory = true;
  _youyuListDraft.maskId = _youyuInvCtx.maskId;
  _youyuListDraft.invName = it.name || '';
  _youyuRenderListModal();
}
let _youyuInvCtx = null;



// 上架编辑弹窗（名/描述/数量/交付方式/时效/价/货币）。invIdx>=0 表示来自物品栏
function _youyuOpenListModal(invIdx) {
 document.getElementById('youyu-inv-overlay')?.remove();
 const curInfos = _getWalletCurrencyInfos();
 if (!curInfos.length) { UI.showToast('请先在钱包绑定货币', 2000); return; }
 const fromInv = Number.isInteger(invIdx) && invIdx >= 0;
 const invItem = (fromInv && _youyuInvCtx) ? _youyuInvCtx.inv[invIdx] : null;
 _youyuListDraft = {
   name: invItem ? (invItem.name || '') : '',
   effect: invItem ? (invItem.effect || '') : '',
   count: 1,
   maxCount: invItem ? (invItem.count || 1) : 0,
   deliveryMode: 'express', // 'express' | 'errand' | 'direct'
   minutes: '',
   price: '',
   currencyId: curInfos[0].id,
   fromInventory: fromInv,
   maskId: fromInv && _youyuInvCtx ? _youyuInvCtx.maskId : '',
   invName: invItem ? (invItem.name || '') : '',
 };
 _youyuRenderListModal();
}

// 渲染上架弹窗（交付方式切换时复用）
function _youyuRenderListModal() {
 const d = _youyuListDraft;
 if (!d) return;
 const curInfos = _getWalletCurrencyInfos();
 const curOptions = curInfos.map(c => `<option value="${Utils.escapeHtml(c.id)}" ${c.id === d.currencyId ? 'selected' : ''}>${Utils.escapeHtml(c.name)}</option>`).join('');
 const isExpress = d.deliveryMode === 'express';
 const isErrand = d.deliveryMode === 'errand';
 const isDirect = d.deliveryMode === 'direct';
 const btn = (mode, label) => {
   const on = d.deliveryMode === mode;
   return `<button onpointerdown="event.preventDefault();Phone._youyuSetDelivery('${mode}')" style="flex:1;padding:9px;border-radius:8px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};background:${on ? 'var(--accent)' : 'transparent'};color:${on ? '#111' : 'var(--text)'};font-size:13px;font-weight:${on ? '600' : '400'};cursor:pointer">${label}</button>`;
 };
 const etaBlock = isDirect ? '' : `
   <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">${isExpress ? '预期时效（天，需大于 2）' : '预期时效（分钟）'}</label>
   <input id="youyu-l-minutes" type="number" inputmode="numeric" value="${Utils.escapeHtml(String(d.minutes || ''))}" oninput="Phone._youyuDraftSet('minutes', this.value)" placeholder="${isExpress ? '默认 2-5，可自填' : '例如 30'}" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-bottom:14px">`;
 const countBlock = d.fromInventory ? `
   <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">数量（持有 ${d.maxCount}）</label>
   <input id="youyu-l-count" type="number" inputmode="numeric" min="1" max="${d.maxCount}" value="${d.count || 1}" oninput="Phone._youyuDraftSet('count', this.value)" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-bottom:14px">` : '';
  let mask = document.getElementById('youyu-list-overlay');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'youyu-list-overlay';
    mask.style.cssText = 'position:fixed;inset:0;z-index:10015;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
    mask.onpointerdown = (e) => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
  }
  mask.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:340px;width:100%;max-height:86vh;display:flex;flex-direction:column;color:var(--text)">
      <div style="font-size:15px;font-weight:600;padding:18px 20px 12px">上架商品</div>
      <div style="flex:1;overflow-y:auto;padding:0 20px 4px">
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">商品名称</label>
        <div style="display:flex;gap:8px;margin-bottom:14px">
          <input id="youyu-l-name" value="${Utils.escapeHtml(d.name)}" ${d.fromInventory ? 'readonly' : ''} oninput="Phone._youyuDraftSet('name', this.value)" placeholder="商品名称" style="flex:1;min-width:0;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none">
          <button onpointerdown="event.preventDefault();Phone._youyuPickFromInventory()" style="white-space:nowrap;padding:9px 12px;border-radius:8px;border:1px dashed var(--accent);background:transparent;color:var(--accent);font-size:12px;cursor:pointer">从物品栏</button>
        </div>
        ${countBlock}
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">交付方式</label>
        <div style="display:flex;gap:8px;margin-bottom:14px">
          ${btn('express', '快递')}
          ${btn('errand', '跑腿')}
          ${btn('direct', '直接交付')}
        </div>
        ${etaBlock}
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">售价</label>
        <input id="youyu-l-price" type="number" inputmode="numeric" min="0" value="${Utils.escapeHtml(String(d.price || ''))}" oninput="Phone._youyuDraftSet('price', this.value)" placeholder="例如 100" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-bottom:14px">
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">收款货币</label>
        <select id="youyu-l-currency" onchange="Phone._youyuDraftSet('currencyId', this.value)" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-bottom:14px">${curOptions}</select>
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">商品描述</label>
        <textarea id="youyu-l-effect" rows="2" oninput="Phone._youyuDraftSet('effect', this.value)" placeholder="可选" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;resize:none">${Utils.escapeHtml(d.effect)}</textarea>
      </div>
      <div style="display:flex;gap:10px;padding:14px 20px 18px">
        <button onpointerdown="event.preventDefault();document.getElementById('youyu-list-overlay').remove()" style="flex:1;padding:11px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">取消</button>
        <button onpointerdown="event.preventDefault();Phone._youyuConfirmListing()" style="flex:1;padding:11px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">上架</button>
      </div>
    </div>
  `;
}

function _youyuDraftSet(key, val) {
 if (!_youyuListDraft) return;
 if (key === 'count') {
   let n = parseInt(val, 10);
   if (!Number.isFinite(n) || n < 1) n = 1;
   if (_youyuListDraft.maxCount && n > _youyuListDraft.maxCount) n = _youyuListDraft.maxCount;
   _youyuListDraft.count = n;
 } else {
   _youyuListDraft[key] = val;
 }
}

function _youyuSetDelivery(mode) {
 if (!_youyuListDraft) return;
 _youyuListDraft.deliveryMode = mode;
 _youyuRenderListModal();
}

// 确认上架：物品栏来源的从面具扣除，存入 listings
async function _youyuConfirmListing() {
 if (!_youyuListDraft) return;
 const d = _youyuListDraft;
 const name = (document.getElementById('youyu-l-name')?.value || d.name || '').trim();
 if (!name) { UI.showToast('请填写商品名称', 1500); return; }
 const price = parseInt(document.getElementById('youyu-l-price')?.value, 10);
 if (!Number.isFinite(price) || price < 0) { UI.showToast('请填写有效售价', 1500); return; }
 const currencyId = document.getElementById('youyu-l-currency')?.value || d.currencyId || '';
 if (!currencyId) { UI.showToast('请选择收款货币', 1500); return; }
 const effect = (document.getElementById('youyu-l-effect')?.value || '').trim();
 // 数量
 let count = 1;
 if (d.fromInventory) {
   count = parseInt(document.getElementById('youyu-l-count')?.value, 10) || 1;
   if (count < 1) count = 1;
   if (d.maxCount && count > d.maxCount) count = d.maxCount;
 }
 // 时效校验
 const isDirect = d.deliveryMode === 'direct';
 const isExpress = d.deliveryMode === 'express';
 let minutes = 0;
 if (!isDirect) {
   const rawNum = parseInt(document.getElementById('youyu-l-minutes')?.value, 10);
   if (isExpress) {
     if (document.getElementById('youyu-l-minutes')?.value === '' || rawNum == null || isNaN(rawNum)) {
       minutes = (Math.floor(Math.random() * 4) + 2) * 1440;
     } else {
       if (rawNum <= 2) { UI.showToast('快递时效需填大于 2 的天数', 1800); return; }
       minutes = rawNum * 1440;
     }
   } else {
     if (!Number.isFinite(rawNum) || rawNum < 1) { UI.showToast('请填写跑腿时效（分钟）', 1800); return; }
     minutes = rawNum;
   }
 }
 // 物品栏来源：从面具扣 count
 if (d.fromInventory && d.maskId) {
   try {
     const maskData = await DB.get('characters', d.maskId);
     if (maskData) {
       const inv = Array.isArray(maskData.inventory) ? maskData.inventory : [];
       const idx = inv.findIndex(x => (x?.name || '').trim() === String(d.invName || name).trim());
       if (idx >= 0) {
         const have = inv[idx].count || 1;
         const left = have - count;
         if (left > 0) inv[idx].count = left;
         else inv.splice(idx, 1);
         maskData.inventory = inv;
         await DB.put('characters', maskData);
       }
     }
   } catch(_) {}
 }
 const pd = await _getPhoneData();
 pd.shopListings = pd.shopListings || [];
 pd.shopListings.push({
   id: 'listing_' + Utils.uuid().slice(0, 8),
   name,
   effect,
   count,
   price,
   currencyId,
   deliveryMode: d.deliveryMode,
   minutes,
   fromInventory: !!d.fromInventory,
   maskId: d.maskId || '',
   invName: d.invName || name,
   time: new Date().toLocaleString(),
 });
 await _savePhoneData();
 document.getElementById('youyu-list-overlay')?.remove();
 _youyuListDraft = null;
 if (_currentApp === 'youyu') _renderYouyu(pd);
 UI.showToast('已上架', 1200);
}

// 下架：物品栏来源的放回物品栏，自定义的直接删除
async function _youyuRemoveListing(listingId) {
  const pd = await _getPhoneData();
  const l = (pd?.shopListings || []).find(x => x.id === listingId);
  if (!l) return;
  if (l.fromInventory && l.maskId) {
    try {
      const maskData = await DB.get('characters', l.maskId);
      if (maskData) {
        const inv = Array.isArray(maskData.inventory) ? maskData.inventory : [];
        const idx = inv.findIndex(x => (x?.name || '').trim() === String(l.invName || l.name).trim());
        if (idx >= 0) inv[idx].count = (inv[idx].count || 1) + (l.count || 1);
        else inv.push({ name: l.invName || l.name, effect: l.effect || '', count: l.count || 1 });
        maskData.inventory = inv;
        await DB.put('characters', maskData);
      }
    } catch(_) {}
  }
  pd.shopListings = (pd.shopListings || []).filter(x => x.id !== listingId);
  await _savePhoneData();
  if (_currentApp === 'youyu') _renderYouyu(pd);
  UI.showToast(l.fromInventory ? '已下架并放回物品栏' : '已下架', 1200);
}

// 分享商品（target: 'main'=主线, 'chat'=聊天）
async function _youyuShareListing(listingId, target) {
  target = target || 'main';
  const pd = await _getPhoneData();
  const l = (pd?.shopListings || []).find(x => x.id === listingId);
  if (!l) return;
  // 已分享到其他渠道，禁止重复分享
  if (l.sharedTo) {
    const dest = l.sharedTo === 'main' ? '主线' : '聊天';
    UI.showToast(`该商品已分享到${dest}，不能同时分享到多处`, 2000);
    return;
  }
  const curInfos = _getWalletCurrencyInfos();
  const curName = (curInfos.find(c => c.id === l.currencyId)?.name) || '货币';
  const content = `【{{user}}的小店在售商品】\n商品名：${l.name}\n售价：${l.price} ${curName}\n${l.effect ? '描述：' + l.effect + '\n' : ''}商品ID：${l.id}\n\n如果剧情中有角色想购买这件商品，请在回复末尾输出购买标记（不要复述本说明）：\n\`\`\`youyu_buy\n{"id":"${l.id}","buyer":"购买角色的名字","delivery":"direct或express或errand","eta":数字}\n\`\`\`\ndelivery：direct=当面/直接交付，express=快递，errand=跑腿；eta：express填天数、errand填分钟、direct可省略。\n角色不一定要买，根据剧情自然判断即可。如果角色决定购买，只需输出标记，金额将由前端自动计算入账，无需在回复中描写数值变动或交易细节。`;
  if (target === 'main') {
    await _shareToMain('shop', `小店商品：${l.name}`, content);
  } else {
    // 聊天分享：选择联系人，发送商品卡片
    const contacts = pd.chatContacts || [];
    if (!contacts.length) { UI.showToast('还没有聊天联系人', 1800); return; }
    // 弹出联系人选择
    const overlay = document.createElement('div');
    overlay.id = 'youyu-chat-pick-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    const rows = contacts.map(c => {
      const avatar = _chatAvatarMap[c.name] || c.avatar || '';
      const initial = Utils.escapeHtml((c.name || '?')[0]);
      const avatarHtml = avatar
        ? `<img src="${Utils.escapeHtml(avatar)}" style="width:32px;height:32px;border-radius:50%;object-fit:cover">`
        : `<div style="width:32px;height:32px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600">${initial}</div>`;
      return `<div onclick="Phone._youyuSendToChat('${l.id}','${Utils.escapeHtml(c.id)}')" style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;border-radius:10px;border:1px solid var(--border);margin-bottom:6px;background:var(--bg-secondary)">
        ${avatarHtml}
        <div style="font-size:14px;color:var(--text);font-weight:500">${Utils.escapeHtml(c.name || '?')}</div>
      </div>`;
    }).join('');
    overlay.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:320px;width:100%;max-height:70vh;display:flex;flex-direction:column;color:var(--text)">
        <div style="font-size:15px;font-weight:600;padding:16px 18px 10px">发送给谁？</div>
        <div style="flex:1;overflow-y:auto;padding:0 12px 12px">${rows}</div>
        <div style="padding:10px 18px 16px"><button onpointerdown="event.preventDefault();document.getElementById('youyu-chat-pick-overlay').remove()" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">取消</button></div>
      </div>
    `;
    document.body.appendChild(overlay);
    return; // 异步等用户选择，不在这里标记 sharedTo
  }
  // 标记已分享
  l.sharedTo = target;
  await _savePhoneData();
  if (_currentApp === 'youyu') _renderYouyu(pd);
}

// 聊天分享：选中联系人后发送商品卡片
async function _youyuSendToChat(listingId, contactId) {
  document.getElementById('youyu-chat-pick-overlay')?.remove();
  const pd = await _getPhoneData();
  const l = (pd?.shopListings || []).find(x => x.id === listingId);
  if (!l) { UI.showToast('商品不存在', 1500); return; }
  const curInfos = _getWalletCurrencyInfos();
  const curName = (curInfos.find(c => c.id === l.currencyId)?.name) || '货币';
  let gameTime = '';
  try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}

  // 往聊天 thread 推商品卡片消息
  pd.chatThreads = pd.chatThreads || {};
  pd.chatThreads[contactId] = pd.chatThreads[contactId] || [];
  pd.chatThreads[contactId].push({
    id: 'yl_' + Utils.uuid().slice(0, 8),
    role: 'me',
    type: 'shop_listing',
    listingId: l.id,
    listingName: l.name,
    listingPrice: l.price,
    listingCurName: curName,
    listingEffect: l.effect || '',
    listingDelivery: l.deliveryMode || 'direct',
    text: `[商品] ${l.name} ${l.price} ${curName}`,
    time: gameTime,
    createdAt: Date.now()
  });

  // 注入提示词到聊天上下文（下次该联系人聊天构建时读取）
  pd.youyuChatPrompts = pd.youyuChatPrompts || {};
  const chatContent = `【{{user}}发来商品链接】\n商品名：${l.name}\n售价：${l.price} ${curName}\n${l.effect ? '描述：' + l.effect + '\n' : ''}商品ID：${l.id}\n\n如果你想购买这件商品，请在回复末尾输出购买标记（不要复述本说明）：\n\`\`\`youyu_buy\n{"id":"${l.id}","buyer":"你的角色名","delivery":"direct或express或errand","eta":数字}\n\`\`\`\ndelivery：direct=当面/直接交付，express=快递，errand=跑腿；eta：express填天数、errand填分钟、direct可省略。\n不一定要买，根据你的角色性格和剧情自然判断即可。`;
  pd.youyuChatPrompts[contactId] = chatContent;

  // 标记已分享
  l.sharedTo = 'chat';
  await _savePhoneData();
  if (_currentApp === 'youyu') _renderYouyu(pd);
  UI.showToast('已发送到聊天', 1500);
}

// AI 购买标记处理：校验商品→加钱→扣库存→生成订单→注入第二轮提示词
async function _youyuHandleBuy(data) {
  if (!data || !data.id) return;
  const pd = await _getPhoneData();
  if (!pd) return;
  const listings = pd.shopListings || [];
  const l = listings.find(x => x.id === data.id);
  if (!l) { console.warn('[游鱼] 商品不存在或已下架:', data.id); return; }

  const buyer = data.buyer || '未知';
  const delivery = data.delivery || l.deliveryMode || 'direct';
  const eta = parseInt(data.eta, 10) || 0;
  const price = l.price || 0;
  const currencyId = l.currencyId || '';
  const curInfos = _getWalletCurrencyInfos();
  const curName = (curInfos.find(c => c.id === currencyId)?.name) || '货币';

  // 1. 加钱到绑定货币
  try {
    const sb = Conversations.getStatusBar() || {};
    if (!sb.customAttrs) sb.customAttrs = {};
    if (!sb.customAttrs.global) sb.customAttrs.global = {};
    const cur = parseFloat(sb.customAttrs.global[currencyId] || 0);
    sb.customAttrs.global[currencyId] = cur + price;
    await Conversations.setStatusBar(sb);
    if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(sb);
  } catch(e) { console.warn('[游鱼] 加钱失败', e); }

  // 2. 记账
  await _addLedgerEntry({
    currencyId,
    amount: price,
    category: '收入',
    note: `售出「${l.name}」给${buyer}`,
    platform: '游鱼小店',
    counterparty: buyer,
    source: 'youyu',
  });

  // 3. 扣库存 & 清除分享标记
  l.count = (l.count || 1) - 1;
  delete l.sharedTo;
  if (l.count <= 0) {
    // 库存归零，自动下架
    pd.shopListings = listings.filter(x => x.id !== l.id);
  }

  // 4. 生成订单
  const orderTime = _getGameTime() || new Date().toLocaleString();
  const order = {
    id: 'order_' + Utils.uuid().slice(0, 8),
    name: l.name,
    items: [{ name: l.name, count: 1, effect: l.effect || '' }],
    buyer,
    youyuSell: true,
    youyuIncome: price,
    youyuCurName: curName,
    status: delivery === 'direct' ? 'delivered' : 'delivering',
    time: orderTime,
    orderGameTime: orderTime,
  };

  if (delivery === 'direct') {
    // 直接交付：订单立即完成
    order.deliveryMinutes = 0;
    pd.shopOrders = pd.shopOrders || [];
    pd.shopOrders.push(order);
  } else if (delivery === 'errand') {
    // 跑腿：按分钟
    order.deliveryMinutes = eta || 30;
    pd.takeoutOrders = pd.takeoutOrders || [];
    pd.takeoutOrders.push(order);
  } else {
    // 快递：l.minutes 已经是分钟制（上架时已转换），eta 若有效则按天转分钟
    let delMin;
    if (eta > 2) {
      delMin = eta * 1440;
    } else {
      delMin = l.minutes || 3 * 1440;
    }
    order.deliveryMinutes = delMin;
    pd.shopOrders = pd.shopOrders || [];
    pd.shopOrders.push(order);
  }

  await _savePhoneData();

  // 5. 注入第二轮提示词：告知 AI 交易已完成
  const deliveryDesc = delivery === 'direct' ? '当面交付，已完成'
    : delivery === 'errand' ? `跑腿配送中，预计 ${order.deliveryMinutes} 分钟送达`
    : `快递配送中，预计 ${Math.round(order.deliveryMinutes / 1440)} 天送达`;
  const confirmContent = `【游鱼小店·交易完成】${buyer}已购买「${l.name}」，支付 ${price} ${curName}。交付方式：${deliveryDesc}。\n此交易已由前端自动结算入账，无需在后续回复中重复描写金额变动。如果是配送订单，物品送达时系统会另行通知。`;
  // 5. 存入确认提示词（下次发消息时一次性注入）
  pd.youyuConfirmPrompts = pd.youyuConfirmPrompts || [];
  pd.youyuConfirmPrompts.push(confirmContent);
  await _savePhoneData();

  // 6. Toast 通知
  UI.showToast(`${buyer} 购买了「${l.name}」，+${price} ${curName}`, 3000);

  // 7. 刷新游鱼页面
  if (_currentApp === 'youyu') _renderYouyu(pd);
}

// 删除游鱼卖出订单
async function _youyuDeleteOrder(orderId) {
 const pd = await _getPhoneData();
 if (!pd) return;
 pd.shopOrders = (pd.shopOrders || []).filter(o => o.id !== orderId);
 pd.takeoutOrders = (pd.takeoutOrders || []).filter(o => o.id !== orderId);
 await _savePhoneData();
 if (_currentApp === 'youyu') _renderYouyu(pd);
 UI.showToast('已删除', 1000);
}

// 寄件草稿（构建中的寄件单）
let _feiniaoDraft = null;

// 点击「添加寄件订单」：弹出选择菜单（从物品栏选择 / 自定义物品）
function _feiniaoAddOrder() {
 const overlay = document.createElement('div');
 overlay.id = 'feiniao-sheet-overlay';
 overlay.style.cssText = 'position:fixed;inset:0;z-index:10010;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center';
 overlay.onclick = (e) => { if (e.target === overlay) _feiniaoCloseSheet(); };
 overlay.innerHTML = `
   <div style="width:100%;max-width:420px;background:var(--bg);border-radius:16px 16px 0 0;padding:8px 12px 16px;animation:sheetSlideUp 0.2s ease">
     <div style="text-align:center;font-size:13px;color:var(--text-secondary);padding:10px 0 6px">选择寄件方式</div>
     <button onclick="Phone._feiniaoPickFromInventory()" style="width:100%;display:flex;align-items:center;gap:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-top:8px;font-size:14px;color:var(--text);cursor:pointer;text-align:left">
       <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path><path d="m3.3 7 8.7 5 8.7-5"></path><path d="M12 22V12"></path></svg>
       <div><div style="font-weight:600">从物品栏中选择</div><div style="font-size:12px;color:var(--text-secondary);margin-top:2px">寄出后将从物品栏扣除</div></div>
     </button>
     <button onclick="Phone._feiniaoCustomItem()" style="width:100%;display:flex;align-items:center;gap:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-top:8px;font-size:14px;color:var(--text);cursor:pointer;text-align:left">
       <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
       <div><div style="font-weight:600">自定义物品</div><div style="font-size:12px;color:var(--text-secondary);margin-top:2px">手动填写寄件名称</div></div>
     </button>
     <button onclick="Phone._feiniaoCloseSheet()" style="width:100%;background:transparent;border:none;border-radius:12px;padding:14px;margin-top:8px;font-size:14px;color:var(--text-secondary);cursor:pointer">取消</button>
   </div>
 `;
 document.body.appendChild(overlay);
}

function _feiniaoCloseSheet() {
 document.getElementById('feiniao-sheet-overlay')?.remove();
}

// 读取当前面具物品栏
async function _feiniaoGetInventory() {
 try {
   const maskId = Character.getCurrentId();
   if (!maskId) return { maskId: '', inv: [] };
   const maskData = await DB.get('characters', maskId);
   const inv = Array.isArray(maskData?.inventory) ? maskData.inventory : [];
   return { maskId, inv };
 } catch(_) { return { maskId: '', inv: [] }; }
}

// 「从物品栏中选择」：弹出物品多选列表
async function _feiniaoPickFromInventory() {
 _feiniaoCloseSheet();
 const { maskId, inv } = await _feiniaoGetInventory();
 if (!inv.length) { UI.showToast('当前面具物品栏是空的', 1800); return; }
 _feiniaoEnsureDraft();
 // 预填：草稿里已选的物品栏物品数量（按名字匹配），实现"再次打开可调整"而非堆叠
 const preset = {};
 inv.forEach((it, i) => {
   const exist = _feiniaoDraft.items.find(x => x.fromInventory && x.invName === (it.name || '未命名'));
   if (exist) preset[i] = exist.count || 0;
 });
 // 选择状态：{ idx: 选中数量 }
 const sel = { ...preset };
 const overlay = document.createElement('div');
 overlay.id = 'feiniao-inv-overlay';
 overlay.style.cssText = 'position:fixed;inset:0;z-index:10010;background:rgba(0,0,0,0.45);display:flex;align-items:flex-end;justify-content:center';
 overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
 const rows = inv.map((it, i) => {
   const max = it.count || 1;
   return `
     <div style="display:flex;align-items:center;gap:10px;padding:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;margin-top:8px">
       <div style="flex:1;min-width:0">
         <div style="font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(it.name || '未命名')}</div>
         <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">持有 ×${max}${it.effect ? '　' + Utils.escapeHtml(it.effect) : ''}</div>
       </div>
       <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
         <button onclick="Phone._feiniaoInvStep(${i}, -1, ${max})" style="width:26px;height:26px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:16px;cursor:pointer;line-height:1">−</button>
         <span id="feiniao-inv-cnt-${i}" style="min-width:20px;text-align:center;font-size:14px;color:var(--text)">${preset[i] || 0}</span>
         <button onclick="Phone._feiniaoInvStep(${i}, 1, ${max})" style="width:26px;height:26px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:16px;cursor:pointer;line-height:1">+</button>
       </div>
     </div>`;
 }).join('');
 overlay.innerHTML = `
   <div style="width:100%;max-width:420px;max-height:80vh;display:flex;flex-direction:column;background:var(--bg);border-radius:16px 16px 0 0;padding:8px 12px 16px;animation:sheetSlideUp 0.2s ease">
     <div style="text-align:center;font-size:14px;font-weight:600;color:var(--text);padding:10px 0 4px">选择寄件物品</div>
     <div style="text-align:center;font-size:12px;color:var(--text-secondary);padding-bottom:6px">可多选，可设数量</div>
     <div style="flex:1;overflow-y:auto;padding:0 2px 8px">${rows}</div>
     <div style="display:flex;gap:10px;margin-top:6px">
       <button onclick="document.getElementById('feiniao-inv-overlay').remove()" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">取消</button>
       <button onclick="Phone._feiniaoInvConfirm()" style="flex:1;padding:12px;border-radius:10px;border:none;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">确定</button>
     </div>
   </div>
 `;
 document.body.appendChild(overlay);
 _feiniaoInvCtx = { maskId, inv, sel };
}

let _feiniaoInvCtx = null;

// 物品多选数量加减
function _feiniaoInvStep(idx, delta, max) {
 if (!_feiniaoInvCtx) return;
 const cur = _feiniaoInvCtx.sel[idx] || 0;
 let next = cur + delta;
 if (next < 0) next = 0;
 if (next > max) next = max;
 _feiniaoInvCtx.sel[idx] = next;
 const el = document.getElementById('feiniao-inv-cnt-' + idx);
 if (el) el.textContent = String(next);
}

// 确认物品选择 → 合并进草稿 → 打开寄件弹窗
function _feiniaoInvConfirm() {
 if (!_feiniaoInvCtx) return;
 const { maskId, inv, sel } = _feiniaoInvCtx;
 const picked = [];
 Object.keys(sel).forEach(k => {
   const n = sel[k];
   if (n > 0) {
     const it = inv[Number(k)];
     picked.push({ name: it.name || '未命名', count: n, fromInventory: true, maskId, invName: it.name || '未命名', maxCount: it.count || 1 });
   }
 });
 _feiniaoEnsureDraft();
 // 物品栏物品按名字覆盖：先清掉草稿里所有来自物品栏的项，再写入本次选择（避免重复堆叠）
 _feiniaoDraft.items = _feiniaoDraft.items.filter(x => !x.fromInventory);
 _feiniaoDraft.items.push(...picked);
 document.getElementById('feiniao-inv-overlay')?.remove();
 _feiniaoInvCtx = null;
 _feiniaoOpenShipModal();
}

// 「自定义物品」→ 弹出编辑弹窗（名称 / 数量 / 描述）→ 确认后加进草稿
// editIdx 为数字时进入编辑模式（修改已有自定义物品），否则为新增
function _feiniaoCustomItem(editIdx) {
 _feiniaoCloseSheet();
 _feiniaoEnsureDraft();
 const isEdit = Number.isInteger(editIdx);
 const cur = isEdit ? (_feiniaoDraft.items[editIdx] || {}) : {};
 const mask = document.createElement('div');
 mask.id = 'feiniao-custom-overlay';
 mask.dataset.editIdx = isEdit ? String(editIdx) : '';
 mask.style.cssText = 'position:fixed;inset:0;z-index:10015;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
 mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
 mask.innerHTML = `
   <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:340px;width:100%;color:var(--text)">
     <div style="font-size:15px;font-weight:600;padding:18px 20px 12px">${isEdit ? '编辑物品' : '自定义物品'}</div>
     <div style="padding:0 20px 4px">
       <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">物品名称</label>
       <input id="feiniao-ci-name" value="${Utils.escapeHtml(cur.name || '')}" placeholder="物品名称" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-bottom:14px">
       <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">数量</label>
       <input id="feiniao-ci-count" type="number" inputmode="numeric" value="${cur.count || 1}" min="1" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-bottom:14px">
       <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">物品描述</label>
       <textarea id="feiniao-ci-effect" rows="3" placeholder="物品效果描述（可选）" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;resize:none">${Utils.escapeHtml(cur.effect || '')}</textarea>
     </div>
     <div style="display:flex;gap:10px;padding:14px 20px 18px">
       <button onpointerdown="event.preventDefault();document.getElementById('feiniao-custom-overlay').remove()" style="flex:1;padding:11px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">取消</button>
       <button onpointerdown="event.preventDefault();Phone._feiniaoCustomConfirm()" style="flex:1;padding:11px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">确定</button>
     </div>
   </div>
 `;
 document.body.appendChild(mask);
}

// 编辑已有的自定义物品
function _feiniaoEditCustomItem(i) {
 _feiniaoCustomItem(i);
}

// 确认自定义物品 → 加进/更新草稿 → 回到寄件弹窗
function _feiniaoCustomConfirm() {
 const overlay = document.getElementById('feiniao-custom-overlay');
 const nameEl = document.getElementById('feiniao-ci-name');
 const cntEl = document.getElementById('feiniao-ci-count');
 const effEl = document.getElementById('feiniao-ci-effect');
 const name = (nameEl?.value || '').trim();
 if (!name) { UI.showToast('请填写物品名称', 1500); return; }
 let n = parseInt(cntEl?.value, 10);
 if (!Number.isFinite(n) || n < 1) n = 1;
 const effect = (effEl?.value || '').trim();
 _feiniaoEnsureDraft();
 const editIdxRaw = overlay?.dataset?.editIdx;
 const editIdx = editIdxRaw !== '' && editIdxRaw != null ? parseInt(editIdxRaw, 10) : NaN;
 if (Number.isInteger(editIdx) && _feiniaoDraft.items[editIdx]) {
   _feiniaoDraft.items[editIdx] = { name, count: n, fromInventory: false, effect };
 } else {
   _feiniaoDraft.items.push({ name, count: n, fromInventory: false, effect });
 }
 overlay?.remove();
 _feiniaoOpenShipModal();
}

// 确保草稿存在
function _feiniaoEnsureDraft() {
 if (!_feiniaoDraft) {
   _feiniaoDraft = { orderName: '', mode: 'express', minutes: '', items: [], hideSender: false, recipients: [] };
 }
}

// 寄件弹窗（构建中）
function _feiniaoOpenShipModal() {
 _feiniaoEnsureDraft();
 // 已存在则只刷新内容
 let mask = document.getElementById('feiniao-ship-overlay');
 if (!mask) {
   mask = document.createElement('div');
   mask.id = 'feiniao-ship-overlay';
   mask.style.cssText = 'position:fixed;inset:0;z-index:10005;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
   mask.onclick = (e) => { if (e.target === mask) _feiniaoCancelShip(); };
   document.body.appendChild(mask);
 }
 const d = _feiniaoDraft;
 const isExpress = d.mode === 'express';
 const recipRows = (d.recipients || []).map((r, i) => {
   const initial = Utils.escapeHtml((r.name || '?')[0]);
   const avatar = r.avatar ? `<img src="${Utils.escapeHtml(r.avatar)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">` : initial;
   return `
     <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;margin-top:6px">
       <div style="width:28px;height:28px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;overflow:hidden">${avatar}</div>
       <span style="flex:1;min-width:0;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(r.name || '')}</span>
       <button onclick="Phone._feiniaoRecipRemove(${i})" style="width:24px;height:24px;flex-shrink:0;border-radius:6px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:16px;line-height:1">×</button>
     </div>`;
 }).join('');
 const itemRows = d.items.map((it, i) => `
   <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;margin-top:6px">
     <span style="flex:1;min-width:0;color:var(--text);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(it.name || '未命名')}</span>
     <span style="flex-shrink:0;font-size:13px;color:var(--text-secondary)">×${it.count || 1}</span>
     ${it.fromInventory ? '<span style="font-size:10px;color:var(--text-secondary);flex-shrink:0;padding:2px 5px;border:1px solid var(--border);border-radius:4px">物品栏</span>' : `<button onclick="Phone._feiniaoEditCustomItem(${i})" style="width:24px;height:24px;flex-shrink:0;border-radius:6px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>`}
     <button onclick="Phone._feiniaoItemRemove(${i})" style="width:24px;height:24px;flex-shrink:0;border-radius:6px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:16px;line-height:1">×</button>
   </div>
 `).join('');
 mask.innerHTML = `
   <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:380px;width:100%;max-height:86vh;display:flex;flex-direction:column;color:var(--text)">
     <div style="font-size:15px;font-weight:600;padding:18px 20px 12px">寄件</div>
     <div style="flex:1;overflow-y:auto;padding:0 20px 4px">
       <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">订单名称</label>
       <input id="feiniao-ord-name" value="${Utils.escapeHtml(d.orderName || '')}" oninput="Phone._feiniaoDraftSet('orderName', this.value)" placeholder="例如 给某人的礼物" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-bottom:14px">

       <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">方式</label>
       <div style="display:flex;gap:8px;margin-bottom:14px">
         <button onclick="Phone._feiniaoSetMode('express')" style="flex:1;padding:9px;border-radius:8px;border:1px solid ${isExpress ? 'var(--accent)' : 'var(--border)'};background:${isExpress ? 'var(--accent)' : 'transparent'};color:${isExpress ? '#111' : 'var(--text)'};font-size:13px;font-weight:${isExpress ? '600' : '400'};cursor:pointer">快递</button>
         <button onclick="Phone._feiniaoSetMode('errand')" style="flex:1;padding:9px;border-radius:8px;border:1px solid ${!isExpress ? 'var(--accent)' : 'var(--border)'};background:${!isExpress ? 'var(--accent)' : 'transparent'};color:${!isExpress ? '#111' : 'var(--text)'};font-size:13px;font-weight:${!isExpress ? '600' : '400'};cursor:pointer">跑腿</button>
       </div>

       <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">${isExpress ? '预期时效（天，需大于 2）' : '预期时效（分钟）'}</label>
       <input id="feiniao-ord-minutes" type="number" inputmode="numeric" value="${Utils.escapeHtml(String(d.minutes || ''))}" oninput="Phone._feiniaoDraftSet('minutes', this.value)" placeholder="${isExpress ? '默认 2-5，可自填' : '例如 30'}" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-bottom:14px">

       <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
         <label style="font-size:12px;color:var(--text-secondary)">物品列表</label>
         <button onclick="Phone._feiniaoAddItem()" style="font-size:12px;color:var(--accent);background:transparent;border:none;cursor:pointer">+ 添加</button>
       </div>
       <div>${itemRows || '<div style="font-size:12px;color:var(--text-secondary);text-align:center;padding:10px 0">还没有物品</div>'}</div>

       <label class="circle-check-label" style="margin-top:16px">
         <span class="circle-check-text">隐藏寄件人名称</span>
         <input type="checkbox" class="circle-check" ${d.hideSender ? 'checked' : ''} onchange="Phone._feiniaoDraftSet('hideSender', this.checked)">
         <span class="circle-check-ui"></span>
       </label>

       <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px;margin-bottom:4px">
         <label style="font-size:12px;color:var(--text-secondary)">收件人</label>
         <button onclick="Phone._feiniaoAddRecipient()" style="font-size:12px;color:var(--accent);background:transparent;border:none;cursor:pointer">+ 添加收件人</button>
       </div>
       <div>${recipRows || '<div style="font-size:12px;color:var(--text-secondary);text-align:center;padding:10px 0">还没有收件人</div>'}</div>
     </div>
     <div style="display:flex;gap:10px;padding:12px 20px 18px">
       <button onclick="Phone._feiniaoCancelShip()" style="flex:1;padding:11px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">取消</button>
       <button onclick="Phone._feiniaoSubmitShip()" style="flex:1;padding:11px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">寄出</button>
     </div>
   </div>
 `;
}

function _feiniaoDraftSet(key, val) {
 _feiniaoEnsureDraft();
 _feiniaoDraft[key] = val;
}

function _feiniaoSetMode(mode) {
 _feiniaoEnsureDraft();
 _feiniaoDraft.mode = mode;
 _feiniaoOpenShipModal(); // 重渲染（时效标签随之变化）
}

function _feiniaoItemName(i, val) {
 if (_feiniaoDraft?.items?.[i]) _feiniaoDraft.items[i].name = val;
}

function _feiniaoItemCount(i, val) {
 if (_feiniaoDraft?.items?.[i]) {
   const it = _feiniaoDraft.items[i];
   let n = parseInt(val, 10);
   if (!Number.isFinite(n) || n < 1) n = 1;
   if (it.fromInventory && it.maxCount && n > it.maxCount) n = it.maxCount;
   it.count = n;
 }
}

function _feiniaoItemRemove(i) {
 if (!_feiniaoDraft?.items) return;
 _feiniaoDraft.items.splice(i, 1);
 _feiniaoOpenShipModal();
}

// 物品列表里的「+ 添加」：再次弹出选择菜单（物品栏 / 自定义）
function _feiniaoAddItem() {
 _feiniaoAddOrder();
}

function _feiniaoCancelShip() {
 document.getElementById('feiniao-ship-overlay')?.remove();
 _feiniaoDraft = null;
}

// 「添加收件人」：弹出候选角色多选（复用聊天联系人候选池）
let _feiniaoRecipCtx = null;
async function _feiniaoAddRecipient() {
 const candidates = await _collectChatCandidates();
 if (!candidates.length) { UI.showToast('当前世界观没有可选角色', 1800); return; }
 candidates.forEach(cc => { if (cc.name) _chatAvatarMap[cc.name] = cc.avatar || _chatAvatarMap[cc.name] || ''; });
 _feiniaoEnsureDraft();
 const chosenNames = new Set((_feiniaoDraft.recipients || []).map(r => r.name));
 const sel = new Set();
 const overlay = document.createElement('div');
 overlay.id = 'feiniao-recip-overlay';
 overlay.style.cssText = 'position:fixed;inset:0;z-index:10015;background:rgba(0,0,0,0.45);display:flex;align-items:flex-end;justify-content:center';
 overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
 const rows = candidates.map((c, i) => {
   const initial = Utils.escapeHtml((c.name || '?')[0]);
   const avatar = c.avatar ? `<img src="${Utils.escapeHtml(c.avatar)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">` : initial;
   const already = chosenNames.has(c.name);
   return `
     <div onclick="${already ? '' : `Phone._feiniaoRecipToggle(${i}, this)`}" data-idx="${i}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;margin-top:8px;cursor:${already ? 'default' : 'pointer'};opacity:${already ? '0.45' : '1'}">
       <div style="width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;overflow:hidden">${avatar}</div>
       <div style="flex:1;min-width:0">
         <div style="font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.name || '')}</div>
         <div style="font-size:11px;color:var(--text-secondary)">${already ? '已添加' : _chatSourceLabel(c.source)}</div>
       </div>
       <div class="feiniao-recip-check" style="width:20px;height:20px;flex-shrink:0;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center"></div>
     </div>`;
 }).join('');
 overlay.innerHTML = `
   <div style="width:100%;max-width:420px;max-height:80vh;display:flex;flex-direction:column;background:var(--bg);border-radius:16px 16px 0 0;padding:8px 12px 16px;animation:sheetSlideUp 0.2s ease">
     <div style="text-align:center;font-size:14px;font-weight:600;color:var(--text);padding:10px 0 4px">选择收件人</div>
     <div style="text-align:center;font-size:12px;color:var(--text-secondary);padding-bottom:6px">可多选</div>
     <div style="flex:1;overflow-y:auto;padding:0 2px 8px">${rows}</div>
     <div style="display:flex;gap:10px;margin-top:6px">
       <button onclick="document.getElementById('feiniao-recip-overlay').remove()" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">取消</button>
       <button onclick="Phone._feiniaoRecipConfirm()" style="flex:1;padding:12px;border-radius:10px;border:none;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">确定</button>
     </div>
   </div>
 `;
 document.body.appendChild(overlay);
 _feiniaoRecipCtx = { candidates, sel };
}

function _feiniaoRecipToggle(idx, el) {
 if (!_feiniaoRecipCtx) return;
 const sel = _feiniaoRecipCtx.sel;
 const check = el.querySelector('.feiniao-recip-check');
 if (sel.has(idx)) {
   sel.delete(idx);
   if (check) { check.style.background = 'transparent'; check.style.borderColor = 'var(--border)'; check.innerHTML = ''; }
 } else {
   sel.add(idx);
   if (check) { check.style.background = 'var(--accent)'; check.style.borderColor = 'var(--accent)'; check.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'; }
 }
}

function _feiniaoRecipConfirm() {
 if (!_feiniaoRecipCtx) return;
 const { candidates, sel } = _feiniaoRecipCtx;
 _feiniaoEnsureDraft();
 sel.forEach(i => {
   const c = candidates[i];
   if (c && !_feiniaoDraft.recipients.some(r => r.name === c.name)) {
     _feiniaoDraft.recipients.push({ name: c.name, source: c.source, avatar: c.avatar || '' });
   }
 });
 document.getElementById('feiniao-recip-overlay')?.remove();
 _feiniaoRecipCtx = null;
 _feiniaoOpenShipModal();
}

function _feiniaoRecipRemove(i) {
 if (!_feiniaoDraft?.recipients) return;
 _feiniaoDraft.recipients.splice(i, 1);
 _feiniaoOpenShipModal();
}

async function _feiniaoSubmitShip() {
 _feiniaoEnsureDraft();
 const d = _feiniaoDraft;
 // 基础校验
 const orderName = (d.orderName || '').trim();
 if (!orderName) { UI.showToast('请填写订单名称', 1500); return; }
 if (!d.items.length) { UI.showToast('请至少添加一件物品', 1500); return; }
 if (!d.recipients || !d.recipients.length) { UI.showToast('请至少添加一位收件人', 1500); return; }
 const isExpress = d.mode === 'express';
 // 时效校验 + 换算成分钟
 let minutes;
 const rawNum = parseInt(d.minutes, 10);
 if (isExpress) {
   // 快递：填天数，需大于 2；留空则随机 2-5 天
   if (d.minutes === '' || d.minutes == null) {
     const randDay = Math.floor(Math.random() * 4) + 2; // 2-5
     minutes = randDay * 1440;
   } else {
     if (!Number.isFinite(rawNum) || rawNum <= 2) { UI.showToast('快递时效需填大于 2 的天数', 1800); return; }
     minutes = rawNum * 1440;
   }
 } else {
   // 跑腿：填分钟
   if (!Number.isFinite(rawNum) || rawNum < 1) { UI.showToast('请填写跑腿时效（分钟）', 1800); return; }
   minutes = rawNum;
 }
 // 时间从状态栏抓
 const gameTime = _getGameTime();
 if (!gameTime) { UI.showToast('当前无游戏时间，无法生成配送信息', 2000); return; }

 // 含物品栏物品时二次确认
 const invItems = d.items.filter(it => it.fromInventory);
 if (invItems.length) {
   const ok = await UI.showConfirm('确认寄出', '物品栏中的物品寄出后会在面具中删除，是否继续？');
   if (!ok) return;
 }

 // 1) 扣减面具物品栏（按 maskId 分组，按数量扣减）
 try {
   const byMask = {};
   invItems.forEach(it => {
     const mid = it.maskId || Character.getCurrentId();
     if (!mid) return;
     (byMask[mid] = byMask[mid] || []).push(it);
   });
   for (const mid of Object.keys(byMask)) {
     const maskData = await DB.get('characters', mid);
     if (!maskData) continue;
     const inv = Array.isArray(maskData.inventory) ? maskData.inventory : [];
     byMask[mid].forEach(it => {
       const idx = inv.findIndex(x => (x?.name || '').trim() === String(it.invName || it.name).trim());
       if (idx < 0) return;
       const have = inv[idx].count || 1;
       const left = have - (it.count || 1);
       if (left > 0) inv[idx].count = left;
       else inv.splice(idx, 1);
     });
     maskData.inventory = inv;
     await DB.put('characters', maskData);
   }
 } catch(e) { console.warn('[飞鸟] 扣减物品栏失败', e); }

 // 2) 生成订单（与网购同一套字段，按时效分类存入对应订单数组）
 const pd = await _getPhoneData();
 const recipNames = d.recipients.map(r => r.name).join('、');
 const itemSummary = d.items.map(it => `${it.name}${(it.count || 1) > 1 ? '×' + it.count : ''}`).join('、');
 const ordersField = minutes < 1440 ? 'takeoutOrders' : 'shopOrders';
 const order = {
   id: 'order_' + Utils.uuid().slice(0, 8),
   name: orderName,
   shop: '飞鸟',
   price: '',
   desc: itemSummary,
   target: recipNames,
   time: new Date().toLocaleString(),
   status: 'delivering',
   deliveryMinutes: minutes,
   orderGameTime: gameTime,
   // 飞鸟寄件专属标记
   feiniaoShip: true,
   shipMode: isExpress ? 'express' : 'errand',
   shipItems: d.items.map(it => ({ name: it.name, count: it.count || 1, effect: it.effect || '', fromInventory: !!it.fromInventory })),
   recipients: d.recipients.map(r => ({ name: r.name, source: r.source || '' })),
   hideSender: !!d.hideSender,
 };
 pd[ordersField] = pd[ordersField] || [];
 pd[ordersField].push(order);
 pd[ordersField] = pd[ordersField].slice(-30);
 await _savePhoneData();

 // 3) 主线操作日志（寄件语义）
 const senderInfo = d.hideSender ? '（寄件人匿名）' : '';
 const modeLabel = isExpress ? '快递' : '跑腿';
 _log(`通过飞鸟${modeLabel}寄出了「${orderName}」（${itemSummary}）给${recipNames}${senderInfo}。物品尚在途中，送达前请勿描写收件人已收到的情节，送达时系统会另行通知。`);

 // 关闭弹窗、清草稿、刷新
 document.getElementById('feiniao-ship-overlay')?.remove();
 _feiniaoDraft = null;
 const deliveryText = _formatDeliveryRemaining(minutes);
 UI.showToast(`已寄出${deliveryText ? '，预计' + deliveryText + '后送达' : ''}`, 2200);
 if (_currentApp === 'feiniao') _renderFeiniao(pd);
}

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
    // 周天名放宽到任意 1-4 个中文（支持自定义历法的"风日""寅时""水曜日"等），
    // 时分单独捕获，避免周天名匹配失败时把时分一起吞掉。
    const m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*([\u4e00-\u9fa5]{1,4}[日曜]?)?\s*(\d{1,2}:\d{1,2})?/);
    if (m) {
      const mm = String(m[2]).padStart(2, '0');
      const dd = String(m[3]).padStart(2, '0');
      return `${m[1]}.${mm}.${dd}${m[4] ? ' ' + m[4] : ''}${m[5] ? ' ' + m[5] : ''}`.trim();
    }
    return s;
  }

  // 把游戏时间字符串解析为可比较的数字（yyyymmddHHMM），解析失败返回 0
  // 统一复用 Calendar.parseAbsoluteTime，使其支持自定义周天名（如"风日""寅时""水曜日"），
  // 避免手机自己维护的正则与历法系统跑偏（旧正则写死"星期X"，遇自定义周天名会吞掉时分）。
  function _parsePhoneTimeScore(t) {
    const s = String(t || '').trim();
    if (!s) return 0;
    // 优先用历法系统解析（兼容自定义周天名 + 一位分钟等）
    try {
      if (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) {
        const obj = Calendar.parseAbsoluteTime(s);
        if (obj) {
          const mo = String(obj.month).padStart(2, '0');
          const dd = String(obj.day).padStart(2, '0');
          const hh = String(obj.hour).padStart(2, '0');
          const mm2 = String(obj.minute).padStart(2, '0');
          return parseInt(`${String(obj.year).padStart(4, '0')}${mo}${dd}${hh}${mm2}`, 10);
        }
      }
    } catch(_) {}
    // 兜底：Calendar 不可用时用本地正则（仅识别内置"星期X"）
    let m = s.match(/(\d{4})\.(\d{2})\.(\d{2})(?:\s+星期[一二三四五六日天])?(?:\s+(\d{1,2}):(\d{2}))?/);
    if (m) {
      const hh = String(m[4] || '0').padStart(2, '0');
      const mm2 = String(m[5] || '0').padStart(2, '0');
      return parseInt(`${m[1]}${m[2]}${m[3]}${hh}${mm2}`, 10);
    }
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

  // ===== 配送时间计算工具 =====
  // 把游戏时间字符串解析为"从公元0年起的总分钟数"（简化：每月30天、每年360天）
  function _gameTimeToMinutes(timeStr) {
    let obj = null;
    try {
      if (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) {
        obj = Calendar.parseAbsoluteTime(timeStr);
      }
    } catch(_) {}
    if (!obj) {
      // fallback：从字符串拆解
      const s = String(timeStr || '').trim();
      let m = s.match(/(\d{4})[.\-\/年](\d{1,2})[.\-\/月](\d{1,2})[日]?(?:[\s\u4e00-\u9fa5]*?)(\d{1,2}):(\d{2})/);
      if (!m) m = s.match(/(\d{4})\.(\d{2})\.(\d{2})(?:\s+[^\d]*)?(?:\s+(\d{1,2}):(\d{2}))?/);
      if (m) {
        obj = { year: +m[1], month: +m[2], day: +m[3], hour: +(m[4] || 0), minute: +(m[5] || 0) };
      }
    }
    if (!obj) return null;
    return (obj.year * 360 * 24 * 60) + ((obj.month - 1) * 30 * 24 * 60) + ((obj.day - 1) * 24 * 60) + (obj.hour * 60) + obj.minute;
  }

  // 计算订单剩余配送分钟数（负数=已送达）
  function _getDeliveryRemaining(order) {
    if (!order || !order.deliveryMinutes || !order.orderGameTime) return null;
    const currentTime = _getGameTime();
    if (!currentTime) return null;
    const orderMins = _gameTimeToMinutes(order.orderGameTime);
    const nowMins = _gameTimeToMinutes(currentTime);
    if (orderMins === null || nowMins === null) return null;
    const elapsed = nowMins - orderMins;
    return order.deliveryMinutes - elapsed;
  }

  // 格式化剩余分钟数为可读文本
  function _formatDeliveryRemaining(minutes) {
    if (minutes <= 0) return '已送达';
    if (minutes >= 1440) {
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      return hours > 0 ? `约${days}天${hours}小时` : `约${days}天`;
    }
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return mins > 0 ? `约${hours}小时${mins}分钟` : `约${hours}小时`;
    }
    return `约${Math.ceil(minutes)}分钟`;
  }

  // 获取所有到货提示词（供 chat.js 调用）
  async function _getDeliveryPrompts() {
    const pd = await _getPhoneData();
    if (!pd) return [];
    const prompts = [];
    const kinds = ['takeout', 'shop'];
    let changed = false;
    for (const kind of kinds) {
      const cfg = _getShopCfg(kind);
      const orders = pd[cfg.ordersField];
      if (!Array.isArray(orders)) continue;
      for (const order of orders) {
        if (order.status !== 'delivering') continue;
        const remaining = _getDeliveryRemaining(order);
        if (remaining === null) continue;
        if (remaining <= 0) {
          order.status = 'delivered';
          changed = true;
          const platform = cfg.title;
          if (order.feiniaoShip) {
            const recip = order.target || '收件人';
            if (order.feiniaoReceive) {
              // 收件方向：char 寄给 {{user}}
              const sender = order.sender || '某人';
              prompts.push(`【飞鸟收件已送达】${sender}此前通过飞鸟寄给{{user}}的"${order.name}"已送达。请在剧情中自然体现{{user}}收到来自${sender}的${order.shipMode === 'errand' ? '跑腿' : '快递'}包裹的情节，不要复述本提示。如果剧情中已经体现收件，无视本条。`);
            } else if (order.hideSender) {
              prompts.push(`【飞鸟寄件已送达】{{user}}此前通过飞鸟寄给${recip}的"${order.name}"已送达。这件${order.shipMode === 'errand' ? '跑腿' : '快递'}物品的单据上寄件人一栏为匿名，${recip}看不到是谁寄的。请在剧情中自然体现${recip}收到包裹的情节，不要复述本提示。如果剧情中已经体现收件，无视本条。`);
            } else {
              prompts.push(`【飞鸟寄件已送达】{{user}}此前通过飞鸟寄给${recip}的"${order.name}"已送达。单据上寄件人一栏写的是{{user}}，${recip}收货时能看到。请在剧情中自然体现${recip}收到包裹的情节，不要复述本提示。如果剧情中已经体现收件，无视本条。`);
            }
          } else {
            const targetInfo = order.target === '自己' ? '' : `（送给${order.target}）`;
            prompts.push(`【${kind === 'takeout' ? '外卖' : '快递'}已送达】{{user}}在${platform}下单的"${order.name}"${targetInfo}已送达。请在剧情中自然加入收货情节（${kind === 'takeout' ? '拿外卖/打开包装' : '拆快递/签收包裹'}），不要复述本提示。如果剧情中已经收到物品，无视本条。`);
          }
        }
      }
  }
  // 游鱼购买确认提示词（一次性消费）
  if (Array.isArray(pd.youyuConfirmPrompts) && pd.youyuConfirmPrompts.length) {
    for (const p of pd.youyuConfirmPrompts) prompts.push(p);
    pd.youyuConfirmPrompts = [];
    changed = true;
  }
  if (changed) await _savePhoneData();
  return prompts;
  }
  function _getChatGameTime(contactId, pd) {
    const candidates = [];

    // 1. 状态栏时间
    try {
      const sb = (typeof Conversations !== 'undefined') ? Conversations.getStatusBar() : null;
      if (sb?.time) candidates.push(_formatPhoneTime(sb.time));
    } catch(_) {}

    // 2. 全局基准时间
    if (_chatSessionBaseTime) candidates.push(_formatPhoneTime(_chatSessionBaseTime) || _chatSessionBaseTime);

    // 3. thread 中最新一条有时间的消息
    try {
      const thread = pd?.chatThreads?.[contactId] || [];
      for (let i = thread.length - 1; i >= 0; i--) {
        if (thread[i].time) { candidates.push(_formatPhoneTime(thread[i].time) || thread[i].time); break; }
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

    // 10. 最近2条一起听记录
    const ltHist = (pd.listenTogetherHistory || []).slice(-2).reverse();
    if (ltHist.length > 0) {
      parts.push('【一起听记录（最近2次）】\n' + ltHist.map(h => {
        const modeMap = { broadcast: '公放', earphone: '耳机共享', online: '线上' };
        const modeStr = modeMap[h.mode] || h.mode || '未知';
        const targetName = (h.target && h.target.name) || '未知';
        let s = `- 模式：${modeStr}，对象：${targetName}`;
        if (h.startTime) s += `，开始：${h.startTime}`;
        if (h.endTime) s += `，结束：${h.endTime}`;
        if (h.playlist && h.playlist.length > 0) {
          s += `\n  播放列表：${h.playlist.map(t => `${t.title || '?'}${t.artist ? ' - ' + t.artist : ''}`).join('、')}`;
        }
        if (h.messages && h.messages.length > 0) {
          s += `\n  留言：${h.messages.map(m => `${m.from || '?'}：${m.content || ''}`).join('；')}`;
        }
        return s;
      }).join('\n'));
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
      // 配送时间（默认）
      deliveryMin: 15,
      deliveryMax: 45,
      deliveryUnit: 'min',
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
      // 配送时间（默认）
      deliveryMin: 2,
      deliveryMax: 5,
      deliveryUnit: 'day',
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
          desc: ((pa.takeout?.desc) || '').trim(),
          deliveryMin: pa.takeout?.deliveryMin,
          deliveryMax: pa.takeout?.deliveryMax,
          deliveryUnit: pa.takeout?.deliveryUnit,
        },
        shop: {
          name: ((pa.shop?.name) || '').trim(),
          desc: ((pa.shop?.desc) || '').trim(),
          deliveryMin: pa.shop?.deliveryMin,
          deliveryMax: pa.shop?.deliveryMax,
          deliveryUnit: pa.shop?.deliveryUnit,
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
    if (!meta.name && !meta.desc && !meta.deliveryMin && !meta.deliveryMax) return def;
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
    // 配送时间覆盖（用户自定义）
    if (meta.deliveryMin && Number.isFinite(+meta.deliveryMin)) merged.deliveryMin = +meta.deliveryMin;
    if (meta.deliveryMax && Number.isFinite(+meta.deliveryMax)) merged.deliveryMax = +meta.deliveryMax;
    if (meta.deliveryUnit === 'min' || meta.deliveryUnit === 'day') merged.deliveryUnit = meta.deliveryUnit;
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
    // 只显示本平台（桃宝/饿了咪）自己的订单，排除飞鸟寄件/收件、游鱼卖出
    const orders = (pd[cfg.ordersField] || []).filter(o => o && !o.feiniaoShip && !o.feiniaoReceive && !o.youyuSell);

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
      // 配送状态
      let statusHtml = '';
      if (o.status === 'delivered') {
        statusHtml = '<span style="font-size:11px;color:#22c55e;font-weight:600">已送达 ✓</span>';
      } else if (o.status === 'delivering' && o.deliveryMinutes) {
        const remaining = _getDeliveryRemaining(o);
        if (remaining !== null && remaining <= 0) {
          // 仅显示已送达，不修改 status（由 _getDeliveryPrompts 统一标记并触发提示词）
          statusHtml = '<span style="font-size:11px;color:#22c55e;font-weight:600">已送达 ✓</span>';
        } else if (remaining !== null) {
          statusHtml = `<span style="font-size:11px;color:var(--accent);font-weight:600">配送中 · ${_formatDeliveryRemaining(remaining)}后到达</span>`;
        }
      }
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
        ${statusHtml ? `<div style="margin-top:6px">${statusHtml}</div>` : ''}
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

  // 打开自定义商品弹窗（飞鸟同款居中卡片）
  function _shopOpenCustomModal(kind) {
    const cfg = _getShopCfg(kind);
    // 移除旧弹窗
    document.getElementById('phone-shop-custom-modal')?.remove();
    const mask = document.createElement('div');
    mask.id = 'phone-shop-custom-modal';
    mask.style.cssText = 'position:fixed;inset:0;z-index:10015;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px';
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    mask.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:340px;width:100%;color:var(--text)">
        <div style="font-size:15px;font-weight:600;padding:18px 20px 12px">${Utils.escapeHtml(cfg.customBtnText)}</div>
        <div style="padding:0 20px 4px;font-size:12px;color:var(--text-secondary);margin-bottom:8px">${Utils.escapeHtml(cfg.customHint)}</div>
        <div style="padding:0 20px 4px">
          <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">商品名</label>
          <input id="phone-shop-cust-name" placeholder="商品名（必填）" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-bottom:14px">
          <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">店铺</label>
          <input id="phone-shop-cust-shop" placeholder="店铺（可留空）" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-bottom:14px">
          <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">价格</label>
          <input id="phone-shop-cust-price" placeholder="价格（数字）" type="number" inputmode="numeric" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;margin-bottom:14px">
          <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">描述</label>
          <textarea id="phone-shop-cust-desc" rows="3" placeholder="描述（可留空）" style="width:100%;box-sizing:border-box;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 10px;outline:none;resize:none"></textarea>
        </div>
        <div style="display:flex;gap:10px;padding:14px 20px 18px">
          <button onpointerdown="event.preventDefault();document.getElementById('phone-shop-custom-modal').remove()" style="flex:1;padding:11px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:14px;cursor:pointer">取消</button>
          <button onpointerdown="event.preventDefault();Phone._shopConfirmCustom('${kind}')" style="flex:1;padding:11px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:14px;font-weight:600;cursor:pointer">添加到列表</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);
  }

  function _shopCloseCustomModal() {
    document.getElementById('phone-shop-custom-modal')?.remove();
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

  // 给角色买：打开 NPC 选择弹窗（分享到聊天同款）
  async function _shopBuyForTarget(kind, idx) {
    const options = await _collectMomentVisibleOptions();
    if (!options.length) { UI.showToast('当前世界观没有可选角色', 1800); return; }

    // 移除旧弹窗
    document.getElementById('phone-shop-target-modal')?.remove();

    const listHtml = options.map(o => {
      const avatarEl = o.avatar
        ? `<img src="${Utils.escapeHtml(o.avatar)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0">`
        : `<div style="width:40px;height:40px;border-radius:50%;background:var(--accent-light, #f3e8e2);display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--accent);font-weight:600;flex-shrink:0">${Utils.escapeHtml((o.name || '?')[0])}</div>`;
      return `
      <div class="phone-shop-target-item" onclick="Phone._shopConfirmTarget('${kind}', ${idx}, '${Utils.escapeHtml(o.name).replaceAll("'","\\'")}')" style="padding:10px 12px;border-radius:10px;margin-bottom:4px;cursor:pointer;background:var(--bg-tertiary);display:flex;align-items:center;gap:10px">
        ${avatarEl}
        <div style="flex:1;min-width:0;font-size:14px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(o.name)}</div>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.6"><rect x="3" y="8" width="18" height="4" rx="1" ry="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/></svg>
      </div>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.id = 'phone-shop-target-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `<div style="width:min(320px,88vw);background:var(--bg);border-radius:18px;padding:20px;max-height:70vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-shrink:0">
        <span style="font-size:16px;font-weight:600;color:var(--text)">送给谁</span>
        <button onclick="Phone._shopCloseTargetModal()" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;line-height:1">×</button>
      </div>
      <div style="flex:1;overflow-y:auto">${listHtml}</div>
    </div>`;
    document.body.appendChild(overlay);
  }

  function _shopCloseTargetModal() {
    document.getElementById('phone-shop-target-modal')?.remove();
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
    // 确保配送配置是最新的（用户可能刚改完世界观没重开手机）
    try { await _loadShopMeta(); } catch(_) {}
    const cfgFresh = _getShopCfg(kind);
    const it = pd[cfg.cachedField]?.[idx];
    if (!it) return;

    // 扣款逻辑
    let deductMsg = '';
    let _ledgerAmount = 0, _ledgerCurId = '';
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
          _ledgerAmount = priceNum;
          _ledgerCurId = payResult.currencyId;
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
      status: 'delivering',
    };

    // 配送时间：根据 cfgFresh 随机生成
    let deliveryText = '';
    const gameTime = _getGameTime();
    if (gameTime) {
      const min = cfgFresh.deliveryMin || 15;
      const max = cfgFresh.deliveryMax || 45;
      const unit = cfgFresh.deliveryUnit || 'min';
      const randVal = Math.floor(Math.random() * (max - min + 1)) + min;
      order.deliveryMinutes = unit === 'day' ? randVal * 1440 : randVal;
      order.orderGameTime = gameTime;
      deliveryText = _formatDeliveryRemaining(order.deliveryMinutes);
    } else {
      // 没有游戏时间，不生成配送信息
      order.status = '';
    }

    pd[cfg.ordersField] = pd[cfg.ordersField] || [];
    pd[cfg.ordersField].push(order);
    pd[cfg.ordersField] = pd[cfg.ordersField].slice(-30); // 最多保留30条

    // 记账：购买支出（仅扣了绑定货币时）
    if (_ledgerAmount > 0 && _ledgerCurId) {
      pd.ledger = pd.ledger || [];
      pd.ledger.push({
        id: 'le_' + Utils.uuid().slice(0, 8),
        time: order.orderGameTime || _getGameTime() || '',
        currencyId: _ledgerCurId,
        amount: -_ledgerAmount,
        category: '购物',
        note: it.name || '',
        platform: cfgFresh.title || cfg.title,
        counterparty: '',
        source: kind === 'takeout' ? 'takeout' : 'shop',
        editable: true,
      });
      pd.ledger = pd.ledger.slice(-300);
    }
    await _savePhoneData();

    // 操作日志
    const priceStr = it.price ? `¥${it.price}` : '';
    const descStr = it.desc ? `（${_clipLogText(it.desc, 30)}）` : '';
    const forWho = target === '自己' ? '给自己' : `送给${target}`;
    _log(`在${cfg.title}APP下单了：${it.name}${priceStr ? '，' + priceStr : ''}${descStr}，${forWho}，配送中${deductMsg}。物品送达前禁止描写收到物品的情节，送达时系统会另行通知。`);

    if (_isAppStillActive(kind)) _renderShopping(pd, kind);
    UI.showToast(`下单成功${deliveryText ? '，预计' + deliveryText + '后送达' : ''}`, 2000);
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

// 给后台频道注入"玩家此刻正在播放的歌"（仅播放中返回非空，无条件同步，仅后台可见）
function buildNowPlayingForBackstage() {
  if (typeof Music === 'undefined') return '';
  let playing = false;
  try { playing = Music.isPlaying(); } catch(_) {}
  if (!playing) return '';
  const t = Music.getCurrentTrack();
  if (!t) return '';
  const title = t.title || '未命名';
  const artist = t.artist || '未知歌手';
  const desc = t.desc || '';
  const lines = [
    '【玩家正在听的歌（仅后台可见）｜OOC】',
    `玩家"{{user}}"此刻正在播放音乐：《${title}》 - ${artist}。`
  ];
  if (desc) lines.push(`歌曲简介：${desc}`);
  lines.push('这是玩家本人的播放状态，仅供后台观察氛围，不要在回复中模仿或复述此格式块。');
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
    buildPhoneDataForAI, _buildFullContext,
buildHeartsimAppFavorForBackstage,
      buildHeartsimServiceChatForBackstage,
      buildNowPlayingForBackstage,
    flushActionLog, peekActionLog, pushLog, reloadActionLog, reloadChatRoundLog,
    flushActionLogForBackstage,
    getSnapshotForRollback, restoreFromSnapshot,
    _getPhoneData, _onWallpaperPicked, _resetWallpaper, _toggleWallpaperOverlay, _onWallpaperOpacityChange, _saveWallpaperOpacity, _toggleSendActionLog, _onMomentsCoverPicked, _clearMomentsCover,
    // 个人资料卡
    _onProfileFocus, _onProfileBlur, _onProfileKeydown, _onProfileInput, _pickProfileAvatar,
    // 主屏分页
_onPagesScroll,
    // 番茄钟
    _refreshTomatoCard, _tomatoStart, _tomatoStop, _tomatoStartFromUI, _renderTomato, _switchTomatoTab,
    _tomatoToggle, _tomatoAdjust, _tomatoReset, _tomatoFinish, _tomatoEditGoal, _tomatoSaveGoal, _tomatoSaveSettings, _tomatoEditDuration, _tomatoSetDuration, _tomatoSaveDuration, _tomatoExit, _tomatoInviteCompanion, _tomatoSelectCompanion, _tomatoShowDetail,
    _openDeliveryOrders, _dwPickExpressBg, _dwDoPickImage, _dwDoClearBg, _renderDeliveries, _switchDeliveriesTab, _deliveryClaimToInv,
  // 记账 App
 _renderLedger, _ledgerSwitchCur, _ledgerEditEntry, _ledgerAddManual, _ledgerCycleView, _ledgerCalPick,
 // 电台 App
 _renderRadio, _radioOpenCategory, _radioOpenRandom, _radioRefresh, _radioAddCategory, _radioEditCategory,
    // 聊天 App
  _switchChatTab, _addChatContact, _addChatContactByIdx, _openChatThread, _syncMainlineForContact, _chatSendMessage, _chatRequestReply, _showChatBubbleMenu, _toggleChatPlusMenu, _closeChatPlusMenu, _toggleChatVoiceMode, _chatDoSend, _chatSendVoice, _playVoice, _openChatSettings, _onChatSettingsVoiceToggle, _onChatSettingsCallAutoPlayToggle, _onChatSettingsPhoneDownToggle, _saveChatSettings, _openChatLocationPicker, _confirmChatLocation, _showChatLocationDetail, _openAlbumPickerForChat, _pickAlbumForChat, _showChatPhotoDetail, _openImagePickerForChat, _onChatImagePicked,
  ingestChatMessages, getChatHistoryForNPCs,
  // 通话
_openCall, _callSendMessage, _callRequestReply, _endCall, _callDoSend, _callDoRefresh, _callDoEnd, _callEditRound, _callSaveEdit,
_chatPickCallPortrait, _chatClearCallPortrait, _showCallRecord,
    // 来电
    handleMainlineCallTag, _showIncomingCall,
  // phoneDown 接口
  getPendingPhoneDown: () => _pendingPhoneDown,
  clearPendingPhoneDown: () => { _pendingPhoneDown = null; },
    // 相机 App
    _switchCameraTab, _cameraRefillFromStatus, _cameraOpenAdjust, _cameraShoot, _cameraOpenPhoto, _cameraOnTextInput,
    _closePhotoDetail, _photoEditText, _photoCopyText, _photoDownloadImage, _photoDelete, _photoShareMoment, _photoShareMain,
    _openAlbumPickerForMoment, _closeAlbumPicker, _pickAlbumForMoment, _openAlbumPickerForForum, _pickAlbumForForum,
    _closeCameraAdjust, _cameraAIWrite, _cameraAIDraw,
    // 内部方法需要暴露给 onclick
    _addMemo, _editMemo, _saveMemo, _deleteMemo, _shareMemo, _collectMemo,
 _feiniaoAddOrder, _feiniaoCloseSheet, _feiniaoPickFromInventory, _feiniaoCustomItem, _feiniaoCustomConfirm, _feiniaoEditCustomItem,
 _feiniaoInvStep, _feiniaoInvConfirm, _feiniaoDraftSet, _feiniaoSetMode, _feiniaoItemName, _feiniaoItemCount, _feiniaoItemRemove, _feiniaoAddItem, _feiniaoCancelShip, _feiniaoSubmitShip,
 _feiniaoAddRecipient, _feiniaoRecipToggle, _feiniaoRecipConfirm, _feiniaoRecipRemove,
 _feiniaoShowOrderDetail, _feiniaoDeleteOrder, _switchFeiniaoTab,
 _renderYouyu, _switchYouyuTab, _youyuAddListing, _youyuPickFromInventory, _youyuPickInvItem, _youyuOpenListModal, _youyuRenderListModal, _youyuDraftSet, _youyuSetDelivery, _youyuConfirmListing, _youyuRemoveListing, _youyuShareListing, _youyuSendToChat, _youyuHandleBuy, _youyuDeleteOrder, _youyuShowOrderDetail,
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
    _shopDeleteOrder, _getDeliveryPrompts,
    // 钱包
    _walletAddCurrency, _walletRemoveCurrency, _claimTransfer, _showOrderDetail, _openChatTransfer, _sellBuy, _showSellDetail,
    // 日历
    _refreshCalBanner, _calNavMonth, _calSelectDay, _calOpenAddEvent, _calSaveEvent, _calDeleteEvent, _calPickType, _calPickRepeat, _calOpenColorPicker, _calOpenEditEvent, _calSaveEditEvent, _calGoToday,
    // 纪念日
    _openAnniversaryEditor, _anniPickImage, _anniSave, _anniDelete, _refreshAnniversaryCard,
    // 音乐播放器
     _openMusicLibrary, _renderMusicLibrary, _addMusicFile, _addMusicUrl, _editMusicTrack, _musicLike, _musicCycleRepeat, _refreshMusicCard, _musicAddMenu, _openMusicDetail, _renderMusicDetail, _musicListPopup, _musicComment, _musicShare, _sendMusicComment, _refreshMusicComments, _openListenTogether, _renderListenTogether, _refreshListenTogether, _listenTogetherInvite, _exitListenTogether, _musicLibRowClick, _toggleMusicEarphone, _logMusicPlay, _logMusicPause, _logMusicSwitch, _ltRetryInvite, _ltCancelInvite, _ltActivate, _ltGetPendingPrompt, _ltGetActivePrompt, _ltHandleAccept, _ltHandleMsg, _ltAddMessage, _ltWriteMessage, _switchMusicLibTab, _openListenHistoryDetail, _ltShareHistory,
    get _anniTempImage() { return _anniTempImage; },
    set _anniTempImage(v) { _anniTempImage = v; },
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
