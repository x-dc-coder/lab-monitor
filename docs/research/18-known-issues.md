# 18 已知问题清单（2026-08-20 用户反馈，V2.1 收尾）

> 状态：**记录在案，待逐项修复**。来源：用户页面反馈 + 数据面实测 + 截图分析（vision）。
> 本文档是问题跟踪事实源；每项含「现象 / 证据 / 根因 / 修复建议 / 状态」。
> 配套：README.md「V2.1 修复与增强」、docs/research/13（slots 根因）、docs/research/17（KV 缓存）。

---

## 问题 1：GPU 利用率趋势图未显示

- **状态**：✅ 已修（2026-08-20 截图核验定位**真根因**：MiniTrend 用 `<polyline>` 元素但 points 是 path 格式 `"M4 52 L12 50"`（M/L 命令），polyline 只接受坐标对 → 属性非法被浏览器忽略 → 折线永不渲染。改 `<path d="M… L…">` + stroke 硬编码 #3964fe）
- **现象**：面板「GPU 利用率趋势」区域空白，无折线（用户截图确认）。
- **证据**：
  - history API 数据正常：18 点、18 个 gpuUtil 非空，值序列有波动（19,16,21,…,48,1,9）——**数据面没问题**
  - client 半已更新（boot rev 2abe4e748ee1 与本地构建一致），含「Y 轴动态区间 + 折线加粗 2px + 浅色基线」修复
  - 上一轮验证（webbridge DOM）：polyline 元素存在、2760 字符 points、stroke 品牌色——**元素在，但视觉可能仍不可见**
- **根因**（2026-08-20 截图复核确认）：
  1. **polyline 元素 + path 格式 points（真根因）**：`d.push((i ? 'L' : 'M') + x + ' ' + y)` 生成 `M/L` 命令串，但 `<polyline points>` 只接受坐标对（`"4,52 12,50"`）。非法属性 → 浏览器不渲染该元素。此前误判为 C.brand CSS 变量问题（stroke 硬编码后仍不可见，反证颜色不是根因）。
- **修复**（2026-08-20）：
  - `<polyline points>` → `<path d>`（d 属性原生支持 M/L 命令）
  - stroke 硬编码 `#3964fe`（不依赖 CSS 变量）+ `strokeWidth: 2` + SVG `minHeight: 56`
- **验证方法**：浏览器硬刷新 → 趋势区可见蓝色折线；`document.querySelector('path[stroke="#3964fe"]')` 非空

---

## 问题 2：GPU 表格数据异常 + 折叠进程无法展开

- **状态**：✅ 已修（2b 折叠展开 2026-08-20 落地；2a 数据面已正常）
- **现象**（用户反馈）：
  a. GPU 表格数据异常
  b. 聚合折叠的进程（如「系统进程（10）」）**无法展开查看成员**
- **证据**：
  - **host 半已是最新且数据正常**（DSH 13:48 重启，lib 13:30 构建）：snapshot procs 前 8 个 pid = [39548, 14852, 16004, …]（chrome/explorer 已置顶），**15 个进程全部带 GPU 值** —— prioritizeGpuProcs 生效 ✅
  - **数据异常疑点**：截图显示 GPU% 列仍为 `-`？若是，需复核是否浏览器缓存旧快照；若数值已出现但乱序/错位，需截图定位
  - **折叠无法展开**：procsTable 的聚合组当前**只渲染一行标题**（`▸ 系统进程（10） System Idle Process / System / …`），**没有展开/收起交互**（V2.1 实现时明确"展开交给后续迭代"）——这是已知功能缺口
- **根因**：
  a. 数据异常：待截图确认（可能旧缓存 / 或 gpu 字段取值优先级问题）
  b. 折叠无展开：procsTable 聚合组仅展示标题 + 前 3 个进程名预览，未实现成员展开
- **修复建议**：
  - b（明确要做）：聚合组标题行加**展开/收起状态**（useState），展开后渲染组内全部成员行（复用 row()）；标题加 ▲/▼ 指示
  - a：截图后定位；确认无 `-` 后标记已解决
- **验证方法**：浏览器点击聚合组标题 → 成员行展开
- **修复落地（2026-08-20）**：client 半 `ProcsTable` 组件化——`useState expanded: Record<pid, bool>`，聚合组标题行可点击（▼/▸），展开渲染组内全部成员行（复用 row()）；watchlist 命中行置顶高亮；status 行改为「数据 <快照时刻>」+ title 提示（替代 lastFetchAt）。mock-test [4] 进程表断言通过（walk 增强：函数组件浅渲染 + 独立 hook 容器）。

---

## 问题 3：告警日志展示不友好

- **状态**：✅ 已修（2026-08-20 落地：同 rule 合并计数 + 长文截断 + 折叠）
- **现象**：告警区域展示冗长、重复、可读性差（用户反馈）。
- **证据**（数据面实测）：
  - 当前 alerts = 3 条：`other-occupancy`×2 + `experiment-crash`×1 —— **同 rule 重复出现**
  - 告警文本含完整命令（如 `当前无实验但 GPU 显存占用 97%…（Top: 149099 node … 长命令串）`），msg 超长
  - client 渲染：`s.alerts.slice(0, 5).map(alertRow)` —— 直接平铺，无去重/折叠/摘要
