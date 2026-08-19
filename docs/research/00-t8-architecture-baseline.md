# t8 科研实验监控助手（Lab Monitor）架构调研报告

> 调研日期：2026-08-19（本会话实测，全部契约来自 `cordis_inspect_*` 实时查询与本机已装 better-sidebar 0.12.2 源码）
> 结论先行：**以自定义动态 Cordis 插件（Host+Client 双半）为实时骨架**；"消息传递/hook"由
> **Host 事件钩子（tools/pre-execute、tools/result 等）+ host.call 进程内 RPC + systemPrompt 变量注入 + 自定义工具桥** 四通道共同完成；
> 可视化落在 **better-sidebar 第三方 Tab**（用户已装且已定方案）；Agent 预设与 Agent-teams 是"大脑"和"调度器"，不是实时载体。

---

## 1. 需求拆解

| 需求 | 本质 | 对架构的约束 |
|---|---|---|
| 实时监控 内存/GPU/CPU | 秒级采样 + 低开销 | 必须进程内定时采样（timer+shell），**不能走 LLM 回合** |
| 实时反馈设备状态变化 | 事件/消息传递（用户最看重） | 平台级 hook：工具执行前/后事件、agent 状态事件；UI 侧拉取刷新 |
| 以最平衡状态最快完成实验 | 确定性诊断引擎 + 建议 | 阈值/规则用**代码**实现，LLM 只做上层解读 |
| Sidebar 自定义 tab | Client 插件机制 | better-sidebar `registerTab`（或原生 `conversation.view` 兜底） |

---

## 2. 三条路线对比（核心结论）

| 维度 | A. 自定义 Agent 预设 | B. Agent-teams | C. 自定义插件（推荐） |
|---|---|---|---|
| 实时性（1~2s 采样） | ❌ 回合制，分钟级延迟 | ❌ 每个成员都是 LLM 回合，秒级遥测不可能 | ✅ Host 内 `timer.interval` + `shell`，零 token |
| 注册 Sidebar Tab / UI | ❌ Agent 无注册 UI 能力 | ❌ 同上 | ✅ Client 半注册 better-sidebar Tab / conversation.view |
| 消息传递（hook） | 只能"被动看到"工具结果，无事件总线 | 邮箱是 LLM 之间的人话消息，非系统级事件 | ✅ `tools/pre-execute`（waterfall 可拦截）、`tools/result`、`agent/status`、`workflow/*` 等平台事件 |
| 确定性（阈值/告警/平衡建议） | LLM 判断不稳定、贵 | 同左 | ✅ 状态机 + 规则引擎，稳定、免费、可测 |
| 成本 | 每回合烧 token | 多成员并发烧 token | 采样与规则零 token |
| 正确角色 | **指挥层**（解读指标、决策下一步） | **编排层**（多实验并行/超参扫描） | **骨架层**（采样/状态/告警/UI/桥） |

**结论：不是三选一，是三层组合。** MVP 只做 C；A 作为 v2 的"实验指挥"预设叠加在 C 之上（C 提供工具+prompt 注入，A 提供 persona 与决策规则）；B 只在需要并行跑多个实验时启用（共享 GPU 池仍由 C 统一监控）。

---

## 3. 平台能力实测（本次调研的硬事实）

### 3.1 Host 端受限环境（决定采样方式）
- 内建符号只有 `ctx / harness / console / btoa / atob / TextEncoder / TextDecoder`——**无 `process`、`require`、`fetch`、`setTimeout`**。
- 定时器走 `timer` 服务（`interval/timeout/throttle/debounce`，随 fiber 自动清理）。
- 采样走 `shell` 服务：`shell.run(spec)` 前台执行（如 `nvidia-smi --query-gpu=...`），`shell.start(spec)` 后台长驻进程 + `ShellProcess.readOutput()` **增量读取** —— 对应 `nvidia-smi dmon -d 1` 连续流，比每秒 fork 一次 `nvidia-smi` 廉价得多（推荐模式）。
- `subprocess` 服务可 spawn 精细控制；`webServer` 可注册 HTTP 路由（可选：SSE 推送给手机/monitor-panel）。

