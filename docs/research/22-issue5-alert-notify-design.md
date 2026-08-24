# 22 Issue #5 综合设计：告警严格分级 × 实验类型 × 目标路由 × 权限 × 消息链

> 状态：**综合设计方案 v2（评审修订后定稿）**（2026-08-23。T3 初稿 → T4 评审 `23-issue5-design-review.md` → T5 按评审 §9 修订定稿；变更明细见 §0.1）。
> **M1 实施状态（2026-08-23 追加）**：本方案 §1（严格分级字段 + 升级规则）、§2（M1 子集：有效级别 + 通知档位 + resolveAction + 节流/指纹/预算）、§6 配置面（settings + lab_ctl set-notify + NotifyCard）、§2.3 I6（clear-alerts 指纹重置）及 §3.3 前置（TRAIN_PATTERNS 精度修复 + 误报 history 清理）已落地（README A1.5）。M2（实验类型识别）、M3（子代理路由/权限/消息链兜底）未实施，按本文档后续章节排期。
> 输入：T1 调研报告（DSH agent 层级/子代理/权限/消息通道机制，任务 t1 输出，见 `.agent-teams/lab-monitor-issue5/team.json`；证据包路径标注同报告）+ T2 调研报告（`21-t2-alert-grading-and-exp-type-input.md`，已落盘）+ v2 方案（`20-issue5-alert-feedback-design.md`）+ 评审报告（`23-issue5-design-review.md`）+ 源码复核（file:line 证据见 §9）。
> 范围：只做设计，不改 `src/` 代码（证据明细见 §9）。
> 结论先行：**level 保留一维对外、内部增多维扩展字段；通知档位由「策略引擎按 告警级别×实验类型×实验状态×目标代理状态」计算（不再全局固定）；路由以「发起实验的 agent」为主目标、根代理兜底；子代理默认只读（guard 执行期拒绝 + 作用域注入）；子→父消息以模型 report 自然传递为主、lab-monitor 仅在存在「链断裂证据」时做根级兜底中转（静默处理 ≠ 链断裂）。**

---

## 0.1 修订记录（v2，T5 按评审 §9 必改项修订）

| 项 | 修订内容 |
|---|---|
| **B1** | §4.3 删除「60s 无 report/settle 活动即向根转发」→ 改为**链断裂证据驱动**兜底：①followup 投递后 `notifyTimeoutMs` 内无 `agent/inbox/claimed`（未领取=未送达）→ 升根；②目标 absent/disposed → 立即升根（并入 §4.2 决策树）；③`subagent/end` stopReason∈{max-tokens,error,cancelled} 且实验未 done → 升根。明示「静默处理是主通道常态路径，静默 ≠ 链断裂」。§2.3 补**投递预算断言**：同一告警×同一目标 ≤2（主通道 1 + 兜底仅链断裂时 1）。 |
| **B2** | §5.3.1 guard 谓词**读取策略存储**（subagentPolicy + lab_ctl 动作白名单），restricted/full 可放行；lab_ctl 工具内部按 exec.agent 复核白名单（伪代码见 §5.3.1）。 |
| **I1** | 矩阵补「目标代理状态」维度：策略矩阵只表达 **notifyLevel×目标**，动作由 `resolveAction(level, targetState)` 纯函数按目标 running/idle/absent 解析（§2.5）；absent → 升根（§4.2 决策树新增行）。 |
| **I2** | 修正 steer 语义误用：注明 **steer 对 idle agent 会启动新回合**（agent-loop 源码实证），故「不唤醒」场景一律 `inject`（running）或 `send(next-turn,false)`（idle）；wake 语义 = running 时 steer / idle 时 followup。 |
| **I3** | §2.2（场景矩阵）与 §3.4（类型表）合并为**单一策略矩阵**（notifyLevel×目标），明示查找顺序：场景行 → 类型默认（experimentTypes 配置）→ 全局 fallback；short（critical→wake）/full（warn→notice）行补齐对齐。 |
| **I4** | isSubagent 判定改用 **`delegationDepth>0 \|\| origin==='subagent'`**（替代 parentSession——它是 fork seed lineage，会把 fork 分支误判）；**决策：fork 分支默认不受限**。 |
| **I5** | 一次性子代理只读语义写明：**一次性子代理 = global 只读 lab_status（M3 前不影子化）；M3 争取 agent/created own-layer 影子化**（标注 KV 代价）。 |
| **I6** | `clear-alerts` **同步重置插件通知指纹**（notifiedFingerprint.clear()）——同指纹告警在 clear 后可重新通知；保留 balancer 5min 防重护栏。 |
| **I7** | 复杂度收敛：策略层只表达 notifyLevel×目标；动作选择收为 `resolveAction` 纯函数；`scale` 灵敏度乘数**删除**（YAGNI，未来 M4 再评估）；`notifyTimeoutMs` 默认统一 **600000ms=10min**（与 escalateAfterSec 600s 同规模）且可注入（环境变量/测试参数）。 |
| minor | agent/inbox/inserted 引用行号更新为 agent-loop L359；§5.3→§5.4 交叉引用修正；§5.3.2 补 registerContinuableSetup 冷恢复子代理一次性 KV 前缀说明；§1.5 补 severity/urgency/sustainedMs 三字段必填断言；§4.2 决策树补 absent 行；M1 验证补 clear-alerts 指纹重置/投递预算/矩阵全格/仅目标尾部增长断言。 |

---

## 0. 用户 6 问的逐条结论（TL;DR）

