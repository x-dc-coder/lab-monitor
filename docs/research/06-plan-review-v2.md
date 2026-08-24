# Lab Monitor 计划 v1.2 复审报告（t8）

> 评审人：reviewer（计划评审员）｜日期：2026-08-18
> 评审对象：output-t3-plan.md **v1.2 修订版**（评审基线：2026-08-18 15:23 版本，460 行；§10 修订记录**尚未产出**，见 H1）
> 评审依据：output-t8-preflight.md（预审：webServer 契约直读 + v1.1 独立性残留扫描）、output-t2b-better-sidebar.md（0.12.2 契约实证）、output-t4-review.md（v1.1 评审 22 条）、docs/t8-lab-monitor-architecture.md；`dsh-host-webserver/lib/types/index.d.ts` 直读核验
> 红线遵守：未调用任何 client 平台 inspect；只用 read/grep/bash

---

## 一、总体评价

v1.2 架构方向**正确且执行度高**：核心引擎层独立性声明（§3.1 L143）、出口注册策略与优先级（§3.2.0 四出口表）、互斥/共存规则（②默认 → ③替代 → ④共存）、conversation.view 升为默认出口（§3.2.2）、better-sidebar 降级为最后开发的可选适配器（§3.2.3）、阈值来源出口适配（§3.2.1）——均完整回应了用户"核心独立、sidebar 最后"原则，也吸收了预审 V1~V6 的大部分方向。T1-1/T1-2/T2-2/R-1 等前轮修正无回归（维度 4 抽查通过）。

但 v1.2 修订**未全部完成**：§10 修订记录缺失（文档自引用断裂）、§4 里程碑验收仍残留 better-sidebar 语义、§5 协作任务包未按"sidebar 最后"拆分、§6 风险表未新增互斥机制/出口降级条目——共 3 高/8 中/5 低问题，详见下。

---

## 二、问题清单（按评审维度）

### 维度 1：独立性达成度

| # | 问题 | 严重度 | 建议修正 |
|---|---|---|---|
| H2 | **V1 残留：§3.2.3 仍写"保留 v1.1 注册骨架（对象形态 `inject:['betterSidebar','timer']`）"**。client 半是单入口 apply（3.2.2 的 conversation.view 默认出口与 3.2.3 适配器同在一个文件/apply 内），若返回对象带 `inject:['betterSidebar']`，0.13.0 互斥禁用（better-sidebar 服务不挂载，队长已核验）时**整个 client 半进入 waiting 永不 apply——默认出口 conversation.view 也不会注册**，"核心独立"名存实亡 | **高** | 3.2.3 明确改为：**client 半返回对象只 `inject:['timer']`**（或按最终核心依赖声明）；betterSidebar 一律 `ctx.get('betterSidebar')` 判空后使用（t2b 结论①明示姿势，ctx.get 免声明、可选消费）；删除"保留 v1.1 注册骨架（inject:['betterSidebar','timer']）"文字，改为"适配器内部 ctx.get 取服务" |
| V2 部分闭合 | **阈值事实来源仍绑 pluginSettings**：3.2.1 已改"无 sidebar 时不携带 → host 用默认/上次 lab_ctl 设置"（比 v1.1 好），但阈值持久化仍绑定 sidebar prefs 文档；无任何 UI 出口时阈值无法配置且重启后回默认，与"核心独立"的完整贯彻有差距 | 中 | 阈值事实来源放 **host 侧模块级 + Host `settings` 服务持久化**（核心层可读写，t2 §2 实证存在）；pluginSettings 仅作 sidebar 出口的同步面（读后携带，写时 host 为准）——写入 02-data-model.md / 03-protocol.md |
| M3 | **阈值双写路径冲突未定义**：snapshot 请求携带的 `thresholds`（来自 pluginSettings）与 `labMonitor.setThresholds`/`lab_ctl`（直连通道）的先后覆盖顺序、优先级无定义——同一阈值两个事实来源，balancer 用哪个？ | 中 | 03-protocol.md 定义单一收敛规则：**host 侧持有生效阈值（last-write-wins），请求携带值仅作"建议更新"**；setThresholds 与请求携带同时到达时以时间戳后者为准；写明冲突仲裁 |
| L1 | §3.3 消息流表"阈值生效"行（L292）仍是 v1.1 表述"pluginSettings → 轮询请求携带"，未同步 3.2.1 的"无 sidebar 不携带"分支 | 低 | 更新为"sidebar 出口：pluginSettings 携带；无 sidebar：host 默认/上次设置（lab_ctl 直连）" |

### 维度 2：出口层设计

