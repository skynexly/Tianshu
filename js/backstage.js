/**
 * 后台频道 — 寄生在主线对话上的独立聊天窗口
 */
const Backstage = (() => {
let isOpen = false;
let messages = [];
let isStreaming = false;
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
      contextCount: conv?.backstageContextCount ?? 15,
      maxTokens: conv?.backstageMaxTokens ?? 8000,
      convId: conv?.backstageConvId || null,
      timeAware: conv?.backstageTimeAware !== false  // 默认开
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
const contentHtml = isUser
? Utils.escapeHtml(m.content)
: (m.content
? Markdown.render(m.content)
: '<div class="typing-indicator"><span></span><span></span><span></span></div>');
return `<div class="backstage-msg-wrap ${isUser ? 'user' : 'assistant'}">
<div class="chat-msg ${isUser ? 'user' : 'assistant'}" data-id="${m.id}">
<div class="md-content">${contentHtml}</div>
</div>
</div>`;
}).join('');
    container.scrollTop = container.scrollHeight;
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
    if (abortCtrl && isStreaming) {
      try { abortCtrl.abort(); } catch(e) {}
    }
    isStreaming = false;
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
      alert(f.content.slice(0, 2000));
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
        <button class="remove-attach" onclick="Backstage.removeAttach('image',${i})">✕</button>
      </div>`;
    });
    pendingMemories.forEach((m, i) => {
      html += `<div class="attach-item">
        <span style="display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z" clip-rule="evenodd" /></svg>${Utils.escapeHtml(m.title || '记忆')}</span>
        <button class="remove-attach" onclick="Backstage.removeAttach('memory',${i})">✕</button>
      </div>`;
    });
    pendingFiles.forEach((f, i) => {
      html += `<div class="attach-item" style="cursor:pointer" onclick="Backstage.previewFile(${i})" title="点击预览">
        <span style="display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0 0 16.5 9h-1.875a1.875 1.875 0 0 1-1.875-1.875V5.25A3.75 3.75 0 0 0 9 1.5H5.625Z" clip-rule="evenodd" /></svg>${Utils.escapeHtml(f.name)}</span>
        <button class="remove-attach" onclick="event.stopPropagation();Backstage.removeAttach('file',${i})">✕</button>
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
          const mainCharText = await SingleMode.getMainCharPrompt(singleSettings);
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
    try {
      const curWvId = Worldview.getCurrentId && Worldview.getCurrentId();
      let _wvForGlobal = null;
      if (window.SingleMode) {
        const ss = SingleMode.getCurrentSingleSettings && SingleMode.getCurrentSingleSettings();
        if (ss && ss.worldviewId) _wvForGlobal = await DB.get('worldviews', ss.worldviewId);
      }
      if (!_wvForGlobal && curWvId && curWvId !== '__default_wv__') {
        _wvForGlobal = await DB.get('worldviews', curWvId);
      }
      const gs = (_wvForGlobal && _wvForGlobal.globalNpcs) || [];
      if (gs.length > 0) {
        const text = '【全图常驻 NPC】\n以下 NPC 不受地区限制，在本世界观下全程常驻，随时可以出现在任何场景中。\n\n' +
          gs.map(n => {
            const head = n.aliases ? `${n.name}（${n.aliases}）` : (n.name || '未命名');
            return n.detail ? `${head}\n${n.detail}` : head;
          }).join('\n\n---\n\n');
        systemParts.push(text);
      }
    } catch(e) {}

    try {
      const summaryText = await Summary.formatForPrompt(Conversations.getCurrent());
      if (summaryText) systemParts.push(summaryText);
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

    // 全局：手机操作日志（后台独立队列，与主线互不干扰）
    try {
      if (typeof Phone !== 'undefined' && Phone.flushActionLogForBackstage) {
        const log = Phone.flushActionLogForBackstage();
        if (log && log.length > 0) {
          const logText = '【玩家手机操作日志（仅后台可见）｜OOC】\n以下是玩家"{{user}}"自上次后台同步以来，在自己手机上进行的全部操作。后台可以基于此观察玩家行为轨迹（操作主体永远是玩家本人，不是任何剧情角色）：\n' +
            log.map(a => `- {{user}} ${a}`).join('\n');
          systemParts.push(logText);
        }
      }
    } catch(e) {}
    const settings = _getSettings();
    let backstageInstruction = '';
    if (settings.prompt) {
      backstageInstruction += '【用户对后台AI的要求】\n' + settings.prompt + '\n\n';
    }
    backstageInstruction += '【后台频道】\n你现在在后台频道。这里的对话完全独立于主线剧情，不会影响任何正在进行的故事。\n不需要遵循回复格式，自由回应即可。你清楚{{user}}实际存在于三次元，而非是剧情中的Ta扮演的角色。可以讨论剧情、吐槽、聊设定、回答问题、聊聊现实中的生活等。';
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

    const historyForAPI = historyMsgs.map(m => ({ role: m.role, content: m.content }));
    // 用户消息拼时间戳（后台默认开）
    let stampedHistory = historyForAPI;
    if (settings.timeAware && window.TimeAwareness) {
      try { stampedHistory = TimeAwareness.stampUserMessages(historyForAPI, historyMsgs); } catch(e) {}
    }
    const apiMessages = await API.buildMessages(stampedHistory, systemParts);

    const maxTokens = settings.maxTokens || 8000;
    const _estimateTokens = (msgs) => msgs.reduce((sum, m) => sum + Math.ceil((m.content || '').length / 2), 0);
    while (_estimateTokens(apiMessages) > maxTokens && apiMessages.length > 2) {
      const idx = apiMessages.findIndex(m => m.role !== 'system');
      if (idx === -1) break;
      apiMessages.splice(idx, 1);
    }
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

    const maxRetries = 3;
    let retryCount = 0;

    const _doStream = () => {
      return new Promise((resolve) => {
        API.streamChat(
          apiMessages,
          (chunk, fullContent) => {
            aiMsg.content = baseContent + fullContent;
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
          },
          async (fullContent) => {
            aiMsg.content = baseContent + fullContent;
            aiMsg.timestamp = Date.now();
            await DB.put('messages', aiMsg);
            _renderMessages();
            resolve('done');
          },
          async (error) => {
            if (error === 'AbortError') {
              // 保存已经生成的部分
              if (aiMsg.content) {
                try { await DB.put('messages', aiMsg); } catch(e) {}
              }
              resolve('abort');
              return;
            }
            retryCount++;
            if (retryCount < maxRetries) {
              console.warn(`[Backstage] 重试 ${retryCount}/${maxRetries}: ${error}`);
              await new Promise(r => setTimeout(r, 1000));
              _doStream().then(resolve);
            } else {
              aiMsg.content = baseContent + `*生成失败（已重试${maxRetries}次）: ${error}*`;
              _renderMessages();
              resolve('error');
            }
          },
          abortCtrl.signal,
          overrideConfig ? { overrideConfig } : undefined
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

    const convId = await _ensureConvId();
    if (!convId) return;

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
        maxTokens: settings.maxTokens || 8000
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
  function openPromptEdit() {
    const settings = _getSettings();
    document.getElementById('backstage-prompt-input').value = settings.prompt;
    document.getElementById('backstage-context-count').value = settings.contextCount;
    document.getElementById('backstage-max-tokens').value = settings.maxTokens || 8000;
    const taEl = document.getElementById('backstage-time-aware');
    if (taEl) taEl.checked = settings.timeAware;
    document.getElementById('backstage-prompt-modal').classList.remove('hidden');
  }

  async function savePrompt() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv) return;
    conv.backstagePrompt = document.getElementById('backstage-prompt-input').value.trim();
    conv.backstageContextCount = parseInt(document.getElementById('backstage-context-count').value) || 15;
    conv.backstageMaxTokens = parseInt(document.getElementById('backstage-max-tokens').value) || 8000;
    const taEl = document.getElementById('backstage-time-aware');
    if (taEl) conv.backstageTimeAware = taEl.checked;
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

  return {
    toggle, minimize, send, cancel, restart,
    editMessage, saveMsgEdit, closeMsgEdit, deleteMessage, regenerate, continueGenerate,
    togglePlusMenu, attachImage, onImagePicked,
    attachFile, onFilePicked, previewFile,
    pickMemories, filterPickMemories, _togglePickMem, confirmPickMemories, closeMemPick,
    removeAttach, exportHistory, importHistory,
    openPromptEdit, savePrompt, closePromptEdit,
    updateFab
  };
})();
