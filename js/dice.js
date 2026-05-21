// 骰点系统 v686
// 对话级字段：
//   conv.diceEnabled : boolean
//   conv.diceMax     : number  (默认 100)
//   conv.diceRule    : '<='|'<'|'>='|'>' (默认 '<=')
//   conv.diceRolls   : [{ id, attr, attrValue, diceMax, rule, result, success, consumed, time }]
//
// AI 触发标记：正文里写  【检定·属性名】
// 前端识别后渲染成 "🎲 请完成 X 检定" 按钮，点击弹投骰面板
// 投骰结果作为 OOC 块拼接到下一条用户消息
window.Dice = (() => {

  const RULE_LABELS = { '<=': '≤', '<': '<', '>=': '≥', '>': '>' };
  const ALL_RULES = ['<=', '<', '>=', '>'];

  // Lucide dices 双骰子 SVG，用 currentColor 自动适配主题
  const ICON_DICES = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:-0.15em;flex-shrink:0"><rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/></svg>`;
  // 模态标题专用：尺寸大一点 + 加 dice-icon-title class，便于 CSS 触发投掷动画
  const ICON_DICES_TITLE = `<svg class="dice-icon-title" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;flex-shrink:0;transform-origin:50% 50%"><rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/></svg>`;

  // ===== 当前对话快捷访问 =====
  function _curConv() {
    try {
      const id = Conversations.getCurrent();
      if (!id) return null;
      return Conversations.getList().find(c => c.id === id) || null;
    } catch(_) { return null; }
  }

  function isEnabled() {
    const c = _curConv();
    return !!(c && c.diceEnabled);
  }

  function getConfig() {
    const c = _curConv();
    return {
      enabled: !!(c?.diceEnabled),
      max: (c && Number.isFinite(+c.diceMax) && +c.diceMax > 0) ? +c.diceMax : 100,
      rule: (c && ALL_RULES.includes(c.diceRule)) ? c.diceRule : '<=',
    };
  }

  // ===== 数值系统访问：读取当前对话的全局属性列表 =====
  async function _listGlobalAttrs() {
    try {
      const conv = _curConv();
      if (!conv) return [];
      const gp = conv.convGameplay;
      const arr = (gp?.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim());
      return arr;
    } catch(_) { return []; }
  }

  // 取属性当前值（优先状态栏累计，回退到 initial）
  function _getAttrValue(attr) {
    try {
      const status = Conversations.getStatusBar() || {};
      const g = status.customAttrs?.global || {};
      const v = g[attr.id];
      if (v != null && Number.isFinite(+v)) return +v;
    } catch(_) {}
    return Number.isFinite(+attr.initial) ? +attr.initial : 0;
  }

  // ===== 启用前置检查：必须先配数值系统 =====
  async function ensurePrerequisite() {
    const attrs = await _listGlobalAttrs();
    if (attrs.length > 0) return true;
    const ok = await UI.showConfirm(
      '骰点系统需要数值',
      '骰点检定依赖数值系统里配置的属性（例如「力量」「敏捷」）。\n当前对话还没有任何全局属性。\n\n点击「确定」去配置数值系统？'
    );
    if (ok) {
      try { ConvGameplay.openAttrEditor(); } catch(_) {}
    }
    return false;
  }

  // ===== 投骰核心 =====
  function _roll(max) {
    return Math.floor(Math.random() * max) + 1;
  }

  function _judge(result, target, rule) {
    switch (rule) {
      case '<':  return result < target;
      case '<=': return result <= target;
      case '>':  return result > target;
      case '>=': return result >= target;
      default:   return result <= target;
    }
  }

  // ===== 投骰面板（弹窗） =====
  let _modalEl = null;
  let _modalState = null;  // { lockedAttrName, rolls[] }

  function _ensureModal() {
    if (_modalEl) return _modalEl;
    const m = document.createElement('div');
    m.id = 'dice-modal';
    m.className = 'modal hidden';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
    m.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;width:100%;max-width:380px;max-height:85vh;overflow:auto;padding:18px;box-sizing:border-box;display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="font-size:15px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:6px">
            <span class="dice-icon-title-wrap" style="display:inline-flex;align-items:center;justify-content:center;transform-origin:50% 50%">${ICON_DICES_TITLE}</span><span>骰点检定</span>
          </div>
          <button type="button" onclick="Dice.closeModal()" style="background:transparent;border:none;color:var(--text-secondary);font-size:20px;cursor:pointer;line-height:1">×</button>
        </div>
        <div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">选择检定属性</div>
          <select id="dice-attr-select" style="width:100%;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px"></select>
        </div>
        <div id="dice-attr-info" style="font-size:12px;color:var(--text-secondary);background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;padding:8px 10px;line-height:1.6"></div>
        <div id="dice-result-area" style="min-height:60px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
          <button type="button" id="dice-btn-reroll" onclick="Dice.rollOnce()" style="padding:7px 14px;background:var(--bg);border:1px solid var(--accent);border-radius:6px;color:var(--accent);font-size:13px;cursor:pointer">投掷</button>
          <button type="button" id="dice-btn-confirm" onclick="Dice.confirmAndSend()" style="padding:7px 14px;background:var(--accent);border:none;border-radius:6px;color:#111;font-size:13px;cursor:pointer;display:none">确认结果</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    _modalEl = m;
    // 切换属性时刷新当前值
    m.querySelector('#dice-attr-select').addEventListener('change', _refreshAttrInfo);
    // 点遮罩关闭
    m.addEventListener('click', e => { if (e.target === m) closeModal(); });
    return m;
  }

  async function openModal(presetAttrName) {
    if (!isEnabled()) {
      UI.showToast('该对话未启用骰点系统', 1500);
      return;
    }
    const attrs = await _listGlobalAttrs();
    if (!attrs.length) {
      const ok = await UI.showConfirm('没有可用属性', '当前对话没有配置任何全局属性，无法投骰。\n点击「确定」去配置？');
      if (ok) { try { ConvGameplay.openAttrEditor(); } catch(_) {} }
      return;
    }
    _ensureModal();
    _modalState = { lockedAttrName: presetAttrName || null, rolls: [] };
    // 填属性选项
    const sel = _modalEl.querySelector('#dice-attr-select');
    sel.innerHTML = attrs.map(a => `<option value="${Utils.escapeHtml(a.id)}" data-name="${Utils.escapeHtml(a.name)}">${Utils.escapeHtml(a.name)}</option>`).join('');
    // 预选锁定
    if (presetAttrName) {
      const hit = attrs.find(a => (a.name || '').trim() === presetAttrName.trim());
      if (hit) {
        sel.value = hit.id;
        sel.disabled = true;
      } else {
        sel.disabled = false;
      }
    } else {
      sel.disabled = false;
    }
    _modalEl.querySelector('#dice-result-area').innerHTML = '';
    _modalEl.querySelector('#dice-btn-confirm').style.display = 'none';
    _modalEl.querySelector('#dice-btn-reroll').textContent = '投掷';
    _refreshAttrInfo();
    _modalEl.classList.remove('hidden');
  }

  function closeModal() {
    if (_modalEl) _modalEl.classList.add('hidden');
    _modalState = null;
  }

  async function _refreshAttrInfo() {
    if (!_modalEl) return;
    const sel = _modalEl.querySelector('#dice-attr-select');
    const attrs = await _listGlobalAttrs();
    const a = attrs.find(x => x.id === sel.value);
    const cfg = getConfig();
    const info = _modalEl.querySelector('#dice-attr-info');
    if (!a) { info.innerHTML = ''; return; }
    const val = _getAttrValue(a);
    info.innerHTML = `
      <div>属性：<b style="color:var(--text)">${Utils.escapeHtml(a.name)}</b> · 当前值 <b style="color:var(--accent)">${val}</b></div>
      <div style="margin-top:4px">骰子：1d${cfg.max} · 规则：结果 <b>${RULE_LABELS[cfg.rule]}</b> 属性值 视为成功</div>`;
  }

  async function rollOnce() {
    if (!_modalEl || !_modalState) return;
    const sel = _modalEl.querySelector('#dice-attr-select');
    const attrs = await _listGlobalAttrs();
    const a = attrs.find(x => x.id === sel.value);
    if (!a) { UI.showToast('请选择属性', 1500); return; }
    const cfg = getConfig();
    const val = _getAttrValue(a);
    // 动效：标题骰子转一圈（动画作用在外层 span 上，比直接动 SVG 稳）
    try {
      const ic = _modalEl.querySelector('.dice-icon-title-wrap');
      if (ic && typeof ic.animate === 'function') {
        ic.animate([
          { transform: 'rotate(0deg) scale(1)' },
          { transform: 'rotate(360deg) scale(1.25)', offset: 0.5 },
          { transform: 'rotate(720deg) scale(1)' },
        ], {
          duration: 550,
          easing: 'cubic-bezier(.4,1.4,.55,1)',
          iterations: 1,
        });
      }
    } catch(_) {}
    const result = _roll(cfg.max);
    const success = _judge(result, val, cfg.rule);
    _modalState.rolls.push({
      id: 'roll_' + Utils.uuid().slice(0, 8),
      attr: a.name,
      attrValue: val,
      diceMax: cfg.max,
      rule: cfg.rule,
      result,
      success,
      time: Date.now(),
    });
    _modalEl.querySelector('#dice-btn-reroll').textContent = '再投一次';
    _modalEl.querySelector('#dice-btn-confirm').style.display = '';
    _renderResultArea();
  }

  function _renderResultArea() {
    if (!_modalEl || !_modalState) return;
    const area = _modalEl.querySelector('#dice-result-area');
    const rolls = _modalState.rolls;
    if (!rolls.length) { area.innerHTML = ''; return; }
    const last = rolls[rolls.length - 1];
    const histHtml = rolls.length > 1
      ? `<div style="margin-top:8px;font-size:11px;color:var(--text-secondary);line-height:1.6">历史：${rolls.slice(0,-1).map(r => `<span style="opacity:.65">${r.result}${r.success ? '✓' : '✗'}</span>`).join(' · ')}</div>`
      : '';
    area.innerHTML = `
      <div style="background:var(--bg-tertiary);border:1px solid ${last.success ? 'var(--accent)' : 'var(--border)'};border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:${last.success ? 'var(--accent)' : 'var(--text)'};line-height:1.2">${last.result}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:3px">1d${last.diceMax} · 目标 ${last.attrValue} · ${RULE_LABELS[last.rule]}</div>
        <div style="font-size:14px;font-weight:600;margin-top:6px;color:${last.success ? 'var(--accent)' : 'var(--danger,#c0524e)'}">${last.success ? '成功 ✅' : '失败 ❌'}</div>
        ${histHtml}
      </div>`;
  }

  // 确认 = 把最后一次 roll 标 consumed=false 存进 conv.diceRolls，关闭弹窗
  async function confirmAndSend() {
    if (!_modalEl || !_modalState || !_modalState.rolls.length) return;
    const last = _modalState.rolls[_modalState.rolls.length - 1];
    const conv = _curConv();
    if (!conv) return;
    if (!Array.isArray(conv.diceRolls)) conv.diceRolls = [];
    conv.diceRolls.push({
      id: last.id,
      attr: last.attr,
      attrValue: last.attrValue,
      diceMax: last.diceMax,
      rule: last.rule,
      result: last.result,
      success: last.success,
      consumed: false,
      time: last.time,
    });
    try { await DB.put('conversations', conv); } catch(_) {}
    closeModal();
    UI.showToast(`检定已确认：${last.attr} ${last.result} ${last.success ? '成功' : '失败'}`, 2200);
    // 在聊天区追加一个跟随气泡（视觉提示，未发送）
    _renderPendingBubble();
  }

  // ===== 气泡：跟随聊天记录，按消息列表底部追加（持久化到 conv.diceRolls）=====
  function _renderPendingBubble() {
    // 简单方案：渲染一个临时的预备发送气泡到聊天区底部
    try {
      const conv = _curConv();
      if (!conv) return;
      const pending = (conv.diceRolls || []).filter(r => !r.consumed);
      if (!pending.length) return;
      const last = pending[pending.length - 1];
      const container = document.getElementById('chat-messages');
      if (!container) return;
      // 移除上一个 pending
      container.querySelectorAll('.dice-bubble-pending').forEach(el => el.remove());
      const div = document.createElement('div');
      div.className = 'dice-bubble dice-bubble-pending';
      div.innerHTML = _bubbleHTML(last, true);
      container.appendChild(div);
      try {
        if (typeof scrollToBottomIfFollowing === 'function') scrollToBottomIfFollowing();
        else container.scrollTop = container.scrollHeight;
      } catch(_) { container.scrollTop = container.scrollHeight; }
    } catch(_) {}
  }

  function _bubbleHTML(roll, pending) {
    const ruleLab = RULE_LABELS[roll.rule] || roll.rule;
    const cls = roll.success ? 'dice-bubble-success' : 'dice-bubble-fail';
    const tag = pending ? '<span class="dice-bubble-tag">待发送</span>' : '';
    return `
      <div class="dice-bubble-inner ${cls}">
        <div class="dice-bubble-row1">
          <span class="dice-bubble-attr">${ICON_DICES} ${Utils.escapeHtml(roll.attr)}检定</span>
          ${tag}
        </div>
        <div class="dice-bubble-row2">1d${roll.diceMax} = <b>${roll.result}</b> / ${roll.attrValue} (${ruleLab}) · <b>${roll.success ? '成功 ✅' : '失败 ❌'}</b></div>
      </div>`;
  }

  // 渲染气泡：v686.1 简化
  // 历史 roll 已经作为 OOC 块拼在 user 消息气泡里，不需要重复渲染
  // 只保留"已确认但未发送"的 pending 气泡（让玩家在发送前看到结果）
  function renderHistoryBubbles() {
    try {
      const container = document.getElementById('chat-messages');
      if (!container) return;
      // 清掉所有 dice 气泡（含旧版 history）
      container.querySelectorAll('.dice-bubble').forEach(el => el.remove());
      // 只渲染 pending
      _renderPendingBubble();
    } catch(_) {}
  }

  // ===== 发送时拼 OOC 块 =====
  // 调用者：chat.send() 在拼 userContentForAPI 前调用 Dice.consumePendingForSend()
  // 返回 { ooc: string | '', consumedIds: [] }
  async function consumePendingForSend() {
    const conv = _curConv();
    if (!conv) return { ooc: '', consumedIds: [] };
    if (!conv.diceEnabled) return { ooc: '', consumedIds: [] };
    const pending = (conv.diceRolls || []).filter(r => !r.consumed);
    if (!pending.length) return { ooc: '', consumedIds: [] };
    // 只带最后一次确认的 roll
    const last = pending[pending.length - 1];
    const ruleLab = RULE_LABELS[last.rule] || last.rule;
    const ooc = `[骰点检定 · ${last.attr} · 1d${last.diceMax}=${last.result} / 目标值${last.attrValue} / 规则${ruleLab} / ${last.success ? '成功' : '失败'}]`;
    // 全部 pending 标 consumed
    const ids = pending.map(r => r.id);
    pending.forEach(r => { r.consumed = true; });
    try { await DB.put('conversations', conv); } catch(_) {}
    return { ooc, consumedIds: ids };
  }

  // ===== AI 提示词块（启用时注入到 system parts） =====
  function buildPromptBlock() {
    if (!isEnabled()) return '';
    const cfg = getConfig();
    const ruleLab = RULE_LABELS[cfg.rule];
    return [
      '【骰点系统玩法】',
      `当前对话启用了骰点系统。骰子规则：1d${cfg.max}，结果 ${ruleLab} 属性值 视为成功，反之失败。`,
      '当剧情进展到需要判定的关键节点时（例如玩家尝试撬锁、说服、闪避、攀爬等不确定结果的行为），请在你这一段回复的最末尾追加一行检定标记，格式严格如下：',
      '【检定·属性名】',
      '其中"属性名"必须是玩家在数值系统里实际配置过的属性名称（例如【检定·力量】【检定·敏捷】【检定·感知】）。',
      '注意：',
      '· 不要写"请掷一个力量检定"这种口语化话术，只在末尾打标记。前端会自动渲染成可点击的投骰按钮。',
      '· 一次回复最多打一个标记。剧情不需要判定就不打。',
      '· 不要自己代玩家投骰，也不要预设成功/失败。等玩家投完，结果会作为 OOC 块在下一轮告诉你。',
      '· 收到 OOC 检定结果后，请基于成功/失败推进剧情。',
    ].join('\n');
  }

  // ===== 标记识别（前端把【检定·X】渲染成按钮） =====
  // 给 chat.js 的 buildAIMessageHTML 调用：传入 body 文本，返回带按钮的 HTML
  // 注意：调用方应该在 Markdown.render 之后再做替换，或者用占位符法
  const CHECK_PATTERN = /【检定·([^】]+)】/g;

  function replaceCheckMarkers(html) {
    if (!html || typeof html !== 'string') return html;
    return html.replace(CHECK_PATTERN, (m, attrName) => {
      const safe = Utils.escapeHtml(String(attrName).trim());
      // 注意：html 已经过 Markdown 渲染，attrName 出现在文本节点里
      return `<button type="button" class="dice-check-btn" onclick="event.stopPropagation();Dice.openModal('${safe.replace(/'/g, "&#39;")}')">${ICON_DICES} 请完成 ${safe} 检定</button>`;
    });
  }

  // ===== 重置（对话清空时调用，留接口） =====
  async function reset() {
    const conv = _curConv();
    if (!conv) return;
    conv.diceRolls = [];
    try { await DB.put('conversations', conv); } catch(_) {}
    renderHistoryBubbles();
  }

  return {
    isEnabled,
    getConfig,
    ensurePrerequisite,
    openModal,
    closeModal,
    rollOnce,
    confirmAndSend,
    consumePendingForSend,
    buildPromptBlock,
    replaceCheckMarkers,
    renderHistoryBubbles,
    reset,
  };
})();
