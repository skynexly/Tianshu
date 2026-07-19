/**
 * GitHub 云备份模块（纯 fetch REST，不引 SDK）
 *
 * 让用户用自己的 GitHub 仓库存/取存档备份。天枢城把 DataMgr 生成的存档 JSON
 * gzip 压缩后 base64 编码，通过 GitHub Contents API PUT 到用户仓库的 saves/ 目录，
 * 恢复时反向拉回。全程走 GitHub 官方 REST 接口，skynex 不经手数据。
 *
 * 配置存 localStorage：github_owner / github_repo / github_token / github_device_name
 * 备份文件命名：saves/{时间戳}-{mode}.json.gz（.gz 表示 gzip 压缩）
 * 列表 = 列 saves/ 目录 + 解析文件名。删除/覆盖需带文件当前 sha。
 *
 * 接口与 SupabaseBackup 对齐，供云备份面板统一调用。
 *
 * 容量：GitHub 单文件上限 100MB（超 50MB 会有警告但仍可传），比 Supabase 免费版更宽松。
 */
const GithubBackup = (() => {
  'use strict';

  const OWNER_KEY = 'github_owner';
  const REPO_KEY = 'github_repo';
  const TOKEN_KEY = 'github_token';
  const DEVICE_KEY = 'github_device_name';
  const DIR = 'saves';               // 仓库内存放备份的目录
  const API = 'https://api.github.com';
  // 单片原始字节上限。base64 编码后膨胀 ~33%，20MB → 约 27MB 请求体，
  // 稳稳落在 GitHub REST 单请求 ~40MB 的硬限制内。大存档超过此值就切片。
  const PART_BYTES = 20 * 1024 * 1024;

  function getConfig() {
    return {
      owner: (localStorage.getItem(OWNER_KEY) || '').trim(),
      repo: (localStorage.getItem(REPO_KEY) || '').trim(),
      token: (localStorage.getItem(TOKEN_KEY) || '').trim(),
      device: (localStorage.getItem(DEVICE_KEY) || '').trim()
    };
  }

  function setConfig(owner, repo, token, device) {
    if (owner != null) localStorage.setItem(OWNER_KEY, String(owner).trim());
    if (repo != null) localStorage.setItem(REPO_KEY, String(repo).trim());
    if (token != null) localStorage.setItem(TOKEN_KEY, String(token).trim());
    if (device != null) localStorage.setItem(DEVICE_KEY, String(device).trim());
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c.owner && c.repo && c.token);
  }

  // 组装 GitHub API 请求头
  function _headers(cfg, extra) {
    return Object.assign({
      'Authorization': 'Bearer ' + cfg.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }, extra || {});
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
      if (e.name === 'AbortError') throw new Error('请求超时，检查网络或仓库地址是否正确');
      throw new Error('网络请求失败：' + (e.message || e));
    }
    clearTimeout(timer);
    if (!resp.ok) {
      let detail = '';
      try { detail = await resp.text(); } catch (_) {}
      let msg = 'HTTP ' + resp.status;
      try {
        const j = JSON.parse(detail);
        if (j.message) msg += '：' + j.message;
        else if (detail) msg += '：' + detail.slice(0, 200);
      } catch (_) {
        if (detail) msg += '：' + detail.slice(0, 200);
      }
      // 常见错误给友好提示
      if (resp.status === 401) {
        msg += '（Token 无效或已过期，请对照教程重新生成）';
      } else if (resp.status === 403) {
        msg += '（Token 权限不足，请确认给了目标仓库的 Contents 读写权限）';
      } else if (resp.status === 404) {
        msg += '（找不到仓库或路径，请检查用户名/仓库名是否正确，仓库是否已创建）';
      } else if (resp.status === 409) {
        msg += '（文件冲突，可能是并发操作，请刷新列表后重试）';
      } else if (resp.status === 422) {
        msg += '（文件可能过大，GitHub 单文件上限 100MB）';
      }
      const err = new Error(msg);
      err.status = resp.status;   // 挂上状态码，供重试逻辑判断
      throw err;
    }
    return resp;
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

  // Blob/ArrayBuffer → base64 字符串（GitHub Contents API 要求 content 为 base64）
  async function _blobToBase64(blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // 分块处理避免超大数组 apply 爆栈
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // base64 字符串 → Blob
  function _base64ToBlob(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes]);
  }

  // 一个错误是否值得重试：网络/超时（无 status）、限流（429）、服务端抖动（5xx）可重试；
  // 认证/权限/找不到/参数错（401/403/404/422）是确定性错误，重试无意义，直接放行。
  function _isRetryable(err) {
    const st = err && err.status;
    if (st == null) return true;          // fetch 层失败（网络中断、超时）
    if (st === 429) return true;          // 限流
    if (st >= 500 && st < 600) return true;
    return false;
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 上传单个 blob（一段二进制），返回 blob sha。失败自动重试（仅对偶发错误）。
  // label：进度提示里显示的分片标识（如 "分片 2/5"）；_p：进度回调
  async function _uploadBlob(cfg, blobPart, label, _p) {
    const MAX_TRY = 3;                     // 首次 + 重试 2 次
    let lastErr;
    for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
      try {
        const contentB64 = await _blobToBase64(blobPart);
        const resp = await _fetch(
          _gitUrl(cfg, 'blobs'),
          {
            method: 'POST',
            headers: _headers(cfg, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ content: contentB64, encoding: 'base64' })
          },
          600000
        );
        const j = await resp.json();
        if (!j || !j.sha) throw new Error('上传数据失败：未拿到 blob sha');
        return j.sha;
      } catch (e) {
        lastErr = e;
        // 确定性错误或已到最后一次，直接抛
        if (!_isRetryable(e) || attempt === MAX_TRY) throw e;
        // 偶发错误：等待递增后重试（1s、2s）
        if (typeof _p === 'function') {
          _p((label ? label + ' ' : '') + '上传失败，重试中（' + attempt + '/' + (MAX_TRY - 1) + '）…');
        }
        await _sleep(attempt * 1000);
      }
    }
    throw lastErr;
  }

  // 一次性把一组文件（{path, sha}）挂到分支上，原子提交（分片备份的多个文件同时上链）
  async function _commitTree(cfg, entries, commitMsg) {
    const branch = await _getDefaultBranch(cfg);
    // 当前 commit
    const refResp = await _fetch(
      _gitUrl(cfg, 'ref/heads/' + encodeURIComponent(branch)),
      { method: 'GET', headers: _headers(cfg) }, 30000
    );
    const refJson = await refResp.json();
    const baseCommitSha = refJson && refJson.object && refJson.object.sha;
    if (!baseCommitSha) throw new Error('读取分支失败：未拿到 commit sha');
    // 当前 tree
    const commitResp = await _fetch(
      _gitUrl(cfg, 'commits/' + encodeURIComponent(baseCommitSha)),
      { method: 'GET', headers: _headers(cfg) }, 30000
    );
    const commitJson = await commitResp.json();
    const baseTreeSha = commitJson && commitJson.tree && commitJson.tree.sha;
    if (!baseTreeSha) throw new Error('读取提交树失败：未拿到 tree sha');
    // 新 tree（把所有 entries 挂上去）
    const treeResp = await _fetch(
      _gitUrl(cfg, 'trees'),
      {
        method: 'POST',
        headers: _headers(cfg, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: entries.map(e => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha }))
        })
      }, 60000
    );
    const treeJson = await treeResp.json();
    const newTreeSha = treeJson && treeJson.sha;
    if (!newTreeSha) throw new Error('创建提交树失败：未拿到 tree sha');
    // 新 commit
    const newCommitResp = await _fetch(
      _gitUrl(cfg, 'commits'),
      {
        method: 'POST',
        headers: _headers(cfg, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message: commitMsg, tree: newTreeSha, parents: [baseCommitSha] })
      }, 60000
    );
    const newCommitJson = await newCommitResp.json();
    const newCommitSha = newCommitJson && newCommitJson.sha;
    if (!newCommitSha) throw new Error('创建提交失败：未拿到 commit sha');
    // 移动分支指针
    await _fetch(
      _gitUrl(cfg, 'refs/heads/' + encodeURIComponent(branch)),
      {
        method: 'PATCH',
        headers: _headers(cfg, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ sha: newCommitSha })
      }, 30000
    );
    return newCommitSha;
  }

  function _contentsUrl(cfg, path) {
    return API + '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo)
      + '/contents/' + path;
  }

  // Git Data API 基址：/repos/{owner}/{repo}/git/...
  function _gitUrl(cfg, sub) {
    return API + '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo)
      + '/git/' + sub;
  }

  // 拿仓库默认分支名（如 main / master），避免写死
  async function _getDefaultBranch(cfg) {
    const resp = await _fetch(
      API + '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo),
      { method: 'GET', headers: _headers(cfg) },
      30000
    );
    const info = await resp.json().catch(() => ({}));
    return (info && info.default_branch) ? info.default_branch : 'main';
  }

  // 测试连接：GET 仓库信息，能通就说明用户名/仓库名/token 都 OK
  async function testConnection(owner, repo, token) {
    const cfg = {
      owner: String(owner || '').trim(),
      repo: String(repo || '').trim(),
      token: String(token || '').trim()
    };
    if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error('请先填写用户名、仓库名和 Token');
    const resp = await _fetch(
      API + '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo),
      { method: 'GET', headers: _headers(cfg) },
      30000
    );
    const info = await resp.json().catch(() => ({}));
    // 顺带校验有没有写权限
    if (info && info.permissions && info.permissions.push === false) {
      throw new Error('该 Token 对此仓库没有写权限，请检查 Token 的 Contents 权限设置');
    }
    return true;
  }

  // 字节数格式化
  function _fmtSize(b) {
    if (!b) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  // 备份：生成存档 → gzip → base64 →【Git Data API 分步提交】
  // 小文件走单 blob（老命名，向后兼容）；大文件自动切片，每片单独 POST blob，
  // 最后一次 commit 把所有分片原子挂上去，突破 REST 单请求 ~40MB 的硬限制。
  // mode: 'full' / 'lite' / 'text'；onProgress(stageText) 可选；
  // confirmFn(sizeText) 可选：存档超大时调用它请求用户确认，返回 false 则中止。
  async function backup(mode, deviceNote, onProgress, confirmFn) {
    const cfg = getConfig();
    if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error('尚未配置 GitHub，请先在设置里填写并测试连接');
    const _p = (typeof onProgress === 'function') ? onProgress : function(){};
    _p('正在生成存档…');
    const jsonStr = await DataMgr.buildSaveJson(mode);
    const rawSize = new Blob([jsonStr]).size;

    // 超大存档预检：生成/压缩/编码会占用较多内存，低配手机可能卡顿或崩溃。
    // 超阈值时请求用户确认（不硬拦，把决定权交给用户）。
    const BIG_THRESHOLD = 300 * 1024 * 1024;   // 原始存档 300MB
    if (rawSize > BIG_THRESHOLD && typeof confirmFn === 'function') {
      const ok = await confirmFn(_fmtSize(rawSize));
      if (!ok) throw new Error('已取消（存档过大）');
    }

    const ts = Date.now();
    const dev = (deviceNote || cfg.device || '').slice(0, 100);
    const gz = _gzipSupported();

    let blob;
    if (gz) {
      _p('正在压缩（原始 ' + _fmtSize(rawSize) + '）…');
      blob = await _gzip(jsonStr);
      _p('压缩完成：' + _fmtSize(rawSize) + ' → ' + _fmtSize(blob.size));
    } else {
      blob = new Blob([jsonStr], { type: 'application/json' });
      _p('准备上传（' + _fmtSize(rawSize) + '，当前环境不支持压缩）…');
    }

    const commitMsg = 'backup: ' + mode + ' ' + _fmtSize(rawSize) + (dev ? (' · ' + dev) : '');

    // —— 小文件：单 blob（沿用老命名 {ts}-{mode}.json[.gz]），完全向后兼容 —— //
    if (blob.size <= PART_BYTES) {
      const fileName = ts + '-' + mode + (gz ? '.json.gz' : '.json');
      const path = DIR + '/' + fileName;
      _p('上传数据中（' + _fmtSize(blob.size) + '）…');
      const sha = await _uploadBlob(cfg, blob, '', _p);
      _p('提交中…');
      await _commitTree(cfg, [{ path: path, sha: sha }], commitMsg);
      return { path: path, mode: mode, size: rawSize, device: dev };
    }

    // —— 大文件：切片。命名 {ts}-{mode}.jsonc.p000 / .p001 ...（jsonc = 分片压缩集）—— //
    // .p000 是主片（列表靠它识别一条备份），其余是续片。gz 与否由主片名的 c 后缀隐含（jsonc=压缩，jsonp=未压缩）
    const ext = gz ? 'jsonc' : 'jsonp';
    const totalParts = Math.ceil(blob.size / PART_BYTES);
    const entries = [];
    for (let i = 0; i < totalParts; i++) {
      const start = i * PART_BYTES;
      const partBlob = blob.slice(start, Math.min(start + PART_BYTES, blob.size));
      const label = '分片 ' + (i + 1) + '/' + totalParts;
      _p(label + '（' + _fmtSize(partBlob.size) + '）…');
      const sha = await _uploadBlob(cfg, partBlob, label, _p);
      const partName = ts + '-' + mode + '.' + ext + '.p' + String(i).padStart(3, '0');
      entries.push({ path: DIR + '/' + partName, sha: sha });
    }
    _p('提交中（' + totalParts + ' 个分片）…');
    await _commitTree(cfg, entries, commitMsg + ' [' + totalParts + ' parts]');
    return { path: entries[0].path, mode: mode, size: rawSize, device: dev, parts: totalParts };
  }

  // 从文件名解析出元信息。支持两种：
  //  · 单文件：{ts}-{mode}.json[.gz]
  //  · 分片：  {ts}-{mode}.jsonc.pNNN（压缩）/ .jsonp.pNNN（未压缩）
  function _parseFileName(name) {
    const s = String(name);
    // 分片：{ts}-{mode}.jsonc|jsonp.pNNN
    const mp = s.match(/^(\d+)-(full|lite|text)\.(jsonc|jsonp)\.p(\d+)$/i);
    if (mp) {
      return {
        ts: Number(mp[1]),
        mode: mp[2].toLowerCase(),
        gz: mp[3].toLowerCase() === 'jsonc',
        chunked: true,
        partIndex: Number(mp[4])
      };
    }
    // 单文件：{ts}-{mode}.json[.gz]
    const m = s.match(/^(\d+)-(full|lite|text)\.json(\.gz)?$/i);
    if (!m) return null;
    return {
      ts: Number(m[1]),
      mode: m[2].toLowerCase(),
      gz: !!m[3],
      chunked: false,
      partIndex: 0
    };
  }

  // 拉备份列表：列 saves/ 目录，把分片聚合成一条备份，按时间倒序
  async function listBackups(limit) {
    const cfg = getConfig();
    if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error('尚未配置 GitHub');
    let resp;
    try {
      resp = await _fetch(
        _contentsUrl(cfg, DIR),
        { method: 'GET', headers: _headers(cfg) },
        30000
      );
    } catch (e) {
      // saves/ 目录还不存在（从没备份过）→ 返回空列表，而不是报错
      if (/HTTP 404/.test(e.message || '')) return [];
      throw e;
    }
    const files = await resp.json().catch(() => []);
    if (!Array.isArray(files)) return [];

    // 先解析所有文件，按 {ts}-{mode} 归组（同组 = 一条备份，可能含多个分片）
    const groups = {};
    files.filter(f => f && f.type === 'file').forEach(f => {
      const meta = _parseFileName(f.name);
      if (!meta) return;
      const key = meta.ts + '-' + meta.mode;
      if (!groups[key]) {
        groups[key] = {
          id: f.path,           // 主片/单文件的 path 当 id（会在下面按 partIndex 修正为 p000）
          name: f.name,
          mode: meta.mode,
          ts: meta.ts,
          gz: meta.gz,
          chunked: meta.chunked,
          size: 0,
          parts: 0,
          _minPart: Infinity
        };
      }
      const g = groups[key];
      g.size += (f.size || 0);
      g.parts += 1;
      // 分片：以 partIndex 最小的那个（p000）作为 id 和 name
      if (meta.chunked) {
        g.chunked = true;
        if (meta.partIndex < g._minPart) {
          g._minPart = meta.partIndex;
          g.id = f.path;
          g.name = f.name;
        }
      }
    });

    const rows = Object.keys(groups).map(k => {
      const g = groups[k];
      return {
        id: g.id,
        path: g.id,
        name: g.name,
        mode: g.mode,
        ts: g.ts,
        created_at: g.ts ? new Date(g.ts).toISOString() : '',
        size: g.size,           // 分片则为所有分片字节之和
        parts: g.chunked ? g.parts : 1
      };
    }).sort((a, b) => (b.ts || 0) - (a.ts || 0));

    const n = Math.max(1, Math.min(100, limit || 20));
    return rows.slice(0, n);
  }

  // 判断一个 id/path 是不是分片主片（.jsonc.p000 / .jsonp.p000）
  function _chunkInfo(path) {
    const m = String(path).match(/^(.*\/)?(\d+)-(full|lite|text)\.(jsonc|jsonp)\.p(\d+)$/i);
    if (!m) return null;
    return {
      dir: m[1] || '',
      ts: m[2],
      mode: m[3].toLowerCase(),
      ext: m[4].toLowerCase(),        // jsonc / jsonp
      gz: m[4].toLowerCase() === 'jsonc',
      partIndex: Number(m[5])
    };
  }

  // 列出某条分片备份的所有分片文件（含 sha），按 partIndex 升序。用于恢复/删除。
  async function _listGroupParts(cfg, ci) {
    const resp = await _fetch(
      _contentsUrl(cfg, DIR),
      { method: 'GET', headers: _headers(cfg) },
      30000
    );
    const files = await resp.json().catch(() => []);
    if (!Array.isArray(files)) throw new Error('读取分片列表失败');
    const prefix = ci.ts + '-' + ci.mode + '.' + ci.ext + '.p';
    const parts = files
      .filter(f => f && f.type === 'file' && f.name.indexOf(prefix) === 0)
      .map(f => {
        const pm = f.name.match(/\.p(\d+)$/);
        return { path: f.path, sha: f.sha, idx: pm ? Number(pm[1]) : 0 };
      })
      .sort((a, b) => a.idx - b.idx);
    if (!parts.length) throw new Error('找不到该备份的分片（可能已被删除）');
    return parts;
  }

  // 读取单个 blob 的完整二进制（走 Blobs raw，无大小截断）。失败自动重试（仅偶发错误）。
  async function _fetchBlobRaw(cfg, sha, label, _p) {
    const MAX_TRY = 3;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
      try {
        const resp = await _fetch(
          _gitUrl(cfg, 'blobs/' + encodeURIComponent(sha)),
          { method: 'GET', headers: _headers(cfg, { 'Accept': 'application/vnd.github.raw+json' }) },
          600000
        );
        return await resp.blob();
      } catch (e) {
        lastErr = e;
        if (!_isRetryable(e) || attempt === MAX_TRY) throw e;
        if (typeof _p === 'function') {
          _p((label ? label + ' ' : '') + '下载失败，重试中（' + attempt + '/' + (MAX_TRY - 1) + '）…');
        }
        await _sleep(attempt * 1000);
      }
    }
    throw lastErr;
  }

  // 恢复：单文件直接读；分片则把所有片按序拉回拼接，再解压 → DataMgr 覆盖。
  // id 是单文件 path 或分片主片（p000）的 path。onProgress(stageText) 可选。
  async function restoreBackup(id, onProgress) {
    const cfg = getConfig();
    if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error('尚未配置 GitHub');
    const _p = (typeof onProgress === 'function') ? onProgress : function(){};
    const path = String(id);
    const ci = _chunkInfo(path);

    let combinedBlob, isGz;
    if (ci) {
      // —— 分片恢复：拉全部分片，按序拼接 —— //
      const parts = await _listGroupParts(cfg, ci);
      const blobs = [];
      for (let i = 0; i < parts.length; i++) {
        const label = '下载分片 ' + (i + 1) + '/' + parts.length;
        _p(label + '…');
        blobs.push(await _fetchBlobRaw(cfg, parts[i].sha, label, _p));
      }
      combinedBlob = new Blob(blobs);   // 顺序拼接还原压缩包
      isGz = ci.gz;
    } else {
      // —— 单文件恢复 —— //
      _p('下载中…');
      const metaResp = await _fetch(
        _contentsUrl(cfg, path),
        { method: 'GET', headers: _headers(cfg, { 'Accept': 'application/vnd.github.object+json' }) },
        30000
      );
      const meta = await metaResp.json().catch(() => ({}));
      const sha = meta && meta.sha;
      if (!sha) throw new Error('找不到该备份（可能已被删除）');
      combinedBlob = await _fetchBlobRaw(cfg, sha, '', _p);
      isGz = /\.gz$/i.test(path);
    }

    let text;
    if (isGz) {
      if (!_gzipSupported()) throw new Error('当前环境不支持解压（gzip），无法恢复这份压缩备份');
      text = await _gunzip(combinedBlob);
    } else {
      text = await combinedBlob.text();
    }
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error('备份文件解析失败，可能已损坏'); }
    if (!data || !data.version) throw new Error('备份内容无效或已损坏');
    return await DataMgr.importFromData(data);
  }

  // 取某条备份的元信息（云备份面板恢复流程用；GitHub 这里直接返回 path 即可）
  async function fetchBackup(id) {
    return { path: String(id) };
  }

  // 删除某条备份：单文件删一个；分片则整组一起删。
  async function deleteBackup(id) {
    const cfg = getConfig();
    if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error('尚未配置 GitHub');
    const path = String(id);
    const ci = _chunkInfo(path);

    // 目标文件列表：分片=整组，单文件=[自身]
    let targets;
    if (ci) {
      targets = (await _listGroupParts(cfg, ci)).map(p => ({ path: p.path, sha: p.sha }));
    } else {
      const metaResp = await _fetch(
        _contentsUrl(cfg, path),
        { method: 'GET', headers: _headers(cfg, { 'Accept': 'application/vnd.github.object+json' }) },
        30000
      );
      const meta = await metaResp.json().catch(() => ({}));
      if (!meta || !meta.sha) throw new Error('找不到该备份（可能已被删除）');
      targets = [{ path: path, sha: meta.sha }];
    }

    // 逐个 DELETE（Contents API 单文件删除，需带各自 sha）
    for (let i = 0; i < targets.length; i++) {
      await _fetch(
        _contentsUrl(cfg, targets[i].path),
        {
          method: 'DELETE',
          headers: _headers(cfg, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            message: 'delete backup: ' + targets[i].path,
            sha: targets[i].sha
          })
        },
        30000
      );
    }
    return true;
  }

  return {
    getConfig, setConfig, isConfigured,
    testConnection, backup, listBackups, fetchBackup, restoreBackup, deleteBackup
  };
})();
