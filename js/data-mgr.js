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

      _emit('version', 4);
      _emit('exportTime', new Date().toISOString());
      _emit('messages', await _safeGetAll('messages'));
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
      _emit('npcAvatars', npcAvatars);
      _emit('drawnImages', drawnImages);
      _emit('lorebooks', lorebooks);
      // 兼容别名：避免外部检查工具/旧脚本只认 snake_case 时误以为没打包
      _emit('single_cards', singleCards);
      _emit('npc_avatars', npcAvatars);
      _emit('drawn_images', drawnImages);
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

        if (!await UI.showConfirm('导入存档', '导入将覆盖当前所有数据，确定继续？')) return;

        // 清空
        await _safeClear('messages');
        await _safeClear('memories');
        await _safeClear('settings');
        await _safeClear('characters');
        await _safeClear('gameState');
        await _safeClear('worldviews');
        await _safeClear('archives');
        await _safeClear('summaries');
        await _safeClear('singleCards');
        await _safeClear('npcAvatars');
        await _safeClear('drawnImages');
        await _safeClear('lorebooks');

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
        const importedNpcAvatars = data.npcAvatars || data.npc_avatars || [];
        const importedDrawnImages = data.drawnImages || data.drawn_images || [];
        for (const c of importedSingleCards) await _safePut('singleCards', c);
        for (const a of importedNpcAvatars) await _safePut('npcAvatars', a);
        for (const img of importedDrawnImages) await _safePut('drawnImages', img);
        // v4：lorebooks（v3 之前没这个字段，老存档直接跳过）
        for (const lb of (data.lorebooks || [])) await _safePut('lorebooks', lb);
        if (data.themeConfig) localStorage.setItem('themeConfig', data.themeConfig);
        if (data.themeCustomPresets) localStorage.setItem('themeCustomPresets', data.themeCustomPresets);

        await UI.showAlert('导入成功', '总存档已恢复，页面将自动刷新');
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

  return { exportAll, importAll, getLastExportAt };
})();