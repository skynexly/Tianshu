/**
 * 聊天系统 — 核心
 * 消息树形存储，支持分支/回溯
 */
const Chat = (() => {
  let messages = []; // 当前分支的线性消息列表
  let currentBranchId = 'main';
  let roundCount = 0;
  let _aiAvatarUrl = ''; // 当前单人对话的 AI 头像（非单人为空）
  let _onlineNpcAvatarMap = {}; // 心动模拟线上小气泡 NPC 头像缓存：name/alias -> url
  let _currentWvName = ''; // 当前世界观名（给气泡时间戳用）

  // 异步刷新当前对话的 AI 头像缓存，并刷新已有消息上的头像
  async function _refreshOnlineNpcAvatarMap() {
    const map = {};
    try {
      const conv = (typeof Conversations !== 'undefined') ? Conversations.getList().find(c => c.id === Conversations.getCurrent()) : null;
      const wvId = conv?.worldviewId || conv?.singleWorldviewId || conv?.singleCharSourceWvId || (document.body.getAttribute('data-worldview') === '心动模拟' ? 'wv_heartsim' : '');
      if (!wvId) { _onlineNpcAvatarMap = {}; return; }
      const wv = await DB.get('worldviews', wvId);
      const wvs = wv ? [wv] : [];
      // 兜底：当前对话世界观未命中/数据旧时，遍历全部世界观找同名 NPC
      try {
        const all = await DB.getAll('worldviews');
        all.forEach(x => { if (x && x.id !== wvId) wvs.push(x); });
      } catch(_) {}
      if (wvs.length === 0) { _onlineNpcAvatarMap = {}; return; }
      const avatarRows = await DB.getAll('npcAvatars');
      const avatarById = {};
      avatarRows.forEach(a => { if (a && a.id) avatarById[a.id] = a.avatar || ''; });
      const addNpc = (n) => {
        if (!n) return;
        const url = avatarById[n.id] || n.avatar || '';
        const names = [n.name, ...(String(n.aliases || '').split(/[,，、\s]+/))].map(s => String(s || '').trim()).filter(Boolean);
        names.forEach(name => { if (url || !map[name]) map[name] = url; });
      };
      wvs.forEach(wvItem => {
        if (wvItem.iconImage && !map['心动模拟客服']) map['心动模拟客服'] = wvItem.iconImage;
        (wvItem.globalNpcs || []).forEach(addNpc);
        (wvItem.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(addNpc)));
      });
    } catch(_) {}
    _onlineNpcAvatarMap = map;
  }

  async function refreshOnlineChatAvatars() {
    await _refreshOnlineNpcAvatarMap();
    document.querySelectorAll('.online-chat-bubble[data-npc-name]').forEach(bubble => {
      const name = bubble.dataset.npcName || '';
      const initial = bubble.dataset.avatarChar || (name[0] || '?');
      const header = bubble.querySelector('.online-chat-header');
      if (!header) return;
      const oldAvatar = header.querySelector('.online-chat-avatar');
      const url = _onlineNpcAvatarMap[name] || '';
      const html = url
        ? `<img src="${Utils.escapeHtml(url)}" class="online-chat-avatar" style="object-fit:cover">`
        : `<div class="online-chat-avatar">${Utils.escapeHtml(initial)}</div>`;
      if (oldAvatar) oldAvatar.outerHTML = html;
      else header.insertAdjacentHTML('afterbegin', html);
    });
  }

  // 异步刷新当前对话的 AI 头像缓存，并刷新已有消息上的头像
  async function refreshAiAvatar() {
    await _refreshOnlineNpcAvatarMap();
    let url = '';
    try {
      const conv = (typeof Conversations !== 'undefined') ? Conversations.getList().find(c => c.id === Conversations.getCurrent()) : null;
      if (conv && conv.isSingle && conv.singleCharType && conv.singleCharId) {
        if (conv.singleCharType === 'card') {
          const card = await DB.get('singleCards', conv.singleCharId);
          url = card?.avatar || '';
        } else if (conv.singleCharType === 'npc') {
          try {
            const r = await DB.get('npcAvatars', conv.singleCharId);
            if (r && r.avatar) url = r.avatar;
          } catch(e) {}
          if (!url) {
            const wvId = conv.singleCharSourceWvId || conv.singleWorldviewId;
            if (wvId) {
              const wv = await DB.get('worldviews', wvId);
              if (wv) {
                outer: for (const r of (wv.regions || [])) {
                  for (const f of (r.factions || [])) {
                    for (const n of (f.npcs || [])) {
                      if (n.id === conv.singleCharId) { url = n.avatar || ''; break outer; }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch(e) {}
    _aiAvatarUrl = url;
    // 刷新已存在消息的头像
    document.querySelectorAll('img[data-ai-avatar="1"]').forEach(img => {
      if (url) {
        img.src = url;
        img.style.display = 'block';
      } else {
        img.style.display = 'none';
      }
    });
    // 没头像的 assistant 消息现在补一个（首次进入还没缓存好就渲染了）
    if (url) {
      document.querySelectorAll('.chat-msg.assistant:not([data-has-avatar])').forEach(el => {
        _wrapAssistantWithAvatar(el, url);
      });
    }
    // 同时回填线上 NPC 气泡头像（_onlineNpcAvatarMap 已在上面填好）
    document.querySelectorAll('.online-chat-bubble[data-npc-name]').forEach(bubble => {
      const name = bubble.dataset.npcName || '';
      const initial = bubble.dataset.avatarChar || (name[0] || '?');
      const header = bubble.querySelector('.online-chat-header');
      if (!header) return;
      const avatarUrl = _onlineNpcAvatarMap[name] || '';
      if (!avatarUrl) return; // 没有头像就保持原样（初始字母）
      const oldAvatar = header.querySelector('.online-chat-avatar');
      const html = `<img src="${Utils.escapeHtml(avatarUrl)}" class="online-chat-avatar" style="object-fit:cover">`;
      if (oldAvatar) oldAvatar.outerHTML = html;
      else header.insertAdjacentHTML('afterbegin', html);
    });
  }

  // 给 assistant 消息包一层头像 wrapper（如果还没包）
  function _wrapAssistantWithAvatar(msgEl, url) {
    // 单人模式不再在 AI 大气泡外挂头像（顶栏已有头像，气泡内可能还有线上消息头像，三重头像太挤）
    return;
  }
  let isStreaming = false;
  let totalTokenEstimate = 0;
  let abortController = null; // 用于中止请求
  let lastUserContent = ''; // 保存最后发送的内容，用于取消时恢复
  let _cancelledMsgId = null; // 被取消的用户消息ID，send()流程会检查它来清理
  let _currentAiMsgId = null; // 当前正在生成的AI消息ID，取消时用于精确定位
  let _currentAiMsg = null;   // 当前正在生成的AI消息对象引用，取消时用于保留已流式内容
  let _currentAiMsgEl = null; // AI消息DOM元素，取消时用于去掉光标

  // 世界观prompt（由配置加载）
  let worldviewPrompt = '';

  // 输出格式指令
  const OUTPUT_FORMAT_PROMPT = `你的回复必须严格遵循以下格式。

**括号内为解释说明，不要将括号内内容输出到正文**。

第一部分 — 正文叙述（约800字，直接开始讲故事，不要在开头写地点时间等信息，这些统一放到第三部分的状态面板里）

如果剧情中有阅读文本，例如书籍段落、纸条、公告、资料等，可以使用引号符号包裹（>）

---

第二部分 — 系统信息（必须用代码块包裹）：

\`\`\`
新获得物品
（例如"雨伞：普通的粉色太阳伞，遮风挡太阳。"）
（每个物品写一行，如果没有新物品，则写"无"）
\`\`\`
\`\`\`
当前相关角色
（角色姓名，每行写一个，若无则写无）
（此处需要列出在场角色和提到的角色；禁止写“NPC”作为姓名占位）
\`\`\`

---

第三部分 — 状态面板（必须紧跟在第二部分之后，用 \`\`\`status 代码块包裹，每轮必须完整输出，未发生变化的字段必须照抄上一轮的内容保持完整）：

\`\`\`status
地点：（当前所在地点，格式为"大地点｜小地点"，如"天枢城·东区｜某街道·某建筑·某房间"；必须使用世界观实际地名，禁止照抄此示例）
时间：（当前时间，格式为"YYYY年M月D日 星期X HH:MM"，如"2065年3月27日 星期五 15:02"；根据剧情推进自然流逝，禁止照抄此示例）
天气：（当前天气和温度，如"晴朗 22℃"；只写天气和温度，不写体感）
场景：（当前场景的环境描写，1-3句话，如"夜风将窗帘吹得噼啪作响，室内只开了一盏台灯，桌上有半杯冷掉的咖啡。"）
用户角色-{{user}}-衣着：（用户角色当前穿的衣服饰品，如"白色睡裙，裙摆坠着荷叶边；颈部一条蓝宝石项链"；字段中的{{user}}应替换为用户角色姓名）
用户角色-{{user}}-姿势：（用户角色当前的姿势动作，如"懒懒躺在沙发上，手中半瓶酒"；字段中的{{user}}应替换为用户角色姓名）
角色-<角色名>-衣着：（该角色当前衣着，如"一袭玄色长袍，腰间挂着青玉佩"）
角色-<角色名>-姿势：（该角色当前姿势，如"坐在另一侧沙发上，手持长烟杆"）
\`\`\`

状态面板规则：
1. **每轮都必须完整输出 status 代码块**，即使所有字段都没变化。未变化的字段直接抄上一轮的内容。
2. **地点**必须用世界观实际地区名，不要编造；格式为"大地点｜小地点"，用全角竖线分隔。根据{{user}}的身份和剧情决定地点，禁止照抄示例中的地名。
3. **时间**格式为"YYYY年M月D日 星期X HH:MM"，根据剧情推进自然流逝。
4. **天气**只写天气和温度，不写体感。
5. 在场的每个角色各写两行（衣着+姿势），格式严格为 \`角色-<名字>-衣着：xxx\` 和 \`角色-<名字>-姿势：xxx\`。不在场的角色不要写。为兼容旧格式，系统仍可识别 \`NPC-<名字>-衣着/姿势\`，但你本轮输出应优先使用 \`角色-<名字>-...\`。
6. 用户角色的衣着/姿势格式为 \`用户角色-<名字>-衣着：xxx\` 和 \`用户角色-<名字>-姿势：xxx\`，其中 \`<名字>\` 必须替换为用户角色姓名；禁止写成"玩家衣着/玩家姿势"。
7. 场景描写只写当前所处环境，不要包含剧情推进。
8. 若某字段实在没有内容（如单人独处没有其他角色），该行可省略，但不要写"无"。
9. **称呼规则**：正文、系统信息、status 内容和追加代码块里，都不要用"玩家""NPC"来称呼角色；必须直接使用角色姓名。
10. **示例中所有括号内的内容都是格式说明，不要输出括号本身**。示例中的地名、人名、时间、衣着描写等均为占位示例，必须替换为当前剧情的实际内容。

三个部分之间必须用 --- 分隔。

如果需要输出剧情外的提示文字（如引导说明、系统提示等），必须放在 status 代码块之前。`;


  // 线上消息气泡格式（可选，仅在用户启用对话设置中"线上消息气泡"开关时注入）
  const ONLINE_CHAT_BLOCK_PROMPT = `

【可选追加：线上消息气泡】
当剧情中出现 NPC 通过手机/IM/社交软件给用户发送线上消息时，可以在 status 代码块之后追加一个 \`\`\`chat 代码块，前端会将其渲染为 QQ/微信式的线上消息气泡。

格式（JSON 数组，每条消息含 npc/text/time）：
\`\`\`chat
[
  {"npc": "角色名", "text": "消息内容", "time": "YYYY.MM.DD 星期X HH:mm"},
  {"npc": "角色名", "text": "下一条消息", "time": "YYYY.MM.DD 星期X HH:mm"}
]
\`\`\`

使用规则：
1. 仅当剧情中确实出现"线上消息"时才输出此代码块。日常对话、面对面交流、电话通话等不要使用此格式。
2. 没有线上消息的轮次完全不要输出 \`\`\`chat 块（不是输出空数组，是整个块都不要写）。
3. text 用 NPC 实际发送的内容，简短自然，符合 IM 聊天习惯。
4. time 是消息发出时间，格式必须为 "YYYY.MM.DD 星期X HH:mm"（与 status 中的时间同一套写法，论坛/好友圈也用这个格式）。可与 status 中的时间略有差异（消息可能发出前几分钟）。
5. npc 必须使用角色真名，与正文/status 中的名字一致。
6. 当输出了 \`\`\`chat 块时，**消息的具体内容只写在 chat 块里，正文不要复述**。正文需要简短交代"发送/收到了消息"这个动作或场景本身（例如"她拿起手机，给他发了一条消息"/"手机震了一下，是来自{{NPC}}的消息"），但不要把消息原文也写进正文，避免一条消息出现两次。
7. **chat 块里只放 NPC 发出的消息，不要包含{{user}}的消息**。用户的消息由用户自己输入，AI 既不要复述也不要替用户写入 chat 块。
8. **chat 块只填本轮新产生的线上消息，不要把历史轮次已经出现过的消息再填一遍**。历史消息前端已经渲染过，重复输出会导致用户看到同一条消息出现多次。`;


  /**
 * 加载对话历史
 */
  // 设置聊天输入区可用性（无对话时禁用，避免发送报错）
  function _setChatInputEnabled(enabled) {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('btn-send');
    if (input) {
      input.disabled = !enabled;
      input.style.opacity = enabled ? '' : '0.5';
      input.placeholder = enabled ? '输入你的行动...' : '请先选择对话';
    }
    if (sendBtn) {
      sendBtn.disabled = !enabled;
      sendBtn.style.opacity = enabled ? '' : '0.5';
      sendBtn.style.pointerEvents = enabled ? '' : 'none';
    }
  }

  async function loadHistory(conversationId) {
    // 切对话时清掉上一个对话残留的心动模拟开场动画状态
    try {
      if (typeof HeartSimIntro !== 'undefined' && HeartSimIntro.cancel) {
        HeartSimIntro.cancel();
      }
    } catch(_) {}
    // 切换对话级背景图（对话有自己的背景就用它，否则回退到主题级）
    try {
      const _convForBg = (conversationId === null)
        ? null
        : Conversations.getList().find(c => c.id === (conversationId || Conversations.getCurrent()));
      if (typeof Theme !== 'undefined' && Theme.setConvBgOverride) {
        Theme.setConvBgOverride(_convForBg?.convBgImage || '');
      }
    } catch(_) {}
    const container = document.getElementById('chat-messages');

    // 淡出动画
    if (container) {
      container.classList.add('fading-out');
      await new Promise(r => setTimeout(r, 150));
      container.classList.remove('fading-out');
    }

    // 如果没有当前对话，进入空态：清空消息区、显示提示、禁用输入框
    const convIdForCheck = conversationId === null ? null : (conversationId || Conversations.getCurrent());
    if (!convIdForCheck) {
      messages = [];
      roundCount = 0;
      currentBranchId = 'main';
      _aiAvatarUrl = '';
      _currentWvName = '';
      if (container) {
        container.innerHTML = `
          <div id="chat-empty-tip" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);gap:14px;padding:32px 24px;text-align:center">
            <svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <div style="font-size:16px;color:var(--text)">请先选择对话</div>
            <div style="font-size:12px;line-height:1.6">从侧边栏选择一个对话<br>或点击「新建对话」开始</div>
          </div>`;
      }
      _setChatInputEnabled(false);
      // 清空状态栏 UI
      try { if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(null); } catch(_) {}
      // 清掉手机操作日志（无对话状态下不该保留任何残留）
      try { if (typeof Phone !== 'undefined' && Phone.reloadActionLog) Phone.reloadActionLog(); } catch(_) {}
      // 清顶栏标题
      try {
        const titleEl = document.getElementById('topbar-title');
        if (titleEl) titleEl.textContent = '未选择对话';
      } catch(_) {}
      return;
    }

    if (conversationId) currentBranchId = 'main';
    const convId = conversationId || Conversations.getCurrent();
    _setChatInputEnabled(true);

    // 切对话加载指示器：在 DB 读取 + 渲染期间显示，避免空白
    if (container) {
      container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);gap:8px;font-size:13px;opacity:0.6">
        <div class="typing-indicator"><span></span><span></span><span></span></div>
      </div>`;
    }

    const allMsgs = await DB.getAllByIndex('messages', 'conversationId', convId);
  // 按分支过滤（已经按对话过滤过了，老数据迁移补了 'default'）
  messages = allMsgs
    .filter(m => m.branchId === currentBranchId)
.sort((a, b) => a.timestamp - b.timestamp);
    roundCount = Math.floor(messages.filter(m => m.role === 'user').length);
    // 在渲染前先把 AI 头像缓存刷掉，避免新对话渲染时拿到旧头像
    _aiAvatarUrl = '';
    // 在渲染前先把当前世界观名拿到，气泡 meta 行要用
    try {
      let _wvForName = null;
      const _convForName = Conversations.getList().find(c => c.id === convId);
      if (_convForName && _convForName.isSingle && _convForName.singleWorldviewId) {
        _wvForName = await DB.get('worldviews', _convForName.singleWorldviewId);
      } else {
        _wvForName = await Worldview.getCurrent();
      }
      _currentWvName = (_wvForName && _wvForName.name) ? _wvForName.name : '';
      // 天枢城专属：设置 body 标签 + 用当前 region 预热（避免加载已有对话时误触发）
      try {
        if (window.TianshuFX) TianshuFX.setBodyTag(_currentWvName);
        if (window.TianshuRegion) {
          TianshuRegion.reset();
          const s = Conversations.getStatusBar();
          if (s && s.region) TianshuRegion.silentInit(s.region);
        }
      } catch(_) {}
      // 单人卡 + 无世界观：套心动模拟皮（视觉壳）
      try {
        const _conv = Conversations.getList().find(c => c.id === convId);
        const _isSingle = !!(_conv && _conv.isSingle);
        const _wvForSkin = (_conv?.singleWorldviewId || _conv?.worldviewId || '__default_wv__');
        const _isDefaultWv = !_wvForSkin || _wvForSkin === '__default_wv__';
        if (_isSingle && _isDefaultWv) {
          document.body.setAttribute('data-skin', 'single-default');
        } else {
          document.body.removeAttribute('data-skin');
        }
        // 切对话时清头像匹配缓存
        if (typeof StatusBar !== 'undefined' && StatusBar._clearNpcAvatarCache) {
          StatusBar._clearNpcAvatarCache();
        }
        // 单人卡皮下：强制 render 一次（即使 status 为 null，render 内部会兜底成空壳显示占位）
        if (_isSingle && _isDefaultWv && typeof StatusBar !== 'undefined' && StatusBar.refreshFromConv) {
          StatusBar.refreshFromConv();
        }
      } catch(_) {}
    } catch(e) { _currentWvName = ''; }
    // 只渲染非隐藏的消息
    renderAll();
    updateTokenCount();
    // 切换对话/刷新页面时，自动滚到最底部（先滚一次占位）
    if (messages.length > 0) scrollToBottom();
    // 切换对话后，从该对话的 phoneData 读回未发送的手机操作日志
    try { if (typeof Phone !== 'undefined' && Phone.reloadActionLog) Phone.reloadActionLog(); } catch(_) {}
    // 切换对话后，刷新底部快速切换栏（不同世界观可见的面具不同）
    try { renderQuickSwitches(); } catch(_) {}
    // 异步加载 AI 头像，加载好后回填到已渲染的消息
    refreshAiAvatar();

  // 淡入动画
  if (container) {
    container.classList.add('fading-in');
    await new Promise(r => setTimeout(r, 250));
    container.classList.remove('fading-in');
  }
  // 淡入结束后再补一次：此时 markdown 已渲染、图片已部分加载，scrollHeight 更准
  if (messages.length > 0) scrollToBottom();

// 新对话开场消息：先世界观 startMessage，再单人卡 firstMes（方案A：叠加播放）
    if (messages.length === 0) {
      // 心动模拟开场动画优先（仅心动模拟世界观 + 没历史 + 没 introDone）
      try {
        if (typeof HeartSimIntro !== 'undefined') {
          const ok = await HeartSimIntro.shouldTrigger();
          if (ok) {
            await HeartSimIntro.start();
            return; // 开场动画接管，不走默认 startMessage 逻辑
          }
        }
      } catch(e) { console.warn('[HeartSimIntro] 触发失败', e); }
      try {
        let wv = null;
        const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
        if (conv && conv.isSingle && conv.singleWorldviewId) {
          // 单人模式只在挂世界观且启用了开场设定时才发世界观开场消息
          if (conv.singleEnableStartPlot) {
            wv = await DB.get('worldviews', conv.singleWorldviewId);
          }
        } else if (!conv || !conv.isSingle) {
          wv = await Worldview.getCurrent();
        }
        _currentWvName = (wv && wv.name) ? wv.name : '';
        const _appendOpening = async (content, opts) => {
          if (!content || !content.trim()) return;
          const welcomeMsg = {
            id: Utils.uuid(),
            role: 'assistant',
            content,
            conversationId: convId,
            branchId: currentBranchId,
            parentId: null,
            timestamp: Utils.timestamp()
          };
          await DB.put('messages', welcomeMsg);
          messages.push(welcomeMsg);
          // 天枢城专属：第一条 startMessage 走打字动画
          const useTyping = opts && opts.typing && window.TianshuFX
            && TianshuFX.isTianshuWorldview(wv);
          if (useTyping) {
            // 等侧边栏收起动画结束再开始打字（侧边栏 transition 约 300ms）
            await new Promise(r => setTimeout(r, 1200));
            const el = appendMessage(welcomeMsg, true, true);  // 占位模式
            const bodyEl = el && el.querySelector('.msg-body');
            if (bodyEl) {
              await TianshuFX.typeMessage(bodyEl, content);
            } else {
              // 兜底：直接渲染
              const el2 = appendMessage(welcomeMsg);
            }
          } else {
            appendMessage(welcomeMsg);
          }
        };
        // 1. 世界观 startMessage（系统旁白/铺垫）
        const sm = wv && wv.startMessage;
        if (sm && sm.trim()) await _appendOpening(sm, { typing: true });
        // 2. 单人卡 firstMes（角色第一句话）
        if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
          try {
            const card = await SingleCard.get(conv.singleCharId);
            if (card && card.firstMes && card.firstMes.trim()) {
              await _appendOpening(card.firstMes);
            }
          } catch(_) {}
        }
      } catch(e) { console.warn('[Chat] startMessage加载失败', e); }
    }
  }

  /**
   * 发送消息
   */
  async function send() {
    try { GameLog.log('info', `send()被调用, isStreaming=${isStreaming}`); } catch(e) {}
    // 没有当前对话 → 拦截
    if (!Conversations.getCurrent()) {
      UI.showToast('请先选择对话或新建对话', 1800);
      return;
    }
    // 心动模拟开场动画进行中 → 拦截
    if (typeof HeartSimIntro !== 'undefined' && HeartSimIntro.isActive()) {
      UI.showToast('请先完成开场流程', 1500);
      return;
    }
    if (isStreaming) {
      GameLog.log('warn', '上一次请求仍在进行中，如果卡住请刷新页面');
      return;
    }
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    // 更新按钮状态为发送中
    updateSendButton(true);

    GameLog.log('info', `发送: ${text.substring(0, 50)}...`);

    // 保存用户发送的内容，用于取消时恢复
    lastUserContent = text;

    // 创建中止控制器
abortController = new AbortController();
const requestController = abortController; // 本轮请求的稳定引用，避免全局 abortController 被置空后重试读 .signal 报错
let wasCancelled = false;

isStreaming = true;
    _resetFollowBottom(); // 新一轮开始：重置跟随状态，无论上轮玩家滑到了哪里
    const _streamConvId = Conversations.getCurrent();
    try { Conversations.setStreaming && Conversations.setStreaming(_streamConvId, true); } catch(_) {}

    try {
    let userContent = text;
    let userContentForAPI = text;

    // 心动模拟：开场动画刚结束的第一条用户消息，追加开场剧情提示
    try {
      if (typeof HeartSimIntro !== 'undefined' && HeartSimIntro.onFirstUserMessage) {
        const extra = await HeartSimIntro.onFirstUserMessage(text);
        if (extra && typeof extra === 'string' && extra !== text) {
          userContentForAPI = extra;
        }
      }
    } catch(_) {}

    // 手机操作日志快照：flush 出来存到本轮 userMsg 上（v566+ 方案B）
    // 仅为"最新一条 user 消息"持久化手机操作快照，重写最新一条时还能恢复。
    // 历史消息不会重复注入手机操作，AI 不会反复提。
    let _pendingPhoneLog = null;
    try {
      if (typeof Phone !== 'undefined' && Phone.flushActionLog) {
        const phoneLog = Phone.flushActionLog();
        if (phoneLog.length > 0) _pendingPhoneLog = phoneLog;
      }
    } catch(_) {}

    // 心动模拟·回家系统通知注入（一次性，注入后清空）
    // 触发场景一：用户在客服那边发"回家"且通关条件达成 → 通知 AI 开始演绎传送倒计时
    // 触发场景二：通关条件刚刚满足（但用户尚未操作） → 通知 AI 提醒用户去客服发"回家"
    try {
      if (typeof Phone !== 'undefined' && Phone.consumeHsHomeNotice) {
        const hsNotice = await Phone.consumeHsHomeNotice();
        if (hsNotice) {
          const noticeText = '\n\n' + hsNotice;
          if (typeof userContentForAPI === 'string') {
            userContentForAPI = userContentForAPI + noticeText;
          } else {
            userContentForAPI[0].text += noticeText;
          }
        }
      }
    } catch(_) {}

    // 如果有图片，构建multimodal content
    if (pendingImages.length > 0) {
      userContentForAPI = [
        { type: 'text', text: text }
      ];
      pendingImages.forEach(img => {
        userContentForAPI.push({
          type: 'image_url',
          image_url: { url: img.base64 }
        });
      });
      userContent = text + `\n[附加了${pendingImages.length}张图片]`;
    }
    // 附加记忆
    if (pendingMemories.length > 0) {
      const memText = pendingMemories.map(m =>
        `[手动附加记忆] ${m.title}: ${m.content}`
      ).join('\n');
      if (typeof userContentForAPI === 'string') {
        userContentForAPI = userContentForAPI + '\n\n' + memText;
      } else {
        userContentForAPI[0].text += '\n\n' + memText;
      }
      userContent = (typeof userContent === 'string' ? userContent : text) +
        `\n[附加了${pendingMemories.length}条记忆]`;
    }

    // 附加文件（纯文本）
    if (pendingFiles.length > 0) {
      const fileText = pendingFiles.map(f =>
        `<file name="${f.name}">\n${f.content}\n</file>`
      ).join('\n\n');
      if (typeof userContentForAPI === 'string') {
        userContentForAPI = userContentForAPI + '\n\n' + fileText;
      } else {
        userContentForAPI[0].text += '\n\n' + fileText;
      }
      userContent = (typeof userContent === 'string' ? userContent : text) +
        `\n[附加了${pendingFiles.length}个文件：${pendingFiles.map(f=>f.name).join('、')}]`;
    }


    // 附加风闻分享
    if (pendingWorldVoice) {
      const wv = pendingWorldVoice;
      let shareText = `[用户正在浏览${wv.mediaType}，看到了以下内容并分享给你，请参考这条内容进行回复]\n\n`;
      shareText += `【${wv.mediaType}·${wv.title}】\n${wv.content}`;
      if (wv.comments?.length) {
        shareText += '\n\n---评论区---\n' + wv.comments.map(c => `${c.username}：${c.content}`).join('\n');
      }
      if (typeof userContentForAPI === 'string') {
        userContentForAPI = userContentForAPI + '\n\n' + shareText;
      } else {
        userContentForAPI[0].text += '\n\n' + shareText;
      }
      userContent = (typeof userContent === 'string' ? userContent : text) +
        `\n[分享了一条${wv.mediaType}内容]`;
    }

    // 保存用户消息（显示用）
    const userMsg = {
      id: Utils.uuid(),
      role: 'user',
      content: userContent,
      contentForAPI: userContentForAPI,
      phoneLogSnapshot: _pendingPhoneLog || null, // 本轮手机操作快照（供最新一条消息的 AI 上下文/重写使用）
      conversationId: Conversations.getCurrent(),
      branchId: currentBranchId,
      parentId: messages.length > 0 ? messages[messages.length - 1].id : null,
      timestamp: Utils.timestamp(),
      hidden: text === '<Continue the Chat/>'  // 隐藏继续指令的消息
    };
    await DB.put('messages', userMsg);
    messages.push(userMsg);
    if (!userMsg.hidden) {
      appendMessage(userMsg, false, true);
    }
    input.value = '';
    input.style.height = 'auto';
    roundCount++;

    // ===== 天枢城专属：入城黑屏动画（并行触发，不 await） =====
    try {
      if (window.TianshuFX && document.body.getAttribute('data-worldview') === '天枢城') {
        // 仅在「本对话第一次用户消息」且关键词匹配时触发
        const userMsgCount = messages.filter(m => m.role === 'user').length;
        const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
        const alreadyShown = conv && conv._skynexIntroShown;
        if (userMsgCount === 1 && !alreadyShown && TianshuFX.isEntryTrigger(text)) {
          // 取当前世界观用于计算副标题
          let _wvForFx = null;
          try {
            if (conv && conv.isSingle && conv.singleWorldviewId) {
              _wvForFx = await DB.get('worldviews', conv.singleWorldviewId);
            } else {
              _wvForFx = await Worldview.getCurrent();
            }
          } catch(_) {}
          // 并行播放，不 block AI 请求
          TianshuFX.playEntryAnimation(_wvForFx).catch(() => {});
          // 标记已触发，避免多次
          if (conv) {
            conv._skynexIntroShown = true;
            try { await DB.put('conversations', conv); } catch(_) {}
          }
        }
      }
    } catch(e) { console.warn('[TianshuFX] entry animation failed', e); }

    // 清空附件
    pendingImages = [];
    pendingMemories = [];
    pendingFiles = [];
    pendingWorldVoice = null;
    renderAttachments();

    // 构建system prompt
    const systemParts = [];
    const gaidenSettings = Gaiden.getCurrentGaidenSettings();
    const isGaidenConv = !!gaidenSettings;
    const singleSettings = (typeof SingleMode !== 'undefined') ? SingleMode.getCurrentSingleSettings() : null;
    const isSingleConv = !!singleSettings;
    const convSettings = _getConvSettings();
    const isGameMode = convSettings.gameMode;

    // 单人模式：优先加载该 conv 绑定的世界观数据到 NPC 模块
    let singleWv = null;
    if (isSingleConv && singleSettings.worldviewId) {
      try {
        singleWv = await DB.get('worldviews', singleSettings.worldviewId);
        if (singleWv) {
          const flatNpcs = [], flatFacs = [], flatRegions = [];
          (singleWv.regions || []).forEach(r => {
            flatRegions.push({ id: r.id, name: r.name, summary: r.summary, detail: r.detail, aliases: r.aliases });
            (r.factions || []).forEach(f => {
              flatFacs.push({ ...f, regionName: r.name, regionId: r.id });
              (f.npcs || []).forEach(n => {
                flatNpcs.push({ ...n, faction: f.name, regions: [r.id || r.name] });
              });
            });
          });
          NPC.init({ npcs: flatNpcs, factions: flatFacs, regions: flatRegions });
        }
      } catch(e) { console.warn('[Chat] 单人模式加载世界观失败', e); }
    }

    // 1. 世界观（每轮发）— 番外模式下看 inheritWv 开关 — 单人模式用自己的世界观 — 非文游模式跳过
    if (isGameMode && !isSingleConv) {
      if (!isGaidenConv) {
        if (worldviewPrompt) systemParts.push(worldviewPrompt);
      } else {
        if (gaidenSettings.inheritWv && worldviewPrompt) {
          systemParts.push(worldviewPrompt);
        }
        if (gaidenSettings.gaidenBg) {
          let gaidenPrompt = `【番外世界线设定】\n本对话为番外世界线，以下是用户提供的番外背景设定。这是本对话的第一优先级，所有叙述和角色行为都以此为准。`;
          if (gaidenSettings.inheritWv || gaidenSettings.inheritNpc) {
            gaidenPrompt += `\n上面的原世界观设定和角色信息仅作为参考，请根据番外背景的需要自行调整、取舍或重新诠释，不要让原设定与番外背景产生矛盾。`;
          }
          gaidenPrompt += `\n\n${gaidenSettings.gaidenBg}`;
          systemParts.push(gaidenPrompt);
        }
      }
    } else if (isSingleConv && isGameMode && singleWv && singleWv.setting) {
      systemParts.push(singleWv.setting);
    }

    // 1c. 单人模式：主角资料（每轮必发）
    if (isSingleConv) {
      const mainCharText = await SingleMode.getMainCharPrompt(singleSettings);
      if (mainCharText) systemParts.push(mainCharText);
    } else if (isGameMode && !isGaidenConv) {
      // 1c'. 群像模式：叙事者元 prompt（让 AI 知道自己是旁白+所有 NPC 的化身，用户才是{{user}}）
      systemParts.push(`【AI 扮演角色】
本对话为群像模式（多角色剧情）。你是"叙事者 + 所有 NPC 的扮演者"，用户扮演"{{user}}"。
你应该：
1. 通过场景描写、NPC 对话和环境互动推进剧情，把"用户角色卡"作为玩家的身份资料理解，不要把用户角色卡本身当成需要你扮演的对象。
2. 描写"{{user}}"时使用第二人称"你"或玩家姓名，保留代入感；描写 NPC 时使用第三人称（"他/她/Ta" 或名字）。
3. 根据场景需要让 NPC 自然登场，不必所有 NPC 都登场。
4. 当你看到带【】框起来 + OOC 标记的系统注入信息（例如【玩家手机操作记录｜OOC】），请理解这些是"系统旁白"，主体是"{{user}}"（玩家本人），不是任何 NPC。`);
    }

    // 1d. 挂载角色（对话级常驻，群像/单人都生效）
    try {
      if (window.AttachedChars) {
        const attachedPrompt = await AttachedChars.buildPrompt();
        if (attachedPrompt) systemParts.push(attachedPrompt);
      }
    } catch(_) {}

    // 1b. 剧情总结（如有）
    const summaryText = await Summary.formatForPrompt(Conversations.getCurrent());
    if (summaryText) systemParts.push(summaryText);

    // 2. 输出格式 — 非文游模式或关闭回复格式时跳过
    if (isGameMode && convSettings.format) {
      systemParts.push(OUTPUT_FORMAT_PROMPT);
      // 线上消息气泡：用户开关开启 且 不是心动模拟（心动模拟世界观自带说明）
      if (convSettings.onlineChat && document.body.getAttribute('data-worldview') !== '心动模拟') {
        systemParts.push(ONLINE_CHAT_BLOCK_PROMPT);
      }
    }

    // 2a. 上一轮状态面板（让 AI 知道当前场景状态，照抄未变化字段）
    if (isGameMode && convSettings.format) {
      try {
        const curStatus = Conversations.getStatusBar();
        const statusText = Utils.serializeStatus(curStatus);
        if (statusText) {
          systemParts.push('【上一轮状态面板】\n以下是当前场景的状态快照。你下一次回复的 `status` 代码块应基于此更新：未发生变化的字段请原样抄回；有变化则写新值。\n\n```status\n' + statusText + '\n```');
        }
      } catch(e) {}
    }

    // 2b. 开场时间和开场剧情（前N轮有效）— 非文游模式跳过 — 单人模式看 enableStartPlot
    if (isGameMode && !isGaidenConv && !isSingleConv) {
      try {
        const wv = await Worldview.getCurrent();
        if (wv) {
          const rounds = wv.startPlotRounds || 5;
          const userMsgCount = messages.filter(m => m.role === 'user').length;
          if (userMsgCount < rounds) {
            let startParts = [];
            if (wv.startTime) startParts.push(`开场时间：${wv.startTime}。第一轮的时间必须从此刻开始。`);
            if (wv.startPlot) startParts.push(`开场剧情指令：${wv.startPlot}`);
            if (startParts.length > 0) {
              systemParts.push(`【开场引导（前${rounds}轮生效）】\n${startParts.join('\n')}`);
            }
          }
        }
      } catch(e) { console.warn('[Chat] startPlot注入失败', e); }
    } else if (isSingleConv && isGameMode && singleWv && singleSettings.enableStartPlot) {
      try {
        const rounds = singleWv.startPlotRounds || 5;
        const userMsgCount = messages.filter(m => m.role === 'user').length;
        if (userMsgCount < rounds) {
          let startParts = [];
          if (singleWv.startTime) startParts.push(`开场时间：${singleWv.startTime}。第一轮的时间必须从此刻开始。`);
          if (singleWv.startPlot) startParts.push(`开场剧情指令：${singleWv.startPlot}`);
          if (startParts.length > 0) {
            systemParts.push(`【开场引导（前${rounds}轮生效）】\n${startParts.join('\n')}`);
          }
        }
      } catch(e) {}
    }

    // 3. 角色卡（非文游模式跳过）
const char = await Character.get();
if (isGameMode && char) systemParts.push(Character.formatForPrompt(char));

// 3b. 世界观速查表（每轮发，所有地区/势力/NPC概要）— 番外模式下看 inheritNpc 开关 — 非文游模式跳过
if (isGameMode && !isSingleConv && (!isGaidenConv || gaidenSettings.inheritNpc)) {
      const quickRef = NPC.formatQuickRef();
      if (quickRef) systemParts.push(quickRef);
    } else if (isSingleConv && isGameMode && singleWv) {
      // 单人模式：地区/势力速查永远发，NPC行受 enableNpc 控制
      try { GameLog.log('info', `[Single] 速查表 enableNpc=${singleSettings.enableNpc} enableDetail=${singleSettings.enableDetail}`); } catch(e) {}
      const quickRef = NPC.formatQuickRef({ includeNpc: singleSettings.enableNpc });
      if (quickRef) systemParts.push(quickRef);
    }

    // 3c. 知识条目索引（每轮发，告诉AI存在哪些条目）— 文游模式
    if (isGameMode) {
    try {
    const wvForIndex = isSingleConv ? singleWv : await Worldview.getCurrent();
    const sendKnowledgeIdx = isSingleConv ? !!singleSettings.enableKnowledge : true;
    if (wvForIndex && sendKnowledgeIdx) {
          const idx = _buildKnowledgeIndex(wvForIndex.knowledges || []);
          if (idx) systemParts.push(idx);
        }
      } catch (e) {}
    }

    // 4. 当前区域NPC（detail，地区命中时发）— 番外看 inheritNpc — 单人看 enableDetail
    const region = NPC.getRegion();
    if (isGameMode && !isSingleConv && (!isGaidenConv || gaidenSettings.inheritNpc)) {
      const npcPrompt = NPC.formatForPrompt(region);
      if (npcPrompt) systemParts.push(npcPrompt);

      // 4b. 在场NPC（跨区域跟随，排除已在地区NPC里的）
      const presentNPCPrompt = NPC.formatPresentForPrompt(region);
      if (presentNPCPrompt) systemParts.push(presentNPCPrompt);
    } else if (isSingleConv && isGameMode && singleWv && singleSettings.enableDetail) {
      // 单人模式：detail受 enableDetail 控制，NPC详细需要 enableNpc 也开
      const npcPrompt = NPC.formatForPrompt(region, { includeNpc: singleSettings.enableNpc });
      if (npcPrompt) systemParts.push(npcPrompt);
      if (singleSettings.enableNpc) {
        const presentNPCPrompt = NPC.formatPresentForPrompt(region);
        if (presentNPCPrompt) systemParts.push(presentNPCPrompt);
      }
    }

    // 4c. 全图 NPC（不受地区限制，本世界观下每轮全量注入）
    // 单人模式必须遵守 enableNpc：未启用 NPC 时，连全图常驻 NPC 也不注入。
    if (isGameMode && (!isSingleConv || singleSettings.enableNpc)) {
      try {
        let _wvForGlobal = null;
        if (isSingleConv && singleWv) {
          _wvForGlobal = singleWv;
        } else if (!isGaidenConv || gaidenSettings.inheritNpc) {
          const curWvId = Worldview.getCurrentId && Worldview.getCurrentId();
          if (curWvId && curWvId !== '__default_wv__') {
            _wvForGlobal = await DB.get('worldviews', curWvId);
          }
        }
        const gs = (_wvForGlobal && _wvForGlobal.globalNpcs) || [];
        if (gs.length > 0) {
          const text = '【全图常驻 NPC】\n以下 NPC 不受地区限制，在本世界观下全程常驻，随时可以出现在任何场景中。\n\n' +
            gs.map(n => {
              const head = n.aliases ? `${n.name}（${n.aliases}）` : (n.name || '未命名');
              return n.detail ? `${head}\n${n.detail}` : head;
            }).join('\n\n---\n\n');
          systemParts.push(text);
        }
      } catch(e) { console.warn('[Chat] 全图NPC注入失败', e); }
    }

    // 5. 相关记忆（方案B：关系按NPC名直接命中，事件按地点+关键词）— 仅文游模式
    if (isGameMode) {
      const recentText = messages.slice(-4).map(m => m.content).join(' ');
      const presentNPCs = NPC.getPresentNPCs();
      const currentLoc = NPC.getRegion();
      const relatedMemories = await Memory.retrieve(recentText, presentNPCs, currentLoc);
      const memoryPrompt = Memory.formatForPrompt(relatedMemories);
      if (memoryPrompt) systemParts.push(memoryPrompt);
    }

    // 6. 自定义提示词注入（system_top和system_bottom）
    const injections = await Prompts.buildInjections();
    if (injections.systemTop.length > 0) {
      systemParts.unshift(...injections.systemTop);
    }
    if (injections.systemBottom.length > 0) {
      systemParts.push(...injections.systemBottom);
    }

    // 7. 现实时间感知（对话设置里开关控制）
    if (convSettings.timeAware && window.TimeAwareness) {
      try {
        const { lastAssistantTs, lastUserTs } = TimeAwareness.extractTimestamps(messages);
        systemParts.push(TimeAwareness.buildPrompt(lastAssistantTs, lastUserTs));
      } catch(e) { console.warn('[Chat] 时间感知注入失败', e); }
    }

// 8. 心动模拟：累计状态注入
      // 已返航后，停止注入心动模拟的状态/任务/好感数据，改为注入"已回家"提示
      let _hsHomecoming = false;
      try {
        if (typeof Phone !== 'undefined' && Phone.isHsHomecomingTriggered) {
          _hsHomecoming = await Phone.isHsHomecomingTriggered();
        }
      } catch(_) {}

      if (_hsHomecoming) {
        systemParts.push('[心动模拟·已返航]\n玩家已结束心动模拟，从原本的世界醒来，回到了自己家中。后续剧情发生在玩家自己的家里：\n- 不再有任务系统、好感度系统、心动目标的概念；\n- 心动模拟APP仍在玩家手机里、客服历史也都还在，但服务已结束；\n- 玩家可能产生与心动模拟有关的回忆、错觉、梦境，请保持一种"刚结束的事其实没有完全结束"的微妙氛围，但不要主动制造惊吓，靠玩家追问或主动行为来推进；\n- 不要再在回复中输出 ```relation``` / ```task``` / ```chat``` / ```homecoming``` 等心动模拟专用代码块。');
      } else if (typeof StatusBar !== 'undefined' && StatusBar.hsFormatForPrompt) {
        try {
          const hsStateText = StatusBar.hsFormatForPrompt();
          if (hsStateText) systemParts.push(hsStateText);
        } catch(e) { console.warn('[Chat] 心动模拟累计状态注入失败', e); }
      }

      // 8a. 心动模拟：通关后的"返航 marker"持续提示（直到 AI 实际触发为止）
      try {
        if (!_hsHomecoming && typeof StatusBar !== 'undefined' && StatusBar.hsCheckClearCondition) {
          const check = StatusBar.hsCheckClearCondition();
          if (check && check.passed) {
            systemParts.push('[心动模拟·返航触发协议]\n玩家已达成回家条件。当玩家在剧情里真正回到自己原本的世界、彻底从心动模拟中醒来后，请在该轮回复的最末尾追加一个空的 ```homecoming``` 代码块作为信号——前端识别到该信号后会接管展示返航过场动画。在那一轮之前请正常推进剧情，玩家可能还有未完成的事情想交代；不要在尚未真正"回到家中醒来"之前提前输出该 marker。该 marker 一旦输出过一次，前端会接管后续展示，不需要再重复输出。');
          }
        }
      } catch(_) {}

      // 重写建议（仅本轮重写生效，发送后立刻清空）
      if (_pendingRewriteHint) {
        systemParts.push(`[本轮重写建议]\n用户对上一次回复不满意，触发了重写。本轮请按下方建议调整方向，但仍然要遵守此前所有的格式与世界观规则：\n${_pendingRewriteHint}`);
        _pendingRewriteHint = '';
      }

// 8b. 心动模拟：黑化阈值警告注入
    if (typeof StatusBar !== 'undefined' && StatusBar.hsGetDarknessWarnings) {
      try {
        const warnings = StatusBar.hsGetDarknessWarnings(true);  // 实际发送：会打/清查手机标记
        if (warnings.length > 0) {
          const warnText = warnings.map(w => w.text).join('\n');
          systemParts.push(`【心动模拟·系统提醒】\n${warnText}`);
          // 黑化≥80时注入手机数据
          const phoneWarns = warnings.filter(w => w.level === 'phone');
          if (phoneWarns.length > 0 && window.Phone && Phone.buildPhoneDataForAI) {
            try {
              const phoneData = await Promise.race([
                Phone.buildPhoneDataForAI({ includeShopping: true }),
                new Promise(resolve => setTimeout(() => resolve(''), 3000))
              ]);
              if (phoneData) {
                systemParts.push(`【${phoneWarns[0].name}正在查看用户手机，以下是手机内容（包含饿了咪/桃宝的搜索与订单记录——这是平时不会暴露的隐私）】\n${phoneData}`);
              }
            } catch(e) {
              console.warn('[Chat] 黑化查手机数据注入失败，已跳过，不阻断发送', e);
            }
          }
        }
      } catch(_) {}
    }

    // 构建对话历史（当前窗口全部消息，隐藏消息除外）
    const config = await API.getConfig();
    let historyForAPI = messages.filter(m => !m.hidden).map(m => ({
      role: m.role,
      content: m.contentForAPI || m.content
    }));
    // 时间感知开启时，给用户消息拼时间戳前缀
    if (convSettings.timeAware && window.TimeAwareness) {
 try {
 historyForAPI = TimeAwareness.stampUserMessages(historyForAPI, messages);
 } catch(e) { console.warn('[Chat] 用户消息时间戳注入失败', e); }
 }

 // 心动模拟：每轮贴近最新用户消息的数值规则提醒
 try {
 const conv = Conversations.getList()?.find(c => c.id === Conversations.getCurrent());
 const isHeartSimConv = document.body?.getAttribute('data-worldview') === '心动模拟'
 || conv?.worldviewId === 'wv_heartsim'
 || conv?.singleWorldviewId === 'wv_heartsim';
 if (isHeartSimConv) {
 const idx = [...historyForAPI].map((m, i) => ({ m, i })).reverse().find(x => x.m.role === 'user')?.i;
 if (idx !== undefined) {
 const hsRule = `[心动模拟·本轮数值规则]\nrelation只记录本轮实际发生变化的心动目标，表示本轮增量，不是当前总值。\naffinity 与 darkness 每次单项变动必须在 -5 到5之间；没有在本轮直接互动、被明确影响或受到明确剧情刺激的目标，不要写入 relation。\n禁止为了推进进度而批量给所有心动目标加分。
任务更新规则：tasks 只表示本轮任务变更，不是完整任务历史；当前仍有 active 任务时，本轮只能把现有任务标记为 active/done/skipped，禁止发布新的 active 任务；done/skipped 是结算事件，系统加减积分后会从任务栏移除，不需要下一轮继续输出；当任务栏没有 active 任务时，下一轮才允许发布新一批 active 任务，同一批最多3个。`;
 historyForAPI[idx] = { ...historyForAPI[idx], content: `${hsRule}\n\n${historyForAPI[idx].content}` };
 }
 }
 } catch(e) { console.warn('[Chat] 心动模拟数值规则注入失败', e); }

 const apiMessages = await API.buildMessages(historyForAPI, systemParts);
  try { GameLog.log('info', `[Chat] API消息构建完成: history=${historyForAPI.length}, systemParts=${systemParts.length}, apiMessages=${apiMessages.length}`); } catch(_) {}

    // 深度注入（在对话历史中间插入）
    if (Object.keys(injections.depths).length > 0) {
      for (const [depthStr, contents] of Object.entries(injections.depths)) {
        const depth = parseInt(depthStr);
        // depth 0 = 最新消息前，1 = 倒数第二条前...
        const insertIdx = apiMessages.length - depth;
        if (insertIdx > 0 && insertIdx <= apiMessages.length) {
          for (const c of contents.reverse()) {
            apiMessages.splice(insertIdx, 0, { role: 'system', content: c });
          }
        }
      }
    }

    // 节日/自定义设定注入（紧贴用户最新消息前，depth 0）— 非文游模式跳过
    if (isGameMode) {
      try {
      const currentWv = isSingleConv ? singleWv : await Worldview.getCurrent();
      if (currentWv) {
        // 单人模式按开关控制
        const sendFestival = isSingleConv ? !!singleSettings.enableFestival : true;
const sendCustom = isSingleConv ? !!singleSettings.enableCustom : true;
const sendKnowledge = isSingleConv ? !!singleSettings.enableKnowledge : true;
const festivalText = sendFestival ? _buildFestivalPrompt(currentWv.festivals || [], messages) : '';
const customText = sendCustom ? _buildCustomPrompt(currentWv.customs || []) : '';
const knowledgeText = sendKnowledge ? _buildKnowledgePrompt(currentWv.knowledges || [], messages) : '';
const timeSensitive = [festivalText, customText, knowledgeText].filter(Boolean).join('\n\n');
if (timeSensitive) {
// 插到最后一条用户消息前面
const insertIdx = apiMessages.length - 1; // 用户最新消息是最后一条
if (insertIdx > 0) {
apiMessages.splice(insertIdx, 0, { role: 'system', content: timeSensitive });
}
}
      }
    } catch(e) { console.warn('[Chat] 节日注入失败:', e); }
    } // isGameMode

    // 手机操作日志：只读"最后一条 user 消息"的 phoneLogSnapshot（方案B）
    // 这样新发送和重写最新一条都能拿到同一份快照，AI 不会反复看到历史轮的手机操作
    try {
      const _lastUserMsg = [...messages].reverse().find(m => m.role === 'user' && !m.hidden);
      const _snapshot = _lastUserMsg?.phoneLogSnapshot;
      if (_snapshot && _snapshot.length > 0) {
        const _phoneLogContent = '【玩家手机操作记录｜OOC】\n以下是"{{user}}"本轮在自己手机里的操作，由系统旁白记录，不是角色对白，也不是任何一方的剧情发言：\n\n' +
          _snapshot.map(a => `- {{user}} ${a}`).join('\n') +
          '\n\n请把这些操作作为"{{user}}"本轮的背景行为融入剧情：\n① 操作主体永远是"{{user}}"，不是任何被扮演的角色。\n② 如果世界观设有日常任务，请据此判断任务完成度——只有"新增"算完成，"删除/更新"不算。\n③ 如果操作涉及其他角色（比如点赞/评论某人动态、给某人下单），相关角色应在合适时机收到提示并自然回应；若当前情境不适合看手机，可由旁白提及"手机震了一下稍后才查看"。\n④ 如果操作与剧情无关，作为背景知晓即可，不必每条都回应。';
        const insertIdx = apiMessages.length - 1; // 最后一条是当前 user 消息
        if (insertIdx >= 0) {
          apiMessages.splice(insertIdx, 0, { role: 'system', content: _phoneLogContent });
        } else {
          apiMessages.push({ role: 'system', content: _phoneLogContent });
        }
      }
    } catch(_) {}

    // 宏替换：{{user}} → 当前面具角色名；{{char}} → 单人卡角色名（如有）
    const _macroUser = char?.name || '玩家';
    let _macroChar = '';
    try {
      if (isSingleConv && singleSettings && singleSettings.charId) {
        if (singleSettings.charType === 'card') {
          const _sc = await SingleCard.get(singleSettings.charId);
          if (_sc && _sc.name) _macroChar = _sc.name;
        } else if (singleSettings.charType === 'npc') {
          const _wvId = singleSettings.charSourceWvId || singleSettings.worldviewId;
          if (_wvId) {
            const _wv = await DB.get('worldviews', _wvId);
            if (_wv) {
              outer: for (const r of (_wv.regions || [])) {
                for (const f of (r.factions || [])) {
                  for (const n of (f.npcs || [])) {
                    if (n.id === singleSettings.charId) { _macroChar = n.name; break outer; }
                  }
                }
              }
            }
          }
        }
      }
    } catch(_) {}
    for (const m of apiMessages) {
      if (m.content && typeof m.content === 'string') {
        if (m.content.includes('{{user}}')) m.content = m.content.replaceAll('{{user}}', _macroUser);
        if (_macroChar && m.content.includes('{{char}}')) m.content = m.content.replaceAll('{{char}}', _macroChar);
      }
    }

    // 创建AI消息占位
    const aiMsg = {
      id: Utils.uuid(),
      role: 'assistant',
      content: '',
      conversationId: Conversations.getCurrent(),
      branchId: currentBranchId,
      parentId: userMsg.id,
      timestamp: Utils.timestamp()
    };

const msgEl = appendMessage(aiMsg, true, true);
        const contentEl = msgEl.querySelector('.msg-body');
        _currentAiMsgId = aiMsg.id;
        _currentAiMsg = aiMsg;
        _currentAiMsgEl = msgEl;

    // 流式请求（带自动重试，最多3次）
    let retryCount = 0;
    const maxRetries = 3;

    async function _doStream() {
      try { GameLog.log('info', '[Chat] 开始调用 API.streamChat'); } catch(_) {}
      return new Promise((resolve, reject) => {
        API.streamChat(
          apiMessages,
          // onChunk
        (chunk, fullContent) => {
          aiMsg.content = fullContent;
          // 流式过滤：把心动模拟返航 marker 从渲染内容里抹掉，玩家不该看到
          // 兼容流式不完整状态：对带尾 ``` 的完整代码块去除；对刚开头的 ```homecoming 也整体擦掉
          let renderContent = fullContent;
          renderContent = renderContent.replace(/```homecoming\s*[\s\S]*?```/gi, '');
          renderContent = renderContent.replace(/```homecoming[\s\S]*$/i, '');
          contentEl.innerHTML = Markdown.render(renderContent);
          if (convSettings.stream) contentEl.classList.add('streaming-cursor');
          scrollToBottomIfFollowing();
        },
          // onDone
          async (fullContent) => {
            try {
              // 正则替换规则
              const regexRules = await Settings.getRegexRules();
              for (const rule of regexRules) {
                if (rule.enabled === false) continue;
                try {
                  const re = new RegExp(rule.pattern, rule.flags || 'g');
                  fullContent = fullContent.replace(re, rule.replacement ?? '');
                } catch(e) {}
              }
              aiMsg.content = fullContent;
aiMsg.timestamp = Utils.timestamp();
// 内容已最终确定，清掉可能的旧缓存（流式过程不写入缓存，但保险）
try { delete aiMsg._cachedFullHTML; delete aiMsg._cachedPlainHTML; } catch(_) {}
await DB.put('messages', aiMsg);
messages.push(aiMsg);

              const parsed = Utils.parseAIOutput(fullContent);
          if (isGameMode && convSettings.format) {
                renderParsedMessage(msgEl, parsed);
                // updateTopbar 移到状态栏更新之后，避免 heartSim 被覆盖
              } else {
                // 非文游模式或关闭回复格式：纯Markdown渲染
                contentEl.innerHTML = Markdown.render(fullContent);
              }

              // 更新状态栏（状态栏在所有模式下都尝试更新，不依赖 format 开关；
              // 但只有文游模式才有 status 代码块，其他场景 parsed.status 为 null）
              if (isGameMode) {
                try {
                  const oldStatus = Conversations.getStatusBar();
                  // 老格式兼容：若 parsed.status 为空但有 header（地点/时间/天气），合成一个最小 status
                  let newStatus = parsed.status;
                  const statusBlockPresent = !!parsed.status;
                  if (!newStatus && (parsed.header.region || parsed.header.time || parsed.header.weather)) {
                    newStatus = {
                      region: parsed.header.region || '',
                      location: parsed.header.location || '',
                      time: parsed.header.time || '',
                      weather: parsed.header.weather || '',
                      scene: '', playerOutfit: '', playerPosture: '', npcs: []
                    };
                  }
                  const merged = Utils.mergeStatus(oldStatus, newStatus, statusBlockPresent);
                  if (merged) {
                    // 保留旧的 heartSim 字段（基础状态栏不包含它）
                    if (oldStatus?.heartSim) merged.heartSim = oldStatus.heartSim;
                    await Conversations.setStatusBar(merged);
                    if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(merged);
                  }
                } catch(e) { console.warn('[Chat] status 更新失败:', e); }
              }
              
              // 心动模拟：处理 relation/task 代码块（在状态栏已就位后应用增量）
              if (isGameMode && convSettings.format) {
                updateTopbar(parsed);
              }

              // 心动模拟：返航动画触发（marker 命中 + 未触发过）
              try {
                if (parsed.homecoming && typeof Phone !== 'undefined' && typeof HeartSimHomecoming !== 'undefined') {
                  const triggered = await Phone.isHsHomecomingTriggered();
                  if (!triggered) {
                    // 1.5s 后触发，让玩家先读完正文
                    setTimeout(() => {
                      try { HeartSimHomecoming.play(); } catch(e) { console.warn('[HSHomecoming] play failed', e); }
                    }, 1500);
                  }
                }
              } catch(e) { console.warn('[Chat] homecoming 触发检测失败', e); }

              // 把"完整状态"（含 heartSim 累计）快照到这条 AI 消息上，回溯时回滚整套
              try {
                const finalStatus = Conversations.getStatusBar();
                if (finalStatus) {
                  aiMsg.statusSnapshot = JSON.parse(JSON.stringify(finalStatus));
                  await DB.put('messages', aiMsg);
                }
              } catch(_) {}
              
              // region和NPC解析在文游模式下始终执行（不管format开关）
              if (isGameMode) {
                const newRegion = NPC.parseRegionFromOutput(parsed);
                if (newRegion !== NPC.getRegion()) NPC.setRegion(newRegion);

                // 更新在场NPC缓存
                if (parsed.presentNPCs && parsed.presentNPCs.length > 0) {
                  NPC.setPresentNPCs(parsed.presentNPCs);
                  GameLog.log('info', `相关NPC: ${parsed.presentNPCs.join(', ')}`);
                }
              }

              updateTokenCount();

              GameLog.log('info', `当前轮数: ${roundCount}`);
              // 记忆提取间隔从配置读取
              const extractInterval = parseInt((await API.getConfig()).extractInterval) || 20;
              const shouldExtract = (roundCount > 0 && roundCount % extractInterval === 0) || _extractPending;
              if (shouldExtract) {
                GameLog.log('info', `触发记忆提取 (第${roundCount}轮, 间隔${extractInterval}, pending=${_extractPending})`);
                UI.showToast(_extractPending ? '正在重试记忆提取…' : '正在进行记忆提取，请稍候…', 4000);
                await autoExtractMemory();
              }
              // 总结：正常检查 + 失败重试
              if (_summaryPending) {
                GameLog.log('info', '[Summary] 上轮失败，重试总结');
                UI.showToast('正在重试剧情总结…', 4000);
              }
              await checkAutoSummary();
              resolve();
            } catch(e) {
              GameLog.log('error', `onDone处理错误: ${e.message}`);
              resolve(); // onDone里的处理错误不算生成失败
            } finally {
              contentEl.classList.remove('streaming-cursor');
            }
          },
          // onError
          (err) => {
            contentEl.classList.remove('streaming-cursor');
            reject(new Error(err));
          },
          // abortSignal
requestController.signal,
// options
          { forceNoStream: !convSettings.stream }
        ).catch(e => {
          if (e.name === 'AbortError') {
            resolve(); // 用户主动取消不重试
          } else {
            reject(e);
          }
        });
      });
    }

    // 重试循环
    while (retryCount < maxRetries) {
      try {
        await _doStream();
        break; // 成功，退出循环
      } catch(err) {
        retryCount++;
        if (retryCount >= maxRetries) {
          // 三次都失败
          contentEl.innerHTML = `<p style="color:var(--danger)">生成失败（已重试${maxRetries}次）：${Utils.escapeHtml(err.message)}</p>`;
          GameLog.log('error', `streamChat失败（${maxRetries}次）: ${err.message}`);
          UI.showToast(`生成失败，已重试${maxRetries}次`, 4000);
        } else {
          // 还有重试机会
          UI.showToast(`生成失败，正在重试（${retryCount}/${maxRetries}）…`, 3000);
          GameLog.log('warn', `streamChat失败第${retryCount}次: ${err.message}，重试中…`);
          aiMsg.content = '';
          contentEl.innerHTML = `<p style="color:var(--text-secondary);font-size:12px">生成失败，正在重试（${retryCount}/${maxRetries}）…</p>`;
          await new Promise(r => setTimeout(r, 1500)); // 等1.5秒再重试
        }
      }
    }

    isStreaming = false;
    abortController = null;
    _cancelledMsgId = null;
    _currentAiMsgId = null;
    _currentAiMsg = null;
    _currentAiMsgEl = null;
    updateSendButton(false);
    try { Conversations.setStreaming && Conversations.setStreaming(_streamConvId, false); } catch(_) {}

    // 天枢城专属：流式完成后检查大区切换
    try {
      if (window.TianshuRegion) {
        const s = Conversations.getStatusBar();
        if (s && s.region) TianshuRegion.check(s.region);
      }
    } catch(_) {}

    } catch(fatalErr) {
      console.error('[Chat] send()致命错误', fatalErr);
      GameLog.log('error', `send()致命错误: ${fatalErr.message}\n${fatalErr.stack}`);
      UI.showToast(`发送失败：${fatalErr.message || '未知错误'}`, 5000);
      isStreaming = false;
      abortController = null;
      _cancelledMsgId = null;
      _currentAiMsgId = null;
      updateSendButton(false);
      try { Conversations.setStreaming && Conversations.setStreaming(_streamConvId, false); } catch(_) {}
    }
  }

  let lastExtractedMsgId = null; // 去重用：记录上次提取到的最后一条消息ID
  let _extractPending = false; // 记忆提取失败后，下一轮自动重试
  let _summaryPending = false; // 总结失败后，下一轮自动重试

  /**
   * 尝试修复被截断的JSON（记忆提取专用）
   * 策略：找到最后一个完整的对象，截掉后面不完整的部分，补全括号
   */
  function _tryFixTruncatedJSON(str) {
    if (!str || !str.startsWith('{')) return null;
    // 策略1：逐字符往回找最后一个完整的 } 或 ]，然后补全外层
    // 先尝试找 "events" 和 "relations" 数组中最后一个完整对象
    try {
      // 找到最后一个 "}," 或 "}" 后跟 "]" 的位置
      let lastGoodPos = -1;
      let braceDepth = 0, bracketDepth = 0, inString = false, escaped = false;
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') braceDepth++;
        if (ch === '}') { braceDepth--; if (braceDepth >= 1) lastGoodPos = i; }
        if (ch === '[') bracketDepth++;
        if (ch === ']') bracketDepth--;
      }
      if (lastGoodPos > 0) {
        // 从 lastGoodPos 截断，补全所有未关闭的括号
        let fixed = str.substring(0, lastGoodPos + 1);
        // 去掉末尾可能的逗号
        fixed = fixed.replace(/,\s*$/, '');
        // 计算还需要多少 ] 和 }
        let needBrackets = 0, needBraces = 0;
        let d1 = 0, d2 = 0, inStr = false, esc = false;
        for (let i = 0; i < fixed.length; i++) {
          const c = fixed[i];
          if (esc) { esc = false; continue; }
          if (c === '\\') { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c === '[') d1++;
          if (c === ']') d1--;
          if (c === '{') d2++;
          if (c === '}') d2--;
        }
        for (let i = 0; i < d1; i++) fixed += ']';
        for (let i = 0; i < d2; i++) fixed += '}';
        const result = JSON.parse(fixed);
        return result;
      }
    } catch(e) { /* 修复失败 */ }
    return null;
  }

  /**
 * 自动提取记忆（带重试）
 * @param {Array} targetMsgs 指定提取的消息列表，不传则取上次提取点之后的新消息
 * @param {Object} options
 * @param {boolean} options.updateLastExtracted 是否推进自动提取游标；多选手动提取应为 false
 */
async function autoExtractMemory(targetMsgs, options = {}) {
GameLog.log('info', '[Memory] 开始自动提取...');

// 锁定本次提取的目标面具/对话/轮数，避免异步期间继续发消息或切换状态导致写入信息漂移
const extractScope = Character.getCurrentId();
const extractConvId = Conversations.getCurrent();
const extractRound = roundCount;
// 多选手动提取只应写入选中内容，不应推进“自动提取游标”，否则会跳过未选中的中间消息
const updateLastExtracted = options.updateLastExtracted !== false;

    let toExtract;
    if (targetMsgs) {
      toExtract = targetMsgs;
    } else {
      if (lastExtractedMsgId) {
        const lastIdx = messages.findIndex(m => m.id === lastExtractedMsgId);
        toExtract = lastIdx >= 0 ? messages.slice(lastIdx + 1) : messages.slice(-20);
      } else {
        toExtract = messages.slice(-20);
      }
    }

    if (toExtract.length === 0) {
      GameLog.log('warn', '[Memory] 没有新消息可提取，跳过');
      return;
    }

    const lastMsg = toExtract[toExtract.length - 1];
const char = await Character.get();
const charName = char?.name || '用户角色';
const config = await API.getConfig();
    const extractLimits = {
      maxEvents: parseInt(config.maxExtractEvents) || 5,
      maxRelations: parseInt(config.maxExtractRelations) || 5
    };
    const charInfo = char ? { name: char.name, gender: char.gender, background: char.background } : null;
    const prompt = Memory.buildExtractionPrompt(toExtract, charName, charInfo, extractLimits);
    const dialogue = toExtract.map(m =>
      `[${m.role === 'user' ? charName : 'AI'}] ${m.content}`
    ).join('\n\n');

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        UI.showToast(`正在提取记忆…（${attempt}/${MAX_RETRIES}）`, 3000);
        GameLog.log('info', `[Memory] 调用提取模型 (第${attempt}次)，${toExtract.length}条消息，${dialogue.length}字`);
        const result = await API.extractMemory(dialogue, prompt);
        GameLog.log('info', `[Memory] 提取返回: ${result.substring(0, 100)}`);
        let cleaned = result.trim();
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
        }
        let data;
        try {
          data = JSON.parse(cleaned);
        } catch (parseErr) {
          // 尝试修复被截断的JSON
          GameLog.log('info', `[Memory] JSON解析失败，尝试修复截断: ${parseErr.message}`);
          data = _tryFixTruncatedJSON(cleaned);
          if (!data) throw parseErr;
          GameLog.log('info', '[Memory] 截断JSON修复成功');
        }
        let eventCount = 0, relCount = 0;
        if (data.events) {
for (const e of data.events) {
await Memory.add('event', { ...e, roundCreated: extractRound, scope: extractScope });
eventCount++;
}
}
if (data.relations) {
for (const r of data.relations) {
await Memory.upsertRelation({ ...r, roundCreated: extractRound, scope: extractScope });
relCount++;
}
}
if (updateLastExtracted) lastExtractedMsgId = lastMsg.id;
_extractPending = false; // 成功，清除重试标记
        GameLog.log('info', `[Memory] 提取完成: ${eventCount}个事件, ${relCount}个关系已存入/更新`);
        UI.showToast(`记忆提取完成（${eventCount} 条事件 / ${relCount} 条关系）`, 2500);
        return; // 成功，退出
      } catch (e) {
        GameLog.log('warn', `[Memory] 提取第${attempt}次失败: ${e.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * attempt)); // 递增等待
        }
      }
    }
    // 3次功能模型都失败，尝试用主模型兜底
    try {
      GameLog.log('info', '[Memory] 功能模型3次失败，尝试主模型兜底...');
      UI.showToast('正在用主模型重试记忆提取…', 3000);
      const mainConfig = await API.getConfig();
      const result = await API.extractMemory(dialogue, prompt, { useMainModel: true });
      GameLog.log('info', `[Memory] 主模型返回: ${result.substring(0, 100)}`);
      let cleaned = result.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      }
      let data;
      try { data = JSON.parse(cleaned); } catch(pe) {
        data = _tryFixTruncatedJSON(cleaned);
        if (!data) throw pe;
      }
      let eventCount = 0, relCount = 0;
      if (data.events) { for (const e of data.events) { await Memory.add('event', { ...e, roundCreated: extractRound, scope: extractScope }); eventCount++; } }
if (data.relations) { for (const r of data.relations) { await Memory.upsertRelation({ ...r, roundCreated: extractRound, scope: extractScope }); relCount++; } }
if (updateLastExtracted) lastExtractedMsgId = lastMsg.id;
_extractPending = false;
      GameLog.log('info', `[Memory] 主模型兜底成功: ${eventCount}个事件, ${relCount}个关系`);
      UI.showToast(`记忆提取完成（主模型兜底：${eventCount} 条事件 / ${relCount} 条关系）`, 2500);
      return;
    } catch(fallbackErr) {
      GameLog.log('warn', `[Memory] 主模型兜底也失败: ${fallbackErr.message}`);
    }
    // 全部失败，标记下一轮重试
    _extractPending = true;
    UI.showToast('⚠ 记忆提取失败，将在下一轮自动重试', 4000);
    GameLog.log('error', '[Memory] 功能模型+主模型均失败，标记下一轮重试');
  }

  /**
   * 检查是否需要自动总结（只按Token阈值）
   * 心动模拟世界观会注入大量额外上下文（手机操作日志、relation/task、status_bar 等），
   * 实际渲染负担明显高于普通世界观——为了避免 17w 左右开始卡甚至闪退，
   * 在心动模拟下把"有效阈值"钳到 130000，比用户配置的更早触发总结
   */
  const HEARTSIM_SUMMARY_CAP = 130000;
  function _isHeartSimWorldview() {
    try {
      return document.body?.getAttribute('data-worldview') === '心动模拟';
    } catch(_) { return false; }
  }
  async function checkAutoSummary() {
    const config = await API.getConfig();
    let tokenLimit = parseInt(config.tokenLimit) || 0;

    // 心动模拟专用：钳到 HEARTSIM_SUMMARY_CAP（含禁用情况下也强制启用）
    if (_isHeartSimWorldview()) {
      if (tokenLimit <= 0 || tokenLimit > HEARTSIM_SUMMARY_CAP) {
        tokenLimit = HEARTSIM_SUMMARY_CAP;
      }
    }

    // 只按token阈值触发，0=禁用；但失败重试时无条件尝试
    if (!_summaryPending && (tokenLimit <= 0 || totalTokenEstimate < tokenLimit)) return;

    GameLog.log('info', `触发自动总结: Token ~${totalTokenEstimate}/${tokenLimit}`);
    // 心动模拟下用更明确的提示，告诉用户这是为了防止闪退
    if (_isHeartSimWorldview() && tokenLimit === HEARTSIM_SUMMARY_CAP) {
      UI.showToast('心动模拟上下文较大，已自动触发剧情总结以避免卡顿/闪退，请稍候…', 6000);
    } else {
      UI.showToast('正在进行剧情总结，请稍候…', 5000);
    }

    // 保留最近10轮
    const toSummarize = messages.slice(0, -(10 * 2));
    if (toSummarize.length === 0) return;

    // 1. 总结前提取记忆（去重）
    let toExtractBeforeSummary = toSummarize;
    if (lastExtractedMsgId) {
      const lastIdx = toSummarize.findIndex(m => m.id === lastExtractedMsgId);
      toExtractBeforeSummary = lastIdx >= 0 ? toSummarize.slice(lastIdx + 1) : toSummarize;
    }
    if (toExtractBeforeSummary.length > 0) {
      GameLog.log('info', `[Summary] 总结前提取 ${toExtractBeforeSummary.length} 条消息的记忆`);
      await autoExtractMemory(toExtractBeforeSummary);
    }

    // 2. AI生成结构化总结（先总结，成功后才归档删除）
const convId = Conversations.getCurrent();
const char = await Character.get();
const charName = char?.name || '用户角色';

const MAX_RETRIES = 3;
    let summarySuccess = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        UI.showToast(`正在生成剧情总结…（${attempt}/${MAX_RETRIES}）`, 4000);
        GameLog.log('info', `[Summary] AI总结第${attempt}次...`);
        await Summary.generate(convId, messages, charName);
        Summary.setConvId(convId);
        summarySuccess = true;
        break;
      } catch(e) {
        GameLog.log('warn', `[Summary] 第${attempt}次失败: ${e.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
    }

    if (!summarySuccess) {
      // 尝试主模型兜底
      try {
        GameLog.log('info', '[Summary] 功能模型3次失败，尝试主模型兜底...');
        UI.showToast('正在用主模型重试剧情总结…', 4000);
        await Summary.generate(convId, messages, charName, { useMainModel: true });
        Summary.setConvId(convId);
        summarySuccess = true;
        GameLog.log('info', '[Summary] 主模型兜底成功');
      } catch(fallbackErr) {
        GameLog.log('warn', `[Summary] 主模型兜底也失败: ${fallbackErr.message}`);
      }
    }

    if (!summarySuccess) {
      _summaryPending = true;
      UI.showToast('⚠ 剧情总结失败，将在下一轮自动重试', 5000);
      GameLog.log('error', '[Summary] 功能模型+主模型均失败，标记下一轮重试');
      return; // 不归档、不删消息
    }

    // 3. 总结成功 → 归档 → 删除
    _summaryPending = false; // 成功，清除重试标记
    await Summary.archive(convId, toSummarize);
    for (const msg of toSummarize) {
      await DB.del('messages', msg.id);
    }

    // 4. 重新加载
    await loadHistory();
    UI.showToast('剧情总结完成', 2000);
    GameLog.log('info', '[Summary] 总结完成');
  }

  async function manualExtractMemory() {
    if (!await UI.showConfirm('手动提取记忆', '立即从最近对话中提取记忆，确定？')) return;
    UI.showToast('正在手动提取记忆…', 3000);
    GameLog.log('info', '[Memory] 手动触发记忆提取');
    await autoExtractMemory();
    GameLog.log('info', '[Memory] 手动提取完成');
  }

  async function manualSummary() {
    if (!await UI.showConfirm('手动剧情总结', '立即总结当前对话并归档旧消息，确定？\n（总结前会自动提取记忆）')) return;
    UI.showToast('正在手动触发剧情总结…', 3000);
    GameLog.log('info', '[Summary] 手动触发剧情总结');
    // 跳过token阈值，直接走总结流程
    const config = await API.getConfig();
    const toSummarize = messages.slice(0, -(10 * 2));
    if (toSummarize.length === 0) {
      UI.showToast('消息太少，无法总结', 2000);
      return;
    }
    // 总结前先提取记忆
    let toExtractBeforeSummary = toSummarize;
    if (lastExtractedMsgId) {
      const lastIdx = toSummarize.findIndex(m => m.id === lastExtractedMsgId);
      toExtractBeforeSummary = lastIdx >= 0 ? toSummarize.slice(lastIdx + 1) : toSummarize;
    }
    if (toExtractBeforeSummary.length > 0) {
      await autoExtractMemory(toExtractBeforeSummary);
    }
    const convId = Conversations.getCurrent();
const char = await Character.get();
const charName = char?.name || '用户角色';
const MAX_RETRIES = 3;
let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        UI.showToast(`正在生成剧情总结…（${attempt}/${MAX_RETRIES}）`, 4000);
        await Summary.generate(convId, messages, charName);
        Summary.setConvId(convId);
        success = true;
        break;
      } catch(e) {
        GameLog.log('warn', `[Summary] 手动总结第${attempt}次失败: ${e.message}`);
        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
    if (!success) {
      try {
        await Summary.generate(convId, messages, charName, { useMainModel: true });
        Summary.setConvId(convId);
        success = true;
      } catch(e) {
        GameLog.log('warn', `[Summary] 手动总结主模型兜底失败: ${e.message}`);
      }
    }
    if (!success) {
      UI.showToast('⚠ 剧情总结失败', 4000);
      return;
    }
    _summaryPending = false;
    await Summary.archive(convId, toSummarize);
    for (const msg of toSummarize) {
      await DB.del('messages', msg.id);
    }
    await loadHistory();
    UI.showToast('剧情总结完成', 2000);
  }

  // ===== 长按上下文菜单 =====

  let pressTimer = null;
  let pressTarget = null;

  function initLongPress() {
const container = document.getElementById('chat-messages');

// 多选模式下点击切换选中
container.addEventListener('click', (e) => {
if (!multiSelectMode) return;
const msgEl = e.target.closest('.chat-msg');
if (!msgEl || !msgEl.dataset.id) return;
// 忽略内部按钮
if (e.target.closest('.copy-btn') || e.target.closest('.msg-tap-actions') || e.target.closest('a')) return;
e.preventDefault();
e.stopPropagation();
toggleMultiSelect(msgEl.dataset.id);
}, true);

// 方案1: 长按（触摸设备）
container.addEventListener('touchstart', (e) => {
const msgEl = e.target.closest('.chat-msg');
if (!msgEl || !msgEl.dataset.id) return;
// 不拦截复制按钮等
if (e.target.closest('.copy-btn') || e.target.closest('.msg-tap-actions')) return;
// 多选模式下不触发长按菜单
if (multiSelectMode) return;
      pressTarget = msgEl;
      msgEl.classList.add('pressing');
      pressTimer = setTimeout(() => {
        const touch = e.touches[0];
        showContextMenu(msgEl.dataset.id, touch.clientX, touch.clientY);
        msgEl.classList.remove('pressing');
      }, 500);
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
      cancelPress();
    });
    container.addEventListener('touchmove', cancelPress);

    // 方案2: 桌面右键
container.addEventListener('contextmenu', (e) => {
const msgEl = e.target.closest('.chat-msg');
if (!msgEl || !msgEl.dataset.id) return;
if (multiSelectMode) return;
e.preventDefault();
showContextMenu(msgEl.dataset.id, e.clientX, e.clientY);
});

    // 点击空白关闭菜单
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.context-menu')) closeContextMenu();
    });

    // 滚动监听：控制回底按钮显隐 + 流式跟随状态
    container.addEventListener('scroll', () => {
      updateScrollBtn();
      // 用户离开底部 → 暂停流式自动跟随；回到底部 → 恢复
      _followBottomDuringStream = _isNearBottom(container);
    }, { passive: true });
  }

  function cancelPress() {
    clearTimeout(pressTimer);
    if (pressTarget) pressTarget.classList.remove('pressing');
    pressTarget = null;
  }

  function showContextMenu(msgId, x, y) {
    closeContextMenu();
    const msg = messages.find(m => m.id === msgId);
    if (!msg) return;

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.id = 'ctx-menu';

    const items = [];

    // 判定：这条消息是否是当前对话的"最新一条"（非 hidden 消息）
    // 用于决定"重写/删除"是否允许——只允许操作最新一条，避免状态栏污染
    const _isLatest = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role !== 'system' && !m.hidden) {
          return m.id === msgId;
        }
      }
      return false;
    })();

    if (msg.role === 'user') {
      // 用户气泡
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg> 编辑剧情', action: () => editMessage(msgId) });
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> 回溯到此处', action: () => rollbackAndRestore(msgId) });
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg> 从此分支', action: () => createBranch(msgId) });
      items.push({ sep: true });
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> 多选', action: () => enterMultiSelect(msgId) });
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 删除', action: () => deleteMessage(msgId), danger: true });
    } else {
      // AI气泡
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg> 编辑剧情', action: () => editMessage(msgId) });
      if (_isLatest) {
        items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> 重写剧情', action: () => openRewriteHint(msgId) });
        items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M10.029 4.285A2 2 0 0 0 7 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/><path d="M3 4v16"/></svg> 继续剧情', action: () => continueGenerate(msgId) });
        items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg> 回退一步', action: () => retractAI(msgId) });
      }
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg> 从此分支', action: () => createBranch(msgId) });
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="m12 3.5 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.7l-5.56 2.92 1.06-6.2L3 10.03l6.22-.9L12 3.5z"/></svg> 收藏剧情', action: () => collectMessage(msgId) });
      // 语音朗读：仅在对话设置开启时显示
      try {
        const _vs = _getConvSettings();
        if (_vs.voiceEnabled && typeof TTS !== 'undefined') {
          const isCur = TTS.isPlaying(msgId);
          if (isCur) {
            items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg> 停止播放', action: () => stopVoice() });
          } else {
            items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg> 播放语音', action: () => playVoiceForMessage(msgId) });
          }
        }
      } catch (_) {}
      items.push({ sep: true });
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> 多选', action: () => enterMultiSelect(msgId) });
      if (_isLatest) {
        items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 删除', action: () => deleteMessage(msgId), danger: true });
      }
    }

    items.forEach(item => {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
      } else {
        const btn = document.createElement('button');
        btn.className = 'ctx-item' + (item.danger ? ' danger' : '');
        btn.innerHTML = item.label;
        btn.onclick = (e) => { e.stopPropagation(); closeContextMenu(); item.action(); };
        menu.appendChild(btn);
      }
    });

    document.body.appendChild(menu);

    // 定位（防止超出屏幕；底部空间不足时优先向上翻）
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;

    let left = Math.min(Math.max(margin, x), maxX);
    let top = y;

    if (y + rect.height + margin > window.innerHeight) {
      top = y - rect.height;
    }

    top = Math.min(Math.max(margin, top), maxY);

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }
function closeContextMenu() {
const existing = document.getElementById('ctx-menu');
if (!existing) return;
existing.classList.add('closing');
setTimeout(() => existing.remove(), 120);
}

  // ===== 语音朗读触发 =====
  function _showVoiceMiniPlayer(state, preview) {
    const el = document.getElementById('voice-mini-player');
    if (!el) return;
    el.classList.remove('hidden', 'is-loading', 'is-playing');
    if (state === 'loading') el.classList.add('is-loading');
    else if (state === 'playing') el.classList.add('is-playing');
    const loadingIco = document.getElementById('voice-mini-icon-loading');
    const playingIco = document.getElementById('voice-mini-icon-playing');
    if (loadingIco && playingIco) {
      if (state === 'playing') {
        loadingIco.style.display = 'none';
        playingIco.style.display = '';
      } else {
        loadingIco.style.display = '';
        playingIco.style.display = 'none';
      }
    }
    const statusEl = el.querySelector('.voice-mini-status');
    if (statusEl) statusEl.textContent = state === 'playing' ? '正在朗读' : '正在准备语音…';
    const prevEl = document.getElementById('voice-mini-preview');
    if (prevEl) prevEl.textContent = preview || '';
  }

  function _hideVoiceMiniPlayer() {
    const el = document.getElementById('voice-mini-player');
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('is-loading', 'is-playing');
  }

  async function playVoiceForMessage(msgId) {
    if (typeof TTS === 'undefined') {
      UI.showAlert('未加载', '语音模块未加载');
      return;
    }
    const msg = messages.find(m => m.id === msgId);
    if (!msg) return;
    const s = _getConvSettings();
    if (!s.voiceEnabled) {
      UI.showAlert('未启用', '请先在对话设置中开启「启用语音朗读」');
      return;
    }
    const raw = msg.content || '';
    const speakText = TTS.extractSpeakingText(raw, s.voiceScope);
    if (!speakText || !speakText.trim()) {
      UI.showAlert('无内容', '当前消息没有匹配朗读范围的内容');
      return;
    }
    // 立刻显示 mini player：loading 状态 + 文本预览
    const preview = speakText.replace(/\s+/g, ' ').slice(0, 50);
    _showVoiceMiniPlayer('loading', preview);
    TTS.onFinish(() => {
      _hideVoiceMiniPlayer();
    });
    try {
      await TTS.speak(speakText, {
        msgId,
        voiceId: s.voiceId,
        onPlayStart: ({ fromCache }) => {
          _showVoiceMiniPlayer('playing', preview);
        }
      });
    } catch (e) {
      _hideVoiceMiniPlayer();
      UI.showAlert('朗读失败', e.message || '未知错误');
    }
  }

  function stopVoice() {
    if (typeof TTS !== 'undefined') TTS.stop();
    _hideVoiceMiniPlayer();
  }


