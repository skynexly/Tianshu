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
      fontMode: "default",
      customFontData: null,
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
      bg:                    '#f5f5f0',
      bgSecondary:           '#ebebeb',
      bgTertiary:            '#dcdcdc',
      text:                  '#1a1a1a',
      textSecondary:         '#666666',
      accent:                '#5a7fa0',
      decoration:            '#8b5a8b',
      border:                '#cccccc',
      aiBubbleBg:            '#e8eef5',
      aiBubbleOpacity:       1,
      aiBubbleBorder:        '#c0ccd8',
      aiBubbleBorderOpacity: 1,
      aiBubbleText:          '#1a1a1a',
      userBubbleBg:          '#e8f0e8',
      userBubbleOpacity:     1,
      userBubbleBorder:      '#c0d0c0',
      userBubbleBorderOpacity: 1,
      userBubbleText:        '#1a1a1a',
      chatBgImage:           '',
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
    s.setProperty('--bg',           cfg.bg);
    s.setProperty('--bg-secondary', toRgba(cfg.bgSecondary, cfg.bgSecondaryOpacity ?? 1));
    s.setProperty('--bg-glass',     cfg.glassEnabled ? toRgba(cfg.bgSecondary, Math.min(cfg.bgSecondaryOpacity ?? 1, 0.7)) : toRgba(cfg.bgSecondary, cfg.bgSecondaryOpacity ?? 1));
    s.setProperty('--bg-glass-inner', cfg.glassEnabled ? toRgba(cfg.bgSecondary, Math.min(cfg.bgSecondaryOpacity ?? 1, 0.35)) : toRgba(cfg.bgSecondary, cfg.bgSecondaryOpacity ?? 1));
    s.setProperty('--bg-tertiary',  toRgba(cfg.bgTertiary,  cfg.bgTertiaryOpacity  ?? 1));

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
    if (cfg.fontMode === 'custom') {
      DB.get('settings', 'customFontData').then(rec => {
        if (rec && rec.value) {
          try {
            const fontFace = new FontFace('CustomThemeFont', 'url("' + rec.value + '")');
            fontFace.load().then(f => {
              document.fonts.add(f);
              s.setProperty('--font-family', '"CustomThemeFont", sans-serif');
            }).catch(() => {});
          } catch(e) {}
        }
      }).catch(() => {});
    } else {
      s.removeProperty('--font-family');
    }
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
    const app = document.getElementById('app');
    if (!app) { fn(); return; }
    if (_themeSwitchTimer) clearTimeout(_themeSwitchTimer);
    app.style.transition = 'opacity 0.24s ease, transform 0.24s ease';
    app.style.opacity = '0.68';
    app.style.transform = 'translateY(-4px)';
    _themeSwitchTimer = setTimeout(() => {
      fn();
      requestAnimationFrame(() => {
        app.style.opacity = '1';
        app.style.transform = 'translateY(0)';
      });
      _themeSwitchTimer = null;
    }, 120);
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
    withThemeFade(() => {
save(cfg);
apply(cfg);
});
_syncAllTriggers(cfg);
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

  function handleFontUpload(input) {
    const file = input.files[0];
    if (!file) return;
    // 限制 5MB
    if (file.size > 5 * 1024 * 1024) {
      UI.showToast('字体文件不能超过 5MB', 3000);
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
      try {
        const fontFace = new FontFace('CustomThemeFont', 'url("' + dataUrl + '")');
        fontFace.load().then(f => {
          document.fonts.add(f);
          // 字体数据存 IndexedDB（不受 5MB 限制）
          DB.put('settings', { key: 'customFontData', value: dataUrl }).then(() => {
            const cfg = load();
            cfg.fontMode = 'custom';
            cfg.customFontData = null; // localStorage 不存字体数据
            save(cfg);
            apply(cfg);
            _syncFontUI(cfg);
            const nameEl = document.getElementById('th-font-filename');
            if (nameEl) nameEl.textContent = file.name;
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

  function _syncFontUI(cfg) {
    cfg = cfg || load();
    const btns = document.querySelectorAll('.th-font-btn');
    btns.forEach(btn => {
      const m = btn.dataset.font;
      const isActive = m === (cfg.fontMode || 'default');
      btn.style.background = isActive ? 'var(--accent)' : 'var(--bg-tertiary)';
      btn.style.color = isActive ? '#111' : 'var(--text-secondary)';
      btn.style.fontWeight = isActive ? '600' : '';
      btn.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
    });
    const uploadArea = document.getElementById('th-font-upload-area');
    if (uploadArea) uploadArea.style.display = cfg.fontMode === 'custom' ? 'flex' : 'none';
    const nameEl = document.getElementById('th-font-filename');
    if (nameEl) {
      if (cfg.fontMode === 'custom') {
        DB.get('settings', 'customFontData').then(rec => {
          nameEl.textContent = (rec && rec.value) ? '已加载自定义字体' : '未选择文件';
        }).catch(() => { nameEl.textContent = '未选择文件'; });
      } else {
        nameEl.textContent = '未选择文件';
      }
    }
  }

  // 背景图
  function handleBgImageUpload(input) {
    const file = input.files[0];
    if (!file) return;
    // 压缩到 max 1200px 宽/高，JPEG 0.7
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1200;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          const scale = MAX / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        // 检查压缩后大小（base64 长度 ≈ 实际字节 × 4/3）
        if (dataUrl.length > 1.5 * 1024 * 1024) {
          UI.showToast('图片太大，请选择更小的图片', 3000);
          return;
        }
        const cfg = readForm(); cfg.chatBgImage = dataUrl;
        save(cfg); apply(cfg);
        const preview = document.getElementById('th-bg-image-preview');
        if (preview) { preview.src = dataUrl; preview.style.display = 'block'; }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
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
    // 保留字体设置
    if (!cfg.fontMode) cfg.fontMode = old.fontMode || 'default';
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
    // 保留字体设置
    if (!cfg.fontMode) cfg.fontMode = old.fontMode || 'default';
    editingCustomName = null;
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
      a.download = `天枢城主题_${names.length}个.json`;
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
    list.innerHTML = names.map(name => {
      const safeId = 'th-export-' + name.replace(/[^a-zA-Z0-9_-]/g, '_');
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
    a.download = `天枢城主题_${names.length}个_${new Date().toLocaleDateString('zh-CN').replace(/\//g,'-')}.json`;
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
    setFontMode, handleFontUpload,
    syncGlassPadding: () => _syncGlassPadding(load().glassEnabled),
    saveAsCustom, applyCustomPreset, activateCustomPreset, deleteCustomPreset, renderCustomList,
    saveCustomPresetNow,
    exportCustomThemes, importCustomThemes, closeExportModal, toggleExportSelectAll, syncExportToggleState, confirmExportSelectedThemes,
    setConvBgOverride,
getPresetNames: () => Object.keys(PRESETS),
  };
})();
