# Lab Monitor 使用文档（A1）

> 落地：2026-08-22（P1 批次，A1「使用文档」承诺兑现）。消费对象：DSH 会话中的 Agent 与端用户。
> 事实源：`src/index.ts` 工具注册 + `docs/reference/protocol.md`（契约 1.4）。与命令签名不一致时以实测为准。

## 0. 一句话定位

Lab Monitor 是本机、秒级的科研实验监控助手：为 DSH 里的训练/推理实验提供
「采样 → 状态 → 诊断 → 告警 → UI/Agent 感知」闭环。默认在 DSH 侧边栏显示实时面板，
Agent 侧可通过三个工具按需查询与操控。

## 1. Agent 工具（DSH 主会话内直接用）

| 工具 | 用途 | 典型场景 |
|---|---|---|
| `lab_status` | 查询实时快照 | 用户问"现在 GPU 什么情况"、实验是否在跑、显存是否快爆 |
| `lab_advice` | 查平衡引擎建议 | 告警时段看分级建议与置信度、可执行动作 |
| `lab_ctl` | 控制与配置 | 调阈值、暂停/恢复监控、打标签、清告警、设 watchlist |

### 1.1 `lab_status`

- 无参数：返回完整快照对象——`gpu[]`（每卡 util/mem/temp/power）、`cpu`、`mem`、
  `procs[]`（前 15）、`experiment`/`experiments[]`（运行中实验）、`ended[]`（已结束实验历史）、
  `alerts[]`（告警+建议动作）、`tags[]`（标签分组聚合）、`thresholds`（生效阈值）、`enabled`（引擎状态）。
- `brief: true`：返回一行摘要 `[Lab Monitor] GPU0 6% · 1.3/15.9G · CPU 5% · 他占 node … 0.5G · 告警: 无`
  ——适合作为会话状态行的低 token 摘要；**它是最终字符串，不要再二次解析成"快照"**（V2.4 修复：此前信封被二次渲染导致恒显"GPU 无"）。
- `mem` 单位 MiB；多卡场景 `gpu[]` 逐卡给出。

### 1.2 `lab_advice`

- 无参数：返回平衡引擎当前建议 `{ advice: [...] }`（分级 + 置信度 + 可执行动作）。
- 无告警时 `advice` 为空数组；建议按规则分组（oom / io-bottleneck / thermal / imbalance / other-occupancy / experiment-crash）。

### 1.3 `lab_ctl`（action 枚举 9 项）

| action | 参数 | 说明 |
|---|---|---|
| `set-threshold` | `thresholds: { utilWarn?, memWarn?, tempWarn?, pollMs? }` | 即时生效并持久化到 settings（重启保留）；`pollMs` 1000–60000 驱动 UI 轮询周期 |
| `pause` / `resume` / `start` | — | 暂停/恢复监控引擎（暂停时跳过采样但快照照常返回，UI 显示"监控已暂停"） |
| `clear-alerts` | `runId?`, `rule?` | 清除告警：不带参数全清（badge 归零）；带 `rule` 只清该规则（如 `rule=experiment-crash`）；带 `runId` 只清该实验告警；**同步重置通知指纹**（同告警可重新通知，不绕过引擎 5min 防重） |
| `watch` | `keywords: string[]` | 设置 watchlist（不传 = 清空）；命中进程在面板置顶显示；随 settings 持久化 |
| `tag` | `tag: { op: 'add'\|'remove'\|'list', label, patterns?/pid?, kind?, color?, id? }` | 标签分组：`add` 支持正表达式规则（`patterns`）或 pid 快速打标（自动提取 cmdline 生成规则，重启后仍命中）；`remove` 按 id；`list` 列出全部 |
| `set-notify` | `alertNotify?('off'\|'notice'\|'wake'), escalateAfterSec?, notifyThrottleMs?` | 设置告警通知策略（M1/issue#5）：档位（off=不推送仅工具可见 / notice=推送不唤醒，默认 / wake=critical 唤醒 Agent）；warn 持续秒数升 critical；聚合窗口 ms。即时生效 + 持久化 |
| `history-manage` | `op: 'list'\|'delete'\|'clear', runId?, keep?` | 实验历史管理（#10/2026-08-24）：`delete` 按 runId 删单条；`clear` 清空（`keep` 保留最近 N 条）；删后显式持久化（settings 同步，重启不丢失） |

