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
  // 强制返回字符串：防止 content 被存成对象/数组/数字（提取掉格式时可能发生）导致 .substring 崩溃
  function _getContent(m) {
    let c = m && m.content;
    if (c != null && c !== '') {
      if (typeof c === 'string') return c;
      if (typeof c === 'object') {
        // content 误存成对象/数组：尽量取出可读文本
        try { return JSON.stringify(c); } catch (_) { return String(c); }
      }
      return String(c);
    }
    return _mergeEventContent(m) || '';
  }

  async function add(type, data) {
    if (type === 'relation') {
      return upsertRelation(data);
    }
    const scope = data.scope || Character.getCurrentId();
    // content 强制转字符串：防止 AI 提取掉格式把 content 传成对象/数组，存进去后导致列表渲染崩溃
    let content = data.content;
    if (content != null && typeof content !== 'string') {
      try { content = (typeof content === 'object') ? JSON.stringify(content) : String(content); } catch (_) { content = String(content); }
    }
    content = content || _mergeEventContent(data);
    const title = data.title || '';
    // 自动提取事件去重：同面具 + 标题相似视为同一事件，避免重复提取
    try {
      const all = await DB.getAll('memories');
      const existing = all.find(m =>
        m.type === type &&
        (m.scope || 'default') === scope &&
        (m.title || '') && title && (
          (m.title || '') === title ||
          (m.title || '').includes(title) ||
          title.includes((m.title || ''))
        )
      );
      if (existing) {
        // 用新数据更新（更新内容到最新版本，补充缺失字段）
        if (content) existing.content = content;
        if (data.time) existing.time = data.time;
        existing.location = data.location || existing.location || '';
        existing.participants = (data.participants?.length ? data.participants : existing.participants) || [];
        existing.keywords = Utils.tokenize((existing.title || title) + ' ' + (existing.content || content) + ' ' + (existing.location || ''));
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

  const NOTE_PRIORITIES = ['pinned', 'important', 'normal'];

  async function addNote(data) {
    const scope = data.scope || Character.getCurrentId();
    const tag = NOTE_TAGS.includes(data.tag) ? data.tag : '有趣';
    const detail = String(data.detail || '').trim();
    if (!detail) return null;
    const priority = NOTE_PRIORITIES.includes(data.priority) ? data.priority : 'normal';

    // 去重：同 scope + 同 tag + 同 detail
    const all = await DB.getAll('memories');
    const dup = all.find(m => m.type === 'note' && m.scope === scope && m.tag === tag && m.detail === detail);
    if (dup) return dup;

    // 永久纸条软限额提醒（10 条）
    if (priority === 'pinned') {
      const pinnedCount = all.filter(m => m.type === 'note' && m.scope === scope && m.priority === 'pinned').length;
      if (pinnedCount >= 10) {
        try { UI.showToast(`永久小纸条已有 ${pinnedCount} 条，建议精简`, 2500); } catch(_) {}
      }
    }

    const memory = {
      id: Utils.uuid(),
      type: 'note',
      tag,
      detail,
      priority,
      time: data.time || '',
      characters: data.characters || [],
      scope,
      timestamp: Utils.timestamp(),
      roundCreated: data.roundCreated || 0
    };
    await DB.put('memories', memory);

    // FIFO：超出上限时只删 normal（永久和重要不删）
    const notes = all.filter(m => m.type === 'note' && m.scope === scope);
    notes.push(memory);
    if (notes.length > NOTE_MAX) {
      const normals = notes.filter(n => (!n.priority || n.priority === 'normal'));
      normals.sort((a, b) => a.timestamp - b.timestamp);
      const excess = notes.length - NOTE_MAX;
      const toRemove = normals.slice(0, Math.min(excess, normals.length));
      for (const old of toRemove) { try { await DB.delete('memories', old.id); } catch(_){} }
    }
    return memory;
  }

  /**
   * 小纸条检索：双路评分（在场角色 + 本轮用户输入命中），命中不够纯随机补，返回 3-5 条
   */
  // 简易中文停用词表
  const _NOTE_STOPWORDS = new Set([
    '我们','你们','他们','她们','它们','自己','这个','那个','这些','那些','什么',
    '怎么','为什么','可能','觉得','应该','但是','不过','然后','所以','因为',
    '一个','一下','一些','一直','一定','已经','或者','不是','就是','还是',
    '没有','现在','以后','以前','刚才','刚刚','上次','下次','可以','需要',
    '今天','明天','昨天','后来','后面','前面','里面','外面','上面','下面'
  ]);

  // 标签触发词库：用户输入命中某标签的触发词时，该标签的小纸条加权
  const NOTE_TAG_TRIGGERS = {
    '喜欢': ['喜欢','想吃','想要','爱吃','爱喝','馋','好吃','好看','心动','满意','偏爱','钟爱','愉悦','美味','迷恋','享受','不错'],
    '讨厌': ['讨厌','不喜欢','烦','受不了','恶心','不想','不要','反感','难吃','难看','难听','厌恶','抵触','拒绝','嫌弃','避开','离我远点'],
    '习惯': ['习惯','经常','总是','每次','下意识','忍不住','不自觉','惯例','照常','老样子','本能','熟练','顺手','自然而然'],
    '开心': ['开心','高兴','快乐','兴奋','笑','激动','喜悦','爽','笑容','嘴角上扬','满足','欢呼','眉飞色舞'],
    '感动': ['感动','破防','心软','温暖','鼻酸','泪目','触动','动容','欣慰','眼眶一热','想哭','暖意'],
    '安心': ['安心','放心','松口气','踏实','平静','宁静','安全','依靠','舒心','放松','卸下防备','喘息'],
    '期待': ['期待','想见','盼着','下次','希望','等待','向往','憧憬','跃跃欲试','迫不及待','祈祷'],
    '骄傲': ['骄傲','自豪','得意','哼','夸我','厉害','挺起胸膛','自信','底气','扬眉吐气','炫耀','成就感'],
    '悲伤': ['难过','伤心','哭','失落','委屈','悲伤','痛哭','哽咽','流泪','抽泣','沉重','心碎','黯然'],
    '愤怒': ['生气','愤怒','气死','火大','恼火','不爽','怒','咬牙','瞪','握拳','发脾气','发火','暴怒'],
    '恐惧': ['害怕','恐惧','怕','吓','不安','危险','紧张','发抖','颤抖','恐慌','惊恐','退缩','畏惧','寒意'],
    '痛苦': ['痛苦','崩溃','绝望','心疼','疼','痛','煎熬','折磨','挣扎','窒息','难以忍受'],
    '迷茫': ['迷茫','不知所措','茫然','懵','疑惑','为什么','怎么办','乱','迟疑','犹豫','找不着北','困惑','发呆'],
    '不悦': ['不悦','皱眉','撇嘴','沉下脸','冷脸','不满','抱怨','啧','切','烦躁','扫兴','郁结'],
    '秘密': ['秘密','别告诉','瞒着','偷偷','保密','不让知道','隐藏','掩饰','私下','悄悄','嘘','隐瞒'],
    '伏笔': ['以后','总有一天','迟早','线索','调查','真相','约定','怀疑','到底','背后','预感','探究','谜团'],
    '有趣': ['好笑','离谱','有趣','奇怪','莫名其妙','搞笑','逗','乐子','奇葩','幽默','打趣','恶作剧']
  };

  function _extractDetailTokens(detail) {
    if (!detail) return [];
    // 切 2-4 字滑动窗口 token，过滤纯标点/纯空白/停用词
    const s = String(detail);
    const tokens = new Set();
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= s.length; i++) {
        const tok = s.slice(i, i + len);
        // 过滤纯标点、含空白、纯数字
        if (/^[\s\p{P}]+$/u.test(tok)) continue;
        if (/\s/.test(tok)) continue;
        if (_NOTE_STOPWORDS.has(tok)) continue;
        tokens.add(tok);
      }
    }
    return [...tokens];
  }

  async function retrieveNotes(presentNPCNames = [], userInputText = '') {
    const allMemories = await DB.getAll('memories');
    const currentScope = Character.getCurrentId();
    // 排除永久纸条（永久走单独注入通道）
    const notes = allMemories.filter(m => m.type === 'note' && m.scope === currentScope && m.priority !== 'pinned');
    if (notes.length === 0) return [];

    const userText = String(userInputText || '');
    const importantNotes = notes.filter(n => n.priority === 'important');
    const normalNotes = notes.filter(n => !n.priority || n.priority === 'normal');

    // 预计算：用户输入命中了哪些标签的触发词
    const triggeredTags = new Set();
    if (userText) {
      for (const [tag, words] of Object.entries(NOTE_TAG_TRIGGERS)) {
        if (words.some(w => userText.includes(w))) triggeredTags.add(tag);
      }
    }

    // 计算匹配分（三路）
    const scored = notes.map(n => {
      let score = 0;
      // 路1：角色命中
      if (n.characters?.length && presentNPCNames.length) {
        const hit = n.characters.some(c => presentNPCNames.includes(c));
        if (hit) score += 2;
      }
      // 路2：用户本轮输入命中 detail 关键词
      if (userText && n.detail) {
        const tokens = _extractDetailTokens(n.detail);
        const anyHit = tokens.some(t => userText.includes(t));
        if (anyHit) score += 3;
      }
      // 路3：标签触发词命中（用户输入的情绪/行为词 → 对应标签纸条加权）
      if (triggeredTags.has(n.tag)) score += 1;
      return { note: n, score };
    });

    const matched = scored.filter(s => s.score > 0).map(s => s.note);
    const matchedIds = new Set(matched.map(n => n.id));

    // 目标抽 3-5 条
    const targetCount = Math.min(notes.length, 3 + Math.floor(Math.random() * 3));

    let result;
    if (matched.length >= targetCount) {
      const shuffled = matched.slice().sort(() => Math.random() - 0.5);
      result = shuffled.slice(0, targetCount);
    } else {
      const others = notes.filter(n => !matchedIds.has(n.id));
      const shuffledOthers = others.slice().sort(() => Math.random() - 0.5);
      result = matched.concat(shuffledOthers.slice(0, targetCount - matched.length));
    }

    // 重要纸条保底：确保至少 2 条 important 在结果里（如果 important 总数 ≥2）
    const resultIds = new Set(result.map(n => n.id));
    const importantInResult = result.filter(n => n.priority === 'important').length;
    const IMPORTANT_FLOOR = 2;
    if (importantInResult < IMPORTANT_FLOOR && importantNotes.length >= IMPORTANT_FLOOR) {
      const missingImportant = importantNotes.filter(n => !resultIds.has(n.id))
        .sort(() => Math.random() - 0.5)
        .slice(0, IMPORTANT_FLOOR - importantInResult);
      // 替换结果尾部的 normal 纸条（如果有的话）
      for (const imp of missingImportant) {
        const normalIdx = result.findLastIndex(n => !n.priority || n.priority === 'normal');
        if (normalIdx >= 0) {
          result[normalIdx] = imp;
        } else {
          result.push(imp); // 全是 important 了就追加
        }
      }
    }

    return result;
  }

  function formatNotesForPrompt(notes) {
    if (!notes || notes.length === 0) return '';
    let text = '【小纸条】这是 {{user}} 之前在剧情里流露过的碎片，有的可能过时了，有的可能很新鲜。它们不是全部，这只是系统给你塞了一把，可能和当前剧情有关，也可能无关，让你每次回应都会随机想起点什么。\n你可以让角色在合适的时机自然呼应，如果情景不贴合，也可以无视它们。\n\n';
    notes.forEach(n => {
      text += `- [${n.tag}] ${n.detail}`;
      if (n.characters?.length) text += `（在场：${n.characters.join('、')}）`;
      text += '\n';
    });
    return text;
  }

  // ===== 永久小纸条（pinned）=====

  async function getPinnedNotes() {
    const allMemories = await DB.getAll('memories');
    const currentScope = Character.getCurrentId();
    return allMemories.filter(m => m.type === 'note' && m.scope === currentScope && m.priority === 'pinned');
  }

  function formatPinnedNotesForPrompt(pinnedNotes) {
    if (!pinnedNotes || pinnedNotes.length === 0) return '';
    let text = '【永久记忆】以下是关于 {{user}} 的核心记忆碎片，每一条都很重要，请始终记住并在合适的时机体现。\n\n';
    pinnedNotes.forEach(n => {
      text += `- [${n.tag}] ${n.detail}`;
      if (n.characters?.length) text += `（在场：${n.characters.join('、')}）`;
      text += '\n';
    });
    return text;
  }

  // ===== 后台小纸条（全局情绪记忆）=====
  const BACKSTAGE_SCOPE = '__backstage__';
  const BACKSTAGE_NOTE_MAX = 1000;

  async function addBackstageNote(data) {
    const tag = String(data.tag || '').trim() || '有趣';
    const detail = String(data.detail || '').trim();
    if (!detail) return null;
    const priority = NOTE_PRIORITIES.includes(data.priority) ? data.priority : 'normal';

    // 来源信息（convId 为空标记为 legacy）
    const convId = data.convId || '__legacy__';
    const convName = data.convName || '';
    const worldviewId = data.worldviewId || '';
    const worldviewName = data.worldviewName || '';

    // 去重（同对话内 tag+detail 重复才算重复）
    const all = await DB.getAll('memories');
    const dup = all.find(m => m.type === 'backstage_note' && m.tag === tag && m.detail === detail && (m.convId || '__legacy__') === convId);
    if (dup) return dup;

    // 永久纸条软限额提醒
    if (priority === 'pinned') {
      const pinnedCount = all.filter(m => m.type === 'backstage_note' && m.priority === 'pinned').length;
      if (pinnedCount >= 10) {
        try { UI.showToast(`后台永久小纸条已有 ${pinnedCount} 条，建议精简`, 2500); } catch(_) {}
      }
    }

    const now = new Date();
    const timeStr = `${now.getFullYear()}.${now.getMonth()+1}.${now.getDate()} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    const memory = {
      id: Utils.uuid(),
      type: 'backstage_note',
      tag,
      detail,
      priority,
      time: data.time || timeStr,
      scope: BACKSTAGE_SCOPE,
      convId,
      convName,
      worldviewId,
      worldviewName,
      timestamp: Utils.timestamp(),
      roundCreated: data.roundCreated || 0
    };
    await DB.put('memories', memory);

    // FIFO：只删 normal
    const notes = all.filter(m => m.type === 'backstage_note');
    notes.push(memory);
    if (notes.length > BACKSTAGE_NOTE_MAX) {
      const normals = notes.filter(n => (!n.priority || n.priority === 'normal'));
      normals.sort((a, b) => a.timestamp - b.timestamp);
      const excess = notes.length - BACKSTAGE_NOTE_MAX;
      const toRemove = normals.slice(0, Math.min(excess, normals.length));
      for (const old of toRemove) { try { await DB.delete('memories', old.id); } catch(_){} }
    }
    return memory;
  }

  async function queryBackstageNotes(opts = {}) {
    const all = await DB.getAll('memories');
    let notes = all.filter(m => m.type === 'backstage_note');

    if (opts.tag) notes = notes.filter(n => n.tag === opts.tag);
    if (opts.keyword) {
      const kw = opts.keyword.toLowerCase();
      notes = notes.filter(n => (n.detail || '').toLowerCase().includes(kw));
    }

    notes.sort((a, b) => b.timestamp - a.timestamp);
    return notes.slice(0, opts.limit || 5);
  }

  async function retrieveBackstageNotes(opts = {}) {
    const all = await DB.getAll('memories');
    let notes = all.filter(m => m.type === 'backstage_note');

    // 按对话隔离：默认只返回当前对话 + legacy（开关开启时才取legacy）
    const currentConvId = opts.currentConvId || '';
    const crossWindow = !!opts.crossWindow;
    const userInputText = String(opts.userInputText || '');

    if (!crossWindow) {
      // 关闭跨窗口：只看当前对话的（legacy 也不读，避免污染）
      notes = notes.filter(n => (n.convId || '__legacy__') === currentConvId);
    }

    if (notes.length === 0) return [];

    // 预计算：用户输入命中了哪些标签的触发词
    const triggeredTags = new Set();
    if (userInputText) {
      for (const [tag, words] of Object.entries(NOTE_TAG_TRIGGERS)) {
        if (words.some(w => userInputText.includes(w))) triggeredTags.add(tag);
      }
    }

    // 路2：用户输入命中 detail 关键词（+1，比主线轻）+ 路3：标签触发词命中
    const scored = notes.map(n => {
      let score = 0;
      if (userInputText && n.detail) {
        const tokens = _extractDetailTokens(n.detail);
        const anyHit = tokens.some(t => userInputText.includes(t));
        if (anyHit) score += 1;
      }
      // 标签触发词命中
      if (triggeredTags.has(n.tag)) score += 1;
      return { note: n, score };
    });

    const matched = scored.filter(s => s.score > 0).map(s => s.note);
    const matchedIds = new Set(matched.map(n => n.id));

    // 跨窗口模式塞多点：6-10；单对话模式：5-8
    const baseMin = crossWindow ? 6 : 5;
    const baseRange = crossWindow ? 5 : 4; // crossWindow: 6-10, 单: 5-8
    const targetCount = Math.min(notes.length, baseMin + Math.floor(Math.random() * baseRange));

    let result;
    if (matched.length >= targetCount) {
      const shuffled = matched.slice().sort(() => Math.random() - 0.5);
      result = shuffled.slice(0, targetCount);
    } else {
      const others = notes.filter(n => !matchedIds.has(n.id));
      const shuffledOthers = others.slice().sort(() => Math.random() - 0.5);
      result = matched.concat(shuffledOthers.slice(0, targetCount - matched.length));
    }
    return result;
  }

  function formatBackstageNotesForPrompt(notes, opts = {}) {
    const toolHint = '\n你可以用 add_backstage_note 记录用户新表达的偏好/情绪/习惯，用 query_backstage_notes 查询更多。只在用户亲口说了值得记的新信息时才记，不揣测，不每轮都用。';
    if (!notes || notes.length === 0) {
      return '【记忆工具】' + toolHint;
    }
    const crossWindow = !!opts.crossWindow;
    const currentConvId = opts.currentConvId || '';

    if (!crossWindow) {
      // 单对话模式
      let text = '【记忆碎片】这是你亲手记下的关于 ta 的事，有的可能过时了，有的可能很新鲜，它们不是全部，这只是系统给你塞了一把，可能和现在的话题有关，也可能无关，让你每轮对话都会随机想起点什么，就像是人类的脑袋里突然闯入的记忆。\n你可以把它们自然地融入对话，如果情景不太合适，也可以无视它们。\n\n';
      notes.forEach(n => {
        text += `- [${n.tag}] ${n.detail}`;
        if (n.time) text += `（${n.time}）`;
        text += '\n';
      });
      text += toolHint;
      return text;
    }

    // 跨窗口模式：按来源分组
    const groups = { current: [], legacy: [], others: {} };
    notes.forEach(n => {
      const cid = n.convId || '__legacy__';
      if (cid === currentConvId) groups.current.push(n);
      else if (cid === '__legacy__') groups.legacy.push(n);
      else {
        const label = n.convName || '未知对话';
        if (!groups.others[label]) groups.others[label] = [];
        groups.others[label].push(n);
      }
    });

    let text = '【记忆碎片】这是你在不同后台里亲手记下的关于 ta 的事——ta 这边打开了跨窗口共享，所以你也能想起在别的对话里记过的片段。有的可能过时了，有的可能很新鲜，它们不是全部，这只是系统给你塞了一把，可能和现在的话题有关，也可能无关，让你每轮对话都会随机想起点什么，就像是人类的脑袋里突然闯入的记忆。\n你可以把它们自然地融入对话，如果情景不太合适，也可以无视它们。来自其他后台的片段是 ta 在另一个对话里的状态，不一定贴合此刻——参考着用就好。\n';

    const renderItem = n => `- [${n.tag}] ${n.detail}${n.time ? `（${n.time}）` : ''}\n`;
    if (groups.current.length) {
      text += '\n★ 当前对话：\n' + groups.current.map(renderItem).join('');
    }
    Object.keys(groups.others).forEach(label => {
      text += `\n★ 来自《${label}》：\n` + groups.others[label].map(renderItem).join('');
    });
    if (groups.legacy.length) {
      text += '\n★ 来源不详：\n' + groups.legacy.map(renderItem).join('');
    }

    text += toolHint;
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
        const parts = Array.isArray(m.participants) ? m.participants : [];
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

        // 事件标题 token 在对话中被提到（拆成 2-4 字滑窗，轻量加分）
        const title = (m.title || '').trim();
        if (title.length >= 2) {
          const titleTokens = _extractDetailTokens(title);
          const titleHits = titleTokens.filter(t => recentText.includes(t)).length;
          if (titleHits > 0) score += Math.min(titleHits * 0.15, 0.45); // 单个 token +0.15，封顶 0.45
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

  function buildExtractionPrompt(recentMessages, charName, charInfo, extractLimits, existingTitles) {
    // 保留向后兼容，返回事件+关系的提示词
    return _buildEventRelationPrompt(recentMessages, charName, charInfo, extractLimits, existingTitles);
  }

  function _buildEventRelationPrompt(recentMessages, charName, charInfo, extractLimits, existingTitles) {
    const displayName = charName || '用户角色';
    const dialogue = recentMessages.map(m =>
        `[${m.role === 'user' ? displayName : 'AI'}] ${m.content}`
    ).join('\n\n');
    const playerName = displayName;
    const maxEvents = extractLimits?.maxEvents || 5;
    const maxRelations = extractLimits?.maxRelations || 5;

    let charBlock = '';
    if (charInfo) {
        const lines = [`姓名：${charInfo.name || displayName}`];
        if (charInfo.gender) lines.push(`性别：${charInfo.gender}`);
        if (charInfo.background) lines.push(`设定：${charInfo.background}`);
        charBlock = `\n【⚠ 玩家角色基本设定（必须严格遵守，所有涉及玩家性别/外貌/身份的提取都以此为准，不得因对话场景而扭曲或忽略）】\n${lines.join('\n')}\n`;
    }

    return `${charBlock}请从以下对话中按时间顺序提取所有重要事件和关系变化，按JSON格式输出。只输出JSON，不要其他内容。

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
"relationship": "与${playerName}当前的关系（一句话，不要写"玩家"或"NPC"）",
"impression": "该角色目前对${playerName}的看法（一句话，不要写"玩家"或"NPC"）",
"emotion": "在经历了XXX后，角色姓名与${playerName}的关系从XXX变为XXX，角色姓名对此感到XXX（无明显变化则留空字符串）",
"participants": ["角色姓名"],
      "keywords": ["关键词"]
    }
  ]
}