// ===== 多选模式 =====
let multiSelectMode = false;
let multiSelectIds = new Set();

function isMultiSelectMode() { return multiSelectMode; }

function enterMultiSelect(initialId) {
multiSelectMode = true;
multiSelectIds = new Set();
if (initialId) multiSelectIds.add(initialId);
_renderMultiSelectBar();
_applyMultiSelectUI();
}

function exitMultiSelect() {
multiSelectMode = false;
multiSelectIds.clear();
document.getElementById('multi-select-bar')?.remove();
// 清除所有选中样式
document.querySelectorAll('.chat-msg.ms-selected').forEach(el => el.classList.remove('ms-selected'));
}

function toggleMultiSelect(id) {
if (!multiSelectMode) return;
if (multiSelectIds.has(id)) multiSelectIds.delete(id);
else multiSelectIds.add(id);
_applyMultiSelectUI();
_updateMultiSelectCount();
}

function selectAllMulti() {
if (!multiSelectMode) return;
messages.forEach(m => multiSelectIds.add(m.id));
_applyMultiSelectUI();
_updateMultiSelectCount();
}

function _applyMultiSelectUI() {
document.querySelectorAll('.chat-msg').forEach(el => {
const id = el.dataset.id;
if (!id) return;
if (multiSelectIds.has(id)) el.classList.add('ms-selected');
else el.classList.remove('ms-selected');
});
}

