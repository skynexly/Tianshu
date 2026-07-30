/**
 * 总结系统
 * 数据结构（summaries store，key=conversationId）：
 * {
 *   conversationId,
 *   // ① 追加内容
 *   timeline: [{ date, event }],          // 时间流
 *   metNPCs: [{ name, relationship }],    // 已相遇NPC（relationship格式："在[地点]因[事件]相识，现为[关系]"）
 *   // ② 流动内容（每次覆盖）
 *   majorEvents: string,                  // 重要事件
 *   emotionTurns: string,                 // 重大情感转折
 *   playerState: string,                  // 玩家情感状态与成长
 *   pending: string,                      // 未解决的事情
 *   updatedAt: number
 * }
 */
const Summary = (() => {

  // ===== 数据读写 =====

  async function get(conversationId) {
    return await DB.get('summaries', conversationId) || {
      conversationId,
      timeline: [],
      metNPCs: [],
      majorEvents: '',
      emotionTurns: '',
      playerState: '',
      pending: '',
      updatedAt: 0
    };
  }

  async function save(data) {
    data.updatedAt = Utils.timestamp();
    await DB.put('summaries', data);
  }

  // ===== 截断JSON修复 =====

  function _tryFixTruncatedJSON(str) {
    if (!str || !str.startsWith('{')) return null;
    try {
      let lastGoodPos = -1;
      let braceDepth = 0, inString = false, escaped = false;
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') braceDepth++;
        if (ch === '}') { braceDepth--; if (braceDepth >= 1) lastGoodPos = i; }
      }
      if (lastGoodPos > 0) {
        let fixed = str.substring(0, lastGoodPos + 1).replace(/,\s*$/, '');
        let d1 = 0, d2 = 0, inStr = false, esc = false;
        for (let i = 0; i < fixed.length; i++) {
          const c = fixed[i];
          if (esc) { esc = false; continue; }
          if (c === '\\') { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c === '[') d1++; if (c === ']') d1--;
          if (c === '{') d2++; if (c === '}') d2--;
        }
        for (let i = 0; i < d1; i++) fixed += ']';
        for (let i = 0; i < d2; i++) fixed += '}';
        return JSON.parse(fixed);
      }
    } catch(e) { /* 修复失败 */ }
    return null;
  }

  // ===== 生成总结（调用AI） =====

  async function generate(conversationId, toSummarizeMessages, charName, options) {
    const existing = await get(conversationId);
    const playerName = charName || '用户角色';

    const dialogue = toSummarizeMessages
      .filter(m => m.role !== 'system')
      .map(m => {
        let content = m.content || '';
        // 将status块中的增量时间替换为绝对时间（总结模型需要知道具体日期）
        if (m.statusSnapshot && m.statusSnapshot.time) {
          content = content.replace(/时间：[+\-]\d[^\n]*/g, '时间：' + m.statusSnapshot.time);
        }
        return `[${m.role === 'user' ? playerName : 'AI'}] ${content}`;
      })
      .join('\n\n');

    // 旧内容作为背景提供给AI
    const oldTimelineStr = existing.timeline.map(t => `${t.date}：${t.event}`).join('\n');
    const oldNPCStr = existing.metNPCs.map(n => `${n.name}（${n.relationship}）`).join('\n');
    const oldMajorEvents = existing.majorEvents || '';
    const oldEmotionTurns = existing.emotionTurns || '';
    const oldPlayerState = existing.playerState || '';
    const oldPending = existing.pending || '';

    const prompt = `你是文字冒险游戏的剧情整理者。请根据以下对话内容，结合已有记录，生成全面的结构化剧情总结。只输出JSON，不要其他内容。

=== 已有记录（在此基础上更新） ===

【已有时间流】（以下条目已存档，是追加模式，请勿重复输出，只需在 timeline 里补充本段新发生的事件）
${oldTimelineStr || '（暂无）'}

【已知相遇角色】
${oldNPCStr || '（暂无）'}

【已有重要事件记录】
${oldMajorEvents || '（暂无）'}

【已有情感转折记录】
${oldEmotionTurns || '（暂无）'}

【已有用户角色状态记录】
${oldPlayerState || '（暂无）'}

【已有未解决事项】
${oldPending || '（暂无）'}

=== 本段对话内容 ===
${dialogue}

=== 输出格式 ===
{
  "timeline": [
    {"date": "年月日 星期", "event": "一句话高度概括起因经过结果"}
  ],
  "metNPCs": [
{"name": "角色姓名", "relationship": "在[地点]因[事件]与${playerName}相遇，现在和${playerName}是[当前关系]"}
],
  "majorEvents": "（Markdown格式，见下方说明）",
  "emotionTurns": "（Markdown格式，见下方说明）",
  "playerState": "（Markdown格式，见下方说明）",
  "pending": "（Markdown格式，见下方说明）"
}

=== 各字段详细要求 ===

**1. timeline（时间流）**
- 只列出本段对话中新发生的重要事件——即对剧情有明显推动作用，或者与其他角色的互动明显导致关系变化的事件
- 【已有时间流】里已经存档的条目绝对不要再输出，哪怕内容相似也不要重复；只输出本段全新的事件（这是追加模式，代码会自动接到已有记录后面）
- 格式：时间（年月日 星期，无明确时间写"未知时间"）+ 一句话总结（高度概括起因经过结果）
- 如果本段对话没有新的重要事件，timeline 输出空数组 []

**2. metNPCs（已相遇角色）**
- 列出从故事开始直到现在所有结识的重要角色（路人龙套不算，只要有名字且与剧情/关系有关）
- 格式：角色名字。在什么地方，因为什么事情与${playerName}相遇，现在和${playerName}是什么关系
- 已有的角色覆盖更新，新的角色追加

**3. majorEvents（重要事件）**
- 独立于 timeline 的完整事件档案（不要把它当成时间流来写，两者是不同字段、不同更新模式）：列出目前剧情中全部的重要事件，确保总结后不会遗忘之前发生过的事情
- 格式：时间 + 地点 + 故事的起因、经过、结果。每一个事件完整描述，明确每个事件为什么会发生，经过了什么，为什么会导向这个结果，对后续有什么影响
- 用Markdown格式，每个事件用 **加粗标题** 后跟完整描述
- 覆盖原有的（输出内容直接替换旧记录，所以必须包含旧记录中仍有效的内容+新内容）

**4. emotionTurns（情感转折）**
- 已相遇角色的详细版本。列出所有重要角色对${playerName}的情感状态的变化和现状
- 格式：角色因为某事对${playerName}的看法/情感 → 在经历某事后变得如何 → …目前的状态为：…（当前的最新动向）
- 用Markdown格式，每个角色用 **角色名** 开头
- 覆盖原有的

**5. playerState（用户角色状态与成长）**
- 故事至今，${playerName}有什么变化和成长？目前最新的状态是如何？
- 格式：1. 在经历某事后，${playerName}变得…（能力提升、心理状态的变化）2. … 目前${playerName}最新的状态（能力、心理状态等等）
- 用Markdown格式
- 覆盖原有的

**6. pending（未解决的事情）**
- 列出目前尚未解决的事情，例如：提出要做但是还没有做的事情、与其他角色之间还没有实现的约定、目前潜在的隐患和危机
- 已经解决的事项要从记录中移除
- 用Markdown格式
- 覆盖原有的

=== 关键规则 ===
- timeline 是追加模式：只输出新条目，代码会自动追加到已有记录后面，不要重复已有条目
- metNPCs 是追加/更新模式：已有角色覆盖更新关系，新角色追加
- majorEvents/emotionTurns/playerState/pending 是覆盖模式：输出内容直接替换旧记录，所以必须包含旧记录中仍然有效的内容+新内容
- 务必全面，不要偷懒只写一两条。宁可多写也不要遗漏
- 所有字段如确实无内容则留空字符串""
- **称呼规则**：禁止用“玩家”“NPC”泛称角色；输出的 timeline、metNPCs、majorEvents、emotionTurns、playerState、pending 中都必须直接使用角色姓名。用户角色使用“${playerName}”，其他角色使用各自姓名。只有确实不知道姓名时，才可用“对方”“那名角色”等临时称呼。`;

    GameLog.log('info', '[Summary] 调用总结模型...');
    const raw = await API.summarize(dialogue, prompt, options);
    GameLog.log('info', `[Summary] 返回: ${raw.substring(0, 80)}`);

    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
    }
    let data;
    try {
      data = JSON.parse(cleaned);
    } catch (parseErr) {
      // 尝试修复截断的JSON
      GameLog.log('info', `[Summary] JSON解析失败，尝试修复截断: ${parseErr.message}`);
      data = _tryFixTruncatedJSON(cleaned);
      if (!data) throw parseErr;
      GameLog.log('info', '[Summary] 截断JSON修复成功');
    }

    // ① 追加内容合并（去重：用 date+event前10字 判断是否已存在）
    if (data.timeline?.length) {
      const existingKeys = new Set(existing.timeline.map(t => `${t.date}|${(t.event || '').slice(0, 10)}`));
      for (const t of data.timeline) {
        const key = `${t.date}|${(t.event || '').slice(0, 10)}`;
        if (!existingKeys.has(key)) {
          existing.timeline.push(t);
          existingKeys.add(key);
        }
      }
    }
    if (data.metNPCs?.length) {
      for (const npc of data.metNPCs) {
        const idx = existing.metNPCs.findIndex(n => n.name === npc.name);
        if (idx >= 0) existing.metNPCs[idx].relationship = npc.relationship;
        else existing.metNPCs.push(npc);
      }
    }

    // ② 流动内容覆盖
    if (data.majorEvents) existing.majorEvents = data.majorEvents;
    if (data.emotionTurns !== undefined) existing.emotionTurns = data.emotionTurns;
    if (data.playerState) existing.playerState = data.playerState;
    if (data.pending !== undefined) existing.pending = data.pending;

    existing.conversationId = conversationId;
    await save(existing);
    GameLog.log('info', '[Summary] 总结已更新');
    return existing;
  }

  // ===== 归档 =====

  async function archive(conversationId, messages) {
    const arch = {
      id: Utils.uuid(),
      conversationId,
      archivedAt: Utils.timestamp(),
      messages: messages.map(m => {
        let content = m.content || '';
        // 归档时将增量时间替换为绝对时间，方便日后查阅
        if (m.statusSnapshot && m.statusSnapshot.time) {
          content = content.replace(/时间：[+\-]\d[^\n]*/g, '时间：' + m.statusSnapshot.time);
        }
        return {
          role: m.role,
          content,
          timestamp: m.timestamp
        };
      })
    };
    await DB.put('archives', arch);
    GameLog.log('info', `[Archive] 归档 ${messages.length} 条消息`);
    return arch;
  }

  async function getArchives(conversationId) {
    const all = await DB.getAll('archives');
    return all
      .filter(a => a.conversationId === conversationId)
      .sort((a, b) => a.archivedAt - b.archivedAt);
  }

  // ===== 导出归档 =====

  async function exportArchive(arch, convName) {
    const lines = [`=== 归档记录 · ${convName || '对话'} ===`,
      `归档时间：${new Date(arch.archivedAt).toLocaleString()}`, ''];
    for (const m of arch.messages) {
      lines.push(`[${m.role === 'user' ? '玩家' : m.role === 'assistant' ? 'AI' : '系统'}]`);
      lines.push(m.content);
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const saved = await Utils.saveFile(blob, `archive_${new Date(arch.archivedAt).toISOString().slice(0, 10)}.txt`);
    if (saved && typeof UI !== 'undefined' && UI.showToast) UI.showToast('已导出归档记录', 1800);
  }

  // ===== 剧情总结 导出 / 导入 =====

  // 导出当前对话的剧情总结为 JSON 文件（不含归档原文，只含总结数据）
  async function _exportSummary() {
    try {
      const convId = _editConvId;
      if (!convId) { UI.showToast('没有可导出的总结', 1800); return; }
      const data = await get(convId);
      const hasContent = (data.timeline && data.timeline.length) || (data.metNPCs && data.metNPCs.length)
        || data.majorEvents || data.emotionTurns || data.playerState || data.pending;
      if (!hasContent) { UI.showToast('当前总结是空的，没什么可导出', 2000); return; }
      // 取对话名做文件名
      let convName = '对话';
      try {
        const cl = await DB.get('gameState', 'conversationList');
        const conv = (cl && cl.value ? cl.value : cl || []).find(c => c && c.id === convId);
        if (conv && conv.name) convName = conv.name;
      } catch(_) {}
      const payload = {
        __type: 'tianshu_story_summary',
        __version: 1,
        exportedAt: Date.now(),
        convName,
        summary: {
          timeline: data.timeline || [],
          metNPCs: data.metNPCs || [],
          majorEvents: data.majorEvents || '',
          emotionTurns: data.emotionTurns || '',
          playerState: data.playerState || '',
          pending: data.pending || ''
        }
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const fnSafe = String(convName).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      const saved = await Utils.saveFile(blob, `剧情总结_${fnSafe}_${new Date().toISOString().slice(0, 10)}.json`);
      if (saved) UI.showToast('已导出剧情总结', 1800);
    } catch (e) {
      try { GameLog.log('error', `[Summary] 导出失败：${e && e.message}`); } catch(_) {}
      await UI.showAlert('导出失败', String(e && e.message || e));
    }
  }

  // 导入剧情总结（覆盖 / 合并当前对话）
  async function _importSummary() {
    try {
      const convId = _editConvId;
      if (!convId) { UI.showToast('请先打开一个对话的总结', 1800); return; }
      const file = await Utils.pickFile({ accept: '.json,application/json' });
      if (!file) return;
      const text = await Utils.fileToText(file);
      let payload = JSON.parse(text);
      // 兼容：既支持带包装的导出格式，也支持直接是 summary 对象
      const s = (payload && payload.summary) ? payload.summary : payload;
      if (!s || typeof s !== 'object') throw new Error('文件格式不对');
      const inTimeline = Array.isArray(s.timeline) ? s.timeline : [];
      const inNPCs = Array.isArray(s.metNPCs) ? s.metNPCs : [];
      const hasAny = inTimeline.length || inNPCs.length || s.majorEvents || s.emotionTurns || s.playerState || s.pending;
      if (!hasAny) throw new Error('文件里没有可导入的总结内容');

      // 确认导入（合并进当前对话）
      const mode = await UI.showConfirm(
        '导入剧情总结',
        `检测到 ${inTimeline.length} 条时间流、${inNPCs.length} 位角色。\n\n将合并进当前对话：时间流 / 角色追加去重，重要事件/情感转折/玩家状态/未解决事项等字段用导入内容覆盖。\n\n确定导入？`
      );
      if (!mode) return;

      const data = await get(convId);
      // 时间流合并去重：date+event 前10字
      const _sig = (t) => `${(t.date || '').trim()}|${String(t.event || '').trim().slice(0, 10)}`;
      const existSig = new Set((data.timeline || []).map(_sig));
      inTimeline.forEach(t => { if (t && t.event && !existSig.has(_sig(t))) { data.timeline.push({ date: t.date || '', event: t.event }); existSig.add(_sig(t)); } });
      // 角色合并去重：按 name
      const existName = new Set((data.metNPCs || []).map(n => (n.name || '').trim()));
      inNPCs.forEach(n => { if (n && n.name && !existName.has((n.name || '').trim())) { data.metNPCs.push({ name: n.name, relationship: n.relationship || '' }); existName.add((n.name || '').trim()); } });
      // 流动字段：导入内容非空则覆盖
      if (s.majorEvents) data.majorEvents = s.majorEvents;
      if (s.emotionTurns) data.emotionTurns = s.emotionTurns;
      if (s.playerState) data.playerState = s.playerState;
      if (s.pending) data.pending = s.pending;

      await save(data);
      renderSummaryView(data, convId, _renderContainerId);
      UI.showToast(`已导入：+${inTimeline.length} 时间流、+${inNPCs.length} 角色`, 2500);
    } catch (e) {
      try { GameLog.log('error', `[Summary] 导入失败：${e && e.message}`); } catch(_) {}
      await UI.showAlert('导入失败', '文件不是合法的剧情总结 JSON。\n\n' + (e && e.message || ''));
    }
  }

  // ===== UI =====

  let viewingArchiveId = null;

  async function showSummaryPanel(conversationId) {
    const data = await get(conversationId);
    renderSummaryView(data, conversationId);
    document.getElementById('panel-summary').classList.add('active');
  }

  // Markdown 渲染兜底：单个字段渲染抛错时降级为转义纯文本 + 提示，避免整页崩成空白
  function _safeMd(text, fieldName) {
    if (text == null || text === '') return '<p style="color:var(--text-secondary);font-size:13px">暂无</p>';
    try {
      return Markdown.render(text);
    } catch (e) {
      try { GameLog.log('error', `[Summary] 字段「${fieldName || '?'}」Markdown 渲染失败：${e && e.message}`); } catch(_) {}
      const esc = (typeof Utils !== 'undefined' && Utils.escapeHtml) ? Utils.escapeHtml(String(text)) : String(text);
      return `<p style="color:var(--text-secondary);font-size:12px;margin-bottom:6px">⚠ 此段格式渲染异常，已降级为纯文本</p><div style="white-space:pre-wrap;font-size:13px;line-height:1.6">${esc}</div>`;
    }
  }

  // 时间流内容 HTML（含底部添加/合并按钮）——全量重绘和局部重建共用
  function _buildTimelineHtml(data) {
    const isMergingTimeline = _mergeMode === 'timeline';
    return (data.timeline || []).map((t, i) => `
      <div class="summary-row${isMergingTimeline ? ' merge-selectable' : ''}${isMergingTimeline && _mergeSelected.has(i) ? ' merge-selected' : ''}" data-section="timeline" data-idx="${i}"${isMergingTimeline ? ` onclick="Summary._toggleMergeItem(${i})"` : ''}>
        ${isMergingTimeline ? `<div class="merge-checkbox">${_mergeSelected.has(i) ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--bg-primary)" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m9 12 2 2 4-4" stroke="var(--bg-primary)" fill="none"/></svg>' : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>'}</div>` : ''}
        <div class="summary-timeline-main" style="flex:1">
          <div class="summary-date">${Utils.escapeHtml(t.date || '未知时间')}</div>
          <div class="summary-event">${Utils.escapeHtml(t.event)}</div>
        </div>
        ${!isMergingTimeline ? `<div class="summary-timeline-actions">
          <button class="summary-edit-btn" onclick="Summary._editTimeline(${i})">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>
          </button>
          <button class="summary-edit-btn" onclick="Summary._deleteTimeline(${i})" style="color:var(--danger)">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>` : ''}
      </div>`).join('') +
      `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        ${!isMergingTimeline ? `<button onclick="Summary._addTimeline()" style="padding:6px 12px;font-size:13px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;gap:6px">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
          添加
        </button>` : ''}
        ${(data.timeline || []).length >= 2 ? (isMergingTimeline
          ? `<button onclick="Summary._confirmMerge()" style="padding:6px 12px;font-size:13px;background:var(--accent);border:none;border-radius:6px;color:#fff;cursor:pointer;display:flex;align-items:center;gap:6px;opacity:${_mergeSelected.size >= 2 ? '1' : '0.5'}" ${_mergeSelected.size < 2 ? 'disabled' : ''}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>
              确认合并 (${_mergeSelected.size})
            </button>
            <button onclick="Summary._cancelMerge()" style="padding:6px 12px;font-size:13px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);cursor:pointer">取消</button>`
          : `<button onclick="Summary._startMerge('timeline')" style="padding:6px 12px;font-size:13px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;gap:6px">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>
              合并
            </button>`)
        : ''}
      </div>`;
  }

  // 已相遇角色内容 HTML（含底部添加/合并按钮）——全量重绘和局部重建共用
  function _buildNPCHtml(data) {
    const isMergingNPC = _mergeMode === 'npc';
    return (data.metNPCs || []).map((n, i) => `
      <div class="summary-row${isMergingNPC ? ' merge-selectable' : ''}${isMergingNPC && _mergeSelected.has(i) ? ' merge-selected' : ''}" data-section="npc" data-idx="${i}" style="flex-direction:column;align-items:stretch;gap:2px"${isMergingNPC ? ` onclick="Summary._toggleMergeItem(${i})"` : ''}>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:6px">
            ${isMergingNPC ? `<div class="merge-checkbox">${_mergeSelected.has(i) ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--bg-primary)" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m9 12 2 2 4-4" stroke="var(--bg-primary)" fill="none"/></svg>' : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>'}</div>` : ''}
            <span style="color:var(--accent);font-weight:bold;font-size:13px">${Utils.escapeHtml(n.name)}</span>
          </div>
          ${!isMergingNPC ? `<div style="display:flex;gap:4px;flex-shrink:0">
            <button class="summary-edit-btn" onclick="Summary._editNPC(${i})">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>
            </button>
            <button class="summary-edit-btn" onclick="Summary._deleteNPC(${i})" style="color:var(--danger)">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>` : ''}
        </div>
        <span style="font-size:12px;color:var(--text-secondary);line-height:1.5;padding-left:${isMergingNPC ? '22' : '2'}px">${Utils.escapeHtml(n.relationship)}</span>
      </div>`).join('') +
      `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        ${!isMergingNPC ? `<button onclick="Summary._addNPC()" style="padding:6px 12px;font-size:13px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;gap:6px">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
          添加
        </button>` : ''}
        ${(data.metNPCs || []).length >= 2 ? (isMergingNPC
          ? `<button onclick="Summary._confirmMerge()" style="padding:6px 12px;font-size:13px;background:var(--accent);border:none;border-radius:6px;color:#fff;cursor:pointer;display:flex;align-items:center;gap:6px;opacity:${_mergeSelected.size >= 2 ? '1' : '0.5'}" ${_mergeSelected.size < 2 ? 'disabled' : ''}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>
              确认合并 (${_mergeSelected.size})
            </button>
            <button onclick="Summary._cancelMerge()" style="padding:6px 12px;font-size:13px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);cursor:pointer">取消</button>`
          : `<button onclick="Summary._startMerge('npc')" style="padding:6px 12px;font-size:13px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;gap:6px">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>
              合并
            </button>`)
        : ''}
      </div>`;
  }

  // 局部重建时间流 section，保留内滚区 scrollTop
  async function _rerenderTimelineSection() {
    const data = await get(_editConvId);
    const cont = document.getElementById('summary-timeline');
    if (!cont) { renderSummaryView(data, _editConvId, _renderContainerId); return; }
    const st = cont.scrollTop;
    cont.innerHTML = _buildTimelineHtml(data);
    try {
      const _max = cont.scrollHeight - cont.clientHeight;
      cont.scrollTop = Math.min(st, Math.max(0, _max));
    } catch(_) {}
  }

  // 局部重建已相遇角色 section，保留内滚区 scrollTop
  async function _rerenderNPCSection() {
    const data = await get(_editConvId);
    const cont = document.getElementById('summary-npcs');
    if (!cont) { renderSummaryView(data, _editConvId, _renderContainerId); return; }
    const st = cont.scrollTop;
    cont.innerHTML = _buildNPCHtml(data);
    try {
      const _max = cont.scrollHeight - cont.clientHeight;
      cont.scrollTop = Math.min(st, Math.max(0, _max));
    } catch(_) {}
  }

  function renderSummaryView(data, conversationId, containerId) {
    const el = document.getElementById(containerId || 'summary-content');
    if (!el) return;
    _renderContainerId = containerId || 'summary-content';
    _editConvId = conversationId;
    // 记住滚动位置：找 el 最近的可滚动祖先，重绘后恢复，避免删除/合并后弹回顶部
    let _scrollEl = null, _savedScrollTop = 0;
    try {
      let _p = el;
      while (_p && _p !== document.body) {
        const _oy = getComputedStyle(_p).overflowY;
        if ((_oy === 'auto' || _oy === 'scroll') && _p.scrollHeight > _p.clientHeight) { _scrollEl = _p; break; }
        _p = _p.parentElement;
      }
      if (_scrollEl) _savedScrollTop = _scrollEl.scrollTop;
    } catch(_) {}
   try {

    // 记住当前展开状态
    const expandedIds = new Set();
    el.querySelectorAll('.summary-section-content').forEach(sec => {
      if (!sec.classList.contains('collapsed') && sec.id) expandedIds.add(sec.id);
    });

    const timelineHtml = _buildTimelineHtml(data);

    const npcHtml = _buildNPCHtml(data);


    el.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <button onclick="Summary._exportSummary()" style="flex:1;padding:7px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text-secondary);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>导出总结
        </button>
        <button onclick="Summary._importSummary()" style="flex:1;padding:7px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text-secondary);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>导入总结
        </button>
      </div>
      <div class="summary-section">
<div class="summary-section-header" onclick="Summary._toggleSection(this)">
<span><svg class="folder-arrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> 时间流</span>
</div>
<div id="summary-timeline" class="summary-section-content collapsed">${timelineHtml}</div>
</div>

<div class="summary-section">
<div class="summary-section-header" onclick="Summary._toggleSection(this)">
<span><svg class="folder-arrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle"><path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/></svg> 已相遇角色</span>
</div>
<div id="summary-npcs" class="summary-section-content collapsed">${npcHtml}</div>
</div>

      <div class="summary-section">
        <div class="summary-section-header" onclick="Summary._toggleSection(this)">
          <span><svg class="folder-arrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><path d="m12.296 3.464 3.02 3.956"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m6.18 5.276 3.1 3.899"/></svg> 重要事件</span>
          <button class="summary-edit-btn" onclick="event.stopPropagation();Summary._editField('majorEvents')">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>
          </button>
        </div>
        <div id="sf-majorEvents" class="summary-section-content collapsed">${_safeMd(data.majorEvents, 'majorEvents')}</div>
      </div>

      <div class="summary-section">
        <div class="summary-section-header" onclick="Summary._toggleSection(this)">
          <span><svg class="folder-arrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/></svg> 情感转折</span>
          <button class="summary-edit-btn" onclick="event.stopPropagation();Summary._editField('emotionTurns')">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>
          </button>
        </div>
        <div id="sf-emotionTurns" class="summary-section-content collapsed">${_safeMd(data.emotionTurns, 'emotionTurns')}</div>
      </div>

      <div class="summary-section">
        <div class="summary-section-header" onclick="Summary._toggleSection(this)">
          <span><svg class="folder-arrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><path d="M18 21a6 6 0 0 0-12 0"/><circle cx="12" cy="11" r="4"/><rect width="18" height="18" x="3" y="3" rx="2"/></svg> 状态与成长</span>
          <button class="summary-edit-btn" onclick="event.stopPropagation();Summary._editField('playerState')">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>
          </button>
        </div>
        <div id="sf-playerState" class="summary-section-content collapsed">${_safeMd(data.playerState, 'playerState')}</div>
      </div>

      <div class="summary-section">
        <div class="summary-section-header" onclick="Summary._toggleSection(this)">
          <span><svg class="folder-arrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><path d="M16 14v2.2l1.6 1"/><path d="M16 4h2a2 2 0 0 1 2 2v.832"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h2"/><circle cx="16" cy="16" r="6"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg> 未解决的事情</span>
          <button class="summary-edit-btn" onclick="event.stopPropagation();Summary._editField('pending')">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>
          </button>
        </div>
        <div id="sf-pending" class="summary-section-content collapsed">${_safeMd(data.pending, 'pending')}</div>
      </div>
    `;

    // 恢复展开状态
    expandedIds.forEach(id => {
      const sec = el.querySelector('#' + id);
      if (sec) {
        sec.classList.remove('collapsed');
        const arrow = sec.previousElementSibling?.querySelector('.folder-arrow');
        if (arrow) arrow.classList.add('expanded');
      }
    });
    // 恢复滚动位置（重绘后 DOM 高度可能变化，clamp 到合法范围）
    if (_scrollEl && _savedScrollTop > 0) {
      try {
        const _max = _scrollEl.scrollHeight - _scrollEl.clientHeight;
        _scrollEl.scrollTop = Math.min(_savedScrollTop, Math.max(0, _max));
      } catch(_) {}
    }
   } catch (e) {
     try { GameLog.log('error', `[Summary] 剧情总结渲染失败：${e && e.message}`); } catch(_) {}
     const esc = (typeof Utils !== 'undefined' && Utils.escapeHtml) ? Utils.escapeHtml(String(e && e.message || e)) : '';
     el.innerHTML = `<div style="padding:16px;color:var(--text-secondary);font-size:13px;line-height:1.7">
       <p style="color:var(--danger);font-weight:600;margin-bottom:8px">⚠ 剧情总结渲染出错</p>
       <p>这条对话的总结数据里有内容触发了渲染异常，已阻止页面崩溃。</p>
       <p style="margin-top:8px;font-size:12px;opacity:0.8">错误：${esc}</p>
       <p style="margin-top:8px;font-size:12px">可尝试重新触发一次剧情总结，或手动编辑修正对应字段。</p>
     </div>`;
   }
  }

  // ===== 归档内容搜索 =====
  // 归档消息已被移出聊天窗口，无法跳回主界面，命中后改为打开归档查看弹窗并定位。
  // 搜的是 arch.messages 原文（含状态栏等结构化块），查看弹窗渲染时会剥离这些块，
  // 因此个别命中词在气泡里可能不可见——首要目的是定位到那段剧情所在的消息。
  let _asTimer = null;
  let _asExpanded = new Set();   // 已展开全部命中的归档 id
  let _asLastQuery = '';
  const AS_PREVIEW_LIMIT = 5;

  function _archiveSearchDebounced(query) {
    clearTimeout(_asTimer);
    _asTimer = setTimeout(() => _archiveSearch(query), 250);
  }

  async function _archiveSearch(query) {
    const el = document.getElementById('modal-archive-list');
    if (!el) return;
    const cid = Conversations.getCurrent();
    const q = (query || '').trim().toLowerCase();
    if (q !== _asLastQuery) { _asExpanded.clear(); _asLastQuery = q; }
    // 清空搜索词：回到常规归档卡片列表
    if (!q) { await renderArchiveList(cid, 'modal-archive-list'); return; }

    const archives = await getArchives(cid);
    if (!archives.length) {
      el.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;padding:8px 0">暂无归档记录</p>';
      return;
    }

    // 逐条归档、逐条消息匹配，记下消息在归档内的下标用于定位
    const groups = [];
    let totalHits = 0;
    for (const a of archives) {
      const hits = [];
      (a.messages || []).forEach((m, idx) => {
        const text = m.content || '';
        if (text.toLowerCase().includes(q)) hits.push({ m, idx });
      });
      if (hits.length) { groups.push({ arch: a, hits }); totalHits += hits.length; }
    }

    if (!totalHits) {
      el.innerHTML = '<div class="gs-empty">没有在归档记录里找到匹配的内容</div>';
      return;
    }

    const escRe = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let html = `<div style="font-size:12px;color:var(--text-secondary);padding:0 0 10px">共 ${totalHits} 条匹配（${groups.length} 份归档）</div>`;
    // 归档按时间倒序（最近归档的在前）
    groups.sort((a, b) => (b.arch.archivedAt || 0) - (a.arch.archivedAt || 0));
    for (const g of groups) {
      const aid = g.arch.id;
      const isExpanded = _asExpanded.has(aid);
      const shown = isExpanded ? g.hits : g.hits.slice(0, AS_PREVIEW_LIMIT);
      html += `<div class="gs-group">`;
      html += `<div class="gs-group-title">${new Date(g.arch.archivedAt).toLocaleString()} <span class="gs-count">${g.hits.length}条匹配</span></div>`;
      for (const h of shown) {
        const role = h.m.role === 'user' ? '你' : (h.m.role === 'assistant' ? 'AI' : '系统');
        const text = h.m.content || '';
        const pos = text.toLowerCase().indexOf(q);
        const start = Math.max(0, pos - 40);
        const end = Math.min(text.length, pos + q.length + 80);
        let snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
        snippet = Utils.escapeHtml(snippet).replace(new RegExp(escRe, 'gi'), s => `<mark>${s}</mark>`);
        html += `<div class="gs-item" onclick="Summary._viewArchive('${aid}', ${h.idx})">`;
        html += `<div class="gs-role">${role}</div>`;
        html += `<div class="gs-preview">${snippet}</div>`;
        html += `</div>`;
      }
      if (g.hits.length > AS_PREVIEW_LIMIT) {
        html += isExpanded
          ? `<button type="button" class="gs-more" onclick="Summary._asToggleExpand('${aid}')">收起</button>`
          : `<button type="button" class="gs-more" onclick="Summary._asToggleExpand('${aid}')">展开剩余 ${g.hits.length - AS_PREVIEW_LIMIT} 条匹配</button>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;
  }

  function _asToggleExpand(archiveId) {
    if (_asExpanded.has(archiveId)) _asExpanded.delete(archiveId);
    else _asExpanded.add(archiveId);
    const input = document.getElementById('archive-search-input');
    _archiveSearch(input ? input.value : _asLastQuery);
  }

  function _toggleSection(headerEl) {
    // headerEl 是被点击的 header 元素本身
    const content = headerEl.nextElementSibling;
    if (!content) return;
    content.classList.toggle('collapsed');
    const arrow = headerEl.querySelector('.folder-arrow');
    if (arrow) {
      arrow.classList.toggle('expanded', !content.classList.contains('collapsed'));
    }
  }

  async function renderArchiveList(conversationId, containerId) {
    const el = document.getElementById(containerId || 'archive-list');
    if (!el) return;
    const archives = await getArchives(conversationId);
    if (archives.length === 0) {
      el.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;padding:8px 0">暂无归档记录</p>';
      return;
    }
    const convData = await DB.get('gameState', 'conversationList');
    const convList = convData?.value || [];
    const convName = convList.find(c => c.id === conversationId)?.name || '对话';
    el.innerHTML = archives.map(a => `
      <div class="card" style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px">${new Date(a.archivedAt).toLocaleString()}</span>
          <span style="font-size:11px;color:var(--text-secondary)">${a.messages.length}条消息</span>
        </div>
        <div class="card-actions">
<button onclick="Summary._viewArchive('${a.id}')" style="display:flex;align-items:center;justify-content:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg> 查看</button>
<button onclick="Summary._restoreArchiveToNewConv('${a.id}','${Utils.escapeHtml(convName)}')" style="display:flex;align-items:center;justify-content:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> 还原到新对话</button>
<button onclick="Summary._exportArchive('${a.id}','${Utils.escapeHtml(convName)}')" style="display:flex;align-items:center;justify-content:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg> 导出</button>
<button onclick="Summary._deleteArchive('${a.id}','${conversationId}','${(containerId || 'archive-list').replace(/'/g, '')}')" style="display:flex;align-items:center;justify-content:center;gap:4px;color:var(--error)"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> 删除</button>
</div>
      </div>`).join('');
  }

  async function _deleteArchive(archiveId, conversationId, containerId) {
    const all = await DB.getAll('archives');
    const arch = all.find(a => a.id === archiveId);
    if (!arch) return;
    const dateStr = new Date(arch.archivedAt).toLocaleString();
    const ok = await UI.showConfirm(
      '永久删除归档？',
      `归档时间：${dateStr}\n包含 ${arch.messages.length} 条消息\n\n⚠ 删除后此归档的所有原始消息将永久丢失，无法恢复。\n（剧情总结本身不会受影响）\n\n建议先「导出」备份后再删除。`
    );
    if (!ok) return;
    await DB.del('archives', archiveId);
    GameLog.log('info', `[Archive] 删除归档 ${archiveId}`);
    UI.showToast('已删除归档', 1800);
    // 刷新列表：搜索态下保持搜索结果，否则回常规列表
    if (_asLastQuery && document.getElementById('archive-search-input')) {
      await _archiveSearch(_asLastQuery);
    } else {
      await renderArchiveList(conversationId, containerId);
    }
  }

  // ===== 编辑功能 =====

  let _editConvId = null;
  let _renderContainerId = null;
  let _mergeMode = null; // null | 'timeline' | 'npc'
  let _mergeSelected = new Set();

  function setConvId(id) {
    if (_editConvId !== id) { _mergeMode = null; _mergeSelected.clear(); }
    _editConvId = id;
  }

  async function _editField(field) {
    const data = await get(_editConvId);
    const val = data[field] || '';
    const modal = document.getElementById('summary-edit-modal');
    document.getElementById('summary-edit-field').value = field;
    document.getElementById('summary-edit-content').value = val;
    document.getElementById('summary-edit-label').textContent = {
      majorEvents: '重要事件', emotionTurns: '情感转折',
      playerState: '状态与成长', pending: '未解决的事情'
    }[field] || field;
    
    // 显示简单编辑区域
    document.getElementById('summary-edit-simple').style.display = 'block';
    document.getElementById('summary-edit-timeline').style.display = 'none';
    document.getElementById('summary-edit-npc').style.display = 'none';
    
    modal.classList.remove('hidden');
  }

  async function _editTimeline(idx) {
    const data = await get(_editConvId);
    const entry = data.timeline[idx];
    if (!entry && idx !== -1) return;
    document.getElementById('summary-edit-field').value = `timeline:${idx}`;
    document.getElementById('summary-edit-label').textContent = idx === -1 ? '添加事件' : '编辑事件';
    document.getElementById('summary-edit-date').value = entry?.date || '';
    document.getElementById('summary-edit-event').value = entry?.event || '';
    
    // 显示对应的编辑区域
    document.getElementById('summary-edit-simple').style.display = 'none';
    document.getElementById('summary-edit-timeline').style.display = 'block';
    document.getElementById('summary-edit-npc').style.display = 'none';
    
    document.getElementById('summary-edit-modal').classList.remove('hidden');
  }

  async function _editNPC(idx) {
    const data = await get(_editConvId);
    const npc = data.metNPCs[idx];
    if (!npc && idx !== -1) return;
    document.getElementById('summary-edit-field').value = `npc:${idx}`;
    document.getElementById('summary-edit-label').textContent = idx === -1 ? '添加人物' : '编辑人物';
    document.getElementById('summary-edit-npc-name').value = npc?.name || '';
    document.getElementById('summary-edit-npc-relation').value = npc?.relationship || '';
    
    // 显示对应的编辑区域
    document.getElementById('summary-edit-simple').style.display = 'none';
    document.getElementById('summary-edit-timeline').style.display = 'none';
    document.getElementById('summary-edit-npc').style.display = 'block';
    
    document.getElementById('summary-edit-modal').classList.remove('hidden');
  }

  async function _addTimeline() {
    _editTimeline(-1);
  }

  async function _addNPC() {
    _editNPC(-1);
  }

  async function saveEdit() {
    const field = document.getElementById('summary-edit-field').value;
    const data = await get(_editConvId);

    if (field.startsWith('merge-timeline:')) {
      // 合并时间流
      const indices = field.split(':')[1].split(',').map(Number).sort((a, b) => b - a);
      const entry = {
        date: document.getElementById('summary-edit-date').value || '',
        event: document.getElementById('summary-edit-event').value || ''
      };
      // 从后往前删，避免索引偏移
      for (const idx of indices) data.timeline.splice(idx, 1);
      // 在最小索引位置插入合并后的条目
      const insertAt = Math.min(...indices.map(Number));
      data.timeline.splice(insertAt, 0, entry);
      _mergeMode = null;
      _mergeSelected.clear();
    } else if (field.startsWith('merge-npc:')) {
      // 合并NPC
      const indices = field.split(':')[1].split(',').map(Number).sort((a, b) => b - a);
      const npc = {
        name: document.getElementById('summary-edit-npc-name').value || '',
        relationship: document.getElementById('summary-edit-npc-relation').value || ''
      };
      for (const idx of indices) data.metNPCs.splice(idx, 1);
      const insertAt = Math.min(...indices.map(Number));
      data.metNPCs.splice(insertAt, 0, npc);
      _mergeMode = null;
      _mergeSelected.clear();
    } else if (field.startsWith('timeline:')) {
      const idx = parseInt(field.split(':')[1]);
      const entry = { 
        date: document.getElementById('summary-edit-date').value || '', 
        event: document.getElementById('summary-edit-event').value || '' 
      };
      if (idx === -1) {
        data.timeline.push(entry);
      } else {
        data.timeline[idx] = entry;
      }
    } else if (field.startsWith('npc:')) {
      const idx = parseInt(field.split(':')[1]);
      const npc = { 
        name: document.getElementById('summary-edit-npc-name').value || '', 
        relationship: document.getElementById('summary-edit-npc-relation').value || '' 
      };
      if (idx === -1) {
        data.metNPCs.push(npc);
      } else {
        data.metNPCs[idx] = npc;
      }
    } else {
      data[field] = document.getElementById('summary-edit-content').value;
    }

    await save(data);
    closeEdit();
    renderSummaryView(data, _editConvId, _renderContainerId);
  }

  async function closeEdit() {
    const modal = document.getElementById('summary-edit-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
  }

  async function _deleteTimeline(idx) {
    if (!await UI.showConfirm('确认删除', '确定删除这条事件记录？')) return;
    const data = await get(_editConvId);
    data.timeline.splice(idx, 1);
    await save(data);
    await _rerenderTimelineSection();
  }

  async function _deleteNPC(idx) {
    if (!await UI.showConfirm('确认删除', '确定删除这条人物记录？')) return;
    const data = await get(_editConvId);
    data.metNPCs.splice(idx, 1);
    await save(data);
    await _rerenderNPCSection();
  }

  // ===== 合并功能 =====

  async function _startMerge(type) {
    _mergeMode = type;
    _mergeSelected.clear();
    if (type === 'timeline') await _rerenderTimelineSection();
    else await _rerenderNPCSection();
  }

  async function _cancelMerge() {
    const prev = _mergeMode;
    _mergeMode = null;
    _mergeSelected.clear();
    if (prev === 'timeline') await _rerenderTimelineSection();
    else if (prev === 'npc') await _rerenderNPCSection();
    else { const data = await get(_editConvId); renderSummaryView(data, _editConvId, _renderContainerId); }
  }

  async function _toggleMergeItem(idx) {
    const selected = _mergeSelected.has(idx);
    if (selected) _mergeSelected.delete(idx);
    else _mergeSelected.add(idx);
    // 局部更新，不整表重绘（避免滚动位置丢失/闪烁）
    try {
      const el = document.getElementById(_renderContainerId || 'summary-content');
      const section = _mergeMode === 'timeline' ? 'timeline' : 'npc';
      const nowSel = _mergeSelected.has(idx);
      const checkedSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--bg-primary)" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m9 12 2 2 4-4" stroke="var(--bg-primary)" fill="none"/></svg>';
      const uncheckedSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>';
      if (el) {
        // 定位当前 section 里对应 idx 的行（timeline 行有 data-section，npc 行没有，用 section 内序号兜底）
        let row = el.querySelector(`.summary-row[data-section="${section}"][data-idx="${idx}"]`);
        if (!row) {
          // npc 行没有 data-section/data-idx，按合并可选行的顺序取第 idx 个
          const rows = el.querySelectorAll('.summary-row.merge-selectable');
          row = rows[idx];
        }
        if (row) {
          row.classList.toggle('merge-selected', nowSel);
          const cb = row.querySelector('.merge-checkbox');
          if (cb) cb.innerHTML = nowSel ? checkedSvg : uncheckedSvg;
        }
        // 更新「确认合并 (N)」按钮的计数 / 禁用态
        const mergeBtn = Array.from(el.querySelectorAll('button')).find(b => /确认合并/.test(b.textContent || ''));
        if (mergeBtn) {
          mergeBtn.innerHTML = mergeBtn.innerHTML.replace(/确认合并 \(\d+\)/, `确认合并 (${_mergeSelected.size})`);
          const enough = _mergeSelected.size >= 2;
          mergeBtn.disabled = !enough;
          mergeBtn.style.opacity = enough ? '1' : '0.5';
        }
        return;
      }
    } catch(_) {}
    // 兜底：局部更新失败才全量重绘
    const data = await get(_editConvId);
    renderSummaryView(data, _editConvId, _renderContainerId);
  }

  async function _confirmMerge() {
    if (_mergeSelected.size < 2) return;
    const data = await get(_editConvId);
    const indices = [..._mergeSelected].sort((a, b) => a - b);

    if (_mergeMode === 'timeline') {
      const items = indices.map(i => data.timeline[i]);
      // 预填：时间取第一条，事件按分隔线拼接
      const mergedDate = items[0].date || '';
      const mergedEvent = items.map(t => t.event || '').join('\n───\n');
      // 打开编辑弹窗
      document.getElementById('summary-edit-field').value = `merge-timeline:${indices.join(',')}`;
      document.getElementById('summary-edit-label').textContent = `合并事件 (${indices.length}条)`;
      document.getElementById('summary-edit-date').value = mergedDate;
      document.getElementById('summary-edit-event').value = mergedEvent;
      document.getElementById('summary-edit-simple').style.display = 'none';
      document.getElementById('summary-edit-timeline').style.display = 'block';
      document.getElementById('summary-edit-npc').style.display = 'none';
      document.getElementById('summary-edit-modal').classList.remove('hidden');
    } else if (_mergeMode === 'npc') {
      const items = indices.map(i => data.metNPCs[i]);
      const mergedName = items[0].name || '';
      const mergedRelation = items.map(n => n.relationship || '').join('\n');
      document.getElementById('summary-edit-field').value = `merge-npc:${indices.join(',')}`;
      document.getElementById('summary-edit-label').textContent = `合并人物 (${indices.length}条)`;
      document.getElementById('summary-edit-npc-name').value = mergedName;
      document.getElementById('summary-edit-npc-relation').value = mergedRelation;
      document.getElementById('summary-edit-simple').style.display = 'none';
      document.getElementById('summary-edit-timeline').style.display = 'none';
      document.getElementById('summary-edit-npc').style.display = 'block';
      document.getElementById('summary-edit-modal').classList.remove('hidden');
    }
  }

  function showArchiveListModal() {
    const cid = Conversations.getCurrent();
    // 每次进面板重置搜索状态，避免上次的关键词残留导致列表看着"少了"
    _asExpanded.clear();
    _asLastQuery = '';
    const si = document.getElementById('archive-search-input');
    if (si) si.value = '';
    renderArchiveList(cid, 'modal-archive-list');
    UI.showPanel('archive-list', 'forward');
  }

  function closeArchiveListModal() {
    UI.showPanel('chat', 'back');
  }

  // ===== 归档查看 =====

  async function _viewArchive(archiveId, focusIdx) {
    const all = await DB.getAll('archives');
    const arch = all.find(a => a.id === archiveId);
    if (!arch) return;
    viewingArchiveId = archiveId;

    const container = document.getElementById('archive-view');
    // v726：归档查看改为气泡渲染（仅显示层，arch.messages 原文一字不动，导出仍是完整原文）。
    //   ① 用主聊天同款 .chat-msg 气泡，user 靠右 / assistant 靠左，视觉和当时聊天一致。
    //   ② AI 消息过一遍 Utils.parseAIOutput 取 body，剥掉 status/relation/task/chat 等结构化块，
    //      这些块对人回看剧情没意义，只是噪音。剥离失败则回退显示原文，不至于空白。
    container.innerHTML = arch.messages.map((m, _i) => {
      const isUser = m.role === 'user';
      const isSystem = m.role !== 'user' && m.role !== 'assistant';
      let text = m.content || '';
      if (!isUser && !isSystem) {
        try {
          const parsed = Utils.parseAIOutput(text);
          if (parsed && typeof parsed.body === 'string' && parsed.body.trim()) text = parsed.body;
        } catch(_) {}
      }
      // 系统消息：居中灰条，不做气泡
      if (isSystem) {
        return `<div data-arch-idx="${_i}" style="text-align:center;font-size:11px;color:var(--text-secondary);margin:10px 0">${Utils.escapeHtml(text)}</div>`;
      }
      return `<div data-arch-idx="${_i}" style="display:flex;flex-direction:column;margin-bottom:10px;${isUser ? 'align-items:flex-end' : 'align-items:flex-start'}">
        <div class="chat-msg ${isUser ? 'user' : 'assistant'}" style="max-width:88%">
          <div class="md-content">${Markdown.render(text)}</div>
        </div>
      </div>`;
    }).join('');

    document.getElementById('archive-view-modal').classList.remove('hidden');

    // 从归档搜索点进来：滚动定位到命中的那条消息并闪一下
    if (Number.isFinite(focusIdx)) {
      requestAnimationFrame(() => {
        const target = container.querySelector(`[data-arch-idx="${focusIdx}"]`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const bubble = target.querySelector('.chat-msg') || target;
        bubble.classList.add('search-flash');
        bubble.addEventListener('animationend', () => bubble.classList.remove('search-flash'), { once: true });
      });
    }
  }

  async function _exportArchive(archiveId, convName) {
    const all = await DB.getAll('archives');
    const arch = all.find(a => a.id === archiveId);
    if (arch) exportArchive(arch, convName);
  }

  // ===== 归档还原到新对话 =====
  // 只还原聊天记录原文到一个全新对话，继承世界观/单人卡/世界书绑定，
  // 但不带状态栏/手机/总结/记忆（这些当前对话早已记了新东西，带过去只会串）。
  async function _restoreArchiveToNewConv(archiveId, convName) {
    const all = await DB.getAll('archives');
    const arch = all.find(a => a.id === archiveId);
    if (!arch) { UI.showToast('归档不存在', 1800); return; }
    if (!arch.messages || arch.messages.length === 0) { UI.showToast('该归档没有可还原的消息', 1800); return; }
    const dateStr = new Date(arch.archivedAt).toLocaleString();
    const ok = await UI.showConfirm(
      '还原到新对话',
      `将这段归档的 ${arch.messages.length} 条聊天记录还原到一个新对话（不影响当前对话）。\n\n新对话只带聊天记录原文，不带状态栏、手机数据、剧情总结和记忆（这些当前对话已经是新的了）。\n\n归档时间：${dateStr}\n\n确定继续吗？`
    );
    if (!ok) return;

    try {
      const newConvId = 'conv_' + Utils.uuid().slice(0, 8);
      // 面具：克隆当前面具给新对话用（否则新对话没有可用面具）
      const oldMaskId = (typeof Character !== 'undefined' && Character.getCurrentId) ? Character.getCurrentId() : null;
      const newMaskId = 'mask_' + Utils.uuid().slice(0, 8);
      try { if (oldMaskId && Character.cloneMask) await Character.cloneMask(newMaskId); } catch(_) {}

      // 1. 写入归档消息到新对话（branchId=main，parentId 顺序链起来）
      let parentId = null;
      for (const m of arch.messages) {
        const msg = {
          id: Utils.uuid(),
          role: m.role,
          content: m.content || '',
          conversationId: newConvId,
          branchId: 'main',
          parentId,
          timestamp: m.timestamp || Utils.timestamp()
        };
        await DB.put('messages', msg);
        parentId = msg.id;
      }

      // 2. 注册新对话：继承世界观/单人卡/世界书绑定，但状态栏/手机传空 override（不继承当前对话的运行时状态）
      const emptyStatus = { region: '', location: '', time: '', weather: '', scene: '', playerOutfit: '', playerPosture: '', npcs: [] };
      const branchName = `${convName || '对话'} · 归档还原 ${new Date(arch.archivedAt).toISOString().slice(0, 10)}`;
      await Conversations.addBranch(newConvId, branchName, newMaskId, {
        statusOverride: emptyStatus,
        phoneOverride: {}
      });

      UI.showToast('已还原到新对话', 2000);
      GameLog.log('info', `[Archive] 归档 ${archiveId} 还原到新对话 ${newConvId}（${arch.messages.length} 条）`);
    } catch(e) {
      GameLog.log('error', `[Archive] 还原失败：${e && e.message}`);
      UI.showToast('还原失败：' + (e && e.message || '未知错误'), 3000);
    }
  }

  async function closeArchiveView() {
    const modal = document.getElementById('archive-view-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
    viewingArchiveId = null;
  }

  // 注入system prompt用的总结文本
  async function formatForPrompt(conversationId) {
    const data = await get(conversationId);
    if (!data.updatedAt) return '';
    let text = '【剧情总结】以下是本次游戏的历史记录，分为历史背景与近期剧情两层，请按各自说明参考。\n';

    const hasHistory = data.timeline?.length || data.metNPCs?.length;
    const hasRecent = data.majorEvents || data.emotionTurns || data.playerState || data.pending;

    if (hasHistory) {
      text += '\n── 历史背景（故事开始至上次总结）──\n以下内容作为背景参考，无需在当前对话中主动提及。但若已认识的角色再次登场，请确保其言行与已建立的关系和历史一致，不要将其当作新角色处理。\n';
      if (data.timeline?.length) {
        text += '\n【时间流】\n';
        data.timeline.forEach(t => { text += `${t.date}：${t.event}\n`; });
      }
      if (data.metNPCs?.length) {
        text += '\n【已相遇角色】\n';
        data.metNPCs.forEach(n => { text += `${n.name}：${n.relationship}\n`; });
      }
    }

    if (hasRecent) {
      text += '\n── 近期剧情 ──\n以下内容与当前情节联系更为紧密。请留意其中的事件是否在当前剧情中出现后续进展，【未解决的事情】中的内容现在进度如何。\n';
      if (data.majorEvents) text += `\n【重要事件】\n${data.majorEvents}\n`;
      if (data.emotionTurns) text += `\n【情感转折】\n${data.emotionTurns}\n`;
      if (data.playerState) text += `\n【用户角色状态】\n${data.playerState}\n`;
      if (data.pending) text += `\n【未解决的事情】\n${data.pending}\n`;
    }

    return text;
  }

  return {
    get, save, generate, archive, getArchives, exportArchive,
    showSummaryPanel, renderSummaryView, renderArchiveList, formatForPrompt,
    showArchiveListModal, closeArchiveListModal, _deleteArchive,
    _archiveSearchDebounced, _asToggleExpand,
    setConvId, saveEdit, closeEdit,
    _editField, _editTimeline, _editNPC, _addTimeline, _addNPC, _deleteTimeline, _deleteNPC,
    _toggleSection,
    _startMerge, _cancelMerge, _toggleMergeItem, _confirmMerge,
    _viewArchive, _exportArchive, _restoreArchiveToNewConv, closeArchiveView,
    _exportSummary, _importSummary
  };
})();