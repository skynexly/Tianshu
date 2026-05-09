/**
 * ColorPicker — 色环 + SV方块 + 明暗度 + 透明度
 * 调用方式：ColorPicker.open(targetEl, hexColor, opacity, callback)
 *   - targetEl : 触发按钮（定位参考）
 *   - hexColor  : 初始色 '#rrggbb'
 *   - opacity   : 初始透明度 0~1
 *   - callback  : fn(hex, opacity) 每次变化时回调
 */
const ColorPicker = (() => {

  // ── 色彩转换 ──────────────────────────────────────────────
  function hsv2rgb(h, s, v) {
    const f = n => {
      const k = (n + h / 60) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [Math.round(f(5)*255), Math.round(f(3)*255), Math.round(f(1)*255)];
  }
  function rgb2hex(r, g, b) {
    return '#' + [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
  }
  function hex2rgb(hex) {
    hex = hex.replace('#','');
    if (hex.length === 3) hex = hex.split('').map(c=>c+c).join('');
    return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
  }
  function rgb2hsv(r, g, b) {
    r/=255; g/=255; b/=255;
    const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
    let h=0, s= max===0 ? 0 : d/max, v=max;
    if (d!==0) {
      if (max===r) h=((g-b)/d+6)%6;
      else if (max===g) h=(b-r)/d+2;
      else h=(r-g)/d+4;
      h*=60;
    }
    return [h, s, v];
  }

  // ── 状态 ─────────────────────────────────────────────────
  let state = { h:0, s:1, v:1, a:1 };
  let _initState = null;
  let cb = null;
  let popEl = null;
  let ringCanvas, svCanvas;
  const RING_R = 96, RING_W = 18, SV_SIZE = 100;

  // ── 构建弹窗 ─────────────────────────────────────────────
  function buildPopup() {
    // 外层复用 .modal 体系
    const overlay = document.createElement('div');
    overlay.id = 'cp-overlay';
    overlay.className = 'modal hidden';
    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) close();
    });
    overlay.addEventListener('touchstart', e => {
      if (e.target === overlay) close();
    }, {passive:true});

    const el = document.createElement('div');
    el.id = 'cp-popup';
    el.className = 'modal-content';
    el.style.cssText = 'display:flex;flex-direction:column;overflow:hidden;padding:0';
    el.innerHTML = `
<div id="cp-scroll-body" style="flex:1;min-height:0;overflow-y:auto;padding:20px 20px 16px">
<h3 id="cp-title" style="margin-bottom:4px">选择颜色</h3>
<div id="cp-ring-wrap">
  <canvas id="cp-ring" width="${RING_R*2}" height="${RING_R*2}"></canvas>
  <canvas id="cp-sv"   width="${SV_SIZE}" height="${SV_SIZE}"></canvas>
</div>
<div id="cp-sliders">
  <div class="cp-slider-row">
    <span class="cp-slider-lbl">明暗</span>
    <div class="cp-track-wrap">
      <canvas id="cp-bright-track" width="200" height="12"></canvas>
      <div id="cp-bright-thumb" class="cp-thumb"></div>
    </div>
    <span id="cp-bright-val" class="cp-val">100</span>
  </div>
  <div class="cp-slider-row">
    <span class="cp-slider-lbl">透明</span>
    <div class="cp-track-wrap">
      <canvas id="cp-alpha-track" width="200" height="12"></canvas>
      <div id="cp-alpha-thumb" class="cp-thumb"></div>
    </div>
    <span id="cp-alpha-val" class="cp-val">100</span>
  </div>
</div>
<div id="cp-hex-row">
  <div id="cp-preview"></div>
  <input id="cp-hex-input" type="text" maxlength="7" spellcheck="false" placeholder="#rrggbb">
</div>
</div>
<div class="modal-actions" style="flex-shrink:0;padding:12px 20px">
  <button id="cp-cancel"  style="flex:1;background:none;border:1px solid var(--border);color:var(--text-secondary)">取消</button>
  <button id="cp-confirm" style="flex:1">确定</button>
</div>`;

    overlay.appendChild(el);
    document.body.appendChild(overlay);

    // style — 只补 colorpicker 专属样式，其余沿用 .modal / .modal-content / .modal-actions
    const style = document.createElement('style');
    style.id = 'cp-style';
    style.textContent = `
#cp-popup.modal-content {
  max-width: 300px;
  width: 90vw;
  user-select: none;
  padding: 0;
  overflow: hidden;
  max-height: none;
}
#cp-scroll-body > * { margin-bottom: 14px; }
#cp-scroll-body > *:last-child { margin-bottom: 0; }
#cp-ring-wrap {
  position:relative; width:${RING_R*2}px; height:${RING_R*2}px;
  margin:0 auto 14px; flex-shrink:0;
}

#cp-ring { position:absolute; top:0; left:0; cursor:crosshair; touch-action:none; }
#cp-sv   {
  position:absolute;
  top:${RING_R - SV_SIZE/2}px;
  left:${RING_R - SV_SIZE/2}px;
  cursor:crosshair; border-radius:4px; touch-action:none;
}
#cp-sliders { display:flex; flex-direction:column; gap:12px; flex-shrink:0; }
.cp-slider-row { display:flex; align-items:center; gap:10px; }
.cp-slider-lbl { font-size:12px; color:var(--text-secondary); width:28px; flex-shrink:0; }
.cp-val        { font-size:12px; color:var(--text-secondary); width:28px; text-align:right; flex-shrink:0; }
.cp-track-wrap { position:relative; flex:1; height:14px; touch-action:none; }
.cp-track-wrap canvas { position:absolute; top:0; left:0; width:100%; height:100%; border-radius:7px; pointer-events:none; }
.cp-thumb {
  position:absolute; top:50%; transform:translate(-50%,-50%);
  width:20px; height:20px; border-radius:50%;
  background:#fff; border:2px solid rgba(0,0,0,.4);
  box-shadow:0 1px 5px rgba(0,0,0,.5);
  pointer-events:none;
}
#cp-hex-row { display:flex; align-items:center; gap:10px; flex-shrink:0; }
#cp-preview {
  width:32px; height:32px; border-radius:8px;
  border:1px solid var(--border); flex-shrink:0;
  background: repeating-conic-gradient(#555 0 25%, #333 0 50%) 0 0/8px 8px;
}
#cp-hex-input {
  flex:1; background:var(--bg-tertiary); border:1px solid var(--border); border-radius:6px;
  color:var(--text); font-size:13px; padding:7px 10px; outline:none;
  font-family:monospace;
}
#cp-hex-input:focus { border-color:var(--accent); }
`;
    document.head.appendChild(style);

    // ── 软键盘适配：用 visualViewport 动态限高 ──
    function fitHeight() {
      const vv = window.visualViewport;
      if (vv) {
        const vh = vv.height;
        el.style.maxHeight = (vh * 0.85) + 'px';
        // 让遮罩层也跟随 visualViewport 定位
        overlay.style.height = vh + 'px';
        overlay.style.top = vv.offsetTop + 'px';
      } else {
        el.style.maxHeight = (window.innerHeight * 0.85) + 'px';
      }
    }
    fitHeight();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitHeight);
      window.visualViewport.addEventListener('scroll', fitHeight);
    } else {
      window.addEventListener('resize', fitHeight);
    }

    return el;
  }

  // ── 绘制色环 ─────────────────────────────────────────────
  function drawRing() {
    const cv = ringCanvas, ctx = cv.getContext('2d');
    const cx = RING_R, cy = RING_R, r1 = RING_R - RING_W, r2 = RING_R;
    ctx.clearRect(0,0,cv.width,cv.height);
    for (let deg=0; deg<360; deg++) {
      const rad = deg * Math.PI / 180;
      const nrad = (deg+1) * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(cx + r1*Math.cos(rad), cy + r1*Math.sin(rad));
      ctx.arc(cx, cy, r2, rad, nrad);
      ctx.arc(cx, cy, r1, nrad, rad, true);
      ctx.closePath();
      ctx.fillStyle = `hsl(${deg},100%,50%)`;
      ctx.fill();
    }
    // 指针
    const pRad = (state.h - 90) * Math.PI / 180;
    const rm = (r1 + r2) / 2;
    const px = cx + rm * Math.cos(pRad + Math.PI/2);
    const py = cy + rm * Math.sin(pRad + Math.PI/2);
    ctx.beginPath();
    ctx.arc(px, py, 8, 0, Math.PI*2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = `hsl(${state.h},100%,50%)`;
    ctx.fill();
  }

  function drawSV() {
    const cv = svCanvas, ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    // 色相底色
    const [hr,hg,hb] = hsv2rgb(state.h, 1, 1);
    ctx.fillStyle = `rgb(${hr},${hg},${hb})`;
    ctx.fillRect(0,0,W,H);
    // 白色横向渐变
    const wg = ctx.createLinearGradient(0,0,W,0);
    wg.addColorStop(0,'rgba(255,255,255,1)');
    wg.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle = wg; ctx.fillRect(0,0,W,H);
    // 黑色纵向渐变
    const bg2 = ctx.createLinearGradient(0,0,0,H);
    bg2.addColorStop(0,'rgba(0,0,0,0)');
    bg2.addColorStop(1,'rgba(0,0,0,1)');
    ctx.fillStyle = bg2; ctx.fillRect(0,0,W,H);
    // 指针
    const px = state.s * W, py = (1-state.v) * H;
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, Math.PI*2);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }

  // ── 绘制滑块轨道 ─────────────────────────────────────────
  function drawBrightTrack() {
    const cv = document.getElementById('cp-bright-track');
    if (!cv) return;
    const ctx = cv.getContext('2d'), W=cv.width, H=cv.height;
    const [hr,hg,hb] = hsv2rgb(state.h, state.s, 1);
    const g = ctx.createLinearGradient(0,0,W,0);
    g.addColorStop(0,'#000');
    g.addColorStop(1,`rgb(${hr},${hg},${hb})`);
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
    // 更新 thumb
    const t = document.getElementById('cp-bright-thumb');
    if (t) t.style.left = (state.v * 100) + '%';
    const lbl = document.getElementById('cp-bright-val');
    if (lbl) lbl.textContent = Math.round(state.v * 100);
  }

  function drawAlphaTrack() {
    const cv = document.getElementById('cp-alpha-track');
    if (!cv) return;
    const ctx = cv.getContext('2d'), W=cv.width, H=cv.height;
    const [r,g,b] = hsv2rgb(state.h, state.s, state.v);
    const grad = ctx.createLinearGradient(0,0,W,0);
    grad.addColorStop(0,'rgba(0,0,0,0)');
    grad.addColorStop(1,`rgb(${r},${g},${b})`);
    // checker bg
    ctx.clearRect(0,0,W,H);
    for (let x=0; x<W; x+=8) {
      for (let y=0; y<H; y+=8) {
        ctx.fillStyle = ((x/8+y/8)%2===0) ? '#555' : '#333';
        ctx.fillRect(x,y,8,8);
      }
    }
    ctx.fillStyle=grad; ctx.fillRect(0,0,W,H);
    const t = document.getElementById('cp-alpha-thumb');
    if (t) t.style.left = (state.a * 100) + '%';
    const lbl = document.getElementById('cp-alpha-val');
    if (lbl) lbl.textContent = Math.round(state.a * 100);
  }

  function updateAll() {
    drawRing(); drawSV(); drawBrightTrack(); drawAlphaTrack();
    const [r,g,b] = hsv2rgb(state.h, state.s, state.v);
    const hex = rgb2hex(r,g,b);
    const inp = document.getElementById('cp-hex-input');
    if (inp) inp.value = hex;
    const prev = document.getElementById('cp-preview');
    if (prev) prev.style.background =
      `linear-gradient(rgba(${r},${g},${b},${state.a}),rgba(${r},${g},${b},${state.a})),`+
      `repeating-conic-gradient(#555 0 25%, #333 0 50%) 0 0/8px 8px`;
    if (cb) cb(hex, state.a);
  }

  // ── 拖拽工具 ─────────────────────────────────────────────
  function bindDrag(el, onMove) {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      onMove(e);
      const mm = ev => onMove(ev);
      const mu = () => { window.removeEventListener('mousemove',mm); window.removeEventListener('mouseup',mu); };
      window.addEventListener('mousemove', mm);
      window.addEventListener('mouseup', mu);
    });
    el.addEventListener('touchstart', e => {
      e.preventDefault();
      onMove(e.touches[0]);
      const mm = ev => onMove(ev.touches[0]);
      const mu = () => { window.removeEventListener('touchmove',mm); window.removeEventListener('touchend',mu); };
      window.addEventListener('touchmove', mm, {passive:false});
      window.addEventListener('touchend', mu);
    }, {passive:false});
  }

  function bindInteractions() {
    // 色环
    bindDrag(ringCanvas, e => {
      const rect = ringCanvas.getBoundingClientRect();
      const cx = rect.left + RING_R * rect.width / (RING_R*2);
      const cy = rect.top  + RING_R * rect.height / (RING_R*2);
      const dx = e.clientX - cx, dy = e.clientY - cy;
      const dist = Math.sqrt(dx*dx+dy*dy);
      const r1 = (RING_R - RING_W) * rect.width / (RING_R*2);
      const r2 = RING_R * rect.width / (RING_R*2);
      if (dist < r1 || dist > r2) return; // 只响应环区域
      state.h = ((Math.atan2(dy,dx) * 180/Math.PI) + 360) % 360;
      updateAll();
    });

    // SV方块
    bindDrag(svCanvas, e => {
      const rect = svCanvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top)  / rect.height;
      state.s = Math.max(0, Math.min(1, x));
      state.v = Math.max(0, Math.min(1, 1-y));
      updateAll();
    });

    // 明暗滑块
    bindDrag(document.getElementById('cp-bright-thumb').parentElement, e => {
      const rect = document.getElementById('cp-bright-thumb').parentElement.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      state.v = Math.max(0, Math.min(1, x));
      updateAll();
    });

    // 透明度滑块
    bindDrag(document.getElementById('cp-alpha-thumb').parentElement, e => {
      const rect = document.getElementById('cp-alpha-thumb').parentElement.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      state.a = Math.max(0, Math.min(1, x));
      updateAll();
    });

    // hex 输入
    const hexInput = document.getElementById('cp-hex-input');
    hexInput.addEventListener('input', e => {
      const val = e.target.value;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        const [r,g,b] = hex2rgb(val);
        [state.h, state.s, state.v] = rgb2hsv(r,g,b);
        updateAll();
      }
    });

    // 键盘弹出时自动滚到输入框可见
    hexInput.addEventListener('focus', () => {
      setTimeout(() => {
        const body = document.getElementById('cp-scroll-body');
        if (body) body.scrollTop = body.scrollHeight;
      }, 300);
    });

    // 确认/取消按钮
    document.getElementById('cp-confirm').addEventListener('click', close);
    document.getElementById('cp-cancel').addEventListener('click', () => {
      // 取消：恢复到打开时的颜色
      if (_initState) {
        Object.assign(state, _initState);
        updateAll();
      }
      close();
    });
  }

  // ── 显示 / 关闭 ───────────────────────────────────────────
  function showOverlay() {
    const ov = document.getElementById('cp-overlay');
    if (ov) ov.classList.remove('hidden');
  }

  function close() {
    const ov = document.getElementById('cp-overlay');
    if (ov) ov.classList.add('hidden');
    cb = null;
  }

  // ── 公开接口 ─────────────────────────────────────────────
  function open(targetEl, hex, opacity, callback) {
    if (!popEl) {
      popEl = buildPopup();
      ringCanvas = document.getElementById('cp-ring');
      svCanvas   = document.getElementById('cp-sv');
      bindInteractions();
    }

    hex     = hex     || '#c4a87c';
    opacity = opacity !== undefined ? opacity : 1;
    const [r,g,b] = hex2rgb(hex);
    [state.h, state.s, state.v] = rgb2hsv(r,g,b);
    state.a = opacity;
    // 保存快照供取消时回滚
    _initState = Object.assign({}, state);
    cb = callback;

    showOverlay();
    updateAll();
  }

  return { open, close };
})();
