// ===== 音乐播放器模块 =====
// 氛围/趣味功能：全局共享歌曲库（存 IndexedDB），第二页常驻播放器卡片 + 可点入的歌曲库管理页。
// 音源两种：1) 本地上传音频文件（存 Blob）  2) 外链直链（网易云分享链接自动抠 ID 拼 outer/url，其他音频直链原样用）
// 歌词可选、可随时补传：有时间轴(LRC)则滚动高亮，无时间轴则静态显示。
const Music = (() => {
  const STORE = 'musicTracks';

  // 运行时状态
  let _tracks = [];            // 歌曲库（内存缓存，与 DB 同步）
  let _loaded = false;
  let _audio = null;           // 单例 <audio>
  let _curId = null;           // 当前曲目 id
  let _objUrl = null;          // 当前 Blob 的 ObjectURL（需在切歌时 revoke）
  let _isPlaying = false;
  let _repeatMode = 'list';    // list | one | shuffle（列表循环 / 单曲循环 / 随机）
  let _parsedLrc = null;       // 当前曲目解析后的 LRC：[{t, text}] 或 null
  let _lrcLineIdx = -1;

  // ---------- 工具 ----------
  function _uuid() {
    return 'mt_' + (Date.now().toString(36)) + Math.random().toString(36).slice(2, 8);
  }

  function _fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // 从网易云分享文本/链接里抠歌曲 id。支持 song?id=xxx、/song/xxx、纯数字。
  function _extractNeteaseId(input) {
    if (!input) return null;
    const s = String(input).trim();
    let m = s.match(/[?&]id=(\d+)/);
    if (m) return m[1];
    m = s.match(/\/song\/(\d+)/);
    if (m) return m[1];
    if (/^\d+$/.test(s)) return s;
    return null;
  }

  // 把用户输入的"音源"解析成可播放 URL（仅对外链类型）。
  // 网易云链接/ID → outer/url 直链；其他 http(s) → 原样；否则 null。
  function _resolveExternalUrl(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    // 网易云短链（163cn.tv）前端无法展开（CORS），不含 id，直接判失败让上层提示
    if (/163cn\.tv/i.test(s)) return null;
    if (/music\.163\.com|y\.music\.163\.com|^\d+$/.test(s)) {
      const id = _extractNeteaseId(s);
      if (id) return `https://music.163.com/song/media/outer/url?id=${id}.mp3`;
    }
    if (/^https?:\/\//i.test(s)) return s;
    return null;
  }

  // 是否为网易云短链（用于给用户精准提示）
  function _isNeteaseShortLink(raw) {
    return /163cn\.tv/i.test(String(raw || ''));
  }

  // ---------- LRC 解析 ----------
  // 返回 { lines: [{t, text}], synced: bool }。无时间轴时 synced=false，lines 为纯文本行（t=0）。
  function parseLrc(raw) {
    if (!raw || !String(raw).trim()) return null;
    const text = String(raw);
    const lines = [];
    let synced = false;
    const reTime = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    text.split(/\r?\n/).forEach(line => {
      const stamps = [];
      let m;
      reTime.lastIndex = 0;
      while ((m = reTime.exec(line)) !== null) {
        const mm = parseInt(m[1], 10) || 0;
        const ss = parseInt(m[2], 10) || 0;
        const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0;
        stamps.push(mm * 60 + ss + frac);
      }
      const content = line.replace(reTime, '').trim();
      if (stamps.length) {
        synced = true;
        stamps.forEach(t => lines.push({ t, text: content }));
      } else if (content) {
        lines.push({ t: 0, text: content });
      }
    });
    if (!lines.length) return null;
    if (synced) lines.sort((a, b) => a.t - b.t);
    return { lines, synced };
  }

  // ---------- 库管理 ----------
  async function _ensureLoaded() {
    if (_loaded) return;
    try {
      _tracks = await DB.getAll(STORE) || [];
      _tracks.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    } catch (e) {
      console.warn('[Music] load failed', e);
      _tracks = [];
    }
    _loaded = true;
  }

  function getTracks() { return _tracks.slice(); }
  function getCurrentId() { return _curId; }
  function getCurrentTrack() { return _tracks.find(t => t.id === _curId) || null; }
  function isPlaying() { return _isPlaying; }

  // 添加：本地文件（转 ArrayBuffer 存储，避免 Blob 直存的 Android 兼容性问题）
  async function addLocalTrack({ title, artist, lrc, coverUrl, file }) {
    if (!file) throw new Error('缺少音频文件');
    const buf = await file.arrayBuffer();
    const rec = {
      id: _uuid(),
      source: 'upload',
      title: (title || file.name.replace(/\.[^.]+$/, '') || '未命名').trim(),
      artist: (artist || '').trim(),
      coverUrl: (coverUrl || '').trim(),
      lrc: (lrc || '').trim(),
      audioBuffer: buf,           // 存 ArrayBuffer（兼容性最好）
      mime: file.type || 'audio/mpeg',
      addedAt: Date.now()
    };
    await DB.put(STORE, rec);
    await _ensureLoaded();
    _tracks.push(rec);
    return rec;
  }

  // 添加：外链
  async function addExternalTrack({ title, artist, lrc, coverUrl, url }) {
    const playUrl = _resolveExternalUrl(url);
    if (!playUrl) throw new Error('无法识别的链接（需网易云分享链接或音频直链）');
    const rec = {
      id: _uuid(),
      source: 'external',
      title: (title || '未命名').trim(),
      artist: (artist || '').trim(),
      coverUrl: (coverUrl || '').trim(),
      lrc: (lrc || '').trim(),
      url: playUrl,
      rawInput: String(url).trim(),
      addedAt: Date.now()
    };
    await DB.put(STORE, rec);
    await _ensureLoaded();
    _tracks.push(rec);
    return rec;
  }

  async function updateTrack(id, patch) {
    await _ensureLoaded();
    const t = _tracks.find(x => x.id === id);
    if (!t) return null;
    Object.assign(t, patch || {});
    await DB.put(STORE, t);
    if (id === _curId && 'lrc' in (patch || {})) {
      _parsedLrc = parseLrc(t.lrc);
      _lrcLineIdx = -1;
    }
    return t;
  }

  async function removeTrack(id) {
    await _ensureLoaded();
    if (id === _curId) { stop(); }
    await DB.del(STORE, id);
    _tracks = _tracks.filter(t => t.id !== id);
  }

  // ---------- 播放控制 ----------
  function _ensureAudio() {
    if (_audio) return _audio;
    _audio = new Audio();
    _audio.preload = 'metadata';
    _audio.addEventListener('timeupdate', _onTimeUpdate);
    _audio.addEventListener('ended', _onEnded);
    _audio.addEventListener('play', () => { _isPlaying = true; _emit(); });
    _audio.addEventListener('pause', () => { _isPlaying = false; _emit(); });
    _audio.addEventListener('error', _onError);
    _audio.addEventListener('loadedmetadata', _emit);
    return _audio;
  }

  function _revokeObjUrl() {
    if (_objUrl) { try { URL.revokeObjectURL(_objUrl); } catch (_) {} _objUrl = null; }
  }

  async function play(id) {
    await _ensureLoaded();
    const audio = _ensureAudio();
    // 同一首：切换播放/暂停
    if (id && id === _curId) {
      if (_isPlaying) { audio.pause(); } else { audio.play().catch(_onPlayReject); }
      return;
    }
    const targetId = id || _curId || (_tracks[0] && _tracks[0].id);
    if (!targetId) { UI.showToast('音乐库是空的', 1500); return; }
    const t = _tracks.find(x => x.id === targetId);
    if (!t) return;

    _revokeObjUrl();
    let src = '';
    if (t.source === 'upload' && (t.audioBuffer || t.audioBlob)) {
      const blob = t.audioBuffer
        ? new Blob([t.audioBuffer], { type: t.mime || 'audio/mpeg' })
        : t.audioBlob;
      _objUrl = URL.createObjectURL(blob);
      src = _objUrl;
    } else if (t.source === 'external' && t.url) {
      src = t.url;
    } else {
      UI.showToast('该曲目无可用音源', 1800);
      return;
    }
    _curId = targetId;
    _parsedLrc = parseLrc(t.lrc);
    _lrcLineIdx = -1;
    audio.src = src;
    audio.play().catch(_onPlayReject);
    _emit();
  }

  function _onPlayReject(err) {
    console.warn('[Music] play rejected', err);
    UI.showToast('播放失败：音源可能失效或不支持跨域', 2500);
  }

  function pause() { if (_audio) _audio.pause(); }

  function toggle() {
    if (!_curId) { play(); return; }
    if (_isPlaying) pause(); else play(_curId);
  }

  function stop() {
    if (_audio) { _audio.pause(); _audio.removeAttribute('src'); _audio.load(); }
    _revokeObjUrl();
    _isPlaying = false;
    _emit();
  }

  function _indexOfCur() { return _tracks.findIndex(t => t.id === _curId); }

  function next() {
    if (!_tracks.length) return;
    if (_repeatMode === 'shuffle') { _playRandom(); return; }
    let i = _indexOfCur();
    i = (i + 1) % _tracks.length;
    play(_tracks[i].id);
  }

  function prev() {
    if (!_tracks.length) return;
    if (_repeatMode === 'shuffle') { _playRandom(); return; }
    let i = _indexOfCur();
    i = (i - 1 + _tracks.length) % _tracks.length;
    play(_tracks[i].id);
  }

  function _playRandom() {
    if (_tracks.length <= 1) { if (_tracks[0]) play(_tracks[0].id); return; }
    let i;
    do { i = Math.floor(Math.random() * _tracks.length); } while (_tracks[i].id === _curId);
    play(_tracks[i].id);
  }

  function seek(ratio) {
    if (!_audio || !isFinite(_audio.duration)) return;
    _audio.currentTime = Math.max(0, Math.min(1, ratio)) * _audio.duration;
    _emit();
  }

  function cycleRepeatMode() {
    _repeatMode = _repeatMode === 'list' ? 'one' : (_repeatMode === 'one' ? 'shuffle' : 'list');
    _emit();
    return _repeatMode;
  }
  function getRepeatMode() { return _repeatMode; }

  function _onEnded() {
    if (_repeatMode === 'one') { if (_audio) { _audio.currentTime = 0; _audio.play().catch(()=>{}); } return; }
    next();
  }

  function _onError() {
    if (_audio && _audio.error) {
      console.warn('[Music] audio error', _audio.error);
      UI.showToast('音源加载失败（外链可能失效或被拦截）', 2500);
    }
  }

  // ---------- 进度 / 歌词 同步 ----------
  function _onTimeUpdate() {
    if (_parsedLrc && _parsedLrc.synced) {
      const ct = _audio.currentTime;
      let idx = -1;
      for (let i = 0; i < _parsedLrc.lines.length; i++) {
        if (_parsedLrc.lines[i].t <= ct) idx = i; else break;
      }
      if (idx !== _lrcLineIdx) { _lrcLineIdx = idx; _emitLrc(); }
    }
    _emitProgress();
  }

  function getProgress() {
    if (!_audio) return { cur: 0, dur: 0, ratio: 0 };
    const dur = isFinite(_audio.duration) ? _audio.duration : 0;
    const cur = _audio.currentTime || 0;
    return { cur, dur, ratio: dur ? cur / dur : 0, curText: _fmtTime(cur), durText: _fmtTime(dur) };
  }

  function getLrcState() {
    return { parsed: _parsedLrc, lineIdx: _lrcLineIdx };
  }

  // ---------- 事件（UI 订阅） ----------
  const _listeners = { state: [], progress: [], lrc: [] };
  function on(type, fn) { if (_listeners[type]) _listeners[type].push(fn); }
  function _emit() { _listeners.state.forEach(f => { try { f(); } catch (_) {} }); }
  function _emitProgress() { _listeners.progress.forEach(f => { try { f(); } catch (_) {} }); }
  function _emitLrc() { _listeners.lrc.forEach(f => { try { f(); } catch (_) {} }); }

  // ---------- 初始化 ----------
  async function init() {
    await _ensureLoaded();
  }

  return {
    init, _ensureLoaded,
    getTracks, getCurrentId, getCurrentTrack, isPlaying,
    addLocalTrack, addExternalTrack, updateTrack, removeTrack,
    play, pause, toggle, stop, next, prev, seek,
    cycleRepeatMode, getRepeatMode,
    getProgress, getLrcState, parseLrc,
    on,
    _fmtTime, _resolveExternalUrl, _extractNeteaseId, _isNeteaseShortLink
  };
})();