| # | 问题 | 严重度 | 建议修正 |
|---|---|---|---|
| M4 | **③ better-sidebar 探测时序竞态未定义**：3.2.3 说"apply 时先注册②，探测③可用 → 注销②注册③"——`ctx.get('betterSidebar')` 是即时查询，若插件 apply 早于 better-sidebar 服务发布（服务激活时序不确定），一次性探测返回 undefined 后**永不升级**到③，即使 better-sidebar 实际存在 | 中 | 定义重探机制：注册②后延迟重探（如 `ctx.setTimeout` 2s 一次、共 3 次；或监听平台服务注册事件——实现时实证），探测成功即切换③；并写明"探测失败保持②，不影响功能" |
| M5 | **3.2.4 webServer 自托管面板三处缺口**（对照预审 W1~W5 直读事实）：① webServer **不提供静态文件服务**（"serves no files"），`web/index.html + app.js` 如何被 serve 未写——Host 无 fs 内建，需 handler 自产响应（shell cat 读取或 HTML 内嵌字符串）；② 路由 `/lab` 过短易与其他插件撞名（**重复 (kind,path) 注册直接 throw**），建议 `/lab-monitor/` 前缀；③ "仅绑 127.0.0.1（遵循平台约定）"表述错误——**绑定地址由 DSH 网关配置决定，插件不可控制**（Config 只有 127.0.0.1/0.0.0.0 两值且属网关） | 中 | ① 写明 handler 实现路径（shell cat web/ 文件或内嵌字符串，P2 前实证 webServer 路由在动态插件 host 半可用）；② 路由改 `/lab-monitor` + `/lab-monitor/api/snapshot`；③ 表述改为"路由注册在 DSH 共享网关（当前 127.0.0.1:3080），手机端经 Tailscale 转发器可达" |
| L2 | 3.2.4 未写 host 半获取 `webServer` 的方式（inject 声明 or `ctx.get` 判空） | 低 | 补一句：host 半 `ctx.get('webServer')` 判空后 `register({kind,path,handler})`（动态插件 host 半服务访问按 t8 实测形态） |
| L3 | 3.2.3 标注"0.13.0 兼容（t6 契约差异合入后定稿）"——t6 尚未完成（output-t6-bs013.md 不存在），0.13.0 细节（urlTarget/settingSelect）未定稿 | 低 | 可接受（核心机制判空+门控+互斥探测已定）；交付物清单加"t6 产出后合入 3.2.3 细节"动作 |

### 维度 3：开发顺序

| # | 问题 | 严重度 | 建议修正 |
|---|---|---|---|
| H3 | **P0 验收 2 与 v1.2 默认出口矛盾**：P0 阶段 better-sidebar"最后开发"尚未实现（默认出口是 conversation.view），但 P0 验收 2 仍写"`visible=false` → 零渲染轮询，仅低频保活"——**conversation.view 无 visible 语义（3.2.1 自述"常驻 5s 节流"）**，该断言在 P0 无对象；P0 验收 1 的"Tab 显示"也未区分是哪个出口 | **高** | P0 验收按出口分轨重写：验收 1/2 以 **conversation.view 默认出口**为对象（"会话头部 tab 环显示 ≥1 GPU 卡…；数据正确性偏差 <5%"；轮询断言改"常驻 5s 节流 + callCount 增量符合 5s 节奏，tab 内容区不可见时无渲染开销（若平台支持卸载；实证后定口径）"）；visible=false 语义的断言**移到 P2 better-sidebar 出口验收** |
| M8 | **§5.1/5.2 任务包未按"sidebar 最后"更新**：D-B 仍为"UI 工程师 client Tab + 轮询 + badge/settings"单包，未拆分为"conversation.view 默认出口先行（P0）→ better-sidebar 适配器（P2）"两段；D-B 与 D-A 并行前提未更新 | 中 | D-B 拆 **D-B1**（conversation.view 默认出口 + 数据消费者，P0，与 D-A 并行，契约=snapshot schema 冻结）与 **D-B2**（better-sidebar 适配器，P2，依赖 P0/P1）；D-B2 与 D-E 合并或串行 |
| L4 | §7 时间盒未体现"better-sidebar 最后开发"（P0 工作量仍含 tab 渲染描述）；§8 交付物未列 docs/architecture/ui-adapters.md 定稿动作 | 低 | 时间盒按 D-B1/D-B2 拆分更新；交付物加"05-ui-adapters.md 定稿（出口注册策略/优先级/互斥规则/降级矩阵）" |

### 维度 4：前轮修正回归抽查（T1-1/T1-2/T2-1/T2-2/R-1）

