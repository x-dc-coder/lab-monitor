# 23 Issue #5 综合设计评审报告

> 状态：**独立评审**（2026-08-23，Issue #5 设计任务 T4 交付，评审对象 = `22-issue5-alert-notify-design.md`）。
> 方法：逐条对照用户 6 问 + 对设计文档中每一处 DSH 机制声称做**宿主源码抽查**（dsh 0.1.1-rc.1 安装包 `@deepseek-ai/dsh/node_modules/@deepseek-ai/`）+ 对照 T1 调研（team.json t1 输出）、T2 调研（`21-t2-alert-grading-and-exp-type-input.md`）、v2 方案（`20-issue5-alert-feedback-design.md`）+ lab-monitor 源码复核。未修改设计文档。
> 评审结论：**机制真实性整体通过（无虚构 API）；但消息链兜底条件存在逻辑矛盾（BLOCKER）、steer 唤醒语义被误用（ISSUE）、策略矩阵缺目标状态维度（ISSUE）、guard 与 restricted 档位自相矛盾（ISSUE）**。必改项清单见 §9。

---

## 1. 总评

| 评审项 | Verdict | 一句话结论 |
|---|---|---|
| ① 严格分级 | **PASS** | 多维扩展字段 + rule 权重表 + 升级规则，可落地 |
| ② 档位随预警调整 | **PASS** | alertNotify 降为 fallback，引擎按矩阵计算，映射表齐全 |
| ③ 实验类型差异化 | **PASS**（附 1 个 minor） | 8 类枚举 + 处理模式差异表 + 三层识别，非泛泛而谈 |
| ④ 路由判定 | **PASS**（附 2 个 ISSUE） | 决策树清晰可执行；但矩阵缺"目标代理状态"维度、absent 情形未显式入树 |
| ⑤ 子代理权限 | **ISSUE** | 机制真实（T1 全支撑）；但 readonly 对一次性子代理"感知子集"不成立、guard 与 restricted 档位冲突、isSubagent 判定过宽 |
| ⑥ 信息给主代理 | **BLOCKER** | 主通道真实；兜底条件与主通道哲学矛盾 → 必双通知 |
| 机制真实性 | **PASS**（附 2 个 minor） | 逐项源码核对，无虚构 API；个别引用行号有漂移 |
| KV 缓存影响 | **PASS** | 正常态零影响成立；需补充冷恢复子代理的一次性前缀说明 |
| 安全与权限边界 | **ISSUE** | 默认 readonly 方向正确；restricted/full 与全局 guard 冲突必须先解 |
| 复杂度与可维护性 | **ISSUE** | 双矩阵 + 动作/档位两层语义混杂；建议收敛为 notifyLevel×目标 |
| 遗漏与边界 | **ISSUE** | 告警风暴/并发已覆盖；clear-alerts、无 ACK、中途切换、静默处理需显式定义 |
| 验证方案 | **ISSUE** | 骨架好；缺矩阵全格单元测试、"静默不兜底"回归、双通道去重断言 |

---

## 2. 用户 6 问覆盖度

### 2.1 ① 事件预警是否有严格分级 —— **PASS**

**优点**：
- 不是空谈：`severity(1-5)/urgency(1-3)/trend/sustainedMs/resource/origin/notifyLevel/escalate` 8 个扩展字段全部**可选**（types.ts:108 `| string` 逃逸口已核实），不破坏 5 类消费者；
- §1.3 rule 权重表给出 severity/urgency 的**静态来源**（crash=5/3、oom=4/2…），§1.4 给出可执行的 5 条降级/升级规则，`escalateAfterSec` 默认 600s 触发 warn→critical 通知升级——修复了 T2 指出的「warn 永不升级」缺陷；
- "检测不分级、通知分级"的定位清晰（§1.4），避免阈值体系配置爆炸。

**问题**：
1. 扩展字段虽是"全部可选"，但设计未声明**哪些字段是 M1 必填**（severity/urgency 由规则表静态可得必填；trend/sustainedMs 由 hitByRule/recentWindow 推导）。若不设必填断言，实现时可能只填 notifyLevel → 多维分级退化为空谈。建议在 §1.5 落点中写明"三字段必填（severity/urgency/sustainedMs），其余可空"。

