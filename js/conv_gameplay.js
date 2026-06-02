/**
 * ConvGameplay — 对话级玩法配置编辑器
 * 读写只碰 conv.convGameplay / conv.convEvents，和 worldview.js 零耦合
 */
const ConvGameplay = (() => {

  const _esc = (s) => Utils && Utils.escapeHtml ? Utils.escapeHtml(s) : (s || '');

  // ========== 工具函数 ==========

  function _getConv() {
    return Conversations.getList().find(c => c.id === Conversations.getCurrent()) || null;
  }

  async function _ensureConvEvents() {
    const conv = _getConv();
    if (!conv) return null;
    if (!conv.convEvents) {
      const wvId = conv.singleWorldviewId || conv.worldviewId || '';
      const wv = (wvId && wvId !== '__default_wv__') ? await DB.get('worldviews', wvId) : null;
      const hasEvents = wv && Array.isArray(wv.events) && wv.events.length > 0;
      const msg = hasEvents
        ? '将从世界观复制事件列表到当前对话。\n之后修改只影响本对话，不影响世界观原件。\n继续？'
        : '当前世界观无已有事件，将为本对话创建空白事件列表。\n继续？';
      if (!await UI.showConfirm('创建对话级事件配置', msg)) return null;
      conv.convEvents = hasEvents ? JSON.parse(JSON.stringify(wv.events)) : [];
      await Conversations.saveList();
    }
    return conv;
  }

  async function _saveConvEvents(events) {
    const conv = _getConv();
    if (!conv) return;
    conv.convEvents = events;
    await Conversations.saveList();
  }

  // ========== 事件卡片列表 ==========

  let _eventsData = [];

  function _attrConditionSummary(ev) {
    const conds = Array.isArray(ev.attrConditions) ? ev.attrConditions : [];
    if (!conds.length) return '<span style="font-size:11px;color:var(--danger)">未设置数值条件</span>';
    return conds.map(c => {
      const prefix = c.scope === 'allCharacters' ? `所有角色(${c.matchMode === 'any' ? '任一' : '全部'}) / ` : (c.targetName ? c.targetName + ' / ' : '全局 / ');
      return `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${_esc(`${prefix}${c.attrName || '属性'} ${c.operator || '>='} ${c.value ?? 0}`)}</span>`;
    }).join('');
  }

  function _renderEventList() {
    const container = document.getElementById('cg-event-list');
    if (!container) return;
    if (!_eventsData.length) {
      container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:12px;border:1px dashed var(--border);border-radius:8px">暂无事件，点击下方添加或使用 AI 生成</div>';
      return;
    }
    container.innerHTML = _eventsData.map((ev, i) => {
      const triggerType = ev.triggerType || 'keyword';
      const keys = (ev.keys || '').trim();
      const keyTags = triggerType === 'attr' ? _attrConditionSummary(ev) : (keys
        ? keys.split(/[,，\s]+/).filter(Boolean).map(t => `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${_esc(t)}</span>`).join('')
        : '<span style="font-size:11px;color:var(--danger)">未设置关键词</span>');
      const modeLabel = triggerType === 'attr' ? '数值触发' : '关键词触发';
      const completeKey = ev.completeKey ? `<span style="font-size:11px;color:var(--text-secondary)">结束词：${_esc(ev.completeKey)}</span>` : '<span style="font-size:11px;color:var(--danger)">未设置结束词</span>';
      return `<div style="position:relative;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer" onclick="ConvGameplay.editEvent(${i})">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg>
          <span style="font-size:14px;font-weight:bold;color:var(--accent)">${_esc(ev.name || '未命名事件')}</span>
          <span style="font-size:10px;color:var(--text-secondary);border:1px solid var(--border);border-radius:999px;padding:1px 6px">${modeLabel}</span>
        </div>
        <div style="margin-bottom:4px">${keyTags}</div>
        <div style="margin-bottom:4px">${completeKey}</div>
        ${ev.content ? `<div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(ev.content)}</div>` : ''}
      </div>`;
    }).join('');
  }

  // ========== 事件编辑弹窗 ==========

  let _editEventIdx = null;
  let _attrCondDraft = [];

  function _collectAttrOptions() {
    const conv = _getConv();
    const gp = conv?.convGameplay || null;
    // fallback 到世界观
    const opts = [];
    const seenAllCharNames = new Set();
    const doCollect = (gameplay) => {
      if (!gameplay) return;
      (gameplay.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim()).forEach(a => {
        opts.push({ value: `global|||${a.id}`, scope: 'global', targetKey: '', targetName: '', attrId: a.id, attrName: a.name, label: `全局 / ${a.name}` });
      });
      (gameplay.characterAttrs || []).forEach(c => {
        const key = [c?.targetType || '', c?.targetId || '', c?.sourceWorldviewId || ''].join(':');
        (c.attrs || []).filter(a => a && a.id && (a.name || '').trim()).forEach(a => {
          opts.push({ value: `character||${key}||${a.id}`, scope: 'character', targetKey: key, targetName: c.targetName || '', attrId: a.id, attrName: a.name, label: `${c.targetName || '未命名角色'} / ${a.name}` });
          // 收集角色属性名，用于"所有角色"选项
          const nm = (a.name || '').trim();
          if (nm && !seenAllCharNames.has(nm)) {
            seenAllCharNames.add(nm);
            opts.push({ value: `allCharacters|||${nm}`, scope: 'allCharacters', targetKey: '', targetName: '', attrId: '', attrName: nm, label: `所有角色 / ${nm}` });
          }
        });
      });
    };
    doCollect(gp);
    if (!opts.length) {
      // fallback 到世界观 gameplay
      try {
        const wvId = conv?.singleWorldviewId || conv?.worldviewId || '';
        if (wvId) {
          // 同步方式无法读 DB，所以数值触发在对话级暂不支持 fallback
        }
      } catch(_) {}
    }
    return opts;
  }

  function _syncTriggerTypeUI() {
    const typeEl = document.getElementById('cg-event-trigger-type');
    const type = typeEl?.value || 'keyword';
    document.getElementById('cg-event-keyword-row')?.classList.toggle('hidden', type === 'attr');
    document.getElementById('cg-event-attr-row')?.classList.toggle('hidden', type !== 'attr');
    if (type === 'attr') {
      if (_attrCondDraft.length === 0) addAttrCondition();
      else _renderAttrConditions();
    }
  }

  function _renderAttrConditions() {
    const box = document.getElementById('cg-event-attr-conditions');
    if (!box) return;
    const opts = _collectAttrOptions();
    if (!opts.length) {
      box.innerHTML = '<div style="font-size:12px;color:var(--danger);padding:10px;border:1px dashed var(--border);border-radius:8px">请先配置自定义属性（在世界观或对话级配置中）。</div>';
      return;
    }
    box.innerHTML = _attrCondDraft.map((c, i) => {
      const curVal = c.scope === 'allCharacters' ? `allCharacters|||${c.attrName || ''}` : (c.scope === 'character' ? `character||${c.targetKey || ''}||${c.attrId || ''}` : `global|||${c.attrId || ''}`);
      const optHtml = opts.map(o => `<option value="${_esc(o.value)}" ${o.value === curVal ? 'selected' : ''}>${_esc(o.label)}</option>`).join('');
      const isAll = c.scope === 'allCharacters';
      const matchModeHtml = isAll ? `<select onchange="ConvGameplay.updateAttrCondition(${i},'matchMode',this.value)" style="flex:1;min-width:0;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)"><option value="all" ${(c.matchMode || 'all') === 'all' ? 'selected' : ''}>全部满足</option><option value="any" ${c.matchMode === 'any' ? 'selected' : ''}>任一满足</option></select>` : '';
      return `<div style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;animation:slideIn 0.3s ease-out">
        <div style="display:flex;gap:8px;margin-bottom:8px;align-items:flex-start">
          <select onchange="ConvGameplay.updateAttrCondition(${i},'attr',this.value)" style="flex:1;min-width:0;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)">${optHtml}</select>
          <button type="button" onclick="ConvGameplay.removeAttrCondition(${i})" style="width:32px;height:32px;border:1px solid var(--danger);background:none;border-radius:6px;color:var(--danger);cursor:pointer;flex-shrink:0">×</button>
        </div>
        ${isAll ? `<div style="display:flex;gap:8px;margin-bottom:8px">${matchModeHtml}</div>` : ''}
        <div style="display:flex;gap:8px;align-items:center">
          <select onchange="ConvGameplay.updateAttrCondition(${i},'operator',this.value)" style="width:60px;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)">${['>','>=','<','<=','==','!='].map(op => `<option value="${op}" ${c.operator === op ? 'selected' : ''}>${op}</option>`).join('')}</select>
          <input type="number" value="${_esc(String(c.value ?? 0))}" oninput="ConvGameplay.updateAttrCondition(${i},'value',this.value)" style="flex:1;min-width:0;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)">
        </div>
      </div>`;
    }).join('');
    _attrCondDraft.forEach((c, i) => {
      if (!c.attrId && !c.attrName && opts[0]) updateAttrCondition(i, 'attr', opts[0].value, true);
    });
  }

  function addAttrCondition() {
    const opts = _collectAttrOptions();
    if (!opts.length) { UI.showToast('请先配置自定义属性', 1800); return; }
    const o = opts[0];
    _attrCondDraft.push({ scope: o.scope, targetKey: o.targetKey, targetName: o.targetName, attrId: o.attrId, attrName: o.attrName, operator: '>=', value: 0 });
    _renderAttrConditions();
  }

  function updateAttrCondition(i, field, value, silent) {
    const c = _attrCondDraft[i];
    if (!c) return;
    if (field === 'attr') {
      const o = _collectAttrOptions().find(x => x.value === value);
      if (!o) return;
      Object.assign(c, { scope: o.scope, targetKey: o.targetKey, targetName: o.targetName, attrId: o.attrId, attrName: o.attrName });
      if (o.scope === 'allCharacters') { c.matchMode = c.matchMode || 'all'; }
      else { delete c.matchMode; }
    } else if (field === 'value') {
      c.value = Number(value);
    } else if (field === 'operator') {
      c.operator = value || '>=';
    } else if (field === 'matchMode') {
      c.matchMode = value || 'all';
    }
    if (!silent && (field === 'attr' || field === 'matchMode')) _renderAttrConditions();
  }

  function removeAttrCondition(i) {
    _attrCondDraft.splice(i, 1);
    _renderAttrConditions();
  }

  function editEvent(i) {
    _editEventIdx = i;
    const ev = _eventsData[i] || {};
    // v687.33：先显示弹窗，再赋值（某些浏览器 hidden 状态下 select 赋值不生效）
    document.getElementById('cg-event-modal').classList.remove('hidden');
    document.getElementById('cg-event-modal-title').textContent = ev.name ? '编辑事件' : '新建事件';
    document.getElementById('cg-event-name').value = ev.name || '';
    document.getElementById('cg-event-keys').value = ev.keys || '';
    const typeEl = document.getElementById('cg-event-trigger-type');
    if (typeEl) {
      typeEl.value = ev.triggerType || 'keyword';
      // 双保险：强制 selectedIndex 对齐
      if (typeEl.value !== (ev.triggerType || 'keyword')) {
        typeEl.selectedIndex = 0; // keyword 是第一个 option
      }
    }
    _attrCondDraft = Array.isArray(ev.attrConditions) ? JSON.parse(JSON.stringify(ev.attrConditions)) : [];
    document.getElementById('cg-event-complete-key').value = ev.completeKey || '';
    document.getElementById('cg-event-finish-rule').value = ev.finishRule || '';
    document.getElementById('cg-event-content').value = ev.content || '';
    _syncTriggerTypeUI();
  }

  function addEvent() {
    _eventsData.push({
      id: 'evt_' + Utils.uuid().slice(0, 8),
      name: '', keys: '', triggerType: 'keyword', attrConditions: [],
      completeKey: '', finishRule: '', content: '', triggerMode: 'event'
    });
    editEvent(_eventsData.length - 1);
  }

  async function saveEvent() {
    if (_editEventIdx === null) return;
    const prev = _eventsData[_editEventIdx] || {};
    const triggerType = document.getElementById('cg-event-trigger-type')?.value || 'keyword';
    _eventsData[_editEventIdx] = {
      id: prev.id || ('evt_' + Utils.uuid().slice(0, 8)),
      name: document.getElementById('cg-event-name').value.trim(),
      keys: triggerType === 'keyword' ? document.getElementById('cg-event-keys').value.trim() : '',
      triggerType,
      attrConditions: triggerType === 'attr' ? _attrCondDraft.filter(c => c && c.attrId && Number.isFinite(Number(c.value))).map(c => ({ ...c, value: Number(c.value), operator: c.operator || '>=' })) : [],
      completeKey: document.getElementById('cg-event-complete-key').value.trim(),
      finishRule: (document.getElementById('cg-event-finish-rule')?.value || '').trim(),
      content: document.getElementById('cg-event-content').value.trim(),
      triggerMode: 'event'
    };
    await _saveConvEvents(_eventsData);
    _renderEventList();
    closeEventModal();
  }

  async function deleteEvent() {
    if (_editEventIdx === null) return;
    if (!await UI.showConfirm('删除事件', `确定删除「${_eventsData[_editEventIdx]?.name || '未命名'}」？`)) return;
    _eventsData.splice(_editEventIdx, 1);
    await _saveConvEvents(_eventsData);
    _renderEventList();
    closeEventModal();
  }

  function closeEventModal() {
    _editEventIdx = null;
    document.getElementById('cg-event-modal')?.classList.add('hidden');
  }

  // ========== AI 生成事件 ==========

  let _aiAbort = null;

  function openAiGenerate() {
    document.getElementById('cg-ai-gen-overlay')?.remove();
    const html = `
    <div id="cg-ai-gen-overlay" style="position:fixed;inset:0;z-index:210;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)this.remove()">
      <div style="background:var(--bg);border-radius:16px;padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto" onclick="event.stopPropagation()">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成事件</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="cg-ai-gen-prompt" rows="3" placeholder="例如：生成几个日常生活事件和一个主线危机事件" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:12px;margin-top:12px">
          <div style="flex:1">
            <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成数量</label>
            <input type="number" id="cg-ai-gen-count" value="5" min="1" max="20" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box">
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('cg-ai-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="cg-ai-gen-btn" onclick="ConvGameplay.doAiGenerate()" style="padding:8px 14px;border:none;border-radius:8px;background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="cg-ai-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  async function doAiGenerate() {
    const btn = document.getElementById('cg-ai-gen-btn');
    const status = document.getElementById('cg-ai-gen-status');
    const prompt = document.getElementById('cg-ai-gen-prompt')?.value?.trim() || '';
    const count = Math.max(1, Math.min(20, parseInt(document.getElementById('cg-ai-gen-count')?.value) || 5));

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = `正在生成 ${count} 个事件…`; }

    // 获取世界观上下文
    const conv = _getConv();
    const wvId = conv?.singleWorldviewId || conv?.worldviewId || '';
    let settingText = '', regionNames = [];
    try {
      const wv = wvId ? await DB.get('worldviews', wvId) : null;
      settingText = wv?.setting || '';
      regionNames = (wv?.regions || []).map(r => r.name).filter(Boolean);
    } catch(_) {}
    const existingEvents = _eventsData.map(e => e.name).filter(Boolean);

    const sysPrompt = `你是一个文字冒险游戏的事件设计师。请根据世界观设定，生成游戏内的剧情事件。

每个事件需要包含：
- name：事件名称（简短有力）
- keys：触发关键词（2-4个，逗号分隔，是玩家在对话中可能提到的词）
- completeKey：结束关键词（格式为 __EVENT_COMPLETE_事件名缩写__，AI回复中出现此词表示事件结束）
- finishRule：事件结束条件（1-2句话描述什么情况下事件算结束）
- content：事件内容（触发后每轮注入给AI的剧情指令，100-300字，写给AI看的指令，不是写给玩家看的）。content 只写事件背景、场景氛围、环境细节、剧情走向和可能的发展方向。**不要写任何角色的具体行为、动作、语气、情感反应**——角色有自己的人设，具体怎么行动由AI根据角色人设自行判断。content 的定位是"舞台布景"，不是"剧本台词"。

要求：
- 事件之间有剧情关联性，可以形成事件链
- 触发关键词要自然，是玩家在探索中容易提到的词
- content 只描述场景和情境，不预设任何角色的反应方式
- 不要和已有事件重复

输出纯JSON数组，不要其他内容。`;

    const userMsg = `${prompt ? '用户需求：' + prompt + '\n\n' : ''}请生成 ${count} 个事件。

## 世界观设定
${settingText || '（未提供）'}

${regionNames.length ? '## 地区\n' + regionNames.join('、') : ''}

${existingEvents.length ? '## 已有事件（不要重复）\n' + existingEvents.join('、') : ''}`;

    try {
      _aiAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiAbort.signal, maxTokens: 8000 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const arr = JSON.parse(cleaned);
      if (!Array.isArray(arr) || arr.length === 0) throw new Error('AI 返回的不是有效数组');

      let added = 0;
      for (const item of arr) {
        if (!item.name) continue;
        _eventsData.push({
          id: 'evt_' + Utils.uuid().slice(0, 8),
          name: item.name || '', keys: item.keys || '', triggerType: 'keyword',
          attrConditions: [], completeKey: item.completeKey || '',
          finishRule: item.finishRule || '', content: item.content || '', triggerMode: 'event'
        });
        added++;
      }
      await _saveConvEvents(_eventsData);
      _renderEventList();
      document.getElementById('cg-ai-gen-overlay')?.remove();
      UI.showToast(`已生成 ${added} 个事件`, 2000);
    } catch(e) {
      if (e.name === 'AbortError') { if (status) status.textContent = '已取消'; return; }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally { _aiAbort = null; }
  }

  // ========== 主面板入口 ==========

  async function openEventEditor() {
    const conv = await _ensureConvEvents();
    if (!conv) return;
    _eventsData = conv.convEvents || [];

    // 关闭对话设置弹窗
    document.getElementById('conv-settings-modal')?.classList.add('hidden');

    // 创建全屏面板
    document.getElementById('cg-event-panel')?.remove();
    const panel = document.createElement('div');
    panel.id = 'cg-event-panel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:180;background:var(--bg);display:flex;flex-direction:column;overflow:hidden';
    panel.innerHTML = `
      <div style="padding:16px 16px 0;flex-shrink:0">
        <button onclick="ConvGameplay.closeEventEditor()" style="width:fit-content;padding:8px 12px;display:flex;align-items:center;background:none;border:none;color:var(--text);cursor:pointer;margin-bottom:12px">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <div style="margin-bottom:12px">
          <div style="font-size:18px;font-weight:700;color:var(--text)">事件配置（对话级）</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">修改只影响当前对话，不影响世界观原件</div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <button onclick="ConvGameplay.openAiGenerate()" style="padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI生成</button>
          <button onclick="ConvGameplay.addEvent()" style="padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer">+ 添加</button>
        </div>
      </div>
      <div id="cg-event-list" style="flex:1;overflow-y:auto;padding:0 16px 16px"></div>
    `;
    document.body.appendChild(panel);
    _renderEventList();
    _ensureEventModal();
  }

  function closeEventEditor() {
    document.getElementById('cg-event-panel')?.remove();
  }

  // 确保编辑弹窗 DOM 存在
  function _ensureEventModal() {
    if (document.getElementById('cg-event-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'cg-event-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
    <div class="modal-content" style="max-height:80vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 id="cg-event-modal-title">编辑事件</h3>
        <button class="btn-icon" onclick="ConvGameplay.deleteEvent()" style="width:32px;height:32px;padding:4px;color:var(--danger)">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
      <div class="form-group"><span class="form-label">事件名称</span><input type="text" id="cg-event-name" placeholder="如：深蓝教会袭击"></div>
      <div class="form-group"><span class="form-label">触发方式</span><select id="cg-event-trigger-type" onchange="ConvGameplay._syncTriggerTypeUI()" style="width:100%;box-sizing:border-box"><option value="keyword">关键词触发</option><option value="attr">数值触发</option></select></div>
      <div class="form-group" id="cg-event-keyword-row"><span class="form-label">触发关键词 <span style="font-size:11px;color:var(--text-secondary)">（多个用逗号或空格分隔）</span></span><input type="text" id="cg-event-keys" placeholder="如：深蓝教会, 深蓝, 阿司霍尔"></div>
      <div class="form-group hidden" id="cg-event-attr-row"><span class="form-label">数值触发条件 <span style="font-size:11px;color:var(--text-secondary)">（全部满足才触发）</span></span><div id="cg-event-attr-conditions" style="display:flex;flex-direction:column;gap:8px"></div><button type="button" onclick="ConvGameplay.addAttrCondition()" style="width:100%;margin-top:8px;padding:8px 10px;background:none;border:1px dashed var(--border);border-radius:8px;color:var(--accent);cursor:pointer;font-size:12px">+ 添加条件</button></div>
      <div class="form-group"><span class="form-label">结束关键词 <span style="font-size:11px;color:var(--text-secondary)">（AI 回复中出现此词后事件自动关闭）</span></span><input type="text" id="cg-event-complete-key" placeholder="如：__EVENT_COMPLETE_深蓝袭击__"></div>
      <div class="form-group"><span class="form-label">如何判断事件结束 <span style="font-size:11px;color:var(--text-secondary)">（满足后 AI 应输出结束关键词）</span></span><textarea id="cg-event-finish-rule" rows="3" placeholder="如：当袭击者撤退、现场危机解除、主要角色确认安全后，视为事件结束。"></textarea></div>
      <div class="form-group"><span class="form-label">事件内容 <span style="font-size:11px;color:var(--text-secondary)">（触发后每轮注入，直到结束）</span></span><textarea id="cg-event-content" rows="8" placeholder="事件剧情引导、场景氛围、环境细节、可能的发展方向…"></textarea></div>
      <div class="modal-actions" style="flex-shrink:0;margin-top:12px">
        <button onclick="ConvGameplay.closeEventModal()" style="flex:1;background:none;border:1px solid var(--border);color:var(--text-secondary)">取消</button>
        <button onclick="ConvGameplay.saveEvent()" style="flex:1">保存</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
  }

  // ========== 对话级属性编辑器 ==========

  async function _ensureConvGameplay() {
    const conv = _getConv();
    if (!conv) return null;
    if (!conv.convGameplay) {
      const wvId = conv.singleWorldviewId || conv.worldviewId || '';
      const wv = (wvId && wvId !== '__default_wv__') ? await DB.get('worldviews', wvId) : null;
      const hasGp = wv && wv.gameplay && (
        (wv.gameplay.globalAttrs && wv.gameplay.globalAttrs.length) ||
        (wv.gameplay.characterAttrs && wv.gameplay.characterAttrs.length)
      );
      const msg = hasGp
        ? '将从世界观复制属性配置到当前对话。\n之后修改只影响本对话，不影响世界观原件。\n继续？'
        : '当前世界观无属性配置，将为本对话创建空白属性配置。\n继续？';
      if (!await UI.showConfirm('创建对话级属性配置', msg)) return null;
      conv.convGameplay = hasGp
        ? JSON.parse(JSON.stringify(wv.gameplay))
        : { globalAttrs: [], characterAttrs: [], taskSystem: { phases: [] } };
      await Conversations.saveList();
    }
    return conv;
  }

  async function _saveConvGameplay(gp) {
    const conv = _getConv();
    if (!conv) return;
    conv.convGameplay = gp;
    await Conversations.saveList();
  }

  // ----- 属性行渲染 -----
  function _renderConvAttrRows(attrs, scope, charIdx) {
    if (!attrs || !attrs.length) {
      return '<div style="padding:12px;color:var(--text-secondary);font-size:12px;text-align:center;border:1px dashed var(--border);border-radius:8px">暂无属性</div>';
    }
    return attrs.map((a, i) => {
      const name = (a.name || '').trim() || '未命名属性';
      const maxText = (a.max === '' || a.max === null || a.max === undefined) ? '无上限' : `最大 ${a.max}`;
      const summary = `初始 ${a.initial ?? 0} / ${maxText}`;
      return `<div onclick="ConvGameplay.openAttrModal('${scope}', ${charIdx}, ${i})" style="display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;background:var(--bg-secondary);border:1px solid color-mix(in srgb, var(--border) 55%, transparent);cursor:pointer">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(name)}</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(summary)}</div>
        </div>
        <div style="color:var(--text-secondary);font-size:18px;line-height:1;opacity:.65">›</div>
      </div>`;
    }).join('');
  }

  let _cgAttrGp = null; // 当前编辑的 gameplay 引用

  function _renderConvAttrs() {
    const globalEl = document.getElementById('cg-global-attrs');
    const charEl = document.getElementById('cg-char-attrs');
    if (!_cgAttrGp) return;
    const gp = _cgAttrGp;

    if (globalEl) {
      globalEl.innerHTML = `
        <div style="padding:2px 0 10px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text)">用户 / 全局属性</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">通用于当前对话，可添加多条。</div>
            </div>
            <button type="button" onclick="ConvGameplay.openAttrModal('global', -1, -1)" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer">+ 添加属性</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:10px">${_renderConvAttrRows(gp.globalAttrs, 'global', -1)}</div>
        </div>`;
    }

    if (charEl) {
      const cards = (gp.characterAttrs || []).map((c, idx) => `
        <div style="padding:2px 0 10px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
            <div style="min-width:0">
              <div style="font-size:14px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.targetName || '未命名角色')}</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.sourceLabel || '')}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button type="button" onclick="ConvGameplay.openAttrModal('character', ${idx}, -1)" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer">+ 属性</button>
              <button type="button" onclick="ConvGameplay.deleteCharCard(${idx})" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--danger);font-size:12px;cursor:pointer">移除</button>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:10px">${_renderConvAttrRows(c.attrs || [], 'character', idx)}</div>
        </div>
      `).join('');

      charEl.innerHTML = `
        <div style="padding:2px 0 10px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text)">角色属性</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">先选择角色，再为该角色添加属性。</div>
            </div>
            <button type="button" onclick="ConvGameplay.toggleCharPicker()" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0">+ 角色</button>
          </div>
          <div id="cg-char-picker" class="hidden" style="margin-bottom:12px;border:1px solid var(--border);border-radius:10px;padding:10px;background:var(--bg-secondary)">
            <input id="cg-char-search" placeholder="搜索角色 / 别名 / 世界观" oninput="ConvGameplay.renderCharPicker(this.value)" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;margin-bottom:8px">
            <div id="cg-char-list" style="max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:6px"></div>
          </div>
          <div style="display:flex;flex-direction:column;gap:12px">${cards || '<div style="padding:12px;color:var(--text-secondary);font-size:12px;text-align:center;border:1px dashed var(--border);border-radius:8px">暂无角色属性卡片</div>'}</div>
        </div>`;
    }
  }

  // ----- 角色选择器 -----
  let _charPickerCache = [];

  async function _collectChars() {
    const out = [];
    try {
      const cards = await SingleCard.getAll();
      cards.forEach(c => out.push({ targetType: 'singleCard', targetId: c.id, sourceWorldviewId: '', targetName: c.name || '未命名角色', aliases: c.aliases || '', sourceLabel: '单人卡', avatar: c.avatar || '' }));
    } catch(_) {}
    try {
      const allWvs = await DB.getAll('worldviews');
      const avatarsArr = await DB.getAll('npcAvatars');
      const avatarMap = {}; avatarsArr.forEach(a => { avatarMap[a.id] = a.avatar || ''; });
      allWvs.forEach(wv => {
        if (!wv || wv.id === '__default_wv__' || wv._hidden) return;
        (wv.globalNpcs || []).forEach(n => out.push({ targetType: 'worldviewNpc', targetId: n.id, sourceWorldviewId: wv.id, targetName: n.name || '未命名', aliases: n.aliases || '', sourceLabel: `世界观：${wv.name || '未命名世界观'} / 全图常驻`, avatar: avatarMap[n.id] || n.avatar || '' }));
        (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(n => out.push({ targetType: 'worldviewNpc', targetId: n.id, sourceWorldviewId: wv.id, targetName: n.name || '未命名', aliases: n.aliases || '', sourceLabel: `世界观：${wv.name || '未命名世界观'} / ${r.name || '未命名地区'} / ${f.name || '未命名势力'}`, avatar: avatarMap[n.id] || n.avatar || '' }))));
      });
    } catch(_) {}
    return out;
  }

  function _attrTargetKey(t) {
    return [t?.targetType || '', t?.targetId || '', t?.sourceWorldviewId || ''].join(':');
  }

  async function toggleCharPicker() {
    const box = document.getElementById('cg-char-picker');
    if (!box) return;
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) {
      const input = document.getElementById('cg-char-search');
      if (input) input.value = '';
      await renderCharPicker('');
      setTimeout(() => input?.focus(), 50);
    }
  }

  async function renderCharPicker(query) {
    const listEl = document.getElementById('cg-char-list');
    if (!listEl) return;
    const q = String(query || '').toLowerCase().trim();
    const chars = await _collectChars();
    const filtered = q ? chars.filter(c => [c.targetName, c.aliases, c.sourceLabel].some(v => String(v || '').toLowerCase().includes(q))) : chars;
    if (!filtered.length) {
      listEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-secondary);font-size:12px">${q ? '没有匹配的角色' : '暂无可选角色'}</div>`;
      return;
    }
    listEl.innerHTML = filtered.map((c, i) => `
      <div onclick="ConvGameplay.selectChar(${i})" style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);cursor:pointer">
        <div style="width:34px;height:34px;border-radius:50%;overflow:hidden;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0">${c.avatar ? `<img src="${_esc(c.avatar)}" style="width:100%;height:100%;object-fit:cover">` : _esc((c.targetName || '?').slice(0,1))}</div>
        <div style="min-width:0;flex:1">
          <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.targetName || '未命名')}${c.aliases ? `<span style="font-size:11px;color:var(--text-secondary)"> · ${_esc(c.aliases)}</span>` : ''}</div>
          <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.sourceLabel || '')}</div>
        </div>
      </div>
    `).join('');
    _charPickerCache = filtered;
  }

  async function selectChar(idx) {
    const c = _charPickerCache[idx];
    if (!c || !_cgAttrGp) return;
    const gp = _cgAttrGp;
    if (!gp.characterAttrs) gp.characterAttrs = [];
    const key = _attrTargetKey({ targetType: c.targetType, targetId: c.targetId, sourceWorldviewId: c.sourceWorldviewId });
    if (gp.characterAttrs.some(x => _attrTargetKey(x) === key)) {
      UI.showToast('这个角色已经有属性卡片了', 2000);
      return;
    }
    gp.characterAttrs.push({ targetType: c.targetType, targetId: c.targetId, targetName: c.targetName, sourceWorldviewId: c.sourceWorldviewId || '', sourceLabel: c.sourceLabel || '', attrs: [] });
    await _saveConvGameplay(gp);
    _renderConvAttrs();
    document.getElementById('cg-char-picker')?.classList.add('hidden');
  }

  async function deleteCharCard(idx) {
    if (!_cgAttrGp) return;
    const ok = await UI.showConfirm('移除角色属性', '只会移除此角色的属性配置，不会删除角色本身。确定移除吗？');
    if (!ok) return;
    _cgAttrGp.characterAttrs.splice(idx, 1);
    await _saveConvGameplay(_cgAttrGp);
    _renderConvAttrs();
  }

  // ----- 属性弹窗 -----
  let _attrCtx = null; // { scope, charIdx, attrIdx, isNew }

  function _defaultAttr() {
    return { id: 'attr_' + Utils.uuid().slice(0, 8), name: '', initial: 0, max: '', desc: '' };
  }

  function _ensureAttrModal() {
    if (document.getElementById('cg-attr-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'cg-attr-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
    <div class="modal-content" style="max-height:90vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0">
        <h3 id="cg-attr-modal-title" style="margin:0;font-size:16px;color:var(--accent)">编辑属性</h3>
        <button onclick="ConvGameplay.closeAttrModal()" style="background:none;border:none;color:var(--text-secondary);font-size:20px;cursor:pointer">×</button>
      </div>
      <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:4px">
        <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">属性名称
          <input id="cg-attr-name" placeholder="例如：饱食度" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none;box-shadow:none">
        </label>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px">
          <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text);min-width:0">初始值
            <input id="cg-attr-initial" type="number" placeholder="0" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;min-width:0;outline:none;box-shadow:none">
          </label>
          <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text);min-width:0">最大值
            <input id="cg-attr-max" type="number" placeholder="留空=无上限" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;min-width:0;outline:none;box-shadow:none">
          </label>
        </div>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">属性描述
          <textarea id="cg-attr-desc" placeholder="让 AI 知道这个数值意味着什么" style="width:100%;box-sizing:border-box;min-height:110px;resize:vertical;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;line-height:1.5;outline:none;box-shadow:none"></textarea>
        </label>
        <div style="font-size:11px;color:var(--text-secondary);line-height:1.5">最大值留空表示无上限。这里保存的是属性定义，当前值存在对话状态栏中。</div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:14px;flex-shrink:0">
        <button id="cg-attr-delete-btn" onclick="ConvGameplay.deleteAttrFromModal()" style="padding:9px 12px;border-radius:8px;border:1px solid color-mix(in srgb, var(--danger) 55%, var(--border));background:none;color:var(--danger);font-size:13px;cursor:pointer">删除</button>
        <div style="display:flex;gap:8px">
          <button onclick="ConvGameplay.closeAttrModal()" style="padding:9px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button onclick="ConvGameplay.saveAttrFromModal()" style="padding:9px 14px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">保存</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(modal);
  }

  function openAttrModal(scope, charIdx, attrIdx) {
    if (!_cgAttrGp) return;
    const gp = _cgAttrGp;
    const list = scope === 'global' ? (gp.globalAttrs || []) : (gp.characterAttrs[charIdx]?.attrs || []);
    const isNew = attrIdx < 0;
    const attr = isNew ? _defaultAttr() : list[attrIdx];
    if (!attr) return;
    _attrCtx = { scope, charIdx, attrIdx, isNew };
    _ensureAttrModal();
    const title = document.getElementById('cg-attr-modal-title');
    if (title) title.textContent = isNew ? (scope === 'global' ? '新增全局属性' : '新增角色属性') : '编辑属性';
    const delBtn = document.getElementById('cg-attr-delete-btn');
    if (delBtn) delBtn.style.visibility = isNew ? 'hidden' : 'visible';
    document.getElementById('cg-attr-name').value = attr.name || '';
    document.getElementById('cg-attr-initial').value = attr.initial ?? 0;
    document.getElementById('cg-attr-max').value = attr.max ?? '';
    document.getElementById('cg-attr-desc').value = attr.desc || '';
    document.getElementById('cg-attr-modal')?.classList.remove('hidden');
    setTimeout(() => document.getElementById('cg-attr-name')?.focus(), 80);
  }

  function closeAttrModal() {
    _attrCtx = null;
    document.getElementById('cg-attr-modal')?.classList.add('hidden');
  }

  async function saveAttrFromModal() {
    if (!_attrCtx || !_cgAttrGp) return;
    const gp = _cgAttrGp;
    // v681 修复：保底初始化字段，避免 (gp.globalAttrs || []) 生成临时空数组导致 push 丢失
    if (_attrCtx.scope === 'global') {
      if (!Array.isArray(gp.globalAttrs)) gp.globalAttrs = [];
    } else {
      if (!Array.isArray(gp.characterAttrs)) gp.characterAttrs = [];
      if (!gp.characterAttrs[_attrCtx.charIdx]) { UI.showToast('角色卡片不存在', 1800); return; }
      if (!Array.isArray(gp.characterAttrs[_attrCtx.charIdx].attrs)) gp.characterAttrs[_attrCtx.charIdx].attrs = [];
    }
    const list = _attrCtx.scope === 'global' ? gp.globalAttrs : gp.characterAttrs[_attrCtx.charIdx].attrs;
    const name = (document.getElementById('cg-attr-name')?.value || '').trim();
    if (!name) { UI.showToast('请填写属性名称', 1800); return; }
    if (list.some((x, i) => i !== _attrCtx.attrIdx && String(x.name || '').trim() === name)) {
      UI.showToast(_attrCtx.scope === 'global' ? '全局属性名称不能重复' : '同一角色的属性名称不能重复', 1800);
      return;
    }
    const attr = _attrCtx.isNew ? _defaultAttr() : list[_attrCtx.attrIdx];
    if (!attr) return;
    attr.name = name;
    attr.desc = document.getElementById('cg-attr-desc')?.value || '';
    const maxVal = document.getElementById('cg-attr-max')?.value || '';
    const initVal = document.getElementById('cg-attr-initial')?.value || '';
    attr.max = maxVal === '' ? '' : Number(maxVal);
    attr.initial = initVal === '' ? 0 : Number(initVal);
    if (_attrCtx.isNew) list.push(attr);
    await _saveConvGameplay(gp);
    closeAttrModal();
    _renderConvAttrs();
    StatusBar.refreshFromConv();
  }

  async function deleteAttrFromModal() {
    if (!_attrCtx || _attrCtx.isNew) return;
    const gp = _cgAttrGp;
    const list = _attrCtx.scope === 'global' ? (gp.globalAttrs || []) : (gp.characterAttrs[_attrCtx.charIdx]?.attrs || []);
    list.splice(_attrCtx.attrIdx, 1);
    await _saveConvGameplay(gp);
    closeAttrModal();
    _renderConvAttrs();
    StatusBar.refreshFromConv();
  }

  // ----- 属性面板入口 -----
  async function openAttrEditor() {
    try {
      const conv = await _ensureConvGameplay();
      if (!conv) return;
      _cgAttrGp = conv.convGameplay;
      // v681 修复：旧对话或异常路径创建的 convGameplay 可能缺字段，进编辑器就保底一次
      if (!Array.isArray(_cgAttrGp.globalAttrs)) _cgAttrGp.globalAttrs = [];
      if (!Array.isArray(_cgAttrGp.characterAttrs)) _cgAttrGp.characterAttrs = [];

      document.getElementById('conv-settings-modal')?.classList.add('hidden');
      document.getElementById('cg-attr-panel')?.remove();

      const panel = document.createElement('div');
      panel.id = 'cg-attr-panel';
      panel.style.cssText = 'position:fixed;inset:0;z-index:180;background:var(--bg);display:flex;flex-direction:column;overflow:hidden';
      panel.innerHTML = `
        <div style="padding:16px 16px 0;flex-shrink:0">
          <button onclick="ConvGameplay.closeAttrEditor()" style="width:fit-content;padding:8px 12px;display:flex;align-items:center;background:none;border:none;color:var(--text);cursor:pointer;margin-bottom:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <div style="margin-bottom:16px">
            <div style="font-size:18px;font-weight:700;color:var(--text)">属性配置（对话级）</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">修改只影响当前对话，不影响世界观原件</div>
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;padding:0 16px 16px">
          <div id="cg-global-attrs"></div>
          <div id="cg-char-attrs" style="margin-top:16px"></div>
        </div>
      `;
      document.body.appendChild(panel);
      _renderConvAttrs();
    } catch(e) {
      console.error('[ConvGameplay.openAttrEditor]', e);
      UI.showToast('打开失败：' + (e.message || e), 3000);
    }
  }

  function closeAttrEditor() {
    _cgAttrGp = null;
    document.getElementById('cg-attr-panel')?.remove();
  }

  // ========== 对话级任务系统编辑器 ==========

  let _cgTaskTs = null; // 当前编辑的 taskSystem 引用

  function _defaultTaskPhase() {
    return {
      id: 'phase_' + Utils.uuid().slice(0, 8),
      name: '',
      batchSize: 3,
      totalTasks: 10,
      types: [],
      completionReward: { mode: 'none', attr: '', value: 0, free: '' }
    };
  }

  function _defaultTaskType() {
    return {
      id: 'tt_' + Utils.uuid().slice(0, 8),
      label: '',
      desc: '',
      rewardMode: 'none',
      rewardAttr: '',
      rewardValue: 0,
      rewardFree: ''
    };
  }

  function _getConvGlobalAttrNames() {
    const gp = _cgAttrGp || _getConv()?.convGameplay;
    return (gp?.globalAttrs || []).map(a => a.name).filter(Boolean);
  }

  function _renderTaskSystem() {
    const el = document.getElementById('cg-task-container');
    if (!el || !_cgTaskTs) return;
    const phases = _cgTaskTs.phases || [];

    if (phases.length === 0) {
      el.innerHTML = `
        <div style="text-align:center;padding:20px;border:1px dashed var(--border);border-radius:8px">
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">尚未配置任务阶段</div>
          <button type="button" onclick="ConvGameplay.addTaskPhase()" style="padding:7px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer">+ 添加阶段</button>
        </div>`;
      return;
    }

    let html = '';
    phases.forEach((phase, pi) => {
      const typeCards = (phase.types || []).map((t, ti) => {
        let rewardTag = '';
        if (t.rewardMode === 'attr' && t.rewardAttr) rewardTag = `<span style="font-size:11px;color:var(--accent);background:color-mix(in srgb, var(--accent) 15%, transparent);padding:1px 6px;border-radius:4px">${_esc(t.rewardAttr)} ${t.rewardValue >= 0 ? '+' : ''}${t.rewardValue || 0}</span>`;
        else if (t.rewardMode === 'free') rewardTag = `<span style="font-size:11px;color:var(--accent);background:color-mix(in srgb, var(--accent) 15%, transparent);padding:1px 6px;border-radius:4px">自由奖励</span>`;
        return `
        <div onclick="ConvGameplay.openTaskTypeModal(${pi},${ti})" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;cursor:pointer">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(t.label || '未命名类型')}</div>
            ${t.desc ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(t.desc)}</div>` : ''}
          </div>
          ${rewardTag}
          <div style="color:var(--text-secondary);font-size:18px;line-height:1;opacity:.65;flex-shrink:0">›</div>
        </div>`;
      }).join('');

      const cr = phase.completionReward || { mode: 'none' };
      let crSummary = '无';
      if (cr.mode === 'attr' && cr.attr) crSummary = `${cr.attr} ${cr.value >= 0 ? '+' : ''}${cr.value || 0}`;
      else if (cr.mode === 'free') crSummary = '自由奖励';

      html += `
      <div style="background:var(--bg-tertiary);padding:12px;border-radius:10px;border:1px solid var(--border);margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
            <div style="font-size:14px;font-weight:700;color:var(--accent);flex-shrink:0">阶段 ${pi + 1}</div>
            <input value="${_esc(phase.name || '')}" placeholder="阶段名称（可选）" onchange="ConvGameplay.updateTaskPhase(${pi},'name',this.value)" style="flex:1;min-width:0;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:12px">
          </div>
          <button type="button" onclick="ConvGameplay.deleteTaskPhase(${pi})" style="padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--danger);font-size:11px;cursor:pointer;flex-shrink:0">删除</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <label style="flex:1;font-size:12px;color:var(--text-secondary)">每批最多
            <input type="number" min="1" max="5" value="${phase.batchSize || 3}" onchange="ConvGameplay.updateTaskPhase(${pi},'batchSize',Number(this.value))" style="width:100%;margin-top:4px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:12px;box-sizing:border-box">
          </label>
          <label style="flex:1;font-size:12px;color:var(--text-secondary)">本阶段总任务数
            <input type="number" min="1" max="999" value="${phase.totalTasks || 10}" onchange="ConvGameplay.updateTaskPhase(${pi},'totalTasks',Number(this.value))" style="width:100%;margin-top:4px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:12px;box-sizing:border-box">
          </label>
        </div>
        <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">任务类型模板</div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">${typeCards || '<div style="padding:10px;color:var(--text-secondary);font-size:12px;text-align:center;border:1px dashed var(--border);border-radius:6px">暂无类型，点击下方添加</div>'}</div>
        <button type="button" onclick="ConvGameplay.openTaskTypeModal(${pi},-1)" style="width:100%;padding:6px;border-radius:6px;border:1px dashed var(--border);background:none;color:var(--accent);font-size:12px;cursor:pointer;margin-bottom:10px">+ 添加任务类型</button>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">阶段完成奖励：</span>
          <span style="font-size:12px;color:var(--text-secondary)">${_esc(crSummary)}</span>
          <button type="button" onclick="ConvGameplay.openPhaseRewardModal(${pi})" style="padding:2px 8px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--accent);font-size:11px;cursor:pointer;margin-left:auto">编辑</button>
        </div>
      </div>`;
    });

    html += `<button type="button" onclick="ConvGameplay.addTaskPhase()" style="width:100%;padding:8px;border-radius:8px;border:1px dashed var(--border);background:none;color:var(--accent);font-size:13px;cursor:pointer">+ 添加新阶段</button>`;
    el.innerHTML = html;
  }

  async function _saveTaskSystem() {
    if (!_cgAttrGp) return;
    _cgAttrGp.taskSystem = _cgTaskTs;
    await _saveConvGameplay(_cgAttrGp);
  }

  async function addTaskPhase() {
    if (!_cgTaskTs) return;
    if (!_cgTaskTs.phases) _cgTaskTs.phases = [];
    _cgTaskTs.phases.push(_defaultTaskPhase());
    await _saveTaskSystem();
    _renderTaskSystem();
  }

  async function deleteTaskPhase(pi) {
    if (!_cgTaskTs) return;
    if (!await UI.showConfirm('删除阶段', `确定删除阶段 ${pi + 1}？`)) return;
    _cgTaskTs.phases.splice(pi, 1);
    await _saveTaskSystem();
    _renderTaskSystem();
  }

  async function updateTaskPhase(pi, field, value) {
    if (!_cgTaskTs) return;
    const phase = _cgTaskTs.phases[pi];
    if (!phase) return;
    if (field === 'batchSize') value = Math.max(1, Math.min(5, value || 3));
    if (field === 'totalTasks') value = Math.max(1, Math.min(999, value || 10));
    phase[field] = value;
    await _saveTaskSystem();
  }

  // ----- 任务类型弹窗 -----
  let _ttPhaseIdx = -1;
  let _ttTypeIdx = -1; // -1=新建, -999=阶段奖励模式

  function _ensureTaskTypeModal() {
    if (document.getElementById('cg-task-type-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'cg-task-type-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
    <div class="modal-content" style="max-height:90vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0">
        <h3 id="cg-tt-title" style="margin:0;font-size:16px;color:var(--accent)">编辑任务类型</h3>
        <button onclick="ConvGameplay.closeTaskTypeModal()" style="background:none;border:none;color:var(--text-secondary);font-size:20px;cursor:pointer">×</button>
      </div>
      <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:4px">
        <label id="cg-tt-label-row" style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">类型名称
          <input id="cg-tt-label" placeholder="例如：唱歌练习" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none">
        </label>
        <label id="cg-tt-desc-row" style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">类型描述
          <textarea id="cg-tt-desc" placeholder="告诉 AI 任务的含义、发布时机、频率等" rows="3" style="width:100%;box-sizing:border-box;min-height:70px;resize:vertical;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;line-height:1.5;outline:none"></textarea>
        </label>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">奖励类型
          <select id="cg-tt-reward-mode" onchange="ConvGameplay.onTaskRewardModeChange()" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none">
            <option value="none">无奖励</option>
            <option value="attr">属性奖励（数值）</option>
            <option value="free">自由奖励（描述）</option>
          </select>
        </label>
        <div id="cg-tt-reward-attr-row" style="display:none;flex-direction:column;gap:6px">
          <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">关联属性
            <select id="cg-tt-reward-attr" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none"></select>
          </label>
          <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">数值变化（正数=加，负数=减）
            <input id="cg-tt-reward-value" type="number" placeholder="例如：+5" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none">
          </label>
        </div>
        <label id="cg-tt-reward-free-row" style="display:none;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">自由奖励描述
          <textarea id="cg-tt-reward-free" rows="2" placeholder="例如：解锁新的对话选项 / 获得一件道具" style="width:100%;box-sizing:border-box;min-height:60px;resize:vertical;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none"></textarea>
        </label>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:14px;flex-shrink:0">
        <button id="cg-tt-delete-btn" onclick="ConvGameplay.deleteTaskTypeFromModal()" style="padding:9px 12px;border-radius:8px;border:1px solid color-mix(in srgb, var(--danger) 55%, var(--border));background:none;color:var(--danger);font-size:13px;cursor:pointer">删除</button>
        <div style="display:flex;gap:8px">
          <button onclick="ConvGameplay.closeTaskTypeModal()" style="padding:9px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button onclick="ConvGameplay.saveTaskTypeFromModal()" style="padding:9px 14px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">保存</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(modal);
  }

  function onTaskRewardModeChange() {
    const mode = document.getElementById('cg-tt-reward-mode')?.value;
    const attrRow = document.getElementById('cg-tt-reward-attr-row');
    const freeRow = document.getElementById('cg-tt-reward-free-row');
    if (attrRow) attrRow.style.display = mode === 'attr' ? 'flex' : 'none';
    if (freeRow) freeRow.style.display = mode === 'free' ? 'flex' : 'none';
  }

  function openTaskTypeModal(pi, ti) {
    if (!_cgTaskTs) return;
    _ensureTaskTypeModal();
    _ttPhaseIdx = pi;
    _ttTypeIdx = ti;
    const phase = _cgTaskTs.phases[pi];
    if (!phase) return;
    const isNew = ti < 0;
    const t = isNew ? _defaultTaskType() : (phase.types?.[ti] || _defaultTaskType());

    document.getElementById('cg-tt-title').textContent = isNew ? '新建任务类型' : '编辑任务类型';
    document.getElementById('cg-tt-label').value = t.label || '';
    document.getElementById('cg-tt-label').disabled = false;
    document.getElementById('cg-tt-label-row').style.display = '';
    document.getElementById('cg-tt-desc').value = t.desc || '';
    document.getElementById('cg-tt-desc-row').style.display = '';
    document.getElementById('cg-tt-reward-mode').value = t.rewardMode || 'none';
    document.getElementById('cg-tt-reward-value').value = t.rewardValue || 0;
    document.getElementById('cg-tt-reward-free').value = t.rewardFree || '';
    document.getElementById('cg-tt-delete-btn').style.display = isNew ? 'none' : '';

    const attrSel = document.getElementById('cg-tt-reward-attr');
    const attrNames = _getConvGlobalAttrNames();
    attrSel.innerHTML = `<option value="">选择属性</option>` + attrNames.map(a => `<option value="${_esc(a)}" ${t.rewardAttr === a ? 'selected' : ''}>${_esc(a)}</option>`).join('');

    onTaskRewardModeChange();
    document.getElementById('cg-task-type-modal').classList.remove('hidden');
  }

  function openPhaseRewardModal(pi) {
    if (!_cgTaskTs) return;
    _ensureTaskTypeModal();
    const phase = _cgTaskTs.phases[pi];
    if (!phase) return;
    if (!phase.completionReward) phase.completionReward = { mode: 'none', attr: '', value: 0, free: '' };
    const cr = phase.completionReward;
    _ttPhaseIdx = pi;
    _ttTypeIdx = -999;

    document.getElementById('cg-tt-title').textContent = `阶段 ${pi + 1} 完成奖励`;
    document.getElementById('cg-tt-label-row').style.display = 'none';
    document.getElementById('cg-tt-desc-row').style.display = 'none';
    document.getElementById('cg-tt-reward-mode').value = cr.mode || 'none';
    document.getElementById('cg-tt-reward-value').value = cr.value || 0;
    document.getElementById('cg-tt-reward-free').value = cr.free || '';
    document.getElementById('cg-tt-delete-btn').style.display = 'none';

    const attrSel = document.getElementById('cg-tt-reward-attr');
    const attrNames = _getConvGlobalAttrNames();
    attrSel.innerHTML = `<option value="">选择属性</option>` + attrNames.map(a => `<option value="${_esc(a)}" ${cr.attr === a ? 'selected' : ''}>${_esc(a)}</option>`).join('');

    onTaskRewardModeChange();
    document.getElementById('cg-task-type-modal').classList.remove('hidden');
  }

  function closeTaskTypeModal() {
    const labelRow = document.getElementById('cg-tt-label-row');
    const descRow = document.getElementById('cg-tt-desc-row');
    if (labelRow) labelRow.style.display = '';
    if (descRow) descRow.style.display = '';
    document.getElementById('cg-task-type-modal')?.classList.add('hidden');
  }

  async function saveTaskTypeFromModal() {
    if (!_cgTaskTs) return;
    const phase = _cgTaskTs.phases[_ttPhaseIdx];
    if (!phase) return;
    const mode = document.getElementById('cg-tt-reward-mode').value;

    if (_ttTypeIdx === -999) {
      phase.completionReward = {
        mode,
        attr: mode === 'attr' ? document.getElementById('cg-tt-reward-attr').value : '',
        value: mode === 'attr' ? Number(document.getElementById('cg-tt-reward-value').value) || 0 : 0,
        free: mode === 'free' ? document.getElementById('cg-tt-reward-free').value.trim() : ''
      };
    } else {
      const label = document.getElementById('cg-tt-label').value.trim();
      if (!label) { UI.showToast('请填写类型名称', 1500); return; }
      if (!phase.types) phase.types = [];
      const data = {
        label,
        desc: document.getElementById('cg-tt-desc').value.trim(),
        rewardMode: mode,
        rewardAttr: mode === 'attr' ? document.getElementById('cg-tt-reward-attr').value : '',
        rewardValue: mode === 'attr' ? Number(document.getElementById('cg-tt-reward-value').value) || 0 : 0,
        rewardFree: mode === 'free' ? document.getElementById('cg-tt-reward-free').value.trim() : ''
      };
      if (_ttTypeIdx < 0) {
        data.id = 'tt_' + Utils.uuid().slice(0, 8);
        phase.types.push(data);
      } else {
        const existing = phase.types[_ttTypeIdx];
        if (existing) Object.assign(existing, data);
      }
    }

    await _saveTaskSystem();
    closeTaskTypeModal();
    _renderTaskSystem();
  }

  async function deleteTaskTypeFromModal() {
    if (!_cgTaskTs || _ttTypeIdx < 0) return;
    const phase = _cgTaskTs.phases[_ttPhaseIdx];
    if (!phase || !phase.types?.[_ttTypeIdx]) return;
    phase.types.splice(_ttTypeIdx, 1);
    await _saveTaskSystem();
    closeTaskTypeModal();
    _renderTaskSystem();
  }

  // ----- 任务面板入口 -----
  async function openTaskEditor() {
    try {
      const conv = await _ensureConvGameplay();
      if (!conv) return;
      _cgAttrGp = conv.convGameplay;
      if (!_cgAttrGp.taskSystem) _cgAttrGp.taskSystem = { phases: [] };
      if (!Array.isArray(_cgAttrGp.taskSystem.phases)) _cgAttrGp.taskSystem.phases = [];
      _cgTaskTs = _cgAttrGp.taskSystem;

      document.getElementById('conv-settings-modal')?.classList.add('hidden');
      document.getElementById('cg-task-panel')?.remove();

      const panel = document.createElement('div');
      panel.id = 'cg-task-panel';
      panel.style.cssText = 'position:fixed;inset:0;z-index:180;background:var(--bg);display:flex;flex-direction:column;overflow:hidden';
      panel.innerHTML = `
        <div style="padding:16px 16px 0;flex-shrink:0">
          <button onclick="ConvGameplay.closeTaskEditor()" style="width:fit-content;padding:8px 12px;display:flex;align-items:center;background:none;border:none;color:var(--text);cursor:pointer;margin-bottom:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <div style="margin-bottom:16px">
            <div style="font-size:18px;font-weight:700;color:var(--text)">任务系统配置（对话级）</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">修改只影响当前对话，不影响世界观原件</div>
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;padding:0 16px 16px">
          <div id="cg-task-container"></div>
        </div>
      `;
      document.body.appendChild(panel);
      _renderTaskSystem();
    } catch(e) {
      console.error('[ConvGameplay.openTaskEditor]', e);
      UI.showToast('打开失败：' + (e.message || e), 3000);
    }
  }

  function closeTaskEditor() {
    _cgTaskTs = null;
    document.getElementById('cg-task-panel')?.remove();
  }

  // ===== v681 调试：dump 当前对话的 convGameplay 全貌 =====
  async function debugDump() {
    try {
      const conv = _getConv();
      if (!conv) { alert('找不到当前对话'); return; }
      const lines = [];
      lines.push('=== 对话基础 ===');
      lines.push('id: ' + conv.id);
      lines.push('isSingle: ' + conv.isSingle);
      lines.push('singleWorldviewId: ' + (conv.singleWorldviewId || '(空)'));
      lines.push('worldviewId: ' + (conv.worldviewId || '(空)'));
      lines.push('');
      lines.push('=== convGameplay ===');
      lines.push('存在: ' + (conv.convGameplay ? '是' : '否'));
      if (conv.convGameplay) {
        const gp = conv.convGameplay;
        lines.push('globalAttrs 是数组: ' + Array.isArray(gp.globalAttrs));
        lines.push('globalAttrs 数量: ' + (gp.globalAttrs?.length ?? 'undefined'));
        lines.push('characterAttrs 是数组: ' + Array.isArray(gp.characterAttrs));
        lines.push('characterAttrs 数量: ' + (gp.characterAttrs?.length ?? 'undefined'));
        lines.push('taskSystem 存在: ' + !!gp.taskSystem);
        lines.push('taskSystem.phases 数量: ' + (gp.taskSystem?.phases?.length ?? 'undefined'));
      }
      lines.push('');
      lines.push('=== convEvents ===');
      lines.push('数量: ' + (conv.convEvents?.length ?? '(无字段)'));
      lines.push('');
      lines.push('=== 完整 convGameplay JSON ===');
      lines.push(JSON.stringify(conv.convGameplay, null, 2));
      lines.push('');
      lines.push('=== StatusBar 视角 ===');
      try {
        const fmt = await StatusBar.formatCustomAttrsFormatPrompt();
        lines.push('formatPrompt 长度: ' + (fmt?.length ?? 0));
        const sta = await StatusBar.formatCustomAttrsStatePrompt();
        lines.push('statePrompt 长度: ' + (sta?.length ?? 0));
        lines.push('');
        lines.push('--- formatPrompt ---');
        lines.push(fmt || '(空)');
        lines.push('');
        lines.push('--- statePrompt ---');
        lines.push(sta || '(空)');
      } catch(e) {
        lines.push('StatusBar 调用出错: ' + e.message);
      }
      const text = lines.join('\n');
      console.log(text);
      // 弹窗显示 + 复制按钮
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:16px';
      modal.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;max-width:560px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden">
          <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
            <div style="font-weight:600;color:var(--text)">🔍 调试 Dump</div>
            <button id="cg-dbg-close" style="background:none;border:none;color:var(--text);font-size:20px;cursor:pointer;padding:0;width:28px;height:28px">×</button>
          </div>
          <pre style="flex:1;overflow:auto;padding:14px;margin:0;font-size:11px;color:var(--text);white-space:pre-wrap;word-break:break-all;font-family:monospace"></pre>
          <div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:8px;flex-shrink:0">
            <button id="cg-dbg-copy" style="flex:1;padding:8px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">复制全部</button>
          </div>
        </div>`;
      modal.querySelector('pre').textContent = text;
      modal.querySelector('#cg-dbg-close').onclick = () => modal.remove();
      modal.querySelector('#cg-dbg-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(text); UI.showToast('已复制', 1500); } catch(_) { UI.showToast('复制失败，请长按 pre 区域手动选', 2000); }
      };
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
      document.body.appendChild(modal);
    } catch(e) {
      alert('调试出错：' + (e.message || e));
    }
  }

  return {
    openEventEditor, closeEventEditor,
    editEvent, addEvent, saveEvent, deleteEvent, closeEventModal,
    _syncTriggerTypeUI: _syncTriggerTypeUI,
    addAttrCondition, updateAttrCondition, removeAttrCondition,
    openAiGenerate, doAiGenerate,
    openAttrEditor, closeAttrEditor,
    openAttrModal, closeAttrModal, saveAttrFromModal, deleteAttrFromModal,
    toggleCharPicker, renderCharPicker, selectChar, deleteCharCard,
    openTaskEditor, closeTaskEditor,
    debugDump,
    addTaskPhase, deleteTaskPhase, updateTaskPhase,
    openTaskTypeModal, closeTaskTypeModal, saveTaskTypeFromModal, deleteTaskTypeFromModal,
    openPhaseRewardModal, onTaskRewardModeChange
  };
})();
