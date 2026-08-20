# 17 prompt 传递与 KV 缓存架构调研（2026-08-20）

> 状态：**调研完成**（2026-08-20）。输入：dsh-system-prompt README（KV Cache effect 节）、dsh-agent-loop 源码、v2 迁移证据链（docs/research/12 §6，用户实测 90%→50%）。
> 结论：**当前架构（promptInjection 默认关 + lab_status 工具按需查询）已是 KV 缓存最优解**；若需开启注入，必须遵循「静态前缀 + 动态尾部」与「变化限频」两条约束。本插件不做任何改动。

## 1. 背景与目标

用户关注「prompt 的传递如何不影响 KV 缓存」——即：Lab Monitor 的状态信息若要进入模型 prompt（让 Agent 主动感知 GPU/实验状态），不能破坏 LLM 提供商的 KV 前缀缓存命中率。

## 2. 机制事实（源码级）

### 2.1 systemPrompt 服务的组装时机

`dsh-system-prompt`（ctx key `systemPrompt`）是**按步组装**的：

> "The loop assembles once per step and renders the result as the complete model prompt."
> "`ctx.systemPrompt.variable(name, provider)` — Providers are evaluated for **each eligible assembly**."

即：**每模型步（每个 LLM 请求）都会重新执行 variable provider、重新渲染全部 prompt 文本**。labstatus 的 `() => promptLine(buildSnapshot())` 每次求值都产生**不同的字符串**（GPU 利用率、实验状态每秒变化）。

### 2.2 KV 前缀缓存的失效规则（官方 README "KV Cache effect" 节原文）

> "Prefix-stable while identity, persona, variables, section text, and order render identically. **Any change may invalidate reuse from the first changed system-prompt token.**"

推论（v2 迁移文档 §6 已实证，用户实测命中率 90% → 50%）：

```
system prompt 渲染结果（每步都不同，变化点在 labstatus 位置）
        │
        ▼
KV 前缀缓存从「第一个变化的 token」（labstatus 处）开始全部失效
        │
        ▼
labstatus 之后的全部内容（后续 sections + 全部对话历史 + 工具定义）每步重算
```

这是「动态注入」与「前缀缓存」的**结构性冲突**：
- 静态 system prompt → 多轮共享前缀 → 90%+ 命中
- 每步动态注入 → 前缀在变化点断裂 → 其后全部失效 → 50%

## 3. 四种传递方案对比

| 方案 | 机制 | KV 影响 | 模型感知时效 | 状态 |
|---|---|---|---|---|
| **A. 工具按需查询（当前）** | `lab_status` 工具；工具结果进 message 尾部，**不进 system prompt 前缀** | 无影响（推荐） | 模型主动调用时才感知 | ✅ 默认 |
| B. prompt 注入（当前可选） | `systemPrompt.variable('labstatus')` 每步渲染 | **每步失效**（labstatus 在 order 150，其前仅身份/persona/工具引导稳定） | 每步自动感知 | ⚠️ 默认关 |
| C. 注入 + 尾部放置 | 同 B，但 section order 提到最大（如 990） | 前缀（身份/persona/工具引导/历史开头）稳定；仅尾部失效 | 每步自动感知 | 未实现 |
| D. 注入 + 变化限频 | 同 B/C，但 provider 仅在实验状态翻转（开始/结束/崩溃）时改变文本 | 大多数步文本恒定 → 前缀稳定；状态翻转那几步短暂失效 | 状态级感知（非秒级） | 未实现 |

## 4. 建议与理由

1. **保持默认方案 A 不动**（本插件当前行为，已是最优）：工具结果不进前缀，Agent 需要时调 `lab_status`（brief 一行摘要也够）。这也是 v2 迁移的既有决策（docs/research/12 §6）。
2. 若用户坚持「让 Agent 每步自动感知」，优先 **方案 C**：把注入 section 的 `order` 从 150 提到 990（动态内容放 prompt 末尾，变化只牺牲尾部缓存，前缀全保留）。
3. 更进一步可做 **方案 D**：provider 内做变化限频（`lastRunId` 未变则返回缓存字符串），把失效频率从「每秒」降到「每实验状态翻转一次」。
4. **禁止**把动态值注入 order < 900 的位置（工具引导 100-199 区间内尤其有害——工具定义在其后，全部失效）。

## 5. 与本插件的关联代码

- `src/index.ts` promptLine() + apply() 的 `sp.variable('labstatus', ...)` 段（order 150，promptInjection 默认 false）
- `lab_status` 工具（render 时用 promptLine 生成 brief 行；工具结果不进前缀）

## 6. 验证方法（若未来改方案 C/D）

- 开启 promptInjection 后观察 DSH 日志的缓存命中率（用户曾实测 90%→50% 指标）
- 对比 C/D 方案下命中率是否回到 ~90%

## 7. 结论

**不修改代码。** 当前方案 A 已满足「prompt 传递不影响 KV 缓存」；调研结论与两条约 束（静态前缀、动态尾部、变化限频）记录于此，供后续如需开启注入时参照。
