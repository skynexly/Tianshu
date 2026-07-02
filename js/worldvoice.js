/**
 * WorldVoice — 手机论坛/信息载体的内容生成后端
 * （旧的浮动风闻 UI 已扣除，本模块只对外暴露数据接口：refresh / loadDetailSilent / getPosts / isRefreshing / abortRefresh / getDetail）
 */
const WorldVoice = (() => {
  let posts = []; // 当前帖子列表
  let currentDetail = null; // 当前查看的帖子详情
  let isGenerating = false;
  let _abortCtrl = null;
  let isMinimized = false;

  // 从DB恢复帖子缓存
  (async function _restorePosts() {
    try {
      const cached = await DB.get('gameState', 'wv_posts');
      if (cached?.value) posts = cached.value;
    } catch(e) {}
  })();

  async function _savePosts() {
    try { await DB.put('gameState', { key: 'wv_posts', value: posts }); } catch(e) {}
  }

  // 获取信息载体名称 + 描述（来自世界观 phoneApps.forum，留空回落"论坛"）
  async function _getMediaType() {
    const wv = await Worldview.getCurrent();
    const nm = wv?.phoneApps?.forum?.name?.trim();
    return nm || '论坛';
  }
  async function _getMediaDesc() {
    const wv = await Worldview.getCurrent();
    return wv?.phoneApps?.forum?.desc?.trim() || '';
  }

  // v617：获取玩家角色名（面具名+网名）
  async function _getPlayerName() {
    try {
      const mask = await Character.get();
      return { name: mask?.name?.trim() || '', onlineName: (mask?.onlineName || '').trim() };
    } catch(_) { return { name: '', onlineName: '' }; }
  }

  // 提取世界观中有设定的NPC角色列表（供论坛prompt使用）
  async function _getNpcListForForum() {
    try {
      const wv = await Worldview.getCurrent();
      const npcs = [];
      const _npcEntry = (n) => {
        if (!n || !n.name) return null;
        const username = (n.onlineName || '').trim() || n.name;
        let s = `- ${username}`;
        if (n.onlineName && n.name !== n.onlineName) s += `（即${n.name}）`;
        return s;
      };
      // 世界观 NPC
      if (wv && wv.regions) {
        for (const region of wv.regions) {
          if (!region.factions) continue;
          for (const faction of region.factions) {
            if (!faction.npcs) continue;
            for (const n of faction.npcs) {
              const e = _npcEntry(n);
              if (e) npcs.push(e);
            }
          }
        }
      }
      // 当前对话生效的世界书 NPC
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
          for (const lb of (lbs || [])) {
            (lb.globalNpcs || []).forEach(n => {
              if (!n || !n.name) return;
              if (npcs.some(x => x.includes(`本名：${n.name}`))) return;
              const e = _npcEntry(n); if (e) npcs.push(e);
            });
          }
        }
      } catch(_) {}
      // 单人卡（作为角色也可以出现在论坛）
      try {
        const convId = (typeof Conversations !== 'undefined') ? Conversations.getCurrent() : null;
        const conv = convId ? Conversations.getList().find(c => c.id === convId) : null;
        if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
          const card = await DB.get('singleCards', conv.singleCharId);
          if (card && card.name && !npcs.some(x => x.includes(`本名：${card.name}`))) {
            const e = _npcEntry(card); if (e) npcs.push(e);
          }
        }
      } catch(_) {}
      if (npcs.length === 0) return '';
      // 获取玩家名，在列表末尾提醒AI不要用玩家名
      let playerNote = '';
      try {
        const { name, onlineName } = await _getPlayerName();
        const pNames = [name, onlineName].filter(Boolean);
        if (pNames.length > 0) playerNote = `\n（注意："${pNames.join('"和"')}"是玩家本人，不在此列表中，不能作为发帖人或评论者）`;
      } catch(_) {}
      return `\n\n## 有设定的角色（仅1-2条可以由以下角色发帖/评论，其余必须是路人。username 直接填"-"后面的名字）${playerNote}\n${npcs.join('\n')}`;
    } catch(_) { return ''; }
  }

  // 构建「任意名（本名/网名/别名）→ 本名」反查映射，供论坛帖子/评论补 realName 身份键（记事本用）。
  // 论坛 AI 输出的是网名，这里反查回本名存进 realName，显示层仍用网名。
  async function _buildNpcRealNameMap() {
    const map = {};
    const add = (n) => {
      if (!n || !n.name) return;
      const real = n.name.trim();
      if (!real) return;
      const keys = [real, (n.onlineName || '').trim()];
      String(n.aliases || '').split(/[,，、\s]+/).forEach(a => keys.push(a.trim()));
      keys.filter(Boolean).forEach(k => { if (!map[k]) map[k] = real; });
    };
    try {
      const wv = await Worldview.getCurrent();
      if (wv && wv.regions) {
        for (const region of wv.regions) {
          for (const faction of (region.factions || [])) {
            for (const n of (faction.npcs || [])) add(n);
          }
        }
      }
      if (wv && wv.globalNpcs) wv.globalNpcs.forEach(add);
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
          for (const lb of (lbs || [])) { (lb.globalNpcs || []).forEach(add); }
        }
      } catch(_) {}
      // 单人卡
      try {
        const convId = (typeof Conversations !== 'undefined') ? Conversations.getCurrent() : null;
        const conv = convId ? Conversations.getList().find(c => c.id === convId) : null;
        if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
          const card = await DB.get('singleCards', conv.singleCharId);
          if (card) add(card);
        }
      } catch(_) {}
    } catch(_) {}
    return map;
  }

  // 给一条帖子/评论补 realName 身份键（用网名/别名反查本名；查不到则不设，视为路人）
  function _attachRealName(item, realNameMap) {
    if (!item || !item.username || !realNameMap) return;
    const real = realNameMap[item.username.trim()];
    if (real) item.realName = real;
  }


  // 更新加号菜单里的按钮名
  async function updateLabel() {
    const label = document.getElementById('world-voice-label');
    if (label) label.textContent = await _getMediaType();
  }

  // 打开窗口
  async function open() {
    const modal = document.getElementById('wv-voice-modal');
    if (!modal) return;
    const mediaType = await _getMediaType();
    document.getElementById('wv-voice-title').textContent = mediaType;
    // 显示列表视图
    document.getElementById('wv-voice-list-view').style.display = 'flex';
    document.getElementById('wv-voice-detail-view').classList.add('hidden');
    modal.classList.remove('hidden');
    document.getElementById('wv-voice-fab')?.classList.add('hidden');
    isMinimized = false;
    // 如果有缓存的帖子就渲染
    if (posts.length > 0) _renderPosts();
  }

  function minimize() {
  const modal = document.getElementById('wv-voice-modal');
  if (!modal) return;
  modal.classList.add('closing');
  setTimeout(() => {
    modal.classList.remove('closing');
    modal.classList.add('hidden');
    const fab = document.getElementById('wv-voice-fab');
    if (fab) {
      fab.classList.remove('hidden');
      fab.classList.toggle('generating', !!isGenerating);
    }
  }, 220);
  isMinimized = true;
}

  function restore() {
  const modal = document.getElementById('wv-voice-modal');
  if (!modal) return;
  modal.classList.remove('closing');
  modal.classList.remove('hidden');
  const fab = document.getElementById('wv-voice-fab');
  if (fab) {
    fab.classList.remove('generating');
    fab.classList.add('hidden');
  }
  isMinimized = false;
}

  async function close() {
  if (isGenerating) {
    if (!await UI.showConfirm('关闭风闻', '正在生成内容，关闭将中断当前生成。确定关闭？')) return;
    if (_abortCtrl) _abortCtrl.abort();
    _abortCtrl = null;
    isGenerating = false;
    UI.showToast('已中断生成');
  }
  const modal = document.getElementById('wv-voice-modal');
  if (modal) {
    modal.classList.add('closing');
    setTimeout(() => {
      modal.classList.remove('closing');
      modal.classList.add('hidden');
      document.getElementById('wv-voice-fab')?.classList.add('hidden');
    }, 220);
  }
  isMinimized = false;
}

  // 把任意时间字符串归一化为 "YYYY.MM.DD 星期X HH:mm"（论坛/好友圈统一格式）
  function _formatGameTime(t) {
    const str = String(t || '').trim();
    if (!str) return '';
    const m = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(星期[一二三四五六日天])?\s*(\d{1,2}:\d{2})?/);
    if (m) {
      const mm = String(m[2]).padStart(2, '0');
      const dd = String(m[3]).padStart(2, '0');
      return `${m[1]}.${mm}.${dd}${m[4] ? ' ' + m[4] : ''}${m[5] ? ' ' + m[5] : ''}`.trim();
    }
    return str;
  }

  // 抓当前游戏时间：优先状态栏 time，回退到最近一条 AI 消息中的 YYYY年M月D日...
  function _extractGameTime() {
    try {
      const sb = (typeof Conversations !== 'undefined') ? Conversations.getStatusBar() : null;
      if (sb?.time) return _formatGameTime(sb.time);
    } catch(_) {}
    try {
      const chatMessages = (typeof Chat !== 'undefined' && Chat.getMessages) ? Chat.getMessages() : [];
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i].role !== 'assistant') continue;
        const tm = String(chatMessages[i].content || '').match(/\d{4}年\d{1,2}月\d{1,2}日[^\n]*/);
        if (tm) return _formatGameTime(tm[0]);
      }
    } catch(_) {}
    return '';
  }

  // 刷新帖子（含3次重试）
  async function refresh() {
    if (isGenerating) return;
    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) { UI.showToast('请先在设置→功能模型中配置模型'); return; }
    isGenerating = true;
    const fab = document.getElementById('wv-voice-fab');
    if (fab && isMinimized) fab.classList.add('generating');
    const btn = document.getElementById('wv-voice-refresh-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
    }
    _renderLoadingSkeleton();

    _abortCtrl = new AbortController();

    const mediaType = await _getMediaType();
    const mediaDesc = await _getMediaDesc();
    const wvPrompt = (typeof Phone !== 'undefined' && Phone._buildFullContext) ? await Phone._buildFullContext() : (Chat.getWorldviewPrompt() || '');
    // 论坛呼应电台：随机抽 0-1 个已订阅电台，给 AI 当可选的呼应素材（读不到/没抽中返回 ''）
