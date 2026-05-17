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

  // ===== 前台工具定义 =====
  const definitions = [
    // --- 小纸条 ---
    { type:'function', function:{
      name:'query_notes',
      description:'查询用户的小纸条（情绪记忆碎片）。当你隐约记得用户说过什么偏好/习惯/情绪但不确定细节时调用。',
      parameters:{ type:'object', properties:{
        tag:{ type:'string', enum:NOTE_TAGS, description:'按标签筛选' },
        keyword:{ type:'string', description:'模糊搜索 detail' },
        limit:{ type:'number', description:'返回条数上限，默认5' }
      }, required:[] }
    }},
    { type:'function', function:{
      name:'add_note',
      description:'记录一条小纸条。当用户明确表达了偏好/情绪/习惯时调用。只记用户说的/做的，不揣测。可同时调用多次。',
      parameters:{ type:'object', properties:{
        tag:{ type:'string', enum:NOTE_TAGS, description:'标签' },
        detail:{ type:'string', description:'以用户角色名为主语如实记录' },
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
      description:'查询事件记忆。可按关键词搜索标题/内容/参与者/地点。',
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
      description:'查询人际关系记忆。可按角色名搜索。',
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
    }}
  ];

  // ===== 后台工具定义 =====
  const backstageDefinitions = [
    { type:'function', function:{
      name:'query_backstage_notes',
      description:'查询用户本人的真实记忆碎片（后台记忆库）。不是游戏角色的，是用户本人的。',
      parameters:{ type:'object', properties:{
        tag:{ type:'string', enum:NOTE_TAGS, description:'按标签筛选' },
        keyword:{ type:'string', description:'模糊搜索' },
        limit:{ type:'number', description:'返回条数上限，默认5' }
      }, required:[] }
    }},
    { type:'function', function:{
      name:'add_backstage_note',
      description:'记录用户本人的真实记忆。只记用户亲口说的/做的，不揣测。可同时调用多次。',
      parameters:{ type:'object', properties:{
        tag:{ type:'string', enum:NOTE_TAGS, description:'标签' },
        detail:{ type:'string', description:'以用户名为主语如实记录' }
      }, required:['tag','detail'] }
    }},
    { type:'function', function:{
      name:'update_backstage_note',
      description:'修改一条后台记忆。仅在用户明确要求修改时使用。',
      parameters:{ type:'object', properties:{
        id:{ type:'string', description:'记忆 id' },
        tag:{ type:'string', enum:NOTE_TAGS },
        detail:{ type:'string' }
      }, required:['id'] }
    }},
    { type:'function', function:{
      name:'delete_backstage_note',
      description:'删除一条后台记忆。仅在用户明确要求删除时使用。',
      parameters:{ type:'object', properties:{
        id:{ type:'string', description:'记忆 id' }
      }, required:['id'] }
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
      const note = await Memory.addNote({ tag:args.tag, detail:args.detail, characters:args.characters||[], scope:_scope() });
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
    async query_backstage_notes(args) {
      const notes = await Memory.queryBackstageNotes({ tag:args.tag, keyword:args.keyword, limit:args.limit||5 });
      if (!notes.length) return OK({ result:'没有找到相关记忆。' });
      return OK({ result: notes.map(n => ({ id:n.id, tag:n.tag, detail:n.detail, time:n.time||'' })) });
    },
    async add_backstage_note(args) {
      if (!args.tag || !args.detail) return ERR('缺少 tag 或 detail');
      const note = await Memory.addBackstageNote({ tag:args.tag, detail:args.detail });
      return note ? OK({ success:true, id:note.id, message:'已记住。' }) : OK({ success:false, message:'重复记录，已跳过。' });
    },
    async update_backstage_note(args) {
      if (!args.id) return ERR('缺少 id');
      const m = await DB.get('memories', args.id);
      if (!m || m.type !== 'backstage_note') return ERR('未找到该记忆');
      if (args.tag && NOTE_TAGS.includes(args.tag)) m.tag = args.tag;
      if (args.detail) m.detail = args.detail;
      m.timestamp = Utils.timestamp();
      await DB.put('memories', m);
      return OK({ success:true, message:'已修改。' });
    },
    async delete_backstage_note(args) {
      if (!args.id) return ERR('缺少 id');
      await DB.del('memories', args.id);
      return OK({ success:true, message:'已删除。' });
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

  function getDefinitions() { return definitions; }
  function getBackstageDefinitions() { return backstageDefinitions; }

  return { getDefinitions, getBackstageDefinitions, execute };
})();