提取规则（重要，请严格遵守）：
- **从对话最开头开始，按时间顺序逐段扫描**，不要只看后半段。每出现一个独立场景/转折/重要决策/到达新地点/关键对话/情感变化，都算一个独立事件。
- **不要做"重要性筛选"**：哪怕是吃饭、闲聊、路过某地，只要在对话中有具体内容也要记录；宁可粒度细，不要漏掉早期发生的事。
- **events 最多 ${maxEvents} 条是上限，不是目标**——如果对话里发生了 ${maxEvents} 件独立事件，就输出 ${maxEvents} 条；如果只有 2 件，就只输出 2 条；不要为了凑数也不要为了精简而丢早期事件。
- **如果事件数量超过上限**：合并相邻同场景的小事件，但**仍要保证时间跨度从开头到结尾都被覆盖**，不允许只保留后半段。
- relations 最多 ${maxRelations} 条。以下情况需要提取关系：1）新角色首次与${playerName}产生交互；2）已有角色本轮与${playerName}有实质互动（即使关系没有剧烈变化，也需要更新其当前的 relationship 和 impression 到最新状态）；3）已有角色与${playerName}的关系发生了明显转变或情感冲突。emotion 字段描述关系变化过程，首次建立关系或无明显变化填""。
- **称呼规则**：禁止在事件标题、事件正文、关系字段、印象字段、emotion、participants 中用"玩家""NPC"泛称角色；必须直接使用角色姓名。用户角色使用"${playerName}"，其他角色使用各自姓名。只有确实不知道姓名时，才可用"对方""那名角色"等临时称呼。
- 事件字段如无对应信息留空字符串，不要编造。
- 只输出 JSON，确保完整闭合。${existingTitles && existingTitles.length > 0 ? `

【已存在的记忆（不要重复提取）】
以下事件和关系已经被提取过了。如果对话中的内容和已有记忆描述的是同一件事，不要再次输出。只提取新发生的事件、新出现的角色关系、或已有关系的最新状态更新。
已有事件：${existingTitles.filter(t => t.type === 'event').map(t => t.title).join('、') || '无'}
已有关系：${existingTitles.filter(t => t.type === 'relation').map(t => t.title).join('、') || '无'}` : ''}`;
  }

  function _buildNotesPrompt(recentMessages, charName, charInfo) {
    const displayName = charName || '用户角色';
    const dialogue = recentMessages.map(m =>
        `[${m.role === 'user' ? displayName : 'AI'}] ${m.content}`
    ).join('\n\n');
    const playerName = displayName;

    let charBlock = '';
    if (charInfo) {
        const lines = [`姓名：${charInfo.name || displayName}`];
        if (charInfo.gender) lines.push(`性别：${charInfo.gender}`);
        if (charInfo.background) lines.push(`设定：${charInfo.background}`);
        charBlock = `\n【⚠ 玩家角色基本设定（必须严格遵守，所有涉及玩家性别/外貌/身份的提取都以此为准，不得因对话场景而扭曲或忽略）】\n${lines.join('\n')}\n`;
    }

    return `${charBlock}小纸条的目的是为了建立起${playerName}的人格画像，只记录能够体现出其性格、偏好、兴趣等的信息。
