# Lab Monitor 完整实施计划（t3）

> **归档注记（2026-08-20 清理）**：本文所述 v1.4.5 MVP 资产（`plugin/` 动态版、`scripts/dev-run.sh`、`lab-monitor.define.json`）已归档至 `docs/archive/v1.4.5-plugin/`。

> 制定人：architect（方案架构师）｜日期：2026-08-18（v1.1 修订：2026-08-18，t4 评审后）
> 输入：output-t1-external.md（外部 12 条借鉴）、output-t2-assets.md（内部复用清单）、output-t2b-better-sidebar.md（Tab 契约实证）、docs/t8-lab-monitor-architecture.md（总架构基线）、output-t4-review.md（22 条评审问题）
> 状态：v1.1 修订版（t4 评审「有条件通过」，6 条高严重度已闭合，见 §9 修订记录）
> 红线遵守：未调用任何 client 平台 inspect；全部输入经 read 读取

---

## 0. 项目定位（一句话）

**Lab Monitor = 科研实验监控助手**：本机、秒级、进程内、零 token 的实时监控骨架，为 DSH 里的科研/训练实验提供「采样 → 状态 → 诊断 → 告警 → UI/Agent 感知」闭环。

三层组合（t8 §2 结论，MVP 只做第 1 层）：

| 层 | 载体 | 角色 | 阶段 |
|---|---|---|---|
| 骨架层 | **Cordis 插件（Host+Client 双半）** | 采样/状态/告警/UI/桥 | **MVP + v2** |
| 指挥层 | Agent 预设「实验指挥」 | persona + 决策规则 + 工具使用指引 | v2 |
| 编排层 | Agent-teams | 多实验并行/超参扫描、共享 GPU 池调配 | v3（可选） |

与 monitor-panel 互补不重叠：monitor-panel = 远程多机、30s 级、HTTP 轮询；Lab Monitor = **本机、秒级、进程内**（t2 §1 接口/边界）。

---

## 1. 项目目录结构

项目路径：`/home/dc/projects/lab-monitor/`（根目录已创建）。

```
/home/dc/projects/lab-monitor/
├── README.md                        # 总览：定位、架构图、快速开始；★注明依赖声明事实来源（T3-2：
│                                    #   MVP 以源码内对象 inject 为事实来源，package.json 仅 v2 启用）
├── plugin/                          # ★ Cordis 插件源码（MVP 动态插件与 v2 正式插件同源）
│   ├── host/                        # —— Host 半（运行于 DSH Node 进程）——
│   │   ├── index.js                 # ★ MVP 单文件（T1-3 决策）：即 cordis_define 的 code.host 函数体；
│   │   │                            #   内部按模块分区注释（collector/ring/state/balancer/hooks/rpc/tools/
│   │   │                            #   prompt 为顶层函数声明 + 顺序敏感初始化区，共享函数体作用域）
│   │   └── modules/                 # （v2 启用）拆分后的 8 个模块文件，与 MVP 分区同名
│   ├── client/                      # —— Client 半（运行于浏览器页面）——
│   │   └── index.js                 # ★ MVP 单文件：registerTab「实验监控」+ badge/title/settings/轮询组件
│   ├── package.json                 # v2 正式插件元数据（dsh.bundle.patch + dsh.client.inject；★MVP 不生效，T3-2）
│   └── cordis.patch.yml             # v2 挂载行（bundle 协调写入 dsh.profile.bundles）
├── agent-preset/                    # v2「实验指挥」Agent 预设（放 ~/.dsh/.agent-presets/ 的副本源；★v2 启用，
│                                    #   MVP 阶段不实现——T3-3）
│   └── lab-commander/
│       ├── persona.md               # 角色：实验指挥官（解读指标、决策下一步）
│       ├── RULES.md                 # 决策规则：何时查 lab_status、采纳 lab_advice 的判据
│       └── tools.md                 # 插件工具使用指引（lab_status/lab_advice/lab_ctl 用法）
├── scripts/
│   ├── verify.sh                    # CI 式自测：node --check 语法 + 目录完整性 + 契约静态核对
│   └── dev-run.sh                   # MVP：读取单文件源码 → 组装 cordis_define 参数（code.host/code.client）
│                                    #   → node --check 校验后输出（T1-3：确定性组装，禁 import/export）
├── docs/
│   ├── 01-architecture.md           # 架构基线（从 t8 同步 + 本计划定稿）
│   ├── 02-data-model.md             # 指标常量枚举 / ring buffer 格式 / 状态机转移表 / 告警分级
│   ├── 03-protocol.md               # host.call RPC 契约（方法名 + JSON schema 版本化）
│   └── 04-milestones.md             # P0/P1/P2 验收清单（可勾选，CI 自测点记录）
└── .gitignore                       # node_modules/ 等
```

**MVP → v2 演进原则（目录一次到位，代码渐进成型）**：

| 维度 | MVP（本会话内验证） | v2（生产化） |
|---|---|---|
| 加载方式 | `cordis_define` 动态插件（会话级，**单文件函数体**：plugin/host/index.js 与 plugin/client/index.js 读出即为 code.host/code.client，经 dev-run.sh 组装 + node --check；**P0 前先跑最小样例验证 cordis_define 装载大函数体可行**——T1-3） | 正式插件：npm 包（bundle 双半 + cordis.patch.yml）或本机 profile 预设行（`cordis:group` + `isolate: true` 包服务），跨会话共享；host 半拆回多文件（t2 §3 边界） |
| 生命周期 | 进程重启即失效 → 重启后重新 define（源码即文件，零丢失） | 随 DSH 组合行常驻 |
| Agent 预设 | 不启用 | agent-preset/lab-commander 挂载为指挥层 |
| 远端扩展 | 不做 | webServer SSE `/lab/events`（手机端 / 对接 monitor-panel，t2 §1 可选） |

