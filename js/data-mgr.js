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

  // ===== 可复用内核：生成存档 JSON 字符串 =====
  // mode: 'full'（含全部图片）/ 'lite'（文字+头像，跳过生成图库）/ 'text'（纯文字，剥所有图）
  // 返回 JSON 字符串。三个 export 函数与云备份共用这套拼装逻辑。
  async function buildSaveJson(mode) {
    mode = (mode === 'lite' || mode === 'text') ? mode : 'full';
    const keepAvatar = (mode === 'lite');   // lite 保留头像小图；text 全剥；full 用原始数据不剥
    const strip = (v) => (mode === 'full') ? v : _stripDataUrls(v, keepAvatar);

    const gameState = strip(await _safeGetAll('gameState'));
    const conversations = (gameState.find(x => x && x.key === 'conversations')?.value) || [];

    const parts = [];
    let _first = true;
    const _emit = (key, value) => {
      parts.push((_first ? '{' : ',') + JSON.stringify(key) + ':');
      parts.push(JSON.stringify(value === undefined ? null : value));
      _first = false;
    };
    // 大数组逐条 stringify，避免一次性生成上百 MB 巨串触发 OOM（仅 full 模式的图片表用到）
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
    if (mode === 'lite') _emit('lite', true);
    if (mode === 'text') _emit('textOnly', true);
    _emit('exportTime', new Date().toISOString());

    if (mode === 'full') {
      await _emitArray('messages', await _safeGetAll('messages'));
    } else {
      _emit('messages', strip(await _safeGetAll('messages')));
    }
    _emit('memories', strip(await _safeGetAll('memories')));
    _emit('settings', strip(await _safeGetAll('settings')));
    _emit('characters', strip(await _safeGetAll('characters')));
    _emit('gameState', gameState);
    _emit('conversations', conversations);
    _emit('worldviews', strip(await _safeGetAll('worldviews')));
    _emit('archives', strip(await _safeGetAll('archives')));
    _emit('summaries', strip(await _safeGetAll('summaries')));
    _emit('singleCards', strip(await _safeGetAll('singleCards')));
    _emit('lorebooks', strip(await _safeGetAll('lorebooks')));

    if (mode === 'full') {
      await _emitArray('npcAvatars', await _safeGetAll('npcAvatars'));
      await _emitArray('drawnImages', await _safeGetAll('drawnImages'));
    } else if (mode === 'lite') {
      _emit('npcAvatars', await _safeGetAll('npcAvatars'));   // 头像小图整表保留
      _emit('drawnImages', []);                                // 生成图库跳过
    } else {
      _emit('npcAvatars', []);
      _emit('drawnImages', []);
    }

    // 主题配置里可能含 chatBgImage/customFontData
    let themeConfig = localStorage.getItem('themeConfig') || null;
    let themePresets = localStorage.getItem('themeCustomPresets') || null;
    if (mode !== 'full') {
      try { if (themeConfig) themeConfig = JSON.stringify(_stripDataUrls(JSON.parse(themeConfig), keepAvatar)); } catch(_) {}
      try { if (themePresets) themePresets = JSON.stringify(_stripDataUrls(JSON.parse(themePresets), keepAvatar)); } catch(_) {}
    }
    _emit('themeConfig', themeConfig);
    _emit('themeCustomPresets', themePresets);
    parts.push('}');

    return parts.join('');
  }

  // 触发浏览器下载一个 JSON 字符串
  function _downloadJson(jsonStr, fileName) {
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    try { localStorage.setItem('tianshu_last_export_at', String(Date.now())); } catch(_) {}
  }

  // ===== 可复用内核：从一个已解析的存档对象覆盖 IndexedDB =====
  // 供本地文件导入与云备份恢复共用。不含 confirm/reload，调用方自行处理交互与刷新。
  async function importFromData(data) {
    if (!data || !data.version) throw new Error('无效的存档数据');
    const isTextOnly = !!data.textOnly;
    const isLite = !!data.lite;

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
      await _safeClear('npcAvatars');
    } else if (!isTextOnly) {
      await _safeClear('npcAvatars');
      await _safeClear('drawnImages');
    }

    for (const m of (data.messages || [])) await _safePut('messages', m);
    for (const m of (data.memories || [])) await _safePut('memories', m);
    for (const s of (data.settings || [])) await _safePut('settings', s);
    for (const c of (data.characters || [])) await _safePut('characters', c);
    const gameStateRows = Array.isArray(data.gameState) ? data.gameState.slice() : [];
    if (Array.isArray(data.conversations) && !gameStateRows.some(x => x && x.key === 'conversations')) {
      gameStateRows.push({ key: 'conversations', value: data.conversations });
    }
    for (const g of gameStateRows) await _safePut('gameState', g);
    for (const w of (data.worldviews || [])) await _safePut('worldviews', w);
    for (const a of (data.archives || [])) await _safePut('archives', a);
    for (const s of (data.summaries || [])) await _safePut('summaries', s);
    const importedSingleCards = data.singleCards || data.single_cards || [];
    for (const c of importedSingleCards) await _safePut('singleCards', c);
    if (isLite) {
      const importedNpcAvatars = data.npcAvatars || data.npc_avatars || [];
      for (const a of importedNpcAvatars) await _safePut('npcAvatars', a);
    } else if (!isTextOnly) {
      const importedNpcAvatars = data.npcAvatars || data.npc_avatars || [];
      const importedDrawnImages = data.drawnImages || data.drawn_images || [];
      for (const a of importedNpcAvatars) await _safePut('npcAvatars', a);
      for (const img of importedDrawnImages) await _safePut('drawnImages', img);
    }
    for (const lb of (data.lorebooks || [])) await _safePut('lorebooks', lb);
    if (data.themeConfig) localStorage.setItem('themeConfig', data.themeConfig);
    if (data.themeCustomPresets) localStorage.setItem('themeCustomPresets', data.themeCustomPresets);

    return { isLite, isTextOnly };
  }

  async function exportAll() {
    try {
      const jsonStr = await buildSaveJson('full');
      _downloadJson(jsonStr, `skynex-save-${new Date().toISOString().slice(0, 10)}.json`);
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
      const jsonStr = await buildSaveJson('text');
      _downloadJson(jsonStr, `skynex-save-text-${new Date().toISOString().slice(0, 10)}.json`);
      UI.showToast('已导出纯文字存档（不含图片）', 2500);
    } catch (e) {
      console.error('[DataMgr.exportTextOnly]', e);
      await UI.showAlert('导出失败', e.message || String(e));
    }
  }

  // 轻量导出：文字 + 各类头像（面具/单人卡/NPC），跳过生成图库与其它内嵌大图。
  async function exportLite() {
    try {
      const jsonStr = await buildSaveJson('lite');
      _downloadJson(jsonStr, `skynex-save-lite-${new Date().toISOString().slice(0, 10)}.json`);
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

        await importFromData(data);

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
    // 私聊图片：chatThreads 各会话消息里的 real_image（imageBase64 原图 + imageThumb 缩略图）。
    // 这是发图功能内联存的 base64，最容易堆到 GB 级。原图在识图后一般已被焚，这里主要清缩略图和未识图的原图。
    { key: 'chatImages', label: '私聊图片',
      scan: pd => { let s = 0; _chatImageEach(pd, m => { s += _strBytes(m && m.imageBase64) + _strBytes(m && m.imageThumb); }); return s; },
      clear: pd => { let c = false; _chatImageEach(pd, m => {
        if (m && _isDataUrl(m.imageBase64)) { m.imageBase64 = ''; c = true; }
        if (m && _isDataUrl(m.imageThumb)) { m.imageThumb = ''; c = true; }
      }); return c; } },
  ];

  // 遍历一个 phoneData 里所有私聊/群聊消息对象（chatThreads 各会话数组），对每个调 fn。
  function _chatImageEach(pd, fn) {
    const threads = (pd && pd.chatThreads && typeof pd.chatThreads === 'object' && !Array.isArray(pd.chatThreads)) ? pd.chatThreads : {};
    Object.keys(threads).forEach(k => { (Array.isArray(threads[k]) ? threads[k] : []).forEach(m => fn(m)); });
  }

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

  // ===== messages 仓快照图片深度清理 =====
  // 每条 AI 回复会存一份手机数据快照用于回滚，旧版本快照没剥净图片，把私聊原图
  // 一份份固化进了 messages，导致该仓膨胀到 GB 级。这里递归遍历每条消息，把值为
  // data:image/font/audio/video 的字符串清空（剧情正文/聊天记录/结构全部保留）。
  // 通用递归剥图：scanOnly=true 只统计不改。返回 { freed, count }。
  function _deepStripDataImages(root, scanOnly) {
    let freed = 0, count = 0;
    const seen = new WeakSet();
    function walk(v, setter) {
      if (typeof v === 'string') {
        if (/^data:(image|font|audio|video)\//i.test(v)) {
          freed += v.length; count++;
          if (!scanOnly && setter) setter('');
        }
        return;
      }
      if (!v || typeof v !== 'object') return;
      if (seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) walk(v[i], nv => { v[i] = nv; });
      } else {
        for (const k in v) walk(v[k], nv => { v[k] = nv; });
      }
    }
    walk(root, null);
    return { freed, count };
  }

  // 扫描 messages 仓内联图片占用（只统计）。返回 { total, msgHit, count, freed }
  async function scanMessageImages() {
    const all = await _safeGetAll('messages');
    let freed = 0, count = 0, msgHit = 0;
    for (const row of all) {
      const r = _deepStripDataImages(row, true);
      if (r.count) { freed += r.freed; count += r.count; msgHit++; }
    }
    return { total: all.length, msgHit, count, freed };
  }

  // 清理 messages 仓内联图片（就地剥图后写回改动过的行）。返回 { updated, count, freed }
  async function clearMessageImages() {
    const all = await _safeGetAll('messages');
    let freed = 0, count = 0, updated = 0;
    for (const row of all) {
      const r = _deepStripDataImages(row, false);
      if (r.count) { freed += r.freed; count += r.count; updated++; await _safePut('messages', row); }
    }
    return { updated, count, freed };
  }

  return { exportAll, exportTextOnly, exportLite, importAll, getLastExportAt,
           buildSaveJson, importFromData,
           getStorageStats, listDrawnImages, getDrawnImageData, deleteDrawnImages, deleteDrawnImagesBefore,
           scanPhoneImages, getPhoneImageCats, clearPhoneImages, getStorageEstimate,
           scanMessageImages, clearMessageImages };
})();