### 2.2 ② 默认档位随预警调整 —— **PASS**

- `alertNotify` 明确降级为"无实验上下文/unknown 时的 fallback（默认 notice）"，实际档位由策略引擎按「有效级别 × 实验类型 × 实验状态 × 归属」计算——满足用户"非全局固定"要求；
- §2.2 主策略矩阵 10 行场景给出明确映射（critical×gpu-train→wake、warn×smoke→off 等），§2.3 给出仲裁/节流/合并规则；
- notifyLevel 写回告警视图、UI 透明展示"为什么这样通知"——闭环到用户可见。

**问题**：见 2.3/2.4 —— 矩阵与类型表的**两层动作语义**（notifyLevel off/notice/wake vs 动作 steer/followup/send）需要先收敛，否则"档位"到底指哪个找不到唯一答案。

### 2.3 ③ 实验类型差异化处理 —— **PASS**（附 minor）

- 8 类枚举（smoke/regression/full/short/long/gpu-calc/gpu-train/unknown）语义表齐全（§3.1）；
- §3.4 类型×处理模式差异表逐类给出 critical/warn 通知档位、唤醒行为、超时关注——不是泛泛而谈；
- 识别三层（自动/配置/学习）有实施顺序、失败语义（未命中=unknown 不猜）、前置修复（TRAIN_PATTERNS 精度）——与 T2 结论一致。

**问题（minor）**：
1. **§2.2 与 §3.4 表间不一致**：short 在 §2.2 是 `critical → steer`，在 §3.4 是 `wake`；full 只在 §3.4 有 `wake` 行，§2.2 无 full 行。两张表用了不同轴（§2.2=动作×目标，§3.4=通知档位），叠加优先级未定义。**必须合并为一个矩阵或明确定义查找顺序**（建议：规则查找 = 场景行(§2.2) 最优先 → 类型默认(§3.4) → 全局 fallback）。
2. §3.4 `scale`（类型级灵敏度乘数）与 §1.4"检测不分级"自相矛盾（设计已标注"可选、默认 1.0"，但仍建议**移出 M1/M2 或直接删除**——YAGNI，且用户问题 3 问的是"处理模式"不是"阈值缩放"）。

### 2.4 ④ 通知子代理还是主代理 —— **PASS**（附 2 个 ISSUE）

- 路由决策树（§4.2）清晰可执行：runId → RunRecord.agentId（来自 pre-execute 的 exec.agent，**机制已验证**）→ 目标=发起者；agentId 缺失/runId=null → roots()/alertTargets；广播默认关；
- 发起者为子代理时并行通知根祖先链——"子代理处理 + 根知情兜底"的意图合理；
- 多 agent 并发实验按 runId 分别路由（每个 RunRecord 独立 agentId），结构上正确。

**问题（ISSUE）**：

1. **矩阵缺"目标代理状态"维度**：§2.1 输入 C 声明了「目标代理状态 running/idle/absent」，但 §2.2 矩阵**没有任何行/列使用它**。而动作选择恰恰依赖目标状态（running→steer/inject；idle→followup 会唤醒、send(next-turn,false) 不唤醒；absent→必须升根）。当前矩阵把动作钉死，遇到"实验 running 但子代理 idle"（长任务后台跑、子代理已交还轮次——**完全常见的形态**）时动作语义就错了。**建议**：矩阵单元格改为「动作(按目标状态)」三元组，或补一行目标状态解析规则（见 §9 建议文本）。
2. **absent 情形未显式入树**：§4.2 只覆盖"agentId 缺失"，未覆盖"agentId 存在但 agent 已 disposed/absent"。§5.4 限制区提了"目录缺失时回退"，但决策树应显式加：`agentDir.get(agentId) === undefined → 直升根（followup）`。实验进程是后台进程，发起子代理可能已结算——这是**常态而非边角**。

### 2.5 ⑤ 子代理权限 —— **ISSUE**

**优点**：三级策略（readonly/restricted/full）默认 readonly；实现三件套全部有 T1 证据、且我已源码复核：
- host 全局 guard（dsh-tools 的 `guard(guard)` + `guardReason`：global 层先查、chainLayers(exec.agent) 次查、**单调不可翻案**）——✓ 真实；
- `registerContinuableSetup`（dsh-subagent L2481）+ installReportTool 范本（childCtx.tools.register + systemPrompt.section，fresh 与 cold resume 都生效，continuation.js L709-743）——✓ 真实；
- `agent/created` 钩子（agent.ctx 已就绪、scoped restrict 可行）——✓ 真实（own-layer KV 影响也被正确标注）。