### 3.2 Host 事件目录——"hook"的真正答案（本会话实测全部存在）
| 事件 | 模式 | 用途 |
|---|---|---|
| `tools/pre-execute` | waterfall | **实验开始钩子**：工具派发前拦截/放行/改参。匹配 bash 工具中的训练命令 → 自动进入实验模式、记录基线、可阻断危险命令（如显存余量不足时提示） |
| `tools/result` | emit | **实验结束钩子**：冻结的最终结果 → 结束实验模式、统计本次实验资源曲线 |
| `tools/execute` / `tools/post-execute` | waterfall | 超时/重试/指标；结果增强（如给实验命令附资源摘要） |
| `agent/status` | emit | agent idle⇄running —— 可监控"DSH 自身 LLM 调用"对 GPU 的占用（若模型服务同机），是"平衡"的一部分 |
| `workflow/start·end·log·phase` | emit | 实验若走 workflow 引擎时的生命周期 |
| `subagent/start·end` | emit | 并行子代理实验的起止 |
| `llm/stream` | waterfall | 每次流式模型调用环绕——可计量 Agent 回合本身的资源消耗 |
| `session/event`、`approval/request` 等 | emit/waterfall | 会话事件流、审批钩子（可作为"用户确认后开跑"的触发点） |

> 关键洞察：DSH 把"工具调用前后"做成了平台级 hook（waterfall 可拦截），**实验生命周期根本不需要 Agent 自轮询**——插件监听 bash 工具的 pre/result 即可自动判定"实验开始/结束"，这正是用户要的"消息传递/hook"的主通道。

### 3.3 插件 → Agent 的双向桥（把状态送进模型上下文）
- **拉 ① 工具桥**：`harness.defineTool` / `harness.registerTool` —— 注册 `lab_status`（快照）、`lab_advice`（平衡建议）、`lab_set_threshold` 等工具，Agent 按需调用。
- **拉 ② 每步自动注入**：`systemPrompt` 服务 `variable(name, provider)` / `section(...)` —— **每个模型步重新解析**，把当前实验状态摘要（如"GPU0 92% util / 显存 20.1/24G / 无告警"）自动写进提示词。这是平台给的最优雅的"Agent 实时感知"通道，无需任何唤醒机制。
- **推（受限）**：`agent/inbox/inserted` 是事件（观察用），无公开 API 向主会话 inbox 直接插消息；因此**告警设计为"UI 提示 + 下一步注入 + 工具结果"，而不是强行打断 Agent 回合**。同会话的其他插件行可通过 `ctx.on('lab/alert')` 监听本插件 emit 的事件。

### 3.4 Client 端与 UI 座位（实测 Slot 树 + better-sidebar 契约）
- Client 内建：`ctx / React（无 JSX，用 createElement）/ host / styles / console`；`host.call(method, args)` 是 **Client→Host 包私有 JSON RPC**，Host 用 `harness.handle` 注册。**平台无 Host→Client 事件桥**，实时刷新用 Client 侧 1s 轮询 `host.call('getSnapshot')`（进程内 RPC，开销可忽略）。
- **better-sidebar 0.12.2（本机已装，`~/.dsh/profiles/web/node_modules/dsh-better-sidebar`）**：
  - Client 端 `ctx.provide("betterSidebar", service)`（实测源码 8811 行），外部插件 `ctx.get('betterSidebar')` 后调 `registerTab(descriptor)`，返回 disposer。
  - `TabDescriptor` 契约（实测 d.ts）：`id`（如 `lab:monitor`）、`title`（string **或 thunk——每次渲染重读，可做实时摘要**）、`icon`、`single: true`（单实例）、`badge(ctx, scope, state)`（**tab 角标**：数字=计数/字符串=原样，可显示告警数或 GPU 温度）、`settings`（**声明式开关/数值行/自定义面板**——阈值配置直接复用）、`createTab`、`onOpen/onActivate/onClose`、`component(props)`，props 含 **`visible`（"tab 活跃且面板打开才为 true，否则应暂停"——官方要求的省电模式：不可见即停轮询）**、`scope`（会话作用域）。
  - 官方 add-plugins 页面即宣传"插件通过 ctx.betterSidebar 注册"——这是平台认可的扩展方式。
