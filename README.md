# Lab Monitor（科研实验监控助手）

> 依据：实施计划 v1.4.5（`docs/PLAN-v1.4.5.md`，唯一事实来源；本文档及 docs/01~05 与其完全一致，修订需同步计划）

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

（计划 §2 原图；详见 `docs/01-architecture.md`）

## 目录结构

```
/home/dc/projects/lab-monitor/
├── README.md                        # 本文件：总览、架构图、快速开始
├── agent-preset/                    # v2「实验指挥」Agent 预设（★v2 启用，MVP 不实现——T3-3）
│   └── lab-commander/               #   ⚠️ 2026-08-20 对照：仍未实现（仅 .gitkeep，persona/RULES/tools 三文件待补）
│       ├── persona.md / RULES.md / tools.md
├── scripts/
│   ├── verify.sh                    # CI 式自测：node --check + 目录完整 + 契约静态核对 + 四测套
│   ├── verify-host.js               # host 核心引擎自测（47 断言，node mock cordis ctx）
│   ├── verify-sampler.js            # sampler 双后端真实采样验证（GPU/interop 实测）
│   ├── e2e-host.js                  # P1/P2 端到端实证：真实 python 进程 + 真实 ps/kill 驱动状态机（T1-T5）
│   └── mock-test.js                 # client 半 mock 回归（verify.sh [5]，import lib/types/client）
├── docs/
│   ├── PLAN-v1.1.md / PLAN-v1.3.md / PLAN-v1.4.5.md  # 实施计划归档（v1.4.5 为当前事实来源）
│   ├── 01-architecture.md           # 架构基线（核心/出口分层）
│   ├── 02-data-model.md             # 指标枚举 / ring buffer / 状态机 / 告警分级 / 阈值事实来源
│   ├── 03-protocol.md               # host.call RPC 契约（JSON schema 版本化）
│   ├── 04-milestones.md             # P0/P1/P2 验收清单（可勾选）
│   ├── 05-ui-adapters.md            # UI 出口层契约：注册策略/优先级/互斥规则/降级矩阵
│   ├── archive/v1.4.5-plugin/       # ★ v1.4.5 旧资产归档（plugin/ 动态版 + dev-run.sh + define.json，2026-08-20）
│   └── research/                    # 调研归档（00-t8 基线 / 01 外部 / 02 内部资产 / 03 sidebar 契约 /
│                                    #   04 评审 / 05 0.13.0 契约 / 06 复审 / 07 webServer 预审）
└── .gitignore
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

**MVP 以源码内对象 `inject` 为事实来源，`package.json` 仅 v2 启用**。MVP 阶段插件依赖声明写在 client/host 源码返回对象上（client 半只 `inject: ['timer']`，betterSidebar 一律 `ctx.get()` 判空可选消费——见 `docs/01-architecture.md` 依赖声明纪律）。

## 文档索引

| 文档 | 内容 | 对应计划章节 |
|---|---|---|
| `docs/01-architecture.md` | 核心引擎层 7 模块 + 出口适配层四出口 + 解耦契约 + 依赖声明纪律 | §2 / §3.1 / §3.2 |
| `docs/02-data-model.md` | 数据模型 + 状态机转移表 + 单实验跟踪 + ring buffer + 阈值事实来源 | §3.1 / T1-1 / T1-2 / R-2 / R-3 / V2 |
| `docs/03-protocol.md` | RPC 契约 + 工具契约 + 事件信封（**冻结版，D-A/D-B1 共同契约**） | §3.1 rpc/tools / M3 |
| `docs/04-milestones.md` | P0/P1/P2 验收清单（勾选制） | §4 / §5.5 |
| `docs/05-ui-adapters.md` | 出口注册策略 / 优先级 / 互斥规则 / 能力降级矩阵 | §3.2 / §6 风险 1/13/15 |
| `docs/research/` | 调研与评审归档（07 篇） | t1~t8 各轮输出 |
| `docs/research/18-known-issues.md` | **已知问题跟踪**（2026-08-20：趋势可见性/表格折叠/告警展示/刷新同步） | 后续迭代 |

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

## 未完成项清单（2026-08-20 对照 PLAN v1.4.5 + 04-milestones）

> 对照依据：PLAN §0 三层组合 / §1 目录树 / §6 风险表 / §4 验收清单；04-milestones 勾选状态。
> 分类：A = 计划明确要求但代码未实现；B = 验收遗留（需真实环境/GUI）；C = 可选增强（非阻塞）。

### A 类：计划明确要求，代码未实现

| # | 未完成项 | 文档依据 | 现状 |
|---|---|---|---|
| A1 | **指挥层 Agent 预设 lab-commander** | PLAN §0 三层组合第 2 层、§1 目录树（persona/RULES/tools 三文件，★v2 启用） | `agent-preset/lab-commander/` 仅 .gitkeep，三文件全缺 |
| A2 | **多实验并行跟踪** | 风险 11（R-2「多轨并存留 v2」） | state-machine 仍单跟踪：新 start 归档旧 run 为 aborted（`src/core/state-machine.ts`） |
| A3 | **webServer 自托管面板（出口④）** | 风险 14 + §3.2.4（「v2 前置」） | 仅实现 HTTP 数据面 `/lab-monitor/api/*`；自托管 HTML 面板未实现 |
| A4 | **SSE `/lab/events` 远端扩展** | README v2 演进表「webServer SSE /lab/events（手机端/对接 monitor-panel）」 | 源码无 SSE/EventSource 实现 |

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