**问题（ISSUE，3 个）**：

1. **guard 与 restricted/full 档位冲突（必须解）**：§5.3.1 说全局 guard"**覆盖一切子代理**"拒绝 lab_ctl，但 §5.2 说 restricted 档子代理"可做 lab_ctl 白名单 action"、full 档"全部"。**这两个机制直接矛盾**——guard 单调、后续监听器无法翻案，若 guard 无条件拒绝，restricted/full 永远无法放行。**建议**：guard 闭包读取策略存储（`subagentPolicy` + 白名单表），`deny` 条件改为 `isSubagent && policy!=='full' && 动作不在白名单`；restricted 的动作白名单在 `lab_ctl` 工具内部按 `exec.agent` 判定（工具是插件自己的，可精确到 action）。
2. **readonly 对一次性子代理"感知子集"不成立**：默认 readonly = 只有 guard（三件套 #2/#3 是 M3 才做、且 #3 仅 restricted 需要）。一次性子代理仍可见 global 层完整 `lab_status`（读全机快照：他人实验/整机进程细节）——§5.2"lab_status（实验感知子集）"对一次性子代理是空话。**建议**：要么明确文档化"一次性子代理 = 全量只读（M3 前）"，要么 M3 用 agent/created 做 own-layer 影子 lab_status（KV 代价已标注）——二选一，但必须写清楚，否则用户问题 ⑤ 的答案不完整。
3. **isSubagent 判定精度**：§5.3/§4.1 用 `parentSession 存在` 判定子代理。但 session header 的 `parentSession` 是 **fork seed lineage**（types.d.ts L54），fork 会话也有 parentSession。**用 parentSession 会把 fork 分支误判为子代理 → fork 的主线分支被剥夺 lab_ctl**。**建议**：改用 `delegationDepth > 0`（types.d.ts L70，持久化，重启不丢）或 `origin === 'subagent'`（L64）为主判据，并显式决定 fork 是否要受限（建议：不受限，或单独配置）。

### 2.6 ⑥ 信息传递给主代理 —— **BLOCKER**

**优点**：主通道（模型 report 自然上抛）是**唯一正确的官方语义**——report 只到直接父级已核实（dsh-tool-subagent-report/README.zh.md L65：「嵌套上报只向上到达一条直接边」）；source.kind `subagent-report|subagent-settled` 已核实（continuation.d.ts L32-58）；followup=next-turn FIFO 不打断当前轮（agent-loop L390-404）✓；插件兜底监听 agent/inbox/inserted（agent-loop L359，payload {agent,message} 经 agentEvents fused 注入）✓、subagent/end stopReason（dsh-subagent L191-256）✓——全部真实。

**问题（BLOCKER——兜底条件与主通道哲学矛盾）**：

设计自身声明（§4.3 主通道优点）：**"子代理能自己处理（降 batch/清告警）就不打扰父级"**——静默处理是**常态路径**。但兜底通道第 3 条：**"critical 告警发出后 notifyTimeoutMs（默认 60s）内无该子代理的 report/settle 活动 → 自动向根转发"**。静默处理 = 无 report/settle 活动 → **兜底必然触发 → 每条 critical 都会被双通知（子代理已处理 + 根被唤醒）**。这不是"链断裂时触发"，而是"没动静就触发"——与"链断裂"的前提无关，也与"不打扰父级"矛盾。且子代理若正在跑长轮次（followup 排队到轮次结束），60s 内无 report 更是常态，误报率接近 100%。

**建议修订（替换 §4.3 超时兜底）**：兜底只应在**存在链断裂证据**时触发：
1. `subagent/end` stopReason ∈ {max-tokens, error, cancelled} 且该子代理在途实验未 done（已设计，保留）；
2. 目标子代理 absent/disposed（并入 §4.2 决策树）；
3. （可选）followup 投递后 `agent/inbox/claimed` 超时未发生（claim 事件 = **比"report/settle 活动"精确得多的"已送达"证据**，runtime-types.d.ts L194 已核实）——且仅对 critical × crashed 生效。
**删除"60s 无活动即转发"**。同时把"同一信息最多两条（模型一条 + 插件兜底一条）"改写为显式计数：**每条告警 × 每个目标的投递预算 = 1（主通道）+ 至多 1（仅链断裂兜底）**，并在 §2.3 防重小节给出断言。

