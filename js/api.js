/**
 * API 调用层 — 自动降级（流式不可用时走非流式）
 */
const API = (() => {
  async function getConfig() {
    return Settings.getCurrent();
  }

  async function buildMessages(conversationMessages, systemPromptParts) {
    const messages = [];
    const systemContent = systemPromptParts.join('\n\n---\n\n');
    messages.push({ role: 'system', content: systemContent });
    for (const msg of conversationMessages) {
      messages.push({ role: msg.role, content: msg.content });
    }
    return messages;
  }

  /**
   * 检测是否支持流式读取
   */
  function supportsStreaming() {
    try {
      return typeof ReadableStream !== 'undefined' && typeof TextDecoder !== 'undefined';
    } catch (e) {
      return false;
    }
  }

  /**
   * 清理模型名（暂不清洗，中转站需要标记来路由）
   */
  function cleanModelName(name) {
    return (name || '').trim();
  }

  /**
 * 发送聊天请求 — 自动选择流式/非流式
 */
async function streamChat(messages, onChunk, onDone, onError, abortSignal, options) {
    const config = await getConfig();
    const overrideConfig = options?.overrideConfig;
    const effectiveUrl = (overrideConfig?.apiUrl || config.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const effectiveKey = overrideConfig?.apiKey || config.apiKey;
    const effectiveModel = cleanModelName(overrideConfig?.model || config.model);
    if (!effectiveKey || !effectiveUrl) {
      onError('请先在设置中配置 API Key 和端点');
      return;
    }

    const url = effectiveUrl;
    const useStream = (options?.forceNoStream) ? false : supportsStreaming();
    const model = effectiveModel;

    GameLog.log('info', `API请求: ${model}, stream=${useStream}${options?.forceNoStream ? ' (用户关闭流式)' : ''}`);
    GameLog.log('info', `端点: ${url}`);

    const body = {
      model: model,
      messages: messages
    };

    // 工具定义（tool calling）
    if (options?.tools?.length) {
      body.tools = options.tools;
    }

    // 只在有值时加可选参数
    const temp = parseFloat(config.temperature);
    if (!isNaN(temp)) body.temperature = temp;
    // overrideConfig?.maxTokens 优先，其次全局配置
    const maxTkOverride = overrideConfig?.maxTokens;
    const maxTk = (maxTkOverride && parseInt(maxTkOverride) > 0)
      ? parseInt(maxTkOverride)
      : parseInt(config.maxTokens);
    if (!isNaN(maxTk) && maxTk > 0) body.max_tokens = maxTk;
    body.stream = useStream;

  GameLog.log('info', `参数: model=${model}, temp=${body.temperature}, max_tokens=${body.max_tokens}, msgs=${messages.length}条`);
  GameLog.log('info', `完整请求体: ${JSON.stringify(body).substring(0, 500)}`);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${effectiveKey}`
      },
      body: JSON.stringify(body),
      signal: abortSignal
    });

    if (!resp.ok) {
      let errText = '';
      try { errText = await resp.text(); } catch(e) { errText = resp.statusText; }
      GameLog.log('error', `API ${resp.status}: ${errText.substring(0, 500)}`);
      GameLog.log('error', `响应头: ${JSON.stringify(Object.fromEntries([...resp.headers.entries()].slice(0, 10)))}`);
      onError(`API错误 ${resp.status}: ${errText.substring(0, 200)}`);
      return;
    }

    // 尝试流式，失败则降级非流式
    if (body.stream) {
      try {
        await readStream(resp, onChunk, onDone, abortSignal, options);
        return;
      } catch (streamErr) {
        // AbortError 不降级，直接向上抛
        if (streamErr.name === 'AbortError') throw streamErr;
        GameLog.log('warn', `流式失败: ${streamErr.message}`);
      }
    }
    // 非流式降级
    const json = await resp.json();
    const message = json.choices?.[0]?.message;
    const toolCalls = message?.tool_calls;
    // 如果模型返回了 tool_calls，走工具回调
    if (toolCalls?.length && options?.onToolCalls) {
      GameLog.log('info', `[API] 收到 tool_calls: ${toolCalls.map(t => t.function?.name).join(', ')}`);
      options.onToolCalls(toolCalls, message);
      return;
    }
    const content = message?.content || '';
    GameLog.log('info', `响应: ${content.length}字`);
    onChunk(content, content);
    onDone(content);
  } catch (e) {
    if (e.name === 'AbortError') {
      GameLog.log('info', '请求已中止');
      throw e; // 向上抛出，让调用方处理
    }
    GameLog.log('error', `网络错误: ${e.message}`);
    onError(`网络错误: ${e.message}`);
  }
}

  async function readStream(resp, onChunk, onDone, abortSignal, options) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let toolCallsAccum = []; // 流式累积 tool_calls

  try {
    while (!abortSignal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            onChunk(delta.content, fullContent);
          }
          // 流式 tool_calls 累积
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsAccum[idx]) {
                toolCallsAccum[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCallsAccum[idx].id = tc.id;
              if (tc.function?.name) toolCallsAccum[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCallsAccum[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch (e) { /* skip */ }
      }
    }
  } finally {
    try { reader.cancel(); } catch(e) {}
  }

  // 如果是被中止的，不调onDone，抛出让外层处理
  if (abortSignal?.aborted) {
    const err = new Error('AbortError');
    err.name = 'AbortError';
    throw err;
  }

  // 如果有 tool_calls，走工具回调
  if (toolCallsAccum.length > 0 && options?.onToolCalls) {
    const validCalls = toolCallsAccum.filter(t => t.function?.name);
    if (validCalls.length > 0) {
      GameLog.log('info', `[API] 流式收到 tool_calls: ${validCalls.map(t => t.function?.name).join(', ')}`);
      options.onToolCalls(validCalls, { role: 'assistant', content: fullContent || null, tool_calls: validCalls });
      return;
    }
  }

  onDone(fullContent);
}

  /**
   * v687.6：带工具循环的流式聊天（最高 maxIter 轮工具调用）
   * 行为：
   *   - 模型返回 tool_calls → 执行工具 → 把结果塞回 messages → 再请求（仍带 tools）
   *   - 模型返回文本 content → 走 onChunk / onDone 正常完成
   *   - 达到 maxIter 仍在调工具 → 走 onError 报错
   * 调用方传 messages 数组，会被本函数修改（push assistant tool_calls + tool 结果）
   */
  async function streamChatWithTools(messages, onChunk, onDone, onError, abortSignal, options) {
    const maxIter = options?.maxToolIterations || 5;

    for (let iter = 0; iter < maxIter; iter++) {
      let toolCallsReceived = null;
      let assistantMsgFromTools = null;
      let errorOccurred = null;

      // 用 Promise 把回调式 streamChat 包装一下，方便外层 await
      await new Promise((resolve) => {
        let settled = false;
        const settle = () => { if (!settled) { settled = true; resolve(); } };

        streamChat(
          messages,
          // onChunk：原样转发
          (chunk, fullContent) => {
            try { onChunk(chunk, fullContent); } catch(_) {}
          },
          // onDone：文本回复完成 → 上抛
          (fullContent) => {
            try { onDone(fullContent); } catch(_) {}
            settle();
          },
          // onError：上抛
          (err) => {
            errorOccurred = err;
            settle();
          },
          abortSignal,
          {
            ...options,
            // 接管 tool_calls：不在回调里执行，把控制权交回循环
            onToolCalls: (toolCalls, message) => {
              toolCallsReceived = toolCalls;
              assistantMsgFromTools = message;
              settle();
            }
          }
        ).catch(e => {
          if (e?.name === 'AbortError') { settle(); return; }
          errorOccurred = e?.message || String(e);
          settle();
        });
      });

      if (abortSignal?.aborted) {
        return;
      }
      if (errorOccurred) {
        try { onError(errorOccurred); } catch(_) {}
        return;
      }
      if (!toolCallsReceived) {
        // 已 onDone，正常结束
        return;
      }

      // 有工具调用 → 执行所有，把结果塞回 messages
      messages.push({
        role: 'assistant',
        content: assistantMsgFromTools?.content || null,
        tool_calls: toolCallsReceived
      });

      for (const tc of toolCallsReceived) {
        let result;
        try {
          result = await Tools.execute(tc);
        } catch (e) {
          result = `工具执行异常：${e?.message || e}`;
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result || ''
        });
        try { GameLog.log('info', `[API] 工具 ${tc.function?.name} 返回: ${String(result).substring(0, 200)}`); } catch(_) {}
      }
      // 继续下一轮（仍带 tools，让 AI 决定是再调工具还是给最终回复）
    }

    // 达到 maxIter 上限
    try { GameLog.log('error', `[API] 工具调用迭代超过 ${maxIter} 次，强制中断`); } catch(_) {}
    try { onError(`AI 工具调用次数超过 ${maxIter} 次上限，对话中断（避免无限循环）`); } catch(_) {}
  }

  /**
   * 非流式调用（总结等）— 实际走流式拼接，避免中转站网关超时
   */
  async function summarize(content, summaryPrompt, options) {
    const mainConfig = await getConfig();
    const funcConfig = (options?.useMainModel) ? {} : Settings.getSummaryConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl).replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = cleanModelName(funcConfig.model || mainConfig.model);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: summaryPrompt },
          { role: 'user', content: content }
        ],
        stream: true,
        temperature: 0.3,
        max_tokens: 20000
      })
    });

    if (!resp.ok) throw new Error(`总结API错误: ${resp.status}`);

    // 流式拼接
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let result = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) result += delta;
        } catch(_) {}
      }
    }
    // 处理残余 buffer
    if (buffer.trim() && buffer.trim() !== 'data: [DONE]' && buffer.trim().startsWith('data: ')) {
      try {
        const json = JSON.parse(buffer.trim().slice(6));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) result += delta;
      } catch(_) {}
    }

    return result;
  }

  /**
   * 获取模型列表
   */
  async function fetchModelList(apiUrl, apiKey) {
    const url = apiUrl.replace(/\/$/, '') + '/models';
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const json = await resp.json();
    return (json.data || json || [])
      .map(m => typeof m === 'string' ? m : (m.id || m.name || ''))
      .filter(Boolean)
      .sort();
  }

  /**
   * 调用记忆提取模型
   */
  async function extractMemory(content, extractPrompt, options) {
    const mainConfig = await getConfig();
    const funcConfig = (options?.useMainModel) ? {} : Settings.getMemoryConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl).replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = cleanModelName(funcConfig.model || mainConfig.model);

    GameLog.log('info', `记忆提取: model=${model}`);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: extractPrompt },
          { role: 'user', content: content }
        ],
        temperature: 0.3,
        max_tokens: 20000
      })
    });

    if (!resp.ok) throw new Error(`记忆提取API错误: ${resp.status}`);
    const json = await resp.json();
    return json.choices?.[0]?.message?.content || '';
  }

  /**
   * 识图：调用 vision 模型（没配就用主模型），传入 base64 dataURL，返回描述文字
   */
  async function describeImage(base64DataUrl, prompt) {
    const mainConfig = await getConfig();
    const funcConfig = Settings.getVisionConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl).replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = cleanModelName(funcConfig.model || mainConfig.model);
    if (!url || !key || !model) throw new Error('请先配置 API Key 和端点');

    const userContent = [
      { type: 'text', text: prompt || '请描述这张图片的内容' },
      { type: 'image_url', image_url: { url: base64DataUrl } }
    ];

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: userContent }],
        stream: false,
        max_tokens: 1000
      })
    });

    if (!resp.ok) throw new Error(`识图 API 错误: ${resp.status}`);
    const json = await resp.json();
    return (json.choices?.[0]?.message?.content || '').trim();
  }

  /**
   * 世界观生成专用（非流式，主模型，高温度）
   */
  async function generate(systemPrompt, userPrompt, options = {}) {
    const mainConfig = await getConfig();
    const url = (mainConfig.apiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = mainConfig.apiKey;
    const model = cleanModelName(mainConfig.model);
    if (!url || !key || !model) throw new Error('请先配置API');

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: false,
        temperature: options.temperature ?? 0.8,
        max_tokens: options.maxTokens ?? 16000
      }),
      signal: options.signal
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`生成API错误 ${resp.status}: ${errText.substring(0, 200)}`);
    }
    const json = await resp.json();
    return json.choices?.[0]?.message?.content || '';
  }

  /**
   * 生成图片（OpenAI 兼容 /v1/images/generations）
   */
  async function generateImage(prompt, options = {}) {
    const drawConfig = Settings.getDrawConfig();
    const mainConfig = await getConfig();
    const url = (drawConfig.apiUrl || mainConfig.apiUrl || '').replace(/\/$/, '') + '/images/generations';
    const key = drawConfig.apiKey || mainConfig.apiKey;
    const model = drawConfig.model || '';
    if (!url || !key) throw new Error('请先在设置→功能模型→生图模型中配置 API');

    const body = {
      prompt,
      n: options.n || 1,
      size: options.size || '1024x768',
      response_format: 'b64_json'
    };
    if (model) body.model = model;

    // 超时控制（90秒），避免中转站卡住时永远转圈不报错
    const timeout = options.timeout || 90000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const mergedSignal = options.signal
      ? (() => { options.signal.addEventListener('abort', () => controller.abort()); return controller.signal; })()
      : controller.signal;

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: mergedSignal
      });
    } catch(e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`生图超时（${Math.round(timeout/1000)}秒无响应），可能是站点暂时不可用`);
      throw e;
    }
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      throw new Error(`生图失败: ${resp.status} ${errText.substring(0, 200)}`);
    }

    const json = await resp.json();
    // 把 b64_json 直接转 dataURL；URL 形式则下载一遍转 base64，避免临时URL过期后图灰飞烟灭
    const rawList = (json.data || []).map(d => {
      if (d.b64_json) return { type: 'b64', value: d.b64_json };
      if (d.url) return { type: 'url', value: d.url };
      return null;
    }).filter(Boolean);

    const images = [];
    let fallbackFailures = 0;  // v687.6：统计图床 fallback 失败次数
    for (const item of rawList) {
      if (item.type === 'b64') {
        images.push(`data:image/png;base64,${item.value}`);
      } else {
        // URL 模式：下载并转 base64
        try {
          const imgResp = await fetch(item.value);
          if (!imgResp.ok) throw new Error(`下载失败 ${imgResp.status}`);
          const blob = await imgResp.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          images.push(dataUrl);
        } catch(e) {
          fallbackFailures++;
          console.warn('[generateImage] 图床下载失败:', item.value, e);
          images.push(item.value);
        }
      }
    }
    // 全部走 URL 且全部失败：弹明确提示（而不是默默返回死链）
    if (fallbackFailures > 0 && fallbackFailures === rawList.length) {
      try { UI.showToast(`图片下载失败（${fallbackFailures}张）：可能是网络环境无法访问图床，建议切 WiFi 重试`, 3500); } catch(_) {}
    }
    return images.filter(Boolean);
  }

  /**
   * v687.6：Unsplash 配图搜索
   * @param {string} query 英文关键词（必须英文，中文返回空）
   * @param {number} perPage 1~5，默认1
   * @returns {Promise<string|null>} 图片URL（regular尺寸）或 null
   */
  async function searchUnsplash(query, perPage = 1) {
    const key = (typeof Settings !== 'undefined' && Settings.getUnsplashKey) ? Settings.getUnsplashKey() : '';
    if (!key || !query) return null;
    try {
      const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape&client_id=${encodeURIComponent(key)}`;
      const r = await fetch(url, { method: 'GET' });
      if (!r.ok) return null;
      const json = await r.json();
      const results = json.results || [];
      if (!results.length) return null;
      // 随机一张避免每次同 query 都一样
      const pick = results[Math.floor(Math.random() * results.length)];
      return pick.urls?.regular || pick.urls?.small || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 回复建议（非流式）
   */
  async function suggest(recentMessages, charPrompt) {
    const mainConfig = await getConfig();
    const funcConfig = Settings.getSuggestConfig();
    const url = (funcConfig.apiUrl || mainConfig.apiUrl).replace(/\/$/, '') + '/chat/completions';
    const key = funcConfig.apiKey || mainConfig.apiKey;
    const model = funcConfig.model || mainConfig.model;

    const charName = charPrompt?.name || '用户角色';
    const charDesc = charPrompt?.desc || '';

    const dialogue = recentMessages.map(m =>
      `[${m.role === 'user' ? charName : 'AI'}] ${m.content}`
    ).join('\n\n');

    const systemPrompt = `你是一个角色扮演的回复建议助手。
以下是用户的角色设定：
角色名：${charName}
${charDesc ? `角色描述：${charDesc}` : ''}

以下是最近的对话：
${dialogue}

请根据角色设定和对话上下文，生成 3 个不同的回复。
要求：
- 符合${charName}的人设和说话风格
- 每个建议 1-3 句话，包含语言描写和动作描写
- 延续${charName}的回复风格，使用类似的符号区分动作描写和语言描写（例如使用括号包裹动作，或使用引号包裹语言等，和用户过去的回复保持一致）
- 在符合${charName}人设的情况下，给出三个倾向略有不同的回复，例如偏保守、偏主动、常规
- 不要重复对话中已经出现过的内容

输出格式（严格遵守，不要输出 JSON，不要加序号或其他说明）：
每个回复独占若干行，回复之间用单独一行的「===」分隔。例如：

（动作描写）"对话内容"
===
（动作描写）"对话内容"
===
（动作描写）"对话内容"`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: systemPrompt }],
        temperature: 0.9,
      max_tokens: 2048,
      }),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}: ${resp.statusText}`);
    const json = await resp.json();
    let text = json.choices?.[0]?.message?.content || '';
    // thinking 模型可能 content 为空，从其他字段找正文
    if (!text) {
      const msg = json.choices?.[0]?.message || {};
      for (const k of Object.keys(msg)) {
        if (k === 'role' || k === 'refusal' || k === 'tool_calls' || k === 'reasoning_content') continue;
        const v = msg[k];
        if (typeof v === 'string' && v.trim().length > 5) { text = v; break; }
      }
    }
    if (!text) throw new Error('模型返回为空');
    // 清理 markdown / 思考标签
    text = text.replace(/```[\s\S]*?\n/g, '').replace(/```/g, '');
    text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    text = text.replace(/<\/?output>/gi, '');
    text = text.trim();
    // 按 === 分隔（兼容全角／半角、前后空白）
    let items = text.split(/\n?\s*={3,}\s*\n?/).map(s => s.trim()).filter(Boolean);
    // 如果没有分隔符（模型没听话），尝试按 JSON 数组兜底
    if (items.length < 2) {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          const arr = JSON.parse(match[0]);
          if (Array.isArray(arr) && arr.length >= 2) return arr;
        } catch(_) {}
      }
      // 再兜底：按双换行分隔
      items = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    }
    // 去掉每条可能残留的序号前缀（1. / 1、/ - 等）
    items = items.map(s => s.replace(/^\s*(?:\d+[.、)]\s*|[-*]\s*)/, '').trim()).filter(Boolean);
    if (items.length === 0) throw new Error('未能解析出回复建议');
    return items.slice(0, 5);
  }

  return { getConfig, buildMessages, streamChat, streamChatWithTools, summarize, extractMemory, describeImage, fetchModelList, generate, generateImage, searchUnsplash, suggest };
})();
