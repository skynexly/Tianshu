/**
 * 工具函数
 */
const Utils = (() => {
  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
  }

  function timestamp() {
    return Date.now();
  }

  function formatDate(ts) {
    if (ts === undefined || ts === null || ts === '') return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const w = weekdays[d.getDay()];
    return `${y}年${m}月${day}日 星期${w} ${h}:${min}`;
  }

  /**
   * 关键词分词（n-gram），用于记忆检索
   * 和Op的方案一致：拆2-gram到5-gram
   */
  function tokenize(text) {
    // 去标点，转小写
    const clean = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase();
    const tokens = new Set();
    // 中文按字拆n-gram
    for (let n = 2; n <= 5; n++) {
      for (let i = 0; i <= clean.length - n; i++) {
        tokens.add(clean.substring(i, i + n));
      }
    }
    // 英文按单词
    const words = text.toLowerCase().match(/[a-zA-Z]+/g);
    if (words) words.forEach(w => tokens.add(w));
    return [...tokens];
  }

  /**
   * 关键词匹配打分
   */
  function matchScore(queryTokens, targetKeywords) {
    if (!targetKeywords || targetKeywords.length === 0) return 0;
    let hits = 0;
    const targetSet = new Set(targetKeywords.map(k => k.toLowerCase()));
    for (const qt of queryTokens) {
      for (const tk of targetSet) {
        if (tk.includes(qt) || qt.includes(tk)) {
          hits++;
          break;
        }
      }
    }
    return hits / Math.max(queryTokens.length, 1);
  }

  /**
   * 粗略估算token数（中文≈1.5token/字，英文≈1token/word）
   */
  function estimateTokens(text) {
    if (!text) return 0;
    // 兼容非字符串入参（如多模态 content 为数组/对象时），统一转成字符串再估算
    if (typeof text !== 'string') {
      try { text = typeof text === 'object' ? JSON.stringify(text) : String(text); }
      catch(_) { text = String(text); }
    }
    const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const english = (text.match(/[a-zA-Z]+/g) || []).length;
    const other = (text.match(/[0-9]+/g) || []).length;
    return Math.ceil(chinese * 1.5 + english + other);
  }

  /**
   * 宽容 JSON 解析：先直接 parse，失败则逐级修复常见 AI 输出瑕疵后重试。
   * 修复项：去掉代码块首尾包裹文字、中文引号→英文、全角标点→半角、
   *         尾逗号、未闭合的括号补全。全部失败返回 null，并写一条诊断日志。
   * @param {string} str  待解析文本
   * @param {string} label 诊断用标签（块名，如 'chat'/'status'）
   * @returns {*} 解析结果，或 null
   */
  function _looseJSONParse(str, label) {
    if (str == null) return null;
    let s = String(str).trim();
    if (!s) return null;

    // 0) 原样直解
    try { return JSON.parse(s); } catch (_) {}

    // 1) 截取第一个 { 或 [ 到最后一个 } 或 ]（去掉 AI 在 JSON 前后加的解释文字）
    const firstBrace = s.indexOf('{');
    const firstBracket = s.indexOf('[');
    let start = -1;
    if (firstBrace === -1) start = firstBracket;
    else if (firstBracket === -1) start = firstBrace;
    else start = Math.min(firstBrace, firstBracket);
    if (start > 0) {
      const openCh = s[start];
      const closeCh = openCh === '{' ? '}' : ']';
      const end = s.lastIndexOf(closeCh);
      if (end > start) s = s.slice(start, end + 1);
    }

    // 2) 逐级修复后重试
    const fixers = [
      // 中文/弯引号 → 英文直引号
      x => x.replace(/[\u201C\u201D\u2018\u2019]/g, '"'),
      // 全角冒号/逗号 → 半角
      x => x.replace(/：/g, ':').replace(/，/g, ','),
      // 尾逗号：, } / , ]
      x => x.replace(/,\s*([}\]])/g, '$1'),
      // 补全未闭合：统计括号差额，在末尾补齐
      x => {
        const need = (open, close) => {
          const o = (x.match(new RegExp('\\' + open, 'g')) || []).length;
          const c = (x.match(new RegExp('\\' + close, 'g')) || []).length;
          return Math.max(0, o - c);
        };
        return x + '}'.repeat(need('{', '}')) + ']'.repeat(need('[', ']'));
      },
    ];

    // 累积应用修复器（每加一层修复就试一次，尽量早成功）
    let cur = s;
    for (const fix of fixers) {
      cur = fix(cur);
      try { return JSON.parse(cur); } catch (_) {}
    }

    // 3) 全部失败：写诊断日志（不抛错，交调用方决定默认值）
    try {
      if (typeof GameLog !== 'undefined') {
        const preview = String(str).trim().slice(0, 80).replace(/\n/g, ' ');
        GameLog.log('warn', `[解析] 「${label || '?'}」代码块 JSON 解析失败，已忽略。原文预览：${preview}${String(str).length > 80 ? '…' : ''}`);
      }
    } catch (_) {}
    return null;
  }

  /**
   * 解析AI输出格式
   * 结构：头部信息 → --- → 正文 → --- → 物品/变化（代码块）
   * 策略：从底部往上找代码块区域，中间全是正文
   */
  function parseAIOutput(raw) {
    const result = {
      header: { region: '', location: '', time: '', weather: '' },
      body: '',
      items: [],
    changes: [],
    presentNPCs: [],
    status: null,      // 新：status 面板数据（null 表示本次未输出）
    thinking: '',      // 新：<think>...</think> 思考过程
    relation: null,    // 心动模拟：好感度/黑化值增量
    tasks: null,       // 心动模拟：任务列表
    phoneLock: null,   // 心动模拟：char 锁/解锁手机指令 { status, by, reason }
    prisonAll: false,  // 心动模拟：多人囚禁结局 marker
    chat: null,        // 心动模拟：线上消息
    customAttrs: null, // 自定义世界观：属性增量 { global, characters }
    raw: raw
  };

    if (!raw) return result;

    // 先抽取 <think>...</think>（兼容 <thinking>），从 raw 里剥离
    const thinkMatch = raw.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
    if (thinkMatch) {
      result.thinking = thinkMatch[1].trim();
      raw = raw.replace(thinkMatch[0], '').trim();
    }

    // 展示型围栏（```html/svg/xml）先用占位符抽出保护——
    // 否则下面"从底部往上找系统区代码块"的切分逻辑会把正文里的组件误当成底部系统区切走
    // （bug：正文 + --- + 组件 结构时，组件从 body 丢失/被当纯文本显示成原样代码）。
    // 切分完成、body 定型后再原样放回正文原位，交给 Markdown 渲染。
    const _displayFences = [];
    raw = raw.replace(/```(?:html|svg|xml)\s*\n[\s\S]*?```/gi, (m) => {
      const idx = _displayFences.length;
      _displayFences.push(m);
      return `\x00HF${idx}\x00`;
    });

    // 先把 ```status 代码块提取出来，并从 raw 里剥离（避免显示在气泡里）
    const statusMatch = raw.match(/```status\s*\n?([\s\S]*?)```/i);
    if (statusMatch) {
      result.status = _parseStatusBlock(statusMatch[1]);
      raw = raw.replace(statusMatch[0], '').trim();
      // 清理紧邻的 --- 分隔符
      raw = raw.replace(/\n---\s*$/, '').trim();
      // 用 status 填充 header（供地区命中、总结模块等沿用旧字段的逻辑使用）
      result.header.region   = result.status.region   || '';
      result.header.location = result.status.location || '';
      result.header.time     = result.status.time     || '';
      result.header.weather  = result.status.weather  || '';
    }

    // 心动模拟专用代码块：```relation / ```task / ```chat
    const relationMatch = raw.match(/```relation\s*\n?([\s\S]*?)```/i);
    if (relationMatch) {
      result.relation = _looseJSONParse(relationMatch[1], 'relation');
      if (result.relation == null) {
        // 二级兜底：非 JSON 的 key:value 行格式
        try {
          const obj = {};
          relationMatch[1].trim().split('\n').forEach(line => {
            const m = line.match(/^(\S+?)\s*[:：]\s*(.+)/);
            if (m) { const v = _looseJSONParse(m[2].trim(), 'relation.val'); if (v != null) obj[m[1].trim()] = v; }
          });
          if (Object.keys(obj).length > 0) result.relation = obj;
        } catch(_) {}
      }
      raw = raw.replace(relationMatch[0], '').trim();
    }

    const taskMatch = raw.match(/```tasks?\s*\n?([\s\S]*?)```/i);
    if (taskMatch) {
      result.tasks = _looseJSONParse(taskMatch[1], 'tasks');
      if (result.tasks == null) {
        // 二级兜底：逐个提取能解析的对象（应对严重损坏、只能抢救部分的情况）
        try {
          const objects = [];
          const objRegex = /\{[^{}]*\}/g;
          let m;
          while ((m = objRegex.exec(taskMatch[1])) !== null) {
            const o = _looseJSONParse(m[0], 'tasks.item');
            if (o != null) objects.push(o);
          }
          if (objects.length > 0) result.tasks = objects;
        } catch(_) {}
      }
      raw = raw.replace(taskMatch[0], '').trim();
    }

    // 心动模拟：char 锁/解锁手机（含状态面板）
    const phoneLockMatch = raw.match(/```phone-lock\s*\n?([\s\S]*?)```/i);
    if (phoneLockMatch) {
      try {
        // 容错：JSON 优先，否则按 key: value 行格式解析
        let obj = _looseJSONParse(phoneLockMatch[1], 'phone-lock');
        if (obj == null) {
          obj = {};
          phoneLockMatch[1].trim().split('\n').forEach(line => {
            const m = line.match(/^([A-Za-z_]+)\s*[:：]\s*(.+?)\s*(?:#.*)?$/);
            if (m) obj[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
          });
        }
        if (obj && (obj.status === 'locked' || obj.status === 'unlocked')) {
          result.phoneLock = {
            status: obj.status,
            by: String(obj.by || '').trim(),
            reason: String(obj.reason || '').trim()
          };
        }
      } catch(_) {}
      raw = raw.replace(phoneLockMatch[0], '').trim();
    }

    const chatMatch = raw.match(/```chat\s*\n?([\s\S]*?)```/i);
 if (chatMatch) {
 result.chat = _looseJSONParse(chatMatch[1], 'chat');
 raw = raw.replace(chatMatch[0], '').trim();
 }
 
// 自定义世界观：属性增量（JSON）
    const customAttrsMatch = raw.match(/```custom-attrs\s*\n?([\s\S]*?)```/i);
    if (customAttrsMatch) {
      result.customAttrs = _looseJSONParse(customAttrsMatch[1], 'custom-attrs');
      raw = raw.replace(customAttrsMatch[0], '').trim();
    }
 
 // 心动模拟：返航触发 marker（空代码块即可）
  // 形如 ```homecoming\n``` 或 ```homecoming``` 或 ```homecoming\n任何内容\n```
  // v687.33：如果内容是 JSON 且含 companion 字段，表示共同返航结局
  const homecomingMatch = raw.match(/```homecoming\s*([\s\S]*?)```/i);
  if (homecomingMatch) {
    result.homecoming = true;
    // 尝试解析共同返航信息
    try {
      const hcContent = (homecomingMatch[1] || '').trim();
      if (hcContent) {
        const hcData = _looseJSONParse(hcContent, 'homecoming');
        if (hcData && hcData.companion) {
          // 支持 string 或 array
          result.homecomingCompanion = Array.isArray(hcData.companion)
            ? hcData.companion.join('、')
            : String(hcData.companion);
        }
      }
    } catch(_) {}
    raw = raw.replace(homecomingMatch[0], '').trim();
  }

  // 心动模拟：多人囚禁结局 marker
  // AI 演绎多人囚禁结局时输出 ```prison-all```，前端直接全员黑化拉满 + 锁手机 + 崩坏演出
  const prisonAllMatch = raw.match(/```prison-all\s*([\s\S]*?)```/i);
  if (prisonAllMatch) {
    result.prisonAll = true;
    raw = raw.replace(prisonAllMatch[0], '').trim();
  }

  // 来电标记：```call 块从正文中剥离（前端已在流式结束后单独检测并触发来电）
  const callBlockMatch = raw.match(/```call\s*\n?([\s\S]*?)```/i);
  if (callBlockMatch) {
    raw = raw.replace(callBlockMatch[0], '').trim();
  }

  // 群聊标记：```groupchat / ```groupcreate 块从正文剥离（前端单独检测并后台处理）
  const groupChatBlockMatch = raw.match(/```groupchat\s*\n?([\s\S]*?)```/i);
  if (groupChatBlockMatch) {
    raw = raw.replace(groupChatBlockMatch[0], '').trim();
  }
  const groupCreateBlockMatch = raw.match(/```groupcreate\s*\n?([\s\S]*?)```/i);
  if (groupCreateBlockMatch) {
    raw = raw.replace(groupCreateBlockMatch[0], '').trim();
  }

  // 好友申请标记：```friendrequest 块从正文剥离（前端单独检测，给被删联系人挂申请并强开手机）
  const friendReqBlockMatch = raw.match(/```friendrequest\s*\n?([\s\S]*?)```/i);
  if (friendReqBlockMatch) {
    raw = raw.replace(friendReqBlockMatch[0], '').trim();
  }

  // 邮件回信信号：```mail_reply 块从正文剥离（前端单独检测并后台生成回信）
  let mailReplyMatch;
  const mailReplyRe = /```mail_reply\s*\n?([\s\S]*?)```/gi;
  while ((mailReplyMatch = mailReplyRe.exec(raw)) !== null) {
    raw = raw.replace(mailReplyMatch[0], '').trim();
    mailReplyRe.lastIndex = 0;
  }

  // 邮件拒回信号：```mail_noreply 块从正文剥离（前端标记该信为"对方无回应"，不再进上下文）
  let mailNoReplyMatch;
  const mailNoReplyRe = /```mail_noreply\s*\n?([\s\S]*?)```/gi;
  while ((mailNoReplyMatch = mailNoReplyRe.exec(raw)) !== null) {
    raw = raw.replace(mailNoReplyMatch[0], '').trim();
    mailNoReplyRe.lastIndex = 0;
  }

  // 一起听：接受/拒绝邀请 marker
  // 形如 ```listen_together\n{"accept":true}``` 或 ```listen_together\n{"accept":false,"reason":"..."}```
  const listenAcceptMatch = raw.match(/```listen_together\s*([\s\S]*?)```/i);
  if (listenAcceptMatch) {
    try {
      const laContent = (listenAcceptMatch[1] || '').trim();
      if (laContent) {
        const la = _looseJSONParse(laContent, 'listen_together');
        if (la != null) result.listenAccept = la;
        else result.listenAccept = { accept: false, reason: '解析失败' };
      }
    } catch(_) { result.listenAccept = { accept: false, reason: '解析失败' }; }
    raw = raw.replace(listenAcceptMatch[0], '').trim();
  }

  // 一起听：留言 marker
  // 形如 ```listen_msg\n留言内容```
  const listenMsgMatch = raw.match(/```listen_msg\s*([\s\S]*?)```/i);
  if (listenMsgMatch) {
    result.listenMsg = (listenMsgMatch[1] || '').trim();
    raw = raw.replace(listenMsgMatch[0], '').trim();
  }

  // 游鱼购买标记：```youyu_buy\n{"id":"...","buyer":"...","delivery":"...","eta":N}```
  const youyuBuyMatch = raw.match(/```youyu_buy\s*([\s\S]*?)```/i);
  if (youyuBuyMatch) {
    try {
      const ybContent = (youyuBuyMatch[1] || '').trim();
      if (ybContent) {
        const yb = _looseJSONParse(ybContent, 'youyu_buy');
        if (yb != null) result.youyuBuy = yb;
      }
    } catch(_) {}
    raw = raw.replace(youyuBuyMatch[0], '').trim();
  }

    // 清理「第X部分 — XXX：」「第X部分 — XXX（...）：」这类格式标签行
    // 第二部分被尾部切割顺带去掉了，但 status 等代码块被提前替换后会留下「第三部分 — 状态面板：」孤儿，统一过滤
    raw = raw.replace(/^[ \t]*第[一二三四五六七八九十]+部分\s*[—\-－]\s*[^\n]*$/gm, '').trim();
    // 多余的连续空行收一下
    raw = raw.replace(/\n{3,}/g, '\n\n').trim();

    // 找最后一个 --- 后面是否有代码块（底部系统区）
    let bottomSection = '';
    let mainContent = raw;

    // 从后往前找代码块区域
    const lastCodeBlockEnd = raw.lastIndexOf('```');
    if (lastCodeBlockEnd > -1) {
      // 找这些代码块前面的 ---
      const beforeCodeBlocks = raw.substring(0, lastCodeBlockEnd);
      const lastSep = beforeCodeBlocks.lastIndexOf('\n---\n');
      if (lastSep > -1) {
        bottomSection = raw.substring(lastSep + 5);
        mainContent = raw.substring(0, lastSep);
      } else {
        // v687.37：AI偶发漏写分隔符的兜底——
        // 向上扫所有代码块，找到第一个"已知底部代码块"（新获得物品/当前相关角色/角色变化）
        // 把它及之后所有内容当作底部区域
        const allBlocks = [...raw.matchAll(/```[\s\S]*?```/g)];
        for (const m of allBlocks) {
          const firstLine = m[0].replace(/```\n?/, '').split('\n')[0].trim();
          if (/^(当前)?相关(?:NPC|角色)|^(当前)?在场(?:NPC|角色)|^新?获得?物品|^角色变化|^变化/i.test(firstLine)) {
            bottomSection = raw.substring(m.index);
            mainContent = raw.substring(0, m.index).trim();
            break;
          }
        }
      }
    }

    // 切分完后，再清掉专用代码块（status/relation/tasks/phone-lock/chat）抽走后在 mainContent 里残留的孤儿分割线。
    // 必须放在 bottomSection 切分之后——否则会误伤"正文与底部系统区之间的真分隔符"，导致 items/changes/NPC 全部丢失。
    // 已知bug回归：dad83a1 把这两行放在切分前用 gm 模式，把 \n---\n 当孤儿吞掉，气泡卡片渲染失效。
    mainContent = mainContent.replace(/\n---\s*$/gm, '').replace(/^---\s*\n/gm, '').trim();

    // 从 mainContent 里分出头部和正文
    // 新格式（有 status 代码块）下没有独立头部，mainContent 首个 --- 前就是正文开头，
    // 所以 status 存在时不走 header 解析，全部当作正文处理
    const firstSep = mainContent.indexOf('\n---\n');
    let headerText = '';
    let bodyText = mainContent;

    if (!result.status && firstSep > -1) {
      headerText = mainContent.substring(0, firstSep).trim();
      bodyText = mainContent.substring(firstSep + 5).trim();
    }

    // 解析头部（仅旧格式走这里；新格式 header 已经由 status 填充）
    if (headerText) {
      const headerLines = headerText.split('\n');
      for (const line of headerLines) {
        const l = line.replace(/^[-•·]\s*/, '').trim();
        if (!l) continue;
        if (l.match(/\d{4}年/) || l.match(/\d+月\d+日/)) {
          result.header.time = l;
        } else if (l.includes('℃') || l.includes('晴') || l.includes('雨') || l.includes('阴') || l.includes('雪') || l.includes('多云')) {
          result.header.weather = l;
        } else if (!result.header.region) {
          result.header.region = l;
        } else if (!result.header.location) {
          result.header.location = l;
        }
      }
    }

    // 正文
    result.body = bodyText;

    // 恢复被保护的展示型围栏（```html/svg/xml）——放回正文原位，交给 Markdown 渲染。
    if (_displayFences.length) {
      result.body = result.body.replace(/\x00HF(\d+)\x00/g, (_, idx) => _displayFences[parseInt(idx)] || '');
    }

    // 解析底部代码块
    if (bottomSection) {
      const codeBlocks = bottomSection.match(/```[\s\S]*?```/g) || [];
      codeBlocks.forEach((block, blockIndex) => {
        const raw = block.replace(/```\n?/g, '').trim();
        if (!raw || raw === '无') return;
        
        const lines = raw.split('\n');
        const firstLine = lines[0].trim();
        
        // 用第一行判断代码块类型
        const isNPC = /^(当前)?相关(?:NPC|角色)|^(当前)?在场(?:NPC|角色)|^(?:NPC|角色)/i.test(firstLine);
        const isItem = /^新?获得?物品|^物品/i.test(firstLine);
        const isChange = /^角色变化|^变化/i.test(firstLine);
        
        // 取内容行：跳过第一行（标题），过滤括号说明行
        const contentLines = lines.slice(1).filter(l => {
          const t = l.trim();
          return t && t !== '无' && !/^（.*）$/.test(t) && !/^\(.*\)$/.test(t);
        });
        
        if (isNPC) {
          result.presentNPCs = contentLines
            .map(l => l.replace(/^[-•·\d.]\s*/, '').trim())
            .filter(l => l && l !== '无');
        } else if (isItem) {
          contentLines
            .filter(l => !/^(名称|效果|物品名称|新获得物品)$/i.test(l.trim()))
            .forEach(l => {
              const t = l.trim();
              if (t) result.items.push(t);
            });
        } else if (isChange) {
          const changeText = contentLines.join('\n').trim();
          if (changeText && changeText !== '无') result.changes.push(changeText);
        } else {
          // 无法识别标题时的兜底：最后一个块且全是短行→NPC
          const looksLikeNPCs = lines.every(l => l.trim().length < 30 && !l.includes('：') && !l.includes(':'));
          if (looksLikeNPCs && blockIndex === codeBlocks.length - 1) {
            result.presentNPCs = lines
              .map(l => l.replace(/^[-•·\d.]\s*/, '').trim())
              .filter(l => l && l !== '无' && !/^（.*）$/.test(l) && !/^\(.*\)$/.test(l));
          } else {
            // 可能是额外的角色变化代码块
            const text = contentLines.length > 0 ? contentLines.join('\n').trim() : lines.join('\n').trim();
            // 防御：如果内容看起来像漏了标签的 status 块（地点/时间/场景/天气 开头），不当 changes
            const looksLikeStatus = /^(地点|时间|场景|天气|用户角色)\s*[:：]/m.test(text);
            if (text && text !== '无' && !looksLikeStatus) result.changes.push(text);
          }
        }
      });
      // 代码块后面如果还有文字，追加到正文
      const afterLastBlock = bottomSection.substring(bottomSection.lastIndexOf('```') + 3).trim();
      if (afterLastBlock) {
        result.body += '\n\n' + afterLastBlock;
      }
    }

    return result;
  }

  /**
   * 解析 status 代码块内容
   * 返回格式：
   * { region, location, time, weather, scene, playerOutfit, playerPosture, npcs: [{name, outfit, posture}] }
   */
  function _parseStatusBlock(text) {
    const result = {
      region: '', location: '',
      time: '', weather: '',
      scene: '',
      playerOutfit: '', playerPosture: '',
      npcs: [],  // [{name, outfit, posture}]
      // v719：自定义状态栏组件收集（通用，不依赖世界观定义；渲染层再按组件定义匹配）
      customComponents: {
        fields: {},      // { 标题: 值 }  文本/数值组件
        charRoles: {},   // { 角色名: { 标题: 值 } }  相关角色组件
        userRoles: {}    // { 面具名: { 标题: 值 } }  用户状态组件
      }
    };
    if (!text) return result;
    const npcMap = {};  // name -> {outfit, posture}
    const lines = text.split('\n');
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      // 跳过说明行
      if (/^（.*）$/.test(l) || /^\(.*\)$/.test(l)) continue;
      // 匹配 key：value 或 key:value
      const m = l.match(/^([^:：]+)[：:]\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      const val = m[2].trim();
      if (!val) continue;
      // 角色格式：角色-<名字>-衣着 / 角色-<名字>-姿势；兼容旧格式 NPC-<名字>-衣着 / NPC-<名字>-姿势
const npcM = key.match(/^(?:NPC|角色)[\-·\s]+(.+?)[\-·\s]+(衣着|姿势|outfit|posture)$/i);
      if (npcM) {
        const name = npcM[1].trim();
        const field = /衣着|outfit/i.test(npcM[2]) ? 'outfit' : 'posture';
        if (!npcMap[name]) npcMap[name] = { name, outfit: '', posture: '' };
        npcMap[name][field] = val;
        continue;
      }
      // v719：用户状态组件 用户角色-<面具名>-自定义标题（须先于下方内置"用户角色衣着/姿势"之外的兜底；
      // 但内置衣着/姿势用宽松 .*衣着 匹配，这里排在其后不会误吞——先判内置，再判自定义）
      // 先处理内置字段，命中就 continue，避免落到自定义收集
      if (/^地点|location|region/i.test(key)) {
        // 地点可能是"大地点｜小地点"或"大地点·小地点"或单纯一段
        const parts = val.split(/[｜|]/);
        if (parts.length >= 2) {
          result.region = parts[0].trim();
          result.location = parts.slice(1).join('｜').trim();
        } else {
          // 用第一个·之前作为大地点，后面作为小地点
          const dotIdx = val.indexOf('·');
          if (dotIdx > -1 && dotIdx < val.length - 1) {
            result.region = val.substring(0, dotIdx).trim();
            result.location = val.substring(dotIdx + 1).trim();
          } else {
            result.region = val;
          }
        }
        continue;
      } else if (/^时间|time/i.test(key)) {
        result.time = val; continue;
      } else if (/^天气|weather/i.test(key)) {
        result.weather = val; continue;
      } else if (/^场景|scene/i.test(key)) {
        result.scene = val; continue;
      } else if (/^(玩家衣着|用户角色[\-·\s].*衣着|user.?outfit|player.?outfit)/i.test(key)) {
        result.playerOutfit = val; continue;
      } else if (/^(玩家姿势|用户角色[\-·\s].*姿势|user.?posture|player.?posture)/i.test(key)) {
        result.playerPosture = val; continue;
      }
      // === v719：自定义状态栏组件收集（内置字段都没命中才走到这里）===
      // 用户状态组件：用户角色-<面具名>-标题
      const userRoleM = key.match(/^用户角色[\-·\s]+(.+?)[\-·\s]+(.+)$/);
      if (userRoleM) {
        const maskName = userRoleM[1].trim();
        const compTitle = userRoleM[2].trim();
        if (maskName && compTitle) {
          if (!result.customComponents.userRoles[maskName]) result.customComponents.userRoles[maskName] = {};
          result.customComponents.userRoles[maskName][compTitle] = val;
          continue;
        }
      }
      // 相关角色组件：角色-<角色名>-标题（NPC- 兼容）
      const charRoleM = key.match(/^(?:NPC|角色)[\-·\s]+(.+?)[\-·\s]+(.+)$/i);
      if (charRoleM) {
        const roleName = charRoleM[1].trim();
        const compTitle = charRoleM[2].trim();
        if (roleName && compTitle) {
          if (!result.customComponents.charRoles[roleName]) result.customComponents.charRoles[roleName] = {};
          result.customComponents.charRoles[roleName][compTitle] = val;
          continue;
        }
      }
      // 文本/数值组件：标题：值（普通单层 key）
      result.customComponents.fields[key] = val;
    }
    result.npcs = Object.values(npcMap).filter(n => n.outfit || n.posture);
    return result;
  }

  /**
   * 合并新旧 status（新字段缺失时用旧值兜底）
   * @param {object} oldStatus 旧状态
   * @param {object} newStatus 新状态
   * @param {boolean} statusBlockPresent 本轮 AI 是否真的输出了 status 代码块；
   *   true 时 npcs 直接用新值（即使为空数组），表示当前没有 NPC 在场；
   *   false/未传时 npcs 沿用旧值（兼容只有 header 没 status 块的情况）。
   */
  function mergeStatus(oldStatus, newStatus, statusBlockPresent) {
    if (!newStatus) return oldStatus || null;
    if (!oldStatus) return newStatus;
    const merged = {
      region: newStatus.region || oldStatus.region || '',
      location: newStatus.location || oldStatus.location || '',
      time: newStatus.time || oldStatus.time || '',
      weather: newStatus.weather || oldStatus.weather || '',
      scene: newStatus.scene || oldStatus.scene || '',
      playerOutfit: newStatus.playerOutfit || oldStatus.playerOutfit || '',
      playerPosture: newStatus.playerPosture || oldStatus.playerPosture || '',
      npcs: statusBlockPresent
        ? (Array.isArray(newStatus.npcs) ? newStatus.npcs : [])
        : (newStatus.npcs && newStatus.npcs.length ? newStatus.npcs : (oldStatus.npcs || []))
    };
    // v719：自定义状态栏组件合并——本轮 AI 输出了 status 块就以新值为准（含空），否则沿用旧值。
    // 逐字段浅合并：新块里没出现的组件字段，保留旧值（避免 AI 漏输出某个组件就丢数据）。
    if (statusBlockPresent) {
      const oldCC = oldStatus.customComponents || {};
      const newCC = newStatus.customComponents || {};
      const _mergeLayer = (oldLayer, newLayer, twoLevel) => {
        oldLayer = oldLayer || {}; newLayer = newLayer || {};
        if (!twoLevel) {
          return Object.assign({}, oldLayer, newLayer);
        }
        const out = {};
        const names = new Set([...Object.keys(oldLayer), ...Object.keys(newLayer)]);
        names.forEach(nm => { out[nm] = Object.assign({}, oldLayer[nm] || {}, newLayer[nm] || {}); });
        return out;
      };
      merged.customComponents = {
        fields: _mergeLayer(oldCC.fields, newCC.fields, false),
        charRoles: _mergeLayer(oldCC.charRoles, newCC.charRoles, true),
        userRoles: _mergeLayer(oldCC.userRoles, newCC.userRoles, true)
      };
    } else {
      merged.customComponents = oldStatus.customComponents || newStatus.customComponents || undefined;
    }
    return merged;
  }

  /**
   * 将 status 对象序列化为 status 代码块文本（用于注入 system prompt）
   */
  function serializeStatus(status) {
    if (!status) return '';
    const lines = [];
    const loc = [status.region, status.location].filter(Boolean).join('｜');
    if (loc) lines.push('地点：' + loc);
    if (status.time) lines.push('时间：' + status.time);
    if (status.season) lines.push('季节：' + status.season);
    if (status.weather) lines.push('天气：' + status.weather);
    if (status.scene) lines.push('场景：' + status.scene);
if (status.playerOutfit) lines.push('用户角色-{{user}}-衣着：' + status.playerOutfit);
 if (status.playerPosture) lines.push('用户角色-{{user}}-姿势：' + status.playerPosture);
 (status.npcs || []).forEach(n => {
 if (!n.name) return;
 if (n.outfit) lines.push(`角色-${n.name}-衣着：${n.outfit}`);
 if (n.posture) lines.push(`角色-${n.name}-姿势：${n.posture}`);
     });
     // v719：自定义状态栏组件序列化（保证注入上下文时 AI 能看到上一轮的自定义组件值，照抄不掉字段）
     const cc = status.customComponents;
     if (cc && typeof cc === 'object') {
       // 文本/数值组件：标题：值
       if (cc.fields && typeof cc.fields === 'object') {
         Object.keys(cc.fields).forEach(title => {
           const v = cc.fields[title];
           if (v !== undefined && v !== null && String(v) !== '') lines.push(`${title}：${v}`);
         });
       }
       // 相关角色组件：角色-<角色名>-标题：值
       if (cc.charRoles && typeof cc.charRoles === 'object') {
         Object.keys(cc.charRoles).forEach(roleName => {
           const obj = cc.charRoles[roleName] || {};
           Object.keys(obj).forEach(title => {
             const v = obj[title];
             if (v !== undefined && v !== null && String(v) !== '') lines.push(`角色-${roleName}-${title}：${v}`);
           });
         });
       }
       // 用户状态组件：用户角色-<面具名>-标题：值
       if (cc.userRoles && typeof cc.userRoles === 'object') {
         Object.keys(cc.userRoles).forEach(maskName => {
           const obj = cc.userRoles[maskName] || {};
           Object.keys(obj).forEach(title => {
             const v = obj[title];
             if (v !== undefined && v !== null && String(v) !== '') lines.push(`用户角色-${maskName}-${title}：${v}`);
           });
         });
       }
     }
     return lines.join('\n');
   }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }
  function refreshAutoResizeTextareas(root = document) {
    if (!root) return;
    root.querySelectorAll('.auto-resize-textarea').forEach(el => {
      el.style.height = 'auto';
      const maxHeight = parseInt(window.getComputedStyle(el).maxHeight, 10) || 220;
      el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
      el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    });
  }

  // ---------- 全屏输入弹窗 ----------
  let _fullscreenTargetId = null;


  function openFullscreen(targetId, title) {
    _fullscreenTargetId = targetId;
    const src = document.getElementById(targetId);
    const modal = document.getElementById('fullscreen-input-modal');
    const ta = document.getElementById('fullscreen-edit-textarea');
    const titleEl = document.getElementById('fullscreen-input-title');
    if (!src || !modal || !ta) return;
    titleEl.textContent = title || '';
    ta.value = src.value;
    modal.classList.remove('hidden');
    setTimeout(() => ta.focus(), 100);
  }

  function closeFullscreen() {
    const modal = document.getElementById('fullscreen-input-modal');
    const ta = document.getElementById('fullscreen-edit-textarea');
    if (_fullscreenTargetId) {
      const src = document.getElementById(_fullscreenTargetId);
      if (src) {
        src.value = ta.value;
        refreshAutoResizeTextareas(src.parentElement || document);
      }
    }
    modal.classList.add('hidden');
    _fullscreenTargetId = null;
  }

async function copyFromDataset(btn) {
    const text = btn?.dataset?.copy ?? '';
    if (!text) return;
    let ok = false;
    // 优先 clipboard API
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch(_) {}
    // fallback: execCommand
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch(_) {}
    }
    if (ok) {
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast('已复制', 1500);
    } else {
      UI.showToast('复制失败，请手动复制', 2000);
    }
  }

  // ===== 文档读取（支持 txt/md/json 等纯文本 + docx + pdf） =====
  async function readFileAsText(file) {
    const name = (file.name || '').toLowerCase();
    const MB5 = 5 * 1024 * 1024;
    if (file.size > MB5) throw new Error('文件超过 5MB 限制');

    // docx
    if (name.endsWith('.docx')) {
      if (typeof mammoth === 'undefined') throw new Error('docx 解析库未加载');
      const buf = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: buf });
      const text = (result.value || '').trim();
      if (!text) throw new Error('docx 中未提取到文本内容');
      return text;
    }

    // pdf
    if (name.endsWith('.pdf')) {
      if (typeof pdfjsLib === 'undefined') throw new Error('PDF 解析库未加载');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/lib/pdf.worker.min.js';
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        const pageText = tc.items.map(item => item.str).join('');
        if (pageText.trim()) pages.push(pageText);
      }
      const text = pages.join('\n\n').trim();
      if (!text) throw new Error('PDF 中未提取到文本（可能是扫描件/图片 PDF）');
      return text;
    }

    // 纯文本家族
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(String(e.target.result || ''));
      reader.onerror = () => reject(new Error('文件读取失败，可能不是文本编码'));
      reader.readAsText(file);
    });
  }

  // 轻量通用文本读取：把 File 读成字符串。
  // 优先 file.text()，但它在老 iOS Safari(<14.5)/鸿蒙可拓/部分老内核上不存在或抛错——
  // 那种情况下页面表现是"选了文件没反应"。这里统一降级到 FileReader（兼容性最好），
  // 供所有 JSON/文本导入直接用（无 docx/pdf 逻辑、无 5MB 限制，适合大存档）。
  function fileToText(file) {
    return new Promise((resolve, reject) => {
      if (!file) { reject(new Error('没有文件')); return; }
      const viaReader = () => {
        try {
          const reader = new FileReader();
          reader.onload = (e) => resolve(String(e.target.result || ''));
          reader.onerror = () => reject(new Error('文件读取失败'));
          reader.readAsText(file);
        } catch (e) { reject(e); }
      };
      if (typeof file.text === 'function') {
        // file.text() 可能返回 rejected promise 或直接抛错，两种都降级到 FileReader
        try {
          file.text().then(
            (t) => resolve(String(t || '')),
            () => viaReader()
          );
        } catch (_) { viaReader(); }
      } else {
        viaReader();
      }
    });
  }

  /**
   * 压缩图片 dataUrl（独立可复用）。动图（gif/webp/apng）直通不压，避免被压成静态首帧。
   * @param {string} dataUrl - 源图 dataUrl
   * @param {Object} opts - { maxSize=800, quality=0.8, outputFormat='jpeg' }
   * @returns {Promise<string>} 压缩后的 dataUrl（失败则返回原图）
   */
  function compressDataUrl(dataUrl, opts = {}) {
    const maxSize = opts.maxSize || 800;
    const quality = opts.quality || 0.8;
    const format = opts.outputFormat || 'jpeg';
    const mimeType = `image/${format}`;
    if (/^data:image\/(gif|webp|apng)/i.test(dataUrl || '')) return Promise.resolve(dataUrl);
    return new Promise(res => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxSize || h > maxSize) {
          if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
          else { w = Math.round(w * maxSize / h); h = maxSize; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        res(canvas.toDataURL(mimeType, quality));
      };
      img.onerror = () => res(dataUrl); // 压缩失败就用原图
      img.src = dataUrl;
    });
  }

  /**
   * 通用图片输入：弹出选择弹窗（本地文件 / 粘贴URL）
   * @param {Object} opts - 选项
   * @param {number} opts.maxSize - 压缩后最大尺寸(px)，默认800
   * @param {number} opts.quality - JPEG压缩质量，默认0.8
   * @param {string} opts.outputFormat - 'jpeg'|'png'|'webp'，默认'jpeg'
   * @returns {Promise<string|null>} dataUrl 或 null（取消）
   */
  function promptImageInput(opts = {}) {
    const maxSize = opts.maxSize || 800;
    const quality = opts.quality || 0.8;
    const format = opts.outputFormat || 'jpeg';
    const mimeType = `image/${format}`;

    return new Promise(resolve => {
      // 构建弹窗
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
      overlay.innerHTML = `
        <div style="background:var(--bg-secondary,#1a1a1a);border:1px solid var(--border,#333);border-radius:12px;padding:20px;max-width:360px;width:100%;display:flex;flex-direction:column;gap:14px">
          <div style="font-size:15px;font-weight:600;color:var(--text,#eee)">选择图片来源</div>
          <button id="_img-pick-file" style="padding:10px;border-radius:8px;border:1px solid var(--border,#333);background:var(--bg-tertiary,#222);color:var(--text,#eee);font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;justify-content:center">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            从本地选择
          </button>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;height:1px;background:var(--border,#333)"></div>
            <span style="font-size:11px;color:var(--text-secondary,#888)">或</span>
            <div style="flex:1;height:1px;background:var(--border,#333)"></div>
          </div>
          <input id="_img-pick-url" type="text" placeholder="粘贴图片URL…" style="padding:10px;border-radius:8px;border:1px solid var(--border,#333);background:var(--bg-tertiary,#222);color:var(--text,#eee);font-size:13px;outline:none">
          <div id="_img-pick-url-err" style="display:none;font-size:11px;color:var(--danger,#e55)"></div>
          <div style="display:flex;gap:8px">
            <button id="_img-pick-cancel" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:var(--text-secondary,#888);font-size:13px;cursor:pointer">取消</button>
            <button id="_img-pick-confirm" style="flex:1;padding:8px;border-radius:8px;border:none;background:var(--accent,#f60);color:#111;font-size:13px;font-weight:600;cursor:pointer">确认URL</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';

      function cleanup() { overlay.remove(); }

      // 压缩图片 dataUrl（动图直通不压）—— 复用公共 compressDataUrl
      function compress(dataUrl) {
        return compressDataUrl(dataUrl, { maxSize, quality, outputFormat: format });
      }

      // 本地文件
      overlay.querySelector('#_img-pick-file').onclick = () => fileInput.click();
      fileInput.onchange = () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
          const result = await compress(e.target.result);
          cleanup();
          resolve(result);
        };
        reader.readAsDataURL(file);
      };

      // URL 确认
      overlay.querySelector('#_img-pick-confirm').onclick = async () => {
        const urlInput = overlay.querySelector('#_img-pick-url');
        const errEl = overlay.querySelector('#_img-pick-url-err');
        const url = urlInput.value.trim();
        if (!url) { errEl.style.display = 'block'; errEl.textContent = '请输入URL'; return; }
        errEl.style.display = 'block'; errEl.textContent = '加载中…'; errEl.style.color = 'var(--text-secondary,#888)';
        try {
          const resp = await fetch(url, { mode: 'cors' });
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const blob = await resp.blob();
          if (!blob.type.startsWith('image/')) throw new Error('不是图片');
          const dataUrl = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = rej;
            r.readAsDataURL(blob);
          });
          const result = await compress(dataUrl);
          cleanup();
          resolve(result);
        } catch(e) {
          // CORS 失败时尝试直接用 URL（不转 base64）
          errEl.style.color = 'var(--text-secondary,#888)';
          errEl.textContent = '无法下载图片，尝试直接使用URL…';
          // 验证是否能作为 img src 加载。注意：图床防盗链/CORS 会让验证 onerror，
          // 但同一 URL 当 <img> 真正显示时往往正常（别的端能用即此理）。所以验证失败
          // 不再一票否决，而是让用户「仍要使用此链接」强行确认，避免误杀有效图床链接。
          let _imgSettled = false;
          const _acceptUrl = () => { if (_imgSettled) return; _imgSettled = true; cleanup(); resolve(url); };
          const _offerForceUse = (msg) => {
            if (_imgSettled) return;
            errEl.style.color = 'var(--danger,#e55)';
            errEl.textContent = msg;
            const confirmBtn = overlay.querySelector('#_img-pick-confirm');
            if (confirmBtn) {
              confirmBtn.textContent = '仍要使用此链接';
              confirmBtn.onclick = _acceptUrl;
            }
          };
          const testImg = new Image();
          testImg.onload = () => { if (_imgSettled) return; _imgSettled = true; cleanup(); resolve(url); };
          testImg.onerror = () => _offerForceUse('图片验证失败（可能是图床防盗链）。若确认链接无误，可直接使用。');
          // 超时兜底：部分图床既不触发 onload 也不触发 onerror，避免一直卡「加载中…」
          setTimeout(() => _offerForceUse('图片验证超时（可能是图床防盗链）。若确认链接无误，可直接使用。'), 6000);
          testImg.src = url;
        }
      };

      // URL 输入框回车
      overlay.querySelector('#_img-pick-url').onkeydown = (e) => {
        if (e.key === 'Enter') overlay.querySelector('#_img-pick-confirm').click();
      };

      // 取消
      overlay.querySelector('#_img-pick-cancel').onclick = () => { cleanup(); resolve(null); };
      overlay.onclick = (e) => { if (e.target === overlay) { cleanup(); resolve(null); } };
    });
  }

  /**
   * AI 生成头像弹窗：预填 prompt（可编辑）→ 生成 → 预览 → 确认返回 dataURL
   * @param {string} defaultPrompt 预填的 prompt（直接中文即可）
   * @param {object} opts { maxSize, quality } 确认后压缩参数
   * @returns {Promise<string|null>} dataUrl 或 null（取消）
   */
  function promptAiAvatar(defaultPrompt = '', opts = {}) {
    const maxSize = opts.maxSize || 256;
    const quality = opts.quality || 0.85;
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
      overlay.innerHTML = `
        <div style="background:var(--bg-secondary,#1a1a1a);border:1px solid var(--border,#333);border-radius:12px;padding:20px;max-width:380px;width:100%;display:flex;flex-direction:column;gap:12px;max-height:88vh;overflow-y:auto;-webkit-overflow-scrolling:touch">
          <div style="font-size:15px;font-weight:600;color:var(--text,#eee);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/></svg>AI 生成头像</div>
          <div style="font-size:11px;color:var(--text-secondary,#888);line-height:1.5">下方是根据角色设定预填的画面描述，可自由编辑（比如只留外貌、加画风）。生图会消耗额度，满意再点「用这张」。</div>
          <textarea id="_aiav-prompt" style="padding:10px;border-radius:8px;border:1px solid var(--border,#333);background:var(--bg-tertiary,#222);color:var(--text,#eee);font-size:13px;outline:none;resize:vertical;min-height:176px;line-height:1.6"></textarea>
          <div id="_aiav-preview" style="display:none;align-items:center;justify-content:center;padding:8px">
            <img id="_aiav-img" src="" style="width:160px;height:160px;border-radius:12px;object-fit:cover;border:1px solid var(--border,#333)">
          </div>
          <div id="_aiav-status" style="display:none;font-size:12px;color:var(--text-secondary,#888);text-align:center;padding:6px"></div>
          <div style="display:flex;gap:8px">
            <button id="_aiav-cancel" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:var(--text-secondary,#888);font-size:13px;cursor:pointer">取消</button>
            <button id="_aiav-gen" style="flex:1;padding:9px;border-radius:8px;border:none;background:var(--accent,#f60);color:#111;font-size:13px;font-weight:600;cursor:pointer">生成</button>
            <button id="_aiav-download" style="display:none;flex:1;padding:9px;border-radius:8px;border:1px solid var(--accent,#f60);background:transparent;color:var(--accent,#f60);font-size:13px;font-weight:600;cursor:pointer">下载原图</button>
            <button id="_aiav-use" style="display:none;flex:1;padding:9px;border-radius:8px;border:none;background:var(--accent,#f60);color:#111;font-size:13px;font-weight:600;cursor:pointer">用这张</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const promptEl = overlay.querySelector('#_aiav-prompt');
      const genBtn = overlay.querySelector('#_aiav-gen');
      const useBtn = overlay.querySelector('#_aiav-use');
      const downloadBtn = overlay.querySelector('#_aiav-download');
      const statusEl = overlay.querySelector('#_aiav-status');
      const previewWrap = overlay.querySelector('#_aiav-preview');
      const imgEl = overlay.querySelector('#_aiav-img');
      promptEl.value = defaultPrompt;

      let curDataUrl = null;
      let downloaded = false; // 下载过就不拦截关闭
      let generating = false; // 正在生成中（请求进行时为 true）

      function cleanup() { overlay.remove(); }

      // 关闭前检查：已生成头像但既没「用这张」也没下载 → 弹确认，避免手滑关掉白费额度
      async function _tryClose() {
        // 生成中关闭：请求不会中断，额度仍会消耗——提示知情，防误触
        if (generating) {
          const ok = await UI.showConfirm('图片正在生成', '关闭不会停止已经发出的生图请求，额度仍会消耗（生成的图也会被丢弃）。确定关闭？');
          if (!ok) return;
          cleanup();
          resolve(null);
          return;
        }
        if (curDataUrl && !downloaded) {
          const ok = await UI.showConfirm('确定关闭？', '已生成的头像还没使用，也没下载。关闭后这张图就找不回来了（生图消耗的额度会白费）。确定关闭？');
          if (!ok) return; // 用户改主意，留在弹窗
        }
        cleanup();
        resolve(null);
      }

      genBtn.onclick = async () => {
        const p = promptEl.value.trim();
        if (!p) { statusEl.style.display = 'block'; statusEl.style.color = 'var(--danger,#e55)'; statusEl.textContent = '请先填写画面描述'; return; }
        // 重新生成前：若已有一张还没「用这张」也没下载的图，先确认——避免手滑覆盖掉满意的图
        if (curDataUrl && !downloaded) {
          const ok = await UI.showConfirm('重新生成？', '当前这张头像还没使用，也没下载。重新生成会覆盖它，旧图找不回来（额度也会再花一次）。确定重新生成？');
          if (!ok) return;
        }
        genBtn.disabled = true;
        useBtn.style.display = 'none';
        downloadBtn.style.display = 'none';
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--text-secondary,#888)';
        statusEl.textContent = '正在生成…（最多约3分钟）';
        generating = true;
        try {
          // 加画质后缀，提升头像出图质量
          const fullPrompt = p + ', portrait, upper body, front-facing, high quality, detailed';
          const images = await API.generateImage(fullPrompt, { size: '1024x1024', n: 1 });
          if (!images || !images.length) throw new Error('未返回图片');
          curDataUrl = images[0];
          downloaded = false; // 新图未下载，重置拦截标记
          imgEl.src = curDataUrl;
          previewWrap.style.display = 'flex';
          statusEl.style.display = 'none';
          genBtn.textContent = '重新生成';
          useBtn.style.display = 'block';
          downloadBtn.style.display = 'block';
        } catch (e) {
          statusEl.style.color = 'var(--danger,#e55)';
          statusEl.textContent = '生成失败：' + (e.message || e);
        } finally {
          generating = false;
          genBtn.disabled = false;
        }
      };

      useBtn.onclick = async () => {
        if (!curDataUrl) return;
        // 提醒：「用这张」只把压缩后的小图设为头像，高清原图不会自动存本地。
        // 给个勾选项让用户顺手留底（没下载过才提示，避免重复）。
        if (!downloaded) {
          const r = await UI.showConfirm('用这张头像', '这会把它设为头像（存的是压缩后的小图）。高清原图不会自动保存到本地，之后想要原图就没有了。', { checkbox: '同时下载高清原图到本地留存' });
          const ok = (r && typeof r === 'object') ? r.ok : r;
          if (!ok) return; // 取消：留在弹窗
          if (r && r.checked) {
            // 下载高清原图
            try {
              const a = document.createElement('a');
              a.href = curDataUrl;
              a.download = `skynex-avatar-${Date.now()}.png`;
              a.style.display = 'none';
              document.body.appendChild(a);
              a.click();
              setTimeout(() => { try { document.body.removeChild(a); } catch(_) {} }, 100);
              downloaded = true;
              if (typeof UI !== 'undefined' && UI.showToast) UI.showToast('原图已保存到下载目录', 1500);
            } catch(_) {}
          }
        }
        const result = await compressDataUrl(curDataUrl, { maxSize, quality, outputFormat: 'jpeg' });
        cleanup();
        resolve(result);
      };

      // 下载原图（未压缩的 1024 大图，避免花钱生成的图只能变小头像）
      downloadBtn.onclick = () => {
        if (!curDataUrl) return;
        try {
          const a = document.createElement('a');
          a.href = curDataUrl;
          a.download = `skynex-avatar-${Date.now()}.png`;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { try { document.body.removeChild(a); } catch(_) {} }, 100);
          downloaded = true; // 已下载，关闭时不再拦截
          if (typeof UI !== 'undefined' && UI.showToast) UI.showToast('已保存到下载目录', 1500);
        } catch(_) {}
      };

      overlay.querySelector('#_aiav-cancel').onclick = () => { _tryClose(); };
      overlay.onclick = (e) => { if (e.target === overlay) { _tryClose(); } };
    });
  }

  // ===== 统一文件保存/选择（v709.80）=====
  // 背景：安卓 WebView 有"用户手势窗口"——下载(a.click)和文件选择(input.click)都必须
  // 在用户手势的同步调用栈里触发。若 click 之前隔了 await（生成/压缩数据），手势会被消费掉，
  // click 被静默拒绝（下载框/文件框不弹，表现为"点了没反应""薛定谔成功"）。
  // 另外隐藏用 display:none 的 file input 在部分 WebView 上也会被拒绝 click()。
  // 这两个工具把正确姿势封装起来，全项目统一走它，避免各处各写各的坑。

  // 保存文件。source 可以是 Blob 或 dataURL 字符串。
  // 弹一个「文件已就绪」面板，用户点「保存」时在纯同步栈里 a.click()，手势必定有效。
  // 返回 Promise<boolean>：true=已点保存，false=取消。
  function saveFile(source, fileName) {
    return new Promise((resolve) => {
      let url, isObjectUrl = false;
      if (typeof source === 'string') {
        url = source; // dataURL，直接用
      } else {
        url = URL.createObjectURL(source);
        isObjectUrl = true;
      }
      let sizeText = '';
      try {
        if (source && typeof source.size === 'number') {
          const kb = source.size / 1024;
          sizeText = kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB';
        }
      } catch(_) {}

      const mask = document.createElement('div');
      mask.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:24px';
      const panel = document.createElement('div');
      panel.style.cssText = 'background:var(--bg-elevated,#1c1c1e);color:var(--text-primary,#fff);border-radius:16px;max-width:340px;width:100%;padding:22px 20px;box-shadow:0 12px 40px rgba(0,0,0,0.45)';
      panel.innerHTML = `
        <div style="font-size:16px;font-weight:600;margin-bottom:10px">文件已就绪</div>
        <div style="font-size:13px;color:var(--text-secondary,#aaa);line-height:1.6;margin-bottom:6px;word-break:break-all">${fileName}</div>
        <div style="font-size:12px;color:var(--text-secondary,#888);margin-bottom:18px">${sizeText ? '大小约 ' + sizeText + '　·　' : ''}点「保存到文件」选择存放位置</div>
        <div style="display:flex;gap:10px">
          <button type="button" id="_sf-cancel" style="flex:1;padding:11px;border:none;border-radius:10px;background:var(--bg-input,#2c2c2e);color:var(--text-primary,#fff);font-size:14px;cursor:pointer">取消</button>
          <button type="button" id="_sf-save" style="flex:1.4;padding:11px;border:none;border-radius:10px;background:var(--accent,#e08a2b);color:#fff;font-size:14px;font-weight:600;cursor:pointer">保存到文件</button>
        </div>
      `;
      mask.appendChild(panel);
      document.body.appendChild(mask);

      const cleanup = () => {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (isObjectUrl) setTimeout(() => { try { URL.revokeObjectURL(url); } catch(_) {} }, 1000);
      };

      panel.querySelector('#_sf-save').onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        cleanup();
        resolve(true);
      };
      panel.querySelector('#_sf-cancel').onclick = () => { cleanup(); resolve(false); };
      mask.onclick = (e) => { if (e.target === mask) { cleanup(); resolve(false); } };
    });
  }

  // 选择文件。opts.accept 例如 '.json' / 'image/*' / '.json,.gz'。
  // 统一处理：append 到 DOM（否则部分 WebView 不弹）+ 占位隐藏（非 display:none）+ 用完清理。
  // 返回 Promise<File|null>：选了文件返回 File，取消返回 null。
  function pickFile(opts) {
    return new Promise((resolve) => {
      const o = opts || {};
      const input = document.createElement('input');
      input.type = 'file';
      // 【全平台通用加固】纯扩展名 accept（如 .json/.css）在 iOS「文件」App、鸿蒙、部分安卓杂牌
      // WebView 里会把目标文件灰掉导致选不中——一律不设，放开所有文件（读取都走 FileReader 按文本解析，
      // 不挑扩展名）。含 '/' 的 MIME 类型（image/* / audio/* / text/plain 等）兼容性好且能过滤相册，保留。
      if (o.accept && /\//.test(o.accept)) input.accept = o.accept;
      if (o.multiple) input.multiple = true;
      input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;width:1px;height:1px';
      document.body.appendChild(input);
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        try { if (input.parentNode) input.parentNode.removeChild(input); } catch(_) {}
        resolve(val);
      };
      input.onchange = () => {
        const f = o.multiple ? Array.from(input.files || []) : (input.files && input.files[0]) || null;
        done(f);
      };
      // 取消选择时多数浏览器不触发 onchange；用 focus 兜底回收。
      // 两个 iOS 坑一起治：
      //   ① onchange 竞态：从系统文件选择器/「文件」App 切回来时，focus 常早于 onchange 填充 input.files——
      //      延时太短会把"选了文件"误判成"取消"。故全平台拉长到 1500ms。
      //   ② onchange 不触发：iOS 上隐藏的 file input（opacity:0+移屏外）选完后 onchange 可能根本不触发，
      //      但 input.files 已填充。此时绝不能"交给 onchange"傻等（会永久卡死＝选了没反应），
      //      必须由 focus 兜底直接 done(f) 把文件交出去（done 有 settled 保护，不会和 onchange 重复）。
      window.addEventListener('focus', () => {
        setTimeout(() => {
          if (settled) return;
          if (input.files && input.files.length > 0) {
            // 有文件：直接交出去，不等 onchange（治 iOS onchange 不触发导致的卡死）
            const f = o.multiple ? Array.from(input.files || []) : (input.files && input.files[0]) || null;
            done(f);
            return;
          }
          // 没文件：再等 400ms 二次确认，仍为空才判定取消（治 onchange 慢半拍）
          setTimeout(() => {
            if (settled) return;
            if (input.files && input.files.length > 0) {
              const f = o.multiple ? Array.from(input.files || []) : (input.files && input.files[0]) || null;
              done(f);
            } else {
              done(o.multiple ? [] : null);
            }
          }, 400);
        }, 1500);
      }, { once: true });
      input.click();
    });
  }

  // 解析 [IMG:] 标记内容，支持 AI 在描述前可选地指定尺寸：
  //   [IMG: 描述]                → 默认横图 1024x768
  //   [IMG: 16:9 | 描述]         → 比例关键词
  //   [IMG: 1280x720 | 描述]     → 直接写像素
  //   [IMG: portrait | 描述]     → 方向关键词
  // 尺寸段必须出现在开头、且用 | 分隔；不认识就当描述的一部分、走默认尺寸。
  // 返回 { size, desc }。
  function parseImgTag(raw) {
    const DEFAULT_SIZE = '1024x768';
    const s = String(raw == null ? '' : raw).trim();
    // 必须有 | 才尝试解析尺寸段（避免把普通描述里的冒号误判成比例）
    const pipe = s.indexOf('|');
    if (pipe === -1) return { size: DEFAULT_SIZE, desc: s };
    const head = s.slice(0, pipe).trim().toLowerCase();
    const rest = s.slice(pipe + 1).trim();
    const size = _resolveImgSize(head);
    if (!size) return { size: DEFAULT_SIZE, desc: s }; // 头部不是合法尺寸，整段当描述
    return { size, desc: rest };
  }
  // 清洗发给 AI 的历史里的「生图产物」：手动生图提示词前缀、图片占位符、未处理的 [IMG:] 标记。
  // 这些内容是给生图模型/前端渲染用的，对剧情理解是纯噪音，不该反复进上下文。
  // 只用于构建 API 历史副本，不动存档原文。
  function stripImgArtifacts(content) {
    if (!content || typeof content !== 'string') return content;
    let s = content;
    // 1. 手动生图前缀段：以 [手动生图] 开头到该行结束（提示词整段），连同其后的空行一起去掉
    s = s.replace(/\[手动生图\][^\n]*\n*/g, '');
    // 2. 已渲染的图片占位符 [TSIMG:id|desc]
    s = s.replace(/\[TSIMG:[^\]]*\]\n*/g, '');
    // 3. 未被前端处理的原始生图标记 [IMG: ...]（含尺寸段）
    s = s.replace(/\[IMG:[^\]]*\]\n*/g, '');
    // 收敛多余空行
    s = s.replace(/\n{3,}/g, '\n\n').trim();
    return s;
  }

  // 把尺寸头（比例/方向/像素）归一成 "WxH"；无法识别返回 null。
  function _resolveImgSize(head) {
    if (!head) return null;
    // 关键词/比例映射
    const MAP = {
      'square': '1024x1024', '1:1': '1024x1024',
      'landscape': '1024x768', '4:3': '1024x768', '16:9': '1024x576', '3:2': '1024x683',
      'portrait': '768x1024', '3:4': '768x1024', '9:16': '576x1024', '2:3': '683x1024'
    };
    if (MAP[head]) return MAP[head];
    // 直接写像素：WxH（w/h 各 64~2048，避免离谱值）
    const m = head.match(/^(\d{2,4})\s*[x×*]\s*(\d{2,4})$/);
    if (m) {
      const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
      if (w >= 64 && w <= 2048 && h >= 64 && h <= 2048) return `${w}x${h}`;
    }
    return null;
  }

  return { uuid, timestamp, formatDate, tokenize, matchScore, estimateTokens, parseAIOutput, mergeStatus, serializeStatus, escapeHtml, debounce, refreshAutoResizeTextareas, openFullscreen, closeFullscreen, copyFromDataset, readFileAsText, fileToText, promptImageInput, promptAiAvatar, compressDataUrl, saveFile, pickFile, parseImgTag, stripImgArtifacts };
})();