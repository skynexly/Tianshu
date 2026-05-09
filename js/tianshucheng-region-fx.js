// 天枢城·大区过场动画
// 对外：TianshuRegion.playTransition(toRegion)  返回 Promise
window.TianshuRegion = (function() {
  'use strict';

  // 四大区的视觉配置（仅限天枢城·东/南/西/北 前缀匹配）
  const DISTRICTS = {
    east:  { cn: '东区', formal: '衡庭', en: 'DISTRICT.E', style: 'east',  duration: 1200 },
    south: { cn: '南区', formal: '熔川', en: 'DISTRICT.S', style: 'south', duration: 900  },
    west:  { cn: '西区', formal: '暮渡', en: 'DISTRICT.W', style: 'west',  duration: 1200 },
    north: { cn: '北区', formal: '钟灵', en: 'DISTRICT.N', style: 'north', duration: 1500 },
  };

  // 从 region 文本识别大区（"天枢城·西区" / "西区" 都识别）
  function _parseDistrict(region) {
    if (!region) return null;
    if (/东区|衡庭/.test(region)) return 'east';
    if (/南区|熔川/.test(region)) return 'south';
    if (/西区|暮渡/.test(region)) return 'west';
    if (/北区|钟灵/.test(region)) return 'north';
    return null;
  }

  // 只对天枢城世界观生效
  function _isTianshu() {
    return document.body.getAttribute('data-worldview') === '天枢城';
  }

  let _lastDistrict = null;  // 上次进入的大区（跨大区检测）
  let _playing = false;

  /**
   * 外部调用：检查并可能触发过场
   * @param {string} region  当前大区文本
   */
  function check(region) {
    if (!_isTianshu()) return;
    const d = _parseDistrict(region);
    if (!d) { _lastDistrict = null; return; }
    if (d === _lastDistrict) return;  // 没跨大区
    const prev = _lastDistrict;
    _lastDistrict = d;
    if (_playing) return;  // 正在播不叠加
    play(d, prev).catch(() => {});
  }

  // 重置（切换对话时调）
  function reset() {
    _lastDistrict = null;
  }

  // 静默初始化：用当前 region 设置 _lastDistrict，但不播动画
  // 切对话/刷新页面时调，避免把已有的 region 当作"新进入"
  function silentInit(region) {
    const d = _parseDistrict(region);
    _lastDistrict = d;
  }

  /**
   * 播放某区过场动画
   */
  function play(districtKey, fromKey) {
    const cfg = DISTRICTS[districtKey];
    if (!cfg) return Promise.resolve();
    _playing = true;

    return new Promise((resolve) => {
      const band = document.createElement('div');
      band.className = `skynex-region-band skynex-region-${cfg.style}`;
      band.innerHTML = `
        <div class="skynex-region-line skynex-region-line-top"></div>
        <div class="skynex-region-content">
          <span class="skynex-region-en">◢ ${cfg.en} ◣</span>
          <span class="skynex-region-cn">${cfg.cn} · ${cfg.formal}</span>
        </div>
        <div class="skynex-region-line skynex-region-line-bot"></div>
      `;
      document.body.appendChild(band);

      // 触发入场动画
      requestAnimationFrame(() => band.classList.add('entering'));

      // 达峰停留，然后出场
      const hold = Math.max(300, cfg.duration - 700);
      setTimeout(() => {
        band.classList.add('leaving');
        setTimeout(() => {
          band.remove();
          _playing = false;
          resolve();
        }, 400);
      }, hold + 300);
    });
  }

  return { check, reset, silentInit, play };
})();