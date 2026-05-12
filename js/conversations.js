/**
 * 多对话管理 — 文件夹 + 置顶 + 拖动排序
 */
const Conversations = (() => {
let currentId = 'default';
let list = [];       // { id, name, created, maskId?, branchMaskId?, folder?, pinned?, worldviewId? }
let folders = [];    // { id, name, collapsed?, worldviewId? }
  let longPressTimer = null;
  const _avatarCache = {};  // { convId: avatarUrl } 单人对话头像缓存
  let _charFilter = '__all__'; // 无世界观下的角色筛选 key

  // 异步刷新单人对话头像缓存，并把 dom 里 placeholder 的 img 填充
  async function _refreshSingleAvatars() {
    for (const c of list) {
      if (!c.isSingle) continue;
      if (_avatarCache[c.id] !== undefined) continue; // 已缓存（含空字符串）
      let url = '';
      try {
        if (c.singleCharType === 'card' && c.singleCharId) {
          const card = await DB.get('singleCards', c.singleCharId);
          url = card?.avatar || '';
        } else if (c.singleCharType === 'npc' && c.singleCharId) {
          // 优先查 npcAvatars 库
          try {
            const r = await DB.get('npcAvatars', c.singleCharId);
            if (r && r.avatar) url = r.avatar;
          } catch(e) {}
          if (!url) {
            const wvId = c.singleCharSourceWvId || c.singleWorldviewId;
            if (wvId) {
              const wv = await DB.get('worldviews', wvId);
              if (wv) {
                outer: for (const r of (wv.regions || [])) {
                  for (const f of (r.factions || [])) {
                    for (const n of (f.npcs || [])) {
                      if (n.id === c.singleCharId) { url = n.avatar || ''; break outer; }
                    }
                  }
                }
              }
            }
          }
        }
      } catch(e) {}
      _avatarCache[c.id] = url;
      // 更新当前 dom
      const imgEl = document.querySelector(`img[data-conv-avatar-id="${c.id}"]`);
      if (imgEl && url) {
        imgEl.src = url;
        imgEl.style.display = 'inline-block';
      }
    }
  }

  // 单人对话设置变更后清缓存
  function _invalidateAvatarCache(convId) {
    if (convId) delete _avatarCache[convId];
    else for (const k in _avatarCache) delete _avatarCache[k];
  }
let dragState = null;

// ===== 初始化 =====

async function init() {
    const data = await DB.get('gameState', 'conversations');
    list = (data?.value && data.value.length > 0) ? data.value : [{ id: 'default', name: '对话 1', created: Date.now() }];

    // 兼容：为没有 maskId 的对话添加默认值
    for (const conv of list) {
      if (!conv.maskId) conv.maskId = 'default';
    }

    // 兼容：为没有 presetId 的对话绑定当前全局预设
    {
      const curPreset = Settings.getCurrentId();
      for (const conv of list) {
        if (!conv.presetId) conv.presetId = curPreset;
      }
    }

    // 迁移：确保默认世界观存在，旧对话归入默认世界观
    await _ensureDefaultWorldview();
    let migrated = false;
    for (const conv of list) {
      if (!conv.worldviewId) {
        conv.worldviewId = '__default_wv__';
        migrated = true;
      }
    }

    const folderData = await DB.get('gameState', 'convFolders');
    folders = folderData?.value || [];
    // 每次进入页面，文件夹默认展开
    folders.forEach(f => f.collapsed = false);
    // 迁移：旧文件夹归入默认世界观
    for (const f of folders) {
      if (!f.worldviewId) {
        f.worldviewId = '__default_wv__';
        migrated = true;
      }
    }

    const lastUsed = await DB.get('gameState', 'lastConversation');
    currentId = lastUsed?.value || null;

    if (migrated) await saveList();

    // 按当前激活世界观校验 currentId
    const activeWv = _activeWorldviewId();
    const curConv = currentId ? list.find(c => c.id === currentId) : null;
    if (!curConv || (curConv.worldviewId || '__default_wv__') !== activeWv) {
      // 优先恢复上次在该世界观下操作的对话
      let targetConv = null;
      try {
        const lastRecord = await DB.get('gameState', `lastWvConv_${activeWv}`);
        if (lastRecord?.value) {
          targetConv = list.find(c => c.id === lastRecord.value && (c.worldviewId || '__default_wv__') === activeWv);
        }
      } catch(_) {}
      if (!targetConv) {
        targetConv = list.find(c => (c.worldviewId || '__default_wv__') === activeWv);
      }
      currentId = targetConv ? targetConv.id : null;
    }

    await saveList();
    renderList();

    await _updateTopbar();
  }

  // ===== 顶栏更新（标题 + 头像）=====
  async function _updateTopbar() {
    try { if (typeof StatusBar !== 'undefined' && StatusBar.refreshFromConv) StatusBar.refreshFromConv(); } catch(e) {}
    const titleEl = document.getElementById('topbar-title');
    const avatarEl = document.getElementById('topbar-avatar');
    if (titleEl) titleEl.textContent = getCurrentName();
    if (!avatarEl) return;

    let avatarUrl = '';
    try {
      const conv = list.find(c => c.id === currentId);
      if (conv && conv.isSingle && conv.singleCharType && conv.singleCharId) {
        if (conv.singleCharType === 'card') {
          const card = await DB.get('singleCards', conv.singleCharId);
          avatarUrl = card?.avatar || '';
        } else if (conv.singleCharType === 'npc') {
          try {
            const r = await DB.get('npcAvatars', conv.singleCharId);
            if (r && r.avatar) avatarUrl = r.avatar;
          } catch(e) {}
          if (!avatarUrl) {
            const wvId = conv.singleCharSourceWvId || conv.singleWorldviewId;
            if (wvId) {
              const wv = await DB.get('worldviews', wvId);
              if (wv) {
                outer: for (const r of (wv.regions || [])) {
                  for (const f of (r.factions || [])) {
                    for (const n of (f.npcs || [])) {
                      if (n.id === conv.singleCharId) { avatarUrl = n.avatar || ''; break outer; }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch(e) {}

    if (avatarUrl) {
      avatarEl.src = avatarUrl;
      avatarEl.style.display = 'inline-block';
    } else {
      avatarEl.style.display = 'none';
      avatarEl.src = '';
    }
  }

  // ===== 数据持久化 =====

  // 确保默认世界观存在
  async function _ensureDefaultWorldview() {
    const wvListData = await DB.get('gameState', 'worldviewList');
    const wvList = wvListData?.value || [];
    let needSave = false;
    let entry = wvList.find(w => w.id === '__default_wv__');
    if (!entry) {
      entry = { id: '__default_wv__', name: '无世界观', description: '未挂世界观的对话', icon: '∅', iconImage: '' };
      wvList.unshift(entry);
      needSave = true;
    } else if (entry.name === '默认世界观') {
      // 旧数据迁移：默认世界观 → 无世界观
      entry.name = '无世界观';
      entry.description = '未挂世界观的对话';
      entry.icon = '∅';
      needSave = true;
    }
    if (needSave) await DB.put('gameState', { key: 'worldviewList', value: wvList });
    // 确保 worldviews store 也有这个条目
    const existing = await DB.get('worldviews', '__default_wv__');
    if (!existing) {
      await DB.put('worldviews', {
        id: '__default_wv__', name: '无世界观', description: '未挂世界观的对话',
        icon: '∅', iconImage: '',
        regions: [], factions: [], npcs: [], festivals: [], knowledges: []
      });
    } else if (existing.name === '默认世界观') {
      existing.name = '无世界观';
      existing.description = '未挂世界观的对话';
      existing.icon = '∅';
      await DB.put('worldviews', existing);
    }
  }

  // 获取当前活动世界观ID
  function _activeWorldviewId() {
    return Worldview.getCurrentId() || '__default_wv__';
  }

  async function saveList() {
    await DB.put('gameState', { key: 'conversations', value: list });
    await DB.put('gameState', { key: 'lastConversation', value: currentId });
    await DB.put('gameState', { key: 'convFolders', value: folders });
  }

  // ===== 对话 CRUD =====

  let simpleInputCallback = null;

  async function create(folderId) {
    const name = await UI.showSimpleInput('新建世界线', '新的世界线');
    if (!name) return;
    const conv = {
      id: 'conv_' + Utils.uuid().slice(0, 8),
      name: name.trim(),
      created: Date.now(),
      folder: folderId || null,
      worldviewId: _activeWorldviewId(),
      presetId: Settings.getCurrentId()
    };
    list.push(conv);
    await saveList();
    await switchTo(conv.id);
  }

  async function addBranch(convId, name, maskId, options) {
    const srcConv = list.find(c => c.id === currentId);
    const conv = { id: convId, name, created: Date.now(), branchMaskId: maskId, folder: srcConv?.folder || null, worldviewId: srcConv?.worldviewId || _activeWorldviewId(), presetId: srcConv?.presetId || Settings.getCurrentId() };
    if (options?.isGaiden) {
      conv.isGaiden = true;
      if (options.gaidenBg !== undefined) conv.gaidenBg = options.gaidenBg;
      if (options.inheritWv !== undefined) conv.inheritWv = options.inheritWv;
      if (options.inheritNpc !== undefined) conv.inheritNpc = options.inheritNpc;
      if (options.sourceGaidenId) conv.sourceGaidenId = options.sourceGaidenId;
    }
    // 单人模式字段继承（复制源对话的单人设定）
    if (srcConv?.isSingle && !options?.isGaiden) {
      conv.isSingle = true;
      conv.singleWorldviewId = srcConv.singleWorldviewId || '';
      conv.singleCharType = srcConv.singleCharType || 'card';
      conv.singleCharId = srcConv.singleCharId || '';
      conv.singleEnableDetail = !!srcConv.singleEnableDetail;
      conv.singleEnableNpc = !!srcConv.singleEnableNpc;
      conv.singleEnableStartPlot = !!srcConv.singleEnableStartPlot;
      conv.singleEnableFestival = !!srcConv.singleEnableFestival;
      conv.singleEnableCustom = !!srcConv.singleEnableCustom;
    }
    // 普通分支（非番外）继承状态栏和手机数据，让分支真正是"完整副本"。
    // 番外是独立剧情线，不继承这些运行时状态，避免污染番外开头。
    if (!options?.isGaiden) {
      if (srcConv?.statusBar) {
        try { conv.statusBar = JSON.parse(JSON.stringify(srcConv.statusBar)); } catch(e) {}
      }
      if (srcConv?.phoneData) {
        try { conv.phoneData = JSON.parse(JSON.stringify(srcConv.phoneData)); } catch(e) {}
      }
    }
    list.push(conv);
    await saveList();
    await Character.switchMask(maskId);
    await switchTo(convId);
  }

  async function switchTo(id) {
    // 生成中禁止切换对话（避免状态栏/NPC/总结写错位置）
    if (typeof Chat !== 'undefined' && Chat.isStreamingNow && Chat.isStreamingNow() && id !== currentId) {
      UI.showToast('正在生成回复，请等待完成或先终止再切换', 2000);
      return;
    }
    // 教程模式下禁止切换对话
    if (typeof Tutorial !== 'undefined' && Tutorial.isEnabled()) {
      UI.showToast('新手引导中，暂时无法切换对话', 1800);
      const sidebar = document.getElementById('sidebar');
      if (sidebar && !sidebar.classList.contains('hidden')) UI.toggleSidebar();
      return;
    }
    // 即使是当前对话也要切回聊天面板
    if (id === currentId) {
      UI.showPanel('chat');
      // 从侧边栏点击对话时，关闭侧边栏
      const sidebar = document.getElementById('sidebar');
      if (sidebar && !sidebar.classList.contains('hidden')) {
        UI.toggleSidebar();
      }
      return;
    }
    currentId = id;
    await saveList();

    // 记录该世界观下最后操作的对话，切换世界观时优先恢复
    try {
      const conv = list.find(c => c.id === id);
      const wvId = conv?.worldviewId || '__default_wv__';
      await DB.put('gameState', { key: `lastWvConv_${wvId}`, value: id });
    } catch(_) {}

    await _updateTopbar();

    // 切换到该对话绑定的面具
    const conv = list.find(c => c.id === id);

    // 如果对话绑定的世界观不同于当前激活世界观，自动切
    try {
      const targetWvId = conv?.worldviewId || '__default_wv__';
      const currentWvId = (typeof Worldview !== 'undefined' && Worldview.getCurrentId) ? Worldview.getCurrentId() : null;
      if (targetWvId && currentWvId && targetWvId !== currentWvId) {
        await Worldview.selectWorldview(targetWvId);
      }
    } catch(e) { console.warn('[Conversations] 自动切世界观失败', e); }

    if (conv?.maskId) {
      await Character.switchMask(conv.maskId, false); // false 表示不更新对话的 maskId
    } else if (conv?.branchMaskId) {
      // 兼容旧的 branchMaskId
      await Character.switchMask(conv.branchMaskId, false);
    }

    // 切换到该对话绑定的 API 预设
    if (conv?.presetId) {
      try { Settings.switchPreset(conv.presetId, false); } catch(e) {}
    }

    // 先关侧边栏 + 切到聊天面板，让用户立刻看到响应，不要等 loadHistory 完成
    UI.showPanel('chat');
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('hidden')) {
      UI.toggleSidebar();
    }

    await Chat.loadHistory(currentId);
    try { Summary.setConvId(currentId); } catch(e) {}
    try { Gaiden.updateMenuVisibility(); } catch(e) {}
    try { if (typeof SingleMode !== 'undefined' && SingleMode.updateMenuVisibility) SingleMode.updateMenuVisibility(); } catch(e) {}
    try { if (typeof Backstage !== 'undefined') Backstage.updateFab(); } catch(e) {}
    renderList();
  }

  // 设置当前对话的绑定面具
  async function setMask(maskId) {
    const conv = list.find(c => c.id === currentId);
    if (conv) {
      conv.maskId = maskId;
      await saveList();
      await Character.switchMask(maskId, false);
    }
  }

  // 设置当前对话绑定的 API 预设
  async function setPreset(presetId) {
    const conv = list.find(c => c.id === currentId);
    if (conv) {
      conv.presetId = presetId;
      await saveList();
    }
  }

  async function rename(id) {
    const conv = list.find(c => c.id === id);
    if (!conv) return;
    const name = await UI.showSimpleInput('重命名对话', conv.name);
    if (!name) return;
    conv.name = name.trim();
    await saveList();
    renderList();
    if (id === currentId) {
      await _updateTopbar();
    }
  }

  async function remove(id) {
    if (list.length <= 1) { alert('至少保留一个对话'); return; }
    const conv = list.find(c => c.id === id);
    if (!await UI.showConfirm('确认删除', `确定删除「${conv?.name || id}」？`)) return;

    try { await DB.deleteByIndex('messages', 'conversationId', id); } catch(e) { console.warn('[Conv] 删除消息失败', e); }
    try { await DB.del('summaries', id); } catch(e) {}
    const allArchives = await DB.getAll('archives');
    for (const arch of allArchives) { if (arch.conversationId === id) await DB.del('archives', arch.id); }

    if (conv?.branchMaskId) {
      try { await DB.del('characters', conv.branchMaskId); } catch(e) {}
      const maskData = await DB.get('gameState', 'maskList');
      const masks = maskData?.value || [];
      await DB.put('gameState', { key: 'maskList', value: masks.filter(m => m.id !== conv.branchMaskId) });
      const allMems = await DB.getAll('memories');
      for (const mem of allMems) { if (mem.scope === conv.branchMaskId) await DB.del('memories', mem.id); }
    }

    list = list.filter(c => c.id !== id);
    if (currentId === id) {
      // 优先在同一世界观下找下一个对话；找不到就进空态（currentId = null）
      const wv = conv?.worldviewId || '__default_wv__';
      const same = list.find(c => (c.worldviewId || '__default_wv__') === wv);
      currentId = same ? same.id : null;
    }
    await saveList();
    await Chat.loadHistory(currentId);
    renderList();
    await _updateTopbar();
  }
function getCurrent() { return currentId; }

  // 进入"无对话"空态：清掉 currentId，让 chat 面板显示"请先选择对话"
  async function enterEmptyState() {
    currentId = null;
    await Chat.loadHistory(null);
    await _updateTopbar();
    renderList();
  }


  // 读取/更新当前对话的状态栏数据
  function getStatusBar(convId) {
    const id = convId || currentId;
    if (!id) return null;
    const conv = list.find(c => c.id === id);
    return conv?.statusBar || null;
  }
  async function setStatusBar(status, convId) {
    const id = convId || currentId;
    if (!id) return;
    const conv = list.find(c => c.id === id);
    if (!conv) return;
    conv.statusBar = status || null;
    await saveList();
  }

  function getCurrentName() {
    if (!currentId) return '未选择对话';
    const conv = list.find(c => c.id === currentId);
    return conv?.name || '对话';
  }

  // ===== 置顶 =====

  async function togglePin(id) {
    const conv = list.find(c => c.id === id);
    if (!conv) return;
    
    // 获取当前元素位置用于动画
    const itemEl = document.querySelector(`.conv-item[data-conv-id="${id}"]`);
    if (itemEl) {
      itemEl.classList.add('reorder-animate');
    }
    
    // 短暂延迟让过渡效果生效
    await new Promise(r => setTimeout(r, 50));
    
    conv.pinned = !conv.pinned;
    await saveList();
    renderList();
  }

  // ===== 移动到文件夹 =====
  
  async function moveToFolder(convId, folderId) {
    const conv = list.find(c => c.id === convId);
    if (!conv) return;
    conv.folder = folderId || null;
    await saveList();
    renderList();
  }

  async function _animateMove(itemEl, direction) {
    if (!itemEl) return;
    itemEl.classList.add('reorder-animate');
    itemEl.classList.add(direction === 'up' ? 'drag-shift-up' : 'drag-shift-down');
    await new Promise(r => setTimeout(r, 180));
    itemEl.classList.remove('drag-shift-up', 'drag-shift-down');
    await new Promise(r => setTimeout(r, 40));
  }

  // 构造当前世界观下和 renderList 一致的混排数组
  function _buildSortedRootItems() {
    const activeWv = _activeWorldviewId();
    const filteredList = list.filter(c => (c.worldviewId || '__default_wv__') === activeWv);
    const filteredFolders = folders.filter(f => (f.worldviewId || '__default_wv__') === activeWv);
    const filteredFolderIds = new Set(filteredFolders.map(f => f.id));
    const rootConvs = filteredList.filter(c => !c.folder || !filteredFolderIds.has(c.folder));

    const items = [];
    rootConvs.forEach(c => items.push({ type: 'conv', id: c.id, pinned: !!c.pinned, order: c.displayOrder ?? 9999 }));
    filteredFolders.forEach(f => items.push({ type: 'folder', id: f.id, pinned: !!f.pinned, order: f.displayOrder ?? 9999 }));

    return [
      ...items.filter(i => i.pinned).sort((a, b) => a.order - b.order),
      ...items.filter(i => !i.pinned).sort((a, b) => a.order - b.order)
    ];
  }

  // 把 sorted 数组里的新位置写回 displayOrder
  function _applyDisplayOrder(sorted) {
    sorted.forEach((item, i) => {
      if (item.type === 'conv') {
        const c = list.find(x => x.id === item.id);
        if (c) c.displayOrder = i;
      } else {
        const f = folders.find(x => x.id === item.id);
        if (f) f.displayOrder = i;
      }
    });
  }

  async function moveConvStep(id, direction) {
    const conv = list.find(c => c.id === id);
    if (!conv) return;

    // 如果对话在文件夹内，走文件夹内排序逻辑
    if (conv.folder) {
      return moveConvInFolderStep(id, direction);
    }

    const sorted = _buildSortedRootItems();
    const idx = sorted.findIndex(i => i.type === 'conv' && i.id === id);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= sorted.length) return;

    // 动画
    const itemEl = document.querySelector(`.conv-item[data-conv-id="${id}"]`);
    const other = sorted[targetIdx];
    const otherEl = other.type === 'conv'
      ? document.querySelector(`.conv-item[data-conv-id="${other.id}"]`)
      : document.querySelector(`.conv-folder[data-folder="${other.id}"]`);
    if (itemEl) itemEl.classList.add('reorder-animate');
    if (otherEl) otherEl.classList.add('reorder-animate');
    if (itemEl) itemEl.classList.add(direction === 'up' ? 'drag-shift-up' : 'drag-shift-down');
    if (otherEl) otherEl.classList.add(direction === 'up' ? 'drag-shift-down' : 'drag-shift-up');
    await new Promise(r => setTimeout(r, 180));
    if (itemEl) itemEl.classList.remove('drag-shift-up', 'drag-shift-down');
    if (otherEl) otherEl.classList.remove('drag-shift-up', 'drag-shift-down');

    [sorted[idx], sorted[targetIdx]] = [sorted[targetIdx], sorted[idx]];
    _applyDisplayOrder(sorted);

    await saveList();
    renderList();
  }

  async function moveConvInFolderStep(id, direction) {
    const conv = list.find(c => c.id === id);
    if (!conv || !conv.folder) return;
    
    const folderConvs = list.filter(c => c.folder === conv.folder);
    const pinned = folderConvs.filter(c => !!c.pinned);
    const normal = folderConvs.filter(c => !c.pinned);
    const ordered = [...pinned, ...normal];
    
    const idx = ordered.findIndex(c => c.id === id);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= ordered.length) return;
    
    const itemEl = document.querySelector(`.conv-item[data-conv-id="${id}"]`);
    const otherEl = document.querySelector(`.conv-item[data-conv-id="${ordered[targetIdx].id}"]`);
    if (itemEl) itemEl.classList.add('reorder-animate');
    if (otherEl) otherEl.classList.add('reorder-animate');
    if (itemEl) itemEl.classList.add(direction === 'up' ? 'drag-shift-up' : 'drag-shift-down');
    if (otherEl) otherEl.classList.add(direction === 'up' ? 'drag-shift-down' : 'drag-shift-up');
    await new Promise(r => setTimeout(r, 180));
    if (itemEl) itemEl.classList.remove('drag-shift-up', 'drag-shift-down');
    if (otherEl) otherEl.classList.remove('drag-shift-up', 'drag-shift-down');
    
    [ordered[idx], ordered[targetIdx]] = [ordered[targetIdx], ordered[idx]];
    const orderedIds = ordered.map(c => c.id);
    const orderedSet = new Set(orderedIds);
    const orderedConvs = list.filter(c => orderedSet.has(c.id));
    const otherConvs = list.filter(c => !orderedSet.has(c.id));
    list = [...orderedIds.map(cid => orderedConvs.find(c => c.id === cid)).filter(Boolean), ...otherConvs];
    
    await saveList();
    renderList();
  }

  async function moveFolderStep(folderId, direction) {
    const sorted = _buildSortedRootItems();
    const idx = sorted.findIndex(i => i.type === 'folder' && i.id === folderId);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= sorted.length) return;

    // 动画
    const itemEl = document.querySelector(`.conv-folder[data-folder="${folderId}"]`);
    const other = sorted[targetIdx];
    const otherEl = other.type === 'conv'
      ? document.querySelector(`.conv-item[data-conv-id="${other.id}"]`)
      : document.querySelector(`.conv-folder[data-folder="${other.id}"]`);
    if (itemEl) itemEl.classList.add('reorder-animate');
    if (otherEl) otherEl.classList.add('reorder-animate');
    if (itemEl) itemEl.classList.add(direction === 'up' ? 'drag-shift-up' : 'drag-shift-down');
    if (otherEl) otherEl.classList.add(direction === 'up' ? 'drag-shift-down' : 'drag-shift-up');
    await new Promise(r => setTimeout(r, 180));
    if (itemEl) itemEl.classList.remove('drag-shift-up', 'drag-shift-down');
    if (otherEl) otherEl.classList.remove('drag-shift-up', 'drag-shift-down');

    [sorted[idx], sorted[targetIdx]] = [sorted[targetIdx], sorted[idx]];
    _applyDisplayOrder(sorted);

    await saveList();
    renderList();
  }


  // ===== 文件夹管理 =====

  async function createFolder() {
    const name = await UI.showSimpleInput('新建关联', '世界线关联');
    if (!name) return;
    folders.push({ id: 'folder_' + Utils.uuid().slice(0, 8), name: name.trim(), worldviewId: _activeWorldviewId() });
    await saveList();
    renderList();
  }

  async function renameFolder(folderId) {
    const f = folders.find(x => x.id === folderId);
    if (!f) return;
    const name = await UI.showSimpleInput('重命名关联', f.name);
    if (!name) return;
    f.name = name.trim();
    await saveList();
    renderList();
  }

  async function deleteFolder(folderId) {
    const f = folders.find(x => x.id === folderId);
    const folderConvs = list.filter(c => c.folder === folderId);

    if (folderConvs.length === 0) {
      // 空文件夹直接删
      folders = folders.filter(x => x.id !== folderId);
      await saveList();
      renderList();
      return;
    }

    // 有对话时让玩家选择
    const choice = await UI.showConfirm(
      '删除文件夹',
      `文件夹「${f?.name || ''}」中有 ${folderConvs.length} 个对话。\n\n` +
      `【确定】= 仅删除文件夹，对话移到根目录\n` +
      `【取消】后可长按选"删除全部"来连同对话一起删除`
    );

    if (choice) {
      // 仅删文件夹，对话移根目录
      list.forEach(c => { if (c.folder === folderId) c.folder = null; });
      folders = folders.filter(x => x.id !== folderId);
      await saveList();
      renderList();
    }
  }

  async function deleteFolderWithConvs(folderId) {
    const f = folders.find(x => x.id === folderId);
    const folderConvs = list.filter(c => c.folder === folderId);
    if (!await UI.showConfirm('确认删除', `确定删除文件夹「${f?.name || ''}」及其中 ${folderConvs.length} 个对话？此操作不可撤销。`)) return;

    // 删除文件夹内所有对话的消息、总结、归档、面具
for (const conv of folderConvs) {
try { await DB.deleteByIndex('messages', 'conversationId', conv.id); } catch(e) { console.warn('[Conv] 删除消息失败', e); }
try { await DB.del('summaries', conv.id); } catch(e) {}
const allArchives = await DB.getAll('archives');
      for (const arch of allArchives) { if (arch.conversationId === conv.id) await DB.del('archives', arch.id); }
      if (conv.branchMaskId) {
        try { await DB.del('characters', conv.branchMaskId); } catch(e) {}
      }
    }

    const removedIds = new Set(folderConvs.map(c => c.id));
    list = list.filter(c => !removedIds.has(c.id));
    folders = folders.filter(x => x.id !== folderId);

    if (removedIds.has(currentId)) {
      // 在当前世界观下找下一个对话；找不到就进空态
      const wv = _activeWorldviewId();
      const same = list.find(c => (c.worldviewId || '__default_wv__') === wv);
      currentId = same ? same.id : null;
      await Chat.loadHistory(currentId);
    }

    await saveList();
    renderList();
  }

  async function toggleFolderPin(folderId) {
    const f = folders.find(x => x.id === folderId);
    if (!f) return;
    
    // 获取当前元素位置用于动画
    const folderEl = document.querySelector(`.conv-folder[data-folder="${folderId}"]`);
    if (folderEl) {
      folderEl.classList.add('reorder-animate');
    }
    
    await new Promise(r => setTimeout(r, 50));
    
    f.pinned = !f.pinned;
    await saveList();
    renderList();
  }

  function toggleFolderCollapse(folderId) {
  const f = folders.find(x => x.id === folderId);
  if (!f) return;
  f.collapsed = !f.collapsed;
  saveList();

  const folderEl = document.querySelector(`.conv-folder[data-folder="${folderId}"]`);
  if (!folderEl) return;
  const body = folderEl.querySelector('.conv-folder-body');
  const arrow = folderEl.querySelector('.folder-arrow');
  if (!body) return;

  if (f.collapsed) {
    body.style.maxHeight = body.scrollHeight + 'px';
    body.offsetHeight;
    body.classList.remove('expanded');
    body.style.maxHeight = '0';
    if (arrow) arrow.classList.remove('expanded');
    body.addEventListener('transitionend', function handler() {
      body.style.maxHeight = '';
      body.removeEventListener('transitionend', handler);
    });
  } else {
    body.classList.add('expanded');
    body.style.maxHeight = body.scrollHeight + 'px';
    if (arrow) arrow.classList.add('expanded');
    body.addEventListener('transitionend', function handler() {
      body.style.maxHeight = 'none';
      body.removeEventListener('transitionend', handler);
    });
  }
}

  function getSorted(items) {
    // 置顶在前，其次按原始顺序
    const pinned = items.filter(c => c.pinned);
    const normal = items.filter(c => !c.pinned);
    return [...pinned, ...normal];
  }

  // ===== 渲染 =====

  function renderList() {
    const container = document.getElementById('conversation-list');
    if (!container) return;

    let html = '';

    // 按当前世界观过滤
    const activeWv = _activeWorldviewId();
    let filteredList = list.filter(c => (c.worldviewId || '__default_wv__') === activeWv);
    const filteredFolders = folders.filter(f => (f.worldviewId || '__default_wv__') === activeWv);

    // 无世界观下，按角色筛选
    if (activeWv === '__default_wv__' && _charFilter && _charFilter !== '__all__') {
      filteredList = filteredList.filter(c => {
        if (_charFilter === '__group__') return !c.isSingle;
        if (!c.isSingle) return false;
        const key = (c.singleCharType || '') + ':' + (c.singleCharId || '');
        return key === _charFilter;
      });
    }
    const filteredFolderIds = new Set(filteredFolders.map(f => f.id));

    // 统一排序：把根对话和文件夹混合
    // 如果对话的 folder 不在当前世界观的文件夹里，也视为根对话
    const rootConvs = filteredList.filter(c => !c.folder || !filteredFolderIds.has(c.folder));

    const items = [];
    rootConvs.forEach(c => items.push({ type: 'conv', data: c, pinned: !!c.pinned, order: c.displayOrder ?? 9999 }));
    filteredFolders.forEach(f => items.push({ type: 'folder', data: f, pinned: !!f.pinned, order: f.displayOrder ?? 9999 }));

    // 置顶在前，其余按 displayOrder 排序
    const sorted = [
      ...items.filter(i => i.pinned).sort((a, b) => a.order - b.order),
      ...items.filter(i => !i.pinned).sort((a, b) => a.order - b.order)
    ];

    sorted.forEach(item => {
      if (item.type === 'conv') {
        html += renderConvItem(item.data);
      } else {
        const f = item.data;
        const folderConvs = getSorted(filteredList.filter(c => c.folder === f.id));
        html += `<div class="conv-folder" data-folder="${f.id}">
          <div class="conv-folder-header" data-folder-id="${f.id}" onclick="Conversations._folderClick(event,'${f.id}')"
            oncontextmenu="event.preventDefault();Conversations.showFolderCtx(event,'${f.id}')"
            ontouchstart="Conversations._folderTouchStart(event,'${f.id}')"
            ontouchend="Conversations._touchEnd()"
            ontouchmove="Conversations._touchEnd()">
            <span style="display:flex;align-items:center;min-width:0;flex:1">
<svg class="folder-arrow${f.collapsed ? '' : ' expanded'}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(f.name)}</span>
</span>
            <span style="display:inline-flex;align-items:center">${f.pinned ? '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:16px;height:16px;color:var(--accent)"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" /></svg>' : ''}</span>
          </div>`;
        html += `<div class="conv-folder-body${f.collapsed ? '' : ' expanded'}">${folderConvs.map(c => renderConvItem(c)).join('')}</div>`;
        html += '</div>';
      }
    });

    container.innerHTML = html;
    initDragSort(container);
    _refreshSingleAvatars();
  }

  function renderConvItem(c) {
    const gaidenIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:text-bottom;margin-right:4px;color:var(--accent)"><path d="M14 11a2 2 0 1 1-4 0 4 4 0 0 1 8 0 6 6 0 0 1-12 0 8 8 0 0 1 16 0 10 10 0 1 1-20 0 11.93 11.93 0 0 1 2.42-7.22 2 2 0 1 1 3.16 2.44"/></svg> ';
    const branchIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:text-bottom;margin-right:4px;color:var(--accent)"><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/></svg> ';
    const nameIcon = c.isGaiden ? gaidenIcon : c.branchMaskId ? branchIcon : '';
    const singleAvatar = c.isSingle
      ? `<img class="conv-avatar" data-conv-avatar-id="${c.id}" src="${_avatarCache[c.id] || ''}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;flex-shrink:0;margin-right:6px;background:var(--bg);vertical-align:middle;${_avatarCache[c.id] ? '' : 'display:none'}">`
      : '';
    return `<div class="conv-item ${c.id === currentId ? 'active' : ''}" data-conv-id="${c.id}"
      onclick="Conversations.switchTo('${c.id}')"
      oncontextmenu="event.preventDefault();Conversations.showCtxMenu(event,'${c.id}')"
      ontouchstart="Conversations._touchStart(event,'${c.id}')"
      ontouchend="Conversations._touchEnd()"
      ontouchmove="Conversations._touchEnd()">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${nameIcon}${singleAvatar}${Utils.escapeHtml(c.name)}</span>${_streamingIds.has(c.id) ? '<span class="conv-spinner" title="生成中"></span>' : ''}${c.pinned ? '<span style="display:inline-flex;align-items:center;margin-left:4px;flex-shrink:0"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:16px;height:16px;color:var(--accent)"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" /></svg></span>' : ''}
    </div>`;
  }

  // ===== 生成中状态（spinner） =====
  const _streamingIds = new Set();

  function setStreaming(convId, streaming) {
    if (!convId) return;
    if (streaming) _streamingIds.add(convId);
    else _streamingIds.delete(convId);
    // 局部刷新：不重建整列表，避免打断动画/正在编辑的项
    const item = document.querySelector(`.conv-item[data-conv-id="${convId}"]`);
    if (!item) return;
    let sp = item.querySelector('.conv-spinner');
    if (streaming && !sp) {
      sp = document.createElement('span');
      sp.className = 'conv-spinner';
      sp.title = '生成中';
      // 插到名字 span 之后、置顶图标之前
      const nameSpan = item.querySelector('span:first-child');
      if (nameSpan && nameSpan.nextSibling) item.insertBefore(sp, nameSpan.nextSibling);
      else item.appendChild(sp);
    } else if (!streaming && sp) {
      sp.remove();
    }
  }

  // ===== 长按菜单 =====

  let _suppressNextFolderClick = false;

  function _getTouchPoint(e) {
    const t = e?.touches?.[0] || e?.changedTouches?.[0] || e;
    return {
      clientX: t?.clientX || t?.pageX || 100,
      clientY: t?.clientY || t?.pageY || 100,
      pageX: t?.pageX || t?.clientX || 100,
      pageY: t?.pageY || t?.clientY || 100,
      target: e?.target || t?.target || null,
      preventDefault: () => { try { e?.preventDefault?.(); } catch(_) {} }
    };
  }

  function _touchStart(e, id) {
    const point = _getTouchPoint(e);
    longPressTimer = setTimeout(() => {
      point.preventDefault();
      showCtxMenu(point, id);
    }, 500);
  }
  function _folderTouchStart(e, folderId) {
    const point = _getTouchPoint(e);
    longPressTimer = setTimeout(() => {
      _suppressNextFolderClick = true;
      point.preventDefault();
      showFolderCtx(point, folderId);
      setTimeout(() => { _suppressNextFolderClick = false; }, 650);
    }, 500);
  }
  function _folderClick(e, folderId) {
    if (_suppressNextFolderClick) {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      _suppressNextFolderClick = false;
      return;
    }
    toggleFolderCollapse(folderId);
  }
  function _touchEnd() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  function showCtxMenu(e, id) {
    _touchEnd();
    _closeCtx();

    const conv = list.find(c => c.id === id);
    const menu = _createMenu(e);

    const items = [
      { label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg> 重命名`, fn: () => { menu.remove(); rename(id); } },
      { label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M12 5v14"/><path d="m19 12-7-7-7 7"/></svg> 上移一位`, fn: () => { menu.remove(); moveConvStep(id, 'up'); } },
      { label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M12 19V5"/><path d="m5 12 7 7 7-7"/></svg> 下移一位`, fn: () => { menu.remove(); moveConvStep(id, 'down'); } },
      { label: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:16px;height:16px;vertical-align:middle"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" /></svg> ${conv?.pinned ? '取消置顶' : '置顶'}`, fn: () => { menu.remove(); togglePin(id); } },
      { label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg> 创建分支`, fn: () => { menu.remove(); createBranchFromConv(id); } },
      { label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/></svg> 切换世界观`, fn: () => { menu.remove(); changeWorldview(id); } },
    ];

    // 移动到文件夹子菜单
    const wvFolders = folders.filter(f => (f.worldviewId || '__default_wv__') === (conv?.worldviewId || '__default_wv__'));
    if (wvFolders.length > 0 || conv?.folder) {
      const moveItems = [];
      if (conv?.folder) moveItems.push({ label: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:16px;height:16px;vertical-align:middle"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg> 移到根目录`, fn: () => { menu.remove(); moveToFolder(id, null); } });
      wvFolders.forEach(f => {
        if (f.id !== conv?.folder) {
          moveItems.push({ label: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:16px;height:16px;vertical-align:middle"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg> 移到 ${f.name}`, fn: () => { menu.remove(); moveToFolder(id, f.id); } });
        }
      });
      if (moveItems.length > 0) {
        items.push({ sep: true });
        moveItems.forEach(mi => items.push(mi));
      }
    }

    if (list.length > 1) {
      items.push({ sep: true });
      items.push({ label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 删除`, fn: () => { menu.remove(); remove(id); }, danger: true });
    }

    _fillMenu(menu, items);
  }

  function showFolderCtx(e, folderId) {
    _closeCtx();
    const f = folders.find(x => x.id === folderId);
    const folderConvs = list.filter(c => c.folder === folderId);
    const menu = _createMenu(e);
    const items = [
      { label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg> 重命名`, fn: () => { menu.remove(); renameFolder(folderId); } },
      { label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M12 5v14"/><path d="m19 12-7-7-7 7"/></svg> 上移一位`, fn: () => { menu.remove(); moveFolderStep(folderId, 'up'); } },
      { label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M12 19V5"/><path d="m5 12 7 7 7-7"/></svg> 下移一位`, fn: () => { menu.remove(); moveFolderStep(folderId, 'down'); } },
      { label: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:16px;height:16px;vertical-align:middle"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" /></svg> ${f?.pinned ? '取消置顶' : '置顶'}`, fn: () => { menu.remove(); toggleFolderPin(folderId); } },
      { label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/></svg> 切换世界观`, fn: () => { menu.remove(); changeFolderWorldview(folderId); } },
      { sep: true },
      { label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 仅删文件夹`, fn: () => { menu.remove(); deleteFolder(folderId); }, danger: true },
    ];
    if (folderConvs.length > 0) {
      items.push({ label: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 连同对话删除`, fn: () => { menu.remove(); deleteFolderWithConvs(folderId); }, danger: true });
    }
    _fillMenu(menu, items);
  }

  // ===== 菜单辅助 =====

  async function _closeCtx() {
    const old = document.getElementById('conv-ctx-menu');
    if (!old) return;
    old.classList.add('closing');
    await new Promise(r => setTimeout(r, 120));
    old.remove();
  }

  function _createMenu(e) {
    const menu = document.createElement('div');
    menu.id = 'conv-ctx-menu';
    menu.style.cssText = 'position:fixed;z-index:400;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:4px 0;box-shadow:0 4px 12px rgba(0,0,0,0.4);min-width:140px;max-height:60vh;overflow-y:auto';

    const x = e.clientX || e.pageX || 100;
    const y = e.clientY || e.pageY || 100;
    menu.dataset.anchorX = String(x);
    menu.dataset.anchorY = String(y);

    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    document.body.appendChild(menu);

    setTimeout(() => {
      const close = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.classList.add('closing');
          setTimeout(() => menu.remove(), 120);
          document.removeEventListener('click', close, true);
        }
      };
      document.addEventListener('click', close, true);
    }, 0);
    return menu;
  }

  function _repositionMenu(menu) {
    if (!menu) return;

    const margin = 8;
    const x = parseFloat(menu.dataset.anchorX || '100');
    const y = parseFloat(menu.dataset.anchorY || '100');
    const rect = menu.getBoundingClientRect();

    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);

    let left = x;
    let top = y;

    if (left + rect.width + margin > window.innerWidth) {
      left = window.innerWidth - rect.width - margin;
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = y - rect.height;
    }

    left = Math.min(Math.max(margin, left), maxLeft);
    top = Math.min(Math.max(margin, top), maxTop);

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function _fillMenu(menu, items) {
    items.forEach(it => {
      if (it.sep) {
        const sep = document.createElement('div');
        sep.style.cssText = 'height:1px;background:var(--border);margin:2px 0';
        menu.appendChild(sep);
      } else {
        const btn = document.createElement('button');
        btn.innerHTML = it.label;
        btn.style.cssText = `display:flex;align-items:center;gap:8px;width:100%;padding:10px 16px;background:none;border:none;color:${it.danger ? 'var(--danger)' : 'var(--text)'};font-size:13px;text-align:left;cursor:pointer`;
        btn.onclick = it.fn;
        menu.appendChild(btn);
      }
    });

    _repositionMenu(menu);
  }

  // ===== 拖动排序 =====

  function initDragSort(container) {
    container.querySelectorAll('.drag-handle[draggable]').forEach(el => {
      el.addEventListener('dragstart', onDragStart);
      el.addEventListener('dragend', onDragEnd);
    });

    // 整个容器监听 dragover 和 drop，用事件代理
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('drop', onDrop);

    // 文件夹头可以作为“对话放进去”的放置目标，但文件夹拖动时不触发收纳
    container.querySelectorAll('.conv-folder-header').forEach(el => {
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', (e) => { el.classList.remove('drag-over'); });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drag-over');
        const convId = e.dataTransfer.getData('text/plain');
        const dragType = e.dataTransfer.getData('application/x-drag-type');
        const folderId = el.parentElement.dataset.folder;
        if (dragType === 'conv' && convId && folderId) moveToFolder(convId, folderId);
      });
    });
  }

  let dragOriginIndex = -1;

  function getAllVisibleRootItems() {
    return Array.from(document.querySelectorAll('#conversation-list > .conv-item, #conversation-list > .conv-folder'));
  }

  function _getDragMeta(target) {
    const convId = target.dataset.convId;
    if (convId) return { type: 'conv', id: convId, el: target.closest('.conv-item') };
    const folderId = target.dataset.folderId;
    if (folderId) return { type: 'folder', id: folderId, el: target.closest('.conv-folder') };
    return null;
  }

  function onDragStart(e) {
    const meta = _getDragMeta(e.target);
    if (!meta?.id || !meta?.el) return;
    e.dataTransfer.setData('text/plain', meta.id);
    e.dataTransfer.setData('application/x-drag-type', meta.type);
    meta.el.classList.add('dragging');
    dragState = meta.id;

    const allItems = getAllVisibleRootItems();
    dragOriginIndex = allItems.findIndex(el => el === meta.el);
  }

  function onDragEnd(e) {
    document.querySelectorAll('.conv-item, .conv-folder').forEach(el => {
      el.classList.remove('dragging', 'drag-shift-up', 'drag-shift-down');
    });
    document.querySelectorAll('.conv-folder-header').forEach(el => el.classList.remove('drag-over'));
    dragState = null;
    dragOriginIndex = -1;
  }

  function onDragOver(e) {
    e.preventDefault();
    if (!dragState || dragOriginIndex < 0) return;

    const hoverEl = e.target.closest('.conv-item, .conv-folder');
    if (!hoverEl) return;

    const dragType = e.dataTransfer.getData('application/x-drag-type');
    const hoverType = hoverEl.classList.contains('conv-folder') ? 'folder' : 'conv';
    const hoverId = hoverType === 'folder' ? hoverEl.dataset.folder : hoverEl.dataset.convId;
    if (!hoverId || hoverId === dragState) return;

    const allItems = getAllVisibleRootItems();
    const hoverIndex = allItems.findIndex(el => el === hoverEl);
    if (hoverIndex < 0) return;

    allItems.forEach((el, i) => {
      const elId = el.classList.contains('conv-folder') ? el.dataset.folder : el.dataset.convId;
      if (elId === dragState) return;
      el.classList.remove('drag-shift-up', 'drag-shift-down');

      if (dragOriginIndex < hoverIndex) {
        if (i > dragOriginIndex && i <= hoverIndex) el.classList.add('drag-shift-down');
      } else if (dragOriginIndex > hoverIndex) {
        if (i >= hoverIndex && i < dragOriginIndex) el.classList.add('drag-shift-up');
      }
    });
  }

  function onDrop(e) {
    e.preventDefault();
    const fromId = e.dataTransfer.getData('text/plain');
    const dragType = e.dataTransfer.getData('application/x-drag-type');
    const toEl = e.target.closest('.conv-item, .conv-folder');
    if (!fromId || !toEl) return;

    const toType = toEl.classList.contains('conv-folder') ? 'folder' : 'conv';
    const toId = toType === 'folder' ? toEl.dataset.folder : toEl.dataset.convId;
    if (!toId || fromId === toId) return;

    // 文件夹头自身的 drop 已处理“放进文件夹”；这里只处理根层重排
    const allItems = getAllVisibleRootItems();
    const domFromIdx = allItems.findIndex(el => (el.classList.contains('conv-folder') ? el.dataset.folder : el.dataset.convId) === fromId);
    const domToIdx = allItems.findIndex(el => el === toEl);
    if (domFromIdx < 0 || domToIdx < 0) return;

    const order = allItems.map(el => {
      if (el.classList.contains('conv-folder')) return { type: 'folder', id: el.dataset.folder };
      return { type: 'conv', id: el.dataset.convId };
    });

    const fromIndex = order.findIndex(x => x.type === dragType && x.id === fromId);
    const toIndex = order.findIndex(x => x.type === toType && x.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;

    const [moved] = order.splice(fromIndex, 1);
    const targetIndex = order.findIndex(x => x.type === toType && x.id === toId);
    if (domFromIdx < domToIdx) order.splice(targetIndex + 1, 0, moved);
    else order.splice(targetIndex, 0, moved);

    const rootConvIds = order.filter(x => x.type === 'conv').map(x => x.id);
    const rootFolderIds = order.filter(x => x.type === 'folder').map(x => x.id);
    const rootConvSet = new Set(rootConvIds);
    const rootFolderSet = new Set(rootFolderIds);

    const rootConvs = list.filter(c => rootConvSet.has(c.id));
    const otherConvs = list.filter(c => !rootConvSet.has(c.id));
    const rootFolders = folders.filter(f => rootFolderSet.has(f.id));
    const otherFolders = folders.filter(f => !rootFolderSet.has(f.id));

    list = [
      ...rootConvIds.map(id => rootConvs.find(c => c.id === id)).filter(Boolean),
      ...otherConvs
    ];
    folders = [
      ...rootFolderIds.map(id => rootFolders.find(f => f.id === id)).filter(Boolean),
      ...otherFolders
    ];

    saveList();
    renderList();
  }

  // ===== 分支 =====

  async function createBranchFromConv(id) {
    if (id !== currentId) await switchTo(id);
    const msgs = Chat.getMessages();
    if (msgs.length === 0) { alert('该对话没有消息，无法创建分支'); return; }
    Chat.createBranch(msgs[msgs.length - 1].id);
  }

  // ===== 切换对话所属世界观 =====

  async function changeWorldview(convId) {
    const conv = list.find(c => c.id === convId);
    if (!conv) return;

    const wvListData = await DB.get('gameState', 'worldviewList');
    const wvList = wvListData?.value || [];

    // 构建选项
    const currentWvId = conv.worldviewId || '__default_wv__';
    let html = '<div style="max-height:60vh;overflow-y:auto;padding:8px 0">';
    for (const w of wvList) {
      const isActive = w.id === currentWvId;
      const iconHTML = w.iconImage
        ? `<img src="${w.iconImage}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;margin-right:8px">`
        : `<div style="width:24px;height:24px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;color:#111;margin-right:8px;flex-shrink:0">${Utils.escapeHtml((w.name || '?')[0])}</div>`;
      html += `<div onclick="Conversations._doChangeWorldview('${convId}','${w.id}')" style="padding:10px 16px;cursor:pointer;font-size:13px;display:flex;align-items:center;color:var(--text);border-radius:6px;margin:0 8px${isActive ? ';background:var(--bg-tertiary);font-weight:bold' : ''}">${iconHTML}${Utils.escapeHtml(w.name)}${isActive ? ' <span style="margin-left:auto;color:var(--accent);font-size:12px">当前</span>' : ''}</div>`;
    }
    html += '</div>';

    // 用一个临时弹窗显示
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = 'z-index:9999';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:320px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <h3 style="margin:0;font-size:16px">移动到世界观</h3>
          <button onclick="this.closest('.modal').remove()" class="btn-icon" style="font-size:18px">✕</button>
        </div>
        ${html}
      </div>`;
    document.body.appendChild(modal);
  }

  async function _doChangeWorldview(convId, newWvId) {
    const conv = list.find(c => c.id === convId);
    if (!conv || conv.worldviewId === newWvId) {
      document.querySelector('.modal[style*="z-index:9999"]')?.remove();
      return;
    }
    conv.worldviewId = newWvId;
    conv.folder = null; // 移出原文件夹（跨世界观文件夹不通用）
    await saveList();
    document.querySelector('.modal[style*="z-index:9999"]')?.remove();
    renderList();
    UI.showToast('已移动到其他世界观');
  }

  // ===== 切换文件夹所属世界观（连同内部对话一起移） =====

  async function changeFolderWorldview(folderId) {
    const f = folders.find(x => x.id === folderId);
    if (!f) return;

    const wvListData = await DB.get('gameState', 'worldviewList');
    const wvList = wvListData?.value || [];

    const currentWvId = f.worldviewId || '__default_wv__';
    let html = '<div style="max-height:60vh;overflow-y:auto;padding:8px 0">';
    for (const w of wvList) {
      const isActive = w.id === currentWvId;
      const iconHTML = w.iconImage
        ? `<img src="${w.iconImage}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;margin-right:8px">`
        : `<div style="width:24px;height:24px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;color:#111;margin-right:8px;flex-shrink:0">${Utils.escapeHtml((w.name || '?')[0])}</div>`;
      html += `<div onclick="Conversations._doChangeFolderWorldview('${folderId}','${w.id}')" style="padding:10px 16px;cursor:pointer;font-size:13px;display:flex;align-items:center;color:var(--text);border-radius:6px;margin:0 8px${isActive ? ';background:var(--bg-tertiary);font-weight:bold' : ''}">${iconHTML}${Utils.escapeHtml(w.name)}${isActive ? ' <span style="margin-left:auto;color:var(--accent);font-size:12px">当前</span>' : ''}</div>`;
    }
    html += '</div>';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = 'z-index:9999';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:320px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <h3 style="margin:0;font-size:16px">移动文件夹到世界观</h3>
          <button onclick="this.closest('.modal').remove()" class="btn-icon" style="font-size:18px">✕</button>
        </div>
        <p style="font-size:12px;color:var(--text-secondary);margin:0 0 8px">文件夹内的对话将一起移动</p>
        ${html}
      </div>`;
    document.body.appendChild(modal);
  }

  async function _doChangeFolderWorldview(folderId, newWvId) {
    const f = folders.find(x => x.id === folderId);
    if (!f || f.worldviewId === newWvId) {
      document.querySelector('.modal[style*="z-index:9999"]')?.remove();
      return;
    }
    f.worldviewId = newWvId;
    // 文件夹内的对话也一起移
    list.forEach(c => {
      if (c.folder === folderId) c.worldviewId = newWvId;
    });
    await saveList();
    document.querySelector('.modal[style*="z-index:9999"]')?.remove();
    renderList();
    UI.showToast('文件夹已移动到其他世界观');
  }

  // 世界观删除时迁移对话和文件夹（操作内存+持久化）
  async function migrateWorldview(fromWvId, toWvId) {
    let changed = false;
    for (const conv of list) {
      if (conv.worldviewId === fromWvId) {
        conv.worldviewId = toWvId;
        conv.folder = null;
        changed = true;
      }
    }
    for (const f of folders) {
      if (f.worldviewId === fromWvId) {
        f.worldviewId = toWvId;
        changed = true;
      }
    }
    if (changed) {
      await saveList();
      renderList();
    }
  }

  // ===== 角色筛选器（无世界观下） =====
  function toggleCharFilter() {
    const dd = document.getElementById('char-filter-dropdown');
    if (!dd) return;
    if (dd.classList.contains('hidden')) {
      _renderCharFilterDropdown();
      dd.classList.remove('hidden');
      setTimeout(() => {
        const handler = (e) => {
          const btn = document.getElementById('char-filter-btn');
          if (!dd.contains(e.target) && btn && !btn.contains(e.target)) {
            dd.classList.add('hidden');
            document.removeEventListener('click', handler);
          }
        };
        document.addEventListener('click', handler);
      }, 0);
    } else {
      dd.classList.add('hidden');
    }
  }

  function _collectUsedChars() {
    const noWvList = list.filter(c => (c.worldviewId || '__default_wv__') === '__default_wv__');
    const seen = new Map();
    let hasGroup = false;
    noWvList.forEach(c => {
      if (!c.isSingle) { hasGroup = true; return; }
      const key = (c.singleCharType || '') + ':' + (c.singleCharId || '');
      if (!seen.has(key)) {
        seen.set(key, {
          key, type: c.singleCharType, id: c.singleCharId,
          wvId: c.singleCharSourceWvId || c.singleWorldviewId,
          name: '', avatar: ''
        });
      }
    });
    return { chars: Array.from(seen.values()), hasGroup };
  }

  async function _resolveCharInfo(item) {
    if (item.type === 'card') {
      try {
        const card = await DB.get('singleCards', item.id);
        if (card) { item.name = card.name || '未命名'; item.avatar = card.avatar || ''; }
        else { item.name = '（已删除角色）'; }
      } catch(e) { item.name = '？'; }
    } else if (item.type === 'npc') {
      try {
        const r = await DB.get('npcAvatars', item.id);
        if (r && r.avatar) item.avatar = r.avatar;
      } catch(e) {}
      if (item.wvId) {
        try {
          const wv = await DB.get('worldviews', item.wvId);
          if (wv) {
            outer: for (const r of (wv.regions || [])) {
              for (const f of (r.factions || [])) {
                for (const n of (f.npcs || [])) {
                  if (n.id === item.id) {
                    item.name = n.name || '未命名';
                    if (!item.avatar) item.avatar = n.avatar || '';
                    break outer;
                  }
                }
              }
            }
          }
        } catch(e) {}
      }
      if (!item.name) item.name = '（已删除NPC）';
    }
    return item;
  }

  async function _renderCharFilterDropdown() {
    const dd = document.getElementById('char-filter-dropdown');
    if (!dd) return;
    const { chars, hasGroup } = _collectUsedChars();
    await Promise.all(chars.map(_resolveCharInfo));
    const items = [{ key: '__all__', name: '全部对话', avatar: '', icon: 'all' }];
    if (hasGroup) items.push({ key: '__group__', name: '群像（无世界观）', avatar: '', icon: 'group' });
    chars.forEach(c => items.push({ key: c.key, name: c.name, avatar: c.avatar, icon: c.type }));
    dd.innerHTML = items.map(it => {
      const active = (_charFilter || '__all__') === it.key;
      const iconHtml = it.avatar
        ? `<img src="${Utils.escapeHtml(it.avatar)}" style="width:100%;height:100%;object-fit:cover">`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)">${
            it.icon === 'all' ? '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>' :
            it.icon === 'group' ? '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>' :
            '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>'
          }</svg>`;
      return `<button onclick="Conversations.pickCharFilter('${it.key}')" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;background:${active ? 'var(--bg-tertiary)' : 'none'};border:none;color:var(--text);font-size:13px;cursor:pointer;text-align:left">
        <div style="width:20px;height:20px;border-radius:50%;flex-shrink:0;overflow:hidden;background:var(--bg);display:flex;align-items:center;justify-content:center">${iconHtml}</div>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(it.name)}</span>
      </button>`;
    }).join('');
  }

  async function pickCharFilter(key) {
    _charFilter = key;
    document.getElementById('char-filter-dropdown')?.classList.add('hidden');
    await refreshCharFilter();
    renderList();
  }

  async function refreshCharFilter() {
    const labelEl = document.getElementById('char-filter-label');
    const iconEl = document.getElementById('char-filter-icon');
    if (!labelEl || !iconEl) return;
    if (!_charFilter || _charFilter === '__all__') {
      labelEl.textContent = '全部对话';
      iconEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)"><path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/></svg>';
      return;
    }
    if (_charFilter === '__group__') {
      labelEl.textContent = '群像（无世界观）';
      iconEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>';
      return;
    }
    const { chars } = _collectUsedChars();
    const target = chars.find(c => c.key === _charFilter);
    if (!target) {
      _charFilter = '__all__';
      labelEl.textContent = '全部对话';
      return;
    }
    await _resolveCharInfo(target);
    labelEl.textContent = target.name;
    iconEl.innerHTML = target.avatar
      ? `<img src="${Utils.escapeHtml(target.avatar)}" style="width:100%;height:100%;object-fit:cover">`
      : '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/></svg>';
  }

  return {
    init, create, switchTo, rename, remove, getCurrent, getCurrentName, getStatusBar, setStatusBar, enterEmptyState,
    renderList, addBranch, showCtxMenu, showFolderCtx, _touchStart, _folderTouchStart, _folderClick, _touchEnd,
    invalidateAvatarCache: _invalidateAvatarCache,
    refreshTopbar: _updateTopbar,
    togglePin, moveToFolder, moveConvStep, createFolder, renameFolder, deleteFolder, deleteFolderWithConvs,
    toggleFolderCollapse, toggleFolderPin, moveFolderStep, setMask, setPreset,
    changeWorldview, _doChangeWorldview,
    changeFolderWorldview, _doChangeFolderWorldview,
    migrateWorldview,
    saveList,
    toggleCharFilter, pickCharFilter, refreshCharFilter,
    getList: () => list,
    setStreaming
  };
})();