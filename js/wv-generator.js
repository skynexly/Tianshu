/**
 * 世界观写卡助手 — AI 分步生成
 * Step 1: 基础设定  Step 2: 地区  Step 3: 势力  Step 4: 角色  Step 5: 开场
 */
const WvGenerator = (() => {
  const REGION_COUNT_MAX = 12;

  // 给需求描述 textarea 包一层容器 + 右下角全屏展开按钮（配 Utils.openFullscreen）。
  // taHtml：原 textarea 的 HTML 字符串；id：该 textarea 的 id；title：全屏弹窗标题。
  function _fsWrap(taHtml, id, title) {
    const t = (title || '').replace(/'/g, "\\'");
    return `<div class="wv-gen-fs-wrap">${taHtml}<button type="button" class="wv-gen-fs-btn" onclick="Utils.openFullscreen('${id}','${t}')"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg></button></div>`;
  }

  function _clampRegionCount(raw, inputId) {
    const n = parseInt(raw, 10);
    const val = Math.min(REGION_COUNT_MAX, Math.max(1, Number.isFinite(n) ? n : 5));
    if (inputId) {
      const el = document.getElementById(inputId);
      if (el && String(el.value) !== String(val)) el.value = val;
    }
    if (Number.isFinite(n) && n > REGION_COUNT_MAX) {
      try { UI.showToast(`地区数量最多 ${REGION_COUNT_MAX} 个，已自动调整`, 1800); } catch(_) {}
    }
    return val;
  }

  function _limitRegions(list) {
    return Array.isArray(list) ? list.slice(0, REGION_COUNT_MAX) : [];
  }

  function _enforceCountInput(inputId, max, label, finalCheck, min = 1) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const raw = String(el.value || '').trim();
    if (!raw) return;
    const n = parseInt(raw, 10);
    const safeMax = Number.isFinite(Number(max)) ? Number(max) : REGION_COUNT_MAX;
    const safeMin = Number.isFinite(Number(min)) ? Number(min) : 1;
    if (Number.isFinite(n) && n > safeMax) {
      el.value = safeMax;
      try { UI.showToast(`${label || '数量'}最多 ${safeMax} 个，已自动调整`, 1500); } catch(_) {}
    } else if (finalCheck && (!Number.isFinite(n) || n < safeMin)) {
      el.value = safeMin;
    }
  }

  function _enforceRegionCountInput(inputId, finalCheck) {
    _enforceCountInput(inputId, REGION_COUNT_MAX, '地区数量', finalCheck, 1);
  }

  // ---- 提示词模板 ----
  const PROMPTS = {
    step1: `你是一个世界观架构师。根据用户的描述，生成一个完整的虚构世界观基础设定。

## 输出要求
严格输出 JSON，不要输出任何 JSON 以外的内容（不要用 \`\`\`json 包裹）。
字段：
- name（string）：世界观名称（中文主名，外文名/缩写写在 description 或 setting 里，不要堆在 name 里）
- description（string）：一句话简介，50字以内
- setting（string）：核心设定文本，详见下方规范
- currency（object: {name, desc}）：仅当题材**明确需要**非现实货币体系时输出（如奇幻/古代/末世/异世界）。**现代日常、校园、都市恋爱等题材绝对不要输出此字段**，留空即可。desc 必须说明基础单位与购买力，并举例常见消费价格，例如"一顿普通餐食约 8-12 枚""普通旅店一晚约 30 枚""工人日薪约 80 枚"等；不要只写抽象设定。
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
- name（string）：地区名（中文主名，**只写一个名字**，不要中英双语堆在一起；外文名/缩写写到 setting 里说明）
- description（string）：50字以内概述（用于速查表）
- setting（string）：地区详细设定，目标约 ##WORD_COUNT## 字

setting 使用 Markdown 格式，按需包含以下内容：
### 地理位置
在世界中的方位、地形地貌、气候特征
（如有外文名/别名/旧称，在这里说明：例如"星栎城（外文名 Astoria，旧称银光城）"）

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
严格输出 JSON 数组，不要用 \`\`\`json 包裹，不要输出任何 JSON 以外的内容。
确保 JSON 结构完整——每个对象的所有字段和括号必须闭合，数组末尾必须有 ]。
如果内容较多，宁可缩减 detail 字数也不要输出不完整的 JSON。
每个角色包含：
- name（string）：姓名（中文主名，外文名/原名/罗马音不要堆在 name 里，写在 aliases）
- aliases（string）：别称/代号/外文名/原名/小名，没有则留空字符串。多个用逗号或顿号分隔（如"影、Agent-7、Shadow"）
- age（string）：年龄
- gender（string）：性别
- profession（string）：**具体职业**，写 ta 实际在做什么、靠什么吃饭。例如"咖啡店店员""第三舰队副官""街头小偷""高中二年级学生""自由佣兵""退休教师"。**不要写成"商会成员""学院的人"这种笼统说法**。无业/学生/退休等也要明写。
- identity（string）：**身份地位**，社会阶层或公开标签，例如"贵族""平民""王室次子""通缉犯""转校生""市议员的女儿"。和 profession 是不同维度——profession 是"干什么"，identity 是"是谁/什么身份"。
- faction（string）：所属势力名称（对应已有势力，无势力则留空）
- region（string）：所属地区名称（无地区则留空——归为全图角色）
- summary（string）：速查简介，格式固定为「性别·年龄·发色瞳色·身份职业·性格」，例如"男·26岁·黑发金瞳·白氏集团董事长·冷漠强势"或"女·19岁·棕发棕瞳·大学新生·温柔内敛"。身份职业尽量简短（10字以内），性格8字以内。
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

角色之间应有差异性，避免性格/身份/职业雷同——同一个咖啡店里也可以有店长、烘焙师、收银员、外卖员等不同分工。
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
  // v711：每步各自勾选的"参考世界书" id 数组（Step1~5 各存各的；inline=编辑页分块生成，沿用上次选择）
  let _refLorebooks = { 1: [], 2: [], 3: [], 4: [], 5: [], inline: [] };

  // 打开世界书多选弹窗（复用全站通用组件），选完刷新按钮文字
  async function _pickRefLorebooks(step) {
    if (typeof LorebookUI === 'undefined' || !LorebookUI.openBindPicker) {
      UI.showToast('世界书 UI 未就绪', 1800);
      return;
    }
    await LorebookUI.openBindPicker(_refLorebooks[step] || [], async (next) => {
      _refLorebooks[step] = Array.from(new Set(next || []));
      await _refreshRefLorebookBtn(step);
    });
  }

  // 刷新某步"参考世界书"按钮上显示的已选名字
  async function _refreshRefLorebookBtn(step) {
    const el = document.getElementById('wv-gen-ref-lb-label');
    if (!el) return;
    const ids = _refLorebooks[step] || [];
    if (ids.length === 0) { el.textContent = '选择参考世界书'; return; }
    let names = [];
    try {
      for (const id of ids) {
        const lb = (typeof Lorebook !== 'undefined') ? await Lorebook.get(id) : null;
        if (lb) names.push(lb.name || '未命名');
      }
    } catch(_) {}
    el.textContent = names.length ? `参考世界书：${names.join('、')}` : `已选 ${ids.length} 本世界书`;
  }

  // 生成某步表单里的"参考世界书"长条按钮 HTML（放在额外要求输入框下面）
  function _refLorebookBtnHtml(step) {
    return `<div class="wv-gen-field">
      <button type="button" class="wv-gen-ref-lb-btn" onclick="WvGenerator._pickRefLorebooks('${step}')">
        ${_svg('book', 'wv-gen-ref-lb-icon')}
        <span id="wv-gen-ref-lb-label">选择参考世界书</span>
      </button>
    </div>`;
  }

  // 拼某步选中的世界书内容（有什么发什么），追加到 AI 上下文
  async function _buildLorebookRefText(step) {
    const ids = _refLorebooks[step] || [];
    if (ids.length === 0 || typeof Lorebook === 'undefined') return '';
    const books = [];
    for (const id of ids) {
      let lb = null;
      try { lb = await Lorebook.get(id); } catch(_) {}
      if (!lb) continue;
      const parts = [`### 《${lb.name || '未命名世界书'}》`];
      if (lb.description && lb.description.trim()) parts.push(lb.description.trim());
      const kn = (lb.knowledges || []).filter(k => k && k.content);
      kn.forEach(k => parts.push(`#### 条目：${k.name || '未命名'}\n${k.content}`));
      const npcs = (lb.globalNpcs || []).filter(n => n && n.name);
      npcs.forEach(n => {
        const sm = _npcSummary(n);
        const dt = (n.detail || '').trim();
        parts.push(`#### 角色：${n.name}${sm ? '（' + sm + '）' : ''}${dt ? '\n' + dt : ''}`);
      });
      const fes = (lb.festivals || []).filter(f => f && f.name);
      fes.forEach(f => parts.push(`#### 节日：${f.name}${f.description ? '\n' + f.description : ''}`));
      if (parts.length > 1) books.push(parts.join('\n\n'));
    }
    if (books.length === 0) return '';
    return `\n\n## 参考世界书（请遵循这些设定/指令）\n${books.join('\n\n')}`;
  }

  // ---- 工具函数 ----
  // 存最近一次 AI 原始输出，方便失败时复盘
  let _lastRawOutput = '';

  // 统一处理 AI 输出的 NPC 字段：兼容 alias/aliases
  function _npcAliases(n) {
    return (n.aliases || n.alias || '').trim();
  }
  // summary：速查表，优先用 AI 返回的 summary 字段，没有时从 gender·age·profession·identity 拼接
function _npcSummary(n) {
  if (n.summary?.trim()) return n.summary.trim();
  const parts = [n.gender, n.age, n.profession, n.identity || n.description].filter(Boolean);
  return parts.join(' · ');
}
  // v687.41j：detail 头部追加 markdown 元信息块（性别/年龄/职业/身份）
  // 让世界书（无 summary）也能直接看到角色基础信息
  function _npcMetaBlock(n) {
    const parts = [];
    if (n.gender) parts.push(`**性别**：${n.gender}`);
    if (n.age) parts.push(`**年龄**：${n.age}`);
    if (n.profession) parts.push(`**职业**：${n.profession}`);
    if (n.identity || n.description) parts.push(`**身份**：${n.identity || n.description}`);
    return parts.length ? parts.join('  \n') : '';
  }
  function _mergeMetaToDetail(n) {
    const meta = _npcMetaBlock(n);
    const detail = (n.detail || '').trim();
    if (!meta && !detail) return '';
    if (!meta) return detail;
    if (!detail) return meta;
    return meta + '\n\n' + detail;
  }

  // v632.1：收集当前世界观/世界书里所有已有的 NPC 名字，用于生成时防撞名
  // 返回格式：[{ name, source }]，source 形如 "常驻"/"地区A·势力B"
  function _collectAllNpcNames(w) {
    if (!w) return [];
    const out = [];
    (w.globalNpcs || []).forEach(n => {
      if (n && n.name) out.push({ name: n.name, source: '常驻' });
    });
    (w.regions || []).forEach(r => {
      (r.factions || []).forEach(f => {
        (f.npcs || []).forEach(n => {
          if (n && n.name) out.push({ name: n.name, source: `${r.name || '未命名地区'}·${f.name || '未命名势力'}` });
        });
      });
    });
    return out;
  }
  // v711：收集当前世界观里所有已有 NPC 的完整对象（用于生成时发全量资料防止家家套同样的家人）
  // 返回 [{ npc, source }]
  function _collectAllNpcsFull(w) {
    if (!w) return [];
    const out = [];
    (w.globalNpcs || []).forEach(n => {
      if (n && n.name) out.push({ npc: n, source: '常驻' });
    });
    (w.regions || []).forEach(r => {
      (r.factions || []).forEach(f => {
        (f.npcs || []).forEach(n => {
          if (n && n.name) out.push({ npc: n, source: `${r.name || '未命名地区'}·${f.name || '未命名势力'}` });
        });
      });
    });
    return out;
  }
  // 把角色对象格式化成给 AI 看的完整"资料卡"（全量 detail，让 AI 看清谁是谁、谁跟谁什么关系）
  function _npcProfileCard(n, source) {
    const nm = n.name || '未命名';
    const src = source || n.faction || n.region || '';
    const summary = _npcSummary(n);
    const detail = (n.detail || '').trim();
    let card = `### ${nm}${src ? `（${src}）` : ''}`;
    if (summary) card += `\n${summary}`;
    if (detail) card += `\n${detail}`;
    return card;
  }

  // 把名单格式化成给 AI 看的"避免重名"提示段
  function _buildNpcDedupeHint(allNpcs, extraNames) {
    const names = [];
    (allNpcs || []).forEach(n => names.push(`${n.name}（${n.source}）`));
    (extraNames || []).forEach(name => { if (name) names.push(name); });
    if (names.length === 0) return '';
    return `\n\n## 已有角色（不要重名，也不要近似名）\n${names.join('、')}`;
  }

  // v632.1：从 worldview 或 lorebook 取 setting；世界书没有 setting 字段时用 description 兜底
function _getEditingSetting(w) {
  return (w?.setting || w?.description || '').trim();
}

// 组装完整世界上下文，供所有 inline 生成函数使用
// overrideSetting：可选，覆盖 w.setting（用于 DOM 中未保存的最新值）
function _buildWorldContext(w, taskHint, overrideSetting) {
  const parts = [];
  // 1. 世界观设定
  const setting = overrideSetting !== undefined ? overrideSetting : _getEditingSetting(w);
  if (setting) parts.push(`## 世界观设定\n${setting}`);
  // 2. 历法（有才加）
  const cal = w?.gameplay?.calendarSystem;
  if (cal) {
    const calLines = [];
    const dpm = Array.isArray(cal.daysPerMonth) ? cal.daysPerMonth : [];
    if (cal.monthsPerYear) {
      const monthStrs = Array.from({ length: cal.monthsPerYear }, (_, i) => {
        const d = typeof dpm[i] === 'number' ? dpm[i] : (cal.uniformDaysPerMonth || '?');
        return `第${i + 1}月（${d}天）`;
      });
      calLines.push(`月份共 ${cal.monthsPerYear} 个：${monthStrs.join('、')}`);
    }
    if (Array.isArray(cal.weekDayNames) && cal.weekDayNames.length) {
      calLines.push(`每周 ${cal.daysPerWeek || cal.weekDayNames.length} 天：${cal.weekDayNames.join('、')}`);
    }
    if (Array.isArray(cal.seasons) && cal.seasons.length) {
      calLines.push(`季节：${cal.seasons.map(s => `${s.name}（${Array.isArray(s.months) ? s.months.join('、') : ''}月）`).join('、')}`);
    }
    if (calLines.length) parts.push(`## 历法\n${calLines.join('\n')}`);
  }
  // 3. 地区→势力→NPC（NPC 只发 summary）
  const regions = w?.regions || [];
  if (regions.length) {
    const regLines = [];
    for (const r of regions) {
      regLines.push(`- **${r.name}**${r.summary ? '：' + r.summary : ''}`);
      for (const f of (r.factions || [])) {
        regLines.push(`  └ **${f.name}**${f.summary ? '：' + f.summary : ''}`);
        const npcs = (f.npcs || []).filter(n => n && n.name);
        if (npcs.length) regLines.push(`    角色：${npcs.map(n => n.name + (n.summary ? `（${n.summary}）` : '')).join('、')}`);
      }
    }
    parts.push(`## 地区与势力结构\n${regLines.join('\n')}`);
  }
  // 4. 常驻角色（name + summary + detail，detail 单个截断防 token 失控）
  const globals = (w?.globalNpcs || []).filter(n => n && n.name);
  if (globals.length) {
    const npcBlocks = globals.map(n => {
      const head = `### ${n.name}${n.summary ? '：' + n.summary : ''}`;
      const detail = (n.detail || '').trim();
      const detailStr = detail ? '\n' + (detail.length > 500 ? detail.slice(0, 500) + '…' : detail) : '';
      return head + detailStr;
    });
    parts.push(`## 常驻角色\n${npcBlocks.join('\n\n')}`);
  }
  // 5. 世界书条目
  const knowledges = (w?.knowledges || []).filter(k => k && k.enabled !== false && k.content);
  if (knowledges.length) parts.push(`## 世界书条目\n${knowledges.map(k => `### ${k.name || '未命名'}\n${k.content}`).join('\n\n')}`);
  // 6. 当前任务
  if (taskHint) parts.push(`## 当前任务\n${taskHint}`);
  return parts.join('\n\n');
}

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
    if (end <= start) {
      // 可能被 max_tokens 完全截断，尝试修复
      const fixed = _tryFixTruncatedJSON(cleaned.substring(start));
      if (fixed) return fixed;
      throw new Error('AI输出的JSON结构不完整（可能因token限制被截断）');
    }
    const slice = cleaned.substring(start, end + 1);
    try { return JSON.parse(slice); }
    catch(e) {
      // 截断修复：补齐括号或丢弃最后一个不完整项
      const fixed = _tryFixTruncatedJSON(cleaned.substring(start));
      if (fixed) return fixed;
      throw new Error('JSON解析失败：' + e.message);
    }
  }

  /**
   * 尝试修复被 max_tokens 截断的 JSON
   * 策略1: 补齐缺失的引号和括号
   * 策略2: 丢弃最后一个不完整的对象，只保留前面完整的部分
   */
  function _tryFixTruncatedJSON(text) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let s = text;
        if (attempt === 1) {
          // 策略2: 找最后一个 "}," 截断，丢弃不完整的尾部对象
          const idx = s.lastIndexOf('},');
          if (idx <= 0) return null;
          s = s.substring(0, idx + 1);
        }
        // 遍历计算括号差异（忽略字符串内部的括号）
        let inStr = false, esc = false, d1 = 0, d2 = 0;
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\' && inStr) { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '[') d1++;
          else if (ch === ']') d1--;
          else if (ch === '{') d2++;
          else if (ch === '}') d2--;
        }
        // 如果截断在字符串中间，先关闭引号
        if (inStr) s += '"';
        // 补齐未关闭的括号
        for (let i = 0; i < d2; i++) s += '}';
        for (let i = 0; i < d1; i++) s += ']';
        const result = JSON.parse(s);
        console.warn('[WvGen] JSON被截断，已自动修复' + (attempt === 1 ? '（丢弃了最后一个不完整项）' : ''));
        return result;
      } catch(_) { continue; }
    }
    return null;
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
        <label class="wv-gen-label">${Utils.escapeHtml(opts.promptLabel || '额外要求（可选）')}</label>
        ${_fsWrap(`<textarea id="wv-inline-prompt" rows="3" placeholder="${Utils.escapeHtml(opts.placeholder || '留空则由 AI 自由发挥')}" class="wv-gen-textarea"></textarea>`, 'wv-inline-prompt', opts.promptLabel || '额外要求')}
      </div>
      ${_refLorebookBtnHtml('inline')}
      ${(opts.hideWords && opts.hideCount) ? '' : `<div class="wv-gen-grid">
        ${opts.hideWords ? '' : `<div class="wv-gen-field">
          <label class="wv-gen-label">单条字数（≤${wcMax}）</label>
          <input id="wv-inline-words" type="number" min="${wcMin}" max="${wcMax}" step="50" value="${wcDef}" class="wv-gen-input">
        </div>`}
        ${opts.hideCount ? '' : `<div class="wv-gen-field">
          <label class="wv-gen-label">${opts.countLabel || '数量'}</label>
          <input id="wv-inline-count" type="number" min="${cntMin}" max="${cntMax}" inputmode="numeric" oninput="WvGenerator._enforceCountInput('wv-inline-count', ${cntMax}, '${Utils.escapeHtml(opts.countLabel || '数量')}')" onchange="WvGenerator._enforceCountInput('wv-inline-count', ${cntMax}, '${Utils.escapeHtml(opts.countLabel || '数量')}', true, ${cntMin})" onblur="WvGenerator._enforceCountInput('wv-inline-count', ${cntMax}, '${Utils.escapeHtml(opts.countLabel || '数量')}', true, ${cntMin})" value="${Math.min(cntMax, Math.max(cntMin, cntDef))}" class="wv-gen-input">
        </div>`}
        ${opts.countHelp ? `<div class="wv-gen-help full">${Utils.escapeHtml(opts.countHelp)}</div>` : ''}
      </div>`}
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div id="wv-gen-batch-progress" class="wv-gen-batch-progress" style="display:none"></div>
      <div class="wv-gen-actions">
        <button id="wv-inline-cancel" class="wv-gen-btn">取消</button>
        <button id="wv-gen-submit" class="wv-gen-btn primary">生成</button>
      </div>`;
    modal.classList.remove('hidden');
    _refreshRefLorebookBtn('inline'); // 显示上次选的参考世界书（沿用）

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
        if (opts.requirePrompt && !prompt) { UI.showToast(opts.requirePromptMsg || '请先填写描述', 1800); return; }
        const wordCount = Math.min(wcMax, Math.max(wcMin, parseInt(document.getElementById('wv-inline-words')?.value) || wcDef));
        const count = Math.min(cntMax, Math.max(cntMin, parseInt(document.getElementById('wv-inline-count')?.value) || cntDef));
        const lbRef = await _buildLorebookRefText('inline'); // 参考世界书（沿用上次选择）
        _setLoading(true, opts.loadingMsg || '正在生成…');
        try {
          _abortCtrl = new AbortController();
          await handler({ prompt, count, wordCount, signal: _abortCtrl.signal, lbRef });
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

  // 安卓 WebView 兜底：弹窗内元素高度突变（如 estimate 单行↔多行）时，
  // 带 transform 合成层的滚动容器有时不重绘可视区（表现为内容飞走/空白，滑动才恢复）。
  // 更新内容后调一次：强制同步布局 + 轻推 scrollTop 触发可视区重绘。
  function _repaintModalScroll() {
    try {
      const mc = document.querySelector('#wv-gen-modal .modal-content');
      if (!mc) return;
      void mc.offsetHeight;
      const st = mc.scrollTop;
      mc.scrollTop = st + 1;
      mc.scrollTop = st;
    } catch (_) {}
  }

  function open() {
    _step = 1;
    _genData = { step1: null, step2: null, step3: null, step4: null, step5: null };
    _wvId = null;
    _renderStep();
    const modal = _getModal();
    if (modal) modal.classList.remove('hidden');
  }

  async function close() {
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
    // 若已渐进落库（_wvId 存在）且未走正式完成流程，说明用户中途关闭，询问保留还是删除草稿
    if (_wvId) {
      const draftId = _wvId;
      const keep = await UI.showConfirm(
        '保留生成草稿？',
        '当前世界观已生成的内容（设定/地区/势力/角色等）已自动保存。\n\n「保留」：留在世界观列表，可在编辑页继续完善。\n「删除」：丢弃这份未完成的草稿。'
      );
      _wvId = null;
      if (!keep) {
        // 删除草稿：从列表移除 + 删表
        try {
          const list = await getWorldviewList();
          const next = list.filter(x => x && x.id !== draftId);
          await saveWorldviewList(next);
          await DB.del('worldviews', draftId);
          await Worldview.load();
        } catch (e) { console.warn('[WvGen] 删除草稿失败', e); }
      } else {
        await Worldview.load();
      }
    }
    const modal = _getModal();
    if (modal) modal.classList.add('hidden');
  }

  function _renderStep() {
    const body = document.getElementById('wv-gen-body');
    if (!body) return;

    switch (_step) {
      case 1: _renderStep1(body); break;
      case 2: _renderStep2(body); break;
      case 3: _renderStep3(body); break;
      case 4: _renderStep4(body); break;
      case 5: _renderStep5(body); break;
      case 99: _renderDone(body); break;
    }
    // v711：恢复该步"参考世界书"按钮上的已选名字（异步，不阻塞渲染）
    if (_step >= 1 && _step <= 5) { _refreshRefLorebookBtn(_step); }
  }

  // ---- Step 1: 基础设定 ----
  function _renderStep1(body) {
    const prev = _genData.step1;
    body.innerHTML = `
