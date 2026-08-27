# Lab Monitor（科研实验监控助手）

> 依据：实施计划 v1.4.5（`docs/plan/PLAN-v1.4.5.md`，唯一事实来源；本文档及 docs/01~05 与其完全一致，修订需同步计划）

## 一句话定位

**Lab Monitor = 科研实验监控助手**：本机、秒级、进程内、零 token 的实时监控骨架，为 DSH 里的科研/训练实验提供「采样 → 状态 → 诊断 → 告警 → UI/Agent 感知」闭环（计划 §0）。

## 核心架构原则（用户明确要求，v1.2+）

插件核心功能**必须独立完整，不依托 better-sidebar 等任何第三方插件**；sidebar 只是**最后的可视化出口之一**，支持后续独立迭代；即使无任何 UI 出口（含 sidebar 被整体禁用），核心层（采集、告警、Agent 工具、prompt 注入、事件广播）仍完整运行（计划 §0）。

## 架构分层图

```
┌────────────────────── 核心引擎层（Host 半，独立完整，零第三方依赖）──────────────────────┐
│  timer.interval(2s) ──► collector ──► ring-buffer(≤1000点) ──► 最近快照 last              │
│  shell.start(dmon)  ──►   (GPU/CPU/内存/进程)      │                 │                    │
│  /proc 经 shell 读取 ──►                          ▼                 ▼                    │
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
┌────────────── UI 出口适配层（可插拔、可缺席）──────────────────────────────┐   ┌──────┐  ┌──────┐
│ ① Agent 通道（host 侧工具+prompt 注入 = 「无 UI 出口」，永远可用）          │   │ 平台  │  │ Agent │
│ ② conversation.view 原生 tab（★默认兜底出口，dsh 自带 slots 零第三方）      │   │ hook  │  │ 主会话│
│ ③ better-sidebar Tab（可选增强：最后开发，判空+features 门控，缺席静默）    │   │ 系统  │  │(LLM)  │
│ ④ webServer 自托管面板（可选，插件自带网页，独立于侧栏媒介）                │   │ →插件 │  │       │
│ 数据消费者（出口共享）：host.call 轮询 → 模块级 last → 各出口渲染           │   │ 通道  │  │       │
└───────────────────────────────────────────────────────────────────────────┘   └──────┘  └──────┘
```

（计划 §2 原图；详见 `docs/architecture/core.md`）

## 目录结构

```
/home/dc/projects/lab-monitor/
├── README.md                        # 本文件：总览、架构图、快速开始
├── agent-preset/                    # v2「实验指挥」Agent 预设（★v2 启用，MVP 不实现——T3-3）
│   └── lab-commander/               #   ✅ 2026-08-22：**不做预设**（用户决策），改为「使用文档」形式
│                                   #     （`docs/usage/usage.md`：lab_status/lab_advice/lab_ctl 用法手册；
│                                   #      面板 UI / 阈值 / 标签 / 多轨语义；prompt 注入增强待讨论）
│       ├── persona.md / RULES.md / tools.md
├── scripts/
│   ├── verify.sh                    # CI 式自测：node --check + 目录完整 + 契约静态核对 + 四测套
│   ├── verify-host.js               # host 核心引擎自测（47 断言，node mock cordis ctx）
│   ├── verify-sampler.js            # sampler 双后端真实采样验证（GPU/interop 实测）
│   ├── e2e-host.js                  # P1/P2 端到端实证：真实 python 进程 + 真实 ps/kill 驱动状态机（T1-T5）
│   └── mock-test.js                 # client 半 mock 回归（verify.sh [5]，import lib/types/client）
├── docs/
│   ├── README.md                    # 文档索引（导航中心：architecture/reference/usage/plan/research）
│   ├── architecture/                # 架构设计（怎么造的）
│   │   ├── core.md                  # 核心引擎架构（原 01-architecture：采样/状态机/平衡引擎/UI 出口/V2/M1-M3）
│   │   ├── alert-notify.md          # 告警通知架构（原 research/25：分级/引擎/路由/权限/消息链）
│   │   └── ui-adapters.md           # UI 出口契约（注册策略/优先级/互斥规则/降级矩阵）
│   ├── reference/                   # 参考说明（协议/数据/里程碑）
│   │   ├── data-model.md            # 数据模型（指标枚举/ring buffer/状态机/告警分级/阈值事实来源）
│   │   ├── protocol.md              # RPC/工具/事件契约（lab-protocol 版本化）
│   │   └── milestones.md            # P0/P1/P2 验收清单
│   ├── usage/usage.md               # 使用手册（人读：工具/面板/配置/变更记录）
│   ├── plan/                        # 历史实施计划（PLAN-v1.1/1.3/1.4.5 归档）
│   ├── research/                    # 调研与设计（00-24/26/27：决策依据、issue 设计/审查）
│   ├── archive/v1.4.5-plugin/       # ★ v1.4.5 旧资产归档（plugin/ 动态版 + dev-run.sh + define.json）
└── AGENTS.md                        # ★ Agent 操作指引（lab-monitor 目录内会话自动加载：工具契约/实验识别/验证）
```

## MVP → v2 演进

