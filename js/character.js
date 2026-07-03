/**
 * 面具（角色卡）管理 — 多面具支持
 */
const Character = (() => {
  const BASIC_FIELDS = ['name', 'onlineName', 'background', 'note'];
  let currentMaskId = 'default';
  let editingMaskId = null; // 当前在弹窗中编辑的面具

  let currentAvatar = null; // 当前面具头像 dataURL 缓存

  let activeAvatar = null; // 当前使用的面具的头像（发送气泡时读取）

  async function getMaskList() {
  const data = await DB.get('gameState', 'maskList');
  return data?.value || [{ id: 'default', name: '默认面具' }];
}

// 取出当前对话所属的世界观 id —— 决定底栏快速切换显示哪些面具
function _getCurrentConvWvId() {
  try {
    if (typeof Conversations === 'undefined') return '';
    const convId = Conversations.getCurrent && Conversations.getCurrent();
    if (!convId) return '';
    const conv = Conversations.getList().find(c => c.id === convId);
    if (!conv) return '';
    return conv.worldviewId || conv.singleWorldviewId || conv.singleCharSourceWvId || '';
  } catch(_) { return ''; }
}

// 检查 wvId 是否对应一个仍存在的世界观（删了的归通用）
async function _isValidWvId(wvId) {
  if (!wvId) return false;
  try {
    const wv = await DB.get('worldviews', wvId);
    return !!wv;
  } catch(_) { return false; }
}

// 拿当前世界观下应该可见的面具（通用 + 当前世界观；wvId 失效的也归通用）
async function _getMasksForCurrentWv() {
  const all = await getMaskList();
  const curWvId = _getCurrentConvWvId();
  // 收集所有 wvId 失效的面具，当成通用看
  const validIds = new Set();
  try {
    const allWvs = await DB.getAll('worldviews');
    allWvs.forEach(w => { if (w && w.id) validIds.add(w.id); });
  } catch(_) {}
  return all.filter(m => {
    // 默认面具永远视为通用（即使旧数据误绑了 wvId）
    if (m.id === 'default') return true;
    const wid = m.worldviewId || '';
    if (!wid) return true; // 通用
    if (!validIds.has(wid)) return true; // 失效→当通用
    if (!curWvId) return !wid; // 没当前世界观→只显示通用
    return wid === curWvId;
  });
}

  async function saveMaskList(list) {
    await DB.put('gameState', { key: 'maskList', value: list });
  }

  async function load(maskId) {
    if (maskId) currentMaskId = maskId;
    const data = await DB.get('characters', currentMaskId);
    
    // 头像
    currentAvatar = data?.avatar || null;
    updateAvatarPreview();
    
    // 给编辑弹窗里的表单赋值
    BASIC_FIELDS.forEach(f => {
      const el = document.getElementById(`char-${f}`);
      if (el) el.value = data?.[f] || '';
    });
    try { Utils.refreshAutoResizeTextareas(document.getElementById('panel-mask-edit') || document); } catch(e) {}
    requestAnimationFrame(() => {
      const ta = document.getElementById('char-background');
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
      ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
    });
    renderAbilities(data?.abilities || []);
    renderInventory(data?.inventory || []);
    
    await renderMaskList();
  }

  let manageMode = false;
  let selectedIds = new Set();
  // v616 排序模式 / 菜单
  let sortMode = false;
  let sortedList = [];
  let menuVisible = false;

  async function renderMaskList(filter = '') {
    if (sortMode) { _renderSortList(); return; }
    const list = await getMaskList();
    const query = filter.trim().toLowerCase();
    const container = document.getElementById('mask-list-container');
    if (!container) return;

    // 按 sortOrder 升序，没有的按列表原顺序
    list.sort((a, b) => {
      const hasA = typeof a.sortOrder === 'number';
      const hasB = typeof b.sortOrder === 'number';
      if (hasA && hasB) return a.sortOrder - b.sortOrder;
      if (hasA) return -1;
      if (hasB) return 1;
      return 0;
    });

    // 分组：通用 + 各世界观（wvId 失效的归通用）
    const allWvs = (await DB.getAll('worldviews').catch(() => [])) || [];
    const wvById = {};
    allWvs.forEach(w => { if (w && w.id && !w._hidden) wvById[w.id] = w; });

    // groups: { 'general': [], 'wvId1': [], ... }
    const groups = { general: [] };
    const groupOrder = ['general'];
    for (const m of list) {
      if (query && !m.name.toLowerCase().includes(query)) continue;
      const wid = m.worldviewId || '';
      let bucketId = 'general';
      // 默认面具强制归入"通用"分组（即使旧数据误绑了 wvId）
      if (m.id !== 'default' && wid && wvById[wid]) bucketId = wid;
      if (!groups[bucketId]) {
        groups[bucketId] = [];
        groupOrder.push(bucketId);
      }
      groups[bucketId].push(m);
    }

    const renderCard = async (m) => {
      const data = await DB.get('characters', m.id);
      const avatarSrc = data?.avatar || '';
      const note = data?.note || m.note || '';
      const background = data?.background || '';
      const preview = note || (background ? (background.length > 80 ? background.slice(0, 80) + '...' : background) : '暂无设定');
      const checked = selectedIds.has(m.id);
      return `
        <div class="card mask-card-item" data-id="${m.id}" onclick="Character._onCardClick('${m.id}')" style="display:flex;gap:12px;padding:12px;align-items:center;background:var(--bg-tertiary);cursor:pointer;">
          ${manageMode ? `<span class="mask-check-circle ${checked ? 'checked' : ''}" data-id="${m.id}" style="width:22px;height:22px;border-radius:50%;border:2px solid ${checked ? 'var(--accent)' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${checked ? 'background:var(--accent);' : ''}">
            ${checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
          </span>` : ''}
          <div style="width:56px;height:56px;border-radius:50%;background:${avatarSrc ? `var(--bg-secondary) url(${avatarSrc}) center/cover` : 'var(--accent)'};border:${avatarSrc ? '2px solid var(--border)' : 'none'};display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;">
            ${!avatarSrc ? '<span style="font-size:30px;color:rgba(255,255,255,0.8)">✦</span>' : ''}
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:16px;font-weight:bold;color:var(--accent);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${Utils.escapeHtml(m.name)}</div>
            <div style="font-size:12px;color:var(--text);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;">
              ${Utils.escapeHtml(preview)}
            </div>
          </div>
        </div>
      `;
    };

    let html = '';
    for (const groupId of groupOrder) {
      const group = groups[groupId];
      if (!group || group.length === 0) continue;
      const groupName = groupId === 'general' ? '通用' : (wvById[groupId]?.name || '未命名世界观');
      html += `<div style="font-size:12px;color:var(--text-secondary);font-weight:600;padding:8px 4px 4px;letter-spacing:0.5px;opacity:0.85">${Utils.escapeHtml(groupName)} · ${group.length}</div>`;
      for (const m of group) {
        html += await renderCard(m);
      }
    }
    if (!html) html = '<div style="text-align:center;color:var(--text-secondary);padding:40px 0;font-size:13px;opacity:0.6">没有匹配的面具</div>';
    container.innerHTML = html;
    _updateSelectAllIcon();
  }

  function _onCardClick(maskId) {
    if (manageMode) {
      // 管理模式：切换选中状态
      if (selectedIds.has(maskId)) selectedIds.delete(maskId);
      else selectedIds.add(maskId);
      renderMaskList(document.getElementById('mask-search')?.value || '');
    } else {
      // 普通模式：进入编辑
      UI.setMaskEditFrom('character');
      openEdit(maskId);
    }
  }

  function exitManageMode() {
    if (!manageMode) return;
    manageMode = false;
    selectedIds.clear();
    const bar = document.getElementById('mask-manage-bar');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    const container = document.getElementById('mask-list-container');
    if (container) container.style.paddingBottom = '';
  }

  function toggleManageMode() {
    if (sortMode) exitSortMode();
    manageMode = !manageMode;
    selectedIds.clear();
    const bar = document.getElementById('mask-manage-bar');
    const container = document.getElementById('mask-list-container');
    if (manageMode) {
      if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
      if (container) container.style.paddingBottom = '72px';
    } else {
      if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
      if (container) container.style.paddingBottom = '';
    }
    renderMaskList(document.getElementById('mask-search')?.value || '');
  }

  async function toggleSelectAll() {
    const list = await getMaskList();
    if (selectedIds.size === list.length) {
      selectedIds.clear();
    } else {
      list.forEach(m => selectedIds.add(m.id));
    }
    renderMaskList(document.getElementById('mask-search')?.value || '');
  }

  async function _updateSelectAllIcon() {
    const list = await getMaskList();
    const icon = document.getElementById('mask-select-all-icon');
    if (!icon) return;
    const allSelected = list.length > 0 && selectedIds.size === list.length;
    icon.style.border = `2px solid ${allSelected ? 'var(--accent)' : 'var(--text-secondary)'}`;
    icon.style.background = allSelected ? 'var(--accent)' : 'transparent';
    icon.innerHTML = allSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '';
  }

  async function batchClone() {
    if (selectedIds.size === 0) { await UI.showAlert('提示', '请先选择面具'); return; }
    const list = await getMaskList();
    for (const sid of selectedIds) {
      const src = await DB.get('characters', sid);
      if (!src) continue;
      const newId = 'mask_' + Utils.uuid().slice(0, 8);
      const cloned = { ...src, id: newId };
      await DB.put('characters', cloned);
      const srcEntry = list.find(m => m.id === sid);
      list.push({ id: newId, name: (srcEntry?.name || '面具') + '（副本）' });
    }
    await saveMaskList(list);
    selectedIds.clear();
    await renderMaskList();
  }

  async function batchDelete() {
    if (selectedIds.size === 0) { await UI.showAlert('提示', '请先选择面具'); return; }
    const list = await getMaskList();
    if (list.length - selectedIds.size < 1) { await UI.showAlert('提示', '至少保留一个面具'); return; }
    if (!await UI.showConfirm('批量删除', `确定删除选中的 ${selectedIds.size} 个面具？`)) return;
    for (const sid of selectedIds) {
      await DB.del('characters', sid);
    }
    const newList = list.filter(m => !selectedIds.has(m.id));
    await saveMaskList(newList);
    if (selectedIds.has(currentMaskId)) {
      await switchMask(newList[0].id);
    }
    selectedIds.clear();
    exitManageMode();
    await load();
  }

  // ===== v616 菜单 / 导入 / 批量导出 / 排序（对齐记忆·世界观·单人卡） =====
  function toggleMenu() {
    const dropdown = document.getElementById('mask-menu-dropdown');
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
    const btn = document.getElementById('mask-menu-btn');
    if (btn && btn.contains(e.target)) return;
    menuVisible = false;
    const dropdown = document.getElementById('mask-menu-dropdown');
    if (dropdown) {
      dropdown.classList.add('closing');
      setTimeout(() => {
        dropdown.classList.add('hidden');
        dropdown.classList.remove('closing');
      }, 120);
    }
  }

  // 批量导出选中面具（含列表元数据 + characters 条目）
  async function exportSelected() {
    if (selectedIds.size === 0) { await UI.showAlert('提示', '请先选择面具'); return; }
    const list = await getMaskList();
    const entries = [];
    const chars = [];
    for (const sid of selectedIds) {
      const entry = list.find(m => m.id === sid);
      if (!entry) continue;
      const data = await DB.get('characters', sid);
      entries.push(entry);
      if (data) chars.push(data);
    }
    if (entries.length === 0) { UI.showToast('未找到可导出的面具'); return; }
    const exportData = { __format: 'tianshu_masks_v1_batch', list: entries, characters: chars };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `masks_${entries.length}个_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    UI.showToast(`已导出 ${entries.length} 个面具`);
  }

  // 导入面具：支持 tianshu_masks_v1_batch 批量包，也支持单个面具 JSON
  function importMask() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const list = await getMaskList();
        let count = 0;
        if (json.__format === 'tianshu_masks_v1_batch' && Array.isArray(json.list) && Array.isArray(json.characters)) {
          for (const entry of json.list) {
            const newId = 'mask_' + Utils.uuid().slice(0, 8);
            const data = json.characters.find(c => c.id === entry.id) || { id: newId };
            const cloned = { ...data, id: newId };
            await DB.put('characters', cloned);
            list.push({ id: newId, name: entry.name || '导入面具', worldviewId: entry.worldviewId || '' });
            count++;
          }
        } else if (json.__format === 'tianshu_mask_v1' && json.entry && json.character) {
          const newId = 'mask_' + Utils.uuid().slice(0, 8);
          const cloned = { ...json.character, id: newId };
          await DB.put('characters', cloned);
          list.push({ id: newId, name: json.entry.name || '导入面具', worldviewId: json.entry.worldviewId || '' });
          count = 1;
        } else {
          UI.showToast('无法识别的面具文件格式', 3000);
          return;
        }
        await saveMaskList(list);
        await renderMaskList();
        UI.showToast(`已导入 ${count} 个面具`);
      } catch (err) {
        console.error('[importMask]', err);
        UI.showToast('导入失败：' + (err.message || err));
      }
    };
    input.click();
  }

  // ===== 面具自动保存 =====
  let _maskAutoSaveTimer = null;
  const _maskAutoSave = (() => {
    const fn = async () => {
      _maskAutoSaveTimer = null;
      if (!editingMaskId) return;
      try {
        const targetId = editingMaskId; // 快照当前 ID
        const data = { id: targetId };
        BASIC_FIELDS.forEach(f => {
          const el = document.getElementById(`char-${f}`);
          data[f] = el ? el.value : '';
        });
        data.abilities = abilitiesData;
        data.inventory = inventoryData;
        data.birthday = _readBirthdayFromForm();
        data.memoryScope = targetId;
        data.avatar = currentAvatar || null;
        if (editingMaskId !== targetId) return; // 中间切面具了→放弃
        await DB.put('characters', data);
        if (editingMaskId !== targetId) return; // save 后再检查
        // 同步名字到列表（静默）
        const list = await getMaskList();
        const entry = list.find(m => m.id === targetId);
        if (entry) {
          let dirty = false;
          if (data.name && entry.name !== data.name.trim()) {
            entry.name = data.name.trim();
            dirty = true;
          }
          // 同步备注
          const newNote = (data.note || '').trim();
          if ((entry.note || '') !== newNote) {
            entry.note = newNote;
            dirty = true;
          }
          // 同步"所属世界观"下拉到 maskList 上
          const wvSel = document.getElementById('char-worldview');
          const wvVal = wvSel ? String(wvSel.value || '') : '';
          const oldWv = entry.worldviewId || '';
          if (wvVal !== oldWv) {
            if (wvVal) entry.worldviewId = wvVal;
            else delete entry.worldviewId;
            dirty = true;
          }
          if (dirty) await saveMaskList(list);
        }
      } catch(e) { GameLog?.log('warn', `[Character] 自动保存失败: ${e.message}`); }
    };
    const debounced = (...args) => {
      clearTimeout(_maskAutoSaveTimer);
      _maskAutoSaveTimer = setTimeout(() => fn(...args), 1500);
    };
    debounced.cancel = () => { clearTimeout(_maskAutoSaveTimer); _maskAutoSaveTimer = null; };
    return debounced;
  })();

  function _attachMaskAutoSave() {
    const panel = document.getElementById('panel-mask-edit');
    if (!panel) return;
    panel.querySelectorAll('input, textarea').forEach(el => {
      el.removeEventListener('input', _maskAutoSave);
      el.addEventListener('input', _maskAutoSave);
    });
    // 自定义下拉用 hidden input 承载值，用 change 事件触发自动保存
    panel.querySelectorAll('input[type="hidden"]').forEach(el => {
      el.removeEventListener('change', _maskAutoSave);
      el.addEventListener('change', _maskAutoSave);
    });
  }

  // ===== "所属世界观"自定义下拉 =====
  function _toggleWvDropdown() {
    const dropdown = document.getElementById('char-worldview-dropdown');
    if (!dropdown) return;
    const willShow = dropdown.classList.contains('hidden');
    if (willShow) {
      dropdown.classList.remove('hidden', 'closing');
    } else {
      dropdown.classList.add('closing');
      setTimeout(() => {
        dropdown.classList.add('hidden');
        dropdown.classList.remove('closing');
      }, 120);
    }
  }
  function _selectWv(id, name) {
    const hidden = document.getElementById('char-worldview');
    const label = document.getElementById('char-worldview-label');
    const dropdown = document.getElementById('char-worldview-dropdown');
    if (hidden) {
      hidden.value = id || '';
      // hidden input 的 value 改了不会自动 dispatch，手动触发让自动保存生效
      hidden.dispatchEvent(new Event('change'));
    }
    // 世界观变了→历法可能变，按当前生日值重渲染下拉（越界会自动落回未设置）
    try { _renderBirthdaySelects(_readBirthdayFromForm()); } catch (_) {}
    if (label) label.textContent = name;
    if (dropdown) {
      // 更新 active 高亮
      dropdown.querySelectorAll('.custom-dropdown-item').forEach(it => it.classList.remove('active'));
      const items = dropdown.querySelectorAll('.custom-dropdown-item');
      items.forEach(it => {
        if ((it.textContent || '').trim() === (name || '').trim()) it.classList.add('active');
      });
      dropdown.classList.add('closing');
      setTimeout(() => {
        dropdown.classList.add('hidden');
        dropdown.classList.remove('closing');
      }, 120);
    }
  }

  // 点外面关下拉
  document.addEventListener('click', (e) => {
    const trigger = document.getElementById('char-worldview-label')?.closest('button');
    const dropdown = document.getElementById('char-worldview-dropdown');
    if (!trigger || !dropdown || dropdown.classList.contains('hidden')) return;
    if (trigger.contains(e.target) || dropdown.contains(e.target)) return;
    dropdown.classList.add('closing');
    setTimeout(() => {
      dropdown.classList.add('hidden');
      dropdown.classList.remove('closing');
    }, 120);
  });

  async function openEdit(maskId) {
    _maskAutoSave.cancel(); // 切面具时取消上一张的挂起自动保存
    editingMaskId = maskId;
    const data = await DB.get('characters', maskId);
    BASIC_FIELDS.forEach(f => {
      const el = document.getElementById(`char-${f}`);
      if (el) el.value = data?.[f] || '';
    });

    // 填充"所属世界观"自定义下拉：通用 + 所有世界观
    try {
      const dropdown = document.getElementById('char-worldview-dropdown');
      const hidden = document.getElementById('char-worldview');
      const label = document.getElementById('char-worldview-label');
      const trigger = label?.closest('button');
      if (dropdown && hidden && label) {
        // 默认面具固定为"通用"，不允许修改
        if (maskId === 'default') {
          hidden.value = '';
          label.textContent = '通用（默认面具固定）';
          dropdown.innerHTML = '';
          if (trigger) {
            trigger.disabled = true;
            trigger.style.opacity = '0.6';
            trigger.style.cursor = 'not-allowed';
          }
        } else {
          if (trigger) {
            trigger.disabled = false;
            trigger.style.opacity = '';
            trigger.style.cursor = '';
          }
          const allWvs = (await DB.getAll('worldviews').catch(() => [])) || [];
          const list = await getMaskList();
          const entry = list.find(m => m.id === maskId);
          const curWvId = entry?.worldviewId || '';

          const items = [{ id: '', name: '通用（所有世界观可见）' }];
          for (const w of allWvs) {
            if (!w?.id) continue;
            // v619：过滤掉隐藏世界观（单人卡扩展专属容器，不应出现在面具下拉中）
            if (w._hidden) continue;
            if (typeof w.id === 'string' && w.id.startsWith('__sc_')) continue;
            items.push({ id: w.id, name: w.name || '未命名世界观' });
          }
          // 当前绑了一个已失效 wvId，添加灰项
          if (curWvId && !allWvs.some(w => w.id === curWvId)) {
            items.push({ id: curWvId, name: `（已失效世界观：${curWvId}）` });
          }

          hidden.value = curWvId;
          const curItem = items.find(it => it.id === curWvId) || items[0];
          label.textContent = curItem.name;

          dropdown.innerHTML = items.map(it => {
            const isActive = it.id === curWvId;
            return `<div class="custom-dropdown-item${isActive ? ' active' : ''}" onclick="Character._selectWv('${Utils.escapeHtml(it.id).replace(/'/g, '&#39;')}', this.textContent.trim())">${Utils.escapeHtml(it.name)}</div>`;
          }).join('');
        }
      }
    } catch(_) {}

    try { Utils.refreshAutoResizeTextareas(document.getElementById('panel-mask-edit') || document); } catch(e) {}
    renderAbilities(data?.abilities || []);
    renderInventory(data?.inventory || []);
    _renderBirthdaySelects(data?.birthday || null);
    currentAvatar = data?.avatar || null;
    updateAvatarPreview();
    UI.showPanel('mask-edit');
    // 绑定自动保存
    requestAnimationFrame(_attachMaskAutoSave);
    const resizeMaskBackground = () => {
      const ta = document.getElementById('char-background');
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
      ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
    };
    requestAnimationFrame(resizeMaskBackground);
    setTimeout(resizeMaskBackground, 260);
    setTimeout(resizeMaskBackground, 420);
  }

  function updateAvatarPreview() {
const preview = document.getElementById('mask-avatar-preview');
const placeholder = document.getElementById('mask-avatar-placeholder');
if (!preview) return;
if (currentAvatar) {
preview.style.backgroundImage = `url(${currentAvatar})`;
preview.style.backgroundSize = 'cover';
preview.style.backgroundPosition = 'center';
preview.style.background = `url(${currentAvatar}) center/cover no-repeat`;
if (placeholder) placeholder.style.display = 'none';
} else {
preview.style.background = 'var(--accent)';
preview.style.backgroundImage = '';
if (placeholder) placeholder.style.display = '';
}
}

  async function pickAvatar() {
    const dataUrl = await Utils.promptImageInput({ maxSize: 256, quality: 0.85 });
    if (!dataUrl) return;
    _processAvatarDataUrl(dataUrl);
  }

  function onAvatarPicked(input) {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => { _processAvatarDataUrl(e.target.result); };
    reader.readAsDataURL(file);
    input.value = '';
  }

  function _processAvatarDataUrl(dataUrl) {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const size = 128;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const min = Math.min(img.width, img.height);
      const sx = (img.width - min) / 2;
      const sy = (img.height - min) / 2;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
      currentAvatar = canvas.toDataURL('image/jpeg', 0.8);
      updateAvatarPreview();
    };
    img.src = dataUrl;
  }

  function removeAvatar() {
    currentAvatar = null;
    updateAvatarPreview();
  }

  async function save() {
    if (!editingMaskId) return;
    const data = { id: editingMaskId };
    BASIC_FIELDS.forEach(f => {
      const el = document.getElementById(`char-${f}`);
      data[f] = el ? el.value.trim() : '';
    });
    data.abilities = abilitiesData;
    data.inventory = inventoryData;
    data.birthday = _readBirthdayFromForm();
    data.memoryScope = editingMaskId;
    data.avatar = currentAvatar || null;
    await DB.put('characters', data);

    // 同步名字到列表
    const list = await getMaskList();
    const entry = list.find(m => m.id === editingMaskId);
    if (entry) {
      if (data.name) entry.name = data.name;
      // 同步备注
      entry.note = data.note || '';
      // 同步"所属世界观"下拉
      const wvSel = document.getElementById('char-worldview');
      const wvVal = wvSel ? String(wvSel.value || '') : '';
      if (wvVal) entry.worldviewId = wvVal;
      else delete entry.worldviewId;
    }
    await saveMaskList(list);

    // 如果正在编辑的就是当前激活的，更新 activeAvatar 并刷新气泡
    if (editingMaskId === currentMaskId) {
      activeAvatar = data.avatar;
      // 教程模式下不刷新聊天气泡（会清空教程内容）
      // 流式输出中也不刷新，否则会打断正在流式写入的 DOM 节点
      const _streaming = (typeof Chat !== 'undefined' && Chat.isStreamingNow && Chat.isStreamingNow());
      if (!(typeof Tutorial !== 'undefined' && Tutorial.isEnabled()) && !_streaming) {
        try { Chat.renderAll(); } catch(e) {}
      }
    }

    // 保存完成后清除 editingMaskId，防止自动保存 debounce 在 load() 回填表单后写脏数据
    const savedId = editingMaskId;
    editingMaskId = null;

    // 教程模式下保存后回到聊天面板而不是面具列表
    if (typeof Tutorial !== 'undefined' && Tutorial.isEnabled()) {
      UI.showPanel('chat');
    } else {
      UI.showPanel('character');
      await load(); // 刷新卡片列表（load() 会用 currentMaskId 回填表单，此时 editingMaskId 已清空，不会触发 autoSave 写脏）
    }
  }

  async function get() {
    return await DB.get('characters', currentMaskId);
  }

  function getCurrentId() { return currentMaskId; }

  // ===== 多面具管理 =====

  async function createMask() {
    const id = 'mask_' + Utils.uuid().slice(0, 8);
    const list = await getMaskList();
    list.push({ id, name: '新面具' });
    await saveMaskList(list);
    await load();
    openEdit(id);
  }

  async function deleteMask(targetId) {
    if (!targetId) targetId = editingMaskId;
    if (!targetId) return;
    const list = await getMaskList();
    if (list.length <= 1) { UI.showToast('至少保留一个面具', 1800); return; }
    if (!await UI.showConfirm('确认删除', '确定删除此面具？')) return;

    await DB.del('characters', targetId);
    const newList = list.filter(m => m.id !== targetId);
    await saveMaskList(newList);
    
    // 如果删掉的是当前激活的，退回到第一个
    if (targetId === currentMaskId) {
      await switchMask(newList[0].id);
    }
    
    UI.showPanel('character');
    await load();
  }

  async function switchMask(id, updateConv = true) {
    // 生成中禁止用户手动切换面具（自动同步 updateConv=false 的内部调用放过）
    if (updateConv && id !== currentMaskId && typeof Chat !== 'undefined' && Chat.isStreamingNow && Chat.isStreamingNow()) {
      UI.showToast('正在生成回复，请等待完成或先终止再切换', 2000);
      return;
    }
    // 心动模拟开场完成首条正式发送前，禁止底栏切换面具，避免清空开场动画状态
    if (typeof HeartSimIntro !== 'undefined' && HeartSimIntro.isMaskSwitchLocked && HeartSimIntro.isMaskSwitchLocked()) {
      UI.showToast('请先完成开场并发送第一条消息后再切换面具', 2200);
      return;
    }
    // 教程模式下禁止切换面具
    if (typeof Tutorial !== 'undefined' && Tutorial.isEnabled()) {
      UI.showToast('新手引导中，暂时无法切换面具', 1800);
      return;
    }
    currentMaskId = id;
    await DB.put('gameState', { key: 'currentMask', value: id });
    // 刷新头像缓存 (发送消息用 activeAvatar)
    const data = await DB.get('characters', id);
    activeAvatar = data?.avatar || null;

    // 如果需要，更新当前对话的绑定面具
    if (updateConv) {
      try { await Conversations.setMask(id); } catch(e) {}
    }

    // 记忆面板跟着切
    try { 
      // 全局面具变了，记忆库视图同步到新面具（chip 高亮跟着走）
      await Memory.syncViewScopeToCurrent();
      Memory.renderList();
    } catch(e) {}
    // 刷新快速切换栏高亮
    try { Chat.renderQuickSwitches(); } catch(e) {}
    // 刷新聊天气泡头像；心动模拟开场进行中时不要重绘聊天区，否则会清空手写的开场动画气泡
    try {
      if (!(typeof HeartSimIntro !== 'undefined' && HeartSimIntro.isActive && HeartSimIntro.isActive())) {
        Chat.renderAll();
      }
    } catch(e) {}

    // 如果卡片列表正在显示，也要刷新使用中标志
    if (document.getElementById('panel-character')?.classList.contains('active')) {
      await load();
    }
    GameLog.log('info', `切换面具: ${id}`);
  }


  function updateMaskIndicator() {
    // 顶栏显示当前面具
    // 后续可扩展
  }

  // ===== 聊天界面快速切换 =====

  async function renderQuickSwitch() {
    const list = await _getMasksForCurrentWv();
    // 边界：当前面具不在可见列表里（属于其他世界观），把它强行加到开头
    // 让用户能看到自己选的是哪个，同时按钮上加个 ✻ 标记表示"非本世界观"
    let displayList = list;
    if (currentMaskId && !list.some(m => m.id === currentMaskId)) {
      const all = await getMaskList();
      const cur = all.find(m => m.id === currentMaskId);
      if (cur) displayList = [{ ...cur, _foreign: true }, ...list];
    }
    const editSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-left:3px"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>`;
    return displayList.map(m => {
      const isActive = m.id === currentMaskId;
      const foreignMark = m._foreign ? '<span style="opacity:0.6;margin-right:4px" title="非当前世界观面具">✻</span>' : '';
      const noteText = m.note ? `<span style="display:block;font-size:10px;opacity:0.65;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80px">${Utils.escapeHtml(m.note)}</span>` : '';
      let btn = `<button onclick="Character.switchMask('${m.id}')" style="padding:4px 10px;border-radius:6px;border:1px solid ${isActive ? 'var(--accent)' : 'var(--border)'};background:${isActive ? 'var(--accent)' : 'var(--bg-tertiary)'};color:${isActive ? '#111' : 'var(--text-secondary)'};cursor:pointer;font-size:12px;display:inline-flex;align-items:center;flex-direction:column">${foreignMark}<span>${Utils.escapeHtml(m.name)}</span>${noteText}`;
      if (isActive) {
        btn += `<span onclick="event.stopPropagation();Character.openEdit('${m.id}')" style="cursor:pointer;opacity:0.7;margin-left:2px;position:absolute;top:2px;right:2px" title="编辑面具">${editSvg}</span>`;
      }
      btn += `</button>`;
      return btn;
    }).join('');
  }

  // ===== 异能 =====

  let abilitiesData = []; // 缓存异能数据

  function renderAbilities(abilities) {
    abilitiesData = abilities || [];
    const container = document.getElementById('abilities-list');
    if (!container) return;
    container.innerHTML = abilitiesData.map((a, i) => `
      <div class="ability-card" data-index="${i}" style="position:relative;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer">
        <div style="position:absolute;top:8px;right:8px;font-size:11px;background:var(--accent);color:#000;padding:2px 6px;border-radius:4px;flex-shrink:0">${Utils.escapeHtml(a.level || '')}</div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px">
          <div style="font-size:16px;font-weight:bold;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px">${Utils.escapeHtml(a.name || '')}</div>
          <div style="font-size:12px;color:var(--decoration);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(a.type || '')}</div>
        </div>
        <div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:calc(100% - 24px)">${Utils.escapeHtml(a.description || '')}</div>
      </div>
    `).join('');

    // 添加点击编辑
    container.querySelectorAll('.ability-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.index);
        Character.editAbility(idx);
      });
    });
  }

  function addAbility() {
    abilitiesData.push({ name: '', type: '', level: '', description: '' });
    renderAbilities(abilitiesData);
    // 自动打开新异能的编辑弹窗
    Character.editAbility(abilitiesData.length - 1);
  }

  function removeAbility(idx) {
    abilitiesData.splice(idx, 1);
    renderAbilities(abilitiesData);
    saveAbilitiesToData();
  }

  let editingAbilityIdx = null;

  function editAbility(idx) {
  editingAbilityIdx = idx;
  const a = abilitiesData[idx] || { name: '', type: '', level: '', description: '' };
  document.getElementById('ability-edit-name').value = a.name || '';
  document.getElementById('ability-edit-type').value = a.type || '';
  document.getElementById('ability-edit-level').value = a.level || '';
  document.getElementById('ability-edit-desc').value = a.description || '';
  document.getElementById('ability-edit-modal').classList.remove('hidden');
}

