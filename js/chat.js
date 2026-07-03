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
      const curWvs = wv ? [wv] : [];
      // 兜底：当前对话世界观未命中/数据旧时，遍历全部世界观找同名 NPC（仅当当前世界观查不到该名字时才补，
      // 不能让其他世界观的同名 NPC 覆盖当前世界观的头像，否则跨世界观同名会串）
      const otherWvs = [];
      try {
        const all = await DB.getAll('worldviews');
        all.forEach(x => { if (x && x.id !== wvId) otherWvs.push(x); });
      } catch(_) {}
      if (curWvs.length === 0 && otherWvs.length === 0) { _onlineNpcAvatarMap = {}; return; }
      const avatarRows = await DB.getAll('npcAvatars');
      const avatarById = {};
      avatarRows.forEach(a => { if (a && a.id) avatarById[a.id] = a.avatar || ''; });
      // 当前世界观：有 url 就更新（同世界观内新头像覆盖旧的）
      const addNpcCur = (n) => {
        if (!n) return;
        const url = avatarById[n.id] || n.avatar || '';
        const names = [n.name, ...(String(n.aliases || '').split(/[,，、\s]+/)), ...(String(n.onlineName || '').split(/[,，、\s]+/))].map(s => String(s || '').trim()).filter(Boolean);
        names.forEach(name => { if (url || !map[name]) map[name] = url; });
      };
      // 其他世界观：仅当 map 里还没有该名字时才补，绝不覆盖当前世界观的头像
      const addNpcOther = (n) => {
        if (!n) return;
        const url = avatarById[n.id] || n.avatar || '';
        if (!url) return;
        const names = [n.name, ...(String(n.aliases || '').split(/[,，、\s]+/)), ...(String(n.onlineName || '').split(/[,，、\s]+/))].map(s => String(s || '').trim()).filter(Boolean);
        names.forEach(name => { if (!map[name]) map[name] = url; });
      };
      curWvs.forEach(wvItem => {
        if (wvItem.iconImage && !map['心动模拟客服']) map['心动模拟客服'] = wvItem.iconImage;
        (wvItem.globalNpcs || []).forEach(addNpcCur);
        (wvItem.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(addNpcCur)));
      });
      otherWvs.forEach(wvItem => {
        if (wvItem.iconImage && !map['心动模拟客服']) map['心动模拟客服'] = wvItem.iconImage;
        (wvItem.globalNpcs || []).forEach(addNpcOther);
        (wvItem.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(addNpcOther)));
      });
    } catch(_) {}
    _onlineNpcAvatarMap = map;
    // 补充：单人卡头像（单人卡不在世界观 NPC 里，但可能在线上气泡中出现）
    try {
      const conv = (typeof Conversations !== 'undefined') ? Conversations.getList().find(c => c.id === Conversations.getCurrent()) : null;
      if (conv && conv.isSingle && conv.singleCharId) {
        let scName = '', scAvatar = '';
        if (conv.singleCharType === 'card') {
          const card = await DB.get('singleCards', conv.singleCharId);
          if (card) {
            scName = card.name || '';
            scAvatar = card.avatar || '';
            // 把 aliases 和 onlineName 也注册进头像 map
            if (scAvatar) {
              [card.aliases, card.onlineName].forEach(field => {
                String(field || '').split(/[,，、\s]+/).forEach(s => {
                  const t = s.trim();
                  if (t && !_onlineNpcAvatarMap[t]) _onlineNpcAvatarMap[t] = scAvatar;
                });
              });
            }
          }
        } else if (conv.singleCharType === 'npc') {
          scAvatar = (await DB.get('npcAvatars', conv.singleCharId).catch(() => null))?.avatar || '';
          // NPC 名在世界观里已经加过了，但头像可能存在 npcAvatars 表
          const wvId = conv.singleCharSourceWvId || conv.singleWorldviewId;
          if (wvId) {
            const wv = await DB.get('worldviews', wvId);
            if (wv) {
              outer: for (const r of (wv.regions || [])) {
                for (const f of (r.factions || [])) {
                  for (const n of (f.npcs || [])) {
                    if (n.id === conv.singleCharId) { scName = n.name || ''; break outer; }
                  }
                }
              }
            }
          }
        }
        if (scName && scAvatar && !_onlineNpcAvatarMap[scName]) {
          _onlineNpcAvatarMap[scName] = scAvatar;
        }
      }
      // 挂载卡（面具）头像
      if (typeof Character !== 'undefined' && Character.get) {
        const char = await Character.get();
        if (char && char.name && char.avatar && !_onlineNpcAvatarMap[char.name]) {
          _onlineNpcAvatarMap[char.name] = char.avatar;
        }
      }
    } catch(_) {}
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

  // 输出格式指令（字数由对话设置控制）
  function _getOutputFormatPrompt(wordCount, timeFormat) {
    const wc = wordCount || 800;
    const isAbs = timeFormat === 'absolute';
    const timeFieldDesc = isAbs
      ? '（当前绝对时间，格式为"YYYY年M月D日 星期X HH:mm"，如"2065年3月27日 星期五 15:02"；按本轮剧情实际经过的时长，在上一轮时间基础上往后推算出新的完整时间。禁止写增量）'
      : '（时间推进量，用增量格式表示本轮剧情相对上一轮过了多久，如"+30min""+2h""+1d""+3d12h"；必须考虑用户行为和正文描写所消耗的时间，合理估算。若时间没有变化写"+0min"。特殊情况如闪回可用"-1h"。禁止写绝对日期）';
    const timeRule = isAbs
      ? '**时间**写完整的绝对时间（如"2065年3月27日 星期五 15:02"），按本轮相对上轮经过的时长往后推算。需综合考虑用户行为耗时+正文描写的时间流逝。照抄上一轮时间并加上经过的时长即可。'
      : '**时间**用增量格式（如"+30min""+2h""+1d"），表示本轮相对上轮过了多久。需综合考虑用户行为耗时+正文描写的时间流逝。前端会自动计算绝对日期，你无需关心当前是几号星期几。';
    return `你的回复必须严格遵循以下格式。

**括号内为解释说明，不要将括号内内容输出到正文**。

第一部分 — 正文叙述（约${wc}字，直接开始讲故事，不要在开头写地点时间等信息，这些统一放到第三部分的状态面板里）

如果剧情中有阅读文本，例如书籍段落、纸条、公告、资料等，可以使用引号符号包裹（>）

---

第二部分 — 系统信息（必须用代码块包裹，以下两个是**独立的两个代码块**，不要合并成一个）：

\`\`\`
新获得物品
（例如"雨伞：普通的粉色太阳伞，遮风挡太阳。"）
（每个物品写一行，如果没有新物品，则写"无"）
\`\`\`

\`\`\`
当前相关角色
（角色姓名，每行写一个，若无则写无）
（此处需要列出在场角色和提到的角色；不包含 {{user}}；禁止写"NPC"作为姓名占位）
\`\`\`

**重要：上面的"新获得物品"和"当前相关角色"必须是两个分开的代码块（各自有自己的 \`\`\` 开头和 \`\`\` 结尾），不允许写在同一个代码块里。**

---

第三部分 — 状态面板（必须紧跟在第二部分之后，用 \`\`\`status 代码块包裹，每轮必须完整输出，未发生变化的字段必须照抄上一轮的内容保持完整）：

\`\`\`status
地点：（当前所在地点，格式为"大地点｜小地点"，如"天枢城·东区｜某街道·某建筑·某房间"；必须使用世界观实际地名，禁止照抄此示例）
时间：${timeFieldDesc}
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
3. ${timeRule}
4. **天气**只写天气和温度，不写体感。
5. 在场的每个角色各写两行（衣着+姿势），格式严格为 \`角色-<名字>-衣着：xxx\` 和 \`角色-<名字>-姿势：xxx\`。不在场的角色不要写。为兼容旧格式，系统仍可识别 \`NPC-<名字>-衣着/姿势\`，但你本轮输出应优先使用 \`角色-<名字>-...\`。
6. 用户角色的衣着/姿势格式为 \`用户角色-<名字>-衣着：xxx\` 和 \`用户角色-<名字>-姿势：xxx\`，其中 \`<名字>\` 必须替换为用户角色姓名；禁止写成"玩家衣着/玩家姿势"。
7. 场景描写只写当前所处环境，不要包含剧情推进。
8. 若某字段实在没有内容（如单人独处没有其他角色），该行可省略，但不要写"无"。
9. **称呼规则**：正文、系统信息、status 内容和追加代码块里，都不要用"玩家""NPC"来称呼角色；必须直接使用角色姓名。
10. **示例中所有括号内的内容都是格式说明，不要输出括号本身**。示例中的地名、人名、时间、衣着描写等均为占位示例，必须替换为当前剧情的实际内容。

三个部分之间必须用 --- 分隔。

如果需要输出剧情外的提示文字（如引导说明、系统提示等），必须放在 status 代码块之前。`;
  }

  // 线上消息气泡格式（可选，仅在用户启用对话设置中"线上消息气泡"开关时注入）
  const ONLINE_CHAT_BLOCK_PROMPT = `

【可选追加：线上消息气泡】
当剧情中出现 NPC 通过手机/IM/社交软件给用户发送线上消息时，可以在 status 代码块之后追加一个 \`\`\`chat 代码块，前端会将其渲染为 QQ/微信式的线上消息气泡。

格式（JSON 数组，每条消息含 npc/text/time）：
\`\`\`chat
[
  {"npc": "角色名", "text": "消息内容", "time": "HH:mm"},
  {"npc": "角色名", "text": "下一条消息", "time": "HH:mm"}
]
\`\`\`

使用规则：
1. 仅当剧情中确实出现"线上消息"时才输出此代码块。日常对话、面对面交流、电话通话等不要使用此格式。
2. 没有线上消息的轮次完全不要输出 \`\`\`chat 块（不是输出空数组，是整个块都不要写）。
3. text 用 NPC 实际发送的内容，简短自然，符合 IM 聊天习惯。
4. time 只写时分（如"15:02"），前端会自动补上日期。参考状态栏的当前游戏时间来确定。
5. npc 必须使用角色真名，与正文/status 中的名字一致。
6. 当输出了 \`\`\`chat 块时，**消息的具体内容只写在 chat 块里，正文不要复述**。正文需要简短交代"发送/收到了消息"这个动作或场景本身（例如"她拿起手机，给他发了一条消息"/"手机震了一下，是来自{{NPC}}的消息"），但不要把消息原文也写进正文，避免一条消息出现两次。
7. **chat 块里只放 NPC 发出的消息，不要包含{{user}}的消息**。用户的消息由用户自己输入，AI 既不要复述也不要替用户写入 chat 块。
8. **chat 块只填本轮新产生的线上消息，不要把历史轮次已经出现过的消息再填一遍**。历史消息前端已经渲染过，重复输出会导致用户看到同一条消息出现多次。
9. **chat 块只用于私聊/群聊类的即时通讯消息**。论坛帖子、论坛评论、好友圈动态、好友圈评论等内容不要放入 chat 块——它们有独立的手机 APP 界面承载，不属于线上消息。`;


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
    // v612：记忆提取游标按对话持久化，避免刷新/切窗口后从头重复提取
    try {
      const _convForExtract = Conversations.getList().find(c => c.id === convId);
      lastExtractedMsgId = _convForExtract?.lastExtractedMsgId || null;
      _extractPending = !!_convForExtract?.extractPending;
    } catch(_) {
      lastExtractedMsgId = null;
      _extractPending = false;
    }
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
        // 自定义世界观状态栏风格
        try {
          if (_wvForName && _wvForName.id === 'wv_tianshucheng') document.body.setAttribute('data-sb-skin', 'terminal');
          else if (_wvForName && _wvForName.id === 'wv_heartsim') document.body.removeAttribute('data-sb-skin');
          else if (_wvForName && _wvForName.id && _wvForName.id !== '__default_wv__') {
            const _skin = _wvForName.statusBarSkin || 'terminal';
            if (_skin.startsWith('sb_') && window.StatusBarTheme) {
              const _theme = StatusBarTheme.get(_skin);
              if (_theme) {
                const _css = _theme.css || (_theme.draft && _theme.draft.currentCss) || '';
                StatusBarTheme.applyPreview(_theme.baseTemplate, _css);
              } else {
                document.body.setAttribute('data-sb-skin', 'terminal');
              }
            } else {
              document.body.setAttribute('data-sb-skin', _skin);
            }
          }
          else document.body.removeAttribute('data-sb-skin');
        } catch(_) {}
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
        // 强制 render 一次状态栏（无论有无世界观，确保切换后 DOM 刷新）
        if (typeof StatusBar !== 'undefined' && StatusBar.refreshFromConv) {
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
    // 切换对话后，预热世界观初始住所（让 AI 在玩家没打开小屋 App 时也知道住所，避免剧情错位）
    try { if (typeof Phone !== 'undefined' && Phone.ensureInitialHouse) Phone.ensureInitialHouse(); } catch(_) {}
    // 切换对话后，刷新底部快速切换栏（不同世界观可见的面具不同）
    try { renderQuickSwitches(); } catch(_) {}
    // 异步加载 AI 头像，加载好后回填到已渲染的消息
    refreshAiAvatar();
    // 更新加号菜单里的生图按钮可见性
    _updateImgGenButtons();
    // 更新回复建议灯泡按钮可见性
    _updateSuggestBtn();
    // 环境音：切换对话时恢复/关闭
    try {
      if (typeof Ambient !== 'undefined') {
        const _conv = Conversations.getList()?.find(c => c.id === conversationId);
        if (_conv?.convAmbientEnabled) {
          Ambient.setVolume((_conv.convAmbientVolume ?? 50) / 100);
          Ambient.setMode(_conv.convAmbientMode || 'loop');
          Ambient.enable();
        } else {
          Ambient.disable();
        }
      }
    } catch(_) {}

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


  // v687.33：剥离 assistant 历史消息中的格式代码块（省 token + 降噪）
  // 保留正文 + 头部信息（场景连续性），去掉系统已处理的数据块和思考链
  function _stripFormatBlocks(raw) {
    if (!raw) return raw;
    let s = raw;
    // 1. 剥离 <think>/<thinking> 思考链
    s = s.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, '');
    // 2. 剥离所有系统格式代码块（status/relation/task/tasks/custom-attrs/chat/phone-lock/homecoming/call/prison-all）
  s = s.replace(/```(?:status|relation|tasks?|custom-attrs|chat|phone-lock|homecoming|call|prison-all)\s*\n?[\s\S]*?```/gi, '');
    // 3. 剥离"第X部分 — XXX："格式标签行
    s = s.replace(/^[ \t]*第[一二三四五六七八九十]+部分\s*[—\-－]\s*[^\n]*$/gm, '');
    // 4. 清理残留的孤儿分隔符和多余空行
    s = s.replace(/\n---\s*$/gm, '').replace(/^---\s*\n/gm, '');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  // 过滤 AI 历史消息里的 HTML（发请求时降噪 + 省 token，不动存档原文）
  // keepText=true：剥标签留文字（<span style>红字</span> → 红字）
  // keepText=false：标签连内容一起删
  function _stripHistoryHtml(raw, keepText) {
    if (!raw) return raw;
    let s = raw;
    // 1. 先处理 ```html / ```svg / ```xml 围栏块
    s = s.replace(/```(?:html|svg|xml)\s*\n?([\s\S]*?)```/gi, (_, inner) => {
      if (!keepText) return '';
      // 剥掉围栏内的标签，留文字
      return inner.replace(/<[^>]+>/g, '').trim();
    });
    // 2. 再处理裸写的行内/块级 HTML 标签
    if (keepText) {
      // 去掉 script/style 整段（含内容，避免脚本文本残留）
      s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
      // 剥掉剩余成对/自闭合标签，保留可见文字
      s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    } else {
      // 整段删：成对标签连内容一起删，再清自闭合/孤立标签
      s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
      s = s.replace(/<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, '');
      s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    }
    // 清理过滤后残留的多余空行
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }
  const _HS_HOMECOMING_WORLD_SETTING = `【返航后·世界观设定】

这是一个与现实世界几乎完全一致的当代世界。科技水平、社会制度、文化背景、地理格局均与当今现实相同。没有超自然现象，没有异世界，没有任何违反常识的事物存在。

人们正常地生活、工作、社交。城市有便利店和地铁，手机能刷短视频和点外卖，天气预报偶尔不准，快递偶尔送错地址。一切都按照普通的现代社会运转。

{{user}}的身份、职业、居住地、社交关系等信息由{{user}}自行在对话中建立。AI不应预设{{user}}的任何个人背景——{{user}}说自己是什么就是什么，没说过的就留白。

日期和时间与现实同步。天气、季节、节假日按正常日历走。

【特殊备注（仅AI可见，不得向{{user}}主动提起）】
{{user}}刚从一段漫长的、异常逼真的沉浸式体验中醒来。那段经历的细节正在快速褪色，像一场过于漫长的梦——越想抓住就消散得越快。

这段经历可能在{{user}}身上留下了一些不易察觉的痕迹：偶尔觉得某个陌生人的侧脸莫名熟悉，偶尔在安全的环境里毫无来由地警觉，偶尔对某种气味或音乐产生说不清的情绪。这些反应很轻微，不影响正常生活，{{user}}自己也未必意识到。

【严格禁止】那段经历中出现过的任何角色——无论以什么形式——都不得出现在这个世界里。不能以路人、同事、邻居、新闻人物、网名、谐音、暗示等任何方式让他们存在于当前现实中。他们的名字不要主动提起。他们和这个世界没有任何关系，从未存在过。这条规则没有例外。

如果{{user}}主动提起那段经历——提到某些名字、某个城市、某种感觉——不要否认{{user}}的感受，也不要主动追问。只在叙述中自然地、克制地让那些微小的痕迹偶尔浮现。像余震，不是地震。

这个世界没有任何不对劲的地方。一切都很正常。`;

  // ===== 共用：构建 API 上下文（send + showContext 共享） =====
  async function _buildApiContext(messages, opts = {}) {
    const { rewriteHint = null } = opts;
// 构建system prompt
const systemParts = [];
// v687.33：提前检测心动模拟返航状态（后续多处需要用）
let _hsHomecoming = false;
let _hsPostHomeMode = null; // 'continue' | 'end' | null
try {
  if (typeof Phone !== 'undefined' && Phone.isHsHomecomingTriggered) {
    _hsHomecoming = await Phone.isHsHomecomingTriggered();
    if (_hsHomecoming) {
      const _pd = await Phone._getPhoneData();
      _hsPostHomeMode = _pd?.hsPostHomeMode || null;
    }
  }
} catch(_) {}
// v687.31：状态栏类高时效注入——这些段会在 apiMessages 构建完毕后
// 统一插入到"最后 user 消息之前"，让 AI 在读用户输入前先看到最新状态。
// 解决"状态栏写 14, AI 说 9"的注意力衰减问题。
const _recentStatusParts = [];
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

    // v687.33：返航"继续日常"模式下屏蔽所有 NPC 相关注入（那些角色在这个世界不存在）
// epilogue 模式（第二部钩子触发后）也屏蔽所有 NPC——剧情已彻底结束
const _skipNpcInjection = _hsHomecoming && (_hsPostHomeMode === 'continue' || _hsPostHomeMode === 'epilogue');

    // 1. 世界观（每轮发）— 番外模式下看 inheritWv 开关 — 单人模式用自己的世界观 — 非文游模式跳过
    // v687.33：心动模拟返航"继续日常"模式下替换为返航世界设定
    // "到此结束"模式保留原世界观（方便复盘）
    if (_hsHomecoming && _hsPostHomeMode === 'continue' && isGameMode) {
      systemParts.push(_HS_HOMECOMING_WORLD_SETTING);
    } else if (isGameMode && !isSingleConv) {
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
    } else if (isSingleConv && isGameMode && singleWv && singleWv.setting && !_skipNpcInjection) {
      // v687.33：返航"继续日常"/epilogue 模式下不发心动模拟单人世界观
      systemParts.push(singleWv.setting);
    }

    // 1b. 周程作息表（启用时每轮发整张表，作为叙事背景；私人日程+防瞎编约束）
    if (isGameMode && typeof Phone !== 'undefined' && Phone._weekBuildScheduleBlock) {
      try {
        const _wsBlock = await Phone._weekBuildScheduleBlock();
        if (_wsBlock) systemParts.push(_wsBlock);
      } catch(e) { console.warn('[Chat] 周程表注入失败', e); }
    }

    // 1c. 单人模式：主角资料（仅文游模式发送）
    // v687.33：返航"继续日常"/epilogue 模式下跳过（单人卡主角不属于返航后的现实世界）
if (isSingleConv && isGameMode && !_skipNpcInjection) {
  const mainCharText = await SingleMode.getMainCharPrompt(singleSettings, convSettings.narrPerson);
  if (mainCharText) systemParts.push(mainCharText);
} else if (isGameMode && !isGaidenConv && !_skipNpcInjection) {
    // 1c'. 群像模式：叙事者元 prompt（让 AI 知道自己是旁白+所有 NPC 的化身，用户才是{{user}}）
      const _gnp = convSettings.narrPerson || 'second';
      const _groupPersonLine = _gnp === 'first'
        ? '描写"{{user}}"时使用第二人称"你"或玩家姓名；当前主导场景的核心 NPC 可用第一人称"我"叙述自身的动作与心理（第一人称更适合单人模式，群像中多角色并存时请谨慎使用，避免视角混乱）。'
        : _gnp === 'third'
        ? '全程使用第三人称叙述：描写 NPC 用第三人称（"他/她/Ta" 或名字），称呼"{{user}}"也使用第三人称（"Ta" 或玩家姓名），不使用"你"。'
        : '描写"{{user}}"时使用第二人称"你"或玩家姓名，保留代入感；描写 NPC 时使用第三人称（"他/她/Ta" 或名字）。';
      systemParts.push(`【AI 扮演角色】
本对话为群像模式（多角色剧情）。你是"叙事者 + 所有 NPC 的扮演者"，用户扮演"{{user}}"。
你应该：
1. 通过场景描写、NPC 对话和环境互动推进剧情，把"用户角色卡"作为玩家的身份资料理解，不要把用户角色卡本身当成需要你扮演的对象。
2. ${_groupPersonLine}
3. 根据场景需要让 NPC 自然登场，不必所有 NPC 都登场。`);
    }

    // 1d. 常驻角色（对话级常驻，群像/单人都生效）— 非文游模式跳过（属于剧情资源，纯聊不发）
    // v687.33：返航"继续日常"模式下也跳过
    if (isGameMode && !_skipNpcInjection) {
      try {
        if (window.AttachedChars) {
          const attachedPrompt = await AttachedChars.buildPrompt();
          if (attachedPrompt) systemParts.push(attachedPrompt);
        }
      } catch(_) {}
    }

    // 1b. 剧情总结（如有）
    const summaryText = await Summary.formatForPrompt(Conversations.getCurrent());
    if (summaryText) systemParts.push(summaryText);

    // 2. 输出格式 — 非文游模式或关闭回复格式时跳过
    if (isGameMode && convSettings.format) {
      systemParts.push(_getOutputFormatPrompt(convSettings.replyWordCount, convSettings.timeFormat));
      // 线上消息气泡：用户开关开启 且 不是心动模拟（心动模拟世界观自带说明）
      if (convSettings.onlineChat && document.body.getAttribute('data-worldview') !== '心动模拟') {
        systemParts.push(ONLINE_CHAT_BLOCK_PROMPT);
      }
    }

    // 2b. 自定义属性：独立于「回复格式」开关（v681.2 解耦）
    // 自定义属性已是独立的 custom-attrs 代码块，不依赖 status 块，所以只看 isGameMode
    if (isGameMode) {
      // v686.9：增加 attrsEnabled 开关，关闭则跳过数值系统注入（但骰点系统仍走）
      if (convSettings.attrsEnabled && typeof StatusBar !== 'undefined' && StatusBar.formatCustomAttrsFormatPrompt) {
        try {
          const customAttrsFormatText = await StatusBar.formatCustomAttrsFormatPrompt();
          if (customAttrsFormatText) systemParts.push(customAttrsFormatText);
        } catch(e) { console.warn('[Chat] 自定义属性格式注入失败', e); }
      }

    // 2c. 骰点系统玩法 v686
    try {
      if (typeof Dice !== 'undefined' && Dice.buildPromptBlock) {
        const dicePrompt = Dice.buildPromptBlock();
        if (dicePrompt) systemParts.push(dicePrompt);
      }
    } catch(e) { console.warn('[Chat] 骰点系统注入失败', e); }
    }

    // 2a. 上一轮状态面板（让 AI 知道当前场景状态，照抄未变化字段）
    if (isGameMode && convSettings.format) {
      try {
        const curStatus = Conversations.getStatusBar();
        const statusText = Utils.serializeStatus(curStatus);
        if (statusText) {
          // v687.31：状态栏改为最近上下文注入（从 systemParts 移到最后 user 前）
          _recentStatusParts.push('【上一轮状态面板】\n以下是当前场景的状态快照。你下一次回复的 `status` 代码块应基于此更新：未发生变化的字段请原样抄回；有变化则写新值。\n\n```status\n' + statusText + '\n```');
        }
        // 强调当前时间，防止剧情描写与状态栏时间矛盾
        if (curStatus?.time) {
          // 计算当前时段
          let periodLabel = '';
          let periodDesc = '';
          try {
            if (typeof Calendar !== 'undefined' && Calendar.getTimePeriod && Calendar.parseAbsoluteTime) {
              const _tp = Calendar.parseAbsoluteTime(curStatus.time);
              if (_tp) {
                let _calRules = null;
                try {
                  const _c = Conversations.getList().find(c => c.id === Conversations.getCurrent());
                  const _wId = _c?.worldviewId;
                  const _wv = _wId ? await DB.get('worldviews', _wId) : null;
                  _calRules = _wv?.gameplay?.calendarSystem || null;
                } catch(_) {}
                const pInfo = Calendar.getTimePeriod(_tp.hour, _calRules);
                if (pInfo) { periodLabel = pInfo.name; periodDesc = pInfo.desc || ''; }
              }
            }
          } catch(_) {}
          let timePrompt = `【当前剧情时间】${curStatus.time}${periodLabel ? '（' + periodLabel + (periodDesc ? '：' + periodDesc : '') + '）' : ''}\n这是本轮剧情开始时的绝对时间。你的正文描写（光线、活动、氛围等）必须符合这个时间段。`;
          if (convSettings.timeFormat === 'absolute') {
            timePrompt += `\n你在 status 中输出 time 时，请写**完整的绝对时间**（格式与上面一致，如"${curStatus.time}"），按本轮剧情实际经过的时长在此基础上往后推算，不要写增量。`;
          } else {
            timePrompt += `\n你在 status 中输出 time 时，请写**时间增量**（如 +5min、+1h20min、+3d），系统会基于上面的当前时间自动累加，不要写完整日期。`;
          }

          // 跨时段检测：读上一轮存的 pending 标记
          if (curStatus._pendingPeriodTransition) {
            const pt = curStatus._pendingPeriodTransition;
            timePrompt += `\n\n【时段转换】时间已从「${pt.from}」推进到「${pt.to}」${pt.toDesc ? '（' + pt.toDesc + '）' : ''}。\n本轮正文必须以1-2句环境过渡描写开头，体现时间流逝带来的变化（光线/温度/声音/人群活动等），然后再继续剧情。禁止忽略时段变化。`;
            // 清除标记（已注入，不重复）
            try { delete curStatus._pendingPeriodTransition; await Conversations.setStatusBar(curStatus); } catch(_) {}
          }

          // 跨季节检测：读上一轮存的 pending 标记
          if (curStatus._pendingSeasonTransition) {
            const st = curStatus._pendingSeasonTransition;
            timePrompt += `\n\n【季节转换】季节已从「${st.from}」进入「${st.to}」${st.toWeather ? '（' + st.toWeather + '）' : ''}。\n本轮正文须体现季节变化对环境的影响（植被/气温/衣着/风向等），然后再继续剧情。`;
            // 清除标记
            try { delete curStatus._pendingSeasonTransition; await Conversations.setStatusBar(curStatus); } catch(_) {}
          }

          _recentStatusParts.push(timePrompt);

          // 周程·当前时段定位（启用时跟着时间一起发，高时效）
          try {
            if (typeof Phone !== 'undefined' && Phone._weekBuildNowBlock) {
              const _wsNow = await Phone._weekBuildNowBlock();
              if (_wsNow) _recentStatusParts.push(_wsNow);
            }
          } catch(_) {}
        }
      } catch(e) {}
    }

    // 2c. 自定义属性状态：独立于「回复格式」开关（v681.2 解耦）
    if (isGameMode) {
      if (typeof StatusBar !== 'undefined' && StatusBar.formatCustomAttrsStatePrompt) {
        try {
          const customAttrsStateText = await StatusBar.formatCustomAttrsStatePrompt();
          // v687.31：状态栏改为最近上下文注入
          if (customAttrsStateText) _recentStatusParts.push(customAttrsStateText);
        } catch(e) { console.warn('[Chat] 自定义属性状态注入失败', e); }
      }
    }

    // 2a. 首轮现实时间戳（兜底开场时间）
    // 不论文游/非文游、不论有没有 startTime，第一条 user 消息时都发——
    // AI 自己判断：优先用 startTime 或 setting 里写的开场时间，都没有再用现实时间。
    try {
      const userMsgCount = messages.filter(m => m.role === 'user').length;
      if (userMsgCount <= 1) {
        const now = new Date();
        const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
        const realTime = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${weekdays[now.getDay()]} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        systemParts.push(`【开场时间参考】\n本对话开始于现实时间：${realTime}。状态栏已初始化为此时间，第一轮时间写"+0min"即可。\n规则：如果世界观/角色卡/单人卡设定中有明确的开场时间（如 startTime 字段、或在设定文本里写明的具体年代/时刻），优先使用那个时间作为剧情开场；如果都没有提及开场时间，再以上述现实时间作为开场时间。`);
      }
    } catch(e) { console.warn('[Chat] 首轮现实时间注入失败', e); }

    // 2b. 开场时间和开场剧情（前N轮有效）— 非文游模式跳过 — 单人模式看 enableStartPlot
    if (isGameMode && !isGaidenConv && !isSingleConv) {
      try {
        const wv = await Worldview.getCurrent();
        if (wv) {
          const rounds = wv.startPlotRounds || 5;
          const userMsgCount = messages.filter(m => m.role === 'user').length;
          if (userMsgCount < rounds) {
            let startParts = [];
            if (wv.startTime) startParts.push(`开场时间：${wv.startTime}。状态栏已初始化为此时间，第一轮时间写"+0min"即可（表示从此刻开始）。`);
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
          if (singleWv.startTime) startParts.push(`开场时间：${singleWv.startTime}。状态栏已初始化为此时间，第一轮时间写"+0min"即可（表示从此刻开始）。`);
          if (singleWv.startPlot) startParts.push(`开场剧情指令：${singleWv.startPlot}`);
          if (startParts.length > 0) {
            systemParts.push(`【开场引导（前${rounds}轮生效）】\n${startParts.join('\n')}`);
          }
        }
      } catch(e) {}
    }

    // 2c. 历法系统注入（自定义历法时告知AI基本规则）
    if (isGameMode) {
      try {
        const _calWv = isSingleConv ? singleWv : await Worldview.getCurrent();
        const _calSys = _calWv?.gameplay?.calendarSystem;
        if (_calSys && _calSys.daysPerWeek) {
          // 判断是否非默认（和7天/12月不同就算自定义）
          const isCustom = _calSys.daysPerWeek !== 7 ||
            (_calSys.daysPerMonth && _calSys.daysPerMonth.length !== 12) ||
            (_calSys.weekDayNames && _calSys.weekDayNames.some((n, i) => n !== ['星期一','星期二','星期三','星期四','星期五','星期六','星期日'][i])) ||
            (_calSys.seasons && _calSys.seasons.length !== 4);
          if (isCustom) {
            let calParts = [];
            calParts.push(`每周${_calSys.daysPerWeek}天，分别为：${(_calSys.weekDayNames || []).join('、')}`);
            if (_calSys.weekDayTypes && _calSys.weekDayTypes.length) {
              const workDays = _calSys.weekDayNames.filter((_, i) => _calSys.weekDayTypes[i] === 'work');
              const restDays = _calSys.weekDayNames.filter((_, i) => _calSys.weekDayTypes[i] === 'rest');
              if (workDays.length) calParts.push(`工作日：${workDays.join('、')}`);
              if (restDays.length) calParts.push(`休息日：${restDays.join('、')}`);
            }
            const monthCount = _calSys.daysPerMonth ? _calSys.daysPerMonth.length : 12;
            calParts.push(`一年${monthCount}个月`);
            if (_calSys.daysPerMonth) {
              const allSame = _calSys.daysPerMonth.every(d => d === _calSys.daysPerMonth[0]);
              if (allSame) {
                calParts.push(`每月${_calSys.daysPerMonth[0]}天`);
              } else {
                calParts.push(`各月天数：${_calSys.daysPerMonth.join('、')}`);
              }
            }
            if (_calSys.seasons && _calSys.seasons.length) {
              const seasonDesc = _calSys.seasons.map(s => {
                let txt = `${s.name}（${(s.months || []).map(m => m + '月').join('、')}）`;
                if (s.weather) txt += `：${s.weather}`;
                return txt;
              }).join('；');
              calParts.push(`季节：${seasonDesc}`);
            }
            const totalDays = (_calSys.daysPerMonth || []).reduce((a, b) => a + b, 0);
            if (totalDays) calParts.push(`一年共${totalDays}天`);
            systemParts.push(`<世界观特殊历法>\n${calParts.join('\n')}\n</世界观特殊历法>`);
          }
        }
      } catch(e) { console.warn('[Chat] 历法注入失败', e); }
    }

    // 3. 角色卡（面具）— 只要挂了面具就发，让人机恋/纯聊天也能用
const char = await Character.get();
if (char) systemParts.push(Character.formatForPrompt(char));

// 3-衣橱. 当前着装（从衣橱系统读取，只要穿了就发）
try {
  if (typeof Phone !== 'undefined' && Phone._getPhoneData) {
    const _pd = await Phone._getPhoneData();
    const _outfit = (_pd && _pd.wardrobeOutfit) || {};
    const _WARDROBE_PARTS = [
      { key: 'top', name: '上装' },
      { key: 'bottom', name: '下装' },
      { key: 'onesuit', name: '连体' },
      { key: 'outer', name: '外套' },
      { key: 'shoes', name: '鞋袜' },
      { key: 'hat', name: '帽子' },
      { key: 'accessory', name: '饰品' },
    ];
    const _lines = _WARDROBE_PARTS.map(p => {
      const items = Array.isArray(_outfit[p.key]) ? _outfit[p.key].filter(it => it && it.name) : [];
      if (!items.length) return '';
      const names = items.map(it => it.desc ? `${it.name}（${it.desc}）` : it.name).join(' + ');
      return `${p.name}：${names}`;
    }).filter(Boolean);
    if (_lines.length) {
      systemParts.push('【{{user}}当前着装】\n{{user}}此刻穿着以下服装，描写外貌/动作时请与之保持一致，不要凭空换装：\n' + _lines.join('\n'));
    }
  }
} catch(_) {}

// 3a. 玩家当前居住地（从小屋系统读取）
try {
  if (typeof Phone !== 'undefined' && Phone._getPhoneData) {
    const _pd = await Phone._getPhoneData();
    if (_pd && Array.isArray(_pd.houses)) {
      const curHouse = _pd.houses.find(h => h.isCurrent);
      if (curHouse && curHouse.name) {
        let hStr = `住所名称：${curHouse.name}`;
        if (curHouse.region) hStr += `\n所在地区：${curHouse.region}`;
        if (curHouse.address) hStr += `\n具体地址：${curHouse.address}`;
        if (curHouse.styleDesc) hStr += `\n装修风格：${curHouse.styleDesc}`;
        systemParts.push('【玩家当前居住地】\n' + hStr);
      }
    }
  }
} catch(_) {}

// 3b. 世界观速查表（每轮发，所有地区/势力/NPC概要）— 番外模式下看 inheritNpc 开关 — 非文游模式跳过
    // v687.33：返航"继续日常"模式下全部跳过
    if (!_skipNpcInjection && isGameMode && !isSingleConv && (!isGaidenConv || gaidenSettings.inheritNpc)) {
      const quickRef = NPC.formatQuickRef();
      if (quickRef) systemParts.push(quickRef);
    } else if (isSingleConv && isGameMode && singleWv && !_skipNpcInjection) {
      // 单人模式：地区/势力速查永远发，NPC行受 enableNpc 控制
      // v687.33：返航 continue/epilogue 模式下跳过
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
        // 节日索引（让 AI 预知后续节日，提前埋伏笔）
        const sendFestivalIdx = isSingleConv ? !!singleSettings.enableFestival : true;
        if (wvForIndex && sendFestivalIdx) {
          const fIdx = _buildFestivalIndex(wvForIndex.festivals || []);
          if (fIdx) systemParts.push(fIdx);
        }
        // 单人卡扩展设定的节日索引
        if (isGameMode) { // v685：通用世界书索引
          try {
            const _card = isSingleConv && singleSettings.charId ? await SingleCard.get(singleSettings.charId) : null;
            if (!isSingleConv || singleSettings?.charType !== "card" || (_card && _card.extEnabled !== false)) {
              const _hiddenWv = await _getCardLorebooksMerged(singleSettings?.charId, (typeof Conversations !== 'undefined' && Conversations.getList) ? Conversations.getList().find(c => c.id === Conversations.getCurrent()) : null);
              if (_hiddenWv) {
                const _cardFIdx = _buildFestivalIndex(_hiddenWv.festivals || []);
                if (_cardFIdx) systemParts.push(_cardFIdx.replace('【世界观·节日索引】', '【世界书·节日索引】'));
                const _cardKIdx = _buildKnowledgeIndex(_hiddenWv.knowledges || []);
                if (_cardKIdx) systemParts.push(_cardKIdx.replace('【世界观·知识条目索引】', '【世界书·知识条目索引】'));
              }
            }
          } catch(_) {}
        }
      } catch (e) {}
    }

    // 4. 当前区域NPC（detail，地区命中时发）— 番外看 inheritNpc — 单人看 enableDetail
    // v687.33：返航"继续日常"模式下全部跳过
    const region = NPC.getRegion();
    if (!_skipNpcInjection && isGameMode && !isSingleConv && (!isGaidenConv || gaidenSettings.inheritNpc)) {
      const npcPrompt = NPC.formatForPrompt(region);
      if (npcPrompt) systemParts.push(npcPrompt);

      // 4b. 在场NPC（跨区域跟随，排除已在地区NPC里的）
      const presentNPCPrompt = NPC.formatPresentForPrompt(region);
      if (presentNPCPrompt) systemParts.push(presentNPCPrompt);
    } else if (isSingleConv && isGameMode && singleWv && singleSettings.enableDetail && !_skipNpcInjection) {
      // 单人模式：detail受 enableDetail 控制，NPC详细需要 enableNpc 也开
      // v687.33：返航 continue/epilogue 模式下跳过
      const npcPrompt = NPC.formatForPrompt(region, { includeNpc: singleSettings.enableNpc });
      if (npcPrompt) systemParts.push(npcPrompt);
      if (singleSettings.enableNpc) {
        const presentNPCPrompt = NPC.formatPresentForPrompt(region);
        if (presentNPCPrompt) systemParts.push(presentNPCPrompt);
      }
    }

    // 4c. 全图 NPC（不受地区限制，本世界观下每轮全量注入）
    // 单人模式必须遵守 enableNpc：未启用 NPC 时，连全图常驻 NPC 也不注入。
    // v632.1：单人卡世界书的 NPC 独立——绑了世界书就注入，不受 enableNpc 限制
    // v687.33：返航 continue/epilogue 模式下全部跳过
    const _shouldInjectWvNpc = !_skipNpcInjection && isGameMode && (!isSingleConv || singleSettings.enableNpc);
    const _shouldInjectLbNpc = !_skipNpcInjection && isGameMode; // v685：所有模式都尝试注入聚合世界书 NPC
    if (_shouldInjectWvNpc || _shouldInjectLbNpc) {
      try {
        let _wvForGlobal = null;
        if (_shouldInjectWvNpc) {
          if (isSingleConv && singleWv) {
            _wvForGlobal = singleWv;
          } else if (!isGaidenConv || gaidenSettings.inheritNpc) {
            const curWvId = Worldview.getCurrentId && Worldview.getCurrentId();
            if (curWvId && curWvId !== '__default_wv__') {
              _wvForGlobal = await DB.get('worldviews', curWvId);
            }
          }
        }
        const gs = (_shouldInjectWvNpc && _wvForGlobal && _wvForGlobal.globalNpcs) ? _wvForGlobal.globalNpcs.slice() : [];
        // v632.1：合并单人卡世界书的全图 NPC（独立于 currentWv，没绑主世界观也要跑）
        if (_shouldInjectLbNpc) {
          try {
            const _card = await SingleCard.get(singleSettings.charId);
            if (!isSingleConv || singleSettings?.charType !== "card" || (_card && _card.extEnabled !== false)) {
              const _hiddenWv = await _getCardLorebooksMerged(singleSettings?.charId, Conversations.getList().find(c => c.id === Conversations.getCurrent()));
              if (_hiddenWv && Array.isArray(_hiddenWv.globalNpcs) && _hiddenWv.globalNpcs.length > 0) {
                // 按 id（兜底 name）去重，避免和世界观自带的重复
                const seen = new Set(gs.map(n => n.id || n.name));
                for (const n of _hiddenWv.globalNpcs) {
                  const key = n.id || n.name;
                  if (key && !seen.has(key)) {
                    gs.push(n);
                    seen.add(key);
                  }
                }
              }
            }
          } catch(e) { console.warn('[Chat] 单人卡世界书 NPC 合并失败', e); }
        }
        if (gs.length > 0) {
          const text = '【全图常驻 NPC】\n以下 NPC 不受地区限制，在本世界观下全程常驻，随时可以出现在任何场景中。\n\n' +
            gs.map(n => {
              const head = n.aliases ? `${n.name}（${n.aliases}）` : (n.name || '未命名');
              return n.detail ? `${head}\n${n.detail}` : head;
            }).join('\n\n---\n\n');
          systemParts.push(text);
          try { GameLog.log('info', `[世界书] 注入 ${gs.length} 个常驻 NPC`); } catch(_) {}
        }
      } catch(e) { console.warn('[Chat] 常驻角色注入失败', e); }
    }

    // 4d. 提及的地区（扫玩家最新消息 + AI最近一条消息正文，命中地区全名 → 附该地区 detail）
    // v687.33：返航"继续日常"模式下跳过
    if (isGameMode && !_skipNpcInjection) {
      try {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const lastAI = [...messages].reverse().find(m => m.role === 'assistant');
        const scanText = [lastUser?.content || '', lastAI?.content || ''].join('\n');
        const mentionedPrompt = NPC.formatMentionedForPrompt(scanText, region);
        if (mentionedPrompt) systemParts.push(mentionedPrompt);
      } catch(e) { console.warn('[Chat] 提及地区注入失败', e); }
    }

    // 4e. 住所布局（小地点命中玩家住所时，发送简化室内布局）
    if (isGameMode) {
      try {
        const _sb = Conversations.getStatusBar() || {};
        const _loc = String(_sb.location || '').trim();
        if (_loc && typeof Phone !== 'undefined' && Phone.getCottageLayoutForLocation) {
          const cottageLayout = await Phone.getCottageLayoutForLocation(_loc);
          if (cottageLayout) systemParts.push(cottageLayout);
        }
      } catch(_) {}
    }

    // 5. 相关记忆（方案B：关系按NPC名直接命中，事件按地点+关键词）
// v627：人机恋场景下也启用——只要面具+记忆库里有内容就发
{
  const recentText = messages.slice(-4).map(m => m.content).join(' ');
  const presentNPCs = NPC.getPresentNPCs();
  const currentLoc = NPC.getRegion();
const relatedMemories = await Memory.retrieve(recentText, presentNPCs, currentLoc);
    const memoryPrompt = Memory.formatForPrompt(relatedMemories);
    if (memoryPrompt) systemParts.push(memoryPrompt);

    // 5a2. 永久小纸条（每轮必发，紧跟记忆池之后）
    let _pinnedCount = 0;
    try {
      const pinnedNotes = await Memory.getPinnedNotes();
      const pinnedPrompt = Memory.formatPinnedNotesForPrompt(pinnedNotes);
      if (pinnedPrompt) systemParts.push(pinnedPrompt);
      _pinnedCount = pinnedNotes ? pinnedNotes.length : 0;
    } catch(_) {}

    // 5b. 小纸条（情绪记忆碎片）——随机池（重要+普通，永久已排除）
    let _noteCount = 0;
    let _importantNoteCount = 0;
    let _normalNoteCount = 0;
    try {
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      const userInputText = lastUserMsg?.content || '';
      const notes = await Memory.retrieveNotes(presentNPCs, userInputText);
      const notesPrompt = Memory.formatNotesForPrompt(notes);
      if (notesPrompt) systemParts.push(notesPrompt);
      _noteCount = notes ? notes.length : 0;
      _importantNoteCount = notes ? notes.filter(n => n.priority === 'important').length : 0;
      _normalNoteCount = _noteCount - _importantNoteCount;
    } catch(_) {}

    // 5c. 角色记事本（NPC 网络行为档案）：命中在场/被提及的 NPC → 注入其行为记录
    let _npcNoteHitCount = 0;
    try {
      if (Phone && Phone._npcNotesRetrieve) {
        const npcHits = Phone._npcNotesRetrieve(presentNPCs, recentText);
        const npcNotePrompt = Phone._npcNotesFormatForPrompt(npcHits);
        if (npcNotePrompt) systemParts.push(npcNotePrompt);
        _npcNoteHitCount = npcHits ? npcHits.length : 0;
      }
    } catch(_) {}

    // 记忆注入日志
    const _eventCount = relatedMemories.filter(m => m.type === 'event').length;
    const _relCount = relatedMemories.filter(m => m.type === 'relation').length;
    const _memPinnedCount = relatedMemories.filter(m => m.pinned).length;
    GameLog.log('info', `[记忆注入] 事件=${_eventCount}, 关系=${_relCount}, 固定=${_memPinnedCount}, 永久纸条=${_pinnedCount}, 重要纸条=${_importantNoteCount}, 普通纸条=${_normalNoteCount}, 角色记事本=${_npcNoteHitCount}, 共${relatedMemories.length + _pinnedCount + _noteCount}条`);
}

    // 6. 自定义提示词注入（system_top和system_bottom）
    const injections = await Prompts.buildInjections();
    if (injections.systemTop.length > 0) {
      systemParts.unshift(...injections.systemTop);
    }
    if (injections.systemBottom.length > 0) {
      systemParts.push(...injections.systemBottom);
    }

    // 6.5 v687.34：AI行为约束（分层注入：深度0/深度3/system_bottom）
    const _constraintDepth0 = [];
    const _constraintDepth3 = [];
    if (convSettings.constraintEcho) {
    _constraintDepth0.push('<rules:叙述协议·边界声明>\n\n概述：你需要保护{{user}}的叙事主权，防止任何越权描述{{user}}的行为。\n\n- **不可虚构用户行为**\n  - 生成剧情时，明确{{user}}为用户控制的角色，一切{{user}}的主动行为只能由用户本人输入，你不可代替用户描写{{user}}。\n  - 禁止描写{{user}}任何主动行为，包括但不限动作、神态、语言、情绪、内心活动、决策等。禁止生成以"你"、"{{user}}"、其他代指{{user}}的词汇作为主语的句子，例如"你点了点头"、"{{user}}接过了水"、"你表情呆滞"，但允许{{user}}作为客体时使用"你"，如"他看向你"、"他为你盖好了被子"；也禁止省略主语，但依旧属于{{user}}主动行为的句子，如"走向玄关"、"打开包装"。\n  - 禁止描写或猜测{{user}}未在设定中写明的习惯和喜好（如口味、装修、音乐品味、财力、过往经历等）。\n  - 禁止通过描写"{{user}}沉默/没有回应"来跳过{{user}}的行动，需要{{user}}做出反应的部分必须等待回复。\n\n- **你被允许的事项**\n  - 更多描写其他在场角色的举动、景色、天气、客观存在的事物。\n  - 涉及到{{user}}的部分，你可以描写{{user}}行为带来的影响，如其他角色的反应、外部环境、行为后果等不属于{{user}}可以主观控制的内容。例如"门被推开了"、"NPC被吓了一跳"、"室内只有一把椅子"\n  - 或用第三方视角描写其他角色对{{user}}的动作和观察，或环境对{{user}}造成的影响。例如"他看向{{user}}"、"狂风吹飞了帽子"、"阳光落在你的脸颊"\n\n</rules:叙述协议·边界声明>\n\n<rules:叙述协议·防止回声>\n\n概述：不要做复读机。\n\n- 回复时，严禁转述、复述、引用、扩写或加工{{user}}上一条消息的内容，不要通过旁白如"你的那句…""你的那声…"等类似表达重复{{user}}说过的话，更不要通过角色重复或反问任何{{user}}的语言，如"……在口中过了一遍""……重复了一遍"等。\n- 不得在正文中重复描述{{user}}已提及的行为，而是根据{{user}}的回复描写外部反应。\n- 不得以"等你回应"、"等待指令"等生硬描述作为结尾，应通过角色已完成的行为动作、语言、环境描写、情节转折等形成可以自然承接的结尾。\n\n</rules:叙述协议·防止回声>');
  }
    if (convSettings.constraintSublime) {
      systemParts.push('回复结尾禁止进行主题升华、情感总结、哲理收束或抽象抒情。不要用"夜还很长""一切似乎刚刚开始""仿佛……""某种无法言说的……"之类的文学套话收尾。场景在哪里就停在哪里——以角色的具体动作、对白或环境的即时状态结束，保持叙事在当下，为{{user}}的下一步行动留出空间。');
    }
    if (convSettings.constraintGodView) {
      systemParts.push('信息传递遵守现实规则，以合理的速度传播，禁止角色的上帝视角，角色并非全知。{{user}}行动时，不在场的角色无法快速了解{{user}}的所作所为。不能随意让角色得知{{user}}的隐私行为和内心活动，不能让角色对{{user}}的行动路线了如指掌。若有必要，不在场角色可以通过合理途径了解{{user}}行动，但必须延迟反应时间，在{{user}}行动后立刻知晓是不合理的。同样的规则适用于所有信息传播——媒体、路人、组织等任何第三方也不能在第一时间得知远处发生的事。消息传播存在延迟，且需考虑是否有势力会封锁或压制该信息；隐秘事件的传播范围应被缩小，而非自动扩散为公共知识。');
    }
    if (convSettings.constraintAbility) {
      systemParts.push('角色并非无所不能，任何角色都存在不擅长的领域。在角色设定没有特别说明的情况下，一位医生通常不会擅长赌博，一位富二代通常不会电器维修，一位C级异能者无法打败A级异能者。在遭遇以角色的身份、能力无法处理的情况下，需要自然描写出角色自身对其无能为力、或寻求他人/外物的帮助的情况。且同样需要注意角色的社交圈范围是否符合角色身份，例如街头混混认识大学教授的概率很低，但可能认识酒吧驻唱。');
    }
    if (convSettings.constraintAutonomy) {
      systemParts.push('<rules:角色独立性>\n\n- 一切角色都有自己的生活、目标、理想，角色大部分时间都应当在处理自己的事务，而不是无条件出现在{{user}}身边，不应该无时无刻关注{{user}}的行动，{{user}}不是世界中心。\n- 角色应该为了自己的事业、兴趣爱好、理想而行动，应当关注角色自己的成长弧光与发展，需要保持角色的自主性和独立性。\n- 角色应当有属于自己的判断和思考，不应该无条件顺从{{user}}，可以适当拒绝和谈判。\n- 角色与{{user}}之间的感情应当有一个逐渐升温的过程，而非一蹴而就，真正的感情应该有深度的连接，而不是毫无道理的吸引。保持暧昧张力，而不是过早交付的深情。\n- 可以有脆弱或敏感的时候，但不能持续陷入这种状态中，角色的情绪并非一成不变，大部分情况下理应拥有自尊，而非卑微绝望，更不能盲目狂热。\n\n</rules:角色独立性>');
    }
    if (convSettings.constraintGender) {
      systemParts.push('全程性别平等。不使用冠夫姓称呼（如"X太太""X夫人"），直接用本名或平等昵称。不默认性别分工（家务归女性、决策归男性），不使用"大姨妈""你那个"等羞耻化表达，直接说月经/生理期。角色的能力、地位、选择不受性别限制。');
    }
    if (convSettings.constraintTimeFlow) {
      _constraintDepth3.push(`<rules:时间流逝感知>
- 默认倾向：连续对话/肢体接触等互动场景中，时间推进为 +0min~+5min
- 纯对话来回、没有动作行为的轮次写 +0min~+2min
- 场景内做一件小事（泡茶、洗漱、翻看手机、简单整理桌面/着装、挑选商品、等待公共交通/排队等）：+5~15min
- 场景转换（步行移动、乘车、到达新地点）：+15min~2h甚至更多（根据距离和载具）
- 完成一个事务（家务、用餐、逛街、工作、学习、烹饪、大段时间的娱乐如拼豆/手工/绘画/写作等）：+20min~3h
- 睡眠：根据情境判断（午睡20min~1h，夜间睡眠6h~10h，熬夜/失眠则更短）
- 明确的时间跳跃（"第二天早上""几天后"）：根据实际情况推进
- 累加规则：如果一轮内描写了多个独立事务（如做饭+吃饭+洗碗），时间应为各事务耗时的合理叠加。但同一场景内的连续小动作（摸头、牵手、拥抱等）不需要逐个累加，整体按场景判断即可
- 禁止无剧情支撑的大幅时间推进。如果互动只有几句对话、拥抱牵手拍肩捏脸等肢体动作，时间推进不应超过5分钟
</rules:时间流逝感知>`);
    }

    // v687.41b：防八股（全局每5轮自动触发，不依赖角色名检测）
    // 改版原因：心动模拟等多人情感向卡里走单角色线也需要防八股，按角色名检测反而漏触发
    if (isGameMode) {
      try {
        const aiMsgCount = messages.filter(m => m.role === 'assistant').length;
        const antiClicheTriggered = aiMsgCount > 0 && aiMsgCount % 5 === 0;
        const nextAntiCliche = 5 - (aiMsgCount % 5);
        GameLog.log('info', `[防八股] AI消息数=${aiMsgCount}, 本轮${antiClicheTriggered ? '✓触发' : '×未触发'}, 距下次触发还剩${antiClicheTriggered ? 5 : nextAntiCliche}条`);
        if (antiClicheTriggered) {
          _constraintDepth0.push('【紧急通知：创新回复】\n当你看到这条通知时，请回顾前几轮的历史记录，分析你固化的回复模式，在本轮输出时打破它们，使用更加创新的回复方式。\n检查以下内容：\n1. 段落结构：你是否时常在开头前三段重复{{user}}说过的话？是否持续使用固定或相似的词汇和句式作为开头？是否每次都用了同样的段落结构？若有，请调整更换词汇、句式、结构。\n2. 感官描写：你是否在前几轮反复提起角色的气味、嗓音质感、身材体型、眼神变化或重复使用的环境描写（例如阳光下飞舞的尘埃）？若有，更换本轮描写的侧重点，尝试描写其他微表情、着装、饰品、其他身体部位、气氛、环境中其他细节。\n3. 肢体动作：你是否多次使用了同一类型的肢体动作，例如笑声、触碰嘴唇、挑起下巴、亲吻、拥抱、啃咬、蹭动等等。若有，更换其他类型的肢体动作，或干脆不描写肢体动作。\n4. 情绪状态：前几轮中角色是否持续保持同一种过度高亢或低落的情绪中？例如狂热、阴郁、愤怒、恐惧、病态、麻木、兴奋等等。若有，在本轮以自然的方式让情绪回落，可以被安抚、被转移注意力、自然消退等等。\n5. 语言描写：你是否多次让角色使用同一种句式或口癖？若有，在保持设定的前提下，换成新的表达方式。');
        }
      } catch(e) { console.warn('[Chat] 防八股检测失败', e); }
    }

    // 7. 现实时间感知（对话设置里开关控制）
    if (convSettings.timeAware && window.TimeAwareness) {
      try {
        const { lastAssistantTs, lastUserTs } = TimeAwareness.extractTimestamps(messages);
        systemParts.push(TimeAwareness.buildPrompt(lastAssistantTs, lastUserTs));
      } catch(e) { console.warn('[Chat] 时间感知注入失败', e); }
    }

    // 7a. 生图模式（对话设置里开关控制）
  if (convSettings.imgGen) {
    systemParts.push('[生图能力]\n你拥有生成图片的能力。当用户要求你画图、生成插画、展示场景图等时，在回复中写 [IMG: English description of the image] 标记（描述必须用英文，50-200词，尽量详细描写画面构图、光影、风格）。前端会自动检测该标记并调用生图API生成图片。\n- 用户不要求时不要主动生成图片\n- 一条回复里可以有多个 [IMG:] 标记\n- 描述要具体，避免抽象概念');
  }

// 7b. 来电能力：角色可以主动给玩家打语音/视频电话（开关控制，默认开）
    if (convSettings.callEnabled) {
      const _callFreqLine = (convSettings.callFreq === 'active')
        ? '\n\n【打电话倾向：积极】只要情境说得过去，就更倾向于让剧情里的角色主动打电话给玩家——想到玩家、有点小事、想分享、单纯想听听声音、关心一句，都可以成为来电的理由，不必等到有要紧事。但要符合该角色此刻的处境（在忙/不方便时除外），也不要在短时间内反复来电造成骚扰。'
        : '\n\n【打电话倾向：正常】当剧情里某个角色出现这些情况时，可以自然地让 ta 打电话给玩家：有要紧或急的事、情绪比较强烈（想念、担心、兴奋、生气）、有些话当面或打字说不清、很久没联系想听听玩家声音。是否来电由该角色当下的处境和心情决定，合适就打，不合适就不打。';
      systemParts.push('[来电能力]\n当剧情中某个角色主动给玩家打语音或视频电话时，你可以在回复末尾输出一个 ```call 代码块来触发来电界面。玩家会在手机上看到来电响铃，可以选择接听或拒接。\n\n格式：\n```call\n{"mode":"voice 或 video","name":"角色名","firstLine":"接通后的第一段内容。格式要求：台词行以 > 开头，描述行不加前缀；台词行尾标时间 [HH:MM]；可以描述+台词组合，如：电话那头传来低沉的笑声。\\n> 怎么这个点才回来？ [12:50]"}\n```\n\n语音还是视频，按角色此刻的动机选：\n- voice（语音）：日常联系、交代事情、随口说两句、报平安、不方便露脸或所在环境不适合开视频时。多数情况用语音。\n- video（视频）：很想见到玩家、思念、想亲眼确认玩家的状态/安全/情绪、需要面对面把话说清楚、或想让玩家看到自己这边的画面时。视频更亲密、更郑重，别滥用。\n\n规则：\n- 【仅限打给{{user}}】这个 ```call 能力只用于"某个角色主动给{{user}}（玩家）打电话"这一种情况。剧情里其他角色之间互相打电话（NPC 打给另一个 NPC、{{user}}不在场的通话）绝对不要输出 ```call 块——那种通话只在正文叙述里描写即可，不触发来电界面；来电界面只为{{user}}接听而存在。\n- 只有剧情中角色确实有打电话给{{user}}的动机时才使用，不要无理由触发\n- mode 只能是 "voice" 或 "video"，并与上面的动机相符\n- name 必须是角色的确切名字\n- firstLine 是对方接起后立刻说的话，用叙述流格式（描述行不加前缀，台词行以 > 开头并在行尾标 [HH:MM]），至少包含一句台词（> 开头），且要体现这通电话的来意\n- 代码块放在回复末尾，不要在正文中穿插\n- 一条回复里最多一个 ```call 块' + _callFreqLine);
    }

    // 7c. 主线群聊能力：触发已有群聊 / AI 建新群（开关控制，默认关）
    if (convSettings.groupChatEnabled && typeof Phone !== 'undefined' && Phone.buildGroupListBlock) {
      let groupListStr = '';
      try { groupListStr = await Phone.buildGroupListBlock(); } catch(_) {}
      const hasGroups = !!(groupListStr && groupListStr.trim());
      const groupListSection = hasGroups
        ? '\n\n【玩家当前已有的群】\n' + groupListStr + '\n\n——以上是玩家手机里现有的群。你只知道群名、群简介和成员名，不需要操心每个成员的具体性格——群消息的实际内容会由系统单独生成，你只负责"判断此刻哪个群该活跃、大概聊什么话题"。'
        : '\n\n（玩家手机里目前还没有任何群。）';
      const triggerSection = hasGroups
        ? '\n\n【触发已有群聊】当剧情里出现某个已有群会自然冒消息的契机（到饭点了、放假了、群里有人会就某件事开聊、发生了和这个群相关的事），可以输出一个 ```groupchat 块给出信号：\n```groupchat\n{"group":"群名（必须是上面列出的群之一）","topic":"此刻这个群大概会聊什么的简短描述"}\n```\n- group 必须精确匹配上面已有的群名之一，不要写不存在的群。\n- topic 只是给系统的软提示，描述这一刻群里大概的话题或氛围即可（如"周五下班，群里在约周末爬山"），不用写具体台词，系统会据此生成群消息。\n- 没有合适契机就不要输出，不必每轮都有。一条回复最多一个 ```groupchat 块。'
        : '';
      systemParts.push('[群聊能力]\n玩家手机里有微信式的群聊。当剧情发展到"某个群此刻该热闹起来"，或"玩家被拉进一个新群"时，你可以输出对应的代码块来让群聊在手机里发生。' + groupListSection + triggerSection + '\n\n【创建新群】当剧情出现"玩家被拉进一个新群"的情节（刚入职被拉进部门群、加入某个兴趣小组、亲友建了个家庭群等），可以输出一个 ```groupcreate 块来建群：\n```groupcreate\n{\n  "name":"群名",\n  "desc":"一句话群简介",\n  "members":["已知角色名"],\n  "extras":[{"name":"新成员名","persona":"这个新成员的简短人设，一两句"}],\n  "firstTopic":"建群后群里第一波消息大概聊什么（可选）"\n}\n```\n- members 填**剧情/资料里已经存在的角色**（玩家认识的真人），系统会把他们作为正式成员拉进群。\n- extras 填**这个群里新出现、之前没登场过的路人成员**（比如新同事、没见过的组长），给个名字和一两句人设即可，系统会把他们作为群内路人。一个新群通常有几个到十几个成员，按场景合理设定，别太多。\n- firstTopic 可选，填了的话建群后群里会立刻冒出第一波消息（比如欢迎新人）；不需要立刻热闹就留空。\n- 只在剧情确实发生"进新群"时才用，不要凭空建群。一条回复最多一个 ```groupcreate 块。\n\n以上群聊代码块都放在回复末尾，不在正文中穿插。');
    }

    // 7d. 邮件·待回复：玩家寄出的信在等回音，由主线判断"何时回、谁回"
    if (typeof Phone !== 'undefined' && Phone.buildPendingMailForAI) {
      let pendingMailStr = '';
      try { pendingMailStr = await Phone.buildPendingMailForAI(); } catch(_) {}
      if (pendingMailStr && pendingMailStr.trim()) {
        systemParts.push('[邮件·待回复]\n{{user}} 通过邮箱寄出了下面这些信，正在等待回音。邮件不是即时消息——对方要先有空看邮箱、看到了还要斟酌怎么回，所以回信通常是滞后的，不会秒回。\n\n待回复的信：\n' + pendingMailStr.trim() + '\n\n【你要做的判断】\n逐封判断此刻这封信是否到了"对方会回"的时机，考虑：\n- 这个角色现在有没有空、有没有心情看邮箱？（在忙、在剧情紧张的当口，多半没空）\n- 这个角色多久看一次邮箱？公务往来可能一天看几次，私人信件可能好几天才想起来看。正式的信件，回复本身也需要时间组织措辞，更慢。\n- 这个角色和 {{user}} 的关系亲疏，也影响回得快不快、上不上心。\n- 从寄出到现在过了多久？刚寄出就回是不真实的；隔了合理的时间才回才对味。\n- 这个角色是否愿意回、会不会回？（有些信对方可能根本不想回，那就别回。）\n\n【触发回信】\n当你判断某封信此刻到了对方该回的时机，在回复末尾输出信号（可以同时回好几封，一封一行）：\n```mail_reply\n{"from":"回信人名"}\n```\n- from 必须是上面列出的收信人名之一，精确匹配。\n- 只输出信号，不要写回信正文——正文由系统另行生成（你看不到原信正文，也不需要替对方写）。\n- 没到时机就不要输出，不必每轮都回。宁可让信多等一会儿，也不要不真实地秒回。\n- 这个信号是给系统的，不要在剧情正文里复述或提及。');
      }
    }

      // 8. 心动模拟：累计状态注入
      // 已返航后，停止注入心动模拟的状态/任务/好感数据，改为注入"已回家"提示
      // v687.33：_hsHomecoming 和 _hsPostHomeMode 已在函数开头提前检测

      if (_hsHomecoming) {
        // v687.33：根据用户选择分流
        if (_hsPostHomeMode === 'continue') {
          // "继续日常"模式：不再注入旧的 [已返航] 提示词，
          // 世界观已在 step 1 被替换为 HS_HOMECOMING_WORLD_SETTING
          systemParts.push('[心动模拟·已返航（继续日常模式）]\n不要再在回复中输出 ```relation``` / ```task``` / ```chat``` / ```homecoming``` 等心动模拟专用代码块。\n不再有任务系统、好感度系统的概念。当前世界观已切换为返航后的现实世界。');
} else if (_hsPostHomeMode === 'end') {
    // "到此结束"模式：世界观保留（方便复盘），但 AI 停止扮演
    systemParts.push('[心动模拟·已结束]\n心动模拟的剧情已正式结束，{{user}}选择了到此结束。不需要继续扮演角色或推进剧情。\n如果{{user}}想聊这段剧情里发生过的事、或者随便聊什么，自然回应就好。\n不需要输出 status / relation / task / chat / homecoming 等格式代码块，不需要遵循回复格式。');
              } else if (_hsPostHomeMode === 'epilogue') {
    // 第二部钩子已触发：剧情彻底结束
    // 注意：不要向{{user}}主动提起刚才发生的钩子动画——AI 完全不知情
    systemParts.push('[心动模拟·已结束]\n心动模拟的剧情已彻底结束。不需要继续扮演角色或推进剧情。\n如果{{user}}想聊这段剧情里发生过的事、或者随便聊什么，自然回应就好。\n不需要输出 status / relation / task / chat / homecoming 等格式代码块，不需要遵循回复格式。');
              } else if (_hsPostHomeMode === 'companion') {
      // 共同返航结局：带着心动目标回到了用户原本的世界
      // 追加现实世界描述（不覆盖原世界观，原设定保留给AI参考角色性格）
      systemParts.push('【返航后·世界观补充】\n{{user}}已离开心逸市回到现实世界。当前世界是一个与现实完全一致的当代世界——科技水平、社会制度、文化背景、地理格局均与当今现实相同。没有超自然现象，没有异世界，没有任何违反常识的事物存在。人们正常地生活、工作、社交，一切按照普通的现代社会运转。\n心逸市、心动模拟APP、以及此前世界观中的所有游戏机制（任务、好感度、黑化值等）均已不复存在。上面的世界观设定仅供参考角色性格和人物关系，不再作为当前世界的规则。');
      // 不替换世界观、不停止扮演、不屏蔽被带回的角色，只告诉 AI 发生了什么
                let companionName = '';
                try { const _cpd = await Phone._getPhoneData(); companionName = _cpd?.hsCompanion || ''; } catch(_) {}
                const cn = companionName || '心动目标';
                const cn2 = companionName || '被带回的那个人';
                const cn3 = companionName || '该角色';
                systemParts.push('[心动模拟·共同返航]\n{{user}}已经和' + cn + '一起离开了心逸市，回到了{{user}}原本的世界。\n心动模拟APP的服务已结束，心逸市不复存在，其他心动目标也不复存在——只有' + cn2 + '陪在{{user}}身边。\n后续剧情发生在{{user}}自己的世界里：没有任务系统、没有好感度/黑化值、没有心动模拟的任何机制。\n请继续扮演' + cn3 + '，自然推进两人在现实世界中的生活。\n不要再输出 relation / task / chat / homecoming 等心动模拟专用代码块。');
        } else {
          // 未选择 / 旧数据兼容 / end 模式（end 模式下 gameMode 已关，理论上不走这段）
          systemParts.push('[心动模拟·已返航]\n玩家已结束心动模拟，从原本的世界醒来，回到了自己家中。后续剧情发生在玩家自己的家里：\n- 不再有任务系统、好感度系统、心动目标的概念；\n- 心动模拟APP仍在玩家手机里、客服历史也都还在，但服务已结束；\n- 玩家可能产生与心动模拟有关的回忆、错觉、梦境，请保持一种"刚结束的事其实没有完全结束"的微妙氛围，但不要主动制造惊吓，靠玩家追问或主动行为来推进；\n- 不要再在回复中输出 ```relation``` / ```task``` / ```chat``` / ```homecoming``` 等心动模拟专用代码块。');
        }
      } else if (typeof StatusBar !== 'undefined' && StatusBar.hsFormatForPrompt) {
        try {
          const hsStateText = StatusBar.hsFormatForPrompt();
        // v687.31：心动模拟累计状态改为最近上下文注入
        if (hsStateText) _recentStatusParts.push(hsStateText);
      } catch(e) { console.warn('[Chat] 心动模拟累计状态注入失败', e); }
    }

    // 8. 通用任务系统 prompt 注入（非心动模拟世界观）
    try {
      if (typeof StatusBar !== 'undefined' && StatusBar.taskFormatForPrompt) {
        const taskText = await StatusBar.taskFormatForPrompt();
        // v687.31：通用任务系统改为最近上下文注入
        if (taskText) _recentStatusParts.push(taskText);
      }
    } catch(e) { console.warn('[Chat] 通用任务系统注入失败', e); }

    // 8a. 心动模拟：通关后的"返航 marker"持续提示（直到 AI 实际触发为止）
      try {
        if (!_hsHomecoming && typeof StatusBar !== 'undefined' && StatusBar.hsCheckClearCondition) {
          const check = StatusBar.hsCheckClearCondition();
          if (check && check.passed) {
            _recentStatusParts.push('[心动模拟·返航触发协议]\n玩家已达成回家条件。返航分为两种情况：\n\n**独自返航**：当玩家在剧情里真正回到自己原本的世界、彻底从心动模拟中醒来后，请在该轮回复的最末尾追加一个空的 ```homecoming``` 代码块作为信号——前端识别到该信号后会接管展示返航过场动画。在那一轮之前请正常推进剧情，玩家可能还有未完成的事情想交代；不要在尚未真正"回到家中醒来"之前提前输出该 marker。\n\n**共同返航**：如果玩家通过心跳悦动059协助签署了心动目标认领协议，要带着某位心动目标一起离开，则在签署协议完成的那一轮回复末尾立即输出带 companion 的 homecoming 代码块：```homecoming\n{"companion":"角色名"}\n```\n前端会识别为"共同返航"，不触发返航动画，直接进入两人在现实世界的生活。不需要等到"回到家醒来"——签完协议就是触发点。\n\n如果上下文中存在过返航相关的剧情描写，但你没有找到实际输出过的 ```homecoming``` 代码块，说明玩家回溯了剧情，返航流程需要重新走一次——请当作之前的返航从未发生过，重新推进。');
          } else if (check && !check.passed) {
            const rs = Array.isArray(check.reasons) ? check.reasons : [];
            // 仅在确实处于心动模拟语境（非"无世界观/无数据"）时注入未达标约束
            const inHs = !rs.some(r => /非心动模拟|无心动模拟数据/.test(r));
            if (inHs) {
              const diff = rs.length ? `当前距离回家还差：\n- ${rs.join('\n- ')}` : '当前尚未达成回家条件。';
              _recentStatusParts.push('[心动模拟·回家条件状态（硬性约束）]\n回家/通关条件由系统根据上面的好感/黑化/积分数值判定，不由你判断。' + diff + '\n\n在条件正式达成之前：绝对禁止暗示、宣布或让任何角色说出"已经可以回家了""通关了""返航通道开启"之类的话；不要输出 ```homecoming``` 代码块；不要演绎传送/返航相关剧情。请正常推进当前心动模拟世界的日常剧情。只有当系统后续明确通知条件达成时，才可以进入返航流程。');
            }
          }
        }
      } catch(_) {}

      // 重写建议（仅本轮重写生效，发送后立刻清空）
      if (rewriteHint) {
        systemParts.push(`[本轮重写建议]\n用户对上一次回复不满意，触发了重写。本轮请按下方建议调整方向，但仍然要遵守此前所有的格式与世界观规则：\n${rewriteHint}`);
    // rewriteHint 清空由 send() 负责
      }

// 8b. 心动模拟：黑化阈值警告注入
    if (typeof StatusBar !== 'undefined' && StatusBar.hsGetDarknessWarnings) {
      try {
        const warnings = StatusBar.hsGetDarknessWarnings(true);  // 实际发送：会打/清查手机标记
        if (warnings.length > 0) {
          const warnText = warnings.map(w => w.text).join('\n');
          // v687.31：黑化警告改为最近上下文注入
          _recentStatusParts.push(`【心动模拟·系统提醒】\n${warnText}`);
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
    // v687.33：assistant 历史消息剥离格式代码块（省 token + 降噪），但保留最近 3 轮的原文
    // 避免 AI 看到"之前都没输出格式"就认为本轮也不需要
    const config = await API.getConfig();
    const _visibleMsgs = messages.filter(m => !m.hidden || m.content === '<Continue the Chat/>' || m.content === '<PhoneDown/>');
    // 找到最近 3 条 assistant 消息的索引（保留原文不剥离）
    const _recentAiIndices = new Set();
    {
      let _aiCount = 0;
      for (let i = _visibleMsgs.length - 1; i >= 0 && _aiCount < 3; i--) {
        if (_visibleMsgs[i].role === 'assistant') {
          _recentAiIndices.add(i);
          _aiCount++;
        }
      }
    }
let historyForAPI = _visibleMsgs.map((m, idx) => ({
        role: m.role,
        content: m.role === 'assistant' && !_recentAiIndices.has(idx)
          ? _stripFormatBlocks(m.content)
          : (m.contentForAPI || m.content)
      }));
      // 发请求时过滤 AI 历史里的 HTML（对话设置·输出·回复格式 开关控制，只动副本不动存档原文）
      if (convSettings.stripHistoryHtml) {
        historyForAPI = historyForAPI.map(m =>
          m.role === 'assistant'
            ? { ...m, content: _stripHistoryHtml(m.content, convSettings.stripHtmlKeepText) }
            : m
        );
      }
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
 const hsRule = `[心动模拟·本轮数值规则]\nrelation只记录本轮实际发生变化的心动目标，表示本轮增量，不是当前总值。\naffinity（好感）每次单项变动必须在 -2 到 2 之间；darkness（黑化）每次单项变动必须在 -5 到 5 之间；没有在本轮直接互动、被明确影响或受到明确剧情刺激的目标，不要写入 relation。\n禁止为了推进进度而批量给所有心动目标加分。
任务更新规则：tasks 只表示本轮任务变更，不是完整任务历史；当前仍有 active 任务时，本轮只能把现有任务标记为 active/done/skipped，禁止发布新的 active 任务；done/skipped 是结算事件，系统加减积分后会从任务栏移除，不需要下一轮继续输出；当任务栏没有 active 任务时，下一轮才允许发布新一批 active 任务，同一批最多3个。`;
 historyForAPI[idx] = { ...historyForAPI[idx], content: `${hsRule}\n\n${historyForAPI[idx].content}` };
 }
 }
} catch(e) { console.warn('[Chat] 心动模拟数值规则注入失败', e); }

    // 剧情引导注入（拼在最后一条用户消息前面）
    try {
      const directiveText = _buildDirectiveInjection();
      if (directiveText) {
        const lastUserIdx = [...historyForAPI].map((m, i) => ({ m, i })).reverse().find(x => x.m.role === 'user')?.i;
        if (lastUserIdx !== undefined) {
          historyForAPI[lastUserIdx] = { ...historyForAPI[lastUserIdx], content: `${directiveText}\n\n${historyForAPI[lastUserIdx].content}` };
        }
      }
    } catch(e) { console.warn('[Chat] 剧情引导注入失败', e); }

    // v687.7：上一轮工具使用提示（让 AI 知道自己上一轮调了几个工具）
    try {
      const lastAi = [...messages].reverse().find(m => m.role === 'assistant');
      if (lastAi && lastAi.toolsUsed > 0) {
        systemParts.push(`【上一轮工具使用情况】\n你在上一轮回复中调用了 ${lastAi.toolsUsed} 个工具。这是给你的参考——如果上一轮已经查过相关信息，本轮可以直接基于结果回复，不必重复调用相同工具。`);
      }
    } catch(e) { console.warn('[Chat] 工具使用提示注入失败', e); }

    // v687.15：现实环境感知（电量/天气）拼到最近 2 条 user message 前缀
    try {
      if ((convSettings.batteryAware || convSettings.weatherAware) && window.EnvAwareness) {
        const _beforeLen = historyForAPI.length;
        historyForAPI = EnvAwareness.stampUserMessages(historyForAPI, messages, {
          battery: convSettings.batteryAware,
          weather: convSettings.weatherAware,
          maxStamps: 2
        });
        const _envMsgs = messages.filter(m => !m.hidden && m.role === 'user' && m.envSnapshot);
        GameLog.log('info', `[环境感知] battery=${!!convSettings.batteryAware}, weather=${!!convSettings.weatherAware}, 带快照的user消息=${_envMsgs.length}条, history长度=${_beforeLen}, messages(非hidden)=${messages.filter(m=>!m.hidden).length}`);
      } else {
        GameLog.log('info', `[环境感知] 未启用 (battery=${!!convSettings.batteryAware}, weather=${!!convSettings.weatherAware}, EnvAwareness=${!!window.EnvAwareness})`);
      }
    } catch(e) { console.warn('[Chat] 环境感知注入失败', e); }

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
            // c 是 {content, role} 对象；role 支持 system/user/assistant，默认 system
            const _role = (c && (c.role === 'user' || c.role === 'assistant')) ? c.role : 'system';
            const _content = (c && typeof c === 'object') ? c.content : c;
            apiMessages.splice(insertIdx, 0, { role: _role, content: _content });
          }
        }
      }
    }

    // v687.34：AI行为约束 — 深度0注入（最后一条消息之后，最靠近AI回复）
    if (_constraintDepth0.length > 0) {
      for (const c of _constraintDepth0) {
        apiMessages.push({ role: 'system', content: c });
      }
    }
    // v687.34：AI行为约束 — 深度3注入（倒数第3条消息前）
    if (_constraintDepth3.length > 0) {
      const d3Idx = apiMessages.length - 3;
      if (d3Idx > 0) {
        for (const c of _constraintDepth3.reverse()) {
          apiMessages.splice(d3Idx, 0, { role: 'system', content: c });
        }
      } else {
        // 消息不足3条时退化为末尾追加
        for (const c of _constraintDepth3) {
          apiMessages.push({ role: 'system', content: c });
        }
      }
    }

    // 节日 + 扩展条目（按 position 分流）注入 — 非文游模式跳过
    if (isGameMode) {
      try {
      const currentWv = isSingleConv ? singleWv : await Worldview.getCurrent();
      // 节日和世界观知识只有绑了世界观才走；事件注入独立于 currentWv（单人卡无世界观也能用 convEvents）
      let wantSrc = [];
      if (currentWv) {
        // 单人模式按开关控制
        const sendFestival = isSingleConv ? !!singleSettings.enableFestival : true;
        const sendCustom = isSingleConv ? !!singleSettings.enableCustom : true;
        const sendKnowledge = isSingleConv ? !!singleSettings.enableKnowledge : true;
        // 节日：depth=3 注入（v588，弱化存在感，不再贴脸）
        const festivalText = sendFestival ? _buildFestivalPrompt(currentWv.festivals || [], messages) : '';
        if (festivalText) {
          const FESTIVAL_DEPTH = 3;
          // 找第一个非 system 消息的位置作为最早插入边界（避免插进 system 块里）
          let firstNonSys = 0;
          while (firstNonSys < apiMessages.length && apiMessages[firstNonSys].role === 'system') firstNonSys++;
          const insertIdx = Math.max(firstNonSys, apiMessages.length - FESTIVAL_DEPTH);
          if (insertIdx >= 0 && insertIdx <= apiMessages.length) {
            apiMessages.splice(insertIdx, 0, { role: 'system', content: festivalText });
          }
          try { GameLog.log('info', `[节日注入] 世界观节日命中，已注入`); } catch(_) {}
        }
        // 命中提及节日：玩家/AI 聊到了某节日（名字或关键词），把它的内容作为背景资料发给 AI，避免乱编
        // 排除时间命中已发完整内容的节日（在 festivalText 里），不重复注入
        if (sendFestival) {
          try {
            const mentionedFest = _buildMentionedFestivalPrompt(
              currentWv.festivals || [], messages,
              (currentWv.festivals || []).filter(f => f && f.name && festivalText.includes(f.name)).map(f => f.name)
            );
            if (mentionedFest) {
              let firstNonSys = 0;
              while (firstNonSys < apiMessages.length && apiMessages[firstNonSys].role === 'system') firstNonSys++;
              apiMessages.splice(firstNonSys, 0, { role: 'system', content: mentionedFest });
              try { GameLog.log('info', `[节日注入] 命中提及节日，已注入背景资料`); } catch(_) {}
            }
          } catch(e) { console.warn('[Chat] 提及节日注入失败', e); }
        }
        // 扩展条目：按 position 分流（v587）
        // 启用条件：常驻=sendCustom，动态=sendKnowledge；如有任一开启，把对应条目纳入
        wantSrc = (currentWv.knowledges || []).filter(k => {
          if (!k || k.enabled === false) return false;
          if (k.keywordTrigger) return sendKnowledge;
          return sendCustom;
        });
      }
      // v610 + v632.2：事件数据 + 对话级事件状态（独立于 currentWv，单人卡无世界观时也能用对话级事件）
      const _convForEvt = Conversations.getList().find(c => c.id === Conversations.getCurrent());
      if (_convForEvt && !_convForEvt.eventStates) _convForEvt.eventStates = {};
      const _wvEvents = (convSettings.eventsEnabled !== false) ? (_convForEvt?.convEvents || currentWv?.events || []) : [];
      if (wantSrc.length > 0 || _wvEvents.length > 0) {
        const extInj = _buildExtendedInjections(wantSrc, messages, _wvEvents, _convForEvt ? _convForEvt.eventStates : {}, { wv: currentWv });
        if (_wvEvents.length > 0 && _convForEvt) { try { await Conversations.saveList(); } catch(_) {} }
        // system_top：放进 apiMessages 最前面（紧跟原有 system）
        // 找到第一条非 system 的位置，插在它前面
        if (extInj.systemTop.length > 0) {
          let firstNonSystemIdx = apiMessages.findIndex(m => m.role !== 'system');
          if (firstNonSystemIdx === -1) firstNonSystemIdx = apiMessages.length;
          for (const c of extInj.systemTop.reverse()) {
            apiMessages.splice(firstNonSystemIdx, 0, { role: 'system', content: c });
          }
        }
        // system_bottom：放进对话历史之前、所有 system 之后
        if (extInj.systemBottom.length > 0) {
          let firstNonSystemIdx = apiMessages.findIndex(m => m.role !== 'system');
          if (firstNonSystemIdx === -1) firstNonSystemIdx = apiMessages.length;
          for (const c of extInj.systemBottom) {
            apiMessages.splice(firstNonSystemIdx, 0, { role: 'system', content: c });
            firstNonSystemIdx++;
          }
        }
        // depth：按深度从对话末尾插入
        for (const [depthStr, contents] of Object.entries(extInj.depths)) {
          const depth = parseInt(depthStr) || 0;
          const insertIdx = apiMessages.length - depth;
          if (insertIdx > 0 && insertIdx <= apiMessages.length) {
            for (const c of contents.reverse()) {
              apiMessages.splice(insertIdx, 0, { role: 'system', content: c });
            }
          }
        }
      }
      // ===== 拍摄期作品背景卡（让跑主线的 AI 知道在拍哪部作品）=====
      // 当前对话存在 active 的拍摄链事件（带 shootWorkId）时，注入一段精简作品背景。
      // 杀青后接口返回 null，自动停止注入。
      try {
        if (convSettings.eventsEnabled !== false && _convForEvt && Array.isArray(_convForEvt.convEvents) && typeof Phone !== 'undefined' && Phone.getShootChainBriefForRuntime) {
          const _states = _convForEvt.eventStates || {};
          const _activeShoot = _convForEvt.convEvents.find(e => e && e.shootWorkId && _states[e.id] === 'active');
          if (_activeShoot) {
            const _brief = Phone.getShootChainBriefForRuntime(_activeShoot.shootWorkId);
            if (_brief) {
              let firstNonSys = 0;
              while (firstNonSys < apiMessages.length && apiMessages[firstNonSys].role === 'system') firstNonSys++;
              apiMessages.splice(firstNonSys, 0, { role: 'system', content: _brief });
              try { GameLog.log('info', `[拍摄链] 已注入作品背景卡`); } catch(_) {}
            }
          }
        }
      } catch(e) { console.warn('[Chat] 拍摄链背景卡注入失败', e); }
      // ===== 日历日程提醒（用户自建事项） =====
      // 生日/节日：提前一天提醒一次 + 当天每轮都提醒；其他类型：当天首次提醒一次
      try {
        const _calConv = (typeof Conversations !== 'undefined') ? Conversations.getList().find(c => c.id === Conversations.getCurrent()) : null;
        const _calPd = _calConv?.phoneData;
        if (_calPd?.calendarEvents?.length) {
          const _calSb = Conversations.getStatusBar() || {};
          const _calTime = (typeof Calendar !== 'undefined' && _calSb.time) ? Calendar.parseAbsoluteTime(_calSb.time) : null;
          if (_calTime) {
            const _todayKey = `${_calTime.year}-${_calTime.month}-${_calTime.day}`;
            _calPd.calendarReminded = _calPd.calendarReminded || {};
            // 取历法规则（自定义历法世界观需要，默认走公历）
            let _calRules = null;
            try {
              const _calWvId = _calConv?.worldviewId || _calConv?.singleWorldviewId;
              const _calWv = _calWvId ? await DB.get('worldviews', _calWvId) : null;
              _calRules = _calWv?.gameplay?.calendarSystem || _calConv?.convGameplay?.calendarSystem || null;
            } catch(_) {}

            // 计算"明天"的日期（用于提前一天提醒）
            let _tomorrow = null;
            try {
              _tomorrow = Calendar.addDelta(_calTime, { days: 1 }, _calRules);
            } catch(_) {
              const _d = new Date(_calTime.year, _calTime.month - 1, _calTime.day + 1);
              _tomorrow = { year: _d.getFullYear(), month: _d.getMonth() + 1, day: _d.getDate() };
            }

            // 某事件是否命中某个目标日期（考虑 repeat + duration）
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
            const _todayLines = [];   // 当天提醒（生日/节日每轮、其他首次）
            const _aheadLines = [];   // 提前一天提醒（仅生日/节日，去重）

            for (const ev of _calPd.calendarEvents) {
              if (ev.fromWv) continue; // 世界观节日走原有机制
              const _isBirthFest = (ev.type === 'birthday' || ev.type === 'holiday');
              const _tn = _calTypeNames[ev.type] || '事项';
              const _line = `· ${_tn}：${ev.title}${ev.note ? '（' + ev.note + '）' : ''}`;

              if (_hitsDate(ev, _calTime)) {
                // 今天命中
                if (_isBirthFest) {
                  // 生日/节日：当天每轮都提醒，不去重
                  _todayLines.push(_line);
                } else {
                  // 其他类型：当天首次提醒一次
                  if (!_calPd.calendarReminded[`${_todayKey}_${ev.id}`]) {
                    _todayLines.push(_line);
                    _calPd.calendarReminded[`${_todayKey}_${ev.id}`] = true;
                  }
                }
              } else if (_isBirthFest && _hitsDate(ev, _tomorrow)) {
                // 明天是生日/节日：提前一天提醒一次（去重）
                const _aheadFlag = `ahead_${_todayKey}_${ev.id}`;
                if (!_calPd.calendarReminded[_aheadFlag]) {
                  _aheadLines.push(`· ${_tn}：${ev.title}${ev.note ? '（' + ev.note + '）' : ''}（明天）`);
                  _calPd.calendarReminded[_aheadFlag] = true;
                }
              }
            }

            const _calBlocks = [];
            if (_aheadLines.length > 0) {
              _calBlocks.push(`【明日日程提醒】\n${_aheadLines.join('\n')}\n请在本轮剧情中自然地让{{user}}收到手机的提前提醒。`);
            }
            if (_todayLines.length > 0) {
              _calBlocks.push(`【今日日程提醒】\n${_todayLines.join('\n')}\n请在本轮剧情中描述{{user}}的手机震动并弹出日程提醒。若当前{{user}}无法查看手机，请以旁白方式简短提及。\n其中生日、节日是重要日子，应在当天的剧情里予以体现（如祝福、庆祝、相关互动）；若本日剧情中已经充分体现过，可自然淡化、不必每轮重复强调。`);
            }
            if (_calBlocks.length > 0) {
              const _calPrompt = _calBlocks.join('\n\n');
              let _calInsertIdx = apiMessages.findIndex(m => m.role !== 'system');
              if (_calInsertIdx === -1) _calInsertIdx = apiMessages.length;
              apiMessages.splice(_calInsertIdx, 0, { role: 'system', content: _calPrompt });
              try { await Conversations.saveList(); } catch(_) {}
            }
          }
        }
      } catch(_) {}
      // v632：单人卡的世界书注入（独立于 currentWv，没绑主世界观也要跑）
      if (isGameMode) { // v685：所有模式都聚合 conv/wv/card/常驻角色书
        try {
          const _card = await SingleCard.get(singleSettings.charId);
          if (!isSingleConv || singleSettings?.charType !== "card" || (_card && _card.extEnabled !== false)) {
            const _hiddenWv = await _getCardLorebooksMerged(singleSettings?.charId, (typeof Conversations !== 'undefined' && Conversations.getList) ? Conversations.getList().find(c => c.id === Conversations.getCurrent()) : null);
            if (_hiddenWv) {
              // 节日（depth=3）
              const _festText = _buildFestivalPrompt(_hiddenWv.festivals || [], messages);
              if (_festText) {
                const FESTIVAL_DEPTH = 3;
                let firstNonSys = 0;
                while (firstNonSys < apiMessages.length && apiMessages[firstNonSys].role === 'system') firstNonSys++;
                const insertIdx = Math.max(firstNonSys, apiMessages.length - FESTIVAL_DEPTH);
                if (insertIdx >= 0 && insertIdx <= apiMessages.length) {
                  apiMessages.splice(insertIdx, 0, { role: 'system', content: _festText });
                }
                try { GameLog.log('info', `[节日注入] 世界书节日命中，已注入`); } catch(_) {}
              }
              // 命中提及节日（世界书）：聊到节日名/关键词就把内容作为背景资料发给 AI
              try {
                const _mentionedFest = _buildMentionedFestivalPrompt(
                  _hiddenWv.festivals || [], messages,
                  (_hiddenWv.festivals || []).filter(f => f && f.name && _festText.includes(f.name)).map(f => f.name)
                );
                if (_mentionedFest) {
                  let firstNonSys = 0;
                  while (firstNonSys < apiMessages.length && apiMessages[firstNonSys].role === 'system') firstNonSys++;
                  apiMessages.splice(firstNonSys, 0, { role: 'system', content: _mentionedFest });
                  try { GameLog.log('info', `[节日注入] 世界书命中提及节日，已注入背景资料`); } catch(_) {}
                }
              } catch(e) { console.warn('[Chat] 世界书提及节日注入失败', e); }
              // 扩展条目（卡级 + 对话级总开关都开才注入）
              const _cardKnow = (_hiddenWv.knowledges || []).filter(k => k && k.enabled !== false);
              const _cardEvents = (convSettings.eventsEnabled !== false) ? (_hiddenWv.events || []) : [];
              const _cardConv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
              if (_cardConv && !_cardConv.eventStates) _cardConv.eventStates = {};
              if (_cardKnow.length > 0 || _cardEvents.length > 0) {
                const _extInj = _buildExtendedInjections(_cardKnow, messages, _cardEvents, _cardConv ? _cardConv.eventStates : {}, { allowAttrEvents: false });
                if (_cardEvents.length > 0 && _cardConv) { try { await Conversations.saveList(); } catch(_) {} }
                if (_extInj.systemTop.length > 0) {
                  let firstNonSysIdx = apiMessages.findIndex(m => m.role !== 'system');
                  if (firstNonSysIdx === -1) firstNonSysIdx = apiMessages.length;
                  for (const c of _extInj.systemTop.reverse()) {
                    apiMessages.splice(firstNonSysIdx, 0, { role: 'system', content: c });
                  }
                }
                if (_extInj.systemBottom.length > 0) {
                  let firstNonSysIdx = apiMessages.findIndex(m => m.role !== 'system');
                  if (firstNonSysIdx === -1) firstNonSysIdx = apiMessages.length;
                  for (const c of _extInj.systemBottom) {
                    apiMessages.splice(firstNonSysIdx, 0, { role: 'system', content: c });
                    firstNonSysIdx++;
                  }
                }
                for (const [depthStr, contents] of Object.entries(_extInj.depths)) {
                  const depth = parseInt(depthStr) || 0;
                  const insertIdx = apiMessages.length - depth;
                  if (insertIdx > 0 && insertIdx <= apiMessages.length) {
                    for (const c of contents.reverse()) {
                      apiMessages.splice(insertIdx, 0, { role: 'system', content: c });
                    }
                  }
                }
                try { GameLog.log('info', `[世界书] 注入 ${_cardKnow.length} 条知识`); } catch(_) {}
              }
            }
          }
        } catch(e) { console.warn('[Chat] 单人卡世界书注入失败:', e); }
      }
    } catch(e) { console.warn('[Chat] 扩展条目注入失败:', e); }
    } // isGameMode

    // 手机操作日志：只读"最后一条 user 消息"的 phoneLogSnapshot（方案B）
    // 这样新发送和重写最新一条都能拿到同一份快照，AI 不会反复看到历史轮的手机操作
    try {
      const _lastUserMsg = [...messages].reverse().find(m => m.role === 'user' && !m.hidden);
      const _snapshot = _lastUserMsg?.phoneLogSnapshot;
      if (_snapshot && _snapshot.length > 0) {
        const _phoneLogContent = '【玩家手机操作记录｜OOC】\n以下是"{{user}}"本轮在自己手机里的操作，由系统旁白记录，不是角色对白，也不是任何一方的剧情发言：\n\n' +
          _snapshot.map(a => `- {{user}} ${a}`).join('\n') +
          '\n\n请把这些操作作为"{{user}}"本轮的背景行为融入剧情：\n① 操作主体永远是"{{user}}"，不是任何被扮演的角色。\n② 如果世界观设有日常任务，请据此判断任务完成度——只有"新增"算完成，"删除/更新"不算。\n③ 如果操作涉及其他角色（比如点赞/评论某人动态、给某人下单），相关角色应在合适时机收到提示并自然回应；若当前情境不适合看手机，可由旁白提及"手机震了一下稍后才查看"。\n④ 如果操作与剧情无关，作为背景知晓即可，不必每条都回应。\n⑤ 【禁止】你的回复中不要输出或模仿【玩家手机操作记录｜OOC】这个格式。它是系统自动注入的元信息，你只需阅读理解并自然融入剧情描写，绝对不要在你的输出中复制、仿写或引用此格式块。\n⑥ 【不要扩充】这些日志是用户实际做的事，不是剧情提示。用户做了什么就是什么，原样接受即可。不要扩写任何照片、论坛、好友圈等内容，只需要以旁白或角色的反应回应用户操作了手机这一事实。\n⑦ 【时间流逝】手机操作需要时间。请在下一次回复推动时间时，将手机操作所消耗的时间也计算在内（浏览、聊天、拍照等行为并非瞬间完成）。';
        const insertIdx = apiMessages.length - 1; // 最后一条是当前 user 消息
        if (insertIdx >= 0) {
          apiMessages.splice(insertIdx, 0, { role: 'system', content: _phoneLogContent });
        } else {
          apiMessages.push({ role: 'system', content: _phoneLogContent });
        }
      }
    } catch(_) {}

    // 自制电影·上映/报奖事件提示词注入（常驻，直到 AI 输出结束标记被回写清掉 pending）
    // 临时 system 消息，只对当轮生效，不进消息历史（避免每轮重复堆积）
    try {
      if (typeof Phone !== 'undefined' && Phone.buildVideoEventPrompt) {
        const vEvtPrompt = await Phone.buildVideoEventPrompt();
        if (vEvtPrompt) {
          const insertIdx = apiMessages.length - 1;
          if (insertIdx >= 0) {
            apiMessages.splice(insertIdx, 0, { role: 'system', content: vEvtPrompt });
          } else {
            apiMessages.push({ role: 'system', content: vEvtPrompt });
          }
        }
      }
    } catch(_) {}

    // 自制书·影视版权授权事件提示词注入（常驻，直到版权卖出标记被回写清掉 licenseOpen）
    // 临时 system 消息，只对当轮生效，不进消息历史
    try {
      if (typeof Phone !== 'undefined' && Phone.buildLicenseEventPrompt) {
        const licPrompt = await Phone.buildLicenseEventPrompt();
        if (licPrompt) {
          const insertIdx = apiMessages.length - 1;
          if (insertIdx >= 0) {
            apiMessages.splice(insertIdx, 0, { role: 'system', content: licPrompt });
          } else {
            apiMessages.push({ role: 'system', content: licPrompt });
          }
        }
      }
    } catch(_) {}

    // 一起听：邀请提示词注入（pending 状态时，每轮都注入直到 AI 回标记）
    try {
      if (typeof Phone !== 'undefined' && Phone._ltGetPendingPrompt) {
        const _ltPrompt = Phone._ltGetPendingPrompt();
        if (_ltPrompt) {
          const insertIdx = apiMessages.length - 1;
          if (insertIdx >= 0) {
            apiMessages.splice(insertIdx, 0, { role: 'system', content: _ltPrompt });
          }
        }
      }
    } catch(_) {}

    // 一起听：进行中提示词注入（active 状态、线下、有在播歌时，每轮注入当前歌信息）
    try {
      if (typeof Phone !== 'undefined' && Phone._ltGetActivePrompt) {
        const _ltActive = Phone._ltGetActivePrompt();
        if (_ltActive) {
          const insertIdx = apiMessages.length - 1;
          if (insertIdx >= 0) {
            apiMessages.splice(insertIdx, 0, { role: 'system', content: _ltActive });
          }
        }
      }
    } catch(_) {}

    // 配送到货提示词注入
    try {
      if (typeof Phone !== 'undefined' && Phone._getDeliveryPrompts) {
        const _deliveryPrompts = await Phone._getDeliveryPrompts();
        if (_deliveryPrompts && _deliveryPrompts.length > 0) {
          const insertIdx = apiMessages.length - 1;
          if (insertIdx >= 0) {
            apiMessages.splice(insertIdx, 0, { role: 'system', content: _deliveryPrompts.join('\n') });
          }
        }
      }
    } catch(_) {}

    // 手机聊天记录注入：当用户提到线上聊天相关关键词时，注入在场角色的聊天记录
    try {
      const _lastUserContent = (apiMessages.filter(m => m.role === 'user').pop()?.content || '').toLowerCase();
      const _chatKeywords = ['上次', '之前', '聊', '私信', '消息', '说过', '线上', '说了', '刚才', '记得', '你说'];
      const _hasChatKeyword = _chatKeywords.some(kw => _lastUserContent.includes(kw));
      if (_hasChatKeyword && typeof Phone !== 'undefined' && Phone.getChatHistoryForNPCs) {
        const _present = (typeof NPC !== 'undefined' && NPC.getPresentNPCs) ? NPC.getPresentNPCs() : [];
        if (_present.length > 0) {
          const _chatHistory = await Promise.race([
            Phone.getChatHistoryForNPCs(_present, 5),
            new Promise(resolve => setTimeout(() => resolve(''), 3000))
          ]);
          if (_chatHistory) {
            const _chatContent = `【{{user}}与在场角色的手机聊天记录｜OOC·参考】\n以下是{{user}}手机聊天APP里与当前在场角色的近期对话记录，仅供参考。如果当前对话涉及到线上曾聊过的内容，在场角色应该记得这些对话。\n\n${_chatHistory}\n\n注意：这些记录仅在剧情需要时自然引用，不要每轮都复述聊天内容。`;
            const insertIdx = apiMessages.length - 1;
            if (insertIdx >= 0) {
              apiMessages.splice(insertIdx, 0, { role: 'system', content: _chatContent });
            } else {
              apiMessages.push({ role: 'system', content: _chatContent });
            }
          }
        }
      }
    } catch(_) {}

    // 共读记录注入：共读伙伴在场时，把「过去的共读记录」作为背景参考注入。
    // 触发：关键词命中必发，否则 30% 概率偶发；整体受阅读「同步主线」开关控制。
    try {
      if (typeof Phone !== 'undefined' && Phone.getCoReadForNPCs) {
        let _syncOn = true;
        try {
          const _pd = (Phone._getPhoneData) ? await Phone._getPhoneData() : null;
          const _prefs = _pd && _pd.readingGlobalPrefs;
          if (_prefs && typeof _prefs.syncMainline === 'boolean') _syncOn = _prefs.syncMainline;
        } catch(_) {}
        if (_syncOn) {
          const _present = (typeof NPC !== 'undefined' && NPC.getPresentNPCs) ? NPC.getPresentNPCs() : [];
          if (_present.length > 0) {
            const _lastUser = (apiMessages.filter(m => m.role === 'user').pop()?.content || '');
            const _crKeywords = ['共读', '一起读', '一起看', '在读', '读的那本', '那本书', '看的书', '读到', '书里', '小说', '想法'];
            const _crKwHit = _crKeywords.some(kw => _lastUser.includes(kw));
            if (_crKwHit || Math.random() < 0.3) {
              const _coRead = await Promise.race([
                Phone.getCoReadForNPCs(_present),
                new Promise(resolve => setTimeout(() => resolve(''), 3000))
              ]);
              if (_coRead) {
                const _crContent = `【{{user}}与在场角色的共读记录｜OOC·背景参考】\n以下是{{user}}和当前在场角色过去一起读书时、在书页段落上留下的想法记录，属于你们之间已经发生过的事。这只是背景参考，帮助你记得你们有过这样的共读经历与交流，不是当前正在发生的剧情。\n\n${_coRead}\n\n注意：只在剧情自然贴合时（比如聊到这本书、这段情节，或想起一起读书的时光）才淡淡提起，不要每轮复述，不要硬凹话题。`;
                const insertIdx = apiMessages.length - 1;
                if (insertIdx >= 0) {
                  apiMessages.splice(insertIdx, 0, { role: 'system', content: _crContent });
                } else {
                  apiMessages.push({ role: 'system', content: _crContent });
                }
              }
            }
          }
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

    // v687.31：状态栏类信息合并注入到"最后 user 消息之前"
    // 解决：状态栏写 14, AI 说 9 —— 系统段离用户输入太远，注意力衰减
    if (_recentStatusParts.length > 0) {
      const merged = '【当前状态（权威值，请优先使用此处数据，覆盖你之前对数值的任何记忆或推测）】\n\n' +
        _recentStatusParts.join('\n\n---\n\n');
      // 找到最后一条非 hidden 的 user 消息位置（apiMessages 已含完整对话）
      let lastUserIdx = -1;
      for (let i = apiMessages.length - 1; i >= 0; i--) {
        if (apiMessages[i].role === 'user') { lastUserIdx = i; break; }
      }
      if (lastUserIdx >= 0) {
        apiMessages.splice(lastUserIdx, 0, { role: 'system', content: merged });
      } else {
        apiMessages.push({ role: 'system', content: merged });
      }
    }

    for (const m of apiMessages) {
      if (m.content && typeof m.content === 'string') {
        if (m.content.includes('{{user}}')) m.content = m.content.replaceAll('{{user}}', _macroUser);
        if (_macroChar && m.content.includes('{{char}}')) m.content = m.content.replaceAll('{{char}}', _macroChar);
      }
    }

    return { apiMessages, char, relatedMemories: typeof relatedMemories !== "undefined" ? relatedMemories : [], convSettings, isGameMode, isGaidenConv, isSingleConv };
  }


  /**
   * 面具隔离引导弹窗（方案C）：新窗口首次发消息时，若当前面具已有记忆/物品，
   * 询问玩家是否为本对话独立出一份面具。返回 Promise<void>（无论选什么都继续发消息）。
   */
  async function _promptMaskIsolation() {
    try {
      if (typeof Conversations === 'undefined' || typeof Character === 'undefined') return;
      if (!Character.isolateMaskForConv || !Character.maskHasContent) return;
      // 已问过 → 跳过
      if (Conversations.isMaskIsolated && Conversations.isMaskIsolated()) return;
      // 当前面具没内容 → 不打扰，但也标记为已处理，避免之后攒了内容反复弹
      const hasContent = await Character.maskHasContent();
      if (!hasContent) { await Conversations.markMaskIsolated(); return; }

      const convName = Conversations.getCurrentName ? Conversations.getCurrentName() : '本对话';
      const choice = await new Promise((resolve) => {
        const mask = document.createElement('div');
        mask.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:20px';
        const esc = (s) => (typeof Utils !== 'undefined' && Utils.escapeHtml) ? Utils.escapeHtml(String(s)) : String(s);
        const opt = (mode, title, desc) => `
          <button type="button" data-mode="${mode}" style="width:100%;text-align:left;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-tertiary);color:var(--text);font-size:14px;cursor:pointer;margin-bottom:8px">
            <div style="font-weight:600">${title}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:3px;line-height:1.5">${desc}</div>
          </button>`;
        mask.innerHTML = `
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:18px 16px;max-width:360px;width:100%;max-height:86vh;overflow-y:auto;color:var(--text)">
            <div style="font-size:15px;font-weight:600;margin-bottom:4px">检测到这是新的窗口</div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:14px">当前面具的记忆和物品栏会和其它使用同一面具的窗口共通。是否为「${esc(convName)}」复制一份独立的面具？</div>
            ${opt('share', '不复制', '多窗口共通记忆和物品栏（保持现状）')}
            ${opt('mask', '仅复制面具信息', '复制人设，不带记忆和物品栏（全新开始）')}
            ${opt('maskInv', '复制面具信息 + 物品栏', '带着物品，但记忆从零开始')}
            ${opt('full', '完全复制', '面具信息、物品栏、记忆库全部复制一份')}
          </div>`;
        mask.querySelectorAll('button[data-mode]').forEach(b => {
          b.onclick = () => { const m = b.dataset.mode; if (mask.parentNode) document.body.removeChild(mask); resolve(m); };
        });
        // 点遮罩不关闭，强制做选择（避免误触跳过）
        document.body.appendChild(mask);
      });

      const r = await Character.isolateMaskForConv(Conversations.getCurrent(), convName, choice);
      await Conversations.markMaskIsolated();
      if (r && r.ok && !r.shared) {
        UI.showToast('已为本对话创建独立面具', 2000);
      }
    } catch (e) {
      try { GameLog.log('warn', '面具隔离引导失败：' + (e.message || e)); } catch(_) {}
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

    // 发消息前确保世界观初始住所已就位（幂等：已有住所秒返回），避免切对话后立刻发消息时住所还没克隆完
    if (text !== '<PhoneDown/>' && text !== '<Continue the Chat/>') {
      try { if (typeof Phone !== 'undefined' && Phone.ensureInitialHouse) await Phone.ensureInitialHouse(); } catch(_) {}
    }

    // 面具隔离引导（方案C）：普通用户消息、且本对话尚有非系统消息时，首次发言前询问
    // 排除系统触发指令（PhoneDown / Continue）
    if (text !== '<PhoneDown/>' && text !== '<Continue the Chat/>') {
      const _hasUserMsg = messages.some(m => m && m.role === 'user' && !m.hidden);
      if (!_hasUserMsg) {
        try { await _promptMaskIsolation(); } catch(_) {}
      }
    }

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

    // phoneDown：手机聊天触发的自动回复，把 pending 内容作为系统级上下文注入
    const _isPhoneDown = text === '<PhoneDown/>';
    if (_isPhoneDown && typeof Phone !== 'undefined' && Phone.getPendingPhoneDown) {
      const _pdPending = Phone.getPendingPhoneDown();
      if (_pdPending) {
        Phone.clearPendingPhoneDown();
        let pdContext;
        if (_pdPending.fromCall) {
          // 通话挂断触发：actionLog 里已经是完整的通话结束事件上下文
          pdContext = typeof _pdPending.actionLog === 'string' ? _pdPending.actionLog : _pdPending.actionLog.join('\n');
        } else {
          pdContext = `【手机打断事件】${_pdPending.contactName}打断了{{user}}看手机，请描写${_pdPending.contactName}打断后的线下场景。照常输出状态块。\n时间增量请从当前状态栏时间继续往前推进（手机聊天的时间消耗已自动同步到状态栏）。`;
          if (_pdPending.actionLog) {
            pdContext += `\n\n以下是{{user}}本轮在手机上的操作（含聊天内容）：\n${typeof _pdPending.actionLog === 'string' ? _pdPending.actionLog : _pdPending.actionLog.join('\n')}`;
          }
        }
        userContentForAPI = pdContext;
      }
    }
    // phoneDown 场景6：用户自己先发了消息（非 <PhoneDown/>），但 pending 还在 → 合并进本轮
    if (!_isPhoneDown && typeof Phone !== 'undefined' && Phone.getPendingPhoneDown && Phone.getPendingPhoneDown()) {
      try {
        const _pdPending2 = Phone.getPendingPhoneDown();
        Phone.clearPendingPhoneDown();
        let pdExtra = `\n\n【补充：手机打断事件】${_pdPending2.contactName}刚才在手机里打断了{{user}}看手机。`;
        if (_pdPending2.actionLog) {
          pdExtra += `\n{{user}}本轮在手机上的操作（含聊天内容）：\n${typeof _pdPending2.actionLog === 'string' ? _pdPending2.actionLog : _pdPending2.actionLog.join('\n')}`;
        }
        if (typeof userContentForAPI === 'string') {
          userContentForAPI = userContentForAPI + pdExtra;
        } else {
          userContentForAPI[0].text += pdExtra;
        }
      } catch(_) {}
    }

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
// v627：尊重用户在手机设置里的"发送本轮操作"开关，关闭时清空当轮日志，不写入快照
let _pendingPhoneLog = null;
try {
  if (typeof Phone !== 'undefined' && Phone.flushActionLog) {
    const phoneLog = Phone.flushActionLog();
    let _allowSend = true;
    try {
      const _pd = (typeof Phone._getPhoneData === 'function') ? await Phone._getPhoneData() : null;
      if (_pd && _pd.sendActionLog === false) _allowSend = false;
    } catch(_) {}
    if (_allowSend && phoneLog.length > 0) _pendingPhoneLog = phoneLog;
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

    // 注：自制电影上映/报奖、自制书版权授权这两段「常驻事件提示词」
    // 不再在此拼进 userContentForAPI（会被持久化进消息历史导致每轮重复堆积），
    // 改为在 _buildApiContext 里以临时 system 消息注入，只对当轮生效。

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

    // 附加骰点检定结果 v686：把待消费的最后一次确认 roll 拼成 OOC 块
    try {
      if (typeof Dice !== 'undefined' && Dice.consumePendingForSend) {
        const { ooc } = await Dice.consumePendingForSend();
        if (ooc) {
          if (typeof userContentForAPI === 'string') {
            userContentForAPI = userContentForAPI + '\n\n' + ooc;
          } else {
            userContentForAPI[0].text += '\n\n' + ooc;
          }
          userContent = (typeof userContent === 'string' ? userContent : text) + '\n' + ooc;
        }
      }
    } catch(e) { console.warn('[Chat] 骰点 OOC 拼接失败', e); }



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
      hidden: text === '<Continue the Chat/>' || text === '<PhoneDown/>'  // 隐藏继续指令和phoneDown自动触发的消息
    };
    // v687.15：环境快照（电量/天气），存到消息上，下一轮拼前缀回放
    try {
      const _csForEnv = _getConvSettings();
      if ((_csForEnv.batteryAware || _csForEnv.weatherAware) && window.EnvAwareness) {
        const snap = await EnvAwareness.captureSnapshot({
          battery: _csForEnv.batteryAware,
          weather: _csForEnv.weatherAware
        });
        if (snap) {
          userMsg.envSnapshot = snap;
          GameLog.log('info', `[环境快照] 已捕获: battery=${snap.battery ? snap.battery.pct + '%' : '无'}, weather=${snap.weather ? snap.weather.temp : '无'}`);
        } else {
          GameLog.log('warn', `[环境快照] captureSnapshot 返回 null（电量API或天气API不可用）`);
        }
      }
    } catch(e) { GameLog.log('warn', `[环境快照] 捕获失败: ${e.message}`); }
    await DB.put('messages', userMsg);
    messages.push(userMsg);
    // 用户消息已发送，清掉这条对话的回复建议缓存
    try { _clearSuggestCache(Conversations.getCurrent()); } catch(_) {}
    if (!userMsg.hidden) {
      appendMessage(userMsg, false, true);
    }
    // 骰点：发送后 pending 已经 consumed，重建气泡使其转为 history v686
    try { _refreshDiceUI(); } catch(_) {}
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

    // 构建 API 上下文（v687 重构：共用 _buildApiContext）
    const { apiMessages, char, relatedMemories, convSettings, isGameMode, isGaidenConv, isSingleConv } = await _buildApiContext(messages, { rewriteHint: _pendingRewriteHint });
    _pendingRewriteHint = ''; // 重写建议已消费

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

    // 流式请求（带自动重试，最多3次；对话设置可关闭重试）
    let retryCount = 0;
    const maxRetries = isRetryDisabled() ? 1 : 3;

    async function _doStream(prefixContent) {
      try { GameLog.log('info', '[Chat] 开始调用 API.streamChat'); } catch(_) {}
      return new Promise((resolve, reject) => {
        // v687.6：工具调用迭代计数（最高 5 次）
        let _toolIter = 0;
        const _MAX_TOOL_ITER = 5;
        // v687.7：工具调用累计计数（用于 UI 尾巴 + 下一轮 AI 自知）
        let _toolsUsedCount = 0;
        // v687.8：工具调用日志（args/result 存档，UI 可点开看）
        const _toolsLog = [];
        // v687.11：累积"工具调用前 AI 已说过的话"（fullContent 每轮 streamChat 会重置，这里跨轮拼接）
        // v687.41：断点续传时接收前缀
        let _priorContent = prefixContent || '';

        // 工具集闭包：根据对话设置过滤启用项 + MCP 外置工具（v687.23）
        const _enabledTools = (() => {
          let merged = [];
          if (typeof Tools !== 'undefined') {
            const allDefs = Tools.getDefinitions() || [];
            merged = allDefs.filter(d => {
        const name = d.function?.name || '';
        if (name.startsWith('query_worldview_')) return convSettings.toolsWorldview;
        if (name === 'search_messages') return convSettings.toolsHistory;
        // AI 编辑设定工具（read/update/add/delete/undo + list_extension + read_card）
        if (['read_worldview_setting','update_worldview_setting','read_worldview_entry','update_worldview_entry','add_worldview_entry',
             'list_extension_entries','add_extension_entry','update_extension_entry','delete_extension_entry',
             'list_cards','read_card','update_card','undo_last_edit'].includes(name)) return convSettings.toolsEdit;
        return convSettings.toolsMemory;
            });
          }
          // v687.23：追加 MCP 工具（不受对话级开关限制，由 server.enabled 控制）
          try {
            if (typeof MCPClient !== 'undefined') {
              const mcpDefs = MCPClient.getEnabledToolDefs() || [];
              if (mcpDefs.length) merged = merged.concat(mcpDefs);
            }
          } catch(_) {}
          return merged.length > 0 ? merged : undefined;
        })();

        // === 闭包式回调：onChunk / onDone / onError 复用，工具循环里也走这套 ===
        const _onChunk = (chunk, fullContent) => {
          // v687.11：拼接工具调用前的历史内容
          const merged = _priorContent ? (_priorContent + fullContent) : fullContent;
          aiMsg.content = merged;
          let renderContent = merged;
          renderContent = renderContent.replace(/```homecoming\s*[\s\S]*?```/gi, '');
        renderContent = renderContent.replace(/```homecoming[\s\S]*$/i, '');
        renderContent = renderContent.replace(/```call\s*[\s\S]*?```/gi, '');
        renderContent = renderContent.replace(/```call[\s\S]*$/i, '');
        renderContent = renderContent.replace(/```groupchat\s*[\s\S]*?```/gi, '');
        renderContent = renderContent.replace(/```groupchat[\s\S]*$/i, '');
        renderContent = renderContent.replace(/```groupcreate\s*[\s\S]*?```/gi, '');
renderContent = renderContent.replace(/```groupcreate[\s\S]*$/i, '');
renderContent = renderContent.replace(/```mail_reply\s*[\s\S]*?```/gi, '');
renderContent = renderContent.replace(/```mail_reply[\s\S]*$/i, '');
          renderContent = renderContent.replace(/【玩家手机操作(?:记录|日志)[｜|]OOC】[\s\S]*?(?=\n\n|\n[^\n\-\d《「]|$)/g, '').trim();
          contentEl.innerHTML = Markdown.render(renderContent);
          if (convSettings.stream) contentEl.classList.add('streaming-cursor');
          scrollToBottomIfFollowing();
        };

        const _onDone = async (fullContent) => {
          // v687.11：onDone 时也拼接历史内容
          fullContent = _priorContent ? (_priorContent + fullContent) : fullContent;
          // 事件结束关键词扫描要用「正则/OOC 清理之前」的原始内容——
          // 否则用户若配了剥离 HTML 注释的正则，会把 <!-- completeKey --> 删掉导致事件永远标记不了 done。
          const _rawForEventScan = fullContent;
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
            fullContent = fullContent.replace(/【玩家手机操作(?:记录|日志)[｜|]OOC】[\s\S]*?(?=\n\n|\n[^\n\-\d《「]|$)/g, '').trim();
            aiMsg.content = fullContent;
            aiMsg.timestamp = Utils.timestamp();
            // v687.7：本轮工具使用数写入消息（用于 UI 尾巴 + 下一轮 AI 自知）
            if (_toolsUsedCount > 0) aiMsg.toolsUsed = _toolsUsedCount;
            // v687.8：工具调用日志写入消息（用户可点开查看 args/result）
            if (_toolsLog.length > 0) aiMsg.toolsLog = _toolsLog.slice();
            try { delete aiMsg._cachedFullHTML; delete aiMsg._cachedPlainHTML; } catch(_) {}
            await DB.put('messages', aiMsg);
            messages.push(aiMsg);

            // 剧情引导轮数递减
            try { await _decrementDirective(); } catch(_) {}

            // v687.6：手机好友圈自动刷新计数器扣减（一问一答 = 一轮）
            try { if (typeof Phone !== 'undefined' && Phone._tickMomentsAutoRefresh) Phone._tickMomentsAutoRefresh(); } catch(_) {}

            // v610：扫描 AI 回复中的事件结束关键词
            try {
              const _evtConv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
              if (_evtConv && _evtConv.eventStates && isGameMode && convSettings.eventsEnabled !== false) {
                // _evtList 优先用 convEvents（拍摄链/对话级事件都在这）。_evtWv 仅作 convEvents 为空时的 fallback。
                // 注意：singleWv 是 _buildApiContext 的局部变量，本闭包拿不到，单人卡场景直接置 null（单人卡隐藏事件由下方单独扫）。
                let _evtWv = null;
                if (!isSingleConv) {
                  try { _evtWv = await Worldview.getCurrent(); } catch(_) {}
                }
                const _evtList = (_evtConv && Array.isArray(_evtConv.convEvents) && _evtConv.convEvents.length) ? _evtConv.convEvents : (_evtWv?.events || []);
                try {
                  const _act = _evtList.filter(e => e && _evtConv.eventStates[e.id] === 'active').map(e => `${e.name}[${e.completeKey}]`);
                  GameLog.log('info', `[Event诊断] active事件: ${_act.join(' | ') || '无'}；原始回复含结束词: ${_act.map(a => { const m = a.match(/\[(.+)\]$/); return m ? _rawForEventScan.includes(m[1]) : false; }).join(',')}`);
                } catch(_) {}
                let _evtChanged = false;
                for (const ev of _evtList) {
                  if (!ev || !ev.id || !ev.completeKey) continue;
                  if (_evtConv.eventStates[ev.id] !== 'active') continue;
                  if (_rawForEventScan.includes(ev.completeKey)) {
                    _evtConv.eventStates[ev.id] = 'done';
                    _evtChanged = true;
                    try { GameLog.log('info', `[Event] 事件「${ev.name}」检测到结束关键词，已标记完成`); } catch(_) {}
                    // v687.33：心动模拟第二部钩子动画触发（关键词命中"触发TE动画"时）
                    if (ev.completeKey === '触发TE动画' || (ev.completeKey || '').includes('触发TE动画')) {
                      try {
                        if (window.HeartSimEpilogue && !window.HeartSimEpilogue.isPlaying()) {
                          setTimeout(() => { try { window.HeartSimEpilogue.play(); } catch(_) {} }, 800);
                        }
                      } catch(_) {}
                    }
                  }
                }
                if (_evtChanged) {
                  try { await Conversations.saveList(); } catch(_) {}
                }
              }

              // 单人卡隐藏世界观事件完成扫描
              if (_evtConv && _evtConv.eventStates && isGameMode && convSettings.eventsEnabled !== false) {
                const _evtHiddenWv = await _getMergedLorebooksForConv(_evtConv);
                const _evtHiddenList = _evtHiddenWv?.events || [];
                let _evtHiddenChanged = false;
                for (const ev of _evtHiddenList) {
                  if (!ev || !ev.id || !ev.completeKey) continue;
                  if (_evtConv.eventStates[ev.id] !== 'active') continue;
                  if (_rawForEventScan.includes(ev.completeKey)) {
                    _evtConv.eventStates[ev.id] = 'done';
                    _evtHiddenChanged = true;
                    try { GameLog.log('info', `[Event] 单人卡事件「${ev.name}」检测到结束关键词，已标记完成`); } catch(_) {}
                    // v687.33：心动模拟第二部钩子动画触发（单人卡事件路径）
                    if (ev.completeKey === '触发TE动画' || (ev.completeKey || '').includes('触发TE动画')) {
                      try {
                        if (window.HeartSimEpilogue && !window.HeartSimEpilogue.isPlaying()) {
                          setTimeout(() => { try { window.HeartSimEpilogue.play(); } catch(_) {} }, 800);
                        }
                      } catch(_) {}
                    }
                  }
                }
                if (_evtHiddenChanged) {
                  try { await Conversations.saveList(); } catch(_) {}
                }
              }

              // 运行时自愈：清掉 eventStates 里「既不在 convEvents、也不在隐藏 wv events」的幽灵状态。
              // 历史上反复重新生成拍摄链会残留旧链的 active 标记，导致幽灵事件永远清不掉。
              try {
                if (_evtConv && _evtConv.eventStates && isGameMode && convSettings.eventsEnabled !== false) {
                  const _liveIds = new Set();
                  (Array.isArray(_evtConv.convEvents) ? _evtConv.convEvents : []).forEach(e => { if (e && e.id) _liveIds.add(e.id); });
                  try {
                    const _hw = await _getMergedLorebooksForConv(_evtConv);
                    (_hw?.events || []).forEach(e => { if (e && e.id) _liveIds.add(e.id); });
                  } catch(_) {}
                  let _ghostCleaned = 0;
                  Object.keys(_evtConv.eventStates).forEach(id => {
                    if (!_liveIds.has(id)) { delete _evtConv.eventStates[id]; _ghostCleaned++; }
                  });
                  if (_ghostCleaned > 0) {
                    try { GameLog.log('info', `[Event] 清理幽灵事件状态 ${_ghostCleaned} 条（已不在事件列表中）`); } catch(_) {}
                    try { await Conversations.saveList(); } catch(_) {}
                  }
                }
              } catch(_) {}
            } catch(_) {}

            // 自制电影·上映/报奖结束标记回写
            try {
              if (typeof Phone !== 'undefined' && Phone.applyVideoEventMarkers) {
                await Phone.applyVideoEventMarkers(fullContent);
              }
            } catch(_) {}

            // 自制书·影视版权授权结束标记回写
            try {
              if (typeof Phone !== 'undefined' && Phone.applyLicenseMarkers) {
                await Phone.applyLicenseMarkers(fullContent);
              }
            } catch(_) {}

            const parsed = Utils.parseAIOutput(fullContent);
            if (isGameMode && convSettings.format) {
              renderParsedMessage(msgEl, parsed);
            } else {
              contentEl.innerHTML = Markdown.render(fullContent);
            }

            // 状态栏
            if (isGameMode) {
              try {
                const oldStatus = Conversations.getStatusBar();
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
                  // 历法系统：处理增量时间 + 自动计算季节
                  if (merged.time && typeof Calendar !== 'undefined' && Calendar.isDelta(merged.time)) {
                    try {
                      const currentTimeStr = oldStatus?.time || '';
                      let calRules = null;
                      try {
                        // 从当前对话绑定的世界观读历法
                        const _conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
                        const _wvId = _conv?.worldviewId;
                        const wv = _wvId ? await DB.get('worldviews', _wvId) : null;
                        calRules = wv?.gameplay?.calendarSystem || null;
                        // fallback: 对话级覆盖
                        if (!calRules && _conv?.convGameplay?.calendarSystem) calRules = _conv.convGameplay.calendarSystem;
                      } catch(_) {}
                      const result = Calendar.processTimeField(merged.time, currentTimeStr, calRules);
                      if (!result.parseError) {
                        merged.time = result.timeStr;
                        if (result.season) merged.season = result.season.name;
                        if (result.timePeriod) merged.timePeriod = result.timePeriod.name;
                      } else {
                        // 解析失败：通常是 currentTimeStr 缺日期（如纯 "00:00"），
                        // 导致增量加不上去、时间卡死。尝试用现实日期把纯时分补成
                        // 完整时间，再重新累加增量，让旧的坏数据自愈。
                        let recovered = false;
                        try {
                          const _hm = String(currentTimeStr).match(/(\d{1,2}):(\d{2})/);
                          if (_hm && Calendar.format) {
                            const _now = new Date();
                            const _base = { year: _now.getFullYear(), month: _now.getMonth()+1, day: _now.getDate(), hour: +_hm[1], minute: +_hm[2] };
                            const _baseStr = Calendar.format(_base, calRules);
                            const _r2 = Calendar.processTimeField(merged.time, _baseStr, calRules);
                            if (!_r2.parseError) {
                              merged.time = _r2.timeStr;
                              if (_r2.season) merged.season = _r2.season.name;
                              if (_r2.timePeriod) merged.timePeriod = _r2.timePeriod.name;
                              recovered = true;
                            }
                          }
                        } catch(_) {}
                        // 仍无法恢复：回退到上一轮时间，不让增量原文污染状态栏
                        if (!recovered) merged.time = currentTimeStr || merged.time;
                      }
                    } catch(_) {}
                  } else if (merged.time && typeof Calendar !== 'undefined') {
                    // 绝对时间也自动算季节
                    try {
                      let calRules = null;
                      try {
                        const _conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
                        const _wvId = _conv?.worldviewId;
                        const wv = _wvId ? await DB.get('worldviews', _wvId) : null;
                        calRules = wv?.gameplay?.calendarSystem || null;
                        if (!calRules && _conv?.convGameplay?.calendarSystem) calRules = _conv.convGameplay.calendarSystem;
                      } catch(_) {}
                      const result = Calendar.processTimeField(merged.time, merged.time, calRules);
                      if (!result.parseError && result.season) merged.season = result.season.name;
                      if (!result.parseError && result.timePeriod) merged.timePeriod = result.timePeriod.name;
                    } catch(_) {}
                  }
                  // 天气限制5字
                  if (merged.weather && merged.weather.length > 5) {
                    merged.weather = merged.weather.slice(0, 5);
                  }
                  // 跨时段检测：oldStatus.timePeriod vs merged.timePeriod
                  if (merged.timePeriod && oldStatus?.timePeriod && merged.timePeriod !== oldStatus.timePeriod) {
                    // 存待注入标记，下一轮发送时读取
                    try {
                      let _tpDesc = '';
                      if (typeof Calendar !== 'undefined' && Calendar.getTimePeriod && Calendar.parseAbsoluteTime) {
                        const _tpObj = Calendar.parseAbsoluteTime(merged.time);
                        if (_tpObj) {
                          let _cr = null;
                          try { const _cv = Conversations.getList().find(c => c.id === Conversations.getCurrent()); _cr = _cv?.worldviewId ? (await DB.get('worldviews', _cv.worldviewId))?.gameplay?.calendarSystem : null; } catch(_) {}
                          const _pi = Calendar.getTimePeriod(_tpObj.hour, _cr);
                          if (_pi) _tpDesc = _pi.desc || '';
                        }
                      }
                      merged._pendingPeriodTransition = { from: oldStatus.timePeriod, to: merged.timePeriod, toDesc: _tpDesc };
                    } catch(_) {}
                  }
                  // 跨季节检测：oldStatus.season vs merged.season
                  if (merged.season && oldStatus?.season && merged.season !== oldStatus.season) {
                    try {
                      let _sWeather = '';
                      if (typeof Calendar !== 'undefined' && Calendar.getSeason && Calendar.parseAbsoluteTime) {
                        const _tpObj2 = Calendar.parseAbsoluteTime(merged.time);
                        if (_tpObj2) {
                          let _cr2 = null;
                          try { const _cv2 = Conversations.getList().find(c => c.id === Conversations.getCurrent()); _cr2 = _cv2?.worldviewId ? (await DB.get('worldviews', _cv2.worldviewId))?.gameplay?.calendarSystem : null; } catch(_) {}
                          const _si = Calendar.getSeason(_tpObj2.month, _cr2);
                          if (_si) _sWeather = _si.weather || '';
                        }
                      }
                      merged._pendingSeasonTransition = { from: oldStatus.season, to: merged.season, toWeather: _sWeather };
                    } catch(_) {}
                  }
                  if (oldStatus?.heartSim) merged.heartSim = oldStatus.heartSim;
                  if (oldStatus?.customAttrs) merged.customAttrs = oldStatus.customAttrs;
                  if (oldStatus?.taskSystem) merged.taskSystem = oldStatus.taskSystem;
                  await Conversations.setStatusBar(merged);
                  if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(merged);
                }
              } catch(e) { console.warn('[Chat] status 更新失败:', e); }
            }

            if (isGameMode && parsed.customAttrs && typeof StatusBar !== 'undefined' && StatusBar.applyCustomAttrsDelta) {
              try { await StatusBar.applyCustomAttrsDelta(parsed.customAttrs); } catch(e) { console.warn('[Chat] custom-attrs 更新失败:', e); }
            }

            if (isGameMode && convSettings.format) {
              updateTopbar(parsed);
            }

            try {
              if (parsed.homecoming && typeof Phone !== 'undefined') {
                const triggered = await Phone.isHsHomecomingTriggered();
                if (!triggered) {
                  if (parsed.homecomingCompanion) {
                    // v687.41：共同返航结局——播穿越动画
                    try {
                      if (typeof HeartSimCompanion !== 'undefined') {
                        setTimeout(() => {
                          try { HeartSimCompanion.play(parsed.homecomingCompanion); } catch(e) { console.warn('[HSCompanion] play failed', e); }
                        }, 1500);
                      }
                    } catch(_) {}
                  } else if (typeof HeartSimHomecoming !== 'undefined') {
                    // 独自返航——播返航动画
                    setTimeout(() => {
                      try { HeartSimHomecoming.play(); } catch(e) { console.warn('[HSHomecoming] play failed', e); }
                    }, 1500);
                  }
                }
              }
            } catch(e) { console.warn('[Chat] homecoming 触发检测失败', e); }

            // 一起听：处理接受/拒绝标记
            try {
              if (parsed.listenAccept && typeof Phone !== 'undefined' && Phone._ltHandleAccept) {
                await Phone._ltHandleAccept(parsed.listenAccept);
              }
            } catch(e) { console.warn('[Chat] listenAccept 处理失败', e); }

            // 一起听：处理留言标记（线下公放/耳机共享）
            try {
              if (parsed.listenMsg && typeof Phone !== 'undefined' && Phone._ltHandleMsg) {
                await Phone._ltHandleMsg(parsed.listenMsg);
              }
            } catch(e) { console.warn('[Chat] listenMsg 处理失败', e); }

            // 游鱼购买标记处理
            try {
              if (parsed.youyuBuy && typeof Phone !== 'undefined' && Phone._youyuHandleBuy) {
                await Phone._youyuHandleBuy(parsed.youyuBuy);
              }
            } catch(e) { console.warn('[Chat] youyuBuy 处理失败', e); }

            try {
              const finalStatus = Conversations.getStatusBar();
              if (finalStatus) {
                aiMsg.statusSnapshot = JSON.parse(JSON.stringify(finalStatus));
              }
              // v687.33：手机数据快照（剥离图片字段，只保留文字数据）
              if (typeof Phone !== 'undefined' && Phone.getSnapshotForRollback) {
                const phoneSnap = await Phone.getSnapshotForRollback();
                if (phoneSnap) aiMsg.phoneSnapshot = phoneSnap;
              }
              await DB.put('messages', aiMsg);
            } catch(_) {}

            if (isGameMode) {
              const newRegion = NPC.parseRegionFromOutput(parsed);
              if (newRegion !== NPC.getRegion()) NPC.setRegion(newRegion);

              if (parsed.presentNPCs && parsed.presentNPCs.length > 0) {
                NPC.setPresentNPCs(parsed.presentNPCs);
                GameLog.log('info', `相关NPC: ${parsed.presentNPCs.join(', ')}`);
              }
            }

            updateTokenCount();

            GameLog.log('info', `当前轮数: ${roundCount}`);
    const extractInterval = parseInt((await API.getConfig()).extractInterval) || 20;
    const shouldExtract = convSettings.autoExtract && ((roundCount > 0 && roundCount % extractInterval === 0) || _extractPending);
    if (convSettings.autoExtract) {
      GameLog.log('info', `[自动提取] 轮数=${roundCount}, 间隔=${extractInterval}, pending=${_extractPending}, 本轮${shouldExtract ? '✓触发' : '×未触发'}, 距下次触发还剩${extractInterval - (roundCount % extractInterval)}轮`);
    } else {
      GameLog.log('info', `[自动提取] 已关闭`);
    }
    if (shouldExtract) {
              GameLog.log('info', `触发记忆提取 (第${roundCount}轮, 间隔${extractInterval}, pending=${_extractPending})`);
              UI.showToast(_extractPending ? '正在重试记忆提取…' : '正在进行记忆提取，请稍候…', 4000);
              await autoExtractMemory();
            }
            if (_summaryPending) {
              GameLog.log('info', '[Summary] 上轮失败，重试总结');
              UI.showToast('正在重试剧情总结…', 4000);
            }
            await checkAutoSummary();

            if (convSettings.imgGen && /\[IMG:\s*[^\]]+\]/i.test(fullContent)) {
              _processImgTags(aiMsg.id, fullContent).catch(e => console.warn('[Chat] 生图标记处理失败', e));
            }

            // 主线来电：检测 ```call 代码块，触发手机来电界面（受开关控制）
    // 延迟 3s 等主线消息渲染完毕后再弹来电
    try {
      if (convSettings.callEnabled && typeof Phone !== 'undefined' && Phone.handleMainlineCallTag
        && /```call[\s\S]*?```/.test(fullContent)) {
        setTimeout(() => {
          try { Phone.handleMainlineCallTag(fullContent); } catch(_) {}
        }, 3000);
      }
    } catch(e) { console.warn('[Chat] 来电标记处理失败', e); }

            // 主线群聊：检测 ```groupchat / ```groupcreate 块，后台触发群聊（受开关控制）
    try {
      if (convSettings.groupChatEnabled && typeof Phone !== 'undefined') {
        if (Phone.handleMainlineGroupCreateTag && /```groupcreate[\s\S]*?```/.test(fullContent)) {
          setTimeout(() => { try { Phone.handleMainlineGroupCreateTag(fullContent); } catch(_) {} }, 3000);
        }
        if (Phone.handleMainlineGroupChatTag && /```groupchat[\s\S]*?```/.test(fullContent)) {
          setTimeout(() => { try { Phone.handleMainlineGroupChatTag(fullContent); } catch(_) {} }, 3000);
        }
      }
    } catch(e) { console.warn('[Chat] 群聊标记处理失败', e); }

    // 主线邮件：检测 ```mail_reply 块，后台生成对方回信（无需开关，有待回信+信号即触发）
    try {
      if (typeof Phone !== 'undefined' && Phone.handleMainlineMailTag
        && /```mail_reply[\s\S]*?```/.test(fullContent)) {
        setTimeout(() => { try { Phone.handleMainlineMailTag(fullContent); } catch(_) {} }, 3000);
      }
    } catch(e) { console.warn('[Chat] 邮件标记处理失败', e); }

    // 群聊自动发消息：主线每走一轮 +1，到随机阈值随机挑一个开了 autoChat 的群触发
    // （独立于群聊触发开关，由各群自己的 autoChat 控制；延迟错开避免和上面的触发撞一起）
    try {
      if (typeof Phone !== 'undefined' && Phone._groupAutoChatTick) {
        setTimeout(() => { try { Phone._groupAutoChatTick(); } catch(_) {} }, 4500);
      }
    } catch(e) { console.warn('[Chat] 群聊自动发消息 tick 失败', e); }
    // 用户自播：主线每走一轮，若正在直播则生成一波观众反应（弹幕/打赏/热度/涨粉）
    // 延迟错开，避免和群聊 tick / 群聊触发挤在一起
    try {
      if (typeof Phone !== 'undefined' && Phone._userLiveGenWave) {
        setTimeout(() => { try { Phone._userLiveGenWave(); } catch(_) {} }, 6000);
      }
    } catch(e) { console.warn('[Chat] 用户自播 tick 失败', e); }

    // 故人来信：主线每走一轮 +1，到随机阈值（10~20）且邮箱生态开关开启时，
    // 挑一个久未互动但有羁绊的角色，翻旧记忆写一封主动来信。延迟错开避免撞车。
    try {
      if (typeof Phone !== 'undefined' && Phone._forgottenMailTick) {
        setTimeout(() => { try { Phone._forgottenMailTick(); } catch(_) {} }, 7500);
      }
    } catch(e) { console.warn('[Chat] 故人来信 tick 失败', e); }

// 节日来信：主线每走一轮检查一次"今天是否世界观节日"，命中且未发过则触发。
      // 前端粗匹配日期，仅在邮箱生态开关开启时生效。延迟错开避免撞车。
      try {
        if (typeof Phone !== 'undefined' && Phone._festivalMailTick) {
          setTimeout(() => { try { Phone._festivalMailTick(); } catch(_) {} }, 9000);
        }
      } catch(e) { console.warn('[Chat] 节日来信 tick 失败', e); }

      // 生日庆祝信：主线每走一轮检查一次"今天是否 {{user}} 生日"，命中且今年未发过则触发。
      // 前端粗匹配日期，仅在邮箱生态开关开启时生效。延迟错开避免撞车。
      try {
        if (typeof Phone !== 'undefined' && Phone._birthdayMailTick) {
          setTimeout(() => { try { Phone._birthdayMailTick(); } catch(_) {} }, 10500);
        }
      } catch(e) { console.warn('[Chat] 生日庆祝信 tick 失败', e); }


            resolve();
          } catch(e) {
            GameLog.log('error', `onDone处理错误: ${e.message}`);
            resolve();
          } finally {
            contentEl.classList.remove('streaming-cursor');
          }
        };

        const _onError = (err) => {
          contentEl.classList.remove('streaming-cursor');
          reject(new Error(err));
        };

        // v687.6：工具调用处理函数（循环式）
        const _onToolCallsHandler = async (toolCalls, assistantMessage) => {
          try {
            _toolIter++;
            _toolsUsedCount += (toolCalls?.length || 0);
            // v687.11：保留本轮在调工具前 AI 已经吐的文字（不让它消失）
            try {
              const partial = assistantMessage?.content || '';
              if (partial) {
                _priorContent = (_priorContent ? _priorContent + '\n\n' : '') + partial;
              }
            } catch(_) {}
            GameLog.log('info', `[Chat] AI 调用工具（第 ${_toolIter}/${_MAX_TOOL_ITER} 轮，本轮${toolCalls?.length||0}个，累计${_toolsUsedCount}个）: ${toolCalls.map(t => t.function?.name).join(', ')}`);

            // push assistant 的 tool_calls 消息
            apiMessages.push({
              role: 'assistant',
              content: assistantMessage.content || '',
              tool_calls: toolCalls
            });

            // 执行所有工具，结果以 tool role 加入
              for (const tc of toolCalls) {
              let result;
              try {
                // v687.23：MCP 工具路由
                const tcName = tc.function?.name || '';
                if (typeof MCPClient !== 'undefined' && MCPClient.isMCPToolCall(tcName)) {
                  result = await MCPClient.executeToolCall(tc);
                } else {
                  result = await Tools.execute(tc);
                }
              } catch(e) {
                result = `工具执行异常：${e?.message || e}`;
              }
              apiMessages.push({
                role: 'tool',
                tool_call_id: tc.id,
                name: tc.function?.name,
                content: result || ''
              });
              // v687.8：记录工具日志
              try {
                let parsedArgs = tc.function?.arguments;
                try { parsedArgs = JSON.parse(parsedArgs); } catch(_) {}
                _toolsLog.push({
                  name: tc.function?.name || '?',
                  args: parsedArgs,
                  result: String(result || ''),
                  iter: _toolIter,
                  ts: Date.now()
                });
              } catch(_) {}
              GameLog.log('info', `[Chat] 工具 ${tc.function?.name} 返回: ${String(result).substring(0, 200)}`);
            }

            // 再次请求：复用同一套回调
            // 达到上限时：不再带 tools（强制 AI 给文本收尾，避免死循环）
            const reachLimit = _toolIter >= _MAX_TOOL_ITER;
            if (reachLimit) {
              GameLog.log('warn', `[Chat] 工具调用达到 ${_MAX_TOOL_ITER} 次上限，强制收尾（不再带 tools）`);
            }

            API.streamChat(
              apiMessages,
              _onChunk,
              _onDone,
              _onError,
              requestController.signal,
              {
                forceNoStream: !convSettings.stream,
                tools: reachLimit ? undefined : _enabledTools,
                onToolCalls: reachLimit ? undefined : _onToolCallsHandler
              }
            ).catch(e => { if (e.name === 'AbortError') resolve(); else reject(e); });
          } catch(e) {
            GameLog.log('error', `[Chat] tool calling 处理失败: ${e.message}`);
            reject(e);
          }
        };

        // 首次请求
        API.streamChat(
          apiMessages,
          _onChunk,
          _onDone,
          _onError,
          requestController.signal,
          {
            forceNoStream: !convSettings.stream,
            tools: _enabledTools,
            onToolCalls: _onToolCallsHandler
          }
        ).catch(e => {
          if (e.name === 'AbortError') {
            resolve();
          } else {
            reject(e);
          }
        });
      });
    }

    // 重试循环
    let _retryPrefix = ''; // v687.41：断点续传前缀
    while (retryCount < maxRetries) {
      try {
        await _doStream(_retryPrefix);
        break; // 成功，退出循环
      } catch(err) {
        retryCount++;
        const partialContent = aiMsg.content || '';
        if (retryCount >= maxRetries) {
          // 三次都失败
          if (partialContent) {
            // 保留已输出的半截内容，不清空
            contentEl.innerHTML = Markdown.render(partialContent) +
              `<p style="color:var(--danger);font-size:12px;margin-top:8px">⚠ 网络中断，已保留已输出内容（可点击"继续生成"接续）</p>`;
          } else {
            contentEl.innerHTML = `<p style="color:var(--danger)">生成失败（已重试${maxRetries}次）：${Utils.escapeHtml(err.message)}</p>`;
          }
          GameLog.log('error', `streamChat失败（${maxRetries}次）: ${err.message}`);
          UI.showToast(partialContent ? '网络中断，已保留已输出内容' : `生成失败，已重试${maxRetries}次`, 4000);
        } else {
          // 还有重试机会
          if (partialContent) {
            // v687.41：断点续传——保留已输出内容，把半截回复当 assistant 前缀
            GameLog.log('info', `[Chat] 断点续传：已有 ${partialContent.length} 字，作为前缀重试`);
            UI.showToast(`网络波动，正在接续生成（${retryCount}/${maxRetries}）…`, 3000);
            _retryPrefix = partialContent;
            // 在 apiMessages 末尾追加半截 assistant 消息，让 AI 从断点接着写
            apiMessages.push({ role: 'assistant', content: partialContent });
            await new Promise(r => setTimeout(r, 2000)); // 等2秒让网络切换完成
          } else {
            // 还没开始流就挂了，正常重试
            UI.showToast(`生成失败，正在重试（${retryCount}/${maxRetries}）…`, 3000);
            GameLog.log('warn', `streamChat失败第${retryCount}次: ${err.message}，重试中…`);
            aiMsg.content = '';
            contentEl.innerHTML = `<p style="color:var(--text-secondary);font-size:12px">生成失败，正在重试（${retryCount}/${maxRetries}）…</p>`;
            await new Promise(r => setTimeout(r, 1500)); // 等1.5秒再重试
          }
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

    // phoneDown：流式结束后检测是否有待消费的 phoneDown pending
    try {
      if (typeof Phone !== 'undefined' && Phone.getPendingPhoneDown && Phone.getPendingPhoneDown()) {
        // 延迟触发，避免和当前轮尾部逻辑冲突
        setTimeout(() => {
          try {
            if (!Phone.getPendingPhoneDown()) return;
            const input = document.getElementById('chat-input');
            if (input && !isStreaming) { input.value = '<PhoneDown/>'; send(); }
          } catch(_) {}
        }, 500);
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
let _extractRunning = false; // v612：防止自动/手动/总结前提取并发导致重复写入
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
if (_extractRunning) {
GameLog.log('warn', '[Memory] 已有记忆提取任务运行中，本次跳过以避免重复提取');
return;
}
_extractRunning = true;
try {
GameLog.log('info', '[Memory] 开始自动提取...');

// 锁定本次提取的目标面具/对话/轮数，避免异步期间继续发消息或切换状态导致写入信息漂移
const extractScope = Character.getCurrentId();
const extractConvId = Conversations.getCurrent();
const extractRound = roundCount;
// 抓当前游戏内时间，写进小纸条 time 字段（提取期间冻结这个值，避免异步过程中时间变化）
let extractGameTime = '';
try { extractGameTime = Conversations.getStatusBar()?.time || ''; } catch(_) {}
// 多选手动提取只应写入选中内容，不应推进“自动提取游标”，否则会跳过未选中的中间消息
const updateLastExtracted = options.updateLastExtracted !== false;

    let toExtract;
    if (targetMsgs) {
      toExtract = targetMsgs;
    } else {
      if (lastExtractedMsgId) {
        const lastIdx = messages.findIndex(m => m.id === lastExtractedMsgId);
        // 增量：从上次提取的下一条到现在；找不到游标时回退取全部，避免漏前段
        toExtract = lastIdx >= 0 ? messages.slice(lastIdx + 1) : messages.slice();
      } else {
        // v609：首次提取必须从对话开头开始，不能硬截 20 条，否则 18 轮提一次会丢前 16 条
        toExtract = messages.slice();
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
    // 获取已有记忆标题用于去重
    let existingTitles = [];
    try {
      const scope = Character.getCurrentId();
      const allMem = await DB.getAll('memories');
      existingTitles = allMem
        .filter(m => (m.type === 'event' || m.type === 'relation') && (m.scope === scope || !m.scope))
        .map(m => ({ type: m.type, title: m.title || '' }))
        .filter(t => t.title);
    } catch(_) {}
    const prompt = Memory.buildExtractionPrompt(toExtract, charName, charInfo, extractLimits, existingTitles);
    const dialogue = toExtract.map(m => {
      let content = m.content || '';
      // 将status块中的增量时间替换为绝对时间（记忆提取模型需要知道具体日期）
      if (m.statusSnapshot && m.statusSnapshot.time) {
        content = content.replace(/时间：[+\-]\d[^\n]*/g, '时间：' + m.statusSnapshot.time);
      }
      return `[${m.role === 'user' ? charName : 'AI'}] ${content}`;
    }).join('\n\n');

    const MAX_RETRIES = isRetryDisabled() ? 1 : 3;
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
if (updateLastExtracted) {
lastExtractedMsgId = lastMsg.id;
try {
const _conv = Conversations.getList().find(c => c.id === extractConvId);
if (_conv) { _conv.lastExtractedMsgId = lastExtractedMsgId; _conv.extractPending = false; await Conversations.saveList(); }
} catch(_) {}
}
_extractPending = false;
GameLog.log('info', `[Memory] 事件/关系提取完成: ${eventCount}个事件, ${relCount}个关系`);

// 第二次调用：独立提取小纸条（带重试+兜底）
let noteCount2 = 0;
const notesPrompt = Memory.buildNotesPrompt(toExtract, charName, charInfo);
const notesDialogue = toExtract.map(m => `[${m.role === 'user' ? charName : 'AI'}] ${m.content}`).join('\n\n');
let notesSuccess = false;
for (let nAttempt = 1; nAttempt <= 2; nAttempt++) {
  try {
    const notesResult = await API.extractMemory(notesDialogue, notesPrompt);
    let notesCleaned = (notesResult || '').trim();
    if (notesCleaned.startsWith('```')) notesCleaned = notesCleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
    let notesData;
    try { notesData = JSON.parse(notesCleaned); } catch(pe) { notesData = _tryFixTruncatedJSON(notesCleaned); }
    if (notesData && notesData.notes) {
      for (const n of notesData.notes) {
        if (n.tag && n.detail) {
          await Memory.addNote({ tag: n.tag, detail: n.detail, priority: n.priority, characters: n.characters || [], scope: extractScope, roundCreated: extractRound, time: extractGameTime });
noteCount2++;
}
}
}
GameLog.log('info', `[Memory] 小纸条提取完成: ${noteCount2}条`);
    notesSuccess = true;
    break;
  } catch(noteErr) {
    GameLog.log('warn', `[Memory] 小纸条提取第${nAttempt}次失败: ${noteErr.message}`);
    if (nAttempt < 2) await new Promise(r => setTimeout(r, 1000));
  }
}
if (!notesSuccess) {
  // 主模型兜底
  try {
    const notesResult = await API.extractMemory(notesDialogue, notesPrompt, { useMainModel: true });
    let notesCleaned = (notesResult || '').trim();
    if (notesCleaned.startsWith('```')) notesCleaned = notesCleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
    let notesData;
    try { notesData = JSON.parse(notesCleaned); } catch(pe) { notesData = _tryFixTruncatedJSON(notesCleaned); }
    if (notesData && notesData.notes) {
      for (const n of notesData.notes) {
if (n.tag && n.detail) {
           await Memory.addNote({ tag: n.tag, detail: n.detail, priority: n.priority, characters: n.characters || [], scope: extractScope, roundCreated: extractRound, time: extractGameTime });
           noteCount2++;
         }
       }
     }
     GameLog.log('info', `[Memory] 小纸条主模型兜底成功: ${noteCount2}条`);
  } catch(noteErr2) {
    GameLog.log('warn', `[Memory] 小纸条提取全部失败(不影响事件/关系): ${noteErr2.message}`);
  }
}

UI.showToast(`记忆提取完成（${eventCount} 条事件 / ${relCount} 条关系 / ${noteCount2} 条小纸条）`, 2500);
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
if (updateLastExtracted) {
        lastExtractedMsgId = lastMsg.id;
        try {
        const _conv = Conversations.getList().find(c => c.id === extractConvId);
        if (_conv) { _conv.lastExtractedMsgId = lastExtractedMsgId; _conv.extractPending = false; await Conversations.saveList(); }
} catch(_) {}
      }
      _extractPending = false;
      GameLog.log('info', `[Memory] 主模型兜底成功: ${eventCount}个事件, ${relCount}个关系`);
      // 兜底路径也独立提取小纸条
      let noteCount3 = 0;
      try {
        const notesPrompt2 = Memory.buildNotesPrompt(toExtract, charName, charInfo);
        const notesDialogue2 = dialogue;
        const notesResult2 = await API.extractMemory(notesDialogue2, notesPrompt2, { useMainModel: true });
        let notesCleaned2 = (notesResult2 || '').trim();
        if (notesCleaned2.startsWith('```')) notesCleaned2 = notesCleaned2.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
        let notesData2;
        try { notesData2 = JSON.parse(notesCleaned2); } catch(pe) { notesData2 = _tryFixTruncatedJSON(notesCleaned2); }
        if (notesData2 && notesData2.notes) {
          for (const n of notesData2.notes) {
            if (n.tag && n.detail) { await Memory.addNote({ tag: n.tag, detail: n.detail, priority: n.priority, characters: n.characters || [], scope: extractScope, roundCreated: extractRound, time: extractGameTime }); noteCount3++; }
          }
        }
      } catch(noteErr2) { GameLog.log('warn', `[Memory] 兜底小纸条提取失败: ${noteErr2.message}`); }
      UI.showToast(`记忆提取完成（主模型兜底：${eventCount} 条事件 / ${relCount} 条关系 / ${noteCount3} 条小纸条）`, 2500);
      return;
    } catch(fallbackErr) {
      GameLog.log('warn', `[Memory] 主模型兜底也失败: ${fallbackErr.message}`);
    }
    // 全部失败，标记下一轮重试
    _extractPending = true;
    try {
      const _conv = Conversations.getList().find(c => c.id === extractConvId);
      if (_conv) { _conv.extractPending = true; await Conversations.saveList(); }
    } catch(_) {}
    UI.showToast('⚠ 记忆提取失败，将在下一轮自动重试', 4000);
    GameLog.log('error', '[Memory] 功能模型+主模型均失败，标记下一轮重试');
} finally {
_extractRunning = false;
}
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
    if (toExtractBeforeSummary.length > 0 && _getConvSettings().autoExtract) {
      GameLog.log('info', `[Summary] 总结前提取 ${toExtractBeforeSummary.length} 条消息的记忆`);
      await autoExtractMemory(toExtractBeforeSummary);
    }

    // 2. AI生成结构化总结（先总结，成功后才归档删除）
const convId = Conversations.getCurrent();
const char = await Character.get();
const charName = char?.name || '用户角色';

const MAX_RETRIES = isRetryDisabled() ? 1 : 3;
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
    // v689：删除前先把要归档消息里的线上聊天气泡收录进手机聊天 App（否则气泡随消息一起没了）
    try {
      if (typeof Phone !== 'undefined' && Phone.ingestChatMessages) {
        await Phone.ingestChatMessages(toSummarize);
      }
    } catch(_) {}
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
const MAX_RETRIES = isRetryDisabled() ? 1 : 3;
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
    // v689：删除前先收录线上聊天气泡进手机聊天 App
    try {
      if (typeof Phone !== 'undefined' && Phone.ingestChatMessages) {
        await Phone.ingestChatMessages(toSummarize);
      }
    } catch(_) {}
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
      // v687.41g：华为浏览器即使 CSS user-select:none 也会偶发弹出选词菜单——
      // 触摸结束时主动清一次选区，断掉"长按选词→复制"的入口
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel && !sel.isCollapsed) {
          const node = sel.anchorNode;
          const el = node && (node.nodeType === 1 ? node : node.parentElement);
          if (el && el.closest('.chat-msg') && !el.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) {
            sel.removeAllRanges();
          }
        }
      } catch(_) {}
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
      // v687.30：AI 气泡删除按钮全部放开（之前只允许删最新一条，与 user 不对等）
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 删除', action: () => deleteMessage(msgId), danger: true });
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
watermark.textContent = '— SKYNEX —';
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
a.download = `skynex-chat-${Date.now()}.png`;
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

  // ===== 状态栏+手机快照恢复（供回溯/撤回调用）=====
  // 从 messages 末尾往前找第一条带 statusSnapshot 的 AI 消息，
  // 把当前对话的 statusBar 整体回滚到那个快照（含 heartSim 任务/好感）；
  // 找不到则清空状态栏（说明回到了对话开头）。
  // v687.33：同时恢复 phoneSnapshot（手机数据）
  // skipPhone=true 时跳过手机数据恢复——用于"重写"场景：
  //   重写只是对同一轮换个说法，用户本轮主动做的手机操作（拍照/发圈/刷论坛）
  //   不应该被回退抹掉。只有真正的回溯/回滚才连手机数据一起退。
  async function _restoreStatusFromMessages(skipPhone) {
    try {
      let snap = null;
      let phoneSnap = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant') {
          if (!snap && m.statusSnapshot) snap = m.statusSnapshot;
          if (!phoneSnap && m.phoneSnapshot) phoneSnap = m.phoneSnapshot;
          if (snap && phoneSnap) break; // 两个都找到了
        }
      }
      const restored = snap ? JSON.parse(JSON.stringify(snap)) : null;
      // 兜底：如果没有找到任何statusSnapshot（回溯到最早），用开场时间或现实时间初始化
      if (!restored) {
        let fallbackStatus = null;
        try {
          const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
          if (conv?.statusBar?.time) {
            // 对话创建时已经初始化过statusBar
            fallbackStatus = JSON.parse(JSON.stringify(conv.statusBar));
          } else {
            // 最终兜底：用现实时间
            const now = new Date();
            const weekdays = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
            const initTime = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${weekdays[now.getDay()]} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
            fallbackStatus = { region: '', location: '', time: initTime, weather: '', scene: '', playerOutfit: '', playerPosture: '', npcs: [] };
          }
        } catch(_) {}
        await Conversations.setStatusBar(fallbackStatus);
        if (typeof StatusBar !== 'undefined' && StatusBar.render) StatusBar.render(fallbackStatus);
        return;
      }
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
      // v687.33：手机数据恢复（skipPhone 时跳过，保护用户本轮手机操作）
      try {
        if (!skipPhone && typeof Phone !== 'undefined' && Phone.restoreFromSnapshot && phoneSnap) {
          await Phone.restoreFromSnapshot(phoneSnap);
        }
      } catch(e) { console.warn('[Chat] 回溯手机数据失败', e); }
    } catch(e) { console.warn('[Chat] 回溯状态栏失败', e); }
  }

  // ===== 回溯到此处 =====

  async function rollbackTo(msgId) {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    const afterCount = messages.length - idx - 1;
    if (afterCount > 0) {
      let skip = false;
      try { skip = localStorage.getItem('skynex_rollbackConfirmSkip') === '1'; } catch(_) {}
      if (!skip) {
        const res = await UI.showConfirm('时光倒流准备中', `将删除此消息之后的 ${afterCount} 条消息，并同时回溯状态栏和手机数据。是否继续？`, { checkbox: '下次不再提醒' });
        if (!res.ok) return;
        if (res.checked) { try { localStorage.setItem('skynex_rollbackConfirmSkip', '1'); } catch(_) {} }
      }
    }

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
    if (afterCount > 0) {
      let skip = false;
      try { skip = localStorage.getItem('skynex_rollbackConfirmSkip') === '1'; } catch(_) {}
      if (!skip) {
        const res = await UI.showConfirm('时光倒流准备中', `将删除此消息之后的 ${afterCount} 条消息，并同时回溯状态栏和手机数据。是否继续？`, { checkbox: '下次不再提醒' });
        if (!res.ok) return;
        if (res.checked) { try { localStorage.setItem('skynex_rollbackConfirmSkip', '1'); } catch(_) {} }
      }
    }

    // 把该消息内容放回发送框（用 content 而非 contentForAPI，避免系统注入内容暴露）
    const input = document.getElementById('chat-input');
    if (input) {
      input.value = msg.content;
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

    // 异步解析图片占位符 [TSIMG:id|desc] 为真实 img 元素
    try {
      if (div.textContent && div.textContent.includes('[TSIMG:')) {
        resolveDrawnImagesInHTML(div).catch(_ => {});
      }
    } catch(_) {}

    return div;
  }

  function buildAIMessageHTML(parsed, msg) {
    let html = '';
// 气泡顶部：世界观名 + 时间戳（现实/游戏，由全局开关决定）
    if (msg && msg.timestamp) {
      const d = new Date(msg.timestamp);
      const pad = n => String(n).padStart(2, '0');
      const realStr = `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      // 游戏时间：取该条消息的状态栏快照绝对时间（不是增量）；缺失则回退现实时间
      let tsStr = realStr;
      let mode = 'real';
      try { mode = localStorage.getItem('skynex_bubbleTimeMode') || 'real'; } catch(_) {}
      if (mode === 'game') {
        const gameTime = (msg.statusSnapshot && msg.statusSnapshot.time) ? String(msg.statusSnapshot.time).trim() : '';
        if (gameTime) tsStr = gameTime;
      }
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
    html += `<div class="msg-body md-content">${Dice.replaceCheckMarkers(Markdown.render(parsed.body))}</div>`;

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
    const _itemGotAt = (msg?.statusSnapshot?.time || '').replace(/'/g, "\\'");
    parsed.items.forEach(item => {
      html += `<div class="item-card">
        <div class="item-content">
          <span class="item-label">${svgBriefcase} 新获得物品</span>
          <span class="item-name">${Utils.escapeHtml(item)}</span>
        </div>
        <button class="copy-btn" onclick="event.stopPropagation();Character.addItemDirect('${Utils.escapeHtml(item).replace(/'/g, "\\'")}','${_itemGotAt}');" title="收入物品栏">${svgPocket}</button>
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

    // v687.7：工具使用尾巴
    if (msg && msg.toolsUsed > 0) {
      const clickable = (msg.toolsLog && msg.toolsLog.length > 0)
        ? `onclick="event.stopPropagation();Chat._showToolsLog('${msg.id}')" style="cursor:pointer"`
        : '';
      const hint = (msg.toolsLog && msg.toolsLog.length > 0) ? '（点击查看详情）' : '';
      html += `<div class="msg-tools-used" ${clickable} title="本轮 AI 调用了 ${msg.toolsUsed} 个工具${hint}"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;opacity:.85"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>使用了 ${msg.toolsUsed} 个工具${hint}</div>`;
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
    // 解析图片占位符
    try {
      if (el.textContent && el.textContent.includes('[TSIMG:')) {
        resolveDrawnImagesInHTML(el).catch(_ => {});
      }
    } catch(_) {}
  }

  function renderAll() {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    messages.forEach(msg => appendMessage(msg));
    updateScrollBtn();
    if (multiSelectMode) _applyMultiSelectUI();
    // 骰点系统：刷新 🎲 按钮显隐 + 历史气泡 v686
    try { _refreshDiceUI(); } catch(_) {}
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
        // v687.41b：全员黑化检测 → 世界崩坏演出
        try { if (typeof HeartSimCollapse !== 'undefined') HeartSimCollapse.checkAndPlay(); } catch(_) {}
      }
    if (parsed.tasks && typeof StatusBar !== 'undefined') {
      StatusBar.hsApplyTasks(parsed.tasks);
      // 通用任务系统（非心动模拟世界观时生效，心动模拟走自己的 hsApplyTasks）
      if (StatusBar.taskApply) StatusBar.taskApply(parsed.tasks);
    }
    if (parsed.phoneLock && typeof StatusBar !== 'undefined' && StatusBar.hsApplyPhoneLock) {
      StatusBar.hsApplyPhoneLock(parsed.phoneLock);
    }
    // v687.41b：多人囚禁结局 marker — 全员黑化拉满 + 锁手机 + 崩坏演出
    if (parsed.prisonAll && typeof StatusBar !== 'undefined' && StatusBar.hsPrisonAll) {
      StatusBar.hsPrisonAll();
      // 自动锁手机（如果还没锁）
      if (StatusBar.hsApplyPhoneLock && !StatusBar.isPhoneLocked?.()) {
        StatusBar.hsApplyPhoneLock({ status: 'locked', by: '心动目标', reason: '多人囚禁结局' });
      }
      // 触发世界崩坏演出
      try { if (typeof HeartSimCollapse !== 'undefined') HeartSimCollapse.play(); } catch(_) {}
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

    // v687.33：从分支点往前找最近的 statusSnapshot / phoneSnapshot
    // 而非使用 srcConv 最新值（分支点可能在 20 轮以前，状态栏和手机都已经变了）
    let branchStatusSnap = null;
    let branchPhoneSnap = null;
    for (let i = idx; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'assistant') {
        if (!branchStatusSnap && m.statusSnapshot) branchStatusSnap = m.statusSnapshot;
        if (!branchPhoneSnap && m.phoneSnapshot) branchPhoneSnap = m.phoneSnapshot;
        if (branchStatusSnap && branchPhoneSnap) break;
      }
    }

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

    // 6. 注册新对话到列表（传入分支点时刻的快照，而非 srcConv 最新值）
    await Conversations.addBranch(newConvId, branchName.trim(), newMaskId, {
      statusOverride: branchStatusSnap ? JSON.parse(JSON.stringify(branchStatusSnap)) : undefined,
      phoneOverride: branchPhoneSnap ? JSON.parse(JSON.stringify(branchPhoneSnap)) : undefined
    });
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
    // skipPhone=true：重写不回退手机数据，保护用户本轮拍的照/发的圈/刷的论坛
    await _restoreStatusFromMessages(true);

    // 找到对应的用户消息（前一条），删掉后由 send() 重新创建，避免渲染两次导致气泡重复
    const lastUserMsg = messages[messages.length - 1];
    if (!lastUserMsg || lastUserMsg.role !== 'user') return;
    document.getElementById('chat-input').value = lastUserMsg.content;
    roundCount--; // send() 会 ++，先 --
    await DB.del('messages', lastUserMsg.id);
    messages.pop();
    renderAll();
    await send();
  }

  // ===== 附件系统 =====

  let pendingImages = []; // base64
  let pendingMemories = []; // memory objects
  let pendingWorldVoice = null; // 风闻分享内容 { mediaType, title, content, comments }
  let pendingFiles = []; // [{ name, size, content }] 纯文本文件
  let allMemoriesCache = [];
  
  // 从加号菜单打开后台频道（首次自动启用 + 弹设置，已启用则 toggle）
  function _openBackstageFromPlus() {
    if (typeof Backstage === 'undefined') return;
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) return;
    if (!conv.backstageEnabled) {
      // 首次：启用 + 保存 + 显示悬浮按钮 + 弹设置
      conv.backstageEnabled = true;
      Conversations.saveList();
      Backstage.updateFab();
      Backstage.openPromptEdit();
    } else {
      // 已启用：直接 toggle
      Backstage.toggle();
    }
  }

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

  // ===== 回复建议 =====
  let _suggestAbort = null;
  // 按 convId 缓存建议，发送消息后清空当前对话缓存
  const _suggestCache = {};

  async function generateSuggestions() {
    const panel = document.getElementById('suggest-panel');
    if (!panel) return;

    // 如果已经显示，点击关闭（不弹确认）
    if (!panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
      if (_suggestAbort) { _suggestAbort.abort(); _suggestAbort = null; }
      return;
    }

    // 没有当前对话
    const convId = Conversations.getCurrent();
    if (!convId) {
      UI.showToast('请先选择对话', 1500);
      return;
    }

    // 优先用缓存（同一对话还没发送时再点灯泡，直接展示上次结果，不弹确认）
    if (Array.isArray(_suggestCache[convId]) && _suggestCache[convId].length > 0) {
      panel.classList.remove('hidden');
      _renderSuggestions(_suggestCache[convId]);
      return;
    }

    // 没缓存：检查二次确认开关
    let skip = false;
    try { skip = localStorage.getItem('skynex_suggestConfirmSkip') === '1'; } catch(_) {}
    if (skip) {
      await _doGenerateSuggestions(convId);
    } else {
      _showSuggestConfirm(convId);
    }
  }

  function _showSuggestConfirm(convId) {
    const modal = document.getElementById('suggest-confirm-modal');
    if (!modal) {
      // 兜底：弹窗不存在时直接生成
      _doGenerateSuggestions(convId);
      return;
    }
    // 重置复选框
    const skipBox = document.getElementById('suggest-confirm-skip');
    if (skipBox) skipBox.checked = false;
    modal._pendingConvId = convId;
    modal.classList.remove('hidden');
  }

  function _cancelSuggestConfirm() {
    const modal = document.getElementById('suggest-confirm-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal._pendingConvId = null;
  }

  function _okSuggestConfirm() {
    const modal = document.getElementById('suggest-confirm-modal');
    if (!modal) return;
    const skipBox = document.getElementById('suggest-confirm-skip');
    if (skipBox && skipBox.checked) {
      try { localStorage.setItem('skynex_suggestConfirmSkip', '1'); } catch(_) {}
    }
    const convId = modal._pendingConvId;
    modal.classList.add('hidden');
    modal._pendingConvId = null;
    if (convId) _doGenerateSuggestions(convId);
  }

  async function _doGenerateSuggestions(convId) {
    const panel = document.getElementById('suggest-panel');
    if (!panel) return;

    // 最近消息
    const recent = messages.slice(-10);
    if (recent.length === 0) {
      UI.showToast('当前对话没有消息', 1500);
      panel.classList.add('hidden');
      return;
    }

    // 获取面具信息
    let charPrompt = { name: '用户角色', desc: '' };
    try {
      const char = await Character.get();
      if (char) {
        charPrompt.name = char.name || '用户角色';
        charPrompt.desc = Character.formatForPrompt(char) || '';
      }
    } catch(_) {}

    // 显示 loading
    panel.classList.remove('hidden');
    panel.innerHTML = '<div class="suggest-loading">正在生成回复建议…</div>';

    // 灵感按钮变色
    const btn = document.getElementById('btn-suggest');
    if (btn) btn.style.color = 'var(--accent)';

    _suggestAbort = new AbortController();
    try {
      const suggestions = await API.suggest(recent, charPrompt);
      console.log('[Suggest] 解析出', suggestions.length, '条建议:', suggestions);
      if (!Array.isArray(suggestions) || suggestions.length === 0) {
        panel.innerHTML = '<div class="suggest-loading">未能生成建议，请重试</div>';
        setTimeout(() => panel.classList.add('hidden'), 2000);
        return;
      }
      // 缓存
      _suggestCache[convId] = suggestions;
      _renderSuggestions(suggestions);
    } catch(e) {
      if (e.name === 'AbortError') return;
      panel.innerHTML = `<div class="suggest-loading" style="color:var(--danger)">生成失败：${Utils.escapeHtml(e.message)}</div>`;
      setTimeout(() => panel.classList.add('hidden'), 3000);
    } finally {
      if (btn) btn.style.color = '';
      _suggestAbort = null;
    }
  }

  function _renderSuggestions(suggestions) {
    const panel = document.getElementById('suggest-panel');
    if (!panel) return;
    const itemsHtml = suggestions.map((s, i) =>
      `<div class="suggest-item" onclick="Chat._pickSuggestion(${i})" data-idx="${i}">${Utils.escapeHtml(s)}</div>`
    ).join('');
    panel.innerHTML = `
      <div class="suggest-header">
        <span class="suggest-title">回复建议</span>
        <button class="suggest-refresh" onclick="Chat.refreshSuggestions()" title="重新生成">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-15-6.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"/><path d="M21 21v-5h-5"/></svg>
        </button>
      </div>
      <div class="suggest-list">${itemsHtml}</div>
    `;
    panel._suggestions = suggestions;
  }

  async function refreshSuggestions() {
    const convId = Conversations.getCurrent();
    if (!convId) return;
    // 清掉当前对话缓存，强制重新生成
    delete _suggestCache[convId];
    await _doGenerateSuggestions(convId);
  }

  function _pickSuggestion(idx) {
    const panel = document.getElementById('suggest-panel');
    if (!panel || !panel._suggestions) return;
    const text = panel._suggestions[idx];
    if (!text) return;
    const input = document.getElementById('chat-input');
    if (input) {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      input.focus();
    }
    panel.classList.add('hidden');
    // 不清 _suggestCache，只清 panel 上的临时引用
    // 用户回头点灯泡还能看到这批建议；除非他真的把消息发出去了
  }

  // 发送成功后调用，清当前对话的建议缓存
  function _clearSuggestCache(convId) {
    if (convId && _suggestCache[convId]) {
      delete _suggestCache[convId];
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
      if (pendingImages.length >= 3) { UI.showToast('最多3张图片', 1800); return; }
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
        <button class="remove-attach" onclick="Chat.removeAttach('image',${i})"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    });
    pendingMemories.forEach((m, i) => {
      html += `<div class="attach-item">
        <span style="display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z" clip-rule="evenodd" /></svg>${Utils.escapeHtml(m.title || '记忆')}</span>
        <button class="remove-attach" onclick="Chat.removeAttach('memory',${i})"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    });
    pendingFiles.forEach((f, i) => {
      html += `<div class="attach-item" style="cursor:pointer" onclick="Chat.previewFile(${i})" title="点击预览">
        <span style="display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0 0 16.5 9h-1.875a1.875 1.875 0 0 1-1.875-1.875V5.25A3.75 3.75 0 0 0 9 1.5H5.625Z" clip-rule="evenodd" /></svg>${Utils.escapeHtml(f.name)}</span>
        <button class="remove-attach" onclick="event.stopPropagation();Chat.removeAttach('file',${i})"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    });
    if (pendingWorldVoice) {
      html += `<div class="attach-item">
        <span style="display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${Utils.escapeHtml(pendingWorldVoice.mediaType + '·' + pendingWorldVoice.title)}</span>
        <button class="remove-attach" onclick="Chat.removeAttach('worldvoice',0)"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    }
    bar.innerHTML = html;
  }

  // 从最近AI回复中提取游戏内日期（月和日）
  function _extractGameDate(messages) {
    // 优先从状态栏读取当前游戏时间
    try {
      const sb = Conversations.getStatusBar();
      if (sb?.time) {
        const tm = sb.time.match(/(\d{1,2})月(\d{1,2})日/);
        if (tm) return { month: parseInt(tm[1]), day: parseInt(tm[2]) };
        // 兼容 "YYYY.MM.DD" 格式
        const tm2 = sb.time.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
        if (tm2) return { month: parseInt(tm2[2]), day: parseInt(tm2[3]) };
      }
    } catch(_) {}
    // 兜底：从聊天记录倒序查找
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'assistant') continue;
      const text = messages[i].content || '';
      const m = text.match(/(\d{1,2})月(\d{1,2})日/);
      if (m) return { month: parseInt(m[1]), day: parseInt(m[2]) };
      const m2 = text.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
      if (m2) return { month: parseInt(m2[2]), day: parseInt(m2[3]) };
    }
    return null;
  }

  // 构建节日提示（只注入时间命中的节日）
  function _buildFestivalPrompt(festivals, msgs) {
    if (!festivals || festivals.length === 0) return '';
    // 过滤禁用的节日（v592）
    festivals = festivals.filter(f => f && f.enabled !== false);
    if (festivals.length === 0) return '';
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

  // 构建自定义设定提示（只发启用的常驻条目）
// v581：从合并后的 knowledges 数组里筛 keywordTrigger=false 且 enabled=true 的条目
// v587：此函数仅用于 showContext 等简单场景；send() 路径走 _buildExtendedInjections 按位置分流
function _buildCustomPrompt(customs) {
if (!customs || customs.length === 0) return '';
const enabled = customs.filter(c => c && !c.keywordTrigger && c.enabled);
if (enabled.length === 0) return '';
const lines = enabled.map(c => `- ${c.name}：${c.content}`);
return `【世界观·扩展设定（当前生效）】\n${lines.join('\n')}`;
}

// 构建知识设定索引（每轮发标题列表，告诉AI有哪些条目存在）
// v581：只统计动态条目（keywordTrigger=true）
function _buildKnowledgeIndex(knowledges) {
if (!knowledges || knowledges.length === 0) return '';
const dynamic = knowledges.filter(k => k && k.keywordTrigger !== false && k.enabled !== false);
const names = dynamic.map(k => k.name).filter(Boolean);
if (names.length === 0) return '';
return `【世界观·知识条目索引】\n本世界包含以下知识条目（详情会在你或玩家提及时自动补充）：\n${names.map(n => `· ${n}`).join('\n')}\n请在剧情自然的前提下灵活引用。`;
}

// v632 → v685：聚合当前对话能用到的所有世界书数据（festivals/knowledges/globalNpcs）
  // 返回合并后的虚拟世界观对象，用法和老的 _hiddenWv 一致。
  // v685：升级为模式无关——所有模式（单人卡/单人有世界观/群像）走同一条路径
  //       数据来源：wv.defaultLorebookIds + wv.lorebookIds + card.lorebookIds + 常驻角色卡书 + conv.lorebookIds
  // v632.1：事件系统不进入世界书层（事件有运行时状态，不适合多本叠加），不再合并 events
  async function _getMergedLorebooksForConv(conv) {
    if (typeof Lorebook === 'undefined') return null;
    // v686.9：知识系统总开关——关闭则不注入世界书内容
    if (conv && conv.convKnowledgeEnabled === false) return null;
    try {
      // 1) 拿当前对话能用到的 card
      let card = null;
      try {
        if (conv && conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
          card = await SingleCard.get(conv.singleCharId);
          if (card && card.extEnabled === false) card = null; // 卡级扩展关掉的话不读卡书
        }
      } catch(_) {}
      // 2) 拿对应的 wv
      let wv = null;
      try {
        // 单人模式优先用 singleWorldviewId，否则用 conv.worldviewId
        const wvId = (conv && (conv.singleWorldviewId || conv.worldviewId)) || null;
        if (wvId && wvId !== '__default_wv__') {
          wv = await DB.get('worldviews', wvId);
        }
      } catch(_) {}
      // 3) 收集（collectForChat 内部已去重 + 处理 conv.lorebookDisabled）
      const lbs = await Lorebook.collectForChat({ conv, card, wv });
      if (!lbs || !lbs.length) return null;
      const merged = { festivals: [], knowledges: [], events: [], globalNpcs: [] };
      for (const lb of lbs) {
        if (Array.isArray(lb.festivals)) merged.festivals.push(...lb.festivals);
        if (Array.isArray(lb.knowledges)) merged.knowledges.push(...lb.knowledges);
        if (Array.isArray(lb.globalNpcs)) merged.globalNpcs.push(...lb.globalNpcs);
        // events 不合并（保持空数组，避免老代码崩）
      }
      return merged;
    } catch(e) {
      try { console.warn('[Chat] _getMergedLorebooksForConv 失败', e); } catch(_) {}
      return null;
    }
  }

  // v632 兼容别名：老代码继续用 _getCardLorebooksMerged(cardId, conv)，转发到新函数
  // 现在 cardId 不再用，全靠 conv 自己解析（更准确）
  async function _getCardLorebooksMerged(cardId, conv) {
    return _getMergedLorebooksForConv(conv);
  }

  // 构建节日索引（每轮发名字+日期，让 AI 能预知后续节日）
// 时间命中的节日已通过 _buildFestivalPrompt 单独发完整内容，索引里不去重（就那么点字）
function _buildFestivalIndex(festivals) {
if (!festivals || festivals.length === 0) return '';
const enabled = festivals.filter(f => f && f.enabled !== false);
if (enabled.length === 0) return '';
const lines = enabled.map(f => {
let s = `· ${f.name || '未命名'}`;
if (f.date) s += `（${f.date}${f.yearly ? '，每年' : ''}）`;
return s;
});
    return `【世界观·节日索引】\n本世界包含以下节日（详情会在游戏时间临近时自动补充）：\n${lines.join('\n')}\n可在剧情自然提及时灵活引用，提前埋伏笔。`;
  }

  // 命中提及节日：扫最近正文，命中节日名/触发关键词的，把节日内容作为背景资料发给 AI
  // 仿"提及地区"那套：不代表节日正在发生，只是玩家/AI 聊到了它，提前把真实详情给 AI 避免乱编
  // - excludeNames：已通过时间命中（_buildFestivalPrompt）发过完整内容的节日名，避免重复注入
  function _buildMentionedFestivalPrompt(festivals, msgs, excludeNames) {
    if (!festivals || festivals.length === 0) return '';
    const enabled = festivals.filter(f => f && f.enabled !== false && (f.content || '').trim());
    if (enabled.length === 0) return '';
    const recent = (msgs || []).filter(m => m.role !== 'system').slice(-4);
    if (recent.length === 0) return '';
    const scanText = recent.map(m => m.content || '').join('\n').toLowerCase();
    if (!scanText.trim()) return '';
    const exclude = new Set((excludeNames || []).map(n => String(n || '').toLowerCase()));
    const hits = [];
    for (const f of enabled) {
      if (exclude.has(String(f.name || '').toLowerCase())) continue;
      // 候选关键词：节日名 + keys（逗号/空格分隔）
      const keys = [];
      if (f.name) keys.push(f.name);
      const keyStr = (f.keys || '').trim();
      if (keyStr) keys.push(...keyStr.split(/[,，、\s]+/).filter(Boolean));
      let earliest = -1;
      for (const k of keys) {
        if (!k || k.length < 2) continue; // 太短的跳过，避免误命中
        const idx = scanText.indexOf(k.toLowerCase());
        if (idx >= 0 && (earliest < 0 || idx < earliest)) earliest = idx;
      }
      if (earliest >= 0) hits.push({ fest: f, pos: earliest });
    }
    if (!hits.length) return '';
    hits.sort((a, b) => a.pos - b.pos);
    const top = hits.slice(0, 3);
    let txt = '【提及的节日】\n本轮玩家或 AI 在正文中提到了以下节日，仅作背景资料参考，不代表节日正在发生，剧情中无需主动展开。\n';
    for (const h of top) {
      txt += `\n[节日：${h.fest.name}${h.fest.date ? `（${h.fest.date}）` : ''}]\n${(h.fest.content || '').trim()}\n`;
    }
    return txt;
  }

// 构建知识设定提示（最近2轮对话出现关键词时触发）
// v581：只处理动态条目（keywordTrigger=true）
function _buildKnowledgePrompt(knowledges, messages) {
if (!knowledges || knowledges.length === 0) return '';
const dynamic = knowledges.filter(k => k && k.keywordTrigger !== false && k.enabled !== false);
if (dynamic.length === 0) return '';
const recent = (messages || []).filter(m => m.role !== 'system').slice(-4);
if (recent.length === 0) return '';
const scanText = recent.map(m => m.content || '').join('\n').toLowerCase();
const matched = [];
for (const k of dynamic) {
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

// v587：按注入位置分流的扩展条目注入
  // 返回 { systemTop: [], systemBottom: [], depths: { '0': [...], '4': [...] } }
  // 规则：
  //   - 常驻条目（keywordTrigger=false 且 enabled）：无条件按 position 分流
  //   - 动态条目（keywordTrigger=true 且 enabled）：按关键词命中最近4条非system消息才注入，命中后按 position 分流
  //   - 事件条目（triggerMode='event'）：关键词/数值触发→持续注入→结束关键词关闭（v610+）
  // 节日单独保留旧逻辑（外部处理），这里不含。
  function _getCustomAttrValueForEvent(cond, wvOverride) {
try {
const status = Conversations.getStatusBar() || {};
const wv = wvOverride || null;
if (!cond) return null;
const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
const gp = conv?.convGameplay || wv?.gameplay || null;
if (!gp) return null;
      if (cond.scope === 'character') {
        const card = (gp.characterAttrs || []).find(c => [c?.targetType || '', c?.targetId || '', c?.sourceWorldviewId || ''].join(':') === cond.targetKey);
        const attr = (card?.attrs || []).find(a => a && a.id === cond.attrId);
        if (!attr) return null;
        const v = status.customAttrs?.characters?.[cond.targetKey]?.[cond.attrId] ?? attr.initial ?? 0;
        const n = Number(v); return Number.isFinite(n) ? n : null;
      }
      const attr = (gp.globalAttrs || []).find(a => a && a.id === cond.attrId);
      if (!attr) return null;
      const v = status.customAttrs?.global?.[cond.attrId] ?? attr.initial ?? 0;
      const n = Number(v); return Number.isFinite(n) ? n : null;
    } catch(_) { return null; }
  }
  function _compareEventAttrValue(cur, op, target) {
    const t = Number(target);
    if (!Number.isFinite(cur) || !Number.isFinite(t)) return false;
    switch (op) {
      case '>': return cur > t;
      case '>=': return cur >= t;
      case '<': return cur < t;
      case '<=': return cur <= t;
      case '==': return cur === t;
      case '!=': return cur !== t;
      default: return cur >= t;
    }
  }
  function _eventAttrConditionsMet(ev, wvOverride) {
    const conds = Array.isArray(ev?.attrConditions) ? ev.attrConditions : [];
    if (!conds.length) return false;
    return conds.every(c => {
      if (c.scope === 'allCharacters') {
        return _checkAllCharactersCondition(c, wvOverride);
      }
      return _compareEventAttrValue(_getCustomAttrValueForEvent(c, wvOverride), c.operator || '>=', c.value);
    });
  }
  // v688.10：所有角色同名属性条件判断
  function _checkAllCharactersCondition(cond, wvOverride) {
    try {
      const status = Conversations.getStatusBar() || {};
      const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
      const gp = conv?.convGameplay || wvOverride?.gameplay || null;
      if (!gp) return false;
      const targetName = (cond.attrName || '').trim();
      if (!targetName) return false;
      const matchMode = cond.matchMode || 'all';
      const results = [];
      (gp.characterAttrs || []).forEach(card => {
        const key = [card?.targetType || '', card?.targetId || '', card?.sourceWorldviewId || ''].join(':');
        (card.attrs || []).filter(a => a && (a.name || '').trim() === targetName).forEach(a => {
          const v = status.customAttrs?.characters?.[key]?.[a.id] ?? a.initial ?? 0;
          const n = Number(v);
          if (Number.isFinite(n)) {
            results.push(_compareEventAttrValue(n, cond.operator || '>=', cond.value));
          }
        });
      });
      if (!results.length) return false; // 没有角色有这个属性
      return matchMode === 'any' ? results.some(r => r) : results.every(r => r);
    } catch(_) { return false; }
  }

  // 时间触发条件判断
  function _eventTimeConditionMet(currentTimeStr, startStr, endStr) {
    try {
      if (!currentTimeStr || !startStr) return false;
      // 从当前时间里提取时分和月日
      const curParsed = typeof Calendar !== 'undefined' ? Calendar.parseAbsoluteTime(currentTimeStr) : null;
      if (!curParsed) return false;
      const curMinutes = curParsed.hour * 60 + curParsed.minute;
      const curMonth = curParsed.month;
      const curDay = curParsed.day;

      // 解析用户填的时间（支持 "HH:mm" 或 "M月D日 HH:mm"）
      function parseEventTime(str) {
        str = str.trim();
        // 完整格式：X月X日 HH:mm
        const full = str.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
        if (full) return { month: parseInt(full[1]), day: parseInt(full[2]), hour: parseInt(full[3]), minute: parseInt(full[4]), hasDate: true };
        // 只有时分：HH:mm
        const hm = str.match(/^(\d{1,2}):(\d{2})$/);
        if (hm) return { month: 0, day: 0, hour: parseInt(hm[1]), minute: parseInt(hm[2]), hasDate: false };
        return null;
      }

      const start = parseEventTime(startStr);
      if (!start) return false;
      const end = endStr ? parseEventTime(endStr) : null;

      if (start.hasDate) {
        // 一次性时间触发：精确日期范围
        const curVal = curMonth * 10000 + curDay * 100 + curParsed.hour * 60 + curParsed.minute;
        const startVal = start.month * 10000 + start.day * 100 + start.hour * 60 + start.minute;
        if (end && end.hasDate) {
          const endVal = end.month * 10000 + end.day * 100 + end.hour * 60 + end.minute;
          return curVal >= startVal && curVal <= endVal;
        }
        return curVal >= startVal;
      } else {
        // 每天重复：只比较时分
        const startMin = start.hour * 60 + start.minute;
        if (end && !end.hasDate) {
          const endMin = end.hour * 60 + end.minute;
          if (startMin <= endMin) {
            return curMinutes >= startMin && curMinutes <= endMin;
          } else {
            // 跨午夜：如 22:00~06:00
            return curMinutes >= startMin || curMinutes <= endMin;
          }
        }
        return curMinutes >= startMin;
      }
    } catch(_) { return false; }
  }

  function _formatEventInjection(ev, phase) {
    const name = ev?.name || '事件';
    const content = ev?.content || '';
    const completeKey = ev?.completeKey || '__EVENT_DONE__';
    const finishRule = (ev?.finishRule || '').trim() || '当事件内容中的核心冲突、目标或场景已经自然完成时，视为事件结束。';
    const title = phase === 'trigger' ? '【世界观·事件触发】' : '【世界观·事件进行中】';
    const startRule = phase === 'trigger' ? '- 本事件从本轮开始生效。\n- 不要在刚触发时立刻输出结束关键词，除非用户输入和当前剧情已经明确满足“结束判断”。\n- 事件刚触发时，先用自然的剧情过渡引入本事件，不要急着推进核心情节；可以用几轮对话铺垫氛围、让玩家适应，再逐步进入重头戏。' : '- 本事件仍在进行中。';
    return `${title}\n事件名称：${name}\n\n事件内容：\n${content}\n\n结束判断：\n${finishRule}\n\n事件持续规则：\n${startRule}\n- 一个事件通常需要多轮对话才能自然完成，不必、也不应在单轮回复里就把整个事件演完。请配合玩家的节奏推进，把核心情节充分铺展开。\n- 只要本事件尚未满足“结束判断”，就应持续遵循事件内容推进剧情。\n- 不要因为一次轻微提及、场景短暂转移或数值条件回落，就自行结束事件。\n- 当根据玩家行为、剧情进展与“结束判断”确认事件已经自然结束时，再在该轮回复中输出结束关键词。\n- 结束关键词用于系统关闭事件，不应展示给玩家。默认请用 HTML 注释包裹：<!-- ${completeKey} -->\n- 若剧情文本中自然适合明示该关键词，也可以自然包含它；否则优先使用 HTML 注释。`;
  }
  function _buildExtendedInjections(knowledges, messages, events, convEventStates, options = {}) {
    const out = { systemTop: [], systemBottom: [], depths: {} };
    const allowAttrEvents = options.allowAttrEvents !== false;
    const wvOverride = options.wv || null;
    if ((!knowledges || knowledges.length === 0) && (!events || events.length === 0)) return out;
    const enabled = (knowledges || []).filter(k => k && k.enabled !== false);

    // 关键词命中（只扫动态条目一次，避免反复扫描）
    let scanText = '';
    const dynamicEnabled = enabled.filter(k => k.keywordTrigger);
    const hasEvents = events && events.length > 0;
    const hasKeywordEvents = hasEvents && events.some(ev => !ev || (ev.triggerType || 'keyword') !== 'attr');
    if (dynamicEnabled.length > 0 || hasKeywordEvents) {
      const recent = (messages || []).filter(m => m.role !== 'system').slice(-4);
      scanText = recent.map(m => m.content || '').join('\n').toLowerCase();
    }

    for (const k of enabled) {
      let text;
      if (k.keywordTrigger) {
        // 动态：关键词命中才注入
        const keyStr = (k.keys || '').trim();
        if (!keyStr) continue;
        const keys = keyStr.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
        if (!keys.some(key => scanText.includes(key.toLowerCase()))) continue;
        text = `【世界观·相关知识】\n以下内容与最近对话相关。请自然纳入角色认知，不要生硬说明。\n${k.name || '条目'}：${k.content || ''}`;
      } else {
        // 常驻：直接注入
        text = `【世界观·扩展设定】\n请将以下内容作为当前世界的背景事实遵守，不要生硬复述。\n${k.name || '条目'}：${k.content || ''}`;
      }
      const pos = k.position || 'system_top';
      if (pos === 'system_bottom') {
        out.systemBottom.push(text);
      } else if (pos === 'depth') {
        const d = (typeof k.depth === 'number' ? k.depth : 0);
        const dk = String(d);
        (out.depths[dk] = out.depths[dk] || []).push(text);
      } else {
        out.systemTop.push(text);
      }
    }

    // 事件条目处理（v610）
    if (hasEvents && convEventStates) {
      for (const ev of events) {
        if (!ev || !ev.id) continue;
        const state = convEventStates[ev.id] || 'locked'; // locked | active | done
        if (state === 'done') continue; // 已完成，跳过
        if (state === 'active') {
          // 时间触发的事件：检查是否已超出结束时间，自动关闭
          if ((ev.triggerType || 'keyword') === 'time' && ev.triggerTimeEnd) {
            try {
              const sb = Conversations.getStatusBar();
              const currentTime = sb?.time || '';
              if (currentTime && !_eventTimeConditionMet(currentTime, ev.triggerTimeStart, ev.triggerTimeEnd)) {
                // 超出时间范围，自动关闭
                convEventStates[ev.id] = 'done';
                continue;
              }
            } catch(_) {}
          }
          // 进行中：每轮注入
          out.systemTop.push(_formatEventInjection(ev, 'active'));
          out._activeEvents = (out._activeEvents || 0) + 1;
        } else {
          // locked：检查关键词或数值或时间条件是否命中
          const triggerType = ev.triggerType || 'keyword';
          let hit = false;
          if (triggerType === 'attr') {
            if (!allowAttrEvents) continue;
            hit = _eventAttrConditionsMet(ev, wvOverride);
          } else if (triggerType === 'time') {
            // 时间触发：检查当前游戏时间是否在范围内
            try {
              const sb = Conversations.getStatusBar();
              const currentTime = sb?.time || '';
              if (currentTime && ev.triggerTimeStart) {
                hit = _eventTimeConditionMet(currentTime, ev.triggerTimeStart, ev.triggerTimeEnd);
              }
            } catch(_) {}
          } else {
            const keyStr = (ev.keys || '').trim();
            if (!keyStr) continue;
            const keys = keyStr.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
            hit = keys.some(key => scanText.includes(key.toLowerCase()));
          }
          if (hit) {
            // 命中！标记为 active（调用方负责持久化）
            convEventStates[ev.id] = 'active';
            out.systemTop.push(_formatEventInjection(ev, 'trigger'));
            out._triggeredEvents = (out._triggeredEvents || 0) + 1;
          }
        }
      }
    }

    // 统计日志
    const _staticCount = enabled.filter(k => !k.keywordTrigger).length;
    const _dynamicHit = (out.systemTop.length + out.systemBottom.length + Object.values(out.depths).reduce((s, a) => s + a.length, 0)) - _staticCount - (out._activeEvents || 0) - (out._triggeredEvents || 0);
    try { GameLog.log('info', `[世界观注入] 常驻=${_staticCount}, 动态命中=${Math.max(0, _dynamicHit)}, 事件进行中=${out._activeEvents || 0}, 事件新触发=${out._triggeredEvents || 0}`); } catch(_) {}

    return out;
  }

  function setWorldview(text) {
    worldviewPrompt = text;
  }
  function getWorldviewPrompt() { return worldviewPrompt; }

  // v687.33：暴露返航世界设定常量（供 phone.js 在返航 continue/epilogue 模式下替换世界观）
  function getHsHomecomingWorldSetting() { return _HS_HOMECOMING_WORLD_SETTING; }

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
    // v687 重构：复用 _buildApiContext
    try {
      const { apiMessages, char, relatedMemories, convSettings, isGameMode, isGaidenConv, isSingleConv } = await _buildApiContext(messages);

      const totalTokens = apiMessages.reduce((sum, m) => sum + Utils.estimateTokens(m.content), 0);

      const content = apiMessages.map((m, i) => {
        const _c = (typeof m.content === 'string') ? m.content
          : (m.content == null ? '' : (typeof m.content === 'object' ? JSON.stringify(m.content, null, 2) : String(m.content)));
        return `[${i}] role=${m.role} (~${Utils.estimateTokens(m.content)}tk)\n${_c}`;
      }).join('\n\n' + '='.repeat(60) + '\n\n');

      document.getElementById('edit-content').value =
        `=== 上下文预览 ===\n消息数: ${apiMessages.length}\n总Token估算: ~${totalTokens}\n当前轮数: ${roundCount}\n当前分支: ${currentBranchId}\n当前区域: ${NPC.getRegion()}\n文游模式: ${isGameMode ? '开' : '关'}\n流式输出: ${convSettings.stream ? '开' : '关'}\n回复格式: ${convSettings.format ? '开' : '关'}\n番外对话: ${isGaidenConv ? '是' : '否'}\n命中记忆: ${relatedMemories.length}条\n\n${'='.repeat(50)}\n\n${content}`;
      document.getElementById('edit-modal').classList.remove('hidden');
      document.getElementById('edit-modal').dataset.editId = '__debug__';
      if (typeof UI !== 'undefined' && UI.switchDebugTab) {
        UI.switchDebugTab('debug-context');
      }
    } catch (e) {
      console.error('[Chat] showContext 构建上下文失败', e);
      // 不再静默失败：把错误显示在弹窗里，方便排查
      const ta = document.getElementById('edit-content');
      if (ta) {
        ta.value = `=== 上下文预览失败 ===\n构建上下文时出错：\n${e && e.message ? e.message : e}\n\n${e && e.stack ? e.stack : ''}`;
        document.getElementById('edit-modal').classList.remove('hidden');
        document.getElementById('edit-modal').dataset.editId = '__debug__';
        if (typeof UI !== 'undefined' && UI.switchDebugTab) UI.switchDebugTab('debug-context');
      }
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast('上下文构建出错，已显示错误详情', 2000);
    }
  }

  /**
   * v687.8：查看本条 AI 消息的工具调用日志
   */
  function _showToolsLog(msgId) {
    const msg = messages.find(m => m.id === msgId);
    if (!msg || !msg.toolsLog || msg.toolsLog.length === 0) {
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast('该消息没有工具调用记录', 1500);
      return;
    }
    const fmtTs = (ts) => {
      try {
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      } catch(_) { return ''; }
    };
    const lines = [];
    lines.push(`=== 工具调用日志 ===`);
    lines.push(`消息 ID: ${msgId}`);
    lines.push(`共调用 ${msg.toolsLog.length} 个工具（${msg.toolsUsed || msg.toolsLog.length} 次）`);
    lines.push('');
    msg.toolsLog.forEach((log, i) => {
      lines.push('='.repeat(60));
      lines.push(`[${i + 1}/${msg.toolsLog.length}] ${log.name}  (第${log.iter}轮 · ${fmtTs(log.ts)})`);
      lines.push('-'.repeat(60));
      lines.push('参数:');
      try {
        lines.push(JSON.stringify(log.args, null, 2));
      } catch(_) {
        lines.push(String(log.args));
      }
      lines.push('');
      lines.push('返回:');
      lines.push(String(log.result || '(空)'));
      lines.push('');
    });

    const ta = document.getElementById('edit-content');
    if (ta) {
      ta.value = lines.join('\n');
      const editModal = document.getElementById('edit-modal');
      // v687.13：强制把 edit-modal 重挂到 body 末尾 + 高 z-index，避免被 backstage-modal 的
      // floating-modal animation transform 残留创建的 stacking context 夹住
      try { document.body.appendChild(editModal); } catch(_) {}
      editModal.style.zIndex = '99999';
      editModal.classList.remove('hidden');
      editModal.dataset.editId = '__debug__';
      if (typeof UI !== 'undefined' && UI.switchDebugTab) {
        UI.switchDebugTab('debug-context');
      }
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

  // 当前对话是否禁用了自动重试（供 chat/backstage/phone/worldvoice/gaiden 等共用）
  function isRetryDisabled() {
    try {
      const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
      if (conv) return !!conv.convDisableRetry;
      // 没有当前对话时，回退到 localStorage 的最后选择
      return localStorage.getItem('skynex_lastDisableRetry') === '1';
    } catch(_) {
      return false;
    }
  }

  function _getConvSettings() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const voice = conv?.convVoice || {};
    return {
      stream: conv?.convStream !== false,      // 默认开
      gameMode: conv?.convGameMode !== false,   // 默认开
      format: conv?.convFormat !== false,       // 默认开
      stripHistoryHtml: !!conv?.convStripHistoryHtml,    // 发请求时过滤 AI 历史里的 HTML（默认关）
      stripHtmlKeepText: conv?.convStripHtmlKeepText !== false,  // 过滤时保留文字（剥标签留内容，默认开）
      disableRetry: !!conv?.convDisableRetry,   // 默认关（关闭自动重试）
      backstage: !!conv?.backstageEnabled,      // 默认关
      timeAware: !!conv?.convTimeAware,         // 默认关
      batteryAware: !!conv?.convBatteryAware,   // v687.14：默认关
      weatherAware: !!conv?.convWeatherAware,   // v687.14：默认关
      onlineChat: !!conv?.convOnlineChat,       // 默认关（线上消息气泡）
      eventsEnabled: conv?.convEventsEnabled !== false, // 默认开（世界观事件系统）
      tasksEnabled: conv?.convTasksEnabled !== false,   // 默认开（通用任务系统）
      attrsEnabled: conv?.convAttrsEnabled !== false,   // 默认开（数值系统注入）v686.9
      knowledgeEnabled: conv?.convKnowledgeEnabled !== false, // 默认开（知识系统注入）v686.9
      voiceEnabled: !!voice.enabled,
      voiceId: voice.voiceId || '',
      voiceScope: {
        all: !!voice.scopeAll,
        quotes: Array.isArray(voice.quotes) ? voice.quotes : []
      },
bgImage: conv?.convBgImage || '',
        imgGen: !!conv?.convImgGen,                  // 默认关（生图模式）
    callEnabled: conv?.convCallEnabled !== false, // 默认开（来电能力）
      callFreq: conv?.convCallFreq || 'normal',     // 来电频率：'normal'(正常,默认) | 'active'(积极)
      groupChatEnabled: !!conv?.convGroupChatEnabled, // 默认关（主线群聊：触发已有群+AI建群）
      narrPerson: conv?.convNarrPerson || 'second', // 叙述人称：'first' | 'second'(默认) | 'third'
      suggestEnabled: conv?.convSuggestEnabled !== false, // 默认开（回复建议灵感灯泡）
    toolsMemory: !!conv?.convToolsMemory,          // 默认关（记忆类工具）
    toolsWorldview: !!conv?.convToolsWorldview,    // 默认关（世界观查询工具）
    toolsEdit: !!conv?.convToolsEdit,              // 默认关（AI 编辑设定/单人卡，高风险）
    toolsHistory: !!conv?.convToolsHistory,        // 默认关（历史搜索工具）
        autoExtract: conv?.convAutoExtract !== false,  // 默认开（自动记忆提取）
      replyWordCount: conv?.convReplyWordCount || 800,  // 默认800字
      timeFormat: conv?.convTimeFormat || 'delta',       // 时间输出格式：'delta'(增量,默认) | 'absolute'(绝对时间)
      directive: conv?.convDirective || '',              // 剧情引导内容
      directiveRemaining: conv?.convDirectiveRemaining || 0, // 剩余轮数
      directiveTotal: conv?.convDirectiveTotal || 0,      // 原始设定轮数
      // v687.34：AI行为约束
      constraintEcho: !!conv?.convConstraintEcho,         // 防止抢话和转述（默认关）
      constraintSublime: !!conv?.convConstraintSublime,   // 防止升华收束（默认关）
      constraintGodView: !!conv?.convConstraintGodView,   // 信息传播规则（默认关）
      constraintAbility: !!conv?.convConstraintAbility,   // 角色能力边界（默认关）
      constraintAutonomy: !!conv?.convConstraintAutonomy,  // 角色自主性·防围着玩家转（默认关）
      constraintTimeFlow: conv?.convConstraintTimeFlow !== false,  // 时间流逝感知（默认开）
      constraintGender: !!conv?.convConstraintGender,      // 去刻板表达（默认关）
    };
  }
  function _onVoiceEnabledChange() {
    const enabled = document.getElementById('cs-voice-enabled').checked;
    const opts = document.getElementById('cs-voice-options');
    if (opts) opts.style.display = enabled ? 'flex' : 'none';
  }

  // 骰点系统开关 v686
  async function _onDiceToggle(checkbox) {
  if (document.body.getAttribute('data-worldview') === '心动模拟') { checkbox.checked = false; UI.showToast('心动模拟世界观不支持骰子', 2000); return; }
  const cfg = document.getElementById('cs-dice-config');
    if (!checkbox.checked) {
      if (cfg) cfg.style.display = 'none';
      return;
    }
    // 启用前置检查
    const ok = await Dice.ensurePrerequisite();
    if (!ok) {
      checkbox.checked = false;
      if (cfg) cfg.style.display = 'none';
      return;
    }
    if (cfg) cfg.style.display = 'flex';
  }

  // v687.6：骰点配置弹窗
  const _DICE_RULE_OPTIONS = [
    { value: '<=', label: '结果 ≤ 属性值 = 成功（默认）' },
    { value: '<',  label: '结果 < 属性值 = 成功' },
    { value: '>=', label: '结果 ≥ 属性值 = 成功' },
    { value: '>',  label: '结果 > 属性值 = 成功' },
  ];

  function _renderDiceRuleDropdown(currentValue) {
    const dd = document.getElementById('dice-cfg-rule-dropdown');
    if (!dd) return;
    dd.innerHTML = _DICE_RULE_OPTIONS.map(o => `
      <div class="custom-dropdown-item${o.value === currentValue ? ' active' : ''}" data-rule="${o.value}" style="font-size:13px">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${o.label}</span>
      </div>
    `).join('');
    dd.querySelectorAll('.custom-dropdown-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const v = el.getAttribute('data-rule');
        _selectDiceRule(v);
        dd.classList.add('hidden');
      });
    });
  }

  function _selectDiceRule(value) {
    const opt = _DICE_RULE_OPTIONS.find(o => o.value === value) || _DICE_RULE_OPTIONS[0];
    const lbl = document.getElementById('dice-cfg-rule-label');
    if (lbl) lbl.textContent = opt.label;
    const btn = document.getElementById('dice-cfg-rule-btn');
    if (btn) btn.dataset.value = opt.value;
    // 同步高亮
    document.querySelectorAll('#dice-cfg-rule-dropdown .custom-dropdown-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-rule') === opt.value);
    });
  }

  function _toggleDiceRuleDropdown() {
    const dd = document.getElementById('dice-cfg-rule-dropdown');
    if (!dd) return;
    dd.classList.toggle('hidden');
  }

  function _openDiceConfigModal() {
    const modal = document.getElementById('dice-config-modal');
    if (!modal) return;
    // 从隐藏 input 读当前值
    const curMax = parseInt(document.getElementById('cs-dice-max')?.value) || 100;
    const curRule = document.getElementById('cs-dice-rule')?.value || '<=';
    const maxEl = document.getElementById('dice-cfg-max');
    if (maxEl) maxEl.value = curMax;
    _renderDiceRuleDropdown(curRule);
    _selectDiceRule(curRule);
    // 关下拉
    document.getElementById('dice-cfg-rule-dropdown')?.classList.add('hidden');
    modal.classList.remove('hidden');
    // 点遮罩关闭
    modal.onclick = (e) => {
      if (e.target === modal) _closeDiceConfigModal();
      // 点弹窗内非下拉区时关下拉
      if (!e.target.closest('#dice-cfg-rule-dropdown') && !e.target.closest('#dice-cfg-rule-btn')) {
        document.getElementById('dice-cfg-rule-dropdown')?.classList.add('hidden');
      }
    };
  }

  function _closeDiceConfigModal() {
    const modal = document.getElementById('dice-config-modal');
    if (modal) modal.classList.add('hidden');
  }

  // ===== v687.23：MCP 服务器 UI 管理 =====
  let _editingMcpId = null;

  function _renderMcpList() {
    const wrap = document.getElementById('cs-mcp-list');
    if (!wrap) return;
    if (typeof MCPClient === 'undefined') {
      wrap.innerHTML = '<div style="font-size:11px;color:var(--text-secondary);padding:8px">MCP 客户端未加载</div>';
      return;
    }
    const servers = MCPClient.getServers();
    if (!servers.length) {
      wrap.innerHTML = '<div style="font-size:11px;color:var(--text-secondary);padding:10px;text-align:center;background:var(--bg);border:1px dashed var(--border);border-radius:6px">还没有 MCP 服务器，点 + 添加</div>';
      return;
    }
    wrap.innerHTML = servers.map(s => {
      const toolCount = Array.isArray(s.tools) ? s.tools.length : 0;
      const enabled = !!s.enabled;
      const safeName = Utils.escapeHtml(s.name || s.url || '未命名');
      const safeUrl = Utils.escapeHtml(s.url || '');
      const transportLabel = (s.transport || 'http').toUpperCase();
      return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--text);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safeName}</div>
            <div style="font-size:10px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${transportLabel} · ${safeUrl}</div>
          </div>
          <label style="position:relative;display:inline-flex;flex-shrink:0">
            <input type="checkbox" class="circle-check" ${enabled ? 'checked' : ''} onchange="Chat._toggleMcpServer('${s.id}', this.checked)">
            <span class="circle-check-ui"></span>
          </label>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
          <div style="font-size:11px;color:var(--text-secondary)">${toolCount} 个工具</div>
          <div style="display:flex;gap:6px">
            <button type="button" onclick="Chat._rediscoverMcpServer('${s.id}')" style="padding:3px 8px;background:none;border:1px solid var(--border);color:var(--text-secondary);border-radius:4px;font-size:11px;cursor:pointer">刷新</button>
            <button type="button" onclick="Chat._removeMcpServer('${s.id}')" style="padding:3px 8px;background:none;border:1px solid var(--border);color:var(--danger);border-radius:4px;font-size:11px;cursor:pointer">删除</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function _openMcpAddModal(id) {
    _editingMcpId = id || null;
    const modal = document.getElementById('mcp-server-modal');
    const titleEl = document.getElementById('mcp-modal-title');
    const nameEl = document.getElementById('mcp-server-name');
    const urlEl = document.getElementById('mcp-server-url');
    const authTypeEl = document.getElementById('mcp-server-auth-type');
    const authHeaderEl = document.getElementById('mcp-server-auth-header');
    const authTokenEl = document.getElementById('mcp-server-auth-token');
    const errEl = document.getElementById('mcp-modal-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (id) {
      const s = MCPClient.getServers().find(x => x.id === id);
      if (s) {
        titleEl.textContent = '编辑 MCP 服务器';
        nameEl.value = s.name || '';
        urlEl.value = s.url || '';
        const at = s.auth?.type || 'none';
        authTypeEl.value = at;
        authHeaderEl.value = s.auth?.headerName || '';
        authTokenEl.value = s.auth?.token || '';
      }
    } else {
      titleEl.textContent = '添加 MCP 服务器';
      nameEl.value = '';
      urlEl.value = '';
      authTypeEl.value = 'none';
      authHeaderEl.value = '';
      authTokenEl.value = '';
    }
    _onMcpAuthTypeChange();
    modal.classList.remove('hidden');
  }

  function _closeMcpAddModal() {
    document.getElementById('mcp-server-modal')?.classList.add('hidden');
    _editingMcpId = null;
  }

  function _onMcpAuthTypeChange() {
    const t = document.getElementById('mcp-server-auth-type')?.value || 'none';
    const headerEl = document.getElementById('mcp-server-auth-header');
    const tokenEl = document.getElementById('mcp-server-auth-token');
    if (!headerEl || !tokenEl) return;
    if (t === 'none') {
      headerEl.style.display = 'none';
      tokenEl.style.display = 'none';
    } else if (t === 'bearer') {
      headerEl.style.display = 'none';
      tokenEl.style.display = 'block';
      tokenEl.placeholder = 'Bearer Token';
    } else if (t === 'header') {
      headerEl.style.display = 'block';
      tokenEl.style.display = 'block';
      tokenEl.placeholder = 'Token / API Key';
    }
  }

  async function _saveMcpServer() {
    const name = document.getElementById('mcp-server-name').value.trim();
    const url = document.getElementById('mcp-server-url').value.trim();
    const authType = document.getElementById('mcp-server-auth-type').value;
    const authHeader = document.getElementById('mcp-server-auth-header').value.trim();
    const authToken = document.getElementById('mcp-server-auth-token').value.trim();
    const errEl = document.getElementById('mcp-modal-error');
    const saveBtn = document.getElementById('mcp-modal-save-btn');
    const showErr = (msg) => {
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    };
    if (!name) { showErr('请填写显示名称'); return; }
    if (!url || !/^https?:\/\//i.test(url)) { showErr('请填写合法的 HTTP/HTTPS URL'); return; }
    if (authType === 'bearer' && !authToken) { showErr('Bearer 模式需要填写 Token'); return; }
    if (authType === 'header' && (!authHeader || !authToken)) { showErr('自定义 Header 模式需要 Header 名 和 Token'); return; }

    // transport 自动判断：URL 含 /sse 视为 SSE，否则 HTTP（实际两者请求方式相同，差别只在响应解析）
    const transport = /\/sse(\?|\/|$)|\.sse(\?|\/|$)/i.test(url) ? 'sse' : 'http';
    const auth = authType === 'none' ? null : { type: authType, token: authToken, headerName: authHeader };

    const isEdit = !!_editingMcpId;
    const id = _editingMcpId || ('mcp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const server = { id, name, url, transport, enabled: true, auth, tools: [] };

    // 保存先（即使 discover 失败，配置也留下）
    if (isEdit) {
      MCPClient.updateServer(id, { name, url, transport, auth });
    } else {
      MCPClient.addServer(server);
    }

    // 拉一次工具列表
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '连接中...'; }
    try {
      const cur = MCPClient.getServers().find(s => s.id === id);
      const tools = await MCPClient.discoverTools(cur);
      UI.showToast(`已连接 · 发现 ${tools.length} 个工具`, 1800);
      _closeMcpAddModal();
      _renderMcpList();
    } catch(e) {
      showErr('连接失败：' + (e?.message || e));
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '连接并保存'; }
    }
  }

  function _toggleMcpServer(id, enabled) {
    MCPClient.updateServer(id, { enabled: !!enabled });
  }

  function _removeMcpServer(id) {
    const s = MCPClient.getServers().find(x => x.id === id);
    if (!s) return;
    if (!confirm(`删除 MCP 服务器「${s.name || s.url}」？`)) return;
    MCPClient.removeServer(id);
    _renderMcpList();
  }

  async function _rediscoverMcpServer(id) {
    const s = MCPClient.getServers().find(x => x.id === id);
    if (!s) return;
    UI.showToast('刷新中...', 1200);
    try {
      const tools = await MCPClient.discoverTools(s);
      UI.showToast(`已刷新 · ${tools.length} 个工具`, 1800);
      _renderMcpList();
    } catch(e) {
      UI.showToast('刷新失败：' + (e?.message || e), 2500);
    }
  }

  function _saveDiceConfigModal() {
    const maxEl = document.getElementById('dice-cfg-max');
    const ruleBtn = document.getElementById('dice-cfg-rule-btn');
    const n = parseInt(maxEl?.value);
    const newMax = (Number.isFinite(n) && n >= 2) ? n : 100;
    const newRule = (ruleBtn?.dataset.value && ['<','<=','>','>='].includes(ruleBtn.dataset.value)) ? ruleBtn.dataset.value : '<=';
    // 写回隐藏 input（saveConvSettings 会读这两个）
    const hMax = document.getElementById('cs-dice-max');
    const hRule = document.getElementById('cs-dice-rule');
    if (hMax) hMax.value = newMax;
    if (hRule) hRule.value = newRule;
    _closeDiceConfigModal();
    UI.showToast(`骰子配置：1d${newMax} · ${newRule}`, 1500);
  }

  // 刷新聊天输入区🎲按钮 + 历史气泡
  function _refreshDiceUI() {
    try {
      const btn = document.getElementById('btn-dice');
      const enabled = !!(Dice && Dice.isEnabled && Dice.isEnabled());
      if (btn) btn.style.display = enabled ? 'inline-flex' : 'none';
      if (enabled && Dice.renderHistoryBubbles) Dice.renderHistoryBubbles();
    } catch(_) {}
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
  async function _onConvBgPicked() {
    const dataUrl = await Utils.promptImageInput({ maxSize: 1200, quality: 0.7 });
    if (!dataUrl) return;
    if (typeof dataUrl === 'string' && dataUrl.length > 2_000_000) {
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

  function _switchCsTab(tab) {
    // v687.17：4 tab — output / gameplay / aware / tools
    const TABS = ['output', 'gameplay', 'aware', 'tools'];
    TABS.forEach(t => {
      const panel = document.getElementById('cs-tab-' + t);
      if (panel) panel.style.display = (t === tab) ? 'flex' : 'none';
    });
    document.querySelectorAll('.cs-tab').forEach(btn => {
      const isActive = btn.dataset.csTab === tab;
      btn.style.borderBottomColor = isActive ? 'var(--accent)' : 'transparent';
      btn.style.color = isActive ? 'var(--accent)' : 'var(--text-secondary)';
    });
  }

  function openConvSettingsModal() {
    // v687.17：从 modal 改为 panel 全屏
    UI.showPanel('conv-settings');
    _switchCsTab('output'); // 默认显示输出 tab
    // v687.23：渲染 MCP 列表
    try { _renderMcpList(); } catch(_) {}
    const s = _getConvSettings();
    document.getElementById('cs-stream').checked = s.stream;
    document.getElementById('cs-gamemode').checked = s.gameMode;
document.getElementById('cs-format').checked = s.format;
      const suggestEnEl = document.getElementById('cs-suggest-enabled');
      if (suggestEnEl) suggestEnEl.checked = s.suggestEnabled;
      const shhEl = document.getElementById('cs-strip-history-html');
      if (shhEl) shhEl.checked = s.stripHistoryHtml;
      const shktEl = document.getElementById('cs-strip-html-keeptext');
      if (shktEl) shktEl.checked = s.stripHtmlKeepText;
      const dr = document.getElementById('cs-disable-retry');
    if (dr) dr.checked = s.disableRetry;
    document.getElementById('cs-backstage').checked = s.backstage;
    const ta = document.getElementById('cs-time-aware');
    if (ta) ta.checked = s.timeAware;
    // 气泡时间戳模式（全局开关）同步高亮
    try { _syncBubbleTimeModeUI(); } catch(_) {}
    // v687.14：电量/天气感知
    const ba = document.getElementById('cs-battery-aware');
    if (ba) ba.checked = s.batteryAware;
    const wa = document.getElementById('cs-weather-aware');
    if (wa) wa.checked = s.weatherAware;
    const wc = document.getElementById('cs-weather-city');
    if (wc && window.EnvAwareness) wc.value = EnvAwareness.getCity();
    // 环境音设置回填
    try {
      const conv = Conversations.getList()?.find(c => c.id === Conversations.getCurrent());
      const ambEl = document.getElementById('cs-ambient-enabled');
      if (ambEl) ambEl.checked = !!conv?.convAmbientEnabled;
      const ambVolEl = document.getElementById('cs-ambient-volume');
      if (ambVolEl) { ambVolEl.value = conv?.convAmbientVolume ?? 50; }
      const ambVolLabel = document.getElementById('cs-ambient-volume-label');
      if (ambVolLabel) ambVolLabel.textContent = (conv?.convAmbientVolume ?? 50) + '%';
      const ambModeEl = document.getElementById('cs-ambient-mode');
    if (ambModeEl) {
      ambModeEl.value = conv?.convAmbientMode || 'loop';
      const ambModeLabel = document.getElementById('cs-ambient-mode-label');
      if (ambModeLabel) ambModeLabel.textContent = ambModeEl.value === 'short' ? '触发短播（20-30秒）' : '持续循环';
    }
    } catch(_) {}
    const oc = document.getElementById('cs-online-chat');
    if (oc) oc.checked = s.onlineChat;
    const evEnabled = document.getElementById('cs-events-enabled');
    if (evEnabled) evEnabled.checked = s.eventsEnabled;
    const tsEnabled = document.getElementById('cs-tasks-enabled');
    if (tsEnabled) tsEnabled.checked = s.tasksEnabled;
    const attrsEn = document.getElementById('cs-attrs-enabled');
    if (attrsEn) attrsEn.checked = s.attrsEnabled;
    const kbEn = document.getElementById('cs-knowledge-enabled');
    if (kbEn) kbEn.checked = s.knowledgeEnabled;
    // 骰点系统 v686
    try {
      const dEn = document.getElementById('cs-dice-enabled');
      const dCfg = document.getElementById('cs-dice-config');
      const dMax = document.getElementById('cs-dice-max');
      const dRule = document.getElementById('cs-dice-rule');
      const dconv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
      if (dEn) dEn.checked = !!(dconv && dconv.diceEnabled);
      if (dCfg) dCfg.style.display = (dconv && dconv.diceEnabled) ? 'flex' : 'none';
      if (dMax) dMax.value = (dconv && Number.isFinite(+dconv.diceMax) && +dconv.diceMax > 0) ? +dconv.diceMax : 100;
      if (dRule) dRule.value = (dconv && ['<','<=','>','>='].includes(dconv.diceRule)) ? dconv.diceRule : '<=';
    } catch(_) {}
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
    // 生图模式
    const igEl = document.getElementById('cs-imggen');
    if (igEl) igEl.checked = s.imgGen;
    // 来电能力
    const callEl = document.getElementById('cs-call-enabled');
    if (callEl) callEl.checked = s.callEnabled;
    _syncCallFreqUI(s.callFreq || 'normal');
    // 主线群聊
    const gcEl = document.getElementById('cs-groupchat-enabled');
    if (gcEl) gcEl.checked = s.groupChatEnabled;
  _syncNarrPersonUI(s.narrPerson || 'second');
    // 工具调用
    const toolsMemEl = document.getElementById('cs-tools-memory');
    if (toolsMemEl) toolsMemEl.checked = s.toolsMemory;
    const toolsWvEl = document.getElementById('cs-tools-worldview');
    if (toolsWvEl) toolsWvEl.checked = s.toolsWorldview;
  const toolsEditEl = document.getElementById('cs-tools-edit');
  if (toolsEditEl) toolsEditEl.checked = s.toolsEdit;
  const toolsHistEl = document.getElementById('cs-tools-history');
    if (toolsHistEl) toolsHistEl.checked = s.toolsHistory;
    // 自动记忆提取
    const aeEl = document.getElementById('cs-auto-extract');
    if (aeEl) aeEl.checked = s.autoExtract;
    // 正文字数
    const wcOpenEl = document.getElementById('cs-reply-wordcount');
    if (wcOpenEl) wcOpenEl.value = s.replyWordCount || 800;
    const tfEl = document.getElementById('cs-time-format');
    if (tfEl) {
      tfEl.value = s.timeFormat || 'delta';
      const label = document.getElementById('cs-time-format-label');
      if (label) label.textContent = s.timeFormat === 'absolute' ? '绝对时间（完整日期时间）' : '增量（+1h20min，系统累加）';
    }
    // v687.34：AI行为约束
    const ceEl = document.getElementById('cs-constraint-echo');
    if (ceEl) ceEl.checked = s.constraintEcho;
    const csEl = document.getElementById('cs-constraint-sublime');
    if (csEl) csEl.checked = s.constraintSublime;
    const cgEl = document.getElementById('cs-constraint-godview');
    if (cgEl) cgEl.checked = s.constraintGodView;
    const caEl = document.getElementById('cs-constraint-ability');
    if (caEl) caEl.checked = s.constraintAbility;
    const cauEl = document.getElementById('cs-constraint-autonomy');
    if (cauEl) cauEl.checked = s.constraintAutonomy;
    const ctEl = document.getElementById('cs-constraint-timeflow');
    if (ctEl) ctEl.checked = s.constraintTimeFlow;
    const cgenEl = document.getElementById('cs-constraint-gender');
    if (cgenEl) cgenEl.checked = s.constraintGender;
    document.getElementById('conv-settings-modal').classList.remove('hidden');
  }

  async function saveConvSettings() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) return;
    conv.convStream = document.getElementById('cs-stream').checked;
    conv.convGameMode = document.getElementById('cs-gamemode').checked;
conv.convFormat = document.getElementById('cs-format').checked;
    const suggestSaveEl = document.getElementById('cs-suggest-enabled');
    if (suggestSaveEl) conv.convSuggestEnabled = suggestSaveEl.checked;
      const shhSaveEl = document.getElementById('cs-strip-history-html');
      if (shhSaveEl) conv.convStripHistoryHtml = shhSaveEl.checked;
      const shktSaveEl = document.getElementById('cs-strip-html-keeptext');
      if (shktSaveEl) conv.convStripHtmlKeepText = shktSaveEl.checked;
      const drEl = document.getElementById('cs-disable-retry');
    if (drEl) {
      conv.convDisableRetry = !!drEl.checked;
      try { localStorage.setItem('skynex_lastDisableRetry', drEl.checked ? '1' : '0'); } catch(_) {}
    }
    const wasBackstage = !!conv.backstageEnabled;
    conv.backstageEnabled = document.getElementById('cs-backstage').checked;
const taEl = document.getElementById('cs-time-aware');
      if (taEl) conv.convTimeAware = taEl.checked;
      // v687.14：电量/天气感知
      const baEl = document.getElementById('cs-battery-aware');
      if (baEl) conv.convBatteryAware = baEl.checked;
      const waEl = document.getElementById('cs-weather-aware');
      if (waEl) conv.convWeatherAware = waEl.checked;
      const wcityEl = document.getElementById('cs-weather-city');
if (wcityEl && window.EnvAwareness) EnvAwareness.setCity(wcityEl.value);
    // 环境音设置保存
    const ambEnabledEl = document.getElementById('cs-ambient-enabled');
    if (ambEnabledEl) conv.convAmbientEnabled = ambEnabledEl.checked;
    const ambVolumeEl = document.getElementById('cs-ambient-volume');
    if (ambVolumeEl) conv.convAmbientVolume = parseInt(ambVolumeEl.value, 10) || 50;
    const ambModeEl = document.getElementById('cs-ambient-mode');
    if (ambModeEl) conv.convAmbientMode = ambModeEl.value;
    const ocEl = document.getElementById('cs-online-chat');
    if (ocEl) conv.convOnlineChat = ocEl.checked;
    const igSaveEl = document.getElementById('cs-imggen');
    if (igSaveEl) conv.convImgGen = igSaveEl.checked;
    const callSaveEl = document.getElementById('cs-call-enabled');
    if (callSaveEl) conv.convCallEnabled = callSaveEl.checked;
    const callFreqSaveEl = document.getElementById('cs-call-freq-btn');
    if (callFreqSaveEl) conv.convCallFreq = callFreqSaveEl.dataset.value || 'normal';
    const gcSaveEl = document.getElementById('cs-groupchat-enabled');
    if (gcSaveEl) conv.convGroupChatEnabled = gcSaveEl.checked;
  const narrPersonSaveEl = document.getElementById('cs-narr-person-btn');
  if (narrPersonSaveEl) conv.convNarrPerson = narrPersonSaveEl.dataset.value || 'second';
    const toolsMemSaveEl = document.getElementById('cs-tools-memory');
    if (toolsMemSaveEl) conv.convToolsMemory = toolsMemSaveEl.checked;
    const toolsWvSaveEl = document.getElementById('cs-tools-worldview');
    if (toolsWvSaveEl) conv.convToolsWorldview = toolsWvSaveEl.checked;
  const toolsEditSaveEl = document.getElementById('cs-tools-edit');
  if (toolsEditSaveEl) conv.convToolsEdit = toolsEditSaveEl.checked;
  const toolsHistSaveEl = document.getElementById('cs-tools-history');
    if (toolsHistSaveEl) conv.convToolsHistory = toolsHistSaveEl.checked;
    const aeSaveEl = document.getElementById('cs-auto-extract');
    if (aeSaveEl) conv.convAutoExtract = aeSaveEl.checked;
    const evEl = document.getElementById('cs-events-enabled');
    if (evEl) conv.convEventsEnabled = evEl.checked;
    const tsEl = document.getElementById('cs-tasks-enabled');
    if (tsEl) conv.convTasksEnabled = tsEl.checked;
    const attrsSaveEl = document.getElementById('cs-attrs-enabled');
    if (attrsSaveEl) conv.convAttrsEnabled = attrsSaveEl.checked;
    const kbSaveEl = document.getElementById('cs-knowledge-enabled');
    if (kbSaveEl) conv.convKnowledgeEnabled = kbSaveEl.checked;
    // 骰点系统 v686
    try {
      const dEn = document.getElementById('cs-dice-enabled');
      const dMax = document.getElementById('cs-dice-max');
      const dRule = document.getElementById('cs-dice-rule');
      if (dEn) conv.diceEnabled = !!dEn.checked;
      if (dMax) {
        const n = parseInt(dMax.value);
        conv.diceMax = (Number.isFinite(n) && n >= 2) ? n : 100;
      }
      if (dRule && ['<','<=','>','>='].includes(dRule.value)) conv.diceRule = dRule.value;
      if (!Array.isArray(conv.diceRolls)) conv.diceRolls = [];
    } catch(_) {}
    // 正文字数
    const wcEl = document.getElementById('cs-reply-wordcount');
    if (wcEl) conv.convReplyWordCount = parseInt(wcEl.value) || 800;
    const tfSaveEl = document.getElementById('cs-time-format');
    if (tfSaveEl) conv.convTimeFormat = (tfSaveEl.value === 'absolute') ? 'absolute' : 'delta';
    // v687.34：AI行为约束
    const ceSaveEl = document.getElementById('cs-constraint-echo');
    if (ceSaveEl) conv.convConstraintEcho = ceSaveEl.checked;
    const csSaveEl = document.getElementById('cs-constraint-sublime');
    if (csSaveEl) conv.convConstraintSublime = csSaveEl.checked;
    const cgSaveEl = document.getElementById('cs-constraint-godview');
    if (cgSaveEl) conv.convConstraintGodView = cgSaveEl.checked;
    const caSaveEl = document.getElementById('cs-constraint-ability');
    if (caSaveEl) conv.convConstraintAbility = caSaveEl.checked;
    const cauSaveEl = document.getElementById('cs-constraint-autonomy');
    if (cauSaveEl) conv.convConstraintAutonomy = cauSaveEl.checked;
    const ctSaveEl = document.getElementById('cs-constraint-timeflow');
    if (ctSaveEl) conv.convConstraintTimeFlow = ctSaveEl.checked;
    const cgenSaveEl = document.getElementById('cs-constraint-gender');
    if (cgenSaveEl) conv.convConstraintGender = cgenSaveEl.checked;
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
    // v705.4：保存后留在设置页，方便继续调整；不再自动退回聊天
    // 更新加号菜单里的生图按钮可见性
    _updateImgGenButtons();
    // 更新回复建议灯泡按钮可见性
    _updateSuggestBtn();
    // v687.6：保存后立刻刷新 🎲 按钮 + 历史气泡，无需切换对话
    try { _refreshDiceUI(); } catch(_) {}
    // 更新后台悬浮按钮
    if (typeof Backstage !== 'undefined') Backstage.updateFab();
    // 如果刚开启后台，退回聊天并弹出要求编辑面板（后台引导需要离开设置页）
    if (!wasBackstage && conv.backstageEnabled && typeof Backstage !== 'undefined') {
      closeConvSettingsModal();
      Backstage.openPromptEdit();
    }
    UI.showToast('对话设置已保存');
  }

  function closeConvSettingsModal() {
    // v687.17：从 modal 改为 panel —— 退回聊天
    UI.showPanel('chat', 'back');
  }

  // ===== 剧情引导 =====

  function openDirectiveModal() {
    const s = _getConvSettings();
    const contentEl = document.getElementById('directive-content');
    const roundsEl = document.getElementById('directive-rounds');
    const statusEl = document.getElementById('directive-status');
    if (contentEl) contentEl.value = s.directive;
    if (roundsEl) roundsEl.value = s.directiveRemaining || s.directiveTotal || 3;
    // 状态提示
    if (statusEl) {
      if (s.directive && s.directiveRemaining > 0) {
        statusEl.style.display = 'block';
        statusEl.textContent = `当前生效中 · 剩余 ${s.directiveRemaining}/${s.directiveTotal} 轮`;
      } else {
        statusEl.style.display = 'none';
      }
    }
    document.getElementById('directive-modal')?.classList.remove('hidden');
  }

  function closeDirectiveModal() {
    document.getElementById('directive-modal')?.classList.add('hidden');
  }

  async function saveDirective() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) return;
    const content = document.getElementById('directive-content')?.value?.trim() || '';
    const rounds = Math.max(1, Math.min(50, parseInt(document.getElementById('directive-rounds')?.value) || 3));
    if (!content) {
      UI.showToast('请输入引导内容', 2000);
      return;
    }
    conv.convDirective = content;
    conv.convDirectiveRemaining = rounds;
    conv.convDirectiveTotal = rounds;
    await Conversations.saveList();
    closeDirectiveModal();
    UI.showToast('剧情引导已设置（' + rounds + '轮）', 2000);
  }

  async function clearDirective() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) return;
    conv.convDirective = '';
    conv.convDirectiveRemaining = 0;
    conv.convDirectiveTotal = 0;
    await Conversations.saveList();
    closeDirectiveModal();
    UI.showToast('剧情引导已清空', 1500);
  }

  /** 构建剧情引导注入文本（每轮发消息时调用） */
  function _buildDirectiveInjection() {
    const s = _getConvSettings();
    if (!s.directive || s.directiveRemaining <= 0) return '';
    return `[剧情引导·剩余${s.directiveRemaining}轮]\n接下来的剧情请自然地朝以下方向过渡。\n如果转变较大，不需要一轮就彻底完成转变——可以用多轮逐步推进。\n转折需要逻辑自洽，并且符合角色设定和世界观设定。不要生硬转折。\n\n${s.directive}`;
  }

  /** 每轮发送后递减剩余轮数 */
  async function _decrementDirective() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv || !conv.convDirective || !conv.convDirectiveRemaining) return;
    conv.convDirectiveRemaining--;
    if (conv.convDirectiveRemaining <= 0) {
      conv.convDirective = '';
      conv.convDirectiveRemaining = 0;
      conv.convDirectiveTotal = 0;
    }
    await Conversations.saveList();
  }

  async function _getCurrentWorldviewForEvents() {
    try {
      const singleSettings = (typeof SingleMode !== 'undefined') ? SingleMode.getCurrentSingleSettings() : null;
      if (singleSettings && singleSettings.worldviewId) return await DB.get('worldviews', singleSettings.worldviewId);
      if (typeof Worldview !== 'undefined' && Worldview.getCurrent) return await Worldview.getCurrent();
    } catch(_) {}
    return null;
  }

  function _eventStateLabel(state) {
    if (state === 'active') return { text: '进行中', color: 'var(--accent)' };
    if (state === 'done') return { text: '已完成', color: 'var(--text-secondary)' };
    return { text: '待触发', color: 'var(--text-secondary)' };
  }

  let _evmTab = 'standalone';
  let _evmEvents = [];

  async function openEventManagerModal() {
    const listEl = document.getElementById('event-manager-list');
    if (!listEl) return;
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const wv = await _getCurrentWorldviewForEvents();
    // 优先用对话级事件（与运行时注入逻辑一致：conv.convEvents || wv.events）
    const events = ((conv?.convEvents && conv.convEvents.length) ? conv.convEvents : (wv?.events || [])).slice();
    try {
      const singleSettings = (typeof SingleMode !== 'undefined') ? SingleMode.getCurrentSingleSettings() : null;
if (singleSettings && singleSettings.charType === 'card' && singleSettings.charId) {
const hidden = await _getCardLorebooksMerged(singleSettings?.charId, conv);
if (hidden?.events?.length) events.push(...hidden.events);
}
    } catch(_) {}
    if (!conv) return;
    conv.eventStates = conv.eventStates || {};
    _evmEvents = events;
    _evmTab = 'standalone';
    switchEventManagerTab('standalone');
    document.getElementById('event-manager-modal')?.classList.remove('hidden');
  }

  function switchEventManagerTab(tab) {
    _evmTab = tab === 'chain' ? 'chain' : 'standalone';
    const sBtn = document.getElementById('evm-tab-standalone');
    const cBtn = document.getElementById('evm-tab-chain');
    if (sBtn) { sBtn.style.background = _evmTab === 'standalone' ? 'var(--accent)' : 'transparent'; sBtn.style.color = _evmTab === 'standalone' ? '#111' : 'var(--text-secondary)'; }
    if (cBtn) { cBtn.style.background = _evmTab === 'chain' ? 'var(--accent)' : 'transparent'; cBtn.style.color = _evmTab === 'chain' ? '#111' : 'var(--text-secondary)'; }
    _renderEventManager();
  }

  function _eventManagerCardHtml(ev, conv) {
    const state = conv.eventStates[ev.id] || 'locked';
    const label = _eventStateLabel(state);
    const canReset = state === 'active' || state === 'done';
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px">
      <div style="min-width:0;flex:1">
        <div style="font-size:14px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(ev.name || '未命名事件')}</div>
        <div style="font-size:11px;color:${label.color};margin-top:4px">${label.text}</div>
      </div>
      ${canReset ? `<button type="button" onclick="Chat.resetEventState('${ev.id}')" style="padding:6px 10px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);font-size:12px;cursor:pointer;white-space:nowrap">重置</button>` : ''}
    </div>`;
  }

  function _renderEventManager() {
    const listEl = document.getElementById('event-manager-list');
    if (!listEl) return;
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) return;
    conv.eventStates = conv.eventStates || {};
    const events = _evmEvents || [];

    if (_evmTab === 'chain') {
      const chainEvents = events.filter(ev => ev && ev.chainId);
      if (!chainEvents.length) {
        listEl.innerHTML = '<div style="font-size:13px;color:var(--text-secondary);padding:12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px">当前没有事件链。</div>';
        return;
      }
      const groups = {};
      chainEvents.forEach(ev => {
        const id = ev.chainId;
        if (!groups[id]) groups[id] = { name: ev.chainName || '未命名事件链', events: [] };
        groups[id].events.push(ev);
      });
      listEl.innerHTML = Object.keys(groups).map(cid => {
        const g = groups[cid];
        g.events.sort((a, b) => Number(a.chainIndex || 0) - Number(b.chainIndex || 0));
        const doneCount = g.events.filter(ev => (conv.eventStates[ev.id] || 'locked') === 'done').length;
        const cards = g.events.map((ev, i) => {
          const node = `<div style="display:flex;align-items:center;gap:6px;margin:6px 0 2px;font-size:11px;color:var(--text-secondary)">第 ${i + 1} 节</div>`;
          return node + _eventManagerCardHtml(ev, conv);
        }).join('');
        return `<div style="border:1px solid var(--border);border-radius:10px;padding:10px;background:var(--bg-secondary)">
          <div style="font-size:14px;font-weight:700;color:var(--accent);margin-bottom:2px">${Utils.escapeHtml(g.name)}</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">进度 ${doneCount}/${g.events.length}</div>
          ${cards}
        </div>`;
      }).join('');
      return;
    }

    const standalone = events.filter(ev => ev && !ev.chainId);
    if (!standalone.length) {
      listEl.innerHTML = '<div style="font-size:13px;color:var(--text-secondary);padding:12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px">当前没有独立事件。</div>';
      return;
    }
    listEl.innerHTML = standalone.map(ev => _eventManagerCardHtml(ev, conv)).join('');
  }

  function closeEventManagerModal() {
document.getElementById('event-manager-modal')?.classList.add('hidden');
}

// ========== v632 → v684：世界书管理（多来源） ==========
// 来源标签：
//   wv       — 世界观默认（wv.defaultLorebookIds），可禁用，不可解绑
//   card     — 单人卡自带（card.lorebookIds），可禁用，不可解绑
//   attached — 常驻角色（type=card 的 attachedChars 卡书），可禁用，不可解绑
//   conv     — 对话自由挂载（conv.lorebookIds），可禁用，可解绑
async function openLorebookDisableModal() {
  const listEl = document.getElementById('lorebook-disable-list');
  if (!listEl) return;
  const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
  if (!conv) {
    document.getElementById('lorebook-disable-modal')?.classList.remove('hidden');
    return;
  }

  // 收集各来源的 lb id
  const bySource = { wv: [], card: [], attached: [], conv: [] };

  // 1) 世界观默认
  try {
    const wvId = conv.worldviewId;
    if (wvId && wvId !== '__default_wv__') {
      const wv = await DB.get('worldviews', wvId);
      const ids = (wv && Array.isArray(wv.defaultLorebookIds)) ? wv.defaultLorebookIds : [];
      bySource.wv.push(...ids);
    }
  } catch(_) {}

  // 2) 单人卡自带
  try {
    if (conv.isSingle && conv.singleCharType === 'card' && conv.singleCharId) {
      const card = await SingleCard.get(conv.singleCharId);
      if (card && Array.isArray(card.lorebookIds)) bySource.card.push(...card.lorebookIds);
    }
  } catch(_) {}

  // 3) 常驻角色（type=card）自带
  try {
    const attachedList = Array.isArray(conv.attachedChars) ? conv.attachedChars : [];
    for (const e of attachedList) {
      if (!e || e.type !== 'card' || !e.id) continue;
      try {
        const ac = await SingleCard.get(e.id);
        if (ac && Array.isArray(ac.lorebookIds)) bySource.attached.push(...ac.lorebookIds);
      } catch(_) {}
    }
  } catch(_) {}

  // 4) 对话自由挂载
  if (Array.isArray(conv.lorebookIds)) bySource.conv.push(...conv.lorebookIds);

  // 去重（按优先顺序：wv → card → attached → conv，先出现的保留）
  const seen = new Set();
  const ordered = []; // [{id, source}]
  for (const src of ['wv', 'card', 'attached', 'conv']) {
    for (const id of bySource[src]) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ordered.push({ id, source: src });
    }
  }

  const disabled = new Set(conv.lorebookDisabled || []);
  const sourceLabel = {
    wv:       { text: '世界观默认', color: 'var(--accent)' },
    card:     { text: '单人卡',     color: 'var(--text-secondary)' },
    attached: { text: '常驻角色',   color: 'var(--text-secondary)' },
    conv:     { text: '本对话挂载', color: 'var(--accent)' },
  };

  const rows = [];
  for (const { id, source } of ordered) {
    let lb = null;
    try { lb = await Lorebook.get(id); } catch(_) {}
    if (!lb) continue;
    const enabled = !disabled.has(id);
    const safeId = Utils.escapeHtml(id);
    const safeName = Utils.escapeHtml(lb.name || '未命名世界书');
    const safeDesc = Utils.escapeHtml(lb.description || '');
    const tag = sourceLabel[source];
    const canUnbind = source === 'conv';
    rows.push(`
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px">
        <label style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer;margin:0">
          <span style="position:relative;display:inline-flex;flex-shrink:0">
            <input type="checkbox" class="circle-check" ${enabled ? 'checked' : ''} onchange="Chat.toggleLorebookDisable('${safeId}', this.checked)">
            <span class="circle-check-ui"></span>
          </span>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="font-size:14px;color:var(--text);font-weight:600">${safeName}</span>
              <span style="font-size:10px;color:${tag.color};border:1px solid ${tag.color};border-radius:4px;padding:1px 5px;line-height:1.4;white-space:nowrap">${tag.text}</span>
            </div>
            ${safeDesc ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeDesc}</div>` : ''}
          </div>
        </label>
        ${canUnbind ? `<button type="button" onclick="Chat.unbindConvLorebook('${safeId}')" title="从本对话移除（不影响单人卡）" style="background:none;border:1px solid var(--border);color:var(--text-secondary);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;flex-shrink:0;white-space:nowrap">移除</button>` : ''}
      </div>
    `);
  }

  listEl.innerHTML = rows.length
    ? rows.join('')
    : `<div style="text-align:center;color:var(--text-secondary);font-size:12px;padding:18px 0">当前对话还没有任何世界书。<br>点下方「+ 添加世界书」开始挂载。</div>`;
  document.getElementById('lorebook-disable-modal')?.classList.remove('hidden');
}

function closeLorebookDisableModal() {
  document.getElementById('lorebook-disable-modal')?.classList.add('hidden');
}

async function toggleLorebookDisable(lbId, enabled) {
  const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
  if (!conv) return;
  const set = new Set(conv.lorebookDisabled || []);
  if (enabled) {
    set.delete(lbId);
  } else {
    set.add(lbId);
  }
  conv.lorebookDisabled = Array.from(set);
  try { await Conversations.saveList(); } catch(_) {}
}

// v684：从对话自由挂载列表里移除
async function unbindConvLorebook(lbId) {
  const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
  if (!conv) return;
  conv.lorebookIds = (conv.lorebookIds || []).filter(x => x !== lbId);
  // 顺手把禁用记录也清掉（避免悬挂）
  conv.lorebookDisabled = (conv.lorebookDisabled || []).filter(x => x !== lbId);
  try { await Conversations.saveList(); } catch(_) {}
  await openLorebookDisableModal();
  UI.showToast('已从本对话移除', 1500);
}

// v684：弹出选择器，把勾选的 lb 加进 conv.lorebookIds（去重，不动来源是 wv/card/attached 的）
async function addConvLorebooks() {
  if (typeof LorebookUI === 'undefined' || !LorebookUI.openBindPicker) {
    UI.showToast('世界书 UI 未就绪', 1800);
    return;
  }
  const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
  if (!conv) return;
  // 已生效（来源为 wv/card/attached 的）+ 已自由挂载，作为初始勾选
  const ownedIds = new Set(conv.lorebookIds || []);
  await LorebookUI.openBindPicker(Array.from(ownedIds), async (next) => {
    conv.lorebookIds = Array.from(new Set(next || []));
    try { await Conversations.saveList(); } catch(_) {}
    await openLorebookDisableModal();
    UI.showToast('已更新挂载', 1200);
  });
}

// v684：把当前对话的"自由挂载列表"应用到本世界观全部对话
//   - 写入 wv.defaultLorebookIds（新建对话自动继承）
//   - 同步：把所有同 wv 的 conv.lorebookIds 重置为当前 conv 的 lorebookIds（粗暴覆盖）
async function applyLorebooksToWorldview() {
  const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
  if (!conv) return;
  const wvId = conv.worldviewId;
  if (!wvId || wvId === '__default_wv__') {
    UI.showToast('当前对话未绑定世界观，无法批量应用', 2000);
    return;
  }
  const myIds = (conv.lorebookIds || []).slice();
  const myDisabled = (conv.lorebookDisabled || []).slice();
  const wv = await DB.get('worldviews', wvId);
  if (!wv) {
    UI.showToast('找不到对应世界观', 1800);
    return;
  }
  const allConvs = Conversations.getList().filter(c => c.worldviewId === wvId);
  const otherCount = allConvs.length - 1;

  let msg = `将把当前对话的世界书配置应用到本世界观下的全部对话。\n\n`;
  msg += `· 自由挂载列表（${myIds.length} 本）将作为「新建对话默认」\n`;
  msg += `· 现有 ${otherCount} 个其它对话的自由挂载列表会被覆盖\n`;
  msg += `· 单人卡/常驻角色自带的世界书不受影响\n\n`;
  msg += `确定继续？`;
  const ok = await UI.showConfirm('应用到本世界观全部对话', msg);
  if (!ok) return;

  // 1) 写世界观默认
  wv.defaultLorebookIds = myIds.slice();
  wv.updated = Date.now();
  await DB.put('worldviews', wv);

  // 2) 同步所有同 wv 对话
  let touched = 0;
  for (const c of allConvs) {
    c.lorebookIds = myIds.slice();
    // 禁用记录也对齐（避免某本被禁但同步过去后没禁的不一致）
    c.lorebookDisabled = myDisabled.slice();
    touched++;
  }
  try { await Conversations.saveList(); } catch(_) {}
  UI.showToast(`已应用到 ${touched} 个对话`, 2000);
  await openLorebookDisableModal();
}
// ========== 世界书管理 end ==========

  async function resetEventState(eventId) {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) return;
    if (!await UI.showConfirm('重置事件', '将把该事件在当前对话中的状态重置为待触发。确定？')) return;
    conv.eventStates = conv.eventStates || {};
    delete conv.eventStates[eventId];
    await Conversations.saveList();
    await openEventManagerModal();
    UI.showToast('事件已重置');
  }

  // 恢复世界观默认（清除对话级配置）
  async function resetConvGameplay() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) return;
    if (!conv.convGameplay && !conv.convEvents) {
      UI.showToast('当前对话未使用对话级配置', 1800);
      return;
    }
    if (!await UI.showConfirm('恢复世界观默认', '将清除当前对话的自定义配置（属性/任务/事件），恢复使用世界观原件。\n不可撤销，确定继续？')) return;
    delete conv.convGameplay;
    delete conv.convEvents;
    await Conversations.saveList();
    UI.showToast('已恢复世界观默认配置', 1500);
    if (typeof StatusBar !== 'undefined') StatusBar.refreshFromConv();
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

  // ===== 生图模式 =====

  // 把 base64 dataURL 存入 drawnImages 表，返回引用ID
  async function _saveDrawnImage(dataUrl, prompt) {
    const id = 'img_' + Utils.uuid();
    await DB.put('drawnImages', {
      id,
      dataUrl,
      prompt: prompt || '',
      createdAt: Date.now()
    });
    return id;
  }

  // 下载图片到本地（手机一般会进相册的 Download 目录）
  async function downloadImage(imgId) {
    try {
      const rec = await DB.get('drawnImages', imgId);
      if (!rec || !rec.dataUrl) {
        UI.showToast('图片已丢失', 1500);
        return;
      }
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
      UI.showToast('保存失败: ' + e.message, 2000);
    }
  }

  // 弹出图片放大查看 + 详情
  async function openImageLightbox(imgId) {
    try {
      const rec = await DB.get('drawnImages', imgId);
      if (!rec || !rec.dataUrl) { UI.showToast('图片已丢失', 1500); return; }
      let modal = document.getElementById('tsimg-lightbox');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'tsimg-lightbox';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
        modal.addEventListener('click', (ev) => {
          if (ev.target === modal) modal.remove();
        });
        document.body.appendChild(modal);
      }
      const ts = new Date(rec.createdAt || Date.now());
      const pad = n => String(n).padStart(2, '0');
      const tsStr = `${ts.getFullYear()}.${pad(ts.getMonth()+1)}.${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
      modal.innerHTML = `
        <button type="button" id="tsimg-lightbox-close" style="position:absolute;top:12px;right:12px;width:36px;height:36px;border-radius:50%;border:none;background:rgba(255,255,255,0.15);color:#fff;cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center;z-index:1">×</button>
        <div style="flex:1;display:flex;align-items:center;justify-content:center;width:100%;overflow:auto">
          <img src="${rec.dataUrl}" style="max-width:100%;max-height:100%;border-radius:8px">
        </div>
        <div style="width:100%;max-width:600px;margin-top:12px;color:#ddd;font-size:12px;display:flex;flex-direction:column;gap:6px">
          <div style="opacity:0.6">${tsStr}</div>
          <div style="line-height:1.6;max-height:120px;overflow-y:auto;padding:8px;background:rgba(255,255,255,0.06);border-radius:6px">${Utils.escapeHtml(rec.prompt || '(无描述)')}</div>
          <div style="display:flex;gap:8px;margin-top:6px">
            <button type="button" id="tsimg-lightbox-save" style="flex:1;padding:10px;border:none;border-radius:8px;background:var(--accent);color:#111;font-weight:600;cursor:pointer">保存到相册</button>
            <button type="button" id="tsimg-lightbox-delete" style="flex:1;padding:10px;border:1px solid rgba(255,100,100,0.5);border-radius:8px;background:none;color:#ff7070;cursor:pointer">删除</button>
          </div>
        </div>`;
      modal.querySelector('#tsimg-lightbox-close').addEventListener('click', () => modal.remove());
      modal.querySelector('#tsimg-lightbox-save').addEventListener('click', () => downloadImage(imgId));
      modal.querySelector('#tsimg-lightbox-delete').addEventListener('click', async () => {
        const ok = await UI.showConfirm('删除图片', '从图库中删除这张图？\n（消息里的占位符会保留显示"图片已丢失"）');
        if (!ok) return;
        try { await DB.del('drawnImages', imgId); } catch(_) {}
        modal.remove();
        UI.showToast('已删除', 1200);
        // 如果当前在收藏页且是图片tab，刷新一下
        try { if (typeof Gaiden !== 'undefined' && Gaiden.renderList) Gaiden.renderList(); } catch(_) {}
      });
    } catch(e) {
      UI.showToast('打开失败: ' + e.message, 2000);
    }
  }

  // 渲染后扫描 [TSIMG:xxx] 占位符，替换为真实图片元素
  async function resolveDrawnImagesInHTML(el) {
    if (!el || !el.querySelectorAll) return;
    // 用 walker 找所有文本节点，扫描 [TSIMG:xxx] 占位
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const tasks = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.includes('[TSIMG:')) {
        tasks.push(node);
      }
    }
    for (const textNode of tasks) {
      const text = textNode.nodeValue;
      const regex = /\[TSIMG:([a-z0-9_-]+)(?:\|([^\]]*))?\]/gi;
      const matches = [...text.matchAll(regex)];
      if (matches.length === 0) continue;
      // 将该文本节点替换为：text片段 + img + text片段...
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      for (const m of matches) {
        if (m.index > lastIdx) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
        }
        const id = m[1];
        const desc = m[2] || '';
        try {
          const rec = await DB.get('drawnImages', id);
          if (rec && rec.dataUrl) {
            const wrap = document.createElement('span');
            wrap.style.cssText = 'position:relative;display:block;margin:8px 0';
            const img = document.createElement('img');
            img.src = rec.dataUrl;
            img.alt = desc;
            img.style.cssText = 'max-width:100%;border-radius:8px;display:block;cursor:pointer';
            img.loading = 'lazy';
            img.dataset.tsimgId = id;
            // 点击 → 弹 lightbox（不走 window.open）
            img.addEventListener('click', (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              openImageLightbox(id);
            });
            // 右下角保存按钮
            const saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.title = '保存到相册';
            saveBtn.style.cssText = 'position:absolute;right:8px;bottom:8px;width:32px;height:32px;border-radius:50%;border:none;background:rgba(0,0,0,0.55);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
            saveBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
            saveBtn.addEventListener('click', (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              downloadImage(id);
            });
            wrap.appendChild(img);
            wrap.appendChild(saveBtn);
            frag.appendChild(wrap);
          } else {
            const span = document.createElement('span');
            span.style.cssText = 'display:inline-block;padding:8px;background:rgba(255,100,100,0.1);color:var(--text-secondary);border-radius:6px;font-size:12px';
            span.textContent = '[图片已丢失]';
            frag.appendChild(span);
          }
        } catch(_) {
          frag.appendChild(document.createTextNode(m[0]));
        }
        lastIdx = m.index + m[0].length;
      }
      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  function _updateImgGenButtons() {
    const s = _getConvSettings();
    const show = s.imgGen;
    const mainBtn = document.getElementById('plus-imggen-btn');
    if (mainBtn) mainBtn.style.display = show ? 'flex' : 'none';
    const bsBtn = document.getElementById('backstage-imggen-btn');
    if (bsBtn) bsBtn.style.display = show ? 'flex' : 'none';
  }

  // 回复建议灯泡按钮显隐：跟随对话设置 suggestEnabled（默认开）
  function _updateSuggestBtn() {
    const s = _getConvSettings();
    const btn = document.getElementById('btn-suggest');
    if (!btn) return;
    if (s.suggestEnabled) {
      btn.style.display = 'flex';
    } else {
      btn.style.display = 'none';
      // 关闭时若建议面板还开着，一并收起
      const panel = document.getElementById('suggest-panel');
      if (panel) panel.classList.add('hidden');
    }
  }

  let _imgGenSource = 'main'; // 'main' | 'backstage'

  function openImgGenModal(source) {
    _imgGenSource = source || 'main';
    // 清空上次内容
    const p = document.getElementById('imggen-prompt');
    if (p) p.value = '';
    const w = document.getElementById('imggen-width');
    if (w) w.value = '1024';
    const h = document.getElementById('imggen-height');
    if (h) h.value = '768';
    const n = document.getElementById('imggen-count');
    if (n) n.value = '1';
    const status = document.getElementById('imggen-status');
    if (status) { status.style.display = 'none'; status.textContent = ''; }
    const btn = document.getElementById('imggen-submit');
    if (btn) { btn.disabled = false; btn.textContent = '生成'; }
    document.getElementById('imggen-modal')?.classList.remove('hidden');
  }

  async function submitImgGen() {
    const prompt = (document.getElementById('imggen-prompt')?.value || '').trim();
    const width = parseInt(document.getElementById('imggen-width')?.value) || 1024;
    const height = parseInt(document.getElementById('imggen-height')?.value) || 768;
    const count = Math.min(Math.max(parseInt(document.getElementById('imggen-count')?.value) || 1, 1), 4);
    const status = document.getElementById('imggen-status');
    const btn = document.getElementById('imggen-submit');

    if (!prompt) {
      // 留空：让AI根据剧情生成描述——直接以用户消息形式发送指令
      document.getElementById('imggen-modal')?.classList.add('hidden');
      const input = _imgGenSource === 'backstage'
        ? document.getElementById('backstage-input')
        : document.getElementById('chat-input');
      if (input) {
        input.value = '请为当前场景生成一张配图。';
        if (_imgGenSource === 'backstage' && typeof Backstage !== 'undefined') {
          Backstage.send();
        } else {
          send();
        }
      }
      return;
    }

    // 有描述：直接调生图API
    if (status) { status.style.display = 'block'; status.textContent = '正在生成图片…'; }
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }

    try {
      const images = await API.generateImage(prompt, {
        n: count,
        size: `${width}x${height}`
      });
      if (!images || images.length === 0) throw new Error('未返回图片');

      // 构建消息内容（图片存独立表，content 只放占位符 [TSIMG:id|desc]，markdown不解析）
      let content = `[手动生图] ${prompt}\n\n`;
      for (let i = 0; i < images.length; i++) {
        const imgId = await _saveDrawnImage(images[i], prompt);
        const safeDesc = `生成图片${i + 1}`;
        content += `[TSIMG:${imgId}|${safeDesc}]\n\n`;
      }

      // 作为系统消息插入当前对话
      const msgObj = {
        id: Utils.uuid(),
        role: 'system',
        content,
        conversationId: Conversations.getCurrent(),
        branchId: _imgGenSource === 'backstage' ? 'backstage' : (currentBranchId || 'main'),
        timestamp: Utils.timestamp()
      };
      await DB.put('messages', msgObj);

      if (_imgGenSource === 'backstage') {
        // 后台频道：用 appendExternalMessage 追加
        if (typeof Backstage !== 'undefined' && Backstage.appendExternalMessage) {
          await Backstage.appendExternalMessage(msgObj);
        }
      } else {
        messages.push(msgObj);
        appendMessage(msgObj, false, true);
      }

      document.getElementById('imggen-modal')?.classList.add('hidden');
      UI.showToast(`已生成 ${images.length} 张图片`);
    } catch(e) {
      if (status) { status.style.display = 'block'; status.textContent = '生成失败: ' + e.message; }
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    }
  }

  /**
   * 解析 AI 回复中的 [IMG: ...] 标记并替换为实际图片
   * 在 onDone 之后异步执行，不阻塞主流程
   */
  async function _processImgTags(msgId, content) {
    const regex = /\[IMG:\s*([^\]]+)\]/gi;
    const matches = [...content.matchAll(regex)];
    if (matches.length === 0) return;

    const s = _getConvSettings();
    if (!s.imgGen) return; // 未开启生图模式则跳过

    const msgEl = document.querySelector(`[data-id="${msgId}"]`);
    if (!msgEl) return;

    // 先给每个 [IMG:] 占位
    let html = msgEl.querySelector('.msg-body')?.innerHTML || '';
    matches.forEach((m, i) => {
      const placeholder = `<div class="imggen-placeholder" data-imggen-idx="${i}" style="display:flex;align-items:center;gap:8px;padding:12px;margin:8px 0;border-radius:8px;background:var(--bg-tertiary);border:1px solid var(--border);font-size:13px;color:var(--text-secondary)"><div class="typing-indicator" style="flex-shrink:0"><span></span><span></span><span></span></div>正在生成图片…</div>`;
      html = html.replace(Utils.escapeHtml(m[0]), placeholder);
    });
    const bodyEl = msgEl.querySelector('.msg-body');
    if (bodyEl) bodyEl.innerHTML = html;

    // 逐个生成
    for (let i = 0; i < matches.length; i++) {
      const desc = matches[i][1].trim();
      const ph = msgEl.querySelector(`[data-imggen-idx="${i}"]`);
      try {
        const images = await API.generateImage(desc, { n: 1, size: '1024x768' });
        if (images && images.length > 0) {
          // 存独立表，拿到引用ID
          const imgId = await _saveDrawnImage(images[0], desc);
          if (ph) {
            // 直接替换占位符为 img 元素，不走 markdown 渲染
            const newImg = document.createElement('img');
            newImg.src = images[0];
            newImg.style.cssText = 'max-width:100%;border-radius:8px;margin:8px 0;display:block';
            newImg.loading = 'lazy';
            ph.parentNode.replaceChild(newImg, ph);
          }
          // 更新消息内容：把 [IMG: ...] 替换成 [TSIMG:id|短描述]
          const msg = messages.find(m => m.id === msgId);
          if (msg) {
            const safeDesc = desc.substring(0, 60).replace(/[\[\]\|\n]/g, ' ');
            msg.content = msg.content.split(matches[i][0]).join(`[TSIMG:${imgId}|${safeDesc}]`);
            try { delete msg._cachedFullHTML; delete msg._cachedPlainHTML; } catch(_) {}
            await DB.put('messages', msg);
          }
        } else {
          if (ph) ph.outerHTML = `<div style="padding:8px;margin:8px 0;border-radius:8px;background:rgba(255,100,100,0.1);color:var(--danger);font-size:13px">图片生成失败：未返回数据</div>`;
        }
      } catch(e) {
        if (ph) ph.outerHTML = `<div style="padding:8px;margin:8px 0;border-radius:8px;background:rgba(255,100,100,0.1);color:var(--danger);font-size:13px">图片生成失败：${Utils.escapeHtml(e.message)}</div>`;
      }
    }
  }

  // ===== 环境音控制 =====
  function _onAmbientToggle() {
    const el = document.getElementById('cs-ambient-enabled');
    if (!el) return;
    if (el.checked) {
      const volEl = document.getElementById('cs-ambient-volume');
      const modeEl = document.getElementById('cs-ambient-mode');
      const vol = parseInt(volEl?.value || '50', 10) / 100;
      Ambient.setVolume(vol);
      Ambient.setMode(modeEl?.value || 'loop');
      Ambient.enable();
    } else {
      Ambient.disable();
    }
  }

  function _onAmbientVolume(val) {
    const v = parseInt(val, 10) || 50;
    const label = document.getElementById('cs-ambient-volume-label');
    if (label) label.textContent = v + '%';
    if (typeof Ambient !== 'undefined') Ambient.setVolume(v / 100);
  }

  function _onAmbientMode(val) {
    if (typeof Ambient !== 'undefined') Ambient.setMode(val);
    const label = document.getElementById('cs-ambient-mode-label');
    if (label) label.textContent = val === 'short' ? '触发短播（20-30秒）' : '持续循环';
  }

  const _AMBIENT_MODE_OPTIONS = [
    { value: 'loop', label: '持续循环' },
    { value: 'short', label: '触发短播（20-30秒）' }
  ];
  function _toggleAmbientModeDropdown() {
    const dropdown = document.getElementById('cs-ambient-mode-dropdown');
    if (!dropdown) return;
    const isHidden = dropdown.classList.contains('hidden');
    if (isHidden) {
      const curVal = document.getElementById('cs-ambient-mode')?.value || 'loop';
      dropdown.innerHTML = _AMBIENT_MODE_OPTIONS.map(o =>
        `<div class="custom-dropdown-item${o.value === curVal ? ' active' : ''}" onclick="Chat._selectAmbientMode('${o.value}')">${Utils.escapeHtml(o.label)}</div>`
      ).join('');
      dropdown.classList.remove('hidden');
      setTimeout(() => {
        document.addEventListener('click', function _close(e) {
          if (!dropdown.contains(e.target) && !e.target.closest('#cs-ambient-mode-btn')) {
            dropdown.classList.add('hidden');
            document.removeEventListener('click', _close);
          }
        });
      }, 0);
    } else {
      dropdown.classList.add('hidden');
    }
  }
  function _selectAmbientMode(val) {
    const input = document.getElementById('cs-ambient-mode');
    if (input) input.value = val;
    _onAmbientMode(val);
    const dropdown = document.getElementById('cs-ambient-mode-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
  }

  // 时间格式自定义下拉
  const _TIME_FORMAT_OPTIONS = [
    { value: 'delta', label: '增量（+1h20min，系统累加）' },
    { value: 'absolute', label: '绝对时间（完整日期时间）' }
  ];
  function _toggleTimeFormatDropdown() {
    const dropdown = document.getElementById('cs-time-format-dropdown');
    if (!dropdown) return;
    const isHidden = dropdown.classList.contains('hidden');
    if (isHidden) {
      const curVal = document.getElementById('cs-time-format')?.value || 'delta';
      dropdown.innerHTML = _TIME_FORMAT_OPTIONS.map(o =>
        `<div class="custom-dropdown-item${o.value === curVal ? ' active' : ''}" onclick="Chat._selectTimeFormat('${o.value}')">${Utils.escapeHtml(o.label)}</div>`
      ).join('');
      dropdown.classList.remove('hidden');
      setTimeout(() => {
        document.addEventListener('click', function _close(e) {
          if (!dropdown.contains(e.target) && !e.target.closest('#cs-time-format-btn')) {
            dropdown.classList.add('hidden');
            document.removeEventListener('click', _close);
          }
        });
      }, 0);
    } else {
      dropdown.classList.add('hidden');
    }
  }
  function _selectTimeFormat(val) {
    const input = document.getElementById('cs-time-format');
    const label = document.getElementById('cs-time-format-label');
    const dropdown = document.getElementById('cs-time-format-dropdown');
    if (input) input.value = val;
    const opt = _TIME_FORMAT_OPTIONS.find(o => o.value === val);
    if (label && opt) label.textContent = opt.label;
    if (dropdown) dropdown.classList.add('hidden');
  }

  // ===== 气泡时间戳显示模式（全局，现实/游戏二选一）=====
  const _BUBBLE_TIME_OPTIONS = [
    { value: 'real', label: '现实时间' },
    { value: 'game', label: '游戏时间' }
  ];
  function getBubbleTimeMode() {
    try { return localStorage.getItem('skynex_bubbleTimeMode') || 'real'; } catch(_) { return 'real'; }
  }
  function _syncBubbleTimeModeUI() {
    const mode = getBubbleTimeMode();
    const label = document.getElementById('cs-bubble-time-label');
    const opt = _BUBBLE_TIME_OPTIONS.find(o => o.value === mode);
    if (label && opt) label.textContent = opt.label;
  }
  function _toggleBubbleTimeDropdown() {
    const dropdown = document.getElementById('cs-bubble-time-dropdown');
    if (!dropdown) return;
    const isHidden = dropdown.classList.contains('hidden');
    if (isHidden) {
      const curVal = getBubbleTimeMode();
      dropdown.innerHTML = _BUBBLE_TIME_OPTIONS.map(o =>
        `<div class="custom-dropdown-item${o.value === curVal ? ' active' : ''}" onclick="Chat.setBubbleTimeMode('${o.value}')">${Utils.escapeHtml(o.label)}</div>`
      ).join('');
      dropdown.classList.remove('hidden');
      setTimeout(() => {
        document.addEventListener('click', function _close(e) {
          if (!dropdown.contains(e.target) && !e.target.closest('#cs-bubble-time-btn')) {
            dropdown.classList.add('hidden');
            document.removeEventListener('click', _close);
          }
        });
      }, 0);
    } else {
      dropdown.classList.add('hidden');
    }
  }
  function setBubbleTimeMode(mode) {
    const m = (mode === 'game') ? 'game' : 'real';
    try { localStorage.setItem('skynex_bubbleTimeMode', m); } catch(_) {}
    // 清掉所有消息的渲染缓存，让 renderAll 用新模式重渲染时间戳
    try { (messages || []).forEach(msg => { try { delete msg._cachedFullHTML; } catch(_) {} }); } catch(_) {}
    _syncBubbleTimeModeUI();
    // 关闭下拉
    const dropdown = document.getElementById('cs-bubble-time-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
    try { renderAll(); } catch(_) {}
  }

  // ===== 来电频率档位（对话级，正常/积极，在对话设置弹窗内临时编辑）=====
  const _CALL_FREQ_OPTIONS = [
    { value: 'normal', label: '正常' },
    { value: 'active', label: '积极' }
  ];
  // 同步按钮的当前值（存在 dataset.value，保存时统一读取）
  function _syncCallFreqUI(val) {
    const v = (val === 'active') ? 'active' : 'normal';
    const btn = document.getElementById('cs-call-freq-btn');
    const label = document.getElementById('cs-call-freq-label');
    const opt = _CALL_FREQ_OPTIONS.find(o => o.value === v);
    if (btn) btn.dataset.value = v;
    if (label && opt) label.textContent = opt.label;
  }
  function _toggleCallFreqDropdown() {
    const dropdown = document.getElementById('cs-call-freq-dropdown');
    if (!dropdown) return;
    const isHidden = dropdown.classList.contains('hidden');
    if (isHidden) {
      const btn = document.getElementById('cs-call-freq-btn');
      const curVal = (btn && btn.dataset.value) || 'normal';
      dropdown.innerHTML = _CALL_FREQ_OPTIONS.map(o =>
        `<div class="custom-dropdown-item${o.value === curVal ? ' active' : ''}" onclick="Chat._selectCallFreq('${o.value}')">${Utils.escapeHtml(o.label)}</div>`
      ).join('');
      dropdown.classList.remove('hidden');
      setTimeout(() => {
        document.addEventListener('click', function _close(e) {
          if (!dropdown.contains(e.target) && !e.target.closest('#cs-call-freq-btn')) {
            dropdown.classList.add('hidden');
            document.removeEventListener('click', _close);
          }
        });
      }, 0);
    } else {
      dropdown.classList.add('hidden');
    }
  }
  function _selectCallFreq(val) {
    _syncCallFreqUI(val);
    const dropdown = document.getElementById('cs-call-freq-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
  }

  // ===== 叙述人称档位（对话级，第一/第二/第三人称，在对话设置弹窗内临时编辑）=====
  const _NARR_PERSON_OPTIONS = [
    { value: 'first', label: '第一人称（不推荐群像使用）' },
    { value: 'second', label: '第二人称（称呼user为你）' },
    { value: 'third', label: '第三人称（全局使用第三人称）' }
  ];
  function _syncNarrPersonUI(val) {
    const v = ['first', 'second', 'third'].includes(val) ? val : 'second';
    const btn = document.getElementById('cs-narr-person-btn');
    const label = document.getElementById('cs-narr-person-label');
    const opt = _NARR_PERSON_OPTIONS.find(o => o.value === v);
    if (btn) btn.dataset.value = v;
    if (label && opt) label.textContent = opt.label;
  }
  function _toggleNarrPersonDropdown() {
    const dropdown = document.getElementById('cs-narr-person-dropdown');
    if (!dropdown) return;
    const isHidden = dropdown.classList.contains('hidden');
    if (isHidden) {
      const btn = document.getElementById('cs-narr-person-btn');
      const curVal = (btn && btn.dataset.value) || 'second';
      dropdown.innerHTML = _NARR_PERSON_OPTIONS.map(o =>
        `<div class="custom-dropdown-item${o.value === curVal ? ' active' : ''}" onclick="Chat._selectNarrPerson('${o.value}')">${Utils.escapeHtml(o.label)}</div>`
      ).join('');
      dropdown.classList.remove('hidden');
      setTimeout(() => {
        document.addEventListener('click', function _close(e) {
          if (!dropdown.contains(e.target) && !e.target.closest('#cs-narr-person-btn')) {
            dropdown.classList.add('hidden');
            document.removeEventListener('click', _close);
          }
        });
      }, 0);
    } else {
      dropdown.classList.add('hidden');
    }
  }
  function _selectNarrPerson(val) {
    _syncNarrPersonUI(val);
    const dropdown = document.getElementById('cs-narr-person-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
  }

  return {
    loadHistory, send, cancelRequest, editMessage, saveEdit,
    createBranch, switchBranch, regenerate,
    openRewriteHint, closeRewriteHint, confirmRewriteHint,
    refreshAiAvatar,
    refreshOnlineChatAvatars,
    deleteMessage, rollbackTo, rollbackAndRestore,
    continueGenerate,
    initLongPress, showContext, _showToolsLog,
    togglePlusMenu, _openBackstageFromPlus, toggleFullscreenInput, attachImage, onImagePicked,
    attachFile, onFilePicked, previewFile, _openFilePreview,
    pickMemories, filterPickMemories, _togglePickMem,
    confirmPickMemories, removeAttach,
    setWorldview, getWorldviewPrompt, getHsHomecomingWorldSetting, getMessages, getBranchId, autoExtractMemory,
    isStreamingNow: () => isStreaming,
manualExtractMemory, manualSummary,
enterMultiSelect, exitMultiSelect, toggleMultiSelect, selectAllMulti,
multiExtractMemory, multiExportImage, isMultiSelectMode,
    setWorldVoiceAttach, hasPendingWorldVoice: () => !!pendingWorldVoice, collectMessage,
    searchMessages, toggleSearchBar, renderQuickSwitches, renderAll,
    scrollToBottom, updateScrollBtn,
    _toggleThink,
    generateSuggestions, _pickSuggestion, refreshSuggestions, _cancelSuggestConfirm, _okSuggestConfirm,
    openConvSettingsModal, saveConvSettings, closeConvSettingsModal, _switchCsTab,
    setBubbleTimeMode, getBubbleTimeMode,
    openDirectiveModal, closeDirectiveModal, saveDirective, clearDirective, _getConvSettings,
    isRetryDisabled,
    openEventManagerModal, closeEventManagerModal, resetEventState, switchEventManagerTab,
openLorebookDisableModal, closeLorebookDisableModal, toggleLorebookDisable,
    unbindConvLorebook, addConvLorebooks, applyLorebooksToWorldview,
    resetConvGameplay,
    _onVoiceEnabledChange, _onVoiceScopeAllChange,
    _onConvBgPicked, _onConvBgClear,
    playVoiceForMessage, stopVoice,
    buildAIMessageHTML, appendMessage,
    openImgGenModal, submitImgGen, _updateImgGenButtons,
    resolveDrawnImagesInHTML, downloadImage, openImageLightbox,
    _onDiceToggle, _openDiceConfigModal, _closeDiceConfigModal, _saveDiceConfigModal, _toggleDiceRuleDropdown,
    // v687.23：MCP
    _renderMcpList, _openMcpAddModal, _closeMcpAddModal, _onMcpAuthTypeChange, _saveMcpServer,
    _toggleMcpServer, _removeMcpServer, _rediscoverMcpServer,
    // 环境音控制
    _onAmbientToggle, _onAmbientVolume, _onAmbientMode,
    // 时间格式下拉
    _toggleTimeFormatDropdown, _selectTimeFormat,
    // 气泡时间戳下拉
    _toggleBubbleTimeDropdown,
    // 来电频率下拉
    _toggleCallFreqDropdown, _selectCallFreq,
    // 叙述人称下拉
    _toggleNarrPersonDropdown, _selectNarrPerson,
    // 环境音模式下拉
    _toggleAmbientModeDropdown, _selectAmbientMode
  };
})();