| 维度 | MVP（动态插件，本会话内验证） | v2（正式插件，生产化） |
|---|---|---|
| 加载方式 | `cordis_define` 动态插件（会话级，**单文件函数体**：plugin/host/index.js 与 plugin/client/index.js 读出即为 code.host/code.client，经 dev-run.sh 组装 + node --check；**P0 前先跑最小样例验证装载可行**——T1-3；v1.4.5 源码已归档 `docs/archive/v1.4.5-plugin/`） | 正式插件：npm 包（bundle 双半 + cordis.patch.yml）或本机 profile 预设行（`cordis:group` + `isolate: true` 包服务），跨会话共享；host 拆多文件、client 出口拆 adapters/ |
| 生命周期 | 进程重启即失效 → 重启后重新 define（源码即文件，零丢失） | 随 DSH 组合行常驻 |
| Agent 预设 | 不启用 | agent-preset/lab-commander 挂载为指挥层 |
| UI 出口 | **核心层无 UI 也完整运行**；MVP 出口 = conversation.view 原生兜底（默认），better-sidebar 适配器为最后增量 | 出口可插拔：conversation.view（默认）+ better-sidebar（可选）+ webServer 自托管面板（可选） |
| 远端扩展 | 不做 | webServer SSE `/lab/events`（手机端 / 对接 monitor-panel） |

（计划 §1 演进表）

## 依赖声明事实来源（T3-2）

**MVP 以源码内对象 `inject` 为事实来源，`package.json` 仅 v2 启用**。MVP 阶段插件依赖声明写在 client/host 源码返回对象上（client 半只 `inject: ['timer']`，betterSidebar 一律 `ctx.get()` 判空可选消费——见 `docs/architecture/core.md` 依赖声明纪律）。

## 文档索引

> 完整导航见 **`docs/README.md`**（分类索引 + 每文档说明 + Agent 查阅指引）。项目内 Agent 自动加载 `AGENTS.md`。

| 分类 | 文档 | 内容 |
|---|---|---|
| 📐 架构 | `docs/architecture/core.md` | 核心引擎 7 模块 + UI 出口四出口 + V2 + M1/M2/M3 架构（§12） |
| 📐 架构 | `docs/architecture/alert-notify.md` | 告警通知架构（分级/引擎/类型矩阵/路由/权限/消息链） |
| 📐 架构 | `docs/architecture/ui-adapters.md` | 出口注册策略 / 优先级 / 互斥规则 / 能力降级矩阵 |
| 📖 参考 | `docs/reference/data-model.md` | 数据模型 + 状态机转移表 + RunRecord/Alert 字段 |
| 📖 参考 | `docs/reference/protocol.md` | RPC/工具/事件契约（冻结版） |
| 📖 参考 | `docs/reference/milestones.md` | P0/P1/P2 验收清单 |
| 📗 使用 | `docs/usage/usage.md` | **使用手册**：工具用法 + 面板 UI + 配置 + 变更记录（V2.4-V2.9） |
| 📗 使用 | `AGENTS.md` | **Agent 操作指引**（工具契约/实验识别/验证清单，自动加载） |
| 🔬 设计调研 | `docs/research/` | 00-24/26/27（决策依据；关键：22-issue5-alert-notify-design.md） |
| 📦 历史计划 | `docs/plan/` | PLAN-v1.1/1.3/1.4.5 归档 |
| ⚠️ 已知问题 | `docs/research/18-known-issues.md` | 已知问题跟踪 |

## 快速开始（MVP 阶段，已归档）

> **v1.4.5 动态版资产（`plugin/`、`scripts/dev-run.sh`、`lab-monitor.define.json`）已于 2026-08-20
> 归档至 `docs/archive/v1.4.5-plugin/`**（保留完整相对结构，可回溯）。原组装流程（D4-1 concat 六文件 +
> host/index.js → code.host、client/index.js → code.client，经 dev-run.sh 组装 + node --check 后
> `cordis_define` → `cordis_run` 激活）仅供历史参考，V2 正式插件安装见下方「V2 正式插件」。
> MVP 期验证流程（`cordis_inspect_self` 确认无 diagnostics；`scripts/verify.sh` CI 自测；P1/P2
> 状态机端到端实证见 `scripts/e2e-host.js` 与 `docs/research/10-p1-e2e-test.md`）仍适用于 V2 回归。

> 红线：禁止 Agent 重启 DSH 进程；动态插件一切副作用在 fiber 内（disposer），`cordis_stop`/`cordis_undefine` 即完全回滚。

---

## V2 正式插件（2026-08-20 迁移完成）

**形态**：从 v1.4.5 动态插件（JS concat + cordis_define）升级为 **TS 源码 + tsc/tsdown 构建的正式插件**（`dsh plugin add` 安装，跨会话常驻）。

### 快速开始（V2）

```bash
# 1. 构建（typecheck + tsc + tsdown → lib/）
cd /home/dc/projects/lab-monitor
pnpm build

# 2. 安装（link: 本地包，官方 cordis.patch.yml 自动挂载）
dsh plugin --profile web add /home/dc/projects/lab-monitor

# 3. 验证安装（bundle 入列 + 配置树含 lab-monitor 行）
dsh --profile web --dump-config | grep lab-monitor

# 4. ★DSH 重启后插件实际加载（进程红线：由用户手动重启）
#    重启后验证：better-sidebar 出现「GPU 监控」Tab / /lab-monitor/api/snapshot HTTP 可达
```

### 回归测试（V2）

```bash
scripts/verify.sh            # 全量：typecheck+构建+verify-host(47 断言)+mock-test(10 组)+verify-sampler(真实 interop)
scripts/verify.sh --e2e      # 追加 P1/P2 端到端（真实 python 进程 ~2.5min）
```