---

## 3. 机制真实性审查

逐项源码核对结果（dsh 0.1.1-rc.1 安装包；与设计 §9 证据清单对照）：

| 设计声称 | 源码实证 | 结论 |
|---|---|---|
| pre-execute 的 exec 含 `.agent`（agent-loop L117-129） | `exec = {callId, name, arguments, agent, signal}`，`agent = ctx.agents.requireInitiator()`；pre-execute waterfall 载体 `scopeTarget(this, exec.agent)`（dsh-tools L3104-3116） | **PASS**（lab-monitor pre-execute 实收 exec，index.ts:1123-1141 已复核） |
| agent/created 全局可见（dsh-scope L327-338） | `scopeTarget` 谓词：`scopeOf(ctx) === undefined → true`；事件载体 `agentCarrier(agent)`（dsh-agent L335-341）；payload {agent} | **PASS**（host 无标签监听器收全部 agent 事件） |
| agent/inbox/inserted source.kind 过滤（T1 引 dsh-agent L151） | 事件真实：`dispatch.emit("agent/inbox/inserted", {message})`（agent-loop L359），agentEvents `fused` 注入 agent → payload {agent, message}（与 runtime-types.d.ts L180 一致）；source.kind 值 'subagent-report'/'subagent-settled'/form relay/notice（continuation.d.ts L32-58） | **PASS**（引用行号应是 agent-loop L359，非 dsh-agent L151——minor 漂移） |
| subagent/end 携带 stopReason（dsh-subagent L191-256） | `emit("subagent/end", {...identity, stopReason, lastAssistantMessage}, parent)`；stopReason ∈ completed/error/max-tokens 等（L191-213 复核） | **PASS** |
| roots() 主代理视图 | `roots() = [...store.values()].filter(e => e.owner === undefined)`（dsh-agent L715-717） | **PASS**（运行时非持久化——设计已注明） |
| report 只到直接父级 | README.zh.md L65「嵌套上报只向上到达一条直接边」；`reportFrom` 按持久化 parentSession 推导唯一接收方（L7）；**无读回执**（L7「不表示已读回执…」） | **PASS**（无 ACK 已被 README 明示，见 §7） |
| registerContinuableSetup + installReportTool 范本 | `registerContinuableSetup`（dsh-subagent L2481）；installReportTool = childCtx.systemPrompt.section + childCtx.tools.register + apply() 经 registerContinuableSetup（dsh-tool-subagent-report L29-96）；continuation.js materializeTracked：applyChildComposition → setupRegistry.apply（L709-743，fresh/cold 均走） | **PASS** |
| guard 全局先查、单调 | `guardReason(exec)`: global 层 → chainLayers(exec.agent)；global 层注册即插件宿主 ctx（layers.effect） | **PASS**（guard 收到 exec，含 .agent/.name；`guard(guard)` 同步谓词、字符串即拒绝） |
| view 恒先取 global 层 | `view(scope)`: `inherited = new Map(layers.global.tools.entries())` 先于 chain 层；own 层注册覆盖同名 | **PASS**（"子代理默认见 lab_ctl"成立） |
| 子代理工具集 = global + preset + own + restrict | `applyChildComposition`：composeFrom(parent) → delegation context → persona → restrict(toolFilter)（child-agent.js L126-135） | **PASS** |
| 委派策略 approval 固定 'never' + sandbox 快照继承 | `captureDelegatedPolicyOverrides`：approval 一律 pin 'never'；sandbox 仅继承父会话显式 override（child-agent.js L146-168） | **PASS** |
| followup=next-turn FIFO 不打断当前轮 | `followup = send(input,"next-turn",true)`；`steer = send(…,"next-step",true)`；`inject = send(…,"next-step",false)`（agent-loop L390-404；runtime-types.d.ts idle/steer/inject 语义注释） | **PASS**（但见 §2.6/§9：**steer 对 idle agent 会启动新回合**——设计在多处误用） |
| exec.agent 缺失降级 roots() | exec.agent 在 0.1.1-rc.1 恒注入；缺失防御分支无害 | **PASS** |
| agent.ctx 作用域注册可行 | agent/created 在 setup 完成后发布（events 注释），agent.ctx 已就绪；scoped 注册落 own layer、随 dispose 撤销 | **PASS**（own-layer 改首请求前缀——设计已标注 KV 影响） |
| `agents.list()` / `context()` 快照等 | 设计中**未出现**任何虚构 API（全文 grep 零命中）；动作枚举全部落在真实 API（followup/steer/inject/send/roots/reportFrom） | **PASS**（无"看起来能用实际不存在"的 API） |

