# 26 prompt 注入替代性分析（Issue #5 关闭依据）

> 状态：**调研完成（2026-08-25）**。目的：判定「prompt 注入（labstatus 动态注入）」是否已被现有功能完整替代，为 Issue #5 关闭提供依据。
> 输入：`17-kv-cache-prompt-architecture.md`（KV 结构与动态注入 90%→50% 实测）+ `20-issue5-alert-feedback-design.md`（注入族缺陷实证 + 方案 F 转折）+ `22-issue5-alert-notify-design.md` §2/§6（通知引擎/配置面设计）+ `docs/architecture/alert-notify.md`（M1 落地 + M2/M3 蓝图）+ `src/index.ts` 当前实现（工具注册、notifyAlerts、M2 类型矩阵、M3 路由/权限）+ `src/core/exp-type.ts`/`constants.ts`（EXP_TYPE_DEFAULT_NOTIFY）。
> 结论先行：**prompt 注入可判定为「被替代、不再需要」**——它想提供的能力（异常占用主动感知）已被 M1 通知引擎以更强语义完整替代（事件驱动、空闲可达、可唤醒/排队、零前缀影响）；按需查询由工具承担；注入的结构性代价（KV 前缀断裂 90%→50%）在替代路径上全部不存在。

---

## 1. prompt 注入原本想提供什么能力

**原始意图**：让 Agent「**主动感知**」GPU/实验状态——把 lab-monitor 的状态摘要（`promptLine` 一行：GPU 利用率/显存/CPU/实验状态/告警计数）作为 system prompt 变量注入，模型**每模型步自动可见**，无需显式调用工具（`docs/research/17 §1`：「让 Agent 主动感知 GPU/实验状态」）。

**具体形态（方案 B）**：`sp.variable('labstatus', () => promptLine(buildSnapshot()))` + `sp.section({ name:'lab-monitor:status', order:150, text:'{{labstatus}}' })`（src/index.ts:1791-1794）。

**需求出处（Issue #5）**：向 Agent 反馈「异常占用」（GPU 利用率 / 显存 / 温度 / 内存等异常），形式未定时候选「主动注入 prompt / 异常时提示 / Agent 按需查询」（`docs/research/20 §1`）。

**两个结构性缺陷（实证）**：

| 缺陷 | 证据 |
|---|---|
| **KV 前缀缓存断裂** | `sp.variable` provider **每模型步重新执行**、渲染结果每步不同（2s 采样的 GPU%/告警数必变）；前缀从第一个变化 token（labstatus 在 order 150）断裂，其后全部内容（后续 sections + 全部对话历史 + 工具定义）每步重算 → 命中率 **90% → 50%**（docs/research/12 §6 用户实测；17 §2.2） |
| **消费时机绑定模型步（空闲时注入无意义）** | sections/variables 仅在 preStep assemble 时渲染；Agent 空闲（无 turn 无 step）→ 注入内容**从未被渲染、从未被消费**；而异常是异步事件，多数恰好发生在模型空闲时（用户午休）——注入族（B/C/D/E）全部降级为「活跃期补充」，主通道改为事件驱动主动推送（docs/research/20 §2，用户质疑经源码验证属实） |

## 2. 现有功能分别承担了什么

| 功能 | 实现（src/index.ts 行号） | 承担的角色 |
|---|---|---|
| **工具按需查询**（lab_status / lab_advice / lab_ctl / lab_status_ro） | 工具注册 L1530-1705；lab_status_ro（M3 子代理只读版）L1742-1755 | **按需查询**：Agent 深挖细节（完整快照/建议/控制）。工具结果进 **message 尾部**、不进 system prompt 前缀 → 无 KV 影响（17 §3 方案 A） |
| **M1 通知引擎**（notifyAlerts） | L481-695：effectiveLevel（升级规则）→ 档位（off/notice/wake）→ resolveAction（running/idle/absent 全格）→ followup/steer/inject/send 投递；护栏：节流 60s + 指纹去重 + 投递预算 ≤2 + clear-alerts 重置 | **主动投递**：lab/alert 事件 → 主动推送告警消息给 Agent（唤醒/排队），模型感知「发生了什么」。通知消息 = 历史尾部普通 user 消息（form:'notice'）、低频 → **无前缀影响**（20 §0/§4.5 F 通道） |
| **M2 类型矩阵** | exp-type.ts（三层识别：配置>自动>学习>unknown 不猜）+ constants.ts EXP_TYPE_DEFAULT_NOTIFY（8 类出厂默认）+ 配置覆盖（experimentTypes） | **精细通知决策**：同级别告警按实验类型差异化档位（gpu-train warn→wake 高危前兆；smoke critical→notice 快速失败；full warn→notice 长跑勿扰） |
| **M3 路由/权限/消息链** | 路由决策树 L601-647（runId→agentId→发起者优先/子代理→根祖先知情/absent→升根）；guard + registerContinuableSetup L1707-1765；链断裂兜底（未领取超时升根 L697-727、异常结算升根 L728-748） | **精细路由与权限边界**：告警只通知相关 agent；子代理默认只读（guard 拒 lab_ctl）；消息链只在「链断裂证据」时兜底升根 |