### V2 关键变化

1. **KV 缓存友好**：prompt 注入**默认关闭**（`promptInjection: false`）。v1.4.5 每模型步重渲染 labstatus 导致 KV 前缀缓存骤降（90%→50% 实证）；V2 用 `lab_status` 工具按需查询，工具结果不进 system prompt 前缀。
2. **client 数据面**：`host.call` RPC → **webServer HTTP `/lab-monitor/api/*`**。
3. **工具注册**：`harness.defineTool` → 官方 `ctx.tools.register(defineTool(...))`（lab_status/lab_advice/lab_ctl）。
4. **依赖**：peerDeps 声明 `@deepseek-ai/cordis ^4.0.1` + dsh-* 包；client 半产出 ModuleLoader bundle（`exports["./client"]`）。

### 目录（V2）

```
src/                # TS 源码
├── index.ts        # host 半入口（collector/状态机/balancer/tools/webServer 路由/prompt/hooks）
├── client.ts       # client 半（fetch 数据面 + conversation.view 兜底 + better-sidebar 适配器）
├── sampler/        # 采集后端（backend-interface / linux / windows / windows-native / windows-paths / index）
├── core/           # 核心引擎（constants / types / ring / state-machine / balancer）
├── types.d.ts      # timer/shell 模块声明合并
lib/                # 构建产物（index.js ESM + client.js ModuleLoader bundle + types/）
cordis.patch.yml    # 插件挂载 patch（dsh plugin add 自动应用）
scripts/            # verify.sh / verify-host.js / verify-sampler.js / e2e-host.js
docs/research/12-v2-migration.md   # V2 迁移设计 + KV 缓存证据链
docs/research/17-kv-cache-prompt-architecture.md  # prompt 传递与 KV 缓存调研（2026-08-20）
```

### V2.1 修复与增强（2026-08-20，plugin-specialist 诊断 + 用户需求）

1. **conversation.view 注册姿势修复**（核心 bug）：② 兜底出口必须用官方 slots 契约
   `slots.inject('conversation.view', () => slots.register(...))` 包裹（裸调 register 抛
   `slot "conversation.view" is not declared`，UI 完全不显示）。实测主页面会话区出现
   三个 tab：对话 / 轨迹 / GPU监控（② 出口生效；③ better-sidebar 适配器留后续优化）。
2. **GPU 占用列恒 `-` 修复（两层）**：
   a. `nvidia-smi pmon` 新版 9 列输出（`gpu pid type sm ... jpg ofa command`），解析改为
      **表头列名映射索引**（兼容新旧格式），不再把 gpu 索引当 pid、type 当 sm；
   b. **截断修复**：tasklist 按 pid 序输出，`slice(0,15)` 截到前 15 个系统进程，真实 GPU
      活动进程（chrome/explorer/llama-server…）被丢弃 → 新增 `prioritizeGpuProcs`
      （有 GPU 值的进程置顶、按利用率降序，再补足到 15）。
3. **趋势首帧加载 + 空闲可见**：面板 init() 首帧并行拉取历史曲线（此前 hist=null → 趋势
   不渲染，直到 5s 后 tick）；MiniTrend 数据不足时显示"数据积累中…"；Y 轴动态区间
   （最小跨度 10）+ 折线加粗 2px + 浅色基线——GPU 空闲（全 0%）时折线不再贴底不可见。
4. **进程展示优化**（需求）：进程表加 GPU%/CPU%/内存 列（GPU 优先读 `gpuUtilPct` 回退 `gpu`）；
   常见默认进程聚合分组（浏览器/编辑器/Docker/系统/其他应用）折叠展示。
5. **watchProcs 进程注册**（需求）：`LabMonitorConfig.watchProcs: string[]` 静态配置 +
   `lab_ctl watch` 运行时动态注册；命中进程在快照 `watchedPids` 标记（面板置顶高亮预留）。
   `lab_status` 输出附加 `watchlist` 字段。
6. **KV 缓存调研**（需求）：docs/research/17 结论——当前「promptInjection 默认关 + lab_status 工具」
   已是 KV 最优；如开启注入须「静态前缀 + 动态尾部(order 990) + 变化限频」三条约束。
7. **诊断命令误报**（已知项）：`curl | python3 -c` 等管道命令命中 `python -c` 训练特征生成假实验，
   属检测策略权衡（收紧可能漏真实训练），待用户决策是否加管道排除规则。

### V2.2 修复与增强（2026-08-20，plugin-specialist 实施 + codex 交叉审查）

1. **lossless JSON 输出修复**（核心 bug）：dsh-tools 注册表对工具返回值做 `isJsonValue`
   校验（NaN/Infinity/undefined/BigInt/-0/环引用 → `value is not lossless JSON`），此前
   `lab_status`/`lab_advice` 在 nvidia-smi/CIM 输出 `N/A`（解析得 NaN）时直接打挂。
   双层修复：
   a. **采样解析安全降级**：`parseSmiLine` num() 非有限数→0；CIM cpuPercent 非有限→null、
   内存→0（WindowsBackend）；`sumCpu/sumMem/sumGpu` 改用 `Number.isFinite`（proc-aggregator）。
   b. **出口统一清洗**：`sanitizeJson()` 递归拷贝（undefined→null、非有限→null、-0→+0、
   深度上限 12）——`buildSnapshot()` 与 `lab_advice` 返回值全量过一遍，防任何残留路径
   逃逸校验。verify-host [E] 新增 N/A 场景断言：快照/lab_status/lab_advice 全 lossless、
   utilPct=0、cpu.percent=null。
