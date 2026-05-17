/**
 * 记忆系统 — 事件 + 人际关系
 * 关键词分词检索；按面具分库
 */
const Memory = (() => {
  let currentTab = 'events';
  let editingId = null;
  let searchQuery = '';
  let viewScope = null; // maskId (null = 显示所有记忆，否则只显示指定面具的记忆)
  
  // 管理模式状态
  let manageMode = false;
  let selectedIds = new Set();
  let _pendingMergeIds = null; // 合并模式：保存要删除的原始记忆ID列表
  let sortMode = false;
  let sortedList = []; // 排序模式中的有序列表
  let menuVisible = false;
  let _pasteMode = false; // true = 粘贴到编辑面板, false = 批量导入

  // ===== 数据操作 =====

  // 将AI提取的分字段（cause/process/result/note）合并为一段内容
  function _mergeEventContent(data) {
    const parts = [];
    if (data.cause) parts.push(`开端：${data.cause}`);
    if (data.process) parts.push(`过程：${data.process}`);
    if (data.result) parts.push(`结果：${data.result}`);
    if (data.note) parts.push(`备注：${data.note}`);
    return parts.join('\n') || '';
  }

  // 兼容旧数据：如果有 cause/process/result 但没有 content，合成一份
  function _getContent(m) {
    if (m.content) return m.content;
    return _mergeEventContent(m);
  }

  async function add(type, data) {
    if (type === 'relation') {
      return upsertRelation(data);
    }
    const scope = data.scope || Character.getCurrentId();
    const content = data.content || _mergeEventContent(data);
    const title = data.title || '';
    // 自动提取事件去重：同面具 + 同标题 + 同内容视为同一事件，避免游标丢失/总结前提取造成重复记忆
    try {
      const all = await DB.getAll('memories');
      const existing = all.find(m =>
        m.type === type &&
        (m.scope || 'default') === scope &&
        (m.title || '') === title &&
        (_getContent(m) || '') === content
      );
      if (existing) {
        existing.time = existing.time || data.time || '';
        existing.location = existing.location || data.location || '';
        existing.participants = existing.participants?.length ? existing.participants : (data.participants || []);
        existing.keywords = existing.keywords || Utils.tokenize(title + ' ' + content + ' ' + (existing.location || data.location || ''));
        existing.timestamp = Utils.timestamp();
        existing.roundCreated = existing.roundCreated || data.roundCreated || 0;
        await DB.put('memories', existing);
        return existing;
      }
    } catch(e) { console.warn('[Memory] 事件去重检查失败:', e); }
    const memory = {
      id: Utils.uuid(),
      type,
    title,
    // 事件内容（统一合并为content）
    time: data.time || '',
    location: data.location || '',
    content,
    keywords: data.keywords || Utils.tokenize(
      title + ' ' + content + ' ' + (data.location||'')
    ),
      participants: data.participants || [],
      // 优先使用调用方传入的 scope（异步写入时锁定原面具，避免和当前激活面具串线）
      scope,
      timestamp: Utils.timestamp(),
      roundCreated: data.roundCreated || 0
    };
    await DB.put('memories', memory);
    return memory;
  }

  /**
   * 人际关系：按NPC名upsert
   * relationship/impression 覆盖；emotions 追加
   */
  async function upsertRelation(data) {
    // 优先使用调用方传入的 scope（异步写入时锁定原面具）
    const scope = data.scope || Character.getCurrentId();
    const all = await DB.getAll('memories');
    const existing = all.find(m =>
      m.type === 'relation' && m.title === data.title && m.scope === scope
    );

    if (existing) {
      if (data.relationship) existing.relationship = data.relationship;
      if (data.impression) existing.impression = data.impression;
      if (data.emotion) {
        existing.emotions = existing.emotions || [];
        existing.emotions.push(data.emotion);
      }
      existing.keywords = Utils.tokenize(
        existing.title + ' ' + (existing.relationship || '') + ' ' + (existing.impression || '')
      );
      existing.timestamp = Utils.timestamp();
      await DB.put('memories', existing);
      return existing;
    } else {
      const memory = {
        id: Utils.uuid(),
        type: 'relation',
        title: data.title || '',
        relationship: data.relationship || '',
        impression: data.impression || '',
        emotions: data.emotion ? [data.emotion] : [],
        // 兼容旧content字段
        content: data.content || data.relationship || '',
        keywords: data.keywords || Utils.tokenize(data.title + ' ' + (data.relationship || '') + ' ' + (data.impression || '')),
        participants: data.participants || [data.title],
        scope,
        timestamp: Utils.timestamp(),
        roundCreated: data.roundCreated || 0
      };
      await DB.put('memories', memory);
      return memory;
    }
  }

  // ===== 小纸条（情绪记忆）=====
  const NOTE_TAGS = ['喜欢','讨厌','期待','恐惧','愤怒','有趣','习惯','秘密','悲伤','迷茫','痛苦'];
  const NOTE_MAX = 1000;

  async function addNote(data) {
    const scope = data.scope || Character.getCurrentId();
    const tag = NOTE_TAGS.includes(data.tag) ? data.tag : '有趣';
    const detail = String(data.detail || '').trim();
    if (!detail) return null;

    // 去重：同 scope + 同 tag + 同 detail
    const all = await DB.getAll('memories');
    const dup = all.find(m => m.type === 'note' && m.scope === scope && m.tag === tag && m.detail === detail);
    if (dup) return dup;

    const memory = {
      id: Utils.uuid(),
      type: 'note',
      tag,
      detail,
      time: data.time || '',
      characters: data.characters || [],
      scope,
      timestamp: Utils.timestamp(),
      roundCreated: data.roundCreated || 0
    };
    await DB.put('memories', memory);

    // FIFO：超出上限时删最早的
    const notes = all.filter(m => m.type === 'note' && m.scope === scope);
    notes.push(memory);
    if (notes.length > NOTE_MAX) {
      notes.sort((a, b) => a.timestamp - b.timestamp);
      const toRemove = notes.slice(0, notes.length - NOTE_MAX);
      for (const old of toRemove) { try { await DB.delete('memories', old.id); } catch(_){} }
    }
    return memory;
  }

  /**
   * 小纸条检索：按在场角色 + 标签命中，无命中随机，返回 3-5 条
   */
  async function retrieveNotes(presentNPCNames = []) {
    const allMemories = await DB.getAll('memories');
    const currentScope = Character.getCurrentId();
    const notes = allMemories.filter(m => m.type === 'note' && m.scope === currentScope);
    if (notes.length === 0) return [];

    // 计算匹配分
    const scored = notes.map(n => {
      let score = 0;
      // 角色命中（任意一个在场就算）
      if (n.characters?.length && presentNPCNames.length) {
        const hit = n.characters.some(c => presentNPCNames.includes(c));
        if (hit) score += 2;
      }
      return { note: n, score };
    });

    // 有命中的优先取命中的，否则全池随机
    const matched = scored.filter(s => s.score > 0);
    const pool = matched.length > 0 ? matched.map(s => s.note) : notes;

    // 随机抽 3-5 条
    const count = Math.min(pool.length, 3 + Math.floor(Math.random() * 3)); // 3~5
    const shuffled = pool.slice().sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  function formatNotesForPrompt(notes) {
    if (!notes || notes.length === 0) return '';
    let text = '【小纸条】你记得关于{{user}}的这些碎片——不需要刻意提起，但如果剧情自然触及，可以像真的记得一样回应。\n';
    notes.forEach(n => {
      text += `- [${n.tag}] ${n.detail}`;
      if (n.characters?.length) text += `（在场：${n.characters.join('、')}）`;
      text += '\n';
    });
    return text;
  }

  /**
   * - 关系：只按NPC名字（标题）精确匹配在场NPC或对话提及
   * - 事件：按参与者交叉+地点+标题提及，不用n-gram关键词
   */
  async function retrieve(recentText, presentNPCNames = [], currentLocation = '') {
    const allMemories = await DB.getAll('memories');
    const currentScope = Character.getCurrentId();
    const scoped = allMemories.filter(m => !m.scope || m.scope === currentScope);

    // ===== 关系记忆：按NPC名字精确命中 =====
    const relationResults = scoped
      .filter(m => m.type === 'relation')
      .filter(m => {
        const title = (m.title || '').trim();
        if (!title) return false;
        // 路径1：在场NPC精确匹配
        if (presentNPCNames.some(name => name === title)) return true;
        // 路径2：对话文本中提到NPC名字（≥2字，避免单字碰撞）
        if (title.length >= 2 && recentText.includes(title)) return true;
        return false;
      })
      .slice(0, 5);

    // ===== 事件记忆：参与者+地点+标题精确匹配 =====
    const eventResults = scoped
      .filter(m => m.type === 'event')
      .map(m => {
        let score = 0;

        // 参与者和在场NPC交叉（主权重）
        const parts = m.participants || [];
        if (parts.length > 0 && presentNPCNames.length > 0) {
          const matchCount = parts.filter(p =>
            presentNPCNames.some(name => name === p)
          ).length;
          if (matchCount > 0) score += 0.4 + matchCount * 0.15;
        }

        // 对话文本中提到参与者名字（≥2字）
        if (parts.length > 0) {
          for (const p of parts) {
            if (p.length >= 2 && recentText.includes(p)) {
              score += 0.3;
              break;
            }
          }
        }

        // 地点匹配
        if (currentLocation && m.location) {
          const loc = m.location.trim();
          if (loc && (currentLocation === loc ||
              currentLocation.includes(loc) ||
              loc.includes(currentLocation))) {
            score += 0.25;
          }
        }

        // 事件标题在对话中被提到（≥2字）
        const title = (m.title || '').trim();
        if (title.length >= 2 && recentText.includes(title)) {
          score += 0.3;
        }

        return { memory: m, score };
      })
      .filter(s => s.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(s => s.memory);

    // ===== 固定记忆：手动添加的始终注入 =====
    const pinnedResults = scoped.filter(m => m.pinned);

    // 合并去重（固定 > 关系 > 事件）
    const seen = new Set(pinnedResults.map(m => m.id));
    for (const m of relationResults) if (!seen.has(m.id)) { seen.add(m.id); }
    const combined = [
      ...pinnedResults,
      ...relationResults.filter(m => !pinnedResults.some(p => p.id === m.id)),
      ...eventResults.filter(m => !seen.has(m.id))
    ];
    return combined;
  }

  function buildExtractionPrompt(recentMessages, charName, charInfo, extractLimits) {
const displayName = charName || '用户角色';
const dialogue = recentMessages.map(m =>
`[${m.role === 'user' ? displayName : 'AI'}] ${m.content}`
).join('\n\n');
const playerName = displayName;
    const maxEvents = extractLimits?.maxEvents || 5;
    const maxRelations = extractLimits?.maxRelations || 5;

    // 角色基本信息
    let charLine = '';
    if (charInfo) {
      const parts = [charInfo.name];
      if (charInfo.gender) parts.push(charInfo.gender);
      if (charInfo.background) parts.push(charInfo.background.substring(0, 100));
      charLine = `\n用户角色：${parts.join('，')}\n`;
    }

    return `请从以下对话中按时间顺序提取所有重要事件和关系变化，按JSON格式输出。只输出JSON，不要其他内容。
${charLine}
对话内容：
${dialogue}

输出格式：
{
  "events": [
    {
      "title": "事件简称",
      "time": "游戏内时间（年月日星期，如无则留空）",
      "location": "事件发生地点",
      "cause": "事件为何发生？开端是什么？",
      "process": "中途发生了什么？经历了怎样的波折？",
      "result": "结局如何？带来了什么影响？导致了什么发生？",
      "note": "补充说明（可留空）",
      "participants": ["参与者"],
      "keywords": ["关键词"]
    }
  ],
  "relations": [
    {
      "title": "角色姓名",
"relationship": "与${playerName}当前的关系（一句话，不要写“玩家”或“NPC”）",
"impression": "该角色目前对${playerName}的看法（一句话，不要写“玩家”或“NPC”）",
"emotion": "在经历了XXX后，角色姓名与${playerName}的关系从XXX变为XXX，角色姓名对此感到XXX（无明显变化则留空字符串）",
"participants": ["角色姓名"],
      "keywords": ["关键词"]
    }
  ],
  "notes": [
    {
      "tag": "从以下标签中选一个：喜欢/讨厌/期待/恐惧/愤怒/有趣/习惯/秘密/悲伤/迷茫/痛苦",
      "detail": "用一句带场景的话描述，像你亲眼看到的瞬间",
      "characters": ["当时在场的角色姓名"]
    }
  ]
}

- notes（小纸条）：提取${playerName}在对话中表达的偏好、情绪、习惯等，用一句带场景的话描述那个瞬间。tag 必须从固定标签中选择。没有明显偏好/情绪表达时 notes 可以为空数组。
提取规则（重要，请严格遵守）：
- **从对话最开头开始，按时间顺序逐段扫描**，不要只看后半段。每出现一个独立场景/转折/重要决策/到达新地点/关键对话/情感变化，都算一个独立事件。
- **不要做"重要性筛选"**：哪怕是吃饭、闲聊、路过某地，只要在对话中有具体内容也要记录；宁可粒度细，不要漏掉早期发生的事。
- **events 最多 ${maxEvents} 条是上限，不是目标**——如果对话里发生了 ${maxEvents} 件独立事件，就输出 ${maxEvents} 条；如果只有 2 件，就只输出 2 条；不要为了凑数也不要为了精简而丢早期事件。
- **如果事件数量超过上限**：合并相邻同场景的小事件，但**仍要保证时间跨度从开头到结尾都被覆盖**，不允许只保留后半段。
- relations 最多 ${maxRelations} 条，只写本轮出现且有变化的角色；emotion 无明显变化填""。
- **称呼规则**：禁止在事件标题、事件正文、关系字段、印象字段、emotion、participants 中用“玩家”“NPC”泛称角色；必须直接使用角色姓名。用户角色使用“${playerName}”，其他角色使用各自姓名。只有确实不知道姓名时，才可用“对方”“那名角色”等临时称呼。
- 事件字段如无对应信息留空字符串，不要编造。
- 只输出 JSON，确保完整闭合。`;
  }

  function formatForPrompt(memories) {
    if (!memories || memories.length === 0) return '';
    let text = '【相关记忆】以下是用户过去经历的事件和角色关系，供AI参考，用于保持剧情一致性。\n- 若记忆与当前对话有关，可通过旁白或角色的言行自然呼应，不要突兀地复述。\n- 若当前场合与这些记忆无关，请仅将其作为背景知识，不必主动提及。\n';
    memories.forEach((m, i) => {
      if (m.type === 'relation') {
        text += `\n[记忆${i + 1}] 🤝关系: ${m.title}\n`;
        if (m.relationship) text += `当前关系: ${m.relationship}\n`;
        if (m.impression) text += `对用户角色看法: ${m.impression}\n`;
        if (m.emotions && m.emotions.length > 0) {
          text += `情感历程:\n${m.emotions.map(e => `  - ${e}`).join('\n')}\n`;
        }
        if (!m.relationship && !m.impression && m.content) text += `${m.content}\n`;
      } else {
        text += `\n[记忆${i + 1}] 📌事件: ${m.title}\n`;
        if (m.time) text += `时间: ${m.time}\n`;
        if (m.location) text += `地点: ${m.location}\n`;
        const content = _getContent(m);
        if (content) text += `${content}\n`;
        if (m.participants?.length) text += `参与者: ${m.participants.join(', ')}\n`;
      }
    });
    return text;
  }

  // ===== UI - 面具筛选 chip 栏 =====
  // 仅作视图筛选，不影响对话界面的全局面具。
  // viewScope 默认 = 当前激活面具，用户可在记忆面板临时切换查看其他面具的记忆。

  let scopeDropdownVisible = false;

  async function renderScopeSelector() {
    const container = document.getElementById('memory-mask-chips');
    if (!container) return;
    const maskData = await DB.get('gameState', 'maskList');
    const masks = maskData?.value || [{ id: 'default', name: '默认面具' }];
    const currentId = Character.getCurrentId();

    // 首次进面板/外部 viewScope 失效时，默认选中当前激活面具；'all' 为合法值
    if (!viewScope || (viewScope !== 'all' && !masks.find(m => m.id === viewScope))) {
      viewScope = currentId;
    }

    const maskDetails = await Promise.all(masks.map(async m => {
      const data = await DB.get('characters', m.id).catch(() => null);
      const bg = (data?.background || '').replace(/\s+/g, ' ').trim();
      return {
        ...m,
        avatar: data?.avatar || '',
        preview: bg ? (bg.length > 52 ? bg.slice(0, 52) + '…' : bg) : '暂无面具设定'
      };
    }));

    const allOption = {
      id: 'all',
      name: '全部记忆',
      avatar: '',
      preview: '显示所有面具下的事件与关系记忆'
    };
    const options = [allOption, ...maskDetails];
    const active = options.find(m => m.id === viewScope) || maskDetails.find(m => m.id === currentId) || allOption;
    const activeIsCurrent = active.id === currentId;
    const activeAvatar = active.avatar
      ? `<span style="width:34px;height:34px;border-radius:50%;background:url('${active.avatar}') center/cover no-repeat;border:1px solid var(--border);flex-shrink:0"></span>`
      : `<span style="width:34px;height:34px;border-radius:50%;background:${active.id === 'all' ? 'var(--bg-secondary)' : 'var(--accent)'};border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${active.id === 'all' ? 'var(--accent)' : '#111'};font-size:15px">${active.id === 'all' ? '全' : '✦'}</span>`;

    container.innerHTML = `
      <div style="position:relative;width:100%">
        <button type="button" onclick="Memory.toggleScopeDropdown()" style="width:100%;display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;cursor:pointer;box-sizing:border-box;text-align:left">
          ${activeAvatar}
          <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">${Utils.escapeHtml(active.name)}${activeIsCurrent ? '<span style="font-size:11px;color:var(--text-secondary)"> · 当前面具</span>' : ''}</span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--text-secondary);line-height:1.4">${Utils.escapeHtml(active.preview)}</span>
          </span>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:16px;height:16px;flex-shrink:0;color:var(--text-secondary)"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
        </button>
        <div id="memory-scope-dropdown" class="custom-dropdown ${scopeDropdownVisible ? '' : 'hidden'}" style="position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:30;max-height:260px;overflow-y:auto">
          ${options.map(m => {
            const isActive = m.id === viewScope;
            const isCurrent = m.id === currentId;
            const avatar = m.avatar
              ? `<span style="width:30px;height:30px;border-radius:50%;background:url('${m.avatar}') center/cover no-repeat;border:1px solid var(--border);flex-shrink:0"></span>`
              : `<span style="width:30px;height:30px;border-radius:50%;background:${m.id === 'all' ? 'var(--bg-secondary)' : 'var(--accent)'};border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${m.id === 'all' ? 'var(--accent)' : '#111'};font-size:13px">${m.id === 'all' ? '全' : '✦'}</span>`;
            return `<div class="custom-dropdown-item ${isActive ? 'active' : ''}" onclick="Memory.selectScope('${m.id}')" style="display:flex;align-items:center;gap:8px;padding:8px 10px">
              ${avatar}
              <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">${Utils.escapeHtml(m.name)}${isCurrent ? '<span style="font-size:11px;color:var(--text-secondary)"> · 当前</span>' : ''}</span>
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--text-secondary);line-height:1.4">${Utils.escapeHtml(m.preview)}</span>
              </span>
              ${isActive ? '<span style="font-size:11px;color:var(--accent);flex-shrink:0">已选</span>' : ''}
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function toggleScopeDropdown() {
    scopeDropdownVisible = !scopeDropdownVisible;
    const dropdown = document.getElementById('memory-scope-dropdown');
    if (!dropdown) return;
    if (scopeDropdownVisible) {
      dropdown.classList.remove('hidden', 'closing');
      setTimeout(() => {
        document.addEventListener('click', _closeScopeDropdownOutside, { once: true });
      }, 0);
    } else {
      dropdown.classList.add('hidden');
    }
  }

  function _closeScopeDropdownOutside(e) {
    const box = document.getElementById('memory-mask-chips');
    if (box && box.contains(e.target)) return;
    scopeDropdownVisible = false;
    document.getElementById('memory-scope-dropdown')?.classList.add('hidden');
  }

  async function selectScope(val) {
    // 仅切换记忆库视图筛选，不调用 Character.switchMask，不改全局面具
    viewScope = val;
    scopeDropdownVisible = false;
    await renderScopeSelector();
    renderList();
  }

  // 让外部（Character.switchMask）能在切换全局面具后同步 chip 高亮
  async function syncViewScopeToCurrent() {
    viewScope = Character.getCurrentId();
    await renderScopeSelector();
  }

  async function updateCurrentMaskCard() {
    // 旧的当前面具卡片已移除，no-op
  }

  async function updateScopeLabel() {
    // 旧下拉已废弃，no-op
  }

  function filterByScope(val) {
    // 兼容旧接口
    viewScope = val;
    renderList();
  }


  // ===== UI - Tab =====

  function showTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.memory-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.tab-btn[onclick*="${tab}"]`)?.classList.add('active');
    renderList();
  }

  // ===== UI - 列表 =====

  async function renderList() {
    const all = await DB.getAll('memories');
    const currentId = Character.getCurrentId();

    // 默认按 viewScope 过滤；viewScope 未初始化时回退到当前激活面具；all = 全部面具
    const scope = viewScope || currentId;
    const scopeFilter = scope === 'all' ? (() => true) : (m => m.scope === scope);

    let filtered = all.filter(m =>
      (currentTab === 'events' ? m.type === 'event' : currentTab === 'relations' ? m.type === 'relation' : m.type === 'note') &&
      scopeFilter(m)
    );

    if (searchQuery) {
      filtered = filtered.filter(m =>
        (m.title || '').toLowerCase().includes(searchQuery) ||
        (m.content || '').toLowerCase().includes(searchQuery) ||
        (m.detail || '').toLowerCase().includes(searchQuery) ||
        (m.tag || '').toLowerCase().includes(searchQuery) ||
        (m.participants || []).join(' ').toLowerCase().includes(searchQuery) ||
        (m.characters || []).join(' ').toLowerCase().includes(searchQuery)
      );
    }

    // 按 sortOrder 排序（有 sortOrder 用 sortOrder，没有用 timestamp）
    if (currentTab === 'events') {
      filtered.sort((a, b) => (a.sortOrder ?? a.timestamp) - (b.sortOrder ?? b.timestamp));
    } else if (currentTab === 'notes') {
      filtered.sort((a, b) => (b.timestamp) - (a.timestamp));
    } else {
      filtered.sort((a, b) => (b.sortOrder ?? b.timestamp) - (a.sortOrder ?? a.timestamp));
    }

    // 获取面具名映射
    const maskData = await DB.get('gameState', 'maskList');
    const masks = maskData?.value || [];
    const maskName = id => masks.find(m => m.id === id)?.name || id || '无归属';

    const container = document.getElementById('memory-list');
    if (!container) return;
    container.innerHTML = filtered.length === 0 ?
      '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无记忆</p>' :
      filtered.map(m => {
        const isSelected = selectedIds.has(m.id);
        // 小纸条独立渲染
        if (m.type === 'note') {
          return `
          <div style="display:flex;align-items:center;gap:10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:6px;cursor:pointer" class="card" data-id="${m.id}" onclick="Memory.deleteNoteConfirm('${m.id}')">
            ${manageMode ? `<span class="memory-select-checkbox" style="width:22px;height:22px;border-radius:50%;border:2px solid var(--text-secondary);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${isSelected ? 'background:var(--accent);border-color:var(--accent);' : ''}" onclick="event.stopPropagation();Memory.toggleSelect('${m.id}')">${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}</span>` : ''}
            <div style="flex:1;overflow:hidden">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
                <span style="font-size:11px;padding:1px 6px;border-radius:4px;background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--accent);font-weight:700;flex-shrink:0">${Utils.escapeHtml(m.tag)}</span>
                ${m.characters?.length ? `<span style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.characters.join('、')}</span>` : ''}
              </div>
              <p style="margin:0;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.detail || '')}</p>
              ${m.time ? `<p style="margin:2px 0 0 0;font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(m.time)}</p>` : ''}
            </div>
          </div>`;
        }
        // 关系记忆的摘要显示
        let preview = '';
        if (m.type === 'relation') {
          if (m.relationship) preview = `关系: ${m.relationship}`;
          else if (m.content) preview = m.content.substring(0, 80);
        } else {
// 优先显示结构化字段
            const raw = _getContent(m);
            preview = raw.substring(0, 100) + (raw.length > 100 ? '…' : '');
        }
        const isSelected = selectedIds.has(m.id);
        return `
        <div style="display:flex;align-items:center;gap:10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px;cursor:${manageMode ? 'default' : 'pointer'}" class="card" data-id="${m.id}" onclick="${manageMode ? `Memory.toggleSelect('${m.id}')` : `Memory.edit('${m.id}')`}">
          ${manageMode ? `
            <span class="memory-select-checkbox" style="width:22px;height:22px;border-radius:50%;border:2px solid var(--text-secondary);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${isSelected ? 'background:var(--accent);border-color:var(--accent);' : ''}" onclick="event.stopPropagation();Memory.toggleSelect('${m.id}')">${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}</span>
          ` : ''}
          <div style="flex:1;overflow:hidden">
            <h3 style="margin:0 0 4px 0;font-size:14px;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.type === 'event' ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="m12.296 3.464 3.02 3.956"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m6.18 5.276 3.1 3.899"/></svg>' : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/></svg>'} ${Utils.escapeHtml(m.title)}</h3>
            <p style="margin:0;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(preview)}</p>
${m.type === 'relation' && m.impression ? `<p style="margin:2px 0 0 0;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">看法: ${Utils.escapeHtml(m.impression.substring(0,60))}${m.impression.length>60?'…':''}</p>` : ''}
${m.type === 'relation' && m.emotions?.length ? `<p style="margin:2px 0 0 0;font-size:11px;color:var(--text-secondary)">情感记录: ${m.emotions.length}条</p>` : ''}
${m.type !== 'relation' && m.participants?.length ? `<p style="margin:2px 0 0 0;font-size:11px;color:var(--accent-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;vertical-align:middle"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg> ${m.participants.join(', ')}</p>` : ''}
            ${viewScope === 'all' ? `<p style="margin:2px 0 0 0;font-size:11px;color:var(--accent-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🎭 ${Utils.escapeHtml(maskName(m.scope))}</p>` : ''}
          </div>
        </div>
      `}).join('');

    // 更新全选按钮状态
    updateSelectAllIcon();
  }

  // ===== 管理模式 =====

  function toggleManageMode() {
    if (sortMode) exitSortMode();
    manageMode = !manageMode;
    selectedIds.clear();
    const bar = document.getElementById('memory-manage-bar');
    const container = document.getElementById('memory-list');
    if (manageMode) {
      bar.classList.remove('hidden');
      bar.style.display = 'flex';
      if (container) container.style.paddingBottom = '72px';
    } else {
      bar.classList.add('hidden');
      bar.style.display = '';
      if (container) container.style.paddingBottom = '';
    }
    renderList();
  }

  function exitManageMode() {
    if (!manageMode) return;
    manageMode = false;
    selectedIds.clear();
    const bar = document.getElementById('memory-manage-bar');
    const container = document.getElementById('memory-list');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    if (container) container.style.paddingBottom = '';
  }

  // ===== 菜单 =====

  function toggleMenu() {
    const dropdown = document.getElementById('memory-menu-dropdown');
    menuVisible = !menuVisible;
    if (menuVisible) {
      dropdown.classList.remove('hidden', 'closing');
      setTimeout(() => {
        document.addEventListener('click', _closeMenuOutside, { once: true });
      }, 0);
    } else {
      dropdown.classList.add('closing');
      setTimeout(() => {
        dropdown.classList.add('hidden');
        dropdown.classList.remove('closing');
      }, 120);
    }
  }

  function _closeMenuOutside(e) {
    const btn = document.getElementById('memory-menu-btn');
    if (btn && btn.contains(e.target)) return;
    menuVisible = false;
    const dropdown = document.getElementById('memory-menu-dropdown');
    if (dropdown) {
      dropdown.classList.add('closing');
      setTimeout(() => {
        dropdown.classList.add('hidden');
        dropdown.classList.remove('closing');
      }, 120);
    }
  }

  // ===== 排序模式 =====

  async function toggleSortMode() {
    if (sortMode) {
      exitSortMode();
      return;
    }
    if (manageMode) exitManageMode();
    sortMode = true;

    const all = await DB.getAll('memories');
    const scopeFilter = viewScope === 'all' ? (() => true) : (viewScope ? m => m.scope === viewScope : () => true);
    sortedList = all.filter(m =>
      (currentTab === 'events' ? m.type === 'event' : m.type === 'relation') && scopeFilter(m)
    );
    sortedList.sort((a, b) => {
      const oa = a.sortOrder ?? a.timestamp;
      const ob = b.sortOrder ?? b.timestamp;
      if (currentTab === 'events') return oa - ob;
      return ob - oa;
    });

    renderSortList();
  }

  function exitSortMode() {
    sortMode = false;
    sortedList = [];
    const bar = document.getElementById('memory-sort-bar');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    const container = document.getElementById('memory-list');
    if (container) container.style.paddingBottom = '';
    renderList();
  }

  function renderSortList() {
    const container = document.getElementById('memory-list');
    if (!container) return;
    container.style.paddingBottom = '72px';

    const bar = document.getElementById('memory-sort-bar');
    if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }

    container.innerHTML = sortedList.length === 0 ?
      '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无记忆</p>' :
      sortedList.map((m, i) => {
        let preview = '';
        if (m.type === 'relation') {
          preview = m.relationship ? `关系: ${m.relationship}` : (m.content || '').substring(0, 80);
        } else {
          const raw = _getContent(m);
          preview = raw.substring(0, 80) + (raw.length > 80 ? '…' : '');
        }
        return `
        <div class="sort-item" style="display:flex;align-items:center;gap:8px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:6px;transition:transform 0.15s ease,opacity 0.15s ease" data-sort-idx="${i}">
          <div class="sort-handle" style="display:flex;align-items:center;justify-content:center;width:24px;flex-shrink:0;cursor:grab;color:var(--text-secondary);font-size:18px;user-select:none;-webkit-user-select:none;touch-action:none">≡</div>
          <div style="flex:1;overflow:hidden">
            <h3 style="margin:0 0 2px 0;font-size:13px;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.title)}</h3>
            <p style="margin:0;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(preview)}</p>
          </div>
          <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0">${i + 1}</span>
        </div>`;
      }).join('');

    // 绑定拖拽事件
    _bindSortDrag(container);
  }

  // ===== 拖拽排序 =====
  let _dragState = null;

  function _bindSortDrag(container) {
    const items = container.querySelectorAll('.sort-item');
    items.forEach(item => {
      const handle = item.querySelector('.sort-handle');
      if (!handle) return;

      handle.addEventListener('touchstart', e => {
        e.preventDefault();
        const touch = e.touches[0];
        const rect = item.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        // 创建占位符
        const placeholder = document.createElement('div');
        placeholder.className = 'sort-placeholder';
        placeholder.style.cssText = `height:${rect.height}px;margin-bottom:6px;border:2px dashed var(--border);border-radius:var(--radius);background:transparent;box-sizing:border-box`;

        // 浮起卡片
        item.style.position = 'fixed';
        item.style.left = rect.left + 'px';
        item.style.width = rect.width + 'px';
        item.style.top = rect.top + 'px';
        item.style.zIndex = '9999';
        item.style.opacity = '0.9';
        item.style.boxShadow = '0 4px 16px rgba(0,0,0,0.2)';
        item.style.pointerEvents = 'none';
        item.style.transition = 'none';

        item.parentNode.insertBefore(placeholder, item);

        _dragState = {
          item,
          placeholder,
          container,
          idx: parseInt(item.dataset.sortIdx),
          startY: touch.clientY,
          itemTop: rect.top,
          itemHeight: rect.height + 6, // 含 margin
          scrollContainer: container.closest('.panel-content') || container.parentElement
        };

        // 拖拽期间才绑定全局事件
        document.addEventListener('touchmove', _onSortTouchMove, { passive: false });
        document.addEventListener('touchend', _onSortTouchEnd);
        document.addEventListener('touchcancel', _onSortTouchEnd);
      }, { passive: false });
    });

    // 全局 touch 事件（只在 container 级别）——不绑 touchmove preventDefault，让页面正常滚动
    // touchmove 的 preventDefault 只在 _dragState 激活时通过 handle 的 touchstart 注册
  }

  function _onSortTouchMove(e) {
    if (!_dragState) return;
    e.preventDefault();
    const touch = e.touches[0];
    const dy = touch.clientY - _dragState.startY;
    _dragState.item.style.top = (_dragState.itemTop + dy) + 'px';

    // 自动滚动：拖到容器边缘时滚动页面
    const sc = _dragState.scrollContainer;
    if (sc) {
      const scRect = sc.getBoundingClientRect();
      const edgeZone = 60; // 距离边缘多少像素开始滚动
      const speed = 8;
      if (touch.clientY < scRect.top + edgeZone) {
        sc.scrollTop -= speed;
      } else if (touch.clientY > scRect.bottom - edgeZone) {
        sc.scrollTop += speed;
      }
    }

    // 找到当前悬停位置对应的目标索引
    const allItems = _dragState.container.querySelectorAll('.sort-item, .sort-placeholder');
    let targetIdx = _dragState.idx;
    const dragCenterY = _dragState.itemTop + dy + _dragState.item.offsetHeight / 2;

    for (let i = 0; i < allItems.length; i++) {
      const el = allItems[i];
      if (el === _dragState.item) continue;
      const r = el.getBoundingClientRect();
      const midY = r.top + r.height / 2;
      if (el.classList.contains('sort-placeholder')) {
        targetIdx = i;
        continue;
      }
      // 判断是否跨越了某个元素的中线
      const elIdx = parseInt(el.dataset.sortIdx);
      if (dragCenterY < midY && elIdx < _dragState.idx) {
        // 向上移动
        _dragState.container.insertBefore(_dragState.placeholder, el);
        break;
      } else if (dragCenterY > midY && elIdx > _dragState.idx) {
        // 向下移动
        if (el.nextSibling) {
          _dragState.container.insertBefore(_dragState.placeholder, el.nextSibling);
        } else {
          _dragState.container.appendChild(_dragState.placeholder);
        }
      }
    }
  }

  function _onSortTouchEnd() {
    if (!_dragState) return;
    const { item, placeholder, container } = _dragState;

    // 找到 placeholder 在同级里的位置
    const allChildren = Array.from(container.children);
    const newIdx = allChildren.indexOf(placeholder);

    // 还原卡片样式
    item.style.position = '';
    item.style.left = '';
    item.style.width = '';
    item.style.top = '';
    item.style.zIndex = '';
    item.style.opacity = '';
    item.style.boxShadow = '';
    item.style.pointerEvents = '';
    item.style.transition = '';

    // 把卡片放到 placeholder 位置
    container.insertBefore(item, placeholder);
    placeholder.remove();

    // 计算新索引（排除非 sort-item 的元素）
    const sortItems = Array.from(container.querySelectorAll('.sort-item'));
    const oldIdx = _dragState.idx;
    const realNewIdx = sortItems.indexOf(item);

    if (realNewIdx !== -1 && realNewIdx !== oldIdx) {
      // 更新 sortedList 数组
      const [moved] = sortedList.splice(oldIdx, 1);
      sortedList.splice(realNewIdx, 0, moved);
      // 重新渲染（更新序号和 data-sort-idx）
      renderSortList();
    }

    _dragState = null;

    // 移除全局拖拽事件
    document.removeEventListener('touchmove', _onSortTouchMove);
    document.removeEventListener('touchend', _onSortTouchEnd);
    document.removeEventListener('touchcancel', _onSortTouchEnd);
  }

  async function saveSortOrder() {
    for (let i = 0; i < sortedList.length; i++) {
      const m = sortedList[i];
      m.sortOrder = i;
      await DB.put('memories', m);
    }
    exitSortMode();
  }

  function toggleSelect(id) {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
    renderList();
  }

  function toggleSelectAll() {
    const allIds = Array.from(document.querySelectorAll('#memory-list .card'))
      .map(el => el.dataset.id);
    if (selectedIds.size === allIds.length && allIds.length > 0) {
      selectedIds.clear();
    } else {
      selectedIds = new Set(allIds);
    }
    renderList();
  }

  function updateSelectAllIcon() {
    const icon = document.getElementById('memory-select-all-icon');
    if (!icon) return;
    const allIds = Array.from(document.querySelectorAll('#memory-list .card'))
      .map(el => el.dataset.id);
    if (selectedIds.size === 0) {
      icon.innerHTML = '';
      icon.style.background = 'transparent';
      icon.style.borderColor = 'var(--text-secondary)';
    } else if (selectedIds.size === allIds.length && allIds.length > 0) {
      icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
      icon.style.background = 'var(--accent)';
      icon.style.borderColor = 'var(--accent)';
    } else {
      icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
      icon.style.background = 'var(--accent-dim)';
      icon.style.borderColor = 'var(--accent)';
    }
  }

  async function batchClone() {
    if (selectedIds.size === 0) {
      await UI.showAlert('提示', '请先选择要复制的记忆');
      return;
    }
    for (const id of selectedIds) {
      const src = await DB.get('memories', id);
      if (!src) continue;
      const cloned = { ...src, id: Utils.uuid(), timestamp: Utils.timestamp() };
      cloned.title = cloned.title + ' (副本)';
      await DB.put('memories', cloned);
    }
    selectedIds.clear();
    updateSelectAllIcon();
    renderList();
  }

  async function batchDelete() {
    if (selectedIds.size === 0) {
      await UI.showAlert('提示', '请先选择要删除的记忆');
      return;
    }
    if (!await UI.showConfirm('批量删除', `确定删除选中的 ${selectedIds.size} 条记忆？`)) return;
    for (const id of selectedIds) {
      await DB.del('memories', id);
    }
    selectedIds.clear();
    updateSelectAllIcon();
    renderList();
  }

  // ===== 合并功能 =====

  async function batchMerge() {
    if (selectedIds.size < 2) {
      await UI.showAlert('提示', '请选择至少2条记忆进行合并');
      return;
    }
    // 获取选中的记忆
    const items = [];
    for (const id of selectedIds) {
      const m = await DB.get('memories', id);
      if (m) items.push(m);
    }
    if (items.length < 2) return;

    // 检查类型一致性
    const types = new Set(items.map(m => m.type));
    if (types.size > 1) {
      await UI.showAlert('提示', '只能合并同类型的记忆（事件和事件合并，或关系和关系合并）');
      return;
    }
    const mergeType = items[0].type;

    // 按时间戳排序（旧的在前）
    items.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // 退出管理模式，进入编辑
    const idsToMerge = items.map(m => m.id);
    exitManageMode();

    // 预填编辑面板
    editingId = null;
    document.getElementById('mem-edit-type').value = mergeType;
    const editTypeLabel = document.getElementById('mem-edit-type-label');

    if (mergeType === 'relation') {
      if (editTypeLabel) editTypeLabel.innerHTML = `${_relationIcon} 人际关系`;
      // 名字取第一个
      document.getElementById('mem-edit-relation-name-input').value = items[0].title || '';
      // 关系描述拼接
      document.getElementById('mem-edit-relation-relationship-input').value =
        items.map(m => m.relationship || '').filter(Boolean).join('\n');
      // 印象拼接
      document.getElementById('mem-edit-relation-impression-input').value =
        items.map(m => m.impression || '').filter(Boolean).join('\n');
      // 情感合并去重
      const allEmotions = items.flatMap(m => m.emotions || []);
      _mergeEmotionsForEdit(allEmotions);

      document.getElementById('mem-edit-relation-fields').style.display = '';
      document.getElementById('mem-edit-event-fields').style.display = 'none';
    } else {
      if (editTypeLabel) editTypeLabel.innerHTML = `${_eventIcon} 事件`;
      // 标题拼接
      document.getElementById('mem-edit-title-input').value =
        items.map(m => m.title || '').filter(Boolean).join(' / ');
      // 时间取第一个
      document.getElementById('mem-edit-time-input').value = items[0].time || '';
      // 地点取第一个非空的
      document.getElementById('mem-edit-location-input').value =
        items.map(m => m.location).find(l => l) || '';
      // 参与者合并去重
      const allParts = [...new Set(items.flatMap(m => m.participants || []))];
document.getElementById('mem-edit-participants-input').value = allParts.join('、');
        // 内容合并（用分隔线拼接各条的content）
document.getElementById('mem-edit-content').value =
          items.map(m => _getContent(m)).filter(Boolean).join('\n───\n');

        document.getElementById('mem-edit-event-fields').style.display = '';
      document.getElementById('mem-edit-relation-fields').style.display = 'none';
      updateEventInfoCard();
    }

    // 设置scope为第一条的
    await updateEditScopeCard(items[0].scope || '');

    // 标记为合并模式（存储要删除的ID）
    _pendingMergeIds = idsToMerge;
    document.querySelector('#panel-memory-edit h2').textContent =
      mergeType === 'event' ? `合并事件 (${items.length}条)` : `合并人物 (${items.length}条)`;
    UI.showPanel('memory-edit');
    setTimeout(() => initAutoResizeTextareas(), 350);
  }

  // ===== UI - 复制/导入导出 =====

  function _formatMemoryText(m) {
    let text = '';
    if (m.type === 'relation') {
      text = `【人物】${m.title}\n`;
      if (m.relationship) text += `关系：${m.relationship}\n`;
      if (m.impression) text += `印象：${m.impression}\n`;
      if (m.emotions?.length) m.emotions.forEach(e => { text += `情感：${e}\n`; });
    } else {
      text = `【事件】${m.title}\n`;
      if (m.time) text += `时间：${m.time}\n`;
      if (m.location) text += `地点：${m.location}\n`;
      if (m.participants?.length) text += `参与者：${m.participants.join(', ')}\n`;
      const content = _getContent(m);
      if (content) text += `内容：${content}\n`;
    }
    return text.trimEnd();
  }

  function _parseMemoryText(text) {
    // 按 【事件】 或 【人物】 分割为多条
    const blocks = text.split(/(?=【(?:事件|人物)】)/).filter(b => b.trim());
    const results = [];
    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;

      const headerMatch = lines[0].match(/^【(事件|人物)】(.*)$/);
      if (!headerMatch) continue;

      const isRelation = headerMatch[1] === '人物';
      const title = headerMatch[2].trim();

      if (isRelation) {
        const m = { type: 'relation', title, relationship: '', impression: '', emotions: [] };
        for (let i = 1; i < lines.length; i++) {
          const l = lines[i];
          if (l.startsWith('关系：') || l.startsWith('关系:')) m.relationship = l.replace(/^关系[：:]/, '').trim();
          else if (l.startsWith('印象：') || l.startsWith('印象:')) m.impression = l.replace(/^印象[：:]/, '').trim();
          else if (l.startsWith('情感：') || l.startsWith('情感:')) m.emotions.push(l.replace(/^情感[：:]/, '').trim());
        }
        results.push(m);
      } else {
        const m = { type: 'event', title, time: '', location: '', participants: [], cause: '', process: '', result: '', note: '' };
        for (let i = 1; i < lines.length; i++) {
          const l = lines[i];
          if (l.startsWith('时间：') || l.startsWith('时间:')) m.time = l.replace(/^时间[：:]/, '').trim();
          else if (l.startsWith('地点：') || l.startsWith('地点:')) m.location = l.replace(/^地点[：:]/, '').trim();
          else if (l.startsWith('参与者：') || l.startsWith('参与者:')) m.participants = l.replace(/^参与者[：:]/, '').trim().split(/[,，、]/).map(s => s.trim()).filter(Boolean);
        else if (l.startsWith('内容：') || l.startsWith('内容:')) m.content = l.replace(/^内容[：:]/, '').trim();
        else if (l.startsWith('开端：') || l.startsWith('开端:')) { if (!m.content) m.content = ''; m.content += (m.content ? '\n' : '') + '开端：' + l.replace(/^开端[：:]/, '').trim(); }
        else if (l.startsWith('过程：') || l.startsWith('过程:')) { if (!m.content) m.content = ''; m.content += (m.content ? '\n' : '') + '过程：' + l.replace(/^过程[：:]/, '').trim(); }
        else if (l.startsWith('结果：') || l.startsWith('结果:')) { if (!m.content) m.content = ''; m.content += (m.content ? '\n' : '') + '结果：' + l.replace(/^结果[：:]/, '').trim(); }
        else if (l.startsWith('备注：') || l.startsWith('备注:')) { if (!m.content) m.content = ''; m.content += (m.content ? '\n' : '') + '备注：' + l.replace(/^备注[：:]/, '').trim(); }
        }
        results.push(m);
      }
    }
    return results;
  }

  // 复制当前编辑中的记忆为文本
  function copyCurrentEdit() {
    const type = document.getElementById('mem-edit-type').value;
    let m;
    if (type === 'relation') {
      m = {
        type: 'relation',
        title: document.getElementById('mem-edit-relation-name-input').value.trim(),
        relationship: document.getElementById('mem-edit-relation-relationship-input').value.trim(),
        impression: document.getElementById('mem-edit-relation-impression-input').value.trim(),
        emotions: _collectEmotionsForEdit()
      };
    } else {
      m = {
        type: 'event',
        title: document.getElementById('mem-edit-title-input').value.trim(),
        time: document.getElementById('mem-edit-time-input').value.trim(),
        location: document.getElementById('mem-edit-location-input').value.trim(),
participants: document.getElementById('mem-edit-participants-input').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
          content: document.getElementById('mem-edit-content').value.trim()
        };
    }
    const text = _formatMemoryText(m);
    try {
      navigator.clipboard.writeText(text);
      GameLog.log('info', '已复制为文本');
    } catch(e) {
      UI.showToast('复制失败，请手动复制', 2000);
    }
  }

  // 粘贴文本到当前编辑面板（打开导入弹窗，只取第一条）
  async function pasteToCurrentEdit() {
    document.getElementById('memory-import-content').value = '';
    // 标记为粘贴模式
    _pasteMode = true;
    document.getElementById('memory-import-modal').classList.remove('hidden');
  }

  // 导出选中记忆为文本文件
  async function exportSelected() {
    if (selectedIds.size === 0) {
      await UI.showAlert('提示', '请先选择要导出的记忆');
      return;
    }
    const items = [];
    for (const id of selectedIds) {
      const m = await DB.get('memories', id);
      if (m) items.push(m);
    }
    items.sort((a, b) => (a.sortOrder ?? a.timestamp) - (b.sortOrder ?? b.timestamp));
    const text = items.map(m => _formatMemoryText(m)).join('\n\n');

    // 下载为 txt 文件
    const tabName = currentTab === 'events' ? '事件' : '人际关系';
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `记忆导出_${tabName}_${dateStr}.txt`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // 同时复制到剪贴板
    try { await navigator.clipboard.writeText(text); } catch(e) {}
    GameLog.log('info', `已导出 ${items.length} 条记忆`);
  }

  // 导入文本为记忆（打开弹窗）
  function importFromText() {
    document.getElementById('memory-import-content').value = '';
    document.getElementById('memory-import-modal').classList.remove('hidden');
  }

  async function closeImportModal() {
    _pasteMode = false;
    const modal = document.getElementById('memory-import-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
  }

  async function confirmImport() {
    const text = document.getElementById('memory-import-content').value.trim();
    if (!text) {
      await UI.showAlert('提示', '请输入内容');
      return;
    }

    const parsed = _parseMemoryText(text);
    if (parsed.length === 0) {
      await UI.showAlert('提示', '无法识别格式。请使用【事件】或【人物】开头的格式。');
      return;
    }

    // 粘贴模式：取第一条填入编辑面板
    if (_pasteMode) {
      const m = parsed[0];
      document.getElementById('mem-edit-type').value = m.type;
      const editTypeLabel = document.getElementById('mem-edit-type-label');
      if (m.type === 'relation') {
        if (editTypeLabel) editTypeLabel.innerHTML = `${_relationIcon} 人际关系`;
        document.getElementById('mem-edit-relation-name-input').value = m.title || '';
        document.getElementById('mem-edit-relation-relationship-input').value = m.relationship || '';
        document.getElementById('mem-edit-relation-impression-input').value = m.impression || '';
        _mergeEmotionsForEdit(m.emotions || []);
        document.getElementById('mem-edit-relation-fields').style.display = '';
        document.getElementById('mem-edit-event-fields').style.display = 'none';
      } else {
        if (editTypeLabel) editTypeLabel.innerHTML = `${_eventIcon} 事件`;
        document.getElementById('mem-edit-title-input').value = m.title || '';
        document.getElementById('mem-edit-time-input').value = m.time || '';
        document.getElementById('mem-edit-location-input').value = m.location || '';
        document.getElementById('mem-edit-participants-input').value = (m.participants || []).join('、');
    document.getElementById('mem-edit-content').value = _getContent(m);
    document.getElementById('mem-edit-event-fields').style.display = '';
    document.getElementById('mem-edit-relation-fields').style.display = 'none';
    updateEventInfoCard();
      }
      document.querySelector('#panel-memory-edit h2').textContent = m.type === 'event' ? '编辑事件' : '编辑人际关系';
      initAutoResizeTextareas();
      _pasteMode = false;
      await closeImportModal();
      return;
    }

    // 批量导入模式
    if (!await UI.showConfirm('导入确认', `识别到 ${parsed.length} 条记忆，确认导入？`)) return;

    const scope = Character.getCurrentId();
    for (const m of parsed) {
      const memory = {
        id: Utils.uuid(),
        type: m.type,
        title: m.title || '',
        scope,
        pinned: true,
        timestamp: Utils.timestamp(),
        createdAt: Date.now()
      };
      if (m.type === 'relation') {
        memory.relationship = m.relationship || '';
        memory.impression = m.impression || '';
        memory.emotions = m.emotions || [];
        memory.content = m.relationship || '';
        memory.keywords = Utils.tokenize(m.title + ' ' + (m.relationship || '') + ' ' + (m.impression || ''));
        memory.participants = [m.title];
      } else {
        memory.time = m.time || '';
        memory.location = m.location || '';
        memory.content = m.content || _mergeEventContent(m);
        memory.participants = m.participants || [];
        memory.keywords = Utils.tokenize(m.title + ' ' + (m.location || '') + ' ' + (m.content || _mergeEventContent(m)));
      }
      await DB.put('memories', memory);
    }
    GameLog.log('info', `成功导入 ${parsed.length} 条记忆`);
    await closeImportModal();
    exitManageMode();
    renderList();
  }

  async function copyMemory(id) {
    const m = await DB.get('memories', id);
    if (!m) return;
    const text = _formatMemoryText(m);
    try {
      await navigator.clipboard.writeText(text);
      GameLog.log('info', '已复制记忆');
    } catch(e) {
      UI.showToast('复制失败，请手动复制', 2000);
    }
  }

  // ===== 情感列表动态渲染 =====

let editingEmotionIdx = null;
let editingEmotionListId = null; // 'edit' 或 'add'

function renderEmotionList(emotions, containerId, listType) {
  const container = document.getElementById(containerId);
  if (!container) return;
    container.innerHTML = (emotions || []).map((e, i) => `
      <div class="emotion-card" data-index="${i}" data-list-type="${listType}" style="position:relative;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer;width:100%;box-sizing:border-box;min-height:56px;display:flex;align-items:center">
        <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%">${Utils.escapeHtml(e || '(空)')}</div>
      </div>
    `).join('');

  // 添加点击编辑
  container.querySelectorAll('.emotion-card').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.index);
      const listType = card.dataset.listType;
      Memory.editEmotion(idx, listType);
    });
  });
  }

function addEmotion() {
  const current = _collectEmotionsForEdit();
  current.push('');
  renderEmotionList(current, 'mem-edit-emotions-list', 'edit');
  // 自动打开新情感编辑
  Memory.editEmotion(current.length - 1, 'edit');
}

function editEmotion(idx, listType) {
  editingEmotionIdx = idx;
  editingEmotionListId = listType;
  const list = _collectEmotionsForEdit();
  const emotion = list[idx] || '';
  document.getElementById('emotion-edit-content').value = emotion;
  document.getElementById('emotion-edit-modal').classList.remove('hidden');
}

async function saveEmotion() {
  const content = document.getElementById('emotion-edit-content').value.trim();
  if (editingEmotionListId === 'edit') {
  const list = _collectEmotionsForEdit();
  list[editingEmotionIdx] = content;
  renderEmotionList(list, 'mem-edit-emotions-list', 'edit');
  }
  closeEmotionModal();
}

async function deleteEmotion() {
  if (editingEmotionIdx === null) return;
  if (editingEmotionListId === 'edit') {
  const list = _collectEmotionsForEdit();
  list.splice(editingEmotionIdx, 1);
  renderEmotionList(list, 'mem-edit-emotions-list', 'edit');
  }
  closeEmotionModal();
}

async function closeEmotionModal() {
  const modal = document.getElementById('emotion-edit-modal');
  modal.classList.add('closing');
  const content = modal.querySelector('.modal-content');
  if (content) content.classList.add('closing');
  await new Promise(r => setTimeout(r, 150));
  modal.classList.remove('closing');
  if (content) content.classList.remove('closing');
  modal.classList.add('hidden');
  editingEmotionIdx = null;
  editingEmotionListId = null;
}

function _collectEmotionsForEdit() {
    const container = document.getElementById('mem-edit-emotions-list');
    if (!container) return [];
    return Array.from(container.querySelectorAll('.emotion-card'))
      .map(el => el.textContent?.trim() || '').filter(Boolean);
  }

  function _mergeEmotionsForEdit(emotions) {
    // 去重并渲染到编辑面板
    const unique = [...new Set(emotions.filter(Boolean))];
    renderEmotionList(unique, 'mem-edit-emotions-list', 'edit');
  }

// ===== 事件信息卡片与编辑弹窗 =====

  let editScopeDropdownVisible = false;

  async function renderEditScopeSelector() {
    const maskContainer = document.getElementById('mem-edit-scope-mask-options');
    if (!maskContainer) return;
    const maskData = await DB.get('gameState', 'maskList');
    const masks = maskData?.value || [{ id: 'default', name: '默认面具' }];
    maskContainer.innerHTML = masks.map(m => `<div data-value="${m.id}" onclick="Memory.selectEditScope('${m.id}')">${Utils.escapeHtml(m.name)}</div>`).join('');
  }

  function toggleEditScopeDropdown() {
    const dropdown = document.getElementById('mem-edit-scope-dropdown');
    editScopeDropdownVisible = !editScopeDropdownVisible;
    if (editScopeDropdownVisible) {
      dropdown.classList.remove('hidden', 'closing');
      setTimeout(() => {
        document.addEventListener('click', closeEditScopeDropdownOutside, { once: true });
      }, 0);
    } else {
      dropdown.classList.add('closing');
      setTimeout(() => {
        if (!editScopeDropdownVisible) {
          dropdown.classList.add('hidden');
          dropdown.classList.remove('closing');
        }
      }, 120);
    }
  }

  function closeEditScopeDropdownOutside(e) {
    const card = document.getElementById('mem-edit-mask-card');
    if (card && !card.contains(e.target)) {
      editScopeDropdownVisible = false;
      const dropdown = document.getElementById('mem-edit-scope-dropdown');
      dropdown.classList.add('closing');
      setTimeout(() => {
        dropdown.classList.add('hidden');
        dropdown.classList.remove('closing');
      }, 120);
    }
  }

  async function selectEditScope(val) {
    editScopeDropdownVisible = false;
    const dropdown = document.getElementById('mem-edit-scope-dropdown');
    dropdown.classList.add('closing');
    setTimeout(() => {
      dropdown.classList.add('hidden');
      dropdown.classList.remove('closing');
    }, 120);
    document.getElementById('mem-edit-scope').value = val;
    await updateEditScopeCard(val);
  }

  async function updateEditScopeCard(scopeId) {
    document.getElementById('mem-edit-scope').value = scopeId || '';
    const label = document.getElementById('mem-edit-scope-label');
    const avatarEl = document.getElementById('mem-edit-mask-avatar');
    if (!label || !avatarEl) return;

    const maskData = await DB.get('gameState', 'maskList');
    const masks = maskData?.value || [];

    if (!scopeId) {
      label.textContent = '选择面具';
      avatarEl.src = '';
      avatarEl.style.background = 'var(--bg-tertiary)';
      return;
    }

    const mask = masks.find(m => m.id === scopeId);
    if (mask) {
      label.textContent = mask.name;
      const charData = await DB.get('characters', scopeId);
      if (charData?.avatar) {
        avatarEl.src = charData.avatar;
      } else {
        avatarEl.src = '';
        avatarEl.style.background = 'var(--bg-tertiary)';
      }
    } else {
      label.textContent = '选择面具';
      avatarEl.src = '';
      avatarEl.style.background = 'var(--bg-tertiary)';
    }
  }

  async function edit(id) {
    const m = await DB.get('memories', id);
    if (!m) return;
    editingId = id;

    document.getElementById('mem-edit-type').value = m.type || 'event';
    // 更新类型下拉label
    const typeLabel = document.getElementById('mem-edit-type-label');
    if (typeLabel) {
      typeLabel.innerHTML = (m.type || 'event') === 'event'
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="m12.296 3.464 3.02 3.956"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m6.18 5.276 3.1 3.899"/></svg> 事件'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/></svg> 人际关系';
    }
    document.getElementById('mem-edit-title-input').value = m.title || '';

    // 关系记忆：填拆分字段
    const isRelation = m.type === 'relation';
    document.getElementById('mem-edit-relation-fields').style.display = isRelation ? '' : 'none';
    document.getElementById('mem-edit-event-fields').style.display = isRelation ? 'none' : '';

    if (isRelation) {
    document.getElementById('mem-edit-relation-name-input').value = m.title || '';
    document.getElementById('mem-edit-relation-relationship-input').value = m.relationship || '';
    document.getElementById('mem-edit-relation-impression-input').value = m.impression || '';
    renderEmotionList(m.emotions || [], 'mem-edit-emotions-list', 'edit');
    // 刷新关系信息卡片
    updateRelationInfoCard();
 } else {
      document.getElementById('mem-edit-time-input').value = m.time || '';
      document.getElementById('mem-edit-location-input').value = m.location || '';
      document.getElementById('mem-edit-participants-input').value = (m.participants || []).join(', ');
      document.getElementById('mem-edit-content').value = _getContent(m);
      // 更新事件信息卡片
      updateEventInfoCard();
    }

    await updateEditScopeCard(m.scope || '');
    document.querySelector('#panel-memory-edit h2').textContent = (m.type || 'event') === 'event' ? '编辑事件' : '编辑人际关系';
    UI.showPanel('memory-edit');
    initAutoResizeTextareas();
  }

  async function saveEdit() {
    const type = document.getElementById('mem-edit-type').value;
    const scope = document.getElementById('mem-edit-scope').value;
    
    let memory;
    if (editingId) {
      // 编辑模式
      memory = await DB.get('memories', editingId);
      if (!memory) return;
    } else {
      // 新建模式
      memory = {
        id: Utils.uuid(),
        type,
        scope,
        pinned: true,
        createdAt: Date.now()
      };
    }
    
    memory.type = type;
    memory.scope = scope;
    
    if (type === 'relation') {
      const name = document.getElementById('mem-edit-relation-name-input').value.trim();
      const relationship = document.getElementById('mem-edit-relation-relationship-input').value.trim();
      const impression = document.getElementById('mem-edit-relation-impression-input').value.trim();
      const emotions = _collectEmotionsForEdit();
      
      memory.title = name;
      memory.relationship = relationship;
      memory.impression = impression;
      memory.emotions = emotions;
      memory.content = relationship;
      memory.keywords = Utils.tokenize(name + ' ' + relationship + ' ' + impression);
      
      if (!name) { await UI.showAlert('提示', '请填写姓名'); return; }
    } else {
      memory.title = document.getElementById('mem-edit-title-input').value.trim();
      memory.time = document.getElementById('mem-edit-time-input').value.trim();
      memory.location = document.getElementById('mem-edit-location-input').value.trim();
      memory.participants = document.getElementById('mem-edit-participants-input').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
      memory.content = document.getElementById('mem-edit-content').value.trim();
      memory.keywords = Utils.tokenize(memory.title + ' ' + memory.location + ' ' + memory.content);
      
      if (!memory.title) { await UI.showAlert('提示', '请填写标题'); return; }
    }
    
    await DB.put('memories', memory);

    // 合并模式：删除原始条目
    if (_pendingMergeIds && _pendingMergeIds.length > 0) {
      for (const oldId of _pendingMergeIds) {
        if (oldId !== memory.id) await DB.del('memories', oldId);
      }
      _pendingMergeIds = null;
    }

    closeEdit();
    renderList();
  }

  function _onEditTypeChange(val) {
    document.getElementById('mem-edit-relation-fields').style.display = val === 'relation' ? '' : 'none';
    document.getElementById('mem-edit-event-fields').style.display = val === 'relation' ? 'none' : '';
  }

  function closeEdit() {
    editingId = null;
    _pendingMergeIds = null;
    document.querySelector('#panel-memory-edit h2').textContent = '编辑记忆';
    UI.showPanel('memory');
  }

  // ===== 自动调整textarea高度 =====

  function initAutoResizeTextareas() {
    const textareas = document.querySelectorAll('.auto-resize-textarea');
    textareas.forEach(textarea => {
      // 初始化已有内容的高度
      textarea.style.height = 'auto';
    textarea.style.height = Math.max(60, textarea.scrollHeight) + 'px';
    // 添加输入事件监听
    textarea.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.max(60, this.scrollHeight) + 'px';
    });
    });
  }

  // ===== UI - 手动添加 =====

  function addManual() {
    editingId = null;
    const type = currentTab === 'events' ? 'event' : 'relation';
    document.getElementById('mem-edit-type').value = type;
    // 更新类型下拉label
    const editTypeLabel = document.getElementById('mem-edit-type-label');
    if (editTypeLabel) {
      document.getElementById('mem-edit-type-label').innerHTML = type === 'event' ? `${_eventIcon} 事件` : `${_relationIcon} 人际关系`;
    }
    // 清空事件字段
    ['mem-edit-title-input','mem-edit-time-input','mem-edit-location-input','mem-edit-participants-input','mem-edit-content'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    // 清空关系字段
    document.getElementById('mem-edit-relation-name-input').value = '';
    document.getElementById('mem-edit-relation-relationship-input').value = '';
    document.getElementById('mem-edit-relation-impression-input').value = '';
    renderEmotionList([], 'mem-edit-emotions-list', 'edit');
    _onEditTypeChange(type);
    // 重置卡片
    if (type === 'event') {
      updateEventInfoCard();
    } else {
      updateRelationInfoCard();
    }
    // 设置归属为当前面具
    const currentMaskId = Character.getCurrentId();
    document.getElementById('mem-edit-scope').value = currentMaskId || '';
    updateEditScopeCard(currentMaskId || '');
    // 更新标题
    document.querySelector('#panel-memory-edit h2').textContent = type === 'event' ? '新建事件' : '新建人际关系';
    UI.showPanel('memory-edit');
    initAutoResizeTextareas();
  }

  // ===== UI - 删除 =====

  async function remove(id) {
    if (!await UI.showConfirm('确认删除', '确定删除这条记忆？')) return;
    await DB.del('memories', id);
    renderList();
  }

  async function deleteNoteConfirm(id) {
    if (!await UI.showConfirm('删除小纸条', '确定删除这条小纸条？')) return;
    await DB.del('memories', id);
    renderList();
  }

  // ===== UI - 搜索 =====

  function search(query) {
    searchQuery = query.toLowerCase();
    renderList();
  }

  // ===== 事件信息卡片与编辑弹窗 =====

  function updateEventInfoCard() {
    const title = document.getElementById('mem-edit-title-input').value.trim();
    const time = document.getElementById('mem-edit-time-input').value.trim();
    const location = document.getElementById('mem-edit-location-input').value.trim();
    const participants = document.getElementById('mem-edit-participants-input').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean);

    document.getElementById('mem-edit-card-title').textContent = title || '-';
    document.getElementById('mem-edit-card-time').textContent = time || '-';
    document.getElementById('mem-edit-card-location').textContent = location || '-';

    const tagsContainer = document.getElementById('mem-edit-card-participants');
    tagsContainer.innerHTML = participants.map(p =>
      `<span style="border:1px solid var(--accent);color:var(--accent);border-radius:12px;padding:4px 10px;font-size:12px;background:transparent">${p}</span>`
    ).join('') || '<span style="color:var(--text-secondary);font-size:14px">-</span>';
  }

  function openEventInfoModal() {
    document.getElementById('event-info-edit-title').value = document.getElementById('mem-edit-title-input').value.trim();
    document.getElementById('event-info-edit-time').value = document.getElementById('mem-edit-time-input').value.trim();
    document.getElementById('event-info-edit-location').value = document.getElementById('mem-edit-location-input').value.trim();
    document.getElementById('event-info-edit-participants').value = document.getElementById('mem-edit-participants-input').value.trim();
    document.getElementById('event-info-edit-modal').classList.remove('hidden');
  }

  function closeEventInfoModal() {
    document.getElementById('event-info-edit-modal').classList.add('hidden');
  }

  function saveEventInfo() {
    document.getElementById('mem-edit-title-input').value = document.getElementById('event-info-edit-title').value.trim();
    document.getElementById('mem-edit-time-input').value = document.getElementById('event-info-edit-time').value.trim();
    document.getElementById('mem-edit-location-input').value = document.getElementById('event-info-edit-location').value.trim();
    document.getElementById('mem-edit-participants-input').value = document.getElementById('event-info-edit-participants').value.trim();
    updateEventInfoCard();
    closeEventInfoModal();
  }

  // ===== 关系信息卡片与编辑弹窗 =====

  function updateRelationInfoCard() {
    const name = document.getElementById('mem-edit-relation-name-input').value.trim();
    const relationship = document.getElementById('mem-edit-relation-relationship-input').value.trim();
    const impression = document.getElementById('mem-edit-relation-impression-input').value.trim();

    document.getElementById('mem-edit-relation-name').textContent = name || '-';
    document.getElementById('mem-edit-relation-relationship').textContent = relationship || '-';
    document.getElementById('mem-edit-relation-impression').textContent = impression || '-';
  }

  function openRelationInfoModal() {
    document.getElementById('relation-info-edit-name').value = document.getElementById('mem-edit-relation-name-input').value.trim();
    document.getElementById('relation-info-edit-relationship').value = document.getElementById('mem-edit-relation-relationship-input').value.trim();
    document.getElementById('relation-info-edit-impression').value = document.getElementById('mem-edit-relation-impression-input').value.trim();
    document.getElementById('relation-info-edit-modal').classList.remove('hidden');
  }

  function closeRelationInfoModal() {
    document.getElementById('relation-info-edit-modal').classList.add('hidden');
  }

  function saveRelationInfo() {
    document.getElementById('mem-edit-relation-name-input').value = document.getElementById('relation-info-edit-name').value.trim();
    document.getElementById('mem-edit-relation-relationship-input').value = document.getElementById('relation-info-edit-relationship').value.trim();
    document.getElementById('mem-edit-relation-impression-input').value = document.getElementById('relation-info-edit-impression').value.trim();
    updateRelationInfoCard();
    closeRelationInfoModal();
  }

  // ===== 面板初始化时渲染面具选择器 =====
  async function onPanelShow() {
    await renderScopeSelector();
    await renderEditScopeSelector();
    renderList();
    await updateCurrentMaskCard();
    initAutoResizeTextareas();
  }

  // ===== 克隆记忆库 =====
  async function cloneScope(oldScope, newScope) {
    const all = await DB.getAll('memories');
    const targets = all.filter(m => (m.scope || 'default') === oldScope);
    for (const m of targets) {
      const cloned = { ...m, id: Utils.uuid(), scope: newScope };
      await DB.put('memories', cloned);
    }
  }

  // ===== 自定义下拉交互 =====

  const _eventIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="m12.296 3.464 3.02 3.956"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m6.18 5.276 3.1 3.899"/></svg>';
  const _relationIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/></svg>';

  function _toggleDropdown(dropdownId) {
    const dd = document.getElementById(dropdownId);
    if (!dd) return;
    const isHidden = dd.classList.contains('hidden');
    // 关闭所有dropdown
    document.querySelectorAll('.custom-dropdown').forEach(d => d.classList.add('hidden'));
    if (isHidden) {
      dd.classList.remove('hidden');
      setTimeout(() => {
        document.addEventListener('click', function _close(e) {
          if (!dd.contains(e.target) && !dd.previousElementSibling?.contains(e.target)) {
            dd.classList.add('hidden');
          }
          document.removeEventListener('click', _close);
        });
      }, 0);
    }
  }

  function _selectEditType(val) {
    document.getElementById('mem-edit-type').value = val;
    const label = document.getElementById('mem-edit-type-label');
    label.innerHTML = val === 'event' ? `${_eventIcon} 事件` : `${_relationIcon} 人际关系`;
    document.getElementById('mem-edit-type-dropdown').classList.add('hidden');
    _onEditTypeChange(val);
  }

  function _toggleEditTypeDropdown() { _toggleDropdown('mem-edit-type-dropdown'); }

function _toggleEditScopeDropdown() { _toggleDropdown('mem-edit-scope-dropdown'); }

  function _selectEditScope(id, name) {
    document.getElementById('mem-edit-scope').value = id;
    document.getElementById('mem-edit-scope-label').textContent = name;
    document.getElementById('mem-edit-scope-dropdown').classList.add('hidden');
  }

  return {
    add, upsertRelation, addNote, retrieve, retrieveNotes, formatNotesForPrompt, NOTE_TAGS, buildExtractionPrompt, formatForPrompt,
    showTab, renderList, edit, saveEdit, closeEdit, _onEditTypeChange, remove, deleteNoteConfirm,
    copyMemory, filterByScope, renderScopeSelector, onPanelShow,
    addManual,
    renderEmotionList,
    addEmotion, editEmotion, saveEmotion, deleteEmotion, closeEmotionModal,
    search, cloneScope,
    toggleScopeDropdown, selectScope, updateCurrentMaskCard, syncViewScopeToCurrent,
    _toggleEditTypeDropdown, _selectEditType,
    toggleEditScopeDropdown, selectEditScope, updateEditScopeCard,
    toggleManageMode, exitManageMode, toggleSelect, toggleSelectAll, updateSelectAllIcon, batchClone, batchDelete, batchMerge,
    toggleMenu, toggleSortMode, exitSortMode, saveSortOrder,
    copyCurrentEdit, pasteToCurrentEdit, exportSelected, importFromText, closeImportModal, confirmImport,
    updateEventInfoCard, openEventInfoModal, closeEventInfoModal, saveEventInfo,
    updateRelationInfoCard, openRelationInfoModal, closeRelationInfoModal, saveRelationInfo
  };
})();
