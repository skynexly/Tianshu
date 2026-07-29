#!/usr/bin/env node
/**
 * 天枢城 · 单文件版（文件版）打包脚本
 * ------------------------------------------------------------
 * 目的：把整个 web 应用打包成一个可离线（file://）双击运行的单 HTML。
 * 主要给 iOS 用户（装不了 APK），也作为"作者跑路后仍可游玩"的存档版。
 *
 * 做的事：
 *  1. 按 index.html 里 <link>/<script src> 的顺序，把 css/js 内联进 HTML
 *  2. 保留的图片（世界观图标 / 教程头像 / 字体）转 base64 内联
 *  3. 被剥离的图片（fx 特效 / 直播背景头像 / 影视封面）：引用替换为 1x1 透明占位，避免裂图
 *  4. 运行时 fetch 本地文件（guide.md ×3、css/style.css ×1）注入成全局变量，file:// 下可用
 *  5. 去掉 Service Worker 注册（file:// 下 SW 无法注册）
 *  6. 保留 wttr.in 天气请求（失败自动降级，不影响主流程）
 *
 * 用法：node build-standalone.js
 * 产物：dist/天枢城-单文件版.html
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'skynex文件版.html');

// 1x1 透明 PNG，占位用（避免 <img> 裂图 / 触发默认兜底）
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ---- 工具函数 ----
function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function fileToDataURI(rel) {
  const abs = path.join(ROOT, rel);
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase().slice(1);
  const mime = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
    woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf'
  }[ext] || 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}
// 去掉资源路径上的 ?v=xxx 查询串
function stripQuery(p) { return p.split('?')[0]; }
function exists(rel) { try { fs.accessSync(path.join(ROOT, rel)); return true; } catch { return false; } }

// ---- 保留内联的图片清单（其余 img/ 一律占位剥离） ----
const KEEP_IMAGES = [
  'img/worldviews/heartsim.png',
  'img/tutorial-avatar.jpg',
];

// 把某个文本里所有 img/xxx 引用做处理：保留清单转 base64，其余转透明占位
function rewriteImgRefs(text) {
  // 匹配 img/ 开头、到引号/括号/空白结束的相对路径
  return text.replace(/img\/[^\s'"()`]+\.(?:png|jpe?g|webp|gif|svg)/gi, (m) => {
    const clean = stripQuery(m);
    if (KEEP_IMAGES.includes(clean) && exists(clean)) {
      try { return fileToDataURI(clean); } catch { return BLANK_PNG; }
    }
    return BLANK_PNG; // 剥离的资源 → 透明占位
  });
}

console.log('[build] 读取 index.html …');
let html = readText('index.html');

// ============ 1. 内联 CSS ============
// 匹配 <link rel="stylesheet" href="css/xxx.css?v=..">
html = html.replace(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']\s*\/?>/gi, (full, href) => {
  const rel = stripQuery(href);
  if (!exists(rel)) { console.warn('[css] 跳过（不存在）:', rel); return full; }
  console.log('[css] 内联:', rel);
  let css = readText(rel);
  // 字体：../fonts/xxx.woff2 → base64
  css = css.replace(/url\(\s*['"]?((?:\.\.\/)?fonts\/[^'")]+\.woff2?)['"]?\s*\)/gi, (m, p) => {
    const fontRel = p.replace(/^\.\.\//, '');
    if (exists(fontRel)) {
      try { return `url('${fileToDataURI(fontRel)}')`; } catch { return m; }
    }
    return m;
  });
  // css 里的 img/ 引用（fx 特效等）→ 占位剥离
  css = rewriteImgRefs(css);
  return `<style data-src="${rel}">\n${css}\n</style>`;
});

// ============ 2. 内联 JS ============
html = html.replace(/<script\s+src=["']([^"']+)["']\s*><\/script>/gi, (full, src) => {
  const rel = stripQuery(src);
  if (!exists(rel)) { console.warn('[js] 跳过（不存在）:', rel); return full; }
  console.log('[js] 内联:', rel);
  let js = readText(rel);
  // js 里硬编码的 img/ 引用 → 占位剥离/保留
  js = rewriteImgRefs(js);
  // 避免脚本内容里的 </script> 提前闭合
  js = js.replace(/<\/script>/gi, '<\\/script>');
  return `<script data-src="${rel}">\n${js}\n</script>`;
});

// ============ 3. 注入运行时 fetch 依赖的本地文件（guide.md / css/style.css） ============
// 应用里有 fetch('guide.md') 和 fetch('css/style.css')；file:// 下会被 CORS 拦。
// 预置成全局变量，并 patch fetch 让这两个路径走内存。
const guideMd = exists('guide.md') ? readText('guide.md') : '';
// style.css 已在上面被内联进 <style>，但 statusbar_theme.js 会 fetch 它的原文，这里单独存一份原文
const styleCssRaw = exists('css/style.css') ? readText('css/style.css') : '';

const injectHead = `<script data-inject="standalone-fetch-shim">
(function(){
  // ==== 文件版：本地资源内存表 ====
  window.__STANDALONE__ = true;
  var __FILES__ = {
    'guide.md': ${JSON.stringify(guideMd)},
    'css/style.css': ${JSON.stringify(styleCssRaw)}
  };
  // patch fetch：命中内存表的本地路径直接返回，其余走原生 fetch（如 wttr.in 天气）
  var _origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function(input, init){
    try {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var clean = String(url).split('?')[0].replace(/^\\.?\\//,'');
      if (Object.prototype.hasOwnProperty.call(__FILES__, clean)) {
        var body = __FILES__[clean];
        return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
      }
    } catch(e){}
    if (_origFetch) return _origFetch(input, init);
    return Promise.reject(new Error('fetch unavailable'));
  };
})();
</script>`;

// 插到 <head> 之后、第一个 <style>/<script> 之前，确保 shim 最早生效
html = html.replace(/<head>/i, '<head>\n' + injectHead);

// ============ 3.4 老存档兜底：DB 里存的是相对路径（img/...）时，file:// 下会裂 ============
// 老用户存档里 iconImage 等字段存的是相对路径（如 img/worldviews/heartsim.png），
// 内置模板改 base64 救不了他们（DB 旧值改不动）。这里注入运行时兜底：
//   1) 把 KEEP_IMAGES 建成 { 相对路径 -> base64 } 映射表
//   2) 全局监听 <img> 加载失败：src 命中映射表就换 base64，否则换透明占位（不裂）
const imgMap = {};
for (const rel of KEEP_IMAGES) {
  if (exists(rel)) {
    try { imgMap[rel] = fileToDataURI(rel); } catch(_) {}
  }
}
const imgFallbackShim = `<script data-inject="standalone-img-fallback">
(function(){
  var MAP = ${JSON.stringify(imgMap)};
  var BLANK = ${JSON.stringify(BLANK_PNG)};
  function norm(u){ try { return String(u||'').split('?')[0].replace(/^\\.?\\//,''); } catch(e){ return ''; } }
  function fix(img){
    try {
      var key = norm(img.getAttribute('src'));
      if (!key) return;
      // 已经是 data:/http(s) 的不管
      var raw = img.getAttribute('src') || '';
      if (/^(data:|https?:)/i.test(raw)) return;
      if (MAP[key]) { img.src = MAP[key]; }
      else if (/^img\\//i.test(key) || /^src\\//i.test(key)) { img.src = BLANK; }
    } catch(e){}
  }
  // 捕获阶段监听全局 img error（error 不冒泡，必须用 capture）
  document.addEventListener('error', function(e){
    var t = e && e.target;
    if (t && t.tagName === 'IMG') fix(t);
  }, true);
})();
</script>`;
html = html.replace(/<head>/i, '<head>\n' + imgFallbackShim);

// ============ 3.5 内联 img/ 之外的关键图片（开屏动画 / 登录 logo） ============
// splash.gif 在 src/ 下、logo.png 在根目录，都不匹配 rewriteImgRefs 的 img/ 规则，
// 内联脚本前它们既没被剥离也没被转 base64，file:// 下会死链裂图。这里精确替换带引号的引用。
const EXTRA_INLINE = [
  'src/splash.gif',
  'logo.png',
];
for (const rel of EXTRA_INLINE) {
  if (!exists(rel)) { console.warn('[extra-img] 跳过（不存在）:', rel); continue; }
  let uri;
  try { uri = fileToDataURI(rel); } catch { console.warn('[extra-img] 转码失败:', rel); continue; }
  // 只替换带引号的完整引用：src="rel" / src='rel'，避免裸文件名误伤
  const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(["\'])' + esc + '(\\?[^"\']*)?\\1', 'g');
  const before = html;
  html = html.replace(re, (m, q) => q + uri + q);
  console.log('[extra-img] 内联:', rel, before === html ? '(无匹配)' : '✓');
}

// ============ 4. 去掉 Service Worker 注册 ============
html = html.replace(/if\s*\(\s*['"]serviceWorker['"]\s+in\s+navigator\s*\)\s*\{[\s\S]*?navigator\.serviceWorker\.register\([^)]*\)[^}]*\}/gi,
  '/* SW 注册已移除（文件版 file:// 下不支持） */');

// ============ 5. 去掉 manifest / apple-touch-icon（file:// 下无意义，且会报 404） ============
html = html.replace(/<link\s+rel=["']manifest["'][^>]*>/gi, '<!-- manifest removed for standalone -->');
html = html.replace(/<link\s+rel=["']apple-touch-icon["']\s+href=["'][^"']*["'][^>]*>/gi, (m) => {
  // apple-touch-icon 用 icon-192.png，可以内联保留（iOS 加桌面时的图标）
  if (exists('icon-192.png')) {
    try { return `<link rel="apple-touch-icon" href="${fileToDataURI('icon-192.png')}">`; } catch { return '<!-- apple-touch-icon removed -->'; }
  }
  return '<!-- apple-touch-icon removed -->';
});

// ============ 输出 ============
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, html, 'utf8');

const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(2);
console.log('\n[build] ✅ 完成');
console.log('[build] 产物:', OUT_FILE);
console.log('[build] 体积:', sizeMB, 'MB');
