# Lab Monitor Client 半（D-B1）实证记录：数据消费者 + conversation.view 默认出口

> **归档注记（2026-08-20 清理）**：本文所述 v1.4.5 MVP 资产（`plugin/client/index.js`、`plugin/client/mock-test.js`）——`index.js` 已归档至 `docs/archive/v1.4.5-plugin/client/`，`mock-test.js`（V2 仍用）已移至 `scripts/mock-test.js`。

> 执行人：researcher（t14）｜日期：2026-08-18
> 交付：`plugin/client/index.js`（MVP 单文件 = code.client 函数体，已归档 `docs/archive/v1.4.5-plugin/client/`）+ `scripts/mock-test.js`（零依赖 mock 测试，原 plugin/client/）
> 契约：lab-protocol/1.1（docs/03-protocol.md §2.1）；计划 v1.4.1 §3.2（t3 计划 output-t3-plan.md）

## 1. 实现要点

| 项 | 实现 |
|---|---|
| 形态 | 单文件 = cordis_define 的 code.client 函数体（顶层 `return { name, inject, apply }`；符号面 React/host/console 由运行时注入）；无 import/export、无 JSX |
| 依赖声明 | **只 `inject: ['timer']`**（better-sidebar 绝不进 inject——硬依赖会使 client 半 waiting、默认出口失效，t2b 结论①）；slots 经 `ctx.get('slots')` 可选消费 |
| 数据消费者 | 模块级 `last` 快照缓存 + `refresh()` 调 `host.call('labMonitor.snapshot', {})`（try/catch 永不抛出）；**T2-3 指数退避 5s→10s→30s 封顶**（`BACKOFFS` 档位 + `backoffIdx`，成功复位） |
| 出口② 注册 | `slots.register({ name:'conversation.view', id:'lab-monitor', order:20, label: labelThunk }, MonitorPanel)`；ctx.effect 包裹（disposer 随 fiber 清理）；注册抛错 try/catch（R-4） |
| label thunk | O(1) 读 last，摘要格式 `监控 GPU0 92% 18.8/24G CPU 340% 1告警`；try/catch + console.error（R-4）；last 缺失/失败时降级 '监控' / '监控 · 重试中' |
| MonitorPanel | React.createElement 渲染：状态行（连接灯 + 摘要 + 更新时间 + `[wsl·dmon]` platform/sources 标注）、GPU 卡（名称/利用率三档色/显存/温度/功耗/degraded 标记）、CPU/内存卡、实验状态行、GPU 进程表（≤10 行）、告警列表（≤5 条，level 着色 + 置信度 + 建议动作） |
| 轮询调度 | 组件内自调度 `ctxRef.setInterval(tick, nextWaitMs())`（成功 5s / 失败退避档）；**卸载 → cleanup dispose 全部 interval = 零渲染轮询**（P0 验收 2 口径）；禁用 window.setInterval（guard 遮蔽） |
| 首帧 | apply 顶部**无条件** `refresh()`（失败静默，退避由组件调度接管）；组件首帧 last 新鲜（<5s）直接复用，否则立即拉取 |

## 2. 验证结果（node scripts/mock-test.js，33 项断言 ALL PASS）

### 2.1 契约形态（[1][2]）
- 插件对象形态 ✓（name='lab-monitor'、inject 仅 ['timer']、apply 函数）
- apply 顶部无条件执行：apply 即触发首帧 `host.call` ✓；slots.register 调用且 options 正确（name/id/order=20/label thunk/组件函数）✓

### 2.2 labelThunk 摘要（[3]，lab-protocol/1.1 样例快照）
```
label = "监控 GPU0 92% 18.8/24G CPU 340% 1告警"
```
（19200MiB→18.8G 换算正确；alertsCriticalCount=1 → '1告警'）

### 2.3 MonitorPanel 渲染树（[4]，createElement 树结构断言 13 项）
- 根 div ✓；GPU0 卡（名称 + 92% + 显存 18.8/24 + 78°C + 350W）✓
- CPU 卡（340%）✓；内存卡（可用 6.1/14）✓
- 进程表（python train_demo.py / pid 1234）✓
- 告警列表（CRITICAL + 显存余量 <10% + 置信 90% + 建议: 降 batch size）✓
- 实验状态行（run-20260818-001 [running]）✓
- platform/sources 标注 `[wsl·dmon]` ✓

### 2.4 轮询节流与 T2-3 退避（[5]）
| 场景 | 期望间隔 | 实测 | 结果 |
|---|---|---|---|
| 成功路径 | 恒 5s | [5000] | ✓ |
| host 失败 1 次 | 退避 10s | 10000 | ✓ |
| host 连续失败 2 次 | 退避 30s（封顶） | 30000 | ✓ |
| host 恢复 | 复位 5s | 5000 | ✓ |
| 调用次数 | 2 失败 + 1 恢复 = 3 次 | 3 | ✓ |

### 2.5 零渲染口径（[6]）
- 组件 useEffect 返回 cleanup ✓；调用 cleanup（模拟卸载）→ **全部 interval disposed**（0 存活）✓ = "组件卸载即停"，P0 验收 2 零渲染可操作定义达成

### 2.6 核心独立兜底（[7]）
- slots 缺席（ctx.get 返回 undefined）→ apply 仍执行首帧拉取（host.call > 0）✓、不注册轮询（无 UI）✓、console.warn 提示 Agent 通道① 兜底 ✓

## 3. 静态纪律检查（node 内联脚本）

- `new Function('React','host','console', src)` 编译通过（= cordis-runner 函数体求值形态）✓
- 无 import/export ✓；无 window.setInterval/window.setTimeout（剥离注释后）✓
- inject 仅含 'timer' ✓；无 betterSidebar 引用（D-B2 范围外）✓

## 4. 已知边界与后续（供 D-B2 / 集成）

1. **M7 样例②未执行**：本实现按"组件卸载即停"口径设计（两分支兼容：若 conversation.view 在 tab 失活时保持挂载，5s 常驻轮询照常；若卸载，interval 清理即停）。**集成前须跑 M7 样例②实证 conversation.view 承载能力与 tab 失活生命周期**（卸载/隐藏/保活），回填 P0 验收 2 口径。
2. **阈值不携带**：refresh() 调 `host.call('labMonitor.snapshot', {})` 不携带 thresholds（事实来源在 host settings，M3 last-write-wins）；D-B2 better-sidebar pluginToggles 编辑面接入后，由适配器读取 pluginSettings 携带。
3. **连接中断 UI**：host 连续失败时 snap 置 null → 状态行红点 + '连接中断，重试中…'；last 保留旧值（label 显示 '监控 · 重试中'）。
4. **callCount 断言**：组件挂载期间 host.call 增量符合 5s 节奏（[5] 已按此节奏验证）；P0 验收 2 的 host 侧 callCount 对照在集成时执行。
5. **host 半契约对齐**：`labMonitor.snapshot` 响应字段按 lab-protocol/1.1 全部消费（含 v1.4 platform/sources/gpuState/degraded）；host 半（D-A）实现须与协议一致，字段缺失时 UI 容错（null 显示 '-'）。