示例：

```text
lab_ctl set-threshold thresholds={memWarn: 90}
lab_ctl pause
lab_ctl clear-alerts rule=experiment-crash
lab_ctl watch keywords=["llama-server","vllm"]
lab_ctl tag tag={op:"add", label:"py实验", patterns:["python.*train"], kind:"experiment"}
lab_ctl set-notify alertNotify=wake escalateAfterSec=900
lab_ctl history-manage op=clear keep=5
```

> **子代理权限（M3/issue#7）**：子代理默认 `readonly`——`lab_ctl` 被 guard 执行期拒绝（restricted 档仅白名单
> `watch/tag/history-manage` 放行，full 档全放行）；子代理可用只读工具 `lab_status_ro`（registerContinuableSetup
> 注入，仅返回 GPU/进程/实验摘要，无控制面）。配置：settings `subagentPolicy`（readonly|restricted|full，默认 readonly）。

## 2. 面板 UI（DSH 侧边栏 conversation.view）

- **概览行**：每卡 GPU 利用率/显存/温度/功耗、CPU、内存、平台来源标注（`[wsl·dmon]`）。
- **实验状态块**：主实验 + 并行实验列表（多轨上限 4）；状态徽标（running/done/crashed/aborted）、时长、pid、cmd。
- **实验历史（P1 新增）**：`▸ 实验历史（N）` 折叠块——已结束实验（done/crashed/aborted）最新在前（上限 20），
  每行 runId + 状态徽标 + **类型徽标（M2：冒烟/回归/全量/短任务/长任务/GPU计算/GPU训练，unknown 不显示）** +
  时长 + GPU 峰值/均值 + 显存峰值 + 组 CPU 峰值 + cmd；点击展开/收起。
- **控制面板（P1 新增）**：阈值输入（GPU利用%/显存%/温度°C）+ **进程排序（取前 N 进程 5..1000 + GPU/CPU/内存权重）** + 保存（即时生效+持久化）；
  暂停/恢复按钮；清除告警按钮（带 critical 计数徽标）；**实验历史管理块（#10）**：历史列表 + 单条删除 + 清空（保留最近 N）+
  即时反馈（下一轮快照自动刷新）；显示当前轮询周期（如 `轮询 5s`，随 `pollMs` 实时变化）。
- **进程表（V2.7 增强）**：`▸ 进程（来源）· 共 N · 显示前N · 监控 M`——按语义组（浏览器/编辑器/Docker/系统/虚拟机/常用应用/其他）折叠，
  组内**家族聚合**（如 `Windows 系统 ×167` → `svchost.exe ×101` → PID 明细 三级折叠，`PROC_FAMILIES` 映射 + 采样自曝进程已过滤）。
- **告警区**：分级列表（CRITICAL 高亮）+ 建议动作 + 多维徽标（severity★/urgency↑/trend/升级标记/notifyLevel）；顶栏 badge = CRITICAL 计数。
- **标签分组卡片**：进程型（资源占用）与实验型（状态/时长）分组展示。
- 轮询 5s 默认，失败自动退避（5s→10s→30s），恢复后回到 `pollMs` 档位；面板不可见时 30s 低频保活（badge 仍更新）。

## 3. 阈值与告警语义

| 阈值 | 默认 | 含义 | 触发规则 |
|---|---|---|---|
| `utilWarn` | 85 | GPU 利用率 | 低利用率告警（imbalance 分摊判断） |
| `memWarn` | 95 | 显存占用 % | 达阈值 + 实验活跃 → `oom` critical；无实验 → `other-occupancy` info（不误报） |
| `tempWarn` | 90 | 温度 °C | `thermal` 告警 |
| `pollMs` | 5000 | UI 轮询周期（1000–60000） | 经快照 `thresholds` 动态驱动，无需改配置重启 |