---

## 2. 技术方案总览（四通道消息流）

```
┌────────────────────────────── Host 半（DSH Node 进程）──────────────────────────────┐
│                                                                                      │
│  timer.interval(2s) ──► collector.js ──► ring-buffer(≤1000点) ──► 最近快照 last       │
│  shell.start(dmon)  ──►   (GPU/CPU/内存/进程)      │                 │                 │
│  /proc 经 shell 读取 ──►                          ▼                 ▼                 │
│                                     state-machine.js        balancer.js(纯代码)       │
│  hooks.js: tools/pre-execute│result ──► 实验起止/crash 判定     4 类诊断→分级告警+建议   │
│                                      └────────────┬──────────────┘                    │
│                                                   ▼                                   │
│                                     ctx.emit('lab/experiment-start|end|alert')        │
│   ┌──────────────┬──────────────────┬───────────────────────┬───────────────┐        │
│   ▼              ▼                  ▼                       ▼               ▼        │
│ rpc.js        tools.js           prompt.js             webServer(可选)   Agent 预设   │
│ harness.     harness.           systemPrompt.         SSE /lab/events    (v2 消费     │
│ handle        defineTool         variable             → 手机/monitor-    工具+注入)   │
│ (host.call    lab_status/        ('labStatus')        panel 对接          │           │
│  服务端)       lab_advice       每模型步注入            (P2 后可选)         │           │
│   ▲            lab_ctl              │                                         │       │
└───┼────────────────────────────────┼─────────────────────────────────────────┼───────┘
    │ host.call(5s 轮询)             │ 每步自动注入（无需唤醒机制）              │
    ▼                                ▼                                         ▼
┌───────────── Client 半（浏览器页面）─────────────┐   ┌──────┐          ┌──────────────┐
│ better-sidebar registerTab('lab-monitor:gpu')   │   │ 平台  │          │  Agent 主会话 │
│  ├─ badge：告警计数（只读模块级快照，O(1)）        │   │ hook  │          │  （LLM 回合） │
│  ├─ title thunk：一行摘要                        │   │ 系统  │          │               │
│  ├─ settings pluginToggles：阈值面板             │   │ →插件 │          │               │
│  └─ component：visible=true 时 5s 轮询渲染       │   │ 通道  │          │               │
│      visible=false → 停轮询（零开销）             │   │      │          │               │
└─────────────────────────────────────────────────┘   └──────┘          └──────────────┘
  兜底：conversation.view 原生 tab（better-sidebar 缺席/注册失败时启用）
```

**四条消息通道清单**（每通道：方向｜用途｜实现）：

| # | 通道 | 方向 | 用途 | 实现 | 来源 |
|---|---|---|---|---|---|
| 1 | **生命周期 hook** | 系统→插件 | 实验起止自动识别、基线快照、危险命令拦截 | `ctx.on('tools/pre-execute', waterfall)` + `ctx.on('tools/result', emit)` | t8 §3.2 |
| 2 | **RPC 拉取** | Client→Host | UI 快照/历史/阈值/启停 | Client `host.call` + Host `harness.handle`（只驮 JSON） | t5 结论② |
| 3 | **工具桥 + prompt 注入** | Host→Agent | 按需查询（lab_status/lab_advice）+ 每步自动注入状态摘要 | `harness.defineTool` + `systemPrompt.variable` | t8 §3.3 |
| 4 | **插件内事件** | 插件→插件 | 实验开始/结束/告警广播（同会话插件行订阅） | `ctx.emit('lab/*')` + `ctx.on` | t8 §4 |

**关键设计决策**（t8 §4 定稿）：
1. 实验生命周期自动钩接（命令匹配训练关键词 → 自动进入实验模式），UI 手动启停兜底；
2. 平衡引擎是**代码不是 LLM**（确定性、零 token、可测）；
3. UI 性能纪律：`visible=false` 停轮询、dmon 长驻流替代每秒 fork、ring buffer 封顶、badge/title thunk 保持 O(1)；
4. 告警**不打断 Agent**：分级告警 → tab 角标 + 面板提示 + 下一模型步注入（平台无 Host→Client 事件桥、无公开 inbox 推送 API，t8 §3.3 已实证）。

---

## 3. 技术方案细节

### 3.1 Host 半（模块 × 输入/输出）

#### collector.js —— 采样器
| 项 | 内容 |
|---|---|
| 输入 | `timer.interval(2000ms)` tick（inject 声明 `timer`）；`shell` 服务 |
| 采集 | ① GPU：`shell.start({ command: 'nvidia-smi dmon -d 1 ...' })` **长驻流**，`ShellProcess.readOutput()` 增量读（比每秒 fork nvidia-smi 廉价，t8 §3.1 推荐模式）；② 内存/CPU：经 shell 一次性 cat `/proc/meminfo`、`/proc/stat`（无 process/require 内建，t2 §2）；③ 进程表：`ps` 低频（5s）快照 |
| 输出 | 每采样点 `{ ts, gpu:[{id,util,memUsed,memTotal,temp,power}], cpu, mem, procs:[] }` 追加进 ring buffer；同时写模块级 `lastSnapshot` |
| 降级 | 启动时探测 `nvidia-smi` 是否存在：缺失 → GPU 区标记 `unavailable`，CPU/内存/进程照常工作（WSL 无 GPU 场景可验收）；**运行中自愈（T1-4）**：每个采样 tick 检测 dmon 流 EOF/超时无新行（WSL2 驱动重置等致进程退出）→ 指数退避重启（1s→2s→4s，≤3 次/5min）→ 连续失败回退 query-gpu 快照模式，快照标 `gpu.degraded: true`，恢复后回到 dmon 流 |

