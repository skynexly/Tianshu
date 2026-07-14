/**
 * 手机 APP 图标自定义 — 全局共享
 * 存储：localStorage key = "phoneAppIcons"
 * 数据结构：{ [appId]: dataUrl }
 * 全局生效（所有对话/世界线共用），管理界面在「设置 → 手机图标」。
 */
const AppIcons = (() => {
  const LS_KEY = 'phoneAppIcons';

  // 可自定义的 app 清单（id / 默认图标名 / 显示名）。
  // 顺序 = 管理界面网格顺序。排除：待解锁(locked)、占位(placeholder)。
  const APP_DEFS = [
    { id: 'takeout',      icon: 'takeout',    name: '饿了咪' },
    { id: 'shop',         icon: 'shop',       name: '桃宝' },
    { id: 'heartsim_app', icon: 'heartsim',   name: '心动模拟' },
    { id: 'forum',        icon: 'forum',      name: '论坛' },
    { id: 'map',          icon: 'map',        name: '地图' },
    { id: 'moments',      icon: 'aperture',   name: '好友圈' },
    { id: 'memo',         icon: 'memo',       name: '备忘录' },
    { id: 'calendar',     icon: 'calendar',   name: '日历' },
    { id: 'settings',     icon: 'gear',       name: '设置' },
    { id: 'email',        icon: 'mail',       name: '邮箱' },
    { id: 'radio',        icon: 'radio',      name: '电台' },
    { id: 'feiniao',      icon: 'feiniao',    name: '飞鸟快递' },
    { id: 'youyu',        icon: 'youyu',      name: '游鱼小铺' },
    { id: 'cottage',      icon: 'cottage',    name: '小屋' },
    { id: 'wardrobe',     icon: 'wardrobe',   name: '衣橱' },
    { id: 'camera',       icon: 'polaroid',   name: '相机' },
    { id: 'chat',         icon: 'chat',       name: '聊天' },
    { id: 'minimize',     icon: 'phone-down', name: '收起手机' },
  ];

  let _cache = null; // { appId: dataUrl }

  function _load() {
    if (_cache) return _cache;
    try {
      const raw = localStorage.getItem(LS_KEY);
      _cache = raw ? (JSON.parse(raw) || {}) : {};
      if (typeof _cache !== 'object' || _cache === null) _cache = {};
    } catch (_) { _cache = {}; }
    return _cache;
  }

  function _persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(_cache || {})); } catch (e) { console.warn('[AppIcons] persist failed', e); }
  }

  // 把选中的图片压成图标尺寸（保留透明通道，用 png）
  function _compressToIcon(dataUrl, maxSide = 128) {
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
          } catch (_) { resolve(dataUrl); }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      } catch (_) { resolve(dataUrl); }
    });
  }

  // 取单个 app 的自定义图标 dataUrl（无则 null）
  function get(appId) {
    if (!appId) return null;
    const c = _load();
    return c[appId] || null;
  }

  function getAll() {
    return { ..._load() };
  }

  // 设置某 app 的自定义图标（dataUrl 已选好）
  async function set(appId, dataUrl) {
    if (!appId || !dataUrl) return;
    const compressed = await _compressToIcon(dataUrl);
    _load();
    _cache[appId] = compressed;
    _persist();
  }

  // 恢复默认（清除自定义）
  function remove(appId) {
    if (!appId) return;
    _load();
    if (appId in _cache) { delete _cache[appId]; _persist(); }
  }

  return { APP_DEFS, get, getAll, set, remove };
})();
