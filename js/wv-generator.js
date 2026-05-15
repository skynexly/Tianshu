/**
 * 世界观写卡助手 — AI 分步生成
 * Step 1: 基础设定  Step 2: 地区  Step 3: 势力  Step 4: 角色  Step 5: 开场
 */
const WvGenerator = (() => {
  // ---- 提示词模板 ----
  const PROMPTS = {
    step1: `你是一个世界观架构师。根据用户的描述，生成一个完整的虚构世界观基础设定。

## 输出要求
严格输出 JSON，不要输出任何 JSON 以外的内容（不要用 \`\`\`json 包裹）。
字段：
- name（string）：世界观名称
- description（string）：一句话简介，50字以内
- setting（string）：核心设定文本，详见下方规范
- currency（object: {name, desc}）：仅当需要非现实货币体系时输出，现代日常题材不需要此字段。desc 必须说明基础单位与购买力，并举例常见消费价格，例如“一顿普通餐食约 8-12 枚”“普通旅店一晚约 30 枚”“工人日薪约 80 枚”等；不要只写抽象设定。
##REGION_INSTRUCTION##

## setting 规范
setting 是整个世界观的核心产物，目标字数约 ##WORD_COUNT## 字（不超过 5000 字）。
使用【】作为章节标题。章节内部可使用 Markdown（标题、列表、加粗等）辅助结构化。
按需选用以下章节——只写相关的，不相关的跳过，不要硬凑：

【世界背景】
年代参考、科技水平、文明阶段

【社会风貌与基调】
整体氛围、社会风向、阶层关系、权力结构

【语言与称谓】
特殊称谓体系、官方语言、礼仪习惯——现代日常题材跳过

【历史概述】
关键历史节点（带年份）、导致当前格局的转折——历史不重要则跳过

【地区结构】
主要区域及关系、地理框架——##REGION_SETTING_NOTE##

【特殊设定】
用户明确要求的核心规则（魔法/异能/种族/科技等）、世界的隐藏真相（如果适用）

章节数量根据复杂度自行判断。简单的世界观 2-3 个章节即可。`,

    step1_regionInstr: `- regions（array: [{name, description}]）：地区骨架，生成 ##REGION_COUNT## 个地区，每个 description 50字以内概述`,

    step2: `基于以下世界观设定，生成地区的详细资料。

## 输出要求
严格输出 JSON 数组，不要用 \`\`\`json 包裹。
每个地区包含：
- name（string）：地区名
- description（string）：50字以内概述（用于速查表）
- setting（string）：地区详细设定，目标约 ##WORD_COUNT## 字

setting 使用 Markdown 格式，按需包含以下内容：
### 地理位置
在世界中的方位、地形地貌、气候特征

### 地区特色
文化、风俗、氛围、与其他地区的差异

### 重点项目/建筑
标志性场所、重要机构、地标

### 主要人群
居民构成、阶层分布、典型人物类型

不是所有地区都需要四个板块全写，简单的地区可以合并或省略。
##EXISTING_REGIONS##`,

    step3: `基于以下世界观和地区设定，生成势力。

## 输出要求
严格输出 JSON。
默认输出 JSON 数组；如果要求为多个地区分别生成势力，则输出对象：{ "地区名": [ {势力对象}, ... ] }。
不要用 \`\`\`json 包裹。
每个势力包含：
- name（string）：势力名称
- description（string）：50字以内简介（用于速查表）
- region（string）：所属地区名（如果有地区）
- setting（string）：势力详细设定，目标约 ##WORD_COUNT## 字

setting 使用 Markdown 格式，包含：
### 类型
这个势力是什么性质的组织（政府机构/商业集团/民间组织/地下势力…）

### 职能
日常做什么、负责什么领域

### 组织架构
大致层级、关键职位

### 核心目标
这个势力追求什么、驱动力是什么

### 与其他势力的关联
合作、对抗、从属、竞争——和同地区或跨地区势力的关系

简单的势力可以合并板块。`,

    step4: `基于以下世界观、地区和势力设定，生成角色。

## 输出要求
严格输出 JSON 数组，不要用 \`\`\`json 包裹。
每个角色包含：
- name（string）：姓名
- alias（string）：别称/代号，没有则留空字符串
- age（string）：年龄
- gender（string）：性别
- identity（string）：身份/职位
- faction（string）：所属势力名称（对应已有势力，无势力则留空）
- region（string）：所属地区名称（无地区则留空——归为全图角色）
- detail（string）：角色详细设定，目标约 ##WORD_COUNT## 字

detail 使用 Markdown 格式，包含：
### 外貌
体型、五官、发色、穿着风格等视觉特征

### 性格
核心性格特质、行为模式、情绪倾向

### 背景
过去的经历、成长环境、关键转折

### 目标与动力
当前追求什么、驱动力是什么

### 人际关系
和本批其他角色的具体关系（同事/对手/师徒/恋人/仇敌…）

角色之间应有差异性，避免性格/身份雷同。
人际关系必须双向自洽——A 提到和 B 的关系，B 也要提到和 A 的关系。`,

    step5: `基于以下完整世界观设定，生成开场内容。

## 输出要求
严格输出 JSON，不要用 \`\`\`json 包裹。
字段：
- startTime（string）：故事开始的时间点（年/月/日/时段，与世界观背景一致）
- startPlot（string）：开场剧情引导（200-500字），交代玩家"此刻在哪、发生了什么"，必须留至少一个剧情钩子，给玩家融入世界的契机——不要替玩家做选择
- startMessage（string）：第一条聊天气泡（AI 发出的第一段话），可以是剧情开场或引导语`,

    rewrite: `以下是当前内容，请根据用户的修改建议重写。
保持与已有世界观设定的一致性，仅修改用户指出的部分。
输出格式与原内容一致（严格 JSON，不要用 \`\`\`json 包裹）。

## 当前内容
##CURRENT##

## 用户的修改建议
##FEEDBACK##`
  };

  // ---- 状态 ----
  let _step = 0;
  let _wvId = null;
  let _abortCtrl = null;
  let _genData = { step1: null, step2: null, step3: null, step4: null, step5: null };

  // ---- 工具函数 ----
  // 存最近一次 AI 原始输出，方便失败时复盘
  let _lastRawOutput = '';

  function _parseJSON(text) {
    _lastRawOutput = text || '';
    let cleaned = (text || '').trim();
    // 去掉 markdown 代码块包裹
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
    }
    // 尝试直接解析
    try { return JSON.parse(cleaned); } catch(_) {}
    // 兜底：抓第一个 { 到最后一个 } 或第一个 [ 到最后一个 ]
    const firstObj = cleaned.indexOf('{');
    const firstArr = cleaned.indexOf('[');
    let start = -1, endChar = '';
    if (firstObj === -1 && firstArr === -1) throw new Error('未在AI输出中找到JSON结构');
    if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
      start = firstArr; endChar = ']';
    } else {
      start = firstObj; endChar = '}';
    }
    const end = cleaned.lastIndexOf(endChar);
    if (end <= start) throw new Error('AI输出的JSON结构不完整');
    const slice = cleaned.substring(start, end + 1);
    try { return JSON.parse(slice); }
    catch(e) { throw new Error('JSON解析失败：' + e.message); }
  }

  function _normalizeArray(data, key) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data[key])) return data[key];
    // 兜底1：扁平化所有数组型 value（兼容 `{中州京畿: [...], 燕北边镇: [...]}` 这种以地区名分组的结构）
    const arrayValues = Object.values(data).filter(Array.isArray);
    if (arrayValues.length > 0) {
      return arrayValues.flat();
    }
    // 兜底2：data 本身是单个对象但有 name 字段——视为单条
    if (data.name) return [data];
    return [];
  }

  // 失败时把原始输出存到全局，并 toast 提示
  function _onGenFail(e, label) {
    console.error('[WvGen] ' + label + ' 失败', e, '原始输出:', _lastRawOutput);
    const hint = _lastRawOutput ? '\nAI原文已打到 console，可F12查看' : '';
    UI.showToast(`${label}失败：${e.message}${hint}`, 4500);
  }

  async function _promptText(title, label, def = '') {
    if (typeof UI !== 'undefined' && UI.showSimpleInput) {
      const v = await UI.showSimpleInput(`${title}\n${label}`, def, { allowEmpty: true });
      // allowEmpty 模式下：null 表示取消，'' 表示留空确认
      return v;
    }
    return window.prompt(`${title}\n\n${label}`, def);
  }

  /**
   * 内联生成统一弹窗（复用 wv-gen-modal）
   * opts: { title, icon, desc, defaults: {count, wordCount}, limits: {count:[min,max], wordCount:[min,max]} }
   * handler: async ({prompt, count, wordCount}) => void  抛错时会被捕获并 toast
   */
  async function _openInlineGenModal(opts, handler) {
    const modal = _getModal();
    const body = document.getElementById('wv-gen-body');
    if (!modal || !body) {
      UI.showToast('弹窗加载失败', 1500);
      return;
    }
    const cntMin = opts.limits?.count?.[0] ?? 1;
    const cntMax = opts.limits?.count?.[1] ?? 20;
    const wcMin = opts.limits?.wordCount?.[0] ?? 200;
    const wcMax = opts.limits?.wordCount?.[1] ?? 1500;
    const cntDef = opts.defaults?.count ?? 5;
    const wcDef = opts.defaults?.wordCount ?? 500;
    body.innerHTML = `
      ${_stepIntro(opts.icon || 'spark', opts.title || 'AI 生成', opts.desc || '')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">额外要求（可选）</label>
        <textarea id="wv-inline-prompt" rows="3" placeholder="${Utils.escapeHtml(opts.placeholder || '留空则由 AI 自由发挥')}" class="wv-gen-textarea"></textarea>
      </div>
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">单条字数（≤${wcMax}）</label>
          <input id="wv-inline-words" type="number" min="${wcMin}" max="${wcMax}" step="50" value="${wcDef}" class="wv-gen-input">
        </div>
        <div class="wv-gen-field">
          <label class="wv-gen-label">${opts.countLabel || '数量'}</label>
          <input id="wv-inline-count" type="number" min="${cntMin}" max="${cntMax}" value="${cntDef}" class="wv-gen-input">
        </div>
      </div>
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div id="wv-gen-batch-progress" class="wv-gen-batch-progress" style="display:none"></div>
      <div class="wv-gen-actions">
        <button id="wv-inline-cancel" class="wv-gen-btn">取消</button>
        <button id="wv-gen-submit" class="wv-gen-btn primary">生成</button>
      </div>`;
    modal.classList.remove('hidden');

    return new Promise((resolve) => {
      const cancelBtn = document.getElementById('wv-inline-cancel');
      const submitBtn = document.getElementById('wv-gen-submit');
      const cleanup = () => {
        if (_abortCtrl) { try { _abortCtrl.abort(); } catch(_) {} _abortCtrl = null; }
        modal.classList.add('hidden');
        resolve();
      };
      cancelBtn.onclick = cleanup;
      submitBtn.onclick = async () => {
        const prompt = document.getElementById('wv-inline-prompt')?.value?.trim() || '';
        const wordCount = Math.min(wcMax, Math.max(wcMin, parseInt(document.getElementById('wv-inline-words')?.value) || wcDef));
        const count = Math.min(cntMax, Math.max(cntMin, parseInt(document.getElementById('wv-inline-count')?.value) || cntDef));
        _setLoading(true, opts.loadingMsg || '正在生成…');
        try {
          _abortCtrl = new AbortController();
          await handler({ prompt, count, wordCount, signal: _abortCtrl.signal });
          _setLoading(false);
          modal.classList.add('hidden');
          resolve();
        } catch (e) {
          _setLoading(false);
          if (e.name === 'AbortError') { resolve(); return; }
          UI.showToast('生成失败: ' + e.message, 3000);
          // 不关弹窗，留给用户重试
        }
      };
    });
  }
  async function _promptInt(title, label, def, min, max) {
    const raw = (typeof UI !== 'undefined' && UI.showSimpleInput) ? await UI.showSimpleInput(`${title}\n${label}`, String(def)) : window.prompt(`${title}\n\n${label}`, String(def));
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Math.min(max, Math.max(min, isNaN(n) ? def : n));
  }
  function _regionBrief(r) { return `${r.name || ''}：${r.description || r.summary || ''}`; }
  function _regionDetail(r) { return r.setting || r.detail || r.description || r.summary || ''; }
  function _facBrief(f) { return `${f.name || ''}：${f.description || f.summary || ''}`; }
  function _facDetail(f) { return f.setting || f.detail || f.description || f.summary || ''; }
  function _svg(name, cls = 'wv-gen-step-icon') {
    const icons = {
      spark: '<path d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/><path d="M5 14l.7 1.8L7.5 16.5l-1.8.7L5 19l-.7-1.8-1.8-.7 1.8-.7L5 14z"/>',
      book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
      map: '<path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z"/><path d="M9 3v15"/><path d="M15 6v15"/>',
      castle: '<path d="M4 21V8l3 2 3-2 2 2 2-2 3 2 3-2v13"/><path d="M9 21v-6a3 3 0 0 1 6 0v6"/><path d="M4 13h16"/>',
      users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
      message: '<path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
      check: '<path d="M20 6L9 17l-5-5"/>',
      pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
      film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14"/><path d="M17 5v14"/><path d="M3 10h4"/><path d="M17 10h4"/><path d="M3 14h4"/><path d="M17 14h4"/>',
      globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20"/><path d="M12 2a15.3 15.3 0 0 0 0 20"/>'
    };
    return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.spark}</svg>`;
  }
  function _stepIntro(icon, title, desc) { return `<div class="wv-gen-step-card"><div class="wv-gen-step-title">${_svg(icon)}<span>${title}</span></div><div class="wv-gen-desc">${desc}</div></div>`; }
  function _aiIcon() { return _svg('spark', 'ai-spark-icon'); }

  // ---- UI 渲染 ----
  function _getModal() { return document.getElementById('wv-gen-modal'); }

  function open() {
    _step = 1;
    _genData = { step1: null, step2: null, step3: null, step4: null, step5: null };
    _wvId = null;
    _renderStep();
    const modal = _getModal();
    if (modal) modal.classList.remove('hidden');
  }

  function close() {
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
    const modal = _getModal();
    if (modal) modal.classList.add('hidden');
  }

  function _renderStep() {
    const body = document.getElementById('wv-gen-body');
    if (!body) return;

    switch (_step) {
      case 1: return _renderStep1(body);
      case 2: return _renderStep2(body);
      case 3: return _renderStep3(body);
      case 4: return _renderStep4(body);
      case 5: return _renderStep5(body);
      case 99: return _renderDone(body);
    }
  }

  // ---- Step 1: 基础设定 ----
  function _renderStep1(body) {
    const prev = _genData.step1;
    body.innerHTML = `
