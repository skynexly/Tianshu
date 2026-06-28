// ===== 名场面演出音效模块 (Web Audio 程序化合成) =====
// 服务于视频观影页的名场面特效，与 Ambient（天气环境音）相互独立。
// 持续型：rain（雨）/ fire（火噼啪）；瞬时型：lightning（雷）/ blood、shake（低频闷响）。
// 雪/光斑/白闪无音效。零素材、零联网，全部用噪音 + 滤波实时合成。

(function() {
  'use strict';

  let _ctx = null;
  let _master = null;
  let _volume = 0.4;
  let _persist = null;     // 当前持续型音轨：{ type, nodes:[], extras:[], gain }
  let _persistType = '';

  function _ensure() {
    if (_ctx && _ctx.state !== 'closed') {
      if (_ctx.state === 'suspended') { try { _ctx.resume(); } catch(_){} }
      return _ctx;
    }
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
    _master = _ctx.createGain();
    _master.gain.value = _volume;
    _master.connect(_ctx.destination);
    return _ctx;
  }

  function _noise(loop) {
    const ctx = _ensure();
    const size = 2 * ctx.sampleRate;
    const buf = ctx.createBuffer(1, size, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < size; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = !!loop;
    return src;
  }

  // ===== 持续型：雨 =====
  function _startRain() {
    const ctx = _ensure();
    const noise = _noise(true);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 3000;
    filter.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = 0.0;
    noise.connect(filter); filter.connect(g); g.connect(_master);
    noise.start();
    g.gain.linearRampToValueAtTime(0.55, ctx.currentTime + 0.7); // 淡入
    return { type: 'rain', src: noise, nodes: [filter, g], gain: g };
  }

  // ===== 持续型：火（噼啪 + 低沉燃烧底噪）=====
  function _startFire() {
    const ctx = _ensure();
    // 底噪：低频燃烧轰鸣
    const base = _noise(true);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 500; lp.Q.value = 0.4;
    const baseG = ctx.createGain(); baseG.gain.value = 0.0;
    base.connect(lp); lp.connect(baseG); baseG.connect(_master);
    base.start();
    baseG.gain.linearRampToValueAtTime(0.32, ctx.currentTime + 0.7);

    // 噼啪：随机短促高频爆裂
    let crackTimer = null;
    const crack = () => {
      if (!_ctx || _ctx.state === 'closed') return;
      const c = _ctx;
      const n = _noise(false);
      const hp = c.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 2200;
      const cg = c.createGain();
      const amp = 0.12 + Math.random() * 0.22;
      cg.gain.setValueAtTime(amp, c.currentTime);
      cg.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.06 + Math.random() * 0.08);
      n.connect(hp); hp.connect(cg); cg.connect(_master);
      n.start();
      n.stop(c.currentTime + 0.2);
      crackTimer = setTimeout(crack, 120 + Math.random() * 380);
    };
    crackTimer = setTimeout(crack, 150);
    return { type: 'fire', src: base, nodes: [lp, baseG], gain: baseG, _crackStop: () => { if (crackTimer) clearTimeout(crackTimer); } };
  }

  function _stopPersist(fadeMs) {
    const p = _persist;
    _persist = null; _persistType = '';
    if (!p) return;
    const ms = fadeMs == null ? 600 : fadeMs;
    try {
      if (p.gain && _ctx) {
        p.gain.gain.cancelScheduledValues(_ctx.currentTime);
        p.gain.gain.setValueAtTime(p.gain.gain.value, _ctx.currentTime);
        p.gain.gain.linearRampToValueAtTime(0, _ctx.currentTime + ms / 1000);
      }
    } catch(_){}
    setTimeout(() => {
      try { p._crackStop && p._crackStop(); } catch(_){}
      try { p.src.stop(); } catch(_){}
      try { p.src.disconnect(); } catch(_){}
      if (p.nodes) p.nodes.forEach(n => { try { n.disconnect(); } catch(_){} });
    }, ms + 80);
  }

  // ===== 瞬时型：雷 =====
  function _fireThunder() {
    const ctx = _ensure();
    const t0 = ctx.currentTime + 0.03;   // 略微延后，确保 resume 后调度生效
    const intensity = 0.85 + Math.random() * 0.3;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(70 + Math.random() * 30, t0);
    osc.frequency.exponentialRampToValueAtTime(34, t0 + 1.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(intensity, t0 + 0.04);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 1.8 + Math.random());
    const noise = _noise(false);
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass'; nf.frequency.value = 320;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.exponentialRampToValueAtTime(intensity * 0.8, t0 + 0.03);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 2.2);
    osc.connect(og); og.connect(_master);
    noise.connect(nf); nf.connect(ng); ng.connect(_master);
    osc.start(t0); noise.start(t0);
    osc.stop(t0 + 2.8); noise.stop(t0 + 2.8);
  }

  // ===== 瞬时型：低频闷响（血溅/冲击）=====
  function _fireImpact() {
    const ctx = _ensure();
    const t0 = ctx.currentTime + 0.03;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t0);
    osc.frequency.exponentialRampToValueAtTime(42, t0 + 0.3);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(0.9, t0 + 0.02);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
    const noise = _noise(false);
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass'; nf.frequency.value = 600;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.exponentialRampToValueAtTime(0.6, t0 + 0.01);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.32);
    osc.connect(og); og.connect(_master);
    noise.connect(nf); nf.connect(ng); ng.connect(_master);
    osc.start(t0); noise.start(t0);
    osc.stop(t0 + 0.7); noise.stop(t0 + 0.7);
  }

  // ===== 瞬时型：玻璃碎裂（尖锐爆裂 + 碎屑叮当散落）=====
  function _fireGlass() {
    const ctx = _ensure();
    const t0 = ctx.currentTime + 0.03;
    // 1) 碎裂瞬间：高通噪声的短促爆裂（"啪"）
    const burst = _noise(false);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2600;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t0);
    bg.gain.exponentialRampToValueAtTime(0.85, t0 + 0.006);
    bg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.13);
    burst.connect(hp); hp.connect(bg); bg.connect(_master);
    burst.start(t0); burst.stop(t0 + 0.2);
    // 2) 碎屑叮当：一串随机高频短音，模拟玻璃渣散落
    const shardCount = 7 + Math.floor(Math.random() * 5);
    for (let i = 0; i < shardCount; i++) {
      const dt = t0 + 0.04 + Math.random() * 0.5;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(2400 + Math.random() * 3600, dt);
      const og2 = ctx.createGain();
      const amp = 0.05 + Math.random() * 0.12;
      og2.gain.setValueAtTime(0.0001, dt);
      og2.gain.exponentialRampToValueAtTime(amp, dt + 0.004);
      og2.gain.exponentialRampToValueAtTime(0.001, dt + 0.05 + Math.random() * 0.08);
      o.connect(og2); og2.connect(_master);
      o.start(dt); o.stop(dt + 0.2);
    }
  }

  // ===== 瞬时型：烟花（上升咻声 + 顶端炸开 + 噼啪余响）=====
  function _fireFirework() {
    const ctx = _ensure();
    const t0 = ctx.currentTime + 0.03;
    // 1) 上升"咻"：频率上滑的正弦哨音
    const whistleDur = 0.55 + Math.random() * 0.2;
    const w = ctx.createOscillator();
    w.type = 'sine';
    w.frequency.setValueAtTime(500, t0);
    w.frequency.exponentialRampToValueAtTime(1700, t0 + whistleDur);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t0);
    wg.gain.exponentialRampToValueAtTime(0.16, t0 + 0.05);
    wg.gain.exponentialRampToValueAtTime(0.04, t0 + whistleDur);
    w.connect(wg); wg.connect(_master);
    w.start(t0); w.stop(t0 + whistleDur + 0.05);
    // 2) 顶端炸开"啪"：低中频爆响
    const tb = t0 + whistleDur;
    const boom = _noise(false);
    const bf = ctx.createBiquadFilter();
    bf.type = 'lowpass'; bf.frequency.value = 1200;
    const bgn = ctx.createGain();
    bgn.gain.setValueAtTime(0.0001, tb);
    bgn.gain.exponentialRampToValueAtTime(0.7, tb + 0.01);
    bgn.gain.exponentialRampToValueAtTime(0.001, tb + 0.4);
    boom.connect(bf); bf.connect(bgn); bgn.connect(_master);
    boom.start(tb); boom.stop(tb + 0.5);
    // 3) 噼啪余响：一串高频小爆，模拟火星炸裂
    const crackN = 8 + Math.floor(Math.random() * 6);
    for (let i = 0; i < crackN; i++) {
      const dt = tb + 0.05 + Math.random() * 0.6;
      const n = _noise(false);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 3000;
      const cg = ctx.createGain();
      const amp = 0.04 + Math.random() * 0.1;
      cg.gain.setValueAtTime(amp, dt);
      cg.gain.exponentialRampToValueAtTime(0.001, dt + 0.05 + Math.random() * 0.06);
      n.connect(hp); hp.connect(cg); cg.connect(_master);
      n.start(dt); n.stop(dt + 0.15);
    }
  }

  // ===== 公共 API =====
  // 切换持续型音轨：相同保留，不同则切换
  function setPersist(type) {
    const t = (type === 'rain' || type === 'fire') ? type : '';
    if (t === _persistType) return;
    _stopPersist(600);
    _persistType = t;
    if (t === 'rain') _persist = _startRain();
    else if (t === 'fire') _persist = _startFire();
  }

  // 触发瞬时型音效
  function trigger(type) {
    if (type === 'lightning') _fireThunder();
    else if (type === 'blood' || type === 'shake') _fireImpact();
    else if (type === 'glass') _fireGlass();
    else if (type === 'firework') _fireFirework();
  }

  // 停止全部（关声音 / 退出观影）
  function stopAll() {
    _stopPersist(200);
  }

  function setVolume(v) {
    _volume = Math.max(0, Math.min(1, parseFloat(v) || 0));
    if (_master && _ctx) {
      _master.gain.cancelScheduledValues(_ctx.currentTime);
      _master.gain.linearRampToValueAtTime(_volume, _ctx.currentTime + 0.2);
    }
  }

  function resume() { if (_ctx && _ctx.state === 'suspended') { try { _ctx.resume(); } catch(_){} } }

  window.WatchSfx = { setPersist, trigger, stopAll, setVolume, resume };
})();
