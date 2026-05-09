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
      codeBlocks.push(`<pre><code class="lang-${lang}">${esc(code)}</code></pre>`);
      return `\x00CB${idx}\x00`;
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

    return html;
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