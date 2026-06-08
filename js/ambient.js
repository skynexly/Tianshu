// ===== 环境音模块 (Web Audio 程序化生成) =====
// 根据游戏天气（status.weather）播放对应环境音
// 四种音轨：雷+雨 / 雨 / 风 / 白噪音底噪
// 两种模式：持续循环 / 触发短播（20-30秒淡入淡出）

(function() {
  'use strict';

  let _enabled = false;
  let _mode = 'loop'; // 'loop' | 'short'
  let _volume = 0.5;  // 0-1
  let _currentType = 'silence'; // 'thunder' | 'rain' | 'wind' | 'white'
  let _ctx = null;     // AudioContext
  let _masterGain = null;
  let _activeNodes = []; // 当前正在播放的节点
  let _thunderInterval = null;
  let _fadeTimer = null;
  let _shortPlayTimer = null;

  // ===== 天气关键词 → 音效类型 =====
  function _weatherToType(weatherStr) {
    const w = (weatherStr || '').toLowerCase();
    if (w.includes('雷')) return 'thunder';
    if (w.includes('雨')) return 'rain';
    if (w.includes('阴') || w.includes('风')) return 'wind';
    return 'white';
  }

  // ===== 初始化 AudioContext =====
  function _ensureContext() {
    if (_ctx && _ctx.state !== 'closed') return _ctx;
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
    _masterGain = _ctx.createGain();
    _masterGain.gain.value = _volume;
    _masterGain.connect(_ctx.destination);
    return _ctx;
  }

  // ===== 噪音生成器 =====
  function _createNoise(type) {
    // type: 'white' | 'pink'
    const ctx = _ensureContext();
    const bufferSize = 2 * ctx.sampleRate; // 2秒buffer
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    if (type === 'pink') {
      // 粉红噪音（1/f）近似
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    } else {
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    return source;
  }

  // ===== 雨声 =====
  function _startRain() {
    const ctx = _ensureContext();
    const noise = _createNoise('white');
    // 带通滤波：模拟雨滴频率
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 3000;
    filter.Q.value = 0.7;
    // 振幅调制（随机起伏）
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0.6;

    noise.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(_masterGain);
    noise.start();
    _activeNodes.push({ source: noise, nodes: [filter, gainNode] });

    // 额外一层低频底噪（环境感）
    const lowNoise = _createNoise('pink');
    const lowGain = ctx.createGain();
    lowGain.gain.value = 0.15;
    lowNoise.connect(lowGain);
    lowGain.connect(_masterGain);
    lowNoise.start();
    _activeNodes.push({ source: lowNoise, nodes: [lowGain] });
  }

  // ===== 风声 =====
  function _startWind() {
    const ctx = _ensureContext();
    const noise = _createNoise('pink');
    // 低通滤波：只保留低频
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    filter.Q.value = 0.5;
    // LFO 调制（风的起伏）
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0.4;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.15 + Math.random() * 0.1; // 很慢的起伏
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.2;
    lfo.connect(lfoGain);
    lfoGain.connect(gainNode.gain);
    lfo.start();

    noise.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(_masterGain);
    noise.start();
    _activeNodes.push({ source: noise, nodes: [filter, gainNode], extras: [lfo, lfoGain] });
  }

  // ===== 白噪音底噪（很淡）=====
  function _startWhite() {
    const ctx = _ensureContext();
    const noise = _createNoise('pink'); // 用粉红噪音更舒服
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0.06; // 很淡
    noise.connect(gainNode);
    gainNode.connect(_masterGain);
    noise.start();
    _activeNodes.push({ source: noise, nodes: [gainNode] });
  }

  // ===== 雷声（偶发）=====
  function _startThunderLoop() {
    _stopThunderLoop();
    const fireThunder = () => {
      if (!_ctx || _ctx.state === 'closed') return;
      const ctx = _ctx;
      // 低频爆发 + 噪音
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 40 + Math.random() * 30;
      const oscGain = ctx.createGain();
      const intensity = 0.3 + Math.random() * 0.4;
      oscGain.gain.setValueAtTime(intensity, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5 + Math.random());

      const noise = _createNoise('white');
      const nFilter = ctx.createBiquadFilter();
      nFilter.type = 'lowpass';
      nFilter.frequency.value = 200;
      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(intensity * 0.5, ctx.currentTime);
      nGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2);

      osc.connect(oscGain);
      oscGain.connect(_masterGain);
      noise.connect(nFilter);
      nFilter.connect(nGain);
      nGain.connect(_masterGain);

      osc.start();
      noise.start();
      osc.stop(ctx.currentTime + 2.5);
      noise.stop(ctx.currentTime + 2.5);
    };

    // 首次延迟5-15秒
    const scheduleNext = () => {
      const delay = (20 + Math.random() * 40) * 1000; // 20-60秒
      _thunderInterval = setTimeout(() => {
        fireThunder();
        scheduleNext();
      }, delay);
    };
    // 进场先来一声
    setTimeout(fireThunder, 3000 + Math.random() * 5000);
    scheduleNext();
  }

  function _stopThunderLoop() {
    if (_thunderInterval) { clearTimeout(_thunderInterval); _thunderInterval = null; }
  }

  // ===== 停止所有音源 =====
  function _stopAll() {
    _stopThunderLoop();
    for (const item of _activeNodes) {
      try { item.source.stop(); } catch(_) {}
      try { item.source.disconnect(); } catch(_) {}
      if (item.nodes) item.nodes.forEach(n => { try { n.disconnect(); } catch(_) {} });
      if (item.extras) item.extras.forEach(n => { try { n.stop?.(); n.disconnect(); } catch(_) {} });
    }
    _activeNodes = [];
    if (_shortPlayTimer) { clearTimeout(_shortPlayTimer); _shortPlayTimer = null; }
  }

  // ===== 淡入 =====
  function _fadeIn(duration) {
    if (!_masterGain) return;
    _masterGain.gain.cancelScheduledValues(_ctx.currentTime);
    _masterGain.gain.setValueAtTime(0, _ctx.currentTime);
    _masterGain.gain.linearRampToValueAtTime(_volume, _ctx.currentTime + duration);
  }

  // ===== 淡出并停止 =====
  function _fadeOut(duration, callback) {
    if (!_masterGain || !_ctx) { if (callback) callback(); return; }
    _masterGain.gain.cancelScheduledValues(_ctx.currentTime);
    _masterGain.gain.setValueAtTime(_masterGain.gain.value, _ctx.currentTime);
    _masterGain.gain.linearRampToValueAtTime(0, _ctx.currentTime + duration);
    if (_fadeTimer) clearTimeout(_fadeTimer);
    _fadeTimer = setTimeout(() => {
      _stopAll();
      if (callback) callback();
    }, duration * 1000 + 100);
  }

  // ===== 播放指定类型 =====
  function _play(type) {
    _stopAll();
    _ensureContext();
    if (_ctx.state === 'suspended') _ctx.resume();

    _currentType = type;
    switch (type) {
      case 'thunder':
        _startRain();
        _startThunderLoop();
        break;
      case 'rain':
        _startRain();
        break;
      case 'wind':
        _startWind();
        break;
      case 'white':
      default:
        _startWhite();
        break;
    }
    _fadeIn(3); // 3秒淡入
  }

  // ===== 短播模式：播放后自动淡出 =====
  function _playShort(type) {
    _play(type);
    if (_shortPlayTimer) clearTimeout(_shortPlayTimer);
    // 20-30秒后淡出
    const duration = 20000 + Math.random() * 10000;
    _shortPlayTimer = setTimeout(() => {
      _fadeOut(5); // 5秒淡出
    }, duration);
  }

  // ===== 公共 API =====

  // 切换天气（由 StatusBar.render 调用）
  function updateWeather(weatherStr) {
    if (!_enabled) return;
    const newType = _weatherToType(weatherStr);
    if (newType === _currentType && _activeNodes.length > 0) return; // 没变，不重复启动
    if (_mode === 'loop') {
      _fadeOut(2, () => _play(newType));
    } else {
      _fadeOut(2, () => _playShort(newType));
    }
  }

  // 开启
  function enable() {
    _enabled = true;
    _ensureContext();
    if (_ctx.state === 'suspended') _ctx.resume();
    // 读当前天气并开始播放
    try {
      const sb = Conversations.getStatusBar();
      const weatherStr = sb?.weather || '';
      const type = _weatherToType(weatherStr);
      if (_mode === 'loop') {
        _play(type);
      } else {
        _playShort(type);
      }
    } catch(_) {
      _play('white');
    }
  }

  // 关闭
  function disable() {
    _enabled = false;
    _fadeOut(2);
  }

  // 设置音量
  function setVolume(v) {
    _volume = Math.max(0, Math.min(1, parseFloat(v) || 0));
    if (_masterGain && _ctx) {
      _masterGain.gain.cancelScheduledValues(_ctx.currentTime);
      _masterGain.gain.linearRampToValueAtTime(_volume, _ctx.currentTime + 0.3);
    }
  }

  // 设置模式
  function setMode(mode) {
    _mode = (mode === 'short') ? 'short' : 'loop';
  }

  // 获取状态
  function getState() {
    return { enabled: _enabled, mode: _mode, volume: _volume, currentType: _currentType };
  }

  // 暴露
  window.Ambient = {
    updateWeather,
    enable,
    disable,
    setVolume,
    setMode,
    getState
  };
})();
