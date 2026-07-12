/**
 * 表情包模块 — 全局共享表情库
 * 数据：DB.stickers store，每条 { id, name, dataUrl, createdAt }
 * 用途：手机聊天（私聊/群聊）通用发送；管理界面在侧边栏设置。
 */
const Stickers = (() => {
  // 内存缓存：id -> {id, name, dataUrl, createdAt}
  let _cache = null;

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

  // 新增表情：name + dataUrl（dataUrl 已经是选好的图）
  async function add(name, dataUrl) {
    const nm = String(name || '').trim();
    if (!nm) throw new Error('表情名字不能为空');
    if (!dataUrl) throw new Error('没有图片');
    const compressed = await _compressToSticker(dataUrl);
    const item = { id: 'stk_' + Utils.uuid().slice(0, 10), name: nm, dataUrl: compressed, createdAt: Date.now() };
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
      await add(nm, dataUrl);
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
            await add(name, dataUrl);
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
          await add(finalName, url);
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
    } catch (_) {}
    const wrap = document.getElementById('stickers-list');
    if (!wrap) return;
    const items = await list();
    if (!items.length) {
      wrap.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;text-align:center;padding:24px 0">还没有表情，点上面的按钮添加</div>';
      return;
    }
    wrap.innerHTML = items.map(s => `
      <div onclick="Stickers._promptRename('${s.id}')" title="点击重命名" style="display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer">
        <div style="position:relative;width:100%;aspect-ratio:1;border-radius:10px;overflow:hidden;background:var(--bg-tertiary);border:1px solid var(--border)">
          <img src="${s.dataUrl}" alt="${_esc(s.name)}" style="width:100%;height:100%;object-fit:contain;pointer-events:none">
          <button onclick="event.stopPropagation();Stickers.confirmRemove('${s.id}')" title="删除" style="position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,0.5);color:#fff;border:none;cursor:pointer;font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0">×</button>
        </div>
        <div style="font-size:12px;color:var(--text);text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(s.name)}</div>
      </div>
    `).join('');
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
    const names = items.map(s => (s.name || '').trim()).filter(Boolean);
    return names.join('、');
  }

  function _esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '"', "'": '&#39;' }[c]));
  }

  return { list, get, add, remove, rename, pickAndAdd, pickBatchAndAdd, pickBatchUrlAndAdd, confirmRemove, renderList, _promptRename, isSyncAI, setSyncAI, findByName, buildPromptNames };
})();
window.Stickers = Stickers;