| # | 用户问题 | 结论 |
|---|---|---|
| 1 | 事件预警是否有严格分级？现有 critical/warn/info 是否够？要不要多维？ | 现状只有 level 一维（critical/warn/info + 离散 confidence），**不够**。设计：对外保留 level 兼容 5 类消费者，**内部新增可选扩展字段** severity（严重度）/urgency（紧迫性）/trend（趋势）/sustainedMs（持续时长）/resource（资源类别）/origin（归属）——全部可选、不破坏现有消费者（T2 §1.4/§1.5 证据：Alert.level 已有 `\| string` 逃逸口 types.ts:108；advice/snapshot 透传整个 Alert 加字段即全链可见）。**通知级升级**：warn 持续超 `escalateAfterSec` → 通知按 critical 处理（不改 level 本身，避免破坏消费端，规避 T2 §1.2「warn 永不升级」缺陷）。 |
| 2 | 默认档位是否应随实验预警调整？ | **是**。废弃「全局固定 alertNotify 单值」为唯一决策：`alertNotify` 降级为「无实验上下文/unknown 类型时的 fallback」，默认 `notice`；实际档位由策略引擎按矩阵计算（如 critical × 实验运行中 → wake；info × 冒烟 → 仅记录）。引擎输出 `notifyLevel: off/notice/wake` 写回告警视图，UI 透明展示「为什么这样通知」。 |
| 3 | 不同类型实验是否需要不同处理模式？ | **是**。设计 8 类枚举（smoke/regression/full/short/long/gpu-calc/gpu-train/unknown）+ 类型×处理模式差异表（§3.4）+ 通知矩阵（§2.2）：如 gpu-train 对 oom 敏感 → critical/warn 都 wake；smoke 快速失败 → critical 才 notice、warn 仅记录；full 长跑 → 不因 warn 唤醒、critical 升级。识别三层：自动（正则保守）/ 配置（experimentTypes 规则）/ 学习（fingerprint 历史）。 |
| 4 | 通知子代理还是主代理是否看具体情况？ | **是**。路由判定：告警 runId → RunRecord.agentId（pre-execute 的 `exec.agent`，T1 证实 agent-loop 注入 exec.agent，L117-129）→ 目标=发起实验的 agent；无 agentId（旧数据/other-occupancy）→ 回退 `roots()`；广播仅当配置显式开启。发起者为子代理时**并行通知其根祖先链**（子代理处理 + 根代理知情兜底）。 |
| 5 | 通知子代理的话，子代理权限？ | 现状：**无天然只读保障**（T1 结论 7：lab_ctl 是 in-process 闭包执行，不经 sandbox/approval 管道；approval 固定 'never' 只拒绝升权请求，toolFilter 由委派方决定、插件改不了）。设计：`subagentPolicy: readonly|restricted|full`，**默认 readonly**：host 全局 `tools.guard` 执行期**按策略存储**拒绝子代理 lab_ctl（restricted 白名单动作放行、full 全放行；guard 单调不可翻案 → 谓词读策略存储而非写死拒绝）+ `registerContinuableSetup` 给可继续子代理注入「实验感知只读版 lab_status_ro」（仿 installReportTool 范本）+ `agent/created` 钩子兜底一次性子代理（M3 争取影子化）。**isSubagent 判定用 delegationDepth>0 \|\| origin==='subagent'**（不用 parentSession，防 fork 分支误伤；fork 默认不受限）。 |
| 6 | 如何把信息传递给主代理？ | 双通道：**主通道=模型自然传递**（告警→执行子代理→子代理用 report 向直接父级上报→逐级上抛；report 只到直接父级是官方边界，T1 结论 5）；**兜底=lab-monitor 插件中转，仅在存在「链断裂证据」时触发**——①wake 档 followup 投递后 `notifyTimeoutMs` 内无 `agent/inbox/claimed`（未领取=未送达）；②目标子代理 absent/disposed；③`subagent/end` stopReason∈{max-tokens,error,cancelled} 且实验未 done。**明确「静默处理（子代理自行解决）≠ 链断裂」，不设「无活动即转发」**。投递预算：同一告警×同一目标 ≤2（主通道 1 + 兜底仅链断裂时 1）。 |

---

## 1. 告警严格分级设计

### 1.1 现状（T2 §1 证据）

- 只有 `level: 'critical'|'warn'|'info'|string` 一维（types.ts:108）+ 离散 confidence（critical 0.85 / 其余 0.7 / external 0.9，balancer.ts:374/407）。
- 持续时间只作固定 10s 防抖（MIN_HITS=5，balancer.ts:252），**不参与升级**：warn 持续恶化永不升 critical。
- 防重护栏：5min 防重 + 24h TTL + 20 条上限（balancer.ts:253/255，constants.ts:16）。
- 消费者 5 类：UI badge / AlertList / lab_advice / lab_status / emitLab 事件（T2 §1.4）。

### 1.2 扩展字段（不破坏兼容）

```ts
// types.ts Alert 扩展（全部可选，旧数据/旧消费者零感知）
export interface Alert {
  level: 'critical' | 'warn' | 'info' | string   // 保留，对外主分级不变
  rule: string
  msg: string
  confidence: number
  actions: string[]
  evidence?: { procs: ProcStat[] }
  ts: number
  runId: string | null
  // ── 新增（可选扩展）──
  severity?: 1 | 2 | 3 | 4 | 5        // 严重度：影响面（实验自身/他人/硬件风险）
  urgency?: 1 | 2 | 3                 // 紧迫性：需要多快响应（由 trend/origin/rule 推导）
  trend?: 'rising' | 'steady' | 'falling'  // 趋势：持续恶化/持平/缓解
  sustainedMs?: number                // 超阈值持续时长（替代「固定 10s 防抖」的累计值）
  resource?: 'gpu-util' | 'vram' | 'temp' | 'cpu' | 'mem' | 'io' | 'process'  // 资源类别
  origin?: 'self' | 'other' | 'system' // 归属：实验自身 / 疑似他人 / 无实验系统级
  notifyLevel?: 'off' | 'notice' | 'wake'  // 策略引擎输出（写回，UI/审计可见）
  escalate?: boolean                  // 是否已发生「warn→critical 通知升级」
}
```

### 1.3 rule 语义权重表（severity 静态来源）

