// 现实时间感知工具：生成 system 提示块 + 给用户消息拼时间戳前缀
// 对外：TimeAwareness.buildPrompt(lastAssistantTs, lastUserTs) / stampUserMessages(historyMsgs)
window.TimeAwareness = (function() {
  'use strict';

  const WEEK = ['周日','周一','周二','周三','周四','周五','周六'];

  function _fmt(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${WEEK[d.getDay()]}`;
  }

  function _humanDiff(fromTs, toTs) {
    const ms = Math.max(0, toTs - fromTs);
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec} 秒`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    if (hr < 24) return remMin ? `${hr} 小时 ${remMin} 分钟` : `${hr} 小时`;
    const day = Math.floor(hr / 24);
    const remHr = hr % 24;
    return remHr ? `${day} 天 ${remHr} 小时` : `${day} 天`;
  }

  /**
   * 构建现实时间感知 prompt 块
   * @param {number} lastAssistantTs 上一条 AI 消息的时间戳（毫秒），可空
   * @param {number} lastUserTs      最新一条用户消息时间戳（毫秒），可空
   */
  function buildPrompt(lastAssistantTs, lastUserTs) {
    const now = Date.now();
    const lines = ['【现实时间感知】'];
    lines.push(`当前时间：${_fmt(now)}`);
    if (lastUserTs) {
      lines.push(`{{user}} 最新这条消息时间:${_fmt(lastUserTs)}`);
    }
    if (lastAssistantTs) {
      lines.push(`你上次回复时间：${_fmt(lastAssistantTs)}`);
      lines.push(`距离你上次回复：${_humanDiff(lastAssistantTs, now)}`);
    } else {
      lines.push(`（这是你第一次在本对话回复）`);
    }
    lines.push('');
    lines.push('你可以根据以上信息自然地感知时间流逝，但不需要刻意提及"现在是几点"、"距离你上次回复多久"这类机械数据，除非 {{user}} 问起或语境合适。');
    return lines.join('\n');
  }

  /**
   * 给历史消息里的 user 消息拼时间戳前缀（返回新的数组，不修改原数据）
   * 只给 user 消息加；assistant 保持原样
   */
  function stampUserMessages(historyForAPI, messages) {
    // messages 是原始 messages（含 timestamp），historyForAPI 是已 filter 过的映射对象
    // 两者需要按序对齐 - 用 filter 里同样的条件重建映射
    const withTs = messages.filter(m => !m.hidden);
    // 长度对齐保险
    if (withTs.length !== historyForAPI.length) return historyForAPI;
    return historyForAPI.map((m, i) => {
      if (m.role !== 'user') return m;
      const ts = withTs[i] && withTs[i].timestamp;
      if (!ts) return m;
      const d = new Date(ts);
      const pad = n => String(n).padStart(2, '0');
      const tag = `[${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}] `;
      return { ...m, content: tag + (m.content || '') };
    });
  }

  /**
   * 从 messages 里找出最近一条 assistant / user 消息的时间戳
   */
  function extractTimestamps(messages) {
    let lastA = 0, lastU = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!lastA && m.role === 'assistant' && m.timestamp) lastA = m.timestamp;
      if (!lastU && m.role === 'user' && m.timestamp) lastU = m.timestamp;
      if (lastA && lastU) break;
    }
    return { lastAssistantTs: lastA, lastUserTs: lastU };
  }

  return { buildPrompt, stampUserMessages, extractTimestamps };
})();