function _updateMultiSelectCount() {
const c = document.getElementById('ms-count');
if (c) c.textContent = `已选 ${multiSelectIds.size}`;
}

function _renderMultiSelectBar() {
if (document.getElementById('multi-select-bar')) return;
const bar = document.createElement('div');
bar.id = 'multi-select-bar';
bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:var(--bg-secondary);border-top:1px solid var(--border);padding:10px 12px;display:flex;align-items:center;gap:8px;z-index:600;flex-wrap:wrap';
bar.innerHTML = `
<span id="ms-count" style="font-size:13px;color:var(--text);flex-shrink:0">已选 ${multiSelectIds.size}</span>
<button onclick="Chat.selectAllMulti()" style="padding:6px 10px;font-size:12px;background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;cursor:pointer;flex-shrink:0">全选</button>
<div style="flex:1"></div>
<button onclick="Chat.multiExtractMemory()" style="padding:6px 12px;font-size:12px;background:var(--accent);color:#111;border:none;border-radius:6px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;gap:4px">
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z"/></svg>
提取记忆
</button>
<button onclick="Chat.multiExportImage()" style="padding:6px 12px;font-size:12px;background:var(--accent);color:#111;border:none;border-radius:6px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;gap:4px">
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
导出截图
</button>
<button onclick="Chat.exitMultiSelect()" style="padding:6px 10px;font-size:12px;background:none;border:1px solid var(--border);color:var(--text-secondary);border-radius:6px;cursor:pointer;flex-shrink:0">取消</button>
`;
document.body.appendChild(bar);
}

