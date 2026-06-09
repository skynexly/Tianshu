## 配送时间系统实现计划（更新版）

### 概述
下单后自动生成随机配送时长（饿了咪15-45分钟，桃宝2-5天），存下单时游戏时间原始字符串，每次打开手机/渲染订单时用 `Calendar.parseAbsoluteTime` 解析当前时间和下单时间算分钟差，判断是否到货。到货后注入系统提示词。用户可在世界观 phoneApps 配置中自定义配送时间范围。

### Step 1：时间差计算工具函数（phone.js）
- `_gameTimeToMinutes(timeStr)`：用 `Calendar.parseAbsoluteTime` 解析时间字符串为 {year,month,day,hour,minute} 对象，转成"从公元0年起的总分钟数"（按每月30天、每年360天简化，够用于差值计算）；解析失败 fallback 到 `_parsePhoneTimeScore` 拆解
- `_getDeliveryRemaining(order)`：计算一个订单的剩余分钟数 = `deliveryMinutes - (当前游戏总分钟 - 下单游戏总分钟)`，负数表示已送达
- `_formatDeliveryRemaining(minutes)`：格式化剩余时间为"约x天x小时"或"约x分钟"

### Step 2：配送时间配置（phone.js - `_shopMeta` / `DEFAULT_SHOP_CFG`）
- `DEFAULT_SHOP_CFG` 中新增默认配送配置：
  - takeout: `{ deliveryMin: 15, deliveryMax: 45, deliveryUnit: 'min' }`
  - shop: `{ deliveryMin: 2, deliveryMax: 5, deliveryUnit: 'day' }`
- 用户可通过世界观 phoneApps 的 takeout/shop 配置覆盖：
  - `deliveryMin`：最小配送时间（数字）
  - `deliveryMax`：最大配送时间（数字）
  - `deliveryUnit`：'min' 或 'day'
- `_getShopCfg(kind)` 合并时一并合并这三个字段
- 没填就用默认值

### Step 3：数据结构改造（phone.js - `_shopCreateOrder`）
- 下单时在 order 对象新增：
  - `deliveryMinutes`：随机配送时长（根据 cfg 的 min/max/unit 生成，unit='day' 时乘以1440转分钟）
  - `orderGameTime`：下单时状态栏原始时间字符串
  - `status`：'delivering'（初始）
- 如果下单时游戏时间为空（状态栏没时间），不生成配送信息，保持旧行为
- 下单时 toast 显示"预计xx后送达"
- 修改 `_log` 文案：去掉"配送时间由你在剧情中自然安排"，改为"预计{格式化时间}后送达"

### Step 4：订单列表 UI 改造（phone.js - 订单渲染处）
- 每张订单卡片显示配送状态：
  - status='delivering' 且剩余>0：显示"配送中 · 约{剩余时间}后到达"（橙色文字）
  - status='delivering' 且剩余<=0：自动标记为 'delivered'，显示"已送达 ✓"（绿色文字）
  - status='delivered'：显示"已送达 ✓"（绿色文字）
  - 无 deliveryMinutes 的旧订单：不显示配送状态（兼容）
- 打开手机/进入订单页时实时计算剩余时间

### Step 5：到货检测与提示词注入（chat.js）
- 在 chat.js 每轮发送前（和一起听注入同位置附近），调用 `Phone._getDeliveryPrompts()`
- 该函数遍历所有 delivering 订单，检测是否到达：
  - 到达 → 标记 status='delivered'，持久化，返回提示词数组
  - 提示词格式：`【外卖/快递已送达】{{user}}在{平台}下单的"{商品名}"{目标信息}已送达。请在剧情中自然加入收货情节（拆快递/拿外卖/递给对方等），不要复述本提示。`
- 注入位置：system 消息，和一起听提示词注入方式一致
- 每个订单只触发一次（status 变更后不再触发）

### Step 6：兼容性处理
- `Calendar.parseAbsoluteTime` 不可用或解析失败 → fallback 用 `_parsePhoneTimeScore` 拆出年月日时分做差值
- 下单时游戏时间为空 → 不生成配送时间，`_log` 保持旧文案"配送时间由你在剧情中自然安排"
- 旧订单无 `deliveryMinutes` 字段 → 订单卡片不显示配送状态，不触发到货检测

### 文件改动
- `js/phone.js`：工具函数 + `DEFAULT_SHOP_CFG` 新增配送配置 + `_shopCreateOrder` 改造 + 订单渲染改造 + 导出 `_getDeliveryPrompts`
- `js/chat.js`：注入检测逻辑（1处）
- 版本号升级