**minor**：
1. dsh-agent L151 的 inbox 引用应更新为 agent-loop L359 + runtime-types.d.ts L180（T1 的原始标注漂移，设计沿用了）。
2. §5.3 的"agentDir 目录（§5.3）"交叉引用错位，应为 §5.4。
3. 设计声称 lab_ctl 注册在 global 层——已复核（index.ts:961 起 toolsService.register 于宿主 ctx）✓ 无问题。

---

## 4. KV 缓存影响 —— **PASS**（附 1 个补充建议）

**正常态零影响成立**：
- 默认路径 = 全局 guard 一个（非工具、不改 prompt、不注入），主代理与子代理的请求内容零变化 → 100% 命中不变；
- 通知是低频 user 消息落历史尾部（告警 5min 防重 + 指纹 + 60s 节流），吸收在尾部不破坏前缀；
- promptLine 注入默认关（index.ts:1105-1120）——设计未触碰；
- M1 验证含"KV 命中率基线回归（正常态 100%）"。

**补充建议**：
1. `registerContinuableSetup`（lab_status_ro + systemPrompt.section + restrict）会改变**子代理**的组合内容 → 子代理首请求前缀变化；对**在插件安装前已存在、之后冷恢复的续跑子代理**是一次性 KV miss（之后就稳定）。设计已标注 own-layer 的 KV 影响，但**未标注 continuable-setup 的同类影响**——建议在 §5.3.2 补一句。
2. 建议验证清单补一条：**"告警时仅目标 agent 的历史尾部增长，非目标 agent 前缀零变化"**——把"影响有界"从口头变成断言。

---

## 5. 安全与权限边界 —— **ISSUE**

**符合委派策略的部分（PASS）**：
- approval 'never' + sandbox 快照继承是宿主强制（captureDelegatedPolicyOverrides），子代理不可能升权——设计未尝试绕过，方向正确；
- 插件的所有手段都是**只减不增**（guard 拒绝 / restrict 收窄 / 影子只读工具），符合"作用域非安全边界、只能拒绝不能加宽"（T1 限制清单）；
- 默认 readonly + 不放宽到 full、UI 警示文案——保守默认正确；
- 不采用 interrupt()（需祖先授权、属产品决策）——正确的克制。

**问题（越界/矛盾风险）**：
1. **guard × restricted/full 冲突**（同 §2.5-1）：不解决则 restricted 档形同虚设、full 档对子代理永远不可能——配置面会给出**做不到的选项**。必须先解。
2. **fork 误伤**（同 §2.5-3）：parentSession 判据会把用户 fork 的分支会话（有权继续主线工作）划为子代理并剥夺 lab_ctl——用户会困惑。改为 delegationDepth/origin 并显式决策 fork。
3. **一次性子代理的全局只读可见性**（同 §2.5-2）：readonly 档对一次性子代理实际是"全量只读 lab_status"——属于信息暴露超承诺；文档必须写明，或 M3 影子化。
4. 安全边界外一项必须补：**策略存储本身的读写权限**——agentDir/subagentPolicy 存内存（§5.4 已说明），若日后持久化需确认 lab_ctl 等控制面不可被子代理改写（当前无持久化，安全）。

---

## 6. 复杂度与可维护性 —— **ISSUE**

