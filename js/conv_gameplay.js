/**
 * ConvGameplay — 对话级玩法配置编辑器
 * 读写只碰 conv.convGameplay / conv.convEvents，和 worldview.js 零耦合
 */
const ConvGameplay = (() => {

  const _esc = (s) => Utils && Utils.escapeHtml ? Utils.escapeHtml(s) : (s || '');

  // ========== 工具函数 ==========

  function _getConv() {
    return Conversations.getList().find(c => c.id === Conversations.getCurrent()) || null;
  }

  async function _ensureConvEvents() {
    const conv = _getConv();
    if (!conv) return null;
    if (!conv.convEvents) {
      const wvId = conv.singleWorldviewId || conv.worldviewId || '';
      const wv = (wvId && wvId !== '__default_wv__') ? await DB.get('worldviews', wvId) : null;
      const hasEvents = wv && Array.isArray(wv.events) && wv.events.length > 0;
      const msg = hasEvents
        ? '将从世界观复制事件列表到当前对话。\n之后修改只影响本对话，不影响世界观原件。\n继续？'
        : '当前世界观无已有事件，将为本对话创建空白事件列表。\n继续？';
      if (!await UI.showConfirm('创建对话级事件配置', msg)) return null;
      conv.convEvents = hasEvents ? JSON.parse(JSON.stringify(wv.events)) : [];
      await Conversations.saveList();
    }
    return conv;
  }

  async function _saveConvEvents(events) {
    const conv = _getConv();
    if (!conv) return;
    conv.convEvents = events;
    await Conversations.saveList();
  }

  // ========== 同步世界观功能 ==========

  // 同步属性：完全覆盖或追加模式
  async function syncAttrsFromWorldview(mode) {
    const conv = _getConv();
    if (!conv) return;
    const wvId = conv.singleWorldviewId || conv.worldviewId || '';
    const wv = (wvId && wvId !== '__default_wv__') ? await DB.get('worldviews', wvId) : null;
    if (!wv || !wv.gameplay) {
      UI.showToast('当前世界观无属性配置', 2000);
      return;
    }
    const wvGlobal = wv.gameplay.globalAttrs || [];
    const wvChar = wv.gameplay.characterAttrs || [];
    if (wvGlobal.length === 0 && wvChar.length === 0) {
      UI.showToast('世界观属性配置为空', 2000);
      return;
    }

    if (mode === 'replace') {
      // 完全覆盖：清空对话级数据，重置状态栏
      const msg = '完全覆盖模式将：\n· 清空对话级属性配置\n· 用世界观原件覆盖\n· 重置状态栏数值为初始值\n\n不可撤销，确定继续？';
      if (!await UI.showConfirm('完全覆盖属性', msg)) return;
      conv.convGameplay = JSON.parse(JSON.stringify(wv.gameplay));
      await Conversations.saveList();
      // 重置状态栏
      const sb = Conversations.getStatusBar() || {};
      sb.customAttrs = { global: {}, characters: {} };
      // 按初始值写入
      (conv.convGameplay.globalAttrs || []).forEach(a => {
        if (a && a.id) sb.customAttrs.global[a.id] = a.initial ?? 0;
      });
      (conv.convGameplay.characterAttrs || []).forEach(c => {
        const key = [c?.targetType || '', c?.targetId || '', c?.sourceWorldviewId || ''].join(':');
        sb.customAttrs.characters[key] = sb.customAttrs.characters[key] || {};
        (c.attrs || []).forEach(a => {
          if (a && a.id) sb.customAttrs.characters[key][a.id] = a.initial ?? 0;
        });
      });
      await Conversations.setStatusBar(sb);
      if (typeof StatusBar !== 'undefined' && StatusBar.refreshFromConv) StatusBar.refreshFromConv();
      UI.showToast('已完全覆盖属性配置', 2000);
    } else {
      // 追加模式：更新已有定义，追加新属性，不动状态栏当前值
      const msg = '追加覆盖模式将：\n· 更新已有属性的名称/描述/上限\n· 追加世界观新增的属性\n· 保留状态栏当前数值不变\n\n继续？';
      if (!await UI.showConfirm('追加覆盖属性', msg)) return;
      if (!conv.convGameplay) conv.convGameplay = { globalAttrs: [], characterAttrs: [], taskSystem: { phases: [] } };
      if (!Array.isArray(conv.convGameplay.globalAttrs)) conv.convGameplay.globalAttrs = [];
      if (!Array.isArray(conv.convGameplay.characterAttrs)) conv.convGameplay.characterAttrs = [];
      
      // 全局属性：按 id 合并（更新 name/desc/max，不动 initial）
      const convGlobalIds = new Set(conv.convGameplay.globalAttrs.map(a => a.id));
      wvGlobal.forEach(wvA => {
        const exist = conv.convGameplay.globalAttrs.find(a => a.id === wvA.id);
        if (exist) {
          exist.name = wvA.name;
          exist.desc = wvA.desc;
          exist.max = wvA.max;
          exist.overflowTo = wvA.overflowTo || '';
      exist.deriveTo = wvA.deriveTo || '';
      exist.deriveStep = wvA.deriveStep ?? '';
          // initial 不更新，保持对话自定义
        } else {
          conv.convGameplay.globalAttrs.push(JSON.parse(JSON.stringify(wvA)));
        }
      });

      // 角色属性：按 targetKey 合并
      const _key = (c) => [c?.targetType || '', c?.targetId || '', c?.sourceWorldviewId || ''].join(':');
      wvChar.forEach(wvC => {
        const k = _key(wvC);
        const exist = conv.convGameplay.characterAttrs.find(c => _key(c) === k);
        if (exist) {
          // 更新角色名、来源标签
          exist.targetName = wvC.targetName;
          exist.sourceLabel = wvC.sourceLabel;
          // 按 id 合并属性
          (wvC.attrs || []).forEach(wvA => {
            const eA = (exist.attrs || []).find(a => a.id === wvA.id);
            if (eA) {
              eA.name = wvA.name;
              eA.desc = wvA.desc;
              eA.max = wvA.max;
            } else {
              if (!Array.isArray(exist.attrs)) exist.attrs = [];
              exist.attrs.push(JSON.parse(JSON.stringify(wvA)));
            }
          });
        } else {
          conv.convGameplay.characterAttrs.push(JSON.parse(JSON.stringify(wvC)));
        }
      });

      await Conversations.saveList();
      // 状态栏：只给新属性写初始值，已有值不动
      const sb = Conversations.getStatusBar() || {};
      if (!sb.customAttrs) sb.customAttrs = { global: {}, characters: {} };
      if (!sb.customAttrs.global) sb.customAttrs.global = {};
      if (!sb.customAttrs.characters) sb.customAttrs.characters = {};
      conv.convGameplay.globalAttrs.forEach(a => {
        if (a && a.id && (sb.customAttrs.global[a.id] === undefined || sb.customAttrs.global[a.id] === null || sb.customAttrs.global[a.id] === '')) {
          sb.customAttrs.global[a.id] = a.initial ?? 0;
        }
      });
      conv.convGameplay.characterAttrs.forEach(c => {
        const k = _key(c);
        if (!sb.customAttrs.characters[k]) sb.customAttrs.characters[k] = {};
        (c.attrs || []).forEach(a => {
          if (a && a.id && (sb.customAttrs.characters[k][a.id] === undefined || sb.customAttrs.characters[k][a.id] === null || sb.customAttrs.characters[k][a.id] === '')) {
            sb.customAttrs.characters[k][a.id] = a.initial ?? 0;
          }
        });
      });
      await Conversations.setStatusBar(sb);
      if (typeof StatusBar !== 'undefined' && StatusBar.refreshFromConv) StatusBar.refreshFromConv();
      UI.showToast('已追加覆盖属性配置', 2000);
    }
  }

  // 同步事件：完全覆盖或追加模式
  async function syncEventsFromWorldview(mode) {
    const conv = _getConv();
    if (!conv) return;
    const wvId = conv.singleWorldviewId || conv.worldviewId || '';
    const wv = (wvId && wvId !== '__default_wv__') ? await DB.get('worldviews', wvId) : null;
    if (!wv || !Array.isArray(wv.events) || wv.events.length === 0) {
      UI.showToast('当前世界观无事件配置', 2000);
      return;
    }

    if (mode === 'replace') {
      // 完全覆盖：清空对话级事件和进度
      const msg = '完全覆盖模式将：\n· 清空对话级事件配置\n· 用世界观原件覆盖\n· 清空所有事件进度\n\n不可撤销，确定继续？';
      if (!await UI.showConfirm('完全覆盖事件', msg)) return;
      conv.convEvents = JSON.parse(JSON.stringify(wv.events));
      conv.eventStates = {};
      await Conversations.saveList();
      UI.showToast('已完全覆盖事件配置', 2000);
    } else {
      // 追加模式：更新已有事件定义，追加新事件，不动进度
      const msg = '追加覆盖模式将：\n· 更新已有事件的名称/内容/关键词\n· 追加世界观新增的事件\n· 保留事件进度不变\n\n继续？';
      if (!await UI.showConfirm('追加覆盖事件', msg)) return;
      if (!Array.isArray(conv.convEvents)) conv.convEvents = [];
      wv.events.forEach(wvE => {
        const exist = conv.convEvents.find(e => e.id === wvE.id);
        if (exist) {
          // 更新定义，不动进度
          exist.name = wvE.name;
          exist.content = wvE.content;
          exist.keys = wvE.keys;
          exist.completeKey = wvE.completeKey;
          exist.triggerType = wvE.triggerType;
          exist.attrConditions = wvE.attrConditions;
          exist.chainId = wvE.chainId;
          exist.chainName = wvE.chainName;
          exist.chainIndex = wvE.chainIndex;
        } else {
          conv.convEvents.push(JSON.parse(JSON.stringify(wvE)));
        }
      });
      await Conversations.saveList();
      UI.showToast('已追加覆盖事件配置', 2000);
    }
  }

  // 同步任务：完全覆盖或追加模式
  async function syncTasksFromWorldview(mode) {
    const conv = _getConv();
    if (!conv) return;
    const wvId = conv.singleWorldviewId || conv.worldviewId || '';
    const wv = (wvId && wvId !== '__default_wv__') ? await DB.get('worldviews', wvId) : null;
    if (!wv || !wv.gameplay || !wv.gameplay.taskSystem || !Array.isArray(wv.gameplay.taskSystem.phases) || wv.gameplay.taskSystem.phases.length === 0) {
      UI.showToast('当前世界观无任务配置', 2000);
      return;
    }

    if (mode === 'replace') {
      // 完全覆盖：清空对话级任务和进度
      const msg = '完全覆盖模式将：\n· 清空对话级任务配置\n· 用世界观原件覆盖\n· 清空任务进度\n\n不可撤销，确定继续？';
      if (!await UI.showConfirm('完全覆盖任务', msg)) return;
      if (!conv.convGameplay) conv.convGameplay = { globalAttrs: [], characterAttrs: [], taskSystem: { phases: [] } };
      conv.convGameplay.taskSystem = JSON.parse(JSON.stringify(wv.gameplay.taskSystem));
      await Conversations.saveList();
      // 重置任务进度
      const sb = Conversations.getStatusBar() || {};
      sb.taskSystem = { phaseIndex: 0, doneInPhase: 0, active: [], pendingPublish: false, finished: false };
      await Conversations.setStatusBar(sb);
      if (typeof StatusBar !== 'undefined' && StatusBar.refreshFromConv) StatusBar.refreshFromConv();
      UI.showToast('已完全覆盖任务配置', 2000);
    } else {
      // 追加模式：更新已有阶段定义，追加新阶段，不动进度
      const msg = '追加覆盖模式将：\n· 更新已有阶段的名称/类型/奖励\n· 追加世界观新增的阶段\n· 保留任务进度不变\n\n继续？';
      if (!await UI.showConfirm('追加覆盖任务', msg)) return;
      if (!conv.convGameplay) conv.convGameplay = { globalAttrs: [], characterAttrs: [], taskSystem: { phases: [] } };
      if (!conv.convGameplay.taskSystem) conv.convGameplay.taskSystem = { phases: [] };
      if (!Array.isArray(conv.convGameplay.taskSystem.phases)) conv.convGameplay.taskSystem.phases = [];
      
      wv.gameplay.taskSystem.phases.forEach(wvP => {
        const exist = conv.convGameplay.taskSystem.phases.find(p => p.id === wvP.id);
        if (exist) {
          // 更新定义
          exist.name = wvP.name;
          exist.batchSize = wvP.batchSize;
          exist.totalTasks = wvP.totalTasks;
          exist.completionReward = JSON.parse(JSON.stringify(wvP.completionReward || { mode: 'none', attr: '', value: 0, free: '' }));
          // types 也按 id 合并：更新已有、追加新增、保留对话自定义
          if (!Array.isArray(exist.types)) exist.types = [];
          (wvP.types || []).forEach(wvT => {
            const eT = exist.types.find(t => t.id === wvT.id);
            if (eT) {
              // 更新已有类型定义
              eT.label = wvT.label;
              eT.desc = wvT.desc;
              eT.rewardMode = wvT.rewardMode;
              eT.rewardAttr = wvT.rewardAttr;
              eT.rewardValue = wvT.rewardValue;
              eT.rewardFree = wvT.rewardFree;
            } else {
              // 追加世界观新增的类型
              exist.types.push(JSON.parse(JSON.stringify(wvT)));
            }
          });
        } else {
          conv.convGameplay.taskSystem.phases.push(JSON.parse(JSON.stringify(wvP)));
        }
      });
      await Conversations.saveList();
      UI.showToast('已追加覆盖任务配置', 2000);
    }
  }

  // ========== 事件卡片列表 ==========

  let _eventsData = [];
  let _eventTab = 'standalone'; // standalone | chain

  function _attrConditionSummary(ev) {
    const conds = Array.isArray(ev.attrConditions) ? ev.attrConditions : [];
    if (!conds.length) return '<span style="font-size:11px;color:var(--danger)">未设置数值条件</span>';
    return conds.map(c => {
      const prefix = c.scope === 'allCharacters' ? `所有角色(${c.matchMode === 'any' ? '任一' : '全部'}) / ` : (c.targetName ? c.targetName + ' / ' : '全局 / ');
      return `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${_esc(`${prefix}${c.attrName || '属性'} ${c.operator || '>='} ${c.value ?? 0}`)}</span>`;
    }).join('');
  }

  function _eventCardHtml(ev, i, extraHtml = '') {
    const triggerType = ev.triggerType || 'keyword';
    const keys = (ev.keys || '').trim();
    const keyTags = triggerType === 'attr' ? _attrConditionSummary(ev) : (keys
      ? keys.split(/[,，\s]+/).filter(Boolean).map(t => `<span style="display:inline-block;font-size:11px;background:var(--bg-secondary);color:var(--text-secondary);padding:2px 6px;border-radius:4px;margin-right:4px;margin-top:2px">${_esc(t)}</span>`).join('')
      : '<span style="font-size:11px;color:var(--danger)">未设置关键词</span>');
    const modeLabel = triggerType === 'attr' ? '数值触发' : (triggerType === 'time' ? '时间触发' : '关键词触发');
    const chainLabel = ev.chainId ? `<span style="font-size:10px;color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:1px 6px">链#${Number(ev.chainIndex || 0) + 1}</span>` : '';
    const completeKey = ev.completeKey ? `<span style="font-size:11px;color:var(--text-secondary)">结束词：${_esc(ev.completeKey)}</span>` : '<span style="font-size:11px;color:var(--danger)">未设置结束词</span>';
    return `<div style="position:relative;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer" onclick="ConvGameplay.editEvent(${i})">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg>
        <span style="font-size:14px;font-weight:bold;color:var(--accent)">${_esc(ev.name || '未命名事件')}</span>
        <span style="font-size:10px;color:var(--text-secondary);border:1px solid var(--border);border-radius:999px;padding:1px 6px">${modeLabel}</span>
        ${chainLabel}
      </div>
      ${extraHtml}
      <div style="margin-bottom:4px">${keyTags}</div>
      <div style="margin-bottom:4px">${completeKey}</div>
      ${ev.content ? `<div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(ev.content)}</div>` : ''}
    </div>`;
  }

  function _renderEventList() {
    const container = document.getElementById('cg-event-list');
    if (!container) return;

    if (_eventTab === 'chain') {
      const chainEvents = _eventsData.filter(e => e.chainId);
      if (!chainEvents.length) {
        container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:12px;border:1px dashed var(--border);border-radius:8px">暂无事件链，点击上方「新建事件链」或「AI生成事件链」</div>';
        return;
      }
      const groups = {};
      chainEvents.forEach((ev) => {
        const id = ev.chainId || '__none__';
        if (!groups[id]) groups[id] = { name: ev.chainName || '未命名事件链', events: [] };
        groups[id].events.push(ev);
      });
container.innerHTML = Object.keys(groups).map(chainId => {
        const g = groups[chainId];
        g.events.sort((a, b) => Number(a.chainIndex || 0) - Number(b.chainIndex || 0));
        // 拍摄链识别：组内任一事件带 shootWorkId，即为某部作品的「拍摄/制作期专属事件链」
        const _isShootChain = g.events.some(e => e && e.shootWorkId);
        const cards = g.events.map(ev => {
          const idx = _eventsData.indexOf(ev);
          const extra = `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">事件链：${_esc(g.name)} · 第 ${Number(ev.chainIndex || 0) + 1} 节</div>`;
          return _eventCardHtml(ev, idx, extra);
        }).join('');
        const _shootBadge = _isShootChain
          ? `<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:6px;background:var(--accent);color:#fff;font-size:10px;font-weight:600;vertical-align:middle">🎬 拍摄期专属</span>`
          : '';
        const _shootTip = _isShootChain
          ? `<div style="margin-bottom:10px;padding:9px 11px;border-radius:8px;background:color-mix(in srgb, var(--accent) 10%, transparent);border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);font-size:11px;color:var(--text-secondary);line-height:1.7">
              这是某部作品的<b style="color:var(--accent)">拍摄/制作期专属事件链</b>，由视频 App 生成。续写这条链时会<b>自动带上该作品的剧本资料</b>，保持剧组剧情。<br>这条链的所有节点都完成后，去<b>视频 App 打开这部作品 → 设置</b>里手动确认杀青/制作完成，即可申请上映/开播。
            </div>`
          : '';
        return `<div style="border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:14px;background:var(--bg-secondary)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
            <div>
              <div style="font-size:15px;font-weight:700;color:var(--accent)">${_esc(g.name)}${_shootBadge}</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${g.events.length} 个事件 · 通过上一事件结束词触发下一事件</div>
            </div>
            <button onclick="event.stopPropagation();ConvGameplay.openAiGenerate('appendChain','${_esc(chainId)}')" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--accent);font-size:12px;cursor:pointer;white-space:nowrap">续写</button>
          </div>
          ${_shootTip}
          ${cards}
          <button onclick="ConvGameplay.addChainNode('${_esc(chainId)}')" style="width:100%;margin-top:8px;padding:8px;border-radius:8px;border:1px dashed var(--border);background:none;color:var(--text-secondary);font-size:12px;cursor:pointer">+ 添加节点</button>
        </div>`;
      }).join('');
      return;
    }

    const standalone = _eventsData.map((ev, i) => ({ ev, i })).filter(x => !x.ev.chainId);
    if (!standalone.length) {
      container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:12px;border:1px dashed var(--border);border-radius:8px">暂无独立事件，点击下方添加或使用 AI 生成</div>';
      return;
    }
    container.innerHTML = standalone.map(({ ev, i }) => _eventCardHtml(ev, i)).join('');
  }

  function switchEventTab(tab) {
    _eventTab = tab === 'chain' ? 'chain' : 'standalone';
    const sBtn = document.getElementById('cg-event-tab-standalone');
    const cBtn = document.getElementById('cg-event-tab-chain');
    if (sBtn) {
      sBtn.style.background = _eventTab === 'standalone' ? 'var(--accent)' : 'transparent';
      sBtn.style.color = _eventTab === 'standalone' ? '#111' : 'var(--text-secondary)';
    }
    if (cBtn) {
      cBtn.style.background = _eventTab === 'chain' ? 'var(--accent)' : 'transparent';
      cBtn.style.color = _eventTab === 'chain' ? '#111' : 'var(--text-secondary)';
    }
    const aiBtn = document.getElementById('cg-event-ai-btn');
    const addBtn = document.getElementById('cg-event-add-btn');
    const _sparkSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>';
    if (aiBtn) aiBtn.innerHTML = _sparkSvg + (_eventTab === 'chain' ? ' AI生成事件链' : ' AI生成');
    if (addBtn) {
      if (_eventTab === 'chain') {
        addBtn.textContent = '+ 新建事件链';
        addBtn.setAttribute('onclick', 'ConvGameplay.addEventChain()');
      } else {
        addBtn.textContent = '+ 添加';
        addBtn.setAttribute('onclick', 'ConvGameplay.addEvent()');
      }
      addBtn.style.display = '';
    }
    _renderEventList();
  }

  // ========== 事件编辑弹窗 ==========

  let _editEventIdx = null;
  let _attrCondDraft = [];

  function _collectAttrOptions() {
    const conv = _getConv();
    const gp = conv?.convGameplay || null;
    // fallback 到世界观
    const opts = [];
    const seenAllCharNames = new Set();
    const doCollect = (gameplay) => {
      if (!gameplay) return;
      (gameplay.globalAttrs || []).filter(a => a && a.id && (a.name || '').trim()).forEach(a => {
        opts.push({ value: `global|||${a.id}`, scope: 'global', targetKey: '', targetName: '', attrId: a.id, attrName: a.name, label: `全局 / ${a.name}` });
      });
      (gameplay.characterAttrs || []).forEach(c => {
        const key = [c?.targetType || '', c?.targetId || '', c?.sourceWorldviewId || ''].join(':');
        (c.attrs || []).filter(a => a && a.id && (a.name || '').trim()).forEach(a => {
          opts.push({ value: `character||${key}||${a.id}`, scope: 'character', targetKey: key, targetName: c.targetName || '', attrId: a.id, attrName: a.name, label: `${c.targetName || '未命名角色'} / ${a.name}` });
          // 收集角色属性名，用于"所有角色"选项
          const nm = (a.name || '').trim();
          if (nm && !seenAllCharNames.has(nm)) {
            seenAllCharNames.add(nm);
            opts.push({ value: `allCharacters|||${nm}`, scope: 'allCharacters', targetKey: '', targetName: '', attrId: '', attrName: nm, label: `所有角色 / ${nm}` });
          }
        });
      });
    };
    doCollect(gp);
    if (!opts.length) {
      // fallback 到世界观 gameplay
      try {
        const wvId = conv?.singleWorldviewId || conv?.worldviewId || '';
        if (wvId) {
          // 同步方式无法读 DB，所以数值触发在对话级暂不支持 fallback
        }
      } catch(_) {}
    }
    return opts;
  }

  function _syncTriggerTypeUI() {
    const typeEl = document.getElementById('cg-event-trigger-type');
    const type = typeEl?.value || 'keyword';
    document.getElementById('cg-event-keyword-row')?.classList.toggle('hidden', type !== 'keyword');
    document.getElementById('cg-event-attr-row')?.classList.toggle('hidden', type !== 'attr');
    document.getElementById('cg-event-time-row')?.classList.toggle('hidden', type !== 'time');
    if (type === 'attr') {
      if (_attrCondDraft.length === 0) addAttrCondition();
      else _renderAttrConditions();
    }
  }
function _renderAttrConditions() {
    const box = document.getElementById('cg-event-attr-conditions');
    if (!box) return;
    const opts = _collectAttrOptions();
    if (!opts.length) {
      box.innerHTML = '<div style="font-size:12px;color:var(--danger);padding:10px;border:1px dashed var(--border);border-radius:8px">请先配置自定义属性（在世界观或对话级配置中）。</div>';
      return;
    }
    box.innerHTML = _attrCondDraft.map((c, i) => {
      const curVal = c.scope === 'allCharacters' ? `allCharacters|||${c.attrName || ''}` : (c.scope === 'character' ? `character||${c.targetKey || ''}||${c.attrId || ''}` : `global|||${c.attrId || ''}`);
      const optHtml = opts.map(o => `<option value="${_esc(o.value)}" ${o.value === curVal ? 'selected' : ''}>${_esc(o.label)}</option>`).join('');
      const isAll = c.scope === 'allCharacters';
      const matchModeHtml = isAll ? `<select onchange="ConvGameplay.updateAttrCondition(${i},'matchMode',this.value)" style="flex:1;min-width:0;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)"><option value="all" ${(c.matchMode || 'all') === 'all' ? 'selected' : ''}>全部满足</option><option value="any" ${c.matchMode === 'any' ? 'selected' : ''}>任一满足</option></select>` : '';
      return `<div style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">
        <div style="display:flex;gap:8px;margin-bottom:8px;align-items:flex-start">
          <select onchange="ConvGameplay.updateAttrCondition(${i},'attr',this.value)" style="flex:1;min-width:0;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)">${optHtml}</select>
          <button type="button" onclick="ConvGameplay.removeAttrCondition(${i})" style="width:32px;height:32px;border:1px solid var(--danger);background:none;border-radius:6px;color:var(--danger);cursor:pointer;flex-shrink:0">×</button>
        </div>
        ${isAll ? `<div style="display:flex;gap:8px;margin-bottom:8px">${matchModeHtml}</div>` : ''}
        <div style="display:flex;gap:8px;align-items:center">
          <select onchange="ConvGameplay.updateAttrCondition(${i},'operator',this.value)" style="width:60px;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)">${['>','>=','<','<=','==','!='].map(op => `<option value="${op}" ${c.operator === op ? 'selected' : ''}>${op}</option>`).join('')}</select>
          <input type="number" value="${_esc(String(c.value ?? 0))}" oninput="ConvGameplay.updateAttrCondition(${i},'value',this.value)" style="flex:1;min-width:0;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)">
        </div>
      </div>`;
    }).join('');
    _attrCondDraft.forEach((c, i) => {
      if (!c.attrId && !c.attrName && opts[0]) updateAttrCondition(i, 'attr', opts[0].value, true);
    });
  }

  function addAttrCondition() {
    const opts = _collectAttrOptions();
    if (!opts.length) { UI.showToast('请先配置自定义属性', 1800); return; }
    const o = opts[0];
    _attrCondDraft.push({ scope: o.scope, targetKey: o.targetKey, targetName: o.targetName, attrId: o.attrId, attrName: o.attrName, operator: '>=', value: 0 });
    _renderAttrConditions();
  }

  function updateAttrCondition(i, field, value, silent) {
    const c = _attrCondDraft[i];
    if (!c) return;
    if (field === 'attr') {
      const o = _collectAttrOptions().find(x => x.value === value);
      if (!o) return;
      Object.assign(c, { scope: o.scope, targetKey: o.targetKey, targetName: o.targetName, attrId: o.attrId, attrName: o.attrName });
      if (o.scope === 'allCharacters') { c.matchMode = c.matchMode || 'all'; }
      else { delete c.matchMode; }
    } else if (field === 'value') {
      c.value = Number(value);
    } else if (field === 'operator') {
      c.operator = value || '>=';
    } else if (field === 'matchMode') {
      c.matchMode = value || 'all';
    }
    if (!silent && (field === 'attr' || field === 'matchMode')) _renderAttrConditions();
  }

  function removeAttrCondition(i) {
    _attrCondDraft.splice(i, 1);
    _renderAttrConditions();
  }

  function editEvent(i) {
    _editEventIdx = i;
    const ev = _eventsData[i] || {};
    // v687.33：先显示弹窗，再赋值（某些浏览器 hidden 状态下 select 赋值不生效）
    document.getElementById('cg-event-modal').classList.remove('hidden');
    document.getElementById('cg-event-modal-title').textContent = ev.name ? '编辑事件' : '新建事件';
    // 事件链名称行：仅在事件属于链时显示
    const chainRow = document.getElementById('cg-event-chain-row');
    const chainNameEl = document.getElementById('cg-event-chain-name');
    if (chainRow) chainRow.classList.toggle('hidden', !ev.chainId);
    if (chainNameEl) chainNameEl.value = ev.chainName || '';
    document.getElementById('cg-event-name').value = ev.name || '';
    document.getElementById('cg-event-keys').value = ev.keys || '';
    const typeEl = document.getElementById('cg-event-trigger-type');
    if (typeEl) {
      typeEl.value = ev.triggerType || 'keyword';
      // 双保险：强制 selectedIndex 对齐
      if (typeEl.value !== (ev.triggerType || 'keyword')) {
        typeEl.selectedIndex = 0; // keyword 是第一个 option
      }
    }
    _attrCondDraft = Array.isArray(ev.attrConditions) ? JSON.parse(JSON.stringify(ev.attrConditions)) : [];
    // 时间触发字段回填
    const timeStartEl = document.getElementById('cg-event-time-start');
    const timeEndEl = document.getElementById('cg-event-time-end');
    if (timeStartEl) timeStartEl.value = ev.triggerTimeStart || '';
    if (timeEndEl) timeEndEl.value = ev.triggerTimeEnd || '';
    document.getElementById('cg-event-complete-key').value = ev.completeKey || '';
    document.getElementById('cg-event-finish-rule').value = ev.finishRule || '';
    document.getElementById('cg-event-content').value = ev.content || '';
    _syncTriggerTypeUI();
  }

  function addEvent() {
    _eventsData.push({
      id: 'evt_' + Utils.uuid().slice(0, 8),
      name: '', keys: '', triggerType: 'keyword', attrConditions: [],
      completeKey: '', finishRule: '', content: '', triggerMode: 'event'
    });
    editEvent(_eventsData.length - 1);
  }

  // 新建事件链：创建一条空链 + 第一个事件，并打开编辑
  function addEventChain() {
    const chainId = 'chain_' + Utils.uuid().slice(0, 8);
    const chainName = '新建事件链';
    _eventsData.push({
      id: 'evt_' + Utils.uuid().slice(0, 8),
      name: '', keys: '', triggerType: 'keyword', attrConditions: [],
      completeKey: '', finishRule: '', content: '', triggerMode: 'event',
      chainId, chainName, chainIndex: 0
    });
    _eventTab = 'chain';
    editEvent(_eventsData.length - 1);
  }

  // 在指定事件链尾部追加一个节点，自动把上一节点的结束词填入新节点关键词，保持链式衔接
  function addChainNode(chainId) {
    const chainEvents = _eventsData.filter(e => e.chainId === chainId).sort((a, b) => Number(a.chainIndex || 0) - Number(b.chainIndex || 0));
    if (!chainEvents.length) return;
    const last = chainEvents[chainEvents.length - 1];
    const nextIndex = Number(last.chainIndex || 0) + 1;
    _eventsData.push({
      id: 'evt_' + Utils.uuid().slice(0, 8),
      name: '', keys: last.completeKey || '', triggerType: 'keyword', attrConditions: [],
      completeKey: '', finishRule: '', content: '', triggerMode: 'event',
      chainId, chainName: last.chainName || '未命名事件链', chainIndex: nextIndex
    });
    editEvent(_eventsData.length - 1);
  }

  async function saveEvent() {
    if (_editEventIdx === null) return;
    const prev = _eventsData[_editEventIdx] || {};
    const triggerType = document.getElementById('cg-event-trigger-type')?.value || 'keyword';
    // 链名：若属于链，取输入框的值（改名同步整条链）
    const newChainName = prev.chainId ? ((document.getElementById('cg-event-chain-name')?.value || '').trim() || prev.chainName || '未命名事件链') : (prev.chainName || '');
    _eventsData[_editEventIdx] = {
      id: prev.id || ('evt_' + Utils.uuid().slice(0, 8)),
      name: document.getElementById('cg-event-name').value.trim(),
      keys: triggerType === 'keyword' ? document.getElementById('cg-event-keys').value.trim() : '',
      triggerType,
      attrConditions: triggerType === 'attr' ? _attrCondDraft.filter(c => c && (c.attrId || c.attrName) && Number.isFinite(Number(c.value))).map(c => ({ ...c, value: Number(c.value), operator: c.operator || '>=' })) : [],
      triggerTimeStart: triggerType === 'time' ? (document.getElementById('cg-event-time-start')?.value.trim() || '') : '',
      triggerTimeEnd: triggerType === 'time' ? (document.getElementById('cg-event-time-end')?.value.trim() || '') : '',
      completeKey: document.getElementById('cg-event-complete-key').value.trim(),
      finishRule: (document.getElementById('cg-event-finish-rule')?.value || '').trim(),
      content: document.getElementById('cg-event-content').value.trim(),
      triggerMode: 'event',
      chainId: prev.chainId || '',
      chainName: newChainName,
      chainIndex: Number(prev.chainIndex || 0)
    };
    // 同步链名到整条链的其它事件
    if (prev.chainId) {
      _eventsData.forEach(ev => {
        if (ev && ev.chainId === prev.chainId) ev.chainName = newChainName;
      });
    }
    await _saveConvEvents(_eventsData);
    _renderEventList();
    closeEventModal();
  }

  async function deleteEvent() {
    if (_editEventIdx === null) return;
    if (!await UI.showConfirm('删除事件', `确定删除「${_eventsData[_editEventIdx]?.name || '未命名'}」？`)) return;
    _eventsData.splice(_editEventIdx, 1);
    await _saveConvEvents(_eventsData);
    _renderEventList();
    closeEventModal();
  }

  function closeEventModal() {
    _editEventIdx = null;
    document.getElementById('cg-event-modal')?.classList.add('hidden');
  }

  // ========== AI 生成事件 ==========

  let _aiAbort = null;

  function openAiGenerate(mode, chainId) {
    const genMode = mode || (_eventTab === 'chain' ? 'newChain' : 'standalone');
    document.getElementById('cg-ai-gen-overlay')?.remove();
    const title = genMode === 'appendChain' ? 'AI 续写事件链' : (genMode === 'newChain' ? 'AI 根据主线生成事件链' : 'AI 根据主线生成事件');
    const placeholder = genMode === 'standalone' ? '例如：围绕刚才的争吵生成几个后续事件' : '例如：把当前调查线扩展成连续主线；围绕复仇目标设计一条事件链';
    const countVal = genMode === 'standalone' ? 3 : 5;
    const html = `
    <div id="cg-ai-gen-overlay" data-mode="${_esc(genMode)}" data-chain-id="${_esc(chainId || '')}" style="position:fixed;inset:0;z-index:210;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)this.remove()">
      <div style="background:var(--bg);border-radius:16px;padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto" onclick="event.stopPropagation()">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:var(--accent);display:flex;align-items:center;gap:6px"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> ${title}</h3>
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成需求（可选）</label>
        <textarea id="cg-ai-gen-prompt" rows="3" placeholder="${placeholder}" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);resize:vertical;font-size:13px;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:12px;margin-top:12px">
          <div style="flex:1">
            <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">生成数量</label>
            <input type="number" id="cg-ai-gen-count" value="${countVal}" min="1" max="10" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box">
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:10px;line-height:1.5">${genMode === 'standalone' ? '生成独立事件，不会强制串联。' : (genMode === 'appendChain' ? '会从当前事件链最后一个事件继续向后写。' : '会自动用“上一事件结束词”触发下一事件。')}</div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('cg-ai-gen-overlay')?.remove()" style="padding:8px 14px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button id="cg-ai-gen-btn" onclick="ConvGameplay.doAiGenerate()" style="padding:8px 14px;border:none;border-radius:8px;background:var(--accent);color:#111;font-size:13px;cursor:pointer;font-weight:600">生成</button>
        </div>
        <div id="cg-ai-gen-status" style="margin-top:12px;font-size:12px;color:var(--text-secondary);display:none"></div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  async function doAiGenerate() {
    const overlay = document.getElementById('cg-ai-gen-overlay');
    const btn = document.getElementById('cg-ai-gen-btn');
    const status = document.getElementById('cg-ai-gen-status');
    const prompt = document.getElementById('cg-ai-gen-prompt')?.value?.trim() || '';
    const count = Math.max(1, Math.min(10, parseInt(document.getElementById('cg-ai-gen-count')?.value) || 3));
    const genMode = overlay?.dataset?.mode || (_eventTab === 'chain' ? 'newChain' : 'standalone');
    const appendChainId = overlay?.dataset?.chainId || '';

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (status) { status.style.display = 'block'; status.textContent = `正在生成 ${count} 个事件…`; }

    // 获取世界观上下文
    const conv = _getConv();
    const wvId = conv?.singleWorldviewId || conv?.worldviewId || '';
    let settingText = '', regionNames = [];
    try {
      const wv = wvId ? await DB.get('worldviews', wvId) : null;
      settingText = wv?.setting || '';
      regionNames = (wv?.regions || []).map(r => r.name).filter(Boolean);
    } catch(_) {}

    // 获取玩家面具
    let maskName = '玩家', maskDesc = '';
    try {
      const mask = (typeof Character !== 'undefined' && Character.get) ? await Character.get() : null;
      if (mask) { maskName = mask.name || '玩家'; maskDesc = mask.description || mask.detail || ''; }
    } catch(_) {}

    // 获取主线最近10轮（20条）消息
    let recentMessages = '（无对话记录）';
    try {
      const msgs = (typeof Chat !== 'undefined' && Chat.getMessages) ? (Chat.getMessages() || []) : [];
      const recent = msgs.filter(m => m.role === 'user' || m.role === 'assistant').slice(-20);
      if (recent.length > 0) {
        recentMessages = recent.map(m => {
          const role = m.role === 'user' ? maskName : 'AI';
          const text = String(m.content || '').replace(/```[\s\S]*?```/g, '').slice(0, 700);
          return `[${role}] ${text}`;
        }).join('\n\n');
      }
    } catch(_) {}

    const existingEvents = _eventsData.map(e => e.name).filter(Boolean);
    const existingChains = [...new Map(_eventsData.filter(e => e.chainId).map(e => [e.chainId, e.chainName || '未命名事件链'])).values()];
    const appendEvents = appendChainId ? _eventsData.filter(e => e.chainId === appendChainId).sort((a, b) => Number(a.chainIndex || 0) - Number(b.chainIndex || 0)) : [];
    const appendChainName = appendEvents[0]?.chainName || '';
    const lastEvent = appendEvents[appendEvents.length - 1] || null;

    const commonFields = `字段格式要求：\n- keys 使用中文逗号或英文逗号分隔都可以，但不要换行。\n- completeKey 只能包含英文大写字母、数字、下划线，格式必须是 __EVENT_COMPLETE_XXXX__。\n- content 不要包含 completeKey。\n- content 不要对玩家或NPC发号施令，不要写“玩家必须……”“NPC会……”。只能写环境、局势、压力、线索和可能方向。\n- 不要输出 Markdown。\n- 不要输出注释。\n- 不要输出解释。`;

    const standaloneSys = `你是一个文字冒险游戏的当前主线事件设计师。请根据当前主线剧情、世界观设定和玩家角色，为当前对话生成可触发的关键词剧情事件。\n\n这些事件属于“对话级独立事件”，只服务于当前这一次对话和当前主线，不要求在其他对话中复用。\n\n事件定位：\n- 事件必须是当前主线的自然延续，用来承接、放大或推进最近剧情。\n- 你需要从最近主线中提取未解决的矛盾、玩家刚做出的决定、被提到但未展开的人物/地点/组织/线索、角色关系变化、当前行动可能引发的后果。\n- 可以引入新的角色或势力，但必须能从当前主线推导出来，说明它们为什么会被当前事件牵动。\n- 不要生成与当前主线无关的随机支线。\n- 不要写成通用世界观事件；要贴合当前对话已经发生的剧情。\n\n每个事件需要包含：\n- name：事件名称，简短有力，贴合当前主线。\n- keys：触发关键词，2-4个，逗号分隔。关键词必须是玩家接下来在对话中自然可能提到的词。\n- completeKey：结束关键词，格式为 __EVENT_COMPLETE_事件名缩写__。\n- finishRule：事件结束条件，1-2句话，说明剧情推进到什么程度算事件结束。\n- content：事件内容，100-300字，写给运行时AI看的剧情指令，不是写给玩家看的文本。content 要写清楚：这个事件承接了当前主线中的什么问题、事件发生后的舞台/情境/压力、可能浮现的新线索或新角色/势力、后续可以往哪些方向发展。不要写任何角色的具体行为、动作、语气、情感反应。\n\n要求：\n- 只生成关键词触发事件，不生成数值触发事件。\n- 事件之间可以有关联，但不要强制串成链。\n- 不要和已有事件重复。\n${commonFields}\n\n输出纯 JSON 数组。`;

    const chainSys = `你是一个文字冒险游戏的当前主线事件链设计师。请根据当前主线剧情、世界观设定和玩家角色，为当前对话生成一条连续剧情事件链。\n\n这些事件属于“对话级事件链”，只服务于当前这一次对话和当前主线。它应当像一段主线骨架，用事件 A → 事件 B → 事件 C 的方式推动当前剧情继续发展。\n\n事件链定位：\n- 事件链必须从当前主线自然延续出来。\n- 它应承接最近剧情中的未解决矛盾、玩家决定、当前目标、刚出现的线索、人物关系变化或潜在后果。\n- 可以引入新的角色或势力，但必须能从当前主线推导出来，并且解释它们为什么会被当前事件牵动。\n- 不要生成与当前主线无关的随机支线。\n\n链式规则：\n- 事件按数组顺序组成链。\n- 第一个事件由当前主线中的自然关键词触发。\n- 从第二个事件开始，每个事件的 keys 必须包含上一个事件的 completeKey。\n- 每个事件的 content 必须承接上一个事件完成后的局面。\n- 最后一个事件可以阶段性收束，也可以留下下一阶段钩子。\n\n每个事件需要包含：name、keys、completeKey、finishRule、content。\n${commonFields}\n\n输出纯 JSON 对象，格式：{"chainName":"事件链名称","events":[{"name":"事件名称","keys":"关键词1,关键词2","completeKey":"__EVENT_COMPLETE_XXXX__","finishRule":"结束条件","content":"事件内容"}]}`;

    const appendSys = `你是一个文字冒险游戏的当前主线事件链续写设计师。请根据已有对话级事件链的最后一个事件，以及当前主线最近剧情，继续向后生成新的链式事件。\n\n这些事件属于“对话级事件链”的追加内容，必须延续原链条和当前主线，而不是重新开一条新链。\n\n续写规则：\n- 你必须读取已有事件链，尤其是最后一个事件。\n- 你还必须参考当前主线最近对话，判断原链条推进到现在后，下一步最自然会发生什么。\n- 新生成的第一个事件，其 keys 必须包含“已有事件链最后一个事件的 completeKey”。\n- 后续新事件继续按链式规则衔接：每个事件的 keys 必须包含上一个新事件的 completeKey。\n- 新事件必须承接原链条已经推进到的局面，不能回到开头，不能另起炉灶。\n- 可以扩大矛盾、引入新角色或势力、揭露更深层原因、推进到下一阶段危机，但必须与原链条、当前主线和世界观设定有关。\n- 不要重复已有事件链中已经发生过的环节。\n\n每个事件需要包含：name、keys、completeKey、finishRule、content。\n${commonFields}\n\n输出纯 JSON 数组。`;

    const baseUser = `${prompt ? '## 用户额外需求\n' + prompt + '\n\n' : ''}## 世界观设定\n${settingText || '（未提供）'}\n\n${regionNames.length ? '## 地区\n' + regionNames.join('、') + '\n\n' : ''}## 玩家面具\n${maskName}${maskDesc ? '：' + maskDesc.slice(0, 500) : ''}\n\n## 当前主线最近对话（最近10轮）\n${recentMessages}\n\n${existingEvents.length ? '## 已有事件（不要重复）\n' + existingEvents.join('、') + '\n\n' : ''}${existingChains.length ? '## 已有事件链（不要重复）\n' + existingChains.join('、') + '\n\n' : ''}`;

    let sysPrompt = standaloneSys;
    let userMsg = `请生成 ${count} 个对话级独立事件。\n\n${baseUser}`;
    if (genMode === 'newChain') {
      sysPrompt = chainSys;
      userMsg = `请生成一条对话级事件链，包含 ${count} 个事件。\n\n${baseUser}`;
    } else if (genMode === 'appendChain') {
      if (!appendEvents.length || !lastEvent) {
        if (status) status.textContent = '未找到要续写的事件链';
        if (btn) { btn.disabled = false; btn.textContent = '重试'; }
        return;
      }
      sysPrompt = appendSys;
      // 分层发送历史事件，避免链很长时 token 滚雪球：
      // 最近 10 个事件发全字段（衔接需要细节）；更早的只发"名字 + content 截断50字"当脉络回顾。
      const FULL_TAIL = 10;
      const _histText = appendEvents.map((e, i) => {
        const no = i + 1;
        if (i >= appendEvents.length - FULL_TAIL) {
          return `${no}. ${e.name}\nkeys: ${e.keys}\ncompleteKey: ${e.completeKey}\nfinishRule: ${e.finishRule}\ncontent: ${e.content}`;
        }
        const _brief = String(e.content || '').replace(/\s+/g, ' ').trim().slice(0, 50);
        return `${no}. ${e.name}${_brief ? '（' + _brief + '…）' : ''}`;
      }).join('\n\n');
      userMsg = `请为以下对话级事件链继续追加 ${count} 个事件。\n\n${baseUser}## 原事件链名称\n${appendChainName}\n\n## 原事件链已有事件（较早的事件只列脉络，最近 ${Math.min(FULL_TAIL, appendEvents.length)} 个为完整内容）\n${_histText}\n\n## 链尾事件 completeKey\n${lastEvent.completeKey}`;
      // 拍摄链续写：若链尾事件带 shootWorkId 标记，喂剧本资料 + 切换为拍摄链舞台说明（无标记则走原逻辑，零影响普通链）
      const _shootWorkId = lastEvent.shootWorkId || appendEvents.find(e => e && e.shootWorkId)?.shootWorkId || '';
      if (_shootWorkId && typeof Phone !== 'undefined' && Phone.getShootChainGenContext) {
        try {
          const _ctx = Phone.getShootChainGenContext(_shootWorkId);
          if (_ctx && _ctx.sysPromptExtra) {
            sysPrompt = appendSys + _ctx.sysPromptExtra;
          }
        } catch (_) {}
      }
    }

    try {
      _aiAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _aiAbort.signal, maxTokens: 8000 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.events) ? parsed.events : []);
      if (!Array.isArray(arr) || arr.length === 0) throw new Error('AI 返回的不是有效事件数组');

      const chainId = genMode === 'newChain' ? ('chain_' + Utils.uuid().slice(0, 8)) : (genMode === 'appendChain' ? appendChainId : '');
      const chainName = genMode === 'newChain' ? (parsed.chainName || arr[0]?.chainName || '未命名事件链') : (genMode === 'appendChain' ? appendChainName : '');
      const startIndex = genMode === 'appendChain' ? appendEvents.length : 0;
      // 拍摄链续写：把链上的 shootWorkId 标记延续到新事件，否则下次续写识别不到
      const _inheritShootWorkId = genMode === 'appendChain'
        ? (lastEvent?.shootWorkId || appendEvents.find(e => e && e.shootWorkId)?.shootWorkId || '')
        : '';
      let added = 0;
      for (const item of arr) {
        if (!item.name) continue;
        const _evt = {
          id: 'evt_' + Utils.uuid().slice(0, 8),
          name: item.name || '', keys: item.keys || '', triggerType: 'keyword',
          attrConditions: [], completeKey: item.completeKey || '',
          finishRule: item.finishRule || '', content: item.content || '', triggerMode: 'event',
          chainId: chainId || '', chainName: chainName || '', chainIndex: chainId ? startIndex + added : 0
        };
        if (_inheritShootWorkId) _evt.shootWorkId = _inheritShootWorkId;
        _eventsData.push(_evt);
        added++;
      }
      await _saveConvEvents(_eventsData);
      if (genMode !== 'standalone') _eventTab = 'chain';
      _renderEventList();
      document.getElementById('cg-ai-gen-overlay')?.remove();
      UI.showToast(`已生成 ${added} 个事件`, 2000);
    } catch(e) {
      if (e.name === 'AbortError') { if (status) status.textContent = '已取消'; return; }
      if (status) status.textContent = `生成失败：${e.message}`;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally { _aiAbort = null; }
  }

  // ========== 主面板入口 ==========

  async function openEventEditor() {
  if (document.body.getAttribute('data-worldview') === '心动模拟') { UI.showToast('心动模拟世界观不支持自定义事件', 2000); return; }
  const conv = await _ensureConvEvents();
    if (!conv) return;
    _eventsData = conv.convEvents || [];

    // 关闭对话设置弹窗
    document.getElementById('conv-settings-modal')?.classList.add('hidden');

    // 创建全屏面板
    document.getElementById('cg-event-panel')?.remove();
    const panel = document.createElement('div');
    panel.id = 'cg-event-panel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:180;background:var(--bg);display:flex;flex-direction:column;overflow:hidden';
    panel.innerHTML = `
      <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 0;flex-shrink:0">
        <button onclick="ConvGameplay.closeEventEditor()" style="width:fit-content;padding:8px 12px;display:flex;align-items:center;background:none;border:none;color:var(--text);cursor:pointer;margin-bottom:12px">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <div style="margin-bottom:12px">
          <div style="font-size:18px;font-weight:700;color:var(--text)">事件配置（对话级）</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">修改只影响当前对话，不影响世界观原件</div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:4px">
          <button id="cg-event-tab-standalone" class="active" onclick="ConvGameplay.switchEventTab('standalone')" style="flex:1;padding:8px;border:none;border-radius:8px;background:var(--accent);color:#111;font-size:12px;font-weight:600;cursor:pointer">独立事件</button>
          <button id="cg-event-tab-chain" onclick="ConvGameplay.switchEventTab('chain')" style="flex:1;padding:8px;border:none;border-radius:8px;background:transparent;color:var(--text-secondary);font-size:12px;font-weight:600;cursor:pointer">事件链</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <button id="cg-event-ai-btn" onclick="ConvGameplay.openAiGenerate()" style="padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI生成</button>
          <button id="cg-event-add-btn" onclick="ConvGameplay.addEvent()" style="padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer">+ 添加</button>
        </div>
      </div>
      <div id="cg-event-list" style="flex:1;overflow-y:auto;padding:0 16px 16px"></div>
    `;
    document.body.appendChild(panel);
    switchEventTab(_eventTab);
    _ensureEventModal();
  }

  function closeEventEditor() {
    document.getElementById('cg-event-panel')?.remove();
  }

  // 确保编辑弹窗 DOM 存在
  function _ensureEventModal() {
    if (document.getElementById('cg-event-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'cg-event-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
    <div class="modal-content" style="max-height:80vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 id="cg-event-modal-title">编辑事件</h3>
        <button class="btn-icon" onclick="ConvGameplay.deleteEvent()" style="width:32px;height:32px;padding:4px;color:var(--danger)">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
      <div class="form-group hidden" id="cg-event-chain-row"><span class="form-label">事件链名称 <span style="font-size:11px;color:var(--text-secondary)">（改名会同步整条链）</span></span><input type="text" id="cg-event-chain-name" placeholder="如：复仇线第一幕"></div>
      <div class="form-group"><span class="form-label">事件名称</span><input type="text" id="cg-event-name" placeholder="如：深蓝教会袭击"></div>
      <div class="form-group"><span class="form-label">触发方式</span><select id="cg-event-trigger-type" onchange="ConvGameplay._syncTriggerTypeUI()" style="width:100%;box-sizing:border-box"><option value="keyword">关键词触发</option><option value="attr">数值触发</option><option value="time">时间触发</option></select></div>
      <div class="form-group" id="cg-event-keyword-row"><span class="form-label">触发关键词 <span style="font-size:11px;color:var(--text-secondary)">（多个用逗号或空格分隔）</span></span><input type="text" id="cg-event-keys" placeholder="如：深蓝教会, 深蓝, 阿司霍尔"></div>
      <div class="form-group hidden" id="cg-event-attr-row"><span class="form-label">数值触发条件 <span style="font-size:11px;color:var(--text-secondary)">（全部满足才触发）</span></span><div id="cg-event-attr-conditions" style="display:flex;flex-direction:column;gap:8px"></div><button type="button" onclick="ConvGameplay.addAttrCondition()" style="width:100%;margin-top:8px;padding:8px 10px;background:none;border:1px dashed var(--border);border-radius:8px;color:var(--accent);cursor:pointer;font-size:12px">+ 添加条件</button></div>
      <div class="form-group hidden" id="cg-event-time-row"><span class="form-label">时间范围 <span style="font-size:11px;color:var(--text-secondary)">（游戏时间进入此范围时触发。只填时分=每天重复，填完整日期=一次性）</span></span><div style="display:flex;flex-direction:column;gap:8px"><input type="text" id="cg-event-time-start" placeholder="开始，如 08:00 或 3月15日 08:00"><input type="text" id="cg-event-time-end" placeholder="结束（可选），如 12:00 或 3月15日 12:00。不填则到结束时间自动关闭"></div></div>
      <div class="form-group"><span class="form-label">结束关键词 <span style="font-size:11px;color:var(--text-secondary)">（AI 回复中出现此词后事件自动关闭）</span></span><input type="text" id="cg-event-complete-key" placeholder="如：__EVENT_COMPLETE_深蓝袭击__"></div>
      <div class="form-group"><span class="form-label">如何判断事件结束 <span style="font-size:11px;color:var(--text-secondary)">（满足后 AI 应输出结束关键词）</span></span><textarea id="cg-event-finish-rule" rows="3" placeholder="如：当袭击者撤退、现场危机解除、主要角色确认安全后，视为事件结束。"></textarea></div>
      <div class="form-group"><span class="form-label">事件内容 <span style="font-size:11px;color:var(--text-secondary)">（触发后每轮注入，直到结束）</span></span><textarea id="cg-event-content" rows="8" placeholder="事件剧情引导、场景氛围、环境细节、可能的发展方向…"></textarea></div>
      <div class="modal-actions" style="flex-shrink:0;margin-top:12px">
        <button onclick="ConvGameplay.closeEventModal()" style="flex:1;background:none;border:1px solid var(--border);color:var(--text-secondary)">取消</button>
        <button onclick="ConvGameplay.saveEvent()" style="flex:1">保存</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
  }

  // ========== 对话级属性编辑器 ==========

  async function _ensureConvGameplay() {
    const conv = _getConv();
    if (!conv) return null;
    if (!conv.convGameplay) {
      const wvId = conv.singleWorldviewId || conv.worldviewId || '';
      const wv = (wvId && wvId !== '__default_wv__') ? await DB.get('worldviews', wvId) : null;
      const hasGp = wv && wv.gameplay && (
        (wv.gameplay.globalAttrs && wv.gameplay.globalAttrs.length) ||
        (wv.gameplay.characterAttrs && wv.gameplay.characterAttrs.length)
      );
      const msg = hasGp
        ? '将从世界观复制属性配置到当前对话。\n之后修改只影响本对话，不影响世界观原件。\n继续？'
        : '当前世界观无属性配置，将为本对话创建空白属性配置。\n继续？';
      if (!await UI.showConfirm('创建对话级属性配置', msg)) return null;
      conv.convGameplay = hasGp
        ? JSON.parse(JSON.stringify(wv.gameplay))
        : { globalAttrs: [], characterAttrs: [], taskSystem: { phases: [] } };
      await Conversations.saveList();
    }
    return conv;
  }

  async function _saveConvGameplay(gp) {
    const conv = _getConv();
    if (!conv) return;
    conv.convGameplay = gp;
    await Conversations.saveList();
  }

  // ----- 属性行渲染 -----
  function _renderConvAttrRows(attrs, scope, charIdx) {
    if (!attrs || !attrs.length) {
      return '<div style="padding:12px;color:var(--text-secondary);font-size:12px;text-align:center;border:1px dashed var(--border);border-radius:8px">暂无属性</div>';
    }
    return attrs.map((a, i) => {
      const name = (a.name || '').trim() || '未命名属性';
      const maxText = (a.max === '' || a.max === null || a.max === undefined) ? '无上限' : `最大 ${a.max}`;
      const summary = `初始 ${a.initial ?? 0} / ${maxText}`;
      return `<div onclick="ConvGameplay.openAttrModal('${scope}', ${charIdx}, ${i})" style="display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;background:var(--bg-secondary);border:1px solid color-mix(in srgb, var(--border) 55%, transparent);cursor:pointer">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(name)}</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(summary)}</div>
        </div>
        <div style="color:var(--text-secondary);font-size:18px;line-height:1;opacity:.65">›</div>
      </div>`;
    }).join('');
  }

  let _cgAttrGp = null; // 当前编辑的 gameplay 引用

  function _renderConvAttrs() {
    const globalEl = document.getElementById('cg-global-attrs');
    const charEl = document.getElementById('cg-char-attrs');
    if (!_cgAttrGp) return;
    const gp = _cgAttrGp;

    if (globalEl) {
      globalEl.innerHTML = `
        <div style="padding:2px 0 10px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text)">用户 / 全局属性</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">通用于当前对话，可添加多条。</div>
            </div>
            <button type="button" onclick="ConvGameplay.openAttrModal('global', -1, -1)" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer">+ 添加属性</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:10px">${_renderConvAttrRows(gp.globalAttrs, 'global', -1)}</div>
        </div>`;
    }

    if (charEl) {
      const cards = (gp.characterAttrs || []).map((c, idx) => `
        <div style="padding:2px 0 10px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
            <div style="min-width:0">
              <div style="font-size:14px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.targetName || '未命名角色')}</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.sourceLabel || '')}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button type="button" onclick="ConvGameplay.openAttrModal('character', ${idx}, -1)" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer">+ 属性</button>
              <button type="button" onclick="ConvGameplay.deleteCharCard(${idx})" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--danger);font-size:12px;cursor:pointer">移除</button>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:10px">${_renderConvAttrRows(c.attrs || [], 'character', idx)}</div>
        </div>
      `).join('');

      charEl.innerHTML = `
        <div style="padding:2px 0 10px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text)">角色属性</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">先选择角色，再为该角色添加属性。</div>
            </div>
            <button type="button" onclick="ConvGameplay.toggleCharPicker()" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0">+ 角色</button>
          </div>
          <div id="cg-char-picker" class="hidden" style="margin-bottom:12px;border:1px solid var(--border);border-radius:10px;padding:10px;background:var(--bg-secondary)">
            <input id="cg-char-search" placeholder="搜索角色 / 别名 / 世界观" oninput="ConvGameplay.renderCharPicker(this.value)" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;margin-bottom:8px">
            <div id="cg-char-list" style="max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:6px"></div>
          </div>
          <div style="display:flex;flex-direction:column;gap:12px">${cards || '<div style="padding:12px;color:var(--text-secondary);font-size:12px;text-align:center;border:1px dashed var(--border);border-radius:8px">暂无角色属性卡片</div>'}</div>
        </div>`;
    }
  }

  // ----- 角色选择器 -----
  let _charPickerCache = [];

  async function _collectChars() {
    const out = [];
    try {
      const cards = await SingleCard.getAll();
      cards.forEach(c => out.push({ targetType: 'singleCard', targetId: c.id, sourceWorldviewId: '', targetName: c.name || '未命名角色', aliases: c.aliases || '', sourceLabel: '单人卡', avatar: c.avatar || '' }));
    } catch(_) {}
    try {
      const allWvs = await DB.getAll('worldviews');
      const avatarsArr = await DB.getAll('npcAvatars');
      const avatarMap = {}; avatarsArr.forEach(a => { avatarMap[a.id] = a.avatar || ''; });
      allWvs.forEach(wv => {
        if (!wv || wv.id === '__default_wv__' || wv._hidden) return;
        (wv.globalNpcs || []).forEach(n => out.push({ targetType: 'worldviewNpc', targetId: n.id, sourceWorldviewId: wv.id, targetName: n.name || '未命名', aliases: n.aliases || '', sourceLabel: `世界观：${wv.name || '未命名世界观'} / 全图常驻`, avatar: avatarMap[n.id] || n.avatar || '' }));
        (wv.regions || []).forEach(r => (r.factions || []).forEach(f => (f.npcs || []).forEach(n => out.push({ targetType: 'worldviewNpc', targetId: n.id, sourceWorldviewId: wv.id, targetName: n.name || '未命名', aliases: n.aliases || '', sourceLabel: `世界观：${wv.name || '未命名世界观'} / ${r.name || '未命名地区'} / ${f.name || '未命名势力'}`, avatar: avatarMap[n.id] || n.avatar || '' }))));
      });
    } catch(_) {}
    return out;
  }

  function _attrTargetKey(t) {
    return [t?.targetType || '', t?.targetId || '', t?.sourceWorldviewId || ''].join(':');
  }

  async function toggleCharPicker() {
    const box = document.getElementById('cg-char-picker');
    if (!box) return;
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) {
      const input = document.getElementById('cg-char-search');
      if (input) input.value = '';
      await renderCharPicker('');
      setTimeout(() => input?.focus(), 50);
    }
  }

  async function renderCharPicker(query) {
    const listEl = document.getElementById('cg-char-list');
    if (!listEl) return;
    const q = String(query || '').toLowerCase().trim();
    const chars = await _collectChars();
    const filtered = q ? chars.filter(c => [c.targetName, c.aliases, c.sourceLabel].some(v => String(v || '').toLowerCase().includes(q))) : chars;
    if (!filtered.length) {
      listEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-secondary);font-size:12px">${q ? '没有匹配的角色' : '暂无可选角色'}</div>`;
      return;
    }
    listEl.innerHTML = filtered.map((c, i) => `
      <div onclick="ConvGameplay.selectChar(${i})" style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);cursor:pointer">
        <div style="width:34px;height:34px;border-radius:50%;overflow:hidden;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0">${c.avatar ? `<img src="${_esc(c.avatar)}" style="width:100%;height:100%;object-fit:cover">` : _esc((c.targetName || '?').slice(0,1))}</div>
        <div style="min-width:0;flex:1">
          <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.targetName || '未命名')}${c.aliases ? `<span style="font-size:11px;color:var(--text-secondary)"> · ${_esc(c.aliases)}</span>` : ''}</div>
          <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.sourceLabel || '')}</div>
        </div>
      </div>
    `).join('');
    _charPickerCache = filtered;
  }

  async function selectChar(idx) {
    const c = _charPickerCache[idx];
    if (!c || !_cgAttrGp) return;
    const gp = _cgAttrGp;
    if (!gp.characterAttrs) gp.characterAttrs = [];
    const key = _attrTargetKey({ targetType: c.targetType, targetId: c.targetId, sourceWorldviewId: c.sourceWorldviewId });
    if (gp.characterAttrs.some(x => _attrTargetKey(x) === key)) {
      UI.showToast('这个角色已经有属性卡片了', 2000);
      return;
    }
    gp.characterAttrs.push({ targetType: c.targetType, targetId: c.targetId, targetName: c.targetName, sourceWorldviewId: c.sourceWorldviewId || '', sourceLabel: c.sourceLabel || '', attrs: [] });
    await _saveConvGameplay(gp);
    _renderConvAttrs();
    document.getElementById('cg-char-picker')?.classList.add('hidden');
  }

  async function deleteCharCard(idx) {
    if (!_cgAttrGp) return;
    const ok = await UI.showConfirm('移除角色属性', '只会移除此角色的属性配置，不会删除角色本身。确定移除吗？');
    if (!ok) return;
    _cgAttrGp.characterAttrs.splice(idx, 1);
    await _saveConvGameplay(_cgAttrGp);
    _renderConvAttrs();
  }

  // ----- 属性弹窗 -----
  let _attrCtx = null; // { scope, charIdx, attrIdx, isNew }

  function _defaultAttr() {
    return { id: 'attr_' + Utils.uuid().slice(0, 8), name: '', initial: 0, max: '', desc: '', overflowTo: '', deriveTo: '', deriveStep: '' };
  }

  function _ensureAttrModal() {
    if (document.getElementById('cg-attr-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'cg-attr-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
    <div class="modal-content" style="max-height:90vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0">
        <h3 id="cg-attr-modal-title" style="margin:0;font-size:16px;color:var(--accent)">编辑属性</h3>
        <button onclick="ConvGameplay.closeAttrModal()" style="background:none;border:none;color:var(--text-secondary);font-size:20px;cursor:pointer">×</button>
      </div>
      <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:4px">
        <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">属性名称
          <input id="cg-attr-name" placeholder="例如：饱食度" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none;box-shadow:none">
        </label>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px">
          <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text);min-width:0">初始值
            <input id="cg-attr-initial" type="number" placeholder="0" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;min-width:0;outline:none;box-shadow:none">
          </label>
          <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text);min-width:0">最大值
            <input id="cg-attr-max" type="number" placeholder="留空=无上限" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;min-width:0;outline:none;box-shadow:none">
          </label>
        </div>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">达到上限后进位到
          <select id="cg-attr-overflow" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none;box-shadow:none">
            <option value="">不进位</option>
          </select>
          <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">本属性达到上限后，每满一次上限，目标属性 +1，本属性保留余数（需设置最大值才生效）。</span>
        </label>
        <div style="display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:10px">
          <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text);min-width:0">每累计 N 点派生到
            <select id="cg-attr-derive" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;min-width:0;outline:none;box-shadow:none">
              <option value="">不派生</option>
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text);min-width:0">步长 N
            <input id="cg-attr-derive-step" type="number" placeholder="100" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;min-width:0;outline:none;box-shadow:none">
          </label>
        </div>
        <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">本属性每累计 N 点，目标属性自动+1（目标 = 本属性÷N 向下取整），本属性持续累积不清零。目标属性变为只读、AI 无法直接修改。与「进位」二选一。</span>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">属性描述
          <textarea id="cg-attr-desc" placeholder="让 AI 知道这个数值意味着什么" style="width:100%;box-sizing:border-box;min-height:110px;resize:vertical;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;line-height:1.5;outline:none;box-shadow:none"></textarea>
        </label>
        <div style="font-size:11px;color:var(--text-secondary);line-height:1.5">最大值留空表示无上限。这里保存的是属性定义，当前值存在对话状态栏中。</div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:14px;flex-shrink:0">
        <button id="cg-attr-delete-btn" onclick="ConvGameplay.deleteAttrFromModal()" style="padding:9px 12px;border-radius:8px;border:1px solid color-mix(in srgb, var(--danger) 55%, var(--border));background:none;color:var(--danger);font-size:13px;cursor:pointer">删除</button>
        <div style="display:flex;gap:8px">
          <button onclick="ConvGameplay.closeAttrModal()" style="padding:9px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button onclick="ConvGameplay.saveAttrFromModal()" style="padding:9px 14px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">保存</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(modal);
  }

  function openAttrModal(scope, charIdx, attrIdx) {
    if (!_cgAttrGp) return;
    const gp = _cgAttrGp;
    const list = scope === 'global' ? (gp.globalAttrs || []) : (gp.characterAttrs[charIdx]?.attrs || []);
    const isNew = attrIdx < 0;
    const attr = isNew ? _defaultAttr() : list[attrIdx];
    if (!attr) return;
    _attrCtx = { scope, charIdx, attrIdx, isNew };
    _ensureAttrModal();
    const title = document.getElementById('cg-attr-modal-title');
    if (title) title.textContent = isNew ? (scope === 'global' ? '新增全局属性' : '新增角色属性') : '编辑属性';
    const delBtn = document.getElementById('cg-attr-delete-btn');
    if (delBtn) delBtn.style.visibility = isNew ? 'hidden' : 'visible';
    document.getElementById('cg-attr-name').value = attr.name || '';
    document.getElementById('cg-attr-initial').value = attr.initial ?? 0;
    document.getElementById('cg-attr-max').value = attr.max ?? '';
    document.getElementById('cg-attr-desc').value = attr.desc || '';
    // 溢出进位目标下拉：同作用域其它属性（排除自己）
    const ovEl = document.getElementById('cg-attr-overflow');
    if (ovEl) {
      const opts = ['<option value="">不进位</option>'];
      list.forEach((x, i) => {
        if (i === attrIdx) return;
        if (!x || !x.id || !(x.name || '').trim()) return;
        const sel = attr.overflowTo === x.id ? ' selected' : '';
        opts.push(`<option value="${_esc(x.id)}"${sel}>${_esc(x.name)}</option>`);
      });
      ovEl.innerHTML = opts.join('');
      ovEl.value = attr.overflowTo || '';
    }
    // 派生目标下拉：同作用域其它属性（排除自己）
    const dvEl = document.getElementById('cg-attr-derive');
    if (dvEl) {
      const opts = ['<option value="">不派生</option>'];
      list.forEach((x, i) => {
        if (i === attrIdx) return;
        if (!x || !x.id || !(x.name || '').trim()) return;
        const sel = attr.deriveTo === x.id ? ' selected' : '';
        opts.push(`<option value="${_esc(x.id)}"${sel}>${_esc(x.name)}</option>`);
      });
      dvEl.innerHTML = opts.join('');
      dvEl.value = attr.deriveTo || '';
    }
    const dvStepEl = document.getElementById('cg-attr-derive-step');
    if (dvStepEl) dvStepEl.value = attr.deriveStep ?? '';
    // 进位/派生互斥联动
    const _cgAttrSyncExclusive = () => {
      const ovOn = !!(ovEl && ovEl.value);
      const dvOn = !!(dvEl && dvEl.value);
      if (ovEl) ovEl.disabled = dvOn;
      if (dvEl) dvEl.disabled = ovOn;
      if (dvStepEl) dvStepEl.disabled = ovOn || !dvOn;
    };
    if (ovEl) ovEl.onchange = _cgAttrSyncExclusive;
    if (dvEl) dvEl.onchange = _cgAttrSyncExclusive;
    _cgAttrSyncExclusive();
    document.getElementById('cg-attr-modal')?.classList.remove('hidden');
    setTimeout(() => document.getElementById('cg-attr-name')?.focus(), 80);
  }

  function closeAttrModal() {
    _attrCtx = null;
    document.getElementById('cg-attr-modal')?.classList.add('hidden');
  }

  async function saveAttrFromModal() {
    if (!_attrCtx || !_cgAttrGp) return;
    const gp = _cgAttrGp;
    // v681 修复：保底初始化字段，避免 (gp.globalAttrs || []) 生成临时空数组导致 push 丢失
    if (_attrCtx.scope === 'global') {
      if (!Array.isArray(gp.globalAttrs)) gp.globalAttrs = [];
    } else {
      if (!Array.isArray(gp.characterAttrs)) gp.characterAttrs = [];
      if (!gp.characterAttrs[_attrCtx.charIdx]) { UI.showToast('角色卡片不存在', 1800); return; }
      if (!Array.isArray(gp.characterAttrs[_attrCtx.charIdx].attrs)) gp.characterAttrs[_attrCtx.charIdx].attrs = [];
    }
    const list = _attrCtx.scope === 'global' ? gp.globalAttrs : gp.characterAttrs[_attrCtx.charIdx].attrs;
    const name = (document.getElementById('cg-attr-name')?.value || '').trim();
    if (!name) { UI.showToast('请填写属性名称', 1800); return; }
    if (list.some((x, i) => i !== _attrCtx.attrIdx && String(x.name || '').trim() === name)) {
      UI.showToast(_attrCtx.scope === 'global' ? '全局属性名称不能重复' : '同一角色的属性名称不能重复', 1800);
      return;
    }
    const attr = _attrCtx.isNew ? _defaultAttr() : list[_attrCtx.attrIdx];
    if (!attr) return;
    attr.name = name;
    attr.desc = document.getElementById('cg-attr-desc')?.value || '';
    const maxVal = document.getElementById('cg-attr-max')?.value || '';
    const initVal = document.getElementById('cg-attr-initial')?.value || '';
    attr.max = maxVal === '' ? '' : Number(maxVal);
    attr.initial = initVal === '' ? 0 : Number(initVal);
    attr.overflowTo = document.getElementById('cg-attr-overflow')?.value || '';
    attr.deriveTo = document.getElementById('cg-attr-derive')?.value || '';
    const dStep = document.getElementById('cg-attr-derive-step')?.value || '';
    attr.deriveStep = attr.deriveTo ? (dStep === '' ? 100 : Number(dStep)) : '';
    // 互斥兜底：二选一，派生优先清进位
    if (attr.deriveTo) attr.overflowTo = '';
    if (_attrCtx.isNew) list.push(attr);
    await _saveConvGameplay(gp);
    closeAttrModal();
    _renderConvAttrs();
    StatusBar.refreshFromConv();
  }

  async function deleteAttrFromModal() {
    if (!_attrCtx || _attrCtx.isNew) return;
    const gp = _cgAttrGp;
    const list = _attrCtx.scope === 'global' ? (gp.globalAttrs || []) : (gp.characterAttrs[_attrCtx.charIdx]?.attrs || []);
    list.splice(_attrCtx.attrIdx, 1);
    await _saveConvGameplay(gp);
    closeAttrModal();
    _renderConvAttrs();
    StatusBar.refreshFromConv();
  }

  // ----- 属性面板入口 -----
  async function openAttrEditor() {
    if (document.body.getAttribute('data-worldview') === '心动模拟') { UI.showToast('心动模拟世界观不支持自定义属性', 2000); return; }
    try {
      const conv = await _ensureConvGameplay();
      if (!conv) return;
      _cgAttrGp = conv.convGameplay;
      // v681 修复：旧对话或异常路径创建的 convGameplay 可能缺字段，进编辑器就保底一次
      if (!Array.isArray(_cgAttrGp.globalAttrs)) _cgAttrGp.globalAttrs = [];
      if (!Array.isArray(_cgAttrGp.characterAttrs)) _cgAttrGp.characterAttrs = [];

      document.getElementById('conv-settings-modal')?.classList.add('hidden');
      document.getElementById('cg-attr-panel')?.remove();

      const panel = document.createElement('div');
      panel.id = 'cg-attr-panel';
      panel.style.cssText = 'position:fixed;inset:0;z-index:180;background:var(--bg);display:flex;flex-direction:column;overflow:hidden';
      panel.innerHTML = `
        <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 0;flex-shrink:0">
        <button onclick="ConvGameplay.closeAttrEditor()" style="width:fit-content;padding:8px 12px;display:flex;align-items:center;background:none;border:none;color:var(--text);cursor:pointer;margin-bottom:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <div style="margin-bottom:16px">
            <div style="font-size:18px;font-weight:700;color:var(--text)">属性配置（对话级）</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">修改只影响当前对话，不影响世界观原件</div>
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;padding:0 16px 16px">
          <div id="cg-global-attrs"></div>
          <div id="cg-char-attrs" style="margin-top:16px"></div>
        </div>
      `;
      document.body.appendChild(panel);
      _renderConvAttrs();
    } catch(e) {
      console.error('[ConvGameplay.openAttrEditor]', e);
      UI.showToast('打开失败：' + (e.message || e), 3000);
    }
  }

  function closeAttrEditor() {
    _cgAttrGp = null;
    document.getElementById('cg-attr-panel')?.remove();
  }

  // ========== 对话级任务系统编辑器 ==========

  let _cgTaskTs = null; // 当前编辑的 taskSystem 引用

  function _defaultTaskPhase() {
    return {
      id: 'phase_' + Utils.uuid().slice(0, 8),
      name: '',
      batchSize: 3,
      totalTasks: 10,
      types: [],
      completionReward: { mode: 'none', attr: '', value: 0, free: '' }
    };
  }

  function _defaultTaskType() {
    return {
      id: 'tt_' + Utils.uuid().slice(0, 8),
      label: '',
      desc: '',
      rewardMode: 'none',
      rewardAttr: '',
      rewardValue: 0,
      rewardFree: ''
    };
  }

  function _getConvGlobalAttrNames() {
    const gp = _cgAttrGp || _getConv()?.convGameplay;
    const globals = (gp?.globalAttrs || []).map(a => a.name).filter(Boolean);
    const chars = (gp?.characterAttrs || []).flatMap(c =>
      (c.attrs || []).map(a => `${c.targetName || '角色'}的${a.name}`).filter(Boolean)
    );
    return [...globals, ...chars];
  }

  function _renderTaskSystem() {
    const el = document.getElementById('cg-task-container');
    if (!el || !_cgTaskTs) return;
    const phases = _cgTaskTs.phases || [];

    if (phases.length === 0) {
      el.innerHTML = `
        <div style="text-align:center;padding:20px;border:1px dashed var(--border);border-radius:8px">
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">尚未配置任务阶段</div>
          <button type="button" onclick="ConvGameplay.addTaskPhase()" style="padding:7px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer">+ 添加阶段</button>
        </div>`;
      return;
    }

    let html = '';
    phases.forEach((phase, pi) => {
      const typeCards = (phase.types || []).map((t, ti) => {
        let rewardTag = '';
        if (t.rewardMode === 'attr' && t.rewardAttr) rewardTag = `<span style="font-size:11px;color:var(--accent);background:color-mix(in srgb, var(--accent) 15%, transparent);padding:1px 6px;border-radius:4px">${_esc(t.rewardAttr)} ${t.rewardValue >= 0 ? '+' : ''}${t.rewardValue || 0}</span>`;
        else if (t.rewardMode === 'free') rewardTag = `<span style="font-size:11px;color:var(--accent);background:color-mix(in srgb, var(--accent) 15%, transparent);padding:1px 6px;border-radius:4px">自由奖励</span>`;
        return `
        <div onclick="ConvGameplay.openTaskTypeModal(${pi},${ti})" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;cursor:pointer">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(t.label || '未命名类型')}</div>
            ${t.desc ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(t.desc)}</div>` : ''}
          </div>
          ${rewardTag}
          <div style="color:var(--text-secondary);font-size:18px;line-height:1;opacity:.65;flex-shrink:0">›</div>
        </div>`;
      }).join('');

      const cr = phase.completionReward || { mode: 'none' };
      let crSummary = '无';
      if (cr.mode === 'attr' && cr.attr) crSummary = `${cr.attr} ${cr.value >= 0 ? '+' : ''}${cr.value || 0}`;
      else if (cr.mode === 'free') crSummary = '自由奖励';

      html += `
      <div style="background:var(--bg-tertiary);padding:12px;border-radius:10px;border:1px solid var(--border);margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
            <div style="font-size:14px;font-weight:700;color:var(--accent);flex-shrink:0">阶段 ${pi + 1}</div>
            <input value="${_esc(phase.name || '')}" placeholder="阶段名称（可选）" onchange="ConvGameplay.updateTaskPhase(${pi},'name',this.value)" style="flex:1;min-width:0;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:12px">
          </div>
          <button type="button" onclick="ConvGameplay.deleteTaskPhase(${pi})" style="padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--danger);font-size:11px;cursor:pointer;flex-shrink:0">删除</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <label style="flex:1;font-size:12px;color:var(--text-secondary)">每批最多
            <input type="number" min="1" max="5" value="${phase.batchSize || 3}" onchange="ConvGameplay.updateTaskPhase(${pi},'batchSize',Number(this.value))" style="width:100%;margin-top:4px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:12px;box-sizing:border-box">
          </label>
          <label style="flex:1;font-size:12px;color:var(--text-secondary)">本阶段总任务数
            <input type="number" min="1" max="999" value="${phase.totalTasks || 10}" onchange="ConvGameplay.updateTaskPhase(${pi},'totalTasks',Number(this.value))" style="width:100%;margin-top:4px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:12px;box-sizing:border-box">
          </label>
        </div>
        <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">任务类型模板</div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">${typeCards || '<div style="padding:10px;color:var(--text-secondary);font-size:12px;text-align:center;border:1px dashed var(--border);border-radius:6px">暂无类型，点击下方添加</div>'}</div>
        <button type="button" onclick="ConvGameplay.openTaskTypeModal(${pi},-1)" style="width:100%;padding:6px;border-radius:6px;border:1px dashed var(--border);background:none;color:var(--accent);font-size:12px;cursor:pointer;margin-bottom:10px">+ 添加任务类型</button>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">阶段完成奖励：</span>
          <span style="font-size:12px;color:var(--text-secondary)">${_esc(crSummary)}</span>
          <button type="button" onclick="ConvGameplay.openPhaseRewardModal(${pi})" style="padding:2px 8px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--accent);font-size:11px;cursor:pointer;margin-left:auto">编辑</button>
        </div>
        <button type="button" id="cg-task-ai-btn-${pi}" onclick="ConvGameplay.aiGenerateTaskTypes(${pi})" style="width:100%;padding:7px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> AI 生成完整阶段配置
        </button>
      </div>`;
    });

    html += `<button type="button" onclick="ConvGameplay.addTaskPhase()" style="width:100%;padding:8px;border-radius:8px;border:1px dashed var(--border);background:none;color:var(--accent);font-size:13px;cursor:pointer">+ 添加新阶段</button>`;
    el.innerHTML = html;
  }

  async function _saveTaskSystem() {
    if (!_cgAttrGp) return;
    _cgAttrGp.taskSystem = _cgTaskTs;
    await _saveConvGameplay(_cgAttrGp);
  }

  async function addTaskPhase() {
    if (!_cgTaskTs) return;
    if (!_cgTaskTs.phases) _cgTaskTs.phases = [];
    _cgTaskTs.phases.push(_defaultTaskPhase());
    await _saveTaskSystem();
    _renderTaskSystem();
  }

  // ========== AI 生成完整阶段配置 ==========

  let _taskAiAbort = null;

  async function aiGenerateTaskTypes(phaseIndex) {
    if (!_cgTaskTs || !_cgTaskTs.phases[phaseIndex]) return;
    const phase = _cgTaskTs.phases[phaseIndex];
    const btn = document.getElementById(`cg-task-ai-btn-${phaseIndex}`);
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }

    try {
      // 1. 收集世界观设定
      const conv = _getConv();
      const wvId = conv?.singleWorldviewId || conv?.worldviewId || '';
      let settingText = '';
      try {
        const wv = wvId ? await DB.get('worldviews', wvId) : null;
        settingText = wv?.setting || '';
      } catch(_) {}

      // 2. 收集自定义属性
      const gp = _cgAttrGp || conv?.convGameplay;
      let attrList = '';
      if (gp) {
        const globals = (gp.globalAttrs || []).map(a => a.name).filter(Boolean);
        const chars = (gp.characterAttrs || []).flatMap(c =>
          (c.attrs || []).map(a => `${c.targetName || '角色'}的${a.name}`).filter(Boolean)
        );
        const all = [...globals, ...chars];
        attrList = all.length > 0 ? all.join('、') : '';
      }

      // 3. 收集玩家面具信息
      let maskName = '玩家', maskDesc = '';
      try {
        const mask = await Character.get();
        if (mask) { maskName = mask.name || '玩家'; maskDesc = mask.description || mask.detail || ''; }
      } catch(_) {}

      // 4. 收集主线最近10轮（20条）消息
      let recentMessages = '（无对话记录）';
      try {
        const msgs = Chat.getMessages() || [];
        const recent = msgs.filter(m => m.role === 'user' || m.role === 'assistant').slice(-20);
        if (recent.length > 0) {
          recentMessages = recent.map(m => {
            const role = m.role === 'user' ? maskName : 'AI';
            const text = (m.content || '').slice(0, 500);
            return `[${role}] ${text}`;
          }).join('\n\n');
        }
      } catch(_) {}

      // 5. 构建 prompt
      const sysPrompt = `你是一个文字冒险游戏的任务系统设计师。请根据当前主线剧情和世界观设定，为当前阶段设计一个完整的任务系统配置。

配置包括：
- name：阶段名称（3-8字，反映这个阶段的主题或玩家的任务特点）
- batchSize：每批任务数量（2-5 之间，建议 3）
- totalTasks：这个阶段的总任务目标数（5-20，建议 10）
- types：任务类型模板数组，包含 3-5 个类型。每个类型：
  - label：类型名称（2-6字，简洁有力，如"武力提升""线索探查""日常修炼"）
  - desc：任务方向说明（给运行时 AI 看的大方向，50-100字）。只说这类任务的性质和内容方向，举1-2个具体任务例子，让 AI 知道应该给玩家派什么类型的事情去做。不要写触发时机，不要写"当玩家……时"，直接描述任务内容的形态。例如："属于武力提升类任务，内容围绕体能训练、格斗学习展开，如报名散打课、完成一次对练、跟师父学招式等。"
  - rewardMode：奖励模式（"attr" / "free" / "none"）
  - rewardAttr：当 rewardMode="attr" 时，填属性名（必须从下方属性列表选）
  - rewardValue：当 rewardMode="attr" 时，奖励数值（1-5）
  - rewardFree：当 rewardMode="free" 时，奖励方向（大方向，非具体物品，例如"获得与调查相关的线索或物品"）
- completionReward：阶段完成奖励（对象格式）
  - mode：奖励模式（"attr" / "free" / "none"）
  - attr：当 mode="attr" 时，属性名
  - value：当 mode="attr" 时，奖励数值
  - free：当 mode="free" 时，奖励方向

要求：
- types 要根据主线剧情走向设计，覆盖玩家在这个阶段自然会去做的不同类型的事情
- 如果有自定义属性，优先使用属性奖励，选择与任务内容最相关的属性
- 阶段奖励可以用属性或 free，也可以无奖励（mode="none"）

输出纯JSON对象（不是数组），不要其他内容。格式：
{"name":"阶段名","batchSize":3,"totalTasks":10,"types":[{"label":"武力提升","desc":"属于武力提升类任务，内容围绕体能训练、格斗学习展开，如报名散打课、完成一次对练等。","rewardMode":"attr","rewardAttr":"战斗力","rewardValue":2,"rewardFree":""}],"completionReward":{"mode":"attr","attr":"战斗力","value":5,"free":""}}`;

      const userMsg = `请根据以下内容为当前阶段设计完整的任务系统配置，任务类型要贴合主线剧情走向。

## 玩家角色
${maskName}${maskDesc ? '：' + maskDesc.slice(0, 300) : ''}

## 世界观设定
${settingText ? settingText.slice(0, 1000) : '（未提供）'}

## 自定义属性
${attrList || '（未配置属性——请用 rewardMode "free" 或 "none"）'}

## 主线最近对话（最近10轮）
${recentMessages}`;

      // 6. 调 AI
      _taskAiAbort = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _taskAiAbort.signal, maxTokens: 4000 });
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const config = JSON.parse(cleaned);
      if (!config || typeof config !== 'object') throw new Error('AI 返回的不是有效对象');

      // 7. 更新阶段（保留 id，覆盖其他字段）
      phase.name = String(config.name || '').trim();
      phase.batchSize = Math.max(1, Math.min(5, Number(config.batchSize) || 3));
      phase.totalTasks = Math.max(1, Math.min(999, Number(config.totalTasks) || 10));
      
      // 类型数组
      phase.types = [];
      if (Array.isArray(config.types) && config.types.length > 0) {
        for (const item of config.types) {
          if (!item.label) continue;
          phase.types.push({
            id: 'tt_' + Utils.uuid().slice(0, 8),
            label: String(item.label).trim(),
            desc: String(item.desc || '').trim(),
            rewardMode: ['attr', 'free', 'none'].includes(item.rewardMode) ? item.rewardMode : 'none',
            rewardAttr: String(item.rewardAttr || '').trim(),
            rewardValue: Number(item.rewardValue) || 0,
            rewardFree: String(item.rewardFree || '').trim()
          });
        }
      }

      // 阶段奖励
      if (config.completionReward && typeof config.completionReward === 'object') {
        phase.completionReward = {
          mode: ['attr', 'free', 'none'].includes(config.completionReward.mode) ? config.completionReward.mode : 'none',
          attr: String(config.completionReward.attr || '').trim(),
          value: Number(config.completionReward.value) || 0,
          free: String(config.completionReward.free || '').trim()
        };
      } else {
        phase.completionReward = { mode: 'none', attr: '', value: 0, free: '' };
      }

      await _saveTaskSystem();
      _renderTaskSystem();
      UI.showToast(`已生成完整阶段配置（${phase.types.length} 个任务类型）`, 2000);
    } catch(e) {
      if (e.name === 'AbortError') { UI.showToast('已取消', 1500); return; }
      UI.showToast(`生成失败：${e.message}`, 3000);
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg> 重试'; }
    } finally { _taskAiAbort = null; }
  }

  async function deleteTaskPhase(pi) {
    if (!_cgTaskTs) return;
    if (!await UI.showConfirm('删除阶段', `确定删除阶段 ${pi + 1}？`)) return;
    _cgTaskTs.phases.splice(pi, 1);
    await _saveTaskSystem();
    _renderTaskSystem();
  }

  async function updateTaskPhase(pi, field, value) {
    if (!_cgTaskTs) return;
    const phase = _cgTaskTs.phases[pi];
    if (!phase) return;
    if (field === 'batchSize') value = Math.max(1, Math.min(5, value || 3));
    if (field === 'totalTasks') value = Math.max(1, Math.min(999, value || 10));
    phase[field] = value;
    await _saveTaskSystem();
  }

  // ----- 任务类型弹窗 -----
  let _ttPhaseIdx = -1;
  let _ttTypeIdx = -1; // -1=新建, -999=阶段奖励模式

  function _ensureTaskTypeModal() {
    if (document.getElementById('cg-task-type-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'cg-task-type-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
    <div class="modal-content" style="max-height:90vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0">
        <h3 id="cg-tt-title" style="margin:0;font-size:16px;color:var(--accent)">编辑任务类型</h3>
        <button onclick="ConvGameplay.closeTaskTypeModal()" style="background:none;border:none;color:var(--text-secondary);font-size:20px;cursor:pointer">×</button>
      </div>
      <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:4px">
        <label id="cg-tt-label-row" style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">类型名称
          <input id="cg-tt-label" placeholder="例如：唱歌练习" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none">
        </label>
        <label id="cg-tt-desc-row" style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">类型描述
          <textarea id="cg-tt-desc" placeholder="告诉 AI 任务的含义、发布时机、频率等" rows="3" style="width:100%;box-sizing:border-box;min-height:70px;resize:vertical;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;line-height:1.5;outline:none"></textarea>
        </label>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">奖励类型
          <select id="cg-tt-reward-mode" onchange="ConvGameplay.onTaskRewardModeChange()" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none">
            <option value="none">无奖励</option>
            <option value="attr">属性奖励（数值）</option>
            <option value="free">自由奖励（描述）</option>
          </select>
        </label>
        <div id="cg-tt-reward-attr-row" style="display:none;flex-direction:column;gap:6px">
          <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">关联属性
            <select id="cg-tt-reward-attr" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none"></select>
          </label>
          <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">数值变化（正数=加，负数=减）
            <input id="cg-tt-reward-value" type="number" placeholder="例如：+5" style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none">
          </label>
        </div>
        <label id="cg-tt-reward-free-row" style="display:none;flex-direction:column;gap:6px;font-size:13px;color:var(--text)">自由奖励描述
          <textarea id="cg-tt-reward-free" rows="2" placeholder="例如：解锁新的对话选项 / 获得一件道具" style="width:100%;box-sizing:border-box;min-height:60px;resize:vertical;padding:9px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;outline:none"></textarea>
        </label>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:14px;flex-shrink:0">
        <button id="cg-tt-delete-btn" onclick="ConvGameplay.deleteTaskTypeFromModal()" style="padding:9px 12px;border-radius:8px;border:1px solid color-mix(in srgb, var(--danger) 55%, var(--border));background:none;color:var(--danger);font-size:13px;cursor:pointer">删除</button>
        <div style="display:flex;gap:8px">
          <button onclick="ConvGameplay.closeTaskTypeModal()" style="padding:9px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:13px;cursor:pointer">取消</button>
          <button onclick="ConvGameplay.saveTaskTypeFromModal()" style="padding:9px 14px;border-radius:8px;border:none;background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">保存</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(modal);
  }

  function onTaskRewardModeChange() {
    const mode = document.getElementById('cg-tt-reward-mode')?.value;
    const attrRow = document.getElementById('cg-tt-reward-attr-row');
    const freeRow = document.getElementById('cg-tt-reward-free-row');
    if (attrRow) attrRow.style.display = mode === 'attr' ? 'flex' : 'none';
    if (freeRow) freeRow.style.display = mode === 'free' ? 'flex' : 'none';
  }

  function openTaskTypeModal(pi, ti) {
    if (!_cgTaskTs) return;
    _ensureTaskTypeModal();
    _ttPhaseIdx = pi;
    _ttTypeIdx = ti;
    const phase = _cgTaskTs.phases[pi];
    if (!phase) return;
    const isNew = ti < 0;
    const t = isNew ? _defaultTaskType() : (phase.types?.[ti] || _defaultTaskType());

    document.getElementById('cg-tt-title').textContent = isNew ? '新建任务类型' : '编辑任务类型';
    document.getElementById('cg-tt-label').value = t.label || '';
    document.getElementById('cg-tt-label').disabled = false;
    document.getElementById('cg-tt-label-row').style.display = '';
    document.getElementById('cg-tt-desc').value = t.desc || '';
    document.getElementById('cg-tt-desc-row').style.display = '';
    document.getElementById('cg-tt-reward-mode').value = t.rewardMode || 'none';
    document.getElementById('cg-tt-reward-value').value = t.rewardValue || 0;
    document.getElementById('cg-tt-reward-free').value = t.rewardFree || '';
    document.getElementById('cg-tt-delete-btn').style.display = isNew ? 'none' : '';

    const attrSel = document.getElementById('cg-tt-reward-attr');
    const attrNames = _getConvGlobalAttrNames();
    attrSel.innerHTML = `<option value="">选择属性</option>` + attrNames.map(a => `<option value="${_esc(a)}" ${t.rewardAttr === a ? 'selected' : ''}>${_esc(a)}</option>`).join('');

    onTaskRewardModeChange();
    document.getElementById('cg-task-type-modal').classList.remove('hidden');
  }

  function openPhaseRewardModal(pi) {
    if (!_cgTaskTs) return;
    _ensureTaskTypeModal();
    const phase = _cgTaskTs.phases[pi];
    if (!phase) return;
    if (!phase.completionReward) phase.completionReward = { mode: 'none', attr: '', value: 0, free: '' };
    const cr = phase.completionReward;
    _ttPhaseIdx = pi;
    _ttTypeIdx = -999;

    document.getElementById('cg-tt-title').textContent = `阶段 ${pi + 1} 完成奖励`;
    document.getElementById('cg-tt-label-row').style.display = 'none';
    document.getElementById('cg-tt-desc-row').style.display = 'none';
    document.getElementById('cg-tt-reward-mode').value = cr.mode || 'none';
    document.getElementById('cg-tt-reward-value').value = cr.value || 0;
    document.getElementById('cg-tt-reward-free').value = cr.free || '';
    document.getElementById('cg-tt-delete-btn').style.display = 'none';

    const attrSel = document.getElementById('cg-tt-reward-attr');
    const attrNames = _getConvGlobalAttrNames();
    attrSel.innerHTML = `<option value="">选择属性</option>` + attrNames.map(a => `<option value="${_esc(a)}" ${cr.attr === a ? 'selected' : ''}>${_esc(a)}</option>`).join('');

    onTaskRewardModeChange();
    document.getElementById('cg-task-type-modal').classList.remove('hidden');
  }

  function closeTaskTypeModal() {
    const labelRow = document.getElementById('cg-tt-label-row');
    const descRow = document.getElementById('cg-tt-desc-row');
    if (labelRow) labelRow.style.display = '';
    if (descRow) descRow.style.display = '';
    document.getElementById('cg-task-type-modal')?.classList.add('hidden');
  }

  async function saveTaskTypeFromModal() {
    if (!_cgTaskTs) return;
    const phase = _cgTaskTs.phases[_ttPhaseIdx];
    if (!phase) return;
    const mode = document.getElementById('cg-tt-reward-mode').value;

    if (_ttTypeIdx === -999) {
      phase.completionReward = {
        mode,
        attr: mode === 'attr' ? document.getElementById('cg-tt-reward-attr').value : '',
        value: mode === 'attr' ? Number(document.getElementById('cg-tt-reward-value').value) || 0 : 0,
        free: mode === 'free' ? document.getElementById('cg-tt-reward-free').value.trim() : ''
      };
    } else {
      const label = document.getElementById('cg-tt-label').value.trim();
      if (!label) { UI.showToast('请填写类型名称', 1500); return; }
      if (!phase.types) phase.types = [];
      const data = {
        label,
        desc: document.getElementById('cg-tt-desc').value.trim(),
        rewardMode: mode,
        rewardAttr: mode === 'attr' ? document.getElementById('cg-tt-reward-attr').value : '',
        rewardValue: mode === 'attr' ? Number(document.getElementById('cg-tt-reward-value').value) || 0 : 0,
        rewardFree: mode === 'free' ? document.getElementById('cg-tt-reward-free').value.trim() : ''
      };
      if (_ttTypeIdx < 0) {
        data.id = 'tt_' + Utils.uuid().slice(0, 8);
        phase.types.push(data);
      } else {
        const existing = phase.types[_ttTypeIdx];
        if (existing) Object.assign(existing, data);
      }
    }

    await _saveTaskSystem();
    closeTaskTypeModal();
    _renderTaskSystem();
  }

  async function deleteTaskTypeFromModal() {
    if (!_cgTaskTs || _ttTypeIdx < 0) return;
    const phase = _cgTaskTs.phases[_ttPhaseIdx];
    if (!phase || !phase.types?.[_ttTypeIdx]) return;
    phase.types.splice(_ttTypeIdx, 1);
    await _saveTaskSystem();
    closeTaskTypeModal();
    _renderTaskSystem();
  }

  // ----- 任务面板入口 -----
  async function openTaskEditor() {
    if (document.body.getAttribute('data-worldview') === '心动模拟') { UI.showToast('心动模拟世界观不支持自定义任务', 2000); return; }
    try {
      const conv = await _ensureConvGameplay();
      if (!conv) return;
      _cgAttrGp = conv.convGameplay;
      if (!_cgAttrGp.taskSystem) _cgAttrGp.taskSystem = { phases: [] };
      if (!Array.isArray(_cgAttrGp.taskSystem.phases)) _cgAttrGp.taskSystem.phases = [];
      _cgTaskTs = _cgAttrGp.taskSystem;

      document.getElementById('conv-settings-modal')?.classList.add('hidden');
      document.getElementById('cg-task-panel')?.remove();

      const panel = document.createElement('div');
      panel.id = 'cg-task-panel';
      panel.style.cssText = 'position:fixed;inset:0;z-index:180;background:var(--bg);display:flex;flex-direction:column;overflow:hidden';
      panel.innerHTML = `
        <div style="padding:max(16px, env(safe-area-inset-top, 16px)) 16px 0;flex-shrink:0">
        <button onclick="ConvGameplay.closeTaskEditor()" style="width:fit-content;padding:8px 12px;display:flex;align-items:center;background:none;border:none;color:var(--text);cursor:pointer;margin-bottom:12px">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <div style="margin-bottom:16px">
            <div style="font-size:18px;font-weight:700;color:var(--text)">任务系统配置（对话级）</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">修改只影响当前对话，不影响世界观原件</div>
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;padding:0 16px 16px">
          <div id="cg-task-container"></div>
        </div>
      `;
      document.body.appendChild(panel);
      _renderTaskSystem();
    } catch(e) {
      console.error('[ConvGameplay.openTaskEditor]', e);
      UI.showToast('打开失败：' + (e.message || e), 3000);
    }
  }

  function closeTaskEditor() {
    _cgTaskTs = null;
    document.getElementById('cg-task-panel')?.remove();
  }

  // ===== v681 调试：dump 当前对话的 convGameplay 全貌 =====
  async function debugDump() {
    try {
      const conv = _getConv();
      if (!conv) { alert('找不到当前对话'); return; }
      const lines = [];
      lines.push('=== 对话基础 ===');
      lines.push('id: ' + conv.id);
      lines.push('isSingle: ' + conv.isSingle);
      lines.push('singleWorldviewId: ' + (conv.singleWorldviewId || '(空)'));
      lines.push('worldviewId: ' + (conv.worldviewId || '(空)'));
      lines.push('');
      lines.push('=== convGameplay ===');
      lines.push('存在: ' + (conv.convGameplay ? '是' : '否'));
      if (conv.convGameplay) {
        const gp = conv.convGameplay;
        lines.push('globalAttrs 是数组: ' + Array.isArray(gp.globalAttrs));
        lines.push('globalAttrs 数量: ' + (gp.globalAttrs?.length ?? 'undefined'));
        lines.push('characterAttrs 是数组: ' + Array.isArray(gp.characterAttrs));
        lines.push('characterAttrs 数量: ' + (gp.characterAttrs?.length ?? 'undefined'));
        lines.push('taskSystem 存在: ' + !!gp.taskSystem);
        lines.push('taskSystem.phases 数量: ' + (gp.taskSystem?.phases?.length ?? 'undefined'));
      }
      lines.push('');
      lines.push('=== convEvents ===');
      lines.push('数量: ' + (conv.convEvents?.length ?? '(无字段)'));
      lines.push('');
      lines.push('=== 完整 convGameplay JSON ===');
      lines.push(JSON.stringify(conv.convGameplay, null, 2));
      lines.push('');
      lines.push('=== StatusBar 视角 ===');
      try {
        const fmt = await StatusBar.formatCustomAttrsFormatPrompt();
        lines.push('formatPrompt 长度: ' + (fmt?.length ?? 0));
        const sta = await StatusBar.formatCustomAttrsStatePrompt();
        lines.push('statePrompt 长度: ' + (sta?.length ?? 0));
        lines.push('');
        lines.push('--- formatPrompt ---');
        lines.push(fmt || '(空)');
        lines.push('');
        lines.push('--- statePrompt ---');
        lines.push(sta || '(空)');
      } catch(e) {
        lines.push('StatusBar 调用出错: ' + e.message);
      }
      const text = lines.join('\n');
      console.log(text);
      // 弹窗显示 + 复制按钮
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:16px';
      modal.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;max-width:560px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden">
          <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
            <div style="font-weight:600;color:var(--text)">🔍 调试 Dump</div>
            <button id="cg-dbg-close" style="background:none;border:none;color:var(--text);font-size:20px;cursor:pointer;padding:0;width:28px;height:28px">×</button>
          </div>
          <pre style="flex:1;overflow:auto;padding:14px;margin:0;font-size:11px;color:var(--text);white-space:pre-wrap;word-break:break-all;font-family:monospace"></pre>
          <div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:8px;flex-shrink:0">
            <button id="cg-dbg-copy" style="flex:1;padding:8px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#111;font-size:13px;font-weight:600;cursor:pointer">复制全部</button>
          </div>
        </div>`;
      modal.querySelector('pre').textContent = text;
      modal.querySelector('#cg-dbg-close').onclick = () => modal.remove();
      modal.querySelector('#cg-dbg-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(text); UI.showToast('已复制', 1500); } catch(_) { UI.showToast('复制失败，请长按 pre 区域手动选', 2000); }
      };
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
      document.body.appendChild(modal);
    } catch(e) {
      alert('调试出错：' + (e.message || e));
    }
  }

  return {
    openEventEditor, closeEventEditor,
    editEvent, addEvent, saveEvent, deleteEvent, closeEventModal,
    switchEventTab, addEventChain, addChainNode,
    _syncTriggerTypeUI: _syncTriggerTypeUI,
    addAttrCondition, updateAttrCondition, removeAttrCondition,
    openAiGenerate, doAiGenerate,
    openAttrEditor, closeAttrEditor,
    openAttrModal, closeAttrModal, saveAttrFromModal, deleteAttrFromModal,
    toggleCharPicker, renderCharPicker, selectChar, deleteCharCard,
    openTaskEditor, closeTaskEditor,
    debugDump,
    addTaskPhase, deleteTaskPhase, updateTaskPhase, aiGenerateTaskTypes,
    openTaskTypeModal, closeTaskTypeModal, saveTaskTypeFromModal, deleteTaskTypeFromModal,
    openPhaseRewardModal, onTaskRewardModeChange,
    syncAttrsFromWorldview, syncEventsFromWorldview, syncTasksFromWorldview
  };
})();
