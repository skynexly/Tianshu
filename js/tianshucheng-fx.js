// 天枢城专属特效：开场打字 + 入城黑屏解码动画
// 仅在 body[data-worldview="天枢城"] 时由 chat.js 主动调用
window.TianshuFX = (function() {
  'use strict';

  const WV_NAME = '天枢城';
  const WV_ID   = 'wv_tianshucheng';

  // ===== 工具：判定是否天枢城世界观 =====
  function isTianshuWorldview(wv) {
    if (!wv) return false;
    return wv.id === WV_ID || wv.name === WV_NAME;
  }

  // ===== body 标签管理（loadConversation 调用） =====
  function setBodyTag(wvName) {
    // 通用：所有世界观都设置 data-worldview，方便手机等模块检测
    if (wvName) {
      document.body.setAttribute('data-worldview', wvName);
    } else {
      document.body.removeAttribute('data-worldview');
    }
    // 手机浮动按钮跟随（不主动显示，只在非聊天面板时隐藏）
    const phoneFab = document.getElementById('phone-fab');
    if (phoneFab) {
      const chatActive = document.querySelector('#panel-chat.active');
      if (!wvName || !chatActive) phoneFab.classList.add('hidden');
      // 注意：不在这里 remove hidden，fab 只在 Phone.close() 时显示
    }
  }

  // ===== 1. 开场打字效果 =====
  // 节奏配置
  const PACE = {
    base: 32,            // 普通字符
    comma: 150,          // ， ； ：
    period: 400,         // 。 ？ ！
    ellipsis: 800,       // …… ...
    paragraph: 600,      // 双换行
  };
  const MAX_TYPING_LEN = 800;  // 超过这个长度直接秒显（防御玩家把 startMessage 改成万字）

  // 当前打字会话状态
  let _typingSession = null;

  /**
   * 把一段文本以打字机方式注入到指定的 .msg-body 元素里
   * @param {HTMLElement} bodyEl  消息气泡的 .msg-body 容器
   * @param {string} content      要吐的完整文本（markdown 格式，最终会用 Markdown.render）
   * @returns {Promise<void>}     完成或被跳过时 resolve
   */
  function typeMessage(bodyEl, content) {
    return new Promise((resolve) => {
      if (!bodyEl || !content) { resolve(); return; }

      // 剥掉 HTML 注释（玩家给 AI 看的暗号不应该被打字出来）
      const visibleContent = content.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (!visibleContent) {
        bodyEl.innerHTML = Markdown ? Markdown.render(content) : content;
        resolve();
        return;
      }

      // 文本超长直接跳过打字效果
      if (visibleContent.length > MAX_TYPING_LEN) {
        bodyEl.innerHTML = Markdown ? Markdown.render(content) : content;
        resolve();
        return;
      }

      const session = { skipped: false, finished: false };
      _typingSession = session;

      // 准备临时容器（纯文本流式追加，最终替换为 markdown 渲染结果）
      bodyEl.classList.add('skynex-typing');
      bodyEl.innerHTML = '<span class="skynex-type-cursor"></span>';
      const cursor = bodyEl.querySelector('.skynex-type-cursor');

      // 显示跳过按钮（首次点击 → 出现按钮，再次点击/点按钮 → 跳过）
      const skipBtn = _attachSkipButton(() => {
        session.skipped = true;
      });

      let i = 0;
      const finish = () => {
        if (session.finished) return;
        session.finished = true;
        bodyEl.classList.remove('skynex-typing');
        bodyEl.innerHTML = Markdown ? Markdown.render(content) : content;
        if (skipBtn) skipBtn.remove();
        // 滚到底
        const cm = document.getElementById('chat-messages');
        if (cm) cm.scrollTop = cm.scrollHeight;
        resolve();
      };

      const step = () => {
        if (session.skipped || i >= visibleContent.length) { finish(); return; }

        const ch = visibleContent[i];
        const next2 = visibleContent.substr(i, 2);
        const next3 = visibleContent.substr(i, 3);

        // 注入字符（在 cursor 前）
        let chunk = ch;
        let delay = PACE.base;

        if (next3 === '...' || next2 === '……') {
          chunk = (next3 === '...') ? '...' : '……';
          delay = PACE.ellipsis;
          i += chunk.length;
        } else if (ch === '\n' && visibleContent[i+1] === '\n') {
          chunk = '\n\n';
          delay = PACE.paragraph;
          i += 2;
        } else if ('。？！.?!'.includes(ch)) {
          delay = PACE.period;
          i++;
        } else if ('，；：、,;:'.includes(ch)) {
          delay = PACE.comma;
          i++;
        } else {
          i++;
        }

        // 文本节点插入（保留换行）
        const textNode = document.createTextNode(chunk);
        bodyEl.insertBefore(textNode, cursor);

        // 滚到底（节流：每 200ms 滚一次）
        if (!step._lastScroll || Date.now() - step._lastScroll > 200) {
          const cm = document.getElementById('chat-messages');
          if (cm) cm.scrollTop = cm.scrollHeight;
          step._lastScroll = Date.now();
        }

        setTimeout(step, delay);
      };
      step();
    });
  }

  function _attachSkipButton(onSkip) {
    let btn = null;
    let armed = false;

    const onTap = (e) => {
      if (!armed) {
        // 第一次点：出现按钮
        armed = true;
        btn = document.createElement('button');
        btn.className = 'skynex-skip-btn';
        btn.textContent = '跳过 →';
        btn.onclick = (ev) => {
          ev.stopPropagation();
          cleanup();
          onSkip();
        };
        document.body.appendChild(btn);
        // 8 秒内没再点按钮就自动消失
        setTimeout(() => {
          if (btn && document.body.contains(btn)) {
            btn.classList.add('fading');
            setTimeout(() => btn && btn.remove(), 300);
          }
        }, 8000);
      }
    };

    const cleanup = () => {
      document.removeEventListener('click', onTap, true);
      if (btn && btn.parentNode) btn.remove();
    };

    document.addEventListener('click', onTap, true);

    // 返回的对象用于 finish 时清理（伪装成 element）
    return { remove: cleanup };
  }

  // ===== 2. 入城关键词检测 =====
  const ENTRY_KEYWORDS = [
    '入城', '进城', '开门', 'enter',
    '开始', '准备好', '准备', 'ready', 'go', 'start', 'begin',
    '出发', '我来了', '走吧',
  ];

  function isEntryTrigger(text) {
    if (!text) return false;
    const t = text.toLowerCase().trim();
    if (!t) return false;
    return ENTRY_KEYWORDS.some(k => t.includes(k.toLowerCase()));
  }

  // ===== 3. 倒计时计算 =====
  // 把 "2065年3月27日 星期五" 解析成 {y,m,d}
  function _parseStartTime(startTime) {
    if (!startTime) return null;
    const m = startTime.match(/(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
    if (!m) return null;
    return { y: +m[1], m: +m[2], d: +m[3] };
  }

  // 把 "3月29日" 解析成 {m,d}
  function _parseFestDate(date) {
    if (!date) return null;
    const m = date.match(/(\d+)\s*月\s*(\d+)\s*日/);
    if (!m) return null;
    return { m: +m[1], d: +m[2] };
  }

  function _daysBetween(a, b) {
    // a, b 是 {y,m,d}
    const da = new Date(a.y, a.m - 1, a.d);
    const db = new Date(b.y, b.m - 1, b.d);
    return Math.round((db - da) / 86400000);
  }

  /**
   * 找出从 startTime 算起最近的下一个节日
   * @returns {{name: string, days: number} | null}
   */
  function _findNextFestival(wv) {
    const start = _parseStartTime(wv && wv.startTime);
    const fests = (wv && wv.festivals) || [];
    if (!start || fests.length === 0) return null;

    let best = null;
    for (const f of fests) {
      const fd = _parseFestDate(f.date);
      if (!fd) continue;
      // 今年的这个节日
      let cand = { y: start.y, m: fd.m, d: fd.d };
      let diff = _daysBetween(start, cand);
      if (diff < 0 && f.yearly) {
        // 已过 → 排到明年
        cand = { y: start.y + 1, m: fd.m, d: fd.d };
        diff = _daysBetween(start, cand);
      }
      if (diff < 0) continue;
      if (best === null || diff < best.days) {
        best = { name: f.name, days: diff };
      }
    }
    return best;
  }

  // ===== 4. 入城黑屏解码动画 =====
  // 噪点字符池（katakana + 拉丁 + 符号）
  const NOISE_POOL = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン#@$%&*+=<>?!ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const TITLE = 'THE SKYNEX';

  function _randNoise(len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      s += NOISE_POOL[Math.floor(Math.random() * NOISE_POOL.length)];
    }
    return s;
  }

  /**
   * 播放入城动画
   * @param {object} wv  当前世界观对象（用来取 startTime/festivals）
   * @returns {Promise<void>}
   */
  function playEntryAnimation(wv) {
    return new Promise((resolve) => {
      // 构建副标题
      const start = _parseStartTime(wv && wv.startTime);
      const next = _findNextFestival(wv);
      let dateLine = wv && wv.startTime ? wv.startTime.replace(/\s*星期./, '') : '';
      let festLine = '';
      if (next) {
        if (next.days === 0) festLine = `今天是${next.name}`;
        else festLine = `距离${next.name}还有 ${next.days} 天`;
      }

      // 注入遮罩 DOM
      const overlay = document.createElement('div');
      overlay.className = 'skynex-entry-overlay';
      overlay.innerHTML = `
        <div class="skynex-entry-inner">
          <div class="skynex-entry-title">
            <span class="skynex-noise" data-target="${TITLE}"></span>
          </div>
          <div class="skynex-entry-divider"></div>
          <div class="skynex-entry-sub">
            <div class="skynex-entry-date" style="opacity:0">${dateLine}</div>
            ${festLine ? `<div class="skynex-entry-fest" style="opacity:0">${festLine}</div>` : ''}
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const noiseEl = overlay.querySelector('.skynex-noise');
      const dateEl = overlay.querySelector('.skynex-entry-date');
      const festEl = overlay.querySelector('.skynex-entry-fest');
      const divider = overlay.querySelector('.skynex-entry-divider');

      // 阶段 1：黑幕淡入（CSS animation 自动跑 300ms）
      // 阶段 2：标题处于纯噪点状态，每 50ms 刷新（持续 700ms）
      let elapsed = 0;
      const noiseTimer = setInterval(() => {
        noiseEl.textContent = _randNoise(TITLE.length);
        elapsed += 50;
      }, 50);

      // 阶段 3：700ms 后开始解码（从左到右逐字落定，每字 70ms）
      setTimeout(() => {
        clearInterval(noiseTimer);
        let locked = 0;
        const lockTimer = setInterval(() => {
          locked++;
          if (locked > TITLE.length) {
            clearInterval(lockTimer);
            // 解码完成 → 红→青过渡
            noiseEl.classList.add('decoded');
            // 阶段 4：标题落定后，分隔线展开 + 副标题淡入
            divider.classList.add('expanded');
            setTimeout(() => {
              if (dateEl) dateEl.style.opacity = '1';
            }, 200);
            setTimeout(() => {
              if (festEl) festEl.style.opacity = '1';
            }, 500);
            // 阶段 5：静止 1.4s 后整体淡出
            setTimeout(() => {
              overlay.classList.add('fading-out');
              setTimeout(() => {
                overlay.remove();
                resolve();
              }, 600);
            }, 1800);
            return;
          }
          // 部分锁定：前 locked 个真字符，后面继续刷噪点
          const fixed = TITLE.substring(0, locked);
          const noise = _randNoise(TITLE.length - locked);
          noiseEl.textContent = fixed + noise;
        }, 70);
        // 在 lockTimer 期间噪点也要继续闪
        const fillTimer = setInterval(() => {
          if (locked > TITLE.length) { clearInterval(fillTimer); return; }
          const fixed = TITLE.substring(0, locked);
          const noise = _randNoise(TITLE.length - locked);
          noiseEl.textContent = fixed + noise;
        }, 35);
      }, 700);
    });
  }

  return {
    isTianshuWorldview,
    setBodyTag,
    typeMessage,
    isEntryTrigger,
    playEntryAnimation,
  };
})();