| # | 结论 | 说明 |
|---|---|---|
| T1-1 pid 链路 | ✅ 无回归 | §3.1 state-machine/hooks 完整保留（pre-execute 无 pid → tools/execute 回传 / ps 关联 / 超时降级） |
| T1-2 result 配对 | ✅ 无回归 | 配对校验 + 双确认 + kill 不误判 done 均在 §3.1 与 P1 验收 1 |
| T2-1 阈值链路 | ⚠️ 部分保留 | 决策①保留但收敛到"sidebar 出口携带"（3.2.1），比 v1.1 更符合独立原则；**遗留 M3（双写冲突）与 V2（持久化绑定）** |
| T2-2 badge 保活 | ✅ 无回归 | 低频保活保留（3.2.1 代码块）；但 conversation.view 出口下"常驻 5s 节流"使保活通道冗余（不冲突，实现时二选一即可）；**P0 验收 2 与默认出口矛盾见 H3** |
| R-1 双实例 | ✅ 无回归 | 风险 7 保留（接受双实例无害 + P0 前实证同名工具） |

### 维度 5：风险表新增项（互斥机制、出口降级）

| # | 问题 | 严重度 | 建议修正 |
|---|---|---|---|
| M6 | **风险表未新增任何 v1.2 相关条目**：无"0.13.0 互斥/aionui-panel 禁用 better-sidebar"风险（机制在 3.2.3，但风险表缺失）；无"出口降级链"风险（②③④ 全缺席/全失败时**依赖 conversation.view 的 slots 服务本身也是可选服务，slots 缺席则②也无法注册** → 纯核心层运行，此场景未入表）；风险 1 仍写"0.12.2"未更新 0.13.0 | 中 | 风险 1 更新为 0.13.0（含互斥机制）；新增风险 13"出口全缺席/全失败"（缓解：核心层完整 + P0 验收加"无任何 UI 出口时采集/告警/工具/prompt 注入正常"断言——**此断言当前 P0~P2 均无，需补**）；风险 14"conversation.view slots 缺席"（缓解：纯核心运行，Agent 通道兜底） |

### 维度 1/4 补充（P2 验收出口无关性）

| # | 问题 | 严重度 | 建议修正 |
|---|---|---|---|
| M1 | **P2 验收 2 持久化断言仍绑定 pluginSettings**（T4-4 原样："重开页面 → pluginSettings['lab-monitor:gpu'] 仍在"）——better-sidebar 缺席时无对象，且与 V2（阈值事实来源移 host）方向矛盾 | 中 | 拆双轨：**better-sidebar 可用** → pluginSettings 持久化断言；**不可用/缺席** → host settings 持久化断言（lab_ctl 设置 → 重 define → 阈值仍在）；并写清两轨验收条件 |
| M2 | **P2 验收 1 的 badge 断言需标注出口前提**：badge 是 better-sidebar 专属能力（conversation.view 无 badge）；核心断言（alertsCriticalCount +1 日志断言）已正确放在 host 侧 ✓，但"低频保活 30s 内 badge 角标出现新计数"需标注"better-sidebar 可用时" | 中 | P2 验收 1 拆两句：核心句（host alertsCriticalCount，任何出口均成立）+ 增强句（badge 角标，标注 better-sidebar 可用时） |

### 维度 4 附（conversation.view 承载能力）

| # | 问题 | 严重度 | 建议修正 |
|---|---|---|---|
| M7 | **conversation.view 面板的组件渲染能力未实证**：P0 验收 1 要求"GPU/CPU/内存卡 + 进程表 + 色条"复杂面板，而 3.2.2 只描述"label thunk 一行摘要"；conversation.view slot 的 component 渲染区域、挂载/卸载/隐藏语义（决定节流口径）均未实证 | 中 | P0 前最小样例实证：① conversation.view 注册自定义组件（createElement 面板）可行；② 面板不可见时组件是否卸载/保活（决定"常驻 5s 节流"与验收口径）；实证结论写入 04-milestones.md |

---

## 三、结论：**有条件通过**

v1.2 架构方向正确（核心独立 + 可插拔出口 + sidebar 最后），主体质量高；但修订**未全部完成**（§10 缺失、§4/§5/§6 未同步），且存在 1 处 v1.1 硬伤残留（H2），需按以下清单修正后进入实施。

### 必须修正项清单（3 高）