#### ring-buffer.js —— 环形缓冲
| 项 | 内容 |
|---|---|
| 输入 | collector 采样点 |
| 容量 | **双条件封顶**：≤1000 点 且 ≤30 分钟（2s 采样 ≈ 900 点，~2MB 上限，t8 §7 采样开销纪律） |
| 输出 | `history(since, bucketMs)`：按桶降采样（借鉴 monitor-panel 查询时降采样策略，t2 §1）→ 图表数据 |

#### state-machine.js —— 实验生命周期状态机
| 项 | 内容 |
|---|---|
| 状态 | `idle / running / done / crashed / alerting`（t1 启示 4：W&B run.finish 检测 + MLflow 状态机） |
| 输入 | hooks.js 事件（start/execute 回传/end）、ps 进程表（5s，pid 存活）、采样快照 |
| 判定 | ① start：pre-execute 匹配训练命令（**关键词表含** `python train*.py`/`python -c`/`python3 -c`/`torchrun`/`deepspeed`/`python -m`，T4-1）→ 记 `{runId, cmd特征, startTs, baseline}`（**此刻无 pid**，T1-1）、置 running；② **pid 关联（T1-1 完整链路）**：首选 `tools/execute`（执行时事件）回传句柄/pid；否则 ps 快照（5s）按「cmdline 含命令特征 且 startTs 之后出现」关联回填；**关联失败降级**：running 且「ps 连续 ≥3 个采样间隔（15s）观测到无候选进程 且无配对 result」→ 超时判 crashed；③ done（T1-2 配对）：tools/result **配对校验**——工具名=bash 且命令串含 runId 特征（或平台调用 ID 配对），不匹配的 result **忽略**；done 需**双确认**（配对命中 且 实验进程已消失），否则按异常结束处理；④ **crashed：running 中 pid 消失（连续 ≥2 个 ps 周期=10~15s 无存活）且无配对 result** → 置 crashed + 告警（kill 实验进程走此路径，**kill 自身的 result 因不配对被忽略，不得误判 done**）；⑤ alerting：平衡引擎触发 critical 时置位，恢复后回 running；**单实验跟踪约束（R-2）**：running 期间新 start 命中 → 旧 run 自动归档 aborted，无双 running 并存 |
| 输出 | 实验记录数组 + `ctx.emit('lab/experiment-start|end')` |

#### balancer.js —— 平衡引擎（纯代码规则）
| 项 | 内容 |
|---|---|
| 输入 | 最近 N=10s 快照窗口 + 当前实验上下文 + **当前生效阈值（host 侧持有：来自 rpc 请求携带的 thresholds 参数，setThresholds 为后备直连通道，T2-1）** |
| 规则 | 4 类诊断（t8 §4 决策 2）：① **OOM 风险**：显存余量 < 阈值 且 util 高 → 建议降 batch/关其他进程；② **数据瓶颈**：GPU util 低 且 CPU 100% → 建议加 num_workers；③ **温度/功耗墙**：temp/power 接近墙 → 降频风险提示；④ **多 GPU 负载不均**：调度建议 |
| 输出 | `{level: info|warn|critical, rule, msg, confidence, actions:[]}`；`ctx.emit('lab/alert', ...)` |
| 防抖 | 阈值需**持续 10s** 才触发（Prometheus `for:` 模式，t1 启示 3）；同类告警最小间隔 5 分钟（W&B wait_duration 模式）；分级 INFO/WARN/CRITICAL |

#### hooks.js —— 生命周期钩子
| 项 | 内容 |
|---|---|
| 输入 | 平台事件 `tools/pre-execute`（waterfall，可拦/改/放行，t2 §2 实证）、`tools/result`（emit）、`tools/execute`/`tools/post-execute`（waterfall） |
| 逻辑 | `tools/pre-execute`（waterfall，派发前）：匹配训练命令 → 调 state-machine.start（**只记 runId/cmd 特征/startTs，无 pid**，T1-1）；**显存余量 < 需求 → 可选阻断**（waterfall 拦截 + 提示，t1 启示 5）；`tools/execute`（执行时）：回传句柄/pid 供 state-machine 关联（T1-1 链路②）；`tools/result`（emit）：**配对校验后**调 state-machine.end（T1-2：工具名=bash 且命令串含 runId 特征；不匹配忽略） |
| 输出 | state-machine 调用、`ctx.emit('lab/experiment-start|end')` |

#### rpc.js —— harness.handle 注册（Client 轮询服务端）
| 方法 | 输入 | 输出 |
|---|---|---|
| `labMonitor.snapshot` | `{ thresholds? }`（**T2-1 决策①「轮询携带阈值」**：client 从 pluginSettings 读出随请求上传，host 以请求参数为准 → 天然 ≤1 轮询周期生效） | `{ ts, gpu[], cpu, mem, procs[], alerts[], alertsCriticalCount, experiment, callCount }`（`alertsCriticalCount`=host 预算的 CRITICAL 计数，badge 直读，T2-2；`callCount`=host 侧 RPC 调用计数器，供 P0 验收 2 断言，T4-2；`gpu.degraded` 随 gpu[] 携带；JSON 纯数据） |
| `labMonitor.history` | `{ sinceMs, bucketMs }` | 降采样后的时间序列 |
| `labMonitor.setThresholds` | `{ util, memPct, temp, pollMs }` | `{ ok, applied }`（v2/兜底直连通道；MVP 以请求参数为准） |
| `labMonitor.control` | `{ action: 'start'\|'pause'\|'resume' }` | `{ ok, state }`（**护栏 T2-5：仅控制监控/告警引擎，绝不触碰实验进程**） |

