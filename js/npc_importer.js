/**
 * NPC 批量导入器（v682 / v683）
 *
 * 三个入口：
 *   - 世界观「常驻 NPC」顶部       → openImporter({ target: 'global' })
 *   - 世界观「势力角色」顶部       → openImporter({ target: 'faction' })   ※ 复用当前 _editRegionIdx / _editFactionIdx
 *   - 世界书全图 NPC 顶部          → openImporter({ target: 'global' })   ※ 编辑器复用世界观界面，所以 target 同 global 即可
 *
 * 设计原则（沈楚定）：
 *   - 全部追加，不去重、不报警（撞名只淡灰提示，不打断）
 *   - 模糊字段识别（中英文常见写法都吃）
 *   - 未知字段全部塞 notes 兜底，不丢
 *   - 必须字段只有 name，没有 name 的条目跳过
 *
 * 支持文件格式：
 *   - 单 NPC 对象          { name: '张三', ... }
 *   - NPC 数组             [ {...}, {...} ]
 *   - 元信息包             { npcs: [...] } / { characters: [...] } / { npcList: [...] }
 *   - 多文件同时选择       一次性合并解析
 */
const NpcImporter = (() => {

  // ========== 字段别名表（按优先级，第一个命中即采用）==========
  const FIELD_ALIASES = {
    name:       ['name', '姓名', '名字', 'title', '角色名', 'charName', 'char_name', 'npcName'],
    aliases:    ['aliases', 'alias', '别名', '昵称', '外号', 'nicknames', 'altname'],
    profession: ['profession', '职业', '身份', '头衔', 'position', 'role', 'occupation', 'job'],
    summary:    ['summary', '简介', '概要', 'brief', 'short', 'shortDesc', 'short_desc'],
    detail:     ['detail', 'description', '设定', '描述', '性格', 'bio', 'profile', 'personality', 'character', 'longDesc', 'long_desc', 'content'],
  };

  // 标准字段所有可能别名的扁平 set —— 用于识别"未知字段"
  const _KNOWN_KEYS = (() => {
    const s = new Set();
    Object.values(FIELD_ALIASES).forEach(arr => arr.forEach(k => s.add(k.toLowerCase())));
    // 元信息包字段也不算 NPC 自带的，避免把它塞进 notes
    ['npcs', 'characters', 'npclist', 'character_list', 'list', 'items', 'data'].forEach(k => s.add(k));
    // 这些是导入时常见但跟内容无关的，也排除
    ['id', 'avatar', 'image', 'icon', 'tags'].forEach(k => s.add(k));
    return s;
  })();

  // ========== 文件读取 ==========
  function _readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsText(file, 'utf-8');
    });
  }

  // ========== JSON 解析 → NPC 数组 ==========
  // 返回 [{ raw, sourceFile }, ...]
  function _extractNpcArray(parsed, fileName) {
    const out = [];
    const push = (obj) => {
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        out.push({ raw: obj, sourceFile: fileName });
      }
    };

    if (Array.isArray(parsed)) {
      parsed.forEach(push);
      return out;
    }
    if (parsed && typeof parsed === 'object') {
      // 元信息包：找数组字段
      const containerKeys = ['npcs', 'characters', 'npcList', 'character_list', 'list', 'items', 'data'];
      for (const k of containerKeys) {
        if (Array.isArray(parsed[k])) {
          parsed[k].forEach(push);
          if (out.length > 0) return out;
        }
      }
      // 单对象（且看起来像 NPC：含 name 类字段）
      const looksLikeNpc = FIELD_ALIASES.name.some(k => parsed[k] !== undefined);
      if (looksLikeNpc) push(parsed);
    }
    return out;
  }

  // ========== 字段映射：raw → 标准 npc ==========
  function _normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const pick = (aliases) => {
      for (const k of aliases) {
        if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') {
          return raw[k];
        }
      }
      return '';
    };

    const name = String(pick(FIELD_ALIASES.name) || '').trim();
    if (!name) return null;  // 没名字 → 弃

    // 别名字段：数组也接受，join 一下
    let aliases = pick(FIELD_ALIASES.aliases);
    if (Array.isArray(aliases)) aliases = aliases.join('、');
    aliases = String(aliases || '').trim();

    const profession = String(pick(FIELD_ALIASES.profession) || '').trim();
    const summary = String(pick(FIELD_ALIASES.summary) || '').trim();
    let detail = String(pick(FIELD_ALIASES.detail) || '').trim();

    // 收集未知字段 → notes 兜底
    const notes = {};
    for (const k of Object.keys(raw)) {
      if (_KNOWN_KEYS.has(k.toLowerCase())) continue;
      const v = raw[k];
      if (v === null || v === undefined || v === '') continue;
      notes[k] = v;
    }
    if (Object.keys(notes).length > 0) {
      const extra = Object.entries(notes)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join('\n');
      detail = detail ? (detail + '\n\n--- 附加字段 ---\n' + extra) : extra;
    }

    return {
      id: 'npc_' + Utils.uuid().slice(0, 8),
      name,
      aliases,
      profession,
      summary,
      detail
    };
  }

  // ========== 主流程：选文件 → 解析 → 预览 → 入库 ==========
  // opts = { target: 'global' | 'faction', onDone }
  async function openImporter(opts = {}) {
    const target = opts.target || 'global';

    // 1. 创建隐藏 file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = async () => {
      try {
        const files = Array.from(input.files || []);
        if (files.length === 0) return;

        // 2. 读取 + 解析所有文件
        const allRaw = [];
        const errors = [];
        for (const f of files) {
          try {
            const text = await _readFileAsText(f);
            const parsed = JSON.parse(text);
            const npcs = _extractNpcArray(parsed, f.name);
            if (npcs.length === 0) {
              errors.push(`${f.name}：未识别出 NPC`);
            } else {
              allRaw.push(...npcs);
            }
          } catch (e) {
            errors.push(`${f.name}：${e.message || '解析失败'}`);
          }
        }

        if (allRaw.length === 0) {
          UI.showToast(errors.length > 0 ? errors[0] : '没有可导入的 NPC', 3000);
          return;
        }

        // 3. 标准化
        const normalized = [];
        const skipped = [];
        allRaw.forEach((item, idx) => {
          const npc = _normalize(item.raw);
          if (npc) {
            normalized.push({ npc, sourceFile: item.sourceFile });
          } else {
            skipped.push(`第 ${idx + 1} 条（${item.sourceFile}）：缺少姓名`);
          }
        });

        if (normalized.length === 0) {
          UI.showToast('全部 NPC 缺少姓名，无法导入', 3000);
          return;
        }

        // 4. 弹预览
        await _showPreviewModal(normalized, target, errors, skipped, opts.onDone);
      } finally {
        input.remove();
      }
    };

    input.click();
  }

  // ========== 预览弹窗 ==========
  async function _showPreviewModal(items, target, fileErrors, normalizeSkipped, onDone) {
    // 收集已有 NPC 名字用于撞名标记
    const existing = await _collectExistingNames(target);

    const modal = document.createElement('div');
    modal.id = 'npc-importer-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';

    const itemsHtml = items.map((it, i) => {
      const n = it.npc;
      const dup = existing.has(n.name);
      const dupBadge = dup ? `<span style="color:var(--text-secondary);font-size:11px;margin-left:6px">· 已有同名</span>` : '';
      const subtitle = [n.profession, n.summary].filter(Boolean).join(' · ') || '（无简介）';
      return `
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;cursor:pointer">
          <span style="position:relative;display:inline-flex;flex-shrink:0;margin-top:2px">
            <input type="checkbox" class="circle-check npc-imp-check" data-idx="${i}" checked>
            <span class="circle-check-ui"></span>
          </span>
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;color:var(--text);font-weight:bold">${Utils.escapeHtml(n.name)}${dupBadge}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(subtitle)}</div>
            <div style="font-size:10px;color:var(--text-secondary);margin-top:2px">来自 ${Utils.escapeHtml(it.sourceFile)}</div>
          </div>
        </label>`;
    }).join('');

    const warnHtml = (fileErrors.length + normalizeSkipped.length > 0) ? `
      <details style="margin-top:8px;font-size:12px;color:var(--text-secondary)">
        <summary style="cursor:pointer">⚠ 跳过 ${fileErrors.length + normalizeSkipped.length} 条（点击查看）</summary>
        <div style="margin-top:6px;line-height:1.6;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
          ${[...fileErrors, ...normalizeSkipped].map(e => Utils.escapeHtml(e)).join('<br>')}
        </div>
      </details>` : '';

    const targetLabel = target === 'faction' ? '当前势力' : '常驻 NPC';

    modal.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;width:100%;max-width:480px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div style="font-size:15px;font-weight:bold;color:var(--text)">批量导入 NPC</div>
          <button id="npc-imp-close" style="background:none;border:none;color:var(--text-secondary);font-size:20px;cursor:pointer;line-height:1">×</button>
        </div>
        <div style="padding:10px 16px;font-size:12px;color:var(--text-secondary);border-bottom:1px solid var(--border);background:var(--bg)">
          解析出 <span style="color:var(--accent);font-weight:bold">${items.length}</span> 个 NPC，将导入到「${targetLabel}」 · 撞名直接追加
        </div>
        <div id="npc-imp-list" style="flex:1;overflow-y:auto;padding:10px 16px;display:flex;flex-direction:column;gap:6px">
          ${itemsHtml}
          ${warnHtml}
        </div>
        <div style="padding:10px 16px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center">
          <button id="npc-imp-toggle-all" style="padding:6px 10px;background:none;border:1px solid var(--border);color:var(--text-secondary);border-radius:6px;cursor:pointer;font-size:12px">全选/反选</button>
          <div style="flex:1"></div>
          <button id="npc-imp-cancel" style="padding:8px 14px;background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;cursor:pointer;font-size:13px">取消</button>
          <button id="npc-imp-confirm" style="padding:8px 14px;background:var(--accent);border:none;color:#111;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold">导入选中</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('#npc-imp-close').onclick = close;
    modal.querySelector('#npc-imp-cancel').onclick = close;
    modal.querySelector('#npc-imp-toggle-all').onclick = () => {
      const boxes = modal.querySelectorAll('.npc-imp-check');
      const anyUnchecked = Array.from(boxes).some(b => !b.checked);
      boxes.forEach(b => { b.checked = anyUnchecked; });
    };
    modal.querySelector('#npc-imp-confirm').onclick = async () => {
      const checked = Array.from(modal.querySelectorAll('.npc-imp-check'))
        .filter(b => b.checked)
        .map(b => parseInt(b.dataset.idx, 10))
        .filter(i => !isNaN(i));
      if (checked.length === 0) {
        UI.showToast('请至少选中 1 个 NPC', 1800);
        return;
      }
      const selected = checked.map(i => items[i].npc);
      try {
        const n = await _commitImport(selected, target);
        UI.showToast(`已导入 ${n} 个 NPC`, 2200);
        close();
        if (typeof onDone === 'function') {
          try { await onDone(); } catch(_) {}
        }
      } catch (e) {
        console.error('[NpcImporter] commit failed', e);
        UI.showToast('导入失败：' + (e.message || ''), 3000);
      }
    };
  }

  // ========== 收集当前作用域已有 NPC 名字（用于撞名提示）==========
  async function _collectExistingNames(target) {
    const set = new Set();
    try {
      const wv = await Worldview._getEditingWVForImporter();
      if (!wv) return set;
      if (target === 'faction') {
        const reg = wv.regions?.[Worldview._editingRegionIdxForImporter()];
        const fac = reg?.factions?.[Worldview._editingFactionIdxForImporter()];
        (fac?.npcs || []).forEach(n => { if (n.name) set.add(n.name); });
      } else {
        (wv.globalNpcs || []).forEach(n => { if (n.name) set.add(n.name); });
      }
    } catch(_) {}
    return set;
  }

  // ========== 真正写入 ==========
  async function _commitImport(npcs, target) {
    // 由 Worldview 模块代为写入（它持有 editingWorldviewId / _editRegionIdx / _editFactionIdx）
    return await Worldview._bulkImportNpcs(npcs, target);
  }

  return {
    openImporter,
  };
})();
