# 20 Issue #5 设计方案：向 Agent 反馈"异常占用"（事件驱动通知 / KV 缓存友好）

> 状态：**设计方案 v2**（2026-08-23，v1 为 context 快照方案，经用户质疑后重审）。
> 输入：GitHub issue #5 + docs/research/17-kv-cache-prompt-architecture.md + dsh 宿主源码（0.1.1-rc.1）源码级调研。
> 结论先行：**推荐方案 F —— `agent.send()`/`followup()`/`steer()` 事件驱动告警通知**。
> 用户质疑（2026-08-23）：**prompt 注入只在模型步组装时被消费；模型没有在回答问题（Agent 空闲）时，注入毫无意义** —— 经源码验证属实，注入族方案（B/C/D/E）全部降级为"活跃期补充"，主通道改为事件驱动主动推送。

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 目标 | 向 Agent 反馈异常占用（GPU 利用率/显存/温度/内存等） |
| 用户质疑 | prompt 注入（section/variable/context）只在每模型步 assemble 时被消费；Agent 空闲时无人读取 → 注入无意义 |
| 质疑验证 | ✅ 属实（§2 源码证据）。所有注入族方案（B/C/D/E）都只能在"模型活跃步"被消费 |
| **推荐方案** | **F：`lab/alert` 事件 → `agent.steer()/followup()/send()` 主动推送告警消息给 Agent（可唤醒）** |
| KV 影响 | **无前缀影响**：推送的消息是普通 user 消息，落在历史尾部；且低频（告警 5 分钟防重 + 合并） |
| 附加 | 可选 E（context 快照）作为"模型活跃期持续感知"补充；工具查询（方案 A）保留 |
| 默认值建议 | `alertNotify`：`off` / `notice`（仅注入不唤醒）/ `wake`（critical 唤醒，warn 仅注入），默认 **notice**（保守）；推荐 power 用户开 `wake` |

## 1. 需求回顾

- 需求：向 Agent 反馈"异常占用"（GPU 利用率 / 显存 / 温度 / 内存等异常）。
- 形式未定：主动注入 prompt / 异常时提示 / Agent 按需查询 / 其他更好方法。
- 已知：prompt 注入（order 150 动态 section）曾使 KV 缓存命中率 90% → 50%。

## 2. 用户质疑的验证：注入族方案的共同缺陷（源码证据）

**质疑**：模型在回答问题时遇到实验预警，注入才有意义；模型没在回答问题（Agent 空闲）时，提示词注入没有意义。

**验证**（dsh-agent-loop / dsh-system-prompt 源码）：

1. **sections/variables**（`sp.section` / `sp.variable`）：
   - `assemble()` 仅在 **preStep**（每模型步开始）时执行；文本渲染进当次请求的 system prompt。
   - Agent 空闲（无 turn 无 step）→ 无 assemble 调用 → 注入内容**从未被渲染、从未被消费**。
2. **contexts**（`sp.context`，v1 方案的 E）：
   - `RuntimeContextProjection.project()` 同样只在 **preStep** 消费；空闲期 provider 求值结果呆在 retained 里，**没有模型读取**。
   - 等下次用户提问时：快照是"当时的"告警，若告警已过期/清除，模型看到的已是 CLEARED 或新状态——**事件已被时间吞掉**。
3. **共同根因**：注入族 = "prompt 的被动附属品"，消费时机被模型步调度绑定；而**异常是异步事件，发生在任意时刻**（多数时候恰好在模型空闲时，如用户午休）。

**结论**：要真正"向 Agent 反馈异常"，必须**主动推送**（事件 → 消息入 inbox → 唤醒/排队），而不是被动注入。

## 3. 关键能力（源码级证据）：Agent 主动消息通道

DSH 0.1.1-rc.1 的 Agent 接口（@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts）提供四档主动通道：