#### tools.js —— harness.defineTool（Agent 按需查询）
| 工具 | 输出 |
|---|---|
| `lab_status` | Agent 友好快照文本/JSON（同 snapshot） |
| `lab_advice` | 平衡引擎当前建议（分级 + 置信度 + 可执行动作） |
| `lab_ctl`（可选） | 启停/阈值控制（**护栏 T2-5**：仅监控/告警引擎启停，绝不碰实验进程；写操作工具描述明示风险；pause 类限 UI 或 approval/request 确认） |

#### prompt.js —— systemPrompt.variable 注入
| 项 | 内容 |
|---|---|
| 输入 | 最近快照 + 告警 + 实验状态（每模型步重新解析，t8 §3.3） |
| 输出 | 注入段示例：`[Lab Monitor] GPU0 92% · 20.1/24G · CPU 340% · 实验 train-v3 (running 12min) · 告警: 无` |
| 约束 | 摘要 ≤ 1 行、O(1) 生成；这是"Agent 实时感知"主通道（无需唤醒机制）；**注入开关用 Host `settings` 服务或 rpc 控制字段承载（Host 无 process.env，T1-6）** |

### 3.2 Client 半（better-sidebar Tab）

#### 注册骨架（t5 结论① 对象形态，动态插件合法姿势）
```js
return {
  inject: ['betterSidebar', 'timer'],          // 硬依赖；guard 门面属性访问必须声明
  apply(ctx) {
    ctx.effect(() => ctx.betterSidebar.registerTab({
      id: 'lab-monitor:gpu',                    // 命名空间前缀+冒号（t5 落地建议 1）
      title: () => 'GPU 监控',                   // 静态 thunk 最稳；动态时 O(1) 读快照
      icon: (size) => createElement(...),        // 简洁图标
      order: 90,
      single: true,                              // 单实例（dedupeKey 糖）
      badge: () => { try { return last ? (last.criticalCount || null) : null }
                     catch (e) { console.error('lab-monitor badge', e); return null } },  // ★只读 last；
      // ★R-4：thunk 抛错被 better-sidebar 吞掉，try/catch + console.error 保证可观测
      settings: {
        pluginToggles: {                         // v0.12.0+ 插件自有键，持久化 pluginSettings[id]
          utilWarn:  { type: 'number', min: 0, max: 100, unit: '%',  def: 90 },
          memWarn:   { type: 'number', min: 0, max: 100, unit: '%',  def: 95 },
          tempWarn:  { type: 'number', min: 0, max: 120, unit: '°C', def: 85 },
          pollMs:    { type: 'number', min: 1000, max: 60000, unit: 'ms', def: 5000 },
          autoPoll:  { type: 'switch', def: true },
        },
      },
      onOpen: () => refresh(),                   // 打开即拉一次快照（体验优化）
      onActivate: () => refresh(),
      component: (props) => createElement(MonitorPanel, props),
    }))
  },
}
```

#### 轮询 + visible 暂停 + 低频保活（t5 结论② 核心模式 + T2-2/T2-3 修订）
```js
const { useState, useEffect } = React            // ★T1-5：统一从 React 解构，不裸用顶层名
let last = null                                   // 模块级最近快照（badge/title 只读源）
let lastFetchAt = 0

async function refresh() {
  try {
    const thresholds = readPluginSettings()       // T2-1：从 pluginSettings 读出阈值随请求携带
    const snap = await host.call('labMonitor.snapshot', { thresholds })
    last = { ...snap, criticalCount: snap.alertsCriticalCount, ts: Date.now() }
    return snap
  } catch (e) {
    return { error: true }                        // T2-3：失败标记，不抛到渲染层
  }
}

function MonitorPanel({ visible }) {
  useEffect(() => { loadOnce() }, [])
  // 渲染轮询：仅 visible 时 5s（可配 pollMs）
  useEffect(() => {
    if (!visible) return                          // ★ tab 失活/面板收起 → 零渲染轮询
    const dispose = ctx.setInterval(() => { refresh().then(setState) }, pollMs)
    return () => dispose()                        // visible 变 false / 卸载 → 清理
  }, [visible, pollMs])
  // 低频保活通道（T2-2 决策①）：visible=false 时降频 30s（可配），仅拉 snapshot 更新 last、不渲染 DOM
  useEffect(() => {
    if (visible) return
    const dispose = ctx.setInterval(() => { refresh() }, 30000)
    return () => dispose()
  }, [visible])
  // host.call 失败退避（T2-3）：refresh 连续失败 → 指数退避 5s→10s→30s 封顶，
  // UI 显示「连接中断，重试中」；恢复后立即刷新一次并复位退避
}
```
- **禁用 `window.setInterval`**：浏览器 timer 全局被 guard 遮蔽（t5 教学陷阱 TIMER_REDIRECT），必须 `inject: ['timer']` 用 `ctx.setInterval`；
- badge 由模块级 `last` 驱动：数字 = **CRITICAL 告警计数**（99+ 自动封顶），null 隐藏（t5 落地建议 2）；
- title 动态化可选：忙时加 `●`，必须 O(1)（t5 落地建议 3）；
- **features 能力门控**（t5 落地建议 6）：`ctx.betterSidebar.features.includes('badge')` 才注册 badge、`'pluginSettings'` 才注册 settings —— 兼容旧版本不炸；
- 生命周期回调仅 service 路径触发（t5 §1.2），只做体验优化不承载状态。