2. **settings 持久化（P2 2' 落地）**：`settings.register('lab-monitor', Schema.object({ thresholds,
   watchProcs }))`——schemastery 为 devDep+peerDep（symlink 安装，Node 从项目 node_modules 解析）。
   register 读磁盘文档 → `thresholds.apply(stored, true)` + watchProcs 过滤重挂 → `settingsScope.watch()`
   响应外部修改；`persistState()` 在 setThresholds / rpcSnapshot(携带阈值) / `lab_ctl watch` 后写回。
   verify-host [D]/[E]：写回 `user.thresholds.memWarn=80`；重启模拟（新 fiber + documents 保留）→
   阈值恢复 80、watchlist 恢复并命中 llama-server(5555)。
3. **客户端三项 UI（known-issues 2b/3/4）**：
   a. **进程组展开**：`ProcsTable` 组件化，聚合组标题行可点击展开成员（▼/▸）；watchlist 命中行置顶。
   b. **告警聚合**：`AlertList` 组件化，同 rule 合并计数（×N）、msg 120 字截断 + title、级别着色、
      默认 2 条 + 「还有 N 条（点击展开全部）」。
   c. **刷新同步**：tick 内 `Promise.all([refresh(), fetchHistory()])` 合并拉取；status 行显示
      「数据 <快照时刻>」+ title 提示（替代 lastFetchAt）。
   mock-test [4] 渲染树断言增强：walk 支持函数组件浅渲染（独立 hook 容器，防 useState 索引串扰）。
4. **趋势图真根因修复（截图核验定位）**：MiniTrend 此前用 `<polyline points>` 渲染 path 命令串
   （`"M4 52 L12 50"`）——SVG polyline 只接受坐标对，非法属性被浏览器忽略 → 折线永不渲染。
   改为 `<path d>`（原生支持 M/L）+ stroke 硬编码 `#3964fe` + SVG `minHeight: 56`
   （known-issues 问题 1；此前误判为 CSS 变量颜色问题，stroke 硬编码后仍不可见反证颜色非根因）。
5. **展示层核验三项（截图驱动）**：普通进程行加「其他进程（N）」标题 + 上分隔线（无组匹配进程
   不再被误读为组内成员）；`fmtGiB` 小内存（<0.1GiB）显示 `<0.1`（不再 0G 误读）。
6. **测试脚本配套**：verify-host.js settingsMock 拆 `documents`（持久化文档层，可预置模拟重启）
   与 `namespaces`（注册表，register 从 documents 初始化）——修复重启模拟时 register 误判
   "already registered" 的问题。

> 注意：1/2/4 的 **host 半改动需 DSH 重启生效**（进程内加载旧 lib/index.js）；3 为 client 半改动，浏览器刷新即生效。

### V2.3 多轨实验 + 标签分组（2026-08-20，A2 实施，需求讨论后落地）

1. **多轨实验并行跟踪（A2，原 R-2「多轨并存留 v2」）**：
   - `state-machine` 单轨 → 多轨：`runs: Map<runId, RunRecord>` 并行跟踪，上限 `MAX_PARALLEL_RUNS=4`
     （满 4 时新 start 归档最旧 running 为 aborted；v1「新 start 即归档旧 run」语义废弃，P1 验收 7 已更新）；
   - **per-run 独立判定**：`pidMissingStreak` 移入 RunRecord，每个实验各自 findAliveProc + BFS 组扩张 +
     done/crashed 双确认，互不干扰；
   - **result 归属**：`markResult(paired, runId?)`——runId 精确归属优先，无 runId 时指纹匹配主实验
     （T1-2 复用）；**追踪主键 = runId + cmdline 指纹，pid 为关联结果**（实验重启/pid 变化自动重关联，R3）；
   - 协议：`snapshot.experiment` 保留为主实验（最近 start），新增 `experiments[]` 承载全部并行实验
     （向后兼容，老 client 照常工作）。
2. **标签分组（用户需求：手动打标签分组展示——系统固定开销/日常客户端/脚本进程）**：
   - `TagRule { id, label, patterns[], kind: 'experiment'|'process', color? }`——**cmdline 正则匹配**，
     脚本形态天然覆盖（ps/tasklist 看到的是解释器进程，脚本路径在 cmdline：`python E:\exp\train.py`、
     `powershell -File deploy.ps1` 均按 cmdline 特征命中）；
   - **`lab_ctl tag` 三操作**：`add`（label + patterns 正则，或 label + pid 快速打标——自动提取
     该进程 cmdline 生成规则，等价规则式，重启后仍命中）/ `remove` / `list`；规则存 settings
     持久化（lab-monitor 命名空间 `tags` 键）；
   - 快照 `tags[]` 聚合：每组命中 pids/procs + GPU/CPU/内存聚合；`kind=experiment` 附归属实验 runIds；
   - UI：实验状态块多轨展示（主实验 + 并行列表，各带状态/时长/pid/cmd）；标签分组卡片在进程表前
     （experiment 组显示状态/时长/曲线，process 组显示资源占用，组头色点 + kind 徽标 + 聚合统计）。