${_stepIntro('book', '第 1 步 · 基础设定', '描述你想创建的世界观，AI 会生成核心设定')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">你想要什么样的世界观？</label>
        <textarea id="wv-gen-prompt" rows="5" placeholder="例如：赛博朋克废土、现代都市恋爱、中世纪魔法大陆……\n可以写得很详细，也可以只写一句话" class="wv-gen-textarea">${prev?._userPrompt || ''}</textarea>
      </div>
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">设定字数（最多5000）</label>
          <input id="wv-gen-words" type="number" min="500" max="5000" step="100" value="${prev?._wordCount || 2500}" class="wv-gen-input">
        </div>
      </div>
      <div class="wv-gen-option">
        <label class="wv-gen-check">
          <input id="wv-gen-create-regions" type="checkbox" ${prev?._createRegions !== false ? 'checked' : ''} onchange="WvGenerator._onRegionToggle()">
          同时生成地区骨架
        </label>
        <div id="wv-gen-region-count-row" style="margin-top:8px;${prev?._createRegions !== false ? '' : 'display:none'}">
          <label class="wv-gen-label">地区数量</label>
          <input id="wv-gen-region-count" type="number" min="1" max="20" value="${prev?._regionCount || 5}" class="wv-gen-input" style="max-width:110px">
        </div>
      </div>
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div class="wv-gen-actions">
        <button onclick="WvGenerator.close()" class="wv-gen-btn">取消</button>
        <button id="wv-gen-submit" onclick="WvGenerator._runStep1()" class="wv-gen-btn primary">生成</button>
      </div>`;
  }

  function _onRegionToggle() {
    const chk = document.getElementById('wv-gen-create-regions');
    const row = document.getElementById('wv-gen-region-count-row');
    if (row) row.style.display = chk?.checked ? '' : 'none';
  }

  async function _runStep1() {
    const prompt = document.getElementById('wv-gen-prompt')?.value?.trim();
    if (!prompt) { UI.showToast('请输入世界观描述', 1500); return; }
    const wordCount = Math.min(5000, Math.max(500, parseInt(document.getElementById('wv-gen-words')?.value) || 2500));
    const createRegions = document.getElementById('wv-gen-create-regions')?.checked;
    const regionCount = parseInt(document.getElementById('wv-gen-region-count')?.value) || 5;

    _setLoading(true, '正在生成基础设定…');

    let sysPrompt = PROMPTS.step1
      .replace('##WORD_COUNT##', wordCount)
      .replace('##REGION_INSTRUCTION##', createRegions
        ? PROMPTS.step1_regionInstr.replace('##REGION_COUNT##', regionCount)
        : '')
      .replace('##REGION_SETTING_NOTE##', createRegions
        ? '勾选了"同时创建地区"，详写并与 regions 数组对齐'
        : '简要带过或跳过');

    try {
      _abortCtrl = new AbortController();
      const raw = await API.generate(sysPrompt, prompt, { signal: _abortCtrl.signal });
      const data = _parseJSON(raw);
      _genData.step1 = { ...data, _userPrompt: prompt, _wordCount: wordCount, _createRegions: createRegions, _regionCount: regionCount };
      _setLoading(false);
      // 自动进入下一步
      if (createRegions) {
        _step = 2;
      } else {
        _step = 4; // 没地区 → 跳过势力 → 直接角色（全图NPC）
      }
      _renderStep();
    } catch (e) {
      _setLoading(false);
      if (e.name === 'AbortError') return;
      UI.showToast('生成失败: ' + e.message, 3000);
    }
  }

  // ---- Step 2: 地区 ----
  function _renderStep2(body) {
    const s1 = _genData.step1 || {};
    const existingNames = (s1.regions || []).map(r => r.name).join('、');
    body.innerHTML = `
${_stepIntro('map', '第 2 步 · 地区详细', '为每个地区生成详细设定' + (existingNames ? '（已有骨架：' + existingNames + '）' : ''))}
      <div class="wv-gen-field">
        <label class="wv-gen-label">额外要求（可选）</label>
        <textarea id="wv-gen-prompt" rows="3" placeholder="对地区有什么额外要求？留空则完全由 AI 自由发挥" class="wv-gen-textarea">${_genData.step2?._userPrompt || ''}</textarea>
      </div>
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">单条字数（≤1000）</label>
          <input id="wv-gen-words" type="number" min="100" max="1000" step="50" value="${_genData.step2?._wordCount || 300}" class="wv-gen-input">
        </div>
        <div class="wv-gen-field">
          <label class="wv-gen-label">地区数量</label>
          <input id="wv-gen-count" type="number" min="1" max="20" value="${s1._regionCount || (s1.regions?.length) || 5}" class="wv-gen-input">
        </div>
      </div>
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div class="wv-gen-actions">
        <button onclick="WvGenerator._skipStep()" class="wv-gen-btn">跳过</button>
        <button id="wv-gen-submit" onclick="WvGenerator._runStep2()" class="wv-gen-btn primary">生成地区</button>
      </div>`;
  }

  async function _runStep2() {
    const s1 = _genData.step1 || {};
    const userPrompt = document.getElementById('wv-gen-prompt')?.value?.trim() || '';
    const wordCount = Math.min(1000, Math.max(100, parseInt(document.getElementById('wv-gen-words')?.value) || 300));
    const count = parseInt(document.getElementById('wv-gen-count')?.value) || 5;
    const existingNames = (s1.regions || []).map(r => r.name);

    _setLoading(true, '正在生成地区…');

    let sysPrompt = PROMPTS.step2.replace('##WORD_COUNT##', wordCount);
    if (existingNames.length) {
      sysPrompt = sysPrompt.replace('##EXISTING_REGIONS##',
        `\n## 必须对齐的地区\n以下地区名来自基础设定的【地区结构】，名称和定位必须一致：${existingNames.join('、')}`);
    } else {
      sysPrompt = sysPrompt.replace('##EXISTING_REGIONS##', '');
    }

    const userMsg = `${userPrompt ? '用户要求：' + userPrompt + '\n\n' : ''}生成 ${count} 个地区。\n\n## 世界观设定\n${s1.setting || ''}`;

    try {
      _abortCtrl = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal });
      const data = _parseJSON(raw);
      _genData.step2 = { regions: Array.isArray(data) ? data : (data.regions || []), _userPrompt: userPrompt, _wordCount: wordCount };
      _setLoading(false);
      _step = 3;
      _renderStep();
    } catch (e) {
      _setLoading(false);
      if (e.name === 'AbortError') return;
      UI.showToast('生成失败: ' + e.message, 3000);
    }
  }

  // ---- Step 3: 势力（按地区分批串行）----
  function _renderStep3(body) {
    const regions = _genData.step2?.regions || _genData.step1?.regions || [];
    const regionNames = regions.map(r => r.name).join('、');
    body.innerHTML = `
${_stepIntro('castle', '第 3 步 · 势力', '为地区生成势力组织' + (regionNames ? '（' + regionNames + '）' : ''))}
      <div class="wv-gen-field">
        <label class="wv-gen-label">额外要求（可选）</label>
        <textarea id="wv-gen-prompt" rows="3" placeholder="对势力有什么要求？留空则由 AI 自由发挥" class="wv-gen-textarea">${_genData.step3?._userPrompt || ''}</textarea>
      </div>
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">单条字数（≤1200）</label>
          <input id="wv-gen-words" type="number" min="200" max="1200" step="50" value="${_genData.step3?._wordCount || 500}" class="wv-gen-input">
        </div>
        <div class="wv-gen-field">
          <label class="wv-gen-label">每地区势力数</label>
          <input id="wv-gen-count" type="number" min="1" max="10" value="${_genData.step3?._count || 3}" class="wv-gen-input">
        </div>
      </div>
      <div id="wv-gen-batch-progress" class="wv-gen-batch-progress" style="display:none"></div>
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div class="wv-gen-actions">
        <button onclick="WvGenerator._skipStep()" class="wv-gen-btn">跳过</button>
        <button id="wv-gen-submit" onclick="WvGenerator._runStep3()" class="wv-gen-btn primary">生成势力</button>
      </div>`;
  }

  function _renderBatchProgress(items, currentIdx, results) {
    const el = document.getElementById('wv-gen-batch-progress');
    if (!el) return;
    el.style.display = '';
    const total = items.length;
    const done = results.filter(r => r.status === 'done').length;
    const failed = results.filter(r => r.status === 'failed').length;
    let html = `<div class="wv-gen-batch-bar"><div class="wv-gen-batch-fill" style="width:${(done + failed) / total * 100}%"></div></div>
      <div class="wv-gen-batch-meta">进度 ${done + failed}/${total} · 成功 ${done} · 失败 ${failed}</div>
      <div class="wv-gen-batch-list">`;
    items.forEach((name, i) => {
      const r = results[i] || { status: 'pending' };
      let icon = '○', color = 'var(--text-secondary)';
      if (i === currentIdx && r.status === 'pending') { icon = '⏳'; color = 'var(--accent)'; }
      else if (r.status === 'done') { icon = '✓'; color = 'var(--accent)'; }
      else if (r.status === 'failed') { icon = '✗'; color = 'var(--danger,#e57373)'; }
      html += `<div class="wv-gen-batch-item" style="color:${color}">${icon} ${name}${r.status === 'done' ? `（${r.count}条）` : ''}${r.status === 'failed' ? `（${r.error || '失败'}）` : ''}</div>`;
    });
    html += '</div>';
    el.innerHTML = html;
  }

  async function _runStep3() {
    const s1 = _genData.step1 || {};
    const regions = _genData.step2?.regions || s1.regions || [];
    if (regions.length === 0) {
      UI.showToast('没有地区可用，请先完成第 2 步', 2000);
      return;
    }
    const userPrompt = document.getElementById('wv-gen-prompt')?.value?.trim() || '';
    const wordCount = Math.min(1200, Math.max(200, parseInt(document.getElementById('wv-gen-words')?.value) || 500));
    const count = parseInt(document.getElementById('wv-gen-count')?.value) || 3;

    // 多次调用提醒
    if (regions.length >= 2) {
      const ok = await UI.showConfirm(
        '一键生成提示',
        `将为 ${regions.length} 个地区分别调用 AI，共 ${regions.length} 次请求。\n确定开始？`
      );
      if (!ok) return;
    }

    _setLoading(true, `正在生成势力（共 ${regions.length} 个地区）…`);
    const items = regions.map(r => r.name);
    const results = items.map(() => ({ status: 'pending' }));
    _renderBatchProgress(items, 0, results);

    const allFactions = {};
    try {
      _abortCtrl = new AbortController();
      const sysPrompt = PROMPTS.step3.replace('##WORD_COUNT##', wordCount);

      for (let i = 0; i < regions.length; i++) {
        const reg = regions[i];
        _renderBatchProgress(items, i, results);
        try {
          const userMsg = `${userPrompt ? '用户要求：' + userPrompt + '\n\n' : ''}请为下面这一个地区生成 ${count} 个势力。\n\n## 世界观设定\n${s1.setting || ''}\n\n## 当前地区\n### ${reg.name}\n${_regionDetail(reg)}`;
          const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal, maxTokens: 8000 });
          const data = _parseJSON(raw);
          const arr = _normalizeArray(data, 'factions');
          if (arr.length === 0) throw new Error('AI返回空');
          allFactions[reg.name] = arr;
          results[i] = { status: 'done', count: arr.length };
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          console.warn(`[WvGen Step3] 地区「${reg.name}」失败:`, err);
          results[i] = { status: 'failed', error: err.message?.substring(0, 30) || '失败' };
          allFactions[reg.name] = [];
        }
        _renderBatchProgress(items, -1, results);
      }

      _genData.step3 = { factions: allFactions, _userPrompt: userPrompt, _wordCount: wordCount, _count: count };
      _setLoading(false);
      const totalSucc = results.filter(r => r.status === 'done').length;
      const totalFail = results.filter(r => r.status === 'failed').length;
      if (totalFail > 0) {
        UI.showToast(`完成：${totalSucc} 成功 · ${totalFail} 失败（可在编辑页补生成）`, 3000);
      }
      _step = 4;
      _renderStep();
    } catch (e) {
      _setLoading(false);
      if (e.name === 'AbortError') return;
      UI.showToast('生成失败: ' + e.message, 3000);
    }
  }

  // ---- Step 4: 角色（按势力分批串行）----
  function _renderStep4(body) {
    body.innerHTML = `
${_stepIntro('users', '第 4 步 · 角色', '为每个势力生成 NPC 角色')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">额外要求（可选）</label>
        <textarea id="wv-gen-prompt" rows="3" placeholder="对角色有什么要求？留空则由 AI 自由发挥" class="wv-gen-textarea">${_genData.step4?._userPrompt || ''}</textarea>
      </div>
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">单条字数（≤1500）</label>
          <input id="wv-gen-words" type="number" min="200" max="1500" step="50" value="${_genData.step4?._wordCount || 500}" class="wv-gen-input">
        </div>
        <div class="wv-gen-field">
          <label class="wv-gen-label">每势力角色数</label>
          <input id="wv-gen-count" type="number" min="1" max="10" value="${_genData.step4?._count || 3}" class="wv-gen-input">
        </div>
      </div>
      <div id="wv-gen-batch-progress" class="wv-gen-batch-progress" style="display:none"></div>
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div class="wv-gen-actions">
        <button onclick="WvGenerator._skipStep()" class="wv-gen-btn">跳过</button>
        <button id="wv-gen-submit" onclick="WvGenerator._runStep4()" class="wv-gen-btn primary">生成角色</button>
      </div>`;
  }

  async function _runStep4() {
    const s1 = _genData.step1 || {};
    const regions = _genData.step2?.regions || s1.regions || [];
    const factions = _genData.step3?.factions || {};
    const userPrompt = document.getElementById('wv-gen-prompt')?.value?.trim() || '';
    const wordCount = Math.min(1500, Math.max(200, parseInt(document.getElementById('wv-gen-words')?.value) || 500));
    const count = parseInt(document.getElementById('wv-gen-count')?.value) || 3;

    // 把所有 {地区,势力} 平铺成任务列表
    const tasks = [];
    for (const [rn, arr] of Object.entries(factions)) {
      for (const fac of (arr || [])) {
        if (fac && fac.name) tasks.push({ region: rn, faction: fac });
      }
    }

    // 多次调用提醒（按势力分批）
    if (tasks.length >= 2) {
      const ok = await UI.showConfirm(
        '一键生成提示',
        `将为 ${tasks.length} 个势力分别调用 AI，共 ${tasks.length} 次请求。\n确定开始？`
      );
      if (!ok) return;
    }

    // 如果完全没势力（用户跳过了 step3），降级为旧逻辑：一次性生成 count 个常驻角色
    if (tasks.length === 0) {
      _setLoading(true, '正在生成角色…');
      try {
        _abortCtrl = new AbortController();
        let sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);
        const ctxParts = [`## 世界观设定\n${s1.setting || ''}`];
        if (regions.length) ctxParts.push(`## 地区\n${regions.map(r => `- ${_regionBrief(r)}`).join('\n')}`);
        const userMsg = `${userPrompt ? '用户要求：' + userPrompt + '\n\n' : ''}生成 ${count} 个角色。\n\n${ctxParts.join('\n\n')}`;
        const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal, maxTokens: 8000 });
        const data = _parseJSON(raw);
        const arr = Array.isArray(data) ? data : (data.npcs || []);
        _genData.step4 = { npcs: arr, _userPrompt: userPrompt, _wordCount: wordCount, _count: count };
        _setLoading(false);
        _step = 5;
        _renderStep();
      } catch (e) {
        _setLoading(false);
        if (e.name === 'AbortError') return;
        UI.showToast('生成失败: ' + e.message, 3000);
      }
      return;
    }

    _setLoading(true, `正在生成角色（共 ${tasks.length} 个势力）…`);
    const items = tasks.map(t => `${t.region}/${t.faction.name}`);
    const results = items.map(() => ({ status: 'pending' }));
    _renderBatchProgress(items, 0, results);

    const allNpcs = [];
    try {
      _abortCtrl = new AbortController();
      const sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        _renderBatchProgress(items, i, results);
        try {
          const facDetail = t.faction.setting || t.faction.detail || t.faction.description || '';
          const userMsg = `${userPrompt ? '用户要求：' + userPrompt + '\n\n' : ''}为势力「${t.faction.name}」（位于地区「${t.region}」）生成 ${count} 个角色。每个角色的 region 必须是「${t.region}」、faction 必须是「${t.faction.name}」。\n\n## 世界观设定\n${s1.setting || ''}\n\n## 当前势力\n### ${t.faction.name}（${t.region}）\n${facDetail}`;
          const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal, maxTokens: 10000 });
          const data = _parseJSON(raw);
          const arr = _normalizeArray(data, 'npcs');
          if (arr.length === 0) throw new Error('AI返回空');
          // 强制对齐 region / faction
          arr.forEach(n => {
            n.region = t.region;
            n.faction = t.faction.name;
            allNpcs.push(n);
          });
          results[i] = { status: 'done', count: arr.length };
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          console.warn(`[WvGen Step4] 势力「${t.region}/${t.faction.name}」失败:`, err);
          results[i] = { status: 'failed', error: err.message?.substring(0, 30) || '失败' };
        }
        _renderBatchProgress(items, -1, results);
      }

      _genData.step4 = { npcs: allNpcs, _userPrompt: userPrompt, _wordCount: wordCount, _count: count };
      _setLoading(false);
      const totalSucc = results.filter(r => r.status === 'done').length;
      const totalFail = results.filter(r => r.status === 'failed').length;
      if (totalFail > 0) {
        UI.showToast(`完成：${totalSucc} 成功 · ${totalFail} 失败（可在编辑页补生成）`, 3000);
      }
      _step = 5;
      _renderStep();
    } catch (e) {
      _setLoading(false);
      if (e.name === 'AbortError') return;
      UI.showToast('生成失败: ' + e.message, 3000);
    }
  }

  // ---- Step 5: 开场 ----
  function _renderStep5(body) {
    body.innerHTML = `
${_stepIntro('message', '第 5 步 · 开场剧情', '生成开场时间、剧情引导和第一条消息')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">开场要求（可选）</label>
        <textarea id="wv-gen-prompt" rows="3" placeholder="例如：从选灵根开始、日常校园开场、酒馆偶遇…留空则由 AI 自由发挥" class="wv-gen-textarea">${_genData.step5?._userPrompt || ''}</textarea>
      </div>
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div class="wv-gen-actions">
        <button onclick="WvGenerator._skipStep()" class="wv-gen-btn">跳过</button>
        <button id="wv-gen-submit" onclick="WvGenerator._runStep5()" class="wv-gen-btn primary">生成开场</button>
      </div>`;
  }

  async function _runStep5() {
    const s1 = _genData.step1 || {};
    const regions = _genData.step2?.regions || s1.regions || [];
    const factions = _genData.step3?.factions || {};
    const npcs = _genData.step4?.npcs || [];
    const userPrompt = document.getElementById('wv-gen-prompt')?.value?.trim() || '';

    _setLoading(true, '正在生成开场…');

    let sysPrompt = PROMPTS.step5;
    let contextParts = [`## 世界观设定\n${s1.setting || ''}`];
    if (regions.length) {
      contextParts.push(`## 地区\n${regions.map(r => `### ${r.name}\n${r.description || ''}`).join('\n\n')}`);
    }
    if (npcs.length) {
      contextParts.push(`## 角色\n${npcs.map(n => `- ${n.name}（${n.identity || ''}）：${n.detail?.substring(0, 100) || ''}…`).join('\n')}`);
    }
    const userMsg = `${userPrompt ? '用户要求：' + userPrompt + '\n\n' : ''}${contextParts.join('\n\n')}`;

    try {
      _abortCtrl = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal });
      const data = _parseJSON(raw);
      _genData.step5 = { ...data, _userPrompt: userPrompt };
      _setLoading(false);
      _step = 99;
      _renderStep();
    } catch (e) {
      _setLoading(false);
      if (e.name === 'AbortError') return;
      UI.showToast('生成失败: ' + e.message, 3000);
    }
  }

  // ---- 完成：写入 ----
  function _renderDone(body) {
    const s1 = _genData.step1 || {};
    const regionCount = (_genData.step2?.regions || s1.regions || []).length;
    const facCount = Object.values(_genData.step3?.factions || {}).reduce((s, a) => s + a.length, 0);
    const npcCount = (_genData.step4?.npcs || []).length;
    const hasStart = !!_genData.step5?.startTime;

    body.innerHTML = `
      <div class="wv-gen-step-card">
        <div class="wv-gen-step-title">${_svg('check')}<span>生成完毕</span></div>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.6">
          <div><b>${Utils.escapeHtml(s1.name || '新世界观')}</b> — ${Utils.escapeHtml(s1.description || '')}</div>
          <div style="margin-top:8px">
            ${regionCount ? `${_svg('pin', 'wv-gen-mini-svg')} ${regionCount} 个地区` : ''}
            ${facCount ? ` · ${_svg('castle', 'wv-gen-mini-svg')} ${facCount} 个势力` : ''}
            ${npcCount ? ` · ${_svg('users', 'wv-gen-mini-svg')} ${npcCount} 个角色` : ''}
            ${hasStart ? ` · ${_svg('film', 'wv-gen-mini-svg')} 开场已就绪` : ''}
          </div>
        </div>
      </div>
      <div class="wv-gen-summary">
        点击「创建」将生成完整世界观并跳转到编辑页面，你可以在那里继续调整。
      </div>
      <div class="wv-gen-actions">
        <button onclick="WvGenerator.close()" class="wv-gen-btn">取消</button>
        <button onclick="WvGenerator._commit()" class="wv-gen-btn primary">创建世界观</button>
      </div>`;
  }

  async function _commit() {
    const s1 = _genData.step1 || {};
    const regions = _genData.step2?.regions || s1.regions || [];
    const factions = _genData.step3?.factions || {};
    const npcs = _genData.step4?.npcs || [];
    const start = _genData.step5 || {};

    // 创建世界观
    const id = 'wv_' + Utils.uuid().slice(0, 8);
    const wv = {
      id,
      name: s1.name || '新世界观',
      description: s1.description || '',
      icon: 'world',
      iconImage: '',
      setting: s1.setting || '',
      currency: s1.currency || { name: '', desc: '' },
      phoneApps: { takeout: { name: '', desc: '' }, shop: { name: '', desc: '' }, forum: { name: '', desc: '' } },
      startTime: start.startTime || '',
      startPlot: start.startPlot || '',
      startPlotRounds: 5,
      startMessage: start.startMessage || '',
      regions: [],
      globalNpcs: [],
      festivals: [],
      knowledges: [],
      events: []
    };

    // 构建 regions + factions + npcs
    if (regions.length) {
      wv.regions = regions.map(r => {
        const regionFacs = (factions[r.name] || []).map(f => ({
          name: f.name || '',
          summary: f.description || '',
          detail: f.setting || '',
          npcs: []
        }));
        // 如果没势力，建一个默认
        if (!regionFacs.length) {
          regionFacs.push({ name: '默认势力', summary: '', detail: '', npcs: [] });
        }
        return {
          name: r.name || '',
          summary: r.description || '',
          detail: r.setting || '',
          factions: regionFacs
        };
      });
    }

    // 分配 NPC
    for (const npc of npcs) {
      const npcObj = {
        name: npc.name || '',
        aliases: npc.alias || '',
        summary: npc.identity || '',
        detail: npc.detail || '',
        avatar: ''
      };

      if (!npc.region || !wv.regions.length) {
        // 全图角色
        wv.globalNpcs.push(npcObj);
      } else {
        // 找到对应地区和势力
        const reg = wv.regions.find(r => r.name === npc.region);
        if (!reg) { wv.globalNpcs.push(npcObj); continue; }
        const fac = npc.faction ? reg.factions.find(f => f.name === npc.faction) : reg.factions[0];
        if (fac) { fac.npcs.push(npcObj); } else { (reg.factions[0] || { npcs: wv.globalNpcs }).npcs.push(npcObj); }
      }
    }

    // 写入 DB
    const list = await getWorldviewList();
    list.push({ id, name: wv.name, description: wv.description, icon: wv.icon, iconImage: '' });
    await saveWorldviewList(list);
    await DB.put('worldviews', wv);

    close();
    await Worldview.load();
    Worldview.openEdit(id);
    UI.showToast('世界观已创建，可在编辑页继续调整', 2000);
  }

  // DB 访问（复用 worldview.js 的）
  async function getWorldviewList() {
    const raw = await DB.get('gameState', 'worldviewList');
    return raw?.value || [];
  }
  async function saveWorldviewList(list) {
    await DB.put('gameState', { key: 'worldviewList', value: list });
  }

  // ---- 跳过 ----
  function _skipStep() {
    const hasRegions = (_genData.step2?.regions || _genData.step1?.regions || []).length > 0;
    if (_step === 2) { _step = hasRegions ? 3 : 4; } // 有地区 → 势力；无地区 → 角色
    else if (_step === 3) { _step = 4; }
    else if (_step === 4) { _step = 5; }
    else if (_step === 5) { _step = 99; }
    _renderStep();
  }

  // ---- Loading 状态 ----
  function _setLoading(on, msg) {
    const status = document.getElementById('wv-gen-status');
    const btn = document.getElementById('wv-gen-submit');
    if (status) {
      status.style.display = on ? '' : 'none';
      status.innerHTML = on ? `<span class="wv-gen-spinner"></span>${msg || ''}` : '';
    }
    if (btn) {
      btn.disabled = on;
      btn.style.opacity = on ? '0.5' : '1';
    }
  }

  // ========== 内联生成（编辑页内使用）==========

  /** 基础设定内联生成 */
  async function inlineSetting() {
    const settingEl = document.getElementById('wv-setting');
    if (!settingEl) return;
    const desc = document.getElementById('wv-description')?.value?.trim() || '';
    const existingSetting = settingEl.value?.trim() || '';
    const prompt = await _promptText('AI 生成设定', '描述你想要的世界观（已有设定会作为参考）\n如：赛博朋克废土、现代校园恋爱…', desc);
    if (prompt === null) return;
    if (!prompt.trim()) { UI.showToast('请输入描述', 1500); return; }

    UI.showToast('正在生成设定…', 60000);
    try {
      const sysPrompt = PROMPTS.step1
        .replace('##WORD_COUNT##', 2500)
        .replace('##REGION_INSTRUCTION##', '')
        .replace('##REGION_SETTING_NOTE##', '简要带过或跳过');
      const userMsg = prompt.trim() + (existingSetting ? '\n\n## 现有设定（参考/重写）\n' + existingSetting : '');
      const raw = await API.generate(sysPrompt, userMsg);
      const data = _parseJSON(raw);
      if (data.name) { const nameEl = document.getElementById('wv-name'); if (nameEl && !nameEl.value.trim()) nameEl.value = data.name; }
      if (data.description) { const descEl = document.getElementById('wv-description'); if (descEl && !descEl.value.trim()) descEl.value = data.description; }
      if (data.setting) { settingEl.value = data.setting; settingEl.style.height = 'auto'; settingEl.style.height = settingEl.scrollHeight + 'px'; }
      if (data.currency?.name) { const cn = document.getElementById('wv-currency-name'); const cd = document.getElementById('wv-currency-desc'); if (cn) cn.value = data.currency.name; if (cd) cd.value = data.currency.desc || ''; }
      UI.showToast('设定已生成，可继续编辑', 2000);
    } catch (e) {
      UI.showToast('生成失败: ' + e.message, 3000);
    }
  }

  /** 开场内联生成 */
  async function inlineOpening() {
    const settingEl = document.getElementById('wv-setting');
    const setting = settingEl?.value?.trim() || '';
    if (!setting) { UI.showToast('请先填写世界观设定', 1500); return; }

    const prompt = await _promptText('AI 生成开场', '对开场有什么要求？留空则由 AI 自由发挥\n如：从选灵根开始、酒馆偶遇…', '');
    if (prompt === null) return;

    UI.showToast('正在生成开场…', 60000);
    try {
      const userMsg = (prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : '') + '## 世界观设定\n' + setting;
      const raw = await API.generate(PROMPTS.step5, userMsg);
      const data = _parseJSON(raw);
      if (data.startTime) { const el = document.getElementById('wv-start-time'); if (el) el.value = data.startTime; }
      if (data.startPlot) { const el = document.getElementById('wv-start-plot'); if (el) { el.value = data.startPlot; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }
      if (data.startMessage) { const el = document.getElementById('wv-start-message'); if (el) { el.value = data.startMessage; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }
      UI.showToast('开场已生成，可继续编辑', 2000);
    } catch (e) {
      UI.showToast('生成失败: ' + e.message, 3000);
    }
  }

  /** 地区内联生成（在详细设定tab内，为当前世界观批量生成地区） */
  async function inlineRegions() {
    const settingEl = document.getElementById('wv-setting');
    const setting = settingEl?.value?.trim() || '';
    if (!setting) { UI.showToast('请先填写世界观设定', 1500); return; }

    await _openInlineGenModal({
      icon: 'globe',
      title: 'AI 追加地区',
      desc: '为当前世界观批量生成地区',
      placeholder: '对地区有什么要求？留空则由 AI 自由发挥',
      countLabel: '生成地区数',
      defaults: { count: 5, wordCount: 300 },
      limits: { count: [1, 20], wordCount: [100, 1000] },
      loadingMsg: '正在生成地区…'
    }, async ({ prompt, count, wordCount, signal }) => {
      const sysPrompt = PROMPTS.step2.replace('##WORD_COUNT##', wordCount).replace('##EXISTING_REGIONS##', '');
      const userMsg = (prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : '') + `生成 ${count} 个地区。\n\n## 世界观设定\n` + setting;
      const raw = await API.generate(sysPrompt, userMsg, { signal });
      const regions = _parseJSON(raw);
      const arr = Array.isArray(regions) ? regions : (regions.regions || []);
      if (typeof Worldview !== 'undefined' && Worldview._getEditingWV) {
        const w = await Worldview._getEditingWV();
        if (w) {
          for (const r of arr) {
            w.regions.push({
              name: r.name || '',
              summary: r.description || '',
              detail: r.setting || '',
              factions: [{ name: '默认势力', summary: '', detail: '', npcs: [] }]
            });
          }
          await Worldview._saveEditingWV(w);
          Worldview._renderRegions(w.regions);
          Worldview.switchEditTab('detail');
        }
      }
      if (arr.length === 0) throw new Error("AI返回了空结构（看console原文）"); UI.showToast(`已生成 ${arr.length} 个地区`, 2000);
    });
  }

  /** 当前地区追加势力（一次调用） */
  async function inlineFactions() {
    const w = await Worldview._getEditingWV();
    if (!w) return;
    const regName = document.getElementById('wv-reg-name')?.value?.trim();
    if (!regName) { UI.showToast('请先填写/打开地区', 1500); return; }

    await _openInlineGenModal({
      icon: 'castle',
      title: 'AI 追加势力',
      desc: `为地区「${regName}」批量生成势力`,
      placeholder: '对势力有什么要求？留空则由 AI 自由发挥',
      countLabel: '生成势力数',
      defaults: { count: 5, wordCount: 500 },
      limits: { count: [1, 20], wordCount: [200, 1200] },
      loadingMsg: '正在生成势力…'
    }, async ({ prompt, count, wordCount, signal }) => {
      const sysPrompt = PROMPTS.step3.replace('##WORD_COUNT##', wordCount);
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}为地区「${regName}」生成 ${count} 个势力。\n\n## 世界观设定\n${w.setting || ''}\n\n## 当前地区\n${regName}\n${document.getElementById('wv-reg-detail')?.value || ''}`;
      const raw = await API.generate(sysPrompt, userMsg, { signal, maxTokens: 16000 });
      const data = _parseJSON(raw);
      const arr = _normalizeArray(data, 'factions');
      const reg = w.regions.find(r => r.name === regName);
      if (!reg) { UI.showToast('找不到当前地区，请先保存地区名称', 2000); return; }
      reg.factions = reg.factions || [];
      arr.forEach(f => reg.factions.push({ name: f.name || '', summary: f.description || '', detail: f.setting || '', npcs: [] }));
      await Worldview._saveEditingWV(w);
      if (Worldview._renderFactionCards) Worldview._renderFactionCards(reg.factions);
      if (arr.length === 0) throw new Error("AI返回了空结构（看console原文）"); UI.showToast(`已生成 ${arr.length} 个势力`, 2000);
    });
  }

  /** 当前势力追加角色 */
  async function inlineFactionNpcs() {
    const w = await Worldview._getEditingWV();
    if (!w) return;
    const facName = document.getElementById('wv-fac-name')?.value?.trim();
    if (!facName) { UI.showToast('请先填写/打开势力', 1500); return; }

    await _openInlineGenModal({
      icon: 'users',
      title: 'AI 追加角色',
      desc: `为势力「${facName}」批量生成角色`,
      placeholder: '对角色有什么要求？留空则由 AI 自由发挥',
      countLabel: '生成角色数',
      defaults: { count: 5, wordCount: 500 },
      limits: { count: [1, 30], wordCount: [200, 1500] },
      loadingMsg: '正在生成角色…'
    }, async ({ prompt, count, wordCount, signal }) => {
      const sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}为势力「${facName}」生成 ${count} 个角色。角色 region/faction 字段必须对应当前地区和势力。\n\n## 世界观设定\n${w.setting || ''}\n\n## 当前势力\n${facName}\n${document.getElementById('wv-fac-detail')?.value || ''}`;
      const raw = await API.generate(sysPrompt, userMsg, { signal, maxTokens: 18000 });
      const data = _parseJSON(raw);
      const arr = _normalizeArray(data, 'npcs');
      let fac = null;
      for (const r of (w.regions || [])) { fac = (r.factions || []).find(f => f.name === facName); if (fac) break; }
      if (!fac) { UI.showToast('找不到当前势力，请先保存势力名称', 2000); return; }
      fac.npcs = fac.npcs || [];
      arr.forEach(n => fac.npcs.push({ name: n.name || '', aliases: n.alias || '', summary: n.identity || n.description || '', detail: n.detail || '', avatar: '' }));
      await Worldview._saveEditingWV(w);
      if (Worldview._renderNPCCards) Worldview._renderNPCCards(fac.npcs);
      if (arr.length === 0) throw new Error("AI返回了空结构（看console原文）"); UI.showToast(`已生成 ${arr.length} 个角色`, 2000);
    });
  }

  /** 全图NPC内联生成 */
  async function inlineGlobalNpcs() {
    const settingEl = document.getElementById('wv-setting');
    const setting = settingEl?.value?.trim() || '';
    if (!setting) { UI.showToast('请先填写世界观设定', 1500); return; }

    await _openInlineGenModal({
      icon: 'users',
      title: 'AI 追加常驻角色',
      desc: '为当前世界观批量生成全图常驻角色',
      placeholder: '对角色有什么要求？留空则由 AI 自由发挥',
      countLabel: '生成角色数',
      defaults: { count: 5, wordCount: 500 },
      limits: { count: [1, 30], wordCount: [200, 1500] },
      loadingMsg: '正在生成角色…'
    }, async ({ prompt, count, wordCount, signal }) => {
      const sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);
      const userMsg = (prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : '') + `生成 ${count} 个角色。所有角色都是常驻角色（不归属地区）。\n\n## 世界观设定\n` + setting;
      const raw = await API.generate(sysPrompt, userMsg, { signal });
      const npcs = _parseJSON(raw);
      const arr = Array.isArray(npcs) ? npcs : (npcs.npcs || []);
      if (typeof Worldview !== 'undefined' && Worldview._getEditingWV) {
        const w = await Worldview._getEditingWV();
        if (w) {
          if (!w.globalNpcs) w.globalNpcs = [];
          for (const npc of arr) {
            w.globalNpcs.push({
              name: npc.name || '',
              aliases: npc.alias || '',
              summary: npc.identity || '',
              detail: npc.detail || '',
              avatar: ''
            });
          }
          await Worldview._saveEditingWV(w);
          if (Worldview._renderGlobalNpcs) Worldview._renderGlobalNpcs(w.globalNpcs);
        }
      }
      if (arr.length === 0) throw new Error("AI返回了空结构（看console原文）"); UI.showToast(`已生成 ${arr.length} 个常驻角色`, 2000);
    });
  }

  /** 单条地区填充（在地区编辑面板内） */
  async function inlineFillRegion() {
    const name = document.getElementById('wv-reg-name')?.value?.trim();
    if (!name) { UI.showToast('请先填写地区名称', 1500); return; }
    const w = await Worldview._getEditingWV();
    const setting = w?.setting || '';
    if (!setting) { UI.showToast('请先填写世界观设定', 1500); return; }

    await _openInlineGenModal({
      icon: 'globe',
      title: 'AI 填充本地区',
      desc: `为地区「${name}」生成详细设定`,
      placeholder: '对本地区有什么要求？留空则由 AI 自由发挥',
      countLabel: '生成数量（固定 1）',
      defaults: { count: 1, wordCount: 300 },
      limits: { count: [1, 1], wordCount: [100, 1000] },
      loadingMsg: `正在为「${name}」生成设定…`
    }, async ({ prompt, wordCount, signal }) => {
      const sysPrompt = PROMPTS.step2.replace('##WORD_COUNT##', wordCount).replace('##EXISTING_REGIONS##', '');
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}仅生成 1 个地区「${name}」的详细设定。\n\n## 世界观设定\n${setting}`;
      const raw = await API.generate(sysPrompt, userMsg, { signal });
      _lastRawOutput = raw;
      const arr = _parseJSON(raw);
      const r = Array.isArray(arr) ? arr[0] : arr;
      if (!r) throw new Error('AI返回了空结构（看console原文）');
      const desc = document.getElementById('wv-reg-summary');
      const detail = document.getElementById('wv-reg-detail');
      if (desc && !desc.value.trim() && r.description) desc.value = r.description;
      if (detail && r.setting) { detail.value = r.setting; detail.style.height = 'auto'; detail.style.height = detail.scrollHeight + 'px'; }
      UI.showToast('地区设定已填充', 2000);
    });
  }

  /** 单条势力填充 */
  async function inlineFillFaction() {
    const name = document.getElementById('wv-fac-name')?.value?.trim();
    if (!name) { UI.showToast('请先填写势力名称', 1500); return; }
    const w = await Worldview._getEditingWV();
    const setting = w?.setting || '';
    if (!setting) { UI.showToast('请先填写世界观设定', 1500); return; }

    await _openInlineGenModal({
      icon: 'castle',
      title: 'AI 填充本势力',
      desc: `为势力「${name}」生成详细设定`,
      placeholder: '对本势力有什么要求？留空则由 AI 自由发挥',
      countLabel: '生成数量（固定 1）',
      defaults: { count: 1, wordCount: 500 },
      limits: { count: [1, 1], wordCount: [200, 1200] },
      loadingMsg: `正在为「${name}」生成设定…`
    }, async ({ prompt, wordCount, signal }) => {
      const sysPrompt = PROMPTS.step3.replace('##WORD_COUNT##', wordCount);
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}仅生成 1 个势力「${name}」的详细设定。\n\n## 世界观设定\n${setting}`;
      const raw = await API.generate(sysPrompt, userMsg, { signal });
      _lastRawOutput = raw;
      const arr = _parseJSON(raw);
      const f = Array.isArray(arr) ? arr[0] : arr;
      if (!f) throw new Error('AI返回了空结构（看console原文）');
      const summary = document.getElementById('wv-fac-summary');
      const detail = document.getElementById('wv-fac-detail');
      if (summary && !summary.value.trim() && f.description) summary.value = f.description;
      if (detail && f.setting) { detail.value = f.setting; detail.style.height = 'auto'; detail.style.height = detail.scrollHeight + 'px'; }
      UI.showToast('势力设定已填充', 2000);
    });
  }

  /** 单条NPC填充 */
  async function inlineFillNpc() {
    const name = document.getElementById('wv-npc-name')?.value?.trim();
    if (!name) { UI.showToast('请先填写角色名称', 1500); return; }
    const w = await Worldview._getEditingWV();
    const setting = w?.setting || '';
    if (!setting) { UI.showToast('请先填写世界观设定', 1500); return; }

    await _openInlineGenModal({
      icon: 'users',
      title: 'AI 填充本角色',
      desc: `为角色「${name}」生成详细设定`,
      placeholder: '对本角色有什么要求？留空则由 AI 自由发挥',
      countLabel: '生成数量（固定 1）',
      defaults: { count: 1, wordCount: 500 },
      limits: { count: [1, 1], wordCount: [200, 1500] },
      loadingMsg: `正在为「${name}」生成设定…`
    }, async ({ prompt, wordCount, signal }) => {
      const sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);
      const identity = document.getElementById('wv-npc-summary')?.value?.trim() || '';
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}仅生成 1 个角色「${name}」${identity ? '（' + identity + '）' : ''}的详细设定。\n\n## 世界观设定\n${setting}`;
      const raw = await API.generate(sysPrompt, userMsg, { signal });
      _lastRawOutput = raw;
      const arr = _parseJSON(raw);
      const n = Array.isArray(arr) ? arr[0] : arr;
      if (!n) throw new Error('AI返回了空结构（看console原文）');
      const detail = document.getElementById('wv-npc-detail');
      if (detail && n.detail) { detail.value = n.detail; detail.style.height = 'auto'; detail.style.height = detail.scrollHeight + 'px'; }
      const aliases = document.getElementById('wv-npc-aliases');
      const summary = document.getElementById('wv-npc-summary');
      if (aliases && !aliases.value.trim() && n.alias) aliases.value = n.alias;
      if (summary && !summary.value.trim() && (n.identity || n.description)) summary.value = n.identity || n.description || '';
      UI.showToast('角色设定已填充', 2000);
    });
  }

  /** 批量填充已有地区（只填 setting 为空的，一次请求） */
  async function inlineFillAllRegions() {
    const w = await Worldview._getEditingWV();
    if (!w) return;
    const setting = w.setting || '';
    if (!setting) { UI.showToast('请先填写世界观设定', 1500); return; }
    const empty = w.regions.filter(r => !r.detail?.trim() && r.name?.trim());
    if (!empty.length) { UI.showToast('没有需要填充的地区（所有地区都已有设定）', 2000); return; }

    await _openInlineGenModal({
      icon: 'globe',
      title: 'AI 填充已有地区',
      desc: `为 ${empty.length} 个空白地区（${empty.map(r=>r.name).join('、')}）一次性生成设定`,
      placeholder: '对地区有什么要求？留空则由 AI 自由发挥',
      countLabel: '地区数（自动）',
      defaults: { count: empty.length, wordCount: 300 },
      limits: { count: [empty.length, empty.length], wordCount: [100, 1000] },
      loadingMsg: `正在为 ${empty.length} 个地区生成设定…`
    }, async ({ prompt, wordCount, signal }) => {
      const sysPrompt = PROMPTS.step2.replace('##WORD_COUNT##', wordCount).replace('##EXISTING_REGIONS##',
        `\n## 必须对齐的地区\n${empty.map(r => r.name).join('、')}`);
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}为以下地区生成设定（共 ${empty.length} 个，每个约 ${wordCount} 字）：${empty.map(r => r.name).join('、')}。\n\n## 世界观设定\n${setting}`;
      const raw = await API.generate(sysPrompt, userMsg, { signal, maxTokens: Math.min(20000, empty.length * wordCount * 4 + 2000) });
      _lastRawOutput = raw;
      const arr = _normalizeArray(_parseJSON(raw), 'regions');
      if (!arr.length) throw new Error('AI返回了空结构（看console原文）');
      let filled = 0;
      for (const r of arr) {
        const target = w.regions.find(reg => reg.name === r.name);
        if (target && !target.detail?.trim()) {
          if (r.description && !target.summary?.trim()) target.summary = r.description;
          if (r.setting) { target.detail = r.setting; filled++; }
        }
      }
      await Worldview._saveEditingWV(w);
      Worldview._renderRegions(w.regions);
      Worldview.switchEditTab('detail');
      UI.showToast(`已填充 ${filled}/${empty.length} 个地区`, 2500);
    });
  }

  /** 批量填充已有全图NPC（一次请求） */
  async function inlineFillAllGlobalNpcs() {
    const w = await Worldview._getEditingWV();
    if (!w) return;
    const setting = w.setting || '';
    if (!setting) { UI.showToast('请先填写世界观设定', 1500); return; }
    const empty = (w.globalNpcs || []).filter(n => !n.detail?.trim() && n.name?.trim());
    if (!empty.length) { UI.showToast('没有需要填充的角色（所有角色都已有设定）', 2000); return; }

    await _openInlineGenModal({
      icon: 'users',
      title: 'AI 填充已有角色',
      desc: `为 ${empty.length} 个空白角色（${empty.map(n=>n.name).join('、')}）一次性生成设定`,
      placeholder: '对角色有什么要求？留空则由 AI 自由发挥',
      countLabel: '角色数（自动）',
      defaults: { count: empty.length, wordCount: 500 },
      limits: { count: [empty.length, empty.length], wordCount: [200, 1500] },
      loadingMsg: `正在为 ${empty.length} 个角色生成设定…`
    }, async ({ prompt, wordCount, signal }) => {
      const sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);
      const names = empty.map(n => n.name + (n.summary ? '（' + n.summary + '）' : '')).join('、');
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}为以下角色生成详细设定（共 ${empty.length} 个，每个约 ${wordCount} 字）：${names}。所有角色都是常驻角色。\n\n## 世界观设定\n${setting}`;
      const raw = await API.generate(sysPrompt, userMsg, { signal, maxTokens: Math.min(20000, empty.length * wordCount * 4 + 2000) });
      _lastRawOutput = raw;
      const arr = _normalizeArray(_parseJSON(raw), 'npcs');
      if (!arr.length) throw new Error('AI返回了空结构（看console原文）');
      let filled = 0;
      for (const n of arr) {
        const target = w.globalNpcs.find(g => g.name === n.name);
        if (target && !target.detail?.trim()) {
          if (n.detail) { target.detail = n.detail; filled++; }
          if (n.alias && !target.aliases?.trim()) target.aliases = n.alias;
          if ((n.identity || n.description) && !target.summary?.trim()) target.summary = n.identity || n.description || '';
        }
      }
      await Worldview._saveEditingWV(w);
      Worldview._renderGlobalNpcs(w.globalNpcs);
      UI.showToast(`已填充 ${filled}/${empty.length} 个角色`, 2500);
    });
  }

  return {
    open,
    close,
    _onRegionToggle,
    _runStep1,
    _runStep2,
    _runStep3,
    _runStep4,
    _runStep5,
    _skipStep,
    _commit,
    inlineSetting,
    inlineOpening,
    inlineRegions,
    inlineFactions,
    inlineFactionNpcs,
    inlineGlobalNpcs,
    inlineFillRegion,
    inlineFillFaction,
    inlineFillNpc,
    inlineFillAllRegions,
    inlineFillAllGlobalNpcs
  };
})();
