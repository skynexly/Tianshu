/**
 * StatusBar 模块 — 顶部可折叠状态条
 * 数据源：Conversations.getStatusBar()
 * 由 chat.js 在收到 AI 回复后调用 render(status) 刷新
 */
const StatusBar = (() => {
  let _expanded = false;
  let _currentStatus = null;
let _editBuf = null; // 编辑缓冲 { mode: 'field'|'npc'|'all', ... }
 let _hsSkipSelectedIdx = null;
let _customAttrDefs = [];
let _characterAttrCards = [];

function _el(id) { return document.getElementById(id); }
function _attrTargetKey(t) { return [t?.targetType || '', t?.targetId || '', t?.sourceWorldviewId || ''].join(':'); }
  function _esc(s) { return Utils && Utils.escapeHtml ? Utils.escapeHtml(s) : (s || ''); }

  // 从 time 字段里拆出"时:分"和"年月日星期"
 function _splitTime(timeStr) {
 if (!timeStr) return { clock: '—', rest: '—' };
 // 匹配常见格式：2065年3月27日 星期五15:02 /2065/3/2715:02 /15:02
 const clockM = timeStr.match(/(\d{1,2}:\d{2})/);
 const clock = clockM ? clockM[1] : '';
 let rest = timeStr.replace(/\s*\d{1,2}:\d{2}\s*/, ' ').trim();
 return { clock: clock || '—', rest: rest || '—' };
 }
function _useNpcCarousel() {
  return _isHeartSim() || _resolveSkin() === 'neumorph';
}

// 把自定义主题（sb_xxx）解析成它的 baseTemplate；其余原样返回
function _resolveSkin(rawSkin) {
  let skin = rawSkin;
  if (skin === undefined || skin === null) {
    // 不传参时，从当前世界观/body 推断
    skin = document.body?.getAttribute('data-sb-skin') || '';
  }
  if (typeof skin === 'string' && skin.startsWith('sb_') && window.StatusBarTheme) {
    try {
      const t = StatusBarTheme.get(skin);
      if (t && t.baseTemplate) return t.baseTemplate;
    } catch(_) {}
    return 'terminal';
  }
  return skin || '';
}

function _refreshNpcDots(count) {
  const dotsEl = _el('sb-npc-dots');
  const listEl = _el('sb-npcs-list');
  if (!dotsEl || !listEl) return;
  if (!_useNpcCarousel() || count <=0) {
    dotsEl.innerHTML = '';
    dotsEl.classList.add('hidden');
    listEl.onscroll = null;
    return;
  }
 dotsEl.classList.remove('hidden');
 dotsEl.innerHTML = Array.from({ length: count }, (_, i) => `<span class="sb-npc-dot${i ===0 ? ' active' : ''}"></span>`).join('');
 const update = () => {
 const cards = listEl.querySelectorAll('.sb-npc-card');
 if (!cards.length) return;
 const first = cards[0];
 const gap = parseFloat(getComputedStyle(listEl).gap || '0') ||0;
 const step = first.getBoundingClientRect().width + gap;
 const idx = step ? Math.max(0, Math.min(count -1, Math.round(listEl.scrollLeft / step))) :0;
 dotsEl.querySelectorAll('.sb-npc-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
 };
 listEl.onscroll = update;
 requestAnimationFrame(update);
 }

  function _refreshTargetDots(count) {
 const dotsEl = _el('hs-target-dots');
 const listEl = _el('hs-targets');
 if (!dotsEl || !listEl) return;
 if (!_isHeartSim() || count <=0) {
 dotsEl.innerHTML = '';
 dotsEl.classList.add('hidden');
 return;
 }
 dotsEl.classList.remove('hidden');
 dotsEl.innerHTML = Array.from({ length: count }, (_, i) => `<span class="hs-target-dot${i ===0 ? ' active' : ''}"></span>`).join('');
 const update = () => {
 const cards = listEl.querySelectorAll('.hs-target-card');
 if (!cards.length) return;
 const first = cards[0];
 const gap = parseFloat(getComputedStyle(listEl).gap || '0') ||0;
 const step = first.getBoundingClientRect().width + gap;
 const idx = step ? Math.max(0, Math.min(count -1, Math.round(listEl.scrollLeft / step))) :0;
 dotsEl.querySelectorAll('.hs-target-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
 };
 listEl.onscroll = update;
 requestAnimationFrame(update);
 }

  // 头像匹配缓存：{ nameLower: url }
  const _npcAvatarCache = new Map();

  async function _resolveNpcAvatar(name) {
    if (!name) return '';
    const key = String(name).trim().toLowerCase();
    if (!key) return '';
    if (_npcAvatarCache.has(key)) return _npcAvatarCache.get(key);

    let url = '';
    try {
      // 1. 当前对话的单人卡 char
      const curId = (typeof Conversations !== 'undefined') ? Conversations.getCurrent() : null;
      const conv = curId ? (Conversations.getList().find(c => c.id === curId) || null) : null;
      if (conv && conv.isSingle && conv.singleCharId) {
        if (conv.singleCharType === 'card') {
          const card = await SingleCard.get(conv.singleCharId);
          if (card && card.name && card.name.trim().toLowerCase() === key && card.avatar) {
            url = card.avatar;
          }
        } else if (conv.singleCharType === 'npc') {
          // npc 类型在头像缓存里
          url = await SingleCard.getNpcAvatar(conv.singleCharId).catch(()=>'');
        }
      }
      // 2. 挂载角色
      if (!url) {
        const attached = (typeof AttachedChars !== 'undefined') ? AttachedChars.get() : [];
        for (const a of attached) {
          if (a.type === 'card') {
            const card = await SingleCard.get(a.id);
            if (card && card.name && card.name.trim().toLowerCase() === key && card.avatar) {
              url = card.avatar; break;
            }
          } else if (a.type === 'npc') {
            // 通过 npcAvatars 直接查；name 匹配需要先拿到 npc 名，这里跳过简化处理
            const avatar = await SingleCard.getNpcAvatar(a.id).catch(()=>'');
            if (avatar) {
              // 名字匹配——查世界观 NPC
              try {
                const wv = await DB.get('worldviews', a.sourceWvId);
                if (wv && Array.isArray(wv.regions)) {
                  outer: for (const r of wv.regions) {
                    for (const f of (r.factions || [])) {
                      for (const n of (f.npcs || [])) {
                        if (n.id === a.id && n.name && n.name.trim().toLowerCase() === key) {
                          url = avatar; break outer;
                        }
                      }
                    }
                  }
                }
              } catch(_) {}
              if (url) break;
            }
          }
        }
      }
    } catch(_) {}

    _npcAvatarCache.set(key, url || '');
    return url || '';
  }

  function _clearNpcAvatarCache() {
    _npcAvatarCache.clear();
  }

  async function _hydrateNpcAvatars(rootEl) {
    if (!rootEl) return;
    const nodes = rootEl.querySelectorAll('.sb-npc-avatar[data-npc-name]');
    for (const node of nodes) {
      const name = node.getAttribute('data-npc-name') || '';
      try {
        const url = await _resolveNpcAvatar(name);
        if (url) {
          node.innerHTML = `<img src="${_esc(url)}" alt="" style="width:100%;height:100%;object-fit:cover">`;
          node.classList.add('has-img');
        }
      } catch(_) {}
    }
  }

  // 占位卡：从当前对话的单人卡读 name + avatar 填充
async function _getCurrentWorldview() {
  try {
    const conv = (typeof Conversations !== 'undefined') ? Conversations.getList().find(c => c.id === Conversations.getCurrent()) : null;
    const wvId = conv?.singleWorldviewId || conv?.worldviewId || '';
    if (!wvId || wvId === '__default_wv__') return null;
    return await DB.get('worldviews', wvId);
  } catch(_) { return null; }
}

// 获取当前对话的 gameplay 配置（优先对话级副本，fallback 到世界观）
async function _getConvGameplay() {
  try {
    const conv = (typeof Conversations !== 'undefined') ? Conversations.getList().find(c => c.id === Conversations.getCurrent()) : null;
    if (conv?.convGameplay) return conv.convGameplay;
    const wv = await _getCurrentWorldview();
    return wv?.gameplay || null;
  } catch(_) { return null; }
}

async function _renderCustomAttrs(status) {
  const wrap = _el('sb-custom-attrs');
  if (!wrap) return;
  const wv = await _getCurrentWorldview();
  const gp = await _getConvGameplay();
  const skin = _resolveSkin(wv?.statusBarSkin || document.body?.getAttribute('data-sb-skin') || '');
  const canShowCustomAttrs = skin === 'neumorph' || skin === 'terminal' || document.body?.getAttribute('data-skin') === 'single-default';
  if (!canShowCustomAttrs || !status) {
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    _customAttrDefs = [];
    return;
  }
  const attrs = (gp?.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim());
  _customAttrDefs = attrs;
  if (!attrs.length) {
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }
  status.customAttrs = status.customAttrs || {};
  status.customAttrs.global = status.customAttrs.global || {};
  let changed = false;
  attrs.forEach(a => {
    if (status.customAttrs.global[a.id] === undefined || status.customAttrs.global[a.id] === null || status.customAttrs.global[a.id] === '') {
      status.customAttrs.global[a.id] = (a.initial === '' || a.initial === undefined || a.initial === null) ? 0 : Number(a.initial);
      changed = true;
    }
  });
  if (changed) {
    try { await Conversations.setStatusBar(status); } catch(_) {}
  }
  wrap.classList.remove('hidden');
  wrap.innerHTML = `
    <div class="sb-custom-attrs-title">Custom Attributes</div>
    <div class="sb-custom-attrs-grid">
      ${attrs.map(a => {
        const val = status.customAttrs.global[a.id] ?? a.initial ?? 0;
        return `<div class="sb-custom-attr-card" onclick="event.stopPropagation();StatusBar.editCustomAttr('${_esc(a.id)}')">
          <div class="sb-custom-attr-name">${_esc(a.name || '未命名属性')}</div>
          <div class="sb-custom-attr-val">${_esc(String(val ?? 0))}</div>
        </div>`;
      }).join('')}
    </div>`;
}

async function editCustomAttr(attrId) {
  const def = _customAttrDefs.find(a => a.id === attrId);
  if (!def) return;
  if (!_currentStatus) _currentStatus = { region:'',location:'',time:'',weather:'',scene:'',playerOutfit:'',playerPosture:'',npcs:[] };
  _currentStatus.customAttrs = _currentStatus.customAttrs || {};
  _currentStatus.customAttrs.global = _currentStatus.customAttrs.global || {};
  const oldVal = _currentStatus.customAttrs.global[attrId] ?? def.initial ?? 0;
  const input = await UI.showSimpleInput(`修改「${def.name || '属性'}」`, String(oldVal), { placeholder: '当前值' });
  if (input === null || input === undefined) return;
  const txt = String(input).trim();
  if (txt === '') return;
  const num = Number(txt);
  if (!Number.isFinite(num)) { UI.showToast('请输入数字', 1800); return; }
  _currentStatus.customAttrs.global[attrId] = num;
  try { await Conversations.setStatusBar(_currentStatus); } catch(e) {}
  render(_currentStatus);
}

async function _renderCharacterAttrs(status) {
const wrap = _el('sb-character-attrs');
if (!wrap) return;
const wv = await _getCurrentWorldview();
const gp = await _getConvGameplay();
const skin = _resolveSkin(wv?.statusBarSkin || document.body?.getAttribute('data-sb-skin') || '');
  const isNeumorph = skin === 'neumorph';
  const isTerminal = skin === 'terminal';
// v632.2：单人卡无世界观时走 single-default 皮肤
const isSingleDefault = document.body?.getAttribute('data-skin') === 'single-default';
const cards = (gp?.characterAttrs || []).filter(c => c && Array.isArray(c.attrs) && c.attrs.some(a => a && a.id && (a.name || '').trim()));
_characterAttrCards = cards;
if ((!isNeumorph && !isTerminal && !isSingleDefault) || !status || !cards.length) {
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }
  status.customAttrs = status.customAttrs || {};
  status.customAttrs.characters = status.customAttrs.characters || {};
  let changed = false;
  cards.forEach(c => {
    const key = _attrTargetKey(c);
    status.customAttrs.characters[key] = status.customAttrs.characters[key] || {};
    (c.attrs || []).forEach(a => {
      if (!a || !a.id || !(a.name || '').trim()) return;
      if (status.customAttrs.characters[key][a.id] === undefined || status.customAttrs.characters[key][a.id] === null || status.customAttrs.characters[key][a.id] === '') {
        status.customAttrs.characters[key][a.id] = (a.initial === '' || a.initial === undefined || a.initial === null) ? 0 : Number(a.initial);
        changed = true;
      }
    });
  });
  if (changed) { try { await Conversations.setStatusBar(status); } catch(_) {} }
  wrap.classList.remove('hidden');
  wrap.innerHTML = `
    <div class="sb-character-attrs-title">Character Attributes</div>
    <div class="sb-character-attrs-list">
      ${cards.map((c, ci) => {
        const key = _attrTargetKey(c);
        const attrs = (c.attrs || []).filter(a => a && a.id && (a.name || '').trim());
        return `<div class="sb-character-attr-card">
          <div class="sb-character-attr-name">${_esc(c.targetName || '未命名角色')}</div>
          <div class="sb-character-attr-lines">
            ${attrs.map((a, ai) => {
              const val = status.customAttrs.characters[key]?.[a.id] ?? a.initial ?? 0;
              const hasMax = !(a.max === '' || a.max === null || a.max === undefined);
              const max = Number(a.max);
              const pct = hasMax && max > 0 ? Math.max(0, Math.min(100, Number(val) / max * 100)) : 0;
              const displayVal = hasMax && Number.isFinite(max) ? `${val ?? 0} / ${max}` : String(val ?? 0);
              return `<div class="sb-character-attr-line" onclick="event.stopPropagation();StatusBar.editCharacterAttr(${ci}, ${ai})">
                <div class="sb-character-attr-row"><span>${_esc(a.name || '未命名属性')}</span><b>${_esc(displayVal)}</b></div>
                ${hasMax ? `<div class="sb-character-attr-bar"><i style="width:${pct}%"></i></div>` : ''}
              </div>`;
            }).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>`;
}
async function _getCustomAttrPromptData() {
  const wv = await _getCurrentWorldview();
  // v632.2：心动模拟有内置机制不支持自定义属性；其余情况（含单人卡无世界观）放行
  if (wv && wv.id === 'wv_heartsim') return null;
  const gp = await _getConvGameplay();
  const globalAttrs = (gp?.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim());
  const charCards = (gp?.characterAttrs || []).filter(c => c && Array.isArray(c.attrs) && c.attrs.some(a => a && a.id && (a.name || '').trim()));
  if (!globalAttrs.length && !charCards.length) return null;
  return { wv, globalAttrs, charCards };
}

async function formatCustomAttrsFormatPrompt() {
  try {
    const data = await _getCustomAttrPromptData();
    if (!data) return '';
    const lines = [];
    lines.push('【可选追加：自定义属性变化】');
    lines.push('当前世界观配置了自定义属性。若本轮剧情明确造成属性变化，请在 `status` 代码块之后追加 `custom-attrs` 代码块；若没有属性变化，完全不要输出该代码块。');
    lines.push('');
    lines.push('规则：');
    lines.push('- `custom-attrs` 中的数字表示本轮增量/减量，不是最终值。');
    lines.push('- 没有变化的属性不要输出。');
    lines.push('- 不要新增未列出的属性；属性名和角色名必须与后续【自定义属性当前状态】一致。');
    lines.push('- 有最大值的属性由系统自动限制在 0 到最大值之间；无最大值的属性最低为 0。');
    lines.push('');
    lines.push('回复格式示例：');
    lines.push('```custom-attrs');
    lines.push('{');
    lines.push('  "global": {');
    lines.push('    "体力": -10');
    lines.push('  },');
    lines.push('  "characters": {');
    lines.push('    "角色名": {');
    lines.push('      "好感度": 3');
    lines.push('    }');
    lines.push('  }');
    lines.push('}');
    lines.push('```');
    return lines.join('\n');
  } catch(e) { return ''; }
}

async function formatCustomAttrsStatePrompt() {
  try {
    const data = await _getCustomAttrPromptData();
    if (!data) return '';
    const { globalAttrs, charCards } = data;
    const status = Conversations.getStatusBar() || {};
    status.customAttrs = status.customAttrs || {};
    status.customAttrs.global = status.customAttrs.global || {};
    status.customAttrs.characters = status.customAttrs.characters || {};
    const lines = [];
    lines.push('【自定义属性当前状态】');
    lines.push('以下属性来自当前世界观的玩法配置，当前值保存在本对话状态栏中。以上为当前累计状态，不是本轮增量。');
    lines.push('');
    if (globalAttrs.length) {
      lines.push('全局属性：');
      globalAttrs.forEach(a => {
        const val = status.customAttrs.global[a.id] ?? a.initial ?? 0;
        const hasMax = !(a.max === '' || a.max === null || a.max === undefined);
        const maxText = hasMax ? ` / ${a.max}` : '';
        const desc = (a.desc || '').trim() ? `。说明：${a.desc.trim()}` : '';
        let ovText = '';
        if (a.overflowTo) {
          const t = globalAttrs.find(x => x.id === a.overflowTo);
          if (t) ovText = `。进位规则：达到上限 ${a.max} 后，每满一次「${t.name}」+1，本属性保留余数（系统自动处理，你只需正常输出增量）`;
        }
        if (a.deriveTo) {
          const t = globalAttrs.find(x => x.id === a.deriveTo);
          const step = Number(a.deriveStep) > 0 ? Number(a.deriveStep) : 100;
          if (t) ovText += `。派生规则：每累计 ${step} 点，「${t.name}」自动+1（${t.name} = 本属性÷${step} 向下取整，系统自动计算，你只需正常输出本属性增量）`;
        }
        const isDerived = globalAttrs.some(x => x.deriveTo === a.id);
        if (isDerived) ovText += `。【只读】本属性由其它属性自动派生，请勿直接输出它的增量（输出也会被忽略）`;
        lines.push(`- ${a.name}：当前 ${val}${maxText}${desc}${ovText}`);
      });
    }
    if (charCards.length) {
      if (globalAttrs.length) lines.push('');
      lines.push('角色属性：');
      charCards.forEach(c => {
        const key = _attrTargetKey(c);
        const attrs = (c.attrs || []).filter(a => a && a.id && (a.name || '').trim());
        if (!attrs.length) return;
        const source = c.sourceLabel ? `（${c.sourceLabel}）` : '';
        lines.push(`- ${c.targetName || '未命名角色'}${source}：`);
        attrs.forEach(a => {
          const val = status.customAttrs.characters[key]?.[a.id] ?? a.initial ?? 0;
          const hasMax = !(a.max === '' || a.max === null || a.max === undefined);
          const maxText = hasMax ? ` / ${a.max}` : '';
          const desc = (a.desc || '').trim() ? `。说明：${a.desc.trim()}` : '';
          let ovText = '';
          if (a.overflowTo) {
            const t = attrs.find(x => x.id === a.overflowTo);
            if (t) ovText = `。进位规则：达到上限 ${a.max} 后，每满一次「${t.name}」+1，本属性保留余数（系统自动处理，你只需正常输出增量）`;
          }
          if (a.deriveTo) {
            const t = attrs.find(x => x.id === a.deriveTo);
            const step = Number(a.deriveStep) > 0 ? Number(a.deriveStep) : 100;
            if (t) ovText += `。派生规则：每累计 ${step} 点，「${t.name}」自动+1（${t.name} = 本属性÷${step} 向下取整，系统自动计算，你只需正常输出本属性增量）`;
          }
          const isDerived = attrs.some(x => x.deriveTo === a.id);
          if (isDerived) ovText += `。【只读】本属性由其它属性自动派生，请勿直接输出它的增量（输出也会被忽略）`;
          lines.push(`  - ${a.name}：当前 ${val}${maxText}${desc}${ovText}`);
        });
      });
    }
    return lines.join('\n');
  } catch(e) { return ''; }
}

async function formatCustomAttrsForPrompt() {
  const format = await formatCustomAttrsFormatPrompt();
  const state = await formatCustomAttrsStatePrompt();
  return [format, state].filter(Boolean).join('\n\n');
}


async function applyCustomAttrsDelta(deltaObj) {
if (!deltaObj || typeof deltaObj !== 'object') return false;
const wv = await _getCurrentWorldview();
// v632.2：心动模拟禁用；其余（含无世界观）放行
if (wv && wv.id === 'wv_heartsim') return false;
const gp = await _getConvGameplay();
  const status = _currentStatus || Conversations.getStatusBar() || { time: '', weather: '', region: '', location: '', scene: '', playerOutfit: '', playerPosture: '', npcs: [] };
  status.customAttrs = status.customAttrs || {};
  status.customAttrs.global = status.customAttrs.global || {};
  status.customAttrs.characters = status.customAttrs.characters || {};
  let changed = false;
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const clamp = (next, attr) => {
    let v = Number.isFinite(Number(next)) ? Number(next) : 0;
    const hasMax = !(attr.max === '' || attr.max === null || attr.max === undefined);
    if (hasMax) {
      const max = Number(attr.max);
      if (Number.isFinite(max)) v = Math.min(max, v);
    }
    v = Math.max(0, v);
    return v;
  };
  // 严格进位（留余数）+ 连锁。store 是当前作用域的 {attrId: value} 映射，defs 是该作用域属性定义数组。
  // 把 attr 累加后的 rawVal 写入 store，若达到上限则向 overflowTo 目标进位，目标再递归处理。
  const applyWithOverflow = (store, defs, attr, rawVal, visited) => {
    visited = visited || new Set();
    let v = Math.max(0, Number.isFinite(Number(rawVal)) ? Number(rawVal) : 0);
    const hasMax = !(attr.max === '' || attr.max === null || attr.max === undefined);
    const max = hasMax ? Number(attr.max) : NaN;
    // 无上限 / 上限非正数 / 未配置进位目标 / 已在链路中（防环）→ 退化为普通钳制
    if (!hasMax || !Number.isFinite(max) || max <= 0 || !attr.overflowTo || visited.has(attr.id)) {
      store[attr.id] = clamp(v, attr);
      return;
    }
    visited.add(attr.id);
    const target = defs.find(d => d && d.id === attr.overflowTo);
    if (!target) { store[attr.id] = clamp(v, attr); return; }
    if (v >= max) {
      const carry = Math.floor(v / max);
      store[attr.id] = v % max;            // 留余数
      const tCur = Number(store[target.id] ?? target.initial ?? 0) || 0;
      applyWithOverflow(store, defs, target, tCur + carry, visited);  // 连锁进位
    } else {
      store[attr.id] = v;
    }
  };
  // 派生投影：target = floor(source / step)，纯只读投影，源不动；支持链式（A→B→C），多轮迭代直至稳定+防环
  const applyDerived = (store, defs) => {
    let any = false, rounds = 0, loop = true;
    while (loop && rounds < defs.length + 2) {
      loop = false; rounds++;
      defs.forEach(attr => {
        if (!attr || !attr.deriveTo) return;
        const target = defs.find(d => d && d.id === attr.deriveTo);
        if (!target || target.id === attr.id) return;
        const step = Number(attr.deriveStep) > 0 ? Number(attr.deriveStep) : 100;
        const srcVal = Number(store[attr.id] ?? attr.initial ?? 0) || 0;
        const derived = Math.floor(srcVal / step);
        if (Number(store[target.id]) !== derived) { store[target.id] = derived; loop = true; any = true; }
      });
    }
    return any;
  };
  const globalDefs = (gp?.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim());
  const globalDeriveTargets = new Set(globalDefs.filter(a => a.deriveTo).map(a => a.deriveTo));
  const globalDelta = deltaObj.global && typeof deltaObj.global === 'object' ? deltaObj.global : {};
  Object.entries(globalDelta).forEach(([name, delta]) => {
    const attr = globalDefs.find(a => (a.name || '').trim() === String(name).trim());
    const d = toNum(delta);
    if (!attr || d === null) return;
    if (globalDeriveTargets.has(attr.id)) return; // 派生目标只读，不认 AI 增量
    const cur = status.customAttrs.global[attr.id] ?? attr.initial ?? 0;
    applyWithOverflow(status.customAttrs.global, globalDefs, attr, Number(cur || 0) + d, new Set());
    changed = true;
  });
  if (applyDerived(status.customAttrs.global, globalDefs)) changed = true;
  const charDelta = deltaObj.characters && typeof deltaObj.characters === 'object' ? deltaObj.characters : {};
  const cards = (gp?.characterAttrs || []).filter(c => c && Array.isArray(c.attrs));
  Object.entries(charDelta).forEach(([charName, attrsObj]) => {
    if (!attrsObj || typeof attrsObj !== 'object') return;
    const card = cards.find(c => (c.targetName || '').trim() === String(charName).trim());
    if (!card) return;
    const key = _attrTargetKey(card);
    status.customAttrs.characters[key] = status.customAttrs.characters[key] || {};
    const defs = (card.attrs || []).filter(a => a && a.id && (a.name || '').trim());
    const deriveTargets = new Set(defs.filter(a => a.deriveTo).map(a => a.deriveTo));
    Object.entries(attrsObj).forEach(([attrName, delta]) => {
      const attr = defs.find(a => (a.name || '').trim() === String(attrName).trim());
      const d = toNum(delta);
      if (!attr || d === null) return;
      if (deriveTargets.has(attr.id)) return; // 派生目标只读，不认 AI 增量
      const cur = status.customAttrs.characters[key][attr.id] ?? attr.initial ?? 0;
      applyWithOverflow(status.customAttrs.characters[key], defs, attr, Number(cur || 0) + d, new Set());
      changed = true;
    });
    if (applyDerived(status.customAttrs.characters[key], defs)) changed = true;
  });
  if (changed) {
    _currentStatus = status;
    try { await Conversations.setStatusBar(status); } catch(_) {}
    try { await render(status); } catch(_) {}
  }
  return changed;
}

async function editCharacterAttr(cardIdx, attrIdx) {
  const card = _characterAttrCards[cardIdx];
  const attrs = (card?.attrs || []).filter(a => a && a.id && (a.name || '').trim());
  const attr = attrs[attrIdx];
  if (!card || !attr) return;
  if (!_currentStatus) _currentStatus = { region:'',location:'',time:'',weather:'',scene:'',playerOutfit:'',playerPosture:'',npcs:[] };
  _currentStatus.customAttrs = _currentStatus.customAttrs || {};
  _currentStatus.customAttrs.characters = _currentStatus.customAttrs.characters || {};
  const key = _attrTargetKey(card);
  _currentStatus.customAttrs.characters[key] = _currentStatus.customAttrs.characters[key] || {};
  const oldVal = _currentStatus.customAttrs.characters[key][attr.id] ?? attr.initial ?? 0;
  const input = await UI.showSimpleInput(`修改「${card.targetName || '角色'} · ${attr.name || '属性'}」`, String(oldVal), { placeholder: '当前值' });
  if (input === null || input === undefined) return;
  const txt = String(input).trim();
  if (txt === '') return;
  const num = Number(txt);
  if (!Number.isFinite(num)) { UI.showToast('请输入数字', 1800); return; }
  _currentStatus.customAttrs.characters[key][attr.id] = num;
  try { await Conversations.setStatusBar(_currentStatus); } catch(e) {}
  render(_currentStatus);
}

async function _hydrateSingleCharPlaceholder(rootEl) {
  try {
    if (!rootEl) return;
    const curId = (typeof Conversations !== 'undefined') ? Conversations.getCurrent() : null;
      const conv = curId ? (Conversations.getList().find(c => c.id === curId) || null) : null;
      if (!conv || !conv.isSingle || !conv.singleCharId) return;
      let name = '角色', avatar = '';
      if (conv.singleCharType === 'card') {
        const card = await SingleCard.get(conv.singleCharId);
        if (card) { name = card.name || '角色'; avatar = card.avatar || ''; }
      } else if (conv.singleCharType === 'npc') {
        avatar = await SingleCard.getNpcAvatar(conv.singleCharId).catch(()=>'');
        // 从世界观读 NPC 名
        try {
          const wv = await DB.get('worldviews', conv.singleCharSourceWvId || conv.singleWorldviewId);
          if (wv && Array.isArray(wv.regions)) {
            outer: for (const r of wv.regions) {
              for (const f of (r.factions || [])) {
                for (const n of (f.npcs || [])) {
                  if (n.id === conv.singleCharId) { name = n.name || name; break outer; }
                }
              }
            }
          }
        } catch(_) {}
      }
      const nameEl = rootEl.querySelector('[data-single-char-name="1"]');
      const avaEl = rootEl.querySelector('[data-single-char-avatar="1"]');
      if (nameEl) nameEl.textContent = name;
      if (avaEl) {
        if (avatar) {
          avaEl.innerHTML = `<img src="${_esc(avatar)}" alt="" style="width:100%;height:100%;object-fit:cover">`;
          avaEl.classList.add('has-img');
        } else {
          avaEl.innerHTML = `<div class="sb-npc-avatar-initial">${_esc((name || '?').trim().charAt(0))}</div>`;
        }
      }
    } catch(_) {}
  }

async function render(status) {
    _currentStatus = status;
    const row = _el('topbar-row-status');
    if (!row) return;
    const _isSingleSkin = document.body.getAttribute('data-skin') === 'single-default';
    const _isNeumorphSkin = _resolveSkin(document.body.getAttribute('data-sb-skin')) === 'neumorph';
    if (!status) {
      let hasCustomGlobalAttrs = false;
      try {
        const wv = await _getCurrentWorldview();
        const gp = await _getConvGameplay();
        const skin = _resolveSkin(wv?.statusBarSkin || document.body.getAttribute('data-sb-skin') || '');
        if (skin === 'neumorph' || skin === 'terminal') {
          hasCustomGlobalAttrs = !!(gp?.globalAttrs || []).some(a => a && a.id && (a.name || '').trim())
          || !!((skin === 'neumorph' || skin === 'terminal') && (gp?.characterAttrs || []).some(c => c && Array.isArray(c.attrs) && c.attrs.some(a => a && a.id && (a.name || '').trim())));
        }
      } catch(_) {}
      if (_isSingleSkin || hasCustomGlobalAttrs) {
        // 拟态皮：允许没有 AI status 时也显示空壳，以便展示/编辑自定义属性
        status = { time: '', weather: '', region: '', location: '', scene: '', playerOutfit: '', playerPosture: '', npcs: [] };
        _currentStatus = status;
      } else {
        row.classList.add('hidden');
        _el('sb-expanded-overlay')?.classList.add('hidden');
        _expanded = false;
        return;
      }
    }
    row.classList.remove('hidden');

    // 时间和天气
    const timeStr = status.time || '';
    const weather = status.weather || '';
    const timeParts = _splitTime(timeStr);
    const clockEl = _el('sb-clock-main');
    const dateEl = _el('sb-date-sub');
    if (clockEl) clockEl.textContent = timeParts.clock || '—';
    if (dateEl) {
      dateEl.textContent = timeParts.rest && timeParts.rest !== '—' ? timeParts.rest : '';
      dateEl.style.display = dateEl.textContent ? '' : 'none';
    }
    // 季节：优先用已存的season字段，没有则根据time实时计算
    const seasonEl = _el('sb-season-text');
    if (seasonEl) {
      let seasonName = status.season || '';
      if (!seasonName && timeStr && typeof Calendar !== 'undefined') {
        try {
          const parsed = Calendar.parseAbsoluteTime(timeStr);
          if (parsed) {
            const s = Calendar.getSeason ? Calendar.getSeason(parsed.month, null) : null;
            if (s) seasonName = s.name;
          }
        } catch(_) {}
      }
      seasonEl.textContent = seasonName;
      seasonEl.style.display = seasonName ? '' : 'none';
    }
    _el('sb-weather-text').textContent = weather || '';
    const ww = _el('sb-weather-wrap');
    if (ww) ww.style.display = weather ? '' : 'none';
    // 环境音：天气变化时同步
    try { if (typeof Ambient !== 'undefined') Ambient.updateWeather(weather); } catch(_) {}

    // 地点
    const placeText = [status.region, status.location].filter(Boolean).join(' · ') || '—';
    const placeEl = _el('sb-place-text');
    if (placeEl) placeEl.textContent = placeText;

    // 展开态内容
    _el('sb-scene').textContent = status.scene || '点击添加场景描写…';
    _el('sb-scene').classList.toggle('sb-empty', !status.scene);
    _el('sb-player-outfit').textContent = status.playerOutfit || '—';
    _el('sb-player-posture').textContent = status.playerPosture || '—';

    // 自定义属性（当前只在拟态风格显示）
    _renderCustomAttrs(status);
    _renderCharacterAttrs(status);

    // NPC 列表
    const npcEl = _el('sb-npcs-list');
    const npcsCount = _el('sb-npcs-count');
    if (npcEl) {
      const npcs = status.npcs || [];
      if (npcsCount) npcsCount.textContent = `(${npcs.length})`;

      if (!npcs.length) {
        if (_isSingleSkin) {
          // 单人卡皮：空 NPC 时显示一张占位卡（单人卡 char 预览）
          npcEl.innerHTML = `
 <div class="sb-npc-card sb-npc-placeholder" onclick="event.stopPropagation();StatusBar.addNPC()">
   <div class="sb-npc-content">
     <div class="sb-npc-val" style="opacity:.5;font-style:italic">等待 AI 描写服装…</div>
     <div class="sb-npc-val" style="opacity:.5;font-style:italic">等待 AI 描写姿态…</div>
   </div>
   <div class="sb-npc-side">
     <div class="sb-npc-avatar" data-single-char-avatar="1">
       <div class="sb-npc-avatar-initial">?</div>
     </div>
     <div class="sb-npc-name" data-single-char-name="1">角色</div>
   </div>
 </div>
 <div class="sb-npc-empty" onclick="event.stopPropagation();StatusBar.addNPC()">+ 添加 NPC</div>`;
          _hydrateSingleCharPlaceholder(npcEl);
        } else {
          npcEl.innerHTML = '<div class="sb-npc-empty" onclick="event.stopPropagation();StatusBar.addNPC()"><span class="sb-npc-add-full">+ 添加 NPC</span><span class="sb-npc-add-plus">+</span></div>';
        }
      } else {
        npcEl.innerHTML = npcs.map((n, i) => {
          if (_isSingleSkin) {
            // 单人卡皮：右侧头像+名字，左侧只显示 outfit/posture 值（无小标题）
            const _initial = _esc((n.name || '?').trim().charAt(0));
            return `
 <div class="sb-npc-card" onclick="event.stopPropagation();StatusBar.editNPC(${i})">
   <div class="sb-npc-content">
     ${n.outfit ? `<div class="sb-npc-val">${_esc(n.outfit)}</div>` : ''}
     ${n.posture ? `<div class="sb-npc-val">${_esc(n.posture)}</div>` : ''}
   </div>
   <div class="sb-npc-side">
     <div class="sb-npc-avatar" data-npc-name="${_esc(n.name)}">
       <div class="sb-npc-avatar-initial">${_initial}</div>
     </div>
     <div class="sb-npc-name">${_esc(n.name)}</div>
   </div>
 </div>`;
          } else {
            return `
 <div class="sb-npc-card" onclick="event.stopPropagation();StatusBar.editNPC(${i})">
 <div class="sb-npc-name">${_esc(n.name)}</div>
 ${n.outfit ? `<div class="sb-npc-val"><span class="sb-field-label-inline">> OUTFIT_</span> ${_esc(n.outfit)}</div>` : ''}
 ${n.posture ? `<div class="sb-npc-val"><span class="sb-field-label-inline">> POSTURE_</span> ${_esc(n.posture)}</div>` : ''}
 </div>
 `;
          }
        }).join('') + '<div class="sb-npc-empty" onclick="event.stopPropagation();StatusBar.addNPC()"><span class="sb-npc-add-full">+ 添加 NPC</span><span class="sb-npc-add-plus">+</span></div>';

        // 单人卡皮：异步填充头像
        if (_isSingleSkin) {
          _hydrateNpcAvatars(npcEl);
        }
      }
 _refreshNpcDots(npcs.length);
    }

    // 手机联动：轨迹记录 + 小组件
    try {
      if (window.Phone) {
        const fullLoc = [status.region, status.location].filter(Boolean).join('·');
        if (fullLoc) Phone.recordLocation(fullLoc, timeStr);
        const phoneTime = document.getElementById('phone-time');
 const clockMatch = (timeStr || '').match(/\d{1,2}:\d{2}/);
 if (phoneTime) phoneTime.textContent = clockMatch ? clockMatch[0] : (timeStr || '');
      }
    } catch(_) {}

    // 心动模拟专区
    _renderHS();
    // 通用任务面板
    _renderTaskPanel();
  }

  function toggleNpcs() {
    const body = document.getElementById('sb-npcs-body');
    const npcsCountText = document.getElementById('sb-npcs-count') ? document.getElementById('sb-npcs-count').textContent : '(0)';
    
    // 根据皮肤决定标题文本
    const skin = _resolveSkin(document.body.getAttribute('data-sb-skin') || '');
    const isSingleDefault = document.body.getAttribute('data-skin') === 'single-default';
    const titleText = (skin === 'neumorph' || isSingleDefault) ? 'Presences' : 'NPCS';
    
    if (body.classList.contains('open')) {
      body.classList.remove('open');
      document.querySelector('.sb-npcs-title').innerHTML = '[ + ] ' + titleText + ' <span id="sb-npcs-count">' + npcsCountText + '</span>';
    } else {
      body.classList.add('open');
      document.querySelector('.sb-npcs-title').innerHTML = '[ - ] ' + titleText + ' <span id="sb-npcs-count">' + npcsCountText + '</span>';
    }
  }

  function _applyWorld(wv) {
    const nameEl = _el('sb-world-name');
    const avaEl = _el('sb-world-avatar');
    if (!nameEl || !avaEl) return;
    if (!wv) { nameEl.textContent = ''; avaEl.style.display = 'none'; return; }
    nameEl.textContent = wv.name || '';
    if (wv.iconImage) {
      avaEl.src = wv.iconImage;
      avaEl.style.display = '';
      avaEl.classList.remove('sb-world-emoji');
      avaEl.textContent = '';
    } else if (wv.icon) {
      // 没有头像图片时用 emoji 兜底
      avaEl.style.display = 'none';
      // 用 nameEl 之前塞一个 emoji 也可以，但简单起见就不显示头像
    } else {
      avaEl.style.display = 'none';
    }
  }

  function toggle(e) {
    if (e) e.stopPropagation();
    _expanded = !_expanded;
    const overlay = _el('sb-expanded-overlay');
    const chev = _el('sb-chevron');
    if (overlay) {
      overlay.classList.toggle('hidden', !_expanded);
      // 注意：之前这里同步调用 getBoundingClientRect 拿 topbar/input 高度，
      // 17w 长会话下会强制 flush 全量 layout，导致 toggle 卡顿明显。
      // 现在改成由 ResizeObserver 把高度写入 CSS 变量，toggle 时直接用。
      // 见下方 _initTopbarHeightVars()。
    }
    if (chev) chev.style.transform = _expanded ? 'rotate(180deg)' : 'rotate(0)';
  }

  // 监听顶栏/输入框尺寸变化，把高度写到 CSS 变量上，供展开态 padding 计算用
  // 只跑一次；ResizeObserver 触发回调是异步的，不会阻塞同步路径。
  let _topbarHeightObsAttached = false;
  function _initTopbarHeightVars() {
    if (_topbarHeightObsAttached) return;
    _topbarHeightObsAttached = true;
    try {
      const topbar = document.getElementById('chat-topbar');
      const input = document.querySelector('#panel-chat .chat-input-area');
      const root = document.documentElement;
      const apply = () => {
        const h = topbar ? topbar.offsetHeight : 80;
        const ih = input ? input.offsetHeight : 0;
        root.style.setProperty('--sb-topbar-h', h + 'px');
        root.style.setProperty('--sb-input-h', ih + 'px');
      };
      apply();
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(apply);
        if (topbar) ro.observe(topbar);
        if (input) ro.observe(input);
      } else {
        // 旧浏览器兜底：监听 window resize
        window.addEventListener('resize', apply);
      }
    } catch(_) {}
  }
  // 在模块就绪后挂上（DOMContentLoaded 之后再调）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initTopbarHeightVars);
  } else {
    _initTopbarHeightVars();
  }

  // ======== 编辑 ========

  function editField(field) {
    if (!_currentStatus) _currentStatus = { region:'',location:'',time:'',weather:'',scene:'',playerOutfit:'',playerPosture:'',npcs:[] };
    const titles = {
      scene: '场景描写',
      playerOutfit: '玩家衣着',
      playerPosture: '玩家姿势',
      region: '大地点',
      location: '小地点',
      time: '时间',
      weather: '天气'
    };
    _editBuf = { mode: 'field', field };
    _el('sb-edit-title').textContent = '编辑 · ' + (titles[field] || field);
    _el('sb-edit-fields').innerHTML = `
      <textarea id="sb-edit-input" style="width:100%;min-height:120px;resize:vertical;padding:10px;font-size:14px;line-height:1.6">${_esc(_currentStatus[field] || '')}</textarea>
    `;
    _el('sb-edit-modal').classList.remove('hidden');
    setTimeout(() => _el('sb-edit-input')?.focus(), 100);
  }

  function editNPC(idx) {
    if (!_currentStatus) return;
    const npc = (_currentStatus.npcs || [])[idx];
    if (!npc) return;
    _editBuf = { mode: 'npc', idx };
    _el('sb-edit-title').textContent = '编辑 NPC · ' + npc.name;
    _el('sb-edit-fields').innerHTML = `
      <label style="font-size:12px;color:var(--text-secondary)">名字</label>
      <input id="sb-edit-npc-name" type="text" value="${_esc(npc.name)}" style="padding:8px;font-size:14px">
      <label style="font-size:12px;color:var(--text-secondary)">衣着</label>
      <textarea id="sb-edit-npc-outfit" style="min-height:60px;resize:vertical;padding:8px;font-size:14px">${_esc(npc.outfit || '')}</textarea>
      <label style="font-size:12px;color:var(--text-secondary)">姿势</label>
      <textarea id="sb-edit-npc-posture" style="min-height:60px;resize:vertical;padding:8px;font-size:14px">${_esc(npc.posture || '')}</textarea>
      <button onclick="StatusBar.deleteNPC(${idx})" style="margin-top:8px;padding:8px;background:none;border:1px solid var(--border);color:var(--danger);border-radius:6px;cursor:pointer">删除此 NPC</button>
    `;
    _el('sb-edit-modal').classList.remove('hidden');
  }

  function addNPC() {
    if (!_currentStatus) _currentStatus = { region:'',location:'',time:'',weather:'',scene:'',playerOutfit:'',playerPosture:'',npcs:[] };
    _editBuf = { mode: 'npc', idx: -1 };  // -1 表示新增
    _el('sb-edit-title').textContent = '添加 NPC';
    _el('sb-edit-fields').innerHTML = `
      <label style="font-size:12px;color:var(--text-secondary)">名字</label>
      <input id="sb-edit-npc-name" type="text" placeholder="NPC 名字" style="padding:8px;font-size:14px">
      <label style="font-size:12px;color:var(--text-secondary)">衣着</label>
      <textarea id="sb-edit-npc-outfit" style="min-height:60px;resize:vertical;padding:8px;font-size:14px"></textarea>
      <label style="font-size:12px;color:var(--text-secondary)">姿势</label>
      <textarea id="sb-edit-npc-posture" style="min-height:60px;resize:vertical;padding:8px;font-size:14px"></textarea>
    `;
    _el('sb-edit-modal').classList.remove('hidden');
    setTimeout(() => _el('sb-edit-npc-name')?.focus(), 100);
  }

async function saveEdit() {
    if (!_editBuf || !_currentStatus) { closeEdit(); return; }
    if (_editBuf.mode === 'field') {
      let val = _el('sb-edit-input').value.trim();
      // 如果编辑的是时间字段，尝试标准化格式
      if (_editBuf.field === 'time' && val && typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) {
        const parsed = Calendar.parseAbsoluteTime(val);
        if (parsed) {
          try {
            let calRules = null;
            try {
              const _conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
              const _wvId = _conv?.worldviewId;
              const wv = _wvId ? await DB.get('worldviews', _wvId) : null;
              calRules = wv?.gameplay?.calendarSystem || null;
            } catch(_) {}
            const formatted = Calendar.format(parsed, calRules);
            if (formatted) val = formatted;
            // 手动改时间后同步重算季节/时段（与 AI 输出后的逻辑对齐）
            try {
              const r = Calendar.processTimeField(val, val, calRules);
              if (r && !r.parseError) {
                if (r.timeStr) val = r.timeStr;
                if (r.season) _currentStatus.season = r.season.name;
                if (r.timePeriod) _currentStatus.timePeriod = r.timePeriod.name;
              }
            } catch(_) {}
          } catch(_) {}
        }
      }
      _currentStatus[_editBuf.field] = val;
    } else if (_editBuf.mode === 'env') {
      _currentStatus.region = _el('sb-edit-env-region').value.trim();
      _currentStatus.location = _el('sb-edit-env-location').value.trim();
      let timeVal = _el('sb-edit-env-time').value.trim();
      // 尝试标准化时间格式，确保后续增量计算能解析
      if (timeVal && typeof Calendar !== 'undefined' && Calendar.parseAbsoluteTime) {
        const parsed = Calendar.parseAbsoluteTime(timeVal);
        if (parsed) {
          // 能解析就格式化成标准格式
          try {
            let calRules = null;
            try {
              const _conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
              const _wvId = _conv?.worldviewId;
              const wv = _wvId ? await DB.get('worldviews', _wvId) : null;
              calRules = wv?.gameplay?.calendarSystem || null;
            } catch(_) {}
            const formatted = Calendar.format ? Calendar.format(parsed, calRules) : null;
            if (formatted) timeVal = formatted;
            // 手动改时间后同步重算季节/时段（与 AI 输出后的逻辑对齐）
            try {
              const r = Calendar.processTimeField(timeVal, timeVal, calRules);
              if (r && !r.parseError) {
                if (r.timeStr) timeVal = r.timeStr;
                if (r.season) _currentStatus.season = r.season.name;
                if (r.timePeriod) _currentStatus.timePeriod = r.timePeriod.name;
              }
            } catch(_) {}
          } catch(_) {}
        }
      }
      _currentStatus.time = timeVal;
      _currentStatus.weather = _el('sb-edit-env-weather').value.trim();
    } else if (_editBuf.mode === 'npc') {
      const name = _el('sb-edit-npc-name').value.trim();
      const outfit = _el('sb-edit-npc-outfit').value.trim();
      const posture = _el('sb-edit-npc-posture').value.trim();
      if (!name) { UI.showToast('请填写名字', 2000); return; }
      _currentStatus.npcs = _currentStatus.npcs || [];
      if (_editBuf.idx === -1) {
        _currentStatus.npcs.push({ name, outfit, posture });
      } else {
        _currentStatus.npcs[_editBuf.idx] = { name, outfit, posture };
      }
    }
    try { await Conversations.setStatusBar(_currentStatus); } catch(e) {}
    render(_currentStatus);
    closeEdit();
  }

  async function deleteNPC(idx) {
    if (!_currentStatus || !_currentStatus.npcs) return;
    _currentStatus.npcs.splice(idx, 1);
    try { await Conversations.setStatusBar(_currentStatus); } catch(e) {}
    render(_currentStatus);
    closeEdit();
  }

  function closeEdit() {
    _editBuf = null;
    _el('sb-edit-modal')?.classList.add('hidden');
  }

  // 一次编辑时间/地点/天气（环境字段组）
  function editEnv() {
    if (!_currentStatus) return;
    _editBuf = { mode: 'env' };
    _el('sb-edit-title').textContent = '编辑 · 时间 / 地点 / 天气';
    _el('sb-edit-fields').innerHTML = `
      <label style="font-size:12px;color:var(--text-secondary);margin-top:4px">大地点</label>
      <input id="sb-edit-env-region" type="text" placeholder="如：天枢城·东区" value="${_esc(_currentStatus.region || '')}" style="padding:8px;font-size:14px">
      <label style="font-size:12px;color:var(--text-secondary);margin-top:4px">小地点</label>
      <input id="sb-edit-env-location" type="text" placeholder="如：某街道·某建筑·某房间" value="${_esc(_currentStatus.location || '')}" style="padding:8px;font-size:14px">
      <label style="font-size:12px;color:var(--text-secondary);margin-top:4px">时间</label>
      <input id="sb-edit-env-time" type="text" placeholder="如：2065年3月27日 星期五 15:02" value="${_esc(_currentStatus.time || '')}" style="padding:8px;font-size:14px">
      <label style="font-size:12px;color:var(--text-secondary);margin-top:4px">天气</label>
      <input id="sb-edit-env-weather" type="text" placeholder="如：晴朗 22℃" value="${_esc(_currentStatus.weather || '')}" style="padding:8px;font-size:14px">
    `;
    _el('sb-edit-modal').classList.remove('hidden');
    setTimeout(() => _el('sb-edit-env-time')?.focus(), 100);
  }

  // ======== 通用任务系统 ========

function _getTaskState() {
  if (!_currentStatus) {
    try { _currentStatus = Conversations.getStatusBar() || {}; } catch(_) { _currentStatus = {}; }
  }
  if (!_currentStatus.taskSystem) {
    _currentStatus.taskSystem = { phaseIndex: 0, doneInPhase: 0, active: [], pendingPublish: false, finished: false };
  }
  return _currentStatus.taskSystem;
}

async function _saveTaskState() {
  try {
    const sb = Conversations.getStatusBar() || {};
    sb.taskSystem = _getTaskState();
    await Conversations.setStatusBar(sb);
  } catch(_) {}
}

async function _getTaskConfig() {
  const gp = await _getConvGameplay();
  if (!gp?.taskSystem?.phases?.length) return null;
  return gp.taskSystem;
}

// 查找类型模板 by label，在当前阶段
function _findTypeTemplate(config, phaseIndex, typeLabel) {
  const phase = config?.phases?.[phaseIndex];
  if (!phase) return null;
  return (phase.types || []).find(t => t.label === typeLabel) || null;
}

// 生成对话级短任务 id（4位 base36，AI 易抄回）
function _genShortTaskId() {
  return Math.random().toString(36).slice(2, 6);
}

// 生成一个在 existingList 中不冲突的短 id（最多重试若干次，兜底用时间戳）
function _genUniqueTaskId(existingList) {
  const used = new Set((existingList || []).map(a => _normTaskId(a && a.id)));
  for (let i = 0; i < 20; i++) {
    const id = _genShortTaskId();
    if (!used.has(id)) return id;
  }
  // 极端兜底：拼时间戳尾段，几乎不可能再撞
  return (_genShortTaskId() + Date.now().toString(36).slice(-2));
}

// 归一化 id：去掉 # 前缀、t_ 前缀、空白，转小写，方便宽松比对
function _normTaskId(id) {
  return String(id || '').trim().toLowerCase().replace(/^#/, '').replace(/^t_/, '');
}

// 归一化任务文本：去掉空白、标点、常见动词修饰词，方便模糊匹配
function _normTaskText(text) {
  let s = String(text || '').toLowerCase();
  // 去掉所有空白和标点符号（含中英文标点）
  s = s.replace(/[\s\u3000]+/g, '');
  s = s.replace(/[，。、；：！？「」『』（）()\[\]【】《》<>~·…—\-_,.;:!?"'`]/g, '');
  // 去掉表示"完成/进行"语义的常见修饰词，避免 AI 改写措辞导致失配
  s = s.replace(/(完成了|完成|已经|已|去|对|的|进行|了|要|把|将|做完|做)/g, '');
  return s;
}

// 字符二元组(bigram)集合，保留词序信息
function _taskBigrams(s) {
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  if (s.length === 1) g.add(s);
  return g;
}

// 两段任务文本的相似度：包含关系=1，否则取 bigram Jaccard
function _taskTextSim(t1, t2) {
  const a = _normTaskText(t1), b = _normTaskText(t2);
  if (!a || !b) return 0;
  if (a === b || a.includes(b) || b.includes(a)) return 1;
  const ga = _taskBigrams(a), gb = _taskBigrams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  return inter / (ga.size + gb.size - inter);
}

// 文本模糊匹配阈值：低于此值视为不同任务（防误伤）
const _TASK_SIM_THRESHOLD = 0.4;

// 多级匹配：在 active 任务里找出 AI 这条 t 指向的任务
// 1) id 精确/宽松  2) text 精确  3) text 模糊（bigram Jaccard）  4) type 唯一兜底
function _matchActiveTask(activeList, t) {
  const actives = activeList.filter(a => a && a.status === 'active');
  if (!actives.length) return null;

  // 1. id 匹配（精确优先，再宽松比对：兼容 AI 带 #、带 t_ 前缀、长短 id）
  if (t.id) {
    const tid = _normTaskId(t.id);
    if (tid) {
      let hit = actives.find(a => _normTaskId(a.id) === tid);
      if (!hit) hit = actives.find(a => {
        const aid = _normTaskId(a.id);
        return aid && tid && (aid.includes(tid) || tid.includes(aid));
      });
      if (hit) return hit;
    }
  }

  const text = String(t.text || '').trim();
  if (text) {
    // 2. text 精确匹配
    let hit = actives.find(a => a.text === text);
    if (hit) return hit;

    // 3. text 模糊匹配：取相似度最高且超过阈值的一条（解决 AI 改写措辞，同时防误伤）
    let best = null, bestScore = 0;
    for (const a of actives) {
      const score = _taskTextSim(text, a.text);
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (best && bestScore >= _TASK_SIM_THRESHOLD) return best;
  }

  // 4. type 唯一兜底：该类型在 active 中只剩一条，直接认定
  const typeLabel = String(t.type || '').trim();
  if (typeLabel) {
    const sameType = actives.filter(a => a.type && a.type === typeLabel);
    if (sameType.length === 1) return sameType[0];
  }

  return null;
}

// AI 输出 tasks 后调用——核心结算逻辑
async function taskApply(tasksArr) {
  // 心动模拟走自己的 hsApplyTasks，这里跳过
  if (_isHeartSim()) return;
  // 尊重对话设置开关
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (conv && conv.convTasksEnabled === false) return;
  } catch(_) {}
  const config = await _getTaskConfig();
  if (!config) return;
  const ts = _getTaskState();
  if (ts.finished) return;

  const phase = config.phases[ts.phaseIndex];
  if (!phase) { ts.finished = true; _saveTaskState(); return; }

  if (!Array.isArray(tasksArr)) return;
  let changed = false;
  const hadActive = ts.active.length > 0;

  // 1. 处理已有任务的状态变化（done / skipped）
  for (const t of tasksArr) {
    if (!t) continue;
    const status = t.status || '';
    // done/skipped 才需要匹配已有任务；active 留到新增阶段处理
    if (status !== 'done' && status !== 'skipped') continue;

    const existing = _matchActiveTask(ts.active, t);
    if (!existing) continue;

    if (status === 'done' && existing.status === 'active') {
      existing.status = 'done';
      ts.doneInPhase++;
      changed = true;

      // 结算单条奖励
      const tmpl = _findTypeTemplate(config, ts.phaseIndex, existing.type);
      if (tmpl) {
        await _settleTaskReward(tmpl);
        // 自由奖励：记入 pendingFreeRewards，下一轮注入 AI
        if (tmpl.rewardMode === 'free' && tmpl.rewardFree) {
          if (!ts.pendingFreeRewards) ts.pendingFreeRewards = [];
          ts.pendingFreeRewards.push({ task: existing.text, reward: tmpl.rewardFree });
        }
      }
    } else if (status === 'skipped' && existing.status === 'active') {
      existing.status = 'skipped';
      changed = true;
    }
  }

  // 2. 清理已完成/已跳过的任务
  const beforeLen = ts.active.length;
  ts.active = ts.active.filter(a => a.status === 'active');
  if (ts.active.length !== beforeLen) changed = true;

  // 3. 检查阶段是否完成
  if (ts.doneInPhase >= phase.totalTasks) {
    // 结算阶段奖励
    if (phase.completionReward && phase.completionReward.mode !== 'none') {
      await _settlePhaseReward(phase.completionReward);
    }
    // 进入下一阶段
    ts.phaseIndex++;
    ts.doneInPhase = 0;
    ts.active = [];
    ts.pendingPublish = false;
    if (ts.phaseIndex >= config.phases.length) {
      ts.finished = true;
    }
    changed = true;
  }

  // 4. 如果任务栏空了，标记可发布（提示词据此催 AI 补发）
  if (ts.active.length === 0 && !ts.finished && !ts.pendingPublish) {
    ts.pendingPublish = true;
    changed = true;
  }

  // 5. 接受 AI 新发布的 active 任务
  // 闸门：进来时本就无任务（!hadActive），或本轮把任务清空了（length===0 && pendingPublish）。
  // 这样既支持"同一轮完成整批 + 立即补发下一批"，也支持空栏轮补发；
  // 但只要清算后还剩活跃任务（批次未清空），就不接受新任务——保留批次锁，防止任务膨胀。
  if (!hadActive || (ts.active.length === 0 && ts.pendingPublish)) {
    let addedCount = 0;
    for (const t of tasksArr) {
      if (!t || t.status !== 'active') continue;
      const text = String(t.text || '').trim();
      if (!text) continue;
      if (ts.active.find(a => a.text === text)) continue;
      if (addedCount >= (phase.batchSize || 3)) break;

      // 验证 type 是否在当前阶段模板池中
      const typeLabel = String(t.type || '').trim();
      const tmpl = _findTypeTemplate(config, ts.phaseIndex, typeLabel);

      // 分配 id：AI 带的先归一化，若为空或与现有 active 冲突则重新生成唯一 id
      let newId = t.id ? _normTaskId(t.id) : '';
      if (!newId || ts.active.some(a => _normTaskId(a.id) === newId)) {
        newId = _genUniqueTaskId(ts.active);
      }

      ts.active.push({
        id: newId,
        text,
        type: typeLabel,
        status: 'active'
      });
      addedCount++;
      changed = true;
    }
    if (addedCount > 0) ts.pendingPublish = false;
  }

  if (changed) await _saveTaskState();
  _renderTaskPanel();
}

// 单条任务奖励结算
async function _settleTaskReward(tmpl) {
  if (!tmpl) return;
  if (tmpl.rewardMode === 'attr' && tmpl.rewardAttr && tmpl.rewardValue) {
    try {
      // 通过自定义属性 delta 机制加减
      const delta = { global: {}, characters: {} };
      delta.global[tmpl.rewardAttr] = tmpl.rewardValue;
      if (typeof StatusBar !== 'undefined' && StatusBar.applyCustomAttrsDelta) {
        StatusBar.applyCustomAttrsDelta(delta);
      }
    } catch(e) { console.warn('[TaskSystem] 属性奖励结算失败', e); }
  }
  // free 模式的奖励在 prompt 注入时处理，不需要代码结算
}

// 阶段完成奖励结算
async function _settlePhaseReward(cr) {
  if (!cr) return;
  if (cr.mode === 'attr' && cr.attr && cr.value) {
    try {
      const delta = { global: {}, characters: {} };
      delta.global[cr.attr] = cr.value;
      if (typeof StatusBar !== 'undefined' && StatusBar.applyCustomAttrsDelta) {
        StatusBar.applyCustomAttrsDelta(delta);
      }
    } catch(e) { console.warn('[TaskSystem] 阶段奖励结算失败', e); }
  }
}

// 跳过任务（玩家手动操作，从状态面板调用）
async function taskSkip(idx) {
  const ts = _getTaskState();
  const task = ts.active?.[idx];
  if (!task || task.status !== 'active') return;
  if (!await UI.showConfirm('跳过任务', `确定跳过「${task.text}」？`)) return;
  task.status = 'skipped';
  ts.active.splice(idx, 1);
  // 通知 AI
  if (window.Phone && Phone.pushLog) {
    Phone.pushLog(`跳过了任务：${task.text}`);
  }
  // 如果任务栏空了 → 标记下一轮可发布
  if (ts.active.length === 0 && !ts.finished) {
    ts.pendingPublish = true;
  }
  await _saveTaskState();
}

// 重置任务系统（对话设置里调用）
async function taskReset() {
  const sb = Conversations.getStatusBar() || {};
  sb.taskSystem = { phaseIndex: 0, doneInPhase: 0, active: [], pendingPublish: false, finished: false };
  await Conversations.setStatusBar(sb);
  _currentStatus = sb;
}

// 兜底：以最新一条 AI 回复为唯一真相，重建任务栏。
// 不动 doneInPhase（避免重复计数），只保留 active。
async function taskRefreshFromLatestAI() {
  const config = await _getTaskConfig();
  if (!config) { UI.showToast?.('当前世界观未配置任务系统'); return; }
  const ts = _getTaskState();
  if (ts.finished) { UI.showToast?.('任务系统已全部完成'); return; }
  if (typeof Chat === 'undefined' || !Chat.getMessages) { UI.showToast?.('Chat 未就绪'); return; }

  const ok = await UI.showConfirm(
    '同步任务栏',
    '将以最新一条 AI 回复为唯一真相，重建任务栏：\n\n' +
    '· 清空当前所有活跃任务\n' +
    '· 只保留最新回复中标为 active 的任务\n' +
    '· 不重新结算已完成进度和奖励\n\n' +
    '这是兜底机制，仅在任务栏卡 bug 时使用。\n确定继续？'
  );
  if (!ok) return;

  const msgs = Chat.getMessages() || [];
  const latestAI = [...msgs].reverse().find(m => m.role === 'assistant' && m.content);
  if (!latestAI) { UI.showToast?.('没有找到 AI 回复'); return; }

  let parsed = null;
  try { parsed = Utils.parseAIOutput(latestAI.content); } catch(e) { console.warn('[TaskSystem] 解析失败', e); }
  const tasksArr = (parsed && Array.isArray(parsed.tasks)) ? parsed.tasks : [];

  const phase = config.phases[ts.phaseIndex];
  const maxBatch = phase?.batchSize || 3;

  const activeTasks = [];
  tasksArr
    .filter(t => t && (t.status || 'active') === 'active' && String(t.text || '').trim())
    .slice(0, maxBatch)
    .forEach(t => {
      let newId = t.id ? _normTaskId(t.id) : '';
      if (!newId || activeTasks.some(a => _normTaskId(a.id) === newId)) {
        newId = _genUniqueTaskId(activeTasks);
      }
      activeTasks.push({
        id: newId,
        text: String(t.text).trim(),
        type: String(t.type || '').trim(),
        status: 'active'
      });
    });

  const before = ts.active.length;
  ts.active = activeTasks;
  ts.pendingPublish = activeTasks.length === 0;
  await _saveTaskState();

  UI.showToast?.(`已同步：清掉 ${before} 条，重建 ${activeTasks.length} 条 active`);
}

// 为 AI 生成当前任务系统状态提示词
async function taskFormatForPrompt() {
  if (_isHeartSim()) return '';
  try {
    const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
    if (conv && conv.convTasksEnabled === false) return '';
  } catch(_) {}
  const config = await _getTaskConfig();
  if (!config) return '';
  const ts = _getTaskState();
  if (ts.finished) return '【任务系统】\n所有阶段已完成，不再发布新任务。';

  const phase = config.phases[ts.phaseIndex];
  if (!phase) return '';

  const lines = [];
  lines.push(`【任务系统·当前阶段${phase.name ? '：' + phase.name : ' ' + (ts.phaseIndex + 1)}】`);
  // 任务栏为空时，把强制补发提示置于本段最前，确保 AI 优先看到
  if (ts.active.length === 0) {
    lines.push('⚠️ 当前没有正在活跃的任务。本轮你必须从下方「可用任务类型」中发布新的一批任务（用 ```tasks``` 代码块，status 填 active）。这是硬性要求，不要遗漏，也不要拖到下一轮。');
  }
  lines.push(`本阶段进度：${ts.doneInPhase}/${phase.totalTasks}`);
  lines.push('');

  // 可用类型池（含奖励信息）
  if (phase.types && phase.types.length > 0) {
    lines.push('可用任务类型：');
    for (const t of phase.types) {
      let line = `- ${t.label}`;
      if (t.desc) line += `：${t.desc}`;
      if (t.rewardMode === 'attr' && t.rewardAttr) {
        line += `（完成奖励：${t.rewardAttr} ${t.rewardValue >= 0 ? '+' : ''}${t.rewardValue}，由游戏引擎自动结算，AI不要重复操作）`;
      } else if (t.rewardMode === 'free' && t.rewardFree) {
        line += `（完成奖励：${t.rewardFree}，由游戏引擎自动结算，AI不要重复操作）`;
      }
      lines.push(line);
    }
    lines.push('');
  }

  // 当前活跃任务
  if (ts.active.length > 0) {
    lines.push('当前活跃任务（id 在每行行首的方括号内）：');
    ts.active.forEach(a => {
      lines.push(`- [#${a.id}] ${a.text}${a.type ? '（类型：' + a.type + '）' : ''}`);
    });
    lines.push('');
  }

  // 规则
  lines.push('任务规则：');
  lines.push(`- 从可用类型中选择发布任务，每批最多 ${phase.batchSize || 3} 条。`);
  lines.push('- 还有活跃任务时不要发布新任务；一旦本批任务全部完成或跳过、没有任何活跃任务了，请在同一轮立即补发新的一批，不要拖到下一轮。');
  lines.push('- 输出格式：```tasks [{"id":"任务id","text":"具体任务内容","type":"类型名","status":"active/done/skipped"}] ```');
  lines.push('- 标记任务为 done/skipped 时，务必带上该任务行首方括号里的 id（例如上面的 #a3f 就填 "id":"a3f"），系统靠 id 精确定位任务。新发布的 active 任务不用填 id，系统会自动分配。');
  lines.push('- AI 输出 type 字段时必须精确使用上面「可用任务类型」中列出的类型名称，不要自创类型名。');
  lines.push('- done/skipped 是结算事件，系统处理后会自动移除，不需要下一轮继续输出。');
  lines.push('- 【重要】标注"由游戏引擎自动结算"的任务奖励属性，引擎会在任务完成时自动增减对应数值，AI 不要在 custom-attrs 代码块中对这些属性重复操作。');

  // 自由奖励提示：本轮有任务完成且带自由奖励，追加进 prompt 并清掉
  const freeRewards = ts.pendingFreeRewards;
  if (Array.isArray(freeRewards) && freeRewards.length > 0) {
    lines.push('');
    lines.push('【自由奖励待发放】以下任务已完成，请在本轮剧情中自然地给予玩家对应奖励（道具/情报/解锁内容等），奖励方向如下：');
    for (const r of freeRewards) {
      lines.push(`- 任务「${r.task}」完成奖励方向：${r.reward}`);
    }
    lines.push('请根据当前剧情情境决定具体奖励内容，自然融入叙事，不要生硬宣布。');
    // 读完即清，避免重复注入
    ts.pendingFreeRewards = [];
    _saveTaskState();
  }

  return lines.join('\n');
}

// ===== 通用任务面板渲染 =====

async function _renderTaskPanel() {
  const container = document.getElementById('sb-task-system');
  if (!container) return;

  const config = await _getTaskConfig();
  if (!config) { container.classList.add('hidden'); return; }

  const ts = _getTaskState();
  if (ts.finished) {
    container.classList.remove('hidden');
    const label = _el('ts-phase-label');
    const progress = _el('ts-progress');
    const percent = _el('ts-progress-percent');
    const bar = _el('ts-progress-bar');
    const list = _el('ts-task-list');
    const skipBtn = _el('ts-skip-btn');
    if (label) label.textContent = '已全部完成';
    if (progress) progress.textContent = '✓';
    if (percent) percent.textContent = '100%';
    if (bar) bar.style.width = '100%';
    if (list) list.innerHTML = '<div class="hs-task-empty">所有阶段已完成</div>';
    if (skipBtn) skipBtn.disabled = true;
    return;
  }

  const phase = config.phases[ts.phaseIndex];
  if (!phase) { container.classList.add('hidden'); return; }

  container.classList.remove('hidden');

  const label = _el('ts-phase-label');
  const progress = _el('ts-progress');
  const percent = _el('ts-progress-percent');
  const bar = _el('ts-progress-bar');
  const list = _el('ts-task-list');
  const skipBtn = _el('ts-skip-btn');

  const phaseName = phase.name || `阶段 ${ts.phaseIndex + 1}`;
  const total = phase.totalTasks || 10;
  const done = ts.doneInPhase || 0;
  const pct = Math.min(100, Math.max(0, done / total * 100));

  if (label) label.textContent = phaseName;
  if (progress) progress.textContent = `${done}/${total}`;
  if (percent) percent.textContent = `${Math.round(pct)}%`;
  if (bar) bar.style.width = pct + '%';
  if (skipBtn) skipBtn.disabled = !ts.active.some(a => a.status === 'active');

  if (list) {
    const active = (ts.active || []).filter(a => a.status === 'active');
    if (active.length > 0) {
      list.innerHTML = active.map((t, idx) => {
        const typeTag = t.type ? `<span class="hs-task-type">${_esc(t.type)}</span>` : '';
        return `<div class="hs-task-item active">
          <span class="hs-task-dot"></span>
          ${typeTag}
          <span class="hs-task-text">${_esc(t.text)}</span>
        </div>`;
      }).join('');
    } else {
      list.innerHTML = '<div class="hs-task-empty">暂无任务</div>';
    }
  }
}

// 跳过弹窗
let _tsSkipSelectedIdx = null;

function taskOpenSkipModal() {
  const ts = _getTaskState();
  const active = (ts?.active || []).map((t, idx) => ({ ...t, idx })).filter(t => t.status === 'active');
  _tsSkipSelectedIdx = null;

  document.getElementById('ts-skip-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'ts-skip-modal';
  modal.className = 'hs-skip-modal';
  modal.onclick = (e) => { if (e.target === modal) taskCloseSkipModal(); };

  const listHtml = active.length > 0
    ? active.map(t => `
    <button class="hs-skip-choice" data-idx="${t.idx}" onclick="event.stopPropagation();StatusBar.taskSelectSkipTask(${t.idx});">
      <span class="hs-skip-choice-dot"></span>
      <span class="hs-skip-choice-text">${_esc(t.text)}</span>
      ${t.type ? `<span class="hs-skip-choice-type">${_esc(t.type)}</span>` : ''}
    </button>`).join('')
    : '<div class="hs-skip-empty">没有可跳过的任务</div>';

  modal.innerHTML = `
  <div class="hs-skip-dialog" onclick="event.stopPropagation()">
    <div class="hs-skip-title">选择要跳过的任务</div>
    <div class="hs-skip-list">${listHtml}</div>
    <div class="hs-skip-actions">
      <button class="hs-skip-cancel" onclick="event.stopPropagation();StatusBar.taskCloseSkipModal();">取消</button>
      <button class="hs-skip-confirm" id="ts-skip-confirm-btn" disabled onclick="event.stopPropagation();StatusBar.taskConfirmSkipTask();">确认跳过</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

function taskCloseSkipModal() {
  document.getElementById('ts-skip-modal')?.remove();
  _tsSkipSelectedIdx = null;
}

function taskSelectSkipTask(idx) {
  _tsSkipSelectedIdx = idx;
  document.querySelectorAll('#ts-skip-modal .hs-skip-choice').forEach(el => {
    el.classList.toggle('selected', Number(el.dataset.idx) === idx);
  });
  const btn = document.getElementById('ts-skip-confirm-btn');
  if (btn) btn.disabled = false;
}

async function taskConfirmSkipTask() {
  if (_tsSkipSelectedIdx == null) return;
  taskCloseSkipModal();
  await taskSkip(_tsSkipSelectedIdx);
  _renderTaskPanel();
}

// ======== 心动模拟 ========

  function _isHeartSim() {
    try {
      let wvId = null;
      if (typeof Worldview !== 'undefined' && Worldview.getCurrentId) {
        wvId = Worldview.getCurrentId();
      }
      if (wvId === 'wv_heartsim') return true;
      const conv = Conversations.getList()?.find(c => c.id === Conversations.getCurrent());
      if (conv?.worldviewId === 'wv_heartsim') return true;
      if (conv?.singleWorldviewId === 'wv_heartsim') return true;
      return false;
    } catch(_) { return false; }
  }

  function _getHS() {
    if (!_currentStatus) {
      try { _currentStatus = Conversations.getStatusBar() || {}; } catch(_) { _currentStatus = {}; }
    }
    if (!_currentStatus.heartSim) {
      _currentStatus.heartSim = { score: 0, tasks: [], targets: [] };
    }
    return _currentStatus.heartSim;
  }

  // 心动模拟目标不再从世界观 NPC 自动初始化。
  // 来源仅限：AI 输出 relation 代码块（hsApplyRelation 会自动新增）、已有状态保存、用户手动添加。
  // 监管规则：wv_heartsim 禁止读取 NPC.getAll / 当前区域 NPC / 世界观 globalNpcs 生成心动目标，避免被天枢城等世界观 NPC 污染。
  async function _syncHSTargets() {
    const hs = _getHS();
    if (!hs) return;
    if (!Array.isArray(hs.targets)) {
      hs.targets = [];
      try { await _saveHS(); } catch(_) {}
    }
  }

function _clampHSDiff(v, max = 5) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    const clamped = Math.max(-max, Math.min(max, n));
    if (clamped !== n) console.warn(`[HeartSim] relation数值超过单次±${max}，已修正：${n} -> ${clamped}`);
    return clamped;
  }

function hsApplyRelation(relationObj) {
    const hs = _getHS();
    if (!hs || !relationObj) return;
    let changed = false;
    for (const [name, data] of Object.entries(relationObj)) {
      if (!name || !data) continue;
      let t = hs.targets.find(x => x.name === name);
      if (!t) {
        t = { name, baseFavor: 20, favor: 0, dark: 30 };
        hs.targets.push(t);
        changed = true;
      }
      const affinityRaw = data.affinity ?? data.favor ?? data.favour;
      const darknessRaw = data.darkness ?? data.dark;
      if (affinityRaw !== undefined) {
        const affinity = _clampHSDiff(affinityRaw, 2);
        if (affinity !== 0) {
          t.favor = Math.max(-t.baseFavor, Math.min(100 - t.baseFavor, (t.favor || 0) + affinity));
          changed = true;
        }
      }
      if (darknessRaw !== undefined) {
        const darkness = _clampHSDiff(darknessRaw, 5);
        if (darkness !== 0) {
          t.dark = Math.max(0, Math.min(100, (t.dark || 0) + darkness));
          changed = true;
        }
      }
    }
    if (changed) _saveHS();
    _renderHS();
    // 好感度/黑化值变化后检查通关条件
    if (changed) { try { Phone?.checkAndNotifyHomeReady?.(); } catch(_) {} }
  }

  // v687.41b：多人囚禁结局——全员黑化直接拉满100（绕过 clamp 限制）
  // 由 chat.js 收到 parsed.prisonAll 时调用
  function hsPrisonAll() {
    const hs = _getHS();
    if (!hs || !Array.isArray(hs.targets) || hs.targets.length === 0) return;
    let changed = false;
    for (const t of hs.targets) {
      if ((t.dark || 0) < 100) {
        t.dark = 100;
        changed = true;
      }
    }
    if (changed) {
      _saveHS();
      _renderHS();
    }
  }

  // 任务批次结清通知：active 从 >0 变 0 时标记，供任务面板快照告知 AI 下轮可发新任务
  // 不再通过 Phone.pushLog 写入手机操作记录（任务状态面板快照每轮已含此信息）
  function _notifyTaskBatchClearedIfNeeded(hs) {
    if (!hs) return;
    const activeNow = (hs.tasks || []).filter(t => (t.status || 'active') === 'active').length;
    if (activeNow === 0) {
      if (!hs._taskBatchNoticed) {
        hs._taskBatchNoticed = true;
      }
    } else {
      // 一旦又有 active 任务（新批次发布），重置通知标记，下次清空再发一次
      if (hs._taskBatchNoticed) hs._taskBatchNoticed = false;
    }
  }

  // 处理 AI 输出的 phone-lock 指令：char 锁/解锁手机（含状态面板）
  // 锁定后 hs.phoneLock = { lockedBy, reason, since }；解锁置 null。
  function hsApplyPhoneLock(lockObj) {
    if (!_isHeartSim()) return;
    const hs = _getHS();
    if (!hs || !lockObj || !lockObj.status) return;
    if (lockObj.status === 'locked') {
      // 至少要有锁机者；不在 targets 也允许（可能是新出现的角色，但通常是 targets 里的）
      const by = String(lockObj.by || '').trim() || '心动目标';
      hs.phoneLock = {
        lockedBy: by,
        reason: String(lockObj.reason || '').trim(),
        since: Date.now()
      };
      try { _saveHS(); } catch(_) {}
      try { UI.showToast?.(`${by}收走了你的手机`, 2500); } catch(_) {}
      // 如果手机正开着，立刻关掉
      try { if (window.Phone && Phone.isOpen && Phone.isOpen() && Phone.close) Phone.close(); } catch(_) {}
      // 直接隐藏 fab（close 内部已处理，但万一手机未开 fab 还在）
      try { document.getElementById('phone-fab')?.classList.add('hidden'); } catch(_) {}
      _renderHS();
    } else if (lockObj.status === 'unlocked') {
      const prevBy = hs.phoneLock?.lockedBy || '';
      hs.phoneLock = null;
      try { _saveHS(); } catch(_) {}
      try { UI.showToast?.(prevBy ? `${prevBy}把手机还给你了` : '手机解锁', 2000); } catch(_) {}
      // 解锁时让 fab 重新出现
      try {
        const fab = document.getElementById('phone-fab');
        if (fab && (!window.Phone || !Phone.isOpen || !Phone.isOpen())) fab.classList.remove('hidden');
      } catch(_) {}
      _renderHS();
    }
  }

  // 查询当前手机是否被锁
  function isPhoneLocked() {
    try {
      if (!_isHeartSim()) return false;
      const hs = _getHS();
      return !!(hs && hs.phoneLock && hs.phoneLock.lockedBy);
    } catch(_) { return false; }
  }

  function getPhoneLockInfo() {
    try {
      if (!_isHeartSim()) return null;
      const hs = _getHS();
      return hs && hs.phoneLock ? { ...hs.phoneLock } : null;
    } catch(_) { return null; }
  }

  // 用户兜底：紧急强制解锁（破沉浸开关，藏在设置里）
  async function hsForceUnlockPhone() {
    if (!_isHeartSim()) return;
    const hs = _getHS();
    if (!hs || !hs.phoneLock) { UI.showToast?.('手机当前未锁'); return; }
    const ok = await UI.showConfirm(
      '强制解锁手机',
      `当前手机被「${hs.phoneLock.lockedBy}」锁定。\n强制解锁会破坏沉浸感，仅在剧情卡死时使用。\n确定继续？`
    );
    if (!ok) return;
    hs.phoneLock = null;
    try { _saveHS(); } catch(_) {}
    UI.showToast?.('已强制解锁', 1500);
    _renderHS();
  }

  // 处理 AI 回复的 task 列表
  function hsApplyTasks(tasksArr) {
    const hs = _getHS();
    if (!hs || !Array.isArray(tasksArr)) return;

    const activeBefore = (hs.tasks || []).filter(x => x.status === 'active');
    const hadActiveBefore = activeBefore.length > 0;
    let changed = false;
    let addedActive = 0;

    // 第一步：先处理已有任务的状态变化。AI 省略旧任务 = 不改变旧任务状态。
    tasksArr.forEach(t => {
      if (!t) return;
      const text = String(t.text || '').trim();
      const id = t.id || '';
      const status = t.status || '';
      const existing = hs.tasks.find(x => (id && x.id === id) || (text && x.text === text));
      if (!existing) return;

      if (status === 'done' && existing.status !== 'done') {
        existing.status = 'done';
        hs.score++;
        changed = true;
      } else if (status === 'skipped' && existing.status !== 'skipped') {
        existing.status = 'skipped';
        hs.score--;
        changed = true;
      } else if (status && status !== 'active' && existing.status !== status) {
        existing.status = status;
        changed = true;
      }
    });

    // 第二步：清理已结算任务。done/skipped 只作为本轮结算事件，不再长期保存/发送给 AI。
    const beforeCleanLen = hs.tasks.length;
    hs.tasks = (hs.tasks || []).filter(t => (t.status || 'active') === 'active');
    if (hs.tasks.length !== beforeCleanLen) changed = true;

    // 第三步：新增 active 任务。若本轮开始时还有 active，则本轮禁止新增，必须下一轮再发。
    if (!hadActiveBefore) {
      tasksArr.forEach(t => {
        if (!t || t.status !== 'active') return;
        const text = String(t.text || '').trim();
        if (!text) return;
        const exists = hs.tasks.find(x => (t.id && x.id === t.id) || x.text === text);
        if (exists) return;
        if (addedActive >= 3) {
          console.warn('[HeartSim] 本轮新任务超过3条，已忽略:', text);
          return;
        }
        hs.tasks.push({
          id: t.id || ('t_' + Date.now() + '_' + Math.random().toString(36).slice(2,5)),
          text,
          type: t.type || 'free',
          status: 'active'
        });
        addedActive++;
        changed = true;
      });
    } else {
      const blocked = tasksArr.filter(t => t && t.status === 'active' && !hs.tasks.find(x => (t.id && x.id === t.id) || (t.text && x.text === t.text)));
      if (blocked.length) {
        console.warn('[HeartSim] 本轮开始时仍有 active 任务，已拒绝新增任务，需下一轮再发布:', blocked.map(t => t.text).join(' / '));
      }
    }

    if (changed) _saveHS();
    _notifyTaskBatchClearedIfNeeded(hs);
    _renderHS();
  }

  // 兜底：以最新一条 AI 回复为唯一真相，重建任务栏。
  // 不动积分（避免重复加减），done/skipped 直接丢弃，只保留 active。
  async function hsRefreshTasksFromLatestAI() {
    const hs = _getHS();
    if (!hs) { UI.showToast?.('当前不是心动模拟'); return; }
    if (typeof Chat === 'undefined' || !Chat.getMessages) { UI.showToast?.('Chat 未就绪'); return; }

    const ok = await UI.showConfirm(
      '同步任务栏',
      '将以最新一条AI回复为唯一真相，重建任务栏：\n\n' +
      '· 清空当前所有任务\n' +
      '· 只保留最新回复中标为 active 的任务（最多3条）\n' +
      '· 已完成/跳过的任务直接丢弃，不重新加减积分\n\n' +
      '这是兜底机制，仅在任务栏卡 bug 时使用。\n确定继续？'
    );
    if (!ok) return;

    const msgs = Chat.getMessages() || [];
    let latestAI = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        latestAI = m; break;
      }
    }
    if (!latestAI) { UI.showToast?.('没有找到 AI 回复'); return; }

    let parsed = null;
    try { parsed = Utils.parseAIOutput(latestAI.content); } catch(e) { console.warn('[HeartSim] 解析失败', e); }
    const tasksArr = (parsed && Array.isArray(parsed.tasks)) ? parsed.tasks : [];

    const activeTasks = tasksArr
      .filter(t => t && (t.status || 'active') === 'active' && String(t.text || '').trim())
      .slice(0, 3)
      .map(t => ({
        id: t.id || ('t_' + Date.now() + '_' + Math.random().toString(36).slice(2,5)),
        text: String(t.text).trim(),
        type: t.type || 'free',
        status: 'active'
      }));

    const before = (hs.tasks || []).length;
    hs.tasks = activeTasks;
    await _saveHS();
    _notifyTaskBatchClearedIfNeeded(hs);
    _renderHS();

    UI.showToast?.(`已同步：清掉 ${before} 条，重建 ${activeTasks.length} 条 active`);
  }

  // 跳过任务
 async function hsSkipTask(idx, needConfirm = true) {
 const hs = _getHS();
 if (!hs || !hs.tasks[idx] || hs.tasks[idx].status !== 'active') return;
 const taskText = hs.tasks[idx].text;
 if (needConfirm && !await UI.showConfirm('跳过任务', `跳过「${taskText}」？\n积分 -1`)) return;
 hs.score--;
 // 完成/跳过后的任务不再长期保存，避免继续喂给 AI；任务栏只保存当前未完成 active
 hs.tasks.splice(idx, 1);
 //通过操作日志通知 AI
 if (window.Phone && Phone.pushLog) {
 Phone.pushLog(`跳过了任务：${taskText}`);
 }
 _saveHS();
 _notifyTaskBatchClearedIfNeeded(hs);
 _renderHS();
 }

 function hsCloseSkipModal() {
 _hsSkipSelectedIdx = null;
 document.getElementById('hs-skip-modal')?.remove();
 }

 function hsSelectSkipTask(idx) {
 _hsSkipSelectedIdx = idx;
 const modal = document.getElementById('hs-skip-modal');
 if (!modal) return;
 modal.querySelectorAll('.hs-skip-choice').forEach(btn => {
 btn.classList.toggle('selected', String(btn.dataset.idx) === String(idx));
 });
 const confirmBtn = modal.querySelector('#hs-skip-confirm');
 if (confirmBtn) confirmBtn.disabled = false;
 }

 function hsConfirmSkipTask() {
 if (_hsSkipSelectedIdx === null || _hsSkipSelectedIdx === undefined) return;
 const idx = _hsSkipSelectedIdx;
 hsCloseSkipModal();
 hsSkipTask(idx, false);
 }

 function hsOpenSkipModal() {
 const hs = _getHS();
 const active = (hs?.tasks || []).map((t, idx) => ({ ...t, idx })).filter(t => t.status === 'active');
 _hsSkipSelectedIdx = null;
 document.getElementById('hs-skip-modal')?.remove();
 const modal = document.createElement('div');
 modal.id = 'hs-skip-modal';
 modal.className = 'hs-skip-modal';
 modal.onclick = () => hsCloseSkipModal();
 const listHtml = active.length ? active.map(t => `
 <button class="hs-skip-choice" data-idx="${t.idx}" onclick="event.stopPropagation();StatusBar.hsSelectSkipTask(${t.idx});">
 <span class="hs-skip-choice-dot"></span>
 <span class="hs-skip-choice-text">${_esc(t.text)}</span>
 <span class="hs-skip-choice-type">${t.type === 'daily' ? '日常' : '自由'}</span>
 </button>
 `).join('') : '<div class="hs-skip-empty">暂无可跳过任务</div>';
 modal.innerHTML = `
 <div class="hs-skip-dialog" onclick="event.stopPropagation()">
 <div class="hs-skip-title">选择要跳过的任务</div>
 <div class="hs-skip-hint">跳过任务会扣除1 积分哦。</div>
 <div class="hs-skip-list">${listHtml}</div>
 <div class="hs-skip-actions">
 <button class="hs-skip-cancel" onclick="event.stopPropagation();StatusBar.hsCloseSkipModal();">取消</button>
 <button class="hs-skip-confirm" id="hs-skip-confirm" ${active.length ? 'disabled' : 'disabled'} onclick="event.stopPropagation();StatusBar.hsConfirmSkipTask();">确认</button>
 </div>
 </div>
 `;
 document.body.appendChild(modal);
 }

  // 手动添加心动目标
 async function hsAddTarget() {
 const name = await UI.showSimpleInput('添加心动目标', '');
 if (!name || !name.trim()) return;
 const hs = _getHS();
 if (!hs) return;
 if (hs.targets.find(t => t.name === name.trim())) { UI.showToast('已存在'); return; }
 hs.targets.push({ name: name.trim(), baseFavor:20, favor:0, dark:30 });
 _saveHS();
 _renderHS();
 }

  // 手动删除心动目标
  async function hsRemoveTarget(idx) {
    const hs = _getHS();
    if (!hs || !hs.targets[idx]) return;
    const t = hs.targets[idx];
    const totalFavor = t.baseFavor + t.favor;
    if (!await UI.showConfirm('删除心动目标', `确定删除「${t.name}」？\n当前好感 ${totalFavor}，黑化 ${t.dark}\n此操作不可撤销！`)) return;
    hs.targets.splice(idx, 1);
    _saveHS();
    _renderHS();
  }

  // 编辑初始好感度
 async function hsEditBaseFavor(idx) {
 const hs = _getHS();
 if (!hs || !hs.targets[idx]) return;
 const t = hs.targets[idx];
 const val = await UI.showSimpleInput(`${t.name} 的初始好感度`, String(t.baseFavor));
 if (val === null) return;
 const num = parseInt(val);
 if (isNaN(num) || num <0 || num >100) { UI.showToast('请输入0-100 的数字'); return; }
 t.baseFavor = num;
 //重新 clamp favor
t.favor = Math.max(-t.baseFavor, Math.min(100 - t.baseFavor, t.favor));
_saveHS();
_renderHS();
try { Phone?.checkAndNotifyHomeReady?.(); } catch(_) {}
}

  async function _saveHS() {
    try { await Conversations.setStatusBar(_currentStatus); } catch(_) {}
  }

  function _renderHS() {
    const container = _el('sb-heartsim');
    if (!container) return;
    const isHS = _isHeartSim();
    if (!isHS) { container.classList.add('hidden'); return; }
    container.classList.remove('hidden');

    const hs = _getHS();

    // 锁定遮罩管理：不替换 innerHTML，避免 hs-tasks/hs-targets 等写死节点丢失
    let lockEl = document.getElementById('hs-locked-overlay');
    if (hs && hs.phoneLock && hs.phoneLock.lockedBy) {
      const by = _esc(hs.phoneLock.lockedBy);
      const reason = hs.phoneLock.reason ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:8px;line-height:1.6;max-width:280px;text-align:center">${_esc(hs.phoneLock.reason)}</div>` : '';
      const html = `
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5;margin-bottom:14px"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <div style="font-size:15px;color:var(--text);font-weight:600">心动模拟面板已被锁定</div>
        <div style="font-size:13px;margin-top:6px;color:var(--text-secondary)">锁定者：<strong style="color:var(--accent)">${by}</strong></div>
        ${reason}`;
      if (!lockEl) {
        lockEl = document.createElement('div');
        lockEl.id = 'hs-locked-overlay';
        lockEl.style.cssText = 'position:absolute;inset:0;background:var(--bg);z-index:50;padding:48px 16px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;border-radius:inherit';
        // 保证父容器有定位上下文
        const cs = getComputedStyle(container);
        if (cs.position === 'static') container.style.position = 'relative';
        container.appendChild(lockEl);
      }
      // 锁定时让被覆盖的子节点 display:none，避免它们仍参与展开态的 layout（17w 长会话下 toggle 会卡）
      container.classList.add('hs-locked');
      // 紧急强制解锁：双击右下角小点（藏起来，避免破坏沉浸感）
      lockEl.innerHTML = html + `<div title="双击紧急解锁（破沉浸）" ondblclick="event.stopPropagation();StatusBar.hsForceUnlockPhone()" style="position:absolute;right:8px;bottom:8px;width:10px;height:10px;border-radius:50%;background:var(--text-secondary);opacity:0.15;cursor:pointer"></div>`;
      return;
    } else if (lockEl) {
      lockEl.remove();
      container.classList.remove('hs-locked');
    }

    // 心动目标为空时保持为空；目标只由 relation 输出、已有存档或手动添加产生。
    if (!hs) return;

// 历史迁移：旧版本会长期保存 done/skipped，导致每轮继续发给 AI；现在任务栏只保留 active
if (Array.isArray(hs.tasks)) {
  const beforeLen = hs.tasks.length;
  hs.tasks = hs.tasks.filter(t => (t.status || 'active') === 'active');
  if (hs.tasks.length !== beforeLen) _saveHS();
}

// 积分
 const scoreEl = _el('hs-score');
 const scorePercentEl = _el('hs-score-percent');
 const barEl = _el('hs-score-bar');
 const scorePercent = Math.min(100, Math.max(0, hs.score /20 *100));
 if (scoreEl) scoreEl.textContent = `${hs.score} /20`;
 if (scorePercentEl) scorePercentEl.textContent = `${Math.round(scorePercent)}%`;
 if (barEl) barEl.style.width = scorePercent + '%';
 const skipBtn = _el('hs-skip-btn');
 if (skipBtn) skipBtn.disabled = !hs.tasks.some(t => t.status === 'active');

    //任务列表（只展示 active；done/skipped 已做完或跳过的任务不再堆在面板上）
    const tasksEl = _el('hs-tasks');
    if (tasksEl) {
      let html = '';
      const activeTasks = (hs.tasks || []).filter(t => t.status === 'active');
      activeTasks.slice(-6).forEach((t) => {
        const typeTag = t.type === 'daily' ? '日常' : '自由';
        html += `<div class="hs-task-item active">
          <span class="hs-task-dot"></span>
          <span class="hs-task-type">${typeTag}</span>
 <span class="hs-task-text">${_esc(t.text)}</span>
 </div>`;
 });
 if (!html) html = '<div class="hs-task-empty">暂无任务</div>';
 tasksEl.innerHTML = html;
 }

    // 心动目标
 const targetsEl = _el('hs-targets');
 if (targetsEl) {
 const editIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;
 const deleteIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
 targetsEl.innerHTML = hs.targets.length ? hs.targets.map((t, i) => {
 const totalFavor = Math.max(0, Math.min(100, t.baseFavor + t.favor));
 const dark = Math.max(0, Math.min(100, t.dark));
 const darkClass = dark >=80 ? 'danger' : dark >=60 ? 'high' : dark >=40 ? 'mid' : 'low';
 return `<div class="hs-target-card">
 <div class="hs-target-top">
 <div class="hs-target-name">${_esc(t.name)}</div>
 <div class="hs-target-actions">
 <button class="hs-target-action edit" onclick="event.stopPropagation();StatusBar.hsEditBaseFavor(${i})" title="编辑初始好感">${editIcon}</button>
 <button class="hs-target-action delete" onclick="event.stopPropagation();StatusBar.hsRemoveTarget(${i})" title="删除">${deleteIcon}</button>
 </div>
 </div>
 <div class="hs-target-meter favor">
 <div class="hs-target-meter-head"><span>好感度 <em>初始 ${t.baseFavor}</em></span><strong>${totalFavor}/100</strong></div>
 <div class="hs-target-track"><div class="hs-target-fill" style="width:${totalFavor}%"></div></div>
 </div>
 <div class="hs-target-meter dark ${darkClass}">
 <div class="hs-target-meter-head"><span>黑化值</span><strong>${dark}/100</strong></div>
 <div class="hs-target-track"><div class="hs-target-fill" style="width:${dark}%"></div></div>
 </div>
 </div>`;
 }).join('') : '<div class="hs-target-empty" onclick="event.stopPropagation();StatusBar.hsAddTarget()">暂无心动目标 · 点击添加</div>';
 _refreshTargetDots(hs.targets.length);
 }

    // 通关条件
    const condEl = _el('hs-conditions');
    if (condEl) {
      const targets = hs.targets;
      const maxFavor = targets.length > 0 ? targets.filter(t => (t.baseFavor + t.favor) >= 100).length : 0;
      const allAbove60 = targets.length > 0 ? targets.filter(t => (t.baseFavor + t.favor) >= 60).length : 0;
      const allDarkBelow90 = targets.length > 0 ? targets.filter(t => t.dark < 90).length : 0;
      const tc = targets.length || 1;

      const c1 = hs.score >= 20;
      const c2 = maxFavor >= 1;
      const c3 = allAbove60 >= tc;
      const c4 = allDarkBelow90 >= tc;

      condEl.innerHTML = `
 <div class="hs-clear-item ${c1 ? 'done' : ''}">
 <span class="hs-clear-dot"></span><span class="hs-clear-text">任务积分 ≥20</span><span class="hs-clear-count">${hs.score}/20</span>
 </div>
 <div class="hs-clear-item ${c2 ? 'done' : ''}">
 <span class="hs-clear-dot"></span><span class="hs-clear-text">至少1 位好感 ≥100</span><span class="hs-clear-count">${maxFavor}/1</span>
 </div>
 <div class="hs-clear-item ${c3 ? 'done' : ''}">
 <span class="hs-clear-dot"></span><span class="hs-clear-text">所有心动目标好感 ≥60</span><span class="hs-clear-count">${allAbove60}/${tc}</span>
 </div>
 <div class="hs-clear-item ${c4 ? 'done' : ''}">
 <span class="hs-clear-dot"></span><span class="hs-clear-text">所有目标黑化 &lt;90</span><span class="hs-clear-count">${allDarkBelow90}/${tc}</span>
 </div>
 <div class="hs-clear-summary ${c1 && c2 && c3 && c4 ? 'complete' : ''}">
 ${c1 && c2 && c3 && c4 ? '通关条件已达成' : `还差 ${[c1,c2,c3,c4].filter(x => !x).length} 项即可通关`}
 </div>
 `;
    }
  }

  // 心动模拟：判定回家/通关条件
// 返回 { passed: bool, reasons: string[] }
// 条件（来自 heartsim.json）：
//   1) 至少 1 位心动目标好感度 ≥ 100
//   2) 所有心动目标好感度 ≥ 60
//   3) 所有心动目标黑化值 < 90
//   4) 任务积分 ≥ 20
  function hsCheckClearCondition() {
    const reasons = [];
    if (!_isHeartSim()) return { passed: false, reasons: ['非心动模拟世界观'] };
    const hs = _getHS();
    if (!hs) return { passed: false, reasons: ['无心动模拟数据'] };

    const targets = Array.isArray(hs.targets) ? hs.targets : [];
    const score = Number.isFinite(Number(hs.score)) ? Number(hs.score) : 0;

    if (targets.length === 0) {
      reasons.push('还没有任何心动目标');
    } else {
      // 计算每位的最终好感度
      const withFavor = targets.map(t => ({
        name: t.name || '未命名',
        favor: Math.max(0, Math.min(100, (Number(t.baseFavor)||20) + (Number(t.favor)||0))),
        dark: Math.max(0, Math.min(100, Number(t.dark)||0)),
      }));

      // 条件1：至少一位好感度 ≥ 100
      const someAt100 = withFavor.some(t => t.favor >= 100);
      if (!someAt100) reasons.push('还没有任何心动目标的好感度达到 100');

      // 条件2：所有好感度 ≥ 60
      const lowFavor = withFavor.filter(t => t.favor < 60);
      if (lowFavor.length > 0) {
        reasons.push(`还有 ${lowFavor.length} 位心动目标的好感度未达 60（${lowFavor.map(t=>t.name).join('、')}）`);
      }

      // 条件3：所有黑化值 < 90
      const highDark = withFavor.filter(t => t.dark >= 90);
      if (highDark.length > 0) {
        reasons.push(`${highDark.map(t=>t.name).join('、')} 的黑化值已超过 90，需要先安抚`);
      }
    }

    // 条件4：任务积分 ≥ 20
    if (score < 20) reasons.push(`任务积分还差 ${20 - score} 分`);

    return { passed: reasons.length === 0, reasons };
  }

  // 心动模拟累计状态 — 返回每轮注入给 AI 的提示词
  function hsFormatForPrompt() {
    if (!_isHeartSim()) return '';
    const hs = _getHS();
    if (!hs) return '';

    // 手机已被锁定：不再发送心动模拟的具体数值（用户也看不到，避免 AI 还在用数值思考）
    // 只告诉 AI 当前处于"已锁手机"状态，让剧情围绕囚禁/控制展开，AI 想解除就用 status: unlocked
    if (hs.phoneLock && hs.phoneLock.lockedBy) {
      const lines = [];
      lines.push('【心动模拟·已锁定状态】');
      lines.push(`手机和心动模拟面板已被「${hs.phoneLock.lockedBy}」锁定。`);
      if (hs.phoneLock.reason) lines.push(`锁定缘由：${hs.phoneLock.reason}`);
      lines.push('');
      lines.push('规则：');
      lines.push(`- 当前处于囚禁/失控剧情中，用户已经无法查看手机和心动模拟面板。`);
      lines.push(`- 不再向 AI 暴露好感度/黑化值/任务等数值，本轮也不要继续输出 relation/tasks 代码块。`);
      lines.push(`- 请围绕「${hs.phoneLock.lockedBy}」的占有/控制/独占来推进剧情。`);
      lines.push(`- 仅当「${hs.phoneLock.lockedBy}」主动将手机归还给{{user}}，或{{user}}通过自己的行动成功拿回手机时，才在该轮回复末尾输出：\n\`\`\`phone-lock\nstatus: unlocked\n\`\`\`\n以解锁面板。不要因为场景切换、时间跳跃、气氛缓和等原因自动解锁——只有上述两种情况才可以。`);
      return lines.join('\n');
    }

    const lines = [];
    const score = Number.isFinite(Number(hs.score)) ? Number(hs.score) : 0;
    lines.push('【心动模拟当前状态】');
    lines.push(`任务积分：${score}/20`);

    const tasks = Array.isArray(hs.tasks) ? hs.tasks.filter(t => (t.status || 'active') === 'active') : [];
    lines.push('');
    lines.push('任务：');
    if (tasks.length) {
      tasks.forEach(t => {
        const type = t.type === 'daily' ? '日常' : '自由';
        lines.push(`- [active] [${type}] ${t.text || '未命名任务'}`);
      });
    } else {
      lines.push('- 暂无 active 任务；允许本轮发布新的 active 任务，最多3条。');
    }

    const targets = Array.isArray(hs.targets) ? hs.targets : [];
    lines.push('');
    lines.push('心动目标：');
    if (targets.length) {
      targets.forEach(t => {
        const base = Number.isFinite(Number(t.baseFavor)) ? Number(t.baseFavor) : 20;
        const diff = Number.isFinite(Number(t.favor)) ? Number(t.favor) : 0;
        const favor = Math.max(0, Math.min(100, base + diff));
        const dark = Math.max(0, Math.min(100, Number.isFinite(Number(t.dark)) ? Number(t.dark) : 0));
        const diffText = diff >= 0 ? `+${diff}` : String(diff);
        lines.push(`- ${t.name || '未命名'}：好感度 ${favor}/100（初始${base}，增量${diffText}），黑化值 ${dark}/100`);
      });
    } else {
      lines.push('- 暂无心动目标');
    }

    lines.push('');
    lines.push('规则：');
    lines.push('- 以上为当前累计状态，不是本轮增量。');
    lines.push('- AI 本轮输出 relation 时，只写本轮实际发生的变化。');
lines.push('- 任务栏只保存当前未完成的 active 任务；done/skipped 只作为本轮结算事件，系统加减积分后会自动从任务栏移除。');
lines.push('- 若当前仍有 active 任务，本轮禁止发布新的 active 任务，只能推进/完成/跳过现有任务；只有任务栏暂无 active 时，才允许发布新一批 active 任务，最多3条。');
lines.push('- 已完成/已跳过的任务不要长期重复输出，除非剧情中明确重新开启为新任务。');
lines.push('- 黑化值阈值：≥75 时开始铺垫危险征兆；≥80 时可以推动强行查看用户手机；≥100 时触发囚禁结局条件。');
return lines.join('\n');
  }

  // 黑化阈值检查 — 返回需要注入的提示词（供 chat.js 调用）
  // commit=true：实际发送链路调用，会打/清"已查手机"标记并保存；commit=false：调试预览，纯查询无副作用。
  // 80-99 区间每个 NPC 只触发一次"强制查手机"（_phoneCheckedAtDark 标记）；<80 自动清标记，回到80以上算新事件；100 触发囚禁结局，照常每轮发。
  function hsGetDarknessWarnings(commit = false) {
    if (!_isHeartSim()) return [];
    const hs = _getHS();
    if (!hs) return [];
    const warnings = [];
    let dirty = false;
    hs.targets.forEach(t => {
      const dark = Math.max(0, Math.min(100, t.dark));
      if (dark >= 100) {
        const locked = !!(hs.phoneLock && hs.phoneLock.lockedBy);
        if (locked) {
          warnings.push({ name: t.name, level: 'prison', text: `${t.name}的黑化值已达${dark}，且手机/心动面板已被「${hs.phoneLock.lockedBy}」锁定。请围绕囚禁/控制/独占推进剧情，本轮不要再输出 phone-lock 代码块（已是锁定状态）。\n仅当剧情发生重大转折（如归还手机、用户逃脱），才在该轮回复末尾输出：\n\`\`\`phone-lock\nstatus: unlocked\n\`\`\`` });
        } else {
          warnings.push({ name: t.name, level: 'prison', text:
`${t.name}的黑化值已达${dark}，已触发囚禁结局条件。请在本轮推动囚禁结局。

⚠️【强制系统规则·必须遵守】：
本轮如果你在叙事中描写了任何"${t.name}没收/收走/抢走/砸碎/锁起用户手机"或类似剥夺手机使用权的情节，那么你**必须**在本轮回复的最末尾追加这个代码块（不是可选的）：

\`\`\`phone-lock
status: locked
by: ${t.name}
reason: <一句话写明剧情原因，如"看到了搜索记录里的另一个名字"或"再也不允许你和外界联系"等>
\`\`\`

如果不输出这个代码块，叙事中的"锁手机"将不会真正生效，用户仍能正常使用手机和状态面板，剧情和系统状态会脱节。
反过来，如果本轮叙事还没演到锁手机这一步，就不要输出这个代码块。
"叙事描写锁手机" 与 "phone-lock 代码块" 必须同时发生，缺一不可。` });
        }
      } else if (dark >= 80) {
        const checkCount = typeof t._phoneCheckCount === 'number' ? t._phoneCheckCount : 0;
        if (checkCount < 2) {
          warnings.push({ name: t.name, level: 'phone', text: `${t.name}的黑化值已达${dark}（≥80），请在本轮合理推动${t.name}强行查看用户手机的情节。${checkCount === 1 ? '（第二轮：可以继续翻看更多内容、质问用户、或对看到的内容做出情绪反应）' : ''}` });
          if (commit) { t._phoneCheckCount = checkCount + 1; t._phoneCheckedAtDark = dark; dirty = true; }
        }
      } else if (dark >= 75) {
        warnings.push({ name: t.name, level: 'warn', text: `${t.name}的黑化值已达${dark}（接近80），请开始铺垫${t.name}想要查看用户手机的征兆。` });
        if (commit && (typeof t._phoneCheckedAtDark === 'number' || typeof t._phoneCheckCount === 'number')) { delete t._phoneCheckedAtDark; delete t._phoneCheckCount; dirty = true; }
      } else {
        if (commit && (typeof t._phoneCheckedAtDark === 'number' || typeof t._phoneCheckCount === 'number')) { delete t._phoneCheckedAtDark; delete t._phoneCheckCount; dirty = true; }
      }
    });
    if (dirty) { try { _saveHS(); } catch(_) {} }
    return warnings;
  }

  // 对话切换时调用
  function refreshFromConv() {
    try {
      const s = Conversations.getStatusBar();
      render(s);
      // 心动模拟不再从世界观 NPC 自动同步目标，避免跨世界观 NPC 污染。
    } catch(e) { render(null); }
  }

  return {
    render, toggle, editField, editEnv, editCustomAttr, editCharacterAttr, applyCustomAttrsDelta, formatCustomAttrsForPrompt, formatCustomAttrsFormatPrompt, formatCustomAttrsStatePrompt, editNPC, addNPC, deleteNPC, saveEdit, closeEdit, refreshFromConv, toggleNpcs,
    _clearNpcAvatarCache,
    // 通用任务系统
    taskApply, taskSkip, taskReset, taskRefreshFromLatestAI, taskFormatForPrompt,
    taskOpenSkipModal, taskCloseSkipModal, taskSelectSkipTask, taskConfirmSkipTask,
    // 心动模拟
    hsApplyRelation, hsApplyTasks, hsApplyPhoneLock, hsPrisonAll, hsSkipTask, hsRefreshTasksFromLatestAI, hsOpenSkipModal, hsCloseSkipModal, hsSelectSkipTask, hsConfirmSkipTask, hsAddTarget, hsRemoveTarget, hsEditBaseFavor, hsGetDarknessWarnings, hsFormatForPrompt, hsCheckClearCondition,
    isPhoneLocked, getPhoneLockInfo, hsForceUnlockPhone,
    _syncHSTargets, _renderHS
  };
})();