async function multiExtractMemory() {
if (multiSelectIds.size === 0) { UI.showToast('请先选择消息', 1800); return; }
const selected = messages.filter(m => multiSelectIds.has(m.id));
if (selected.length === 0) { UI.showToast('未找到选中的消息', 1800); return; }
// 按原对话顺序排序
selected.sort((a, b) => messages.indexOf(a) - messages.indexOf(b));
UI.showToast(`正在提取 ${selected.length} 条消息的记忆…`, 3000);
try {
await autoExtractMemory(selected, { updateLastExtracted: false });
exitMultiSelect();
} catch(e) {
GameLog.log('error', `[MultiExtract] 失败: ${e.message}`);
UI.showToast('提取失败，详情见日志', 2500);
}
}

async function multiExportImage() {
if (multiSelectIds.size === 0) { UI.showToast('请先选择消息', 1800); return; }
if (typeof html2canvas === 'undefined') { UI.showToast('截图库未加载', 2000); return; }
UI.showToast('正在生成截图…', 2500);

// 建一个临时容器
const temp = document.createElement('div');
temp.className = 'export-capture';
const theme = (typeof Theme !== 'undefined' && Theme.load) ? Theme.load() : null;
const bgImage = theme?.chatBgImage || '';
const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg') || '#0f0f0f';
temp.style.cssText = `
position:fixed;top:0;left:-10000px;width:420px;padding:16px;
background-color:${bgColor};
${bgImage ? `background-image:url(${bgImage});background-size:cover;background-position:center;` : ''}
display:flex;flex-direction:column;gap:8px;box-sizing:border-box;
`;

// 按对话顺序克隆选中的气泡
const selected = messages.filter(m => multiSelectIds.has(m.id));
selected.sort((a, b) => messages.indexOf(a) - messages.indexOf(b));

const container = document.getElementById('chat-messages');
for (const m of selected) {
const orig = container.querySelector(`.chat-msg[data-id="${m.id}"]`);
if (!orig) continue;
const clone = orig.cloneNode(true);
// 截图导出必须禁用滚动性能优化；html2canvas 对 content-visibility/contain 支持不完整，会导致文字挤压/布局错位
clone.style.contentVisibility = 'visible';
clone.style.contain = 'none';
clone.style.containIntrinsicSize = 'auto';
clone.style.animation = 'none';
clone.querySelectorAll('*').forEach(el => {
  el.style.contentVisibility = 'visible';
  el.style.contain = 'none';
  el.style.containIntrinsicSize = 'auto';
});
// 清除多选高亮
clone.classList.remove('ms-selected', 'pressing');
// 外层 wrap 为了 flex 对齐
const wrap = document.createElement('div');
wrap.style.cssText = 'display:flex;flex-direction:column;' + (m.role === 'user' ? 'align-items:flex-end' : 'align-items:flex-start');
wrap.appendChild(clone);
temp.appendChild(wrap);
}

// 底部水印
const watermark = document.createElement('div');
watermark.style.cssText = 'text-align:center;font-size:11px;color:var(--text-secondary);opacity:0.6;margin-top:12px;padding-top:8px;border-top:1px dashed var(--border)';
watermark.textContent = '— 天枢城 · 文游记录 —';
temp.appendChild(watermark);

document.body.appendChild(temp);

try {
const canvas = await html2canvas(temp, {
backgroundColor: null,
useCORS: true,
scale: 2,
logging: false
});
const dataUrl = canvas.toDataURL('image/png');
// 下载
const a = document.createElement('a');
a.href = dataUrl;
a.download = `对话截图_${Date.now()}.png`;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
UI.showToast('截图已导出', 2000);
} catch(e) {
console.error('[ExportImage]', e);
UI.showToast('截图失败：' + (e.message || '未知错误'), 3000);
} finally {
document.body.removeChild(temp);
exitMultiSelect();
}
}

