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
    const panelOnline = document.getElementById('sc-panel-onlinename');
    if (panelOnline) panelOnline.value = card.onlineName || '';
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
    // 渲染已绑定的世界书列表
    _refreshLorebookList(card);
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

    // 自愈兜底：切主题等外部状态可能让 tab 内容容器渲染高度为 0（表现为"只剩标题和 Tab"）。
    // 与世界观编辑页同款修复：进面板后检测一次，若内容区不可见，强制清除整条祖先链的隐藏状态并重切。
    requestAnimationFrame(() => {
      try {
        const basic = document.getElementById('sc-edit-tab-basic');
        if (!basic) return;
        const visible = basic.offsetHeight > 0 && !basic.classList.contains('hidden');
        if (!visible) {
          const clearVis = (el) => {
            if (!el) return;
            el.classList.remove('hidden');
            ['opacity','transform','display','visibility','height','max-height'].forEach(p => el.style.removeProperty(p));
          };
          document.querySelectorAll('.sc-edit-tab-content').forEach(clearVis);
          const panel = document.getElementById('panel-single-card-edit');
          let node = basic;
          while (node && node !== panel) { clearVis(node); node = node.parentElement; }
          clearVis(panel);
          switchEditTab('basic');
        }
      } catch(_) {}
    });
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

  // v632：渲染卡的世界书绑定列表
  async function _refreshLorebookList(card) {
    const container = document.getElementById('sc-panel-lorebook-list');
    if (!container || typeof LorebookUI === 'undefined') return;
    const ids = (card && card.lorebookIds) || [];
    await LorebookUI.renderBoundList(container, ids, async (next) => {
      // 解绑回调：更新卡的 lorebookIds 并保存
      if (!_editingId) return;
      const c = await get(_editingId);
      if (!c) return;
      c.lorebookIds = next;
      await save(c);
      await _refreshLorebookList(c);
    });
  }

  // v632：打开世界书选择器
  async function openLorebookPicker() {
    if (!_editingId) {
      UI.showToast('请先保存角色，再绑定世界书', 2200);
      return;
    }
    if (typeof LorebookUI === 'undefined') return;
    const card = await get(_editingId);
    if (!card) return;
    await LorebookUI.openBindPicker(card.lorebookIds || [], async (next) => {
      if (!_editingId) return;
      const c = await get(_editingId);
      if (!c) return;
      c.lorebookIds = next;
      await save(c);
      await _refreshLorebookList(c);
    });
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
    const onlineName = (document.getElementById('sc-panel-onlinename')?.value || '').trim();
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
    card.onlineName = onlineName;
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
    const editOnline = document.getElementById('sc-edit-onlinename');
    if (editOnline) editOnline.value = card.onlineName || '';
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
    const onlineName = (document.getElementById('sc-edit-onlinename')?.value || '').trim();
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
    card.onlineName = onlineName;
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
    const ok = await UI.showConfirm('删除角色', '确定删除这个角色？相关对话不会被删除，但角色资料会丢失');
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
    if (card.onlineName) text += `\n网名：${card.onlineName}`;
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
        onlineName: card.onlineName || '',
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
    input.accept = '.json,application/json';
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
          UI.showToast('暂不支持导入 PNG 角色卡，请使用 JSON 格式', 3500);
          return;
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
          onlineName: parsed.onlineName || '',
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

  // ===== 世界观角色头像库（v687.5：UI 入口已迁入世界观词条编辑页，仅保留数据层 API） =====

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

  // ===== AI 写卡助手（单人卡）=====
  let _aiGenAbort = null;

  function openAiGen() {
    const modal = document.getElementById('sc-gen-modal');
    const body = document.getElementById('sc-gen-body');
    if (!modal || !body) { UI.showToast('弹窗加载失败', 1500); return; }
    body.innerHTML = `
      <div class="wv-gen-field">
        <label class="wv-gen-label">你想要什么样的角色卡？ *</label>
        <textarea id="sc-gen-prompt" rows="4" placeholder="例如：高岭之花的剑道部学姐，外冷内热；或者毒舌但护短的便利店店长" class="wv-gen-textarea"></textarea>
      </div>
      <div class="wv-gen-field">
        <label class="wv-gen-label">你想和 Ta 怎样相遇？（可选）</label>
        <textarea id="sc-gen-meet" rows="3" placeholder="留空则由 AI 自由设计开场。例如：在深夜便利店打烊前撞见" class="wv-gen-textarea"></textarea>
      </div>
      <div class="wv-gen-field">
        <label class="wv-gen-label">设定字数（≤5000）</label>
        <input id="sc-gen-words" type="number" min="200" max="5000" step="100" value="800" class="wv-gen-input">
      </div>
      <div id="sc-gen-status" class="wv-gen-status" style="display:none"></div>
      <div class="wv-gen-actions">
        <button id="sc-gen-cancel" class="wv-gen-btn">取消</button>
        <button id="sc-gen-submit" class="wv-gen-btn primary">生成</button>
      </div>`;
    modal.classList.remove('hidden');
    const cancelBtn = document.getElementById('sc-gen-cancel');
    const submitBtn = document.getElementById('sc-gen-submit');
    if (cancelBtn) cancelBtn.onclick = closeAiGen;
    if (submitBtn) submitBtn.onclick = _runAiGen;
  }

  function closeAiGen() {
    if (_aiGenAbort) { try { _aiGenAbort.abort(); } catch(_) {} _aiGenAbort = null; }
    const modal = document.getElementById('sc-gen-modal');
    if (modal) modal.classList.add('hidden');
  }

  function _setAiGenLoading(on, msg) {
    const status = document.getElementById('sc-gen-status');
    const btn = document.getElementById('sc-gen-submit');
    if (status) {
      status.style.display = on ? '' : 'none';
      status.innerHTML = on ? `<span class="wv-gen-spinner"></span>${msg || ''}` : '';
    }
    if (btn) btn.disabled = on;
  }

  async function _runAiGen() {
    const prompt = (document.getElementById('sc-gen-prompt')?.value || '').trim();
    const meet = (document.getElementById('sc-gen-meet')?.value || '').trim();
    const wordCount = Math.min(5000, Math.max(200, parseInt(document.getElementById('sc-gen-words')?.value) || 800));
    if (!prompt) { UI.showToast('先描述一下你想要的角色', 1800); return; }
    _setAiGenLoading(true, '正在生成角色卡…');
    try {
      _aiGenAbort = new AbortController();
      const card = await _aiGenerateCard({ prompt, meet, wordCount, signal: _aiGenAbort.signal });
      _setAiGenLoading(false);
      closeAiGen();
      // 生成完进入新建面板并填充，用户可微调后手动保存
      _editingId = null;
      _openEditPanel({
        name: card.name || '',
        aliases: card.aliases || '',
        onlineName: card.onlineName || '',
        detail: card.detail || '',
        firstMes: card.firstMes || '',
        mesExample: card.mesExample || '',
        avatar: '',
        extEnabled: true
      });
      UI.showToast('已生成，检查后点保存', 2200);
    } catch (e) {
      _setAiGenLoading(false);
      if (e && e.name === 'AbortError') return;
      UI.showToast('生成失败: ' + (e?.message || e), 3000);
    }
  }

  // 实际调用 AI 生成
  function _scParseJSON(text) {
    let cleaned = (text || '').trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
    }
    try { return JSON.parse(cleaned); } catch(_) {}
    // 兜底：抓第一个 { 到最后一个 }
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try { return JSON.parse(cleaned.slice(first, last + 1)); } catch(_) {}
    }
    throw new Error('AI 返回内容无法解析为 JSON');
  }

  const _SC_GEN_SYS = `你是一位资深的角色卡设计师，为一款叙事型文字对话游戏创作"单人角色卡"。用户会用一句话描述想要的角色，你需要把它扩写成一张立体、可扮演、有真人感的角色卡，并以严格的 JSON 返回。

# 输出格式（严格 JSON，不要任何额外文字、不要 markdown 代码块）
{
  "name": "角色姓名",
  "aliases": "代号/别称，没有则空字符串",
  "onlineName": "网名/社交媒体昵称，没有则空字符串",
  "detail": "详细设定，见下方规范",
  "firstMes": "开场白，见下方规范",
  "mesExample": "对话样例，见下方规范"
}

# detail（详细设定）内容规范
detail 是一段结构化的角色设定文本，用小标题分段组织。包含以下维度——标【必填】的无论字数多少都要写；其余项目根据字数预算灵活取舍，字数充裕时尽量全部写到：

【基础信息·必填】性别；年龄；社会位置（在社会中和家庭中分别是什么身份，如贵族后代/组织成员/家中老几/某群体的边缘人）；职业（什么职业、什么职位；或学生——什么学历、哪个方向）
【背景】出身【必填】（怎样的家庭、家庭财力、还是孤儿）；成长环境（童年由谁教导，双亲/家庭教师/放养/机构）；成就与荣誉（不论大小，哪怕只是斗蛐蛐获胜）；转折事件（对 Ta 造成重大影响、导致成长或转变的事）；近况【必填】（最近在做什么，行程和事务）
【外貌】发型/发色/瞳色【必填】；身高/体格身材【必填】；特征（痣、胎记、疤痕并说明来源、桃花眼、精灵耳、异色瞳等）；气质（优雅、清冷、稳重、痞气、慵懒等）；气味（是否用香水、偏好哪种味道，或衣服是什么味道，还是更喜欢保持干净清爽无味）
【穿衣风格】正式/娱乐/休闲场合分别穿什么；喜欢的风格（舒适还是体面，花哨还是简约）；饰品偏好（戴不戴、什么类型、什么时候戴/摘）
【性格·必填】表层性格（对外形象，对关系不深的人的态度）；深层性格（表层之下的真实驱动力，如温文尔雅是保守软弱还是掩饰狠辣的保护色）；阴暗面（心底最见不得光、几乎不宣之于口的想法）；创伤（被内化为人格一部分的伤口，要追问成因：为什么永远充满秩序感？焦虑从何而来？为什么对一切游刃有余？是否解离、为何解离）
【语言习惯】说话语气（温和/尖锐/懒散/正式）；口头禅或高频用词；语速节奏（话多/话少/只说必要的）；方言或外语夹杂
【习惯与小动作】无意识动作（转笔、揉眉心、咬指甲、摸耳朵）；日常习惯（早起/晚睡、烟酒茶、运动频率）；紧张/放松/生气时的身体语言
【关系模式】对陌生人/熟人/亲近的人的态度差异；依恋类型（安全/回避/焦虑/恐惧）；社交主动性（主动搭话还是等人来找）
【喜好与爱好】喜好（口味、动物、电影、音乐、书籍、哲学偏好）；爱好（与是否擅长无关，只是喜欢做的事）；能力（真正擅长的部分）
【排斥与雷区】讨厌（忌口、不喜欢的事物类型）；雷区（被触及会真正不悦的部分，需说明原因）
【目标与理想·必填】目标（当下想做的事，朝什么方向努力）；理想（难以企及但追逐的美好愿景）

## 字数预算与取舍（按用户给定的设定字数）
- ≤1000 字：重点写外貌 + 表层/深层性格 + 背景核心事件 + 语言习惯概要，其余必填项简短带过，非必填可省略。
- 1000–2500 字：在上面基础上补充穿衣风格、喜好爱好、关系模式、习惯与小动作。
- 2500–5000 字：全维度展开，创伤、阴暗面、雷区、目标理想全部写透。

# 写作要求
1. 真人感优先：不要完美无缺，不要玛丽苏/杰克苏。要有缺陷、有矛盾、有不合逻辑但合情理之处。一个人可以同时聪明又在某些事上愚蠢到可笑。
2. 逻辑自洽：性格、背景、创伤、目标之间要有因果链。每个特征都应能追溯到经历——表层性格是深层性格的外壳，深层性格是创伤的产物。
3. 具体优于抽象：不要写"Ta 很温柔"，要写具体行为。不要"喜欢音乐"，要写"手机里存了三百多首后摇，但从不在人前用外放"。
4. 微小细节建立真实：越是微小、无用的细节越能让角色立体（冰箱里常年放什么、走路看地面还是抬头、钥匙挂哪个口袋）。
5. 不预设与用户的关系：detail 里不要出现"用户""玩家"字眼，角色设定独立于任何交互对象。与用户的初始关系由 firstMes 的场景暗示。

# firstMes（开场白）规范
- 用第三人称叙述流（"他靠在吧台后面，听见门铃响才懒懒抬眼……"），不要用第一人称。
- 一段场景描写，着重刻画环境、气氛，以及角色自身的外貌、动作、神态、台词（台词用引号）。
- 【硬性要求】绝对禁止描写用户（"你"）的任何东西——不写用户的语言、动作、神态、心理、反应、所处姿势，连"你推门而入""你愣住了"这类都不允许。开场白只呈现角色和场景，把一切反应空间完全留给用户自己发挥。
- 要建立氛围和初始的关系距离感，但这种距离感通过角色的姿态和环境来体现，而非通过描写用户。
- 如果用户提供了"相遇场景"，以此为基础写；没提供就自由设计一个贴合角色的开场。

# mesExample（对话样例）规范
- 写 2-3 轮示范对话，用清晰的对话格式（每轮标明是用户发言还是角色发言，例如以「用户：」「角色：」开头）。
- 「用户：」那行写一句简短的示范输入即可；「角色：」那部分同样不要替用户描写动作、神态、心理。
- 尽量涵盖多种场景与情绪状态，如商务/正式场景、私下/亲近场景，以及不悦、兴奋等不同情绪下的说话方式，让 AI 学到角色在不同情境的口吻切换。
- 对话样例只写台词本身，不要加动作描写（不写"（他笑了笑）"这类），纯粹展示角色的说话风格、语气、习惯用词。
- 要能体现表层性格与深层性格的差异（如嘴上毒舌但本意关切）。

务必返回合法 JSON，所有字符串内的换行用 \\n 转义。`;

  async function _aiGenerateCard(opts) {
    const { prompt, meet, wordCount, signal } = opts;
    const parts = [];
    parts.push(`【想要的角色】\n${prompt}`);
    if (meet) parts.push(`【希望的相遇场景】\n${meet}`);
    else parts.push(`【希望的相遇场景】\n未指定，请你自由设计一个贴合角色的开场。`);
    parts.push(`【detail 设定字数】约 ${wordCount} 字（上限 5000）。按字数预算规范取舍内容。`);
    const userMsg = parts.join('\n\n');
    const raw = await API.generate(_SC_GEN_SYS, userMsg, { signal, maxTokens: Math.min(32000, wordCount * 4 + 4000) });
    const data = _scParseJSON(raw);
    if (!data || (!data.name && !data.detail)) throw new Error('AI 返回内容不完整');
    return data;
  }

  // ===== 编辑页内联 AI 生成（只重写指定字段，参考全部已填信息）=====

  // 收集当前编辑框里的全部信息，作为给 AI 的参考资料
  function _collectCurrentCardCtx() {
    const g = (id) => (document.getElementById(id)?.value || '').trim();
    const parts = [];
    const name = g('sc-panel-name');
    const aliases = g('sc-panel-aliases');
    const onlineName = g('sc-panel-onlinename');
    const detail = g('sc-panel-detail');
    const firstMes = g('sc-panel-firstmes');
    const mesExample = g('sc-panel-mesexample');
    if (name) parts.push(`姓名：${name}`);
    if (aliases) parts.push(`代号/别称：${aliases}`);
    if (onlineName) parts.push(`网名：${onlineName}`);
    if (detail) parts.push(`【详细设定】\n${detail}`);
    if (firstMes) parts.push(`【开场白】\n${firstMes}`);
    if (mesExample) parts.push(`【对话样例】\n${mesExample}`);
    return parts.join('\n\n');
  }

  // 通用：弹需求输入 → 调 AI → 只回填 targetField
  async function _inlineGen(opts) {
    // opts: { targetField, fieldLabel, targetElId, promptTitle, promptHint, sysPrompt, fieldKey }
    const ctx = _collectCurrentCardCtx();
    const reqRaw = await UI.showSimpleInput(
      `${opts.promptTitle}\n${opts.promptHint}`,
      '',
      { allowEmpty: true, multiline: true, rows: 5, minHeight: '140px' }
    );
    if (reqRaw === null) return; // 取消
    const req = (reqRaw || '').trim();
    const targetEl = document.getElementById(opts.targetElId);
    if (!targetEl) return;
    UI.showToast(`正在生成${opts.fieldLabel}…`, 60000);
    try {
      const userParts = [];
      if (ctx) userParts.push(`## 当前角色卡已有信息（作为参考，保持一致）\n${ctx}`);
      else userParts.push(`（当前角色卡尚未填写其它信息，请根据下面的要求自由发挥）`);
      if (req) userParts.push(`## 本次要求\n${req}`);
      userParts.push(`## 任务\n${opts.taskLine}`);
      const userMsg = userParts.join('\n\n');
      const raw = await API.generate(opts.sysPrompt, userMsg, { maxTokens: opts.maxTokens || 8000 });
      let out = (raw || '').trim();
      // 这几个字段是纯文本，去掉可能的 markdown 代码块包裹
      if (out.startsWith('```')) out = out.replace(/^```\w*\s*/, '').replace(/```\s*$/, '').trim();
      // 如果 AI 误返回 JSON，尝试取出对应字段
      if (out.startsWith('{')) {
        try { const j = JSON.parse(out); if (j && typeof j[opts.fieldKey] === 'string') out = j[opts.fieldKey]; } catch(_) {}
      }
      if (!out) throw new Error('AI 返回为空');
      targetEl.value = out;
      targetEl.style.height = 'auto';
      targetEl.style.height = targetEl.scrollHeight + 'px';
      // 触发自动保存
      targetEl.dispatchEvent(new Event('input', { bubbles: true }));
      UI.showToast(`${opts.fieldLabel}已生成`, 1800);
    } catch (e) {
      UI.showToast(`生成失败：${e?.message || e}`, 3000);
    }
  }

  const _SC_DETAIL_SYS = `你是一位资深的角色卡设计师。用户正在编辑一张单人角色卡，需要你重写或填充【详细设定】这一段。\n\n` +
    _SC_GEN_SYS.split('# detail（详细设定）内容规范')[1].split('# firstMes')[0].replace(/^/, '# 详细设定内容规范') +
    `\n\n# 输出要求\n- 只输出【详细设定】这一段正文本身，不要 JSON、不要 markdown 代码块、不要任何额外说明。\n- 必须与用户已有信息（姓名、开场白、对话样例等）保持一致，不要矛盾。\n- 用小标题分段组织，遵循上面的维度规范与必填项要求。`;

  const _SC_FIRSTMES_SYS = `你是一位资深的角色卡设计师，为叙事型文字对话游戏写角色的【开场白】（firstMes）。\n\n` +
    `# 开场白规范\n- 用第三人称叙述流（"他靠在吧台后面，听见门铃响才懒懒抬眼……"），不要用第一人称。\n- 一段场景描写，着重刻画环境、气氛，以及角色自身的外貌、动作、神态、台词（台词用引号）。\n- 【硬性要求】绝对禁止描写用户（"你"）的任何东西——不写用户的语言、动作、神态、心理、反应、所处姿势，连"你推门而入""你愣住了"这类都不允许。开场白只呈现角色和场景，把一切反应空间完全留给用户。\n- 要建立氛围和初始的关系距离感，但这种距离感通过角色的姿态和环境体现，而非通过描写用户。\n\n# 输出要求\n- 只输出开场白正文本身，不要 JSON、不要 markdown、不要额外说明。\n- 必须贴合角色卡已有的详细设定（外貌、性格、近况等），不要矛盾。`;

  const _SC_MESEXAMPLE_SYS = `你是一位资深的角色卡设计师，为叙事型文字对话游戏写角色的【对话样例】（mesExample），用于教 AI 学习角色的说话风格。\n\n` +
    `# 对话样例规范\n- 写 2-3 轮示范对话，用清晰的对话格式（每轮标明是用户发言还是角色发言，例如以「用户：」「角色：」开头）。\n- 「用户：」那行写一句简短的示范输入即可；「角色：」那部分不要替用户描写动作、神态、心理。\n- 尽量涵盖多种场景与情绪状态，如商务/正式场景、私下/亲近场景，以及不悦、兴奋等不同情绪下的说话方式，让 AI 学到角色在不同情境的口吻切换。\n- 对话样例只写台词本身，不要加动作描写（不写"（他笑了笑）"这类），纯粹展示角色的说话风格、语气、习惯用词。\n- 要能体现表层性格与深层性格的差异（如嘴上毒舌但本意关切）。\n\n# 输出要求\n- 只输出对话样例正文本身，不要 JSON、不要 markdown、不要额外说明。\n- 必须贴合角色卡已有的详细设定（性格、语言习惯等），不要矛盾。`;

  function inlineGenDetail() {
    return _inlineGen({
      fieldLabel: '详细设定', targetElId: 'sc-panel-detail', fieldKey: 'detail',
      promptTitle: 'AI 生成详细设定',
      promptHint: '描述/补充你想要的角色（已有信息会作为参考一起发给 AI）。留空则在已有信息基础上自由补全。',
      sysPrompt: _SC_DETAIL_SYS,
      taskLine: '请重写或填充这张卡的【详细设定】，与已有信息保持一致。',
      maxTokens: 16000
    });
  }
  function inlineGenFirstMes() {
    return _inlineGen({
      fieldLabel: '开场白', targetElId: 'sc-panel-firstmes', fieldKey: 'firstMes',
      promptTitle: 'AI 生成开场白',
      promptHint: '描述你想要的相遇场景/开场氛围（已有角色信息会作为参考）。留空则由 AI 自由设计。',
      sysPrompt: _SC_FIRSTMES_SYS,
      taskLine: '请写这张卡的【开场白】，第三人称叙述流，禁止描写用户的任何反应。',
      maxTokens: 4000
    });
  }
  function inlineGenMesExample() {
    return _inlineGen({
      fieldLabel: '对话样例', targetElId: 'sc-panel-mesexample', fieldKey: 'mesExample',
      promptTitle: 'AI 生成对话样例',
      promptHint: '描述你想强调的说话风格/场景（已有角色信息会作为参考）。留空则由 AI 自由发挥。',
      sysPrompt: _SC_MESEXAMPLE_SYS,
      taskLine: '请写这张卡的【对话样例】，涵盖多种场景和情绪，只写台词不写动作描写。',
      maxTokens: 6000
    });
  }

  return {
    getAll, get, save, remove,
    renderList, create, edit, quickCreateConversation,
    closeEditModal, saveFromModal, deleteCurrent, pickAvatar,
    // v594 新 panel 入口
    closeEditPanel, savePanelForm, switchEditTab, toggleEditMoreMenu, closeEditMoreMenu, pickAvatarPanel,
    // v596 扩展设定跳转
openCardExtEdit, restoreEditPanel,
// v632 世界书绑定
openLorebookPicker,
    formatForPrompt,
    importCard, exportCurrent,
    // v614 批量管理 / 排序 / 菜单（对齐记忆/世界观）
    toggleMenu,
    toggleManageMode, exitManageMode, toggleSelectAll, _onCardClick,
    exportSelected, batchClone, batchDelete,
    toggleSortMode, exitSortMode, saveSortOrder,
    openAiGen, closeAiGen,
    inlineGenDetail, inlineGenFirstMes, inlineGenMesExample,
    getNpcAvatar, setNpcAvatar
  };
})();
