/**
 * 提示词注入管理 — 表单UI版
 */
const Prompts = (() => {
  const STORE_KEY = 'customPrompts';
  let editingId = null;
  let selectedGroup = '全部'; // 当前选中的分组
  let searchQuery = ''; // 搜索关键词
  let promptManageMode = false;
  let promptSelectedIds = new Set();

  async function getAll() {
    const data = await DB.get('gameState', STORE_KEY);
    return data?.value || [];
  }

  async function saveAll(list) {
    await DB.put('gameState', { key: STORE_KEY, value: list });
  }

  // 获取所有分组（去重）
  async function getGroups() {
    const list = await getAll();
    const groups = new Set(['全部']);
    list.forEach(p => {
      if (p.group) groups.add(p.group);
    });
    return Array.from(groups);
  }

  // 切换分组
  async function switchGroup(group) {
    selectedGroup = group;
    await render();
  }

  // 搜索
  async function search(query) {
    searchQuery = query.toLowerCase();
    await render();
  }

  async function add() {
    editingId = null;
    showEditModal({
      name: '', group: '默认', enabled: true,
      position: 'system_top', depth: 0, content: ''
    });
  }

  async function edit(id) {
    const list = await getAll();
    const item = list.find(p => p.id === id);
    if (!item) return;
    editingId = id;
    showEditModal(item);
  }

  function showEditModal(data) {
    const modal = document.getElementById('prompt-edit-modal');
    document.getElementById('pe-name').value = data.name || '';
    document.getElementById('pe-group').value = data.group || '默认';
    document.getElementById('pe-depth').value = data.depth || 0;
    document.getElementById('pe-content').value = data.content || '';
    // 设置自定义下拉菜单
    _selectPosition(data.position || 'system_top', false);
    modal.classList.remove('hidden');
  }

  const _positionOptions = {
    system_top: { label: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> 系统顶部' },
    system_bottom: { label: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg> 系统底部' },
    depth: { label: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> 按聊天深度插入' }
  };

  function _togglePositionDropdown() {
    const dropdown = document.getElementById('pe-position-dropdown');
    if (!dropdown) return;
    if (dropdown.classList.contains('hidden')) {
      dropdown.classList.remove('closing');
      dropdown.classList.remove('hidden');
    } else {
      if (dropdown.classList.contains('closing')) return;
      dropdown.classList.add('closing');
      setTimeout(() => {
        dropdown.classList.remove('closing');
        dropdown.classList.add('hidden');
      }, 120);
    }
  }

  function _selectPosition(value, closeDropdown = true) {
    document.getElementById('pe-position').value = value;
    const label = document.getElementById('pe-position-label');
    if (label && _positionOptions[value]) label.innerHTML = _positionOptions[value].label;
    // 更新 active 状态
    document.querySelectorAll('#pe-position-dropdown .custom-dropdown-item').forEach(item => {
      const isActive = item.getAttribute('onclick').includes(`'${value}'`);
      item.classList.toggle('active', isActive);
    });
    // 深度行可见性
    const depthRow = document.getElementById('pe-depth-row');
    if (depthRow) depthRow.style.display = value === 'depth' ? '' : 'none';
    if (closeDropdown) {
      const dropdown = document.getElementById('pe-position-dropdown');
      if (dropdown && !dropdown.classList.contains('hidden') && !dropdown.classList.contains('closing')) {
        dropdown.classList.add('closing');
        setTimeout(() => {
          dropdown.classList.remove('closing');
          dropdown.classList.add('hidden');
        }, 120);
      }
    }
  }

  async function saveEdit() {
    const list = await getAll();
    const data = {
      name: document.getElementById('pe-name').value.trim() || '未命名',
      group: document.getElementById('pe-group').value.trim() || '默认',
      enabled: true,
      position: document.getElementById('pe-position').value,
      depth: parseInt(document.getElementById('pe-depth').value) || 0,
      content: document.getElementById('pe-content').value.trim()
    };

    if (editingId) {
      const item = list.find(p => p.id === editingId);
      if (item) Object.assign(item, data);
    } else {
      data.id = Utils.uuid();
      data.enabled = true;
      list.push(data);
    }

    await saveAll(list);
    closeEdit();
    render();
  }

  async function closeEdit() {
    const modal = document.getElementById('prompt-edit-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
    editingId = null;
    // 如果是从提示词选择弹窗跳过来的，编辑完回去
    if (_returnToOverride) {
      _returnToOverride = false;
      openConvOverrideModal();
    }
  }

  async function remove(id) {
    if (!await UI.showConfirm('确认删除', '确定删除？')) return;
    let list = await getAll();
    list = list.filter(p => p.id !== id);
    await saveAll(list);
    renderList();
  }

  async function toggle(id) {
    const list = await getAll();
    const item = list.find(p => p.id === id);
    if (item) item.enabled = !item.enabled;
    await saveAll(list);
    render();
  }

  async function _resolveVars(text) {
    if (!text || typeof text !== 'string') return text;
    if (!text.includes('{{')) return text;
    let userName = '玩家';
    let charName = '';
    try {
      const char = await Character.get();
      if (char && char.name) userName = char.name;
    } catch(e) {}
    // 单人模式下的 {{char}}
    try {
      const ss = (typeof SingleMode !== 'undefined' && SingleMode.getCurrentSingleSettings)
        ? SingleMode.getCurrentSingleSettings() : null;
      if (ss && ss.charId) {
        if (ss.charType === 'card') {
          const card = await SingleCard.get(ss.charId);
          if (card && card.name) charName = card.name;
        } else if (ss.charType === 'npc') {
          // NPC 名直接是 charId 或单独存的，简单处理：跳过
        }
      }
    } catch(e) {}
    let out = text
      .replace(/\{\{user\}\}/gi, userName)
      .replace(/\{\{User\}\}/g, userName);
    if (charName) {
      out = out.replace(/\{\{char\}\}/gi, charName);
    }
    return out;
  }

  async function buildInjections() {
    const list = await getAll();
    const overrides = await _getConvOverrides();
    const result = { systemTop: [], systemBottom: [], depths: {} };
    for (const p of list) {
      // 对话覆盖优先，没有覆盖用全局值
      const isEnabled = overrides.hasOwnProperty(p.id) ? overrides[p.id] : p.enabled;
      if (!isEnabled || !p.content) continue;
      const content = await _resolveVars(p.content);
      if (p.position === 'system_top') {
        result.systemTop.push(content);
      } else if (p.position === 'system_bottom') {
        result.systemBottom.push(content);
      } else if (p.position === 'depth') {
        const d = parseInt(p.depth) || 0;
        if (!result.depths[d]) result.depths[d] = [];
        result.depths[d].push(content);
      }
    }
    return result;
  }

  async function render() {
    const container = document.getElementById('prompts-list');
    const tabsContainer = document.getElementById('prompt-group-tabs');
    if (!container || !tabsContainer) return;
    const list = await getAll();
    const groups = await getGroups();

    // 渲染分组 Tab
    let tabsHtml = '';
    groups.forEach(g => {
      const isActive = g === selectedGroup;
      tabsHtml += `<button onclick="Prompts.switchGroup('${Utils.escapeHtml(g)}')" style="flex-shrink:0;padding:6px 14px;border-radius:var(--radius);font-size:12px;border:1px solid ${isActive ? 'var(--accent)' : 'var(--border)'};background:${isActive ? 'var(--accent)' : 'var(--bg-tertiary)'};color:${isActive ? '#111' : 'var(--text-secondary)'};cursor:pointer">${Utils.escapeHtml(g)}</button>`;
    });
    tabsContainer.innerHTML = tabsHtml;

    // 根据选中分组和搜索关键词过滤
    let filteredList = list;
    if (selectedGroup !== '全部') {
      filteredList = filteredList.filter(p => p.group === selectedGroup);
    }
    if (searchQuery) {
      filteredList = filteredList.filter(p => 
        (p.name || '').toLowerCase().includes(searchQuery) ||
        (p.content || '').toLowerCase().includes(searchQuery)
      );
    }

    let html = '';
    if (filteredList.length === 0) {
      html = '<p style="color:var(--text-secondary);text-align:center;padding:20px">暂无提示词</p>';
    } else {
      for (const p of filteredList) {
        const posLabel = p.position === 'system_top'
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> 顶部'
          : p.position === 'system_bottom'
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg> 底部'
          : `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> 深度${p.depth}`;
        const isSelected = promptSelectedIds.has(p.id);
        html += `
          <div class="card" style="${p.enabled ? '' : 'opacity:0.4'};display:flex;flex-direction:column;gap:4px;padding:12px;background:var(--bg-tertiary);cursor:${promptManageMode ? 'default' : 'pointer'}" onclick="${promptManageMode ? `Prompts.togglePromptSelect('${p.id}')` : `Prompts.edit('${p.id}')`}">
            <div style="display:flex;align-items:center;gap:8px">
              ${promptManageMode ? `
              <span style="width:22px;height:22px;border-radius:50%;border:2px solid ${isSelected ? 'var(--accent)' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${isSelected ? 'background:var(--accent);' : ''}" onclick="event.stopPropagation();Prompts.togglePromptSelect('${p.id}')">
                ${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
              </span>` : `
              <span style="position:relative;display:inline-flex;flex-shrink:0">
<input type="checkbox" class="circle-check" ${p.enabled ? 'checked' : ''} onchange="Prompts.toggle('${p.id}')" onclick="event.stopPropagation()">
<span class="circle-check-ui"></span>
</span>`}
              <h3 style="flex:1;margin:0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(p.name)}</h3>
              <span style="font-size:11px;color:var(--text-secondary);white-space:nowrap;display:flex;align-items:center;gap:3px">${posLabel}</span>
            </div>
            <p style="margin:0;font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml((p.content || '').substring(0, 80))}${(p.content || '').length > 80 ? '...' : ''}</p>
          </div>`;
      }
    }

    container.innerHTML = html;
  }

  function togglePromptSelect(id) {
    if (promptSelectedIds.has(id)) promptSelectedIds.delete(id);
    else promptSelectedIds.add(id);
    render();
  }

  function togglePromptManageMode() {
    promptManageMode = !promptManageMode;
    promptSelectedIds.clear();
    const bar = document.getElementById('prompt-manage-bar');
    const btn = document.getElementById('prompt-manage-btn');
    if (promptManageMode) {
      if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
      if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg> 退出'; btn.style.background = 'var(--accent)'; btn.style.color = '#111'; btn.style.borderColor = 'var(--accent)'; }
    } else {
      if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
      if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理'; btn.style.background = 'none'; btn.style.color = 'var(--text-secondary)'; btn.style.borderColor = 'var(--border)'; }
    }
    render();
  }

  function exitPromptManageMode() {
    if (!promptManageMode) return;
    promptManageMode = false;
    promptSelectedIds.clear();
    const bar = document.getElementById('prompt-manage-bar');
    const btn = document.getElementById('prompt-manage-btn');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理'; btn.style.background = 'none'; btn.style.color = 'var(--text-secondary)'; btn.style.borderColor = 'var(--border)'; }
    render();
  }

  async function batchDeletePrompts() {
    if (promptSelectedIds.size === 0) return;
    if (!await UI.showConfirm('批量删除', `确定删除选中的 ${promptSelectedIds.size} 条提示词？`)) return;
    let list = await getAll();
    list = list.filter(p => !promptSelectedIds.has(p.id));
    promptSelectedIds.clear();
    await saveAll(list);
    render();
  }

  // ===== 对话级提示词覆盖 =====

  let _overrideTemp = {}; // 弹窗临时状态
  let _returnToOverride = false; // 编辑完是否回到提示词选择弹窗

  async function _getConvOverrides() {
    const convId = Conversations.getCurrent();
    const conv = Conversations.getList().find(c => c.id === convId);
    return conv?.promptOverrides || {};
  }

  async function openConvOverrideModal() {
    const list = await getAll();
    const overrides = await _getConvOverrides();
    _overrideTemp = { ...overrides };
    _overrideGroup = '全部';

    _renderOverrideList(list);
    document.getElementById('prompt-override-modal').classList.remove('hidden');
  }

  function _renderOverrideList(list) {
    const container = document.getElementById('prompt-override-list');
    if (!container) return;

    // 收集分组
    const groups = ['全部'];
    const seen = new Set();
    list.forEach(p => { if (p.group && !seen.has(p.group)) { seen.add(p.group); groups.push(p.group); } });

    // 分组tabs
    const tabsHtml = groups.map(g =>
      `<button onclick="Prompts._switchOverrideGroup('${g}')" style="padding:4px 12px;border-radius:14px;border:1px solid ${g === _overrideGroup ? 'var(--accent)' : 'var(--border)'};background:${g === _overrideGroup ? 'var(--accent)' : 'transparent'};color:${g === _overrideGroup ? '#111' : 'var(--text-secondary)'};font-size:12px;cursor:pointer;white-space:nowrap">${Utils.escapeHtml(g)}</button>`
    ).join('');

    // 过滤
    const filtered = _overrideGroup === '全部' ? list : list.filter(p => p.group === _overrideGroup);

    let listHtml = '';
    if (filtered.length === 0) {
      listHtml = '<p style="text-align:center;color:var(--text-secondary);padding:20px 0;font-size:13px">该分组下没有提示词</p>';
    } else {
      listHtml = filtered.map(p => {
        const isEnabled = _overrideTemp.hasOwnProperty(p.id) ? _overrideTemp[p.id] : p.enabled;
        const isOverridden = _overrideTemp.hasOwnProperty(p.id);
        const posLabel = p.position === 'system_top' ? '顶部'
          : p.position === 'system_bottom' ? '底部'
          : `深度${p.depth}`;
        return `
        <div class="card" style="padding:10px 12px;background:var(--bg-tertiary);display:flex;align-items:center;gap:10px">
          <label style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer">
            <span style="position:relative;display:inline-flex;flex-shrink:0">
              <input type="checkbox" class="circle-check" ${isEnabled ? 'checked' : ''} onchange="Prompts._toggleOverride('${p.id}', this.checked)">
              <span class="circle-check-ui"></span>
            </span>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(p.name)}</span>
                ${isOverridden ? '<span style="font-size:10px;color:var(--accent);background:rgba(255,165,0,0.15);padding:1px 5px;border-radius:3px;white-space:nowrap">已调整</span>' : ''}
              </div>
              <span style="font-size:11px;color:var(--text-secondary)">${posLabel}</span>
            </div>
          </label>
          <button onclick="event.stopPropagation();Prompts._editFromOverride('${p.id}')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px;flex-shrink:0" title="编辑提示词">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
          </button>
        </div>`;
      }).join('');
    }

    container.innerHTML = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;flex-shrink:0">${tabsHtml}</div>
      <div style="display:flex;flex-direction:column;gap:8px">${listHtml}</div>`;
  }

  let _overrideGroup = '全部';

  async function _switchOverrideGroup(group) {
    _overrideGroup = group;
    const list = await getAll();
    _renderOverrideList(list);
  }

  function _toggleOverride(id, checked) {
    _overrideTemp[id] = checked;
  }

  async function _editFromOverride(id) {
    // 标记：编辑完后回到选择弹窗
    _returnToOverride = true;
    // 打开编辑弹窗（选择弹窗不关，编辑弹窗叠在上面）
    edit(id);
  }

  async function saveConvOverrides() {
    const convId = Conversations.getCurrent();
    const convList = Conversations.getList();
    const conv = convList.find(c => c.id === convId);
    if (!conv) return;

    // 只存和全局不一样的值，减少存储
    const allPrompts = await getAll();
    const cleaned = {};
    for (const [id, val] of Object.entries(_overrideTemp)) {
      const globalPrompt = allPrompts.find(p => p.id === id);
      if (globalPrompt && globalPrompt.enabled !== val) {
        cleaned[id] = val;
      }
    }

    conv.promptOverrides = cleaned;
    await Conversations.saveList();
    closeConvOverrideModal();
    UI.showToast('提示词设置已保存');
  }

  async function resetConvOverrides() {
    if (!await UI.showConfirm('恢复默认', '将清除本对话的所有提示词调整，恢复为全局设置。确定？')) return;
    const convId = Conversations.getCurrent();
    const conv = Conversations.getList().find(c => c.id === convId);
    if (conv) {
      delete conv.promptOverrides;
      await Conversations.saveList();
    }
    _overrideTemp = {};
    closeConvOverrideModal();
    UI.showToast('已恢复默认');
  }

  function closeConvOverrideModal() {
    document.getElementById('prompt-override-modal')?.classList.add('hidden');
    _overrideTemp = {};
  }

  // ===== 导出提示词 =====
  async function exportPreset() {
    const list = await getAll();
    const filtered = selectedGroup === '全部' ? list : list.filter(p => p.group === selectedGroup);
    if (filtered.length === 0) {
      UI.showToast('当前分组没有提示词', 1800);
      return;
    }
    // 导出为"我们的原生格式 + 通用预设兼容字段"：prompts 数组每条同时带 injection_position/injection_depth/enabled
    const prompts = filtered.map(p => ({
      // 通用预设兼容
      identifier: p.id,
      name: p.name,
      role: 'system',
      content: p.content,
      injection_position: p.position === 'depth' ? 1 : 0,
      injection_depth: p.depth || 0,
      enabled: !!p.enabled,
      // 我们独有
      _group: p.group || '',
      _position: p.position
    }));
    // 也带一个 prompt_order 提供顺序信息
    const prompt_order = [{
      character_id: 100001,
      order: prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled }))
    }];
    const out = {
      _exportedBy: '天枢城文游APP',
      _exportedAt: new Date().toISOString(),
      _group: selectedGroup,
      prompts,
      prompt_order
    };

    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (selectedGroup === '全部' ? '全部提示词' : selectedGroup).replace(/[\/\\:*?"<>|]/g, '_');
    a.download = `prompts_${safeName}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    UI.showToast(`已导出 ${prompts.length} 条提示词`, 2000);
  }

  // ===== 导入预设 =====
  async function importPreset(input) {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      input.value = '';
      const data = JSON.parse(text);
      const result = await _parseAndImport(data, file.name.replace(/\.json$/i, ''));
      UI.showToast(`已导入 ${result.imported} 条提示词${result.skipped ? `（跳过 ${result.skipped} 条空内容）` : ''}`, 2500);
      render();
    } catch(e) {
      console.error('[Prompts.importPreset]', e);
      await UI.showAlert('导入失败', '文件不是合法的 JSON，或格式不支持。\n\n' + (e.message || ''));
      input.value = '';
    }
  }

  async function _parseAndImport(data, fileGroupName) {
    const list = await getAll();
    const group = (fileGroupName || '导入').slice(0, 30);
    let imported = 0, skipped = 0;

    // 我们自己的导出格式：{ prompts: [...] } 或 直接数组
    let promptsArr = null;
    let orderArr = null;

    if (Array.isArray(data)) {
      promptsArr = data;
    } else if (Array.isArray(data.prompts)) {
      promptsArr = data.prompts;
    }
    // prompt_order：用第一个 character_id 的顺序（或者所有 enabled=true 的）
    if (data.prompt_order && Array.isArray(data.prompt_order) && data.prompt_order.length > 0) {
      orderArr = data.prompt_order[0]?.order || null;
    }

    if (!promptsArr || promptsArr.length === 0) {
      throw new Error('未找到 prompts 数组');
    }

    // 构建 identifier -> enabled 映射（来自 prompt_order）
    const enabledMap = {};
    if (orderArr) {
      orderArr.forEach(o => { if (o.identifier) enabledMap[o.identifier] = !!o.enabled; });
    }

    for (const p of promptsArr) {
      const content = (p.content || '').trim();
      if (!content) { skipped++; continue; }
      // 过滤纯系统占位（marker / system_prompt）
      if (p.marker || p.system_prompt === true) {
        // 系统占位条目内容多为空，已被上一个 if 滤掉。这里再保险跳过 chatHistory 类
        if (!content) { skipped++; continue; }
      }

      const role = p.role || 'system'; // system / user / assistant
      let finalContent = content;
      if (role === 'user') finalContent = `[用户输入] ${content}`;
      else if (role === 'assistant') finalContent = `[AI回复] ${content}`;

      // 注入位置
      let position = 'system_top';
      let depth = 0;
      if (p.injection_position === 1) {
        position = 'depth';
        depth = parseInt(p.injection_depth) || 4;
      } else if (p.injection_position === 0 || p.injection_position === undefined) {
        position = 'system_top';
      }

      // 启用状态：优先用 prompt_order 的；其次看 enabled 字段；都没有默认 true
      let isEnabled = true;
      if (p.identifier && enabledMap.hasOwnProperty(p.identifier)) {
        isEnabled = enabledMap[p.identifier];
      } else if (typeof p.enabled === 'boolean') {
        isEnabled = p.enabled;
      }

      list.push({
        id: Utils.uuid(),
        name: (p.name || p.identifier || '未命名').slice(0, 80),
        group: group,
        enabled: isEnabled,
        position: position,
        depth: depth,
        content: finalContent
      });
      imported++;
    }

    await saveAll(list);
    return { imported, skipped };
  }

  function toggleMenu() {
    const dropdown = document.getElementById('prompt-menu-dropdown');
    if (!dropdown) return;
    if (dropdown.classList.contains('hidden')) {
      dropdown.classList.remove('closing');
      dropdown.classList.remove('hidden');
      // 点外面关闭
      setTimeout(() => {
        document.addEventListener('click', _onMenuOutsideClick, { once: true });
      }, 0);
    } else {
      dropdown.classList.add('hidden');
    }
  }
  function _onMenuOutsideClick(e) {
    const menu = document.getElementById('prompt-menu-dropdown');
    const btn = document.getElementById('prompt-menu-btn');
    if (!menu || menu.classList.contains('hidden')) return;
    if (e.target.closest('#prompt-menu-dropdown') || e.target.closest('#prompt-menu-btn')) return;
    menu.classList.add('hidden');
  }

  return { getAll, add, edit, saveEdit, closeEdit, remove, toggle, buildInjections, render, getGroups, switchGroup, search,
    togglePromptSelect, togglePromptManageMode, exitPromptManageMode, batchDeletePrompts,
    _togglePositionDropdown, _selectPosition, importPreset, exportPreset, toggleMenu,
    openConvOverrideModal, saveConvOverrides, resetConvOverrides, closeConvOverrideModal, _toggleOverride, _switchOverrideGroup, _editFromOverride };
})();