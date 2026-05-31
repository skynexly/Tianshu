/**
 * SKYNEX 用户协议模块
 *
 * 流程：
 *  - 启动时调用 Agreement.ensureAgreed() → Promise
 *    - localStorage 里 skynex_agreement_<version> 已同意 → 立刻 resolve
 *    - 未同意 → 弹全屏协议页，用户点"同意并继续"后写入 localStorage 再 resolve
 *  - 设置页"用户协议"入口调用 Agreement.open() 重新查看（只读，关闭按钮）
 *  - 协议升版本：改 AGREEMENT_VERSION，旧 key 自动失效，下次启动会重新弹
 *
 * 视觉：跟随主题色 var(--bg) / var(--text) / var(--accent) / var(--border)
 */
const Agreement = (() => {
  const AGREEMENT_VERSION = 'v4.1';
  const STORAGE_KEY = 'skynex_agreement_' + AGREEMENT_VERSION;

  // 协议正文（与 docs/disclaimer-draft.md 同步）
  const AGREEMENT_MD = `# SKYNEX 用户协议与免责声明

> 在开始使用 SKYNEX 前，请花几分钟阅读本协议。
> 它会说明本服务的定位、你的数据如何保存，以及你在使用过程中需要注意的责任边界。
> 本服务由独立开发者维护。

---

## 一、关于本服务

「SKYNEX」（中文名「天枢城」，以下简称"本服务"）是一款辅助文字角色扮演与世界观创作的工具。

本服务本身不提供、不运营、不控制任何 AI 模型。你看到的 AI 输出，是由你配置的第三方 AI 服务根据你的输入、设定和提示词生成的。本服务不参与模型训练、模型审核或输出控制，因此无法保证 AI 输出的准确性、合法性、适当性或稳定性。

本服务包含少量内置世界观与角色作为示例；除此之外，内容通常由你自行编写、导入，或由你调用的第三方 AI 服务生成。

API 调用费用、内容审核规则、服务中断、模型输出限制等问题，通常由你与你选择的第三方 AI 服务商按照其服务条款处理。

---

## 二、关于数据

### 你的本地数据

你在本服务中产生的主要内容，包括但不限于对话记录、世界观、角色卡、记忆库、提示词、API Key、主题、相册等，均保存在你的浏览器本地存储中，包括 IndexedDB / LocalStorage 等。

开发者无法直接读取你的本地内容，也不会主动读取。所有 AI 请求均由你的浏览器直接发送给你配置的第三方 AI 服务商，不经过开发者中转。

如果你清除浏览器数据、更换设备、更换浏览器，或浏览器本身出现异常，本地内容可能会丢失。请定期到「个人主页 → 数据 → 导出存档」备份。

### 账号数据

为了完成账号注册、登录、设备绑定和邀请码管理，账号系统会保存以下必要信息：

- 邮箱；
- 经不可逆哈希处理后的密码；
- 设备标识与设备名称；
- 邀请码；
- 浏览器粗略类型，例如 iPhone / Android 等。

其中，密码仅保存哈希结果，开发者无法查看你的原始密码。

上述账号数据仅用于账号识别、登录、设备绑定和邀请码管理。除法律法规要求、基础服务提供商处理所必需，或经你另行同意外，开发者不会向第三方出售、出租或主动披露这些信息。

---

## 三、合规与禁止内容

你应对自己在本服务中输入、导入、保存、导出、传播的内容，以及你通过自己配置的第三方 AI 服务生成并使用、保存或传播的内容承担相应责任。

你承诺在使用本服务时遵守中华人民共和国法律法规，包括但不限于《网络安全法》《数据安全法》《个人信息保护法》《互联网信息服务管理办法》《网络信息内容生态治理规定》《生成式人工智能服务管理暂行办法》等。

请勿在本服务中产生、导入、保存或传播以下内容：

1. 反对宪法所确定的基本原则，危害国家安全，颠覆国家政权，破坏国家统一的内容；
2. 损害国家荣誉和利益的内容；
3. 煽动民族仇恨、破坏民族团结的内容；
4. 破坏国家宗教政策，宣扬邪教、非法宗教活动，或借迷信名义实施欺诈、扰乱社会秩序的内容；
5. 散布谣言，扰乱社会秩序，破坏社会稳定的内容；
6. 散布淫秽、色情、赌博、暴力、凶杀、恐怖，或教唆犯罪的内容；
7. 侮辱、诽谤他人，或侵害他人名誉权、隐私权、肖像权、知识产权等合法权益的内容；
8. 法律、行政法规禁止的其他内容。

即使相关内容属于虚构创作、角色扮演或世界观设定，也不得以现实传播、诱导、教学、煽动等方式违反法律法规或侵害他人权益。

如因你的使用行为或相关内容引发争议、投诉、处罚或其他法律责任，应由你本人承担；因此给开发者造成损失的，开发者保留依法追究责任的权利。

---

## 四、邀请码与账号

本服务通过邀请码注册制提供。注册后，你获得个人、不可转让的使用许可。

请你不要：

- 转让、出借、共享账号给任何他人；
- 二次销售、转赠邀请码或访问权；
- 把本服务包装成自己的产品对外销售或宣传；
- 以恶意、滥用、攻击、破坏等方式使用本服务。

如发现转售、共享、滥用、攻击、破坏服务秩序等行为，开发者有权限制、暂停或终止你对本服务的使用许可。

---

## 五、年龄限制

本服务仅供年满 18 周岁、具备完全民事行为能力的成年人使用。未成年人请勿注册或使用本服务。

如发现或有合理理由认为用户未满 18 周岁，开发者有权限制、暂停或终止其对本服务的使用许可。

监护人应监管未成年人的上网行为。因未成年人违规使用本服务产生的后果，由其本人及/或监护人依法承担。

---

## 六、虚构与现实

本服务中的角色、对话、剧情、设定等内容均属于虚构内容，不构成现实建议。

AI 输出可能存在不准确、不完整、过时、偏见、幻觉或其他问题。请勿将其作为医疗、法律、金融、心理、情感、人生选择等现实决策的依据。

如你依据本服务中的虚构内容或 AI 输出作出现实决策，由此产生的后果由你本人承担。

---

## 七、服务现状与责任限制

本服务按"现状"提供。开发者会尽力维护服务的可用性和安全性，但不承诺本服务无错误、无中断、无数据风险，也不承诺永久运营或达到特定服务等级。

在适用法律允许的最大范围内，开发者不对以下情况承担责任：

- 第三方 AI 服务中断、错误、输出不当或内容限制；
- API 调用费用、扣费、额度、账号封禁等与第三方 AI 服务相关的问题；
- 因用户设备、浏览器环境、第三方插件、用户自行操作或第三方服务导致的本地数据丢失、损坏或泄漏；
- 用户在本服务中输入、保存、导出、传播或使用相关内容引发的纠纷；
- 用户依据 AI 输出作出的现实决策；
- 账号系统所依赖的基础云服务、数据库服务等出现宕机、故障或停服；
- 因不可抗力、网络攻击、浏览器限制、系统更新或其他非开发者可控原因导致的服务异常。

除依法属于第三方、开源项目或另有授权说明的内容外，本服务的代码、界面设计、图标、UI、动效等相关权益归开发者或相应权利人所有。未经授权，请勿反向工程、二次分发、去除版权声明，或将本服务伪装为自有产品发布。

你自己编写的世界观、角色卡、提示词、文本内容等权益归你本人所有。AI 生成内容的权利归属，请参考你所使用的第三方 AI 服务商相关条款。

---

## 八、协议变更

开发者可能会根据功能变化、法律法规要求或运营需要，对本协议进行修改。

- 一般修改：通过版本更新或页面展示生效，继续使用本服务视为你接受修改后的协议；
- 重大修改：如数据收集范围、账号规则、商业化模式等发生明显变化，会在登录或使用相关功能时提示，并需要你重新确认。

如你不同意本协议或后续修改内容，请停止使用本服务、退出登录，并根据需要自行导出或清除本地数据。`;

  function hasAgreed() {
    try { return !!localStorage.getItem(STORAGE_KEY); } catch(_) { return false; }
  }

  function _markAgreed() {
    try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch(_) {}
  }

  // 渲染协议正文（用项目自带的 Markdown）
  function _renderBody() {
    try {
      if (typeof Markdown !== 'undefined' && Markdown.render) {
        return Markdown.render(AGREEMENT_MD);
      }
    } catch(_) {}
    // 兜底：原文 pre 显示
    return '<pre style="white-space:pre-wrap;font-family:inherit">' +
      AGREEMENT_MD.replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])) +
      '</pre>';
  }

  function _build(opts) {
    const o = opts || {};
    const mode = o.mode || 'agree'; // 'agree' | 'readonly'
    const overlay = document.createElement('div');
    overlay.id = 'agreement-overlay';
    overlay.innerHTML = `
      <div class="agreement-card">
        <div class="agreement-header">
          <div class="agreement-brand">SKYNEX</div>
          <div class="agreement-version">协议版本 ${AGREEMENT_VERSION}</div>
        </div>
        <div class="agreement-scroll md-content">${_renderBody()}</div>
        <div class="agreement-footer">
          ${mode === 'agree'
            ? `<button type="button" class="agreement-btn agreement-btn-primary" id="agreement-agree-btn">同意并继续</button>
               <div class="agreement-hint">点击"同意并继续"即视为你已阅读、理解并同意本协议全部条款。<br>如不同意，请关闭本服务。</div>`
            : `<button type="button" class="agreement-btn agreement-btn-ghost" id="agreement-close-btn">关闭</button>`
          }
        </div>
      </div>
    `;
    return overlay;
  }

  // 启动检查：未同意 → 弹窗等同意；已同意 → 立刻 resolve
  function ensureAgreed() {
    if (hasAgreed()) return Promise.resolve();
    return new Promise((resolve) => {
      const overlay = _build({ mode: 'agree' });
      document.body.appendChild(overlay);
      // 禁止 body 滚动
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      overlay.querySelector('#agreement-agree-btn').addEventListener('click', () => {
        _markAgreed();
        overlay.remove();
        document.body.style.overflow = prevOverflow;
        resolve();
      });
    });
  }

  // 设置页用：只读模式
  function open() {
    // 已经有一个就关掉
    const old = document.getElementById('agreement-overlay');
    if (old) old.remove();
    const overlay = _build({ mode: 'readonly' });
    document.body.appendChild(overlay);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function close() {
      overlay.remove();
      document.body.style.overflow = prevOverflow;
    }
    overlay.querySelector('#agreement-close-btn').addEventListener('click', close);
    // 点遮罩也关
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  // ===== 使用说明弹窗 =====
  let _guideMarkdown = null; // 缓存原始 Markdown

  async function _loadGuideMarkdown() {
    if (_guideMarkdown) return _guideMarkdown;
    try {
      const resp = await fetch('guide.md?_=' + Date.now());
      if (!resp.ok) throw new Error(resp.status);
      _guideMarkdown = await resp.text();
    } catch(_) {
      _guideMarkdown = '> 无法加载使用说明，请检查 guide.md 文件是否存在。';
    }
    return _guideMarkdown;
  }

  function _renderGuideHtml(md) {
    try {
      if (typeof Markdown !== 'undefined' && Markdown.render) return Markdown.render(md);
    } catch(_) {}
    return '<pre style="white-space:pre-wrap;font-family:inherit">' +
      md.replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])) + '</pre>';
  }

  function _highlightKeyword(html, keyword) {
    if (!keyword) return html;
    // 转义正则特殊字符
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(' + escaped + ')', 'gi');
    // 只替换文本节点（不动标签属性）——简化版：跳过 <> 内部
    return html.replace(/>([^<]+)</g, (full, text) => {
      return '>' + text.replace(re, '<mark style="background:var(--accent);color:#fff;border-radius:2px;padding:0 2px">$1</mark>') + '<';
    });
  }

  function _filterSections(md, keyword) {
    if (!keyword) return md;
    const kw = keyword.toLowerCase();
    const lines = md.split('\n');
    const sections = [];
    let cur = { heading: '', lines: [] };
    for (const line of lines) {
      if (/^#{1,5}\s/.test(line)) {
        if (cur.heading || cur.lines.length) sections.push(cur);
        cur = { heading: line, lines: [] };
      } else {
        cur.lines.push(line);
      }
    }
    if (cur.heading || cur.lines.length) sections.push(cur);
    // 优先标题命中，否则内容命中最多3个
    const titleHits = [];
    const bodyHits = [];
    for (const s of sections) {
      const full = (s.heading + '\n' + s.lines.join('\n')).toLowerCase();
      if (s.heading.toLowerCase().includes(kw)) {
        titleHits.push(s);
      } else if (full.includes(kw)) {
        bodyHits.push(s);
      }
    }
    const matched = titleHits.length > 0 ? titleHits : bodyHits.slice(0, 3);
    if (matched.length === 0) return '> 没有找到包含"' + keyword + '"的内容。';
    return matched.map(s => s.heading + '\n' + s.lines.join('\n')).join('\n\n');
  }

  async function openGuide() {
    const old = document.getElementById('guide-overlay');
    if (old) old.remove();
    const md = await _loadGuideMarkdown();
    const overlay = document.createElement('div');
    overlay.id = 'guide-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:12px';
    overlay.innerHTML = `
      <div style="background:var(--bg);border-radius:16px;width:100%;max-width:520px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.25)">
        <div style="padding:14px 16px 10px;display:flex;align-items:center;gap:10px">
          <div style="font-size:16px;font-weight:600;color:var(--text);flex-shrink:0">使用说明</div>
          <input id="guide-search-input" type="text" placeholder="搜索关键词…"
            style="flex:1;min-width:0;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--card-bg,var(--bg));color:var(--text);font-size:13px;outline:none"
          />
          <button id="guide-close-btn" type="button" style="background:none;border:none;cursor:pointer;padding:4px;color:var(--text-secondary)">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <div id="guide-body" class="md-content" style="flex:1;overflow-y:auto;padding:16px;font-size:13px;line-height:1.7;color:var(--text)">
          ${_renderGuideHtml(md)}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function close() {
      overlay.remove();
      document.body.style.overflow = prevOverflow;
    }
    overlay.querySelector('#guide-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // 搜索功能
    let debounce = null;
    overlay.querySelector('#guide-search-input').addEventListener('input', (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const kw = e.target.value.trim();
        const filtered = _filterSections(md, kw);
        const html = _renderGuideHtml(filtered);
        overlay.querySelector('#guide-body').innerHTML = _highlightKeyword(html, kw);
      }, 300);
    });
  }

  return {
    VERSION: AGREEMENT_VERSION,
    hasAgreed,
    ensureAgreed,
    open,
    openGuide,
  };
})();
