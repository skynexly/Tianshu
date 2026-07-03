/**
 * 世界书 UI 层 — 列表渲染、新建、删除、绑定选择器。
 * 编辑走 Worldview.openEdit('lb:' + id)，复用世界观编辑器的 special tab。
 */
const LorebookUI = (() => {

  // ========== 列表渲染 ==========
  async function renderList(filterText) {
    const container = document.getElementById('lorebook-list');
    if (!container) return;
    const list = await Lorebook.getAll();
    list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const q = (filterText || '').trim().toLowerCase();
    const filtered = q
      ? list.filter(lb =>
          (lb.name || '').toLowerCase().includes(q) ||
          (lb.description || '').toLowerCase().includes(q))
      : list;
    if (filtered.length === 0) {
      container.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:40px 20px;font-size:13px">${q ? '没有匹配的世界书' : '还没有世界书，点右上「新建」开始'}</div>`;
      return;
    }
    // 并发获取每本的引用计数
    const items = await Promise.all(filtered.map(async lb => {
      const ref = await Lorebook.getRefCount(lb.id);
      return { lb, ref };
    }));
    container.innerHTML = items.map(({ lb, ref }) => {
      const fc = lb.festivals?.length || 0;
      const kc = lb.knowledges?.length || 0;
      const nc = lb.globalNpcs?.length || 0;
      const total = fc + kc + nc;
      const refText = ref.total > 0
        ? `<span style="color:var(--accent)">已挂载 ${ref.total}</span>`
        : `<span style="color:var(--text-secondary)">未挂载</span>`;
      const safeId = Utils.escapeHtml(lb.id);
      const safeName = Utils.escapeHtml(lb.name || '未命名');
      const safeDesc = Utils.escapeHtml(lb.description || '');
      return `
        <div class="lorebook-card" data-id="${safeId}" style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:14px 16px;cursor:pointer" onclick="LorebookUI.openEdit('${safeId}')">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
            <div style="font-size:15px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${safeName}</div>
            <button type="button" onclick="event.stopPropagation();LorebookUI.editNameDesc('${safeId}')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px;display:flex;align-items:center" title="编辑名字和描述">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            </button>
            <button type="button" onclick="event.stopPropagation();LorebookUI.confirmDelete('${safeId}')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px;display:flex;align-items:center" title="删除">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
          ${safeDesc ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${safeDesc}</div>` : ''}
          <div style="display:flex;gap:8px;align-items:center;font-size:11px;color:var(--text-secondary)">
            <span>条目 ${total}</span>
            <span style="opacity:0.5">·</span>
            <span>节日 ${fc}</span>
            <span>常驻/动态 ${kc}</span>
            <span>NPC ${nc}</span>
            <span style="margin-left:auto">${refText}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // ========== 新建 ==========
  async function createNew() {
    const name = await UI.showSimpleInput('新建世界书', '', { placeholder: '给世界书起个名字' });
    if (name === null || name === undefined) return;
    const lb = {
      name: (name || '').trim() || '未命名世界书',
      description: '',
      festivals: [],
      knowledges: [],
      events: [],
      globalNpcs: [],
    };
    const id = await Lorebook.save(lb);
    await renderList();
    // 直接打开编辑
    openEdit(id);
  }

  // ========== 编辑（走 Worldview.openEdit 的 lb 模式）==========
  function openEdit(lbId) {
    if (typeof Worldview === 'undefined' || !Worldview.openEdit) return;
    Worldview.openEdit('lb:' + lbId, { returnTo: 'lorebook-list' });
  }

  // ========== 编辑名字和描述（合并弹窗）==========
  async function editNameDesc(lbId) {
    const lb = await Lorebook.get(lbId);
    if (!lb) return;
    const res = await UI.showNameDescInput('编辑世界书', {
      name: lb.name || '',
      description: lb.description || '',
      namePlaceholder: '给世界书起个名字',
      descPlaceholder: '简单介绍一下这本世界书...',
    });
    if (!res) return;
    lb.name = res.name;
    lb.description = res.description;
    await Lorebook.save(lb);
    UI.showToast('已保存');
    await renderList();
  }

  // ========== 删除 ==========
  async function confirmDelete(lbId) {
    const lb = await Lorebook.get(lbId);
    if (!lb) return;
    const ref = await Lorebook.getRefCount(lbId);
    let msg = `确定删除世界书「${lb.name || '未命名'}」吗？此操作不可恢复。`;
    if (ref.total > 0) {
      const parts = [];
      if (ref.cards) parts.push(`${ref.cards} 张角色卡`);
      if (ref.wvs) parts.push(`${ref.wvs} 个世界观`);
      if (ref.convs) parts.push(`${ref.convs} 个对话`);
      msg += `\n\n当前被 ${parts.join(' / ')} 挂载，删除后会自动解绑。`;
    }
    const ok = await UI.showConfirm('删除世界书', msg);
    if (!ok) return;
    await Lorebook.remove(lbId);
    UI.showToast('已删除');
    await renderList();
  }

  // ========== 卡片/世界观/对话用的绑定选择器（多选弹窗）==========
  // 传入当前已绑 ids、回调（接收新的 ids 数组）
  async function openBindPicker(currentIds, onChange) {
    const all = await Lorebook.getAll();
    if (all.length === 0) {
      UI.showToast('请先到「世界 → 世界书管理」新建一本', 2500);
      return;
    }
    all.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const set = new Set(currentIds || []);
    const html = `
      <div style="max-height:50vh;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin:8px 0">
        ${all.map(lb => {
          const checked = set.has(lb.id);
          const safeId = Utils.escapeHtml(lb.id);
          const safeName = Utils.escapeHtml(lb.name || '未命名');
          const fc = lb.festivals?.length || 0;
          const kc = lb.knowledges?.length || 0;
          const nc = lb.globalNpcs?.length || 0;
          return `
            <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;cursor:pointer">
              <span style="position:relative;display:inline-flex;flex-shrink:0">
                <input type="checkbox" class="circle-check" data-lb-id="${safeId}" ${checked ? 'checked' : ''}>
                <span class="circle-check-ui"></span>
              </span>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeName}</div>
                <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">节日 ${fc} · 常驻/动态 ${kc} · NPC ${nc}</div>
              </div>
            </label>
          `;
        }).join('')}
      </div>
      <div style="font-size:11px;color:var(--text-secondary);line-height:1.6">勾选要绑定的世界书。多本之间按勾选顺序注入。</div>
    `;
    // 用项目自带 modal 容器，直接拼一个出来
    let modal = document.getElementById('lb-bind-modal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'lb-bind-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:480px">
        <h3>选择世界书</h3>
        ${html}
        <div class="modal-actions" style="margin-top:12px">
          <button type="button" data-act="cancel" style="flex:1;background:none;border:1px solid var(--border);color:var(--text-secondary)">取消</button>
          <button type="button" data-act="ok" style="flex:1;background:var(--accent);color:#111;border:none">确定</button>
        </div>
      </div>
    `;
    // 兼容华为 webview：如果当前在某个 overlay 内，挂到它里面
    document.body.appendChild(modal);
    return new Promise(resolve => {
      const close = () => { modal.remove(); resolve(); };
      modal.querySelector('[data-act="cancel"]').onclick = close;
      modal.addEventListener('click', e => { if (e.target === modal) close(); });
      modal.querySelector('[data-act="ok"]').onclick = () => {
        const checked = Array.from(modal.querySelectorAll('input[type=checkbox]:checked')).map(c => c.dataset.lbId);
        try { onChange && onChange(checked); } catch(_) {}
        close();
      };
    });
  }

  // 简洁版的"已绑定列表"渲染（给单人卡 extended tab 用）
  async function renderBoundList(containerEl, ids, onChange) {
    if (!containerEl) return;
    const all = await Lorebook.getAll();
    const map = {};
    all.forEach(lb => { map[lb.id] = lb; });
    const list = (ids || []).map(id => map[id]).filter(Boolean);
    if (list.length === 0) {
      containerEl.innerHTML = `<div style="font-size:12px;color:var(--text-secondary);text-align:center;padding:18px 12px;background:var(--bg-tertiary);border:1px dashed var(--border);border-radius:8px">还没有绑定世界书</div>`;
      return;
    }
    containerEl.innerHTML = list.map(lb => {
      const safeId = Utils.escapeHtml(lb.id);
      const safeName = Utils.escapeHtml(lb.name || '未命名');
      const fc = lb.festivals?.length || 0;
      const kc = lb.knowledges?.length || 0;
      const nc = lb.globalNpcs?.length || 0;
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeName}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">节日 ${fc} · 常驻/动态 ${kc} · NPC ${nc}</div>
          </div>
          <button type="button" data-unbind-lb="${safeId}" style="background:none;border:1px solid var(--border);color:var(--text-secondary);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px">解绑</button>
        </div>
      `;
    }).join('');
    containerEl.querySelectorAll('[data-unbind-lb]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.unbindLb;
        const next = (ids || []).filter(x => x !== id);
        try { onChange && onChange(next); } catch(_) {}
      };
    });
  }

  return {
    renderList,
    createNew,
    openEdit,
    editNameDesc,
    confirmDelete,
    openBindPicker,
    renderBoundList,
  };
})();