let radioEcho = '';
try { radioEcho = (typeof Phone !== 'undefined' && Phone._radioEchoBlockForForum) ? await Phone._radioEchoBlockForForum() : ''; } catch (_) {}
// 论坛呼应阅读：随机抽 0-1 本书架上的书（AI/自建，排除导入），给 AI 当可选的呼应素材
let readingEcho = '';
try { readingEcho = (typeof Phone !== 'undefined' && Phone._readingEchoBlockForForum) ? await Phone._readingEchoBlockForForum() : ''; } catch (_) {}
      // 论坛呼应影视：随机抽 0-1 部看过的影视作品（电影/剧/番），给 AI 当可选的呼应素材
      let videoEcho = '';
      try { videoEcho = (typeof Phone !== 'undefined' && Phone._videoEchoBlockForForum) ? await Phone._videoEchoBlockForForum() : ''; } catch (_) {}
      // 论坛呼应直播：随机抽 0-1 个关注的直播间，给 AI 当可选的呼应素材
      let liveEcho = '';
      try { liveEcho = (typeof Phone !== 'undefined' && Phone._liveEchoBlockForForum) ? await Phone._liveEchoBlockForForum() : ''; } catch (_) {}
      // 多个都抽中时只随机保留一个，避免多条呼应帖同时挤占帖子名额、互相竞争注意力
{
        const _echoes = [];
        if (radioEcho) _echoes.push('radio');
        if (readingEcho) _echoes.push('reading');
        if (videoEcho) _echoes.push('video');
        if (liveEcho) _echoes.push('live');
        if (_echoes.length > 1) {
          const _keep = _echoes[Math.floor(Math.random() * _echoes.length)];
          if (_keep !== 'radio') radioEcho = '';
          if (_keep !== 'reading') readingEcho = '';
          if (_keep !== 'video') videoEcho = '';
          if (_keep !== 'live') liveEcho = '';
        }
}
    const chatMessages = Chat.getMessages();
    const summaryText = await Summary.formatForPrompt(Conversations.getCurrent());

    let gameTime = _extractGameTime();

    const recentMain = chatMessages.slice(-10).map(m =>
      `[${m.role === 'user' ? '玩家' : 'AI'}]: ${m.content}`
    ).join('\n');

    const mediaBrief = mediaDesc ? `\n\n载体说明：${mediaDesc}` : '';