#### 兜底：conversation.view 原生 tab（t8 §3.4 + T1-7 修订）
- 触发条件与互斥顺序（T1-7）：`ctx.get('betterSidebar') === undefined` **或** registerTab 抛错 → 自动切兜底；与 registerTab **互斥**（只注册其一，防双注册重复渲染）；better-sidebar 恢复（重载后）以 registerTab 优先；
- 实现：`const slots = ctx.get('slots'); if (slots) ctx.effect(() => slots.register({ name:'conversation.view', id:'lab.monitor', order:20, label: thunk }, ...))`（slots 需 ctx.get 判空 + ctx.effect 包裹，replaceRisk none），会话头部 tab 环；
- 数据通道不变（host.call 轮询），仅 UI 座位不同。

### 3.3 消息流完整性检查（t4 评审维度 2 的预答）

| 闭环场景 | 通道组合 |
|---|---|
| 实验开始 | hooks(pre-execute) → state-machine → emit lab/experiment-start → prompt 注入（下一步） |
| 实验崩溃 | state-machine(crashed) → emit lab/alert → badge 计数 + 面板 + 下一模型步注入 |
| UI 实时刷新 | host.call(snapshot, 5s) ← rpc.js（进程内 RPC 开销可忽略，t2 §2） |
| Agent 主动查询 | defineTool lab_status/lab_advice ← tools.js |
| 告警不打断 | 无推送 API → UI + 下一步注入 + 工具结果三路闭环（t8 §3.3 设计决策） |
| 阈值生效 | pluginSettings → 轮询请求携带 → host 以请求参数为准（≤1 轮询周期生效，T2-1） |

---

## 4. MVP 里程碑（P0 → P1 → P2，各带可测量验收）

### P0「能看」：采样 + RPC + Tab 渲染（动态插件最小闭环）
- 交付：collector + ring-buffer + rpc.snapshot + client Tab（GPU/CPU/内存卡 + 进程表 + 色条）
- 验收标准（全部可测量）：
  1. Tab 显示 ≥1 张 GPU 卡（util/显存/温度/功耗色条）+ CPU/内存 + 进程表；**比较方法（T4-3）**：同秒内先后取 dmon 行解析值与 `nvidia-smi --query-gpu` 快照比较，≥3 个采样点均值偏差 < 5%；
  2. 5s 轮询刷新；**visible=false → 零渲染轮询，仅低频保活 ≤1 次/30s 更新 last（T2-2 决策①）**；**断言手段（T4-2）改为 host 侧计数**：rpc.js 内置 `callCount` 计数器经 snapshot 字段暴露，client refresh 打 debug 日志，对照「visible=false 期间 callCount 增量 ≤ 30s 一次」；
  3. 无 GPU 环境（nvidia-smi 缺失）→ GPU 区显示 unavailable，CPU/内存正常，**不抛错不挂起**；
  4. **dmon 自愈（T1-4）**：kill 后台 dmon 进程 → 30s 内自动重启恢复采集，且 `gpu.degraded` 期间 UI 有降级提示；
  5. **重复激活断言（R-1）**：同一插件被重复 define/激活 → 无崩溃、无重复 UI；同名工具重复 defineTool 行为（报错/覆盖/忽略）实证并记录进 04-milestones.md；
  6. `cordis_inspect_self(pluginId, packageId)` 无 diagnostics；停止插件后采集与 UI 全部随 fiber 清理（无残留 interval/进程）。

### P1「能懂」：生命周期钩子 + 状态机 + 平衡引擎 + 工具 + prompt 注入
- 交付：hooks + state-machine + balancer + tools + prompt
- 验收标准：
  1. **验收命令固化（T4-1）**：用 `python train_demo.py` 形态命令（关键词表已含 `python train*.py`，并加入 `python -c`/`python3 -c` 覆盖内联形态）→ 状态机自动 running（pre-execute 命中）；`kill <pid>` 实验进程 → **≤15s 内判 crashed**（ps 间隔 5s，连续 ≥2 周期无存活 = 10~15s，T1-1 对齐）并出 CRITICAL 告警；**kill 自身的 tools/result 不得误判 done（T1-2 配对校验断言）**；
  2. 正常结束的命令 → done（**配对命中 + 进程消失双确认**），实验记录含资源曲线摘要（>30min 实验摘要标注「部分数据」，R-3）；
  3. `lab_status` 工具被 Agent 调用返回正确 JSON；`lab_advice` 在构造的「显存余量 <10% + util 95%」场景下返回 OOM 风险建议（置信度+动作）；
  4. **提示词中出现注入摘要**：下一次模型步的 system prompt 含 `[Lab Monitor]` 段且数据为当前快照（会话内人工核对）；
  5. 平衡引擎 4 类规则各构造场景触发一次，告警含分级字段；
  6. **emit 可测点（T2-4）**：插件内自监听或临时观测行断言 `lab/experiment-start|end|alert` 按状态机转移发出（console 日志断言）；
  7. **并发单跟踪约束（R-2）**：同时跑两条实验命令 → 只跟踪其一（新 start 命中时旧 run 自动归档 aborted），无双 running 并存。

### P2「能管」：分级告警 + badge/title 实时 + settings 阈值面板 + 历史曲线
- 交付：告警防抖/静默、badge/title 实时化、pluginToggles 面板、history 曲线
- 验收标准：
  1. util > 阈值（如 90%）**持续 10s** → host `alertsCriticalCount` +1 且同类告警 5 分钟内不重复（日志断言）；**badge 更新（T2-2 决策①）**：用户**不在看 tab**（visible=false）时，低频保活 30s 内 badge 角标出现新计数（依赖 last 更新，不渲染 DOM）；badge 在 100 个告警时显示 `99+`（封顶断言）；
  2. settings 面板改阈值（如显存 95→50）→ **≤1 轮询周期生效（T2-1 决策①：请求携带阈值，host 为准）**；**持久化断言步骤（T4-4）**：重开页面 → `pluginSettings['lab-monitor:gpu']` 仍在 → 重新 define 后阈值生效（MVP 跨会话保留依赖 better-sidebar prefs 文档，非插件自身）；
  3. 历史曲线渲染 ≥30 分钟数据（降采样 ≤500 点）；关闭 tab 后 host 采集不中断（告警引擎独立于 UI 可见性，t1 启示 9；UI badge 感知由 30s 保活兜底）；
  4. **thunk 健壮性（R-4）**：badge/title thunk 抛错 → 不白屏且有 console.error 日志（better-sidebar 吞异常前提）；better-sidebar 缺失时 conversation.view 兜底 tab 正常显示同数据。

