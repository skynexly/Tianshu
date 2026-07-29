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
  // 当前编辑中的作用域集合（scopes）；空集合语义=全选（向下兼容老数据）
  let _editScopes = new Set(['chat']);
  const _ALL_SCOPES = ['chat', 'backstage', 'phone'];
  const SELECTED_GROUP = '__selected__'; // 虚拟分组：已启用的提示词（只读预览，不排序）

  async function getAll() {
    const data = await DB.get('gameState', STORE_KEY);
    return data?.value || [];
  }

  async function saveAll(list) {
    await DB.put('gameState', { key: STORE_KEY, value: list });
  }

  // 获取所有分组（去重）：合并独立分组数组 + 各提示词已用到的 group
  async function getGroups() {
    const list = await getAll();
    const stored = await getPromptGroups();
    const groups = new Set(['全部']);
    stored.forEach(g => { if (g) groups.add(g); });
    list.forEach(p => {
      if (p.group) groups.add(p.group);
    });
    return Array.from(groups);
  }

  // 独立分组名数组（支持空组、重命名、删除）
  async function getPromptGroups() {
    const data = await DB.get('gameState', 'promptGroups');
    return Array.isArray(data?.value) ? data.value : [];
  }
  async function savePromptGroups(groups) {
    await DB.put('gameState', { key: 'promptGroups', value: groups });
  }

  function _isReservedPromptGroup(g) {
    return g === '全部' || g === SELECTED_GROUP;
  }

  // 轻量底部选项弹层（无分割线），返回选中项 value 或 null
  function _groupSheet(title, options) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.5);display:flex;align-items:flex-end;justify-content:center';
      const btns = options.map((o, i) =>
        `<button data-i="${i}" style="width:100%;padding:15px 16px;background:none;border:none;color:${o.danger ? 'var(--danger)' : 'var(--text)'};font-size:15px;cursor:pointer;text-align:center">${Utils.escapeHtml(o.label)}</button>`
      ).join('');
      overlay.innerHTML = `
        <div style="background:var(--bg);width:100%;max-width:480px;border-radius:16px 16px 0 0;overflow:hidden;padding-bottom:env(safe-area-inset-bottom,0)">
          <div style="padding:14px 16px 8px;font-size:13px;color:var(--text-secondary);text-align:center">${Utils.escapeHtml(title || '')}</div>
          ${btns}
          <button data-i="-1" style="width:100%;padding:15px 16px;margin-top:6px;background:var(--bg-tertiary);border:none;color:var(--text-secondary);font-size:15px;cursor:pointer;text-align:center">取消</button>
        </div>`;
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { close(null); return; }
        const b = e.target.closest('button[data-i]');
        if (!b) return;
        const idx = parseInt(b.dataset.i, 10);
        close(idx < 0 ? null : options[idx].value);
      });
      document.body.appendChild(overlay);
    });
  }

  // 新建分组（＋ Tab）
  async function addPromptGroup() {
    const name = await UI.showSimpleInput('新建分组', '');
    if (!name || !name.trim()) return;
    const g = name.trim();
    if (_isReservedPromptGroup(g)) { UI.showToast('该名称被保留，请换一个'); return; }
    const groups = await getPromptGroups();
    // 已用到的 group 也算存在
    const all = await getGroups();
    if (all.includes(g)) { UI.showToast('分组已存在'); selectedGroup = g; await render(); return; }
    groups.push(g);
    await savePromptGroups(groups);
    selectedGroup = g;
    await render();
  }

  // 长按分组 Tab：重命名 / 删除
  async function _onGroupTabLongPress(groupName) {
    if (_isReservedPromptGroup(groupName)) return;
    const action = await _groupSheet(`分组「${groupName}」`, [
      { label: '重命名', value: 'rename' },
      { label: '删除分组', value: 'delete', danger: true }
    ]);
    if (!action) return;
    if (action === 'rename') {
      const nn = await UI.showSimpleInput('重命名分组', groupName);
      if (!nn || !nn.trim()) return;
      const nname = nn.trim();
      if (nname === groupName) return;
      if (_isReservedPromptGroup(nname)) { UI.showToast('该名称被保留，请换一个'); return; }
      const all = await getGroups();
      if (all.includes(nname)) { UI.showToast('已有同名分组'); return; }
      // 更新独立分组数组
      const groups = await getPromptGroups();
      const gi = groups.indexOf(groupName);
      if (gi >= 0) groups[gi] = nname; else groups.push(nname);
      await savePromptGroups(groups);
      // 迁移该组下提示词
      const list = await getAll();
      let changed = false;
      list.forEach(p => { if ((p.group || '默认') === groupName) { p.group = nname; changed = true; } });
      if (changed) await saveAll(list);
      if (selectedGroup === groupName) selectedGroup = nname;
      await render();
    } else if (action === 'delete') {
      if (!await UI.showConfirm('删除分组', `确定删除分组「${groupName}」？\n\n该组下的提示词会退回「默认」，提示词本身不会被删除。`)) return;
      const groups = await getPromptGroups();
      await savePromptGroups(groups.filter(g => g !== groupName));
      // 该组下提示词退回默认
      const list = await getAll();
      let changed = false;
      list.forEach(p => { if ((p.group || '默认') === groupName) { p.group = '默认'; changed = true; } });
      if (changed) await saveAll(list);
      if (selectedGroup === groupName) selectedGroup = '全部';
      await render();
    }
  }

  // 长按计时器（分组 Tab）
  let _groupLongPressTimer = null;
  let _groupSuppressClick = false;
  function _onGroupTabTouchStart(e, groupName) {
    if (_isReservedPromptGroup(groupName)) return;
    _groupLongPressTimer = setTimeout(() => {
      _groupSuppressClick = true;
      try { e?.preventDefault?.(); } catch(_) {}
      _onGroupTabLongPress(groupName);
      setTimeout(() => { _groupSuppressClick = false; }, 650);
    }, 500);
  }
  function _onGroupTabTouchEnd() {
    if (_groupLongPressTimer) { clearTimeout(_groupLongPressTimer); _groupLongPressTimer = null; }
  }
  function _onGroupTabClick(e, group) {
    if (_groupSuppressClick) { _groupSuppressClick = false; try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch(_) {} return; }
    switchGroup(group);
  }

  // 批量移动选中提示词到某分组
  async function moveSelectedToGroup() {
    if (promptSelectedIds.size === 0) { UI.showToast('请先选择提示词'); return; }
    const groups = await getPromptGroups();
    // 合并已用到的 group（去掉保留名）
    const all = (await getGroups()).filter(g => !_isReservedPromptGroup(g));
    const merged = Array.from(new Set([...all, ...groups]));
    const options = [
      ...merged.map(g => ({ label: g, value: g })),
      { label: '＋ 新建分组…', value: '__new__' }
    ];
    let target = await _groupSheet(`移动 ${promptSelectedIds.size} 条提示词到`, options);
    if (!target) return;
    if (target === '__new__') {
      const name = await UI.showSimpleInput('新建分组', '');
      if (!name || !name.trim()) return;
      const g = name.trim();
      if (_isReservedPromptGroup(g)) { UI.showToast('该名称被保留，请换一个'); return; }
      if (!groups.includes(g)) { groups.push(g); await savePromptGroups(groups); }
      target = g;
    }
    const list = await getAll();
    list.forEach(p => { if (promptSelectedIds.has(p.id)) p.group = target; });
    await saveAll(list);
    const moved = promptSelectedIds.size;
    selectedGroup = target;
    exitPromptManageMode();
    UI.showToast(`已移动 ${moved} 条提示词`);
  }

  // 切换分组
  async function switchGroup(group) {
    selectedGroup = group;
    await render();
  }

  // 搜索（render 会自行以搜索框实际值为准，这里只触发重渲染）
  async function search(query) {
    searchQuery = (query || '').trim().toLowerCase();
    await render();
  }

  // 复位视图状态：分组回「全部」、清空搜索框与搜索关键词（进入面板时调用，避免状态残留）
  function resetView() {
    selectedGroup = '全部';
    searchQuery = '';
    const _searchInput = document.getElementById('prompt-search');
    if (_searchInput) _searchInput.value = '';
  }

  async function add() {
    editingId = null;
    showEditModal({
      name: '', group: '默认', enabled: true,
      position: 'system_top', depth: 0, content: '', scopes: ['chat']
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
    // 作用域：老数据无 scopes 字段=全选（向下兼容）；新建默认 ['chat']
    if (Array.isArray(data.scopes)) {
      _editScopes = new Set(data.scopes.filter(s => _ALL_SCOPES.includes(s)));
    } else {
      _editScopes = new Set(_ALL_SCOPES); // 老数据兼容：全选
    }
    _renderScopeTags();
    // 设置自定义下拉菜单
    _selectRole(data.role || 'system', false);
    _selectPosition(data.position || 'system_top', false);
    modal.classList.remove('hidden');
  }

  function _renderScopeTags() {
    document.querySelectorAll('#pe-scope-tags .pe-scope-tag').forEach(btn => {
      const sc = btn.getAttribute('data-scope');
      btn.classList.toggle('active', _editScopes.has(sc));
    });
  }

  function _toggleScope(sc) {
    if (!_ALL_SCOPES.includes(sc)) return;
    if (_editScopes.has(sc)) {
      _editScopes.delete(sc);
    } else {
      _editScopes.add(sc);
    }
    _renderScopeTags();
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
    // 注入角色行：仅「底部」和「深度」可选 role（顶部本质是拼进 system 大块，无法带其他角色）
    const roleRow = document.getElementById('pe-role-row');
    if (roleRow) roleRow.style.display = (value === 'system_bottom' || value === 'depth') ? '' : 'none';
    // 顶部强制回落 system，避免残留 user/assistant
    if (value === 'system_top') { _selectRole('system', false); }
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

  const _roleLabels = {
    system: '系统 (system)',
    user: '用户 (user)',
    assistant: '助手 (assistant)'
  };

  function _toggleRoleDropdown() {
    const dropdown = document.getElementById('pe-role-dropdown');
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

  function _selectRole(value, closeDropdown = true) {
    const val = (value === 'user' || value === 'assistant') ? value : 'system';
    document.getElementById('pe-role').value = val;
    const label = document.getElementById('pe-role-label');
    if (label) label.textContent = _roleLabels[val];
    document.querySelectorAll('#pe-role-dropdown .custom-dropdown-item').forEach(item => {
      const isActive = item.getAttribute('onclick').includes(`'${val}'`);
      item.classList.toggle('active', isActive);
    });
    if (closeDropdown) {
      const dropdown = document.getElementById('pe-role-dropdown');
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
    const _pos = document.getElementById('pe-position').value;
    const data = {
      name: document.getElementById('pe-name').value.trim() || '未命名',
      group: document.getElementById('pe-group').value.trim() || '默认',
      enabled: true,
      position: _pos,
      depth: parseInt(document.getElementById('pe-depth').value) || 0,
      // role：仅 底部/深度 支持 user/assistant，顶部强制 system
      role: (_pos === 'system_top') ? 'system' : (document.getElementById('pe-role').value || 'system'),
      content: document.getElementById('pe-content').value.trim(),
      scopes: Array.from(_editScopes)
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

  async function buildInjections(sceneKind) {
    const list = await getAll();
    const overrides = await _getConvOverrides();
    const result = { systemTop: [], systemBottom: [], depths: {} };
    // 排序：先按分组出现顺序（分组第一次在 list 里出现的位置），同组内按 sortOrder（无则按原顺序兜底）
    const _groupFirstIdx = {};
    list.forEach((p, i) => { const g = p.group || ''; if (!(g in _groupFirstIdx)) _groupFirstIdx[g] = i; });
    const _sorted = list.map((p, i) => ({ p, i })).sort((a, b) => {
      const ga = _groupFirstIdx[a.p.group || ''] ?? 0;
      const gb = _groupFirstIdx[b.p.group || ''] ?? 0;
      if (ga !== gb) return ga - gb;
      const sa = (typeof a.p.sortOrder === 'number') ? a.p.sortOrder : a.i;
      const sb = (typeof b.p.sortOrder === 'number') ? b.p.sortOrder : b.i;
      if (sa !== sb) return sa - sb;
      return a.i - b.i;
    }).map(x => x.p);
    for (const p of _sorted) {
      // 对话覆盖优先，没有覆盖用全局值
      const isEnabled = overrides.hasOwnProperty(p.id) ? overrides[p.id] : p.enabled;
      if (!isEnabled || !p.content) continue;
      // 作用域过滤：无 scopes 字段=全作用域（老数据兼容）；传了 sceneKind 才过滤
      if (sceneKind && Array.isArray(p.scopes)) {
        if (!p.scopes.includes(sceneKind)) continue;
      }
      const content = await _resolveVars(p.content);
      // phone 场景没有逐条对话消息结构：depth 降级为 system_bottom
      let pos = p.position;
      if (sceneKind === 'phone' && pos === 'depth') pos = 'system_bottom';
      // top/bottom 也支持 role（system/user/assistant），默认 system
      const _tbRole = (p.role === 'user' || p.role === 'assistant') ? p.role : 'system';
      if (pos === 'system_top') {
        result.systemTop.push({ content, role: _tbRole });
      } else if (pos === 'system_bottom') {
        result.systemBottom.push({ content, role: _tbRole });
      } else if (pos === 'depth') {
        const d = parseInt(p.depth) || 0;
        if (!result.depths[d]) result.depths[d] = [];
        // depth 注入支持 role（system/user/assistant），默认 system
        const role = (p.role === 'user' || p.role === 'assistant') ? p.role : 'system';
        result.depths[d].push({ content, role });
      }
    }
    return result;
  }

  async function render() {
    const container = document.getElementById('prompts-list');
    const tabsContainer = document.getElementById('prompt-group-tabs');
    if (!container || !tabsContainer) return;
    // 以搜索框 DOM 实际值为准同步 searchQuery，避免变量残留导致列表莫名"缩水"
    const _searchInput = document.getElementById('prompt-search');
    searchQuery = _searchInput ? (_searchInput.value || '').trim().toLowerCase() : '';
    const list = await getAll();
    const groups = await getGroups();

    // 渲染分组 Tab（「全部」后插入虚拟「已选」= 已启用的提示词，只读预览）
    let tabsHtml = '';
    groups.forEach(g => {
      const isActive = g === selectedGroup;
      const deletable = !_isReservedPromptGroup(g);
      const esc = Utils.escapeHtml(g).replace(/'/g, "\\'");
      const onclickAttr = deletable
        ? `onclick="Prompts._onGroupTabClick(event,'${esc}')"`
        : `onclick="Prompts.switchGroup('${esc}')"`;
      const longPress = deletable
        ? ` oncontextmenu="event.preventDefault();Prompts._onGroupTabLongPress('${esc}')" ontouchstart="Prompts._onGroupTabTouchStart(event,'${esc}')" ontouchend="Prompts._onGroupTabTouchEnd()" ontouchmove="Prompts._onGroupTabTouchEnd()"`
        : '';
      tabsHtml += `<button ${onclickAttr}${longPress} style="flex-shrink:0;padding:6px 14px;border-radius:var(--radius);font-size:12px;border:1px solid ${isActive ? 'var(--accent)' : 'var(--border)'};background:${isActive ? 'var(--accent)' : 'var(--bg-tertiary)'};color:${isActive ? '#111' : 'var(--text-secondary)'};cursor:pointer;white-space:nowrap">${Utils.escapeHtml(g)}</button>`;
      // 紧跟在「全部」后面插入「已选」
      if (g === '全部') {
        const selActive = selectedGroup === SELECTED_GROUP;
        tabsHtml += `<button onclick="Prompts.switchGroup('${SELECTED_GROUP}')" style="flex-shrink:0;padding:6px 14px;border-radius:var(--radius);font-size:12px;border:1px solid ${selActive ? 'var(--accent)' : 'var(--border)'};background:${selActive ? 'var(--accent)' : 'var(--bg-tertiary)'};color:${selActive ? '#111' : 'var(--text-secondary)'};cursor:pointer">✓ 已选</button>`;
      }
    });
    // ＋ 新建分组
    tabsHtml += `<button onclick="Prompts.addPromptGroup()" style="flex-shrink:0;padding:6px 12px;border-radius:var(--radius);font-size:14px;border:1px dashed var(--border);background:none;color:var(--text-secondary);cursor:pointer">＋</button>`;
    tabsContainer.innerHTML = tabsHtml;

    // 根据选中分组和搜索关键词过滤
    let filteredList = list;
    const _isSelectedView = selectedGroup === SELECTED_GROUP;
    if (_isSelectedView) {
      filteredList = filteredList.filter(p => p.enabled);
    } else if (selectedGroup !== '全部') {
      filteredList = filteredList.filter(p => p.group === selectedGroup);
    }
    if (searchQuery) {
      filteredList = filteredList.filter(p => 
        (p.name || '').toLowerCase().includes(searchQuery) ||
        (p.content || '').toLowerCase().includes(searchQuery)
      );
    }
    // 显示顺序与拼接顺序一致：分组出现顺序 + 组内 sortOrder
    filteredList = _sortPrompts(filteredList);
    let html = '';
    if (filteredList.length === 0) {
      html = '<p style="color:var(--text-secondary);text-align:center;padding:20px">暂无提示词</p>';
    } else {
      // 顶部「全开 / 全关」快捷行（作用于当前分组+搜索筛选出的提示词），管理模式下隐藏（那时顶部走批量删除）
      if (!promptManageMode) {
        html += `
          <div style="display:flex;gap:8px;margin-bottom:10px">
            <button onclick="Prompts.toggleGroupAll(true)" style="flex:1;padding:7px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text-secondary);font-size:12px;cursor:pointer">全部开启</button>
            <button onclick="Prompts.toggleGroupAll(false)" style="flex:1;padding:7px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text-secondary);font-size:12px;cursor:pointer">全部关闭</button>
          </div>`;
      }
      for (let _pi = 0; _pi < filteredList.length; _pi++) {
        const p = filteredList[_pi];
        const posLabel = p.position === 'system_top'
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> 顶部'
          : p.position === 'system_bottom'
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg> 底部'
          : `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> 深度${p.depth}`;
        const isSelected = promptSelectedIds.has(p.id);
        const _scMap = { chat: '主线', backstage: '后台', phone: '手机聊天' };
        const _scArr = Array.isArray(p.scopes) ? p.scopes : _ALL_SCOPES;
        const scopeLabel = (_scArr.length === _ALL_SCOPES.length)
          ? '全部'
          : _scArr.map(s => _scMap[s]).filter(Boolean).join('/');
        html += `
          <div class="card" style="${p.enabled ? '' : 'opacity:0.4'};display:flex;flex-direction:column;gap:4px;padding:12px;background:var(--bg-tertiary);cursor:${promptManageMode ? 'default' : 'pointer'}" onclick="${promptManageMode ? `Prompts.togglePromptSelect('${p.id}')` : `Prompts.edit('${p.id}')`}">
            <div style="display:flex;align-items:center;gap:8px">
              ${promptManageMode ? `
              <span style="width:22px;height:22px;border-radius:50%;border:2px solid ${isSelected ? 'var(--accent)' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${isSelected ? 'background:var(--accent);' : ''}" onclick="event.stopPropagation();Prompts.togglePromptSelect('${p.id}')">
                ${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
              </span>` : `
              <span style="position:relative;display:inline-flex;flex-shrink:0;cursor:pointer" onclick="event.stopPropagation();Prompts.toggle('${p.id}')">
<input type="checkbox" class="circle-check" ${p.enabled ? 'checked' : ''}>
<span class="circle-check-ui"></span>
</span>`}
              <h3 style="flex:1;margin:0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(p.name)}</h3>
              <span style="font-size:10px;color:var(--accent);background:rgba(0,0,0,0.2);padding:1px 6px;border-radius:8px;white-space:nowrap;flex-shrink:0">${scopeLabel}</span>
              <span style="font-size:11px;color:var(--text-secondary);white-space:nowrap;display:flex;align-items:center;gap:3px">${posLabel}</span>
              ${(!promptManageMode && !_isSelectedView) ? (() => {
                const _prevSameGroup = _pi > 0 && (filteredList[_pi - 1].group || '') === (p.group || '');
                const _nextSameGroup = _pi < filteredList.length - 1 && (filteredList[_pi + 1].group || '') === (p.group || '');
                return `<span style="display:inline-flex;flex-direction:column;flex-shrink:0;gap:1px">
                  <span onclick="event.stopPropagation();${_prevSameGroup ? `Prompts.movePrompt('${p.id}',-1)` : ''}" style="cursor:${_prevSameGroup ? 'pointer' : 'default'};opacity:${_prevSameGroup ? '0.7' : '0.2'};line-height:1;display:flex" title="上移">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                  </span>
                  <span onclick="event.stopPropagation();${_nextSameGroup ? `Prompts.movePrompt('${p.id}',1)` : ''}" style="cursor:${_nextSameGroup ? 'pointer' : 'default'};opacity:${_nextSameGroup ? '0.7' : '0.2'};line-height:1;display:flex" title="下移">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                  </span>
                </span>`;
              })() : ''}
            </div>
            <p style="margin:0;font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml((p.content || '').substring(0, 80))}${(p.content || '').length > 80 ? '...' : ''}</p>
          </div>`;
      }
    }

    container.innerHTML = html;
    if (promptManageMode) _updatePromptSelectAllIcon();
  }

  // 主设置：把当前分组+搜索筛选出的提示词全部开启/关闭
  async function toggleGroupAll(enable) {
    const filtered = await _getFilteredPrompts();
    if (!filtered.length) return;
    const ids = new Set(filtered.map(p => p.id));
    const list = await getAll();
    list.forEach(p => { if (ids.has(p.id)) p.enabled = !!enable; });
    await saveAll(list);
    await render();
    UI.showToast(enable ? `已开启 ${ids.size} 条` : `已关闭 ${ids.size} 条`, 1500);
  }

  function togglePromptSelect(id) {
    if (promptSelectedIds.has(id)) promptSelectedIds.delete(id);
    else promptSelectedIds.add(id);
    render();
  }

  // 按当前分组+搜索筛选后的提示词列表（全选/图标刷新共用）
  async function _getFilteredPrompts() {
    let filtered = await getAll();
    if (selectedGroup === SELECTED_GROUP) filtered = filtered.filter(p => p.enabled);
    else if (selectedGroup !== '全部') filtered = filtered.filter(p => p.group === selectedGroup);
    if (searchQuery) {
      filtered = filtered.filter(p =>
        (p.name || '').toLowerCase().includes(searchQuery) ||
        (p.content || '').toLowerCase().includes(searchQuery)
      );
    }
    return _sortPrompts(filtered);
  }

  // 统一排序：先按分组出现顺序，同组内按 sortOrder（无则原顺序兜底）
  function _sortPrompts(arr) {
    const groupFirstIdx = {};
    arr.forEach((p, i) => { const g = p.group || ''; if (!(g in groupFirstIdx)) groupFirstIdx[g] = i; });
    return arr.map((p, i) => ({ p, i })).sort((a, b) => {
      const ga = groupFirstIdx[a.p.group || ''] ?? 0;
      const gb = groupFirstIdx[b.p.group || ''] ?? 0;
      if (ga !== gb) return ga - gb;
      const sa = (typeof a.p.sortOrder === 'number') ? a.p.sortOrder : a.i;
      const sb = (typeof b.p.sortOrder === 'number') ? b.p.sortOrder : b.i;
      if (sa !== sb) return sa - sb;
      return a.i - b.i;
    }).map(x => x.p);
  }

  // 上移/下移：在「同分组内」和相邻条目交换位置（改 sortOrder）
  // dir = -1 上移，1 下移
  async function movePrompt(id, dir) {
    const list = await getAll();
    const cur = list.find(p => p.id === id);
    if (!cur) return;
    // 同组条目按当前排序取出
    const sameGroup = _sortPrompts(list.filter(p => (p.group || '') === (cur.group || '')));
    // 懒初始化：确保同组每条都有连续 sortOrder
    sameGroup.forEach((p, i) => { p.sortOrder = i; });
    const idx = sameGroup.findIndex(p => p.id === id);
    const target = idx + dir;
    if (target < 0 || target >= sameGroup.length) {
      // 已到边界，仍要把懒初始化的 sortOrder 落库
      await saveAll(list);
      return;
    }
    // 交换 sortOrder
    const a = sameGroup[idx], b = sameGroup[target];
    const tmp = a.sortOrder; a.sortOrder = b.sortOrder; b.sortOrder = tmp;
    await saveAll(list);
    await render();
  }

  // ===== 拖拽排序模式（组内拖拽，复用面具排序那套触摸逻辑）=====
  let promptSortMode = false;
  let _sortList = [];          // 排序模式下的当前顺序（含所有提示词，已按分组+sortOrder排）
  let _promptDragState = null;

  async function enterPromptSortMode() {
    promptSortMode = true;
    // 退出可能开着的批量模式
    if (promptManageMode) { promptManageMode = false; promptSelectedIds.clear(); }
    const list = await getAll();
    _sortList = _sortPrompts(list);
    _renderPromptSortList();
  }
  function exitPromptSortMode() {
    promptSortMode = false;
    _sortList = [];
    const bar = document.getElementById('prompt-sort-bar');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    const listEl = document.getElementById('prompts-list');
    if (listEl) listEl.style.paddingBottom = '';
    render();
  }
  // 把当前 _sortList 的顺序写回各条的 sortOrder（按分组分别赋连续序号），落库后退出
  async function savePromptSortOrder() {
    const list = await getAll();
    // 按分组分别计数
    const counter = {};
    const orderMap = new Map();
    for (const p of _sortList) {
      const g = p.group || '';
      counter[g] = (counter[g] || 0);
      orderMap.set(p.id, counter[g]);
      counter[g]++;
    }
    list.forEach(p => { if (orderMap.has(p.id)) p.sortOrder = orderMap.get(p.id); });
    await saveAll(list);
    exitPromptSortMode();
    UI.showToast('排序已保存', 1500);
  }

  function _renderPromptSortList() {
    const container = document.getElementById('prompts-list');
    if (!container) return;
    container.style.paddingBottom = '72px';
    const bar = document.getElementById('prompt-sort-bar');
    if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
    // 分组 Tab 在排序模式下无意义，清掉（退出时 render 会重建）
    const tabsContainer = document.getElementById('prompt-group-tabs');
    if (tabsContainer) tabsContainer.innerHTML = '';

    if (!_sortList.length) {
      container.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px">暂无提示词</p>';
      return;
    }
    let html = '';
    let lastGroup = null;
    for (let i = 0; i < _sortList.length; i++) {
      const p = _sortList[i];
      const g = p.group || '';
      if (g !== lastGroup) {
        html += `<div style="font-size:12px;color:var(--text-secondary);font-weight:600;margin:${lastGroup === null ? '4px' : '14px'} 0 6px;padding-left:2px">${Utils.escapeHtml(g || '未分组')}</div>`;
        lastGroup = g;
      }
      html += `<div class="sort-item" data-sort-idx="${i}" data-id="${p.id}" data-group="${Utils.escapeHtml(g)}" style="display:flex;align-items:center;gap:8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:6px;transition:transform 0.15s ease,opacity 0.15s ease">
        <div class="sort-handle" style="display:flex;align-items:center;justify-content:center;width:24px;flex-shrink:0;cursor:grab;color:var(--text-secondary);font-size:18px;user-select:none;-webkit-user-select:none;touch-action:none">≡</div>
        <div style="flex:1;overflow:hidden">
          <h3 style="margin:0;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(p.name || '未命名')}</h3>
        </div>
      </div>`;
    }
    container.innerHTML = html;
    _bindPromptSortDrag(container);
  }

  function _bindPromptSortDrag(container) {
    const items = container.querySelectorAll('.sort-item');
    items.forEach(item => {
      const handle = item.querySelector('.sort-handle');
      if (!handle) return;
      handle.addEventListener('touchstart', e => {
        e.preventDefault();
        const touch = e.touches[0];
        const rect = item.getBoundingClientRect();
        const placeholder = document.createElement('div');
        placeholder.className = 'sort-placeholder';
        placeholder.style.cssText = `height:${rect.height}px;margin-bottom:6px;border:2px dashed var(--accent);border-radius:var(--radius);background:transparent;box-sizing:border-box`;
        item.style.position = 'fixed';
        item.style.left = rect.left + 'px';
        item.style.width = rect.width + 'px';
        item.style.top = rect.top + 'px';
        item.style.zIndex = '9999';
        item.style.opacity = '0.9';
        item.style.boxShadow = '0 4px 16px rgba(0,0,0,0.2)';
        item.style.pointerEvents = 'none';
        item.style.transition = 'none';
        item.parentNode.insertBefore(placeholder, item);
        _promptDragState = {
          item, placeholder, container,
          idx: parseInt(item.dataset.sortIdx),
          group: item.dataset.group || '',
          startY: touch.clientY,
          itemTop: rect.top,
          scrollContainer: container.closest('.panel-content') || container.parentElement
        };
        document.addEventListener('touchmove', _onPromptSortTouchMove, { passive: false });
        document.addEventListener('touchend', _onPromptSortTouchEnd);
        document.addEventListener('touchcancel', _onPromptSortTouchEnd);
      }, { passive: false });
    });
  }
  function _onPromptSortTouchMove(e) {
    if (!_promptDragState) return;
    e.preventDefault();
    const touch = e.touches[0];
    const dy = touch.clientY - _promptDragState.startY;
    _promptDragState.item.style.top = (_promptDragState.itemTop + dy) + 'px';
    const sc = _promptDragState.scrollContainer;
    if (sc) {
      const scRect = sc.getBoundingClientRect();
      const edgeZone = 60, speed = 8;
      if (touch.clientY < scRect.top + edgeZone) sc.scrollTop -= speed;
      else if (touch.clientY > scRect.bottom - edgeZone) sc.scrollTop += speed;
    }
    const allItems = _promptDragState.container.querySelectorAll('.sort-item, .sort-placeholder');
    const dragCenterY = _promptDragState.itemTop + dy + _promptDragState.item.offsetHeight / 2;
    for (let i = 0; i < allItems.length; i++) {
      const el = allItems[i];
      if (el === _promptDragState.item) continue;
      if (el.classList.contains('sort-placeholder')) continue;
      // 组内限制：只和同分组的条目换位，跨组不动
      if ((el.dataset.group || '') !== _promptDragState.group) continue;
      const r = el.getBoundingClientRect();
      const midY = r.top + r.height / 2;
      const elIdx = parseInt(el.dataset.sortIdx);
      if (dragCenterY < midY && elIdx < _promptDragState.idx) {
        _promptDragState.container.insertBefore(_promptDragState.placeholder, el);
        break;
      } else if (dragCenterY > midY && elIdx > _promptDragState.idx) {
        if (el.nextSibling) _promptDragState.container.insertBefore(_promptDragState.placeholder, el.nextSibling);
        else _promptDragState.container.appendChild(_promptDragState.placeholder);
      }
    }
  }
  function _onPromptSortTouchEnd() {
    if (!_promptDragState) return;
    const { item, placeholder, container } = _promptDragState;
    item.style.position = '';
    item.style.left = '';
    item.style.width = '';
    item.style.top = '';
    item.style.zIndex = '';
    item.style.opacity = '';
    item.style.boxShadow = '';
    item.style.pointerEvents = '';
    item.style.transition = '';
    container.insertBefore(item, placeholder);
    placeholder.remove();
    // 根据 DOM 里 sort-item 的新顺序重建 _sortList
    const domItems = Array.from(container.querySelectorAll('.sort-item'));
    const newOrder = domItems.map(el => el.dataset.id);
    const byId = new Map(_sortList.map(p => [p.id, p]));
    const rebuilt = newOrder.map(id => byId.get(id)).filter(Boolean);
    if (rebuilt.length === _sortList.length) _sortList = rebuilt;
    _promptDragState = null;
    document.removeEventListener('touchmove', _onPromptSortTouchMove);
    document.removeEventListener('touchend', _onPromptSortTouchEnd);
    document.removeEventListener('touchcancel', _onPromptSortTouchEnd);
    // 重绘刷新序号/data-sort-idx（保证下次拖拽 idx 正确）
    _renderPromptSortList();
  }

  // 底栏「全选」图标态刷新
  async function _updatePromptSelectAllIcon() {
    const iconEl = document.getElementById('prompt-select-all-icon');
    if (!iconEl) return;
    const filtered = await _getFilteredPrompts();
    const allSelected = filtered.length > 0 && filtered.every(p => promptSelectedIds.has(p.id));
    if (allSelected) {
      iconEl.style.background = 'var(--accent)';
      iconEl.style.border = '2px solid var(--accent)';
      iconEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    } else {
      iconEl.style.background = '';
      iconEl.style.border = '2px solid var(--text-secondary)';
      iconEl.innerHTML = '';
    }
  }

  async function togglePromptSelectAll() {
    const filtered = await _getFilteredPrompts();
    const allSelected = filtered.length > 0 && filtered.every(p => promptSelectedIds.has(p.id));
    if (allSelected) {
      filtered.forEach(p => promptSelectedIds.delete(p.id));
    } else {
      filtered.forEach(p => promptSelectedIds.add(p.id));
    }
    await render();
    _updatePromptSelectAllIcon();
  }

  function togglePromptManageMode() {
    promptManageMode = !promptManageMode;
    promptSelectedIds.clear();
    const bar = document.getElementById('prompt-manage-bar');
    const btn = document.getElementById('prompt-manage-btn');
    const list = document.getElementById('prompts-list');
    if (promptManageMode) {
      if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
      if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg> 退出'; btn.style.background = 'var(--accent)'; btn.style.color = '#111'; btn.style.borderColor = 'var(--accent)'; }
      if (list) list.style.paddingBottom = '64px';
    } else {
      if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
      if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理'; btn.style.background = 'none'; btn.style.color = 'var(--text-secondary)'; btn.style.borderColor = 'var(--border)'; }
      if (list) list.style.paddingBottom = '';
    }
    render();
  }

  function exitPromptManageMode() {
    if (!promptManageMode) return;
    promptManageMode = false;
    promptSelectedIds.clear();
    const bar = document.getElementById('prompt-manage-bar');
    const btn = document.getElementById('prompt-manage-btn');
    const list = document.getElementById('prompts-list');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理'; btn.style.background = 'none'; btn.style.color = 'var(--text-secondary)'; btn.style.borderColor = 'var(--border)'; }
    if (list) list.style.paddingBottom = '';
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

    await _renderOverrideList(list);
    document.getElementById('prompt-override-modal').classList.remove('hidden');
  }

  async function _renderOverrideList(list) {
    const container = document.getElementById('prompt-override-list');
    if (!container) return;

    // 收集分组（与设置页 getGroups 一致，含独立分组数组）
    const groups = await getGroups();

    // 该对话最终生效状态（有覆盖用覆盖值，否则用全局 enabled）
    const _effEnabled = (p) => _overrideTemp.hasOwnProperty(p.id) ? _overrideTemp[p.id] : p.enabled;

    // 分组tabs（「全部」后插入虚拟「已选」）
    let tabsHtml = '';
    groups.forEach(g => {
      tabsHtml += `<button onclick="Prompts._switchOverrideGroup('${g}')" style="padding:4px 12px;border-radius:14px;border:1px solid ${g === _overrideGroup ? 'var(--accent)' : 'var(--border)'};background:${g === _overrideGroup ? 'var(--accent)' : 'transparent'};color:${g === _overrideGroup ? '#111' : 'var(--text-secondary)'};font-size:12px;cursor:pointer;white-space:nowrap">${Utils.escapeHtml(g)}</button>`;
      if (g === '全部') {
        const sa = _overrideGroup === SELECTED_GROUP;
        tabsHtml += `<button onclick="Prompts._switchOverrideGroup('${SELECTED_GROUP}')" style="padding:4px 12px;border-radius:14px;border:1px solid ${sa ? 'var(--accent)' : 'var(--border)'};background:${sa ? 'var(--accent)' : 'transparent'};color:${sa ? '#111' : 'var(--text-secondary)'};font-size:12px;cursor:pointer;white-space:nowrap">✓ 已选</button>`;
      }
    });

    // 过滤（统一走 _sortPrompts，保持与设置页显示顺序一致）
    const _isSelView = _overrideGroup === SELECTED_GROUP;
    const filtered = _sortPrompts(
      _isSelView
        ? list.filter(p => _effEnabled(p))
        : (_overrideGroup === '全部' ? list : list.filter(p => p.group === _overrideGroup))
    );

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
      <div style="display:flex;gap:8px;margin-bottom:8px;flex-shrink:0">
        <button onclick="Prompts._overrideGroupAll(true)" style="flex:1;padding:6px;border-radius:14px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);font-size:12px;cursor:pointer">全部开启</button>
        <button onclick="Prompts._overrideGroupAll(false)" style="flex:1;padding:6px;border-radius:14px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);font-size:12px;cursor:pointer">全部关闭</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">${listHtml}</div>`;
  }

  // 对话覆盖弹窗：把当前分组的提示词在本对话内全部开启/关闭（只改临时覆盖态，保存时才落库）
  async function _overrideGroupAll(enable) {
    const list = await getAll();
    const _eff = (p) => _overrideTemp.hasOwnProperty(p.id) ? _overrideTemp[p.id] : p.enabled;
    const filtered = _overrideGroup === SELECTED_GROUP
      ? list.filter(p => _eff(p))
      : (_overrideGroup === '全部' ? list : list.filter(p => p.group === _overrideGroup));
    if (!filtered.length) return;
    filtered.forEach(p => { _overrideTemp[p.id] = !!enable; });
    await _renderOverrideList(list);
  }

  let _overrideGroup = '全部';

  async function _switchOverrideGroup(group) {
    _overrideGroup = group;
    const list = await getAll();
    await _renderOverrideList(list);
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
      role: (p.role === 'user' || p.role === 'assistant') ? p.role : 'system',
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
      _exportedBy: 'SKYNEX',
      _exportedAt: new Date().toISOString(),
      _group: selectedGroup,
      prompts,
      prompt_order
    };

    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const safeName = (selectedGroup === '全部' ? '全部提示词' : selectedGroup).replace(/[\/\\:*?"<>|]/g, '_');
    const saved = await Utils.saveFile(blob, `prompts_${safeName}_${Date.now()}.json`);
    if (saved) UI.showToast(`已导出 ${prompts.length} 条提示词`, 2000);
  }

  // ===== 导入预设 =====
  async function importPreset() {
    const file = await Utils.pickFile({ accept: '.json,application/json' });
    if (!file) return;
    try {
      const text = await Utils.fileToText(file);
      const data = JSON.parse(text);
      const result = await _parseAndImport(data, file.name.replace(/\.json$/i, ''));
      UI.showToast(`已导入 ${result.imported} 条提示词${result.skipped ? `（跳过 ${result.skipped} 条空内容）` : ''}`, 2500);
      render();
    } catch(e) {
      console.error('[Prompts.importPreset]', e);
      await UI.showAlert('导入失败', '文件不是合法的 JSON，或格式不支持。\n\n' + (e.message || ''));
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

      // 注入位置
      let position = 'system_top';
      let depth = 0;
      if (p.injection_position === 1) {
        position = 'depth';
        // 注意 injection_depth 可能是 0（最新消息前，酒馆常用位置），不能用 `|| 4` 兜底
        const _d = parseInt(p.injection_depth);
        depth = Number.isFinite(_d) ? _d : 4;
      } else if (p.injection_position === 0 || p.injection_position === undefined) {
        position = 'system_top';
      }

      // 现在所有位置（top/bottom/depth）都支持真实 role（user/assistant/system）
      let finalContent = content;
      let finalRole = (role === 'user' || role === 'assistant') ? role : 'system';

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
        role: finalRole,
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

  return { getAll, add, edit, saveEdit, closeEdit, remove, toggle, buildInjections, render, resetView, getGroups, switchGroup, search,
    addPromptGroup, moveSelectedToGroup, _onGroupTabLongPress, _onGroupTabTouchStart, _onGroupTabTouchEnd, _onGroupTabClick,
    togglePromptSelect, togglePromptManageMode, exitPromptManageMode, batchDeletePrompts,
    togglePromptSelectAll, toggleGroupAll, movePrompt,
    enterPromptSortMode, exitPromptSortMode, savePromptSortOrder,
    _togglePositionDropdown, _selectPosition, _toggleRoleDropdown, _selectRole, _toggleScope, importPreset, exportPreset, toggleMenu,
    openConvOverrideModal, saveConvOverrides, resetConvOverrides, closeConvOverrideModal, _toggleOverride, _switchOverrideGroup, _overrideGroupAll, _editFromOverride };
})();