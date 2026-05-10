/**
 * 新手引导模块：复用聊天面板，以选项推进脚本
 * 说明：只实现用户已定稿的基础教程，不额外扩展剧情。
 */
const Tutorial = (() => {
  let active = false;
  let currentNode = null;
  let started = false;
  let firstRun = false;
  let _skipAnim = false;

  const STORAGE_DONE_KEY = 'tutorial_completed_v1';
  const STORAGE_SEEN_KEY = 'tutorial_seen_v1';
  const TUTORIAL_AVATAR = 'img/tutorial-avatar.jpg';

  function isEnabled() {
    return active;
  }

  function getScript() {
    if (typeof TUTORIAL_SCRIPT !== 'undefined') return TUTORIAL_SCRIPT;
    return window.TUTORIAL_SCRIPT || {};
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function optionBar() {
    return byId('tutorial-option-bar');
  }

  function chatBox() {
    return byId('chat-messages');
  }

  function chatInput() {
    return byId('chat-input');
  }

  function sendBtn() {
    return byId('btn-send');
  }

  function plusBtn() {
    return byId('btn-plus');
  }

  function topMenu() {
    return byId('top-dropdown-menu');
  }

  function tapOverlay() {
    return byId('tutorial-tap-overlay');
  }

  let _optionsVisible = false;
  let _pendingOptions = [];

  function setInputDisabled(disabled) {
    const input = chatInput();
    const send = sendBtn();
    const plus = plusBtn();
    const overlay = tapOverlay();
    if (input) {
      input.disabled = disabled;
      input.placeholder = disabled ? '点击此处查看选项…' : '输入你的行动...';
      input.style.opacity = disabled ? '0.75' : '';
    }
    if (overlay) {
      if (disabled) {
        overlay.classList.remove('hidden');
      } else {
        overlay.classList.add('hidden');
      }
    }
    if (send) {
      send.disabled = disabled;
      send.style.pointerEvents = disabled ? 'none' : '';
    }
    // 加号菜单在教程中保持可用
  }

  function toggleOptions() {
    const bar = optionBar();
    if (!bar || !active) return;
    _optionsVisible = !_optionsVisible;
    if (_optionsVisible && _pendingOptions.length) {
      bar.classList.remove('hidden');
    } else {
      bar.classList.add('hidden');
      _optionsVisible = false;
    }
  }

  function hideOptions() {
    const bar = optionBar();
    if (bar) bar.classList.add('hidden');
    _optionsVisible = false;
  }

  function clearChat() {
    const box = chatBox();
    if (box) box.innerHTML = '';
  }

  function scrollBottom() {
    const box = chatBox();
    if (!box) return;
    requestAnimationFrame(() => {
      box.scrollTop = box.scrollHeight;
    });
  }

  function renderOptions(options = []) {
    const bar = optionBar();
    if (!bar) return;
    _pendingOptions = options;
    _optionsVisible = false;
    if (!active || !options.length) {
      bar.innerHTML = '';
      bar.classList.add('hidden');
      return;
    }
    bar.innerHTML = options.map((opt, idx) => (
      `<button class="tutorial-option-btn" data-index="${idx}">${Utils.escapeHtml(opt.label || '继续')}</button>`
    )).join('');
    bar.classList.add('hidden');
    Array.from(bar.querySelectorAll('.tutorial-option-btn')).forEach((btn, idx) => {
      btn.onclick = async () => {
        if (!active) return;
        disableOptions(true);
        hideOptions();
        const opt = options[idx];
        await appendUserBubble(opt.label || '继续');
        await handleOption(opt || {});
      };
    });
    // 提示用户可以点输入框
    const input = chatInput();
    if (input) {
      input.placeholder = '点击此处查看选项…';
    }
  }

  function disableOptions(disabled) {
    const bar = optionBar();
    if (!bar) return;
    bar.querySelectorAll('.tutorial-option-btn').forEach(btn => {
      btn.disabled = disabled;
      btn.style.opacity = disabled ? '0.6' : '1';
      btn.style.pointerEvents = disabled ? 'none' : 'auto';
    });
  }

  function createWrap(className) {
    const wrap = document.createElement('div');
    wrap.className = className;
    return wrap;
  }

  function createBubble(className, html) {
    const bubble = document.createElement('div');
    bubble.className = className;
    bubble.innerHTML = html;
    return bubble;
  }

  async function appendTypingBubble() {
    const box = chatBox();
    if (!box) return null;
    // 用正式聊天的AI气泡结构：直接放chat-msg assistant
    const div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.dataset.id = 'tutorial-typing';
    div.innerHTML = '<div class="msg-body md-content"><div class="typing-indicator"><span></span><span></span><span></span></div></div>';
    box.appendChild(div);
    scrollBottom();
    return { wrap: div, bubble: div };
  }

  async function appendAIBubble(content, useTyping = false) {
    const box = chatBox();
    if (!box) return;
    if (useTyping && !_skipAnim) {
      const typingRef = await appendTypingBubble();
      await wait(900);
      if (typingRef?.wrap?.parentNode) typingRef.wrap.remove();
    }
    // AI头像 + 气泡，和正式聊天的assistant一样
    const avatarEl = document.createElement('img');
    avatarEl.src = TUTORIAL_AVATAR;
    avatarEl.className = 'msg-avatar';
    avatarEl.style.cssText = 'width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0';
    const div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.dataset.id = 'tutorial-ai-' + Date.now();
    div.innerHTML = '<div class="msg-body md-content"></div>';
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:flex-start;align-self:flex-start;max-width:100%;width:auto';
    wrapper.appendChild(avatarEl);
    wrapper.appendChild(div);
    div.style.width = 'auto';
    div.style.maxWidth = '100%';
    box.appendChild(wrapper);
    scrollBottom();
    // 模拟流式输出
    await streamText(div, String(content || ''));
  }

  async function appendStructuredBubble(content) {
    const box = chatBox();
    if (!box) return;
    if (!_skipAnim) {
      const typingRef = await appendTypingBubble();
      await wait(900);
      if (typingRef?.wrap?.parentNode) typingRef.wrap.remove();
    }
    const avatarEl = document.createElement('img');
    avatarEl.src = TUTORIAL_AVATAR;
    avatarEl.className = 'msg-avatar';
    avatarEl.style.cssText = 'width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0';
    const div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.dataset.id = 'tutorial-structured-' + Date.now();
    div.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:flex-start;align-self:flex-start;max-width:100%;width:auto';
    wrapper.appendChild(avatarEl);
    wrapper.appendChild(div);
    div.style.width = 'auto';
    div.style.maxWidth = '100%';
    box.appendChild(wrapper);
    scrollBottom();
    await streamStructured(div, String(content));
  }

  async function appendUserBubble(content) {
    const box = chatBox();
    if (!box) return;
    // 用正式聊天的用户气泡结构
    const div = document.createElement('div');
    div.className = 'chat-msg user';
    div.dataset.id = 'tutorial-user-' + Date.now();
    div.innerHTML = `<div class="msg-body md-content">${Markdown.render(String(content || ''))}</div>`;
    // 加用户头像（和正式聊天一样）
    const avatar = Character.getAvatar();
    if (avatar) {
      const avatarEl = document.createElement('img');
      avatarEl.src = avatar;
      avatarEl.className = 'msg-avatar';
      avatarEl.style.cssText = 'width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0';
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:flex-end;align-self:flex-end;max-width:95%;width:auto';
      wrapper.appendChild(avatarEl);
      wrapper.appendChild(div);
      div.style.width = 'auto';
      div.style.maxWidth = '100%';
      box.appendChild(wrapper);
    } else {
      box.appendChild(div);
    }
    scrollBottom();
    await wait(400);
  }

  async function appendSystemCard(rawText) {
    const box = chatBox();
    if (!box || !rawText) return;
    if (!_skipAnim) {
      const typingRef = await appendTypingBubble();
      await wait(900);
      if (typingRef?.wrap?.parentNode) typingRef.wrap.remove();
    }
    const avatarEl = document.createElement('img');
    avatarEl.src = TUTORIAL_AVATAR;
    avatarEl.className = 'msg-avatar';
    avatarEl.style.cssText = 'width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0';
    const div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.dataset.id = 'tutorial-sys-' + Date.now();
    div.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:flex-start;align-self:flex-start;max-width:100%;width:auto';
    wrapper.appendChild(avatarEl);
    wrapper.appendChild(div);
    div.style.width = 'auto';
    div.style.maxWidth = '100%';
    box.appendChild(wrapper);
    scrollBottom();
    // 直接构造 parsed 对象，绕过 parseAIOutput 的前置依赖（要求底部代码块前必须有 \n---\n）
    // systemCard 支持两种写法：
    //   1. 三反引号包裹：```\n新获得物品\n物品名：描述\n```
    //   2. 纯文本：新获得物品\n物品名：描述
    const parsed = _parseSystemCard(String(rawText));
    await streamStructuredFromParsed(div, parsed);
  }

  function _parseSystemCard(rawText) {
    const parsed = {
      header: { region: '', location: '', time: '', weather: '' },
      body: '',
      items: [],
      changes: [],
      presentNPCs: [],
      status: null,
      thinking: '',
      relation: null,
      tasks: null,
      phoneLock: null,
      chat: null,
      raw: rawText
    };
    // 剥离 ``` 包裹
    let text = rawText.trim();
    text = text.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return parsed;
    const firstLine = lines[0];
    const isItem = /^新?获得?物品|^物品/.test(firstLine);
    const isChange = /^角色变化|^变化/.test(firstLine);
    const contentLines = lines.slice(1).filter(l =>
      l && l !== '无' && !/^（.*）$/.test(l) && !/^\(.*\)$/.test(l)
    );
    if (isItem) {
      contentLines.forEach(l => parsed.items.push(l));
    } else if (isChange) {
      const t = contentLines.join('\n').trim();
      if (t) parsed.changes.push(t);
    } else {
      // 兜底：当物品处理
      contentLines.forEach(l => parsed.items.push(l));
    }
    return parsed;
  }

  async function streamStructuredFromParsed(bubbleEl, parsed) {
    const fadeInStyle = 'opacity:0;transition:opacity 0.28s ease';
    if (parsed.items.length === 0 && parsed.changes.length === 0) return;
    const fullHtml = Chat.buildAIMessageHTML(parsed, { id: 'tutorial-sys-stream' });
    const temp = document.createElement('div');
    temp.innerHTML = fullHtml;
    const itemsDiv = temp.querySelector('.msg-items');
    if (itemsDiv) {
      itemsDiv.style.cssText = fadeInStyle;
      bubbleEl.appendChild(itemsDiv);
      scrollBottom();
      await wait(80);
      itemsDiv.style.opacity = '1';
      await wait(300);
    }
    scrollBottom();
  }

  function buildContentHTML(content) {
    const text = String(content || '');
    // 普通教程文案用Markdown渲染即可
    return `<div class="msg-body md-content">${Markdown.render(text)}</div>`;
  }

  function buildStructuredHTML(content) {
    // 结构化内容（finalPreview）走正式AI气泡渲染
    const text = String(content || '');
    if (Chat && typeof Chat.buildAIMessageHTML === 'function') {
      const parsed = Utils.parseAIOutput(text);
      return Chat.buildAIMessageHTML(parsed, { id: 'tutorial-preview' });
    }
    return `<div class="msg-body md-content">${Markdown.render(text)}</div>`;
  }

  function wait(ms) {
    if (_skipAnim) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function streamText(bubbleEl, text) {
    const body = bubbleEl.querySelector('.msg-body');
    if (!body) { bubbleEl.innerHTML = buildContentHTML(text); return; }
    // 跳过模式：直接渲染完整内容
    if (_skipAnim) {
      body.innerHTML = Markdown.render(text);
      scrollBottom();
      return;
    }
    body.classList.add('streaming-cursor');
    const chars = Array.from(text);
    const len = chars.length;
    let rendered = '';
    // 速度：短文本慢一点有感觉，长文本快一点别拖节奏
    const baseDelay = len < 30 ? 48 : len < 80 ? 34 : 22;
    for (let i = 0; i < len; i++) {
      rendered += chars[i];
      body.innerHTML = Markdown.render(rendered);
      scrollBottom();
      // 标点符号稍微停顿
      const ch = chars[i];
      if ("，。！？…—、；：“”‘’".includes(ch)) {
        await wait(baseDelay * 3);
      } else if ('\n'.includes(ch)) {
        await wait(baseDelay * 2);
      } else {
        await wait(baseDelay);
      }
    }
    body.classList.remove('streaming-cursor');
    body.innerHTML = Markdown.render(text);
    scrollBottom();
    // 气泡之间加一点呼吸感
    await wait(500);
  }

  async function streamStructured(bubbleEl, rawText) {
    const parsed = Utils.parseAIOutput(rawText);
    const fadeInStyle = 'opacity:0;transition:opacity 0.28s ease';

    // 1. 头部信息栏：一排一排出现
    if (parsed.header.region || parsed.header.time) {
      const headerEl = document.createElement('div');
      headerEl.className = 'msg-header';
      bubbleEl.appendChild(headerEl);
      scrollBottom();

      const headerParts = [];
      if (parsed.header.region) {
        headerParts.push('<span class="loc"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg> ' + Utils.escapeHtml(parsed.header.region) + '</span>');
      }
      if (parsed.header.location) {
        headerParts.push('<span class="loc">' + Utils.escapeHtml(parsed.header.location) + '</span>');
      }
      if (parsed.header.time) {
        headerParts.push('<span class="time"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> ' + Utils.escapeHtml(parsed.header.time) + '</span>');
      }
      if (parsed.header.weather) {
        headerParts.push('<span class="weather">' + Utils.escapeHtml(parsed.header.weather) + '</span>');
      }

      for (let i = 0; i < headerParts.length; i++) {
        const row = document.createElement('span');
        row.style.cssText = fadeInStyle + ';display:inline-flex;align-items:center';
        row.innerHTML = headerParts[i];
        headerEl.appendChild(row);
        scrollBottom();
        await wait(70);
        row.style.opacity = '1';
        await wait(180);
      }
      await wait(160);
    }

    // 2. 正文：逐字流式 + 小光标
    if (parsed.body) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'msg-body md-content streaming-cursor';
      bubbleEl.appendChild(bodyEl);
      const chars = Array.from(parsed.body);
      const len = chars.length;
      let rendered = '';
      const baseDelay = len < 30 ? 42 : len < 80 ? 28 : 18;
      for (let i = 0; i < len; i++) {
        rendered += chars[i];
        bodyEl.innerHTML = Markdown.render(rendered);
        scrollBottom();
        const ch = chars[i];
        if ("，。！？…—、；：“”‘’".includes(ch)) {
          await wait(baseDelay * 3);
        } else if (ch === '\n') {
          await wait(baseDelay * 2);
        } else {
          await wait(baseDelay);
        }
      }
      bodyEl.classList.remove('streaming-cursor');
      bodyEl.innerHTML = Markdown.render(parsed.body);
      scrollBottom();
    }

    // 3. 底部卡片区域：整体渐显
    if (parsed.items.length > 0 || parsed.changes.length > 0 || parsed.presentNPCs.length > 0) {
      await wait(200);
      const fullHtml = Chat.buildAIMessageHTML(parsed, { id: 'tutorial-stream' });
      const temp = document.createElement('div');
      temp.innerHTML = fullHtml;
      const itemsDiv = temp.querySelector('.msg-items');
      const npcDiv = temp.querySelector('.npc-tags');
      if (itemsDiv) {
        itemsDiv.style.cssText = fadeInStyle;
        bubbleEl.appendChild(itemsDiv);
        scrollBottom();
        await wait(80);
        itemsDiv.style.opacity = '1';
        await wait(300);
      }
      if (npcDiv) {
        npcDiv.style.cssText = fadeInStyle;
        bubbleEl.appendChild(npcDiv);
        scrollBottom();
        await wait(80);
        npcDiv.style.opacity = '1';
        await wait(200);
      }
    }
    scrollBottom();
  }

  async function playNode(nodeId) {
    const script = getScript();
    const node = script[nodeId];
    if (!node) {
      console.warn('[Tutorial] missing node:', nodeId);
      finish();
      return;
    }
    currentNode = nodeId;
    _skipAnim = false;
    renderOptions([]);
    _showSkipBtn();

    const messages = Array.isArray(node.messages) ? node.messages : [];
    for (let i = 0; i < messages.length; i++) {
      await appendAIBubble(messages[i], true);
    }
    if (node.systemCard) {
      await appendSystemCard(node.systemCard);
    }
    if (node.finalPreview) {
      await appendStructuredBubble(getFinalPreviewText());
    }
    _hideSkipBtn();
    renderOptions(node.options || []);
  }

  function _showSkipBtn() {
    let btn = document.getElementById('tutorial-skip-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'tutorial-skip-btn';
      btn.textContent = '跳过动画 ▸▸';
      btn.style.cssText = 'position:fixed;top:56px;right:12px;z-index:700;padding:6px 14px;font-size:12px;background:var(--bg-secondary,#2a2a2a);color:var(--text-secondary,#aaa);border:1px solid var(--border,#444);border-radius:16px;cursor:pointer;opacity:0.8;transition:opacity 0.2s';
      btn.onclick = () => {
        _skipAnim = true;
        btn.style.opacity = '0.3';
        btn.style.pointerEvents = 'none';
      };
      document.body.appendChild(btn);
    }
    btn.style.display = 'block';
    btn.style.opacity = '0.8';
    btn.style.pointerEvents = 'auto';
  }

  function _hideSkipBtn() {
    const btn = document.getElementById('tutorial-skip-btn');
    if (btn) btn.style.display = 'none';
  }

  function _addInputHighlight() {
    const input = chatInput();
    if (input) {
      input.style.outline = '1.5px solid var(--accent, #e8a04a)';
      input.style.outlineOffset = '-1px';
      input.dataset.tutorialHighlight = '1';
    }
  }

  function _removeInputHighlight() {
    const input = chatInput();
    if (input && input.dataset.tutorialHighlight) {
      input.style.outline = '';
      input.style.outlineOffset = '';
      delete input.dataset.tutorialHighlight;
    }
  }

  async function handleOption(opt) {
    if (!opt) return;
    if (opt.action) {
      await runAction(opt.action);
    }
    if (opt.next) {
      await playNode(opt.next);
      return;
    }
    renderOptions([]);
  }

  async function runAction(action) {
    switch (action) {
      case 'pickup_key':
        await Character.addItemDirect('新获得物品\n钥匙：入城的通行证，意味着你已经做好了第一步准备。');
        break;
      case 'delete_key':
        await Character.removeItemByName('钥匙');
        break;
      case 'finish_direct':
        await finish();
        break;
      default:
        console.warn('[Tutorial] unknown action:', action);
    }
  }

  function getFinalPreviewText() {
    var lines = [];
    lines.push('天枢城·入口');
    lines.push('城门外·引导处');
    lines.push('2065年4月25日 星期五 14:00');
    lines.push('晴朗 24℃（室外）｜微风，适合出行');
    lines.push('---');
    lines.push('城门缓缓打开，光线从缝隙中涌入。');
    lines.push('');
    lines.push('引导员靠在墙边，随手翻着一本旧杂志，头也不抬地朝你挥了挥手。');
    lines.push('');
    lines.push('"好了——知道这些就可以了。去吧，剩下的自己探索去。"');
    lines.push('');
    lines.push('TA顿了一下，又补充了句——');
    lines.push('');
    lines.push("“如果你忘记了，或者还想打听更详细的东西，随时可以从‘右上角菜单’里找到我。”");
    lines.push('');
    lines.push('"祝你好运。"');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('```');
    lines.push('新获得物品');
    lines.push('无');
    lines.push('```');
    lines.push('');
    lines.push('```');
    lines.push('当前相关角色');
    lines.push('引导员');
    lines.push('```');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('```status');
    lines.push('地点：天枢城·入口广场');
    lines.push('时间：2065年3月27日 星期五 14:30');
    lines.push('天气：晴朗 22℃');
    lines.push('场景：引导员站在天枢城入口牌坊下，身后是熙攘的街市。');
    lines.push('用户角色-{{user}}-衣着：一身普通的出行装束。');
lines.push('用户角色-{{user}}-姿势：站在引导员面前，刚刚完成登记。');
lines.push('角色-引导员-衣着：一袭深青色制服，胸前别着天枢城徽章。');
lines.push('角色-引导员-姿势：站在牌坊下，手中拿着登记册。');
    lines.push('```');
    return lines.join('\n');
  }

  async function ensureDefaultWorldview() {
    try {
      if (typeof Worldview?.switchWorldview === 'function') {
        await Worldview.switchWorldview('__default_wv__');
      } else if (typeof Worldview?.restoreCurrentWorldview === 'function') {
        await Worldview.restoreCurrentWorldview();
      }
    } catch (e) {
      console.warn('[Tutorial.worldview]', e);
    }
  }

  function markSeen() {
    localStorage.setItem(STORAGE_SEEN_KEY, '1');
  }

  function markDone() {
    localStorage.setItem(STORAGE_DONE_KEY, '1');
    localStorage.setItem(STORAGE_SEEN_KEY, '1');
  }

  function shouldAutoStart() {
    return !localStorage.getItem(STORAGE_DONE_KEY) && !localStorage.getItem(STORAGE_SEEN_KEY);
  }

  async function start({ auto = false } = {}) {
    active = true;
    started = true;
    firstRun = auto;
    markSeen();
    try { UI.showPanel('chat'); } catch (_) {}
    try { UI.toggleTopMenu(false); } catch (_) {}
    await ensureDefaultWorldview();
    clearChat();
    setInputDisabled(true);
    _addInputHighlight();
    renderOptions([]);
    await playNode('start');
  }

  async function restart() {
    await start({ auto: false });
  }

  async function finish() {
    markDone();
    active = false;
    currentNode = null;
    _skipAnim = false;
    _hideSkipBtn();
    _removeInputHighlight();
    renderOptions([]);
    setInputDisabled(false);
    try { UI.showToast('新手引导已完成', 1800); } catch (_) {}
  }

  async function init() {
    setInputDisabled(false);
    renderOptions([]);
    if (shouldAutoStart()) {
      await start({ auto: true });
    }
  }

  return {
    init,
    start,
    restart,
    finish,
    isEnabled,
    toggleOptions
  };
})();
