/**
 * TTS — 文本转语音（MiniMax T2A v2）
 *
 * 设计：
 * - 依赖 Settings.getTtsConfig() 提供 apiUrl / apiKey / model / groupId
 * - 朗读范围（引号类型 / 全部内容）由对话设置 convSettings.voiceScope 决定
 * - 每条消息最多一个播放实例；切换消息会自动停止上一个
 * - 长文自动按段切分（每段 <= 1000 字符），顺序播放
 */
const TTS = (() => {
  let _audio = null;           // 当前 <audio> 实例
  let _currentMsgId = null;    // 当前播放的消息 id
  let _abort = false;          // 中断标记
  let _queue = [];             // 待播放的 blobUrl 队列
  let _playing = false;        // 是否正在播放
  let _onFinishCbs = [];       // 播放结束回调

  // ===== hex -> Uint8Array =====
  function _hexToBytes(hex) {
    const clean = (hex || '').replace(/\s+/g, '');
    if (clean.length === 0 || clean.length % 2 !== 0) {
      throw new Error('音频数据格式错误');
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      bytes[i / 2] = parseInt(clean.substr(i, 2), 16);
    }
    return bytes;
  }

  // ===== 调用 MiniMax T2A v2 =====
  // 使用 output_format=url，让服务端返回 CDN 音频链接，省流量、播放更快
  // 返回 Blob（统一形态，便于缓存）
  async function _requestAudio(text, cfg) {
    const voiceId = cfg.voiceId || 'female-shaonv';
    const model = cfg.model || 'speech-2.8-hd';
    const base = (cfg.apiUrl || 'https://api.minimaxi.com/v1/t2a_v2').replace(/\?.*$/, '');
    // GroupId 可选：新版 sk-api-... key 已内含 group，无需手动传
    const gid = (cfg.groupId || '').trim();
    const url = gid ? `${base}?GroupId=${encodeURIComponent(gid)}` : base;

    const body = {
      model,
      text,
      stream: false,
      output_format: 'url',
      voice_setting: {
        voice_id: voiceId,
        speed: 1.0,
        vol: 1.0,
        pitch: 0
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1
      }
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey || ''}`
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`TTS 请求失败 (${resp.status})：${errText.slice(0, 200)}`);
    }

    const json = await resp.json();
    // MiniMax 错误格式：base_resp.status_code !== 0 即失败
    if (json.base_resp && json.base_resp.status_code !== 0) {
      throw new Error(`MiniMax 错误：${json.base_resp.status_msg || 'unknown'}`);
    }
    const audioField = json?.data?.audio;
    if (!audioField) throw new Error('TTS 响应缺少音频数据');

    // output_format=url 时返回 CDN 链接：fetch 下载为 Blob 以便缓存
    if (/^https?:\/\//i.test(audioField)) {
      const audioResp = await fetch(audioField);
      if (!audioResp.ok) throw new Error(`音频下载失败 (${audioResp.status})`);
      return await audioResp.blob();
    }
    // 兜底：hex 解码
    const bytes = _hexToBytes(audioField);
    return new Blob([bytes], { type: 'audio/mp3' });
  }

  // ===== 文本切片（MiniMax 单次限制约 5000 字符，保守取 1000） =====
  function _splitText(text) {
    const MAX = 1000;
    if (text.length <= MAX) return [text];
    const segs = [];
    let rest = text;
    while (rest.length > MAX) {
      // 找最近的标点作为切分点
      let cut = rest.lastIndexOf('。', MAX);
      if (cut < MAX * 0.5) cut = rest.lastIndexOf('！', MAX);
      if (cut < MAX * 0.5) cut = rest.lastIndexOf('？', MAX);
      if (cut < MAX * 0.5) cut = rest.lastIndexOf('，', MAX);
      if (cut < MAX * 0.5) cut = rest.lastIndexOf('\n', MAX);
      if (cut < MAX * 0.5) cut = MAX;
      segs.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest.trim()) segs.push(rest);
    return segs;
  }

  // ===== 按朗读范围提取文本 =====
  // scope: { quotes: ['cjk-double','cjk-bracket','ascii-double','cjk-single'], all: bool }
  function extractSpeakingText(rawText, scope) {
    if (!rawText) return '';
    // 先把代码块、状态栏之类剔掉
    let text = rawText
      .replace(/```[\s\S]*?```/g, '')   // 去代码块
      .replace(/^---$/gm, '')            // 去分隔线
      .trim();

    if (scope && scope.all) return text.trim();

    const patterns = [];
    const quotes = (scope && scope.quotes) || [];
    if (quotes.includes('cjk-double')) patterns.push(/[\u201c\u201d]([^\u201c\u201d]{1,500})[\u201c\u201d]/g);
    if (quotes.includes('cjk-bracket')) patterns.push(/\u300c([^\u300d]{1,500})\u300d/g);
    if (quotes.includes('ascii-double')) patterns.push(/"([^"]{1,500})"/g);
    if (quotes.includes('cjk-single')) patterns.push(/[\u2018\u2019]([^\u2018\u2019]{1,500})[\u2018\u2019]/g);

    if (patterns.length === 0) return '';

    const parts = [];
    for (const re of patterns) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const content = (m[1] || '').trim();
        if (content) parts.push(content);
      }
    }
    return parts.join('。');
  }

  // ===== 停止播放 =====
  function stop() {
    _abort = true;
    _playing = false;
    _currentMsgId = null;
    if (_audio) {
      try { _audio.pause(); } catch (_) {}
      try { _audio.removeAttribute('src'); _audio.load(); } catch (_) {}
    }
    // 清理队列里未播的 URL（仅 blob 需要 revoke）
    for (const url of _queue) {
      if (typeof url === 'string' && url.startsWith('blob:')) {
        try { URL.revokeObjectURL(url); } catch (_) {}
      }
    }
    _queue = [];
    _fireFinish();
  }

  function isPlaying(msgId) {
    if (msgId != null) return _playing && _currentMsgId === msgId;
    return _playing;
  }

  function onFinish(cb) {
    if (typeof cb === 'function') _onFinishCbs.push(cb);
  }
  function _fireFinish() {
    const cbs = _onFinishCbs.slice();
    _onFinishCbs = [];
    for (const cb of cbs) {
      try { cb(); } catch (_) {}
    }
  }

  // ===== 缓存（IndexedDB ttsCache 表） =====
  // 上限：50MB；命中时刷新 accessedAt；超限时按 accessedAt 升序淘汰
  const CACHE_MAX_BYTES = 50 * 1024 * 1024;

  async function _hashKey(text, cfg) {
    const raw = `${cfg.model || ''}|${cfg.voiceId || ''}|${cfg.speed || 1}|${text}`;
    try {
      const buf = new TextEncoder().encode(raw);
      const hash = await crypto.subtle.digest('SHA-1', buf);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      // 兜底：简易 hash（极少触发）
      let h = 0;
      for (let i = 0; i < raw.length; i++) { h = (h << 5) - h + raw.charCodeAt(i); h |= 0; }
      return 'fallback_' + h;
    }
  }

  async function _cacheGet(key) {
    if (typeof DB === 'undefined' || !DB.get) return null;
    try {
      const row = await DB.get('ttsCache', key);
      if (!row || !row.blob) return null;
      // 异步刷新 accessedAt（不 await，不阻塞播放）
      row.accessedAt = Date.now();
      DB.put('ttsCache', row).catch(() => {});
      return row.blob;
    } catch (_) { return null; }
  }

  async function _cachePut(key, blob, text) {
    if (typeof DB === 'undefined' || !DB.put) return;
    try {
      await DB.put('ttsCache', {
        key,
        blob,
        size: blob.size || 0,
        textPreview: (text || '').slice(0, 60),
        createdAt: Date.now(),
        accessedAt: Date.now()
      });
      // 异步触发 LRU 清理
      _evictIfNeeded().catch(() => {});
    } catch (_) {}
  }

  async function _evictIfNeeded() {
    if (typeof DB === 'undefined' || !DB.getAll) return;
    const all = await DB.getAll('ttsCache').catch(() => []);
    let total = all.reduce((s, r) => s + (r.size || 0), 0);
    if (total <= CACHE_MAX_BYTES) return;
    // 按 accessedAt 升序，淘汰最旧的直到总大小 ≤ 上限
    all.sort((a, b) => (a.accessedAt || 0) - (b.accessedAt || 0));
    for (const row of all) {
      if (total <= CACHE_MAX_BYTES) break;
      try {
        await DB.del('ttsCache', row.key);
        total -= (row.size || 0);
      } catch (_) {}
    }
  }

  async function clearCache() {
    if (typeof DB === 'undefined' || !DB.clear) return;
    try { await DB.clear('ttsCache'); } catch (_) {}
  }

  async function getCacheStats() {
    if (typeof DB === 'undefined' || !DB.getAll) return { count: 0, bytes: 0 };
    try {
      const all = await DB.getAll('ttsCache');
      return {
        count: all.length,
        bytes: all.reduce((s, r) => s + (r.size || 0), 0)
      };
    } catch (_) { return { count: 0, bytes: 0 }; }
  }

  // ===== 播放入口 =====
  // text: 待朗读文本
  // options: { msgId, onStart, onProgress }
  async function speak(text, options = {}) {
    stop();
    const speakText = (text || '').trim();
    if (!speakText) throw new Error('没有可朗读的内容');

    const cfg = (typeof Settings !== 'undefined' && Settings.getTtsConfig) ? Settings.getTtsConfig() : {};
    if (!cfg.apiKey) throw new Error('未配置语音 API Key（请到「设置 → 功能模型 → 语音模型」填写）');

    _abort = false;
    _playing = true;
    _currentMsgId = options.msgId != null ? options.msgId : null;
    if (options.onStart) { try { options.onStart(); } catch (_) {} }

    const segs = _splitText(speakText);
    try {
      for (let i = 0; i < segs.length; i++) {
        if (_abort) return;
        const mergedCfg = Object.assign({}, cfg, { voiceId: options.voiceId || cfg.voiceId });

        // 缓存优先
        const key = await _hashKey(segs[i], mergedCfg);
        let blob = await _cacheGet(key);
        const fromCache = !!blob;
        if (!blob) {
          blob = await _requestAudio(segs[i], mergedCfg);
          if (blob && blob.size) {
            _cachePut(key, blob, segs[i]).catch(() => {});
          }
        }
        if (_abort) return;

        // 第一段开始播放时触发 onPlayStart（loading → playing 切换点）
        if (i === 0 && options.onPlayStart) {
          try { options.onPlayStart({ fromCache }); } catch (_) {}
        }

        const blobUrl = URL.createObjectURL(blob);
        await _playBlob(blobUrl);
      }
    } finally {
      _playing = false;
      _currentMsgId = null;
      _fireFinish();
    }
  }

  function _playBlob(audioUrl) {
    return new Promise((resolve, reject) => {
      if (!_audio) _audio = new Audio();
      const audio = _audio;
      const isBlob = audioUrl.startsWith('blob:');
      const cleanup = () => {
        audio.onended = null;
        audio.onerror = null;
        if (isBlob) {
          try { URL.revokeObjectURL(audioUrl); } catch (_) {}
        }
      };
      audio.onended = () => { cleanup(); resolve(); };
      audio.onerror = (e) => { cleanup(); reject(new Error('音频播放失败')); };
      audio.src = audioUrl;
      const p = audio.play();
      if (p && p.catch) p.catch(err => { cleanup(); reject(err); });
    });
  }

  return {
    speak,
    stop,
    isPlaying,
    onFinish,
    extractSpeakingText,
    clearCache,
    getCacheStats
  };
})();