```ts
interface Agent {
  /** 路由到 inbox 边界 + 可选唤醒 driver（找 turn/step 边界） */
  send(message: UserMessage, target: 'next-turn'|'next-step', wakeup: boolean): void;
  /** 排队一轮普通后续 turn 并唤醒 driver —— 空闲 agent 也会被唤醒开始新 turn */
  followup(message: UserMessage): void;
  /** 提交最近 step 边界的引导消息 —— 运行中 agent 下一步立即消费；空闲则启动 turn */
  steer(message: UserMessage): void;
  /** 排队下个 pre-step 的模型面向上下文，不唤醒 —— 运行中下一步可见；空闲挂起 */
  inject(message: UserMessage): void;
}
```

配套设施：

| 设施 | 位置 | 用途 |
|---|---|---|
| `ctx.agents`（AgentRegistry） | dsh-agent | `list()`/`roots()`/`get(id)` 拿活 agent；`agent/created`/`agent/status` 事件 |
| `createUserMessage()` | dsh-llm | 构造消息：`{content:[{type:'text',text}], source:{kind:'plugin', plugin:'lab-monitor', form:'notice', summary:'…'}}` |
| `form:'notice'` | dsh-llm | **"A one-off account of something that just happened; it supersedes nothing"** —— 一次性告警通知的标准语义 |
| `lab/alert` 事件 | 本插件 balancer | 告警产生点（`emitLab('lab/alert', …)`，已有，含 level/rule/msg/actions/evidence） |

**语义矩阵（告警 vs Agent 状态）**：

| Agent 状态 | 推荐通道 | 效果 |
|---|---|---|
| 运行中（正在回答问题） | `steer()` | 下一步骤立即看到告警（无需等新 turn，也不打断当前回答） |
| 空闲（没在回答） + 用户想被唤醒 | `followup()` | **唤醒 agent 开始新回合**，模型主动读告警并处理/汇报 |
| 空闲 + 不想被唤醒（静默排队） | `send(msg, 'next-turn', false)` | 消息在 inbox 挂着，下次用户提问时模型看到 |
| 任意 + 纯背景上下文 | `inject()`（或 E context 快照） | 下个 pre-step 携带；不唤醒 |

## 4. 方案设计（推荐方案 F：事件驱动告警通知）

### 4.1 总体架构

```
采样 → balancer.evaluate() → 命中规则（10s 持续 + 5min 防重）
       │
       ├─ emitLab('lab/alert', {level, rule, msg, actions, evidence})   ← 已有
       │        │
       │        ▼  （新增）
       │   alertNotifier（本插件新增模块）
       │      ├─ 节流/合并：同一 turn 内多规则告警合并为一条消息
       │      ├─ 策略分级：critical → 按 cfg 唤醒或注入；warn/info → 仅注入/忽略
       │      └─ 目标选择：ctx.agents.roots()（或 cfg.alertTargets 限定 id）
       │
       └─ (可选 E) sp.context() 快照 —— 模型活跃期的持续可见补充
```

### 4.2 配置项

```ts
// LabMonitorConfig 新增
/**
 * 告警通知通道:
 *  - 'off'    : 不做任何推送（纯工具查询，现状）
 *  - 'notice' : 告警发生时 push 消息但不唤醒空闲 agent（send next-turn wakeup:false / 运行中 steer）【默认】
 *  - 'wake'   : critical 告警时 followup() 唤醒 agent；warn/info 同 notice
 */
alertNotify: 'off' | 'notice' | 'wake'
/** 可选：只通知这些 agent id（默认全部 roots） */
alertTargets?: string[]
```

默认值建议 `notice`：不打断用户，但消息一定在模型下轮可见（不管这轮是"正在回答"还是"下次提问"）；power 用户可开 `wake` 获得即时处理。

### 4.3 通知消息构造

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'   // peer 依赖需新增

function buildAlertMessage(alerts: AlertView[]): UserMessage {
  const text = alerts.map((a) =>
    `[${a.level}:${a.rule}] ${a.msg}` + (a.actions.length ? '\n建议: ' + a.actions.join(' / ') : '')
  ).join('\n\n')
  return createUserMessage({
    content: [{ type: 'text', text: `⚠️ [Lab Monitor 异常告警]\n${text}` }],
    source: { kind: 'plugin', plugin: 'lab-monitor', form: 'notice', summary: `Lab Monitor: ${alerts.length} 条告警` },
  })
}
```

### 4.4 发送策略（AlertNotifier）

```ts
// 内部实现（apply 内闭包）
let notifiedFingerprint = ''   // 防重复通知同一批告警

