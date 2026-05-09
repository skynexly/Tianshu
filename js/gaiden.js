/**
 * Gaiden（番外）模块 — 生成番外故事 + 番外库管理
 */
const Gaiden = (() => {
  let gaidenList = []; // { id, title, content, sourceConv, sourceConvName, created }
  let currentDraft = null; // 正在生成/预览的番外
  let isGenerating = false;
  let _abortCtrl = null;

  // ===== 状态条切换 =====
  function _showStatusBar(areaId, mode = 'generate') {
    const area = document.getElementById(areaId);
    if (!area) return;
    const isContinue = mode === 'continue';
    const subtext = isContinue
      ? '正在读取已保存番外并续写后文…'
      : areaId === 'gaiden-picker-action-area'
        ? '正在整理所选对话与设定…'
        : '正在整理上下文与设定…';
    area.innerHTML = `<div class="gaiden-status-bar">
      <div class="gaiden-status-indicator" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <div class="gaiden-status-copy">
        <div class="gaiden-status-title">${isContinue ? '正在续写番外' : '正在生成番外'}</div>
        <div class="gaiden-status-subtext">${subtext}</div>
      </div>
      <button type="button" class="gaiden-stop-btn" onclick="Gaiden.abort()" title="终止">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
      </button>
    </div>`;
  }

  function _showSendBtn(areaId, btnId, label, onclick) {
    const area = document.getElementById(areaId);
    if (!area) return;
    area.innerHTML = `<button id="${btnId}" onclick="${onclick}" style="width:100%;background:var(--accent);color:#000;border:none;padding:10px 16px;border-radius:6px;cursor:pointer;font-size:13px">${label}</button>`;
  }

  function _showError(areaId, btnId, label, onclick, msg) {
    const area = document.getElementById(areaId);
    if (!area) return;
    area.innerHTML = `<div style="font-size:12px;color:var(--danger);margin-bottom:8px">${Utils.escapeHtml(msg)}</div>
      <button id="${btnId}" onclick="${onclick}" style="width:100%;background:var(--accent);color:#000;border:none;padding:10px 16px;border-radius:6px;cursor:pointer;font-size:13px">${label}</button>`;
  }

  function _showResultActions() {
    const area = document.getElementById('gaiden-result-actions');
    if (!area) return;
    area.innerHTML = `<button onclick="Gaiden.rewrite()" style="flex:1;background:none;border:1px solid var(--border);color:var(--text-secondary)">重写</button>
<button onclick="Gaiden.continueDraft()" style="flex:1;background:none;border:1px solid var(--accent);color:var(--accent)">续写</button>
<button onclick="Gaiden.saveDraft()" style="flex:1;background:var(--accent);color:#000;border:none">保存番外</button>`;
  }

  function abort() {
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
    isGenerating = false;
    _showSendBtn('gaiden-action-area', 'gaiden-send-btn', '发送', 'Gaiden.generate()');
    _showSendBtn('gaiden-picker-action-area', 'gaiden-picker-send-btn', '生成番外', 'Gaiden.generateFromPicker()');
    UI.showToast('已终止生成');
  }

  // ===== 初始化 =====

  async function init() {
    const data = await DB.get('gameState', 'gaidenList');
    gaidenList = data?.value || [];
  }

  async function saveList() {
    await DB.put('gameState', { key: 'gaidenList', value: gaidenList });
  }

  // 供外部模块（如WorldVoice）往收藏列表添加条目
  function addToList(item) {
    gaidenList.unshift(item);
    // 如果收藏库面板正在显示，立即刷新
    const panel = document.getElementById('panel-gaiden');
    if (panel && panel.classList.contains('active')) {
      renderList();
    }
  }

  // ===== 获取番外 API 配置 =====

  function getGaidenConfig() {
    return Settings.getGaidenConfig();
  }

  // ===== 生成番外 =====

  function openGenerateModal() {
    const modal = document.getElementById('gaiden-generate-modal');
    if (!modal) return;
    document.getElementById('gaiden-requirement').value = '';
    _showSendBtn('gaiden-action-area', 'gaiden-send-btn', '发送', 'Gaiden.generate()');
    document.getElementById('gaiden-result-area').classList.add('hidden');
    document.getElementById('gaiden-input-area').classList.remove('hidden');
    currentDraft = null;
    _showResultActions();
    modal.classList.remove('hidden');
    // 关闭加号菜单
    document.getElementById('plus-menu')?.classList.add('hidden');
  }

  async function generate() {
    if (isGenerating) return;
    const requirement = document.getElementById('gaiden-requirement').value.trim();
    if (!requirement) { UI.showToast('请输入番外要求'); return; }

    const funcConfig = getGaidenConfig();
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl).replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;

    if (!url || !key || !model) {
      UI.showToast('请先在设置→功能模型中配置番外模型');
      return;
    }

    // 收集当前窗口上下文
    const messages = Chat.getMessages();
    if (messages.length === 0) {
      UI.showToast('当前窗口没有消息，无法生成番外');
      return;
    }

    const contextText = messages.map(m => `[${m.role === 'user' ? '玩家' : 'AI'}]: ${m.content}`).join('\n\n');

    // 收集世界观和角色设定
    const wvPrompt = Chat.getWorldviewPrompt() || '';
    const char = await Character.get();
    const charPrompt = char ? Character.formatForPrompt(char) : '';

    isGenerating = true;
    _abortCtrl = new AbortController();
    _showStatusBar('gaiden-action-area');

    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
    const systemPrompt = `你是一位出色的故事创作者。用户将给你一段互动小说/文字游戏的对话记录作为上下文，以及对番外故事的要求。
请根据上下文和要求，创作一篇完整的番外短篇故事。
要求：
1. 保持角色性格和世界观一致
2. 故事要完整，有开头、发展和结尾
3. 文风和原文保持协调
4. 不要加任何元信息或说明
5. 严格遵循用户角色设定中的所有属性（性别、外貌、性格等），不得自行修改
6. 第一行只写标题（不加#号和任何符号），第二行留空，第三行开始写正文`;

        let userPrompt = '';
        if (wvPrompt) userPrompt += `## 世界观设定\n\n${wvPrompt}\n\n`;
        if (charPrompt) userPrompt += `## 用户角色设定\n\n${charPrompt}\n\n`;
        userPrompt += `## 当前剧情上下文\n\n${contextText}\n\n## 番外要求\n\n${requirement}\n\n请创作番外故事。`;

        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            stream: false,
            temperature: 0.85,
            max_tokens: 4096
          }),
          signal: _abortCtrl?.signal
        });

        if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
        const json = await resp.json();
        const content = json.choices?.[0]?.message?.content || '';

        if (!content) throw new Error('AI返回了空内容');

        // 解析标题和正文
        const lines = content.split('\n');
        const autoTitle = (lines[0] || '').replace(/^[#\s*]+/, '').trim().slice(0, 30) || '未命名番外';
        let bodyStart = 1;
        while (bodyStart < lines.length && !lines[bodyStart].trim()) bodyStart++;
        const bodyContent = lines.slice(bodyStart).join('\n');

        currentDraft = {
          id: 'gaiden_' + Utils.uuid().slice(0, 8),
          title: autoTitle,
          content: bodyContent,
          requirement: requirement,
          sourceConv: Conversations.getCurrent(),
          sourceConvName: Conversations.getCurrentName(),
          created: Date.now()
        };

        // 切换到结果视图
        document.getElementById('gaiden-input-area').classList.add('hidden');
        document.getElementById('gaiden-result-area').classList.remove('hidden');
        document.getElementById('gaiden-result-title').value = currentDraft.title;
        document.getElementById('gaiden-result-content').innerHTML = Markdown.render(currentDraft.content);

        _notifyDone();
        lastError = null;
        break; // 成功
      } catch(e) {
        if (e.name === 'AbortError') return;
        lastError = e;
        if (attempt < maxRetries) {
          UI.showToast(`生成失败，正在重试（${attempt}/${maxRetries}）…`, 3000);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }

    if (lastError) {
      console.error('[Gaiden] generate error:', lastError);
      _showError('gaiden-action-area', 'gaiden-send-btn', '发送', 'Gaiden.generate()', `生成失败（已重试${maxRetries}次）: ${lastError.message}`);
      UI.showToast(`番外生成失败，已重试${maxRetries}次`, 4000);
    }

    isGenerating = false;
    _abortCtrl = null;
  }

  // ===== 保存/续写辅助 =====

  function _syncDraftFromResultInputs() {
    if (!currentDraft) return;
    const titleInput = document.getElementById('gaiden-result-title');
    if (titleInput) currentDraft.title = titleInput.value.trim() || currentDraft.title;
  }

  async function _ensureDraftSaved({ silent = false } = {}) {
    if (!currentDraft) return null;
    _syncDraftFromResultInputs();
    let existing = currentDraft.savedId
      ? gaidenList.find(g => g.id === currentDraft.savedId)
      : gaidenList.find(g => g.id === currentDraft.id);

    if (existing) {
      Object.assign(existing, currentDraft, {
        id: existing.id,
        type: existing.type || 'gaiden',
        updated: Date.now()
      });
      currentDraft.savedId = existing.id;
    } else {
      const item = {
        ...currentDraft,
        id: currentDraft.id || ('gaiden_' + Utils.uuid().slice(0, 8)),
        type: currentDraft.type || 'gaiden',
        created: currentDraft.created || Date.now(),
        savedAt: currentDraft.savedAt || Date.now()
      };
      gaidenList.unshift(item);
      currentDraft.savedId = item.id;
      existing = item;
    }
    await saveList();
    renderList();
    if (!silent) UI.showToast('番外已保存');
    return existing;
  }

  function _appendGaidenContent(base, addition) {
    const a = String(base || '').trimEnd();
    const b = String(addition || '').trim();
    if (!a) return b;
    if (!b) return a;
    return `${a}\n\n${b}`;
  }

  function _extractContinuationContent(content) {
    const text = String(content || '').trim();
    if (!text) return '';
    const lines = text.split('\n');
    const first = (lines[0] || '').replace(/^[#\s*]+/, '').trim();
    if (first && first.length <= 40 && lines.length > 2 && !lines[1].trim()) {
      return lines.slice(2).join('\n').trim();
    }
    return text;
  }

  function _renderCurrentDraftResult() {
    if (!currentDraft) return;
    document.getElementById('gaiden-input-area')?.classList.add('hidden');
    document.getElementById('gaiden-result-area')?.classList.remove('hidden');
    const titleInput = document.getElementById('gaiden-result-title');
    if (titleInput) titleInput.value = currentDraft.title || '';
    const contentEl = document.getElementById('gaiden-result-content');
    if (contentEl) contentEl.innerHTML = Markdown.render(currentDraft.content || '');
  }

  async function _requestGaidenContinuation(savedItem, requirement, areaId) {
    const funcConfig = getGaidenConfig();
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) throw new Error('请先配置番外模型');

    const systemPrompt = `你是一位出色的故事续写作者。用户会给你一篇已经写好的番外故事前文，以及原始番外要求。
请从前文的最后一句之后自然续写，不要重写标题，不要重复前文，不要输出任何元说明。
要求：
1. 保持角色性格和世界观一致
2. 文风和前文协调
3. 直接输出续写正文
4. 不要使用“续写如下”等说明文字`;

    const userPrompt = `## 原始番外要求\n\n${requirement || savedItem.requirement || '无'}\n\n## 已完成番外前文\n\n${savedItem.content || ''}\n\n请从前文末尾继续写后续正文。`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        stream: false,
        temperature: 0.85,
        max_tokens: 4096
      }),
      signal: _abortCtrl?.signal
    });
    if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
    const json = await resp.json();
    const content = json.choices?.[0]?.message?.content || '';
    if (!content.trim()) throw new Error('AI返回了空内容');
    return _extractContinuationContent(content);
  }

  async function continueDraft() {
    if (isGenerating || !currentDraft) return;
    const savedItem = await _ensureDraftSaved({ silent: true });
    if (!savedItem) return;
    UI.showToast('已先保存当前番外，开始续写…', 1800);

    isGenerating = true;
    _abortCtrl = new AbortController();
    _showStatusBar('gaiden-action-area', 'continue');
    _showStatusBar('gaiden-result-actions', 'continue');

    const maxRetries = 3;
    let lastError = null;
    try {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const addition = await _requestGaidenContinuation(savedItem, currentDraft.requirement, 'gaiden-action-area');
          savedItem.content = _appendGaidenContent(savedItem.content, addition);
          savedItem.updated = Date.now();
          currentDraft = { ...savedItem, savedId: savedItem.id };
          await saveList();
          _renderCurrentDraftResult();
          renderList();
          UI.showToast('番外续写已追加并保存', 1800);
          lastError = null;
          break;
        } catch(e) {
          if (e.name === 'AbortError') return;
          lastError = e;
          if (attempt < maxRetries) {
            UI.showToast(`续写失败，正在重试（${attempt}/${maxRetries}）…`, 3000);
            await new Promise(r => setTimeout(r, 1500));
          }
        }
      }
      if (lastError) {
        _showError('gaiden-action-area', 'gaiden-continue-btn', '继续续写', 'Gaiden.continueDraft()', `续写失败（已重试${maxRetries}次）: ${lastError.message}`);
        UI.showToast(`番外续写失败，已保留已写部分`, 3500);
      }
    } finally {
      isGenerating = false;
      _abortCtrl = null;
      _showResultActions();
      if (!lastError) _showSendBtn('gaiden-action-area', 'gaiden-send-btn', '发送', 'Gaiden.generate()');
    }
  }

  // ===== 重写 =====

  async function rewrite() {
    if (!currentDraft) return;
    // 回到输入界面，保留原来的要求
    document.getElementById('gaiden-result-area').classList.add('hidden');
    document.getElementById('gaiden-input-area').classList.remove('hidden');
    _showSendBtn('gaiden-action-area', 'gaiden-send-btn', '发送', 'Gaiden.generate()');
    currentDraft = null;
    _showResultActions();
  }

  // ===== 保存 =====

  async function saveDraft() {
    if (!currentDraft) return;
    await _ensureDraftSaved({ silent: true });
    currentDraft = null;

    // 关闭弹窗 + 清理悬浮按钮
    document.getElementById('gaiden-generate-modal').classList.add('hidden');
    document.getElementById('gaiden-fab')?.classList.add('hidden');
    _isMinimized = false;
    UI.showToast('番外已保存');

    // 跳转到番外库
    UI.showPanel('gaiden');
    renderList();
  }

  // ===== 关闭弹窗（带确认） =====

