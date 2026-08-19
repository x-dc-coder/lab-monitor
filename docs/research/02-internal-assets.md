# Lab Monitor 内部可复用资产调研报告（t2，队长代完成）

> 说明：本任务原由 asset-researcher 执行，因其两次卡死于 `cordis_inspect_query(platform=client)`（子代理环境无页面可响应，工具永久挂起），由队长接手完成。better-sidebar 契约部分已由 researcher 在 t5 完成（output-t2b-better-sidebar.md），本节只做交叉引用。
> 依据：monitor-panel docs/01~06 与 scripts/deploy.sh、t8 报告（队长主会话实测）、plugin-audit-report.md、~/.dsh 已装插件、Agent-teams 实战。

---

## 1. monitor-panel 项目（远程多机监控面板）

### 现状
- 形态：云服务器（腾讯云 124.221.190.237）上的 FastAPI + uvicorn + SQLite + asyncio 面板（8898 端口，仅绑 127.0.0.1），前端 TypeScript + esbuild 构建（package.json 实证；docs/01 中 "echarts" 指旧 8899 面板，新 8898 面板已 esbuild 化，二期已移除 ECharts）。
- 采集：**30s 周期 psutil 自采**（CPU/内存/磁盘/负载/带宽）+ frp/tailscale 隧道质量 + 端口区间自动扫描发现（10000–19999 约定区，分片轮巡 256 端口/轮，TCP 全连接+HTTP banner 识别）。
- 数据模型：devices/tunnels/samples 全表带 `node_id`（MonitorNode 抽象，二期接远端 agent `POST /api/ingest` 零 schema 变更）；`metric_name` 收敛为常量枚举 + 白名单校验。
- 告警：阈值引擎 + alerts 表 + 面板红黄灯事件流；webhook（钉钉/企微/邮件）二期。
- 部署：scripts/deploy.sh 原子部署 + 自动回滚（releases/backups 目录、健康检查 grep 转义坑、chown 属主分离教训——详见 AGENTS.md monitor-panel 生产部署规则）。

### 可复用点
| 资产 | 复用方式 | 说明 |
|---|---|---|
| 指标命名常量枚举 + 白名单 | 直接借鉴 | Lab Monitor 的 metric 名也收敛为常量表，防脏数据污染 |
| 告警分级（红/黄灯 + 事件流） | 直接借鉴 | 与 t1 的 INFO/WARN/CRITICAL 三级呼应；monitor-panel 已证明"事件流+灯"的 UI 模式 |
| 历史趋势降采样（查询时按桶降采样） | 直接借鉴 | Lab Monitor ring buffer + 历史曲线可复用该策略 |
| node_id / MonitorNode 抽象 | 借鉴 | Lab Monitor 预留 node 维度（本机=local，未来远端机），数据模型一次到位 |
| 端口区间隐式注册表 | 不适用 | 本机场景无端口发现需求；但"零配置自动发现"哲学一致（t1 启示 11） |
| deploy.sh 原子部署 | 不适用（本机插件） | 仅 v2 转正式 npm 包发布时参考其发布纪律 |
| 前端 DataTable 组件规范（docs/06） | 参考 | 进程表/设备表 UI 的表格规范可沿用其踩坑结论 |

### 接口/边界
- **互补关系**：monitor-panel = 远程多机、30s 级、HTTP 轮询；Lab Monitor = **本机、秒级、进程内**。两者数据面正交；未来若 Lab Monitor 需要看远端 GPU，可经 webServer 注册 `/lab/events`（SSE）或对接 monitor-panel 的 agent 上报协议（v2 可选）。
- monitor-panel 的"30s 周期"对实验监控**不够**（训练瓶颈常在秒级波动），Lab Monitor 必须 1~2s。

## 2. DSH 平台能力核验（t8 基线复核）

### 现状（队长主会话实测，2026-08-18）
- **Host 内建符号仅** `ctx / harness / console / btoa / atob / TextEncoder / TextDecoder` —— **无 process、require、fetch、setTimeout**。定时器必须走 `timer` 服务（inject 声明），采样命令走 `shell` 服务（`shell.run` 前台 / `shell.start` 后台长驻 + `ShellProcess.readOutput()` 增量读）。
- **Host 事件目录**（全部实测存在）：`tools/pre-execute`（waterfall，可拦/改/放行）、`tools/result`（emit，冻结结果）、`tools/execute`/`tools/post-execute`（waterfall）、`agent/status`、`agent/pre-step`（waterfall，可注入/替换进入 step 的消息——实验提醒的备选注入点）、`system-prompt/assemble`（waterfall，提示词组装专家钩子）、`workflow/start|end|log|phase`、`subagent/start|end`、`llm/stream`（waterfall）、`session/event`、`approval/request`（waterfall）。
- **Host 服务**：`timer`（interval/timeout/throttle/debounce，disposer 语义）、`shell`（run/start）、`subprocess`（spawn/spawnTerminal）、`webServer`（register 路由）、`tools`（register/guard）、`systemPrompt`（section/context/variable——每模型步重新解析）、`settings`、`jobs`、`terminals`、`agents`、`sessions` 等。
- **Client 内建**：`ctx / React(createElement,useState,useEffect) / host / styles / console`。`host.call(method,args)` = Client→Host 包私有 JSON RPC（Host 侧 `harness.handle` 注册）。
- **确认两条限制**：① Host 无 process/require/fetch → /proc 读取只能经 shell 服务；② **无 Host→Client 事件桥** → UI 实时刷新 = Client 1s 轮询 host.call（进程内 RPC 开销可忽略）。
- **Client 事件目录**：仅 connection/reset、locale/change、slots/changed、theme/change（无跨平面业务事件）。

