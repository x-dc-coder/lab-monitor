# 27 验收汇总审查：Issue #4 / #5 关闭结论（供 gh issue close 执行）

> 状态：**审查完成（2026-08-25）**。审查员（reviewer）基于 t1-t4 实际输出逐项交叉核验（含独立复跑/复核），输出 #4/#5 两份关闭结论。
> 审查方法：①读取 t1-t4 任务输出全文；②对关键证据独立复核——`verify.sh` 全量重跑、snapshot 双采样 callCount 节奏、ended 字段/阈值运行时值、源码行号与断言逐一比对、17/20/22/26 文档引用核验、issue #4/#5 原文比对。

---

## 1. 各任务审查结论（t1-t4）

### t1 — B1 callCount 节奏对照：✅ PASS（证据充分）

- 独立复核：两次 snapshot 调用（间隔 6s，ts 1787552805064→1787552811073）callCount **197→198（+1）**，utilPct 24→25 实时更新 —— 与 t1 实测（176→177，+1）完全一致。
- t1 补充验证（背靠背 3 连调每次 +1、`thresholds.pollMs=5000`、brief 折叠仅存在于 MCP 层）逻辑自洽，其中 brief 参数发现（HTTP 端点忽略 brief，非缺陷）已如实记录。
- 结论：callCount 差值落在预期 ≈1-2 范围，面板数据随轮询实时刷新，数据面无副作用。**B1 通过**。

### t2 — B3/B4 确认：✅ PASS（证据充分）

- 断言逐一比对属实：
  - `mock-test.js` L308「③ 注册成功 → 注销 ②（互斥）」、L377-378「可见性标志 false → 保持 ②」——互斥形态 A/B 双覆盖；
  - `verify-host.js` L249「[A2] betterSidebarVisible=true（无互斥）」、L738「[F] aionui-panel 互斥 → false」、L554+[D] 阈值 last-write-wins、L657-658/E2 watch/tag 共存。
- 运行时独立复核：`ui.betterSidebarVisible=True`（当前快照）——与 t2 一致；语义 = 无 aionui-panel 互斥冲突。
- **注意点（需在关闭说明中注明）**：issue #4 原文 B4 行（2026-08-22）写「本会话已默认启用 better-sidebar tab，待 GUI 复核 icon/面板」，而 README V2 B4 行记录后续用户决策「保持 conversation.view（②）现状，③ 未启用——有意保持」。二者是**同一事项的决策演进**（先试用 → 后有意保持 ②），非矛盾；验收以 README V2 用户决策为准。t2 结论正确。
- 结论：**B3/B4 通过**。

### t3 — B5 回归红线 + 运行时证据：✅ PASS（证据充分）

- 独立重跑 `bash scripts/verify.sh`：**EXIT=0，七组全绿**（typecheck/构建/目录/契约/verify-host/mock-test/verify-m1/verify-sampler；e2e 按设计跳过）——与 t3 声称一致。
- 运行时字段独立复核（按 endTs 降序，第一条即最新）：
  - ended 最新一条 = `run-20260824-001`：**type=gpu-train ✅ + agentId=session-3d7dadd0-cc79-4c98-a9a1-b7ae52fe39d1 ✅**（M2/M3 数据面透出属实）；has_type=4、has_agentId=1 与 t3 完全一致（旧记录 agentId=null 属演进前数据，正常）。
  - `thresholds.procTopN`：settings.yaml L101=400 ✅ 且运行时快照=400 ✅（配置与运行时一致，生效确认）。
  - settings.yaml 持久化：`subagentPolicy=readonly`（L963）✅、`experimentTypes=[]`（L960，键存在）✅、`promptInjection` 键不存在 → 默认 false ✅。
- 结论：**B5 通过**。

### t4 — prompt 注入替代性分析：✅ 成立（证据链完整，两处措辞精度提示）

- 源码引用逐项比对属实：`promptInjection` 默认 false（index.ts:303、1791-1794）✅；`notifyAlerts`（L545-690：effectiveLevel→档位→resolveAction→followup/steer/inject/send + 节流 60s + 指纹去重 + 预算 ≤2）✅；路由决策树（L601-647）✅；链断裂兜底（L697-754：未领取超时升根 + 异常结算升根）✅；工具注册 L1530-1705 区域 + `lab_status_ro`（L1743）✅。
- 文档证据链（17→20→22→25→src）核验属实：17 确认「90%→50% 用户实测 + 方案 A 无前缀影响」；20 确认「注入只在模型步被消费、空闲无意义（经源码验证）」+「方案 F 事件驱动推送取代注入族成为主通道」+「F 是唯一覆盖『Agent 空闲时异常』语义的通道」。
- 能力对照矩阵（§3）逻辑成立：主动感知=通知引擎（更强：事件驱动/空闲可达/可唤醒）、按需查询=工具、无 KV 代价=工具与通知均进 message 尾部不进前缀、注入反而是唯一恶化源。**「被替代、不再需要」判定成立**。
- **两处措辞精度提示（不影响结论）**：
  1. §3 第 5 行「正常态 **100%** 基线」建议改为「回到静态基线 ~90%」——17 文档的基线是「静态 system prompt 90%+ 命中」，替代路径只是「无前缀影响」，不应表述为 100%。
  2. §4 证据 4 中「注入反而是唯一恶化源」需限定为「在本插件功能集内」（排除外部因素如对话长度/多模态输入等）。