3. **测试**：verify-host [B3]（多轨：并行 2 实验独立判定、主实验切换、上限 4 归档、清理）+ [E2]
   （标签：add 正则/pid 快速打标/list/remove/非法正则守卫/持久化）；mock-test 全绿。

> 注意：本段 **host 半改动（state-machine/协议/tag 引擎）需 DSH 重启生效**；client 半（实验块/标签分组 UI）浏览器刷新即生效。

### V2.4 P0 三件修复（2026-08-22，plugin-specialist 排查 + 实施）

> 来源：完整排查报告（运行时实测 + 源码审计）。核心引擎健康（采样/状态机/多轨/标签/持久化全绿），
> 本段修复用户视角最扎眼的三个体验/正确性缺陷，均含 verify-host 新增断言回归。

1. **`lab_status brief` 摘要恒显示「GPU 无 · 告警: 无」**（显示 bug，实测矛盾）：brief 模式 execute 返回
   信封 `{ok:true,line}`，render 把信封当快照二次调 `promptLine()` → gpu 必为 undefined → Agent/UI
   永远看到假摘要。修复：render brief 分支直接使用信封内 line（无则回退 JSON 序列化）。
2. **告警生命周期（修复"badge 恒 8 / advice 被 11h 前旧 crash 污染"）**：
   a. **TTL 24h 自动过期**：`balancer.pruneExpired()`——超过 24h 的告警自动从列表弹出并扣减
      criticalCount（pause 状态下 snapshot/advice/count 读取时兜底清理）；
   b. **`lab_ctl clear-alerts`**：全清（alerts + criticalCount 归零）或按 `runId`/`rule` 定向清除
      （如 `lab_ctl clear-alerts rule=experiment-crash`），HTTP 面 `control` 路由同步支持；
   c. **容量截断计数修正**：ALERT_MAX 截断时同步扣减被截 critical（此前 count 只增不减）。
3. **watchlist 命中进程置顶可见**（修复"watchedPids 有标记但 UI 永远看不到命中行"）：buildSnapshot
   进程排序改为 watch 命中先行 + 其余 GPU 优先补足 15 行——空闲 llama-server 等无 GPU 活动进程
   不再被 15 行截断切掉，面板置顶高亮真实生效。
4. **测试配套**：verify-host 新增 [C2] 告警生命周期段（TTL 过期回落 / rule+runId 定向清除 / 全清归零，
   8 断言）+ watch 置顶断言；修复 e2e-host.js mock ctx 缺 `setTimeout`/settings `register` 桩
   （V2 apply 的 M4 重探链路在 e2e 脚手架下崩溃，补桩后 e2e 恢复 ALL PASS）。

> 注意：本段全部为 **host 半改动（render/balancer/buildSnapshot/工具注册），需 DSH 重启生效**（进程内加载旧 lib/index.js）。

### V2.5 P1 实验历史复盘 + 设置面 + 使用文档（2026-08-22，继续 plugin-specialist 排查批次）

> 前情：V2.4 修完三件 P0 后用户指示「继续 P1」。本段落地三件事：① 实验历史保留 + **复盘入口**（此前实验结束即被状态机丢弃，无任何存档）；② **设置面补全**（此前阈值/watch/标签只能靠 Agent 工具改，面板无任何设置/控制入口）；③ A1 使用文档交付。

1. **实验历史保留 + 复盘**（`ended[]` 协议，纯增量追加）：
   - 状态机归档扩展：done/crashed/aborted 结束时除 event 外同时生成**指标摘要**（GPU 利用率峰值/均值、
     显存峰值、组 CPU/内存峰值、时长等，`archive()` 时 buildSummary）存入 history（上限 20，最新在前）；
   - 快照新增 `ended[]`（`{ runId, state, cmd, cmdFeature, startTs, endTs, summary }`）；
   - UI：面板新增「▸ 实验历史（N）」折叠块——每行 runId + 状态徽标（完成/崩溃/中止）+ 时长 +
     GPU 峰值/均值 + 显存峰值 + 组 CPU 峰值 + cmd；点击展开。
2. **设置面补全（ControlPanel）**：
   - 面板新增控制卡片：阈值输入（GPU利用%/显存%/温度°C）+ **保存**（走 HTTP `setThresholds`，即时生效
     + settings 持久化，重启保留）、**暂停/恢复**（`control`，暂停时跳过采样但快照照常返回）、**清除告警**
     （`control` clear-alerts，带 critical 计数徽标）；外部（lab_ctl/settings.yaml）改阈值后面板表单自动跟随；
   - **轮询周期动态驱动**：快照新增 `thresholds`/`enabled` 透出——client 轮询间隔改由
     `thresholds.pollMs`（1000–60000 钳制）驱动，`lab_ctl set-threshold pollMs=3000` 或面板改值即实时生效，
     无需改配置重启（此前 pollMs 是无处可配的死字段，排查发现）；
   - 顺带清理：`promptInjection`/`sampleMs` 确认在插件形态下不可配（无 config 槽位），维持现状记录在案。
3. **使用文档（A1）**：`docs/usage/usage.md`——lab_status/lab_advice/lab_ctl 三工具完整用法手册（含 schema 实测）、
   面板 UI 指引、阈值与告警语义表、多轨跟踪语义、watchlist/标签、settings.yaml 持久化说明、HTTP 数据面与
   鉴权警示、变更记录。