**过度设计点**：
1. **两套语义层（notifyLevel vs 动作）混杂**：策略引擎输入侧有 notifyLevel（off/notice/wake 写回告警），输出侧有动作（off/inject/steer/followup/send）；§2.2 矩阵用动作、§3.4 表用档位，二者换算关系（wake⇒followup? steer?）没有一处明确定义——这是 §2.2/§3.4 不一致的根因。**建议**：策略层只表达 `notifyLevel × 目标`（off/notice/wake），**具体动作由投递器按目标状态在运行时选择**（wake ⇒ running 时 steer/followup、idle 时 followup；notice ⇒ running 时 inject、idle 时 send(next-turn,false)）——动作选择收进一个纯函数 `resolveAction(level, targetState)`，矩阵可读性大增、测试面收窄。
2. `scale` 灵敏度乘数：与"检测不分级"矛盾且需求未证——删或 M4。
3. 配置面 12 个键（alertNotify/alertTargets/notifyThrottleMs/escalateAfterSec/notifyTimeoutMs/broadcast/experimentTypes/expTypeLearning/expTypeDefault/subagentPolicy…）——每个都有默认值且互不嵌套，UI 四张卡可承载；但 `escalateAfterSec` 与 `notifyTimeoutMs` 都默认 60000/600 且容易混淆（一个秒一个毫秒），建议统一单位并排注解。
4. **建议的简化**：M1 只交付「扩展字段 + 升级规则 + 单矩阵（notifyLevel×目标）+ 全局投递器」；M2 交付类型识别与类型覆盖；M3 交付路由+权限+消息链。**把 §3.4 的"处理模式差异表"降级为 experimentTypes 配置的默认建议值，不单独实现一套代码分支**——设计已暗示如此，请写死"类型矩阵 = 配置，不硬编码"。

---

## 7. 遗漏与边界场景 —— **ISSUE**

| 场景 | 覆盖情况 | 结论 |
|---|---|---|
| 多 agent 并发实验 | 按 runId→agentId 分别路由，agentDir.runs 支持多维；MAX_PARALLEL_RUNS=4 复核存在 | **已覆盖**（建议 M3 验证补一例并发双 agent） |
| 实验中途 agent 切换/发起者结算 | 后台进程继续跑、发起子代理已结算 → agentId 指向 dead agent；设计只在 §5.4 限制区隐式提"目录缺失回退"，决策树未显式 | **缺显式规则** → 并入 §4.2 决策树（absent → 升根） |
| 告警风暴 | 合并单条 + 60s 节流 + 指纹 + 5min 防重三层 + ALERT_MAX=20 | **已覆盖**（升级例外允许新指纹再通知一次，节流兜底） |
| agent 重启（持久化） | agentDir 内存态、roots() 非持久化、冷 child 无事件——设计 §5.4 已写上"目录缺失回退 roots()/alertTargets" | **已覆盖**（接受降级） |
| clear-alerts 后状态 | **未定义**：清告警后同指纹告警再次触发是否重新通知？插件通知指纹（notifiedFingerprint）与 balancer 存储互不感知 | **缺**：建议 clear-alerts 同步重置插件通知指纹（保留 balancer 5min 防重护栏）并写进 M1 验证 |
| 通知送达确认（无 ACK） | report README 明示无读回执；设计未显式声明"无 ACK"边界，60s 兜底把"无活动"当"未送达" | **缺**：以 agent/inbox/claimed 为"已送达"证据 + 显式声明无 ACK 语义（见 §2.6 修订） |
| 静默处理（子代理自行解决） | 设计主通道哲学支持，但兜底第 3 条必然触发 | **BLOCKER 根因**（见 §2.6） |
| 升级后再通知（escalate=true） | 指纹加 escalate/新 rule 维度 → 允许再通知一次 | **已覆盖** |
| 广播目标含已结算子代理 | broadcast 默认 false；开启时需过滤 agentDir absent | minor，随 absent 规则一并处理 |

---

## 8. 验证方案评估 —— **ISSUE**

**好的部分**：M1 单元（权重表/升级规则）+ e2e（oom 低阈值触发矩阵行为）+ KV 基线 + 降级路径；M2 误报回归集（T2 §2.3 案例）+ 类型样本表 + 配置覆盖断言；M3 三条 e2e 链路（子代理收到+guard 拒绝+report 上抛 / 60s 兜底 / 主代理直收）+ 冷恢复/一次性 guard 断言——**骨架正确，链路 ①-③ 确实覆盖"告警→子代理→主代理"**。