function notifyAlerts() {
  const a = balancer.advice()
  if (!a.advice.length || cfg.alertNotify === 'off') return
  // 指纹 = level+rule+msg 的连接；相同告警集合不重复通知（配合 5min 防重）
  const fp = a.advice.map((x) => `${x.level}:${x.rule}:${x.msg}`).join('|')
  if (fp === notifiedFingerprint) return
  notifiedFingerprint = fp

  const msg = buildAlertMessage(a.advice)
  const agents = cfg.alertTargets?.length
    ? cfg.alertTargets.map((id) => agentsSvc.get(id)).filter(Boolean)
    : agentsSvc.roots()
  if (!agents.length) return

  for (const agent of agents) {
    const critical = a.advice.some((x) => x.level === 'critical')
    if (cfg.alertNotify === 'wake' && critical) {
      agent.followup(msg)          // 唤醒新回合，模型立即处理
    } else if (agent.status === 'running') {
      agent.steer(msg)             // 正在回答 → 下一步骤注入
    } else {
      agent.send(msg, 'next-turn', false)  // 空闲 → 排队不唤醒，下轮提问可见
    }
  }
}
```

**触发时机**：`emitLab('lab/alert', …)` 处（balancer.evaluate 已发出时）追加调用 `notifyAlerts()` —— 或者更简单：在现有告警评估周期（已有 timer）末尾调用一次。这样告警列表变化（新增/过期/清除）都会同步一次通知，指纹去重保证不重复轰炸。

### 4.5 与其它方案的关系（分层定位）

| 通道 | 角色 | KV 影响 |
|---|---|---|
| **F：事件通知**（推荐主通道） | 异常发生时主动推送（唤醒/排队），模型感知"发生了什么" | 无前缀影响（历史尾部普通 user 消息，低频） |
| **E：context 快照**（可选辅通道） | 模型活跃期持续可见"当前告警集合"（每步背景） | 正常态零影响（空文本）；翻转时尾部一条 |
| **A：工具查询**（保留） | Agent 深挖细节（完整快照/建议/控制） | 无影响 |

三者不冲突：
- F 回答"异常发生了"（事件，异步，主动）；
- E 回答"现在仍然异常"（状态，同步，持续）；
- A 回答"具体多严重、怎么办"（细节，按需）。

若只做 F（最小实现）：异常告知已闭环，E 可不做。

## 5. KV 缓存影响评估

| 场景 | F 事件通知 | E context 快照 | 注入族 B/C/D |
|---|---|---|---|
| 正常态 | 无消息，历史不变，100% 命中 | 空文本，0 影响 | 每步变 → 50%（B）/尾部变（C） |
| Agent 空闲时告警 | **消息入 inbox，唤醒或待下轮**（吸收在历史尾部） | **无人读取（快照等模型活跃才见）** | **无人读取（无意义）** |
| Agent 运行中告警 | steer 下一步即见 | 下一步即见 | 每步见但前缀断裂 |
| Agent 空闲时告警被清除 | 消息仍在 inbox（可选），agent 下轮可见"曾发生" | CLEARED 等模型活跃才投影 | 同 E |

**F 是唯一覆盖"Agent 空闲时异常"语义的通道**。

## 6. 实现清单

- [ ] `package.json`：peerDependencies + devDependencies 增加 `@deepseek-ai/dsh-llm`（用 `createUserMessage`）；`@deepseek-ai/dsh-agent` 类型（仅类型引用可走 `@deepseek-ai/dsh` 的依赖——**不能直接依赖 dsh 宿主**，需确认类型来源：dsh-agent runtime-types 从何 import）
- [ ] `src/index.ts`：`LabMonitorConfig` 加 `alertNotify` + `alertTargets`；默认树
- [ ] `src/index.ts`：新增 `buildAlertMessage()` + `notifyAlerts()`（§4.3/4.4）
- [ ] `src/index.ts`：告警评估周期末尾调用 `notifyAlerts()`；`ctx.agents` 可选注入（`inject` 数组加 `'agents'`？——需确认 cordis inject 语义与宿主可用性，或运行时 `ctx.get('agents')` 探测降级）
- [ ] 前端 settings 页：`alertNotify` 三档选择（client.ts 设置卡片）
- [ ] 文档：README 配置项 + docs/research/17 追加"通知通道"注记
- [ ] issue #5 回复方案摘要，落地后 close

## 7. 验证清单

1. `pnpm typecheck` + `pnpm build` 通过。
2. 挂载/重启（用户手动）后 dump-config 无报错，配置行在位。
3. **运行中注入**：开一个长任务让 agent 回答中 → `lab_ctl set-threshold` 调低阈值触发告警 → 观察模型**下一步骤**收到告警消息（会话历史出现 trata 'note' 消息）。
4. **空闲唤醒**（`alertNotify:'wake'`）：agent 空闲 → 触发 critical 告警 → 观察 agent 被唤醒开始新回合、模型读取告警并响应（可能有 LLM 调用成本——验证提示语是否清晰）。
5. **空闲排队**（`alertNotify:'notice'`）：agent 空闲 → 触发告警 → agent 不被唤醒；下次用户提问时模型看到告警消息。
6. **指纹去重**：同一告警集合持续期间，只通知一次；新告警到达/清除后再通知。
7. **KV**：全程观察命中率不回退（正常态 100% 基线）。
8. **多 agent**：roots() 全部收到（或 alertTargets 限定）。
9. **降级**：宿主无 agents 服务时（探测 `ctx.get('agents')`）→ 静默跳过通知，仅工具模式，不报错。

## 8. 风险与回退

| 风险 | 级别 | 缓解 |
|---|---|---|
| `wake` 唤醒产生 LLM 调用成本/打扰 | 中 | 默认 `notice`（不唤醒）；wake 用户显式开；critical 才唤醒 |
| 通知消息形态干扰 UI（user 消息显示） | 低 | `form:'notice'` + summary 一行折叠（DSH 已支持 notice 呈现） |
| 多 agent 广播打扰（子 agent 多） | 低 | `alertTargets` 限定；默认仅 roots |
| 依赖 `@deepseek-ai/dsh-llm` 版本漂移 | 低 | 锁 peer 版本与宿主一致（0.1.0-rc.7 已在 devDeps） |
| 指纹准则不稳（msg 含动态值） | 低 | msg 是生成时快照，稳定；指纹用 level:rule:msg |
| 回退 | — | `alertNotify:'off'` 一键回到纯工具模式 |

## 9. 备选（不推荐）

- 仅 context 快照（v1 方案 E）：无法覆盖 "Agent 空闲时异常"（用户质疑点），只作 F 的补充。
- 仅工具（现状 A）：Agent 不知道何时该查，异常感知依赖模型自觉，无法保证。
- 轮询注入（order 990 + 高频）：性能与语义都劣于事件推送。

## 10. 附：证据源

- issue #5；docs/research/17-kv-cache-prompt-architecture.md；12-v2-migration.md §6
- dsh 0.1.1-rc.1 宿主源码：
  - `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`（Agent.send/followup/steer/inject + 全部 agent 事件）
  - `@deepseek-ai/dsh-agent/lib/types/index.d.ts`（AgentRegistry.list/roots/get/create）
  - `@deepseek-ai/dsh-llm/lib/types/message.d.ts`（UserMessage/createUserMessage/MessageSource/form:'notice'）
  - `@deepseek-ai/dsh-agent-loop/lib/index.js`（preStep/assemble 消费时机 —— 注入族缺陷证据）
  - `@deepseek-ai/dsh-system-prompt/lib/index.js`（contexts/sections 每步求值）