4. **测试配套**：verify-host 新增 P1 断言段（ended[] 初始空/协议完整性/done/crashed/runId 精确匹配/
   aborted 归档/thresholds 透出 memWarn=80/pollMs=3000/enabled pause↔resume，13 断言）+ **修复 cap 场景测试盲区**
   （此前 FAKE.psLines 每循环覆盖导致 crash 抢先，上限 aborted 分支从未被覆盖——累积 pid 后真正触发）；
   mock-test 新增 5 条 P1 渲染断言（实验历史折叠头/轮询周期/启停状态/清除告警计数/保存按钮）；
   `docs/reference/protocol.md` 升级 1.4（ended/thresholds/enabled 三字段契约）。

> 注意：本段 **host 半改动（协议字段/状态机归档）需 DSH 重启生效**；client 半（实验历史块/控制面板/pollMs 驱动）浏览器刷新即生效。

### V2.6 实验历史持久化 + HTTP 暴露面实证（2026-08-22，P2 批次）

> 触发：V2.5 交付后浏览器端到端验证（Playwright MCP）发现「实验历史重启即失」——用户看到面板
> 出现「实验历史（1）」后 DSH 重启即消失（history 纯内存）。本段修复该真实缺陷。

1. **实验历史持久化（settings 命名空间 lab-monitor `history` 键）**：
   - 状态机新增 `restoreEnded(EndedRunSnapshot[])`——settings 读回的 ended 投影重建为最小 RunRecord
     追加 history 尾部（旧数据在后，新归档 unshift 在前），保持上限 20；已结束记录不进 runs 判定；
   - 写回：`persistState()` 载荷增加 `history`（ended 投影，倒序与 snapshot() 一致）；**惰性触发**——
     `buildSnapshot` 出口检测 `history[0].endTs` 变化才落盘（新归档 ≤1 轮询周期写入，正常轮询零写入；
     重启恢复后与持久化比对一致不重复写）；
   - schema：`history: Schema.array(Schema.object({runId,state,cmd,cmdFeature,startTs,endTs,summary}))`
     `.default([])`（`MAX_HISTORY=20` 常量统一 history 上限）。
2. **HTTP 暴露面实证（修正认知）**：Tailscale IP `100.64.0.2:13080` 访问 `/lab-monitor/api/*` 实测
   **超时不可达（000）**——`--trusted-host` 当前未暴露该端口，暴露面 = **localhost only** ✅；
   此前「HTTP API 零鉴权」风险在当前网络配置下不成立，降级为防御性 backlog（若未来配置端口转发需先加鉴权）。
3. **测试配套**：verify-host 重启模拟段（ctxd3 documents 保留 → 新 fiber apply）新增 3 断言——
   重启后 ended[] 恢复 / runId 精确（runA done + runB crashed）/ summary 结构完整；全量回归绿。
4. **端到端实证（2026-08-22 真实 DSH + Playwright MCP 浏览器）**：重启后 DSH 工具通道跑
   `python3 -c 'import time; time.sleep(6)'` → 归档后 **`~/.dsh/settings.yaml` 落盘 `history` 键**
   （run-20260822-001 done，summary 含 gpuUtilMax 6/avg 4/memPeak 1917/durationSec 10）→ 面板
   「实验历史（1）」展开显示与持久化数据一致（GPU峰值 6%/均 4%/显存峰值 1.9G/10s）——写回链路实测闭环。
5. **顺带记录**：known-issues 问题 6 补充「实验历史只存内存」为已修复（V2.6）。

> 注意：本段 **host 半改动（持久化链路），需 DSH 重启生效**（client 无改动，浏览器刷新即可）。

### V2.7 进程展示增强：家族聚合 + 采样自曝过滤 + 上限放宽（2026-08-24）

> 触发：用户反馈"打开折叠的进程有很多重名进程"（404 进程仅 141 种程序名）。
> 专项：plugin-specialist 重名进程分析 → ①②③ 落地。

1. **③ 采样自曝过滤**（`backend-windows.ts` 新增 `purgeSamplerSelf()`）：剔除 tasklist.exe/nvidia-smi.exe
   采样工具自身 + 其伴随 conhost（ppid 指向采样工具），用户程序 conhost 不受影响——实测 tasklist/nvidia-smi
   从进程表清零。
2. **① 组内二级折叠**（`client.ts` ProcsTable）：展开分组后按 cmd 名聚合 → "chrome.exe ×40" 一行，点击展开 PID 明细。
3. **② 家族归类**（`client.ts` `PROC_FAMILIES` ~90 条映射）：组 → **家族行**（如 `Windows 系统 ×167`）→ 种类行 → PID 明细
   三级折叠；系统进程组正则补全（svchost/conhost 等归组）；WeChatAppEx 归常用应用组（微信家族不再跨组分裂）。
   实测：141 种 → 79 家族行，折叠态密度提升近半。
4. **procTopN 上限 500 → 1000**（两处 clamp + 设置页文案；用户配置 400 曾被 200 上限静默截断，链路实测定位）。

### V2.8 实验历史管理（#10）+ M2 实验类型识别（#6）（2026-08-24）

1. **实验历史管理（issue #10）**：`machine.removeRun/clearHistory`（splice 修复空洞 bug）+
   `rpcHistoryManage`（list/delete/clear+keep 最近 N）+ `lab_ctl history-manage` action +
   HTTP `/lab-monitor/api/historyManage` + 设置页「实验历史管理」块（列表/单删/清空保留 N）；删除/清空显式持久化。
