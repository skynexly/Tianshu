/**
 * 风闻 — 论坛/微博/茶馆等信息载体系统
 */
const WorldVoice = (() => {
  let posts = []; // 当前帖子列表
  let currentDetail = null; // 当前查看的帖子详情
  let isGenerating = false;
  let _abortCtrl = null;
  let isMinimized = false;

  // 从DB恢复帖子缓存
  (async function _restorePosts() {
    try {
      const cached = await DB.get('gameState', 'wv_posts');
      if (cached?.value) posts = cached.value;
    } catch(e) {}
  })();

  async function _savePosts() {
    try { await DB.put('gameState', { key: 'wv_posts', value: posts }); } catch(e) {}
  }

  // 获取信息载体名称
  async function _getMediaType() {
    const wv = await Worldview.getCurrent();
    return wv?.mediaType || '论坛';
  }

  // 更新加号菜单里的按钮名
  async function updateLabel() {
    const label = document.getElementById('world-voice-label');
    if (label) label.textContent = await _getMediaType();
  }

  // 打开窗口
  async function open() {
    const modal = document.getElementById('wv-voice-modal');
    if (!modal) return;
    const mediaType = await _getMediaType();
    document.getElementById('wv-voice-title').textContent = mediaType;
    // 显示列表视图
    document.getElementById('wv-voice-list-view').style.display = 'flex';
    document.getElementById('wv-voice-detail-view').classList.add('hidden');
    modal.classList.remove('hidden');
    document.getElementById('wv-voice-fab')?.classList.add('hidden');
    isMinimized = false;
    // 如果有缓存的帖子就渲染
    if (posts.length > 0) _renderPosts();
  }

  function minimize() {
  const modal = document.getElementById('wv-voice-modal');
  if (!modal) return;
  modal.classList.add('closing');
  setTimeout(() => {
    modal.classList.remove('closing');
    modal.classList.add('hidden');
    const fab = document.getElementById('wv-voice-fab');
    if (fab) {
      fab.classList.remove('hidden');
      fab.classList.toggle('generating', !!isGenerating);
    }
  }, 220);
  isMinimized = true;
}

  function restore() {
  const modal = document.getElementById('wv-voice-modal');
  if (!modal) return;
  modal.classList.remove('closing');
  modal.classList.remove('hidden');
  const fab = document.getElementById('wv-voice-fab');
  if (fab) {
    fab.classList.remove('generating');
    fab.classList.add('hidden');
  }
  isMinimized = false;
}

  async function close() {
  if (isGenerating) {
    if (!await UI.showConfirm('关闭风闻', '正在生成内容，关闭将中断当前生成。确定关闭？')) return;
    if (_abortCtrl) _abortCtrl.abort();
    _abortCtrl = null;
    isGenerating = false;
    UI.showToast('已中断生成');
  }
  const modal = document.getElementById('wv-voice-modal');
  if (modal) {
    modal.classList.add('closing');
    setTimeout(() => {
      modal.classList.remove('closing');
      modal.classList.add('hidden');
      document.getElementById('wv-voice-fab')?.classList.add('hidden');
    }, 220);
  }
  isMinimized = false;
}

  // 抓当前游戏时间：优先状态栏 time，回退到最近一条 AI 消息中的"YYYY年M月D日..."
  function _extractGameTime() {
    try {
      const sb = (typeof Conversations !== 'undefined') ? Conversations.getStatusBar() : null;
      if (sb?.time) return sb.time;
    } catch(_) {}
    try {
      const chatMessages = (typeof Chat !== 'undefined' && Chat.getMessages) ? Chat.getMessages() : [];
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i].role !== 'assistant') continue;
        const tm = chatMessages[i].content.match(/\d{4}年\d{1,2}月\d{1,2}日[^\n]*/);
        if (tm) return tm[0];
      }
    } catch(_) {}
    return '';
  }

  // 刷新帖子（含3次重试）
  async function refresh() {
    if (isGenerating) return;
    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) { UI.showToast('请先在设置→功能模型中配置模型'); return; }
    isGenerating = true;
    const fab = document.getElementById('wv-voice-fab');
    if (fab && isMinimized) fab.classList.add('generating');
    const btn = document.getElementById('wv-voice-refresh-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
    }
    _renderLoadingSkeleton();

    _abortCtrl = new AbortController();

    const mediaType = '论坛';
    const wvPrompt = Chat.getWorldviewPrompt() || '';
    const chatMessages = Chat.getMessages();
    const summaryText = await Summary.formatForPrompt(Conversations.getCurrent());

    let gameTime = _extractGameTime();

    const recentMain = chatMessages.slice(-10).map(m =>
      `[${m.role === 'user' ? '玩家' : 'AI'}]: ${m.content}`
    ).join('\n');

    const systemPrompt = `你是一个论坛内容生成器。根据提供的世界观和当前剧情，生成论坛上的帖子。

要求：
1. 生成6-8条帖子预览
2. 80%的内容与世界观有关但与主线剧情无直接关系（日常生态、社会话题、生活琐事）
3. 20%的内容与主线正在发生的剧情有关联（但是从路人/旁观者视角，不会知道具体细节）
4. 每条内容的用户名要符合世界观风格
5. 帖子风格可长可短，有正经讨论也有水帖灌水，摘要长度不要千篇一律
6. 返回纯JSON数组，不要包含任何其他文字

JSON格式（严格遵循）：
[{"id":"p1","username":"用户名","avatar_color":"#颜色","time":"时间描述","title":"标题","summary":"摘要","tags":["标签1","标签2"],"views":数字,"likes":数字,"comments":数字}]`;

    let userPrompt = '';
    if (wvPrompt) userPrompt += `## 世界观\n${wvPrompt}\n\n`;
    if (summaryText) userPrompt += `## 剧情总结\n${summaryText}\n\n`;
    if (gameTime) userPrompt += `## 当前游戏时间\n${gameTime}\n\n`;
    if (recentMain) userPrompt += `## 最近剧情\n${recentMain}\n\n`;
    userPrompt += `请生成${mediaType}内容。`;

    const maxRetries = 3;
    let lastError = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (_abortCtrl?.signal.aborted) break;
      try {
        if (attempt > 1) {
          if (btn) {
            btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
            btn.title = `重试中(${attempt}/${maxRetries})...`;
          }
        }
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model, stream: false, temperature: 0.9, max_tokens: 4096,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ]
          }),
          signal: _abortCtrl?.signal
        });

        if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
        const json = await resp.json();
        const content = json.choices?.[0]?.message?.content || '';
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('AI返回格式不正确');
        posts = JSON.parse(jsonMatch[0]);
        await _savePosts();
        _hideLoadingHint();
        _renderPosts();
        UI.showToast('已刷新');
        lastError = '';
        break;
      } catch(e) {
        if (e.name === 'AbortError') { lastError = ''; _hideLoadingHint(); break; }
        lastError = e.message;
        console.error(`[WorldVoice] refresh attempt ${attempt} failed:`, e);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (lastError) {
      UI.showToast('生成失败: ' + lastError, 4000);
      const phoneContainer = document.getElementById('phone-forum-posts');
      if (phoneContainer) phoneContainer.innerHTML = `<div style="text-align:center;color:var(--danger);padding:24px;font-size:12px"><div>生成失败：${Utils.escapeHtml(lastError)}</div><div style="opacity:0.6;margin-top:6px">已重试${maxRetries}次，可尝试再次刷新</div></div>`;
      console.error('[WorldVoice] 最终失败 systemPrompt:', systemPrompt);
      console.error('[WorldVoice] 最终失败 userPrompt:', userPrompt);
    }
    _hideLoadingHint();

    isGenerating = false;
    _abortCtrl = null;
    document.getElementById('wv-voice-fab')?.classList.remove('generating');
    if (btn) {
      btn.disabled = false;
      btn.title = '刷新';
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
    }
  }

