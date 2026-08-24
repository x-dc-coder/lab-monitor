# Lab Monitor 通知策略架构（Issue #5 落地实现 + 设计蓝图）

> 状态：**v2（2026-08-23，M1 落地后撰写，codex 交叉审查通过并修正）**。
> 来源：设计文档 `22-issue5-alert-notify-design.md`（评审修订定稿）+ 源码事实（M1 已实现部分）+ M2/M3 蓝图。
> 目的：向用户呈现「告警 → 分级 → 通知策略 → 投递 → 消息链」的完整架构，明示哪些已落地、哪些是蓝图。
> 审查：`codex 交叉审查`指出并修正了初稿的 2 处 BLOCKER（扩展字段数量、护栏描述）+ 多处 ISSUE；修正记录见"修订说明"。

---

## 0. 架构总览

```
                     ┌───────────────────────────────────────────────┐
                     │              数据面（已落地）                   │
  采样 backend  ────►│  sampler → SamplePoint → ring/recentWindow     │
  2s tick/5s ps      │                                               │
                     │  state-machine（实验生命周期）→ RunRecord      │
                     │  balancer（告警引擎）→ Alert[]                │
                     └───────────────┬───────────────────────────────┘
                                     │ emitLab('lab/alert')
                                     ▼
                     ┌───────────────────────────────────────────────┐
                     │       通知策略引擎（M1 已落地）                 │
                     │  ① 分级：severity/urgency/trend/sustainedMs/   │
                     │     resource/origin/escalate                  │
                     │  ② effectiveLevel（升级规则）                  │
                     │  ③ notifyAlerts：档位 → resolveAction → 投递   │
                     │  ④ 护栏：节流/指纹去重/预算守卫/clear 重置      │
                     └───────────────┬───────────────────────────────┘
                                     │ agents.roots()（M1）/ agentDir 路由（M3）
                                     ▼
                     ┌───────────────────────────────────────────────┐
                     │   投递（M1：主代理 roots）                      │
                     │  resolveAction(level, targetState)             │
                     │  → followup/steer/inject/send(next-turn,false) │
                     └───────────────┬───────────────────────────────┘
                                     │ user 消息（form:'notice'）
                                     ▼
                     ┌───────────────────────────────────────────────┐
                     │  Agent 侧（模型感知）                          │
                     │  主通道：子代理 report 上抛（M3 蓝图）          │
                     │  兜底：lab-monitor 监听 inbox/settle（M3 蓝图） │
                     └───────────────────────────────────────────────┘
```

---

## 1. 告警分级（已落地，M1）

### 1.1 Alert 扩展字段（types.ts）

`Alert` 在原有 `level/rule/msg/confidence/actions/evidence/ts/runId` 基础上新增 **8 个可选扩展字段**（全部 `?` 可选，旧消费者零破坏）：

| 字段 | 说明 | 注释标注 |
|---|---|---|
| `severity`(1-5) | 严重度（rule 权重表静态映射） | M1 生成时必填（运行时约定，非接口强制） |
| `urgency`(1-3) | 紧迫性（rule 基准 + trend=rising +1） | M1 生成时必填 |
| `trend`(rising/steady/falling) | 趋势（窗口指标对比推导） | 可选 |
| `sustainedMs` | 超阈值持续时长（hitByRule × SAMPLE_MS） | M1 生成时必填 |
| `resource` | 资源类别（gpu-util/vram/temp/cpu/mem/io/process） | 规则映射 |
| `origin` | 归属（self/other/system） | 规则映射 |
| `notifyLevel` | 策略引擎输出档位（可空，投递后回写） | 可选 |
| `escalate` | warn→critical 通知升级标记 | 触发时 True |

> **重要**：`severity/urgency/sustainedMs` 是 M1 告警**生成路径**（evaluate/pushExternal）的运行时约定——evaluate 命中 rule 时从权重表静态填充、pushExternal 用 crash 默认值兜底；**不是** `Alert` 接口类型层面必填（接口字段全是 `?`，避免破旧消费者/兼容外部 pushExternal 的旧告警形态）。

