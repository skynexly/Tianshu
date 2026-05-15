/**
 * 设置管理 — 多API预设
 */
const Settings = (() => {
  let presets = [];
  let currentPresetId = 'default';
  let editingPresetId = null;

  // 功能模型配置（总结、记忆提取、识图）
  let summaryPresets = [];
let memoryPresets = [];
let visionPresets = [];
  let gaidenPresets = [];
  let worldvoicePresets = [];
  let backstagePresets = [];
  let ttsPresets = [];
  let drawPresets = [];
  let currentSummaryId = 'default';
  let currentMemoryId = 'default';
  let currentVisionId = 'default';
  let currentGaidenId = 'default';
  let currentWorldvoiceId = 'default';
  let currentBackstageId = 'default';
  let currentTtsId = 'default';
  let currentDrawId = 'default';
  let editingSummaryId = null;
  let editingMemoryId = null;
  let editingVisionId = null;
  let editingGaidenId = null;
  let editingWorldvoiceId = null;
  let editingBackstageId = null;
  let editingTtsId = null;
  let editingDrawId = null;

// 管理模式状态
let presetManageMode = false;
let presetSelectedIds = new Set();
let funcManageMode = { summary: false, memory: false, vision: false, gaiden: false, worldvoice: false, backstage: false, tts: false, draw: false };
  let funcSelectedIds = { summary: new Set(), memory: new Set(), vision: new Set(), gaiden: new Set(), worldvoice: new Set(), backstage: new Set(), tts: new Set(), draw: new Set() };
  let regexManageMode = false;
  let regexSelectedIdxs = new Set();

  const PRESET_FIELDS = [
    { id: 'sp-name', key: 'name', def: '默认' },
    { id: 'sp-api-url', key: 'apiUrl', def: '' },
    { id: 'sp-api-key', key: 'apiKey', def: '', type: 'password' },
    { id: 'sp-model', key: 'model', def: '' },
    { id: 'sp-temperature', key: 'temperature', def: '0.8' },
    { id: 'sp-max-tokens', key: 'maxTokens', def: '4096' },
    { id: 'sp-token-limit', key: 'tokenLimit', def: '230000' },
    { id: 'sp-extract-interval', key: 'extractInterval', def: '20' },
  { id: 'sp-max-extract-events', key: 'maxExtractEvents', def: '5' },
  { id: 'sp-max-extract-relations', key: 'maxExtractRelations', def: '5' }
  ];

  async function init() {
    const data = await DB.get('settings', 'apiPresets');
    presets = (data?.value && data.value.length > 0) ? data.value : [{
      id: 'default', name: '默认',
      apiUrl: '', apiKey: '', model: '',
      temperature: '0.8', maxTokens: '4096', tokenLimit: '230000', extractInterval: '20'
  }];
  // 迁移旧数据
    const oldData = await DB.get('settings', 'api');
    if (oldData?.value?.apiUrl && presets[0].apiUrl === '') {
      Object.assign(presets[0], oldData.value);
      presets[0].name = presets[0].name || '默认';
      await savePresets();
    }
    const lastUsed = await DB.get('settings', 'currentPreset');
    currentPresetId = lastUsed?.value || presets[0].id;
    if (!presets.find(p => p.id === currentPresetId)) currentPresetId = presets[0].id;

    // 功能模型预设
    const sumData = await DB.get('settings', 'summaryPresets');
    summaryPresets = (sumData?.value && sumData.value.length > 0) ? sumData.value : [{ id: 'default', name: '默认', apiUrl: '', apiKey: '', model: '' }];
    const memData = await DB.get('settings', 'memoryPresets');
    memoryPresets = (memData?.value && memData.value.length > 0) ? memData.value : [{ id: 'default', name: '默认', apiUrl: '', apiKey: '', model: '' }];
    const visData = await DB.get('settings', 'visionPresets');
visionPresets = (visData?.value && visData.value.length > 0) ? visData.value : [{ id: 'default', name: '默认', apiUrl: '', apiKey: '', model: '' }];
    const gaiData = await DB.get('settings', 'gaidenPresets');
    gaidenPresets = (gaiData?.value && gaiData.value.length > 0) ? gaiData.value : [{ id: 'default', name: '默认', apiUrl: '', apiKey: '', model: '' }];
    const wvData = await DB.get('settings', 'worldvoicePresets');
worldvoicePresets = (wvData?.value && wvData.value.length > 0) ? wvData.value : [{ id: 'default', name: '默认', apiUrl: '', apiKey: '', model: '' }];
// v380 迁移：功能模型 UI 从“风闻模型”改为“手机模型”，旧预设名自动同步显示
let _worldvoiceNameMigrated = false;
worldvoicePresets.forEach(p => {
  if (p && typeof p.name === 'string' && /^风闻(\s|$)/.test(p.name)) {
    p.name = p.name.replace(/^风闻/, '手机');
    _worldvoiceNameMigrated = true;
  }
});
const bsData = await DB.get('settings', 'backstagePresets');
    backstagePresets = (bsData?.value && bsData.value.length > 0) ? bsData.value : [{ id: 'default', name: '默认', apiUrl: '', apiKey: '', model: '' }];
    const ttsData = await DB.get('settings', 'ttsPresets');
    ttsPresets = (ttsData?.value && ttsData.value.length > 0) ? ttsData.value : [{ id: 'default', name: '默认', apiUrl: 'https://api.minimaxi.com/v1/t2a_v2', apiKey: '', model: 'speech-2.8-hd', groupId: '' }];
    const drawData = await DB.get('settings', 'drawPresets');
    drawPresets = (drawData?.value && drawData.value.length > 0) ? drawData.value : [{ id: 'default', name: '默认', apiUrl: '', apiKey: '', model: '' }];

    const currSum = await DB.get('settings', 'currentSummary');
    currentSummaryId = currSum?.value || 'default';
    const currMem = await DB.get('settings', 'currentMemory');
    currentMemoryId = currMem?.value || 'default';
    const currVis = await DB.get('settings', 'currentVision');
    currentVisionId = currVis?.value || 'default';
    const currGai = await DB.get('settings', 'currentGaiden');
    currentGaidenId = currGai?.value || 'default';
    const currWv = await DB.get('settings', 'currentWorldvoice');
    currentWorldvoiceId = currWv?.value || 'default';
    const currBs = await DB.get('settings', 'currentBackstage');
    currentBackstageId = currBs?.value || 'default';
    const currTts = await DB.get('settings', 'currentTts');
    currentTtsId = currTts?.value || 'default';
    const currDraw = await DB.get('settings', 'currentDraw');
    currentDrawId = currDraw?.value || 'default';

    // 安全校验：currentId 指向的预设不存在则重置到第一个
    if (!summaryPresets.find(p => p.id === currentSummaryId)) currentSummaryId = summaryPresets[0]?.id || 'default';
    if (!memoryPresets.find(p => p.id === currentMemoryId)) currentMemoryId = memoryPresets[0]?.id || 'default';
    if (!visionPresets.find(p => p.id === currentVisionId)) currentVisionId = visionPresets[0]?.id || 'default';
    if (!gaidenPresets.find(p => p.id === currentGaidenId)) currentGaidenId = gaidenPresets[0]?.id || 'default';
    if (!worldvoicePresets.find(p => p.id === currentWorldvoiceId)) currentWorldvoiceId = worldvoicePresets[0]?.id || 'default';
    if (!backstagePresets.find(p => p.id === currentBackstageId)) currentBackstageId = backstagePresets[0]?.id || 'default';
    if (!ttsPresets.find(p => p.id === currentTtsId)) currentTtsId = ttsPresets[0]?.id || 'default';
    if (!drawPresets.find(p => p.id === currentDrawId)) currentDrawId = drawPresets[0]?.id || 'default';

    await savePresets();
  }

  async function savePresets() {
    await DB.put('settings', { key: 'apiPresets', value: presets });
    await DB.put('settings', { key: 'currentPreset', value: currentPresetId });
    await DB.put('settings', { key: 'summaryPresets', value: summaryPresets });
    await DB.put('settings', { key: 'currentSummary', value: currentSummaryId });
    await DB.put('settings', { key: 'memoryPresets', value: memoryPresets });
    await DB.put('settings', { key: 'currentMemory', value: currentMemoryId });
    await DB.put('settings', { key: 'visionPresets', value: visionPresets });
    await DB.put('settings', { key: 'currentVision', value: currentVisionId });
    await DB.put('settings', { key: 'gaidenPresets', value: gaidenPresets });
    await DB.put('settings', { key: 'currentGaiden', value: currentGaidenId });
    await DB.put('settings', { key: 'worldvoicePresets', value: worldvoicePresets });
    await DB.put('settings', { key: 'currentWorldvoice', value: currentWorldvoiceId });
    await DB.put('settings', { key: 'backstagePresets', value: backstagePresets });
    await DB.put('settings', { key: 'currentBackstage', value: currentBackstageId });
    await DB.put('settings', { key: 'ttsPresets', value: ttsPresets });
    await DB.put('settings', { key: 'currentTts', value: currentTtsId });
    await DB.put('settings', { key: 'drawPresets', value: drawPresets });
    await DB.put('settings', { key: 'currentDraw', value: currentDrawId });
  }

  function getCurrent() {
    return presets.find(p => p.id === currentPresetId) || presets[0] || {};
  }

  function getCurrentId() { return currentPresetId; }

  // 获取当前功能模型配置（空字段全部返回undefined以确保干净fallback）
  function _cleanFuncConfig(preset) {
    if (!preset) return {};
    const c = {};
    if (preset.apiUrl && preset.apiUrl.trim()) c.apiUrl = preset.apiUrl.trim();
    if (preset.apiKey && preset.apiKey.trim()) c.apiKey = preset.apiKey.trim();
    if (preset.model && preset.model.trim()) c.model = preset.model.trim();
    return c;
  }
  function getSummaryConfig() {
    return _cleanFuncConfig(summaryPresets.find(p => p.id === currentSummaryId) || summaryPresets[0]);
  }
  function getMemoryConfig() {
    return _cleanFuncConfig(memoryPresets.find(p => p.id === currentMemoryId) || memoryPresets[0]);
  }
  function getVisionConfig() {
    return _cleanFuncConfig(visionPresets.find(p => p.id === currentVisionId) || visionPresets[0]);
  }
  function getGaidenConfig() {
    return _cleanFuncConfig(gaidenPresets.find(p => p.id === currentGaidenId) || gaidenPresets[0]);
  }
  function getWorldvoiceConfig() {
    return _cleanFuncConfig(worldvoicePresets.find(p => p.id === currentWorldvoiceId) || worldvoicePresets[0]);
  }
  function getBackstageConfig() {
    return _cleanFuncConfig(backstagePresets.find(p => p.id === currentBackstageId) || backstagePresets[0]);
  }
  function getTtsConfig() {
    const preset = ttsPresets.find(p => p.id === currentTtsId) || ttsPresets[0];
    if (!preset) return {};
    const c = _cleanFuncConfig(preset);
    if (preset.groupId && preset.groupId.trim()) c.groupId = preset.groupId.trim();
    return c;
  }
  function getDrawConfig() {
    return _cleanFuncConfig(drawPresets.find(p => p.id === currentDrawId) || drawPresets[0]);
  }

  async function switchPreset(id, updateConv = true) {
    if (!presets.find(p => p.id === id)) return;
    currentPresetId = id;
    await savePresets();
    renderPresetList();
    try { Chat.renderQuickSwitches(); } catch(e) {}
    if (updateConv) {
      try { Conversations.setPreset(id); } catch(e) {}
    }
    GameLog.log('info', `切换API预设: ${getCurrent().name}`);
  }

  // ===== 编辑 =====

  async function load() {
    renderPresetList();
    renderRegexRules();
    renderFuncPresetList('summary');
    renderFuncPresetList('memory');
    renderFuncPresetList('vision');
    renderFuncPresetList('gaiden');
    renderFuncPresetList('worldvoice');
    renderFuncPresetList('backstage');
    renderFuncPresetList('tts');
  }

  function editPreset(id) {
  const preset = presets.find(p => p.id === id);
  if (!preset) return;
  editingPresetId = id;
  PRESET_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (el) el.value = preset[f.key] || f.def;
  });
  const tempVal = document.getElementById('sp-temp-val');
  if (tempVal) tempVal.textContent = preset.temperature || '0.8';
  const spLabel = document.getElementById('sp-model-label');
  if (spLabel) spLabel.textContent = preset.model || '手动输入';
  const spDropdown = document.getElementById('sp-model-dropdown');
  if (spDropdown) { spDropdown.innerHTML = ''; spDropdown.classList.add('hidden'); }
  document.getElementById('preset-edit-modal').classList.remove('hidden');
}

  async function savePreset() {
    if (!editingPresetId) return;
    const preset = presets.find(p => p.id === editingPresetId);
    if (!preset) return;
    PRESET_FIELDS.forEach(f => {
      const el = document.getElementById(f.id);
      if (el) preset[f.key] = el.value.trim();
    });
    // 校验
    const mt = parseInt(preset.maxTokens);
    if (mt > 32768) {
      if (!await UI.showConfirm('确认', `Max Tokens 设为 ${mt}，大部分模型上限是 8192~32768。确定？`)) return;
    }
    await savePresets();
    document.getElementById('preset-edit-modal').classList.add('hidden');
    editingPresetId = null;
    renderPresetList();
  }

