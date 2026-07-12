/**
 * IndexedDB 封装 — 本地持久化存储
 */
const DB = (() => {
  const DB_NAME = 'TextGameEngine';
  const DB_VERSION = 13;
  let db = null;

  const STORES = {
    messages:  { keyPath: 'id', indexes: ['branchId', 'parentId', 'timestamp', 'conversationId'] },
    memories:  { keyPath: 'id', indexes: ['type', 'keywords'] },
    settings:  { keyPath: 'key' },
    characters:{ keyPath: 'id' },
    worldviews:{ keyPath: 'id' },
    gameState: { keyPath: 'key' },
    archives:  { keyPath: 'id', indexes: ['conversationId', 'archivedAt'] },
    summaries: { keyPath: 'conversationId' },
    singleCards: { keyPath: 'id', indexes: ['updated'] },
    npcAvatars: { keyPath: 'id', indexes: ['updated'] },
    ttsCache:  { keyPath: 'key', indexes: ['accessedAt'] },
    drawnImages: { keyPath: 'id', indexes: ['createdAt'] },  // v9：生图独立存储，消息只存引用
    lorebooks: { keyPath: 'id', indexes: ['updated'] },  // v10：世界书（独立资源，可挂角色/世界观/对话）
    musicTracks: { keyPath: 'id', indexes: ['addedAt'] },  // v11：音乐库（全局共享，存音频Blob或外链）
    importedBooks: { keyPath: 'id', indexes: ['addedAt'] },  // v12：导入电子书母本（全局共享，正文/目录；阅读痕迹仍按对话存在 readingBooks）
    stickers: { keyPath: 'id', indexes: ['createdAt'] }  // v13：表情包（全局共享，dataUrl+name，手机聊天通用）
  };

  function open() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) { reject(e); return; }
      req.onerror = () => reject(req.error);
      // 版本升级被其他标签页占用而阻塞：明确 reject，避免永久挂起
      req.onblocked = () => {
        console.warn('[DB] open blocked（可能有其他标签页占用旧版本）');
        reject(new Error('数据库被其他标签页占用，请关闭其他天枢城页面后重试'));
      };
      req.onupgradeneeded = (e) => {
        const _db = e.target.result;
        const _tx = e.target.transaction; // 升级事务，可拿已存在的 store
        const oldVersion = e.oldVersion || 0;

        for (const [name, opts] of Object.entries(STORES)) {
          let store;
          if (!_db.objectStoreNames.contains(name)) {
            store = _db.createObjectStore(name, { keyPath: opts.keyPath });
          } else {
            // 已存在的 store：通过升级事务拿到，下面给它补缺失的索引
            store = _tx.objectStore(name);
          }
          if (opts.indexes) {
            opts.indexes.forEach(idx => {
              if (!store.indexNames.contains(idx)) {
                store.createIndex(idx, idx, { unique: false });
              }
            });
          }
        }

        // v7 迁移：messages 老数据可能没有 conversationId 字段（早期默认 'default'）
        // 遍历一次，把缺字段的填上 'default'，让 conversationId 索引能命中
        if (oldVersion < 7) {
          try {
            const store = _tx.objectStore('messages');
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = (ev) => {
              const cur = ev.target.result;
              if (cur) {
                if (!cur.value.conversationId) {
                  cur.value.conversationId = 'default';
                  cur.update(cur.value);
                }
                cur.continue();
              }
            };
          } catch (mErr) {
            console.warn('[DB] v7 migration failed:', mErr);
          }
        }
      };
      req.onsuccess = () => {
        db = req.result;
        // 别的标签页要升级版本时，主动关掉本连接，避免把对方 block 住
        db.onversionchange = () => {
          try { db.close(); } catch(_) {}
          db = null;
          console.warn('[DB] versionchange：连接已主动关闭');
        };
        // 连接被浏览器意外断开（挂起/内存压力等）：置 null，下次 openWithRetry 会重开
        db.onclose = () => {
          db = null;
          console.warn('[DB] 连接被关闭');
        };
        resolve(db);
      };
    });
  }

  // 带重试的打开：偶发首次打开失败（连接不稳）时重试，避免直接停摆
  async function openWithRetry(maxRetries = 2) {
    let lastErr = null;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await open();
      } catch (e) {
        lastErr = e;
        console.warn(`[DB] open 第 ${i + 1} 次失败：`, e && e.message ? e.message : e);
        // blocked 类错误重试无意义（需用户关标签页），直接抛出
        if (e && /占用/.test(e.message || '')) throw e;
        if (i < maxRetries) await new Promise(r => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw lastErr;
  }

  function tx(storeName, mode = 'readonly') {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function put(storeName, data) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName, 'readwrite').put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function get(storeName, key) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function getAll(storeName) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function del(storeName, key) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName, 'readwrite').delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function clear(storeName) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName, 'readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function getAllByIndex(storeName, indexName, value) {
    return new Promise((resolve, reject) => {
      const store = tx(storeName);
      const index = store.index(indexName);
      const req = index.getAll(value);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // 按索引值批量删除（避免拉全表后再 filter）
  // 用游标，对索引匹配的每条记录调用 delete
  function deleteByIndex(storeName, indexName, value) {
    return new Promise((resolve, reject) => {
      const store = tx(storeName, 'readwrite');
      const index = store.index(indexName);
      const req = index.openCursor(value);
      let count = 0;
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) {
          cur.delete();
          count++;
          cur.continue();
        } else {
          resolve(count);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  return { open, openWithRetry, put, get, getAll, del, clear, getAllByIndex, deleteByIndex };
})();