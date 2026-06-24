/* ============================================================
 * 本地电子书导入解析模块（零依赖）
 * 支持：txt（章节正则拆分）、epub（原生 DecompressionStream 解 zip + 解析 spine）
 * 暴露全局：window.EbookImport.parseFile(file) -> Promise<{title, author, chapters:[{title, content}]}>
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 通用：章节标题正则 ----------
  // 匹配「第X章/回/节/卷」「Chapter X」「序章/楔子/尾声/番外」等常见标题行
  // 关键：章节号(第X章)后必须是 行尾/空格/标点/书名号，避免把"第二章正文。"这类正文行误判为标题
  const CHAPTER_RE = /^\s*(?:第\s*[0-9零一二三四五六七八九十百千两]+\s*[章回节卷篇部](?:\s*$|[\s:：、，,.。·\-—《（(【「])|序章\s*$|序言\s*$|楔子\s*$|引子\s*$|尾声\s*$|后记\s*$|番外|终章\s*$|Chapter\s+\d+|CHAPTER\s+\d+)/i;

  // ---------- txt 解析 ----------
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result || '');
      reader.onerror = () => reject(new Error('读取文件失败'));
      // 优先 UTF-8，常见网文 txt 也多为 UTF-8；GBK 不在此处兜底（绝大多数现代 txt 是 UTF-8）
      reader.readAsText(file, 'utf-8');
    });
  }

  function parseTxt(text, fallbackTitle) {
    const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const chapters = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.body.trim()) {
        chapters.push({ title: cur.title, content: cur.body.trim() });
      }
      cur = null;
    };
    for (const raw of lines) {
      const line = raw.trim();
      // 章节标题行：标题不能太长（排除正文里出现"第一章"字样的普通句子）
      if (line && line.length <= 30 && CHAPTER_RE.test(line)) {
        flush();
        cur = { title: line, body: '' };
      } else {
        if (!cur) cur = { title: '正文', body: '' };
        cur.body += raw + '\n';
      }
    }
    flush();
    // 没识别出任何章节标题：整本作为单章（或按字数粗分）
    if (!chapters.length) {
      const body = String(text || '').trim();
      if (body) chapters.push({ title: fallbackTitle || '正文', content: body });
    }
    return chapters;
  }

  // ---------- epub 解析：原生解 zip ----------
  // 读取 zip 的 central directory，按需 inflate 每个条目。
  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  async function inflateRaw(bytes) {
    // 优先用原生 DecompressionStream('deflate-raw')
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) {
        // 某些内核 deflate-raw 不支持，尝试 deflate（带 zlib 头），失败再抛
        throw e;
      }
    }
    throw new Error('当前环境不支持 DecompressionStream，无法解析 epub');
  }

  // 解析整个 zip，返回 { name -> Uint8Array } 的映射（按需解压文本条目）
  async function unzip(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    const u8 = new Uint8Array(arrayBuffer);
    const len = dv.byteLength;
    // 找 End of Central Directory (EOCD) 签名 0x06054b50，从尾部往前扫
    let eocd = -1;
    for (let i = len - 22; i >= 0 && i >= len - 22 - 65536; i--) {
      if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 epub（zip）文件');
    const cdCount = u16(dv, eocd + 10);
    let cdOffset = u32(dv, eocd + 16);

    const entries = {};
    let p = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (u32(dv, p) !== 0x02014b50) break; // central dir header 签名
      const method = u16(dv, p + 10);
      const compSize = u32(dv, p + 20);
      const nameLen = u16(dv, p + 28);
      const extraLen = u16(dv, p + 30);
      const commentLen = u16(dv, p + 32);
      const localOffset = u32(dv, p + 42);
      const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method, compSize, localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }

    // 读取某个条目的原始字节（解压）
    async function readEntry(name) {
      const ent = entries[name];
      if (!ent) return null;
      // 读 local file header 拿到真实数据偏移
      const lo = ent.localOffset;
      if (u32(dv, lo) !== 0x04034b50) return null;
      const nameLen = u16(dv, lo + 26);
      const extraLen = u16(dv, lo + 28);
      const dataStart = lo + 30 + nameLen + extraLen;
      const raw = u8.subarray(dataStart, dataStart + ent.compSize);
      if (ent.method === 0) return raw.slice(); // stored，未压缩
      if (ent.method === 8) return await inflateRaw(raw); // deflate
      throw new Error('不支持的压缩方式: ' + ent.method);
    }

    return { entries, readEntry };
  }

  async function readZipText(zip, name) {
    const bytes = await zip.readEntry(name);
    if (!bytes) return '';
    return new TextDecoder('utf-8').decode(bytes);
  }

  function parseXml(str) {
    return new DOMParser().parseFromString(str, 'application/xml');
  }

  // 把 xhtml 内容转成纯文本（保留段落换行）
  function xhtmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // 移除脚本/样式
    doc.querySelectorAll('script, style').forEach(el => el.remove());
    // 块级元素后补换行
    const blocks = doc.querySelectorAll('p, div, br, h1, h2, h3, h4, h5, h6, li');
    blocks.forEach(el => {
      if (el.tagName === 'BR') { el.replaceWith('\n'); }
      else { el.appendChild(document.createTextNode('\n')); }
    });
    const text = (doc.body ? doc.body.textContent : doc.textContent) || '';
    return text.replace(/\n{3,}/g, '\n\n').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  }

  async function parseEpub(arrayBuffer, fallbackTitle) {
    const zip = await unzip(arrayBuffer);
    // 1. container.xml 找 opf 路径
    const containerXml = await readZipText(zip, 'META-INF/container.xml');
    if (!containerXml) throw new Error('epub 缺少 container.xml');
    const cdoc = parseXml(containerXml);
    const rootfile = cdoc.querySelector('rootfile');
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath) throw new Error('epub 缺少 opf 路径');
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

    // 2. 解析 opf：metadata（标题/作者）+ manifest（id->href）+ spine（阅读顺序）
    const opfXml = await readZipText(zip, opfPath);
    const opf = parseXml(opfXml);
    const title = (opf.querySelector('metadata title') || {}).textContent
      || (opf.getElementsByTagName('dc:title')[0] || {}).textContent
      || fallbackTitle || '导入书籍';
    const author = (opf.getElementsByTagName('dc:creator')[0] || {}).textContent || '佚名';

    const manifest = {};
    opf.querySelectorAll('manifest item').forEach(it => {
      const id = it.getAttribute('id');
      const href = it.getAttribute('href');
      if (id && href) manifest[id] = href;
    });
    const spine = [];
    opf.querySelectorAll('spine itemref').forEach(ref => {
      const idref = ref.getAttribute('idref');
      if (idref && manifest[idref]) spine.push(manifest[idref]);
    });

    // 3. 依 spine 顺序读取每个 xhtml，转纯文本作为一章
    const chapters = [];
    for (const href of spine) {
      const path = opfDir + decodeURIComponent(href).split('#')[0];
      let html = '';
      try { html = await readZipText(zip, path); } catch (_) {}
      if (!html) continue;
      const text = xhtmlToText(html);
      if (!text.trim()) continue;
      // 章节标题：取正文首行（若像标题）或顺序编号
      const firstLine = text.split('\n')[0].trim();
      const chapTitle = (firstLine && firstLine.length <= 30) ? firstLine : `第 ${chapters.length + 1} 节`;
      // 若首行被当作标题，正文去掉首行
      const body = (chapTitle === firstLine) ? text.split('\n').slice(1).join('\n').trim() : text;
      chapters.push({ title: chapTitle, content: body || text });
    }
    if (!chapters.length) throw new Error('epub 未解析出任何正文章节');
    return { title: String(title).trim(), author: String(author).trim() || '佚名', chapters };
  }

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsArrayBuffer(file);
    });
  }

  // ---------- 对外入口 ----------
  async function parseFile(file) {
    const name = file.name || '';
    const baseTitle = name.replace(/\.[^.]+$/, '').trim() || '导入书籍';
    const lower = name.toLowerCase();
    if (lower.endsWith('.epub')) {
      const buf = await readFileAsArrayBuffer(file);
      return await parseEpub(buf, baseTitle);
    }
    // 默认按 txt 处理
    const text = await readFileAsText(file);
    const chapters = parseTxt(text, baseTitle);
    if (!chapters.length) throw new Error('文件内容为空');
    return { title: baseTitle, author: '佚名', chapters };
  }

  window.EbookImport = { parseFile, parseTxt, parseEpub };
})();