### 1.2 rule 语义权重表（balancer RULES）

| rule | level | severity | urgencyBase | resource | origin |
|---|---|---|---|---|---|
| oom | critical/warn（动态） | 4 | 2 | vram | self（组不活跃动态改 other） |
| io-bottleneck | warn | 3 | 2 | io | self |
| thermal | warn | 4 | 2 | temp | self |
| imbalance | info | 2 | 1 | gpu-util | self |
| other-occupancy | info | 2 | 1 | vram | other |

### 1.3 有效级别（effectiveLevel，index.ts）

`effectiveLevel` 在**不修改 Alert.level**（避免破坏 5 类消费者）的前提下计算通知视角的有效级别：

```
critical                         → critical
warn + escalate=true             → critical（warn 持续 ≥ escalateAfterSec）
warn + trend=falling             → info（缓解中不打扰）
info + origin=other              → off（他人占用，仅记录）
其余                             → 按 level
```

### 1.4 trend=falling 判定（M1 收尾新增）

`metricOf(rule)` 提取各 rule 的触发指标，对窗口首尾对比做回落判定（末值 < 首值 × 0.9 → falling）：

| rule | metricOf 提取 | 状态 |
|---|---|---|
| oom / other-occupancy | 首卡显存利用率 % | ✅ 已支持 |
| thermal | 首卡温度 °C | ✅ 已支持 |
| imbalance | 多卡 util 差（max-min） | ✅ 已支持 |
| io-bottleneck | **无单体指标，返回 null**（源码注释明确：io 无单体指标时不做回落判断） | ⚠️ 安全回退为 steady（不误报） |
| 未知 rule | null | ⚠️ 安全回退 |

> 说明：`io-bottleneck` 当前**不基于 GPU util 判 falling**（metricOf 返回 null），文档如实标注为"未支持/安全回退"，而非"已实现 GPU util 指标"。

---

## 2. 通知策略引擎（已落地，M1）

### 2.1 输入 → 输出

```
输入：告警视图（effectiveLevel × severity × urgency × trend × origin × runId）
      + 目标代理状态（M1：roots 的 running/idle；M2/M3 补类型/子代理路由）
      + 配置（alertNotify/alertTargets/notifyThrottleMs/escalateAfterSec/...）
输出：notifyLevel（off/notice/wake）→ resolveAction(level, targetState) → 投递动作
```

### 2.2 档位计算（notifyAlerts，M1 简化语义）

M1 无类型识别/子代理路由 → 目标=roots（主代理）。档位 = 批内告警的最高有效级别：

| 批内最高有效级别 | notifyLevel |
|---|---|
| critical（非 origin=other） | alertNotify=wake ? wake : notice |
| warn（非 origin=other） | notice |
| info / off | off（仅 UI/工具可见） |
| 仅 origin=other | 不打扰（off 或按配置） |

每条告警单独定 notifyLevel（critical→wake/notice、warn→notice、info/off→off、origin=other→off），通过 `balancer.setNotifyLevel(runId, rule, level)` **回写到告警**（设计 §1.2"引擎输出写回告警视图"，UI 徽标/advice 可见）。

### 2.3 resolveAction 纯函数（已落地 + 全格测试）

`resolveAction(level: off/notice/wake, targetState: running/idle/absent) → Action`

| level | running | idle | absent |
|---|---|---|---|
| off | off | off | off |
| notice | inject | send-nq | escalate-root |
| wake | steer | followup | escalate-root |

**语义红线（设计 §2.5 I2，评审源码实证）**：`steer = send(msg,'next-step', true)` 对 idle agent 会**启动新回合**。因此「不唤醒」只用 `inject`（running）/`send(next-turn,false)`（idle）；`steer` 仅在 running 时用；`followup` 仅 idle 唤醒用。

