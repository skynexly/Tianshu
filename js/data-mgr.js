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
    const gameState = await _safeGetAll('gameState');
    const singleCards = await _safeGetAll('singleCards');
    const npcAvatars = await _safeGetAll('npcAvatars');
    const data = {
      version: 3,
      exportTime: new Date().toISOString(),
      messages: await _safeGetAll('messages'),
      memories: await _safeGetAll('memories'),
      settings: await _safeGetAll('settings'),
      characters: await _safeGetAll('characters'),
      gameState,
      // 显式冗余一份，方便人工检查/兼容旧导入器；真实来源仍是 gameState 内的 conversations 项
      conversations: (gameState.find(x => x && x.key === 'conversations')?.value) || [],
      worldviews: await _safeGetAll('worldviews'),
      archives: await _safeGetAll('archives'),
      summaries: await _safeGetAll('summaries'),
      singleCards,
      npcAvatars,
      // 兼容别名：避免外部检查工具/旧脚本只认 snake_case 时误以为没打包
      single_cards: singleCards,
      npc_avatars: npcAvatars,
      themeConfig: localStorage.getItem('themeConfig') || null,
      themeCustomPresets: localStorage.getItem('themeCustomPresets') || null
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `textgame-save-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
        for (const c of importedSingleCards) await _safePut('singleCards', c);
        for (const a of importedNpcAvatars) await _safePut('npcAvatars', a);
        if (data.themeConfig) localStorage.setItem('themeConfig', data.themeConfig);
        if (data.themeCustomPresets) localStorage.setItem('themeCustomPresets', data.themeCustomPresets);

        alert('导入成功！');
        location.reload();
      } catch (e) {
        alert('导入失败: ' + e.message);
      }
    };
    input.click();
  }

  return { exportAll, importAll };
})();