2. **M2 实验类型识别（issue #6，docs/research/22 §3）**：
   - 新增 `src/core/exp-type.ts` `classifyExpType` **三层识别**：配置层（experimentTypes 规则）→ 自动层
     （EXP_TYPE_PATTERNS 8 类保守正则 + TRAIN_PATTERNS 门控 gpu-train）→ 学习层（fingerprint 历史时长 p90 ≥3600s → long）
     → 兜底 unknown 不猜；
   - 数据面：`RunRecord.type` + 快照/ended 透出 + **restoreEnded 补存 fingerprint**（学习层前置修复）；
   - 配置面：settings `experimentTypes/expTypeDefault/expTypeLearning` 三键；
   - **通知矩阵接线**：告警 runId → run.type → 配置覆盖 > `EXP_TYPE_DEFAULT_NOTIFY` 出厂矩阵 > 全局 fallback
     （gpu-train×warn→wake、smoke×warn→off 等）；
   - client 实验历史行类型徽标（unknown 不显示）。
   - 验证：24 项单测 + 误报回归（grep/heredoc/zipfile/env-check 均不猜）+ 端到端模拟 + 真实 DSH 实测
     （`python3 -c "...nn.Module(); backward()..."` → gpu-train，pyc: 指纹持久化）。

### V2.9 M3 通知链路闭环（#7）+ 实测修复（2026-08-24）

> 触发：issue #7（M3 子代理路由/权限/消息链）——issue #5 全链路最后阶段。docs/research/22 §4/§5 设计落地。

1. **① 路由**（§4）：`RunRecord.agentId/agentRole/parentId` + pre-execute 读 `exec.agent`（session.id + header 判主/子）
   + agentDir 运行时索引（agent/created|disposed|status + rootAncestors 根祖先链 + isSubagentAgent）；
   notifyAlerts **路由决策树**：发起者优先（子代理 → 发起者按矩阵档位 + 根祖先 notice 知情；crashed → 子代理降 notice
   + **根 wake 接管**；发起者 absent/disposed → **立即升根 roots**；无实验上下文 → roots 兜底）。
2. **② 权限**（§5）：`subagentPolicy`（readonly 默认/restricted/full，settings 持久化）+ host 全局
   `tools.guard` 执行期拒绝子代理 `lab_ctl`（谓词读策略存储；restricted 白名单 watch/tag/history-manage 放行）+
   `registerContinuableSetup` 注入只读 `lab_status_ro` + restrict deny lab_ctl（可继续子代理 fresh+cold resume 生效）。
3. **③ 消息链**（§4.3）：仅链断裂证据触发——证据1：wake 档 followup 投递子代理后 `notifyTimeoutMs` 内无
   `agent/inbox/claimed` → 超时升根；证据3：`subagent/end` 异常结算（max-tokens/error/cancelled）且有在途实验 → roots 升根；
   投递预算 ≤2；明确不做「无活动即转发」（B1：静默处理是常态路径）。
4. **两个实测修复**：
   - `makeRunId` 重启重复（日期+计数器 → **日期+HHMMSS+计数器**，仿 makeTagId；实测 run-20260824-001 出现两条）；
   - 通知投递 off 档误投递（M1 遗留 `t.level==='off' ? 'notice'` fallback 把 info 级告警打扰主代理，链路实测抓到；
     改为 off 直接跳过，符合设计 §2.2「info 仅 UI/工具可见不投递」）。
5. **验证**：M3 逻辑单测 14 项（路由决策树/guard/isSubagent）+ verify.sh 7 组全绿 + **真实链路实测**
   （memWarn 调低触发 other-occupancy → lab/alert 事件 → 投递日志 → 用户收到告警消息；agentId 链路、settings 持久化确认）。

> 注意：V2.7-V2.9 **host 半改动均需 DSH 重启生效**（client 半刷新页面即可）。

### V2.10 #17 误判修复 + 显式实验跟踪（2026-08-27）

> 触发：issue #17——`run_code` 工具代码体（含 `python train*.py` 字样）被 pre-execute 误判为实验，
> 进程消失触发 experiment-crash 误报（critical/wake 噪音，实证 run-20260827-185517-001）。

1. **源头修复**：pre-execute 仅 `bash`（明确 shell 执行）参与 `TRAIN_PATTERNS` 匹配——`run_code`/write/edit
   等工具的代码体/文本内容不再参与（代码里的示例命令不再误记为实验；run_code 内嵌套 `tools.bash` 自带独立
   pre-execute，真实训练不漏检）。
2. **幽灵 run crash 门控**（`isGhostRun`）：从未关联进程 + 时长 <30s + 无资源活动证据（GPU 峰值 <10% 且组 CPU
   峰值 <5%）的 run 归档 `aborted`（进历史可复盘，不触发 experiment-crash 告警）——防工具代码体/文档文本误判的
   第二道防线。
3. **显式注册实验跟踪（`lab_ctl track`）**：用户可显式指定命令作为实验监控——`track add`（pattern 正则或 pid
   快速注册）命中 cmdline 的命令无条件建 run（`source=explicit`，`cmdFeature=explicit:<label>`），不受
   TRAIN_PATTERNS 保守识别限制（如 `python infer.py`/`vllm serve`）；显式 run **跳过幽灵豁免**（crash 严格判定）；
   规则持久化（settings `trackRules`），HTTP 面 `/lab-monitor/api/track` 等效路由。
