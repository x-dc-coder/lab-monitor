# Lab Monitor 实施计划评审报告（t4）

> **归档注记（2026-08-20 清理）**：本文所述 v1.4.5 MVP 资产（`plugin/` 动态版、`scripts/dev-run.sh`、`lab-monitor.define.json`）已归档至 `docs/archive/v1.4.5-plugin/`。

> 评审人：reviewer（计划评审员）｜日期：2026-08-18
> 评审对象：output-t3-plan.md（368 行 8 章，architect 制定）
> 评审依据（全部经 read/grep/bash 核验，未调用任何 client 平台 inspect）：
> - output-t2b-better-sidebar.md（TabDescriptor/badge/pluginToggles/visible/guard 契约实证）
> - docs/t8-lab-monitor-architecture.md（架构基线：Host 事件语义、Host 受限环境、Client 符号面）
> - output-t1-external.md（外部 12 条借鉴）、output-t2-assets.md（内部资产与平台复核）
> - 事实核验：`~/projects/lab-monitor/` 已创建（空目录，符合计划 §8 交付物 1）；DSH 宿主 types 中无 pre-execute 事件定义文件（事件存在性以 t8 实测为准，未重复验证）

---

## 一、总体评价

计划整体质量高：三层组合定位、四通道消息流、P0→P2 可测量验收、协作分工与红线纪律均超出一般实施计划水平，与 t1/t2/t8 依据一致度高，**无方向性错误**。

但存在 **6 条高严重度缺口**：其中 3 条会让里程碑验收在实现时必然失败（状态机 pid 来源、tools/result 配对、P1 验收命令不匹配），2 条是消息传递闭环未闭合（pluginToggles 生效链路、badge 实时性 vs 零轮询冲突），1 条是已列风险的缓解措施实际无效（跨会话双采集器检查）。另有 9 条中严重度与 7 条低严重度问题，详见下。

---

## 二、问题清单（按评审维度）

### 维度 1：技术可行性

| # | 问题 | 严重度 | 建议修正 |
|---|---|---|---|
| T1-1 | **状态机 crashed 判定依赖 pid，但 pid 来源未定义且 pre-execute 时不可能有 pid**。§3.1 判定③"running 中 pid 消失 → crashed"，实验记录记 `{runId, pid, ...}`；但 t8 §3.2 实测 pre-execute 是"工具派发**前**"事件（拦截/放行/改参），此时 bash 工具尚未执行、被跟踪进程不存在，pre-execute 处理器拿不到 pid。整份计划未说明 pid 如何获得 | 高 | ① pre-execute 只记 `{runId, cmd 特征, startTs, baseline}`；② 由 ps 快照（5s）按"cmdline 含命令特征 + startTs 之后出现"关联出 pid；③ 或监听 `tools/execute`（执行时事件）回传句柄/pid；④ 明确 pid 关联失败降级（"无进程活动 N 秒 + 无 result → crashed"超时判定）；⑤ crashed 判定周期与 ps 快照间隔对齐（≥2 个采样间隔无存活才判，验收"≤15s"而非"10s 内"） |
| T1-2 | **tools/result 无配对机制，实验运行期间任何其他工具结果会误判 done**。tools/result 是 emit 事件，**任何**工具完成后都触发（t8 §3.2 实测）；§3.1 判定②"tools/result 匹配 → done"未定义如何识别"这是实验命令的结果"。实验 running 期间 Agent 执行 ls/curl/kill 等任意工具，其 result 都会触发 done——尤其 P1 验收 1 的 kill 场景会直接误判 done 而非 crashed | 高 | result 处理器必须配对校验（工具名=bash 且命令串含 runId 特征，或平台调用 ID 配对），不匹配的 result 忽略；done 判定加"实验进程已消失"双确认；kill 实验进程（本身是工具调用）不得触发 done——这是 P1 验收 1 成立的前提，写入 02-data-model.md |
| T1-3 | **MVP 动态插件"单函数体"限制与目录结构"多文件"矛盾**。cordis_define 的 code.host/code.client 是函数体字符串，Host 半无 require/import（t8 §3.1）；但目录规划 host/ 下 8 个模块文件，§1 只说 dev-run.sh"打包为 define 输入"，合并策略（拼接顺序/作用域/命名冲突/函数提升）完全未定义——MVP 可执行性的根基问题 | 高 | 二选一：① MVP 改单文件开发（plugin/host/index.js 单文件，按顶层函数声明共享作用域组织，v2 转正式插件再拆多文件）；② dev-run.sh 实现确定性合并器（固定顺序 concat、禁 import/export、合并产物 node --check 纳入 verify.sh）。无论哪种，P0 前先用最小样例验证 cordis_define 装载"多函数/大体积函数体"可行 |
| T1-4 | **dmon 长驻流缺运行中中断检测与自愈**。shell.start 的后台进程可能因驱动切换/WSL2 显卡驱动重置（WSL2 下 dmon 行为与裸 Linux 有差异）退出；readOutput 流 EOF 后采样器将静默停采。风险 3 只覆盖"启动探测 + 字段解析容错"，未覆盖运行中中断 | 中 | 采样 tick 检测流 EOF/超时无新行 → 指数退避重启（≤3 次/5min）+ 回退 query-gpu 快照模式 + 快照标 `gpu.degraded`；P0 验收加"kill dmon 进程后 30s 内自动恢复"用例 |
| T1-5 | **Client 半 React hooks 导入来源未定义**。动态插件 client 符号面是 `React` 对象（t8 §3.4：React(createElement,useState,useEffect)）；§3.2 MonitorPanel 代码裸用 `useEffect/useState`，若符号面未暴露顶层函数将 ReferenceError | 中 | 统一 `const {useState,useEffect} = React` 解构或 `React.useEffect`，补充进 §5.4 红线 3 |
| T1-6 | **风险 9 缓解措施"环境变量开关"在 Host 半不可行**——Host 无 process/process.env（t8 §3.1 实测） | 低 | 只用 Host `settings` 服务（t2 §2 实证存在）或 rpc 控制字段承载注入开关 |
| T1-7 | **conversation.view 兜底分支写法不完整**：直接 `slots.register(...)`，未说明动态插件下 slots 的获取方式（slots 有专门守卫，t2b §2.2 参考实现为 `ctx.get('slots')` 判空）且未写明与 registerTab 的互斥/降级顺序，双注册会重复渲染 | 低 | 兜底改为 `const slots = ctx.get('slots'); if (slots) ctx.effect(() => slots.register(...))`；写明"registerTab 抛错 → 自动切兜底"的顺序与回滚分支（与风险 1 呼应） |

