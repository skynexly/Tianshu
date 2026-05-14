/**
 * 单人模式 — 模式选择 + 单人对话创建/设置
 */
const SingleMode = (() => {
  let _editingConvId = null; // null 表示新建

  // ===== 模式选择弹窗 =====
  function openModeSelect() {
    // 无世界观时禁用群像入口
    const wvId = Worldview.getCurrentId();
    const isNoWv = !wvId || wvId === '__default_wv__';
    const groupBtn = document.getElementById('mode-select-group-btn');
    const groupHint = document.getElementById('mode-select-group-hint');
    if (groupBtn) groupBtn.style.display = isNoWv ? 'none' : 'flex';
    if (groupHint) groupHint.style.display = isNoWv ? 'block' : 'none';
    document.getElementById('mode-select-modal').classList.remove('hidden');
  }
  function closeModeSelect() {
    document.getElementById('mode-select-modal').classList.add('hidden');
  }
  function pickGroup() {
    closeModeSelect();
    Conversations.create();
  }
  function pickSingle() {
    closeModeSelect();
    openCreateModal();
  }

  // ===== 单人对话设置弹窗 =====
  // mode: 'create' | 'edit'  当 edit 时传 convId
  async function openCreateModal(convId, preset) {
    _editingConvId = convId || null;
    let initial = {
      worldviewId: '',
      charType: 'card',
      charId: '',
      enableDetail: false,
      enableNpc: false,
      enableStartPlot: false,
      enableFestival: false,
      enableCustom: false,
      enableKnowledge: false,
      enableCardExtended: true
    };
    if (!convId && preset) {
      initial = {
        ...initial,
        worldviewId: preset.worldviewId || '',
        charType: preset.charType || 'card',
        charId: preset.charId || '',
        charSourceWvId: preset.charSourceWvId || '',
        enableDetail: !!preset.enableDetail,
        enableNpc: !!preset.enableNpc,
        enableStartPlot: !!preset.enableStartPlot,
        enableFestival: !!preset.enableFestival,
        enableCustom: !!preset.enableCustom,
        enableKnowledge: !!preset.enableKnowledge,
        enableCardExtended: preset.enableCardExtended !== false
      };
    }
    if (convId) {
      const conv = Conversations.getList().find(c => c.id === convId);
      if (conv) {
        initial = {
          worldviewId: conv.singleWorldviewId || '',
          charType: conv.singleCharType || 'card',
          charId: conv.singleCharId || '',
          charSourceWvId: conv.singleCharSourceWvId || '',
          enableDetail: !!conv.singleEnableDetail,
          enableNpc: !!conv.singleEnableNpc,
          enableStartPlot: !!conv.singleEnableStartPlot,
          enableFestival: !!conv.singleEnableFestival,
          enableCustom: !!conv.singleEnableCustom,
          enableKnowledge: !!conv.singleEnableKnowledge,
          enableCardExtended: conv.singleEnableCardExtended !== false
        };
      }
    }

    // 渲染世界观下拉
    await _renderWorldviewSelect(initial.worldviewId);

    // 渲染角色选择器（默认 tab）
    _state.charType = initial.charType;
    _state.charId = initial.charId;
    _state.charSourceWvId = initial.charSourceWvId || '';
    _state.charSearchText = '';
    document.getElementById('sm-char-search').value = '';
    _switchCharTab(initial.charType);

    // 勾选框
    document.getElementById('sm-enable-detail').checked = initial.enableDetail;
    document.getElementById('sm-enable-npc').checked = initial.enableNpc;
    document.getElementById('sm-enable-startplot').checked = initial.enableStartPlot;
    // v599：扩展设定合并为单一总开关（任一旧字段为真即视为开启，向后兼容）
    document.getElementById('sm-enable-extended').checked =
      !!(initial.enableFestival || initial.enableCustom || initial.enableKnowledge);
    // 单人卡扩展设定开关
    const cardExtEl = document.getElementById('sm-enable-card-extended');
    if (cardExtEl) cardExtEl.checked = initial.enableCardExtended;
    _updateCardExtRowVisibility();

    // 标题
    document.getElementById('sm-modal-title').textContent = convId ? '单人对话设置' : '新建单人对话';
    document.getElementById('sm-modal-confirm-btn').textContent = convId ? '保存' : '创建';

    _updateWorldviewOptionsState();
    document.getElementById('single-mode-modal').classList.remove('hidden');
  }

  function closeCreateModal() {
    document.getElementById('single-mode-modal').classList.add('hidden');
    _editingConvId = null;
  }

  async function _renderWorldviewSelect(currentId) {
    const dropdown = document.getElementById('sm-worldview-dropdown');
    const hidden = document.getElementById('sm-worldview-select');
    if (!dropdown || !hidden) return;
    const wvs = await DB.getAll('worldviews');
    const wvList = wvs.filter(w => w.id !== '__default_wv__' && !w._hidden);

    // 全部世界观选项
    const items = [{ id: '', name: '无', icon: '', iconImage: '' }].concat(wvList);
    dropdown.innerHTML = items.map(w => {
      const isActive = (currentId || '') === w.id;
      const iconHtml = w.iconImage
        ? `<span style="display:inline-block;width:22px;height:22px;border-radius:5px;background:url('${Utils.escapeHtml(w.iconImage)}') center/cover;flex-shrink:0;margin-right:8px;vertical-align:middle"></span>`
        : (w.id === '' ? `<span style="display:inline-block;width:22px;margin-right:8px;flex-shrink:0"></span>` : `<svg class="wv-fallback-icon" style="margin-right:8px;vertical-align:middle" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20"/><path d="M12 2a15.3 15.3 0 0 0 0 20"/></svg>`);
      return `<div class="custom-dropdown-item${isActive ? ' active' : ''}" style="display:flex;align-items:center" onclick="SingleMode._pickWorldview('${Utils.escapeHtml(w.id)}')">${iconHtml}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(w.name || '未命名')}</span></div>`;
    }).join('');

    // 设置当前显示
    const cur = items.find(w => w.id === (currentId || '')) || items[0];
    hidden.value = cur.id;
    _updateWorldviewLabel(cur);
  }

  function _updateWorldviewLabel(w) {
    const label = document.getElementById('sm-worldview-label');
    const iconEl = document.getElementById('sm-wv-icon');
    const emojiEl = document.getElementById('sm-wv-emoji');
    if (!label) return;
    label.textContent = w.name || '未命名';
    if (w.iconImage) {
      iconEl.style.display = 'inline-block';
      iconEl.style.backgroundImage = `url('${w.iconImage}')`;
      emojiEl.style.display = 'none';
    } else if (w.icon) {
      iconEl.style.display = 'none';
      emojiEl.style.display = 'inline';
      emojiEl.textContent = w.icon;
    } else {
      iconEl.style.display = 'none';
      emojiEl.style.display = 'none';
    }
  }

  function _toggleWorldviewDropdown() {
    const dropdown = document.getElementById('sm-worldview-dropdown');
    if (!dropdown) return;
    if (!dropdown.classList.contains('hidden')) {
      dropdown.classList.add('hidden');
      return;
    }
    dropdown.classList.remove('hidden');
    setTimeout(() => {
      document.addEventListener('click', function _close(e) {
        if (!dropdown.contains(e.target) && !dropdown.previousElementSibling?.contains(e.target)) {
          dropdown.classList.add('hidden');
          document.removeEventListener('click', _close);
        }
      });
    }, 0);
  }

  async function _pickWorldview(wvId) {
    const hidden = document.getElementById('sm-worldview-select');
    hidden.value = wvId;
    const wvs = await DB.getAll('worldviews');
    const all = [{ id: '', name: '无', icon: '', iconImage: '' }].concat(wvs.filter(w => w.id !== '__default_wv__' && !w._hidden));
    const w = all.find(x => x.id === wvId) || all[0];
    _updateWorldviewLabel(w);
    document.getElementById('sm-worldview-dropdown').classList.add('hidden');
    // 更新激活样式
    document.querySelectorAll('#sm-worldview-dropdown .custom-dropdown-item').forEach(el => el.classList.remove('active'));
    _onWorldviewChange();
  }

  // 当世界观切到"无"时，相关勾选框 disabled
  function _updateWorldviewOptionsState() {
    const wvId = document.getElementById('sm-worldview-select').value;
    const hasWv = !!wvId;
    ['sm-enable-detail','sm-enable-npc','sm-enable-startplot','sm-enable-extended'].forEach(id => {
      const cb = document.getElementById(id);
      if (cb) {
        cb.disabled = !hasWv;
        if (!hasWv) cb.checked = false;
        const label = cb.closest('label');
        if (label) label.style.opacity = hasWv ? '1' : '0.4';
      }
    });
  }

  // 单人卡扩展设定开关行：选了单人卡时显示
  function _updateCardExtRowVisibility() {
    const row = document.getElementById('sm-card-ext-row');
    if (!row) return;
    const isCard = _state.charType === 'card' && !!_state.charId;
    if (isCard) row.classList.remove('hidden');
    else row.classList.add('hidden');
  }

  // ===== 角色选择器 =====
  const _state = { charType: 'card', charId: '', charSourceWvId: '', charSearchText: '' };

  function _switchCharTab(tab) {
    _state.charType = tab;
    const cardBtn = document.getElementById('sm-char-tab-card');
    const npcBtn = document.getElementById('sm-char-tab-npc');
    if (tab === 'card') {
      cardBtn.style.background = 'var(--accent)';
      cardBtn.style.color = '#111';
      npcBtn.style.background = 'transparent';
      npcBtn.style.color = 'var(--text-secondary)';
    } else {
      cardBtn.style.background = 'transparent';
      cardBtn.style.color = 'var(--text-secondary)';
      npcBtn.style.background = 'var(--accent)';
      npcBtn.style.color = '#111';
    }
    _renderCharList();
    _updateCardExtRowVisibility();
  }

  async function _renderCharList() {
    const container = document.getElementById('sm-char-list');
    if (!container) return;
    const q = (_state.charSearchText || '').toLowerCase().trim();
    if (_state.charType === 'card') {
      const cards = await SingleCard.getAll();
      cards.sort((a, b) => (b.updated || 0) - (a.updated || 0));
      const filtered = q ? cards.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.aliases || '').toLowerCase().includes(q)) : cards;
      if (filtered.length === 0) {
        container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px">${q ? '没有匹配的角色' : '没有角色，先去角色管理新建一张'}</div>`;
        return;
      }
      container.innerHTML = filtered.map(c => `
        <div onclick="SingleMode._selectChar('card','${c.id}','')" data-id="${c.id}" class="sm-char-item" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid ${_state.charId === c.id ? 'var(--accent)' : 'transparent'};background:${_state.charId === c.id ? 'rgba(196,168,124,0.1)' : 'var(--bg-tertiary)'}">
          <div style="width:36px;height:36px;border-radius:50%;flex-shrink:0;overflow:hidden;background:var(--bg);display:flex;align-items:center;justify-content:center">
            ${c.avatar ? `<img src="${Utils.escapeHtml(c.avatar)}" style="width:100%;height:100%;object-fit:cover">` : `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/></svg>`}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.name || '未命名')}</div>
            ${c.aliases ? `<div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.aliases)}</div>` : ''}
          </div>
        </div>
      `).join('');
    } else {
      // 遍历所有世界观，把所有NPC都列出来（不依赖当前选的世界观）
      const allWvs = await DB.getAll('worldviews');
      // 一次性拿所有头像
      const avatarsArr = await DB.getAll('npcAvatars');
      const avatarMap = {};
      avatarsArr.forEach(a => { avatarMap[a.id] = a.avatar; });
      const npcs = [];
      allWvs.forEach(wv => {
        if (wv.id === '__default_wv__') return;
        if (wv._hidden) return;
        // 全图 NPC
        (wv.globalNpcs || []).forEach(n => {
          npcs.push({ ...n, _wvId: wv.id, _wvName: wv.name || '未命名世界观', _faction: '全图常驻', _region: '全图', _avatar: avatarMap[n.id] || n.avatar || '' });
        });
        // 地区/势力 NPC
        (wv.regions || []).forEach(r => {
          (r.factions || []).forEach(f => {
            (f.npcs || []).forEach(n => {
              npcs.push({ ...n, _wvId: wv.id, _wvName: wv.name || '未命名世界观', _faction: f.name, _region: r.name, _avatar: avatarMap[n.id] || n.avatar || '' });
            });
          });
        });
      });
      const filtered = q ? npcs.filter(n =>
        (n.name || '').toLowerCase().includes(q) ||
        (n.aliases || '').toLowerCase().includes(q) ||
        (n._wvName || '').toLowerCase().includes(q) ||
        (n._region || '').toLowerCase().includes(q) ||
        (n._faction || '').toLowerCase().includes(q)) : npcs;
      if (filtered.length === 0) {
        container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px">${q ? '没有匹配的角色' : '所有世界观里都还没有角色'}</div>`;
        return;
      }
      container.innerHTML = filtered.map(n => `
        <div onclick="SingleMode._selectChar('npc','${n.id}','${n._wvId}')" data-id="${n.id}" class="sm-char-item" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid ${_state.charId === n.id ? 'var(--accent)' : 'transparent'};background:${_state.charId === n.id ? 'rgba(196,168,124,0.1)' : 'var(--bg-tertiary)'}">
          <div style="width:36px;height:36px;border-radius:50%;flex-shrink:0;overflow:hidden;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:14px">${n._avatar ? `<img src="${Utils.escapeHtml(n._avatar)}" style="width:100%;height:100%;object-fit:cover">` : Utils.escapeHtml((n.name || '?').slice(0, 1))}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(n.name || '未命名')}${n.aliases ? `<span style="color:var(--text-secondary);font-size:12px"> · ${Utils.escapeHtml(n.aliases)}</span>` : ''}</div>
            <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(n._wvName)} / ${Utils.escapeHtml(n._region)} / ${Utils.escapeHtml(n._faction)}</div>
          </div>
        </div>
      `).join('');
    }
  }

  function _selectChar(type, id, sourceWvId) {
    _state.charType = type;
    _state.charId = id;
    _state.charSourceWvId = sourceWvId || '';
    _renderCharList();
    _updateCardExtRowVisibility();
  }

  function _onCharSearch(text) {
    _state.charSearchText = text;
    _renderCharList();
  }

  function _onWorldviewChange() {
    _updateWorldviewOptionsState();
    // NPC 列表不再依赖当前选的世界观，无需重新渲染
  }

  // ===== 创建/保存单人对话 =====
  async function confirmCreate() {
    const wvId = document.getElementById('sm-worldview-select').value;
    const charType = _state.charType;
    const charId = _state.charId;
    if (!charId) {
      UI.showToast('请选一个角色');
      return;
    }
    const enableDetail = document.getElementById('sm-enable-detail').checked;
    const enableNpc = document.getElementById('sm-enable-npc').checked;
    const enableStartPlot = document.getElementById('sm-enable-startplot').checked;
    // v599：扩展设定合并为单一总开关，三个细分字段一起 toggle 保持向后兼容
    const enableExtended = document.getElementById('sm-enable-extended').checked;
    const enableFestival = enableExtended;
    const enableCustom = enableExtended;
    const enableKnowledge = enableExtended;
    // 单人卡扩展设定开关（仅在选了单人卡时有意义；其他情况默认 true 不影响）
    const cardExtEl = document.getElementById('sm-enable-card-extended');
    const enableCardExtended = cardExtEl ? cardExtEl.checked : true;

    // 取角色名作为默认对话名
    let charName = '';
    if (charType === 'card') {
      const c = await SingleCard.get(charId);
      charName = c?.name || '角色';
    } else {
      // NPC：从来源世界观找
      const sourceWvId = _state.charSourceWvId;
      if (sourceWvId) {
        const wv = await DB.get('worldviews', sourceWvId);
        let found = null;
        (wv?.regions || []).forEach(r => {
          (r.factions || []).forEach(f => {
            (f.npcs || []).forEach(n => { if (n.id === charId) found = n; });
          });
        });
        charName = found?.name || '角色';
      } else {
        charName = '角色';
      }
    }

    if (_editingConvId) {
      // 编辑模式：更新现有对话
      const conv = Conversations.getList().find(c => c.id === _editingConvId);
      if (conv) {
        conv.singleWorldviewId = wvId || '';
        conv.singleCharType = charType;
        conv.singleCharId = charId;
        conv.singleCharSourceWvId = _state.charSourceWvId || '';
        conv.singleEnableDetail = enableDetail;
        conv.singleEnableNpc = enableNpc;
        conv.singleEnableStartPlot = enableStartPlot;
        conv.singleEnableFestival = enableFestival;
        conv.singleEnableCustom = enableCustom;
      conv.singleEnableKnowledge = enableKnowledge;
        conv.singleEnableCardExtended = enableCardExtended;
        // 同步对话归属世界观（裸跑→默认世界观）
        const newWv = wvId || '__default_wv__';
        const oldWv = conv.worldviewId;
        conv.worldviewId = newWv;
        await Conversations.saveList();
        // 如果归属世界观变了，需要切到新世界观
        if (oldWv !== newWv) {
          try { await Worldview.selectWorldview(newWv); } catch(e) {}
        }
      }
      closeCreateModal();
      try { Conversations.invalidateAvatarCache(_editingConvId); } catch(e) {}
      try { Conversations.renderList && Conversations.renderList(); } catch(e) {}
      try { Conversations.refreshTopbar && await Conversations.refreshTopbar(); } catch(e) {}
      try { Chat.refreshAiAvatar && await Chat.refreshAiAvatar(); } catch(e) {}
      UI.showToast('已保存');
      return;
    }

    // 新建模式
    const convId = 'conv_' + Utils.uuid().slice(0, 8);
    const conv = {
      id: convId,
      name: '与 ' + charName,
      created: Date.now(),
      folder: null,
      // 挂世界观→该世界观；裸跑→默认世界观（容纳所有未分类对话）
      worldviewId: wvId || '__default_wv__',
      presetId: Settings.getCurrentId(),
      isSingle: true,
      singleWorldviewId: wvId || '',
      singleCharType: charType,
      singleCharId: charId,
      singleCharSourceWvId: _state.charSourceWvId || '',
      singleEnableDetail: enableDetail,
      singleEnableNpc: enableNpc,
      singleEnableStartPlot: enableStartPlot,
      singleEnableFestival: enableFestival,
      singleEnableCustom: enableCustom,
      singleEnableKnowledge: enableKnowledge,
      singleEnableCardExtended: enableCardExtended
    };
    Conversations.getList().push(conv);
    await Conversations.saveList();
    closeCreateModal();
    await Conversations.switchTo(convId);
  }

  // 获取当前对话的单人模式设定（chat.js 注入时调用）
  function getCurrentSingleSettings() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv || !conv.isSingle) return null;
    return {
      worldviewId: conv.singleWorldviewId || '',
      charType: conv.singleCharType || 'card',
      charId: conv.singleCharId || '',
      charSourceWvId: conv.singleCharSourceWvId || '',
      enableDetail: !!conv.singleEnableDetail,
      enableNpc: !!conv.singleEnableNpc,
      enableStartPlot: !!conv.singleEnableStartPlot,
      enableFestival: !!conv.singleEnableFestival,
      enableCustom: !!conv.singleEnableCustom,
      enableKnowledge: !!conv.singleEnableKnowledge,
      enableCardExtended: conv.singleEnableCardExtended !== false
    };
  }

  // 根据设定取出 AI 扮演角色的资料文本（chat.js 调用）
  async function getMainCharPrompt(settings) {
    if (!settings || !settings.charId) return '';
    if (settings.charType === 'card') {
      const c = await SingleCard.get(settings.charId);
      if (!c) return '';
      let text = `【AI 扮演角色】
在本对话中，你扮演"{{char}}"，用户扮演"{{user}}"。
请严格扮演"{{char}}"，确保你的回答始终符合设定。
你应该：
1. 将这些设定自然地融入到对话中，不要直接重复或提及这些设定内容。
2. 描写"{{char}}"时使用第三人称（"他/她/Ta" 或名字）；称呼"{{user}}"时使用第二人称"你"或玩家姓名，让玩家保有代入感。
3. 如果世界观中存在其他角色，允许Ta们作为路人/NPC登场推动剧情。
4. 如果{{user}}和{{char}}不在同一场景，请保持跟随{{user}}的视角，而非一味描写{{char}}。如有必要可以双线进行，但优先回应{{user}}对环境的互动，再考虑提及{{char}}的状态。
5. 当你看到带【】框起来 + OOC 标记的系统注入信息（例如【玩家手机操作记录｜OOC】），请理解这些是"系统旁白"，主体是"{{user}}"（玩家本人），不是你扮演的{{char}}。

姓名：${c.name}`;
      if (c.aliases) text += `\n别称/代号：${c.aliases}`;
      if (c.detail) text += `\n\n${c.detail}`;
      return text;
    }
    // NPC：从 charSourceWvId 找（如果没存就 fallback 到 worldviewId）
    const wvId = settings.charSourceWvId || settings.worldviewId;
    try { GameLog.log('info', `[Single] NPC charId=${settings.charId} sourceWv=${settings.charSourceWvId} wvId=${settings.worldviewId} 用=${wvId}`); } catch(e) {}
    if (!wvId) return '';
    const wv = await DB.get('worldviews', wvId);
    if (!wv) {
      try { GameLog.log('warn', `[Single] 找不到世界观 ${wvId}`); } catch(e) {}
      return '';
    }
    let found = null, foundFaction = '', foundRegion = '';
    (wv.regions || []).forEach(r => {
      (r.factions || []).forEach(f => {
        (f.npcs || []).forEach(n => {
          if (n.id === settings.charId) { found = n; foundFaction = f.name; foundRegion = r.name; }
        });
      });
    });
    if (!found) {
      try { GameLog.log('warn', `[Single] 在世界观 ${wv.name} 里找不到 NPC ${settings.charId}`); } catch(e) {}
      return '';
    }
    let text = `【AI 扮演角色】
在本对话中，你扮演"{{char}}"，用户扮演"{{user}}"。
请严格扮演"{{char}}"，确保你的回答始终符合设定。
你应该：
1. 将这些设定自然地融入到对话中，不要直接重复或提及这些设定内容。
2. 描写"{{char}}"时使用第三人称（"他/她/Ta" 或名字）；称呼"{{user}}"时使用第二人称"你"或玩家姓名，让玩家保有代入感。
3. 如果世界观中存在其他角色，允许Ta们作为路人/NPC登场推动剧情。
4. 如果{{user}}和{{char}}不在同一场景，请保持跟随{{user}}的视角，而非一味描写{{char}}。如有必要可以双线进行，但优先回应{{user}}对环境的互动，再考虑提及{{char}}的状态。
5. 当你看到带【】框起来 + OOC 标记的系统注入信息（例如【玩家手机操作记录｜OOC】），请理解这些是"系统旁白"，主体是"{{user}}"（玩家本人），不是你扮演的{{char}}。

姓名：${found.name}`;
    if (found.aliases) text += `\n别称：${found.aliases}`;
    if (foundRegion) text += `\n所在地区：${foundRegion}`;
    if (foundFaction) text += `\n所属势力：${foundFaction}`;
    if (found.summary) text += `\n简介：${found.summary}`;
    if (found.detail) text += `\n\n${found.detail}`;
    return text;
  }

  return {
    openModeSelect, closeModeSelect, pickGroup, pickSingle,
    openCreateModal, closeCreateModal, confirmCreate,
    _switchCharTab, _selectChar, _onCharSearch, _onWorldviewChange,
    _toggleWorldviewDropdown, _pickWorldview,
    getCurrentSingleSettings, getMainCharPrompt,
    updateMenuVisibility() {
      const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
      const btn = document.getElementById('single-settings-menu-btn');
      if (btn) {
        btn.style.display = (conv && conv.isSingle) ? 'flex' : 'none';
      }
    }
  };
})();