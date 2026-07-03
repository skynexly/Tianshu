/**
 * Theme 模块 — 预设主题 + 细调
 * 存储：localStorage key = "themeConfig"
 * 策略：全量覆盖所有 :root CSS 变量，整个 UI 联动响应
 */
const Theme = (() => {
  let editingCustomName = null;

  const STORAGE_KEY = 'themeConfig';

  // ── 内置预设 ──────────────────────────────────────────────
  const PRESETS = {
    '天枢城': {
      bg:                       '#0f0f0f',
      bgSecondary:              '#1a1a1a',
      bgSecondaryOpacity:       0.49324334342606385,
      bgTertiary:               '#444444',
      bgTertiaryOpacity:        0.322423997718141,
      text:                     '#e0e0e0',
      textSecondary:            '#888888',
      accent:                   '#00cdb4',
      decoration:               '#1eb374',
      border:                   '#ff0000',
      borderOpacity:            0.5464527102730147,
      aiBubbleBg:               '#1a1a2e',
      aiBubbleOpacity:          0,
      aiBubbleBorder:           '#ff000c',
      aiBubbleBorderOpacity:    0,
      aiBubbleText:             '#e0e0e0',
      userBubbleBg:             '#ffffff',
      userBubbleOpacity:        0,
      userBubbleBorder:         '#00d29d',
      userBubbleBorderOpacity:  0.7614019862393179,
      userBubbleText:           '#e0e0e0',
      chatBgImage:              (typeof window !== 'undefined' && window.__TIANSHUCHENG_BG__) || '',
      glassEnabled:             true,
      aiBubbleRender:           true,
    },
    '心动模拟': {
      bg: "#ffffff",
      bgSecondary: "#ffffff",
      bgSecondaryOpacity: 1,
      bgTertiary: "#edc9cb",
      bgTertiaryOpacity: 0.25337841205565426,
      text: "#4d4d4d",
      textOpacity: 1,
      textSecondary: "#8c8c8c",
      textSecondaryOpacity: 1,
      accent: "#db9b9b",
      decoration: "#c27f77",
      border: "#e08b8b",
      borderOpacity: 1,
      aiBubbleBg: "#e8eef5",
      aiBubbleOpacity: 0,
      aiBubbleBorder: "#c0ccd8",
      aiBubbleBorderOpacity: 0,
      aiBubbleText: "#4d4d4d",
      userBubbleBg: "#db9b9b",
      userBubbleOpacity: 1,
      userBubbleBorder: "#c0d0c0",
      userBubbleBorderOpacity: 0,
      userBubbleText: "#ffffff",
      chatBgImage: "",
      statusBarBg: "#ffffff",
      statusBarBgOpacity: 1,
      statusBarCard: "#e6b2b2",
      statusBarCardOpacity: 0.16596289801120573,
      glassEnabled: false,
      aiBubbleRender: true,
      msgFontSize: 13.5,
    },
    '暖棕': {
      bg:                    '#120d08',
      bgSecondary:           '#1e1610',
      bgTertiary:            '#2a1f16',
      text:                  '#e8d8c0',
      textSecondary:         '#9a8070',
      accent:                '#d4945a',
      decoration:            '#a67c52',
      border:                '#3a2a1e',
      aiBubbleBg:            '#1e1508',
      aiBubbleOpacity:       1,
      aiBubbleBorder:        '#3a2810',
      aiBubbleBorderOpacity: 1,
      aiBubbleText:          '#e8d8c0',
      userBubbleBg:          '#1a1a0e',
      userBubbleOpacity:     1,
      userBubbleBorder:      '#302a18',
      userBubbleBorderOpacity: 1,
      userBubbleText:        '#e8d8c0',
      chatBgImage:           '',
    },
    '霜白': {
      bg:                    '#ffffff',
      bgSecondary:           '#ffffff',
      bgSecondaryOpacity:    1,
      bgTertiary:            '#c9dfe1',
      bgTertiaryOpacity:     0.34353881652437857,
      text:                  '#1a1a1a',
      textOpacity:           1,
      textSecondary:         '#666666',
      textSecondaryOpacity:  1,
      accent:                '#8fb9c4',
      decoration:            '#819da5',
      border:                '#6f80a1',
      borderOpacity:         1,
      aiBubbleBg:            '#e8eef5',
      aiBubbleOpacity:       0,
      aiBubbleBorder:        '#c0ccd8',
      aiBubbleBorderOpacity: 0,
      aiBubbleText:          '#1a1a1a',
      userBubbleBg:          '#e8f0e8',
      userBubbleOpacity:     0,
      userBubbleBorder:      '#748aaa',
      userBubbleBorderOpacity: 1,
      userBubbleText:        '#1a1a1a',
      chatBgImage:           '',
      statusBarBg:           '#ffffff',
      statusBarBgOpacity:    1,
      statusBarCard:         '#a3c5d9',
      statusBarCardOpacity:  0.6779982802288728,
      glassEnabled:          false,
      aiBubbleRender:        true,
      msgFontSize:           13.5,
    },
    '暮紫': {
      bg:                    '#0e0b16',
      bgSecondary:           '#181320',
      bgTertiary:            '#221a2e',
      text:                  '#e0d8f0',
      textSecondary:         '#8878aa',
      accent:                '#b088e0',
      decoration:            '#7a5c9e',
      border:                '#302040',
      aiBubbleBg:            '#160e28',
      aiBubbleOpacity:       1,
      aiBubbleBorder:        '#2a1848',
      aiBubbleBorderOpacity: 1,
      aiBubbleText:          '#e0d8f0',
      userBubbleBg:          '#100e20',
      userBubbleOpacity:     1,
      userBubbleBorder:      '#201838',
      userBubbleBorderOpacity: 1,
      userBubbleText:        '#e0d8f0',
      chatBgImage:           '',
    },
  };

  const DEFAULT_PRESET = '天枢城';

  // ── 工具函数 ──────────────────────────────────────────────
  function toRgba(hex, opacity) {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return `rgba(${r},${g},${b},${opacity})`;
  }

  function dimColor(hex, factor) {
    const clamp = v => Math.min(255, Math.max(0, Math.round(v)));
    const r = clamp(parseInt(hex.slice(1,3),16) * factor);
    const g = clamp(parseInt(hex.slice(3,5),16) * factor);
    const b = clamp(parseInt(hex.slice(5,7),16) * factor);
    return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
  }

  // ── 存取 ──────────────────────────────────────────────────
  function load() {
    // 透明度类字段：旧存档可能没有，给安全默认（1=不透明）
    const OPACITY_DEFAULTS = {
      bgSecondaryOpacity: 1, bgTertiaryOpacity: 1,
      textOpacity: 1, textSecondaryOpacity: 1, borderOpacity: 1,
      aiBubbleText: null, userBubbleText: null,
      aiBubbleRender: true,
    };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const base  = Object.assign({}, PRESETS[DEFAULT_PRESET]);
      // 注意：先填 OPACITY_DEFAULTS，再用 base 覆盖（保留 preset 的 glassEnabled），最后 saved 覆盖
      // 不要把 glassEnabled 放进 OPACITY_DEFAULTS，否则会硬把天枢城的 true 打成 false
      return Object.assign({}, OPACITY_DEFAULTS, base, saved);
    } catch {
      return Object.assign({}, OPACITY_DEFAULTS, PRESETS[DEFAULT_PRESET]);
    }
  }

  function save(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  // ── 毛玻璃底部 padding 同步 ──────────────────────────────
  function _syncGlassPadding(glassOn) {
    requestAnimationFrame(() => {
      const msgs = document.getElementById('chat-messages');
      const input = document.querySelector('.chat-input-area');
      if (msgs) {
        if (glassOn && input && input.offsetHeight > 0) {
          msgs.style.paddingBottom = input.offsetHeight + 12 + 'px';
        } else if (glassOn) {
          // 面板隐藏时拿不到高度，用安全值
          msgs.style.paddingBottom = '80px';
        } else {
          msgs.style.paddingBottom = '';
        }
      }
    });
  }

  // ── 应用全量变量 ──────────────────────────────────────────
function apply(cfg) {
    const s = document.documentElement.style;
    // 保险：如果本地存储显示省电模式关闭，但 body 上残留 lite-mode，立刻清掉；否则毛玻璃会被全局 CSS 禁用
    try { if (!isLiteMode()) document.body.classList.remove('lite-mode'); } catch(_) {}
    // 同步 theme-color meta，让 iOS Home Indicator 区域跟着主题底色（消除底部黑/白条）
    try {
      const tc = document.querySelector('meta[name="theme-color"]');
      if (tc && cfg.bg) tc.setAttribute('content', cfg.bg);
    } catch(_) {}
    s.setProperty('--bg',           cfg.bg);
    s.setProperty('--bg-secondary', toRgba(cfg.bgSecondary, cfg.bgSecondaryOpacity ?? 1));
    s.setProperty('--bg-glass',     cfg.glassEnabled ? toRgba(cfg.bgSecondary, Math.min(cfg.bgSecondaryOpacity ?? 1, 0.7)) : toRgba(cfg.bgSecondary, cfg.bgSecondaryOpacity ?? 1));
    s.setProperty('--bg-glass-inner', cfg.glassEnabled ? toRgba(cfg.bgSecondary, Math.min(cfg.bgSecondaryOpacity ?? 1, 0.35)) : toRgba(cfg.bgSecondary, cfg.bgSecondaryOpacity ?? 1));
    s.setProperty('--bg-tertiary',  toRgba(cfg.bgTertiary,  cfg.bgTertiaryOpacity  ?? 1));
    // solid 版本：忽略主题不透明度，纯色——小手机壁纸下的卡片自己控透明度时用
    s.setProperty('--bg-solid',           cfg.bg);
    s.setProperty('--bg-secondary-solid', cfg.bgSecondary);
    s.setProperty('--bg-tertiary-solid',  cfg.bgTertiary);

    // 毛玻璃 body class
    document.body.classList.toggle('glass-on', !!cfg.glassEnabled);

    // 毛玻璃开启时，同步聊天区底部 padding 以避让浮动底栏
    _syncGlassPadding(cfg.glassEnabled);
    s.setProperty('--text',         toRgba(cfg.text,        cfg.textOpacity         ?? 1));
    s.setProperty('--text-secondary', toRgba(cfg.textSecondary, cfg.textSecondaryOpacity ?? 1));
    s.setProperty('--accent',       cfg.accent);
    s.setProperty('--accent-dim',   dimColor(cfg.accent, 0.7));
    s.setProperty('--decoration',   cfg.decoration);
    s.setProperty('--border',       toRgba(cfg.border, cfg.borderOpacity ?? 1));
    s.setProperty('--msg-ai-bg',    toRgba(cfg.aiBubbleBg,     cfg.aiBubbleOpacity));
    s.setProperty('--msg-ai-border',toRgba(cfg.aiBubbleBorder, cfg.aiBubbleBorderOpacity));
    s.setProperty('--msg-ai-text',  cfg.aiBubbleText  || cfg.text);
    s.setProperty('--msg-user-bg',  toRgba(cfg.userBubbleBg,   cfg.userBubbleOpacity));
    s.setProperty('--msg-user-border', toRgba(cfg.userBubbleBorder, cfg.userBubbleBorderOpacity));
    s.setProperty('--msg-user-text',cfg.userBubbleText || cfg.text);

    // 状态栏配色（默认从次级背景/三级背景兜底）
    s.setProperty('--status-bg',   toRgba(cfg.statusBarBg   || cfg.bgSecondary, cfg.statusBarBgOpacity   ?? 1));
    s.setProperty('--status-card', toRgba(cfg.statusBarCard || cfg.bgTertiary,  cfg.statusBarCardOpacity ?? 1));

    // 聊天背景图（设到 CSS 变量上，由 .chat-messages::before 伪元素读取，
    // 避免华为/MIUI 浏览器长按时把背景图识别为图片弹出"保存图片"菜单）
    const chatArea = document.getElementById('chat-messages');
    if (chatArea) {
      // 清掉历史遗留的内联背景图（旧版本曾设在元素自身上）
      chatArea.style.backgroundImage = '';
      chatArea.style.backgroundSize = '';
      chatArea.style.backgroundPosition = '';
    }
    s.setProperty('--chat-bg-image', _resolveChatBgImage(cfg.chatBgImage));

    // 字体
    const BUILTIN_FONTS = {
      system: { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', url: null },
      kai: { family: '"Ma Shan Zheng", cursive', url: 'https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng&display=swap' },
      song: { family: '"ZCOOL XiaoWei", serif', url: 'https://fonts.googleapis.com/css2?family=ZCOOL+XiaoWei&display=swap' },
      rounded: { family: '"ZCOOL QingKe HuangYou", sans-serif', url: 'https://fonts.googleapis.com/css2?family=ZCOOL+QingKe+HuangYou&display=swap' },
      mono: { family: '"Noto Sans KR", sans-serif', url: 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;700&display=swap' }
    };
    function _loadGoogleFont(url) {
      if (!url) return;
      if (document.querySelector('link[href="' + url + '"]')) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      document.head.appendChild(link);
    }
    if (cfg.fontMode === 'custom' || /^custom[123]$/.test(cfg.fontMode)) {
      // 兼容旧值 'custom' → 槽1；数据键 customFontData_N（旧的 customFontData 视作槽1）
      const slot = cfg.fontMode === 'custom' ? 1 : parseInt(cfg.fontMode.slice(6), 10);
      const dataKey = slot === 1 ? ['customFontData_1', 'customFontData'] : ['customFontData_' + slot];
      const faceName = 'CustomThemeFont' + slot;
      (async () => {
        let val = null;
        for (const k of dataKey) {
          try { const rec = await DB.get('settings', k); if (rec && rec.value) { val = rec.value; break; } } catch(_) {}
        }
        if (val) {
          try {
            const fontFace = new FontFace(faceName, 'url("' + val + '")');
            fontFace.load().then(f => {
              document.fonts.add(f);
              s.setProperty('--font-family', '"' + faceName + '", sans-serif');
            }).catch(() => {});
          } catch(e) {}
        }
      })();
    } else if (BUILTIN_FONTS[cfg.fontMode]) {
      const f = BUILTIN_FONTS[cfg.fontMode];
      _loadGoogleFont(f.url);
      s.setProperty('--font-family', f.family);
    } else {
      s.removeProperty('--font-family');
    }

    // 正文字号（v681.3）
    const fs = Number(cfg.msgFontSize);
    s.setProperty('--msg-font-size', (Number.isFinite(fs) && fs > 0 ? fs : 15) + 'px');
    // 强制浏览器刷新 CSS 变量，防止换主题后某些面板卡片样式不更新（Android Chrome / MIUI 常见问题）
    try {
      void document.documentElement.offsetHeight;
    } catch(_) {}
  }

  // 对话级背景图覆盖（优先级高于主题级 chatBgImage；空字符串/undefined 表示走主题级）
  let _convBgOverride = null;
  function _resolveChatBgImage(themeBg) {
    const url = (_convBgOverride !== null && _convBgOverride !== undefined) ? _convBgOverride : themeBg;
    return url ? `url("${url}")` : 'none';
  }
  function setConvBgOverride(url) {
    _convBgOverride = (url == null || url === '') ? null : url;
    const cfg = load();
    document.documentElement.style.setProperty('--chat-bg-image', _resolveChatBgImage(cfg.chatBgImage));
  }

  let _themeSwitchTimer = null;
  function withThemeFade(fn) {
    // v688.1: 去掉 fade 动画，直接同步应用，避免与面板切换冲突导致世界观空白
    if (_themeSwitchTimer) clearTimeout(_themeSwitchTimer);
    _themeSwitchTimer = null;
    fn();
  }
// ── 初始化 ────────────────────────────────────────────────
function init() {
apply(load());
// 启动时应用省电模式（持久化在 localStorage）
try { applyLiteMode(isLiteMode()); } catch(_) {}
}

  // ── 表单操作（已迁移至 _syncAllTriggers）──────────────────

  function readForm() {
    const get  = id => { const el = document.getElementById(id); return el ? el.value : ''; };
    const getF = id => { const el = document.getElementById(id); return el ? parseFloat(el.value) : 1; };
    const old  = load();
    return {
      bg:                    get('th-bg')            || old.bg,
      bgSecondary:           get('th-bg-secondary')  || old.bgSecondary,
      bgSecondaryOpacity:    getF('th-bg-secondary-op'),
      bgTertiary:            get('th-bg-tertiary')   || old.bgTertiary,
      bgTertiaryOpacity:     getF('th-bg-tertiary-op'),
      text:                  get('th-text')          || old.text,
      textOpacity:           getF('th-text-op'),
      textSecondary:         get('th-text-secondary')|| old.textSecondary,
      textSecondaryOpacity:  getF('th-text-secondary-op'),
      accent:                get('th-accent')        || old.accent,
      decoration:            get('th-decoration')    || old.decoration,
      border:                get('th-border')        || old.border,
      borderOpacity:         getF('th-border-op'),
      aiBubbleBg:            get('th-ai-bg')         || old.aiBubbleBg,
      aiBubbleOpacity:       getF('th-ai-opacity'),
      aiBubbleBorder:        get('th-ai-border')     || old.aiBubbleBorder,
      aiBubbleBorderOpacity: getF('th-ai-border-op'),
      aiBubbleText:          get('th-ai-text')        || old.aiBubbleText || null,
      userBubbleBg:          get('th-user-bg')       || old.userBubbleBg,
      userBubbleOpacity:     getF('th-user-opacity'),
      userBubbleBorder:      get('th-user-border')   || old.userBubbleBorder,
      userBubbleBorderOpacity: getF('th-user-border-op'),
      userBubbleText:        get('th-user-text')      || old.userBubbleText || null,
      chatBgImage:           old.chatBgImage || '',
      statusBarBg:           get('th-status-bg')     || old.statusBarBg   || '',
      statusBarBgOpacity:    getF('th-status-bg-op'),
      statusBarCard:         get('th-status-card')   || old.statusBarCard || '',
      statusBarCardOpacity:  getF('th-status-card-op'),
      glassEnabled:          old.glassEnabled ?? false,
      aiBubbleRender:        old.aiBubbleRender ?? true,
      fontMode:              old.fontMode || 'default',
      customFontData:        old.customFontData || null,
      msgFontSize:           old.msgFontSize ?? 13.5,
    };
  }

  // 点预设按钮
  function applyPreset(name) {
     const p = PRESETS[name];
     if (!p) return;
     const old = load();
     const cfg = Object.assign({}, p);
     cfg.customPresetName = '';
     // 保留字体设置
     cfg.fontMode = old.fontMode || 'default';
     // 保留正文字号（v681.3.2）
     cfg.msgFontSize = old.msgFontSize ?? 13.5;
     withThemeFade(() => {
save(cfg);
apply(cfg);
});
_syncAllTriggers(cfg);
     // 换主题后重新渲染当前页面，防止样式混乱
     try { if (typeof Chat !== 'undefined' && Chat.renderAll) Chat.renderAll(); } catch(_) {}
    // 同步背景图预览（内置预设没有背景图，清空）
    const img = document.getElementById('th-bg-image-preview');
    if (img) { img.src = ''; img.style.display = 'none'; }
    document.querySelectorAll('.th-preset-btn').forEach(btn => {
      const isActive = btn.dataset.preset === name;
      btn.style.background = isActive ? 'var(--accent)' : 'var(--bg-tertiary)';
      btn.style.color      = isActive ? '#111'          : 'var(--text)';
      btn.style.fontWeight = isActive ? '600'           : '';
      btn.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
    });
  }

  // 实时预览（颜色 picker / 滑块触发）
  function preview() {
    apply(readForm());
  }

  async function saveForm() {
    const ok = await UI.showConfirm('保存主题', '将当前配色保存为当前主题？');
    if (!ok) return;
    const cfg = readForm();
    save(cfg);
    apply(cfg);
    UI.showToast('主题已保存', 2000);
  }

  async function resetDefaults() {
    const ok = await UI.showConfirm('恢复默认', '将丢弃所有自定义配色，恢复为「天枢城」默认主题？');
    if (!ok) return;
    const old = load();
    const cfg = Object.assign({}, PRESETS[DEFAULT_PRESET]);
    // 保留字体设置
    cfg.fontMode = old.fontMode || 'default';
    // 保留正文字号（v681.3.2）
    cfg.msgFontSize = old.msgFontSize ?? 13.5;
    withThemeFade(() => {
save(cfg);
apply(cfg);
});
    _syncAllTriggers(cfg);
    document.querySelectorAll('.th-preset-btn').forEach(btn => {
      const isActive = btn.dataset.preset === DEFAULT_PRESET;
      btn.style.background = isActive ? 'var(--accent)' : 'var(--bg-tertiary)';
      btn.style.color      = isActive ? '#111'          : 'var(--text)';
      btn.style.fontWeight = isActive ? '600'           : '';
      btn.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
    });
    UI.showToast('已恢复默认', 2000);
  }

// 字体设置
function setFontMode(mode) {
    const cfg = load();
    cfg.fontMode = mode;
    save(cfg);
    apply(cfg);
    _syncFontUI(cfg);
  }

  // 点"自定义"按钮：展开 3 槽面板（不强制切字体，让用户在面板里上传/选择）
  function openFontPanel() {
    const area = document.getElementById('th-font-upload-area');
    if (!area) return;
    const cfg = load();
    const isCustom = cfg.fontMode === 'custom' || /^custom[123]$/.test(cfg.fontMode);
    // 展开面板（不改 fontMode，真正启用由槽里的「使用」或上传触发）
    area.style.display = 'flex';
    // 若面板已展开且当前就是自定义模式，再点则收起
    if (isCustom && area.dataset.forceOpen === '1') {
      area.style.display = 'none';
      area.dataset.forceOpen = '0';
      return;
    }
    area.dataset.forceOpen = '1';
    _syncFontUI(cfg);
  }

// 正文字号设置（v681.3.1）
function setMsgFontSize(px) {
const n = Number(px);
if (!Number.isFinite(n) || n < 12 || n > 24) return;
const cfg = load();
cfg.msgFontSize = n;
save(cfg);
apply(cfg);
_syncFontSizeUI(cfg);
}

function _syncFontSizeUI(cfg) {
cfg = cfg || load();
const slider = document.getElementById('th-msg-fontsize');
if (slider) slider.value = cfg.msgFontSize || 13.5;
const label = document.getElementById('th-msg-fontsize-val');
if (label) label.textContent = (cfg.msgFontSize || 13.5) + 'px';
}

  function handleFontUpload(input, slot) {
    slot = parseInt(slot, 10) || 1;
    if (slot < 1 || slot > 3) slot = 1;
    const file = input.files[0];
    if (!file) return;
    // 限制 15MB
    if (file.size > 15 * 1024 * 1024) {
      UI.showToast('字体文件不能超过 15MB', 3000);
      input.value = '';
      return;
    }
    UI.showToast('正在加载字体…', 1500);
    const reader = new FileReader();
    reader.onerror = () => {
      UI.showToast('读取字体文件失败', 3000);
    };
    reader.onload = e => {
      const dataUrl = e.target.result;
      const faceName = 'CustomThemeFont' + slot;
      try {
        const fontFace = new FontFace(faceName, 'url("' + dataUrl + '")');
        fontFace.load().then(f => {
          document.fonts.add(f);
          // 字体数据存 IndexedDB（不受 localStorage 配额限制）
          DB.put('settings', { key: 'customFontData_' + slot, value: dataUrl, fileName: file.name }).then(() => {
            const cfg = load();
            cfg.fontMode = 'custom' + slot;
            cfg.customFontData = null; // localStorage 不存字体数据
            save(cfg);
            apply(cfg);
            _syncFontUI(cfg);
            UI.showToast('字体已应用', 2000);
          }).catch(() => {
            UI.showToast('存储字体失败', 3000);
          });
        }).catch(err => {
          UI.showToast('字体加载失败：文件可能损坏', 3000);
        });
      } catch(e) {
        UI.showToast('字体格式不支持', 3000);
      }
    };
    reader.readAsDataURL(file);
  }

  // 选用某个自定义字体槽（该槽已有字体时才切换）
  async function useFontSlot(slot) {
    slot = parseInt(slot, 10) || 1;
    const keys = slot === 1 ? ['customFontData_1', 'customFontData'] : ['customFontData_' + slot];
    let has = false;
    for (const k of keys) {
      try { const rec = await DB.get('settings', k); if (rec && rec.value) { has = true; break; } } catch(_) {}
    }
    if (!has) { UI.showToast('该槽还没有上传字体', 2000); return; }
    const cfg = load();
    cfg.fontMode = 'custom' + slot;
    save(cfg);
    apply(cfg);
    _syncFontUI(cfg);
  }

  // 清空某个自定义字体槽
  async function clearFontSlot(slot) {
    slot = parseInt(slot, 10) || 1;
    try { await DB.del('settings', 'customFontData_' + slot); } catch(_) {}
    if (slot === 1) { try { await DB.del('settings', 'customFontData'); } catch(_) {} }
    const cfg = load();
    // 若当前正用这个槽，退回默认字体
    if (cfg.fontMode === 'custom' + slot || (slot === 1 && cfg.fontMode === 'custom')) {
      cfg.fontMode = 'default';
      save(cfg);
      apply(cfg);
    }
    _syncFontUI(cfg);
    UI.showToast('已清空该字体槽', 1800);
  }

  function _syncFontUI(cfg) {
    cfg = cfg || load();
    const mode = cfg.fontMode || 'default';
    const isCustomMode = mode === 'custom' || /^custom[123]$/.test(mode);
    const btns = document.querySelectorAll('.th-font-btn');
    btns.forEach(btn => {
      const m = btn.dataset.font;
      // "custom" 按钮在任何自定义槽激活时都高亮
      const isActive = (m === 'custom') ? isCustomMode : (m === mode);
      btn.style.background = isActive ? 'var(--accent)' : 'var(--bg-tertiary)';
      btn.style.color = isActive ? '#111' : 'var(--text-secondary)';
      btn.style.fontWeight = isActive ? '600' : '';
      btn.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
    });
    const uploadArea = document.getElementById('th-font-upload-area');
    if (uploadArea) uploadArea.style.display = (isCustomMode || uploadArea.dataset.forceOpen === '1') ? 'flex' : 'none';
    // 当前使用的槽号（旧 'custom' 视作 1）
    const activeSlot = mode === 'custom' ? 1 : (/^custom[123]$/.test(mode) ? parseInt(mode.slice(6), 10) : 0);
    // 逐槽刷新文件名 + 使用中高亮
    for (let slot = 1; slot <= 3; slot++) {
      const row = document.getElementById('th-font-slot-' + slot);
      const nameEl = document.getElementById('th-font-slotname-' + slot);
      const useBtn = document.getElementById('th-font-slotuse-' + slot);
      const keys = slot === 1 ? ['customFontData_1', 'customFontData'] : ['customFontData_' + slot];
      (async () => {
        let rec = null;
        for (const k of keys) {
          try { const r = await DB.get('settings', k); if (r && r.value) { rec = r; break; } } catch(_) {}
        }
        if (nameEl) nameEl.textContent = rec ? (rec.fileName || '已加载字体') : '未上传';
        const isUsing = (activeSlot === slot);
        if (useBtn) {
          useBtn.textContent = isUsing ? '使用中' : (rec ? '使用' : '—');
          useBtn.style.background = isUsing ? 'var(--accent)' : 'var(--bg-tertiary)';
          useBtn.style.color = isUsing ? '#111' : 'var(--text-secondary)';
          useBtn.disabled = !rec;
          useBtn.style.opacity = rec ? '1' : '.5';
        }
        if (row) row.style.borderColor = isUsing ? 'var(--accent)' : 'var(--border)';
      })();
    }
  }

  // 背景图
  async function handleBgImageUpload() {
    const dataUrl = await Utils.promptImageInput({ maxSize: 1200, quality: 0.7 });
    if (!dataUrl) return;
    if (typeof dataUrl === 'string' && dataUrl.length > 1.5 * 1024 * 1024) {
      UI.showToast('图片太大，请选择更小的图片', 3000);
      return;
    }
    const cfg = readForm(); cfg.chatBgImage = dataUrl;
    save(cfg); apply(cfg);
    const preview = document.getElementById('th-bg-image-preview');
    if (preview) { preview.src = dataUrl; preview.style.display = 'block'; }
  }

  function clearBgImage() {
    const cfg = readForm(); cfg.chatBgImage = '';
    save(cfg); apply(cfg);
    const img = document.getElementById('th-bg-image-preview');
    if (img) { img.src = ''; img.style.display = 'none'; }
  }

  // ── 内部工具 ──────────────────────────────────────────────
  function _syncLabel(sliderId) {
    const el    = document.getElementById(sliderId);
    const label = document.getElementById(sliderId + '-lbl');
    if (el && label) label.textContent = parseFloat(el.value).toFixed(2);
  }

  function syncLabel(id) { _syncLabel(id); }

  // 尝试匹配当前 cfg 对应哪个预设名（用于高亮）
  function _matchPreset(cfg) {
    for (const [name, p] of Object.entries(PRESETS)) {
      if (p.bg === cfg.bg && p.accent === cfg.accent && p.bgSecondary === cfg.bgSecondary) return name;
    }
    return '';
  }

  // ── 自定义主题（用户预设）──────────────────────────────────
  const CUSTOM_STORAGE_KEY = 'themeCustomPresets';

  function loadCustomPresets() {
    try { return JSON.parse(localStorage.getItem(CUSTOM_STORAGE_KEY) || '{}'); }
    catch { return {}; }
  }

  function saveCustomPresets(map) {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(map));
  }

  async function saveAsCustom() {
    const name = (document.getElementById('th-custom-name') || {}).value?.trim();
    if (!name) { UI.showToast('请先输入主题名称', 2000); return; }
    const existing = loadCustomPresets();
    if (existing[name]) {
      const ok = await UI.showConfirm('覆盖主题', `已存在名为「${name}」的主题，确定覆盖？`);
      if (!ok) return;
    }
    const cfg = readForm();
    existing[name] = cfg;
    saveCustomPresets(existing);
    renderCustomList();
    UI.showToast(`已保存「${name}」`, 2000);
  }
async function applyCustomPreset(name) {
    const map = loadCustomPresets();
    const cfg = map[name];
    if (!cfg) return;
    const old = load();
    editingCustomName = name;
    cfg.customPresetName = name;
    // 保留字体设置（字体独立于主题，无条件保留当前值）
    cfg.fontMode = old.fontMode || 'default';
    // 保留正文字号（v681.3.2）
    cfg.msgFontSize = old.msgFontSize ?? 13.5;
    const nameInput = document.getElementById('th-custom-name');
if (nameInput) nameInput.value = name;
withThemeFade(() => {
apply(cfg);
save(cfg);
});
_syncAllTriggers(cfg);
// 同步背景图预览
const img = document.getElementById('th-bg-image-preview');
if (img) { img.src = cfg.chatBgImage || ''; img.style.display = cfg.chatBgImage ? 'block' : 'none'; }
document.querySelectorAll('.th-preset-btn').forEach(b => {
b.style.background  = 'var(--bg-tertiary)';
b.style.color       = 'var(--text)';
b.style.fontWeight  = '';
b.style.borderColor = 'var(--border)';
});
renderCustomList();
UI.showToast(`已载入「${name}」，可直接修改名称并保存`, 2500);
}

function activateCustomPreset(name, silent = false) {
     const map = loadCustomPresets();
     const cfg = map[name];
     if (!cfg) return;
     const old = load();
     cfg.customPresetName = name;
    // 保留字体设置（字体独立于主题，无条件保留当前值）
    cfg.fontMode = old.fontMode || 'default';
    // 保留正文字号（v681.3.2）
    cfg.msgFontSize = old.msgFontSize ?? 13.5;
    editingCustomName = null;
const nameInput = document.getElementById('th-custom-name');
 if (nameInput) nameInput.value = name;
 withThemeFade(() => {
 apply(cfg);
 save(cfg);
 });
 _syncAllTriggers(cfg);
 // 换主题后重新渲染当前页面，防止样式混乱
 try { if (typeof Chat !== 'undefined' && Chat.renderAll) Chat.renderAll(); } catch(_) {}
// 同步背景图预览
const img = document.getElementById('th-bg-image-preview');
if (img) { img.src = cfg.chatBgImage || ''; img.style.display = cfg.chatBgImage ? 'block' : 'none'; }
document.querySelectorAll('.th-preset-btn').forEach(b => {
b.style.background  = 'var(--bg-tertiary)';
b.style.color       = 'var(--text)';
b.style.fontWeight  = '';
b.style.borderColor = 'var(--border)';
});
renderCustomList();
if (!silent) UI.showToast(`已切换到「${name}」`, 2000);
}
  async function deleteCustomPreset(name) {
    const ok = await UI.showConfirm('删除主题', `确定删除「${name}」？`);
    if (!ok) return;
    const map = loadCustomPresets();
    delete map[name];
    saveCustomPresets(map);
    renderCustomList();
  }

  function renderCustomList() {
const container = document.getElementById('th-custom-list');
if (!container) return;
const map = loadCustomPresets();
const names = Object.keys(map);
if (!names.length) {
container.innerHTML = '<div style="font-size:12px;color:var(--text-secondary)">暂无自定义主题</div>';
return;
}
const currentName = load().customPresetName || '';
const esc = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
container.innerHTML = names.map(n => {
const en = esc(n);
const isActive = n === currentName;
const isEditing = n === editingCustomName;
return `<div onclick="Theme.activateCustomPreset('${en}');event.stopPropagation()" style="display:flex;align-items:center;gap:4px;padding:8px 10px;background:var(--bg-tertiary);border-radius:8px;margin-bottom:6px;border:1px solid transparent;box-shadow:${isActive ? 'inset 0 0 0 1px var(--accent)' : 'none'};cursor:pointer">
 <span style="flex:1;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${n}</span>
 <button title="${isEditing ? '保存' : '编辑'}" onclick="event.stopPropagation();${isEditing ? `Theme.saveCustomPresetNow('${en}')` : `Theme.applyCustomPreset('${en}')`}" style="padding:6px;border-radius:6px;border:none;background:none;color:var(--text-secondary);cursor:pointer;line-height:0">
${isEditing
? `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`
: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>`}
</button>
<button title="删除" onclick="event.stopPropagation();Theme.deleteCustomPreset('${en}')" style="padding:6px;border-radius:6px;border:none;background:none;color:var(--text-secondary);cursor:pointer;line-height:0">
<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
</button>
</div>`;
}).join('');
}

  // ── 导出导入 ──────────────────────────────────────────────
  function exportCustomThemes() {
    const map = loadCustomPresets();
    const names = Object.keys(map);
    if (!names.length) { UI.showToast('没有自定义主题可导出', 2000); return; }
    const modal = document.getElementById('theme-export-modal');
    const list = document.getElementById('theme-export-list');
    const toggle = document.getElementById('theme-export-toggle-all');
    if (!modal || !list) {
      const json = JSON.stringify(map, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `skynex-theme-${names.length}个.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      UI.showToast(`已导出 ${names.length} 个主题`, 2500);
      return;
    }
    const escHtml = s => String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '"')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    list.innerHTML = names.map((name, i) => {
      const safeId = 'th-export-' + i;
      const safeName = escHtml(name);
      return `<label for="${safeId}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;cursor:pointer">
        <input id="${safeId}" type="checkbox" class="theme-export-check" value="${safeName}" checked onchange="Theme.syncExportToggleState()" style="position:absolute;opacity:0;pointer-events:none">
        <span class="theme-export-check-ui" style="width:20px;height:20px;border-radius:50%;border:2px solid var(--text-secondary);display:flex;align-items:center;justify-content:center;flex:0 0 20px;transition:all 0.15s ease;background:var(--accent);border-color:var(--accent)"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
        <span style="font-size:13px;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeName}</span>
      </label>`;
    }).join('');
    if (toggle) toggle.checked = true;
    syncExportToggleState();
    modal.classList.remove('hidden');
  }

  function closeExportModal() {
    const modal = document.getElementById('theme-export-modal');
    if (modal) modal.classList.add('hidden');
  }
  function _syncExportToggleAllUI() {
    const checkbox = document.getElementById('theme-export-toggle-all');
    const ui = document.getElementById('theme-export-toggle-all-ui');
    if (!checkbox || !ui) return;
    ui.innerHTML = checkbox.checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '';
    ui.style.background = checkbox.checked ? 'var(--accent)' : 'transparent';
    ui.style.borderColor = checkbox.checked ? 'var(--accent)' : 'var(--text-secondary)';
  }

  function syncExportToggleState() {
    const checks = Array.from(document.querySelectorAll('.theme-export-check'));
    const allChecked = checks.length > 0 && checks.every(el => el.checked);
    const toggle = document.getElementById('theme-export-toggle-all');
    if (toggle) toggle.checked = allChecked;
    checks.forEach(el => {
      const ui = el.parentElement ? el.parentElement.querySelector('.theme-export-check-ui') : null;
      if (!ui) return;
      ui.innerHTML = el.checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '';
      ui.style.background = el.checked ? 'var(--accent)' : 'transparent';
      ui.style.borderColor = el.checked ? 'var(--accent)' : 'var(--text-secondary)';
    });
    _syncExportToggleAllUI();
  }

  function toggleExportSelectAll(checked) {
    document.querySelectorAll('.theme-export-check').forEach(el => {
      el.checked = !!checked;
    });
    syncExportToggleState();
  }


  function confirmExportSelectedThemes() {
    const map = loadCustomPresets();
    const checks = Array.from(document.querySelectorAll('.theme-export-check:checked'));
    const names = checks.map(el => el.value).filter(Boolean);
    if (!names.length) { UI.showToast('请先选择要导出的主题', 2000); return; }
    const picked = {};
    names.forEach(name => {
      if (map[name]) picked[name] = map[name];
    });
    const json = JSON.stringify(picked, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `skynex-theme-${names.length}个_${new Date().toLocaleDateString('zh-CN').replace(/\//g,'-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    closeExportModal();
    UI.showToast(`已导出 ${Object.keys(picked).length} 个主题`, 2500);
  }

  async function importCustomThemes() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        if (typeof imported !== 'object' || Array.isArray(imported)) {
          UI.showToast('数据格式不正确', 2000); return;
        }
        const existing = loadCustomPresets();
        const newNames = Object.keys(imported);
        if (!newNames.length) { UI.showToast('没有找到主题数据', 2000); return; }
        const dupes = newNames.filter(n => existing[n]);
        if (dupes.length) {
          const ok = await UI.showConfirm('覆盖主题', `以下主题已存在将被覆盖：\n${dupes.join('、')}`);
          if (!ok) return;
        }
        Object.assign(existing, imported);
        saveCustomPresets(existing);
        renderCustomList();
        UI.showToast(`已导入 ${newNames.length} 个主题`, 2000);
      } catch (e) {
        UI.showToast('导入失败：' + e.message, 3000);
      }
    };
    input.click();
  }

function saveCustomPresetNow(oldName) {
const nameInput = document.getElementById('th-custom-name');
const newName = nameInput ? nameInput.value.trim() : oldName;
if (!newName) { UI.showToast('主题名称不能为空', 2000); return; }
const map = loadCustomPresets();
if (!map[oldName]) { UI.showToast('找不到该主题', 2000); return; }
const doSave = () => {
const cfg = readForm();
cfg.customPresetName = newName;
if (newName !== oldName) delete map[oldName];
map[newName] = cfg;
    saveCustomPresets(map);
    withThemeFade(() => {
    save(cfg);
    apply(cfg);
    });
    editingCustomName = null;
    if (nameInput) nameInput.value = newName;
    const img = document.getElementById('th-bg-image-preview');
if (img) { img.src = cfg.chatBgImage || ''; img.style.display = cfg.chatBgImage ? 'block' : 'none'; }
renderCustomList();
UI.showToast(`已保存并应用「${newName}」`, 2000);
};
if (newName !== oldName && map[newName]) {
UI.showConfirm('名称已存在', `已存在名为「${newName}」的主题，确定覆盖？`).then(ok => {
if (!ok) return;
doSave();
});
return;
}
doSave();
}
  // ── ColorPicker 桥接 ─────────────────────────────────────
  // Theme.openPicker(btnEl, colorFieldId, opacityFieldId?)
  function openPicker(btnEl, colorId, opacityId) {
    const colorInp   = document.getElementById(colorId);
    const opacityInp = opacityId ? document.getElementById(opacityId) : null;
    const initHex    = colorInp  ? (colorInp.value  || '#888888') : '#888888';
    const initAlpha  = opacityInp ? parseFloat(opacityInp.value || '1') : 1;

    ColorPicker.open(btnEl, initHex, initAlpha, (hex, alpha) => {
      if (colorInp)   { colorInp.value = hex; }
      if (opacityInp) { opacityInp.value = alpha; }
      // 更新按钮外观
      _updateTrigger(btnEl, hex, alpha);
      // 实时预览
      apply(readForm());
    });
  }

  function _updateTrigger(btn, hex, alpha) {
    if (!btn) return;
    btn.style.background = hex;
    btn.style.opacity    = alpha !== undefined ? alpha : 1;
  }

  function _syncAllTriggers(cfg) {
    const map = [
      ['th-bg',                cfg.bg,              1],
      ['th-bg-secondary',      cfg.bgSecondary,     cfg.bgSecondaryOpacity    ?? 1],
      ['th-bg-tertiary',       cfg.bgTertiary,      cfg.bgTertiaryOpacity     ?? 1],
      ['th-text',              cfg.text,            cfg.textOpacity           ?? 1],
      ['th-text-secondary',    cfg.textSecondary,   cfg.textSecondaryOpacity  ?? 1],
      ['th-accent',            cfg.accent,          1],
      ['th-decoration',        cfg.decoration,      1],
      ['th-border',            cfg.border,          cfg.borderOpacity         ?? 1],
      ['th-ai-bg',             cfg.aiBubbleBg,      cfg.aiBubbleOpacity],
      ['th-ai-border',         cfg.aiBubbleBorder,  cfg.aiBubbleBorderOpacity],
      ['th-ai-text',           cfg.aiBubbleText  || cfg.text, 1],
      ['th-user-bg',           cfg.userBubbleBg,    cfg.userBubbleOpacity],
      ['th-user-border',       cfg.userBubbleBorder,cfg.userBubbleBorderOpacity],
      ['th-user-text',         cfg.userBubbleText || cfg.text, 1],
      ['th-status-bg',         cfg.statusBarBg   || cfg.bgSecondary, cfg.statusBarBgOpacity   ?? 1],
      ['th-status-card',       cfg.statusBarCard || cfg.bgTertiary,  cfg.statusBarCardOpacity ?? 1],
    ];
    map.forEach(([id, hex, a]) => {
      const inp = document.getElementById(id);
      if (inp) inp.value = hex;
      // 向后找第一个 .cp-trigger（跳过中间的 opacity hidden input）
      let sib = inp ? inp.nextElementSibling : null;
      while (sib && !sib.classList.contains('cp-trigger')) sib = sib.nextElementSibling;
      if (sib) _updateTrigger(sib, hex, a);
    });
    const oi = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    oi('th-bg-secondary-op',   cfg.bgSecondaryOpacity   ?? 1);
    oi('th-bg-tertiary-op',    cfg.bgTertiaryOpacity    ?? 1);
    oi('th-text-op',           cfg.textOpacity          ?? 1);
    oi('th-text-secondary-op', cfg.textSecondaryOpacity ?? 1);
    oi('th-border-op',         cfg.borderOpacity        ?? 1);
    oi('th-ai-opacity',        cfg.aiBubbleOpacity);
    oi('th-ai-border-op',      cfg.aiBubbleBorderOpacity);
    oi('th-user-opacity',      cfg.userBubbleOpacity);
    oi('th-user-border-op',    cfg.userBubbleBorderOpacity);
    oi('th-status-bg-op',      cfg.statusBarBgOpacity   ?? 1);
    oi('th-status-card-op',    cfg.statusBarCardOpacity ?? 1);
    // 文字色 trigger 单独更新（input 后紧跟 cp-trigger）
    const updTxt = (id, hex) => {
      const inp = document.getElementById(id);
      if (!inp) return;
      const btn = inp.nextElementSibling;
      if (btn && btn.classList.contains('cp-trigger')) _updateTrigger(btn, hex, 1);
    };
    updTxt('th-ai-text',   cfg.aiBubbleText  || cfg.text);
    updTxt('th-user-text', cfg.userBubbleText || cfg.text);
  }

  function toggleGlass() {
const cfg = load();
cfg.glassEnabled = !cfg.glassEnabled;
// 开毛玻璃时自动退出省电模式，否则省电模式的全局规则会把 backdrop-filter 全禁掉，造成“开了但没效果”
if (cfg.glassEnabled) {
  try { localStorage.setItem(LITE_KEY, '0'); } catch(_) {}
  applyLiteMode(false);
}
save(cfg);
apply(cfg);
const btn = document.getElementById('th-glass-toggle');
if (btn) btn.checked = !!cfg.glassEnabled;
}

// ===== 省电模式 =====
// 关闭所有 backdrop-filter / 入场动画 / 阴影，安卓低端机 / 华为浏览器卡顿时打开
const LITE_KEY = 'tianshu_lite_mode';
function isLiteMode() {
try { return localStorage.getItem(LITE_KEY) === '1'; } catch(_) { return false; }
}
function applyLiteMode(on) {
document.body.classList.toggle('lite-mode', !!on);
}
function toggleLite() {
const next = !isLiteMode();
try { localStorage.setItem(LITE_KEY, next ? '1' : '0'); } catch(_) {}
applyLiteMode(next);
const btn = document.getElementById('th-lite-toggle');
if (btn) btn.checked = next;
}

function toggleAiBubbleRender() {
  const cfg = load();
  cfg.aiBubbleRender = !cfg.aiBubbleRender;
  save(cfg);
  const btn = document.getElementById('th-ai-render-toggle');
  if (btn) btn.checked = !!cfg.aiBubbleRender;
  // 重新渲染聊天区
  if (typeof Chat !== 'undefined' && Chat.renderAll) Chat.renderAll();
}

  function isAiBubbleRenderEnabled() {
    return load().aiBubbleRender !== false;
  }

  async function applyToAllWorldviews() {
    const ok = await UI.showConfirm('全局应用主题', '将当前主题绑定至所有世界观（含无世界观），确定？');
    if (!ok) return;
    const cfg = load();
    let themeName = '';
    if (cfg.customPresetName) {
      themeName = `custom:${cfg.customPresetName}`;
    } else {
      // 读取当前表单的实际颜色，和预设对比
      const formCfg = readForm();
      const presetNames = Object.keys(PRESETS);
      for (const n of presetNames) {
        const p = PRESETS[n];
        if (p.bg === formCfg.bg && p.accent === formCfg.accent && p.text === formCfg.text) {
          themeName = `builtin:${n}`;
          break;
        }
      }
      if (!themeName) {
        // 表单颜色和存储的也不一样 → 用户调过色没保存
        const savedMatch = presetNames.some(n => {
          const p = PRESETS[n];
          return p.bg === cfg.bg && p.accent === cfg.accent && p.text === cfg.text;
        });
        if (savedMatch) {
          // 存储里是某个预设，但表单被改过了
          UI.showToast('当前调色未保存，请先保存主题再全局应用', 2500);
          return;
        }
        UI.showToast('请先保存为自定义主题再全局应用', 2000);
        return;
      }
    }
    // 遍历所有世界观写 themeName
    if (typeof Worldview !== 'undefined' && Worldview.getWorldviewList) {
      const list = await Worldview.getWorldviewList();
      for (const entry of list) {
        if (entry.id === '__default_wv__') continue;
        const w = await DB.get('worldviews', entry.id);
        if (w) {
          w.themeName = themeName;
          await DB.put('worldviews', w);
        }
      }
      // 无世界观也写入
      let defaultWv = await DB.get('worldviews', '__default_wv__');
      if (!defaultWv) {
        defaultWv = { id: '__default_wv__', name: '无世界观', description: '未挂世界观的对话', icon: '∅', iconImage: '' };
      }
      defaultWv.themeName = themeName;
      await DB.put('worldviews', defaultWv);
    }
    // 存全局绑定标记（新建世界观时继承）
    await DB.put('gameState', { key: 'globalThemeBinding', value: themeName });
    // 如果当前处于无世界观，立刻应用
    if (typeof Worldview !== 'undefined' && Worldview.getCurrentId) {
      const curId = Worldview.getCurrentId();
      if (!curId || curId === '__default_wv__') {
        // 直接应用主题
        if (themeName.startsWith('builtin:')) {
          const name = themeName.slice(8);
          const p = PRESETS[name];
          if (p) { const c = Object.assign({}, p); c.customPresetName = ''; c.fontMode = cfg.fontMode || 'default'; c.msgFontSize = cfg.msgFontSize ?? 13.5; save(c); apply(c); }
        } else if (themeName.startsWith('custom:')) {
          activateCustomPreset(themeName.slice(7), true);
        }
      }
    }
    UI.showToast('已应用至所有世界观', 2000);
  }

  return {
    init,
    populateForm: (cfg) => {
      cfg = cfg || load();
      _syncAllTriggers(cfg);
      renderCustomList();
      // 同步毛玻璃开关
    const glassBtn = document.getElementById('th-glass-toggle');
    if (glassBtn) glassBtn.checked = !!cfg.glassEnabled;
    // 同步AI气泡渲染开关
    const aiRenderBtn = document.getElementById('th-ai-render-toggle');
    if (aiRenderBtn) aiRenderBtn.checked = (cfg.aiBubbleRender !== false);
      // 同步字体UI
      _syncFontUI(cfg);
      // 同步字号UI（v681.3）
      _syncFontSizeUI(cfg);
      // 标记当前激活的预设
      document.querySelectorAll('.th-preset-btn').forEach(btn => {
        const p = PRESETS[btn.dataset.preset];
        const isActive = !!(p && p.bg === cfg.bg && p.accent === cfg.accent && p.text === cfg.text);
        btn.style.background  = isActive ? 'var(--accent)' : 'var(--bg-tertiary)';
        btn.style.color       = isActive ? '#111'          : 'var(--text)';
        btn.style.fontWeight  = isActive ? '600'           : '';
        btn.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
      });
    },
    preview, saveForm, resetDefaults,
    applyPreset, handleBgImageUpload, clearBgImage, syncLabel,
    openPicker, toggleGlass, toggleAiBubbleRender, isAiBubbleRenderEnabled,
toggleLite, isLiteMode, applyLiteMode,
    setFontMode, handleFontUpload, useFontSlot, clearFontSlot, openFontPanel,
setMsgFontSize,
    syncGlassPadding: () => _syncGlassPadding(load().glassEnabled),
    saveAsCustom, applyCustomPreset, activateCustomPreset, deleteCustomPreset, renderCustomList,
    saveCustomPresetNow,
    exportCustomThemes, importCustomThemes, closeExportModal, toggleExportSelectAll, syncExportToggleState, confirmExportSelectedThemes,
    setConvBgOverride,
    getPresetNames: () => Object.keys(PRESETS),
    getPreset: (name) => PRESETS[name] ? Object.assign({}, PRESETS[name]) : null,
    load,
    save,
    apply,
    applyToAllWorldviews,
  };
})();
