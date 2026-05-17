/**
 * 单人卡管理 — 独立角色（不挂世界观也能用）
 */
const SingleCard = (() => {
  let _editingId = null;
  
  // 管理模式
  let manageMode = false;
  let selectedIds = new Set();
  // 排序模式
  let sortMode = false;
  let sortedList = [];
  // 菜单
  let menuVisible = false;

  async function getAll() {
    return await DB.getAll('singleCards');
  }
  async function get(id) {
    return await DB.get('singleCards', id);
  }
  async function save(card) {
    if (!card.id) card.id = 'sc_' + Utils.uuid();
    if (!card.created) card.created = Date.now();
    card.updated = Date.now();
    await DB.put('singleCards', card);
    // v596：自动确保对应的隐藏世界观存在（用于扩展设定）
    try {
      if (typeof Worldview !== 'undefined' && Worldview.ensureHiddenWvForCard) {
        await Worldview.ensureHiddenWvForCard(card.id, card.name);
      }
    } catch(e) { console.warn('[SingleCard] 同步隐藏世界观失败', e); }
    // 清空所有引用这张卡的对话头像缓存
    try {
      const list = (typeof Conversations !== 'undefined') ? Conversations.getList() : [];
      list.forEach(c => {
        if (c.isSingle && c.singleCharType === 'card' && c.singleCharId === card.id) {
          Conversations.invalidateAvatarCache(c.id);
        }
      });
      if (typeof Conversations !== 'undefined') {
        Conversations.renderList && Conversations.renderList();
        Conversations.refreshTopbar && await Conversations.refreshTopbar();
      }
      try { Chat.refreshAiAvatar && await Chat.refreshAiAvatar(); } catch(e) {}
    } catch(e) {}
    return card.id;
  }
  async function remove(id) {
    await DB.del('singleCards', id);
    // v596：连带删除对应的隐藏世界观
    try {
      if (typeof Worldview !== 'undefined' && Worldview.deleteHiddenWvForCard) {
        await Worldview.deleteHiddenWvForCard(id);
      }
    } catch(e) { console.warn('[SingleCard] 删除隐藏世界观失败', e); }
  }

  // 列表渲染
  async function renderList(filterText) {
    if (sortMode) { _renderSortList(); return; }
    const container = document.getElementById('single-card-list');
    if (!container) return;
    const cards = await getAll();
    // 排序：有 sortOrder 的在前（升序），没有的按 updated 降序
    cards.sort((a, b) => {
      const hasA = typeof a.sortOrder === 'number';
      const hasB = typeof b.sortOrder === 'number';
      if (hasA && hasB) return a.sortOrder - b.sortOrder;
      if (hasA) return -1;
      if (hasB) return 1;
      return (b.updated || 0) - (a.updated || 0);
    });
    const q = (filterText || '').trim().toLowerCase();
    const filtered = q
      ? cards.filter(c =>
          (c.name || '').toLowerCase().includes(q) ||
          (c.aliases || '').toLowerCase().includes(q))
      : cards;
    if (filtered.length === 0) {
      container.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:40px 20px;font-size:13px">${q ? '没有匹配的角色' : '还没有角色，点右上菜单新建第一张'}</div>`;
      _updateSelectAllIcon();
      return;
    }
    container.innerHTML = filtered.map(c => {
      const checked = selectedIds.has(c.id);
      const clickHandler = manageMode
        ? `SingleCard._onCardClick('${c.id}')`
        : `SingleCard.edit('${c.id}')`;
      return `
      <div class="single-card-item" data-id="${c.id}" onclick="${clickHandler}" style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:12px;display:flex;align-items:center;gap:12px;cursor:pointer">
        ${manageMode ? `<span class="single-card-check-circle ${checked ? 'checked' : ''}" style="width:22px;height:22px;border-radius:50%;border:2px solid ${checked ? 'var(--accent)' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${checked ? 'background:var(--accent);' : ''}">
          ${checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
        </span>` : ''}
        <div style="width:48px;height:48px;border-radius:50%;flex-shrink:0;overflow:hidden;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center">
          ${c.avatar
            ? `<img src="${Utils.escapeHtml(c.avatar)}" style="width:100%;height:100%;object-fit:cover">`
            : `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/></svg>`}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.name || '未命名')}</div>
          ${c.aliases ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.aliases)}</div>` : ''}
          ${c.creator ? `<div style="font-size:11px;color:var(--text-tertiary,var(--text-secondary));margin-top:2px;opacity:0.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">by ${Utils.escapeHtml(c.creator)}</div>` : ''}
        </div>
        ${!manageMode ? `<button type="button" onclick="event.stopPropagation();SingleCard.quickCreateConversation('${c.id}')" style="flex-shrink:0;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap">创建对话</button>` : ''}
      </div>
    `;}).join('');
    _updateSelectAllIcon();
  }
  
  function _onCardClick(id) {
    if (!manageMode) return;
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    renderList(document.getElementById('single-card-search')?.value || '');
  }

  async function quickCreateConversation(cardId) {
    const card = await get(cardId);
    if (!card) { UI.showToast('未找到此角色'); return; }
    if (typeof UI !== 'undefined') UI.showPanel && UI.showPanel('chat', 'back');
    if (typeof SingleMode !== 'undefined' && SingleMode.openCreateModal) {
      await SingleMode.openCreateModal(null, { charType: 'card', charId: cardId });
    }
  }

  // 新建（v594：走新 panel）
  function create() {
    _scAutoSave.cancel();
    _editingId = null;
    _openEditPanel({ name: '', aliases: '', detail: '', avatar: '', extEnabled: true });
  }

  // 编辑（v594：改走全屏 panel）
  async function edit(id) {
    _scAutoSave.cancel(); // 切卡时取消上一张的挂起自动保存
    const card = await get(id);
    if (!card) { UI.showToast('未找到此角色'); return; }
    _editingId = id;
    _openEditPanel(card);
  }

  // 单人卡自动保存（仅编辑已有卡时触发，新建卡无 ID 不自动保存）
  // 带 cancel 方法，关闭/切卡时清除挂起的 timer 防止竞态
  let _autoSaveTimer = null;
  const _scAutoSave = (() => {
    const fn = async () => {
      _autoSaveTimer = null;
      if (!_editingId) return;
      try {
        const targetId = _editingId; // 快照当前 ID，防止 await 期间变化
        const card = await get(targetId);
        if (!card) return;
        if (_editingId !== targetId) return; // 再检查一次：如果中间切卡了就放弃
        // 优先读 panel 字段（v594），不存在再读旧 modal
        const panelEl = document.getElementById('sc-panel-name');
        if (panelEl && document.getElementById('panel-single-card-edit')?.classList.contains('active')) {
          card.name = (panelEl.value || '').trim() || card.name;
          card.aliases = document.getElementById('sc-panel-aliases')?.value || '';
          card.detail = document.getElementById('sc-panel-detail')?.value || '';
          card.firstMes = document.getElementById('sc-panel-firstmes')?.value || '';
          card.mesExample = document.getElementById('sc-panel-mesexample')?.value || '';
          card.creator = document.getElementById('sc-panel-creator')?.value || '';
          card.creatorNotes = document.getElementById('sc-panel-creatornotes')?.value || '';
          const extEl = document.getElementById('sc-panel-ext-enabled');
          if (extEl) card.extEnabled = extEl.checked;
          const avatarEl = document.querySelector('#sc-panel-avatar-preview img, #sc-panel-avatar-preview div');
          if (avatarEl) card.avatar = avatarEl.dataset.value || '';
        } else {
          card.name = (document.getElementById('sc-edit-name')?.value || '').trim() || card.name;
          card.aliases = document.getElementById('sc-edit-aliases')?.value || '';
          card.detail = document.getElementById('sc-edit-detail')?.value || '';
          card.firstMes = document.getElementById('sc-edit-firstmes')?.value || '';
          card.mesExample = document.getElementById('sc-edit-mesexample')?.value || '';
          card.creator = document.getElementById('sc-edit-creator')?.value || '';
          card.creatorNotes = document.getElementById('sc-edit-creatornotes')?.value || '';
        }
        if (_editingId !== targetId) return; // await save 前再检查
        await save(card);
      } catch(e) { console.warn('[SingleCard] 自动保存失败', e); }
    };
    const debounced = (...args) => {
      clearTimeout(_autoSaveTimer);
      _autoSaveTimer = setTimeout(() => fn(...args), 1500);
    };
    debounced.cancel = () => { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; };
    return debounced;
  })();

  function _attachSCAutoSave() {
    // 新 panel 自动保存绑定
    const panel = document.getElementById('panel-single-card-edit');
    if (panel) {
      panel.querySelectorAll('input, textarea').forEach(el => {
        el.removeEventListener('input', _scAutoSave);
        el.addEventListener('input', _scAutoSave);
      });
      // 总开关切换也算改动
      const ext = document.getElementById('sc-panel-ext-enabled');
      if (ext) {
        ext.removeEventListener('change', _scAutoSave);
        ext.addEventListener('change', _scAutoSave);
      }
    }
    // 旧 modal 自动保存绑定（兼容）
    const modal = document.getElementById('sc-edit-modal');
    if (modal) {
      modal.querySelectorAll('input, textarea').forEach(el => {
        el.removeEventListener('input', _scAutoSave);
        el.addEventListener('input', _scAutoSave);
      });
    }
  }

  // ===== v594 新 panel 入口 =====
  function _openEditPanel(card) {
    // 跳到 panel
    UI.showPanel('single-card-edit');
    // 标题
    const titleEl = document.getElementById('sc-edit-title');
    if (titleEl) titleEl.textContent = _editingId ? '编辑角色' : '新建角色';
    // 删除按钮显隐（菜单里那个）
    const delBtn = document.getElementById('sc-edit-delete-btn');
    if (delBtn) delBtn.style.display = _editingId ? '' : 'none';
    // 默认切到基础 tab
    switchEditTab('basic');
    // 填充字段
    document.getElementById('sc-panel-name').value = card.name || '';
    document.getElementById('sc-panel-aliases').value = card.aliases || '';
    document.getElementById('sc-panel-detail').value = card.detail || '';
    document.getElementById('sc-panel-firstmes').value = card.firstMes || '';
    document.getElementById('sc-panel-mesexample').value = card.mesExample || '';
    document.getElementById('sc-panel-creator').value = card.creator || '';
    document.getElementById('sc-panel-creatornotes').value = card.creatorNotes || '';
    // 头像
    const avatarPreview = document.getElementById('sc-panel-avatar-preview');
    if (card.avatar) {
      avatarPreview.innerHTML = `<img src="${Utils.escapeHtml(card.avatar)}" data-value="${Utils.escapeHtml(card.avatar)}" style="width:80px;height:80px;border-radius:50%;object-fit:cover">`;
    } else {
      avatarPreview.innerHTML = `<div data-value="" style="width:80px;height:80px;border-radius:50%;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:32px">+</div>`;
    }
    // 扩展设定总开关（默认 true，旧卡没这字段视为开启）
    const extEnabled = card.extEnabled !== false;
    document.getElementById('sc-panel-ext-enabled').checked = extEnabled;
    // 绑定自动保存
    requestAnimationFrame(_attachSCAutoSave);
    // 详情自适应高度
    setTimeout(() => {
      const ta = document.getElementById('sc-panel-detail');
      if (ta) {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      }
    }, 50);
  }

  function switchEditTab(name) {
    document.querySelectorAll('.sc-edit-tab-content').forEach(el => el.classList.add('hidden'));
    const target = document.getElementById('sc-edit-tab-' + name);
    if (target) target.classList.remove('hidden');
    document.querySelectorAll('.wv-edit-tab-btn[data-sctab]').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.wv-edit-tab-btn[data-sctab="${name}"]`);
    if (btn) btn.classList.add('active');
  }

  function toggleEditMoreMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('sc-edit-more-menu');
    if (!menu) return;
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    if (willOpen) {
      setTimeout(() => {
        const onDocClick = (ev) => {
          if (!menu.contains(ev.target)) {
            menu.classList.add('hidden');
            document.removeEventListener('click', onDocClick);
          }
        };
        document.addEventListener('click', onDocClick);
      }, 0);
    }
  }
  function closeEditMoreMenu() {
    const menu = document.getElementById('sc-edit-more-menu');
    if (menu) menu.classList.add('hidden');
  }

  function closeEditPanel() {
    _scAutoSave.cancel();
    _editingId = null;
    UI.showPanel('worldview', 'back');
    if (typeof Worldview !== 'undefined' && Worldview.switchWorldTab) {
      Worldview.switchWorldTab('char');
    }
  }

  // v596：从扩展设定面板返回时，重新打开单人卡编辑面板（恢复状态）
  async function restoreEditPanel() {
    if (!_editingId) {
      // 没有编辑中的卡，退回列表
      UI.showPanel('worldview', 'back');
      if (typeof Worldview !== 'undefined' && Worldview.switchWorldTab) {
        Worldview.switchWorldTab('char');
      }
      return;
    }
    const card = await get(_editingId);
    if (!card) {
      UI.showPanel('worldview', 'back');
      return;
    }
    _openEditPanel(card);
  }

  // v596：打开本卡扩展设定的编辑面板（进入对应的隐藏世界观）
  async function openCardExtEdit() {
    if (!_editingId) {
      UI.showToast('请先保存角色，让它获得 ID 后再编辑扩展设定', 2500);
      return;
    }
    // 先自动保存，防止跳转丢失基础 tab 的改动
    try { _scAutoSave.cancel(); } catch(e) {}
    try {
      const card = await get(_editingId);
      if (!card) { UI.showToast('未找到此角色'); return; }
      const wv = await Worldview.ensureHiddenWvForCard(card.id, card.name);
      if (!wv) { UI.showToast('初始化扩展设定失败'); return; }
      // 跳到世界观编辑面板；标记返回路径
      Worldview.openEdit(wv.id, { returnTo: 'single-card-edit' });
    } catch(e) {
      console.warn('[SingleCard] 打开扩展设定失败', e);
      UI.showToast('打开失败：' + (e.message || e));
    }
  }

  async function pickAvatarPanel() {
    const dataUrl = await Utils.promptImageInput({ maxSize: 256, quality: 0.85 });
    if (!dataUrl) return;
    const preview = document.getElementById('sc-panel-avatar-preview');
    preview.innerHTML = `<img src="${dataUrl}" data-value="${dataUrl}" style="width:80px;height:80px;border-radius:50%;object-fit:cover">`;
    _scAutoSave();
  }

  // 从 panel 读字段并保存
  async function savePanelForm() {
    const name = document.getElementById('sc-panel-name').value.trim();
    if (!name) { UI.showToast('请填写姓名'); return; }
    const aliases = document.getElementById('sc-panel-aliases').value.trim();
    const detail = document.getElementById('sc-panel-detail').value.trim();
    const firstMes = (document.getElementById('sc-panel-firstmes')?.value || '').trim();
    const mesExample = (document.getElementById('sc-panel-mesexample')?.value || '').trim();
    const creator = (document.getElementById('sc-panel-creator')?.value || '').trim();
    const creatorNotes = (document.getElementById('sc-panel-creatornotes')?.value || '').trim();
    const avatarEl = document.querySelector('#sc-panel-avatar-preview img, #sc-panel-avatar-preview div');
    const avatar = avatarEl ? (avatarEl.dataset.value || '') : '';
    const extEnabled = document.getElementById('sc-panel-ext-enabled').checked;
    const card = _editingId ? (await get(_editingId)) : {};
    card.name = name;
    card.aliases = aliases;
    card.detail = detail;
    card.avatar = avatar;
    card.firstMes = firstMes;
    card.mesExample = mesExample;
    card.creator = creator;
    card.creatorNotes = creatorNotes;
    card.extEnabled = extEnabled;
    if (_editingId) card.id = _editingId;
    await save(card);
    closeEditPanel();
    await renderList();
    UI.showToast('已保存');
  }

  // ===== 旧 modal 兼容入口（保留作回滚保险）=====
  function _openEditModal(card) {
    document.getElementById('sc-edit-name').value = card.name || '';
    document.getElementById('sc-edit-aliases').value = card.aliases || '';
    document.getElementById('sc-edit-detail').value = card.detail || '';
    const fm = document.getElementById('sc-edit-firstmes'); if (fm) fm.value = card.firstMes || '';
    const me = document.getElementById('sc-edit-mesexample'); if (me) me.value = card.mesExample || '';
    const cr = document.getElementById('sc-edit-creator'); if (cr) cr.value = card.creator || '';
    const cn = document.getElementById('sc-edit-creatornotes'); if (cn) cn.value = card.creatorNotes || '';
    const avatarPreview = document.getElementById('sc-edit-avatar-preview');
    if (card.avatar) {
      avatarPreview.innerHTML = `<img src="${Utils.escapeHtml(card.avatar)}" data-value="${Utils.escapeHtml(card.avatar)}" style="width:80px;height:80px;border-radius:50%;object-fit:cover">`;
    } else {
      avatarPreview.innerHTML = `<div data-value="" style="width:80px;height:80px;border-radius:50%;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:32px">+</div>`;
    }
    document.getElementById('sc-delete-btn').style.display = _editingId ? '' : 'none';
    document.getElementById('sc-edit-modal').classList.remove('hidden');
    // 绑定自动保存（新建卡 _editingId 为 null，save 内部会跳过）
    requestAnimationFrame(_attachSCAutoSave);
    setTimeout(() => {
      const ta = document.getElementById('sc-edit-detail');
      if (ta) {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      }
    }, 50);
  }

  function closeEditModal() {
    _scAutoSave.cancel(); // 取消挂起的自动保存，防止关闭后写脏数据
    document.getElementById('sc-edit-modal').classList.add('hidden');
    _editingId = null;
  }

  async function saveFromModal() {
    const name = document.getElementById('sc-edit-name').value.trim();
    if (!name) { UI.showToast('请填写姓名'); return; }
    const aliases = document.getElementById('sc-edit-aliases').value.trim();
    const detail = document.getElementById('sc-edit-detail').value.trim();
    const firstMes = (document.getElementById('sc-edit-firstmes')?.value || '').trim();
    const mesExample = (document.getElementById('sc-edit-mesexample')?.value || '').trim();
    const creator = (document.getElementById('sc-edit-creator')?.value || '').trim();
    const creatorNotes = (document.getElementById('sc-edit-creatornotes')?.value || '').trim();
    const avatarEl = document.querySelector('#sc-edit-avatar-preview img, #sc-edit-avatar-preview div');
    const avatar = avatarEl ? (avatarEl.dataset.value || '') : '';
    const card = _editingId ? await get(_editingId) : {};
    card.name = name;
    card.aliases = aliases;
    card.detail = detail;
    card.avatar = avatar;
    card.firstMes = firstMes;
    card.mesExample = mesExample;
    card.creator = creator;
    card.creatorNotes = creatorNotes;
    if (_editingId) card.id = _editingId;
    await save(card);
    closeEditModal();
    await renderList();
    UI.showToast('已保存');
  }

  async function deleteCurrent() {
    if (!_editingId) return;
    const ok = await UI.confirm('确定删除这个角色？相关对话不会被删除，但角色资料会丢失');
    if (!ok) return;
    await remove(_editingId);
    // 兼容新旧入口
    if (document.getElementById('panel-single-card-edit')?.classList.contains('active')) {
      closeEditPanel();
    } else {
      closeEditModal();
    }
    await renderList();
    UI.showToast('已删除');
  }

  // 选择头像（复用世界观图片选择逻辑或简单的文件上传）
  function pickAvatar() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        const preview = document.getElementById('sc-edit-avatar-preview');
        preview.innerHTML = `<img src="${dataUrl}" data-value="${dataUrl}" style="width:80px;height:80px;border-radius:50%;object-fit:cover">`;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  // 格式化为 prompt（核心：单人模式注入用）
  function formatForPrompt(card) {
    if (!card) return '';
    let text = `【AI 扮演角色】\n你将扮演以下角色与用户进行一对一对话。请始终以这个角色的视角说话和行动，不要扮演用户。\n\n姓名：${card.name}`;
    if (card.aliases) text += `\n别称/代号：${card.aliases}`;
    if (card.detail) text += `\n\n${card.detail}`;
    if (card.mesExample) text += `\n\n【对话样例】（参考其语气和风格，不要照抄）\n${card.mesExample}`;
    return text;
  }

  // ===== 导入 / 导出 =====
  function exportCurrent() {
    if (!_editingId) { UI.showToast('请先保存后再导出'); return; }
    get(_editingId).then(card => {
      if (!card) return;
      const data = {
        __format: 'tianshu_single_card_v1',
        name: card.name || '',
        aliases: card.aliases || '',
        detail: card.detail || '',
        avatar: card.avatar || '',
        firstMes: card.firstMes || '',
        mesExample: card.mesExample || '',
        creator: card.creator || '',
        creatorNotes: card.creatorNotes || ''
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(card.name || 'card').replace(/[\\/:*?"<>|]/g, '_')}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      UI.showToast(`已导出「${card.name || 'card'}」`, 1800);
    });
  }

  function importCard() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.png,application/json,image/png';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        // 先尝试批量格式
        if (file.name.toLowerCase().endsWith('.json') || file.type === 'application/json') {
          const text = await file.text();
          let json;
          try { json = JSON.parse(text); } catch (_) { json = null; }
          if (json && json.__format === 'tianshu_single_card_v1_batch' && Array.isArray(json.cards)) {
            let count = 0;
            for (const c of json.cards) {
              const copy = JSON.parse(JSON.stringify(c));
              delete copy.id;
              delete copy.created;
              delete copy.updated;
              delete copy.sortOrder;
              await save(copy);
              count++;
            }
            await renderList();
            UI.showToast(`已导入 ${count} 个角色`);
            return;
          }
        }
        let parsed;
        if (file.name.toLowerCase().endsWith('.png') || file.type === 'image/png') {
          parsed = await _parsePngCard(file);
        } else {
          const text = await file.text();
          parsed = _parseJsonCard(text);
        }
        if (!parsed) { UI.showToast('无法识别该文件'); return; }
        if (parsed.__warnLoreBook) {
          UI.showToast('该卡含世界书未导入，可能影响表现', 4000);
        }
        const newCard = {
          name: parsed.name || '未命名',
          aliases: parsed.aliases || '',
          detail: parsed.detail || '',
          avatar: parsed.avatar || '',
          firstMes: parsed.firstMes || '',
          mesExample: parsed.mesExample || '',
          creator: parsed.creator || '',
          creatorNotes: parsed.creatorNotes || ''
        };
        await save(newCard);
        await renderList();
        UI.showToast(`已导入：${newCard.name}`);
      } catch (err) {
        console.error('[importCard]', err);
        UI.showToast('导入失败：' + (err.message || err));
      }
    };
    input.click();
  }

  // 解析 JSON 卡：兼容自家格式 + 通用 v1/v2
  function _parseJsonCard(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) { return null; }
    // 自家格式
    if (json.__format === 'tianshu_single_card_v1') {
      return json;
    }
    return _normalizeExternalCard(json);
  }

  // 把外部 JSON 卡映射到本应用格式
  function _normalizeExternalCard(json) {
    if (!json) return null;
    // v2 格式把核心字段塞在 data 字段里
    const v2 = (json.spec === 'chara_card_v2' && json.data) ? json.data : null;
    const src = v2 || json;
    const name = src.name || src.char_name || '未命名';
    const description = src.description || '';
    const personality = src.personality || '';
    const scenario = src.scenario || '';
    const firstMes = src.first_mes || src.first_message || '';
    const mesExample = src.mes_example || '';
    const creator = src.creator || src.creator_name || '';
    const creatorNotes = src.creator_notes || src.creatorcomment || '';
    const tags = Array.isArray(src.tags) ? src.tags.join(', ') : (src.tags || '');
    // 拼接 detail
    const parts = [];
    if (description) parts.push(description);
    if (personality) parts.push(`【性格】\n${personality}`);
    if (scenario) parts.push(`【场景】\n${scenario}`);
    const detail = parts.join('\n\n');
    const hasLoreBook = !!(src.character_book && (src.character_book.entries || []).length > 0);
    return {
      name, detail, firstMes, mesExample, creator, creatorNotes,
      aliases: tags,
      avatar: '',
      __warnLoreBook: hasLoreBook
    };
  }

  // 解析 PNG 卡（嵌入元数据的角色卡 PNG）
  async function _parsePngCard(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // 校验 PNG 签名
    const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== sig[i]) throw new Error('不是有效的 PNG 文件');
    }
    // 遍历 chunk，找 tEXt / iTXt 中 keyword === 'chara' 或 'ccv3'
    let pos = 8;
    let charaB64 = null;
    let ccv3B64 = null;
    while (pos < bytes.length) {
      const length = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
      pos += 4;
      const type = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      pos += 4;
      const dataStart = pos;
      const dataEnd = dataStart + length;
      if (type === 'tEXt' || type === 'iTXt') {
        // 找 keyword 结束的 \0
        let nullIdx = dataStart;
        while (nullIdx < dataEnd && bytes[nullIdx] !== 0) nullIdx++;
        const keyword = new TextDecoder().decode(bytes.slice(dataStart, nullIdx));
        let valueStart = nullIdx + 1;
        // iTXt 还有 compression flag/method, language tag, translated keyword 各跳一段
        if (type === 'iTXt') {
          valueStart += 2; // compression flag + method
          // language tag
          while (valueStart < dataEnd && bytes[valueStart] !== 0) valueStart++;
          valueStart++;
          // translated keyword
          while (valueStart < dataEnd && bytes[valueStart] !== 0) valueStart++;
          valueStart++;
        }
        const value = new TextDecoder().decode(bytes.slice(valueStart, dataEnd));
        if (keyword === 'chara') charaB64 = value;
        else if (keyword === 'ccv3') ccv3B64 = value;
      }
      pos = dataEnd + 4; // 跳过 CRC
      if (type === 'IEND') break;
    }
    const b64 = ccv3B64 || charaB64;
    if (!b64) throw new Error('未在 PNG 中找到角色卡数据');
    // base64 → utf8 字符串
    let jsonStr;
    try {
      const binary = atob(b64.replace(/\s+/g, ''));
      const u8 = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
      jsonStr = new TextDecoder('utf-8').decode(u8);
    } catch (e) {
      throw new Error('卡片数据解码失败');
    }
    let json;
    try { json = JSON.parse(jsonStr); } catch (e) { throw new Error('卡片 JSON 解析失败'); }
    const normalized = _normalizeExternalCard(json);
    if (!normalized) throw new Error('卡片格式无法识别');
    // PNG 本体作为头像
    normalized.avatar = await _fileToDataUrl(file);
    return normalized;
  }

  function _fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  // ===== 世界观角色头像库 =====
  function switchCharSubtab(tab) {
    const cardBtn = document.getElementById('char-subtab-card-btn');
    const npcBtn = document.getElementById('char-subtab-npc-btn');
    const cardPane = document.getElementById('char-subtab-card');
    const npcPane = document.getElementById('char-subtab-npc');
    const _play = (el, dir) => {
      el.classList.remove('tab-pane-enter-left', 'tab-pane-enter-right');
      void el.offsetWidth;
      el.classList.add(dir === 'left' ? 'tab-pane-enter-left' : 'tab-pane-enter-right');
    };
    if (tab === 'npc') {
      cardBtn.style.background = 'none';
      cardBtn.style.color = 'var(--text-secondary)';
      cardBtn.style.border = '1px solid var(--border)';
      npcBtn.style.background = 'var(--accent)';
      npcBtn.style.color = '#111';
      npcBtn.style.border = 'none';
      cardPane.style.display = 'none';
      npcPane.style.display = 'block';
      _play(npcPane, 'right');
      renderNpcAvatarList('');
    } else {
      npcBtn.style.background = 'none';
      npcBtn.style.color = 'var(--text-secondary)';
      npcBtn.style.border = '1px solid var(--border)';
      cardBtn.style.background = 'var(--accent)';
      cardBtn.style.color = '#111';
      cardBtn.style.border = 'none';
      cardPane.style.display = 'block';
      npcPane.style.display = 'none';
      _play(cardPane, 'left');
    }
  }

  // 收集所有世界观下所有 NPC，附带头像缓存
  async function _collectAllNpcs() {
    const wvs = await DB.getAll('worldviews');
    const list = [];
    for (const wv of wvs) {
      if (wv.id === '__default_wv__') continue;
      if (wv._hidden) continue;
      // 全图 NPC（不归属地区/势力）
      (wv.globalNpcs || []).forEach(n => {
        list.push({
          id: n.id,
          name: n.name || '未命名',
          aliases: n.aliases || '',
          wvId: wv.id,
          wvName: wv.name || '',
          regionName: '全图 NPC',
          factionName: '—'
        });
      });
      (wv.regions || []).forEach(r => {
        (r.factions || []).forEach(f => {
          (f.npcs || []).forEach(n => {
            list.push({
              id: n.id,
              name: n.name || '未命名',
              aliases: n.aliases || '',
              wvId: wv.id,
              wvName: wv.name || '',
              regionName: r.name || '',
              factionName: f.name || ''
            });
          });
        });
      });
    }
    // 拉取所有 npcAvatars
    const avatars = await DB.getAll('npcAvatars');
    const avatarMap = {};
    avatars.forEach(a => { avatarMap[a.id] = a.avatar; });
    list.forEach(n => { n.avatar = avatarMap[n.id] || ''; });
    return list;
  }

  async function getNpcAvatar(npcId) {
    if (!npcId) return '';
    try {
      const r = await DB.get('npcAvatars', npcId);
      return r?.avatar || '';
    } catch(e) { return ''; }
  }

  async function setNpcAvatar(npcId, avatarUrl) {
    if (!npcId) return;
    if (avatarUrl) {
      await DB.put('npcAvatars', { id: npcId, avatar: avatarUrl, updated: Date.now() });
    } else {
      await DB.del('npcAvatars', npcId);
    }
    // 通知 UI 刷新
    try {
      if (typeof Conversations !== 'undefined') {
        Conversations.invalidateAvatarCache && Conversations.invalidateAvatarCache();
        Conversations.renderList && Conversations.renderList();
        Conversations.refreshTopbar && await Conversations.refreshTopbar();
      }
      if (typeof Chat !== 'undefined') {
        Chat.refreshAiAvatar && await Chat.refreshAiAvatar();
        Chat.refreshOnlineChatAvatars && await Chat.refreshOnlineChatAvatars();
        if (!(typeof HeartSimIntro !== 'undefined' && HeartSimIntro.isMaskSwitchLocked && HeartSimIntro.isMaskSwitchLocked())) {
          Chat.renderAll && Chat.renderAll();
        }
      }
      if (typeof HeartSimIntro !== 'undefined') {
        // 非阻塞刷新，避免头像保存流程拖慢侧边栏/对话切换响应
        setTimeout(() => { try { HeartSimIntro.refreshNpcAvatars && HeartSimIntro.refreshNpcAvatars(); } catch(_) {} }, 0);
      }
    } catch(e) {}
  }

  async function renderNpcAvatarList(filter) {
    const container = document.getElementById('npc-avatar-list');
    if (!container) return;
    const q = (filter || '').trim().toLowerCase();
    const npcs = await _collectAllNpcs();
    const filtered = q ? npcs.filter(n =>
      (n.name).toLowerCase().includes(q) ||
      (n.aliases).toLowerCase().includes(q) ||
      (n.wvName).toLowerCase().includes(q) ||
      (n.regionName).toLowerCase().includes(q) ||
      (n.factionName).toLowerCase().includes(q)
    ) : npcs;

    if (filtered.length === 0) {
      container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px">${q ? '没有匹配的角色' : '没有角色，先到世界观管理添加'}</div>`;
      return;
    }
    container.innerHTML = filtered.map(n => {
      const subtitle = `${Utils.escapeHtml(n.wvName)} / ${Utils.escapeHtml(n.regionName)} / ${Utils.escapeHtml(n.factionName)}`;
      const avatarHtml = n.avatar
        ? `<img src="${Utils.escapeHtml(n.avatar)}" style="width:100%;height:100%;object-fit:cover">`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/></svg>`;
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary)">
        <div onclick="SingleCard._pickNpcAvatar('${n.id}')" style="width:40px;height:40px;border-radius:50%;flex-shrink:0;overflow:hidden;background:var(--bg);display:flex;align-items:center;justify-content:center;cursor:pointer">${avatarHtml}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(n.name)}${n.aliases ? `<span style="color:var(--text-secondary);font-size:12px"> · ${Utils.escapeHtml(n.aliases)}</span>` : ''}</div>
          <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${subtitle}</div>
        </div>
        ${n.avatar ? `<button type="button" onclick="SingleCard._removeNpcAvatar('${n.id}')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px" title="删除头像"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>` : ''}
      </div>`;
    }).join('');
  }

  async function _pickNpcAvatar(npcId) {
    const dataUrl = await Utils.promptImageInput({ maxSize: 256, quality: 0.85 });
    if (!dataUrl) return;
    await setNpcAvatar(npcId, dataUrl);
    renderNpcAvatarList(document.getElementById('npc-avatar-search')?.value || '');
    UI.showToast('头像已更新');
  }

  async function _removeNpcAvatar(npcId) {
    if (!await UI.showConfirm('确认删除', '删除该 NPC 的自定义头像？')) return;
    await setNpcAvatar(npcId, '');
    renderNpcAvatarList(document.getElementById('npc-avatar-search')?.value || '');
    UI.showToast('已删除');
  }
  
  // ===== v614 菜单 / 批量 / 排序（对齐 Memory & Worldview） =====
  function toggleMenu() {
    const dropdown = document.getElementById('single-card-menu-dropdown');
    if (!dropdown) return;
    menuVisible = !menuVisible;
    if (menuVisible) {
      dropdown.classList.remove('hidden', 'closing');
      setTimeout(() => {
        document.addEventListener('click', _closeMenuOutside, { once: true });
      }, 0);
    } else {
      dropdown.classList.add('closing');
      setTimeout(() => {
        dropdown.classList.add('hidden');
        dropdown.classList.remove('closing');
      }, 120);
    }
  }
  function _closeMenuOutside(e) {
    const btn = document.getElementById('single-card-menu-btn');
    if (btn && btn.contains(e.target)) return;
    menuVisible = false;
    const dropdown = document.getElementById('single-card-menu-dropdown');
    if (dropdown) {
      dropdown.classList.add('closing');
      setTimeout(() => {
        dropdown.classList.add('hidden');
        dropdown.classList.remove('closing');
      }, 120);
    }
  }
  
  // ----- 管理模式 -----
  async function toggleManageMode() {
    if (manageMode) { exitManageMode(); return; }
    if (sortMode) exitSortMode();
    manageMode = true;
    const bar = document.getElementById('single-card-manage-bar');
    if (bar) bar.classList.remove('hidden');
    const container = document.getElementById('single-card-list');
    if (container) container.style.paddingBottom = '72px';
    await renderList(document.getElementById('single-card-search')?.value || '');
  }
  function exitManageMode() {
    manageMode = false;
    selectedIds.clear();
    const bar = document.getElementById('single-card-manage-bar');
    if (bar) bar.classList.add('hidden');
    const container = document.getElementById('single-card-list');
    if (container) container.style.paddingBottom = '';
    renderList(document.getElementById('single-card-search')?.value || '');
  }
  async function toggleSelectAll() {
    const container = document.getElementById('single-card-list');
    const allIds = Array.from(container.querySelectorAll('.single-card-item')).map(el => el.dataset.id);
    const allSelected = allIds.length > 0 && allIds.every(id => selectedIds.has(id));
    if (allSelected) selectedIds.clear();
    else allIds.forEach(id => selectedIds.add(id));
    await renderList(document.getElementById('single-card-search')?.value || '');
  }
  function _updateSelectAllIcon() {
    const iconEl = document.getElementById('single-card-select-all-icon');
    if (!iconEl) return;
    const container = document.getElementById('single-card-list');
    if (!container) return;
    const allIds = Array.from(container.querySelectorAll('.single-card-item')).map(el => el.dataset.id);
    const allSelected = allIds.length > 0 && allIds.every(id => selectedIds.has(id));
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
  
  // 批量导出
  async function exportSelected() {
    if (selectedIds.size === 0) { await UI.showAlert('提示', '请先选择角色'); return; }
    const cards = [];
    for (const id of selectedIds) {
      const c = await get(id);
      if (c) cards.push(c);
    }
    if (cards.length === 0) { UI.showToast('未找到可导出的角色'); return; }
    const exportData = { __format: 'tianshu_single_card_v1_batch', cards };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `single_cards_${cards.length}个_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    UI.showToast(`已导出 ${cards.length} 个角色`);
  }
  
  // 批量复制
  async function batchClone() {
    if (selectedIds.size === 0) { await UI.showAlert('提示', '请先选择角色'); return; }
    let count = 0;
    for (const id of selectedIds) {
      const c = await get(id);
      if (!c) continue;
      const copy = JSON.parse(JSON.stringify(c));
      delete copy.id;
      delete copy.created;
      delete copy.updated;
      delete copy.sortOrder;
      copy.name = (copy.name || '未命名') + ' (副本)';
      await save(copy);
      count++;
    }
    selectedIds.clear();
    await renderList(document.getElementById('single-card-search')?.value || '');
    UI.showToast(`已复制 ${count} 个角色`);
  }
  
  // 批量删除
  async function batchDelete() {
    if (selectedIds.size === 0) { await UI.showAlert('提示', '请先选择角色'); return; }
    if (!await UI.showConfirm('批量删除', `确定删除选中的 ${selectedIds.size} 个角色？\n\n关联对话不会被删除，但会失去角色绑定。`)) return;
    for (const id of selectedIds) {
      await remove(id);
    }
    selectedIds.clear();
    exitManageMode();
    UI.showToast('已删除');
  }
  
  // ----- 排序模式 -----
  async function toggleSortMode() {
    if (sortMode) { exitSortMode(); return; }
    if (manageMode) exitManageMode();
    sortMode = true;
    const cards = await getAll();
    sortedList = cards.slice().sort((a, b) => {
      const hasA = typeof a.sortOrder === 'number';
      const hasB = typeof b.sortOrder === 'number';
      if (hasA && hasB) return a.sortOrder - b.sortOrder;
      if (hasA) return -1;
      if (hasB) return 1;
      return (b.updated || 0) - (a.updated || 0);
    });
    _renderSortList();
  }
  function exitSortMode() {
    sortMode = false;
    sortedList = [];
    const bar = document.getElementById('single-card-sort-bar');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    const container = document.getElementById('single-card-list');
    if (container) container.style.paddingBottom = '';
    renderList(document.getElementById('single-card-search')?.value || '');
  }
  function _renderSortList() {
    const container = document.getElementById('single-card-list');
    if (!container) return;
    container.style.paddingBottom = '72px';
    const bar = document.getElementById('single-card-sort-bar');
    if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
    container.innerHTML = sortedList.length === 0 ?
      '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无角色</p>' :
      sortedList.map((c, i) => {
        const sub = c.aliases || c.creator || '';
        return `
        <div class="sort-item" style="display:flex;align-items:center;gap:8px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:6px;transition:transform 0.15s ease,opacity 0.15s ease" data-sort-idx="${i}" data-id="${c.id}">
          <div class="sort-handle" style="display:flex;align-items:center;justify-content:center;width:24px;flex-shrink:0;cursor:grab;color:var(--text-secondary);font-size:18px;user-select:none;-webkit-user-select:none;touch-action:none">≡</div>
          <div style="flex:1;overflow:hidden">
            <h3 style="margin:0 0 2px 0;font-size:13px;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.name || '未命名')}</h3>
            <p style="margin:0;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(sub || '—')}</p>
          </div>
          <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0">${i + 1}</span>
        </div>`;
      }).join('');
    _bindSortDrag(container);
  }
  let _dragState = null;
  function _bindSortDrag(container) {
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
        placeholder.style.cssText = `height:${rect.height}px;margin-bottom:6px;border:2px dashed var(--border);border-radius:var(--radius);background:transparent;box-sizing:border-box`;
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
        _dragState = {
          item, placeholder, container,
          idx: parseInt(item.dataset.sortIdx),
          startY: touch.clientY,
          itemTop: rect.top,
          itemHeight: rect.height + 6,
          scrollContainer: container.closest('.panel-content') || container.parentElement
        };
        document.addEventListener('touchmove', _onSortTouchMove, { passive: false });
        document.addEventListener('touchend', _onSortTouchEnd);
        document.addEventListener('touchcancel', _onSortTouchEnd);
      }, { passive: false });
    });
  }
  function _onSortTouchMove(e) {
    if (!_dragState) return;
    e.preventDefault();
    const touch = e.touches[0];
    const dy = touch.clientY - _dragState.startY;
    _dragState.item.style.top = (_dragState.itemTop + dy) + 'px';
    const sc = _dragState.scrollContainer;
    if (sc) {
      const scRect = sc.getBoundingClientRect();
      const edgeZone = 60;
      const speed = 8;
      if (touch.clientY < scRect.top + edgeZone) sc.scrollTop -= speed;
      else if (touch.clientY > scRect.bottom - edgeZone) sc.scrollTop += speed;
    }
    const allItems = _dragState.container.querySelectorAll('.sort-item, .sort-placeholder');
    const dragCenterY = _dragState.itemTop + dy + _dragState.item.offsetHeight / 2;
    for (let i = 0; i < allItems.length; i++) {
      const el = allItems[i];
      if (el === _dragState.item) continue;
      const r = el.getBoundingClientRect();
      const midY = r.top + r.height / 2;
      if (el.classList.contains('sort-placeholder')) continue;
      const elIdx = parseInt(el.dataset.sortIdx);
      if (dragCenterY < midY && elIdx < _dragState.idx) {
        _dragState.container.insertBefore(_dragState.placeholder, el);
        break;
      } else if (dragCenterY > midY && elIdx > _dragState.idx) {
        if (el.nextSibling) _dragState.container.insertBefore(_dragState.placeholder, el.nextSibling);
        else _dragState.container.appendChild(_dragState.placeholder);
      }
    }
  }
  function _onSortTouchEnd() {
    if (!_dragState) return;
    const { item, placeholder, container } = _dragState;
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
    const sortItems = Array.from(container.querySelectorAll('.sort-item'));
    const oldIdx = _dragState.idx;
    const realNewIdx = sortItems.indexOf(item);
    if (realNewIdx !== -1 && realNewIdx !== oldIdx) {
      const [moved] = sortedList.splice(oldIdx, 1);
      sortedList.splice(realNewIdx, 0, moved);
      _renderSortList();
    }
    _dragState = null;
    document.removeEventListener('touchmove', _onSortTouchMove);
    document.removeEventListener('touchend', _onSortTouchEnd);
    document.removeEventListener('touchcancel', _onSortTouchEnd);
  }
  async function saveSortOrder() {
    for (let i = 0; i < sortedList.length; i++) {
      const c = sortedList[i];
      c.sortOrder = i;
      await DB.put('singleCards', c);
    }
    UI.showToast('排序已保存');
    exitSortMode();
  }

  return {
    getAll, get, save, remove,
    renderList, create, edit, quickCreateConversation,
    closeEditModal, saveFromModal, deleteCurrent, pickAvatar,
    // v594 新 panel 入口
    closeEditPanel, savePanelForm, switchEditTab, toggleEditMoreMenu, closeEditMoreMenu, pickAvatarPanel,
    // v596 扩展设定跳转
    openCardExtEdit, restoreEditPanel,
    formatForPrompt,
    importCard, exportCurrent,
    // v614 批量管理 / 排序 / 菜单（对齐记忆/世界观）
    toggleMenu,
    toggleManageMode, exitManageMode, toggleSelectAll, _onCardClick,
    exportSelected, batchClone, batchDelete,
    toggleSortMode, exitSortMode, saveSortOrder,
    switchCharSubtab, renderNpcAvatarList, getNpcAvatar, setNpcAvatar,
    _pickNpcAvatar, _removeNpcAvatar
  };
})();
