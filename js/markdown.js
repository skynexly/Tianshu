/**
 * 完整Markdown渲染器（无依赖）
 * 支持：h1-h6、粗体、斜体、删除线、行内代码、代码块、
 * 引用（含嵌套）、有序/无序列表（含嵌套）、表格、分割线、链接、图片、HTML混写
 */
const Markdown = (() => {

  function render(text) {
    if (!text) return '';
    // 先提取代码块保护起来
    const codeBlocks = [];
    let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      // html/svg/xml 围栏：作为真实 HTML 渲染（气泡富文本排版），不转义、不包 <pre>
      if (/^(html|svg|xml)$/i.test(lang)) {
        codeBlocks.push(code);
      } else {
        codeBlocks.push(`<pre><code class="lang-${lang}">${esc(code)}</code></pre>`);
      }
      return `\x00CB${idx}\x00`;
    });

    // 提取 <style>...</style> 整块保护，避免多行 CSS 被逐行处理拆成 <p>/<br>
    // （内容原样存起来，作用域限定由出口的 sanitize 统一处理）
    const styleBlocks = [];
    processed = processed.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (m) => {
      const idx = styleBlocks.length;
      styleBlocks.push(m);
      return `\x00SB${idx}\x00`;
    });

    // 提取 <script>...</script> 整块保护（避免多行脚本被逐行处理拆坏），最终一律丢弃。
    const scriptBlocks = [];
    processed = processed.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (m) => {
      const idx = scriptBlocks.length;
      scriptBlocks.push(m);
      return `\x00JS${idx}\x00`;
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

      // 占位符独占一行（如 <style> 块、<script> 块、html 围栏块）：原样通过，不要包 <p>
      if (/^\s*\x00(?:SB|CB|JS)\d+\x00\s*$/.test(line)) {
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

    // <script> 块一律丢弃：innerHTML 注入的 <script> 本就不会执行，且放行有安全风险。
    html = html.replace(/\x00JS(\d+)\x00/g, '');

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
    // 2. on* 内联事件属性 / javascript: 伪协议一律删除（innerHTML 注入的事件会执行，必须清洗）
    // 删除所有 on* 内联事件属性（覆盖双引号、单引号、无引号三种写法）
    s = s.replace(/\son[a-z0-9_-]+\s*=\s*"[^"]*"/gi, '');
    s = s.replace(/\son[a-z0-9_-]+\s*=\s*'[^']*'/gi, '');
    s = s.replace(/\son[a-z0-9_-]+\s*=\s*[^\s>]+/gi, '');
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

  return { render };
})();