${_stepIntro('book', '第 1 步 · 基础设定', '描述你想创建的世界观，AI 会生成核心设定')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">你想要什么样的世界观？</label>
        ${_fsWrap(`<textarea id="wv-gen-prompt" rows="5" placeholder="例如：赛博朋克废土、现代都市恋爱、中世纪魔法大陆……\n可以写得很详细，也可以只写一句话" class="wv-gen-textarea">${prev?._userPrompt || ''}</textarea>`, 'wv-gen-prompt', '你想要什么样的世界观')}
      </div>
      ${_refLorebookBtnHtml(1)}
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">设定字数（最多5000）</label>
          <input id="wv-gen-words" type="number" min="500" max="5000" step="100" value="${prev?._wordCount || 2500}" class="wv-gen-input">
        </div>
      </div>
      <div class="wv-gen-option">
        <label class="wv-gen-check" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <span style="position:relative;display:inline-flex;flex-shrink:0">
            <input id="wv-gen-create-regions" type="checkbox" class="circle-check" ${prev?._createRegions !== false ? 'checked' : ''} onchange="WvGenerator._onRegionToggle()">
            <span class="circle-check-ui"></span>
          </span>
          同时生成地区骨架
        </label>
        <div id="wv-gen-region-count-row" style="margin-top:8px;${prev?._createRegions !== false ? '' : 'display:none'}">
          <label class="wv-gen-label">地区数量</label>
          <input id="wv-gen-region-count" type="number" min="1" max="12" inputmode="numeric" oninput="WvGenerator._enforceRegionCountInput('wv-gen-region-count')" onchange="WvGenerator._enforceRegionCountInput('wv-gen-region-count', true)" onblur="WvGenerator._enforceRegionCountInput('wv-gen-region-count', true)" value="${Math.min(REGION_COUNT_MAX, prev?._regionCount || 5)}" class="wv-gen-input" style="max-width:110px">
          <div class="wv-gen-help">建议 3–8 个，最多 12 个。为避免页面卡顿或生成中断，建议分批生成，后续可继续追加。</div>
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
    const regionCount = _clampRegionCount(document.getElementById('wv-gen-region-count')?.value, 'wv-gen-region-count');

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
      const _refText = await _buildLorebookRefText(1);
      const raw = await API.generate(sysPrompt, prompt + _refText, { signal: _abortCtrl.signal });
      const data = _parseJSON(raw);
      if (data && Array.isArray(data.regions)) data.regions = _limitRegions(data.regions);
      _genData.step1 = { ...data, _userPrompt: prompt, _wordCount: wordCount, _createRegions: createRegions, _regionCount: regionCount };
      await _upsertWV();  // 渐进落库：第1步完成即入库
      _setLoading(false);
      // 自动进入下一步
      if (createRegions) {
        _step = 2;
      } else {
        _step = 4; // 没地区 → 跳过势力 → 直接角色（常驻角色）
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
        ${_fsWrap(`<textarea id="wv-gen-prompt" rows="3" placeholder="对地区有什么额外要求？留空则完全由 AI 自由发挥" class="wv-gen-textarea">${_genData.step2?._userPrompt || ''}</textarea>`, 'wv-gen-prompt', '地区额外要求')}
      </div>
      ${_refLorebookBtnHtml(2)}
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">单条字数（≤1000）</label>
          <input id="wv-gen-words" type="number" min="100" max="1000" step="50" value="${_genData.step2?._wordCount || 300}" class="wv-gen-input">
        </div>
        <div class="wv-gen-field">
          <label class="wv-gen-label">地区数量</label>
          <input id="wv-gen-count" type="number" min="1" max="12" inputmode="numeric" oninput="WvGenerator._enforceRegionCountInput('wv-gen-count')" onchange="WvGenerator._enforceRegionCountInput('wv-gen-count', true)" onblur="WvGenerator._enforceRegionCountInput('wv-gen-count', true)" value="${Math.min(REGION_COUNT_MAX, s1._regionCount || (s1.regions?.length) || 5)}" class="wv-gen-input">
        </div>
        <div class="wv-gen-help full">建议 3–8 个，最多 12 个。为避免页面卡顿或生成中断，建议分批生成，后续可继续追加。</div>
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
    const count = _clampRegionCount(document.getElementById('wv-gen-count')?.value, 'wv-gen-count');
    const existingNames = _limitRegions(s1.regions || []).map(r => r.name);

    _setLoading(true, '正在生成地区…');

    let sysPrompt = PROMPTS.step2.replace('##WORD_COUNT##', wordCount);
    if (existingNames.length) {
      sysPrompt = sysPrompt.replace('##EXISTING_REGIONS##',
        `\n## 必须对齐的地区\n以下地区名来自基础设定的【地区结构】，名称和定位必须一致：${existingNames.join('、')}`);
    } else {
      sysPrompt = sysPrompt.replace('##EXISTING_REGIONS##', '');
    }

    const userMsg = `${userPrompt ? '用户要求：' + userPrompt + '\n\n' : ''}生成 ${count} 个地区。\n\n## 世界观设定\n${s1.setting || ''}` + await _buildLorebookRefText(2);

    try {
      _abortCtrl = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal });
      const data = _parseJSON(raw);
      const regions = _limitRegions(Array.isArray(data) ? data : (data.regions || []));
      _genData.step2 = { regions, _userPrompt: userPrompt, _wordCount: wordCount };
      await _upsertWV();  // 渐进落库：第2步（地区）完成即入库
      _setLoading(false);
      _step = 3;
      _renderStep();
    } catch (e) {
      _setLoading(false);
      if (e.name === 'AbortError') return;
      UI.showToast('生成失败: ' + e.message, 3000);
    }
  }

  // ---- Step 3: 势力（勾选地区 → 合并一次请求）----
  function _renderStep3(body) {
    const regions = _genData.step2?.regions || _genData.step1?.regions || [];
    const doneFactions = _genData.step3?.factions || {};
    // 已生成势力的地区（有 ≥1 条）标记完成；默认勾选"还没生成的"
    const rows = regions.map((r, i) => {
      const done = Array.isArray(doneFactions[r.name]) && doneFactions[r.name].length > 0;
      const cnt = done ? doneFactions[r.name].length : 0;
      const checked = done ? '' : 'checked';
      return `<label class="wv-gen-region-check${done ? ' is-done' : ''}">
        <input type="checkbox" class="circle-check wv-gen-region-cb" value="${Utils.escapeHtml(r.name)}" ${checked} onchange="WvGenerator._updateStep3Estimate()">
        <span class="circle-check-ui"></span>
        <span class="wv-gen-region-nm">${Utils.escapeHtml(r.name || ('地区' + (i + 1)))}</span>
        ${done ? `<span class="wv-gen-region-done">✓ 已生成 ${cnt} 势力</span>` : ''}
      </label>`;
    }).join('');
    body.innerHTML = `
${_stepIntro('castle', '第 3 步 · 势力', '勾选要本次生成势力的地区，一次性合并生成')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">额外要求（可选）</label>
        ${_fsWrap(`<textarea id="wv-gen-prompt" rows="3" placeholder="对势力有什么要求？留空则由 AI 自由发挥" class="wv-gen-textarea">${_genData.step3?._userPrompt || ''}</textarea>`, 'wv-gen-prompt', '势力额外要求')}
      </div>
      ${_refLorebookBtnHtml(3)}
      <div class="wv-gen-field">
        <label class="wv-gen-label">选择地区（已生成的可重新勾选覆盖）</label>
        <div class="wv-gen-region-list">${rows || '<div class="wv-gen-help">没有地区</div>'}</div>
      </div>
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">单条字数（≤1200）</label>
          <input id="wv-gen-words" type="number" min="200" max="1200" step="50" value="${_genData.step3?._wordCount || 500}" class="wv-gen-input" oninput="WvGenerator._updateStep3Estimate()">
        </div>
        <div class="wv-gen-field">
          <label class="wv-gen-label">每地区势力数</label>
          <input id="wv-gen-count" type="number" min="1" max="10" inputmode="numeric" oninput="WvGenerator._enforceCountInput('wv-gen-count', 10, '每地区势力数'); WvGenerator._updateStep3Estimate()" onchange="WvGenerator._enforceCountInput('wv-gen-count', 10, '每地区势力数', true); WvGenerator._updateStep3Estimate()" onblur="WvGenerator._enforceCountInput('wv-gen-count', 10, '每地区势力数', true)" value="${Math.min(10, Math.max(1, _genData.step3?._count || 3))}" class="wv-gen-input">
        </div>
      </div>
      <div id="wv-gen-estimate" class="wv-gen-estimate"></div>
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div class="wv-gen-actions">
        <button onclick="WvGenerator._skipStep()" class="wv-gen-btn">跳过</button>
        <button id="wv-gen-submit" onclick="WvGenerator._runStep3()" class="wv-gen-btn primary">生成势力</button>
      </div>`;
    _updateStep3Estimate();
  }

  // 字数预估：勾选/字数变化时更新，超 8000 字变橙提示截断风险
  function _updateStep3Estimate() {
    const el = document.getElementById('wv-gen-estimate');
    if (!el) return;
    const checked = Array.from(document.querySelectorAll('.wv-gen-region-cb')).filter(cb => cb.checked);
    const nRegion = checked.length;
    const words = Math.min(1200, Math.max(200, parseInt(document.getElementById('wv-gen-words')?.value) || 500));
    const count = Math.min(10, Math.max(1, parseInt(document.getElementById('wv-gen-count')?.value) || 3));
    const total = nRegion * count * words;
    const WARN = 8000;
    let cls = 'wv-gen-estimate', html;
    if (nRegion === 0) {
      html = '<span class="wv-gen-help">未勾选地区</span>';
    } else {
      const base = `已勾 ${nRegion} 个地区 × ${count} 势力 × 约 ${words} 字 ≈ 预计 ~${total} 字`;
      if (total > WARN) {
        cls = 'wv-gen-estimate warn';
        html = `⚠ ${base}<br>内容较大，一次生成可能导致 JSON 结构错误或截断（能解析多少就存多少）。建议减少勾选地区或降低字数。`;
      } else {
        html = base;
      }
    }
    el.className = cls;
    el.innerHTML = html;
    _repaintModalScroll();
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
      if (i === currentIdx && r.status === 'pending') { icon = '◎'; color = 'var(--accent)'; }
      else if (r.status === 'done') { icon = '✓'; color = 'var(--accent)'; }
      else if (r.status === 'failed') { icon = '✗'; color = 'var(--danger,#e57373)'; }
      html += `<div class="wv-gen-batch-item" style="color:${color}">${icon} ${name}${r.status === 'done' ? `（${r.count}条）` : ''}${r.status === 'failed' ? `（${r.error || '失败'}）` : ''}</div>`;
    });
    html += '</div>';
    el.innerHTML = html;
  }

  async function _runStep3() {
    const s1 = _genData.step1 || {};
    const allRegions = _genData.step2?.regions || s1.regions || [];
    if (allRegions.length === 0) {
      UI.showToast('没有地区可用，请先完成第 2 步', 2000);
      return;
    }
    // 读勾选的地区
    const checkedNames = Array.from(document.querySelectorAll('.wv-gen-region-cb'))
      .filter(cb => cb.checked).map(cb => cb.value);
    if (checkedNames.length === 0) {
      UI.showToast('请至少勾选一个地区', 2000);
      return;
    }
    const regions = allRegions.filter(r => checkedNames.includes(r.name));
    const userPrompt = document.getElementById('wv-gen-prompt')?.value?.trim() || '';
    const wordCount = Math.min(1200, Math.max(200, parseInt(document.getElementById('wv-gen-words')?.value) || 500));
    const count = Math.min(10, Math.max(1, parseInt(document.getElementById('wv-gen-count')?.value) || 3));

    _setLoading(true, `正在生成势力（勾选 ${regions.length} 个地区，一次合并生成）…`);

    // 已有势力（合并保留：本次没勾的地区结果不动）
    const allFactions = Object.assign({}, _genData.step3?.factions || {});

    try {
      _abortCtrl = new AbortController();
      const sysPrompt = PROMPTS.step3.replace('##WORD_COUNT##', wordCount);

      // 把勾中的所有地区打包成一次请求。要求 AI 按 { "地区名": [势力...] } 对象返回。
      const regionBlocks = regions.map(r => `### ${r.name}\n${_regionDetail(r)}`).join('\n\n');
      const userMsg = `${userPrompt ? '用户要求：' + userPrompt + '\n\n' : ''}请为下面每一个地区分别生成 ${count} 个势力，务必用对象格式返回：{ "地区名": [ {势力对象}, ... ] }，键名严格用下面给出的地区名。\n\n## 世界观设定\n${s1.setting || ''}\n\n## 需要生成势力的地区（共 ${regions.length} 个）\n${regionBlocks}` + await _buildLorebookRefText(3);

      const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal });
      const data = _parseJSON(raw); // 截断时会自动修复/丢弃尾部不完整项 → 天然实现"能解析多少存多少"

      // 逐地区提取：优先按地区名精确取；没有对应键的地区视为本次没成功
      let succ = 0, fail = 0;
      const failNames = [];
      for (const reg of regions) {
        let arr = [];
        if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data[reg.name])) {
          arr = data[reg.name];
        }
        // 过滤掉没 name 的脏项
        arr = (arr || []).filter(f => f && f.name);
        if (arr.length > 0) {
          allFactions[reg.name] = arr;
          succ++;
        } else {
          fail++;
          failNames.push(reg.name);
        }
      }

      // 兜底：如果 AI 没按地区名分组、而是返回了扁平数组（带 region 字段），按 region 归位
      if (succ === 0 && Array.isArray(data)) {
        for (const reg of regions) {
          const arr = data.filter(f => f && f.name && (f.region === reg.name || !f.region));
          if (arr.length > 0) { allFactions[reg.name] = arr; succ++; }
        }
        failNames.length = 0;
        for (const reg of regions) if (!(allFactions[reg.name]?.length)) failNames.push(reg.name);
        fail = failNames.length;
      }

      _genData.step3 = { factions: allFactions, _userPrompt: userPrompt, _wordCount: wordCount, _count: count };
      await _upsertWV();  // 渐进落库
      _setLoading(false);

      if (succ === 0) {
        // 全失败：留在本步，让用户重勾重试
        UI.showToast('生成失败：未解析出势力，请重试', 3000);
        _renderStep(); // 重渲染，刷新勾选状态
        const st = document.getElementById('wv-gen-status');
        if (st) { st.style.display = ''; st.innerHTML = `<span style="color:var(--danger,#e57373)">生成失败：未解析出任何势力（可能因内容过大被截断）。可减少勾选/字数后重试。</span>`; }
        return;
      }

      if (fail > 0) {
        UI.showToast(`成功 ${succ} 个地区，失败 ${fail} 个：${failNames.join('、')}。可重新勾选失败的重试`, 3500);
        _renderStep(); // 留在本步：完成的打勾，失败的仍可勾选重试
        const st = document.getElementById('wv-gen-status');
        if (st) { st.style.display = ''; st.innerHTML = `<span style="color:var(--warning,#e0a030)">部分成功：${succ} 个地区已生成势力，${fail} 个未解析出（${failNames.join('、')}）。已保留成功的，可重勾失败的重试，或点下一步继续。</span>`; }
        return;
      }

      // 全部成功 → 进入下一步
      UI.showToast(`已生成 ${succ} 个地区的势力`, 2000);
      _step = 4;
      _renderStep();
    } catch (e) {
      _setLoading(false);
      if (e.name === 'AbortError') return;
      const st = document.getElementById('wv-gen-status');
      if (st) st.innerHTML = `<span style="color:var(--danger,#e57373)">生成失败：${Utils.escapeHtml(e.message || '未知错误')}。可重试。</span>`;
      UI.showToast('生成失败: ' + e.message, 3000);
    }
  }

  // ---- Step 4: 角色（按势力分批串行）----
  // 把 step3 的 {地区名:[势力...]} 平铺成 [{region, faction}...]，render/run 用同一顺序保证 index 对齐
  function _flattenFactions() {
    const factions = _genData.step3?.factions || {};
    const list = [];
    for (const [rn, arr] of Object.entries(factions)) {
      for (const fac of (arr || [])) {
        if (fac && fac.name) list.push({ region: rn, faction: fac });
      }
    }
    return list;
  }

  // ---- Step 4: 角色（勾选势力 → 合并一次请求，可跨地区）----
  function _renderStep4(body) {
    const list = _flattenFactions();
    // 无势力（step3 被跳过）：降级为一次性生成常驻角色的简单表单
    if (list.length === 0) {
      body.innerHTML = `
${_stepIntro('users', '第 4 步 · 角色', '为世界生成常驻角色（未设置势力）')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">额外要求（可选）</label>
        ${_fsWrap(`<textarea id="wv-gen-prompt" rows="3" placeholder="对角色有什么要求？留空则由 AI 自由发挥" class="wv-gen-textarea">${_genData.step4?._userPrompt || ''}</textarea>`, 'wv-gen-prompt', '角色额外要求')}
      </div>
      ${_refLorebookBtnHtml(4)}
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">单条字数（≤1500）</label>
          <input id="wv-gen-words" type="number" min="200" max="1500" step="50" value="${_genData.step4?._wordCount || 500}" class="wv-gen-input">
        </div>
        <div class="wv-gen-field">
          <label class="wv-gen-label">生成数量</label>
          <input id="wv-gen-count" type="number" min="1" max="10" inputmode="numeric" oninput="WvGenerator._enforceCountInput('wv-gen-count', 10, '生成数量')" onchange="WvGenerator._enforceCountInput('wv-gen-count', 10, '生成数量', true)" onblur="WvGenerator._enforceCountInput('wv-gen-count', 10, '生成数量', true)" value="${Math.min(10, Math.max(1, _genData.step4?._count || 3))}" class="wv-gen-input">
        </div>
      </div>
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div class="wv-gen-actions">
        <button onclick="WvGenerator._skipStep()" class="wv-gen-btn">跳过</button>
        <button id="wv-gen-submit" onclick="WvGenerator._runStep4()" class="wv-gen-btn primary">生成角色</button>
      </div>`;
      return;
    }
    // 有势力：勾选列表（可跨地区/跨势力），已生成角色的势力标 ✓，默认勾未生成的
    const npcs = _genData.step4?.npcs || [];
    const rows = list.map((it, i) => {
      const done = npcs.filter(n => n && n.faction === it.faction.name && n.region === it.region).length;
      const checked = done > 0 ? '' : 'checked';
      return `<label class="wv-gen-region-check${done > 0 ? ' is-done' : ''}">
        <input type="checkbox" class="circle-check wv-gen-fac-cb" value="${i}" ${checked} onchange="WvGenerator._updateStep4Estimate()">
        <span class="circle-check-ui"></span>
        <span class="wv-gen-region-nm">${Utils.escapeHtml(it.region || '')} / ${Utils.escapeHtml(it.faction.name || ('势力' + (i + 1)))}</span>
        ${done > 0 ? `<span class="wv-gen-region-done">✓ 已生成 ${done} 角色</span>` : ''}
      </label>`;
    }).join('');
    body.innerHTML = `
${_stepIntro('users', '第 4 步 · 角色', '勾选要本次生成角色的势力（可跨地区），一次性合并生成')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">额外要求（可选）</label>
        ${_fsWrap(`<textarea id="wv-gen-prompt" rows="3" placeholder="对角色有什么要求？留空则由 AI 自由发挥" class="wv-gen-textarea">${_genData.step4?._userPrompt || ''}</textarea>`, 'wv-gen-prompt', '角色额外要求')}
      </div>
      ${_refLorebookBtnHtml(4)}
      <div class="wv-gen-field">
        <label class="wv-gen-label">选择势力（已生成的可重新勾选覆盖）</label>
        <div class="wv-gen-region-list">${rows || '<div class="wv-gen-help">没有势力</div>'}</div>
      </div>
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">单条字数（≤1500）</label>
          <input id="wv-gen-words" type="number" min="200" max="1500" step="50" value="${_genData.step4?._wordCount || 500}" class="wv-gen-input" oninput="WvGenerator._updateStep4Estimate()">
        </div>
        <div class="wv-gen-field">
          <label class="wv-gen-label">每势力角色数</label>
          <input id="wv-gen-count" type="number" min="1" max="10" inputmode="numeric" oninput="WvGenerator._enforceCountInput('wv-gen-count', 10, '每势力角色数'); WvGenerator._updateStep4Estimate()" onchange="WvGenerator._enforceCountInput('wv-gen-count', 10, '每势力角色数', true); WvGenerator._updateStep4Estimate()" onblur="WvGenerator._enforceCountInput('wv-gen-count', 10, '每势力角色数', true)" value="${Math.min(10, Math.max(1, _genData.step4?._count || 3))}" class="wv-gen-input">
        </div>
      </div>
      <div id="wv-gen-estimate" class="wv-gen-estimate"></div>
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div class="wv-gen-actions">
        <button onclick="WvGenerator._skipStep()" class="wv-gen-btn">跳过</button>
        <button id="wv-gen-submit" onclick="WvGenerator._runStep4()" class="wv-gen-btn primary">生成角色</button>
      </div>`;
    _updateStep4Estimate();
  }

  // 字数预估：勾选/字数变化时更新，超 8000 字变橙提示截断风险
  function _updateStep4Estimate() {
    const el = document.getElementById('wv-gen-estimate');
    if (!el) return;
    const checked = Array.from(document.querySelectorAll('.wv-gen-fac-cb')).filter(cb => cb.checked);
    const nFac = checked.length;
    const words = Math.min(1500, Math.max(200, parseInt(document.getElementById('wv-gen-words')?.value) || 500));
    const count = Math.min(10, Math.max(1, parseInt(document.getElementById('wv-gen-count')?.value) || 3));
    const total = nFac * count * words;
    const WARN = 8000;
    let cls = 'wv-gen-estimate', html;
    if (nFac === 0) {
      html = '<span class="wv-gen-help">未勾选势力</span>';
    } else {
      const base = `已勾 ${nFac} 个势力 × ${count} 角色 × 约 ${words} 字 ≈ 预计 ~${total} 字`;
      if (total > WARN) {
        cls = 'wv-gen-estimate warn';
        html = `⚠ ${base}<br>内容较大，一次生成可能导致 JSON 结构错误或截断（能解析多少就存多少）。建议减少勾选势力或降低字数。`;
      } else {
        html = base;
      }
    }
    el.className = cls;
    el.innerHTML = html;
    _repaintModalScroll();
  }

  async function _runStep4() {
    const s1 = _genData.step1 || {};
    const regions = _genData.step2?.regions || s1.regions || [];
    const list = _flattenFactions();
    const userPrompt = document.getElementById('wv-gen-prompt')?.value?.trim() || '';
    const wordCount = Math.min(1500, Math.max(200, parseInt(document.getElementById('wv-gen-words')?.value) || 500));
    const count = Math.min(10, Math.max(1, parseInt(document.getElementById('wv-gen-count')?.value) || 3));

    // 如果完全没势力（用户跳过了 step3），降级：一次性生成 count 个常驻角色
    if (list.length === 0) {
      _setLoading(true, '正在生成角色…');
      try {
        _abortCtrl = new AbortController();
        let sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);
        const ctxParts = [`## 世界观设定\n${s1.setting || ''}`];
        if (regions.length) ctxParts.push(`## 地区\n${regions.map(r => `- ${_regionBrief(r)}`).join('\n')}`);
        // 世界书条目作为参考上下文
        try {
          const wNow = await Worldview._getEditingWV();
          const knowledges = (wNow?.knowledges || []).filter(k => k && k.enabled !== false && k.content);
          if (knowledges.length) ctxParts.push(`## 世界书条目\n${knowledges.map(k => `### ${k.name || '未命名'}\n${k.content}`).join('\n\n')}`);
          // 世界书已有 NPC 作为参考
          const existingNpcs = (wNow?.globalNpcs || []).filter(n => n && n.name);
          if (existingNpcs.length) ctxParts.push(`## 世界书已有角色（参考风格，不要重复生成）\n${existingNpcs.map(n => `- **${n.name}**${n.summary ? '（' + n.summary + '）' : ''}${n.detail ? '：' + n.detail.substring(0, 200) + (n.detail.length > 200 ? '…' : '') : ''}`).join('\n')}`);
        } catch(_) {}
        const regionHint = regions.length ? `\n每个角色的 region 字段必须从以下地区中选一个：${regions.map(r => '「' + r.name + '」').join('、')}。` : '';
        const userMsg = `${userPrompt ? '用户要求：' + userPrompt + '\n\n' : ''}生成 ${count} 个角色。${regionHint}\n\n${ctxParts.join('\n\n')}` + await _buildLorebookRefText(4);
        const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal, maxTokens: Math.min(32000, count * wordCount * 4 + 2000) });
        const data = _parseJSON(raw);
        const arr = Array.isArray(data) ? data : (data.npcs || []);
        // v704：把性别/年龄/职业/身份合进 detail 头部（与单个补全一致；此前漏了这步，导致性别等元信息不进 detail、编辑界面看不到）
        arr.forEach(n => { if (n) n.detail = _mergeMetaToDetail(n); });
        _genData.step4 = { npcs: arr, _userPrompt: userPrompt, _wordCount: wordCount, _count: count };
        await _upsertWV();  // 渐进落库：第4步（角色·无势力降级路径）完成即入库
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

    // 读勾选的势力（index 对齐 _flattenFactions 顺序）
    const checkedIdx = Array.from(document.querySelectorAll('.wv-gen-fac-cb'))
      .filter(cb => cb.checked).map(cb => parseInt(cb.value)).filter(i => !isNaN(i));
    if (checkedIdx.length === 0) {
      UI.showToast('请至少勾选一个势力', 2000);
      return;
    }
    const tasks = checkedIdx.map(i => list[i]).filter(Boolean);

    _setLoading(true, `正在生成角色（勾选 ${tasks.length} 个势力，一次合并生成）…`);

    // 已有角色（合并保留：本次没勾的势力结果不动。以 region+faction 为键覆盖勾中的）
    const prevNpcs = (_genData.step4?.npcs || []).slice();
    const checkedKey = new Set(tasks.map(t => `${t.region}\u0000${t.faction.name}`));
    // 先剔除本次勾中的势力的旧角色（重新生成 → 覆盖）
    const keptNpcs = prevNpcs.filter(n => !checkedKey.has(`${n.region}\u0000${n.faction}`));

    try {
      _abortCtrl = new AbortController();
      const sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);

      // 去重上下文：世界书已有 + 未勾中而保留的角色 → 发全量资料卡，让 AI 看清谁是谁、谁跟谁什么关系
      // （避免每个势力都凭空套一套一模一样的爸妈哥姐）
      let existingCards = [];
      let knowledgeHint = '';
      const seenNames = new Set();
      try {
        const wNow = await Worldview._getEditingWV();
        _collectAllNpcsFull(wNow).forEach(({ npc, source }) => {
          if (npc.name && !seenNames.has(npc.name)) {
            seenNames.add(npc.name);
            existingCards.push(_npcProfileCard(npc, source));
          }
        });
        const knowledges = (wNow?.knowledges || []).filter(k => k && k.enabled !== false && k.content);
        if (knowledges.length) knowledgeHint = `\n\n## 世界书条目\n${knowledges.map(k => `### ${k.name || '未命名'}\n${k.content}`).join('\n\n')}`;
      } catch(_) {}
      // 本次没勾中而保留的角色（可能还没落库，补进资料卡）
      keptNpcs.forEach(n => {
        if (n && n.name && !seenNames.has(n.name)) {
          seenNames.add(n.name);
          existingCards.push(_npcProfileCard(n, n.faction || n.region || ''));
        }
      });
      const dedupeHint = existingCards.length > 0
        ? `\n\n## 已有角色资料（不要重名/近似名；已有的家人、同事、上下级等关系人写在这里，新角色的人际关系请与这些既有角色对接，不要每个势力都凭空造一套相同的家庭成员）\n${existingCards.join('\n\n')}`
        : '';

      // 只发勾中势力的资料，要求 AI 按 { "势力名": [角色...] } 对象返回
      const facBlocks = tasks.map(t => {
        const facDetail = t.faction.setting || t.faction.detail || t.faction.description || '';
        return `### ${t.faction.name}（地区：${t.region}）\n${facDetail}`;
      }).join('\n\n');
      const facNameList = tasks.map(t => `「${t.faction.name}」`).join('、');
      const userMsg = `${userPrompt ? '用户要求：' + userPrompt + '\n\n' : ''}请为下面每一个势力分别生成 ${count} 个角色，务必用对象格式返回：{ "势力名": [ {角色对象}, ... ] }，键名严格用下面给出的势力名（${facNameList}）。每个角色的 faction 必须是所属势力名、region 必须是该势力所在地区。\n\n## 世界观设定\n${s1.setting || ''}\n\n## 需要生成角色的势力（共 ${tasks.length} 个）\n${facBlocks}${dedupeHint}${knowledgeHint}` + await _buildLorebookRefText(4);

      const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal });
      const data = _parseJSON(raw); // 截断时自动修复/丢弃尾部不完整项 → 天然实现"能解析多少存多少"

      // 逐势力提取：优先按势力名精确取
      const newNpcs = [];
      let succ = 0, fail = 0;
      const failNames = [];
      for (const t of tasks) {
        let arr = [];
        if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data[t.faction.name])) {
          arr = data[t.faction.name];
        }
        arr = (arr || []).filter(n => n && n.name);
        if (arr.length > 0) {
          arr.forEach(n => {
            n.region = t.region;
            n.faction = t.faction.name;
            n.detail = _mergeMetaToDetail(n);
            newNpcs.push(n);
          });
          succ++;
        } else {
          fail++;
          failNames.push(`${t.region}/${t.faction.name}`);
        }
      }

      // 兜底：AI 没按势力名分组、返回了扁平数组时，按 faction 字段归位
      if (succ === 0 && Array.isArray(data)) {
        for (const t of tasks) {
          const arr = (data || []).filter(n => n && n.name && (n.faction === t.faction.name || (!n.faction && tasks.length === 1)));
          if (arr.length > 0) {
            arr.forEach(n => {
              n.region = t.region;
              n.faction = t.faction.name;
              n.detail = _mergeMetaToDetail(n);
              newNpcs.push(n);
            });
            succ++;
          }
        }
        failNames.length = 0;
        for (const t of tasks) if (!newNpcs.some(n => n.faction === t.faction.name && n.region === t.region)) failNames.push(`${t.region}/${t.faction.name}`);
        fail = failNames.length;
      }

      _genData.step4 = { npcs: keptNpcs.concat(newNpcs), _userPrompt: userPrompt, _wordCount: wordCount, _count: count };
      await _upsertWV();  // 渐进落库
      _setLoading(false);

      if (succ === 0) {
        // 全失败：留在本步，让用户重勾重试
        UI.showToast('生成失败：未解析出角色，请重试', 3000);
        _renderStep(); // 重渲染，刷新勾选状态
        const st = document.getElementById('wv-gen-status');
        if (st) { st.style.display = ''; st.innerHTML = `<span style="color:var(--danger,#e57373)">生成失败：未解析出任何角色（可能因内容过大被截断）。可减少勾选/字数后重试。</span>`; }
        return;
      }

      if (fail > 0) {
        UI.showToast(`完成：${succ} 成功 · ${fail} 未解析（可重勾重试）`, 3000);
        _renderStep(); // 刷新勾选状态：成功的打 ✓，失败的仍可勾
        const st = document.getElementById('wv-gen-status');
        if (st) { st.style.display = ''; st.innerHTML = `<span style="color:var(--warning,#e0a030)">部分成功：${succ} 个势力已生成，${fail} 个未解析出（${failNames.join('、')}）。已保留成功的，可重勾失败的重试，或点下一步继续。</span>`; }
        return;
      }

      // 全部成功 → 进入下一步
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
        ${_fsWrap(`<textarea id="wv-gen-prompt" rows="3" placeholder="例如：从选灵根开始、日常校园开场、酒馆偶遇…留空则由 AI 自由发挥" class="wv-gen-textarea">${_genData.step5?._userPrompt || ''}</textarea>`, 'wv-gen-prompt', '开场要求')}
      </div>
      ${_refLorebookBtnHtml(5)}
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
      contextParts.push(`## 角色\n${npcs.map(n => `- ${n.name}（${n.profession || n.identity || ''}）：${n.detail?.substring(0, 100) || ''}…`).join('\n')}`);
    }
    const userMsg = `${userPrompt ? '用户要求：' + userPrompt + '\n\n' : ''}${contextParts.join('\n\n')}` + await _buildLorebookRefText(5);

    try {
      _abortCtrl = new AbortController();
      const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal });
      const data = _parseJSON(raw);
      _genData.step5 = { ...data, _userPrompt: userPrompt };
      await _upsertWV();  // 渐进落库：第5步（开场）完成即入库
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

  // ---- 渐进落库：用当前 _genData 构建完整 wv 对象（每步复用，整体覆盖，幂等）----
  function _buildWVFromGenData(id) {
    const s1 = _genData.step1 || {};
    // 最终落库层再裁一次，防止历史 _genData 或后续入口绕过前台限制。
    const regions = _limitRegions(_genData.step2?.regions || s1.regions || []);
    const factions = _genData.step3?.factions || {};
    const npcs = _genData.step4?.npcs || [];
    const start = _genData.step5 || {};

    const wv = {
      id,
      name: s1.name || '新世界观',
      description: s1.description || '',
      icon: 'world',
      iconImage: '',
      setting: s1.setting || '',
      currencies: (s1.currency && (s1.currency.name || '').trim()) ? [{ id: 'cur_' + Utils.uuid().slice(0, 8), name: s1.currency.name, desc: s1.currency.desc || '' }] : [],
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

    // 构建 regions + factions
    if (regions.length) {
      wv.regions = regions.map(r => {
        const regionFacs = (factions[r.name] || []).map(f => ({
          id: 'fac_' + Utils.uuid().slice(0,8),
          name: f.name || '',
          summary: f.description || '',
          detail: f.setting || '',
          npcs: []
        }));
        // 如果没势力，建一个默认
        if (!regionFacs.length) {
          regionFacs.push({ id: 'fac_' + Utils.uuid().slice(0,8), name: (r.name || '默认') + '势力', summary: '', detail: '', npcs: [] });
        }
        return {
          id: 'reg_' + Utils.uuid().slice(0,8),
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
        id: 'npc_' + Utils.uuid().slice(0, 8),
        name: npc.name || '',
        aliases: _npcAliases(npc),
        summary: _npcSummary(npc),
        detail: _mergeMetaToDetail(npc),
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

    return wv;
  }

  // 渐进落库：每步生成完调用，用当前 _genData 整体重建并覆盖同一个 wv。
  // 首次调用生成 _wvId 并加入列表；之后复用同一 id 覆盖。失败静默（不阻断生成流程）。
  async function _upsertWV() {
    try {
      if (!_wvId) _wvId = 'wv_' + Utils.uuid().slice(0, 8);
      const wv = _buildWVFromGenData(_wvId);
      const list = await getWorldviewList();
      const entry = { id: _wvId, name: wv.name, description: wv.description, icon: wv.icon, iconImage: '' };
      const idx = list.findIndex(x => x && x.id === _wvId);
      if (idx >= 0) list[idx] = entry; else list.push(entry);
      await saveWorldviewList(list);
      await DB.put('worldviews', wv);
    } catch (e) {
      console.warn('[WvGen] 渐进落库失败', e);
    }
  }

  async function _commit() {
    // 数据已在生成过程中渐进落库，这里只需确保最新一步也已写入，然后收尾跳转。
    await _upsertWV();
    const id = _wvId;
    _wvId = null;  // 标记为"已正式完成"，close 不再询问保留/删除
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
    // 先中止正在跑的请求，避免迟到回调打乱 _step/_genData 状态（曾导致整个世界观丢失）
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
    _setLoading(false);
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
      btn.style.opacity = on ? '0.7' : '1';
      // 文字变"生成中…"，结束恢复原文（原文存 dataset，避免恢复错）
      if (on) {
        if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
        btn.textContent = '生成中…';
      } else if (btn.dataset.origText) {
        btn.textContent = btn.dataset.origText;
        delete btn.dataset.origText;
      }
    }
    // 生成中禁用"跳过"按钮：跳过若在请求进行中触发会 abort 请求打乱状态，
    // 生成中不允许跳过，只能等完成或取消整个向导。
    const modal = _getModal();
    if (modal) {
      modal.querySelectorAll('button[onclick*="_skipStep"]').forEach(b => {
        b.disabled = on;
        b.style.opacity = on ? '0.5' : '1';
        b.style.pointerEvents = on ? 'none' : '';
      });
    }
  }

  // ========== 内联生成（编辑页内使用）==========

  /** 基础设定内联生成 */
  async function inlineSetting() {
    const settingEl = document.getElementById('wv-setting');
    if (!settingEl) return;

    await _openInlineGenModal({
      icon: 'spark',
      title: 'AI 生成设定',
      desc: '描述你想要的世界观，AI 生成完整基础设定（已有设定会作为参考）',
      promptLabel: '世界观描述（必填）',
      placeholder: '如：赛博朋克废土、现代校园恋爱、被永夜笼罩的哥特世界…',
      requirePrompt: true,
      requirePromptMsg: '请先描述你想要的世界观',
      hideWords: true,
      hideCount: true,
      loadingMsg: '正在生成设定…'
    }, async ({ prompt, signal, lbRef }) => {
      const existingSetting = settingEl.value?.trim() || '';
      const sysPrompt = PROMPTS.step1
        .replace('##WORD_COUNT##', 2500)
        .replace('##REGION_INSTRUCTION##', '')
        .replace('##REGION_SETTING_NOTE##', '简要带过或跳过');
      const userMsg = prompt.trim() + (existingSetting ? '\n\n## 现有设定（参考/重写）\n' + existingSetting : '') + (lbRef || '');
      const raw = await API.generate(sysPrompt, userMsg, { signal });
      _lastRawOutput = raw;
      const data = _parseJSON(raw);
      if (!data) throw new Error('AI返回了空结构（看console原文）');
      if (data.name) { const nameEl = document.getElementById('wv-name'); if (nameEl && !nameEl.value.trim()) nameEl.value = data.name; }
      if (data.description) { const descEl = document.getElementById('wv-description'); if (descEl && !descEl.value.trim()) descEl.value = data.description; }
      if (data.setting) { settingEl.value = data.setting; settingEl.style.height = 'auto'; settingEl.style.height = settingEl.scrollHeight + 'px'; }
      if (data.currency?.name) { try { await Worldview.applyGeneratedCurrency(data.currency.name, data.currency.desc || ''); } catch(_) {} }
      UI.showToast('设定已生成，可继续编辑', 2000);
    });
  }

  /** 开场内联生成 */
  async function inlineOpening() {
    const settingEl = document.getElementById('wv-setting');
    const setting = settingEl?.value?.trim() || '';
    if (!setting) { UI.showToast('请先填写世界观设定', 1500); return; }
    const w = await Worldview._getEditingWV();

    await _openInlineGenModal({
      icon: 'message',
      title: 'AI 生成开场',
      desc: '生成开场时间、开场剧情与第一条气泡',
      placeholder: '对开场有什么要求？留空则由 AI 自由发挥\n如：从选灵根开始、酒馆偶遇…',
      hideWords: true,
      hideCount: true,
      loadingMsg: '正在生成开场…'
    }, async ({ prompt, signal, lbRef }) => {
      const ctx = _buildWorldContext(w, '生成本世界观的开场内容（startTime / startPlot / startMessage）', setting);
      const userMsg = (prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : '') + ctx + (lbRef || '');
      const raw = await API.generate(PROMPTS.step5, userMsg, { signal });
      _lastRawOutput = raw;
      const data = _parseJSON(raw);
      if (!data) throw new Error('AI返回了空结构（看console原文）');
      if (data.startTime) { const el = document.getElementById('wv-start-time'); if (el) { el.value = data.startTime; if (typeof Worldview !== 'undefined' && Worldview._fillStartTimeFields) Worldview._fillStartTimeFields(data.startTime); } }
      if (data.startPlot) { const el = document.getElementById('wv-start-plot'); if (el) { el.value = data.startPlot; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }
      if (data.startMessage) { const el = document.getElementById('wv-start-message'); if (el) { el.value = data.startMessage; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }
      UI.showToast('开场已生成，可继续编辑', 2000);
    });
  }

  /** 地区内联生成（在详细设定tab内，为当前世界观批量生成地区） */
  async function inlineRegions() {
    const settingEl = document.getElementById('wv-setting');
    const setting = settingEl?.value?.trim() || '';
    if (!setting) { UI.showToast('请先填写世界观设定', 1500); return; }
    const w = await Worldview._getEditingWV();

    await _openInlineGenModal({
      icon: 'globe',
      title: 'AI 追加地区',
      desc: '为当前世界观批量生成地区',
      placeholder: '对地区有什么要求？留空则由 AI 自由发挥',
      countLabel: '生成地区数',
      defaults: { count: 5, wordCount: 300 },
      limits: { count: [1, REGION_COUNT_MAX], wordCount: [100, 1000] },
      countHelp: '建议 3–8 个，最多 12 个。为避免页面卡顿或生成中断，建议分批生成，后续可继续追加。',
      loadingMsg: '正在生成地区…'
    }, async ({ prompt, count, wordCount, signal, lbRef }) => {
      const sysPrompt = PROMPTS.step2.replace('##WORD_COUNT##', wordCount).replace('##EXISTING_REGIONS##', '');
      const ctx = _buildWorldContext(w, `为当前世界观新增 ${count} 个地区`, setting);
      const userMsg = (prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : '') + `生成 ${count} 个地区。\n\n` + ctx + (lbRef || '');
      const raw = await API.generate(sysPrompt, userMsg, { signal });
      const data = _parseJSON(raw);
      const arr = _limitRegions(Array.isArray(data) ? data : (data.regions || []));
      if (typeof Worldview !== 'undefined' && Worldview._getEditingWV) {
        const w = await Worldview._getEditingWV();
        if (w) {
          for (const r of arr) {
            w.regions.push({
              id: 'reg_' + Utils.uuid().slice(0,8),
              name: r.name || '',
              summary: r.description || '',
              detail: r.setting || '',
              factions: [{ id: 'fac_' + Utils.uuid().slice(0,8), name: (r.name || '默认') + '势力', summary: '', detail: '', npcs: [] }]
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
      limits: { count: [1, 10], wordCount: [200, 1200] },
      countHelp: '建议 2–4 个，最多 10 个。数量过多会增加后续角色生成压力，建议分批补充。',
      loadingMsg: '正在生成势力…'
    }, async ({ prompt, count, wordCount, signal, lbRef }) => {
      const sysPrompt = PROMPTS.step3.replace('##WORD_COUNT##', wordCount);
      const ctx = _buildWorldContext(w, `为地区「${regName}」新增 ${count} 个势力`);
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}为地区「${regName}」生成 ${count} 个势力。\n\n${ctx}\n\n## 当前地区详情\n${document.getElementById('wv-reg-detail')?.value || ''}` + (lbRef || '');
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

  // ========== 编辑页批量生成势力（跨地区勾选 + 一次合并 + 追加落库）==========
  // 记录本次批量已成功生成势力的地区名（用于打✓划线、失败重勾），随弹窗生命周期存在
  let _facBatchDone = {}; // { 地区名: 本次新增势力数 }
  let _facBatchPrompt = '';
  let _facBatchWords = 500;
  let _facBatchCount = 3;

  /** 入口：批量生成势力（跨地区） */
  async function inlineFactionsBatch() {
    const w = await Worldview._getEditingWV();
    if (!w) return;
    if (!(w.regions || []).length) { UI.showToast('还没有地区，请先添加地区', 2000); return; }
    if (!_getEditingSetting(w)) { UI.showToast('请先填写世界观设定', 1500); return; }
    _facBatchDone = {};
    _facBatchPrompt = '';
    _facBatchWords = 500;
    _facBatchCount = 3;
    await _renderFactionsBatchModal();
  }

  async function _renderFactionsBatchModal() {
    const modal = _getModal();
    const body = document.getElementById('wv-gen-body');
    if (!modal || !body) { UI.showToast('弹窗加载失败', 1500); return; }
    const w = await Worldview._getEditingWV();
    if (!w) return;
    const regions = w.regions || [];
    const rows = regions.map((r, i) => {
      const added = _facBatchDone[r.name] || 0;
      const existing = (r.factions || []).length;
      const done = added > 0;
      const checked = done ? '' : 'checked';
      return `<label class="wv-gen-region-check${done ? ' is-done' : ''}">
        <input type="checkbox" class="circle-check wv-fb-cb" value="${Utils.escapeHtml(r.name)}" ${checked} onchange="WvGenerator._updateFacBatchEstimate()">
        <span class="circle-check-ui"></span>
        <span class="wv-gen-region-nm">${Utils.escapeHtml(r.name || ('地区' + (i + 1)))}${existing ? `（现有 ${existing} 势力）` : ''}</span>
        ${done ? `<span class="wv-gen-region-done">✓ 本次+${added}</span>` : ''}
      </label>`;
    }).join('');
    body.innerHTML = `
      ${_stepIntro('castle', '批量生成势力', '勾选地区，一次性为选中的每个地区追加势力（不覆盖已有）')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">额外要求（可选）</label>
        <textarea id="wv-fb-prompt" rows="3" placeholder="对势力有什么要求？留空则由 AI 自由发挥" class="wv-gen-textarea">${Utils.escapeHtml(_facBatchPrompt)}</textarea>
      </div>
      ${_refLorebookBtnHtml('inline')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">选择地区（本次已生成的默认不勾，可重勾再追加）</label>
        <div class="wv-gen-region-list">${rows || '<div class="wv-gen-help">没有地区</div>'}</div>
      </div>
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">单条字数（≤1200）</label>
          <input id="wv-fb-words" type="number" min="200" max="1200" step="50" value="${_facBatchWords}" class="wv-gen-input" oninput="WvGenerator._updateFacBatchEstimate()">
        </div>
        <div class="wv-gen-field">
          <label class="wv-gen-label">每地区势力数</label>
          <input id="wv-fb-count" type="number" min="1" max="10" inputmode="numeric" value="${_facBatchCount}" class="wv-gen-input" oninput="WvGenerator._enforceCountInput('wv-fb-count', 10, '每地区势力数'); WvGenerator._updateFacBatchEstimate()" onchange="WvGenerator._enforceCountInput('wv-fb-count', 10, '每地区势力数', true); WvGenerator._updateFacBatchEstimate()" onblur="WvGenerator._enforceCountInput('wv-fb-count', 10, '每地区势力数', true)">
        </div>
      </div>
      <div id="wv-gen-estimate" class="wv-gen-estimate"></div>
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div class="wv-gen-actions">
        <button id="wv-fb-close" class="wv-gen-btn">关闭</button>
        <button id="wv-gen-submit" class="wv-gen-btn primary">生成势力</button>
      </div>`;
    modal.classList.remove('hidden');
    _refreshRefLorebookBtn('inline');
    _updateFacBatchEstimate();
    document.getElementById('wv-fb-close').onclick = () => {
      if (_abortCtrl) { try { _abortCtrl.abort(); } catch(_) {} _abortCtrl = null; }
      modal.classList.add('hidden');
    };
    document.getElementById('wv-gen-submit').onclick = _runFactionsBatch;
  }

  function _updateFacBatchEstimate() {
    const el = document.getElementById('wv-gen-estimate');
    if (!el) return;
    const nRegion = Array.from(document.querySelectorAll('.wv-fb-cb')).filter(cb => cb.checked).length;
    const words = Math.min(1200, Math.max(200, parseInt(document.getElementById('wv-fb-words')?.value) || 500));
    const count = Math.min(10, Math.max(1, parseInt(document.getElementById('wv-fb-count')?.value) || 3));
    if (nRegion === 0) { el.className = 'wv-gen-estimate'; el.innerHTML = '<span class="wv-gen-help">未勾选地区</span>'; _repaintModalScroll(); return; }
    const total = nRegion * count * words;
    const base = `已勾 ${nRegion} 个地区 × ${count} 势力 × 约 ${words} 字 ≈ 预计 ~${total} 字`;
    if (total > 8000) {
      el.className = 'wv-gen-estimate warn';
      el.innerHTML = `⚠ ${base}<br>内容较大，一次生成可能截断（能解析多少存多少）。建议减少勾选或降低字数。`;
    } else { el.className = 'wv-gen-estimate'; el.innerHTML = base; }
    _repaintModalScroll();
  }

  async function _runFactionsBatch() {
    const w = await Worldview._getEditingWV();
    if (!w) return;
    const checkedNames = Array.from(document.querySelectorAll('.wv-fb-cb')).filter(cb => cb.checked).map(cb => cb.value);
    if (checkedNames.length === 0) { UI.showToast('请至少勾选一个地区', 2000); return; }
    const regions = (w.regions || []).filter(r => checkedNames.includes(r.name));
    _facBatchPrompt = document.getElementById('wv-fb-prompt')?.value?.trim() || '';
    _facBatchWords = Math.min(1200, Math.max(200, parseInt(document.getElementById('wv-fb-words')?.value) || 500));
    _facBatchCount = Math.min(10, Math.max(1, parseInt(document.getElementById('wv-fb-count')?.value) || 3));

    _setLoading(true, `正在生成势力（勾选 ${regions.length} 个地区，一次合并生成）…`);
    try {
      _abortCtrl = new AbortController();
      const sysPrompt = PROMPTS.step3.replace('##WORD_COUNT##', _facBatchWords);
      const regionBlocks = regions.map(r => `### ${r.name}\n${_regionDetail(r)}`).join('\n\n');
      const lbRef = await _buildLorebookRefText('inline');
      const userMsg = `${_facBatchPrompt ? '用户要求：' + _facBatchPrompt + '\n\n' : ''}请为下面每一个地区分别生成 ${_facBatchCount} 个势力，务必用对象格式返回：{ "地区名": [ {势力对象}, ... ] }，键名严格用下面给出的地区名。\n\n## 世界观设定\n${_getEditingSetting(w) || ''}\n\n## 需要生成势力的地区（共 ${regions.length} 个，注意：不要与该地区现有势力重复）\n${regionBlocks}` + (lbRef || '');
      const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal });
      _lastRawOutput = raw;
      const data = _parseJSON(raw);

      // 逐地区提取
      let succ = 0, fail = 0;
      const failNames = [];
      const perRegion = {}; // 地区名 -> 新增势力数组
      for (const reg of regions) {
        let arr = [];
        if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data[reg.name])) arr = data[reg.name];
        arr = (arr || []).filter(f => f && f.name);
        if (arr.length > 0) { perRegion[reg.name] = arr; succ++; } else { fail++; failNames.push(reg.name); }
      }
      // 兜底：扁平数组按 region 字段归位
      if (succ === 0 && Array.isArray(data)) {
        for (const reg of regions) {
          const arr = data.filter(f => f && f.name && (f.region === reg.name || !f.region));
          if (arr.length > 0) { perRegion[reg.name] = arr; succ++; }
        }
        failNames.length = 0;
        for (const reg of regions) if (!(perRegion[reg.name]?.length)) failNames.push(reg.name);
        fail = failNames.length;
      }

      // 追加落库（不覆盖已有势力）
      const wFresh = await Worldview._getEditingWV();
      for (const reg of regions) {
        const arr = perRegion[reg.name];
        if (!arr || !arr.length) continue;
        const target = (wFresh.regions || []).find(r => r.name === reg.name);
        if (!target) continue;
        target.factions = target.factions || [];
        arr.forEach(f => target.factions.push({
          id: 'fac_' + Utils.uuid().slice(0, 8),
          name: f.name || '', summary: f.description || '', detail: f.setting || '', npcs: []
        }));
        _facBatchDone[reg.name] = (_facBatchDone[reg.name] || 0) + arr.length;
      }
      await Worldview._saveEditingWV(wFresh);
      if (Worldview._renderRegions) Worldview._renderRegions(wFresh.regions);
      _setLoading(false);

      if (succ === 0) {
        UI.showToast('生成失败：未解析出势力，请重试', 3000);
        await _renderFactionsBatchModal();
        const st = document.getElementById('wv-gen-status');
        if (st) { st.style.display = ''; st.innerHTML = `<span style="color:var(--danger,#e57373)">生成失败：未解析出任何势力（可能因内容过大被截断）。可减少勾选/字数后重试。</span>`; }
        return;
      }
      if (fail > 0) {
        UI.showToast(`成功 ${succ} 个地区，失败 ${fail} 个：${failNames.join('、')}`, 3500);
        await _renderFactionsBatchModal();
        const st = document.getElementById('wv-gen-status');
        if (st) { st.style.display = ''; st.innerHTML = `<span style="color:var(--warning,#e0a030)">部分成功：${succ} 个地区已追加势力，${fail} 个未解析出（${failNames.join('、')}）。已保留成功的，可重勾失败的重试。</span>`; }
        return;
      }
      // 全部成功
      UI.showToast(`已为 ${succ} 个地区追加势力`, 2000);
      await _renderFactionsBatchModal();
      const st = document.getElementById('wv-gen-status');
      if (st) { st.style.display = ''; st.innerHTML = `<span style="color:var(--accent)">✓ 已为 ${succ} 个地区追加势力。可继续勾选其它地区，或关闭。</span>`; }
    } catch (e) {
      _setLoading(false);
      if (e.name === 'AbortError') return;
      _onGenFail(e, '批量生成势力');
    }
  }

  // ========== 编辑页批量生成角色（跨势力勾选 + 一次合并 + 追加落库 + 全量去重）==========
  let _npcBatchDone = {}; // key = 地区名\u0000势力名 -> 本次新增角色数
  let _npcBatchPrompt = '';
  let _npcBatchWords = 500;
  let _npcBatchCount = 3;

  // 展平所有势力为 { region, faction, key } 列表
  function _flattenEditFactions(w) {
    const out = [];
    (w.regions || []).forEach(r => {
      (r.factions || []).forEach(f => {
        if (f && f.name) out.push({ region: r.name || '', faction: f, key: `${r.name || ''}\u0000${f.name || ''}` });
      });
    });
    return out;
  }

  /** 入口：批量生成角色（跨势力） */
  async function inlineNpcsBatch() {
    const w = await Worldview._getEditingWV();
    if (!w) return;
    if (!_flattenEditFactions(w).length) { UI.showToast('还没有势力，请先生成/添加势力', 2000); return; }
    if (!_getEditingSetting(w)) { UI.showToast('请先填写世界观设定', 1500); return; }
    _npcBatchDone = {};
    _npcBatchPrompt = '';
    _npcBatchWords = 500;
    _npcBatchCount = 3;
    await _renderNpcsBatchModal();
  }

  async function _renderNpcsBatchModal() {
    const modal = _getModal();
    const body = document.getElementById('wv-gen-body');
    if (!modal || !body) { UI.showToast('弹窗加载失败', 1500); return; }
    const w = await Worldview._getEditingWV();
    if (!w) return;
    const list = _flattenEditFactions(w);
    const rows = list.map((it, i) => {
      const added = _npcBatchDone[it.key] || 0;
      const existing = (it.faction.npcs || []).length;
      const done = added > 0;
      const checked = done ? '' : 'checked';
      return `<label class="wv-gen-region-check${done ? ' is-done' : ''}">
        <input type="checkbox" class="circle-check wv-nb-cb" value="${i}" ${checked} onchange="WvGenerator._updateNpcBatchEstimate()">
        <span class="circle-check-ui"></span>
        <span class="wv-gen-region-nm">${Utils.escapeHtml(it.region || '')} / ${Utils.escapeHtml(it.faction.name || ('势力' + (i + 1)))}${existing ? `（现有 ${existing} 角色）` : ''}</span>
        ${done ? `<span class="wv-gen-region-done">✓ 本次+${added}</span>` : ''}
      </label>`;
    }).join('');
    body.innerHTML = `
      ${_stepIntro('users', '批量生成角色', '勾选势力（可跨地区），一次性为选中的每个势力追加角色（不覆盖已有）')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">额外要求（可选）</label>
        ${_fsWrap(`<textarea id="wv-nb-prompt" rows="3" placeholder="对角色有什么要求？留空则由 AI 自由发挥" class="wv-gen-textarea">${Utils.escapeHtml(_npcBatchPrompt)}</textarea>`, 'wv-nb-prompt', '角色额外要求')}
      </div>
      ${_refLorebookBtnHtml('inline')}
      <div class="wv-gen-field">
        <label class="wv-gen-label">选择势力（本次已生成的默认不勾，可重勾再追加）</label>
        <div class="wv-gen-region-list">${rows || '<div class="wv-gen-help">没有势力</div>'}</div>
      </div>
      <div class="wv-gen-grid">
        <div class="wv-gen-field">
          <label class="wv-gen-label">单条字数（≤1500）</label>
          <input id="wv-nb-words" type="number" min="200" max="1500" step="50" value="${_npcBatchWords}" class="wv-gen-input" oninput="WvGenerator._updateNpcBatchEstimate()">
        </div>
        <div class="wv-gen-field">
          <label class="wv-gen-label">每势力角色数</label>
          <input id="wv-nb-count" type="number" min="1" max="10" inputmode="numeric" value="${_npcBatchCount}" class="wv-gen-input" oninput="WvGenerator._enforceCountInput('wv-nb-count', 10, '每势力角色数'); WvGenerator._updateNpcBatchEstimate()" onchange="WvGenerator._enforceCountInput('wv-nb-count', 10, '每势力角色数', true); WvGenerator._updateNpcBatchEstimate()" onblur="WvGenerator._enforceCountInput('wv-nb-count', 10, '每势力角色数', true)">
        </div>
      </div>
      <div id="wv-gen-estimate" class="wv-gen-estimate"></div>
      <div id="wv-gen-status" class="wv-gen-status"></div>
      <div class="wv-gen-actions">
        <button id="wv-nb-close" class="wv-gen-btn">关闭</button>
        <button id="wv-gen-submit" class="wv-gen-btn primary">生成角色</button>
      </div>`;
    modal.classList.remove('hidden');
    _refreshRefLorebookBtn('inline');
    _updateNpcBatchEstimate();
    document.getElementById('wv-nb-close').onclick = () => {
      if (_abortCtrl) { try { _abortCtrl.abort(); } catch(_) {} _abortCtrl = null; }
      modal.classList.add('hidden');
    };
    document.getElementById('wv-gen-submit').onclick = _runNpcsBatch;
  }

  function _updateNpcBatchEstimate() {
    const el = document.getElementById('wv-gen-estimate');
    if (!el) return;
    const nFac = Array.from(document.querySelectorAll('.wv-nb-cb')).filter(cb => cb.checked).length;
    const words = Math.min(1500, Math.max(200, parseInt(document.getElementById('wv-nb-words')?.value) || 500));
    const count = Math.min(10, Math.max(1, parseInt(document.getElementById('wv-nb-count')?.value) || 3));
    if (nFac === 0) { el.className = 'wv-gen-estimate'; el.innerHTML = '<span class="wv-gen-help">未勾选势力</span>'; _repaintModalScroll(); return; }
    const total = nFac * count * words;
    const base = `已勾 ${nFac} 个势力 × ${count} 角色 × 约 ${words} 字 ≈ 预计 ~${total} 字`;
    if (total > 8000) {
      el.className = 'wv-gen-estimate warn';
      el.innerHTML = `⚠ ${base}<br>内容较大，一次生成可能截断（能解析多少存多少）。建议减少勾选或降低字数。`;
    } else { el.className = 'wv-gen-estimate'; el.innerHTML = base; }
    _repaintModalScroll();
  }

  async function _runNpcsBatch() {
    const w = await Worldview._getEditingWV();
    if (!w) return;
    const list = _flattenEditFactions(w);
    const checkedIdx = Array.from(document.querySelectorAll('.wv-nb-cb')).filter(cb => cb.checked).map(cb => parseInt(cb.value));
    if (checkedIdx.length === 0) { UI.showToast('请至少勾选一个势力', 2000); return; }
    const tasks = checkedIdx.map(i => list[i]).filter(Boolean);
    _npcBatchPrompt = document.getElementById('wv-nb-prompt')?.value?.trim() || '';
    _npcBatchWords = Math.min(1500, Math.max(200, parseInt(document.getElementById('wv-nb-words')?.value) || 500));
    _npcBatchCount = Math.min(10, Math.max(1, parseInt(document.getElementById('wv-nb-count')?.value) || 3));

    _setLoading(true, `正在生成角色（勾选 ${tasks.length} 个势力，一次合并生成）…`);
    try {
      _abortCtrl = new AbortController();
      const sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', _npcBatchWords);

      // 去重上下文：发已有角色全量资料卡（防止家家套同样的家人）
      let existingCards = [];
      let knowledgeHint = '';
      const seenNames = new Set();
      _collectAllNpcsFull(w).forEach(({ npc, source }) => {
        if (npc.name && !seenNames.has(npc.name)) { seenNames.add(npc.name); existingCards.push(_npcProfileCard(npc, source)); }
      });
      const knowledges = (w.knowledges || []).filter(k => k && k.enabled !== false && k.content);
      if (knowledges.length) knowledgeHint = `\n\n## 世界书条目\n${knowledges.map(k => `### ${k.name || '未命名'}\n${k.content}`).join('\n\n')}`;
      const dedupeHint = existingCards.length > 0
        ? `\n\n## 已有角色资料（不要重名/近似名；新角色的人际关系请与这些既有角色对接，不要每个势力都凭空造一套相同的家庭成员）\n${existingCards.join('\n\n')}`
        : '';

      const facBlocks = tasks.map(t => {
        const facDetail = t.faction.setting || t.faction.detail || t.faction.summary || '';
        return `### ${t.faction.name}（地区：${t.region}）\n${facDetail}`;
      }).join('\n\n');
      const facNameList = tasks.map(t => `「${t.faction.name}」`).join('、');
      const lbRef = await _buildLorebookRefText('inline');
      const userMsg = `${_npcBatchPrompt ? '用户要求：' + _npcBatchPrompt + '\n\n' : ''}请为下面每一个势力分别生成 ${_npcBatchCount} 个角色，务必用对象格式返回：{ "势力名": [ {角色对象}, ... ] }，键名严格用下面给出的势力名（${facNameList}）。每个角色的 faction 必须是所属势力名、region 必须是该势力所在地区。\n\n## 世界观设定\n${_getEditingSetting(w) || ''}\n\n## 需要生成角色的势力（共 ${tasks.length} 个）\n${facBlocks}${dedupeHint}${knowledgeHint}` + (lbRef || '');

      const raw = await API.generate(sysPrompt, userMsg, { signal: _abortCtrl.signal });
      _lastRawOutput = raw;
      const data = _parseJSON(raw);

      // 逐势力提取
      let succ = 0, fail = 0;
      const failNames = [];
      const perTask = {}; // key -> 角色数组
      for (const t of tasks) {
        let arr = [];
        if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data[t.faction.name])) arr = data[t.faction.name];
        arr = (arr || []).filter(n => n && n.name);
        if (arr.length > 0) { perTask[t.key] = arr; succ++; } else { fail++; failNames.push(`${t.region}/${t.faction.name}`); }
      }
      // 兜底：扁平数组按 faction 字段归位
      if (succ === 0 && Array.isArray(data)) {
        for (const t of tasks) {
          const arr = (data || []).filter(n => n && n.name && (n.faction === t.faction.name || (!n.faction && tasks.length === 1)));
          if (arr.length > 0) { perTask[t.key] = arr; succ++; }
        }
        failNames.length = 0;
        for (const t of tasks) if (!(perTask[t.key]?.length)) failNames.push(`${t.region}/${t.faction.name}`);
        fail = failNames.length;
      }

      // 追加落库（不覆盖已有角色）
      const wFresh = await Worldview._getEditingWV();
      const freshList = _flattenEditFactions(wFresh);
      for (const t of tasks) {
        const arr = perTask[t.key];
        if (!arr || !arr.length) continue;
        const target = freshList.find(x => x.key === t.key);
        if (!target) continue;
        target.faction.npcs = target.faction.npcs || [];
        arr.forEach(n => target.faction.npcs.push({
          id: 'npc_' + Utils.uuid().slice(0, 8),
          name: n.name || '', aliases: _npcAliases(n), summary: _npcSummary(n), detail: _mergeMetaToDetail(n), avatar: ''
        }));
        _npcBatchDone[t.key] = (_npcBatchDone[t.key] || 0) + arr.length;
      }
      await Worldview._saveEditingWV(wFresh);
      if (Worldview._renderRegions) Worldview._renderRegions(wFresh.regions);
      _setLoading(false);

      if (succ === 0) {
        UI.showToast('生成失败：未解析出角色，请重试', 3000);
        await _renderNpcsBatchModal();
        const st = document.getElementById('wv-gen-status');
        if (st) { st.style.display = ''; st.innerHTML = `<span style="color:var(--danger,#e57373)">生成失败：未解析出任何角色（可能因内容过大被截断）。可减少勾选/字数后重试。</span>`; }
        return;
      }
      if (fail > 0) {
        UI.showToast(`成功 ${succ} 个势力，失败 ${fail} 个：${failNames.join('、')}`, 3500);
        await _renderNpcsBatchModal();
        const st = document.getElementById('wv-gen-status');
        if (st) { st.style.display = ''; st.innerHTML = `<span style="color:var(--warning,#e0a030)">部分成功：${succ} 个势力已追加角色，${fail} 个未解析出（${failNames.join('、')}）。已保留成功的，可重勾失败的重试。</span>`; }
        return;
      }
      UI.showToast(`已为 ${succ} 个势力追加角色`, 2000);
      await _renderNpcsBatchModal();
      const st = document.getElementById('wv-gen-status');
      if (st) { st.style.display = ''; st.innerHTML = `<span style="color:var(--accent)">✓ 已为 ${succ} 个势力追加角色。可继续勾选其它势力，或关闭。</span>`; }
    } catch (e) {
      _setLoading(false);
      if (e.name === 'AbortError') return;
      _onGenFail(e, '批量生成角色');
    }
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
      limits: { count: [1, 10], wordCount: [200, 1500] },
      countHelp: '建议 2–4 个，最多 10 个。角色过多可能导致页面卡顿或生成中断，建议分批追加。',
      loadingMsg: '正在生成角色…'
    }, async ({ prompt, count, wordCount, signal, lbRef }) => {
      const sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);
      const facDetail = document.getElementById('wv-fac-detail')?.value || '';
      const ctx = _buildWorldContext(w, `为势力「${facName}」新增 ${count} 个角色，角色的 region/faction 字段必须对应当前地区和势力`);
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}为势力「${facName}」生成 ${count} 个角色。角色 region/faction 字段必须对应当前地区和势力。\n\n${ctx}\n\n## 当前势力详情\n${facDetail}` + (lbRef || '');
      const raw = await API.generate(sysPrompt, userMsg, { signal, maxTokens: 18000 });
      const data = _parseJSON(raw);
      const arr = _normalizeArray(data, 'npcs');
      // 重新从 DB 读最新版（避免与自动保存竞态）
      const freshW = await Worldview._getEditingWV();
      if (!freshW) { UI.showToast('世界观数据丢失', 2000); return; }
      let fac = null;
      for (const r of (freshW.regions || [])) { fac = (r.factions || []).find(f => f.name === facName); if (fac) break; }
      if (!fac) { UI.showToast('找不到当前势力，请先保存势力名称', 2000); return; }
      fac.npcs = fac.npcs || [];
      arr.forEach(n => fac.npcs.push({ id: 'npc_' + Utils.uuid().slice(0,8), name: n.name || '', aliases: _npcAliases(n), summary: _npcSummary(n), detail: _mergeMetaToDetail(n), avatar: '' }));
      await Worldview._saveEditingWV(freshW);
      if (Worldview._renderNPCCards) Worldview._renderNPCCards(fac.npcs);
      if (arr.length === 0) throw new Error("AI返回了空结构（看console原文）"); UI.showToast(`已生成 ${arr.length} 个角色`, 2000);
    });
  }

  /** 常驻角色内联生成 */
  async function inlineGlobalNpcs() {
    // v632.1：优先从编辑中的 wv/lb 取设定；wv-setting input 只在世界观 basic tab 才存在
    const w = await Worldview._getEditingWV();
    const setting = _getEditingSetting(w) || (document.getElementById('wv-setting')?.value?.trim() || '');
    if (!setting) { UI.showToast(w?._hidden ? '请先填写世界书描述' : '请先填写世界观设定', 1500); return; }

    await _openInlineGenModal({
      icon: 'users',
      title: w?._hidden ? 'AI 追加常驻角色（世界书）' : 'AI 追加常驻角色',
      desc: w?._hidden ? '为当前世界书批量生成常驻角色' : '为当前世界观批量生成全图常驻角色',
      placeholder: '对角色有什么要求？留空则由 AI 自由发挥',
      countLabel: '生成角色数',
      defaults: { count: 5, wordCount: 500 },
      limits: { count: [1, 10], wordCount: [200, 1500] },
      countHelp: '建议 2–4 个，最多 10 个。角色过多可能导致页面卡顿或生成中断，建议分批追加。',
      loadingMsg: '正在生成角色…'
    }, async ({ prompt, count, wordCount, signal, lbRef }) => {
      const sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);
      const dedupeNpcs = _collectAllNpcNames(w);
      const dedupeHint = _buildNpcDedupeHint(dedupeNpcs);
      const ctx = _buildWorldContext(w, `为当前世界观新增 ${count} 个常驻角色（不归属任何地区）`);
      const userMsg = (prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : '') + `生成 ${count} 个角色。所有角色都是常驻角色（不归属地区）。\n\n` + ctx + dedupeHint + (lbRef || '');
      const raw = await API.generate(sysPrompt, userMsg, { signal });
      const npcs = _parseJSON(raw);
      const arr = Array.isArray(npcs) ? npcs : (npcs.npcs || []);
      if (typeof Worldview !== 'undefined' && Worldview._getEditingWV) {
        const wFresh = await Worldview._getEditingWV();
        if (wFresh) {
          if (!wFresh.globalNpcs) wFresh.globalNpcs = [];
          for (const npc of arr) {
            wFresh.globalNpcs.push({
              id: 'npc_' + Utils.uuid().slice(0, 8),
              name: npc.name || '',
          aliases: _npcAliases(npc),
          summary: _npcSummary(npc),
          detail: _mergeMetaToDetail(npc),
          avatar: ''
        });
          }
          await Worldview._saveEditingWV(wFresh);
          if (Worldview._renderGlobalNpcs) Worldview._renderGlobalNpcs(wFresh.globalNpcs);
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
    }, async ({ prompt, wordCount, signal, lbRef }) => {
      const sysPrompt = PROMPTS.step2.replace('##WORD_COUNT##', wordCount).replace('##EXISTING_REGIONS##', '');
      const existingDetail = document.getElementById('wv-reg-detail')?.value?.trim() || '';
      const ctx = _buildWorldContext(w, `填充地区「${name}」的详细设定${existingDetail ? '（已有部分内容，请参考并扩充）' : ''}`);
      const targetInfo = existingDetail ? `\n\n## 「${name}」已有内容（参考并扩充）\n${existingDetail}` : '';
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}仅生成 1 个地区「${name}」的详细设定。\n\n${ctx}${targetInfo}` + (lbRef || '');
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
    }, async ({ prompt, wordCount, signal, lbRef }) => {
      const sysPrompt = PROMPTS.step3.replace('##WORD_COUNT##', wordCount);
      const existingDetail = document.getElementById('wv-fac-detail')?.value?.trim() || '';
      const ctx = _buildWorldContext(w, `填充势力「${name}」的详细设定${existingDetail ? '（已有部分内容，请参考并扩充）' : ''}`);
      const targetInfo = existingDetail ? `\n\n## 「${name}」已有内容（参考并扩充）\n${existingDetail}` : '';
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}仅生成 1 个势力「${name}」的详细设定。\n\n${ctx}${targetInfo}` + (lbRef || '');
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
const setting = _getEditingSetting(w);
if (!setting) { UI.showToast(w?._hidden ? '请先填写世界书描述' : '请先填写世界观设定', 1500); return; }

await _openInlineGenModal({
icon: 'users',
title: 'AI 填充本角色',
desc: `为角色「${name}」生成详细设定`,
placeholder: '对本角色有什么要求？留空则由 AI 自由发挥',
countLabel: '生成数量（固定 1）',
defaults: { count: 1, wordCount: 500 },
limits: { count: [1, 1], wordCount: [200, 1500] },
loadingMsg: `正在为「${name}」生成设定…`
}, async ({ prompt, wordCount, signal, lbRef }) => {
    const sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);
    const identity = document.getElementById('wv-npc-summary')?.value?.trim() || '';
    const existingDetail = document.getElementById('wv-npc-detail')?.value?.trim() || '';
    // 防撞名：把当前 NPC 排除在外，其余全列
    const dedupeNpcs = _collectAllNpcNames(w).filter(n => n.name !== name);
    const dedupeHint = _buildNpcDedupeHint(dedupeNpcs);
    const ctx = _buildWorldContext(w, `填充角色「${name}」${identity ? '（' + identity + '）' : ''}的详细设定${existingDetail ? '（已有部分内容，请参考并扩充）' : ''}`);
    const targetInfo = existingDetail ? `\n\n## 「${name}」已有内容（参考并扩充）\n${existingDetail}` : '';
    const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}仅生成 1 个角色「${name}」${identity ? '（' + identity + '）' : ''}的详细设定。\n\n${ctx}${dedupeHint}${targetInfo}` + (lbRef || '');
      const raw = await API.generate(sysPrompt, userMsg, { signal });
      _lastRawOutput = raw;
      const arr = _parseJSON(raw);
      const n = Array.isArray(arr) ? arr[0] : arr;
      if (!n) throw new Error('AI返回了空结构（看console原文）');
      const detail = document.getElementById('wv-npc-detail');
if (detail && (n.detail || _npcMetaBlock(n))) { detail.value = _mergeMetaToDetail(n); detail.style.height = 'auto'; detail.style.height = detail.scrollHeight + 'px'; }
      const aliases = document.getElementById('wv-npc-aliases');
      const summary = document.getElementById('wv-npc-summary');
      if (aliases && !aliases.value.trim() && _npcAliases(n)) aliases.value = _npcAliases(n);
        if (summary && !summary.value.trim()) {
          const sumStr = _npcSummary(n);
          if (sumStr) summary.value = sumStr;
        }
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
    }, async ({ prompt, wordCount, signal, lbRef }) => {
      const sysPrompt = PROMPTS.step2.replace('##WORD_COUNT##', wordCount).replace('##EXISTING_REGIONS##',
        `\n## 必须对齐的地区\n${empty.map(r => r.name).join('、')}`);
      const ctx = _buildWorldContext(w, `批量填充以下 ${empty.length} 个空白地区的详细设定：${empty.map(r => r.name).join('、')}`);
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}为以下地区生成设定（共 ${empty.length} 个，每个约 ${wordCount} 字）：${empty.map(r => r.name).join('、')}。\n\n${ctx}` + (lbRef || '');
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

  /** 批量填充已有常驻角色（一次请求） */
async function inlineFillAllGlobalNpcs() {
const w = await Worldview._getEditingWV();
if (!w) return;
const setting = _getEditingSetting(w);
if (!setting) { UI.showToast(w?._hidden ? '请先填写世界书描述' : '请先填写世界观设定', 1500); return; }
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
    }, async ({ prompt, wordCount, signal, lbRef }) => {
      const sysPrompt = PROMPTS.step4.replace('##WORD_COUNT##', wordCount);
      const names = empty.map(n => n.name + (n.summary ? '（' + n.summary + '）' : '')).join('、');
      const ctx = _buildWorldContext(w, `批量填充以下 ${empty.length} 个空白常驻角色的详细设定：${names}`);
      // 每个待填角色附上已有的部分信息（name/aliases/summary）
      const targetsInfo = empty.map(n => {
        const lines = [`- 姓名：${n.name}`];
        if (n.aliases?.trim()) lines.push(`  别称：${n.aliases}`);
        if (n.summary?.trim()) lines.push(`  速查：${n.summary}`);
        return lines.join('\n');
      }).join('\n');
      const userMsg = `${prompt.trim() ? '用户要求：' + prompt.trim() + '\n\n' : ''}为以下角色生成详细设定（共 ${empty.length} 个，每个约 ${wordCount} 字）。所有角色都是常驻角色。\n\n${ctx}\n\n## 待填充角色清单\n${targetsInfo}` + (lbRef || '');
      const raw = await API.generate(sysPrompt, userMsg, { signal, maxTokens: Math.min(20000, empty.length * wordCount * 4 + 2000) });
      _lastRawOutput = raw;
      const arr = _normalizeArray(_parseJSON(raw), 'npcs');
      if (!arr.length) throw new Error('AI返回了空结构（看console原文）');
      let filled = 0;
      for (const n of arr) {
        const target = w.globalNpcs.find(g => g.name === n.name);
        if (target && !target.detail?.trim()) {
          const merged = _mergeMetaToDetail(n);
          if (merged) { target.detail = merged; filled++; }
          if (_npcAliases(n) && !target.aliases?.trim()) target.aliases = _npcAliases(n);
          if (!target.summary?.trim()) {
            const sumStr = _npcSummary(n);
            if (sumStr) target.summary = sumStr;
          }
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
    _enforceCountInput,
    _enforceRegionCountInput,
    _runStep1,
    _runStep2,
    _runStep3,
    _updateStep3Estimate,
    _runStep4,
    _updateStep4Estimate,
    _pickRefLorebooks,
    _runStep5,
    _skipStep,
    _commit,
    inlineSetting,
    inlineOpening,
    inlineRegions,
    inlineFactions,
    inlineFactionsBatch,
    _updateFacBatchEstimate,
    inlineNpcsBatch,
    _updateNpcBatchEstimate,
    inlineFactionNpcs,
    inlineGlobalNpcs,
    inlineFillRegion,
    inlineFillFaction,
    inlineFillNpc,
    inlineFillAllRegions,
    inlineFillAllGlobalNpcs,
    _buildWorldContext
  };
})();
