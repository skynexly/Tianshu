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
      _invalidateMomentsCache();
      return;
    }
    const conv = Conversations.getList().find(c => c.id === convId);
    const stored = conv?.phoneData?.pendingActionLog;
    const storedBs = conv?.phoneData?.pendingActionLogForBackstage;
    _actionLog = Array.isArray(stored) ? stored.slice() : [];
    _actionLogForBackstage = Array.isArray(storedBs) ? storedBs.slice() : [];
    // 切对话时连带清空好友圈渲染缓存（mask/NPC 头像可能换了）
    _invalidateMomentsCache();
  } catch(_) {
    _actionLog = [];
    _actionLogForBackstage = [];
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
  const log = _actionLog.slice();
  _actionLog = [];
  _persistActionLog();
  return log;
}
function peekActionLog() { return _actionLog.slice(); }
function flushActionLogForBackstage() {
  const log = _actionLogForBackstage.slice();
  _actionLogForBackstage = [];
  _persistActionLog();
  return log;
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
      moments: [],               // [{id, text, image, imageDesc, visibleNpcs, time, comments, createdAt}]
      momentsCover: '',          // 好友圈顶部封面 DataURL
      npcMoments: [],            // [{npc, text, comments}] 刷新覆盖
 mapLastResults: [], // 上一次地图搜索结果，持久化
 mapLastQuery: '', // 上一次搜索关键词
 wallpaper: '', // 用户自定义手机壁纸 DataURL
      wallpaperOverlay: false, // 壁纸遮罩（深色半透明层，适配深色壁纸）
      wallpaperOpacity: 75, // 卡片/底栏/顶栏不透明度（0-100，仅有壁纸时生效）
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

    // 1. 世界观基础设定
    const wvPrompt = Chat.getWorldviewPrompt() || '';
    if (wvPrompt) parts.push('【世界观设定】\n' + wvPrompt);

    // 1.5 当前游戏时间（统一给论坛 / 好友圈 / 地图等 AI 生成内容使用）
    try {
      const sb = Conversations.getStatusBar();
      if (sb?.time) parts.push('【当前游戏时间】\n' + _formatPhoneTime(sb.time));
    } catch(_) {}

    // 2. 世界观详细数据（NPC、节日、自定义设定）
    try {
      const wv = await Worldview.getCurrent();
      if (wv) {
        // 全图 NPC + 详细资料
        const allNpcs = [];
        if (wv.globalNpcs && wv.globalNpcs.length > 0) {
          for (const npc of wv.globalNpcs) {
            let desc = `${npc.name || '未命名'}`;
            if (npc.aliases) desc += `（别名：${npc.aliases}）`;
            if (npc.detail) desc += `\n${npc.detail}`;
            allNpcs.push(desc);
          }
        }
        // 地区/势力挂载 NPC
        if (wv.regions && wv.regions.length > 0) {
          for (const r of wv.regions) {
            if (r.npcs && r.npcs.length > 0) {
              for (const npc of r.npcs) {
                let desc = `${npc.name || '未命名'}（所属：${r.name || '未知'}）`;
                if (npc.aliases) desc += `（别名：${npc.aliases}）`;
                if (npc.detail) desc += `\n${npc.detail}`;
                allNpcs.push(desc);
              }
            }
          }
        }
        if (allNpcs.length > 0) parts.push('【NPC列表与详细资料】\n' + allNpcs.join('\n---\n'));

        // 节日设定
        if (wv.festivals && wv.festivals.length > 0) {
          const festStr = wv.festivals.map(f => `${f.name || ''}（${f.date || ''}）：${f.desc || ''}`).join('\n');
          parts.push('【节日设定】\n' + festStr);
        }

        // 自定义设定（已开启的常驻条目，v581：从合并后的 knowledges 筛 keywordTrigger=false）
        const allKnowledges = wv.knowledges || wv.customs || [];
        if (allKnowledges.length > 0) {
          const enabledCustoms = allKnowledges.filter(c => !c.keywordTrigger && c.enabled !== false);
          if (enabledCustoms.length > 0) {
            const custStr = enabledCustoms.map(c => `${c.name || ''}：${c.content || ''}`).join('\n');
            parts.push('【自定义设定】\n' + custStr);
          }
        }
      }
    } catch(e) { console.warn('[Phone] 世界观数据获取失败', e); }

    // 3. 用户面具信息
    try {
      const mask = await Character.get();
      if (mask && mask.name) {
        let maskStr = `名字：${mask.name}`;
        if (mask.description) maskStr += `\n描述：${mask.description}`;
        if (mask.personality) maskStr += `\n性格：${mask.personality}`;
        parts.push('【用户角色（面具）】\n' + maskStr);
      }
    } catch(_) {}

    // 3.5 v617：当前对话绑定的单人卡主角（AI 扮演角色）
    try {
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
    try {
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
      temperature = 0.9, max_tokens = 2048, maxRetries = 3,
      onAttempt
    } = opts || {};
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
 <span class="phone-header-spacer"></span>
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
 map: `<svg ${common}><path d="M12 21s6-5 6-11a6 6 0 0 0-12 0c0 6 6 11 6 11z"></path><circle cx="12" cy="10" r="2"></circle></svg>`,
 camera: `<svg ${common}><rect x="4" y="7" width="16" height="12" rx="3"></rect><circle cx="12" cy="13" r="3"></circle><path d="M9 7l1.5-2h3L15 7"></path></svg>`,
 memo: `<svg ${common}><rect x="5" y="3" width="14" height="18" rx="2"></rect><line x1="8" y1="8" x2="16" y2="8"></line><line x1="8" y1="12" x2="16" y2="12"></line><line x1="8" y1="16" x2="13" y2="16"></line></svg>`,
 takeout: `<svg ${common}><path d="M5 9h14l-1 11H6L5 9z"></path><path d="M8 9V6a4 4 0 0 1 8 0v3"></path><line x1="9" y1="13" x2="9" y2="17"></line><line x1="15" y1="13" x2="15" y2="17"></line></svg>`,
 shop: `<svg ${common}><path d="M3 7h18l-2 13H5L3 7z"></path><path d="M8 7V5a4 4 0 0 1 8 0v2"></path></svg>`
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
 comment: `<svg ${common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"></path></svg>`
 };
 return icons[type] || '';
}
function _renderHomeIcon(a) {
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

    // 系统 App 放上方：饿了咪/桃宝 + 设置/收起手机
      const isHeartSim = document.body?.getAttribute('data-worldview') === '心动模拟';
      // 心动模拟：独占一行放在系统应用栏上方
      const heartsimApp = isHeartSim ? { id: 'heartsim_app', icon: 'heartsim', name: '心动模拟' } : null;
      const systemApps = [
        { id: 'takeout', icon: 'takeout', name: (_shopMeta?.takeout?.name || '饿了咪') },
        { id: 'shop', icon: 'shop', name: (_shopMeta?.shop?.name || '桃宝') },
        { id: 'settings', icon: 'gear', name: '设置' },
        { id: 'minimize', icon: 'phone-down', name: '收起手机' },
      ];
      const apps = [
        { id: 'forum', icon: 'forum', name: _getForumName() },
 { id: 'map', icon: 'map', name: '地图' },
 { id: 'moments', icon: 'camera', name: '好友圈' },
 { id: 'memo', icon: 'memo', name: '备忘录' },
 ];

 body.innerHTML = `
 <div class="phone-home">
 <div class="phone-widget">
  <div class="phone-widget-time" id="phone-widget-time">--:--</div>
  <div class="phone-widget-subline">
    <div class="phone-widget-date" id="phone-widget-date"></div>
    <div class="phone-widget-weather" id="phone-widget-weather"></div>
  </div>
</div>
<div class="phone-home-spacer"></div>
${heartsimApp ? `<div class="phone-system-grid phone-heartsim-row">${_renderHomeIcon(heartsimApp)}</div>` : ''}
<div class="phone-system-grid">
${systemApps.map(a => _renderHomeIcon(a)).join('')}
</div>
<div class="phone-app-grid">
 ${apps.map(a => _renderHomeIcon(a)).join('')}
 </div>
 </div>
 `;

 // 填充小组件数据（从 status 缓存拿）
 _refreshWidget();
 _getPhoneData().then(pd => _applyWallpaper(pd)).catch(() => {});
 _currentApp = null;
  }

  let _navStack = []; // 导航栈：每一项是 function
  let _isNavBack = false; // 防止 goBack 触发的渲染再次 push

  function _pushNav(renderFn) {
    if (_isNavBack) return; // goBack 触发的渲染不 push
    _navStack.push(renderFn);
    document.getElementById('phone-back-btn')?.classList.remove('hidden');
  }

  function goBack() {
    if (_navStack.length > 1) {
      _navStack.pop();
      const prev = _navStack[_navStack.length - 1];
      _isNavBack = true;
      prev();
      _isNavBack = false;
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
 case 'forum': _renderForum(phoneData); break;
 case 'map': _renderMap(phoneData); break;
 case 'moments': _renderMoments(phoneData); break;
 case 'memo': _renderMemo(phoneData); break;
 case 'takeout': _renderShopping(phoneData, 'takeout'); break;
 case 'shop': _renderShopping(phoneData, 'shop'); break;
 case 'heartsim_app': _renderHeartSimApp(phoneData); break;
 }
 document.getElementById('phone-back-btn')?.classList.remove('hidden');
 };
    _navStack = [renderApp]; // 重置栈，App 列表页为栈底
    renderApp();
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
 <label class="phone-settings-btn">
 <input type="file" accept="image/*" onchange="Phone._onWallpaperPicked(event)" hidden>
 <span>更换壁纸</span>
 </label>
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
 </div>
 `;
}

async function _onWallpaperPicked(e) {
 const file = e?.target?.files?.[0];
 if (!file) return;
 try {
 const dataUrl = await _compressWallpaper(file);
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

async function _onMomentsCoverPicked(input) {
 const file = input?.files?.[0];
 if (!file) return;
 try {
 const dataUrl = await _compressWallpaper(file, { maxW: 1200, maxH: 520, quality: 0.82 });
 const pd = await _getPhoneData();
 if (!pd) return;
 pd.momentsCover = dataUrl;
 await _savePhoneData();
 UI.showToast('好友圈封面已更新');
 _renderMoments(pd);
 } catch(e) {
 console.error('[Phone] 好友圈封面上传失败', e);
 UI.showToast('封面上传失败');
 } finally {
 if (input) input.value = '';
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
  let _forumTab = 'posts'; // 'posts' | 'history'

  function _renderForum(pd) {
    const body = document.getElementById('phone-body');
    document.getElementById('phone-title').textContent = _getForumName();

    // 统一以 phoneData 缓存为准（WorldVoice 仅作为生成器）
    const posts = pd.cachedForumPosts || [];
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
          <div style="display:flex;gap:6px;margin-bottom:10px">
            <input id="phone-forum-search" type="text" placeholder="搜索…" style="flex:1;border:1px solid var(--border);border-radius:6px;padding:6px 10px;background:var(--bg-tertiary);color:var(--text);font-size:13px">
            <button onclick="Phone._forumSearch()" style="background:var(--accent);color:#111;border:none;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;white-space:nowrap">搜索</button>
            <button onclick="Phone._forumRefresh()" class="phone-icon-btn" title="随机推荐">
 ${_uiIcon('refresh', 15)}
 </button>
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
        <div class="phone-tabbar">
          <div class="phone-tab ${_forumTab === 'posts' ? 'active' : ''}" onclick="Phone._switchForumTab('posts')">推荐</div>
          <div class="phone-tab ${_forumTab === 'history' ? 'active' : ''}" onclick="Phone._switchForumTab('history')">搜索记录</div>
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
          <div style="width:24px;height:24px;border-radius:50%;background:${Utils.escapeHtml(p.avatar_color || '#888')};display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:bold;flex-shrink:0">${Utils.escapeHtml((p.username || '?')[0])}</div>
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
          <button type="button" onclick="event.stopPropagation();Phone._shareForumPost(${i})" class="phone-forum-preview-action-btn" title="分享到主线">${_uiIcon('share', 12)} 分享</button>
        </div>
      </div>
    `).join('');
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
    // push 详情页到导航栈
    _pushNav(() => _forumViewDetail(index));

    function _renderDetailInPhone(p) {
      const formatNum = n => { if (!n) return '0'; if (n >= 10000) return (n/10000).toFixed(1)+'w'; if (n >= 1000) return (n/1000).toFixed(1)+'k'; return String(n); };
      let html = `<div class="phone-forum-detail-page" style="display:flex;flex-direction:column;height:100%">`;
 html += `<div class="phone-forum-detail-scroll" style="flex:1;overflow-y:auto;padding:12px">`;
      // 发帖人
      html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <div style="width:28px;height:28px;border-radius:50%;background:${Utils.escapeHtml(p.avatar_color||'#888')};display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:bold;flex-shrink:0">${Utils.escapeHtml((p.username||'?')[0])}</div>
        <div><div style="font-size:13px;font-weight:600;color:var(--text)">${Utils.escapeHtml(p.username||'匿名')}</div><div style="font-size:10px;color:var(--text-secondary)">${Utils.escapeHtml(_formatPhoneTime(p.time||''))}</div></div>
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
              <div style="width:24px;height:24px;border-radius:50%;background:${Utils.escapeHtml(c.avatar_color||'#666')};display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:bold;flex-shrink:0">${Utils.escapeHtml((c.username||'?')[0])}</div>
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
        // 操作底栏：固定在底部
        html += `<div class="phone-forum-detail-actions" style="display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--border);flex-shrink:0;background:var(--bg-secondary)">
        <button onclick="Phone._likeForumPost(${index})" id="phone-forum-like-btn" class="wv-action-btn" style="flex:1;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;font-size:12px;display:flex;align-items:center;justify-content:center;gap:4px">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          <span id="phone-forum-like-num">${formatNum(p.likes||0)}</span>
        </button>
        <button onclick="Phone._collectForumPost(${index})" id="phone-forum-collect-btn" class="wv-action-btn" style="flex:1;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;font-size:12px;display:flex;align-items:center;justify-content:center;gap:4px">
          <svg id="phone-forum-collect-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3.5 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.7l-5.56 2.92 1.06-6.2L3 10.03l6.22-.9L12 3.5z"/></svg>
          <span>收藏</span>
        </button>
        <button onclick="Phone._shareForumPost(${index})" class="wv-action-btn" style="flex:1;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;font-size:12px;display:flex;align-items:center;justify-content:center;gap:4px">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
          <span>分享</span>
        </button>
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

  async function _shareForumPost(index) {
    const pd = await _getPhoneData();
    let posts = pd?.cachedForumPosts || [];
    if (posts.length === 0) posts = (window.WorldVoice && WorldVoice.getPosts()) || [];
    const p = posts[index];
    if (!p) { UI.showToast('帖子不存在', 1000); return; }
    let content = `标题：${p.title || ''}\n作者：${p.username || '匿名'}\n`;
    if (p.fullContent) {
      content += `\n${p.fullContent}`;
    } else {
      content += `摘要：${p.summary || ''}`;
    }
    if (p.tags?.length) content += `\n标签：${p.tags.join('、')}`;
    if (p._comments?.length) {
      content += '\n\n评论区：\n' + p._comments.map(c => `${c.username || '匿名'}：${c.content || ''}`).join('\n');
    }
    _shareToMain('forum', p.title || `${_getForumName()}帖子`, content);
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

  function _shareMapResult(index) {
    const r = _mapSearchResults[index];
    if (!r) return;
    const content = `地点：${r.name || ''}\n地址：${r.address || ''}\n描述：${r.desc || ''}${r.distance ? '\n距离：' + r.distance : ''}`;
    _shareToMain('map', r.name || '地点', content);
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
            <button type="button" onclick="Phone._collectMyMoment(${i})" class="phone-moment-action-btn">${_uiIcon('star', 12)} 收藏</button>
            <button type="button" onclick="Phone._shareMoment(${i})" class="phone-moment-action-btn">${_uiIcon('share', 12)} 分享</button>
            <button type="button" onclick="Phone._deleteMyMoment(${i})" class="phone-moment-action-btn danger">${_uiIcon('trash', 12)} 删除</button>
            ${!(m.comments && m.comments.length) ? `<button type="button" onclick="Phone._refreshMomentComments(${i})" class="phone-moment-action-btn">${_uiIcon('refresh', 12)} 刷新评论</button>` : ''}
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
            </div>
          </div>
          <div class="phone-moment-actions">
            <button type="button" onclick="Phone._likeNpcMoment(${i})" class="phone-moment-action-btn ${m.likedByUser ? 'active-collect' : ''}">${_uiIcon('heart', 12)} ${m.likedByUser ? '已赞' : '点赞'}${m.userLikeCount ? ` ${m.userLikeCount}` : ''}</button>
            <button type="button" onclick="Phone._commentNpcMoment(${i})" class="phone-moment-action-btn">${_uiIcon('comment', 12)} 评论</button>
            <button type="button" onclick="Phone._collectNpcMoment(${i})" class="phone-moment-action-btn">${_uiIcon('star', 12)} 收藏</button>
            <button type="button" onclick="Phone._shareNpcMoment(${i})" class="phone-moment-action-btn">${_uiIcon('share', 12)} 分享</button>
          </div>
          ${commentsHtml(m.comments)}
        </div>
      `).join('')
      : '<p style="text-align:center;color:var(--text-secondary);font-size:12px;margin-top:24px">点击"刷新动态"查看好友动态</p>';

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%">
        <div class="phone-moments-cover" onclick="document.getElementById('phone-moments-cover-input')?.click()" style="${pd.momentsCover ? `background-image:linear-gradient(180deg,rgba(0,0,0,0.10),rgba(0,0,0,0.46)),url('${pd.momentsCover}')` : ''}">
          <input id="phone-moments-cover-input" type="file" accept="image/*" hidden onchange="Phone._onMomentsCoverPicked(this)">
          <button type="button" class="phone-moments-cover-action" onclick="event.stopPropagation();${_momentsTab === 'mine' ? 'Phone._postMoment()' : 'Phone._refreshNpcMoments()'}" title="${_momentsTab === 'mine' ? '发动态' : '刷新好友动态'}">
            ${_momentsTab === 'mine' ? _uiIcon('camera', 15) : _uiIcon('refresh', 15)}
          </button>
          <div class="phone-moments-cover-hint">点击更换封面</div>
          <div class="phone-moments-profile">
            ${avatarHtml(maskName, maskAvatar, 'cover')}
            <div class="phone-moments-profile-text">
              <div class="phone-moments-profile-name">${Utils.escapeHtml(maskName)}</div>
              <div class="phone-moments-profile-sub">${_momentsTab === 'mine' ? '我的动态' : '好友动态'}</div>
            </div>
          </div>
        </div>
        <div id="phone-moments-mine-list" class="phone-moments-list" style="display:${_momentsTab === 'mine' ? 'block' : 'none'}">${myHtml}</div>
        <div id="phone-moments-npc-list" class="phone-moments-list" style="display:${_momentsTab === 'friends' ? 'block' : 'none'}">${friendsHtml}</div>
        <div class="phone-tabbar">
          <div class="phone-tab ${_momentsTab === 'mine' ? 'active' : ''}" onclick="Phone._switchMomentsTab('mine')">我的动态</div>
          <div class="phone-tab ${_momentsTab === 'friends' ? 'active' : ''}" onclick="Phone._switchMomentsTab('friends')">好友动态</div>
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
      maskName = mask?.name || '我';
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
    await _addPhoneCollection('moments', `${m.npc}的动态`, text, { comments: m.comments || [] });
  }

  async function _collectMyMoment(index) {
    const pd = await _getPhoneData();
    const m = pd?.moments?.[index];
    if (!m) return;
    let text = m.text || '';
    if (m.imageDesc) text += `\n[配图描述：${m.imageDesc}]`;
    await _addPhoneCollection('moments', '我的动态：' + (m.text || '').substring(0, 20), text, { comments: m.comments || [] });
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
      (wv.globalNpcs || []).forEach(n => add(n.name, '全图NPC', avatarById[n.id] || n.avatar || ''));
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

  async function _postMoment() {
    _momentVisibleOptions = await _collectMomentVisibleOptions();
    _momentVisibleSelected = new Set(['__all__']);

    // 抓主线时间
    let gameTime = '';
    try { const sb = Conversations.getStatusBar(); gameTime = _formatPhoneTime(sb?.time || ''); } catch(_) {}

    const body = document.getElementById('phone-body');
    document.getElementById('phone-title').textContent = '发动态';
    body.innerHTML = `
<div style="padding:12px;display:flex;flex-direction:column;gap:8px;height:100%">
                <textarea id="phone-moment-text" placeholder="说点什么…" style="flex:1;min-height:80px;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg-tertiary);color:var(--text);font-size:13px;resize:none"></textarea>
                <div id="phone-moment-imgdesc-wrap">
                  <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;display:flex;align-items:center;gap:4px">${_uiIcon('image', 12)} 描述配图（可选，AI 会根据描述生成评论）</div>
                  <textarea id="phone-moment-imgdesc" placeholder="用文字描述你想配的图片，例如：一张窗外的雨景照片" style="width:100%;min-height:40px;border:1px solid var(--border);border-radius:6px;padding:6px 8px;background:var(--bg-tertiary);color:var(--text);font-size:12px;resize:none;box-sizing:border-box"></textarea>
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
      _log('新增了一条好友圈动态');
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
    try { const mask = await Character.get(); _userName = mask?.name || ''; } catch(_) {}
    const userBan = _userName
      ? `\n【严格约束】评论者姓名绝对不能是"${_userName}"（那是玩家本人），也不允许任何评论以"我"（指代玩家）的口吻发言。这条动态是玩家自己发的，不需要玩家自评。`
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

    // 自动切到"好友动态" tab
    _momentsTab = 'friends';
    _renderMoments(pd);

    // 显示骨架屏加载态
    const npcContainer = document.getElementById('phone-moments-npc-list');
    const setLoading = (attempt = 1, maxRetries = 3) => {
      const cur = document.getElementById('phone-moments-npc-list');
      if (!cur) return;
      cur.innerHTML = Array.from({ length: 4 }).map((_, idx) => `
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

      const nameConstraint = npcNames.length > 0
      ? `\n\n【严格约束】动态发布者必须从以下NPC列表中选：${npcNames.join('、')}。评论者可以是列表中的NPC，也可以是虚构的路人账号（但路人名字要符合世界观风格）。禁止编造列表外的NPC。`
      : '';
    // v617：禁止冒充玩家
    const userBan = userName
      ? `\n\n【禁止冒充玩家】玩家角色"${userName}"绝对不能作为动态发布者出现，也不能作为任何评论者出现（包括路人评论）。评论者 name 字段不允许是"${userName}"，也不允许任何评论以"我"（指代玩家）的口吻发布。玩家会自己评论，不需要 AI 代劳。`
      : '\n\n【禁止冒充玩家】不要让玩家角色作为动态发布者或评论者，也不要让任何角色冒充用户/玩家发言。';
    
    const systemPrompt = `根据以下世界观、NPC资料和剧情，生成4条NPC的社交媒体动态。从NPC列表中随机挑选（不重复），内容要贴合角色性格和当前剧情，可以是日常、心情、暗示、或和主角相关的。每条带1-3条路人或者与该NPC有关的其他NPC的评论，若NPC相互不认识或没有交集，可以仅路人评论。${nameConstraint}${userBan}

时间要求：每条动态必须带发布时间 time，格式为“YYYY.MM.DD 星期X HH:mm”。发布时间必须在当前/截止剧情最新时间之前，且不早于该时间前7天；禁止生成未来时间。若能从上下文中的【当前游戏时间】读取到时间，就以它为基准生成；如果无法确定具体剧情日期，也要使用世界观/状态栏中能推断出的最新时间附近的过去7天内时间。

返回纯JSON数组，不要任何额外文字：
[{"npc":"NPC名","time":"YYYY.MM.DD 星期X HH:mm","text":"动态内容","comments":[{"name":"评论者","text":"评论"}]}]

${fullCtx}`;

      const arr = await _phoneJsonArrayWithRetry({
        label: '好友动态', url, key, model,
        temperature: 0.9,
        max_tokens: 3000,
        maxRetries: 3,
        onAttempt: setLoading,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '请生成4条NPC动态，严格使用NPC列表中的名字，并为每条动态填写符合要求的发布时间 time。' }
        ]
      });
      pd.npcMoments = arr.slice(0, 4);
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

    // 8. 最近2条备忘录（完整内容）
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
    const platform = _getShopCfg(kind).title;  // '饿了咪' / '桃宝'
    const title = `${platform}：${it.name || '商品'}`;
    const lines = [];
    lines.push(`平台：${platform}`);
    lines.push(`商品：${it.name || ''}`);
    if (it.shop) lines.push(`店铺：${it.shop}`);
    if (it.price !== undefined && it.price !== null && String(it.price).trim() !== '') {
      lines.push(`价格：¥${it.price}`);
    }
    if (it.desc) lines.push(`描述：${it.desc}`);
    await _shareToMain('shop', title, lines.join('\n'));
  }

  // 给自己买
  async function _shopBuyForSelf(kind, idx) {
    const pd = await _getPhoneData();
    const it = pd?.[_getShopCfg(kind).cachedField]?.[idx];
    if (!it) return;
    const priceStr = it.price ? `¥${it.price}` : '';
    const ok = await UI.showConfirm(
      '确认下单',
      `给自己买：${it.name}${priceStr ? ' · ' + priceStr : ''}${it.shop ? '\n店铺：' + it.shop : ''}`
    );
    if (!ok) return;
    await _shopCreateOrder(kind, idx, '自己');
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
    const priceStr = it.price ? `¥${it.price}` : '';
    const ok = await UI.showConfirm(
      '确认下单',
      `给 ${target} 买：${it.name}${priceStr ? ' · ' + priceStr : ''}${it.shop ? '\n店铺：' + it.shop : ''}`
    );
    if (!ok) return;
    await _shopCreateOrder(kind, idx, target);
  }

  // 创建订单（通用）
  async function _shopCreateOrder(kind, idx, target) {
    const cfg = _getShopCfg(kind);
    const pd = await _getPhoneData();
    if (!pd) return;
    const it = pd[cfg.cachedField]?.[idx];
    if (!it) return;

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

    // 操作日志：AI 看到这条就知道剧情里要演"送达"
    const priceStr = it.price ? `¥${it.price}` : '';
    const descStr = it.desc ? `（${_clipLogText(it.desc, 30)}）` : '';
    const forWho = target === '自己' ? '给自己' : `送给${target}`;
    _log(`在${cfg.title}APP下单了：${it.name}${priceStr ? '，' + priceStr : ''}${descStr}，${forWho}（配送时间由你在剧情中自然安排）`);

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
          <div id="hs-edit-avatar-preview" style="width:80px;height:80px;border-radius:50%;overflow:hidden;background:var(--bg-tertiary);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;cursor:pointer" onclick="document.getElementById('hs-edit-avatar-input').click()">
            ${avatarSrc
              ? `<img src="${Utils.escapeHtml(avatarSrc)}" alt="" style="width:100%;height:100%;object-fit:cover">`
              : `<span style="font-size:11px;color:var(--text-secondary)">点击上传</span>`}
          </div>
          <input type="file" id="hs-edit-avatar-input" accept="image/*" style="display:none" onchange="Phone._hsEditAvatarPicked(this)">
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
function _hsEditAvatarPicked(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const raw = e.target.result;
    const img = new Image();
    img.onload = () => {
      // 压缩到 200×200，JPEG 0.85（头像够用）
      const SIZE = 200;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE; canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      // 居中裁剪
      const minSide = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - minSide) / 2;
      const sy = (img.naturalHeight - minSide) / 2;
      ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, SIZE, SIZE);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      _hsEditPendingAvatar = dataUrl;
      const preview = document.getElementById('hs-edit-avatar-preview');
      if (preview) {
        preview.innerHTML = `<img src="${Utils.escapeHtml(dataUrl)}" alt="" style="width:100%;height:100%;object-fit:cover">`;
      }
    };
    img.src = raw;
  };
  reader.readAsDataURL(file);
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