### 2.4 护栏（已落地，M1 范围）

| 护栏 | 机制 | 现状 |
|---|---|---|
| 节流/聚合窗口 | `notifyThrottleMs`（默认 60000ms）：同目标窗口内最多 1 条 | ✅ |
| 指纹去重 | 批次级 `fp = level:rule:msg` 拼接（**不含 runId**）；escalate=true 允许再通知 | ✅ |
| 投递预算守卫 | 按 **agent 目标 id** 累计（非"告警×目标"粒度），上限 2 条 | ✅（当前只有主通道 1 条路径，此守卫为 M3 兜底预留） |
| clear 联动 | `lab_ctl clear-alerts` 清空通知指纹（保留 balancer 5min 防重；**不重置节流时间/预算**） | ✅ |
| 无 agents 降级 | 无 agents 服务 → 静默跳过，工具不受影响（KV 零影响） | ✅ |

> **重要**：投递预算上限 2 是一个**全局计数守卫**（按目标 id 累计），**不是**"同一告警 × 同一目标 ≤ 2"的精确语义。M1 实际只有**一条**投递路径（主通道），第 2 条"链断裂兜底"属于 M3 蓝图尚未实现，届时才真正消费这个预算。

### 2.5 配置面（settings 命名空间 lab-monitor）

```yaml
lab-monitor:
  alertNotify: notice        # off|notice|wake（无类型上下文 fallback；实际档位由引擎算）
  alertTargets: []           # 空=roots()；显式 agentId 列表
  notifyThrottleMs: 60000
  escalateAfterSec: 600      # warn 持续该秒数 → 通知升 critical
  notifyTimeoutMs: 600000    # M3 兜底等待（可注入 LAB_MONITOR_NOTIFY_TIMEOUT_MS）
  broadcast: false           # M3 广播（默认关）
```

三通道改配置（**注意：当前控制面只改其中 3 项**）：
- `lab_ctl set-notify`：可改 `alertNotify` / `escalateAfterSec` / `notifyThrottleMs`（✅）
- 设置页 NotifyCard：同上 3 项（✅）
- settings.yaml 热更新：可读写全部 6 键（✅）
- **`alertTargets` / `notifyTimeoutMs` / `broadcast` 当前无 UI/工具控制面入口**，只能经 settings.yaml / 插件 config 行配置——如实标注，非"全通道可改"。

---

## 3. 工具与 UI（已落地）

- **lab_status / lab_advice / lab_ctl**：工具注册（global 层）；lab_ctl 含 `set-notify`（改 3 项）；lab_advice 透传分级扩展字段；快照透出 `notify` 配置块 + `alerts[].notifyLevel`
- **设置页 NotifyCard**：三档（静默/通知/唤醒）+ escalateAfterSec 输入 + 保存 → control set-notify（改 3 项）
- **告警多维徽标**（AlertList）：S 严重度 / U 紧迫性 / trend 箭头 / 升级 / 通知档位

---

## 4. 蓝图（M2/M3，未实现）

### 4.1 M2 实验类型 × 通知（设计 §3）

8 类枚举（smoke/regression/full/short/long/gpu-calc/gpu-train/unknown）× 处理模式差异表 + 三层识别（自动/配置/学习）。**前置**：TRAIN_PATTERNS 已精度修复（完成）。**未做**：`RunRecord.type` 字段缺失；`RunRecord.fingerprint` **存在**（内存态）但**未持久化**（历史恢复时 fingerprint=''）——两者应区分。

### 4.2 M3 路由 + 权限 + 消息链（设计 §4/§5）

- **路由**：pre-execute 读 `exec.agent` → RunRecord.agentId + agentDir 目录；absent→升根；子代理→根祖先链
- **权限**：`subagentPolicy`（readonly 默认）——host 全局 guard + `registerContinuableSetup` 注入只读 lab_status_ro + agent/created 影子化
- **消息链**：主通道=模型 report 上抛（只到直接父级）；兜底=lab-monitor 监听 inbox/claimed + subagent/end stopReason（链断裂证据驱动，非"无动静即转发"）

