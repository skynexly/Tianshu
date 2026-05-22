// v687.23：MCP (Model Context Protocol) client
// 支持 HTTP (POST JSON-RPC) 和 SSE (Server-Sent Events) 两种 transport
// 配置存 localStorage('mcp_servers')，跨对话共享
//
// 对外接口：
//   MCPClient.getServers()                    => Array<{id, name, url, transport, enabled, auth, tools}>
//   MCPClient.saveServers(servers)
//   MCPClient.addServer(server)
//   MCPClient.removeServer(id)
//   MCPClient.updateServer(id, patch)
//   MCPClient.discoverTools(server)           => 拉一次 tools/list，返回 tools 数组
//   MCPClient.callTool(server, name, args)    => 调用一个工具
//   MCPClient.getEnabledToolDefs()            => 返回所有启用 server 的工具 schema（OpenAI 兼容）
//   MCPClient.isMCPToolCall(toolName)         => 判断工具名是否是 MCP 工具（以 mcp_ 开头）
//   MCPClient.executeToolCall(toolCall)       => 执行一个 mcp_ 工具调用，返回结果字符串
window.MCPClient = (function() {
  'use strict';

  const STORAGE_KEY = 'mcp_servers';
  const REQ_TIMEOUT_MS = 30000; // 30s 工具调用超时

  // === 存储 ===
  function getServers() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch(_) { return []; }
  }

  function saveServers(servers) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(servers || [])); } catch(_) {}
  }

  function addServer(server) {
    const list = getServers();
    list.push(server);
    saveServers(list);
  }

  function removeServer(id) {
    saveServers(getServers().filter(s => s.id !== id));
  }

  function updateServer(id, patch) {
    saveServers(getServers().map(s => s.id === id ? { ...s, ...patch } : s));
  }

  // === JSON-RPC 请求 ===
  let _reqId = 1;
  function _nextId() { return _reqId++; }

  function _buildHeaders(server) {
    // v687.25：Accept 必须明确带两种 MIME（MCP Streamable HTTP spec 要求）
    // 服务器会反射 OPTIONS 预检的 Access-Control-Request-Headers，所以 accept 是允许的
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (server.auth) {
      // 支持 Bearer token / 自定义 header
      if (server.auth.type === 'bearer' && server.auth.token) {
        h['Authorization'] = 'Bearer ' + server.auth.token;
      } else if (server.auth.type === 'header' && server.auth.headerName && server.auth.token) {
        h[server.auth.headerName] = server.auth.token;
      }
    }
    return h;
  }

  // 发一个 JSON-RPC 请求，返回 result（或抛 error）
  async function _rpcCall(server, method, params) {
    const id = _nextId();
    const body = { jsonrpc: '2.0', id, method, params: params || {} };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    try {
      console.log('[MCP] →', method, server.url);
      let resp;
      try {
        resp = await fetch(server.url, {
          method: 'POST',
          headers: _buildHeaders(server),
          body: JSON.stringify(body),
          signal: ctrl.signal,
          mode: 'cors'
        });
      } catch(netErr) {
        // 网络层失败（CORS / DNS / SSL / 离线）
        console.error('[MCP] fetch 失败:', netErr);
        throw new Error(`网络/CORS 失败：${netErr?.message || netErr}（按 F12 看 Network 标签的具体原因）`);
      }
      console.log('[MCP] ←', resp.status, resp.headers.get('content-type'));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(()=>'')}`);
      const ct = resp.headers.get('content-type') || '';
      let data;
      if (ct.includes('text/event-stream')) {
        // SSE 响应：读完所有 chunks，找最后一个含 result/error 的 data
        const text = await resp.text();
        // 简单解析：每个 event 块以 \n\n 分隔，每行 'data: xxx'
        const events = text.split(/\n\n+/).filter(Boolean);
        for (const ev of events.reverse()) {
          const dataLines = ev.split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trim())
            .join('');
          if (!dataLines || dataLines === '[DONE]') continue;
          try {
            const obj = JSON.parse(dataLines);
            if (obj.id === id && (obj.result !== undefined || obj.error)) {
              data = obj;
              break;
            }
          } catch(_) {}
        }
        if (!data) throw new Error('SSE: 未找到响应');
      } else {
        data = await resp.json();
      }
      if (data.error) throw new Error(`MCP ${data.error.code || ''}: ${data.error.message || 'unknown'}`);
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  // === MCP 方法封装 ===

  // 初始化握手（MCP spec 要求；可选，许多 server 不强制）
  async function initialize(server) {
    try {
      return await _rpcCall(server, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'tianshu-mcp-client', version: '1.0.0' }
      });
    } catch(e) {
      // initialize 不强制，失败也继续
      console.warn('[MCP] initialize 失败（继续）:', e.message);
      return null;
    }
  }

  // 列出工具
  async function listTools(server) {
    const result = await _rpcCall(server, 'tools/list', {});
    return (result && result.tools) || [];
  }

  // 拉取工具列表（含 initialize），写回 server.tools
  async function discoverTools(server) {
    await initialize(server);
    const tools = await listTools(server);
    updateServer(server.id, { tools, lastDiscoverAt: Date.now() });
    return tools;
  }

  // 调用单个工具
  // toolName 是 server 原生工具名（不带前缀）
  async function callTool(server, toolName, args) {
    const result = await _rpcCall(server, 'tools/call', {
      name: toolName,
      arguments: args || {}
    });
    // MCP spec: result.content 是 Array<{type:'text', text:'...'} | ...>
    if (result && Array.isArray(result.content)) {
      return result.content
        .map(c => c.type === 'text' ? c.text : JSON.stringify(c))
        .join('\n');
    }
    return JSON.stringify(result);
  }

  // === 集成到 chat tool_use 循环 ===

  // 工具名前缀：mcp_<server_short_id>_<tool_name>
  // server_short_id 取 id 前 6 位防止过长
  function _serverShort(serverId) {
    return (serverId || '').slice(0, 6);
  }

  function _wrapToolName(serverId, toolName) {
    return `mcp_${_serverShort(serverId)}_${toolName}`;
  }

  // 反解：从 mcp_xxxxxx_toolname 找回 server 和 toolName
  function _unwrapToolName(wrappedName) {
    const m = /^mcp_([0-9a-z]{1,6})_(.+)$/i.exec(wrappedName);
    if (!m) return null;
    const shortId = m[1];
    const toolName = m[2];
    const server = getServers().find(s => _serverShort(s.id) === shortId);
    if (!server) return null;
    return { server, toolName };
  }

  // 把 MCP server 的工具 schema 转成 OpenAI 兼容格式
  // 返回 [{type:'function', function:{name, description, parameters}}]
  function getEnabledToolDefs() {
    const out = [];
    for (const server of getServers()) {
      if (!server.enabled) continue;
      if (!Array.isArray(server.tools)) continue;
      for (const tool of server.tools) {
        if (server.disabledTools && server.disabledTools.includes(tool.name)) continue;
        out.push({
          type: 'function',
          function: {
            name: _wrapToolName(server.id, tool.name),
            description: `[${server.name || 'MCP'}] ${tool.description || tool.name}`,
            parameters: tool.inputSchema || { type: 'object', properties: {}, required: [] }
          }
        });
      }
    }
    return out;
  }

  function isMCPToolCall(toolName) {
    return /^mcp_[0-9a-z]{1,6}_/i.test(toolName || '');
  }

  // 执行一个 MCP 工具调用（被 Tools.execute 路由过来时使用）
  // toolCall: { id, function: { name, arguments } }
  // 返回字符串
  async function executeToolCall(toolCall) {
    try {
      const wrappedName = toolCall.function?.name;
      const unwrap = _unwrapToolName(wrappedName);
      if (!unwrap) return JSON.stringify({ error: 'MCP 工具未找到: ' + wrappedName });
      let args = toolCall.function?.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch(_) { args = {}; }
      }
      const result = await callTool(unwrap.server, unwrap.toolName, args || {});
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch(e) {
      return JSON.stringify({ error: 'MCP 调用失败: ' + (e?.message || e) });
    }
  }

  return {
    getServers, saveServers, addServer, removeServer, updateServer,
    discoverTools, callTool, initialize, listTools,
    getEnabledToolDefs, isMCPToolCall, executeToolCall
  };
})();