// ===== 删除消息 =====

  async function deleteMessage(msgId) {
    if (!await UI.showConfirm('确认删除', '确定删除这条消息？')) return;
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0) return;

    // 判定：被删的是不是"最新一条"（非 hidden）
    let lastVisibleIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && !messages[i].hidden) { lastVisibleIdx = i; break; }
    }
    const isDeletingLatest = (idx === lastVisibleIdx);

    // 获取消息元素，添加删除动画
    const msgEl = document.querySelector(`.chat-msg[data-id="${msgId}"]`);
    if (msgEl) {
      msgEl.classList.add('delete-anim');
      // 等待动画完成
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    await DB.del('messages', msgId);
    messages.splice(idx, 1);
    roundCount = messages.filter(m => m.role === 'user').length;
    // 删最新一条时回滚状态栏（中间删消息不回滚，状态对不上是用户的责任）
    if (isDeletingLatest) {
      await _restoreStatusFromMessages();
    }
    renderAll();
    updateTokenCount();
  }

  // ===== 状态栏快照恢复（供回溯/撤回调用）=====
  // 从 messages 末尾往前找第一条带 statusSnapshot 的 AI 消息，
  // 把当前对话的 statusBar 整体回滚到那个快照（含 heartSim 任务/好感）；
  // 找不到则清空状态栏（说明回到了对话开头）。
  async function _restoreStatusFromMessages() {
    try {
      let snap = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant' && m.statusSnapshot) {
          snap = m.statusSnapshot;
          break;
        }
      }
      const restored = snap ? JSON.parse(JSON.stringify(snap)) : null;
      // 整体覆盖（包括 heartSim：剧情都回去了，好感/任务也得退回）
      await Conversations.setStatusBar(restored);
      if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(restored);
      // 心动模拟面板：让任务/心动目标 UI 跟着重渲
      try {
        if (typeof StatusBar !== 'undefined' && StatusBar._renderHS) StatusBar._renderHS();
      } catch(_) {}
      // 同步 region/在场NPC 到 NPC 模块（让速查/详情注入也跟着回滚）
      try {
        const newRegion = (restored && restored.region) ? restored.region : '';
        if (typeof NPC !== 'undefined') {
          if (NPC.setRegion) NPC.setRegion(newRegion);
          if (NPC.setPresentNPCs) NPC.setPresentNPCs(Array.isArray(restored?.npcs) ? restored.npcs.map(n => n.name).filter(Boolean) : []);
        }
      } catch(_) {}
    } catch(e) { console.warn('[Chat] 回溯状态栏失败', e); }
  }

  // ===== 回溯到此处 =====

  async function rollbackTo(msgId) {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    if (!await UI.showConfirm('确认回溯', `将删除此消息之后的所有 ${messages.length - idx - 1} 条消息，确定回溯？`)) return;

    // 删除此消息之后的所有消息
    const toDelete = messages.slice(idx + 1);
    for (const msg of toDelete) {
      await DB.del('messages', msg.id);
    }
    messages = messages.slice(0, idx + 1);
    roundCount = messages.filter(m => m.role === 'user').length;
    await _restoreStatusFromMessages();
    renderAll();
    updateTokenCount();
  }

  // ===== 回溯到此处（用户气泡，内容返回发送框） =====

  async function rollbackAndRestore(msgId) {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    const msg = messages[idx];
    const afterCount = messages.length - idx - 1;
    if (afterCount > 0 && !await UI.showConfirm('确认回溯', `将删除此消息之后的 ${afterCount} 条消息并回溯，确定？`)) return;

    // 把该消息内容放回发送框
    const input = document.getElementById('chat-input');
    if (input) {
      input.value = msg.contentForAPI || msg.content;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }

    // 删除该消息及之后所有
    const toDelete = messages.slice(idx);
    for (const m of toDelete) {
      await DB.del('messages', m.id);
    }
    messages = messages.slice(0, idx);
    roundCount = messages.filter(m => m.role === 'user').length;
    await _restoreStatusFromMessages();
    renderAll();
    updateTokenCount();
  }

  // ===== 继续生成（在AI最后一条消息后追加） =====

  async function continueGenerate(msgId) {
  const msg = messages.find(m => m.id === msgId);
  if (!msg || msg.role !== 'assistant') return;
  // 用"<Continue the Chat/>"作为隐式指令发送
  const input = document.getElementById('chat-input');
  const original = input?.value || '';
  if (input) input.value = '<Continue the Chat/>';
  await send();
  // send() 会清空输入框，不需要恢复
}

  // ===== 撤回AI回复（仅删除AI本条消息，用户输入返回发送框） =====