async function closeGenerateModal() {
    if ((currentDraft && !currentDraft.savedId) || isGenerating) {
      if (!await UI.showConfirm('确认退出', '当前番外尚未保存，退出后将丢失。确定退出？')) return;
    }
  currentDraft = null;
  isGenerating = false;
  if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
  const modal = document.getElementById('gaiden-generate-modal');
  const content = modal?.querySelector('.modal-content');
  if (modal) {
    modal.classList.add('closing');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 220));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
  }
  document.getElementById('gaiden-fab')?.classList.add('hidden');
  _isMinimized = false;
}

  let _isMinimized = false;

  function minimizeModal() {
    _isMinimized = true;
    document.getElementById('gaiden-generate-modal').classList.add('hidden');
    const fab = document.getElementById('gaiden-fab');
    if (fab) {
      fab.classList.remove('hidden');
      fab.classList.toggle('generating', !!isGenerating);
      fab.style.animation = '';
    }
  }

  function restoreModal() {
    _isMinimized = false;
    const fab = document.getElementById('gaiden-fab');
    if (fab) {
      fab.classList.remove('generating');
      fab.classList.add('hidden');
    }
    document.getElementById('gaiden-generate-modal').classList.remove('hidden');
  }

  // 生成完成后的通知（在 generate 函数里调用）
  function _notifyDone() {
    if (_isMinimized) {
      UI.showToast('番外生成完毕，点击悬浮按钮查看', 5000);
      const fab = document.getElementById('gaiden-fab');
      if (fab) {
        fab.classList.remove('generating');
        fab.style.animation = 'gaiden-fab-done 0.6s ease';
        setTimeout(() => { if (_isMinimized) fab.style.animation = ''; }, 600);
      }
    }
  }

  // ===== 从番外库入口：选世界观→选对话→写要求 =====

  let _selectedConvId = null;
  let _selectedConvName = null;

  async function openPickerModal() {
    const modal = document.getElementById('gaiden-picker-modal');
    if (!modal) return;
    _selectedConvId = null;
    _selectedConvName = null;
    // 渲染世界观列表
    await _renderPickerWorldviews();
    document.getElementById('gaiden-picker-step-wv').classList.remove('hidden');
    document.getElementById('gaiden-picker-step-conv').classList.add('hidden');
    document.getElementById('gaiden-picker-step-req').classList.add('hidden');
    modal.classList.remove('hidden');
  }

  async function _renderPickerWorldviews() {
    const wvListData = await DB.get('gameState', 'worldviewList');
    const wvList = wvListData?.value || [];
    const container = document.getElementById('gaiden-picker-wv-list');
    if (!container) return;
    container.innerHTML = wvList.map(w => {
      const iconHTML = w.iconImage
        ? `<img src="${w.iconImage}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;margin-right:10px">`
        : `<div style="width:28px;height:28px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:bold;color:#111;margin-right:10px;flex-shrink:0">${Utils.escapeHtml((w.name || '?')[0])}</div>`;
      return `<div onclick="Gaiden._pickWorldview('${w.id}')" style="padding:10px 12px;cursor:pointer;font-size:14px;display:flex;align-items:center;color:var(--text);border-radius:6px" onmouseover="this.style.background='var(--bg-tertiary)'" onmouseout="this.style.background=''">${iconHTML}${Utils.escapeHtml(w.name)}</div>`;
    }).join('');
  }

  async function _pickWorldview(wvId) {
    // 读该世界观下的对话
    const convData = await DB.get('gameState', 'conversations');
    const convList = (convData?.value || []).filter(c => (c.worldviewId || '__default_wv__') === wvId);
    const container = document.getElementById('gaiden-picker-conv-list');
    if (!container) return;
    if (convList.length === 0) {
      container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:20px;font-size:13px">该世界观下没有对话</p>';
    } else {
      container.innerHTML = convList.map(c => {
        return `<div onclick="Gaiden._pickConv('${c.id}','${Utils.escapeHtml(c.name).replace(/'/g, "\\'")}')" style="padding:10px 12px;cursor:pointer;font-size:14px;color:var(--text);border-radius:6px" onmouseover="this.style.background='var(--bg-tertiary)'" onmouseout="this.style.background=''">${Utils.escapeHtml(c.name)}</div>`;
      }).join('');
    }
    document.getElementById('gaiden-picker-step-wv').classList.add('hidden');
    document.getElementById('gaiden-picker-step-conv').classList.remove('hidden');
  }

  function _pickConv(convId, convName) {
    _selectedConvId = convId;
    _selectedConvName = convName;
    document.getElementById('gaiden-picker-selected-conv').textContent = convName;
    document.getElementById('gaiden-picker-requirement').value = '';
    document.getElementById('gaiden-picker-status').textContent = '';
    document.getElementById('gaiden-picker-step-conv').classList.add('hidden');
    document.getElementById('gaiden-picker-step-req').classList.remove('hidden');
  }

  function _pickerBack(step) {
    if (step === 'conv') {
      document.getElementById('gaiden-picker-step-conv').classList.add('hidden');
      document.getElementById('gaiden-picker-step-wv').classList.remove('hidden');
    } else if (step === 'req') {
      document.getElementById('gaiden-picker-step-req').classList.add('hidden');
      document.getElementById('gaiden-picker-step-conv').classList.remove('hidden');
    }
  }

  async function generateFromPicker() {
    if (isGenerating || !_selectedConvId) return;
    const requirement = document.getElementById('gaiden-picker-requirement').value.trim();
    if (!requirement) { UI.showToast('请输入番外要求'); return; }

    const funcConfig = getGaidenConfig();
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl).replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) { UI.showToast('请先配置番外模型'); return; }

    // 从 DB 读指定对话的消息
