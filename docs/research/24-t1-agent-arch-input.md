# 24 T1 调研报告：DSH agent 层级/子代理/权限/消息通道机制（设计输入）

> 状态：**调研报告**（2026-08-23，Issue #5 综合设计 T1 输入，落盘自团队任务 t1 输出）。
> 范围：DSH agent 体系机制事实——`agent/created` 等事件的可见性、子代理工具集的构成与 toolFilter、`agent.ctx` 作用域注册与插件能力注入路径（installReportTool 范本）、`roots()`/主代理定位、report/settle/send_message/interrupt 消息通道边界、可继续子代理的 FIFO 派发与唤醒语义、委派策略（approval 'never' + sandbox 覆盖快照）及其对 lab_ctl 只读控制的意义。
> 方法：宿主源码/文档逐项核对（dsh 0.1.1-rc.1 安装包 `@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下 12 个包的 README.zh.md + lib 实现，路径见 §9 证据清单）+ lab-monitor 源码现状复核（`src/index.ts`）。**纯调研，未修改任何文件。**
> 供：designer（综合方案 `22-issue5-alert-notify-design.md` 修订）、reviewer（评审 `23-issue5-design-review.md` 交叉引用）、researcher-exp-policy（T2 `21-t2-alert-grading-and-exp-type-input.md` 交叉引用）。
> 关联文档：`20-issue5-alert-feedback-design.md`（Issue #5 方案 F 接入点 `emitLab('lab/alert')`）、`21-t2-alert-grading-and-exp-type-input.md`、`22-issue5-alert-notify-design.md`、`23-issue5-design-review.md`。

---

## 0. 核心结论（≤1000 字）

1. **agent/created 对所有 agent 全局可见**。dsh-agent 用 `scopeTarget(agent, agent)` 载体分发 agent/* 事件（dsh-agent/lib/index.js L323-325、L564-682）；dsh-scope 的 scopeTarget 谓词对**无标签监听器直接放行**（`scopeOf(ctx)===undefined → true`，dsh-scope/lib/index.js L327-338），带标签监听器仅在"标签 === 分发键或其 scope 祖先"时放行（事件沿父链**向上**流动，永不向下）。lab-monitor 在 host 无标签 ctx 上 `ctx.on('agent/created')` 能收到主代理与全部子代理（含一次性/可继续/冷恢复）的事件，payload `{agent}` 含完整 Agent（.ctx/.session/.inbox/.status）。注意：子代理 scope 的父是 preset 常驻键而非父代理 agent 键（applyChildComposition→composeFrom），因此"agent 键之间无父子链"——只有 preset 级监听器与无标签监听器能看到子孙事件；在子代理作用域内注册的监听器收不到其孙级事件。

2. **子代理工具集 = global 层 + preset 常驻层 + 自身层 + 自身 restrictions**（解析沿 `agent → preset → global`，近者遮蔽远者）。`applyChildComposition(childCtx, parent, composition)`（dsh-subagent/lib/types/child-agent.js L126-135）依次：`agentPresets?.composeFrom(childCtx, parent.ctx)`（加入父 preset 组合）→ `childCtx.systemPrompt.context('subagent:delegation')` → persona 段 → `childCtx.tools.restrict(toolFilter)`。**host 全局注册的 lab_status/lab_advice/lab_ctl 在 global 层，子代理默认全部可见可调**（dsh-subagent README L44：无 roster 部署子代理经全局层解析到宿主工具；view() 恒先取 global 层，dsh-tools/lib/index.js L2843-2869）。toolFilter 即 `ToolRestriction{allow?,deny?}`（dsh-tools/types/index.d.ts L474-479），restrict() 要求 scoped ctx（否则 throw），编译进 own layer restrictions 过滤**继承面**；own layer 注册（report、结构化输出机制）**豁免** filters（dsh-tools/lib/index.js L2756-2794、L2822-2868）。委派侧：`SubagentStartRequest.toolFilter`（types.d.ts L125-139）+ provider capability `toolFilter`，descriptor 持久化（冷恢复重建，descriptor.d.ts L75）。插件侧无法改写委派请求的 toolFilter，但可：registerContinuableSetup 装 scoped 工具/guard、agent/created 钩子、host 全局 guard 按 exec.agent 判定。

3. **agent.ctx 作用域注册 = "按 agent 注入能力"的官方机制**。cordis 追踪（symbols.tracker property:'ctx'，cordis/lib/index.js L84-162：createTraceable 的 get 对 tracker.property 返回**调用方 ctx**）使 `agent.ctx.get('tools').register()` 内部 `this.ctx` 解析为 agent 的 scoped ctx，`ScopedLayers.effect` 按 `scopeOf(this.ctx)` 落该 agent 的 own layer（dsh-tools/lib/index.js L2762-2771 + dsh-scope/lib/index.js L189-218），随 agent dispose 撤销。这在 agent/created 里做没问题（事件在 scope setup 之后、发布之后触发，agent.ctx 已就绪），但会改变该 agent 首请求前缀（KV cache 影响）；官方更优路径是发布前注入。**installReportTool(childCtx, ctx, delivery)**（dsh-tool-subagent-report/lib/index.js L29-96）正是该模式的范本：`childCtx.tools.register(defineTool({name:'report',...}))` + `childCtx.systemPrompt.section('tool:report')`，由 `apply()` 经 `ctx.subagents.registerContinuableSetup((childCtx)=>installReportTool(childCtx,ctx,delivery))` 注册；管理器在**每个可继续子代理未发布的 setup 中执行**（fresh 与 cold resume 都跑：continuation.js L716-725 先 applyChildComposition 再 setupRegistry.apply(childCtx)）。**lab-monitor 可完全仿照给子代理装"只读 lab_status_ro"或 scoped guard**。

4. **主代理 = `ctx.agents.roots()`**（dsh-agent/lib/index.js L715-717：owner===undefined 的 live agent；owner 由 `agents.enter(agent, ownerCtx.agent)` 记录，agent-loop/lib/index.js L1183；config 创建走 host ctx → root）。roots() 是运行时视图非持久化；config `agents[].id` 只是 label，实际 session id 为 `${label}-session-<uuid>` 或显式 sessionId/resumeSessionId（dsh-agent-loop README L19、L41-52）。子代理判定（运行时）：`agent.session.header.parentSession` 存在 / `header.origin==='subagent'` / `header.delegationDepth>0`（dsh-session/types/types.d.ts L54/64/70）。插件拿主代理：`ctx.agents.get(sessionId)` 或 agent/created 里按 header/delegationDepth 过滤。

5. **report 只能到直接父级**（README：`reportFrom(child,...)` 投递到"确切在线直接父级"；孙级→子级，不直达顶层协调器，需直接父级显式转发）。成熟通道：① report（子→父，next-step 唤醒或 quiet 注入，reportFrom L2470）；② **settle notice**（管理器无条件投递："对于每个已经向调用方返回过 id 的子级，管理器都会无条件投递结算通知"，源 `{kind:'subagent-settled',form:'notice',summary,senderSessionId}`）；③ send_message（父→子 followup FIFO，源 `{kind:'coordinator',form:'relay'}`）；④ interrupt_agent（祖先→后代）。**插件可观察**：`subagent/start|end` 生命周期事件载体键为父级（dsh-subagent/lib/index.js L2394），无标签监听器全部收得到（payload: runId/provider/id/local/stopReason/lastAssistantMessage，L191-256）；report/settle 是写入父级 inbox 的消息（`agent/inbox/inserted {message}` 通知，dsh-agent/lib/index.js L151）；因此插件可监听 agent/inbox/inserted 按 source.kind==='subagent-report'|'subagent-settled' 筛出，再自建逻辑向 roots() 转发（"生命周期事件只供观察"，无决策接口——自动升级是插件自建行为）。

6. **可继续子代理 followup = FIFO next-turn，绝不 steering 当前轮**：`subagents.followup(parent, childId, content)` 走 `Agent.followup()`（send(msg,'next-turn',true)，agent-loop/lib/index.js L390-404）；驻留状态路由：running 入队、waiting 唤醒同一 Activation、无 Activation 冷恢复（dsh-subagent README L76-78）。对告警通知：子代理跑长任务时，告警排队到当前轮次结束后才处理；无法中途打断当前步骤。紧急打断只有 `interrupt()`（keepInbox 只停当前轮），授权要求人类持久 parent 地址或**确切在线祖先 Agent**（dsh-subagent README L21、L100；插件持祖先 Agent 引用可代传，但这是产品决策）。

7. **委派策略：approval 固定 'never' + sandbox 显式覆盖快照继承**（captureDelegatedPolicyOverrides，child-agent.js L146-151；append… 写入子级日志 source:'delegation'，L161-168）。对 lab_ctl：它是**全局工具、in-process 闭包执行，不经 sandbox/approval 管道**——沙箱角度对它无 gate（沙箱只 gate bash/run_code 等 shell 类）；approval 'never' 只是让子代理的任何升权请求确定性拒绝。因此**不存在"只读"天然保障**：子代理默认能调用 lab_ctl（改阈值/清告警/打标签）。真正可用的 gate：① 委派方 toolFilter deny:['lab_ctl']（委派侧决定）；② 插件侧 scoped/host **tools.guard 执行期拒绝**（guardReason 先 global 后 chainLayers(exec.agent)，dsh-tools/lib/index.js L2811-2820；guard 单调，后续监听器无法翻案）；③ tools/pre-execute waterfall 拒绝（同载体 scopeTarget(this,exec.agent)，L3104-3116）。exec.agent 由循环注入（agent-loop/lib/index.js L118-129 `agent: ctx.agents.requireInitiator()`），guard/pre-execute 里可按 `exec.agent.session.header.parentSession` 区分主/子。作用域是"可见性组合、非权限边界"（官方 non-goal：dsh-scope README L27、dsh-tools README L22）。

---

## 1. Q1：agent/created 事件的全局可见性

### 问题

lab-monitor 作为全局插件（host 组合），`ctx.on('agent/created')` 能收到所有 agent（含子代理）的事件吗？还是 scope-filtered 只收全局？dsh-scope 的 Scope-filtered dispatch 语义是什么——全局监听器 vs agent-scoped 监听器的区别？子代理的 agent/created 事件会被全局插件收到吗？

### 结论

**能收到全部**（主代理 + 一次性子代理 + 可继续子代理 + 冷恢复子代理）。机制三层：

1. **事件载体**：dsh-agent 注册表对每个 agent 构建 `carrier = scopeTarget(agent, agent)`，`agent/created`、`agent/disposed` 等一律经该载体分发（dsh-agent/lib/index.js L323-325、L564-682）。载体是"路由状态"，真实主体在事件参数 `{agent}` 中。
2. **Scope 谓词**（dsh-scope/lib/index.js L327-338）：监听器注册 ctx 无 scope 标签（`scopeOf(ctx)===undefined`）→ **直接放行**；有标签 → 仅当标签 === 分发键或为分发键的 scope 祖先时放行；`key===undefined` → 只放行无标签监听器。事件沿 scope 父链**向上**流动、永不向下。
3. **子代理 scope 父链**：`applyChildComposition` 用 `composeFrom(childCtx, parent.ctx)` 把子代理 scope 的父绑定到 **preset 常驻键**（不是父代理 agent 键）——因此 agent 键之间没有父子链。子代理的 agent/created（分发键=子代理 agent）能被：无标签全局监听器（lab-monitor）、preset 级监听器（该 preset 常驻挂载）收到；**收不到**：父代理 agent 作用域内注册的监听器（除非父代理恰好也是该分发键的 scope 祖先——不是）。

**对 lab-monitor**：host `ctx.on('agent/created'|'agent/disposed'|'agent/status')` 全量可见，payload 的 `agent` 是完整 Agent 对象（含 `.ctx` 作用域上下文、`.session`、`.inbox`、`.status`），可直接用于维护 agent 目录；`agent/created` 在注册表条目与会话都存在之后、setup 完成之后触发（dsh-agent README L53）。

### 证据引用

- dsh-agent/lib/index.js L323-325（`agentCarrier = scopeTarget(agent, agent)`）、L560-682（`register`/`enter`/`announce`：`agent/created` 经 `entry.carrier` 分发）、L715-717（`roots`）
- dsh-scope/lib/index.js L327-338（scopeTarget 谓词：无标签放行、祖先放行）、dsh-scope/README.zh.md L5/L15（父链/语义）
- dsh-subagent/lib/types/child-agent.js L126-135（applyChildComposition→composeFrom 绑定 preset 父）
- dsh-agent/README.zh.md L53（agent/created 时机）

## 2. Q2：子代理的工具可见性

### 问题

子代理（含可继续子代理）的工具集由什么决定？dsh-agent-presets 的组合逻辑（applyChildComposition：先加入父级 preset 组合，再应用 persona/toolFilter）。全局注册的工具（比如 lab-monitor 在 host ctx 注册的 lab_status）子代理能看到吗？toolFilter 怎么实现（请求里带 toolFilter 时 provider 怎么过滤）？插件侧（非委派场景）有没有办法给特定子代理注入/移除工具？

### 结论

**工具集组成**：`view(scope)` 解析顺序 = **global 层（恒有，host 插件注册处）→ scope 链上的祖先层（preset 常驻层，按名遮蔽）→ own 层（子代理自身注册）**，再用**链上所有层的 restrictions 取交集过滤继承面**（dsh-tools/lib/index.js L2843-2869、dsh-scope README L5）。子代理没加入任何 preset 时（无 roster 部署）也经 global 层解析到宿主工具（dsh-subagent README L44）。

**lab_status/lab_advice/lab_ctl（global 层）子代理默认全可见、全可调**——这是"默认放开"的基线。

**toolFilter 实现链**：
1. 委派请求 `SubagentStartRequest.toolFilter?: ToolRestriction{allow?,deny?}`（dsh-subagent/lib/types/types.d.ts L125-139），依赖 provider capability `toolFilter`；
2. 提供方在子代理创建窗口调用 `applyChildComposition(childCtx, parent, {persona, toolFilter})` → `childCtx.tools.restrict(toolFilter)`（dsh-subagent-in-process-driver/lib/index.js L160-187）；
3. `restrict()` 要求 scoped ctx（非 scoped 直接 throw），把 allow/deny 编译为 **own layer 的 restrictions**，过滤**继承面**（global+祖先层）；own layer 自己注册的工具（report、结构化输出机制）**豁免**——这正是"report 通道不可被 toolFilter 移除"的保证（dsh-tools/lib/index.js L2756-2794、L2822-2868；dsh-tool-subagent-report README L11）；
4. 可继续子代理的 persona/toolFilter 写入持久化 descriptor，冷恢复时重建（dsh-subagent/lib/types/descriptor.d.ts L75；continuation.js L709-743）；
5. 多个 restrict 叠加取交集；deny 掩码对"后来注册的未点名全局工具"仍放行、allow 掩码则排除后续新名（dsh-tools README.zh.md L22）。

**插件侧（非委派）注入/移除途径**（委派工具集不可直接改写，但可叠加）：
- `ctx.subagents.registerContinuableSetup(contribution)`：给**每个可继续子代理**的未发布作用域装 scoped 工具/guard/prompt 段（官方路径，见 Q3）；
- `ctx.on('agent/created')` 中对 `agent.ctx` 注册（覆盖**任意** agent，含一次性子代理）；
- host 全局 `ctx.tools.guard()` 按 `exec.agent` 判定（执行期拒绝，见 Q7）。

### 证据引用

- dsh-tools/lib/index.js L2515-2541（ToolLayer/admits）、L2762-2794（register/restrict）、L2843-2869（view：global 恒先、own 豁免）；dsh-tools/types/index.d.ts L474-479（ToolRestriction）；dsh-tools/README.zh.md L20-22
- dsh-subagent/lib/types/child-agent.js L126-135（applyChildComposition）；dsh-subagent-in-process-driver/lib/index.js L160-187
- dsh-subagent/lib/types/types.d.ts L125-139（SubagentStartRequest.toolFilter）；descriptor.d.ts L75
- dsh-subagent/README.zh.md L44（无 roster 部署经全局层解析）
- dsh-agent-presets/README.zh.md L33-39（composeFrom 组装子代理）

## 3. Q3：agent.ctx 的作用域工具注册

### 问题

文档说 "Agent-scoped context; its contributions are agent-local, unwind on disposal"。在 agent/created 监听器里对 agent.ctx 做 ctx.get('tools').register(...) 会怎样？这是否是"按 agent 注入能力"的官方路径？dsh-tool-subagent-report 的 installReportTool(childCtx, ctx, delivery) 是不是就是这种模式（作用域局部注册）？它如何安装到子级作用域（registerContinuableSetup？）——也就是说 lab-monitor 能不能仿照 installReportTool 给子代理装"只读 lab_status / 禁 lab_ctl"的能力？

### 结论

**会注册到该 agent 的 own layer**（只对该 agent 生效，随 agent dispose 完全撤销）。这由 cordis 的**调用方追踪**保证：`ctx.tools` 混入的是 traceable 代理，`createTraceable` 对 `tracker.property`（即 `'ctx'`）的 get 返回**调用方的 ctx**（cordis/lib/index.js L84-162），因此 `agent.ctx.get('tools').register()` 里 `this.ctx` 是 agent 的 scoped ctx，`ScopedLayers.effect` 按 `scopeOf(this.ctx)` 落到该 agent 的 own ToolLayer（dsh-tools/lib/index.js L2762-2771；dsh-scope/lib/index.js L189-218）。dsh-tools README 官方表述："所在层由调用上下文的作用域决定：普通插件上下文会全局注册；agent 的 agent.ctx 只为该 agent 注册，并在此处遮蔽同名全局工具"。

**是否官方路径**：是——`agent.ctx` 作用域注册就是"按 agent 注入能力"的机制（dsh-agent README L15：通过它注册工具／段／变量／监听器，只对该 agent 生效）。但存在两个时机问题：
- `agent/created` 在发布后触发，此时注册会**改变该 agent 首个请求的提示词/tool schema 前缀**（KV cache 从第一个受影响的请求 token 起失效，dsh-agent README L113）；
- 官方更优注入点是**发布前**：`CreateAgentOptions.setup(agentCtx)`/`ResumeAgentOptions.setup(agentCtx)`（新建/恢复未发布时组合，失败整体回滚，dsh-agent README L15、L53）。

**installReportTool 就是该模式的范畴化范本**（dsh-tool-subagent-report/lib/index.js L29-96）：
- `childCtx.tools.register(defineTool({name:'report', ...}))` + `childCtx.systemPrompt.section({name:'tool:report', ...})`——全部注册在子代理作用域，父级/同级不可见；
- 由 `apply()` 通过 `ctx.subagents.registerContinuableSetup((childCtx) => installReportTool(childCtx, ctx, reportDelivery))` 注册为**部署能力贡献**；
- 管理器在**每个可继续子代理未发布的 setup 中**执行：materialize 时 setup = `appendDelegatedPolicyOverrides → applyChildComposition → setupRegistry.apply(childCtx)`（continuation.js L716-725）——**fresh 创建与冷恢复都跑**；新授权须等到下一个 Activation，移除贡献立即撤销驻留安装（dsh-subagent README L104）。

**lab-monitor 完全可以仿照**：`ctx.subagents.registerContinuableSetup(childCtx => { childCtx.tools.register(只读 lab_status_ro); childCtx.tools.guard(拒 lab_ctl); childCtx.systemPrompt.section(告警指引) })`——组件全落在子代理 own layer，**不可被委派方 toolFilter 移除**（豁免语义），冷恢复自动重建。

### 证据引用

- cordis/lib/index.js L84-162（getTraceable/createTraceable：tracker.property 'ctx'→调用方 ctx）、L668-724（服务解析+追踪）、L880-900（ctx.mixin 绑定）
- dsh-tools/lib/index.js L2762-2771（register：layers.effect(this.ctx)）、L2578-2580（layers = ScopedLayers）；dsh-tools/README.zh.md L20
- dsh-scope/lib/index.js L189-218（ScopedLayers.effect：按 scopeOf(ctx) 落层）
- dsh-tool-subagent-report/lib/index.js L29-96（installReportTool 全实现）、README.zh.md L5/L11/L62-65
- dsh-subagent/lib/types/continuation.js L716-725（setup：applyChildComposition→setupRegistry.apply）；README.zh.md L23/L104
- dsh-agent/README.zh.md L15/L53/L113（Agent.ctx 语义/created 时机/KV 影响）

## 4. Q4：AgentRegistry 的 roots() 与子代理关系

### 问题

roots()（顶层 agent）vs 子代理（有 parentSession 的）。lab-monitor 通知"主代理"应该用 roots() 还是别的？（注意 roots() 是运行时的，不是持久化的）。顶级主代理的 session id 怎么拿（agentLoop 配置的 agents?）？

### 结论

- **`ctx.agents.roots()` = 无 owner agent 上下文创建的实时 agent**（dsh-agent/lib/index.js L715-717：`entry.owner === undefined`）。owner 在 `agents.enter(agent, ownerCtx.agent)` 时记录（agent-loop/lib/index.js L1183）：config 声明创建的 agent 走 host ctx（ownerCtx.agent === undefined）→ **root**；子代理经 `parent.ctx.agents.create()` → owner = 父代理 → 非 root。注意持久谱系不影响该运行时关系（恢复的 fork 会话仍可能是 root）。
- **通知主代理用 roots()**：一次拿全部顶层 agent；需要精确对象再 `ctx.agents.get(sessionId)`。roots() 是**运行时视图**（live registry），不持久化；冷 child（仅存存储、无 Activation）不在其中。
- **主代理身份判定（运行时）**：子代理 = `agent.session.header.parentSession` 存在 / `header.origin === 'subagent'` / `header.delegationDepth > 0`（dsh-session/types/types.d.ts L54/64/70）；主代理 = 三者皆无且出现在 roots()。
- **主代理 session id**：`agent.id === agent.session.id`（enter 强制校验，dsh-agent/lib/index.js L603），即 `agent.session.id`；config `agents[].id` 只是"稳定 label"，实际 id 默认 `${label}-session-<uuid>`，除非显式 `sessionId`/`resumeSessionId`（dsh-agent-loop README L19、L41-52）。
- 辅助：`subagent/start|end` 事件（载体键=父级）可让插件增量建"父→子"映射；`ctx.subagents.listChildren/listDescendants` 可直接枚举会话树（含持久化合并）但只服务可继续/会话支撑子级。

### 证据引用

- dsh-agent/lib/index.js L699-717（isOwnedBy/list/roots）、L601-603（enter：id===session.id 强制）
- dsh-agent-loop/lib/index.js L1183（enter(agent, ownerCtx.agent)）；README.zh.md L19/L41-52（config agents[].id 语义）
- dsh-subagent/lib/index.js L536、L1249（parentSession 写入）；README.zh.md L26-27（listChildren/listDescendants）
- dsh-session/lib/types/types.d.ts L54/64/70（SessionHeader.parentSession/origin/delegationDepth）

## 5. Q5：report 通道的边界

### 问题

dsh-tool-subagent-report 说"嵌套上报只向上到达一条直接边：孙级只向作为其直接父级的子级上报，不会直接到达顶层协调器"。这是不是意味着：如果 lab-monitor 想把告警给"执行实验的子代理"，子代理拿到后要自己向主代理转发？中间有哪些成熟通道（report / settle notice / send_message）？lab-monitor 作为插件能不能在 child settle 或 report 时监听并自动升级转发（比如收 lab/alert 的 emitLab 已有响应式事件，但 report 是 agent 侧动作）？

### 结论

- **report 边界确认**：`ctx.subagents.reportFrom(child, content, {delivery, signal})` 投递到"确切在线直接父级"（dsh-subagent README L22）；嵌套上报只走一条直接边，**孙级→子级，不直达顶层**，"该直接父级必须随后显式发出一条衍生更新"（dsh-tool-subagent-report README L65）。因此"告警给执行实验的子代理 → 子代理决定是否/如何向主代理转发"是官方语义，转发动作属于子代理自身（可用 report 或后续轮次文本）。
- **成熟通道清单**：
  - 子→父：`report` 工具（next-step 唤醒 / quiet 注入，投递策略部署级固定，dsh-tool-subagent-report README L9）；
  - 管理器→父：**settle notice**——"对于每个已经向调用方返回过 id 的子级，管理器都会无条件投递结算通知"，源 `{kind:'subagent-settled', form:'notice', summary, senderSessionId}`，与子级自撰 report 不同源（dsh-subagent README L84）；
  - 父→子：`send_message` 工具 → `ctx.subagents.followup(parent, childId, ...)`，源 `{kind:'coordinator', form:'relay', senderSessionId}`（dsh-tool-subagent-control/lib/index.js L50-66）；
  - 祖先→后代：`interrupt_agent` → `ctx.subagents.interrupt()`（只停当前轮 keepInbox，见 Q6）。
- **插件能否监听并自动升级转发**：**能观察、无官方决策接口**。
  - `subagent/start|end` 生命周期事件：载体键=父级（dsh-subagent/lib/index.js L2394 `createLifecycleEmitter(ctx, (parent) => scopeTarget(this, parent))`），无标签监听器全量收到；payload `{runId, provider, id, local, stopReason, lastAssistantMessage?}`（L191-256）→ 插件可识别"子级异常结算"（max-tokens/cancel/error 等 stopReason）；
  - report/settle 消息进入父级 inbox 时发 `agent/inbox/inserted {message}` 通知（dsh-agent/lib/index.js L151，代理载体）→ 插件可按 `message.source.kind === 'subagent-report' | 'subagent-settled'` 筛出并自建"向 roots() 转发汇总"逻辑；
  - 但官方明确"生命周期事件只供观察"（dsh-subagent README L159）——**没有决策/延续接口**，自动升级是插件自建行为，需自行处理去重/风暴/恰好一次语义。
- lab-monitor 自己的 `emitLab('lab/alert')` 是响应式事件、插件本地通知，与 report 是两条独立链路；如要走"子代理上报→插件升级"需监听 inbox 通知（见上），走"插件直接推送告警给主代理"则是 `agent.followup/inject`（Q6/Q8）。

### 证据引用

- dsh-subagent/lib/index.js L2394（生命周期载体）、L191-256（payload）、L2470-2483（reportFrom/registerContinuableSetup）；README.zh.md L22/L84-89/L94-100/L159
- dsh-tool-subagent-report/README.zh.md L9/L49/L65
- dsh-tool-subagent-control/lib/index.js L50-66（send_message→followup）；README.zh.md L7-9
- dsh-agent/lib/index.js L148-152（agent/inbox/inserted 通知）
- dsh-subagent/lib/types/continuation.d.ts L32-69（coordinator/subagent-report/subagent-settled 源类型，MessageSourceMap 合并扩展）

## 6. Q6：可继续子代理的派发与唤醒

### 问题

subagents.startContinuable / followup(parent, childId, content) 的语义（消息成为 FIFO 轮次、不 steering 当前轮次）；对"告警通知子代理"意味着什么——子代理正在跑长任务时，通知会等当前轮次结束？

### 结论

- **startContinuable(spec)**：`{provider, label, childId?, request: Omit<SubagentStartRequest,'label'|'signal'|'outputSchema'>, signal}`（continuation.d.ts L80-112）；子代理 inbox 接受初始提示词即兑现 `{childId, messageId}`，不等轮次开始/不等日志写入。
- **followup(parent, childId, content, {source, signal})** = `Agent.followup()` = `send(msg, 'next-turn', true)`——**追加 next-turn FIFO 并唤醒驱动器**（agent-loop/lib/index.js L390-404）。路由只取决于驻留状态：**running 入队（等当前轮次结束）、waiting 唤醒同一 Activation、无 Activation 冷恢复**（dsh-subagent README L76-78）。"继续执行消息绝不 steering"（README L154）。
- **对告警通知子代理**：
  - 子代理正在跑长任务（running）→ 告警消息**排队到当前轮次结束**后才处理——不能重定向进行中的工作（dsh-tool-subagent-control README L7/L74），也不能中途插入当前 step；
  - 想要"低打扰"：`agent.inject()`（next-step 不唤醒，等下一 step 边界）；想要"唤醒"：`agent.steer()`（next-step 唤醒）或 `followup()`（下一轮）；对**驻留子代理**插件只能走这三者（拿到 Agent 引用）或 `ctx.subagents.followup`（要求调用方是确切在线直接父级——**插件不是父级，走不了**；此 API 的 parent 参数是授权凭证）；
  - 紧急打断只有 `interrupt(targetSessionId, authority)`：只停当前轮（keepInbox），排队消息保留；授权要求"人类持久的直接父地址"或"确切在线祖先 Agent"（dsh-subagent README L21、L100）——插件默认无授权，除非产品决策允许持有祖先 Agent 引用代传。
- 消息唤醒的时序保证：管理器在所有权释放前投递 settle notice、父级驻留时按 report 同款唤醒准入记账，避免通知滞留时被 dispose 吞掉（README L86）。

### 证据引用

- dsh-subagent/lib/types/continuation.d.ts L80-112（ContinuableStartSpec）；README.zh.md L19-22/L76-78/L154
- dsh-agent-loop/lib/index.js L390-404（send/followup/steer/inject/cancel）
- dsh-tool-subagent-control/README.zh.md L7/L74（不 steering、排队语义）
- dsh-subagent/README.zh.md L21/L100（interrupt 授权）

## 7. Q7：委派策略细节

### 问题

子代理审批策略固定 'never' + sandbox 覆盖快照继承——对 lab-monitor 的意义：子代理能调用 lab_ctl（控制引擎：改阈值/清告警/打标签）吗（沙箱角度）？toolFilter 角度呢？有没有"只读"天然保障？

### 结论

- **委派策略机制**（dsh-subagent README L62-64）：`captureDelegatedPolicyOverrides(parent)` 捕获父会话**显式** sandbox 覆盖快照（部署默认不复制）+ 组合了审批能力时把子代理审批策略固定 `'never'`；以 `source:'delegation'` 事件写入子代理自己的日志（`sandbox/mode`、`approval/policy`），冷恢复只重放已持久化事件、不再捕获（子代理创建后的父级切换不追溯）。
- **沙箱角度对 lab_ctl 无 gate**：lab_ctl 是**全局工具、in-process 闭包执行**（`ctx.tools.register(defineTool({...}))`，execute 直接调 `rpcControl/rpcTag/...`），根本不经过 bash/run_code 的 sandbox/approval 管道；approval 'never' 只保证子代理任何**升权请求**（如 `sandbox_permissions` 参数）确定性拒绝且不弹未处理的提示。→ **子代理默认就能调用 lab_ctl**（改阈值/清告警/打标签/watch）。
- **toolFilter 角度**：唯一"委派侧"控制是请求 `toolFilter`（deny:['lab_ctl'] 或 allow 白名单）——由**委派方**决定，插件不能改写；且只影响可见性（模型看不到 schema 就调不到），执行期解析严格按可见集（dsh-tools view）。
- **"只读"没有天然保障**：作用域是"可见性组合"而非权限边界（官方 non-goal：dsh-scope README L27"作用域用于路由受信任的同进程插件；它们不是沙箱或权限边界"；dsh-tools README L22"这是实时可见性组合，不是权限边界"）。要落实"子代理只读/禁 lab_ctl"，执行期 gate 只有：
  1. **host 全局 guard**：`ctx.tools.guard(exec => exec.agent?.session.header.parentSession ? '子代理不允许控制监控引擎' : undefined)`——guardReason 先 global 后 `chainLayers(exec.agent)`（dsh-tools/lib/index.js L2811-2820），guard 单调、后续 waterfall 监听器不能翻案；
  2. **scoped guard**：经 registerContinuableSetup 装进子代理 own layer（仅该子代理生效，且豁免 toolFilter）；
  3. **tools/pre-execute waterfall 拒绝**（`decision.kind === 'reject'`，载体 `scopeTarget(this, exec.agent)`，L3104-3116）——lab-monitor **已有** `ctx.on('tools/pre-execute')` 监听（实验识别），可在同一链路加权限判定；
  4. 只读工具方案：`registerContinuableSetup` 装 `lab_status_ro` 到 own layer（豁免 toolFilter，冷恢复重建），配合 guard 禁 `lab_ctl`。
- `exec.agent` 由循环注入（`ctx.agents.requireInitiator()`，agent-loop/lib/index.js L118-129），主/子区分可靠（`exec.agent.session.header.parentSession`）。

### 证据引用

- dsh-subagent/lib/types/child-agent.js L146-168（captureDelegatedPolicyOverrides/appendDelegatedPolicyOverrides）；README.zh.md L62-64
- dsh-tools/lib/index.js L2805-2820（guard/guardReason 全局→链）、L3104-3116（pre-execute 载体/拒绝）、L2843-2869（view 过滤）；README.zh.md L22
- dsh-agent-loop/lib/index.js L117-129（exec.agent = requireInitiator）
- dsh-scope/README.zh.md L27（非权限边界）；dsh-tools/types/index.d.ts L488（ToolGuard 签名）

---

## 8. lab-monitor 参与 agent 体系的能力清单

### 能做到（API/模式）

- **维护 agent 目录**：`ctx.on('agent/created'|'agent/disposed'|'agent/status')` + `ctx.on('subagent/start'|'subagent/end')`（host 无标签监听器全量收到）；运行时区分主/子：`ctx.agents.roots()` vs `agent.session.header.parentSession/origin/delegationDepth`。
- **主动推送告警给指定 agent**：`agent.followup(createUserMessage({content, source:{kind:'plugin',plugin:'lab-monitor',form:'notice',summary}}))`（唤醒下一轮）/ `agent.inject(...)`（next-step 不唤醒）/ `agent.steer(...)`（next-step 唤醒）；前提是能拿到 Agent 引用（`ctx.agents.get/roots` 或事件 payload）。form 语义：notice=一次性事件（summary ≤120 字）、snapshot=当前状态、relay=agent 间消息（dsh-llm/types/message.d.ts L42-104）。
- **按 agent 注入能力**：
  - 可继续子代理（官方路径）：`ctx.subagents.registerContinuableSetup(childCtx => { childCtx.tools.register(只读工具); childCtx.tools.guard(拒 lab_ctl); childCtx.systemPrompt.section(...) })`——仿 installReportTool；fresh+cold resume 生效；新授权等下个 Activation，移除立即撤销；
  - 任意 agent（含一次性子代理）：`ctx.on('agent/created', ({agent}) => agent.ctx.get('tools')... )`——own layer 注册/guard，随 agent dispose 撤销；注意 KV 前缀影响，优先发布前注入；
  - 执行期兜底：host 全局 `ctx.tools.guard(exec => exec.agent?.session.header.parentSession ? '子代理不允许控制监控引擎' : undefined)`——覆盖所有子代理（含 one-shot/冷恢复），主代理不受限。
- **观察触发升级**：`agent/inbox/inserted` 按 source.kind 筛 report/settle；`subagent/end` 按 stopReason 识别异常结算 → 自动向 roots() 转发汇总（自建逻辑，无官方决策接口）。
- **服务探测**沿用现有 `ctx.get('agents')`/`ctx.get('subagents')` 运行时探测（均可选服务，与 `ctx.get('systemPrompt')`/`ctx.get('settings')` 同模式）。
- **复用现有监听**：`tools/pre-execute`/`tools/result` 载体已按 exec.agent 区分主/子，实验识别链路可直接扩展 attribution 与权限判定。

### 限制

- 无法改写委派请求的 toolFilter（委派方决定）；插件只能 guard/own-layer 兜底。
- `interrupt()` 需要祖先 Agent/人类地址授权；插件默认无授权，需产品决策。
- roots() 非持久化；冷 child（仅存储）无 agent 事件；驻留仅限单进程（跨进程不协调）；事件/inbox 通知不保证恰好一次投递。
- agent 事件/inbox 通知均"只供观察"（观察者不能干涉运行，也拿不到 dispose 能力）。
- 作用域非安全边界——执行期强制只能靠 guard/pre-execute 的"拒绝"，不能加宽权限。
- `ctx.subagents.followup(parent, ...)` 的 parent 是授权凭证——插件不是父级，对该 API 无授权；对驻留子代理只能走 `agent.followup/inject/steer`（需 Agent 引用）。

---

## 9. 证据清单（包路径 + 段落）

- dsh-scope/lib/index.js L327-338（scopeTarget 谓词）；dsh-scope/README.zh.md L5/L15/L27（父链/语义/非权限边界）
- dsh-agent/lib/index.js L323-325（agentCarrier）、L560-682（register/enter/announce：agent/created 走 entry.carrier）、L699-717（isOwnedBy/list/roots）、L601-603（id===session.id）；dsh-agent/README.zh.md L15/L20/L53/L69-77/L113（Agent.ctx/owner/created 时机/Agent 接口/KV 影响）
- dsh-subagent/lib/types/child-agent.js L100-135（delegation 声明+applyChildComposition）、L146-168（委派策略捕获与落日志）
- dsh-subagent-in-process-driver/lib/index.js L160-187（one-shot：captureDelegatedPolicyOverrides→applyChildComposition→parent.ctx.agents.create）
- dsh-subagent/lib/types/continuation.js L709-743（可继续 setup：appendDelegatedPolicyOverrides→applyChildComposition→setupRegistry.apply；cold resume 亦走）
- dsh-subagent/lib/index.js L2394（生命周期载体 scopeTarget(this,parent)）、L191-256（subagent/start|end payload）、L536/L1249（parentSession 写入）、L2470-2483（reportFrom/registerContinuableSetup）；README.zh.md L21/L31/L44/L62-64/L76-78/L84-89/L94-100/L104/L154/L159
- dsh-tool-subagent-report/lib/index.js L29-96（installReportTool 全实现）；README.zh.md L5/L9/L11/L49/L62-65
- dsh-tool-subagent-control/lib/index.js L20-66（send_message→followup，source coordinator/relay）；README.zh.md L5-10
- dsh-tools/lib/index.js L2515-2541（ToolLayer/admits）、L2762-2794（register/restrict）、L2805-2820（guard/guardReason 全局→链）、L2843-2869（view：global 恒先、own 豁免）、L3104-3116（pre-execute 载体/拒绝）；dsh-tools/types/index.d.ts L474-479（ToolRestriction）、L488（ToolGuard）；README.zh.md L20-25
- dsh-agent-presets/README.zh.md L33-39（composeFrom 组装子代理）
- dsh-agent-loop/lib/index.js L117-129（exec.agent=requireInitiator）、L380-411（send/followup/steer/inject/cancel）、L1183（enter(agent,ownerCtx.agent)）、L1260（setup(prepared.agent.ctx)）；README.zh.md L19/L41-52/L52/L58
- dsh-llm/lib/index.js L176-181（createUserMessage）；lib/types/message.d.ts L42-104（ContextForm/MessageSourceMap：plugin+notice/relay/recall/snapshot，summary ≤120）
- dsh-subagent/lib/types/continuation.d.ts L32-69（coordinator/subagent-report/subagent-settled 源类型：MessageSourceMap 合并扩展）、L80-112（ContinuableStartSpec）
- dsh-session/lib/types/types.d.ts L54/64/70（SessionHeader.parentSession/origin/delegationDepth）
- cordis/lib/index.js L84-162（getTraceable/createTraceable：tracker.property 'ctx'→调用方 ctx）、L668-724（服务解析+追踪）、L880-900（ctx.mixin 绑定）