async function retractAI(msgId) {
  const idx = messages.findIndex(m => m.id === msgId);
  if (idx < 0 || messages[idx].role !== 'assistant') return;

  // 获取消息元素，添加撤回动画
  const msgEl = document.querySelector(`.chat-msg[data-id="${msgId}"]`);
  if (msgEl) {
    msgEl.classList.add('retract-anim');
    // 等待动画完成
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // 找到前面的用户消息
  let userMsg = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { userMsg = messages[i]; break; }
  }

  // 把用户消息内容放回发送框
  if (userMsg) {
    const input = document.getElementById('chat-input');
    if (input) {
      input.value = userMsg.contentForAPI || userMsg.content;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }
  }

  // 仅删除AI本条消息
  await DB.del('messages', msgId);
  messages = messages.filter(m => m.id !== msgId);
  roundCount = messages.filter(m => m.role === 'user').length;
  await _restoreStatusFromMessages();
  renderAll();
  updateTokenCount();
}

  // ===== 渲染 =====
  function appendMessage(msg, isPlaceholder = false, animate = false) {
    // 普通 hidden 消息不渲染；心动模拟开场客服气泡例外：可见但不进入 API 上下文
    if (msg.hidden && !msg._hsIntroBubble) return null;

    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = `chat-msg ${msg.role}`;
    div.dataset.id = msg.id;

    // 心动模拟开场客服气泡：持久显示在聊天记录里，但仍保持 hidden，不参与上下文
    if (msg._hsIntroBubble) {
      const b = msg._hsIntroBubble || {};
      const nameRaw = b.name || '客服';
      const name = Utils.escapeHtml(nameRaw);
      const initial = (nameRaw || '?')[0];
      const timeStr = Utils.escapeHtml(b.time || '');
      const avatarUrl = b.avatarImg || '';
      const avatarHtml = avatarUrl
        ? `<img src="${Utils.escapeHtml(avatarUrl)}" class="online-chat-avatar" style="object-fit:cover">`
        : `<div class="online-chat-avatar">${Utils.escapeHtml(initial)}</div>`;
      div.classList.add('hs-intro-persist');
      div.innerHTML = `
        <div class="msg-body md-content">
          <div class="online-chat-block hs-intro-chat-block">
            <div class="online-chat-divider"><span>线上消息</span></div>
            <div class="online-chat-bubble" data-npc-name="${name}" data-avatar-char="${Utils.escapeHtml(initial)}">
              <div class="online-chat-header">
                ${avatarHtml}
                <div class="online-chat-meta">
                  <div class="online-chat-name">${name}</div>
                  ${timeStr ? `<div class="online-chat-time">${timeStr}</div>` : ''}
                </div>
              </div>
              <div class="online-chat-text">${Utils.escapeHtml(b.text || '')}</div>
            </div>
          </div>
        </div>`;
      container.appendChild(div);
      if (animate) requestAnimationFrame(() => div.classList.add('send-anim'));
      // 只在主动追加（animate=true）+ 跟随状态下才自动滚；renderAll 批量调用时不滚（animate=false）
      if (animate) scrollToBottomIfFollowing();
      return div;
    }


    // 搜索高亮
    if (searchHighlight && (msg.content || '').toLowerCase().includes(searchHighlight)) {
      div.classList.add('search-hit');
    }
    if (msg.role === 'assistant') {
    if (isPlaceholder) {
      div.innerHTML = `
        <div class="msg-body md-content">
          <div class="typing-indicator"><span></span><span></span><span></span></div>
        </div>`;
    } else if (Theme.isAiBubbleRenderEnabled()) {
      // 缓存解析+渲染结果到 message 对象（不写回 DB）。
      // 内容变化时（编辑/重写/流式追加）需要清掉缓存，由对应路径负责。
      let cachedHTML = msg._cachedFullHTML;
      if (cachedHTML == null) {
        const parsed = Utils.parseAIOutput(msg.content);
        cachedHTML = buildAIMessageHTML(parsed, msg);
        try { msg._cachedFullHTML = cachedHTML; } catch(_) {}
      }
      div.innerHTML = cachedHTML;
    } else {
      let cachedPlain = msg._cachedPlainHTML;
      if (cachedPlain == null) {
        cachedPlain = `<div class="msg-body md-content">${Markdown.render(msg.content)}</div>`;
        try { msg._cachedPlainHTML = cachedPlain; } catch(_) {}
      }
      div.innerHTML = cachedPlain;
    }
    // 单人模式 AI 头像已移除（顶栏已有 + 线上消息气泡内还有，三重头像太挤）
    } else if (msg.role === 'system') {
      div.innerHTML = `<div class="msg-body md-content">${Markdown.render(msg.content)}</div>`;
      div.style.borderColor = 'var(--accent-dim)';
      div.style.background = 'rgba(196,168,124,0.08)';
    } else {
      div.innerHTML = `<div class="msg-body md-content">${Markdown.render(msg.content)}</div>`;
      // 用户头像（面具头像）
      const avatar = Character.getAvatar();
      if (avatar) {
        const avatarEl = document.createElement('img');
        avatarEl.src = avatar;
        avatarEl.className = 'msg-avatar';
        avatarEl.style.cssText = 'width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0';
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:flex-end;align-self:flex-end;max-width:95%;width:auto';
        wrapper.appendChild(avatarEl);
        wrapper.appendChild(div);
        div.style.width = 'auto';
        div.style.maxWidth = '100%';
        container.appendChild(wrapper);
      }
    }

    // 如果没有被 wrapper 包裹，直接追加
    if (!div.parentNode) container.appendChild(div);

    // 发送动画（仅在 animate=true 时触发）
    if (animate) {
      requestAnimationFrame(() => {
        div.classList.add('send-anim');
      });
    }

    // 只在主动追加（animate=true）+ 跟随状态下才自动滚；
    // renderAll 批量调用时不滚（animate=false），避免上翻浏览历史时被反复拽到底部
    if (animate) scrollToBottomIfFollowing();
    return div;
  }

  function buildAIMessageHTML(parsed, msg) {
    let html = '';
// 气泡顶部：世界观名 + 真实时间戳（装饰 + 实用）
    if (msg && msg.timestamp) {
      const d = new Date(msg.timestamp);
      const pad = n => String(n).padStart(2, '0');
      const tsStr = `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const wvPart = _currentWvName ? `<span class="msg-meta-wv">「${Utils.escapeHtml(_currentWvName)}」</span>` : '';
      html += `<div class="msg-meta"><span class="msg-meta-dot">●</span>${wvPart}<span class="msg-meta-ts">${tsStr}</span></div>`;
    }

    // 思考过程（<think>...</think>）— 默认折叠
    if (parsed.thinking) {
      html += `<div class="msg-think">
        <div class="msg-think-header" onclick="Chat._toggleThink(this)">
          <span><svg class="folder-arrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>思考过程</span>
        </div>
        <div class="msg-think-body collapsed">${Markdown.render(parsed.thinking)}</div>
      </div>`;
    }


    // 头部信息栏 — 仅旧格式展示；新格式（有 status 代码块）统一由顶部状态栏展示
    if (!parsed.status && (parsed.header.region || parsed.header.time)) {
      html += '<div class="msg-header">';
if (parsed.header.region) html += `<span class="loc"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg> ${Utils.escapeHtml(parsed.header.region)}</span>`;
        if (parsed.header.location) html += `<span class="loc">→ ${Utils.escapeHtml(parsed.header.location)}</span>`;
        if (parsed.header.time) html += `<span class="time"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> ${Utils.escapeHtml(parsed.header.time)}</span>`;
        if (parsed.header.weather) html += `<span class="weather"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg> ${Utils.escapeHtml(parsed.header.weather)}</span>`;
      html += '</div>';
    }

    // 正文
    html += `<div class="msg-body md-content">${Markdown.render(parsed.body)}</div>`;

    // 线上聊天气泡（```chat 块）：心动模拟世界观自带，其他世界观需对话设置里手动开启
    const _isHs = document.body.getAttribute('data-worldview') === '心动模拟';
    const _onlineChatEnabled = _isHs || _getConvSettings().onlineChat;
    if (parsed.chat && Array.isArray(parsed.chat) && parsed.chat.length > 0 && _onlineChatEnabled) {
      html += '<div class="online-chat-block">';
      html += '<div class="online-chat-divider"><span>线上消息</span></div>';
      for (const cm of parsed.chat) {
        const npcNameRaw = cm.npc || '???';
        const npcName = Utils.escapeHtml(npcNameRaw);
        const initial = (npcNameRaw || '?')[0];
        const msgTime = Utils.escapeHtml(cm.time || '');
        const avatarUrl = _onlineNpcAvatarMap[npcNameRaw] || '';
        const avatarHtml = avatarUrl
          ? `<img src="${Utils.escapeHtml(avatarUrl)}" class="online-chat-avatar" style="object-fit:cover">`
          : `<div class="online-chat-avatar">${Utils.escapeHtml(initial)}</div>`;
        html += `<div class="online-chat-bubble" data-npc-name="${Utils.escapeHtml(npcNameRaw)}" data-avatar-char="${Utils.escapeHtml(initial)}">
          <div class="online-chat-header">
            ${avatarHtml}
            <div class="online-chat-meta">
              <div class="online-chat-name">${npcName}</div>
              ${msgTime ? `<div class="online-chat-time">${msgTime}</div>` : ''}
            </div>
          </div>
          <div class="online-chat-text">${Utils.escapeHtml(cm.text || '')}</div>
        </div>`;
      }
      html += '</div>';
    }

    // 物品和变化
    if (parsed.items.length > 0 || parsed.changes.length > 0) {
      html += '<div class="msg-items">';
      const svgBriefcase = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;min-width:12px"><path d="M12 12h.01"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M22 13a18.15 18.15 0 0 1-20 0"/><rect width="20" height="14" x="2" y="6" rx="2"/></svg>`;
    const svgStar = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;min-width:12px"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>`;
    const svgCopy = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
    const svgPocket = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle"><path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/><path d="M16 2v3"/><path d="M8 2v3"/><path d="M12 11v4"/><path d="M10 13h4"/></svg>`;
    parsed.items.forEach(item => {
      html += `<div class="item-card">
        <div class="item-content">
          <span class="item-label">${svgBriefcase} 新获得物品</span>
          <span class="item-name">${Utils.escapeHtml(item)}</span>
        </div>
        <button class="copy-btn" onclick="event.stopPropagation();Character.addItemDirect('${Utils.escapeHtml(item).replace(/'/g, "\\'")}');" title="收入物品栏">${svgPocket}</button>
      </div>`;
    });
    parsed.changes.forEach(change => {
      html += `<div class="item-card">
        <div class="item-content">
          <span class="item-label">${svgStar} 角色变化</span>
          <span class="item-name">${Utils.escapeHtml(change)}</span>
        </div>
        <button class="copy-btn" data-copy="${Utils.escapeHtml(change)}" onclick="event.stopPropagation();Utils.copyFromDataset(this)">${svgCopy}</button>
      </div>`;
    });
      html += '</div>';
    }

    // 相关NPC标签
    if (parsed.presentNPCs && parsed.presentNPCs.length > 0) {
      html += '<div class="npc-tags">';
      parsed.presentNPCs.forEach(name => {
        html += `<span class="npc-tag">${Utils.escapeHtml(name)}</span>`;
      });
      html += '</div>';
    }

    return html;
  }

  function renderParsedMessage(el, parsed) {
    const msg = messages.find(m => m.id === el.dataset.id) || { id: el.dataset.id };
    if (Theme.isAiBubbleRenderEnabled()) {
      el.innerHTML = buildAIMessageHTML(parsed, msg);
    } else {
      el.innerHTML = `<div class="msg-body md-content">${Markdown.render(msg.content || '')}</div>`;
    }
  }

  function renderAll() {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    messages.forEach(msg => appendMessage(msg));
    updateScrollBtn();
    if (multiSelectMode) _applyMultiSelectUI();
  }

  function scrollToBottom() {
    const container = document.getElementById('chat-messages');
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
      updateScrollBtn();
    });
  }

  // 流式跟随状态：用户向上滑过就停止跟随，滚回底部附近自动恢复
  let _followBottomDuringStream = true;
  function _isNearBottom(container, threshold = 80) {
    if (!container) return true;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distance <= threshold;
  }
  // 流式专用滚动：只在用户没向上滑时才跟随
  function scrollToBottomIfFollowing() {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    if (!_followBottomDuringStream) {
      // 用户已主动滑离底部：不跟随，仅刷新 scroll btn
      updateScrollBtn();
      return;
    }
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
      updateScrollBtn();
    });
  }
  // 重置跟随状态（每轮发送时调用）
  function _resetFollowBottom() {
    _followBottomDuringStream = true;
  }

  function updateScrollBtn() {
    const container = document.getElementById('chat-messages');
    const btn = document.getElementById('scroll-to-bottom-btn');
    if (!container || !btn) return;
    // 只在聊天面板可见时显示
    const chatPanel = document.querySelector('#panel-chat.active');
    if (!chatPanel) { btn.classList.add('hidden'); return; }
    const isAtBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 100;
    if (isAtBottom) {
      btn.classList.add('hidden');
    } else {
      btn.classList.remove('hidden');
    }
  }

  function updateTopbar(parsed) {
  try {
    if (parsed.relation && typeof StatusBar !== 'undefined') {
      StatusBar.hsApplyRelation(parsed.relation);
    }
    if (parsed.tasks && typeof StatusBar !== 'undefined') {
      StatusBar.hsApplyTasks(parsed.tasks);
    }
    if (parsed.phoneLock && typeof StatusBar !== 'undefined' && StatusBar.hsApplyPhoneLock) {
      StatusBar.hsApplyPhoneLock(parsed.phoneLock);
    }
  } catch(e) { console.error('[updateTopbar]', e); }
}

  let _tokenProgressShape = '';

  function _syncTokenProgressShape() {
    const svg = document.querySelector('#token-progress svg');
    if (!svg) return;
    const isHeartSim = document.body.getAttribute('data-worldview') === '心动模拟';
    const shape = isHeartSim ? 'heart' : 'diamond';
    if (_tokenProgressShape === shape && document.getElementById('token-progress-path')) return;

    if (shape === 'heart') {
      svg.setAttribute('viewBox', '0 0 40 40');
      const heartPath = 'M20 33 L3 20 L3 12 L10 6 L16 6 L20 10 L24 6 L30 6 L37 12 L37 20 Z';
      svg.innerHTML = `
        <path d="${heartPath}" fill="none" stroke="rgba(200, 200, 200, 0.3)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        <path id="token-progress-path" d="${heartPath}" fill="none" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="0 1000"/>
      `;
    } else {
      svg.setAttribute('viewBox', '0 0 40 40');
      svg.innerHTML = `
        <polygon points="20,2 38,20 20,38 2,20" fill="none" stroke="rgba(200, 200, 200, 0.3)" stroke-width="5"/>
        <polygon id="token-progress-path" points="20,2 38,20 20,38 2,20" fill="none" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="0 1000"/>
      `;
    }
    _tokenProgressShape = shape;
  }

  function updateTokenCount() {
  (async () => {
    const total = messages.reduce((sum, m) => sum + Utils.estimateTokens(m.content), 0);
    totalTokenEstimate = total;
    
    // 更新进度条
    _syncTokenProgressShape();
    const config = await API.getConfig();
    let tokenLimit = parseInt(config.tokenLimit) || 0;
    // 心动模拟世界观：进度条按"实际触发总结的阈值"显示，让用户能看到逼近
    let isHsClamped = false;
    if (_isHeartSimWorldview()) {
      if (tokenLimit <= 0 || tokenLimit > HEARTSIM_SUMMARY_CAP) {
        tokenLimit = HEARTSIM_SUMMARY_CAP;
        isHsClamped = true;
      }
    }
    const progressPath = document.getElementById('token-progress-path');
    const textEl = document.getElementById('token-progress-text');
    const popupTextEl = document.getElementById('token-popup-text');
    
    if (progressPath && textEl && popupTextEl) {
      // tokenLimit 为 0 时，显示固定参考值（比如 4000）
      const limitRef = tokenLimit > 0 ? tokenLimit : 4000;
      const percent = Math.min(100, (total / limitRef) * 100);
      const percentInt = Math.round(percent);
      
      // 当前 SVG 图形真实周长：菱形/爱心都自动适配
      let totalPerimeter = 101.82;
      try { totalPerimeter = progressPath.getTotalLength(); } catch(_) {}
      const filledLength = totalPerimeter * (percent / 100);
      const gapLength = Math.max(0, totalPerimeter - filledLength);
      
      console.log(`[TokenProgress] total=${total}, limitRef=${limitRef}, percent=${percent}%, filledLength=${filledLength}`);
      
      progressPath.setAttribute('stroke-dasharray', `${filledLength} ${gapLength}`);
      textEl.textContent = percentInt;
      progressPath.parentElement.title = `Token: ${Math.round(total)}/${tokenLimit > 0 ? tokenLimit : '未设置'}`;
      popupTextEl.textContent = `当前窗口：${Math.round(total)}`;

      // 心动模拟：在 token 浮窗里加一行说明
      const noteEl = document.getElementById('token-popup-note');
      if (noteEl) {
        if (isHsClamped) {
          noteEl.textContent = `※ 心动模拟上下文较大，为避免卡顿/闪退，达到 ${HEARTSIM_SUMMARY_CAP} 时会自动总结`;
          noteEl.style.display = 'block';
        } else {
          noteEl.style.display = 'none';
          noteEl.textContent = '';
        }
      }
      
      // 计算所有窗口总计
      const totalEl = document.getElementById('token-popup-total');
      if (totalEl) {
        try {
          const allMsgs = await DB.getAll('messages');
          const grandTotal = allMsgs.reduce((sum, m) => sum + Utils.estimateTokens(m.content), 0);
          totalEl.textContent = `总计：${Math.round(grandTotal)}`;
        } catch(e) {
          totalEl.textContent = `总计：--`;
        }
      }
      
      // 超过阈值时变红
      if (tokenLimit > 0 && total >= tokenLimit) {
        progressPath.setAttribute('stroke', 'var(--error)');
      } else {
        progressPath.setAttribute('stroke', 'var(--accent)');
      }
    }
  })();
}

  // ===== 编辑消息 =====

  function editMessage(id) {
    const msg = messages.find(m => m.id === id);
    if (!msg) return;
    document.getElementById('msg-edit-content').value = msg.content;
    document.getElementById('msg-edit-modal').classList.remove('hidden');
    document.getElementById('msg-edit-modal').dataset.editId = id;
  }

  async function saveEdit() {
    const id = document.getElementById('msg-edit-modal').dataset.editId;
    const content = document.getElementById('msg-edit-content').value;
const msg = messages.find(m => m.id === id);
if (msg) {
msg.content = content;
// 清缓存让 renderAll 重新解析渲染
try { delete msg._cachedFullHTML; delete msg._cachedPlainHTML; } catch(_) {}
await DB.put('messages', msg);
renderAll();
}
    UI.closeMsgEditModal();
  }

  // ===== 分支 =====

  async function createBranch(fromMsgId) {
    const branchName = await UI.showSimpleInput('从此分支', '转入平行世界线');
    if (!branchName) return;

    const idx = messages.findIndex(m => m.id === fromMsgId);
    if (idx < 0) return;

    // 新建独立对话
    const newConvId = 'conv_' + Utils.uuid().slice(0, 8);
    const oldMaskId = Character.getCurrentId();
    const newMaskId = 'mask_' + Utils.uuid().slice(0, 8);

    // 1. 复制消息（含分支点那条，即 0..idx 包含）到新 convId，重置 branchId=main
    for (let i = 0; i <= idx; i++) {
      const copy = { ...messages[i], id: Utils.uuid(), branchId: 'main', conversationId: newConvId };
      await DB.put('messages', copy);
    }

    // 2. 复制面具
    await Character.cloneMask(newMaskId);

    // 3. 复制记忆库（oldMaskId -> newMaskId）
    await Memory.cloneScope(oldMaskId, newMaskId);

    // 4. 复制总结
    const oldSummary = await Summary.get(Conversations.getCurrent());
    if (oldSummary?.updatedAt) {
      const newSummary = { ...oldSummary, conversationId: newConvId };
      await Summary.save(newSummary);
    }

    // 5. 复制归档记录
    const oldArchives = await Summary.getArchives(Conversations.getCurrent());
    for (const arch of oldArchives) {
      const newArch = { ...arch, id: Utils.uuid(), conversationId: newConvId };
      await DB.put('archives', newArch);
    }

    // 6. 注册新对话到列表
    await Conversations.addBranch(newConvId, branchName.trim(), newMaskId);
  }

  // switchBranch 已废弃（分支现在是独立对话），保留接口避免旧引用报错
  async function switchBranch(branchId) {
    GameLog.log('warn', '分支已改为独立对话，请在对话列表切换');
  }

  // ===== 重新生成 =====

  // 本轮重写建议（仅对下一次 send() 生效一次，发送后立刻清空）
  let _pendingRewriteHint = '';
  let _pendingRewriteMsgId = null;

  function openRewriteHint(msgId) {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0 || messages[idx].role !== 'assistant') return;
    _pendingRewriteMsgId = msgId;
    const modal = document.getElementById('rewrite-hint-modal');
    const input = document.getElementById('rewrite-hint-input');
    if (input) input.value = '';
    if (modal) {
      modal.classList.remove('hidden');
      // 自动聚焦
      setTimeout(() => input?.focus(), 50);
    }
  }

  function closeRewriteHint() {
    _pendingRewriteMsgId = null;
    document.getElementById('rewrite-hint-modal')?.classList.add('hidden');
  }

  async function confirmRewriteHint() {
    const input = document.getElementById('rewrite-hint-input');
    const hint = String(input?.value || '').trim();
    const msgId = _pendingRewriteMsgId;
    document.getElementById('rewrite-hint-modal')?.classList.add('hidden');
    _pendingRewriteMsgId = null;
    if (!msgId) return;
    // 把 hint 暂存，由 send() 在构建 systemParts 时取走并清空
    _pendingRewriteHint = hint;
    await regenerate(msgId);
  }

  async function regenerate(msgId) {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0 || messages[idx].role !== 'assistant') return;

    // 删除这条AI消息
    await DB.del('messages', msgId);
    messages.splice(idx, 1);
    roundCount = Math.floor(messages.filter(m => m.role === 'user').length);

    // ⚠ 关键修复：把状态栏回滚到再上一条 AI 的快照
    // 之前重写时没回滚，导致旧 AI 的好感/任务/积分 delta 残留在余额里
    await _restoreStatusFromMessages();

    renderAll();

    // 找到它对应的用户消息（前一条）
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg && lastUserMsg.role === 'user') {
      // 重新构建并发送（不增加roundCount，不添加新用户消息）
      roundCount--; // send()会++，所以先--
      // 把用户消息内容放回输入框然后发送
      document.getElementById('chat-input').value = lastUserMsg.content;
      // 删掉这条用户消息，因为send会重新创建
      await DB.del('messages', lastUserMsg.id);
      messages.pop();
      await send();
    }
  }

  // ===== 附件系统 =====

  let pendingImages = []; // base64
  let pendingMemories = []; // memory objects
  let pendingWorldVoice = null; // 风闻分享内容 { mediaType, title, content, comments }
  let pendingFiles = []; // [{ name, size, content }] 纯文本文件
  let allMemoriesCache = [];
  
  function togglePlusMenu() {
    const menu = document.getElementById('plus-menu');
    if (!menu) return;
    if (menu.classList.contains('hidden')) {
      menu.classList.remove('hidden', 'closing');
    } else {
      menu.classList.add('closing');
      setTimeout(() => {
        menu.classList.remove('closing');
menu.classList.add('hidden');
        // 菜单关闭后，确保附件栏状态正确
        renderAttachments();
      }, 120);
    }
  }

  function toggleFullscreenInput() {
  const overlay = document.getElementById('fullscreen-input-overlay');
  const originalTextarea = document.getElementById('chat-input');
  const fullscreenTextarea = document.getElementById('fullscreen-input-textarea');
  const isFullscreen = !overlay.classList.contains('hidden');
  
  if (isFullscreen) {
    // 退出全屏 - 将内容同步回原输入框
    overlay.classList.add('hidden');
    originalTextarea.value = fullscreenTextarea.value;
    // 触发输入事件以确保内容更新
    originalTextarea.dispatchEvent(new Event('input'));
  } else {
    // 进入全屏 - 将内容复制到全屏输入框
    fullscreenTextarea.value = originalTextarea.value;
    overlay.classList.remove('hidden');
    // 自动聚焦
    setTimeout(() => {
      fullscreenTextarea.focus();
    }, 100);
  }
}


  function attachImage() {
    document.getElementById('plus-menu').classList.add('hidden');
    document.getElementById('image-picker').click();
  }

  // 读取本地文本文件
  function attachFile() {
    document.getElementById('plus-menu').classList.add('hidden');
    document.getElementById('file-picker').value = '';
    document.getElementById('file-picker').click();
  }

  async function onFilePicked(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    try {
      const content = await Utils.readFileAsText(file);
      const charCount = content.length;
      const tokenEst = Utils.estimateTokens(content);
      if (charCount > 20000) {
        const ok = await UI.showConfirm('文件内容较长',
          `「${file.name}」提取出约 ${Math.round(charCount / 1000)}k 字符（约 ${Math.round(tokenEst / 1000)}k token）。\n\n内容过长可能占用大量上下文窗口，导致 AI 遗忘前文或回复异常。\n\n确定要附加吗？`);
        if (!ok) return;
      }
      pendingFiles.push({ name: file.name, size: file.size, content });
      renderAttachments();
    } catch (e) {
      UI.showAlert('读取失败', e.message || '无法解析该文件');
    }
  }

  // 预览文件内容
  function previewFile(index) {
    const f = pendingFiles[index];
    if (!f) return;
    _openFilePreview(f.name, f.content);
  }

  function _openFilePreview(name, content) {
    let modal = document.getElementById('file-preview-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'file-preview-modal';
      modal.className = 'modal hidden';
      modal.innerHTML = `
        <div class="modal-content" style="max-width:640px;width:92%;max-height:80vh;display:flex;flex-direction:column">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
            <span id="file-preview-title" style="font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:12px"></span>
            <button class="btn-icon modal-corner-btn close-btn" title="关闭" onclick="document.getElementById('file-preview-modal').classList.add('hidden')">×</button>
          </div>
          <pre id="file-preview-body" style="flex:1;overflow:auto;margin:0;padding:12px 16px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;background:var(--bg);color:var(--text);font-family:ui-monospace,Menlo,Consolas,monospace"></pre>
        </div>`;
      document.body.appendChild(modal);
    }
    modal.querySelector('#file-preview-title').textContent = name;
    modal.querySelector('#file-preview-body').textContent = content;
    modal.classList.remove('hidden');
  }

  function onImagePicked(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      if (pendingImages.length >= 3) { alert('最多3张图片'); return; }
      pendingImages.push({
        base64: e.target.result,
        name: file.name,
        type: file.type
      });
      renderAttachments();
    };
    reader.readAsDataURL(file);
    input.value = '';
  }

  async function pickMemories() {
    document.getElementById('plus-menu').classList.add('hidden');
    const all = await DB.getAll('memories');
    const currentMask = Character.getCurrentId();
    allMemoriesCache = currentMask
      ? all.filter(m => m.scope === currentMask)
      : all;
    renderPickList(allMemoriesCache);
    document.getElementById('memory-pick-modal').classList.remove('hidden');
  }

  function filterPickMemories(query) {
    const q = query.toLowerCase();
    const filtered = q ? allMemoriesCache.filter(m =>
      (m.title || '').toLowerCase().includes(q) ||
      (m.content || '').toLowerCase().includes(q)
    ) : allMemoriesCache;
    renderPickList(filtered);
  }

  function renderPickList(list) {
    const container = document.getElementById('mem-pick-list');
    container.innerHTML = list.map(m => {
      const checked = pendingMemories.some(pm => pm.id === m.id);
      return `<div style="display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border)">
        <span class="mem-check-circle ${checked ? 'checked' : ''}" data-id="${m.id}" onclick="event.stopPropagation();Chat._togglePickMem('${m.id}', !this.classList.contains('checked'))" style="width:22px;height:22px;border-radius:50%;border:2px solid ${checked ? 'var(--accent)' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;cursor:pointer;${checked ? 'background:var(--accent);' : ''}">
          ${checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
        </span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--accent);display:flex;align-items:center;gap:6px">
            ${m.type === 'event'
              ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.296 3.464 3.02 3.956"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m6.18 5.276 3.1 3.899"/></svg>`
              : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/></svg>`
            }
            ${Utils.escapeHtml(m.title || '无标题')}
          </div>
          <div style="font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml((m.content || '').substring(0, 80))}</div>
        </div>
      </div>`;
    }).join('') || '<p style="color:var(--text-secondary);text-align:center;padding:12px">暂无记忆</p>';
  }

  async function _togglePickMem(id, checked) {
    if (checked) {
      if (pendingMemories.length >= 3) {
        await UI.showAlert('提示', '最多只能添加3条记忆');
        return;
      }
      const mem = allMemoriesCache.find(m => m.id === id);
      if (mem) pendingMemories.push(mem);
    } else {
      pendingMemories = pendingMemories.filter(m => m.id !== id);
    }
    renderPickList(allMemoriesCache);
  }

  function confirmPickMemories() {
    document.getElementById('memory-pick-modal').classList.add('hidden');
    renderAttachments();
  }

  function removeAttach(type, index) {
    if (type === 'image') pendingImages.splice(index, 1);
    if (type === 'memory') pendingMemories.splice(index, 1);
    if (type === 'file') pendingFiles.splice(index, 1);
    if (type === 'worldvoice') pendingWorldVoice = null;
    renderAttachments();
  }

  function renderAttachments() {
    const bar = document.getElementById('attachments-bar');
    if (pendingImages.length === 0 && pendingMemories.length === 0 && pendingFiles.length === 0 && !pendingWorldVoice) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }
    bar.classList.remove('hidden');
    let html = '';
    pendingImages.forEach((img, i) => {
      html += `<div class="attach-item">
        <img src="${img.base64}">
        <span>${Utils.escapeHtml(img.name)}</span>
        <button class="remove-attach" onclick="Chat.removeAttach('image',${i})">✕</button>
      </div>`;
    });
    pendingMemories.forEach((m, i) => {
      html += `<div class="attach-item">
        <span style="display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z" clip-rule="evenodd" /></svg>${Utils.escapeHtml(m.title || '记忆')}</span>
        <button class="remove-attach" onclick="Chat.removeAttach('memory',${i})">✕</button>
      </div>`;
    });
    pendingFiles.forEach((f, i) => {
      html += `<div class="attach-item" style="cursor:pointer" onclick="Chat.previewFile(${i})" title="点击预览">
        <span style="display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0 0 16.5 9h-1.875a1.875 1.875 0 0 1-1.875-1.875V5.25A3.75 3.75 0 0 0 9 1.5H5.625Z" clip-rule="evenodd" /></svg>${Utils.escapeHtml(f.name)}</span>
        <button class="remove-attach" onclick="event.stopPropagation();Chat.removeAttach('file',${i})">✕</button>
      </div>`;
    });
    if (pendingWorldVoice) {
      html += `<div class="attach-item">
        <span style="display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${Utils.escapeHtml(pendingWorldVoice.mediaType + '·' + pendingWorldVoice.title)}</span>
        <button class="remove-attach" onclick="Chat.removeAttach('worldvoice',0)">✕</button>
      </div>`;
    }
    bar.innerHTML = html;
  }

  // 从最近AI回复中提取游戏内日期（月和日）
  function _extractGameDate(messages) {
    // 从后往前找最近的assistant消息
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'assistant') continue;
      const text = messages[i].content || '';
      // 匹配 "X月X日" 格式
      const m = text.match(/(\d{1,2})月(\d{1,2})日/);
      if (m) return { month: parseInt(m[1]), day: parseInt(m[2]) };
    }
    return null;
  }

  // 构建节日提示（只注入时间命中的节日）
  function _buildFestivalPrompt(festivals, msgs) {
    if (!festivals || festivals.length === 0) return '';
    const gameDate = _extractGameDate(msgs || []);
    if (!gameDate) {
      // 没有游戏时间（比如第一轮），全部列出让AI自行判断
      const lines = festivals.map(f => {
        let s = `- ${f.name}（${f.date || ''}）`;
        if (f.content) s += `：${f.content}`;
        return s;
      });
      return `【世界观·节日设定】\n以下是当前世界观中的节日，请根据剧情时间判断是否需要融入：\n${lines.join('\n')}`;
    }
    // 有游戏时间，匹配当天和前后3天内的节日
    const matched = festivals.filter(f => {
      if (!f.date) return false;
      const dm = f.date.match(/(\d{1,2})月(\d{1,2})日/);
      if (!dm) return false;
      const fMonth = parseInt(dm[1]);
      const fDay = parseInt(dm[2]);
      if (fMonth !== gameDate.month) return false;
      return Math.abs(fDay - gameDate.day) <= 3;
    });
    if (matched.length === 0) return '';
    const lines = matched.map(f => {
      let s = `- ${f.name}（${f.date}）`;
      if (f.content) s += `：${f.content}`;
      return s;
    });
    return `【世界观·节日提醒】\n当前游戏时间附近有以下节日正在发生或即将到来：\n${lines.join('\n')}\n\n融入方式（不要生硬提及，而是让节日成为世界的一部分）：\n- 环境：街道装饰、商铺活动、人流变化（节假日景点商场拥挤、学生社畜讨论假期安排）\n- NPC行为：NPC可能主动做节日相关的事（如花醒节送花、誓约之日去民政局排队）\n- 旁白补充：在NPC行为或场景中自然附带一句节日习俗说明\n- 社会氛围：电视/网络/路人对话中出现节日相关话题\n根据当前场景选择最合适的方式，不必每种都用。`;
  }

  // 构建自定义设定提示（只发启用的）