- **根因**：
  - host 半 balancer 对同类告警按周期重复入列（`snapshotAlerts()` 保留多条同 rule）
  - client 无聚合展示：不合并计数、不截断长文本、无级别分组
- **修复建议**：
  1. **同 rule 合并**：alerts 按 `rule` 去重合并（显示 `other-occupancy ×2`），或 host 半 balancer 去重
  2. **msg 截断**：超长文本截断 + ellipsis（如 120 字），完整内容 title 提示
  3. **级别分组/着色**：critical/warn/info 分色（已有 alertRow 分色，可加强图标+折叠）
  4. 告警区**可折叠**：默认显示前 2 条 + 「还有 N 条」
- **验证方法**：浏览器截图对比；构造重复告警（如高显存占用）看合并效果
- **修复落地（2026-08-20）**：client 半 `AlertList` 组件化——alerts 按 `rule` 合并计数（`×N`）、msg 超 120 字截断 + title 全量提示、级别着色（critical/warn/info）、默认显示前 2 条 + 「还有 N 条（点击展开全部）」。mock-test [4] 告警断言（CRITICAL / 显存余量 <10% / 降 batch size）通过。

---

## 问题 4：GPU 利用率与面板展示数字未同步刷新

- **状态**：🟡 部分完成（2026-08-20：refresh+fetchHistory 同 tick 合并拉取已落地；变化驱动渲染/节拍对齐未做）
- **现象**：GPU 卡片/趋势/表格数字与实时 GPU 利用率不同步、刷新节奏不一致（用户反馈）。
- **证据**：
  - 采样链路：backend 2s 采集（`SAMPLE_MS`）→ ring；面板轮询 5s（`POLL_MS`）拉 snapshot
  - `buildSnapshot()` 返回 `ts: Date.now()`（快照生成时刻），但 procs/gpu 来自 `backendState.lastSnap`（最近一次 2s 采样缓存）——**两者存在 0~2s 的固有延迟**
  - 前端 `refresh()` 每 5s 拉一次；`labelThunk` 用 `last`（全局缓存）——tab 标题与面板内容可能差一个轮询周期
  - 趋势（history）与快照分开拉取（tick 内先 refresh 再 fetchHistory），**两处数据时刻不同步**
- **根因**：
  1. 采样(2s) 与展示(5s) 周期不整除 → 展示数字滞后最多 4s
  2. snapshot 与 history 双通道独立拉取，时间基准不一
  3. tab 标题（labelThunk 读 last）与面板（useState snap）更新时机不同
- **修复建议**：
  1. **统一快照时间戳展示**：面板显示 `更新于` 用 snapshot.ts（已有），并标注数据实际时刻（lastSnap.ts）——让用户理解延迟来源
  2. **同通道拉取**：tick 内一次拉取返回「快照+历史」合并体（或 history 带 sinceMs 由 host 端快照缓存对齐），消除双通道错位
  3. **轮询节拍对齐**：POLL_MS 改为 SAMPLE_MS 整数倍（如 4s），并在收到新 lastSnap 时才 setSnap（变化驱动渲染，而非固定节拍）
  4. 可选：SSE/流式推送（README 提及出口④ SSE 可扩）替代轮询
- **验证方法**：连续观察 3 个周期，卡片数字与 nvidia-smi 实时值偏差 ≤1 采样周期
- **修复落地（2026-08-20，部分）**：client tick 内 `Promise.all([refresh(), fetchHistory()])` 同 tick 合并拉取，消除「快照/历史双通道时刻错位」；快照 `ts` 即数据实际时刻（buildSnapshot 已用 lastSnap 数据 + 当前 ts 标注）。未做：轮询节拍对齐（POLL_MS 取 SAMPLE_MS 整数倍）、变化驱动渲染、SSE 推送。

---

## 问题 5：lab_status brief 摘要恒显示「GPU 无」+ watchlist 命中行 UI 不可见 + 告警无生命周期（2026-08-22 排查新增）

- **状态**：✅ 已修（2026-08-22 V2.4，plugin-specialist 排查定位，verify-host [C2] 回归）
- **现象**（运行时实测）：
  a. `lab_status brief:true` 返回 `[Lab Monitor] GPU 无 · 告警: 无`，但完整快照 GPU 正常（RTX 5060 Ti / 36°C / 1016MiB used）——Agent 摘要与真相矛盾；
  b. `watchedPids=[41184]`（llama-server 命中）但快照 procs 15 行里没有 41184 → 面板 watch 置顶高亮形同虚设；
  c. 告警列表 8 条全是 11 小时前的 experiment-crash（critical），`alertsCriticalCount=8` 只增不减，`lab_advice` 恒返回这 5 条旧 crash——badge/建议被历史噪音淹没。