| rule | level | severity | urgency 基准 | resource | origin 默认 | 推导 |
|---|---|---|---|---|---|---|
| `experiment-crash` | critical(external) | 5 | 3 | process | self | 实验已死，必须行动 |
| `oom` | critical/warn(动态) | 4 | 2（rising→3） | vram | self/other（activity 仲裁，balancer.ts:105-140） | 显存爆，可能杀进程 |
| `thermal` | warn | 4 | 2（rising→3） | temp | self | 硬件风险 |
| `io-bottleneck` | warn | 3 | 2 | io | self | 性能劣化 |
| `imbalance` | info | 2 | 1 | gpu-util | self | 效率问题 |
| `other-occupancy` | info | 2 | 1 | vram | other | 他人占用，非我实验 |

### 1.4 分级规则（通知视角的有效级别）

```
有效级别 = 降级/升级规则（不动 Alert.level，只影响通知档位计算）：
  1. level=critical                     → effective critical
  2. level=warn 且 sustainedMs ≥ escalateAfterSec（默认 600s=10min，可配）→ effective critical（escalate=true）
  3. level=warn 且 trend=falling        → effective info（缓解中，不打扰）
  4. level=info 且 origin=other         → effective off（非我实验，只记录）
  5. 其余                               → 按 level
```

- **阈值体系是否要分级**：检测阈值（utilWarn/memWarn/tempWarn）保持全局单套（现状，防配置爆炸）；**分级的是通知门槛**（escalateAfterSec 等）。即「检测不分级、通知分级」。（类型级灵敏度乘数 `scale` 已删除——与「检测不分级」矛盾且需求未证，YAGNI；如未来需要按类型缩放阈值，作为 M4 独立项重新评估，见 §3.4 注。）

### 1.5 落点

- `balancer.evaluate()` 在命中 rule 时计算并填充扩展字段（rule 权重表静态映射 + 从 hitByRule/recentWindow 推导 trend/sustainedMs）。
- **必填断言（防空谈，M1 起）**：`severity`/`urgency`/`sustainedMs` 三字段**必填**（severity 由 §1.3 权重表静态可得；urgency 由 rule 基准+trend 推导；sustainedMs 由 hitByRule 累计）——防止实现时只填 notifyLevel 导致多维分级退化为空谈；其余字段（trend/resource/origin/notifyLevel/escalate）按规则可空。
- `lab/alert` 事件载荷原样带新字段（index.ts:320-326 现有透传不变，payload 加字段即可）。

---

## 2. 通知策略引擎设计

### 2.1 输入 → 输出

```
输入：
  A. 告警视图     effective level × severity × urgency × trend × resource × origin × runId
  B. 实验上下文   type（§3）× state（running/done/crashed/aborted）× duration × expectedMaxSec
  C. 目标代理状态 running / idle / absent（agentDir 目录，§5.4）× 角色（root/subagent）× 是否发起者
  D. 配置         alertNotify(fallback) × alertTargets × experimentTypes[].notify × throttle/escalate × subagentPolicy
输出：
  notifyLevel × 目标列表        // 策略层只表达档位：off | notice | wake
  动作由投递器按目标实时状态解析：resolveAction(level, targetState) → off | inject | steer | followup | send
  [对齐 20-issue5 §3 语义矩阵 + T1 能力清单；动作解析见 §2.5，strategy 层不掺动作]
```

### 2.2 策略矩阵（核心交付——单一事实来源）

**查找顺序（叠加优先级，命中即返回、不再下探）**：
1. **场景行**（下表，命中即返回）→ 2. **类型默认**（§3.4 / `experimentTypes[].notify` 配置）→ 3. **全局 fallback**（`cfg.alertNotify`，默认 notice）。

行 = 场景（有效级别 × 类型 × 实验状态 × 归属），列 = 目标。单元格值 = **notifyLevel（off/notice/wake）**；具体投递动作由 §2.5 按目标状态解析（absent 处理见 §4.2 决策树）。

| 场景 | 执行子代理（发起者） | 主代理 roots（发起者的根祖先） | 广播（默认关） |
|---|---|---|---|
| critical × gpu-train/long × running × self | **wake**（显存/IO 危机需立即处理） | notice（并行告知不打断） | — |
| critical × short × running × self | **wake**（短任务可唤醒，马上有结果） | notice | — |
| critical × smoke × running × self | **notice**（快速失败立即重跑即可；不唤醒新回合） | notice | — |
| critical × full × running × self | **wake**（长跑关键节点才唤醒） | notice | — |
| critical × 任意 × crashed × self | notice（排队；实验已死，子代理可能卡死，不激进唤醒） | **wake**（根代理兜底接管：检查日志/重跑决策） | 仅异常结算时（§4.3） |
| warn × gpu-train × running × self | **wake**（训练显存 warn = 高危前兆） | notice | — |
| warn × full/long × running × self | notice（不唤醒，长跑勿扰；记录即可） | notice | — |
| warn × smoke/regression × running × self | off（类型矩阵降级） | off | — |
| warn × 任意 × running × origin=other | off（与他人占用有关，通知我方无意义） | off | — |
| info × 任意 | off（仅 UI/工具可见） | off | — |
| critical/warn × unknown × running | 全局 fallback：critical→wake、warn→notice（unknown 不加类型特权） | 同左 | — |
| 任意 × 无实验（other-occupancy/系统级） | —（无发起者） | notice（仅当 watchProcs 命中或 GPU 高位）；否则 off | — |

> 与 §3.4 的关系：上表「场景行」覆盖不到的组合（如空类型上下文）→ 落到 §3.4 类型默认；两者都没有 → 全局 fallback。§3.4 类型默认是 `experimentTypes[].notify` 的出厂建议值，**可被用户配置覆盖，不硬编码代码分支**。

### 2.3 优先级仲裁、节流与合并

