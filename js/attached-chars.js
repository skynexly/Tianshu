// 对话级挂载角色：群像/单人均可挂载常驻角色，AI 随时可用
// 数据字段：conversation.attachedChars = [{ type: 'card'|'npc', id, sourceWvId? }]
window.AttachedChars = (function() {
  'use strict';

  // ===== 数据访问 =====
  function _getCurrentConv() {
    const id = Conversations.getCurrent();
    return Conversations.getList().find(c => c.id === id) || null;
  }

  async function _saveConv(conv) {
    await DB.put('conversations', conv);
  }

  function getList() {
    const conv = _getCurrentConv();
    return (conv && conv.attachedChars) || [];
  }

  async function add(entry) {
    const conv = _getCurrentConv();
    if (!conv) return;
    if (!conv.attachedChars) conv.attachedChars = [];
    // 去重
    const key = entry.type + ':' + entry.id;
    if (conv.attachedChars.some(e => (e.type + ':' + e.id) === key)) return;
    conv.attachedChars.push(entry);
    await _saveConv(conv);
  }

  async function remove(type, id) {
    const conv = _getCurrentConv();
    if (!conv || !conv.attachedChars) return;
    const key = type + ':' + id;
    conv.attachedChars = conv.attachedChars.filter(e => (e.type + ':' + e.id) !== key);
    await _saveConv(conv);
  }

  // ===== 解析：返回每个挂载角色的完整信息 =====
  async function resolveAll() {
    const list = getList();
    const out = [];
    for (const e of list) {
      try {
        if (e.type === 'card') {
          const card = await SingleCard.get(e.id);
          if (!card) continue;
          out.push({
            type: 'card',
            id: e.id,
            name: card.name || '未命名',
            avatar: card.avatar || '',
            detail: card.detail || '',
          });
        } else if (e.type === 'npc') {
          const wvId = e.sourceWvId;
          if (!wvId) continue;
          const wv = await DB.get('worldviews', wvId);
          if (!wv) continue;
          let npc = null;
          // 先找全图 NPC
          for (const n of (wv.globalNpcs || [])) {
            if (n.id === e.id) { npc = n; break; }
          }
          // 再找地区/势力 NPC
          if (!npc) {
            outer: for (const r of (wv.regions || [])) {
              for (const f of (r.factions || [])) {
                for (const n of (f.npcs || [])) {
                  if (n.id === e.id) { npc = n; break outer; }
                }
              }
            }
          }
          if (!npc) continue;
          out.push({
            type: 'npc',
            id: e.id,
            name: npc.name || '未命名',
            avatar: npc.avatar || '',
            detail: npc.detail || '',
            aliases: npc.aliases || '',
          });
        }
      } catch(_) {}
    }
    return out;
  }

  // ===== Prompt 注入 =====
  async function buildPrompt() {
    const resolved = await resolveAll();
    if (resolved.length === 0) return '';
    const parts = resolved.map(c => {
      const head = c.aliases ? `${c.name}（${c.aliases}）` : c.name;
      return `---\n${head}\n${c.detail}`;
    });
    return '【挂载角色（常驻）】\n以下角色在本对话中常驻出现，不受地区限制。请根据场景需要自然引入，不必强行让所有角色都登场。\n\n' + parts.join('\n\n');
  }

  // ===== UI：Modal =====
  let _activeTab = 'list';  // 'list' | 'addCard' | 'addNpc'

  async function openModal() {
    _activeTab = 'list';
    let modal = document.getElementById('attached-chars-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'attached-chars-modal';
      modal.className = 'modal hidden';
      modal.innerHTML = `
        <div class="modal-content" style="max-width:560px;max-height:85vh;display:flex;flex-direction:column;padding:0">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px 12px;border-bottom:1px solid var(--border);flex-shrink:0">
            <h3 style="margin:0;font-size:16px">添加角色</h3>
            <button onclick="AttachedChars.closeModal()" class="btn-icon modal-corner-btn close-btn" title="关闭">×</button>
          </div>
          <div id="attached-chars-tabs" style="display:flex;gap:0;padding:0 12px;border-bottom:1px solid var(--border);flex-shrink:0;white-space:nowrap;overflow-x:auto"></div>
          <div id="attached-chars-body" style="flex:1;overflow-y:auto;padding:14px 16px"></div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.classList.add('active');
    await _render();
  }

  function closeModal() {
    const modal = document.getElementById('attached-chars-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('active');
    }
  }

  async function _render() {
    await _renderTabs();
    await _renderBody();
  }

  async function _renderTabs() {
    const conv = _getCurrentConv();
    const isSingle = conv && conv.isSingle;
    const tabsEl = document.getElementById('attached-chars-tabs');
    if (!tabsEl) return;
    const mkTab = (key, label) => `
      <button onclick="AttachedChars._switchTab('${key}')"
        style="padding:10px 14px;background:none;border:none;border-bottom:2px solid ${_activeTab === key ? 'var(--accent)' : 'transparent'};color:${_activeTab === key ? 'var(--accent)' : 'var(--text-secondary)'};font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">${label}</button>
    `;
    let html = mkTab('list', '已挂载') + mkTab('addCard', '添加角色');
if (isSingle) html += mkTab('addNpc', '添加世界观角色');
    tabsEl.innerHTML = html;
  }

  async function _switchTab(tab) {
    _activeTab = tab;
    await _render();
  }

  async function _renderBody() {
    const body = document.getElementById('attached-chars-body');
    if (!body) return;
    if (_activeTab === 'list') {
      body.innerHTML = await _renderListHtml();
    } else if (_activeTab === 'addCard') {
      body.innerHTML = await _renderAddCardHtml();
    } else if (_activeTab === 'addNpc') {
      body.innerHTML = await _renderAddNpcHtml();
    }
  }

  async function _renderListHtml() {
    const resolved = await resolveAll();
    if (resolved.length === 0) {
      return `<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0">还没有挂载任何角色<br><span style="font-size:11px;opacity:.7">点击上方「添加角色」添加</span></div>`;
    }
    return resolved.map(c => {
      const avatar = c.avatar
        ? `<img src="${Utils.escapeHtml(c.avatar)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0">`
        : `<div style="width:36px;height:36px;border-radius:50%;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0;font-size:14px">${Utils.escapeHtml((c.name||'?')[0])}</div>`;
      const tag = c.type === 'card' ? '角色' : '世界观角色';
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-tertiary);border-radius:8px;margin-bottom:8px">
        ${avatar}
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.name)}</div>
          <div style="font-size:11px;color:var(--text-secondary)">${tag}</div>
        </div>
        <button onclick="AttachedChars._onRemove('${c.type}','${c.id}')" style="padding:6px 10px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);font-size:12px;cursor:pointer;font-family:inherit">移除</button>
      </div>`;
    }).join('');
  }

  async function _renderAddCardHtml() {
    const cards = await SingleCard.getAll();
    if (!cards || cards.length === 0) {
      return `<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0">还没有创建任何角色<br><span style="font-size:11px;opacity:.7">去世界 → 角色管理 创建</span></div>`;
    }
    const attachedKeys = new Set(getList().map(e => e.type + ':' + e.id));
    cards.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    return cards.map(card => {
      const key = 'card:' + card.id;
      const attached = attachedKeys.has(key);
      const avatar = card.avatar
        ? `<img src="${Utils.escapeHtml(card.avatar)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0">`
        : `<div style="width:36px;height:36px;border-radius:50%;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0;font-size:14px">${Utils.escapeHtml((card.name||'?')[0])}</div>`;
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-tertiary);border-radius:8px;margin-bottom:8px;${attached ? 'opacity:.55' : ''}">
        ${avatar}
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(card.name || '未命名')}</div>
          <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml((card.detail || '').slice(0, 50))}</div>
        </div>
        ${attached
          ? `<span style="font-size:11px;color:var(--text-secondary);padding:6px 10px">已挂载</span>`
          : `<button onclick="AttachedChars._onAddCard('${card.id}')" style="padding:6px 10px;background:var(--accent);border:none;border-radius:6px;color:var(--bg);font-size:12px;cursor:pointer;font-family:inherit">添加</button>`}
      </div>`;
    }).join('');
  }

  async function _renderAddNpcHtml() {
    const conv = _getCurrentConv();
    if (!conv || !conv.isSingle) {
      return `<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0">群像模式只能挂载角色</div>`;
    }
    const wvId = conv.singleWorldviewId;
    if (!wvId) {
      return `<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0">当前对话没有挂世界观</div>`;
    }
    const wv = await DB.get('worldviews', wvId);
    if (!wv) {
      return `<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0">世界观数据未找到</div>`;
    }
    // 收集所有 NPC
    const allNpcs = [];
    // 全图 NPC
    for (const n of (wv.globalNpcs || [])) {
      allNpcs.push({ npc: n, regionName: '全图', factionName: '常驻' });
    }
    // 地区 NPC
    for (const r of (wv.regions || [])) {
      for (const f of (r.factions || [])) {
        for (const n of (f.npcs || [])) {
          allNpcs.push({ npc: n, regionName: r.name, factionName: f.name });
        }
      }
    }
    if (allNpcs.length === 0) {
      return `<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0">该世界观下没有角色</div>`;
    }
    const attachedKeys = new Set(getList().map(e => e.type + ':' + e.id));
    return allNpcs.map(({ npc, regionName, factionName }) => {
      const key = 'npc:' + npc.id;
      const attached = attachedKeys.has(key);
      const avatar = npc.avatar
        ? `<img src="${Utils.escapeHtml(npc.avatar)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0">`
        : `<div style="width:36px;height:36px;border-radius:50%;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0;font-size:14px">${Utils.escapeHtml((npc.name||'?')[0])}</div>`;
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-tertiary);border-radius:8px;margin-bottom:8px;${attached ? 'opacity:.55' : ''}">
        ${avatar}
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(npc.name || '未命名')}${npc.aliases ? `<span style="color:var(--text-secondary);font-size:11px;margin-left:6px">${Utils.escapeHtml(npc.aliases)}</span>` : ''}</div>
          <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(regionName)} · ${Utils.escapeHtml(factionName)}</div>
        </div>
        ${attached
          ? `<span style="font-size:11px;color:var(--text-secondary);padding:6px 10px">已挂载</span>`
          : `<button onclick="AttachedChars._onAddNpc('${npc.id}','${wvId}')" style="padding:6px 10px;background:var(--accent);border:none;border-radius:6px;color:var(--bg);font-size:12px;cursor:pointer;font-family:inherit">添加</button>`}
      </div>`;
    }).join('');
  }

  // ===== 事件处理 =====
  async function _onAddCard(cardId) {
    await add({ type: 'card', id: cardId });
    UI.showToast('已添加', 1500);
    await _render();
  }

  async function _onAddNpc(npcId, wvId) {
    await add({ type: 'npc', id: npcId, sourceWvId: wvId });
    UI.showToast('已添加', 1500);
    await _render();
  }

  async function _onRemove(type, id) {
    await remove(type, id);
    UI.showToast('已移除', 1500);
    await _render();
  }

  return {
    getList, add, remove, resolveAll, buildPrompt,
    openModal, closeModal,
    _switchTab, _onAddCard, _onAddNpc, _onRemove,
  };
})();