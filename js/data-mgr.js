/**
 * 数据导入导出
 */
const DataMgr = (() => {
  async function _safeGetAll(storeName) {
    try { return await DB.getAll(storeName); }
    catch(e) {
      console.warn(`[DataMgr] 读取 ${storeName} 失败，按空数组导出`, e);
      return [];
    }
  }

  async function _safeClear(storeName) {
    try { await DB.clear(storeName); } catch(e) { console.warn(`[DataMgr] 清空 ${storeName} 失败，跳过`, e); }
  }

  async function _safePut(storeName, item) {
    try { await DB.put(storeName, item); } catch(e) { console.warn(`[DataMgr] 写入 ${storeName} 失败，跳过`, e, item); }
  }

  async function exportAll() {
    try {
      const gameState = await _safeGetAll('gameState');
      const singleCards = await _safeGetAll('singleCards');
      const npcAvatars = await _safeGetAll('npcAvatars');
      const drawnImages = await _safeGetAll('drawnImages');
      const lorebooks = await _safeGetAll('lorebooks');
      const conversations = (gameState.find(x => x && x.key === 'conversations')?.value) || [];

      // 注意：大存档（含 drawnImages / npcAvatars / messages 里的 base64 图片）一次性
      // JSON.stringify 整个对象会在 JS 堆里生成一个巨型字符串，移动浏览器极易 OOM 闪退。
      // 这里改成按字段分片 stringify，push 进数组直接交给 Blob 流式拼接，
      // 避免同时存在「所有数据拼成的单一巨串」。同时去掉缩进，进一步省内存与体积。
      const parts = [];
      let _first = true;
      const _emit = (key, value) => {
        parts.push((_first ? '{' : ',') + JSON.stringify(key) + ':');
        parts.push(JSON.stringify(value === undefined ? null : value));
        _first = false;
      };
      // 大数组（含 base64 图片）逐条 stringify，避免一次性 stringify 整表生成上百 MB 的巨串触发 OOM。
      // 每 CHUNK 条 await 一次让出主线程，防止 UI 假死/卡顿。
      const _emitArray = async (key, arr) => {
        const list = Array.isArray(arr) ? arr : [];
        parts.push((_first ? '{' : ',') + JSON.stringify(key) + ':[');
        _first = false;
        const CHUNK = 20;
        for (let i = 0; i < list.length; i++) {
          parts.push((i ? ',' : '') + JSON.stringify(list[i] === undefined ? null : list[i]));
          if (i % CHUNK === CHUNK - 1) await new Promise(r => setTimeout(r, 0));
        }
        parts.push(']');
      };

      _emit('version', 4);
      _emit('exportTime', new Date().toISOString());
      await _emitArray('messages', await _safeGetAll('messages'));
      _emit('memories', await _safeGetAll('memories'));
      _emit('settings', await _safeGetAll('settings'));
      _emit('characters', await _safeGetAll('characters'));
      _emit('gameState', gameState);
      // 显式冗余一份，方便人工检查/兼容旧导入器；真实来源仍是 gameState 内的 conversations 项
      _emit('conversations', conversations);
      _emit('worldviews', await _safeGetAll('worldviews'));
      _emit('archives', await _safeGetAll('archives'));
      _emit('summaries', await _safeGetAll('summaries'));
      _emit('singleCards', singleCards);
      await _emitArray('npcAvatars', npcAvatars);
      await _emitArray('drawnImages', drawnImages);
      _emit('lorebooks', lorebooks);
      _emit('themeConfig', localStorage.getItem('themeConfig') || null);
      _emit('themeCustomPresets', localStorage.getItem('themeCustomPresets') || null);
      parts.push('}');

      const blob = new Blob(parts, { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `skynex-save-${new Date().toISOString().slice(0, 10)}.json`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      try { localStorage.setItem('tianshu_last_export_at', String(Date.now())); } catch(_) {}
      UI.showToast('已导出总存档', 2000);
    } catch (e) {
      console.error('[DataMgr.exportAll]', e);
      await UI.showAlert('导出失败', e.message || String(e));
    }
  }

  // 递归剥离内嵌的 base64 dataURL（图片/字体等），替换成空字符串。
  // 不依赖具体字段名，任何值为 data:image/... 或 data:font/... 的字符串都会被清掉。
  // 用空串而非占位符，避免导入后被当成图片 URL 渲染出破图。
  // 原地修改传入对象，调用方应传入可丢弃的副本或本来就要序列化的数据。
  // keepAvatar=true 时，保留各类头像/图标小图字段（轻量导出要留）：
  //   avatar（面具/单人卡/NPC/主页/联系人/群/心动目标头像）、iconImage（世界观图标）。
  function _stripDataUrls(node, keepAvatar) {
    if (node == null) return node;
    if (typeof node === 'string') {
      return /^data:(image|font|audio|video)\//i.test(node) ? '' : node;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = _stripDataUrls(node[i], keepAvatar);
      return node;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (keepAvatar && (k === 'avatar' || k === 'iconImage')) continue; // 头像/世界观图标整段保留
        node[k] = _stripDataUrls(node[k], keepAvatar);
      }
      return node;
    }
    return node;
  }

  // 纯文字导出：跳过纯图片表（drawnImages/npcAvatars），并递归剥离其余数据里
  // 内嵌的 base64 图片/字体，得到一个体积极小、永远不会 OOM 的存档。
  // 用于数据量大、带图导出闪退时的兜底备份；图片不会被保留。
  async function exportTextOnly() {
    try {
      const gameState = _stripDataUrls(await _safeGetAll('gameState'));
      const conversations = (gameState.find(x => x && x.key === 'conversations')?.value) || [];

      const parts = [];
      let _first = true;
      const _emit = (key, value) => {
        parts.push((_first ? '{' : ',') + JSON.stringify(key) + ':');
        parts.push(JSON.stringify(value === undefined ? null : value));
        _first = false;
      };

      _emit('version', 4);
      _emit('textOnly', true);
      _emit('exportTime', new Date().toISOString());
      _emit('messages', _stripDataUrls(await _safeGetAll('messages')));
      _emit('memories', _stripDataUrls(await _safeGetAll('memories')));
      _emit('settings', _stripDataUrls(await _safeGetAll('settings')));
      _emit('characters', _stripDataUrls(await _safeGetAll('characters')));
      _emit('gameState', gameState);
      _emit('conversations', conversations);
      _emit('worldviews', _stripDataUrls(await _safeGetAll('worldviews')));
      _emit('archives', _stripDataUrls(await _safeGetAll('archives')));
      _emit('summaries', _stripDataUrls(await _safeGetAll('summaries')));
      _emit('singleCards', _stripDataUrls(await _safeGetAll('singleCards')));
      _emit('lorebooks', _stripDataUrls(await _safeGetAll('lorebooks')));
      // 图片表整表跳过：导出空数组占位，导入端遇到空数组即不写入
      _emit('npcAvatars', []);
      _emit('drawnImages', []);
      // 主题配置里可能含 chatBgImage/customFontData，解析后剥离再写回字符串
      let themeConfig = localStorage.getItem('themeConfig') || null;
      try { if (themeConfig) themeConfig = JSON.stringify(_stripDataUrls(JSON.parse(themeConfig))); } catch(_) {}
      let themePresets = localStorage.getItem('themeCustomPresets') || null;
      try { if (themePresets) themePresets = JSON.stringify(_stripDataUrls(JSON.parse(themePresets))); } catch(_) {}
      _emit('themeConfig', themeConfig);
      _emit('themeCustomPresets', themePresets);
      parts.push('}');

      const blob = new Blob(parts, { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `skynex-save-text-${new Date().toISOString().slice(0, 10)}.json`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      try { localStorage.setItem('tianshu_last_export_at', String(Date.now())); } catch(_) {}
      UI.showToast('已导出纯文字存档（不含图片）', 2500);
    } catch (e) {
      console.error('[DataMgr.exportTextOnly]', e);
      await UI.showAlert('导出失败', e.message || String(e));
    }
  }

  // 轻量导出：文字 + 各类头像（面具/单人卡/NPC），跳过生成图库与其它内嵌大图。
  // 与纯文字导出的唯一区别：保留 avatar 字段 + 完整保留 npcAvatars 表（头像都是小图，体积可控）。
  // drawnImages（生成图库）整表跳过——它才是 100MB 存档的大头。导入端按 lite 标记走"不覆盖图片表"逻辑。
  async function exportLite() {
    try {
      const gameState = _stripDataUrls(await _safeGetAll('gameState'), true);
      const conversations = (gameState.find(x => x && x.key === 'conversations')?.value) || [];

      const parts = [];
      let _first = true;
      const _emit = (key, value) => {
        parts.push((_first ? '{' : ',') + JSON.stringify(key) + ':');
        parts.push(JSON.stringify(value === undefined ? null : value));
        _first = false;
      };

      _emit('version', 4);
      _emit('lite', true);   // 导入端按 lite 逻辑：写入头像表，但跳过生成图库
      _emit('exportTime', new Date().toISOString());
      _emit('messages', _stripDataUrls(await _safeGetAll('messages'), true));
      _emit('memories', _stripDataUrls(await _safeGetAll('memories'), true));
      _emit('settings', _stripDataUrls(await _safeGetAll('settings'), true));
      _emit('characters', _stripDataUrls(await _safeGetAll('characters'), true));
      _emit('gameState', gameState);
      _emit('conversations', conversations);
      _emit('worldviews', _stripDataUrls(await _safeGetAll('worldviews'), true));
      _emit('archives', _stripDataUrls(await _safeGetAll('archives'), true));
      _emit('summaries', _stripDataUrls(await _safeGetAll('summaries'), true));
      _emit('singleCards', _stripDataUrls(await _safeGetAll('singleCards'), true));
      _emit('lorebooks', _stripDataUrls(await _safeGetAll('lorebooks'), true));
      // 头像表整表保留（都是小图），生成图库整表跳过
      _emit('npcAvatars', await _safeGetAll('npcAvatars'));
      _emit('drawnImages', []);
      // 主题配置里可能含 chatBgImage/customFontData，解析后剥离再写回字符串
      let themeConfig = localStorage.getItem('themeConfig') || null;
      try { if (themeConfig) themeConfig = JSON.stringify(_stripDataUrls(JSON.parse(themeConfig), true)); } catch(_) {}
      let themePresets = localStorage.getItem('themeCustomPresets') || null;
      try { if (themePresets) themePresets = JSON.stringify(_stripDataUrls(JSON.parse(themePresets), true)); } catch(_) {}
      _emit('themeConfig', themeConfig);
      _emit('themeCustomPresets', themePresets);
      parts.push('}');

      const blob = new Blob(parts, { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `skynex-save-lite-${new Date().toISOString().slice(0, 10)}.json`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      try { localStorage.setItem('tianshu_last_export_at', String(Date.now())); } catch(_) {}
      UI.showToast('已导出轻量存档（含头像，不含图库）', 2500);
    } catch (e) {
      console.error('[DataMgr.exportLite]', e);
      await UI.showAlert('导出失败', e.message || String(e));
    }
  }

  function importAll() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.version) throw new Error('无效的存档文件');

        const isTextOnly = !!data.textOnly;
        const isLite = !!data.lite;
        const confirmMsg = isLite
          ? '这是轻量存档（含文字和各类头像，不含生成图库）。导入会覆盖文字数据和头像，并保留你当前设备上的生成图库（不会被空图覆盖）。确定继续？'
          : isTextOnly
          ? '这是纯文字存档（不含任何图片）。导入会覆盖文字数据，并保留你当前设备上已有的图片（不会用存档里的空图覆盖）。注意：如果导入到一台没有这些图的新设备，那些图就会是空的。确定继续？'
          : '导入将覆盖当前所有数据，确定继续？';
        if (!await UI.showConfirm('导入存档', confirmMsg)) return;

        // 清空（纯文字存档不动图片表，保留现有图片；轻量存档只清头像表、不动生成图库）
        await _safeClear('messages');
        await _safeClear('memories');
        await _safeClear('settings');
        await _safeClear('characters');
        await _safeClear('gameState');
        await _safeClear('worldviews');
        await _safeClear('archives');
        await _safeClear('summaries');
        await _safeClear('singleCards');
        await _safeClear('lorebooks');
        if (isLite) {
          await _safeClear('npcAvatars');   // 头像表有真实数据，要覆盖；drawnImages 保留本机
        } else if (!isTextOnly) {
          await _safeClear('npcAvatars');
          await _safeClear('drawnImages');
        }

        // 导入
        for (const m of (data.messages || [])) await _safePut('messages', m);
        for (const m of (data.memories || [])) await _safePut('memories', m);
        for (const s of (data.settings || [])) await _safePut('settings', s);
        for (const c of (data.characters || [])) await _safePut('characters', c);
        const gameStateRows = Array.isArray(data.gameState) ? data.gameState.slice() : [];
        // 兼容 v3 显式 conversations 字段：如果 gameState 里没有 conversations，就补回去
        if (Array.isArray(data.conversations) && !gameStateRows.some(x => x && x.key === 'conversations')) {
          gameStateRows.push({ key: 'conversations', value: data.conversations });
        }
        for (const g of gameStateRows) await _safePut('gameState', g);
        for (const w of (data.worldviews || [])) await _safePut('worldviews', w);
        for (const a of (data.archives || [])) await _safePut('archives', a);
        for (const s of (data.summaries || [])) await _safePut('summaries', s);
        const importedSingleCards = data.singleCards || data.single_cards || [];
        for (const c of importedSingleCards) await _safePut('singleCards', c);
        // 纯文字存档的图片表是空的，跳过写入以保留现有图片
        if (isLite) {
          // 轻量存档：写入头像表（有真实数据），生成图库保留本机不动
          const importedNpcAvatars = data.npcAvatars || data.npc_avatars || [];
          for (const a of importedNpcAvatars) await _safePut('npcAvatars', a);
        } else if (!isTextOnly) {
          const importedNpcAvatars = data.npcAvatars || data.npc_avatars || [];
          const importedDrawnImages = data.drawnImages || data.drawn_images || [];
          for (const a of importedNpcAvatars) await _safePut('npcAvatars', a);
          for (const img of importedDrawnImages) await _safePut('drawnImages', img);
        }
        // v4：lorebooks（v3 之前没这个字段，老存档直接跳过）
        for (const lb of (data.lorebooks || [])) await _safePut('lorebooks', lb);
        if (data.themeConfig) localStorage.setItem('themeConfig', data.themeConfig);
        if (data.themeCustomPresets) localStorage.setItem('themeCustomPresets', data.themeCustomPresets);

        await UI.showAlert('导入成功', isLite ? '文字数据和各类头像已恢复。生成图库保留了本机现有的；手机里的壁纸/封面等内联大图因为轻量存档不含它们，会是空的（恢复默认）。页面将自动刷新' : isTextOnly ? '文字数据已恢复。独立图库（生成图/头像）保留了本机现有的；手机里的壁纸/头像/封面等内联图因为纯文字存档不含它们，会是空的（恢复默认）。页面将自动刷新' : '总存档已恢复，页面将自动刷新');
        location.reload();
      } catch (e) {
        await UI.showAlert('导入失败', e.message || String(e));
      }
    };
    input.click();
  }

  function getLastExportAt() {
    try {
      const v = localStorage.getItem('tianshu_last_export_at');
      return v ? Number(v) : 0;
    } catch(_) { return 0; }
  }

  // ===== 图片存储管理 =====
  // 估算一条记录里所有 dataURL 字符串的字节数（base64 字符串长度近似 = 字节数）
  function _recordImageBytes(rec) {
    let bytes = 0;
    const visit = (v) => {
      if (typeof v === 'string') {
        if (/^data:(image|font|audio|video)\//i.test(v)) bytes += v.length;
      } else if (Array.isArray(v)) {
        v.forEach(visit);
      } else if (v && typeof v === 'object') {
        Object.values(v).forEach(visit);
      }
    };
    visit(rec);
    return bytes;
  }

  // 统计图片相关存储：生成图（drawnImages）+ 头像（npcAvatars）的数量与体积
  async function getStorageStats() {
    const drawn = await _safeGetAll('drawnImages');
    const avatars = await _safeGetAll('npcAvatars');
    let drawnBytes = 0;
    for (const r of drawn) drawnBytes += _recordImageBytes(r);
    let avatarBytes = 0;
    for (const r of avatars) avatarBytes += _recordImageBytes(r);
    return {
      drawn: { count: drawn.length, bytes: drawnBytes },
      avatars: { count: avatars.length, bytes: avatarBytes },
      total: { count: drawn.length + avatars.length, bytes: drawnBytes + avatarBytes }
    };
  }

  // 列出生成图（缩略展示用）：返回 [{id, prompt, createdAt, bytes}]，按时间倒序，不含 dataUrl
  async function listDrawnImages() {
    const drawn = await _safeGetAll('drawnImages');
    return drawn.map(r => ({
      id: r.id,
      prompt: r.prompt || '',
      createdAt: r.createdAt || 0,
      bytes: _recordImageBytes(r)
    })).sort((a, b) => {
      const ta = typeof a.createdAt === 'string' ? Date.parse(a.createdAt) || 0 : (a.createdAt || 0);
      const tb = typeof b.createdAt === 'string' ? Date.parse(b.createdAt) || 0 : (b.createdAt || 0);
      return tb - ta;
    });
  }

  // 取单张生成图的 dataUrl（缩略图懒加载用）
  async function getDrawnImageData(id) {
    try {
      const r = await DB.get('drawnImages', id);
      return r && r.dataUrl ? r.dataUrl : '';
    } catch(_) { return ''; }
  }

  // 批量删除生成图（消息里的 [TSIMG:id] 占位会优雅降级显示"图片已丢失"）
  async function deleteDrawnImages(ids) {
    let ok = 0;
    for (const id of (ids || [])) {
      try { await DB.del('drawnImages', id); ok++; } catch(_) {}
    }
    return ok;
  }

  // 删除指定时间之前的生成图，返回删除数量。beforeTs 为毫秒时间戳
  async function deleteDrawnImagesBefore(beforeTs) {
    const drawn = await _safeGetAll('drawnImages');
    const toDel = drawn.filter(r => {
      const t = typeof r.createdAt === 'string' ? Date.parse(r.createdAt) || 0 : (r.createdAt || 0);
      return t && t < beforeTs;
    }).map(r => r.id);
    return await deleteDrawnImages(toDel);
  }

  // ===== 手机内联图片（各对话 phoneData 里直接内联的 base64）管理 =====
  // 只统计 data: 开头的 base64，URL/空串不计。

  function _isDataUrl(v) {
    return typeof v === 'string' && /^data:(image|font|audio|video)\//i.test(v);
  }
  function _strBytes(v) { return _isDataUrl(v) ? v.length : 0; }

  // 内联图片类别定义：key=类别id，label=显示名，scan(pd)=返回该类别在这个 phoneData 里的字节数，
  // clear(pd)=就地清空该类别的图片字段（返回是否有改动）
  const _PHONE_IMG_CATS = [
    { key: 'wallpaper', label: '壁纸',
      scan: pd => _strBytes(pd.wallpaper),
      clear: pd => { if (_isDataUrl(pd.wallpaper)) { pd.wallpaper = ''; return true; } return false; } },
    { key: 'avatar', label: '主页头像',
      scan: pd => _strBytes(pd.profile && pd.profile.avatar),
      clear: pd => { if (pd.profile && _isDataUrl(pd.profile.avatar)) { pd.profile.avatar = ''; return true; } return false; } },
    { key: 'momentsCover', label: '好友圈封面',
      scan: pd => _strBytes(pd.momentsCover),
      clear: pd => { if (_isDataUrl(pd.momentsCover)) { pd.momentsCover = ''; return true; } return false; } },
    { key: 'dwExpressBg', label: '快递卡背景',
      scan: pd => _strBytes(pd.dwExpressBg),
      clear: pd => { if (_isDataUrl(pd.dwExpressBg)) { pd.dwExpressBg = ''; return true; } return false; } },
    { key: 'anniversary', label: '纪念日卡背景',
      scan: pd => _strBytes(pd.anniversary && pd.anniversary.image),
      clear: pd => { if (pd.anniversary && _isDataUrl(pd.anniversary.image)) { pd.anniversary.image = ''; return true; } return false; } },
    { key: 'wardrobe', label: '衣橱立绘',
      scan: pd => _strBytes(pd.wardrobePortrait),
      clear: pd => { if (_isDataUrl(pd.wardrobePortrait)) { pd.wardrobePortrait = ''; return true; } return false; } },
    { key: 'npcMoments', label: 'NPC动态配图',
      scan: pd => (Array.isArray(pd.npcMoments) ? pd.npcMoments : []).reduce((s, m) => s + _strBytes(m && m.image), 0),
      clear: pd => { let c = false; (Array.isArray(pd.npcMoments) ? pd.npcMoments : []).forEach(m => { if (m && _isDataUrl(m.image)) { m.image = ''; c = true; } }); return c; } },
    { key: 'moments', label: '我的动态配图',
      scan: pd => (Array.isArray(pd.moments) ? pd.moments : []).reduce((s, m) => s + _strBytes(m && m.image), 0),
      clear: pd => { let c = false; (Array.isArray(pd.moments) ? pd.moments : []).forEach(m => { if (m && _isDataUrl(m.image)) { m.image = ''; c = true; } }); return c; } },
    { key: 'houses', label: '小屋图片',
      scan: pd => (Array.isArray(pd.houses) ? pd.houses : []).reduce((s, h) => s + _strBytes(h && h.image), 0),
      clear: pd => { let c = false; (Array.isArray(pd.houses) ? pd.houses : []).forEach(h => { if (h && _isDataUrl(h.image)) { h.image = ''; c = true; } }); return c; } },
    { key: 'chatAvatars', label: '联系人/群头像',
      scan: pd => (Array.isArray(pd.chatContacts) ? pd.chatContacts : []).reduce((s, c) => s + _strBytes(c && c.avatar), 0)
                + (Array.isArray(pd.chatGroups) ? pd.chatGroups : []).reduce((s, g) => s + _strBytes(g && g.avatar), 0),
      clear: pd => { let c = false;
        (Array.isArray(pd.chatContacts) ? pd.chatContacts : []).forEach(x => { if (x && _isDataUrl(x.avatar)) { x.avatar = ''; c = true; } });
        (Array.isArray(pd.chatGroups) ? pd.chatGroups : []).forEach(x => { if (x && _isDataUrl(x.avatar)) { x.avatar = ''; c = true; } });
        return c; } },
    { key: 'hsTargets', label: '心动目标头像',
      scan: pd => (Array.isArray(pd.hsAppTargets) ? pd.hsAppTargets : []).reduce((s, t) => s + _strBytes(t && t.avatar), 0),
      clear: pd => { let c = false; (Array.isArray(pd.hsAppTargets) ? pd.hsAppTargets : []).forEach(t => { if (t && _isDataUrl(t.avatar)) { t.avatar = ''; c = true; } }); return c; } },
    // 视频封面：用户手动换的封面才是内联 base64（AI 列表默认封面是资源文件名，不计）。
    // 同一作品可能同时在 videoDiscover 各分类与 videoWorks 里，按对象引用去重避免重复计数/漏清。
    { key: 'videoCover', label: '影视封面',
      scan: pd => { let s = 0; _videoCoverEach(pd, w => { s += _strBytes(w && w.cover); }); return s; },
      clear: pd => { let c = false; _videoCoverEach(pd, w => { if (w && _isDataUrl(w.cover)) { w.cover = ''; c = true; } }); return c; } },
    // 阅读封面：书架 + 发现页两类缓存，同样只算内联 base64。
    { key: 'readingCover', label: '书籍封面',
      scan: pd => { let s = 0; _readingCoverEach(pd, b => { s += _strBytes(b && b.cover); }); return s; },
      clear: pd => { let c = false; _readingCoverEach(pd, b => { if (b && _isDataUrl(b.cover)) { b.cover = ''; c = true; } }); return c; } },
    // 电台封面：radioPrograms 各频道（含 __mine__）的 program.cover，部分是 Unsplash URL，靠 _isDataUrl 只挑 base64。
    { key: 'radioCover', label: '电台封面',
      scan: pd => { let s = 0; _radioCoverEach(pd, p => { s += _strBytes(p && p.cover); }); return s; },
      clear: pd => { let c = false; _radioCoverEach(pd, p => { if (p && _isDataUrl(p.cover)) { p.cover = ''; c = true; } }); return c; } },
  ];

  // 遍历一个 phoneData 里所有视频作品对象（videoDiscover 各分类 + videoWorks，按引用去重），对每个调 fn。
  function _videoCoverEach(pd, fn) {
    const seen = new Set();
    const visit = (w) => { if (w && typeof w === 'object' && !seen.has(w)) { seen.add(w); fn(w); } };
    const disc = (pd && pd.videoDiscover && typeof pd.videoDiscover === 'object' && !Array.isArray(pd.videoDiscover)) ? pd.videoDiscover : {};
    Object.keys(disc).forEach(k => { (Array.isArray(disc[k]) ? disc[k] : []).forEach(visit); });
    (Array.isArray(pd && pd.videoWorks) ? pd.videoWorks : []).forEach(visit);
  }

  // 遍历一个 phoneData 里所有书对象（readingBooks + readingDiscover.long/short，按引用去重），对每个调 fn。
  function _readingCoverEach(pd, fn) {
    const seen = new Set();
    const visit = (b) => { if (b && typeof b === 'object' && !seen.has(b)) { seen.add(b); fn(b); } };
    (Array.isArray(pd && pd.readingBooks) ? pd.readingBooks : []).forEach(visit);
    const disc = pd && pd.readingDiscover;
    if (Array.isArray(disc)) { disc.forEach(visit); }
    else if (disc && typeof disc === 'object') {
      (Array.isArray(disc.long) ? disc.long : []).forEach(visit);
      (Array.isArray(disc.short) ? disc.short : []).forEach(visit);
    }
  }

  // 遍历一个 phoneData 里所有电台节目对象（radioPrograms 各频道数组，含 __mine__），对每个调 fn。
  function _radioCoverEach(pd, fn) {
    const progs = (pd && pd.radioPrograms && typeof pd.radioPrograms === 'object' && !Array.isArray(pd.radioPrograms)) ? pd.radioPrograms : {};
    Object.keys(progs).forEach(k => { (Array.isArray(progs[k]) ? progs[k] : []).forEach(p => fn(p)); });
  }

  // 取 conversations 数组（真实来源在 gameState 的 conversations 项）
  async function _getConversations() {
    const gs = await DB.get('gameState', 'conversations');
    return (gs && Array.isArray(gs.value)) ? gs.value : [];
  }

  // 扫描所有对话的 phoneData 内联图片，返回 [{convId, convName, total, cats:{key:bytes}}]，只含有图的对话
  async function scanPhoneImages() {
    const convs = await _getConversations();
    const result = [];
    for (const conv of convs) {
      const pd = conv && conv.phoneData;
      if (!pd || typeof pd !== 'object') continue;
      const cats = {};
      let total = 0;
      for (const cat of _PHONE_IMG_CATS) {
        let bytes = 0;
        try { bytes = cat.scan(pd) || 0; } catch(_) {}
        if (bytes > 0) { cats[cat.key] = bytes; total += bytes; }
      }
      if (total > 0) {
        result.push({ convId: conv.id, convName: conv.name || '未命名对话', total, cats });
      }
    }
    result.sort((a, b) => b.total - a.total);
    return result;
  }

  // 内联图片类别元信息（给 UI 显示用）
  function getPhoneImageCats() {
    return _PHONE_IMG_CATS.map(c => ({ key: c.key, label: c.label }));
  }

  // 清理某个对话指定类别的内联图片。catKeys 不传或为空数组表示清理该对话所有类别。
  // 返回清理后是否有改动。改动会写回 gameState 的 conversations。
  async function clearPhoneImages(convId, catKeys) {
    const gs = await DB.get('gameState', 'conversations');
    const convs = (gs && Array.isArray(gs.value)) ? gs.value : [];
    const conv = convs.find(c => c && c.id === convId);
    if (!conv || !conv.phoneData) return false;
    const keys = (Array.isArray(catKeys) && catKeys.length) ? catKeys : _PHONE_IMG_CATS.map(c => c.key);
    let changed = false;
    for (const cat of _PHONE_IMG_CATS) {
      if (!keys.includes(cat.key)) continue;
      try { if (cat.clear(conv.phoneData)) changed = true; } catch(_) {}
    }
    if (changed) {
      await DB.put('gameState', { key: 'conversations', value: convs });
    }
    return changed;
  }

  // 浏览器存储配额估算：返回 {usage, quota, supported}，字节。不支持时 supported=false
  async function getStorageEstimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        return { usage: est.usage || 0, quota: est.quota || 0, supported: true };
      }
    } catch(_) {}
    return { usage: 0, quota: 0, supported: false };
  }

  return { exportAll, exportTextOnly, exportLite, importAll, getLastExportAt,
           getStorageStats, listDrawnImages, getDrawnImageData, deleteDrawnImages, deleteDrawnImagesBefore,
           scanPhoneImages, getPhoneImageCats, clearPhoneImages, getStorageEstimate };
})();