- 告警防重：同类规则 5 分钟窗口内不重复计数。
- 告警生命周期：TTL 24h 自动过期（badge/count 同步回落）；`lab_ctl clear-alerts` 可手动全清/定向清。
- `alertsCriticalCount` = host 预算的 CRITICAL 计数（徽标直读）。
- **严格分级（M1/issue#5 新增）**：告警不再只有 level 一维——每条告警附带 `severity(1-5)/urgency(1-3)/trend/sustainedMs/resource/origin` 扩展字段（`lab_status`/`lab_advice` 可见，面板告警行显示 S/U/趋势/升级徽标）；`warn` 持续超 `escalateAfterSec`（默认 600s，可配）→ 通知按 critical 处理（不改 level 本身，消费端零破坏）。
- **通知引擎（M1 新增）**：告警发生时按「有效级别 × 归属 × **实验类型（M2）**」计算通知档位，向 DSH Agent 投递一条 user 消息（`form:'notice'`）：
  - `alertNotify=notice`（默认）：推送但不唤醒（Agent 空闲时排队，提问时可见）；
  - `alertNotify=wake`：critical 告警唤醒 Agent 处理；
  - `alertNotify=off`：仅 UI/工具可见（info/off 档一律不投递，V2.9 实测修复）。
  - **类型矩阵（M2）**：告警关联实验 runId → run.type → 档位（`experimentTypes[].notify` 配置覆盖 > 出厂矩阵
    `EXP_TYPE_DEFAULT_NOTIFY` > 全局 fallback）。出厂要点：`gpu-train` critical/warn 均 `wake`（显存危机立即处置）、
    `smoke` warn 为 `off`（快速失败不打扰）、`full/long` critical 为 `wake`（长跑关键节点才唤醒）、`unknown` 走全局 fallback。
  - **目标路由（M3）**：告警 runId → 发起 agent（pre-execute 记录 exec.agent）——发起者为子代理时通知发起者（按矩阵档位）
    + 根祖先链并行知情（notice）；实验 crashed → 子代理降 notice + **根代理 wake 接管**；发起者 absent/disposed → **立即升根 roots()**；
    无实验上下文 → roots()。
  - **消息链兜底（M3）**：仅链断裂证据触发——子代理异常结算（subagent/end stopReason∈{max-tokens,error,cancelled} 且有在途实验）
    → roots 升根；wake 档投递子代理后 `notifyTimeoutMs`（默认 10min）内无 inbox/claimed（未领取）→ 超时升根。
  - 护栏：聚合窗口（默认 60s 同目标 ≤1 条）+ 指纹去重（同告警不重复）+ 投递预算（同告警×同目标 ≤2）；兜底：**无 agents 服务时自动降级**（仅 console 记录，工具不受影响，KV 缓存零影响——通知是历史尾部 user 消息）。
  - 配置：`lab_ctl set-notify` / 设置页「通知策略」卡 / settings.yaml `lab-monitor` 段（`alertNotify/alertTargets/notifyThrottleMs/escalateAfterSec/notifyTimeoutMs/broadcast` + M2 `experimentTypes/expTypeDefault/expTypeLearning` + M3 `subagentPolicy`）。

## 4. 实验跟踪语义（多轨）

- **识别**：`tools/pre-execute` 钩子命中训练类命令（python/训练脚本等）→ 建 run；`tools/result` 配对回收。
- **类型识别（M2）**：start 时三层识别（配置规则 `experimentTypes` > 自动正则 8 类 > fingerprint 历史时长 p90 ≥1h → long > unknown 不猜）；
  类型随快照/历史透出（面板徽标、通知矩阵输入）。
- **多轨**：并行实验各自独立跟踪（runId 归属，pid 重关联），上限 4——满 4 时新 start 将最旧归档为 `aborted`。
- **结束判定**：配对 result + 进程消失 → `done`；进程消失 ≥2 个 ps 周期（10s）→ `crashed`（触发 experiment-crash 告警）。
- **复盘**：每次结束即生成摘要（GPU 峰值/均值、显存峰值、组 CPU/内存峰值、时长）存入 `ended[]`，面板"实验历史"可查。

