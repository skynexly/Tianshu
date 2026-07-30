/**
 * 消息急救
 *
 * 背景：AI 偶发输出超长内容（几万到几十万字），主线渲染会一次性做 markdown 解析 + 塞进
 * DOM，直接卡死 WebView。而启动时会自动恢复上次对话 —— 于是「打开即崩」，连设置都进不去。
 *
 * 本模块提供不经过渲染的处置入口：
 *   1. 只读取消息的长度和开头片段（纯文本 escape，绝不跑 markdown、不渲染正文），
 *      因此无论那条消息多长，本页自身都不会卡。
 *   2. 每条消息可「截断」（保留前 N 字）或「删除」，直接写 IndexedDB。
 *
 * 配合 app.js 的安全模式（?safe=1）：跳过启动自动进入对话，用户即可进到这里。
 */
const Rescue = (() => {
  'use strict';

  const PREVIEW_CHARS = 60;      // 列表里每条显示多少字的开头片段
  const TRUNCATE_KEEP = 2000;    // 截断时保留多少字
  const WARN_LEN = 20000;        // 超过多少字标红提示

  let _convId = null;            // 当前查看的对话；null = 停在对话选择列表

  // ===== 入口 =====

  async function render() {
    _convId = null;
    await _renderConvList();
  }

  // ===== 对话列表 =====

  async function _renderConvList() {
    const box = document.getElementById('rescue-body');
    if (!box) return;
    box.innerHTML = '<div style="padding:24px 0;text-align:center;color:var(--text-secondary);font-size:13px">正在统计…</div>';

    let convs = [];
    try {
      convs = (typeof Conversations !== 'undefined' && Conversations.getList) ? (Conversations.getList() || []) : [];
    } catch(_) {}
    if (!convs.length) {
      box.innerHTML = '<div style="padding:24px 0;text-align:center;color:var(--text-secondary);font-size:13px">没有对话</div>';
      return;
    }

    // 逐个对话统计：消息数 + 最长消息字数。只读长度，不碰内容渲染。
    const rows = [];
    for (const c of convs) {
      if (!c || !c.id) continue;
      let msgs = [];
      try { msgs = await DB.getAllByIndex('messages', 'conversationId', c.id) || []; } catch(_) {}
      let maxLen = 0;
      msgs.forEach(m => {
        const len = ((m && m.content) || '').length;
        if (len > maxLen) maxLen = len;
      });
      rows.push({ id: c.id, name: c.name || '未命名对话', count: msgs.length, maxLen });
    }
    // 最长消息越长越靠前，方便直接找到出问题的那个对话
    rows.sort((a, b) => b.maxLen - a.maxLen);

    box.innerHTML = rows.map(r => {
      const danger = r.maxLen >= WARN_LEN;
      return `<div onclick="Rescue.openConv('${_esc(r.id)}')"
        style="display:flex;align-items:center;gap:10px;padding:12px;background:var(--bg-tertiary);border-radius:10px;margin-bottom:8px;cursor:pointer">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(r.name)}</div>
          <div style="font-size:11px;color:${danger ? 'var(--danger)' : 'var(--text-secondary)'};margin-top:2px">
            ${r.count} 条消息 · 最长 ${r.maxLen.toLocaleString()} 字${danger ? '（可能导致卡死）' : ''}
          </div>
        </div>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--text-secondary)"><path d="m9 18 6-6-6-6"/></svg>
      </div>`;
    }).join('');
  }

  // ===== 消息列表 =====

  async function openConv(convId) {
    _convId = convId;
    await _renderMsgList();
  }

  async function _renderMsgList() {
    const box = document.getElementById('rescue-body');
    if (!box) return;
    box.innerHTML = '<div style="padding:24px 0;text-align:center;color:var(--text-secondary);font-size:13px">正在读取…</div>';

    let msgs = [];
    try { msgs = await DB.getAllByIndex('messages', 'conversationId', _convId) || []; } catch(_) {}

    let convName = '';
    try {
      const c = (Conversations.getList() || []).find(x => x.id === _convId);
      convName = c ? (c.name || '未命名对话') : '';
    } catch(_) {}

    const backBtn = `<button onclick="Rescue.render()"
      style="margin-bottom:12px;padding:8px 14px;border-radius:8px;background:var(--bg-tertiary);color:var(--text);border:none;font-size:13px;cursor:pointer">← 返回对话列表</button>`;

    if (!msgs.length) {
      box.innerHTML = backBtn + '<div style="padding:24px 0;text-align:center;color:var(--text-secondary);font-size:13px">这个对话没有消息</div>';
      return;
    }

    // 按长度倒序：出问题那条永远在最前面
    msgs.sort((a, b) => ((b && b.content) || '').length - ((a && a.content) || '').length);

    const head = `${backBtn}
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px">
        「${_esc(convName)}」共 ${msgs.length} 条，按长度从大到小排列
      </div>`;

    box.innerHTML = head + msgs.map(m => {
      const content = (m && m.content) || '';
      const len = content.length;
      const danger = len >= WARN_LEN;
      // 关键：只取开头片段并做 HTML escape，绝不走 markdown 渲染
      const preview = content.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ');
      const roleLabel = m.role === 'user' ? '我' : (m.role === 'assistant' ? 'AI' : (m.role || '?'));
      const time = m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN') : '';
      return `<div style="padding:12px;background:var(--bg-tertiary);border-radius:10px;margin-bottom:8px${danger ? ';border:1px solid var(--danger)' : ''}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);color:var(--text-secondary)">${_esc(roleLabel)}</span>
          <span style="font-size:12px;color:${danger ? 'var(--danger)' : 'var(--text-secondary)'};font-weight:600">${len.toLocaleString()} 字</span>
          <span style="font-size:11px;color:var(--text-secondary);margin-left:auto">${_esc(time)}</span>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:10px;word-break:break-all">${_esc(preview)}${len > PREVIEW_CHARS ? '…' : ''}</div>
        <div style="display:flex;gap:8px">
          <button onclick="Rescue.truncate('${_esc(m.id)}')"
            style="flex:1;padding:8px;border-radius:8px;background:var(--bg);color:var(--text);border:1px solid var(--border);font-size:12px;cursor:pointer">截断到 ${TRUNCATE_KEEP} 字</button>
          <button onclick="Rescue.remove('${_esc(m.id)}')"
            style="flex:1;padding:8px;border-radius:8px;background:var(--bg);color:var(--danger);border:1px solid var(--border);font-size:12px;cursor:pointer">删除这条</button>
        </div>
      </div>`;
    }).join('');
  }

  // ===== 操作 =====

  // 截断：保留前 TRUNCATE_KEEP 字，其余丢弃。消息本体保留，上下文不断。
  async function truncate(msgId) {
    let msg = null;
    try { msg = await DB.get('messages', msgId); } catch(_) {}
    if (!msg) { UI.showToast('消息不存在', 1500); return; }
    const len = (msg.content || '').length;
    if (len <= TRUNCATE_KEEP) { UI.showToast('这条消息不长，不需要截断', 1800); return; }

    const ok = await UI.showConfirm('确认截断',
      `这条消息有 ${len.toLocaleString()} 字，将只保留前 ${TRUNCATE_KEEP} 字，其余内容删除。\n\n消息本身会保留，上下文不会断。此操作不可撤销。`);
    if (!ok) return;

    msg.content = (msg.content || '').slice(0, TRUNCATE_KEEP) + '\n\n[超长内容已截断]';
    try { await DB.put('messages', msg); } catch(e) {
      UI.showToast('保存失败：' + (e.message || '未知'), 2000);
      return;
    }
    UI.showToast('已截断，重新打开对话即可', 2500);
    await _renderMsgList();
  }

  // 删除：整条移除
  async function remove(msgId) {
    let msg = null;
    try { msg = await DB.get('messages', msgId); } catch(_) {}
    if (!msg) { UI.showToast('消息不存在', 1500); return; }
    const len = (msg.content || '').length;

    const ok = await UI.showConfirm('确认删除',
      `将删除这条 ${len.toLocaleString()} 字的消息。\n\n此操作不可撤销。如果只是想让对话能打开，建议先用「截断」。`);
    if (!ok) return;

    try {
      await DB.del('messages', msgId);
    } catch(e) {
      UI.showToast('删除失败：' + (e.message || '未知'), 2000);
      return;
    }

    UI.showToast('已删除，重新打开对话即可', 2500);
    await _renderMsgList();
  }

  function _esc(s) {
    try { return Utils.escapeHtml(String(s == null ? '' : s)); }
    catch(_) { return String(s == null ? '' : s); }
  }

  return { render, openConv, truncate, remove };
})();