- **合并**：同一评估周期多条告警 → 单条消息（20-issue5 §4.3 的 buildAlertMessage），消息内按 effective level 降序。
- **指纹去重**：`fp = level:rule:msg (+runId +target)`；同集合不重复通知（20-issue5 §4.4 已有）；**升级例外**：`escalate=true` 或新 rule 加入 → 新指纹 → 允许再通知一次。
- **投递预算断言（B1 配套，M1 起自动化验证）**：同一告警 × 同一目标 **≤ 2 条**（主通道 1 + 兜底仅在链断裂时 1）；预算记录随指纹去重一并维护，超出断言视为实现缺陷。兜底只允许在 §4.3 的「链断裂证据」命中时消耗第 2 条预算——**«无 report/settle 活动»不是合法触发条件**。
- **clear-alerts 联动（I6）**：`lab_ctl clear-alerts` 执行时**同步重置插件通知指纹**（`notifiedFingerprint` 归零）——同指纹告警在 clear 后再次触发可重新通知；**保留 balancer 的 5min 防重护栏**（清告警不绕过引擎级防重，只解除「插件已通知过」的钳制）。写入 M1 验证（§7）。
- **聚合窗口**：`notifyThrottleMs`（默认 60000）内同目标最多 1 条（最紧急的胜出）。
- **多目标仲裁**：同一目标同时被「子代理路径」和「根路径」命中 → 取最紧档位（wake > notice > off；动作由 §2.5 解析）；目标间互不影响。
- **与现有护栏的关系**：5min 防重（balancer）+ 24h TTL 不动——分级策略叠加在其后，不绕过（T2 §1.5 红线）。

### 2.4 触发时机

`emitLab('lab/alert')` 处追加 notifyAlerts()（20-issue5 §4.4 方案）+ 告警评估周期末尾一次（覆盖清除/过期）。升级计时由 balancer 评估周期驱动（sustainedMs 累计）。

### 2.5 动作解析纯函数（I2/I7：策略层与动作层解耦）

```
/** 纯函数：notifyLevel × 目标实时状态 → 投递动作（M1 起单元测试全格覆盖） */
resolveAction(level: 'off'|'notice'|'wake', targetState: 'running'|'idle'|'absent'): Action
  off                                   → noop（仅 UI/工具可见）
  notice × running                      → inject           // next-step，不唤醒（agent 本就在跑）
  notice × idle                         → send('next-turn', false)  // 排队不唤醒，下轮提问可见
  wake   × running                      → steer            // next-step 唤醒（当前轮下一步立即消费）
  wake   × idle                         → followup         // 唤醒新回合
  任意   × absent                       → （不发；由 §4.2 决策树处理：直升根 / 目录缺失回退）

⚠ steer 语义红线（I2，评审源码实证）：
  steer = send(msg, 'next-step', true)  —— 对 idle agent 会【启动新回合】！
  因此「不唤醒」的语义永远不用 steer；steer 只在 targetState=running 时使用。
「不唤醒」= inject（running）或 send(next-turn,false)（idle）。
[证据：agent-loop L390-404 send/followup/steer/inject；runtime-types.d.ts idle/steer/inject 语义]
```

动作枚举说明（对齐 20-issue5 §3 + T1 能力清单）：`off` 不推送仅落 UI/工具；`inject` 下个 pre-step 可见不唤醒；`steer` 下个 step 可见且唤醒（仅 running 用）；`followup` 排队新回合并唤醒（idle 用）；`send(msg,'next-turn',false)` 排队不唤醒。

---

## 3. 实验类型模型

### 3.1 枚举与语义

| type | 含义 | 典型形态 | 默认 expectedMaxSec |
|---|---|---|---|
| `smoke` | 冒烟测试（快速验证核心路径） | `smoke*.py`、`--smoke`、`test_smoke` | 300（5min） |
| `regression` | 回归测试（批量验证） | `run_regression.py`、`regression` | 1800（30min） |
| `full` | 全量测试（长批量） | `full*.py`、`--full`、`run_all` | 7200（2h） |
| `short` | 短任务（脚本/工具） | 无关键字、<5min | 300 |
| `long` | 长任务（批处理/推理服务） | `serve*.py`、`batch*`、vim/llama 类 | 3600 |
| `gpu-calc` | GPU 计算（非训练：推理/仿真/数据处理） | `infer*`、`render*`、`sim*` | 1800 |
| `gpu-train` | GPU 训练 | `torchrun`、`deepspeed`、`train*.py`（S3 训练器门控） | 7200 |
| `unknown` | 未识别（保守默认） | — | 用全局 fallback |

### 3.2 识别三层（对照 T2 §3.2，逐层实现顺序）

| 层 | 内容 | 信号（T2 §3.1） | 失败语义 |
|---|---|---|---|
| 自动层（零配置） | 关键字/脚本名正则 + 训练器门控 | S1 关键字、S2 脚本名、S3 cmdFeature（**先修 TRAIN_PATTERNS 精度**，T2 §2.4：torchrun 裸词 + python -c/-m 全匹配是误报主因）、S4 进程数 | **未命中=unknown，不猜**（防误报优先） |
| 配置层（用户意图） | `experimentTypes[]` 规则：pattern→type→notify 覆盖；`expTypeDefault`；用户标签声明类型（S10） | S10 + 配置 | 规则未命中 → 交给自动层/学习层 |
| 学习层（运行时） | 按 `fingerprint`（脚本名）累积历史时长/画像分布 | S5 时长分布、S6 资源画像、S8 翻转节奏 | 首见=默认策略；二次起按历史归类；结束后回写（需先补存 fingerprint，T2 §0.5：restoreEnded 丢 fingerprint，state-machine.ts:348） |

### 3.3 命令 → 类型映射示例（自动层正则草案）

```
smoke:      /\b(smoke|冒烟|--smoke|test_smoke|smoke_test)\b/i
regression: /\b(regression|回归|run_regression|regress)\b/i
full:       /\b(full|全量|run_all|--full|e2e_all)\b/i
gpu-train:  (S3 门控) torchrun/deepspeed 后跟脚本/参数（修复：不裸词匹配，需 `torchrun\s+\S+\.py` 或 `-m torch.distributed` 句式）
gpu-calc:   /\b(infer|inference|render|sim|simulate|推理|渲染)\b/i 且非 train 门控
long:       fingerprint 历史 p90 ≥ 阈值（学习层）
short:      默认（未命中且历史上 <5min）
```