（注：${playerName}是真实角色名，请直接使用，不要写成 {PlayerName}、{{user}} 等占位符，也不要用"用户""玩家"这种泛称代替。）

对话内容：
${dialogue}

- 纸条标签包含三个类别
  - 偏好类：喜欢、讨厌、习惯
  - 情绪类：标签根据实际情绪填写，建议从下列中选——
    · 正面：开心、感动、安心、期待、骄傲
    · 负面：悲伤、愤怒、恐惧、痛苦、迷茫、不悦
    · 若以上都不贴切，可自行用2-4字的简洁情绪词
  - 事件类:有趣、伏笔、秘密

- 记录范围
  - 偏好类
    - ${playerName}亲口说的喜欢、厌恶、习惯等。例如Ta说"我不爱吃秋葵"，则打"讨厌"标签，记录为"${playerName}不爱吃秋葵"。或Ta说"我喜欢吃辣"，则打"喜欢"标签，记录为"${playerName}喜欢吃辣。"
    - ${playerName}通过行为表现出的偏好，例如Ta写"美滋滋买了一杯三分甜去冰草莓麻薯奶茶喝"，则打"喜欢"标签，记录为"${playerName}美滋滋地买了一杯三分甜去冰草莓麻薯奶茶"。或Ta写"沉思……习惯性地用手指敲了敲桌面"，则需要根据剧情理解是什么情景的习惯，打"习惯"标签，记录为"${playerName}在沉思时习惯性地用手指敲了敲桌面"。
  - 情绪类
    - ${playerName}明确说明情绪的行为或语言。例如Ta写"愤怒地踹开了房门"，此时需要根据剧情写明Ta愤怒的前因，打"愤怒"标签，记录为"听到了妹妹受伤的消息后，${playerName}愤怒地踹开房了。"或Ta说"我很不高兴"，打"不悦"标签，记录为"听到陆文泽提起深蓝教会的罪行后，${playerName}说'我很不高兴'。"
    - ${playerName}没有明确说明情绪，但表达了强烈情绪的行为，例如Ta写"躲在被子里哭"，依旧需要根据剧情写明哭泣的原因，打"悲伤"标签，记录为"在发现冰箱里一瓶酒都没有了后，${playerName}躲在被子里哭"。
  - 事件类
    - ${playerName}值得一记的有趣行为、可能为未来事件埋下伏笔的话/事、或明确的秘密行为。
      · "有趣"标签：例如"${playerName}走在路上莫名其妙给了树一拳"。
      · "伏笔"标签——指向未来可能影响剧情走向的话/事：例如"${playerName}说再这样下去总有一天会喜提调查局一日游。"
      · "秘密"标签——已经发生但不想被知道的事：例如"${playerName}秘密地为林时星准备生日礼物，礼物是一枚胸针。"、"当被问起来历时，${playerName}说这是秘密。"

