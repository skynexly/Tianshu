/**
 * AI Tool Calling 系统
 * 定义工具列表 + handler 映射
 */
const Tools = (() => {

  // ===== 通用 helper =====
  const _scope = () => Character.getCurrentId();
  const _allMem = () => DB.getAll('memories');
  const NOTE_TAGS = ['喜欢','讨厌','期待','恐惧','愤怒','有趣','习惯','秘密','悲伤','迷茫','痛苦'];
  const OK = (data) => JSON.stringify(data);
  const ERR = (msg) => JSON.stringify({ error: msg });

  // ===== 世界观查询 helper =====
  // 返回当前对话能访问的所有世界观对象（主世界观 + 单人卡绑定的世界书）
  async function _getAccessibleWorldviews() {
    const result = [];
    try {
      const singleSettings = (typeof SingleMode !== 'undefined') ? SingleMode.getCurrentSingleSettings() : null;
      if (singleSettings && singleSettings.worldviewId) {
        const wv = await DB.get('worldviews', singleSettings.worldviewId);
        if (wv) result.push({ wv, source: 'worldview' });
        // v632：单人卡绑定的世界书们（合并展开）
        if (singleSettings.charType === 'card' && singleSettings.charId && typeof Lorebook !== 'undefined') {
          try {
            const card = await DB.get('singleCards', singleSettings.charId);
            const conv = (typeof Conversations !== 'undefined' && Conversations.getList)
              ? Conversations.getList().find(c => c.id === Conversations.getCurrent())
              : null;
            const lbs = await Lorebook.collectForChat({ conv, card });
            for (const lb of lbs) {
              // 包装成世界观格式喂给 _findInWorldview / _searchExtended
              result.push({
                wv: {
                  name: lb.name || '世界书',
                  festivals: lb.festivals || [],
                  knowledges: lb.knowledges || [],
                  events: lb.events || [],
                  globalNpcs: lb.globalNpcs || [],
                  regions: []
                },
                source: 'card'
              });
            }
          } catch(_) {}
        }
      } else if (typeof Worldview !== 'undefined' && Worldview.getCurrent) {
        const wv = await Worldview.getCurrent();
        if (wv) result.push({ wv, source: 'worldview' });
      }
    } catch(_) {}
    return result;
  }


  // ===== AI 编辑设定 helper（世界观/单人卡，可回滚） =====
  const _clone = (v) => JSON.parse(JSON.stringify(v ?? null));
  function _currentConv() {
    try {
      const id = Conversations.getCurrent && Conversations.getCurrent();
      return (Conversations.getList && Conversations.getList().find(c => c.id === id)) || null;
    } catch(_) { return null; }
  }
  async function _saveConvs() {
    if (typeof Conversations !== 'undefined' && Conversations.saveList) await Conversations.saveList();
  }
  async function _pushEditUndo(entry) {
    const conv = _currentConv();
    if (!conv) return;
    if (!Array.isArray(conv._editUndoStack)) conv._editUndoStack = [];
    conv._editUndoStack.push({ id: 'undo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), ts: Date.now(), ...entry });
    if (conv._editUndoStack.length > 10) conv._editUndoStack = conv._editUndoStack.slice(-10);
    await _saveConvs();
  }
  async function _getWritableWorldview() {
    let id = '';
    try {
      const ss = (typeof SingleMode !== 'undefined' && SingleMode.getCurrentSingleSettings) ? SingleMode.getCurrentSingleSettings() : null;
      if (ss && ss.worldviewId) id = ss.worldviewId;
    } catch(_) {}
    if (!id) {
      const conv = _currentConv();
      id = conv?.singleWorldviewId || conv?.worldviewId || '';
    }
    if ((!id || id === '__default_wv__') && typeof Worldview !== 'undefined' && Worldview.getCurrentId) id = Worldview.getCurrentId() || '';
    if (!id || id === '__default_wv__') return null;
    const wv = await DB.get('worldviews', id);
    return wv ? { id, wv } : null;
  }
  function _findWritableEntry(wv, name, kind) {
    if (!wv || !name) return null;
    const target = String(name).trim().toLowerCase();
    const matches = (s) => s && String(s).trim().toLowerCase() === target;
    const includes = (s) => s && String(s).toLowerCase().includes(target);
    const hits = [];
    if (!kind || kind === 'region') (wv.regions || []).forEach((r, ri) => {
      if (matches(r.name) || includes(r.name)) hits.push({ kind:'region', exact:matches(r.name), ref:r, path:{ ri } });
    });
    if (!kind || kind === 'faction') (wv.regions || []).forEach((r, ri) => (r.factions || []).forEach((f, fi) => {
      if (matches(f.name) || includes(f.name)) hits.push({ kind:'faction', exact:matches(f.name), ref:f, path:{ ri, fi }, region:r.name || '' });
    }));
    if (!kind || kind === 'npc') {
      (wv.globalNpcs || []).forEach((n, ni) => {
        const aliasHit = n.aliases && String(n.aliases).toLowerCase().split(/[,，、]/).some(a => a.trim() === target);
        if (matches(n.name) || aliasHit || includes(n.name) || (n.aliases && String(n.aliases).toLowerCase().includes(target))) hits.push({ kind:'npc', exact:matches(n.name)||aliasHit, ref:n, path:{ global:true, ni }, where:'全图常驻' });
      });
      (wv.regions || []).forEach((r, ri) => (r.factions || []).forEach((f, fi) => (f.npcs || []).forEach((n, ni) => {
        const aliasHit = n.aliases && String(n.aliases).toLowerCase().split(/[,，、]/).some(a => a.trim() === target);
        if (matches(n.name) || aliasHit || includes(n.name) || (n.aliases && String(n.aliases).toLowerCase().includes(target))) hits.push({ kind:'npc', exact:matches(n.name)||aliasHit, ref:n, path:{ ri, fi, ni }, where:`${r.name || '?'} / ${f.name || '?'}` });
      })));
    }
    hits.sort((a,b) => (b.exact?1:0) - (a.exact?1:0));
    return hits[0] || null;
  }
  function _listExtensions(wv, kind) {
    const items = [];
    if (!kind || kind === 'festival') (wv.festivals || []).forEach(x => items.push({ kind:'festival', id:x.id||'', name:x.name||'', date:x.date||'', yearly:!!x.yearly, enabled:x.enabled!==false, content:x.content||'' }));
    (wv.knowledges || []).forEach(x => {
      const k = x.keywordTrigger ? 'dynamic' : 'resident';
      if (!kind || kind === k) items.push({ kind:k, id:x.id||'', name:x.name||'', keys:x.keys||'', position:x.position||'', depth:x.depth||0, enabled:x.enabled!==false, content:x.content||'' });
    });
    return items;
  }
  function _findExtension(wv, kind, idOrName) {
    const target = String(idOrName || '').trim().toLowerCase();
    if (!target) return null;
    if ((!kind || kind === 'festival') && Array.isArray(wv.festivals)) {
      const idx = wv.festivals.findIndex(x => String(x.id||'').toLowerCase() === target || String(x.name||'').toLowerCase() === target);
      if (idx >= 0) return { kind:'festival', list:wv.festivals, idx, item:wv.festivals[idx] };
    }
    if (Array.isArray(wv.knowledges)) {
      const idx = wv.knowledges.findIndex(x => {
        const k = x.keywordTrigger ? 'dynamic' : 'resident';
        return (!kind || kind === k) && (String(x.id||'').toLowerCase() === target || String(x.name||'').toLowerCase() === target);
      });
      if (idx >= 0) return { kind:wv.knowledges[idx].keywordTrigger ? 'dynamic' : 'resident', list:wv.knowledges, idx, item:wv.knowledges[idx] };
    }
    return null;
  }
  async function _saveWorldview(wv) {
    await DB.put('worldviews', wv);
    try {
      const isCurrent = typeof Worldview !== 'undefined' && Worldview.getCurrentId && Worldview.getCurrentId() === wv.id;
      if (isCurrent && typeof Chat !== 'undefined' && Chat.setWorldview) Chat.setWorldview(wv.setting || '');
      // 改了地区/势力/NPC 后重建运行态 NPC 索引，使新增/改名立即生效（与 selectWorldview 同口径）
      if (isCurrent && typeof NPC !== 'undefined' && NPC.init) {
        const flatNpcs = [], flatFacs = [], flatRegions = [];
        (wv.regions || []).forEach(r => {
          flatRegions.push({ id:r.id, name:r.name, summary:r.summary, detail:r.detail, aliases:r.aliases });
          (r.factions || []).forEach(f => {
            flatFacs.push({ ...f, regionName:r.name, regionId:r.id });
            (f.npcs || []).forEach(n => flatNpcs.push({ ...n, faction:f.name, regions:[r.id || r.name] }));
          });
        });
        NPC.init({ npcs:flatNpcs, factions:flatFacs, regions:flatRegions });
      }
    } catch(_) {}
  }
  // 列出当前对话所有可编辑的单人卡（单人模式主角卡 + 对话级挂载的常驻 card 角色）
  async function _listEditableCards() {
    const seen = new Set();
    const refs = [];
    const _add = (id, source) => { if (id && !seen.has(id)) { seen.add(id); refs.push({ id, source }); } };
    // 单人模式主角卡
    try {
      const ss = (typeof SingleMode !== 'undefined' && SingleMode.getCurrentSingleSettings) ? SingleMode.getCurrentSingleSettings() : null;
      if (ss?.charType === 'card' && ss.charId) _add(ss.charId, '主角');
    } catch(_) {}
    const conv = _currentConv();
    if (conv?.isSingle && conv.singleCharType === 'card' && conv.singleCharId) _add(conv.singleCharId, '主角');
    // 对话级挂载的常驻角色（只取 card 类型；npc 走世界观工具改）
    if (conv && Array.isArray(conv.attachedChars)) {
      conv.attachedChars.filter(e => e && e.type === 'card').forEach(e => _add(e.id, '常驻'));
    }
    const out = [];
    for (const r of refs) {
      const card = await DB.get('singleCards', r.id).catch(() => null);
      if (card) out.push({ id: r.id, source: r.source, card });
    }
    return out;
  }
  // 定位单张可编辑卡：传 idOrName 则按 id/名称匹配；不传则取主角卡或唯一卡
  async function _getCurrentCard(idOrName) {
    const cards = await _listEditableCards();
    if (cards.length === 0) return null;
    if (idOrName) {
      const t = String(idOrName).trim().toLowerCase();
      const byId = cards.find(c => String(c.id).toLowerCase() === t);
      if (byId) return { id: byId.id, card: byId.card };
      const byName = cards.find(c => String(c.card.name || '').trim().toLowerCase() === t);
      if (byName) return { id: byName.id, card: byName.card };
      const fuzzy = cards.find(c => String(c.card.name || '').toLowerCase().includes(t));
      if (fuzzy) return { id: fuzzy.id, card: fuzzy.card };
      return null;
    }
    const main = cards.find(c => c.source === '主角');
    if (main) return { id: main.id, card: main.card };
    if (cards.length === 1) return { id: cards[0].id, card: cards[0].card };
    return null; // 多张且无主角卡，需指定
  }

  // 在世界观里找某个名字（地区/势力/地点/常驻角色/角色NPC）
  // kind: 'region' | 'faction' | 'npc' | undefined（不传则全找）
  function _findInWorldview(wv, name, kind) {
    if (!wv || !name) return [];
    const target = String(name).trim().toLowerCase();
    const hits = [];
    const matches = (s) => s && String(s).toLowerCase() === target;
    const includes = (s) => s && String(s).toLowerCase().includes(target);
    // 地区
    if (!kind || kind === 'region') {
      (wv.regions || []).forEach(r => {
        if (matches(r.name)) {
          hits.push({ kind: 'region', exact: true, name: r.name, summary: r.summary || '', detail: r.detail || '' });
        } else if (includes(r.name)) {
          hits.push({ kind: 'region', exact: false, name: r.name, summary: r.summary || '', detail: r.detail || '' });
        }
      });
    }
    // 势力
    if (!kind || kind === 'faction') {
      (wv.regions || []).forEach(r => (r.factions || []).forEach(f => {
        if (matches(f.name)) {
          hits.push({ kind: 'faction', exact: true, name: f.name, region: r.name, summary: f.summary || '', detail: f.detail || '' });
        } else if (includes(f.name)) {
          hits.push({ kind: 'faction', exact: false, name: f.name, region: r.name, summary: f.summary || '', detail: f.detail || '' });
        }
      }));
    }
    // NPC（全图 + 各势力）
    if (!kind || kind === 'npc') {
      const npcMatch = (n, where) => {
        const aliasHit = n.aliases && String(n.aliases).toLowerCase().split(/[,，、]/).some(a => a.trim() === target);
        if (matches(n.name) || aliasHit) {
          hits.push({ kind: 'npc', exact: true, name: n.name, aliases: n.aliases || '', profession: n.profession || '', where, summary: n.summary || '', detail: n.detail || '' });
        } else if (includes(n.name) || (n.aliases && String(n.aliases).toLowerCase().includes(target))) {
          hits.push({ kind: 'npc', exact: false, name: n.name, aliases: n.aliases || '', profession: n.profession || '', where, summary: n.summary || '', detail: n.detail || '' });
        }
      };
      (wv.globalNpcs || []).forEach(n => npcMatch(n, '全图常驻'));
      (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(n => npcMatch(n, `${r.name || '?'} / ${f.name || '?'}`))));
    }
    return hits;
  }

  // 在世界观里搜扩展设定（节日/常驻/动态，不含事件）
  // kind: 'festival' | 'resident' | 'dynamic' | undefined
  function _searchExtended(wv, keyword, kind) {
    if (!wv) return [];
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return [];
    const hits = [];
    const includesKw = (s) => s && String(s).toLowerCase().includes(kw);
    if (!kind || kind === 'festival') {
      (wv.festivals || []).filter(f => f && f.enabled !== false).forEach(f => {
        if (includesKw(f.name) || includesKw(f.content) || includesKw(f.date)) {
          hits.push({ kind: 'festival', name: f.name || '未命名', date: f.date || '', yearly: !!f.yearly, content: f.content || '' });
        }
      });
    }
    const knowledges = (wv.knowledges || []).filter(k => k && k.enabled !== false);
    if (!kind || kind === 'resident') {
      knowledges.filter(k => !k.keywordTrigger).forEach(k => {
        if (includesKw(k.name) || includesKw(k.content) || includesKw(k.keys)) {
          hits.push({ kind: 'resident', name: k.name || '未命名', content: k.content || '' });
        }
      });
    }
    if (!kind || kind === 'dynamic') {
      knowledges.filter(k => k.keywordTrigger).forEach(k => {
        if (includesKw(k.name) || includesKw(k.content) || includesKw(k.keys)) {
          hits.push({ kind: 'dynamic', name: k.name || '未命名', keys: k.keys || '', content: k.content || '' });
        }
      });
    }
    return hits;
  }


  const editDefinitions = [
    { type:'function', function:{ name:'read_worldview_setting', description:'读取当前挂载世界观的基础设定文本。只读，不修改。', parameters:{ type:'object', properties:{}, required:[] } }},
    { type:'function', function:{ name:'update_worldview_setting', description:'修改当前挂载世界观的基础设定文本。仅在用户明确要求修改世界观设定时使用；写入前会保存回滚快照。', parameters:{ type:'object', properties:{ setting:{ type:'string', description:'新的完整基础设定文本，会覆盖原 setting 字段' } }, required:['setting'] } }},
    { type:'function', function:{ name:'read_worldview_entry', description:'读取当前世界观中单个地区/势力/NPC的摘要和详细设定。', parameters:{ type:'object', properties:{ name:{ type:'string', description:'地区/势力/NPC名称或NPC别名' }, kind:{ type:'string', enum:['region','faction','npc'], description:'限定类型；不传则全搜' } }, required:['name'] } }},
    { type:'function', function:{ name:'update_worldview_entry', description:'修改当前世界观中单个地区/势力/NPC的 name/aliases/summary/detail。只改命中的单个条目，写入前会保存回滚快照。', parameters:{ type:'object', properties:{ name:{ type:'string', description:'要修改的条目名称或NPC别名' }, kind:{ type:'string', enum:['region','faction','npc'] }, newName:{ type:'string', description:'新名称，不传则不改' }, aliases:{ type:'string', description:'NPC别名，不传则不改' }, summary:{ type:'string', description:'新摘要，不传则不改' }, detail:{ type:'string', description:'新详细设定，不传则不改' } }, required:['name'] } }},
    { type:'function', function:{ name:'add_worldview_entry', description:'给当前世界观新增一个地区/势力/全图常驻NPC。写入前会保存回滚快照。新增势力时必须指定所属地区名；新增势力下NPC时指定所属地区+势力名。', parameters:{ type:'object', properties:{ kind:{ type:'string', enum:['region','faction','npc'], description:'新增类型' }, name:{ type:'string', description:'名称' }, summary:{ type:'string' }, detail:{ type:'string' }, aliases:{ type:'string', description:'NPC别名' }, region:{ type:'string', description:'势力/NPC归属地区名（新增全图常驻NPC不传）' }, faction:{ type:'string', description:'NPC归属势力名（新增全图常驻NPC不传）' } }, required:['kind','name'] } }},
    { type:'function', function:{ name:'list_extension_entries', description:'列出当前世界观的扩展设定条目（节日/常驻/动态）。用于修改前定位 id。', parameters:{ type:'object', properties:{ kind:{ type:'string', enum:['festival','resident','dynamic'], description:'筛选类型；不传则全部' } }, required:[] } }},
    { type:'function', function:{ name:'add_extension_entry', description:'给当前世界观新增一条扩展设定。写入前会保存回滚快照。', parameters:{ type:'object', properties:{ kind:{ type:'string', enum:['festival','resident','dynamic'], description:'新增类型' }, name:{ type:'string' }, content:{ type:'string' }, keys:{ type:'string', description:'动态条目触发关键词' }, date:{ type:'string', description:'节日日期' }, yearly:{ type:'boolean', description:'节日是否每年重复' }, enabled:{ type:'boolean', description:'是否启用，默认 true' } }, required:['kind','name','content'] } }},
    { type:'function', function:{ name:'update_extension_entry', description:'修改当前世界观的一条扩展设定。用 id 或名称定位；写入前会保存回滚快照。', parameters:{ type:'object', properties:{ id:{ type:'string', description:'条目 id；id/name 至少传一个' }, name:{ type:'string', description:'条目名称；id/name 至少传一个' }, kind:{ type:'string', enum:['festival','resident','dynamic'] }, newName:{ type:'string' }, content:{ type:'string' }, keys:{ type:'string' }, date:{ type:'string' }, yearly:{ type:'boolean' }, enabled:{ type:'boolean' } }, required:[] } }},
    { type:'function', function:{ name:'delete_extension_entry', description:'删除当前世界观的一条扩展设定。仅在用户明确要求删除时使用；写入前会保存回滚快照。', parameters:{ type:'object', properties:{ id:{ type:'string' }, name:{ type:'string' }, kind:{ type:'string', enum:['festival','resident','dynamic'] } }, required:[] } }},
    { type:'function', function:{ name:'list_cards', description:'列出当前对话可编辑的单人卡（单人模式主角卡 + 对话级挂载的常驻角色卡）。修改前用来确认有哪些卡、各自的 id/名称。', parameters:{ type:'object', properties:{}, required:[] } }},
    { type:'function', function:{ name:'read_card', description:'读取单人卡的可编辑文本字段。当前对话只有一张可编辑卡时可不传 card；多张时用 card 指定名称或 id。', parameters:{ type:'object', properties:{ card:{ type:'string', description:'要读的卡名称或 id；只有一张卡时可省略' } }, required:[] } }},
    { type:'function', function:{ name:'update_card', description:'修改单人卡的 name/aliases/detail/firstMes/mesExample。仅在用户明确要求修改时使用；写入前会保存回滚快照。当前对话多张可编辑卡时必须用 card 指定改哪张。', parameters:{ type:'object', properties:{ card:{ type:'string', description:'要改的卡名称或 id（用于定位，不会被写入）；只有一张卡时可省略' }, name:{ type:'string', description:'新角色名' }, aliases:{ type:'string' }, detail:{ type:'string' }, firstMes:{ type:'string' }, mesExample:{ type:'string' } }, required:[] } }},
    { type:'function', function:{ name:'undo_last_edit', description:'撤销上一次由AI编辑工具写入的世界观/扩展设定/单人卡修改。', parameters:{ type:'object', properties:{}, required:[] } }}
  ];


  // ===== 前台工具定义 =====
  const definitions = [
    ...editDefinitions,
    // --- 小纸条 ---
    { type:'function', function:{
      name:'query_notes',
      description:'查询 {{user}}（你在主线里扮演的角色）的情绪记忆碎片（小纸条）。记的是这个角色的偏好/习惯/情绪。当你隐约记得该角色说过什么但不确定细节时调用。',
      parameters:{ type:'object', properties:{
        tag:{ type:'string', enum:NOTE_TAGS, description:'按标签筛选' },
        keyword:{ type:'string', description:'模糊搜索 detail' },
        limit:{ type:'number', description:'返回条数上限，默认5' }
      }, required:[] }
    }},
    { type:'function', function:{
      name:'add_note',
description:'记录一条小纸条。当用户明确表达了偏好/情绪/习惯时调用。只记用户说的/做的，不揣测。可同时调用多次。priority 字段：能稳定体现长期性格（习惯/喜好/厌恶）标 important，单次情绪/偶然事件标 normal。每轮最多 1 条 important。',
parameters:{ type:'object', properties:{
tag:{ type:'string', enum:NOTE_TAGS, description:'标签' },
detail:{ type:'string', description:'以用户角色名为主语如实记录' },
priority:{ type:'string', enum:['important','normal'], description:'重要程度：important=长期性格画像，normal=单次事件。默认normal' },
characters:{ type:'array', items:{type:'string'}, description:'在场角色' }
      }, required:['tag','detail'] }
    }},
    { type:'function', function:{
      name:'update_note',
      description:'修改一条小纸条。仅在用户明确要求修改或记忆确认有误时使用。',
      parameters:{ type:'object', properties:{
        id:{ type:'string', description:'要修改的小纸条 id' },
        tag:{ type:'string', enum:NOTE_TAGS, description:'新标签（不传则不改）' },
        detail:{ type:'string', description:'新内容（不传则不改）' }
      }, required:['id'] }
    }},
    { type:'function', function:{
      name:'delete_note',
      description:'删除一条小纸条。仅在用户明确要求删除时使用。',
      parameters:{ type:'object', properties:{
        id:{ type:'string', description:'要删除的小纸条 id' }
      }, required:['id'] }
    }},
    // --- 事件记忆 ---
    { type:'function', function:{
      name:'query_events',
      description:'查询 {{user}} 所在剧情中已记录的事件记忆（剧情里发生过的事，不是现实中的）。可按关键词搜索标题/内容/参与者/地点。',
      parameters:{ type:'object', properties:{
        keyword:{ type:'string', description:'搜索关键词' },
        participant:{ type:'string', description:'按参与者筛选' },
        limit:{ type:'number', description:'返回条数上限，默认5' }
      }, required:[] }
    }},
    { type:'function', function:{
      name:'add_event',
      description:'记录一条事件记忆。记录剧情中发生的重要事件。',
      parameters:{ type:'object', properties:{
        title:{ type:'string', description:'事件简称' },
        time:{ type:'string', description:'游戏内时间' },
        location:{ type:'string', description:'地点' },
        cause:{ type:'string', description:'起因' },
        process:{ type:'string', description:'经过' },
        result:{ type:'string', description:'结果/影响' },
        participants:{ type:'array', items:{type:'string'}, description:'参与者' }
      }, required:['title'] }
    }},
    { type:'function', function:{
      name:'update_event',
      description:'修改一条事件记忆。仅在用户明确要求或记忆确认有误时使用。',
      parameters:{ type:'object', properties:{
        id:{ type:'string', description:'事件 id' },
        title:{ type:'string' }, time:{ type:'string' }, location:{ type:'string' },
        cause:{ type:'string' }, process:{ type:'string' }, result:{ type:'string' },
        participants:{ type:'array', items:{type:'string'} }
      }, required:['id'] }
    }},
    { type:'function', function:{
      name:'delete_event',
      description:'删除一条事件记忆。仅在用户明确要求删除时使用。',
      parameters:{ type:'object', properties:{
        id:{ type:'string', description:'事件 id' }
      }, required:['id'] }
    }},
    // --- 人际关系 ---
    { type:'function', function:{
      name:'query_relations',
      description:'查询 {{user}} 与剧情中角色的人际关系记忆（剧情里的关系，不是现实中的）。可按角色名搜索。',
      parameters:{ type:'object', properties:{
        name:{ type:'string', description:'角色名（精确或模糊）' },
        limit:{ type:'number', description:'返回条数上限，默认5' }
      }, required:[] }
    }},
    { type:'function', function:{
      name:'upsert_relation',
      description:'记录或更新一条人际关系。按角色名匹配，已存在则更新，不存在则新建。',
      parameters:{ type:'object', properties:{
        title:{ type:'string', description:'角色姓名' },
        relationship:{ type:'string', description:'与用户角色的当前关系' },
        impression:{ type:'string', description:'该角色对用户角色的看法' },
        emotion:{ type:'string', description:'情感变化描述（追加到历程中）' }
      }, required:['title'] }
    }},
    { type:'function', function:{
      name:'delete_relation',
      description:'删除一条人际关系记忆。仅在用户明确要求删除时使用。',
      parameters:{ type:'object', properties:{
        id:{ type:'string', description:'关系记忆 id' }
      }, required:['id'] }
    }},
    // --- 世界观查询 ---
    { type:'function', function:{
      name:'query_worldview_detail',
      description:'按名字查地区/势力/NPC的详细设定。每轮只发了简介+索引，想要完整 detail 时调用。只返回该条目本身，不会带出下属（查地区不返回里面的势力/NPC）。',
      parameters:{ type:'object', properties:{
        name:{ type:'string', description:'要查的名字（地区名/势力名/NPC名/NPC别名）' },
        kind:{ type:'string', enum:['region','faction','npc'], description:'限定类型；不传则地区/势力/NPC 都搜' }
      }, required:['name'] }
    }},
    { type:'function', function:{
      name:'query_worldview_extended',
      description:'按关键词搜扩展设定（节日/常驻条目/动态条目）的完整内容。常驻条目每轮已全发，动态条目只发了名字索引；想看动态条目详情或确认有没有相关设定时调用。不含事件。',
      parameters:{ type:'object', properties:{
        keyword:{ type:'string', description:'搜索关键词（在名字/内容/触发词里找）' },
        kind:{ type:'string', enum:['festival','resident','dynamic'], description:'限定类型；不传则三类都搜' }
      }, required:['keyword'] }
    }},
// --- 历史消息搜索 ---
  { type:'function', function:{
    name:'search_messages',
    description:'按关键词搜当前对话被归档的历史消息。归档消息是被总结剥离掉、当前已经看不到的旧对话；搜不到通常说明这部分对话还在上下文里能直接看到。每条命中会带上前后各 1 条作为上下文。',
    parameters:{ type:'object', properties:{
      keyword:{ type:'string', description:'搜索关键词' },
      limit:{ type:'number', description:'返回的命中段落数，默认 3，最大 5' }
    }, required:['keyword'] }
  }},
  // --- 使用说明查询 ---
  { type:'function', function:{
    name:'query_guide',
    description:'查询 skynex 应用使用说明的章节详情。功能目录已在上下文中提供，本工具用来查看某个具体章节的完整内容。传 keyword（章节名或功能关键词）返回匹配的章节内容（标题命中与正文命中都会返回）。用来回答用户关于"这个功能在哪""怎么用"等问题。',
    parameters:{ type:'object', properties:{
      keyword:{ type:'string', description:'搜索关键词，不传则返回目录' }
    }, required:[] }
  }},
  ];

  // ===== 后台工具定义 =====
  const backstageDefinitions = [
    ...editDefinitions,
    { type:'function', function:{
      name:'query_backstage_notes',
      description:'查询 {{user}} 本人（现实中和你聊天的这个人）的记忆碎片（后台专属记忆库）。记的是现实里 ta 的偏好/情绪/事件，与主线剧情无关。注意：这和主线里被扮演角色的小纸条（query_mainline_notes）是两回事——这个查的是真实用户本人。',
      parameters:{ type:'object', properties:{
        tag:{ type:'string', enum:NOTE_TAGS, description:'按标签筛选' },
        keyword:{ type:'string', description:'模糊搜索' },
        limit:{ type:'number', description:'返回条数上限，默认5' }
      }, required:[] }
    }},
    { type:'function', function:{
      name:'add_backstage_note',
description:'记录一条值得留下的 {{user}} 片段。聊天里如果 {{user}} 表达了什么能反映 ta 是谁的东西（喜好、情绪、事件），就顺手记一条。不用每轮都记。priority 字段：长期性格画像标 important，单次情绪/偶然事件标 normal。每轮最多 1 条 important。',
parameters:{ type:'object', properties:{
tag:{ type:'string', description:'标签。建议从三类里选最贴切的：偏好类（喜欢/讨厌/习惯）、情绪类（实际什么情绪就写什么，如开心/感动/悲伤/愤怒等）、事件类（有趣/伏笔/秘密）' },
detail:{ type:'string', description:'内容要带前因+{{user}}的反应，引用原话时保留引号' },
priority:{ type:'string', enum:['important','normal'], description:'重要程度：important=长期性格画像，normal=单次事件。默认normal' }
}, required:['tag','detail'] }
    }},
    { type:'function', function:{
      name:'update_backstage_note',
      description:'改一条已记下的片段。{{user}} 说"那条不对，应该是xxx"、主动让你订正时，或者那条现在已经不再适用时用。',
      parameters:{ type:'object', properties:{
        id:{ type:'string', description:'记忆 id' },
        tag:{ type:'string' },
        detail:{ type:'string' }
      }, required:['id'] }
    }},
    { type:'function', function:{
      name:'delete_backstage_note',
      description:'删一条已记下的片段。{{user}} 明确说"忘掉这条"或类似意思时，或者你发现有重复的记忆时用。',
      parameters:{ type:'object', properties:{
        id:{ type:'string', description:'记忆 id' }
      }, required:['id'] }
    }},
    { type:'function', function:{
      name:'query_mainline_notes',
      description:'查询主线剧情里 {{user}} 扮演的那个角色的情绪记忆碎片（小纸条）。记的是被扮演角色在剧情中的偏好/习惯/情绪，属于故事内容，不是现实用户本人的。想了解主线角色时用；想了解真实用户本人用 query_backstage_notes。',
      parameters:{ type:'object', properties:{
        tag:{ type:'string', enum:NOTE_TAGS, description:'按标签筛选' },
        keyword:{ type:'string', description:'模糊搜索' },
        limit:{ type:'number', description:'返回条数上限，默认5' }
      }, required:[] }
    }},
    { type:'function', function:{
      name:'query_directive',
      description:'查询当前主线的剧情引导状态（是否有生效中的引导、内容、剩余轮数）。',
      parameters:{ type:'object', properties:{}, required:[] }
    }},
    { type:'function', function:{
      name:'set_directive',
      description:'设置或修改主线的剧情引导。会覆盖当前已有内容。使用前必须向用户确认内容和轮数。',
      parameters:{ type:'object', properties:{
        content:{ type:'string', description:'引导内容（希望剧情朝什么方向发展）' },
        rounds:{ type:'number', description:'持续轮数，默认3' }
      }, required:['content'] }
    }},
    { type:'function', function:{
      name:'remove_directive',
      description:'清空当前主线的剧情引导。仅在用户明确同意撤销时使用。',
      parameters:{ type:'object', properties:{}, required:[] }
    }},
    // --- 世界观查询（后台也能查，方便闲聊时引用设定） ---
    { type:'function', function:{
      name:'query_worldview_detail',
      description:'按名字查这个对话挂载的世界观里的地区/势力/NPC的详细设定。只返回该条目本身，不含下属。',
      parameters:{ type:'object', properties:{
        name:{ type:'string', description:'要查的名字（地区名/势力名/NPC名/NPC别名）' },
        kind:{ type:'string', enum:['region','faction','npc'], description:'限定类型；不传则全搜' }
      }, required:['name'] }
    }},
    { type:'function', function:{
      name:'query_worldview_extended',
      description:'按关键词搜这个对话挂载的世界观的扩展设定（节日/常驻/动态条目）的完整内容。不含事件。',
      parameters:{ type:'object', properties:{
        keyword:{ type:'string', description:'搜索关键词' },
        kind:{ type:'string', enum:['festival','resident','dynamic'], description:'限定类型；不传则三类都搜' }
      }, required:['keyword'] }
    }},
    // --- 历史消息搜索（后台搜的是主线归档，方便回顾旧剧情） ---
  { type:'function', function:{
    name:'search_messages',
    description:'按关键词搜主线对话被归档的历史消息。归档是被总结剥离掉、当前已经看不到的旧对话内容。每条命中会带前后各 1 条作为上下文。',
    parameters:{ type:'object', properties:{
      keyword:{ type:'string', description:'搜索关键词' },
      limit:{ type:'number', description:'返回的命中段落数，默认 3，最大 5' }
    }, required:['keyword'] }
  }},
  // --- 使用说明查询 ---
  { type:'function', function:{
    name:'query_guide',
    description:'查询 skynex 应用使用说明的章节详情。功能目录已在上下文中提供，本工具用来查看某个具体章节的完整内容。传 keyword（章节名或功能关键词）返回匹配的章节内容（标题命中与正文命中都会返回）。用来回答用户关于"这个功能在哪""怎么用"等问题。',
    parameters:{ type:'object', properties:{
      keyword:{ type:'string', description:'搜索关键词，不传则返回目录' }
    }, required:[] }
  }},
    // --- 复用前台的事件 / 关系查询 ---
    { type:'function', function:{
      name:'query_events',
      description:'查询主线已记录的剧情事件。可按关键词搜索标题/内容/参与者/地点。',
      parameters:{ type:'object', properties:{
        keyword:{ type:'string', description:'搜索关键词' },
        participant:{ type:'string', description:'按参与者筛选' },
        limit:{ type:'number', description:'返回条数上限，默认5' }
      }, required:[] }
    }},
    { type:'function', function:{
      name:'query_relations',
      description:'查询主线人际关系记忆。可按角色名搜索。',
      parameters:{ type:'object', properties:{
        name:{ type:'string', description:'角色名（精确或模糊）' },
        limit:{ type:'number', description:'返回条数上限，默认5' }
      }, required:[] }
    }}
  ];

  // ===== handler =====
  const handlers = {

    // --- 小纸条 CRUD ---
    async query_notes(args) {
      const all = await _allMem(); const scope = _scope();
      let notes = all.filter(m => m.type === 'note' && m.scope === scope);
      if (args.tag) notes = notes.filter(n => n.tag === args.tag);
      if (args.keyword) { const kw = args.keyword.toLowerCase(); notes = notes.filter(n => (n.detail||'').toLowerCase().includes(kw)); }
      notes.sort((a,b) => b.timestamp - a.timestamp);
      notes = notes.slice(0, args.limit || 5);
      if (!notes.length) return OK({ result:'没有找到相关的小纸条。' });
      return OK({ result: notes.map(n => ({ id:n.id, tag:n.tag, detail:n.detail, characters:n.characters||[], time:n.time||'' })) });
    },
    async add_note(args) {
if (!args.tag || !args.detail) return ERR('缺少 tag 或 detail');
const note = await Memory.addNote({ tag:args.tag, detail:args.detail, priority:args.priority||'normal', characters:args.characters||[], scope:_scope() });
return note ? OK({ success:true, id:note.id, message:'已记住。' }) : OK({ success:false, message:'重复记录，已跳过。' });
},
    async update_note(args) {
      if (!args.id) return ERR('缺少 id');
      const m = await DB.get('memories', args.id);
      if (!m || m.type !== 'note') return ERR('未找到该小纸条');
      if (args.tag && NOTE_TAGS.includes(args.tag)) m.tag = args.tag;
      if (args.detail) m.detail = args.detail;
      m.timestamp = Utils.timestamp();
      await DB.put('memories', m);
      return OK({ success:true, message:'已修改。' });
    },
    async delete_note(args) {
      if (!args.id) return ERR('缺少 id');
      await DB.del('memories', args.id);
      return OK({ success:true, message:'已删除。' });
    },

    // --- 事件 CRUD ---
    async query_events(args) {
      const all = await _allMem(); const scope = _scope();
      let events = all.filter(m => m.type === 'event' && m.scope === scope);
      if (args.keyword) {
        const kw = args.keyword.toLowerCase();
        events = events.filter(e =>
          (e.title||'').toLowerCase().includes(kw) ||
          (e.content||'').toLowerCase().includes(kw) ||
          (e.location||'').toLowerCase().includes(kw) ||
          (e.participants||[]).join(' ').toLowerCase().includes(kw)
        );
      }
      if (args.participant) {
        const p = args.participant.toLowerCase();
        events = events.filter(e => (e.participants||[]).some(x => x.toLowerCase().includes(p)));
      }
      events.sort((a,b) => b.timestamp - a.timestamp);
      events = events.slice(0, args.limit || 5);
      if (!events.length) return OK({ result:'没有找到相关事件。' });
      return OK({ result: events.map(e => ({
        id:e.id, title:e.title, time:e.time||'', location:e.location||'',
        cause:e.cause||'', process:e.process||'', result:e.result||'',
        participants:e.participants||[]
      })) });
    },
    async add_event(args) {
      if (!args.title) return ERR('缺少 title');
      const ev = await Memory.add('event', {
        title:args.title, time:args.time||'', location:args.location||'',
        cause:args.cause||'', process:args.process||'', result:args.result||'',
        participants:args.participants||[], scope:_scope()
      });
      return ev ? OK({ success:true, id:ev.id, message:'事件已记录。' }) : ERR('记录失败');
    },
    async update_event(args) {
      if (!args.id) return ERR('缺少 id');
      const m = await DB.get('memories', args.id);
      if (!m || m.type !== 'event') return ERR('未找到该事件');
      if (args.title) m.title = args.title;
      if (args.time) m.time = args.time;
      if (args.location) m.location = args.location;
      if (args.cause) m.cause = args.cause;
      if (args.process) m.process = args.process;
      if (args.result) m.result = args.result;
      if (args.participants) m.participants = args.participants;
      m.content = [m.cause, m.process, m.result].filter(Boolean).join('\n');
      m.timestamp = Utils.timestamp();
      await DB.put('memories', m);
      return OK({ success:true, message:'事件已修改。' });
    },
    async delete_event(args) {
      if (!args.id) return ERR('缺少 id');
      await DB.del('memories', args.id);
      return OK({ success:true, message:'事件已删除。' });
    },

    // --- 人际关系 CRD ---
    async query_relations(args) {
      const all = await _allMem(); const scope = _scope();
      let rels = all.filter(m => m.type === 'relation' && m.scope === scope);
      if (args.name) {
        const n = args.name.toLowerCase();
        rels = rels.filter(r => (r.title||'').toLowerCase().includes(n));
      }
      rels.sort((a,b) => b.timestamp - a.timestamp);
      rels = rels.slice(0, args.limit || 5);
      if (!rels.length) return OK({ result:'没有找到相关人际关系。' });
      return OK({ result: rels.map(r => ({
        id:r.id, title:r.title, relationship:r.relationship||'', impression:r.impression||'',
        emotions:r.emotions||[]
      })) });
    },
    async upsert_relation(args) {
      if (!args.title) return ERR('缺少 title（角色名）');
      const rel = await Memory.upsertRelation({
        title:args.title, relationship:args.relationship||'',
        impression:args.impression||'', emotion:args.emotion||'',
        scope:_scope()
      });
      return rel ? OK({ success:true, id:rel.id, message:'关系已更新。' }) : ERR('更新失败');
    },
    async delete_relation(args) {
      if (!args.id) return ERR('缺少 id');
      await DB.del('memories', args.id);
      return OK({ success:true, message:'关系已删除。' });
    },

    // --- 后台 CRUD ---
    // 后台查主线小纸条：复用 query_notes 的逻辑（按当前面具 scope 查 type='note'）
    async query_mainline_notes(args) {
      const all = await _allMem(); const scope = _scope();
      let notes = all.filter(m => m.type === 'note' && m.scope === scope);
      if (args.tag) notes = notes.filter(n => n.tag === args.tag);
      if (args.keyword) { const kw = args.keyword.toLowerCase(); notes = notes.filter(n => (n.detail||'').toLowerCase().includes(kw)); }
      notes.sort((a,b) => b.timestamp - a.timestamp);
      notes = notes.slice(0, args.limit || 5);
      if (!notes.length) return OK({ result:'没有找到相关的主线小纸条。' });
      return OK({ result: notes.map(n => ({ id:n.id, tag:n.tag, detail:n.detail, characters:n.characters||[], time:n.time||'' })) });
    },
    async query_backstage_notes(args) {
      const notes = await Memory.queryBackstageNotes({ tag:args.tag, keyword:args.keyword, limit:args.limit||5 });
      if (!notes.length) return OK({ result:'没有找到相关记忆。' });
      return OK({ result: notes.map(n => ({ id:n.id, tag:n.tag, detail:n.detail, time:n.time||'' })) });
    },
    async add_backstage_note(args) {
      if (!args.tag || !args.detail) return ERR('缺少 tag 或 detail');
      // 自动注入来源信息
      const convId = Conversations.getCurrent() || '';
      const conv = Conversations.getList().find(c => c.id === convId);
      const convName = conv?.title || conv?.name || '';
      const wvId = conv?.singleWorldviewId || conv?.worldviewId || '';
      let worldviewName = '';
      if (wvId && wvId !== '__default_wv__') {
        try {
          const wv = await DB.get('worldviews', wvId);
          worldviewName = wv?.name || '';
        } catch(_) {}
      }
      const note = await Memory.addBackstageNote({
        tag: args.tag,
        detail: args.detail,
        priority: args.priority || 'normal',
        convId,
        convName,
        worldviewId: wvId,
        worldviewName
      });
      return note ? OK({ success:true, id:note.id, message:'已记住。' }) : OK({ success:false, message:'重复记录，已跳过。' });
    },
    async update_backstage_note(args) {
      if (!args.id) return ERR('缺少 id');
      const m = await DB.get('memories', args.id);
      if (!m || m.type !== 'backstage_note') return ERR('未找到该记忆');
      if (args.tag && String(args.tag).trim()) m.tag = String(args.tag).trim();
      if (args.detail) m.detail = args.detail;
      m.timestamp = Utils.timestamp();
      await DB.put('memories', m);
      return OK({ success:true, message:'已修改。' });
    },
    async delete_backstage_note(args) {
      if (!args.id) return ERR('缺少 id');
      await DB.del('memories', args.id);
      return OK({ success:true, message:'已删除。' });
    },

    // --- 剧情引导 ---
    async query_directive() {
      if (typeof Chat === 'undefined' || !Chat._getConvSettings) return ERR('Chat 模块不可用');
      const s = Chat._getConvSettings();
      if (!s.directive || s.directiveRemaining <= 0) return OK({ active:false, message:'当前没有生效中的剧情引导。' });
      return OK({ active:true, content:s.directive, remaining:s.directiveRemaining, total:s.directiveTotal });
    },
    async set_directive(args) {
      if (!args.content) return ERR('缺少 content');
      const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
      if (!conv) return ERR('找不到当前对话');
      const rounds = Math.max(1, Math.min(50, args.rounds || 3));
      conv.convDirective = args.content;
      conv.convDirectiveRemaining = rounds;
      conv.convDirectiveTotal = rounds;
      await Conversations.saveList();
      return OK({ success:true, message:`剧情引导已设置，持续${rounds}轮。` });
    },
    async remove_directive() {
      const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
      if (!conv) return ERR('找不到当前对话');
      conv.convDirective = '';
      conv.convDirectiveRemaining = 0;
      conv.convDirectiveTotal = 0;
      await Conversations.saveList();
      return OK({ success:true, message:'剧情引导已清空。' });
    },

    // --- 世界观查询 ---
    async query_worldview_detail(args) {
      if (!args.name) return ERR('缺少 name');
      const sources = await _getAccessibleWorldviews();
      if (sources.length === 0) return OK({ result: '当前对话没有挂载世界观。' });
      const allHits = [];
      for (const { wv, source } of sources) {
        const hits = _findInWorldview(wv, args.name, args.kind);
        hits.forEach(h => allHits.push({ ...h, _from: source === 'card' ? '单人卡' : (wv.name || '世界观') }));
      }
      if (allHits.length === 0) return OK({ result: `没找到名为「${args.name}」的${args.kind ? args.kind : '地区/势力/NPC'}。` });
      // 精确匹配优先
      const exact = allHits.filter(h => h.exact);
      const fuzzy = allHits.filter(h => !h.exact);
      const items = (exact.length > 0 ? exact : fuzzy).slice(0, 5).map(h => {
        const item = { kind: h.kind, name: h.name, source: h._from };
        if (h.kind === 'faction') item.region = h.region;
        if (h.kind === 'npc') {
          if (h.aliases) item.aliases = h.aliases;
          if (h.where) item.where = h.where;
        }
        if (h.summary) item.summary = h.summary;
        if (h.detail) item.detail = h.detail;
        return item;
      });
      const note = exact.length === 0 ? `（没有完全匹配，返回模糊匹配结果）` : undefined;
      return OK(note ? { items, note } : { items });
    },

    async query_worldview_extended(args) {
      if (!args.keyword) return ERR('缺少 keyword');
      const sources = await _getAccessibleWorldviews();
      if (sources.length === 0) return OK({ result: '当前对话没有挂载世界观。' });
      const allHits = [];
      for (const { wv, source } of sources) {
        const hits = _searchExtended(wv, args.keyword, args.kind);
        hits.forEach(h => allHits.push({ ...h, source: source === 'card' ? '单人卡' : (wv.name || '世界观') }));
      }
      if (allHits.length === 0) return OK({ result: `没找到包含「${args.keyword}」的${args.kind ? args.kind : '扩展'}设定。` });
      const items = allHits.slice(0, 8);
      return OK({ items });
    },


    // --- AI 编辑设定（世界观/单人卡，可回滚） ---
    async read_worldview_setting() {
      const got = await _getWritableWorldview();
      if (!got) return ERR('当前没有可写入的世界观');
      return OK({ id: got.id, name: got.wv.name || '', setting: got.wv.setting || '' });
    },
    async update_worldview_setting(args) {
      if (typeof args.setting !== 'string') return ERR('缺少 setting');
      const got = await _getWritableWorldview();
      if (!got) return ERR('当前没有可写入的世界观');
      await _pushEditUndo({ type:'worldview_setting', worldviewId:got.id, label:`世界观基础设定：${got.wv.name || got.id}`, before:got.wv.setting || '' });
      got.wv.setting = args.setting;
      await _saveWorldview(got.wv);
      return OK({ success:true, message:'世界观基础设定已修改；可用 undo_last_edit 回滚。' });
    },
    async read_worldview_entry(args) {
      if (!args.name) return ERR('缺少 name');
      const got = await _getWritableWorldview();
      if (!got) return ERR('当前没有可写入的世界观');
      const hit = _findWritableEntry(got.wv, args.name, args.kind);
      if (!hit) return ERR('未找到对应地区/势力/NPC');
      return OK({ kind:hit.kind, where:hit.where || hit.region || '', name:hit.ref.name || '', aliases:hit.ref.aliases || '', summary:hit.ref.summary || '', detail:hit.ref.detail || '' });
    },
    async update_worldview_entry(args) {
      if (!args.name) return ERR('缺少 name');
      const got = await _getWritableWorldview();
      if (!got) return ERR('当前没有可写入的世界观');
      const hit = _findWritableEntry(got.wv, args.name, args.kind);
      if (!hit) return ERR('未找到对应地区/势力/NPC');
      await _pushEditUndo({ type:'worldview_entry', worldviewId:got.id, label:`${hit.kind}:${hit.ref.name || args.name}`, path:hit.path, kind:hit.kind, before:_clone(hit.ref) });
      if (typeof args.newName === 'string') hit.ref.name = args.newName;
      if (hit.kind === 'npc' && typeof args.aliases === 'string') hit.ref.aliases = args.aliases;
      if (typeof args.summary === 'string') hit.ref.summary = args.summary;
      if (typeof args.detail === 'string') hit.ref.detail = args.detail;
      await _saveWorldview(got.wv);
      return OK({ success:true, message:`${hit.kind} 已修改；可用 undo_last_edit 回滚。` });
    },
    async add_worldview_entry(args) {
      if (!args.kind || !args.name) return ERR('缺少 kind/name');
      const got = await _getWritableWorldview();
      if (!got) return ERR('当前没有可写入的世界观');
      const wv = got.wv;
      const id = (args.kind === 'region' ? 'reg_' : args.kind === 'faction' ? 'fac_' : 'npc_') + (typeof Utils !== 'undefined' ? Utils.uuid().slice(0,8) : Date.now().toString(36));
      if (args.kind === 'region') {
        if (!Array.isArray(wv.regions)) wv.regions = [];
        const entry = { id, name:args.name, summary:args.summary||'', detail:args.detail||'', factions:[] };
        wv.regions.push(entry);
        await _pushEditUndo({ type:'entry_add', worldviewId:got.id, label:`新增地区:${args.name}`, kind:'region', id });
      } else if (args.kind === 'faction') {
        if (!args.region) return ERR('新增势力必须指定 region（所属地区名）');
        const reg = (wv.regions || []).find(r => String(r.name||'').trim().toLowerCase() === String(args.region).trim().toLowerCase());
        if (!reg) return ERR(`找不到地区「${args.region}」`);
        if (!Array.isArray(reg.factions)) reg.factions = [];
        const entry = { id, name:args.name, summary:args.summary||'', detail:args.detail||'', npcs:[] };
        reg.factions.push(entry);
        await _pushEditUndo({ type:'entry_add', worldviewId:got.id, label:`新增势力:${args.name}`, kind:'faction', id, region:args.region });
      } else if (args.kind === 'npc') {
        const entry = { id, name:args.name, aliases:args.aliases||'', summary:args.summary||'', detail:args.detail||'' };
        if (!args.region && !args.faction) {
          // 全图常驻NPC
          if (!Array.isArray(wv.globalNpcs)) wv.globalNpcs = [];
          wv.globalNpcs.push(entry);
          await _pushEditUndo({ type:'entry_add', worldviewId:got.id, label:`新增全图NPC:${args.name}`, kind:'npc', id, global:true });
        } else {
          // 归属地区/势力的 NPC
          if (!args.region || !args.faction) return ERR('新增势力下NPC时必须同时指定 region + faction');
          const reg = (wv.regions || []).find(r => String(r.name||'').trim().toLowerCase() === String(args.region).trim().toLowerCase());
          if (!reg) return ERR(`找不到地区「${args.region}」`);
          const fac = (reg.factions || []).find(f => String(f.name||'').trim().toLowerCase() === String(args.faction).trim().toLowerCase());
          if (!fac) return ERR(`找不到势力「${args.faction}」`);
          if (!Array.isArray(fac.npcs)) fac.npcs = [];
          fac.npcs.push(entry);
          await _pushEditUndo({ type:'entry_add', worldviewId:got.id, label:`新增NPC:${args.name}`, kind:'npc', id, region:args.region, faction:args.faction });
        }
      } else return ERR('kind 必须是 region/faction/npc');
      await _saveWorldview(wv);
      return OK({ success:true, id, message:`${args.kind} 已新增；可用 undo_last_edit 回滚。` });
    },
    async list_extension_entries(args) {
      const got = await _getWritableWorldview();
      if (!got) return ERR('当前没有可写入的世界观');
      return OK({ worldview:got.wv.name || got.id, items:_listExtensions(got.wv, args.kind) });
    },
    async add_extension_entry(args) {
      if (!args.kind || !args.name || !args.content) return ERR('缺少 kind/name/content');
      const got = await _getWritableWorldview();
      if (!got) return ERR('当前没有可写入的世界观');
      const id = (args.kind === 'festival' ? 'fest_' : 'know_') + Utils.uuid().slice(0,8);
      let item;
      if (args.kind === 'festival') {
        if (!Array.isArray(got.wv.festivals)) got.wv.festivals = [];
        item = { id, name:args.name, date:args.date || '', yearly:args.yearly !== false, content:args.content, enabled:args.enabled !== false };
        got.wv.festivals.push(item);
      } else {
        if (!Array.isArray(got.wv.knowledges)) got.wv.knowledges = [];
        item = { id, name:args.name, content:args.content, enabled:args.enabled !== false, keywordTrigger:args.kind === 'dynamic', keys:args.keys || '', position:'system_top', depth:0 };
        got.wv.knowledges.push(item);
      }
      await _pushEditUndo({ type:'extension_add', worldviewId:got.id, label:`新增扩展:${args.name}`, kind:args.kind, id });
      await _saveWorldview(got.wv);
      return OK({ success:true, id, message:'扩展设定已新增；可用 undo_last_edit 回滚。' });
    },
    async update_extension_entry(args) {
      const key = args.id || args.name;
      if (!key) return ERR('缺少 id 或 name');
      const got = await _getWritableWorldview();
      if (!got) return ERR('当前没有可写入的世界观');
      const hit = _findExtension(got.wv, args.kind, key);
      if (!hit) return ERR('未找到扩展设定条目');
      await _pushEditUndo({ type:'extension_update', worldviewId:got.id, label:`扩展:${hit.item.name || key}`, kind:hit.kind, id:hit.item.id || '', before:_clone(hit.item) });
      if (typeof args.newName === 'string') hit.item.name = args.newName;
      if (typeof args.content === 'string') hit.item.content = args.content;
      if (typeof args.enabled === 'boolean') hit.item.enabled = args.enabled;
      if (hit.kind === 'festival') {
        if (typeof args.date === 'string') hit.item.date = args.date;
        if (typeof args.yearly === 'boolean') hit.item.yearly = args.yearly;
      } else if (typeof args.keys === 'string') hit.item.keys = args.keys;
      await _saveWorldview(got.wv);
      return OK({ success:true, message:'扩展设定已修改；可用 undo_last_edit 回滚。' });
    },
    async delete_extension_entry(args) {
      const key = args.id || args.name;
      if (!key) return ERR('缺少 id 或 name');
      const got = await _getWritableWorldview();
      if (!got) return ERR('当前没有可写入的世界观');
      const hit = _findExtension(got.wv, args.kind, key);
      if (!hit) return ERR('未找到扩展设定条目');
      const before = _clone(hit.item);
      hit.list.splice(hit.idx, 1);
      await _pushEditUndo({ type:'extension_delete', worldviewId:got.id, label:`删除扩展:${before.name || key}`, kind:hit.kind, before });
      await _saveWorldview(got.wv);
      return OK({ success:true, message:'扩展设定已删除；可用 undo_last_edit 回滚。' });
    },
    async list_cards() {
      const cards = await _listEditableCards();
      if (cards.length === 0) return OK({ result:'当前对话没有可编辑的单人卡（主角卡或常驻挂载角色）。' });
      return OK({ items: cards.map(c => ({ id:c.id, source:c.source, name:c.card.name||'', aliases:c.card.aliases||'', summary:(c.card.detail||'').slice(0,60) })) });
    },
    async read_card(args) {
      const got = await _getCurrentCard(args && (args.card || args.name));
      if (!got) {
        const cards = await _listEditableCards();
        if (cards.length > 1) return ERR('当前对话有多张可编辑卡，请用 card 参数指定（名称或 id）。可先用 list_cards 查看。');
        return ERR('当前对话没有可编辑的单人卡');
      }
      const c = got.card;
      return OK({ id:got.id, name:c.name||'', aliases:c.aliases||'', detail:c.detail||'', firstMes:c.firstMes||'', mesExample:c.mesExample||'' });
    },
    async update_card(args) {
      const got = await _getCurrentCard(args && (args.card || args.name_locate));
      if (!got) {
        const cards = await _listEditableCards();
        if (cards.length > 1) return ERR('当前对话有多张可编辑卡，请用 card 参数指定要改哪张（名称或 id）。可先用 list_cards 查看。');
        return ERR('当前对话没有可编辑的单人卡');
      }
      const fields = ['name','aliases','detail','firstMes','mesExample'];
      if (!fields.some(k => typeof args[k] === 'string')) return ERR('没有可修改字段');
      await _pushEditUndo({ type:'card_update', cardId:got.id, label:`单人卡:${got.card.name || got.id}`, before:_clone(got.card) });
      fields.forEach(k => { if (typeof args[k] === 'string') got.card[k] = args[k]; });
      if (typeof SingleCard !== 'undefined' && SingleCard.save) await SingleCard.save(got.card); else await DB.put('singleCards', got.card);
      return OK({ success:true, id:got.id, message:`单人卡「${got.card.name||got.id}」已修改；可用 undo_last_edit 回滚。` });
    },
    async undo_last_edit() {
      const conv = _currentConv();
      if (!conv || !Array.isArray(conv._editUndoStack) || conv._editUndoStack.length === 0) return ERR('没有可回滚的 AI 编辑记录');
      const u = conv._editUndoStack.pop();
      if (u.type === 'worldview_setting') {
        const wv = await DB.get('worldviews', u.worldviewId); if (!wv) return ERR('找不到要回滚的世界观');
        wv.setting = u.before || ''; await _saveWorldview(wv);
      } else if (u.type === 'worldview_entry') {
        const wv = await DB.get('worldviews', u.worldviewId); if (!wv) return ERR('找不到要回滚的世界观');
        let ref = null, p = u.path || {};
        if (u.kind === 'region') ref = wv.regions?.[p.ri];
        else if (u.kind === 'faction') ref = wv.regions?.[p.ri]?.factions?.[p.fi];
        else if (u.kind === 'npc') ref = p.global ? wv.globalNpcs?.[p.ni] : wv.regions?.[p.ri]?.factions?.[p.fi]?.npcs?.[p.ni];
        if (!ref) return ERR('找不到要回滚的条目');
        Object.keys(ref).forEach(k => delete ref[k]); Object.assign(ref, _clone(u.before));
        await _saveWorldview(wv);
      } else if (u.type === 'entry_add') {
        const wv = await DB.get('worldviews', u.worldviewId); if (!wv) return ERR('找不到要回滚的世界观');
        if (u.kind === 'region') { wv.regions = (wv.regions||[]).filter(r => r.id !== u.id); }
        else if (u.kind === 'faction') {
          for (const r of (wv.regions||[])) { r.factions = (r.factions||[]).filter(f => f.id !== u.id); }
        } else if (u.kind === 'npc') {
          if (u.global) { wv.globalNpcs = (wv.globalNpcs||[]).filter(n => n.id !== u.id); }
          else { for (const r of (wv.regions||[])) for (const f of (r.factions||[])) { f.npcs = (f.npcs||[]).filter(n => n.id !== u.id); } }
        }
        await _saveWorldview(wv);
      } else if (u.type === 'extension_add') {
        const wv = await DB.get('worldviews', u.worldviewId); if (!wv) return ERR('找不到要回滚的世界观');
        const hit = _findExtension(wv, u.kind, u.id); if (hit) hit.list.splice(hit.idx, 1);
        await _saveWorldview(wv);
      } else if (u.type === 'extension_update') {
        const wv = await DB.get('worldviews', u.worldviewId); if (!wv) return ERR('找不到要回滚的世界观');
        const hit = _findExtension(wv, u.kind, u.id || u.before?.name); if (!hit) return ERR('找不到要回滚的扩展设定');
        Object.keys(hit.item).forEach(k => delete hit.item[k]); Object.assign(hit.item, _clone(u.before));
        await _saveWorldview(wv);
      } else if (u.type === 'extension_delete') {
        const wv = await DB.get('worldviews', u.worldviewId); if (!wv) return ERR('找不到要回滚的世界观');
        if (u.kind === 'festival') { if (!Array.isArray(wv.festivals)) wv.festivals = []; wv.festivals.push(_clone(u.before)); }
        else { if (!Array.isArray(wv.knowledges)) wv.knowledges = []; wv.knowledges.push(_clone(u.before)); }
        await _saveWorldview(wv);
      } else if (u.type === 'card_update') {
        const before = _clone(u.before); if (!before) return ERR('缺少单人卡快照');
        if (typeof SingleCard !== 'undefined' && SingleCard.save) await SingleCard.save(before); else await DB.put('singleCards', before);
      } else return ERR('未知回滚类型');
      await _saveConvs();
      return OK({ success:true, message:`已回滚：${u.label || u.type}` });
    },

    // --- 历史消息搜索（搜主线归档） ---
    async search_messages(args) {
      if (!args.keyword) return ERR('缺少 keyword');
      const kw = String(args.keyword).toLowerCase();
      const limit = Math.min(Math.max(parseInt(args.limit) || 3, 1), 5);
      // 主线 conversationId（不是后台的 backstageConvId）
      const convId = Conversations.getCurrent();
      if (!convId) return OK({ result: '当前没有对话。' });
      let archives = [];
      try {
        archives = await Summary.getArchives(convId);
      } catch(_) {}
      if (!archives || archives.length === 0) {
        return OK({ result: '当前对话还没有归档消息。所有历史对话应该都在你的上下文里能直接看到。' });
      }
      // 把所有归档消息拍平成一个数组，记下原 archive 的归档时间
      const flat = [];
      // 按归档时间倒序（最近归档的优先搜）
      const sorted = archives.slice().sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
      sorted.forEach(arch => {
        (arch.messages || []).forEach((m, idx) => {
          flat.push({
            role: m.role,
            content: m.content || '',
            timestamp: m.timestamp,
            archivedAt: arch.archivedAt,
            archIdx: flat.length // 全局位置，用于取上下文
          });
        });
      });
      // 命中
      const hits = [];
      for (let i = 0; i < flat.length; i++) {
        if (typeof flat[i].content !== 'string') continue;
        if (flat[i].content.toLowerCase().includes(kw)) {
          hits.push(i);
          if (hits.length >= limit) break;
        }
      }
      if (hits.length === 0) {
        return OK({ result: `归档消息里没找到包含「${args.keyword}」的内容。这部分对话可能还在你的上下文里。` });
      }
      const segments = hits.map(idx => {
        const before = idx > 0 ? flat[idx - 1] : null;
        const hit = flat[idx];
        const after = idx < flat.length - 1 ? flat[idx + 1] : null;
        const lines = [];
        const fmt = (m) => `[${m.role === 'user' ? '玩家' : 'AI'}] ${typeof m.content === 'string' ? m.content : '[非文本内容]'}`;
        if (before) lines.push(fmt(before));
        lines.push('▶ ' + fmt(hit));
        if (after) lines.push(fmt(after));
        return { archivedAt: hit.archivedAt, context: lines.join('\n') };
      });
      return OK({ items: segments });
    },

    // --- 使用说明查询 ---
    async query_guide(args) {
      let md;
      try {
        const resp = await fetch('guide.md?_=' + Date.now());
        if (!resp.ok) throw new Error(resp.status);
        md = await resp.text();
      } catch(_) {
        return ERR('无法加载 guide.md');
      }
      const keyword = args && args.keyword ? String(args.keyword).trim() : '';
      if (!keyword) {
        // 返回目录（文本列表，缩进表示层级）
        const toc = md.split('\n')
          .filter(l => /^#{1,5}\s/.test(l))
          .map(l => {
            const level = l.match(/^(#{1,5})\s/)[1].length;
            const indent = '  '.repeat(level - 1);
            return indent + '- ' + l.replace(/^#+\s*/, '').trim();
          })
          .join('\n');
        return OK({ type: 'toc', content: toc + '\n\n提示：传 keyword 可查看对应章节详情' });
      }
      // 按最深标题级别拆成叶子段落
      const kw = keyword.toLowerCase();
      const lines = md.split('\n');
      const sections = [];
      let cur = { heading: '', body: [] };
      for (const line of lines) {
        if (/^#{1,5}\s/.test(line)) {
          if (cur.heading || cur.body.length) sections.push(cur);
          cur = { heading: line, body: [] };
        } else {
          cur.body.push(line);
        }
      }
      if (cur.heading || cur.body.length) sections.push(cur);

      // 分两组：标题命中 vs 仅内容命中
      const titleHits = [];
      const bodyHits = [];
      for (const s of sections) {
        const title = s.heading.toLowerCase();
        const body = s.body.join('\n').toLowerCase();
        if (title.includes(kw)) {
          titleHits.push(s);
        } else if (body.includes(kw)) {
          bodyHits.push(s);
        }
      }
      // 章节名 + 关键词搜索：标题命中在前，正文命中补后，去重，上限 5
      let matched = [];
      const seen = new Set();
      for (const s of titleHits.concat(bodyHits)) {
        if (seen.has(s)) continue;
        seen.add(s);
        matched.push(s);
        if (matched.length >= 5) break;
      }
      if (matched.length === 0) {
        return OK({ result: '使用说明中没有找到包含「' + keyword + '」的内容。' });
      }
      const items = matched.map(s => {
        const content = (s.heading + '\n' + s.body.join('\n')).trim();
        return {
          section: s.heading.replace(/^#+\s*/, '').trim(),
          content
        };
      });
      return OK({ type: 'sections', count: items.length, items });
    }
  };

  // ===== 执行 =====
  async function execute(toolCall) {
    const name = toolCall.function?.name;
    const handler = handlers[name];
    if (!handler) return ERR(`未知工具: ${name}`);
    let args = {};
    try { args = JSON.parse(toolCall.function?.arguments || '{}'); } catch(e) { return ERR('参数解析失败'); }
    try { return await handler(args); } catch(e) { return ERR(`工具执行失败: ${e.message}`); }
  }

  // v685.1 → v685.3：只有后台工具做 {{user}} 替换
  // 主线工具不动——主线"用户"指向面具角色，不需要换昵称
  // 后台池子可能跨用户共享，必须用 OOC 昵称避免被各种面具名整迷糊
  function getDefinitions() { return definitions; }
  function getBackstageDefinitions() {
    return _withMacros(backstageDefinitions, _cachedBackstageUser);
  }

  // ===== 后台 user 名缓存（OOC 昵称） =====
  async function _resolveBackstageUserName() {
    let name = '';
    try {
      const _ooc = await DB.get('settings', 'oocNickname');
      if (_ooc?.value && String(_ooc.value).trim()) name = String(_ooc.value).trim();
    } catch(_) {}
    if (!name) {
      try {
        const _mc = (typeof Character !== 'undefined' && Character.get) ? await Character.get() : null;
        if (_mc?.name) name = _mc.name;
      } catch(_) {}
    }
    return name || '玩家';
  }

  let _cachedBackstageUser = '玩家';
  let _cachedAt = 0;
  async function _refreshBackstageCache() {
    if (Date.now() - _cachedAt < 30000) return _cachedBackstageUser;
    _cachedBackstageUser = await _resolveBackstageUserName();
    _cachedAt = Date.now();
    return _cachedBackstageUser;
  }
  _refreshBackstageCache().catch(()=>{});

  function _withMacros(defs, userName) {
    const u = userName;
    if (!u || u === '{{user}}') return defs;
    return defs.map(d => {
      if (!d || !d.function) return d;
      const fn = d.function;
      const newDesc = (typeof fn.description === 'string' && fn.description.includes('{{user}}'))
        ? fn.description.replaceAll('{{user}}', u)
        : fn.description;
      let newProps = fn.parameters && fn.parameters.properties;
      if (newProps) {
        const out = {};
        let touched = false;
        for (const [k, v] of Object.entries(newProps)) {
          if (v && typeof v.description === 'string' && v.description.includes('{{user}}')) {
            out[k] = { ...v, description: v.description.replaceAll('{{user}}', u) };
            touched = true;
          } else {
            out[k] = v;
          }
        }
        if (touched) {
          return { ...d, function: { ...fn, description: newDesc, parameters: { ...fn.parameters, properties: out } } };
        }
      }
      if (newDesc !== fn.description) {
        return { ...d, function: { ...fn, description: newDesc } };
      }
      return d;
    });
  }

  function refreshMacroCache() { _cachedAt = 0; return _refreshBackstageCache(); }

  return { getDefinitions, getBackstageDefinitions, execute, refreshMacroCache };
})();