### 可复用点
- t8 报告的架构结论全部成立，无需修改：生命周期钩子（tools/pre-execute|result）、systemPrompt.variable 注入、harness.defineTool 工具桥、host.call 轮询、better-sidebar Tab（详见 t5）。

### 边界
- 动态插件（cordis_define）**进程重启即失效**、会话级隔离；生产化需转正式插件（宿主组合行 / npm 包 / 预设行，服务发布须 `cordis:group` + `isolate: true`，见 §4）。
- `systemPrompt.variable` 是"每步拉取"而非推送——告警打断 Agent 不可行，按 t8 设计以"UI + 下一步注入 + 工具结果"闭环。

## 3. 插件生态与已装资产

### 现状
- `plugin-audit-report.md` 六仓库（clinic/windtunnel/depguard/update-copilot/plugin-check/plugin-integration）均为**插件运维/质量类**，无资源监控插件。
- `~/.dsh/plugins/` 已装：`dsh-plugin-doctor`（只读体检工具）、`dsh-crypto-randomuuid-polyfill`（手机端 polyfill）——无监控类。
- 用户已有 `/home/dc/dsh-plugins/my-tabs-plugin`（better-sidebar 第三方 tab 验证项目，t5 已分析）。
- 生态搜索（awesome-deepseek-harness 等）：无现成"实验资源监控"插件——**该定位空白**（与 t1 结论"Cursor/Codex 无内置监控"一致）。

### 可复用点
- my-tabs-plugin = Tab 注册的**可直接复制的参考骨架**（t5 已给代码级结论）。
- plugin-doctor 的零依赖只读工具模式：Lab Monitor 的采集器也应零依赖（Host 内建 + shell 调用系统命令，不引入 npm 依赖）。

### 边界
- 动态插件是 MVP 载体；v2 生产化路径：① 本机 profile 预设行（`cordis:group` + `isolate: true` 包服务）→ 跨会话共享；② npm 包（bundle 双半 + cordis.patch.yml，参照 my-tabs-plugin 形态）。

## 4. Agent-teams 消息模型（本会话实战）

### 现状
- agent_teams_* 工具族：create（队长）/ add_member（durable continuable 子代理，默认快照队长 provider/model/effort）/ create_task（subject/description/assignee/dependencies）/ claim（依赖完成后可认领）/ send_message（邮箱消息，成员下次 turn 送达；队长在线时实时唤醒）/ status（成员活动+任务状态+邮箱）/ update_task / delete。
- 成员 = 独立会话的持久子代理（注册表可见，idle/ready/running 状态），任务输出落盘于团队目录 `.agent-teams/<team>/`（output-t*.md + inbox/*.jsonl + team.json）。
- 实战教训（本轮）：
  1. **子代理环境不可用 cordis_inspect_query(platform=client)**——永久挂起等待页面响应（两轮卡死根因）；
  2. 成员默认 deepseek-v4-flash + reasoning max，长任务可能超时被系统中断（asset-researcher 第一次"stopped before finished"）；
  3. 中断后成员上下文保留（durable），send_message 续跑可行；但连续踩坑的成员应果断换人/队长接手（本轮决策）。

### 可复用点（t3 协作方案输入）
- 任务依赖图驱动流程：调研（并行）→ 计划（依赖调研）→ 评审（依赖计划）——本次已验证该模式。
- 每个任务必须有明确输出文件路径 + 完成标记 + 摘要回报（否则队长需人工核验）。
- **红线清单必须随任务描述下发**（成员看不到队长对话）：禁 client 平台 inspect、禁长挂起工具、输出路径、超时处理。

### 边界
- Agent-teams 适合**任务编排与并行调研**；不适合秒级遥测/UI（t8 结论不变）。

---

## 5. 复用清单（P0/P1/P2）

| 优先级 | 资产 | 用途 |
|---|---|---|
| P0 | my-tabs-plugin 参考骨架（t5 结论） | better-sidebar Tab 注册、visible 暂停轮询、timer 服务 |
| P0 | t5 契约实证（guard 门禁/timer 坑/badge 快照） | Client 半实现规范 |
| P0 | t8 架构（hooks/RPC/prompt 注入/状态机） | 整体骨架 |
| P1 | monitor-panel：指标常量枚举、告警分级+事件流、历史降采样 | 平衡引擎与 UI |
| P1 | monitor-panel：node_id/MonitorNode 抽象 | 数据模型预留扩展 |
| P1 | t1 外部借鉴（dmon 长驻流、阈值防抖、run 状态机） | Host 半设计 |
| P2 | webServer SSE 出口 | 手机端/远端扩展（对接 monitor-panel 协议可选） |
| P2 | plugin-doctor 零依赖只读模式 | 采集器依赖纪律 |