## 3. 逐能力对照：现有功能是否完整替代 prompt 注入

| prompt 注入声称/想提供的能力 | 注入的实际表现 | 替代者 | 覆盖度 |
|---|---|---|---|
| 主动感知异常占用（Issue #5 需求核心） | 告警产生后的**下一模型步**才可见；Agent 空闲时**永不可见** | M1 通知引擎：lab/alert → notifyAlerts → 事件驱动推送（notice 排队不唤醒 / wake 唤醒 / running 时 steer 下步即见） | ✅ **完整替代且更强**：空闲时注入无意义，通知引擎是唯一覆盖「Agent 空闲时异常」语义的通道（20 §5） |
| 每步自动可见状态摘要（持续背景感知） | 每步可见，但代价 = KV 前缀断裂 90%→50% | 通知引擎（事件级）+ 工具查询（事件→按需查状态闭环）；设计明确「若只做 F，异常告知已闭环，E（context 快照持续背景）可不做」（20 §4.5） | ✅ 完整替代（事件 + 状态查询链闭环；不做每步无差别注入） |
| 细节深挖（多严重/怎么办） | 注入只有一行摘要，不含细节 | lab_status / lab_advice 工具按需查询 | ✅ 注入本就不提供细节，工具是唯一来源 |
| KV 缓存友好 | 注入 = **恶化**（90%→50%） | 工具尾部消息 / 通知尾部消息均不进 system prompt 前缀 → 正常态 100% 基线（20 §5） | ✅ 取代（决定性优势） |
| 无主动副作用（不唤醒） | 注入天然不唤醒 | notice 档 = inject（running）/ send(next-turn,false)（idle 排队不唤醒） | ✅ 完全覆盖 |
| 需要唤醒处置（critical） | 注入无法唤醒 | wake 档 = steer（running）/ followup（idle 唤醒新回合） | ✅ 更强（注入无此能力） |

**剩余差异（已接受的边界）**：
1. **事件 vs 状态的语义差异**：通知回答「发生了什么」（事件），注入回答「现在仍然异常」（状态）。现状用「事件 → Agent 调 lab_status 取当前状态」闭环，设计已确认 E（context 快照持续状态）可不做（20 §4.5「若只做 F，异常告知已闭环」）。
2. **promptInjection 开关保留**：config 键默认 false，显式开启才注入（index.ts:1791-1794）；开启即接受缓存代价（17 §4 禁止动态值入 order<900）。属「legacy 逃生通道」，非在用功能——不影响「默认路径不再需要注入」的判定。

## 4. 结论：prompt 注入可判定为「被替代、不再需要」（#5 关闭依据）

**判定：是。** 证据链：

1. **17（2026-08-20 调研）**：「当前架构（promptInjection 默认关 + lab_status 工具按需查询）已是 KV 缓存最优解」——注入 90%→50% 实测代价不可接受。
2. **20（2026-08-23 设计）**：注入族缺陷实证（消费时机绑定模型步、空闲无意义）→ **方案 F 事件驱动推送取代注入成为主通道**；「若只做 F，异常告知已闭环」。
3. **22 设计 + src 实现**：M1（通知引擎 notifyAlerts + effectiveLevel + resolveAction 全格 + 护栏）✅ 落地；M2（类型矩阵）✅ 落地；M3（路由/权限/消息链兜底）✅ 落地——Issue #5 全链路闭环（README A1.5：「issue #5 全链路闭环（剩余『prompt 注入形式』与 KV 缓存冲突，维持工具按需查询——17-kv-cache 决策）」）。
4. **逐能力对照（§3）**：注入想提供的能力（主动感知异常占用）被通知引擎**以更强语义完整替代**（事件驱动、空闲可达、可唤醒/排队、零前缀影响）；附加价值（持续状态背景）由「事件→按需查询」闭环覆盖；结构性代价（KV 前缀断裂）在替代路径上全部不存在。

**关闭措辞建议**：Issue #5 关闭依据 = ① 17 调研（注入与 KV 缓存结构性冲突）；② 20 方案 F 取代注入族（注入只在模型活跃步被消费、空闲无意义）；③ M1/M2/M3 落地闭环（notifyAlerts + EXP_TYPE_DEFAULT_NOTIFY + 路由决策树 + guard/lab_status_ro）。「prompt 注入」由「计划功能」降级为「legacy 逃生通道（config promptInjection 默认 false）」，不阻塞 #5 关闭；如需彻底移除可后续将注入分支标记 legacy（非必须，默认已关、零生效路径）。
