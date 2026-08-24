# 05 UI 出口适配层契约（注册策略 / 优先级 / 互斥规则 / 能力降级矩阵）

> 来源：实施计划 v1.3 §3.2 + §6 风险 1/13/15 + t6（0.13.0 互斥）+ t8 预审（webServer W1-W5）。本文档定稿出口层契约（计划 §8 交付物 2）。

## 1. 出口注册策略与优先级

| # | 出口 | 依赖 | 状态 | 优先级与时机 |
|---|---|---|---|---|
| ① | **Agent 通道**（tools + prompt 注入） | 无（host 侧核心层固有） | **永远可用** | 第一：本质即「无 UI 出口」，任何 UI 缺席都不受影响 |
| ② | **conversation.view 原生 tab** | dsh 自带 `slots`（零第三方） | **默认启用** | 第二：**默认兜底出口**；better-sidebar 缺席/被整体禁用时自动生效 |
| ③ | **better-sidebar Tab** | 第三方 dsh-better-sidebar | 可选（**最后开发**，D-B2） | 第三：**双检查**（§3）；存在且可见时**替代** ②（互斥） |
| ④ | **webServer 自托管面板** | 平台 `webServer`（零第三方） | 可选（v2 前置） | 第四：独立注册路由，与 ②③ 可共存（不同媒介） |

**互斥/共存规则**：
- ② 与 ③ **互斥**（同属 tab 环类座位，防重复渲染）：默认注册 ②（不依赖原则）；探测 ③ 可用 → 注销 ②、注册 ③（③ 为增强替代）；
- ④ 与 ②③ **共存**（不同媒介）；
- 任一出口注册抛错 → 各自 try/catch + console.error，不影响其他出口与核心层；
- 出口全部缺席 → 核心层（① 永远在）不受影响——「无 UI 也完整」。

**依赖声明纪律（v1.3，V1/H2 闭合）**：client 半返回对象**只声明 `inject: ['timer']`**；**better-sidebar 绝不进 inject**（硬依赖会在服务缺席时使整个 client 半 waiting、apply 永不执行——默认出口 ② 也会失效）。apply 顶部无条件执行核心逻辑与 ② 注册；`const bs = ctx.get('betterSidebar'); if (bs) ...` 分支才注册 ③（t2b 结论①：ctx.get 免声明、缺席返回 undefined）。

## 2. 出口②：conversation.view 原生兜底（★默认出口）

```js
const slots = ctx.get('slots')            // ctx.get 判空（slots 是可选服务）
if (slots) {
  ctx.effect(() => slots.register({
    name: 'conversation.view',
    id: 'lab.monitor',
    order: 20,
    label: labelThunk,                    // O(1) 读 last；仅 last 变化时更新 label（R-4 try/catch）
    // 面板组件：若 M7 实证支持自定义组件渲染（createElement 面板），按实证结论注册
  }, component))
}
```

- replaceRisk：none（会话头部 tab 环，t8 §3.4）；
- 渲染节流：无 visible 语义 → **常驻 5s**（渲染路径见 docs/architecture/core.md §2.9）；
- 注册时序：apply 时先注册本出口；③ 探测可用 → 注销本出口（disposer）改注册 ③；③ 失败 → 保持本出口；
- slots 缺席 → 本出口跳过（纯核心运行，Agent 通道①兜底——风险 15 场景）。

## 3. 出口③：better-sidebar 适配器（最后开发，可选增强）

### 3.1 注册形态（不依赖注入）

```js
// client 半对象只 inject:['timer']；适配器分区内：
const bs = ctx.get('betterSidebar')
if (bs && snapshotUi.betterSidebarVisible) {   // ★双检查（§3.2）
  ctx.effect(() => bs.registerTab({
    id: 'lab-monitor:gpu',                    // 命名空间前缀+冒号（t5 落地建议 1）
    title: () => 'GPU 监控',                   // thunk O(1) 读 last（可动态化，忙时加 ●）
    order: 90,
    single: true,
    badge: () => last ? (last.criticalCount || null) : null,  // 数字=CRITICAL 计数（99+ 封顶），只读 last
    settings: { pluginToggles: {              // v0.12.0+ 插件自有键，持久化 pluginSettings[id]
      utilWarn:  { type: 'number', min: 0, max: 100, unit: '%',  def: 90 },
      memWarn:   { type: 'number', min: 0, max: 100, unit: '%',  def: 95 },
      tempWarn:  { type: 'number', min: 0, max: 120, unit: '°C', def: 85 },
      pollMs:    { type: 'number', min: 1000, max: 60000, unit: 'ms', def: 5000 },
      autoPoll:  { type: 'switch', def: true },
    } },
    component: (props) => createElement(MonitorPanel, props),  // visible 语义组件
  }))
}
```

- **features 能力门控**：`bs.features.includes('badge')` 才注册 badge、`includes('pluginSettings')` 才注册 settings（features 只增不减，用 includes() 语义，t6 D6）；
- thunk 抛错被 better-sidebar 吞掉 → 一律 try/catch + console.error（R-4）；
- 生命周期回调仅 service 路径触发，只做体验优化不承载状态（t5 §1.2）。

### 3.2 双检查（0.13.0 互斥「服务在、UI 隐形」形态防御，t6 §4 结论 B）