---

## 5. 团队协作方案（开发阶段）

### 5.1 角色划分与任务包
| 角色 | 负责模块 | 对应任务包 |
|---|---|---|
| **采样器工程师** | collector + ring-buffer + rpc.snapshot | D-A（P0 前半） |
| **UI 工程师** | client Tab + 轮询 + badge/settings | D-B（P0 后半，依赖 D-A 的 RPC 契约） |
| **引擎工程师** | state-machine + balancer + hooks | D-C（P1，依赖 P0 全部） |
| **集成工程师（队长/主会话）** | tools + prompt + 验收 + cordis_define/run | D-D（P1 后半）→ D-E（P2 收尾） |

### 5.2 任务依赖图与并行度
```
t3(本计划) ──► P0: D-A(采样器) ──┬──► D-C(引擎: 状态机+平衡+hooks) ──► D-D(工具+prompt)
                                  └──► D-B(UI: tab+轮询) ──────────────┘        │
                                                    D-E(P2: 告警+badge+settings+曲线) ◄─┘
```
- **并行度**：D-A 与 D-B 可**并行**（前提：rpc.js 的 snapshot JSON schema 先在 docs/reference/protocol.md 冻结，作为两任务共同契约）；D-C 依赖 P0 两者；D-D 依赖 D-C；D-E 依赖 D-D。
- 并行上限 2 个实现任务（避免对同一文件/同一会话冲突；host/client 分属两文件可解耦）。
- 每里程碑末尾一个**验收任务**（队长或 reviewer 执行，接 §4 验收清单）。

### 5.3 普通子代理 vs 团队成员选用原则
| 场景 | 选用 |
|---|---|
| 单个模块实现（写死一个文件、无跨任务协调） | **普通 subagent**（背景任务、上下文独立、失败重派成本低） |
| 需要跨模块协调/复用上下文（如集成、契约冻结） | **团队成员**（durable 续跑、inbox 消息）或队长主会话 |
| 计划/评审类 | 团队成员（本次 t3/t4 模式，验证有效） |
| 跨会话长期职责（如"引擎维护者"） | 团队成员 |

### 5.4 红线纪律（随任务描述逐条下发，成员看不到队长对话——t2 §4 教训）
1. **严禁 `cordis_inspect_query(platform=client)`**——子代理环境永久挂起（本轮两次卡死根因，t2 §4 教训 1）；
2. 只允许 read/grep/bash 读文件；`cordis_define`/`cordis_run`/`cordis_stop` 只由**队长主会话**执行（子代理只产出源码文件）；
3. Host/Client 源码**纯 JavaScript**（无 TS/JSX/import/require；Client 用 React.createElement；**React hooks 统一 `const {useState,useEffect}=React` 解构或 `React.useEffect`，不裸用顶层名——T1-5**）；禁 window.setInterval（timer 服务替代）；
4. 输出必须有明确文件路径 + 完成标记 + 摘要回报；
5. 成员默认 flash 模型长任务可能超时中断：任务按模块拆分 ≤1 文件/次，中断后 send_message 续跑（durable），连续踩坑换人（t2 §4 教训 2/3）。

### 5.5 CI 式自测点
- **每次 cordis_define 后**：`cordis_inspect_self(pluginId, packageId)` 确认无 diagnostics（队长执行）；
- **每次里程碑结束**：① `scripts/verify.sh`（node --check 全部 js、目录完整性、契约文件存在）；② 会话内跑 §4 验收清单（docs/reference/milestones.md 勾选）；③ 结果回报队长；
- **回归红线**：改 client 半后重 define + 重跑 P0 验收 1/2/5（轮询与 visible 暂停、重复激活不回归）；**断连自愈回归（T2-3）**：插件重启/页面刷新后轮询自动恢复（退避重试 + 恢复立即刷新）。

---

## 6. 风险与回滚

