# Lab Monitor 完整实施计划（t3）

> **归档注记（2026-08-20 清理）**：本文所述 v1.4.5 MVP 资产（`plugin/` 动态版、`scripts/dev-run.sh`、`lab-monitor.define.json`）已归档至 `docs/archive/v1.4.5-plugin/`；`mock-test.js` 已移至 `scripts/`。

> 制定人：architect（方案架构师）｜日期：2026-08-18（v1.1：t4 评审修订；v1.2：用户新架构原则 + t6 契约；v1.3：t8 复审 + reviewer 预审闭合；v1.4：采样实证 + 采集后端抽象）
> 输入：output-t1-external.md（外部 12 条借鉴）、output-t2-assets.md（内部复用清单）、output-t2b-better-sidebar.md（0.12.2 契约实证）、docs/t8-lab-monitor-architecture.md（总架构基线）、output-t4-review.md（22 条评审问题）、output-t6-bs013.md（0.13.0 契约差异）、output-t7-review2.md（t8 复审）、output-t8-preflight.md（V1-V6 + webServer W1-W5）、lab-monitor/docs/research/08-sampling-empirical.md（本机采样实证：WSL 无 nvidia-smi、interop 通道）、output-t10-sampler-adapter.md（三范式 + SamplerBackend 接口 + 双后端方案）
> 状态：v1.4 修订版（**采集后端抽象：LinuxBackend + WindowsBackend（interop）**；修订明细见 §12）
> 红线遵守：未调用任何 client 平台 inspect；全部输入经 read 读取

---

## 0. 项目定位（一句话）

**Lab Monitor = 科研实验监控助手**：本机、秒级、进程内、零 token 的实时监控骨架，为 DSH 里的科研/训练实验提供「采样 → 状态 → 诊断 → 告警 → UI/Agent 感知」闭环。

三层组合（t8 §2 结论，MVP 只做第 1 层）：

| 层 | 载体 | 角色 | 阶段 |
|---|---|---|---|
| 骨架层 | **Cordis 插件（核心引擎层 + UI 出口适配层）** | 核心：采样/状态/告警/Agent 通道；出口：可插拔 UI（原生兜底 + sidebar 可选） | **MVP + v2** |
| 指挥层 | Agent 预设「实验指挥」 | persona + 决策规则 + 工具使用指引 | v2 |
| 编排层 | Agent-teams | 多实验并行/超参扫描、共享 GPU 池调配 | v3（可选） |

与 monitor-panel 互补不重叠：monitor-panel = 远程多机、30s 级、HTTP 轮询；Lab Monitor = **本机、秒级、进程内**（t2 §1 接口/边界）。

**v1.2 核心架构原则（用户明确要求）**：插件核心功能**必须独立完整，不依托 better-sidebar 等任何第三方插件**；sidebar 只是**最后的可视化出口之一**，支持后续独立迭代；即使无任何 UI 出口（含 sidebar 被整体禁用），核心层（采集、告警、Agent 工具、prompt 注入、事件广播）仍完整运行。

---

## 1. 项目目录结构

项目路径：`/home/dc/projects/lab-monitor/`（根目录已创建）。

```
/home/dc/projects/lab-monitor/
├── README.md                        # 总览：定位、架构图、快速开始；★注明依赖声明事实来源（T3-2：
│                                    #   MVP 以源码内对象 inject 为事实来源，package.json 仅 v2 启用）
├── plugin/                          # ★ Cordis 插件源码（MVP 动态插件与 v2 正式插件同源）
│   ├── host/                        # —— 核心引擎层（Host 半，独立完整，零第三方依赖）——
│   │   ├── index.js                 # ★ MVP 主函数体（T1-3 修订，v1.4）：即 cordis_define 的 code.host 函数体；
│   │   │                            #   源码仓库按模块分文件，dev-run.sh 固定顺序 concat 合并
│   │   │                            #   （禁 import/export；顶层函数声明 + 顺序敏感初始化区）
│   │   │                            #   分区：sampler 合并段 / ring / state / balancer / hooks / rpc / tools / prompt
│   │   ├── sampler/                 # ★ 采集后端抽象（v1.4 新增，替代 v1.3 单体 collector 设计）
│   │   │   ├── backend-interface.js # SamplerBackend 契约（probe/snapshot/stream/close + cacheTtlMs）
│   │   │   ├── backend-linux.js     # LinuxBackend：/proc+ps 零依赖（纯 Linux 场景）
│   │   │   ├── backend-windows.js   # WindowsBackend：interop（nvidia-smi.exe + CIM/tasklist，WSL 场景）
│   │   │   ├── backend-windows-native.js  # 预留桩：纯 Windows 本机（未来，probe→ok:false）
│   │   │   ├── windows-paths.js     # interop 完整路径 + 编码策略常量表（t10 §4）
│   │   │   └── index.js             # detectPlatform() + createBackend() 平台分发
│   │   └── modules/                 # （v2 启用）全部模块拆分文件（含 sampler/ 保留原样）
│   ├── client/                      # —— UI 出口适配层（Client 半，可插拔、可缺席）——
│   │   ├── index.js                 # ★ MVP 单文件（T1-3 沿用）：出口层入口/分发（探测+互斥+注册）；
│   │   │                            #   内部分区：①数据消费者（host.call 轮询→模块级 last 快照，出口共享）
│   │   │                            #   ②conversation.view 原生兜底（默认出口，零第三方依赖）
│   │   │                            #   ③better-sidebar 适配器（最后开发，判空+features 门控，缺席静默）
│   │   └── adapters/                # （v2 启用）出口适配器拆文件：conversation-view.js / better-sidebar.js
│   ├── web/                         # （可选，v2 前置）自托管 HTTP 面板出口：web/index.html + app.js
│   │                                #   host 侧 webServer.register 路由（快照 JSON，后续可扩 SSE /lab/events）
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
│   └── dev-run.sh                   # MVP：按固定顺序 concat → code.host，node --check 校验后输出
│                                    #   （T1-3 v1.4 修订：确定性合并器——禁 import/export、文件内注释分隔、
│                                    #   顶层函数声明共享作用域、顺序敏感初始化区）
│                                    #   ★concat 顺序（v1.4.1 定稿，D4-1）：
│                                    #   backend-interface.js → windows-paths.js → backend-linux.js →
│                                    #   backend-windows.js → backend-windows-native.js → sampler/index.js
│                                    #   → 主 index.js（ring/state/balancer/hooks/rpc/tools/prompt 分区）
├── docs/
│   ├── 01-architecture.md           # 架构基线（从 t8 同步 + 本计划定稿，含核心/出口分层）
│   ├── 02-data-model.md             # 指标常量枚举 / ring buffer 格式 / 状态机转移表 / 告警分级
│   ├── 03-protocol.md               # host.call RPC 契约（方法名 + JSON schema 版本化）
│   ├── 04-milestones.md             # P0/P1/P2 验收清单（可勾选，CI 自测点记录）
│   └── 05-ui-adapters.md            # UI 出口层契约：注册策略/优先级/互斥规则/能力降级矩阵
└── .gitignore                       # node_modules/ 等
```

**MVP → v2 演进原则（目录一次到位，代码渐进成型）**：

