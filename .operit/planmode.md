## 对话级 gameplay 覆盖（属性/任务/事件配置可对话内修改）

### 核心机制

**存储方式：整体复制（convGameplay）**

- 对话对象 `conv` 上新增字段 `convGameplay`（初始为 `null`/不存在）
- 当用户首次在对话里编辑任何 gameplay 配置时，从当前绑定的世界观完整深拷贝 `wv.gameplay` → `conv.convGameplay`
- 之后所有读取 gameplay 配置的地方优先读 `conv.convGameplay`，如果没有再 fallback 到 `wv.gameplay`
- 世界观原件不受影响，对话之间互相隔离

**读取优先级（需要改动的地方）：**

| 模块 | 原来读 | 改后读 |
|---|---|---|
| `StatusBar._getTaskConfig()` | `wv.gameplay.taskSystem` | `conv.convGameplay?.taskSystem ?? wv.gameplay.taskSystem` |
| `StatusBar._renderGlobalAttrs()` | `wv.gameplay.globalAttrs` | `conv.convGameplay?.globalAttrs ?? wv.gameplay.globalAttrs` |
| `StatusBar._renderCharacterAttrs()` | `wv.gameplay.characterAttrs` | `conv.convGameplay?.characterAttrs ?? wv.gameplay.characterAttrs` |
| `StatusBar._getCustomAttrPromptData()` | `wv.gameplay.globalAttrs` / `characterAttrs` | 同上 |
| `StatusBar.formatCustomAttrsFormatPrompt()` | 同上 | 同上 |
| `StatusBar.applyCustomAttrsDelta()` | `wv.gameplay.globalAttrs` / `characterAttrs` | 同上 |
| `chat.js` 事件触发条件 | `wv.gameplay.characterAttrs` | 同上 |
| `chat.js` 事件列表 | `currentWv.events` | `conv.convEvents ?? currentWv.events`（事件也做对话级） |
| `StatusBar.taskFormatForPrompt()` | `wv.gameplay.taskSystem` | 同上 |

**核心辅助函数（status_bar.js）：**
```js
async function _getConvGameplay() {
  const conv = Conversations.getList().find(c => c.id === Conversations.getCurrent());
  if (conv?.convGameplay) return conv.convGameplay;
  const wv = await _getCurrentWorldview();
  return wv?.gameplay || null;
}
```

---

### 编辑入口

在对话设置的"功能" tab 里，现有的"管理事件"按钮和"重置任务"按钮旁边/下方，增加：

1. **"编辑属性配置"按钮** — 打开属性编辑弹窗（全局属性 + 角色属性的完整编辑面板，和世界观里的体验一致）
2. **"编辑任务配置"按钮** — 打开任务阶段编辑弹窗（阶段列表 + 任务类型 + 奖励配置）
3. **"编辑事件列表"按钮** — 打开事件编辑弹窗（事件增删改，对话级副本）

首次点击任意编辑按钮时：
- 如果 `conv.convGameplay` 不存在，弹确认："将从世界观复制一份配置到当前对话，之后修改只影响本对话。继续？"
- 用户确认后深拷贝 `wv.gameplay` → `conv.convGameplay`（事件单独：`wv.events` → `conv.convEvents`）
- 然后打开编辑面板

**编辑面板实现方式：**
- 复用世界观里已有的渲染/保存逻辑（`_renderAttrRows`、`_renderTaskSystem` 等），但保存目标从 `DB.put('worldviews', w)` 变为写 `conv.convGameplay` 然后 `Conversations.saveList()`
- 可以在现有 worldview.js 函数基础上加一个 `target` 参数区分写入目标，或者对话级编辑单独实现一套简化版

---

### 任务进度冲突处理

- 保存任务配置前检查 `conv.statusBar.taskSystem.active` 是否有活跃任务
- 如果有，弹窗提示："当前有进行中的任务，修改配置可能导致冲突。建议先重置任务进度。"
- 提供"重置并保存"和"仅保存（保留现有进度）"两个选项
- 不强制重置，选择权交给用户

---

### 事件对话级覆盖

- `conv` 新增字段 `convEvents`（数组，初始不存在）
- 读取事件列表时：`conv.convEvents ?? currentWv.events`
- 编辑事件弹窗里可以增删改事件条目（和世界观事件编辑一样的体验）
- 事件状态 `conv.eventStates` 保持不变（本来就是对话级的）

---

### 文件改动清单

| 文件 | 改动 |
|---|---|
| **status_bar.js** | 新增 `_getConvGameplay()` 辅助函数；所有读 `wv.gameplay` 的地方改为优先读 `convGameplay` |
| **chat.js** | 事件列表读取加 `conv.convEvents` 优先级；对话设置功能 tab 加编辑按钮的 onclick |
| **index.html** | 对话设置功能 tab 加"编辑属性配置"/"编辑任务配置"/"编辑事件列表"三个按钮；对应的编辑弹窗 HTML |
| **worldview.js 或 新文件** | 对话级 gameplay 编辑面板的渲染和保存逻辑（复用或简化世界观已有代码） |

---

### 注意事项

- 深拷贝用 `JSON.parse(JSON.stringify(...))`
- `convGameplay` 和 `convEvents` 存在 conv 对象上，会随 `Conversations.saveList()` 持久化
- 对话设置里加一个"恢复世界观默认"按钮（删除 `convGameplay` / `convEvents`，回退到读世界观原件）
- 世界观编辑页不受影响，继续写 `wv.gameplay`
