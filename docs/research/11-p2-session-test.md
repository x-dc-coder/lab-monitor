# 11 Lab Monitor P2 会话内实证步骤（v1.4.5）

> **归档注记（2026-08-20 清理）**：本文所述 v1.4.5 MVP 资产（`plugin/`、`scripts/dev-run.sh`、`lab-monitor.define.json`）已归档至 `docs/archive/v1.4.5-plugin/`；以下装载流程仅供历史参考，V2 用 `dsh plugin add` 安装。

> 目的：在 GUI 会话完成 P2 剩余会话内验证 + 回归红线。
> 前置：lab-monitor.define.json 已由 dev-run.sh 重新生成（v1.4.5，含 python -c 指纹修复 E1；现归档于 `docs/archive/v1.4.5-plugin/lab-monitor.define.json`）。
> 执行人：集成工程师（GUI 会话）。
> **进度（2026-08-19 队长）**：P2 1（T4c 5min 防重）、P2 2' 即时生效（T4）、P2 3（T5 history 真实数据）
> 已由 `scripts/e2e-host.js` 真实进程完成（见 docs/research/10-p1-e2e-test.md §5）——本清单剩余：
> **P2 5 better-sidebar 适配器真实注册 + P0 回归红线**（需 GUI 会话真实环境）。

## 0. 装载 v1.4.5

1. `lab-monitor.define.json`（v1.4.5，现归档 `docs/archive/v1.4.5-plugin/`）→ cordis_define 装载 → cordis_run 激活；
2. `cordis_inspect_self(labm-*, pkg-*)` 无 diagnostics；
3. 若旧 labm-1（v1.4.4）仍在运行，先 cordis_stop 再装载新版本（或直接 update 到新 pkg）。

## 1. P0 回归红线（改 host 后必查）

> 本次只改 host 半（指纹/归一化），client 半未动——P0 1/2/5/6 中：

| 项 | 验证 | 预期 |
|---|---|---|
| P0 1' 数据面 | `lab_status` → JSON 快照 | platform=wsl、GPU 真实 util/mem/temp、experiment=null（无实验） |
| P0 5 核心独立 | 无 UI 出口时采集/告警不中断 | host 侧采样 + 工具照常（GUI 面板可关） |
| P0 2 轮询节流 | 观察 conversation.view（若已注册） | 5s 节流 + 退避（mock 已覆盖，UI 侧确认即可） |
| P0 6 互斥 | snapshot.ui.betterSidebarVisible | 本机无 aionui-panel → true |

## 2. P2 验收 2' 即时生效复核（持久化已留 v2）

| 步骤 | 预期 |
|---|---|
| `lab_ctl set-threshold tempWarn=1` → 等 12s | thermal warn 告警出现（≤1 采样周期生效） |
| `lab_ctl set-threshold tempWarn=85`（复位） | 告警停止增长 |
| 重复 set-threshold 同参数 | last-write-wins 不报错 |

## 3. P2 验收 1 会话内复核：告警防抖 + 5min 防重

| 步骤 | 预期 |
|---|---|
| `lab_ctl set-threshold memWarn=5 utilWarn=1` → 等 12s | oom critical 告警 1 条 |
| 继续观察 20s | **不重复发 oom**（5min 防重 lastByRule） |
| 复位 memWarn=95 utilWarn=90 | — |

## 4. P2 验收 5 会话内：better-sidebar 适配器真实注册

> 本机 GUI 会话装了 better-sidebar（0.13.0）→ ③ 应注册并替代 ②。

| 步骤 | 预期 |
|---|---|
| 装载后侧边栏出现 lab-monitor Tab | ③ registerTab 成功（双检查：ctx.get + betterSidebarVisible=true） |
| Tab badge | 显示 CRITICAL 计数（无告警时隐藏/null） |
| Tab settings（pluginToggles） | 4 行阈值面板（utilWarn/memWarn/tempWarn/pollMs） |
| 改 pluginToggles 阈值 | ≤1 轮询周期生效（经 snapshot 携带） |
| 切走 Tab（visible=false） | 30s 低频保活（badge 仍更新） |
| 若 Tab 未出现 | 记录：是否 betterSidebar 互斥（aionui-panel.rightPanel）或激活时序——降级链应保持 ② 正常 |

## 5. P2 验收 3/4 会话内复核

| 项 | 步骤 | 预期 |
|---|---|---|
| 3 历史曲线 | `labMonitor.history`（或 UI 曲线） | 降采样 ≤500 点；长实验 running 扩容（R-3） |
| 4 出口健壮性 | 面板关闭（better-sidebar 禁用场景模拟） | host 采集/告警不中断（工具 lab_status 照常） |

## 6. 记录回填

执行完成后：
1. 本文件补「执行记录」节（真实观测 + 通过/受限）；
2. docs/04-milestones.md P2 项勾选回填（2' 即时生效复核、5 会话内、回归红线）；
3. 若发现缺陷 → 记录版本号，交队长出 v1.4.6 修订。
