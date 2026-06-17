/**
 * StatusBarTheme 模块 — 状态栏美化主题管理
 * 存储：localStorage key = "statusBarCustomThemes"
 * 数据结构：{ id: { id, name, baseTemplate, css, createdAt, updatedAt, draft } }
 */
var StatusBarTheme = (() => {
  const STORAGE_KEY = 'statusBarCustomThemes';
  let _editingId = null; // 当前编辑器正在编辑的主题 ID
  let _savedGlobalState = null; // 打开编辑器时保存的全局状态快照

  // ── 预设模板（只读）────────────────────────────────────────
  const PRESETS = {
    terminal: { name: '终端风格', value: 'terminal', description: '黑客风格，等宽字体，方块装饰' },
    neumorph: { name: '拟态风格', value: 'neumorph', description: '柔和阴影，圆角卡片，现代质感' },
    'single-default': { name: '无世界观', value: 'single-default', description: '单人卡专用，简洁优雅' }
  };

  // ── 工具函数 ────────────────────────────────────────────────
  function _genId() {
    return 'sb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  }

  function _esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '"').replace(/'/g, '&#039;');
  }

  // ── 存取 ────────────────────────────────────────────────────
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn('[StatusBarTheme] load 失败', e);
      return {};
    }
  }

  function save(map) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (e) {
      console.error('[StatusBarTheme] save 失败', e);
    }
  }

  // ── CRUD ────────────────────────────────────────────────────
  function create(baseTemplate, name) {
    const map = load();
    const id = _genId();
    const now = Date.now();
    map[id] = {
      id,
      name: name || '未命名主题',
      baseTemplate: baseTemplate || 'terminal',
      css: '',
      createdAt: now,
      updatedAt: now,
      draft: { messages: [], currentCss: '' }
    };
    save(map);
    return id;
  }

  function get(id) {
    const map = load();
    return map[id] || null;
  }

  function update(id, updates) {
    const map = load();
    if (!map[id]) return false;
    Object.assign(map[id], updates, { updatedAt: Date.now() });
    save(map);
    return true;
  }

  function remove(id) {
    const map = load();
    if (!map[id]) return false;
    delete map[id];
    save(map);
    return true;
  }

  function getAll() {
    return Object.values(load());
  }

  // ── 草稿管理 ────────────────────────────────────────────────
  function saveDraft(id, draft) {
    const map = load();
    if (!map[id]) return false;
    map[id].draft = draft;
    map[id].updatedAt = Date.now();
    save(map);
    return true;
  }

  function clearDraft(id) {
    return saveDraft(id, { messages: [], currentCss: '' });
  }

  // ── 装饰重置 CSS：自动清除模板自带的装饰线/圆点/障眼法 ──────────
  // 这样 AI 不需要记得写 content:none，系统层面已经帮它清了
  function _getDecorationReset(baseTemplate) {
    // 通用重置（所有模板都有的穿搭竖线）
    let reset = `.sb-field-val { border-left: none !important; }\n`;
    
    if (baseTemplate === 'terminal') {
      reset += `
.sb-custom-attr-card::before { content: none !important; border: none !important; display: none !important; }
.sb-custom-attr-name::before { content: none !important; }
.sb-character-attr-name::after { content: none !important; }
.sb-character-attr-row::before { content: none !important; border: none !important; display: none !important; }
#sb-task-system .hs-task-item::before { content: none !important; }
#sb-task-system .hs-task-item.done::before { content: none !important; }
#sb-task-system .hs-task-item.skipped::before { content: none !important; }
#sb-task-system .hs-task-type::before { content: none !important; }
#sb-task-system .hs-task-type::after { content: none !important; }
#sb-task-system .hs-skip-btn::before { content: none !important; }
#sb-task-system .hs-skip-btn::after { content: none !important; }
`;
    } else if (baseTemplate === 'neumorph' || baseTemplate === 'single-default') {
      reset += `
.sb-player-card .sb-field-row::after { content: none !important; display: none !important; }
.sb-player-card::before { content: none !important; display: none !important; }
`;
    }
    return reset;
  }

  // ── 应用到真实页面（世界观加载时调用）────────────────────────────────
  function applyPreview(baseTemplate, customCss) {
    // 移除旧的预览样式
    const oldCustom = document.getElementById('sb-theme-preview-custom');
    if (oldCustom) oldCustom.remove();

    // 设置 body 属性（用于触发 CSS 选择器）
    if (baseTemplate === 'terminal' || baseTemplate === 'neumorph') {
      document.body.setAttribute('data-sb-skin', baseTemplate);
      document.body.removeAttribute('data-skin');
    } else if (baseTemplate === 'single-default') {
      document.body.setAttribute('data-skin', 'single-default');
      document.body.removeAttribute('data-sb-skin');
    } else {
      document.body.removeAttribute('data-sb-skin');
      document.body.removeAttribute('data-skin');
    }

    // 注入自定义 CSS
    // 装饰重置（系统自动清除模板装饰） + 用户/AI 的自定义 CSS
    const resetCss = _getDecorationReset(baseTemplate);
    const hasCustom = customCss && customCss.trim();
    
    if (resetCss || hasCustom) {
      let realCss = hasCustom ? customCss : '';
      // 用户/AI 写的 CSS 可能用了 Shadow DOM 预览里的选择器格式，需要反向转换
      realCss = realCss.replace(/\.sb-root\[data-sb-skin=/g, 'body[data-sb-skin=');
      realCss = realCss.replace(/\.sb-root\[data-skin=/g, 'body[data-skin=');
      realCss = realCss.replace(/\.sb-custom-attrs-section/g, '#sb-custom-attrs');
      realCss = realCss.replace(/\.sb-character-attrs-section/g, '#sb-character-attrs');
      realCss = realCss.replace(/\.sb-task-system-section/g, '#sb-task-system');
      // 折叠态锁定基础款：剔除任何命中折叠态的规则
      realCss = _stripCollapsedRules(realCss);
      // 作用域兜底：把裸标签/通用选择器强制限定到状态栏内，防止泄漏改坏全局界面
      realCss = _scopeSelectors(realCss);
      
      const style = document.createElement('style');
      style.id = 'sb-theme-preview-custom';
      // 装饰重置在前（优先清除），用户 CSS 在后（覆盖/新增）
      style.textContent = resetCss + '\n' + realCss;
      document.head.appendChild(style);
    }
  }

  // 折叠态选择器黑名单——命中其一的规则整条剔除
  const _COLLAPSED_SELECTORS = [
    'topbar-row-status', 'sb-datemeta', 'sb-datemeta-left', 'sb-datemeta-right',
    'sb-clock-main', 'sb-date-sub', 'sb-weather-line', 'sb-region-line',
    'sb-place-text', 'sb-chevron'
  ];

  // 逐条解析 CSS，剔除选择器命中折叠态黑名单的规则块
  function _stripCollapsedRules(css) {
    if (!css) return css;
    let result = '';
    let i = 0;
    const n = css.length;
    while (i < n) {
      // 找下一个规则块的 { 和 }
      const braceOpen = css.indexOf('{', i);
      if (braceOpen === -1) { result += css.slice(i); break; }
      // 处理 @media / @keyframes 等带嵌套的 at-rule：原样保留（折叠态不会写在里面）
      const selector = css.slice(i, braceOpen);
      // 找配对的 }（简单处理：假设规则内无嵌套花括号，普通规则成立）
      let depth = 1;
      let j = braceOpen + 1;
      for (; j < n; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (depth === 0) break; }
      }
      const block = css.slice(i, j + 1);
      // 判断选择器是否命中折叠态黑名单
      const hit = _COLLAPSED_SELECTORS.some(cls => 
        new RegExp('\\.' + cls + '(?![\\w-])').test(selector)
      );
      if (!hit) result += block;
      i = j + 1;
    }
    return result;
  }

  // 作用域兜底：强制每条规则的选择器限定在状态栏内，防止裸标签/通用选择器泄漏到全局。
  // 已带状态栏锚点（.sb- / .hs- / body[data-sb-skin] / body[data-skin] / #sb- / :root）的放行；
  // 其余（如 button、div、*）自动加 .sb-root 前缀限定。
  function _scopeSelectors(css) {
    if (!css) return css;
    // 选择器已含状态栏作用域锚点 → 视为安全，放行
    const SAFE = /\.sb-|\.hs-|\bbody\s*\[\s*data-sb-skin|\bbody\s*\[\s*data-skin|#sb-|:root|\.topbar-row-status/;
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
      const body = css.slice(braceOpen, j + 1);
      // @media / @keyframes / @font-face 等 at-rule：原样保留（内部规则一般不针对全局元素）
      if (selector.startsWith('@')) {
        result += selectorRaw + body;
      } else {
        // 逗号分隔的选择器组，逐个处理
        const scoped = selector.split(',').map(sel => {
          const s = sel.trim();
          if (!s) return s;
          if (SAFE.test(s)) return s;        // 已有状态栏锚点，放行
          return '.sb-root ' + s;            // 裸选择器，强制限定到状态栏内
        }).join(', ');
        // 保留选择器前的空白（缩进/换行），把选择器主体替换为加了作用域的版本
        const lead = selectorRaw.slice(0, selectorRaw.length - selectorRaw.trimStart().length);
        result += lead + scoped + ' ' + body;
      }
      i = j + 1;
    }
    return result;
  }

  // 清除自定义主题样式（切换世界观/关闭编辑器时调用）
  function clearPreview() {
    const oldCustom = document.getElementById('sb-theme-preview-custom');
    if (oldCustom) oldCustom.remove();
  }

  // ── 导出导入 ────────────────────────────────────────────────
  function exportTheme(id) {
    const theme = get(id);
    if (!theme) return null;
    // 导出时移除 draft，只保留最终版本
    const { draft, ...exportData } = theme;
    return exportData;
  }

  function exportSelected(ids) {
    const map = load();
    const result = {};
    ids.forEach(id => {
      if (map[id]) {
        const { draft, ...exportData } = map[id];
        result[id] = exportData;
      }
    });
    return result;
  }

  function importThemes(data, mode = 'skip') {
    // mode: 'skip' (跳过同名) | 'overwrite' (覆盖) | 'rename' (重命名)
    const map = load();
    const imported = [];
    const skipped = [];
    const existingNames = Object.values(map).map(t => t.name);

    Object.entries(data).forEach(([oldId, theme]) => {
      let finalName = theme.name;
      const nameExists = existingNames.includes(finalName);

      if (nameExists) {
        if (mode === 'skip') {
          skipped.push(finalName);
          return;
        } else if (mode === 'rename') {
          let suffix = 2;
          while (existingNames.includes(`${finalName} (${suffix})`)) suffix++;
          finalName = `${finalName} (${suffix})`;
        }
        // overwrite 模式：找到同名的旧 ID 并覆盖
        if (mode === 'overwrite') {
          const existingId = Object.keys(map).find(k => map[k].name === finalName);
          if (existingId) {
            map[existingId] = { ...theme, id: existingId, name: finalName, updatedAt: Date.now(), draft: { messages: [], currentCss: '' } };
            imported.push(finalName);
            return;
          }
        }
      }

      // 新主题或重命名：生成新 ID
      const newId = _genId();
      map[newId] = { ...theme, id: newId, name: finalName, updatedAt: Date.now(), draft: { messages: [], currentCss: '' } };
      imported.push(finalName);
      existingNames.push(finalName);
    });

    save(map);
    return { imported, skipped };
  }

  // ── UI 层：列表页 ────────────────────────────────────────────
  function openListPage() {
    if (window.UI && UI.switchSettingsTab) {
      UI.switchSettingsTab('st-statusbar');
    }
    renderList();
  }

  function closeListPage() {
    if (window.UI && UI.showSettingsOverview) {
      UI.showSettingsOverview();
    }
  }

  function renderList() {
    const container = document.getElementById('sb-theme-list-container');
    if (!container) return;

    const themes = getAll().sort((a, b) => b.updatedAt - a.updatedAt);
    
    console.log('[StatusBarTheme.renderList] 渲染主题列表，数量:', themes.length);
    
    let html = '<div style="display:flex;flex-direction:column;gap:12px">';
    
    // 预设主题（只读）
    html += '<div style="font-size:12px;color:var(--text-secondary);font-weight:600;letter-spacing:.05em;margin-bottom:4px">预设模板</div>';
    Object.values(PRESETS).forEach(p => {
      html += `<div style="display:flex;align-items:center;gap:10px;padding:12px;background:var(--bg-tertiary);border-radius:8px;border:1px solid var(--border)">
        <div style="flex:1">
          <div style="font-size:14px;color:var(--text);font-weight:600">${_esc(p.name)}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">${_esc(p.description)}</div>
        </div>
        <span style="padding:4px 8px;font-size:11px;color:var(--text-secondary);background:var(--bg-secondary);border-radius:4px">内置</span>
      </div>`;
    });

    // 自定义主题
    if (themes.length > 0) {
      html += '<div style="font-size:12px;color:var(--text-secondary);font-weight:600;letter-spacing:.05em;margin:16px 0 4px">我的主题</div>';
      themes.forEach(t => {
        console.log('[StatusBarTheme.renderList] 渲染主题:', t.id, t.name);
        const basePreset = PRESETS[t.baseTemplate] || { name: '未知' };
        // 修复：用 data-id 而不是直接拼接到 onclick 里
        html += `<div style="display:flex;align-items:center;gap:10px;padding:12px;background:var(--bg-tertiary);border-radius:8px;border:1px solid var(--border)">
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(t.name)}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">基于 ${_esc(basePreset.name)}</div>
          </div>
          <button data-theme-id="${t.id}" onclick="console.log('点击编辑按钮，ID:', this.getAttribute('data-theme-id')); StatusBarTheme.openEditor(this.getAttribute('data-theme-id'))" style="padding:6px 10px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap">编辑</button>
          <button data-theme-id="${t.id}" onclick="StatusBarTheme.deleteThemeWithConfirm(this.getAttribute('data-theme-id'))" style="padding:6px 10px;background:none;border:1px solid var(--border);color:var(--text-secondary);border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap">删除</button>
        </div>`;
      });
    } else {
      html += '<div style="font-size:12px;color:var(--text-secondary);margin:16px 0 4px">暂无自定义主题</div>';
    }

    html += '</div>';
    container.innerHTML = html;
    
    console.log('[StatusBarTheme.renderList] 列表渲染完成');
  }

  async function deleteThemeWithConfirm(id) {
    const theme = get(id);
    if (!theme) return;
    const ok = await UI.showConfirm('删除主题', `确定删除「${theme.name}」？`);
    if (!ok) return;
    remove(id);
    renderList();
    UI.showToast('已删除', 2000);
  }

  // ── UI 层：模板选择器 ────────────────────────────────────────
  function openTemplatePicker() {
    const modal = document.getElementById('sb-template-picker-modal');
    if (modal) modal.classList.remove('hidden');
  }

  function closeTemplatePicker() {
    const modal = document.getElementById('sb-template-picker-modal');
    if (modal) modal.classList.add('hidden');
  }

  async function selectTemplate(template) {
    console.log('[StatusBarTheme.selectTemplate] 开始，模板:', template);

    // 先关闭模板选择器
    closeTemplatePicker();

    // 用项目统一的输入弹窗（替代浏览器原生 prompt）
    const defaultName = '我的' + (PRESETS[template]?.name || '主题');
    const name = await UI.showSimpleInput('给新主题起个名字', defaultName, {
      placeholder: '输入主题名称',
      allowEmpty: false
    });

    if (!name || !name.trim()) {
      console.log('[StatusBarTheme.selectTemplate] 用户取消输入');
      return;
    }
    
    console.log('[StatusBarTheme.selectTemplate] 创建主题，模板:', template, '名称:', name.trim());
    
    const id = create(template, name.trim());
    
    console.log('[StatusBarTheme.selectTemplate] 主题已创建，ID:', id);
    
    // 延迟一下再关闭列表页和打开编辑器
    setTimeout(() => {
      console.log('[StatusBarTheme.selectTemplate] 关闭列表页...');
      closeListPage();
      
      setTimeout(() => {
        console.log('[StatusBarTheme.selectTemplate] 打开编辑器，ID:', id);
        openEditor(id);
      }, 100);
    }, 100);
  }

  // ── UI 层：编辑器 ────────────────────────────────────────
  function openEditor(id) {
    console.log('[StatusBarTheme.openEditor] 开始，ID:', id);
    
    const theme = get(id);
    console.log('[StatusBarTheme.openEditor] 获取主题:', theme);
    
    if (!theme) {
      console.error('[StatusBarTheme.openEditor] 主题不存在，ID:', id);
      UI.showToast('错误：主题不存在', 3000);
      return;
    }
    
    // 不关闭列表页，让编辑器直接盖在上面（z-index 更高）
    
    _editingId = id;
    const modal = document.getElementById('sb-theme-editor-modal');
    
    // 清除全局自定义样式（避免污染编辑器里的折叠态预览）
    // closeEditor 时会通过 Worldview.reapplyStatusBarSkin 重新应用
    const globalStyle = document.getElementById('sb-theme-preview-custom');
    if (globalStyle) globalStyle.remove();
    
    if (!modal) {
      console.error('[StatusBarTheme.openEditor] 找不到编辑器 modal 元素');
      UI.showToast('错误：找不到编辑器元素', 3000);
      return;
    }

    console.log('[StatusBarTheme.openEditor] 加载草稿...');
    
    // 加载草稿
    const draft = theme.draft || { messages: [], currentCss: '' };
    const messages = draft.messages || [];
    
    // 渲染消息列表
    renderMessages(messages);
    
    // 更新标题
    const titleEl = document.getElementById('sb-editor-title');
    if (titleEl) titleEl.textContent = theme.name;

    // 更新用户昵称
    const nickEl = document.getElementById('sb-editor-user-nickname');
    if (nickEl && window.Auth) {
      nickEl.textContent = Auth.getNickname() || '用户';
    }
    
    console.log('[StatusBarTheme.openEditor] 显示 modal...');
    modal.classList.remove('hidden');
    
    // 滚动到底部
    setTimeout(() => {
      const container = document.getElementById('sb-editor-messages');
      if (container) container.scrollTop = container.scrollHeight;
    }, 100);
    
    console.log('[StatusBarTheme.openEditor] 完成');
  }

  function closeEditor() {
    const modal = document.getElementById('sb-theme-editor-modal');
    if (modal) modal.classList.add('hidden');
    
    // 收起展开态
    const host = document.getElementById('sb-editor-expanded');
    if (host) host.classList.add('hidden');
    
    _editingId = null;
    _extractedCss = null; // 清除 CSS 缓存，下次重新提取
    _savedGlobalState = null;
    
    // 移除编辑器可能残留的预览样式元素
    const oldBase = document.getElementById('sb-theme-preview-base');
    const oldCustom = document.getElementById('sb-theme-preview-custom');
    if (oldBase) oldBase.remove();
    if (oldCustom) oldCustom.remove();
    
    // 用和"刷新时"完全相同的路径重新应用当前世界观的状态栏
    if (window.Worldview && Worldview.reapplyStatusBarSkin) {
      Promise.resolve(Worldview.reapplyStatusBarSkin()).then(() => {
        if (window.StatusBar && StatusBar.refreshFromConv) StatusBar.refreshFromConv();
      }).catch(() => {});
    } else if (window.StatusBar && StatusBar.refreshFromConv) {
      StatusBar.refreshFromConv();
    }
    
    // 刷新列表（以防有更改）
    setTimeout(() => renderList(), 100);
  }

  // ── Shadow DOM 预览系统 ─────────────────────────────────────────
  let _shadowRoot = null;
  let _extractedCss = null; // 缓存提取的 CSS
  let _cssLoading = false;

  /**
   * 从 CSS 文件加载完整样式，做选择器替换后注入 Shadow DOM。
   * body[data-sb-skin="X"] → .sb-root[data-sb-skin="X"]
   * body[data-skin="X"]    → .sb-root[data-skin="X"]
   * body[data-worldview="X"] → .sb-root[data-worldview="X"]
   * body.glass-on → .sb-root.glass-on
   * #sb-custom-attrs → .sb-custom-attrs-section
   * #sb-character-attrs → .sb-character-attrs-section
   */
  async function _loadAndTransformCss() {
    if (_extractedCss) return _extractedCss;
    if (_cssLoading) {
      // 等待加载完成
      while (_cssLoading) await new Promise(r => setTimeout(r, 50));
      return _extractedCss || '';
    }
    
    _cssLoading = true;
    try {
      const resp = await fetch('css/style.css');
      let fullCss = await resp.text();
      
      // 选择器替换：body[...] → .sb-root[...]
      fullCss = fullCss.replace(/body\[data-sb-skin="([^"]+)"\]/g, '.sb-root[data-sb-skin="$1"]');
      fullCss = fullCss.replace(/body\[data-skin="([^"]+)"\]/g, '.sb-root[data-skin="$1"]');
      fullCss = fullCss.replace(/body\[data-worldview="([^"]+)"\]/g, '.sb-root[data-worldview="$1"]');
      fullCss = fullCss.replace(/body\.glass-on/g, '.sb-root.glass-on');
      // ID → class（避免和页面真实状态栏 ID 冲突）
      fullCss = fullCss.replace(/#sb-custom-attrs\b/g, '.sb-custom-attrs-section');
      fullCss = fullCss.replace(/#sb-character-attrs\b/g, '.sb-character-attrs-section');
      fullCss = fullCss.replace(/#sb-task-system\b/g, '.sb-task-system-section');
      // .sb-expanded-scroll → .sb-root（Shadow 内的滚动容器）
      fullCss = fullCss.replace(/\.sb-expanded-scroll\b/g, '.sb-root');
      // .sb-expanded-overlay → :host（Shadow 宿主本身）
      fullCss = fullCss.replace(/\.sb-expanded-overlay\b/g, ':host');
      
      // 添加 Shadow DOM 宿主和容器样式
      const hostCss = `
        :host {
          display: block;
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.45);
          z-index: 5;
          animation: sbFadeIn .2s ease-out;
        }
        :host(.hidden) { display: none !important; }
        .sb-root {
          width: 100%;
          height: 100%;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          padding: 12px 12px 16px;
          box-sizing: border-box;
          color: var(--text);
          font-family: var(--font-family, system-ui, sans-serif);
        }
      `;
      
      _extractedCss = hostCss + '\n' + fullCss;
      return _extractedCss;
    } catch (e) {
      console.error('[StatusBarTheme] CSS 文件加载失败:', e);
      _extractedCss = '';
      return '';
    } finally {
      _cssLoading = false;
    }
  }

  /**
   * 初始化/获取 Shadow DOM
   */
  function _getShadowRoot() {
    const host = document.getElementById('sb-editor-expanded');
    if (!host) return null;
    
    if (!host.shadowRoot) {
      _shadowRoot = host.attachShadow({ mode: 'open' });
    }
    return host.shadowRoot;
  }

  /**
   * 渲染 Shadow DOM 内的完整状态栏预览
   */
  async function _renderShadowPreview() {
    const shadow = _getShadowRoot();
    if (!shadow) return;
    
    const theme = get(_editingId);
    if (!theme) return;
    
    const baseTemplate = theme.baseTemplate || 'terminal';
    const draft = theme.draft || {};
    const customCss = draft.currentCss || theme.css || '';
    
    // 加载并转换 CSS（有缓存）
    const baseCss = await _loadAndTransformCss();
    
    // 构建 wrapper 属性
    let rootAttrs = '';
    if (baseTemplate === 'terminal' || baseTemplate === 'neumorph') {
      rootAttrs = `data-sb-skin="${baseTemplate}"`;
    } else if (baseTemplate === 'single-default') {
      rootAttrs = `data-skin="single-default"`;
    }
    
    // 获取当前主题的 CSS 变量（从 :root 继承）
    const computedStyle = getComputedStyle(document.documentElement);
    const cssVars = [
      '--bg', '--bg-secondary', '--bg-tertiary', '--text', '--text-secondary',
      '--accent', '--border', '--decoration', '--status-bg', '--status-card',
      '--font-family'
    ].map(v => {
      const val = computedStyle.getPropertyValue(v).trim();
      return val ? `${v}: ${val};` : '';
    }).filter(Boolean).join('\n');
    
    // 覆盖 topbar/input 高度变量（编辑器 topbar 约 120px，底部输入约 110px）
    const overrideVars = '--sb-topbar-h: 120px; --sb-input-h: 110px;';
    
    // 生成内容 HTML
    const contentHtml = _generateStatusBarContent();
    
    // 装饰重置（与真实页面 applyPreview 保持一致），需转换成 Shadow 选择器
    const resetCss = _transformCssForShadow(_getDecorationReset(baseTemplate));

    // 完整 Shadow DOM 内容
    shadow.innerHTML = `
      <style>
        :host { ${cssVars} ${overrideVars} }
        ${baseCss}
      </style>
      ${resetCss ? `<style id="sb-shadow-reset">${resetCss}</style>` : ''}
      ${customCss ? `<style id="sb-shadow-custom">${_transformCssForShadow(customCss)}</style>` : ''}
      <div class="sb-root" ${rootAttrs} onclick="event.stopPropagation()">
        ${contentHtml}
      </div>
    `;

    // NPC 折叠交互（终端/默认风可折叠；拟态/单人风 CSS 里 max-height:none，点击无视觉变化）
    const npcsHeader = shadow.querySelector('.sb-npcs-header');
    const npcsBody = shadow.querySelector('.sb-npcs-body');
    const npcsTitle = shadow.querySelector('.sb-npcs-title');
    if (npcsHeader && npcsBody) {
      npcsHeader.style.cursor = 'pointer';
      // 终端/默认风的标题带折叠箭头
      const isCollapsible = (baseTemplate === 'terminal' || baseTemplate === 'default');
      const baseTitle = isCollapsible ? 'NPCS' : 'Presences';
      const updateTitle = () => {
        if (!isCollapsible || !npcsTitle) return;
        const open = npcsBody.classList.contains('open');
        npcsTitle.textContent = `[ ${open ? '-' : '+'} ] ${baseTitle} (2)`;
      };
      updateTitle();
      npcsHeader.addEventListener('click', (ev) => {
        ev.stopPropagation();
        npcsBody.classList.toggle('open');
        updateTitle();
      });
    }
  }

  /**
   * 把用户/AI 写的 CSS 转换成 Shadow DOM 内可用的格式
   * body[data-sb-skin="X"] → .sb-root[data-sb-skin="X"]
   * 这样 AI 写的带 body 前缀的选择器也能在预览里生效
   */
  function _transformCssForShadow(css) {
    if (!css) return '';
    let out = css;
    // 将 :root 转换为 :host (Shadow DOM 根节点)
    out = out.replace(/:root/g, ':host');
    
    out = out.replace(/body\[data-sb-skin="([^"]+)"\]/g, '.sb-root[data-sb-skin="$1"]');
    out = out.replace(/body\[data-skin="([^"]+)"\]/g, '.sb-root[data-skin="$1"]');
    out = out.replace(/body\[data-worldview="([^"]+)"\]/g, '.sb-root[data-worldview="$1"]');
    // 裸 body 选择器（如 body .xxx 或 body{...}）→ .sb-root
    out = out.replace(/(^|[^-\w.])body(\s*[.#:\[\s{>+~,])/g, '$1.sb-root$2');
    return out;
  }

  /**
   * 更新 Shadow DOM 内的自定义 CSS（不重新渲染内容）
   */
  function _updateShadowCustomCss(css) {
    const shadow = _getShadowRoot();
    if (!shadow) return;
    
    let styleEl = shadow.getElementById('sb-shadow-custom');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'sb-shadow-custom';
      shadow.appendChild(styleEl);
    }
    styleEl.textContent = _transformCssForShadow(css);
  }

  function renderMessages(messages) {
    const container = document.getElementById('sb-editor-messages');
    if (!container) return;
    
    if (messages.length === 0) {
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:13px">告诉我你想要什么样的状态栏风格</div>';
      return;
    }
    
    container.innerHTML = messages.map((m, idx) => {
      const isUser = m.role === 'user';
      // 加载中（无内容）：显示三点动画
      if (m.loading && !m.content) {
        return `<div style="display:flex;gap:10px;margin-bottom:16px">
          <div style="flex:1;max-width:100%">
            <div style="padding:12px 14px;background:var(--bg-tertiary);border-radius:10px;display:inline-flex;gap:5px;align-items:center">
              <span class="sb-typing-dot"></span><span class="sb-typing-dot"></span><span class="sb-typing-dot"></span>
            </div>
          </div>
        </div>`;
      }
      // 报错气泡：红色边框 + 可点重试
      if (m.error) {
        return `<div style="display:flex;gap:10px;margin-bottom:16px">
          <div style="flex:1;max-width:100%">
            <div onclick="StatusBarTheme.retryLastSend()" style="padding:10px 12px;background:rgba(229,72,77,0.12);border:1px solid #e5484d;color:#e5484d;border-radius:10px;font-size:13px;line-height:1.5;white-space:pre-wrap;cursor:pointer">⚠️ ${_esc(m.content)}</div>
          </div>
        </div>`;
      }
      // 操作按钮（复制/编辑/删除）——用户和 AI 消息都有
      const actionBtns = `<div style="display:flex;gap:10px;margin-top:5px;${isUser ? 'justify-content:flex-end' : ''}">
        <span onclick="StatusBarTheme.copyMessage(${idx})" style="font-size:11px;color:var(--text-secondary);cursor:pointer;opacity:.75">复制</span>
        <span onclick="StatusBarTheme.editMessage(${idx})" style="font-size:11px;color:var(--text-secondary);cursor:pointer;opacity:.75">编辑</span>
        <span onclick="StatusBarTheme.deleteMessage(${idx})" style="font-size:11px;color:var(--text-secondary);cursor:pointer;opacity:.75">删除</span>
      </div>`;
      return `<div style="display:flex;gap:10px;margin-bottom:16px;${isUser ? 'flex-direction:row-reverse' : ''}">
        <div style="flex:1;max-width:100%;${isUser ? 'margin-left:auto' : ''}">
          <div class="md-content" style="padding:10px 12px;background:${isUser ? 'var(--accent)' : 'var(--bg-tertiary)'};color:${isUser ? '#fff' : 'var(--text)'};border-radius:10px;font-size:13px;line-height:1.5">${isUser ? _esc(m.content) : (typeof Markdown !== 'undefined' ? Markdown.render(m.content) : _esc(m.content))}</div>
          ${actionBtns}
        </div>
      </div>`;
    }).join('');
    
    container.scrollTop = container.scrollHeight;
  }

  let _isGenerating = false;
  let _abortCtrl = null;
  let _pendingImages = []; // [{ base64, name, type }]
  let _pendingFiles = [];  // [{ name, size, content }]

  // 发送按钮状态：'idle'（发送箭头）| 'generating'（红色 ✗ 可中止）
  function _setSendBtnState(state) {
    const btn = document.getElementById('sb-editor-send');
    const icon = document.getElementById('sb-editor-send-icon');
    if (!btn || !icon) return;
    if (state === 'generating') {
      btn.style.background = '#e5484d'; // 红色
      icon.outerHTML = '<svg id="sb-editor-send-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:18px;height:18px"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>';
    } else {
      btn.style.background = 'var(--accent)';
      icon.outerHTML = '<svg id="sb-editor-send-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:18px;height:18px"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" /></svg>';
    }
  }

  // 发送按钮点击分发：生成中 → 中止；空闲 → 发送
  function onSendBtnClick() {
    if (_isGenerating) {
      // 中止生成
      if (_abortCtrl) { try { _abortCtrl.abort(); } catch(_) {} }
      _isGenerating = false;
      _abortCtrl = null;
      _setSendBtnState('idle');
      UI.showToast('已停止生成', 1500);
    } else {
      sendMessage();
    }
  }
// 复制消息内容
  function copyMessage(idx) {
    const theme = get(_editingId);
    if (!theme || !theme.draft) return;
    const msg = (theme.draft.messages || [])[idx];
    if (!msg) return;
    const text = msg.content || '';
    // 优先用 navigator.clipboard，失败回退 textarea
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => UI.showToast('已复制', 1500),
        () => _fallbackCopy(text)
      );
    } else {
      _fallbackCopy(text);
    }
  }

  function _fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      UI.showToast('已复制', 1500);
    } catch(e) {
      UI.showToast('复制失败', 1500);
    }
  }

  // 删除消息
  function deleteMessage(idx) {
    if (_isGenerating) { UI.showToast('生成中，请稍候', 1500); return; }
    const theme = get(_editingId);
    if (!theme || !theme.draft) return;
    const msgs = theme.draft.messages || [];
    if (idx < 0 || idx >= msgs.length) return;
    msgs.splice(idx, 1);
    saveDraft(_editingId, theme.draft);
    renderMessages(msgs);
  }

  // 编辑消息：弹出输入框修改该条消息内容
  async function editMessage(idx) {
    if (_isGenerating) { UI.showToast('生成中，请稍候', 1500); return; }
    const theme = get(_editingId);
    if (!theme || !theme.draft) return;
    const msgs = theme.draft.messages || [];
    const msg = msgs[idx];
    if (!msg) return;
    const newContent = await UI.showSimpleInput('编辑消息', msg.content || '', { multiline: true, allowEmpty: true });
    if (newContent === null || newContent === undefined) return; // 取消
    msg.content = newContent;
    saveDraft(_editingId, theme.draft);
    renderMessages(msgs);
    // 如果编辑的是用户消息，提示可重新发送
    if (msg.role === 'user') UI.showToast('已修改（可重新发送让 AI 重答）', 2200);
  }

  // 点击报错气泡重试上一条
  function retryLastSend() {
    if (_isGenerating || !_editingId) return;
    const theme = get(_editingId);
    if (!theme || !theme.draft) return;
    const msgs = theme.draft.messages || [];
    // 移除末尾的报错占位消息
    if (msgs.length && msgs[msgs.length - 1].error) msgs.pop();
    saveDraft(_editingId, theme.draft);
    renderMessages(msgs);
    // 用最后一条用户消息重新发起
    _resend();
  }

  async function sendMessage() {
    if (!_editingId || _isGenerating) return;
    
    const input = document.getElementById('sb-editor-input');
    if (!input) return;
    
    const content = input.value.trim();
    if (!content) return;
    
    const theme0 = get(_editingId);
    if (!theme0) return;
    const draft0 = theme0.draft || { messages: [], currentCss: '' };
    draft0.messages.push({ role: 'user', content, ts: Date.now() });
    input.value = '';
    renderMessages(draft0.messages);
    saveDraft(_editingId, draft0);
    
    _resend();
  }

  // 实际发起 API 调用（sendMessage 和 retryLastSend 共用）
  async function _resend() {
    if (!_editingId || _isGenerating) return;
    
    const theme = get(_editingId);
    if (!theme) return;
    const draft = theme.draft || { messages: [], currentCss: '' };
    
    // ── 上下文长度管理（滑动窗口） ──
    const contextLimit = parseInt(draft.contextLimit) || 128000;
    
    // 估算 Token (粗略算法：中文1.5/字，其他1/字)
    const _est = (text) => {
      if (!text) return 0;
      const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
      return Math.ceil(cn * 1.5 + (text.length - cn));
    };

    // 保留最近的消息，直到总 Token 低于限制
    // 注意：至少保留最后一条用户消息
    // 此时 AI 占位还没有 push，所以 draft.messages 最后一条就是用户最新消息，全部保留
    let historyMsgs = draft.messages.slice().map(m => ({ role: m.role, content: m.content }));
    
    let totalEst = 0;
    let keepIdx = historyMsgs.length - 1;
    for (let i = historyMsgs.length - 1; i >= 0; i--) {
      const mToken = _est(typeof historyMsgs[i].content === 'string' ? historyMsgs[i].content : JSON.stringify(historyMsgs[i].content));
      if (totalEst + mToken > contextLimit && i < historyMsgs.length - 1) {
        keepIdx = i + 1;
        break;
      }
      totalEst += mToken;
      keepIdx = i;
    }
    
    if (keepIdx > 0) {
      console.log(`[StatusBarTheme] 上下文触发滑窗，丢弃前 ${keepIdx} 条消息，保留约 ${totalEst} tokens`);
      historyMsgs = historyMsgs.slice(keepIdx);
    }

    // ── 调用 AI ──
    _isGenerating = true;
    _abortCtrl = new AbortController();
    _setSendBtnState('generating');
    
    // 添加 AI 消息占位（用特殊标记触发加载动画）
    draft.messages.push({ role: 'assistant', content: '', ts: Date.now(), loading: true });
    renderMessages(draft.messages);
    
    const aiMsgIdx = draft.messages.length - 1;
    
    // 构建 system prompt
    const baseTemplate = theme.baseTemplate || 'terminal';
    const currentCss = draft.currentCss || theme.css || '';
    const systemPrompt = _buildSystemPrompt(baseTemplate, currentCss);
    
    // 构建 API messages
    // (历史消息已在上方滑窗逻辑中处理完成)

    // 把附件挂到最后一条用户消息上（图片走 multimodal，文件内容拼进 text）
    if ((_pendingImages.length > 0 || _pendingFiles.length > 0) && historyMsgs.length > 0) {
      const lastUserIdx = historyMsgs.length - 1;
      let textContent = historyMsgs[lastUserIdx].content || '';
      // 文件内容拼接到文本
      if (_pendingFiles.length > 0) {
        _pendingFiles.forEach(f => {
          textContent += `\n\n[附件文件：${f.name}]\n${f.content}`;
        });
      }
      // 有图片则转成 multimodal 数组
      if (_pendingImages.length > 0) {
        const parts = [{ type: 'text', text: textContent }];
        _pendingImages.forEach(img => {
          parts.push({ type: 'image_url', image_url: { url: img.base64 } });
        });
        historyMsgs[lastUserIdx].content = parts;
      } else {
        historyMsgs[lastUserIdx].content = textContent;
      }
    }
    
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...historyMsgs
    ];
    
    // 附件已发送，清空
    _pendingImages = [];
    _pendingFiles = [];
    _renderEditorAttachments();
    
    // 获取选中的预设配置
    const selectedPresetId = draft.apiPreset;
    let overrideConfig = null;
    if (selectedPresetId) {
      const presets = Settings._getPresets ? Settings._getPresets() : [];
      const preset = presets.find(p => p.id === selectedPresetId);
      if (preset && preset.apiUrl && preset.apiKey && preset.model) {
        overrideConfig = { 
          apiUrl: preset.apiUrl, 
          apiKey: preset.apiKey, 
          model: preset.model,
          maxTokens: 16000  // 状态栏美化默认 16k 输出限制，防止 CSS 被截断
        };
      }
    } else {
      // 没选预设时也给个兜底值（避免全局配置太低）
      overrideConfig = { maxTokens: 16000 };
    }
    
    let fullContent = '';
    
    API.streamChat(
      apiMessages,
      // onChunk
      (chunk) => {
        fullContent += chunk;
        draft.messages[aiMsgIdx].content = fullContent;
        draft.messages[aiMsgIdx].loading = false; // 有内容了，取消加载动画
        renderMessages(draft.messages);
      },
      // onDone
      () => {
        _isGenerating = false;
        _abortCtrl = null;
        _setSendBtnState('idle');
        draft.messages[aiMsgIdx].content = fullContent;
        draft.messages[aiMsgIdx].loading = false;
        
// 尝试从 AI 回复中提取 CSS
            const extractedCss = _extractCssFromResponse(fullContent);
            if (extractedCss !== null) {
              // ── 撤销历史：保存旧 CSS（最多5步）──
              if (!draft.cssHistory) draft.cssHistory = [];
              const oldCss = draft.currentCss || '';
              draft.cssHistory.push(oldCss);
              if (draft.cssHistory.length > 5) draft.cssHistory.shift();
              
              draft.currentCss = extractedCss;
              // 自动保存到正式字段（无需手动保存）
              update(_editingId, { css: extractedCss });
              updateCssPreview(extractedCss);
              UI.showToast('CSS 已更新，点击状态栏预览', 2000);
            }
        
        saveDraft(_editingId, draft);
        renderMessages(draft.messages);
      },
      // onError
      (err) => {
        _isGenerating = false;
        _abortCtrl = null;
        _setSendBtnState('idle');
        draft.messages[aiMsgIdx].loading = false;
        draft.messages[aiMsgIdx].error = true;
        draft.messages[aiMsgIdx].content = '生成失败：' + (err || '未知错误') + '（点击重试）';
        saveDraft(_editingId, draft);
        renderMessages(draft.messages);
      },
      _abortCtrl.signal,
      { overrideConfig }
    );
  }

  function _buildSystemPrompt(baseTemplate, currentCss) {
    const templateNames = { terminal: '终端风格', neumorph: '拟态风格', 'single-default': '无世界观风格' };
    const templateName = templateNames[baseTemplate] || baseTemplate;
    
    // 根据模板生成对应 DOM 结构
    const npcDom = baseTemplate === 'single-default' ? `
        &lt;div class="sb-npcs-list"&gt;
          &lt;div class="sb-npc-card"&gt;
            &lt;div class="sb-npc-content"&gt;
              &lt;div class="sb-npc-val"&gt;{衣着描述}&lt;/div&gt;
              &lt;div class="sb-npc-val"&gt;{姿态描述}&lt;/div&gt;
            &lt;/div&gt;
            &lt;div class="sb-npc-side"&gt;
              &lt;div class="sb-npc-avatar"&gt;&lt;span class="sb-npc-avatar-initial"&gt;{首字}&lt;/span&gt;&lt;/div&gt;
              &lt;div class="sb-npc-name"&gt;{名字}&lt;/div&gt;
            &lt;/div&gt;
          &lt;/div&gt;
        &lt;/div&gt;` : `
        &lt;div class="sb-npcs-list"&gt;
          &lt;div class="sb-npc-card"&gt;
            &lt;div class="sb-npc-name"&gt;{名字}&lt;/div&gt;
            &lt;div class="sb-npc-val"&gt;&lt;span class="sb-field-label-inline"&gt;&gt; OUTFIT_&lt;/span&gt; {衣着}&lt;/div&gt;
            &lt;div class="sb-npc-val"&gt;&lt;span class="sb-field-label-inline"&gt;&gt; POSTURE_&lt;/span&gt; {姿态}&lt;/div&gt;
          &lt;/div&gt;
          &lt;div class="sb-npc-empty"&gt;&lt;span class="sb-npc-add-full"&gt;+ 添加 NPC&lt;/span&gt;&lt;/div&gt;
        &lt;/div&gt;`;

    return `你是状态栏 CSS 美化助手。用户正在编辑「${templateName}」模板的状态栏主题。

## 职责
根据用户描述，输出自定义 CSS。CSS 叠加在模板基础样式之上（增量覆盖）。

## CSS 变量（跟随用户主题色自动变化）
**强烈建议优先使用这些主题色变量**，这样用户切换主题时状态栏颜色会自动跟随，保持整体协调。请把它们作为配色的第一选择。
- --bg, --bg-secondary, --bg-tertiary（背景色）
- --text, --text-secondary（文字色）
- --accent（强调色）
- --border, --decoration（边框/装饰色）
- --status-bg, --status-card（状态栏专用背景）
只有当用户**明确要求**某个固定颜色（例如"标题用大红色 #ff0000""背景就要纯黑"）时，才硬编码写死颜色值。否则一律用上面的变量，不要凭自己喜好写死颜色。

## ⛔ 作用域铁律（必须遵守，否则会破坏整个 App）
你写的 CSS 会注入到**整个页面的全局样式表**里，因此：
- **每一条选择器都必须限定在状态栏内**，即必须以状态栏根选择器开头：\`.sb-root\` 或 \`body[data-sb-skin="${baseTemplate}"]\` 或 \`body[data-skin]\`，或针对上面 DOM 结构里的 \`.sb-\` / \`.hs-\` 开头的具体 class。
- **严禁使用裸标签选择器或通用选择器**，例如 \`button {}\`、\`div {}\`、\`* {}\`、\`input {}\`、\`a {}\`——这些会命中整个 App 的所有元素，把全局界面改坏（比如把所有按钮变成方形）。
- 如果要改某个状态栏内的按钮，要写成 \`.sb-root .sb-card-close {}\` 这种带状态栏前缀的形式，绝不能只写 \`button {}\`。

## 完整 DOM 结构
以下是状态栏展开态的完整 HTML 结构（你的 CSS 选择器要对应这些 class）：

\`\`\`html
&lt;div class="sb-root" data-sb-skin="${baseTemplate}"&gt;
  &lt;!-- 主状态卡片 --&gt;
  &lt;div class="sb-status-card"&gt;
    &lt;button class="sb-card-close"&gt;×&lt;/button&gt;
    
    &lt;!-- 标题 --&gt;
    &lt;div class="sb-status-title"&gt;
      &lt;span class="sb-dot"&gt;&lt;/span&gt;
      &lt;span class="sb-title-default"&gt;STATUS CARD&lt;/span&gt;
    &lt;/div&gt;
    
    &lt;!-- 场景 --&gt;
    &lt;div class="sb-scene-wrap"&gt;
      &lt;div class="sb-scene-label"&gt;Current Scene&lt;/div&gt;
      &lt;div class="sb-scene"&gt;{场景文本}&lt;/div&gt;
    &lt;/div&gt;
    
    &lt;!-- 玩家状态 --&gt;
    &lt;div class="sb-player-card"&gt;
      &lt;div class="sb-field-row"&gt;
        &lt;div class="sb-field-label"&gt;&gt; OUTFIT_&lt;/div&gt;
        &lt;div class="sb-field-val"&gt;{穿搭}&lt;/div&gt;
      &lt;/div&gt;
      &lt;div class="sb-field-row"&gt;
        &lt;div class="sb-field-label"&gt;&gt; POSTURE_&lt;/div&gt;
        &lt;div class="sb-field-val"&gt;{姿势}&lt;/div&gt;
      &lt;/div&gt;
    &lt;/div&gt;
    
    &lt;!-- 全局自定义属性 --&gt;
    &lt;div class="sb-custom-attrs-section"&gt;
      &lt;div class="sb-custom-attrs-title"&gt;Custom Attributes&lt;/div&gt;
      &lt;div class="sb-custom-attrs-grid"&gt;
        &lt;div class="sb-custom-attr-card"&gt;
          &lt;div class="sb-custom-attr-name"&gt;{属性名}&lt;/div&gt;
          &lt;div class="sb-custom-attr-val"&gt;{数值}&lt;/div&gt;
        &lt;/div&gt;
        &lt;!-- 重复多个 --&gt;
      &lt;/div&gt;
    &lt;/div&gt;
    
    &lt;!-- 角色属性 --&gt;
    &lt;div class="sb-character-attrs-section"&gt;
      &lt;div class="sb-character-attrs-title"&gt;Character Attributes&lt;/div&gt;
      &lt;div class="sb-character-attrs-list"&gt;
        &lt;div class="sb-character-attr-card"&gt;
          &lt;div class="sb-character-attr-name"&gt;{角色名}&lt;/div&gt;
          &lt;div class="sb-character-attr-lines"&gt;
            &lt;div class="sb-character-attr-line"&gt;
              &lt;div class="sb-character-attr-row"&gt;
                &lt;span&gt;{属性名}&lt;/span&gt;&lt;b&gt;{值} / {最大值}&lt;/b&gt;
              &lt;/div&gt;
              &lt;div class="sb-character-attr-bar"&gt;&lt;i style="width:{百分比}%"&gt;&lt;/i&gt;&lt;/div&gt;
            &lt;/div&gt;
          &lt;/div&gt;
        &lt;/div&gt;
      &lt;/div&gt;
    &lt;/div&gt;
    
      &lt;!-- NPC 区域 --&gt;
      &lt;div class="sb-npcs-accordion"&gt;
        &lt;div class="sb-npcs-header"&gt;
          &lt;div class="sb-npcs-title"&gt;Presences&lt;/div&gt;
        &lt;/div&gt;
        &lt;div class="sb-npcs-body open"&gt;${npcDom}
      &lt;/div&gt;
    &lt;/div&gt;
    
    &lt;!-- 任务面板 --&gt;
    &lt;div class="sb-task-system-section"&gt;
      &lt;div class="hs-mission-section"&gt;
        &lt;div class="hs-module-title"&gt;Tasks&lt;/div&gt;
        &lt;div class="hs-mission-card"&gt;
          &lt;div class="hs-mission-head"&gt;
&lt;div&gt;
&lt;div class="hs-mission-label"&gt;{阶段名}&lt;/div&gt;
&lt;div class="hs-mission-score"&gt;&lt;span&gt;{进度}&lt;/span&gt;&lt;span&gt;{百分比}&lt;/span&gt;&lt;/div&gt;
&lt;/div&gt;
&lt;div style="display:flex;gap:6px;align-items:center"&gt;
&lt;button class="hs-skip-btn" style="background:rgba(255,255,255,0.06)"&gt;Sync&lt;/button&gt;
&lt;button class="hs-skip-btn"&gt;Skip&lt;/button&gt;
&lt;/div&gt;
&lt;/div&gt;
          &lt;div class="hs-score-track"&gt;&lt;div class="hs-score-fill" style="width:{%}"&gt;&lt;/div&gt;&lt;/div&gt;
          &lt;div class="hs-task-list"&gt;
            &lt;div class="hs-task-item active"&gt;
              &lt;span class="hs-task-dot"&gt;&lt;/span&gt;
              &lt;span class="hs-task-type"&gt;{类型}&lt;/span&gt;
              &lt;span class="hs-task-text"&gt;{任务内容}&lt;/span&gt;
            &lt;/div&gt;
          &lt;/div&gt;
        &lt;/div&gt;
      &lt;/div&gt;
    &lt;/div&gt;
  &lt;/div&gt;
&lt;/div&gt;
\`\`\`

## 折叠态（顶部摘要条）— 禁止修改
折叠态（顶部那一行时间/地点摘要）保持系统基础款，**请不要为它写任何 CSS**。
不要使用以下选择器（写了也不会生效，会被系统过滤掉）：
.topbar-row-status / .sb-datemeta / .sb-datemeta-left / .sb-datemeta-right
.sb-clock-main / .sb-date-sub / .sb-weather-line / .sb-region-line / .sb-place-text / .sb-chevron
你只需要美化展开态（上面那些卡片区域）。

## 输出规则
- CSS 代码放在 \`\`\`css 代码块中
- 每次输出完整 CSS（不是追加片段），因为会整体替换
- 可以用 ::before / ::after 伪元素添加装饰
- 可以附带简短说明
- 用户只是聊天时正常回答，不必强行输出 CSS

## 视觉铁律（必须遵守，否则界面会塌）
1. **背景必须不透明**：所有卡片/容器的 background 必须是不透明色（用 var(--bg)、var(--bg-secondary)、var(--bg-tertiary) 或不透明色值）。禁止用半透明背景（如 rgba(...,0.5)），否则后面的内容会透出来导致文字重叠看不清。
2. **保持布局流**：不要用 position:absolute / fixed 让元素脱离文档流乱飞。卡片之间靠 margin/padding/gap 排列，保持自上而下的正常流式布局。
3. **容器要有边界**：每个区块（状态卡、属性卡、NPC卡、任务卡）用 padding 和 background 形成清晰的视觉边界，不要让内容溢出或互相叠加。
4. **文字不重叠**：标题（如 SINGLE CARD / CURRENT SCENE）和正文之间要有足够间距（margin/padding），确保不重叠。
5. **大改也要克制**：可以彻底改配色、字体、圆角、装饰风格，做出和原版完全不同的视觉，但要保证每个元素清晰可读、布局整齐。"好看"的前提是"不乱"。

## ⚠️ 模板自带的装饰线/装饰符号（系统已自动清除，你无需处理）
当前模板「${templateName}」原本有 CSS 伪元素装饰（虚线、圆点、符号前缀等）。
**系统已自动注入重置 CSS 清除了所有模板装饰**——你不需要写 \`content:none\` 或 \`display:none\` 来清除它们。
你只需要专注于"加什么新样式"，而不需要记得"去什么旧样式"。
如果你想**恢复**某个被清除的装饰（比如想保留虚线），可以显式重新声明它。

## 📌 标题样式说明（大标题/小标题，容易"改了没用"）
状态栏有这些标题，改它们时注意以下机制，否则会"回归默认"：
- **状态卡大标题** \`.sb-status-title\`（里面有 \`.sb-dot\` 圆点 + \`.sb-title-default\` 文字"STATUS CARD"）
- **小标题**：\`.sb-custom-attrs-title\`（"Custom Attributes"）、\`.sb-character-attrs-title\`（"Character Attributes"）、\`.sb-npcs-title\`（"Presences"）、\`#sb-task-system .hs-mission-label\`（任务标题）
- **优先级陷阱**：模板默认标题样式选择器是 \`body[data-sb-skin="${baseTemplate}"] .xxx-title\`。你写覆盖时**必须带上 \`body[data-sb-skin="${baseTemplate}"]\` 前缀或加 !important**，否则优先级不够会被默认样式盖回去（这就是"改了没用/回归默认"的原因）。
- **拟态风阴影**：拟态风格的阴影是由变量控制的。要去掉阴影，请在 CSS 顶部加入：\`:root { --hs-shadow-neu: none !important; --hs-shadow-neu-hover: none !important; }\`
${baseTemplate === 'neumorph' || baseTemplate === 'single-default' ? `- **⚠️ 障眼法警告**：拟态风/无世界观风的 \`.sb-npcs-title\` 用了 \`font-size:0\` 隐藏原文字，再用 \`::before{content:"Presence"}\` 显示假标题。你改这个标题时要么改 \`::before\` 的 content，要么先把 \`font-size\` 改回正常值再设新文字。` : ''}
- 推荐写法示例：\`body[data-sb-skin="${baseTemplate}"] .sb-custom-attrs-title { font-size:14px; color:var(--accent); letter-spacing:.1em; }\`

## 当前自定义 CSS
${currentCss ? '```css\n' + currentCss + '\n```' : '（暂无，从零开始）'}`;
  }

  function _extractCssFromResponse(text) {
    if (!text) return null;
    // 1) 优先匹配 ```css ... ``` 代码块（宽松：大小写、语言标记后的空格/换行都兼容）
    let match = text.match(/```\s*css\b[ \t]*\n?([\s\S]*?)```/i);
    if (match && match[1] && match[1].trim()) {
      return match[1].trim();
    }
    // 1b) 同行紧贴格式 ```css xxx```
    match = text.match(/```\s*css\b[ \t]+([\s\S]*?)```/i);
    if (match && match[1] && match[1].trim()) {
      return match[1].trim();
    }
    // 2) 不再匹配任意代码块——只有明确标记为 css 的才提取，避免误替换
    // 3) 检测截断：有开头无结尾
    if (text.includes('```') && (text.match(/```/g) || []).length % 2 === 1) {
      UI.showToast('CSS 似乎被截断，请让 AI 继续输出', 3000);
    }
    return null;
  }

  async function saveEditorChanges() {
    if (!_editingId) return;
    
    const theme = get(_editingId);
    if (!theme) return;
    
    const draft = theme.draft || { messages: [], currentCss: '' };
    
    // 将草稿的 CSS 保存为最终版本
    update(_editingId, { css: draft.currentCss || theme.css });
    
    UI.showToast('已保存', 2000);
    closeEditor();
    openListPage();
  }

  function updateCssPreview(css) {
    if (!_editingId) return;
    
    const theme = get(_editingId);
    if (!theme) return;
    
    const draft = theme.draft || { messages: [], currentCss: '' };
    draft.currentCss = css;
    saveDraft(_editingId, draft);
    
    // 更新预览：只在 Shadow DOM 内生效（不污染真实页面）
    _updateShadowCustomCss(css);
    
    // 如果展开态可见，刷新整个 Shadow
    const host = document.getElementById('sb-editor-expanded');
    if (host && !host.classList.contains('hidden')) {
      _renderShadowPreview();
    }
  }

  // ── 导出导入 UI ────────────────────────────────────────────
  async function exportSingle(id) {
    const data = exportTheme(id);
    if (!data) return;
    
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `statusbar_theme_${data.name}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    UI.showToast('已导出', 2000);
  }

  async function importFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        
        // 判断是单个主题还是多个主题
        const isSingle = data.id && data.name && data.baseTemplate;
        const themes = isSingle ? { [data.id]: data } : data;
        
        const { imported, skipped } = importThemes(themes, 'rename');
        
        renderList();
        
        if (imported.length > 0) {
          UI.showToast(`已导入 ${imported.length} 个主题`, 2000);
        }
        if (skipped.length > 0) {
          UI.showToast(`跳过 ${skipped.length} 个同名主题`, 2000);
        }
      } catch (e) {
        console.error('[StatusBarTheme] 导入失败', e);
        UI.showToast('导入失败：文件格式错误', 3000);
      }
    };
    input.click();
  }

  // ── UI 层：编辑器交互 ────────────────────────────────────────
  function toggleEditorMenu() {
    const menu = document.getElementById('sb-editor-menu');
    if (menu) menu.classList.toggle('hidden');
  }

  function togglePlusMenu() {
    const menu = document.getElementById('sb-editor-plus-menu');
    if (menu) menu.classList.toggle('hidden');
  }

  function togglePreview(e) {
    if (e) e.stopPropagation();
    const host = document.getElementById('sb-editor-expanded');
    if (!host) return;
    
    const isHidden = host.classList.contains('hidden');
    
    if (isHidden) {
      // 展开：渲染 Shadow DOM 预览
      host.classList.remove('hidden');
      _renderShadowPreview(); // async，不 await，让它自己完成
    } else {
      // 收起
      host.classList.add('hidden');
    }
  }

  function _generateStatusBarContent() {
    const theme = get(_editingId);
    if (!theme) return '<div style="padding:20px;color:var(--text-secondary)">主题不存在</div>';
    
    const baseTemplate = theme.baseTemplate || 'terminal';
    const isSingle = (baseTemplate === 'single-default');
    
    let html = '';
    
    // .sb-status-card
    html += `<div class="sb-status-card">
      <button class="sb-card-close" onclick="event.stopPropagation();StatusBarTheme.togglePreview()" title="关闭" aria-label="关闭">×</button>
      <div class="sb-status-title">
        <span class="sb-dot"></span>
        <span class="sb-title-default">STATUS CARD</span>
        <span class="sb-title-hs"><span class="sb-title-hs-main">心动模拟</span><span class="sb-title-hs-sub">Status Bar</span></span>
        <span class="sb-title-single">SINGLE CARD</span>
      </div>
      
      <!-- 场景描写 -->
      <div class="sb-scene-wrap">
        <div class="sb-scene-label">Current Scene</div>
        <div class="sb-scene">天枢城中央商业区·咖啡厅二楼靠窗位置</div>
      </div>
      
      <div class="sb-player-card">
        <div class="sb-field-row">
          <div class="sb-field-label">> OUTFIT_</div>
          <div class="sb-field-val">休闲装扮</div>
        </div>
        <div class="sb-field-row">
          <div class="sb-field-label">> POSTURE_</div>
          <div class="sb-field-val">坐着，目光望向窗外</div>
        </div>
      </div>

      <!-- 自定义属性 -->
      <div class="sb-custom-attrs-section">
        <div class="sb-custom-attrs-title">Custom Attributes</div>
        <div class="sb-custom-attrs-grid">
          <div class="sb-custom-attr-card"><div class="sb-custom-attr-name">金钱</div><div class="sb-custom-attr-val">1250</div></div>
          <div class="sb-custom-attr-card"><div class="sb-custom-attr-name">体力</div><div class="sb-custom-attr-val">75/100</div></div>
          <div class="sb-custom-attr-card"><div class="sb-custom-attr-name">心情</div><div class="sb-custom-attr-val">85/100</div></div>
          <div class="sb-custom-attr-card"><div class="sb-custom-attr-name">声望</div><div class="sb-custom-attr-val">42</div></div>
        </div>
      </div>
      
      <!-- 角色属性 -->
      <div class="sb-character-attrs-section">
        <div class="sb-character-attrs-title">Character Attributes</div>
        <div class="sb-character-attrs-list">
          <div class="sb-character-attr-card">
            <div class="sb-character-attr-name">沈楚</div>
            <div class="sb-character-attr-lines">
              <div class="sb-character-attr-line">
                <div class="sb-character-attr-row"><span>好感度</span><b>78 / 100</b></div>
                <div class="sb-character-attr-bar"><i style="width:78%"></i></div>
              </div>
              <div class="sb-character-attr-line">
                <div class="sb-character-attr-row"><span>信任度</span><b>65 / 100</b></div>
                <div class="sb-character-attr-bar"><i style="width:65%"></i></div>
              </div>
            </div>
          </div>
          <div class="sb-character-attr-card">
            <div class="sb-character-attr-name">言殊</div>
            <div class="sb-character-attr-lines">
              <div class="sb-character-attr-line">
                <div class="sb-character-attr-row"><span>好感度</span><b>92 / 100</b></div>
                <div class="sb-character-attr-bar"><i style="width:92%"></i></div>
              </div>
              <div class="sb-character-attr-line">
                <div class="sb-character-attr-row"><span>亲密度</span><b>88 / 100</b></div>
                <div class="sb-character-attr-bar"><i style="width:88%"></i></div>
              </div>
            </div>
          </div>
        </div>
      </div>

        <!-- NPC -->
        <div class="sb-npcs-accordion">
          <div class="sb-npcs-header">
            <div class="sb-npcs-title">Presences</div>
          </div>
          <div class="sb-npcs-body open">
            <div class="sb-npcs-list">
            ${isSingle ? `
            <div class="sb-npc-card">
              <div class="sb-npc-content">
                <div class="sb-npc-val">围裙制服</div>
                <div class="sb-npc-val">正在吧台忙碌</div>
              </div>
              <div class="sb-npc-side">
                <div class="sb-npc-avatar"><span class="sb-npc-avatar-initial">咖</span></div>
                <div class="sb-npc-name">咖啡厅老板</div>
              </div>
            </div>
            <div class="sb-npc-card">
              <div class="sb-npc-content">
                <div class="sb-npc-val">黑色外套</div>
                <div class="sb-npc-val">坐在角落看书</div>
              </div>
              <div class="sb-npc-side">
                <div class="sb-npc-avatar"><span class="sb-npc-avatar-initial">神</span></div>
                <div class="sb-npc-name">神秘顾客</div>
              </div>
            </div>` : `
            <div class="sb-npc-card">
              <div class="sb-npc-name">咖啡厅老板</div>
              <div class="sb-npc-val"><span class="sb-field-label-inline">> OUTFIT_</span> 围裙制服</div>
              <div class="sb-npc-val"><span class="sb-field-label-inline">> POSTURE_</span> 正在吧台忙碌</div>
            </div>
            <div class="sb-npc-card">
              <div class="sb-npc-name">神秘顾客</div>
              <div class="sb-npc-val"><span class="sb-field-label-inline">> OUTFIT_</span> 黑色外套</div>
              <div class="sb-npc-val"><span class="sb-field-label-inline">> POSTURE_</span> 坐在角落看书</div>
            </div>`}
            <div class="sb-npc-empty"><span class="sb-npc-add-full">+ 添加 NPC</span><span class="sb-npc-add-plus">+</span></div>
          </div>
        </div>
      </div>

      <!-- 通用任务系统面板（在 .sb-status-card 内部） -->
      <div class="sb-task-system-section" style="margin-top:12px">
        <div class="hs-mission-section">
          <div class="hs-module-title">Tasks</div>
          <div class="hs-mission-card">
            <div class="hs-mission-head">
              <div>
                <div class="hs-mission-label">阶段 1</div>
                <div class="hs-mission-score"><span>2/5</span><span>40%</span></div>
              </div>
              <div style="display:flex;gap:6px;align-items:center">
                <button class="hs-skip-btn" style="background:rgba(255,255,255,0.06)">Sync</button>
                <button class="hs-skip-btn">Skip</button>
              </div>
            </div>
            <div class="hs-score-track"><div class="hs-score-fill" style="width:40%"></div></div>
            <div class="hs-task-list">
              <div class="hs-task-item active"><span class="hs-task-dot"></span><span class="hs-task-type">主线</span><span class="hs-task-text">寻找失落的记忆</span></div>
              <div class="hs-task-item active"><span class="hs-task-dot"></span><span class="hs-task-type">支线</span><span class="hs-task-text">收集咖啡厅情报</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
    
    return html;
  }

  function toggleApiPopup(e) {
    if (e) e.stopPropagation();
    const popup = document.getElementById('sb-editor-api-popup');
    if (!popup) return;
    popup.classList.toggle('hidden');
    
    // 首次打开时加载 API 列表
    if (!popup.classList.contains('hidden') && popup.innerHTML === '') {
      _renderApiPopup();
    }
    
    // 点外部关闭
    if (!popup.classList.contains('hidden')) {
      setTimeout(() => {
        const closeHandler = (ev) => {
          if (!popup.contains(ev.target)) {
            popup.classList.add('hidden');
            document.removeEventListener('click', closeHandler, true);
          }
        };
        document.addEventListener('click', closeHandler, true);
      }, 0);
    }
  }

  function _renderApiPopup() {
    const popup = document.getElementById('sb-editor-api-popup');
    if (!popup) return;
    
    const presets = Settings._getPresets ? Settings._getPresets() : [];
    
    if (presets.length === 0) {
      popup.innerHTML = '<div style="padding:8px;color:var(--text-secondary);font-size:12px">暂无 API 预设</div>';
      return;
    }
    
    popup.innerHTML = presets.map(p => 
      `<button onclick="StatusBarTheme.selectApiPreset('${_esc(p.id)}')" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:var(--text);font-size:13px;text-align:left;cursor:pointer;white-space:nowrap">${_esc(p.name)}<span style="font-size:11px;color:var(--text-secondary);margin-left:4px">${_esc(p.model || '')}</span></button>`
    ).join('');
  }

  function selectApiPreset(presetId) {
    // 保存选中的 API 预设
    const theme = get(_editingId);
    if (theme) {
      const draft = theme.draft || { messages: [], currentCss: '', apiPreset: null };
      draft.apiPreset = presetId;
      saveDraft(_editingId, draft);
    }
    
    const presets = Settings._getPresets ? Settings._getPresets() : [];
    const btn = document.getElementById('sb-editor-api-name');
    const preset = presets.find(p => p.id === presetId);
    if (btn && preset) btn.textContent = preset.name;
    
    // 关闭弹窗
    const popup = document.getElementById('sb-editor-api-popup');
    if (popup) popup.classList.add('hidden');
  }

  // ── CSS 编辑器 ────────────────────────────────────────────────
  function openCssEditor() {
    if (!_editingId) return;
    
    const theme = get(_editingId);
    if (!theme) return;
    
    const draft = theme.draft || { messages: [], currentCss: '' };
    const css = draft.currentCss || theme.css || '';
    
    const textarea = document.getElementById('sb-css-editor-textarea');
    const modal = document.getElementById('sb-css-editor-modal');
    
    if (textarea) textarea.value = css;
    if (modal) modal.classList.remove('hidden');
    
    // 关闭烤串菜单
    toggleEditorMenu();
  }

  function closeCssEditor() {
    const modal = document.getElementById('sb-css-editor-modal');
    if (modal) modal.classList.add('hidden');
  }

  function saveCssFromEditor() {
    const textarea = document.getElementById('sb-css-editor-textarea');
    if (!textarea) return;
    
    const css = textarea.value;
    updateCssPreview(css);
    // 自动保存到正式字段
    if (_editingId) update(_editingId, { css });
    closeCssEditor();
    UI.showToast('CSS 已应用并保存', 2000);
  }

  // ── 附件上传（对齐主聊天：图片走 multimodal，文件走文本拼接）──
  function attachImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = (e) => {
      const files = Array.from(e.target.files);
      files.forEach(file => {
        if (_pendingImages.length >= 3) { UI.showToast('最多3张图片', 1800); return; }
        const reader = new FileReader();
        reader.onload = (ev) => {
          _pendingImages.push({ base64: ev.target.result, name: file.name, type: file.type });
          _renderEditorAttachments();
        };
        reader.readAsDataURL(file);
      });
    };
    input.click();
    togglePlusMenu();
  }

  async function attachFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = Array.from(e.target.files);
      for (const file of files) {
        try {
          const content = await Utils.readFileAsText(file);
          if (content.length > 20000) {
            const ok = await UI.showConfirm('文件内容较长',
              `「${file.name}」约 ${Math.round(content.length / 1000)}k 字符，过长可能占满上下文。确定附加吗？`);
            if (!ok) continue;
          }
          _pendingFiles.push({ name: file.name, size: file.size, content });
          _renderEditorAttachments();
        } catch (err) {
          UI.showToast('读取失败: ' + (err.message || file.name), 2500);
        }
      }
    };
    input.click();
    togglePlusMenu();
  }

  // 渲染附件预览条
  function _renderEditorAttachments() {
    const container = document.getElementById('sb-editor-attachments');
    if (!container) return;
    if (_pendingImages.length === 0 && _pendingFiles.length === 0) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }
    container.classList.remove('hidden');
    let html = '';
    _pendingImages.forEach((img, i) => {
      html += `<div class="attach-item">
        <img src="${img.base64}">
        <span>${_esc(img.name)}</span>
        <button class="remove-attach" onclick="StatusBarTheme.removeAttachment('image',${i})"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    });
    _pendingFiles.forEach((f, i) => {
      html += `<div class="attach-item">
        <span style="display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0 0 16.5 9h-1.875a1.875 1.875 0 0 1-1.875-1.875V5.25A3.75 3.75 0 0 0 9 1.5H5.625Z" clip-rule="evenodd" /></svg>${_esc(f.name)}</span>
        <button class="remove-attach" onclick="StatusBarTheme.removeAttachment('file',${i})"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    });
    container.innerHTML = html;
  }

  function removeAttachment(type, index) {
    if (type === 'image') _pendingImages.splice(index, 1);
    else if (type === 'file') _pendingFiles.splice(index, 1);
    _renderEditorAttachments();
  }

  // ── 撤销 CSS（最多5步）────────────────────────────────────
  function undoCss() {
    if (!_editingId) return;
    const theme = get(_editingId);
    if (!theme || !theme.draft) return;
    const draft = theme.draft;
    if (!draft.cssHistory || draft.cssHistory.length === 0) {
      UI.showToast('没有可撤销的历史', 1500);
      return;
    }
    const prevCss = draft.cssHistory.pop();
    draft.currentCss = prevCss;
    update(_editingId, { css: prevCss });
    updateCssPreview(prevCss);
    saveDraft(_editingId, draft);
    UI.showToast(`已撤销（剩余 ${draft.cssHistory.length} 步）`, 1500);
  }

  async function renameTheme() {
    if (!_editingId) return;
    const theme = get(_editingId);
    if (!theme) return;

    const newName = await UI.showSimpleInput('重命名主题', theme.name, {
      placeholder: '输入新名称',
      allowEmpty: false
    });

    if (newName === null || newName.trim() === theme.name) return;

    const trimmed = newName.trim();
    if (!trimmed) {
      UI.showToast('名称不能为空', 2000);
      return;
    }

    theme.name = trimmed;
    update(_editingId, { name: trimmed });

    // 更新编辑器标题
    const titleEl = document.getElementById('sb-editor-title');
    if (titleEl) titleEl.textContent = trimmed;

    UI.showToast('已重命名', 1500);
  }

  async function setContextLimit() {
    if (!_editingId) return;
    const theme = get(_editingId);
    if (!theme) return;
    const draft = theme.draft || { messages: [], currentCss: '' };
    const current = draft.contextLimit || 128000;

    const val = await UI.showSimpleInput('上下文长度限制 (tokens)', current, {
      type: 'number',
      placeholder: '默认 128000',
      helpText: '超过此长度的消息将从较早的记录开始舍弃。设置为 0 则不限制。'
    });

    if (val === null) return;
    const num = parseInt(val);
    if (isNaN(num) || num < 0) {
      UI.showToast('请输入有效的正整数', 2000);
      return;
    }

    draft.contextLimit = num;
    saveDraft(_editingId, draft);
    UI.showToast(`已设置上下文限制为 ${num} tokens`, 2000);
  }

  // ── 导出/导入（编辑器内） ────────────────────────────────────
  function exportCurrentTheme() {
    if (_editingId) {
      exportSingle(_editingId);
      toggleEditorMenu();
    }
  }

  function importFromFileInEditor() {
    importFromFile();
    toggleEditorMenu();
  }

  // ── 公开接口 ────────────────────────────────────────────────
  return {
    PRESETS,
    create,
    get,
    update,
    remove,
    getAll,
    saveDraft,
    clearDraft,
    applyPreview,
    clearPreview,
    exportTheme,
    exportSelected,
    importThemes,
    setEditingId: (id) => { _editingId = id; },
    getEditingId: () => _editingId,
    // UI
    openListPage,
    closeListPage,
    renderList,
    deleteThemeWithConfirm,
    openTemplatePicker,
    closeTemplatePicker,
    selectTemplate,
    openEditor,
    closeEditor,
    sendMessage,
    onSendBtnClick,
    retryLastSend,
    copyMessage,
    editMessage,
    deleteMessage,
    saveEditorChanges,
    updateCssPreview,
    exportSingle,
    importFromFile,
    // 编辑器交互
    toggleEditorMenu,
    togglePlusMenu,
    togglePreview,
    toggleApiPopup,
    selectApiPreset,
    openCssEditor,
    closeCssEditor,
    saveCssFromEditor,
    attachImage,
    attachFile,
    removeAttachment,
    renameTheme,
    undoCss,
    setContextLimit,
    exportCurrentTheme,
    importFromFileInEditor
  };
})();
