// ==========================================================
//  心动模拟·世界崩坏演出
//  触发：前端检测所有心动目标 dark ≥ 100
//  视觉：裂纹扩散 + 暗红光 + 抖动 + 熔岩滴落
//  规则：
//   - 不阻断交互（pointer-events: none）
//   - 同一对话只播一次（conv.hsCollapseShown）
//   - 纯演出，播完自动消失
//   - 约 5s
// ==========================================================
(function () {
  let _playing = false;

  function play() {
    if (_playing) return;
    _playing = true;

    const overlay = document.createElement('div');
    overlay.className = 'hsc-collapse-overlay';
    overlay.innerHTML = `
      <div class="hsc-collapse-cracks">
        ${_generateCracks(8)}
      </div>
      <div class="hsc-collapse-glow"></div>
      <div class="hsc-collapse-drip"></div>
    `;
    document.body.appendChild(overlay);

    // 给 body 加抖动
    document.body.classList.add('hsc-collapse-shake');

    // 5s 后淡出
    setTimeout(() => {
      overlay.classList.add('hsc-collapse-fade');
      document.body.classList.remove('hsc-collapse-shake');
      setTimeout(() => {
        overlay.remove();
        _playing = false;
      }, 1000);
    }, 5000);
  }

  function _generateCracks(count) {
    let html = '';
    for (let i = 0; i < count; i++) {
      const left = 10 + Math.random() * 80;
      const delay = Math.random() * 1.5;
      const height = 40 + Math.random() * 60;
      const skew = -15 + Math.random() * 30;
      html += `<div class="hsc-collapse-crack" style="left:${left}%;animation-delay:${delay}s;height:${height}%;transform:skewX(${skew}deg)"></div>`;
    }
    return html;
  }

  // 检测是否该触发——供 chat.js onDone 后调用
  async function checkAndPlay() {
    try {
      if (_playing) return;
      if (typeof Conversations === 'undefined') return;
      const sb = Conversations.getStatusBar();
      const hs = sb?.heartSim;
      if (!hs || !hs.targets || hs.targets.length < 2) return;

      // 检测所有 target dark ≥ 100
      const allMaxed = hs.targets.every(t => t.dark >= 100);
      if (!allMaxed) return;

      // 同一对话只播一次
      const conv = (typeof Conversations !== 'undefined')
        ? Conversations.getList().find(c => c.id === Conversations.getCurrent())
        : null;
      if (!conv) return;
      if (conv.hsCollapseShown) return;

      // 标记并播放
      conv.hsCollapseShown = true;
      try { await Conversations.saveList(); } catch (_) {}

      // 延迟 1s 让用户先看到 AI 回复
      setTimeout(() => play(), 1000);
    } catch (e) {
      console.warn('[HSCollapse] check failed', e);
    }
  }

  function isPlaying() { return _playing; }

  window.HeartSimCollapse = { play, checkAndPlay, isPlaying };
})();