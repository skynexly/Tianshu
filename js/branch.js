/**
 * 分支管理UI
 * 分支现在是独立对话，通过对话列表管理。
 * 本面板仅保留入口提示。
 */
const Branch = (() => {
  function renderTree() {
    const container = document.getElementById('branch-tree');
    if (!container) return;
    container.innerHTML = `
      <div style="padding:16px;color:var(--text-secondary);font-size:14px;line-height:1.7">
        <p>分支现在是独立对话窗口。</p>
        <p>在消息上长按 → <b>创建分支</b>，会自动复制当前对话、面具与记忆库，并切换到新对话。</p>
        <p>切换/重命名/删除分支，请到<b>对话列表</b>管理。</p>
        <div style="margin-top:12px">
          <button onclick="UI.showPanel('conversations')" style="padding:8px 16px;background:var(--accent);color:#111;border:none;border-radius:8px;cursor:pointer;font-size:13px">前往对话列表</button>
        </div>
      </div>
    `;
  }

  return { renderTree };
})();