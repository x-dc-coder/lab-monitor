# 19 better-sidebar 接入契约与 UI 打磨复盘（2026-08-23）

> 状态：**已实现并验证**（2026-08-23 收尾）。关联/推翻 #13（2026-08-20）：当时用户要求保持 **conversation.view 作为面板主出口**；本轮用户**反转决策，要求默认走 better-sidebar tab**（conversation.view 仅作兜底）。输入：`dsh-better-sidebar@0.14.0` lib/types/client/service.d.ts 契约、官方 README、浏览器 console/DOM/getBBox 实测。
> 唯一知识源：`~/.dsh/.agent-presets/plugin-specialist/docs/local/better-sidebar-integration.md`（预设沉淀）——本笔记是该预设仓库侧的落地复盘。
> 已推送 GitHub `x-dc-coder/lab-monitor`（commit c49930c 及之前的 lab-monitor 提交链）。

## 1. 结论速览（5 条，避免再踩）
1. **服务访问必须兼容 `ctx.betterSidebar` 属性通道**：`ctx.get('betterSidebar')` 在本轮实测**一直返回 undefined**（尽管 better-sidebar client 已加载、`ctx.provide("betterSidebar", service)` 无条件执行），而 `(ctx as any).betterSidebar` **命中**。⇒ 用「`ctx.get` + `ctx.betterSidebar` 双通道」探测（office 插件正是走 `inject:['betterSidebar']` → `ctx.betterSidebar`）。
   - ⚠️ 这**修正**了 #13 第 2 节"跨 bundle `ctx.get` 应能拿到"的判定——实证是拿不到，需属性通道。
2. **判 better-sidebar 是否加载**：DSH 设置页导航有无 **「Side card」** section（better-sidebar 注册的 `settings.section`）。有 ⇒ client 已加载；无 ⇒ 未加载（看 console）。
3. **client 的 `ui-primitives/ui-slots` 等 peer 由 web 宿主解析，勿装进 profile**：`plugin_doctor_health` 报 peer 缺失是**既存基线**（宽声明）。本轮曾误 `dsh plugin add` 装进 profile，回滚后 better-sidebar 仍正常 ⇒ 证明确由 host 解析（详见预设 RULES.md §6）。
4. **注册→默认打开**：`registerTab` 后 `bs.openTab({ type: id })` 让 tab 成为激活 tab；`single: true`（= dedupeKey:()=>id）保证不重复建。
5. **tab 图标**：契约 `icon: (size) => ReactNode`，better-sidebar 用 `currentColor` 染色，默认 16px。**判据：`svg.getBBox()` 与默认图标对照**——本仪表盘起初是半圆（bbox `10.4×6.8`），远小于默认文件夹图标（`15×12.9`）⇒ 视觉"大小不匹配"。改成 **270° 弧**（底口、表盘上扫、枢轴底中，`strokeWidth 1.5`）后 bbox `14.6×12.4`，与默认图标匹配。

## 2. better-sidebar 服务访问（★核心，本轮真因）
- better-sidebar client 在 `apply` 里 **`ctx.provide("betterSidebar", service)`**（`client-registry.js`），`SideCardSection` 等 `settings.section` 也在同 apply 注册 ⇒ **设置页有「Side card」= 服务已 provide**。
- 但 lab-monitor 用 `ctx.get('betterSidebar')` 探测 10×2s（20s）**始终超时** → 曾回退 conversation.view；加 `ctx.betterSidebar` 通道后立即命中（console `better-sidebar 出口③已注册`）。
- 结论：**可选消费 better-sidebar 时，把 `ctx.get` 与 `(ctx as any).betterSidebar` 都试一遍**；绝不放 `inject:['betterSidebar']`（服务缺席会崩）。