**unknown 默认策略**：不享受类型特权，按全局 fallback（§2.2 场景行 11）。

### 3.4 类型 × notifyLevel 默认表（I3：与 §2.2 合并查找，直接回答用户问题 3）

| type | critical → notifyLevel | warn → notifyLevel | 超时关注（expectedMaxSec 超时） |
|---|---|---|---|
| `smoke` | notice（运行中仅下一模型步可见，不唤醒新回合） | off | 短；超时→仅记录 |
| `regression` | notice | off | 中；超时→notice |
| `full` | **wake**（长跑关键节点才唤醒） | notice | 长；超时→升级检查卡死 |
| `short` | **wake**（可唤醒，马上有结果） | notice | 短 |
| `long` | **wake** | notice | 长；超时→升级 |
| `gpu-calc` | **wake** | notice | 中 |
| `gpu-train` | **wake** | **wake**（显存/IO 危机需立即处置） | 长；卡死→升级 |
| `unknown` | 全局 fallback（notice 起点） | 全局 fallback | 默认策略 |

> 查找语义：§2.2 场景行命中即返回；未覆盖组合落到本表（`experimentTypes[].notify` 的出厂建议值，用户可配置覆盖，**类型矩阵 = 配置，不硬编码代码分支**——§6.1 的 `experimentTypes` 是唯一实现载体，本表只是出厂默认）。
> `scale`（类型级阈值灵敏度乘数）**已删除**（I7）：与 §1.4「检测不分级」矛盾且需求未证（YAGNI）。如未来需要按类型缩放检测阈值，作为 M4 独立项重新评估，不进 M1/M2。

---

## 4. 路由与层级设计

### 4.1 数据面：哪个 agent 发起了实验

- **事实**：`tools/pre-execute` 的 exec 含 `.agent`（T1：agent-loop L117-129 `exec.agent = ctx.agents.requireInitiator()`）；lab-monitor 的 pre-execute 已能拿到 exec（index.ts:1123-1141）。
- **isSubagent 判定（I4，全局唯一定义，§5 复用）**：`(h.delegationDepth ?? 0) > 0 || h.origin === 'subagent'`（session header，dsh-session types.d.ts L64/70，持久化、重启不丢）。**不用 `parentSession`**——它是 fork seed lineage（types.d.ts L54），fork 分支也有 parentSession，用它会把 fork 主线误判为子代理并剥夺 lab_ctl。**决策：fork 分支默认不受限**（视为主代理同等权限；如未来需要单独限制 fork，另立配置项）。
- **设计**：`machine.start(cmd, feature)` 增参 `agentId/agentRole/parentId`（来自 exec.agent）；`RunRecord` 增 3 字段；`lab/experiment-start` 载荷带 `agentId`（state-machine.ts:197）；`ExperimentSnapshot` 透出（types.ts:79-92）。exec.agent 缺失（旧宿主）→ agentId=null，路由回退 roots()。

### 4.2 路由判定（决策树）

```
告警 (runId) 
  ├─ runId → RunRecord.agentId 存在
  │    ├─ agentDir 命中失败（目标 absent/disposed）→ 【立即升根：roots() 中该 agent 的根祖先 followup】（I1：后台进程常由已结算子代理遗留，此为常态非边角）
  │    ├─ 该 agent 是 root            → 目标 = 该 root（即主代理），按矩阵
  │    └─ 该 agent 是子代理            → 目标 = 子代理(按矩阵) + 根祖先链各层(notice 知情)
  ├─ runId → agentId 缺失（旧数据/冷恢复）→ 回退 alertTargets 或 roots()
  └─ runId = null（other-occupancy/系统级）→ 仅当 watchProcs 命中或 GPU 高位 → roots()；否则 off
广播：仅 cfg.broadcast=true 显式开启（默认 false），且只对「critical × 实验级」生效，并过滤 absent 目标
```

### 4.3 子代理 → 主代理消息链（问题 6 的完整方案）

**主通道（模型驱动，默认）**：告警 → 执行子代理（模型读告警、处理、决定是否上报）→ `report` 工具向**直接父级**上报 → 父级逐级上抛。依据：
- report 只到直接父级是官方边界（T1 结论 5：dsh-tool-subagent-report README「嵌套上报只向上到达一条直接边」）；
- **优点**：语义权在模型——子代理能自己处理（降 batch/清告警）就不打扰父级；报告内容由模型整合上下文，质量高。
- **缺点**：依赖模型自觉 + 子代理存活；子代理卡死/结算异常时链断裂。

**兜底通道（lab-monitor 中转，插件主动）——仅在存在「链断裂证据」时触发（B1 重写）**：lab-monitor 监听：
- `agent/inbox/inserted`（agent-loop L359 / runtime-types.d.ts L146-215【minor：引用行号已更新，原 dsh-agent L151 漂移】；source.kind==='subagent-report'|'subagent-settled'）→ 发现在途实验相关 report/settle 且未流向根（链断裂）→ 向 roots() 转发汇总；
- `subagent/end`（payload stopReason，dsh-subagent L191-256）→ **证据 3**：`stopReason∈{max-tokens,error,cancelled}` 且该子代理在途实验未 done → **根级升级通知**（保留原设计）；
- **证据 1（替代旧「60s 无活动」）**：wake 档 followup 投递后 `notifyTimeoutMs`（默认 **600000ms=10min**，可注入：环境变量/测试参数）内无 `agent/inbox/claimed` 事件（消息未被该子代理领取 = 未送达）→ 视为未送达 → 升根通知；
- **证据 2**：目标子代理 absent/disposed（agentDir 命中失败）→ **立即升根**（并入 §4.2 决策树 absent 行）。

**明确不做（评审 B1 结论）**：以「无 report/settle 活动」作为兜底判据。**静默处理（子代理自行降 batch/清告警、不上报）是主通道的常态路径，静默 ≠ 链断裂**——「无动静即转发」会把每条 critical 双通知（子代理已处理 + 根被唤醒），误报率接近 100%。「无活动」既不证明未送达、也不证明链断裂；链断裂必须由上述三类**证据**支撑。