function _buildCustomPrompt(customs) {
if (!customs || customs.length === 0) return '';
const enabled = customs.filter(c => c.enabled);
if (enabled.length === 0) return '';
const lines = enabled.map(c => `- ${c.name}：${c.content}`);
return `【世界观·特殊设定（当前生效）】\n${lines.join('\n')}`;
}

// 构建知识设定索引（每轮发标题列表，告诉AI有哪些条目存在）
function _buildKnowledgeIndex(knowledges) {
if (!knowledges || knowledges.length === 0) return '';
const names = knowledges.map(k => k.name).filter(Boolean);
if (names.length === 0) return '';
return `【世界观·知识条目索引】\n本世界包含以下知识条目（详情会在你或玩家提及时自动补充）：\n${names.map(n => `· ${n}`).join('\n')}\n请在剧情自然的前提下灵活引用。`;
}

// 构建知识设定提示（最近2轮对话出现关键词时触发）
function _buildKnowledgePrompt(knowledges, messages) {
if (!knowledges || knowledges.length === 0) return '';
// 取最近2轮对话（user+assistant 各算1条算半轮，简化处理：取最后4条非system）
const recent = (messages || []).filter(m => m.role !== 'system').slice(-4);
if (recent.length === 0) return '';
const scanText = recent.map(m => m.content || '').join('\n').toLowerCase();
const matched = [];
for (const k of knowledges) {
const keyStr = (k.keys || '').trim();
if (!keyStr) continue;
const keys = keyStr.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
if (keys.some(key => scanText.includes(key.toLowerCase()))) {
matched.push(k);
}
}
if (matched.length === 0) return '';
const lines = matched.map(k => `- ${k.name || '条目'}：${k.content}`);
return `【世界观·相关知识】\n（根据最近对话内容触发，请将以下信息纳入扮演时的认知）\n${lines.join('\n')}`;
}

  function setWorldview(text) {
    worldviewPrompt = text;
  }
  function getWorldviewPrompt() { return worldviewPrompt; }

  /**
   * 取消当前请求
   * 行为：保留用户消息 + 保留 AI 已流出的部分（不还原输入框）。
   * 不做：状态栏/记忆/总结/NPC 解析（输出可能不完整，跳过完整流程更稳）。
   */
  function cancelRequest() {
    if (abortController && isStreaming) {
      abortController.abort();
      GameLog.log('info', '请求已中止（保留已流出内容）');

      const container = document.getElementById('chat-messages');

      // 保留 AI 已流式输出的部分
      if (_currentAiMsg) {
        // 去掉光标
        if (_currentAiMsgEl) {
          const contentEl = _currentAiMsgEl.querySelector('.msg-body');
          if (contentEl) contentEl.classList.remove('streaming-cursor');
        }
        const partial = _currentAiMsg.content || '';
        if (partial.trim()) {
          // 写入 DB + 加入内存消息列表（注意：不做正则替换/状态栏/记忆/NPC，输出不完整）
          _currentAiMsg.timestamp = Utils.timestamp();
          DB.put('messages', _currentAiMsg).catch(e => GameLog.log('warn', `保存中止AI消息失败: ${e.message}`));
          // 防止 send() 流程后续再 push 一次（虽然 AbortError 会走 resolve 退出，但 send 后续不再写库；这里 push 是为了让消息进入 messages 列表参与下一轮上下文）
          if (!messages.find(m => m.id === _currentAiMsg.id)) {
            messages.push(_currentAiMsg);
          }
          GameLog.log('info', `已保留AI部分内容: ${partial.length}字`);
        } else {
          // 空内容：移除占位气泡 + 删 DB（如果有）
          const aiEl = container?.querySelector(`.chat-msg[data-id="${_currentAiMsg.id}"]`);
          if (aiEl) aiEl.remove();
          DB.del('messages', _currentAiMsg.id).catch(() => {});
        }
      } else {
        // fallback：兜底清掉 typing-indicator
        const placeholder = container?.querySelector('.typing-indicator');
        if (placeholder) placeholder.closest('.chat-msg')?.remove();
      }

      // 直接重置所有状态——不等 send() 的 await 了
      isStreaming = false;
      abortController = null;
      _cancelledMsgId = null;
      _currentAiMsgId = null;
      _currentAiMsg = null;
      _currentAiMsgEl = null;
      updateSendButton(false);
      try {
        const list = (typeof Conversations !== 'undefined') ? Conversations.getList() : [];
        list.forEach(c => { try { Conversations.setStreaming(c.id, false); } catch(_) {} });
      } catch(_) {}
    }
  }

  /**
   * 更新发送按钮状态
   */
  function updateSendButton(isSending) {
    const btn = document.getElementById('btn-send');
    if (!btn) return;

    if (isSending) {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:20px;height:20px"><path fill-rule="evenodd" d="M5.47 5.47a.75.75 0 0 1 1.06 0L12 10.94l5.47-5.47a.75.75 0 1 1 1.06 1.06L13.06 12l5.47 5.47a.75.75 0 1 1-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 0 1-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>';
      btn.style.background = 'var(--danger)';
      btn.style.color = '#fff';
      btn.onclick = cancelRequest;
      btn.disabled = false;
    } else {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>';
      btn.style.background = 'var(--accent)';
      btn.style.color = '#111';
      btn.onclick = send;
      btn.disabled = false;
    }
  }

  /**
   * 查看完整上下文（调试用）
   */
  async function showContext() {
    const systemParts = [];
    const gaidenSettings = Gaiden.getCurrentGaidenSettings();
    const isGaidenConv = !!gaidenSettings;
    const singleSettings = (typeof SingleMode !== 'undefined') ? SingleMode.getCurrentSingleSettings() : null;
    const isSingleConv = !!singleSettings;
    const convSettings = _getConvSettings();
    const isGameMode = convSettings.gameMode;

    // 单人模式：加载该 conv 绑定的世界观数据
    let singleWv = null;
    if (isSingleConv && singleSettings.worldviewId) {
      try {
        singleWv = await DB.get('worldviews', singleSettings.worldviewId);
        if (singleWv) {
          const flatNpcs = [], flatFacs = [], flatRegions = [];
          (singleWv.regions || []).forEach(r => {
            flatRegions.push({ id: r.id, name: r.name, summary: r.summary, detail: r.detail, aliases: r.aliases });
            (r.factions || []).forEach(f => {
              flatFacs.push({ ...f, regionName: r.name, regionId: r.id });
              (f.npcs || []).forEach(n => {
                flatNpcs.push({ ...n, faction: f.name, regions: [r.id || r.name] });
              });
            });
          });
          NPC.init({ npcs: flatNpcs, factions: flatFacs, regions: flatRegions });
        }
      } catch(e) {}
    }

    // 1. 世界观
    if (isGameMode && !isSingleConv) {
      if (!isGaidenConv) {
        if (worldviewPrompt) systemParts.push(worldviewPrompt);
      } else {
        if (gaidenSettings.inheritWv && worldviewPrompt) {
          systemParts.push(worldviewPrompt);
        }
        if (gaidenSettings.gaidenBg) {
          let gaidenPrompt = `【番外世界线设定】\n本对话为番外世界线，以下是用户提供的番外背景设定。这是本对话的第一优先级，所有叙述和角色行为都以此为准。`;
          if (gaidenSettings.inheritWv || gaidenSettings.inheritNpc) {
            gaidenPrompt += `\n上面的原世界观设定和角色信息仅作为参考，请根据番外背景的需要自行调整、取舍或重新诠释，不要让原设定与番外背景产生矛盾。`;
          }
          gaidenPrompt += `\n\n${gaidenSettings.gaidenBg}`;
          systemParts.push(gaidenPrompt);
        }
      }
    } else if (isSingleConv && isGameMode && singleWv && singleWv.setting) {
      systemParts.push(singleWv.setting);
    }

    // 1c. 单人模式：AI扮演角色资料
    if (isSingleConv) {
      const mainCharText = await SingleMode.getMainCharPrompt(singleSettings);
      if (mainCharText) systemParts.push(mainCharText);
    } else if (isGameMode && !isGaidenConv) {
      // 1c'. 群像模式：叙事者元 prompt
      systemParts.push(`【AI 扮演角色】
本对话为群像模式（多角色剧情）。你是"叙事者 + 所有 NPC 的扮演者"，用户扮演"{{user}}"。
你应该：
1. 通过场景描写、NPC 对话和环境互动推进剧情，把"用户角色卡"作为玩家的身份资料理解，不要把用户角色卡本身当成需要你扮演的对象。
2. 描写"{{user}}"时使用第二人称"你"或玩家姓名，保留代入感；描写 NPC 时使用第三人称（"他/她/Ta" 或名字）。
3. 根据场景需要让 NPC 自然登场，不必所有 NPC 都登场。
4. 当你看到带【】框起来 + OOC 标记的系统注入信息（例如【玩家手机操作记录｜OOC】），请理解这些是"系统旁白"，主体是"{{user}}"（玩家本人），不是任何 NPC。`);
    }

    // 1d. 挂载角色（对话级常驻）
    try {
      if (window.AttachedChars) {
        const attachedPrompt = await AttachedChars.buildPrompt();
        if (attachedPrompt) systemParts.push(attachedPrompt);
      }
    } catch(e) {}

    // 1b. 剧情总结
    const summaryText = await Summary.formatForPrompt(Conversations.getCurrent());
    if (summaryText) systemParts.push(summaryText);
    // 2. 输出格式
    if (isGameMode && convSettings.format) {
      systemParts.push(OUTPUT_FORMAT_PROMPT);
      if (convSettings.onlineChat && document.body.getAttribute('data-worldview') !== '心动模拟') {
        systemParts.push(ONLINE_CHAT_BLOCK_PROMPT);
      }
    }


    // 2a. 上一轮状态面板
    if (isGameMode && convSettings.format) {
      try {
        const curStatus = Conversations.getStatusBar();
        const statusText = Utils.serializeStatus(curStatus);
        if (statusText) {
          systemParts.push('【上一轮状态面板】\n以下是当前场景的状态快照。你下一次回复的 `status` 代码块应基于此更新：未发生变化的字段请原样抄回；有变化则写新值。\n\n```status\n' + statusText + '\n```');
        }
      } catch(e) {}
    }

    // 2b. 开场引导
    if (isGameMode && !isGaidenConv && !isSingleConv) {
      try {
        const wv = await Worldview.getCurrent();
        if (wv) {
          const rounds = wv.startPlotRounds || 5;
          const userMsgCount = messages.filter(m => m.role === 'user').length;
          if (userMsgCount < rounds) {
            let startParts = [];
            if (wv.startTime) startParts.push(`开场时间：${wv.startTime}。第一轮的时间必须从此刻开始。`);
            if (wv.startPlot) startParts.push(`开场剧情指令：${wv.startPlot}`);
            if (startParts.length > 0) {
              systemParts.push(`【开场引导（前${rounds}轮生效）】\n${startParts.join('\n')}`);
            }
          }
        }
      } catch(e) { console.warn('[showContext] startPlot失败', e); }
    } else if (isSingleConv && isGameMode && singleWv && singleSettings.enableStartPlot) {
      try {
        const rounds = singleWv.startPlotRounds || 5;
        const userMsgCount = messages.filter(m => m.role === 'user').length;
        if (userMsgCount < rounds) {
          let startParts = [];
          if (singleWv.startTime) startParts.push(`开场时间：${singleWv.startTime}。第一轮的时间必须从此刻开始。`);
          if (singleWv.startPlot) startParts.push(`开场剧情指令：${singleWv.startPlot}`);
          if (startParts.length > 0) {
            systemParts.push(`【开场引导（前${rounds}轮生效）】\n${startParts.join('\n')}`);
          }
        }
      } catch(e) {}
    }

    // 3. 角色卡（非文游模式跳过）
const char = await Character.get();
if (isGameMode && char) systemParts.push(Character.formatForPrompt(char));

// 3b. 速查表
if (isGameMode && !isSingleConv && (!isGaidenConv || gaidenSettings.inheritNpc)) {
      const quickRef = NPC.formatQuickRef();
      if (quickRef) systemParts.push(quickRef);
    } else if (isSingleConv && isGameMode && singleWv) {
      const quickRef = NPC.formatQuickRef({ includeNpc: singleSettings.enableNpc });
      if (quickRef) systemParts.push(quickRef);
    }

    // 3c. 知识条目索引
    if (isGameMode) {
    try {
    const wvForIndex = isSingleConv ? singleWv : await Worldview.getCurrent();
    const sendKnowledgeIdx2 = isSingleConv ? !!singleSettings.enableKnowledge : true;
    if (wvForIndex && sendKnowledgeIdx2) {
          const idx = _buildKnowledgeIndex(wvForIndex.knowledges || []);
          if (idx) systemParts.push(idx);
        }
      } catch (e) {}
    }

    // 4. 当前区域NPC detail
    const region = NPC.getRegion();
    if (isGameMode && !isSingleConv && (!isGaidenConv || gaidenSettings.inheritNpc)) {
      const npcPrompt = NPC.formatForPrompt(region);
      if (npcPrompt) systemParts.push(npcPrompt);

      // 4b. 在场NPC
      const presentNPCPrompt = NPC.formatPresentForPrompt(region);
      if (presentNPCPrompt) systemParts.push(presentNPCPrompt);
    } else if (isSingleConv && isGameMode && singleWv && singleSettings.enableDetail) {
      const npcPrompt = NPC.formatForPrompt(region, { includeNpc: singleSettings.enableNpc });
      if (npcPrompt) systemParts.push(npcPrompt);
      if (singleSettings.enableNpc) {
        const presentNPCPrompt = NPC.formatPresentForPrompt(region);
        if (presentNPCPrompt) systemParts.push(presentNPCPrompt);
      }
    }

    // 4c. 全图 NPC
    // 单人模式必须遵守 enableNpc：未启用 NPC 时，连全图常驻 NPC 也不注入。
    if (isGameMode && (!isSingleConv || singleSettings.enableNpc)) {
      try {
        let _wvForGlobal = null;
        if (isSingleConv && singleWv) {
          _wvForGlobal = singleWv;
        } else if (!isGaidenConv || (gaidenSettings && gaidenSettings.inheritNpc)) {
          const curWvId = Worldview.getCurrentId && Worldview.getCurrentId();
          if (curWvId && curWvId !== '__default_wv__') {
            _wvForGlobal = await DB.get('worldviews', curWvId);
          }
        }
        const gs = (_wvForGlobal && _wvForGlobal.globalNpcs) || [];
        if (gs.length > 0) {
          const text = '【全图常驻 NPC】\n以下 NPC 不受地区限制，在本世界观下全程常驻，随时可以出现在任何场景中。\n\n' +
            gs.map(n => {
              const head = n.aliases ? `${n.name}（${n.aliases}）` : (n.name || '未命名');
              return n.detail ? `${head}\n${n.detail}` : head;
            }).join('\n\n---\n\n');
          systemParts.push(text);
        }
      } catch(e) {}
    }

    // 5. 记忆 — 仅文游模式
    let relatedMemories = [];
    if (isGameMode) {
      const recentText = messages.slice(-4).map(m => m.content).join(' ');
      const presentNPCs = NPC.getPresentNPCs();
      const currentLoc = NPC.getRegion();
      relatedMemories = await Memory.retrieve(recentText, presentNPCs, currentLoc);
      const memoryPrompt = Memory.formatForPrompt(relatedMemories);
      if (memoryPrompt) systemParts.push(memoryPrompt);
    }

    // 6. 提示词注入
    const injections = await Prompts.buildInjections();
    if (injections.systemTop.length > 0) systemParts.unshift(...injections.systemTop);
    if (injections.systemBottom.length > 0) systemParts.push(...injections.systemBottom);

    // 7. 现实时间感知
    if (convSettings.timeAware && window.TimeAwareness) {
      try {
        const { lastAssistantTs, lastUserTs } = TimeAwareness.extractTimestamps(messages);
        systemParts.push(TimeAwareness.buildPrompt(lastAssistantTs, lastUserTs));
      } catch(e) {}
    }

// 8. 心动模拟：累计状态注入（调试预览与实际发送保持一致）
      let _hsHomecomingDbg = false;
      try {
        if (typeof Phone !== 'undefined' && Phone.isHsHomecomingTriggered) {
          _hsHomecomingDbg = await Phone.isHsHomecomingTriggered();
        }
      } catch(_) {}
      if (_hsHomecomingDbg) {
        systemParts.push('[心动模拟·已返航]\n玩家已结束心动模拟，从原本的世界醒来，回到了自己家中。后续剧情发生在玩家自己的家里：\n- 不再有任务系统、好感度系统、心动目标的概念；\n- 心动模拟APP仍在玩家手机里、客服历史也都还在，但服务已结束；\n- 玩家可能产生与心动模拟有关的回忆、错觉、梦境，请保持一种"刚结束的事其实没有完全结束"的微妙氛围，但不要主动制造惊吓，靠玩家追问或主动行为来推进；\n- 不要再在回复中输出 ```relation``` / ```task``` / ```chat``` / ```homecoming``` 等心动模拟专用代码块。');
      } else if (typeof StatusBar !== 'undefined' && StatusBar.hsFormatForPrompt) {
        try {
          const hsStateText = StatusBar.hsFormatForPrompt();
          if (hsStateText) systemParts.push(hsStateText);
        } catch(e) { console.warn('[showContext] 心动模拟累计状态注入失败', e); }
      }
      try {
        if (!_hsHomecomingDbg && typeof StatusBar !== 'undefined' && StatusBar.hsCheckClearCondition) {
          const chk = StatusBar.hsCheckClearCondition();
          if (chk && chk.passed) {
            systemParts.push('[心动模拟·返航触发协议]\n玩家已达成回家条件。当玩家在剧情里真正回到自己原本的世界、彻底从心动模拟中醒来后，请在该轮回复的最末尾追加一个空的 ```homecoming``` 代码块作为信号——前端识别到该信号后会接管展示返航过场动画。该 marker 一旦输出过一次，前端会接管后续展示，不需要再重复输出。');
          }
        }
      } catch(_) {}

    // 8b. 心动模拟：黑化阈值警告注入（调试预览与实际发送保持一致）
    if (typeof StatusBar !== 'undefined' && StatusBar.hsGetDarknessWarnings) {
      try {
        const warnings = StatusBar.hsGetDarknessWarnings(false);  // 预览：不动标记
        if (warnings.length > 0) {
          const warnText = warnings.map(w => w.text).join('\n');
          systemParts.push(`【心动模拟·系统提醒】\n${warnText}`);
          const phoneWarns = warnings.filter(w => w.level === 'phone');
          if (phoneWarns.length > 0 && window.Phone && Phone.buildPhoneDataForAI) {
            try {
              const phoneData = await Promise.race([
                Phone.buildPhoneDataForAI({ includeShopping: true }),
                new Promise(resolve => setTimeout(() => resolve(''), 3000))
              ]);
              if (phoneData) systemParts.push(`【${phoneWarns[0].name}正在查看用户手机，以下是手机内容（包含饿了咪/桃宝的搜索与订单记录——这是平时不会暴露的隐私）】\n${phoneData}`);
            } catch(e) {
              console.warn('[showContext] 黑化查手机数据注入失败，已跳过', e);
            }
          }
        }
      } catch(_) {}
    }

    let historyForAPI = messages.filter(m => !m.hidden).map(m => ({
      role: m.role,
      content: m.contentForAPI || m.content
    }));
    if (convSettings.timeAware && window.TimeAwareness) {
      try { historyForAPI = TimeAwareness.stampUserMessages(historyForAPI, messages); } catch(e) {}
    }

    // 心动模拟：每轮贴近最新用户消息的数值规则提醒（调试预览与实际发送保持一致）
    try {
      const conv = Conversations.getList()?.find(c => c.id === Conversations.getCurrent());
      const isHeartSimConv = document.body?.getAttribute('data-worldview') === '心动模拟'
        || conv?.worldviewId === 'wv_heartsim'
        || conv?.singleWorldviewId === 'wv_heartsim';
      if (isHeartSimConv) {
        const idx = [...historyForAPI].map((m, i) => ({ m, i })).reverse().find(x => x.m.role === 'user')?.i;
        if (idx !== undefined) {
          const hsRule = `[心动模拟·本轮数值规则]\nrelation只记录本轮实际发生变化的心动目标，表示本轮增量，不是当前总值。\naffinity 与 darkness 每次单项变动必须在 -5 到5之间；没有在本轮直接互动、被明确影响或受到明确剧情刺激的目标，不要写入 relation。\n禁止为了推进进度而批量给所有心动目标加分。
任务更新规则：tasks 只表示本轮任务变更，不是完整任务历史；当前仍有 active 任务时，本轮只能把现有任务标记为 active/done/skipped，禁止发布新的 active 任务；done/skipped 是结算事件，系统加减积分后会从任务栏移除，不需要下一轮继续输出；当任务栏没有 active 任务时，下一轮才允许发布新一批 active 任务，同一批最多3个。`;
          historyForAPI[idx] = { ...historyForAPI[idx], content: `${hsRule}\n\n${historyForAPI[idx].content}` };
        }
      }
    } catch(e) { console.warn('[showContext] 心动模拟数值规则注入失败', e); }

    const apiMessages = await API.buildMessages(historyForAPI, systemParts);

    // 深度注入
    if (Object.keys(injections.depths).length > 0) {
      for (const [depthStr, contents] of Object.entries(injections.depths)) {
        const depth = parseInt(depthStr);
        const insertIdx = apiMessages.length - depth;
        if (insertIdx > 0 && insertIdx <= apiMessages.length) {
          for (const c of contents.reverse()) {
            apiMessages.splice(insertIdx, 0, { role: 'system', content: c });
          }
        }
      }
    }

    // 节日/自定义（depth 0 注入）
    if (isGameMode) {
      try {
        const currentWv = isSingleConv ? singleWv : await Worldview.getCurrent();
        if (currentWv) {
          const sendFestival = isSingleConv ? !!singleSettings.enableFestival : true;
const sendCustom = isSingleConv ? !!singleSettings.enableCustom : true;
const sendKnowledge = isSingleConv ? !!singleSettings.enableKnowledge : true;
const festivalText = sendFestival ? _buildFestivalPrompt(currentWv.festivals || [], messages) : '';
const customText = sendCustom ? _buildCustomPrompt(currentWv.customs || []) : '';
const knowledgeText = sendKnowledge ? _buildKnowledgePrompt(currentWv.knowledges || [], messages) : '';
const timeSensitive = [festivalText, customText, knowledgeText].filter(Boolean).join('\n\n');
if (timeSensitive) {
const insertIdx = apiMessages.length - 1;
if (insertIdx > 0) {
apiMessages.splice(insertIdx, 0, { role: 'system', content: timeSensitive });
}
}
        }
      } catch(e) { console.warn('[showContext] 节日注入失败:', e); }
    }

    // 手机操作日志：读最后一条 user 的 phoneLogSnapshot（与发送主流程对齐）
    try {
      const _lastUserMsg = [...messages].reverse().find(m => m.role === 'user' && !m.hidden);
      const _snapshot = _lastUserMsg?.phoneLogSnapshot;
      if (_snapshot && _snapshot.length > 0) {
        const _phoneLogContent = '【玩家手机操作记录｜OOC】\n以下是"{{user}}"本轮在自己手机里的操作，由系统旁白记录，不是角色对白，也不是任何一方的剧情发言：\n\n' +
          _snapshot.map(a => `- {{user}} ${a}`).join('\n') +
          '\n\n请把这些操作作为"{{user}}"本轮的背景行为融入剧情：\n① 操作主体永远是"{{user}}"，不是任何被扮演的角色。\n② 如果世界观设有日常任务，请据此判断任务完成度——只有"新增"算完成，"删除/更新"不算。\n③ 如果操作涉及其他角色（比如点赞/评论某人动态、给某人下单），相关角色应在合适时机收到提示并自然回应；若当前情境不适合看手机，可由旁白提及"手机震了一下稍后才查看"。\n④ 如果操作与剧情无关，作为背景知晓即可，不必每条都回应。';
        const insertIdx = apiMessages.length - 1;
        if (insertIdx >= 0) {
          apiMessages.splice(insertIdx, 0, { role: 'system', content: _phoneLogContent });
        }
      }
    } catch(_) {}

    // 宏替换：{{user}} → 当前面具角色名；{{char}} → 单人卡角色名（如有）
    {
      const _mc = await Character.get();
      const _mu = _mc?.name || '玩家';
      let _mch = '';
      try {
        const _ss = (typeof SingleMode !== 'undefined' && SingleMode.getCurrentSingleSettings)
          ? SingleMode.getCurrentSingleSettings() : null;
        if (_ss && _ss.charId) {
          if (_ss.charType === 'card') {
            const _sc = await SingleCard.get(_ss.charId);
            if (_sc && _sc.name) _mch = _sc.name;
          } else if (_ss.charType === 'npc') {
            const _wvId = _ss.charSourceWvId || _ss.worldviewId;
            if (_wvId) {
              const _wv = await DB.get('worldviews', _wvId);
              if (_wv) {
                outer: for (const r of (_wv.regions || [])) {
                  for (const f of (r.factions || [])) {
                    for (const n of (f.npcs || [])) {
                      if (n.id === _ss.charId) { _mch = n.name; break outer; }
                    }
                  }
                }
              }
            }
          }
        }
      } catch(_) {}
      for (const m of apiMessages) {
        if (m.content && typeof m.content === 'string') {
          if (m.content.includes('{{user}}')) m.content = m.content.replaceAll('{{user}}', _mu);
          if (_mch && m.content.includes('{{char}}')) m.content = m.content.replaceAll('{{char}}', _mch);
        }
      }
    }

    const totalTokens = apiMessages.reduce((sum, m) => sum + Utils.estimateTokens(m.content), 0);

    const content = apiMessages.map((m, i) => {
      return `[${i}] role=${m.role} (~${Utils.estimateTokens(m.content)}tk)\n${m.content}`;
    }).join('\n\n' + '='.repeat(60) + '\n\n');

    document.getElementById('edit-content').value =
      `=== 上下文预览 ===\n消息数: ${apiMessages.length}\n总Token估算: ~${totalTokens}\n当前轮数: ${roundCount}\n当前分支: ${currentBranchId}\n当前区域: ${NPC.getRegion()}\n文游模式: ${isGameMode ? '开' : '关'}\n流式输出: ${convSettings.stream ? '开' : '关'}\n回复格式: ${convSettings.format ? '开' : '关'}\n番外对话: ${isGaidenConv ? '是' : '否'}\n命中记忆: ${relatedMemories.length}条\n\n${'='.repeat(50)}\n\n${content}`;
    document.getElementById('edit-modal').classList.remove('hidden');
    document.getElementById('edit-modal').dataset.editId = '__debug__';
    if (typeof UI !== 'undefined' && UI.switchDebugTab) {
      UI.switchDebugTab('debug-context');
    }
  }

  // ===== 聊天搜索 =====

  let searchHighlight = '';

  function toggleSearchBar() {
    const bar = document.getElementById('chat-search-bar');
    bar.classList.toggle('hidden');
    if (!bar.classList.contains('hidden')) {
      document.getElementById('chat-search-input').focus();
    } else {
      // 关闭时清除搜索
      document.getElementById('chat-search-input').value = '';
      searchHighlight = '';
      renderAll();
    }
  }

  function searchMessages(query) {
    searchHighlight = query.trim().toLowerCase();
    renderAll();
    // 滚动到第一条匹配
    if (searchHighlight) {
      const firstMatch = document.querySelector('.chat-msg.search-hit');
      if (firstMatch) firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ===== 快速切换渲染 =====

  async function renderQuickSwitches() {
    // 刷新底部切换按钮文字
    const apiBtn = document.getElementById('curr-preset-name');
    if (apiBtn) apiBtn.textContent = Settings.getCurrent().name || '预设';

    const maskBtn = document.getElementById('curr-mask-name');
    if (maskBtn) {
      const maskData = await DB.get('gameState', 'maskList');
      const masks = maskData?.value || [{ id: 'default', name: '默认面具' }];
      const m = masks.find(x => x.id === Character.getCurrentId());
      maskBtn.textContent = m?.name || '面具';
    }
  }

  function getMessages() { return messages; }
  function getBranchId() { return currentBranchId; }
  
  // 供WorldVoice调用：挂载分享内容为附件
  function setWorldVoiceAttach(data) {
    pendingWorldVoice = data; // { mediaType, title, content, comments }
    renderAttachments();
  }

  // 收藏AI消息到收藏库
  async function collectMessage(msgId) {
    const msg = messages.find(m => m.id === msgId);
    if (!msg) return;
    const content = msg.content || '';
    const preview = content.substring(0, 80);
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const saved = {
      id: 'msg_' + Utils.uuid().slice(0, 8),
      type: 'message',
      title: preview || '收藏剧情',
      content: content,
      sourceConv: Conversations.getCurrent(),
      sourceConvName: conv?.name || '',
      savedAt: Date.now()
    };
    const data = await DB.get('gameState', 'gaidenList');
    const list = data?.value || [];
    list.unshift(saved);
    await DB.put('gameState', { key: 'gaidenList', value: list });
    Gaiden.addToList(saved);
    UI.showToast('已收藏到收藏库');
  }

  // ===== 对话设置（流式输出 / 文游模式）=====

  function _getConvSettings() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const voice = conv?.convVoice || {};
    return {
      stream: conv?.convStream !== false,      // 默认开
      gameMode: conv?.convGameMode !== false,   // 默认开
      format: conv?.convFormat !== false,       // 默认开
      backstage: !!conv?.backstageEnabled,      // 默认关
      timeAware: !!conv?.convTimeAware,         // 默认关
      onlineChat: !!conv?.convOnlineChat,       // 默认关（线上消息气泡）
      voiceEnabled: !!voice.enabled,
      voiceId: voice.voiceId || '',
      voiceScope: {
        all: !!voice.scopeAll,
        quotes: Array.isArray(voice.quotes) ? voice.quotes : []
      },
      bgImage: conv?.convBgImage || ''
    };
  }

  function _onVoiceEnabledChange() {
    const enabled = document.getElementById('cs-voice-enabled').checked;
    const opts = document.getElementById('cs-voice-options');
    if (opts) opts.style.display = enabled ? 'flex' : 'none';
  }

  function _onVoiceScopeAllChange() {
    const all = document.getElementById('cs-voice-scope-all').checked;
    document.querySelectorAll('.cs-voice-quote-cb').forEach(cb => {
      cb.disabled = all;
      cb.closest('.cs-voice-quote-opt').style.opacity = all ? '0.4' : '1';
    });
  }

  // 对话级背景图：上传 + 清除
  let _pendingConvBg = null; // 弹窗内的暂存值，保存时才落到 conv 上
  function _onConvBgPicked(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const raw = e.target.result;
      const img = new Image();
      img.onload = () => {
        // 压缩到 max 1200px 宽/高，JPEG 0.7（与主题级背景图保持一致）
        const MAX = 1200;
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > MAX || h > MAX) {
          const ratio = Math.min(MAX / w, MAX / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        if (dataUrl.length > 2_000_000) {
          UI.showToast('图片过大，请选择更小的图片', 2500);
          return;
        }
        _pendingConvBg = dataUrl;
        const preview = document.getElementById('cs-bg-preview');
        if (preview) {
          preview.src = dataUrl;
          preview.style.display = 'block';
        }
        const clearBtn = document.getElementById('cs-bg-clear');
        if (clearBtn) clearBtn.style.display = 'inline-flex';
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  }
  function _onConvBgClear() {
    _pendingConvBg = '';
    const preview = document.getElementById('cs-bg-preview');
    if (preview) {
      preview.src = '';
      preview.style.display = 'none';
    }
    const clearBtn = document.getElementById('cs-bg-clear');
    if (clearBtn) clearBtn.style.display = 'none';
  }

  function openConvSettingsModal() {
    const s = _getConvSettings();
    document.getElementById('cs-stream').checked = s.stream;
    document.getElementById('cs-gamemode').checked = s.gameMode;
    document.getElementById('cs-format').checked = s.format;
    document.getElementById('cs-backstage').checked = s.backstage;
    const ta = document.getElementById('cs-time-aware');
    if (ta) ta.checked = s.timeAware;
    const oc = document.getElementById('cs-online-chat');
    if (oc) oc.checked = s.onlineChat;
    // 语音
    const ve = document.getElementById('cs-voice-enabled');
    if (ve) {
      ve.checked = s.voiceEnabled;
      const opts = document.getElementById('cs-voice-options');
      if (opts) opts.style.display = s.voiceEnabled ? 'flex' : 'none';
      const vid = document.getElementById('cs-voice-id');
      if (vid) vid.value = s.voiceId || '';
      const all = document.getElementById('cs-voice-scope-all');
      if (all) all.checked = !!s.voiceScope.all;
      const qList = ['cjk-double', 'cjk-bracket', 'ascii-double', 'cjk-single'];
      qList.forEach(k => {
        const cb = document.getElementById('cs-voice-scope-' + k);
        if (cb) cb.checked = (s.voiceScope.quotes || []).includes(k);
      });
      _onVoiceScopeAllChange();
    }
    // 对话级背景图
    _pendingConvBg = null; // null = 沿用 conv 原值，'' = 清除，dataUrl = 新选
    const preview = document.getElementById('cs-bg-preview');
    const clearBtn = document.getElementById('cs-bg-clear');
    if (preview) {
      preview.src = s.bgImage || '';
      preview.style.display = s.bgImage ? 'block' : 'none';
    }
    if (clearBtn) clearBtn.style.display = s.bgImage ? 'inline-flex' : 'none';
    document.getElementById('conv-settings-modal').classList.remove('hidden');
  }

  async function saveConvSettings() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) return;
    conv.convStream = document.getElementById('cs-stream').checked;
    conv.convGameMode = document.getElementById('cs-gamemode').checked;
    conv.convFormat = document.getElementById('cs-format').checked;
    const wasBackstage = !!conv.backstageEnabled;
    conv.backstageEnabled = document.getElementById('cs-backstage').checked;
    const taEl = document.getElementById('cs-time-aware');
    if (taEl) conv.convTimeAware = taEl.checked;
    const ocEl = document.getElementById('cs-online-chat');
    if (ocEl) conv.convOnlineChat = ocEl.checked;
    // 语音
    const ve = document.getElementById('cs-voice-enabled');
    if (ve) {
      const qList = ['cjk-double', 'cjk-bracket', 'ascii-double', 'cjk-single'];
      const quotes = qList.filter(k => document.getElementById('cs-voice-scope-' + k)?.checked);
      conv.convVoice = {
        enabled: ve.checked,
        voiceId: (document.getElementById('cs-voice-id')?.value || '').trim(),
        scopeAll: !!document.getElementById('cs-voice-scope-all')?.checked,
        quotes
      };
    }
    // 对话级背景图：_pendingConvBg !== null 时才覆盖（null = 没动）
    if (_pendingConvBg !== null) {
      conv.convBgImage = _pendingConvBg || '';
    }
    // 应用到当前页面
    try {
      if (typeof Theme !== 'undefined' && Theme.setConvBgOverride) {
        Theme.setConvBgOverride(conv.convBgImage || '');
      }
    } catch(_) {}
    await Conversations.saveList();
    closeConvSettingsModal();
    // 更新后台悬浮按钮
    if (typeof Backstage !== 'undefined') Backstage.updateFab();
    // 如果刚开启后台，弹出要求编辑面板
    if (!wasBackstage && conv.backstageEnabled && typeof Backstage !== 'undefined') {
      Backstage.openPromptEdit();
    }
    UI.showToast('对话设置已保存');
  }

  function closeConvSettingsModal() {
    document.getElementById('conv-settings-modal')?.classList.add('hidden');
  }

  function _toggleThink(headerEl) {
    const arrow = headerEl.querySelector('.folder-arrow');
    const body = headerEl.nextElementSibling;
    if (!body) return;
    if (body.classList.contains('collapsed')) {
      body.classList.remove('collapsed');
      arrow?.classList.add('expanded');
    } else {
      body.classList.add('collapsed');
      arrow?.classList.remove('expanded');
    }
  }

  return {
    loadHistory, send, cancelRequest, editMessage, saveEdit,
    createBranch, switchBranch, regenerate,
    openRewriteHint, closeRewriteHint, confirmRewriteHint,
    refreshAiAvatar,
    refreshOnlineChatAvatars,
    deleteMessage, rollbackTo, rollbackAndRestore,
    continueGenerate, retractAI,
    initLongPress, showContext,
    togglePlusMenu, toggleFullscreenInput, attachImage, onImagePicked,
    attachFile, onFilePicked, previewFile, _openFilePreview,
    pickMemories, filterPickMemories, _togglePickMem,
    confirmPickMemories, removeAttach,
    setWorldview, getWorldviewPrompt, getMessages, getBranchId, autoExtractMemory,
    isStreamingNow: () => isStreaming,
manualExtractMemory, manualSummary,
enterMultiSelect, exitMultiSelect, toggleMultiSelect, selectAllMulti,
multiExtractMemory, multiExportImage, isMultiSelectMode,
    setWorldVoiceAttach, collectMessage,
    searchMessages, toggleSearchBar, renderQuickSwitches, renderAll,
    scrollToBottom, updateScrollBtn,
    _toggleThink,
    openConvSettingsModal, saveConvSettings, closeConvSettingsModal,
    _onVoiceEnabledChange, _onVoiceScopeAllChange,
    _onConvBgPicked, _onConvBgClear,
    playVoiceForMessage, stopVoice,
    buildAIMessageHTML, appendMessage
  };
})();