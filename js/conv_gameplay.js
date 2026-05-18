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
    return conds.map(c => `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${_esc(`${c.targetName ? c.targetName + ' / ' : '全局 / '}${c.attrName || '属性'} ${c.operator || '>='} ${c.value ?? 0}`)}</span>`).join('');
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
    const doCollect = (gameplay) => {
      if (!gameplay) return;
      (gameplay.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim()).forEach(a => {
        opts.push({ value: `global|||${a.id}`, scope: 'global', targetKey: '', targetName: '', attrId: a.id, attrName: a.name, label: `全局 / ${a.name}` });
      });
      (gameplay.characterAttrs || []).forEach(c => {
        const key = [c?.targetType || '', c?.targetId || '', c?.sourceWorldviewId || ''].join(':');
        (c.attrs || []).filter(a => a && a.id && (a.name || '').trim()).forEach(a => {
          opts.push({ value: `character||${key}||${a.id}`, scope: 'character', targetKey: key, targetName: c.targetName || '', attrId: a.id, attrName: a.name, label: `${c.targetName || '未命名角色'} / ${a.name}` });
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
    const opHtml = ['>','>=','<','<=','==','!='].map(op => `<option value="${op}">${op}</option>`).join('');
    box.innerHTML = _attrCondDraft.map((c, i) => {
      const curVal = c.scope === 'character' ? `character||${c.targetKey || ''}||${c.attrId || ''}` : `global|||${c.attrId || ''}`;
      const optHtml = opts.map(o => `<option value="${_esc(o.value)}" ${o.value === curVal ? 'selected' : ''}>${_esc(o.label)}</option>`).join('');
      return `<div style="display:grid;grid-template-columns:1fr 64px 74px 32px;gap:6px;align-items:center">
        <select onchange="ConvGameplay.updateAttrCondition(${i},'attr',this.value)" style="min-width:0;width:100%;box-sizing:border-box">${optHtml}</select>
        <select onchange="ConvGameplay.updateAttrCondition(${i},'operator',this.value)" style="width:100%;box-sizing:border-box">${['>','>=','<','<=','==','!='].map(op => `<option value="${op}" ${c.operator === op ? 'selected' : ''}>${op}</option>`).join('')}</select>
        <input type="number" value="${_esc(String(c.value ?? 0))}" oninput="ConvGameplay.updateAttrCondition(${i},'value',this.value)" style="width:100%;box-sizing:border-box">
        <button type="button" onclick="ConvGameplay.removeAttrCondition(${i})" style="width:32px;height:32px;border:1px solid var(--border);background:none;border-radius:6px;color:var(--danger);cursor:pointer">×</button>
      </div>`;
    }).join('');
    _attrCondDraft.forEach((c, i) => {
      if (!c.attrId && opts[0]) updateAttrCondition(i, 'attr', opts[0].value, true);
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
    } else if (field === 'value') {
      c.value = Number(value);
    } else if (field === 'operator') {
      c.operator = value || '>=';
    }
    if (!silent && field === 'attr') _renderAttrConditions();
  }

  function removeAttrCondition(i) {
    _attrCondDraft.splice(i, 1);
    _renderAttrConditions();
  }

  function editEvent(i) {
    _editEventIdx = i;
    const ev = _eventsData[i] || {};
    document.getElementById('cg-event-modal-title').textContent = ev.name ? '编辑事件' : '新建事件';
    document.getElementById('cg-event-name').value = ev.name || '';
    document.getElementById('cg-event-keys').value = ev.keys || '';
    const typeEl = document.getElementById('cg-event-trigger-type');
    if (typeEl) typeEl.value = ev.triggerType || 'keyword';
    _attrCondDraft = Array.isArray(ev.attrConditions) ? JSON.parse(JSON.stringify(ev.attrConditions)) : [];
    document.getElementById('cg-event-complete-key').value = ev.completeKey || '';
    document.getElementById('cg-event-finish-rule').value = ev.finishRule || '';
    document.getElementById('cg-event-content').value = ev.content || '';
    _syncTriggerTypeUI();
    document.getElementById('cg-event-modal').classList.remove('hidden');
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

  return {
    openEventEditor, closeEventEditor,
    editEvent, addEvent, saveEvent, deleteEvent, closeEventModal,
    _syncTriggerTypeUI: _syncTriggerTypeUI,
    addAttrCondition, updateAttrCondition, removeAttrCondition,
    openAiGenerate, doAiGenerate
  };
})();