## 3. registerTab 契约（TabDescriptor，service.d.ts）
```ts
bs.registerTab({
  id,                       // 唯一 = SidebarTab.type
  title: ()=>string|string, // thunk 支持 i18n
  icon: (size:number)=>ReactNode, // 16px 描边 currentColor（官方 primitives `IconXxxOutline16`，或内联 SVG）
  order: 90,                // + 菜单排序（升序 默认100）
  single: true,             // = dedupeKey: ()=>id（聚焦已有，不重复建）
  badge: (ctx,scope,state)=>number|string|null, // 数字渲染为计数(99+ 封顶)
  settings: { pluginToggles:[{key,title,type:'number',min,max,unit}] }, // 声明式设置（阈值同步）
  component: (props)=>ReactNode,
  // 可选: hidden/available/dedupeKey/createTab/urlTarget/onOpen/onActivate/onClose
})
// 默认打开:
bs.openTab({ type: id })   // OpenTabSeed: type/title/path/diff/id/url/meta
```
- **零第三方依赖图标**：内联 SVG `viewBox 0 0 16 16`、`stroke currentColor`、`strokeWidth 1.5`、round caps——与官方同风格。lab-monitor 用 `gpuTabIcon(size)` 返回 `React.createElement('svg', ...)`。

## 4. 图标"大小匹配"判定与 270° 仪表盘
- 判据：`tab.querySelector('svg').getBBox()`。默认文件夹 `{w:15,h:12.9}`；**半圆表盘只有 `{w:10.4,h:6.8}`**（内容只占上半，视觉偏小）。
- 修复：**270° 弧**（底部开口、上扫、枢轴底中）——`M2 13.6 A7.3 7.3 0 1 1 14 13.6`（外弧）+ 内圈刻度带 + 3 刻度 + 指针 `M8 12.9 L11.4 6.3` + 枢轴圆。后 bbox `{w:14.6,h:12.4}` 匹配。
- 不要用 `width/height` 属性判断大小（都是 16px），要用 `getBBox()` 看**内容**。

## 5. UI 打磨轮（本次一并落地，均遵守"最小改动/内联 style/只用 --dsw-alias-* token"）
| 改动 | 要点 |
|---|---|
| 详情展示页 | `DetailOverlay` 全屏浮层：标题/指标栅格/完整命令（等宽+复制），点击进程/实验行打开；`ProcLike` 兼容 `cmd:string|null` |
| 控制/标签管理迁设置页 | 走 `settings.section` slot（`slots.inject('settings.section', ...)`），主面板只留监控视图 |
| tab 名称 | `labelThunk` → `GPU 监控`（+critical 告警角标）；`summaryLine` 改为工具栏式 `GPU 0% · CPU 16% · 内存 71%`（去 "监控 GPU0 0% 1.3/15.9G CPU 6%" 长串） |
| 暗色主题 | `background: C.brand + #fff` 在暗色下白底白字不可见（`--dsw-alias-brand-primary` 暗色=近白）→ 统一改 `background: C.label(ink) + color: C.layer1(surface)` 反转色；bar track / chip 硬编码 `rgba(0,0,0,0.0x)` → `C.border` |
| section 卡片统一 | `sectionCard/sectionHead/sectionChip` 共用；`EndedBlock` 改标题行+指标栅格+cmd 行（两行栅格）；`ControlPanel` 阈值改 label在上/input在下 栅格 |
| better-sidebar 兜底互斥 | ③ 注册成功才 dispose ②（conversation.view）；③ 失败/未注册 → 保留 ②。探测窗口 20s（10×2s）；`ui.betterSidebarVisible===false` 跳过 |

## 6. 关键文件 / 提交
- `src/client.ts`（全部 UI/集成改动）。
- 提交链（已推 `x-dc-coder/lab-monitor` master）：`c49930c`（图标放大）← `faa71d5`（图标细化）← `b38d740`（仪表盘+默认打开）← `f42a7e2`（↔ctx.betterSidebar 双通道探测）← `a0ba6f1`（tab 名称/状态行）← `a243d78`（GPU图标+兜底）← `cbe47e4`（详情页+设置页迁移）← `0f30240`（section 卡片统一）。
- 预设侧：`~/.dsh/.agent-presets/plugin-specialist/docs/local/better-sidebar-integration.md`（新增）+ RULES.md §6（2026-08-23 条目）+ ui-optimization-quickref.md §3（指针）。

## 7. 后续可优化（backlog）
- better-sidebar tab 的 `badge`/`settings.render` 尚未深度展开（当前用 `pluginToggles` 同步阈值）。
- 图标可再加"告警色调"（如 critical 时指针变红）——需 badged 状态传入 icon。
- 无 remote 前的历史（#13 决策反转）值得在 usage.md 标注：当前默认 better-sidebar tab，conversation.view 兜底。
