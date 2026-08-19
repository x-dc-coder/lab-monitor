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
│   └── lab-commander/
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
```