---

## 5. 设计-实现对照

| 层 | 已实现（M1） | 蓝图（M2/M3） |
|---|---|---|
| 分级 | ✅ severity/urgency/trend/sustainedMs/resource/origin + escalate + notifyLevel 回写 | — |
| 升级 | ✅ warn→critical（escalateAfterSec） | — |
| trend | ✅ rising/steady/falling（窗口对比；io-bottleneck 安全回退） | — |
| 策略引擎 | ✅ effectiveLevel + 档位 + resolveAction（roots 单目标） | 「策略矩阵」场景行（M2 类型矩阵） |
| 护栏 | ✅ 节流/指纹/预算守卫/clear | 投递预算 M3 兜底第 2 条 |
| 路由 | 仅 roots() | agentDir + exec.agent（M3） |
| 权限 | 无 guard | subagentPolicy（M3） |
| 消息链 | 插件投递 user 消息 | report 主通道 + 兜底中转（M3） |
| 配置 UI | ✅ settings 六键 + NotifyCard（改 3 项） | experimentTypes 类型规则卡（M2） |

---

## 6. 边界与已知缺口

- **通知引擎触发时机**：仅 `lab/alert` 事件驱动；设计 §2.4 的"评估周期末尾"兜底（清除/过期通知）未实现（M1 缺口，影响小）
- **投递预算第 2 条**（链断裂兜底）为 M3；M1 主通道只用 1 条
- **policyFor 场景矩阵**为注释代码（M2 启用；M1 用等价简化档位逻辑）
- **KV 缓存**：默认路径（guard 除外）零影响；通知是历史尾部低频 user 消息；`registerContinuableSetup`（M3）会改变子代理组合 → 冷恢复子代理一次性前缀变化
- **`lab_ctl set-notify` 只改 3 项通知配置**（alertNotify/escalateAfterSec/notifyThrottleMs），其余 3 项非当前控制面可编辑项

---

## 7. 修订说明（codex 交叉审查修正记录，v1→v2）

| # | 初稿错误 | 修正 |
|---|---|---|
| 1 | 误称"9 个扩展字段" | 改为 **8 个**（severity/urgency/trend/sustainedMs/resource/origin/notifyLevel/escalate） |
| 2 | "必填三字段"表述为接口必填 | 改为**生成路径运行时约定**，接口字段全为 `?` 可选 |
| 3 | io-bottleneck 描述为"GPU util 指标" | 改为 **metricOf 返回 null（未支持/安全回退）**，文档如实标注 |
| 4 | 护栏描述过于完整 | 指纹**不含 runId**、预算**按目标累计**、**无第 2 条投递**——均如实修正 |
| 5 | "设置页三通道改配置"过宽 | 标注 **set-notify/NotifyCard 只改 3 项**，另 3 项仅 settings.yaml 可改 |
| 6 | M2 缺口笼统"RunRecord.type+fingerprint 都缺" | 拆分为 **type 缺失 vs fingerprint 存在但未持久化** |
| 7 | 文件名 `arhitecture` 拼写错误 | 改为 `architecture` |

---

## 8. 证据源

- 设计：`docs/research/22-issue5-alert-notify-design.md`；评审：`23-issue5-design-review.md`；T1：`24-t1-agent-arch-input.md`；T2：`21-t2-alert-grading-and-exp-type-input.md`
- 源码：`src/core/types.ts`（Alert 8 扩展字段）、`src/core/balancer.ts`（RULES 权重 + metricOf + setNotifyLevel + escalate）、`src/index.ts`（effectiveLevel + notifyAlerts + 配置 + set-notify）、`src/client.ts`（NotifyCard + 多维徽标）、`scripts/verify-m1.js`（19 断言）