const { name: userName, onlineName: userOnlineName } = await _getPlayerName();
const banNames = [userName, userOnlineName].filter(Boolean);
const userBan = banNames.length > 0
  ? `\n\n【禁止冒充玩家】玩家角色"${banNames.join('"和"')}"绝对不能作为帖子/动态发布者或评论者出现。所有用户名和评论者名字都不允许是"${banNames.join('"或"')}"，也不允许任何角色用"我"（指代玩家）的口吻发言。玩家自己发的内容由用户单独操作，不在本生成范围内。`
  : '\n\n【禁止冒充玩家】不要让玩家角色作为发布者或评论者，也不要让任何角色冒充玩家发言。';
const systemPrompt = `你是一个"${mediaType}"内容生成器。根据提供的世界观和当前剧情，生成${mediaType}上的帖子/动态。${mediaBrief}${userBan}

要求：
1. 生成8-10条帖子/动态预览
2. 80%的内容与世界观有关但与主线剧情无直接关系（日常生态、社会话题、生活琐事；下方若提供了可呼应的电台/小说素材，那条呼应帖也算在这 80% 日常里）
3. 20%的内容与主线正在发生的剧情有关联（但是从路人/旁观者视角，不会知道具体细节），只能涉及已经发生过的事件，不能透露或暗示尚未发生的剧情
4. 绝大多数帖子的发帖人是虚构的路人用户（非NPC），用户名要符合世界观和${mediaType}的风格
5. 每条帖子都是独立的原创帖/一楼，不是对其他帖子的回复。标题和摘要不能出现"回楼上""楼主""回复@"等评论区用语。帖子风格贴合${mediaType}的画风，长短皆可，有正经讨论也有水帖灌水，摘要长度不要千篇一律
6. tags 风格也要贴合${mediaType}（论坛/贴吧偏普通词、微博偏"#话题#"、小红书偏"#标签"），无需统一形式
7. 时间分布：80% 在当前游戏时间附近 7 天内（日常推荐流），可以有 20% 是置顶/热门/挖坟的更早老帖，time 可以更靠前；但评论时间永远不要超过当前游戏时间
8. 8-10条帖子中仅允许1-2条（不能更多）由有设定的角色发帖，其余全部是路人。角色发帖时语气必须符合该角色性格，username 直接填该角色在列表中"-"后面的名字。角色的认知范围以当前剧情进度为准，不能提到还没发生的事。角色发布的帖子可以和主线有关，也可以完全和主线无关，可能是技术贴、求助帖、生活吐槽或者一切符合角色身份、职业、性格的帖子
9. 返回纯JSON数组，不要包含任何其他文字

JSON格式（严格遵循）：
[{"id":"p1","username":"用户名","avatar_color":"#颜色","time":"YYYY.MM.DD 星期X HH:mm","title":"标题","summary":"摘要","tags":["标签1","标签2"],"views":数字,"likes":数字,"comments":数字}]

所有 time 都必须使用"YYYY.MM.DD 星期X HH:mm"格式，必须和当前游戏时间同一套写法，不要自己发明别的时间样式。

${wvPrompt}${radioEcho ? '\n\n' + radioEcho : ''}${readingEcho ? '\n\n' + readingEcho : ''}${videoEcho ? '\n\n' + videoEcho : ''}${liveEcho ? '\n\n' + liveEcho : ''}`;

    let userPrompt = '';
    if (summaryText) userPrompt += `## 剧情总结\n${summaryText}\n\n`;
    if (gameTime) userPrompt += `## 当前游戏时间\n${gameTime}\n\n`;
    if (recentMain) userPrompt += `## 最近剧情\n${recentMain}\n\n`;
    const npcListStr = await _getNpcListForForum();
    if (npcListStr) userPrompt += npcListStr + '\n\n';
    userPrompt += `请生成${mediaType}内容。`;


    const maxRetries = (typeof Chat !== 'undefined' && Chat.isRetryDisabled && Chat.isRetryDisabled()) ? 1 : 3;
    let lastError = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (_abortCtrl?.signal.aborted) break;
      try {
        if (attempt > 1) {
          if (btn) {
            btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
            btn.title = `重试中(${attempt}/${maxRetries})...`;
          }
        }
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model, stream: false, temperature: 0.9, max_tokens: 16384,
        messages: [
          { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ]
          }),
          signal: _abortCtrl?.signal
        });

        if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
        const json = await resp.json();
        const content = (typeof Phone !== 'undefined' && Phone._phoneExtractContent) ? Phone._phoneExtractContent(json) : (json.choices?.[0]?.message?.content || '');
        // 用 Phone 的强容错解析（截断救援 / 尾逗号 / 逐条抠取兜底）；不可用时回退裸解析
        if (typeof Phone !== 'undefined' && Phone._parsePhoneJsonArray) {
          posts = Phone._parsePhoneJsonArray(content);
        } else {
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (!jsonMatch) throw new Error('AI返回格式不正确');
          posts = JSON.parse(jsonMatch[0]);
        }
        await _savePosts();
        _hideLoadingHint();
        _renderPosts();
        UI.showToast('已刷新');
        lastError = '';
        break;
      } catch(e) {
        if (e.name === 'AbortError') { lastError = ''; _hideLoadingHint(); break; }
        lastError = e.message;
        console.error(`[WorldVoice] refresh attempt ${attempt} failed:`, e);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (lastError) {
      UI.showToast('生成失败: ' + lastError, 4000);
      const phoneContainer = document.getElementById('phone-forum-posts');
      if (phoneContainer) phoneContainer.innerHTML = `<div style="text-align:center;color:var(--danger);padding:24px;font-size:12px"><div>生成失败：${Utils.escapeHtml(lastError)}</div><div style="opacity:0.6;margin-top:6px">已重试${maxRetries}次，可尝试再次刷新</div></div>`;
      console.error('[WorldVoice] 最终失败 systemPrompt:', systemPrompt);
      console.error('[WorldVoice] 最终失败 userPrompt:', userPrompt);
    }
    _hideLoadingHint();

    isGenerating = false;
    _abortCtrl = null;
    document.getElementById('wv-voice-fab')?.classList.remove('generating');
    if (btn) {
      btn.disabled = false;
      btn.title = '刷新';
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
    }
  }

