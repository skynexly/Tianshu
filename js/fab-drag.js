// v687.27：FAB 拖动逻辑
// 适用 .floating-fab 三个：phone-fab / gaiden-fab / backstage-fab
//
// 交互：
//   - 长按 220ms → 进入拖动模式（视觉反馈：放大 + 阴影加深）
//   - 拖动中：跟随手指/光标，自动改 left/top（删除原 right/transform）
//   - 短按（< 220ms 或移动 < 6px）→ 正常触发 onclick
//   - 拖动结束：clamp 到视口边界，写 localStorage（按 id 分别存）
//   - 页面加载/fab 显示时：从 localStorage 恢复位置
//   - resize：clamp 一次防超出（窗口变小后位置可能在屏幕外）
window.FabDrag = (function() {
  'use strict';

  const STORAGE_KEY = 'fab_positions'; // { phone-fab: {x, y}, ... }
  const LONG_PRESS_MS = 220;
  const MOVE_THRESHOLD = 6;
  const EDGE_PADDING = 4; // 距离视口边缘最少留白

  function _readPositions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch(_) { return {}; }
  }

  function _writePositions(obj) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj || {})); } catch(_) {}
  }

  function _savePos(id, x, y) {
    const all = _readPositions();
    all[id] = { x, y };
    _writePositions(all);
  }

  function _clamp(x, y, w, h) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxX = vw - w - EDGE_PADDING;
    const maxY = vh - h - EDGE_PADDING;
    return {
      x: Math.max(EDGE_PADDING, Math.min(maxX, x)),
      y: Math.max(EDGE_PADDING, Math.min(maxY, y))
    };
  }

  // 把 fab 改成走 left/top 定位（清掉原来的 right/bottom/transform）
  function _applyPos(el, x, y) {
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
  }

  // 给单个 fab 绑定拖动
  function attach(el) {
    if (!el || el._fabDragAttached) return;
    el._fabDragAttached = true;

    const id = el.id;
    let startX = 0, startY = 0;        // 指针起始视口坐标
    let elStartX = 0, elStartY = 0;     // 元素起始 left/top
    let pressTimer = null;
    let dragging = false;
    let moved = false;
    let suppressClick = false;

    function _getPoint(e) {
      if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    }

    function _onStart(e) {
      // 多指/右键忽略
      if (e.touches && e.touches.length > 1) return;
      if (e.button !== undefined && e.button !== 0) return;
      const pt = _getPoint(e);
      startX = pt.x; startY = pt.y;
      const rect = el.getBoundingClientRect();
      elStartX = rect.left;
      elStartY = rect.top;
      moved = false;
      dragging = false;

      pressTimer = setTimeout(() => {
        // 长按到时——进入拖动模式
        dragging = true;
        el.classList.add('fab-dragging');
        // 触发轻微振动（如果设备支持）
        try { navigator.vibrate && navigator.vibrate(10); } catch(_) {}
      }, LONG_PRESS_MS);

      // 监听 move/end
      if (e.type === 'touchstart') {
        document.addEventListener('touchmove', _onMove, { passive: false });
        document.addEventListener('touchend', _onEnd, { passive: false });
        document.addEventListener('touchcancel', _onEnd, { passive: false });
      } else {
        document.addEventListener('mousemove', _onMove);
        document.addEventListener('mouseup', _onEnd);
      }
    }

    function _onMove(e) {
      const pt = _getPoint(e);
      const dx = pt.x - startX;
      const dy = pt.y - startY;
      if (!moved && Math.hypot(dx, dy) > MOVE_THRESHOLD) {
        moved = true;
      }
      if (!dragging) {
        // 还没进入拖动模式：移动超阈值就取消长按计时（但不视为拖动）
        if (moved) { clearTimeout(pressTimer); pressTimer = null; }
        return;
      }
      // 拖动中
      if (e.cancelable) e.preventDefault();
      const rect = el.getBoundingClientRect();
      const next = _clamp(elStartX + dx, elStartY + dy, rect.width, rect.height);
      _applyPos(el, next.x, next.y);
    }

    function _onEnd(e) {
      clearTimeout(pressTimer); pressTimer = null;
      if (dragging) {
        dragging = false;
        el.classList.remove('fab-dragging');
        // 写位置
        const rect = el.getBoundingClientRect();
        _savePos(id, rect.left, rect.top);
        // 抑制本次 click（不打开手机/番外/后台）
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 100);
      }
      document.removeEventListener('touchmove', _onMove);
      document.removeEventListener('touchend', _onEnd);
      document.removeEventListener('touchcancel', _onEnd);
      document.removeEventListener('mousemove', _onMove);
      document.removeEventListener('mouseup', _onEnd);
    }

    // 拦 click：如果刚拖动结束就吞掉
    el.addEventListener('click', (e) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }, true);

    el.addEventListener('touchstart', _onStart, { passive: true });
    el.addEventListener('mousedown', _onStart);

    // 应用已存的位置
    const saved = _readPositions()[id];
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      // 等元素布局完再读 size 然后 clamp
      requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const c = _clamp(saved.x, saved.y, rect.width, rect.height);
        _applyPos(el, c.x, c.y);
      });
    }
  }

  // 自动给所有 .floating-fab 绑（包括动态后续添加的）
  function attachAll() {
    document.querySelectorAll('.floating-fab').forEach(attach);
  }

  // resize 时所有 fab 重新 clamp（防窗口变小后跑出屏幕）
  function _onResize() {
    document.querySelectorAll('.floating-fab').forEach(el => {
      if (!el._fabDragAttached) return;
      const saved = _readPositions()[el.id];
      if (!saved) return;
      const rect = el.getBoundingClientRect();
      const c = _clamp(saved.x, saved.y, rect.width, rect.height);
      _applyPos(el, c.x, c.y);
      _savePos(el.id, c.x, c.y);
    });
  }

  // ===== 显隐开关（用户偏好，存 localStorage，跨对话）=====
  // 用独立 class fab-force-hidden 叠加，不动各 fab 自身的 hidden 业务逻辑：
  //   业务逻辑决定"逻辑上该不该显示"，本开关决定"用户允不允许显示"，两者与关系。
  //
  // v2：从单一总开关升级为按 id 独立控制。
  //   旧存储 VISIBLE_KEY('fab_visible', '0'/'1') 仍兼容读取（作为迁移默认值）。
  //   新存储 VIS_MAP_KEY('fab_visible_map') = { 'phone-fab':true/false, ... }
  const VISIBLE_KEY = 'fab_visible';          // 旧：全局总开关（保留兼容）
  const VIS_MAP_KEY = 'fab_visible_map';      // 新：按 id 独立开关
  const FAB_IDS = ['phone-fab', 'gaiden-fab', 'backstage-fab'];

  function _readVisMap() {
    try {
      const raw = localStorage.getItem(VIS_MAP_KEY);
      if (raw) return JSON.parse(raw) || {};
    } catch(_) {}
    // 没有新存储：从旧总开关迁移（旧存了 '0' 则三个都关，否则都开）
    const legacyHidden = localStorage.getItem(VISIBLE_KEY) === '0';
    const map = {};
    FAB_IDS.forEach(id => { map[id] = !legacyHidden; });
    return map;
  }

  function _writeVisMap(map) {
    try { localStorage.setItem(VIS_MAP_KEY, JSON.stringify(map || {})); } catch(_) {}
  }

  // 单个球是否允许显示（默认显示：只有显式存 false 才隐藏）
  function isVisible(id) {
    const map = _readVisMap();
    if (typeof id === 'string') return map[id] !== false;
    // 不传 id：三个都开才算"全局可见"（兼容旧调用语义）
    return FAB_IDS.every(fid => map[fid] !== false);
  }

  // 按各自开关刷新三个 fab 的强制隐藏态
  function apply() {
    const map = _readVisMap();
    document.querySelectorAll('.floating-fab').forEach(el => {
      const hide = map[el.id] === false;
      el.classList.toggle('fab-force-hidden', hide);
    });
  }

  function setVisible(id, v) {
    // 兼容旧调用 setVisible(true/false) —— 一次设置三个
    if (typeof id === 'boolean') {
      const map = _readVisMap();
      FAB_IDS.forEach(fid => { map[fid] = id; });
      _writeVisMap(map);
      apply();
      return;
    }
    const map = _readVisMap();
    map[id] = !!v;
    _writeVisMap(map);
    apply();
  }

  // ===== 悬浮球自定义图标 + 尺寸（桌宠）=====
  // 图标存 AppIcons（key: __fab_phone__/__fab_gaiden__/__fab_backstage__），尺寸全局。
  const _FAB_ICON_KEY = {
    'phone-fab': '__fab_phone__',
    'gaiden-fab': '__fab_gaiden__',
    'backstage-fab': '__fab_backstage__',
  };
  const _FAB_SIZE_PX = { sm: 36, md: 52, lg: 72, xl: 96 };

  // 应用自定义图标 + 尺寸到三个 fab；改完 reclamp 一次防放大后越界。
  function applyFabCustom() {
    if (typeof AppIcons === 'undefined') return;
    let size = 'sm';
    try { size = AppIcons.getFabSize(); } catch(_) {}
    const px = _FAB_SIZE_PX[size] || 36;
    let bare = true;
    try { bare = AppIcons.getFabBare(); } catch(_) {}
    FAB_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      let icon = null;
      try { icon = AppIcons.get(_FAB_ICON_KEY[id]); } catch(_) {}
      // 尺寸（全局）：覆盖内联 width/height（gaiden/backstage 内联写死了 36px）
      el.style.setProperty('width', px + 'px', 'important');
      el.style.setProperty('height', px + 'px', 'important');
      // 图标
      let img = el.querySelector('.fab-custom-img');
      if (icon) {
        el.classList.add('fab-has-custom');
        el.classList.toggle('fab-custom', bare); // 异形开=裸露；关=保留 accent 圆底框
        if (!img) {
          img = document.createElement('img');
          img.className = 'fab-custom-img';
          el.insertBefore(img, el.firstChild);
        }
        // 非异形时图标塞进圆框，用 cover 填满更好看；异形用 contain 完整显示
        img.style.objectFit = bare ? 'contain' : 'cover';
        if (img.getAttribute('src') !== icon) img.src = icon;
        // 隐藏原生 SVG（保留在 DOM，恢复默认时复原）
        el.querySelectorAll(':scope > svg').forEach(s => { s.style.display = 'none'; });
      } else {
        el.classList.remove('fab-custom');
        el.classList.remove('fab-has-custom');
        if (img) img.remove();
        el.querySelectorAll(':scope > svg').forEach(s => { s.style.display = ''; });
      }
    });
    // reclamp：尺寸变了，位置可能越界
    try {
      document.querySelectorAll('.floating-fab').forEach(el => {
        if (!el._fabDragAttached) return;
        const saved = _readPositions()[el.id];
        if (!saved) return;
        const rect = el.getBoundingClientRect();
        const c = _clamp(saved.x, saved.y, rect.width, rect.height);
        _applyPos(el, c.x, c.y);
        _savePos(el.id, c.x, c.y);
      });
    } catch(_) {}
  }

  // 供 UI 用：换图标 / 恢复默认 / 读图标
  function getFabIconKey(fabId) { return _FAB_ICON_KEY[fabId] || null; }

  // 初始化
  function init() {
    attachAll();
    apply();
    try { applyFabCustom(); } catch(_) {}
    window.addEventListener('resize', _onResize);
    window.addEventListener('orientationchange', _onResize);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { attach, attachAll, init, isVisible, setVisible, apply, applyFabCustom, getFabIconKey, FAB_IDS };
})();