**防重复（B1 配套）**：**投递预算 = 同一告警 × 同一目标 ≤ 2 条**（主通道 1 + 仅链断裂时兜底 1，§2.3 断言）；插件的转发用 `form:'notice'` + 指纹（与模型 report 的 `form:'relay'`/settle notice 不同源）；5min 防重 + 指纹去重兜底（模型一条 + 插件兜底一条，兜底仅在链断裂时消耗第 2 条预算）。

**明确不做**：不做「逐级自动转发」（每级都转 = 双通道轰炸、与模型 report 冲突）；不做 steer/followup 侵入性唤醒子代理的父级——父级只在子代理主动上报或兜底条件满足时收到。

---

## 5. 权限设计

### 5.1 现状与威胁（T1 结论 7）

- 子代理工具集 = global + preset + own + restrictions（applyChildComposition）；**global 层注册的 lab_status/lab_advice/lab_ctl 子代理默认全部可见可调**（dsh-subagent README L44；view 恒先取 global 层，dsh-tools L2843-2869）。
- lab_ctl 是 in-process 闭包执行，**不经 sandbox/approval 管道** → 沙箱与 approval('never') 对它是空门 → **无天然只读保障**。
- 插件改不了委派方 toolFilter；能做：guard / own-layer 注册 / pre-execute 拒绝（T1 能力清单）。

### 5.2 三级策略（`subagentPolicy`，默认 readonly）

| 档位 | 子代理可见 | 子代理可做 | 适用 |
|---|---|---|---|
| `readonly`（默认） | lab_status + lab_advice（只读）。**可继续子代理**（M3 起）：实验感知子集 `lab_status_ro`（registerContinuableSetup 注入，只含自己 runId 的实验子集 + brief 摘要）；**一次性子代理（I5 明示）**：M3 前 = global 只读 `lab_status`（**全量只读快照**——含他人实验/整机进程细节，属已知信息暴露面，由「只读」性质兜底）；M3 争取 agent/created own-layer **影子化** lab_status（只读+实验感知，标注 KV 代价） | 只读查询，无控制 | 一切子代理 |
| `restricted` | 同 readonly 可见性 + lab_ctl（白名单 action，见 §5.3.1） | 可执行白名单动作（如 watch 注册监控目标），禁止改阈值/清告警/暂停 | 明确授权的执行子代理 |
| `full` | global 全量（同主代理） | 全部 | 与现状等价，不推荐给子代理 |

### 5.3 实现机制（三件套，按可靠性排序）

1. **host 全局 guard（执行期强制，必做；B2：谓词读策略存储，解锁 restricted/full）**：

```ts
// M3 实现伪代码（评审 §9 B2 建议文本采用）：guard 谓词读取策略存储，不再写死拒绝
ctx.tools.guard(exec => {
  if (!isSubagent(exec.agent)) return undefined            // I4：delegationDepth>0 || origin==='subagent'；fork 不受限
  const policy = policyFor(exec.agent.session.id)          // 默认 readonly；策略存储可为 agentDir 伴生/直接查配置
  if (policy === 'full') return undefined                  // full 档放行
  if (exec.name === 'lab_ctl') {
    if (policy === 'restricted' && LAB_CTL_WHITELIST.includes(exec.arguments?.action))
      return undefined                                     // restricted 白名单动作放行
    return `subagentPolicy=${policy}：子代理禁止 lab_ctl（${policy === 'restricted' ? '仅白名单动作' : '只读'}）`
  }
  return undefined
})
```
   guardReason 先 global 后 chainLayers(exec.agent)（dsh-tools L2805-2820），单调不可翻案——**因此谓词必须读策略存储**（若写死拒绝，restricted/full 永远无法放行）。**lab_ctl 工具内部按 `exec.agent` 复核白名单**（工具是插件自有，可精确到 action，防 guard 谓词与工具执行脱节）。策略存储本身：内存态（agentDir 伴生），读写仅限插件内部与主代理 lab_ctl（子代理无法改写，符合安全边界 §5.1）。
2. **registerContinuableSetup 作用域注入（可继续子代理官方路径，M2/M3 做）**：仿 `installReportTool(childCtx, ctx, delivery)`（dsh-tool-subagent-report L29-96）：`childCtx.tools.register(defineTool({name:'lab_status_ro',…}))` + `childCtx.tools.restrict({deny:['lab_ctl']})` + 可选 `childCtx.systemPrompt.section('tool:lab_status_ro')`，经 `ctx.subagents.registerContinuableSetup` 注册；fresh + cold resume 都生效（continuation.js L709-743）。**「按代理分级暴露」落点**：lab_status_ro 返回「该子代理自己 runId 的实验子集 + brief 摘要」，不泄露他人实验/整机进程细节。**[KV 补充（minor）]**：registerContinuableSetup 改变子代理组合内容 → **插件安装前已存在、之后冷恢复的续跑子代理**首请求前缀变化 = 一次性 KV miss（之后稳定）——与 own-layer 同类影响，接受并记录。
3. **agent/created 钩子（兜底/影子化，一次性/任意子代理）**：`ctx.on('agent/created', ({agent}) => { if (isSubagent(agent)) agent.ctx.tools.restrict({deny:['lab_ctl']}) })`——注意 own-layer 变更改首请求前缀（KV 影响，T1 结论 3），仅当场景 2 不可用（一次性子代理）且 guard 还不够（需要按代理定制工具而非仅拒绝）时才用。**I5 落点**：这也是 M3 一次性子代理「影子化只读 lab_status」的实现通道（own-layer 注册只读/实验感知版，代价=该子代理首请求前缀一次性变化）。

主代理（roots）与 fork 分支不受任何限制（guard 判定精确到 isSubagent，I4）。

### 5.4 lab-monitor agent 目录（路由+权限共用的运行时索引）