**缺口（必须补）**：
1. **策略矩阵全格单元测试**：矩阵是核心交付物，现状验证只提"观察矩阵行为"。应表驱动逐格断言（10 场景 × 3 目标 × 3 状态）。
2. **"静默处理不触发兜底"回归测试**（BLOCKER 的验收）：子代理收到 critical 后自行清告警/降 batch、无 report → **断言根代理不被通知**。
3. **双通道去重断言**：同一告警对同一目标投递 ≤ 2（主通道 1 + 兜底 1）且兜底仅在链断裂时发生——要有自动化断言，不能靠手工观察。
4. **目标状态维度测试**：同场景 × {子代理 running, idle, absent} 三态动作断言（尤其 idle 时 steer 会唤醒——若按 §9 修订后该行为应消失）。
5. 60s 兜底 e2e 要等真实 60s——`notifyTimeoutMs` 应做成可注入（环境变量/测试参数），否则 e2e 基建痛苦。
6. M3 验证里"子代理模型不响应 → 60s 兜底"这条**在修订后应改为**"子代理 settled-but-no-report（异常结算）→ 依 stopReason 兜底"。

---

## 9. 设计定稿前的必改项清单

### BLOCKER（必须改，否则核心链路不可用）

**B1. 删除/重写"60s 无 report/settle 活动即向根转发"§4.3 兜底第 3 条**

建议修订文本（替换 §4.3 超时兜底）：

```
超时兜底（仅当存在链断裂证据）：
- 证据 1：followup 投递后 notifyTimeoutMs（默认 600s，可注入）内
  无 agent/inbox/claimed（消息未被该子代理领取）→ 视为未送达 → 升根通知；
- 证据 2：目标子代理 absent/disposed（agentDir 命中失败）→ 立即升根；
- 证据 3：subagent/end stopReason ∈ {max-tokens, error, cancelled}
  且该子代理在途实验未 done → 根级升级通知（已设计，保留）。
明确不做：以"无 report/settle 活动"作为兜底判据（子代理静默处理
是主通道的常态路径，静默 ≠ 链断裂；误判必致双通知）。
```

配套：§2.3 防重小节补投递预算断言：「同一告警 × 同一目标 ≤ 2 条（主通道 1 + 仅链断裂时兜底 1）」，并在 §8 验证清单加对应回归与断言。

**B2. 解决 guard 与 restricted/full 档位冲突**

建议修订文本（替换 §5.3.1）：guard 谓词读取策略存储：

```
// 伪代码（M3 实现）
ctx.tools.guard(exec => {
  if (!isSubagent(exec.agent)) return undefined
  const policy = policyFor(exec.agent.session.id)   // 默认 readonly
  if (policy === 'full') return undefined
  if (exec.name === 'lab_ctl') {
    if (policy === 'restricted' && LAB_CTL_WHITELIST.includes(exec.arguments?.action))
      return undefined                              // restricted 白名单动作放行
    return `subagentPolicy=${policy}：子代理禁止 lab_ctl（${policy==='restricted' ? '仅白名单动作' : '只读'}）`
  }
  return undefined
})
```
并在 `lab_ctl` 工具内部按 `exec.agent` 复核白名单（工具是插件自有，可精确到 action），防止 guard 谓词与工具执行脱节。

### ISSUE（必须处理，可附实施阶段）

