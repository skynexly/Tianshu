/**
 * Supabase 云备份模块（纯 fetch REST，不引 SDK）
 *
 * 让用户用自己的 Supabase 项目存/取存档备份。天枢城只是把 DataMgr 生成的
 * 存档 JSON POST 到用户表、从用户表拉回，全程走 Supabase 的 PostgREST 接口。
 *
 * 配置存 localStorage：supabase_url / supabase_key（anon key）。
 * 存档本体传 Storage bucket（tianshu-saves），数据库表只存元信息当索引。
 * 目标表结构（用户按教程建）：
 *   create table tianshu_saves (
 *     id bigint generated always as identity primary key,
 *     created_at timestamptz default now(),
 *     device text,        -- 备注/设备名
 *     mode text,          -- full / lite / text
 *     path text,          -- Storage 里的文件路径
 *     size bigint         -- 存档字节数（用于显示）
 *   );
 * 表名固定 tianshu_saves，bucket 固定 tianshu-saves。
 */
const SupabaseBackup = (() => {
  'use strict';

  const TABLE = 'tianshu_saves';
  const BUCKET = 'tianshu-saves';
  const URL_KEY = 'supabase_url';
  const KEY_KEY = 'supabase_key';
  const DEVICE_KEY = 'supabase_device_name';

  function getConfig() {
    return {
      url: (localStorage.getItem(URL_KEY) || '').trim().replace(/\/+$/, ''),
      key: (localStorage.getItem(KEY_KEY) || '').trim(),
      device: (localStorage.getItem(DEVICE_KEY) || '').trim()
    };
  }

  function setConfig(url, key, device) {
    if (url != null) localStorage.setItem(URL_KEY, String(url).trim().replace(/\/+$/, ''));
    if (key != null) localStorage.setItem(KEY_KEY, String(key).trim());
    if (device != null) localStorage.setItem(DEVICE_KEY, String(device).trim());
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c.url && c.key);
  }

  // 组装 PostgREST 请求头
  function _headers(cfg, extra) {
    return Object.assign({
      'apikey': cfg.key,
      'Authorization': 'Bearer ' + cfg.key,
      'Content-Type': 'application/json'
    }, extra || {});
  }

  function _restUrl(cfg, pathAndQuery) {
    return cfg.url + '/rest/v1/' + pathAndQuery;
  }

  // 统一的 fetch（带超时 + 错误信息提取）
  async function _fetch(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
    let resp;
    try {
      resp = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('请求超时，检查网络或 Supabase 项目地址是否正确');
      throw new Error('网络请求失败：' + (e.message || e));
    }
    clearTimeout(timer);
    if (!resp.ok) {
      let detail = '';
      try { detail = await resp.text(); } catch (_) {}
      let msg = 'HTTP ' + resp.status;
      // PostgREST 错误一般是 JSON，尽量提取 message
      try {
        const j = JSON.parse(detail);
        if (j.message) msg += '：' + j.message;
        else if (j.hint) msg += '：' + j.hint;
        else if (detail) msg += '：' + detail.slice(0, 200);
      } catch (_) {
        if (detail) msg += '：' + detail.slice(0, 200);
      }
      // 常见错误给友好提示
      if (resp.status === 401 || resp.status === 403) {
        msg += '（可能是 anon key 错误，或表的 RLS 策略没放行，请对照教程检查）';
      } else if (resp.status === 404) {
        msg += '（找不到表 ' + TABLE + '，请确认已按教程执行建表 SQL）';
      }
      throw new Error(msg);
    }
    return resp;
  }

  function _storageUrl(cfg, pathAndQuery) {
    return cfg.url + '/storage/v1/' + pathAndQuery;
  }

  // gzip 压缩：字符串 → gzip 后的 Blob。浏览器原生 CompressionStream，不引库。
  async function _gzip(str) {
    const enc = new TextEncoder().encode(str);
    const cs = new Response(new Blob([enc]).stream().pipeThrough(new CompressionStream('gzip')));
    return await cs.blob();
  }

  // gzip 解压：gzip 的 Blob/ArrayBuffer → 原始字符串
  async function _gunzip(blob) {
    const ds = new Response(blob.stream().pipeThrough(new DecompressionStream('gzip')));
    return await ds.text();
  }

  // 当前运行环境是否支持原生 gzip（老 webview 可能没有）
  function _gzipSupported() {
    return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
  }

  // 上传文件本体到 Storage bucket。path 为桶内路径（如 "1783430000000.json"）。
  // body 为 Blob。返回 true。
  async function _storageUpload(cfg, path, blob) {
    await _fetch(
      _storageUrl(cfg, 'object/' + BUCKET + '/' + path),
      {
        method: 'POST',
        headers: _headers(cfg, { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' }),
        body: blob
      },
      300000  // 大文件给 5 分钟
    );
    return true;
  }

  // 删除 Storage 文件（失败不抛，尽力而为——表行删掉更重要）
  async function _storageDelete(cfg, path) {
    try {
      await _fetch(
        _storageUrl(cfg, 'object/' + BUCKET + '/' + path),
        { method: 'DELETE', headers: _headers(cfg) },
        30000
      );
    } catch (_) {}
  }

  // 测试连接：查表（limit 1），能通就说明地址/key/表/RLS 都 OK
  async function testConnection(url, key) {
    const cfg = {
      url: String(url || '').trim().replace(/\/+$/, ''),
      key: String(key || '').trim()
    };
    if (!cfg.url || !cfg.key) throw new Error('请先填写 Project URL 和 anon key');
    if (!/^https?:\/\//i.test(cfg.url)) throw new Error('Project URL 格式不对，应以 https:// 开头');
    const resp = await _fetch(
      _restUrl(cfg, TABLE + '?select=id&limit=1'),
      { method: 'GET', headers: _headers(cfg) },
      30000
    );
    await resp.json().catch(() => []);
    return true;
  }

  // 备份：生成指定模式的存档 → gzip 压缩 → 上传到 Storage → 表里插一行元信息
  // mode: 'full' / 'lite' / 'text'；onProgress(stageText) 可选，用于 UI 显示进度
  async function backup(mode, deviceNote, onProgress) {
    const cfg = getConfig();
    if (!cfg.url || !cfg.key) throw new Error('尚未配置 Supabase，请先在设置里填写并测试连接');
    const _p = (typeof onProgress === 'function') ? onProgress : function(){};
    _p('正在生成存档…');
    const jsonStr = await DataMgr.buildSaveJson(mode);
    const rawSize = new Blob([jsonStr]).size;  // 未压缩原始大小（用于显示）
    // gzip 压缩后上传，大幅减小体积以绕开 50MB 单文件限制
    let blob, path, gz;
    if (_gzipSupported()) {
      _p('正在压缩（原始 ' + _fmtSize(rawSize) + '）…');
      blob = await _gzip(jsonStr);
      path = Date.now() + '-' + mode + '.json.gz';
      gz = true;
      _p('压缩完成：' + _fmtSize(rawSize) + ' → ' + _fmtSize(blob.size) + '，上传中…');
    } else {
      blob = new Blob([jsonStr], { type: 'application/json' });
      path = Date.now() + '-' + mode + '.json';
      gz = false;
      _p('上传中（' + _fmtSize(rawSize) + '，当前环境不支持压缩）…');
    }
    await _storageUpload(cfg, path, blob);
    // 存档本体已在 Storage，表里只存元信息当索引（size 记原始大小，便于显示真实存档体积）
    const row = {
      device: (deviceNote || cfg.device || '').slice(0, 100),
      mode: mode,
      path: path,
      size: rawSize
    };
    const resp = await _fetch(
      _restUrl(cfg, TABLE),
      {
        method: 'POST',
        headers: _headers(cfg, { 'Prefer': 'return=representation' }),
        body: JSON.stringify(row)
      },
      30000
    );
    const inserted = await resp.json().catch(() => []);
    return Array.isArray(inserted) ? inserted[0] : inserted;
  }

  // 字节数格式化（模块内用）
  function _fmtSize(b) {
    if (!b) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  // 拉备份列表（只取元信息，存档本体在 Storage，列表很轻）
  async function listBackups(limit) {
    const cfg = getConfig();
    if (!cfg.url || !cfg.key) throw new Error('尚未配置 Supabase');
    const n = Math.max(1, Math.min(100, limit || 20));
    const resp = await _fetch(
      _restUrl(cfg, TABLE + '?select=id,created_at,device,mode,path,size&order=created_at.desc&limit=' + n),
      { method: 'GET', headers: _headers(cfg) },
      30000
    );
    return await resp.json().catch(() => []);
  }

  // 拉某条备份的元信息（含 Storage path）
  async function fetchBackup(id) {
    const cfg = getConfig();
    if (!cfg.url || !cfg.key) throw new Error('尚未配置 Supabase');
    const resp = await _fetch(
      _restUrl(cfg, TABLE + '?select=path,mode&id=eq.' + encodeURIComponent(id)),
      { method: 'GET', headers: _headers(cfg) },
      30000
    );
    const rows = await resp.json().catch(() => []);
    if (!rows || !rows.length) throw new Error('找不到该备份（可能已被删除）');
    return rows[0];
  }

  // 恢复：查元信息拿 path → 从 Storage 下载存档（.gz 自动解压）→ 交给 DataMgr 覆盖
  async function restoreBackup(id) {
    const cfg = getConfig();
    const row = await fetchBackup(id);
    if (!row.path) throw new Error('该备份缺少文件路径，可能是旧格式，无法恢复');
    // 下载文件本体（Blob）
    const resp = await _fetch(
      _storageUrl(cfg, 'object/' + BUCKET + '/' + row.path),
      { method: 'GET', headers: _headers(cfg) },
      300000
    );
    const blob = await resp.blob();
    // 按后缀判断是否 gzip 压缩
    let text;
    if (/\.gz$/i.test(row.path)) {
      if (!_gzipSupported()) throw new Error('当前环境不支持解压（gzip），无法恢复这份压缩备份');
      text = await _gunzip(blob);
    } else {
      text = await blob.text();
    }
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error('备份文件解析失败，可能已损坏'); }
    if (!data || !data.version) throw new Error('备份内容无效或已损坏');
    return await DataMgr.importFromData(data);
  }

  // 删除某条备份：先删 Storage 文件，再删表行
  async function deleteBackup(id) {
    const cfg = getConfig();
    if (!cfg.url || !cfg.key) throw new Error('尚未配置 Supabase');
    // 先查 path，删掉 Storage 里的文件（失败不阻断——表行删掉才是关键）
    try {
      const row = await fetchBackup(id);
      if (row && row.path) await _storageDelete(cfg, row.path);
    } catch (_) {}
    await _fetch(
      _restUrl(cfg, TABLE + '?id=eq.' + encodeURIComponent(id)),
      { method: 'DELETE', headers: _headers(cfg) },
      30000
    );
    return true;
  }

  return {
    getConfig, setConfig, isConfigured,
    testConnection, backup, listBackups, fetchBackup, restoreBackup, deleteBackup
  };
})();
