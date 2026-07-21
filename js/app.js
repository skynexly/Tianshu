/**
 * 应用入口 — 每步独立try/catch防止连锁崩溃
 */
(async function App() {
  // 首先应用主题（同步，避免闪屏）
  try { Theme.init(); } catch(e) { console.error('[Theme]', e); }
  // 初始化手势锁状态
  try { UI.initLockBackGestureToggle(); } catch(e) { console.error('[UI] 初始化手势锁失败', e); }
  // 初始化数据库
  try { await DB.openWithRetry(); } catch(e) { console.error('[DB]', e); alert('数据库初始化失败: ' + e.message); return; }

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
      // 状态栏皮肤恢复统一在 Worldview.restoreCurrentWorldview() 里处理
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
  // v632：老隐藏世界观迁移为 lorebook
  try {
    if (typeof Lorebook !== 'undefined' && Lorebook.migrateHiddenWorldviewsOnce) {
      await Lorebook.migrateHiddenWorldviewsOnce();
    }
  } catch(e) { console.error('[Lorebook.migrate]', e); }
  // 世界观
  try { await Worldview.init(); } catch(e) { console.error('[Worldview.init]', e); }
    // 恢复当前世界观选择（必须在 Conversations.init 之前）
    try { await Worldview.restoreCurrentWorldview(); } catch(e) { console.error('[Worldview.restore]', e); }

    // 设置（多API预设）— 必须在 Conversations.init 之前，因为对话迁移需要 getCurrentId
    try { await Settings.init(); } catch(e) { console.error('[Settings.init]', e); }

    // 多对话管理
    try { await Conversations.init(); } catch(e) { console.error('[Conversations]', e); }

    // 迁移前全量快照：只要有任一迁移待跑，就先把当前对话数据整体备份一份（7天自动清）。
    // 必须在所有迁移/自愈动手之前——捕捉最原始状态，翻车了能一键还原。
    try {
      const _migFlags = ['migrate_merge_split_npc_v1', 'migrate_merge_split_relation_v1', 'recover_orphan_conversations_v1', 'cleanup_recovered_backstage_v1'];
      let _hasPending = false;
      for (const fk of _migFlags) {
        try { const f = await DB.get('gameState', fk); if (!f || !f.value) { _hasPending = true; break; } } catch(_) { _hasPending = true; break; }
      }
      if (Conversations.backupBeforeMigration) {
        await Conversations.backupBeforeMigration(_hasPending);
      }
    } catch(e) { console.error('[Conversations.backup]', e); }

    // 对话自愈：从 messages 表反推重建丢失的对话（修复 v706.1 对话丢失事故）
    // 必须在合并迁移之前——先把对话找回来，迁移才能在完整数据上跑。
    try {
      if (Conversations.recoverOrphanConversations) {
        await Conversations.recoverOrphanConversations();
      }
    } catch(e) { console.error('[Conversations.recover]', e); }

    // 一次性清理：移除早期恢复逻辑误捞的后台频道假对话（只删外壳，不碰后台聊天记录）
    try {
      if (Conversations.cleanupRecoveredBackstage) {
        await Conversations.cleanupRecoveredBackstage();
      }
    } catch(e) { console.error('[Conversations.cleanupBackstage]', e); }

    // 一次性 migration：合并因本名/代号分裂产生的重复身份数据
    // 【必须在 Conversations.init 之后】——迁移会遍历并 saveList 对话列表，
    // 早于 init 执行会拿到空 list 并把它写回，覆盖真实对话数据（v706.1 曾因此翻车）。
    try {
      if (typeof Phone !== 'undefined' && Phone.migrateMergeSplitNpcIdentities) {
        await Phone.migrateMergeSplitNpcIdentities();
      }
    } catch(e) { console.error('[Phone.mergeSplitNpc]', e); }
    try {
      if (typeof Memory !== 'undefined' && Memory.migrateMergeSplitRelations) {
        await Memory.migrateMergeSplitRelations();
      }
    } catch(e) { console.error('[Memory.mergeSplitRelation]', e); }

    // 面具
  try { await Character.init(); } catch(e) { console.error('[Character.init]', e); }

  // 按当前对话绑定的面具同步 activeAvatar（init 读的是全局 currentMask，可能和当前对话不一致）
  // 用 forceSetMask 而非 switchMask：启动恢复不该被 streaming/心动开场/教程 那几个「仅拦用户手动切换」的 guard 拦掉，
  // 否则会偶发命中 guard 提前 return，面具停在全局值 → 表现为刷新后对话面具变默认。
  try {
    const _curConv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const _convMaskId = _curConv?.maskId || _curConv?.branchMaskId;
    if (_convMaskId) await Character.forceSetMask(_convMaskId);
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

  // 后台悬浮球：刷新/启动时按当前对话是否开启后台恢复显示（切对话时由 conversations 调，这里补启动一次）
  try { if (typeof Backstage !== 'undefined' && Backstage.updateFab) Backstage.updateFab(); } catch(e) { console.error('[Backstage.updateFab]', e); }
  // 手机悬浮球：刷新/启动时按当前条件恢复显示（有世界观+未锁机+聊天页），实现常驻
  try { if (typeof Phone !== 'undefined' && Phone.syncFab) Phone.syncFab(); } catch(e) { console.error('[Phone.syncFab]', e); }

  // 长按菜单
  try { Chat.initLongPress(); } catch(e) { console.error('[LongPress]', e); }

  // 快速切换栏
  try { await Chat.renderQuickSwitches(); } catch(e) { console.error('[QuickSwitch]', e); }

  // v687.37：iOS PWA 锁屏恢复后面具同步
  // iOS Safari 会在锁屏/切后台时杀 PWA 进程，恢复时页面完全重载走 init；
  // 但某些情况下 JS 上下文保留但内存变量丢失（soft kill），此时走 visibilitychange 恢复
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
      const expectedMaskId = conv?.maskId || conv?.branchMaskId;
      if (expectedMaskId && expectedMaskId !== Character.getCurrentId()) {
        console.log('[App] visibilitychange: 面具漂移修复', Character.getCurrentId(), '->', expectedMaskId);
        await Character.switchMask(expectedMaskId, false);
      }
    } catch(e) { console.warn('[App] visibilitychange mask sync failed', e); }
  });

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

  // 新手引导
  try { await Tutorial.init(); } catch(e) { console.error('[Tutorial.init]', e); }

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

  // ===== 更新公告（登录成功后弹出，可拿到昵称）=====
  try {
    const APP_VERSION = 'v719';
    const CHANGELOG = `○新增正则作用时机：选择「仅显示」后，正则只影响显示效果、不再替换原文
○新增自定义状态栏：可选四种组件，在世界观玩法内设置
○自定义状态栏组件现已接入状态栏美化，可直接修改 CSS
○优化状态栏美化助手输出逻辑，支持 CSS 局部增删改
○新增可自定义 CSS 的「新获得物品」卡片、相关角色标签、引用块`;
    // 历史公告（最新在前），版本变旧后手动把上一版内容挪进来
    const CHANGELOG_HISTORY = [
      { version: 'v718', notes: `○新增删除好友机制，继续主线后被删除的角色可能会申请重新添加
○新增粉丝群/付费入群功能，可绑定阅读、视频中的作品或直播间
○新增手机对话可单独设置背景
○新增私聊对话中，角色可能会将悬而未决的事项添加进对话级事件中，以便线下继续处理
○新增搜索联系人/对话、置顶对话、删除对话
○新增提示词可选择作用域（主线/后台/手机聊天）
○新增论坛热搜词条内刷新按钮
○部分UI优化` },
      { version: 'v717', notes: `○新增GitHub云端备份，大存档分片上传
○地图APP升级，新增评论、打分、预定、出行字段，新增附近地图功能
○世界观编辑→手机配置可以自定义地图APP设定
○字体上传支持20MB＋
○新增手机数据恢复备份
○调整部分UI适配` },
      { version: 'v716', notes: `○优化部分UI和交互
○修复一些BUG
○增加手机私聊的引用功能
○新增世界观编辑手机配置，为商城选择固定货币
○新增番外可挂世界书，可在收藏中续写
○新增手机数据可单独导出导入
○新增手机主题配色可调整透明度` },
      { version: 'v715', notes: `○调整了部分回溯逻辑
○部分交互优化
○新增论坛热搜榜
○新增开播时关闭打赏选项
○修复群像模式无法读取世界书的BUG
○新增地区背景图，添加后将在对话时根据地区切换对话背景` },
      { version: 'v714', notes: `○优化手动生图，可总结场景并勾选生图描述
○部分生图逻辑优化
○新增观看直播马甲，主播私联时也只能联系正在使用的马甲
○新增后台全屏模式
○新增手机全局美化，配色/壁纸/头像/签名等可全局共享，配色支持导入导出
○修复部分BUG
○新增心动模拟可手动修改黑化值` },
      { version: 'v713.3', notes: `○修复部分BUG、调整部分UI
○增加按钮，可以取消角色主动挂断电话（手机聊天设置内）
○新增通话时可在括号内描写动作
○增加了用户气泡的继续剧情按钮
○新增正则测试功能
○增加了提示词批量全选按钮` },
    ];
    const SEEN_KEY = 'changelog_seen_version';

    function _showChangelog(opts) {
      const force = !!(opts && opts.force);
      if (!force) {
        try {
          const lastSeen = localStorage.getItem(SEEN_KEY);
          if (lastSeen === APP_VERSION) return;
        } catch(_) {}
      }
      const delay = force ? 0 : 800;
      setTimeout(() => {
        // 已经存在就不重复弹
        if (document.getElementById('changelog-overlay')) return;
        let nickname = '';
        try {
          if (typeof Auth !== 'undefined' && Auth.getNickname) nickname = Auth.getNickname() || '';
        } catch(_) {}
        const safeName = String(nickname).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'"',"'":'&#39;' }[c]));
        const greeting = safeName ? `欢迎回来，${safeName}` : '欢迎回来';
        const titleText = force ? '更新公告' : greeting;

        // 生成历史公告折叠栏（第一条默认展开）
        const historyHtml = CHANGELOG_HISTORY.map((h, i) => {
          const open = i === 0;
          const safeNotes = String(h.notes || '').replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
          return `<div class="changelog-hist-item" style="background:var(--bg-tertiary);border:none;border-radius:10px;overflow:hidden">
            <button type="button" class="changelog-hist-head" data-idx="${i}" style="width:100%;padding:11px 14px;border:none;background:none;color:var(--text);font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;font-family:inherit">
              <span>${h.version}</span>
              <span class="changelog-hist-arrow" style="font-size:12px;color:var(--text-secondary);transition:transform .2s;transform:rotate(${open ? 90 : 0}deg)">›</span>
            </button>
            <div class="changelog-hist-body" style="white-space:pre-line;padding:${open ? '0 14px 12px' : '0 14px'};max-height:${open ? '400px' : '0'};overflow:hidden;transition:max-height .25s ease,padding .25s ease;color:var(--text-secondary);font-size:12px;line-height:1.9">${safeNotes}</div>
          </div>`;
        }).join('');

        const overlay = document.createElement('div');
        overlay.id = 'changelog-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:24px;animation:sbFadeIn .25s ease-out';
        overlay.innerHTML = `
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:22px 22px 18px;max-width:340px;width:100%;color:var(--text);font-size:13px;line-height:1.8;box-shadow:0 10px 28px rgba(0,0,0,0.22)">
            <div style="font-size:16px;font-weight:650;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;gap:8px">
              <span>${titleText}</span><span style="font-size:11px;color:var(--text-secondary);font-weight:400;border:1px solid var(--border);border-radius:999px;padding:1px 8px;line-height:1.6">${APP_VERSION}</span>
            </div>
            <div id="changelog-main-view">
            <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;letter-spacing:0.5px">本次更新</div>
            <div style="height:1px;background:var(--border);opacity:.7;margin:0 0 14px"></div>
            <div style="white-space:pre-line;margin-bottom:18px;color:var(--text-secondary);font-size:12px;line-height:1.9">${CHANGELOG}</div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px">
              <div id="changelog-goto-profile" style="background:var(--bg-tertiary);border:none;border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:10px;font-size:12px;line-height:1.6;color:var(--text-secondary);cursor:pointer">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                <span style="flex:1;min-width:0">请及时存档，以免数据丢失</span>
                <span style="font-size:14px;color:var(--text-secondary);flex-shrink:0;line-height:1">›</span>
              </div>
              <div style="background:var(--bg-tertiary);border:none;border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:10px;font-size:12px;line-height:1.6;color:var(--text-secondary)">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                <div style="flex:1;min-width:0;display:flex;align-items:center;justify-content:space-between;gap:8px">
                  <span style="flex:1;min-width:0">skynex 交流群 <strong style="color:var(--text);font-weight:650;font-size:13px;letter-spacing:0.3px">739657680</strong></span>
                  <button id="changelog-copy-group" type="button" title="复制群号" style="flex-shrink:0;width:24px;height:24px;padding:0;border:none;background:none;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                </div>
              </div>
            </div>
            </div>
            <div id="changelog-history-view" style="display:none">
              <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;letter-spacing:0.5px">历史公告</div>
              <div style="height:1px;background:var(--border);opacity:.7;margin:0 0 14px"></div>
              <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px">${historyHtml}</div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <button id="changelog-history-toggle" type="button" style="padding:6px 4px;border:none;background:none;color:var(--text-secondary);font-size:12px;cursor:pointer;line-height:1.5;display:flex;align-items:center;gap:2px">查看历史公告<span style="font-size:14px;line-height:1">›</span></button>
              <button id="changelog-ok" style="padding:8px 24px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">${force ? '关闭' : '已阅'}</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        // 历史公告：切换主视图 / 历史视图
        (function bindHistory(){
          const mainView = overlay.querySelector('#changelog-main-view');
          const histView = overlay.querySelector('#changelog-history-view');
          const toggleBtn = overlay.querySelector('#changelog-history-toggle');
          if (!mainView || !histView || !toggleBtn) return;
          let showingHist = false;
          const applyView = () => {
            mainView.style.display = showingHist ? 'none' : '';
            histView.style.display = showingHist ? '' : 'none';
            toggleBtn.innerHTML = showingHist
              ? '<span style="font-size:14px;line-height:1">‹</span>返回本次更新'
              : '查看历史公告<span style="font-size:14px;line-height:1">›</span>';
          };
          toggleBtn.onclick = (e) => {
            try { e.stopPropagation(); } catch(_) {}
            showingHist = !showingHist;
            applyView();
          };
          // 折叠栏展开/收起
          histView.querySelectorAll('.changelog-hist-head').forEach(head => {
            head.onclick = (e) => {
              try { e.stopPropagation(); } catch(_) {}
              const item = head.closest('.changelog-hist-item');
              const body = item && item.querySelector('.changelog-hist-body');
              const arrow = head.querySelector('.changelog-hist-arrow');
              if (!body) return;
              const isOpen = body.style.maxHeight && body.style.maxHeight !== '0px';
              if (isOpen) {
                body.style.maxHeight = '0';
                body.style.padding = '0 14px';
                if (arrow) arrow.style.transform = 'rotate(0deg)';
              } else {
                body.style.maxHeight = '400px';
                body.style.padding = '0 14px 12px';
                if (arrow) arrow.style.transform = 'rotate(90deg)';
              }
            };
          });
        })();
        // 点存档提示卡 → 关公告 + 跳个人主页（存档入口）
        const gotoProfileCard = overlay.querySelector('#changelog-goto-profile');
        if (gotoProfileCard) {
          gotoProfileCard.onclick = (e) => {
            try { e.stopPropagation(); } catch(_) {}
            try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch(_) {}
            overlay.style.opacity = '0';
            overlay.style.transition = 'opacity .2s';
            setTimeout(() => {
              overlay.remove();
              try {
                if (typeof Auth !== 'undefined' && Auth.openProfile) Auth.openProfile();
              } catch(_) {}
            }, 200);
          };
        }
        const copyGroupBtn = overlay.querySelector('#changelog-copy-group');
        if (copyGroupBtn) {
          copyGroupBtn.onclick = async (e) => {
            try { e.stopPropagation(); } catch(_) {}
            const groupNo = '739657680';
            let ok = false;
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(groupNo);
                ok = true;
              }
            } catch(_) {}
            if (!ok) {
              try {
                const ta = document.createElement('textarea');
                ta.value = groupNo;
                ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                ok = document.execCommand && document.execCommand('copy');
                ta.remove();
              } catch(_) {}
            }
            try { if (typeof UI !== 'undefined' && UI.showToast) UI.showToast(ok ? '群号已复制' : '复制失败，请手动复制群号', 1600); } catch(_) {}
          };
        }
        overlay.querySelector('#changelog-ok').onclick = () => {
          try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch(_) {}
          overlay.style.opacity = '0';
          overlay.style.transition = 'opacity .2s';
          setTimeout(() => overlay.remove(), 200);
        };
        // 点遮罩也关
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) overlay.querySelector('#changelog-ok').click();
        });
      }, delay);
    }

    // 监听登录成功事件（缓存登录 / 表单登录都会触发）
    window.addEventListener('auth:ready', _showChangelog, { once: true });
    // 暴露手动调用接口（右上角菜单按钮用）
    window.App = window.App || {};
    window.App.showChangelogManually = function() { _showChangelog({ force: true }); };
  } catch(_) {}
})();