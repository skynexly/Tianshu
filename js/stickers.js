/**
 * 表情包模块 — 全局共享表情库
 * 数据：DB.stickers store，每条 { id, name, dataUrl, createdAt }
 * 用途：手机聊天（私聊/群聊）通用发送；管理界面在侧边栏设置。
 */
const Stickers = (() => {
  // 内存缓存：id -> {id, name, dataUrl, category, createdAt}
  let _cache = null;
  // 管理界面当前的分类筛选：null=全部, ''=未分类, 其它=具体类别名
  let _filterCat = null;
  // 批量管理模式
  let _manageMode = false;
  let _selectedIds = new Set();
  // 名字搜索关键词
  let _searchQuery = '';

  // 把选中的图片压成表情尺寸（保留透明通道，用 png）
  function _compressToSticker(dataUrl, maxSide = 240) {
    // 通用图片弹窗在 CORS 下载失败时可能返回原始远程 URL；远程 URL 不能安全上 canvas，直通保存。
    if (!/^data:image\//i.test(dataUrl || '')) return Promise.resolve(dataUrl);
    return new Promise(resolve => {
      try {
        const img = new Image();
        img.onload = () => {
          try {
            let w = img.width, h = img.height;
            const scale = Math.min(1, maxSide / w, maxSide / h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/png'));
          } catch (_) {
            resolve(dataUrl);
          }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      } catch (_) { resolve(dataUrl); }
    });
  }

  // 读取所有表情（带缓存），按 createdAt 升序
  async function list() {
    if (_cache) return _cache.slice();
    try {
      const all = await DB.getAll('stickers');
      _cache = (all || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    } catch (_) { _cache = []; }
    return _cache.slice();
  }

  // 按 id 取单个表情
  async function get(id) {
    if (!id) return null;
    if (_cache) return _cache.find(s => s.id === id) || null;
    try { return await DB.get('stickers', id); } catch (_) { return null; }
  }

  // 新增表情：name + dataUrl（dataUrl 已经是选好的图）+ 可选 category（分类名，空=未分类）
  async function add(name, dataUrl, category) {
    const nm = String(name || '').trim();
    if (!nm) throw new Error('表情名字不能为空');
    if (!dataUrl) throw new Error('没有图片');
    const compressed = await _compressToSticker(dataUrl);
    const item = { id: 'stk_' + Utils.uuid().slice(0, 10), name: nm, dataUrl: compressed, category: String(category || '').trim(), createdAt: Date.now() };
    await DB.put('stickers', item);
    _cache = null; // 失效缓存
    return item;
  }

  // 删除表情
  async function remove(id) {
    if (!id) return;
    await DB.del('stickers', id);
    _cache = null;
  }

  // 重命名
  async function rename(id, newName) {
    const nm = String(newName || '').trim();
    if (!nm) throw new Error('名字不能为空');
    const item = await DB.get('stickers', id);
    if (!item) return;
    item.name = nm;
    await DB.put('stickers', item);
    _cache = null;
  }

  // ===== 分类管理（类别列表存 localStorage，不纳入整包导出）=====
  const _CAT_KEY = 'stickers_categories';

  function getCategories() {
    try {
      const raw = localStorage.getItem(_CAT_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(c => typeof c === 'string' && c.trim()) : [];
    } catch (_) { return []; }
  }
  function _saveCategories(arr) {
    try { localStorage.setItem(_CAT_KEY, JSON.stringify(arr)); } catch (_) {}
  }
  // 新增类别，返回规范化后的名字（已存在则直接返回）；空名返回 null
  function addCategory(name) {
    const nm = String(name || '').trim();
    if (!nm) return null;
    const arr = getCategories();
    if (!arr.includes(nm)) { arr.push(nm); _saveCategories(arr); }
    return nm;
  }
  // 删除类别：从列表移除，并把该类下所有表情归为未分类
  async function removeCategory(name) {
    const nm = String(name || '').trim();
    if (!nm) return;
    _saveCategories(getCategories().filter(c => c !== nm));
    // 同步范围里也移除该类（未设置过则不动，仍是「全部」语义）
    const sc = getSyncCats();
    if (sc !== null && sc.includes(nm)) _saveSyncCats(sc.filter(c => c !== nm));
    try {
      const all = await DB.getAll('stickers');
      for (const s of (all || [])) {
        if ((s.category || '') === nm) { s.category = ''; await DB.put('stickers', s); }
      }
    } catch (_) {}
    _cache = null;
  }
  // 重命名类别：改列表里的名字，并迁移该类下所有表情的 category
  async function renameCategory(oldName, newName) {
    const on = String(oldName || '').trim();
    const nn = String(newName || '').trim();
    if (!on || !nn || on === nn) return;
    const arr = getCategories();
    const i = arr.indexOf(on);
    if (i >= 0) arr[i] = nn; else arr.push(nn);
    _saveCategories(arr);
    // 同步范围里的旧名字跟着改
    const sc = getSyncCats();
    if (sc !== null && sc.includes(on)) _saveSyncCats(sc.map(c => c === on ? nn : c));
    try {
      const all = await DB.getAll('stickers');
      for (const s of (all || [])) {
        if ((s.category || '') === on) { s.category = nn; await DB.put('stickers', s); }
      }
    } catch (_) {}
    _cache = null;
  }
  // 修改单个表情的分类（cat 为空=归为未分类）
  async function setCategory(id, cat) {
    const item = await DB.get('stickers', id);
    if (!item) return;
    item.category = String(cat || '').trim();
    await DB.put('stickers', item);
    _cache = null;
  }

  // 名字输入弹窗（单字段，应用风格）。返回字符串或 null（取消）
  function _promptName(title, placeholder, initVal) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal';
      overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:100020';
      overlay.innerHTML = `
        <div class="modal-content" style="max-width:360px;width:calc(100% - 40px)">
          <h3 style="margin:0 0 14px">${_esc(title || '输入名字')}</h3>
          <input id="stk-name-input" type="text" placeholder="${_esc(placeholder || '')}" maxlength="20" style="width:100%;box-sizing:border-box;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;padding:9px 12px;outline:none">
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
            <button data-act="cancel" style="padding:8px 16px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit">取消</button>
            <button data-act="ok" style="padding:8px 16px;background:var(--accent);border:none;border-radius:8px;color:var(--bg);font-size:13px;cursor:pointer;font-family:inherit">确定</button>
          </div>
        </div>`;
      const inputEl = overlay.querySelector('#stk-name-input');
      inputEl.value = initVal || '';
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { close(null); return; }
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        if (b.dataset.act === 'cancel') { close(null); return; }
        if (b.dataset.act === 'ok') { close(inputEl.value.trim()); return; }
      });
      inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(inputEl.value.trim()); });
      document.body.appendChild(overlay);
      setTimeout(() => inputEl.focus(), 50);
    });
  }

  // 选分类弹窗：列出已有类别 + 不分类 + 新建。返回分类名（''=不分类）或 undefined（取消）
  function _promptCategory(title) {
    return new Promise(resolve => {
      const cats = getCategories();
      const overlay = document.createElement('div');
      overlay.className = 'modal';
      overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:100020';
      const catBtns = cats.map(c =>
        `<button data-cat="${_esc(c)}" style="padding:8px 14px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:999px;color:var(--text);font-size:13px;cursor:pointer;font-family:inherit">${_esc(c)}</button>`
      ).join('');
      overlay.innerHTML = `
        <div class="modal-content" style="max-width:360px;width:calc(100% - 40px);position:relative">
          <button data-act="cancel" aria-label="关闭" style="position:absolute;top:12px;right:12px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:none;border:none;border-radius:6px;color:var(--text-secondary);font-size:20px;line-height:1;cursor:pointer;font-family:inherit">×</button>
          <h3 style="margin:0 0 14px;padding-right:28px">${_esc(title || '选择分类')}</h3>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
            <button data-cat="" style="padding:8px 14px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:999px;color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit">不分类</button>
            ${catBtns}
          </div>
          <div style="display:flex;gap:8px">
            <input id="stk-newcat-input" type="text" placeholder="或输入新类别名" maxlength="12" style="flex:1;min-width:0;box-sizing:border-box;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;padding:9px 12px;outline:none">
            <button data-act="newcat" style="flex-shrink:0;padding:8px 16px;background:var(--accent);border:none;border-radius:8px;color:var(--bg);font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap">新建并选</button>
          </div>
        </div>`;
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { close(undefined); return; }
        const catBtn = e.target.closest('button[data-cat]');
        if (catBtn) { close(catBtn.getAttribute('data-cat')); return; }
        const actBtn = e.target.closest('button[data-act]');
        if (!actBtn) return;
        if (actBtn.dataset.act === 'cancel') { close(undefined); return; }
        if (actBtn.dataset.act === 'newcat') {
          const v = overlay.querySelector('#stk-newcat-input').value.trim();
          if (!v) { UI.showToast('请输入类别名', 1500); return; }
          const nm = addCategory(v);
          close(nm || '');
        }
      });
      document.body.appendChild(overlay);
    });
  }

  // 选图/URL → 压缩 → 弹名字输入 → 存库。走完刷新管理列表。
  async function pickAndAdd() {
    try {
      const dataUrl = (typeof Utils !== 'undefined' && Utils.promptImageInput)
        ? await Utils.promptImageInput({ maxSize: 240, outputFormat: 'png' })
        : null;
      if (!dataUrl) return;
      const name = await _promptName('给表情起个名字', '如：开心、无语、狗头', '');
      if (name === null) return; // 取消
      const nm = String(name || '').trim();
      if (!nm) { UI.showToast('名字不能为空', 1800); return; }
      const cat = await _promptCategory('选择分类（可跳过）');
      if (cat === undefined) return; // 取消
      await add(nm, dataUrl, cat);
      UI.showToast('表情已添加', 1500);
      renderList();
    } catch (e) {
      UI.showToast('添加失败：' + (e.message || e), 2000);
    }
  }

  function _fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function _nameFromFile(file, fallbackIndex) {
    const raw = String(file?.name || '').replace(/\.[^.]+$/, '').trim();
    const cleaned = raw
      .replace(/[\\/]/g, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return (cleaned || `表情${fallbackIndex}`).slice(0, 20);
  }

  function _uniqueName(base, used) {
    const root = String(base || '表情').trim().slice(0, 20) || '表情';
    if (!used.has(root)) { used.add(root); return root; }
    let n = 2;
    while (true) {
      const suffix = `(${n})`;
      const candidate = root.slice(0, Math.max(1, 20 - suffix.length)) + suffix;
      if (!used.has(candidate)) { used.add(candidate); return candidate; }
      n++;
    }
  }

  // 批量导入本地图片：多选 → 文件名自动命名 → 压缩 → 存库。
  async function pickBatchAndAdd() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []).filter(f => f && /^image\//i.test(f.type || ''));
      if (!files.length) return;
      if (files.length > 100) {
        const ok = await UI.showConfirm('批量导入', `一次选择了 ${files.length} 张图片，数量较多可能会占用较多本地存储空间。确定继续导入吗？`);
        if (!ok) return;
      }
      const cat = await _promptCategory('这批表情放入哪个分类（可跳过）');
      if (cat === undefined) return; // 取消
      let imported = 0;
      let failed = 0;
      try {
        UI.showToast(`开始导入 ${files.length} 个表情…`, 1600);
        const existing = await list();
        const used = new Set(existing.map(s => String(s.name || '').trim()).filter(Boolean));
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          try {
            const dataUrl = await _fileToDataUrl(file);
            const baseName = _nameFromFile(file, i + 1);
            const name = _uniqueName(baseName, used);
            await add(name, dataUrl, cat);
            imported++;
            if (files.length >= 10 && (imported % 5 === 0 || imported === files.length)) {
              UI.showToast(`正在导入 ${imported}/${files.length}`, 900);
            }
          } catch (e) {
            console.warn('[Stickers] 批量导入失败', file?.name, e);
            failed++;
          }
        }
        renderList();
        UI.showToast(failed ? `已导入 ${imported} 个，失败 ${failed} 个` : `已导入 ${imported} 个表情`, 2200);
      } catch (e) {
        UI.showToast('批量导入失败：' + (e.message || e), 2400);
      }
    };
    input.click();
  }

  // 批量 URL 导入：弹一个大文本框，用户把一堆图片 URL 粘进去（一行一条）→ 解析 → 逐条存库。
  // 每行支持「URL」或「URL 名字」；不写名字自动命名「表情N」，重名自动加序号。
  // 直接存 URL（不转 base64、不联网校验）：批量场景校验太慢且会被图床防盗链误杀，与酒馆行为一致。
  // 代价：这些表情依赖图床长期有效，图床挂掉/防盗链变严会裂图（弹窗已提示）。
  function pickBatchUrlAndAdd() {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:100020';
    overlay.innerHTML = `
      <div class="modal-content" style="max-width:420px;width:calc(100% - 40px)">
        <h3 style="margin:0 0 8px">批量 URL 导入</h3>
        <p style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin:0 0 12px">
          把表情清单粘进来，<span style="color:var(--accent)">一行一条</span>，格式 <span style="color:var(--accent)">名字:链接</span>（也兼容纯链接、或链接后加名字）。<br>
          <span style="color:var(--danger,#e55)">注意：URL 表情依赖图床长期有效，图床失效会裂图；想存久建议用「批量本地」。</span>
        </p>
        <textarea id="stk-url-input" rows="9" placeholder="吹泡泡:https://i.imglt.com/xxx.jpg&#10;拜拜:https://i.imglt.com/yyy.jpg&#10;早安:https://i.imglt.com/zzz.jpg" style="outline:none;width:100%;box-sizing:border-box;font-size:13px;line-height:1.6;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 12px;resize:vertical"></textarea>
        <div class="modal-actions" style="display:flex;gap:8px;margin-top:14px">
          <button data-act="cancel" style="flex:1;padding:9px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit">取消</button>
          <button data-act="ok" style="flex:1;padding:9px;background:var(--accent);border:none;border-radius:8px;color:var(--bg);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">导入</button>
        </div>
      </div>`;
    const close = () => overlay.remove();
    overlay.addEventListener('click', async (e) => {
      if (e.target === overlay) { close(); return; }
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'cancel') { close(); return; }
      if (b.dataset.act === 'ok') {
        const raw = overlay.querySelector('#stk-url-input').value || '';
        close();
        await _importUrls(raw);
      }
    });
    document.body.appendChild(overlay);
    setTimeout(() => overlay.querySelector('#stk-url-input')?.focus(), 50);
  }

  // 解析多行文本 → 逐条存库。智能识别两种常见写法：
  //   ①「名字:URL」或「名字：URL」（名字在前，冒号分隔，最常见的表情包清单格式）
  //   ②「URL」或「URL 名字」（纯链接，或链接后空格跟名字）
  // 统一策略：定位行内 http(s):// 的位置，之前是名字、从 http 起是 URL——不受冒号/空格分隔差异影响，
  // 也不会被 URL 里自带的「https:」冒号误伤。
  async function _importUrls(rawText) {
    const lines = String(rawText || '').split(/\r?\n/);
    const entries = [];
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      const um = s.match(/https?:\/\/\S+/i); // 行内第一个链接
      if (!um) continue; // 没链接的杂行跳过
      const url = um[0];
      // 名字 = 链接之前的部分，去掉尾部的分隔符（: ： 空格）；链接在最前则名字为空
      let name = s.slice(0, um.index).trim().replace(/[:：]\s*$/, '').trim();
      // 若名字为空、但链接后面还有文字（「URL 名字」写法），取链接后的部分当名字
      if (!name) {
        const after = s.slice(um.index + url.length).trim();
        if (after) name = after;
      }
      entries.push({ url, name });
    }
    if (!entries.length) { UI.showToast('没有解析到有效的图片链接', 2000); return; }
    if (entries.length > 100) {
      const ok = await UI.showConfirm('批量导入', `解析到 ${entries.length} 条链接，数量较多。确定继续导入吗？`);
      if (!ok) return;
    }
    const cat = await _promptCategory('这批表情放入哪个分类（可跳过）');
    if (cat === undefined) return; // 取消
    let imported = 0;
    let failed = 0;
    try {
      UI.showToast(`开始导入 ${entries.length} 个表情…`, 1600);
      const existing = await list();
      const used = new Set(existing.map(s => String(s.name || '').trim()).filter(Boolean));
      for (let i = 0; i < entries.length; i++) {
        const { url, name } = entries[i];
        try {
          const baseName = name || `表情${i + 1}`;
          const finalName = _uniqueName(baseName, used);
          await add(finalName, url, cat);
          imported++;
          if (entries.length >= 10 && (imported % 5 === 0 || imported === entries.length)) {
            UI.showToast(`正在导入 ${imported}/${entries.length}`, 900);
          }
        } catch (e) {
          console.warn('[Stickers] URL 批量导入失败', url, e);
          failed++;
        }
      }
      renderList();
      UI.showToast(failed ? `已导入 ${imported} 个，失败 ${failed} 个` : `已导入 ${imported} 个表情`, 2200);
    } catch (e) {
      UI.showToast('批量导入失败：' + (e.message || e), 2400);
    }
  }
  async function confirmRemove(id) {
    const item = await get(id);
    if (!item) return;
    const ok = await UI.showConfirm('删除表情', `确定删除表情「${item.name}」吗？已发送到聊天记录里的会显示为占位。`);
    if (!ok) return;
    await remove(id);
    UI.showToast('已删除', 1400);
    renderList();
  }

  // 渲染管理列表（设置 → 表情包管理）
  async function renderList() {
    // 回填「同步给角色」开关状态
    try {
      const sw = document.getElementById('stickers-sync-ai');
      if (sw) sw.checked = isSyncAI();
      const scopeEl = document.getElementById('stickers-sync-scope-label');
      if (scopeEl) scopeEl.textContent = _syncScopeLabel();
    } catch (_) {}
    _renderCatTabs();
    const wrap = document.getElementById('stickers-list');
    if (!wrap) return;
    let items = await list();
    // 按当前筛选过滤
    if (_filterCat === '') items = items.filter(s => !(s.category || '').trim());
    else if (_filterCat != null) items = items.filter(s => (s.category || '') === _filterCat);
    // 名字搜索
    if (_searchQuery) items = items.filter(s => (s.name || '').toLowerCase().includes(_searchQuery));

    if (!items.length) {
      const tip = _searchQuery ? `没有名字含「${_esc(_searchQuery)}」的表情`
        : (_filterCat == null ? '还没有表情，点上面的按钮添加'
        : (_filterCat === '' ? '「未分类」里还没有表情' : `「${_esc(_filterCat)}」分类下还没有表情`));
      wrap.innerHTML = `<div style="grid-column:1/-1;color:var(--text-secondary);font-size:13px;text-align:center;padding:24px 0">${tip}</div>`;
      _updateSelectAllIcon();
      return;
    }
    wrap.innerHTML = items.map(s => {
      const checked = _selectedIds.has(s.id);
      const onclickAttr = _manageMode
        ? `Stickers._toggleSelect('${s.id}')`
        : `Stickers._openStickerMenu('${s.id}')`;
      return `
      <div class="sticker-card" data-id="${s.id}" onclick="${onclickAttr}" title="${_manageMode ? '点击选择' : '点击操作'}" style="display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer">
        <div class="sticker-thumb" style="position:relative;width:100%;aspect-ratio:1;border-radius:10px;overflow:hidden;background:var(--bg-tertiary);border:1px solid ${_manageMode && checked ? 'var(--accent)' : 'var(--border)'}">
          <img src="${s.dataUrl}" alt="${_esc(s.name)}" style="width:100%;height:100%;object-fit:contain;pointer-events:none${_manageMode && checked ? ';opacity:0.6' : ''}">
          ${_manageMode ? `<span class="sticker-check" style="position:absolute;right:3px;top:3px;width:20px;height:20px;border-radius:50%;border:2px solid ${checked ? 'var(--accent)' : 'rgba(255,255,255,0.85)'};background:${checked ? 'var(--accent)' : 'rgba(0,0,0,0.35)'};display:flex;align-items:center;justify-content:center;pointer-events:none">${checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--on-accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}</span>` : ''}
          ${(s.category || '').trim() ? `<div style="position:absolute;left:2px;bottom:2px;max-width:calc(100% - 8px);padding:1px 6px;border-radius:6px;background:rgba(0,0,0,0.5);color:#fff;font-size:10px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(s.category)}</div>` : ''}
        </div>
        <div style="font-size:12px;color:var(--text);text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(s.name)}</div>
      </div>`;
    }).join('');
    _updateSelectAllIcon();
  }

  // ===== 批量管理模式 =====

  // 当前筛选+搜索后的表情（全选/图标刷新共用）
  async function _getFilteredStickers() {
    let items = await list();
    if (_filterCat === '') items = items.filter(s => !(s.category || '').trim());
    else if (_filterCat != null) items = items.filter(s => (s.category || '') === _filterCat);
    if (_searchQuery) items = items.filter(s => (s.name || '').toLowerCase().includes(_searchQuery));
    return items;
  }

  function _onSearchInput(val) {
    _searchQuery = String(val || '').trim().toLowerCase();
    renderList();
  }

  function _toggleSelect(id) {
    if (_selectedIds.has(id)) _selectedIds.delete(id);
    else _selectedIds.add(id);
    // 局部更新那一张卡，避免 200 张全量重绘
    const card = document.querySelector(`.sticker-card[data-id="${id}"]`);
    if (card) {
      const checked = _selectedIds.has(id);
      const box = card.querySelector('.sticker-thumb');
      const img = card.querySelector('img');
      const circle = card.querySelector('.sticker-check');
      if (box) box.style.borderColor = checked ? 'var(--accent)' : 'var(--border)';
      if (img) img.style.opacity = checked ? '0.6' : '';
      if (circle) {
        circle.style.borderColor = checked ? 'var(--accent)' : 'rgba(255,255,255,0.85)';
        circle.style.background = checked ? 'var(--accent)' : 'rgba(0,0,0,0.35)';
        circle.innerHTML = checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--on-accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '';
      }
    } else {
      renderList();
    }
    _updateSelectAllIcon();
    _updateManageBarCount();
  }

  function toggleManageMode() {
    _manageMode = !_manageMode;
    _selectedIds.clear();
    const bar = document.getElementById('stickers-manage-bar');
    const btn = document.getElementById('stickers-manage-btn');
    const wrap = document.getElementById('stickers-list');
    if (_manageMode) {
      if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
      if (btn) { btn.textContent = '退出'; btn.style.background = 'var(--accent)'; btn.style.color = 'var(--bg)'; btn.style.borderColor = 'var(--accent)'; }
      if (wrap) wrap.style.paddingBottom = '64px';
    } else {
      if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
      if (btn) { btn.textContent = '批量'; btn.style.background = 'var(--bg-tertiary)'; btn.style.color = 'var(--text)'; btn.style.borderColor = 'var(--border)'; }
      if (wrap) wrap.style.paddingBottom = '';
    }
    renderList();
  }

  function exitManageMode() {
    if (!_manageMode) return;
    toggleManageMode();
  }

  async function _updateSelectAllIcon() {
    const iconEl = document.getElementById('stickers-select-all-icon');
    if (!iconEl) return;
    const filtered = await _getFilteredStickers();
    const allSelected = filtered.length > 0 && filtered.every(s => _selectedIds.has(s.id));
    if (allSelected) {
      iconEl.style.background = 'var(--accent)';
      iconEl.style.border = '2px solid var(--accent)';
      iconEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--on-accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    } else {
      iconEl.style.background = '';
      iconEl.style.border = '2px solid var(--text-secondary)';
      iconEl.innerHTML = '';
    }
    _updateManageBarCount();
  }

  function _updateManageBarCount() {
    const el = document.getElementById('stickers-selected-count');
    if (el) el.textContent = _selectedIds.size ? `已选 ${_selectedIds.size}` : '全选';
  }

  async function toggleSelectAll() {
    const filtered = await _getFilteredStickers();
    const allSelected = filtered.length > 0 && filtered.every(s => _selectedIds.has(s.id));
    if (allSelected) filtered.forEach(s => _selectedIds.delete(s.id));
    else filtered.forEach(s => _selectedIds.add(s.id));
    await renderList();
  }

  // 批量删除（逐条删，带进度提示）
  async function batchRemove() {
    if (!_selectedIds.size) { UI.showToast('请先选择表情', 1400); return; }
    const n = _selectedIds.size;
    const ok = await UI.showConfirm('批量删除', `确定删除选中的 ${n} 个表情？已发送到聊天记录里的会显示为占位。`);
    if (!ok) return;
    const ids = Array.from(_selectedIds);
    let done = 0;
    for (const id of ids) {
      try { await DB.del('stickers', id); } catch (_) {}
      done++;
      if (done % 20 === 0) UI.showToast(`删除中 ${done}/${n}`, 800);
    }
    _cache = null;
    _selectedIds.clear();
    UI.showToast(`已删除 ${n} 个表情`, 1600);
    exitManageMode();
  }

  // 批量移到分类
  async function batchSetCategory() {
    if (!_selectedIds.size) { UI.showToast('请先选择表情', 1400); return; }
    const cat = await _promptCategory(`移动 ${_selectedIds.size} 个表情到`);
    if (cat === undefined) return;
    const ids = Array.from(_selectedIds);
    const n = ids.length;
    let done = 0;
    for (const id of ids) {
      try {
        const item = await DB.get('stickers', id);
        if (item) { item.category = String(cat || '').trim(); await DB.put('stickers', item); }
      } catch (_) {}
      done++;
      if (done % 20 === 0) UI.showToast(`移动中 ${done}/${n}`, 800);
    }
    _cache = null;
    _selectedIds.clear();
    if (cat) _filterCat = cat;
    UI.showToast(cat ? `已移动 ${n} 个到「${cat}」` : `已把 ${n} 个设为未分类`, 1600);
    exitManageMode();
  }

  // 渲染分类筛选 tab：全部 / 未分类 / 各类别（长按可重命名/删除）/ ＋新类别
  function _renderCatTabs() {
    const bar = document.getElementById('stickers-cat-tabs');
    if (!bar) return;
    const cats = getCategories();
    const tab = (label, val, longPressName) => {
      const active = (val === _filterCat);
      const activeCss = active ? 'background:var(--accent);color:var(--bg);border-color:var(--accent)' : 'background:var(--bg-tertiary);color:var(--text);border-color:var(--border)';
      const esc = longPressName ? _esc(longPressName).replace(/'/g, "\\'") : '';
      const lp = longPressName
        ? ` oncontextmenu="event.preventDefault();Stickers._onCatLongPress('${esc}')" ontouchstart="Stickers._onCatTouchStart(event,'${esc}')" ontouchend="Stickers._onCatTouchEnd()" ontouchmove="Stickers._onCatTouchEnd()"`
        : '';
      const onclickAttr = longPressName
        ? `Stickers._onCatClick(event,'${esc}')`
        : `Stickers._setFilter(${val == null ? 'null' : `'${_esc(String(val)).replace(/'/g, "\\'")}'`})`;
      return `<button onclick="${onclickAttr}"${lp} style="padding:5px 12px;border:1px solid;border-radius:999px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;${activeCss}">${_esc(label)}</button>`;
    };
    let html = tab('全部', null) + tab('未分类', '');
    for (const c of cats) html += tab(c, c, c);
    html += `<button onclick="Stickers._promptNewCategory()" style="padding:5px 12px;border:1px dashed var(--border);border-radius:999px;font-size:12px;cursor:pointer;font-family:inherit;background:none;color:var(--text-secondary)">＋新类别</button>`;
    bar.innerHTML = html;
  }

  // 分类 Tab 长按：重命名 / 删除
  let _catLongPressTimer = null;
  let _catSuppressClick = false;
  function _onCatTouchStart(e, name) {
    _catLongPressTimer = setTimeout(() => {
      _catSuppressClick = true;
      try { e?.preventDefault?.(); } catch (_) {}
      _onCatLongPress(name);
      setTimeout(() => { _catSuppressClick = false; }, 650);
    }, 500);
  }
  function _onCatTouchEnd() {
    if (_catLongPressTimer) { clearTimeout(_catLongPressTimer); _catLongPressTimer = null; }
  }
  function _onCatClick(e, name) {
    if (_catSuppressClick) { _catSuppressClick = false; try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {} return; }
    _setFilter(name);
  }
  async function _onCatLongPress(name) {
    const act = await _sheet(`类别「${name}」`, [
      { label: '重命名', value: 'rename' },
      { label: '删除类别', value: 'delete', danger: true }
    ]);
    if (!act) return;
    if (act === 'rename') {
      const nn = await _promptName('重命名类别', '类别名字', name);
      if (nn === null) return;
      const nm = String(nn || '').trim();
      if (!nm || nm === name) return;
      if (getCategories().includes(nm)) { UI.showToast('已有同名类别', 1500); return; }
      await renameCategory(name, nm);
      if (_filterCat === name) _filterCat = nm;
      UI.showToast('已重命名', 1400);
      renderList();
    } else if (act === 'delete') {
      await _confirmRemoveCategory(name);
    }
  }

  // 轻量底部选项弹层（无分割线）
  function _sheet(title, options) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:100030;background:rgba(0,0,0,0.5);display:flex;align-items:flex-end;justify-content:center';
      const btns = options.map((o, i) =>
        `<button data-i="${i}" style="width:100%;padding:15px 16px;background:none;border:none;color:${o.danger ? 'var(--danger,#e55)' : 'var(--text)'};font-size:15px;cursor:pointer;text-align:center;font-family:inherit">${_esc(o.label)}</button>`
      ).join('');
      overlay.innerHTML = `
        <div style="background:var(--bg);width:100%;max-width:480px;border-radius:16px 16px 0 0;overflow:hidden;padding-bottom:env(safe-area-inset-bottom,0)">
          <div style="padding:14px 16px 8px;font-size:13px;color:var(--text-secondary);text-align:center">${_esc(title || '')}</div>
          ${btns}
          <button data-i="-1" style="width:100%;padding:15px 16px;margin-top:6px;background:var(--bg-tertiary);border:none;color:var(--text-secondary);font-size:15px;cursor:pointer;text-align:center;font-family:inherit">取消</button>
        </div>`;
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { close(null); return; }
        const b = e.target.closest('button[data-i]');
        if (!b) return;
        const idx = parseInt(b.dataset.i, 10);
        close(idx < 0 ? null : options[idx].value);
      });
      document.body.appendChild(overlay);
    });
  }

  function _setFilter(val) {
    _filterCat = val;
    renderList();
  }

  async function _promptNewCategory() {
    const name = await _promptName('新建类别', '如：狗狗、猫猫、日常', '');
    if (name === null) return;
    const nm = addCategory(name);
    if (nm) { _filterCat = nm; renderList(); }
  }

  async function _confirmRemoveCategory(name) {
    const ok = await UI.showConfirm('删除类别', `确定删除类别「${name}」吗？该类别下的表情不会被删除，会变成未分类。`);
    if (!ok) return;
    await removeCategory(name);
    if (_filterCat === name) _filterCat = null;
    UI.showToast('已删除类别', 1400);
    renderList();
  }

  // 点表情卡片：弹操作菜单（改分类 / 重命名 / 删除）
  function _openStickerMenu(id) {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.style.cssText = 'display:flex;align-items:flex-end;justify-content:center;z-index:100020';
    overlay.innerHTML = `
      <div class="modal-content" style="max-width:360px;width:calc(100% - 24px);margin-bottom:16px">
        <div style="display:flex;flex-direction:column;gap:8px">
          <button data-act="cat" style="padding:12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:14px;cursor:pointer;font-family:inherit">改分类</button>
          <button data-act="rename" style="padding:12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:14px;cursor:pointer;font-family:inherit">重命名</button>
          <button data-act="del" style="padding:12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:10px;color:var(--danger,#e55);font-size:14px;cursor:pointer;font-family:inherit">删除</button>
          <button data-act="cancel" style="padding:12px;background:none;border:1px solid var(--border);border-radius:10px;color:var(--text-secondary);font-size:14px;cursor:pointer;font-family:inherit">取消</button>
        </div>
      </div>`;
    const close = () => overlay.remove();
    overlay.addEventListener('click', async (e) => {
      if (e.target === overlay) { close(); return; }
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      close();
      if (act === 'cat') { await _changeCategory(id); }
      else if (act === 'rename') { await _promptRename(id); }
      else if (act === 'del') { await confirmRemove(id); }
    });
    document.body.appendChild(overlay);
  }

  async function _changeCategory(id) {
    const cat = await _promptCategory('改到哪个分类');
    if (cat === undefined) return;
    await setCategory(id, cat);
    UI.showToast(cat ? `已归入「${cat}」` : '已设为未分类', 1400);
    renderList();
  }

  async function _promptRename(id) {
    const item = await get(id);
    if (!item) return;
    const name = await _promptName('重命名表情', '表情名字', item.name);
    if (name === null) return;
    const nm = String(name || '').trim();
    if (!nm) return;
    try { await rename(id, nm); renderList(); } catch (_) {}
  }

  // ===== 同步给角色（全局开关，存 localStorage） =====
  const _SYNC_KEY = 'stickers_sync_ai';

  function isSyncAI() {
    try { return localStorage.getItem(_SYNC_KEY) === '1'; } catch (_) { return false; }
  }

  function setSyncAI(on) {
    try { localStorage.setItem(_SYNC_KEY, on ? '1' : '0'); } catch (_) {}
  }

  // 按名字查表情（供 AI 解析用，返回条目或 null）
  async function findByName(name) {
    const nm = String(name || '').trim();
    if (!nm) return null;
    const items = await list();
    return items.find(s => (s.name || '').trim() === nm) || null;
  }

  // 全量名字列表字符串（供提示词注入），空库返回 ''
  async function buildPromptNames() {
    const items = await list();
    const scope = getSyncCats();
    // scope 为 null = 从未设置过 → 全部同步（老行为）
    const filtered = (scope === null)
      ? items
      : items.filter(s => scope.includes((s.category || '').trim()));
    const names = filtered.map(s => (s.name || '').trim()).filter(Boolean);
    return names.join('、');
  }

  // ===== 同步范围（哪些分类同步给 AI）=====
  // localStorage 存分类名数组；'' 代表「未分类」。
  // 键不存在 = 从未设置过 → 视为全部同步；存了空数组 = 主动全不选 → 不同步任何。
  const _SYNC_CATS_KEY = 'stickers_sync_cats';

  // 返回 null（未设置过）或字符串数组
  function getSyncCats() {
    try {
      const raw = localStorage.getItem(_SYNC_CATS_KEY);
      if (raw == null) return null;
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(c => typeof c === 'string') : null;
    } catch (_) { return null; }
  }
  function _saveSyncCats(arr) {
    try { localStorage.setItem(_SYNC_CATS_KEY, JSON.stringify(arr)); } catch (_) {}
  }

  // 当前生效的同步分类集合（未设置过时返回「所有分类 + 未分类」）
  function _effectiveSyncCats() {
    const s = getSyncCats();
    if (s !== null) return s;
    return ['', ...getCategories()];
  }

  // 同步范围摘要文字（回填到设置行）
  function _syncScopeLabel() {
    const s = getSyncCats();
    const all = ['', ...getCategories()];
    if (s === null) return '全部';
    if (!s.length) return '不同步';
    const picked = s.filter(c => all.includes(c));
    if (picked.length >= all.length) return '全部';
    return picked.map(c => c === '' ? '未分类' : c).join('、');
  }

  // 打开同步范围多选弹窗
  function openSyncScope() {
    const cats = ['', ...getCategories()];
    const cur = new Set(_effectiveSyncCats());
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:100020';
    const row = (c, i) => {
      const label = c === '' ? '未分类' : c;
      const on = cur.has(c);
      return `<label data-i="${i}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-tertiary);border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};border-radius:8px;cursor:pointer;font-size:14px;color:var(--text)">
        <span style="width:20px;height:20px;border-radius:50%;border:2px solid ${on ? 'var(--accent)' : 'var(--text-secondary)'};background:${on ? 'var(--accent)' : 'transparent'};display:flex;align-items:center;justify-content:center;flex-shrink:0">${on ? '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--on-accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}</span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(label)}</span>
      </label>`;
    };
    overlay.innerHTML = `
      <div class="modal-content" style="max-width:360px;width:calc(100% - 40px);position:relative;display:flex;flex-direction:column;max-height:76vh">
        <h3 style="margin:0 0 6px;padding-right:28px">同步给角色的分类</h3>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">只有勾选分类里的表情，名字才会写进提示词给 AI。全不选=不同步任何表情。</div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <button data-act="all" style="flex:1;padding:7px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:12px;cursor:pointer;font-family:inherit">全选</button>
          <button data-act="none" style="flex:1;padding:7px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:12px;cursor:pointer;font-family:inherit">全不选</button>
        </div>
        <div id="stk-scope-rows" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${cats.map(row).join('')}</div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button data-act="cancel" style="flex:1;padding:10px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:14px;cursor:pointer;font-family:inherit">取消</button>
          <button data-act="save" style="flex:1;padding:10px;background:var(--accent);border:none;border-radius:8px;color:var(--bg);font-size:14px;cursor:pointer;font-family:inherit;font-weight:600">保存</button>
        </div>
      </div>`;
    const rerender = () => {
      const box = overlay.querySelector('#stk-scope-rows');
      if (box) box.innerHTML = cats.map(row).join('');
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); return; }
      const lab = e.target.closest('label[data-i]');
      if (lab) {
        const key = cats[parseInt(lab.dataset.i, 10)];
        if (key === undefined) return;
        if (cur.has(key)) cur.delete(key); else cur.add(key);
        rerender();
        return;
      }
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'all') { cats.forEach(c => cur.add(c)); rerender(); return; }
      if (act === 'none') { cur.clear(); rerender(); return; }
      if (act === 'cancel') { overlay.remove(); return; }
      if (act === 'save') {
        _saveSyncCats(cats.filter(c => cur.has(c)));
        overlay.remove();
        UI.showToast('已保存同步范围', 1400);
        renderList();
      }
    });
    document.body.appendChild(overlay);
  }

  function _esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '"', "'": '&#39;' }[c]));
  }

  return { list, get, add, remove, rename, pickAndAdd, pickBatchAndAdd, pickBatchUrlAndAdd, confirmRemove, renderList, _promptRename, isSyncAI, setSyncAI, findByName, buildPromptNames, getCategories, addCategory, removeCategory, renameCategory, setCategory, _setFilter, _openStickerMenu, _promptNewCategory, _confirmRemoveCategory,
    toggleManageMode, exitManageMode, toggleSelectAll, batchRemove, batchSetCategory, _toggleSelect, _onSearchInput,
    openSyncScope, getSyncCats,
    _onCatLongPress, _onCatTouchStart, _onCatTouchEnd, _onCatClick };
})();
window.Stickers = Stickers;