- **原生兜底座位**：`conversation.view`（list，session 作用域，replaceRisk **none**）——chat(0)/trajectory(10) 同款会话头部 tab 环，注册 `{ id: 'lab.monitor', order: 20, label: 实时 thunk }` 即得一个原生 tab；`tool.view.cordis`（key `self`）可在 run card 内嵌面板，适合 MVP 快速验证。

---

## 4. 推荐架构：消息传递全景图

```
                        ┌────────────────────────────────────────────┐
                        │              Host 半（采样与状态）           │
  nvidia-smi dmon 流 ──►│  timer.interval(1~2s) 采样器                │
  /proc/meminfo,stat ──►│  ring buffer(最近10~30min) + 状态机         │
  ps / 进程表          │  (idle / running / done / alert)            │
                        │                                            │
  平台 hook（监听）：    │       │ emit ctx 事件 lab/experiment-start  │
  tools/pre-execute ───►│       │               lab/experiment-end    │
  tools/result ────────►│       │               lab/alert(分级)       │
  agent/status ────────►│       ▼  （同会话插件行可 ctx.on 监听）      │
  workflow/* ········  │  ┌──────────────────────────────────┐       │
                        │  │ 平衡引擎（纯代码）:              │       │
                        │  │ OOM风险/数据瓶颈/CPU争用/温度功耗墙│       │
                        │  │ → 分级告警 + 建议动作            │       │
                        │  └──────────────────────────────────┘       │
                        └───────┬──────────────┬────────────┬─────────┘
                                │              │            │
                     harness.handle           harness.    systemPrompt.
                     (host.call 服务端)        defineTool  variable('labStatus')
                                │              │            │
                                ▼              ▼            ▼
                      ┌────────────────┐   ┌──────────┐ ┌──────────────────┐
                      │ Client 半      │   │ Agent    │ │ 每个模型步自动注入│
                      │ better-sidebar│   │ lab_status│ │ 实验状态+告警+建议│
                      │ Tab「实验监控」│◄──┤ lab_advice│ │（无需唤醒机制）  │
                      │ 1s 轮询        │   │ lab_ctl   │ └──────────────────┘
                      │ getSnapshot    │   └──────────┘
                      │ visible=false  │
                      │ 时暂停轮询      │
                      └────────────────┘
```

**消息通道清单（按方向与用途）：**

| 通道 | 方向 | 用途 | 实现 |
|---|---|---|---|
| `tools/pre-execute` / `tools/result` | 系统→插件 | 实验起止自动识别、基线快照、危险命令拦截 | `ctx.on` waterfall/emit 监听 |
| `ctx.emit('lab/*')` | 插件→插件 | 实验开始/结束/告警广播（同会话插件行订阅） | 插件自身 emit |
| `host.call('getSnapshot')` | UI→Host | 1s 轮询快照、历史曲线、进程表 | Client `host` 内建 + Host `harness.handle` |
| `host.call('setThresholds'/'startMonitor')` | UI→Host | 阈值设置、启停 | 同上 |
| `harness.defineTool` | Host→Agent | `lab_status/lab_advice` 按需查询 | 动态工具注册 |
| `systemPrompt.variable` | Host→Agent | 每步自动注入状态摘要 | prompt 变量 provider |
| `webServer.register`（可选） | Host→外部 | SSE `/lab/events`，手机端或与 monitor-panel 集成 | HTTP 路由 |
| `llm/stream`（可选） | 系统→插件 | 计量 Agent 回合自身 GPU 消耗 | waterfall 环绕 |

