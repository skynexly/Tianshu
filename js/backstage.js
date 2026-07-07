/**
 * 后台频道 — 寄生在主线对话上的独立聊天窗口
 */
const Backstage = (() => {
let isOpen = false;
  let messages = [];
  let isStreaming = false;
  let _sendLock = false; // v687.19：防重入锁（覆盖 captureSnapshot 等异步窗口）
let abortCtrl = null;
let pendingImages = [];   // [{base64, name, type}]
  let pendingMemories = []; // [{id, title, content}]
  let pendingFiles = [];    // [{name, size, content}]
  let _allMemCache = [];

  // 获取当前对话的后台设定
  function _getSettings() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    return {
    enabled: !!conv?.backstageEnabled,
    prompt: conv?.backstagePrompt || '',
    rules: conv?.backstageRules || '',
    contextCount: conv?.backstageContextCount ?? 200,
    maxTokens: conv?.backstageMaxTokens ?? 230000,
    convId: conv?.backstageConvId || null,
    timeAware: conv?.backstageTimeAware !== false,  // 默认开
    batteryAware: !!conv?.backstageBatteryAware,    // v687.14：默认关
    weatherAware: !!conv?.backstageWeatherAware,    // v687.14：默认关
    toolsMemory: conv?.backstageToolsMemory !== false,     // 默认开
    toolsDirective: conv?.backstageToolsDirective !== false, // 默认开
    toolsWorldview: conv?.backstageToolsWorldview !== false, // 默认开（只读）
    toolsEdit: !!conv?.backstageToolsEdit,               // 默认关（AI 编辑设定/单人卡，高风险）
    toolsMainMemory: conv?.backstageToolsMainMemory !== false, // 默认开（主线记忆查询，只读）
    crossWindow: !!conv?.backstageCrossWindow,  // 默认关：纸条只在当前对话内可见
    roleId: conv?.backstageRoleId || '',           // 身份认知，空=自由
    roleType: conv?.backstageRoleType || '',       // 'card' | 'wv_npc'
    roleSourceWvId: conv?.backstageRoleSourceWvId || '',
    roleName: conv?.backstageRoleName || ''
    };
  }

  // 确保后台有独立的conversationId
  async function _ensureConvId() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) return null;
    if (!conv.backstageConvId) {
      conv.backstageConvId = 'bs_' + Conversations.getCurrent();
      await Conversations.saveList();
    }
    return conv.backstageConvId;
  }

  // 加载后台消息
  async function _loadMessages() {
    const convId = _getSettings().convId || ('bs_' + Conversations.getCurrent());
const allMsgs = await DB.getAllByIndex('messages', 'conversationId', convId);
messages = allMsgs
.filter(m => m.branchId === 'backstage')
.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  // 渲染消息
function _renderMessages() {
const container = document.getElementById('backstage-messages');
if (!container) return;
if (messages.length === 0) {
container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:40px 20px;font-size:13px">后台频道已开启。<br>这里的对话不影响主线剧情。</div>';
return;
}
container.innerHTML = messages.map(m => {
      const isUser = m.role === 'user';
      // v687.37：提取 <think>/<thinking> 内容，做折叠栏
      let displayContent = m.content || '';
      let thinkingHtml = '';
      if (!isUser && displayContent) {
        const thinkParts = [];
        displayContent = displayContent.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, (_, inner) => {
          if (inner.trim()) thinkParts.push(inner.trim());
          return '';
        });
        if (thinkParts.length > 0) {
          const thinkText = Utils.escapeHtml(thinkParts.join('\n\n'));
          thinkingHtml = `<details class="thinking-block" style="margin-bottom:8px"><summary style="cursor:pointer;font-size:12px;color:var(--text-secondary);user-select:none">💭 思考过程</summary><pre style="white-space:pre-wrap;font-size:12px;color:var(--text-secondary);margin:6px 0 0;max-height:200px;overflow-y:auto">${thinkText}</pre></details>`;
        }
      }
      const contentHtml = isUser
        ? Utils.escapeHtml(m.content)
        : (displayContent.trim()
          ? thinkingHtml + Markdown.render(displayContent)
          : (thinkingHtml || '<div class="typing-indicator"><span></span><span></span><span></span></div>'));
      // v687.7：工具使用尾巴（仅 AI 消息）
      const hasLog = !isUser && m.toolsLog && m.toolsLog.length > 0;
      const toolsTail = (!isUser && m.toolsUsed > 0)
        ? `<div class="msg-tools-used" ${hasLog ? `onclick="event.stopPropagation();Backstage._showToolsLog('${m.id}')" style="cursor:pointer"` : ''} title="本轮 AI 调用了 ${m.toolsUsed} 个工具${hasLog ? '（点击查看详情）' : ''}"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;opacity:.85"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>使用了 ${m.toolsUsed} 个工具${hasLog ? '（点击查看详情）' : ''}</div>`
        : '';
      return `<div class="backstage-msg-wrap ${isUser ? 'user' : 'assistant'}">
        <div class="chat-msg ${isUser ? 'user' : 'assistant'}" data-id="${m.id}">
          <div class="md-content">${contentHtml}</div>
          ${toolsTail}
        </div>
      </div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
    // 解析"正在生成图片"占位符，替换为前台同款动画
    try {
      container.querySelectorAll('.md-content').forEach(el => {
        if (!el.textContent || !el.textContent.includes('[正在生成图片')) return;
        el.innerHTML = el.innerHTML.replace(
          /\[正在生成图片[^…]*…\]/g,
          '<div style="display:flex;align-items:center;gap:8px;padding:12px;margin:8px 0;border-radius:8px;background:var(--bg-tertiary);border:1px solid var(--border);font-size:13px;color:var(--text-secondary)"><div class="typing-indicator" style="flex-shrink:0"><span></span><span></span><span></span></div>正在生成图片…</div>'
        );
      });
    } catch(_) {}
    // 解析图片占位符 [TSIMG:id|desc]
    try {
      if (container.textContent && container.textContent.includes('[TSIMG:') && typeof Chat !== 'undefined' && Chat.resolveDrawnImagesInHTML) {
        Chat.resolveDrawnImagesInHTML(container).catch(_ => {});
      }
    } catch(_) {}
  }

  // 切换后台窗口显隐
  function toggle() {
    if (isOpen) {
      minimize();
    } else {
      _open();
    }
  }

  async function _open() {
    await _ensureConvId();
    await _loadMessages();
_renderMessages();
document.getElementById('backstage-modal').classList.remove('hidden');
isOpen = true;
try { initLongPress(); } catch(e) { console.error('[Backstage LongPress]', e); }
_updateSendButton();
const container = document.getElementById('backstage-messages');
    if (container) container.scrollTop = container.scrollHeight;
  }

  function minimize() {
  const modal = document.getElementById('backstage-modal');
  if (!modal) return;
  modal.classList.add('closing');
  setTimeout(() => {
    modal.classList.remove('closing');
    modal.classList.add('hidden');
  }, 220);
  isOpen = false;
  // 最小化后显示悬浮球（仅当后台已启用，与 updateFab 条件一致）
  try {
    const fab = document.getElementById('backstage-fab');
    if (fab && _getSettings().enabled) {
      fab.classList.remove('hidden');
      fab.classList.toggle('generating', !!isStreaming);
    }
  } catch(_) {}
}

  // 更新发送按钮状态
  function _updateSendButton() {
    const btn = document.getElementById('backstage-send-btn');
    if (!btn) return;
    if (isStreaming) {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px"><path fill-rule="evenodd" d="M5.47 5.47a.75.75 0 0 1 1.06 0L12 10.94l5.47-5.47a.75.75 0 1 1 1.06 1.06L13.06 12l5.47 5.47a.75.75 0 1 1-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 0 1-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>';
      btn.style.background = 'var(--danger)';
      btn.style.color = '#fff';
      btn.onclick = cancel;
    } else {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>';
      btn.style.background = 'var(--accent)';
      btn.style.color = '#111';
      btn.onclick = send;
    }
  }

  // 终止当前生成
  function cancel() {
    if (abortCtrl) {
      try { abortCtrl.abort(); } catch(e) {}
    }
    // v687.37：强制清理所有锁状态（防止 API 未响应时 abort 被吞导致锁死）
    isStreaming = false;
    _sendLock = false;
    abortCtrl = null;
    document.getElementById('backstage-fab')?.classList.remove('generating');
    _updateSendButton();
  }

  // ===== 加号菜单 / 附件 =====
  function togglePlusMenu() {
    const menu = document.getElementById('backstage-plus-menu');
    if (!menu) return;
    menu.classList.toggle('hidden');
  }
  function _closePlusMenu() {
    document.getElementById('backstage-plus-menu')?.classList.add('hidden');
  }

  function attachImage() {
    _closePlusMenu();
    document.getElementById('backstage-image-picker').click();
  }

  function attachFile() {
    _closePlusMenu();
    const picker = document.getElementById('backstage-file-picker');
    picker.value = '';
    picker.click();
  }

  async function onFilePicked(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    try {
      const content = await Utils.readFileAsText(file);
      const charCount = content.length;
      const tokenEst = Utils.estimateTokens(content);
      if (charCount > 20000) {
        const ok = await UI.showConfirm('文件内容较长',
          `「${file.name}」提取出约 ${Math.round(charCount / 1000)}k 字符（约 ${Math.round(tokenEst / 1000)}k token）。\n\n内容过长可能占用大量上下文窗口，导致 AI 遗忘前文或回复异常。\n\n确定要附加吗？`);
        if (!ok) return;
      }
      pendingFiles.push({ name: file.name, size: file.size, content });
      _renderAttachments();
    } catch (e) {
      UI.showToast(e.message || '读取失败', 2000);
    }
  }

  function previewFile(index) {
    const f = pendingFiles[index];
    if (!f) return;
    if (window.Chat && typeof Chat._openFilePreview === 'function') {
      Chat._openFilePreview(f.name, f.content);
    } else {
      // fallback: 调 Chat.previewFile 通过临时挂载
      UI.showToast('文件预览不可用', 1800);
    }
  }

  function onImagePicked(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      if (pendingImages.length >= 3) { UI.showToast('最多3张图片', 1500); return; }
      pendingImages.push({ base64: e.target.result, name: file.name, type: file.type });
      _renderAttachments();
    };
    reader.readAsDataURL(file);
    input.value = '';
  }

  async function pickMemories() {
    _closePlusMenu();
    const all = await DB.getAll('memories');
    const currentMask = Character.getCurrentId();
    _allMemCache = currentMask ? all.filter(m => m.scope === currentMask) : all;
    _renderMemPickList(_allMemCache);
    document.getElementById('backstage-mem-pick-modal').classList.remove('hidden');
  }

  function filterPickMemories(query) {
    const q = (query || '').toLowerCase();
    const filtered = q ? _allMemCache.filter(m =>
      (m.title || '').toLowerCase().includes(q) ||
      (m.content || '').toLowerCase().includes(q)
    ) : _allMemCache;
    _renderMemPickList(filtered);
  }

  function _renderMemPickList(list) {
    const container = document.getElementById('backstage-mem-pick-list');
    if (!container) return;
    container.innerHTML = list.map(m => {
      const checked = pendingMemories.some(pm => pm.id === m.id);
      return `<div style="display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border)">
        <span class="mem-check-circle ${checked ? 'checked' : ''}" onclick="event.stopPropagation();Backstage._togglePickMem('${m.id}', !this.classList.contains('checked'))" style="width:22px;height:22px;border-radius:50%;border:2px solid ${checked ? 'var(--accent)' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;${checked ? 'background:var(--accent);' : ''}">
          ${checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
        </span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--accent)">${Utils.escapeHtml(m.title || '无标题')}</div>
          <div style="font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml((m.content || '').substring(0, 80))}</div>
        </div>
      </div>`;
    }).join('') || '<p style="color:var(--text-secondary);text-align:center;padding:12px">暂无记忆</p>';
  }

  function _togglePickMem(id, checked) {
    if (checked) {
      if (pendingMemories.length >= 3) { UI.showToast('最多3条记忆', 1500); return; }
      const mem = _allMemCache.find(m => m.id === id);
      if (mem) pendingMemories.push(mem);
    } else {
      pendingMemories = pendingMemories.filter(m => m.id !== id);
    }
    _renderMemPickList(_allMemCache);
  }

  function confirmPickMemories() {
    document.getElementById('backstage-mem-pick-modal').classList.add('hidden');
    _renderAttachments();
  }

  function closeMemPick() {
    document.getElementById('backstage-mem-pick-modal').classList.add('hidden');
  }

  function removeAttach(type, index) {
    if (type === 'image') pendingImages.splice(index, 1);
    if (type === 'memory') pendingMemories.splice(index, 1);
    if (type === 'file') pendingFiles.splice(index, 1);
    _renderAttachments();
  }

  function _renderAttachments() {
    const bar = document.getElementById('backstage-attachments-bar');
    if (!bar) return;
    if (pendingImages.length === 0 && pendingMemories.length === 0 && pendingFiles.length === 0) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }
    bar.classList.remove('hidden');
    let html = '';
    pendingImages.forEach((img, i) => {
      html += `<div class="attach-item">
        <img src="${img.base64}">
        <span>${Utils.escapeHtml(img.name)}</span>
        <button class="remove-attach" onclick="Backstage.removeAttach('image',${i})"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    });
    pendingMemories.forEach((m, i) => {
      html += `<div class="attach-item">
        <span style="display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z" clip-rule="evenodd" /></svg>${Utils.escapeHtml(m.title || '记忆')}</span>
        <button class="remove-attach" onclick="Backstage.removeAttach('memory',${i})"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    });
    pendingFiles.forEach((f, i) => {
      html += `<div class="attach-item" style="cursor:pointer" onclick="Backstage.previewFile(${i})" title="点击预览">
        <span style="display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0 0 16.5 9h-1.875a1.875 1.875 0 0 1-1.875-1.875V5.25A3.75 3.75 0 0 0 9 1.5H5.625Z" clip-rule="evenodd" /></svg>${Utils.escapeHtml(f.name)}</span>
        <button class="remove-attach" onclick="event.stopPropagation();Backstage.removeAttach('file',${i})"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    });
    bar.innerHTML = html;
  }

  // 构建发给 API 的消息（system + history）
  async function _buildApiMessages(historyMsgs) {
    const systemParts = [];

    const wvPrompt = Chat.getWorldviewPrompt();
    if (wvPrompt) systemParts.push(wvPrompt);
    const char = await Character.get();
    if (char) systemParts.push(Character.formatForPrompt(char));
    const quickRef = NPC.formatQuickRef();
    if (quickRef) systemParts.push(quickRef);

    // 单人模式主角资料（如果当前对话是单人模式）
    try {
      if (window.SingleMode) {
        const singleSettings = SingleMode.getCurrentSingleSettings && SingleMode.getCurrentSingleSettings();
        if (singleSettings) {
          let _np = 'second';
          try { _np = (Chat._getConvSettings && Chat._getConvSettings().narrPerson) || 'second'; } catch(_) {}
          const mainCharText = await SingleMode.getMainCharPrompt(singleSettings, _np);
          if (mainCharText) systemParts.push(mainCharText);
        }
      }
    } catch(e) {}

    // 挂载角色（对话级常驻）
    try {
      if (window.AttachedChars) {
        const attachedPrompt = await AttachedChars.buildPrompt();
        if (attachedPrompt) systemParts.push(attachedPrompt);
      }
    } catch(e) {}

    // 全图 NPC（世界观级常驻）
    let _bsWvForExt = null;
    let _bsCardHiddenWv = null;
    try {
      const curWvId = Worldview.getCurrentId && Worldview.getCurrentId();
      let _wvForGlobal = null;
      if (window.SingleMode) {
        const ss = SingleMode.getCurrentSingleSettings && SingleMode.getCurrentSingleSettings();
        if (ss && ss.worldviewId) _wvForGlobal = await DB.get('worldviews', ss.worldviewId);
        if (ss && ss.charType === 'card' && ss.charId) {
          // v632：从单人卡绑定的世界书聚合
          try {
            if (typeof Lorebook !== 'undefined') {
              const _card = await SingleCard.get(ss.charId);
              if (_card && (_card.lorebookIds || []).length > 0) {
                const _conv = (typeof Conversations !== 'undefined' && Conversations.getList)
                  ? Conversations.getList().find(c => c.id === Conversations.getCurrent())
                  : null;
                const _lbs = await Lorebook.collectForChat({ conv: _conv, card: _card });
                if (_lbs && _lbs.length > 0) {
                  const merged = { festivals: [], knowledges: [], events: [], globalNpcs: [] };
for (const lb of _lbs) {
if (Array.isArray(lb.festivals)) merged.festivals.push(...lb.festivals);
if (Array.isArray(lb.knowledges)) merged.knowledges.push(...lb.knowledges);
// v632.1：events 不再合并，事件系统不走世界书层
if (Array.isArray(lb.globalNpcs)) merged.globalNpcs.push(...lb.globalNpcs);
}
                  _bsCardHiddenWv = merged;
                }
              }
            }
          } catch(_) {}
        }
      }
      if (!_wvForGlobal && curWvId && curWvId !== '__default_wv__') {
        _wvForGlobal = await DB.get('worldviews', curWvId);
      }
      _bsWvForExt = _wvForGlobal;
      const gs = (_wvForGlobal && _wvForGlobal.globalNpcs) || [];
      if (gs.length > 0) {
        const text = '【全图常驻 NPC】\n以下 NPC 不受地区限制，在本世界观下全程常驻，随时可以出现在任何场景中。\n\n' +
          gs.map(n => {
            const head = n.aliases ? `${n.name}（${n.aliases}）` : (n.name || '未命名');
const headFull = head + (n.onlineName ? `（网名：${n.onlineName}）` : '');
            return n.detail ? `${headFull}\n${n.detail}` : headFull;
          }).join('\n\n---\n\n');
        systemParts.push(text);
      }
    } catch(e) {}

    // 扩展设定索引（仅在开了"世界观查询工具"开关时发，配套使用）
    try {
      const _bsSettings = _getSettings();
      if (_bsSettings.toolsWorldview) {
        const indexParts = [];
        const _renderIdx = (wv, label) => {
          if (!wv) return;
          const lines = [];
          // 节日
          const fests = (wv.festivals || []).filter(f => f && f.enabled !== false);
          if (fests.length > 0) {
            lines.push('节日：' + fests.map(f => {
              let s = f.name || '未命名';
              if (f.date) s += `（${f.date}${f.yearly ? '，每年' : ''}）`;
              return s;
            }).join('、'));
          }
          // 常驻条目
          const customs = (wv.knowledges || []).filter(k => k && k.enabled !== false && !k.keywordTrigger);
          if (customs.length > 0) {
            lines.push('常驻设定：' + customs.map(k => k.name || '未命名').join('、'));
          }
          // 动态条目
          const dyns = (wv.knowledges || []).filter(k => k && k.enabled !== false && k.keywordTrigger);
          if (dyns.length > 0) {
            lines.push('知识条目：' + dyns.map(k => k.name || '未命名').join('、'));
          }
          if (lines.length > 0) {
            indexParts.push(`【${label}】\n${lines.join('\n')}`);
          }
        };
        _renderIdx(_bsWvForExt, '世界观扩展设定索引');
        _renderIdx(_bsCardHiddenWv, '单人卡扩展设定索引');
        if (indexParts.length > 0) {
          systemParts.push(
            '【扩展设定索引（配合世界观查询工具使用）】\n' +
            '以下是这个对话挂载的世界观/单人卡里有哪些扩展设定。详情用 query_worldview_extended 按名字或关键词查。\n\n' +
            indexParts.join('\n\n')
          );
        }
      }
    } catch(_) {}

    try {
      const summaryText = await Summary.formatForPrompt(Conversations.getCurrent());
      if (summaryText) systemParts.push(summaryText);
    } catch(e) {}

    // 自定义属性当前状态（后台只读，不允许修改）
    try {
      if (typeof StatusBar !== 'undefined' && StatusBar.formatCustomAttrsStatePrompt) {
        const customAttrsState = await StatusBar.formatCustomAttrsStatePrompt();
        if (customAttrsState) {
          systemParts.push(customAttrsState + '\n\n【后台频道规则】以上自定义属性仅供后台只读参考。后台频道不影响主线剧情，请不要输出 custom-attrs 代码块，也不要尝试修改这些属性。');
        }
      }
    } catch(e) {}

    // 心动模拟累计状态（非心动模拟世界观时 hsFormatForPrompt 会返回空）
    // 已返航后停止注入累计状态，改为注入"已返航"情报
    let _bsHsHomecoming = false;
    try {
      if (typeof Phone !== 'undefined' && Phone.isHsHomecomingTriggered) {
        _bsHsHomecoming = await Phone.isHsHomecomingTriggered();
      }
    } catch(_) {}

    if (_bsHsHomecoming) {
      systemParts.push('【心动模拟·返航后情报（仅后台可见）】\n玩家已结束心动模拟，从原本的世界醒来回到自己家中。返航过场动画已展示给玩家——动画包含 6 条客服推送，最后一条「亲爱的，你想去哪？」头像漆黑、来源不明（不是心动模拟客服发的，悬念点）。\n现在主线 AI 已切换到"已返航"模式，不再有任务/好感度/心动目标，氛围是"刚结束的事其实没完全结束"。\n后台你可以照常吐槽、聊设定，但请知悉这个剧情节点已经达成。');
      // v687.41d：返航后追加现实世界描述（后台也要知道当前世界观已变）
      systemParts.push('【返航后·世界观补充】\n当前世界是一个与现实完全一致的当代世界——科技水平、社会制度、文化背景、地理格局均与当今现实相同。没有超自然现象，没有异世界，没有任何违反常识的事物存在。人们正常地生活、工作、社交，一切按照普通的现代社会运转。心逸市、心动模拟APP及其所有游戏机制不再存在于当前世界。');
    } else {
      try {
        if (typeof StatusBar !== 'undefined' && StatusBar.hsFormatForPrompt) {
          const hsStateText = StatusBar.hsFormatForPrompt();
          if (hsStateText) systemParts.push(hsStateText);
        }
      } catch(e) {}

      // 通关条件达成但还未返航时，给后台一个情报
      try {
        if (typeof StatusBar !== 'undefined' && StatusBar.hsCheckClearCondition) {
          const chk = StatusBar.hsCheckClearCondition();
          if (chk && chk.passed) {
            systemParts.push('【心动模拟·通关情报（仅后台可见）】\n玩家已达成通关条件，可以回家了。但玩家是否真的让 AI 推剧情回家、是否在心动模拟客服那边发送过「回家」指令，看上面的客服对话记录与主线状态。返航触发后 AI 会输出 ```homecoming``` 信号、前端会接管展示返航过场动画。');
          }
        }
      } catch(_) {}
    }

// 心动模拟 APP 玩家私下好感度（仅后台可见，主线不可见）
    try {
      if (typeof Phone !== 'undefined' && Phone.buildHeartsimAppFavorForBackstage) {
        const hsAppText = await Phone.buildHeartsimAppFavorForBackstage();
        if (hsAppText) systemParts.push(hsAppText);
      }
    } catch(e) {}
    // 心动模拟 APP 客服对话记录（仅后台可见，含 ★ 新增标记）
    try {
      if (typeof Phone !== 'undefined' && Phone.buildHeartsimServiceChatForBackstage) {
        const hsChatText = await Phone.buildHeartsimServiceChatForBackstage();
        if (hsChatText) systemParts.push(hsChatText);
      }
    } catch(e) {}

    // 全局：玩家正在播放的歌（仅播放中，无条件同步，仅后台可见）
    try {
      if (typeof Phone !== 'undefined' && Phone.buildNowPlayingForBackstage) {
        const nowPlayingText = Phone.buildNowPlayingForBackstage();
        if (nowPlayingText) systemParts.push(nowPlayingText);
      }
    } catch(e) {}


    // 全局：手机操作日志（后台独立队列，与主线互不干扰）
    try {
      if (typeof Phone !== 'undefined' && Phone.flushActionLogForBackstage) {
        const log = Phone.flushActionLogForBackstage();
        if (log && log.length > 0) {
          const logText = '【玩家手机操作日志（仅后台可见）｜OOC】\n以下是玩家"{{user}}"自上次后台同步以来，在自己手机上进行的全部操作。后台可以基于此观察玩家行为轨迹（操作主体永远是玩家本人，不是任何剧情角色）：\n' +
            log.map(a => `- {{user}} ${a}`).join('\n') +
            '\n\n【禁止】不要在回复中输出或模仿此格式块，它是系统自动注入的元信息。';
          systemParts.push(logText);
        }
      }
    } catch(e) {}
    const settings = _getSettings();

    // 身份认知（如果选了角色，往最前面塞身份）
    let roleIdentityText = '';
    if (settings.roleId && settings.roleType) {
      try {
        if (settings.roleType === 'card') {
          const c = await SingleCard.get(settings.roleId);
          if (c && c.name) {
            roleIdentityText = `你是${c.name}。`;
if (c.aliases) roleIdentityText += `\n别称：${c.aliases}`;
if (c.onlineName) roleIdentityText += `\n网名：${c.onlineName}`;
            if (c.detail) roleIdentityText += `\n\n${c.detail}`;
          }
        } else if (settings.roleType === 'wv_npc') {
          const wvId = settings.roleSourceWvId;
          if (wvId) {
            const wv = await DB.get('worldviews', wvId);
            if (wv) {
              let npc = (wv.globalNpcs || []).find(n => n.id === settings.roleId);
              if (!npc) {
                for (const r of (wv.regions || [])) {
                  for (const f of (r.factions || [])) {
                    npc = (f.npcs || []).find(n => n.id === settings.roleId);
                    if (npc) break;
                  }
                  if (npc) break;
                }
              }
              if (npc && npc.name) {
                roleIdentityText = `你是${npc.name}。`;
if (npc.aliases) roleIdentityText += `\n别称：${npc.aliases}`;
if (npc.onlineName) roleIdentityText += `\n网名：${npc.onlineName}`;
                if (npc.detail) roleIdentityText += `\n\n${npc.detail}`;
              }
            }
          }
        }
      } catch(_) {}
    }
    if (roleIdentityText) systemParts.unshift(roleIdentityText);

    let backstageInstruction = '';
    if (settings.prompt) {
      backstageInstruction += '【用户对后台AI的要求】\n' + settings.prompt + '\n\n';
    }
    backstageInstruction += '【后台频道】\n你现在在后台频道。这里的对话完全独立于主线剧情，不会影响任何正在进行的故事。\n不需要遵循回复格式，自由回应即可。你清楚{{user}}实际存在于三次元，而非是剧情中的Ta扮演的角色。可以讨论剧情、吐槽、聊设定、回答问题、聊聊现实中的生活等。';

    // OOC 昵称（用户在账号里填的、剧情外的称呼）
    try {
      if (typeof Auth !== 'undefined' && Auth.getNickname) {
        const oocNick = Auth.getNickname();
        if (oocNick) {
          backstageInstruction += `\n\n【关于用户的现实称呼】\n用户在账号里填写的昵称是「${oocNick}」。在后台聊天（剧情外）中，你可以这样称呼Ta；这与剧情中的角色姓名无关。`;
        }
      }
    } catch(_) {}

    if (settings.prompt) {
      backstageInstruction += '\n（注意：如果上方【用户对后台AI的要求】中指定了角色扮演或其他特殊要求，以用户要求为准，本段仅作兜底参考。）';
    }
    systemParts.push(backstageInstruction);

    // 现实时间感知（后台默认开）
if (settings.timeAware && window.TimeAwareness) {
try {
const { lastAssistantTs, lastUserTs } = TimeAwareness.extractTimestamps(historyMsgs);
systemParts.push(TimeAwareness.buildPrompt(lastAssistantTs, lastUserTs));
} catch(e) {}
}

// 生图模式（与主对话共用同一开关：convImgGen）
try {
const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
if (conv && conv.convImgGen) {
systemParts.push('[生图能力]\n你拥有生成图片的能力。当用户要求你画图、生成插画、展示场景图等时，在回复中写 [IMG: English description of the image] 标记（描述必须用英文，50-200词，尽量详细描写画面构图、光影、风格）。前端会自动检测该标记并调用生图API生成图片。\n- 用户不要求时不要主动生成图片\n- 一条回复里可以有多个 [IMG:] 标记\n- 描述要具体，避免抽象概念');
}
} catch(e) {}

    const mainMessages = Chat.getMessages();
    const contextCount = settings.contextCount;
    if (contextCount > 0 && mainMessages.length > 0) {
      const recent = mainMessages.slice(-contextCount);
      const mainContext = recent.map(m => `[${m.role === 'user' ? '玩家' : 'AI'}]: ${m.content}`).join('\n\n');
      systemParts.push('【主线剧情参考（只读，不要续写）】\n以下是主线中最近的对话内容，仅供了解当前剧情进展：\n\n' + mainContext);
      const latestRounds = mainMessages.slice(-4);
      if (latestRounds.length > 0) {
        const latestContext = latestRounds.map(m => `[${m.role === 'user' ? '玩家' : 'AI'}]: ${m.content}`).join('\n\n');
        systemParts.push('【⚠ 主线最新剧情（优先基于此回复）】\n以下是主线最新发生的内容，当用户讨论剧情时请优先参考这部分：\n\n' + latestContext);
      }
    }

    // 后台记忆碎片被动注入
    try {
      if (typeof Memory !== 'undefined' && Memory.retrieveBackstageNotes) {
        const settings = _getSettings();
        const currentConvId = Conversations.getCurrent() || '';
        const lastUserMsg = [...historyMsgs].reverse().find(m => m.role === 'user');
        const userInputText = lastUserMsg?.content || '';
        const bsNotes = await Memory.retrieveBackstageNotes({
          currentConvId,
          crossWindow: settings.crossWindow,
          userInputText
        });
        const bsNotesPrompt = Memory.formatBackstageNotesForPrompt(bsNotes, { crossWindow: settings.crossWindow, currentConvId });
        if (bsNotesPrompt) systemParts.push(bsNotesPrompt);
      }
    } catch(_) {}

    // skynex 功能目录：常驻注入 + 关键词命中章节注入（不依赖工具）
    try {
      const _gresp = await fetch('guide.md?_=' + Date.now());
      if (_gresp.ok) {
        const _gmd = await _gresp.text();
        // 1) 常驻目录
        const _toc = _gmd.split('\n')
          .filter(l => /^#{1,5}\s/.test(l))
          .map(l => {
            const level = l.match(/^(#{1,5})\s/)[1].length;
            const indent = '  '.repeat(level - 1);
            return indent + '- ' + l.replace(/^#+\s*/, '').trim();
          })
          .join('\n');
        if (_toc) {
          systemParts.push('【skynex 使用说明·功能目录】\n'
            + '以下是 skynex（本应用）的全部功能章节目录。skynex 是你和用户所在的这个 AI 文游应用。\n'
            + '当用户问起某个功能"在哪/怎么用"，你可以对照目录定位，然后用 query_guide 工具传对应关键词（章节名或功能词都行）查看该章节的详细说明（查询结果不进上下文、不耗窗口）。\n\n'
            + _toc);
        }
        // 2) 关键词命中：拿最新用户消息，比对各章节的标题 + 「关键词：」行，命中则把该章节完整内容注入
        try {
          const _lastUser = [...historyMsgs].reverse().find(m => m.role === 'user');
          const _userText = (_lastUser && _lastUser.content ? String(_lastUser.content) : '').toLowerCase();
          if (_userText) {
            // 拆章节
            const _glines = _gmd.split('\n');
            const _secs = [];
            let _cur = null;
            for (const _l of _glines) {
              if (/^#{1,5}\s/.test(_l)) {
                if (_cur) _secs.push(_cur);
                _cur = { heading: _l, title: _l.replace(/^#+\s*/, '').trim(), body: [] };
              } else if (_cur) {
                _cur.body.push(_l);
              }
            }
            if (_cur) _secs.push(_cur);
            // 逐章节算命中词数（标题 + 关键词行的词）
            const _scored = [];
            for (const _sec of _secs) {
              const _terms = new Set();
              if (_sec.title) _terms.add(_sec.title.toLowerCase());
              for (const _b of _sec.body) {
                const _m = _b.match(/^关键词[：:]\s*(.+)$/);
                if (_m) {
                  _m[1].split(/[\s，,、]+/).forEach(t => { t = t.trim(); if (t) _terms.add(t.toLowerCase()); });
                }
              }
              let _hits = 0;
              for (const _t of _terms) { if (_t && _userText.includes(_t)) _hits++; }
              if (_hits > 0) _scored.push({ sec: _sec, hits: _hits });
            }
            // 命中数降序，取前 3
            _scored.sort((a, b) => b.hits - a.hits);
            const _picked = _scored.slice(0, 3);
            if (_picked.length > 0) {
              const _blocks = _picked.map(x => (x.sec.heading + '\n' + x.sec.body.join('\n')).trim()).join('\n\n');
              systemParts.push('【功能命中·参考信息】\n'
                + '用户可能正在询问 skynex 的功能。以下是根据 ta 这条消息命中的说明章节，判断能否回答 ta 的问题；如果不够，可以用 query_guide 工具查阅更多。若 ta 并非在提问功能，可无视这部分。\n'
                + '回答时请保持你的人设，同时清楚地解释功能。\n\n'
                + _blocks);
            }
          }
        } catch(_) {}
      }
    } catch(_) {}

    // 后台工具说明书（根据开关状态动态生成）
    try {
      const bsSettings = _getSettings();
      const guideParts = [];
      if (bsSettings.toolsMemory) {
        // v685.4：告知 AI 后台纸条的查看路径和口令，方便 ta 在用户问起时引导
        let _pwd = '1001';
        try {
          if (typeof Memory !== 'undefined' && Memory.getBackstagePwd) _pwd = Memory.getBackstagePwd();
        } catch(_) {}
        guideParts.push(`【后台记忆工具】
你可以用 add_backstage_note 记下用户片段，用 query_backstage_notes 翻旧记录。

什么时候记：
- 用户说了能体现 ta 性格、偏好、兴趣的话——记
- 用户表达了情绪、有了情绪反应——记
- 用户说了/做了有意思的事、可能是伏笔的话、想保密的事——记
- 普通寒暄、日常陈述（"我去吃饭了"）——不用记
- 不用记在主线发生的事情，除非 ta 对此表达出了强烈的情绪。这种情况下写清楚那是在剧情中的事、以及 ta 为什么有情绪。这能帮你想起来 ta 曾因为什么情节不满或开心过。

怎么记：
- 标签从三类里选最贴切的一个：
  · 偏好类：喜欢、讨厌、习惯
  · 情绪类：实际什么情绪就写什么（开心、感动、悲伤、愤怒……都行）
  · 事件类：有趣、伏笔、秘密
- 内容要带上前因+反应，不要孤立记一句话
- 引用用户原话时保留引号
- priority 字段：能稳定体现 ta 长期性格画像的（习惯、喜好、厌恶）标 important，单次情绪、偶然事件标 normal。每轮最多标 1 条 important，不要硬凑。

不揣测、不每轮都记。觉得这条以后可能会想起来——就记。

你可能会收到来自其他后台的记忆，这取决于 ta 是否打开了后台跨窗口纸条共享。

【后台纸条的查看路径｜OOC】
后台小纸条入口比较隐蔽——存在【记忆库】里，用户需要在记忆库顶部的搜索框输入口令才能看到。
当前口令是：「${_pwd}」（用户可以在进入后台后点右上角"改口令"修改；默认 1001）
**如果用户问起"后台纸条在哪/怎么看/口令是什么/我忘了口令"之类的问题，请如实告诉 ta 上面这段信息。**
其它情况下不要主动提，这是为了方便 ta 在忘记时能问你拿回口令，不是要你时不时提醒。`);
      }
      if (bsSettings.toolsDirective) {
        guideParts.push(`【剧情引导工具】
你可以使用 set_directive / query_directive / remove_directive 来影响主线剧情走向。
- set_directive 会向主线注入一条临时指令，AI 会在接下来的 N 轮中自然过渡
- 指令到期后自动消失，中途可以编辑或撤销
- **使用前必须向用户确认内容和轮数，不要自行决定**
- 适用场景：用户觉得主线节奏不对、想要特定剧情发展、想调整氛围等
- 使用 query_directive 可以查看当前是否有生效中的引导`);
      }
      if (bsSettings.toolsWorldview) {
    guideParts.push(`【世界观查询工具】
聊到主线相关的设定时，可以查这个对话挂载的世界观。
- query_worldview_detail：按名字查地区/势力/NPC 的完整设定
- query_worldview_extended：按关键词搜节日/常驻条目/动态条目（不含事件）
不确定有没有相关设定时也可以试着搜一下，没有就没有。`);
  }
  if (bsSettings.toolsEdit) {
    guideParts.push(`【AI 编辑设定工具】
你可以在用户明确要求时，直接修改当前世界观/单人卡的设定文本。工具列表：
- read_worldview_setting / update_worldview_setting：读写世界观基础设定
- read_worldview_entry / update_worldview_entry：读写单个地区/势力/NPC
- list_extension_entries / add_extension_entry / update_extension_entry / delete_extension_entry：管理扩展设定（节日/常驻/动态）
- read_card / update_card：读写当前单人卡
- undo_last_edit：撤销上一次修改（支持 10 步回滚）

**使用规则：**
- 仅在用户明确说"帮我改/写/加/删"时才动笔，不要主动改设定
- 写入前系统会自动保存回滚快照，改错了可以 undo
- 不允许修改玩法配置（自定义属性/事件/任务/骰子）`);
      }
      if (bsSettings.toolsMainMemory) {
        guideParts.push(`【主线记忆查询工具】
聊到主线相关时可以翻主线的记忆：
- query_events：按关键词查主线已记录的剧情事件
- query_relations：按角色名查人际关系
- search_messages：按关键词搜被归档的旧消息（很久以前发生的、已经从上下文里剥离的对话）`);
      }
      if (guideParts.length > 0) {
        systemParts.push(guideParts.join('\n\n'));
      }
    } catch(_) {}

    const historyForAPI = historyMsgs.map(m => ({ role: m.role, content: m.content }));
    // 用户消息拼时间戳（后台默认开）
let stampedHistory = historyForAPI;
if (settings.timeAware && window.TimeAwareness) {
try { stampedHistory = TimeAwareness.stampUserMessages(historyForAPI, historyMsgs); } catch(e) {}
      }
      // v687.15：现实环境感知（电量/天气）拼到最近 2 条 user message 前缀
      try {
        if ((settings.batteryAware || settings.weatherAware) && window.EnvAwareness) {
          stampedHistory = EnvAwareness.stampUserMessages(stampedHistory, historyMsgs, {
            battery: settings.batteryAware,
            weather: settings.weatherAware,
            maxStamps: 2
          });
        }
      } catch(e) { console.warn('[Backstage] 环境感知注入失败', e); }
      // v687.7：上一轮工具使用提示
      try {
        const lastAi = [...historyMsgs].reverse().find(m => m.role === 'assistant');
        if (lastAi && lastAi.toolsUsed > 0) {
          systemParts.push(`【上一轮工具使用情况】\n你在上一轮回复中调用了 ${lastAi.toolsUsed} 个工具。这是给你的参考——如果上一轮已经查过相关信息，本轮可以直接基于结果回复，不必重复调用相同工具。`);
        }
      } catch(e) {}
      const apiMessages = await API.buildMessages(stampedHistory, systemParts);

    const maxTokens = settings.maxTokens || 230000;
    const _estimateTokens = (msgs) => msgs.reduce((sum, m) => {
      const c = m.content;
      if (typeof c === 'string') return sum + Math.ceil(c.length / 2);
      if (Array.isArray(c)) return sum + c.reduce((s, p) => s + (p.type === 'text' ? Math.ceil((p.text || '').length / 2) : 200), 0);
      return sum;
    }, 0);
    while (_estimateTokens(apiMessages) > maxTokens && apiMessages.length > 2) {
      const idx = apiMessages.findIndex(m => m.role !== 'system');
      if (idx === -1) break;
      apiMessages.splice(idx, 1);
    }

    // 重要规则：注入到 apiMessages 末尾（深度0，紧贴 AI 回复前）
    if (settings.rules) {
      apiMessages.push({ role: 'system', content: '【重要规则】\n' + settings.rules });
    }

    // 宏替换：{{user}} → OOC昵称（如有） / 面具名 / '玩家'；{{char}} → 单人卡角色名（如有）
    try {
      let _macroUser = '';
      try {
        const _ooc = await DB.get('settings', 'oocNickname');
        if (_ooc?.value && String(_ooc.value).trim()) _macroUser = String(_ooc.value).trim();
      } catch(_) {}
      if (!_macroUser) {
        try {
          const _mc = await Character.get();
          if (_mc?.name) _macroUser = _mc.name;
        } catch(_) {}
      }
      if (!_macroUser) _macroUser = '玩家';

      let _macroChar = '';
      try {
        if (typeof SingleMode !== 'undefined' && SingleMode.getCurrentSingleSettings) {
          const _ss = await SingleMode.getCurrentSingleSettings();
          if (_ss?.cardId && typeof SingleCard !== 'undefined') {
            const _card = await SingleCard.get(_ss.cardId);
            if (_card?.name) _macroChar = _card.name;
          }
        }
      } catch(_) {}

      for (const m of apiMessages) {
        if (m.content && typeof m.content === 'string') {
          if (m.content.includes('{{user}}')) m.content = m.content.replaceAll('{{user}}', _macroUser);
          if (_macroChar && m.content.includes('{{char}}')) m.content = m.content.replaceAll('{{char}}', _macroChar);
        }
      }
    } catch(_) {}

    return apiMessages;
  }

  // 核心生成：基于 historyMsgs 生成一条新 AI 消息（或追加到 existingAiMsg）
  async function _runGeneration(historyMsgs, existingAiMsg, isContinue) {
    const convId = await _ensureConvId();
    if (!convId) return;
    const apiMessages = await _buildApiMessages(historyMsgs);
    const bsConfig = Settings.getBackstageConfig ? Settings.getBackstageConfig() : {};
    const overrideConfig = (bsConfig.apiUrl && bsConfig.apiKey && bsConfig.model) ? bsConfig : null;

    let aiMsg;
    let baseContent = '';
    if (existingAiMsg && isContinue) {
      aiMsg = existingAiMsg;
      baseContent = aiMsg.content || '';
    } else {
      aiMsg = {
        id: Utils.uuid(),
        role: 'assistant',
        content: '',
        conversationId: convId,
        branchId: 'backstage',
        timestamp: Date.now()
      };
      messages.push(aiMsg);
    }

    isStreaming = true;
    abortCtrl = new AbortController();
    const fab = document.getElementById('backstage-fab');
    if (fab) fab.classList.add('generating');
    _updateSendButton();
    _renderMessages();

    const maxRetries = (typeof Chat !== 'undefined' && Chat.isRetryDisabled && Chat.isRetryDisabled()) ? 1 : 3;
    let retryCount = 0;

    const _doStream = (prefixContent) => {
    return new Promise((resolve) => {
      // v687.6：工具调用迭代计数
      let _toolIter = 0;
      const _MAX_TOOL_ITER = 5;
      // v687.7：工具调用累计计数
      let _toolsUsedCount = 0;
      // v687.8：工具日志
      const _toolsLog = [];
      // v687.11：累积工具调用前的内容
      // v687.41：断点续传时接收前缀
      let _priorContent = prefixContent || '';
        const bsSettings = _getSettings();

        // 工具集闭包
        const _enabledTools = (() => {
          let merged = [];
          if (typeof Tools !== 'undefined') {
            const allDefs = Tools.getBackstageDefinitions() || [];
            merged = allDefs.filter(d => {
              const name = d.function?.name || '';
              if (name.includes('backstage_note')) return bsSettings.toolsMemory;
              if (name.includes('directive')) return bsSettings.toolsDirective;
              if (name.startsWith('query_worldview_')) return bsSettings.toolsWorldview;
      if (['read_worldview_setting','update_worldview_setting','read_worldview_entry','update_worldview_entry','add_worldview_entry',
           'list_extension_entries','add_extension_entry','update_extension_entry','delete_extension_entry',
           'list_cards','read_card','update_card','undo_last_edit'].includes(name)) return bsSettings.toolsEdit;
      if (name === 'search_messages' || name === 'query_events' || name === 'query_relations') return bsSettings.toolsMainMemory;
              return bsSettings.toolsMemory;
            });
          }
          // v687.23：追加 MCP 工具
          try {
            if (typeof MCPClient !== 'undefined') {
              const mcpDefs = MCPClient.getEnabledToolDefs() || [];
              if (mcpDefs.length) merged = merged.concat(mcpDefs);
            }
          } catch(_) {}
          return merged.length > 0 ? merged : undefined;
        })();

        // === 闭包式回调 ===
        const _onChunk = (chunk, fullContent) => {
          // v687.11：拼接工具调用前的内容
          const merged = _priorContent ? (_priorContent + fullContent) : fullContent;
          aiMsg.content = baseContent + merged;
          const container = document.getElementById('backstage-messages');
          if (container) {
            const target = container.querySelector(`[data-id="${aiMsg.id}"] .md-content`);
            if (target) {
              target.innerHTML = aiMsg.content ? Markdown.render(aiMsg.content) : '<div class="typing-indicator"><span></span><span></span><span></span></div>';
            } else {
              _renderMessages();
            }
            container.scrollTop = container.scrollHeight;
          }
        };

        const _onDone = async (fullContent) => {
          // v687.11：拼接工具调用前的内容
          fullContent = _priorContent ? (_priorContent + fullContent) : fullContent;
          // 正则替换规则
          try {
            const regexRules = await Settings.getRegexRules();
            for (const rule of regexRules) {
              if (rule.enabled === false) continue;
              try { fullContent = fullContent.replace(new RegExp(rule.pattern, rule.flags || 'g'), rule.replacement ?? ''); } catch(e) {}
            }
          } catch(_) {}
aiMsg.content = baseContent + fullContent;
            aiMsg.timestamp = Date.now();
            // v687.7：工具使用数
            if (_toolsUsedCount > 0) aiMsg.toolsUsed = _toolsUsedCount;
            // v687.8：工具日志
            if (_toolsLog.length > 0) aiMsg.toolsLog = _toolsLog.slice();
            await DB.put('messages', aiMsg);
          _renderMessages();

          // 生图：解析 [IMG:] 标记
          try {
            const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
            if (conv && conv.convImgGen && /\[IMG:\s*[^\]]+\]/i.test(aiMsg.content)) {
              _processImgTagsBackstage(aiMsg).catch(e => console.warn('[Backstage] 生图标记处理失败', e));
            }
          } catch(_) {}

          resolve('done');
        };

        const _onError = async (error) => {
        if (error === 'AbortError') {
          if (aiMsg.content) {
            try { await DB.put('messages', aiMsg); } catch(e) {}
          }
          resolve('abort');
          return;
        }
        retryCount++;
        if (retryCount < maxRetries) {
          const partialContent = aiMsg.content || '';
          if (partialContent) {
            // v687.41：断点续传——保留已输出内容，作为前缀重试
            console.warn(`[Backstage] 断点续传重试 ${retryCount}/${maxRetries}: 已有 ${partialContent.length} 字`);
            apiMessages.push({ role: 'assistant', content: partialContent });
            await new Promise(r => setTimeout(r, 2000));
            _doStream(partialContent).then(resolve);
          } else {
            console.warn(`[Backstage] 重试 ${retryCount}/${maxRetries}: ${error}`);
            await new Promise(r => setTimeout(r, 1000));
            _doStream().then(resolve);
          }
        } else {
          const partialContent = aiMsg.content || '';
          if (partialContent) {
            aiMsg.content = partialContent;
            try { await DB.put('messages', aiMsg); } catch(e) {}
          } else {
            aiMsg.content = baseContent + `*生成失败（已重试${maxRetries}次）: ${error}*`;
          }
          _renderMessages();
          resolve('error');
        }
      };

        // 工具调用循环
        const _onToolCallsHandler = async (toolCalls, assistantMessage) => {
          try {
            _toolIter++;
            _toolsUsedCount += (toolCalls?.length || 0);
            // v687.11：保留本轮调工具前 AI 已经吐的文字
            try {
              const partial = assistantMessage?.content || '';
              if (partial) {
                _priorContent = (_priorContent ? _priorContent + '\n\n' : '') + partial;
              }
            } catch(_) {}
            console.log(`[Backstage] AI 调用工具（第 ${_toolIter}/${_MAX_TOOL_ITER} 轮，本轮${toolCalls?.length||0}个，累计${_toolsUsedCount}个）:`, toolCalls.map(t => t.function?.name).join(', '));

            apiMessages.push({
              role: 'assistant',
              content: assistantMessage.content || '',
              tool_calls: toolCalls
            });

            for (const tc of toolCalls) {
              let result;
              try {
                result = await Tools.execute(tc);
              } catch(e) {
                result = `工具执行异常：${e?.message || e}`;
              }
              apiMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name, content: result || '' });
              // v687.8：记录工具日志
              try {
                let parsedArgs = tc.function?.arguments;
                try { parsedArgs = JSON.parse(parsedArgs); } catch(_) {}
                _toolsLog.push({
                  name: tc.function?.name || '?',
                  args: parsedArgs,
                  result: String(result || ''),
                  iter: _toolIter,
                  ts: Date.now()
                });
              } catch(_) {}
            }

            const reachLimit = _toolIter >= _MAX_TOOL_ITER;
            if (reachLimit) {
              console.warn(`[Backstage] 工具调用达到 ${_MAX_TOOL_ITER} 次上限，强制收尾`);
            }

            const followOpts = overrideConfig ? { overrideConfig } : {};
            if (!reachLimit) {
              if (_enabledTools) followOpts.tools = _enabledTools;
              followOpts.onToolCalls = _onToolCallsHandler;
            }

            API.streamChat(
              apiMessages,
              _onChunk,
              _onDone,
              _onError,
              abortCtrl.signal,
              followOpts
            ).catch(() => resolve('error'));
          } catch(e) {
            console.error('[Backstage] tool calling 失败:', e);
            resolve('error');
          }
        };

        // 首次请求
        const opts = overrideConfig ? { overrideConfig } : {};
        if (_enabledTools) opts.tools = _enabledTools;
        opts.onToolCalls = _onToolCallsHandler;

        API.streamChat(
          apiMessages,
          _onChunk,
          _onDone,
          _onError,
          abortCtrl.signal,
          opts
        );
      });
    };

    try {
      await _doStream();
    } catch(e) {
      console.error('[Backstage] generation error:', e);
    }

    isStreaming = false;
    abortCtrl = null;
    document.getElementById('backstage-fab')?.classList.remove('generating');
    _updateSendButton();
  }

  // 发送消息
  async function send() {
    const input = document.getElementById('backstage-input');
    const text = input?.value.trim();
    if ((!text && pendingImages.length === 0 && pendingMemories.length === 0 && pendingFiles.length === 0) || isStreaming) return;
    // v687.19：立刻上锁防重入。isStreaming 要等 _runGeneration 才置位；
    //         开了天气感知时 captureSnapshot 要等 wttr.in 1-2s，期间用户重复点击会触发重入
    if (_sendLock) return;
    _sendLock = true;
    try {

    const convId = await _ensureConvId();
    if (!convId) { _sendLock = false; return; }

    // 显示文本（带附件标记）
    let displayText = text;
    if (pendingImages.length > 0) displayText += (displayText ? '\n' : '') + `[附加了${pendingImages.length}张图片]`;
    if (pendingMemories.length > 0) displayText += (displayText ? '\n' : '') + `[附加了${pendingMemories.length}条记忆]`;
    if (pendingFiles.length > 0) displayText += (displayText ? '\n' : '') + `[附加了${pendingFiles.length}个文件：${pendingFiles.map(f=>f.name).join('、')}]`;

    // 拼给 API 的文本（记忆内容拼到 text 里，图片走 multimodal）
    let apiText = text;
    if (pendingMemories.length > 0) {
      const memText = pendingMemories.map(m => `[手动附加记忆] ${m.title}: ${m.content}`).join('\n');
      apiText = (apiText ? apiText + '\n\n' : '') + memText;
    }
    if (pendingFiles.length > 0) {
      const fileText = pendingFiles.map(f => `<file name="${f.name}">\n${f.content}\n</file>`).join('\n\n');
      apiText = (apiText ? apiText + '\n\n' : '') + fileText;
    }
    let apiContent = apiText;
    if (pendingImages.length > 0) {
      apiContent = [{ type: 'text', text: apiText }];
      pendingImages.forEach(img => {
        apiContent.push({ type: 'image_url', image_url: { url: img.base64 } });
      });
    }

    const userMsg = {
      id: Utils.uuid(),
      role: 'user',
      content: displayText,
      conversationId: convId,
      branchId: 'backstage',
      timestamp: Date.now()
    };
    // v687.15：环境快照
    try {
      const _bs = _getSettings();
      if ((_bs.batteryAware || _bs.weatherAware) && window.EnvAwareness) {
        const snap = await EnvAwareness.captureSnapshot({
          battery: _bs.batteryAware,
          weather: _bs.weatherAware
        });
        if (snap) userMsg.envSnapshot = snap;
      }
    } catch(_) {}
    await DB.put('messages', userMsg);
    messages.push(userMsg);
    input.value = '';
    input.style.height = 'auto';

    // 清空附件状态
    pendingImages = [];
    pendingMemories = [];
    pendingFiles = [];
    _renderAttachments();
    _renderMessages();

    // 这一轮发给 API 的 history：把最后一条 user 替换成 multimodal/带记忆文本版本
    const historyForApi = messages.slice(0, -1).concat([{ ...userMsg, content: apiContent }]);
    await _runGeneration(historyForApi, null, false);
    } finally {
      _sendLock = false;
    }
  }

  // ===== 长按菜单 =====
  let pressTimer = null;
  let pressTarget = null;

  function initLongPress() {
    const container = document.getElementById('backstage-messages');
    if (!container || container.dataset.lpInit) return;
    container.dataset.lpInit = '1';

    container.addEventListener('touchstart', (e) => {
      const msgEl = e.target.closest('.chat-msg');
      if (!msgEl || !msgEl.dataset.id) return;
      pressTarget = msgEl;
      msgEl.classList.add('pressing');
      pressTimer = setTimeout(() => {
        const touch = e.touches[0];
        _showCtxMenu(msgEl.dataset.id, touch.clientX, touch.clientY);
        msgEl.classList.remove('pressing');
      }, 500);
    }, { passive: true });

    container.addEventListener('touchend', _cancelPress);
    container.addEventListener('touchmove', _cancelPress);

    container.addEventListener('contextmenu', (e) => {
      const msgEl = e.target.closest('.chat-msg');
      if (!msgEl || !msgEl.dataset.id) return;
      e.preventDefault();
      _showCtxMenu(msgEl.dataset.id, e.clientX, e.clientY);
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#bs-ctx-menu')) _closeCtxMenu();
      // 关闭加号菜单
      if (!e.target.closest('#backstage-plus-menu') && !e.target.closest('#backstage-plus-btn')) {
        _closePlusMenu();
      }
    });
  }

  function _cancelPress() {
    clearTimeout(pressTimer);
    if (pressTarget) pressTarget.classList.remove('pressing');
    pressTarget = null;
  }

  function _showCtxMenu(msgId, x, y) {
    _closeCtxMenu();
    const msg = messages.find(m => m.id === msgId);
    if (!msg) return;

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.id = 'bs-ctx-menu';
    menu.style.zIndex = '400';

    const items = [];
    if (msg.role === 'user') {
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg> 编辑', action: () => editMessage(msgId) });
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> 回溯到此处', action: () => rollbackAndRestore(msgId) });
      items.push({ sep: true });
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 删除', action: () => deleteMessage(msgId), danger: true });
    } else {
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg> 编辑', action: () => editMessage(msgId) });
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> 重写', action: () => regenerate(msgId) });
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M10.029 4.285A2 2 0 0 0 7 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/><path d="M3 4v16"/></svg> 继续', action: () => continueGenerate(msgId) });
      items.push({ sep: true });
      items.push({ label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;vertical-align:middle"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 删除', action: () => deleteMessage(msgId), danger: true });
    }

    items.forEach(item => {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
      } else {
        const btn = document.createElement('button');
        btn.className = 'ctx-item' + (item.danger ? ' danger' : '');
        btn.innerHTML = item.label;
        btn.onclick = (e) => { e.stopPropagation(); _closeCtxMenu(); item.action(); };
        menu.appendChild(btn);
      }
    });

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    let left = Math.min(Math.max(margin, x), maxX);
    let top = y;
    if (y + rect.height + margin > window.innerHeight) top = y - rect.height;
    top = Math.min(Math.max(margin, top), maxY);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function _closeCtxMenu() {
    const existing = document.getElementById('bs-ctx-menu');
    if (existing) existing.remove();
  }

  // ===== 消息操作 =====

  async function deleteMessage(msgId) {
    if (!await UI.showConfirm('确认删除', '确定删除这条消息？')) return;
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    try { await DB.del('messages', msgId); } catch(e) {}
    messages.splice(idx, 1);
    _renderMessages();
  }

  // v687.6：回溯到此处（用户气泡），把内容塞回输入框，删除该消息及之后的所有消息
  async function rollbackAndRestore(msgId) {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    const msg = messages[idx];
    const afterCount = messages.length - idx - 1;
    if (afterCount > 0) {
      let skip = false;
      try { skip = localStorage.getItem('skynex_rollbackConfirmSkip') === '1'; } catch(_) {}
      if (!skip) {
        const res = await UI.showConfirm('时光倒流准备中', `将删除此消息之后的 ${afterCount} 条消息，并同时回溯状态栏和手机数据。是否继续？`, { checkbox: '下次不再提醒' });
        if (!res.ok) return;
        if (res.checked) { try { localStorage.setItem('skynex_rollbackConfirmSkip', '1'); } catch(_) {} }
      }
    }
    // 内容回输入框
    const input = document.getElementById('backstage-input');
    if (input) {
      input.value = msg.content || '';
      try { input.focus(); } catch(_) {}
      try {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      } catch(_) {}
    }
    // 删除从该消息起的所有消息（包括它自己）
    const toDelete = messages.slice(idx);
    for (const m of toDelete) {
      try { await DB.del('messages', m.id); } catch(_) {}
    }
    messages.splice(idx);
    _renderMessages();
  }

  let _editingMsgId = null;
  async function editMessage(msgId) {
    const msg = messages.find(m => m.id === msgId);
    if (!msg) return;
    _editingMsgId = msgId;
    const ta = document.getElementById('backstage-msg-edit-input');
    if (ta) ta.value = msg.content || '';
    document.getElementById('backstage-msg-edit-modal').classList.remove('hidden');
    setTimeout(() => ta && ta.focus(), 50);
  }

  async function saveMsgEdit() {
    if (!_editingMsgId) { closeMsgEdit(); return; }
    const ta = document.getElementById('backstage-msg-edit-input');
    const newText = (ta?.value || '').trim();
    if (!newText) { UI.showToast('内容不能为空', 1500); return; }
    const msg = messages.find(m => m.id === _editingMsgId);
    if (msg) {
      msg.content = newText;
      msg.timestamp = Date.now();
      try { await DB.put('messages', msg); } catch(e) {}
      _renderMessages();
    }
    closeMsgEdit();
  }

  function closeMsgEdit() {
    _editingMsgId = null;
    document.getElementById('backstage-msg-edit-modal')?.classList.add('hidden');
  }

  async function regenerate(msgId) {
    if (isStreaming) { UI.showToast('当前正在生成中', 1500); return; }
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    const msg = messages[idx];
    if (msg.role !== 'assistant') return;
    // 删掉这条及之后所有消息
    const toRemove = messages.slice(idx);
    for (const m of toRemove) { try { await DB.del('messages', m.id); } catch(e) {} }
    messages = messages.slice(0, idx);
    _renderMessages();
    await _runGeneration(messages.slice(), null, false);
  }

  async function continueGenerate(msgId) {
    if (isStreaming) { UI.showToast('当前正在生成中', 1500); return; }
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    const msg = messages[idx];
    if (msg.role !== 'assistant') return;
    // 必须是最后一条
    if (idx !== messages.length - 1) {
      UI.showToast('只能从最后一条AI消息继续', 1800);
      return;
    }
    // 用 history 截到这条之前 + 该条作为前缀
    const history = messages.slice(0, idx + 1);
    await _runGeneration(history, msg, true);
  }



  // ===== 导出/导入聊天记录 =====
  async function exportHistory() {
    _closePlusMenu();
    if (messages.length === 0) { UI.showToast('当前后台没有消息', 1800); return; }
    const settings = _getSettings();
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const out = {
      _exportedBy: '天枢城后台频道',
      _exportedAt: new Date().toISOString(),
      _sourceConv: conv?.name || '',
      settings: {
        prompt: settings.prompt || '',
        contextCount: settings.contextCount,
        maxTokens: settings.maxTokens || 230000
      },
      messages: messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || 0
      }))
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `后台记录_${(conv?.name || '未命名').replace(/[\/\\:*?"<>|]/g, '_')}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    UI.showToast(`已导出 ${messages.length} 条消息`, 2000);
  }

  async function importHistory(input) {
    _closePlusMenu();
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      input.value = '';
      const data = JSON.parse(text);
      if (!Array.isArray(data.messages)) throw new Error('文件不包含 messages 数组');

      const isEmpty = messages.length === 0;
      let mode = 'append';
      if (!isEmpty) {
        const ok = await UI.showConfirm(
          '导入聊天记录',
          `当前后台已有 ${messages.length} 条消息，导入文件含 ${data.messages.length} 条。\n\n【确定】= 追加到现有记录之后\n【取消】= 不导入`
        );
        if (!ok) return;
      } else {
        mode = 'replace';
      }

      const convId = await _ensureConvId();
      if (!convId) return;

      const importedMsgs = [];
      for (const m of data.messages) {
        if (!m || !m.role || typeof m.content === 'undefined') continue;
        const msg = {
          id: Utils.uuid(),
          role: m.role,
          content: m.content,
          conversationId: convId,
          branchId: 'backstage',
          timestamp: m.timestamp || Date.now()
        };
        await DB.put('messages', msg);
        importedMsgs.push(msg);
      }

      // 选择是否一并导入设定（仅当现有 prompt 为空时）
      if (data.settings && mode === 'replace') {
        try {
          const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
          if (conv) {
            if (!conv.backstagePrompt && data.settings.prompt) conv.backstagePrompt = data.settings.prompt;
            if (!conv.backstageContextCount && data.settings.contextCount) conv.backstageContextCount = data.settings.contextCount;
            if (!conv.backstageMaxTokens && data.settings.maxTokens) conv.backstageMaxTokens = data.settings.maxTokens;
            await Conversations.saveList();
          }
        } catch(e) {}
      }

      messages = messages.concat(importedMsgs);
      _renderMessages();
      const container = document.getElementById('backstage-messages');
      if (container) container.scrollTop = container.scrollHeight;
      UI.showToast(`已导入 ${importedMsgs.length} 条消息`, 2500);
    } catch(e) {
      console.error('[Backstage.importHistory]', e);
      await UI.showAlert('导入失败', '文件格式错误。\n\n' + (e.message || ''));
      input.value = '';
    }
  }

  // 重启后台（清空消息）
  async function restart() {
    if (!await UI.showConfirm('重启后台', '清空后台频道的所有消息？主线剧情不受影响。')) return;
    const convId = _getSettings().convId;
    if (convId) {
const allMsgs = await DB.getAllByIndex('messages', 'conversationId', convId);
const toDelete = allMsgs.filter(m => m.branchId === 'backstage');
for (const m of toDelete) {
await DB.del('messages', m.id);
      }
    }
    messages = [];
    _renderMessages();
    UI.showToast('后台已重启');
  }

  // 后台要求编辑
  let _roleOptionsCache = null;  // 缓存所有可选角色

  function openPromptEdit() {
    const settings = _getSettings();
    document.getElementById('backstage-prompt-input').value = settings.prompt;
    const rulesEl = document.getElementById('backstage-rules-input');
    if (rulesEl) {
      rulesEl.value = settings.rules || '';
      const countEl = document.getElementById('backstage-rules-count');
      if (countEl) countEl.textContent = (settings.rules || '').length + ' / 2000';
    }
    document.getElementById('backstage-context-count').value = settings.contextCount;
    document.getElementById('backstage-max-tokens').value = settings.maxTokens || 8000;
    const taEl = document.getElementById('backstage-time-aware');
    if (taEl) taEl.checked = settings.timeAware;
    // v687.14：电量/天气
    const baEl = document.getElementById('backstage-battery-aware');
    if (baEl) baEl.checked = settings.batteryAware;
    const waEl = document.getElementById('backstage-weather-aware');
    if (waEl) waEl.checked = settings.weatherAware;
    const wcEl = document.getElementById('backstage-weather-city');
    if (wcEl && window.EnvAwareness) wcEl.value = EnvAwareness.getCity();
    const toolsMemEl = document.getElementById('backstage-tools-memory');
    if (toolsMemEl) toolsMemEl.checked = settings.toolsMemory;
    const toolsDirEl = document.getElementById('backstage-tools-directive');
    if (toolsDirEl) toolsDirEl.checked = settings.toolsDirective;
    const toolsWvEl = document.getElementById('backstage-tools-worldview');
    if (toolsWvEl) toolsWvEl.checked = settings.toolsWorldview;
    const toolsEditEl = document.getElementById('backstage-tools-edit');
    if (toolsEditEl) toolsEditEl.checked = settings.toolsEdit;
    const toolsMmEl = document.getElementById('backstage-tools-mainmemory');
    if (toolsMmEl) toolsMmEl.checked = settings.toolsMainMemory;
    const crossEl = document.getElementById('backstage-cross-window');
    if (crossEl) crossEl.checked = settings.crossWindow;
    // 身份认知
    const roleNameEl = document.getElementById('backstage-role-name');
    if (roleNameEl) roleNameEl.textContent = settings.roleName || '自由';
    const roleDisplay = document.getElementById('backstage-role-display');
    if (roleDisplay) {
      roleDisplay.dataset.roleId = settings.roleId || '';
      roleDisplay.dataset.roleType = settings.roleType || '';
      roleDisplay.dataset.roleSourceWvId = settings.roleSourceWvId || '';
      roleDisplay.dataset.roleName = settings.roleName || '';
    }
    const picker = document.getElementById('backstage-role-picker');
    if (picker) picker.classList.add('hidden');
    _roleOptionsCache = null;
    document.getElementById('backstage-prompt-modal').classList.remove('hidden');
  }

  async function _loadRoleOptions() {
    if (_roleOptionsCache) return _roleOptionsCache;
    const options = [];
    // 自由
    options.push({ id: '', type: '', name: '自由', group: '不选择身份' });
    // 单人卡
    try {
      const cards = await SingleCard.getAll();
      cards.forEach(c => {
        if (c.id && c.name) {
          options.push({ id: c.id, type: 'card', name: c.name, aliases: c.aliases || '', group: '单人卡' });
        }
      });
    } catch(_) {}
    // 世界观 NPC（全部世界观，不只是当前对话挂的）
    try {
      const wvs = await DB.getAll('worldviews');
      wvs.forEach(wv => {
        if (!wv || wv._hidden) return;
        const wvName = wv.name || '未命名世界观';
        (wv.globalNpcs || []).forEach(n => {
          if (n.id && n.name) {
            options.push({
              id: n.id, type: 'wv_npc', sourceWvId: wv.id,
              name: n.name, aliases: n.aliases || '',
              group: `${wvName} · 全图常驻`
            });
          }
        });
        (wv.regions || []).forEach(r => {
          (r.factions || []).forEach(f => {
            (f.npcs || []).forEach(n => {
              if (n.id && n.name) {
                options.push({
                  id: n.id, type: 'wv_npc', sourceWvId: wv.id,
                  name: n.name, aliases: n.aliases || '',
                  group: `${wvName} · ${r.name || '?'} / ${f.name || '?'}`
                });
              }
            });
          });
        });
      });
    } catch(_) {}
    // 单人卡绑定的世界书（v632：原 __sc_* 已迁移为 lorebooks）
    try {
      if (typeof Lorebook !== 'undefined') {
        const lbs = await Lorebook.getAll();
        const cards = await SingleCard.getAll();
        // 反向索引：lbId -> 引用它的卡名列表
        const refByLb = {};
        cards.forEach(c => {
          (c.lorebookIds || []).forEach(lbId => {
            if (!refByLb[lbId]) refByLb[lbId] = [];
            refByLb[lbId].push(c.name || '单人卡');
          });
        });
        lbs.forEach(wv => {
          if (!wv || !wv.id) return;
          const refCards = refByLb[wv.id] || [];
          // 没卡引用的世界书不在角色选择器里出（避免污染）
          if (refCards.length === 0) return;
          const lbLabel = wv.name || '世界书';
          (wv.globalNpcs || []).forEach(n => {
            if (n.id && n.name) {
              options.push({
                id: n.id, type: 'wv_npc', sourceWvId: wv.id,
                name: n.name, aliases: n.aliases || '',
                group: `${lbLabel} · 常驻角色`
              });
            }
          });
          (wv.regions || []).forEach(r => {
            (r.factions || []).forEach(f => {
              (f.npcs || []).forEach(n => {
                if (n.id && n.name) {
                  options.push({
                    id: n.id, type: 'wv_npc', sourceWvId: wv.id,
                    name: n.name, aliases: n.aliases || '',
                    group: `${lbLabel} · ${r.name || '?'} / ${f.name || '?'}`
                  });
                }
              });
            });
          });
        });
      }
    } catch(_) {}
    _roleOptionsCache = options;
    return options;
  }

  async function toggleRolePicker(ev) {
    if (ev) ev.stopPropagation();
    const picker = document.getElementById('backstage-role-picker');
    if (!picker) return;
    if (picker.classList.contains('hidden')) {
      await _renderRolePicker('');
      picker.classList.remove('hidden');
      const inp = document.getElementById('backstage-role-search');
      if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
    } else {
      picker.classList.add('hidden');
    }
  }

  async function _renderRolePicker(filterText) {
    const list = document.getElementById('backstage-role-list');
    if (!list) return;
    const options = await _loadRoleOptions();
    const kw = String(filterText || '').trim().toLowerCase();
    const filtered = kw ? options.filter(o =>
      String(o.name).toLowerCase().includes(kw) ||
      String(o.aliases || '').toLowerCase().includes(kw) ||
      (o.id === '' && '自由'.includes(kw))
    ) : options;
    if (filtered.length === 0) {
      list.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-secondary);font-size:12px">没有匹配的角色</div>';
      return;
    }
    // 按 group 分组
    const groups = {};
    const order = [];
    filtered.forEach(o => {
      const g = o.group || '其他';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(o);
    });
    let html = '';
    order.forEach(g => {
      html += `<div style="font-size:11px;color:var(--text-secondary);padding:6px 8px 2px;font-weight:600">${_esc(g)}</div>`;
      groups[g].forEach(o => {
        const dataset = `data-id="${_esc(o.id || '')}" data-type="${_esc(o.type || '')}" data-source-wv="${_esc(o.sourceWvId || '')}" data-name="${_esc(o.name)}"`;
        const aliasStr = o.aliases ? ` <span style="color:var(--text-secondary);font-size:11px">（${_esc(o.aliases)}）</span>` : '';
        html += `<div ${dataset} onclick="Backstage.selectRole(this)" style="padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--text);transition:background 0.15s" onmouseover="this.style.background='var(--bg-tertiary)'" onmouseout="this.style.background=''">${_esc(o.name)}${aliasStr}</div>`;
      });
    });
    list.innerHTML = html;
  }

  function _esc(s) {
const map = {'&':'&amp;','<':'&lt;','>':'&gt;'};
map['"'] = '&' + 'quot;';
map["'"] = '&' + '#39;';
return String(s == null ? '' : s).replace(/[&<>"']/g, c => map[c]);
}

  async function filterRolePicker() {
    const inp = document.getElementById('backstage-role-search');
    await _renderRolePicker(inp?.value || '');
  }

  function selectRole(el) {
    const id = el.dataset.id || '';
    const type = el.dataset.type || '';
    const sourceWv = el.dataset.sourceWv || '';
    const name = el.dataset.name || '自由';
    const display = document.getElementById('backstage-role-display');
    if (display) {
      display.dataset.roleId = id;
      display.dataset.roleType = type;
      display.dataset.roleSourceWvId = sourceWv;
      display.dataset.roleName = name;
    }
    const nameEl = document.getElementById('backstage-role-name');
    if (nameEl) nameEl.textContent = name;
    const picker = document.getElementById('backstage-role-picker');
    if (picker) picker.classList.add('hidden');
  }

  async function savePrompt() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) return;
    conv.backstagePrompt = document.getElementById('backstage-prompt-input').value.trim();
    const rulesInput = document.getElementById('backstage-rules-input');
    conv.backstageRules = rulesInput ? rulesInput.value.trim().slice(0, 2000) : '';
    conv.backstageContextCount = parseInt(document.getElementById('backstage-context-count').value) || 200;
    conv.backstageMaxTokens = parseInt(document.getElementById('backstage-max-tokens').value) || 230000;
    const taEl = document.getElementById('backstage-time-aware');
    if (taEl) conv.backstageTimeAware = taEl.checked;
    // v687.14：电量/天气
    const baEl = document.getElementById('backstage-battery-aware');
    if (baEl) conv.backstageBatteryAware = baEl.checked;
    const waEl = document.getElementById('backstage-weather-aware');
    if (waEl) conv.backstageWeatherAware = waEl.checked;
    const wcSaveEl = document.getElementById('backstage-weather-city');
    if (wcSaveEl && window.EnvAwareness) EnvAwareness.setCity(wcSaveEl.value);
    const toolsMemEl = document.getElementById('backstage-tools-memory');
    if (toolsMemEl) conv.backstageToolsMemory = toolsMemEl.checked;
    const toolsDirEl = document.getElementById('backstage-tools-directive');
    if (toolsDirEl) conv.backstageToolsDirective = toolsDirEl.checked;
    const toolsWvEl = document.getElementById('backstage-tools-worldview');
    if (toolsWvEl) conv.backstageToolsWorldview = toolsWvEl.checked;
    const toolsEditSaveEl = document.getElementById('backstage-tools-edit');
    if (toolsEditSaveEl) conv.backstageToolsEdit = toolsEditSaveEl.checked;
    const toolsMmEl = document.getElementById('backstage-tools-mainmemory');
    if (toolsMmEl) conv.backstageToolsMainMemory = toolsMmEl.checked;
    const crossEl = document.getElementById('backstage-cross-window');
    if (crossEl) conv.backstageCrossWindow = crossEl.checked;
    // 身份认知
    const display = document.getElementById('backstage-role-display');
    if (display) {
      conv.backstageRoleId = display.dataset.roleId || '';
      conv.backstageRoleType = display.dataset.roleType || '';
      conv.backstageRoleSourceWvId = display.dataset.roleSourceWvId || '';
      conv.backstageRoleName = display.dataset.roleName || '';
    }
    await Conversations.saveList();
    closePromptEdit();
    UI.showToast('后台设定已保存');
  }

  function closePromptEdit() {
  const modal = document.getElementById('backstage-prompt-modal');
  const content = modal?.querySelector('.modal-content');
  if (!modal) return;
  modal.classList.add('closing');
  if (content) content.classList.add('closing');
  setTimeout(() => {
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
  }, 220);
}

  // 解析后台 AI 回复中的 [IMG:] 标记，逐个生图，替换为 markdown 图片
  async function _processImgTagsBackstage(aiMsg) {
    const regex = /\[IMG:\s*([^\]]+)\]/gi;
    const matches = [...aiMsg.content.matchAll(regex)];
    if (matches.length === 0) return;

    // 先把所有 [IMG:] 替换为"正在生成…"占位，避免用户看到原始英文描述
    let tempContent = aiMsg.content;
    matches.forEach((m, i) => {
      tempContent = tempContent.split(m[0]).join(`[正在生成图片${matches.length > 1 ? (i+1) : ''}…]`);
    });
    aiMsg.content = tempContent;
    await DB.put('messages', aiMsg);
    _renderMessages();

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const placeholder = `[正在生成图片${matches.length > 1 ? (i+1) : ''}…]`;
      const desc = m[1].trim();
      try {
        const images = await API.generateImage(desc, { n: 1, size: '1024x768' });
        if (images && images.length > 0) {
          // 存到 drawnImages 表，content 只放占位符 [TSIMG:id|desc]
          const imgId = 'img_' + Utils.uuid();
          await DB.put('drawnImages', {
            id: imgId,
            dataUrl: images[0],
            prompt: desc,
            createdAt: Date.now()
          });
          const safeDesc = desc.substring(0, 60).replace(/[\[\]\|\n]/g, ' ');
          aiMsg.content = aiMsg.content.split(placeholder).join(`[TSIMG:${imgId}|${safeDesc}]`);
          await DB.put('messages', aiMsg);
          _renderMessages();
        } else {
          aiMsg.content = aiMsg.content.split(placeholder).join(`\n\n> ⚠ 图片生成失败：未返回数据\n\n`);
          await DB.put('messages', aiMsg);
          _renderMessages();
        }
      } catch(e) {
        aiMsg.content = aiMsg.content.split(placeholder).join(`\n\n> ⚠ 图片生成失败：${e.message}\n\n`);
        await DB.put('messages', aiMsg);
        _renderMessages();
      }
    }
  }

  // 更新悬浮按钮显隐（对话切换时调用）
  function updateFab() {
    const fab = document.getElementById('backstage-fab');
    if (!fab) return;
    const settings = _getSettings();
    if (settings.enabled) {
      fab.classList.remove('hidden');
    } else {
      fab.classList.add('hidden');
      // 如果窗口开着也关掉
      if (isOpen) minimize();
    }
  }

  // v687.8：查看本条 AI 消息的工具调用日志（复用 Chat 的实现思路）
  function _showToolsLog(msgId) {
    const msg = messages.find(m => m.id === msgId);
    if (!msg || !msg.toolsLog || msg.toolsLog.length === 0) {
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast('该消息没有工具调用记录', 1500);
      return;
    }
    const fmtTs = (ts) => {
      try {
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      } catch(_) { return ''; }
    };
    const lines = [];
    lines.push(`=== 后台 · 工具调用日志 ===`);
    lines.push(`消息 ID: ${msgId}`);
    lines.push(`共调用 ${msg.toolsLog.length} 个工具（${msg.toolsUsed || msg.toolsLog.length} 次）`);
    lines.push('');
    msg.toolsLog.forEach((log, i) => {
      lines.push('='.repeat(60));
      lines.push(`[${i + 1}/${msg.toolsLog.length}] ${log.name}  (第${log.iter}轮 · ${fmtTs(log.ts)})`);
      lines.push('-'.repeat(60));
      lines.push('参数:');
      try { lines.push(JSON.stringify(log.args, null, 2)); }
      catch(_) { lines.push(String(log.args)); }
      lines.push('');
      lines.push('返回:');
      lines.push(String(log.result || '(空)'));
      lines.push('');
    });
    const ta = document.getElementById('edit-content');
    if (ta) {
      ta.value = lines.join('\n');
      const editModal = document.getElementById('edit-modal');
      // v687.13：重挂 body 末尾避免被 backstage-modal transform stacking context 夹住
      try { document.body.appendChild(editModal); } catch(_) {}
      editModal.style.zIndex = '99999';
      editModal.classList.remove('hidden');
      editModal.dataset.editId = '__debug__';
      if (typeof UI !== 'undefined' && UI.switchDebugTab) UI.switchDebugTab('debug-context');
    }
  }

  return {
    toggle, minimize, send, cancel, restart,
    editMessage, saveMsgEdit, closeMsgEdit, deleteMessage, regenerate, continueGenerate,
    togglePlusMenu, attachImage, onImagePicked,
    attachFile, onFilePicked, previewFile,
    pickMemories, filterPickMemories, _togglePickMem, confirmPickMemories, closeMemPick,
    removeAttach, exportHistory, importHistory,
    openPromptEdit, savePrompt, closePromptEdit,
toggleRolePicker, filterRolePicker, selectRole,
    updateFab,
    _showToolsLog,
    // 给手动生图弹窗用：把指定消息追加进后台消息列表并刷新渲染
    appendExternalMessage: async (msg) => {
      try {
        await _ensureConvId();
        await _loadMessages();
        messages.push(msg);
        _renderMessages();
      } catch(e) { console.warn('[Backstage] appendExternalMessage failed', e); }
    }
  };
})();
