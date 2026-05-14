/**
 * 世界观管理 — 多世界观 + 三级嵌套（地区/势力/NPC）+ 节日 + 自定义设定
 */
const Worldview = (() => {
  let currentWorldviewId = null;
  let editingWorldviewId = null;
  
  // 管理模式
  let manageMode = false;
  let selectedIds = new Set();
  // 排序模式
  let sortMode = false;
  let sortedList = [];
  // 菜单
  let menuVisible = false;
  
  // ---------- 列表 CRUD ----------
  async function getWorldviewList() {
    const data = await DB.get('gameState', 'worldviewList');
    const list = data?.value || [];
    // 强制覆盖：__default_wv__ 始终显示为「无世界观」
    list.forEach(w => {
      if (w.id === '__default_wv__') {
        w.name = '无世界观';
        w.description = '未挂世界观的对话';
        w.icon = '∅';
        w.iconImage = '';
      }
    });
    return list;
  }
  async function saveWorldviewList(list) {
    await DB.put('gameState', { key: 'worldviewList', value: list });
  }
  
  // ---------- 默认数据模板 ----------
  function _defaultWorldview(id) {
    return {
      id,
      name: '新世界观',
      description: '',
      icon: 'world',
      iconImage: '',        // base64图片（本地展示用，不发AI）
      setting: '',           // 世界观核心设定（每轮发送）
      currency: { name: '', desc: '' }, // 通用货币：名称+说明，仅发AI，前端仍显示 ¥
      phoneApps: {                       // 手机 App 自定义（留空用默认）
        takeout: { name: '', desc: '' }, // 短时效商城（默认饿了咪）
        shop:    { name: '', desc: '' }, // 长时效商城（默认桃宝）
        forum:   { name: '', desc: '' }, // 信息载体（默认论坛）
      },
      startTime: '',         // 开场时间
      startPlot: '',         // 开场剧情
      startPlotRounds: 5,    // 开场剧情保留轮数
      startMessage: '',      // 开场第一条AI消息
      regions: [],
      globalNpcs: [],   // 全图 NPC（不归属任何地区/势力，每轮全量注入）
festivals: [],
knowledges: []  // v581：customs 已合并到 knowledges，按 keywordTrigger 字段区分常驻/动态
};
}

  // 构建下发给 Chat 的 worldview prompt：setting + 附加字段（货币等）
  function _buildSettingWithExtras(w) {
    if (!w) return '';
    let s = w.setting || '';
    const cur = w.currency || {};
    if (cur.name && cur.name.trim()) {
      const extra = [];
      extra.push('【通用货币】');
      extra.push(`货币名称：${cur.name.trim()}`);
      if (cur.desc && cur.desc.trim()) extra.push(`货币说明：${cur.desc.trim()}`);
      extra.push('（商品/服务价格生成时，price 字段只填纯数字，数值应符合此货币的合理范围与购买力；前端统一以 ¥ 符号展示占位，货币名称仅用于你内部生成合理价格时参考。）');
      s = s ? `${s}\n\n${extra.join('\n')}` : extra.join('\n');
    }
    return s;
  }
function _defaultRegion() {
    return { id: 'reg_' + Utils.uuid().slice(0,8), name: '', summary: '', detail: '', factions: [] };
  }
  function _defaultFaction() {
    return { id: 'fac_' + Utils.uuid().slice(0,8), name: '', summary: '', detail: '', npcs: [] };
  }
  function _defaultNPC() {
    return { id: 'npc_' + Utils.uuid().slice(0,8), name: '', aliases: '', summary: '', detail: '' };
  }
  function _defaultFestival() {
    return { id: 'fest_' + Utils.uuid().slice(0,8), name: '', date: '', yearly: true, content: '', enabled: true };
  }
  function _defaultCustom() {
    // 常驻模式默认值（keywordTrigger=false）
    return { id: 'know_' + Utils.uuid().slice(0,8), name: '', content: '', enabled: false, keywordTrigger: false, keys: '', position: 'system_top', depth: 0 };
  }
  function _defaultKnowledge() {
    // 动态模式默认值（keywordTrigger=true）
    return { id: 'know_' + Utils.uuid().slice(0,8), name: '', keys: '', content: '', enabled: true, keywordTrigger: true, position: 'system_top', depth: 0 };
  }

  /**
   * 迁移旧数据 → 统一 knowledges schema
   * 规则：
   * - 旧 customs[] → 追加到 knowledges[]，keywordTrigger=false
   * - 旧 knowledges[] 不带 keywordTrigger 字段 → 默认为 true（动态）
   * - 所有条目补齐 enabled/position/depth 字段
   * - 迁移后 wv.customs 删除
   * 幂等：已迁移过的世界观（没有 customs 字段且 knowledges 全带 keywordTrigger）跳过
   */
  function _migrateToKnowledges(wv) {
    if (!wv) return wv;
    let knowledges = Array.isArray(wv.knowledges) ? wv.knowledges.slice() : [];
    // 1. 补齐旧 knowledges 的字段
    knowledges = knowledges.map(k => ({
      id: k.id || ('know_' + Utils.uuid().slice(0,8)),
      name: k.name || '',
      content: k.content || '',
      enabled: (k.enabled === undefined || k.enabled === null) ? true : !!k.enabled,
      keywordTrigger: (k.keywordTrigger === undefined || k.keywordTrigger === null) ? true : !!k.keywordTrigger,
      keys: k.keys || '',
      position: k.position || 'system_top',
      depth: (typeof k.depth === 'number') ? k.depth : 0
    }));
    // 2. 合并旧 customs → knowledges（常驻）
    if (Array.isArray(wv.customs) && wv.customs.length > 0) {
      for (const c of wv.customs) {
        knowledges.push({
          id: c.id || ('know_' + Utils.uuid().slice(0,8)),
          name: c.name || '',
          content: c.content || '',
          enabled: (c.enabled === undefined || c.enabled === null) ? false : !!c.enabled,
          keywordTrigger: false,
          keys: '',
          position: 'system_top',
          depth: 0
        });
      }
    }
    wv.knowledges = knowledges;
    // 3. 删除 customs 字段（下次保存时就不会再出现）
    if ('customs' in wv) delete wv.customs;
    return wv;
  }

  // ---------- 隐藏世界观（v596：单人卡专属扩展设定容器）----------
  // 单人卡使用 `__sc_<cardId>__` id，仅存 worldviews store，不进 worldviewList 索引
  function _scHiddenId(cardId) {
    return '__sc_' + cardId + '__';
  }
  // 创建/确保某张单人卡的隐藏世界观存在
  async function ensureHiddenWvForCard(cardId, cardName) {
    if (!cardId) return null;
    const id = _scHiddenId(cardId);
    let wv = await DB.get('worldviews', id);
    if (!wv) {
      wv = {
        id: id,
        _hidden: 'sc',
        _scCardId: cardId,
        name: '【单人卡扩展·' + (cardName || '') + '】',
        description: '隐藏世界观，单人卡 ' + cardId + ' 专属',
        knowledges: [],
        festivals: []
      };
      await DB.put('worldviews', wv);
    }
    return wv;
  }
  // 删除某张单人卡的隐藏世界观
  async function deleteHiddenWvForCard(cardId) {
    if (!cardId) return;
    const id = _scHiddenId(cardId);
    try { await DB.del('worldviews', id); } catch(e) {}
  }
  // 判断某 wv 是否隐藏（单人卡专属）
  function isHiddenWv(wv) {
    return !!(wv && wv._hidden);
  }
  // v596：根据"是否隐藏世界观"调整编辑面板 UI
  function _applyHiddenWvUI(isHidden) {
    // 基础/详细 tab 按钮：隐藏时只显示扩展
    const basicBtn = document.querySelector('.wv-edit-tab-btn[data-tab="basic"]');
    const detailBtn = document.querySelector('.wv-edit-tab-btn[data-tab="detail"]');
    if (basicBtn) basicBtn.style.display = isHidden ? 'none' : '';
    if (detailBtn) detailBtn.style.display = isHidden ? 'none' : '';
    // ⋯ 菜单：隐藏世界观时不允许删除整个世界观、不允许导出（整包）；只保留"扩展设定导入导出"
    const exportBtn = document.querySelector('#worldview-edit-more-menu button[onclick*="exportCurrent"]');
    const importBtn = document.querySelector('#worldview-edit-more-menu button[onclick*="importSingle"]');
    const delBtn = document.querySelector('#worldview-edit-more-menu button[onclick*="deleteCurrentWorldview"]');
    const restoreBtn = document.getElementById('worldview-restore-builtin-btn');
    if (exportBtn) exportBtn.style.display = isHidden ? 'none' : '';
    if (importBtn) importBtn.style.display = isHidden ? 'none' : '';
    if (delBtn) delBtn.style.display = isHidden ? 'none' : '';
    if (restoreBtn && isHidden) restoreBtn.classList.add('hidden');
  }

  async function load() {
    const filter = document.getElementById('worldview-search')?.value || '';
    await renderWorldviewList(filter);
  }
  
  async function renderWorldviewList(filter = '') {
    if (sortMode) { _renderSortList(); return; }
    const list = await getWorldviewList();
    const query = filter.trim().toLowerCase();
    const container = document.getElementById('worldview-list-container');
    if (!container) return;
    // 按 sortOrder 排序（没有 sortOrder 的按原顺序）
    const sorted = list.slice().sort((a, b) => {
      const oa = (typeof a.sortOrder === 'number') ? a.sortOrder : 999999;
      const ob = (typeof b.sortOrder === 'number') ? b.sortOrder : 999999;
      return oa - ob;
    });
    
    let html = '';
    for (const w of sorted) {
      if (w.id === '__default_wv__') continue; // 无世界观不显示预览卡片
      if (w._hidden) continue; // v596：隐藏世界观（单人卡专属）不出现在列表
      if (query && !w.name.toLowerCase().includes(query)) continue;
      const checked = selectedIds.has(w.id);
      const iconHTML = w.iconImage
        ? `<img src="${w.iconImage}" style="width:48px;height:48px;border-radius:50%;object-fit:cover">`
        : `<div style="width:48px;height:48px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:28px;color:rgba(255,255,255,0.8)">✦</div>`;
      
      html += `
        <div class="card worldview-card-item" data-id="${w.id}" onclick="Worldview._onCardClick('${w.id}')" style="display:flex;gap:12px;padding:12px;align-items:center;background:var(--bg-tertiary);cursor:pointer;">
          ${manageMode ? `<span class="worldview-check-circle ${checked ? 'checked' : ''}" data-id="${w.id}" style="width:22px;height:22px;border-radius:50%;border:2px solid ${checked ? 'var(--accent)' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${checked ? 'background:var(--accent);' : ''}">
            ${checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
          </span>` : ''}
          <div style="width:64px;height:64px;border-radius:50%;background:transparent;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            ${iconHTML}
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:16px;font-weight:bold;color:var(--accent);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${Utils.escapeHtml(w.name)}</div>
            <div style="font-size:12px;color:var(--text);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;">
              ${Utils.escapeHtml(w.description || '暂无描述')}
            </div>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;
    _updateSelectAllIcon();
  }
  
  function _onCardClick(worldviewId) {
    if (manageMode) {
      if (selectedIds.has(worldviewId)) selectedIds.delete(worldviewId);
      else selectedIds.add(worldviewId);
      renderWorldviewList(document.getElementById('worldview-search')?.value || '');
    } else {
      openPreview(worldviewId);
    }
  }
  
  // ---------- 管理模式 ----------
  async function toggleManageMode() {
    manageMode = !manageMode;
    const btn = document.getElementById('worldview-manage-btn');
    const bar = document.getElementById('worldview-manage-bar-fixed');
    const container = document.getElementById('worldview-list-container');
    
    if (manageMode) {
      if (btn) { btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M18 6L6 18M6 6l12 12"/></svg> 退出`; btn.style.background = 'var(--accent)'; btn.style.color = '#111'; btn.style.border = 'none'; }
      if (bar) bar.classList.remove('hidden');
      if (container) container.style.paddingBottom = '72px';
    } else {
      if (btn) { btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理`; btn.style.background = 'none'; btn.style.color = 'var(--text-secondary)'; btn.style.border = '1px solid var(--border)'; }
      if (bar) bar.classList.add('hidden');
      if (container) container.style.paddingBottom = '';
      selectedIds.clear();
    }
    await renderWorldviewList(document.getElementById('worldview-search')?.value || '');
    _updateSelectAllIcon();
  }
  
  async function createWorldview() {
    const id = 'wv_' + Utils.uuid().slice(0, 8);
    const newEntry = _defaultWorldview(id);
    const list = await getWorldviewList();
    list.push({ id, name: newEntry.name, description: newEntry.description, icon: newEntry.icon, iconImage: '' });
    await saveWorldviewList(list);
    await DB.put('worldviews', newEntry);
    await load();
    openEdit(id);
  }
  
  async function deleteSelectedWorldviews() {
    if (selectedIds.size === 0) { await UI.showAlert('提示', '请先选择世界观'); return; }
    if (!await UI.showConfirm('批量删除', `确定删除选中的 ${selectedIds.size} 个世界观？\n\n关联的对话将被改为「无世界观」。`)) return;
    // 迁移每个被删世界观的对话
    for (const id of selectedIds) {
      await _migrateConvsFromWorldview(id);
      await DB.del('worldviews', id);
    }
    const list = await getWorldviewList();
    await saveWorldviewList(list.filter(w => !selectedIds.has(w.id)));
    selectedIds.clear();
    manageMode = false;
    const bar = document.getElementById('worldview-manage-bar-fixed');
    if (bar) bar.classList.add('hidden');
    const container = document.getElementById('worldview-list-container');
    if (container) container.style.paddingBottom = '';
    await renderWorldviewList();
  }
  
  // 批量导出选中的世界观
  async function exportSelectedWorldviews() {
    if (selectedIds.size === 0) { await UI.showAlert('提示', '请先选择世界观'); return; }
    const wvArr = [];
    for (const id of selectedIds) {
      const w = await DB.get('worldviews', id);
      if (w) wvArr.push(w);
    }
    if (wvArr.length === 0) { UI.showToast('未找到可导出的世界观'); return; }
    const exportData = { worldviews: wvArr };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `worldviews_${wvArr.length}个_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    UI.showToast(`已导出 ${wvArr.length} 个世界观`);
  }
  
  function _updateSelectAllIcon() {
    const iconEl = document.getElementById('worldview-select-all-icon');
    if (!iconEl) return;
    const container = document.getElementById('worldview-list-container');
    if (!container) return;
    const allIds = Array.from(container.querySelectorAll('.worldview-card-item')).map(el => el.dataset.id);
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
  async function toggleSelectAll() {
    const container = document.getElementById('worldview-list-container');
    const allIds = Array.from(container.querySelectorAll('.worldview-card-item')).map(el => el.dataset.id);
    const allSelected = allIds.length > 0 && allIds.every(id => selectedIds.has(id));
    if (allSelected) { selectedIds.clear(); } else { allIds.forEach(id => selectedIds.add(id)); }
    await renderWorldviewList(document.getElementById('worldview-search')?.value || '');
    _updateSelectAllIcon();
  }
  
  // ===== 菜单（参考 Memory.toggleMenu） =====
  function toggleMenu() {
    const dropdown = document.getElementById('worldview-menu-dropdown');
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
    const btn = document.getElementById('worldview-menu-btn');
    if (btn && btn.contains(e.target)) return;
    menuVisible = false;
    const dropdown = document.getElementById('worldview-menu-dropdown');
    if (dropdown) {
      dropdown.classList.add('closing');
      setTimeout(() => {
        dropdown.classList.add('hidden');
        dropdown.classList.remove('closing');
      }, 120);
    }
  }
  
  // ===== 排序模式 =====
  async function toggleSortMode() {
    if (sortMode) { exitSortMode(); return; }
    if (manageMode) {
      // 退出管理模式
      manageMode = false;
      selectedIds.clear();
      const mbar = document.getElementById('worldview-manage-bar-fixed');
      if (mbar) mbar.classList.add('hidden');
    }
    sortMode = true;
    const list = await getWorldviewList();
    sortedList = list.filter(w => w.id !== '__default_wv__' && !w._hidden).slice();
    sortedList.sort((a, b) => {
      const oa = (typeof a.sortOrder === 'number') ? a.sortOrder : 999999;
      const ob = (typeof b.sortOrder === 'number') ? b.sortOrder : 999999;
      return oa - ob;
    });
    _renderSortList();
  }
  function exitSortMode() {
    sortMode = false;
    sortedList = [];
    const bar = document.getElementById('worldview-sort-bar');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    const container = document.getElementById('worldview-list-container');
    if (container) container.style.paddingBottom = '';
    renderWorldviewList(document.getElementById('worldview-search')?.value || '');
  }
  function _renderSortList() {
    const container = document.getElementById('worldview-list-container');
    if (!container) return;
    container.style.paddingBottom = '72px';
    const bar = document.getElementById('worldview-sort-bar');
    if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
    container.innerHTML = sortedList.length === 0 ?
      '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无世界观</p>' :
      sortedList.map((w, i) => {
        const desc = w.description || '暂无描述';
        return `
        <div class="sort-item" style="display:flex;align-items:center;gap:8px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:6px;transition:transform 0.15s ease,opacity 0.15s ease" data-sort-idx="${i}" data-id="${w.id}">
          <div class="sort-handle" style="display:flex;align-items:center;justify-content:center;width:24px;flex-shrink:0;cursor:grab;color:var(--text-secondary);font-size:18px;user-select:none;-webkit-user-select:none;touch-action:none">≡</div>
          <div style="flex:1;overflow:hidden">
            <h3 style="margin:0 0 2px 0;font-size:13px;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(w.name)}</h3>
            <p style="margin:0;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(desc)}</p>
          </div>
          <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0">${i + 1}</span>
        </div>`;
      }).join('');
    _bindSortDrag(container);
  }
  // 拖拽排序（参考 Memory）
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
    // 把 sortedList 中的顺序写回 worldviewList
    const list = await getWorldviewList();
    const orderMap = new Map();
    sortedList.forEach((w, i) => { orderMap.set(w.id, i); });
    list.forEach(w => {
      if (orderMap.has(w.id)) {
        w.sortOrder = orderMap.get(w.id);
      }
    });
    // 把 list 按 sortOrder 重排（保留 __default_wv__ 等特殊项）
    list.sort((a, b) => {
      const oa = (typeof a.sortOrder === 'number') ? a.sortOrder : 999999;
      const ob = (typeof b.sortOrder === 'number') ? b.sortOrder : 999999;
      return oa - ob;
    });
    await saveWorldviewList(list);
    UI.showToast('排序已保存');
    exitSortMode();
  }
  
  function _isBuiltinWorldview(w) {
    if (!w) return false;
    if (w._builtinVersion || w.isBuiltin || w.builtin || w.official) return true;
    if (['wv_tianshucheng', 'wv_heartsim'].includes(w.id)) return true;
    try {
      return Array.isArray(window.__BUILTIN_WORLDVIEWS__) && window.__BUILTIN_WORLDVIEWS__.some(b => b && b.id === w.id);
    } catch (_) {
      return false;
    }
  }

  function _getBuiltinSource(id) {
    try {
      if (!Array.isArray(window.__BUILTIN_WORLDVIEWS__)) return null;
      return window.__BUILTIN_WORLDVIEWS__.find(b => b && b.id === id) || null;
    } catch (_) {
      return null;
    }
  }

  function _cloneWorldviewData(w) {
    try {
      return JSON.parse(JSON.stringify(w || {}));
    } catch (_) {
      return { ...(w || {}) };
    }
  }

  function _syncBuiltinRestoreButton(w) {
    const btn = document.getElementById('worldview-restore-builtin-btn');
    if (!btn) return;
    const canRestore = !!_getBuiltinSource(w?.id);
    btn.classList.toggle('hidden', !canRestore);
  }

  function _closeEditMoreMenu() {
    const menu = document.getElementById('worldview-edit-more-menu');
    if (menu) menu.classList.add('hidden');
    document.removeEventListener('click', _closeEditMoreMenuOutside);
  }

  function _closeEditMoreMenuOutside(e) {
    const menu = document.getElementById('worldview-edit-more-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.contains(e.target)) return;
    _closeEditMoreMenu();
  }

  function _toggleEditMoreMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('worldview-edit-more-menu');
    if (!menu) return;
    const willOpen = menu.classList.contains('hidden');
    if (willOpen) {
      menu.classList.remove('hidden');
      setTimeout(() => document.addEventListener('click', _closeEditMoreMenuOutside), 0);
    } else {
      _closeEditMoreMenu();
    }
  }

  async function _restoreBuiltinWorldview() {
    if (!editingWorldviewId) return;
    const builtin = _getBuiltinSource(editingWorldviewId);
    if (!builtin) {
      UI.showToast('未找到此世界观的内置原版', 2200);
      return;
    }
    const name = builtin.name || '此世界观';
    const ok = await UI.showConfirm('恢复内置世界观', `将把「${name}」恢复为当前版本内置原版。\n\n这会覆盖你对该世界观基础设定、地区、角色、节日、扩展设定等内容的修改，但会保留原本的世界观 ID 与专属机制绑定。\n\n确定恢复吗？`);
    if (!ok) return;

    const restored = _cloneWorldviewData(builtin);
    restored.id = editingWorldviewId;
    _migrateToKnowledges(restored); // v581：恢复内置时也顺手迁移 customs→knowledges
    await DB.put('worldviews', restored);

    const list = await getWorldviewList();
    const entry = list.find(e => e.id === editingWorldviewId);
    if (entry) {
      entry.name = restored.name || entry.name || '未命名';
      entry.description = restored.description || '';
      entry.icon = restored.icon || 'world';
      entry.iconImage = restored.iconImage || '';
    } else {
      list.push({
        id: restored.id,
        name: restored.name || '未命名',
        description: restored.description || '',
        icon: restored.icon || 'world',
        iconImage: restored.iconImage || ''
      });
    }
    await saveWorldviewList(list);
    await _syncRuntime(restored);
    await _loadEditForm(editingWorldviewId);
    await load();
    await _updateCurrentCard();
    UI.showToast('已恢复内置原版');
  }

  async function _confirmBuiltinWorldviewAccess(type, w) {
    if (!_isBuiltinWorldview(w)) return true;
    const key = `wvBuiltinWarned_${type}_${w.id}`;
    try {
      if (localStorage.getItem(key) === '1') return true;
    } catch (_) {}

    const name = w.name || '此世界观';
    const ok = type === 'edit'
      ? await UI.showConfirm('编辑内置世界观', `「${name}」是内置世界观，可能绑定专属机制、开场流程、角色匹配、地区流动或隐藏提示词。\n\n直接修改原设定可能导致机制异常、剧情推进异常，或与后续更新不兼容。\n\n仍要继续编辑吗？`)
      : await UI.showConfirm('可能包含剧透', `「${name}」的完整世界观设定可能包含未登场角色、地区情报、隐藏背景或机制线索。\n\n如果你希望保持探索感，建议剧情推进后再查看。\n\n仍要继续查看吗？`);
    if (ok) {
      try { localStorage.setItem(key, '1'); } catch (_) {}
    }
    return !!ok;
  }

  // ---------- 预览弹窗 ----------
  async function openPreview(id) {
    const w = await DB.get('worldviews', id);
    if (!w) return;
    const modal = document.getElementById('worldview-preview-modal');
    if (!modal) return;
    
    const iconEl = modal.querySelector('.wv-preview-icon');
    if (w.iconImage) {
      iconEl.innerHTML = `<img src="${w.iconImage}" style="width:96px;height:96px;border-radius:50%;object-fit:cover">`;
    } else {
      iconEl.innerHTML = '<div style="width:96px;height:96px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:64px;color:rgba(255,255,255,0.8)">✦</div>';
    }
    modal.querySelector('.wv-preview-name').textContent = w.name || '';
    modal.querySelector('.wv-preview-desc').innerHTML = w.description ? Markdown.render(w.description) : '';
    modal.dataset.id = id;
    modal.classList.remove('hidden');
  }
  function closePreview() {
    const modal = document.getElementById('worldview-preview-modal');
    if (modal) modal.classList.add('hidden');
  }
  
  // ===== 世界观自动保存（主编辑页字段） =====
  const _wvAutoSave = Utils.debounce(async () => {
    if (!editingWorldviewId) return;
    try {
      const w = await DB.get('worldviews', editingWorldviewId);
      if (!w) return;
      w.name = (document.getElementById('wv-name')?.value || '').trim() || w.name;
      w.description = document.getElementById('wv-description')?.value || '';
      w.setting = document.getElementById('wv-setting')?.value || '';
      w.currency = w.currency || { name: '', desc: '' };
      w.currency.name = document.getElementById('wv-currency-name')?.value || '';
      w.currency.desc = document.getElementById('wv-currency-desc')?.value || '';
      w.phoneApps = w.phoneApps || { takeout: { name: '', desc: '' }, shop: { name: '', desc: '' }, forum: { name: '', desc: '' } };
      w.phoneApps.takeout = w.phoneApps.takeout || { name: '', desc: '' };
      w.phoneApps.shop = w.phoneApps.shop || { name: '', desc: '' };
      w.phoneApps.forum = w.phoneApps.forum || { name: '', desc: '' };
      w.phoneApps.takeout.name = document.getElementById('wv-takeout-name')?.value || '';
      w.phoneApps.takeout.desc = document.getElementById('wv-takeout-desc')?.value || '';
      w.phoneApps.shop.name = document.getElementById('wv-shop-name')?.value || '';
      w.phoneApps.shop.desc = document.getElementById('wv-shop-desc')?.value || '';
      w.phoneApps.forum.name = document.getElementById('wv-forum-name')?.value || '';
      w.phoneApps.forum.desc = document.getElementById('wv-forum-desc')?.value || '';
      w.startTime = document.getElementById('wv-start-time')?.value || '';
      w.startPlot = document.getElementById('wv-start-plot')?.value || '';
      w.startPlotRounds = parseInt(document.getElementById('wv-start-plot-rounds')?.value) || 5;
      w.startMessage = document.getElementById('wv-start-message')?.value || '';
      await DB.put('worldviews', w);
      // 同步到运行时（仅当编辑的是当前激活世界观才生效）
      await _syncRuntime(w);
      // 静默同步名字到列表
      const list = await getWorldviewList();
      const entry = list.find(e => e.id === editingWorldviewId);
      if (entry && w.name) { entry.name = w.name; await saveWorldviewList(list); }
    } catch(e) { console.warn('[Worldview] 自动保存失败', e); }
  }, 1500);

  // 地区/势力/NPC 各子页的自动保存
  const _wvRegionAutoSave = Utils.debounce(() => saveRegion(true), 1500);
  const _wvFactionAutoSave = Utils.debounce(() => saveFaction(true), 1500);
  const _wvNpcAutoSave = Utils.debounce(() => saveNPC(true), 1500);

  function _attachWVAutoSave() {
    // 主编辑页
    ['wv-name','wv-description','wv-setting','wv-currency-name','wv-currency-desc','wv-takeout-name','wv-takeout-desc','wv-shop-name','wv-shop-desc','wv-forum-name','wv-forum-desc','wv-start-time','wv-start-plot','wv-start-plot-rounds','wv-start-message'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.removeEventListener('input', _wvAutoSave); el.addEventListener('input', _wvAutoSave); }
    });
  }
  function _attachWVRegionAutoSave() {
    ['wv-reg-name','wv-reg-summary','wv-reg-detail'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.removeEventListener('input', _wvRegionAutoSave); el.addEventListener('input', _wvRegionAutoSave); }
    });
  }
  function _attachWVFactionAutoSave() {
    ['wv-fac-name','wv-fac-summary','wv-fac-detail'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.removeEventListener('input', _wvFactionAutoSave); el.addEventListener('input', _wvFactionAutoSave); }
    });
  }
  function _attachWVNpcAutoSave() {
    ['wv-npc-name','wv-npc-aliases','wv-npc-summary','wv-npc-detail'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.removeEventListener('input', _wvNpcAutoSave); el.addEventListener('input', _wvNpcAutoSave); }
    });
  }

  // ---------- 编辑面板 ----------
  // v596：标记从哪里进入编辑（用于返回时跳对地方）
  let _editReturnTo = null;
  
  async function openEdit(id, opts) {
    const w = await DB.get('worldviews', id);
    if (!w) return;
    if (!await _confirmBuiltinWorldviewAccess('edit', w)) return;
    editingWorldviewId = id;
    _editReturnTo = (opts && opts.returnTo) || null;
    closePreview(); // 关闭预览弹窗（如果有的话）
    UI.showPanel('worldview-edit');
    _loadEditForm(id);
  }
  // 给外部调用：编辑面板返回时的目标路径
  function getEditReturnTo() {
    return _editReturnTo;
  }
  function clearEditReturnTo() {
    _editReturnTo = null;
  }
  
  async function _loadEditForm(id) {
    const w = await DB.get('worldviews', id);
    if (!w) return;
    
    // 数据迁移（v581）：customs[] + knowledges[] → 统一 knowledges[]
    _migrateToKnowledges(w);

    // v596：隐藏世界观（单人卡专属扩展设定容器）特殊处理
    const isHidden = isHiddenWv(w);
    document.getElementById('worldview-edit-title').textContent = isHidden ? '编辑扩展设定' : '编辑世界观';
    _applyHiddenWvUI(isHidden);
    if (isHidden) {
      // 隐藏世界观只用扩展 tab
      switchEditTab('special');
      _renderFestivals(w.festivals || []);
    _renderCustoms((w.knowledges || []).filter(k => !k.keywordTrigger));
    _renderKnowledges((w.knowledges || []).filter(k => !!k.keywordTrigger));
    _renderEvents(w.events || []);
    return;
    }

    _syncBuiltinRestoreButton(w);
    
    // 基础设定
    document.getElementById('wv-name').value = w.name || '';
    document.getElementById('wv-description').value = w.description || '';
    // icon字段保留默认值（不再有emoji输入框）
    document.getElementById('wv-setting').value = w.setting || '';
    const _cur = w.currency || {};
    const _curName = document.getElementById('wv-currency-name'); if (_curName) _curName.value = _cur.name || '';
    const _curDesc = document.getElementById('wv-currency-desc'); if (_curDesc) _curDesc.value = _cur.desc || '';
    const _pa = w.phoneApps || {};
    const _paTk = _pa.takeout || {};
    const _paSh = _pa.shop || {};
    const _paFm = _pa.forum || {};
    const _tkN = document.getElementById('wv-takeout-name'); if (_tkN) _tkN.value = _paTk.name || '';
    const _tkD = document.getElementById('wv-takeout-desc'); if (_tkD) _tkD.value = _paTk.desc || '';
    const _shN = document.getElementById('wv-shop-name'); if (_shN) _shN.value = _paSh.name || '';
    const _shD = document.getElementById('wv-shop-desc'); if (_shD) _shD.value = _paSh.desc || '';
    const _fmN = document.getElementById('wv-forum-name'); if (_fmN) _fmN.value = _paFm.name || '';
    const _fmD = document.getElementById('wv-forum-desc'); if (_fmD) _fmD.value = _paFm.desc || '';
    document.getElementById('wv-start-time').value = w.startTime || '';
    document.getElementById('wv-start-plot').value = w.startPlot || '';
    document.getElementById('wv-start-plot-rounds').value = w.startPlotRounds ?? 5;
    document.getElementById('wv-start-message').value = w.startMessage || '';
    // 图片预览
    const previewEl = document.getElementById('wv-icon-image-preview');
    if (w.iconImage) {
      previewEl.innerHTML = `<img src="${w.iconImage}" style="width:64px;height:64px;object-fit:cover" data-value="${w.iconImage}">`;
    } else {
      previewEl.innerHTML = '<div id="wv-icon-placeholder" style="width:64px;height:64px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:36px;color:rgba(255,255,255,0.8)">✦</div>';
    }
    
    // 详细设定 — 渲染三级嵌套
    _renderRegions(w.regions || []);
    
    // 节日
    _renderFestivals(w.festivals || []);
    
// 自定义设定（常驻条目：从 knowledges 中筛 keywordTrigger=false）
    _renderCustoms((w.knowledges || []).filter(k => !k.keywordTrigger));
    
    // 知识设定（动态条目：从 knowledges 中筛 keywordTrigger=true）
    _renderKnowledges((w.knowledges || []).filter(k => !!k.keywordTrigger));
    
    // 事件设定
    _renderEvents(w.events || []);
    
    // 绑定主题下拉
_populateThemeSelect(w.themeName || '');

    // 全图 NPC 渲染
    _renderGlobalNpcs(w.globalNpcs || []);
    
    switchEditTab('basic');
    // 绑定主编辑页自动保存
    requestAnimationFrame(_attachWVAutoSave);

    const resizeWorldviewEdit = () => {
      ['wv-description', 'wv-setting', 'wv-start-plot', 'wv-start-message'].forEach(id => {
        const ta = document.getElementById(id);
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
        ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
      });
    };
    requestAnimationFrame(resizeWorldviewEdit);
    setTimeout(resizeWorldviewEdit, 260);
    setTimeout(resizeWorldviewEdit, 420);
  }
  
  function switchEditTab(tab) {
    document.querySelectorAll('.wv-edit-tab-btn').forEach(btn => btn.classList.remove('active'));
    const btn = document.querySelector(`.wv-edit-tab-btn[data-tab="${tab}"]`);
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.wv-edit-tab-content').forEach(c => c.classList.add('hidden'));
    const panel = document.getElementById(`wv-edit-tab-${tab}`);
    if (panel) panel.classList.remove('hidden');
    // 切到扩展 tab 时刷新计数
    if (tab === 'special') {
      _updateExtCounts();
      _applyExtSearch();
    }
  }

  // ---------- 扩展设定子 tab（节日 / 常驻 / 动态） ----------
  let _currentExtSubtab = 'festival';
  function switchExtSubtab(subtab) {
    _currentExtSubtab = subtab;
    document.querySelectorAll('.wv-ext-subtab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.subtab === subtab);
    });
    document.querySelectorAll('.wv-ext-subtab-content').forEach(c => {
      c.classList.toggle('hidden', c.dataset.subtab !== subtab);
    });
    // 切 tab 后保持搜索过滤
    _applyExtSearch();
  }

  // 刷新四个子 tab 的数量提示（v612：改为不显示数字，tab 只保留图标 + 文字；函数保留以便后续复用）
  function _updateExtCounts() {
    const fEl = document.getElementById('wv-ext-count-festival');
    const cEl = document.getElementById('wv-ext-count-constant');
    const dEl = document.getElementById('wv-ext-count-dynamic');
    const eEl = document.getElementById('wv-ext-count-event');
    if (fEl) fEl.textContent = '';
    if (cEl) cEl.textContent = '';
    if (dEl) dEl.textContent = '';
    if (eEl) eEl.textContent = '';
  }

  // 跨 tab 搜索：名称 + 关键词 + 内容
  function filterExtended() {
    const input = document.getElementById('wv-ext-search');
    const clearBtn = document.getElementById('wv-ext-search-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !input.value);
    _applyExtSearch();
  }
  function clearExtendedSearch() {
    const input = document.getElementById('wv-ext-search');
    if (input) input.value = '';
    const clearBtn = document.getElementById('wv-ext-search-clear');
    if (clearBtn) clearBtn.classList.add('hidden');
    _applyExtSearch();
  }
  // 切换添加菜单
  function toggleExtAddMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('wv-ext-add-menu');
    if (!menu) return;
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    if (willOpen) {
      // 点空白处关闭
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
  // 从菜单添加：自动切到目标 tab + 调原有 add 函数
  function addFromMenu(type) {
    const menu = document.getElementById('wv-ext-add-menu');
    if (menu) menu.classList.add('hidden');
    if (type === 'festival') {
      switchExtSubtab('festival');
      addFestival();
    } else if (type === 'constant') {
      switchExtSubtab('constant');
      addCustom();
    } else if (type === 'dynamic') {
      switchExtSubtab('dynamic');
      addKnowledge();
    } else if (type === 'event') {
      switchExtSubtab('event');
      addEvent();
    }
  }

  // ---------- v589 扩展设定导入导出 ----------
  function toggleExtIoMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('wv-ext-io-menu');
    if (!menu) return;
    // 关掉另一个菜单
    const addMenu = document.getElementById('wv-ext-add-menu');
    if (addMenu) addMenu.classList.add('hidden');
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

  // 导出扩展设定（节日 + 扩展条目）为 JSON
  async function exportExtended() {
    const menu = document.getElementById('wv-ext-io-menu');
    if (menu) menu.classList.add('hidden');
    if (!editingWorldviewId) { UI.showToast('没有正在编辑的世界观'); return; }
    const w = await DB.get('worldviews', editingWorldviewId);
    const wvName = w?.name || '扩展设定';
    // 注：导出当前内存中的数据（已编辑但未保存的也会一并导出）
    const exportData = {
      _format: 'tianshu-extended',
      _version: 1,
      _source: wvName,
      _exportedAt: new Date().toISOString(),
      festivals: JSON.parse(JSON.stringify(festivalsData || [])),
      knowledges: JSON.parse(JSON.stringify(knowledgesData || []))
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = wvName + '-扩展设定.json';
    a.click();
    URL.revokeObjectURL(url);
    const total = (festivalsData?.length || 0) + (knowledgesData?.length || 0);
    UI.showToast(`已导出 ${total} 条`);
  }

  // 导入扩展设定（单一入口，内部静默识别两种格式）
  async function importExtended() {
    const menu = document.getElementById('wv-ext-io-menu');
    if (menu) menu.classList.add('hidden');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        // 格式 sniff：优先原生格式，否则尝试 entries 格式
        if (data._format === 'tianshu-extended') {
          return _importNativeFormat(data);
        }
        if (data.entries && typeof data.entries === 'object') {
          return _importEntriesFormat(data);
        }
        // 兜底：直接是数组（少数情况）
        if (Array.isArray(data)) {
          return _importEntriesFormat({ entries: data });
        }
        UI.showToast('文件格式不识别', 3000);
      } catch(e) {
        UI.showToast('导入失败：' + e.message, 3000);
      }
    };
    input.click();
  }

  // 导入原生格式
  async function _importNativeFormat(data) {
    const fest = Array.isArray(data.festivals) ? data.festivals : [];
    const know = Array.isArray(data.knowledges) ? data.knowledges : [];
    if (fest.length === 0 && know.length === 0) {
      UI.showToast('文件内没有扩展设定内容', 3000);
      return;
    }
    const mode = await _askImportMode(fest.length, know.length);
    if (!mode) return;
    if (mode === 'replace') {
      festivalsData = fest;
      knowledgesData = know;
    } else {
      for (const f of fest) {
        if (!f.id) f.id = 'fest_' + Utils.uuid().slice(0, 8);
        else if (festivalsData.some(x => x.id === f.id)) f.id = 'fest_' + Utils.uuid().slice(0, 8);
      }
      for (const k of know) {
        if (!k.id) k.id = 'know_' + Utils.uuid().slice(0, 8);
        else if (knowledgesData.some(x => x.id === k.id)) k.id = 'know_' + Utils.uuid().slice(0, 8);
      }
      festivalsData = festivalsData.concat(fest);
      knowledgesData = knowledgesData.concat(know);
    }
    _renderFestivals(festivalsData);
    _renderKnowledges(knowledgesData);
    _updateExtCounts();
    UI.showToast(`已导入 ${fest.length + know.length} 条（记得保存）`, 3000);
  }

  // 导入 entries 格式（兼容外部格式，静默处理）
  async function _importEntriesFormat(data) {
    const entries = data.entries;
    const arr = Array.isArray(entries) ? entries : Object.values(entries);
    if (!arr.length) { UI.showToast('文件内没有可导入的条目', 2500); return; }

    // position 数字映射
    const POS_MAP = {
      0: 'system_top',
      1: 'system_bottom',
      2: 'system_bottom',
      3: 'system_bottom',
      4: 'depth',
      5: 'system_top',
      6: 'system_bottom'
    };

    const imported = [];
    let skipped = 0;
    for (const e of arr) {
      if (!e || typeof e !== 'object') { skipped++; continue; }
      const content = e.content || '';
      if (!content.trim()) { skipped++; continue; }
      const keysArr = Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : []);
      const isConstant = !!e.constant;
      const isDisabled = !!e.disable;
      const posNum = (typeof e.position === 'number') ? e.position : 1;
      const position = POS_MAP[posNum] || 'system_top';
      const depth = (typeof e.depth === 'number' && e.depth >= 0) ? e.depth : 0;
      const name = e.comment || e.name || (keysArr[0] || '未命名条目');

      imported.push({
        id: 'know_' + Utils.uuid().slice(0, 8),
        name: String(name).slice(0, 60),
        content: String(content),
        enabled: !isDisabled,
        keywordTrigger: !isConstant,
        keys: keysArr.join(', '),
        position: position,
        depth: depth
      });
    }

    if (!imported.length) { UI.showToast('没有可导入的条目', 2500); return; }

    const mode = await _askImportMode(0, imported.length);
    if (!mode) return;
    if (mode === 'replace') {
      knowledgesData = imported;
    } else {
      knowledgesData = knowledgesData.concat(imported);
    }
    _renderKnowledges(knowledgesData);
    _updateExtCounts();
    const msg = `已导入 ${imported.length} 条` + (skipped ? `（跳过 ${skipped} 条空条目）` : '') + '（记得保存）';
    UI.showToast(msg, 3000);
  }

  // 询问导入模式：替换 / 追加
  async function _askImportMode(festCount, knowCount) {
    const hasData = (festivalsData?.length || 0) + (knowledgesData?.length || 0) > 0;
    if (!hasData) return 'append'; // 当前为空，直接追加 = 等于替换
    const msg = `当前已有 ${festivalsData?.length || 0} 个节日 + ${knowledgesData?.length || 0} 个条目。\n` +
                `即将导入 ${festCount} 个节日 + ${knowCount} 个条目。\n\n` +
                `选择「确定」=追加到现有条目\n选择「取消」=取消导入`;
    // 简化：用 confirm，true=追加，false=问是否替换
    const append = await UI.showConfirm('追加导入', msg);
    if (append) return 'append';
    const replace = await UI.showConfirm('替换导入', '是否清空当前所有节日和扩展条目，用导入的内容替换？\n（此操作不可逆，但需点击保存后才会写入数据库）');
    return replace ? 'replace' : null;
  }
  // ---------- 扩展设定导入导出 END ----------
  function _applyExtSearch() {
    const input = document.getElementById('wv-ext-search');
    const q = (input?.value || '').trim().toLowerCase();
    const containers = [
      { box: document.getElementById('wv-festivals-container'), match: (el) => _matchFestivalCard(el, q) },
      { box: document.getElementById('wv-customs-container'), match: (el) => _matchKnowledgeCard(el, q) },
      { box: document.getElementById('wv-knowledges-container'), match: (el) => _matchKnowledgeCard(el, q) },
      { box: document.getElementById('wv-events-container'), match: (el) => _matchKnowledgeCard(el, q) }
    ];
    for (const { box, match } of containers) {
      if (!box) continue;
      const cards = box.children;
      for (const card of cards) {
        if (!q) {
          card.style.display = '';
          continue;
        }
        card.style.display = match(card) ? '' : 'none';
      }
    }
  }
  // 卡片内文本搜索（节日：name + content）
  function _matchFestivalCard(card, q) {
    const txt = (card.textContent || '').toLowerCase();
    return txt.includes(q);
  }
  // 卡片内文本搜索（常驻/动态：name + keys + content）
  function _matchKnowledgeCard(card, q) {
    const txt = (card.textContent || '').toLowerCase();
    return txt.includes(q);
  }
  
  // ---------- 图片上传 ----------
  function handleIconImageUpload(input) {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const size = 128;
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        const preview = document.getElementById('wv-icon-image-preview');
        // 用img替换placeholder
        preview.innerHTML = `<img src="${dataUrl}" style="width:64px;height:64px;object-fit:cover" data-value="${dataUrl}">`;
        // 立刻保存到DB并刷新
        _saveIconImageToDB(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    input.value = '';
  }
  function clearIconImage() {
    const preview = document.getElementById('wv-icon-image-preview');
    preview.innerHTML = '<div id="wv-icon-placeholder" style="width:64px;height:64px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:36px;color:rgba(255,255,255,0.8)">✦</div>';
    _saveIconImageToDB('');
  }
  
  async function _saveIconImageToDB(dataUrl) {
    if (!editingWorldviewId) return;
    const w = await DB.get('worldviews', editingWorldviewId);
    if (!w) return;
    w.iconImage = dataUrl;
    await DB.put('worldviews', w);
    const list = await getWorldviewList();
    const entry = list.find(e => e.id === editingWorldviewId);
    if (entry) { entry.iconImage = dataUrl; }
    await saveWorldviewList(list);
    await renderWorldviewList(document.getElementById('worldview-search')?.value || '');
    if (currentWorldviewId === editingWorldviewId) { await _updateCurrentCard(); }
  }
  
  // ---------- 逐级编辑状态 ----------
  let _editRegionIdx = -1;
  let _editFactionIdx = -1;
  let _editNPCIdx = -1;
  
  // 获取当前编辑中的worldview（从DB实时读取）
  async function _getEditingWV() {
    if (!editingWorldviewId) return null;
    return await DB.get('worldviews', editingWorldviewId);
  }
  async function _saveEditingWV(w) {
    await DB.put('worldviews', w);
    // 立刻同步到运行时（仅当编辑的是当前激活世界观）
    await _syncRuntime(w);
  }
  
  // ---------- 详细设定Tab：地区卡片列表 ----------
  function _renderRegions(regions) {
    const container = document.getElementById('wv-regions-container');
    if (!container) return;
    if (!regions || regions.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:24px;font-size:13px">暂无地区，点击下方按钮添加</div>';
      return;
    }
    let html = '';
    regions.forEach((reg, ri) => {
      const facCount = (reg.factions || []).length;
      const npcCount = (reg.factions || []).reduce((sum, f) => sum + (f.npcs || []).length, 0);
      html += `<div class="card" onclick="Worldview.openRegionEdit(${ri})" style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-tertiary);cursor:pointer;margin-bottom:8px;border-radius:8px">
 <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:bold;color:var(--accent);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(reg.name || '未命名地区')}</div>
          <div style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(reg.summary || '暂无简介')}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:2px">${facCount} 个势力 · ${npcCount} 个角色</div>
        </div>
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      </div>`;
    });
    container.innerHTML = html;
  }
  
  // ---------- 地区编辑面板 ----------
  async function openRegionEdit(ri) {
    const w = await _getEditingWV();
    if (!w) return;
    if (ri === -1) {
      // 新增
      w.regions = w.regions || [];
      w.regions.push(_defaultRegion());
      ri = w.regions.length - 1;
      await _saveEditingWV(w);
    }
    _editRegionIdx = ri;
    const reg = w.regions[ri];
    if (!reg) return;
    
    document.getElementById('wv-region-title').textContent = reg.name || '编辑地区';
    document.getElementById('wv-reg-name').value = reg.name || '';
    document.getElementById('wv-reg-summary').value = reg.summary || '';
    document.getElementById('wv-reg-detail').value = reg.detail || '';
    
    // 渲染势力卡片列表
    _renderFactionCards(reg.factions || []);
    UI.showPanel('wv-region', 'forward');
    requestAnimationFrame(_attachWVRegionAutoSave);
    const resizeRegionEdit = () => {
      ['wv-reg-summary', 'wv-reg-detail'].forEach(id => {
        const ta = document.getElementById(id);
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
        ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
      });
    };
    requestAnimationFrame(resizeRegionEdit);
    setTimeout(resizeRegionEdit, 260);
    setTimeout(resizeRegionEdit, 420);
  }
  
  function _renderFactionCards(factions) {
    const container = document.getElementById('wv-factions-list');
    if (!container) return;
    if (!factions || factions.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:16px;font-size:12px">暂无势力</div>';
      return;
    }
    let html = '';
    factions.forEach((fac, fi) => {
      const npcCount = (fac.npcs || []).length;
      html += `<div class="card" onclick="Worldview.openFactionEdit(${fi})" style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-secondary);cursor:pointer;margin-bottom:6px;border-radius:6px">
 <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:bold;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(fac.name || '未命名势力')}</div>
          <div style="font-size:11px;color:var(--text-secondary)">${npcCount} 个角色</div>
        </div>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      </div>`;
    });
    container.innerHTML = html;
  }
  
  async function saveRegion(silent) {
    const w = await _getEditingWV();
    if (!w || _editRegionIdx < 0) return;
    const reg = w.regions[_editRegionIdx];
    if (!reg) return;
    reg.name = document.getElementById('wv-reg-name').value.trim();
    reg.summary = document.getElementById('wv-reg-summary').value.trim();
    reg.detail = document.getElementById('wv-reg-detail').value.trim();
    await _saveEditingWV(w);
    if (!silent) UI.showToast('地区已保存');
    // 刷新上级
    _renderRegions(w.regions);
  }
  
  async function deleteRegion() {
    const w = await _getEditingWV();
    if (!w || _editRegionIdx < 0) return;
    if (!await UI.showConfirm('删除地区', `确定删除"${w.regions[_editRegionIdx]?.name || '未命名'}"？其下的势力和角色也会被删除。`)) return;
    w.regions.splice(_editRegionIdx, 1);
    await _saveEditingWV(w);
    _renderRegions(w.regions);
    UI.showPanel('worldview-edit', 'back');
  }
  
  // ---------- 势力编辑面板 ----------
  async function openFactionEdit(fi) {
    const w = await _getEditingWV();
    if (!w) return;
    const reg = w.regions[_editRegionIdx];
    if (!reg) return;
    if (fi === -1) {
      reg.factions = reg.factions || [];
      reg.factions.push(_defaultFaction());
      fi = reg.factions.length - 1;
      await _saveEditingWV(w);
    }
    _editFactionIdx = fi;
    const fac = reg.factions[fi];
    if (!fac) return;
    
    document.getElementById('wv-faction-title').textContent = fac.name || '编辑势力';
    document.getElementById('wv-fac-name').value = fac.name || '';
    document.getElementById('wv-fac-summary').value = fac.summary || '';
    document.getElementById('wv-fac-detail').value = fac.detail || '';
    
    _renderNPCCards(fac.npcs || []);
    UI.showPanel('wv-faction', 'forward');
    requestAnimationFrame(_attachWVFactionAutoSave);
    const resizeFactionEdit = () => {
      ['wv-fac-summary', 'wv-fac-detail'].forEach(id => {
        const ta = document.getElementById(id);
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
        ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
      });
    };
    requestAnimationFrame(resizeFactionEdit);
    setTimeout(resizeFactionEdit, 260);
    setTimeout(resizeFactionEdit, 420);
  }
  
  function _renderNPCCards(npcs) {
    const container = document.getElementById('wv-npcs-list');
    if (!container) return;
    if (!npcs || npcs.length === 0) {
container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:16px;font-size:12px">暂无角色</div>';
return;
}
    let html = '';
    npcs.forEach((npc, ni) => {
      html += `<div class="card" onclick="Worldview.openNPCEdit(${ni})" style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-secondary);cursor:pointer;margin-bottom:6px;border-radius:6px">
 <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:bold;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(npc.name || '未命名角色')}</div>
          <div style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(npc.summary || '暂无简介')}</div>
        </div>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      </div>`;
    });
    container.innerHTML = html;
  }
  
  async function saveFaction(silent) {
    const w = await _getEditingWV();
    if (!w || _editRegionIdx < 0 || _editFactionIdx < 0) return;
    const fac = w.regions[_editRegionIdx]?.factions[_editFactionIdx];
    if (!fac) return;
    fac.name = document.getElementById('wv-fac-name').value.trim();
    fac.summary = document.getElementById('wv-fac-summary').value.trim();
    fac.detail = document.getElementById('wv-fac-detail').value.trim();
    await _saveEditingWV(w);
    if (!silent) UI.showToast('势力已保存');
    _renderFactionCards(w.regions[_editRegionIdx].factions);
  }
  
  async function deleteFaction() {
    const w = await _getEditingWV();
    if (!w || _editRegionIdx < 0 || _editFactionIdx < 0) return;
    const fac = w.regions[_editRegionIdx]?.factions[_editFactionIdx];
    if (!await UI.showConfirm('删除势力', `确定删除"${fac?.name || '未命名'}"？其下的角色也会被删除。`)) return;
    w.regions[_editRegionIdx].factions.splice(_editFactionIdx, 1);
    await _saveEditingWV(w);
    _renderFactionCards(w.regions[_editRegionIdx].factions);
    UI.showPanel('wv-region', 'back');
  }
  
  // ---------- NPC编辑面板 ----------
  async function openNPCEdit(ni) {
    const w = await _getEditingWV();
    if (!w) return;
    const fac = w.regions[_editRegionIdx]?.factions[_editFactionIdx];
    if (!fac) return;
    if (ni === -1) {
      fac.npcs = fac.npcs || [];
      fac.npcs.push(_defaultNPC());
      ni = fac.npcs.length - 1;
      await _saveEditingWV(w);
    }
    _editNPCIdx = ni;
    _editGlobalNpcIdx = -1;  // 复位全图标记
    // 普通 NPC 显示简介
    const sumLbl = document.getElementById('wv-npc-summary-label');
    if (sumLbl) sumLbl.style.display = '';
    const npc = fac.npcs[ni];
    if (!npc) return;
    
    document.getElementById('wv-npc-title').textContent = npc.name || '编辑角色';
    document.getElementById('wv-npc-name').value = npc.name || '';
    document.getElementById('wv-npc-aliases').value = npc.aliases || '';
    document.getElementById('wv-npc-summary').value = npc.summary || '';
    document.getElementById('wv-npc-detail').value = npc.detail || '';
    
    UI.showPanel('wv-npc', 'forward');
    requestAnimationFrame(_attachWVNpcAutoSave);
    const resizeNPCEdit = () => {
      ['wv-npc-summary', 'wv-npc-detail'].forEach(id => {
        const ta = document.getElementById(id);
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
        ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
      });
    };
    requestAnimationFrame(resizeNPCEdit);
    setTimeout(resizeNPCEdit, 260);
    setTimeout(resizeNPCEdit, 420);
  }
  
  async function saveNPC(silent) {
    const w = await _getEditingWV();
    if (!w) return;
    // 全图 NPC 模式
    if (_editGlobalNpcIdx >= 0) {
      const npc = w.globalNpcs && w.globalNpcs[_editGlobalNpcIdx];
      if (!npc) return;
      npc.name = document.getElementById('wv-npc-name').value.trim();
      npc.aliases = document.getElementById('wv-npc-aliases').value.trim();
      npc.summary = document.getElementById('wv-npc-summary').value.trim();
      npc.detail = document.getElementById('wv-npc-detail').value.trim();
      await _saveEditingWV(w);
      if (!silent) UI.showToast('常驻角色已保存');
      _renderGlobalNpcs(w.globalNpcs);
      return;
    }
    // 普通地区/势力 NPC
    if (_editRegionIdx < 0 || _editFactionIdx < 0 || _editNPCIdx < 0) return;
    const npc = w.regions[_editRegionIdx]?.factions[_editFactionIdx]?.npcs[_editNPCIdx];
    if (!npc) return;
    npc.name = document.getElementById('wv-npc-name').value.trim();
    npc.aliases = document.getElementById('wv-npc-aliases').value.trim();
    npc.summary = document.getElementById('wv-npc-summary').value.trim();
    npc.detail = document.getElementById('wv-npc-detail').value.trim();

    await _saveEditingWV(w);
    if (!silent) UI.showToast('角色已保存');
    _renderNPCCards(w.regions[_editRegionIdx].factions[_editFactionIdx].npcs);
  }

  async function deleteNPC() {
    const w = await _getEditingWV();
    if (!w) return;
    // 全图 NPC 模式
    if (_editGlobalNpcIdx >= 0) {
      const npc = w.globalNpcs && w.globalNpcs[_editGlobalNpcIdx];
      if (!await UI.showConfirm('删除常驻角色', `确定删除"${npc?.name || '未命名'}"？`)) return;
      w.globalNpcs.splice(_editGlobalNpcIdx, 1);
      _editGlobalNpcIdx = -1;
      await _saveEditingWV(w);
      _renderGlobalNpcs(w.globalNpcs);
      UI.showPanel('worldview-edit', 'back');
      return;
    }
    if (_editRegionIdx < 0 || _editFactionIdx < 0 || _editNPCIdx < 0) return;
    const npc = w.regions[_editRegionIdx]?.factions[_editFactionIdx]?.npcs[_editNPCIdx];
    if (!await UI.showConfirm('删除角色', `确定删除"${npc?.name || '未命名'}"？`)) return;
    w.regions[_editRegionIdx].factions[_editFactionIdx].npcs.splice(_editNPCIdx, 1);
    await _saveEditingWV(w);
    _renderNPCCards(w.regions[_editRegionIdx].factions[_editFactionIdx].npcs);
    UI.showPanel('wv-faction', 'back');
  }
  
  // ---------- 添加按钮（传-1表示新增） ----------
  function addRegion() { openRegionEdit(-1); }
  function addFaction() { openFactionEdit(-1); }
  function addNPC() { openNPCEdit(-1); }

  // ---------- 全图 NPC ----------
  let _editGlobalNpcIdx = -1;  // ≥0 时表示当前编辑的是全图 NPC

  /**
   * NPC 编辑面板的返回按钮：
   * - 全图 NPC → 返回 worldview-edit（世界观主编辑页）
   * - 普通 NPC → 返回 wv-faction（势力编辑页）
   */
  function backFromNpcEdit() {
    if (_editGlobalNpcIdx >= 0) {
      UI.showPanel('worldview-edit', 'back');
    } else {
      UI.showPanel('wv-faction', 'back');
    }
  }
  let _globalNpcsCache = [];   // 渲染缓存（只用于显示）

  function _renderGlobalNpcs(list) {
    _globalNpcsCache = list || [];
    const container = document.getElementById('wv-global-npcs-container');
    if (!container) return;
    if (_globalNpcsCache.length === 0) {
      container.innerHTML = `<div style="text-align:center;color:var(--text-secondary);font-size:12px;padding:14px 0;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px">还没有常驻角色</div>`;
      return;
    }
    container.innerHTML = _globalNpcsCache.map((n, i) => `
      <div onclick="Worldview.editGlobalNpc(${i})" style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer">
        <div style="display:flex;align-items:center;gap:6px;font-size:14px;color:var(--text)">
          <span style="font-weight:600">${Utils.escapeHtml(n.name || '未命名')}</span>
          ${n.aliases ? `<span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(n.aliases)}</span>` : ''}
        </div>
        ${n.summary ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(n.summary)}</div>` : ''}
      </div>
    `).join('');
  }

  async function addGlobalNpc() {
    const w = await _getEditingWV();
    if (!w) return;
    if (!w.globalNpcs) w.globalNpcs = [];
    w.globalNpcs.push(_defaultNPC());
    await _saveEditingWV(w);
    _renderGlobalNpcs(w.globalNpcs);
    editGlobalNpc(w.globalNpcs.length - 1);
  }

  async function editGlobalNpc(idx) {
    const w = await _getEditingWV();
    if (!w || !w.globalNpcs) return;
    const npc = w.globalNpcs[idx];
    if (!npc) return;
    _editGlobalNpcIdx = idx;
    _editRegionIdx = -1;
    _editFactionIdx = -1;
    _editNPCIdx = -1;

    document.getElementById('wv-npc-title').textContent = (npc.name || '编辑角色') + ' · 全图';
    document.getElementById('wv-npc-name').value = npc.name || '';
    document.getElementById('wv-npc-aliases').value = npc.aliases || '';
    document.getElementById('wv-npc-summary').value = npc.summary || '';
    document.getElementById('wv-npc-detail').value = npc.detail || '';
    // 全图 NPC 不需要简介（不进速查表）
    const sumLbl = document.getElementById('wv-npc-summary-label');
    if (sumLbl) sumLbl.style.display = 'none';

    UI.showPanel('wv-npc', 'forward');
    requestAnimationFrame(_attachWVNpcAutoSave);
    const resize = () => {
      ['wv-npc-summary', 'wv-npc-detail'].forEach(id => {
        const ta = document.getElementById(id);
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
        ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
      });
    };
    requestAnimationFrame(resize);
    setTimeout(resize, 260);
  }
  
  // ---------- 节日/自定义内存数组 ----------
let festivalsData = [];
let customsData = [];
let knowledgesData = [];

  // ---------- 节日渲染（只读卡片） ----------
  function _renderFestivals(festivals) {
    festivalsData = festivals || [];
    const container = document.getElementById('wv-festivals-container');
    if (!container) return;
    container.innerHTML = festivalsData.map((f, i) => {
      const enabled = f.enabled !== false;
      return `
      <div style="position:relative;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px 12px 12px 44px;margin-bottom:8px;cursor:pointer" onclick="Worldview.editFestival(${i})">
        <button type="button" onclick="event.stopPropagation();Worldview.toggleFestivalEnabled(${i})" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);width:24px;height:24px;border-radius:50%;border:2px solid ${enabled ? 'var(--accent)' : 'var(--text-secondary)'};background:${enabled ? 'var(--accent)' : 'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">
          ${enabled ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
        </button>
        <div style="position:absolute;top:8px;right:8px;font-size:11px;background:var(--accent);color:#000;padding:2px 6px;border-radius:4px">${f.yearly ? '每年' : '一次'}</div>
        <div style="font-size:15px;font-weight:bold;color:${enabled ? 'var(--accent)' : 'var(--text-secondary)'};margin-bottom:4px;padding-right:48px">${Utils.escapeHtml(f.name || '未命名节日')}</div>
        <div style="font-size:12px;color:var(--text-secondary)">${Utils.escapeHtml(f.date || '')}</div>
        ${f.content ? `<div style="font-size:12px;color:var(--text);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(f.content)}</div>` : ''}
      </div>
    `;
    }).join('');
    _updateExtCounts();
    _applyExtSearch();
  }

  function toggleFestivalEnabled(i) {
    if (!festivalsData[i]) return;
    festivalsData[i].enabled = festivalsData[i].enabled === false;
    _renderFestivals(festivalsData);
  }

  let _editFestivalIdx = null;

  function addFestival() {
    festivalsData.push(_defaultFestival());
    editFestival(festivalsData.length - 1);
  }
  function _syncFestYearlyUI() {
    const input = document.getElementById('wv-fest-modal-yearly');
    const ui = document.getElementById('wv-fest-modal-yearly-ui');
    if (!input || !ui) return;
    ui.style.background = input.checked ? 'var(--accent)' : 'transparent';
    ui.style.borderColor = input.checked ? 'var(--accent)' : 'var(--text-secondary)';
    ui.innerHTML = input.checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '';
  }
  function _syncFestEnabledUI() {
    const input = document.getElementById('wv-fest-modal-enabled');
    const ui = document.getElementById('wv-fest-modal-enabled-ui');
    if (!input || !ui) return;
    ui.style.background = input.checked ? 'var(--accent)' : 'transparent';
    ui.style.borderColor = input.checked ? 'var(--accent)' : 'var(--text-secondary)';
    ui.innerHTML = input.checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '';
  }

  function editFestival(i) {
    _editFestivalIdx = i;
    const f = festivalsData[i] || _defaultFestival();
    document.getElementById('wv-fest-modal-name').value = f.name || '';
    document.getElementById('wv-fest-modal-date').value = f.date || '';
    document.getElementById('wv-fest-modal-yearly').checked = !!f.yearly;
    document.getElementById('wv-fest-modal-yearly').onchange = _syncFestYearlyUI;
    _syncFestYearlyUI();
    document.getElementById('wv-fest-modal-enabled').checked = f.enabled !== false;
    document.getElementById('wv-fest-modal-enabled').onchange = _syncFestEnabledUI;
    _syncFestEnabledUI();
    document.getElementById('wv-fest-modal-content').value = f.content || '';
    document.getElementById('wv-festival-modal').classList.remove('hidden');
  }
  function saveFestivalFromModal() {
    if (_editFestivalIdx === null) return;
    festivalsData[_editFestivalIdx] = {
      id: (festivalsData[_editFestivalIdx] && festivalsData[_editFestivalIdx].id) || ('fest_' + Utils.uuid().slice(0,8)),
      name: document.getElementById('wv-fest-modal-name').value.trim(),
      date: document.getElementById('wv-fest-modal-date').value.trim(),
      yearly: document.getElementById('wv-fest-modal-yearly').checked,
      enabled: document.getElementById('wv-fest-modal-enabled').checked,
      content: document.getElementById('wv-fest-modal-content').value.trim()
    };
    _renderFestivals(festivalsData);
    closeFestivalModal();
  }
  function deleteFestivalFromModal() {
    if (_editFestivalIdx === null) return;
    festivalsData.splice(_editFestivalIdx, 1);
    _renderFestivals(festivalsData);
    closeFestivalModal();
  }
  function closeFestivalModal() {
    _editFestivalIdx = null;
    document.getElementById('wv-festival-modal').classList.add('hidden');
  }

  // ---------- 自定义设定渲染（只读卡片） ----------
  function _renderCustoms(customs) {
    customsData = customs || [];
    const container = document.getElementById('wv-customs-container');
    if (!container) return;
    container.innerHTML = customsData.map((c, i) => {
      const enabled = c.enabled !== false;
      const posLabel = _positionLabel(c.position || 'system_top', c.depth);
      return `<div style="position:relative;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px 12px 12px 44px;margin-bottom:8px;cursor:pointer" onclick="Worldview.editCustom(${i})">
        <button type="button" onclick="event.stopPropagation();Worldview.toggleCustomEnabled(${i})" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);width:24px;height:24px;border-radius:50%;border:2px solid ${enabled ? 'var(--accent)' : 'var(--text-secondary)'};background:${enabled ? 'var(--accent)' : 'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">
          ${enabled ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
        </button>
        <div style="font-size:14px;font-weight:bold;color:${enabled ? 'var(--accent)' : 'var(--text-secondary)'};margin-bottom:4px">${Utils.escapeHtml(c.name || '未命名条目')}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;display:flex;align-items:center;gap:4px">${_positionIcon(c.position || 'system_top')}<span>${posLabel}</span></div>
        ${c.content ? `<div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.content)}</div>` : ''}
      </div>`;
    }).join('');
    _updateExtCounts();
    _applyExtSearch();
  }
  function toggleCustomEnabled(i) {
    if (!customsData[i]) return;
    customsData[i].enabled = !customsData[i].enabled;
    _renderCustoms(customsData);
  }
  function _positionLabel(pos, depth) {
    if (pos === 'system_bottom') return '系统底部';
    if (pos === 'depth') return `深度 ${depth || 0}`;
    return '系统顶部';
  }
  // 注入位置的 SVG 图标（与提示词模块一致）
  function _positionIcon(pos) {
    const sz = 'width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;vertical-align:middle"';
    if (pos === 'system_bottom') {
      return `<svg xmlns="http://www.w3.org/2000/svg" ${sz}><path d="M3 6h18M3 12h18M3 18h18"/></svg>`;
    }
    if (pos === 'depth') {
      return `<svg xmlns="http://www.w3.org/2000/svg" ${sz}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    }
    // system_top（默认）
    return `<svg xmlns="http://www.w3.org/2000/svg" ${sz}><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`;
  }
let _editCustomIdx = null;
function _syncCustomEnabledUI() {
const input = document.getElementById('wv-cust-modal-enabled');
const ui = document.getElementById('wv-cust-modal-enabled-ui');
if (!input || !ui) return;
ui.style.background = input.checked ? 'var(--accent)' : 'transparent';
ui.style.borderColor = input.checked ? 'var(--accent)' : 'var(--text-secondary)';
ui.innerHTML = input.checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '';
}


  function addCustom() {
    customsData.push(_defaultCustom());
    editCustom(customsData.length - 1);
  }
  function editCustom(i) {
    _editCustomIdx = i;
    const c = customsData[i] || _defaultCustom();
    document.getElementById('wv-cust-modal-name').value = c.name || '';
    document.getElementById('wv-cust-modal-content').value = c.content || '';
    document.getElementById('wv-cust-modal-enabled').checked = !!c.enabled;
    document.getElementById('wv-cust-modal-trigger').checked = !!c.keywordTrigger;
    document.getElementById('wv-cust-modal-keys').value = c.keys || '';
    _selectCustPosition(c.position || 'system_top');
    document.getElementById('wv-cust-modal-depth').value = (typeof c.depth === 'number') ? c.depth : 0;
    document.getElementById('wv-cust-modal-enabled').onchange = _syncCustomEnabledUI;
    document.getElementById('wv-cust-modal-trigger').onchange = _syncCustomTriggerUI;
    _syncCustomEnabledUI();
    _syncCustomTriggerUI();
    document.getElementById('wv-custom-modal').classList.remove('hidden');
  }
  function _syncCustomTriggerUI() {
    const input = document.getElementById('wv-cust-modal-trigger');
    const ui = document.getElementById('wv-cust-modal-trigger-ui');
    const keysRow = document.getElementById('wv-cust-modal-keys-row');
    if (!input || !ui) return;
    ui.style.background = input.checked ? 'var(--accent)' : 'transparent';
    ui.style.borderColor = input.checked ? 'var(--accent)' : 'var(--text-secondary)';
    ui.innerHTML = input.checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '';
    if (keysRow) keysRow.style.display = input.checked ? '' : 'none';
  }
  function toggleCustPositionDropdown() {
    const dd = document.getElementById('wv-cust-modal-position-dropdown');
    if (dd) dd.classList.toggle('hidden');
  }
  function selectCustPosition(pos) {
    _selectCustPosition(pos);
    const dd = document.getElementById('wv-cust-modal-position-dropdown');
    if (dd) dd.classList.add('hidden');
  }
  function _selectCustPosition(pos) {
    document.getElementById('wv-cust-modal-position').value = pos;
    const label = document.getElementById('wv-cust-modal-position-label');
    const depthRow = document.getElementById('wv-cust-modal-depth-row');
    const txt = pos === 'system_bottom' ? '系统底部' : pos === 'depth' ? '按聊天深度插入' : '系统顶部';
    if (label) label.innerHTML = `${_positionIcon(pos)} <span>${txt}</span>`;
    if (depthRow) depthRow.style.display = pos === 'depth' ? '' : 'none';
  }
  function saveCustomFromModal() {
    if (_editCustomIdx === null) return;
    const prev = customsData[_editCustomIdx] || {};
    const trigger = document.getElementById('wv-cust-modal-trigger').checked;
    const entry = {
      id: prev.id || ('know_' + Utils.uuid().slice(0,8)),
      name: document.getElementById('wv-cust-modal-name').value.trim(),
      content: document.getElementById('wv-cust-modal-content').value.trim(),
      enabled: document.getElementById('wv-cust-modal-enabled').checked,
      keywordTrigger: trigger,
      keys: trigger ? (document.getElementById('wv-cust-modal-keys').value.trim()) : '',
      position: document.getElementById('wv-cust-modal-position').value || 'system_top',
      depth: parseInt(document.getElementById('wv-cust-modal-depth').value, 10) || 0
    };
    // 跨模式：从 customsData 移除，追加到 knowledgesData，刷新两边
    if (trigger) {
      customsData.splice(_editCustomIdx, 1);
      knowledgesData.push(entry);
      _renderCustoms(customsData);
      _renderKnowledges(knowledgesData);
      // 切到动态 tab 让用户看到迁移结果
      switchExtSubtab('dynamic');
    } else {
      customsData[_editCustomIdx] = entry;
      _renderCustoms(customsData);
    }
    closeCustomModal();
  }
  function deleteCustomFromModal() {
    if (_editCustomIdx === null) return;
    customsData.splice(_editCustomIdx, 1);
    _renderCustoms(customsData);
    closeCustomModal();
  }
  function closeCustomModal() {
_editCustomIdx = null;
document.getElementById('wv-custom-modal').classList.add('hidden');
}

// ---------- 知识设定（关键词触发注入） ----------
function _renderKnowledges(list) {
knowledgesData = list || [];
const container = document.getElementById('wv-knowledges-container');
if (!container) return;
container.innerHTML = knowledgesData.map((k, i) => {
const enabled = k.enabled !== false;
const keys = (k.keys || '').trim();
const keyTags = keys
? keys.split(/[,，\s]+/).filter(Boolean).map(t => `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${Utils.escapeHtml(t)}</span>`).join('')
: '<span style="font-size:11px;color:var(--danger)">未设置关键词</span>';
const posLabel = _positionLabel(k.position || 'system_top', k.depth);
return `<div style="position:relative;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px 12px 12px 44px;margin-bottom:8px;cursor:pointer" onclick="Worldview.editKnowledge(${i})">
<button type="button" onclick="event.stopPropagation();Worldview.toggleKnowledgeEnabled(${i})" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);width:24px;height:24px;border-radius:50%;border:2px solid ${enabled ? 'var(--accent)' : 'var(--text-secondary)'};background:${enabled ? 'var(--accent)' : 'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">
${enabled ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
</button>
<div style="font-size:14px;font-weight:bold;color:${enabled ? 'var(--accent)' : 'var(--text-secondary)'};margin-bottom:4px">${Utils.escapeHtml(k.name || '未命名条目')}</div>
<div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;display:flex;align-items:center;gap:4px">${_positionIcon(k.position || 'system_top')}<span>${posLabel}</span></div>
<div style="margin-bottom:6px">${keyTags}</div>
${k.content ? `<div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(k.content)}</div>` : ''}
</div>`;
}).join('');
_updateExtCounts();
_applyExtSearch();
}
function toggleKnowledgeEnabled(i) {
if (!knowledgesData[i]) return;
knowledgesData[i].enabled = !knowledgesData[i].enabled;
_renderKnowledges(knowledgesData);
}
let _editKnowledgeIdx = null;
function addKnowledge() {
knowledgesData.push(_defaultKnowledge());
editKnowledge(knowledgesData.length - 1);
}
function editKnowledge(i) {
_editKnowledgeIdx = i;
const k = knowledgesData[i] || _defaultKnowledge();
document.getElementById('wv-know-modal-name').value = k.name || '';
document.getElementById('wv-know-modal-keys').value = k.keys || '';
document.getElementById('wv-know-modal-content').value = k.content || '';
// 动态条目默认 keywordTrigger=true
const trigger = (k.keywordTrigger === undefined || k.keywordTrigger === null) ? true : !!k.keywordTrigger;
document.getElementById('wv-know-modal-trigger').checked = trigger;
_selectKnowPosition(k.position || 'system_top');
document.getElementById('wv-know-modal-depth').value = (typeof k.depth === 'number') ? k.depth : 0;
document.getElementById('wv-know-modal-trigger').onchange = _syncKnowTriggerUI;
_syncKnowTriggerUI();
document.getElementById('wv-knowledge-modal').classList.remove('hidden');
}
function _syncKnowTriggerUI() {
const input = document.getElementById('wv-know-modal-trigger');
const ui = document.getElementById('wv-know-modal-trigger-ui');
const keysRow = document.getElementById('wv-know-modal-keys-row');
if (!input || !ui) return;
ui.style.background = input.checked ? 'var(--accent)' : 'transparent';
ui.style.borderColor = input.checked ? 'var(--accent)' : 'var(--text-secondary)';
ui.innerHTML = input.checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '';
if (keysRow) keysRow.style.display = input.checked ? '' : 'none';
}
function toggleKnowPositionDropdown() {
const dd = document.getElementById('wv-know-modal-position-dropdown');
if (dd) dd.classList.toggle('hidden');
}
function selectKnowPosition(pos) {
_selectKnowPosition(pos);
const dd = document.getElementById('wv-know-modal-position-dropdown');
if (dd) dd.classList.add('hidden');
}
function _selectKnowPosition(pos) {
document.getElementById('wv-know-modal-position').value = pos;
const label = document.getElementById('wv-know-modal-position-label');
const depthRow = document.getElementById('wv-know-modal-depth-row');
const txt = pos === 'system_bottom' ? '系统底部' : pos === 'depth' ? '按聊天深度插入' : '系统顶部';
if (label) label.innerHTML = `${_positionIcon(pos)} <span>${txt}</span>`;
if (depthRow) depthRow.style.display = pos === 'depth' ? '' : 'none';
}
function saveKnowledgeFromModal() {
if (_editKnowledgeIdx === null) return;
const prev = knowledgesData[_editKnowledgeIdx] || {};
const trigger = document.getElementById('wv-know-modal-trigger').checked;
const entry = {
id: prev.id || ('know_' + Utils.uuid().slice(0,8)),
name: document.getElementById('wv-know-modal-name').value.trim(),
keys: trigger ? (document.getElementById('wv-know-modal-keys').value.trim()) : '',
content: document.getElementById('wv-know-modal-content').value.trim(),
enabled: (prev.enabled === undefined || prev.enabled === null) ? true : !!prev.enabled,
keywordTrigger: trigger,
position: document.getElementById('wv-know-modal-position').value || 'system_top',
depth: parseInt(document.getElementById('wv-know-modal-depth').value, 10) || 0
};
// 跨模式：移到 customsData
if (!trigger) {
knowledgesData.splice(_editKnowledgeIdx, 1);
customsData.push(entry);
_renderKnowledges(knowledgesData);
_renderCustoms(customsData);
switchExtSubtab('constant');
} else {
knowledgesData[_editKnowledgeIdx] = entry;
_renderKnowledges(knowledgesData);
}
closeKnowledgeModal();
}
function deleteKnowledgeFromModal() {
if (_editKnowledgeIdx === null) return;
knowledgesData.splice(_editKnowledgeIdx, 1);
_renderKnowledges(knowledgesData);
closeKnowledgeModal();
}
function closeKnowledgeModal() {
    _editKnowledgeIdx = null;
    document.getElementById('wv-knowledge-modal').classList.add('hidden');
  }

  // ---------- 事件设定（关键词触发 → 持续注入 → 结束关键词关闭） ----------
  let eventsData = [];
  function _renderEvents(list) {
    eventsData = list || [];
    const container = document.getElementById('wv-events-container');
    if (!container) return;
    container.innerHTML = eventsData.map((ev, i) => {
      const keys = (ev.keys || '').trim();
      const keyTags = keys
        ? keys.split(/[,，\s]+/).filter(Boolean).map(t => `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${Utils.escapeHtml(t)}</span>`).join('')
        : '<span style="font-size:11px;color:var(--danger)">未设置关键词</span>';
      const completeKey = ev.completeKey ? `<span style="font-size:11px;color:var(--text-secondary)">结束词：${Utils.escapeHtml(ev.completeKey)}</span>` : '<span style="font-size:11px;color:var(--danger)">未设置结束词</span>';
      return `<div style="position:relative;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer" onclick="Worldview.editEvent(${i})">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg>
          <span style="font-size:14px;font-weight:bold;color:var(--accent)">${Utils.escapeHtml(ev.name || '未命名事件')}</span>
        </div>
        <div style="margin-bottom:4px">${keyTags}</div>
        <div style="margin-bottom:4px">${completeKey}</div>
        ${ev.content ? `<div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(ev.content)}</div>` : ''}
      </div>`;
    }).join('');
    _updateExtCounts();
    _applyExtSearch();
  }
  let _editEventIdx = null;
  function addEvent() {
    eventsData.push({
      id: 'evt_' + Utils.uuid().slice(0, 8),
      name: '',
      keys: '',
      completeKey: '',
      content: '',
      triggerMode: 'event'
    });
    editEvent(eventsData.length - 1);
  }
  function editEvent(i) {
    _editEventIdx = i;
    const ev = eventsData[i] || {};
    document.getElementById('wv-event-modal-title').textContent = ev.name ? '编辑事件' : '新建事件';
    document.getElementById('wv-event-modal-name').value = ev.name || '';
    document.getElementById('wv-event-modal-keys').value = ev.keys || '';
    document.getElementById('wv-event-modal-complete-key').value = ev.completeKey || '';
    document.getElementById('wv-event-modal-content').value = ev.content || '';
    document.getElementById('wv-event-modal').classList.remove('hidden');
  }
  function saveEventFromModal() {
    if (_editEventIdx === null) return;
    const prev = eventsData[_editEventIdx] || {};
    eventsData[_editEventIdx] = {
      id: prev.id || ('evt_' + Utils.uuid().slice(0, 8)),
      name: document.getElementById('wv-event-modal-name').value.trim(),
      keys: document.getElementById('wv-event-modal-keys').value.trim(),
      completeKey: document.getElementById('wv-event-modal-complete-key').value.trim(),
      content: document.getElementById('wv-event-modal-content').value.trim(),
      triggerMode: 'event'
    };
    _renderEvents(eventsData);
    closeEventModal();
  }
  function deleteEventFromModal() {
    if (_editEventIdx === null) return;
    eventsData.splice(_editEventIdx, 1);
    _renderEvents(eventsData);
    closeEventModal();
  }
  function closeEventModal() {
    _editEventIdx = null;
    document.getElementById('wv-event-modal').classList.add('hidden');
  }
  
  // ---------- 同步到运行时 ----------
  // 把 DB 中的世界观数据同步给 Chat（worldviewPrompt）和 NPC 模块。
  // 仅当被编辑的就是当前激活世界观时才同步，避免编辑别的世界观影响当前会话。
  async function _syncRuntime(w) {
    if (!w) return;
    if (w.id !== currentWorldviewId) return; // 不是当前激活世界观，跳过
    try { Chat.setWorldview(_buildSettingWithExtras(w)); } catch(e) { console.warn('[Worldview] sync prompt 失败', e); }
    try {
      const flatNpcs = [];
      const flatFacs = [];
      const flatRegions = [];
      (w.regions || []).forEach(reg => {
        flatRegions.push({ name: reg.name, summary: reg.summary, detail: reg.detail });
        (reg.factions || []).forEach(fac => {
          flatFacs.push({ name: fac.name, summary: fac.summary, detail: fac.detail, regionName: reg.name });
          (fac.npcs || []).forEach(npc => {
            flatNpcs.push({ ...npc, regionName: reg.name, factionName: fac.name });
          });
        });
      });
      NPC.init({ npcs: flatNpcs, factions: flatFacs, regions: flatRegions });
    } catch(e) { console.warn('[Worldview] sync NPC 失败', e); }
  }

  // ---------- 保存 ----------
  async function save() {
    if (!editingWorldviewId) return;
    
    const w = await DB.get('worldviews', editingWorldviewId) || _defaultWorldview(editingWorldviewId);

    // v596：隐藏世界观特殊保存（只存扩展数据，不改基础字段）
    if (isHiddenWv(w)) {
      w.festivals = festivalsData.slice();
      w.knowledges = customsData.concat(knowledgesData).map(k => ({
        id: k.id,
        name: k.name || '',
        content: k.content || '',
        enabled: (k.enabled === undefined || k.enabled === null) ? true : !!k.enabled,
        keywordTrigger: !!k.keywordTrigger,
        keys: k.keywordTrigger ? (k.keys || '') : '',
        position: k.position || 'system_top',
        depth: (typeof k.depth === 'number') ? k.depth : 0
      }));
      w.events = eventsData.slice();
      if ('customs' in w) delete w.customs;
      await DB.put('worldviews', w);
      UI.showToast('已保存扩展设定');
      return;
    }
    
    // 基础设定
    w.name = document.getElementById('wv-name').value.trim() || '未命名';
    w.description = document.getElementById('wv-description').value.trim();
    w.icon = w.icon || 'world'; // 保留原值
    w.setting = document.getElementById('wv-setting').value.trim();
    w.currency = w.currency || { name: '', desc: '' };
    w.currency.name = (document.getElementById('wv-currency-name')?.value || '').trim();
    w.currency.desc = (document.getElementById('wv-currency-desc')?.value || '').trim();
    w.phoneApps = w.phoneApps || { takeout: { name: '', desc: '' }, shop: { name: '', desc: '' }, forum: { name: '', desc: '' } };
    w.phoneApps.takeout = w.phoneApps.takeout || { name: '', desc: '' };
    w.phoneApps.shop = w.phoneApps.shop || { name: '', desc: '' };
    w.phoneApps.forum = w.phoneApps.forum || { name: '', desc: '' };
    w.phoneApps.takeout.name = (document.getElementById('wv-takeout-name')?.value || '').trim();
    w.phoneApps.takeout.desc = (document.getElementById('wv-takeout-desc')?.value || '').trim();
    w.phoneApps.shop.name = (document.getElementById('wv-shop-name')?.value || '').trim();
    w.phoneApps.shop.desc = (document.getElementById('wv-shop-desc')?.value || '').trim();
    w.phoneApps.forum.name = (document.getElementById('wv-forum-name')?.value || '').trim();
    w.phoneApps.forum.desc = (document.getElementById('wv-forum-desc')?.value || '').trim();
    w.startTime = document.getElementById('wv-start-time').value.trim();
    w.startPlot = document.getElementById('wv-start-plot').value.trim();
    w.startPlotRounds = parseInt(document.getElementById('wv-start-plot-rounds').value) || 5;
    w.startMessage = document.getElementById('wv-start-message').value.trim();
    // 绑定主题
    const themeInput = document.getElementById('wv-theme-binding');
    w.themeName = themeInput ? themeInput.value : (w.themeName || '');
    
    // 图片
    const imgEl = document.querySelector('#wv-icon-image-preview img');
    w.iconImage = imgEl ? (imgEl.dataset.value || imgEl.src || '') : '';
    if (!imgEl) w.iconImage = '';
    
    // 三级嵌套：已实时保存到DB，直接读取
    // w.regions 已经是最新的（每次子面板保存都写DB了）
    
    // 节日
    w.festivals = festivalsData.slice();
    
    // v581：customs + knowledges 统一写入 w.knowledges
    // customsData = 常驻条目（keywordTrigger=false）
    // knowledgesData = 动态条目（keywordTrigger=true）
    w.knowledges = customsData.concat(knowledgesData).map(k => ({
      id: k.id,
      name: k.name || '',
      content: k.content || '',
      enabled: (k.enabled === undefined || k.enabled === null) ? true : !!k.enabled,
      keywordTrigger: !!k.keywordTrigger,
      keys: k.keywordTrigger ? (k.keys || '') : '',
      position: k.position || 'system_top',
      depth: (typeof k.depth === 'number') ? k.depth : 0
    }));
    // 删除旧字段（保证导出/存储干净）
    if ('customs' in w) delete w.customs;
    
    // 事件设定
    w.events = eventsData.slice();
    
    await DB.put('worldviews', w);
    
    // 更新列表元数据
    const list = await getWorldviewList();
    const entry = list.find(e => e.id === editingWorldviewId);
    if (entry) {
      entry.name = w.name;
      entry.description = w.description;
      entry.icon = w.icon;
      entry.iconImage = w.iconImage;
    }
    await saveWorldviewList(list);
    
     UI.showToast('保存成功');
     // 同步到运行时（如果改的就是当前激活世界观，AI 立刻看到新设定）
     await _syncRuntime(w);
     await load();
   }
  
  // ---------- 删除世界观时迁移对话 ----------
  async function _migrateConvsFromWorldview(wvId) {
    await Conversations.migrateWorldview(wvId, '__default_wv__');
  }

  async function deleteCurrentWorldview() {
    if (!editingWorldviewId) return;
    const w = await DB.get('worldviews', editingWorldviewId);
    const isBuiltin = _isBuiltinWorldview(w);
    if (isBuiltin) {
      const name = w?.name || '此世界观';
      const okBuiltin = await UI.showConfirm('删除内置世界观', `「${name}」是内置世界观，可能绑定专属机制、开场流程、角色匹配、地区流动或隐藏提示词。\n\n删除后，相关对话会被改为「无世界观」，对应机制也可能无法正常触发。\n\n确定要删除吗？`);
      if (!okBuiltin) return;
    }
    if (!await UI.showConfirm('确认删除', '确定删除此世界观？\n\n该世界观下的对话将被改为「无世界观」。')) return;
    // 把关联对话迁移到默认（无世界观）
    await _migrateConvsFromWorldview(editingWorldviewId);
    await DB.del('worldviews', editingWorldviewId);
    const list = await getWorldviewList();
    await saveWorldviewList(list.filter(w => w.id !== editingWorldviewId));
    // 如果删的是当前世界观，切到默认
    if (currentWorldviewId === editingWorldviewId) {
      currentWorldviewId = '__default_wv__';
      await DB.put('gameState', { key: 'currentWorldviewId', value: currentWorldviewId });
    }
    editingWorldviewId = null;
    UI.showPanel('worldview');
    await load();
  }
  
  // ---------- 获取当前世界观（供chat.js调用） ----------
  async function getCurrent() {
    if (!currentWorldviewId) return null;
    return await DB.get('worldviews', currentWorldviewId);
  }
  function setCurrentId(id) {
    currentWorldviewId = id;
  }
  function getCurrentId() {
    return currentWorldviewId;
  }
  
  // ---------- 当前世界观下拉菜单 ----------
  let scopeDropdownVisible = false;
  
  async function toggleScopeDropdown() {
    const dropdown = document.getElementById('worldview-scope-dropdown');
    if (!dropdown) return;
    scopeDropdownVisible = !scopeDropdownVisible;
    if (scopeDropdownVisible) {
      await _renderScopeDropdown();
      dropdown.classList.remove('hidden');
      document.addEventListener('click', _closeScopeOutside);
    } else {
      dropdown.classList.add('closing');
      setTimeout(() => { dropdown.classList.add('hidden'); dropdown.classList.remove('closing'); }, 120);
      document.removeEventListener('click', _closeScopeOutside);
    }
  }
  function _closeScopeOutside(e) {
    const card = document.getElementById('current-worldview-card');
    if (card && !card.contains(e.target)) {
      scopeDropdownVisible = false;
      const dropdown = document.getElementById('worldview-scope-dropdown');
      if (dropdown) {
        dropdown.classList.add('closing');
        setTimeout(() => { dropdown.classList.add('hidden'); dropdown.classList.remove('closing'); }, 120);
      }
      document.removeEventListener('click', _closeScopeOutside);
    }
  }
  async function _renderScopeDropdown() {
    const dropdown = document.getElementById('worldview-scope-dropdown');
    if (!dropdown) return;
    const list = await getWorldviewList();
    let html = '';
    list.forEach(w => {
      const active = w.id === currentWorldviewId || (!currentWorldviewId && w.id === '__default_wv__');
      const iconHTML = w.iconImage
        ? `<img src="${w.iconImage}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:8px">`
        : `<div style="width:24px;height:24px;border-radius:50%;background:var(--accent);display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;color:#111;margin-right:8px;flex-shrink:0;vertical-align:middle">${Utils.escapeHtml((w.name || '?')[0])}</div>`;
      html += `<div onclick="Worldview.selectWorldview('${w.id}')" style="padding:10px 16px;cursor:pointer;font-size:13px;color:var(--text);display:flex;align-items:center${active ? ';background:var(--bg-tertiary);font-weight:bold' : ''}">${iconHTML}${Utils.escapeHtml(w.name)}</div>`;
    });
    dropdown.innerHTML = html;
  }
  // 辅助：从regions嵌套结构展平NPC和Faction给NPC模块用
  function _flattenNPCs(regions) {
    const npcs = [];
    (regions || []).forEach(r => {
      (r.factions || []).forEach(f => {
        (f.npcs || []).forEach(n => {
          npcs.push({ ...n, faction: f.name, regions: [r.id || r.name] });
        });
      });
    });
    return npcs;
  }
  function _flattenFactions(regions) {
    const factions = [];
    (regions || []).forEach(r => {
      (r.factions || []).forEach(f => {
        factions.push({ ...f, regionName: r.name, regionId: r.id });
      });
    });
    return factions;
  }

  async function selectWorldview(id) {
    // 教程模式下禁止切换世界观
    if (typeof Tutorial !== 'undefined' && Tutorial.isEnabled()) {
      UI.showToast('新手引导中，暂时无法切换世界观', 1800);
      return;
    }

    // 心动模拟世界观：首次切入时弹病娇题材警告
    if (id === 'wv_heartsim') {
      const DISMISS_KEY = 'heartsim_warning_dismissed';
      const dismissed = (() => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch(_) { return false; } })();
      if (!dismissed) {
        const confirmed = await new Promise(resolve => {
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:24px';
          overlay.innerHTML = `
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:340px;width:100%;color:var(--text);font-size:14px;line-height:1.7">
              <div style="font-size:16px;font-weight:600;margin-bottom:12px;color:var(--accent)">⚠️ 内容提示</div>
              <div style="margin-bottom:16px">
                心动模拟世界观为<strong>病娇题材</strong>，所有角色都存在不同类型的危险倾向，包括但不限于：占有、控制、监视、囚禁等极端行为。<br><br>
                是否继续？
              </div>
              <label style="display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:12px;color:var(--text-secondary);cursor:pointer;user-select:none">
                <input type="checkbox" id="hs-warn-dismiss" style="width:16px;height:16px;accent-color:var(--accent);border-radius:50%;cursor:pointer">
                下次不再提醒
              </label>
              <div style="display:flex;gap:8px;justify-content:flex-end">
                <button id="hs-warn-cancel" style="padding:8px 20px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;cursor:pointer">取消</button>
                <button id="hs-warn-ok" style="padding:8px 20px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">继续</button>
              </div>
            </div>`;
          document.body.appendChild(overlay);
          overlay.querySelector('#hs-warn-ok').onclick = () => {
            const cb = overlay.querySelector('#hs-warn-dismiss');
            if (cb && cb.checked) { try { localStorage.setItem(DISMISS_KEY, '1'); } catch(_) {} }
            overlay.remove();
            resolve(true);
          };
          overlay.querySelector('#hs-warn-cancel').onclick = () => { overlay.remove(); resolve(false); };
        });
        if (!confirmed) return;
      }
    }

    currentWorldviewId = id || '__default_wv__';
    await DB.put('gameState', { key: 'currentWorldviewId', value: currentWorldviewId });
    // 关闭下拉
    scopeDropdownVisible = false;
    const dropdown = document.getElementById('worldview-scope-dropdown');
    if (dropdown) {
      dropdown.classList.add('closing');
      setTimeout(() => { dropdown.classList.add('hidden'); dropdown.classList.remove('closing'); }, 120);
    }
    document.removeEventListener('click', _closeScopeOutside);
    await _updateCurrentCard();
    // 绑定主题联动
    if (currentWorldviewId) {
      const w = await DB.get('worldviews', currentWorldviewId);
      if (w && w.themeName) {
        _applyBoundTheme(w.themeName);
      }
      // 同步NPC和世界观prompt到游戏运行时
      if (w) {
        Chat.setWorldview(_buildSettingWithExtras(w));
        try {
          const flatNpcs = [];
          const flatFacs = [];
          const flatRegions = [];
          (w.regions || []).forEach(r => {
            flatRegions.push({ id: r.id, name: r.name, summary: r.summary, detail: r.detail, aliases: r.aliases });
            (r.factions || []).forEach(f => {
              flatFacs.push({ ...f, regionName: r.name, regionId: r.id });
              (f.npcs || []).forEach(n => {
                flatNpcs.push({ ...n, faction: f.name, regions: [r.id || r.name] });
              });
            });
          });
          NPC.init({ npcs: flatNpcs, factions: flatFacs, regions: flatRegions });
          await DB.put('gameState', { key: 'worldview', value: {
            prompt: w.setting || '',
            npcs: flatNpcs,
            factions: flatFacs,
            regions: flatRegions
          }});
        } catch(e) { console.error('[selectWorldview] NPC同步失败:', e); }
      }
    }
    // 刷新对话列表，切换到当前世界观下的对话
    Conversations.renderList();
    // 如果当前对话不属于新世界观，自动切换到该世界观下最后操作过的对话；没有则第一个；都没有则空态
    const curConvId = Conversations.getCurrent();
    const allConvs = await DB.get('gameState', 'conversations');
    const convList = allConvs?.value || [];
    const activeWv = currentWorldviewId || '__default_wv__';
    const curConv = convList.find(c => c.id === curConvId);
    if (!curConv || (curConv.worldviewId || '__default_wv__') !== activeWv) {
      // 优先恢复上次在该世界观下操作的对话
      let targetConv = null;
      try {
        const lastRecord = await DB.get('gameState', `lastWvConv_${activeWv}`);
        if (lastRecord?.value) {
          targetConv = convList.find(c => c.id === lastRecord.value && (c.worldviewId || '__default_wv__') === activeWv);
        }
      } catch(_) {}
      // fallback：该世界观下第一个对话
      if (!targetConv) {
        targetConv = convList.find(c => (c.worldviewId || '__default_wv__') === activeWv);
      }
      if (targetConv) {
        await Conversations.switchTo(targetConv.id);
      } else {
        // 该世界观下没有对话 → 进入空态
        await Conversations.enterEmptyState();
      }
    }
  }
  async function _updateCurrentCard() {
    const label = document.getElementById('worldview-scope-label');
    const nameEl = document.getElementById('current-wv-name');
    const iconEl = document.getElementById('current-wv-icon');
    // 侧边栏
    const sidebarName = document.getElementById('sidebar-wv-name');
    const sidebarHint = document.getElementById('sidebar-wv-hint');
    const sidebarIcon = document.getElementById('sidebar-wv-icon');
    
    if (!currentWorldviewId) {
      if (label) label.textContent = '选择世界观';
      if (nameEl) nameEl.textContent = '在此处切换世界观';
      if (iconEl) iconEl.innerHTML = '<div style="width:56px;height:56px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:32px;color:rgba(255,255,255,0.8)">✦</div>';
      if (sidebarName) sidebarName.textContent = '未选择世界观';
      if (sidebarHint) sidebarHint.textContent = '请先选择世界观';
      if (sidebarIcon) sidebarIcon.innerHTML = '<div style="width:52px;height:52px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:30px;color:rgba(255,255,255,0.8)">✦</div>';
      return;
    }
    const w = await DB.get('worldviews', currentWorldviewId);
    if (!w) {
      if (label) label.textContent = '选择世界观';
      if (nameEl) nameEl.textContent = '在此处切换世界观';
      if (iconEl) iconEl.innerHTML = '<div style="width:56px;height:56px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:32px;color:rgba(255,255,255,0.8)">✦</div>';
      if (sidebarName) sidebarName.textContent = '未选择世界观';
      if (sidebarHint) sidebarHint.textContent = '请先选择世界观';
      if (sidebarIcon) sidebarIcon.innerHTML = '<div style="width:52px;height:52px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:30px;color:rgba(255,255,255,0.8)">✦</div>';
      return;
    }
    // __default_wv__ 强制显示为「无世界观」
    if (w.id === '__default_wv__') {
      w.name = '无世界观';
      w.description = '未挂世界观的对话';
      w.iconImage = '';
    }
    // 无世界观：隐藏侧边栏 Header、显示角色筛选器
    const headerWrap = document.getElementById('sidebar-header-wrapper');
    const charFilter = document.getElementById('char-filter-wrapper');
    const isNoWv = w.id === '__default_wv__';
    if (headerWrap) headerWrap.style.display = isNoWv ? 'none' : '';
    if (charFilter) {
      charFilter.style.display = isNoWv ? 'block' : 'none';
      if (isNoWv && typeof Conversations !== 'undefined' && Conversations.refreshCharFilter) {
        Conversations.refreshCharFilter();
      }
    }
    if (label) label.textContent = w.name;
    if (nameEl) nameEl.textContent = '在此处切换世界观';
    if (iconEl) {
      if (w.iconImage) {
        iconEl.innerHTML = `<img src="${w.iconImage}" style="width:56px;height:56px;border-radius:50%;object-fit:cover">`;
      } else {
        iconEl.innerHTML = '<div style="width:56px;height:56px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:32px;color:rgba(255,255,255,0.8)">✦</div>';
      }
    }
    // 侧边栏
    if (sidebarName) sidebarName.textContent = w.name;
    if (sidebarHint) sidebarHint.textContent = '世界观已装载，请选择世界线。';
    if (sidebarIcon) {
      if (w.iconImage) {
        sidebarIcon.innerHTML = `<img src="${w.iconImage}" style="width:52px;height:52px;border-radius:50%;object-fit:cover">`;
      } else {
        sidebarIcon.innerHTML = '<div style="width:52px;height:52px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:30px;color:rgba(255,255,255,0.8)">✦</div>';
      }
    }
  }
  // ---------- 查看器（只读） ----------
  let _viewerData = null;
  
  async function openViewer(id) {
    const w = await DB.get('worldviews', id);
    if (!w) return;
    if (!await _confirmBuiltinWorldviewAccess('view', w)) return;
    closePreview();
    _viewerData = w;
    document.getElementById('panel-wv-viewer').dataset.id = id;
    document.getElementById('wv-viewer-title').textContent = w.name || '查看世界观';
    _renderViewerBasic(w);
    _renderViewerRegions(w);
    _renderViewerNPCFilters(w);
    filterViewerNPCs();
    _renderViewerSpecial(w);
    switchViewerTab('v-basic');
    UI.showPanel('wv-viewer', 'forward');
  }
  
  function switchViewerTab(tab) {
    document.querySelectorAll('.wv-viewer-tab-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.wv-viewer-tab-btn[data-tab="${tab}"]`);
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.wv-viewer-tab-content').forEach(c => c.classList.add('hidden'));
    const panel = document.getElementById(`wv-viewer-tab-${tab}`);
    if (panel) panel.classList.remove('hidden');
  }
  
  function _renderViewerBasic(w) {
    const el = document.getElementById('wv-viewer-basic');
    if (!el) return;
    let html = '';
    html += `<div style="margin-bottom:16px">
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px">世界观名称</div>
      <div style="font-size:18px;font-weight:bold;color:var(--accent)">${Utils.escapeHtml(w.name || '未命名')}</div>
    </div>`;
    if (w.description) {
      html += `<div style="margin-bottom:16px">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px">描述</div>
        <div class="md-content" style="font-size:14px;line-height:1.8;color:var(--text)">${Markdown.render(w.description)}</div>
      </div>`;
    }
    if (w.setting) {
      html += `<div style="margin-bottom:16px">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px">世界观设定</div>
        <div class="md-content" style="font-size:13px;line-height:1.8;color:var(--text);background:var(--bg-tertiary);padding:12px;border-radius:8px;border:1px solid var(--border)">${Markdown.render(w.setting)}</div>
      </div>`;
    }
    const _cur = w.currency || {};
    if (_cur.name) {
      html += `<div style="margin-bottom:16px">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px">💰 通用货币</div>
        <div style="font-size:14px;font-weight:bold;color:var(--accent);margin-bottom:4px">${Utils.escapeHtml(_cur.name)}</div>
        ${_cur.desc ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary)">${Markdown.render(_cur.desc)}</div>` : ''}
      </div>`;
    }
    const _pa = w.phoneApps || {};
    const _paTk = _pa.takeout || {}; const _paSh = _pa.shop || {}; const _paFm = _pa.forum || {};
    if (_paTk.name || _paSh.name) {
      html += `<div style="margin-bottom:16px">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px">🛒 手机商城</div>
        ${_paTk.name ? `<div style="background:var(--bg-tertiary);padding:10px;border-radius:8px;margin-bottom:6px">
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px">短时效</div>
          <div style="font-size:14px;font-weight:bold;color:var(--accent);margin-bottom:4px">${Utils.escapeHtml(_paTk.name)}</div>
          ${_paTk.desc ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary)">${Markdown.render(_paTk.desc)}</div>` : ''}
        </div>` : ''}
        ${_paSh.name ? `<div style="background:var(--bg-tertiary);padding:10px;border-radius:8px">
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px">长时效</div>
          <div style="font-size:14px;font-weight:bold;color:var(--accent);margin-bottom:4px">${Utils.escapeHtml(_paSh.name)}</div>
          ${_paSh.desc ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary)">${Markdown.render(_paSh.desc)}</div>` : ''}
        </div>` : ''}
      </div>`;
    }
    if (_paFm.name) {
      html += `<div style="margin-bottom:16px">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px">📢 信息载体</div>
        <div style="background:var(--bg-tertiary);padding:10px;border-radius:8px">
          <div style="font-size:14px;font-weight:bold;color:var(--accent);margin-bottom:4px">${Utils.escapeHtml(_paFm.name)}</div>
          ${_paFm.desc ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary)">${Markdown.render(_paFm.desc)}</div>` : ''}
        </div>
      </div>`;
    }
    if (!w.setting && !w.description) {
      html += '<div style="text-align:center;color:var(--text-secondary);padding:24px;font-size:13px">暂无设定内容</div>';
    }
    el.innerHTML = html;
  }
  
  function _renderViewerRegions(w) {
    const el = document.getElementById('wv-viewer-regions');
    if (!el) return;
    const regions = w.regions || [];
    if (regions.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:24px;font-size:13px">暂无地区数据</div>';
      return;
    }
    let html = '';
    regions.forEach(reg => {
      html += `<div class="card" style="padding:12px;margin-bottom:12px;border:1px solid var(--border);border-radius:8px">
        <div style="font-size:16px;font-weight:bold;color:var(--accent);margin-bottom:4px">${Utils.escapeHtml(reg.name || '未命名')}</div>
        ${reg.summary ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary);margin-bottom:8px">${Markdown.render(reg.summary)}</div>` : ''}
        ${reg.detail ? `<div class="md-content" style="font-size:13px;line-height:1.8;color:var(--text);background:var(--bg-tertiary);padding:10px;border-radius:6px;margin-bottom:8px">${Markdown.render(reg.detail)}</div>` : ''}`;
      
      const factions = reg.factions || [];
      if (factions.length > 0) {
        html += '<div style="margin-left:8px;border-left:2px solid var(--border);padding-left:12px;margin-top:8px">';
        factions.forEach(fac => {
          html += `<div style="margin-bottom:8px">
            <div style="font-size:14px;font-weight:bold;color:var(--text);margin-bottom:2px">${Utils.escapeHtml(fac.name || '未命名')}</div>
            ${fac.summary ? `<div class="md-content" style="font-size:11px;line-height:1.8;color:var(--text-secondary);margin-bottom:4px">${Markdown.render(fac.summary)}</div>` : ''}
            ${fac.detail ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text);background:var(--bg-secondary);padding:8px;border-radius:4px">${Markdown.render(fac.detail)}</div>` : ''}
          </div>`;
        });
        html += '</div>';
      }
      html += '</div>';
    });
    el.innerHTML = html;
  }
  
  function _renderViewerNPCFilters(w) {
    const regionInput = document.getElementById('wv-viewer-npc-region');
    const factionInput = document.getElementById('wv-viewer-npc-faction');
    const regionDropdown = document.getElementById('wv-viewer-npc-region-dropdown');
    const factionDropdown = document.getElementById('wv-viewer-npc-faction-dropdown');
    const regionLabel = document.getElementById('wv-viewer-npc-region-label');
    const factionLabel = document.getElementById('wv-viewer-npc-faction-label');
    if (!regionInput || !factionInput || !regionDropdown || !factionDropdown || !regionLabel || !factionLabel) return;
    
    const regions = w.regions || [];
    const hasGlobalNpcs = (w.globalNpcs || []).length > 0;
    const factionNames = [];
    let rHtml = `<div class="custom-dropdown-item active" onclick="Worldview.selectViewerNPCFilter('region','','全部地区')">全部地区</div>`;
    let fHtml = `<div class="custom-dropdown-item active" onclick="Worldview.selectViewerNPCFilter('faction','','全部势力')">全部势力</div>`;
    if (hasGlobalNpcs) {
      rHtml += `<div class="custom-dropdown-item" onclick="Worldview.selectViewerNPCFilter('region','__global__','常驻角色')">常驻角色</div>`;
    }
    regions.forEach(reg => {
      if (reg.name) rHtml += `<div class="custom-dropdown-item" onclick="Worldview.selectViewerNPCFilter('region','${Utils.escapeHtml(reg.name)}','${Utils.escapeHtml(reg.name)}')">${Utils.escapeHtml(reg.name)}</div>`;
      (reg.factions || []).forEach(fac => {
        if (fac.name && !factionNames.includes(fac.name)) {
          factionNames.push(fac.name);
          fHtml += `<div class="custom-dropdown-item" onclick="Worldview.selectViewerNPCFilter('faction','${Utils.escapeHtml(fac.name)}','${Utils.escapeHtml(fac.name)}')">${Utils.escapeHtml(fac.name)}</div>`;
        }
      });
    });
    regionDropdown.innerHTML = rHtml;
    factionDropdown.innerHTML = fHtml;
    regionLabel.textContent = regionInput.value || '全部地区';
    factionLabel.textContent = factionInput.value || '全部势力';
  }
  
  function toggleViewerNPCDropdown(type) {
    const regionDropdown = document.getElementById('wv-viewer-npc-region-dropdown');
    const factionDropdown = document.getElementById('wv-viewer-npc-faction-dropdown');
    if (!regionDropdown || !factionDropdown) return;

    function closeDropdown(el) {
      if (!el || el.classList.contains('hidden')) return;
      el.classList.add('closing');
      setTimeout(() => {
        el.classList.add('hidden');
        el.classList.remove('closing');
      }, 120);
    }

    function openDropdown(el) {
      if (!el) return;
      el.classList.remove('closing');
      el.classList.remove('hidden');
    }

    if (type === 'region') {
      if (regionDropdown.classList.contains('hidden')) {
        closeDropdown(factionDropdown);
        openDropdown(regionDropdown);
      } else {
        closeDropdown(regionDropdown);
      }
    } else {
      if (factionDropdown.classList.contains('hidden')) {
        closeDropdown(regionDropdown);
        openDropdown(factionDropdown);
      } else {
        closeDropdown(factionDropdown);
      }
    }
  }

  function selectViewerNPCFilter(type, value, label) {
    const input = document.getElementById(type === 'region' ? 'wv-viewer-npc-region' : 'wv-viewer-npc-faction');
    const labelEl = document.getElementById(type === 'region' ? 'wv-viewer-npc-region-label' : 'wv-viewer-npc-faction-label');
    const dropdown = document.getElementById(type === 'region' ? 'wv-viewer-npc-region-dropdown' : 'wv-viewer-npc-faction-dropdown');
    if (!input || !labelEl || !dropdown) return;
    input.value = value || '';
    labelEl.textContent = label;
    dropdown.classList.add('closing');
    setTimeout(() => {
      dropdown.classList.add('hidden');
      dropdown.classList.remove('closing');
    }, 120);
    filterViewerNPCs();
  }
  
  function filterViewerNPCs() {
    if (!_viewerData) return;
    const regionFilter = document.getElementById('wv-viewer-npc-region')?.value || '';
    const factionFilter = document.getElementById('wv-viewer-npc-faction')?.value || '';
    const container = document.getElementById('wv-viewer-npcs');
    if (!container) return;
    
    // 收集所有角色（带归属信息），包含常驻角色
const allNPCs = [];
    const includeGlobal = !regionFilter || regionFilter === '__global__';
    if (includeGlobal && !factionFilter) {
      (_viewerData.globalNpcs || []).forEach(npc => {
        allNPCs.push({ ...npc, regionName: '常驻角色', factionName: '—', _isGlobalNpc: true });
      });
    }
    if (regionFilter !== '__global__') {
      (_viewerData.regions || []).forEach(reg => {
        if (regionFilter && reg.name !== regionFilter) return;
        (reg.factions || []).forEach(fac => {
          if (factionFilter && fac.name !== factionFilter) return;
          (fac.npcs || []).forEach(npc => {
            allNPCs.push({ ...npc, regionName: reg.name, factionName: fac.name });
          });
        });
      });
    }
    
    if (allNPCs.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:24px;font-size:13px">无匹配角色</div>';
      return;
    }
    
    let html = '';
    allNPCs.forEach(npc => {
      html += `<div class="card" style="padding:12px;margin-bottom:8px;border:1px solid var(--border);border-radius:8px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div style="font-size:15px;font-weight:bold;color:var(--accent)">${Utils.escapeHtml(npc.name || '未命名')}${npc.aliases ? ` <span style="font-size:12px;font-weight:normal;color:var(--text-secondary)">（${Utils.escapeHtml(npc.aliases)}）</span>` : ''}</div>
          <div style="font-size:10px;color:var(--text-secondary);text-align:right;flex-shrink:0;margin-left:8px">${Utils.escapeHtml(npc.regionName || '')} · ${Utils.escapeHtml(npc.factionName || '')}</div>
        </div>
        ${npc.summary ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary);margin-bottom:6px">${Markdown.render(npc.summary)}</div>` : ''}
        ${npc.detail ? `<div class="md-content" style="font-size:13px;line-height:1.8;color:var(--text);background:var(--bg-tertiary);padding:10px;border-radius:6px;margin-bottom:6px">${Markdown.render(npc.detail)}</div>` : ''}
        
      </div>`;
    });
    container.innerHTML = html;
  }
  
  function _renderViewerSpecial(w) {
    const el = document.getElementById('wv-viewer-special');
    if (!el) return;
    let html = '';
    
    // 节日
    const festivals = w.festivals || [];
    html += '<div style="font-size:15px;font-weight:bold;color:var(--text);margin-bottom:8px;display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M3 10h18"/><path d="M8 2v4"/><path d="M17 14h-6"/><path d="M13 18H7"/><path d="M7 14h.01"/><path d="M17 18h.01"/></svg> 节日设定</div>';
    if (festivals.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px;margin-bottom:16px">暂无节日</div>';
    } else {
      festivals.forEach(f => {
        html += `<div class="card" style="padding:10px;margin-bottom:6px;border:1px solid var(--border);border-radius:6px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div style="font-size:14px;font-weight:bold;color:var(--accent)">${Utils.escapeHtml(f.name || '未命名')}</div>
            <div style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(f.date || '')} ${f.yearly ? '(每年)' : ''}</div>
          </div>
          ${f.content ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text)">${Markdown.render(f.content)}</div>` : ''}
        </div>`;
      });
      html += '<div style="margin-bottom:16px"></div>';
    }
    
    // 常驻条目（v581：从 knowledges 中筛 keywordTrigger=false）
    _migrateToKnowledges(w);
    const customs = (w.knowledges || []).filter(k => !k.keywordTrigger);
    html += '<div style="font-size:15px;font-weight:bold;color:var(--text);margin-bottom:8px;display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg> 常驻条目</div>';
    if (customs.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px;margin-bottom:16px">暂无常驻条目</div>';
    } else {
      customs.forEach(c => {
        html += `<div class="card" style="padding:10px;margin-bottom:6px;border:1px solid var(--border);border-radius:6px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div style="font-size:14px;font-weight:bold;color:var(--text)">${Utils.escapeHtml(c.name || '未命名')}</div>
            <div style="font-size:11px;padding:2px 8px;border-radius:10px;${c.enabled ? 'background:var(--accent);color:#111' : 'background:var(--bg-tertiary);color:var(--text-secondary)'}">${c.enabled ? '已启用' : '未启用'}</div>
          </div>
          ${c.content ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text)">${Markdown.render(c.content)}</div>` : ''}
        </div>`;
      });
    }

    // 动态条目（v581：从 knowledges 中筛 keywordTrigger=true）
    const knowledges = (w.knowledges || []).filter(k => !!k.keywordTrigger);
    html += '<div style="font-size:15px;font-weight:bold;color:var(--text);margin:18px 0 8px;display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> 动态条目</div>';
    if (knowledges.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px">暂无动态条目</div>';
    } else {
      knowledges.forEach(k => {
        const keys = (k.keys || '').trim();
        const keyTags = keys
          ? keys.split(/[,，\s]+/).filter(Boolean).map(t => `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${Utils.escapeHtml(t)}</span>`).join('')
          : '<span style="font-size:11px;color:var(--text-secondary)">无关键词</span>';
        html += `<div class="card" style="padding:10px;margin-bottom:6px;border:1px solid var(--border);border-radius:6px">
          <div style="font-size:14px;font-weight:bold;color:var(--text);margin-bottom:4px">${Utils.escapeHtml(k.name || '未命名')}</div>
          <div style="margin-bottom:6px">${keyTags}</div>
          ${k.content ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text)">${Markdown.render(k.content)}</div>` : ''}
        </div>`;
      });
    }

    // 事件条目
    const events = w.events || [];
    html += '<div style="font-size:15px;font-weight:bold;color:var(--text);margin:18px 0 8px;display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg> 事件</div>';
    if (events.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px">暂无事件</div>';
    } else {
      events.forEach(ev => {
        const triggerKeys = (ev.keys || '').trim();
        const endKeys = (ev.endKeys || '').trim();
        const triggerTags = triggerKeys
          ? triggerKeys.split(/[,，\s]+/).filter(Boolean).map(t => `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${Utils.escapeHtml(t)}</span>`).join('')
          : '<span style="font-size:11px;color:var(--text-secondary)">无触发词</span>';
        const endTags = endKeys
          ? endKeys.split(/[,，\s]+/).filter(Boolean).map(t => `<span style="display:inline-block;font-size:11px;background:color-mix(in srgb, var(--accent) 15%, var(--bg-secondary));color:var(--accent);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${Utils.escapeHtml(t)}</span>`).join('')
          : '<span style="font-size:11px;color:var(--text-secondary)">无结束词</span>';
        html += `<div class="card" style="padding:10px;margin-bottom:6px;border:1px solid var(--border);border-radius:6px">
          <div style="font-size:14px;font-weight:bold;color:var(--text);margin-bottom:6px">${Utils.escapeHtml(ev.name || '未命名')}</div>
          <div style="margin-bottom:4px"><span style="font-size:11px;color:var(--text-secondary);margin-right:4px">触发：</span>${triggerTags}</div>
          <div style="margin-bottom:6px"><span style="font-size:11px;color:var(--text-secondary);margin-right:4px">结束：</span>${endTags}</div>
          ${ev.content ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text)">${Markdown.render(ev.content)}</div>` : ''}
        </div>`;
      });
    }
    el.innerHTML = html;
  }
  function _populateThemeSelect(currentThemeName) {
    const hiddenInput = document.getElementById('wv-theme-binding');
    const label = document.getElementById('wv-theme-label');
    const dropdown = document.getElementById('wv-theme-dropdown');
    if (!hiddenInput || !dropdown) return;

    let html = '<div class="custom-dropdown-item" onclick="Worldview.selectTheme(\'\')">不绑定主题</div>';
    
    // 内置预设
    const builtinNames = Theme.getPresetNames();
    builtinNames.forEach(n => {
      const value = `builtin:${n}`;
      const active = currentThemeName === value ? ' active' : '';
      html += `<div class="custom-dropdown-item${active}" onclick="Worldview.selectTheme('${value}')">${Utils.escapeHtml(n)}</div>`;
    });
    
    // 自定义主题
    try {
      const customMap = JSON.parse(localStorage.getItem('themeCustomPresets') || '{}');
      const customNames = Object.keys(customMap);
      if (customNames.length) {
        customNames.forEach(n => {
          const value = `custom:${n}`;
          const active = currentThemeName === value ? ' active' : '';
          html += `<div class="custom-dropdown-item${active}" onclick="Worldview.selectTheme('${Utils.escapeHtml(value)}')">${Utils.escapeHtml(n)}</div>`;
        });
      }
    } catch(e) {}
    
    dropdown.innerHTML = html;
    
    // 设置当前显示文本
    hiddenInput.value = currentThemeName || '';
    if (!currentThemeName) {
      label.textContent = '不绑定主题';
    } else if (currentThemeName.startsWith('builtin:')) {
      label.textContent = currentThemeName.slice(8);
    } else if (currentThemeName.startsWith('custom:')) {
      label.textContent = currentThemeName.slice(7);
    }
  }

  function toggleThemeDropdown() {
    const dropdown = document.getElementById('wv-theme-dropdown');
    if (!dropdown) return;
    const isHidden = dropdown.classList.contains('hidden');
    
    // 关闭其他下拉框
    document.querySelectorAll('.custom-dropdown').forEach(d => {
      if (d !== dropdown) d.classList.add('hidden');
    });
    
    if (isHidden) {
      dropdown.classList.remove('hidden');
      setTimeout(() => {
        document.addEventListener('click', function _close(e) {
          if (!dropdown.contains(e.target) && !e.target.closest('.custom-select-btn')) {
            dropdown.classList.add('hidden');
            document.removeEventListener('click', _close);
          }
        });
      }, 0);
    } else {
      dropdown.classList.add('hidden');
    }
  }

  function selectTheme(value) {
    const hiddenInput = document.getElementById('wv-theme-binding');
    const label = document.getElementById('wv-theme-label');
    const dropdown = document.getElementById('wv-theme-dropdown');
    
    if (hiddenInput) hiddenInput.value = value;
    
    if (!value) {
      label.textContent = '不绑定主题';
    } else if (value.startsWith('builtin:')) {
      label.textContent = value.slice(8);
    } else if (value.startsWith('custom:')) {
      label.textContent = value.slice(7);
    }
    
    if (dropdown) dropdown.classList.add('hidden');
  }

function _applyBoundTheme(themeName) {
  if (!themeName) return;
  if (themeName.startsWith('builtin:')) {
    const name = themeName.slice(8);
    Theme.applyPreset(name);
  } else if (themeName.startsWith('custom:')) {
    const name = themeName.slice(7);
    Theme.activateCustomPreset(name, true);
  }
}

// ---------- 无世界观·默认主题选择弹窗 ----------
async function openDefaultThemePicker() {
  const modal = document.getElementById('default-theme-modal');
  const list = document.getElementById('default-theme-list');
  if (!modal || !list) return;

  // 读出当前 __default_wv__ 的 themeName
  let current = '';
  try {
    const wv = await DB.get('worldviews', '__default_wv__');
    current = wv?.themeName || '';
  } catch(_) {}

  const _row = (label, value) => {
    const active = current === value;
    const check = active
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent);flex-shrink:0"><path d="M20 6 9 17l-5-5"/></svg>'
      : '<span style="width:14px;flex-shrink:0"></span>';
    const safe = Utils.escapeHtml(value);
    return `<div onclick="Worldview.pickDefaultTheme('${safe}')" class="ctx-item" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--text)${active ? ';background:var(--bg-tertiary)' : ''}">${check}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(label)}</span></div>`;
  };

  let html = _row('不绑定主题', '');
  // 内置预设
  try {
    const builtinNames = Theme.getPresetNames();
    if (builtinNames.length) {
      html += '<div style="height:1px;background:var(--border);margin:4px 0"></div>';
      builtinNames.forEach(n => { html += _row(n, `builtin:${n}`); });
    }
  } catch(_) {}
  // 自定义
  try {
    const customMap = JSON.parse(localStorage.getItem('themeCustomPresets') || '{}');
    const customNames = Object.keys(customMap);
    if (customNames.length) {
      html += '<div style="height:1px;background:var(--border);margin:4px 0"></div>';
      customNames.forEach(n => { html += _row(n, `custom:${n}`); });
    }
  } catch(_) {}

  list.innerHTML = html;
  modal.classList.remove('hidden');
}

