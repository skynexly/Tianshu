/**
 * 世界观管理 — 多世界观 + 三级嵌套（地区/势力/NPC）+ 节日 + 自定义设定
 */
const Worldview = (() => {
  let currentWorldviewId = null;
  let editingWorldviewId = null;
  let _editingCalRules = null; // 当前编辑世界观的历法缓存
  
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
      currencies: [],        // 通用货币列表：[{id,name,desc}]，仅发AI，前端仍显示 ¥；可多个
      phoneApps: {                       // 手机 App 自定义（留空用默认）
        takeout: { name: '', desc: '' }, // 短时效商城（默认饿了咪）
        shop:    { name: '', desc: '' }, // 长时效商城（默认桃宝）
        forum:   { name: '', desc: '' }, // 信息载体（默认论坛）
      },
      statusBarSkin: 'terminal', // 状态栏风格：terminal=终端风格，neumorph=拟态风格
      gameplay: { globalAttrs: [], characterAttrs: [] }, // 玩法配置：属性定义/触发器/状态栏布局
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

  // 读取世界观货币列表，兼容旧的单货币结构 currency:{name,desc}
  function _getCurrencies(w) {
    if (!w) return [];
    let list = Array.isArray(w.currencies) ? w.currencies.slice() : [];
    // 旧数据迁移：currency 单对象 -> currencies 数组
    if (!list.length && w.currency && (w.currency.name || '').trim()) {
      list = [{ id: 'cur_' + Utils.uuid().slice(0, 8), name: w.currency.name || '', desc: w.currency.desc || '' }];
    }
    return list.filter(c => c && (c.name || '').trim());
  }

  // 构建下发给 Chat 的 worldview prompt：setting + 附加字段（货币等）
  function _buildSettingWithExtras(w) {
    if (!w) return '';
    let s = w.setting || '';
    const curs = _getCurrencies(w);
    if (curs.length) {
      const extra = [];
      extra.push('【通用货币】');
      if (curs.length === 1) {
        extra.push(`货币名称：${curs[0].name.trim()}`);
        if ((curs[0].desc || '').trim()) extra.push(`货币说明：${curs[0].desc.trim()}`);
      } else {
        extra.push(`本世界存在以下 ${curs.length} 种货币：`);
        curs.forEach((c, i) => {
          extra.push(`${i + 1}. ${c.name.trim()}${(c.desc || '').trim() ? `：${c.desc.trim()}` : ''}`);
        });
      }
      extra.push('（商品/服务价格生成时，price 字段只填纯数字，数值应符合相应货币的合理范围与购买力；前端统一以 ¥ 符号展示占位，货币名称仅用于你内部生成合理价格时参考。）');
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
    return { id: 'fest_' + Utils.uuid().slice(0,8), name: '', date: '', yearly: true, content: '', keys: '', enabled: true };
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
    // v632：世界书只剩 special 一个 tab，按钮本身也藏（没必要让用户看到"扩展"二字）
    const specialBtn = document.querySelector('.wv-edit-tab-btn[data-tab="special"]');
    if (specialBtn) specialBtn.style.display = isHidden ? 'none' : '';
// 心动模拟世界观：禁止编辑玩法页（任务/属性/状态栏由内置机制管理）
    // v632：世界书也不该有玩法 tab（状态栏/手机/属性是世界观级，不能叠加）
    const gameplayBtn = document.querySelector('.wv-edit-tab-btn[data-tab="gameplay"]');
    if (gameplayBtn) {
      const isHS = editingWorldviewId === 'wv_heartsim';
      gameplayBtn.style.display = (isHidden || isHS) ? 'none' : '';
    }
    // ⋯ 菜单：隐藏世界观时不允许删除整个世界观、不允许导出（整包）；只保留"扩展设定导入导出"
    const exportBtn = document.querySelector('#worldview-edit-more-menu button[onclick*="exportCurrent"]');
    const importBtn = document.querySelector('#worldview-edit-more-menu button[onclick*="importSingle"]');
    const delBtn = document.querySelector('#worldview-edit-more-menu button[onclick*="deleteCurrentWorldview"]');
    const restoreBtn = document.getElementById('worldview-restore-builtin-btn');
    if (exportBtn) exportBtn.style.display = isHidden ? 'none' : '';
    if (importBtn) importBtn.style.display = isHidden ? 'none' : '';
    if (delBtn) delBtn.style.display = isHidden ? 'none' : '';
    if (restoreBtn && isHidden) restoreBtn.classList.add('hidden');
    // v632：世界书状态下，⋯ 按钮本身也藏了（菜单里什么都没有）
    const moreBtn = document.getElementById('worldview-edit-more-btn');
    if (moreBtn) moreBtn.style.display = isHidden ? 'none' : '';
    // v632.1：世界书显示"编辑描述"按钮（让用户能填写 AI 生成所需的设定背景）
    const lbDescBtn = document.getElementById('worldview-edit-lb-desc-btn');
    if (lbDescBtn) lbDescBtn.style.display = isHidden ? 'flex' : 'none';
    // v632：世界书把"事件"子 tab 藏掉、显示"NPC"子 tab；世界观反之
const eventSubBtn = document.querySelector('.wv-ext-subtab-btn[data-subtab="event"]');
const npcSubBtn = document.getElementById('wv-ext-subtab-btn-npc');
if (eventSubBtn) eventSubBtn.style.display = isHidden ? 'none' : '';
if (npcSubBtn) npcSubBtn.style.display = isHidden ? 'flex' : 'none';
// v683.1：+菜单里事件/NPC 项也跟着切（世界书隐藏"事件"、显示"NPC"）
const addMenuEvent = document.getElementById('wv-ext-add-menu-event');
const addMenuNpc = document.getElementById('wv-ext-add-menu-npc');
if (addMenuEvent) addMenuEvent.style.display = isHidden ? 'none' : 'flex';
if (addMenuNpc) addMenuNpc.style.display = isHidden ? 'flex' : 'none';
// v683.2：世界观下强制隐藏 NPC 子 tab 内容容器（按钮已隐藏，但内容会残留导致"扩展页一进来就看到 NPC 区"）
const npcSubContent = document.querySelector('.wv-ext-subtab-content[data-subtab="npc"]');
if (npcSubContent) npcSubContent.classList.toggle('hidden', !isHidden ? true : (_currentExtSubtab !== 'npc'));
    // 默认子 tab 落点：
// - 世界书进来停在节日（事件子 tab 不存在）
// - 世界观进来若残留在 npc（来自上次编辑的世界书），切回节日
if (isHidden && _currentExtSubtab === 'event') {
  try { switchExtSubtab('festival'); } catch(_) {}
}
if (!isHidden && _currentExtSubtab === 'npc') {
  try { switchExtSubtab('festival'); } catch(_) {}
}
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

    // 读取内置世界观待更新标记
    let pendingMap = {};
    try {
      const pendingRaw = await DB.get('gameState', 'builtinPendingUpdate');
      pendingMap = pendingRaw?.value || {};
    } catch(_) {}

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
            <div style="font-size:16px;font-weight:bold;color:var(--accent);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${Utils.escapeHtml(w.name)}${pendingMap[w.id] ? ' <span onclick="event.stopPropagation();Worldview.applyBuiltinUpdate(\'' + w.id + '\')" style="font-size:11px;font-weight:500;padding:1px 6px;border-radius:4px;background:var(--accent);color:#111;cursor:pointer;vertical-align:middle;margin-left:6px">可更新</span>' : ''}</div>
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
    // 继承全局主题绑定（如果有）
    try {
      const binding = await DB.get('gameState', 'globalThemeBinding');
      if (binding && binding.value) newEntry.themeName = binding.value;
    } catch(_) {}
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
function _applyStatusBarSkin(w) {
  try {
    // 先清除之前可能残留的自定义主题样式
    if (window.StatusBarTheme && StatusBarTheme.clearPreview) StatusBarTheme.clearPreview();
    
    if (!w) { document.body.removeAttribute('data-sb-skin'); document.body.removeAttribute('data-skin'); return; }
    // 内置世界观锁死
    if (_isBuiltinWorldview(w)) {
      if (w.id === 'wv_tianshucheng') document.body.setAttribute('data-sb-skin', 'terminal');
      else document.body.removeAttribute('data-sb-skin');
      document.body.removeAttribute('data-skin');
      return;
    }
    // 自定义世界观
    // 无世界观（__default_wv__）原生默认皮肤是 single-default，其余自定义世界观默认 terminal
    const _defaultSkin = (w.id === '__default_wv__') ? 'single-default' : 'terminal';
    const skin = w.statusBarSkin || _defaultSkin;
    if (skin.startsWith('sb_')) {
      if (window.StatusBarTheme) {
        const theme = StatusBarTheme.get(skin);
        if (theme) {
          const css = theme.css || (theme.draft && theme.draft.currentCss) || '';
          StatusBarTheme.applyPreview(theme.baseTemplate, css);
        } else {
          document.body.setAttribute('data-sb-skin', 'terminal');
        }
      }
    } else if (skin === 'single-default') {
      // 无世界观风：用 data-skin，清掉 data-sb-skin
      document.body.setAttribute('data-skin', 'single-default');
      document.body.removeAttribute('data-sb-skin');
    } else {
      // 预设风格（terminal / neumorph）
      document.body.setAttribute('data-sb-skin', skin);
      document.body.removeAttribute('data-skin');
    }
    try { setTimeout(() => StatusBar?.refreshFromConv?.(), 0); } catch(_) {}
  } catch(_) {}
}

// 重新应用当前世界观的状态栏皮肤（供外部调用，比如编辑器关闭后恢复）
async function reapplyStatusBarSkin() {
  try {
    if (!currentWorldviewId) return;
    const w = await DB.get('worldviews', currentWorldviewId);
    if (w) _applyStatusBarSkin(w);
  } catch(e) { console.warn('[reapplyStatusBarSkin]', e); }
}

// 渲染状态栏风格下拉框选项（自定义下拉组件版）
function _renderStatusBarSkinOptions() {
  const input = document.getElementById('wv-statusbar-skin');
  if (!input) return;
  // 收集所有可选项存到 _skinOptions 供下拉使用
  _skinOptions = [
    { value: 'neumorph', label: '拟态风格' },
    { value: 'terminal', label: '终端风格' }
  ];
  if (window.StatusBarTheme) {
    const customThemes = StatusBarTheme.getAll();
    customThemes.forEach(t => {
      _skinOptions.push({ value: t.id, label: t.name });
    });
  }
}
let _skinOptions = [];
// 幽灵点击防护：选中项关闭下拉的瞬间，挡掉合成 click 穿透到触发按钮
let _skinClickLock = 0;

function _toggleSkinDropdown(ev) {
  // 刚选完项的短时间窗内忽略触发，防止幽灵点击重新弹出
  if (Date.now() < _skinClickLock) return;
  const dropdown = document.getElementById('wv-statusbar-skin-dropdown');
  if (!dropdown) return;
  const isHidden = dropdown.classList.contains('hidden');
  if (isHidden) {
    const curVal = document.getElementById('wv-statusbar-skin')?.value || 'neumorph';
    dropdown.innerHTML = _skinOptions.map(o =>
      `<div class="custom-dropdown-item${o.value === curVal ? ' active' : ''}" onclick="event.stopPropagation();Worldview._selectSkin('${Utils.escapeHtml(o.value)}', event)">${Utils.escapeHtml(o.label)}</div>`
    ).join('');
    dropdown.classList.remove('hidden');
    setTimeout(() => {
      document.addEventListener('click', function _close(e) {
        if (!dropdown.contains(e.target) && !e.target.closest('#wv-statusbar-skin-btn')) {
          dropdown.classList.add('hidden');
          document.removeEventListener('click', _close);
        }
      });
    }, 0);
  } else {
    dropdown.classList.add('hidden');
  }
}

function _selectSkin(val, ev) {
  if (ev) { try { ev.stopPropagation(); ev.preventDefault(); } catch(_) {} }
  // 上锁 350ms，挡掉这次 tap 的延迟合成 click
  _skinClickLock = Date.now() + 350;
  const input = document.getElementById('wv-statusbar-skin');
  const label = document.getElementById('wv-statusbar-skin-label');
  const dropdown = document.getElementById('wv-statusbar-skin-dropdown');
  if (input) { input.value = val; input.dispatchEvent(new Event('change')); }
  const opt = _skinOptions.find(o => o.value === val);
  if (label && opt) label.textContent = opt.label;
  if (dropdown) dropdown.classList.add('hidden');
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
      // 货币改为多货币（currencies 数组），由 add/update/deleteCurrency 实时保存，这里不覆盖
      w.phoneApps = w.phoneApps || { takeout: { name: '', desc: '' }, shop: { name: '', desc: '' }, forum: { name: '', desc: '' } };
      w.phoneApps.takeout = w.phoneApps.takeout || { name: '', desc: '' };
      w.phoneApps.shop = w.phoneApps.shop || { name: '', desc: '' };
      w.phoneApps.forum = w.phoneApps.forum || { name: '', desc: '' };
      w.phoneApps.takeout.name = document.getElementById('wv-takeout-name')?.value || '';
      w.phoneApps.takeout.desc = document.getElementById('wv-takeout-desc')?.value || '';
      w.phoneApps.takeout.deliveryMin = document.getElementById('wv-takeout-deliveryMin')?.value || '';
      w.phoneApps.takeout.deliveryMax = document.getElementById('wv-takeout-deliveryMax')?.value || '';
      w.phoneApps.takeout.deliveryUnit = document.getElementById('wv-takeout-deliveryUnit')?.value || 'min';
      w.phoneApps.shop.name = document.getElementById('wv-shop-name')?.value || '';
      w.phoneApps.shop.desc = document.getElementById('wv-shop-desc')?.value || '';
      w.phoneApps.shop.deliveryMin = document.getElementById('wv-shop-deliveryMin')?.value || '';
      w.phoneApps.shop.deliveryMax = document.getElementById('wv-shop-deliveryMax')?.value || '';
      w.phoneApps.shop.deliveryUnit = document.getElementById('wv-shop-deliveryUnit')?.value || 'day';
      w.phoneApps.forum.name = document.getElementById('wv-forum-name')?.value || '';
      w.phoneApps.forum.desc = document.getElementById('wv-forum-desc')?.value || '';
      const skinEl = document.getElementById('wv-statusbar-skin');
    if (skinEl && !_isBuiltinWorldview(w)) w.statusBarSkin = skinEl.value || 'terminal';
      try { if (typeof _syncStartTimeHidden === 'function') _syncStartTimeHidden(); } catch(_) {}
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

  // ===== 扩展/玩法 定时全量保存（防闪退丢数据） =====
  let _fullSaveTimer = null;
  function _startFullSaveTimer() {
    _stopFullSaveTimer();
    _fullSaveTimer = setInterval(() => {
    if (editingWorldviewId) {
      try { save({ silent: true }); } catch(_) {}
    }
    }, 30000);
  }
  function _stopFullSaveTimer() {
    if (_fullSaveTimer) { clearInterval(_fullSaveTimer); _fullSaveTimer = null; }
  }

  // ===== 扩展设定自动保存（节日/常驻/动态修改后 debounce 2s 写DB） =====
  const _wvExtAutoSave = Utils.debounce(async () => {
    if (!editingWorldviewId) return;
    try { await save({ silent: true }); } catch(e) { console.warn('[Worldview] 扩展自动保存失败', e); }
  }, 2000);

  function _attachWVAutoSave() {
    // 主编辑页
    ['wv-name','wv-description','wv-setting','wv-takeout-name','wv-takeout-desc','wv-shop-name','wv-shop-desc','wv-forum-name','wv-forum-desc','wv-statusbar-skin','wv-start-time','wv-start-plot','wv-start-plot-rounds','wv-start-message','wv-takeout-deliveryMin','wv-takeout-deliveryMax','wv-takeout-deliveryUnit','wv-shop-deliveryMin','wv-shop-deliveryMax','wv-shop-deliveryUnit'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.removeEventListener('input', _wvAutoSave);
        el.removeEventListener('change', _wvAutoSave);
        el.addEventListener('input', _wvAutoSave);
        el.addEventListener('change', _wvAutoSave);
      }
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
    ['wv-npc-name','wv-npc-aliases','wv-npc-onlinename','wv-npc-summary','wv-npc-detail'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.removeEventListener('input', _wvNpcAutoSave); el.addEventListener('input', _wvNpcAutoSave); }
    });
  }

  // ---------- 编辑面板 ----------
  // v596：标记从哪里进入编辑（用于返回时跳对地方）
  let _editReturnTo = null;

  // v632：复用本编辑器编辑世界书（Lorebook）。
  // 约定：editingWorldviewId 以 'lb:' 开头时，从 lorebooks store 读写；
  // 否则按 worldviews store 走。这样所有编辑 UI 逻辑零改动。
  function _isLorebookEditing(id) {
    return typeof id === 'string' && id.startsWith('lb:');
  }
  function _lbIdOf(id) { return id.replace(/^lb:/, ''); }
  async function _loadEditingDoc(id) {
    if (_isLorebookEditing(id)) {
      const lb = (typeof Lorebook !== 'undefined') ? await Lorebook.get(_lbIdOf(id)) : null;
      if (!lb) return null;
      // 包装成"隐藏世界观"格式，复用现有编辑 UI
      return {
        id: id,
        _hidden: 'lb',
        _lbId: lb.id,
        name: lb.name || '未命名世界书',
        description: lb.description || '',
        festivals: lb.festivals || [],
        knowledges: lb.knowledges || [],
        events: lb.events || [],
        globalNpcs: lb.globalNpcs || [],
      };
    }
    return await DB.get('worldviews', id);
  }

  async function openEdit(id, opts) {
    const w = await _loadEditingDoc(id);
    window.__wvEditingCache = w;
    if (!w) return;
    if (!_isLorebookEditing(id)) {
      if (!await _confirmBuiltinWorldviewAccess('edit', w)) return;
    }
    editingWorldviewId = id;
    _editReturnTo = (opts && opts.returnTo) || null;
    closePreview(); // 关闭预览弹窗（如果有的话）
    // 先加载表单数据，再切面板，避免出现"先切到空白页 → 后填内容"的视觉空白
    await _loadEditForm(id);
    UI.showPanel('worldview-edit');
    // 面板显示后再补算一次 textarea 高度：_loadEditForm 内的重算发生在面板尚未显示时，
    // 此时 scrollHeight 读到 0，会把高度/滚动算错，导致 AI 生成的长设定打开后无法滑动。
    // 面板显示并完成布局后重算一次即可恢复（无需用户先手动编辑触发）。
    requestAnimationFrame(_resizeWorldviewEditTextareas);
    setTimeout(_resizeWorldviewEditTextareas, 120);
    _startFullSaveTimer();
  }
  // 给外部调用：编辑面板返回时的目标路径
  function getEditReturnTo() {
    return _editReturnTo;
  }
  function clearEditReturnTo() {
    _editReturnTo = null;
  }
  
  async function _loadEditForm(id) {
    const w = await _loadEditingDoc(id);
    if (!w) return;
    
    // 数据迁移（v581）：customs[] + knowledges[] → 统一 knowledges[]
    _migrateToKnowledges(w);

    // v596：隐藏世界观（单人卡专属扩展设定容器）特殊处理
    const isHidden = isHiddenWv(w);
    document.getElementById('worldview-edit-title').textContent = isHidden ? '编辑世界书' : '编辑世界观';
    _applyHiddenWvUI(isHidden);
    if (isHidden) {
      // 隐藏世界观只用扩展 tab
      switchEditTab('special');
      _renderFestivals(w.festivals || []);
    _renderCustoms((w.knowledges || []).filter(k => !k.keywordTrigger));
    _renderKnowledges((w.knowledges || []).filter(k => !!k.keywordTrigger));
    _renderEvents(w.events || []);
    // v632.1：世界书也要渲染全图 NPC（加载时漏了）
    _renderGlobalNpcs(w.globalNpcs || []);
      
      // 自愈兜底：切主题后世界书编辑页（special tab）内容区可能高度为 0，强制清除隐藏状态
      requestAnimationFrame(() => {
        try {
          const special = document.getElementById('wv-edit-tab-special');
          if (!special) return;
          const visible = special.offsetHeight > 0 && !special.classList.contains('hidden');
          if (!visible) {
            const clearVis = (el) => {
              if (!el) return;
              el.classList.remove('hidden');
              ['opacity','transform','display','visibility','height','max-height'].forEach(p => el.style.removeProperty(p));
            };
            document.querySelectorAll('.wv-edit-tab-content').forEach(clearVis);
            let node = special;
            const panel = document.getElementById('panel-worldview-edit');
            while (node && node !== panel) { clearVis(node); node = node.parentElement; }
            clearVis(panel);
            switchEditTab('special');
          }
        } catch(_) {}
      });
    return;
    }

    // 关键修复：无论后续数据填充是否出错，先把内容区切到 basic tab 显示出来，
    // 避免某个 getElementById 拿到 null 抛异常导致 switchEditTab 不执行、整页只剩标题+Tab。
    try { switchEditTab('basic'); } catch(_) {}

    try {
    _syncBuiltinRestoreButton(w);
    
    // 基础设定
    document.getElementById('wv-name').value = w.name || '';
    document.getElementById('wv-description').value = w.description || '';
    // icon字段保留默认值（不再有emoji输入框）
    document.getElementById('wv-setting').value = w.setting || '';
    try { _renderCurrencies(w); } catch(_) {}
    const _pa = w.phoneApps || {};
    const _paTk = _pa.takeout || {};
    const _paSh = _pa.shop || {};
    const _paFm = _pa.forum || {};
const _tkN = document.getElementById('wv-takeout-name'); if (_tkN) _tkN.value = _paTk.name || '';
      const _tkD = document.getElementById('wv-takeout-desc'); if (_tkD) _tkD.value = _paTk.desc || '';
      const _tkDMin = document.getElementById('wv-takeout-deliveryMin'); if (_tkDMin) _tkDMin.value = _paTk.deliveryMin || '';
      const _tkDMax = document.getElementById('wv-takeout-deliveryMax'); if (_tkDMax) _tkDMax.value = _paTk.deliveryMax || '';
      const _tkDUnit = document.getElementById('wv-takeout-deliveryUnit'); if (_tkDUnit) _tkDUnit.value = _paTk.deliveryUnit || 'min';
      const _shN = document.getElementById('wv-shop-name'); if (_shN) _shN.value = _paSh.name || '';
      const _shD = document.getElementById('wv-shop-desc'); if (_shD) _shD.value = _paSh.desc || '';
      const _shDMin = document.getElementById('wv-shop-deliveryMin'); if (_shDMin) _shDMin.value = _paSh.deliveryMin || '';
      const _shDMax = document.getElementById('wv-shop-deliveryMax'); if (_shDMax) _shDMax.value = _paSh.deliveryMax || '';
      const _shDUnit = document.getElementById('wv-shop-deliveryUnit'); if (_shDUnit) _shDUnit.value = _paSh.deliveryUnit || 'day';
    const _fmN = document.getElementById('wv-forum-name'); if (_fmN) _fmN.value = _paFm.name || '';
    const _fmD = document.getElementById('wv-forum-desc'); if (_fmD) _fmD.value = _paFm.desc || '';
    const _skin = document.getElementById('wv-statusbar-skin');
    if (_skin) {
      _renderStatusBarSkinOptions(); // 渲染选项（包含自定义主题）
      _skin.value = w.statusBarSkin || 'terminal';
      // 同步 label 显示
      const _skinLabel = document.getElementById('wv-statusbar-skin-label');
      const _skinOpt = _skinOptions.find(o => o.value === _skin.value);
      if (_skinLabel && _skinOpt) _skinLabel.textContent = _skinOpt.label;
      // disabled 态：内置世界观禁止改
      const _skinBtn = document.getElementById('wv-statusbar-skin-btn');
      if (_skinBtn) {
        if (_isBuiltinWorldview(w)) { _skinBtn.style.opacity = '0.5'; _skinBtn.style.pointerEvents = 'none'; }
        else { _skinBtn.style.opacity = ''; _skinBtn.style.pointerEvents = ''; }
      }
    }
    document.getElementById('wv-start-time').value = w.startTime || '';
    // 缓存当前编辑世界观的历法规则（供开场时间星期计算用）
    _editingCalRules = w?.gameplay?.calendarSystem || null;
    // 回填分字段
    _fillStartTimeFields(w.startTime || '');
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
// 玩法配置：自定义属性
_renderGameplayAttrs(w);
// 历法系统卡片标签
_updateCalendarCardLabel();
// 手机配置卡片标签
_updatePhoneAppsLabel();
    } catch (e) {
      // 数据填充中途出错也不影响内容区显示（已在前面先切到 basic tab）
      console.warn('[Worldview] _loadEditForm 填充部分字段失败', e);
    }

 switchEditTab('basic');

    // 自愈兜底：切主题等外部状态可能让 tab 内容容器渲染高度为 0（表现为"只剩标题和 Tab"）。
    // 进面板后检测一次，若内容区高度异常，强制清除隐藏状态并重切，避免必须手动刷新。
    requestAnimationFrame(() => {
      try {
        const basic = document.getElementById('wv-edit-tab-basic');
        if (!basic) return;
        const visible = basic.offsetHeight > 0 && !basic.classList.contains('hidden');
        if (!visible) {
          // 1) 清掉从 tab 内容到面板根的整条祖先链上的内联可见性样式 + hidden 类
          const clearVis = (el) => {
            if (!el) return;
            el.classList.remove('hidden');
            ['opacity','transform','display','visibility','height','max-height'].forEach(p => el.style.removeProperty(p));
          };
          document.querySelectorAll('.wv-edit-tab-content').forEach(clearVis);
          let node = basic;
          const panel = document.getElementById('panel-worldview-edit');
          while (node && node !== panel) { clearVis(node); node = node.parentElement; }
          clearVis(panel);
          switchEditTab('basic');
          // 2) 诊断：把修复前各层状态记到面板 dataset，便于无控制台时排查
          try {
            const probe = [];
            let n2 = document.getElementById('wv-edit-tab-basic');
            const panel2 = document.getElementById('panel-worldview-edit');
            while (n2 && n2 !== panel2.parentElement) {
              const cs = getComputedStyle(n2);
              probe.push((n2.id || n2.className || n2.tagName) + ':h' + n2.offsetHeight + ',op' + cs.opacity + ',d' + cs.display + ',v' + cs.visibility);
              n2 = n2.parentElement;
            }
            if (panel2) panel2.dataset.blankProbe = probe.join(' | ');
          } catch(_) {}
        }
      } catch(_) {}
    });
    // 绑定主编辑页自动保存
    requestAnimationFrame(_attachWVAutoSave);

    const resizeWorldviewEdit = _resizeWorldviewEditTextareas;
    requestAnimationFrame(resizeWorldviewEdit);
    setTimeout(resizeWorldviewEdit, 260);
    setTimeout(resizeWorldviewEdit, 420);
  }

  // 重算主编辑页几个自适应 textarea 的高度/滚动（抽成模块级，供 openEdit 在面板显示后再补一次，
  // 修复 AI 生成世界观后直接打开编辑页、textarea 高度按未显示时的 scrollHeight(=0) 算错、导致内容无法滑动的问题）。
  function _resizeWorldviewEditTextareas() {
    ['wv-description', 'wv-setting', 'wv-start-plot', 'wv-start-message'].forEach(id => {
      const ta = document.getElementById(id);
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
      ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
    });
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
    // 进入事件子 tab 时，初始化"独立/事件链"二级 tab 的高亮与按钮文案
    if (subtab === 'event') { try { switchEventTab(_wvEventTab); } catch(_) {} }
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
    if (!willOpen) {
      menu.classList.add('hidden');
      menu.style.position = 'absolute';
      return;
    }
    const btn = e?.currentTarget || e?.target;
    const rect = btn?.getBoundingClientRect ? btn.getBoundingClientRect() : null;
    menu.classList.remove('hidden');
    if (rect) {
      const menuW = Math.max(menu.offsetWidth || 150, 150);
      const left = Math.max(8, Math.min(window.innerWidth - menuW - 8, rect.right - menuW));
      const top = Math.min(window.innerHeight - 12, rect.bottom + 4);
      menu.style.position = 'fixed';
      menu.style.left = left + 'px';
      menu.style.right = 'auto';
      menu.style.top = top + 'px';
      menu.style.zIndex = '999999';
      try { document.body.appendChild(menu); } catch(_) {}
    }
    // 点空白处关闭
    setTimeout(() => {
      const onDocClick = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.classList.add('hidden');
          menu.style.position = 'absolute';
          menu.style.left = '';
          menu.style.right = '0';
          menu.style.top = 'calc(100% + 4px)';
          document.removeEventListener('click', onDocClick);
        }
      };
      document.addEventListener('click', onDocClick);
    }, 0);
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
    } else if (type === 'npc') {
      // 世界书专属：直接打开批量导入入口；想新增单个 NPC 还是走 NPC 子 tab 里的 + 按钮
      switchExtSubtab('npc');
      if (typeof addGlobalNpc === 'function') addGlobalNpc();
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

  // 导出扩展设定（节日 + 扩展条目 + 事件 + 全图 NPC）为 JSON
  async function exportExtended() {
    const menu = document.getElementById('wv-ext-io-menu');
    if (menu) menu.classList.add('hidden');
    if (!editingWorldviewId) { UI.showToast('没有正在编辑的世界观'); return; }
    const w = await _getEditingWV();
    const wvName = w?.name || '扩展设定';
    const evts = Array.isArray(w?.events) ? w.events : [];
    const npcs = Array.isArray(w?.globalNpcs) ? w.globalNpcs : [];
    // 注：导出当前内存中的数据（已编辑但未保存的也会一并导出）
    const exportData = {
      _format: 'tianshu-extended',
      _version: 2,
      _source: wvName,
      _exportedAt: new Date().toISOString(),
      festivals: JSON.parse(JSON.stringify(festivalsData || [])),
      knowledges: JSON.parse(JSON.stringify(knowledgesData || [])),
      events: JSON.parse(JSON.stringify(evts)),
      globalNpcs: JSON.parse(JSON.stringify(npcs)),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = wvName + '-扩展设定.json';
    a.click();
    URL.revokeObjectURL(url);
    const total = (festivalsData?.length || 0) + (knowledgesData?.length || 0) + evts.length + npcs.length;
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
    const evts = Array.isArray(data.events) ? data.events : [];
    const npcs = Array.isArray(data.globalNpcs) ? data.globalNpcs : [];
    if (fest.length === 0 && know.length === 0 && evts.length === 0 && npcs.length === 0) {
      UI.showToast('文件内没有扩展设定内容', 3000);
      return;
    }
    // v683.1：检查当前是世界观还是世界书，决定哪些数据能落地
    const w = await _getEditingWV();
    const isLb = isHiddenWv(w);
    const mode = await _askImportMode(fest.length, know.length, evts.length, npcs.length, isLb);
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
    // events：仅世界观接收，世界书无事件 tab（events 跳过并提示）
    let evtMsg = '';
    if (evts.length > 0) {
      if (isLb) {
        evtMsg = `（跳过 ${evts.length} 条事件：世界书无事件系统）`;
      } else {
        try {
          if (!Array.isArray(w.events)) w.events = [];
          for (const e of evts) {
            if (!e.id) e.id = 'evt_' + Utils.uuid().slice(0, 8);
            else if (w.events.some(x => x.id === e.id)) e.id = 'evt_' + Utils.uuid().slice(0, 8);
          }
          if (mode === 'replace') w.events = evts;
          else w.events = w.events.concat(evts);
          await _saveEditingWV(w);
          _renderEvents(w.events);
          evtMsg = `+ ${evts.length} 条事件`;
        } catch(e) {
          console.warn('[importExtended] 事件写入失败', e);
          evtMsg = `（${evts.length} 条事件写入失败）`;
        }
      }
    }
    // globalNpcs：世界观/世界书都有 → 直接合并到 globalNpcs（追加，撞名不阻拦，保持 v683 风格）
    let npcMsg = '';
    if (npcs.length > 0) {
      try {
        const wv2 = await _getEditingWV();
        if (wv2) {
          wv2.globalNpcs = wv2.globalNpcs || [];
          for (const n of npcs) {
            if (!n.id) n.id = 'npc_' + Utils.uuid().slice(0, 8);
            else if (wv2.globalNpcs.some(x => x.id === n.id)) n.id = 'npc_' + Utils.uuid().slice(0, 8);
          }
          if (mode === 'replace') wv2.globalNpcs = npcs;
          else wv2.globalNpcs = wv2.globalNpcs.concat(npcs);
          await _saveEditingWV(wv2);
          _renderGlobalNpcs(wv2.globalNpcs);
          npcMsg = `+ ${npcs.length} 个 NPC`;
        }
      } catch(e) {
        console.warn('[importExtended] NPC 写入失败', e);
        npcMsg = `（${npcs.length} 个 NPC 写入失败）`;
      }
    }
    _renderFestivals(festivalsData);
    _renderKnowledges(knowledgesData);
    _updateExtCounts();
    UI.showToast(`已导入 ${fest.length + know.length} 条 ${evtMsg} ${npcMsg}`.replace(/\s+/g, ' ').trim(), 3500);
    _wvExtAutoSave();
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
    const msg = `已导入 ${imported.length} 条` + (skipped ? `（跳过 ${skipped} 条空条目）` : '');
    UI.showToast(msg, 3000);
    _wvExtAutoSave();
  }

  // 询问导入模式：替换 / 追加
  async function _askImportMode(festCount, knowCount, evtCount, npcCount, isLb) {
    const eventsNow = 0; // 不展示当前事件数（拿不到很麻烦）
    const hasData = (festivalsData?.length || 0) + (knowledgesData?.length || 0) > 0;
    if (!hasData && (evtCount || 0) === 0 && (npcCount || 0) === 0) return 'append';
    const parts = [
      `当前已有 ${festivalsData?.length || 0} 个节日 + ${knowledgesData?.length || 0} 个条目。`,
      `即将导入 ${festCount} 个节日 + ${knowCount} 个条目`
        + ((evtCount || 0) > 0 ? ` + ${evtCount} 条事件${isLb ? '（世界书会跳过）' : ''}` : '')
        + ((npcCount || 0) > 0 ? ` + ${npcCount} 个 NPC` : '')
        + '。',
      '',
      '选择「确定」=追加到现有条目',
      '选择「取消」=取消导入',
    ];
    const append = await UI.showConfirm('追加导入', parts.join('\n'));
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
      let visibleCount = 0;
      for (const card of cards) {
        if (card.id && card.id.endsWith('-empty')) continue;
        const show = !q || match(card);
        card.style.display = show ? '' : 'none';
        if (show) visibleCount++;
      }
      const empty = Array.from(cards).find(el => el.id && el.id.endsWith('-empty'));
      if (empty) empty.style.display = (!q && visibleCount === 0) ? '' : 'none';
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
  async function handleIconImageUpload() {
    const dataUrl = await Utils.promptImageInput({ maxSize: 256, quality: 0.85 });
    if (!dataUrl) return;
    const preview = document.getElementById('wv-icon-image-preview');
    preview.innerHTML = `<img src="${dataUrl}" style="width:64px;height:64px;object-fit:cover" data-value="${dataUrl}">`;
    _saveIconImageToDB(dataUrl);
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
// v632：editingWorldviewId 以 'lb:' 开头时走 lorebooks store，包装成 worldview 形状
async function _getEditingWV() {
if (!editingWorldviewId) return null;
if (_isLorebookEditing(editingWorldviewId)) {
  const lb = (typeof Lorebook !== 'undefined') ? await Lorebook.get(_lbIdOf(editingWorldviewId)) : null;
  if (!lb) return null;
  return {
    id: editingWorldviewId,
    _hidden: 'lb',
    _lbId: lb.id,
    name: lb.name || '未命名世界书',
    description: lb.description || '',
    festivals: lb.festivals || [],
    knowledges: lb.knowledges || [],
    events: lb.events || [],
    globalNpcs: lb.globalNpcs || [],
  };
}
return await DB.get('worldviews', editingWorldviewId);
}
async function _saveEditingWV(w) {
// v632：世界书路径走 Lorebook.save，回写到 lorebooks store
if (_isLorebookEditing(editingWorldviewId)) {
  if (typeof Lorebook === 'undefined') return;
  const lbId = _lbIdOf(editingWorldviewId);
  const existing = await Lorebook.get(lbId);
  if (!existing) return;
  // v632.1：只回写 globalNpcs（NPC 是直读直写架构）
  // festivals/knowledges/events 由模块级缓存 + save() 按钮统一回写，
  // 这里不能用入参 w 的旧值覆盖（w 是 _getEditingWV 从 lorebook 现读的，
  // 不含用户在 UI 上未保存的修改）
  existing.globalNpcs = w.globalNpcs || [];
  // name 仅在用户在面板顶部改名时生效（保留旧行为）
  if (w.name && w.name !== existing.name) existing.name = w.name;
  await Lorebook.save(existing);
  return;
}
// 关键修复：历法等子保存走的是"从 DB 现读 w → 改字段 → 整体 put 回写"。
// 但用户在编辑表单里改的开场时间（startTime）可能尚未落库，
// 若不合并就 put，会用 DB 旧快照（无 startTime）覆盖掉表单上的最新值，
// 导致"填了开场时间却仍提示未填"。这里在写库前同步一次表单的开场时间字段。
try {
  const stEl = document.getElementById('wv-start-time');
  // 仅当编辑面板已加载（hidden 元素存在）且不是隐藏/世界书世界观时才合并
  if (stEl && !isHiddenWv(w)) {
    if (typeof _syncStartTimeHidden === 'function') _syncStartTimeHidden();
    const stVal = (stEl.value || '').trim();
    if (stVal) w.startTime = stVal;
  }
} catch(_) {}
await DB.put('worldviews', w);
// 立刻同步到运行时（仅当编辑的是当前激活世界观）
await _syncRuntime(w);
}
// v632.1：世界书状态下，弹窗编辑名字 + 描述（描述在 AI 生成时作为 setting 兜底）
async function editLorebookDescription() {
  if (!_isLorebookEditing(editingWorldviewId)) return;
  const lbId = _lbIdOf(editingWorldviewId);
  if (typeof Lorebook === 'undefined') return;
  const lb = await Lorebook.get(lbId);
  if (!lb) return;
  const res = await UI.showNameDescInput('编辑世界书', {
    name: lb.name || '',
    description: lb.description || '',
    namePlaceholder: '给世界书起个名字',
    descPlaceholder: '描述这本世界书的背景设定。AI 生成 NPC 时会以此为背景。',
  });
  if (!res) return;
  lb.name = res.name;
  lb.description = res.description;
  await Lorebook.save(lb);
  // 同步刷新编辑器顶部标题（改了名字要立即体现）
  try {
    const titleEl = document.getElementById('worldview-edit-title');
    if (titleEl) titleEl.textContent = lb.name;
  } catch(_) {}
  UI.showToast('已保存', 1500);
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
  // 当前编辑中的 NPC id（普通 / 全图都用同一个变量）
  async function _currentEditNpcId() {
    try {
      const w = await _getEditingWV();
      if (!w) return null;
      if (_editGlobalNpcIdx >= 0) {
        return (w.globalNpcs && w.globalNpcs[_editGlobalNpcIdx])?.id || null;
      }
      if (_editRegionIdx >= 0 && _editFactionIdx >= 0 && _editNPCIdx >= 0) {
        return (w.regions[_editRegionIdx]?.factions[_editFactionIdx]?.npcs[_editNPCIdx])?.id || null;
      }
    } catch(_) {}
    return null;
  }

  async function _refreshEditingNpcAvatar() {
    const content = document.getElementById('wv-npc-avatar-content');
    const btn = document.getElementById('wv-npc-avatar-btn');
    if (!content || !btn) return;
    const npcId = await _currentEditNpcId();
    let url = '';
    if (npcId) {
      try {
        const r = await DB.get('npcAvatars', npcId);
        if (r && r.avatar) url = r.avatar;
      } catch(_) {}
    }
    if (url) {
      content.innerHTML = `<img src="${Utils.escapeHtml(url)}" style="width:100%;height:100%;object-fit:cover">`;
    } else {
      content.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/></svg>`;
    }
    // 长按删除：重新绑定（每次刷新清掉旧的）
    btn.ontouchstart = null;
    btn.ontouchend = null;
    btn.ontouchcancel = null;
    btn.oncontextmenu = null;
    let _lpTimer = null;
    const _startLp = () => {
      if (_lpTimer) clearTimeout(_lpTimer);
      _lpTimer = setTimeout(() => { _lpTimer = null; _clearEditingNpcAvatar(); }, 600);
    };
    const _cancelLp = () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } };
    btn.ontouchstart = (e) => { _startLp(); };
    btn.ontouchend = _cancelLp;
    btn.ontouchcancel = _cancelLp;
    btn.oncontextmenu = (e) => { e.preventDefault(); _clearEditingNpcAvatar(); };
  }
  async function _pickEditingNpcAvatar() {
    const npcId = await _currentEditNpcId();
    if (!npcId) { UI.showToast('请先保存角色名称再上传头像', 1800); return; }
    const dataUrl = await Utils.promptImageInput({ maxSize: 256, quality: 0.85 });
    if (!dataUrl) return;
    try {
      if (typeof SingleCard !== 'undefined' && SingleCard.setNpcAvatar) {
        await SingleCard.setNpcAvatar(npcId, dataUrl);
      } else {
        await DB.put('npcAvatars', { id: npcId, avatar: dataUrl, updated: Date.now() });
      }
    } catch(e) { console.warn('[wv-npc] 头像保存失败', e); UI.showToast('头像保存失败', 1500); return; }
    await _refreshEditingNpcAvatar();
    UI.showToast('头像已更新', 1500);
  }

  // AI 生成 NPC 头像：从表单当前值拼中文 prompt（名字+别名+网名+简介+设定，用户自己删减）
  async function _aiGenEditingNpcAvatar() {
    const npcId = await _currentEditNpcId();
    if (!npcId) { UI.showToast('请先保存角色名称再生成头像', 1800); return; }
    const g = id => (document.getElementById(id)?.value || '').trim();
    const parts = [];
    const name = g('wv-npc-name'); if (name) parts.push(name);
    const aliases = g('wv-npc-aliases'); if (aliases) parts.push(aliases);
    const onlineName = g('wv-npc-onlinename'); if (onlineName) parts.push(onlineName);
    const summary = g('wv-npc-summary'); if (summary) parts.push(summary);
    const detail = g('wv-npc-detail'); if (detail) parts.push(detail);
    const dataUrl = await Utils.promptAiAvatar(parts.join('，'), { maxSize: 256, quality: 0.85 });
    if (!dataUrl) return;
    try {
      if (typeof SingleCard !== 'undefined' && SingleCard.setNpcAvatar) {
        await SingleCard.setNpcAvatar(npcId, dataUrl);
      } else {
        await DB.put('npcAvatars', { id: npcId, avatar: dataUrl, updated: Date.now() });
      }
    } catch(e) { console.warn('[wv-npc] 头像保存失败', e); UI.showToast('头像保存失败', 1500); return; }
    await _refreshEditingNpcAvatar();
    UI.showToast('头像已更新', 1500);
  }


  async function _clearEditingNpcAvatar() {
    const npcId = await _currentEditNpcId();
    if (!npcId) return;
    try {
      const r = await DB.get('npcAvatars', npcId);
      if (!r || !r.avatar) return;  // 本来就没有，不弹确认
    } catch(_) {}
    if (!await UI.showConfirm('删除头像', '删除该角色的自定义头像？')) return;
    try {
      if (typeof SingleCard !== 'undefined' && SingleCard.setNpcAvatar) {
        await SingleCard.setNpcAvatar(npcId, '');
      } else {
        await DB.delete('npcAvatars', npcId);
      }
    } catch(_) {}
    await _refreshEditingNpcAvatar();
    UI.showToast('已删除', 1200);
  }

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

    // v687.41j：老数据迁移——profession 字段合进 detail 头部
    if (npc.profession && npc.profession.trim()) {
      const prof = npc.profession.trim();
      const cur = (npc.detail || '').trim();
      const profLine = `**职业**：${prof}`;
      if (!cur.includes(profLine)) {
        npc.detail = cur ? profLine + '\n\n' + cur : profLine;
      }
      delete npc.profession;
    }

    document.getElementById('wv-npc-title').textContent = npc.name || '编辑角色';
document.getElementById('wv-npc-name').value = npc.name || '';
document.getElementById('wv-npc-aliases').value = npc.aliases || '';
const wvNpcOnline1 = document.getElementById('wv-npc-onlinename');
if (wvNpcOnline1) wvNpcOnline1.value = npc.onlineName || '';
document.getElementById('wv-npc-summary').value = npc.summary || '';
document.getElementById('wv-npc-detail').value = npc.detail || '';

    UI.showPanel('wv-npc', 'forward');
    requestAnimationFrame(_attachWVNpcAutoSave);
    _refreshEditingNpcAvatar();
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
      npc.onlineName = (document.getElementById('wv-npc-onlinename')?.value || '').trim();
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
    npc.onlineName = (document.getElementById('wv-npc-onlinename')?.value || '').trim();
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

  // 导出当前编辑中的角色为单 NPC JSON（不含头像；格式可被批量导入直接吃回）
  async function exportCurrentNpc() {
    // 先把表单当前值落库，导出的就是最新内容
    try { await saveNPC(true); } catch(_) {}
    const w = await _getEditingWV();
    if (!w) { UI.showToast('没有正在编辑的世界观'); return; }
    let npc = null;
    if (_editGlobalNpcIdx >= 0) {
      npc = w.globalNpcs && w.globalNpcs[_editGlobalNpcIdx];
    } else if (_editRegionIdx >= 0 && _editFactionIdx >= 0 && _editNPCIdx >= 0) {
      npc = w.regions?.[_editRegionIdx]?.factions?.[_editFactionIdx]?.npcs?.[_editNPCIdx];
    }
    if (!npc) { UI.showToast('未找到要导出的角色'); return; }
    const name = (npc.name || '').trim() || '未命名角色';
    // 单 NPC 对象，导入端 _extractNpcArray 的“单对象含 name”分支可直接识别；不含 id/avatar
    const exportData = {
      _format: 'tianshu-npc',
      _version: 1,
      _source: w.name || '',
      _exportedAt: new Date().toISOString(),
      name,
      aliases: npc.aliases || '',
      onlineName: npc.onlineName || '',
      summary: npc.summary || '',
      detail: npc.detail || ''
    };
    try {
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name + '.json';
      a.click();
      URL.revokeObjectURL(url);
      UI.showToast(`已导出角色「${name}」`);
    } catch(e) {
      UI.showToast('导出失败：' + (e.message || e), 3000);
    }
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
  function _ensureGameplay(w) {
  if (!w.gameplay) w.gameplay = {};
  if (!Array.isArray(w.gameplay.globalAttrs)) w.gameplay.globalAttrs = [];
  if (!Array.isArray(w.gameplay.characterAttrs)) w.gameplay.characterAttrs = [];
  if (!w.gameplay.taskSystem) w.gameplay.taskSystem = { phases: [] };
  if (!Array.isArray(w.gameplay.taskSystem.phases)) w.gameplay.taskSystem.phases = [];
  return w.gameplay;
}

function _defaultGameplayAttr() {
  return { id: 'attr_' + Utils.uuid().slice(0, 8), name: '', desc: '', max: '', initial: 0, overflowTo: '', deriveTo: '', deriveStep: '' };
}

function _attrTargetKey(t) {
  return [t?.targetType || '', t?.targetId || '', t?.sourceWorldviewId || ''].join(':');
}

let _attrModalCtx = null; // { scope, charIdx, attrIdx, isNew }

function _renderAttrRows(attrs, scope, charIdx) {
  if (!attrs || attrs.length === 0) {
    return '<div style="padding:12px;color:var(--text-secondary);font-size:12px;text-align:center;border:1px dashed var(--border);border-radius:8px">暂无属性</div>';
  }
  return attrs.map((a, i) => {
    const name = (a.name || '').trim() || '未命名属性';
    const maxText = (a.max === '' || a.max === null || a.max === undefined) ? '无上限' : `最大 ${a.max}`;
    const summary = `初始 ${a.initial ?? 0} / ${maxText}`;
    return `
      <div onclick="Worldview.openGameplayAttrModal('${scope}', ${charIdx}, ${i})" style="display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;background:var(--bg-secondary);border:1px solid color-mix(in srgb, var(--border) 55%, transparent);cursor:pointer">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(name)}</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(summary)}</div>
        </div>
        <div style="color:var(--text-secondary);font-size:18px;line-height:1;opacity:.65">›</div>
      </div>
    `;
  }).join('');
}

// ===== 通用货币（多货币）编辑 =====
function _renderCurrencies(w) {
  const box = document.getElementById('wv-currencies-container');
  if (!box) return;
  const curs = Array.isArray(w?.currencies) ? w.currencies : [];
  if (!curs.length) {
    box.innerHTML = '<div style="padding:12px;color:var(--text-secondary);font-size:12px;text-align:center;border:1px dashed var(--border);border-radius:8px">暂无货币，点击右上角「+ 添加货币」</div>';
    return;
  }
  box.innerHTML = curs.map((c, i) => `
    <div style="border:1px solid color-mix(in srgb, var(--border) 60%, transparent);border-radius:9px;padding:10px;background:var(--bg-secondary);display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <input type="text" value="${Utils.escapeHtml(c.name || '')}" placeholder="货币名称" oninput="Worldview.updateCurrency(${i},'name',this.value)" style="flex:1;min-width:0">
        <button type="button" onclick="Worldview.bindCurrencyToAttr(${i})" style="white-space:nowrap;padding:6px 9px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--accent);font-size:11px;cursor:pointer">创建属性</button>
        <button type="button" onclick="Worldview.deleteCurrency(${i})" style="white-space:nowrap;padding:6px 9px;border-radius:7px;border:1px solid var(--border);background:none;color:var(--danger);font-size:11px;cursor:pointer">删除</button>
      </div>
      <textarea rows="2" placeholder="货币说明，如购买力" oninput="Worldview.updateCurrency(${i},'desc',this.value)" style="width:100%">${Utils.escapeHtml(c.desc || '')}</textarea>
    </div>`).join('');
}

async function addCurrency() {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  if (!Array.isArray(w.currencies)) w.currencies = _getCurrencies(w); // 旧数据迁移
  w.currencies.push({ id: 'cur_' + Utils.uuid().slice(0, 8), name: '', desc: '' });
  if ('currency' in w) delete w.currency;
  await _saveEditingWV(w);
  _renderCurrencies(w);
}

async function updateCurrency(idx, field, value) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w || !Array.isArray(w.currencies) || !w.currencies[idx]) return;
  w.currencies[idx][field] = value || '';
  if ('currency' in w) delete w.currency;
  await _saveEditingWV(w);
}

async function deleteCurrency(idx) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w || !Array.isArray(w.currencies)) return;
  w.currencies.splice(idx, 1);
  if ('currency' in w) delete w.currency;
  await _saveEditingWV(w);
  _renderCurrencies(w);
}

// 根据货币一键创建一条全局属性（数值型），方便进游戏后在钱包绑定
async function bindCurrencyToAttr(idx) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w || !Array.isArray(w.currencies) || !w.currencies[idx]) return;
  const cur = w.currencies[idx];
  const name = (cur.name || '').trim();
  if (!name) { UI.showToast('请先填写货币名称', 1800); return; }
  const gp = _ensureGameplay(w);
  if (gp.globalAttrs.some(a => String(a.name || '').trim() === name)) {
    UI.showToast(`全局属性「${name}」已存在`, 1800);
    return;
  }
  const attr = _defaultGameplayAttr();
  attr.name = name;
  attr.desc = (cur.desc || '').trim();
  attr.initial = 0;
  gp.globalAttrs.push(attr);
  await _saveEditingWV(w);
  _renderGameplayAttrs(w);
  UI.showToast(`已创建全局属性「${name}」，进游戏后可在钱包绑定`, 2400);
}

// 供 AI 生成设定后回填货币：追加到 currencies 并重渲染
async function applyGeneratedCurrency(name, desc) {
  if (!editingWorldviewId) return;
  const nm = (name || '').trim();
  if (!nm) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  if (!Array.isArray(w.currencies)) w.currencies = _getCurrencies(w);
  if (!w.currencies.some(c => String(c.name || '').trim() === nm)) {
    w.currencies.push({ id: 'cur_' + Utils.uuid().slice(0, 8), name: nm, desc: (desc || '').trim() });
  }
  if ('currency' in w) delete w.currency;
  await _saveEditingWV(w);
  _renderCurrencies(w);
}

function _renderGameplayAttrs(w) {
  if (!w) return;
  window.__wvEditingCache = w;
  const gp = _ensureGameplay(w);
  const globalEl = document.getElementById('wv-global-attrs-container');
  const charEl = document.getElementById('wv-character-attrs-container');
  if (globalEl) {
    globalEl.innerHTML = `
      <div style="padding:2px 0 10px;background:transparent">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text)">用户 / 全局属性</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">通用于当前世界观玩法，可添加多条。</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button type="button" onclick="Worldview.aiGenerateGlobalAttrs()" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px;white-space:nowrap"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI生成</button>
            <button type="button" onclick="Worldview.addGameplayAttr('global', -1)" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer">+ 添加属性</button>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px">${_renderAttrRows(gp.globalAttrs, 'global', -1)}</div>
      </div>`;
  }
  if (charEl) {
    const cards = gp.characterAttrs.map((c, idx) => {
      // 判断是否显示"继承"按钮：当前角色无属性 且 有其他角色卡片有属性
      const hasAttrs = (c.attrs || []).length > 0;
      const hasOtherWithAttrs = !hasAttrs && gp.characterAttrs.some((x, i) => i !== idx && (x.attrs || []).length > 0);
      const inheritBtn = hasOtherWithAttrs
        ? `<button type="button" onclick="Worldview.inheritCharAttrs(${idx})" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer;white-space:nowrap">继承</button>`
        : '';
      return `
      <div style="padding:2px 0 10px;background:transparent">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
          <div style="min-width:0">
            <div style="font-size:14px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.targetName || '未命名角色')}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.sourceLabel || '')}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            ${inheritBtn}
            <button type="button" onclick="Worldview.addGameplayAttr('character', ${idx})" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer">+ 属性</button>
            <button type="button" onclick="Worldview.deleteGameplayCharacter(${idx})" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--danger);font-size:12px;cursor:pointer">移除</button>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px">${_renderAttrRows(c.attrs || [], 'character', idx)}</div>
      </div>
    `;
    }).join('');
    charEl.innerHTML = `
      <div style="padding:2px 0 10px;background:transparent">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text)">角色属性</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">先选择角色，再为该角色添加多条属性。同一角色不能重复建卡。</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button type="button" onclick="Worldview.aiGenerateCharAttrs()" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px;white-space:nowrap"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI生成</button>
            <button type="button" onclick="Worldview.toggleGameplayCharPicker()" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0">+ 角色</button>
          </div>
        </div>
        <div id="wv-attr-char-picker" class="hidden" style="margin-bottom:12px;border:1px solid var(--border);border-radius:10px;padding:10px;background:var(--bg-secondary)">
          <input id="wv-attr-char-search" placeholder="搜索角色 / 别名 / 世界观" oninput="Worldview.renderGameplayCharPicker(this.value)" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;margin-bottom:8px">
          <div id="wv-attr-char-list" style="max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:6px"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">${cards || '<div style="padding:12px;color:var(--text-secondary);font-size:12px;text-align:center;border:1px dashed var(--border);border-radius:8px">暂无角色属性卡片</div>'}</div>
      </div>`;
  }
  // 渲染任务系统
  _renderTaskSystem(w);
}

// ===== 任务系统编辑器 =====

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

function _getGlobalAttrNames(w) {
  const gp = _ensureGameplay(w);
  return (gp.globalAttrs || []).map(a => a.name).filter(Boolean);
}

function _renderTaskSystem(w) {
  const el = document.getElementById('wv-task-system-container');
  if (!el) return;
  const gp = _ensureGameplay(w);
  const phases = gp.taskSystem.phases;

  if (phases.length === 0) {
    el.innerHTML = `
      <div style="text-align:center;padding:20px;border:1px dashed var(--border);border-radius:8px">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">尚未配置任务阶段</div>
        <button type="button" onclick="Worldview.addTaskPhase()" style="padding:7px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer">+ 添加阶段</button>
      </div>`;
    return;
  }

  let html = '';
  phases.forEach((phase, pi) => {
    // 类型模板卡片（紧凑版，点击打开弹窗编辑）
    const typeCards = (phase.types || []).map((t, ti) => {
      let rewardTag = '';
      if (t.rewardMode === 'attr' && t.rewardAttr) rewardTag = `<span style="font-size:11px;color:var(--accent);background:color-mix(in srgb, var(--accent) 15%, transparent);padding:1px 6px;border-radius:4px">${Utils.escapeHtml(t.rewardAttr)} ${t.rewardValue >= 0 ? '+' : ''}${t.rewardValue || 0}</span>`;
      else if (t.rewardMode === 'free') rewardTag = `<span style="font-size:11px;color:var(--accent);background:color-mix(in srgb, var(--accent) 15%, transparent);padding:1px 6px;border-radius:4px">自由奖励</span>`;
      return `
      <div onclick="Worldview.openTaskTypeModal(${pi},${ti})" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;cursor:pointer">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(t.label || '未命名类型')}</div>
          ${t.desc ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(t.desc)}</div>` : ''}
        </div>
        ${rewardTag}
        <div style="color:var(--text-secondary);font-size:18px;line-height:1;opacity:.65;flex-shrink:0">›</div>
      </div>`;
    }).join('');

    // 阶段完成奖励摘要
    const cr = phase.completionReward || { mode: 'none' };
    let crSummary = '无';
    if (cr.mode === 'attr' && cr.attr) crSummary = `${cr.attr} ${cr.value >= 0 ? '+' : ''}${cr.value || 0}`;
    else if (cr.mode === 'free') crSummary = '自由奖励';

    html += `
    <div style="background:var(--bg-tertiary);padding:12px;border-radius:10px;border:1px solid var(--border);margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
          <div style="font-size:14px;font-weight:700;color:var(--accent);flex-shrink:0">阶段 ${pi + 1}</div>
          <input value="${Utils.escapeHtml(phase.name || '')}" placeholder="阶段名称（可选）" onchange="Worldview.updateTaskPhase(${pi},'name',this.value)" style="flex:1;min-width:0;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:12px">
        </div>
        <button type="button" onclick="Worldview.deleteTaskPhase(${pi})" style="padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--danger);font-size:11px;cursor:pointer;flex-shrink:0">删除</button>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <label style="flex:1;font-size:12px;color:var(--text-secondary)">每批最多
          <input type="number" min="1" max="5" value="${phase.batchSize || 3}" onchange="Worldview.updateTaskPhase(${pi},'batchSize',Number(this.value))" style="width:100%;margin-top:4px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:12px;box-sizing:border-box">
        </label>
        <label style="flex:1;font-size:12px;color:var(--text-secondary)">本阶段总任务数
          <input type="number" min="1" max="999" value="${phase.totalTasks || 10}" onchange="Worldview.updateTaskPhase(${pi},'totalTasks',Number(this.value))" style="width:100%;margin-top:4px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:12px;box-sizing:border-box">
        </label>
      </div>
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">任务类型模板</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">${typeCards || '<div style="padding:10px;color:var(--text-secondary);font-size:12px;text-align:center;border:1px dashed var(--border);border-radius:6px">暂无类型，点击下方添加</div>'}</div>
      <button type="button" id="wv-task-ai-btn-${pi}" onclick="Worldview.aiGenerateTaskPhase(${pi})" style="width:100%;padding:7px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;margin-bottom:6px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成完整阶段配置</button>
      <button type="button" onclick="Worldview.openTaskTypeModal(${pi},-1)" style="width:100%;padding:6px;border-radius:6px;border:1px dashed var(--border);background:none;color:var(--accent);font-size:12px;cursor:pointer;margin-bottom:10px">+ 添加任务类型</button>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:12px;font-weight:600;color:var(--text)">阶段完成奖励：</span>
        <span style="font-size:12px;color:var(--text-secondary)">${Utils.escapeHtml(crSummary)}</span>
        <button type="button" onclick="Worldview.openPhaseRewardModal(${pi})" style="padding:2px 8px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--accent);font-size:11px;cursor:pointer;margin-left:auto">编辑</button>
      </div>
    </div>`;
  });

  html += `<button type="button" onclick="Worldview.addTaskPhase()" style="width:100%;padding:8px;border-radius:8px;border:1px dashed var(--border);background:none;color:var(--accent);font-size:13px;cursor:pointer">+ 添加新阶段</button>`;
  el.innerHTML = html;
}

// ===== 任务类型弹窗 =====
let _ttModalPhaseIdx = -1;
let _ttModalTypeIdx = -1; // -1 = 新建

function openTaskTypeModal(pi, ti) {
  _ttModalPhaseIdx = pi;
  _ttModalTypeIdx = ti;
  const w = window.__wvEditingCache;
  if (!w) return;
  const gp = _ensureGameplay(w);
  const phase = gp.taskSystem.phases[pi];
  if (!phase) return;
  const isNew = ti < 0;
  const t = isNew ? _defaultTaskType() : (phase.types?.[ti] || _defaultTaskType());

  document.getElementById('wv-task-type-modal-title').textContent = isNew ? '新建任务类型' : '编辑任务类型';
  document.getElementById('wv-tt-label').value = t.label || '';
  document.getElementById('wv-tt-desc').value = t.desc || '';
  document.getElementById('wv-tt-reward-mode').value = t.rewardMode || 'none';
  document.getElementById('wv-tt-reward-value').value = t.rewardValue || 0;
  document.getElementById('wv-tt-reward-free').value = t.rewardFree || '';
  document.getElementById('wv-tt-delete-btn').style.display = isNew ? 'none' : '';

  // 填充属性下拉
  const attrSel = document.getElementById('wv-tt-reward-attr');
  const attrNames = _getGlobalAttrNames(w);
  attrSel.innerHTML = `<option value="">选择属性</option>` + attrNames.map(a => `<option value="${Utils.escapeHtml(a)}" ${t.rewardAttr === a ? 'selected' : ''}>${Utils.escapeHtml(a)}</option>`).join('');

  onTaskTypeRewardModeChange();
  document.getElementById('wv-task-type-modal').classList.remove('hidden');
}

function closeTaskTypeModal() {
  document.getElementById('wv-task-type-modal').classList.add('hidden');
}

function onTaskTypeRewardModeChange() {
  const mode = document.getElementById('wv-tt-reward-mode').value;
  const attrRow = document.getElementById('wv-tt-reward-attr-row');
  const freeRow = document.getElementById('wv-tt-reward-free-row');
  attrRow.style.display = mode === 'attr' ? '' : 'none';
  attrRow.classList.toggle('hidden', mode !== 'attr');
  freeRow.style.display = mode === 'free' ? '' : 'none';
  freeRow.classList.toggle('hidden', mode !== 'free');
}

async function saveTaskTypeFromModal() {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const phase = gp.taskSystem.phases[_ttModalPhaseIdx];
  if (!phase) return;
  if (!phase.types) phase.types = [];

  const label = document.getElementById('wv-tt-label').value.trim();
  if (!label) { UI.showToast('请填写类型名称', 1500); return; }
  const mode = document.getElementById('wv-tt-reward-mode').value;

  const data = {
    label,
    desc: document.getElementById('wv-tt-desc').value.trim(),
    rewardMode: mode,
    rewardAttr: mode === 'attr' ? document.getElementById('wv-tt-reward-attr').value : '',
    rewardValue: mode === 'attr' ? Number(document.getElementById('wv-tt-reward-value').value) || 0 : 0,
    rewardFree: mode === 'free' ? document.getElementById('wv-tt-reward-free').value.trim() : ''
  };

  if (_ttModalTypeIdx < 0) {
    data.id = 'tt_' + Utils.uuid().slice(0, 8);
    phase.types.push(data);
  } else {
    const existing = phase.types[_ttModalTypeIdx];
    if (existing) Object.assign(existing, data);
  }

  await DB.put('worldviews', w);
  window.__wvEditingCache = w;
  closeTaskTypeModal();
  _renderTaskSystem(w);
}

async function deleteTaskTypeFromModal() {
  if (!editingWorldviewId || _ttModalTypeIdx < 0) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const phase = gp.taskSystem.phases[_ttModalPhaseIdx];
  if (!phase || !phase.types?.[_ttModalTypeIdx]) return;
  phase.types.splice(_ttModalTypeIdx, 1);
  await DB.put('worldviews', w);
  window.__wvEditingCache = w;
  closeTaskTypeModal();
  _renderTaskSystem(w);
}

// 阶段完成奖励也用弹窗复用任务类型弹窗的思路，但更简单——直接用 confirm 式交互
async function openPhaseRewardModal(pi) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const phase = gp.taskSystem.phases[pi];
  if (!phase) return;
  if (!phase.completionReward) phase.completionReward = { mode: 'none', attr: '', value: 0, free: '' };
  const cr = phase.completionReward;
  const attrNames = _getGlobalAttrNames(w);

  // 复用任务类型弹窗的字段
  _ttModalPhaseIdx = pi;
  _ttModalTypeIdx = -999; // 标记为阶段奖励模式
  document.getElementById('wv-task-type-modal-title').textContent = `阶段 ${pi + 1} 完成奖励`;
  document.getElementById('wv-tt-label').value = '阶段完成奖励';
  document.getElementById('wv-tt-label').disabled = true;
  document.getElementById('wv-tt-desc').value = '';
  document.getElementById('wv-tt-desc').parentElement.style.display = 'none';
  document.getElementById('wv-tt-reward-mode').value = cr.mode || 'none';
  document.getElementById('wv-tt-reward-value').value = cr.value || 0;
  document.getElementById('wv-tt-reward-free').value = cr.free || '';
  document.getElementById('wv-tt-delete-btn').style.display = 'none';
  const attrSel = document.getElementById('wv-tt-reward-attr');
  attrSel.innerHTML = `<option value="">选择属性</option>` + attrNames.map(a => `<option value="${Utils.escapeHtml(a)}" ${cr.attr === a ? 'selected' : ''}>${Utils.escapeHtml(a)}</option>`).join('');
  onTaskTypeRewardModeChange();
  document.getElementById('wv-task-type-modal').classList.remove('hidden');
}

// 覆写保存：检测是阶段奖励模式还是类型模式
const _origSaveTaskTypeFromModal = saveTaskTypeFromModal;
saveTaskTypeFromModal = async function() {
  if (_ttModalTypeIdx === -999) {
    // 阶段奖励模式
    if (!editingWorldviewId) return;
    const w = await DB.get('worldviews', editingWorldviewId);
    if (!w) return;
    const gp = _ensureGameplay(w);
    const phase = gp.taskSystem.phases[_ttModalPhaseIdx];
    if (!phase) return;
    const mode = document.getElementById('wv-tt-reward-mode').value;
    phase.completionReward = {
      mode,
      attr: mode === 'attr' ? document.getElementById('wv-tt-reward-attr').value : '',
      value: mode === 'attr' ? Number(document.getElementById('wv-tt-reward-value').value) || 0 : 0,
      free: mode === 'free' ? document.getElementById('wv-tt-reward-free').value.trim() : ''
    };
    await DB.put('worldviews', w);
    window.__wvEditingCache = w;
    // 恢复弹窗状态
    document.getElementById('wv-tt-label').disabled = false;
    document.getElementById('wv-tt-desc').parentElement.style.display = '';
    closeTaskTypeModal();
    _renderTaskSystem(w);
  } else {
    return _origSaveTaskTypeFromModal();
  }
};

// 关闭时恢复弹窗状态
const _origCloseTaskTypeModal = closeTaskTypeModal;
closeTaskTypeModal = function() {
  document.getElementById('wv-tt-label').disabled = false;
  document.getElementById('wv-tt-desc').parentElement.style.display = '';
  _origCloseTaskTypeModal();
};

async function addTaskPhase() {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  gp.taskSystem.phases.push(_defaultTaskPhase());
  await DB.put('worldviews', w);
  _renderTaskSystem(w);
}

async function deleteTaskPhase(pi) {
  if (!editingWorldviewId) return;
  if (!await UI.showConfirm('删除阶段', `确定删除阶段 ${pi + 1}？`)) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  gp.taskSystem.phases.splice(pi, 1);
  await DB.put('worldviews', w);
  _renderTaskSystem(w);
}

async function updateTaskPhase(pi, field, value) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const phase = gp.taskSystem.phases[pi];
  if (!phase) return;
  if (field === 'batchSize') value = Math.max(1, Math.min(5, value || 3));
  if (field === 'totalTasks') value = Math.max(1, Math.min(999, value || 10));
  phase[field] = value;
  await DB.put('worldviews', w);
}

async function addTaskType(pi) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const phase = gp.taskSystem.phases[pi];
  if (!phase) return;
  if (!phase.types) phase.types = [];
  phase.types.push(_defaultTaskType());
  await DB.put('worldviews', w);
  _renderTaskSystem(w);
}

async function deleteTaskType(pi, ti) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const phase = gp.taskSystem.phases[pi];
  if (!phase || !phase.types) return;
  phase.types.splice(ti, 1);
  await DB.put('worldviews', w);
  _renderTaskSystem(w);
}

async function updateTaskType(pi, ti, field, value) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const phase = gp.taskSystem.phases[pi];
  if (!phase || !phase.types?.[ti]) return;
  phase.types[ti][field] = value;
  // 切换 rewardMode 时清空无关字段
  if (field === 'rewardMode') {
    if (value !== 'attr') { phase.types[ti].rewardAttr = ''; phase.types[ti].rewardValue = 0; }
    if (value !== 'free') { phase.types[ti].rewardFree = ''; }
  }
  await DB.put('worldviews', w);
  if (field === 'rewardMode') _renderTaskSystem(w);
}

async function updateTaskPhaseReward(pi, field, value) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const phase = gp.taskSystem.phases[pi];
  if (!phase) return;
  if (!phase.completionReward) phase.completionReward = { mode: 'none', attr: '', value: 0, free: '' };
  phase.completionReward[field] = value;
  if (field === 'mode') {
    if (value !== 'attr') { phase.completionReward.attr = ''; phase.completionReward.value = 0; }
    if (value !== 'free') { phase.completionReward.free = ''; }
  }
  await DB.put('worldviews', w);
  if (field === 'mode') _renderTaskSystem(w);
}

async function updateGameplayAttr(scope, charIdx, attrIdx, field, value) {
  // 兼容旧内联输入入口；当前 UI 主要通过弹窗保存。
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const list = scope === 'global' ? gp.globalAttrs : (gp.characterAttrs[charIdx]?.attrs || []);
  const attr = list[attrIdx];
  if (!attr) return;
  if (field === 'name') {
    const name = String(value || '').trim();
    if (name && list.some((x, i) => i !== attrIdx && String(x.name || '').trim() === name)) {
      UI.showToast(scope === 'global' ? '全局属性名称不能重复' : '同一角色的属性名称不能重复', 1800);
      return;
    }
  }
  if (field === 'max') attr.max = value === '' ? '' : Number(value);
  else if (field === 'initial') attr.initial = value === '' ? 0 : Number(value);
  else attr[field] = value;
  await _saveEditingWV(w);
}

async function addGameplayAttr(scope, charIdx) {
  await openGameplayAttrModal(scope, charIdx, -1);
}

async function openGameplayAttrModal(scope, charIdx, attrIdx) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const list = scope === 'global' ? gp.globalAttrs : (gp.characterAttrs[charIdx]?.attrs || []);
  const isNew = attrIdx < 0;
  const attr = isNew ? _defaultGameplayAttr() : list[attrIdx];
  if (!attr) return;
  _attrModalCtx = { scope, charIdx, attrIdx, isNew };
  const title = document.getElementById('wv-attr-modal-title');
  if (title) title.textContent = isNew ? (scope === 'global' ? '新增全局属性' : '新增角色属性') : '编辑属性';
  const delBtn = document.getElementById('wv-attr-delete-btn');
  if (delBtn) delBtn.style.visibility = isNew ? 'hidden' : 'visible';
  const nameEl = document.getElementById('wv-attr-name'); if (nameEl) nameEl.value = attr.name || '';
  const initEl = document.getElementById('wv-attr-initial'); if (initEl) initEl.value = attr.initial ?? 0;
  const maxEl = document.getElementById('wv-attr-max'); if (maxEl) maxEl.value = attr.max ?? '';
  const descEl = document.getElementById('wv-attr-desc'); if (descEl) descEl.value = attr.desc || '';
  // 溢出进位目标下拉：同作用域其它属性（排除自己）
  const ovEl = document.getElementById('wv-attr-overflow');
  if (ovEl) {
    const opts = ['<option value="">不进位</option>'];
    list.forEach((x, i) => {
      if (i === attrIdx) return; // 排除自己
      if (!x || !x.id || !(x.name || '').trim()) return;
      const sel = attr.overflowTo === x.id ? ' selected' : '';
      opts.push(`<option value="${Utils.escapeHtml(x.id)}"${sel}>${Utils.escapeHtml(x.name)}</option>`);
    });
    ovEl.innerHTML = opts.join('');
    ovEl.value = attr.overflowTo || '';
  }
  // 派生目标下拉：同作用域其它属性（排除自己）
  const dvEl = document.getElementById('wv-attr-derive');
  if (dvEl) {
    const opts = ['<option value="">不派生</option>'];
    list.forEach((x, i) => {
      if (i === attrIdx) return;
      if (!x || !x.id || !(x.name || '').trim()) return;
      const sel = attr.deriveTo === x.id ? ' selected' : '';
      opts.push(`<option value="${Utils.escapeHtml(x.id)}"${sel}>${Utils.escapeHtml(x.name)}</option>`);
    });
    dvEl.innerHTML = opts.join('');
    dvEl.value = attr.deriveTo || '';
  }
  const dvStepEl = document.getElementById('wv-attr-derive-step');
  if (dvStepEl) dvStepEl.value = attr.deriveStep ?? '';
  // 进位/派生互斥联动
  const _wvAttrSyncExclusive = () => {
    const ovOn = !!(ovEl && ovEl.value);
    const dvOn = !!(dvEl && dvEl.value);
    if (ovEl) ovEl.disabled = dvOn;
    if (dvEl) dvEl.disabled = ovOn;
    if (dvStepEl) dvStepEl.disabled = ovOn || !dvOn;
  };
  if (ovEl) ovEl.onchange = _wvAttrSyncExclusive;
  if (dvEl) dvEl.onchange = _wvAttrSyncExclusive;
  _wvAttrSyncExclusive();
  document.getElementById('wv-attr-modal')?.classList.remove('hidden');
  setTimeout(() => nameEl?.focus(), 80);
}

function closeGameplayAttrModal() {
  _attrModalCtx = null;
  document.getElementById('wv-attr-modal')?.classList.add('hidden');
}

async function saveGameplayAttrFromModal() {
  if (!_attrModalCtx || !editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const list = _attrModalCtx.scope === 'global' ? gp.globalAttrs : (gp.characterAttrs[_attrModalCtx.charIdx]?.attrs || []);
  const name = (document.getElementById('wv-attr-name')?.value || '').trim();
  if (!name) { UI.showToast('请填写属性名称', 1800); return; }
  if (list.some((x, i) => i !== _attrModalCtx.attrIdx && String(x.name || '').trim() === name)) {
    UI.showToast(_attrModalCtx.scope === 'global' ? '全局属性名称不能重复' : '同一角色的属性名称不能重复', 1800);
    return;
  }
  const attr = _attrModalCtx.isNew ? _defaultGameplayAttr() : list[_attrModalCtx.attrIdx];
  if (!attr) return;
  attr.name = name;
  attr.desc = document.getElementById('wv-attr-desc')?.value || '';
  const maxVal = document.getElementById('wv-attr-max')?.value || '';
  const initVal = document.getElementById('wv-attr-initial')?.value || '';
  attr.max = maxVal === '' ? '' : Number(maxVal);
  attr.initial = initVal === '' ? 0 : Number(initVal);
  attr.overflowTo = document.getElementById('wv-attr-overflow')?.value || '';
  attr.deriveTo = document.getElementById('wv-attr-derive')?.value || '';
  const dStep = document.getElementById('wv-attr-derive-step')?.value || '';
  attr.deriveStep = attr.deriveTo ? (dStep === '' ? 100 : Number(dStep)) : '';
  // 互斥兜底：二选一，派生优先清进位
  if (attr.deriveTo) attr.overflowTo = '';
  if (_attrModalCtx.isNew) list.push(attr);
  await _saveEditingWV(w);
  window.__wvEditingCache = w;
  closeGameplayAttrModal();
  _renderGameplayAttrs(w);
}

async function deleteGameplayAttr(scope, charIdx, attrIdx) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const list = scope === 'global' ? gp.globalAttrs : (gp.characterAttrs[charIdx]?.attrs || []);
  list.splice(attrIdx, 1);
  await _saveEditingWV(w);
  _renderGameplayAttrs(w);
}

async function deleteGameplayAttrFromModal() {
  if (!_attrModalCtx || _attrModalCtx.isNew) return;
  await deleteGameplayAttr(_attrModalCtx.scope, _attrModalCtx.charIdx, _attrModalCtx.attrIdx);
  closeGameplayAttrModal();
}

async function deleteGameplayCharacter(idx) {
  if (!editingWorldviewId) return;
  const ok = await UI.showConfirm('移除角色属性', '只会移除此角色的属性配置，不会删除角色本身。确定移除吗？');
  if (!ok) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  gp.characterAttrs.splice(idx, 1);
  await _saveEditingWV(w);
  _renderGameplayAttrs(w);
}

async function inheritCharAttrs(idx) {
  if (!editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const card = gp.characterAttrs[idx];
  if (!card) return;
  // 找最近一个有属性的其他角色卡片（优先往前找，找不到往后找）
  let source = null;
  for (let i = idx - 1; i >= 0; i--) {
    if ((gp.characterAttrs[i]?.attrs || []).length > 0) { source = gp.characterAttrs[i]; break; }
  }
  if (!source) {
    for (let i = idx + 1; i < gp.characterAttrs.length; i++) {
      if ((gp.characterAttrs[i]?.attrs || []).length > 0) { source = gp.characterAttrs[i]; break; }
    }
  }
  if (!source || !source.attrs || source.attrs.length === 0) {
    UI.showToast('没有可继承的角色属性', 1800);
    return;
  }
  // 深拷贝属性，id 重新生成
  card.attrs = source.attrs.map(a => ({
    ...JSON.parse(JSON.stringify(a)),
    id: 'attr_' + Utils.uuid().slice(0, 8)
  }));
  await _saveEditingWV(w);
  _renderGameplayAttrs(w);
  UI.showToast(`已继承「${source.targetName || '角色'}」的 ${card.attrs.length} 条属性`, 2000);
}

async function toggleGameplayCharPicker() {
  const box = document.getElementById('wv-attr-char-picker');
  if (!box) return;
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) {
    const input = document.getElementById('wv-attr-char-search');
    if (input) input.value = '';
    await renderGameplayCharPicker('');
    setTimeout(() => input?.focus(), 50);
  }
}

async function _collectGameplayCharacters() {
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

async function renderGameplayCharPicker(query = '') {
  const listEl = document.getElementById('wv-attr-char-list');
  if (!listEl) return;
  const q = String(query || '').toLowerCase().trim();
  const chars = await _collectGameplayCharacters();
  const filtered = q ? chars.filter(c => [c.targetName, c.aliases, c.sourceLabel].some(v => String(v || '').toLowerCase().includes(q))) : chars;
  if (!filtered.length) {
    listEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-secondary);font-size:12px">${q ? '没有匹配的角色' : '暂无可选角色'}</div>`;
    return;
  }
  listEl.innerHTML = filtered.map((c, i) => `
    <div onclick="Worldview.selectGameplayCharacter(${i})" style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);cursor:pointer">
      <div style="width:34px;height:34px;border-radius:50%;overflow:hidden;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0">${c.avatar ? `<img src="${Utils.escapeHtml(c.avatar)}" style="width:100%;height:100%;object-fit:cover">` : Utils.escapeHtml((c.targetName || '?').slice(0,1))}</div>
      <div style="min-width:0;flex:1">
        <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.targetName || '未命名')}${c.aliases ? `<span style="font-size:11px;color:var(--text-secondary)"> · ${Utils.escapeHtml(c.aliases)}</span>` : ''}</div>
        <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.sourceLabel || '')}</div>
      </div>
    </div>
  `).join('');
  window.__wvAttrCharPickerCache = filtered;
}

async function selectGameplayCharacter(idx) {
  const c = (window.__wvAttrCharPickerCache || [])[idx];
  if (!c || !editingWorldviewId) return;
  const w = await DB.get('worldviews', editingWorldviewId);
  if (!w) return;
  const gp = _ensureGameplay(w);
  const key = _attrTargetKey({ targetType: c.targetType, targetId: c.targetId, sourceWorldviewId: c.sourceWorldviewId });
  if (gp.characterAttrs.some(x => _attrTargetKey(x) === key)) {
    UI.showToast('这个角色已经有属性卡片了', 2000);
    return;
  }
  gp.characterAttrs.push({ targetType: c.targetType, targetId: c.targetId, targetName: c.targetName, sourceWorldviewId: c.sourceWorldviewId || '', sourceLabel: c.sourceLabel || '', attrs: [] });
  await _saveEditingWV(w);
  _renderGameplayAttrs(w);
}

let _globalNpcsCache = [];   // 渲染缓存（只用于显示）

function _renderGlobalNpcs(list) {
_globalNpcsCache = list || [];
// v632：basic tab 容器（世界观用）+ special tab 容器（世界书用），两者并存，填同一份数据
const containers = [
  document.getElementById('wv-global-npcs-container'),
  document.getElementById('wv-ext-global-npcs-container'),
].filter(Boolean);
if (containers.length === 0) return;
let html;
if (_globalNpcsCache.length === 0) {
  html = `<div style="text-align:center;color:var(--text-secondary);font-size:12px;padding:14px 0;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px">还没有常驻角色</div>`;
} else {
  html = _globalNpcsCache.map((n, i) => `
    <div onclick="Worldview.editGlobalNpc(${i})" style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer">
      <div style="display:flex;align-items:center;gap:6px;font-size:14px;color:var(--text)">
        <span style="font-weight:600">${Utils.escapeHtml(n.name || '未命名')}</span>
        ${n.aliases ? `<span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(n.aliases)}</span>` : ''}
      </div>
      ${n.summary ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(n.summary)}</div>` : ''}
    </div>
  `).join('');
}
containers.forEach(c => { c.innerHTML = html; });
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

// ---------- v682：批量导入 NPC ----------
// 入口（HTML 按钮调用）：
//   Worldview.openNpcImporter('global')  → 当前世界观/世界书的 globalNpcs
//   Worldview.openNpcImporter('faction') → 当前编辑的势力 npcs（依赖 _editRegionIdx / _editFactionIdx）
function openNpcImporter(target) {
  if (typeof NpcImporter === 'undefined') {
    UI.showToast('批量导入模块未加载', 2200);
    return;
  }
  // faction 模式必须已经选定地区/势力
  if (target === 'faction' && (_editRegionIdx < 0 || _editFactionIdx < 0)) {
    UI.showToast('请先打开一个势力的编辑界面', 2200);
    return;
  }
  NpcImporter.openImporter({
    target,
    onDone: async () => {
      const w = await _getEditingWV();
      if (!w) return;
      if (target === 'faction') {
        const fac = w.regions?.[_editRegionIdx]?.factions?.[_editFactionIdx];
        if (fac) _renderNPCCards(fac.npcs || []);
      } else {
        _renderGlobalNpcs(w.globalNpcs || []);
      }
    }
  });
}

// 内部钩子（供 NpcImporter 用）
async function _bulkImportNpcs(npcs, target) {
  if (!Array.isArray(npcs) || npcs.length === 0) return 0;
  const w = await _getEditingWV();
  if (!w) throw new Error('当前没有编辑中的世界观/世界书');

  if (target === 'faction') {
    if (_editRegionIdx < 0 || _editFactionIdx < 0) {
      throw new Error('请先打开势力编辑界面');
    }
    const fac = w.regions?.[_editRegionIdx]?.factions?.[_editFactionIdx];
    if (!fac) throw new Error('找不到目标势力');
    fac.npcs = fac.npcs || [];
    npcs.forEach(n => fac.npcs.push(n));
  } else {
    w.globalNpcs = w.globalNpcs || [];
    npcs.forEach(n => w.globalNpcs.push(n));
  }
  await _saveEditingWV(w);
  return npcs.length;
}

function _getEditingWVForImporter() { return _getEditingWV(); }
function _editingRegionIdxForImporter() { return _editRegionIdx; }
function _editingFactionIdxForImporter() { return _editFactionIdx; }

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
    // v687.41j：老数据迁移——profession 字段合进 detail 头部
    if (npc.profession && npc.profession.trim()) {
      const prof = npc.profession.trim();
      const cur = (npc.detail || '').trim();
      const profLine = `**职业**：${prof}`;
      if (!cur.includes(profLine)) {
        npc.detail = cur ? profLine + '\n\n' + cur : profLine;
      }
      delete npc.profession;
    }
    document.getElementById('wv-npc-name').value = npc.name || '';
    document.getElementById('wv-npc-aliases').value = npc.aliases || '';
    const wvNpcOnline2 = document.getElementById('wv-npc-onlinename');
    if (wvNpcOnline2) wvNpcOnline2.value = npc.onlineName || '';
    document.getElementById('wv-npc-summary').value = npc.summary || '';
    document.getElementById('wv-npc-detail').value = npc.detail || '';
    const sumLbl = document.getElementById('wv-npc-summary-label');
    if (sumLbl) sumLbl.style.display = 'none';

    UI.showPanel('wv-npc', 'forward');
    requestAnimationFrame(_attachWVNpcAutoSave);
    _refreshEditingNpcAvatar();
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
  // 从节日 date 文本解析出可排序数值（年*10000+月*100+日）。无法解析的返回 Infinity（排末尾）
  function _festSortKey(dateStr) {
    const s = String(dateStr || '').trim();
    if (!s) return Infinity;
    // 年（可选）：YYYY年 / YYYY-
    let year = 0;
    const ym = s.match(/(\d{1,4})\s*年/);
    if (ym) year = parseInt(ym[1], 10) || 0;
    // 月日：支持 "4月15日"、"4-15"、"4/15"、"4.15"
    let mo = 0, day = 0;
    let m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})/);
    if (m) { mo = parseInt(m[1], 10); day = parseInt(m[2], 10); }
    else {
      m = s.match(/(\d{1,2})\s*[-\/.]\s*(\d{1,2})/);
      if (m) { mo = parseInt(m[1], 10); day = parseInt(m[2], 10); }
      else {
        // 只有月份
        const mo2 = s.match(/(\d{1,2})\s*月/);
        if (mo2) mo = parseInt(mo2[1], 10);
      }
    }
    if (!mo) return Infinity; // 解析不出月份，排末尾
    return year * 10000 + mo * 100 + day;
  }

  function _renderFestivals(festivals) {
    festivalsData = festivals || [];
    // 按日期顺序排序（无法解析日期的排在最后，保持稳定）
    festivalsData.sort((a, b) => {
      const ka = _festSortKey(a && a.date);
      const kb = _festSortKey(b && b.date);
      return ka - kb;
    });
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
    _wvExtAutoSave();
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
    document.getElementById('wv-fest-modal-keys').value = f.keys || '';
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
      content: document.getElementById('wv-fest-modal-content').value.trim(),
      keys: document.getElementById('wv-fest-modal-keys').value.trim()
    };
    _renderFestivals(festivalsData);
    closeFestivalModal();
    _wvExtAutoSave();
  }
  async function deleteFestivalFromModal() {
  if (_editFestivalIdx === null) return;
  const nm = (festivalsData[_editFestivalIdx]?.name || '该节日');
  if (!await UI.showConfirm('删除节日', `确定删除「${nm}」？此操作不可撤销。`)) return;
  festivalsData.splice(_editFestivalIdx, 1);
  _renderFestivals(festivalsData);
  closeFestivalModal();
  _wvExtAutoSave();
}
  function closeFestivalModal() {
    _editFestivalIdx = null;
    document.getElementById('wv-festival-modal').classList.add('hidden');
  }

  // ===== AI 批量生成节日 =====
  let _aiFestAbort = null;

  // AI 生成节日：弹窗收集需求 + 数量，再调 AI 生成节日数组追加进列表
  async function aiGenFestivals() {
    const w = window.__wvEditingCache;
    if (!w) { UI.showToast('请先打开世界观编辑', 1500); return; }
    const html = `
    <div id="ai-fest-gen-overlay" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-fest-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成节日</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-fest-gen-prompt" rows="3" placeholder="例如：多生成几个跟农耕和丰收有关的节日" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:12px;margin-top:12px">
          <div style="flex:1">
            <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成数量</label>
            <input type="number" id="ai-fest-gen-count" value="3" min="1" max="10" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box">
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">根据世界观设定与历法生成扎根本世界的节日，追加进列表（不覆盖已有节日）。</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-fest-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-fest-gen-btn" onclick="Worldview._doAiGenFestivals()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-fest-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  const _AI_FEST_SYS = `你是一个为虚构世界观设计节日的文化设定师。请根据世界观设定，设计符合其文明、历史、信仰、社会结构的节日。

设计要求：
- 节日要扎根世界观本身：从它的历史事件、神明信仰、自然现象、生产周期、政治制度、重要人物、地域文化里生长出来。不要套用现实世界的节日（春节、圣诞节等），除非世界观本身就是现实背景。
- 每个节日的来历、习俗、氛围各不相同，彼此不雷同。
- 不要与「已有节日」重复（名称、日期、主题都要避开）。

每个节日的 content（详情，250-350字）必须涵盖：
1. 流行范围：属于哪个地区 / 哪一类人会过这个节日。
2. 来历：从哪里来，为了纪念什么。
3. 习俗传统：节日这天会做什么、如何庆祝。
4. 假期：有没有假期，放几天。

输出格式：
严格输出 JSON 数组，不要用 \`\`\`json 包裹，不要输出任何 JSON 以外的内容。
每个节日对象包含：
- name（string）：节日名称
- date（string）：日期，格式「X月X日」（如「3月15日」）
- keys（string）：触发关键词，2-5 个，用中文逗号分隔，是聊天时可能提到这个节日的词（别名、相关习俗、标志物等）
- content（string）：节日详情，250-350字，涵盖上述四点`;

  async function _doAiGenFestivals() {
    const overlay = document.getElementById('ai-fest-gen-overlay');
    const btn = document.getElementById('ai-fest-gen-btn');
    const status = document.getElementById('ai-fest-gen-status');
    const prompt = document.getElementById('ai-fest-gen-prompt')?.value?.trim() || '';
    const count = Math.max(1, Math.min(10, parseInt(document.getElementById('ai-fest-gen-count')?.value) || 3));

    const w = window.__wvEditingCache;
    if (!w) { UI.showToast('请先打开世界观编辑', 1500); return; }

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = `正在生成 ${count} 个节日…`; }

    // 1. 通用资料：世界书模式只发世界书自己的资料；世界观模式发完整上下文
    let baseCtx;
    if (isHiddenWv(w)) {
      // 世界书：description + 知识条目 + 常驻 NPC
      const parts = [];
      if (w.description) parts.push(`## 世界书简介\n${w.description}`);
      const ks = (w.knowledges || []).filter(k => k && k.content);
      if (ks.length) parts.push(`## 世界书条目\n${ks.map(k => `### ${k.name || '未命名'}\n${k.content}`).join('\n\n')}`);
      const npcs = (w.globalNpcs || []).filter(n => n && n.name);
      if (npcs.length) parts.push(`## 角色\n${npcs.map(n => `- ${n.name}${n.summary ? '：' + n.summary : ''}`).join('\n')}`);
      baseCtx = parts.length ? parts.join('\n\n') : '## 世界书\n（暂无资料，请根据节日设计常识自由发挥）';
    } else {
      const settingText = document.getElementById('wv-setting')?.value?.trim() || w.setting || '';
      baseCtx = (typeof WvGenerator !== 'undefined' && WvGenerator._buildWorldContext)
        ? WvGenerator._buildWorldContext(w, '', settingText)
        : `## 世界观设定\n${settingText || '（未提供）'}`;
    }
    // 2. 已有节日（防重复）
    const existing = (festivalsData || []).map(f => `${f.name || ''}（${f.date || ''}）`).filter(s => s !== '（）');
    const existingBlock = existing.length ? `## 已有节日（不要重复名称、日期、主题）\n${existing.join('、')}\n\n` : '';
    // 3. 用户要求 + 数量
    const userMsg = `${prompt ? '## 用户额外要求\n' + prompt + '\n\n' : ''}${baseCtx}\n\n${existingBlock}请生成 ${count} 个节日，严格按要求输出 JSON 数组。`;

    try {
      _aiFestAbort = new AbortController();
      const raw = await API.generate(_AI_FEST_SYS, userMsg, { signal: _aiFestAbort.signal, maxTokens: 8000 });
      let cleaned = (raw || '').trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      // 抓第一个 [ 到最后一个 ]
      const fa = cleaned.indexOf('[');
      const la = cleaned.lastIndexOf(']');
      if (fa !== -1 && la > fa) cleaned = cleaned.substring(fa, la + 1);
      const parsed = JSON.parse(cleaned);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.festivals) ? parsed.festivals : []);
      if (!arr.length) throw new Error('AI 未返回有效节日');

      let added = 0;
      for (const f of arr) {
        if (!f || !f.name) continue;
        festivalsData.push({
          id: 'fest_' + Utils.uuid().slice(0, 8),
          name: String(f.name).trim(),
          date: String(f.date || '').trim(),
          yearly: true,
          enabled: true,
          content: String(f.content || '').trim(),
          keys: String(f.keys || '').trim()
        });
        added++;
      }
      _renderFestivals(festivalsData);
      _wvExtAutoSave();
      overlay?.remove();
      UI.showToast(`已生成 ${added} 个节日`, 2000);
    } catch (e) {
      if (e.name === 'AbortError') { overlay?.remove(); return; }
      console.error('[Worldview] AI 生成节日失败', e);
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiFestAbort = null;
    }
  }

  // ===== AI 生成动态知识条目（keywordTrigger=true，围绕世界观自由发挥）=====
  let _aiKnowAbort = null;

  async function aiGenKnowledges() {
    const w = window.__wvEditingCache;
    if (!w) { UI.showToast('请先打开世界观编辑', 1500); return; }
    const html = `
    <div id="ai-know-gen-overlay" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-know-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成动态条目</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-know-gen-prompt" rows="3" placeholder="例如：多写点经济、货币、物价、交通出行方面的背景设定" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:12px;margin-top:12px">
          <div style="flex:1">
            <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成数量</label>
            <input type="number" id="ai-know-gen-count" value="3" min="1" max="10" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box">
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">生成围绕本世界观的背景设定（成套的体系如经济/教育，或点状的细节如物产/黑话），带触发关键词，命中时自动注入。追加进列表（不覆盖已有）。</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-know-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-know-gen-btn" onclick="Worldview._doAiGenKnowledges()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-know-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  const _AI_KNOW_SYS = `你是一个为虚构世界观补充背景设定的世界构建师。请设计若干条「动态知识条目」——它们是这个世界的背景设定，平时不占用提示词，只有当聊天中提到相关内容时才会被自动注入给 AI 参考。

条目可以是两种粒度，按世界观需要自由搭配（默认以体系为主、细节点缀）：
1. **体系**：成套地讲清这个世界某一整个方面。比如「经济体系」把货币、物价、贸易、职业收入、贫富结构一并讲清；「教育体系」把求学阶段、门槛、师承、晋升路径一并讲清。一条 = 一个自成系统的板块，信息密度高。
2. **细节**：一个具体而点状的设定。比如某种货币的兑换规矩、某条商路的门道、某种特色饮食、某个行当的黑话。轻、具体，用来补世界的血肉和质感。

设计方向（放开选，但必须紧扣这个世界观本身）：
体系类——经济、教育、军事/武力、政治与权力、律法与刑罚、修炼/能力/等级、金融、交通地理、通讯、宗教信仰、社会阶层、科技/工业、医疗、婚姻家族、语言文字等；
细节类——具体的物产、习俗、行当、地名典故、日常生活片段、圈内黑话等。
挑那些"平时不用讲、但聊到就得对得上"的内容来写。

要求：
- 每一条都要从这个世界观里生长出来，跟它的题材、设定、已有内容自洽，不要套用与本世界观无关的现实设定（除非世界观本身就是现实背景）。
- 体系类成体系地写透，细节类写具体写实；条目之间不重叠。
- 不要与「已有条目」重复（主题、名称都要避开）。

输出格式：
严格输出 JSON 数组，不要用 \`\`\`json 包裹，不要输出任何 JSON 以外的内容。
每个条目对象包含：
- name（string）：条目名称（体系如"灵石经济体系"，细节如"坊市黑话"）
- keys（string）：触发关键词，2-6 个，用中文逗号分隔，是聊天时真的会冒出来、应该命中这条的词（关键概念、物名、场景词等）
- content（string）：具体内容——体系类 250-500字成体系写清，细节类 150-300字写具体，都要落到这个世界里到底是怎样的`;

  async function _doAiGenKnowledges() {
    const overlay = document.getElementById('ai-know-gen-overlay');
    const btn = document.getElementById('ai-know-gen-btn');
    const status = document.getElementById('ai-know-gen-status');
    const prompt = document.getElementById('ai-know-gen-prompt')?.value?.trim() || '';
    const count = Math.max(1, Math.min(10, parseInt(document.getElementById('ai-know-gen-count')?.value) || 3));

    const w = window.__wvEditingCache;
    if (!w) { UI.showToast('请先打开世界观编辑', 1500); return; }

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = `正在生成 ${count} 条动态条目…`; }

    // 1. 上下文：世界书模式只发世界书自己的资料（无世界观设定）；世界观模式发完整上下文
    let baseCtx;
    if (isHiddenWv(w)) {
      const parts = [];
      if (w.description) parts.push(`## 世界书简介\n${w.description}`);
      const ks = (w.knowledges || []).filter(k => k && k.content);
      if (ks.length) parts.push(`## 世界书已有条目\n${ks.map(k => `### ${k.name || '未命名'}\n${k.content}`).join('\n\n')}`);
      const npcs = (w.globalNpcs || []).filter(n => n && n.name);
      if (npcs.length) parts.push(`## 角色\n${npcs.map(n => `- ${n.name}${n.summary ? '：' + n.summary : ''}`).join('\n')}`);
      baseCtx = parts.length ? parts.join('\n\n') : '## 世界书\n（这是一本独立世界书，暂无世界观设定。请紧扣下面用户需求和已有条目来补充，不要脱离这本世界书已经确立的调性。）';
    } else {
      const settingText = document.getElementById('wv-setting')?.value?.trim() || w.setting || '';
      baseCtx = (typeof WvGenerator !== 'undefined' && WvGenerator._buildWorldContext)
        ? WvGenerator._buildWorldContext(w, '', settingText)
        : `## 世界观设定\n${settingText || '（未提供）'}`;
    }
    // 2. 已有动态条目（防重复）
    const existing = (knowledgesData || []).filter(k => k && k.name).map(k => k.name);
    const existingBlock = existing.length ? `## 已有条目（不要重复名称、主题）\n${existing.join('、')}\n\n` : '';
    // 3. 用户要求 + 数量
    const userMsg = `${prompt ? '## 用户额外要求\n' + prompt + '\n\n' : ''}${baseCtx}\n\n${existingBlock}请生成 ${count} 条动态知识条目，严格按要求输出 JSON 数组。`;

    try {
      _aiKnowAbort = new AbortController();
      const raw = await API.generate(_AI_KNOW_SYS, userMsg, { signal: _aiKnowAbort.signal, maxTokens: 8000 });
      let cleaned = (raw || '').trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const fa = cleaned.indexOf('[');
      const la = cleaned.lastIndexOf(']');
      if (fa !== -1 && la > fa) cleaned = cleaned.substring(fa, la + 1);
      const parsed = JSON.parse(cleaned);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.knowledges) ? parsed.knowledges : []);
      if (!arr.length) throw new Error('AI 未返回有效条目');

      const existSet = new Set(existing.map(n => String(n).toLowerCase()));
      let added = 0;
      for (const k of arr) {
        if (!k || !k.name) continue;
        const nm = String(k.name).trim();
        if (!nm || existSet.has(nm.toLowerCase())) continue;
        knowledgesData.push({
          id: 'know_' + Utils.uuid().slice(0, 8),
          name: nm,
          keys: String(k.keys || '').trim(),
          content: String(k.content || '').trim(),
          enabled: true,
          keywordTrigger: true,
          position: 'system_top',
          depth: 0
        });
        existSet.add(nm.toLowerCase());
        added++;
      }
      if (added === 0) throw new Error('生成的条目都与已有条目重名');
      _renderKnowledges(knowledgesData);
      _wvExtAutoSave();
      overlay?.remove();
      UI.showToast(`已生成 ${added} 条动态条目`, 2000);
    } catch (e) {
      if (e.name === 'AbortError') { overlay?.remove(); return; }
      console.error('[Worldview] AI 生成动态条目失败', e);
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiKnowAbort = null;
    }
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
    _wvExtAutoSave();
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

  // 从文档导入常驻条目（txt/md/json/docx/pdf）：按空行分段，每段一条常驻知识
  async function importCustomsFromDoc() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.md,.json,.docx,.pdf';
    input.onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      let text = '';
      try {
        UI.showToast('正在解析文档...', 1500);
        text = await Utils.readFileAsText(file);
      } catch (err) {
        UI.showToast('解析失败：' + (err && err.message ? err.message : '无法读取该文档'), 3000);
        return;
      }
      text = String(text || '').replace(/\r\n/g, '\n').trim();
      if (!text) { UI.showToast('文档中没有可导入的文本', 2500); return; }
      // 按分隔线（单独一行的 --- / === / ***，至少3个）分段
      let segs = [];
      { const _lines = text.split('\n'); let _buf = [];
        const _SEP = /^[ \t]*[-=*]{3,}[ \t]*$/;
        for (const _ln of _lines) {
          if (_SEP.test(_ln)) { const _s = _buf.join('\n').trim(); if (_s) segs.push(_s); _buf = []; }
          else { _buf.push(_ln); }
        }
        const _sLast = _buf.join('\n').trim(); if (_sLast) segs.push(_sLast);
      }
      if (segs.length === 0) segs = [text];
      const CAP = 100;
      const docName = (file.name || '文档').replace(/\.[^.]+$/, '');
      const _doImport = (list) => {
        for (const seg of list) {
          const firstLine = seg.split('\n')[0].trim();
          const name = (firstLine.slice(0, 20) || docName) + (firstLine.length > 20 ? '...' : '');
          const item = _defaultCustom();
          item.name = name;
          item.content = seg;
          item.enabled = true;
          item.keywordTrigger = false;
          item.position = 'system_top';
          item.depth = 0;
          customsData.push(item);
        }
        _renderCustoms(customsData);
        _wvExtAutoSave();
        UI.showToast('已导入 ' + list.length + ' 条常驻条目', 2500);
      };
      if (segs.length > CAP) {
        const ok1 = await UI.showConfirm('导入文档', `从《${docName}》解析出 ${segs.length} 段，超过建议上限 ${CAP} 段。常驻条目每轮都会全量注入，过多会占用大量上下文。\n是否只导入前 ${CAP} 段？（推荐）`);
        if (ok1) { _doImport(segs.slice(0, CAP)); return; }
        const ok2 = await UI.showConfirm('全部导入？', `确定要把全部 ${segs.length} 段都导入吗？内容很多时会明显占用上下文并增加消耗，建议导入后逐条改为「动态（关键词触发）」。`);
        if (ok2) _doImport(segs);
      } else {
        const ok = await UI.showConfirm('导入文档', `从《${docName}》解析出 ${segs.length} 段，将作为常驻知识条目导入。\n\n分段规则：用单独一行的分隔线（--- 或 === 或 ***，至少3个符号）来分隔条目，分隔线之间的内容为一条。若整篇没有分隔线，则作为一条导入。\n\n提示：常驻条目每轮都会注入，内容较多时可在编辑后逐条改为「动态（关键词触发）」以节省上下文。\n确定导入吗？`);
        if (ok) _doImport(segs);
      }
    };
    input.click();
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
    _wvExtAutoSave();
  }
  async function deleteCustomFromModal() {
  if (_editCustomIdx === null) return;
  const nm = (customsData[_editCustomIdx]?.name || '该条目');
  if (!await UI.showConfirm('删除常驻条目', `确定删除「${nm}」？此操作不可撤销。`)) return;
  customsData.splice(_editCustomIdx, 1);
  _renderCustoms(customsData);
  closeCustomModal();
  _wvExtAutoSave();
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
    _wvExtAutoSave();
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
    _wvExtAutoSave();
  }
  async function deleteKnowledgeFromModal() {
  if (_editKnowledgeIdx === null) return;
  const nm = (knowledgesData[_editKnowledgeIdx]?.name || '该条目');
  if (!await UI.showConfirm('删除动态条目', `确定删除「${nm}」？此操作不可撤销。`)) return;
  knowledgesData.splice(_editKnowledgeIdx, 1);
  _renderKnowledges(knowledgesData);
  closeKnowledgeModal();
  _wvExtAutoSave();
}
function closeKnowledgeModal() {
    _editKnowledgeIdx = null;
    document.getElementById('wv-knowledge-modal').classList.add('hidden');
  }

  // ---------- 事件设定（关键词 / 数值触发 → 持续注入 → 结束关键词关闭） ----------
  let eventsData = [];
  let _wvEventTab = 'standalone';
  let _eventAttrConditionsDraft = [];
  function _collectEventAttrOptions() {
    const opts = [];
    const w = window.__wvEditingCache || null;
    const gp = w?.gameplay || {};
    const seenAllCharNames = new Set();
    (gp.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim()).forEach(a => {
      opts.push({ value: `global|||${a.id}`, scope: 'global', targetKey: '', targetName: '', attrId: a.id, attrName: a.name, label: `全局 / ${a.name}` });
    });
    (gp.characterAttrs || []).forEach(c => {
      const key = _attrTargetKey(c);
      (c.attrs || []).filter(a => a && a.id && (a.name || '').trim()).forEach(a => {
        opts.push({ value: `character||${key}||${a.id}`, scope: 'character', targetKey: key, targetName: c.targetName || '', attrId: a.id, attrName: a.name, label: `${c.targetName || '未命名角色'} / ${a.name}` });
        const nm = (a.name || '').trim();
        if (nm && !seenAllCharNames.has(nm)) {
          seenAllCharNames.add(nm);
          opts.push({ value: `allCharacters|||${nm}`, scope: 'allCharacters', targetKey: '', targetName: '', attrId: '', attrName: nm, label: `所有角色 / ${nm}` });
        }
      });
    });
    return opts;
  }
  function _eventAttrConditionSummary(ev) {
    const conds = Array.isArray(ev.attrConditions) ? ev.attrConditions : [];
    if ((ev.triggerType || 'keyword') !== 'attr') return null;
    if (!conds.length) return '<span style="font-size:11px;color:var(--danger)">未设置数值条件</span>';
    return conds.map(c => {
      const prefix = c.scope === 'allCharacters' ? `所有角色(${c.matchMode === 'any' ? '任一' : '全部'}) / ` : (c.targetName ? c.targetName + ' / ' : '全局 / ');
      return `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${Utils.escapeHtml(`${prefix}${c.attrName || '属性'} ${c.operator || '>='} ${c.value ?? 0}`)}</span>`;
    }).join('');
  }
  function _renderEvents(list) {
    eventsData = list || [];
    const container = document.getElementById('wv-events-container');
    if (!container) return;
    const oldEmpty = document.getElementById('wv-events-empty');
    if (oldEmpty) oldEmpty.remove();

    if (_wvEventTab === 'chain') {
      const chainEvents = eventsData.filter(e => e.chainId);
      if (!chainEvents.length) {
        container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:12px;border:1px dashed var(--border);border-radius:8px">暂无事件链，点击下方「新建事件链」或「AI生成事件链」</div>';
        _updateExtCounts();
        _applyExtSearch();
        return;
      }
      const groups = {};
      chainEvents.forEach(ev => {
        const id = ev.chainId || '__none__';
        if (!groups[id]) groups[id] = { name: ev.chainName || '未命名事件链', events: [] };
        groups[id].events.push(ev);
      });
      container.innerHTML = Object.keys(groups).map(chainId => {
        const g = groups[chainId];
        g.events.sort((a, b) => Number(a.chainIndex || 0) - Number(b.chainIndex || 0));
        const cards = g.events.map(ev => {
          const idx = eventsData.indexOf(ev);
          const extra = `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">事件链：${Utils.escapeHtml(g.name)} · 第 ${Number(ev.chainIndex || 0) + 1} 节</div>`;
          return _wvEventCardHtml(ev, idx, extra);
        }).join('');
        return `<div style="border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:14px;background:var(--bg-secondary)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
            <div>
              <div style="font-size:15px;font-weight:700;color:var(--accent)">${Utils.escapeHtml(g.name)}</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${g.events.length} 个事件 · 通过上一事件结束词触发下一事件</div>
            </div>
            <button type="button" onclick="event.stopPropagation();Worldview.aiGenerateEvents('appendChain','${Utils.escapeHtml(chainId)}')" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--accent);font-size:12px;cursor:pointer;white-space:nowrap">续写</button>
          </div>
          ${cards}
          <button type="button" onclick="Worldview.addChainNode('${Utils.escapeHtml(chainId)}')" style="width:100%;margin-top:8px;padding:8px;border-radius:8px;border:1px dashed var(--border);background:none;color:var(--text-secondary);font-size:12px;cursor:pointer">+ 添加节点</button>
        </div>`;
      }).join('');
      _updateExtCounts();
      _applyExtSearch();
      return;
    }

    const standalone = eventsData.map((ev, i) => ({ ev, i })).filter(x => !x.ev.chainId);
    if (!standalone.length) {
      container.innerHTML = '';
      _updateExtCounts();
      _applyExtSearch();
      return;
    }
    container.innerHTML = standalone.map(({ ev, i }) => _wvEventCardHtml(ev, i)).join('');
    _updateExtCounts();
    _applyExtSearch();
  }

  function _wvEventCardHtml(ev, i, extraHtml = '') {
    const triggerType = ev.triggerType || 'keyword';
    const keys = (ev.keys || '').trim();
    const keyTags = triggerType === 'attr' ? _eventAttrConditionSummary(ev) : (keys
      ? keys.split(/[,，\s]+/).filter(Boolean).map(t => `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${Utils.escapeHtml(t)}</span>`).join('')
      : '<span style="font-size:11px;color:var(--danger)">未设置关键词</span>');
    const modeLabel = triggerType === 'attr' ? '数值触发' : '关键词触发';
    const chainLabel = ev.chainId ? `<span style="font-size:10px;color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:1px 6px">链#${Number(ev.chainIndex || 0) + 1}</span>` : '';
    const completeKey = ev.completeKey ? `<span style="font-size:11px;color:var(--text-secondary)">结束词：${Utils.escapeHtml(ev.completeKey)}</span>` : '<span style="font-size:11px;color:var(--danger)">未设置结束词</span>';
    return `<div style="position:relative;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer" onclick="Worldview.editEvent(${i})">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg>
        <span style="font-size:14px;font-weight:bold;color:var(--accent)">${Utils.escapeHtml(ev.name || '未命名事件')}</span>
        <span style="font-size:10px;color:var(--text-secondary);border:1px solid var(--border);border-radius:999px;padding:1px 6px">${modeLabel}</span>
        ${chainLabel}
      </div>
      ${extraHtml}
      <div style="margin-bottom:4px">${keyTags}</div>
      <div style="margin-bottom:4px">${completeKey}</div>
      ${ev.content ? `<div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(ev.content)}</div>` : ''}
    </div>`;
  }

  function switchEventTab(tab) {
    _wvEventTab = tab === 'chain' ? 'chain' : 'standalone';
    const sBtn = document.getElementById('wv-event-tab-standalone');
    const cBtn = document.getElementById('wv-event-tab-chain');
    if (sBtn) { sBtn.style.background = _wvEventTab === 'standalone' ? 'var(--accent)' : 'transparent'; sBtn.style.color = _wvEventTab === 'standalone' ? '#111' : 'var(--text-secondary)'; }
    if (cBtn) { cBtn.style.background = _wvEventTab === 'chain' ? 'var(--accent)' : 'transparent'; cBtn.style.color = _wvEventTab === 'chain' ? '#111' : 'var(--text-secondary)'; }
    const aiBtn = document.getElementById('wv-event-ai-btn');
    const addBtn = document.getElementById('wv-event-add-btn');
    const _sparkSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>';
    if (aiBtn) aiBtn.innerHTML = _sparkSvg + (_wvEventTab === 'chain' ? ' AI 生成事件链' : ' AI 生成事件');
    if (addBtn) {
      if (_wvEventTab === 'chain') { addBtn.textContent = '+ 新建事件链'; addBtn.setAttribute('onclick', 'Worldview.addEventChain()'); }
      else { addBtn.textContent = '+ 添加事件'; addBtn.setAttribute('onclick', 'Worldview.addEvent()'); }
    }
    _renderEvents(eventsData);
  }
  let _editEventIdx = null;

  // ===== AI 生成全局属性 =====
  let _aiAttrAbort = null;

  // 弹窗：让用户填数量 + 可选需求
  function aiGenerateGlobalAttrs() {
    const w = window.__wvEditingCache;
    if (!w) { UI.showToast('请先打开世界观编辑'); return; }
    const html = `
    <div id="ai-attr-gen-overlay" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-attr-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成全局属性</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-attr-gen-prompt" rows="3" placeholder="例如：侧重生存要素、或偏向养成向的成长数值" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:12px;margin-top:12px">
          <div style="flex:1">
            <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成数量</label>
            <input type="number" id="ai-attr-gen-count" value="3" min="1" max="10" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box">
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">根据当前世界观基调生成独立属性（追加到已有属性后），进位/派生等联动请生成后手动配置。</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-attr-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-attr-gen-btn" onclick="Worldview._doAiGenerateGlobalAttrs()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-attr-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  async function _doAiGenerateGlobalAttrs() {
    const overlay = document.getElementById('ai-attr-gen-overlay');
    const btn = document.getElementById('ai-attr-gen-btn');
    const status = document.getElementById('ai-attr-gen-status');
    const prompt = document.getElementById('ai-attr-gen-prompt')?.value?.trim() || '';
    const count = Math.max(1, Math.min(10, parseInt(document.getElementById('ai-attr-gen-count')?.value) || 3));

    const w = window.__wvEditingCache;
    if (!w) { if (status) { status.style.display = 'block'; status.textContent = '请先打开世界观编辑'; } return; }
    const gp = _ensureGameplay(w);
    const settingText = w?.setting || '';
    const existingNames = (gp.globalAttrs || []).map(a => (a.name || '').trim()).filter(Boolean);

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = `正在生成 ${count} 个属性…`; }

    const sysPrompt = `你是一个文字冒险游戏的玩法数值设计师。请根据世界观设定的基调，为该世界观设计一组"全局属性"（作用于玩家/全局的自定义数值）。

设计要求：
- 属性要贴合世界观基调。举例：生存/末世题材可以有「饱食度」「体力值」「精神状态」；娱乐圈题材可以有「星光值」「粉丝数」「话题度」；修仙题材可以有「灵力」「境界」「声望」；校园题材可以有「学分」「体力」「人气」。
- 每个属性都是独立数值，不要设计属性之间的联动关系。
- 属性名简洁（2-6字），有辨识度，符合世界观风格。
- desc 说明这个数值代表什么、大致怎么变化，写给运行时 AI 看（30-80字），让 AI 知道什么时候该加减这个值。
- initial：初始值（整数）。一般成长型属性从 0 起（如金币、经验、粉丝数），状态型属性可以给个中间值（如体力 100、饱食度 80）。
- max：上限（整数）。有明确上限的状态属性填数值（如体力上限 100）；无上限的成长属性填空字符串 ""。

输出纯 JSON 数组，每项格式：{"name":"属性名","desc":"说明","initial":0,"max":100}
max 无上限时写 {"max":""}。不要输出 Markdown、注释或解释。`;

    const userMsg = `请为以下世界观生成 ${count} 个全局属性。
${prompt ? '\n## 用户额外需求\n' + prompt + '\n' : ''}
## 世界观设定
${settingText ? settingText.slice(0, 1500) : '（未提供，请生成通用的成长/状态属性）'}
${existingNames.length ? '\n## 已有属性（不要重复）\n' + existingNames.join('、') : ''}`;

    try {
      _aiAttrAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiAttrAbort.signal, maxTokens: 3000 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.attrs) ? parsed.attrs : []);
      if (!Array.isArray(arr) || arr.length === 0) throw new Error('AI 返回的不是有效属性数组');

      const existSet = new Set(existingNames.map(n => n.toLowerCase()));
      let added = 0;
      for (const item of arr) {
        const name = String(item?.name || '').trim();
        if (!name || existSet.has(name.toLowerCase())) continue;
        const attr = _defaultGameplayAttr();
        attr.name = name;
        attr.desc = String(item.desc || '').trim();
        attr.initial = Number.isFinite(Number(item.initial)) ? Number(item.initial) : 0;
        const mx = item.max;
        attr.max = (mx === '' || mx === null || mx === undefined || !Number.isFinite(Number(mx))) ? '' : Number(mx);
        // 联动字段一律留空（第一版不生成联动）
        attr.overflowTo = ''; attr.deriveTo = ''; attr.deriveStep = '';
        gp.globalAttrs.push(attr);
        existSet.add(name.toLowerCase());
        added++;
      }

      if (added === 0) throw new Error('生成的属性都与已有重复');
      await _saveEditingWV(w);
      window.__wvEditingCache = w;
      _renderGameplayAttrs(w);
      overlay?.remove();
      UI.showToast(`已生成 ${added} 个全局属性`, 2000);
    } catch(e) {
      if (e.name === 'AbortError') { if (status) status.textContent = '已取消'; return; }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiAttrAbort = null;
    }
  }
  // ===== AI 生成角色属性（模板 → 批量套用勾选的角色）=====
  // 收集当前世界观的可选角色（只列本世界观的 NPC，不含单人卡/其它世界观）
  function _collectCurrentWvNpcs(w) {
    const out = [];
    if (!w) return out;
    (w.globalNpcs || []).forEach(n => {
      if (!n || !n.id) return;
      out.push({ targetType: 'worldviewNpc', targetId: n.id, sourceWorldviewId: w.id, targetName: n.name || '未命名', aliases: n.aliases || '', sourceLabel: '全图常驻' });
    });
    (w.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(n => {
      if (!n || !n.id) return;
      out.push({ targetType: 'worldviewNpc', targetId: n.id, sourceWorldviewId: w.id, targetName: n.name || '未命名', aliases: n.aliases || '', sourceLabel: `${r.name || '未命名地区'} / ${f.name || '未命名势力'}` });
    })));
    return out;
  }

  function aiGenerateCharAttrs() {
    const w = window.__wvEditingCache;
    if (!w) { UI.showToast('请先打开世界观编辑'); return; }
    const npcs = _collectCurrentWvNpcs(w);
    if (!npcs.length) { UI.showToast('当前世界观还没有角色，请先添加 NPC', 2400); return; }
    window.__wvCharAttrNpcCache = npcs;
    const rows = npcs.map((c, i) => `
      <label style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);cursor:pointer">
        <input type="checkbox" class="ai-charattr-pick" data-idx="${i}" checked style="width:16px;height:16px;accent-color:var(--accent);flex-shrink:0">
        <div style="min-width:0;flex:1">
          <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.targetName)}</div>
          <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.sourceLabel || '')}</div>
        </div>
      </label>`).join('');
    const html = `
    <div id="ai-charattr-gen-overlay" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-charattr-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:440px;max-height:85vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成角色属性</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-charattr-gen-prompt" rows="2" placeholder="例如：侧重角色与玩家的关系发展，或加入信任/戒备这类对立向数值" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <div style="margin-top:12px">
          <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成数量</label>
          <input type="number" id="ai-charattr-gen-count" value="3" min="1" max="10" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box">
        </div>
        <div style="margin-top:12px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <label style="font-size:12px;color:var(--text-secondary)">应用到角色</label>
            <div style="display:flex;gap:8px">
              <button type="button" onclick="Worldview._charAttrPickAll(true)" style="background:none;border:none;color:var(--accent);font-size:12px;cursor:pointer;padding:0">全选</button>
              <button type="button" onclick="Worldview._charAttrPickAll(false)" style="background:none;border:none;color:var(--text-secondary);font-size:12px;cursor:pointer;padding:0">全不选</button>
            </div>
          </div>
          <div style="max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">${rows}</div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">生成一套通用角色属性模板，套用到勾选的角色（各角色数值独立）。已有属性的角色只追加不重名的，联动请生成后手动配置。</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-charattr-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-charattr-gen-btn" onclick="Worldview._doAiGenerateCharAttrs()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-charattr-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  function _charAttrPickAll(on) {
    document.querySelectorAll('#ai-charattr-gen-overlay .ai-charattr-pick').forEach(cb => { cb.checked = !!on; });
  }

  async function _doAiGenerateCharAttrs() {
    const overlay = document.getElementById('ai-charattr-gen-overlay');
    const btn = document.getElementById('ai-charattr-gen-btn');
    const status = document.getElementById('ai-charattr-gen-status');
    const prompt = document.getElementById('ai-charattr-gen-prompt')?.value?.trim() || '';
    const count = Math.max(1, Math.min(10, parseInt(document.getElementById('ai-charattr-gen-count')?.value) || 3));

    const picks = Array.from(document.querySelectorAll('#ai-charattr-gen-overlay .ai-charattr-pick'))
      .filter(cb => cb.checked)
      .map(cb => (window.__wvCharAttrNpcCache || [])[Number(cb.getAttribute('data-idx'))])
      .filter(Boolean);
    if (!picks.length) { if (status) { status.style.display = 'block'; status.textContent = '请至少勾选一个角色'; } return; }

    const w = window.__wvEditingCache;
    if (!w) { if (status) { status.style.display = 'block'; status.textContent = '请先打开世界观编辑'; } return; }
    const settingText = w?.setting || '';

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = `正在生成模板并套用到 ${picks.length} 个角色…`; }

    const sysPrompt = `你是一个文字冒险游戏的玩法数值设计师。请根据世界观基调，设计一套"角色属性模板"——衡量单个角色与玩家之间关系/状态的自定义数值，会被套用到多个角色身上。

设计要求：
- 以角色与玩家的关系向为主。举例：「好感度」「信任度」「亲密度」「戒备心」等，也可以根据世界观加入题材相关的关系数值（如宫斗题材的「宠爱值」、江湖题材的「义气」）。跟随用户需求，不必拘泥于好感度。
- 每个属性都是独立数值，不要设计属性之间的联动关系。
- 属性名简洁（2-6字），符合世界观风格。
- desc 说明这个数值代表这个角色对玩家的什么态度/状态、大致怎么变化，写给运行时 AI 看（30-80字）。desc 里用"该角色/对方"这类通用称呼，不要写死具体角色名（因为会套用到多个角色）。
- initial：初始值（整数）。关系类一般从中性值起（如好感度 50、信任 30），负向数值（如戒备心）可以从较低值起。
- max：上限（整数）。关系类通常有上限（如好感度上限 100）；无上限的填空字符串 ""。

输出纯 JSON 数组，每项格式：{"name":"属性名","desc":"说明","initial":50,"max":100}
max 无上限时写 {"max":""}。不要输出 Markdown、注释或解释。`;

    const userMsg = `请为以下世界观生成 ${count} 个角色属性（模板，将套用到多个角色）。
${prompt ? '\n## 用户额外需求\n' + prompt + '\n' : ''}
## 世界观设定
${settingText ? settingText.slice(0, 1500) : '（未提供，请生成通用的角色关系属性）'}`;

    try {
      _aiAttrAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiAttrAbort.signal, maxTokens: 3000 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.attrs) ? parsed.attrs : []);
      if (!Array.isArray(arr) || arr.length === 0) throw new Error('AI 返回的不是有效属性数组');

      // 归一化成模板属性（去掉 id，套用时每个角色各自生成 id）
      const template = [];
      const tplSeen = new Set();
      for (const item of arr) {
        const name = String(item?.name || '').trim();
        if (!name || tplSeen.has(name.toLowerCase())) continue;
        const mx = item.max;
        template.push({
          name,
          desc: String(item.desc || '').trim(),
          initial: Number.isFinite(Number(item.initial)) ? Number(item.initial) : 0,
          max: (mx === '' || mx === null || mx === undefined || !Number.isFinite(Number(mx))) ? '' : Number(mx)
        });
        tplSeen.add(name.toLowerCase());
      }
      if (!template.length) throw new Error('生成的属性无效');

      // 重新拿最新世界观写入（避免 __wvEditingCache 过期）
      const ww = await DB.get('worldviews', editingWorldviewId) || w;
      const gp = _ensureGameplay(ww);
      let touchedCards = 0, addedAttrs = 0;
      for (const npc of picks) {
        const key = _attrTargetKey({ targetType: npc.targetType, targetId: npc.targetId, sourceWorldviewId: npc.sourceWorldviewId });
        let card = gp.characterAttrs.find(x => _attrTargetKey(x) === key);
        if (!card) {
          card = { targetType: npc.targetType, targetId: npc.targetId, targetName: npc.targetName, sourceWorldviewId: npc.sourceWorldviewId || '', sourceLabel: npc.sourceLabel || '', attrs: [] };
          gp.characterAttrs.push(card);
        }
        const existSet = new Set((card.attrs || []).map(a => (a.name || '').trim().toLowerCase()).filter(Boolean));
        let cardAdded = 0;
        for (const t of template) {
          if (existSet.has(t.name.toLowerCase())) continue;
          const attr = _defaultGameplayAttr();
          attr.name = t.name;
          attr.desc = t.desc;
          attr.initial = t.initial;
          attr.max = t.max;
          attr.overflowTo = ''; attr.deriveTo = ''; attr.deriveStep = '';
          card.attrs.push(attr);
          existSet.add(t.name.toLowerCase());
          cardAdded++; addedAttrs++;
        }
        if (cardAdded > 0) touchedCards++;
      }

      if (addedAttrs === 0) throw new Error('勾选的角色都已有同名属性');
      await _saveEditingWV(ww);
      window.__wvEditingCache = ww;
      _renderGameplayAttrs(ww);
      overlay?.remove();
      UI.showToast(`已为 ${touchedCards} 个角色套用属性（共 ${addedAttrs} 条）`, 2200);
    } catch(e) {
      if (e.name === 'AbortError') { if (status) status.textContent = '已取消'; return; }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiAttrAbort = null;
    }
  }

    // ===== AI 生成任务阶段配置（世界观级，照搬对话级逻辑，上下文用世界观设定）=====
  let _aiTaskAbort = null;

  // 弹窗：让用户填可选需求（任务的 types 数量由 AI 按 3-5 自定，不需要数量输入）
  function aiGenerateTaskPhase(pi) {
    const w = window.__wvEditingCache;
    if (!w) { UI.showToast('请先打开世界观编辑'); return; }
    const gp = _ensureGameplay(w);
    if (!gp.taskSystem.phases[pi]) return;
    const html = `
    <div id="ai-task-gen-overlay" data-pi="${pi}" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-task-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成完整阶段配置</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-task-gen-prompt" rows="3" placeholder="例如：侧重日常养成向任务、或偏调查解谜、或围绕某条主线" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">会生成一套完整阶段配置（阶段名、任务类型、奖励），覆盖当前阶段的内容。任务类型数量由 AI 按需生成。</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-task-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-task-gen-btn" onclick="Worldview._doAiGenerateTaskPhase()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-task-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  async function _doAiGenerateTaskPhase() {
    const overlay = document.getElementById('ai-task-gen-overlay');
    const btn = document.getElementById('ai-task-gen-btn');
    const status = document.getElementById('ai-task-gen-status');
    const prompt = document.getElementById('ai-task-gen-prompt')?.value?.trim() || '';
    const pi = Number(overlay?.dataset?.pi);

    const w = window.__wvEditingCache;
    if (!w) { if (status) { status.style.display = 'block'; status.textContent = '请先打开世界观编辑'; } return; }
    const gp = _ensureGameplay(w);
    const phase = gp.taskSystem.phases[pi];
    if (!phase) { if (status) { status.style.display = 'block'; status.textContent = '阶段已不存在'; } return; }

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = '正在生成阶段配置…'; }

    try {
      const settingText = w?.setting || '';
      // 收集属性名（全局 + 各角色），供任务奖励绑定
      const globals = (gp.globalAttrs || []).map(a => a.name).filter(Boolean);
      const chars = (gp.characterAttrs || []).flatMap(c =>
        (c.attrs || []).map(a => `${c.targetName || '角色'}的${a.name}`).filter(Boolean)
      );
      const attrList = [...globals, ...chars].join('、');

      const sysPrompt = `你是一个文字冒险游戏的任务系统设计师。请根据世界观设定，为一个游戏阶段设计一套完整的任务系统配置。

配置包括：
- name：阶段名称（3-8字，反映这个阶段的主题）
- batchSize：每批任务数量（2-5 之间，建议 3）
- totalTasks：这个阶段的总任务目标数（5-20，建议 10）
- types：任务类型模板数组，包含 3-5 个类型。每个类型：
  - label：类型名称（2-6字，简洁有力，如"武力提升""线索探查""日常修炼"）
  - desc：任务方向说明（给运行时 AI 看的大方向，50-100字）。只说这类任务的性质和内容方向，举1-2个具体任务例子，让 AI 知道应该给玩家派什么类型的事情去做。不要写触发时机，不要写"当玩家……时"，直接描述任务内容的形态。例如："属于武力提升类任务，内容围绕体能训练、格斗学习展开，如报名散打课、完成一次对练、跟师父学招式等。"
  - rewardMode：奖励模式（"attr" / "free" / "none"）
  - rewardAttr：当 rewardMode="attr" 时，填属性名（必须从下方属性列表选）
  - rewardValue：当 rewardMode="attr" 时，奖励数值（1-5）
  - rewardFree：当 rewardMode="free" 时，奖励方向（大方向，非具体物品，例如"获得与调查相关的线索或物品"）
- completionReward：阶段完成奖励（对象格式）
  - mode：奖励模式（"attr" / "free" / "none"）
  - attr：当 mode="attr" 时，属性名
  - value：当 mode="attr" 时，奖励数值
  - free：当 mode="free" 时，奖励方向

要求：
- 这是"世界观级"任务配置，应来自世界观本身的题材、主题和玩家在该世界里会自然去做的事情，不要依赖某一次具体对话的临时剧情。
- types 要覆盖玩家在这个阶段自然会去做的不同类型的事情。
- 如果有自定义属性，优先使用属性奖励，选择与任务内容最相关的属性。
- 阶段奖励可以用属性或 free，也可以无奖励（mode="none"）。

输出纯JSON对象（不是数组），不要其他内容。格式：
{"name":"阶段名","batchSize":3,"totalTasks":10,"types":[{"label":"武力提升","desc":"属于武力提升类任务，内容围绕体能训练、格斗学习展开，如报名散打课、完成一次对练等。","rewardMode":"attr","rewardAttr":"战斗力","rewardValue":2,"rewardFree":""}],"completionReward":{"mode":"attr","attr":"战斗力","value":5,"free":""}}`;

      const userMsg = `请为以下世界观设计一套完整的阶段任务系统配置。
${prompt ? '\n## 用户额外需求\n' + prompt + '\n' : ''}
## 世界观设定
${settingText ? settingText.slice(0, 1500) : '（未提供）'}

## 可用自定义属性
${attrList || '（未配置属性——请用 rewardMode "free" 或 "none"）'}`;

      _aiTaskAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiTaskAbort.signal, maxTokens: 4000 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const config = JSON.parse(cleaned);
      if (!config || typeof config !== 'object') throw new Error('AI 返回的不是有效对象');

      // 重新拿最新世界观写入
      const ww = await DB.get('worldviews', editingWorldviewId) || w;
      const gpw = _ensureGameplay(ww);
      const ph = gpw.taskSystem.phases[pi];
      if (!ph) throw new Error('阶段已不存在');

      ph.name = String(config.name || '').trim();
      ph.batchSize = Math.max(1, Math.min(5, Number(config.batchSize) || 3));
      ph.totalTasks = Math.max(1, Math.min(999, Number(config.totalTasks) || 10));
      ph.types = [];
      if (Array.isArray(config.types)) {
        for (const item of config.types) {
          if (!item || !item.label) continue;
          ph.types.push({
            id: 'tt_' + Utils.uuid().slice(0, 8),
            label: String(item.label).trim(),
            desc: String(item.desc || '').trim(),
            rewardMode: ['attr', 'free', 'none'].includes(item.rewardMode) ? item.rewardMode : 'none',
            rewardAttr: String(item.rewardAttr || '').trim(),
            rewardValue: Number(item.rewardValue) || 0,
            rewardFree: String(item.rewardFree || '').trim()
          });
        }
      }
      if (config.completionReward && typeof config.completionReward === 'object') {
        ph.completionReward = {
          mode: ['attr', 'free', 'none'].includes(config.completionReward.mode) ? config.completionReward.mode : 'none',
          attr: String(config.completionReward.attr || '').trim(),
          value: Number(config.completionReward.value) || 0,
          free: String(config.completionReward.free || '').trim()
        };
      } else {
        ph.completionReward = { mode: 'none', attr: '', value: 0, free: '' };
      }

      await _saveEditingWV(ww);
      window.__wvEditingCache = ww;
      _renderTaskSystem(ww);
      overlay?.remove();
      UI.showToast(`已生成阶段配置（${ph.types.length} 个任务类型）`, 2000);
    } catch(e) {
      if (e.name === 'AbortError') { if (status) status.textContent = '已取消'; return; }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiTaskAbort = null;
    }
  }

  // ===== AI 生成历法系统（世界观级，整体覆盖当前历法；hoursPerDay 锁 24）=====
  let _aiCalAbort = null;

  // 弹窗：填可选需求（历法是整体结构，只生成不需要数量）
  function aiGenerateCalendar() {
    const w = window.__wvEditingCache;
    if (!w) { UI.showToast('请先打开世界观编辑'); return; }
    const html = `
    <div id="ai-cal-gen-overlay" style="position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-cal-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成历法系统</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-cal-gen-prompt" rows="3" placeholder="例如：修仙世界用天干纪日、日式月曜日、或用古风十二时辰" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">会根据世界观基调生成星期名、月份天数、季节、时段，<b>整体覆盖</b>当前历法（一天固定 24 小时不变）。</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-cal-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-cal-gen-btn" onclick="Worldview._doAiGenerateCalendar()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-cal-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  async function _doAiGenerateCalendar() {
    const overlay = document.getElementById('ai-cal-gen-overlay');
    const btn = document.getElementById('ai-cal-gen-btn');
    const status = document.getElementById('ai-cal-gen-status');
    const prompt = document.getElementById('ai-cal-gen-prompt')?.value?.trim() || '';

    const w = window.__wvEditingCache;
    if (!w) { if (status) { status.style.display = 'block'; status.textContent = '请先打开世界观编辑'; } return; }

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = '正在生成历法…'; }

    try {
      const settingText = w?.setting || '';

      const sysPrompt = `你是一个文字冒险游戏的历法系统设计师。请根据世界观设定，设计一套贴合该世界基调的历法。

必须输出以下字段（纯 JSON 对象）：
- daysPerWeek：一周天数（整数，3-10，通常 7）
- weekDayNames：星期名数组，长度必须等于 daysPerWeek。每个是完整名称（如"星期一""月曜日""甲日"）。**严禁包含任何阿拉伯数字或中文数字**（会干扰时间解析），要用有世界观特色的命名。
- weekDayTypes：与 weekDayNames 等长的数组，每项是 "work"（工作/活动日）或 "rest"（休息日），一般末尾 1-2 天为 rest。
- monthsPerYear：一年月份数（整数，通常 12，奇幻世界可 4-16）
- daysPerMonth：每月天数数组，长度必须等于 monthsPerYear，每项 20-40 的整数。
- seasons：季节数组，每项 {name:季节名(2-6字), months:该季节包含的月份数字数组(元素在 1..monthsPerYear 范围内), weather:天气概述(不超过20字)}。所有月份应被季节覆盖，不重不漏。
- timePeriods：一天的时段数组，每项 {name:时段名(如"卯时""清晨"), startHour:起始小时(0-23整数), desc:该时段环境特征(不超过30字)}。至少 4 个时段，按 startHour 升序，第一个 startHour 应为 0。

要求：
- 历法命名和风格要贴合世界观题材（修仙用天干地支/时辰，日式用曜日，西幻可自造月份名等）。
- 不要输出 hoursPerDay（一天固定 24 小时，由系统管理）。
- 季节与月份要自洽（如四季对应的月份连续）。

输出纯 JSON 对象，不要任何其他内容。格式示例：
{"daysPerWeek":7,"weekDayNames":["星期一","星期二","星期三","星期四","星期五","星期六","星期日"],"weekDayTypes":["work","work","work","work","work","rest","rest"],"monthsPerYear":12,"daysPerMonth":[31,28,31,30,31,30,31,31,30,31,30,31],"seasons":[{"name":"春","months":[3,4,5],"weather":"微风渐暖"},{"name":"夏","months":[6,7,8],"weather":"炎热潮湿"},{"name":"秋","months":[9,10,11],"weather":"凉爽干燥"},{"name":"冬","months":[12,1,2],"weather":"寒冷"}],"timePeriods":[{"name":"凌晨","startHour":0,"desc":"天色未明，万籁俱寂"},{"name":"早晨","startHour":5,"desc":"天色渐亮"},{"name":"上午","startHour":8,"desc":"日光明亮"},{"name":"下午","startHour":14,"desc":"日光偏斜"},{"name":"傍晚","startHour":18,"desc":"太阳落山"},{"name":"夜晚","startHour":20,"desc":"灯火亮起"}]}`;

      const userMsg = `请为以下世界观设计一套历法。
${prompt ? '\n## 用户额外需求\n' + prompt + '\n' : ''}
## 世界观设定
${settingText ? settingText.slice(0, 1500) : '（未提供）'}`;

      _aiCalAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiCalAbort.signal, maxTokens: 3000 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const c = JSON.parse(cleaned);
      if (!c || typeof c !== 'object') throw new Error('AI 返回的不是有效对象');

      // ===== 严格校验 + 归一化 =====
      // 星期名：剥数字、去空、非空
      let weekNames = Array.isArray(c.weekDayNames)
        ? c.weekDayNames.map(n => String(n == null ? '' : n).replace(/[0-9\uFF10-\uFF19]/g, '').trim()).filter(Boolean)
        : [];
      if (weekNames.length < 1) throw new Error('星期名无效');
      let daysPerWeek = weekNames.length;

      // 星期类型：与星期名等长，非法值补 work
      let weekTypes = Array.isArray(c.weekDayTypes) ? c.weekDayTypes.map(t => t === 'rest' ? 'rest' : 'work') : [];
      while (weekTypes.length < daysPerWeek) weekTypes.push('work');
      weekTypes = weekTypes.slice(0, daysPerWeek);

      // 月份数
      let monthsPerYear = Math.max(1, Math.min(24, Math.round(Number(c.monthsPerYear) || 12)));
      // 每月天数：与月份数等长，缺补 30，越界钳到 1..999
      let daysPerMonth = Array.isArray(c.daysPerMonth) ? c.daysPerMonth.map(d => Math.max(1, Math.min(999, Math.round(Number(d) || 30)))) : [];
      while (daysPerMonth.length < monthsPerYear) daysPerMonth.push(30);
      daysPerMonth = daysPerMonth.slice(0, monthsPerYear);

      // 季节：过滤越界月份，非空名
      let seasons = Array.isArray(c.seasons) ? c.seasons.map(s => ({
        name: String(s?.name || '').trim().slice(0, 10),
        months: Array.isArray(s?.months) ? s.months.map(m => Math.round(Number(m))).filter(m => m >= 1 && m <= monthsPerYear) : [],
        weather: String(s?.weather || '').trim().slice(0, 20)
      })).filter(s => s.name) : [];
      if (!seasons.length) throw new Error('季节配置无效');

      // 时段：startHour 0-23、按升序、非空名
      let timePeriods = Array.isArray(c.timePeriods) ? c.timePeriods.map(p => ({
        name: String(p?.name || '').trim().slice(0, 10),
        startHour: Math.max(0, Math.min(23, Math.round(Number(p?.startHour) || 0))),
        desc: String(p?.desc || '').trim().slice(0, 30)
      })).filter(p => p.name) : [];
      if (timePeriods.length < 1) throw new Error('时段配置无效');
      timePeriods.sort((a, b) => a.startHour - b.startHour);
      // 保证第一个时段从 0 点起，避免出现无法归属的凌晨时段
      if (timePeriods[0].startHour !== 0) timePeriods[0].startHour = 0;

      // ===== 整体覆盖写入（hoursPerDay 锁死 24）=====
      const ww = await DB.get('worldviews', editingWorldviewId) || w;
      const gpw = _ensureGameplay(ww);
      gpw.calendarSystem = {
        hoursPerDay: 24,
        daysPerWeek,
        weekDayNames: weekNames,
        weekDayTypes: weekTypes,
        monthsPerYear,
        daysPerMonth,
        uniformDaysPerMonth: false,
        seasons,
        timePeriods
      };

      await _saveEditingWV(ww);
      window.__wvEditingCache = ww;
      _editingCalRules = gpw.calendarSystem;
      overlay?.remove();
      // 刷新历法编辑器界面（若打开着）+ 卡片标签
      _calSaveAndRefresh();
      _updateCalendarCardLabel();
      UI.showToast(`已生成历法（${daysPerWeek}天/周 · ${monthsPerYear}月/年 · ${seasons.length}季）`, 2200);
    } catch(e) {
      if (e.name === 'AbortError') { if (status) status.textContent = '已取消'; return; }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiCalAbort = null;
    }
  }

  // ===== AI 生成商城配置（短时效 takeout + 长时效 shop，一次生成两个，只回填不自动保存）=====
  let _aiShopAbort = null;

  function aiGenerateShops() {
    const w = window.__wvEditingCache;
    if (!w) { UI.showToast('请先打开世界观编辑'); return; }
    const html = `
    <div id="ai-shop-gen-overlay" style="position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-shop-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成商城配置</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-shop-gen-prompt" rows="3" placeholder="例如：末世废土风的补给站和黑市、或修仙界的灵厨外送和天机阁" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">会根据世界观基调一次生成<b>短时效商城</b>（即时到手，如外卖/补给）和<b>长时效商城</b>（等几天，如网购/大件）的名称、描述、配送时间，填进上面的表单。生成后可手动微调。</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-shop-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-shop-gen-btn" onclick="Worldview._doAiGenerateShops()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-shop-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  async function _doAiGenerateShops() {
    const overlay = document.getElementById('ai-shop-gen-overlay');
    const btn = document.getElementById('ai-shop-gen-btn');
    const status = document.getElementById('ai-shop-gen-status');
    const prompt = document.getElementById('ai-shop-gen-prompt')?.value?.trim() || '';

    const w = window.__wvEditingCache;
    if (!w) { if (status) { status.style.display = 'block'; status.textContent = '请先打开世界观编辑'; } return; }

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = '正在生成商城配置…'; }

    try {
      const settingText = w?.setting || '';

      const sysPrompt = `你是一个文字冒险游戏的手机商城设计师。请根据世界观设定，一次性设计两个购物平台：短时效商城和长时效商城。

- takeout（短时效商城）：即时/当天就能到手的东西，如餐食、饮品、日用补给、灵厨外送等。配送以分钟计（deliveryUnit="min"），deliveryMin/deliveryMax 是配送分钟数范围（如 15~45）。
- shop（长时效商城）：需要等几天送达的大件或贵重物品，如装备、家具、法宝、丹药、网购商品等。配送以天计（deliveryUnit="day"），deliveryMin/deliveryMax 是配送天数范围（如 2~5）。

每个商城都要有：
- name：平台名称（有世界观特色，如现代"饿了咪/桃宝"、修仙"灵厨到家/天机阁"、末世"补给空投/黑市"）
- desc：告诉运行时 AI 这家卖什么（50-100字，说明经营范围和特色，让 AI 知道玩家能在这买到什么）
- deliveryMin / deliveryMax：配送时间范围的整数
- deliveryUnit："min"（短时效固定用 min）或 "day"（长时效固定用 day）

要求：
- 两个平台的风格、命名都要贴合世界观题材。
- 短时效卖即时消耗品，长时效卖需要等待的大件，两者定位要区分开。
- 配送时间要符合常识：短时效几十分钟内，长时效几天。

输出纯 JSON 对象，不要任何其他内容。格式示例：
{"takeout":{"name":"灵厨到家","desc":"修真界即时灵膳外送，供应各类餐食、茶点、疗伤灵丹小食，下单后由御剑差役即刻送达。","deliveryMin":15,"deliveryMax":45,"deliveryUnit":"min"},"shop":{"name":"天机阁","desc":"跨域法宝集市，售卖法器、丹药、符箓、灵草与炼器材料等珍稀物品，需由飞舟运送数日方达。","deliveryMin":2,"deliveryMax":5,"deliveryUnit":"day"}}`;

      const userMsg = `请为以下世界观设计短时效和长时效两个商城。
${prompt ? '\n## 用户额外需求\n' + prompt + '\n' : ''}
## 世界观设定
${settingText ? settingText.slice(0, 1500) : '（未提供）'}`;

      _aiShopAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiShopAbort.signal, maxTokens: 2000 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const c = JSON.parse(cleaned);
      if (!c || typeof c !== 'object') throw new Error('AI 返回的不是有效对象');

      const tk = c.takeout || {};
      const sh = c.shop || {};
      if (!tk.name && !sh.name) throw new Error('未生成有效商城');

      // 只回填到表单（不自动保存，用户可微调，返回时走原有 autosave）
      const setVal = (id, v) => { const el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; };
      const setUnit = (id, v, def) => { const el = document.getElementById(id); if (el) el.value = (v === 'min' || v === 'day') ? v : def; };
      // 短时效
      setVal('pa-takeout-name', String(tk.name || '').trim());
      setVal('pa-takeout-desc', String(tk.desc || '').trim());
      const tkMin = Math.max(0, Math.round(Number(tk.deliveryMin))); if (Number.isFinite(tkMin) && tk.deliveryMin != null) setVal('pa-takeout-deliveryMin', tkMin);
      const tkMax = Math.max(0, Math.round(Number(tk.deliveryMax))); if (Number.isFinite(tkMax) && tk.deliveryMax != null) setVal('pa-takeout-deliveryMax', tkMax);
      setUnit('pa-takeout-deliveryUnit', tk.deliveryUnit, 'min');
      // 长时效
      setVal('pa-shop-name', String(sh.name || '').trim());
      setVal('pa-shop-desc', String(sh.desc || '').trim());
      const shMin = Math.max(0, Math.round(Number(sh.deliveryMin))); if (Number.isFinite(shMin) && sh.deliveryMin != null) setVal('pa-shop-deliveryMin', shMin);
      const shMax = Math.max(0, Math.round(Number(sh.deliveryMax))); if (Number.isFinite(shMax) && sh.deliveryMax != null) setVal('pa-shop-deliveryMax', shMax);
      setUnit('pa-shop-deliveryUnit', sh.deliveryUnit, 'day');

      // 触发一次 autosave（表单 input 有绑定，但程序化 setVal 不触发 input 事件，主动存一次）
      try {
        const ww = await DB.get('worldviews', editingWorldviewId) || w;
        ww.phoneApps = ww.phoneApps || {};
        ww.phoneApps.takeout = ww.phoneApps.takeout || {};
        ww.phoneApps.shop = ww.phoneApps.shop || {};
        const gv = id => (document.getElementById(id)?.value || '');
        ww.phoneApps.takeout.name = gv('pa-takeout-name');
        ww.phoneApps.takeout.desc = gv('pa-takeout-desc');
        ww.phoneApps.takeout.deliveryMin = gv('pa-takeout-deliveryMin');
        ww.phoneApps.takeout.deliveryMax = gv('pa-takeout-deliveryMax');
        ww.phoneApps.takeout.deliveryUnit = gv('pa-takeout-deliveryUnit') || 'min';
        ww.phoneApps.shop.name = gv('pa-shop-name');
        ww.phoneApps.shop.desc = gv('pa-shop-desc');
        ww.phoneApps.shop.deliveryMin = gv('pa-shop-deliveryMin');
        ww.phoneApps.shop.deliveryMax = gv('pa-shop-deliveryMax');
        ww.phoneApps.shop.deliveryUnit = gv('pa-shop-deliveryUnit') || 'day';
        await _saveEditingWV(ww);
        window.__wvEditingCache = ww;
        try { _updatePhoneAppsLabel(); } catch(_) {}
      } catch(_) {}

      overlay?.remove();
      UI.showToast('已生成商城配置，可在表单里微调', 2200);
    } catch(e) {
      if (e.name === 'AbortError') { if (status) status.textContent = '已取消'; return; }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiShopAbort = null;
    }
  }

  // ===== AI 生成内容平台（信息载体/电台/阅读/视频，四个的 name + desc 一起生成）=====
  let _aiMediaAbort = null;

  function aiGenerateMediaApps() {
    const w = window.__wvEditingCache;
    if (!w) { UI.showToast('请先打开世界观编辑'); return; }
    const html = `
    <div id="ai-media-gen-overlay" style="position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-media-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成内容平台</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-media-gen-prompt" rows="3" placeholder="例如：末世废土风、或修真界的坊市传音风" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">会根据世界观基调一次生成<b>信息载体、电台、阅读、视频</b>四个内容平台的名称和描述，填进下面对应的表单。生成后可手动微调。</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-media-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-media-gen-btn" onclick="Worldview._doAiGenerateMediaApps()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-media-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  async function _doAiGenerateMediaApps() {
    const overlay = document.getElementById('ai-media-gen-overlay');
    const btn = document.getElementById('ai-media-gen-btn');
    const status = document.getElementById('ai-media-gen-status');
    const prompt = document.getElementById('ai-media-gen-prompt')?.value?.trim() || '';

    const w = window.__wvEditingCache;
    if (!w) { if (status) { status.style.display = 'block'; status.textContent = '请先打开世界观编辑'; } return; }

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = '正在生成内容平台…'; }

    try {
      const settingText = w?.setting || '';

      const sysPrompt = `你是一个文字冒险游戏的手机应用设计师。请根据世界观设定，一次性设计四个"内容平台"应用。它们是这个世界里人们获取信息和娱乐的主流渠道：

- forum（信息载体）：人们讨论交流、发帖爆料的平台（相当于论坛/微博/小红书/贴吧，或世界观对应形态如坊市传音阵、幸存者留言板）。
- radio（电台）：音频广播平台（相当于电台/播客，或世界观对应形态如传音法阵、废土电波）。
- reading（阅读）：小说/文本阅读平台（相当于起点/番茄小说，或世界观对应形态如藏书楼、灵典阁）。
- video（视频）：影视点播平台（相当于优酷/爱奇艺，或世界观对应形态如光影阁、幻境投影）。

每个平台都要有：
- name：平台名称（有世界观特色，别用地球现实品牌名，要贴合题材再创作）
- desc：平台描述（40-90字），告诉运行时 AI 这个平台的内容画风、主要用户群、常见内容类型，方便 AI 生成符合世界观的内容。

要求：
- 四个平台的命名风格要统一在同一个世界观基调下，但各有各的定位，不要雷同。
- 描述要具体到"谁在用、有什么内容、什么画风"。

输出纯 JSON 对象，不要任何其他内容。格式示例：
{"forum":{"name":"传音坊","desc":"散修交流的阵盘社区，常见丹方交易、剑修吐槽、门派八卦，画风市井热闹。"},"radio":{"name":"灵音台","desc":"以传音法器广播的音频频道，涵盖宗门资讯、夜话情感、志怪奇谈等。"},"reading":{"name":"藏经阁","desc":"修真界小说文库，收录修仙志、异闻录、话本传奇，读者多为闲暇散修与坊市百姓。"},"video":{"name":"幻影镜","desc":"以幻境法阵投影的影像平台，播映斗法实录、秘境游记、志怪短剧等。"}}`;

      const userMsg = `请为以下世界观设计信息载体、电台、阅读、视频四个内容平台。
${prompt ? '\n## 用户额外需求\n' + prompt + '\n' : ''}
## 世界观设定
${settingText ? settingText.slice(0, 1500) : '（未提供）'}`;

      _aiMediaAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiMediaAbort.signal, maxTokens: 2500 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const c = JSON.parse(cleaned);
      if (!c || typeof c !== 'object') throw new Error('AI 返回的不是有效对象');

      const fm = c.forum || {}, rd = c.radio || {}, rg = c.reading || {}, vg = c.video || {};
      if (!fm.name && !rd.name && !rg.name && !vg.name) throw new Error('未生成有效内容');

      const setVal = (id, v) => { const el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; };
      setVal('pa-forum-name', String(fm.name || '').trim());
      setVal('pa-forum-desc', String(fm.desc || '').trim());
      setVal('pa-radio-name', String(rd.name || '').trim());
      setVal('pa-radio-desc', String(rd.desc || '').trim());
      setVal('pa-reading-name', String(rg.name || '').trim());
      setVal('pa-reading-desc', String(rg.desc || '').trim());
      setVal('pa-video-name', String(vg.name || '').trim());
      setVal('pa-video-desc', String(vg.desc || '').trim());

      // 主动存一次（程序化 setVal 不触发 input 的 autosave）
      try {
        const ww = await DB.get('worldviews', editingWorldviewId) || w;
        ww.phoneApps = ww.phoneApps || {};
        const gv = id => (document.getElementById(id)?.value || '');
        ww.phoneApps.forum = ww.phoneApps.forum || {};
        ww.phoneApps.forum.name = gv('pa-forum-name');
        ww.phoneApps.forum.desc = gv('pa-forum-desc');
        ww.phoneApps.radio = ww.phoneApps.radio || {};
        ww.phoneApps.radio.name = gv('pa-radio-name');
        ww.phoneApps.radio.desc = gv('pa-radio-desc');
        ww.phoneApps.reading = ww.phoneApps.reading || {};
        ww.phoneApps.reading.name = gv('pa-reading-name');
        ww.phoneApps.reading.desc = gv('pa-reading-desc');
        ww.phoneApps.video = ww.phoneApps.video || {};
        ww.phoneApps.video.name = gv('pa-video-name');
        ww.phoneApps.video.desc = gv('pa-video-desc');
        await _saveEditingWV(ww);
        window.__wvEditingCache = ww;
        try { _updatePhoneAppsLabel(); } catch(_) {}
      } catch(_) {}

      overlay?.remove();
      UI.showToast('已生成四个内容平台，可在表单里微调', 2200);
    } catch(e) {
      if (e.name === 'AbortError') { if (status) status.textContent = '已取消'; return; }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiMediaAbort = null;
    }
  }

  // ===== AI 生成电台分类（只生成分类 name+direction+icon，不含标签）=====
  let _aiRadioCatAbort = null;
  const _RADIO_ICON_IDS = ['news','emotion','ghost','talk','music','mic','star','book','tower','clock','heart','coffee'];

  function aiGenerateRadioCats() {
    const html = `
    <div id="ai-radiocat-gen-overlay" style="position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-radiocat-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成电台分类</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-radiocat-gen-prompt" rows="3" placeholder="例如：侧重志怪灵异向、或围绕宗门时政" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin:12px 0 4px">生成数量</label>
        <input type="number" id="ai-radiocat-gen-count" value="3" min="1" max="10" style="width:80px;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:13px">
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">按世界观基调生成电台分类（只含分类名和大方向，不含具体标签），追加到自建分类。生成后可进各分类自行添加标签。</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-radiocat-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-radiocat-gen-btn" onclick="Worldview._doAiGenerateRadioCats()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-radiocat-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  async function _doAiGenerateRadioCats() {
    const overlay = document.getElementById('ai-radiocat-gen-overlay');
    const btn = document.getElementById('ai-radiocat-gen-btn');
    const status = document.getElementById('ai-radiocat-gen-status');
    const prompt = document.getElementById('ai-radiocat-gen-prompt')?.value?.trim() || '';
    let count = parseInt(document.getElementById('ai-radiocat-gen-count')?.value) || 3;
    count = Math.max(1, Math.min(10, count));

    const w = await _getEditingWV();
    if (!w) { if (status) { status.style.display = 'block'; status.textContent = '请先选择世界观'; } return; }

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = '正在生成电台分类…'; }

    try {
      const settingText = w?.setting || '';
      // 电台 App 整体定位（名称 + 描述），让生成的分类贴合这个电台
      const radioName = (w.phoneApps?.radio?.name || '').trim();
      const radioDesc = (w.phoneApps?.radio?.desc || '').trim();
      // 已有分类名（预设 + 自建）供去重提示
      const presetNames = _RADIO_PRESET_CATS.map(p => p.name);
      const customNames = (w.phoneApps?.radio?.categories || []).map(c => c.name).filter(Boolean);
      const existNames = [...presetNames, ...customNames];

      const sysPrompt = `你是一个文字冒险游戏的电台频道设计师。请根据世界观设定，设计若干个电台「分类」。

**重要——分类是最顶层的大分类**。电台的层级是三层：分类（最大的一级，如"新闻""情感""音乐""财经"）→ 标签（分类下的小分类细分，如新闻分类下的"时政""本地""社区"）→ 具体的一档台（玩家在手机里点开才现场生成）。你现在**只生成最顶层的大分类**，粒度要非常宽泛，能往下容纳好几个小分类。
- 正确示例（够大，是顶级大类）：新闻、情感、怪谈、音乐、闲聊、财经、体育、少儿、文艺、科普。
- 错误示例（太细，这些是分类下面的小分类标签或具体节目，不要生成）：时政要闻、地方快报、社区简讯、深夜点歌台、某某夜话。

每个分类输出：
- name：分类名称（2-6字，一个宽泛的顶级大类名，别带具体节目色彩）
- direction：这个大类整体覆盖哪一片内容领域、整体调性（30-80字）。描述的是"这一整个大类"，不是某一档节目或某个小分类。
- icon：从以下图标 id 里选一个最贴合的：news(新闻)、emotion(情感)、ghost(怪谈)、talk(闲聊)、music(音乐)、mic(麦克风)、star(星星)、book(书本)、tower(信号塔)、clock(时钟)、heart(爱心)、coffee(咖啡)。

要求：
- 分类要贴合世界观题材，是这个世界的电台会有的几个大频道。
- 分类之间是并列的大类，彼此不重叠，也不要和"已有分类"重名。
- 保持宽泛：宁可大而全，不要细而专。

输出纯 JSON 数组，不要其他内容。格式示例：
[{"name":"修真要闻","direction":"这一整个大类覆盖修真界的时政、宗门、榜单、秘境等各类正经资讯，整体调性权威正式，下辖时政、地方、宗门等多个细分方向。","icon":"news"},{"name":"情感夜话","direction":"这一大类聚焦情感与心灵，涵盖道侣情缘、师门恩怨、红尘牵挂等各类倾诉与陪伴内容，整体调性温暖私密。","icon":"emotion"}]`;

      const userMsg = `请为以下世界观设计 ${count} 个电台分类。
${prompt ? '\n## 用户额外需求\n' + prompt + '\n' : ''}
## 电台整体定位（分类要贴合这个电台的名称和描述）
电台名称：${radioName || '（未命名）'}
电台描述：${radioDesc || '（未填写）'}
## 已有分类（不要重复）
${existNames.join('、') || '（无）'}
## 世界观设定
${settingText ? settingText.slice(0, 1500) : '（未提供）'}`;

      _aiRadioCatAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiRadioCatAbort.signal, maxTokens: 2500 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const arr = JSON.parse(cleaned);
      if (!Array.isArray(arr) || !arr.length) throw new Error('AI 返回的不是有效数组');

      // 重新拿最新世界观写入
      const ww = await _getEditingWV();
      if (!ww) throw new Error('世界观已不存在');
      ww.phoneApps = ww.phoneApps || {};
      ww.phoneApps.radio = ww.phoneApps.radio || {};
      if (!Array.isArray(ww.phoneApps.radio.categories)) ww.phoneApps.radio.categories = [];
      const existSet = new Set([...existNames, ...ww.phoneApps.radio.categories.map(c => (c.name || '').toLowerCase())].map(n => String(n).toLowerCase()));

      let added = 0;
      for (const item of arr) {
        if (!item || !item.name) continue;
        const nm = String(item.name).trim();
        if (!nm || existSet.has(nm.toLowerCase())) continue;
        const icon = _RADIO_ICON_IDS.includes(item.icon) ? item.icon : 'mic';
        ww.phoneApps.radio.categories.push({
          id: 'rc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name: nm,
          icon,
          direction: String(item.direction || '').trim(),
          tags: []
        });
        existSet.add(nm.toLowerCase());
        added++;
      }
      if (added === 0) throw new Error('生成的分类都与已有分类重名');

      await _saveEditingWV(ww);
      window.__wvEditingCache = ww;
      overlay?.remove();
      // 刷新分类编辑器界面
      const catsOverlay = document.getElementById('radio-cats-editor-overlay');
      if (catsOverlay) _renderRadioCatsEditor(catsOverlay, ww);
      UI.showToast(`已生成 ${added} 个电台分类`, 2200);
    } catch(e) {
      if (e.name === 'AbortError') { if (status) status.textContent = '已取消'; return; }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiRadioCatAbort = null;
    }
  }

  // ===== AI 生成电台标签（在某个分类下批量生成 name+desc+guide+plays+renewMode）=====
  let _aiRadioTagAbort = null;
  const _RADIO_PLAY_IDS = ['mail','vote','request','call','lottery','divination'];
  const _RADIO_RENEW_MODES = ['unit','serial','free'];

  function aiGenerateRadioTags(catIdx) {
    const html = `
    <div id="ai-radiotag-gen-overlay" data-cat-idx="${catIdx}" style="position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-radiotag-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成标签</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-radiotag-gen-prompt" rows="3" placeholder="例如：偏向轻松日常向、或多来点互动玩法" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin:12px 0 4px">生成数量</label>
        <input type="number" id="ai-radiotag-gen-count" value="3" min="1" max="10" style="width:80px;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:13px">
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">按当前分类的大方向生成标签（小分类），含名称、描述、规则、玩法、续期方式，追加到本分类。生成后可进各标签微调。</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-radiotag-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-radiotag-gen-btn" onclick="Worldview._doAiGenerateRadioTags()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-radiotag-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  async function _doAiGenerateRadioTags() {
    const overlay = document.getElementById('ai-radiotag-gen-overlay');
    const btn = document.getElementById('ai-radiotag-gen-btn');
    const status = document.getElementById('ai-radiotag-gen-status');
    const prompt = document.getElementById('ai-radiotag-gen-prompt')?.value?.trim() || '';
    let count = parseInt(document.getElementById('ai-radiotag-gen-count')?.value) || 3;
    count = Math.max(1, Math.min(10, count));
    const catIdx = parseInt(overlay?.dataset?.catIdx);

    const w = await _getEditingWV();
    if (!w) { if (status) { status.style.display = 'block'; status.textContent = '请先选择世界观'; } return; }
    const cat = w.phoneApps?.radio?.categories?.[catIdx];
    if (!cat) { if (status) { status.style.display = 'block'; status.textContent = '分类不存在'; } return; }

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = '正在生成标签…'; }

    try {
      const settingText = w?.setting || '';
      // 电台 App 整体定位
      const radioName = (w.phoneApps?.radio?.name || '').trim();
      const radioDesc = (w.phoneApps?.radio?.desc || '').trim();
      // 当前分类信息
      const catName = (cat.name || '').trim();
      const catDir = (cat.direction || '').trim();
      // 已有标签名（去重）
      const existTagNames = (cat.tags || []).map(t => t.name).filter(Boolean);

      const sysPrompt = `你是一个文字冒险游戏的电台节目设计师。请根据世界观设定和「所属分类」的大方向，为这个分类设计若干个「标签」。

**电台的层级**：分类（大类，如"新闻""情感""音乐"）→ 标签（分类下的小分类细分）→ 具体的一档台（玩家在手机里点开才现场生成）。你现在设计的是**中间那层「标签」**，也就是这个大分类底下的几个小分类方向。比如"新闻"分类下可以有"时政""本地民生""社区简讯""娱乐八卦"这样的标签。

每个标签输出：
- name：标签名称（2-6字，是这个大分类底下的一个具体小方向，别再是宽泛大类，也别是某一档具体节目名）
- desc：这个标签聊什么内容、什么调性（30-60字，用于让 AI 判断某档台该不该挂这个标签）
- guide：规则（一段这个标签固定的写作要求，写清调性、内容取向、注意事项，50-150字。这是这个标签每期都遵循的规则，不是某一期的临时要求。别写开场/正文/结尾的三段结构，那些系统会自动加）
- plays：可用玩法，从下面 6 种里挑 0~3 个（按这个标签的节目性质选，不合适就给空数组）。选项与适用场景：
  - mail（读留言）：情感、闲聊、答疑、吐槽类适合
  - vote（投票）：话题讨论、评选、剧场类适合
  - request（点歌）：音乐类适合
  - call（连线）：情感热线、连麦陪伴类适合
  - lottery（抽奖）：娱乐、互动热闹类适合
  - divination（问卜）：玄学、占卜类适合
- renewMode：续期方式，三选一：
  - unit（独立单元）：每期换题材、彼此独立，最常用
  - serial（连载）：一个长故事分集播，接着上期往下讲
  - free（自由发挥）：参考上期风格自由续

要求：
- 所有标签都要落在「${catName}」这个分类的大方向内，是它底下的细分小方向，别跑题到别的分类去。
- 标签之间彼此不重叠，也不要和"已有标签"重名。
- 贴合世界观题材和电台整体定位。

输出纯 JSON 数组，不要其他内容。格式示例：
[{"name":"时政要闻","desc":"聚焦国家大事、政策要闻、经济动向，正经严肃的时政播报。","guide":"这是一档严肃正经的新闻播报，主播口吻权威正式、字正腔圆，只播报事实、不夹带过多个人评论，保持新闻媒体的专业分寸。","plays":[],"renewMode":"unit"},{"name":"社区简讯","desc":"街坊邻里、家长里短、社区通知，充满烟火气的本地小广播。","guide":"主播口吻亲切热络、像唠家常，带着街坊人情味，可以有点本地腔和小幽默，播报的是社区里的琐碎小事。","plays":["mail"],"renewMode":"unit"}]`;

      const userMsg = `请为以下分类设计 ${count} 个标签。
${prompt ? '\n## 用户额外需求\n' + prompt + '\n' : ''}
## 所属分类（标签必须落在这个大方向内）
分类名称：${catName || '（未命名）'}
分类大方向：${catDir || '（未填写）'}
## 电台整体定位
电台名称：${radioName || '（未命名）'}
电台描述：${radioDesc || '（未填写）'}
## 本分类已有标签（不要重复）
${existTagNames.join('、') || '（无）'}
## 世界观设定
${settingText ? settingText.slice(0, 1500) : '（未提供）'}`;

      _aiRadioTagAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiRadioTagAbort.signal, maxTokens: 3000 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const arr = JSON.parse(cleaned);
      if (!Array.isArray(arr) || !arr.length) throw new Error('AI 返回的不是有效数组');

      // 重新拿最新世界观写入
      const ww = await _getEditingWV();
      if (!ww) throw new Error('世界观已不存在');
      const wcat = ww.phoneApps?.radio?.categories?.[catIdx];
      if (!wcat) throw new Error('分类已不存在');
      if (!Array.isArray(wcat.tags)) wcat.tags = [];
      const existSet = new Set([...existTagNames, ...wcat.tags.map(t => (t.name || ''))].map(n => String(n).toLowerCase()));

      let added = 0;
      for (const item of arr) {
        if (!item || !item.name) continue;
        const nm = String(item.name).trim();
        if (!nm || existSet.has(nm.toLowerCase())) continue;
        // 玩法：过滤到合法 id，去重，最多 3 个
        let plays = Array.isArray(item.plays) ? item.plays.filter(p => _RADIO_PLAY_IDS.includes(p)) : [];
        plays = [...new Set(plays)].slice(0, 3);
        // 续期方式：非法落 unit
        const renewMode = _RADIO_RENEW_MODES.includes(item.renewMode) ? item.renewMode : 'unit';
        wcat.tags.push({
          name: nm,
          desc: String(item.desc || '').trim(),
          guide: String(item.guide || '').trim(),
          wordCount: 2000,
          plays,
          renewMode
        });
        existSet.add(nm.toLowerCase());
        added++;
      }
      if (added === 0) throw new Error('生成的标签都与已有标签重名');

      await _saveEditingWV(ww);
      window.__wvEditingCache = ww;
      overlay?.remove();
      // 刷新分类编辑器界面（回到当前分类）
      const catsOverlay = document.getElementById('radio-cats-editor-overlay');
      if (catsOverlay) _radioOpenCatEditor(ww, catIdx);
      UI.showToast(`已生成 ${added} 个标签`, 2200);
    } catch(e) {
      if (e.name === 'AbortError') { if (status) status.textContent = '已取消'; return; }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiRadioTagAbort = null;
    }
  }

  // ===== AI 生成直播品类（phoneApps.video.liveCats，生成 name+desc+plays）=====
  let _aiLiveCatAbort = null;
  const _LIVE_PLAY_IDS = ['call','pk','cart'];

  function aiGenerateLiveCats() {
    const html = `
    <div id="ai-livecat-gen-overlay" style="position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-livecat-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成直播品类</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-livecat-gen-prompt" rows="3" placeholder="例如：多来点才艺类、或贴合修真世界的特色直播" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin:12px 0 4px">生成数量</label>
        <input type="number" id="ai-livecat-gen-count" value="3" min="1" max="10" style="width:80px;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:13px">
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">按世界观基调生成直播品类（含名称、调性、可用玩法），追加到自建品类。生成后可进各品类微调。</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-livecat-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-livecat-gen-btn" onclick="Worldview._doAiGenerateLiveCats()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-livecat-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  async function _doAiGenerateLiveCats() {
    const overlay = document.getElementById('ai-livecat-gen-overlay');
    const btn = document.getElementById('ai-livecat-gen-btn');
    const status = document.getElementById('ai-livecat-gen-status');
    const prompt = document.getElementById('ai-livecat-gen-prompt')?.value?.trim() || '';
    let count = parseInt(document.getElementById('ai-livecat-gen-count')?.value) || 3;
    count = Math.max(1, Math.min(10, count));

    const w = await _getEditingWV();
    if (!w) { if (status) { status.style.display = 'block'; status.textContent = '请先选择世界观'; } return; }

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = '正在生成直播品类…'; }

    try {
      const settingText = w?.setting || '';
      // 视频/直播 App 整体定位
      const videoName = (w.phoneApps?.video?.name || '').trim();
      const videoDesc = (w.phoneApps?.video?.desc || '').trim();
      // 已有品类名（预设 + 自建）供去重
      const customNames = (w.phoneApps?.video?.liveCats?.categories || []).map(c => c.name).filter(Boolean);
      const existNames = [..._LIVE_PRESET_TAG_NAMES, ...customNames];

      const sysPrompt = `你是一个文字冒险游戏的直播平台品类设计师。请根据世界观设定，设计若干个直播「品类」（直播间的类型）。

参考现实直播平台的品类：游戏直播、唱歌、跳舞、带货、颜值聊天、兴趣陪伴、ASMR、答疑咨询等。你要按这个世界观的题材，设计契合这个世界的直播品类。

每个品类输出：
- name：品类名称（2-6字，一个直播间类型，如"斗法实况""古琴雅奏""灵材带货"）
- desc：这个品类的直播间在播什么、什么调性（30-60字）
- plays：可用玩法，从下面 3 种里挑 0~2 个（按品类性质选，不合适就给空数组）：
  - call（连麦连线）：观众付费上麦和主播一对一聊，适合聊天陪伴、才艺互动类
  - pk（礼物 PK）：和别的主播连麦battle刷礼物冲榜，适合游戏、才艺、颜值类
  - cart（购物车带货）：挂商品观众下单，适合带货卖货类

要求：
- 品类要贴合世界观题材，是这个世界的直播平台会有的直播类型。
- 品类之间不重叠，也不要和"已有品类"重名。

输出纯 JSON 数组，不要其他内容。格式示例：
[{"name":"斗法实况","desc":"主播现场演示修炼心得、法术对拆或秘境探险实况，边打边讲解，热血刺激。","plays":["pk"]},{"name":"灵材带货","desc":"主播上架各类灵草、法器、丹药，边讲功效边卖货，观众可直接下单。","plays":["cart"]}]`;

      const userMsg = `请为以下世界观设计 ${count} 个直播品类。
${prompt ? '\n## 用户额外需求\n' + prompt + '\n' : ''}
## 直播平台整体定位
平台名称：${videoName || '（未命名）'}
平台描述：${videoDesc || '（未填写）'}
## 已有品类（不要重复）
${existNames.join('、') || '（无）'}
## 世界观设定
${settingText ? settingText.slice(0, 1500) : '（未提供）'}`;

      _aiLiveCatAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiLiveCatAbort.signal, maxTokens: 2500 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const arr = JSON.parse(cleaned);
      if (!Array.isArray(arr) || !arr.length) throw new Error('AI 返回的不是有效数组');

      // 重新拿最新世界观写入
      const ww = await _getEditingWV();
      if (!ww) throw new Error('世界观已不存在');
      ww.phoneApps = ww.phoneApps || {};
      ww.phoneApps.video = ww.phoneApps.video || {};
      ww.phoneApps.video.liveCats = ww.phoneApps.video.liveCats || {};
      if (!Array.isArray(ww.phoneApps.video.liveCats.categories)) ww.phoneApps.video.liveCats.categories = [];
      const existSet = new Set([...existNames, ...ww.phoneApps.video.liveCats.categories.map(c => (c.name || ''))].map(n => String(n).toLowerCase()));

      let added = 0;
      for (const item of arr) {
        if (!item || !item.name) continue;
        const nm = String(item.name).trim();
        if (!nm || existSet.has(nm.toLowerCase())) continue;
        let plays = Array.isArray(item.plays) ? item.plays.filter(p => _LIVE_PLAY_IDS.includes(p)) : [];
        plays = [...new Set(plays)].slice(0, 2);
        ww.phoneApps.video.liveCats.categories.push({
          name: nm,
          desc: String(item.desc || '').trim(),
          plays
        });
        existSet.add(nm.toLowerCase());
        added++;
      }
      if (added === 0) throw new Error('生成的品类都与已有品类重名');

      await _saveEditingWV(ww);
      window.__wvEditingCache = ww;
      overlay?.remove();
      // 刷新直播品类编辑器界面
      const catsOverlay = document.getElementById('live-cats-editor-overlay');
      if (catsOverlay) _renderLiveCatsEditor(catsOverlay, ww);
      UI.showToast(`已生成 ${added} 个直播品类`, 2200);
    } catch(e) {
      if (e.name === 'AbortError') { if (status) status.textContent = '已取消'; return; }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiLiveCatAbort = null;
    }
  }

  // ===== AI 批量生成事件 =====
  let _aiEventAbort = null;
  async function aiGenerateEvents(mode, chainId) {
    // 收集世界观上下文
    const w = window.__wvEditingCache;
    if (!w) { UI.showToast('请先打开世界观编辑'); return; }

    const genMode = mode || (_wvEventTab === 'chain' ? 'newChain' : 'standalone');
    const title = genMode === 'appendChain' ? 'AI 续写事件链' : (genMode === 'newChain' ? 'AI 生成事件链' : 'AI 生成事件');
    const placeholder = genMode === 'standalone' ? '例如：生成几个日常生活事件和一个主线危机事件' : '例如：围绕某个势力博弈设计一条连续主线';
    const countVal = genMode === 'standalone' ? 5 : 5;
    const tipText = genMode === 'standalone' ? '生成可复用的独立事件，不会强制串联。' : (genMode === 'appendChain' ? '会从当前事件链最后一个事件继续向后写。' : '会自动用"上一事件结束词"触发下一事件。');

    // 弹窗让用户输入需求和数量
    const html = `
    <div id="ai-event-gen-overlay" data-mode="${Utils.escapeHtml(genMode)}" data-chain-id="${Utils.escapeHtml(chainId || '')}" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)document.getElementById('ai-event-gen-overlay')?.remove()">
      <div style="background:var(--bg);border-radius:var(--radius);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> ${title}</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="ai-event-gen-prompt" rows="3" placeholder="${placeholder}" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:12px;margin-top:12px">
          <div style="flex:1">
            <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成数量</label>
            <input type="number" id="ai-event-gen-count" value="${countVal}" min="1" max="10" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box">
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">${tipText}</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('ai-event-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="ai-event-gen-btn" onclick="Worldview._doAiGenerateEvents()" style="padding:8px 14px;border:none;border-radius:var(--radius);background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="ai-event-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  async function _doAiGenerateEvents() {
    const overlay = document.getElementById('ai-event-gen-overlay');
    const btn = document.getElementById('ai-event-gen-btn');
    const status = document.getElementById('ai-event-gen-status');
    const prompt = document.getElementById('ai-event-gen-prompt')?.value?.trim() || '';
    const count = Math.max(1, Math.min(10, parseInt(document.getElementById('ai-event-gen-count')?.value) || 5));
    const genMode = overlay?.dataset?.mode || (_wvEventTab === 'chain' ? 'newChain' : 'standalone');
    const appendChainId = overlay?.dataset?.chainId || '';

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = `正在生成 ${count} 个事件…`; }

    const w = window.__wvEditingCache;
    const settingText = w?.setting || '';
    const regionNames = (w?.regions || []).map(r => r.name).filter(Boolean);
    const factionNames = (w?.regions || []).flatMap(r => (r.factions || []).map(f => f.name)).filter(Boolean);
    const npcNames = [
      ...(w?.globalNpcs || []).map(n => n.name),
      ...(w?.regions || []).flatMap(r => (r.factions || []).flatMap(f => (f.npcs || []).map(n => n.name)))
    ].filter(Boolean);
    const existingEvents = eventsData.map(e => e.name).filter(Boolean);
    const existingChains = [...new Map(eventsData.filter(e => e.chainId).map(e => [e.chainId, e.chainName || '未命名事件链'])).values()];
    const appendEvents = appendChainId ? eventsData.filter(e => e.chainId === appendChainId).sort((a, b) => Number(a.chainIndex || 0) - Number(b.chainIndex || 0)) : [];
    const appendChainName = appendEvents[0]?.chainName || '';
    const lastEvent = appendEvents[appendEvents.length - 1] || null;

    const commonFields = `字段格式要求：\n- keys 使用中文逗号或英文逗号分隔都可以，但不要换行。\n- completeKey 只能包含英文大写字母、数字、下划线，格式必须是 __EVENT_COMPLETE_XXXX__。\n- content 不要包含 completeKey。\n- content 不要对玩家或NPC发号施令，不要写"玩家必须……""NPC会……"。只能写环境、局势、压力、线索和可能方向。\n- 不要输出 Markdown。\n- 不要输出注释。\n- 不要输出解释。`;

    const standaloneSys = `你是一个文字冒险游戏的世界观事件设计师。请根据世界观设定，为该世界观生成可复用的关键词触发剧情事件。\n\n这些事件属于"世界观级独立事件"，应当适用于该世界观下的不同对话和不同玩家主线，不要依赖某一次具体对话里刚发生的细节。\n\n事件定位：\n- 事件应来自世界观本身的规则、地区、势力、历史遗留问题、社会结构、禁忌、灾难、传闻或常见冲突。\n- 事件可以作为剧情钩子、环境危机、地区传闻、势力介入、世界规则显现、隐藏历史浮现等。\n- 事件应具有可复用性：换一个对话仍然有机会触发。\n- 不要写成某条主线的直接后续，不要依赖最近聊天里某句临时对话。\n- 应围绕世界观中已有的地区、势力、重要NPC展开，让事件与世界观产生关联。\n- 可以引入新角色或势力，但必须符合世界观设定，更像"世界观中可能存在的人物/组织/现象"。\n\n每个事件需要包含：\n- name：事件名称，简短有力，符合世界观风格。\n- keys：触发关键词，2-4个，逗号分隔。应是玩家在探索这个世界时自然可能提到的词，例如地区名、势力名、传闻、物品、禁忌、职业、灾害、制度等。\n- completeKey：结束关键词，格式为 __EVENT_COMPLETE_事件名缩写__。\n- finishRule：事件结束条件，1-2句话。\n- content：事件内容，100-300字，写给运行时AI看的剧情指令，不是写给玩家看的。content 应描述事件背景、世界规则、地点氛围、势力压力、可浮现的线索、可能的发展方向。不要写任何角色的具体行为、动作、语气、情感反应；角色如何行动由运行时AI根据角色人设自行判断。\n\n要求：\n- 只生成关键词触发事件，不生成数值触发事件。\n- 事件之间可以有关联，但不要强制串成链。\n- 不要和已有事件重复。\n- 不要生成脱离世界观设定的随机桥段。\n${commonFields}\n\n输出纯 JSON 数组。`;

    const chainSys = `你是一个文字冒险游戏的世界观主线事件链设计师。请根据世界观设定，为该世界观生成一条可复用的连续剧情事件链。\n\n这些事件属于"世界观级事件链"，用于表现该世界观中可能长期存在、可被不同对话触发的连续剧情线。它不应依赖某一次具体对话的临时细节，而应来自世界观本身的核心矛盾、地区冲突、势力博弈、历史遗留问题、禁忌规则、社会制度或大型危机。\n\n事件链定位：\n- 事件链是一组按顺序推进的关键词触发事件。\n- 应围绕世界观中已有的地区、势力、重要NPC展开。\n- 可以形成阶段性主线，例如：传闻出现 → 线索确认 → 势力介入 → 危机升级 → 阶段性收束/新钩子。\n- 可以引入新角色或势力，但必须符合世界观设定，并服务于这条世界观级剧情线。\n- 不要依赖当前某次对话里的临时剧情。\n\n链式规则：\n- 事件按数组顺序组成链。\n- 第一个事件由自然关键词触发（地区、传闻、势力、物品、禁忌、灾害等）。\n- 从第二个事件开始，每个事件的 keys 必须包含上一个事件的 completeKey，可再附加1-3个自然关键词。\n- 每个事件的 content 必须承接上一个事件完成后的局面。\n- 每个事件的 completeKey 必须唯一。\n- 最后一个事件可阶段性收束，也可留下下一阶段钩子。\n\n每个事件需要包含：name、keys、completeKey、finishRule、content（content 为舞台布景与剧情压力，不写角色具体反应）。\n${commonFields}\n\n输出纯 JSON 对象，格式：{"chainName":"事件链名称","events":[{"name":"...","keys":"...","completeKey":"__EVENT_COMPLETE_XXXX__","finishRule":"...","content":"..."}]}`;

    const appendSys = `你是一个文字冒险游戏的世界观事件链续写设计师。请根据已有事件链的最后一个事件，继续向后生成新的链式事件。\n\n这些事件属于"世界观级事件链"的追加内容，必须延续原链条，而不是重新开一条新链。\n\n续写规则：\n- 你必须读取已有事件链，尤其是最后一个事件。\n- 新生成的第一个事件，其 keys 必须包含"已有事件链最后一个事件的 completeKey"。\n- 后续新事件继续按链式规则衔接：每个事件的 keys 必须包含上一个新事件的 completeKey。\n- 新事件必须承接原链条已经推进到的局面，不能回到开头，不能另起炉灶。\n- 可以扩大矛盾、引入新角色或势力、揭露更深层原因、推进到下一阶段危机，但必须与原链条和世界观设定有关。\n- 不要重复已有事件链中已经发生过的环节。\n\n每个事件需要包含：name、keys、completeKey（唯一，不与已有重复）、finishRule、content（舞台布景与剧情压力，不写角色具体反应）。\n${commonFields}\n\n输出纯 JSON 数组。`;

    const baseCtx = (typeof WvGenerator !== 'undefined' && WvGenerator._buildWorldContext)
      ? WvGenerator._buildWorldContext(w, '', settingText)
      : `## 世界观设定\n${settingText || '（未提供）'}`;
    const baseUser = `${prompt ? '## 用户额外需求\n' + prompt + '\n\n' : ''}${baseCtx}\n\n${existingEvents.length ? '## 已有事件（不要重复）\n' + existingEvents.join('、') + '\n\n' : ''}${existingChains.length ? '## 已有事件链（不要重复）\n' + existingChains.join('、') + '\n\n' : ''}`;

    let sysPrompt = standaloneSys;
    let userMsg = `请生成 ${count} 个世界观级独立事件。\n\n${baseUser}`;
    if (genMode === 'newChain') {
      sysPrompt = chainSys;
      userMsg = `请生成一条世界观级事件链，包含 ${count} 个事件。\n\n${baseUser}`;
    } else if (genMode === 'appendChain') {
      if (!appendEvents.length || !lastEvent) {
        if (status) status.textContent = '未找到要续写的事件链';
        if (btn) { btn.disabled = false; btn.textContent = '重试'; }
        return;
      }
      sysPrompt = appendSys;
      userMsg = `请为以下世界观级事件链继续追加 ${count} 个事件。\n\n${baseUser}## 原事件链名称\n${appendChainName}\n\n## 原事件链已有事件\n${appendEvents.map((e, i) => `${i + 1}. ${e.name}\nkeys: ${e.keys}\ncompleteKey: ${e.completeKey}\nfinishRule: ${e.finishRule}\ncontent: ${e.content}`).join('\n\n')}\n\n## 链尾事件 completeKey\n${lastEvent.completeKey}`;
    }

    try {
      _aiEventAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiEventAbort.signal, maxTokens: 8000 });

      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.events) ? parsed.events : []);
      if (!Array.isArray(arr) || arr.length === 0) throw new Error('AI 返回的不是有效事件数组');

      const chainId = genMode === 'newChain' ? ('chain_' + Utils.uuid().slice(0, 8)) : (genMode === 'appendChain' ? appendChainId : '');
      const chainName = genMode === 'newChain' ? (parsed.chainName || arr[0]?.chainName || '未命名事件链') : (genMode === 'appendChain' ? appendChainName : '');
      const startIndex = genMode === 'appendChain' ? appendEvents.length : 0;
      let added = 0;
      for (const item of arr) {
        if (!item.name) continue;
        eventsData.push({
          id: 'evt_' + Utils.uuid().slice(0, 8),
          name: item.name || '',
          keys: item.keys || '',
          triggerType: 'keyword',
          attrConditions: [],
          completeKey: item.completeKey || '',
          finishRule: item.finishRule || '',
          content: item.content || '',
          triggerMode: 'event',
          chainId: chainId || '',
          chainName: chainName || '',
          chainIndex: chainId ? startIndex + added : 0
        });
        added++;
      }

      try {
        const ww = await _getEditingWV();
        if (ww) { ww.events = eventsData.slice(); await _saveEditingWV(ww); window.__wvEditingCache = ww; }
      } catch(e) { console.warn('[Worldview] 保存生成事件失败', e); }

      if (genMode !== 'standalone') _wvEventTab = 'chain';
      switchEventTab(_wvEventTab);
      overlay?.remove();
      UI.showToast(`已生成 ${added} 个事件`, 2000);
    } catch(e) {
      if (e.name === 'AbortError') {
        if (status) status.textContent = '已取消';
        return;
      }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      _aiEventAbort = null;
    }
  }

  function addEvent() {
    eventsData.push({
      id: 'evt_' + Utils.uuid().slice(0, 8),
      name: '',
      keys: '',
      triggerType: 'attr',
      attrConditions: [],
      completeKey: '',
      content: '',
      triggerMode: 'event'
    });
    editEvent(eventsData.length - 1);
  }
  // 新建事件链：创建一条空链 + 第一个事件，并打开编辑
  function addEventChain() {
    const chainId = 'chain_' + Utils.uuid().slice(0, 8);
    eventsData.push({
      id: 'evt_' + Utils.uuid().slice(0, 8),
      name: '', keys: '', triggerType: 'keyword', attrConditions: [],
      completeKey: '', finishRule: '', content: '', triggerMode: 'event',
      chainId, chainName: '新建事件链', chainIndex: 0
    });
    _wvEventTab = 'chain';
    editEvent(eventsData.length - 1);
  }
  // 在指定事件链尾部追加节点，自动用上一节点结束词预填关键词
  function addChainNode(chainId) {
    const chainEvents = eventsData.filter(e => e.chainId === chainId).sort((a, b) => Number(a.chainIndex || 0) - Number(b.chainIndex || 0));
    if (!chainEvents.length) return;
    const last = chainEvents[chainEvents.length - 1];
    eventsData.push({
      id: 'evt_' + Utils.uuid().slice(0, 8),
      name: '', keys: last.completeKey || '', triggerType: 'keyword', attrConditions: [],
      completeKey: '', finishRule: '', content: '', triggerMode: 'event',
      chainId, chainName: last.chainName || '未命名事件链', chainIndex: Number(last.chainIndex || 0) + 1
    });
    editEvent(eventsData.length - 1);
  }
  function _isEditingHiddenWv() {
    try { return isHiddenWv(window.__wvEditingCache); } catch(_) { return false; }
  }
  function syncEventTriggerTypeUI() {
    const typeEl = document.getElementById('wv-event-modal-trigger-type');
    const typeRow = typeEl?.closest('.form-group');
    const hidden = _isEditingHiddenWv();
    if (hidden && typeEl) typeEl.value = 'keyword';
    if (typeRow) typeRow.classList.toggle('hidden', hidden);
    const type = hidden ? 'keyword' : (typeEl?.value || 'keyword');
    document.getElementById('wv-event-keyword-row')?.classList.toggle('hidden', type !== 'keyword');
    document.getElementById('wv-event-attr-row')?.classList.toggle('hidden', type !== 'attr');
    document.getElementById('wv-event-time-row')?.classList.toggle('hidden', type !== 'time');
    if (type === 'attr') {
      if (_eventAttrConditionsDraft.length === 0) addEventAttrCondition();
      else _renderEventAttrConditions();
    }
  }
  function _renderEventAttrConditions() {
    const box = document.getElementById('wv-event-attr-conditions');
    if (!box) return;
    const opts = _collectEventAttrOptions();
    if (!opts.length) {
      box.innerHTML = '<div style="font-size:12px;color:var(--danger);padding:10px;border:1px dashed var(--border);border-radius:8px">请先在玩法配置里添加全局属性或角色属性。</div>';
      return;
    }
    box.innerHTML = _eventAttrConditionsDraft.map((c, i) => {
      const curVal = c.scope === 'allCharacters' ? `allCharacters|||${c.attrName || ''}` : (c.scope === 'character' ? `character||${c.targetKey || ''}||${c.attrId || ''}` : `global|||${c.attrId || ''}`);
      const optHtml = opts.map(o => `<option value="${Utils.escapeHtml(o.value)}" ${o.value === curVal ? 'selected' : ''}>${Utils.escapeHtml(o.label)}</option>`).join('');
      const isAll = c.scope === 'allCharacters';
      const matchModeHtml = isAll ? `<select onchange="Worldview.updateEventAttrCondition(${i}, 'matchMode', this.value)" style="flex:1;min-width:0;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)"><option value="all" ${(c.matchMode || 'all') === 'all' ? 'selected' : ''}>全部满足</option><option value="any" ${c.matchMode === 'any' ? 'selected' : ''}>任一满足</option></select>` : '';
      return `<div style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">
        <div style="display:flex;gap:8px;margin-bottom:8px;align-items:flex-start">
          <select onchange="Worldview.updateEventAttrCondition(${i}, 'attr', this.value)" style="flex:1;min-width:0;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)">${optHtml}</select>
          <button type="button" onclick="Worldview.removeEventAttrCondition(${i})" style="width:32px;height:32px;border:1px solid var(--danger);background:none;border-radius:6px;color:var(--danger);cursor:pointer;flex-shrink:0">×</button>
        </div>
        ${isAll ? `<div style="display:flex;gap:8px;margin-bottom:8px">${matchModeHtml}</div>` : ''}
        <div style="display:flex;gap:8px;align-items:center">
          <select onchange="Worldview.updateEventAttrCondition(${i}, 'operator', this.value)" style="width:60px;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)">${['>','>=','<','<=','==','!='].map(op => `<option value="${op}" ${c.operator === op ? 'selected' : ''}>${op}</option>`).join('')}</select>
          <input type="number" value="${Utils.escapeHtml(c.value ?? 0)}" oninput="Worldview.updateEventAttrCondition(${i}, 'value', this.value)" style="flex:1;min-width:0;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)">
        </div>
      </div>`;
    }).join('');
    _eventAttrConditionsDraft.forEach((c, i) => {
      if (!c.attrId && !c.attrName && opts[0]) updateEventAttrCondition(i, 'attr', opts[0].value, true);
     });
  }
  function addEventAttrCondition() {
    const opts = _collectEventAttrOptions();
    if (!opts.length) { UI.showToast('请先配置自定义属性', 1800); return; }
    const o = opts[0];
    _eventAttrConditionsDraft.push({ scope: o.scope, targetKey: o.targetKey, targetName: o.targetName, attrId: o.attrId, attrName: o.attrName, operator: '>=', value: 0 });
    _renderEventAttrConditions();
  }
  function updateEventAttrCondition(i, field, value, silent) {
    const c = _eventAttrConditionsDraft[i];
    if (!c) return;
    if (field === 'attr') {
      const o = _collectEventAttrOptions().find(x => x.value === value);
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
    if (!silent && (field === 'attr' || field === 'matchMode')) _renderEventAttrConditions();
  }
  function removeEventAttrCondition(i) {
    _eventAttrConditionsDraft.splice(i, 1);
    _renderEventAttrConditions();
  }
  function editEvent(i) {
    _editEventIdx = i;
    const ev = eventsData[i] || {};
    document.getElementById('wv-event-modal-title').textContent = ev.name ? '编辑事件' : '新建事件';
    // 事件链名称行：仅在事件属于链时显示
    const chainRow = document.getElementById('wv-event-chain-row');
    const chainNameEl = document.getElementById('wv-event-chain-name');
    if (chainRow) chainRow.classList.toggle('hidden', !ev.chainId);
    if (chainNameEl) chainNameEl.value = ev.chainName || '';
    document.getElementById('wv-event-modal-name').value = ev.name || '';
    document.getElementById('wv-event-modal-keys').value = ev.keys || '';
    const triggerType = _isEditingHiddenWv() ? 'keyword' : (ev.triggerType || 'keyword');
    const typeEl = document.getElementById('wv-event-modal-trigger-type');
    if (typeEl) typeEl.value = triggerType;
    _eventAttrConditionsDraft = Array.isArray(ev.attrConditions) ? JSON.parse(JSON.stringify(ev.attrConditions)) : [];
    // 时间触发字段回填
    const timeStartEl = document.getElementById('wv-event-modal-time-start');
    const timeEndEl = document.getElementById('wv-event-modal-time-end');
    if (timeStartEl) timeStartEl.value = ev.triggerTimeStart || '';
    if (timeEndEl) timeEndEl.value = ev.triggerTimeEnd || '';
    document.getElementById('wv-event-modal-complete-key').value = ev.completeKey || '';
    const finishEl = document.getElementById('wv-event-modal-finish-rule');
    if (finishEl) finishEl.value = ev.finishRule || '';
    document.getElementById('wv-event-modal-content').value = ev.content || '';
    syncEventTriggerTypeUI();
    document.getElementById('wv-event-modal').classList.remove('hidden');
  }
  async function saveEventFromModal() {
    if (_editEventIdx === null) return;
    const prev = eventsData[_editEventIdx] || {};
    const triggerType = _isEditingHiddenWv() ? 'keyword' : (document.getElementById('wv-event-modal-trigger-type')?.value || 'keyword');
    const newChainName = prev.chainId ? ((document.getElementById('wv-event-chain-name')?.value || '').trim() || prev.chainName || '未命名事件链') : (prev.chainName || '');
    eventsData[_editEventIdx] = {
      id: prev.id || ('evt_' + Utils.uuid().slice(0, 8)),
      name: document.getElementById('wv-event-modal-name').value.trim(),
      keys: triggerType === 'keyword' ? document.getElementById('wv-event-modal-keys').value.trim() : '',
      triggerType,
      attrConditions: triggerType === 'attr' ? _eventAttrConditionsDraft.filter(c => c && (c.attrId || c.attrName) && Number.isFinite(Number(c.value))).map(c => ({ ...c, value: Number(c.value), operator: c.operator || '>=' })) : [],
      triggerTimeStart: triggerType === 'time' ? (document.getElementById('wv-event-modal-time-start')?.value.trim() || '') : '',
      triggerTimeEnd: triggerType === 'time' ? (document.getElementById('wv-event-modal-time-end')?.value.trim() || '') : '',
      completeKey: document.getElementById('wv-event-modal-complete-key').value.trim(),
      finishRule: (document.getElementById('wv-event-modal-finish-rule')?.value || '').trim(),
      content: document.getElementById('wv-event-modal-content').value.trim(),
      triggerMode: 'event',
      chainId: prev.chainId || '',
      chainName: newChainName,
      chainIndex: Number(prev.chainIndex || 0)
    };
    // 同步链名到整条链
    if (prev.chainId) {
      eventsData.forEach(e => { if (e && e.chainId === prev.chainId) e.chainName = newChainName; });
    }
    try {
      const w = await _getEditingWV();
      if (w) {
        w.events = eventsData.slice();
        await _saveEditingWV(w);
        window.__wvEditingCache = w;
      }
    } catch(e) { console.warn('[Worldview] 保存事件失败', e); }
    _renderEvents(eventsData);
    closeEventModal();
  }
  async function deleteEventFromModal() {
    if (_editEventIdx === null) return;
    const nm = (eventsData[_editEventIdx]?.name || '该事件');
    if (!await UI.showConfirm('删除事件', `确定删除「${nm}」？此操作不可撤销。`)) return;
    eventsData.splice(_editEventIdx, 1);
    try {
      const w = await _getEditingWV();
      if (w) {
        w.events = eventsData.slice();
        await _saveEditingWV(w);
        window.__wvEditingCache = w;
      }
    } catch(e) { console.warn('[Worldview] 删除事件失败', e); }
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
    _applyStatusBarSkin(w);
    try { Chat.setWorldview(_buildSettingWithExtras(w)); } catch(e) { console.warn('[Worldview] sync prompt 失败', e); }
    try {
      const flatNpcs = [];
      const flatFacs = [];
      const flatRegions = [];
      (w.regions || []).forEach(reg => {
          flatRegions.push({ id: reg.id, name: reg.name, summary: reg.summary, detail: reg.detail });
          (reg.factions || []).forEach(fac => {
            flatFacs.push({ id: fac.id, name: fac.name, summary: fac.summary, detail: fac.detail, regionName: reg.name, regionId: reg.id });
            (fac.npcs || []).forEach(npc => {
              flatNpcs.push({ ...npc, faction: fac.name, regions: [reg.id || reg.name], regionName: reg.name, factionName: fac.name });
            });
          });
      });
      NPC.init({ npcs: flatNpcs, factions: flatFacs, regions: flatRegions });
    } catch(e) { console.warn('[Worldview] sync NPC 失败', e); }
  }

  // ---------- 保存 ----------
  async function save(opts) {
    const silent = !!(opts && opts.silent);
    if (!editingWorldviewId) return;

    // v632：编辑的是世界书，直接回写 lorebooks store
    if (_isLorebookEditing(editingWorldviewId)) {
      if (typeof Lorebook === 'undefined') return;
      const lbId = _lbIdOf(editingWorldviewId);
      const lb = (await Lorebook.get(lbId)) || { id: lbId };
      // v632.1：先保留 globalNpcs（防止 lb 是新对象时丢字段）
      lb.globalNpcs = Array.isArray(lb.globalNpcs) ? lb.globalNpcs : [];
      lb.festivals = festivalsData.slice();
      lb.knowledges = customsData.concat(knowledgesData).map(k => ({
        id: k.id,
        name: k.name || '',
        content: k.content || '',
        enabled: (k.enabled === undefined || k.enabled === null) ? true : !!k.enabled,
        keywordTrigger: !!k.keywordTrigger,
        keys: k.keywordTrigger ? (k.keys || '') : '',
        position: k.position || 'system_top',
        depth: (typeof k.depth === 'number') ? k.depth : 0
      }));
      lb.events = eventsData.slice();
      // name / description 从顶部表单读（如果用户填了）
      const nameEl = document.getElementById('worldview-edit-name');
      const descEl = document.getElementById('worldview-edit-desc');
      if (nameEl && nameEl.value.trim()) lb.name = nameEl.value.trim();
      if (descEl) lb.description = descEl.value;
      await Lorebook.save(lb);
      if (!silent) UI.showToast('已保存世界书');
      return;
    }

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
      if (!silent) UI.showToast('已保存扩展设定');
      return;
    }
    
    // 基础设定
    w.name = document.getElementById('wv-name').value.trim() || '未命名';
    w.description = document.getElementById('wv-description').value.trim();
    w.icon = w.icon || 'world'; // 保留原值
    w.setting = document.getElementById('wv-setting').value.trim();
    // 货币改为多货币（currencies 数组），由 add/update/deleteCurrency 实时保存，这里不覆盖
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
    const skinInput = document.getElementById('wv-statusbar-skin');
    if (skinInput && !_isBuiltinWorldview(w)) w.statusBarSkin = skinInput.value || 'terminal';
    // 读取前强制从分字段同步 hidden，避免 oninput 时序遗漏导致存旧值
    try { if (typeof _syncStartTimeHidden === 'function') _syncStartTimeHidden(); } catch(_) {}
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
    
     if (!silent) UI.showToast('保存成功');
     // 同步到运行时（如果改的就是当前激活世界观，AI 立刻看到新设定）
     await _syncRuntime(w);
     // silent 模式下跳过 load()——避免和返回路径上的 showPanel('worldview') 触发的列表刷新竞态（iOS 上会导致列表空白）
     if (!silent) await load();
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
                <span style="position:relative;display:inline-flex;flex-shrink:0">
                  <input type="checkbox" id="hs-warn-dismiss" class="circle-check">
                  <span class="circle-check-ui"></span>
                </span>
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
      // 应用状态栏皮肤
      if (w) _applyStatusBarSkin(w);
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
    } else {
      // 无世界观：优先读全局绑定，否则 fallback 霜白
      try {
        const binding = await DB.get('gameState', 'globalThemeBinding');
        if (binding && binding.value) {
          _applyBoundTheme(binding.value);
        } else {
          _applyBoundTheme('builtin:霜白');
        }
      } catch(_) {
        _applyBoundTheme('builtin:霜白');
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
    // 无世界观时 header 被隐藏，sidebar-nav 直接顶到最上面，需补灵动岛/刘海安全区
    try { document.getElementById('sidebar')?.classList.toggle('sidebar-no-header', isNoWv); } catch(_) {}
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
    _renderViewerGameplay(w);
    // 心动模拟隐藏玩法tab
    const gpBtn = document.querySelector('.wv-viewer-tab-btn[data-tab="v-gameplay"]');
    if (gpBtn) gpBtn.style.display = (id === 'wv_heartsim') ? 'none' : '';
    switchViewerTab('v-basic');
    UI.showPanel('wv-viewer', 'forward');
    
    // 自愈兜底：切主题后查看页内容区可能高度为 0，强制清除隐藏状态
    requestAnimationFrame(() => {
      try {
        const basic = document.getElementById('wv-viewer-tab-v-basic');
        if (!basic) return;
        const visible = basic.offsetHeight > 0 && !basic.classList.contains('hidden');
        if (!visible) {
          const clearVis = (el) => {
            if (!el) return;
            el.classList.remove('hidden');
            ['opacity','transform','display','visibility','height','max-height'].forEach(p => el.style.removeProperty(p));
          };
          document.querySelectorAll('.wv-viewer-tab-content').forEach(clearVis);
          let node = basic;
          const panel = document.getElementById('panel-wv-viewer');
          while (node && node !== panel) { clearVis(node); node = node.parentElement; }
          clearVis(panel);
          switchViewerTab('v-basic');
        }
      } catch(_) {}
    });
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
    html += `<div style="margin-bottom:24px">
      <div style="font-size:20px;font-weight:700;color:var(--accent);margin-bottom:6px">${Utils.escapeHtml(w.name || '未命名')}</div>
      ${w.description ? `<div class="md-content" style="font-size:13px;line-height:1.8;color:var(--text-secondary)">${Markdown.render(w.description)}</div>` : ''}
    </div>`;
    if (w.setting) {
      html += `<div style="margin-bottom:24px">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:8px">世界观设定</div>
        <div class="md-content" style="font-size:13px;line-height:2;color:var(--text);background:var(--bg-tertiary);padding:16px;border-radius:12px">${Markdown.render(w.setting)}</div>
      </div>`;
    }
    const _curs = _getCurrencies(w);
    if (_curs.length) {
      html += `<div style="margin-bottom:24px">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:8px">通用货币</div>
        ${_curs.map(c => `<div style="background:var(--bg-tertiary);padding:14px;border-radius:12px;margin-bottom:8px">
          <div style="font-size:15px;font-weight:600;color:var(--accent);margin-bottom:4px">${Utils.escapeHtml(c.name)}</div>
          ${(c.desc || '').trim() ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary)">${Markdown.render(c.desc)}</div>` : ''}
        </div>`).join('')}
      </div>`;
    }
    if (!w.setting && !w.description && !_curs.length) {
      html += '<div style="text-align:center;color:var(--text-secondary);padding:40px 0;font-size:13px">暂无设定内容</div>';
    }
    el.innerHTML = html;
  }
  
  function _renderViewerRegions(w) {
    const el = document.getElementById('wv-viewer-regions');
    if (!el) return;
    const regions = w.regions || [];
    if (regions.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:40px 0;font-size:13px">暂无地区数据</div>';
      return;
    }
    let html = '';
    regions.forEach(reg => {
      html += `<div style="margin-bottom:20px">
        <div style="font-size:16px;font-weight:700;color:var(--accent);margin-bottom:6px">${Utils.escapeHtml(reg.name || '未命名')}</div>
        ${reg.summary ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary);margin-bottom:8px">${Markdown.render(reg.summary)}</div>` : ''}
        ${reg.detail ? `<div class="md-content" style="font-size:13px;line-height:2;color:var(--text);background:var(--bg-tertiary);padding:14px;border-radius:12px;margin-bottom:10px">${Markdown.render(reg.detail)}</div>` : ''}`;
      
      const factions = reg.factions || [];
      if (factions.length > 0) {
        html += '<div style="margin-left:12px;padding-left:14px;margin-top:10px">';
        factions.forEach(fac => {
          html += `<div style="margin-bottom:14px">
            <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px">${Utils.escapeHtml(fac.name || '未命名')}</div>
            ${fac.summary ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary);margin-bottom:6px">${Markdown.render(fac.summary)}</div>` : ''}
            ${fac.detail ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text);background:var(--bg-tertiary);padding:12px;border-radius:10px">${Markdown.render(fac.detail)}</div>` : ''}
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
      container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:40px 0;font-size:13px">无匹配角色</div>';
      return;
    }
    
    let html = '';
    allNPCs.forEach(npc => {
      html += `<div style="background:var(--bg-tertiary);padding:14px;margin-bottom:12px;border-radius:12px">
        <div style="font-size:15px;font-weight:700;color:var(--accent);margin-bottom:2px">${Utils.escapeHtml(npc.name || '未命名')}${npc.aliases ? ` <span style="font-size:12px;font-weight:normal;color:var(--text-secondary)">（${Utils.escapeHtml(npc.aliases)}）</span>` : ''}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">${Utils.escapeHtml(npc.regionName || '')} · ${Utils.escapeHtml(npc.factionName || '')}</div>
        ${npc.summary ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary);margin-bottom:8px">${Markdown.render(npc.summary)}</div>` : ''}
        ${npc.detail ? `<div class="md-content" style="font-size:13px;line-height:2;color:var(--text);background:var(--bg-secondary);padding:12px;border-radius:10px">${Markdown.render(npc.detail)}</div>` : ''}
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
    html += '<div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:10px">节日设定</div>';
    if (festivals.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px;margin-bottom:24px">暂无节日</div>';
    } else {
      festivals.forEach(f => {
        html += `<div style="background:var(--bg-tertiary);padding:12px;margin-bottom:8px;border-radius:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div style="font-size:14px;font-weight:600;color:var(--accent)">${Utils.escapeHtml(f.name || '未命名')}</div>
            <div style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(f.date || '')} ${f.yearly ? '(每年)' : ''}</div>
          </div>
          ${f.content ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text)">${Markdown.render(f.content)}</div>` : ''}
        </div>`;
      });
      html += '<div style="margin-bottom:24px"></div>';
    }
    
    // 常驻条目
    _migrateToKnowledges(w);
    const customs = (w.knowledges || []).filter(k => !k.keywordTrigger);
    html += '<div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:10px">常驻条目</div>';
    if (customs.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px;margin-bottom:24px">暂无常驻条目</div>';
    } else {
      customs.forEach(c => {
        html += `<div style="background:var(--bg-tertiary);padding:12px;margin-bottom:8px;border-radius:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div style="font-size:14px;font-weight:600;color:var(--text)">${Utils.escapeHtml(c.name || '未命名')}</div>
            <div style="font-size:11px;padding:2px 8px;border-radius:10px;${c.enabled ? 'background:var(--accent);color:#111' : 'background:var(--bg-secondary);color:var(--text-secondary)'}">${c.enabled ? '启用' : '未启用'}</div>
          </div>
          ${c.content ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text)">${Markdown.render(c.content)}</div>` : ''}
        </div>`;
      });
      html += '<div style="margin-bottom:24px"></div>';
    }

    // 动态条目
    const knowledges = (w.knowledges || []).filter(k => !!k.keywordTrigger);
    html += '<div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:10px">动态条目</div>';
    if (knowledges.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px;margin-bottom:24px">暂无动态条目</div>';
    } else {
      knowledges.forEach(k => {
        const keys = (k.keys || '').trim();
        const keyTags = keys
          ? keys.split(/[,，\s]+/).filter(Boolean).map(t => `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 8px;border-radius:6px;margin-right:6px;margin-top:3px">${Utils.escapeHtml(t)}</span>`).join('')
          : '<span style="font-size:11px;color:var(--text-secondary)">无关键词</span>';
        html += `<div style="background:var(--bg-tertiary);padding:12px;margin-bottom:8px;border-radius:10px">
          <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:6px">${Utils.escapeHtml(k.name || '未命名')}</div>
          <div style="margin-bottom:8px">${keyTags}</div>
          ${k.content ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text)">${Markdown.render(k.content)}</div>` : ''}
        </div>`;
      });
      html += '<div style="margin-bottom:24px"></div>';
    }

    // 事件条目
    const events = w.events || [];
    html += '<div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:10px">事件</div>';
    if (events.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px">暂无事件</div>';
    } else {
      events.forEach(ev => {
        const triggerKeys = (ev.keys || '').trim();
        const endKeys = (ev.endKeys || '').trim();
        const triggerTags = triggerKeys
          ? triggerKeys.split(/[,，\s]+/).filter(Boolean).map(t => `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 8px;border-radius:6px;margin-right:6px;margin-top:3px">${Utils.escapeHtml(t)}</span>`).join('')
          : '<span style="font-size:11px;color:var(--text-secondary)">无触发词</span>';
        const endTags = endKeys
          ? endKeys.split(/[,，\s]+/).filter(Boolean).map(t => `<span style="display:inline-block;font-size:11px;background:color-mix(in srgb, var(--accent) 15%, var(--bg-secondary));color:var(--accent);padding:2px 8px;border-radius:6px;margin-right:6px;margin-top:3px">${Utils.escapeHtml(t)}</span>`).join('')
          : '<span style="font-size:11px;color:var(--text-secondary)">无结束词</span>';
        html += `<div style="background:var(--bg-tertiary);padding:12px;margin-bottom:8px;border-radius:10px">
          <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:8px">${Utils.escapeHtml(ev.name || '未命名')}</div>
          <div style="margin-bottom:4px"><span style="font-size:11px;color:var(--text-secondary);margin-right:6px">触发</span>${triggerTags}</div>
          <div style="margin-bottom:8px"><span style="font-size:11px;color:var(--text-secondary);margin-right:6px">结束</span>${endTags}</div>
          ${ev.content ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text)">${Markdown.render(ev.content)}</div>` : ''}
        </div>`;
      });
    }
    el.innerHTML = html;
  }

  function _renderViewerGameplay(w) {
    const el = document.getElementById('wv-viewer-gameplay');
    if (!el) return;
    let html = '';

    // 手机配置
    const _pa = w.phoneApps || {};
    const _paTk = _pa.takeout || {}; const _paSh = _pa.shop || {}; const _paFm = _pa.forum || {};
    if (_paTk.name || _paSh.name || _paFm.name) {
      html += '<div style="font-size:15px;font-weight:bold;color:var(--text);margin-bottom:8px;display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></svg> 手机配置</div>';
      if (_paTk.name) {
        html += `<div style="background:var(--bg-tertiary);padding:10px;border-radius:8px;margin-bottom:6px">
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px">短时效商城</div>
          <div style="font-size:14px;font-weight:bold;color:var(--accent);margin-bottom:4px">${Utils.escapeHtml(_paTk.name)}</div>
          ${_paTk.desc ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary)">${Markdown.render(_paTk.desc)}</div>` : ''}
        </div>`;
      }
      if (_paSh.name) {
        html += `<div style="background:var(--bg-tertiary);padding:10px;border-radius:8px;margin-bottom:6px">
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px">长时效商城</div>
          <div style="font-size:14px;font-weight:bold;color:var(--accent);margin-bottom:4px">${Utils.escapeHtml(_paSh.name)}</div>
          ${_paSh.desc ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary)">${Markdown.render(_paSh.desc)}</div>` : ''}
        </div>`;
      }
      if (_paFm.name) {
        html += `<div style="background:var(--bg-tertiary);padding:10px;border-radius:8px;margin-bottom:6px">
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px">信息载体</div>
          <div style="font-size:14px;font-weight:bold;color:var(--accent);margin-bottom:4px">${Utils.escapeHtml(_paFm.name)}</div>
          ${_paFm.desc ? `<div class="md-content" style="font-size:12px;line-height:1.8;color:var(--text-secondary)">${Markdown.render(_paFm.desc)}</div>` : ''}
        </div>`;
      }
      html += '<div style="margin-bottom:16px"></div>';
    }

    // 自定义属性
    const gp = w.gameplay || { globalAttrs: [], characterAttrs: [] };
    const globalAttrs = gp.globalAttrs || [];
    const charAttrs = gp.characterAttrs || [];

    html += '<div style="font-size:15px;font-weight:bold;color:var(--text);margin-bottom:8px;display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/><circle cx="12" cy="12" r="10"/></svg> 自定义属性</div>';

    if (globalAttrs.length === 0 && charAttrs.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px;margin-bottom:16px">暂无自定义属性</div>';
    } else {
      if (globalAttrs.length > 0) {
        html += '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">用户 / 全局属性</div>';
        globalAttrs.forEach(a => {
          html += `<div class="card" style="padding:8px 10px;margin-bottom:4px;border:1px solid var(--border);border-radius:6px;display:flex;justify-content:space-between;align-items:center">
            <div style="font-size:13px;color:var(--text)">${Utils.escapeHtml(a.name || '未命名')}</div>
            <div style="font-size:12px;color:var(--text-secondary)">${a.type === 'number' ? `数值 (初始:${a.initial ?? 0})` : a.type === 'text' ? '文本' : a.type === 'toggle' ? '开关' : a.type || '数值'}</div>
          </div>`;
        });
        html += '<div style="margin-bottom:12px"></div>';
      }
      if (charAttrs.length > 0) {
        html += '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">角色属性</div>';
        charAttrs.forEach(c => {
          html += `<div style="background:var(--bg-tertiary);padding:10px;border-radius:8px;margin-bottom:8px">
            <div style="font-size:13px;font-weight:bold;color:var(--accent);margin-bottom:6px">${Utils.escapeHtml(c.targetName || '未命名角色')}</div>`;
          (c.attrs || []).forEach(a => {
            html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
              <div style="font-size:12px;color:var(--text)">${Utils.escapeHtml(a.name || '未命名')}</div>
              <div style="font-size:11px;color:var(--text-secondary)">${a.type === 'number' ? `数值 (初始:${a.initial ?? 0})` : a.type === 'text' ? '文本' : a.type === 'toggle' ? '开关' : a.type || '数值'}</div>
            </div>`;
          });
          html += '</div>';
        });
      }
      html += '<div style="margin-bottom:16px"></div>';
    }

    // 任务系统（读 gp.taskSystem.phases，每个阶段内含 types 任务类型）
    const _ts = gp.taskSystem || {};
    const phases = Array.isArray(_ts.phases) ? _ts.phases : [];
    html += '<div style="font-size:15px;font-weight:bold;color:var(--text);margin-bottom:8px;display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> 任务系统</div>';
    if (phases.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px;margin-bottom:16px">暂无任务阶段</div>';
    } else {
      phases.forEach((ph, pi) => {
        const types = Array.isArray(ph.types) ? ph.types : [];
        const cr = ph.completionReward || { mode: 'none' };
        let crSummary = '无';
        if (cr.mode === 'attr' && cr.attr) crSummary = `${cr.attr} ${cr.value >= 0 ? '+' : ''}${cr.value || 0}`;
        else if (cr.mode === 'free') crSummary = '自由奖励';
        let typeHtml = '';
        if (types.length === 0) {
          typeHtml = '<div style="font-size:12px;color:var(--text-secondary);padding:6px 0">暂无任务类型</div>';
        } else {
          typeHtml = types.map(t => {
            let rewardTag = '';
            if (t.rewardMode === 'attr' && t.rewardAttr) rewardTag = `<span style="font-size:11px;color:var(--accent);background:color-mix(in srgb, var(--accent) 15%, transparent);padding:1px 6px;border-radius:4px;flex-shrink:0">${Utils.escapeHtml(t.rewardAttr)} ${t.rewardValue >= 0 ? '+' : ''}${t.rewardValue || 0}</span>`;
            else if (t.rewardMode === 'free') rewardTag = `<span style="font-size:11px;color:var(--accent);background:color-mix(in srgb, var(--accent) 15%, transparent);padding:1px 6px;border-radius:4px;flex-shrink:0">自由奖励</span>`;
            return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0">
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;color:var(--text);font-weight:600">${Utils.escapeHtml(t.label || '未命名类型')}</div>
                ${t.desc ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${Utils.escapeHtml(t.desc)}</div>` : ''}
              </div>
              ${rewardTag}
            </div>`;
          }).join('');
        }
        html += `<div class="card" style="padding:12px;margin-bottom:8px;border:1px solid var(--border);border-radius:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div style="font-size:14px;font-weight:bold;color:var(--accent)">${Utils.escapeHtml(ph.name || ('阶段 ' + (pi + 1)))}</div>
            <div style="font-size:11px;color:var(--text-secondary)">每批${ph.batchSize || 3} · 共${ph.totalTasks || 10}</div>
          </div>
          ${typeHtml}
          <div style="font-size:11px;color:var(--text-secondary);margin-top:8px;padding-top:6px;border-top:1px solid var(--border)">阶段完成奖励：${Utils.escapeHtml(crSummary)}</div>
        </div>`;
      });
    }

    // 历法系统（折叠展示）
    const cal = gp.calendarSystem;
    if (cal) {
      const _wk = (cal.weekDayNames || []).map((n, i) => {
        const rest = (cal.weekDayTypes || [])[i] === 'rest';
        return `<span style="display:inline-block;font-size:11px;padding:2px 8px;margin:2px;border-radius:4px;background:${rest ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'var(--bg-tertiary)'};color:${rest ? 'var(--accent)' : 'var(--text-secondary)'}">${Utils.escapeHtml(n)}${rest ? '(休)' : ''}</span>`;
      }).join('');
      const _seasons = (cal.seasons || []).map(se => `<div style="font-size:12px;color:var(--text-secondary);padding:3px 0"><span style="color:var(--text);font-weight:600">${Utils.escapeHtml(se.name || '')}</span>　${(se.months || []).join('/')}月　${Utils.escapeHtml(se.weather || '')}</div>`).join('');
      const _periods = (cal.timePeriods || []).map(tp => `<div style="font-size:12px;color:var(--text-secondary);padding:3px 0"><span style="color:var(--text);font-weight:600">${Utils.escapeHtml(tp.name || '')}</span>　${tp.startHour}时起　${Utils.escapeHtml(tp.desc || '')}</div>`).join('');
      html += `<details style="margin-top:8px;margin-bottom:8px;border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <summary style="font-size:15px;font-weight:bold;color:var(--text);padding:10px 12px;cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/></svg>
          历法系统<span style="font-size:11px;color:var(--text-secondary);font-weight:normal">（点击展开）</span>
        </summary>
        <div style="padding:0 12px 12px">
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">每天 ${cal.hoursPerDay || 24} 小时 · 每周 ${cal.daysPerWeek || (cal.weekDayNames || []).length} 天 · 每年 ${cal.monthsPerYear || 12} 月</div>
          ${_wk ? `<div style="margin-bottom:10px"><div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">星期</div>${_wk}</div>` : ''}
          ${_seasons ? `<div style="margin-bottom:10px"><div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">季节</div>${_seasons}</div>` : ''}
          ${_periods ? `<div><div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">时段</div>${_periods}</div>` : ''}
        </div>
      </details>`;
    }

    if (!html.trim()) {
      html = '<div style="text-align:center;color:var(--text-secondary);padding:24px;font-size:13px">暂无玩法配置</div>';
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
      // 直接应用，不走 withThemeFade 动画（避免与面板切换冲突导致空白）
      const p = Theme.getPreset ? Theme.getPreset(name) : null;
      if (p) {
        const old = Theme.load();
        const cfg = Object.assign({}, p);
        cfg.customPresetName = '';
        cfg.fontMode = old.fontMode || 'default';
        cfg.msgFontSize = old.msgFontSize ?? 13.5;
        Theme.save(cfg);
        Theme.apply(cfg);
      } else {
        // fallback：走原路径
        Theme.applyPreset(name);
      }
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

  // ---------- 无世界观·状态栏皮肤选择弹窗 ----------
  async function openDefaultSkinPicker() {
    const modal = document.getElementById('default-skin-modal');
    const list = document.getElementById('default-skin-list');
    if (!modal || !list) return;

    // 读出当前 __default_wv__ 的 statusBarSkin（无世界观默认 single-default）
    let current = 'single-default';
    try {
      const wv = await DB.get('worldviews', '__default_wv__');
      if (wv && wv.statusBarSkin) current = wv.statusBarSkin;
    } catch(_) {}

    const _row = (label, value, desc) => {
      const active = current === value;
      const check = active
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent);flex-shrink:0"><path d="M20 6 9 17l-5-5"/></svg>'
        : '<span style="width:14px;flex-shrink:0"></span>';
      const safe = Utils.escapeHtml(value);
      const descHtml = desc ? `<span style="font-size:11px;color:var(--text-secondary);display:block;margin-top:2px">${Utils.escapeHtml(desc)}</span>` : '';
      return `<div onclick="Worldview.pickDefaultSkin('${safe}')" class="ctx-item" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--text)${active ? ';background:var(--bg-tertiary)' : ''}">${check}<span style="flex:1;overflow:hidden"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(label)}</span>${descHtml}</span></div>`;
    };

    // 预设风格
    let html = _row('终端风格', 'terminal', '黑客风格，等宽字体')
      + _row('拟态风格', 'neumorph', '柔和阴影，圆角卡片')
      + _row('无世界观', 'single-default', '简洁优雅');

    // 自定义状态栏主题（sb_ 开头）
    try {
      if (window.StatusBarTheme && StatusBarTheme.getAll) {
        const customThemes = StatusBarTheme.getAll();
        if (customThemes.length) {
          html += '<div style="height:1px;background:var(--border);margin:4px 0"></div>';
          customThemes.forEach(t => { html += _row(t.name, t.id, '自定义主题'); });
        }
      }
    } catch(_) {}

    list.innerHTML = html;
    modal.classList.remove('hidden');
  }

  function closeDefaultSkinPicker() {
    const modal = document.getElementById('default-skin-modal');
    if (modal) modal.classList.add('hidden');
  }

  async function pickDefaultSkin(value) {
    try {
      let wv = await DB.get('worldviews', '__default_wv__');
      if (!wv) {
        wv = { id: '__default_wv__', name: '无世界观', description: '未挂世界观的对话', icon: '∅', iconImage: '' };
      }
      wv.statusBarSkin = value || 'single-default';
      await DB.put('worldviews', wv);

      // 如果当前正处于无世界观下，立刻应用
      const cur = (typeof getCurrentId === 'function') ? getCurrentId() : null;
      if (!cur || cur === '__default_wv__') {
        _applyStatusBarSkin(wv);
      }
      UI.showToast('状态栏皮肤已应用', 1800);
    } catch(e) {
      console.warn('[pickDefaultSkin]', e);
      UI.showToast('保存失败', 1800);
    }
    closeDefaultSkinPicker();
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
        // 应用状态栏皮肤
        _applyStatusBarSkin(w);
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
      // 应用无世界观保存的状态栏皮肤 / 绑定主题
      try {
        const dwv = await DB.get('worldviews', '__default_wv__');
        if (dwv) {
          _applyStatusBarSkin(dwv);
          if (dwv.themeName) { try { _applyBoundTheme(dwv.themeName); } catch(_) {} }
        }
      } catch(e) { console.warn('[Worldview.restore] 无世界观皮肤恢复失败', e); }
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

  // 内置世界观自动加载（增量；已有的不自动覆盖，标记待更新）
  async function _loadBuiltinWorldviews() {
    try {
      const builtinArr = window.__BUILTIN_WORLDVIEWS__;
      if (!builtinArr || !Array.isArray(builtinArr) || builtinArr.length === 0) return;

      // 读已加载过的内置版本记录 { id: version }
      const loaded = await DB.get('gameState', 'builtinLoaded');
      const loadedMap = loaded?.value || {};

      // 待更新列表 { id: newVersion }（本地有旧版但不自动覆盖）
      const pendingRaw = await DB.get('gameState', 'builtinPendingUpdate');
      const pendingMap = pendingRaw?.value || {};

      let list = await getWorldviewList();
      let newCount = 0;

      for (const w of builtinArr) {
        if (!w.id) w.id = 'wv_' + Utils.uuid().slice(0, 8);
        const ver = w._builtinVersion || 1;
        const knownVer = loadedMap[w.id] || 0;

        if (ver <= knownVer) {
          // 版本一致或更低，跳过（同时清理可能残留的 pending 标记）
          if (pendingMap[w.id]) delete pendingMap[w.id];
          continue;
        }

        const existing = list.find(e => e.id === w.id);
        if (existing) {
          // 本地已有旧版——不自动覆盖，仅标记"有可用更新"
          pendingMap[w.id] = ver;
        } else {
          // 全新的内置世界观——静默自动加载
          list.push({ id: w.id, name: w.name || '未命名', description: w.description || '', icon: w.icon || 'world', iconImage: w.iconImage || '' });
          _migrateToKnowledges(w); // v581
          await DB.put('worldviews', w);
          loadedMap[w.id] = ver;
          newCount++;
        }
      }

      if (newCount > 0) {
        await saveWorldviewList(list);
        console.log('[Worldview] 新增内置世界观：' + newCount + '个');
      }
      await DB.put('gameState', { key: 'builtinLoaded', value: loadedMap });
      await DB.put('gameState', { key: 'builtinPendingUpdate', value: pendingMap });
    } catch(e) {
      console.warn('[Worldview] 加载内置世界观失败:', e);
    }
  }

  // 手动执行内置世界观更新（玩家点击"更新"按钮后调用）
  async function applyBuiltinUpdate(wvId) {
    const builtinArr = window.__BUILTIN_WORLDVIEWS__;
    if (!builtinArr) return;
    const w = builtinArr.find(b => b.id === wvId);
    if (!w) { UI.showToast('未找到该内置世界观数据'); return; }

    const ok = await UI.showConfirm('更新内置世界观', '更新将彻底覆盖当前版本（包括你的所有修改），是否继续？');
    if (!ok) return;

    const ver = w._builtinVersion || 1;
    _migrateToKnowledges(w);
    await DB.put('worldviews', w);

    // 更新 loadedMap + 清除 pending
    const loaded = await DB.get('gameState', 'builtinLoaded');
    const loadedMap = loaded?.value || {};
    loadedMap[wvId] = ver;
    await DB.put('gameState', { key: 'builtinLoaded', value: loadedMap });

    const pendingRaw = await DB.get('gameState', 'builtinPendingUpdate');
    const pendingMap = pendingRaw?.value || {};
    delete pendingMap[wvId];
    await DB.put('gameState', { key: 'builtinPendingUpdate', value: pendingMap });

    // 刷新列表 UI
    let list = await getWorldviewList();
    const existing = list.find(e => e.id === wvId);
    if (existing) {
      existing.name = w.name || existing.name;
      existing.description = w.description || existing.description;
      existing.icon = w.icon || existing.icon;
      existing.iconImage = w.iconImage || existing.iconImage;
      await saveWorldviewList(list);
    }
    await load();
    UI.showToast('已更新到最新版本');
  }

  /**
   * 【已停用·2026-07】此函数当年为修"天枢城 NPC name/aliases 填反"而写，做无脑交换。
   * 但它无法区分"用户数据已是对的"还是"反的"，会把已修正的数据又交换反，属于帮倒忙。
   * 现改用 Phone 的身份归一（本名/代号双向兼容 _resolveNpcRealName），方向不再重要，
   * 此函数彻底退休：不再交换，只打 flag 占位，避免旧逻辑继续作乱。
   */
  async function _migrateTianshuchengNpcNames() {
    try {
      const FLAG = 'migrate_tsc_npc_names_v1';
      // 直接打标记跳过，永不再交换（双向兼容已接管，无需纠正数据方向）
      await DB.put('gameState', { key: FLAG, value: 1 });
    } catch(e) {
      console.warn('[Migration] 天枢城NPC名称迁移(已停用)标记失败:', e);
    }
  }

// ===== 开场时间分字段辅助 =====
  function _fillStartTimeFields(str) {
    const yEl = document.getElementById('wv-start-time-year');
    const moEl = document.getElementById('wv-start-time-month');
    const dEl = document.getElementById('wv-start-time-day');
    const hEl = document.getElementById('wv-start-time-hour');
    const miEl = document.getElementById('wv-start-time-min');
    if (!yEl) return;
    if (!str) { yEl.value = ''; moEl.value = ''; dEl.value = ''; hEl.value = ''; miEl.value = ''; _updateStartTimeWeekday(); return; }
    // 尝试解析
    const parsed = (typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) ? Calendar.parseAbsoluteTime(str) : null;
    if (parsed) {
      yEl.value = parsed.year || '';
      moEl.value = parsed.month || '';
      dEl.value = parsed.day || '';
      hEl.value = parsed.hour ?? '';
      miEl.value = parsed.minute ?? '';
    } else {
      // 无法解析，尝试简单正则
      const m = str.match(/(\d+)[年.\-\/](\d+)[月.\-\/](\d+)[日]?\s*(?:.*?)?(\d{1,2}):(\d{2})/);
      if (m) { yEl.value = m[1]; moEl.value = m[2]; dEl.value = m[3]; hEl.value = m[4]; miEl.value = m[5]; }
      else {
        const m2 = str.match(/(\d+)[年.\-\/](\d+)[月.\-\/](\d+)/);
        if (m2) { yEl.value = m2[1]; moEl.value = m2[2]; dEl.value = m2[3]; hEl.value = ''; miEl.value = ''; }
      }
    }
    _updateStartTimeWeekday();
    // 加载阶段：只同步 hidden，不触发自动保存（避免回填过程反向覆盖刚保存的数据）
    try { if (typeof _syncStartTimeHidden === 'function') _syncStartTimeHidden(); } catch(_) {}
  }

  // 纯同步函数：从分字段读值 → 拼标准时间字符串 → 写回 hidden input，并返回该字符串。
  // 不依赖 oninput 时序；save / 自动保存在读取 hidden 之前都应主动调用一次，
  // 避免分字段变化未触发 oninput 导致 hidden 滞留旧值（表现为"改了又变回去"）。
  function _syncStartTimeHidden() {
    const now = new Date();
    const _val = (id) => {
      const el = document.getElementById(id);
      const raw = (el && el.value != null) ? String(el.value).trim() : '';
      const n = parseInt(raw, 10);
      return isNaN(n) ? null : n;
    };
    const y = _val('wv-start-time-year') ?? now.getFullYear();
    const mo = _val('wv-start-time-month') ?? (now.getMonth() + 1);
    const d = _val('wv-start-time-day') ?? now.getDate();
    const h = _val('wv-start-time-hour') ?? now.getHours();
    const mi = _val('wv-start-time-min') ?? now.getMinutes();

    const hh = String(h).padStart(2, '0');
    const mm = String(mi).padStart(2, '0');
    let timeStr = `${y}年${mo}月${d}日 ${hh}:${mm}`;

    // 算星期并补上
    if (typeof Calendar !== 'undefined' && Calendar.getWeekDay) {
      try {
        const timeObj = { year: y, month: mo, day: d, hour: h, minute: mi };
        const wd = Calendar.getWeekDay(timeObj, _editingCalRules);
        if (wd) timeStr = `${y}年${mo}月${d}日 ${wd} ${hh}:${mm}`;
      } catch(_) {}
    }

    const hidden = document.getElementById('wv-start-time');
    if (hidden) hidden.value = timeStr;
    return timeStr;
  }

  function _onStartTimeChange() {
    _syncStartTimeHidden();
    _updateStartTimeWeekday();
    // 触发自动保存
    if (typeof _wvAutoSave === 'function') _wvAutoSave();
  }

  function _updateStartTimeWeekday() {
    const el = document.getElementById('wv-start-time-weekday');
    if (!el) return;
    const now = new Date();
    const _val = (id) => {
      const raw = document.getElementById(id)?.value?.trim() || '';
      const n = parseInt(raw, 10);
      return isNaN(n) ? null : n;
    };
    const y = _val('wv-start-time-year') ?? now.getFullYear();
    const mo = _val('wv-start-time-month') ?? (now.getMonth() + 1);
    const d = _val('wv-start-time-day') ?? now.getDate();
    try {
      if (typeof Calendar !== 'undefined' && Calendar.getWeekDay) {
        const timeObj = { year: y, month: mo, day: d, hour: 0, minute: 0 };
        const wd = Calendar.getWeekDay(timeObj, _editingCalRules);
        el.textContent = wd || '';
      }
    } catch(_) { el.textContent = ''; }
  }

  // ===== 历法系统编辑器 =====

function _ensureCalendarSystem(w) {
  const gp = _ensureGameplay(w);
  if (!gp.calendarSystem) {
    gp.calendarSystem = {
      hoursPerDay: 24,
      daysPerWeek: 7,
      weekDayNames: ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'],
      weekDayTypes: ['work', 'work', 'work', 'work', 'work', 'rest', 'rest'],
      monthsPerYear: 12,
      daysPerMonth: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
      uniformDaysPerMonth: false,
      seasons: [
        { name: '春', months: [3, 4, 5], weather: '微风渐暖' },
        { name: '夏', months: [6, 7, 8], weather: '炎热潮湿' },
        { name: '秋', months: [9, 10, 11], weather: '凉爽干燥' },
        { name: '冬', months: [12, 1, 2], weather: '寒冷' }
      ],
      timePeriods: [
        { name: '凌晨', startHour: 0, desc: '天色未明，万籁俱寂' },
        { name: '早晨', startHour: 5, desc: '天色渐亮，日光初照' },
        { name: '上午', startHour: 8, desc: '日光明亮，正是活动时间' },
        { name: '中午', startHour: 11, desc: '日头正盛，光线最强' },
        { name: '下午', startHour: 14, desc: '日光偏斜，暑气渐消' },
        { name: '傍晚', startHour: 18, desc: '太阳落山，天色渐暗' },
        { name: '夜晚', startHour: 20, desc: '天色已暗，灯火亮起' },
        { name: '深夜', startHour: 23, desc: '夜深人静，一片沉寂' }
      ]
    };
  }
  // 兼容旧数据：已有历法但缺 timePeriods 时补上默认值
  if (!gp.calendarSystem.timePeriods || gp.calendarSystem.timePeriods.length === 0) {
    gp.calendarSystem.timePeriods = [
      { name: '凌晨', startHour: 0, desc: '天色未明，万籁俱寂' },
      { name: '早晨', startHour: 5, desc: '天色渐亮，日光初照' },
      { name: '上午', startHour: 8, desc: '日光明亮，正是活动时间' },
      { name: '中午', startHour: 11, desc: '日头正盛，光线最强' },
      { name: '下午', startHour: 14, desc: '日光偏斜，暑气渐消' },
      { name: '傍晚', startHour: 18, desc: '太阳落山，天色渐暗' },
      { name: '夜晚', startHour: 20, desc: '天色已暗，灯火亮起' },
      { name: '深夜', startHour: 23, desc: '夜深人静，一片沉寂' }
    ];
  }
  return gp.calendarSystem;
}

async function openCalendarEditor() {
  const w = await _getEditingWV();
  if (!w) { UI.showToast('请先选择世界观', 1200); return; }
  const cal = _ensureCalendarSystem(w);

  let overlay = document.getElementById('calendar-editor-overlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'calendar-editor-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;animation:sbFadeIn .2s ease-out';
  overlay.innerHTML = _buildCalendarEditorHTML(cal);
  document.body.appendChild(overlay);
}

function _buildCalendarEditorHTML(cal) {
  // 确保 weekDayTypes 数组长度和 weekDayNames 一致
  if (!cal.weekDayTypes) cal.weekDayTypes = cal.weekDayNames.map((_, i) => i < cal.weekDayNames.length - 2 ? 'work' : 'rest');
  while (cal.weekDayTypes.length < cal.weekDayNames.length) cal.weekDayTypes.push('work');

  const weekDayInputs = cal.weekDayNames.map((name, i) => {
    const isRest = cal.weekDayTypes[i] === 'rest';
    return `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
      <span style="font-size:11px;color:var(--text-secondary);min-width:24px">第${i + 1}天</span>
      <input type="text" value="${Utils.escapeHtml(name)}" maxlength="10" data-weekday-idx="${i}"
        style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:12px"
        oninput="Worldview._onCalWeekDayChange(${i}, this.value)">
      <button type="button" onclick="Worldview._calToggleDayType(${i})"
        style="border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:10px;cursor:pointer;min-width:40px;text-align:center;background:${isRest ? 'var(--accent)' : 'var(--bg-secondary)'};color:${isRest ? '#111' : 'var(--text-secondary)'}"
        title="${isRest ? '休息日' : '工作日'}">${isRest ? '休' : '工'}</button>
      ${cal.weekDayNames.length > 1 ? `<button type="button" onclick="Worldview._calRemoveWeekDay(${i})" style="border:none;background:none;color:var(--text-secondary);cursor:pointer;font-size:14px;padding:2px 4px" title="删除">×</button>` : ''}
    </div>`;
  }).join('');

  let monthContent = '';
  if (cal.uniformDaysPerMonth) {
    monthContent = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:12px;color:var(--text)">每月天数</span>
        <input type="number" min="1" max="999" value="${cal.daysPerMonth[0] || 30}" id="cal-uniform-days"
          style="width:60px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:12px"
          oninput="Worldview._calSetUniformDays(this.value)">
      </div>`;
  } else {
    monthContent = cal.daysPerMonth.map((d, i) => `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <span style="font-size:11px;color:var(--text-secondary);min-width:36px">${i + 1}月</span>
        <input type="number" min="1" max="999" value="${d}" data-month-idx="${i}"
          style="width:55px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:12px"
          oninput="Worldview._calSetMonthDays(${i}, this.value)">
        <span style="font-size:11px;color:var(--text-secondary)">天</span>
      </div>
    `).join('');
  }

  const seasonCards = cal.seasons.map((s, i) => `
    <div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--bg-secondary)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <input type="text" value="${Utils.escapeHtml(s.name || '')}" placeholder="季节名" maxlength="10"
          style="width:60px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:12px"
          oninput="Worldview._calSetSeasonName(${i}, this.value)">
        <input type="text" value="${(s.months || []).join(',')}" placeholder="如：3,4,5 或 3、4、5"
          style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:12px"
          oninput="Worldview._calSetSeasonMonths(${i}, this.value)">
        <button type="button" onclick="Worldview._calRemoveSeason(${i})" style="border:none;background:none;color:var(--text-secondary);cursor:pointer;font-size:14px;padding:2px 4px" title="删除">×</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:11px;color:var(--text-secondary)">概述</span>
        <input type="text" value="${Utils.escapeHtml(s.weather || '')}" placeholder="该季节的天气概述" maxlength="20"
          style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:12px"
          oninput="Worldview._calSetSeasonWeather(${i}, this.value)">
      </div>
    </div>
  `).join('');

  // 时段卡片
  const periods = cal.timePeriods || [];
  const periodCards = periods.map((p, i) => `
    <div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--bg-secondary)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <input type="text" value="${Utils.escapeHtml(p.name || '')}" placeholder="时段名" maxlength="10"
          style="width:60px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:12px"
          oninput="Worldview._calSetPeriodName(${i}, this.value)">
        <input type="number" value="${p.startHour ?? 0}" min="0" max="23" placeholder="起始时"
          style="width:55px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:12px"
          oninput="Worldview._calSetPeriodHour(${i}, this.value)">
        <span style="font-size:11px;color:var(--text-secondary)">时起</span>
        <button type="button" onclick="Worldview._calRemovePeriod(${i})" style="border:none;background:none;color:var(--text-secondary);cursor:pointer;font-size:14px;padding:2px 4px" title="删除">×</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:11px;color:var(--text-secondary)">描述</span>
        <input type="text" value="${Utils.escapeHtml(p.desc || '')}" placeholder="该时段的环境特征" maxlength="30"
          style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text);font-size:12px"
          oninput="Worldview._calSetPeriodDesc(${i}, this.value)">
      </div>
    </div>
  `).join('');

  const totalDays = cal.daysPerMonth.reduce((a, b) => a + b, 0);

  return `
    <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 12px;display:flex;align-items:center;justify-content:space-between">
  <div style="display:flex;align-items:center;gap:8px">
    <button type="button" onclick="Worldview.closeCalendarEditor()" style="border:none;background:none;color:var(--text);cursor:pointer;padding:4px">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span style="font-size:16px;font-weight:600;color:var(--text)">历法系统</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <button type="button" onclick="Worldview.aiGenerateCalendar()" style="border:1px solid var(--accent);background:var(--bg-secondary);color:var(--accent);cursor:pointer;padding:5px 10px;border-radius:6px;font-size:11px;display:inline-flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>AI生成</button>
        <button type="button" onclick="Worldview._calReset()" style="border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-secondary);cursor:pointer;padding:5px 10px;border-radius:6px;font-size:11px">恢复默认</button>
      </div>
    </div>
    <div style="flex:1;overflow-y:auto;padding:16px">

      <div style="font-size:11px;color:#e74c3c;line-height:1.5;margin-bottom:16px;padding:8px 10px;border:1px solid rgba(231,76,60,0.3);border-radius:6px;background:rgba(231,76,60,0.05)">⚠️ 自定义历法后，必须在「开场设定」中填写开场时间，否则历法系统无法正常计算时间增量。</div>

      <!-- 周设定 -->
      <div style="margin-bottom:24px">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;display:flex;align-items:center;gap:6px">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          周设定
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px">一周有 ${cal.daysPerWeek} 天。填写完整名称（如"星期一"或"水曜日"），将直接显示在状态栏。<br>星期名不可含阿拉伯数字（会干扰开场时间解析）。</div>
        <div id="cal-weekday-list">
          ${weekDayInputs}
        </div>
        <button type="button" onclick="Worldview._calAddWeekDay()" style="margin-top:4px;padding:5px 12px;border:1px dashed var(--border);border-radius:6px;background:none;color:var(--accent);cursor:pointer;font-size:11px">+ 添加一天</button>
      </div>

      <!-- 月设定 -->
      <div style="margin-bottom:24px">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;display:flex;align-items:center;gap:6px">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
          月设定
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:12px;color:var(--text)">一年 ${cal.monthsPerYear} 个月</span>
          <button type="button" onclick="Worldview._calAddMonth()" style="border:1px dashed var(--border);border-radius:6px;background:none;color:var(--accent);cursor:pointer;font-size:11px;padding:3px 8px">+</button>
          ${cal.monthsPerYear > 1 ? `<button type="button" onclick="Worldview._calRemoveMonth()" style="border:1px dashed var(--border);border-radius:6px;background:none;color:var(--text-secondary);cursor:pointer;font-size:11px;padding:3px 8px">−</button>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <label style="font-size:12px;color:var(--text);display:flex;align-items:center;gap:4px;cursor:pointer">
            <input type="radio" name="cal-month-mode" ${cal.uniformDaysPerMonth ? 'checked' : ''} onchange="Worldview._calSetMonthMode(true)"> 每月统一
          </label>
          <label style="font-size:12px;color:var(--text);display:flex;align-items:center;gap:4px;cursor:pointer">
            <input type="radio" name="cal-month-mode" ${!cal.uniformDaysPerMonth ? 'checked' : ''} onchange="Worldview._calSetMonthMode(false)"> 分月设定
          </label>
        </div>
        <div id="cal-month-content">
          ${monthContent}
        </div>
      </div>

      <!-- 季设定 -->
      <div style="margin-bottom:24px">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;display:flex;align-items:center;gap:6px">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg>
          季设定
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px">设定哪些月份属于哪个季节，以及该季节的天气概述。</div>
        <div id="cal-season-list">
          ${seasonCards}
        </div>
        <button type="button" onclick="Worldview._calAddSeason()" style="margin-top:4px;padding:5px 12px;border:1px dashed var(--border);border-radius:6px;background:none;color:var(--accent);cursor:pointer;font-size:11px">+ 添加季节</button>
      </div>

      <!-- 时段设定 -->
      <div style="margin-bottom:24px">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;display:flex;align-items:center;gap:6px">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          时段设定
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px">定义一天中的时间段（按起始小时升序）。跨段时会自动提醒AI进行环境描写过渡。<br>起始小时须为 0-23 的整数，且首个时段必须从 0 点开始（用于覆盖凌晨时分）。</div>
        <div id="cal-period-list">
          ${periodCards}
        </div>
        <button type="button" onclick="Worldview._calAddPeriod()" style="margin-top:4px;padding:5px 12px;border:1px dashed var(--border);border-radius:6px;background:none;color:var(--accent);cursor:pointer;font-size:11px">+ 添加时段</button>
      </div>

      <!-- 年设定 -->
      <div style="margin-bottom:24px">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;display:flex;align-items:center;gap:6px">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
          年设定
        </div>
        <div style="font-size:12px;color:var(--text);margin-bottom:4px">一年共 <strong>${totalDays}</strong> 天（${cal.monthsPerYear} 个月 × 各月天数）</div>
        <div style="font-size:11px;color:var(--text-secondary)">年总天数由月设定自动计算，无需手动填写。</div>
      </div>

    </div>
  `;
}

async function closeCalendarEditor() {
  const overlay = document.getElementById('calendar-editor-overlay');
  if (overlay) overlay.remove();
  _updateCalendarCardLabel();
  const w = await _getEditingWV();
  if (w) _saveEditingWV(w);
}

async function _updateCalendarCardLabel() {
  const label = document.getElementById('wv-calendar-card-label');
  if (!label) return;
  const w = await _getEditingWV();
  if (!w) return;
  const gp = w.gameplay;
  if (!gp || !gp.calendarSystem) { label.textContent = '设置历法系统'; return; }
  const cal = gp.calendarSystem;
  label.textContent = `${cal.daysPerWeek}天/周 · ${cal.monthsPerYear}月/年 · ${cal.seasons.length}季`;
}

async function _calSaveAndRefresh() {
  const w = await _getEditingWV();
  if (!w) return;
  await _saveEditingWV(w);
  const cal = _ensureCalendarSystem(w);
  const overlay = document.getElementById('calendar-editor-overlay');
  if (overlay) {
    const scroller = overlay.querySelector('div[style*="overflow-y:auto"]');
    const scrollTop = scroller?.scrollTop || 0;
    overlay.innerHTML = _buildCalendarEditorHTML(cal);
    requestAnimationFrame(() => {
      const s2 = overlay.querySelector('div[style*="overflow-y:auto"]');
      if (s2) s2.scrollTop = scrollTop;
    });
  }
}

async function _onCalWeekDayChange(idx, value) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  // 星期名禁止含数字：数字会干扰开场时间解析（parseAbsoluteTime 靠数字锚定年月日时分），剥掉并同步回显
  const clean = String(value == null ? '' : value).replace(/[0-9\uFF10-\uFF19]/g, '');
  if (clean !== value) {
    const inp = document.querySelector('#cal-weekday-list input[data-weekday-idx="' + idx + '"]');
    if (inp) inp.value = clean;
  }
  cal.weekDayNames[idx] = clean;
  await _saveEditingWV(w);
}

// ===== 手机配置编辑器 =====

async function _updatePhoneAppsLabel() {
  const label = document.getElementById('wv-phone-apps-label');
  if (!label) return;
  const w = await _getEditingWV();
  if (!w) { label.textContent = '默认配置'; return; }
  const pa = w.phoneApps || {};
  const tkName = (pa.takeout || {}).name || '';
  const shName = (pa.shop || {}).name || '';
  const fmName = (pa.forum || {}).name || '';
  if (!tkName && !shName && !fmName) {
    label.textContent = '默认配置（饿了咪/桃宝/论坛）';
  } else {
    const parts = [];
    if (tkName) parts.push(tkName);
    if (shName) parts.push(shName);
    if (fmName) parts.push(fmName);
    label.textContent = parts.join(' / ');
  }
}

async function openPhoneAppsEditor() {
  const w = await _getEditingWV();
  if (!w) { UI.showToast('请先选择世界观', 1200); return; }
  w.phoneApps = w.phoneApps || { takeout: { name: '', desc: '' }, shop: { name: '', desc: '' }, forum: { name: '', desc: '' } };

  let overlay = document.getElementById('phone-apps-editor-overlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'phone-apps-editor-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;animation:sbFadeIn .2s ease-out';
  overlay.innerHTML = _buildPhoneAppsEditorHTML(w);
  document.body.appendChild(overlay);

  // 回填数据
  const pa = w.phoneApps || {};
  const tk = pa.takeout || {};
  const sh = pa.shop || {};
  const fm = pa.forum || {};
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  setVal('pa-takeout-name', tk.name);
  setVal('pa-takeout-desc', tk.desc);
  setVal('pa-takeout-deliveryMin', tk.deliveryMin);
  setVal('pa-takeout-deliveryMax', tk.deliveryMax);
  const tkUnitEl = document.getElementById('pa-takeout-deliveryUnit'); if (tkUnitEl) tkUnitEl.value = tk.deliveryUnit || 'min';
  setVal('pa-shop-name', sh.name);
  setVal('pa-shop-desc', sh.desc);
  setVal('pa-shop-deliveryMin', sh.deliveryMin);
  setVal('pa-shop-deliveryMax', sh.deliveryMax);
  const shUnitEl = document.getElementById('pa-shop-deliveryUnit'); if (shUnitEl) shUnitEl.value = sh.deliveryUnit || 'day';
  setVal('pa-forum-name', fm.name);
  setVal('pa-forum-desc', fm.desc);
// 电台
  const rd = pa.radio || {};
  setVal('pa-radio-name', rd.name);
  setVal('pa-radio-desc', rd.desc);
// 阅读
    const rg = pa.reading || {};
    setVal('pa-reading-name', rg.name);
    setVal('pa-reading-desc', rg.desc);

    // 视频
    const vg = pa.video || {};
    setVal('pa-video-name', vg.name);
    setVal('pa-video-desc', vg.desc);
    // 启用预设主播：默认勾选，只有显式存 false 才不勾
    const presetChk = document.getElementById('pa-video-preset-enabled');
    if (presetChk) presetChk.checked = vg.presetEnabled !== false;

  // 小屋
  const ct = pa.cottage || {};
  setVal('pa-cottage-name', ct.name);
  setVal('pa-cottage-deliveryMin', ct.deliveryMin);
  setVal('pa-cottage-deliveryMax', ct.deliveryMax);
  const ctUnitEl = document.getElementById('pa-cottage-deliveryUnit'); if (ctUnitEl) ctUnitEl.value = ct.deliveryUnit || 'day';
  // 衣橱（无初始模板，仅 APP 名 + 配送时间）
  const wr = pa.wardrobe || {};
  setVal('pa-wardrobe-name', wr.name);
  setVal('pa-wardrobe-deliveryMin', wr.deliveryMin);
  setVal('pa-wardrobe-deliveryMax', wr.deliveryMax);
  const wrUnitEl = document.getElementById('pa-wardrobe-deliveryUnit'); if (wrUnitEl) wrUnitEl.value = wr.deliveryUnit || 'day';
  // 模板状态
  const tplStatus = document.getElementById('pa-cottage-template-status');
  if (tplStatus) {
    if (ct.initialHouse && ct.initialHouse.name) {
      const roomCount = (ct.initialHouse.floors || []).reduce((n, f) => n + (f.rooms || []).length, 0) || (ct.initialHouse.rooms || []).length;
      tplStatus.textContent = `已设置：${ct.initialHouse.name}（${roomCount} 个房间）`;
      tplStatus.style.color = 'var(--accent)';
    } else {
      tplStatus.textContent = '未设置';
      tplStatus.style.color = '';
    }
  }

  // 模板按钮事件
  const tplCopyBtn = document.getElementById('pa-cottage-template-copy');
  const tplImportBtn = document.getElementById('pa-cottage-template-import');
  const tplClearBtn = document.getElementById('pa-cottage-template-clear');
  if (tplCopyBtn) tplCopyBtn.onclick = async () => {
    try {
      if (typeof Phone === 'undefined' || !Phone._getPhoneData) { UI.showToast('手机模块未加载', 1500); return; }
      const pd = await Phone._getPhoneData();
      const curHouse = (pd?.houses || []).find(h => h.isCurrent);
      if (!curHouse) { UI.showToast('当前没有设为居住的住所', 2000); return; }
      const tpl = JSON.parse(JSON.stringify(curHouse));
      delete tpl.id; delete tpl.isCurrent; delete tpl.image;
      const ww = await _getEditingWV();
      if (!ww) return;
      ww.phoneApps = ww.phoneApps || {};
      ww.phoneApps.cottage = ww.phoneApps.cottage || {};
      ww.phoneApps.cottage.initialHouse = tpl;
      await _saveEditingWV(ww);
      const roomCount = (tpl.floors || []).reduce((n, f) => n + (f.rooms || []).length, 0) || (tpl.rooms || []).length;
      const st = document.getElementById('pa-cottage-template-status');
      if (st) { st.textContent = `已设置：${tpl.name}（${roomCount} 个房间）`; st.style.color = 'var(--accent)'; }
      UI.showToast('已从当前住所复制为模板', 1600);
    } catch(e) { UI.showToast('复制失败：' + (e.message || e), 2500); }
  };
  if (tplImportBtn) tplImportBtn.onclick = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files[0]; if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        let tpl = null;
        if (data.__format === 'tianshu_cottage_v1' && Array.isArray(data.houses) && data.houses.length) {
          tpl = JSON.parse(JSON.stringify(data.houses[0]));
        } else if (data.name && (data.floors || data.rooms)) {
          tpl = JSON.parse(JSON.stringify(data));
        } else { UI.showToast('无法识别的住所数据', 2500); return; }
        delete tpl.id; delete tpl.isCurrent; delete tpl.image;
        const ww = await _getEditingWV();
        if (!ww) return;
        ww.phoneApps = ww.phoneApps || {};
        ww.phoneApps.cottage = ww.phoneApps.cottage || {};
        ww.phoneApps.cottage.initialHouse = tpl;
        await _saveEditingWV(ww);
        const roomCount = (tpl.floors || []).reduce((n, f) => n + (f.rooms || []).length, 0) || (tpl.rooms || []).length;
        const st = document.getElementById('pa-cottage-template-status');
        if (st) { st.textContent = `已设置：${tpl.name || '住所'}（${roomCount} 个房间）`; st.style.color = 'var(--accent)'; }
        UI.showToast('已导入住所模板', 1600);
      } catch(e) { UI.showToast('导入失败：' + (e.message || e), 2500); }
    };
    input.click();
  };
  if (tplClearBtn) tplClearBtn.onclick = async () => {
    const ww = await _getEditingWV();
    if (!ww) return;
    if (ww.phoneApps?.cottage) { delete ww.phoneApps.cottage.initialHouse; await _saveEditingWV(ww); }
    const st = document.getElementById('pa-cottage-template-status');
    if (st) { st.textContent = '未设置'; st.style.color = ''; }
    UI.showToast('已清除模板', 1200);
  };
}

function _buildPhoneAppsEditorHTML(w) {
  return `
<div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 12px;display:flex;align-items:center;justify-content:space-between">
  <div style="display:flex;align-items:center;gap:8px">
    <button type="button" onclick="Worldview.closePhoneAppsEditor()" style="border:none;background:none;color:var(--text);cursor:pointer;padding:4px">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <span style="font-size:16px;font-weight:600;color:var(--text)">手机配置</span>
  </div>
  <span style="font-size:12px;color:var(--text-secondary)">仅小手机内使用，不发给主线 AI</span>
</div>
<div style="flex:1;overflow-y:auto;padding:16px">

  <!-- 短时效商城 -->
  <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;display:flex;align-items:center;gap:6px">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
    短时效商城
    <span style="font-size:11px;font-weight:normal;color:var(--text-secondary)">（默认：饿了咪·外卖）</span>
  </div>
  <div style="background:var(--bg-tertiary);padding:12px;border-radius:8px;margin-bottom:16px">
    <label style="display:block;margin-bottom:10px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">商城名称</span>
      <input type="text" id="pa-takeout-name" placeholder="例如：灵厨到家 / 补给空投" style="width:100%;padding:6px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
    </label>
    <label style="display:block;margin-bottom:10px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">商城描述 <span style="font-size:11px;color:var(--text-secondary)">（告诉AI这家卖什么）</span></span>
      <textarea id="pa-takeout-desc" class="auto-resize-textarea" rows="3" placeholder="例如：修真界即时灵厨外送，卖餐食、茶水、灵丹小点，短时效到手" style="width:100%;padding:8px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px;line-height:1.5;resize:vertical;min-height:60px"></textarea>
    </label>
    <div>
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">配送时间 <span style="font-size:11px;color:var(--text-secondary)">（留空用默认15-45分钟）</span></span>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="number" id="pa-takeout-deliveryMin" placeholder="最小" style="width:70px;padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
        <span style="color:var(--text-secondary)">~</span>
        <input type="number" id="pa-takeout-deliveryMax" placeholder="最大" style="width:70px;padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
        <select id="pa-takeout-deliveryUnit" style="padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px"><option value="min">分钟</option><option value="day">天</option></select>
      </div>
    </div>
  </div>

  <!-- 长时效商城 -->
  <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;display:flex;align-items:center;gap:6px">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
    长时效商城
    <span style="font-size:11px;font-weight:normal;color:var(--text-secondary)">（默认：桃宝·网购）</span>
  </div>
  <div style="background:var(--bg-tertiary);padding:12px;border-radius:8px;margin-bottom:16px">
    <label style="display:block;margin-bottom:10px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">商城名称</span>
      <input type="text" id="pa-shop-name" placeholder="例如：天机阁 / 主神商城" style="width:100%;padding:6px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
    </label>
    <label style="display:block;margin-bottom:10px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">商城描述 <span style="font-size:11px;color:var(--text-secondary)">（告诉AI这家卖什么）</span></span>
      <textarea id="pa-shop-desc" class="auto-resize-textarea" rows="3" placeholder="例如：修真界网购平台，卖法宝、丹药、符箓、灵草等长时效物品" style="width:100%;padding:8px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px;line-height:1.5;resize:vertical;min-height:60px"></textarea>
    </label>
    <div>
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">配送时间 <span style="font-size:11px;color:var(--text-secondary)">（留空用默认2-5天）</span></span>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="number" id="pa-shop-deliveryMin" placeholder="最小" style="width:70px;padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
        <span style="color:var(--text-secondary)">~</span>
        <input type="number" id="pa-shop-deliveryMax" placeholder="最大" style="width:70px;padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
        <select id="pa-shop-deliveryUnit" style="padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px"><option value="day">天</option><option value="min">分钟</option></select>
      </div>
    </div>
  </div>

  <button type="button" onclick="Worldview.aiGenerateShops()" style="width:100%;margin-bottom:16px;border:1px solid var(--accent);background:var(--bg-secondary);color:var(--accent);cursor:pointer;padding:9px;border-radius:8px;font-size:13px;display:flex;align-items:center;justify-content:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>AI 生成两个商城配置</button>

  <button type="button" onclick="Worldview.aiGenerateMediaApps()" style="width:100%;margin-bottom:8px;border:1px solid var(--accent);background:var(--bg-secondary);color:var(--accent);cursor:pointer;padding:9px;border-radius:8px;font-size:13px;display:flex;align-items:center;justify-content:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>AI 生成内容平台（信息载体/电台/阅读/视频）</button>
  <div style="font-size:11px;color:var(--text-secondary);margin-bottom:16px;text-align:center;line-height:1.5">一次生成下面四个平台的名称和描述</div>

  <!-- 信息载体 -->
  <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;display:flex;align-items:center;gap:6px">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>
    信息载体
    <span style="font-size:11px;font-weight:normal;color:var(--text-secondary)">（默认：论坛）</span>
  </div>
  <div style="background:var(--bg-tertiary);padding:12px;border-radius:8px">
    <label style="display:block;margin-bottom:10px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">载体名称</span>
      <input type="text" id="pa-forum-name" placeholder="例如：微博 / 小红书 / 茶馆" style="width:100%;padding:6px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
    </label>
    <label style="display:block">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">载体描述 <span style="font-size:11px;color:var(--text-secondary)">（告诉AI内容画风、用户群、常见话题）</span></span>
      <textarea id="pa-forum-desc" class="auto-resize-textarea" rows="3" placeholder="例如：修真界主流信息载体，用户多为各派弟子，常见丹方/剑修吐槽/门派八卦" style="width:100%;padding:8px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px;line-height:1.5;resize:vertical;min-height:60px"></textarea>
    </label>
  </div>

  <!-- 电台 -->
  <div style="font-size:14px;font-weight:600;color:var(--text);margin-top:16px;margin-bottom:4px;display:flex;align-items:center;gap:6px">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
    电台
    <span style="font-size:11px;font-weight:normal;color:var(--text-secondary)">（默认：5个预设分类）</span>
  </div>
  <div style="background:var(--bg-tertiary);padding:12px;border-radius:8px;margin-bottom:16px">
    <label style="display:block;margin-bottom:10px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">APP 名称</span>
      <input type="text" id="pa-radio-name" placeholder="例如：调频 / 无线电 / 声波" style="width:100%;padding:6px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
    </label>
    <label style="display:block;margin-bottom:12px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">APP 描述 <span style="font-size:11px;color:var(--text-secondary)">（告诉AI这个世界的电台画风）</span></span>
      <textarea id="pa-radio-desc" class="auto-resize-textarea" rows="2" placeholder="例如：修真界主流电台，涵盖宗门资讯、夜话情感、灵异志怪等分类" style="width:100%;padding:8px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px;line-height:1.5;resize:vertical;min-height:50px"></textarea>
    </label>
<div>
            <button type="button" onclick="Worldview.openRadioCategoriesEditor()" style="width:100%;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">管理分类与标签</button>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">隐藏预设、新建分类、自定义标签</div>
          </div>
          <div style="margin-top:10px">
            <button type="button" onclick="Worldview.openRadioCastEditor()" style="width:100%;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">可出场角色</button>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">设置哪些角色可以主持电台 / 当嘉宾</div>
          </div>
  </div>

  <!-- 阅读 -->
  <div style="font-size:14px;font-weight:600;color:var(--text);margin-top:16px;margin-bottom:4px;display:flex;align-items:center;gap:6px">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
    阅读
    <span style="font-size:11px;font-weight:normal;color:var(--text-secondary)">（小说阅读）</span>
  </div>
  <div style="background:var(--bg-tertiary);padding:12px;border-radius:8px;margin-bottom:16px">
    <label style="display:block;margin-bottom:10px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">APP 名称</span>
      <input type="text" id="pa-reading-name" placeholder="例如：书阁 / 藏书楼 / 阅文" style="width:100%;padding:6px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
    </label>
    <label style="display:block;margin-bottom:12px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">APP 描述 <span style="font-size:11px;color:var(--text-secondary)">（告诉AI这个世界的阅读平台画风）</span></span>
      <textarea id="pa-reading-desc" class="auto-resize-textarea" rows="2" placeholder="例如：修真界主流小说平台，涵盖修仙、异界、都市玄幻等题材" style="width:100%;padding:8px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px;line-height:1.5;resize:vertical;min-height:50px"></textarea>
    </label>
    <div>
      <button type="button" onclick="Worldview.openReadingCastEditor()" style="width:100%;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">可出场作者</button>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">设置哪些角色可以成为书的作者</div>
    </div>
  </div>

  <!-- 视频 -->
  <div style="font-size:14px;font-weight:600;color:var(--text);margin-top:16px;margin-bottom:4px;display:flex;align-items:center;gap:6px">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="15" height="14" rx="2.5"/><path d="M17 9.5l4.55-2.42A1 1 0 0 1 23 7.96v8.08a1 1 0 0 1-1.45.88L17 14.5z"/></svg>
    视频
    <span style="font-size:11px;font-weight:normal;color:var(--text-secondary)">（影视播放）</span>
  </div>
  <div style="background:var(--bg-tertiary);padding:12px;border-radius:8px;margin-bottom:16px">
    <label style="display:block;margin-bottom:10px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">APP 名称</span>
      <input type="text" id="pa-video-name" placeholder="例如：星视 / 光影 / 优酷" style="width:100%;padding:6px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
    </label>
    <label style="display:block;margin-bottom:12px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">APP 描述 <span style="font-size:11px;color:var(--text-secondary)">（告诉AI这个世界的影视平台画风）</span></span>
      <textarea id="pa-video-desc" class="auto-resize-textarea" rows="2" placeholder="例如：主流影视点播平台，涵盖院线大片、剧集、纪录片等" style="width:100%;padding:8px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px;line-height:1.5;resize:vertical;min-height:50px"></textarea>
    </label>
    <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">真人影视（电影 / 电视剧）</div>
    <div style="margin-bottom:10px">
      <button type="button" onclick="Worldview.openVideoCastEditor('director')" style="width:100%;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">导演名单</button>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">设置哪些角色可以担任导演</div>
    </div>
    <div style="margin-bottom:10px">
      <button type="button" onclick="Worldview.openVideoCastEditor('screenwriter')" style="width:100%;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">编剧名单</button>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">设置哪些角色可以担任编剧</div>
    </div>
    <div style="margin-bottom:14px">
      <button type="button" onclick="Worldview.openVideoCastEditor('actor')" style="width:100%;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">演员名单</button>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">设置哪些角色可以担任演员</div>
    </div>
    <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;padding-top:8px;border-top:1px solid var(--border)">动画制作 staff</div>
    <div style="margin-bottom:10px">
      <button type="button" onclick="Worldview.openVideoCastEditor('animeDirector')" style="width:100%;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">监督名单</button>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">设置哪些角色可以担任动画监督</div>
    </div>
    <div style="margin-bottom:10px">
      <button type="button" onclick="Worldview.openVideoCastEditor('animeScript')" style="width:100%;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">系列构成名单</button>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">设置哪些角色可以担任系列构成（脚本）</div>
    </div>
    <div style="margin-bottom:10px">
      <button type="button" onclick="Worldview.openVideoCastEditor('animeCv')" style="width:100%;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">配音演员名单</button>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">设置哪些角色可以担任配音演员</div>
    </div>
    <div>
      <button type="button" onclick="Worldview.openVideoCastEditor('animeArt')" style="width:100%;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">作画名单</button>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">设置哪些角色可以担任动画作画</div>
    </div>
    <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;padding-top:8px;border-top:1px solid var(--border)">直播</div>
    <div>
      <button type="button" onclick="Worldview.openVideoCastEditor('streamer')" style="width:100%;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">主播名单</button>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">设置哪些角色可以作为主播开直播（默认空=全部虚构主播）</div>
    </div>
    <div style="margin-top:10px">
      <button type="button" onclick="Worldview.openLiveCategoriesEditor()" style="width:100%;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">直播分类管理</button>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;text-align:center">隐藏预设品类、新建自定义品类（默认：10个预设品类）</div>
    </div>
    <label style="margin-top:10px;display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 4px">
      <input type="checkbox" id="pa-video-preset-enabled" style="width:16px;height:16px;flex-shrink:0;accent-color:var(--accent);cursor:pointer">
      <span style="flex:1;min-width:0">
        <span style="display:block;font-size:14px;font-weight:600;color:var(--text)">启用预设主播</span>
        <span style="display:block;font-size:11px;color:var(--text-secondary);margin-top:2px">开启后首页随机刷到内置的一批主播（开箱即食，进间才现场生成、烧token）；关掉就只刷 AI 生成的</span>
      </span>
    </label>
  </div>

  <!-- 小屋 -->
  <div style="font-size:14px;font-weight:600;color:var(--text);margin-top:16px;margin-bottom:4px;display:flex;align-items:center;gap:6px">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/></svg>
    小屋
    <span style="font-size:11px;font-weight:normal;color:var(--text-secondary)">（默认：小屋）</span>
  </div>
  <div style="background:var(--bg-tertiary);padding:12px;border-radius:8px;margin-bottom:16px">
    <label style="display:block;margin-bottom:10px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">APP 名称</span>
      <input type="text" id="pa-cottage-name" placeholder="例如：寝居 / 巢穴 / 营地" style="width:100%;padding:6px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
    </label>
    <div style="margin-bottom:10px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">家具商城配送时间 <span style="font-size:11px;color:var(--text-secondary)">（留空用默认2-5天）</span></span>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="number" id="pa-cottage-deliveryMin" placeholder="最小" style="width:70px;padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
        <span style="color:var(--text-secondary)">~</span>
        <input type="number" id="pa-cottage-deliveryMax" placeholder="最大" style="width:70px;padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
        <select id="pa-cottage-deliveryUnit" style="padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px"><option value="day">天</option><option value="min">分钟</option></select>
      </div>
    </div>
    <div>
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">初始住所模板 <span style="font-size:11px;color:var(--text-secondary)">（玩家首次进入小屋时自动获得这套房子）</span></span>
      <div id="pa-cottage-template-status" style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">未设置</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" id="pa-cottage-template-copy" style="padding:6px 12px;font-size:12px;border:1px solid var(--accent);border-radius:6px;background:none;color:var(--accent);cursor:pointer">从当前住所复制</button>
        <button type="button" id="pa-cottage-template-import" style="padding:6px 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:none;color:var(--text);cursor:pointer">导入 JSON</button>
        <button type="button" id="pa-cottage-template-clear" style="padding:6px 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:none;color:#e0464b;cursor:pointer">清除</button>
      </div>
    </div>

  <!-- 衣橱 -->
  <div style="font-size:14px;font-weight:600;color:var(--text);margin-top:16px;margin-bottom:4px;display:flex;align-items:center;gap:6px">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M12 3v3"/><path d="m5 6 3 14h8l3-14"/></svg>
    衣橱
    <span style="font-size:11px;font-weight:normal;color:var(--text-secondary)">（默认：衣橱）</span>
  </div>
  <div style="background:var(--bg-tertiary);padding:12px;border-radius:8px;margin-bottom:16px">
    <label style="display:block;margin-bottom:10px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">APP 名称</span>
      <input type="text" id="pa-wardrobe-name" placeholder="例如：衣阁 / 行装 / 锦衣坊" style="width:100%;padding:6px 10px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
    </label>
    <div>
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">服装商城配送时间 <span style="font-size:11px;color:var(--text-secondary)">（留空用默认2-5天）</span></span>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="number" id="pa-wardrobe-deliveryMin" placeholder="最小" style="width:70px;padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
        <span style="color:var(--text-secondary)">~</span>
        <input type="number" id="pa-wardrobe-deliveryMax" placeholder="最大" style="width:70px;padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
        <select id="pa-wardrobe-deliveryUnit" style="padding:6px 8px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px"><option value="day">天</option><option value="min">分钟</option></select>
      </div>
    </div>
  </div>

</div>
</div>`;
}

async function closePhoneAppsEditor() {
  // 保存编辑器数据回世界观
  const w = await _getEditingWV();
  if (w) {
    w.phoneApps = w.phoneApps || { takeout: { name: '', desc: '' }, shop: { name: '', desc: '' }, forum: { name: '', desc: '' } };
    w.phoneApps.takeout = w.phoneApps.takeout || { name: '', desc: '' };
    w.phoneApps.shop = w.phoneApps.shop || { name: '', desc: '' };
    w.phoneApps.forum = w.phoneApps.forum || { name: '', desc: '' };
    const getVal = (id) => document.getElementById(id)?.value || '';
    w.phoneApps.takeout.name = getVal('pa-takeout-name');
    w.phoneApps.takeout.desc = getVal('pa-takeout-desc');
    w.phoneApps.takeout.deliveryMin = getVal('pa-takeout-deliveryMin');
    w.phoneApps.takeout.deliveryMax = getVal('pa-takeout-deliveryMax');
    w.phoneApps.takeout.deliveryUnit = getVal('pa-takeout-deliveryUnit') || 'min';
    w.phoneApps.shop.name = getVal('pa-shop-name');
    w.phoneApps.shop.desc = getVal('pa-shop-desc');
    w.phoneApps.shop.deliveryMin = getVal('pa-shop-deliveryMin');
    w.phoneApps.shop.deliveryMax = getVal('pa-shop-deliveryMax');
    w.phoneApps.shop.deliveryUnit = getVal('pa-shop-deliveryUnit') || 'day';
    w.phoneApps.forum.name = getVal('pa-forum-name');
    w.phoneApps.forum.desc = getVal('pa-forum-desc');
// 电台（只保存 name/desc，分类数据由分类编辑器单独管理）
    w.phoneApps.radio = w.phoneApps.radio || {};
    w.phoneApps.radio.name = getVal('pa-radio-name');
    w.phoneApps.radio.desc = getVal('pa-radio-desc');
    // 阅读（只保存 name/desc，出场作者由专用编辑器管理）
    w.phoneApps.reading = w.phoneApps.reading || {};
    w.phoneApps.reading.name = getVal('pa-reading-name');
    w.phoneApps.reading.desc = getVal('pa-reading-desc');
    // 视频（只保存 name/desc，导演/编剧/演员名单由专用编辑器管理）
    w.phoneApps.video = w.phoneApps.video || {};
    w.phoneApps.video.name = getVal('pa-video-name');
    w.phoneApps.video.desc = getVal('pa-video-desc');
    // 启用预设主播开关（默认开，存布尔）
    { const el = document.getElementById('pa-video-preset-enabled'); if (el) w.phoneApps.video.presetEnabled = !!el.checked; }
    // 小屋
    w.phoneApps.cottage = w.phoneApps.cottage || {};
    w.phoneApps.cottage.name = getVal('pa-cottage-name');
    w.phoneApps.cottage.deliveryMin = getVal('pa-cottage-deliveryMin');
    w.phoneApps.cottage.deliveryMax = getVal('pa-cottage-deliveryMax');
    w.phoneApps.cottage.deliveryUnit = getVal('pa-cottage-deliveryUnit') || 'day';
    // 衣橱（无初始模板）
    w.phoneApps.wardrobe = w.phoneApps.wardrobe || {};
    w.phoneApps.wardrobe.name = getVal('pa-wardrobe-name');
    w.phoneApps.wardrobe.deliveryMin = getVal('pa-wardrobe-deliveryMin');
    w.phoneApps.wardrobe.deliveryMax = getVal('pa-wardrobe-deliveryMax');
    w.phoneApps.wardrobe.deliveryUnit = getVal('pa-wardrobe-deliveryUnit') || 'day';
    // initialHouse 由按钮事件直接写入，这里不覆盖
    // 同步回隐藏字段（供 _collectForm 兼容）
    const syncHidden = (hid, val) => { const el = document.getElementById(hid); if (el) el.value = val; };
    syncHidden('wv-takeout-name', w.phoneApps.takeout.name);
    syncHidden('wv-takeout-desc', w.phoneApps.takeout.desc);
    syncHidden('wv-takeout-deliveryMin', w.phoneApps.takeout.deliveryMin);
    syncHidden('wv-takeout-deliveryMax', w.phoneApps.takeout.deliveryMax);
    syncHidden('wv-takeout-deliveryUnit', w.phoneApps.takeout.deliveryUnit);
    syncHidden('wv-shop-name', w.phoneApps.shop.name);
    syncHidden('wv-shop-desc', w.phoneApps.shop.desc);
    syncHidden('wv-shop-deliveryMin', w.phoneApps.shop.deliveryMin);
    syncHidden('wv-shop-deliveryMax', w.phoneApps.shop.deliveryMax);
    syncHidden('wv-shop-deliveryUnit', w.phoneApps.shop.deliveryUnit);
    syncHidden('wv-forum-name', w.phoneApps.forum.name);
    syncHidden('wv-forum-desc', w.phoneApps.forum.desc);
    await _saveEditingWV(w);
    // v704：刷新手机缓存，让首页图标立刻生效
    if (typeof Phone !== 'undefined' && Phone.reloadShopMeta) {
      await Phone.reloadShopMeta();
    }
  }
  const overlay = document.getElementById('phone-apps-editor-overlay');
  if (overlay) overlay.remove();
  _updatePhoneAppsLabel();
}

// ===== 电台分类编辑器 =====
const _RADIO_ICON_OPTIONS = [
  { id: 'news', label: '新闻' }, { id: 'emotion', label: '情感' }, { id: 'ghost', label: '怪谈' },
  { id: 'talk', label: '闲聊' }, { id: 'music', label: '音乐' }, { id: 'mic', label: '麦克风' },
  { id: 'star', label: '星星' }, { id: 'book', label: '书本' }, { id: 'tower', label: '信号塔' },
  { id: 'clock', label: '时钟' }, { id: 'heart', label: '爱心' }, { id: 'coffee', label: '咖啡' },
];
const _RADIO_PRESET_CATS = [
  { id: 'news', name: '晚间新闻' }, { id: 'emotion', name: '深夜情感' },
  { id: 'ghost', name: '都市怪谈' }, { id: 'chat', name: '闲聊电台' }, { id: 'music', name: '音乐漫谈' },
];

async function openRadioCategoriesEditor() {
  const w = await _getEditingWV();
  if (!w) { UI.showToast('请先选择世界观', 1200); return; }
  w.phoneApps = w.phoneApps || {};
  w.phoneApps.radio = w.phoneApps.radio || {};
  if (!Array.isArray(w.phoneApps.radio.hiddenPresets)) w.phoneApps.radio.hiddenPresets = [];
  if (!Array.isArray(w.phoneApps.radio.categories)) w.phoneApps.radio.categories = [];

  let overlay = document.getElementById('radio-cats-editor-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'radio-cats-editor-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;animation:sbFadeIn .2s ease-out';
  document.body.appendChild(overlay);
  _renderRadioCatsEditor(overlay, w);
}

function _renderRadioCatsEditor(overlay, w) {
  const radio = w.phoneApps.radio;
  const hidden = new Set(radio.hiddenPresets || []);
  const customs = radio.categories || [];

  let presetsHtml = _RADIO_PRESET_CATS.map(p => {
    const isHidden = hidden.has(p.id);
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-tertiary);border-radius:8px;margin-bottom:6px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:14px;color:var(--text)">${p.name}</span>
        <span style="font-size:11px;color:var(--text-secondary)">预设</span>
      </div>
      <button type="button" onclick="Worldview._radioTogglePreset('${p.id}')" style="padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:${isHidden ? 'var(--accent)' : 'var(--bg-secondary)'};color:${isHidden ? '#fff' : 'var(--text)'};font-size:12px;cursor:pointer">${isHidden ? '恢复' : '隐藏'}</button>
    </div>`;
  }).join('');

  let customsHtml = customs.map((c, i) => {
    const iconLabel = (_RADIO_ICON_OPTIONS.find(o => o.id === c.icon) || {}).label || c.icon;
    const tagCount = (c.tags || []).length;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-tertiary);border-radius:8px;margin-bottom:6px">
      <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
        <span style="font-size:14px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.name || '未命名'}</span>
        <span style="font-size:11px;color:var(--text-secondary)">${iconLabel} · ${tagCount}个标签</span>
      </div>
      <div style="display:flex;gap:6px">
        <button type="button" onclick="Worldview._radioEditCat(${i})" style="padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:12px;cursor:pointer">编辑</button>
        <button type="button" onclick="Worldview._radioDeleteCat(${i})" style="padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--danger);font-size:12px;cursor:pointer">删除</button>
      </div>
    </div>`;
  }).join('');

  overlay.innerHTML = `
  <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 12px;display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:8px">
      <button type="button" onclick="Worldview.closeRadioCatsEditor()" style="border:none;background:none;color:var(--text);cursor:pointer;padding:4px">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <span style="font-size:16px;font-weight:600;color:var(--text)">电台分类管理</span>
    </div>
  </div>
  <div style="flex:1;overflow-y:auto;padding:0 16px 24px">
    <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">预设分类</div>
    ${presetsHtml}
    <div style="font-size:13px;font-weight:600;color:var(--text);margin-top:16px;margin-bottom:8px">自建分类</div>
    ${customsHtml || '<div style="font-size:12px;color:var(--text-secondary);padding:12px;text-align:center">还没有自建分类</div>'}
    <button type="button" onclick="Worldview._radioAddCat()" style="width:100%;margin-top:12px;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">+ 新建分类</button>
    <button type="button" onclick="Worldview.aiGenerateRadioCats()" style="width:100%;margin-top:8px;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>AI 生成分类</button>
  </div>`;
}
  async function closeRadioCatsEditor() {
    const overlay = document.getElementById('radio-cats-editor-overlay');
    if (overlay) overlay.remove();
  }

  // ===== 电台「可出场角色」编辑器 =====
  // castMode: 'default'(发全部,AI自选) | 'disabled'(不发名单) | 'whitelist'(只发勾选)
  // castWhitelist: [{ id, name }]  存世界观 NPC + 单人卡角色的 id+name
  // castIncludeLorebook: bool  勾选后，挂载的世界书 NPC 整体放行
  // 收集可勾选的角色：世界观所有 NPC（全图常驻 + 地区/势力挂载）+ 单人卡全部角色
  async function _radioCollectCastChars(w) {
    const wv = [];
    const cards = [];
    const seen = new Set();
    const _addWv = (n) => {
      if (!n || !n.id || seen.has(n.id)) return;
      seen.add(n.id);
      wv.push({ id: n.id, name: n.name || '未命名', aliases: n.aliases || '', avatar: n.avatar || '', group: 'wv' });
    };
    (w.globalNpcs || []).forEach(_addWv);
    (w.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(_addWv)));
    try {
      const list = await SingleCard.getAll();
      (list || []).forEach(c => {
        if (!c || !c.id || seen.has(c.id)) return;
        seen.add(c.id);
        cards.push({ id: c.id, name: c.name || '未命名角色', aliases: c.aliases || '', avatar: c.avatar || '', group: 'card' });
      });
    } catch (_) {}
    return { wv, cards };
  }

  async function openRadioCastEditor() {
    const w = await _getEditingWV();
    if (!w) { UI.showToast('请先选择世界观', 1200); return; }
    w.phoneApps = w.phoneApps || {};
    w.phoneApps.radio = w.phoneApps.radio || {};
    if (!w.phoneApps.radio.castMode) w.phoneApps.radio.castMode = 'default';
    if (!Array.isArray(w.phoneApps.radio.castWhitelist)) w.phoneApps.radio.castWhitelist = [];
    if (typeof w.phoneApps.radio.castIncludeLorebook !== 'boolean') w.phoneApps.radio.castIncludeLorebook = false;

    let overlay = document.getElementById('radio-cast-editor-overlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'radio-cast-editor-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;animation:sbFadeIn .2s ease-out';
    document.body.appendChild(overlay);
    _renderRadioCastEditor(overlay, w);
  }

  async function _renderRadioCastEditor(overlay, w, query = '') {
    const radio = w.phoneApps.radio;
    const mode = radio.castMode || 'default';
    const picked = new Set((radio.castWhitelist || []).map(x => x.id));
    const incLore = !!radio.castIncludeLorebook;

    const modeBtn = (val, label, desc) => `
      <div onclick="Worldview._radioSetCastMode('${val}')" style="padding:10px 12px;border-radius:8px;margin-bottom:6px;cursor:pointer;border:1px solid ${mode === val ? 'var(--accent)' : 'var(--border)'};background:${mode === val ? 'color-mix(in srgb, var(--accent) 12%, var(--bg-tertiary))' : 'var(--bg-tertiary)'}">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="width:16px;height:16px;border-radius:50%;border:2px solid ${mode === val ? 'var(--accent)' : 'var(--text-secondary)'};display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${mode === val ? '<span style="width:8px;height:8px;border-radius:50%;background:var(--accent)"></span>' : ''}</span>
          <span style="font-size:14px;color:var(--text);font-weight:600">${label}</span>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;margin-left:24px">${desc}</div>
      </div>`;

    let listHtml = '';
    if (mode === 'whitelist') {
      const { wv, cards } = await _radioCollectCastChars(w);
      const q = String(query || '').toLowerCase().trim();
      const matchQ = (n) => !q || [n.name, n.aliases].some(v => String(v || '').toLowerCase().includes(q));
      const charRow = (n) => {
        const on = picked.has(n.id);
        return `<div onclick="Worldview._radioToggleCastNpc('${n.id}')" style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};border-radius:8px;background:var(--bg-tertiary);cursor:pointer;margin-bottom:6px">
          <div style="width:34px;height:34px;border-radius:50%;overflow:hidden;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0">${n.avatar ? `<img src="${Utils.escapeHtml(n.avatar)}" style="width:100%;height:100%;object-fit:cover">` : Utils.escapeHtml((n.name || '?').slice(0,1))}</div>
          <div style="min-width:0;flex:1">
            <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(n.name)}${n.aliases ? `<span style="font-size:11px;color:var(--text-secondary)"> · ${Utils.escapeHtml(n.aliases)}</span>` : ''}</div>
          </div>
          <span style="width:20px;height:20px;border-radius:50%;border:2px solid ${on ? 'var(--accent)' : 'var(--text-secondary)'};background:${on ? 'var(--accent)' : 'transparent'};display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${on ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</span>
        </div>`;
      };
      const groupHtml = (title, arr) => {
        const f = arr.filter(matchQ);
        if (!f.length) return '';
        return `<div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-top:12px;margin-bottom:6px">${title}（${f.length}）</div>${f.map(charRow).join('')}`;
      };
      const wvGroup = groupHtml('世界观角色', wv);
      const cardGroup = groupHtml('单人卡角色', cards);
      const noResult = (!wvGroup && !cardGroup) ? `<div style="padding:14px;text-align:center;color:var(--text-secondary);font-size:12px">${q ? '没有匹配的角色' : '没有可选的角色'}</div>` : '';
      // 世界书角色：整体开关复选框（不预知具体角色，运行时按来源放行）
      const loreBox = `
        <div onclick="Worldview._radioToggleCastLorebook()" style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid ${incLore ? 'var(--accent)' : 'var(--border)'};border-radius:8px;background:${incLore ? 'color-mix(in srgb, var(--accent) 12%, var(--bg-tertiary))' : 'var(--bg-tertiary)'};cursor:pointer;margin-top:16px">
          <span style="width:20px;height:20px;border-radius:5px;border:2px solid ${incLore ? 'var(--accent)' : 'var(--text-secondary)'};background:${incLore ? 'var(--accent)' : 'transparent'};display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${incLore ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</span>
          <div style="min-width:0;flex:1">
            <div style="font-size:13px;color:var(--text);font-weight:600">世界书角色</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">勾选后，当前挂载的世界书 NPC 全部可出场（无需逐个选）</div>
          </div>
        </div>`;
      listHtml = `
        <div style="font-size:13px;font-weight:600;color:var(--text);margin-top:16px;margin-bottom:8px">勾选可出场的角色（已选 ${picked.size}${incLore ? ' + 世界书' : ''}）</div>
        <input id="radio-cast-search" placeholder="搜索角色 / 别名" oninput="Worldview._radioCastSearch(this.value)" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;margin-bottom:8px">
        <div>${wvGroup}${cardGroup}${noResult}</div>
        ${loreBox}`;
    }

    // 重渲染前记录滚动位置（toggle 勾选不应弹回顶部）
    const _prevScroll = (() => { const sc = overlay.querySelector('.wv-cast-scroll'); return sc ? sc.scrollTop : 0; })();
    overlay.innerHTML = `
    <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 12px;display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:8px">
        <button type="button" onclick="Worldview.closeRadioCastEditor()" style="border:none;background:none;color:var(--text);cursor:pointer;padding:4px">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span style="font-size:16px;font-weight:600;color:var(--text)">可出场角色</span>
      </div>
    </div>
    <div class="wv-cast-scroll" style="flex:1;overflow-y:auto;padding:0 16px 24px">
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;line-height:1.6">生成电台预览时，决定哪些角色可能出任主播 / 嘉宾。该设置只影响预览生成阶段。</div>
      ${modeBtn('default', '默认', '发送全部角色，由 AI 自行挑选合适的人出场')}
      ${modeBtn('disabled', '禁用', '不发送任何角色名单，主播 / 嘉宾全部为虚构')}
      ${modeBtn('whitelist', '勾选', '只发送下方勾选的角色，AI 只能从中挑选')}
      ${listHtml}
    </div>`;
    // 恢复滚动位置
    const _sc = overlay.querySelector('.wv-cast-scroll');
    if (_sc && _prevScroll) _sc.scrollTop = _prevScroll;
  }

  async function closeRadioCastEditor() {
    const overlay = document.getElementById('radio-cast-editor-overlay');
    if (overlay) overlay.remove();
  }

  async function _radioSetCastMode(mode) {
    const w = await _getEditingWV(); if (!w) return;
    w.phoneApps = w.phoneApps || {}; w.phoneApps.radio = w.phoneApps.radio || {};
    w.phoneApps.radio.castMode = ['default', 'disabled', 'whitelist'].includes(mode) ? mode : 'default';
    if (!Array.isArray(w.phoneApps.radio.castWhitelist)) w.phoneApps.radio.castWhitelist = [];
    await _saveEditingWV(w);
    const overlay = document.getElementById('radio-cast-editor-overlay');
    if (overlay) _renderRadioCastEditor(overlay, w);
  }

  async function _radioToggleCastNpc(npcId) {
    const w = await _getEditingWV(); if (!w) return;
    w.phoneApps = w.phoneApps || {}; w.phoneApps.radio = w.phoneApps.radio || {};
    if (!Array.isArray(w.phoneApps.radio.castWhitelist)) w.phoneApps.radio.castWhitelist = [];
    const list = w.phoneApps.radio.castWhitelist;
    const idx = list.findIndex(x => x.id === npcId);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      const { wv, cards } = await _radioCollectCastChars(w);
      const npc = [...wv, ...cards].find(n => n.id === npcId);
      if (npc) list.push({ id: npc.id, name: npc.name });
    }
    await _saveEditingWV(w);
    const overlay = document.getElementById('radio-cast-editor-overlay');
    const q = (document.getElementById('radio-cast-search') || {}).value || '';
    if (overlay) _renderRadioCastEditor(overlay, w, q);
  }

  async function _radioToggleCastLorebook() {
    const w = await _getEditingWV(); if (!w) return;
    w.phoneApps = w.phoneApps || {}; w.phoneApps.radio = w.phoneApps.radio || {};
    w.phoneApps.radio.castIncludeLorebook = !w.phoneApps.radio.castIncludeLorebook;
    await _saveEditingWV(w);
    const overlay = document.getElementById('radio-cast-editor-overlay');
    const q = (document.getElementById('radio-cast-search') || {}).value || '';
    if (overlay) _renderRadioCastEditor(overlay, w, q);
  }
function _radioCastSearch(query) {
    const overlay = document.getElementById('radio-cast-editor-overlay');
    if (!overlay) return;
    _getEditingWV().then(w => { if (w) _renderRadioCastEditor(overlay, w, query); });
  }

  // ===== 阅读「可出场作者」编辑器 =====
  // 与电台同款三档：castMode default/disabled/whitelist；castWhitelist [{id,name}]；castIncludeLorebook bool
  // 存进 w.phoneApps.reading，复用电台的角色收集器 _radioCollectCastChars
  async function openReadingCastEditor() {
    const w = await _getEditingWV();
    if (!w) { UI.showToast('请先选择世界观', 1200); return; }
    w.phoneApps = w.phoneApps || {};
    w.phoneApps.reading = w.phoneApps.reading || {};
    if (!Array.isArray(w.phoneApps.reading.castWhitelist)) w.phoneApps.reading.castWhitelist = [];
    if (typeof w.phoneApps.reading.castIncludeLorebook !== 'boolean') w.phoneApps.reading.castIncludeLorebook = false;

    let overlay = document.getElementById('reading-cast-editor-overlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'reading-cast-editor-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;animation:sbFadeIn .2s ease-out';
    document.body.appendChild(overlay);
    _renderReadingCastEditor(overlay, w);
  }

  // 阅读「可出场作者」：纯白名单（没勾人=作者全虚构；勾了=AI 只能从名单里挑人署名）。
  // 与电台不同——作者身份与人物素材分离，默认不发任何 NPC 当作者，只有勾选的才发。
  async function _renderReadingCastEditor(overlay, w, query = '') {
    const reading = w.phoneApps.reading;
    const picked = new Set((reading.castWhitelist || []).map(x => x.id));
    const incLore = !!reading.castIncludeLorebook;

    const { wv, cards } = await _radioCollectCastChars(w);
    const q = String(query || '').toLowerCase().trim();
    const matchQ = (n) => !q || [n.name, n.aliases].some(v => String(v || '').toLowerCase().includes(q));
    const charRow = (n) => {
      const on = picked.has(n.id);
      return `<div onclick="Worldview._readingToggleCastNpc('${n.id}')" style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};border-radius:8px;background:var(--bg-tertiary);cursor:pointer;margin-bottom:6px">
        <div style="width:34px;height:34px;border-radius:50%;overflow:hidden;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0">${n.avatar ? `<img src="${Utils.escapeHtml(n.avatar)}" style="width:100%;height:100%;object-fit:cover">` : Utils.escapeHtml((n.name || '?').slice(0,1))}</div>
        <div style="min-width:0;flex:1">
          <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(n.name)}${n.aliases ? `<span style="font-size:11px;color:var(--text-secondary)"> · ${Utils.escapeHtml(n.aliases)}</span>` : ''}</div>
        </div>
        <span style="width:20px;height:20px;border-radius:50%;border:2px solid ${on ? 'var(--accent)' : 'var(--text-secondary)'};background:${on ? 'var(--accent)' : 'transparent'};display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${on ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</span>
      </div>`;
    };
    const groupHtml = (title, arr) => {
      const f = arr.filter(matchQ);
      if (!f.length) return '';
      return `<div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-top:12px;margin-bottom:6px">${title}（${f.length}）</div>${f.map(charRow).join('')}`;
    };
    const wvGroup = groupHtml('世界观角色', wv);
    const cardGroup = groupHtml('单人卡角色', cards);
    const noResult = (!wvGroup && !cardGroup) ? `<div style="padding:14px;text-align:center;color:var(--text-secondary);font-size:12px">${q ? '没有匹配的角色' : '没有可选的角色'}</div>` : '';
    const loreBox = `
      <div onclick="Worldview._readingToggleCastLorebook()" style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid ${incLore ? 'var(--accent)' : 'var(--border)'};border-radius:8px;background:${incLore ? 'color-mix(in srgb, var(--accent) 12%, var(--bg-tertiary))' : 'var(--bg-tertiary)'};cursor:pointer;margin-top:16px">
        <span style="width:20px;height:20px;border-radius:5px;border:2px solid ${incLore ? 'var(--accent)' : 'var(--text-secondary)'};background:${incLore ? 'var(--accent)' : 'transparent'};display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${incLore ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</span>
        <div style="min-width:0;flex:1">
          <div style="font-size:13px;color:var(--text);font-weight:600">世界书角色</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">勾选后，当前挂载的世界书 NPC 全部可成为作者（无需逐个选）</div>
        </div>
      </div>`;
    const countLabel = (picked.size || incLore) ? `已选 ${picked.size}${incLore ? ' + 世界书' : ''}` : '未选 · 作者将全部虚构';
    const listHtml = `
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-top:4px;margin-bottom:8px">勾选可成为作者的角色（${countLabel}）</div>
      <input id="reading-cast-search" placeholder="搜索角色 / 别名" oninput="Worldview._readingCastSearch(this.value)" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;margin-bottom:8px">
      <div>${wvGroup}${cardGroup}${noResult}</div>
      ${loreBox}`;

    // 重渲染前记录滚动位置（toggle 勾选不应弹回顶部）
    const _prevScroll = (() => { const sc = overlay.querySelector('.wv-cast-scroll'); return sc ? sc.scrollTop : 0; })();
    overlay.innerHTML = `
    <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 12px;display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:8px">
        <button type="button" onclick="Worldview.closeReadingCastEditor()" style="border:none;background:none;color:var(--text);cursor:pointer;padding:4px">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span style="font-size:16px;font-weight:600;color:var(--text)">可出场作者</span>
      </div>
    </div>
    <div class="wv-cast-scroll" style="flex:1;overflow-y:auto;padding:0 16px 24px">
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;line-height:1.6">设置哪些角色可以作为书的作者署名。不勾任何人则作者全部虚构；勾了谁，AI 就只能从这些人里挑选作者。此设置独立于「注入世界观」和「映射」，只决定作者身份。</div>
      ${listHtml}
    </div>`;
    // 恢复滚动位置
    const _sc = overlay.querySelector('.wv-cast-scroll');
    if (_sc && _prevScroll) _sc.scrollTop = _prevScroll;
  }

  async function closeReadingCastEditor() {
    const overlay = document.getElementById('reading-cast-editor-overlay');
    if (overlay) overlay.remove();
  }

  async function _readingToggleCastNpc(npcId) {
    const w = await _getEditingWV(); if (!w) return;
    w.phoneApps = w.phoneApps || {}; w.phoneApps.reading = w.phoneApps.reading || {};
    if (!Array.isArray(w.phoneApps.reading.castWhitelist)) w.phoneApps.reading.castWhitelist = [];
    const list = w.phoneApps.reading.castWhitelist;
    const idx = list.findIndex(x => x.id === npcId);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      const { wv, cards } = await _radioCollectCastChars(w);
      const npc = [...wv, ...cards].find(n => n.id === npcId);
      if (npc) list.push({ id: npc.id, name: npc.name });
    }
    await _saveEditingWV(w);
    const overlay = document.getElementById('reading-cast-editor-overlay');
    const q = (document.getElementById('reading-cast-search') || {}).value || '';
    if (overlay) _renderReadingCastEditor(overlay, w, q);
  }

  async function _readingToggleCastLorebook() {
    const w = await _getEditingWV(); if (!w) return;
    w.phoneApps = w.phoneApps || {}; w.phoneApps.reading = w.phoneApps.reading || {};
    w.phoneApps.reading.castIncludeLorebook = !w.phoneApps.reading.castIncludeLorebook;
    await _saveEditingWV(w);
    const overlay = document.getElementById('reading-cast-editor-overlay');
    const q = (document.getElementById('reading-cast-search') || {}).value || '';
    if (overlay) _renderReadingCastEditor(overlay, w, q);
  }

  function _readingCastSearch(query) {
    const overlay = document.getElementById('reading-cast-editor-overlay');
    if (!overlay) return;
    _getEditingWV().then(w => { if (w) _renderReadingCastEditor(overlay, w, query); });
  }

  // ===== 视频「导演/编剧/演员」名单编辑器 =====
  // 真人影视（电影+电视剧共用）：director / screenwriter / actor
  // 动画专属：animeDirector(监督) / animeScript(系列构成) / animeCv(配音演员) / animeArt(作画)
  // 各自独立纯白名单，存进 w.phoneApps.video.{key} [{id,name}]，复用电台的角色收集器
  const _VIDEO_CAST_ROLES = {
    director:     { key: 'directorWhitelist',     title: '导演名单', noun: '导演' },
    screenwriter: { key: 'screenwriterWhitelist', title: '编剧名单', noun: '编剧' },
    actor:        { key: 'actorWhitelist',        title: '演员名单', noun: '演员' },
    animeDirector: { key: 'animeDirectorWhitelist', title: '监督名单',   noun: '监督' },
    animeScript:   { key: 'animeScriptWhitelist',   title: '系列构成名单', noun: '系列构成' },
    animeCv:       { key: 'animeCvWhitelist',       title: '配音演员名单', noun: '配音演员' },
    animeArt:      { key: 'animeArtWhitelist',      title: '作画名单',     noun: '作画' },
    streamer:      { key: 'streamerWhitelist',      title: '主播名单',     noun: '主播' },
  };
  let _videoCastRole = 'director';

  async function openVideoCastEditor(role) {
    if (!_VIDEO_CAST_ROLES[role]) role = 'director';
    _videoCastRole = role;
    const w = await _getEditingWV();
    if (!w) { UI.showToast('请先选择世界观', 1200); return; }
    w.phoneApps = w.phoneApps || {};
    w.phoneApps.video = w.phoneApps.video || {};
    const key = _VIDEO_CAST_ROLES[role].key;
    if (!Array.isArray(w.phoneApps.video[key])) w.phoneApps.video[key] = [];

    let overlay = document.getElementById('video-cast-editor-overlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'video-cast-editor-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;animation:sbFadeIn .2s ease-out';
    document.body.appendChild(overlay);
    _renderVideoCastEditor(overlay, w);
  }

  async function _renderVideoCastEditor(overlay, w, query = '') {
    const role = _VIDEO_CAST_ROLES[_videoCastRole] ? _videoCastRole : 'director';
    const conf = _VIDEO_CAST_ROLES[role];
    const video = w.phoneApps.video || (w.phoneApps.video = {});
    if (!Array.isArray(video[conf.key])) video[conf.key] = [];
    const picked = new Set((video[conf.key] || []).map(x => x.id));

    const { wv, cards } = await _radioCollectCastChars(w);
    const q = String(query || '').toLowerCase().trim();
    const matchQ = (n) => !q || [n.name, n.aliases].some(v => String(v || '').toLowerCase().includes(q));
    const charRow = (n) => {
      const on = picked.has(n.id);
      return `<div onclick="Worldview._videoToggleCastNpc('${n.id}')" style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};border-radius:8px;background:var(--bg-tertiary);cursor:pointer;margin-bottom:6px">
        <div style="width:34px;height:34px;border-radius:50%;overflow:hidden;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0">${n.avatar ? `<img src="${Utils.escapeHtml(n.avatar)}" style="width:100%;height:100%;object-fit:cover">` : Utils.escapeHtml((n.name || '?').slice(0,1))}</div>
        <div style="min-width:0;flex:1">
          <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(n.name)}${n.aliases ? `<span style="font-size:11px;color:var(--text-secondary)"> · ${Utils.escapeHtml(n.aliases)}</span>` : ''}</div>
        </div>
        <span style="width:20px;height:20px;border-radius:50%;border:2px solid ${on ? 'var(--accent)' : 'var(--text-secondary)'};background:${on ? 'var(--accent)' : 'transparent'};display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${on ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</span>
      </div>`;
    };
    const groupHtml = (title, arr) => {
      const f = arr.filter(matchQ);
      if (!f.length) return '';
      return `<div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-top:12px;margin-bottom:6px">${title}（${f.length}）</div>${f.map(charRow).join('')}`;
    };
    const wvGroup = groupHtml('世界观角色', wv);
    const cardGroup = groupHtml('单人卡角色', cards);
    const noResult = (!wvGroup && !cardGroup) ? `<div style="padding:14px;text-align:center;color:var(--text-secondary);font-size:12px">${q ? '没有匹配的角色' : '没有可选的角色'}</div>` : '';
    const countLabel = picked.size ? `已选 ${picked.size}` : `未选 · ${conf.noun}将全部虚构`;
    const listHtml = `
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-top:4px;margin-bottom:8px">勾选可担任${conf.noun}的角色（${countLabel}）</div>
      <input id="video-cast-search" placeholder="搜索角色 / 别名" oninput="Worldview._videoCastSearch(this.value)" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;margin-bottom:8px">
      <div>${wvGroup}${cardGroup}${noResult}</div>`;

    const _prevScroll = (() => { const sc = overlay.querySelector('.wv-cast-scroll'); return sc ? sc.scrollTop : 0; })();
    overlay.innerHTML = `
    <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 12px;display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:8px">
        <button type="button" onclick="Worldview.closeVideoCastEditor()" style="border:none;background:none;color:var(--text);cursor:pointer;padding:4px">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span style="font-size:16px;font-weight:600;color:var(--text)">${conf.title}</span>
      </div>
    </div>
    <div class="wv-cast-scroll" style="flex:1;overflow-y:auto;padding:0 16px 24px">
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;line-height:1.6">设置哪些角色可以担任${conf.noun}。不勾任何人则${conf.noun}全部虚构；勾了谁，AI 就可能从这些人里挑选担任${conf.noun}。导演、编剧、演员是三份独立名单，互不影响。</div>
      ${listHtml}
    </div>`;
    const _sc = overlay.querySelector('.wv-cast-scroll');
    if (_sc && _prevScroll) _sc.scrollTop = _prevScroll;
  }

  async function closeVideoCastEditor() {
    const overlay = document.getElementById('video-cast-editor-overlay');
    if (overlay) overlay.remove();
  }

  async function _videoToggleCastNpc(npcId) {
    const w = await _getEditingWV(); if (!w) return;
    const conf = _VIDEO_CAST_ROLES[_videoCastRole] || _VIDEO_CAST_ROLES.director;
    w.phoneApps = w.phoneApps || {}; w.phoneApps.video = w.phoneApps.video || {};
    if (!Array.isArray(w.phoneApps.video[conf.key])) w.phoneApps.video[conf.key] = [];
    const list = w.phoneApps.video[conf.key];
    const idx = list.findIndex(x => x.id === npcId);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      const { wv, cards } = await _radioCollectCastChars(w);
      const npc = [...wv, ...cards].find(n => n.id === npcId);
      if (npc) list.push({ id: npc.id, name: npc.name });
    }
    await _saveEditingWV(w);
    const overlay = document.getElementById('video-cast-editor-overlay');
    const q = (document.getElementById('video-cast-search') || {}).value || '';
    if (overlay) _renderVideoCastEditor(overlay, w, q);
  }
function _videoCastSearch(query) {
    const overlay = document.getElementById('video-cast-editor-overlay');
    if (!overlay) return;
    _getEditingWV().then(w => { if (w) _renderVideoCastEditor(overlay, w, query); });
  }

  // ===== 直播品类编辑器（phoneApps.video.liveCats）=====
  // 结构：{ hiddenPresets:[预设品类名], categories:[{name, desc, plays:['call'|'pk'|'cart']}] }
  // 预设品类靠 name 隐藏；自建品类填 名称+调性+可用玩法（三选，可不选）。
  const _LIVE_PRESET_TAG_NAMES = ['游戏直播', '单人唱歌', '唱歌团播', '单人舞蹈', '舞蹈团播', '带货卖货', '颜值聊天', '兴趣陪伴', 'ASMR', '答疑咨询'];
  const _LIVE_PLAY_OPTIONS = [
    { id: 'call', label: '连麦连线', hint: '观众付费上麦和主播一对一聊' },
    { id: 'pk', label: '礼物 PK', hint: '和别的主播连麦battle刷礼物冲榜' },
    { id: 'cart', label: '购物车带货', hint: '挂商品，观众下单购买' },
  ];

  async function openLiveCategoriesEditor() {
    const w = await _getEditingWV();
    if (!w) { UI.showToast('请先选择世界观', 1200); return; }
    w.phoneApps = w.phoneApps || {};
    w.phoneApps.video = w.phoneApps.video || {};
    w.phoneApps.video.liveCats = w.phoneApps.video.liveCats || {};
    if (!Array.isArray(w.phoneApps.video.liveCats.hiddenPresets)) w.phoneApps.video.liveCats.hiddenPresets = [];
    if (!Array.isArray(w.phoneApps.video.liveCats.categories)) w.phoneApps.video.liveCats.categories = [];

    let overlay = document.getElementById('live-cats-editor-overlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'live-cats-editor-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;animation:sbFadeIn .2s ease-out';
    document.body.appendChild(overlay);
    _renderLiveCatsEditor(overlay, w);
  }

  function _renderLiveCatsEditor(overlay, w) {
    const cfg = w.phoneApps.video.liveCats;
    const hidden = new Set(cfg.hiddenPresets || []);
    const customs = cfg.categories || [];

    const presetsHtml = _LIVE_PRESET_TAG_NAMES.map(name => {
      const isHidden = hidden.has(name);
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-tertiary);border-radius:8px;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:14px;color:var(--text)">${name}</span>
          <span style="font-size:11px;color:var(--text-secondary)">预设</span>
        </div>
        <button type="button" onclick="Worldview._liveTogglePreset('${name.replace(/'/g, "\\'")}')" style="padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:${isHidden ? 'var(--accent)' : 'var(--bg-secondary)'};color:${isHidden ? '#fff' : 'var(--text)'};font-size:12px;cursor:pointer">${isHidden ? '恢复' : '隐藏'}</button>
      </div>`;
    }).join('');

    const customsHtml = customs.map((c, i) => {
      const playLabels = (c.plays || []).map(pid => (_LIVE_PLAY_OPTIONS.find(o => o.id === pid) || {}).label).filter(Boolean);
      const playStr = playLabels.length ? playLabels.join(' · ') : '无附加玩法';
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-tertiary);border-radius:8px;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
          <span style="font-size:14px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.name || '未命名'}</span>
          <span style="font-size:11px;color:var(--text-secondary);white-space:nowrap">${playStr}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button type="button" onclick="Worldview._liveEditCat(${i})" style="padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:12px;cursor:pointer">编辑</button>
          <button type="button" onclick="Worldview._liveDeleteCat(${i})" style="padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--danger);font-size:12px;cursor:pointer">删除</button>
        </div>
      </div>`;
    }).join('');

    overlay.innerHTML = `
    <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 12px;display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:8px">
        <button type="button" onclick="Worldview.closeLiveCatsEditor()" style="border:none;background:none;color:var(--text);cursor:pointer;padding:4px">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span style="font-size:16px;font-weight:600;color:var(--text)">直播品类管理</span>
      </div>
    </div>
    <div style="flex:1;overflow-y:auto;padding:0 16px 24px">
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">预设品类</div>
      ${presetsHtml}
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-top:16px;margin-bottom:8px">自建品类</div>
      ${customsHtml || '<div style="font-size:12px;color:var(--text-secondary);padding:12px;text-align:center">还没有自建品类</div>'}
      <button type="button" onclick="Worldview._liveAddCat()" style="width:100%;margin-top:12px;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">+ 新建品类</button>
      <button type="button" onclick="Worldview.aiGenerateLiveCats()" style="width:100%;margin-top:8px;padding:10px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>AI 生成品类</button>
    </div>`;
  }

  async function closeLiveCatsEditor() {
    const overlay = document.getElementById('live-cats-editor-overlay');
    if (overlay) overlay.remove();
  }

  async function _liveTogglePreset(name) {
    const w = await _getEditingWV(); if (!w) return;
    w.phoneApps = w.phoneApps || {}; w.phoneApps.video = w.phoneApps.video || {};
    w.phoneApps.video.liveCats = w.phoneApps.video.liveCats || {};
    if (!Array.isArray(w.phoneApps.video.liveCats.hiddenPresets)) w.phoneApps.video.liveCats.hiddenPresets = [];
    const arr = w.phoneApps.video.liveCats.hiddenPresets;
    const idx = arr.indexOf(name);
    if (idx >= 0) arr.splice(idx, 1); else arr.push(name);
    await _saveEditingWV(w);
    const overlay = document.getElementById('live-cats-editor-overlay');
    if (overlay) _renderLiveCatsEditor(overlay, w);
  }

  async function _liveAddCat() {
    const w = await _getEditingWV(); if (!w) return;
    w.phoneApps = w.phoneApps || {}; w.phoneApps.video = w.phoneApps.video || {};
    w.phoneApps.video.liveCats = w.phoneApps.video.liveCats || {};
    if (!Array.isArray(w.phoneApps.video.liveCats.categories)) w.phoneApps.video.liveCats.categories = [];
    w.phoneApps.video.liveCats.categories.push({ name: '', desc: '', plays: [] });
    await _saveEditingWV(w);
    _liveOpenCatEditor(w, w.phoneApps.video.liveCats.categories.length - 1);
  }

  async function _liveEditCat(idx) {
    const w = await _getEditingWV(); if (!w) return;
    _liveOpenCatEditor(w, idx);
  }

  async function _liveDeleteCat(idx) {
    const w = await _getEditingWV(); if (!w) return;
    const cats = w.phoneApps?.video?.liveCats?.categories;
    if (!cats || !cats[idx]) return;
    if (!await UI.showConfirm('删除品类', `确定删除自建品类「${cats[idx].name || '未命名'}」？`)) return;
    cats.splice(idx, 1);
    await _saveEditingWV(w);
    const overlay = document.getElementById('live-cats-editor-overlay');
    if (overlay) _renderLiveCatsEditor(overlay, w);
  }

  function _liveOpenCatEditor(w, catIdx) {
    const cats = w.phoneApps?.video?.liveCats?.categories;
    if (!cats || !cats[catIdx]) return;
    const overlay = document.getElementById('live-cats-editor-overlay');
    if (!overlay) return;
    const cat = cats[catIdx];
    const plays = new Set(cat.plays || []);

    const playBtns = _LIVE_PLAY_OPTIONS.map(o => {
      const on = plays.has(o.id);
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px">
        <div style="flex:1;min-width:0;margin-right:10px">
          <div style="font-size:14px;color:var(--text)">${o.label}</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${o.hint}</div>
        </div>
        <button type="button" onclick="Worldview._liveToggleCatPlay(${catIdx},'${o.id}')" style="padding:6px 14px;border-radius:6px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};background:${on ? 'var(--accent)' : 'var(--bg-tertiary)'};color:${on ? '#fff' : 'var(--text)'};font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">${on ? '已开启' : '开启'}</button>
      </div>`;
    }).join('');

    overlay.innerHTML = `
    <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 12px;display:flex;align-items:center;gap:8px">
      <button type="button" onclick="Worldview._liveBackToCatsList()" style="border:none;background:none;color:var(--text);cursor:pointer;padding:4px">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <span style="font-size:16px;font-weight:600;color:var(--text)">编辑品类</span>
    </div>
    <div style="flex:1;overflow-y:auto;padding:0 16px 24px">
      <label style="display:block;margin-bottom:12px">
        <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">品类名称</span>
        <input type="text" id="lc-cat-name" value="${(cat.name || '').replace(/"/g, '"')}" placeholder="例如：钓鱼陪聊 / 学习自习室" style="width:100%;padding:8px 10px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px" onchange="Worldview._liveSaveCatField(${catIdx},'name',this.value)">
      </label>
      <label style="display:block;margin-bottom:16px">
        <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">品类调性 <span style="font-size:11px;color:var(--text-secondary)">（告诉AI这是什么样的直播间）</span></span>
        <textarea id="lc-cat-desc" rows="3" placeholder="例如：主播在野外钓鱼，一边等鱼一边和观众闲聊，氛围松弛安静，观众围观催更、聊钓技、刷礼物应援。可以是真人，也可以是虚拟主播。" style="width:100%;padding:8px 10px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px;line-height:1.5;resize:vertical;min-height:70px" onchange="Worldview._liveSaveCatField(${catIdx},'desc',this.value)">${(cat.desc || '').replace(/</g, '&lt;')}</textarea>
      </label>
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">可用玩法</div>
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">按需开启，不开则这个品类只有基础的弹幕/打赏互动</div>
      ${playBtns}
    </div>`;
  }

  async function _liveBackToCatsList() {
    const w = await _getEditingWV(); if (!w) return;
    const overlay = document.getElementById('live-cats-editor-overlay');
    if (overlay) _renderLiveCatsEditor(overlay, w);
  }

  async function _liveSaveCatField(catIdx, field, value) {
    const w = await _getEditingWV(); if (!w) return;
    const cat = w.phoneApps?.video?.liveCats?.categories?.[catIdx]; if (!cat) return;
    cat[field] = (value || '').trim();
    await _saveEditingWV(w);
  }

  async function _liveToggleCatPlay(catIdx, playId) {
    const w = await _getEditingWV(); if (!w) return;
    const cat = w.phoneApps?.video?.liveCats?.categories?.[catIdx]; if (!cat) return;
    if (!Array.isArray(cat.plays)) cat.plays = [];
    const idx = cat.plays.indexOf(playId);
    if (idx >= 0) cat.plays.splice(idx, 1); else cat.plays.push(playId);
    await _saveEditingWV(w);
    _liveOpenCatEditor(w, catIdx);
  }




async function _radioTogglePreset(presetId) {
  const w = await _getEditingWV(); if (!w) return;
  w.phoneApps = w.phoneApps || {}; w.phoneApps.radio = w.phoneApps.radio || {};
  if (!Array.isArray(w.phoneApps.radio.hiddenPresets)) w.phoneApps.radio.hiddenPresets = [];
  const arr = w.phoneApps.radio.hiddenPresets;
  const idx = arr.indexOf(presetId);
  if (idx >= 0) arr.splice(idx, 1); else arr.push(presetId);
  await _saveEditingWV(w);
  const overlay = document.getElementById('radio-cats-editor-overlay');
  if (overlay) _renderRadioCatsEditor(overlay, w);
}

async function _radioAddCat() {
  const w = await _getEditingWV(); if (!w) return;
  w.phoneApps = w.phoneApps || {}; w.phoneApps.radio = w.phoneApps.radio || {};
  if (!Array.isArray(w.phoneApps.radio.categories)) w.phoneApps.radio.categories = [];
  const newCat = { id: 'rc_' + Date.now().toString(36), name: '', icon: 'mic', direction: '', tags: [] };
  w.phoneApps.radio.categories.push(newCat);
  await _saveEditingWV(w);
  // 直接打开编辑
  _radioOpenCatEditor(w, w.phoneApps.radio.categories.length - 1);
}

async function _radioEditCat(idx) {
  const w = await _getEditingWV(); if (!w) return;
  _radioOpenCatEditor(w, idx);
}

async function _radioDeleteCat(idx) {
  const w = await _getEditingWV(); if (!w) return;
  const cats = w.phoneApps?.radio?.categories;
  if (!cats || !cats[idx]) return;
  if (!await UI.showConfirm('删除分类', `确定删除分类「${cats[idx].name || '未命名'}」？其下所有标签也会被删除。`)) return;
  cats.splice(idx, 1);
  await _saveEditingWV(w);
  const overlay = document.getElementById('radio-cats-editor-overlay');
  if (overlay) _renderRadioCatsEditor(overlay, w);
}

// ===== 单个分类编辑器 =====
function _radioOpenCatEditor(w, catIdx) {
  const cats = w.phoneApps?.radio?.categories;
  if (!cats || !cats[catIdx]) return;
  const overlay = document.getElementById('radio-cats-editor-overlay');
  if (!overlay) return;
  const cat = cats[catIdx];

  const iconBtns = _RADIO_ICON_OPTIONS.map(o =>
    `<button type="button" data-icon="${o.id}" onclick="Worldview._radioSetCatIcon(${catIdx},'${o.id}')" style="padding:6px 10px;border-radius:6px;border:1px solid ${cat.icon === o.id ? 'var(--accent)' : 'var(--border)'};background:${cat.icon === o.id ? 'color-mix(in srgb, var(--accent) 15%, var(--bg-secondary))' : 'var(--bg-secondary)'};color:${cat.icon === o.id ? 'var(--accent)' : 'var(--text)'};font-size:12px;cursor:pointer">${o.label}</button>`
  ).join('');

  const tagRows = (cat.tags || []).map((t, ti) =>
    `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--bg-secondary);border-radius:6px;margin-bottom:4px">
      <span style="font-size:13px;color:var(--text);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.name || '未命名标签'}</span>
      <div style="display:flex;gap:4px">
        <button type="button" onclick="Worldview._radioEditTag(${catIdx},${ti})" style="padding:4px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:11px;cursor:pointer">编辑</button>
        <button type="button" onclick="Worldview._radioDeleteTag(${catIdx},${ti})" style="padding:4px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--danger);font-size:11px;cursor:pointer">删</button>
      </div>
    </div>`
  ).join('');

  overlay.innerHTML = `
  <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 12px;display:flex;align-items:center;gap:8px">
    <button type="button" onclick="Worldview._radioBackToCatsList()" style="border:none;background:none;color:var(--text);cursor:pointer;padding:4px">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <span style="font-size:16px;font-weight:600;color:var(--text)">编辑分类</span>
  </div>
  <div style="flex:1;overflow-y:auto;padding:0 16px 24px">
    <label style="display:block;margin-bottom:12px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">分类名称</span>
      <input type="text" id="rc-cat-name" value="${(cat.name || '').replace(/"/g, '"')}" placeholder="例如：深夜食堂" style="width:100%;padding:8px 10px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px" onchange="Worldview._radioSaveCatField(${catIdx},'name',this.value)">
    </label>
    <div style="margin-bottom:12px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:6px">图标</span>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${iconBtns}</div>
    </div>
    <label style="display:block;margin-bottom:16px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">大方向 <span style="font-size:11px;color:var(--text-secondary)">（告诉AI这个分类的基调）</span></span>
      <textarea id="rc-cat-direction" rows="2" placeholder="例如：都市夜归人的美食与人情" style="width:100%;padding:8px 10px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px;line-height:1.5;resize:vertical;min-height:50px" onchange="Worldview._radioSaveCatField(${catIdx},'direction',this.value)">${(cat.direction || '').replace(/</g, '&lt;')}</textarea>
    </label>
    <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">标签列表</div>
    ${tagRows || '<div style="font-size:12px;color:var(--text-secondary);padding:8px;text-align:center">还没有标签，点下方按钮添加</div>'}
    <button type="button" onclick="Worldview._radioAddTag(${catIdx})" style="width:100%;margin-top:8px;padding:8px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">+ 添加标签</button>
    <button type="button" onclick="Worldview.aiGenerateRadioTags(${catIdx})" style="width:100%;margin-top:6px;padding:8px;background:var(--bg-secondary);color:var(--accent);border:1px solid var(--accent);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>AI 生成标签</button>
  </div>`;
}

async function _radioBackToCatsList() {
  const w = await _getEditingWV(); if (!w) return;
  const overlay = document.getElementById('radio-cats-editor-overlay');
  if (overlay) _renderRadioCatsEditor(overlay, w);
}

async function _radioSetCatIcon(catIdx, iconId) {
  const w = await _getEditingWV(); if (!w) return;
  const cat = w.phoneApps?.radio?.categories?.[catIdx]; if (!cat) return;
  cat.icon = iconId;
  await _saveEditingWV(w);
  _radioOpenCatEditor(w, catIdx);
}

async function _radioSaveCatField(catIdx, field, value) {
  const w = await _getEditingWV(); if (!w) return;
  const cat = w.phoneApps?.radio?.categories?.[catIdx]; if (!cat) return;
  cat[field] = (value || '').trim();
  await _saveEditingWV(w);
}

async function _radioAddTag(catIdx) {
  const w = await _getEditingWV(); if (!w) return;
  const cat = w.phoneApps?.radio?.categories?.[catIdx]; if (!cat) return;
  if (!Array.isArray(cat.tags)) cat.tags = [];
  cat.tags.push({ name: '', desc: '', guide: '', wordCount: 2000, plays: [], renewMode: 'unit' });
  await _saveEditingWV(w);
  _radioOpenTagEditor(w, catIdx, cat.tags.length - 1);
}

async function _radioEditTag(catIdx, tagIdx) {
  const w = await _getEditingWV(); if (!w) return;
  _radioOpenTagEditor(w, catIdx, tagIdx);
}

async function _radioDeleteTag(catIdx, tagIdx) {
  const w = await _getEditingWV(); if (!w) return;
  const cat = w.phoneApps?.radio?.categories?.[catIdx]; if (!cat) return;
  const tags = cat.tags || []; if (!tags[tagIdx]) return;
  if (!await UI.showConfirm('删除标签', `确定删除标签「${tags[tagIdx].name || '未命名'}」？`)) return;
  tags.splice(tagIdx, 1);
  await _saveEditingWV(w);
  _radioOpenCatEditor(w, catIdx);
}

// ===== 标签编辑器 =====
const _RADIO_PLAY_OPTIONS = [
  { id: 'mail', label: '读留言' }, { id: 'vote', label: '投票' }, { id: 'request', label: '点歌' },
  { id: 'call', label: '连线' }, { id: 'lottery', label: '抽奖' }, { id: 'divination', label: '问卜' },
];

function _radioOpenTagEditor(w, catIdx, tagIdx) {
  const cat = w.phoneApps?.radio?.categories?.[catIdx]; if (!cat) return;
  const tags = cat.tags || []; const tag = tags[tagIdx]; if (!tag) return;
  const overlay = document.getElementById('radio-cats-editor-overlay'); if (!overlay) return;

  const playsSet = new Set(tag.plays || []);
  const playCheckboxes = _RADIO_PLAY_OPTIONS.map(p =>
    `<label style="display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;border:1px solid ${playsSet.has(p.id) ? 'var(--accent)' : 'var(--border)'};background:${playsSet.has(p.id) ? 'color-mix(in srgb, var(--accent) 15%, var(--bg-secondary))' : 'var(--bg-secondary)'};color:var(--text);font-size:12px;cursor:pointer">
      <span style="position:relative;display:inline-flex;flex-shrink:0">
        <input type="checkbox" class="circle-check" value="${p.id}" ${playsSet.has(p.id) ? 'checked' : ''} onchange="Worldview._radioToggleTagPlay(${catIdx},${tagIdx},this.value,this.checked)">
        <span class="circle-check-ui"></span>
      </span>
      ${p.label}
    </label>`
  ).join('');

  const renewMode = tag.renewMode || 'unit';

  overlay.innerHTML = `
  <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 12px;display:flex;align-items:center;gap:8px">
    <button type="button" onclick="Worldview._radioBackToCatEditor(${catIdx})" style="border:none;background:none;color:var(--text);cursor:pointer;padding:4px">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <span style="font-size:16px;font-weight:600;color:var(--text)">编辑标签</span>
  </div>
  <div style="flex:1;overflow-y:auto;padding:0 16px 24px">
    <label style="display:block;margin-bottom:12px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">标签名称 <span style="font-size:11px;color:var(--text-secondary)">（预览时喂给AI）</span></span>
      <input type="text" id="rt-tag-name" value="${(tag.name || '').replace(/"/g, '"')}" placeholder="例如：夜宵闲话" style="width:100%;padding:8px 10px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px" onchange="Worldview._radioSaveTagField(${catIdx},${tagIdx},'name',this.value)">
    </label>
    <label style="display:block;margin-bottom:12px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">描述 <span style="font-size:11px;color:var(--text-secondary)">（预览时喂给AI，让它判断某个台该不该挂这个标签）</span></span>
      <textarea id="rt-tag-desc" rows="2" placeholder="例如：围绕一种深夜会吃的食物，讲讲来吃的人和他们的故事" style="width:100%;padding:8px 10px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px;line-height:1.5;resize:vertical;min-height:50px" onchange="Worldview._radioSaveTagField(${catIdx},${tagIdx},'desc',this.value)">${(tag.desc || '').replace(/</g, '&lt;')}</textarea>
    </label>
    <label style="display:block;margin-bottom:12px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">规则 <span style="font-size:11px;color:var(--text-secondary)">（选填，详情生成时注入AI）</span></span>
      <textarea id="rt-tag-guide" rows="3" placeholder="例如：轻松温暖的调子，别煽情过头，每期围绕一个具体的小主题展开" style="width:100%;padding:8px 10px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px;line-height:1.5;resize:vertical;min-height:70px" onchange="Worldview._radioSaveTagField(${catIdx},${tagIdx},'guide',this.value)">${(tag.guide || '').replace(/</g, '&lt;')}</textarea>
    </label>
    <label style="display:block;margin-bottom:12px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:4px">字数</span>
      <input type="number" id="rt-tag-wordCount" value="${tag.wordCount || 2000}" min="500" max="5000" step="100" style="width:100%;padding:8px 10px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px" onchange="Worldview._radioSaveTagField(${catIdx},${tagIdx},'wordCount',parseInt(this.value)||2000)">
    </label>
    <div style="margin-bottom:12px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:6px">可用玩法 <span style="font-size:11px;color:var(--text-secondary)">（AI最多从中挑一个融入节目）</span></span>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${playCheckboxes}</div>
    </div>
    <div style="margin-bottom:12px">
      <span style="display:block;font-size:12px;color:var(--text);margin-bottom:6px">续期方式 <span style="font-size:11px;color:var(--text-secondary)">（收听本期更新时如何处理上一期）</span></span>
      <div style="display:flex;gap:6px">
        <button type="button" onclick="Worldview._radioSetTagRenewMode(${catIdx},${tagIdx},'unit')" style="flex:1;padding:8px;border-radius:6px;border:1px solid ${renewMode === 'unit' ? 'var(--accent)' : 'var(--border)'};background:${renewMode === 'unit' ? 'color-mix(in srgb, var(--accent) 15%, var(--bg-secondary))' : 'var(--bg-secondary)'};color:${renewMode === 'unit' ? 'var(--accent)' : 'var(--text)'};font-size:12px;cursor:pointer">独立单元</button>
        <button type="button" onclick="Worldview._radioSetTagRenewMode(${catIdx},${tagIdx},'serial')" style="flex:1;padding:8px;border-radius:6px;border:1px solid ${renewMode === 'serial' ? 'var(--accent)' : 'var(--border)'};background:${renewMode === 'serial' ? 'color-mix(in srgb, var(--accent) 15%, var(--bg-secondary))' : 'var(--bg-secondary)'};color:${renewMode === 'serial' ? 'var(--accent)' : 'var(--text)'};font-size:12px;cursor:pointer">连载</button>
        <button type="button" onclick="Worldview._radioSetTagRenewMode(${catIdx},${tagIdx},'free')" style="flex:1;padding:8px;border-radius:6px;border:1px solid ${renewMode === 'free' ? 'var(--accent)' : 'var(--border)'};background:${renewMode === 'free' ? 'color-mix(in srgb, var(--accent) 15%, var(--bg-secondary))' : 'var(--bg-secondary)'};color:${renewMode === 'free' ? 'var(--accent)' : 'var(--text)'};font-size:12px;cursor:pointer">自由发挥</button>
      </div>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;line-height:1.4">
        独立单元：换题材避免撞车 · 连载：接着上一期往下讲 · 自由发挥：参考上期开头
      </div>
    </div>
  </div>`;
}

async function _radioBackToCatEditor(catIdx) {
  const w = await _getEditingWV(); if (!w) return;
  _radioOpenCatEditor(w, catIdx);
}

async function _radioSaveTagField(catIdx, tagIdx, field, value) {
  const w = await _getEditingWV(); if (!w) return;
  const tag = w.phoneApps?.radio?.categories?.[catIdx]?.tags?.[tagIdx]; if (!tag) return;
  tag[field] = (typeof value === 'string') ? value.trim() : value;
  await _saveEditingWV(w);
}

async function _radioToggleTagPlay(catIdx, tagIdx, playId, checked) {
  const w = await _getEditingWV(); if (!w) return;
  const tag = w.phoneApps?.radio?.categories?.[catIdx]?.tags?.[tagIdx]; if (!tag) return;
  if (!Array.isArray(tag.plays)) tag.plays = [];
  const idx = tag.plays.indexOf(playId);
  if (checked && idx < 0) tag.plays.push(playId);
  else if (!checked && idx >= 0) tag.plays.splice(idx, 1);
  await _saveEditingWV(w);
}

async function _radioSetTagRenewMode(catIdx, tagIdx, mode) {
  const w = await _getEditingWV(); if (!w) return;
  const tag = w.phoneApps?.radio?.categories?.[catIdx]?.tags?.[tagIdx]; if (!tag) return;
  tag.renewMode = mode;
  await _saveEditingWV(w);
  _radioOpenTagEditor(w, catIdx, tagIdx);
}

async function _calAddWeekDay() {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  cal.weekDayNames.push(`第${cal.weekDayNames.length + 1}日`);
  cal.weekDayTypes.push('work');
  cal.daysPerWeek = cal.weekDayNames.length;
  await _saveEditingWV(w);
  _calSaveAndRefresh();
}

async function _calRemoveWeekDay(idx) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  if (cal.weekDayNames.length <= 1) return;
  cal.weekDayNames.splice(idx, 1);
  cal.weekDayTypes.splice(idx, 1);
  cal.daysPerWeek = cal.weekDayNames.length;
  await _saveEditingWV(w);
  _calSaveAndRefresh();
}

async function _calToggleDayType(idx) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  if (!cal.weekDayTypes) cal.weekDayTypes = cal.weekDayNames.map(() => 'work');
  cal.weekDayTypes[idx] = cal.weekDayTypes[idx] === 'rest' ? 'work' : 'rest';
  await _saveEditingWV(w);
  _calSaveAndRefresh();
}

async function _calSetMonthMode(uniform) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  cal.uniformDaysPerMonth = uniform;
  if (uniform) {
    const d = cal.daysPerMonth[0] || 30;
    cal.daysPerMonth = Array(cal.monthsPerYear).fill(d);
  }
  await _saveEditingWV(w);
  _calSaveAndRefresh();
}

async function _calSetUniformDays(val) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  const d = Math.max(1, parseInt(val) || 30);
  cal.daysPerMonth = Array(cal.monthsPerYear).fill(d);
  await _saveEditingWV(w);
}

async function _calSetMonthDays(idx, val) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  cal.daysPerMonth[idx] = Math.max(1, parseInt(val) || 30);
  await _saveEditingWV(w);
}

async function _calAddMonth() {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  cal.monthsPerYear += 1;
  cal.daysPerMonth.push(cal.uniformDaysPerMonth ? (cal.daysPerMonth[0] || 30) : 30);
  await _saveEditingWV(w);
  _calSaveAndRefresh();
}

async function _calRemoveMonth() {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  if (cal.monthsPerYear <= 1) return;
  cal.monthsPerYear -= 1;
  cal.daysPerMonth.pop();
  cal.seasons.forEach(s => { s.months = (s.months || []).filter(m => m <= cal.monthsPerYear); });
  await _saveEditingWV(w);
  _calSaveAndRefresh();
}

async function _calSetSeasonName(idx, val) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  if (cal.seasons[idx]) cal.seasons[idx].name = val;
  await _saveEditingWV(w);
}

async function _calSetSeasonMonths(idx, val) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  if (cal.seasons[idx]) {
    cal.seasons[idx].months = val.split(/[,，、\s]+/).map(s => parseInt(s)).filter(n => n > 0 && n <= cal.monthsPerYear);
  }
  await _saveEditingWV(w);
}

async function _calSetSeasonWeather(idx, val) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  if (cal.seasons[idx]) cal.seasons[idx].weather = val;
  await _saveEditingWV(w);
}

async function _calAddSeason() {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  cal.seasons.push({ name: '', months: [], weather: '' });
  await _saveEditingWV(w);
  _calSaveAndRefresh();
}

async function _calRemoveSeason(idx) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  cal.seasons.splice(idx, 1);
  await _saveEditingWV(w);
  _calSaveAndRefresh();
}

// ===== 时段操作 =====

async function _calSetPeriodName(idx, val) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  if (!cal.timePeriods) cal.timePeriods = [];
  if (cal.timePeriods[idx]) cal.timePeriods[idx].name = val;
  await _saveEditingWV(w);
}

async function _calSetPeriodHour(idx, val) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  if (!cal.timePeriods) cal.timePeriods = [];
  if (cal.timePeriods[idx]) {
    cal.timePeriods[idx].startHour = Math.max(0, Math.min(23, parseInt(val) || 0));
    // 按 startHour 升序排列
    cal.timePeriods.sort((a, b) => a.startHour - b.startHour);
    // 强制首个时段从 0 点开始（覆盖凌晨时分，避免 0 点到首段之间出现无归属的时间空洞）
    if (cal.timePeriods.length > 0 && cal.timePeriods[0].startHour !== 0) {
      cal.timePeriods[0].startHour = 0;
      try { UI.showToast('首个时段已自动设为 0 点起', 1800); } catch(_) {}
    }
  }
  await _saveEditingWV(w);
  _calSaveAndRefresh();
}

async function _calSetPeriodDesc(idx, val) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  if (!cal.timePeriods) cal.timePeriods = [];
  if (cal.timePeriods[idx]) cal.timePeriods[idx].desc = val;
  await _saveEditingWV(w);
}

async function _calAddPeriod() {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  if (!cal.timePeriods) cal.timePeriods = [];
  cal.timePeriods.push({ name: '', startHour: 0, desc: '' });
  cal.timePeriods.sort((a, b) => a.startHour - b.startHour);
  await _saveEditingWV(w);
  _calSaveAndRefresh();
}

async function _calRemovePeriod(idx) {
  const w = await _getEditingWV(); if (!w) return;
  const cal = _ensureCalendarSystem(w);
  if (!cal.timePeriods) return;
  cal.timePeriods.splice(idx, 1);
  // 删除后若首段不再从 0 点开始，自动拉回 0（避免删掉 0 点段后凌晨无归属）
  if (cal.timePeriods.length > 0 && cal.timePeriods[0].startHour !== 0) {
    cal.timePeriods[0].startHour = 0;
    try { UI.showToast('首个时段已自动设为 0 点起', 1800); } catch(_) {}
  }
  await _saveEditingWV(w);
  _calSaveAndRefresh();
}

async function _calReset() {
  const w = await _getEditingWV(); if (!w) return;
  const gp = _ensureGameplay(w);
  gp.calendarSystem = null;
  _ensureCalendarSystem(w);
  await _saveEditingWV(w);
  _calSaveAndRefresh();
  UI.showToast('已恢复默认历法', 1200);
}

function _tryExitEdit() {
  // 正常退出：保存 + 停定时器 + 返回列表
  if (typeof Worldview !== 'undefined') {
    if (Worldview.save) try { Worldview.save({ silent: true }); } catch(_) {}
    if (Worldview._stopFullSaveTimer) try { Worldview._stopFullSaveTimer(); } catch(_) {}
  }
  // 检查 returnTo
  const rt = (typeof Worldview !== 'undefined' && Worldview.getEditReturnTo) ? Worldview.getEditReturnTo() : null;
  if (rt === 'single-card-edit') {
    if (Worldview.clearEditReturnTo) Worldview.clearEditReturnTo();
    if (typeof SingleCard !== 'undefined' && SingleCard.restoreEditPanel) {
      SingleCard.restoreEditPanel();
    } else {
      UI.showPanel('single-card-edit', 'back');
    }
  } else if (rt === 'lorebook-list') {
    if (Worldview.clearEditReturnTo) Worldview.clearEditReturnTo();
    UI.showPanel('worldview', 'back');
    if (typeof Worldview !== 'undefined' && Worldview.switchWorldTab) Worldview.switchWorldTab('lb');
    if (typeof LorebookUI !== 'undefined' && LorebookUI.renderList) setTimeout(() => LorebookUI.renderList(), 50);
  } else {
    UI.showPanel('worldview', 'back');
  }
}

  return {
    init: load,
    load,
    createWorldview,
    getWorldviewList,
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
    addEvent, editEvent, saveEventFromModal, deleteEventFromModal, closeEventModal, syncEventTriggerTypeUI, addEventAttrCondition, updateEventAttrCondition, removeEventAttrCondition,
    aiGenerateEvents, _doAiGenerateEvents, switchEventTab, addEventChain, addChainNode,
      aiGenerateGlobalAttrs, _doAiGenerateGlobalAttrs,
      aiGenerateCharAttrs, _doAiGenerateCharAttrs, _charAttrPickAll,
aiGenerateTaskPhase,
    _doAiGenerateTaskPhase,
    aiGenerateCalendar,
    _doAiGenerateCalendar,
    aiGenerateShops,
    _doAiGenerateShops,
    aiGenerateMediaApps,
    _doAiGenerateMediaApps,
    aiGenerateRadioCats,
    _doAiGenerateRadioCats,
    aiGenerateRadioTags,
    _doAiGenerateRadioTags,
    aiGenerateLiveCats,
    _doAiGenerateLiveCats,
    _onCardClick,
    applyBuiltinUpdate,
    handleIconImageUpload,
    clearIconImage,
    addRegion, addFaction, addNPC,
    openRegionEdit, saveRegion, deleteRegion,
    openFactionEdit, saveFaction, deleteFaction,
    openNPCEdit, saveNPC, deleteNPC, exportCurrentNpc,
    addGlobalNpc, editGlobalNpc, backFromNpcEdit,
    _pickEditingNpcAvatar, _aiGenEditingNpcAvatar, _clearEditingNpcAvatar,
    openNpcImporter,
    _bulkImportNpcs,
    _getEditingWVForImporter,
    _editingRegionIdxForImporter,
    _editingFactionIdxForImporter,
    addGameplayAttr, updateGameplayAttr, deleteGameplayAttr, openGameplayAttrModal, closeGameplayAttrModal, saveGameplayAttrFromModal, deleteGameplayAttrFromModal, deleteGameplayCharacter, inheritCharAttrs, toggleGameplayCharPicker, renderGameplayCharPicker, selectGameplayCharacter,
    addCurrency, updateCurrency, deleteCurrency, bindCurrencyToAttr, applyGeneratedCurrency,
    addTaskPhase, deleteTaskPhase, updateTaskPhase, addTaskType, deleteTaskType, updateTaskType, updateTaskPhaseReward,
    openTaskTypeModal, closeTaskTypeModal, saveTaskTypeFromModal, deleteTaskTypeFromModal, onTaskTypeRewardModeChange, openPhaseRewardModal,
    openCalendarEditor, closeCalendarEditor,
    openPhoneAppsEditor, closePhoneAppsEditor,
openRadioCategoriesEditor, closeRadioCatsEditor, _radioTogglePreset, _radioAddCat, _radioEditCat, _radioDeleteCat,
    openRadioCastEditor, closeRadioCastEditor, _radioSetCastMode, _radioToggleCastNpc, _radioToggleCastLorebook, _radioCastSearch,
    openReadingCastEditor, closeReadingCastEditor, _readingToggleCastNpc, _readingToggleCastLorebook, _readingCastSearch,
    openVideoCastEditor, closeVideoCastEditor, _videoToggleCastNpc, _videoCastSearch,
    openLiveCategoriesEditor, closeLiveCatsEditor, _liveTogglePreset, _liveAddCat, _liveEditCat, _liveDeleteCat,
    _liveOpenCatEditor, _liveBackToCatsList, _liveSaveCatField, _liveToggleCatPlay,
_radioOpenCatEditor, _radioBackToCatsList, _radioSetCatIcon, _radioSaveCatField,
_radioAddTag, _radioEditTag, _radioDeleteTag, _radioOpenTagEditor, _radioBackToCatEditor, _radioSaveTagField, _radioToggleTagPlay, _radioSetTagRenewMode,
    _onCalWeekDayChange, _calAddWeekDay, _calRemoveWeekDay, _calToggleDayType, _calSetMonthMode, _calSetUniformDays, _calSetMonthDays, _calAddMonth, _calRemoveMonth,
    _calSetSeasonName, _calSetSeasonMonths, _calSetSeasonWeather, _calAddSeason, _calRemoveSeason, _calReset,
    _calSetPeriodName, _calSetPeriodHour, _calSetPeriodDesc, _calAddPeriod, _calRemovePeriod,
    _onStartTimeChange,
    _tryExitEdit,
    _getEditingWV, _saveEditingWV, _renderGlobalNpcs: _renderGlobalNpcs, _renderRegions: _renderRegions, _renderFactionCards: _renderFactionCards, _renderNPCCards: _renderNPCCards, _fillStartTimeFields,
editLorebookDescription,
    addFestival, editFestival, saveFestivalFromModal, deleteFestivalFromModal, closeFestivalModal, aiGenFestivals, _doAiGenFestivals,
  addCustom, importCustomsFromDoc, editCustom, saveCustomFromModal, deleteCustomFromModal, closeCustomModal,
addKnowledge, editKnowledge, saveKnowledgeFromModal, deleteKnowledgeFromModal, closeKnowledgeModal, aiGenKnowledges, _doAiGenKnowledges,
toggleCustPositionDropdown, selectCustPosition, toggleKnowPositionDropdown, selectKnowPosition,
    getCurrent, setCurrentId, getCurrentId,
    openViewer, switchViewerTab, filterViewerNPCs,
    toggleViewerNPCDropdown, selectViewerNPCFilter,
    toggleScopeDropdown,
    selectWorldview,
    reapplyStatusBarSkin,
    _toggleSkinDropdown, _selectSkin,
    toggleThemeDropdown, selectTheme,
    openDefaultThemePicker, closeDefaultThemePicker, pickDefaultTheme, openDefaultSkinPicker, closeDefaultSkinPicker, pickDefaultSkin,
    restoreCurrentWorldview: _restoreCurrentWorldview,
    exportCurrent, importSingle, restoreBuiltinWorldview: _restoreBuiltinWorldview, toggleEditMoreMenu: _toggleEditMoreMenu, closeEditMoreMenu: _closeEditMoreMenu, loadBuiltinWorldviews: _loadBuiltinWorldviews, migrateTianshuchengNpcNames: _migrateTianshuchengNpcNames,
    ensureHiddenWvForCard, deleteHiddenWvForCard, isHiddenWv,
    getEditReturnTo, clearEditReturnTo, _stopFullSaveTimer,
    switchWorldTab(tab) {
    const wvBtn = document.getElementById('world-tab-wv-btn');
    const charBtn = document.getElementById('world-tab-char-btn');
    const lbBtn = document.getElementById('world-tab-lb-btn');
    const wvPane = document.getElementById('world-tab-wv');
    const charPane = document.getElementById('world-tab-char');
    const lbPane = document.getElementById('world-tab-lb');
    if (!wvBtn || !charBtn || !wvPane || !charPane) return;
    const _play = (el, dir) => {
      el.classList.remove('tab-pane-enter-left', 'tab-pane-enter-right');
      void el.offsetWidth;
      el.classList.add(dir === 'left' ? 'tab-pane-enter-left' : 'tab-pane-enter-right');
    };
    const _setActive = (btn, active) => {
      if (!btn) return;
      btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
      btn.style.color = active ? 'var(--accent)' : 'var(--text-secondary)';
      btn.style.fontWeight = active ? '600' : '400';
    };
    _setActive(wvBtn, tab === 'wv');
    _setActive(charBtn, tab === 'char');
    _setActive(lbBtn, tab === 'lb');
    wvPane.style.display = (tab === 'wv') ? '' : 'none';
    charPane.style.display = (tab === 'char') ? '' : 'none';
    if (lbPane) lbPane.style.display = (tab === 'lb') ? '' : 'none';
    if (tab === 'char') {
      _play(charPane, 'right');
      if (typeof SingleCard !== 'undefined') SingleCard.renderList();
    } else if (tab === 'lb') {
      if (lbPane) _play(lbPane, 'right');
      if (typeof LorebookUI !== 'undefined') LorebookUI.renderList();
    } else {
      _play(wvPane, 'left');
      // 与 char/lb 分支保持一致：切回世界观 Tab 时也重渲列表，
      // 避免外部状态（如切主题）影响后内容区为空、需刷新才回来
      try { load(); } catch(_) {}
    }
  }
  };
  })();

// 显式挂到 window，供其他模块通过 window.Worldview 访问
try { window.Worldview = Worldview; } catch(_) {}