```
agentDir: Map<sessionId, { agent, role: 'root'|'subagent', parentSessionId, delegationDepth, status, runs: Set<runId> }>
维护：ctx.on('agent/created'|'agent/disposed'|'agent/status') + ctx.on('subagent/start'|'subagent/end') + 自有 start/end 事件写 runs
限制（T1）：roots() 非持久化；冷 child 无 agent 事件；跨进程不协调——目录缺失时路由回退 roots()/alertTargets。
```

---

## 6. 配置与 UI

### 6.1 settings schema 新键（`lab-monitor` 命名空间，模式沿用 index.ts:672-704）

```yaml
lab-monitor:
  # ── 通知（20-issue5 提案保留，降为 fallback）──
  alertNotify: notice        # off|notice|wake —— 仅无实验上下文/unknown 时的 fallback
  alertTargets: []           # 空=roots()；显式 agentId 列表
  # ── 分级与引擎 ──
  notifyThrottleMs: 60000    # 聚合窗口（同目标最多 1 条/分钟）
  escalateAfterSec: 600      # warn 持续该时长 → 通知升 critical（null=关，保守）
  notifyTimeoutMs: 600000    # B1 证据1：wake 档 followup 投递后未领取（无 agent/inbox/claimed）的兜底等待，默认 10min（与 escalateAfterSec 同规模）；可注入（环境变量/测试参数）
  broadcast: false           # 是否广播 critical 到全部 agent（默认关）
  # ── 实验类型 ──
  experimentTypes: []        # id/type/patterns/notify{critical,warn,info}/expectedMaxSec（复用 TagRule 形态）
  expTypeLearning: true
  expTypeDefault: unknown
  # ── 子代理权限 ──
  subagentPolicy: readonly   # readonly|restricted|full（默认只读，安全边界）
```

### 6.2 client 设置页控件（settings.section「监控设置」，client.ts:1524-1533）

| 卡片 | 控件 | 参考现有实现 |
|---|---|---|
| 通知策略 | alertNotify 三档选择 + escalateAfterSec（数字，空=关）+ throttle/队列状态展示 | ControlPanel 风格（client.ts:392-517） |
| 实验类型 | 类型规则列表 + 添加表单（type 下拉枚举 + patterns chips + notify 三档 + expectedMaxSec）+ 当前实验识别结果展示（命中的类型/层/指纹） | TagManager 结构（client.ts:589-688） |
| 子代理权限 | subagentPolicy radio 三档 + 说明文案（保守默认 readonly）+ 当前生效的 guard 状态 | WatchManager chips（client.ts:1167-1213） |
| 告警分级（只读） | 每条告警展开多维分解：severity/urgency/trend/sustainedMs/resource/notifyLevel（引擎决策透明化） | AlertList 扩展 |

### 6.3 默认值原则（保守）

- alertNotify 默认 notice（不唤醒不打扰，20-issue5 继承）；escalateAfterSec 默认 null 关闭？——**建议默认 600s 开启**但仅影响通知档位不动 level，且 warn 场景矩阵本就偏 notice，风险低；保守者可关。
- notifyTimeoutMs 默认 **600000ms=10min**（与 escalateAfterSec 600s 同规模、同直觉），且**可注入**（环境变量/测试参数缩短，避免 e2e 等真实 10min）。
- subagentPolicy 默认 readonly（**本次设计的核心安全边界**）。
- broadcast/restricted/full 全部默认关/不启用。

---

## 7. 实施路线

### M1：告警严格分级 + 通知策略引擎（核心闭环）

- **文件**：`src/core/types.ts`（Alert 扩展字段，**severity/urgency/sustainedMs 必填断言**，§1.5）、`src/core/balancer.ts`（rule 权重表 + trend/sustainedMs 推导 + evaluate 填充 + clear-alerts 时通知指纹重置钩子）、`src/index.ts`（notifyAlerts() 策略引擎 + resolveAction 纯函数 + 配置键 + emitLab 接线）、`src/client.ts`（通知策略卡 + 告警多维展示）
- **验证**：typecheck/build；单元：权重表/升级规则表驱动 + **resolveAction 全格测试（3 level × 3 targetState）** + **策略矩阵全格单元测试（场景 × 目标 × 目标状态表驱动）**；e2e：触发 oom（调低 memWarn）→ 观察矩阵行为（warn 不打扰、critical wake、escalate 生效）；**clear-alerts 指纹重置断言（I6）**：告警→通知→clear-alerts→同告警再触发→**再次通知**；**投递预算断言**（同一告警×同一目标 ≤2，超出即缺陷）；KV 命中率基线回归（正常态 100%）+ **「告警时仅目标 agent 的历史尾部增长，非目标 agent 前缀零变化」断言**（评审 §4 补充）；降级：宿主无 agents 服务 → 静默跳过。

### M2：实验类型识别

- **前置**：修 TRAIN_PATTERNS 精度（constants.ts:34-49：torchrun 句式化、python -c/-m 加排除特征——T2 §2.4 误报集作回归测试集）
- **文件**：`src/core/constants.ts`（正则/类型表）、`src/core/state-machine.ts`（RunRecord.type + start 识别 + 补存 fingerprint 供学习层）、`src/core/types.ts`（RunRecord+ExperimentSnapshot.type）、`src/index.ts`（experimentTypes 配置面 + settings 键）、`src/client.ts`（类型规则卡）
- **验证**：T2 §2.3 误报案例（grep torchrun / gh heredoc / docx python -c）全部不再命中实验；类型识别样本表（smoke/regression/train 各 3 例）；配置层覆盖自动层断言。**（scale 已删除，本阶段不做类型阈值缩放。）**

### M3：路由与权限 + 消息链