1. **I1 — 矩阵缺目标代理状态维度**：§2.2 单元格改为「动作(按目标状态)」或新增解析规则；absent → 升根。同时 §2.1 输入 C 与矩阵对齐。
2. **I2 — steer 语义误用**：任何"不唤醒"注释处（§2.2 smoke/short 行、§3.4 smoke/regression）改用 `inject`（next-step 不唤醒）或 `send(next-turn,false)`；"wake" 语义用 followup（idle 冷恢复/排队）/ steer（running 立即 next-step）并在 doc 注明 **steer 对 idle agent 会启动新回合**（源码实证）。
3. **I3 — 表间一致性**：§2.2/§3.4 合并为单一"策略矩阵"（notifyLevel × 目标），查找顺序明示：场景行 → 类型默认（experimentTypes 配置）→ 全局 fallback；short/full 行补齐对齐（short: critical 按"可唤醒"策略 → followup，与 §3.4 wake 一致；full: 不因 warn 唤醒 → notice）。
4. **I4 — isSubagent 判定**：改用 `delegationDepth>0 || origin==='subagent'`（替代 parentSession），补 fork 决策（建议默认不受限）。
5. **I5 — 一次性子代理只读语义**：文档写明"一次性子代理 = global 只读 lab_status；争取 M3 影子化"，或 M3 实现 own-layer 影子 lab_status（标注 KV 代价）。
6. **I6 — clear-alerts 联动**：clear-alerts 同步重置插件通知指纹（保留 balancer 5min 防重）。
7. **I7 — 复杂度收敛**：策略层只表达 notifyLevel×目标；动作选择收为 `resolveAction(level, targetState)` 纯函数；`scale` 删除或 M4；`notifyTimeoutMs` 默认值与单位统一（建议 600000ms=10min，与 escalateAfterSec 同规模，且可注入）。

### Minor（顺手改）

1. §4.3 引用行号更新：agent/inbox/inserted = dsh-agent-loop L359（非 dsh-agent L151）。
2. §5.3 交叉引用 "§5.3"→"§5.4"（agentDir）。
3. §5.3.2 补一句话：registerContinuableSetup 改变子代理组合 → 冷恢复续跑子代理一次性前缀变化（KV）。
4. M1 落点补"三字段必填断言"（severity/urgency/sustainedMs），防多维分级空谈。
5. 决策树补 absent 行（见 I1）。

---

## 10. 评审证据（文件:行号）

- 设计文档：`docs/research/22-issue5-alert-notify-design.md`（356 行，全文）
- T1 调研：`.agent-teams/lab-monitor-issue5/team.json` t1 output（结论 1-7 + 能力清单）
- T2 调研：`docs/research/21-t2-alert-grading-and-exp-type-input.md`
- v2 方案：`docs/research/20-issue5-alert-feedback-design.md`（§3 关键能力、§4.3/4.4 通知构造与指纹）
- 宿主源码（`/home/dc/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`）：
  - dsh-agent-loop/lib/index.js L117-135（exec.agent）、L345-365（inbox inserted 发射）、L375-411（send/followup/steer/inject）
  - dsh-agent/lib/index.js L335-341（agentEvents fused 注入 agent）、L715-717（roots）、lib/types/runtime-types.d.ts L146-215（agent/created、inbox inserted/claimed 类型与语义）
  - dsh-scope/lib/index.js L327-338（scopeTarget 谓词）
  - dsh-subagent/lib/index.js L185-256（subagent/end payload）、L2481（registerContinuableSetup）；lib/types/child-agent.js L126-168（applyChildComposition + captureDelegatedPolicyOverrides）；lib/types/continuation.js L709-743（setup 时序）
  - dsh-tool-subagent-report/lib/index.js L29-96（installReportTool）；README.zh.md L5-9/L65（report 边界与无读回执）
  - dsh-tools/lib/index.js L2756-2794（register/restrict）、L2800-2820（guard/guardReason 单调）、L2843-2900（view 层级）、L3104-3116（pre-execute waterfall 载体）
  - dsh-session/lib/types/types.d.ts L54/64/70（parentSession/origin/delegationDepth）
  - dsh-llm/lib/types/message.d.ts L100-120（CONTEXT_SUMMARY_MAX_CHARS=120，notice 消息摘要上限）
- lab-monitor 源码：src/index.ts L294-330（emitLab/lab alert）、L417-418（告警归属）、L955-1060（工具 global 注册）、L1123-1141（pre-execute）、L656-746（settings schema）；src/core/types.ts L107-117（Alert）；src/core/balancer.ts L378-392（emitLab payload）；src/core/constants.ts L16-26（ALERT_MAX/MAX_PARALLEL_RUNS）；src/core/state-machine.ts L170-199（start + experiment-start）；src/client.ts L1524-1533（settings.section）

> 注：设计文档中途由 `21-issue5-alert-notify-design.md` 更名为 `22-issue5-alert-notify-design.md`（文档末注释约定 22=设计、23=评审、24=T1），故本评审按团队现行编号落盘为 `23-issue5-design-review.md`。