- 提取规则
  - 提取时尽可能引用原文：行为/场景用第三人称改写，但${playerName}的原话或情绪外露的关键短语保留引号引用。
  - 每条记录必须包含触发情景（前因）+ ${playerName}的反应，不要孤立记录行为。
  - 只提取能够体现${playerName}性格的信息，不记录日常陈述。例如Ta说"我去吃饭了"、"我回来了"这类不体现性格画像，跳过；但若Ta说"我又点了同一家烧烤"——这是稳定偏好，记。
  - 每次最多提取6条，优先记录偏好类和强烈的情绪波动（如愤怒、幸福等）。

- 优先级标记（priority）
  - 每条纸条需标记 priority 字段，取值为 "important" 或 "normal"。
  - "important"：能够稳定体现${playerName}长期性格画像的信息，例如习惯、喜好、厌恶、核心恐惧、反复出现的行为模式。
  - "normal"：单次情绪波动、偶然事件、一次性的有趣行为等。
  - 每次提取最多标记 1 条为 "important"，其余都是 "normal"。优先将习惯/喜好/厌恶标为 important。
  - 如果本次提取的内容全是一次性事件，那就全部标 "normal"，不要硬凑 important。

输出格式：
{
  "notes": [
    {
      "tag": "从上述标签中选最贴切的一个",
      "detail": "包含前因+${playerName}的反应，按上述规则书写",
      "priority": "important 或 normal",
      "time": "游戏内时间（能从上下文推断就填，推断不出留空字符串）",
      "characters": ["当时在场的角色姓名"]
    }
  ]
}

