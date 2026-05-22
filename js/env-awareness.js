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
  const WEATHER_TTL_MS = 30 * 60 * 1000;

  async function getWeatherInfo() {
    const now = Date.now();
    if (_weatherCache && (now - _weatherCacheTs) < WEATHER_TTL_MS) {
      return _weatherCache;
    }
    try {
      // wttr.in 简洁格式：城市|温度|描述
      // %l=location %t=temp %C=condition %h=humidity
      const resp = await fetch('https://wttr.in/?format=%l|%t|%C|%h&lang=zh');
      if (!resp.ok) throw new Error('wttr.in ' + resp.status);
      const raw = (await resp.text()).trim();
      const parts = raw.split('|').map(s => s.trim());
      if (parts.length < 3) throw new Error('wttr.in format unexpected: ' + raw);
      const [loc, temp, cond, hum] = parts;
      const info = {
        location: loc,
        temp: temp,
        condition: cond,
        humidity: hum || '',
        text: `${loc} · ${temp} · ${cond}${hum ? ' · 湿度' + hum : ''}`
      };
      _weatherCache = info;
      _weatherCacheTs = now;
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

  return { getBatteryInfo, getWeatherInfo, buildEnvBlock };
})();