- **文件**：`src/core/state-machine.ts`（start 增 agentId/agentRole/parentId；experiment-start 载荷）、`src/index.ts`（pre-execute 读 exec.agent；agentDir 目录；路由矩阵含 absent 升根；guard 注册（**谓词读策略存储**，§5.3.1）；registerContinuableSetup 只读工具；inbox/subagent-end 中转监听 + inbox/claimed 证据判定；notifyTimeoutMs 可注入）、`src/core/types.ts`（RunRecord 3 字段）、`src/client.ts`（子代理权限卡）
- **验证**：e2e 链路①：子代理发起训练实验 → lab_ctl 被 guard 拒绝（readonly 档断言错误信息）→ critical 告警 → 子代理 followup 收到 → 子代理 report → 父级收到；**链路②（B1 修订版）**：子代理**异常结算**（stopReason∈{max-tokens,error,cancelled} 且实验未 done）→ roots() 收到升级通知；followup 投递后无 inbox/claimed 超时（notifyTimeoutMs 注入缩短）→ roots() 收到；**链路③**：主代理发起 → 只通知主代理；**B1 验收回归**：子代理收到 critical 后**静默处理**（自行清告警/降 batch、无 report）→ **断言根代理不被通知**；once/冷恢复子代理 guard 生效断言；并发双 agent 路由断言（评审 §7 补充）。

---

## 8. 风险与回退

| 风险 | 级别 | 缓解 |
|---|---|---|
| 唤醒打扰/LLM 成本（wake 风暴） | 中 | 矩阵保守（仅 critical×关键类型 wake）；throttle 60s + 指纹 + 5min 防重三层护栏；默认 notice 起点 |
| 升级误判（warn→critical 通知） | 中 | escalate 只影响通知档位不改 level；默认 10min 持续才升；UI 展示 escalate 标记可审计 |
| 双通道重复（模型 report + 插件兜底） | 低 | **投递预算断言（≤2，§2.3）** + 兜底仅在链断裂证据（未领取/absent/异常结算）时触发；form/指纹区分；5min 防重 |
| exec.agent 缺失（旧宿主/边缘路径） | 低 | 探测降级 roots()（现状行为），不报错 |
| guard 误伤主代理/fork 分支 | 低 | isSubagent 判定用 delegationDepth/origin（**不用 parentSession**，防 fork 误伤，I4）；主代理回归测试 |
| 类型误识别 → 错误通知矩阵 | 中 | 自动层保守（未知=unknown）；配置层用户可覆盖；学习层可关（expTypeLearning=false）；误报集回归 |
| agent/created own-layer 破坏 KV 前缀 | 低 | 默认只用 guard（无 KV 影响）；own-layer 仅 restricted 档位按需启用并在文档标注 |
| 权限放宽（restricted/full）被滥用 | 低 | 默认 readonly；放宽需显式配置 + UI 警示文案 |
| **回退** | — | `alertNotify: off` + `subagentPolicy: full` + `experimentTypes: []` = 完全回到现状；每 M 独立可回退（M1 回退删引擎不删分级字段，字段可选零感知） |

---

## 9. 证据清单

| 事实 | 证据位置 |
|---|---|
| agent/created 全局可见；scopeTarget 无标签放行 | T1 调研报告结论 1；dsh-scope/lib/index.js L327-338 |
| 子代理工具集解析（global+preset+own）；view 恒先 global | T1 结论 2；dsh-subagent/lib/types/child-agent.js L126-135；dsh-tools L2843-2869 |
| installReportTool 范本（childCtx.tools.register + registerContinuableSetup） | T1 结论 3；dsh-tool-subagent-report/lib/index.js L29-96；continuation.js L709-743 |
| roots() 与子代理判定（**delegationDepth>0 \|\| origin==='subagent'**；parentSession 仅 fork lineage，不用作子代理判据） | T1 结论 4；dsh-agent L715-717；dsh-session types.d.ts L54/64/70 |
| report 只到直接父级；settle notice 无条件投递；subagent/end payload（stopReason） | T1 结论 5；dsh-tool-subagent-report README（L65「一条直接边」）；dsh-subagent L191-256/2470+ |
| agent/inbox/inserted + agent/inbox/claimed（送达证据，B1 证据 1） | dsh-agent-loop L359（inserted 发射）；runtime-types.d.ts L146-215（inserted/claimed 事件类型与语义）；dsh-agent L335-341（fused 注入 agent） |
| followup=FIFO next-turn 不打断当前轮；interrupt 需授权 | T1 结论 6；agent-loop L390-404；dsh-subagent README L76-78 |
| approval 'never' + sandbox 不 gate in-process 工具；guard/exec.agent 区分主/子 | T1 结论 7；child-agent.js L146-168；dsh-tools L2805-2820；agent-loop L117-129 |
| 告警只有 level 一维；confidence 映射；防重/TTL/上限 | T2 §1.1-1.3；balancer.ts:252-255, 374, 407；constants.ts:16 |
| 5 类消费者；emitLab 事件现状仅 console.log | T2 §1.4；index.ts:294-306；balancer.ts:383-390 |
| TRAIN_PATTERNS 误报实证（grep/heredoc/docx 案例） | T2 §2.3-2.4；~/.dsh/settings.yaml history |
| setAlerting 死代码；restoreEnded 丢 fingerprint | T2 §0.5；state-machine.ts:293-311, 348 |
| pre-execute 现状（只取 name/arguments，可扩展 exec.agent） | index.ts:1123-1141 |
| 工具注册（lab_status/lab_advice/lab_ctl 全 global 注册） | index.ts:961-1060 |
| settings 持久化模式（schema 在插件、值在 settings.yaml） | index.ts:656-746；docs/usage/usage.md:95-98 |
| RunRecord / Alert / ExperimentSnapshot 结构 | types.ts:54-117 |
| machine.start 签名与 experiment-start 载荷 | state-machine.ts:170-199 |
| 设置页控件参考（ControlPanel/TagManager/WatchManager） | client.ts:392-517, 589-688, 1167-1213, 1524-1533 |
| v2 方案（alertNotify 三档/fingerprint/steer-followup-send 语义） | docs/research/20-issue5-alert-feedback-design.md §3-4 |

> 注：T1 调研报告当前存在于团队任务 t1 输出（`.agent-teams/lab-monitor-issue5/team.json`），建议由队长安排 researcher 落盘为 `docs/research/24-t1-agent-arch-input.md`（22 为本设计、23 为评审）以便长期引用（本文档结论已内联，不阻塞实现）。