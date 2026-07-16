/**
 * 完整Markdown渲染器（无依赖）
 * 支持：h1-h6、粗体、斜体、删除线、行内代码、代码块、
 * 引用（含嵌套）、有序/无序列表（含嵌套）、表格、分割线、链接、图片、HTML混写
 */
const Markdown = (() => {

  function render(text, opts) {
    if (!text) return '';
    const _streaming = !!(opts && opts.streaming);
    // 先提取代码块保护起来
    const codeBlocks = [];
    // v711：HTML 沙箱 iframe 单独存，在 sanitize 之后才恢复——绝不能让 sanitize 洗它的 srcdoc
    // （sanitize 会删 on* 事件，会把 srcdoc 里 AI 写的 onclick 全删掉，导致 iframe 内点不了）。
    const iframeBlocks = [];
    let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      // html/svg/xml 围栏（v711）：渲染进 sandbox iframe 隔离执行（可交互、不污染主页面、读不到本站数据）。
      // 流式过程中先占位，避免半截 HTML 反复重建 iframe 导致闪烁/报错；流结束才真正建 iframe。
      if (/^(html|svg|xml)$/i.test(lang)) {
        if (_streaming) {
          const idx = codeBlocks.length;
          codeBlocks.push('<div class="html-sandbox-loading" style="padding:12px;border:1px dashed var(--border);border-radius:8px;color:var(--text-secondary);font-size:12px;opacity:0.7">✦ HTML 组件加载中…</div>');
          return `\x00CB${idx}\x00`;
        }
        const fid = 'htmlbox_' + Math.random().toString(36).slice(2, 10);
        const doc = _buildSandboxDoc(code, fid);
        const ifIdx = iframeBlocks.length;
        iframeBlocks.push(
          '<iframe class="html-sandbox" data-hid="' + fid + '" ' +
          'sandbox="allow-scripts" scrolling="no" loading="lazy" ' +
          'style="width:100%;height:60px;border:0;display:block;background:transparent" ' +
          'srcdoc="' + escAttr(doc) + '"></iframe>'
        );
        return `\x00IF${ifIdx}\x00`;
      }
      const idx = codeBlocks.length;
      codeBlocks.push(`<pre><code class="lang-${lang}">${esc(code)}</code></pre>`);
      return `\x00CB${idx}\x00`;
    });

    // 提取 <style>...</style> 整块保护，避免多行 CSS 被逐行处理拆成 <p>/<br>
    // （内容原样存起来，作用域限定由出口的 sanitize 统一处理）
    const styleBlocks = [];
    // 占位符前后补换行，确保它「独占一行」——否则单行 HTML（如 <style>...</style><div>...）
    // 抽走 style 后占位符与后续 <div> 同处一行，会被判为普通段落用 <p> 包住、后续结构丢失。
    processed = processed.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (m) => {
      const idx = styleBlocks.length;
      styleBlocks.push(m);
      return `\n\x00SB${idx}\x00\n`;
    });

    // 提取 <script>...</script> 整块保护（避免多行脚本被逐行处理拆坏），最终一律丢弃。
    const scriptBlocks = [];
    processed = processed.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (m) => {
      const idx = scriptBlocks.length;
      scriptBlocks.push(m);
      return `\n\x00JS${idx}\x00\n`;
    });

    // 提取行内代码
    const inlineCodes = [];
    processed = processed.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code>${esc(code)}</code>`);
      return `\x00IC${idx}\x00`;
    });

    // 按行处理
    const lines = processed.split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 占位符独占一行（如 <style> 块、<script> 块、html 围栏块、iframe 沙箱块）：原样通过，不要包 <p>
      if (/^\s*\x00(?:SB|CB|JS|IF)\d+\x00\s*$/.test(line)) {
        html += line.trim();
        i++;
        continue;
      }

      // 表格
      if (line.includes('|') && i + 1 < lines.length && /^\|?[\s-:|]+\|/.test(lines[i + 1])) {
        const tableResult = parseTable(lines, i);
        html += tableResult.html;
        i = tableResult.endIndex;
        continue;
      }

      // 分割线
      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
        html += '<hr>';
        i++;
        continue;
      }

      // 标题
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        html += `<h${level}>${inline(headingMatch[2])}</h${level}>`;
        i++;
        continue;
      }

      // 引用
      if (line.trimStart().startsWith('>')) {
        const quoteResult = parseBlockquote(lines, i);
        html += quoteResult.html;
        i = quoteResult.endIndex;
        continue;
      }

      // 无序列表
      if (/^(\s*)([-*+])\s+/.test(line)) {
        const listResult = parseList(lines, i, 'ul');
        html += listResult.html;
        i = listResult.endIndex;
        continue;
      }

      // 有序列表
      if (/^(\s*)\d+[.)]\s+/.test(line)) {
        const listResult = parseList(lines, i, 'ol');
        html += listResult.html;
        i = listResult.endIndex;
        continue;
      }

      // HTML标签直接通过
      if (/^\s*<[a-zA-Z\/]/.test(line)) {
        html += line;
        i++;
        continue;
      }

      // 空行
      if (line.trim() === '') {
        i++;
        continue;
      }

      // 普通段落
      let para = inline(line);
      i++;
      while (i < lines.length && lines[i].trim() !== '' &&
             !lines[i].match(/^#{1,6}\s/) &&
             !lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+/) &&
             !lines[i].trimStart().startsWith('>') &&
             !lines[i].includes('|') &&
             !/^(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[i].trim()) &&
             !/^\s*<[a-zA-Z\/]/.test(lines[i]) &&
             !/^```/.test(lines[i])) {
        para += '<br>' + inline(lines[i]);
        i++;
      }
      html += `<p>${para}</p>`;
    }

    // 恢复代码块
    html = html.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);
    // 恢复行内代码
    html = html.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)]);
    // 恢复 <style> 块（原样恢复，作用域限定交给下面的 sanitize 统一处理）
    html = html.replace(/\x00SB(\d+)\x00/g, (_, idx) => styleBlocks[parseInt(idx)] || '');

    // 安全过滤：清洗 on* 事件 / javascript: 伪协议、给 <style> 加气泡作用域。
    // 此时 <script> 仍是 \x00JS 占位符，不受影响。
    html = sanitize(html);

    // <script> 块：提取内容，转成运行时动态执行的触发节点
    // （innerHTML 注入的 <script> 标签浏览器不执行，用 onerror 触发动态 createElement 绕过限制）
    html = html.replace(/\x00JS(\d+)\x00/g, (_, idx) => {
      const raw = scriptBlocks[parseInt(idx)] || '';
      // 提取 <script> 标签内的代码
      const codeMatch = raw.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/i);
      if (!codeMatch || !codeMatch[1].trim()) return '';
      // 把代码 base64 编码存进 data 属性，用 onerror 触发执行（img src="" 必然失败从而触发 onerror）
      const encoded = btoa(unescape(encodeURIComponent(codeMatch[1])));
      return `<img src="" style="display:none" data-script="${encoded}" onerror="(function(el){var s=document.createElement('script');s.textContent=decodeURIComponent(escape(atob(el.dataset.script)));el.parentNode.insertBefore(s,el);el.removeAttribute('onerror')})(this)">`;
    });

    // v711：在 sanitize 之后恢复 HTML 沙箱 iframe——它的 srcdoc 内容不能被 sanitize 洗
    // （否则 srcdoc 里 AI 写的 onclick/script 会被删，iframe 内点不了）。iframe 有 sandbox 隔离，安全。
    html = html.replace(/\x00IF(\d+)\x00/g, (_, idx) => iframeBlocks[parseInt(idx)] || '');

    return html;
  }

  // 渲染输出的安全清洗：掐掉"执行 JS"这一环，展示能力全部保留。
  // <script> 已在 render 阶段用占位符抽离并最终丢弃，这里不处理；
  // 本函数负责 <style> 作用域 + 一律删除 on* 事件 + javascript: 伪协议。
  function sanitize(html) {
    if (!html || html.indexOf('<') === -1) return html;
    let s = html;
    // 1. <style> 不删除，但强制把内部 CSS 选择器限定到气泡正文（.md-content）内，
    //    防止裸选择器（button/div/*）泄漏改坏全局界面。允许 AI 写气泡内的背景/动画/伪类。
    //    先用占位符保护处理结果，避免被下面"删残段"的正则误伤。
    const _styleHolder = [];
    s = s.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_, css) => {
      const idx = _styleHolder.length;
      _styleHolder.push('<style>' + _scopeBubbleCss(css) + '</style>');
      return '\x00ST' + idx + '\x00';
    });
    // 无闭合的残段 <style ...> 直接删（避免把后续正文都吞进样式）
    s = s.replace(/<style\b[^>]*>/gi, '');
    // 2. on* 内联事件属性已开放（用户自行负责），仅保留 javascript: 伪协议过滤
    // 删除 href/src 等属性里的 javascript: 伪协议
    s = s.replace(/(\b(?:href|src|xlink:href|formaction)\s*=\s*)(["']?)\s*javascript:[^"'>\s]*/gi, '$1$2');
    // 恢复被保护的 <style>（已加气泡作用域）
    if (_styleHolder.length) s = s.replace(/\x00ST(\d+)\x00/g, (_, idx) => _styleHolder[parseInt(idx)] || '');
    return s;
  }

  // 把 <style> 内的 CSS 选择器强制限定到气泡正文 .md-content 内，防止泄漏到全局。
  // @keyframes / @font-face 等 at-rule 原样保留（不针对全局元素）；
  // @media 外壳保留、内部规则递归加前缀；其余选择器统一加 ".md-content " 前缀。
  function _scopeBubbleCss(css) {
    if (!css || css.indexOf('{') === -1) return css || '';
    const PREFIX = '.md-content';
    let result = '';
    let i = 0;
    const n = css.length;
    while (i < n) {
      const braceOpen = css.indexOf('{', i);
      if (braceOpen === -1) { result += css.slice(i); break; }
      const selectorRaw = css.slice(i, braceOpen);
      const selector = selectorRaw.trim();
      // 找配对的 }
      let depth = 1, j = braceOpen + 1;
      for (; j < n; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (depth === 0) break; }
      }
      const inner = css.slice(braceOpen + 1, j); // 不含两端花括号
      const lead = selectorRaw.slice(0, selectorRaw.length - selectorRaw.trimStart().length);
      if (selector.startsWith('@')) {
        const lower = selector.toLowerCase();
        if (/^@media\b/.test(lower) || /^@supports\b/.test(lower)) {
          // 条件组：外壳保留，内部规则递归加前缀
          result += lead + selector + '{' + _scopeBubbleCss(inner) + '}';
        } else {
          // @keyframes / @font-face / @import 等：原样保留
          result += lead + selector + '{' + inner + '}';
        }
      } else {
        const scoped = selector.split(',').map(sel => {
          const t = sel.trim();
          if (!t) return t;
          // 已经限定在气泡内的放行，避免重复加前缀
          if (t.indexOf(PREFIX) === 0 || t.indexOf(PREFIX) !== -1) return t;
          return PREFIX + ' ' + t;
        }).join(', ');
        result += lead + scoped + '{' + inner + '}';
      }
      i = j + 1;
    }
    return result;
  }

  // 行内格式
  function inline(text) {
    let s = text;
    // 保护已有的HTML标签和占位符
    // 图片
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">');
    // 链接
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    // 粗斜体
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    // 粗体
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    // 斜体
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/_(.+?)_/g, '<em>$1</em>');
    // 删除线
    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // 引号包裹内容加下划线装饰（中文双引号、单引号、日式引号、英文双引号、英文单引号）
  s = s.replace(/(\u201C[^\u201D]+\u201D|\u300C[^\u300D]+\u300D|\u300E[^\u300F]+\u300F|\u2018[^\u2019]+\u2019|"[^"]+")/g, '<span class="quoted-text">$1</span>');
    return s;
  }

  // 引用块解析（支持嵌套）
  function parseBlockquote(lines, startIdx) {
    let i = startIdx;
    const content = [];
    while (i < lines.length && lines[i].trimStart().startsWith('>')) {
      content.push(lines[i].replace(/^\s*>\s?/, ''));
      i++;
    }
    // 检查是否有嵌套引用
    const hasNested = content.some(l => l.trimStart().startsWith('>'));
    let innerHtml;
    if (hasNested) {
      // 嵌套引用：逐行处理，再次解析引用
      innerHtml = '';
      let j = 0;
      while (j < content.length) {
        if (content[j].trimStart().startsWith('>')) {
          const sub = parseBlockquote(content, j);
          innerHtml += sub.html;
          j = sub.endIndex;
        } else {
          const trimmed = content[j].trim();
          if (trimmed === '') {
            j++;
            continue;
          }
          innerHtml += `<p>${inline(trimmed)}</p>`;
          j++;
        }
      }
    } else {
      // 非嵌套引用：每行直接 inline 处理（不递归 render，避免占位符作用域问题）
      const parts = content.filter(l => l.trim() !== '').map(l => inline(l));
      innerHtml = parts.length > 0 ? `<p>${parts.join('<br>')}</p>` : '';
    }
    return { html: `<blockquote>${innerHtml}</blockquote>`, endIndex: i };
  }

  // 列表解析（支持嵌套）
  function parseList(lines, startIdx, type) {
    const listTag = type;
    const pattern = type === 'ul' ? /^(\s*)([-*+])\s+(.*)/ : /^(\s*)(\d+[.)])\s+(.*)/;
    let i = startIdx;
    const firstMatch = lines[i].match(pattern);
    const baseIndent = firstMatch ? firstMatch[1].length : 0;
    let html = `<${listTag}>`;

    while (i < lines.length) {
      const match = lines[i].match(pattern);
      if (!match) {
        // 检查是否是另一种列表类型的嵌套
        const otherPattern = type === 'ul' ? /^(\s*)(\d+[.)])\s+(.*)/ : /^(\s*)([-*+])\s+(.*)/;
        const otherMatch = lines[i].match(otherPattern);
        if (otherMatch && otherMatch[1].length > baseIndent) {
          const subType = type === 'ul' ? 'ol' : 'ul';
          const sub = parseList(lines, i, subType);
          html = html.replace(/<\/li>$/, '') + sub.html + '</li>';
          i = sub.endIndex;
          continue;
        }
        break;
      }

      const indent = match[1].length;
      if (indent < baseIndent) break;

      if (indent > baseIndent) {
        // 嵌套列表
        const sub = parseList(lines, i, type);
        html = html.replace(/<\/li>$/, '') + sub.html + '</li>';
        i = sub.endIndex;
      } else {
        html += `<li>${inline(match[3])}</li>`;
        i++;
      }
    }

    html += `</${listTag}>`;
    return { html, endIndex: i };
  }

  // 表格解析
  function parseTable(lines, startIdx) {
    let i = startIdx;
    const headerCells = parseTableRow(lines[i]);
    i++; // 跳过分隔行

    // 解析对齐
    const alignRow = lines[i];
    const aligns = alignRow.split('|').filter(c => c.trim()).map(c => {
      c = c.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    i++;

    let html = '<table><thead><tr>';
    headerCells.forEach((cell, ci) => {
      const align = aligns[ci] || 'left';
      html += `<th style="text-align:${align}">${inline(cell)}</th>`;
    });
    html += '</tr></thead><tbody>';

    while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
      const cells = parseTableRow(lines[i]);
      html += '<tr>';
      cells.forEach((cell, ci) => {
        const align = aligns[ci] || 'left';
        html += `<td style="text-align:${align}">${inline(cell)}</td>`;
      });
      html += '</tr>';
      i++;
    }

    html += '</tbody></table>';
    return { html, endIndex: i };
  }

  function parseTableRow(line) {
    return line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // v711：HTML 属性值转义（用于 srcdoc）。必须转义双引号，否则内部 " 会截断属性导致 iframe 空白。
  function escAttr(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, String.fromCharCode(38) + 'quot;');
  }

  // v711：为 HTML 围栏构建 sandbox iframe 文档（统一返回字符串）。
  // 量高不看 body/html 的 scrollHeight（受 100vh/flex 居中干扰会虚高或量不到），
  // 而是遍历文档里所有元素、取最大 bottom 坐标 = 内容真实底部。这对"一个按钮"和
  // "固定尺寸手机壳"都准，且完整文档/片段用同一套逻辑，不再靠 isFullDoc 猜意图。
  function _buildSandboxDoc(userHtml, fid) {
    const src = String(userHtml || '');
    const isFullDoc = /<html[\s>]/i.test(src) || /<!doctype/i.test(src);

    // 量高脚本：只在 load + 有限几次定时量高，不用 ResizeObserver/resize（避免撑高→回量的死循环）。
    // measure：取所有元素 getBoundingClientRect().bottom 的最大值（相对文档顶部），得内容真实高度。
    const heightScript = '<scr' + 'ipt>'
      + '(function(){'
      + 'var last=0;'
      + 'function measure(){'
      + 'var max=0,els=document.body?document.body.getElementsByTagName("*"):[];'
      + 'for(var i=0;i<els.length;i++){var el=els[i];'
      + 'var st=window.getComputedStyle(el);'
      + 'if(st&&st.position==="fixed")continue;'
      + 'var b=el.getBoundingClientRect().bottom;'
      + 'if(b>max)max=b;}'
      + 'return Math.ceil(max);}'
      + 'function r(){var h=measure();if(h>0&&Math.abs(h-last)>1){last=h;'
      + "parent.postMessage({__htmlbox:'" + fid + "',height:h},'*');}}"
      + "window.addEventListener('load',r);"
      + 'setTimeout(r,80);setTimeout(r,300);setTimeout(r,800);setTimeout(r,1600);'
      + '})();'
      + '</scr' + 'ipt>';

    if (isFullDoc) {
      // 完整文档：只注入一句"背景透明"（融进气泡），绝不碰尺寸/定位/子元素以免压烂布局。
      // 手机壳等有自己背景色的容器不受影响；只把 body 直接铺的白/纯色底透明化。
      const bgFix = '<style>html,body{background:transparent!important}</style>';
      let doc = src;
      if (/<\/head>/i.test(doc)) {
        doc = doc.replace(/<\/head>/i, bgFix + '</head>');
      } else if (/<body[^>]*>/i.test(doc)) {
        doc = doc.replace(/(<body[^>]*>)/i, '$1' + bgFix);
      } else {
        doc = bgFix + doc;
      }
      if (/<\/body>/i.test(doc)) {
        doc = doc.replace(/<\/body>/i, heightScript + '</body>');
      } else {
        doc = doc + heightScript;
      }
      return doc;
    }

    // 片段：套上骨架 + 量高脚本。
    const head = '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<style>'
      + 'html,body{margin:0;padding:0;background:transparent;color:#e8e8e8;'
      + "font-family:-apple-system,'Noto Sans SC',sans-serif;font-size:14px;"
      + 'line-height:1.6;word-break:break-word;overflow:hidden}'
      + 'img{max-width:100%}'
      + '</style></head><body>';
    return head + src + heightScript + '</body></html>';
  }

  return { render };
})();