/**
 * AI Tool Calling 系统
 * 定义工具列表 + handler 映射
 */
const Tools = (() => {

  // ===== 工具定义（OpenAI function calling 格式）=====
  const definitions = [
    {
      type: 'function',
      function: {
        name: 'query_notes',
        description: '查询用户的小纸条（情绪记忆碎片）。当你隐约记得用户说过什么偏好/习惯/情绪但不确定细节时，可以调用此工具查询。',
        parameters: {
          type: 'object',
          properties: {
            tag: {
              type: 'string',
              enum: ['喜欢','讨厌','期待','恐惧','愤怒','有趣','习惯','秘密','悲伤','迷茫','痛苦'],
              description: '按标签筛选，不传则不限标签'
            },
            keyword: {
              type: 'string',
              description: '按关键词模糊搜索 detail 内容，不传则不限'
            },
            limit: {
              type: 'number',
              description: '返回条数上限，默认5'
            }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'add_note',
        description: '记录一条关于用户的小纸条。当用户在对话中明确表达了喜好、厌恶、习惯、情绪等值得记住的信息时，调用此工具记下来。只记录用户自己说的/做的，不揣测。',
        parameters: {
          type: 'object',
          properties: {
            tag: {
              type: 'string',
              enum: ['喜欢','讨厌','期待','恐惧','愤怒','有趣','习惯','秘密','悲伤','迷茫','痛苦'],
              description: '情绪/偏好标签'
            },
            detail: {
              type: 'string',
              description: '以用户角色名为主语，如实记录说了什么或做了什么。例如：「沈楚吃了麻辣烫觉得很好吃」'
            },
            characters: {
              type: 'array',
              items: { type: 'string' },
              description: '当时在场的角色姓名'
            }
          },
          required: ['tag', 'detail']
        }
      }
    }
  ];

  // 后台专用工具定义
  const backstageDefinitions = [
    {
      type: 'function',
      function: {
        name: 'query_backstage_notes',
        description: '查询关于用户本人的真实记忆碎片（后台记忆库）。这里记录的是用户在后台聊天中表达过的真实喜好、情绪、习惯，不是游戏角色的。',
        parameters: {
          type: 'object',
          properties: {
            tag: {
              type: 'string',
              enum: ['喜欢','讨厌','期待','恐惧','愤怒','有趣','习惯','秘密','悲伤','迷茫','痛苦'],
              description: '按标签筛选'
            },
            keyword: {
              type: 'string',
              description: '按关键词模糊搜索'
            },
            limit: {
              type: 'number',
              description: '返回条数上限，默认5'
            }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'add_backstage_note',
        description: '记录一条关于用户本人的真实记忆。当用户在后台聊天中表达了真实的喜好、情绪、习惯、秘密等值得记住的信息时调用。只记录用户亲口说的/做的，不揣测，不修饰。',
        parameters: {
          type: 'object',
          properties: {
            tag: {
              type: 'string',
              enum: ['喜欢','讨厌','期待','恐惧','愤怒','有趣','习惯','秘密','悲伤','迷茫','痛苦'],
              description: '情绪/偏好标签'
            },
            detail: {
              type: 'string',
              description: '以用户名为主语，如实记录。例如：「用户讨厌秋葵」「用户最近在研究MCP服务器」'
            }
          },
          required: ['tag', 'detail']
        }
      }
    }
  ];

  // ===== 工具 handler =====
  const handlers = {
    async query_notes(args) {
      const allMemories = await DB.getAll('memories');
      const currentScope = Character.getCurrentId();
      let notes = allMemories.filter(m => m.type === 'note' && m.scope === currentScope);

      // 按标签筛选
      if (args.tag) {
        notes = notes.filter(n => n.tag === args.tag);
      }
      // 按关键词筛选
      if (args.keyword) {
        const kw = args.keyword.toLowerCase();
        notes = notes.filter(n => (n.detail || '').toLowerCase().includes(kw));
      }
      // 按时间倒序，取最近的
      notes.sort((a, b) => b.timestamp - a.timestamp);
      const limit = args.limit || 5;
      notes = notes.slice(0, limit);

      if (notes.length === 0) {
        return JSON.stringify({ result: '没有找到相关的小纸条。' });
      }
      const items = notes.map(n => ({
        tag: n.tag,
        detail: n.detail,
        characters: n.characters || [],
        time: n.time || ''
      }));
      return JSON.stringify({ result: items });
    },

    async add_note(args) {
      if (!args.tag || !args.detail) {
        return JSON.stringify({ error: '缺少 tag 或 detail' });
      }
      const note = await Memory.addNote({
        tag: args.tag,
        detail: args.detail,
        characters: args.characters || [],
        scope: Character.getCurrentId()
      });
      if (note) {
        return JSON.stringify({ success: true, id: note.id, message: '已记住。' });
      } else {
        return JSON.stringify({ success: false, message: '重复记录，已跳过。' });
      }
    },

    // 后台工具 handler
    async query_backstage_notes(args) {
      const notes = await Memory.queryBackstageNotes({
        tag: args.tag,
        keyword: args.keyword,
        limit: args.limit || 5
      });
      if (notes.length === 0) {
        return JSON.stringify({ result: '没有找到相关记忆。' });
      }
      const items = notes.map(n => ({ tag: n.tag, detail: n.detail, time: n.time || '' }));
      return JSON.stringify({ result: items });
    },

    async add_backstage_note(args) {
      if (!args.tag || !args.detail) {
        return JSON.stringify({ error: '缺少 tag 或 detail' });
      }
      const note = await Memory.addBackstageNote({
        tag: args.tag,
        detail: args.detail
      });
      if (note) {
        return JSON.stringify({ success: true, id: note.id, message: '已记住。' });
      } else {
        return JSON.stringify({ success: false, message: '重复记录，已跳过。' });
      }
    }
  };

  // ===== 执行工具调用 =====
  async function execute(toolCall) {
    const name = toolCall.function?.name;
    const handler = handlers[name];
    if (!handler) {
      return JSON.stringify({ error: `未知工具: ${name}` });
    }
    let args = {};
    try {
      args = JSON.parse(toolCall.function?.arguments || '{}');
    } catch(e) {
      return JSON.stringify({ error: '参数解析失败' });
    }
    try {
      return await handler(args);
    } catch(e) {
      return JSON.stringify({ error: `工具执行失败: ${e.message}` });
    }
  }

  // ===== 获取工具定义列表 =====
  function getDefinitions() {
    return definitions;
  }

  function getBackstageDefinitions() {
    return backstageDefinitions;
  }

  return { getDefinitions, getBackstageDefinitions, execute };
})();