## 5. watchlist 与标签

- **watchlist**：`lab_ctl watch` 维护关键词列表（cmdline 子串匹配），持久化；命中进程在进程表**置顶**显示（V2.4 修复：不再被 15 行截断切掉）。
- **标签分组**：规则式（cmdline 正则）或 pid 快速打标 → 命中分组聚合展示资源占用；`kind=experiment` 组附归属实验。
  - 脚本形态天然覆盖：`ps/tasklist` 看到的是解释器进程，脚本路径在 cmdline（`python E:\exp\train.py`、`powershell -File deploy.ps1` 均按 cmdline 特征命中）。

## 6. 持久化与配置文件

- 插件配置**一律在包外**（遵守全局 RULES §1.1）：
  - **settings.yaml**（`$DSH_HOME/settings.yaml`，命名空间 `lab-monitor`）：`thresholds`、`watchProcs`、`tags`、`history`（实验历史，V2.6，含 type/fingerprint 投影 V2.8）+ **通知策略键**（`alertNotify/alertTargets/notifyThrottleMs/escalateAfterSec/notifyTimeoutMs/broadcast`，M1）+ **实验类型键**（`experimentTypes/expTypeDefault/expTypeLearning`，M2）+ **子代理权限**（`subagentPolicy`，M3）持久化；
    运行时经 `lab_ctl` / 面板修改会自动写回，**无需手改**；如需手工预设，按同名键书写即可（启动时读取、运行时双向同步）。
  - 行级配置（如依次叠加的 patch）：profile 的 `cordis.patch.yml` 或 `$DSH_HOME/cordis.patch.yml` 中
    `lab-monitor` 行的 `config` 字段（见 docs/config-catalog.zh.md 对应条目）。
- 采样周期：GPU 2s / 进程表 5s / 历史降采样 ≤500 点——均为引擎内部常量，无需配置。

## 7. HTTP 数据面（进阶/对接用）

- `POST /lab-monitor/api/snapshot|history|setThresholds|control|advice|tag|watch|historyManage`（webServer 注册时；
  `watch`/`historyManage` 为 V2.7/#10 新增路由）。
- 与 `lab_status`/`lab_ctl` 同一数据源、同一契约（docs/reference/protocol.md 1.4）；`control` 与 `setThresholds` 与工具通道一致生效并持久化。
- ⚠️ 该 HTTP 面**无鉴权**——**V2.6 实测**：Tailscale IP（100.64.0.2:13080）访问 `/lab-monitor/api/*` 超时不可达（`--trusted-host` 未暴露该端口），**当前暴露面 = localhost only**；若未来配置端口转发/SSE 开放，需先加鉴权（防御性 backlog）。

## 8. 变更记录

| 版本 | 内容 |
|---|---|
| V2.4（2026-08-22） | brief 摘要修复；告警生命周期（TTL/clear-alerts/截断计数修正）；watch 置顶 |
| V2.5（2026-08-22） | P1：实验历史 `ended[]` + 面板历史折叠块；设置面（阈值/暂停/清除告警 + pollMs 驱动）；本使用文档 |
| V2.6（2026-08-22） | P2：实验历史持久化（settings `history` 键，重启恢复，上限 20）；HTTP 暴露面实证（Tailscale 实际不可达 → localhost only） |
| V2.7（2026-08-24） | 进程展示增强：采样自曝过滤（tasklist/nvidia-smi + 伴随 conhost）+ 组内 cmd 聚合 + 家族归类三级折叠（PROC_FAMILIES ~90 条）+ 系统组正则补全 + procTopN 上限 1000 |
| V2.8（2026-08-24） | #10 实验历史管理（rpcHistoryManage + lab_ctl history-manage + 设置页管理块）；M2 实验类型识别（三层识别 + 数据面 type/fingerprint + 配置三键 + 通知矩阵接线 + 类型徽标） |
| V2.9（2026-08-24） | M3 通知链路闭环（#7）：发起者路由决策树 + subagentPolicy 权限（guard/lab_status_ro）+ 消息链兜底（异常结算/未领取升根）；修复 makeRunId 重启重复 + off 档误投递 |