const allMsgs = await DB.getAllByIndex('messages', 'conversationId', _selectedConvId);
const convMsgs = allMsgs.filter(m => m.branchId === 'main')
.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    if (convMsgs.length === 0) { UI.showToast('该对话没有消息'); return; }

    const contextText = convMsgs.map(m => `[${m.role === 'user' ? '玩家' : 'AI'}]: ${m.content}`).join('\n\n');

    // 收集世界观和角色设定
    const wvPrompt = Chat.getWorldviewPrompt() || '';
    const char = await Character.get();
    const charPrompt = char ? Character.formatForPrompt(char) : '';

    isGenerating = true;
    _abortCtrl = new AbortController();
    _showStatusBar('gaiden-picker-action-area');

    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
    const systemPrompt = `你是一位出色的故事创作者。用户将给你一段互动小说/文字游戏的对话记录作为上下文，以及对番外故事的要求。
请根据上下文和要求，创作一篇完整的番外短篇故事。
要求：
1. 保持角色性格和世界观一致
2. 故事要完整，有开头、发展和结尾
3. 文风和原文保持协调
4. 不要加任何元信息或说明
5. 严格遵循用户角色设定中的所有属性（性别、外貌、性格等），不得自行修改
6. 第一行只写标题（不加#号和任何符号），第二行留空，第三行开始写正文`;

        let userPrompt = '';
        if (wvPrompt) userPrompt += `## 世界观设定\n\n${wvPrompt}\n\n`;
        if (charPrompt) userPrompt += `## 用户角色设定\n\n${charPrompt}\n\n`;
        userPrompt += `## 当前剧情上下文\n\n${contextText}\n\n## 番外要求\n\n${requirement}\n\n请创作番外故事。`;

        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            stream: false, temperature: 0.85, max_tokens: 4096
          }),
          signal: _abortCtrl?.signal
        });

        if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
        const json = await resp.json();
        const content = json.choices?.[0]?.message?.content || '';
        if (!content) throw new Error('AI返回了空内容');

        const lines = content.split('\n');
        const autoTitle = (lines[0] || '').replace(/^[#\s*]+/, '').trim().slice(0, 30) || '未命名番外';
        let bodyStart = 1;
        while (bodyStart < lines.length && !lines[bodyStart].trim()) bodyStart++;
        const bodyContent = lines.slice(bodyStart).join('\n');

        const gaiden = {
          id: 'gaiden_' + Utils.uuid().slice(0, 8),
          title: autoTitle,
          content: bodyContent, requirement,
          sourceConv: _selectedConvId,
          sourceConvName: _selectedConvName,
          created: Date.now()
        };

        document.getElementById('gaiden-picker-modal').classList.add('hidden');
        currentDraft = gaiden;
        document.getElementById('gaiden-generate-modal').classList.remove('hidden');
        document.getElementById('gaiden-input-area').classList.add('hidden');
        document.getElementById('gaiden-result-area').classList.remove('hidden');
        document.getElementById('gaiden-result-title').value = gaiden.title;
        document.getElementById('gaiden-result-content').innerHTML = Markdown.render(gaiden.content);

        _notifyDone();
        lastError = null;
      } catch(e) {
        if (e.name === 'AbortError') return;
        lastError = e;
        if (attempt < maxRetries) {
          UI.showToast(`生成失败，正在重试（${attempt}/${maxRetries}）…`, 3000);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }

    if (lastError) {
      console.error('[Gaiden] picker generate error:', lastError);
      _showError('gaiden-picker-action-area', 'gaiden-picker-send-btn', '生成番外', 'Gaiden.generateFromPicker()', `生成失败（已重试${maxRetries}次）: ${lastError.message}`);
      UI.showToast(`番外生成失败，已重试${maxRetries}次`, 4000);
    }

    isGenerating = false;
    _abortCtrl = null;
  }

  function closePickerModal() {
  const modal = document.getElementById('gaiden-picker-modal');
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

  let _filterWv = '';
  let _filterConv = '';
  let _collectionTab = 'all'; // 'all' | 'gaiden' | 'phone' | 'message'
  let _phoneSubtab = 'all';   // 'all' | 'forum' | 'map' | 'moments' | 'memo'

  // 判断一个条目是否是手机类（兼容旧的 worldvoice 数据）
  function _isPhoneItem(g) {
    return g.type === 'phone' || g.type === 'worldvoice';
  }
  function _getPhoneType(g) {
    if (g.phoneType) return g.phoneType;
    if (g.type === 'worldvoice') return 'forum'; // 向后兼容
    return 'other';
  }

  function filterCollection(tab) {
    _collectionTab = tab;
    // 更新tab样式
    document.querySelectorAll('#collection-tabs .collection-tab').forEach(btn => {
      const isActive = btn.dataset.tab === tab;
      btn.style.background = isActive ? 'var(--accent)' : 'none';
      btn.style.color = isActive ? '#000' : 'var(--text-secondary)';
    });
    // 切到 phone 时显示子分类
    const sub = document.getElementById('phone-subtabs');
    if (sub) sub.style.display = (tab === 'phone') ? 'flex' : 'none';
    renderList();
  }

  function filterPhoneSubtab(sub) {
    _phoneSubtab = sub;
    document.querySelectorAll('#phone-subtabs .phone-subtab').forEach(btn => {
      const isActive = btn.dataset.subtab === sub;
      btn.style.background = isActive ? 'var(--accent)' : 'none';
      btn.style.color = isActive ? '#000' : 'var(--text-secondary)';
    });
    renderList();
  }

  function renderList() {
    const container = document.getElementById('gaiden-list');
    if (!container) return;

    // 按类型过滤
    let filtered = gaidenList;
    if (_collectionTab === 'gaiden') {
      filtered = filtered.filter(g => !_isPhoneItem(g) && g.type !== 'message');
    } else if (_collectionTab === 'phone') {
      filtered = filtered.filter(g => _isPhoneItem(g));
      if (_phoneSubtab !== 'all') {
        filtered = filtered.filter(g => _getPhoneType(g) === _phoneSubtab);
      }
    } else if (_collectionTab === 'message') {
      filtered = filtered.filter(g => g.type === 'message');
    }

    // 按世界观/对话过滤（手机类也应用筛选——用户需要的）
    if (_filterConv) {
      filtered = filtered.filter(g => g.sourceConv === _filterConv);
    } else if (_filterWv) {
      const convIds = new Set((Conversations.getList() || []).filter(c => (c.worldviewId || '__default_wv__') === _filterWv).map(c => c.id));
      filtered = filtered.filter(g => convIds.has(g.sourceConv));
    }

    if (filtered.length === 0) {
      const emptyMsg = _collectionTab === 'phone'
        ? '还没有手机收藏<br>在手机的论坛/地图/好友圈/备忘录中点击收藏按钮'
        : _collectionTab === 'gaiden'
        ? (gaidenList.filter(g => !_isPhoneItem(g) && g.type !== 'message').length === 0 ? '还没有番外故事<br>在聊天界面点 ＋ → 生成番外' : '没有匹配的番外')
        : _collectionTab === 'message'
        ? '还没有收藏的剧情<br>长按AI气泡 → 收藏剧情'
        : (gaidenList.length === 0 ? '还没有收藏内容' : '没有匹配的内容');
      container.innerHTML = `<p style="text-align:center;color:var(--text-secondary);padding:40px 0;font-size:13px">${emptyMsg}</p>`;
      return;
    }

    container.innerHTML = filtered.map(g => {
      if (_isPhoneItem(g)) {
        // 手机类卡片（按 phoneType 显示不同图标和标签）
        const pt = _getPhoneType(g);
        const _svgForum = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="12" rx="3"/><polyline points="8 17 8 21 12 17"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/></svg>`;
    const _svgMap = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s6-5 6-11a6 6 0 0 0-12 0c0 6 6 11 6 11z"/><circle cx="12" cy="10" r="2"/></svg>`;
    const _svgCamera = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="3"/><circle cx="12" cy="13" r="3"/><path d="M9 7l1.5-2h3L15 7"/></svg>`;
    const _svgMemo = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>`;
    const _svgPhone = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>`;
    const meta = pt === 'forum' ? { icon: _svgForum, label: '论坛' }
      : pt === 'map' ? { icon: _svgMap, label: '地图' }
      : pt === 'moments' ? { icon: _svgCamera, label: '好友圈' }
      : pt === 'memo' ? { icon: _svgMemo, label: '备忘录' }
      : { icon: _svgPhone, label: '手机' };
        const savedAt = g.savedAt || g.created || g.createdAt;
        return `<div class="card" style="padding:12px;background:var(--bg-tertiary);cursor:pointer;margin-bottom:8px" onclick="Gaiden.viewPhoneItem('${g.id}')">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
          <span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--accent);color:#000;flex-shrink:0;display:inline-flex;align-items:center;gap:3px">${meta.icon} ${meta.label}</span>
              <h3 style="margin:0;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(g.title || '无标题')}</h3>
            </div>
            <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0;margin-left:8px">${Utils.formatDate(savedAt)}</span>
          </div>
          <span style="font-size:12px;color:var(--text-secondary)">${g.sourceConvName ? '来源：' + Utils.escapeHtml(g.sourceConvName) : ''}</span>
        </div>`;
      } else if (g.type === 'message') {
        // 收藏的剧情卡片
        return `<div class="card" style="padding:12px;background:var(--bg-tertiary);cursor:pointer;margin-bottom:8px" onclick="Gaiden.viewDetail('${g.id}')">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
              <span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--text-secondary);color:#000;flex-shrink:0">剧情</span>
              <h3 style="margin:0;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(g.title)}</h3>
            </div>
            <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0;margin-left:8px">${Utils.formatDate(g.savedAt)}</span>
          </div>
          <span style="font-size:12px;color:var(--text-secondary)">来源：${Utils.escapeHtml(g.sourceConvName || '未知对话')}</span>
        </div>`;
      } else {
        // 番外卡片（兜底，但要排除已知类型避免误识别）
        if (g.type === 'phone' || g.type === 'worldvoice') return ''; // 安全防御
        return `<div class="card" style="padding:12px;background:var(--bg-tertiary);cursor:pointer;margin-bottom:8px" onclick="Gaiden.viewDetail('${g.id}')">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <h3 style="margin:0;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(g.title)}</h3>
            <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0;margin-left:8px">${Utils.formatDate(g.created)}</span>
          </div>
          <span style="font-size:12px;color:var(--text-secondary)">来源：${Utils.escapeHtml(g.sourceConvName || '未知对话')}</span>
        </div>`;
      }
    }).join('');
  }

  async function toggleFilter(type) {
    const dropdownId = type === 'wv' ? 'gaiden-filter-wv-dropdown' : 'gaiden-filter-conv-dropdown';
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;

    if (!dropdown.classList.contains('hidden')) {
      dropdown.classList.add('hidden');
      return;
    }

    // 关闭另一个
    document.querySelectorAll('#gaiden-filter-wv-dropdown,#gaiden-filter-conv-dropdown').forEach(d => d.classList.add('hidden'));

    if (type === 'wv') {
      const wvData = await DB.get('gameState', 'worldviewList');
      const wvList = wvData?.value || [];
      dropdown.innerHTML = '<div class="custom-dropdown-item" onclick="Gaiden.selectFilter(\'wv\',\'\')">全部世界观</div>' +
        wvList.map(w => `<div class="custom-dropdown-item${_filterWv === w.id ? ' active' : ''}" onclick="Gaiden.selectFilter('wv','${w.id}','${Utils.escapeHtml(w.name).replace(/'/g, "\\'")}')">${Utils.escapeHtml(w.name)}</div>`).join('');
    } else {
      const convList = Conversations.getList() || [];
      let filtered = convList;
      if (_filterWv) {
        filtered = convList.filter(c => (c.worldviewId || '__default_wv__') === _filterWv);
      }
      dropdown.innerHTML = '<div class="custom-dropdown-item" onclick="Gaiden.selectFilter(\'conv\',\'\')">全部对话</div>' +
        filtered.map(c => `<div class="custom-dropdown-item${_filterConv === c.id ? ' active' : ''}" onclick="Gaiden.selectFilter('conv','${c.id}','${Utils.escapeHtml(c.name).replace(/'/g, "\\'")}')">${Utils.escapeHtml(c.name)}</div>`).join('');
    }

    dropdown.classList.remove('hidden');
    setTimeout(() => {
      document.addEventListener('click', function _close(e) {
        if (!dropdown.contains(e.target) && !dropdown.previousElementSibling?.contains(e.target)) {
          dropdown.classList.add('hidden');
          document.removeEventListener('click', _close);
        }
      });
    }, 0);
  }

  function selectFilter(type, id, name) {
    if (type === 'wv') {
      _filterWv = id;
      _filterConv = ''; // 切世界观时重置对话筛选
      document.getElementById('gaiden-filter-wv-label').textContent = name || '全部世界观';
      document.getElementById('gaiden-filter-conv-label').textContent = '全部对话';
    } else {
      _filterConv = id;
      document.getElementById('gaiden-filter-conv-label').textContent = name || '全部对话';
    }
    document.querySelectorAll('#gaiden-filter-wv-dropdown,#gaiden-filter-conv-dropdown').forEach(d => d.classList.add('hidden'));
    renderList();
  }

  // ===== 查看详情 =====

  function viewDetail(id) {
    const g = gaidenList.find(x => x.id === id);
    if (!g) return;

    const modal = document.getElementById('gaiden-detail-modal');
    if (!modal) return;
    document.getElementById('gaiden-detail-title').textContent = g.title;
    document.getElementById('gaiden-detail-content').innerHTML = Markdown.render(g.content);
    document.getElementById('gaiden-detail-source').textContent = `来源：${g.sourceConvName || '未知对话'} · ${Utils.formatDate(g.savedAt || g.created)}`;
    modal.dataset.gaidenId = id;
    // 确保是查看模式
    document.getElementById('gaiden-view-area').classList.remove('hidden');
    document.getElementById('gaiden-edit-area').classList.add('hidden');
    document.getElementById('gaiden-view-actions').classList.remove('hidden');
    document.getElementById('gaiden-edit-actions').classList.add('hidden');
    // 恢复编辑/世界线按钮（viewWvPost / _viewPhoneItemGeneric 会改它们）
    const editBtnEl = document.getElementById('gaiden-edit-btn');
    if (editBtnEl) editBtnEl.style.display = '';
    const enterBtn = document.getElementById('gaiden-enter-btn');
    const editBigBtn = document.getElementById('gaiden-edit-big-btn');
    // 只有番外显示"进入世界线"，其他类型都不显示
    if (g.type === 'gaiden' || !g.type) {
      if (enterBtn) enterBtn.classList.remove('hidden');
    } else {
      if (enterBtn) enterBtn.classList.add('hidden');
    }
    if (editBigBtn) editBigBtn.classList.add('hidden');
    modal.classList.remove('hidden');
  }

  function startEdit() {
    const id = document.getElementById('gaiden-detail-modal').dataset.gaidenId;
    const g = gaidenList.find(x => x.id === id);
    if (!g) return;
    document.getElementById('gaiden-edit-title').value = g.title;
    document.getElementById('gaiden-edit-content').value = g.content;
    // 切到编辑模式
    document.getElementById('gaiden-view-area').classList.add('hidden');
    document.getElementById('gaiden-edit-area').classList.remove('hidden');
    document.getElementById('gaiden-view-actions').classList.add('hidden');
    document.getElementById('gaiden-edit-actions').classList.remove('hidden');
    document.getElementById('gaiden-edit-btn').classList.add('hidden');
  }

  function cancelEdit() {
    // 切回查看模式
    document.getElementById('gaiden-view-area').classList.remove('hidden');
    document.getElementById('gaiden-edit-area').classList.add('hidden');
    document.getElementById('gaiden-view-actions').classList.remove('hidden');
    document.getElementById('gaiden-edit-actions').classList.add('hidden');
    document.getElementById('gaiden-edit-btn').classList.remove('hidden');
  }

  async function saveEdit() {
    const id = document.getElementById('gaiden-detail-modal').dataset.gaidenId;
    const g = gaidenList.find(x => x.id === id);
    if (!g) return;
    const newTitle = document.getElementById('gaiden-edit-title').value.trim();
    const newContent = document.getElementById('gaiden-edit-content').value;
    if (!newTitle) { UI.showToast('标题不能为空'); return; }
    g.title = newTitle;
    g.content = newContent;
    await saveList();
    // 刷新查看模式
    document.getElementById('gaiden-detail-title').textContent = g.title;
    document.getElementById('gaiden-detail-content').innerHTML = Markdown.render(g.content);
    cancelEdit();
    renderList();
    UI.showToast('番外已保存');
  }

  function closeDetail() {
  const modal = document.getElementById('gaiden-detail-modal');
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

  // ===== 进入番外世界线 =====

  let _pendingGaidenId = null; // 正在设置的番外id
  let _settingsMode = 'enter'; // 'enter'=进入世界线 | 'edit'=编辑已有设定

  async function enterWorldline(id) {
    const g = gaidenList.find(x => x.id === id);
    if (!g) return;

    _pendingGaidenId = id;
    _settingsMode = 'enter';

    // 打开设定面板，让用户填番外背景和选择继承
    document.getElementById('gaiden-bg-input').value = '';
    document.getElementById('gaiden-inherit-wv').checked = true;
    document.getElementById('gaiden-inherit-npc').checked = true;
    document.getElementById('gaiden-settings-modal').classList.remove('hidden');
    // 关闭详情弹窗
    closeDetail();
  }

  // 从菜单打开（编辑已有番外设定）
  async function openSettingsModal() {
    _settingsMode = 'edit';
    _pendingGaidenId = null;

    // 读取当前对话的番外设定
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv || !conv.isGaiden) {
      UI.showToast('当前不是番外对话');
      return;
    }

    document.getElementById('gaiden-bg-input').value = conv.gaidenBg || '';
    document.getElementById('gaiden-inherit-wv').checked = conv.inheritWv !== false;
    document.getElementById('gaiden-inherit-npc').checked = conv.inheritNpc !== false;
    document.getElementById('gaiden-settings-modal').classList.remove('hidden');
  }

  async function saveSettings() {
    const bg = document.getElementById('gaiden-bg-input').value.trim();
    const inheritWv = document.getElementById('gaiden-inherit-wv').checked;
    const inheritNpc = document.getElementById('gaiden-inherit-npc').checked;

    if (_settingsMode === 'enter') {
      // 进入番外世界线
      const g = gaidenList.find(x => x.id === _pendingGaidenId);
      if (!g) return;

      const newConvId = 'conv_' + Utils.uuid().slice(0, 8);
      const newMaskId = 'mask_' + Utils.uuid().slice(0, 8);

      // 复制源对话的面具
      const srcConvList = await DB.get('gameState', 'conversations');
      const srcConv = (srcConvList?.value || []).find(c => c.id === g.sourceConv);
      const srcMaskId = srcConv?.maskId || srcConv?.branchMaskId || Character.getCurrentId();
      await Character.cloneMaskFrom(srcMaskId, newMaskId);

      // 番外内容作为第一条AI消息
      const gaidenMsg = {
        id: Utils.uuid(),
        role: 'assistant',
        content: g.content,
        branchId: 'main',
        conversationId: newConvId,
        timestamp: Date.now()
      };
      await DB.put('messages', gaidenMsg);

      // 注册新对话（带番外设定）
      await Conversations.addBranch(newConvId, g.title.slice(0, 20), newMaskId, {
        isGaiden: true,
        gaidenBg: bg,
        inheritWv: inheritWv,
        inheritNpc: inheritNpc,
        sourceGaidenId: _pendingGaidenId
      });

      closeSettingsModal();
      UI.showToast('已进入番外世界线');

    } else {
      // 编辑已有番外设定
      const convList = Conversations.getList();
      const conv = convList.find(c => c.id === Conversations.getCurrent());
      if (conv) {
        conv.gaidenBg = bg;
        conv.inheritWv = inheritWv;
        conv.inheritNpc = inheritNpc;
        await Conversations.saveList();
        closeSettingsModal();
        UI.showToast('番外设定已更新');
      }
    }
    _pendingGaidenId = null;
  }

  function closeSettingsModal() {
  const modal = document.getElementById('gaiden-settings-modal');
  const content = modal?.querySelector('.modal-content');
  if (modal) {
    modal.classList.add('closing');
    if (content) content.classList.add('closing');
    setTimeout(() => {
      modal.classList.remove('closing');
      if (content) content.classList.remove('closing');
      modal.classList.add('hidden');
    }, 220);
  }
  _pendingGaidenId = null;
}

  // 更新菜单按钮可见性（切换对话时调用）
  function updateMenuVisibility() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    const btn = document.getElementById('gaiden-settings-menu-btn');
    if (btn) {
      btn.style.display = (conv && conv.isGaiden) ? 'flex' : 'none';
    }
  }

  // 获取当前番外对话的设定（供 chat.js 发送时读取）
  function getCurrentGaidenSettings() {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (!conv || !conv.isGaiden) return null;
    return {
      gaidenBg: conv.gaidenBg || '',
      inheritWv: conv.inheritWv !== false,
      inheritNpc: conv.inheritNpc !== false
    };
  }

  // ===== 删除番外 =====

  async function remove(id) {
    if (!await UI.showConfirm('确认删除', '确定删除这个番外？')) return;
    gaidenList = gaidenList.filter(g => g.id !== id);
    await saveList();
    closeDetail();
    renderList();
    UI.showToast('番外已删除');
  }

  // 查看手机收藏（按 phoneType 分发）
  function viewPhoneItem(id) {
    const item = gaidenList.find(g => g.id === id);
    if (!item) return;
    const pt = _getPhoneType(item);
    if (pt === 'forum') return viewWvPost(id); // 复用原有的论坛详情视图
    // 其它类型：通用渲染
    _viewPhoneItemGeneric(item);
  }

  function _viewPhoneItemGeneric(item) {
    const modal = document.getElementById('gaiden-detail-modal');
    if (!modal) return;
    modal.dataset.gaidenId = item.id;
    document.getElementById('gaiden-detail-title').textContent = item.title || '收藏';
    const pt = _getPhoneType(item);
    const _svgMap2 = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s6-5 6-11a6 6 0 0 0-12 0c0 6 6 11 6 11z"/><circle cx="12" cy="10" r="2"/></svg>`;
  const _svgCamera2 = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="3"/><circle cx="12" cy="13" r="3"/><path d="M9 7l1.5-2h3L15 7"/></svg>`;
  const _svgMemo2 = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>`;
  const _svgPhone2 = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>`;
  const typeLabel = pt === 'map' ? `${_svgMap2} 地图`
    : pt === 'moments' ? `${_svgCamera2} 好友圈`
    : pt === 'memo' ? `${_svgMemo2} 备忘录`
    : `${_svgPhone2} 手机`;
    let html = `<div style="font-size:11px;color:var(--text-secondary);display:flex;align-items:center;gap:4px;margin-bottom:12px">${typeLabel}${item.sourceConvName ? ' · 来源：' + Utils.escapeHtml(item.sourceConvName) : ''}</div>`;
    html += `<div class="md-content" style="font-size:14px;line-height:1.8;color:var(--text);white-space:pre-wrap">${Utils.escapeHtml(item.content || '')}</div>`;
    if (item.comments?.length) {
      html += '<div style="font-size:14px;font-weight:bold;color:var(--text);margin:16px 0 8px;padding-top:12px;border-top:1px solid var(--border)">评论</div>';
      item.comments.forEach(c => {
        html += `<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:13px"><b>${Utils.escapeHtml(c.name || c.username || '匿名')}</b>：${Utils.escapeHtml(c.text || c.content || '')}</div>`;
      });
    }
    const contentEl = document.getElementById('gaiden-detail-content');
    contentEl.innerHTML = html;
    // 隐藏顶部小编辑按钮（手机收藏用底部大按钮编辑）
    const editBtnEl = document.getElementById('gaiden-edit-btn');
    if (editBtnEl) editBtnEl.style.display = 'none';
    // 底部按钮：隐藏"进入世界线"和"编辑"，只保留删除
    const enterBtn = document.getElementById('gaiden-enter-btn');
    const editBigBtn = document.getElementById('gaiden-edit-big-btn');
    if (enterBtn) enterBtn.classList.add('hidden');
    if (editBigBtn) editBigBtn.classList.add('hidden');
    // 确保查看区域可见
    document.getElementById('gaiden-view-area')?.classList.remove('hidden');
    document.getElementById('gaiden-edit-area')?.classList.add('hidden');
    document.getElementById('gaiden-view-actions')?.classList.remove('hidden');
    document.getElementById('gaiden-edit-actions')?.classList.add('hidden');
    modal.classList.remove('hidden');
  }

  // 查看收藏的论坛帖子（兼容旧的 worldvoice 类型和新的 phone-forum）
  function viewWvPost(id) {
    const post = gaidenList.find(g => g.id === id);
    if (!post) return;
    if (!_isPhoneItem(post) || _getPhoneType(post) !== 'forum') return;
    
    const modal = document.getElementById('gaiden-detail-modal');
    if (!modal) return;
    modal.dataset.gaidenId = id;
    
    document.getElementById('gaiden-detail-title').textContent = post.title;
    
    // 渲染风闻帖子内容
    let html = '';
    // 发帖人信息
    html += `<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <div style="width:36px;height:36px;border-radius:50%;background:${Utils.escapeHtml(post.avatar_color || '#888')};display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;font-weight:bold">${Utils.escapeHtml((post.username || '?')[0])}</div>
      <div><div style="font-size:14px;font-weight:bold;color:var(--text)">${Utils.escapeHtml(post.username || '匿名')}</div>
      <div style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(post.time || '')}</div></div>
    </div>`;
    // 标签
    if (post.tags?.length) {
      html += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${post.tags.map(t => `<span style="font-size:11px;background:var(--bg-tertiary);color:var(--accent);padding:2px 8px;border-radius:10px">${Utils.escapeHtml(t)}</span>`).join('')}</div>`;
    }
    // 正文
    html += `<div class="md-content" style="font-size:14px;line-height:1.8;color:var(--text);margin-bottom:20px">${Markdown.render(post.content || '')}</div>`;
    // 评论区
    if (post.comments?.length) {
      html += '<div style="font-size:14px;font-weight:bold;color:var(--text);margin-bottom:12px;padding-top:12px;border-top:1px solid var(--border)">评论区</div>';
      post.comments.forEach(c => {
        html += `<div style="display:flex;gap:10px;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border)">
          <div style="width:28px;height:28px;border-radius:50%;background:${Utils.escapeHtml(c.avatar_color || '#666')};display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:bold;flex-shrink:0">${Utils.escapeHtml((c.username || '?')[0])}</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <span style="font-size:13px;font-weight:bold;color:var(--text)">${Utils.escapeHtml(c.username || '匿名')}</span>
              <span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(c.time || '')}</span>
            </div>
            <div style="font-size:13px;color:var(--text);line-height:1.5">${Utils.escapeHtml(c.content || '')}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${c.likes || 0}</div>
          </div>
        </div>`;
      });
    }
    
    const contentEl = document.getElementById('gaiden-detail-content');
    contentEl.innerHTML = html;
    
    // 隐藏编辑按钮（风闻帖子不能编辑）
    const editBtn = document.getElementById('gaiden-edit-btn');
    if (editBtn) editBtn.style.display = 'none';
    
    // 查看模式按钮区：只显示删除，隐藏进入世界线和编辑
    const viewActions = document.getElementById('gaiden-view-actions');
    if (viewActions) {
      viewActions.classList.remove('hidden');
      const enterBtn = document.getElementById('gaiden-enter-btn');
      const editBigBtn = document.getElementById('gaiden-edit-big-btn');
      if (enterBtn) enterBtn.classList.add('hidden');
      if (editBigBtn) editBigBtn.classList.add('hidden');
    }
    
    // 来源信息
    document.getElementById('gaiden-detail-source').textContent = `收藏的风闻帖子 · ${Utils.formatDate(post.savedAt)}`;
    
    // 显示查看模式
    document.getElementById('gaiden-view-area')?.classList.remove('hidden');
    document.getElementById('gaiden-edit-area')?.classList.add('hidden');
    document.getElementById('gaiden-edit-actions')?.classList.add('hidden');
    modal.classList.remove('hidden');
  }

  return {
    init, openGenerateModal, generate, rewrite, saveDraft, continueDraft, closeGenerateModal, abort,
    minimizeModal, restoreModal,
    renderList, viewDetail, viewWvPost, viewPhoneItem, closeDetail, enterWorldline, remove, addToList,
    startEdit, cancelEdit, saveEdit,
    toggleFilter, selectFilter, filterCollection, filterPhoneSubtab,
    openPickerModal, _pickWorldview, _pickConv, _pickerBack, generateFromPicker, closePickerModal,
    openSettingsModal, saveSettings, closeSettingsModal, updateMenuVisibility, getCurrentGaidenSettings
  };
})();
window.Gaiden = Gaiden;