- 结论：**t4 成立，#5 关闭依据充分**。

---

## 2. 关闭结论 a)：Issue #4「B: 多环境适配」—— ✅ 可关闭

| 验收项 | 结论 | 依据 |
|---|---|---|
| B1 会话端到端（callCount 与 5s 节奏对照） | ✅ **通过** | t1 实测 + 审查独立复核（双采样 +1、数据实时刷新） |
| B2 真实无 GPU 机实证 | ⏸ **留目标环境** | 本机有 GPU 无法实证；降级路径已由 verify-host 自测覆盖（README V2 记录一致）；**不阻塞 #4 关闭**，作为目标环境（WSL-Ubuntu 无 GPU 机）遗留项备注 |
| B3 互斥形态真实设置模拟 | ✅ **通过** | mock-test [10] + verify-host [F] 逻辑覆盖；live 模拟需 better-sidebar 环境，README V2 已如实记录覆盖方式 |
| B4 better-sidebar 真实注册 | ✅ **通过** | 运行时 `betterSidebarVisible=true`（无互斥）；README V2 记录用户决策保持 conversation.view（②）、③ 未启用——验收以此为准（注：issue 原文「默认启用」为 2026-08-22 试用态，后续决策演进为保持 ②，非矛盾） |
| B5 回归红线 | ✅ **通过** | verify.sh 七组全绿（审查独立重跑 EXIT=0）+ 运行时链路证据（ended type/agentId、procTopN=400 生效） |

**#4 关闭结论**：B1/B3/B4/B5 本机验收通过；B2 因环境限制（本机有 GPU）留目标环境，降级路径已有 verify-host 自测覆盖，不阻塞关闭。**建议 gh issue close #4**，关闭说明附 B2 备注。

## 3. 关闭结论 b)：Issue #5「C: 向 Agent 反馈异常占用」—— ✅ 可关闭

**判定：prompt 注入已被完整替代、不再需要，建议 gh issue close #5。** 设计取舍说明：

1. **原始形态**：`sp.variable('labstatus') + order 150` 每模型步注入（index.ts:1791-1794）—— 想让 Agent 主动感知 GPU/实验状态。
2. **取舍动因（结构性缺陷实证）**：
   - KV 前缀断裂：动态注入每步重渲染 → 命中率 90%→50%（用户实测，17 §2.2）；
   - 消费时机绑定模型步：Agent 空闲时注入从未被渲染/消费，而异常多数发生在空闲期（20 §2 源码验证属实）。
3. **替代路径（已落地闭环）**：
   - 主动感知 = M1 通知引擎（notifyAlerts：事件驱动、空闲可达 followup/send、可唤醒 steer、节流/指纹/预算护栏）——**更强**；
   - 按需查询 = lab_status/lab_advice/lab_ctl/lab_status_ro 工具（结果进 message 尾部）；
   - 精细决策 = M2 类型矩阵（EXP_TYPE_DEFAULT_NOTIFY 8 类出厂默认 + 三层识别）；
   - 精细路由/权限 = M3（路由决策树 + guard 拒 lab_ctl + 链断裂兜底升根）。
   - 全程零前缀影响（工具/通知均尾部消息）。
4. **保留项**：`promptInjection` 开关默认 false 保留为 legacy 逃生通道（零生效路径），不阻塞关闭；如需彻底移除可后续标记 legacy。
5. **已接受边界**：事件（发生了什么）vs 状态（现在仍异常）语义差异，由「事件 → lab_status 查询」闭环覆盖（20 §4.5 明确 E 可不做）。

**建议 #5 关闭措辞**：①17 调研（注入与 KV 缓存结构性冲突 90%→50%）；②20 方案 F 取代注入族（注入只在模型活跃步被消费、空闲无意义）；③M1/M2/M3 落地闭环（notifyAlerts + EXP_TYPE_DEFAULT_NOTIFY + 路由决策树 + guard/lab_status_ro）。「prompt 注入」由计划功能降级为 legacy 逃生通道。

---

## 4. 供 captain 执行的关闭动作

```bash
gh issue close 4 --comment "本机验收完成：B1/B3/B4/B5 通过（verify.sh 七组全绿 + callCount 节奏实测 + 运行时证据）；B2（真实无 GPU 机实证）因本机有 GPU 留目标环境，降级路径已由 verify-host 自测覆盖，不阻塞关闭。详见 docs/research/27-acceptance-review-issue4-5.md"
gh issue close 5 --comment "prompt 注入已被现有功能完整替代（M1 通知引擎主动感知 + 工具按需查询 + M2/M3 精细路由，全部零 KV 前缀代价）；注入 90%→50% 命中率实测与空闲期无消费两个结构性缺陷经源码验证。promptInjection 保留为 legacy 逃生通道（默认 false）。详见 docs/research/26-prompt-injection-replacement-analysis.md + 27 审查"
```