4. **验证**：verify-host 新增 [A2.5]（run_code 不误判）/[A2.6]（track 显式跟踪闭环）/ [B2.5]（幽灵 run 豁免）/
   [B2.6]（显式 run 严格 crash）/[B2.7]（通知路由绑定发起 session）五段回归 + verify.sh 7 组全绿；契约 protocol.md 升 1.5（source 字段 + track 路由）。
5. **#17 衍生修复（通知路由绑定发起 session）**：误判 crash 告警曾因 `agentDir` 缺宿主会话条目（无
   `agent/created` 登记）走 absent 分支广播 `roots()`，唤醒全部 root 会话（实测多个 session 启动）。
   修复：目录缺失 ≠ 目标不可达——先 `agentsSvc.get(run.agentId)` 精确投递发起会话，真不可达才广播；
   同时 `persistState` 历史持久化补存 `agentId`（重启恢复后路由仍绑定发起会话，不退回 roots 广播）。

## 未完成项清单（2026-08-20 对照 PLAN v1.4.5 + 04-milestones）

> 对照依据：PLAN §0 三层组合 / §1 目录树 / §6 风险表 / §4 验收清单；04-milestones 勾选状态。
> 分类：A = 计划明确要求但代码未实现；B = 验收遗留（需真实环境/GUI）；C = 可选增强（非阻塞）。

### A 类：计划明确要求，代码未实现

| # | 未完成项 | 文档依据 | 现状 |
|---|---|---|---|
| A1 | ~~指挥层 Agent 预设 lab-commander~~ → **使用文档**（lab_status/lab_advice/lab_ctl 用法手册） | PLAN §0 三层组合第 2 层、§1 目录树 | ✅ **2026-08-22 落地（V2.5）**：`docs/usage/usage.md`——工具用法手册 + 面板 UI + 阈值/标签/多轨语义 + 持久化说明；用户决策不做 Agent 预设（插件功能未完善时预设无收益）；prompt 注入增强待讨论（KV 缓存影响） |
| A1.5 | **告警通知闭环（issue #5 方案 M1→M3）** | docs/research/22-issue5-alert-notify-design.md（设计）+ 23 评审 + 25 架构 | ✅ **M1（2026-08-23，V2.7→V2.8）**：告警严格分级（Alert 8 扩展字段 severity/urgency/trend/sustainedMs/resource/origin/notifyLevel/escalate + rule 权重表 + warn 升级）+ 通知策略引擎（effectiveLevel→档位→resolveAction 全格→投递；节流/指纹去重/预算守卫/clear 重置）+ 配置面（settings 六键 + lab_ctl set-notify + 设置页 NotifyCard）+ TRAIN_PATTERNS 精度修复。**M2（#6）+ M3（#7）（2026-08-24，V2.8→V2.9）**：实验类型三层识别（配置>自动>学习>unknown 不猜）+ 类型×通知矩阵接线（gpu-train warn→wake 等）+ 子代理路由（发起者优先/根祖先知情/absent 升根）+ 权限（subagentPolicy + guard 拒 lab_ctl + lab_status_ro）+ 消息链兜底（异常结算/未领取超时升根）。**issue #5 全链路闭环**（剩余「prompt 注入形式」与 KV 缓存冲突，维持工具按需查询——17-kv-cache 决策） |
| A2 | **多实验并行跟踪**（R-2「多轨并存留 v2」） | 风险 11 | ✅ **2026-08-20 实施完成（V2.3）**：多轨（上限 4 + per-run 判定 + runId 归属）+ 标签分组（规则式打标 + lab_ctl tag + tags 聚合 + UI 分组展示）；verify-host [B3]/[E2] 全绿 |
| A3 | webServer 自托管面板（出口④） | 风险 14 + §3.2.4（「v2 前置」） | 仅实现 HTTP 数据面 `/lab-monitor/api/*`；自托管 HTML 面板未实现 |
| A4 | SSE `/lab/events` 远端扩展 | README v2 演进表「webServer SSE /lab/events（手机端/对接 monitor-panel）」 | 源码无 SSE/EventSource 实现 |

### B 类：验收遗留（需真实环境/GUI）

| # | 未完成项 | 说明 |
|---|---|---|
| B1 | **P0 2' 会话端到端**（callCount 与 UI 5s 节奏对照） | host 侧 callCount 字段已就绪；conversation.view 已生效（截图确认）→ 现可 GUI 复核 |
| B2 | **P0 3' 真实无 GPU 机实证** | 环境受限（本机有 GPU）；降级路径由 verify-host 自测覆盖，留待目标环境 |
| B3 | **P0 6' 互斥形态真实设置模拟**（aionui-panel.rightPanel） | 逻辑由 mock-test [10] + verify-host [F] 覆盖；live 模拟需 better-sidebar 环境 |
| B4 | **P2 5 better-sidebar 真实注册（GUI 实测）** | 用户确认保持 conversation.view（②）现状，③ 未启用——有意保持 |
| B5 | **回归红线（§5.5）**：改 client 半后重跑 P0 验收 1/2/5/6 + 断连自愈 | 流程项；mock-test/verify-host 已全绿，真实 GUI 复核待安排 |

### C 类：可选增强（非阻塞）

- **告警静默窗口**（风险 6「静默窗口 v2」）：手动确认/临时忽略某类告警
- **编排层 Agent-teams**（v3 可选）：多实验并行/超参扫描、共享 GPU 池调配——明确不在当前范围
