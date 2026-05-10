/**
 * 单人卡管理 — 独立角色（不挂世界观也能用）
 */
const SingleCard = (() => {
  let _editingId = null;

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
  }

  // 列表渲染
  async function renderList(filterText) {
    const container = document.getElementById('single-card-list');
    if (!container) return;
    const cards = await getAll();
    cards.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const q = (filterText || '').trim().toLowerCase();
    const filtered = q
      ? cards.filter(c =>
          (c.name || '').toLowerCase().includes(q) ||
          (c.aliases || '').toLowerCase().includes(q))
      : cards;
    if (filtered.length === 0) {
      container.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:40px 20px;font-size:13px">${q ? '没有匹配的角色' : '还没有角色，点上方"新建"创建第一张'}</div>`;
      return;
    }
    container.innerHTML = filtered.map(c => `
      <div onclick="SingleCard.edit('${c.id}')" style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:12px;display:flex;align-items:center;gap:12px;cursor:pointer">
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
        <button type="button" onclick="event.stopPropagation();SingleCard.quickCreateConversation('${c.id}')" style="flex-shrink:0;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap">创建对话</button>
      </div>
    `).join('');
  }

  async function quickCreateConversation(cardId) {
    const card = await get(cardId);
    if (!card) { UI.showToast('未找到此角色'); return; }
    if (typeof UI !== 'undefined') UI.showPanel && UI.showPanel('chat', 'back');
    if (typeof SingleMode !== 'undefined' && SingleMode.openCreateModal) {
      await SingleMode.openCreateModal(null, { charType: 'card', charId: cardId });
    }
  }

  // 新建
  function create() {
    _editingId = null;
    _openEditModal({ name: '', aliases: '', detail: '', avatar: '' });
  }

  // 编辑
  async function edit(id) {
    _scAutoSave.cancel(); // 切卡时取消上一张的挂起自动保存
    const card = await get(id);
    if (!card) { UI.showToast('未找到此角色'); return; }
    _editingId = id;
    _openEditModal(card);
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
        card.name = (document.getElementById('sc-edit-name')?.value || '').trim() || card.name;
        card.aliases = document.getElementById('sc-edit-aliases')?.value || '';
        card.detail = document.getElementById('sc-edit-detail')?.value || '';
        card.firstMes = document.getElementById('sc-edit-firstmes')?.value || '';
        card.mesExample = document.getElementById('sc-edit-mesexample')?.value || '';
        card.creator = document.getElementById('sc-edit-creator')?.value || '';
        card.creatorNotes = document.getElementById('sc-edit-creatornotes')?.value || '';
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
    const modal = document.getElementById('sc-edit-modal');
    if (!modal) return;
    modal.querySelectorAll('input, textarea').forEach(el => {
      el.removeEventListener('input', _scAutoSave);
      el.addEventListener('input', _scAutoSave);
    });
  }

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
    closeEditModal();
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

  // 解析 JSON 卡：兼容我们自家格式 + 酒馆 v1/v2
  function _parseJsonCard(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) { return null; }
    // 自家格式
    if (json.__format === 'tianshu_single_card_v1') {
      return json;
    }
    return _normalizeTavernCard(json);
  }

  // 把酒馆卡的 JSON 对象映射到我们的格式
  function _normalizeTavernCard(json) {
    if (!json) return null;
    // 酒馆 v2 把核心字段塞在 data 字段里
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

  // 解析 PNG 卡（酒馆角色卡 PNG）
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
    const normalized = _normalizeTavernCard(json);
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

  function _pickNpcAvatar(npcId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        await setNpcAvatar(npcId, reader.result);
        renderNpcAvatarList(document.getElementById('npc-avatar-search')?.value || '');
        UI.showToast('头像已更新');
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  async function _removeNpcAvatar(npcId) {
    if (!await UI.showConfirm('确认删除', '删除该 NPC 的自定义头像？')) return;
    await setNpcAvatar(npcId, '');
    renderNpcAvatarList(document.getElementById('npc-avatar-search')?.value || '');
    UI.showToast('已删除');
  }

  return {
    getAll, get, save, remove,
    renderList, create, edit, quickCreateConversation,
    closeEditModal, saveFromModal, deleteCurrent, pickAvatar,
    formatForPrompt,
    importCard, exportCurrent,
    switchCharSubtab, renderNpcAvatarList, getNpcAvatar, setNpcAvatar,
    _pickNpcAvatar, _removeNpcAvatar
  };
})();