async function saveAbility() {
  if (editingAbilityIdx === null) return;
  abilitiesData[editingAbilityIdx] = {
    name: document.getElementById('ability-edit-name').value.trim(),
    type: document.getElementById('ability-edit-type').value.trim(),
    level: document.getElementById('ability-edit-level').value.trim(),
    description: document.getElementById('ability-edit-desc').value.trim()
  };
  renderAbilities(abilitiesData);
  await saveAbilitiesToData();
  closeAbilityEdit();
}

async function deleteAbility() {
    if (editingAbilityIdx === null) return;
    const ok = await UI.showConfirm('删除异能', '确定删除这个异能吗？');
    if (!ok) return;
    Character.removeAbility(editingAbilityIdx);
    closeAbilityEdit();
  }

async function closeAbilityModal() {
  await closeAbilityEdit();
}

  async function saveAbilitiesToData() {
    const maskData = await DB.get('characters', editingMaskId);
    if (maskData) {
      maskData.abilities = abilitiesData;
      await DB.put('characters', maskData);
    }
  }

  async function closeAbilityEdit() {
    const modal = document.getElementById('ability-edit-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
    editingAbilityIdx = null;
  }

  function getEditingAbilityIdx() {
    return editingAbilityIdx;
  }

  // ===== 物品栏 =====

  let inventoryData = []; // 缓存物品数据

  function renderInventory(inventory) {
    inventoryData = inventory || [];
    const container = document.getElementById('inventory-list');
    if (!container) return;
    container.innerHTML = inventoryData.map((item, i) => `
      <div class="inv-card" data-index="${i}" style="position:relative;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer">
        <div style="position:absolute;top:8px;right:8px;font-size:11px;background:var(--accent);color:#000;padding:2px 6px;border-radius:4px;flex-shrink:0">${item.count || 1}</div>
        <div style="font-size:16px;font-weight:bold;color:var(--accent);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px">${Utils.escapeHtml(item.name || '')}</div>
        <div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:calc(100% - 24px)">${Utils.escapeHtml(item.effect || '')}</div>
        ${item.gotAt ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">入手于 ${Utils.escapeHtml(item.gotAt)}</div>` : ''}
      </div>
    `).join('');

    // 添加点击编辑
    container.querySelectorAll('.inv-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.index);
        Character.editItem(idx);
      });
    });
  }

  function addItem() {
    inventoryData.push({ name: '', effect: '', count: 1 });
    renderInventory(inventoryData);
    // 自动打开新物品的编辑弹窗
    Character.editItem(inventoryData.length - 1);
  }

  function removeItem(idx) {
    inventoryData.splice(idx, 1);
    renderInventory(inventoryData);
    saveInventoryToData();
  }

  let editingItemIdx = null;

  function editItem(idx) {
  editingItemIdx = idx;
  const item = inventoryData[idx] || { name: '', effect: '', count: 1, gotAt: '' };
  document.getElementById('item-edit-name').value = item.name || '';
  document.getElementById('item-edit-effect').value = item.effect || '';
  document.getElementById('item-edit-count').value = item.count || 1;
  const gotEl = document.getElementById('item-edit-gotat');
  if (gotEl) gotEl.value = item.gotAt || '';
  document.getElementById('item-edit-modal').classList.remove('hidden');
}

async function saveItem() {
  if (editingItemIdx === null) return;
  const gotEl = document.getElementById('item-edit-gotat');
  inventoryData[editingItemIdx] = {
    name: document.getElementById('item-edit-name').value.trim(),
    effect: document.getElementById('item-edit-effect').value.trim(),
    count: parseInt(document.getElementById('item-edit-count').value) || 1,
    gotAt: gotEl ? gotEl.value.trim() : ''
  };
  renderInventory(inventoryData);
  await saveInventoryToData();
  closeItemEdit();
}

async function deleteItem() {
    if (editingItemIdx === null) return;
    const ok = await UI.showConfirm('删除物品', '确定删除这个物品吗？');
    if (!ok) return;
    Character.removeItem(editingItemIdx);
    closeItemEdit();
  }

  // 把当前编辑的物品移入衣橱/家具仓库（弹目的地 + 数量选择）
  async function moveItemToStorage() {
    if (editingItemIdx === null) return;
    if (typeof Phone === 'undefined' || !Phone.moveInventoryToStorage) {
      UI.showToast('仓库功能不可用', 1800); return;
    }
    const item = inventoryData[editingItemIdx];
    if (!item || !(item.name || '').trim()) { UI.showToast('请先填写物品名称', 1800); return; }
    const have = item.count || 1;

    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,0.5);display:flex;align-items:flex-end;justify-content:center';
    const esc = (s) => Utils.escapeHtml(String(s));
    mask.innerHTML = `
      <div style="background:var(--bg);border-radius:16px 16px 0 0;padding:18px 16px;width:100%;max-width:400px">
        <div style="text-align:center;font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px">移入仓库</div>
        <div style="text-align:center;font-size:12px;color:var(--text-secondary);margin-bottom:14px">${esc(item.name)}（持有 ${have}）</div>
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:6px">移入数量</label>
        <input id="mv-storage-count" type="number" inputmode="numeric" min="1" max="${have}" value="${have}" style="width:100%;box-sizing:border-box;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;padding:10px 12px;outline:none;margin-bottom:14px">
        <div style="display:flex;flex-direction:column;gap:8px">
          <button type="button" data-dest="wardrobe" style="width:100%;text-align:left;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-tertiary);color:var(--text);font-size:14px;cursor:pointer">
            <div style="font-weight:600">衣橱仓库</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">移入后可在着装里穿上</div>
          </button>
          <button type="button" data-dest="furniture" style="width:100%;text-align:left;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-tertiary);color:var(--text);font-size:14px;cursor:pointer">
            <div style="font-weight:600">家具仓库</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">移入后可摆进小屋房间</div>
          </button>
        </div>
        <button type="button" id="mv-storage-cancel" style="width:100%;background:none;border:none;color:var(--text-secondary);font-size:13px;padding:12px 0 2px;cursor:pointer">取消</button>
      </div>`;
    const close = () => { if (mask.parentNode) document.body.removeChild(mask); };
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    mask.querySelector('#mv-storage-cancel').onclick = close;
    mask.querySelectorAll('button[data-dest]').forEach(b => {
      b.onclick = async () => {
        const dest = b.dataset.dest;
        let n = parseInt(mask.querySelector('#mv-storage-count').value, 10) || 1;
        if (n < 1) n = 1;
        if (n > have) n = have;
        close();
        // 先落盘当前编辑内容，确保 DB 里的物品名/描述与界面一致（按名字匹配扣减）
        await saveInventoryToData();
        const r = await Phone.moveInventoryToStorage(editingMaskId, item.name, n, dest);
        UI.showToast(r.msg, 2000);
        if (r.ok) {
          // 同步本地缓存并刷新列表
          if (r.left > 0) inventoryData[editingItemIdx].count = r.left;
          else inventoryData.splice(editingItemIdx, 1);
          renderInventory(inventoryData);
          closeItemEdit();
        }
      };
    });
    document.body.appendChild(mask);
  }

  async function closeItemModal() {
    await closeItemEdit();
  }

  async function saveInventoryToData() {
    const maskData = await DB.get('characters', editingMaskId);
    if (maskData) {
      maskData.inventory = inventoryData;
      await DB.put('characters', maskData);
    }
  }

  async function closeItemEdit() {
    const modal = document.getElementById('item-edit-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
    editingItemIdx = null;
  }

  function getEditingItemIdx() {
    return editingItemIdx;
  }

  // ===== 格式化 =====

  function formatForPrompt(char) {
    if (!char) return '';
    let text = '【用户角色卡】\n';
    if (char.name) text += `姓名: ${char.name}\n`;
    if (char.onlineName) text += `网名: ${char.onlineName}\n`;
    if (char.gender) text += `性别: ${char.gender}\n`;
    if (char.age) text += `年龄: ${char.age}\n`;
    if (char.appearance) text += `外貌: ${char.appearance}\n`;
    if (char.personality) text += `性格: ${char.personality}\n`;
    if (char.background) text += `背景: ${char.background}\n`;
    if (char.birthday && char.birthday.month && char.birthday.day) {
      const b = char.birthday;
      const mLabel = b.monthName ? b.monthName : `${b.month}月`;
      text += `生日: ${mLabel}${b.day}日\n`;
    }
    if (char.other) text += `其他: ${char.other}\n`;
    if (char.abilities?.length > 0) {
      text += '\n【异能/技能】\n';
      char.abilities.forEach(a => {
        text += `- ${a.name}`;
        if (a.type) text += ` [${a.type}]`;
        if (a.level) text += ` Lv.${a.level}`;
        text += '\n';
        if (a.description) text += `  ${a.description}\n`;
      });
    }
    if (char.inventory?.length > 0) {
      text += '\n【物品栏】\n';
      char.inventory.forEach(it => {
        text += `- ${it.name}`;
        if (it.count > 1) text += ` ×${it.count}`;
        if (it.effect) text += ` (${it.effect})`;
        if (it.gotAt) text += ` [入手于${it.gotAt}]`;
        text += '\n';
      });
    }
    return text;
  }

  // ===== 初始化 =====

  async function init() {
    const lastMask = await DB.get('gameState', 'currentMask');
    if (lastMask?.value) currentMaskId = lastMask.value;
    const list = await getMaskList();
    if (!list.find(m => m.id === currentMaskId)) currentMaskId = list[0]?.id || 'default';
    // 一次性清理：默认面具不允许绑世界观，旧数据如果有则擦掉
    const defaultEntry = list.find(m => m.id === 'default');
    if (defaultEntry && defaultEntry.worldviewId) {
      delete defaultEntry.worldviewId;
      await saveMaskList(list);
    }
    // 加载头像缓存
    const data = await DB.get('characters', currentMaskId);
    activeAvatar = data?.avatar || null;
  }

  // ===== 克隆面具 =====
  // 分支命名规则（方案 A 编号制）：
  //   小明 → 小明 · 分支1 → 小明 · 分支2 …
  //   从分支再分支不会叠加"（分支）（分支）"，而是剥掉尾部分支标记拿到根名，
  //   再扫整个面具列表里所有以"根名 · 分支N"命名的项，取最大编号 +1。
  function _stripBranchSuffix(name) {
    if (!name) return '';
    let n = String(name).trim();
    // 去掉新格式尾巴：" · 分支N" 或 " · 分支"
    n = n.replace(/\s*[·•・]\s*分支\d*\s*$/, '');
    // 去掉旧格式尾巴：可能多次出现的"（分支）/(分支)"
    while (/[（(]\s*分支\s*[）)]\s*$/.test(n)) {
      n = n.replace(/[（(]\s*分支\s*[）)]\s*$/, '').trim();
    }
    return n.trim();
  }

  function _nextBranchName(rootName, list) {
    // 在 list 中找所有 "rootName · 分支N" 的最大 N
    const escaped = rootName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + escaped + '\\s*[·•・]\\s*分支(\\d+)\\s*$');
    let max = 0;
    list.forEach(m => {
      const mt = re.exec(m.name || '');
      if (mt) {
        const n = parseInt(mt[1], 10);
        if (n > max) max = n;
      }
    });
    return `${rootName} · 分支${max + 1}`;
  }

  async function cloneMask(newMaskId) {
    const src = await DB.get('characters', currentMaskId);
    if (!src) return;
    const cloned = { ...src, id: newMaskId, memoryScope: newMaskId };
    await DB.put('characters', cloned);
    // 注册到面具列表，让选择器能看到
    const list = await getMaskList();
    const srcEntry = list.find(m => m.id === currentMaskId);
    const srcName = srcEntry?.name || src.name || '面具';
    const rootName = _stripBranchSuffix(srcName) || '面具';
    const cloneName = _nextBranchName(rootName, list);
    // 提取分支编号作为默认备注
    const branchMatch = cloneName.match(/分支(\d+)/);
    const defaultNote = branchMatch ? `分支${branchMatch[1]}` : '';
    list.push({ id: newMaskId, name: cloneName, note: defaultNote });
    await saveMaskList(list);
    // 同步备注到角色数据
    if (defaultNote) { cloned.note = defaultNote; await DB.put('characters', cloned); }
    return cloned;
  }

  async function cloneMaskFrom(srcMaskId, newMaskId) {
    const src = await DB.get('characters', srcMaskId);
    if (!src) return;
    const cloned = { ...src, id: newMaskId, memoryScope: newMaskId };
    await DB.put('characters', cloned);
    const list = await getMaskList();
    const srcEntry = list.find(m => m.id === srcMaskId);
    const cloneName = (srcEntry?.name || src.name || '面具') + '（番外）';
    list.push({ id: newMaskId, name: cloneName });
    await saveMaskList(list);
    return cloned;
  }

  // 为当前对话独立出一份面具（方案C：新窗口面具隔离引导）
  // mode: 'share' 不复制(共享) | 'mask' 仅面具信息 | 'maskInv' 面具+物品栏 | 'full' 面具+物品栏+记忆
  // 返回 { ok, newMaskId? }
  async function isolateMaskForConv(convId, convName, mode) {
    try {
      const srcMaskId = getCurrentId();
      if (!srcMaskId) return { ok: false };
      // 选项1：不复制，仅标记已问过
      if (mode === 'share') return { ok: true, shared: true };

      const src = await DB.get('characters', srcMaskId);
      if (!src) return { ok: false };
      const newMaskId = 'mask_' + Utils.uuid().slice(0, 8);
      // 备注：给玩家看，不发给 AI
      const noteTag = `${(convName || '对话').trim()}副本`;
      const cloned = {
        ...src,
        id: newMaskId,
        memoryScope: newMaskId,
        note: noteTag,
      };
      // 选项2：仅面具信息 → 物品栏清空
      if (mode === 'mask') {
        cloned.inventory = [];
      }
      // 选项3/4：面具信息 + 物品栏（直接保留 src.inventory 的深拷贝）
      if (mode === 'maskInv' || mode === 'full') {
        cloned.inventory = JSON.parse(JSON.stringify(src.inventory || []));
      }
      await DB.put('characters', cloned);

      // 注册到面具列表（名字沿用原名，备注写对话名副本）
      const list = await getMaskList();
      const srcEntry = list.find(m => m.id === srcMaskId);
      const keepName = srcEntry?.name || src.name || '面具';
      list.push({ id: newMaskId, name: keepName, note: noteTag });
      await saveMaskList(list);

      // 选项4：复制记忆库（把原 scope 下所有 memories 复制一份，scope 改为新面具 id）
      if (mode === 'full') {
        try {
          const all = await DB.getAll('memories');
          const mine = all.filter(m => (m.scope || 'default') === srcMaskId);
          for (const m of mine) {
            const copy = { ...m, id: 'mem_' + Utils.uuid().slice(0, 8), scope: newMaskId };
            await DB.put('memories', copy);
          }
        } catch (e) { console.warn('[面具隔离] 复制记忆失败', e); }
      }

      // 把对话绑定到新面具并切换激活
      if (typeof Conversations !== 'undefined' && Conversations.setMask) {
        await Conversations.setMask(newMaskId);
      } else {
        await switchMask(newMaskId);
      }
      try { await renderMaskList(); } catch(_) {}
      return { ok: true, newMaskId };
    } catch (e) {
      console.warn('[面具隔离] 失败', e);
      return { ok: false };
    }
  }

  // 判断当前面具是否「有内容」（有记忆或物品栏非空），用于决定是否弹隔离引导
  async function maskHasContent() {
    try {
      const maskId = getCurrentId();
      if (!maskId) return false;
      const mask = await DB.get('characters', maskId);
      if (Array.isArray(mask?.inventory) && mask.inventory.length > 0) return true;
      const all = await DB.getAll('memories');
      return all.some(m => (m.scope || 'default') === maskId);
    } catch(_) { return false; }
  }

  async function addItemDirect(rawText, gotAtOverride) {
    const maskId = editingMaskId || getCurrentId();
    if (!maskId) { UI.showToast('请先选择面具', 2000); return; }
    let maskData = await DB.get('characters', maskId);
    // 默认面具可能从未被写入DB，自动初始化
    if (!maskData) {
      maskData = { id: maskId, name: '默认面具', abilities: [], inventory: [], background: '' };
      await DB.put('characters', maskData);
    }
    const inv = maskData.inventory || [];
    // 优先使用传入的时间（气泡对应的statusSnapshot.time），兜底从状态栏读
    let gotAt = gotAtOverride || '';
    if (!gotAt) {
      try { gotAt = Conversations.getStatusBar()?.time || ''; } catch(_) {}
    }
    // 可能多行多个物品，逐行解析
    const lines = rawText.split('\n').map(l => l.replace(/^[-•·\d.]\s*/, '').trim()).filter(Boolean);
    let addedNames = [];
    for (const line of lines) {
      // 按中英文冒号拆 "名称：效果"
      const match = line.match(/^(.+?)[：:]\s*(.+)$/);
      const name = match ? match[1].trim() : line.trim();
      const effect = match ? match[2].trim() : '';
      // 过滤掉占位词和标题行
      if (!name || /^(名称|物品名称|新获得物品|物品|效果|无)$/.test(name)) continue;
      const existing = inv.find(it => it.name === name);
      if (existing) {
        existing.count = (existing.count || 1) + 1;
        if (effect && !existing.effect) existing.effect = effect;
        // 已有物品不覆盖原始入手时间
      } else {
        inv.push({ name, effect, count: 1, gotAt });
      }
      addedNames.push(name);
    }
    if (addedNames.length === 0) { UI.showToast('未识别到物品', 2000); return; }
    maskData.inventory = inv;
    await DB.put('characters', maskData);
    if (editingMaskId === maskId) {
      renderInventory(inv);
    }
    UI.showToast(`已收入「${addedNames.join('、')}」`, 2500);
  }

  async function removeItemByName(name) {
    const maskId = editingMaskId || getCurrentId();
    if (!maskId || !name) return false;
    const maskData = await DB.get('characters', maskId);
    if (!maskData) return false;
    const inv = Array.isArray(maskData.inventory) ? maskData.inventory : [];
    const idx = inv.findIndex(it => (it?.name || '').trim() === String(name).trim());
    if (idx < 0) return false;
    inv.splice(idx, 1);
    maskData.inventory = inv;
    await DB.put('characters', maskData);
    if (editingMaskId === maskId) renderInventory(inv);
    return true;
  }

    // ===== v616 排序模式（对齐记忆·世界观·单人卡） =====
  async function toggleSortMode() {
    if (sortMode) { exitSortMode(); return; }
    if (manageMode) exitManageMode();
    sortMode = true;
    const list = await getMaskList();
    sortedList = list.slice().sort((a, b) => {
      const hasA = typeof a.sortOrder === 'number';
      const hasB = typeof b.sortOrder === 'number';
      if (hasA && hasB) return a.sortOrder - b.sortOrder;
      if (hasA) return -1;
      if (hasB) return 1;
      return 0;
    });
    _renderSortList();
  }
  function exitSortMode() {
    sortMode = false;
    sortedList = [];
    const bar = document.getElementById('mask-sort-bar');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    const container = document.getElementById('mask-list-container');
    if (container) container.style.paddingBottom = '';
    renderMaskList(document.getElementById('mask-search')?.value || '');
  }
  function _renderSortList() {
    const container = document.getElementById('mask-list-container');
    if (!container) return;
    container.style.paddingBottom = '72px';
    const bar = document.getElementById('mask-sort-bar');
    if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
    container.innerHTML = sortedList.length === 0 ?
      '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无面具</p>' :
      sortedList.map((m, i) => `
        <div class="sort-item" style="display:flex;align-items:center;gap:8px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:6px;transition:transform 0.15s ease,opacity 0.15s ease" data-sort-idx="${i}" data-id="${m.id}">
          <div class="sort-handle" style="display:flex;align-items:center;justify-content:center;width:24px;flex-shrink:0;cursor:grab;color:var(--text-secondary);font-size:18px;user-select:none;-webkit-user-select:none;touch-action:none">≡</div>
          <div style="flex:1;overflow:hidden">
            <h3 style="margin:0 0 2px 0;font-size:13px;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(m.name || '未命名')}</h3>
          </div>
          <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0">${i + 1}</span>
        </div>`).join('');
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
    const list = await getMaskList();
    const orderMap = new Map();
    sortedList.forEach((m, i) => orderMap.set(m.id, i));
    list.forEach(m => {
      if (orderMap.has(m.id)) m.sortOrder = orderMap.get(m.id);
    });
    list.sort((a, b) => {
      const oa = (typeof a.sortOrder === 'number') ? a.sortOrder : 999999;
      const ob = (typeof b.sortOrder === 'number') ? b.sortOrder : 999999;
      return oa - ob;
    });
    await saveMaskList(list);
    UI.showToast('排序已保存');
    exitSortMode();
  }

  function getAvatar() { return activeAvatar; }
  function searchMasks(query) {
    renderMaskList(query);
  }

  // ===== 生日（按绑定世界观历法约束） =====

  // 取当前编辑面具"正在编辑中"的世界观 id：优先表单 hidden（实时），回退 maskList 快照
  function _getEditingWvId() {
    const hidden = document.getElementById('char-worldview');
    if (hidden && typeof hidden.value === 'string') return hidden.value || '';
    return '';
  }

  // 取当前编辑面具绑定世界观的历法规则（无则默认 12 月）
  async function _getBirthRules() {
    let wvId = _getEditingWvId();
    // hidden 不存在时（理论上不会）回退 maskList
    if (wvId === '' && !document.getElementById('char-worldview')) {
      try {
        const list = await getMaskList();
        const entry = list.find(m => m.id === editingMaskId);
        wvId = entry?.worldviewId || '';
      } catch (_) {}
    }
    let calSys = null;
    if (wvId) {
      try {
        const wv = await DB.get('worldviews', wvId);
        calSys = wv?.gameplay?.calendarSystem || null;
      } catch (_) {}
    }
    return (typeof Calendar !== 'undefined') ? Calendar.getRules(calSys) : { monthsPerYear: 12, daysPerMonth: [31,28,31,30,31,30,31,31,30,31,30,31] };
  }

  // 渲染生日两个下拉（自定义下拉）。birthday: {month, day} | null
  async function _renderBirthdaySelects(birthday) {
    const monthHidden = document.getElementById('char-birth-month');
    const dayHidden = document.getElementById('char-birth-day');
    if (!monthHidden || !dayHidden) return;
    const rules = await _getBirthRules();
    const mpy = rules?.monthsPerYear || 12;
    const curMonth = (birthday && birthday.month && birthday.month <= mpy) ? birthday.month : 0;
    // 月
    monthHidden.value = curMonth ? String(curMonth) : '';
    _setBirthLabel('month', curMonth ? `${curMonth}月` : '月份');
    // 日（依当前月）
    const curDay = (birthday && birthday.day) ? birthday.day : 0;
    _renderBirthDayState(rules, curMonth, curDay);
  }

  // 根据月份刷新"日"的可选范围与当前值
  function _renderBirthDayState(rules, month, curDay) {
    const dayHidden = document.getElementById('char-birth-day');
    if (!dayHidden) return;
    if (!month) {
      dayHidden.value = '';
      _setBirthLabel('day', '日期');
      return;
    }
    const dpm = rules?.daysPerMonth || [];
    const days = dpm.length ? (dpm[(month - 1) % dpm.length] || 30) : 30;
    const valid = (curDay && curDay <= days) ? curDay : 0;
    dayHidden.value = valid ? String(valid) : '';
    _setBirthLabel('day', valid ? `${valid}日` : '日期');
  }

  function _setBirthLabel(which, text) {
    const label = document.getElementById(`char-birth-${which}-label`);
    if (label) label.textContent = text;
  }

  // 幽灵点击防护：选中项后关闭下拉的瞬间，挡掉合成 click 穿透到触发按钮
  let _birthClickLock = 0;

  // 展开/收起生日下拉，并填充选项
  async function _toggleBirthDropdown(which, ev) {
    // 刚选完项的短时间窗内忽略触发，防止幽灵点击重新弹出
    if (Date.now() < _birthClickLock) return;
    const dropdown = document.getElementById(`char-birth-${which}-dropdown`);
    if (!dropdown) return;
    // 关掉另一个
    const other = which === 'month' ? 'day' : 'month';
    const otherDd = document.getElementById(`char-birth-${other}-dropdown`);
    if (otherDd) otherDd.classList.add('hidden');

    if (!dropdown.classList.contains('hidden')) {
      dropdown.classList.add('hidden');
      return;
    }
    const rules = await _getBirthRules();
    let items = '';
    if (which === 'month') {
      const mpy = rules?.monthsPerYear || 12;
      const cur = parseInt(document.getElementById('char-birth-month')?.value, 10) || 0;
      for (let m = 1; m <= mpy; m++) {
        items += `<div class="custom-dropdown-item${m === cur ? ' active' : ''}" onclick="event.stopPropagation();Character._selectBirth('month', ${m}, event)">${m}月</div>`;
      }
    } else {
      const month = parseInt(document.getElementById('char-birth-month')?.value, 10) || 0;
      if (!month) { UI.showToast('请先选月份', 1400); return; }
      const dpm = rules?.daysPerMonth || [];
      const days = dpm.length ? (dpm[(month - 1) % dpm.length] || 30) : 30;
      const cur = parseInt(document.getElementById('char-birth-day')?.value, 10) || 0;
      for (let d = 1; d <= days; d++) {
        items += `<div class="custom-dropdown-item${d === cur ? ' active' : ''}" onclick="event.stopPropagation();Character._selectBirth('day', ${d}, event)">${d}日</div>`;
      }
    }
    dropdown.innerHTML = items;
    dropdown.classList.remove('hidden');
  }

  async function _selectBirth(which, val, ev) {
    if (ev) { try { ev.stopPropagation(); ev.preventDefault(); } catch(_) {} }
    // 上锁 350ms，挡掉这次 tap 的延迟合成 click
    _birthClickLock = Date.now() + 350;
    const dropdown = document.getElementById(`char-birth-${which}-dropdown`);
    if (dropdown) dropdown.classList.add('hidden');
    if (which === 'month') {
      const monthHidden = document.getElementById('char-birth-month');
      if (monthHidden) monthHidden.value = String(val);
      _setBirthLabel('month', `${val}月`);
      // 换月后，校验已选的日是否还合法
      const rules = await _getBirthRules();
      const curDay = parseInt(document.getElementById('char-birth-day')?.value, 10) || 0;
      _renderBirthDayState(rules, val, curDay);
    } else {
      const dayHidden = document.getElementById('char-birth-day');
      if (dayHidden) dayHidden.value = String(val);
      _setBirthLabel('day', `${val}日`);
    }
  }

  function clearBirthday() {
    const monthHidden = document.getElementById('char-birth-month');
    const dayHidden = document.getElementById('char-birth-day');
    if (monthHidden) monthHidden.value = '';
    if (dayHidden) dayHidden.value = '';
    _setBirthLabel('month', '月份');
    _setBirthLabel('day', '日期');
    ['month', 'day'].forEach(w => {
      const dd = document.getElementById(`char-birth-${w}-dropdown`);
      if (dd) dd.classList.add('hidden');
    });
  }

  // 从表单读出生日对象（无效返回 null）
  function _readBirthdayFromForm() {
    const monthSel = document.getElementById('char-birth-month');
    const daySel = document.getElementById('char-birth-day');
    const m = parseInt(monthSel?.value, 10);
    const d = parseInt(daySel?.value, 10);
    if (!isFinite(m) || !isFinite(d) || m <= 0 || d <= 0) return null;
    return { month: m, day: d };
  }

  // ===== AI 生成面具 =====

  // 解析 AI 输出的 JSON（去 markdown 包裹 + 抓第一个对象）
  function _aiParseJSON(text) {
    let cleaned = (text || '').trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
    }
    try { return JSON.parse(cleaned); } catch (_) {}
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s === -1 || e <= s) throw new Error('AI未返回有效JSON');
    return JSON.parse(cleaned.substring(s, e + 1));
  }

  // 直接从 DB 取某个世界观对象，组装资料块（不依赖 phone.js / 全局激活态）
  async function _aiBuildWvBlock(wvId) {
    if (!wvId) return '';
    let wv = null;
    try { wv = await DB.get('worldviews', wvId); } catch (_) {}
    if (!wv) return '';
    const parts = [];
    // 基础设定
    const base = (wv.setting || wv.description || '').trim();
    if (base) parts.push('【世界观基础设定】\n' + base);
    // 地区 + 势力速查
    if (Array.isArray(wv.regions) && wv.regions.length) {
      const regBlocks = wv.regions.map(r => {
        if (!r || !r.name) return '';
        let s = `● ${r.name}`;
        const rd = r.summary || r.detail || r.description || '';
        if (rd) s += `：${rd}`;
        const facs = Array.isArray(r.factions) ? r.factions : [];
        const facStr = facs.map(f => {
          if (!f || !f.name) return '';
          const fd = f.summary || f.detail || f.description || '';
          return `  - 势力·${f.name}${fd ? `：${fd}` : ''}`;
        }).filter(Boolean).join('\n');
        if (facStr) s += '\n' + facStr;
        return s;
      }).filter(Boolean).join('\n');
      if (regBlocks) parts.push('【地区与势力速查】\n' + regBlocks);
    }
    // 节日
    if (Array.isArray(wv.festivals) && wv.festivals.length) {
      const festStr = wv.festivals.filter(f => f && f.enabled !== false)
        .map(f => `${f.name || ''}（${f.date || ''}）：${f.content || ''}`).join('\n');
      if (festStr) parts.push('【节日设定】\n' + festStr);
    }
    // 知识
    const ks = (wv.knowledges || wv.customs || []).filter(c => c && c.enabled !== false);
    if (ks.length) parts.push('【知识设定】\n' + ks.map(c => `${c.name || ''}：${c.content || ''}`).join('\n'));
    // 开场设定
    const startParts = [];
    if (wv.startTime) startParts.push('开场时间：' + wv.startTime);
    if (wv.startPlot) startParts.push('开场剧情：' + wv.startPlot);
    if (wv.startMessage) startParts.push('开场旁白：' + wv.startMessage);
    if (startParts.length) parts.push('【开场设定】\n' + startParts.join('\n'));
    return parts.length ? parts.join('\n\n') : '';
  }

  function openAiGen() {
    if (!editingMaskId) { UI.showToast('请先打开一个面具', 1600); return; }
    const reqEl = document.getElementById('mask-aigen-req');
    const wordsEl = document.getElementById('mask-aigen-words');
    if (reqEl) reqEl.value = '';
    if (wordsEl) wordsEl.value = '';
    // 提示当前面具绑定的世界观
    (async () => {
      const hint = document.getElementById('mask-aigen-wv-hint');
      if (!hint) return;
      try {
        const list = await getMaskList();
        const entry = list.find(m => m.id === editingMaskId);
        const wvId = entry?.worldviewId || '';
        if (!wvId) { hint.textContent = '当前面具未绑定世界观，将生成一个通用角色。'; return; }
        const wv = await DB.get('worldviews', wvId).catch(() => null);
        hint.textContent = wv ? `将参考世界观「${wv.name || '未命名'}」的设定生成角色。` : '绑定的世界观已失效，将生成通用角色。';
      } catch (_) { hint.textContent = ''; }
    })();
    const modal = document.getElementById('mask-aigen-modal');
    if (modal) modal.classList.remove('hidden');
  }

  function closeAiGen() {
    const modal = document.getElementById('mask-aigen-modal');
    if (modal) modal.classList.add('hidden');
  }

  async function runAiGen() {
    if (!editingMaskId) { UI.showToast('请先打开一个面具', 1600); return; }
    const reqEl = document.getElementById('mask-aigen-req');
    const wordsEl = document.getElementById('mask-aigen-words');
    const goBtn = document.getElementById('mask-aigen-go');
    const requirement = (reqEl?.value || '').trim();
    let wordCount = parseInt(wordsEl?.value, 10);
    if (!isFinite(wordCount) || wordCount <= 0) wordCount = 0;

    // 取当前面具绑定的世界观（优先表单实时值，未保存也能跟随）
    const wvId = _getEditingWvId();
    const wvBlock = await _aiBuildWvBlock(wvId);

    if (goBtn) { goBtn.disabled = true; goBtn.textContent = '生成中…'; }
    try {
      const wordLine = wordCount
        ? `设定（background）正文控制在 ${wordCount} 字左右。`
        : '设定（background）正文长度适中（约 200-400 字）。';
      const sysPrompt = [
        '你是一个角色设定生成器。根据用户要求，生成一个可直接用于角色扮演的"用户面具"（玩家扮演的角色）。',
        wvBlock ? '请让角色贴合下面的世界观设定，姓名、身份、技能、物品都要符合这个世界观的风格与设定，不要出现与世界观冲突的现代/现实专有名词。\n\n' + wvBlock : '世界观未绑定，生成一个设定自洽的通用角色即可。',
        '',
        '## 输出要求',
        '严格只输出一个 JSON 对象，不要任何解释或 markdown 代码块包裹。结构如下：',
        '{',
        '  "name": "角色本名",',
        '  "onlineName": "网名/社交媒体显示名，可与本名相同",',
        '  "background": "角色设定正文。用分行的方式依次写：性别、年龄、身份、外貌（发色发型长度/瞳色/身高/气质/特征）、背景故事。把这些都写进这一段文本里。",',
        `  "birthday": { "month": 整数(1-${(await _getBirthRules()).monthsPerYear || 12}), "day": 整数(该月的合法日期，没有合适就省略整个birthday字段) },`,
        '  "abilities": [ { "name": "技能名", "type": "类型(如元素/精神/辅助/战斗)", "level": "等级(如S级/A级，没有体系就留空)", "description": "效果描述" } ],',
        '  "inventory": [ { "name": "物品名", "effect": "作用/说明", "count": 1 } ]',
        '}',
        wordLine,
        'abilities 0-4 个，inventory 0-6 个，按角色合理性来，没有就给空数组。'
      ].join('\n');

      const userMsg = requirement
        ? '用户要求：' + requirement
        : '用户没有特别要求，请自由设计一个有记忆点的角色。';

      const raw = await API.generate(sysPrompt, userMsg, {});
      const obj = _aiParseJSON(raw);

      // 回填到当前编辑表单
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
      if (obj.name) setVal('char-name', String(obj.name).trim());
      if (obj.onlineName) setVal('char-onlineName', String(obj.onlineName).trim());
      if (obj.background) {
        setVal('char-background', String(obj.background).trim());
        // 触发设定框自适应高度（与 openEdit 同口径：超高时开滚动）
        const ta = document.getElementById('char-background');
        if (ta) {
          ta.style.height = 'auto';
          ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
          ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
        }
      }
      // 技能
      const abis = Array.isArray(obj.abilities) ? obj.abilities.map(a => ({
        name: String(a?.name || '').trim(),
        type: String(a?.type || '').trim(),
        level: String(a?.level || '').trim(),
        description: String(a?.description || '').trim()
      })).filter(a => a.name) : [];
      renderAbilities(abis);
      // 物品
      const invs = Array.isArray(obj.inventory) ? obj.inventory.map(it => ({
        name: String(it?.name || '').trim(),
        effect: String(it?.effect || '').trim(),
        count: (() => { const n = parseInt(it?.count, 10); return isFinite(n) && n > 0 ? n : 1; })()
      })).filter(it => it.name) : [];
      renderInventory(invs);

      // 生日（按当前历法校验）
      if (obj.birthday && typeof obj.birthday === 'object') {
        const bm = parseInt(obj.birthday.month, 10);
        const bd = parseInt(obj.birthday.day, 10);
        const bday = (isFinite(bm) && isFinite(bd) && bm > 0 && bd > 0) ? { month: bm, day: bd } : null;
        await _renderBirthdaySelects(bday);
      }

      closeAiGen();
      UI.showToast('已生成，记得检查后保存', 2200);
    } catch (e) {
      UI.showToast('生成失败：' + (e?.message || e), 3000);
    } finally {
      if (goBtn) { goBtn.disabled = false; goBtn.textContent = '生成'; }
    }
  }


return {
    init, load, save, get, getCurrentId, formatForPrompt, getAvatar,
    createMask, deleteMask, switchMask, renderQuickSwitch, openEdit,
    _toggleWvDropdown, _selectWv,
  addAbility, removeAbility, editAbility, saveAbility, deleteAbility, closeAbilityEdit, closeAbilityModal,
  addItem, removeItem, editItem, saveItem, deleteItem, closeItemEdit, closeItemModal, moveItemToStorage, addItemDirect, removeItemByName, cloneMask, cloneMaskFrom, isolateMaskForConv, maskHasContent,
  onAvatarPicked, pickAvatar, removeAvatar, searchMasks,
    openAiGen, closeAiGen, runAiGen,
    clearBirthday, _toggleBirthDropdown, _selectBirth,
  toggleManageMode, toggleSelectAll, batchClone, batchDelete, _onCardClick, exitManageMode,
  // v616
  toggleMenu, exportSelected, importMask,
  toggleSortMode, exitSortMode, saveSortOrder
};
})();