| # | 风险 | 等级 | 缓解 / 回滚 |
|---|---|---|---|
| 1 | **better-sidebar 版本耦合**（0.12.2，契约随版本演进，曾有 dsh-full-remote 冲突史，t8 §7） | 高 | 锁版本测试；`features` 门控降级；**兜底 conversation.view**；回滚 = registerTab 失败分支自动切兜底 |
| 2 | **动态插件进程内临时性**（重启即失效，t2 §3 边界） | 中 | 源码即文件（零丢失），重启后重 define；v2 转正式插件/预设行；回滚 = `cordis_stop` 即回到无监控状态，无持久副作用 |
| 3 | **WSL GPU 场景缺失/驱动差异 + dmon 运行中中断**（nvidia-smi 不存在、字段差异、WSL2 驱动重置致 dmon 退出） | 中 | collector 启动探测 + `unavailable` 降级（P0 验收 3）；**运行中自愈（T1-4）**：EOF/超时检测 → 指数退避重启（≤3 次/5min）→ 回退 query-gpu 快照模式 + `gpu.degraded` 标记（P0 验收 4）；dmon 字段解析容错；CPU/内存监控不受影响 |
| 4 | **采样开销失控**（每秒 fork nvidia-smi、ring buffer 无界） | 中 | dmon 长驻流替代 fork（t8 §7）；ring buffer 双条件封顶（≤1000 点 / ≤30 分钟）；visible=false 停轮询；5s 轮询间隔下限 1s 可配 |
| 5 | **Client guard 限制**（属性访问需 inject 声明、timer 全局遮蔽、host.call 只驮 JSON） | 中 | 按 t5 结论①/② 的规范形态书写（对象形态 + inject 声明 + ctx.setInterval + 纯 JSON 载荷）；验收含"停止后无残留"断言 |
| 6 | **告警风暴** | 中 | 阈值持续 10s + 同类最小间隔 5 分钟 + 分级（t1 启示 3）；静默窗口 v2 |
| 7 | **跨会话双采集器**（两个会话同时 define 同一插件 → 双 dmon + 双 timer + 同名工具重复 defineTool） | 中（R-1 已缓解） | **接受"双实例已知无害"**：采集只读、双 dmon 开销可忽略、timer 各自 fiber 隔离；同名工具重复 defineTool 行为（报错/覆盖/忽略）在 **P0 前最小样例实证**并写明策略（P0 验收 5 记录）；**inspect_self 检查防不住跨会话（t2 §2 会话级隔离实证），不再作为缓解手段**；v2 组合行单例化 + `isolate: true` 为正解（保留） |
| 8 | **命令误拦截**（pre-execute 关键词误伤非实验命令） | 低 | 关键词表白名单 + 命中记日志；waterfall 默认放行，仅"显存余量 < 需求"场景才建议阻断 |
| 9 | **prompt 注入污染**（每步注入增大上下文） | 低 | 摘要 ≤1 行恒定长度；**可开关用 Host `settings` 服务或 rpc 控制字段承载（Host 无 process.env，T1-6）** |
| 10 | **DSH 进程红线** | — | 本方案全程**不重启 DSH**：动态插件随会话加载/停止，无进程操作；v2 安装走用户手动 `dsh plugin add` |
| 11 | **并行实验状态机语义**（同会话并行 bash/workflow 下多 run 归属） | 中 | v1 定「单实验跟踪」：新 start 命中时旧 run 自动归档 aborted（P1 验收 7）；多轨并存留 v2（R-2） |
| 12 | **长实验超 ring buffer 窗口**（>30min 早期数据滚动丢失） | 中 | running 期间按需扩容（容量翻倍至 2h）或摘要标注「部分数据」（P1 验收 2）（R-3） |

**回滚总策略**：MVP 一切副作用都在 fiber 内（disposer 语义）→ `cordis_stop`/`cordis_undefine` 即完全回滚，无磁盘/配置残留；v2 卸载插件行或 `dsh plugin remove` 即可。

---

## 7. 时间盒建议

| 里程碑 | 工作量（会话轮次） | 工作量（人时） | 说明 |
|---|---|---|---|
| P0 | 1.5~2 轮 | 4~6h | **P0 前最小样例验证（0.25~0.5h：cordis_define 装载单文件大函数体 + 同名工具重复 defineTool 行为实证，T1-3/R-1）**；D-A 与 D-B 并行各 ~0.75 轮 + 集成验收 0.5 轮 |
| P1 | 2~3 轮 | 6~8h | D-C 引擎 1.5 轮 + D-D 工具/prompt 0.5~1 轮 + 场景构造验收 0.5 轮 |
| P2 | 2~3 轮 | 6~8h | 告警防抖 1 轮 + badge/settings 1 轮 + 历史曲线 0.5~1 轮 |
| 评审 | 1 轮穿插（t4 完成后） | 1~2h | 计划评审先行，实现评审随里程碑 |
| **合计** | **~7 个开发轮次** | **18~24h** | 按 1 轮/半天，MVP 全程约 **2~3 个工作日** |

节奏建议：P0→P1→P2 顺序交付，每里程碑结束后先跑 CI 式自测再进下一里程碑；t4 计划评审应在**任何实现开始前**完成（评审意见合入本计划的修订版）。

---

## 8. 交付物清单（本计划衍生的下一步动作）

1. t4 评审（有条件通过，6 高项已在本修订版 §9 闭合）后：在 `/home/dc/projects/lab-monitor/` 落地目录骨架 + README + docs/01~04（由集成工程师执行）；**docs/reference/data-model.md 先行定稿**：状态机转移表（含 pid 关联链路 T1-1、result 配对规则 T1-2）、单实验跟踪约束（R-2）、buffer 扩容标注（R-3）；
2. 冻结 docs/reference/protocol.md 的 snapshot JSON schema（含 `alertsCriticalCount`/`callCount`/`gpu.degraded` 字段与 `thresholds` 请求参数——T2-1/T2-2/T4-2）；**P0 前最小样例验证 cordis_define 装载（T1-3）**；
3. 按 §5.2 依赖图派出 D-A/D-B（普通 subagent，红线清单随任务下发）；
4. 每里程碑执行 §4 验收 + §5.5 CI 自测，验收单勾选结果回报队长。

> 本文档为 t3 最终交付物，已按 t4 评审（有条件通过）出 v1.1 修订版；修订明细见 §9。

---

## 9. 修订记录 v1.1（2026-08-18，t4 评审后）

> 评审报告：output-t4-review.md（22 条：6 高 + 9 中 + 7 低）。本版就地修订对应小节，修订点均已在正文标注 `T*-*` 编号。

### 9.1 高严重度闭合（6/6）

