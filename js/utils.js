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
    const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const english = (text.match(/[a-zA-Z]+/g) || []).length;
    const other = (text.match(/[0-9]+/g) || []).length;
    return Math.ceil(chinese * 1.5 + english + other);
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
    chat: null,        // 心动模拟：线上消息
    raw: raw
  };

    if (!raw) return result;

    // 先抽取 <think>...</think>（兼容 <thinking>），从 raw 里剥离
    const thinkMatch = raw.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
    if (thinkMatch) {
      result.thinking = thinkMatch[1].trim();
      raw = raw.replace(thinkMatch[0], '').trim();
    }

    // 先把 ```status 代码块提取出来，并从 raw 里剥离（避免显示在气泡里）
    const statusMatch = raw.match(/```status\s*\n([\s\S]*?)```/i);
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
    const relationMatch = raw.match(/```relation\s*\n([\s\S]*?)```/i);
    if (relationMatch) {
      try { result.relation = JSON.parse(relationMatch[1].trim()); } catch(e) {
        // 容错：非 JSON 格式（如 key:value 格式），尝试简单解析
        try {
          const obj = {};
          relationMatch[1].trim().split('\n').forEach(line => {
            const m = line.match(/^(\S+?)\s*[:：]\s*(.+)/);
            if (m) obj[m[1].trim()] = JSON.parse(m[2].trim());
          });
          if (Object.keys(obj).length > 0) result.relation = obj;
        } catch(_) {}
      }
      raw = raw.replace(relationMatch[0], '').trim();
    }

    const taskMatch = raw.match(/```tasks?\s*\n([\s\S]*?)```/i);
    if (taskMatch) {
      try { result.tasks = JSON.parse(taskMatch[1].trim()); } catch(e) {}
      raw = raw.replace(taskMatch[0], '').trim();
    }

    // 心动模拟：char 锁/解锁手机（含状态面板）
    const phoneLockMatch = raw.match(/```phone-lock\s*\n([\s\S]*?)```/i);
    if (phoneLockMatch) {
      try {
        // 容错：JSON 优先，否则按 key: value 行格式解析
        let obj = null;
        try { obj = JSON.parse(phoneLockMatch[1].trim()); } catch(_) {
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

    const chatMatch = raw.match(/```chat\s*\n([\s\S]*?)```/i);
    if (chatMatch) {
      try { result.chat = JSON.parse(chatMatch[1].trim()); } catch(e) {}
      raw = raw.replace(chatMatch[0], '').trim();
    }

    // 心动模拟：返航触发 marker（空代码块即可）
    // 形如 ```homecoming\n``` 或 ```homecoming``` 或 ```homecoming\n任何内容\n```
    const homecomingMatch = raw.match(/```homecoming\s*([\s\S]*?)```/i);
    if (homecomingMatch) {
      result.homecoming = true;
      raw = raw.replace(homecomingMatch[0], '').trim();
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
            if (text && text !== '无') result.changes.push(text);
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
      npcs: []  // [{name, outfit, posture}]
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
      } else if (/^时间|time/i.test(key)) {
        result.time = val;
      } else if (/^天气|weather/i.test(key)) {
        result.weather = val;
      } else if (/^场景|scene/i.test(key)) {
        result.scene = val;
      } else if (/^(玩家衣着|用户角色.*衣着|user.?outfit|player.?outfit)/i.test(key)) {
result.playerOutfit = val;
} else if (/^(玩家姿势|用户角色.*姿势|user.?posture|player.?posture)/i.test(key)) {
        result.playerPosture = val;
      }
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
    if (status.weather) lines.push('天气：' + status.weather);
    if (status.scene) lines.push('场景：' + status.scene);
    if (status.playerOutfit) lines.push('用户角色-{{user}}-衣着：' + status.playerOutfit);
if (status.playerPosture) lines.push('用户角色-{{user}}-姿势：' + status.playerPosture);
(status.npcs || []).forEach(n => {
if (!n.name) return;
if (n.outfit) lines.push(`角色-${n.name}-衣着：${n.outfit}`);
if (n.posture) lines.push(`角色-${n.name}-姿势：${n.posture}`);
    });
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
      prompt('复制以下内容：', text);
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

  return { uuid, timestamp, formatDate, tokenize, matchScore, estimateTokens, parseAIOutput, mergeStatus, serializeStatus, escapeHtml, debounce, refreshAutoResizeTextareas, openFullscreen, closeFullscreen, copyFromDataset, readFileAsText };
})();