- **根因**：
  a. defineTool render 对 brief 模式把 execute 返回的信封 `{ok,line}` 当快照二次调 `promptLine(value)` → `value.gpu` undefined → 恒走「GPU 无」分支（src/index.ts render 分支，execute 生成的正确 line 被丢弃）；
  b. `prioritizeGpuProcs` 只按 GPU 利用率排序，无 GPU 活动的 watch 进程（空闲 llama-server）被 15 行截断切掉；
  c. balancer alerts 纯内存只进不出：TTL/确认/清除机制全无，ALERT_MAX 截断也不扣 criticalCount。
- **修复（2026-08-22）**：
  a. render brief 分支直接使用信封 line（无则回退 JSON 序列化）；
  b. buildSnapshot 排序改为 watch 命中先行 + 其余 GPU 优先补足 15 行；
  c. balancer 加 `ALERT_TTL_MS=24h` 过期清理（snapshot/advice/count 读取时兜底）+ `clear(filter?)`（全清 / runId / rule 定向清除）+ 截断计数修正；`lab_ctl` 加 `clear-alerts` 动作（返回 cleared/remaining/criticalCount），HTTP control 路由同步支持。
- **验证方法**：DSH 重启后 `lab_status brief:true` 摘要含 `GPU0 ...%`；`lab_ctl clear-alerts` 后 badge 归零；watch 命中进程（如运行 llama-server）出现在面板进程表顶部高亮。
- **修复落地的回归**：verify-host.js 新增 [C2] 段（8 断言：TTL 过期回落 / rule+runId 定向清除 / 全清归零）+ watch 置顶断言；e2e-host.js 补 settings/ctx 桩后 ALL PASS；`scripts/verify.sh --e2e` 全绿。

---

## 问题 6：P1 功能端到端实证 + 「终端跑命令不产生实验历史」疑问（2026-08-22，V2.5 批次）

- **状态**：✅ 已实证/已解释（V2.5 落地后真实 DSH 验证）
- **背景**：V2.5（ended[] 实验历史 + 设置面 + 使用文档）交付后，用户在 WSL 终端直接跑短训练命令，面板未出现实验历史——疑似 bug。
- **结论（实测）**：
  - **DSH 工具通道跑**（pre-execute 命中 → run 建立 → 进程组关联 → 结束归档）：`python3 -c 'import time; time.sleep(20)'` → `run-20260822-001` `state=done`，`ended[]` 含完整摘要（gpuUtilMax 20 / gpuUtilAvg 10 / memPeak 1751 / durationSec 41 / dataPartial false），面板「实验历史（1）」可见 ✅；
  - **终端直接跑**（无 pre-execute 事件）：进程只出现在 ps 快照，状态机不会凭空建 run → 无历史、无告警——**设计行为，非 bug**（跟踪依赖工具事件链路）；匹配规则见 `TRAIN_PATTERNS`（python train*.py / python -c / python -m / torchrun / deepspeed）。
- **顺带发现**：① 阈值极端值 1/1/10 曾出现在生效阈值中——排查确认系测试通道写入未复位（e2e 独立进程不写真实 settings；实际为用户/工具测试残留），后恢复；② 设置面补全前 pollMs 无任何配置入口（死字段）——V2.5 由 snapshot.thresholds.pollMs 动态驱动（1000–60000 钳制），`lab_ctl set-threshold pollMs=3000` 或面板即改即生效。
- **V2.6 跟进（2026-08-22）——「实验历史只存内存」已修复**：V2.5 交付后端到端验证发现重启即失（真实缺陷）→ settings 持久化 `history` 键 + 惰性写回（history[0].endTs 变化触发）+ 启动 restoreEnded 恢复（上限 20）；verify-host 重启模拟新增 3 断言（恢复/runId 精确/summary 完整）。
- **文档同步**：README V2.5 / V2.6 / docs/usage.md（A1）/ docs/03-protocol.md 1.4（ended/thresholds/enabled）/ 04-milestones V2.5 完成记录。

---

## 附录 A：数据面健康快照（2026-08-20 14:0x 实测）

- DSH 进程：PID 174318，13:48 启动（host 半 = lib 13:30 构建，含全部修复）
- snapshot：procs 15 个全带 GPU 值，chrome/explorer 置顶（prioritizeGpuProcs 生效）
- history：18 点全有 gpuUtil（数据面正常）
- alerts：3 条（other-occupancy×2 + experiment-crash×1）
- 结论：**host 半数据面全部正常**；4 个问题集中在 client 渲染层（问题 1/2b/3/4）

## 附录 B：修复优先级建议

| 优先级 | 问题 | 工作量 | 说明 |
|---|---|---|---|
| P0 | 问题 1 趋势可见性 | 小（stroke 硬编码+minHeight） | 最显眼的视觉缺陷 |
| P0 | 问题 2b 折叠展开 | 中（useState + 成员行渲染） | 功能缺口，用户明确提及 |
| P1 | 问题 4 刷新同步 | 中（合并拉取/变化驱动） | 数据一致性 |
| P1 | 问题 3 告警聚合 | 中（去重合并+截断+折叠） | 可读性 |
| P2 | 问题 2a 数据异常复核 | 小（截图确认后标记） | 可能已随 host 重启解决 |
