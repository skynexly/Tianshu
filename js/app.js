/**
 * 应用入口 — 每步独立try/catch防止连锁崩溃
 */
(async function App() {
  // 首先应用主题（同步，避免闪屏）
  try { Theme.init(); } catch(e) { console.error('[Theme]', e); }
  // 初始化数据库
  try { await DB.open(); } catch(e) { console.error('[DB]', e); alert('数据库初始化失败: ' + e.message); return; }

  // 世界观：确保worldviewPrompt被正确设置
  try {
    // 先从当前世界观ID读DB
    const savedWvId = await DB.get('gameState', 'currentWorldviewId');
    const wvId = savedWvId?.value;
    if (wvId && wvId !== '__default_wv__') {
      const wvData = await DB.get('worldviews', wvId);
      if (wvData && wvData.setting) {
        Chat.setWorldview(wvData.setting);
        console.log('[App] 直接从DB设置worldview, 长度:', wvData.setting.length);
      }
    }
  } catch(e) { console.error('[App.worldview]', e); }

  // 内置世界观自动加载（增量）
  try {
    await Worldview.loadBuiltinWorldviews();
  } catch(e) { console.error('[Worldview.builtin]', e); }
  // 一次性 migration：天枢城 NPC name/aliases 交换
  try {
    if (Worldview.migrateTianshuchengNpcNames) {
      await Worldview.migrateTianshuchengNpcNames();
    }
  } catch(e) { console.error('[Worldview.migrate]', e); }
  // 世界观
  try { await Worldview.init(); } catch(e) { console.error('[Worldview.init]', e); }
    // 恢复当前世界观选择（必须在 Conversations.init 之前）
    try { await Worldview.restoreCurrentWorldview(); } catch(e) { console.error('[Worldview.restore]', e); }

    // 设置（多API预设）— 必须在 Conversations.init 之前，因为对话迁移需要 getCurrentId
    try { await Settings.init(); } catch(e) { console.error('[Settings.init]', e); }

    // 多对话管理
    try { await Conversations.init(); } catch(e) { console.error('[Conversations]', e); }

    // 面具
  try { await Character.init(); } catch(e) { console.error('[Character.init]', e); }

  // 按当前对话绑定的面具同步 activeAvatar（init 读的是全局 currentMask，可能和当前对话不一致）
  try {
    const _curConv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const _convMaskId = _curConv?.maskId || _curConv?.branchMaskId;
    if (_convMaskId) await Character.switchMask(_convMaskId, false);
  } catch(e) { console.warn('[App] 初始化面具同步失败', e); }
// 番外
try { await Gaiden.init(); } catch(e) { console.error('[Gaiden.init]', e); }

  // 加载设置UI
  try { await Settings.load(); } catch(e) { console.error('[Settings]', e); }

  // 角色卡
  try { await Character.load(); } catch(e) { console.error('[Character.load]', e); }

  // 对话历史
  try { await Chat.loadHistory(Conversations.getCurrent()); } catch(e) { console.error('[Chat.loadHistory]', e); }

  // 总结convId初始化
  try { Summary.setConvId(Conversations.getCurrent()); } catch(e) { console.error('[Summary]', e); }

  // 长按菜单
  try { Chat.initLongPress(); } catch(e) { console.error('[LongPress]', e); }

  // 快速切换栏
  try { await Chat.renderQuickSwitches(); } catch(e) { console.error('[QuickSwitch]', e); }

  // 输入框高度自适应
  try {
    const input = document.getElementById('chat-input');
    if (input) {
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      });
    }

    const resizeTextarea = (el) => {
      if (!el) return;
      el.style.height = 'auto';
      const maxHeight = parseInt(window.getComputedStyle(el).maxHeight, 10) || 220;
      el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
      el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    };

    document.querySelectorAll('.auto-resize-textarea').forEach(el => {
      resizeTextarea(el);
      el.addEventListener('input', () => resizeTextarea(el));
    });
  } catch(e) { console.error('[Input]', e); }

  // 发送按钮初始化
  try {
    const sendBtn = document.getElementById('btn-send');
    if (sendBtn) {
      setTimeout(() => {
        sendBtn.onclick = Chat.send;
      }, 100);
    }
  } catch(e) { console.error('[SendButton]', e); }

  // 新手引导（暂时停用：文案跟不上当前版本，等重写后再恢复）
  // try { await Tutorial.init(); } catch(e) { console.error('[Tutorial.init]', e); }

  // 全局禁止文字选中（华为浏览器对 CSS user-select 不完全尊重，用 JS 兜底）
  // 白名单：仅 input / textarea / contenteditable 元素及其后代允许选中
  try {
    const isSelectableTarget = (el) => {
      if (!el || el.nodeType !== 1) return false;
      return !!el.closest('input, textarea, [contenteditable="true"], [contenteditable=""]');
    };
    document.addEventListener('selectstart', (e) => {
      if (!isSelectableTarget(e.target)) e.preventDefault();
    }, true);
    // 兜底：即使 selectstart 漏过，也立刻清掉非白名单元素的选区
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const node = sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      if (!isSelectableTarget(el)) {
        try { sel.removeAllRanges(); } catch(_) {}
      }
    });
    // 禁止长按图片弹出原生菜单（华为浏览器对 CSS -webkit-touch-callout:none 不完全尊重）
    document.addEventListener('contextmenu', (e) => {
      // 白名单：input/textarea 允许原生右键菜单
      if (isSelectableTarget(e.target)) return;
      e.preventDefault();
    }, true);
  } catch(e) { console.error('[NoSelect]', e); }

  // 移除开屏 splash（主题+DB+UI 全部就绪后才消失，避免用户看到毛坯房）
  try {
    const splash = document.getElementById('splash-screen');
    if (splash) {
      splash.style.opacity = '0';
      setTimeout(() => splash.remove(), 800);
    }
  } catch(_) {}

  console.log('[TextGame Engine] 初始化完成');
  GameLog.log('info', '引擎初始化完成');

  // ===== 更新公告 =====
  try {
    const APP_VERSION = 'v445';
    const CHANGELOG = `· 性能与稳定性优化
· 心动模拟相关内容更新
· 世界观切换体验调整
· 部分开场动画体验调整`;
    const SEEN_KEY = 'changelog_seen_version';
    const lastSeen = localStorage.getItem(SEEN_KEY);
    if (lastSeen !== APP_VERSION) {
      // 延迟弹出，等 splash 消失
      setTimeout(() => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:24px;animation:sbFadeIn .25s ease-out';
        overlay.innerHTML = `
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:22px 22px 18px;max-width:340px;width:100%;color:var(--text);font-size:13px;line-height:1.8;box-shadow:0 10px 28px rgba(0,0,0,0.22)">
            <div style="font-size:16px;font-weight:650;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;gap:8px">
              <span>更新公告</span><span style="font-size:11px;color:var(--text-secondary);font-weight:400;border:1px solid var(--border);border-radius:999px;padding:1px 8px;line-height:1.6">${APP_VERSION}</span>
            </div>
            <div style="height:1px;background:var(--border);opacity:.7;margin:12px 0 14px"></div>
            <div style="white-space:pre-line;margin-bottom:18px;color:var(--text-secondary);font-size:12px;line-height:1.9">${CHANGELOG}</div>
            <div style="display:flex;justify-content:flex-end">
              <button id="changelog-ok" style="padding:8px 24px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">已阅</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#changelog-ok').onclick = () => {
          localStorage.setItem(SEEN_KEY, APP_VERSION);
          overlay.style.opacity = '0';
          overlay.style.transition = 'opacity .2s';
          setTimeout(() => overlay.remove(), 200);
        };
        // 点遮罩也关
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) overlay.querySelector('#changelog-ok').click();
        });
      }, 1200);
    }
  } catch(_) {}
})();