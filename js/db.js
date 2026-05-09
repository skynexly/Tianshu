/**
 * IndexedDB 封装 — 本地持久化存储
 */
const DB = (() => {
  const DB_NAME = 'TextGameEngine';
  const DB_VERSION = 8;
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
    ttsCache:  { keyPath: 'key', indexes: ['accessedAt'] }
  };

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
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
      req.onsuccess = () => { db = req.result; resolve(db); };
    });
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

  return { open, put, get, getAll, del, clear, getAllByIndex, deleteByIndex };
})();