function _renderLoadingSkeleton() {
    const hint = document.getElementById('wv-voice-loading-hint');
    const container = document.getElementById('wv-voice-posts');
    if (hint) hint.classList.remove('hidden');
    if (!container) return;
    container.innerHTML = Array.from({ length: 5 }).map(() => `
      <div class="wv-skeleton-card">
        <div class="wv-skeleton-row">
          <div class="wv-skeleton-avatar"></div>
          <div class="wv-skeleton-line user"></div>
          <div class="wv-skeleton-line time"></div>
        </div>
        <div class="wv-skeleton-line title"></div>
        <div class="wv-skeleton-line summary-1"></div>
        <div class="wv-skeleton-line summary-2"></div>
        <div class="wv-skeleton-tags">
          <div class="wv-skeleton-pill"></div>
          <div class="wv-skeleton-pill"></div>
        </div>
        <div class="wv-skeleton-meta-row">
          <div class="wv-skeleton-meta"></div>
          <div class="wv-skeleton-meta"></div>
          <div class="wv-skeleton-meta"></div>
        </div>
      </div>
    `).join('');
  }

  function _hideLoadingHint() {
    document.getElementById('wv-voice-loading-hint')?.classList.add('hidden');
  }

  // 渲染帖子列表
  function _renderPosts() {
    const container = document.getElementById('wv-voice-posts');
    if (!container || posts.length === 0) return;
    container.innerHTML = posts.map((p, i) => `
      <div class="wv-post-card" style="animation-delay:${Math.min(i * 0.04, 0.2)}s" onclick="WorldVoice.viewDetail(${i})" style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px;cursor:pointer">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <div style="width:28px;height:28px;border-radius:50%;background:${Utils.escapeHtml(p.avatar_color || '#888')};display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:bold;flex-shrink:0">${Utils.escapeHtml((p.username || '?')[0])}</div>
          <span style="font-size:13px;color:var(--text);font-weight:bold">${Utils.escapeHtml(p.username || '匿名')}</span>
          <span style="font-size:11px;color:var(--text-secondary);margin-left:auto">${Utils.escapeHtml(p.time || '')}</span>
        </div>
        <div style="font-size:14px;font-weight:bold;color:var(--text);margin-bottom:6px">${Utils.escapeHtml(p.title || '')}</div>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;margin-bottom:8px">${Utils.escapeHtml(p.summary || '')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${(p.tags || []).map(t => `<span class="wv-tag-pill" style="font-size:11px;background:var(--bg-tertiary);color:var(--accent);padding:2px 8px;border-radius:10px">${Utils.escapeHtml(t)}</span>`).join('')}</div>
        <div style="display:flex;gap:12px;font-size:11px;color:var(--text-secondary)">
          <span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>${_formatNum(p.views)}</span>
          <span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${_formatNum(p.likes)}</span>
          <span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${_formatNum(p.comments)}</span>
        </div>
      </div>
    `).join('');
  }

  function _formatNum(n) {
    if (!n) return '0';
    if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  // 查看帖子详情
  async function viewDetail(idx) {
    const post = posts[idx];
    if (!post || isGenerating) return;

    const listView = document.getElementById('wv-voice-list-view');
    const detailView = document.getElementById('wv-voice-detail-view');
    document.getElementById('wv-voice-detail-title').textContent = post.title;
    if (listView) listView.classList.add('wv-detail-entering-out');
    if (detailView) {
      detailView.classList.remove('hidden');
      detailView.style.display = 'flex';
      detailView.classList.remove('wv-detail-entering-in');
      void detailView.offsetWidth;
      detailView.classList.add('wv-detail-entering-in');
    }
    setTimeout(() => {
      if (listView) {
        listView.style.display = 'none';
        listView.classList.remove('wv-detail-entering-out');
      }
    }, 180);
    
    // 更新点赞数显示
    document.getElementById('wv-voice-like-count').textContent = post.likes || 0;
    try {
      const data = await DB.get('gameState', 'gaidenList');
      const list = data?.value || [];
      post._collected = list.some(item => item.type === 'worldvoice' && item.title === post.title && item.content === post.fullContent);
    } catch(e) {
      post._collected = !!post._collected;
    }
    const collectBtn = document.getElementById('wv-voice-collect-btn');
    const collectIcon = document.getElementById('wv-voice-collect-icon');
    if (collectBtn && collectIcon) {
      collectBtn.classList.toggle('active-collect', !!post._collected);
      collectBtn.style.color = post._collected ? 'var(--accent)' : 'var(--text-secondary)';
      collectIcon.setAttribute('fill', post._collected ? 'currentColor' : 'none');
    }

    // 如果已有缓存的详情，直接渲染
    if (post._detailLoaded) {
      currentDetail = post;
      _hideDetailLoading();
      _renderDetail();
      return;
    }

    // 没有缓存，生成详情
    currentDetail = post;
    post.fullContent = '';
    post._comments = [];
    _renderDetailLoading();

    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) { UI.showToast('请先配置模型'); return; }

    isGenerating = true;
    _abortCtrl = new AbortController();
    const wvPrompt = (typeof Phone !== 'undefined' && Phone._buildFullContext) ? await Phone._buildFullContext() : (Chat.getWorldviewPrompt() || '');
    const gameTime = _extractGameTime();

    const _mt = await _getMediaType();
    const _md = await _getMediaDesc();
    const _mb = _md ? `

载体说明：${_md}` : '';
    const { name: _un, onlineName: _uon } = await _getPlayerName();
    const _banNames2 = [_un, _uon].filter(Boolean);
    const _ub = _banNames2.length > 0
      ? `\n\n【禁止冒充玩家】玩家角色"${_banNames2.join('"和"')}"绝对不能作为帖子/动态发布者或评论者出现。评论者用户名不允许是"${_banNames2.join('"或"')}"，也不允许任何评论以"我"（指代玩家）的口吻发布。`
      : '\n\n【禁止冒充玩家】不要让玩家角色作为发布者或评论者。';
    const systemPrompt = `你是一个"${_mt}"内容生成器。用户给你一条帖子/动态的预览信息，请生成完整的正文和评论/回复区。${_mb}${_ub}

要求：
1. 正文长度贴合${_mt}的画风——该短的短、该长的长，不要一律写成千字小作文，像真的${_mt}用户在写
2. 评论/回复区8-12条，绝大多数评论者是虚构的路人用户（非NPC），仅允许1-2条由有设定的角色评论。风格多样（赞同、反对、吐槽、跑题等）。长度自然，有人一句话有人写一段。可以加入适量的"@某人"或引用前排回复的互动感，但不要每条都@。
3. 评论者的用户名和说话风格要符合世界观和${_mt}的氛围。角色评论时 username 直接填该角色在列表中的名字，语气符合角色性格
4. 评论时间必须依次晚于该帖子的发帖时间和已有的最新评论。请根据"当前游戏时间"智能安排回复节奏：
   - 若当前时间距离发帖/上一条评论很近，允许将新评论时间自然向后顺延（可合理超过当前游戏时间几分钟到几十分钟），模拟网友陆陆续续打字回复的过程。
   - 若当前时间比发帖/上一条评论晚了几个小时或几天，请将新评论散布在这段过去的空窗期内，并让最新几条紧贴当前游戏时间。
   - 严禁跳跃到不合逻辑的遥远未来。
5. 所有 time 都必须使用"YYYY.MM.DD 星期X HH:mm"格式，不要写成别的时间样式
6. 返回纯JSON，不要包含任何其他文字

JSON格式：
{"content":"帖子/动态完整正文","comments":[{"username":"用户名","avatar_color":"#颜色","content":"评论内容","time":"YYYY.MM.DD 星期X HH:mm","likes":数字}]}

${wvPrompt}`;

    const _radioDetail = (typeof Phone !== 'undefined' && Phone._radioDetailBlockForPost) ? (await Phone._radioDetailBlockForPost(post).catch(() => '')) : '';
        const _readingDetail = (typeof Phone !== 'undefined' && Phone._readingDetailBlockForPost) ? (await Phone._readingDetailBlockForPost(post).catch(() => '')) : '';
        const systemPromptFull = systemPrompt + (_radioDetail ? '\n\n' + _radioDetail : '') + (_readingDetail ? '\n\n' + _readingDetail : '');

    const npcListStr2 = await _getNpcListForForum();
    const userPrompt = `${gameTime ? `## 当前游戏时间\n${gameTime}\n\n` : ''}## 帖子预览\n标题：${post.title}\n摘要：${post.summary}\n发帖人（楼主）：${post.username}\n发帖时间：${post.time || '未知'}\n标签：${(post.tags || []).join('、')}${npcListStr2}\n\n请生成完整内容和评论区。注意：正文是以楼主"${post.username}"的口吻写的，语气和内容要符合这个角色的性格。评论区中如果楼主出现，必须是以作者身份回复读者（如答疑、补充），而不是以路人视角评论自己。`;

    const maxRetries = (typeof Chat !== 'undefined' && Chat.isRetryDisabled && Chat.isRetryDisabled()) ? 1 : 3;
    let lastError = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (_abortCtrl?.signal.aborted) break;
      try {
        if (attempt > 1) {
          _renderDetailLoading();
        }
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model, stream: false, temperature: 0.85, max_tokens: 16384,
        messages: [
          { role: 'system', content: systemPromptFull },
              { role: 'user', content: userPrompt }
            ]
          }),
          signal: _abortCtrl?.signal
        });

        if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
        const json = await resp.json();
        const content = (typeof Phone !== 'undefined' && Phone._phoneExtractContent) ? Phone._phoneExtractContent(json) : (json.choices?.[0]?.message?.content || '');
        let detail;
        if (typeof Phone !== 'undefined' && Phone._parsePhoneJsonObject) {
          detail = Phone._parsePhoneJsonObject(content);
        } else {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error('返回格式不正确');
          detail = JSON.parse(jsonMatch[0]);
        }
        post.fullContent = detail.content || '';
        post._comments = detail.comments || [];
        try {
          const _rnMap = await _buildNpcRealNameMap();
          _attachRealName(post, _rnMap);
          (post._comments || []).forEach(c => _attachRealName(c, _rnMap));
        } catch(_) {}
        post._detailLoaded = true;
        currentDetail = post;
        await _savePosts();
        _hideDetailLoading();
        _renderDetail();
        UI.showToast('内容加载完成');
        lastError = '';
        break;
      } catch(e) {
        if (e.name === 'AbortError') { lastError = ''; break; }
        lastError = e.message;
        console.error(`[WorldVoice] detail attempt ${attempt} failed:`, e);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (lastError) {
      _hideDetailLoading();
      document.getElementById('wv-voice-detail-content').innerHTML = `<div style="text-align:center;color:var(--danger);padding:40px">加载失败: ${Utils.escapeHtml(lastError)}</div>`;
    }
    isGenerating = false;
  }

  function _renderDetailLoading() {
    const hint = document.getElementById('wv-voice-detail-loading-hint');
    const content = document.getElementById('wv-voice-detail-content');
    const actions = document.getElementById('wv-voice-detail-actions');
    if (hint) hint.classList.remove('hidden');
    if (actions) actions.style.opacity = '0.4';
    if (!content) return;
    content.innerHTML = `
      <div class="wv-detail-skeleton">
        <div class="wv-detail-skeleton-header">
          <div class="wv-detail-skeleton-avatar"></div>
          <div class="wv-detail-skeleton-meta">
            <div class="wv-detail-skeleton-line name"></div>
            <div class="wv-detail-skeleton-line time"></div>
          </div>
        </div>
        <div class="wv-detail-skeleton-line title"></div>
        <div class="wv-detail-skeleton-line body-1"></div>
        <div class="wv-detail-skeleton-line body-2"></div>
        <div class="wv-detail-skeleton-line body-3"></div>
        <div class="wv-detail-skeleton-line body-4"></div>
        <div class="wv-detail-skeleton-tags">
          <div class="wv-detail-skeleton-pill"></div>
          <div class="wv-detail-skeleton-pill"></div>
        </div>
        <div class="wv-detail-skeleton-comments">
          ${Array.from({ length: 3 }).map(() => `
            <div class="wv-detail-skeleton-comment">
              <div class="wv-detail-skeleton-avatar"></div>
              <div class="wv-detail-skeleton-comment-body">
                <div class="wv-detail-skeleton-line line-1"></div>
                <div class="wv-detail-skeleton-line line-2"></div>
                <div class="wv-detail-skeleton-line line-3"></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function _hideDetailLoading() {
    document.getElementById('wv-voice-detail-loading-hint')?.classList.add('hidden');
    const actions = document.getElementById('wv-voice-detail-actions');
    if (actions) actions.style.opacity = '1';
  }

  // 渲染详情
  function _renderDetail() {
    if (!currentDetail) return;
    const d = currentDetail;
    let html = '';
    // 发帖人信息
    html += `<div class="wv-detail-section" style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <div style="width:36px;height:36px;border-radius:50%;background:${Utils.escapeHtml(d.avatar_color || '#888')};display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;font-weight:bold">${Utils.escapeHtml((d.username || '?')[0])}</div>
      <div><div style="font-size:14px;font-weight:bold;color:var(--text)">${Utils.escapeHtml(d.username || '匿名')}</div>
      <div style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(d.time || '')}</div></div>
    </div>`;
    // 正文
    html += `<div class="md-content wv-detail-section wv-detail-md" style="font-size:14px;line-height:1.8;color:var(--text);padding:0 0 20px 0;margin-bottom:0;animation-delay:0.03s">${Markdown.render(d.fullContent || '')}</div>`;
    // 标签
    if (d.tags?.length) {
      html += `<div class="wv-detail-section" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px;animation-delay:0.06s">${d.tags.map(t => `<span class="wv-tag-pill" style="font-size:11px;background:var(--bg-tertiary);color:var(--accent);padding:2px 8px;border-radius:10px">${Utils.escapeHtml(t)}</span>`).join('')}</div>`;
    }
    // 互动数据
    html += `<div class="wv-detail-section" style="display:flex;gap:16px;font-size:12px;color:var(--text-secondary);padding:12px 0;border-top:1px solid var(--border);margin-bottom:16px;animation-delay:0.09s">      <span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>${_formatNum(d.views)}</span><span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${_formatNum(d.likes)}</span><span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${_formatNum(d._comments?.length || 0)}</span></div>`;
    // 评论区
    if (d._comments?.length) {
      html += '<div class="wv-detail-section wv-detail-comments" style="animation-delay:0.12s"><div style="font-size:14px;font-weight:bold;color:var(--text);margin-bottom:12px">评论区</div>';
      d._comments.forEach((c, idx) => {
        html += `<div class="wv-comment-item" style="animation-delay:${0.14 + Math.min(idx * 0.03, 0.24)}s;display:flex;gap:10px;margin-bottom:14px;padding-bottom:14px">          <div style="width:28px;height:28px;border-radius:50%;background:${Utils.escapeHtml(c.avatar_color || '#666')};display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:bold;flex-shrink:0">${Utils.escapeHtml((c.username || '?')[0])}</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <span style="font-size:13px;font-weight:bold;color:var(--text)">${Utils.escapeHtml(c.username || '匿名')}</span>
              <span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(c.time || '')}</span>
            </div>
            <div class="md-content" style="font-size:13px;color:var(--text);line-height:1.6">${Markdown.render(c.content || '')}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${c.likes || 0}</div>
          </div>
        </div>`;
      });
    }
    document.getElementById('wv-voice-detail-content').innerHTML = html;
  }

  function backToList() {
    _hideDetailLoading();
    const detailView = document.getElementById('wv-voice-detail-view');
    const listView = document.getElementById('wv-voice-list-view');
    if (listView) {
      listView.style.display = 'flex';
      listView.classList.remove('wv-detail-entering-out');
      void listView.offsetWidth;
      listView.classList.add('wv-detail-entering-in');
    }
    if (detailView) {
      detailView.classList.remove('wv-detail-entering-in');
      detailView.classList.add('wv-detail-entering-out');
      setTimeout(() => {
        detailView.classList.add('hidden');
        detailView.style.display = 'none';
        detailView.classList.remove('wv-detail-entering-out');
        if (listView) listView.classList.remove('wv-detail-entering-in');
      }, 180);
    }
  }

  // 分享到主线（作为附件挂载）
  async function shareToMain() {
    if (!currentDetail) return;
    const mediaType = await _getMediaType();
    if (!await UI.showConfirm('分享到主线', `将这条${mediaType}内容作为附件挂载，下次发送消息时会一并带入上下文。`)) return;
    Chat.setWorldVoiceAttach({
      mediaType,
      title: currentDetail.title,
      content: currentDetail.fullContent,
      comments: currentDetail._comments || []
    });
    minimize();
    UI.showToast(`已挂载${mediaType}内容，发送消息时将一并带入`);
  }

  // 收藏帖子
  async function collectPost() {
    if (!currentDetail) return;
    const data = await DB.get('gameState', 'gaidenList');
    const list = data?.value || [];

    if (currentDetail._collected) {
      const idx = list.findIndex(item => item.type === 'worldvoice' && item.title === currentDetail.title && item.content === currentDetail.fullContent);
      if (idx !== -1) list.splice(idx, 1);
      await DB.put('gameState', { key: 'gaidenList', value: list });
      currentDetail._collected = false;
      const collectBtn = document.getElementById('wv-voice-collect-btn');
      const collectIcon = document.getElementById('wv-voice-collect-icon');
      if (collectBtn && collectIcon) {
        collectBtn.classList.remove('active-collect');
        collectBtn.style.color = 'var(--text-secondary)';
        collectIcon.setAttribute('fill', 'none');
      }
      UI.showToast('已取消收藏');
      return;
    }

    const saved = {
      id: 'wv_' + Utils.uuid().slice(0, 8),
      type: 'worldvoice',
      title: currentDetail.title,
      username: currentDetail.username,
      avatar_color: currentDetail.avatar_color,
      time: currentDetail.time,
      tags: currentDetail.tags,
      views: currentDetail.views,
      likes: currentDetail.likes,
      content: currentDetail.fullContent,
      comments: currentDetail._comments,
      sourceConv: Conversations.getCurrent(),
      sourceConvName: Conversations.getCurrentName(),
      savedAt: Date.now()
    };
    Gaiden.addToList(saved);
    list.unshift(saved);
    await DB.put('gameState', { key: 'gaidenList', value: list });
    currentDetail._collected = true;
    const collectBtn = document.getElementById('wv-voice-collect-btn');
    const collectIcon = document.getElementById('wv-voice-collect-icon');
    if (collectBtn && collectIcon) {
      collectBtn.classList.add('active-collect');
      collectBtn.style.color = 'var(--accent)';
      collectIcon.setAttribute('fill', 'currentColor');
    }
    UI.showToast('已收藏');
  }

  // 点赞（纯本地，增加计数）
  function likePost() {
    if (!currentDetail) return;
    currentDetail.likes = (currentDetail.likes || 0) + 1;
    document.getElementById('wv-voice-like-count').textContent = currentDetail.likes;
    const btn = document.getElementById('wv-voice-like-btn');
    if (btn) {
      btn.classList.add('active-like');
      btn.style.color = 'var(--danger)';
      btn.querySelector('svg')?.setAttribute('fill', 'currentColor');
    }
  }

  return {
    // 数据生成接口（手机论坛 App 使用）
    refresh,
    _getNpcListForForum,
    // 手机论坛接口
  getPosts: () => posts,
  getDetail: () => currentDetail,
  isRefreshing: () => isGenerating,
  abortRefresh: () => { if (_abortCtrl) _abortCtrl.abort(); },
  // 静默加载详情（只加载数据，不操作 DOM）
  // 参数可以是 index（在 posts 数组中）或 post 对象本身
  loadDetailSilent: async (idxOrPost) => {
    const post = (typeof idxOrPost === 'number') ? posts[idxOrPost] : idxOrPost;
    if (!post || post._detailLoaded) return post;
    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) throw new Error('请先配置功能模型');
    const wvPrompt = (typeof Phone !== 'undefined' && Phone._buildFullContext) ? await Phone._buildFullContext() : (Chat.getWorldviewPrompt() || '');
    const gameTime = _extractGameTime();
    const _mt = await _getMediaType();
    const _md = await _getMediaDesc();
    const _mb = _md ? `

载体说明：${_md}` : '';
    const { name: _un, onlineName: _uon } = await _getPlayerName();
    const _banNames2 = [_un, _uon].filter(Boolean);
    const _ub = _banNames2.length > 0
      ? `\n\n【禁止冒充玩家】玩家角色"${_banNames2.join('"和"')}"绝对不能作为帖子/动态发布者或评论者出现。评论者用户名不允许是"${_banNames2.join('"或"')}"，也不允许任何评论以"我"（指代玩家）的口吻发布。`
      : '\n\n【禁止冒充玩家】不要让玩家角色作为发布者或评论者。';
    const systemPrompt = `你是一个"${_mt}"内容生成器。用户给你一条帖子/动态的预览信息，请生成完整的正文和评论/回复区。${_mb}${_ub}

要求：
1. 正文长度贴合${_mt}的画风——该短的短、该长的长，不要一律写成千字小作文，像真的${_mt}用户在写
2. 评论/回复区8-12条，绝大多数评论者是虚构的路人用户（非NPC），仅允许1-2条由有设定的角色评论。风格多样（赞同、反对、吐槽、跑题等），长度自然，有人一句话有人写一段
3. 评论者的用户名和说话风格要符合世界观和${_mt}的氛围。角色评论时 username 直接填该角色在列表中的名字，语气符合角色性格
4. 评论时间必须晚于帖子的发帖时间、且不超过"当前游戏时间"；如果是挖坟老帖，评论可以横跨较长时间（早期评论紧贴发帖时间，近期评论紧贴当前游戏时间）
5. 所有 time 都必须使用"YYYY.MM.DD 星期X HH:mm"格式，不要写成别的时间样式
6. 【楼中楼】部分主楼评论可以带楼中楼回复（replies），模拟真实论坛的盖楼：有人反驳、有人附和、有人接话对线、有人歪楼。给其中 2-4 条「有讨论度」的主楼挂 replies（争议帖、高赞帖、有观点的帖），其余主楼不带 replies（或留空数组）。每条带 replies 的主楼配 2-5 条楼中楼。楼中楼也是路人为主，最多一两条 NPC。楼中楼的 time 要晚于其所在主楼、且符合上面的时间规则。replyToName 留空=直接回复楼主，填某人网名=回复楼里那个人（让同一楼里几个人来回对线）。楼中楼只需 username/isNpc/content/time/likes/replyToName，不带其他字段。
7. 返回纯JSON，不要包含任何其他文字

JSON格式：
{"content":"帖子/动态完整正文","comments":[{"username":"用户名","avatar_color":"#颜色","content":"评论内容","time":"YYYY.MM.DD 星期X HH:mm","likes":数字,"replies":[{"username":"回复者网名","isNpc":false,"content":"楼中楼回复","time":"YYYY.MM.DD 星期X HH:mm","likes":数字,"replyToName":""}]}]}

${wvPrompt}`;
    const npcListStr3 = await _getNpcListForForum();
    // 若这条帖子来自「书架命中」搜索，注入这本书的信息，让正文/评论都围绕这本书展开
    let _bookBlock = '';
    if (post._bookRef && post._bookRef.title) {
      const _br = post._bookRef;
      const _brCats = Array.isArray(_br.category) ? _br.category.filter(Boolean).join('、') : '';
      _bookBlock = `\n\n## 这条帖子讨论的书\n本帖是关于小说《${_br.title}》的讨论。正文和评论都要紧扣这本书的真实内容来写，符合真实书友讨论的氛围（书评/考据/磕CP/吐槽/安利/对线等），不要跑题到别的作品。\n书名：${_br.title}\n作者：${_br.author || '佚名'}${_brCats ? '\n题材：' + _brCats : ''}\n简介：${_br.intro || '（无）'}`;
      // 用户读到的最新进度 + 末尾正文（让讨论能聊到真实读到的地方：催更/剧情进展/名场面）
      const rc = _br.readChapter;
      if (rc) {
        const _chTitle = rc.title ? `《${rc.title}》` : '';
        const _progress = (typeof rc.idx === 'number')
          ? `读者目前追到第 ${rc.idx} 章${_chTitle}${rc.total ? `（全书共 ${rc.total} 章）` : ''}`
          : `读者已读完${_chTitle}`;
        let _rcBlock = `\n\n## 读者当前进度（重要）\n${_progress}。书友们的讨论可以聊到这个进度（催更、追连载、剧情进展、最新一章的名场面/转折），但【绝不能剧透或编造这个进度之后还没发生的剧情】。`;
        if (rc.summary) _rcBlock += `\n最新一章概述：${rc.summary}`;
        if (rc.tail) _rcBlock += `\n最新一章末尾原文（节选，供讨论贴合真实内容）：\n「${rc.tail}」`;
        _bookBlock += _rcBlock;
      }
    }
    // 若这条帖子来自「电台命中」搜索，注入这档电台的资料 + 那期实际播出内容，让正文/评论贴合真实节目
    if (post._stationRef && post._stationRef.name) {
      const _sr = post._stationRef;
      _bookBlock += `\n\n## 这条帖子讨论的电台\n本帖是关于电台节目「${_sr.name}」的讨论。正文和评论都要紧扣这档电台的真实内容来写，符合真实电台听众讨论的氛围（听后感/安利/吐槽主播/讨论某段来电或话题/催更求重播等），不要跑题到别的节目。\n电台名：${_sr.name}${_sr.fm ? '\nFM 频率：' + _sr.fm : ''}${_sr.concept ? '\n频道核心概念：' + _sr.concept : ''}${_sr.showName ? '\n最近一期节目：' + _sr.showName : ''}`;
      if (_sr.digest) {
        _bookBlock += `\n这期实际播出的内容：${_sr.digest}\n讨论可以聊到这期内容，但【涉及节目情节时要贴合上面的真实内容，绝不能编造没播过的情节】。`;
      } else if (_sr.intro) {
        _bookBlock += `\n这期节目预告：${_sr.intro}\n（听众可能还没听到具体内容，讨论以预告和期待为主，不要编造具体播出情节。）`;
      }
    }
    // 若这条帖子来自「影视命中」搜索，注入这部作品的资料 + 实际剧情，让正文/评论贴合真实作品
    if (post._workRef && post._workRef.title) {
      const _wr = post._workRef;
      const _wkKind = _wr.kind === 'tv' ? '电视剧' : _wr.kind === 'anime' ? '动漫' : '电影';
      const _wkCast = Array.isArray(_wr.cast) ? _wr.cast.filter(Boolean).join('、') : '';
      const _wkStaff = [
        _wr.director ? '导演/监督：' + _wr.director : '',
        _wr.screenwriter ? '编剧/脚本：' + _wr.screenwriter : ''
      ].filter(Boolean).join('，');
      _bookBlock += `\n\n## 这条帖子讨论的影视作品\n本帖是关于${_wkKind}《${_wr.title}》的讨论。正文和评论都要紧扣这部作品的真实内容来写，符合真实观众讨论的氛围（剧评/影评/磕CP/夸演技或作画/吐槽编剧或结局/讨论某段剧情等），不要跑题到别的作品。\n片名：${_wr.title}${_wr.genre ? '\n类型：' + _wr.genre : ''}${_wkStaff ? '\n' + _wkStaff : ''}${_wkCast ? '\n主演/CV：' + _wkCast : ''}\n简介：${_wr.intro || '（无）'}`;
      if (_wr.synopsis) {
        _bookBlock += `\n剧情梗概：${_wr.synopsis}\n讨论可以聊到这些剧情，但【涉及具体情节时要贴合上面的真实内容，绝不能编造作品里没有的情节或乱给结局】。`;
      }
    }
    const userPrompt = `${gameTime ? `## 当前游戏时间\n${gameTime}\n\n` : ''}## 帖子预览\n标题：${post.title}\n摘要：${post.summary}\n发帖人（楼主）：${post.username}\n发帖时间：${post.time || '未知'}\n标签：${(post.tags||[]).join('、')}${_bookBlock}${npcListStr3}\n\n请生成完整内容和评论区。注意：正文是以楼主"${post.username}"的口吻写的，语气和内容要符合这个角色的性格。评论区中如果楼主出现，必须是以作者身份回复读者（如答疑、补充），而不是以路人视角评论自己。`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, stream: false, temperature: 0.85, max_tokens: 16384, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
    });
    if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
    const json = await resp.json();
    const content = (typeof Phone !== 'undefined' && Phone._phoneExtractContent) ? Phone._phoneExtractContent(json) : (json.choices?.[0]?.message?.content || '');
    let detail;
    if (typeof Phone !== 'undefined' && Phone._parsePhoneJsonObject) {
      detail = Phone._parsePhoneJsonObject(content);
    } else {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('返回格式不正确');
      detail = JSON.parse(jsonMatch[0]);
    }
    post.fullContent = detail.content || '';
    post._comments = detail.comments || [];
    try {
      const _rnMap = await _buildNpcRealNameMap();
      _attachRealName(post, _rnMap);
      (post._comments || []).forEach(c => _attachRealName(c, _rnMap));
    } catch(_) {}
    post._detailLoaded = true;
    currentDetail = post;
    await _savePosts();
    return post;
  },
  };
})();