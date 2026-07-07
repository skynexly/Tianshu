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

  // ===== 全局显隐总开关（用户偏好，存 localStorage，跨对话）=====
  // 用独立 class fab-force-hidden 叠加，不动各 fab 自身的 hidden 业务逻辑：
  //   业务逻辑决定"逻辑上该不该显示"，本开关决定"用户允不允许显示"，两者与关系。
  const VISIBLE_KEY = 'fab_visible';

  function isVisible() {
    // 默认显示（只有显式存了 '0' 才隐藏）
    return localStorage.getItem(VISIBLE_KEY) !== '0';
  }

  // 按当前开关刷新三个 fab 的强制隐藏态
  function apply() {
    const hide = !isVisible();
    document.querySelectorAll('.floating-fab').forEach(el => {
      el.classList.toggle('fab-force-hidden', hide);
    });
  }

  function setVisible(v) {
    try { localStorage.setItem(VISIBLE_KEY, v ? '1' : '0'); } catch(_) {}
    apply();
  }

  // 初始化
  function init() {
    attachAll();
    apply();
    window.addEventListener('resize', _onResize);
    window.addEventListener('orientationchange', _onResize);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { attach, attachAll, init, isVisible, setVisible, apply };
})();
