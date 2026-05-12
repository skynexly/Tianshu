/**
 * UI控制
 */
const UI = (() => {
  let overlay = null;
  let _maskEditFrom = null; // 面具编辑页的来源面板

  async function toggleTopMenu() {
     const menu = document.getElementById('top-dropdown-menu');
     if (!menu) return;
     const wasHidden = menu.classList.contains('hidden');
 
     if (!wasHidden) {
       // 关闭
       menu.classList.add('closing');
       await new Promise(r => setTimeout(r, 120));
       menu.classList.remove('closing');
       menu.classList.add('hidden');
     } else {
       // 打开
       menu.classList.remove('closing', 'hidden');
     }
   }
 
   async function toggleTokenPopup() {
     const popup = document.getElementById('token-popup');
     if (!popup) return;
     const wasHidden = popup.classList.contains('hidden');
 
     if (!wasHidden) {
       // 关闭
       popup.classList.add('closing');
       await new Promise(r => setTimeout(r, 120));
       popup.classList.remove('closing');
       popup.classList.add('hidden');
     } else {
       // 打开
       popup.classList.remove('closing', 'hidden');
     }
   }
 
   async function toggleNewMenu() {
    const menu = document.getElementById('new-menu');
    if (!menu) return;
    const wasHidden = menu.classList.contains('hidden');

    if (!wasHidden) {
      menu.classList.add('closing');
      await new Promise(r => setTimeout(r, 120));
      menu.classList.remove('closing');
      menu.classList.add('hidden');
    } else {
      // 仅在无世界观下显示「绑定主题」项
      try {
        const activeWv = (typeof Worldview !== 'undefined' && Worldview.getCurrentId) ? Worldview.getCurrentId() : null;
        const showDefaultTheme = !activeWv || activeWv === '__default_wv__';
        const themeBtn = document.getElementById('new-menu-default-theme');
        const themeSep = document.getElementById('new-menu-default-theme-sep');
        if (themeBtn) themeBtn.style.display = showDefaultTheme ? 'flex' : 'none';
        if (themeSep) themeSep.style.display = showDefaultTheme ? 'block' : 'none';
      } catch(_) {}
      menu.classList.remove('closing', 'hidden');
    }
  }
 
   // 清除手势留下的 inline style，让 CSS class 接管
  function _clearSidebarInline() {
    const sidebar = document.getElementById('sidebar');
    sidebar.style.transform = '';
    sidebar.style.transition = '';
  }

  function _ensureOverlay() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      overlay.onclick = () => toggleSidebar();
    }
    overlay.style.opacity = '';
    overlay.style.transition = '';
    return overlay;
  }

  function _removeOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const willOpen = sidebar.classList.contains('hidden');

    // 清除手势残留
    sidebar.style.transition = '';

    if (willOpen) {
      // 先用 inline style 固定在关闭位置
      sidebar.style.transform = 'translateX(-100%)';
      sidebar.classList.remove('hidden');
      // 强制浏览器渲染这一帧（起始位置）
      sidebar.offsetHeight;
      // 移除 inline transform，CSS 的 translateX(0) 接管，触发过渡动画
      sidebar.style.transform = '';
      _ensureOverlay();
      document.getElementById('app').appendChild(overlay);
    } else {
      // 先用 inline transform 触发滑出动画
      sidebar.style.transform = 'translateX(-100%)';
      // 遮罩淡出
      if (overlay) {
        overlay.style.transition = 'opacity 0.25s ease';
        overlay.style.opacity = '0';
      }
      // 等动画结束后再真正隐藏
      setTimeout(() => {
        sidebar.classList.add('hidden');
        sidebar.style.transform = '';
        _removeOverlay();
        if (overlay) {
          overlay.style.opacity = '';
          overlay.style.transition = '';
        }
      }, 250);
    }
  }

  // 侧边栏手势滑动
  (function initSidebarSwipe() {
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let isDragging = false;
    let isOpen = false;
    let gestureActive = false;
    let gestureType = ''; // 'sidebar' | 'back'
    let directionLocked = false;
    const sidebarWidth = 260;
    const threshold = 50;

    function _isChatPanel() {
      const chatPanel = document.getElementById('panel-chat');
      return chatPanel && chatPanel.classList.contains('active');
    }

    // 检测是否有弹窗/模态框打开
    function _hasOpenPopup() {
      // 模态框
      const modals = document.querySelectorAll('.modal:not(.hidden)');
      if (modals.length > 0) return true;
      // 全局搜索页
      const gsPage = document.getElementById('global-search-page');
      if (gsPage && !gsPage.classList.contains('hidden')) return false;
      // 右上角菜单
      const topMenu = document.getElementById('top-menu');
      if (topMenu && !topMenu.classList.contains('hidden')) return true;
      // token弹窗
      const tokenPop = document.getElementById('token-popup');
      if (tokenPop && !tokenPop.classList.contains('hidden')) return true;
      // 加号菜单
      const plusMenu = document.getElementById('plus-menu');
      if (plusMenu && !plusMenu.classList.contains('hidden')) return true;
      // 长按菜单
      const ctxMenu = document.querySelector('.context-menu:not(.hidden)');
      if (ctxMenu) return true;
      // 管理模式底栏（面具/记忆/世界观）
      for (const barId of ['mask-manage-bar', 'memory-manage-bar', 'worldview-manage-bar-fixed']) {
        const bar = document.getElementById(barId);
        if (bar && !bar.classList.contains('hidden')) return true;
      }
      return false;
    }

    // 获取当前活动面板的返回动作
    function _getBackAction() {
      const gsPage = document.getElementById('global-search-page');
      if (gsPage && !gsPage.classList.contains('hidden')) {
        return () => closeGlobalSearch();
      }

      const active = document.querySelector('.panel.active');
      if (!active) return null;
      const id = active.id;

      switch (id) {
        case 'panel-chat': return null; // 聊天面板不走返回
        case 'panel-worldview': return () => showPanel('chat', 'back');
        case 'panel-worldview-edit': return () => {
          // v596：检查是否从单人卡跳进来
          const rt = (typeof Worldview !== 'undefined' && Worldview.getEditReturnTo) ? Worldview.getEditReturnTo() : null;
          if (rt === 'single-card-edit') {
            if (Worldview.clearEditReturnTo) Worldview.clearEditReturnTo();
            // 让 single_card 自己恢复编辑状态
            if (typeof SingleCard !== 'undefined' && SingleCard.restoreEditPanel) {
              SingleCard.restoreEditPanel();
            } else {
              showPanel('single-card-edit', 'back');
            }
          } else {
            showPanel('worldview', 'back');
          }
        };
        case 'panel-wv-region': return () => showPanel('worldview-edit', 'back');
        case 'panel-wv-faction': return () => showPanel('wv-region', 'back');
        case 'panel-wv-npc': return () => {
        if (typeof Worldview !== 'undefined' && Worldview.backFromNpcEdit) {
          Worldview.backFromNpcEdit();
        } else {
          showPanel('wv-faction', 'back');
        }
      };
        case 'panel-wv-viewer': return () => showPanel('worldview', 'back');
        case 'panel-character': return () => showPanel('chat', 'back');
        case 'panel-single-card-edit': return () => {
          showPanel('worldview', 'back');
          if (typeof Worldview !== 'undefined' && Worldview.switchWorldTab) {
            Worldview.switchWorldTab('char');
          }
        };
        case 'panel-mask-edit': return () => showPanel(_maskEditFrom || 'character', 'back');
        case 'panel-memory': return () => showPanel('chat', 'back');
    case 'panel-gaiden': return () => showPanel('chat', 'back');
        case 'panel-memory-edit': return () => showPanel('memory', 'back');
        case 'panel-summary': return () => showPanel('chat', 'back');
        case 'panel-settings': return () => handleSettingsBack();
        default: return () => showPanel('chat', 'back');
      }
    }

    document.addEventListener('touchstart', (e) => {
      const sidebar = document.getElementById('sidebar');
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      currentX = startX;
      isDragging = false;
      gestureActive = false;
      gestureType = '';
      directionLocked = false;
isOpen = !sidebar.classList.contains('hidden');
 // 状态栏展开时屏蔽全局侧边栏/返回滑动手势，避免横向小卡误触发
 const statusOverlay = document.getElementById('sb-expanded-overlay');
 if (statusOverlay && !statusOverlay.classList.contains('hidden')) {
 directionLocked = true;
 gestureActive = false;
 return;
 }
 //代码块内滑动不触发手势
      if (e.target.closest('pre, code, .code-block')) {
        directionLocked = true;
        gestureActive = false;
      }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      const sidebar = document.getElementById('sidebar');
      currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const deltaX = currentX - startX;
      const deltaY = currentY - startY;

      // 死区
      if (!directionLocked && Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10) return;

      if (!directionLocked) {
        directionLocked = true;
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          gestureActive = false;
          return;
        }

        // 有弹窗时屏蔽所有滑动手势
 const statusOverlay = document.getElementById('sb-expanded-overlay');
 if ((statusOverlay && !statusOverlay.classList.contains('hidden')) || _hasOpenPopup()) {
 gestureActive = false;
 return;
 }

        isDragging = true;
        const inChat = _isChatPanel();

        if (deltaX > 0 && !isOpen) {
          // 右滑
          if (inChat) {
            gestureType = 'sidebar';
            gestureActive = true;
            sidebar.classList.remove('hidden');
            sidebar.style.transition = 'none';
            sidebar.style.transform = `translateX(-${sidebarWidth}px)`;
          } else {
            // 非聊天界面：返回上级
            const action = _getBackAction();
            if (action) {
              gestureType = 'back';
              gestureActive = true;
            } else {
              gestureActive = false;
              return;
            }
          }
        } else if (deltaX < 0 && isOpen && inChat) {
          gestureType = 'sidebar';
          gestureActive = true;
        } else {
          gestureActive = false;
          return;
        }
      }
      if (!gestureActive) return;

      if (gestureType === 'sidebar') {
        e.preventDefault();
        sidebar.style.transition = 'none';

        if (!isOpen) {
          const offset = Math.min(Math.max(deltaX - sidebarWidth, -sidebarWidth), 0);
          sidebar.style.transform = `translateX(${offset}px)`;
          const progress = (sidebarWidth + offset) / sidebarWidth;

          _ensureOverlay();
          overlay.style.transition = 'none';
          overlay.style.opacity = String(progress * 0.4);
          if (!overlay.parentNode) document.getElementById('app').appendChild(overlay);
        } else {
          const offset = Math.min(Math.max(deltaX, -sidebarWidth), 0);
          sidebar.style.transform = `translateX(${offset}px)`;
          const progress = (sidebarWidth + offset) / sidebarWidth;

          if (overlay) {
            overlay.style.transition = 'none';
            overlay.style.opacity = String(progress * 0.4);
          }
        }
      }
    }, { passive: false });

    document.addEventListener('touchend', () => {
      if (!gestureActive) { isDragging = false; return; }
      isDragging = false;
      gestureActive = false;

      const deltaX = currentX - startX;
      const absDelta = Math.abs(deltaX);

      if (gestureType === 'back') {
        if (deltaX > threshold) {
          const action = _getBackAction();
          if (action) action();
        }
        gestureType = '';
        return;
      }

      // sidebar 手势
      const sidebar = document.getElementById('sidebar');
      const curve = !isOpen
        ? 'transform 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94)'
        : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
      sidebar.style.transition = curve;
      if (overlay) overlay.style.transition = 'opacity 0.3s ease';

      const shouldComplete = absDelta > threshold;

      if (!isOpen && shouldComplete) {
        sidebar.style.transform = 'translateX(0)';
        sidebar.classList.remove('hidden');
        _ensureOverlay();
        overlay.style.opacity = '0.4';
        if (!overlay.parentNode) document.getElementById('app').appendChild(overlay);
        setTimeout(_clearSidebarInline, 350);
      } else if (isOpen && shouldComplete) {
        sidebar.style.transform = `translateX(-${sidebarWidth}px)`;
        if (overlay) overlay.style.opacity = '0';
        setTimeout(() => {
          sidebar.classList.add('hidden');
          _clearSidebarInline();
          _removeOverlay();
        }, 300);
      } else {
        if (!isOpen) {
          sidebar.style.transform = `translateX(-${sidebarWidth}px)`;
          if (overlay) overlay.style.opacity = '0';
          setTimeout(() => { sidebar.classList.add('hidden'); _clearSidebarInline(); _removeOverlay(); }, 300);
        } else {
          sidebar.style.transform = 'translateX(0)';
          if (overlay) overlay.style.opacity = '0.4';
          setTimeout(_clearSidebarInline, 350);
        }
      }
      gestureType = '';
    });
  })();

  function switchWorldviewTab(tab) {
    document.querySelectorAll('#panel-worldview .tab-btn').forEach(btn => btn.classList.remove('active'));
    const btn = document.querySelector(`#panel-worldview .tab-btn[onclick*="${tab}"]`);
    if (btn) btn.classList.add('active');
    
    document.querySelectorAll('.wv-tab').forEach(t => t.classList.add('hidden'));
    document.getElementById(`wv-tab-${tab}`).classList.remove('hidden');

    if (tab === 'npc') NPC.renderNPCList();
    if (tab === 'factions') NPC.renderFactionList();
  }

  async function showPanel(name, direction = 'forward') {
    // 提示词注入已搬入设置面板
    if (name === 'prompts') { showPanel('settings'); switchSettingsTab('st-prompts'); return; }

    // 如果已经在该面板，直接返回
    const currentPanel = document.querySelector('.panel.active');
    if (currentPanel && currentPanel.id === `panel-${name}`) return;

    // 旧面板退出动画
    if (currentPanel) {
      const exitClass = direction === 'back' ? 'anim-exit-back' : 'anim-exit-forward';
      currentPanel.classList.add(exitClass);
      await new Promise(r => setTimeout(r, 200));
      currentPanel.classList.remove('active', exitClass);
    }

    // 切换到新面板
    const enterClass = direction === 'back' ? 'anim-enter-back' : 'anim-enter-forward';
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active', 'anim-enter-forward', 'anim-enter-back'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const panel = document.getElementById(`panel-${name}`);
    if (panel) {
      panel.classList.add('active', enterClass);
      panel.addEventListener('animationend', () => {
        panel.classList.remove(enterClass);
      }, { once: true });
    }
    const nav = document.querySelector(`.nav-item[data-panel="${name}"]`);
    if (nav) nav.classList.add('active');

    // 顶栏显示/隐藏
    const chatTopbar = document.getElementById('chat-topbar');
    if (chatTopbar) {
      chatTopbar.style.display = (name === 'chat') ? '' : 'none';
    }

    // 切回聊天面板时，重新同步毛玻璃底部 padding
    if (name === 'chat' && typeof Theme !== 'undefined' && Theme.syncGlassPadding) {
      Theme.syncGlassPadding();
    }

    // 聊天面板：显示 token 和下拉菜单
const topbarActions = document.querySelector('.topbar-actions');
if (topbarActions) topbarActions.style.display = (name === 'chat') ? '' : 'none';

// 非聊天面板隐藏返回底部按钮
const scrollBtn = document.getElementById('scroll-to-bottom-btn');
if (scrollBtn && name !== 'chat') scrollBtn.classList.add('hidden');

// 手机浮动按钮：非聊天面板时隐藏
const phoneFab = document.getElementById('phone-fab');
if (phoneFab && name !== 'chat') {
  phoneFab.classList.add('hidden');
}

    if (name === 'memory' || name === 'memory-edit') { Memory.onPanelShow(); if (typeof Memory.exitManageMode === 'function') Memory.exitManageMode(); }
    if (name === 'summary') {
      const cid = Conversations.getCurrent();
      Summary.setConvId(cid);
      const data = await Summary.get(cid);
      Summary.renderSummaryView(data, cid, 'summary-content');
    }
    if (name === 'character') { Character.load(); if (typeof Character.exitManageMode === 'function') Character.exitManageMode(); }
    if (name === 'gaiden') { await Gaiden.ensureLoaded(); Gaiden.renderList(); }
    if (name === 'worldview') { await Worldview.load(); }
    if (name === 'settings') { Settings.load(); Prompts.render(); }
  }

  // 从侧边栏按钮点击时使用
  function showPanelAndCloseSidebar(name) {
    showPanel(name);
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('hidden')) {
      toggleSidebar();
    }
  }

  // ===== 设置分栏切换 =====

  function switchSettingsTab(tabId) {
    // 隐藏卡片概览，显示内容区域
    const overview = document.getElementById('settings-overview');
    const contentArea = document.getElementById('settings-content-area');
    if (overview) overview.style.display = 'none';
    if (contentArea) contentArea.style.display = 'block';

    // 显示对应的 tab 内容
    document.querySelectorAll('.settings-tab-content').forEach(el => {
      el.style.display = el.id === tabId ? '' : 'none';
    });
  }

  function showSettingsOverview() {
// 显示卡片概览，隐藏内容区域
const overview = document.getElementById('settings-overview');
const contentArea = document.getElementById('settings-content-area');
if (overview) {
  overview.style.display = 'flex';
  overview.style.animation = 'none';
  void overview.offsetHeight;
  overview.style.animation = 'tabContentFadeIn 0.28s ease';
}
if (contentArea) contentArea.style.display = 'none';
}

  function handleSettingsBack() {
    const overview = document.getElementById('settings-overview');
    const contentArea = document.getElementById('settings-content-area');

    // 退出所有设置相关的管理模式
    if (typeof Settings.exitPresetManageMode === 'function') Settings.exitPresetManageMode();
    if (typeof Settings.exitRegexManageMode === 'function') Settings.exitRegexManageMode();
    ['summary', 'memory', 'vision'].forEach(t => {
      if (Settings.toggleFuncManageMode && document.getElementById(`func-${t}-manage-bar`) && !document.getElementById(`func-${t}-manage-bar`).classList.contains('hidden')) {
        Settings.toggleFuncManageMode(t);
      }
    });
    if (typeof Prompts.exitPromptManageMode === 'function') Prompts.exitPromptManageMode();

    // 如果在子页面，返回概览
    if (contentArea && getComputedStyle(contentArea).display !== 'none') {
      showSettingsOverview();
    }
    // 如果在概览，退出到聊天
    else {
      showPanel('chat', 'back');
    }
  }

  function switchDebugTab(tabId) {
    // 切 Tab 按钮高亮（只在 edit-modal 内部查找）
    const modal = document.getElementById('edit-modal');
    if (!modal) return;
    modal.querySelectorAll('.settings-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
      btn.style.borderBottomColor = btn.dataset.tab === tabId ? 'var(--accent)' : 'transparent';
      btn.style.color = btn.dataset.tab === tabId ? 'var(--accent)' : 'var(--text-secondary)';
    });
    // 切内容（只在 edit-modal 内部查找）
    modal.querySelectorAll('.settings-tab-content').forEach(el => {
      if (el.id === tabId) {
        // debug-log 需要 flex 布局
        el.style.display = el.id === 'debug-log' ? 'flex' : '';
      } else {
        el.style.display = 'none';
      }
    });
    // 切到调试日志 Tab 时自动刷新日志
    if (tabId === 'debug-log' && typeof GameLog !== 'undefined' && GameLog.render) {
      GameLog.render();
    }
  }

  function showDebugLog() {
    // 打开模态框
    const modal = document.getElementById('edit-modal');
    modal.classList.remove('hidden');
    modal.dataset.editId = '__debug__';
    // 切换到日志Tab
    switchDebugTab('debug-log');
    // 刷新日志
    if (typeof GameLog !== 'undefined' && GameLog.render) {
      GameLog.render();
    }
  }

  function showBranchModal() {
    Branch.renderTree();
    document.getElementById('branch-modal').classList.remove('hidden');
  }

  async function closeBranchModal() {
    const modal = document.getElementById('branch-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
  }

  async function closeEditModal() {
    const modal = document.getElementById('edit-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
  }

  async function closeMsgEditModal() {
    const modal = document.getElementById('msg-edit-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
  }

// ===== 底部弹出菜单 =====

  async function closeAllPopups() {
    const popups = document.querySelectorAll('.popup-menu:not(#new-menu)');
    popups.forEach(p => p.classList.add('closing'));
    await new Promise(r => setTimeout(r, 120));
    popups.forEach(p => {
      p.classList.remove('closing');
      p.classList.add('hidden');
    });
    try { Chat.renderQuickSwitches(); } catch(e) {}
  }

  async function togglePopup(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const wasHidden = el.classList.contains('hidden');
    await closeAllPopups();
    document.getElementById('plus-menu')?.classList.add('hidden');
    if (!wasHidden) return;

    // 先移除可能的 closing 类，避免残留
    el.classList.remove('closing');

    // 填充内容
    if (id === 'api-popup') {
      const presets = Settings._getPresets();
      const cur = Settings.getCurrentId();
      el.innerHTML = presets.map(p => `
        <button class="${p.id === cur ? 'active' : ''}" style="display:flex;align-items:center;justify-content:space-between" onclick="Settings.switchPreset('${p.id}');UI.closeAllPopups()">
          <span>${Utils.escapeHtml(p.name)}
          <span style="font-size:11px;color:var(--text-secondary);margin-left:4px">${Utils.escapeHtml(p.model || '')}</span></span>
          ${p.id === cur ? `<span onclick="event.stopPropagation();UI.closeAllPopups();Settings.editPreset('${p.id}')" style="cursor:pointer;opacity:0.6;padding:2px 4px;line-height:0;flex-shrink:0" title="编辑预设"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></span>` : ''}
        </button>`).join('');
    } else if (id === 'mask-popup') {
      const maskData = await DB.get('gameState', 'maskList');
      const allMasks = maskData?.value || [{ id: 'default', name: '默认面具' }];
      const cur = Character.getCurrentId();

      // 过滤：只显示通用 + 当前对话所属世界观的面具（与底栏快速切换栏一致）
      let curWvId = '';
      try {
        const convId = Conversations.getCurrent && Conversations.getCurrent();
        if (convId) {
          const conv = Conversations.getList().find(c => c.id === convId);
          curWvId = conv?.worldviewId || conv?.singleWorldviewId || conv?.singleCharSourceWvId || '';
        }
      } catch(_) {}
      // 收集仍存在的世界观 id 集合，wvId 失效的面具归通用
      const validWvIds = new Set();
      try {
        const allWvs = await DB.getAll('worldviews');
        allWvs.forEach(w => { if (w && w.id) validWvIds.add(w.id); });
      } catch(_) {}

      let masks = allMasks.filter(m => {
        // 默认面具永远视为通用
        if (m.id === 'default') return true;
        const wid = m.worldviewId || '';
        if (!wid) return true;                     // 通用
        if (!validWvIds.has(wid)) return true;     // 失效→视作通用
        if (!curWvId) return !wid;                 // 没当前世界观→只通用
        return wid === curWvId;
      });

      // 边界：当前面具不在可见列表里（属于其他世界观），把它强行加到开头
      if (cur && !masks.some(m => m.id === cur)) {
        const curMask = allMasks.find(m => m.id === cur);
        if (curMask) masks = [{ ...curMask, _foreign: true }, ...masks];
      }

      const editSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>`;
      // 并发取头像
      const items = await Promise.all(masks.map(async m => {
        const data = await DB.get('characters', m.id);
        return { ...m, avatar: data?.avatar || '' };
      }));
      el.innerHTML = items.map(m => {
        const avatarHtml = m.avatar
          ? `<div style="width:24px;height:24px;border-radius:50%;background:var(--bg-secondary) url(${m.avatar}) center/cover;border:1px solid var(--border);flex-shrink:0"></div>`
          : `<div style="width:24px;height:24px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;flex-shrink:0"><span style="font-size:14px;color:rgba(255,255,255,0.85);line-height:1">✦</span></div>`;
        const foreignMark = m._foreign ? '<span style="opacity:0.6;margin-right:2px" title="非当前世界观面具">✻</span>' : '';
        return `
        <button class="${m.id === cur ? 'active' : ''}" style="display:flex;align-items:center;justify-content:space-between;gap:8px" onclick="Character.switchMask('${m.id}');UI.closeAllPopups()">
          <span style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">${avatarHtml}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${foreignMark}${Utils.escapeHtml(m.name)}</span></span>
          ${m.id === cur ? `<span onclick="event.stopPropagation();UI.closeAllPopups();UI.setMaskEditFrom('chat');Character.openEdit('${m.id}')" style="cursor:pointer;opacity:0.6;padding:2px 4px;line-height:0;flex-shrink:0" title="编辑面具">${editSvg}</span>` : ''}
        </button>`;
      }).join('');
    } else if (id === 'quick-switch') {
      Chat.renderQuickSwitches();
    }
    el.classList.remove('hidden');
  }

  function closeSwitchSheet() {
    document.getElementById('switch-sheet-overlay')?.classList.add('hidden');
    document.getElementById('switch-sheet')?.classList.add('hidden');
    try { Chat.renderQuickSwitches(); } catch(e) {}
  }

  async function openChatSummary() {
    const panel = document.getElementById('chat-summary-panel');
    if (!panel) return;
    const cid = Conversations.getCurrent();
    Summary.setConvId(cid);
    const data = await Summary.get(cid);
    Summary.renderSummaryView(data, cid, 'chat-summary-content');
    panel.classList.remove('hidden');
  }

  async function toggleChatSummary() {
    // v604：从弹窗改为走全屏 panel（渲染由 showPanel('summary') 内统一处理）
    showPanel('summary');
  }

  function showCopyText(title, value) {
    return new Promise((resolve) => {
      const modal = document.getElementById('copy-text-modal');
      const titleEl = document.getElementById('copy-text-title');
      const valueEl = document.getElementById('copy-text-value');
      const confirmBtn = document.getElementById('copy-text-confirm');
      const cancelBtn = document.getElementById('copy-text-cancel');

      titleEl.textContent = title || '复制内容';
      valueEl.value = value || '';
      modal.classList.remove('hidden');
      setTimeout(() => {
        valueEl.focus();
        valueEl.select();
      }, 0);

      const cleanup = async () => {
        modal.classList.add('closing');
        const content = modal.querySelector('.modal-content');
        if (content) content.classList.add('closing');
        await new Promise(r => setTimeout(r, 150));
        modal.classList.remove('closing');
        if (content) content.classList.remove('closing');
        modal.classList.add('hidden');
        confirmBtn.onclick = null;
        cancelBtn.onclick = null;
      };

      confirmBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(valueEl.value);
          await cleanup();
          resolve(true);
        } catch (e) {
          valueEl.focus();
          valueEl.select();
          resolve(false);
        }
      };

      cancelBtn.onclick = async () => {
        await cleanup();
        resolve(false);
      };
    });
  }

  // ===== 简单输入框 =====

  function showSimpleInput(title, defaultValue) {
    return new Promise((resolve) => {
      const modal = document.getElementById('simple-input-modal');
      const titleEl = document.getElementById('simple-input-title');
      const inputEl = document.getElementById('simple-input-field');
      const confirmBtn = document.getElementById('simple-input-confirm');
      const cancelBtn = document.getElementById('simple-input-cancel');

      titleEl.textContent = title;
      inputEl.value = defaultValue || '';
      inputEl.dataset.resolve = '';

      // 确保弹窗挂在 body 最顶层，不被任何 transform/will-change 父级夹住
      if (modal.parentNode !== document.body) {
        document.body.appendChild(modal);
      }
      modal.classList.remove('hidden');
      inputEl.focus();

      const cleanup = async () => {
        modal.classList.add('closing');
        const content = modal.querySelector('.modal-content');
        if (content) content.classList.add('closing');
        await new Promise(r => setTimeout(r, 150));
        modal.classList.remove('closing');
        if (content) content.classList.remove('closing');
        modal.classList.add('hidden');
        confirmBtn.onclick = null;
        cancelBtn.onclick = null;
        inputEl.onkeydown = null;
      };

      confirmBtn.onclick = () => {
        const value = inputEl.value.trim();
        cleanup();
        resolve(value || null);
      };

      cancelBtn.onclick = () => {
        cleanup();
        resolve(null);
      };

      inputEl.onkeydown = (e) => {
        if (e.key === 'Enter') {
          confirmBtn.click();
        } else if (e.key === 'Escape') {
          cancelBtn.click();
        }
      };
    });
  }

  async function closeSimpleInput() {
    const modal = document.getElementById('simple-input-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
  }

  async function confirmSimpleInput() {
    const inputEl = document.getElementById('simple-input-field');
    const value = inputEl.value.trim();
    const modal = document.getElementById('simple-input-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
    // 通过触发自定义事件来传递结果
    window.dispatchEvent(new CustomEvent('simple-input-confirm', { detail: value }));
  }

  // ===== 确认弹窗 =====

  function showConfirm(title, message) {
    return new Promise((resolve) => {
      const modal = document.getElementById('confirm-modal');
      const titleEl = document.getElementById('confirm-title');
      const msgEl = document.getElementById('confirm-message');
      const okBtn = document.getElementById('confirm-ok');
      const cancelBtn = document.getElementById('confirm-cancel');

      titleEl.textContent = title || '确认';
msgEl.textContent = message || '确定要继续吗？';
// 确认弹窗必须挂到 body 最顶层，避免被虚拟手机/transform 父级压住
if (modal.parentNode !== document.body) {
document.body.appendChild(modal);
}
modal.style.setProperty('z-index', '99999', 'important');
modal.querySelector('.modal-content')?.style.setProperty('z-index', '100000', 'important');
modal.querySelector('.modal-content')?.style.setProperty('position', 'relative');
modal.classList.remove('hidden');

      const cleanup = async () => {
        modal.classList.add('closing');
        const content = modal.querySelector('.modal-content');
        if (content) content.classList.add('closing');
        await new Promise(r => setTimeout(r, 150));
        modal.classList.remove('closing');
        if (content) content.classList.remove('closing');
        modal.classList.add('hidden');
        okBtn.onclick = null;
        cancelBtn.onclick = null;
      };

      okBtn.onclick = () => {
        cleanup();
        resolve(true);
      };

      cancelBtn.onclick = () => {
        cleanup();
        resolve(false);
      };
    });
  }

  // ===== 提示弹窗 =====

  function showAlert(title, message) {
    return new Promise((resolve) => {
      const modal = document.getElementById('alert-modal');
      const titleEl = document.getElementById('alert-title');
      const msgEl = document.getElementById('alert-message');
      const okBtn = document.getElementById('alert-ok');

      titleEl.textContent = title || '提示';
      msgEl.textContent = message || '';
      modal.style.zIndex = '930';
      modal.querySelector('.modal-content')?.style.setProperty('z-index', '931', 'important');
      modal.querySelector('.modal-content')?.style.setProperty('position', 'relative');
      modal.classList.remove('hidden');

      const cleanup = async () => {
        modal.classList.add('closing');
        const content = modal.querySelector('.modal-content');
        if (content) content.classList.add('closing');
        await new Promise(r => setTimeout(r, 150));
        modal.classList.remove('closing');
        if (content) content.classList.remove('closing');
        modal.classList.add('hidden');
        okBtn.onclick = null;
      };

      okBtn.onclick = () => {
        cleanup();
        resolve();
      };
    });
  }

  // ===== 全局聊天搜索 =====

  let _gsTimer = null;

  function openGlobalSearch() {
    const page = document.getElementById('global-search-page');
    const input = document.getElementById('global-search-input');
    input.value = '';
    document.getElementById('global-search-results').innerHTML =
      '<div class="gs-empty">输入关键词搜索所有对话</div>';
    // 关闭侧边栏
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('hidden')) toggleSidebar();
    // 滑入
    page.classList.remove('hidden', 'slide-out');
    requestAnimationFrame(() => {
      page.style.pointerEvents = '';
      page.classList.add('visible');
      setTimeout(() => input.focus(), 250);
    });
  }

  async function closeGlobalSearch() {
    const page = document.getElementById('global-search-page');
    page.classList.remove('visible');
    page.classList.add('slide-out');
    page.style.pointerEvents = 'none';
    await new Promise(r => setTimeout(r, 260));
    page.classList.add('hidden');
    page.classList.remove('slide-out');
  }

  function _globalSearchDebounced(query) {
    clearTimeout(_gsTimer);
    _gsTimer = setTimeout(() => _globalSearch(query), 250);
  }

  async function _globalSearch(query) {
    const container = document.getElementById('global-search-results');
    const q = query.trim().toLowerCase();
    if (!q) {
      container.innerHTML = '<div class="gs-empty">输入关键词搜索所有对话</div>';
      return;
    }

    // 搜索所有消息
    const allMsgs = await DB.getAll('messages');
    const hits = allMsgs.filter(m =>
      m.content && m.content.toLowerCase().includes(q) && !m.hidden
    );

    if (hits.length === 0) {
      container.innerHTML = '<div class="gs-empty">没有找到匹配的消息</div>';
      return;
    }

    // 按对话分组
    const groups = {};
    hits.forEach(m => {
      const cid = m.conversationId || 'default';
      if (!groups[cid]) groups[cid] = [];
      groups[cid].push(m);
    });

    // 获取对话名称列表
    const convData = await DB.get('gameState', 'conversations');
    const convList = convData?.value || [];
    const nameMap = {};
    convList.forEach(c => { nameMap[c.id] = c.name; });

    // 渲染结果
    let html = '';
    for (const [cid, msgs] of Object.entries(groups)) {
      const convName = nameMap[cid] || '未命名对话';
      html += `<div class="gs-group">`;
      html += `<div class="gs-group-title">${Utils.escapeHtml(convName)} <span class="gs-count">${msgs.length}条匹配</span></div>`;

      // 每个对话最多显示5条预览
      const preview = msgs.sort((a, b) => a.timestamp - b.timestamp).slice(0, 5);
      preview.forEach(m => {
        const role = m.role === 'user' ? '你' : 'AI';
        const text = m.content || '';
        // 截取关键词周围的片段
        const idx = text.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 30);
        const end = Math.min(text.length, idx + q.length + 60);
        let snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
        // 高亮关键词
        snippet = Utils.escapeHtml(snippet).replace(
          new RegExp(Utils.escapeHtml(query.trim()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          m => `<mark>${m}</mark>`
        );

        html += `<div class="gs-item" onclick="UI._jumpToMessage('${cid}','${m.id}')">`;
        html += `<div class="gs-role">${role}</div>`;
        html += `<div class="gs-preview">${snippet}</div>`;
        html += `</div>`;
      });

      if (msgs.length > 5) {
        html += `<div style="font-size:11px;color:var(--text-secondary);padding:4px 12px">还有 ${msgs.length - 5} 条匹配...</div>`;
      }
      html += `</div>`;
    }
    container.innerHTML = html;
  }

  async function _jumpToMessage(convId, msgId) {
    // 先关闭搜索
    await closeGlobalSearch();
    // 切换到目标对话
    await Conversations.switchTo(convId);
    // 等待渲染完成
    await new Promise(r => setTimeout(r, 100));
    // 定位到具体消息
    const msgEl = document.querySelector(`.chat-msg[data-id="${msgId}"]`);
    if (msgEl) {
      msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      msgEl.classList.add('search-flash');
      msgEl.addEventListener('animationend', () => msgEl.classList.remove('search-flash'), { once: true });
    }
  }

function showToast(text, duration = 4500) {
    // 堆叠容器
    let stack = document.getElementById('ui-toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'ui-toast-stack';
      stack.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:min(86vw,420px)';
      document.body.appendChild(stack);
    }
    const toast = document.createElement('div');
    toast.className = 'ui-toast-item';
    toast.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-secondary);color:var(--text);border:1px solid color-mix(in srgb, var(--accent) 35%, var(--border));box-shadow:0 8px 24px rgba(0,0,0,0.18);padding:12px 12px 12px 16px;border-radius:12px;font-size:14px;line-height:1.45;animation:toastIn 0.22s ease;display:flex;align-items:flex-start;gap:10px;pointer-events:auto';
    const span = document.createElement('span');
    span.textContent = text;
    span.style.cssText = 'flex:1;word-break:break-word;white-space:normal;min-width:0;padding-top:1px';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '关闭提示');
    closeBtn.style.cssText = 'width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer;opacity:0.78;font-size:18px;line-height:22px;padding:0;flex-shrink:0;display:flex;align-items:center;justify-content:center';
    closeBtn.onclick = () => {
      toast.style.animation = 'toastOut 0.2s ease forwards';
      setTimeout(() => toast.remove(), 200);
    };
    toast.appendChild(span);
    toast.appendChild(closeBtn);
    stack.appendChild(toast);
    setTimeout(() => {
      if (!toast.parentNode) return;
      toast.style.animation = 'toastOut 0.2s ease forwards';
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }

  function setMaskEditFrom(from) { _maskEditFrom = from; }

  return {
    toggleTopMenu, toggleTokenPopup, toggleNewMenu, toggleSidebar, showPanel, showPanelAndCloseSidebar,
    showBranchModal, closeBranchModal,
    closeEditModal, closeMsgEditModal,
    togglePopup, closeAllPopups, closeSwitchSheet,
    openSwitchSheet: togglePopup,
    toggleChatSummary, openChatSummary,
    switchWorldviewTab, switchSettingsTab, showSettingsOverview, handleSettingsBack,
    switchDebugTab, showDebugLog,
    showSimpleInput, closeSimpleInput, confirmSimpleInput,
    showConfirm, showAlert, showCopyText, showToast,
    openGlobalSearch, closeGlobalSearch, _globalSearchDebounced, _jumpToMessage,
    setMaskEditFrom
  };
})();