function closeDefaultThemePicker() {
  const modal = document.getElementById('default-theme-modal');
  if (modal) modal.classList.add('hidden');
}

async function pickDefaultTheme(value) {
  try {
    let wv = await DB.get('worldviews', '__default_wv__');
    if (!wv) {
      wv = { id: '__default_wv__', name: '无世界观', description: '未挂世界观的对话', icon: '∅', iconImage: '' };
    }
    wv.themeName = value || '';
    await DB.put('worldviews', wv);

    // 如果当前正处于无世界观下，立刻应用
    const cur = (typeof getCurrentId === 'function') ? getCurrentId() : null;
    if (!cur || cur === '__default_wv__') {
      if (value) {
        _applyBoundTheme(value);
      }
      // 不绑定时不主动切回什么——保留用户当前临时改的主题
    }
    UI.showToast(value ? '主题已绑定到无世界观' : '已取消绑定', 1800);
  } catch(e) {
    console.warn('[pickDefaultTheme]', e);
    UI.showToast('保存失败', 1800);
  }
  closeDefaultThemePicker();
}

// 初始化时恢复当前世界观
  async function _restoreCurrentWorldview() {
    const data = await DB.get('gameState', 'currentWorldviewId');
    if (data?.value) {
      currentWorldviewId = data.value;
    } else {
      const list = await getWorldviewList();
      const builtin = list.find(w => w.id === 'wv_tianshucheng');
      currentWorldviewId = builtin ? builtin.id : '__default_wv__';
      await DB.put('gameState', { key: 'currentWorldviewId', value: currentWorldviewId });
    }
    await _updateCurrentCard();
    // 同步NPC和世界观prompt——无论是什么ID都尝试
    if (currentWorldviewId && currentWorldviewId !== '__default_wv__') {
      const w = await DB.get('worldviews', currentWorldviewId);
      if (w) {
        if (w.themeName) {
          try { _applyBoundTheme(w.themeName); } catch(e) { console.warn('[Worldview.restore] 主题绑定失败', e); }
        }
        const settingText = _buildSettingWithExtras(w);
        // 先设世界观prompt，这是最重要的，不能被后面的NPC.init异常拖累
        Chat.setWorldview(settingText);
        console.log('[Worldview.restore] 已设worldviewPrompt, 长度:', settingText.length);
        
        // NPC初始化单独保护
        try {
          const flatNpcs = [];
          const flatFacs = [];
          const flatRegions = [];
          (w.regions || []).forEach(r => {
            flatRegions.push({ id: r.id, name: r.name, summary: r.summary, detail: r.detail, aliases: r.aliases });
            (r.factions || []).forEach(f => {
              flatFacs.push({ ...f, regionName: r.name, regionId: r.id });
              (f.npcs || []).forEach(n => {
                flatNpcs.push({ ...n, faction: f.name, regions: [r.id || r.name] });
              });
            });
          });
          NPC.init({ npcs: flatNpcs, factions: flatFacs, regions: flatRegions });
          console.log('[Worldview.restore] NPC初始化完成, npcs:', flatNpcs.length, 'facs:', flatFacs.length, 'regions:', flatRegions.length);
          
          await DB.put('gameState', { key: 'worldview', value: {
            prompt: settingText,
            npcs: flatNpcs,
            factions: flatFacs,
            regions: flatRegions
          }});
        } catch(e) {
          console.error('[Worldview.restore] NPC初始化失败:', e);
        }
      } else {
        console.warn('[Worldview.restore] DB中未找到世界观:', currentWorldviewId);
      }
    } else {
      Chat.setWorldview('');
      NPC.init({ npcs: [], factions: [], regions: [] });
      console.log('[Worldview.restore] 使用默认世界观（空）');
    }
  }
  
    // 导出单个世界观
  async function exportCurrent() {
    if (!editingWorldviewId) { UI.showToast('没有正在编辑的世界观'); return; }
    const w = await DB.get('worldviews', editingWorldviewId);
    if (!w) { UI.showToast('世界观数据不存在'); return; }
    const exportData = { worldviews: [w] };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (w.name || '世界观') + '.json';
    a.click();
    URL.revokeObjectURL(url);
    UI.showToast('已导出「' + w.name + '」');
  }

  // 导入单个世界观
  async function importSingle() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const wvArr = data.worldviews;
        if (!wvArr || !Array.isArray(wvArr) || wvArr.length === 0) {
          UI.showToast('文件格式不正确，需包含 worldviews 数组', 3000);
          return;
        }
        let count = 0;
        const list = await getWorldviewList();
        for (const w of wvArr) {
          if (!w.id) w.id = 'wv_' + Utils.uuid().slice(0, 8);
          const existing = list.find(e => e.id === w.id);
          if (existing) {
            if (!await UI.showConfirm('覆盖', `已存在「${existing.name}」，确定覆盖？`)) continue;
            existing.name = w.name;
            existing.description = w.description;
            existing.icon = w.icon || 'world';
            existing.iconImage = w.iconImage || '';
          } else {
            list.push({ id: w.id, name: w.name || '未命名', description: w.description || '', icon: w.icon || 'world', iconImage: w.iconImage || '' });
          }
          await DB.put('worldviews', w);
          count++;
        }
        await saveWorldviewList(list);
        await load();
        UI.showToast(`已导入 ${count} 个世界观`);
      } catch(e) {
        UI.showToast('导入失败：' + e.message, 3000);
      }
    };
    input.click();
  }

  // 内置世界观自动加载（增量 + 版本更新）
  async function _loadBuiltinWorldviews() {
    try {
      const builtinArr = window.__BUILTIN_WORLDVIEWS__;
      if (!builtinArr || !Array.isArray(builtinArr) || builtinArr.length === 0) return;

      // 读已加载过的内置版本记录 { id: version }
      const loaded = await DB.get('gameState', 'builtinLoaded');
      const loadedMap = loaded?.value || {};

      let list = await getWorldviewList();
      let newCount = 0;
      let updateCount = 0;

      for (const w of builtinArr) {
        if (!w.id) w.id = 'wv_' + Utils.uuid().slice(0, 8);
        const ver = w._builtinVersion || 1;
        const knownVer = loadedMap[w.id] || 0;

        if (ver <= knownVer) continue; // 已加载过且版本没变

        const existing = list.find(e => e.id === w.id);
        if (existing) {
          // 版本更高，覆盖更新
          existing.name = w.name || existing.name;
          existing.description = w.description || existing.description;
          existing.icon = w.icon || existing.icon;
          existing.iconImage = w.iconImage || existing.iconImage;
          _migrateToKnowledges(w); // v581
          await DB.put('worldviews', w);
          loadedMap[w.id] = ver;
          updateCount++;
        } else {
          // 全新的内置世界观
          list.push({ id: w.id, name: w.name || '未命名', description: w.description || '', icon: w.icon || 'world', iconImage: w.iconImage || '' });
          _migrateToKnowledges(w); // v581
          await DB.put('worldviews', w);
          loadedMap[w.id] = ver;
          newCount++;
        }
      }

      if (newCount > 0 || updateCount > 0) {
        await saveWorldviewList(list);
        if (newCount) console.log('[Worldview] 新增内置世界观：' + newCount + '个');
        if (updateCount) console.log('[Worldview] 更新内置世界观：' + updateCount + '个');
      }
      await DB.put('gameState', { key: 'builtinLoaded', value: loadedMap });
    } catch(e) {
      console.warn('[Worldview] 加载内置世界观失败:', e);
    }
  }

  /**
   * 一次性 migration：天枢城内置 NPC 的 name/aliases 当年填反了，做一次精确交换
   * 只动 name/aliases 两个字段，其它内容（detail/summary/regions/factions 等）一概不动
   * 跑完打标记，下次不再跑
   */
  async function _migrateTianshuchengNpcNames() {
    try {
      const FLAG = 'migrate_tsc_npc_names_v1';
      const flag = await DB.get('gameState', FLAG);
      if (flag && flag.value) return;

      const wv = await DB.get('worldviews', 'wv_tianshucheng');
      if (!wv) {
        // 还没有这个世界观，直接打标记跳过（新用户的 builtin 已是修好的）
        await DB.put('gameState', { key: FLAG, value: 1 });
        return;
      }

      const SKIP = new Set(['神钥', '易昂']);
      let swapped = 0;
      (wv.regions || []).forEach(r =>
        (r.factions || []).forEach(f =>
          (f.npcs || []).forEach(n => {
            if (!n || SKIP.has(n.name)) return;
            if (!n.aliases) return;
            const old = n.name;
            n.name = n.aliases;
            n.aliases = old;
            swapped++;
          })
        )
      );

      if (swapped > 0) {
        await DB.put('worldviews', wv);
        console.log('[Migration] 天枢城 NPC name/aliases 交换完成：' + swapped + '个');
      }
      await DB.put('gameState', { key: FLAG, value: 1 });
    } catch(e) {
      console.warn('[Migration] 天枢城NPC名称交换失败:', e);
    }
  }

  return {
    init: load,
    load,
    createWorldview,
    openEdit,
    openPreview,
    closePreview,
    save,
    deleteCurrentWorldview,
    toggleManageMode,
    deleteSelectedWorldviews,
    exportSelectedWorldviews,
    toggleSelectAll,
    toggleMenu,
    toggleSortMode, exitSortMode, saveSortOrder,
    renderWorldviewList,
    switchEditTab,
switchExtSubtab, filterExtended, clearExtendedSearch, toggleExtAddMenu, addFromMenu, toggleExtIoMenu, exportExtended, importExtended,
    toggleCustomEnabled, toggleKnowledgeEnabled, toggleFestivalEnabled,
    addEvent, editEvent, saveEventFromModal, deleteEventFromModal, closeEventModal,
    _onCardClick,
    handleIconImageUpload,
    clearIconImage,
    addRegion, addFaction, addNPC,
    openRegionEdit, saveRegion, deleteRegion,
    openFactionEdit, saveFaction, deleteFaction,
    openNPCEdit, saveNPC, deleteNPC,
    addGlobalNpc, editGlobalNpc, backFromNpcEdit,
    _getEditingWV, _saveEditingWV, _renderGlobalNpcs: _renderGlobalNpcs, _renderRegions: _renderRegions, _renderFactionCards: _renderFactionCards, _renderNPCCards: _renderNPCCards,
    addFestival, editFestival, saveFestivalFromModal, deleteFestivalFromModal, closeFestivalModal,
  addCustom, editCustom, saveCustomFromModal, deleteCustomFromModal, closeCustomModal,
addKnowledge, editKnowledge, saveKnowledgeFromModal, deleteKnowledgeFromModal, closeKnowledgeModal,
toggleCustPositionDropdown, selectCustPosition, toggleKnowPositionDropdown, selectKnowPosition,
    getCurrent, setCurrentId, getCurrentId,
    openViewer, switchViewerTab, filterViewerNPCs,
    toggleViewerNPCDropdown, selectViewerNPCFilter,
    toggleScopeDropdown,
    selectWorldview,
    toggleThemeDropdown, selectTheme,
    openDefaultThemePicker, closeDefaultThemePicker, pickDefaultTheme,
    restoreCurrentWorldview: _restoreCurrentWorldview,
    exportCurrent, importSingle, restoreBuiltinWorldview: _restoreBuiltinWorldview, toggleEditMoreMenu: _toggleEditMoreMenu, closeEditMoreMenu: _closeEditMoreMenu, loadBuiltinWorldviews: _loadBuiltinWorldviews, migrateTianshuchengNpcNames: _migrateTianshuchengNpcNames,
    ensureHiddenWvForCard, deleteHiddenWvForCard, isHiddenWv,
    getEditReturnTo, clearEditReturnTo,
    switchWorldTab(tab) {
      const wvBtn = document.getElementById('world-tab-wv-btn');
      const charBtn = document.getElementById('world-tab-char-btn');
      const wvPane = document.getElementById('world-tab-wv');
      const charPane = document.getElementById('world-tab-char');
      if (!wvBtn || !charBtn || !wvPane || !charPane) return;
      const _play = (el, dir) => {
        el.classList.remove('tab-pane-enter-left', 'tab-pane-enter-right');
        // 强制回流，确保动画重放
        void el.offsetWidth;
        el.classList.add(dir === 'left' ? 'tab-pane-enter-left' : 'tab-pane-enter-right');
      };
      if (tab === 'char') {
        wvBtn.style.borderBottomColor = 'transparent';
        wvBtn.style.color = 'var(--text-secondary)';
        wvBtn.style.fontWeight = '400';
        charBtn.style.borderBottomColor = 'var(--accent)';
        charBtn.style.color = 'var(--accent)';
        charBtn.style.fontWeight = '600';
        wvPane.style.display = 'none';
        charPane.style.display = '';
        _play(charPane, 'right');
        if (typeof SingleCard !== 'undefined') SingleCard.renderList();
      } else {
        wvBtn.style.borderBottomColor = 'var(--accent)';
        wvBtn.style.color = 'var(--accent)';
        wvBtn.style.fontWeight = '600';
        charBtn.style.borderBottomColor = 'transparent';
        charBtn.style.color = 'var(--text-secondary)';
        charBtn.style.fontWeight = '400';
        wvPane.style.display = '';
        charPane.style.display = 'none';
        _play(wvPane, 'left');
      }
    }
  };
  })();
