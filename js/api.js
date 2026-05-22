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
    const maxTk = parseInt(config.maxTokens);
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
   * 非流式调用（总结等）
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
        stream: false,
        temperature: 0.3,
        max_tokens: 20000
      })
    });

    if (!resp.ok) throw new Error(`总结API错误: ${resp.status}`);
    const json = await resp.json();
    return json.choices?.[0]?.message?.content || '';
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

  return { getConfig, buildMessages, streamChat, summarize, extractMemory, fetchModelList, generate, generateImage, searchUnsplash };
})();
