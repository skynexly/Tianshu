/**
 * 世界书（Lorebook） — 独立资源，可挂角色/世界观/对话。
 *
 * 数据结构：
 * {
 *   id: 'lb_xxx',
 *   name: '世界书名',
 *   description: '',
 *   festivals: [],     // 节日
 *   knowledges: [],    // 知识条目（含常驻 keywordTrigger=false / 动态 keywordTrigger=true）
 *   events: [],        // 事件（单人卡场景只关键词触发，沿用世界观的 events 数据结构）
 *   globalNpcs: [],    // 全局 NPC（沿用世界观格式）
 *   created, updated
 * }
 *
 * 挂载方：
 * - 单人卡：    card.lorebookIds = []
 * - 世界观：    wv.lorebookIds   = []  （Step 2 接入）
 * - 对话：      conv.lorebookIds = []  （Step 2 接入）
 *
 * 对话级临时禁用：conv.lorebookDisabled = [lbId, ...]
 */
const Lorebook = (() => {

  // ========== CRUD ==========
  async function getAll() {
    try { return await DB.getAll('lorebooks'); } catch(_) { return []; }
  }
  async function get(id) {
    if (!id) return null;
    try { return await DB.get('lorebooks', id); } catch(_) { return null; }
  }
  async function save(lb) {
    if (!lb.id) lb.id = 'lb_' + (typeof Utils !== 'undefined' ? Utils.uuid() : (Date.now() + '_' + Math.random().toString(36).slice(2, 8)));
    if (!lb.created) lb.created = Date.now();
    lb.updated = Date.now();
    if (!Array.isArray(lb.festivals)) lb.festivals = [];
    if (!Array.isArray(lb.knowledges)) lb.knowledges = [];
    if (!Array.isArray(lb.events)) lb.events = [];
    if (!Array.isArray(lb.globalNpcs)) lb.globalNpcs = [];
    await DB.put('lorebooks', lb);
    return lb.id;
  }
  async function remove(id) {
    if (!id) return;
    await DB.del('lorebooks', id);
    // 解绑所有引用这本世界书的卡/世界观/对话
    try {
      const cards = await DB.getAll('singleCards');
      for (const c of cards) {
        if (Array.isArray(c.lorebookIds) && c.lorebookIds.includes(id)) {
          c.lorebookIds = c.lorebookIds.filter(x => x !== id);
          await DB.put('singleCards', c);
        }
      }
    } catch(_) {}
    try {
      const wvs = await DB.getAll('worldviews');
      for (const w of wvs) {
        if (Array.isArray(w.lorebookIds) && w.lorebookIds.includes(id)) {
          w.lorebookIds = w.lorebookIds.filter(x => x !== id);
          await DB.put('worldviews', w);
        }
      }
    } catch(_) {}
    // 对话存在 Conversations 模块内存里，让它自己处理；这里只清持久层
  }

  // ========== 引用计数（用于列表卡片显示"被 N 处挂载"）==========
  async function getRefCount(id) {
    let cards = 0, wvs = 0, convs = 0;
    try {
      const cs = await DB.getAll('singleCards');
      cards = cs.filter(c => Array.isArray(c.lorebookIds) && c.lorebookIds.includes(id)).length;
    } catch(_) {}
    try {
      const ws = await DB.getAll('worldviews');
      wvs = ws.filter(w => Array.isArray(w.lorebookIds) && w.lorebookIds.includes(id)).length;
    } catch(_) {}
    try {
      if (typeof Conversations !== 'undefined' && Conversations.getList) {
        convs = Conversations.getList().filter(c => Array.isArray(c.lorebookIds) && c.lorebookIds.includes(id)).length;
      }
    } catch(_) {}
    return { cards, wvs, convs, total: cards + wvs + convs };
  }

  // ========== 注入收集：合并 + 去重 + 临时禁用 ==========
  // 收集顺序：世界观 → 卡 → 常驻角色（type=card 的卡书）→ 对话（同一本只算第一次出现的来源）
  // 返回数组（按收集顺序，已展开为 lorebook 对象）
  async function collectForChat({ conv, card, wv } = {}) {
    const candidates = [];
    const push = (ids, source) => {
      (ids || []).forEach(id => { if (id) candidates.push({ id, source }); });
    };
    push(wv?.defaultLorebookIds, 'wv');
    push(wv?.lorebookIds, 'wv');
    push(card?.lorebookIds, 'card');

    // v684：常驻角色（type=card）的 lorebookIds 也自动收集
    try {
      const attachedList = (conv && Array.isArray(conv.attachedChars)) ? conv.attachedChars : [];
      const cardEntries = attachedList.filter(e => e && e.type === 'card' && e.id);
      for (const e of cardEntries) {
        try {
          const ac = (typeof SingleCard !== 'undefined' && SingleCard.get) ? await SingleCard.get(e.id) : null;
          if (ac && Array.isArray(ac.lorebookIds)) {
            push(ac.lorebookIds, 'attached');
          }
        } catch(_) {}
      }
    } catch(_) {}

    push(conv?.lorebookIds, 'conv');

    const disabled = new Set(conv?.lorebookDisabled || []);
    const seen = new Set();
    const out = [];
    for (const c of candidates) {
      if (seen.has(c.id) || disabled.has(c.id)) continue;
      seen.add(c.id);
      const lb = await get(c.id);
      if (lb) out.push({ ...lb, _source: c.source });
    }
    return out;
  }

  // 同步版（不读 DB，只返回 id 列表，用于 UI 列出候选）
  // 注意：常驻角色的世界书需要异步读卡，同步版不包含 attached 来源
  function collectCandidateIds({ conv, card, wv } = {}) {
    const seen = new Set();
    const out = [];
    const push = (ids, source) => {
      (ids || []).forEach(id => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        out.push({ id, source });
      });
    };
    push(wv?.lorebookIds, 'wv');
    push(card?.lorebookIds, 'card');
    push(conv?.lorebookIds, 'conv');
    return out;
  }

  // v684：异步候选列表（包含常驻角色的世界书来源）
  async function collectCandidateIdsAsync({ conv, card, wv } = {}) {
    const seen = new Set();
    const out = [];
    const push = (ids, source) => {
      (ids || []).forEach(id => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        out.push({ id, source });
      });
    };
    push(wv?.defaultLorebookIds, 'wv');
    push(wv?.lorebookIds, 'wv');
    push(card?.lorebookIds, 'card');
    try {
      const attachedList = (conv && Array.isArray(conv.attachedChars)) ? conv.attachedChars : [];
      const cardEntries = attachedList.filter(e => e && e.type === 'card' && e.id);
      for (const e of cardEntries) {
        try {
          const ac = (typeof SingleCard !== 'undefined' && SingleCard.get) ? await SingleCard.get(e.id) : null;
          if (ac && Array.isArray(ac.lorebookIds)) push(ac.lorebookIds, 'attached');
        } catch(_) {}
      }
    } catch(_) {}
    push(conv?.lorebookIds, 'conv');
    return out;
  }

  // ========== 老隐藏世界观迁移（启动时跑一次）==========
  const MIGRATE_FLAG = 'tianshu_migrated_lorebooks_v1';
  async function migrateHiddenWorldviewsOnce() {
    try {
      if (localStorage.getItem(MIGRATE_FLAG) === '1') return { migrated: 0, skipped: true };
    } catch(_) {}
    let migrated = 0;
    try {
      const wvs = await DB.getAll('worldviews');
      const hiddens = wvs.filter(w => w && w._hidden === 'sc' && w._scCardId);
      if (hiddens.length === 0) {
        try { localStorage.setItem(MIGRATE_FLAG, '1'); } catch(_) {}
        return { migrated: 0 };
      }
      const cards = await DB.getAll('singleCards');
      const cardMap = {};
      cards.forEach(c => { cardMap[c.id] = c; });

      for (const wv of hiddens) {
        const cardId = wv._scCardId;
        const card = cardMap[cardId];
        // 有任一字段非空才迁移；否则只删空壳
        const hasContent = (wv.festivals?.length || 0) + (wv.knowledges?.length || 0) +
                           (wv.events?.length || 0) + (wv.globalNpcs?.length || 0) > 0;
        if (hasContent) {
          const lb = {
            id: 'lb_' + (typeof Utils !== 'undefined' ? Utils.uuid() : (Date.now() + '_' + Math.random().toString(36).slice(2, 8))),
            name: (card?.name || '未命名角色') + ' 的世界书',
            description: '从单人卡扩展设定迁移而来',
            festivals: wv.festivals || [],
            knowledges: wv.knowledges || [],
            events: wv.events || [],
            globalNpcs: wv.globalNpcs || [],
            created: wv.created || Date.now(),
            updated: Date.now(),
            _migratedFromCard: cardId
          };
          await DB.put('lorebooks', lb);
          if (card) {
            card.lorebookIds = card.lorebookIds || [];
            if (!card.lorebookIds.includes(lb.id)) card.lorebookIds.push(lb.id);
            await DB.put('singleCards', card);
          }
          migrated++;
        }
        // 不管有没有内容，老隐藏世界观都删掉
        await DB.del('worldviews', wv.id);
      }
      try { localStorage.setItem(MIGRATE_FLAG, '1'); } catch(_) {}
      console.log('[Lorebook] 迁移完成：', migrated, '本');
    } catch(e) {
      console.warn('[Lorebook] 迁移失败：', e);
    }
    return { migrated };
  }

  return {
    getAll, get, save, remove,
    getRefCount,
    collectForChat,
    collectCandidateIds,
    collectCandidateIdsAsync,
    migrateHiddenWorldviewsOnce,
  };
})();