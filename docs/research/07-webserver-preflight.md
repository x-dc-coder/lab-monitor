# t8 v1.2 复审预审备忘（v1.2 尚未落盘，正式复审待续）

> 评审人：reviewer｜日期：2026-08-18
> 状态说明：t8 已认领（attempt 1）；评审对象 v1.2（output-t3-plan.md §10 修订）**尚未产出**——t7（architect）in_progress 且依赖 t6（0.13.0 核验，claimed 未完成）；队长已向 architect 转达 0.13.0 关键事实，architect 可不依赖 t6 先行修订。
> 本备忘 = 正式复审前已完成的事实核验 + v1.1 独立性残留扫描。v1.2 落盘后据此完成 output-t7-review2.md。

---

## 1. 事实核验：webServer 服务契约（直接读 `dsh-host-webserver/lib/types/index.d.ts`，109 行）

| # | 事实 | 对 v1.2 的意义 |
|---|---|---|
| W1 | webServer = **DSH 共享网关上的路由注册服务**，非独立服务器；监听地址/端口由网关配置决定（`host: '127.0.0.1'\|'0.0.0.0'`，port 0=OS 分配），**插件不可自选端口** | 自托管面板 = `http://127.0.0.1:3080/<自定义路径>`，不是独立端口服务；与 monitor-panel 形态不同 |
| W2 | `register(route: {kind:'exact'\|'prefix', path, handler}) → disposer`；**重复 (kind, path) 直接 throw**（"route patterns are a composition-level contract, so a collision is a misconfiguration"） | 路径必须全局唯一，建议 `/lab-monitor/` 前缀命名空间；与 DSH 内置冲突的唯一途径是路径撞名，先查已有路由再定路径 |
| W3 | **`registerFallback` 单座位**："One owner only — a second registration throws"——Web 组合的 SPA dist 服务器已占位 | **Lab Monitor 绝不可注册 fallback**（会 throw 破坏组合）；只可用命名路由 |
| W4 | handler "Owns the full response lifecycle (may hold the response open, e.g. SSE)" | **SSE `/lab/events` 可行**（t8 §3.1 webServer 可选通道 ✓） |
| W5 | "Knows no harness concepts and **serves no files**" | **webServer 不提供静态文件服务**：自托管 HTML 面板需 handler 自产响应体（HTML 内嵌插件源码字符串，或经 shell 服务 cat 文件——Host 无 fs 内建）；v1.2 若规划自托管面板必须写明此实现路径 |

## 2. v1.1 独立性残留扫描（v1.2 必须处理的 6 点）

| # | 残留 | 严重度 | 说明 |
|---|---|---|---|
| V1 | **`inject: ['betterSidebar','timer']` 硬依赖**（§3.2 注册骨架） | **高** | t2b 结论①：已声明属性访问 = 硬依赖，服务缺席时插件进入 **waiting 状态永不 apply**。0.13.0 互斥机制（选 aionui-panel 时 better-sidebar 整体不挂载，队长已核验）下 `ctx.get('betterSidebar')` 为 undefined——**conversation.view 兜底代码在 apply 内，根本不会执行**，"core 独立"名存实亡。必须改：inject 只留核心服务（timer），betterSidebar 改 `ctx.get()` 可选消费（t2b 结论①明示姿势：`const bs = ctx.get('betterSidebar'); if (bs) bs.registerTab(...)`） |
| V2 | **T2-1 决策①阈值事实来源绑定 pluginSettings**（better-sidebar 专属持久化） | **高** | pluginSettings 存于 sidebar prefs 文档（t2b §1.3 实证）——better-sidebar 缺席时 client 读不到阈值 → 退默认且无法持久化。核心配置（阈值）应存 **host 侧 `settings` 服务**（t2 §2 实证存在），pluginSettings 仅为出口层同步面；请求携带阈值仍可保留（来源改为 host settings 读出） |
| V3 | **P0 验收 1/2 以 better-sidebar Tab 为唯一 UI 断言** | 中 | P0 无"better-sidebar 缺席时兜底 UI 同数据"断言（兜底断言只在 P2 验收 4）——独立架构下 P0 就应加：禁用 better-sidebar（0.13.0 互斥或卸载）→ conversation.view 兜底显示同数据 |
| V4 | **P2「能管」的 badge 是 better-sidebar 专属能力**（conversation.view 无 badge 概念） | 中 | badge 应定位为**出口层增强**；核心验收 = host 侧 `alertsCriticalCount` 字段存在且增长（任意出口可消费），P2 验收 1 不应把 badge 显示写死为唯一断言路径 |
| V5 | **P2 验收 2 持久化断言（T4-4）绑定 pluginSettings**（"重开页面 → pluginSettings[id] 仍在"） | 中 | better-sidebar 缺席时此断言无对象；应改为 host settings 持久化断言，或双轨写明 |
| V6 | §2 架构图 / §3.2 标题仍以"better-sidebar Tab"为主视觉、兜底仅一句 | 低 | v1.2 应改为「核心引擎 + 出口适配器层」表达（registerTab / conversation.view / webServer 自托管为并列出口） |

## 3. v1.2 正式复审核对点（v1.2 落盘后逐项核对）

1. **独立性达成度**：core 层零第三方依赖（不 import better-sidebar/slots 必须判空）；V1 硬依赖是否消除；better-sidebar 缺席时采集/告警/工具/prompt 注入/兜底 UI 全链路可工作；P0~P2 验收无 better-sidebar 隐含依赖（对照 V3/V4/V5）
2. **出口层设计**：适配器注册策略（判空/features 门控/优先级/共存规则）闭环；conversation.view 兜底 replaceRisk none 零风险论证；webServer 自托管路径按 W1~W5 事实核对（命名路由唯一、禁 fallback、静态内容自产）
3. **开发顺序**：P0/P1/P2 是否"sidebar 最后"；每里程碑验收可测量且不依赖第三方插件存在
4. **前轮回归抽查**：T1-1（pid 链路）、T1-2（result 配对）、T2-1（阈值链路改版后无回归）、T2-2（保活通道）、R-1（双实例策略）五处在 v1.2 中保留且无矛盾
5. **风险表**：新增「0.13.0 互斥禁用」「出口降级链」两条风险及其缓解是否完整

## 4. 预审结论（正式结论待 v1.2）

v1.1 的"核心独立"**未达成**：V1（inject 硬依赖）为硬伤——better-sidebar 缺席时 client 半整体不激活，兜底路径失效。v1.2 能否通过复审，取决于 architect 对 V1~V6 的处理质量；其中 V1/V2 为高严重度判定基准。
