# 01 架构基线（核心引擎层 + UI 出口适配层）

> 来源：实施计划 v1.3 §2/§3.1/§3.2（`../docs/PLAN-v1.3.md`）。本文档与计划完全一致，是 Lab Monitor 的架构定稿。

## 1. 分层总览

| 层 | 位置 | 内容 | 独立性 |
|---|---|---|---|
| **核心引擎层** | Host 半全部 + Client 半「数据消费者」 | collector / ring-buffer / state-machine / balancer / hooks / rpc / tools / prompt 注入；只依赖平台内建（timer/shell/harness/systemPrompt + tools/* 平台事件） | **不 import/依赖任何第三方服务；无任何 UI 也完整运行**（采集/告警/工具/prompt 注入/事件广播） |
| **UI 出口适配层** | Client 半出口分区 + 可选 web 出口 | ① Agent 通道 ② conversation.view ③ better-sidebar ④ webServer 自托管面板 | 各出口独立 `ctx.effect` 注册、互不干扰；只消费 host.call 快照与 lab/* 事件，**不反向依赖核心层** |

## 2. 核心引擎层（Host 半，7 模块）

> **核心层独立性声明（计划 §3.1）**：以下全部模块只依赖平台内建（`timer`/`shell`/`harness`/`systemPrompt` 服务与 `tools/*` 平台事件），不 import/依赖任何第三方服务；无任何 UI 出口时完整运行。`rpc.js`（harness.handle）与 `ctx.emit('lab/*')` 是核心层**对外唯一数据/事件面**，出口层只消费这两者。

### 2.1 sampler/ —— 采集后端抽象（v1.4 重构）

> 事实基线（docs/research/08-sampling-empirical.md）：**WSL 内没有 nvidia-smi**，GPU 采样走 Windows interop（`/mnt/c/Windows/System32/nvidia-smi.exe`：query 40–60ms、dmon 流 1s 行流）；cmd/powershell 裸名不在 PATH（完整路径）；PowerShell CIM ~1.5s（chcp 65001 + UTF8）、tasklist GBK→iconv；/proc 原生；WSL 内存视图 14.3GB ≠ Windows 31.7GB——platform 必须进数据模型。

> **MVP 运行时边界（P0 收尾实证，2026-08-19）**：动态插件为**会话级隔离**——`lab-monitor.define.json`（v1.4.5，已归档 `docs/archive/v1.4.5-plugin/`）经 `cordis_define` 装载后仅当前 DSH 会话可见，重启/换会话需重新 define；`cordis_inspect_self` 在其他会话（如子代理）返回空属正常现象，非缺陷。v2（正式插件，package.json + cordis.patch.yml）安装后跨会话常驻，见 README「MVP/v2 演进」。

**① SamplerBackend 接口**（backend-interface.js，对齐 netdata 五方法 + nvitop TTL + psutil 差分，t10 §2）：

| 方法/字段 | 语义 |
|---|---|
| `probe()` | 探测环境可用性（= netdata Check）；绝不抛错，返回 `{ ok, reason?, detail? }` |
| `snapshot()` | 一次性全量采样（= netdata Collect）；规范化指标 JSON |
| `stream()` | 长驻增量流（GPU dmon 行流）；无流能力返回 null；上层负责行→指标解析 |
| `close()` | 释放资源（**杀 interop 子进程、清缓存**）；幂等防孤儿（WSL 父进程死 Windows 子进程存活） |
| `cacheTtlMs` | 后端内建查询 TTL（nvitop ttl_cache）；interop 40–60ms/次，缓存窗口内不重复 fork |
| `lastCpuTimes` | CPU 差分基线（psutil：首帧丢弃、负值截 0）——后端内维护 |

**② 双后端组成**：LinuxBackend（/proc+ps，零依赖，纯 Linux 场景）/ WindowsBackend（nvidia-smi.exe query+dmon + PowerShell CIM + tasklist，interop 通道）/ WindowsNativeBackend（预留桩）。

**③ 平台分发**（sampler/index.js）：detectPlatform **双保险**——`/proc/version` 含 `microsoft` 且 `/proc/sys/fs/binfmt_misc/WSLInterop` 存在 → 'wsl' → WindowsBackend；纯 Linux → LinuxBackend；未来 win32 → WindowsNativeBackend。

**④ 快照协议**：`{ ts, platform, sources, gpu[], cpu, mem, procs[], degraded }`——`platform`（'linux'|'wsl'|'windows-native'，内存视图语义）+ `sources`（gpu/cpu/mem/procs 通道标注）+ **指标命名规范化**（utilPct/memUsedMiB/tempC/powerW/totalMiB/percent，通道差异封死后端内）+ `degraded`。

**⑤ 降级链**：GPU 缺失（probe 失败）→ `sources.gpu='unavailable'` + CPU/内存照常；dmon 断流 → 指数退避重启（1s→2s→4s，≤3 次/5min）→ query-fallback + `degraded.gpu='query-fallback'`（T1-4 interop 版）；单通道失败（tasklist 解析错）→ 该通道降级不拖垮整次 snapshot。

**⑥ Windows 通道契约**（windows-paths.js，t10 §4）：完整路径常量表；编码分通道（ASCII / chcp+UTF8 / iconv）；频率分级（dmon 1s / query TTL 500ms / CIM·tasklist ≥5s）；close() 显式杀子进程。

合并规则（T1-3 v1.4 修订）：sampler/ 六文件 + 主 index.js 经 **dev-run.sh 固定顺序 concat** 成单一 code.host 函数体（禁 import/export、顶层函数共享作用域、顺序敏感初始化区）+ node --check。（v1.4.5 工具与源码已归档 `docs/archive/v1.4.5-plugin/`）

### 2.2 ring-buffer.js —— 环形缓冲
| 项 | 内容 |
|---|---|
| 输入 | collector 采样点 |
| 容量 | **双条件封顶**：≤1000 点 且 ≤30 分钟（2s 采样 ≈ 900 点，~2MB 上限）；running 期间按需扩容（容量翻倍至 2h）或摘要标注「部分数据」（R-3，详见 docs/02） |
| 输出 | `history(since, bucketMs)`：按桶降采样（借鉴 monitor-panel）→ 图表数据 |

### 2.3 state-machine.js —— 实验生命周期状态机
| 项 | 内容 |
|---|---|
| 状态 | `idle / running / done / crashed / alerting` |
| 输入 | hooks.js 事件（start/execute 回传/end）、ps 进程表（5s，pid 存活）、采样快照 |
| 判定 | 见 docs/02-data-model.md §3（状态机转移表，含 T1-1 pid 链路 / T1-2 配对 / kill 不误判 done） |
| 输出 | 实验记录数组 + `ctx.emit('lab/experiment-start|end')` |

### 2.4 balancer.js —— 平衡引擎（纯代码规则）
| 项 | 内容 |
|---|---|
| 输入 | 最近 N=10s 快照窗口 + 当前实验上下文 + **当前生效阈值（host 侧 settings 服务为唯一事实来源；请求携带/setThresholds/lab_ctl 均为更新入口，last-write-wins，M3）** |
| 规则 | 4 类诊断：① **OOM 风险**（显存余量 < 阈值 且 util 高 → 降 batch/关其他进程）；② **数据瓶颈**（GPU util 低 且 CPU 100% → 加 num_workers）；③ **温度/功耗墙**（降频风险提示）；④ **多 GPU 负载不均**（调度建议） |
| 输出 | `{level: info|warn|critical, rule, msg, confidence, actions:[]}`；`ctx.emit('lab/alert', ...)` |
| 防抖 | 阈值持续 **10s** 才触发（Prometheus `for:` 模式）；同类告警最小间隔 **5 分钟**（W&B wait_duration 模式）；分级 INFO/WARN/CRITICAL |

### 2.5 hooks.js —— 生命周期钩子
| 项 | 内容 |
|---|---|
| 输入 | 平台事件 `tools/pre-execute`（waterfall，可拦/改/放行）、`tools/result`（emit）、`tools/execute`/`tools/post-execute`（waterfall） |
| 逻辑 | `tools/pre-execute`：匹配训练命令 → state-machine.start（**只记 runId/cmd 特征/startTs，无 pid**，T1-1）；显存余量 < 需求 → **可选阻断**；`tools/execute`：回传句柄/pid 供关联（T1-1 链路②）；`tools/result`：**配对校验后**调 state-machine.end（T1-2） |
| 输出 | state-machine 调用、`ctx.emit('lab/experiment-start|end')` |

### 2.6 rpc.js —— harness.handle 注册（出口统一数据面）
| 方法 | 输入 | 输出 |
|---|---|---|
| `labMonitor.snapshot` | `{ thresholds? }`（携带值=「建议更新」，last-write-wins，M3） | `{ ts, gpu[], cpu, mem, procs[], alerts[], alertsCriticalCount, experiment, callCount, ui }`（含 `ui.betterSidebarVisible`；**schema 见 docs/03-protocol.md**） |
| `labMonitor.history` | `{ sinceMs, bucketMs }` | 降采样后的时间序列 |
| `labMonitor.setThresholds` | `{ util, memPct, temp, pollMs }` | `{ ok, applied }`（直连更新通道；冲突以时间戳后者为准，M3） |
| `labMonitor.control` | `{ action: 'start'\|'pause'\|'resume' }` | `{ ok, state }`（**护栏：仅控制监控/告警引擎，绝不触碰实验进程**） |

### 2.7 tools.js —— harness.defineTool（Agent 按需查询）
| 工具 | 输出 |
|---|---|
| `lab_status` | Agent 友好快照文本/JSON（同 snapshot；schema 见 docs/03-protocol.md） |
| `lab_advice` | 平衡引擎当前建议（分级 + 置信度 + 可执行动作） |
| `lab_ctl`（可选） | 启停/阈值控制（**护栏：仅监控/告警引擎启停，绝不碰实验进程；写操作明示风险；pause 类限 UI 或 approval/request 确认**） |

### 2.8 prompt.js —— systemPrompt.variable 注入
| 项 | 内容 |
|---|---|
| 输入 | 最近快照 + 告警 + 实验状态（每模型步重新解析） |
| 输出 | 注入段示例：`[Lab Monitor] GPU0 92% · 20.1/24G · CPU 340% · 实验 train-v3 (running 12min) · 告警: 无` |
| 约束 | 摘要 ≤ 1 行、O(1) 生成；注入开关用 Host `settings` 服务或 rpc 控制字段承载（Host 无 process.env） |

### 2.9 Client 数据消费者（核心层在 Client 侧的延伸，出口共享）
- 所有出口共用「host.call 轮询 → 模块级 `last` 快照 → 各自渲染」；`last` 是各出口 badge/label/title 的唯一只读源（O(1)）；
- 轮询代码形态（计划 §3.2.1）：`refresh()` 带 try/catch（T2-3 失败退避 5s→10s→30s 封顶）+ `ctx.setInterval`（禁 window.setInterval）；
- **阈值事实来源 = host 侧 settings 服务**（V2）：pluginSettings 仅作 sidebar 出口 UI 编辑同步面；last-write-wins 仲裁见 docs/03-protocol.md；
- **conversation.view 出口渲染路径**：label thunk 实时摘要（仅 `last` 变化时更新 label）+ 面板组件（若 M7 实证支持；常驻 5s 节流，不依赖 visible）——D-B1 实现者须同时产出两条路径。

## 3. UI 出口适配层（四出口注册策略）

| # | 出口 | 依赖 | 状态 | 优先级与时机 |
|---|---|---|---|---|
| ① | **Agent 通道**（tools + prompt 注入） | 无（host 侧核心层固有） | **永远可用** | 第一：本质即「无 UI 出口」 |
| ② | **conversation.view 原生 tab** | dsh 自带 `slots`（零第三方） | **默认启用** | 第二：**默认兜底出口**；better-sidebar 缺席/禁用时自动生效 |
| ③ | **better-sidebar Tab** | 第三方 dsh-better-sidebar | 可选（**最后开发**） | 第三：**双检查**（`ctx.get('betterSidebar')` 判空 + `snapshot.ui.betterSidebarVisible` 标志）；存在且可见时**替代** ②（互斥） |
| ④ | **webServer 自托管面板** | 平台 `webServer`（零第三方） | 可选（v2 前置） | 第四：独立注册路由，与 ②③ 可共存（不同媒介） |

**互斥/共存规则**：
- ② 与 ③ **互斥**（同属 tab 环类座位）：默认注册 ②；探测 ③ 可用 → 注销 ②、注册 ③；③ 失败 → 保持 ②；
- ④ 与 ②③ **共存**（不同媒介）；
- 任一出口注册抛错 → 各自 try/catch + console.error，不影响其他出口与核心层；
- 出口全部缺席 → 核心层（① 永远在）不受影响——「无 UI 也完整」验收口径。

## 4. 核心 ↔ 出口解耦契约

- **出口只消费、不反向依赖**：出口适配器只通过两个面取数——① `host.call` 快照/历史/阈值 RPC（rpc.js 数据面）；② `ctx.on('lab/*')` 事件（订阅广播）。核心层**不 import/不感知**任何出口的存在；
- **核心层无 UI 也完整**：采集、状态机、平衡引擎告警、Agent 工具、prompt 注入、事件广播全部在 Host 半独立运行——sidebar 被整体禁用/缺席时零功能损失；
- **出口彼此独立**：每个出口独立 `ctx.effect` 注册（disposer 语义），任一出口注册失败不影响其他出口与核心层；
- **出口可增删**：新增出口 = 新增一个适配器文件（v2 拆 adapters/），不改核心层任何代码。

## 5. 依赖声明纪律（v1.3，V1/H2 闭合）

**client 半返回对象只声明核心依赖 `inject: ['timer']`**（timer 是平台内置服务，恒存在）；**better-sidebar 绝不进 inject**——若声明为硬依赖，服务缺席（0.13.0 互斥禁用/未安装）时整个 client 半进入 waiting 永不 apply，apply 内的 conversation.view 默认出口 ② 也不会注册，"核心独立"名存实亡。

正确姿势（apply 顶部无条件执行核心逻辑与 ② 注册）：

```js
return {
  inject: ['timer'],                       // ★只声明核心依赖；betterSidebar 不进 inject
  apply(ctx) {
    // ① 无条件：数据消费者（host.call 轮询 → last）
    // ② 无条件：conversation.view 默认出口注册（见 docs/05-ui-adapters.md §2）
    const slots = ctx.get('slots')
    if (slots) ctx.effect(() => slots.register({ ... }))
    // ③ 条件：better-sidebar 适配器（ctx.get 免声明、缺席返回 undefined）
    const bs = ctx.get('betterSidebar')
    if (bs) { /* 双检查通过后 registerTab（见 docs/05-ui-adapters.md §3） */ }
  },
}
```

## 6. 四通道消息流（闭环场景）

| 闭环场景 | 通道组合 |
|---|---|
| 实验开始 | hooks(pre-execute) → state-machine → emit lab/experiment-start → prompt 注入（下一步） |
| 实验崩溃 | state-machine(crashed) → emit lab/alert → badge 计数 + 面板 + 下一模型步注入 |
| UI 实时刷新 | host.call(snapshot, 5s) ← rpc.js（进程内 RPC 开销可忽略） |
| Agent 主动查询 | defineTool lab_status/lab_advice ← tools.js |
| 告警不打断 | 无推送 API → UI + 下一步注入 + 工具结果三路闭环 |
| 阈值生效 | host settings 为事实来源；更新入口 last-write-wins → ≤1 轮询周期生效 |

## 7. 关联文档

- 数据模型/状态机：`docs/02-data-model.md`
- RPC/工具/事件契约：`docs/03-protocol.md`
- 验收清单：`docs/04-milestones.md`
- 出口层详细契约（双检查/重探/webServer 约束）：`docs/05-ui-adapters.md`
- 调研归档：`docs/research/`（00-t8 基线、05 0.13.0 契约、07 webServer 预审）

---

# V2 架构（正式插件形态，2026-08-20 落地）

> 完整迁移设计/动机/风险实证：`docs/research/12-v2-migration.md`。本文只记 V2 与 v1.4.5 的关键架构差异。

## 8. V2 形态（动态插件 → 正式插件）

| 维度 | v1.4.5 动态插件 | V2 正式插件 |
|---|---|---|
| 代码形态 | `docs/archive/v1.4.5-plugin/host/index.js` + sampler 六文件（JS，concat 求值，已归档） | `src/**/*.ts`（TS 源码）+ `tsc`/`tsdown` → `lib/` |
| 持久性 | 进程内存（会话级，重启消失） | package.json + `cordis.patch.yml`（跨会话常驻） |
| 安装 | `cordis_define` | `dsh plugin --profile web add <dir>`（link:） |
| client 数据面 | `host.call('labMonitor.*')` RPC（harness.handle 表） | **webServer HTTP 路由 `/lab-monitor/api/*`**（better-sidebar 同款模式） |
| 工具 | `harness.defineTool/registerTool` | **官方 `ctx.tools.register(defineTool(...))`** |
| settings | 无持久化（阈值在内存） | schemastery + `settings.register`（P2 2' 解锁） |
| prompt 注入 | 默认开（每模型步重渲染 → **KV 缓存骤降根因**） | **默认关**（`promptInjection: false`，KV 缓存友好；`lab_status` 工具按需查询） |
| 依赖 | 隐式（全局） | peerDeps（@deepseek-ai/cordis + dsh-* 包） |
| 构建 | 无 | `tsc -p tsconfig.build.json && tsdown`（host ESM / client ModuleLoader bundle） |

## 9. V2 模块映射

| v1.4.5 | V2 |
|---|---|
| `docs/archive/v1.4.5-plugin/host/index.js`（925 行，已归档） | `src/index.ts`（641 行，逻辑等价 + webServer 路由 + defineTool + promptInjection 默认关） |
| `docs/archive/v1.4.5-plugin/host/sampler/*.js`（六文件，已归档） | `src/sampler/*.ts`（六文件；WindowsBackend 增加 `closed` 标志根治 D2-1 断流重启孤儿） |
| `docs/archive/v1.4.5-plugin/client/index.js`（490 行，已归档） | `src/client.ts`（fetch 数据面 + slots 兜底 + better-sidebar 适配器） |
| `scripts/verify-host.js`（concat 求值） | 同文件改造：`import ../lib/types/index.js` + mock webServer/tools |
| `scripts/verify-sampler.js` | 同文件改造：`import ../lib/types/sampler/index.js` |

## 10. V2 硬约束（用户要求 + 官方规则）

1. **全 TS + 官方规范**：tsconfig strict、`dsh.bundle.patch` 声明、`exports["./client"]`、ModuleLoader bundle、peerDeps 含 `@deepseek-ai/cordis ^4.0.1`
2. **无硬编码 tunables**（官方 AGENTS.md）：SAMPLE_MS/PS_INTERVAL_MS/阈值入 config（`promptInjection`/`sampleMs`/`pollMs`）
3. **KV 缓存友好**：prompt 注入默认关；`lab_status` 工具替代（详见 §6 证据链）
4. **安装**：`dsh plugin add` → bundle 自动挂载（`dsh.profile.bundles` 增行）+ patch 合并（`dsh --dump-config` 验证 lab-monitor 行）

## 11. V2 验证状态（2026-08-20）

- `pnpm typecheck` ✅ / `pnpm build` ✅（lib/index.js 48KB ESM + lib/client.js 21KB ModuleLoader）
- `scripts/verify.sh` 全绿：typecheck + 构建 + 目录 + 契约 + verify-host（47 断言）+ mock-test（10 组）+ verify-sampler（真实 interop）
- `dsh plugin add` ✅（bundle 入列）+ `dsh --dump-config` 显示 lab-monitor 行 ✅ + client-modules 校验模拟 ✅
- **DSH 重启后插件才实际加载**（红线：用户手动重启）；重启前文档已就绪

## 12. M1/M2/M3 架构（issue #5 告警反馈全链路，2026-08-23~24）

> 设计事实源：docs/research/22-issue5-alert-notify-design.md（综合定稿）+ 23 评审 + 24 T1 调研 + 25 架构。

### 12.1 M1 告警严格分级 + 通知策略引擎

- **数据面**：`Alert` 扩展 8 可选字段（severity/urgency/trend/sustainedMs/resource/origin/notifyLevel/escalate）；
  生成侧 `balancer.evaluate`（rule 权重表静态映射 severity + sustainedMs 累计 + trend 窗口判定 + warn 超时升级 escalate）。
- **策略引擎**：`lab/alert` 事件 → `notifyAlerts()`：advice 取批 → throttle 聚合窗口 → 指纹去重 →
  `effectiveLevel()`（分级规则，不改 Alert.level）→ **档位计算** → `setNotifyLevel` 回写告警视图 →
  目标选择 → `resolveAction(level, targetState)` 纯函数（off/inject/steer/followup/send-nq/escalate-root，全格测试）→
  `agents.followup/steer/inject/send` 投递；护栏：聚合窗口/指纹/投递预算 ≤2/clear 重置指纹。

### 12.2 M2 实验类型识别（三层）

- `src/core/exp-type.ts` `classifyExpType`：**配置层**（experimentTypes 规则）→ **自动层**
  （EXP_TYPE_PATTERNS 8 类保守正则 + TRAIN_PATTERNS 门控 gpu-train）→ **学习层**（fingerprint 历史时长 p90 ≥1h → long）→
  兜底 unknown 不猜；`RunRecord.type` + 快照/ended 透出 + fingerprint 持久化（restoreEnded 补存）；
  类型矩阵 `EXP_TYPE_DEFAULT_NOTIFY` 出厂默认（配置可覆盖，不硬编码分支）。

### 12.3 M3 路由 + 权限 + 消息链

- **agentDir 运行时索引**（Map<sessionId, {role, parentId, status, runs, disposed}>）：`agent/created|disposed|status` 维护 +
  `rootAncestors` 根祖先链 + `isSubagentAgent`（delegationDepth>0 ∥ origin==='subagent'，不用 parentSession 防 fork 误伤）。
- **路由决策树**（notifyAlerts）：runId → RunRecord.agentId（pre-execute 读 exec.agent 记录）→ 发起者在线
  （子代理 = 发起者按矩阵 + 根祖先 notice 知情；root = 自身；crashed = 子代理降 notice + 根 wake 接管）→
  发起者 absent/disposed → 立即升根 roots() → 无实验上下文 → roots() 兜底。
- **权限三件套**：① host 全局 `tools.guard` 执行期拒绝子代理 `lab_ctl`（谓词读 subagentPolicy 策略存储，restricted
  白名单放行、full 放行）；② `registerContinuableSetup` 给可继续子代理注入只读 `lab_status_ro` + restrict deny
  lab_ctl（fresh+cold resume 生效，仿 installReportTool 范本）；③ agent/created 兜底（一次性子代理靠 guard）。
- **消息链兜底**（仅链断裂证据）：证据1 = wake 档 followup 投递后 notifyTimeoutMs 内无 `agent/inbox/claimed` → 超时升根；
  证据3 = `subagent/end` stopReason∈{max-tokens,error,cancelled} 且有在途实验 → roots 升根；
  明确不做「无 report/settle 活动即转发」（静默处理是主通道常态路径，B1 红线）。