只输出JSON，确保完整闭合。没有符合条件的内容时notes为空数组。`;
  }

  function formatForPrompt(memories) {
    if (!memories || memories.length === 0) return '';
    let text = '【相关记忆】这是 {{user}} 之前经历过的事件和形成的角色关系，给你参考用，保持剧情一致性。\n- 如果当前情景能自然呼应到这些记忆，让角色通过言行或旁白点出来\n- 如果当前情景无关，作为背景知识就好，不需要硬塞\n- 不要突兀地复述记忆原文\n';
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
  // 退出后台模式（无论从哪条路径进 renderList 都恢复 tab）
  _backstageViewActive = false;
  document.querySelectorAll('.memory-tabs .tab-btn').forEach(b => b.style.display = '');
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
        try {
        const isSelected = selectedIds.has(m.id);
        // 小纸条独立渲染
        if (m.type === 'note') {
          const pIcon = m.priority === 'pinned'
            ? `<span style="position:absolute;top:6px;right:8px;color:var(--accent);display:flex;align-items:center" title="永久"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:14px;height:14px"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"/></svg></span>`
            : m.priority === 'important'
            ? `<span style="position:absolute;top:6px;right:8px;color:var(--accent);display:flex;align-items:center" title="重要"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/></svg></span>`
            : '';
          return `
          <div style="position:relative;display:flex;align-items:center;gap:10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:6px;cursor:pointer" class="card" data-id="${m.id}" onclick="${manageMode ? `Memory.toggleSelect('${m.id}')` : `Memory.editNote('${m.id}')`}">
            ${manageMode ? `<span class="memory-select-checkbox" style="width:22px;height:22px;border-radius:50%;border:2px solid var(--text-secondary);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${isSelected ? 'background:var(--accent);border-color:var(--accent);' : ''}" onclick="event.stopPropagation();Memory.toggleSelect('${m.id}')">${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}</span>` : ''}
            ${pIcon}
            <div style="flex:1;overflow:hidden;${pIcon ? 'padding-right:20px' : ''}">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
                <span style="font-size:11px;padding:1px 6px;border-radius:4px;background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--accent);font-weight:700;flex-shrink:0">${Utils.escapeHtml(m.tag)}</span>
                ${m.characters?.length ? `<span style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.characters.join('、')}</span>` : ''}
              </div>
              <p style="margin:0;font-size:13px;color:var(--text);line-height:1.4">${Utils.escapeHtml(m.detail || '')}</p>
              ${m.time ? `<p style="margin:2px 0 0 0;font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(m.time)}</p>` : ''}
            </div>
          </div>`;
        }
        // 关系记忆的摘要显示
        let preview = '';
        if (m.type === 'relation') {
          if (m.relationship) preview = `关系: ${String(m.relationship)}`;
          else if (m.content) preview = String(m.content).substring(0, 80);
        } else {
// 优先显示结构化字段
            const raw = String(_getContent(m) || '');
            preview = raw.substring(0, 100) + (raw.length > 100 ? '…' : '');
        }
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
      `;
        } catch (err) {
          // 单条记忆数据异常（如 content 掉格式）：降级显示，不拖垮整个列表
          console.warn('[Memory] 渲染记忆卡片失败，降级显示:', m && m.id, err);
          const safeTitle = Utils.escapeHtml(String((m && m.title) || '(损坏的记忆)'));
          return `
          <div style="display:flex;align-items:center;gap:10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px;cursor:${manageMode ? 'default' : 'pointer'}" class="card" data-id="${m && m.id}" onclick="${manageMode ? `Memory.toggleSelect('${m && m.id}')` : `Memory.edit('${m && m.id}')`}">
            <div style="flex:1;overflow:hidden">
              <h3 style="margin:0 0 4px 0;font-size:14px;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeTitle}</h3>
              <p style="margin:0;font-size:12px;color:var(--text-secondary)">这条记忆数据格式异常，点击可编辑修复</p>
            </div>
          </div>`;
        }
      }).join('');

    // 更新全选按钮状态
    updateSelectAllIcon();
  }

  // ===== 管理模式 =====

  function toggleManageMode() {
    // 后台视图下的管理模式由 _toggleBackstageManage 处理（退出后仍留在后台视图）
    if (_backstageViewActive) { _toggleBackstageManage(); return; }
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
    _reRenderManageView();
  }

  // 管理模式下重渲当前视图：后台视图走 _renderBackstageNotes，普通三 tab 走 renderList
  function _reRenderManageView() {
    if (_backstageViewActive) { _renderBackstageNotes(); }
    else { renderList(); }
  }

  function toggleSelectAll() {
    const allIds = Array.from(document.querySelectorAll('#memory-list .card'))
      .map(el => el.dataset.id);
    if (selectedIds.size === allIds.length && allIds.length > 0) {
      selectedIds.clear();
    } else {
      selectedIds = new Set(allIds);
    }
    _reRenderManageView();
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
    if (_backstageViewActive) { await UI.showAlert('提示', '后台记忆不支持复制，只能导出或删除'); return; }
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
    _reRenderManageView();
  }

  // ===== 合并功能 =====

  async function batchMerge() {
    if (_backstageViewActive) { await UI.showAlert('提示', '后台记忆不支持合并，只能导出或删除'); return; }
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
    } else if (m.type === 'note') {
      text = `【纸条】${m.tag || '有趣'}\n`;
      if (m.detail) text += `内容：${m.detail}\n`;
      if (m.priority && m.priority !== 'normal') text += `优先级：${m.priority === 'pinned' ? '永久' : '重要'}\n`;
      if (m.time) text += `时间：${m.time}\n`;
      if (m.characters?.length) text += `关联角色：${m.characters.join(', ')}\n`;
    } else if (m.type === 'backstage_note') {
      text = `【后台纸条】${m.tag || ''}\n`;
      if (m.detail) text += `内容：${m.detail}\n`;
      if (m.priority && m.priority !== 'normal') text += `优先级：${m.priority === 'pinned' ? '永久' : '重要'}\n`;
      if (m.convName) text += `来源对话：${m.convName}\n`;
      if (m.worldviewName) text += `世界观：${m.worldviewName}\n`;
      if (m.time) text += `时间：${m.time}\n`;
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
    // 按 【事件】 或 【人物】 或 【纸条】 分割为多条
    const blocks = text.split(/(?=【(?:事件|人物|纸条)】)/).filter(b => b.trim());
    const results = [];
    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;

      const headerMatch = lines[0].match(/^【(事件|人物|纸条)】(.*)$/);
      if (!headerMatch) continue;

      const typeLabel = headerMatch[1];
      const title = headerMatch[2].trim();

      if (typeLabel === '纸条') {
        const m = { type: 'note', tag: title || '有趣', detail: '', priority: 'normal', time: '', characters: [] };
        for (let i = 1; i < lines.length; i++) {
          const l = lines[i];
          if (l.startsWith('内容：') || l.startsWith('内容:')) m.detail = l.replace(/^内容[：:]/, '').trim();
          else if (l.startsWith('优先级：') || l.startsWith('优先级:')) {
            const pv = l.replace(/^优先级[：:]/, '').trim();
            m.priority = pv === '永久' ? 'pinned' : pv === '重要' ? 'important' : 'normal';
          }
          else if (l.startsWith('时间：') || l.startsWith('时间:')) m.time = l.replace(/^时间[：:]/, '').trim();
          else if (l.startsWith('关联角色：') || l.startsWith('关联角色:')) m.characters = l.replace(/^关联角色[：:]/, '').trim().split(/[,，、]/).map(s => s.trim()).filter(Boolean);
        }
        results.push(m);
      } else if (typeLabel === '人物') {
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

    // 下载为 txt 文件（选中项含后台纸条时用「后台小纸条」命名）
    const hasBackstage = items.some(m => m.type === 'backstage_note');
    const tabName = hasBackstage ? '后台小纸条' : (currentTab === 'events' ? '事件' : currentTab === 'notes' ? '小纸条' : '人际关系');
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
      await UI.showAlert('提示', '无法识别格式。请使用【事件】、【人物】或【纸条】开头的格式。');
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
      if (m.type === 'note') {
        // 纸条走 addNote（自带去重+FIFO）
        await addNote({ tag: m.tag, detail: m.detail, priority: m.priority, time: m.time, characters: m.characters, scope });
        continue;
      }
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

  // ===== 手动新建小纸条 =====
  async function addNoteManual() {
    _editingNoteId = '__new__';
    const m = { tag: '有趣', detail: '', characters: [], priority: 'normal' };

    const curTag = m.tag;
    const tagGroups = [
      { title: '偏好', tags: ['喜欢', '讨厌', '习惯'] },
      { title: '情绪', tags: ['开心', '感动', '安心', '期待', '骄傲', '悲伤', '愤怒', '恐惧', '痛苦', '迷茫', '不悦'] },
      { title: '事件', tags: ['有趣', '伏笔', '秘密'] }
    ];
    let tagDropdownHtml = '';
    for (const g of tagGroups) {
      tagDropdownHtml += `<div style="padding:4px 10px 2px;font-size:10px;color:var(--text-secondary);font-weight:700;text-transform:uppercase;letter-spacing:0.5px">${g.title}</div>`;
      tagDropdownHtml += `<div style="display:flex;flex-wrap:wrap;gap:4px;padding:2px 6px 6px">`;
      for (const t of g.tags) {
        const isCur = t === curTag;
        tagDropdownHtml += `<div onclick="event.stopPropagation();Memory._selectTag('${t}')" style="padding:4px 10px;cursor:pointer;font-size:13px;border-radius:20px;${isCur ? 'background:var(--accent);color:#fff;font-weight:600' : 'background:color-mix(in srgb, var(--accent) 10%, transparent);color:var(--text)'}">${t}</div>`;
      }
      tagDropdownHtml += `</div>`;
    }

    const curPriority = 'normal';
    const curLabel = '普通';
    const priorityChoices = ['pinned', 'important', 'normal'];
    const dropdownItems = priorityChoices.map(v => {
      const icon = _PRIORITY_SVG[v] || '';
      const label = _PRIORITY_LABEL[v] || v;
      const isCur = v === curPriority;
      return `<div onclick="event.stopPropagation();Memory._selectPriority('${v}')" style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text);border-radius:var(--radius);${isCur ? 'background:color-mix(in srgb, var(--accent) 12%, transparent);font-weight:600' : ''}">${icon ? '<span style="display:inline-flex;color:var(--accent)">' + icon + '</span>' : ''}<span>${label}</span></div>`;
    }).join('');

    // 面具/后台选择器（默认当前面具）
    const defaultScope = Character.getCurrentId();
    const maskData = await DB.get('gameState', 'maskList');
    const masks = maskData?.value || [];
    const foundMask = masks.find(x => x.id === defaultScope);
    const scopeDisplayLabel = foundMask ? foundMask.name : defaultScope;
    const scopeOptionsHtml = await _buildScopeOptionsHtml(defaultScope);

    const html = `
    <div id="note-edit-overlay" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)Memory.closeNoteEdit()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:400px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 16px 0;font-size:16px;color:var(--text)">新建小纸条</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">标签</label>
        <input type="hidden" id="note-edit-tag" value="${curTag}" />
        <div style="position:relative;margin-bottom:12px">
          <div id="note-tag-display" onclick="Memory._toggleTagDropdown(event)" style="width:100%;padding:8px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;gap:6px;box-sizing:border-box;user-select:none"><span>${curTag}</span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:0.5"><path d="m6 9 6 6 6-6"/></svg></div>
          <div id="note-tag-dropdown" class="hidden" style="position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10;overflow:hidden;padding:4px 0;max-height:240px;overflow-y:auto">${tagDropdownHtml}</div>
        </div>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">优先级</label>
        <input type="hidden" id="note-edit-priority" value="${curPriority}" />
        <div style="position:relative;margin-bottom:12px">
          <div id="note-priority-display" onclick="Memory._togglePriorityDropdown(event)" style="width:100%;padding:8px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;gap:6px;box-sizing:border-box;user-select:none"><span>${curLabel}</span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:0.5"><path d="m6 9 6 6 6-6"/></svg></div>
          <div id="note-priority-dropdown" class="hidden" style="position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10;overflow:hidden;padding:4px">${dropdownItems}</div>
        </div>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">内容</label>
        <textarea id="note-edit-detail" style="width:100%;min-height:80px;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:14px;line-height:1.4" placeholder="写点什么..."></textarea>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin:12px 0 4px 0">在场角色（逗号分隔）</label>
        <input id="note-edit-characters" type="text" value="" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px" />
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin:12px 0 4px 0">所属</label>
        <input type="hidden" id="note-edit-scope" value="${defaultScope}" />
        <div style="position:relative;margin-bottom:12px">
          <div id="note-scope-display" onclick="Memory._toggleNoteScopeDropdown(event)" style="width:100%;padding:8px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;gap:6px;box-sizing:border-box;user-select:none"><span>${scopeDisplayLabel}</span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:0.5"><path d="m6 9 6 6 6-6"/></svg></div>
          <div id="note-scope-dropdown" class="hidden" style="position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10;overflow:hidden;padding:4px;max-height:200px;overflow-y:auto">${scopeOptionsHtml}</div>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="Memory.closeNoteEdit()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button onclick="Memory.saveNoteEdit()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#fff;font-size:13px;cursor:pointer">保存</button>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  function addManual() {
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

  // 小纸条编辑弹窗
  let _editingNoteId = null;

  async function editNote(id) {
    const m = await DB.get('memories', id);
    if (!m) return;
    _editingNoteId = id;

    // 构建弹窗
    const curTag = m.tag || '有趣';
    const tagGroups = [
      { title: '偏好', tags: ['喜欢', '讨厌', '习惯'] },
      { title: '情绪', tags: ['开心', '感动', '安心', '期待', '骄傲', '悲伤', '愤怒', '恐惧', '痛苦', '迷茫', '不悦'] },
      { title: '事件', tags: ['有趣', '伏笔', '秘密'] }
    ];
    let tagDropdownHtml = '';
    for (const g of tagGroups) {
      tagDropdownHtml += `<div style="padding:4px 10px 2px;font-size:10px;color:var(--text-secondary);font-weight:700;text-transform:uppercase;letter-spacing:0.5px">${g.title}</div>`;
      tagDropdownHtml += `<div style="display:flex;flex-wrap:wrap;gap:4px;padding:2px 6px 6px">`;
      for (const t of g.tags) {
        const isCur = t === curTag;
        tagDropdownHtml += `<div onclick="event.stopPropagation();Memory._selectTag('${t}')" style="padding:4px 10px;cursor:pointer;font-size:13px;border-radius:20px;${isCur ? 'background:var(--accent);color:#fff;font-weight:600' : 'background:color-mix(in srgb, var(--accent) 10%, transparent);color:var(--text)'}">${t}</div>`;
      }
      tagDropdownHtml += `</div>`;
    }
    // 标签不在 NOTE_TAGS 分组里时，追加到末尾
    const allGroupedTags = tagGroups.flatMap(g => g.tags);
    if (!allGroupedTags.includes(curTag)) {
      tagDropdownHtml += `<div style="display:flex;flex-wrap:wrap;gap:4px;padding:2px 6px 6px"><div onclick="event.stopPropagation();Memory._selectTag('${curTag}')" style="padding:4px 10px;cursor:pointer;font-size:13px;border-radius:20px;background:var(--accent);color:#fff;font-weight:600">${curTag}</div></div>`;
    }

    const curPriority = m.priority || 'normal';
    const curIcon = _PRIORITY_SVG[curPriority] || '';
    const curLabel = _PRIORITY_LABEL[curPriority] || '普通';

    // 面具/后台选择器
    const curScope = m.scope || Character.getCurrentId();
    const isBackstage = m.type === 'backstage_note' || curScope === BACKSTAGE_SCOPE;
    let scopeDisplayLabel = '后台';
    if (!isBackstage) {
      const maskData = await DB.get('gameState', 'maskList');
      const masks = maskData?.value || [];
      const found = masks.find(x => x.id === curScope);
      scopeDisplayLabel = found ? found.name : curScope;
    }
    const scopeOptionsHtml = await _buildScopeOptionsHtml(curScope);

    const priorityChoices = ['pinned', 'important', 'normal'];
    const dropdownItems = priorityChoices.map(v => {
      const icon = _PRIORITY_SVG[v] || '';
      const label = _PRIORITY_LABEL[v] || v;
      const isCur = v === curPriority;
      return `<div onclick="event.stopPropagation();Memory._selectPriority('${v}')" style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text);border-radius:var(--radius);${isCur ? 'background:color-mix(in srgb, var(--accent) 12%, transparent);font-weight:600' : ''}">${icon ? '<span style="display:inline-flex;color:var(--accent)">' + icon + '</span>' : ''}<span>${label}</span></div>`;
    }).join('');
    const html = `
    <div id="note-edit-overlay" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)Memory.closeNoteEdit()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:400px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 16px 0;font-size:16px;color:var(--text)">编辑小纸条</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">标签</label>
        <input type="hidden" id="note-edit-tag" value="${curTag}" />
        <div style="position:relative;margin-bottom:12px">
          <div id="note-tag-display" onclick="Memory._toggleTagDropdown(event)" style="width:100%;padding:8px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;gap:6px;box-sizing:border-box;user-select:none"><span>${curTag}</span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:0.5"><path d="m6 9 6 6 6-6"/></svg></div>
          <div id="note-tag-dropdown" class="hidden" style="position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10;overflow:hidden;padding:4px 0;max-height:240px;overflow-y:auto">${tagDropdownHtml}</div>
        </div>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">优先级</label>
        <input type="hidden" id="note-edit-priority" value="${curPriority}" />
        <div style="position:relative;margin-bottom:12px">
          <div id="note-priority-display" onclick="Memory._togglePriorityDropdown(event)" style="width:100%;padding:8px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;gap:6px;box-sizing:border-box;user-select:none">${curIcon ? '<span style="display:inline-flex;color:var(--accent)">' + curIcon + '</span>' : ''}<span>${curLabel}</span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:0.5"><path d="m6 9 6 6 6-6"/></svg></div>
          <div id="note-priority-dropdown" class="hidden" style="position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10;overflow:hidden;padding:4px">${dropdownItems}</div>
        </div>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">内容</label>
        <textarea id="note-edit-detail" style="width:100%;min-height:80px;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:14px;line-height:1.4">${Utils.escapeHtml(m.detail || '')}</textarea>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin:12px 0 4px 0">在场角色（逗号分隔）</label>
        <input id="note-edit-characters" type="text" value="${Utils.escapeHtml((m.characters || []).join('、'))}" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px" />
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin:12px 0 4px 0">所属</label>
        <input type="hidden" id="note-edit-scope" value="${m.scope || ''}" />
        <div style="position:relative;margin-bottom:12px">
          <div id="note-scope-display" onclick="Memory._toggleNoteScopeDropdown(event)" style="width:100%;padding:8px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;gap:6px;box-sizing:border-box;user-select:none"><span>${scopeDisplayLabel}</span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:0.5"><path d="m6 9 6 6 6-6"/></svg></div>
          <div id="note-scope-dropdown" class="hidden" style="position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10;overflow:hidden;padding:4px;max-height:200px;overflow-y:auto">${scopeOptionsHtml}</div>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="Memory.deleteNoteFromEdit()" style="padding:8px 14px;border:1px solid var(--danger, #e53935);border-radius:var(--radius);background:transparent;color:var(--danger, #e53935);font-size:13px;cursor:pointer">删除</button>
          <button onclick="Memory.closeNoteEdit()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button onclick="Memory.saveNoteEdit()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#fff;font-size:13px;cursor:pointer">保存</button>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  // 优先级下拉选择项 — 图标 SVG（复用侧边栏同款）
  const _PRIORITY_SVG = {
    pinned: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:14px;height:14px"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"/></svg>',
    important: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/></svg>',
    normal: ''
  };
  const _PRIORITY_LABEL = { pinned: '永久', important: '重要', normal: '普通' };

  function _selectPriority(value) {
    const input = document.getElementById('note-edit-priority');
    const display = document.getElementById('note-priority-display');
    const dropdown = document.getElementById('note-priority-dropdown');
    if (input) input.value = value;
    if (display) {
      const icon = _PRIORITY_SVG[value] || '';
      const label = _PRIORITY_LABEL[value] || value;
      display.innerHTML = (icon ? '<span style="display:inline-flex;color:var(--accent)">' + icon + '</span>' : '') +
        '<span>' + label + '</span>' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:0.5"><path d="m6 9 6 6 6-6"/></svg>';
    }
    if (dropdown) dropdown.classList.add('hidden');
  }

  function _togglePriorityDropdown(e) {
    e.stopPropagation();
    const dd = document.getElementById('note-priority-dropdown');
    if (dd) dd.classList.toggle('hidden');
    // 关闭其他下拉
    document.getElementById('note-tag-dropdown')?.classList.add('hidden');
    document.getElementById('note-scope-dropdown')?.classList.add('hidden');
  }

  function _selectTag(value) {
    const input = document.getElementById('note-edit-tag');
    const display = document.getElementById('note-tag-display');
    const dropdown = document.getElementById('note-tag-dropdown');
    if (input) input.value = value;
    if (display) { const s = display.querySelector('span'); if (s) s.textContent = value; }
    if (dropdown) dropdown.classList.add('hidden');
  }

  function _bsSelectTag(value) {
    const input = document.getElementById('bs-edit-tag');
    const label = document.getElementById('bs-tag-label');
    const dropdown = document.getElementById('bs-tag-dropdown');
    if (input) input.value = value;
    if (label) label.textContent = value;
    if (dropdown) dropdown.classList.add('hidden');
  }

  function _toggleTagDropdown(e) {
    e.stopPropagation();
    const dd = document.getElementById('note-tag-dropdown');
    if (dd) dd.classList.toggle('hidden');
    // 关闭其他下拉
    document.getElementById('note-priority-dropdown')?.classList.add('hidden');
    document.getElementById('note-scope-dropdown')?.classList.add('hidden');
  }

  function _selectNoteScope(value, label) {
    const input = document.getElementById('note-edit-scope');
    const display = document.getElementById('note-scope-display');
    const dropdown = document.getElementById('note-scope-dropdown');
    if (input) input.value = value;
    if (display) {
      display.innerHTML = '<span>' + Utils.escapeHtml(label) + '</span>' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:0.5"><path d="m6 9 6 6 6-6"/></svg>';
    }
    if (dropdown) dropdown.classList.add('hidden');
  }

  function _toggleNoteScopeDropdown(e) {
    e.stopPropagation();
    const dd = document.getElementById('note-scope-dropdown');
    if (dd) dd.classList.toggle('hidden');
    document.getElementById('note-tag-dropdown')?.classList.add('hidden');
    document.getElementById('note-priority-dropdown')?.classList.add('hidden');
  }

  // 构建面具+后台选项列表 HTML
  async function _buildScopeOptionsHtml(currentScope) {
    const maskData = await DB.get('gameState', 'maskList');
    const masks = maskData?.value || [{ id: 'default', name: '默认面具' }];
    let html = '';
    for (const m of masks) {
      const isCur = m.id === currentScope;
      html += `<div onclick="event.stopPropagation();Memory._selectNoteScope('${m.id}','${Utils.escapeHtml(m.name)}')" style="padding:8px 12px;cursor:pointer;font-size:13px;color:var(--text);border-radius:var(--radius);display:flex;align-items:center;gap:6px;${isCur ? 'background:color-mix(in srgb, var(--accent) 12%, transparent);font-weight:600' : ''}"><span style="width:8px;height:8px;border-radius:50%;background:var(--accent);flex-shrink:0"></span><span>${Utils.escapeHtml(m.name)}</span></div>`;
    }
    // 后台选项
    const isBs = currentScope === BACKSTAGE_SCOPE;
    html += `<div style="height:1px;background:var(--border);margin:4px 8px"></div>`;
    html += `<div onclick="event.stopPropagation();Memory._selectNoteScope('${BACKSTAGE_SCOPE}','后台')" style="padding:8px 12px;cursor:pointer;font-size:13px;color:var(--text);border-radius:var(--radius);display:flex;align-items:center;gap:6px;${isBs ? 'background:color-mix(in srgb, var(--accent) 12%, transparent);font-weight:600' : ''}"><span style="width:8px;height:8px;border-radius:50%;background:var(--text-secondary);flex-shrink:0"></span><span>后台</span></div>`;
    return html;
  }

  function closeNoteEdit() {
    _editingNoteId = null;
    document.getElementById('note-edit-overlay')?.remove();
  }

  async function saveNoteEdit() {
    if (!_editingNoteId) return;
    const isNew = _editingNoteId === '__new__';

    const tag = document.getElementById('note-edit-tag').value;
    const detail = document.getElementById('note-edit-detail').value.trim();
    const charsRaw = document.getElementById('note-edit-characters').value.trim();
    const characters = charsRaw ? charsRaw.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : [];
    const priority = document.getElementById('note-edit-priority')?.value || 'normal';

    if (!detail) { UI.showToast('内容不能为空'); return; }

    if (isNew) {
      // 新建模式
      const newScope = document.getElementById('note-edit-scope')?.value || Character.getCurrentId();
      const isBackstageScope = newScope === BACKSTAGE_SCOPE;
      if (isBackstageScope) {
        await addBackstageNote({ tag, detail, priority, characters });
      } else {
        await addNote({ tag, detail, priority, characters, scope: newScope });
      }
      closeNoteEdit();
      showTab('notes');
      UI.showToast('已创建');
      return;
    }

    // 编辑模式
    const m = await DB.get('memories', _editingNoteId);
    if (!m) { closeNoteEdit(); return; }

    // 永久纸条软限额提醒
    if (priority === 'pinned' && m.priority !== 'pinned') {
      const all = await DB.getAll('memories');
      const pinnedCount = all.filter(x => x.type === 'note' && x.scope === m.scope && x.priority === 'pinned').length;
      if (pinnedCount >= 10) {
        UI.showToast(`永久小纸条已有 ${pinnedCount} 条，建议精简`, 2500);
      }
    }

    m.tag = tag;
    m.detail = detail;
    m.characters = characters;
    m.priority = NOTE_PRIORITIES.includes(priority) ? priority : 'normal';

    // 面具/后台切换
    const newScope = document.getElementById('note-edit-scope')?.value || m.scope;
    if (newScope === BACKSTAGE_SCOPE) {
      m.scope = BACKSTAGE_SCOPE;
      m.type = 'backstage_note';
    } else {
      m.scope = newScope;
      m.type = 'note';
    }

    await DB.put('memories', m);

    closeNoteEdit();
    renderList();
    UI.showToast('已保存');
  }

  async function deleteNoteFromEdit() {
    if (!_editingNoteId) return;
    if (!await UI.showConfirm('删除小纸条', '确定删除这条小纸条？')) return;
    await DB.del('memories', _editingNoteId);
    closeNoteEdit();
    renderList();
  }

  // ===== UI - 搜索 =====

  // v685.1：后台口令（默认 1001，可自定义）
  const BACKSTAGE_PWD_KEY = 'backstage_pwd';
  function _getBackstagePwd() {
    try {
      const v = localStorage.getItem(BACKSTAGE_PWD_KEY);
      return (v && v.trim()) ? v.trim() : '1001';
    } catch(_) { return '1001'; }
  }
  // v685.4：暴露给外部模块（如 backstage.js）读口令
  function getBackstagePwd() { return _getBackstagePwd(); }
  function _setBackstagePwd(v) {
    try { localStorage.setItem(BACKSTAGE_PWD_KEY, String(v || '').trim()); } catch(_) {}
  }
  async function changeBackstagePwd() {
    const cur = _getBackstagePwd();
    const next = await UI.showSimpleInput('修改后台口令', cur === '1001' ? '' : '', {
      placeholder: '输入新口令（区分大小写，建议字母+数字组合）',
    });
    if (next === null || next === undefined) return;
    const trimmed = String(next).trim();
    if (!trimmed) {
      UI.showToast('口令不能为空', 1800);
      return;
    }
    if (trimmed.length < 2) {
      UI.showToast('口令至少 2 位', 1800);
      return;
    }
    _setBackstagePwd(trimmed);
    UI.showToast('口令已更新（请记好）', 2000);
  }

  function search(query) {
    // 后台入口：输入当前口令进入/退出后台记忆库（默认 1001）
    if (query.trim() === _getBackstagePwd()) {
      _toggleBackstageView();
      // 清空搜索框
      const input = document.querySelector('#memory-panel input[type="search"], #memory-panel input[type="text"]');
      if (input) input.value = '';
      return;
    }
    searchQuery = query.toLowerCase();
    renderList();
  }

  // 后台记忆库视图
  let _backstageViewActive = false;
  let _backstageFilter = 'current'; // 'current' | 'all'

  async function _toggleBackstageView() {
    _backstageViewActive = !_backstageViewActive;
    if (_backstageViewActive) {
      _backstageFilter = 'current';
      await _renderBackstageNotes();
    } else {
      // 退出后台前先收起可能残留的批量管理栏
      if (manageMode) { manageMode = false; selectedIds.clear(); const bar = document.getElementById('memory-manage-bar'); if (bar) { bar.classList.add('hidden'); bar.style.display = ''; } const c = document.getElementById('memory-list'); if (c) c.style.paddingBottom = ''; }
      renderList();
      // 恢复 tab 显示
      document.querySelectorAll('.memory-tabs .tab-btn').forEach(b => b.style.display = '');
    }
  }

  function _switchBackstageFilter(filter) {
    _backstageFilter = filter;
    _renderBackstageNotes();
  }

  async function _renderBackstageNotes() {
    // 隐藏 tab 按钮
    document.querySelectorAll('.memory-tabs .tab-btn').forEach(b => b.style.display = 'none');

    const all = await DB.getAll('memories');
    let notes = all.filter(m => m.type === 'backstage_note').sort((a, b) => b.timestamp - a.timestamp);

    // 当前对话信息（用于过滤和分组）
    const currentConvId = (typeof Conversations !== 'undefined' ? Conversations.getCurrent() : '') || '';
    const currentConv = (typeof Conversations !== 'undefined' ? Conversations.getList().find(c => c.id === currentConvId) : null);
    const currentConvName = currentConv?.title || currentConv?.name || '当前对话';

    // 过滤
    if (_backstageFilter === 'current') {
      notes = notes.filter(n => (n.convId || '__legacy__') === currentConvId);
    }

    const container = document.getElementById('memory-list');
    if (!container) return;

    // 切换条
    const switchTab = `<div style="display:flex;gap:6px;margin-bottom:8px">
      <button onclick="Memory._switchBackstageFilter('current')" style="flex:1;padding:6px 10px;border-radius:8px;border:1px solid ${_backstageFilter === 'current' ? 'var(--accent)' : 'var(--border)'};background:${_backstageFilter === 'current' ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-secondary)'};color:${_backstageFilter === 'current' ? 'var(--accent)' : 'var(--text)'};font-size:12px;cursor:pointer">仅当前对话</button>
      <button onclick="Memory._switchBackstageFilter('all')" style="flex:1;padding:6px 10px;border-radius:8px;border:1px solid ${_backstageFilter === 'all' ? 'var(--accent)' : 'var(--border)'};background:${_backstageFilter === 'all' ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-secondary)'};color:${_backstageFilter === 'all' ? 'var(--accent)' : 'var(--text)'};font-size:12px;cursor:pointer">全部</button>
    </div>`;

    const header = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:8px 12px;background:color-mix(in srgb, var(--accent) 8%, transparent);border-radius:var(--radius)">
      <span style="font-size:13px;font-weight:700;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> 后台记忆库（${notes.length}条）</span>
      <span style="display:flex;gap:10px;align-items:center">
        <span style="font-size:11px;color:${manageMode ? 'var(--accent)' : 'var(--text-secondary)'};cursor:pointer" onclick="Memory._toggleBackstageManage()" title="批量选中、导出、删除">${manageMode ? '完成' : '管理'}</span>
        <span style="font-size:11px;color:var(--text-secondary);cursor:pointer" onclick="Memory.changeBackstagePwd()" title="修改进入后台需要输入的口令">改口令</span>
        <span style="font-size:11px;color:var(--text-secondary);cursor:pointer" onclick="Memory.search('')">退出</span>
      </span>
    </div>` + switchTab;

    if (notes.length === 0) {
      const tip = _backstageFilter === 'current' ? '当前对话暂无后台记忆' : '暂无后台记忆';
      container.innerHTML = header + `<p style="color:var(--text-secondary);text-align:center;padding:20px;">${tip}</p>`;
      return;
    }

    container.innerHTML = header + notes.map(n => {
      const convId = n.convId || '__legacy__';
      let sourceLabel = '';
      let sourceColor = 'var(--text-secondary)';
      if (convId === '__legacy__') {
        sourceLabel = '早期记录';
        sourceColor = 'color-mix(in srgb, var(--text-secondary) 80%, var(--accent))';
      } else if (convId === currentConvId) {
        sourceLabel = '当前对话';
        sourceColor = 'var(--accent)';
      } else {
        sourceLabel = n.convName || '未知对话';
      }
      const wvLabel = n.worldviewName ? `《${Utils.escapeHtml(n.worldviewName)}》` : '';
      const isSelected = selectedIds.has(n.id);
      const checkbox = manageMode
        ? `<span class="memory-select-checkbox" style="width:22px;height:22px;border-radius:50%;border:2px solid var(--text-secondary);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${isSelected ? 'background:var(--accent);border-color:var(--accent);' : ''}" onclick="event.stopPropagation();Memory.toggleSelect('${n.id}')">${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}</span>`
        : '';
      const onClick = manageMode ? `Memory.toggleSelect('${n.id}')` : `Memory.editBackstageNote('${n.id}')`;
      return `
      <div style="display:flex;align-items:center;gap:10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:6px;cursor:pointer" class="card" data-id="${n.id}" onclick="${onClick}">
        ${checkbox}
        <div style="flex:1;overflow:hidden">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap">
            <span style="font-size:11px;padding:1px 6px;border-radius:4px;background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--accent);font-weight:700;flex-shrink:0">${Utils.escapeHtml(n.tag)}</span>
            <span style="font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid ${sourceColor};color:${sourceColor};flex-shrink:0">${Utils.escapeHtml(sourceLabel)}${wvLabel ? ' · ' + wvLabel : ''}</span>
            <span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(n.time || '')}</span>
          </div>
          <p style="margin:0;font-size:13px;color:var(--text);line-height:1.4">${Utils.escapeHtml(n.detail || '')}</p>
        </div>
        ${manageMode ? '' : `<span style="font-size:11px;color:var(--text-secondary);cursor:pointer;flex-shrink:0;padding:4px 6px" onclick="event.stopPropagation();Memory._deleteBackstageNote('${n.id}')">×</span>`}
      </div>
    `}).join('');
  }

  // 后台视图进/出批量管理：复用普通管理栏（memory-manage-bar）+ selectedIds，但重渲走后台视图
  function _toggleBackstageManage() {
    if (sortMode) exitSortMode();
    manageMode = !manageMode;
    selectedIds.clear();
    const bar = document.getElementById('memory-manage-bar');
    const container = document.getElementById('memory-list');
    if (manageMode) {
      if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
      if (container) container.style.paddingBottom = '72px';
    } else {
      if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
      if (container) container.style.paddingBottom = '';
    }
    _renderBackstageNotes();
  }

  async function _deleteBackstageNote(id) {
    if (!await UI.showConfirm('删除后台记忆', '确定删除这条记忆？')) return;
    await DB.del('memories', id);
    await _renderBackstageNotes();
  }

  // ===== 后台纸条编辑弹窗 =====
  let _editingBsNoteId = null;

  async function editBackstageNote(id) {
    const m = await DB.get('memories', id);
    if (!m) return;
    _editingBsNoteId = id;
    _ensureBsEditModal();
    document.getElementById('bs-edit-tag').value = m.tag || '有趣';
  const bsTagLabel = document.getElementById('bs-tag-label');
  if (bsTagLabel) bsTagLabel.textContent = m.tag || '有趣';
  document.getElementById('bs-edit-detail').value = m.detail || '';
  document.getElementById('bs-edit-time').value = m.time || '';
  const bsPriSel = document.getElementById('bs-edit-priority');
  if (bsPriSel) bsPriSel.value = m.priority || 'normal';

    // 来源选择器
    const conversations = (typeof Conversations !== 'undefined' ? Conversations.getList() : []) || [];
    const sel = document.getElementById('bs-edit-conv');
    const currentSrc = m.convId || '__legacy__';
    sel.innerHTML = `
      <option value="__legacy__" ${currentSrc === '__legacy__' ? 'selected' : ''}>未标记来源（早期记录）</option>
      ${conversations.map(c => `<option value="${Utils.escapeHtml(c.id)}" ${currentSrc === c.id ? 'selected' : ''}>${Utils.escapeHtml(c.title || c.name || '未命名对话')}</option>`).join('')}
    `;

    document.getElementById('bs-edit-modal').classList.remove('hidden');
  }

  function _ensureBsEditModal() {
    if (document.getElementById('bs-edit-modal')) return;
    const tagGroups = [
      { title: '偏好', tags: ['喜欢', '讨厌', '习惯'] },
      { title: '情绪', tags: ['开心', '感动', '安心', '期待', '骄傲', '悲伤', '愤怒', '恐惧', '痛苦', '迷茫', '不悦'] },
      { title: '事件', tags: ['有趣', '伏笔', '秘密'] }
    ];
    let tagDropdownHtml = '';
    for (const g of tagGroups) {
      tagDropdownHtml += `<div style="padding:4px 10px 2px;font-size:10px;color:var(--text-secondary);font-weight:700;letter-spacing:0.5px">${g.title}</div>`;
      tagDropdownHtml += `<div style="display:flex;flex-wrap:wrap;gap:4px;padding:2px 6px 6px">`;
      for (const t of g.tags) {
        tagDropdownHtml += `<div onclick="event.stopPropagation();Memory._bsSelectTag('${t}')" style="padding:4px 10px;cursor:pointer;font-size:13px;border-radius:20px;background:color-mix(in srgb, var(--accent) 10%, transparent);color:var(--text)">${t}</div>`;
      }
      tagDropdownHtml += `</div>`;
    }
    const html = `
    <div id="bs-edit-modal" class="hidden" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)Memory.closeBsEdit()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto" onclick="event.stopPropagation()">
        <h3 style="margin:0 0 16px 0;font-size:16px;color:var(--text)">编辑后台记忆</h3>

        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">标签</label>
        <input type="hidden" id="bs-edit-tag" value="" />
        <div style="position:relative;margin-bottom:12px">
          <div id="bs-tag-display" onclick="event.stopPropagation();document.getElementById('bs-tag-dropdown').classList.toggle('hidden')" style="width:100%;padding:8px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;gap:6px;box-sizing:border-box;user-select:none"><span id="bs-tag-label">—</span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:0.5"><path d="m6 9 6 6 6-6"/></svg></div>
          <div id="bs-tag-dropdown" class="hidden" style="position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10;overflow:hidden;padding:4px 0;max-height:240px;overflow-y:auto">${tagDropdownHtml}</div>
        </div>

        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">优先级</label>
        <select id="bs-edit-priority" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);margin-bottom:12px;font-size:14px">
          <option value="normal">普通</option>
          <option value="important">重要</option>
          <option value="pinned">永久</option>
        </select>

        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">内容</label>
        <textarea id="bs-edit-detail" rows="4" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);margin-bottom:12px;font-size:14px;resize:vertical;box-sizing:border-box"></textarea>

        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">时间</label>
        <input id="bs-edit-time" type="text" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);margin-bottom:12px;font-size:14px;box-sizing:border-box">

        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">来源对话</label>
        <select id="bs-edit-conv" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);margin-bottom:4px;font-size:14px"></select>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:12px">改了来源后，这条纸条会出现在被认领对话的"仅当前对话"视图里。</div>

        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button onclick="Memory.deleteBsFromEdit()" style="padding:8px 14px;border-radius:8px;border:1px solid color-mix(in srgb, var(--danger) 55%, var(--border));background:none;color:var(--danger);font-size:13px;cursor:pointer;margin-right:auto">删除</button>
          <button onclick="Memory.closeBsEdit()" style="padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button onclick="Memory.saveBsEdit()" style="padding:8px 14px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">保存</button>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  function closeBsEdit() {
    _editingBsNoteId = null;
    document.getElementById('bs-edit-modal')?.classList.add('hidden');
  }

  async function saveBsEdit() {
    if (!_editingBsNoteId) return;
    const m = await DB.get('memories', _editingBsNoteId);
    if (!m) { closeBsEdit(); return; }

    const tag = document.getElementById('bs-edit-tag').value;
    const detail = document.getElementById('bs-edit-detail').value.trim();
    const time = document.getElementById('bs-edit-time').value.trim();
    const newConvId = document.getElementById('bs-edit-conv').value;

    if (!detail) { UI.showToast('内容不能为空', 1500); return; }

    m.tag = String(tag || m.tag || '有趣').trim() || m.tag;
    m.detail = detail;
    m.time = time;
    const newPriority = document.getElementById('bs-edit-priority')?.value;
    if (NOTE_PRIORITIES.includes(newPriority)) m.priority = newPriority;

    // 更新来源
    if (newConvId !== (m.convId || '__legacy__')) {
      if (newConvId === '__legacy__') {
        m.convId = '__legacy__';
        m.convName = '';
        m.worldviewId = '';
        m.worldviewName = '';
      } else {
        const conv = (typeof Conversations !== 'undefined' ? Conversations.getList().find(c => c.id === newConvId) : null);
        m.convId = newConvId;
        m.convName = conv?.title || conv?.name || '';
        const wvId = conv?.singleWorldviewId || conv?.worldviewId || '';
        m.worldviewId = wvId;
        if (wvId && wvId !== '__default_wv__') {
          try {
            const wv = await DB.get('worldviews', wvId);
            m.worldviewName = wv?.name || '';
          } catch(_) { m.worldviewName = ''; }
        } else {
          m.worldviewName = '';
        }
      }
    }

    await DB.put('memories', m);
    closeBsEdit();
    await _renderBackstageNotes();
    UI.showToast('已保存');
  }

  async function deleteBsFromEdit() {
    if (!_editingBsNoteId) return;
    if (!await UI.showConfirm('删除后台记忆', '确定删除这条记忆？')) return;
    await DB.del('memories', _editingBsNoteId);
    closeBsEdit();
    await _renderBackstageNotes();
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
    add, upsertRelation, addNote, retrieve, retrieveNotes, formatNotesForPrompt, getPinnedNotes, formatPinnedNotesForPrompt, NOTE_TAGS, NOTE_PRIORITIES,
    addBackstageNote, queryBackstageNotes, retrieveBackstageNotes, formatBackstageNotesForPrompt,
    buildExtractionPrompt, buildNotesPrompt: _buildNotesPrompt, formatForPrompt,
    showTab, renderList, edit, saveEdit, closeEdit, _onEditTypeChange, remove, deleteNoteConfirm, _deleteBackstageNote,
    _switchBackstageFilter, editBackstageNote, closeBsEdit, saveBsEdit, deleteBsFromEdit, _toggleBackstageManage,
    changeBackstagePwd, getBackstagePwd,
    editNote, closeNoteEdit, saveNoteEdit, deleteNoteFromEdit, addNoteManual, _selectPriority, _togglePriorityDropdown, _selectTag, _toggleTagDropdown, _selectNoteScope, _toggleNoteScopeDropdown,
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