async function cancelEdit() {
    const modal = document.getElementById('preset-edit-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
    editingPresetId = null;
  }

  async function createPreset() {
    const np = {
      id: 'preset_' + Utils.uuid().slice(0, 8),
      name: `API ${presets.length + 1}`,
      apiUrl: '', apiKey: '', model: '',
      temperature: '0.8', maxTokens: '4096', tokenLimit: '230000', extractInterval: '20'
  };
  presets.push(np);
    await savePresets();
    renderPresetList();
    editPreset(np.id);
  }

  async function clonePreset(id) {
    const src = presets.find(p => p.id === id);
    if (!src) return;
    const np = {
      ...src,
      id: 'preset_' + Utils.uuid().slice(0, 8),
      name: src.name + ' (副本)'
    };
    presets.push(np);
    await savePresets();
    renderPresetList();
    GameLog.log('info', `已复制预设: ${np.name}`);
  }

  async function deletePreset(id) {
    if (presets.length <= 1) { await UI.showAlert('提示', '至少保留一个预设'); return; }
    if (!await UI.showConfirm('确认删除', '确定删除？')) return;
    presets = presets.filter(p => p.id !== id);
    if (currentPresetId === id) currentPresetId = presets[0].id;
    await savePresets();
    renderPresetList();
  }

  async function previewPresetEndpoint(id) {
    const p = presets.find(x => x.id === id);
    if (!p) return;
    await UI.showAlert('预设详情', `预设名称: ${p.name}\nAPI端点: ${p.apiUrl || '未设置'}\n模型: ${p.model || '未设置'}`);
  }

  async function fetchModels() {
    const url = document.getElementById('sp-api-url').value.trim();
    const key = document.getElementById('sp-api-key').value.trim();
    if (!url || !key) { await UI.showAlert('提示', '请先填写端点和Key'); return; }
    const label = document.getElementById('sp-model-label');
    const dropdown = document.getElementById('sp-model-dropdown');
    label.textContent = '加载中...';
    dropdown.innerHTML = '';
    try {
      const models = await API.fetchModelList(url, key);
      _fillModelDropdown('sp', models);
      const cur = document.getElementById('sp-model').value;
      if (cur && models.includes(cur)) label.textContent = cur;
      GameLog.log('info', `获取到 ${models.length} 个模型`);
    } catch(e) {
      label.textContent = '获取失败';
      dropdown.innerHTML = '';
      GameLog.log('error', `获取模型列表失败: ${e.message}`);
    }
  }

  function toggleKeyVisibility(btnId, inputId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (input.type === 'password') {
      input.type = 'text';
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';
    }
    else {
      input.type = 'password';
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
    }
  }

  async function copyKey(inputId) {
    const val = document.getElementById(inputId)?.value;
    if (!val) { GameLog.log('warn', '没有可复制的Key'); return; }
    try {
      await navigator.clipboard.writeText(val);
      GameLog.log('info', 'Key已复制');
    } catch(e) {
      await UI.showCopyText('复制 Key', val);
    }
  }

  function _getPresets() { return presets; }

  // ===== 预设列表渲染 =====

  function renderPresetList() {
    const container = document.getElementById('preset-list');
    if (!container) return;

    let html = '';
    for (const p of presets) {
      const isSelected = presetSelectedIds.has(p.id);
      html += `
        <div class="card" style="${p.id === currentPresetId ? 'border-color:var(--accent)' : ''};display:flex;align-items:flex-start;gap:8px;padding:12px;background:var(--bg-tertiary);cursor:pointer;" onclick="${presetManageMode ? `Settings.togglePresetSelect('${p.id}')` : `Settings.switchPreset('${p.id}')`}">
          ${presetManageMode ? `
          <span style="width:22px;height:22px;border-radius:50%;border:2px solid ${isSelected ? 'var(--accent)' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${isSelected ? 'background:var(--accent);' : ''}" onclick="event.stopPropagation();Settings.togglePresetSelect('${p.id}')">
            ${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
          </span>` : `<input type="radio" name="preset" ${p.id === currentPresetId ? 'checked' : ''} onchange="Settings.switchPreset('${p.id}')" onclick="event.stopPropagation()" style="accent-color:var(--accent);margin-top:2px">`}
          <div style="flex:1;min-width:0;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:2px">
              <h3 style="margin:0;font-size:14px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(p.name)}</h3>
              <span style="font-size:11px;color:var(--text-secondary);white-space:nowrap">${Utils.escapeHtml(p.model || '未设置')}</span>
            </div>
            <span style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(p.apiUrl || '未设置端点')}</span>
          </div>
          ${!presetManageMode ? `<button onclick="event.stopPropagation();Settings.editPreset('${p.id}')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px;flex-shrink:0">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
          </button>` : ''}
        </div>
      `;
    }
    container.innerHTML = html;

    // 同步聊天界面的快速切换
    renderQuickSwitch();
  }

  function togglePresetSelect(id) {
    if (presetSelectedIds.has(id)) presetSelectedIds.delete(id);
    else presetSelectedIds.add(id);
    renderPresetList();
  }

  function togglePresetManageMode() {
    presetManageMode = !presetManageMode;
    presetSelectedIds.clear();
    const bar = document.getElementById('preset-manage-bar');
    const btn = document.getElementById('preset-manage-btn');
    const container = document.getElementById('preset-list');
    if (presetManageMode) {
      if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
      if (container) container.style.paddingBottom = '72px';
      if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg> 退出'; btn.style.background = 'var(--accent)'; btn.style.color = '#111'; btn.style.borderColor = 'var(--accent)'; }
    } else {
      if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
      if (container) container.style.paddingBottom = '';
      if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理'; btn.style.background = 'none'; btn.style.color = 'var(--text-secondary)'; btn.style.borderColor = 'var(--border)'; }
    }
    renderPresetList();
  }

  function exitPresetManageMode() {
    if (!presetManageMode) return;
    presetManageMode = false;
    presetSelectedIds.clear();
    const bar = document.getElementById('preset-manage-bar');
    const btn = document.getElementById('preset-manage-btn');
    const container = document.getElementById('preset-list');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    if (container) container.style.paddingBottom = '';
    if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理'; btn.style.background = 'none'; btn.style.color = 'var(--text-secondary)'; btn.style.borderColor = 'var(--border)'; }
    renderPresetList();
  }

  async function batchDeletePresets() {
    if (presetSelectedIds.size === 0) return;
    // 不能删除所有预设
    if (presetSelectedIds.size >= presets.length) { await UI.showAlert('提示', '至少保留一个预设'); return; }
    if (!await UI.showConfirm('批量删除', `确定删除选中的 ${presetSelectedIds.size} 个预设？`)) return;
    presets = presets.filter(p => !presetSelectedIds.has(p.id));
    if (!presets.find(p => p.id === currentPresetId)) currentPresetId = presets[0].id;
    presetSelectedIds.clear();
    await savePresets();
    renderPresetList();
    try { Chat.renderQuickSwitches(); } catch(e) {}
  }

  async function batchClonePresets() {
    if (presetSelectedIds.size === 0) return;
    for (const id of presetSelectedIds) {
      const src = presets.find(p => p.id === id);
      if (!src) continue;
      presets.push({ ...src, id: 'preset_' + Utils.uuid().slice(0, 8), name: src.name + ' (副本)' });
    }
    presetSelectedIds.clear();
    await savePresets();
    renderPresetList();
  }

  function renderQuickSwitch() {
    const el = document.getElementById('quick-api-switch');
    if (!el) return;
    el.innerHTML = presets.map(p =>
      `<button onclick="Settings.switchPreset('${p.id}')" style="padding:2px 8px;border-radius:4px;border:1px solid ${p.id === currentPresetId ? 'var(--accent)' : 'var(--border)'};background:${p.id === currentPresetId ? 'var(--accent)' : 'var(--bg-tertiary)'};color:${p.id === currentPresetId ? '#111' : 'var(--text-secondary)'};cursor:pointer;font-size:11px;white-space:nowrap">${Utils.escapeHtml(p.name)}</button>`
    ).join('');
  }

  // ===== 正则替换规则 =====

  let editingRegexIdx = -1; // -1=新建，>=0=编辑

  async function getRegexRules() {
    const data = await DB.get('gameState', 'regexRules');
    return data?.value || [];
  }

  async function saveRegexRules(rules) {
    await DB.put('gameState', { key: 'regexRules', value: rules });
  }

  async function renderRegexRules() {
    const container = document.getElementById('regex-rules-list');
    if (!container) return;
    const rules = await getRegexRules();

    if (rules.length === 0) {
      container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">暂无规则</p>';
      return;
    }

    container.innerHTML = rules.map((r, i) => {
      const isSelected = regexSelectedIdxs.has(i);
      return `
      <div class="card" style="opacity:${r.enabled === false ? '0.5' : '1'};padding:10px 12px;background:var(--bg-tertiary);margin-bottom:8px;cursor:${regexManageMode ? 'default' : 'pointer'}" onclick="${regexManageMode ? `Settings.toggleRegexSelect(${i})` : `Settings.editRegex(${i})`}">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${regexManageMode ? `
          <span style="width:22px;height:22px;border-radius:50%;border:2px solid ${isSelected ? 'var(--accent)' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${isSelected ? 'background:var(--accent);' : ''}" onclick="event.stopPropagation();Settings.toggleRegexSelect(${i})">
            ${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
          </span>` : `
          <label style="display:flex;align-items:center;cursor:pointer" onclick="event.stopPropagation()">
            <span style="position:relative;display:inline-flex;flex-shrink:0">
            <input type="checkbox" class="circle-check" ${r.enabled !== false ? 'checked' : ''} onchange="Settings.toggleRegex(${i},this.checked)">
            <span class="circle-check-ui"></span>
            </span>
          </label>`}
          <code style="flex:1;min-width:80px;font-size:12px;background:rgba(0,0,0,0.2);padding:2px 6px;border-radius:4px;color:var(--accent);word-break:break-all;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(r.pattern)}</code>
          <span style="font-size:12px;color:var(--text-secondary);flex-shrink:0">→</span>
          <code style="flex:1;min-width:40px;font-size:12px;background:rgba(0,0,0,0.2);padding:2px 6px;border-radius:4px;color:var(--text);word-break:break-all;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.replacement === '' ? '<i style="color:var(--text-secondary)">删除</i>' : Utils.escapeHtml(r.replacement)}</code>
          <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0">${r.flags || 'g'}</span>
        </div>
        ${r.note ? `<p style="font-size:11px;color:var(--text-secondary);margin-top:4px;margin-bottom:0">${Utils.escapeHtml(r.note)}</p>` : ''}
      </div>
    `}).join('');
  }

  function toggleRegexSelect(idx) {
    if (regexSelectedIdxs.has(idx)) regexSelectedIdxs.delete(idx);
    else regexSelectedIdxs.add(idx);
    renderRegexRules();
  }

  function toggleRegexManageMode() {
    regexManageMode = !regexManageMode;
    regexSelectedIdxs.clear();
    const bar = document.getElementById('regex-manage-bar');
    const btn = document.getElementById('regex-manage-btn');
    if (regexManageMode) {
      if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
      if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg> 退出'; btn.style.background = 'var(--accent)'; btn.style.color = '#111'; btn.style.borderColor = 'var(--accent)'; }
    } else {
      if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
      if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理'; btn.style.background = 'none'; btn.style.color = 'var(--text-secondary)'; btn.style.borderColor = 'var(--border)'; }
    }
    renderRegexRules();
  }

  function exitRegexManageMode() {
    if (!regexManageMode) return;
    regexManageMode = false;
    regexSelectedIdxs.clear();
    const bar = document.getElementById('regex-manage-bar');
    const btn = document.getElementById('regex-manage-btn');
    if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
    if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理'; btn.style.background = 'none'; btn.style.color = 'var(--text-secondary)'; btn.style.borderColor = 'var(--border)'; }
    renderRegexRules();
  }

  async function batchDeleteRegex() {
    if (regexSelectedIdxs.size === 0) return;
    if (!await UI.showConfirm('批量删除', `确定删除选中的 ${regexSelectedIdxs.size} 条规则？`)) return;
    let rules = await getRegexRules();
    rules = rules.filter((_, i) => !regexSelectedIdxs.has(i));
    regexSelectedIdxs.clear();
    await saveRegexRules(rules);
    renderRegexRules();
  }

  function addRegex() {
    editingRegexIdx = -1;
    document.getElementById('regex-edit-title').textContent = '添加正则规则';
    document.getElementById('regex-pattern').value = '';
    document.getElementById('regex-replacement').value = '';
    document.getElementById('regex-flags').value = 'g';
    document.getElementById('regex-note').value = '';
    document.getElementById('regex-edit-modal').classList.remove('hidden');
  }

  async function editRegex(idx) {
    const rules = await getRegexRules();
    const r = rules[idx];
    if (!r) return;
    editingRegexIdx = idx;
    document.getElementById('regex-edit-title').textContent = '编辑正则规则';
    document.getElementById('regex-pattern').value = r.pattern;
    document.getElementById('regex-replacement').value = r.replacement || '';
    document.getElementById('regex-flags').value = r.flags || 'g';
    document.getElementById('regex-note').value = r.note || '';
    document.getElementById('regex-edit-modal').classList.remove('hidden');
  }

  async function saveRegex() {
    const pattern = document.getElementById('regex-pattern').value.trim();
    if (!pattern) { await UI.showAlert('提示', '正则表达式不能为空'); return; }
    const flags = document.getElementById('regex-flags').value.trim() || 'g';
    try { new RegExp(pattern, flags); } catch(e) { await UI.showAlert('提示', '正则语法错误：' + e.message); return; }
    const rule = {
      pattern,
      replacement: document.getElementById('regex-replacement').value,
      flags,
      note: document.getElementById('regex-note').value.trim(),
      enabled: true
    };
    const rules = await getRegexRules();
    if (editingRegexIdx >= 0 && editingRegexIdx < rules.length) {
      rule.enabled = rules[editingRegexIdx].enabled !== false;
      rules[editingRegexIdx] = rule;
    } else {
      rules.push(rule);
    }
    await saveRegexRules(rules);
    closeRegexEdit();
    renderRegexRules();
  }

  async function closeRegexEdit() {
    const modal = document.getElementById('regex-edit-modal');
    modal.classList.add('closing');
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.add('closing');
    await new Promise(r => setTimeout(r, 150));
    modal.classList.remove('closing');
    if (content) content.classList.remove('closing');
    modal.classList.add('hidden');
    editingRegexIdx = -1;
  }

  async function toggleRegex(idx, checked) {
    const rules = await getRegexRules();
    if (rules[idx]) {
      rules[idx].enabled = checked;
      await saveRegexRules(rules);
    }
  }

  async function removeRegex(idx) {
    if (!await UI.showConfirm('确认删除', '确定删除这条规则？')) return;
    const rules = await getRegexRules();
    rules.splice(idx, 1);
    await saveRegexRules(rules);
    renderRegexRules();
  }

  // ===== 功能模型管理 =====

  // 通用渲染函数
  function renderFuncPresetList(type) {
    const containerId = `func-${type}-list`;
    const container = document.getElementById(containerId);
    if (!container) return;

    let list, currentId;
    if (type === 'summary') { list = summaryPresets; currentId = currentSummaryId; }
    else if (type === 'memory') { list = memoryPresets; currentId = currentMemoryId; }
    else if (type === 'vision') { list = visionPresets; currentId = currentVisionId; }
    else if (type === 'gaiden') { list = gaidenPresets; currentId = currentGaidenId; }
    else if (type === 'worldvoice') { list = worldvoicePresets; currentId = currentWorldvoiceId; }
    else if (type === 'backstage') { list = backstagePresets; currentId = currentBackstageId; }
    else if (type === 'tts') { list = ttsPresets; currentId = currentTtsId; }
    else if (type === 'draw') { list = drawPresets; currentId = currentDrawId; }
    else return;

    const switchFnName = 'switch' + type.charAt(0).toUpperCase() + type.slice(1);
    const isManage = funcManageMode[type];
    const selected = funcSelectedIds[type];

    let html = '';
    for (const p of list) {
      const isSelected = selected.has(p.id);
      html += `
        <div class="card" style="${p.id === currentId ? 'border-color:var(--accent)' : ''};display:flex;align-items:flex-start;gap:8px;padding:12px;background:var(--bg-tertiary);cursor:pointer;" onclick="${isManage ? `Settings.toggleFuncSelect('${type}','${p.id}')` : `Settings.${switchFnName}('${p.id}')`}">
          ${isManage ? `
          <span style="width:22px;height:22px;border-radius:50%;border:2px solid ${isSelected ? 'var(--accent)' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s ease;${isSelected ? 'background:var(--accent);' : ''}" onclick="event.stopPropagation();Settings.toggleFuncSelect('${type}','${p.id}')">
            ${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
          </span>` : `<input type="radio" name="func-${type}" ${p.id === currentId ? 'checked' : ''} onchange="Settings.${switchFnName}('${p.id}')" onclick="event.stopPropagation()" style="accent-color:var(--accent);margin-top:2px">`}
          <div style="flex:1;min-width:0;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:2px">
              <h3 style="margin:0;font-size:14px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(p.name)}</h3>
              <span style="font-size:11px;color:var(--text-secondary);white-space:nowrap">${Utils.escapeHtml(p.model || '未设置')}</span>
            </div>
            <span style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(p.apiUrl || '未设置端点')}</span>
          </div>
          ${!isManage ? `<button onclick="event.stopPropagation();Settings.editFuncPreset('${type}','${p.id}')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px;flex-shrink:0">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
          </button>` : ''}
        </div>
      `;
    }
    container.innerHTML = html;
  }

  function toggleFuncSelect(type, id) {
    const selected = funcSelectedIds[type];
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    renderFuncPresetList(type);
  }

  function toggleFuncManageMode(type) {
    funcManageMode[type] = !funcManageMode[type];
    funcSelectedIds[type].clear();
    const bar = document.getElementById(`func-${type}-manage-bar`);
    const btn = document.getElementById(`func-${type}-manage-btn`);
    if (funcManageMode[type]) {
      if (bar) { bar.classList.remove('hidden'); bar.style.display = 'flex'; }
      if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg> 退出'; btn.style.background = 'var(--accent)'; btn.style.color = '#111'; btn.style.borderColor = 'var(--accent)'; }
    } else {
      if (bar) { bar.classList.add('hidden'); bar.style.display = ''; }
      if (btn) { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 管理'; btn.style.background = 'none'; btn.style.color = 'var(--text-secondary)'; btn.style.borderColor = 'var(--border)'; }
    }
    renderFuncPresetList(type);
  }

  async function batchDeleteFunc(type) {
    let list, currentId, switchFn;
    if (type === 'summary') { list = summaryPresets; currentId = currentSummaryId; switchFn = (x) => currentSummaryId = x; }
    else if (type === 'memory') { list = memoryPresets; currentId = currentMemoryId; switchFn = (x) => currentMemoryId = x; }
    else if (type === 'vision') { list = visionPresets; currentId = currentVisionId; switchFn = (x) => currentVisionId = x; }
    else if (type === 'gaiden') { list = gaidenPresets; currentId = currentGaidenId; switchFn = (x) => currentGaidenId = x; }
    else if (type === 'worldvoice') { list = worldvoicePresets; currentId = currentWorldvoiceId; switchFn = (x) => currentWorldvoiceId = x; }
    else if (type === 'backstage') { list = backstagePresets; currentId = currentBackstageId; switchFn = (x) => currentBackstageId = x; }
    else if (type === 'tts') { list = ttsPresets; currentId = currentTtsId; switchFn = (x) => currentTtsId = x; }
    else if (type === 'draw') { list = drawPresets; currentId = currentDrawId; switchFn = (x) => currentDrawId = x; }
    else return;
    const selected = funcSelectedIds[type];
    if (selected.size === 0) return;
    const deleteAll = selected.size >= list.length;
    const msg = deleteAll
      ? `确定删除全部 ${selected.size} 个预设？删除后将使用主模型。`
      : `确定删除选中的 ${selected.size} 个预设？`;
    if (!await UI.showConfirm('批量删除', msg)) return;
    const toDelete = new Set(selected);
    if (type === 'summary') summaryPresets = list.filter(p => !toDelete.has(p.id));
    else if (type === 'memory') memoryPresets = list.filter(p => !toDelete.has(p.id));
    else if (type === 'vision') visionPresets = list.filter(p => !toDelete.has(p.id));
    else if (type === 'gaiden') gaidenPresets = list.filter(p => !toDelete.has(p.id));
    else if (type === 'worldvoice') worldvoicePresets = list.filter(p => !toDelete.has(p.id));
    else if (type === 'backstage') backstagePresets = list.filter(p => !toDelete.has(p.id));
    else if (type === 'tts') ttsPresets = list.filter(p => !toDelete.has(p.id));
    else if (type === 'draw') drawPresets = list.filter(p => !toDelete.has(p.id));
    const newList = type === 'summary' ? summaryPresets : type === 'memory' ? memoryPresets : type === 'vision' ? visionPresets : type === 'gaiden' ? gaidenPresets : type === 'worldvoice' ? worldvoicePresets : type === 'tts' ? ttsPresets : type === 'draw' ? drawPresets : backstagePresets;
    // 删光后自动补回默认预设
    if (newList.length === 0) {
      const defaultPreset = { id: 'default', name: '默认', apiUrl: '', apiKey: '', model: '' };
      newList.push(defaultPreset);
    }
    if (toDelete.has(currentId)) switchFn(newList[0].id);
    selected.clear();
    await savePresets();
    renderFuncPresetList(type);
  }

  async function batchCloneFunc(type) {
    let list;
    if (type === 'summary') list = summaryPresets;
    else if (type === 'memory') list = memoryPresets;
    else if (type === 'vision') list = visionPresets;
    else if (type === 'gaiden') list = gaidenPresets;
    else if (type === 'worldvoice') list = worldvoicePresets;
    else if (type === 'backstage') list = backstagePresets;
    else if (type === 'tts') list = ttsPresets;
    else if (type === 'draw') list = drawPresets;
    else return;
    const selected = funcSelectedIds[type];
    if (selected.size === 0) return;
    for (const id of selected) {
      const src = list.find(p => p.id === id);
      if (!src) continue;
      list.push({ ...src, id: 'func_' + type + '_' + Utils.uuid().slice(0, 8), name: src.name + ' (副本)' });
    }
    selected.clear();
    await savePresets();
    renderFuncPresetList(type);
  }

  function switchSummary(id) {
    if (!summaryPresets.find(p => p.id === id)) return;
    currentSummaryId = id;
    savePresets();
    renderFuncPresetList('summary');
  }
  function switchMemory(id) {
    if (!memoryPresets.find(p => p.id === id)) return;
    currentMemoryId = id;
    savePresets();
    renderFuncPresetList('memory');
  }
  function switchVision(id) {
    if (!visionPresets.find(p => p.id === id)) return;
    currentVisionId = id;
    savePresets();
    renderFuncPresetList('vision');
  }
  function switchGaiden(id) {
    if (!gaidenPresets.find(p => p.id === id)) return;
    currentGaidenId = id;
    savePresets();
    renderFuncPresetList('gaiden');
  }
  function switchWorldvoice(id) {
    if (!worldvoicePresets.find(p => p.id === id)) return;
    currentWorldvoiceId = id;
    savePresets();
    renderFuncPresetList('worldvoice');
  }
  function switchBackstage(id) {
    if (!backstagePresets.find(p => p.id === id)) return;
    currentBackstageId = id;
    savePresets();
    renderFuncPresetList('backstage');
  }
  function switchTts(id) {
    if (!ttsPresets.find(p => p.id === id)) return;
    currentTtsId = id;
    savePresets();
    renderFuncPresetList('tts');
  }
  function switchDraw(id) {
    if (!drawPresets.find(p => p.id === id)) return;
    currentDrawId = id;
    savePresets();
    renderFuncPresetList('draw');
  }

  // ===== 从主模型预设填充功能模型 =====
  function fillFromMainPreset(type, presetId) {
    const mainPreset = presets.find(p => p.id === presetId);
    if (!mainPreset) return;
    const urlEl = document.getElementById(`func-${type}-url`);
    const keyEl = document.getElementById(`func-${type}-key`);
    const modelEl = document.getElementById(`func-${type}-model`);
    const labelEl = document.getElementById(`func-${type}-model-label`);
    if (urlEl) urlEl.value = mainPreset.apiUrl || '';
    if (keyEl) keyEl.value = mainPreset.apiKey || '';
    if (modelEl) modelEl.value = mainPreset.model || '';
    if (labelEl) labelEl.textContent = mainPreset.model || '手动输入';
    // 收起选择器
    const selector = document.getElementById(`func-${type}-fill-dropdown`);
    if (selector) selector.classList.add('hidden');
    UI.showToast(`已填入「${mainPreset.name}」的配置`, 2000);
  }

  function toggleFillDropdown(type) {
    const dropdown = document.getElementById(`func-${type}-fill-dropdown`);
    if (!dropdown) return;
    if (dropdown.classList.contains('hidden')) {
      // 渲染主模型列表
      dropdown.innerHTML = presets.map(p =>
        `<div class="custom-dropdown-item" onclick="Settings.fillFromMainPreset('${type}','${p.id}')" style="padding:8px 12px;cursor:pointer;font-size:13px">${Utils.escapeHtml(p.name)} <span style="color:var(--text-secondary);font-size:11px">${Utils.escapeHtml(p.model || '未配置')}</span></div>`
      ).join('') || '<div style="padding:8px 12px;color:var(--text-secondary);font-size:12px">暂无主模型预设</div>';
      dropdown.classList.remove('hidden');
    } else {
      dropdown.classList.add('hidden');
    }
  }

  function editFuncPreset(type, id) {
    let list, editingIdVar, modalId;
    if (type === 'summary') { list = summaryPresets; editingIdVar = 'editingSummaryId'; modalId = 'func-summary-modal'; }
    else if (type === 'memory') { list = memoryPresets; editingIdVar = 'editingMemoryId'; modalId = 'func-memory-modal'; }
    else if (type === 'vision') { list = visionPresets; editingIdVar = 'editingVisionId'; modalId = 'func-vision-modal'; }
    else if (type === 'gaiden') { list = gaidenPresets; editingIdVar = 'editingGaidenId'; modalId = 'func-gaiden-modal'; }
    else if (type === 'worldvoice') { list = worldvoicePresets; editingIdVar = 'editingWorldvoiceId'; modalId = 'func-worldvoice-modal'; }
    else if (type === 'backstage') { list = backstagePresets; editingIdVar = 'editingBackstageId'; modalId = 'func-backstage-modal'; }
    else if (type === 'tts') { list = ttsPresets; editingIdVar = 'editingTtsId'; modalId = 'func-tts-modal'; }
    else if (type === 'draw') { list = drawPresets; editingIdVar = 'editingDrawId'; modalId = 'func-draw-modal'; }
    else return;

    const preset = list.find(p => p.id === id);
    if (!preset) return;
    if (editingIdVar === 'editingSummaryId') editingSummaryId = id;
    else if (editingIdVar === 'editingMemoryId') editingMemoryId = id;
    else if (editingIdVar === 'editingVisionId') editingVisionId = id;
    else if (editingIdVar === 'editingGaidenId') editingGaidenId = id;
    else if (editingIdVar === 'editingWorldvoiceId') editingWorldvoiceId = id;
    else if (editingIdVar === 'editingBackstageId') editingBackstageId = id;
    else if (editingIdVar === 'editingTtsId') editingTtsId = id;

    document.getElementById(`func-${type}-name`).value = preset.name || '';
    document.getElementById(`func-${type}-url`).value = preset.apiUrl || '';
    document.getElementById(`func-${type}-key`).value = preset.apiKey || '';
    document.getElementById(`func-${type}-model`).value = preset.model || '';
    const modelLabel = document.getElementById(`func-${type}-model-label`);
    if (modelLabel) modelLabel.textContent = preset.model || '手动输入';
    const modelDropdown = document.getElementById(`func-${type}-model-dropdown`);
    if (modelDropdown) { modelDropdown.innerHTML = ''; modelDropdown.classList.add('hidden'); }
    if (type === 'tts') {
      const groupEl = document.getElementById('func-tts-groupid');
      if (groupEl) groupEl.value = preset.groupId || '';
    }

    document.getElementById(modalId).classList.remove('hidden');
  }

  async function saveFuncPreset(type) {
    let list, editingIdVar, modalId;
    if (type === 'summary') { list = summaryPresets; editingIdVar = 'editingSummaryId'; modalId = 'func-summary-modal'; }
    else if (type === 'memory') { list = memoryPresets; editingIdVar = 'editingMemoryId'; modalId = 'func-memory-modal'; }
    else if (type === 'vision') { list = visionPresets; editingIdVar = 'editingVisionId'; modalId = 'func-vision-modal'; }
    else if (type === 'gaiden') { list = gaidenPresets; editingIdVar = 'editingGaidenId'; modalId = 'func-gaiden-modal'; }
    else if (type === 'worldvoice') { list = worldvoicePresets; editingIdVar = 'editingWorldvoiceId'; modalId = 'func-worldvoice-modal'; }
    else if (type === 'backstage') { list = backstagePresets; editingIdVar = 'editingBackstageId'; modalId = 'func-backstage-modal'; }
    else if (type === 'tts') { list = ttsPresets; editingIdVar = 'editingTtsId'; modalId = 'func-tts-modal'; }
    else if (type === 'draw') { list = drawPresets; editingIdVar = 'editingDrawId'; modalId = 'func-draw-modal'; }
    else return;

    const editingId = type === 'summary' ? editingSummaryId : type === 'memory' ? editingMemoryId : type === 'vision' ? editingVisionId : type === 'gaiden' ? editingGaidenId : type === 'worldvoice' ? editingWorldvoiceId : type === 'tts' ? editingTtsId : type === 'draw' ? editingDrawId : editingBackstageId;
    if (!editingId) return;

    const preset = list.find(p => p.id === editingId);
    if (!preset) return;

    preset.name = document.getElementById(`func-${type}-name`).value.trim();
    preset.apiUrl = document.getElementById(`func-${type}-url`).value.trim();
    preset.apiKey = document.getElementById(`func-${type}-key`).value.trim();
    const modelSelectEl = document.getElementById(`func-${type}-model-select`);
    const modelSelect = modelSelectEl ? modelSelectEl.value : '';
    preset.model = modelSelect || document.getElementById(`func-${type}-model`).value.trim();
    if (type === 'tts') {
      const groupEl = document.getElementById('func-tts-groupid');
      preset.groupId = groupEl ? groupEl.value.trim() : (preset.groupId || '');
    }

    await savePresets();
    document.getElementById(modalId).classList.add('hidden');

    if (type === 'summary') editingSummaryId = null;
    else if (type === 'memory') editingMemoryId = null;
    else if (type === 'vision') editingVisionId = null;
    else if (type === 'gaiden') editingGaidenId = null;
    else if (type === 'worldvoice') editingWorldvoiceId = null;
    else if (type === 'backstage') editingBackstageId = null;
    else if (type === 'tts') editingTtsId = null;
    else if (type === 'draw') editingDrawId = null;

    renderFuncPresetList(type);
  }

  function cancelFuncEdit(type) {
    if (type === 'summary') editingSummaryId = null;
    else if (type === 'memory') editingMemoryId = null;
    else if (type === 'vision') editingVisionId = null;
    else if (type === 'gaiden') editingGaidenId = null;
    else if (type === 'worldvoice') editingWorldvoiceId = null;
    else if (type === 'backstage') editingBackstageId = null;
    else if (type === 'tts') editingTtsId = null;
    else if (type === 'draw') editingDrawId = null;

    const modalId = `func-${type}-modal`;
    document.getElementById(modalId).classList.add('hidden');
  }

  async function createFuncPreset(type) {
    let list, modalId, titlePrefix;
    if (type === 'summary') {
      list = summaryPresets;
      modalId = 'func-summary-modal';
      titlePrefix = '总结';
    }
    else if (type === 'memory') {
      list = memoryPresets;
      modalId = 'func-memory-modal';
      titlePrefix = '记忆提取';
    }
    else if (type === 'vision') {
      list = visionPresets;
      modalId = 'func-vision-modal';
      titlePrefix = '识图';
    }
    else if (type === 'gaiden') {
      list = gaidenPresets;
      modalId = 'func-gaiden-modal';
      titlePrefix = '番外';
    }
    else if (type === 'worldvoice') {
      list = worldvoicePresets;
      modalId = 'func-worldvoice-modal';
      titlePrefix = '手机';
    }
    else if (type === 'backstage') {
      list = backstagePresets;
      modalId = 'func-backstage-modal';
      titlePrefix = '后台';
    }
    else if (type === 'tts') {
      list = ttsPresets;
      modalId = 'func-tts-modal';
      titlePrefix = '语音';
    }
    else if (type === 'draw') {
      list = drawPresets;
      modalId = 'func-draw-modal';
      titlePrefix = '生图';
    }
    else return;

    const id = 'func_' + type + '_' + Utils.uuid().slice(0, 8);
    const np = type === 'tts'
      ? { id, name: `${titlePrefix} ${list.length + 1}`, apiUrl: 'https://api.minimaxi.com/v1/t2a_v2', apiKey: '', model: 'speech-2.8-hd', groupId: '' }
      : { id, name: `${titlePrefix} ${list.length + 1}`, apiUrl: '', apiKey: '', model: '' };
    list.push(np);

    if (type === 'summary') editingSummaryId = id;
    else if (type === 'memory') editingMemoryId = id;
    else if (type === 'vision') editingVisionId = id;
    else if (type === 'gaiden') editingGaidenId = id;
    else if (type === 'worldvoice') editingWorldvoiceId = id;
    else if (type === 'backstage') editingBackstageId = id;
    else if (type === 'tts') editingTtsId = id;
    else if (type === 'draw') editingDrawId = id;

    await savePresets();
    renderFuncPresetList(type);
    editFuncPreset(type, id);
  }

  async function cloneFuncPreset(type, id) {
    let list, currentId;
    if (type === 'summary') { list = summaryPresets; currentId = currentSummaryId; }
    else if (type === 'memory') { list = memoryPresets; currentId = currentMemoryId; }
    else if (type === 'vision') { list = visionPresets; currentId = currentVisionId; }
    else if (type === 'gaiden') { list = gaidenPresets; currentId = currentGaidenId; }
    else if (type === 'worldvoice') { list = worldvoicePresets; currentId = currentWorldvoiceId; }
    else if (type === 'backstage') { list = backstagePresets; currentId = currentBackstageId; }
    else if (type === 'tts') { list = ttsPresets; currentId = currentTtsId; }
    else if (type === 'draw') { list = drawPresets; currentId = currentDrawId; }
    else return;

    const src = list.find(p => p.id === id);
    if (!src) return;

    const np = { ...src, id: 'func_' + type + '_' + Utils.uuid().slice(0, 8), name: src.name + ' (副本)' };
    list.push(np);
    await savePresets();
    renderFuncPresetList(type);
  }

  async function deleteFuncPreset(type, id) {
    let list, currentId, switchFn;
    if (type === 'summary') { list = summaryPresets; currentId = currentSummaryId; switchFn = (x) => currentSummaryId = x; }
    else if (type === 'memory') { list = memoryPresets; currentId = currentMemoryId; switchFn = (x) => currentMemoryId = x; }
    else if (type === 'vision') { list = visionPresets; currentId = currentVisionId; switchFn = (x) => currentVisionId = x; }
    else if (type === 'gaiden') { list = gaidenPresets; currentId = currentGaidenId; switchFn = (x) => currentGaidenId = x; }
    else if (type === 'worldvoice') { list = worldvoicePresets; currentId = currentWorldvoiceId; switchFn = (x) => currentWorldvoiceId = x; }
    else if (type === 'backstage') { list = backstagePresets; currentId = currentBackstageId; switchFn = (x) => currentBackstageId = x; }
    else if (type === 'tts') { list = ttsPresets; currentId = currentTtsId; switchFn = (x) => currentTtsId = x; }
    else return;

    if (list.length <= 1) {
      if (!await UI.showConfirm('确认删除', '删除后将使用主模型，确定？')) return;
    } else {
      if (!await UI.showConfirm('确认删除', '确定删除？')) return;
    }
    const idx = list.findIndex(p => p.id === id);
    if (idx >= 0) list.splice(idx, 1);
    // 删光后自动补回默认预设
    if (list.length === 0) {
      list.push({ id: 'default', name: '默认', apiUrl: '', apiKey: '', model: '' });
    }
    if (id === currentId) switchFn(list[0].id);
    await savePresets();
    renderFuncPresetList(type);
  }

  async function fetchFuncModels(type) {
    const url = document.getElementById(`func-${type}-url`).value.trim();
    const key = document.getElementById(`func-${type}-key`).value.trim();
    if (!url || !key) { await UI.showAlert('提示', '请先填写端点和Key'); return; }
    const prefix = `func-${type}`;
    const label = document.getElementById(`${prefix}-model-label`);
    const dropdown = document.getElementById(`${prefix}-model-dropdown`);
    label.textContent = '加载中...';
    dropdown.innerHTML = '';
    try {
      const resp = await fetch(url + '/models', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + key }
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const models = (data.data || []).map(m => m.id);
      if (models.length === 0) {
        label.textContent = '无可用模型';
        return;
      }
      _fillModelDropdown(prefix, models);
    } catch(e) {
      console.error('[fetchFuncModels]', e);
      label.textContent = '获取失败';
      dropdown.innerHTML = '';
      await UI.showAlert('提示', '获取模型列表失败: ' + e.message);
    }
  }

  // ===== 自定义模型下拉框通用逻辑 =====
  function _fillModelDropdown(prefix, models) {
    const dropdown = document.getElementById(`${prefix}-model-dropdown`);
    const label = document.getElementById(`${prefix}-model-label`);
    label.textContent = '手动输入';
    dropdown.innerHTML = '<div class="custom-dropdown-item" onclick="Settings.selectModel(\'' + prefix + '\',\'\')">手动输入</div>' +
      models.map(m => `<div class="custom-dropdown-item" onclick="Settings.selectModel('${prefix}','${Utils.escapeHtml(m)}')">${Utils.escapeHtml(m)}</div>`).join('');
  }

  function toggleModelDropdown(prefix) {
    const dropdown = document.getElementById(`${prefix}-model-dropdown`);
    if (!dropdown) return;
    if (dropdown.classList.contains('hidden')) {
      // 关闭其他所有模型下拉框
      document.querySelectorAll('.custom-dropdown').forEach(d => {
        if (d.id && d.id.endsWith('-model-dropdown') && d !== dropdown) d.classList.add('hidden');
      });
      // 用 fixed 定位脱离 overflow 容器
      const btn = dropdown.previousElementSibling;
      if (btn) {
        const rect = btn.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = rect.left + 'px';
        dropdown.style.top = (rect.bottom + 4) + 'px';
        dropdown.style.width = rect.width + 'px';
        dropdown.style.zIndex = '9999';
      }
      dropdown.classList.remove('hidden');
      // 点外面关闭
      setTimeout(() => {
        document.addEventListener('click', function _close(e) {
          if (!dropdown.contains(e.target) && !dropdown.previousElementSibling?.contains(e.target)) {
            dropdown.classList.add('hidden');
            document.removeEventListener('click', _close);
          }
        });
      }, 0);
    } else {
      dropdown.classList.add('closing');
      setTimeout(() => { dropdown.classList.remove('closing'); dropdown.classList.add('hidden'); }, 120);
    }
  }

  function selectModel(prefix, value) {
    const label = document.getElementById(`${prefix}-model-label`);
    const dropdown = document.getElementById(`${prefix}-model-dropdown`);
    const inputId = prefix === 'sp' ? 'sp-model' : `${prefix}-model`;
    const input = document.getElementById(inputId);
    if (label) label.textContent = value || '手动输入';
    if (input && value) input.value = value;
    if (dropdown) {
      dropdown.classList.add('closing');
      setTimeout(() => { dropdown.classList.remove('closing'); dropdown.classList.add('hidden'); }, 120);
    }
  }

  return {
    init, load, getCurrent, getCurrentId, switchPreset,
    editPreset, savePreset, cancelEdit, createPreset, clonePreset, deletePreset, previewPresetEndpoint,
    fetchModels, toggleKeyVisibility, copyKey, _getPresets,
    toggleModelDropdown, selectModel,
    renderPresetList, renderQuickSwitch,
    togglePresetSelect, togglePresetManageMode, exitPresetManageMode, batchDeletePresets, batchClonePresets,
    getRegexRules, addRegex, editRegex, saveRegex, closeRegexEdit,
    toggleRegex, removeRegex, renderRegexRules,
    toggleRegexSelect, toggleRegexManageMode, exitRegexManageMode, batchDeleteRegex,
    getSummaryConfig, getMemoryConfig, getVisionConfig, getGaidenConfig, getWorldvoiceConfig, getBackstageConfig, getTtsConfig, getDrawConfig,
    renderFuncPresetList, switchSummary, switchMemory, switchVision, switchGaiden, switchWorldvoice, switchBackstage, switchTts, switchDraw,
    editFuncPreset, saveFuncPreset, cancelFuncEdit, createFuncPreset,
    cloneFuncPreset, deleteFuncPreset, fetchFuncModels, fillFromMainPreset, toggleFillDropdown,
    toggleFuncSelect, toggleFuncManageMode, batchDeleteFunc, batchCloneFunc
  };
})();