| 维度 | MVP（本会话内验证） | v2（生产化） |
|---|---|---|
| 加载方式 | `cordis_define` 动态插件（会话级，**源码分文件 + dev-run.sh 确定性 concat 为单一函数体**：host 主 index.js + sampler/*.js 固定顺序合并为 code.host，plugin/client/index.js 为 code.client；node --check 校验；**P0 前先跑最小样例验证 cordis_define 装载大函数体可行**——T1-3 v1.4 修订） | 正式插件：npm 包（bundle 双半 + cordis.patch.yml）或本机 profile 预设行（`cordis:group` + `isolate: true` 包服务），跨会话共享；host 模块拆文件、client 出口拆 adapters/（t2 §3 边界） |
| 生命周期 | 进程重启即失效 → 重启后重新 define（源码即文件，零丢失） | 随 DSH 组合行常驻 |
| Agent 预设 | 不启用 | agent-preset/lab-commander 挂载为指挥层 |
| UI 出口 | **核心层无 UI 也完整运行**；MVP 出口 = conversation.view 原生兜底（默认），better-sidebar 适配器为最后增量 | 出口可插拔：conversation.view（默认）+ better-sidebar（可选）+ webServer 自托管面板（可选） |
| 远端扩展 | 不做 | webServer SSE `/lab/events`（手机端 / 对接 monitor-panel，t2 §1 可选） |

---

## 2. 技术方案总览（四通道消息流）

```
┌────────────────────── 核心引擎层（Host 半，独立完整，零第三方依赖）──────────────────────┐
│                                                                                          │
│  timer.interval(2s) ──► sampler(LinuxBackend/WindowsBackend) ──► ring-buffer(≤1000点)    │
│  /proc 原生 或 interop  ──►   (GPU/CPU/内存/进程，platform+sources 标注)  ▼  最近快照 last │
│  （WSL 无 nvidia-smi，实证 08）      │                            ▼                       │
│                                     state-machine         balancer(纯代码)               │
│  hooks: tools/pre-execute│result ──► 实验起止/crash         4 类诊断→分级告警+建议         │
│                                      └────────────┬──────────────┘                       │
│                                                   ▼                                      │
│                                     ctx.emit('lab/experiment-start|end|alert')           │
│   ┌──────────────┬──────────────────┬───────────────────────┬──────────────────┐        │
│   ▼              ▼                  ▼                       ▼                  ▼        │
│ rpc            tools             prompt                 webServer(可选)     Agent 预设   │
│ harness.      harness.          systemPrompt.         自托管面板路由         (v2 消费     │
│ handle        defineTool        variable             （出口④，SSE 可扩）     工具+注入)   │
│ (出口统一       lab_status/       ('labStatus')                            │            │
│  数据面)        lab_advice       每模型步注入                              │            │
│   ▲            lab_ctl              │                                      │            │
└───┼────────────────────────────────┼──────────────────────────────────────┼────────────┘
    │ host.call(快照/历史/阈值)       │ 每步自动注入（无需唤醒机制）          │
    ▼                                ▼                                      ▼
┌────────────── UI 出口适配层（可插拔、可缺席，v1.2 重构）────────────────┐   ┌──────┐  ┌──────┐
│ ① Agent 通道（host 侧工具+prompt 注入 = 「无 UI 出口」，永远可用）        │   │ 平台  │  │ Agent │
│ ② conversation.view 原生 tab（★默认兜底出口，dsh 自带 slots 零第三方）    │   │ hook  │  │ 主会话│
│ ③ better-sidebar Tab（可选增强：最后开发，判空+features 门控，缺席静默）  │   │ 系统  │  │(LLM)  │
│ ④ webServer 自托管面板（可选，插件自带网页，独立于侧栏媒介）              │   │ →插件 │  │       │
│ 数据消费者（出口共享）：host.call 轮询 → 模块级 last → 各出口渲染         │   │ 通道  │  │       │
└─────────────────────────────────────────────────────────────────────────┘   └──────┘  └──────┘
```

**核心 ↔ 出口解耦契约（v1.2 新增）**：
- **出口只消费、不反向依赖**：所有出口适配器只通过两个面取数——① `host.call` 快照/历史/阈值 RPC（rpc.js 数据面）；② `ctx.on('lab/*')` 事件（订阅广播）。核心层**不 import/不感知**任何出口的存在；
- **核心层无 UI 也完整**：采集、状态机、平衡引擎告警、Agent 工具（lab_status/lab_advice）、prompt 注入、事件广播全部在 Host 半独立运行——sidebar 被整体禁用/缺席时零功能损失；
- **出口彼此独立**：每个出口独立 `ctx.effect` 注册（disposer 语义），任一出口注册失败/抛错不影响其他出口与核心层（各自 try/catch + console.error）；
- **出口可增删**：新增出口 = 新增一个适配器文件（v2 拆 adapters/），不改核心层任何代码。

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

### 3.1 核心引擎层（Host 半，模块 × 输入/输出）

> **核心层独立性声明（v1.2）**：以下全部模块只依赖平台内建（`timer`/`shell`/`harness`/`systemPrompt` 服务与 `tools/*` 平台事件），**不 import/依赖任何第三方服务**；无任何 UI 出口时（采集、告警、Agent 工具、prompt 注入、事件广播）完整运行。`rpc.js`（harness.handle）与 `ctx.emit('lab/*')` 是核心层**对外唯一数据/事件面**，出口层只消费这两者。

#### sampler/ —— 采集后端抽象（v1.4 重构，替代 v1.3 单体 collector 设计）

> 事实基线（docs/research/08-sampling-empirical.md 本机实证）：**WSL 内没有 nvidia-smi**（`/usr/lib/wsl/lib/` 无该命令、无 /dev/nvidia* 设备），GPU 采样必须走 **Windows interop**（`/mnt/c/Windows/System32/nvidia-smi.exe`：query 40–60ms、dmon 流 1s 行流）；cmd/powershell 裸名不在 WSL PATH（必须完整路径）；PowerShell CIM ~1.5s（chcp 65001 + UTF8）、tasklist GBK→iconv 转码；/proc 原生零开销；**WSL 内存视图 14.3GB ≠ Windows 31.7GB**——platform 维度必须进数据模型（t10 §1.2/§2 要点 3）。

**① SamplerBackend 接口**（backend-interface.js，对齐 netdata 五方法 + nvitop TTL 缓存 + psutil 差分，t10 §2）：

| 方法/字段 | 语义 |
|---|---|
| `probe()` | 探测当前环境是否可用（= netdata Check）；**绝不抛错**，返回 `{ ok, reason?, detail? }`（detail 含 gpu 可用性/interop/wslVersion） |
| `snapshot()` | 一次性全量采样（= netdata Collect）；输出**规范化指标 JSON**（见 ④ 快照协议） |
| `stream()` | 长驻增量流（GPU dmon 行流）；无流能力返回 `null`；上层负责行→指标解析，后端保证「流活着 + 断流可感知（EOF/超时）」 |
| `close()` | 释放资源（**杀 interop 子进程、清缓存**）；幂等——WSL 父进程死后 Windows 子进程仍存活（t10 §4 实证），必须显式清理**防孤儿**（新增验收） |
| `cacheTtlMs` | 后端内建查询 TTL（nvitop ttl_cache 模式）；interop 通道 40–60ms/次，缓存窗口内不重复 fork（如 500ms） |
| `lastCpuTimes` | CPU 差分基线（psutil 算法：**首帧丢弃、负值截 0**）——后端内维护，暴露给上层诊断 |

**② 双后端组成**（backend-linux.js / backend-windows.js / backend-windows-native.js 预留桩）：

| 后端 | 组成 | 指标 | 依赖 |
|---|---|---|---|
| **LinuxBackend** | `/proc/stat` 差分 + `/proc/meminfo` + `ps`（5s） | cpu.percent（差分）/ mem.* / procs | **零依赖**（纯 Linux 场景验收） |
| **WindowsBackend** | nvidia-smi.exe query（快照）+ dmon（流）+ PowerShell CIM（CPU/内存，低频 ≥5s）+ tasklist（进程表，GBK 转码） | gpu.*（interop）/ cpu、mem（CIM）/ procs | interop 可用（probe 检测）；windows-paths.js 完整路径常量表 |
| **WindowsNativeBackend**（预留） | 同接口，Windows 侧实现 | 同上 | 未来：纯 Windows/远程场景，接口不变 |

**③ 平台分发**（sampler/index.js，v1.4.1 职责分离，D1-1）：`detectPlatform()` **只看平台特征**——`/proc/version` 含 `microsoft` → `'wsl'` → WindowsBackend；纯 Linux → LinuxBackend；未来 win32 → WindowsNativeBackend（预留桩 probe→ok:false）。**interop 可用性不参与平台判定**，由 `WindowsBackend.probe()` 驱动通道级降级（见 ⑤）。

**④ 快照协议**（backend.snapshot() 规范化输出 → ring buffer）：`{ ts, platform, sources, gpu[], cpu, mem, procs[], degraded }`
- `platform: 'linux' | 'wsl' | 'windows-native'`——**内存视图语义区分**（WSL 14.3GB vs Windows 31.7GB，实证 1.6）；
- `sources: { gpu?: 'dmon'|'query'|'unavailable', cpu: 'procfs'|'cim', mem: 'procfs'|'cim', procs: 'ps'|'tasklist' }`——来源通道标注（差分 vs 瞬时语义可见，消费方按需解释）；
- **指标命名规范化**（借鉴 nvitop 带单位）：`utilPct` / `memUsedMiB` / `memTotalMiB` / `tempC` / `powerW` / `totalMiB` / `percent`——通道差异（dmon `sm` 字段换算、GBK 转码、字段缺省）**封死在后端内**，上层 ring/UI/告警只消费规范化字段；
- `degraded?: { gpu?: 'stream-down'|'query-fallback', reason? }`。

**⑤ 降级链**（后端内建，与上层告警解耦）：
- GPU 缺失（probe 发现 nvidia-smi.exe 不存在/interop 断）→ `sources.gpu='unavailable'`，CPU/内存/进程照常（P0 验收 3）；
- **interop 通道级降级（v1.4.1，D1-1）**：interop 断（nvidia-smi.exe 不可执行/CIM 不可达）→ GPU 通道 `unavailable`；**CPU/内存回退 /proc 原生读取**（`sources.cpu/mem='procfs'`，WSL 内核视角仍真实）；**`platform` 保持 `'wsl'`**（标注真实采样视图，不因通道降级改平台）；
- 流中断（dmon EOF/超时）→ 指数退避重启（1s→2s→4s，≤3 次/5min）→ 连续失败回退 query-gpu 快照模式 + `degraded.gpu='query-fallback'`（P0 验收 4，T1-4 interop 版）；
- 单通道失败（tasklist GBK 解析错）→ 该通道降级（procs 空数组 + sources 标注），**不拖垮整次 snapshot**。

**⑥ Windows 通道契约要点**（windows-paths.js，t10 §4 全表）：
- **全部完整路径**（裸名不在 WSL PATH，实证 1.4）；
- **编码分通道**：nvidia-smi 纯 ASCII 免处理 / PowerShell `chcp 65001` + `OutputEncoding=UTF8` + bash 侧单引号传参 / tasklist GBK→`iconv -f GBK -t UTF-8`；
- **频率分级**：dmon 流 1s（长驻）/ query 40–60ms（缓存 TTL 500ms 内复用）/ CIM 与 tasklist ≥5s（慢通道集中化或后台异步，防闪窗）；
- **自愈**：dmon 退出重启 + query 失败重试 + 单通道降级不拖垮全局；**清理**：close() 显式杀 interop 子进程（不留孤儿）。

#### ring-buffer.js —— 环形缓冲
| 项 | 内容 |
|---|---|
| 输入 | sampler 后端 snapshot() 输出采样点（v1.4.1 命名同步） |
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
| 输入 | 最近 N=10s 快照窗口 + 当前实验上下文 + **当前生效阈值（host 侧 settings 服务为唯一事实来源，v1.3；请求携带/setThresholds/lab_ctl 均为更新入口，last-write-wins，M3）** |
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
| `labMonitor.snapshot` | `{ thresholds? }`（**T2-1 决策① 修订（v1.3）**：携带值视作「建议更新」，host 以时间戳后者为准——last-write-wins，M3；事实来源是 host settings 服务） | `{ ts, platform, sources, gpu[], cpu, mem, procs[], alerts[], alertsCriticalCount, experiment, callCount, ui }`（**v1.4：`platform`/`sources` 为后端采样标注**——platform 区分 WSL/Windows 内存视图语义，sources 标注各指标通道（dmon/query/procfs/cim/tasklist）；`alertsCriticalCount`=host 预算的 CRITICAL 计数，badge 直读，T2-2；`callCount`=host 侧 RPC 调用计数器，供 P0 验收 2 断言，T4-2；`gpu[].degraded` 随 gpu[] 携带（T1-4）；**`ui.betterSidebarVisible`=host 半经 `settings.describe` 探测 aionui-panel 互斥标志（t6 §3.2 判据）+ 监听 `settings/updated` 实时刷新，出口适配层据此决定 ②/③ 切换**；JSON 纯数据） |
| `labMonitor.history` | `{ sinceMs, bucketMs }` | 降采样后的时间序列 |
| `labMonitor.setThresholds` | `{ util, memPct, temp, pollMs }` | `{ ok, applied }`（直连更新通道；与请求携带冲突时以时间戳后者为准，M3） |
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

### 3.2 UI 出口适配层（Client 半 + 可选 web 出口）

#### 3.2.0 出口注册策略与优先级（v1.2 核心变更）

| # | 出口 | 依赖 | 状态 | 优先级与时机 |
|---|---|---|---|---|
| ① | **Agent 通道**（tools + prompt 注入） | 无（host 侧核心层固有） | **永远可用** | 第一：本质即「无 UI 出口」，任何 UI 缺席都不受影响 |
| ② | **conversation.view 原生 tab** | dsh 自带 `slots`（零第三方） | **默认启用** | 第二：**默认兜底出口**；better-sidebar 缺席/被整体禁用时自动生效 |
| ③ | **better-sidebar Tab** | 第三方 dsh-better-sidebar | 可选（**最后开发**） | 第三：**双检查**——`ctx.get('betterSidebar')` 判空（服务缺席）**且** `snapshot.ui.betterSidebarVisible` 标志（0.13.0「UI 隐形」形态：host 半探测 aionui-panel 互斥，t6 §3/§4）；`features` 门控；存在且可见时**替代** ②（互斥） |
| ④ | **webServer 自托管面板** | 平台 `webServer`（零第三方） | 可选（v2 前置） | 第四：独立注册路由，与 ②③ 可共存（不同媒介：独立网页 vs 侧栏） |

**互斥/共存规则（v1.2）**：
- ② 与 ③ **互斥**（同属 tab 环类座位，防重复渲染）：默认注册 ②（不依赖原则）；探测 ③ 可用 → 注销 ②、注册 ③（③ 为增强替代）。v1.1 的「registerTab 优先」**反转**：默认 ②，sidebar 仅当可用且未被禁用时替代；
- ④ 与 ②③ **共存**（不同媒介）；
- 任一出口注册抛错 → 各自 try/catch + console.error，不影响其他出口与核心层；
- 出口全部缺席 → 核心层（① 永远在）不受影响——「无 UI 也完整」验收口径（§4 P0）。

**client 半依赖声明纪律（v1.3，V1/H2 闭合）**：client 半返回对象**只声明核心依赖 `inject: ['timer']`**（timer 是平台内置服务，恒存在）；**better-sidebar 绝不进 inject**——若声明为硬依赖，服务缺席（0.13.0 互斥禁用/未安装）时整个 client 半进入 waiting 永不 apply，apply 内的 conversation.view 默认出口 ② 也不会注册，"核心独立"名存实亡。正确姿势：apply 顶部**无条件执行**核心逻辑与 ② 注册；`const bs = ctx.get('betterSidebar'); if (bs) ...` 分支才注册 ③（t2b 结论① 明示：ctx.get 免声明、缺席返回 undefined）。

#### 3.2.1 数据消费者（出口共享，唯一取数通道）
- 所有出口共用同一套「host.call 轮询 → 模块级 `last` 快照 → 各自渲染」；`last` 是各出口 badge/label/title 的唯一只读源（O(1)）；
- **阈值事实来源 = host 侧 settings 服务（v1.3，V2 闭合）**：默认值与持久化都在核心层（Host `settings` 服务，t2 §2 实证），**不依赖任何第三方持久化**；better-sidebar 的 pluginSettings **仅作出口层 UI 编辑同步面**（读后携带、host 为准回写）；**last-write-wins 仲裁（M3，reviewer 细化版）**：host 侧记录「生效阈值 + 生效时间戳」——`lab_ctl`/`setThresholds` 直连写入**即时生效并更新时间戳**；snapshot 请求携带的 `thresholds` 到达时**晚于生效时间戳才覆盖**（比纯按到达顺序更可测）；balancer 一律用 host 持有值（写入 docs/03-protocol.md）；无任何 UI 出口时阈值经 lab_ctl 配置且重启后仍生效；
- **渲染节流**：conversation.view 无 visible 语义 → 常驻 5s 节流；better-sidebar 出口按 visible 暂停（见 3.2.3）。

#### 轮询 + 可见性节流 + 低频保活（t5 结论② 核心模式 + T2-2/T2-3 修订）
```js
const { useState, useEffect } = React            // ★T1-5：统一从 React 解构，不裸用顶层名
let last = null                                   // 模块级最近快照（badge/title 只读源）
let lastFetchAt = 0

async function refresh() {
  try {
    const thresholds = readThresholds()           // v1.2：sidebar 出口读 pluginSettings；无 sidebar 则不携带（host 用默认/上次设置）
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
- **禁用 `window.setInterval`**：浏览器 timer 全局被 guard 遮蔽（t5 教学陷阱 TIMER_REDIRECT），必须 `inject: ['timer']` 用 `ctx.setInterval`（出口层通用红线）；
- 数据消费者与出口渲染解耦：轮询只更新 `last` 与出口可见时 setState；`last` 快照供 ②③ 的 label/badge/title thunk 只读（R-4：thunk try/catch + console.error）；
- **conversation.view 出口渲染路径（reviewer 补充，v1.3）**：上述代码块是 better-sidebar 组件形态（visible 语义）；默认出口 ② 的渲染路径 = **label thunk 实时摘要**（O(1) 读 `last`，仅 `last` 变化时更新 label）+ **面板组件**（若 M7 实证支持自定义组件渲染；节流口径 = 常驻 5s，不依赖 visible）——**D-B1 实现者须同时产出两条路径，不得只照 better-sidebar 形态写**。

#### 3.2.2 conversation.view 原生兜底（★默认出口，v1.2 升级）
- 状态：**默认启用**（v1.2 从"兜底"升为"默认出口"——零第三方依赖，贯彻核心独立原则）；
- 实现：`const slots = ctx.get('slots'); if (slots) ctx.effect(() => slots.register({ name:'conversation.view', id:'lab.monitor', order:20, label: thunk }, ...))`（ctx.get 判空 + ctx.effect 包裹 + replaceRisk none，会话头部 tab 环，t8 §3.4）；
- label thunk：O(1) 读 `last` 输出一行摘要（如 `GPU0 92% · 20.1/24G · 2告警`）；try/catch + console.error（R-4）；
- 注册时序：apply 时先注册本出口；3.2.3 适配器探测可用 → 注销本出口（disposer）改注册 ③；③ 失败 → 保持本出口（互斥规则落地）；
- 数据通道：与 3.2.1 共享 host.call 轮询（无 visible 语义 → 常驻 5s 节流）。

#### 3.2.3 better-sidebar 适配器（最后开发，可选增强）
- 适配器形态（v1.3，V1/H2 闭合）：**不依赖注入**——client 半对象只 `inject:['timer']`，适配器内部 `const bs = ctx.get('betterSidebar'); if (bs) bs.registerTab({ id:'lab-monitor:gpu', badge 只读 last, pluginToggles 阈值面板, visible 暂停轮询, features 门控, 低频保活, R-4 try/catch })`（t2b 结论① 姿势：ctx.get 免声明、缺席返回 undefined）——**实现顺序排在最后**（用户原则：最后才考虑如何对接 sidebar）；**显式声明（reviewer 补充）**：client 半**插件级 inject 仅含 timer 等核心依赖**，betterSidebar 只在适配器分区内 `ctx.get()` 取用——防止实现者沿用 v1.1 骨架惯性；
- **探测重探机制（M4）**：`ctx.get` 是即时查询，若插件 apply 早于 better-sidebar 服务发布（激活时序不定），一次性探测返回 undefined 后永不升级。因此注册 ② 后延迟重探：`ctx.setTimeout` 2s 一次、共 3 次（或实现时实证平台服务注册事件）；探测成功即注销 ② 切换 ③；探测失败保持 ②，不影响功能；
- **0.13.0 兼容（t6 契约差异已合入）**：
  - 契约面**完全向后兼容**（registerTab/badge/title thunk/visible/pluginToggles/render 不变，t6 §2.2）；新增 `settingSelect` 为可选能力（阈值面板用 number 行不强依赖）；`features` 用 `includes()` 语义（只增不减，t6 D6）；
  - **互斥「双检查」（t6 §4 结论 B）**：0.13.0 新增「服务在、UI 隐形」形态——aionui-panel 场景下 `ctx.get` 判空**无法识别**（服务照常 provide、registerTab 照常成功但 UI 不挂载，suspended 不进快照）。因此 **host 半**直接读 settings 命名空间 `aionui-panel`（`settings.describe`，better-sidebar 自己的 host 半即此姿势，t6 §3.2 ①）：`rightPanel === 'aionui-panel'` → `snapshot.ui.betterSidebarVisible=false`；host 半监听 `settings/updated` 事件实时刷新该标志（t6 §4 规避方案 1/2）；
  - 注册条件 = **服务判空（absent）且 可见性标志（hidden）双通过** → 注册 ③；任一不通过 → 保持 ② 默认出口，零功能损失（t6 §4 规避方案 3）；
- 注册时序：apply 时先注册 ②，探测 ③ 可用 → 注销 ②、注册 ③；③ 注册抛错 → 保持 ②；
- badge 语义：数字 = CRITICAL 告警计数（99+ 封顶，`alertsCriticalCount` 直读）；title 动态化可选（O(1)）。

#### 3.2.4 webServer 自托管面板（可选，v2 前置；按 t8 预审 W1-W5 修正）
- 获取方式（L2）：host 半 `const ws = ctx.get('webServer'); if (ws) ws.register({ kind, path, handler })`（判空可选消费，注册返回 disposer）；
- **路由命名（W2）**：`/lab-monitor`（面板页）与 `/lab-monitor/api/snapshot`（快照 JSON）——重复 (kind, path) 注册直接 throw，路径必须全局唯一前缀；**禁 registerFallback（W3）**：单座位已被 DSH SPA dist 占用，注册即 throw 破坏组合；
- **静态内容自产（W5）**：webServer **不提供静态文件服务**（"serves no files"）——HTML 内嵌插件源码字符串，或经 shell 服务 cat 文件（Host 无 fs 内建），handler 自产完整响应体；
- **绑定与可达（W1）**：webServer 是 **DSH 共享网关上的路由注册**（非独立服务器），监听地址/端口由网关配置决定（当前 127.0.0.1:3080），**插件不可选端口**；手机端经 Tailscale 转发器（100.64.0.2:13080）可达；
- 与 ②③ **共存**（独立浏览器页/手机端媒介，不同座位）；后续可扩展 SSE `/lab/events`（W4：handler 可保持响应打开）；MVP 不做（v2 前置）。

### 3.3 消息流完整性检查（t4 评审维度 2 的预答）

| 闭环场景 | 通道组合 |
|---|---|
| 实验开始 | hooks(pre-execute) → state-machine → emit lab/experiment-start → prompt 注入（下一步） |
| 实验崩溃 | state-machine(crashed) → emit lab/alert → badge 计数 + 面板 + 下一模型步注入 |
| UI 实时刷新 | host.call(snapshot, 5s) ← rpc.js（进程内 RPC 开销可忽略，t2 §2） |
| Agent 主动查询 | defineTool lab_status/lab_advice ← tools.js |
| 告警不打断 | 无推送 API → UI + 下一步注入 + 工具结果三路闭环（t8 §3.3 设计决策） |
| 阈值生效 | **host settings 为事实来源（v1.3）**；pluginSettings 仅 sidebar 出口同步面；更新入口（请求携带/setThresholds/lab_ctl）last-write-wins → ≤1 轮询周期生效（T2-1） |

---

## 4. MVP 里程碑（P0 → P1 → P2，各带可测量验收）

### P0「核心引擎 + 最小可见性」：采样（双后端）+ RPC + 数据面（v1.4 映射 probe/stream 语义）
- 交付：sampler/ 后端抽象（backend-interface + LinuxBackend + WindowsBackend + index 分发）+ ring-buffer + rpc.snapshot + **最小可见性 = conversation.view 原生兜底 tab（默认出口②，推荐）或 Agent 工具 lab_status（① 无 UI 出口）**，二者至少其一
- 验收标准（全部可测量）：
  1. **核心数据面正确（后端语义，v1.4）**：`lab_status` 工具返回正确 JSON 快照；**WSL 环境默认走 WindowsBackend**——GPU 快照经 `nvidia-smi.exe --query-gpu` interop 调用（实测 40–60ms，08 实证）；**conversation.view 默认出口（②）为 P0 主 UI 对象**（自定义组件渲染能力先经样例②实证）；**比较方法（T4-3 修订 + D1-2）**：同秒内先后取 **dmon 流解析值**与 **query 快照值**（对比对象改为 interop 通道）比较——**偏差阈值不预设 5%**，由 **P0 前样例③顺带实测（稳定负载）后定阈值**并回填本清单；**LinuxBackend 在纯 Linux 场景单独验收**（无 interop 时 `/proc` 路径正确性）；
  2. 数据消费者轮询生效（**conversation.view 无 visible 语义 → 常驻 5s 节流**）；**断言手段（T4-2）host 侧计数**：rpc.js `callCount` 经 snapshot 字段暴露，对照「callCount 增量符合 5s 节流节奏」（callCount 只断言轮询频率）；**零渲染可操作定义**：组件卸载即停，或 label thunk 仅在 `last` 变化时更新 label（口径待样例②实证定稿）；visible=false 暂停/保活断言移至 P2 验收 5；
  3. **无 GPU 降级（probe 驱动，v1.4）**：probe() 失败（nvidia-smi.exe 不存在/interop 断）→ `sources.gpu='unavailable'` + CPU/内存/进程照常，**不抛错不挂起**；
  4. **dmon 自愈（T1-4 interop 版）**：kill 后台 dmon 进程（Windows 侧）→ 30s 内指数退避重启恢复采集；连续失败回退 query 快照模式 + `degraded.gpu='query-fallback'` 期间出口有降级提示；
  5. **核心独立运行断言**：**不注册任何 UI 出口（注释掉 ②③④）→ 核心层采集/告警/工具/prompt 注入仍完整可用**（lab_status 正常、alerts 正常产生）；
  6. **兜底同数据断言（V3）**：禁用/卸载 better-sidebar（0.13.0 互斥或移除插件）→ client 半**不 waiting**（console 无错误）、② 正常显示同数据；**互斥形态模拟（t6 补充）**：手动改 settings 命名空间 `aionui-panel.rightPanel='aionui-panel'`（或单测 `betterSidebarVisible` 标志逻辑）→ 断言 `snapshot.ui.betterSidebarVisible=false` 且出口层保持 ②；
  7. **重复激活断言（R-1）**：同一插件被重复 define/激活 → 无崩溃、无重复 UI；同名工具重复 defineTool 行为（报错/覆盖/忽略）实证并记录进 04-milestones.md；
  8. **真实采样实证（v1.4 新增）**：跑通 LinuxBackend + WindowsBackend **最小实现**（probe→snapshot→stream→close 全链路），实测耗时与编码处理（query 40–60ms / CIM ~1.5s / tasklist GBK 转码 / dmon 流增量读）**记录进 docs/research/08-sampling-empirical.md 增补**；
  9. **close() 无孤儿（v1.4 新增，v1.4.1 核对方式修订，D2-1）**：`close()` 后无残留 interop 子进程（WSL 父进程死 Windows 子进程存活特性，t10 §4）——动态插件 stop/update 时资源清理断言：**按命令行特征（cmdline 含 `dmon`）或 spawn 时记录的 pid 清单核对**（不用进程名，避免误伤用户同名进程）；
  10. `cordis_inspect_self(pluginId, packageId)` 无 diagnostics；停止插件后采集与 UI 全部随 fiber 清理（无残留 interval/进程）。

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

### P2「能管」：分级告警 + 原生兜底 UI + 历史曲线（better-sidebar 适配器为最后增量）
- 交付：告警防抖/静默、conversation.view 默认出口增强（label 实时摘要）、history 曲线、lab_ctl 阈值控制；**better-sidebar 适配器（badge/pluginToggles）为 P2 末尾可选增量**
- 验收标准：
  1. util > 阈值（如 90%）**持续 10s** → host `alertsCriticalCount` +1 且同类告警 5 分钟内不重复（日志断言）；conversation.view 的 label 摘要含告警数（如 `2告警`）；
  2. **阈值生效（出口无关，v1.2）**：经 `lab_ctl set-threshold`（或 rpc.setThresholds 直连）改阈值（如显存 95→50）→ ≤1 轮询周期生效（host 为准，T2-1）；**持久化断言（T4-4）**：重新 define 后阈值仍生效（host 默认值 + settings 服务持久化，**不依赖任何第三方**）；
  3. 历史曲线渲染 ≥30 分钟数据（降采样 ≤500 点）；关闭 UI 出口后 host 采集/告警不中断（核心独立于出口可见性，t1 启示 9）；
  4. **出口健壮性（R-4）**：label/badge thunk 抛错 → 不白屏且有 console.error 日志；**better-sidebar 被禁用（0.13.0 互斥/整体禁用）时 conversation.view 默认出口正常显示同数据**（降级矩阵生效，docs/05-ui-adapters.md）；
  5. **better-sidebar 适配器（最后增量，可选验收）**：注册 ③ 成功时 badge 显示 CRITICAL 计数（100 告警封顶 `99+`）、pluginToggles 阈值面板改值 ≤1 轮询周期生效、visible=false 时低频保活 30s 内 badge 更新、features 门控兼容旧版本；③ 不可用（get 返回 undefined / aionui-panel 互斥）→ **自动保持 ②**。

---

## 5. 团队协作方案（开发阶段）

### 5.1 角色划分与任务包
| 角色 | 负责模块 | 对应任务包 |
|---|---|---|
| **采样器工程师** | sampler/ 后端抽象（interface + Linux/Windows 后端 + 分发）+ ring-buffer + rpc.snapshot（核心层） | D-A（P0 前半） |
| **出口层工程师** | 数据消费者 + **conversation.view 默认出口（先行）**；**better-sidebar 适配器最后** | D-B1（P0 后半，依赖 D-A 的 RPC 契约）→ D-B2（P2 末尾，可选增量；M8 拆分） |
| **引擎工程师** | state-machine + balancer + hooks（核心层） | D-C（P1，依赖 P0 全部） |
| **集成工程师（队长/主会话）** | tools + prompt + 验收 + cordis_define/run | D-D（P1 后半）→ D-E（P2 主体收尾） |

### 5.2 任务依赖图与并行度
```
t3(本计划) ──► P0: D-A(采样器/核心) ──┬──► D-C(引擎: 状态机+平衡+hooks/核心) ──► D-D(工具+prompt)
                                       └──► D-B1(出口层: 数据消费者 + conversation.view 默认出口) ──┘   │
                                                                                      D-E(P2: 告警+原生UI+曲线) ◄─┘
                                                                                      D-B2(★最后: better-sidebar 适配器) ◄─ D-E
```
- **并行度**：D-A 与 D-B1 可**并行**（前提：rpc.js 的 snapshot JSON schema 先在 docs/03-protocol.md 冻结，作为两任务共同契约）；D-C 依赖 P0 两者；D-D 依赖 D-C；D-E 依赖 D-D；**D-B2（better-sidebar 适配器）必须最后**——不进入任何 P0/P1 并行路径（开发顺序：引擎与 Agent 通道优先 → 原生兜底 UI → sidebar 最后）。
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
- **每次里程碑结束**：① `scripts/verify.sh`（node --check 全部 js、目录完整性、契约文件存在）；② 会话内跑 §4 验收清单（docs/04-milestones.md 勾选）；③ 结果回报队长；
- **回归红线**：改 client 半后重 define + 重跑 P0 验收 1/2/5/6（轮询节流、核心独立、兜底同数据、重复激活不回归）；**断连自愈回归（T2-3）**：插件重启/页面刷新后轮询自动恢复（退避重试 + 恢复立即刷新）。

---

## 6. 风险与回滚

| # | 风险 | 等级 | 缓解 / 回滚 |
|---|---|---|---|
| 1 | **better-sidebar 版本耦合 + 可被整体禁用**（0.13.0 与 aionui-panel 互斥、可整体禁用；契约随版本演进；曾有 dsh-full-remote 冲突史，t8 §7） | 高（v1.2 必须防御） | **架构级防御：核心层零第三方依赖（v1.2 原则），sidebar 仅是出口③**；出口层 `ctx.get` 判空 + features 门控 + 0.13.0 互斥探测；**conversation.view 为默认出口（②）**，③ 不可用自动保持 ②；回滚 = 注销 ③ 出口，核心层不受影响 |
| 2 | **动态插件进程内临时性**（重启即失效，t2 §3 边界） | 中 | 源码即文件（零丢失），重启后重 define；v2 转正式插件/预设行；回滚 = `cordis_stop` 即回到无监控状态，无持久副作用 |
| 3 | **WSL GPU 采样依赖 interop 通道**（v1.4 实证：WSL 内无 nvidia-smi、GPU 采样走 Windows 侧 nvidia-smi.exe；完整路径/编码/频率分级均需处理；dmon 运行中中断） | 中 | WindowsBackend 内建：完整路径常量表 + 编码分通道（ASCII/chcp+UTF8/iconv）+ 频率分级（dmon 流 1s / query TTL 500ms / CIM·tasklist ≥5s）；**probe 先行**：nvidia-smi.exe 不存在/interop 断 → `sources.gpu='unavailable'` + CPU/内存照常（P0 验收 3）；**运行中自愈（T1-4 interop 版）**：EOF/超时检测 → 指数退避重启（≤3 次/5min）→ 回退 query 模式 + `degraded.gpu='query-fallback'`（P0 验收 4）；纯 Linux 场景 LinuxBackend 零依赖兜底 |
| 4 | **采样开销失控**（interop query 反复调用、ring buffer 无界） | 中 | dmon 长驻流替代反复 query（WSL 下为 interop 长驻流）；query 通道 cacheTtlMs 500ms 内复用（40–60ms/次）；ring buffer 双条件封顶（≤1000 点 / ≤30 分钟）；CIM/tasklist 慢通道 ≥5s 低频；visible=false 停轮询；5s 轮询间隔下限 1s 可配 |
| 5 | **Client guard 限制**（属性访问需 inject 声明、timer 全局遮蔽、host.call 只驮 JSON） | 中 | 按 t5 结论①/② 的规范形态书写（对象形态 + inject 声明 + ctx.setInterval + 纯 JSON 载荷）；验收含"停止后无残留"断言 |
| 6 | **告警风暴** | 中 | 阈值持续 10s + 同类最小间隔 5 分钟 + 分级（t1 启示 3）；静默窗口 v2 |
| 7 | **跨会话双采集器**（两个会话同时 define 同一插件 → 双 dmon + 双 timer + 同名工具重复 defineTool） | 中（R-1 已缓解） | **接受"双实例已知无害"**：采集只读、双 dmon 开销可忽略、timer 各自 fiber 隔离；同名工具重复 defineTool 行为（报错/覆盖/忽略）在 **P0 前最小样例实证**并写明策略（P0 验收 5 记录）；**inspect_self 检查防不住跨会话（t2 §2 会话级隔离实证），不再作为缓解手段**；v2 组合行单例化 + `isolate: true` 为正解（保留） |
| 8 | **命令误拦截**（pre-execute 关键词误伤非实验命令） | 低 | 关键词表白名单 + 命中记日志；waterfall 默认放行，仅"显存余量 < 需求"场景才建议阻断 |
| 9 | **prompt 注入污染**（每步注入增大上下文） | 低 | 摘要 ≤1 行恒定长度；**可开关用 Host `settings` 服务或 rpc 控制字段承载（Host 无 process.env，T1-6）** |
| 10 | **DSH 进程红线** | — | 本方案全程**不重启 DSH**：动态插件随会话加载/停止，无进程操作；v2 安装走用户手动 `dsh plugin add` |
| 11 | **并行实验状态机语义**（同会话并行 bash/workflow 下多 run 归属） | 中 | v1 定「单实验跟踪」：新 start 命中时旧 run 自动归档 aborted（P1 验收 7）；多轨并存留 v2（R-2） |
| 12 | **长实验超 ring buffer 窗口**（>30min 早期数据滚动丢失） | 中 | running 期间按需扩容（容量翻倍至 2h）或摘要标注「部分数据」（P1 验收 2）（R-3） |
| 13 | **better-sidebar 0.13.0 互斥机制（「服务在、UI 隐形」形态）**（aionui-panel 启用 → sidebar UI 整体不挂载，t6 §3/§4 实证：仅判空无法识别） | 高（v1.2 必须防御） | **host 半双检查**：`settings.describe` 探测 `aionui-panel.rightPanel === 'aionui-panel'`（host 半可读，t6 §3.2 ①）+ 监听 `settings/updated` 实时刷新 → `snapshot.ui.betterSidebarVisible` 标志；client 出口层「服务判空 + 可见性标志」双通过才注册 ③，否则自动保持 ② 默认出口（t6 §4 规避方案 3）；核心层与 ②④ 不受影响 |
| 14 | **webServer 自托管面板出口安全/路由**（可选 ④） | 低 | 路由 `/lab-monitor` 前缀全局唯一（W2）、**禁 registerFallback**（W3）、快照只读 API；绑定地址由 DSH 网关决定（W1）；v2 前置，MVP 不启用 |
| 15 | **出口全缺席/全失败（含 slots 缺席）**（② 依赖的 slots 本身也是可选服务；②③④ 全不可用 → 纯核心运行） | 中 | 缓解：核心层完整（P0 验收 5「无任何 UI 出口时核心完整」已覆盖）+ Agent 通道①永远兜底 + 出口各自 try/catch 互不影响；降级矩阵见 docs/05-ui-adapters.md（M6） |
| 16 | **interop 管道缓冲/增量读未实证**（长驻 Windows dmon 进程输出经 interop 管道，shell.start+readOutput 增量读行为与纯 Linux 长驻进程有差异） | 中 | **P0 前最小样例③实证**（shell.start + readOutput 读 Windows dmon 流：行完整性/缓冲边界/EOF 感知）；实测结论写入 08-sampling-empirical.md 增补；失败则回退 query 快照模式（40–60ms/次可接受） |
| 17 | **interop 进程孤儿**（WSL 父进程死后 Windows 子进程仍存活，t10 §4 实证——动态插件 stop/update 时若不清理会残留 nvidia-smi.exe/powershell.exe） | 中 | `close()` 显式杀 interop 子进程（记录 pid 清单 + taskkill 或 Job Object）；P0 验收 9「close() 无孤儿」断言；fiber disposer 语义下 close 挂在 ctx.effect 清理链 |
| 18 | **慢通道拖累采样周期**（PowerShell CIM ~1.5s、tasklist ~230ms，若与 2s 采样 tick 同步执行会卡周期） | 低 | 频率分级：CIM/tasklist ≥5s 低频或后台异步采样（缓存 TTL 内复用）；单通道慢不阻塞 GPU 主通道（dmon 流） |

**回滚总策略**：MVP 一切副作用都在 fiber 内（disposer 语义）→ `cordis_stop`/`cordis_undefine` 即完全回滚，无磁盘/配置残留；v2 卸载插件行或 `dsh plugin remove` 即可。

---

## 7. 时间盒建议

| 里程碑 | 工作量（会话轮次） | 工作量（人时） | 说明 |
|---|---|---|---|
| P0 | 2~2.5 轮 | 5~7h | **P0 前最小样例验证（0.5~1h：① cordis_define 装载大函数体 + 同名工具重复 defineTool 实证（T1-3/R-1）；② conversation.view 承载能力实证（M7）；③ interop 长驻流增量读实证：shell.start + readOutput 读 Windows dmon 流（v1.4 新增，风险 16））**；D-A 与 D-B1 并行各 ~0.75 轮（D-A = sampler 双后端 + ring + rpc.snapshot；D-B1 = 数据消费者 + conversation.view 默认出口）+ 真实采样实证与集成验收 0.5~1 轮 |
| P1 | 2~3 轮 | 6~8h | D-C 引擎 1.5 轮 + D-D 工具/prompt 0.5~1 轮 + 场景构造验收 0.5 轮 |
| P2 | 2~3 轮 | 6~8h | 告警防抖 1 轮 + 原生兜底 UI 增强/历史曲线 1 轮 + 验收 0.5~1 轮；**better-sidebar 适配器（D-B2）为末尾增量 +0.5~1 轮** |
| 评审 | 1 轮穿插（t4 完成后） | 1~2h | 计划评审先行，实现评审随里程碑 |
| **合计** | **~7 个开发轮次** | **18~24h** | 按 1 轮/半天，MVP 全程约 **2~3 个工作日** |

节奏建议：P0→P1→P2 顺序交付，每里程碑结束后先跑 CI 式自测再进下一里程碑；t4 计划评审应在**任何实现开始前**完成（评审意见合入本计划的修订版）。

---

## 8. 交付物清单（本计划衍生的下一步动作）

1. t4 评审（v1.1，§9）+ 用户新架构原则（v1.2，§10）+ t8 复审（v1.3，§11）+ 采样实证（v1.4，§12）后：落地目录骨架 + README + docs/01~05（已由 t9 完成，v1.4 变更同步于本计划）；**docs/02-data-model.md 先行定稿**：状态机转移表（含 pid 关联链路 T1-1、result 配对规则 T1-2）、单实验跟踪约束（R-2）、buffer 扩容标注（R-3）、**阈值事实来源 = host settings 服务（V2）**；**sampler/ 目录落地**（六文件，t10 §5）；
2. 冻结 docs/03-protocol.md 的 snapshot JSON schema（含 `platform`/`sources`/`alertsCriticalCount`/`callCount`/`gpu[].degraded`/**`ui.betterSidebarVisible`** 字段与 `thresholds` 请求参数——T2-1/T2-2/T4-2/t6/v1.4；**阈值 last-write-wins 仲裁（M3，host 生效时间戳版）**）；**docs/05-ui-adapters.md 定稿**：出口注册策略/优先级/互斥规则/能力降级矩阵；**P0 前最小样例验证**：① cordis_define 装载（T1-3）+ 同名工具重复 defineTool（R-1）；② conversation.view 承载能力（M7）；③ **interop 长驻流增量读实证（v1.4）**；**真实采样实证**：LinuxBackend + WindowsBackend 最小实现跑通，耗时/编码记录进 08-sampling-empirical.md 增补；
3. 按 §5.2 依赖图派出 D-A/D-B1（普通 subagent，红线清单随任务下发；D-A = sampler 双后端 + ring + rpc.snapshot；D-B1 只做数据消费者 + conversation.view 默认出口，**D-B2 better-sidebar 适配器最后**）；
4. 每里程碑执行 §4 验收 + §5.5 CI 自测，验收单勾选结果回报队长。

> 本文档为 t3 最终交付物，已按 t4 评审出 v1.1、按用户新架构原则出 v1.2、按 t8 复审出 v1.3、按采样实证出 v1.4；修订明细见 §9/§10/§11/§12。

---

## 9. 修订记录 v1.1（2026-08-18，t4 评审后）

> 评审报告：output-t4-review.md（22 条：6 高 + 9 中 + 7 低）。本版就地修订对应小节，修订点均已在正文标注 `T*-*` 编号。

### 9.1 高严重度闭合（6/6）

| # | 闭合方式 | 修订位置 |
|---|---|---|
| T1-1 pid 来源 | 完整链路已定义：① pre-execute 只记 `{runId, cmd特征, startTs}`（无 pid）→ ② ps 快照（5s）按「cmdline 特征 + startTs 后出现」关联回填 → ③ 优先 tools/execute 回传句柄/pid → ④ 关联失败降级（无候选进程 ≥3 个采样间隔 + 无 result → 超时判 crashed）；crashed 判定与 ps 间隔对齐（连续 ≥2 周期无存活 = 10~15s），验收改「≤15s」 | §3.1 state-machine / hooks、§4 P1 验收 1 |
| T1-2 tools/result 配对 | result 处理器必须配对校验（工具名=bash 且命令串含 runId 特征，或平台调用 ID 配对），不匹配**忽略**；done 需「配对命中 + 实验进程已消失」**双确认**；kill 实验进程走 crashed 路径，其自身 result 不触发 done；规则定稿进 docs/02-data-model.md | §3.1 state-machine / hooks、§4 P1 验收 1、§8 交付物 1 |
| T1-3 单函数体 vs 多文件 | **选定 MVP 单文件**：plugin/host/index.js 与 plugin/client/index.js 即 code.host/code.client（内部分区注释、顶层函数共享函数体作用域），dev-run.sh 只做确定性组装 + node --check（禁 import/export）；v2 拆多文件；**P0 前最小样例验证**（含同名工具重复 defineTool 实证，联动 R-1） | §1 目录树 / 演进表、§7 时间盒、§8 交付物 2 |
| T2-1 pluginToggles 生效链路 | **选定「轮询携带阈值」**：client 从 pluginSettings 读出随 snapshot 请求上传 `thresholds`，host 以请求参数为准（天然 ≤1 轮询周期生效）；setThresholds 保留为 v2/兜底直连；写入 docs/03-protocol.md | §3.1 rpc / balancer、§3.2 轮询代码、§3.3 消息流表、§4 P2 验收 2、§8 交付物 2 |
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
| R-2 并行实验单跟踪 | §3.1 状态机（新 start 归档旧 run 为 aborted）+ §4 P1 验收 7 + §6 风险 11 + docs/02-data-model.md |
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

6 条高严重度全部闭合、9 条中严重度全部合入对应里程碑任务、7 条低严重度随实现文档合入。v1.1 结论：可进入实施（后续 v1.2/v1.3 演进见 §10/§11）。

---

## 10. 修订记录 v1.2（2026-08-18，用户新架构原则 + t6 0.13.0 契约）

> 动因：用户明确要求「插件核心功能必须独立完整，不依托 better-sidebar 等任何第三方插件；sidebar 只是最后的可视化出口之一，支持后续独立迭代」；better-sidebar 已升级 0.13.0（与 aionui-panel 互斥，可被整体禁用）。t6（output-t6-bs013.md）实证 0.13.0 契约差异与互斥机制。

### 10.1 架构分层重构（核心引擎层 + UI 出口适配层）

| 层 | 内容 | 独立性 |
|---|---|---|
| **核心引擎层**（Host 半全部 + Client 数据消费者） | collector / ring-buffer / state-machine / balancer / hooks / rpc / tools / prompt 注入；只依赖平台内建（timer/shell/harness/systemPrompt + tools/* 平台事件） | **不 import/依赖任何第三方服务；无任何 UI 也完整运行**（采集/告警/工具/prompt 注入/事件广播） |
| **UI 出口适配层**（可插拔、可缺席） | ① Agent 通道（tools+prompt =「无 UI 出口」，永远可用）；② conversation.view 原生 tab（**默认兜底出口**，零第三方）；③ better-sidebar Tab（可选增强，**最后开发**）；④ webServer 自托管面板（可选，v2 前置） | 各出口独立 `ctx.effect` 注册、互不干扰；只消费 host.call 快照与 ctx 事件（lab/*），**不反向依赖核心层** |

**解耦契约**：核心层对外唯一数据/事件面 = `rpc.js`（harness.handle）+ `ctx.emit('lab/*')`；新增出口 = 新增适配器文件（v2 拆 adapters/），不改核心层任何代码。架构图见 §2。

### 10.2 开发顺序修正（用户原话「最后才需要考虑如何对接 sidebar」）

| 顺序 | 内容 | 对应任务 |
|---|---|---|
| 1（优先） | 核心引擎 + Agent 通道（采集/状态机/平衡引擎/工具/prompt 注入） | D-A / D-C / D-D（P0/P1） |
| 2 | conversation.view 原生兜底 UI（默认出口） | D-B（P0 后半） |
| 3（最后） | better-sidebar 适配器 | D-F（P2 末尾，可选增量） |

里程碑验收口径：**P0 不再要求 better-sidebar 渲染**，改为「核心引擎 + 最小可见性」（Agent 工具或原生兜底二选一）；P0 新增验收 5「不注册任何 UI 出口 → 核心层仍完整运行」；P2 阈值生效改出口无关（lab_ctl/rpc 直连），badge/pluginToggles 移入 P2 末尾 better-sidebar 增量（验收 5 可选）。

### 10.3 目录结构调整

- `plugin/host/` = 核心引擎层（标注「独立完整，零第三方依赖」）；
- `plugin/client/` = UI 出口适配层：index.js 单文件内分区（① 数据消费者 / ② conversation.view 默认出口 / ③ better-sidebar 适配器），v2 拆 `adapters/`（conversation-view.js / better-sidebar.js）；
- `plugin/web/` = 可选自托管 HTTP 面板（web/index.html + app.js，host 半 webServer.register 路由，v2 前置，仅绑 127.0.0.1）；
- `docs/05-ui-adapters.md` = 出口层契约（注册策略/优先级/互斥规则/能力降级矩阵）定稿；
- **T1-3 单文件 MVP 决策沿用**：多个适配器仍单文件内分区（dev-run.sh 确定性组装不变）。

### 10.4 里程碑调整（相对 v1.1）

| 里程碑 | v1.1 | v1.2 |
|---|---|---|
| P0 | 采样+RPC+**better-sidebar Tab 渲染** | 采样+RPC+**核心数据面 + 最小可见性**（conversation.view 默认出口或 lab_status 二选一）；新增「无 UI 核心独立运行」验收 5 |
| P1 | 不变（引擎 + Agent 通道优先） | 不变（7 条验收全部保留） |
| P2 | 告警+badge/title+**pluginToggles 面板**+曲线 | 告警+**原生兜底 UI 增强**+曲线+**出口无关阈值**（lab_ctl/rpc）；badge/pluginToggles 移入末尾 **better-sidebar 适配器增量**（可选验收 5，含双检查降级断言） |

### 10.5 0.13.0 契约差异合入（t6 实证）

- 契约面完全向后兼容（t6 D9/D10/D12：方法集、TabDescriptor、pluginToggles 无变化；D5 urlTarget 生效但不使用）；新增 `settingSelect`（D2-D4/D6）为可选能力，`features` 用 `includes()` 语义（t6 §2.2）；
- **互斥「双检查」**（t6 §4 结论 B）：0.13.0 新增「服务在、UI 隐形」形态（aionui-panel 场景下服务照常 provide、registerTab 成功但 UI 不挂载、suspended 不进快照，仅 `ctx.get` 判空无法识别）→ **host 半** `settings.describe` 探测 `aionui-panel.rightPanel === 'aionui-panel'` + 监听 `settings/updated` 实时刷新 → `snapshot.ui.betterSidebarVisible` 标志；出口层「服务判空 + 可见性标志」双通过才注册 ③，否则保持 ②（t6 §4 规避方案 3）——已合入 §3.1 rpc、§3.2.0/3.2.3、§6 风险 13。

### 10.6 风险表更新

- **风险 1 升级**：better-sidebar 版本耦合 + 可整体禁用 → **架构级防御**（核心层零第三方依赖 + 默认出口 ② + 双检查；回滚 = 注销 ③ 出口，核心层不受影响）；
- **新增风险 13**（0.13.0 互斥「服务在、UI 隐形」，高）：host 半 settings.describe 探测 + 可见性标志双检查降级；
- **新增风险 14**（webServer 自托管面板安全/端口，低）：仅绑 127.0.0.1、只读 API、端口可配、v2 前置。

### 10.7 结论

v1.2 满足用户核心原则：核心功能独立完整（无 UI / 无 sidebar 均完整运行）、sidebar 降级为最后的可选出口之一（双检查 + 默认出口 ② + 降级矩阵）；0.13.0 升级风险已实证并纳入双检查防御。可进入实施：按 §5.2 依赖图（D-F 最后）派出 D-A/D-B。（v1.2 遗留的 V1/V2 硬伤已在 v1.3 §11 闭合，任务包命名 D-F 在 v1.3 改为 D-B2。）

---

## 11. 修订记录 v1.3（2026-08-18，t8 复审 + reviewer 预审闭合）

> 评审输入：output-t7-review2.md（t8 复审：3 高/8 中/5 低，结论「有条件通过」，评审基线为 v1.2 中间版 460 行）；output-t8-preflight.md（V1-V6 独立性残留扫描 + webServer 契约 W1-W5）。本版就地修正，修订点已在正文标注 `v1.3`/`M*`/`V*` 编号。

### 11.1 高严重度闭合（3/3）

| # | 闭合方式 | 修订位置 |
|---|---|---|
| H2（=V1）betterSidebar 硬依赖残留 | §3.2.3 移除「保留 v1.1 注册骨架（`inject:['betterSidebar','timer']`）」表述；client 半只 `inject:['timer']`，betterSidebar 一律 `ctx.get()` 判空可选消费（t2b 结论① 姿势）；apply 顶部**无条件执行**核心逻辑与 ② 注册——0.13.0 互斥禁用时 client 半照常 apply、默认出口 ② 正常注册 | §3.2.0「client 半依赖声明纪律」、§3.2.3 适配器形态 |
| H3（=V3）P0 验收与默认出口矛盾 | P0 验收 2 移除 visible=false 断言，改为「conversation.view 常驻 5s 节流 + callCount 节奏断言」（无 visible 语义）；visible 暂停/低频保活断言**移至 P2 验收 5**（better-sidebar 出口专属）；P0 验收 1 明确 conversation.view（②）为 P0 主 UI 对象（组件能力先经 M7 实证） | §4 P0 验收 1/2、§4 P2 验收 5 |
| H1 评审对象完整性 | v1.2 已含 §10；本版补 §11 记录 t8 各条闭合方式与修订位置；头部 meta 更新 v1.3 | §11 全文、头部 meta |

### 11.2 中严重度合入（8/8）

| # | 合入位置 |
|---|---|
| M3 阈值双写仲裁 | §3.1 rpc snapshot/setThresholds 行 + balancer 输入行 + §3.3 阈值行（last-write-wins：请求携带=建议更新、直连=直连更新，时间戳后者为准，**host settings 为事实来源**）+ §8 交付物 2（写入 03-protocol） |
| M4 ③探测重探机制 | §3.2.3（apply 早于服务发布时 `ctx.setTimeout` 2s×3 重探或平台事件；失败保持 ②） |
| M5 webServer 三缺口 | §3.2.4 全面重写：路由 `/lab-monitor` 前缀（W2 撞名 throw）、**禁 registerFallback**（W3）、静态内容 handler 自产（W5）、绑定由 DSH 网关决定（W1） |
| M6 风险表新增 | §6 风险 15（出口全缺席/全失败含 slots 缺席：核心完整 + Agent 通道①兜底 + 降级矩阵）；风险 14 改写（路由/fallback/网关绑定） |
| M7 conversation.view 承载实证 | §7 P0 时间盒 + §8 交付物 2（P0 前最小样例加「自定义组件渲染可行 + 不可见时卸载/保活语义」，结论写入 04-milestones.md） |
| M1 P2 验收 2 双轨化 | v1.2 已改为 host settings 持久化断言（不依赖第三方）——闭合 |
| M2 P2 验收 1 badge 标注出口前提 | v1.2 已拆核心句（host `alertsCriticalCount`）+ 增强句（badge，better-sidebar 可用时）——闭合 |
| M8 任务包拆分 | §5.1/5.2/§7/§8 命名 **D-B1**（P0 默认出口）/ **D-B2**（P2 适配器），与 reviewer 建议对齐（原 D-B/D-F） |

### 11.3 低严重度处理（5/5）

| # | 处理 |
|---|---|
| L1 §3.3 阈值行同步 | v1.3 已更新（§3.3 阈值生效行，host settings 事实来源） |
| L2 3.2.4 获取方式 | §3.2.4 补 `ctx.get('webServer')` 判空后 register |
| L3 t6 未产出 | 已闭合（t6 完成并合入 v1.2 §10.5） |
| L4 时间盒/交付物 | §7 时间盒按 D-B1/D-B2 拆分 + §8 交付物已含 docs/05-ui-adapters.md 定稿 |
| V6 架构图表达 | v1.2 已改「核心引擎 + 出口适配层」（§2 图）——闭合 |

### 11.4 reviewer 细节补充采纳（5 条，2026-08-18 reviewer 消息）

| # | 内容 | 落位 |
|---|---|---|
| R1 | P0 验收 2 零渲染可操作定义：callCount 只断言轮询频率；零渲染 = 组件卸载即停或 label 仅在 `last` 变化时更新；口径待 M7 实证 conversation.view 生命周期后定稿 | §4 P0 验收 2 |
| R2 | M3 仲裁细化：host 记录「生效阈值 + 生效时间戳」，直连写入即时生效并更新时间戳，携带值晚于生效时间戳才覆盖 | §3.2.1 + §8 交付物 2 |
| R3 | §8 protocol 字段冻结清单补 `ui.betterSidebarVisible`；风险 14 表述已在 v1.3 修正（非「仅绑 127.0.0.1」，改网关绑定） | §8 交付物 2、§6 风险 14 |
| R4 | §3.2.3 显式声明：插件级 inject 仅含 timer 等核心依赖，betterSidebar 仅适配器分区内 ctx.get() | §3.2.3 |
| R5 | §3.2.1 补 conversation.view 出口渲染路径（label thunk + 面板组件双路径，D-B1 须同时产出） | §3.2.1 |

### 11.5 结论

v1.3 闭合 t8 复审全部必须修正项（3 高）与建议合入项（8 中）；独立架构硬伤 **V1（inject 硬依赖）消除**、阈值事实来源 **V2 完成 host 化**（pluginSettings 降为出口同步面）。计划达到「核心独立、可插拔出口、sidebar 最后」完整达成状态，可进入实施。建议 reviewer 增量复核确认闭合。

---

## 12. 修订记录 v1.4（2026-08-18，采样实证 + 采集后端抽象）

> 动因：用户指出采样层未实证、未考虑平台扩展；队长本机实测（`lab-monitor/docs/research/08-sampling-empirical.md`）证明 **v1.3 假设「WSL 内 nvidia-smi 可用」不成立**——WSL 内无 nvidia-smi、GPU 采样必须走 Windows interop（nvidia-smi.exe 40–60ms、dmon 流跨 interop 可用）、cmd/powershell 裸名不在 PATH、PowerShell CIM ~1.5s、tasklist GBK 转码、/proc 原生、内存双视图 14.3 vs 31.7GB。t10（output-t10-sampler-adapter.md）提炼三范式（nvitop 设备注入+TTL 缓存 / psutil 平台分发+差分 / netdata 五方法契约）并给出 SamplerBackend 接口与双后端方案。

### 12.1 采集器重构为后端抽象（sampler/）

| 项 | v1.3 | v1.4 |
|---|---|---|
| 结构 | collector.js 单体（假设 WSL 内 nvidia-smi） | **sampler/ 六文件**：backend-interface.js / backend-linux.js / backend-windows.js / backend-windows-native.js（预留桩）/ windows-paths.js / index.js（平台分发） |
| 接口 | 无（内联逻辑） | **SamplerBackend**：probe() / snapshot() / stream() / close() + cacheTtlMs + lastCpuTimes（对齐 netdata 五方法 + nvitop TTL + psutil 差分） |
| 平台 | 隐含 Linux/WSL 单一假设 | **detectPlatform 双保险**（/proc/version 含 microsoft + binfmt_misc/WSLInterop）→ LinuxBackend / WindowsBackend / WindowsNativeBackend（预留） |
| 快照协议 | `{ ts, gpu[], cpu, mem, procs[] }` | **+ `platform` + `sources`**（内存视图语义、通道标注）+ `degraded` |
| 指标命名 | id/util/memUsed/memTotal/temp/power | **规范化**：utilPct / memUsedMiB / memTotalMiB / tempC / powerW / totalMiB / percent（通道差异封死后端内） |
| 降级链 | collector 内 if 判断 | **probe 驱动**（GPU 缺失→unavailable+CPU 照常）；dmon 断流→指数退避重启→query-fallback+degraded（T1-4 interop 版） |
| 清理 | 未定义 | **close() 显式杀 interop 子进程防孤儿**（WSL 父进程死 Windows 子进程存活实证） |

合并规则（T1-3 修订）：**源码仓库按模块分文件，dev-run.sh 固定顺序 concat 成单一 code.host 函数体**（禁 import/export、顶层函数声明共享作用域、顺序敏感初始化区、文件内注释分隔）+ node --check；P0 前最小样例验证装载可行。

### 12.2 protocol 更新（docs/03-protocol.md 同步）

- snapshot 响应**加 `platform`（'linux'|'wsl'|'windows-native'）与 `sources`（gpu/cpu/mem/procs 各通道）**——WSL 与 Windows 内存语义不同必须标注（14.3 vs 31.7GB）；`gpu[].degraded` 保留（T1-4）；已同步 `lab-monitor/docs/03-protocol.md`。

### 12.3 里程碑验收更新

- P0 验收 1：映射 WindowsBackend（nvidia-smi.exe query 40–60ms 实测）；T4-3 对比对象改为 **interop 通道**（dmon 流 vs query 快照）；LinuxBackend 纯 Linux 场景单独验收；
- P0 验收 3/4：降级链映射 probe/stream 语义（probe 失败→sources.gpu='unavailable'；dmon 断流→指数退避→query-fallback+degraded）；
- **新增 P0 验收 8「真实采样实证」**：LinuxBackend + WindowsBackend 最小实现跑通（probe→snapshot→stream→close），耗时/编码处理记录进 08-sampling-empirical.md 增补；
- **新增 P0 验收 9「close() 无孤儿」**：stop/update 后无残留 interop 子进程；
- **P0 前最小样例新增③「interop 长驻流增量读实证」**（shell.start + readOutput 读 Windows dmon 流，风险 16）。

### 12.4 风险表更新

- **风险 3 重写**：移除「WSL 内 nvidia-smi 可用」表述 → interop 通道风险（完整路径/编码/频率分级/probe 先行/T1-4 interop 版；纯 Linux 场景 LinuxBackend 兜底）；
- **新增风险 16**（interop 管道缓冲/增量读未实证，中）：P0 前样例③实证，失败回退 query 模式；
- **新增风险 17**（interop 进程孤儿，中）：close() 显式清理 + P0 验收 9；
- **新增风险 18**（慢通道拖累采样周期，低）：频率分级（CIM/tasklist ≥5s 或异步）。

### 12.5 目录结构与时间盒

- plugin/host 下新增 sampler/ 目录（六文件）；index.js 改为「主函数体 + concat 合并」说明；dev-run.sh 更新为确定性合并器；
- P0 时间盒 1.5~2 轮 → **2~2.5 轮（5~7h）**（最小样例三件套 + 真实采样实证）。

### 12.6 结论

v1.4 以本机实证为事实基线重构采集层：**双后端抽象**使「WSL（interop）/ 纯 Linux / 未来 Windows 原生」三场景共用同一上层（ring/state/balancer/rpc/tools/UI 零改动——适配器模式验收标准，t10 §5.4）；protocol 加 platform/sources 消除内存视图歧义；新增真实采样实证与 close() 防孤儿验收堵住「纸面采样」与「孤儿进程」两个缺口。可进入实施：D-A 按 sampler/ 六文件实现双后端。建议 reviewer 评审 v1.4。

### 12.7 v1.4.1 就地修订（2026-08-18，t12 评审后）

> 评审报告：output-t11-review3.md（0 高/3 中/7 低，结论「有条件通过」）。本版一句话级就地修正，修订点已标注 `D*-*` 编号。

| # | 闭合方式 | 修订位置 |
|---|---|---|
| D1-1 detectPlatform 职责分离 | **平台判定只看 `/proc/version` 含 microsoft → 'wsl'**；interop 可用性**不参与平台判定**，由 `WindowsBackend.probe()` 驱动通道级降级——interop 断 → CPU/内存回退 /proc（`sources.cpu/mem='procfs'`）+ GPU `unavailable` + **platform 保持 'wsl'**（标注真实采样视图，不因通道降级改平台） | §3.1 sampler ③平台分发 / ⑤降级链 |
| D1-2 偏差基线 | P0 验收 1 的「dmon vs query 偏差 <5%」**不预设阈值**——由 P0 前样例③顺带实测（稳定负载）后定阈值并回填清单 | §4 P0 验收 1 |
| D2-1 孤儿核对方式 | P0 验收 9 改**按命令行特征（cmdline 含 dmon）或 spawn pid 清单核对**，不用进程名（避免误伤用户同名进程） | §4 P0 验收 9 |
| 低度残留（L 系列） | ring-buffer 输入「collector」旧名 → sampler（§3.1 ring-buffer）；风险 4「每秒 fork」旧表述 → interop query + cacheTtlMs 复用（§6 风险 4）；**concat 顺序清单定稿**（D4-1）：backend-interface → windows-paths → backend-linux → backend-windows → backend-windows-native → sampler/index → 主 index.js（§1 dev-run.sh 注释） | §3.1 / §6 / §1 |
| 其余 7 低 | 表述级（引号/编号/引用一致），随实现文档合入，不单独阻塞 | — |

**结论**：v1.4.1 闭合 t12 全部中低项（0 高）；detectPlatform 职责分离后平台判定与通道可用性解耦，降级语义更清晰。可放行 D-A（sampler/ 六文件实现双后端）；样例③顺带完成 dmon vs query 偏差基线实测（D1-2 回填）。

### 12.8 v1.4.5 就地修订（2026-08-19，P1 端到端实证后）

> 触发：P1 端到端测试（`scripts/e2e-host.js`，真实 python3 进程 + 真实 ps/kill 驱动同一份 host 代码）暴露
> **verify-host 自测未覆盖的真实缺陷**——`python3 -c` 内联形态 pid 关联结构性失败，正常结束误判 crashed。
> 测试记录：docs/research/10-p1-e2e-test.md（T1-T4 全部真实进程 ALL PASS）。

| # | 缺陷（e2e 实证） | 根因 | 修复（plugin/host/index.js） |
|---|---|---|---|
| E1 | `python3 -c '...'` 正常结束误判 crashed + 误发 CRITICAL 告警（T1 暴露） | `cmdFingerprint` 对 `python -c` 用**内容哈希**（`pyc:<hash>`）；ps 行 args 是代码原文（引号被 shell 剥离），哈希永不匹配 → `findAliveProc` 永找不到 → pid 关联失败 → 进程结束即 `pidMissingStreak>=2` 判 crashed。verify-host fake ps 直给 pid 行故未覆盖 | ① 指纹改 `pyc:` + 归一化命令从 `-c` 起的完整后缀前 28 字符（非哈希）；② 新增 `normalizeCmdForMatch`（引号剥离+空白折叠）；③ `findAliveProc` 归一化对比 + 剥离 `pyc:` 前缀；④ result 配对校验同剥离前缀 + 归一化（否则带引号 cmd 不配对） |
| E2 | oom 构造阈值语义（T4 暴露） | oom 规则为 `usedPct>=memWarn && utilPct>=utilWarn` 双条件（占用百分比），非"余量" | 非代码缺陷；测试参数修正（memWarn=5 utilWarn=1，空闲 util≈2%） |
| I1 | 实验归档 aborted/done 无 RPC 数据面（改进点） | machine.history 未暴露；P1 6 emit 只覆盖 start/alert | P2 增强 history RPC 时补实验记录面（记录，不阻塞） |

**结论**：v1.4.5 闭合 E1/E2；「自测（verify-host）+ 真实端到端（e2e-host）」双轨验证的必要性实证（fake 数据面永远有盲区）。
P1 验收 1/2 会话内端到端实证完成（T1 done 零告警 / T2 crashed+CRITICAL ≤15s / T3 单跟踪 / T4 thermal+oom），
全部回填 docs/04-milestones.md；verify.sh 全绿无回归。

---

# V2 迁移完成记录（2026-08-20）

- **状态**：V2 正式插件迁移完成（架构/代码/构建/回归/安装全链路）。本计划（v1.4.5）为 MVP 动态插件形态的定稿；V2 为其正式插件演进，代码从 `plugin/`（JS concat）迁移至 `src/`（TS + tsc/tsdown）。
- 关键差异与动机：`docs/01-architecture.md` §8-11；迁移设计文档：`docs/research/12-v2-migration.md`。
- 回归：`scripts/verify.sh` 全绿（typecheck/构建/verify-host 47 断言/mock-test 10 组/verify-sampler 真实 interop/e2e 可选）。
- 安装：`dsh plugin --profile web add /home/dc/projects/lab-monitor`（link:）→ `dsh.profile.bundles` 入列 + `dsh --dump-config` 验证 lab-monitor 行。
- **DSH 重启后插件实际加载**（进程红线：用户手动重启）；重启后验证：`dsh --dump-config` 行 + better-sidebar tab + `/lab-monitor/api/snapshot` HTTP 可达。

## V2.2 完成记录（2026-08-20，plugin-specialist 实施 + codex 交叉审查 + 截图核验）

已完成的修复（详细见 README V2.2 段 + docs/research/18-known-issues.md 状态勾选）：

1. **lossless JSON 输出修复**（lab_status/lab_advice 在 N/A 场景报 `value is not lossless JSON`）：采样解析安全降级（N/A→0/null）+ `sanitizeJson()` 出口统一清洗（undefined→null、非有限→null、-0→+0、深度上限 12 + WeakSet 防环）；codex 审查补 lab_ctl 输出清洗。
2. **settings 持久化（P2 2' 落地）**：`settings.register('lab-monitor', Schema.object({thresholds, watchProcs}))`——register 读文档 → apply → watch 响应外部修改；persistState() 写回。重启模拟恢复阈值/watchlist（verify-host [D]/[E]）。
3. **客户端三项 UI（known-issues 2b/3/4）**：进程组展开、告警同 rule 合并/截断/折叠、tick 合并拉取。
4. **趋势图真根因修复**（known-issues 问题 1，截图核验定位）：polyline 用 path 格式 points 非法 → 改 path 元素 + stroke 硬编码。
5. **展示层核验三项**（截图驱动）：普通进程行「其他进程」分隔、<0.1G 内存显示。
6. **测试配套**：verify-host settingsMock documents/namespaces 拆分、mock-test 函数组件浅渲染。

## V2 遗留（2026-08-20 对照清单，未完成）

- **P0 2' 会话端到端（callCount 与 UI 5s 节奏对照）**：conversation.view 已生效 → 现可 GUI 复核（B1）。
- **P0 3' 真实无 GPU 机实证**：环境受限，降级路径自测覆盖，留待目标环境（B2）。
- **P0 6' 互斥形态真实设置模拟**：逻辑已由 mock-test [10]/verify-host [F] 覆盖（B3）。
- **P2 5 better-sidebar 真实注册（GUI 实测）**：用户确认保持 ②，③ 有意不启用（B4）。
- **回归红线 + 断连自愈（T2-3）**：自测全绿；GUI 复核待安排（B5）。
- **A1 指挥层 Agent 预设 lab-commander**（§0 三层组合第 2 层，★v2 启用）：`agent-preset/lab-commander/` 空目录，persona/RULES/tools 三文件未实现。
- **A2 多实验并行跟踪**（风险 11 R-2「多轨并存留 v2」）：state-machine 仍单跟踪（新 start 归档旧 run aborted）。
- **A3 webServer 自托管面板（出口④）**（风险 14 + §3.2.4）：仅 API 数据面，自托管 HTML 面板未实现（可选）。
- **A4 SSE /lab/events 远端扩展**（README v2 演进表）：未实现（可选，手机端/对接 monitor-panel）。

> 完整 A/B/C 未完成清单见 README「未完成项清单」+ 04-milestones「V2 阶段未完成项」。
