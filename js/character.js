/**
 * 面具（角色卡）管理 — 多面具支持
 */
const Character = (() => {
  const BASIC_FIELDS = ['name', 'background'];
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

  async function renderMaskList(filter = '') {
    const list = await getMaskList();
    const query = filter.trim().toLowerCase();
    const container = document.getElementById('mask-list-container');
    if (!container) return;

    // 分组：通用 + 各世界观（wvId 失效的归通用）
    const allWvs = (await DB.getAll('worldviews').catch(() => [])) || [];
    const wvById = {};
    allWvs.forEach(w => { if (w && w.id) wvById[w.id] = w; });

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
      const background = data?.background || '';
      const preview = background ? (background.length > 80 ? background.slice(0, 80) + '...' : background) : '暂无设定';
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
    const btn = document.getElementById('mask-manage-btn');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    const container = document.getElementById('mask-list-container');
    if (container) container.style.paddingBottom = '';
    if (btn) {
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理`;
      btn.style.background = 'none';
      btn.style.color = 'var(--text-secondary)';
      btn.style.borderColor = 'var(--border)';
    }
  }

  function toggleManageMode() {
    manageMode = !manageMode;
    selectedIds.clear();
    const bar = document.getElementById('mask-manage-bar');
    const btn = document.getElementById('mask-manage-btn');
    const container = document.getElementById('mask-list-container');
    if (manageMode) {
      bar.classList.remove('hidden');
      bar.style.display = 'flex';
      if (container) container.style.paddingBottom = '72px';
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg> 退出`;
      btn.style.background = 'var(--accent)';
      btn.style.color = '#111';
      btn.style.borderColor = 'var(--accent)';
    } else {
      bar.classList.add('hidden');
      bar.style.display = '';
      if (container) container.style.paddingBottom = '';
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理`;
      btn.style.background = 'none';
      btn.style.color = 'var(--text-secondary)';
      btn.style.borderColor = 'var(--border)';
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
    await load();
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

  function onAvatarPicked(input) {
    const file = input.files?.[0];
    if (!file) return;
    // 压缩到 128x128 以节省存储
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const size = 128;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // 居中裁切正方形
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        currentAvatar = canvas.toDataURL('image/jpeg', 0.8);
        updateAvatarPreview();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    input.value = '';
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
    data.memoryScope = editingMaskId;
    data.avatar = currentAvatar || null;
    await DB.put('characters', data);

    // 同步名字到列表
    const list = await getMaskList();
    const entry = list.find(m => m.id === editingMaskId);
    if (entry) {
      if (data.name) entry.name = data.name;
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
    if (list.length <= 1) { alert('至少保留一个面具'); return; }
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
      let btn = `<button onclick="Character.switchMask('${m.id}')" style="padding:4px 10px;border-radius:6px;border:1px solid ${isActive ? 'var(--accent)' : 'var(--border)'};background:${isActive ? 'var(--accent)' : 'var(--bg-tertiary)'};color:${isActive ? '#111' : 'var(--text-secondary)'};cursor:pointer;font-size:12px;display:inline-flex;align-items:center">${foreignMark}${Utils.escapeHtml(m.name)}`;
      if (isActive) {
        btn += `<span onclick="event.stopPropagation();Character.openEdit('${m.id}')" style="cursor:pointer;opacity:0.7;margin-left:2px" title="编辑面具">${editSvg}</span>`;
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
  Character.removeItem(editingItemIdx);
  closeItemEdit();
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
    if (char.gender) text += `性别: ${char.gender}\n`;
    if (char.age) text += `年龄: ${char.age}\n`;
    if (char.appearance) text += `外貌: ${char.appearance}\n`;
    if (char.personality) text += `性格: ${char.personality}\n`;
    if (char.background) text += `背景: ${char.background}\n`;
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
    list.push({ id: newMaskId, name: cloneName });
    await saveMaskList(list);
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

  async function addItemDirect(rawText) {
    const maskId = editingMaskId || getCurrentId();
    if (!maskId) { UI.showToast('请先选择面具', 2000); return; }
    let maskData = await DB.get('characters', maskId);
    // 默认面具可能从未被写入DB，自动初始化
    if (!maskData) {
      maskData = { id: maskId, name: '默认面具', abilities: [], inventory: [], background: '' };
      await DB.put('characters', maskData);
    }
    const inv = maskData.inventory || [];
    // 从最近 assistant 消息提取游戏时间
    let gotAt = '';
    try {
      const msgs = (typeof Chat !== 'undefined' && Chat.getMessages) ? Chat.getMessages() : [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== 'assistant') continue;
        const tm = (msgs[i].content || '').match(/\d{4}年\d{1,2}月\d{1,2}日(?:\s*\d{1,2}[:：]\d{1,2})?/);
        if (tm) { gotAt = tm[0]; break; }
      }
    } catch(e) {}
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

  function getAvatar() { return activeAvatar; }

  function searchMasks(query) {
    renderMaskList(query);
  }

return {
    init, load, save, get, getCurrentId, formatForPrompt, getAvatar,
    createMask, deleteMask, switchMask, renderQuickSwitch, openEdit,
    _toggleWvDropdown, _selectWv,
  addAbility, removeAbility, editAbility, saveAbility, deleteAbility, closeAbilityEdit, closeAbilityModal,
  addItem, removeItem, editItem, saveItem, deleteItem, closeItemEdit, closeItemModal, addItemDirect, removeItemByName, cloneMask, cloneMaskFrom,
  onAvatarPicked, removeAvatar, searchMasks,
  toggleManageMode, toggleSelectAll, batchClone, batchDelete, _onCardClick, exitManageMode
};
})();