### 维度 2：消息传递完整性

| # | 问题 | 严重度 | 建议修正 |
|---|---|---|---|
| T2-1 | **pluginToggles 声明式设置行 → host 阈值生效的链路缺失（第 5 条通道断裂）**。pluginToggles 由 better-sidebar 自行渲染并持久化到 `pluginSettings[id]`（t2b §1.3 实证），**无值变更回调**；而阈值判断在 host 半 balancer.js。计划有 rpc.setThresholds 但没定义谁、何时调用它——P2 验收 2"改阈值 ≤1 轮询周期生效"无实现路径 | 高 | 二选一并写入 docs/reference/protocol.md：① 组件从 props.store（TabComponentProps 含 store）读 pluginSettings，每次轮询/onOpen 时随 snapshot 请求上传阈值参数（host 以请求参数为准，天然 ≤1 轮询周期生效）；② 改用 `settings.render` 自定义面板（实证可拿 updatePluginSetting 回调）→ 回调里 host.call('labMonitor.setThresholds') |
| T2-2 | **badge 实时性与 visible=false 零轮询冲突（P0 验收 2 与 P2 验收 1/3 自相矛盾）**。badge 由模块级 last 快照驱动且 thunk 禁止发请求（t2b 结论②3 实证）；last 只在 client 轮询运行时更新，visible=false 时轮询停止（P0 验收 2 要求"页面零 host.call"）→ badge 永远停留在最后值。P2 验收 1"持续 10s → badge 计数 +1"在用户没看 tab 时不会发生；P2 验收 3"关闭 tab 后告警引擎独立"只对 host 成立，UI badge 感知不到 | 高 | 三选一（必须选定，否则 P0 与 P2 验收不可兼得）：① **低频保活通道**：visible=false 时降频（如 30s）仅拉一次 snapshot 更新 last（不渲染 DOM），并把 P0 验收 2 改为"visible=false 时零渲染轮询、仅 ≤1 次/30s 低频保活（可配）"；② badge 语义降级为"会话内累计告警数（打开过 tab 后累计）"，文档写明取舍；③ 依赖 v2 的 Host→Client 推送（当前平台无此能力，t8 §3.4 实证，不可作为 MVP 方案）。另需在 protocol 中定义 `snapshot.alertsCriticalCount` 字段（现快照结构只有 alerts[]，badge 需先算再缓存） |
| T2-3 | **host.call 失败处理未定义**。页面刷新/插件重启/断连瞬间 client 轮询 host.call 会 reject；平台无 Host→Client 事件桥，client 只能自愈。badge/title 依赖的 last 可能长期过期且无任何提示 | 中 | refresh() 包 try/catch → "连接中断，重试中"错误态 + 指数退避（5s→10s→30s 封顶）+ 恢复后立即刷新；写入 §5.5 回归项 |
| T2-4 | **通道 4（ctx.emit lab/*）无任何可测点**——P0~P2 验收均未覆盖"事件确实发出"，MVP 又无其他插件行消费，属于写了但不验收的通道 | 中 | P1 验收加一项：自监听或临时观测行断言 lab/experiment-start/end/alert 按状态机转移发出（console 日志断言即可） |
| T2-5 | **lab_ctl 缺 Agent 误用护栏**。若 pause 语义为"暂停告警/监控"，Agent 误用造成漏报窗口；若为"暂停实验进程"则违反 t8 §7"只建议不越权"红线 | 低 | ① 语义明确为监控/告警引擎启停，绝不碰实验进程；② pause 类写操作限定 UI 或需 approval/request 确认（t8 §3.2 实证该钩子存在）；③ 工具描述明示只读工具与写操作风险 |

### 维度 3：项目结构

| # | 问题 | 严重度 | 建议修正 |
|---|---|---|---|
| T3-1 | 多文件 vs 单函数体矛盾（同 T1-3，此处交叉引用）——目录树本身的完整性、MVP→v2 演进表均无问题 | 高 | 见 T1-3 |
| T3-2 | **双轨依赖声明事实来源**：plugin/package.json（dsh.client.inject，v2 形态）与动态插件对象 inject（MVP 形态）并存，D-A/D-B 可能误读 | 中 | README/01-architecture 写明"MVP 以源码内对象 inject 为事实来源，package.json 仅 v2 启用" |
| T3-3 | agent-preset/lab-commander 为 v2 内容但目录位于 MVP 源码树下，MVP 实现者可能误实现 | 低 | 目录保留、README 标注"v2 启用"，README 落地时注明（与 §1 演进表一致） |

### 维度 4：里程碑可验收性

| # | 问题 | 严重度 | 建议修正 |
|---|---|---|---|
| T4-1 | **P1 验收 1 的模拟命令与关键词表不匹配，验收第一步即失败**：验收给 `sleep 300 &` 或 `python -c "import time;time.sleep(300)"`，但 §3.1 关键词表只列 `python train*.py`/`torchrun`/`deepspeed`/`python -m`——sleep 与 `python -c` 均不命中，pre-execute 不会触发 running | 中 | 关键词表加入 `python -c`/`python3 -c`（或明确 sleep 类命令命中规则），或验收改用 `python train_demo.py` 形态命令；验收用命令固化进验收脚本 |
| T4-2 | **P0 验收 2 断言手段不可行**："DevTools 网络/console 计数断言"——host.call 是进程内 RPC（t8 §3.4 实证），**不走网络**，DevTools Network 面板看不到任何请求；console 若无日志也无从断言 | 中 | 断言改为 host 侧计数（rpc.js 内置调用计数器，经专属 RPC/快照字段暴露）+ client refresh 打 debug 日志，验收对照计数器增量；手段写入 04-milestones.md |
| T4-3 | P0 验收 1"偏差 <5%"未定义比较方法（dmon 1s 均值 vs query-gpu 瞬时值、采样时刻对齐、util 波动场景） | 低 | 写明：同秒内先后取 dmon 行解析值与 `nvidia-smi --query-gpu` 快照比较，≥3 个采样点均值偏差 <5% |
| T4-4 | P2 验收 2"重启会话后设置保留"的断言路径未写清：MVP 动态插件重启会话后需重新 define，pluginSettings 持久化在 better-sidebar prefs 文档（t2b §1.3 实证），跨会话保留依赖 better-sidebar 而非插件 | 低 | 断言步骤写清：重开页面验证 pluginSettings[id] 仍在 + 重新 define 后阈值生效 |

### 维度 5：风险遗漏补充（architect 未写到，共 5 条新增 + 2 条交叉引用）

| # | 问题 | 严重度 | 建议修正 |
|---|---|---|---|
| R-1 | **风险 7 的缓解措施实际无效：inspect_self 检查防不住跨会话双采集器**。动态插件会话级隔离（t2 §2 边界实证），本会话 inspect 列表看不到其他会话 define 的插件；双实例后果也未定义：两个 dmon 长驻进程 + 两套 timer + 同名 lab_status 重复 defineTool（注册冲突行为未实证） | 高 | MVP 修正为：接受"跨会话双采集器为已知无害状态"（采集只读、重复 tool 注册需实证同名工具行为并写明策略）；v2 组合行单例化 + `isolate: true` 为正解（保留）；P0 验收加"同一插件被重复定义/激活时的行为断言" |
| R-2 | **同一会话并行工具调用（并行 bash 实验 / workflow 并行）下状态机语义未定义**：实验记录数组是否支持多 run 并发？两个 running 并存时 crashed/done 判定如何归属 runId？§6 风险 7 只讲了多**会话**竞争，没讲多**实验**并发 | 中 | v1 明确"单实验跟踪"约束（新 start 命中时旧 run 自动归档 done/aborted），或按 runId 多轨并存（复杂）——二选一写入 02-data-model.md；P1 验收加"并发双命令只跟踪其一"用例 |
| R-3 | **ring buffer ≤30 分钟上限与长时间实验（>30min）冲突**：P1 验收 2"实验记录含资源曲线摘要"对 >30min 实验摘要不完整（早期数据已滚动丢失），告警历史同样丢失 | 中 | 实验 running 期间按需扩容（如容量翻倍至 2h）或摘要只覆盖最近 30min 并在记录标注"部分数据"；写明取舍 |
| R-4 | **badge/title thunk 抛异常被 better-sidebar 吞掉（t2b §1.2 实证：异常被吞、角标不显示），无日志则静默失效**——与 R-5 同源的可观测性缺口 | 中 | thunk 内 try/catch + console.error；P2 验收加"thunk 抛错不白屏且有日志"用例 |
| R-5 | **页面刷新/断连时 host.call 失败**（同 T2-3，交叉引用） | 中 | 见 T2-3 |
| R-6 | **nvidia-smi 存在但 dmon 启动即失败/流中断**（WSL2 下 dmon 支持受限，队长提示方向）（同 T1-4，交叉引用） | 中 | 见 T1-4 |
| R-7 | **Agent 工具误用 lab 工具的护栏**（同 T2-5，交叉引用） | 低 | 见 T2-5 |

---

## 三、结论：**有条件通过**

计划方向、架构选择、四通道总览、协作方案与时间盒均成立，可进入实施；但以下 **6 条高严重度问题必须在任何实现（D-A/D-B 派出）之前修正**，否则对应里程碑验收必然失败：

### 必须修正项清单（高严重度，阻断开工）

1. **T1-1 状态机 pid 来源**：定义 pre-execute（无 pid）→ ps 关联 / tools/execute 回传 / 超时降级 的完整链路；
2. **T1-2 tools/result 配对**：result 必须与 runId 配对校验，不匹配忽略，kill 实验进程不得误判 done（P1 验收 1 成立前提）；
3. **T1-3 单函数体 vs 多文件**：确定 MVP 单文件或 dev-run.sh 确定性合并策略，P0 前最小样例验证；
4. **T2-1 pluginToggles 生效链路**：选定"轮询携带阈值"或"render 自定义面板回调"之一，写入 03-protocol.md；
5. **T2-2 badge 与零轮询冲突**：选定低频保活 / 累计语义 / v2 推送三选一，同步修订 P0 验收 2 与 P2 验收 1 的表述；
6. **R-1 跨会话双采集器**：修正风险 7 缓解措施（inspect_self 检查无效），定义双实例行为与同名工具策略。

### 建议合入修订版的中严重度项（共 9 条，不阻断开工但需列入对应里程碑任务）

T1-4 dmon 中断自愈（P0）、T1-5 hooks 导入来源（P0 红线补充）、T2-3 host.call 失败处理（P0）、T2-4 emit 事件可测点（P1）、T3-2 依赖声明事实来源（P0 README）、T4-1 P1 验收命令匹配（P1）、T4-2 P0 验收 2 断言手段（P0）、R-2 并行实验状态机语义（P1 前定稿）、R-3 长实验 buffer（P1）。

> 修订路径建议：architect 依据本报告出 output-t3-plan.md 修订版（或修订段），队长确认 6 条高项闭合后派出 D-A/D-B；低严重度项（T1-6/7、T2-5、T3-3、T4-3/4、R-7 等 7 条）随实现文档合入即可，不单独阻塞。