| # | 闭合方式 | 修订位置 |
|---|---|---|
| T1-1 pid 来源 | 完整链路已定义：① pre-execute 只记 `{runId, cmd特征, startTs}`（无 pid）→ ② ps 快照（5s）按「cmdline 特征 + startTs 后出现」关联回填 → ③ 优先 tools/execute 回传句柄/pid → ④ 关联失败降级（无候选进程 ≥3 个采样间隔 + 无 result → 超时判 crashed）；crashed 判定与 ps 间隔对齐（连续 ≥2 周期无存活 = 10~15s），验收改「≤15s」 | §3.1 state-machine / hooks、§4 P1 验收 1 |
| T1-2 tools/result 配对 | result 处理器必须配对校验（工具名=bash 且命令串含 runId 特征，或平台调用 ID 配对），不匹配**忽略**；done 需「配对命中 + 实验进程已消失」**双确认**；kill 实验进程走 crashed 路径，其自身 result 不触发 done；规则定稿进 docs/reference/data-model.md | §3.1 state-machine / hooks、§4 P1 验收 1、§8 交付物 1 |
| T1-3 单函数体 vs 多文件 | **选定 MVP 单文件**：plugin/host/index.js 与 plugin/client/index.js 即 code.host/code.client（内部分区注释、顶层函数共享函数体作用域），dev-run.sh 只做确定性组装 + node --check（禁 import/export）；v2 拆多文件；**P0 前最小样例验证**（含同名工具重复 defineTool 实证，联动 R-1） | §1 目录树 / 演进表、§7 时间盒、§8 交付物 2 |
| T2-1 pluginToggles 生效链路 | **选定「轮询携带阈值」**：client 从 pluginSettings 读出随 snapshot 请求上传 `thresholds`，host 以请求参数为准（天然 ≤1 轮询周期生效）；setThresholds 保留为 v2/兜底直连；写入 docs/reference/protocol.md | §3.1 rpc / balancer、§3.2 轮询代码、§3.3 消息流表、§4 P2 验收 2、§8 交付物 2 |
| T2-2 badge vs 零轮询 | **选定「低频保活通道」**：visible=false 时降频 30s（可配）仅拉 snapshot 更新 last、不渲染 DOM；P0 验收 2 改「零渲染轮询 + 低频保活」，断言改 host 侧 `callCount`；P2 验收 1/3 同步（用户不看 tab 时 badge 30s 内更新）；protocol 增加 `alertsCriticalCount` 字段 | §3.1 rpc、§3.2 保活代码、§4 P0 验收 2 / P2 验收 1/3、§8 交付物 2 |
| R-1 跨会话双采集器 | inspect_self 检查**移除**（会话级隔离下无效）；改为**接受「双实例已知无害」**（采集只读、fiber 隔离）+ P0 前实证同名工具重复 defineTool 行为并写明策略 + P0 验收 5 重复激活断言；v2 组合行单例 + `isolate: true` 为正解 | §6 风险 7、§4 P0 验收 5、§7 时间盒 |

### 9.2 中严重度合入（9/9）

| # | 合入位置 |
|---|---|
| T1-4 dmon 中断自愈 | §3.1 collector 降级行 + §4 P0 验收 4（kill dmon 30s 内恢复 + `gpu.degraded`） |
| T1-5 React hooks 导入来源 | §3.2 轮询代码（React 解构）+ §5.4 红线 3 |
| T2-3 host.call 失败处理 | §3.2 refresh try/catch + 指数退避（5s→10s→30s 封顶）+ 错误态 + §5.5 回归项 |
| T2-4 emit 可测点 | §4 P1 验收 6（自监听/观测行 console 断言 lab/experiment-start\|end\|alert） |
| T3-2 依赖声明事实来源 | §1 README 注释（MVP 以源码对象 inject 为事实来源，package.json 仅 v2 启用） |
| T4-1 P1 验收命令匹配 | §3.1 关键词表加入 `python -c`/`python3 -c` + §4 P1 验收 1 固化 `python train_demo.py` 形态 |
| T4-2 P0 验收 2 断言手段 | §3.1 rpc 加 `callCount` 计数器 + §4 P0 验收 2 改 host 侧计数断言（host.call 进程内 RPC 不走网络） |
| R-2 并行实验单跟踪 | §3.1 状态机（新 start 归档旧 run 为 aborted）+ §4 P1 验收 7 + §6 风险 11 + docs/reference/data-model.md |
| R-3 长实验 buffer | §4 P1 验收 2（running 期扩容至 2h 或摘要标注「部分数据」）+ §6 风险 12 |

### 9.3 低严重度处理（7/7，随实现文档合入）

| # | 处理 |
|---|---|
| T1-6 | 风险 9 注入开关改 Host `settings` 服务 / rpc 控制字段（Host 无 process.env）——§3.1 prompt 约束行 + §6 风险 9 |
| T1-7 | 兜底分支改 `ctx.get('slots')` 判空 + ctx.effect 包裹 + 与 registerTab 互斥/降级顺序——§3.2 兜底小节 |
| T2-5 | lab_ctl 护栏：仅监控/告警引擎启停、不碰实验进程、写操作限 UI 或 approval——§3.1 rpc/tools 表 |
| T3-3 | agent-preset 目录标注「v2 启用，MVP 不实现」——§1 目录树 |
| T4-3 | P0 验收 1 写明比较方法（同秒 dmon vs query-gpu、≥3 采样点均值偏差 <5%）——§4 P0 验收 1 |
| T4-4 | P2 验收 2 写明断言步骤（重开页面验 `pluginSettings[id]` 仍在 + 重新 define 后生效）——§4 P2 验收 2 |
| R-4 | badge/title thunk try/catch + console.error + P2 验收 4（thunk 抛错不白屏有日志）——§3.2 badge + §4 P2 验收 4 |

### 9.4 结论

6 条高严重度全部闭合、9 条中严重度全部合入对应里程碑任务、7 条低严重度随实现文档合入。本修订版可进入实施：D-A/D-B 派出前需完成 §8 交付物 1/2（目录骨架 + docs/02、03 定稿 + P0 前最小样例验证）。
