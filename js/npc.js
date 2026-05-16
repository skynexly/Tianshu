/**
 * NPC管理 — 按地区/势力流动
 */
const NPC = (() => {
  // NPC数据结构（从世界观配置文件加载）
  let npcData = [];
  let factionData = [];
  let regionData = [];
  let currentRegion = 'all';
  let presentNPCNames = []; // 当前在场NPC名单（从最近AI输出解析）

  function init(config) {
    npcData = config.npcs || [];
    factionData = config.factions || [];
    regionData = config.regions || [];
  }

  /**
   * 速查表（每轮发送）：三层嵌套概要 地区→势力→NPC
   * @param {Object} options - { includeNpc: 是否包含NPC行，默认true }
   */
  function formatQuickRef(options) {
    const includeNpc = !options || options.includeNpc !== false;
    if (regionData.length === 0) return '';
    let text = '【世界观速查表】\n';
    regionData.forEach(r => {
      text += `\n▸ ${r.name}`;
      if (r.summary) text += `：${r.summary}`;
      text += '\n';
      // 该地区下的势力
      const facs = factionData.filter(f => f.regionName === r.name || f.regionId === r.id);
      if (facs.length > 0) {
        facs.forEach(f => {
          text += `  ├ ${f.name}`;
          if (f.summary) text += `：${f.summary}`;
          text += '\n';
          // 该势力下的NPC（同势力名 + 同地区，避免「默认势力」这种重名势力跨地区串台）
          if (includeNpc) {
            const npcs = npcData.filter(n => {
              if (n.faction !== f.name) return false;
              // 没标 regions 的旧数据兜底：只按 faction 名匹配
              if (!n.regions || n.regions.length === 0) return true;
              return n.regions.includes(r.id) || n.regions.includes(r.name);
            });
            npcs.forEach(n => {
              text += `  │  └ ${n.name}`;
              if (n.aliases) text += `（${n.aliases}）`;
              if (n.summary) text += `：${n.summary}`;
              text += '\n';
            });
          }
        });
      }
      // 不属于任何势力但属于该地区的NPC
      if (includeNpc) {
        const loosenpcs = npcData.filter(n => !n.faction && n.regions && n.regions.includes(r.id || r.name));
        loosenpcs.forEach(n => {
          text += `  └ ${n.name}`;
          if (n.aliases) text += `（${n.aliases}）`;
          if (n.summary) text += `：${n.summary}`;
          text += '\n';
        });
      }
    });
    return text;
  }

  /**
   * 获取当前区域的NPC列表
   */
  function getByRegion(region) {
    if (!region || region === 'all') return npcData;
    return npcData.filter(n =>
      n.regions && n.regions.includes(region)
    );
  }

  /**
   * 获取某势力的NPC
   */
  function getByFaction(faction) {
    if (!faction || faction === 'all') return npcData;
    return npcData.filter(n => n.faction === faction);
  }

  /**
   * 格式化NPC信息为prompt注入文本
   * region='all' 时输出所有地区/势力/NPC的detail（第一轮全量）
   * region=具体地区 时只输出该地区的detail（命中模式）
   * @param {Object} options - { includeNpc: 是否包含NPC详细，默认true }
   */
  function formatForPrompt(region, options) {
    const includeNpc = !options || options.includeNpc !== false;
    const isAll = !region || region === 'all';
    const npcs = includeNpc ? getByRegion(region) : [];
    if (npcs.length === 0 && !isAll && !includeNpc) {
      // 检查是否有地区/势力detail可发
      const reg = regionData.find(r => (r.id || r.name) === region);
      const facs = reg ? factionData.filter(f => f.regionName === reg.name || f.regionId === reg.id) : [];
      const hasContent = (reg && reg.detail) || facs.some(f => f.detail);
      if (!hasContent) return '';
    } else if (npcs.length === 0 && !isAll) {
      return '';
    }

    let text = isAll ? '【全部区域详细档案】\n' : `【${region} 区域详细档案】\n`;

    if (isAll) {
      // 第一轮全量：输出每个地区detail + 该地区下所有势力detail + 该势力下所有NPC detail
      regionData.forEach(r => {
        if (r.detail) {
          text += `\n[地区：${r.name}]\n${r.detail}\n`;
        }
        // 该地区下的所有势力
        const facs = factionData.filter(f => f.regionName === r.name || f.regionId === r.id);
        facs.forEach(f => {
          if (f.detail) {
            text += `\n[势力：${f.name}]\n${f.detail}\n`;
          }
        });
        // 该地区下的所有NPC
        if (includeNpc) {
          const regionNpcs = npcData.filter(n => n.regions && n.regions.includes(r.id || r.name));
          regionNpcs.forEach(n => {
            text += `\n[${n.name}]`;
            if (n.aliases) text += ` 代号/别名:${n.aliases}`;
            if (n.faction) text += ` 势力:${n.faction}`;
            text += `\n${n.detail || ''}\n`;
          });
        }
      });
    } else {
      // 命中模式：只发该地区
      const reg = regionData.find(r => (r.id || r.name) === region);
      if (reg && reg.detail) {
        text += `\n[地区：${reg.name}]\n${reg.detail}\n`;
      }
      // 该地区下所有势力detail（不依赖NPC引用）
      const facs = factionData.filter(f => {
        if (reg) return f.regionName === reg.name || f.regionId === reg.id;
        return false;
      });
      facs.forEach(f => {
        if (f.detail) {
          text += `\n[势力：${f.name}]\n${f.detail}\n`;
        }
      });
      // 该地区NPC detail
      if (includeNpc) {
        npcs.forEach(n => {
          text += `\n[${n.name}]`;
          if (n.aliases) text += ` 代号/别名:${n.aliases}`;
          if (n.faction) text += ` 势力:${n.faction}`;
          text += `\n${n.detail || ''}\n`;
        });
      }
    }

    return text;
  }

  /**
   * 从AI输出中解析当前区域
   */
  function parseRegionFromOutput(parsed) {
    const regionText = (parsed.header?.region || '').trim();
    const locationText = (parsed.header?.location || '').trim();
    // 依次尝试 region → location，因为 AI 有时会把地区名放进小地点
    const candidates = [regionText, locationText].filter(Boolean);
    for (const text of candidates) {
      // 精确匹配
      const directMatch = regionData.find(r =>
        r.name === text || r.aliases?.includes(text)
      );
      if (directMatch) return directMatch.id || directMatch.name;

      // 模糊匹配：文本包含地区名，或者地区名包含文本
      const fuzzyMatch = regionData.find(r => {
        if (text.includes(r.name) || r.name.includes(text)) return true;
        if (r.aliases) return r.aliases.some(a => text.includes(a) || a.includes(text));
        return false;
      });
      if (fuzzyMatch) return fuzzyMatch.id || fuzzyMatch.name;
    }

    return currentRegion;
  }

  function setRegion(region) {
    currentRegion = region;
  }

  function getRegion() {
    return currentRegion;
  }

  /**
   * 命中提及地区：扫文本里精确出现的地区全名/别名，返回 [提及的地区] 注入文本
   * - 大小写不敏感
   * - 排除 excludeRegion（即 currentRegion，避免和"当前区域NPC"重复）
   * - 命中上限 3 个，按文本中首次出现位置排序
   * - 仅输出 name + detail，不带势力 / NPC
   * @param {string} text 要扫描的正文（玩家最新 + AI最近）
   * @param {string} excludeRegion 当前区域 id 或 name
   */
  function formatMentionedForPrompt(text, excludeRegion) {
    if (!text || !regionData.length) return '';
    const lower = String(text).toLowerCase();
    const excludeKey = excludeRegion || '';
    const hits = [];

    for (const r of regionData) {
      const rid = r.id || r.name;
      if (rid === excludeKey || r.name === excludeKey) continue;
      if (!r.detail || !r.detail.trim()) continue; // 没 detail 不发

      // 候选关键词：name + aliases（aliases 可能是字符串"a,b,c"或数组）
      const keys = [];
      if (r.name) keys.push(r.name);
      if (r.aliases) {
        const aliasList = Array.isArray(r.aliases)
          ? r.aliases
          : String(r.aliases).split(/[,，、\s]+/).filter(Boolean);
        keys.push(...aliasList);
      }

      // 找最早出现的位置
      let earliest = -1;
      for (const k of keys) {
        if (!k || k.length < 2) continue; // 太短的跳过，避免被任何长串吞掉
        const idx = lower.indexOf(k.toLowerCase());
        if (idx >= 0 && (earliest < 0 || idx < earliest)) earliest = idx;
      }
      if (earliest >= 0) hits.push({ region: r, pos: earliest });
    }

    if (!hits.length) return '';
    hits.sort((a, b) => a.pos - b.pos);
    const top = hits.slice(0, 3);

    let txt = '【提及的地区】\n本轮玩家或 AI 在正文中提到了以下地区，仅作参考资料，不代表场景已切换；剧情中无需主动展开。\n';
    for (const h of top) {
      txt += `\n[地区：${h.region.name}]\n${h.region.detail.trim()}\n`;
    }
    return txt;
  }

  /**
   * 更新在场NPC名单（从AI输出解析结果里取）
   */
  function setPresentNPCs(names) {
    // 无论是否为空都更新，确保AI输出"无"时能清空上轮缓存
    presentNPCNames = (names || []).filter(n => n !== '无');
  }

  function getPresentNPCs() {
    return presentNPCNames;
  }

  /**
   * 按名字查NPC（模糊匹配）
   */
  function getByNames(names) {
    if (!names || names.length === 0) return [];
    return npcData.filter(n => {
      // 收集本名+所有别名
      const allNames = [n.name];
      if (n.aliases) {
        n.aliases.split(/[,，、]/).forEach(a => { if (a.trim()) allNames.push(a.trim()); });
      }
      return names.some(name =>
        allNames.some(an => an === name || an.includes(name) || name.includes(an))
      );
    });
  }

  /**
   * 格式化「在场NPC」注入文本（排除已在地区NPC里的）
   */
  function formatPresentForPrompt(excludeRegion) {
    const regionNPCNames = new Set(getByRegion(excludeRegion).map(n => n.name));
    const presentNPCs = getByNames(presentNPCNames).filter(n => !regionNPCNames.has(n.name));
    if (presentNPCs.length === 0) return '';
    let text = '【相关角色档案（跨区域）】\n以下角色当前与剧情直接相关（正在跟随用户角色、被提及，或跨区域出现）。请以此资料为准进行扮演，不要自行填充或改变其设定。\n';
    const mentionedFactions = new Set();
    presentNPCs.forEach(n => {
      text += `\n[${n.name}]`;
      if (n.aliases) text += ` 代号/别名:${n.aliases}`;
      if (n.faction) { text += ` 势力:${n.faction}`; mentionedFactions.add(n.faction); }
      text += `\n${n.detail || ''}`;
      text += '\n';
    });
    // 跨区域也发势力完整设定
    if (mentionedFactions.size > 0) {
      const facDetails = [];
      mentionedFactions.forEach(fname => {
        const fac = factionData.find(f => f.name === fname);
        if (fac && (fac.detail || fac.summary)) {
          facDetails.push(`[势力：${fname}]\n${fac.detail || fac.summary}`);
        }
      });
      if (facDetails.length > 0) {
        text += '\n【相关势力档案】\n' + facDetails.join('\n\n') + '\n';
      }
    }
    return text;
  }

  // ===== UI =====

  function filterByRegion(val) {
    renderNPCList(val, document.getElementById('npc-faction-filter').value);
  }

  function filterByFaction(val) {
    renderNPCList(document.getElementById('npc-region-filter').value, val);
  }

  function renderNPCList(region = 'all', faction = 'all') {
    let list = npcData;
    if (region !== 'all') list = list.filter(n => n.regions?.includes(region));
    if (faction !== 'all') list = list.filter(n => n.faction === faction);

    const container = document.getElementById('npc-list');
    container.innerHTML = list.length === 0 ?
      '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无角色数据</p>' :
      list.map(n => `
        <div class="card">
          <h3>${Utils.escapeHtml(n.name)} ${n.faction ? `<span style="font-size:12px;color:var(--text-secondary)">[${Utils.escapeHtml(n.faction)}]</span>` : ''}</h3>
          <p>${Utils.escapeHtml(n.description || '暂无描述')}</p>
          
        </div>
      `).join('');

    // 更新筛选器选项
    updateFilters();
  }

  function updateFilters() {
    const regionSelect = document.getElementById('npc-region-filter');
    const factionSelect = document.getElementById('npc-faction-filter');

    // 保留当前值
    const curR = regionSelect.value;
    const curF = factionSelect.value;

    regionSelect.innerHTML = '<option value="all">全部地区</option>' +
      regionData.map(r => `<option value="${r.id || r.name}">${r.name}</option>`).join('');
    factionSelect.innerHTML = '<option value="all">全部势力</option>' +
      factionData.map(f => `<option value="${f.id || f.name}">${f.name}</option>`).join('');

    regionSelect.value = curR;
    factionSelect.value = curF;
  }

  function renderFactionList() {
    const container = document.getElementById('faction-list');
    container.innerHTML = factionData.length === 0 ?
      '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无势力数据</p>' :
      factionData.map(f => `
        <div class="card">
          <h3>${Utils.escapeHtml(f.name)}</h3>
          <p>${Utils.escapeHtml(f.description || '暂无描述')}</p>
          ${f.territory ? `<p style="font-size:12px;color:var(--accent-dim)">领地: ${Utils.escapeHtml(f.territory)}</p>` : ''}
        </div>
      `).join('');
  }

  return {
    init, getByRegion, getByFaction, getByNames,
    formatQuickRef, formatForPrompt, formatPresentForPrompt,
    parseRegionFromOutput, setRegion, getRegion,
    formatMentionedForPrompt,
    setPresentNPCs, getPresentNPCs,
    filterByRegion, filterByFaction, renderNPCList, renderFactionList
  };
})();