// v687.14：现实环境感知工具
// 提供电量 / 天气获取（带缓存）+ 统一 env block 拼接
// 对外：EnvAwareness.getBatteryInfo() / getWeatherInfo() / buildEnvBlock({battery, weather})
window.EnvAwareness = (function() {
  'use strict';

  // === 电量（毫秒级，每次实时读） ===
  async function getBatteryInfo() {
    try {
      if (!navigator.getBattery) return null;
      const b = await navigator.getBattery();
      const pct = Math.round((b.level || 0) * 100);
      const charging = !!b.charging;
      return { pct, charging, text: `${pct}%${charging ? '（充电中）' : ''}` };
    } catch(e) {
      return null;
    }
  }

  // === 天气（30 分钟缓存，IP 定位无授权） ===
  let _weatherCache = null;
  let _weatherCacheTs = 0;
  let _weatherCacheCity = '';
  const WEATHER_TTL_MS = 30 * 60 * 1000;

  // 用户设的城市（localStorage），不设走 IP 定位（开梯子会拿到代理出口城市）
  function getCity() {
    try { return localStorage.getItem('env_weather_city') || ''; } catch(_) { return ''; }
  }
  function setCity(city) {
    try {
      localStorage.setItem('env_weather_city', (city || '').trim());
      // 清缓存让下次重新拉
      _weatherCache = null;
      _weatherCacheTs = 0;
      _weatherCacheCity = '';
    } catch(_) {}
  }

  async function getWeatherInfo() {
    const now = Date.now();
    const city = getCity();
    // 城市变了缓存失效
    if (_weatherCache && (now - _weatherCacheTs) < WEATHER_TTL_MS && city === _weatherCacheCity) {
      return _weatherCache;
    }
    try {
      // wttr.in 简洁格式：城市|温度|描述
      // %l=location %t=temp %C=condition %h=humidity
      // 城市为空走 IP 定位，否则按 city 查
      const cityPath = city ? '/' + encodeURIComponent(city) : '';
      const resp = await fetch(`https://wttr.in${cityPath}?format=%l|%t|%C|%h&lang=zh`);
      if (!resp.ok) throw new Error('wttr.in ' + resp.status);
      const raw = (await resp.text()).trim();
      const parts = raw.split('|').map(s => s.trim());
      if (parts.length < 3) throw new Error('wttr.in format unexpected: ' + raw);
      const [loc, temp, cond, hum] = parts;
      // v687.16：过滤 wttr.in 返回的"北纬 X 度，东经 Y 度"坐标格式，避免 AI 误以为是地名
      const isCoord = /度|°|纬|经|N\d|S\d|E\d|W\d/.test(loc);
      const cleanLoc = isCoord ? '' : loc;
      const info = {
        location: cleanLoc,
        temp: temp,
        condition: cond,
        humidity: hum || '',
        text: `${cleanLoc ? cleanLoc + ' · ' : ''}${temp} · ${cond}${hum ? ' · 湿度' + hum : ''}`
      };
      _weatherCache = info;
      _weatherCacheTs = now;
      _weatherCacheCity = city;
      return info;
    } catch(e) {
      console.warn('[EnvAwareness] 天气获取失败', e);
      return null;
    }
  }

  // === 拼接环境块（用于注入到 user message 末尾） ===
  // opts: { battery: bool, weather: bool }
  // 返回字符串或空串
  async function buildEnvBlock(opts) {
    const lines = [];
    const tasks = [];
    if (opts?.battery) tasks.push(getBatteryInfo().then(b => { if (b) lines.push('电量：' + b.text); }));
    if (opts?.weather) tasks.push(getWeatherInfo().then(w => { if (w) lines.push('天气：' + w.text); }));
    if (tasks.length === 0) return '';
    await Promise.all(tasks);
    if (lines.length === 0) return '';
    return '[当前环境]\n' + lines.join('\n');
  }

  // === 拍当前环境快照（用于存到 user message 上，下一轮回放） ===
  // opts: { battery: bool, weather: bool }
  async function captureSnapshot(opts) {
    const out = { ts: Date.now() };
    const tasks = [];
    if (opts?.battery) tasks.push(getBatteryInfo().then(b => { if (b) out.battery = { pct: b.pct, charging: b.charging }; }));
    if (opts?.weather) tasks.push(getWeatherInfo().then(w => { if (w) out.weather = { temp: w.temp, condition: w.condition, location: w.location }; }));
    if (tasks.length === 0) return null;
    await Promise.all(tasks);
    if (!out.battery && !out.weather) return null;
    return out;
  }

  // === 给最近 N 条带 envSnapshot 的 user 消息拼前缀（仿 TimeAwareness.stampUserMessages） ===
  // 返回新数组，不修改原数据
  function stampUserMessages(historyForAPI, messages, opts) {
    const want = (opts?.battery || opts?.weather);
    if (!want) return historyForAPI;
    const maxStamps = opts?.maxStamps ?? 2;
    const withTs = messages.filter(m => !m.hidden);
    if (withTs.length !== historyForAPI.length) return historyForAPI;
    // 倒序找最近 N 条带 envSnapshot 的 user 索引
    const targetIndices = new Set();
    let collected = 0;
    for (let i = withTs.length - 1; i >= 0 && collected < maxStamps; i--) {
      const m = withTs[i];
      if (m.role !== 'user' || !m.envSnapshot) continue;
      targetIndices.add(i);
      collected++;
    }
    if (targetIndices.size === 0) return historyForAPI;
    return historyForAPI.map((m, i) => {
      if (!targetIndices.has(i)) return m;
      const snap = withTs[i].envSnapshot;
      const tagParts = [];
      if (opts.battery && snap.battery) {
        tagParts.push(`电量${snap.battery.pct}%${snap.battery.charging ? '充' : ''}`);
      }
      if (opts.weather && snap.weather) {
        const w = snap.weather;
        const locPart = (w.location && !/度|°|纬|经/.test(w.location)) ? w.location : '';
        const wxText = `${locPart}${locPart ? ' ' : ''}${w.temp || ''} ${w.condition || ''}`.trim();
        if (wxText) tagParts.push(wxText);
      }
      if (tagParts.length === 0) return m;
      const tag = `[${tagParts.join(' · ')}] `;
      if (Array.isArray(m.content)) {
        const stamped = m.content.map((part, pi) => {
          if (pi === 0 && part.type === 'text') return { ...part, text: tag + (part.text || '') };
          return part;
        });
        return { ...m, content: stamped };
      }
      return { ...m, content: tag + (m.content || '') };
    });
  }

  return { getBatteryInfo, getWeatherInfo, buildEnvBlock, captureSnapshot, stampUserMessages, getCity, setCity };
})();