0.13.0 起存在「**服务在、UI 隐形**」形态：aionui-panel 启用时 better-sidebar 的 client 半在 apply 开头**无条件 provide 服务**、registerTab **照常成功**，但仅 unmount 侧边栏 UI（suspended=true），且 **suspended 不进 getSnapshot、服务 API 不暴露**——仅 `ctx.get('betterSidebar')` 判空**无法识别**。

防御（t6 §4 规避方案 3）：

1. **host 半探测**：`settings.describe` 读命名空间 `aionui-panel`，`rightPanel === 'aionui-panel'` → 标志 false（better-sidebar 自己的 host 半即此姿势，t6 §3.2 ①）；
2. **标志并入快照**：`snapshot.ui.betterSidebarVisible`（docs/reference/protocol.md §2.1）；host 半监听 `settings/updated` 事件**实时刷新**（t6 §4 规避方案 1/2）；
3. **注册条件 = 服务判空（absent）且 可见性标志（hidden）双通过** → 注册 ③；任一不通过 → 保持 ② 默认出口，零功能损失。

### 3.3 探测重探机制（M4）

`ctx.get` 是即时查询——若插件 apply 早于 better-sidebar 服务发布（激活时序不定），一次性探测返回 undefined 后永不升级。注册 ② 后**延迟重探**：

- `ctx.setTimeout` 2s 一次、共 3 次（或实现时实证平台服务注册事件）；
- 探测成功 → 注销 ② 切换 ③；探测失败 → 保持 ②，不影响功能。

### 3.4 0.13.0 契约兼容性（t6 §2.2）

- registerTab/badge/title thunk/visible/pluginToggles/render/onOpen|onActivate|onClose 全部不变（完全向后兼容）；
- `settingSelect`（select 设置行）为可选能力，阈值面板用 number 行不强依赖；`urlTarget` 不使用（不抢外链）。

## 4. 出口④：webServer 自托管面板（可选，v2 前置）

```js
const ws = ctx.get('webServer')          // 判空可选消费（L2）
if (ws) {
  const dispose = ws.register({ kind: 'exact', path: '/lab-monitor', handler: serveHtml })
  ws.register({ kind: 'exact', path: '/lab-monitor/api/snapshot', handler: serveSnapshot })
}
```

**三约束（t8 预审 W1-W5）**：
1. **路由命名（W2）**：`/lab-monitor`（面板页）+ `/lab-monitor/api/snapshot`（快照 JSON）——重复 (kind, path) 注册直接 throw，路径必须全局唯一前缀；
2. **禁 registerFallback（W3）**：单座位已被 DSH SPA dist 占用，注册即 throw 破坏组合；
3. **静态内容自产（W5）**：webServer **不提供静态文件服务**（"serves no files"）——HTML 内嵌插件源码字符串，或经 shell 服务 cat 文件（Host 无 fs 内建），handler 自产完整响应体。

**绑定与可达（W1）**：webServer 是 DSH 共享网关上的路由注册（非独立服务器），监听地址/端口由网关配置决定（当前 127.0.0.1:3080），**插件不可选端口**；手机端经 Tailscale 转发器（100.64.0.2:13080）可达。后续可扩展 SSE `/lab/events`（W4：handler 可保持响应打开）。MVP 不做（v2 前置）。

## 5. 能力降级矩阵（出口不可用时的行为）

| 场景 | 判据 | 行为 | 用户可见结果 |
|---|---|---|---|
| 未安装/未挂载 better-sidebar | `ctx.get('betterSidebar') === undefined` | 跳过 ③，保持 ② | 默认出口 ② 正常 |
| 已装但选了 aionui-panel（0.13.0 互斥） | `snapshot.ui.betterSidebarVisible === false` | 双检查不通过，保持 ② | ② 正常，③ 隐形不误报 |
| registerTab 抛错 | try/catch 捕获 | 注销 ③（若有），保持 ② | ② 正常 + console.error 日志 |
| slots 缺席 | `ctx.get('slots') === undefined` | 跳过 ② | 纯核心运行，Agent 通道①可用 |
| webServer 不可用/路由冲突 | `ctx.get('webServer')` 空或 register throw | 跳过 ④ | 其他出口不受影响 |
| **②③④ 全缺席/全失败** | 组合判据 | 纯核心运行 | 采集/告警/工具/prompt 注入完整（P0 验收 5） |

> 降级矩阵实现于 client 半出口分发分区；每个出口独立 `ctx.effect` + try/catch（计划 §6 风险 15）。

## 6. 关联文档

- 出口层总览与解耦契约：`docs/architecture/core.md` §3/§4
- 快照字段 `ui.betterSidebarVisible` 与 RPC 契约：`docs/reference/protocol.md`
- 出口相关验收：`docs/reference/milestones.md` P0 验收 6、P2 验收 4/5
- 0.13.0 互斥机制证据：`docs/research/05-better-sidebar-0.13-contract.md`
- webServer 契约证据：`docs/research/07-webserver-preflight.md`

---

## V2（正式插件形态，2026-08-20）

- 本文件内容在 V2 保持不变（数据模型/协议/验收语义与形态无关）。
- V2 差异：client 数据面由 `host.call('labMonitor.*')` 改为 **HTTP `/lab-monitor/api/*`**（协议字段不变）；工具注册走官方 `ctx.tools.register(defineTool(...))`；prompt 注入默认关闭（KV 缓存友好，`lab_status` 工具替代）。
- 完整迁移设计：`docs/research/12-v2-migration.md`；架构差异：`docs/architecture/core.md` §8-11。