// ===== 对外接口 =====
  return {
    open, close, minimize, goHome, goBack, openApp, isOpen,
    setNotification, recordLocation,
    buildPhoneDataForAI,
    buildHeartsimAppFavorForBackstage,
    buildHeartsimServiceChatForBackstage,
    flushActionLog, peekActionLog, pushLog, reloadActionLog,
    flushActionLogForBackstage,
    _getPhoneData, _onWallpaperPicked, _resetWallpaper, _toggleWallpaperOverlay, _onWallpaperOpacityChange, _saveWallpaperOpacity, _onMomentsCoverPicked, _clearMomentsCover,
    // 内部方法需要暴露给 onclick
    _addMemo, _editMemo, _saveMemo, _deleteMemo, _shareMemo, _collectMemo,
    _forumRefresh, _forumSearch, _forumViewDetail, _shareForumPost, _collectForumPost, _likeForumPost,
    _switchForumTab, _shareForumSearch, _shareAllForumSearches, _deleteForumSearch,
    _postMoment, _onMomentImagePicked, _toggleImageDesc, _submitMoment, _shareMoment, _collectMyMoment, _deleteMyMoment, _shareNpcMoment, _refreshMomentComments, _refreshNpcMoments,
    _openMomentVisibleModal, _closeMomentVisibleModal, _filterMomentVisibleOptions, _toggleMomentVisibleOption, _setMomentVisibleAll,
    _switchMomentsTab, _collectNpcMoment, _likeNpcMoment, _commentNpcMoment,
    _mapSearch, _shareMapResult, _collectMapResult, _switchMapTab, _renderMapResultsHtml,
    _shareMapSearch, _shareAllMapSearches, _deleteMapSearch, _deleteLocationHistory,
    // 外卖/网购
    _switchShopTab, _shopRefresh, _shopSearch, _shopRepeatSearch, _deleteShopSearch,
    _shopOpenCustomModal, _shopCloseCustomModal, _shopConfirmCustom,
    _shopBuyForSelf, _shopBuyForTarget, _shopConfirmTarget, _shopCloseTargetModal,
    _shopShareItem,
    _shopDeleteOrder,
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