function _renderLoadingSkeleton() {
    const hint = document.getElementById('wv-voice-loading-hint');
    const container = document.getElementById('wv-voice-posts');
    if (hint) hint.classList.remove('hidden');
    if (!container) return;
    container.innerHTML = Array.from({ length: 5 }).map(() => `
      <div class="wv-skeleton-card">
        <div class="wv-skeleton-row">
          <div class="wv-skeleton-avatar"></div>
          <div class="wv-skeleton-line user"></div>
          <div class="wv-skeleton-line time"></div>
        </div>
        <div class="wv-skeleton-line title"></div>
        <div class="wv-skeleton-line summary-1"></div>
        <div class="wv-skeleton-line summary-2"></div>
        <div class="wv-skeleton-tags">
          <div class="wv-skeleton-pill"></div>
          <div class="wv-skeleton-pill"></div>
        </div>
        <div class="wv-skeleton-meta-row">
          <div class="wv-skeleton-meta"></div>
          <div class="wv-skeleton-meta"></div>
          <div class="wv-skeleton-meta"></div>
        </div>
      </div>
    `).join('');
  }

  function _hideLoadingHint() {
    document.getElementById('wv-voice-loading-hint')?.classList.add('hidden');
  }

  // 渲染帖子列表
  function _renderPosts() {
    const container = document.getElementById('wv-voice-posts');
    if (!container || posts.length === 0) return;
    container.innerHTML = posts.map((p, i) => `
      <div class="wv-post-card" style="animation-delay:${Math.min(i * 0.04, 0.2)}s" onclick="WorldVoice.viewDetail(${i})" style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px;cursor:pointer">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <div style="width:28px;height:28px;border-radius:50%;background:${Utils.escapeHtml(p.avatar_color || '#888')};display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:bold;flex-shrink:0">${Utils.escapeHtml((p.username || '?')[0])}</div>
          <span style="font-size:13px;color:var(--text);font-weight:bold">${Utils.escapeHtml(p.username || '匿名')}</span>
          <span style="font-size:11px;color:var(--text-secondary);margin-left:auto">${Utils.escapeHtml(p.time || '')}</span>
        </div>
        <div style="font-size:14px;font-weight:bold;color:var(--text);margin-bottom:6px">${Utils.escapeHtml(p.title || '')}</div>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;margin-bottom:8px">${Utils.escapeHtml(p.summary || '')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${(p.tags || []).map(t => `<span style="font-size:11px;background:var(--bg-tertiary);color:var(--accent);padding:2px 8px;border-radius:10px">${Utils.escapeHtml(t)}</span>`).join('')}</div>
        <div style="display:flex;gap:12px;font-size:11px;color:var(--text-secondary)">
          <span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>${_formatNum(p.views)}</span>
          <span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${_formatNum(p.likes)}</span>
          <span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${_formatNum(p.comments)}</span>
        </div>
      </div>
    `).join('');
  }

  function _formatNum(n) {
    if (!n) return '0';
    if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  // 查看帖子详情
  async function viewDetail(idx) {
    const post = posts[idx];
    if (!post || isGenerating) return;

    const listView = document.getElementById('wv-voice-list-view');
    const detailView = document.getElementById('wv-voice-detail-view');
    document.getElementById('wv-voice-detail-title').textContent = post.title;
    if (listView) listView.classList.add('wv-detail-entering-out');
    if (detailView) {
      detailView.classList.remove('hidden');
      detailView.style.display = 'flex';
      detailView.classList.remove('wv-detail-entering-in');
      void detailView.offsetWidth;
      detailView.classList.add('wv-detail-entering-in');
    }
    setTimeout(() => {
      if (listView) {
        listView.style.display = 'none';
        listView.classList.remove('wv-detail-entering-out');
      }
    }, 180);
    
    // 更新点赞数显示
    document.getElementById('wv-voice-like-count').textContent = post.likes || 0;
    try {
      const data = await DB.get('gameState', 'gaidenList');
      const list = data?.value || [];
      post._collected = list.some(item => item.type === 'worldvoice' && item.title === post.title && item.content === post.fullContent);
    } catch(e) {
      post._collected = !!post._collected;
    }
    const collectBtn = document.getElementById('wv-voice-collect-btn');
    const collectIcon = document.getElementById('wv-voice-collect-icon');
    if (collectBtn && collectIcon) {
      collectBtn.classList.toggle('active-collect', !!post._collected);
      collectBtn.style.color = post._collected ? 'var(--accent)' : 'var(--text-secondary)';
      collectIcon.setAttribute('fill', post._collected ? 'currentColor' : 'none');
    }

    // 如果已有缓存的详情，直接渲染
    if (post._detailLoaded) {
      currentDetail = post;
      _hideDetailLoading();
      _renderDetail();
      return;
    }

    // 没有缓存，生成详情
    currentDetail = post;
    post.fullContent = '';
    post._comments = [];
    _renderDetailLoading();

    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) { UI.showToast('请先配置模型'); return; }

    isGenerating = true;
    _abortCtrl = new AbortController();
    const wvPrompt = Chat.getWorldviewPrompt() || '';
    const gameTime = _extractGameTime();

    const systemPrompt = `你是一个论坛内容生成器。用户给你一条帖子的预览信息，请生成完整的帖子正文和评论区。

要求：
1. 正文长度符合论坛帖子风格——几百字到上千字不等，不要一律写成千字小作文，要像真的论坛用户在写东西
2. 评论区8-12条回复，风格多样（有赞同、反对、吐槽、跑题的），评论长度也要自然，有人一句话有人写一段
3. 评论者的用户名和说话风格要符合世界观
4. 评论时间要符合"当前游戏时间"，分布在最近几小时到几天内（绝对不要凭空瞎编年份/年代）
5. 返回纯JSON，不要包含任何其他文字

JSON格式：
{"content":"帖子完整正文","comments":[{"username":"用户名","avatar_color":"#颜色","content":"评论内容","time":"时间","likes":数字}]}`;

    const userPrompt = `## 世界观\n${wvPrompt}\n\n${gameTime ? `## 当前游戏时间\n${gameTime}\n\n` : ''}## 帖子预览\n标题：${post.title}\n摘要：${post.summary}\n发帖人：${post.username}\n标签：${(post.tags || []).join('、')}\n\n请生成完整内容和评论区。`;

    const maxRetries = 3;
    let lastError = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (_abortCtrl?.signal.aborted) break;
      try {
        if (attempt > 1) {
          _renderDetailLoading();
        }
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model, stream: false, temperature: 0.85, max_tokens: 8192,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ]
          }),
          signal: _abortCtrl?.signal
        });

        if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
        const json = await resp.json();
        const content = json.choices?.[0]?.message?.content || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('返回格式不正确');
        const detail = JSON.parse(jsonMatch[0]);
        post.fullContent = detail.content || '';
        post._comments = detail.comments || [];
        post._detailLoaded = true;
        currentDetail = post;
        await _savePosts();
        _hideDetailLoading();
        _renderDetail();
        UI.showToast('内容加载完成');
        lastError = '';
        break;
      } catch(e) {
        if (e.name === 'AbortError') { lastError = ''; break; }
        lastError = e.message;
        console.error(`[WorldVoice] detail attempt ${attempt} failed:`, e);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (lastError) {
      _hideDetailLoading();
      document.getElementById('wv-voice-detail-content').innerHTML = `<div style="text-align:center;color:var(--danger);padding:40px">加载失败: ${Utils.escapeHtml(lastError)}</div>`;
    }
    isGenerating = false;
  }

  function _renderDetailLoading() {
    const hint = document.getElementById('wv-voice-detail-loading-hint');
    const content = document.getElementById('wv-voice-detail-content');
    const actions = document.getElementById('wv-voice-detail-actions');
    if (hint) hint.classList.remove('hidden');
    if (actions) actions.style.opacity = '0.4';
    if (!content) return;
    content.innerHTML = `
      <div class="wv-detail-skeleton">
        <div class="wv-detail-skeleton-header">
          <div class="wv-detail-skeleton-avatar"></div>
          <div class="wv-detail-skeleton-meta">
            <div class="wv-detail-skeleton-line name"></div>
            <div class="wv-detail-skeleton-line time"></div>
          </div>
        </div>
        <div class="wv-detail-skeleton-line title"></div>
        <div class="wv-detail-skeleton-line body-1"></div>
        <div class="wv-detail-skeleton-line body-2"></div>
        <div class="wv-detail-skeleton-line body-3"></div>
        <div class="wv-detail-skeleton-line body-4"></div>
        <div class="wv-detail-skeleton-tags">
          <div class="wv-detail-skeleton-pill"></div>
          <div class="wv-detail-skeleton-pill"></div>
        </div>
        <div class="wv-detail-skeleton-comments">
          ${Array.from({ length: 3 }).map(() => `
            <div class="wv-detail-skeleton-comment">
              <div class="wv-detail-skeleton-avatar"></div>
              <div class="wv-detail-skeleton-comment-body">
                <div class="wv-detail-skeleton-line line-1"></div>
                <div class="wv-detail-skeleton-line line-2"></div>
                <div class="wv-detail-skeleton-line line-3"></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function _hideDetailLoading() {
    document.getElementById('wv-voice-detail-loading-hint')?.classList.add('hidden');
    const actions = document.getElementById('wv-voice-detail-actions');
    if (actions) actions.style.opacity = '1';
  }

  // 渲染详情
  function _renderDetail() {
    if (!currentDetail) return;
    const d = currentDetail;
    let html = '';
    // 发帖人信息
    html += `<div class="wv-detail-section" style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <div style="width:36px;height:36px;border-radius:50%;background:${Utils.escapeHtml(d.avatar_color || '#888')};display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;font-weight:bold">${Utils.escapeHtml((d.username || '?')[0])}</div>
      <div><div style="font-size:14px;font-weight:bold;color:var(--text)">${Utils.escapeHtml(d.username || '匿名')}</div>
      <div style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(d.time || '')}</div></div>
    </div>`;
    // 正文
    html += `<div class="md-content wv-detail-section wv-detail-md" style="font-size:14px;line-height:1.8;color:var(--text);background:var(--bg-tertiary);padding:12px;border-radius:8px;border:1px solid var(--border);margin-bottom:20px;animation-delay:0.03s">${Markdown.render(d.fullContent || '')}</div>`;
    // 标签
    if (d.tags?.length) {
      html += `<div class="wv-detail-section" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px;animation-delay:0.06s">${d.tags.map(t => `<span style="font-size:11px;background:var(--bg-tertiary);color:var(--accent);padding:2px 8px;border-radius:10px">${Utils.escapeHtml(t)}</span>`).join('')}</div>`;
    }
    // 互动数据
    html += `<div class="wv-detail-section" style="display:flex;gap:16px;font-size:12px;color:var(--text-secondary);padding:12px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:16px;animation-delay:0.09s">
      <span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>${_formatNum(d.views)}</span><span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${_formatNum(d.likes)}</span><span style="display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${_formatNum(d._comments?.length || 0)}</span></div>`;
    // 评论区
    if (d._comments?.length) {
      html += '<div class="wv-detail-section wv-detail-comments" style="animation-delay:0.12s"><div style="font-size:14px;font-weight:bold;color:var(--text);margin-bottom:12px">评论区</div>';
      d._comments.forEach((c, idx) => {
        html += `<div class="wv-comment-item" style="animation-delay:${0.14 + Math.min(idx * 0.03, 0.24)}s;display:flex;gap:10px;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border)">
          <div style="width:28px;height:28px;border-radius:50%;background:${Utils.escapeHtml(c.avatar_color || '#666')};display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:bold;flex-shrink:0">${Utils.escapeHtml((c.username || '?')[0])}</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <span style="font-size:13px;font-weight:bold;color:var(--text)">${Utils.escapeHtml(c.username || '匿名')}</span>
              <span style="font-size:11px;color:var(--text-secondary)">${Utils.escapeHtml(c.time || '')}</span>
            </div>
            <div class="md-content" style="font-size:13px;color:var(--text);line-height:1.6">${Markdown.render(c.content || '')}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${c.likes || 0}</div>
          </div>
        </div>`;
      });
    }
    document.getElementById('wv-voice-detail-content').innerHTML = html;
  }

  function backToList() {
    _hideDetailLoading();
    const detailView = document.getElementById('wv-voice-detail-view');
    const listView = document.getElementById('wv-voice-list-view');
    if (listView) {
      listView.style.display = 'flex';
      listView.classList.remove('wv-detail-entering-out');
      void listView.offsetWidth;
      listView.classList.add('wv-detail-entering-in');
    }
    if (detailView) {
      detailView.classList.remove('wv-detail-entering-in');
      detailView.classList.add('wv-detail-entering-out');
      setTimeout(() => {
        detailView.classList.add('hidden');
        detailView.style.display = 'none';
        detailView.classList.remove('wv-detail-entering-out');
        if (listView) listView.classList.remove('wv-detail-entering-in');
      }, 180);
    }
  }

  // 分享到主线（作为附件挂载）
  async function shareToMain() {
    if (!currentDetail) return;
    const mediaType = await _getMediaType();
    if (!await UI.showConfirm('分享到主线', `将这条${mediaType}内容作为附件挂载，下次发送消息时会一并带入上下文。`)) return;
    Chat.setWorldVoiceAttach({
      mediaType,
      title: currentDetail.title,
      content: currentDetail.fullContent,
      comments: currentDetail._comments || []
    });
    minimize();
    UI.showToast(`已挂载${mediaType}内容，发送消息时将一并带入`);
  }

  // 收藏帖子
  async function collectPost() {
    if (!currentDetail) return;
    const data = await DB.get('gameState', 'gaidenList');
    const list = data?.value || [];

    if (currentDetail._collected) {
      const idx = list.findIndex(item => item.type === 'worldvoice' && item.title === currentDetail.title && item.content === currentDetail.fullContent);
      if (idx !== -1) list.splice(idx, 1);
      await DB.put('gameState', { key: 'gaidenList', value: list });
      currentDetail._collected = false;
      const collectBtn = document.getElementById('wv-voice-collect-btn');
      const collectIcon = document.getElementById('wv-voice-collect-icon');
      if (collectBtn && collectIcon) {
        collectBtn.classList.remove('active-collect');
        collectBtn.style.color = 'var(--text-secondary)';
        collectIcon.setAttribute('fill', 'none');
      }
      UI.showToast('已取消收藏');
      return;
    }

    const saved = {
      id: 'wv_' + Utils.uuid().slice(0, 8),
      type: 'worldvoice',
      title: currentDetail.title,
      username: currentDetail.username,
      avatar_color: currentDetail.avatar_color,
      time: currentDetail.time,
      tags: currentDetail.tags,
      views: currentDetail.views,
      likes: currentDetail.likes,
      content: currentDetail.fullContent,
      comments: currentDetail._comments,
      sourceConv: Conversations.getCurrent(),
      sourceConvName: Conversations.getCurrentName(),
      savedAt: Date.now()
    };
    Gaiden.addToList(saved);
    list.unshift(saved);
    await DB.put('gameState', { key: 'gaidenList', value: list });
    currentDetail._collected = true;
    const collectBtn = document.getElementById('wv-voice-collect-btn');
    const collectIcon = document.getElementById('wv-voice-collect-icon');
    if (collectBtn && collectIcon) {
      collectBtn.classList.add('active-collect');
      collectBtn.style.color = 'var(--accent)';
      collectIcon.setAttribute('fill', 'currentColor');
    }
    UI.showToast('已收藏');
  }

  // 点赞（纯本地，增加计数）
  function likePost() {
    if (!currentDetail) return;
    currentDetail.likes = (currentDetail.likes || 0) + 1;
    document.getElementById('wv-voice-like-count').textContent = currentDetail.likes;
    const btn = document.getElementById('wv-voice-like-btn');
    if (btn) {
      btn.classList.add('active-like');
      btn.style.color = 'var(--danger)';
      btn.querySelector('svg')?.setAttribute('fill', 'currentColor');
    }
  }

  return {
    open, close, minimize, restore,
    refresh, viewDetail, backToList,
    shareToMain, collectPost, likePost,
    updateLabel,
    // 手机论坛接口
  getPosts: () => posts,
  getDetail: () => currentDetail,
  isRefreshing: () => isGenerating,
  abortRefresh: () => { if (_abortCtrl) _abortCtrl.abort(); },
  // 静默加载详情（只加载数据，不操作 DOM）
  // 参数可以是 index（在 posts 数组中）或 post 对象本身
  loadDetailSilent: async (idxOrPost) => {
    const post = (typeof idxOrPost === 'number') ? posts[idxOrPost] : idxOrPost;
    if (!post || post._detailLoaded) return post;
    const funcConfig = Settings.getWorldvoiceConfig ? Settings.getWorldvoiceConfig() : {};
    const mainConfig = await API.getConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;
    if (!url || !key || !model) throw new Error('请先配置功能模型');
    const wvPrompt = Chat.getWorldviewPrompt() || '';
    const gameTime = _extractGameTime();
    const systemPrompt = `你是一个论坛内容生成器。用户给你一条帖子的预览信息，请生成完整的帖子正文和评论区。

要求：
1. 正文长度符合论坛帖子风格——几百字到上千字不等，不要一律写成千字小作文，要像真的论坛用户在写东西
2. 评论区8-12条回复，风格多样（有赞同、反对、吐槽、跑题的），评论长度也要自然，有人一句话有人写一段
3. 评论者的用户名和说话风格要符合世界观
4. 评论时间要符合"当前游戏时间"，分布在最近几小时到几天内（绝对不要凭空瞎编年份/年代）
5. 返回纯JSON，不要包含任何其他文字

JSON格式：
{"content":"帖子完整正文","comments":[{"username":"用户名","avatar_color":"#颜色","content":"评论内容","time":"时间","likes":数字}]}`;
    const userPrompt = `## 世界观\n${wvPrompt}\n\n${gameTime ? `## 当前游戏时间\n${gameTime}\n\n` : ''}## 帖子预览\n标题：${post.title}\n摘要：${post.summary}\n发帖人：${post.username}\n标签：${(post.tags||[]).join('、')}\n\n请生成完整内容和评论区。`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, stream: false, temperature: 0.85, max_tokens: 8192, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
    });
    if (!resp.ok) throw new Error(`API错误: ${resp.status}`);
    const json = await resp.json();
    const content = json.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('返回格式不正确');
    const detail = JSON.parse(jsonMatch[0]);
    post.fullContent = detail.content || '';
    post._comments = detail.comments || [];
    post._detailLoaded = true;
    currentDetail = post;
    await _savePosts();
    return post;
  },
  };
})();