1. **H2（阻断开工）**：3.2.3 移除 `inject:['betterSidebar','timer']` 硬依赖残留——client 半只声明核心依赖，betterSidebar 一律 `ctx.get()` 判空可选消费；否则互斥禁用场景下默认出口 conversation.view 也不会注册，"核心独立"崩溃；
2. **H3（阻断开工）**：P0 验收 1/2 按默认出口（conversation.view，无 visible 语义）重写断言口径，visible=false 断言移至 P2 better-sidebar 出口验收；§5.1 D-B 拆 D-B1（P0 默认出口）/ D-B2（P2 适配器）；
3. **H1（评审对象完整性）**：补 §10 v1.2 修订记录（含本报告各条闭合方式与修订位置），更新 L5/L414 自引用表述；同步 §4/§5/§6/§8 与 v1.2 一致（含 M1/M2/M6/M8 条目）。

### 建议合入的中严重度项（8 条，随修订版一并处理）

M3 阈值双写仲裁（03-protocol.md）、M4 ③探测重探机制、M5 webServer 三缺口（静态托管路径/路由前缀/绑定表述）、M6 风险表新增 13/14 条 + 风险 1 更新 0.13.0 + 补"无 UI 出口时核心完整"P0 断言、M7 conversation.view 承载能力实证、M1/M2 P2 验收双轨化、M8 §5 任务包拆分。

> 备注：评审基线为 15:23 版本（t7 仍在进行中、t6 未产出）。architect 补完 §10 与上列条目后，队长可安排 reviewer 做增量复核（预计 1 轮）；若 §10 合入内容与本报告完全一致，可视为闭合。

---

## 四、增量复核通过（v1.3，2026-08-18）

对 output-t3-plan.md **v1.3 正式版（572 行，含 §11 修订记录）** 执行增量复核，核对清单（H2/H3 闭合 + 中项抽查 + 前轮无回归）**全部通过**：

- **H2/V1 闭合**：`inject:['betterSidebar','timer']` 残留全文档清零；新增 §3.2.0「client 半依赖声明纪律」（只 `inject:['timer']`、betterSidebar 绝不进 inject、apply 顶部无条件执行核心逻辑与 ② 注册）；§3.2.3 适配器形态改 `const bs = ctx.get('betterSidebar'); if (bs) bs.registerTab(...)`（t2b 结论① 姿势）✓
- **H3 闭合**：P0 验收 2 改「conversation.view 常驻 5s 节流 + callCount 节奏断言」，visible 暂停/保活断言移至 P2 验收 5（better-sidebar 专属语义）；P0 验收 1 明确 conversation.view 为 P0 主 UI 对象（组件能力先经 M7 实证）；§5.1/5.2 任务包拆分 D-B1/D-B2（D-B2 必须最后）✓
- **H1 闭合**：§11 修订记录完整（11.1 高 3/3、11.2 中 8/8、11.3 低 5/5、11.4 结论）；§4/§5/§6/§7/§8 与 v1.3 一致（P2 验收 2 host settings 持久化、风险 1 更新 0.13.0、风险 13/14/15 齐全、时间盒与交付物按 D-B1/D-B2）✓
- **中项抽查**：M3 last-write-wins 仲裁四处表述一致（§3.1 balancer/rpc/setThresholds + §3.3 + §8，host settings 为唯一事实来源）；M4 `ctx.setTimeout` 2s×3 重探（或平台服务注册事件）；M5 webServer 四缺口全修（/lab-monitor 前缀、禁 registerFallback、handler 自产静态内容、网关绑定表述）+ L2 ctx.get('webServer') 判空；M6 风险 15（出口全缺席含 slots 缺席）新增 + 风险 14 改写；M7 conversation.view 承载实证列入 P0 前最小样例 ②（结论写入 04-milestones.md）；M8 D-B1/D-B2 命名贯穿 §5/§7/§8 ✓
- **新增加分项**：P0 验收 6 兜底同数据断言含**互斥形态模拟**（手动改 settings 命名空间 `aionui-panel.rightPanel='aionui-panel'` → 断言 `betterSidebarVisible=false` 且保持 ②）——本机未装 aionui-panel 时互斥防御仍可测量 ✓
- **前轮回归**：T1-1/T1-2/T2-1/T2-2/R-1 全部无回归 ✓

残留仅 2 处低度（不阻塞）：§8 交付物 2 的 protocol 字段冻结清单未显式列 `ui.betterSidebarVisible`（03-protocol.md 定稿时 schema 自然包含）；§10.3 历史修订记录保留「仅绑 127.0.0.1」旧表述（正文 3.2.4 已正确，修订记录保留历史原文可接受）。

**结论：v1.3 闭合通过。** 计划达到「核心独立、可插拔出口、sidebar 最后」完整达成状态，可按 §5.2 依赖图派出 D-A/D-B1（P0 前先跑 §8 交付物 2 的两个最小样例验证）。