**关键设计决策：**
1. **实验生命周期自动钩接**：监听 bash 工具的 pre-execute（命令匹配训练/推理脚本关键词）→ 记基线、置 running；tools/result 后 → 置 done、汇总曲线。用户无需手动开关；另提供 UI 手动启停兜底。
2. **平衡引擎是代码不是 LLM**：显存余量 <阈值 + 利用率低 → "OOM 风险，建议降 batch/关其他进程"；GPU 利用率低 + CPU 100% → "数据加载瓶颈，建议加 num_workers"；温度/功耗接近墙 → "降频风险"；多 GPU 负载不均 → "调度建议"。每条建议带置信度与可执行动作，由 Agent 决定是否执行。
3. **UI 性能纪律**：`visible=false` 停轮询；dmon 后台流替代每秒 fork；ring buffer 封顶；badge/title 用 thunk 保持廉价。
4. **告警不打断 Agent**：分级（critical/warning/info）→ tab 角标 + 面板提示 + 下一模型步注入；critical 可经 `approval/request` 式交互或直接 UI 闪烁。

---

## 5. 可视化落地对比（用户已定 sidebar 自定义 tab）

| 方案 | 位置 | 优点 | 缺点 |
|---|---|---|---|
| **better-sidebar 第三方 Tab（首选）** | 侧边栏工作台（本机已装 0.12.2） | 正是"sidebar 自定义 tab"；`title`/`badge`/`settings`/`visible` 全齐；与文件/终端/Git 并列；官方认可扩展方式 | 依赖第三方插件（曾有 dsh-full-remote 冲突史）；契约随版本演进，需锁版本 |
| `conversation.view` 原生 tab（兜底） | 会话头部 tab 环（chat/trajectory 同款） | 零第三方依赖；replaceRisk=none；label thunk 实时 | 在中间列头部而非左侧栏 |
| `tool.view.cordis`（MVP 过渡） | run card 内嵌 | 最快验证采样+RPC 链路 | 区域小、随 run card 生命周期 |
| 可选增强 | `conversation.composer.dock` | 会话底部常驻迷你状态条 | 信息密度有限 |

推荐组合：**MVP 用 tool.view.cordis 验证链路 → 正式做 better-sidebar Tab（主）**，必要时同时注册 conversation.view 兜底；badge 显示告警数/温度，title 显示一行摘要（"GPU0 92%·20.1/24G·3 告警"）。

---

## 6. 实施路线图

- **MVP（动态 Cordis 插件，本会话内跑通）**
  - P0 Host：dmon 流采样 + /proc 内存/CPU + ring buffer + `getSnapshot` RPC
  - P0 Client：better-sidebar 注册「实验监控」Tab，1s 轮询渲染 GPU/CPU/内存卡 + 进程表 + 迷你趋势
  - P1 Host：`tools/pre-execute`/`tools/result` 生命周期钩子 + 状态机
  - P1：平衡引擎（OOM/瓶颈/温度/均衡 4 类诊断）+ `lab_status`/`lab_advice` 工具 + `systemPrompt.variable` 注入
  - P2：分级告警 + tab badge/title 实时化 + settings 阈值面板 + 历史曲线导出（实验复盘）
- **v2（生产化）**：从动态插件沉淀为正式插件（宿主组合行或 npm 包，monitor 服务共享、跨会话）；叠加自定义 Agent 预设"实验指挥"（persona + 决策规则 + 插件工具使用指引）
- **v3（可选）**：Agent-teams 并行编排（超参扫描/多 trial），captain 依据 `lab_advice` 调配共享 GPU 池

---

## 7. 风险与边界

- **WSL GPU 监控**：WSL2 下 `nvidia-smi`/`dmon` 可用（依赖 Windows 驱动）；跨机实验（用户有 monitor-panel 远程经验）暂不做，v2 再通过 webServer/agent 通道扩展。
- **动态插件进程内临时性**：重启即失 → 生产化必须转正式插件/预设行（符合 `editing-cordis-compositions` 平面规则：预设内发布服务需 `cordis:group`+`isolate`）。
- **无 process/require**：/proc 读取只能经 shell 服务（dmon 长驻流 + 低频 ps 快照）。
- **只建议不越权**：插件不杀实验进程，仅告警与建议；执行动作由用户/Agent 显式完成。
- **采样开销**：1s dmon 流开销极小；避免高频 fork 子进程；ring buffer 限内存。
- **better-sidebar 版本耦合**：锁版本测试；预留 conversation.view 兜底路径。
