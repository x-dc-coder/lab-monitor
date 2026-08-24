# 03 协议契约（host.call RPC / Agent 工具 / 事件信封）

> 来源：实施计划 v1.3 §3.1（rpc.js/tools.js）+ M3 + t6 + **v1.4（采样后端抽象：platform/sources 字段）**。**本文件为冻结版契约**（计划 §8 交付物 2）——D-A（采样器）与 D-B1（出口层）并行开发共同依赖，变更须经计划修订流程。

## 1. 版本与变更规则

- 契约版本：`lab-protocol/1.2`（v1.4：+platform/sources，指标命名规范化；**1.2：进程级跟踪（2026-08-20）**——`procs[].ppid/gpuUtilPct`、`experiment.procGroup/groupStats`、`snapshot.system`、`alerts[].evidence`、`history[].groupCpu/groupMem`；**纯增量追加字段，老 client 照常工作**；**1.3（2026-08-20，A2 多轨+标签）：新增 `experiments[]`（全部并行实验，`experiment` 保留为主实验）、`tags[]`（标签分组聚合）——继续纯增量追加**；**1.4（2026-08-22，P1 复盘+设置面）：新增 `ended[]`（已结束实验历史投影，上限 20）、`thresholds`（当前生效阈值，client 轮询周期由 `pollMs` 驱动）、`enabled`（监控引擎启停状态）——继续纯增量追加**）；
- JSON schema 追加字段向后兼容；**删除/改型字段 = 破坏性变更**，须先更新本文件与计划，再通知 D-A/D-B1；
- 所有载荷为**纯 JSON**（host.call 只驮 JSON；函数/undefined/类实例会被 codec 拒收，t5 结论②）。

## 2. host.call RPC 方法（Host 半 harness.handle 注册）

### 2.1 `labMonitor.snapshot` —— 最近快照（Client 轮询主通道）

**请求**：

```json
{
  "thresholds": { "utilWarn": 90, "memWarn": 95, "tempWarn": 85, "pollMs": 5000 }
}
```

- `thresholds` **可选**；携带值视作「**建议更新**」——仅当到达时间晚于 host 生效时间戳才覆盖（M3，见 docs/reference/data-model.md §6）；不携带则 host 用当前持有值。

**响应**（字段全部必填，值为 null 时表示不可用；v1.4：新增 `platform`/`sources`，指标命名规范化，mem 单位 MiB；**1.2：新增 `procs[].ppid/gpuUtilPct`、`experiment.procGroup/groupStats`、`snapshot.system`、`alerts[].evidence`**）：

```json
{
  "ts": 1787030000000,
  "platform": "wsl",
  "sources": { "gpu": "dmon", "cpu": "cim", "mem": "cim", "procs": "tasklist+pmon" },
  "gpu": [
    { "id": 0, "name": "NVIDIA GeForce RTX 5060 Ti", "utilPct": 92, "memUsedMiB": 19200,
      "memTotalMiB": 24576, "tempC": 78, "powerW": 350, "degraded": false }
  ],
  "gpuState": "ok | unavailable",
  "cpu": { "percent": 340, "cores": 8 },
  "mem": { "totalMiB": 14310, "availableMiB": 6297 },
  "procs": [ { "pid": 1234, "cmd": "python train_demo.py", "gpu": 87, "ppid": 1200, "gpuUtilPct": 87, "gpuMemMiB": null } ],
  "system": { "cpuPct": 12, "memMiB": 8500, "gpuUtilPct": null, "topN": [ { "pid": 9999, "cmd": "chrome.exe", "cpuPct": null, "memMiB": 1024, "gpuUtilPct": null } ] },
  "alerts": [ { "level": "critical", "rule": "oom", "msg": "整卡显存 98% 达阈值；实验进程组活跃（1 进程，CPU -%，内存 2930MiB）",
                "confidence": 0.85, "actions": ["降低 batch size", "检查实验进程内存占用"],
                "evidence": { "procs": [ { "pid": 1234, "cmd": "python train_demo.py", "cpuPct": null, "memMiB": 2930, "gpuUtilPct": 87 } ] },
                "ts": 1787030005000, "runId": "run-20260818-001" } ],
  "alertsCriticalCount": 1,
  "experiment": { "runId": "run-20260818-001", "state": "running", "cmd": "python train_demo.py",
                  "pid": 1234, "procGroup": [1234, 5678], "groupStats": { "cpuPct": null, "memMiB": 2938, "memberCount": 2, "alive": true, "gpuUtilPct": null, "gpuMemMiB": null, "members": [] },
                  "startTs": 1787030000000, "summary": null },
  "experiments": [ { "runId": "run-20260818-002", "state": "running", "cmd": "python train_b.py", "pid": 5679, "startTs": 1787030006000 } ],
  "ended": [ { "runId": "run-20260818-000", "state": "done", "cmd": "python train_batch.py", "cmdFeature": "python",
               "startTs": 1787029990000, "endTs": 1787030000000,
               "summary": { "gpuUtilMax": 95, "gpuUtilAvg": 80, "memPeakMiB": 12800, "groupCpuMax": 400,
                            "groupMemPeakMiB": 13000, "otherMemPeakMiB": 400, "durationSec": 10, "dataPartial": false } } ],
  "thresholds": { "utilWarn": 85, "memWarn": 95, "tempWarn": 90, "pollMs": 5000 },
  "enabled": true,
  "tags": [ { "rule": { "id": "tag-20260820-001", "label": "推理服务", "patterns": ["llama-server"], "kind": "process", "color": "#16a34a" },
              "pids": [5555], "procs": [ { "pid": 5555, "cmd": "llama-server", "cpuPct": null, "memMiB": 50000, "gpuUtilPct": 45 } ],
              "gpuUtilPct": 45, "cpuPct": null, "memMiB": 50000 } ],
  "callCount": 42,
  "ui": { "betterSidebarVisible": true }
}
```

| 字段 | 说明 |
|---|---|
| `ts` | 快照生成时间（epoch ms） |
| `platform` | **`'linux' \| 'wsl' \| 'windows-native'`（v1.4）**——采样视角平台；**WSL 与 Windows 内存视图语义不同**（WSL 14.3GB vs Windows 31.7GB，实证 docs/research/08-sampling-empirical.md），消费方必须据此解释 mem 字段 |
| `sources` | **（v1.4/1.2）各指标来源通道**：`gpu: 'dmon'\|'query'\|'unavailable'`、`cpu/mem: 'procfs'\|'cim'`、`procs: 'ps'\|'tasklist'\|'ps+pmon'\|'tasklist+pmon'\|'pmon'`（**1.2：+pmon 后缀**，pmon 可用时标注每进程 GPU 利用率来源）——差分 vs 瞬时语义标注 |
| `gpu[]` | 每卡 { id, name?, utilPct, memUsedMiB, memTotalMiB, tempC?, powerW? }——**指标命名规范化（v1.4）**，通道差异封死在 sampler 后端内；`degraded`（T1-4 dmon 降级标记）随 gpu[] 携带 |
| `gpuState` | `'ok'` / `'unavailable'`（probe 失败 / 无 nvidia-smi.exe） |
| `cpu` | { percent, cores? }（多核归一，差分或 CIM 瞬时由 sources 标注）；`mem` { totalMiB, availableMiB }（**单位 MiB，v1.4**） |
| `procs[]` | 进程表（ps 或 tasklist，5s 快照；**1.2：`ppid` 进程树骨架、`gpuUtilPct` 每进程 GPU 利用率（pmon 辅助证据，仅活动进程有值）、`gpuMemMiB` 预留恒 null**；`gpu` 遗留字段语义定稿 = GPU 利用率 %） |
| `system` | **（1.2）非实验组统计**：`{ cpuPct, memMiB, gpuUtilPct, gpuMemMiB(预留), topN[5] }`——系统其他进程聚合（实验成员按 pid 差集排除） |
| `alerts[]` | 最近告警列表（含分级/规则/建议动作；**1.2：`evidence.procs[]` 进程级证据，CPU/内存为主、GPU 每进程辅助**） |
| `alertsCriticalCount` | **host 预算的 CRITICAL 计数**（badge 直读，T2-2） |
| `experiment` | 主实验（= 最近 start 的 running run，状态机输出；idle 时为 null） |
| `experiments` | **（1.3，A2 多轨）全部 running 实验数组**——`experiment` 保留为主实验（向后兼容），本字段承载并行实验（多轨上限 4） |
| `ended` | **（1.4，P1 复盘）已结束实验历史投影**——`{ runId, state: 'done'\|'crashed'\|'aborted', cmd, cmdFeature, startTs, endTs, summary }`；最新在前、上限 20；`summary` 为归档时生成的指标摘要（GPU 利用率峰值/均值、显存峰值、组 CPU/内存峰值、时长等），采样不足时为 null；client 实验历史折叠块直读本字段 |
| `thresholds` | **（1.4，P1 设置面）当前生效阈值**——`{ utilWarn, memWarn, tempWarn, pollMs }`；与 `setThresholds`/`lab_ctl set-threshold`/settings.yaml 三通道一致（持久化在 settings 命名空间 lab-monitor）；**client 轮询周期由 `pollMs` 动态驱动**（范围 1000–60000ms） |
| `enabled` | **（1.4，P1 设置面）监控引擎启停状态**——`true`=运行 / `false`=暂停（`control` 的 `pause`/`resume` 切换；暂停时跳过采样但快照照常返回）；client 控制面板据此显示「监控运行中/已暂停」 |
| `tags` | **（1.3，标签分组）用户标签规则命中聚合数组**——`{ rule: {id,label,patterns,kind,color}, pids[], procs[], gpuUtilPct, cpuPct, memMiB, runIds? }`；`kind=experiment` 时 `runIds` 附归属实验；匹配 cmdline 正则（脚本形态天然覆盖） |
| `callCount` | **host 侧 RPC 调用计数器**（P0 验收 2 断言手段，T4-2） |
| `ui.betterSidebarVisible` | **host 半经 `settings.describe` 探测 aionui-panel 互斥标志**（`aionui-panel.rightPanel === 'aionui-panel'` → false；t6 §3.2 判据）+ 监听 `settings/updated` 实时刷新；出口适配层据此决定 ②/③ 切换（t6 §4 规避方案 1/2） |

### 2.2 `labMonitor.history` —— 降采样历史

- 请求：`{ sinceMs: number, bucketMs: number }`
- 响应：`{ points: [{ ts, gpuUtil, gpuMem, cpu, memUsed, groupCpu, groupMem }], truncated: boolean }`（≤500 点；**1.2：`groupCpu/groupMem` 实验进程组 CPU/内存（5s 周期聚合，无实验时 null）**）

### 2.3 `labMonitor.setThresholds` —— 直连更新阈值

- 请求：`{ utilWarn, memWarn, tempWarn, pollMs }`（全字段或子集）
- 响应：`{ ok: true, applied: { utilWarn, memWarn, tempWarn, pollMs } }`
- 语义：**直连更新通道**——即时生效并更新 host 生效时间戳；与请求携带冲突时以时间戳后者为准（M3）。

### 2.4 `labMonitor.control` —— 监控引擎启停

- 请求：`{ action: 'start' | 'pause' | 'resume' }`
- 响应：`{ ok: true, state: 'running' | 'paused' }`
- **护栏（T2-5）**：仅控制监控/告警引擎，**绝不触碰实验进程**。

## 3. Agent 工具契约（harness.defineTool）

### 3.1 `lab_status` —— Agent 友好快照

- 输入：`{}`（可选 `{ brief: true }` 取一行摘要）
- 输出（JSON）：同 `labMonitor.snapshot` 响应结构；`brief: true` 时输出字符串：
  `"GPU0 92% · 20.1/24G · CPU 340% · 实验 run-... (running 12min) · 实验组 45%CPU/3.2G · 5 进程 · 他占 chrome.exe 1G · 告警: 无"`
  （**1.2：摘要增加实验组 CPU/内存/进程数与系统其他进程 Top 占卡提示**）

### 3.2 `lab_advice` —— 平衡引擎建议

- 输入：`{}`
- 输出：`{ advice: [{ level, rule, msg, confidence, actions[], evidence? }], generatedAt }`（无告警时 `advice: []`；**1.2：`evidence.procs[]` 进程级证据**）

### 3.3 `lab_ctl` —— 启停/阈值控制（可选，护栏 T2-5）

- 输入：`{ action: 'start'|'pause'|'resume'|'set-threshold', thresholds? }`
- 输出：`{ ok, state? , applied? }`
- 护栏：仅监控/告警引擎启停，**绝不碰实验进程**；写操作工具描述明示风险；pause 类限 UI 或 approval/request 确认。

## 4. `lab/*` 事件信封（ctx.emit / ctx.on，同会话插件行订阅）

统一信封（t1 启示 6）：

```json
{
  "type": "lab/experiment-start | lab/experiment-end | lab/alert | lab/status-flip",
  "ts": 1787030000000,
  "runId": "run-20260818-001",
  "data": {}
}
```

| 事件 | data 内容 |
|---|---|
| `lab/experiment-start` | `{ cmd, cmdFeature, startTs, type, expTypeLayer, agentId, agentRole }`（M2/M3 增补） |
| `lab/experiment-end` | `{ state: 'done'\|'crashed'\|'aborted', endTs, summary, type, agentId }`（#11 补全，2026-08-24） |
| `lab/alert` | `{ level, rule, msg, confidence, actions[], severity, urgency, trend, sustainedMs, resource, origin }`（M1 扩展字段） |
| `lab/status-flip` | `{ enabled }`（#11：pause/resume 状态翻转，2026-08-24） |

## 4.1 SSE 远端事件流（#11，2026-08-24 新增）

`GET /lab-monitor/events`（SSE/EventSource 长连接，localhost only；与 `/lab-monitor/api/*` JSON 拉取互补）：

- 响应头：`Content-Type: text/event-stream` / `Cache-Control: no-cache` / `Connection: keep-alive` / `X-Accel-Buffering: no`
- 事件格式：`event: <name>\ndata: <json>\n\n`（`<name>` = lab/ 后缀，如 `experiment-start`；data 含 `{ts, runId, ...}` 与 §4 对齐）
- 心跳：15s `: ping` 保活；连接 close 自动清理
- 回放：新连接先推最近 20 条事件缓冲（订阅者连上即有上下文）
- 鉴权：当前 localhost only（known-issues #6）；开放端口转发需先加鉴权（backlog）

## 5. 出口层消费约束

- 出口适配器只消费 §2 RPC 与 §4 事件（核心↔出口解耦契约，docs/architecture/core.md §4）；
- badge/title/label thunk 只读**模块级 `last` 快照**（O(1)），禁止在 thunk 内发 host.call（t5 结论②3）。

## 6. 关联文档

- 字段语义与仲裁规则：`docs/reference/data-model.md`
- 出口层消费姿势：`docs/architecture/ui-adapters.md`
- 架构总览：`docs/architecture/core.md`

---

## V2（正式插件形态，2026-08-20）

- 本文件内容在 V2 保持不变（数据模型/协议/验收语义与形态无关）。
- V2 差异：client 数据面由 `host.call('labMonitor.*')` 改为 **HTTP `/lab-monitor/api/*`**（协议字段不变）；工具注册走官方 `ctx.tools.register(defineTool(...))`；prompt 注入默认关闭（KV 缓存友好，`lab_status` 工具替代）。
- 完整迁移设计：`docs/research/12-v2-migration.md`；架构差异：`docs/architecture/core.md` §8-11。

## 1.2 变更记录（进程级跟踪，2026-08-20）

- **版本**：`lab-protocol/1.1` → `1.2`（纯增量，向后兼容）。
- **新增字段**：`procs[].ppid`（进程树骨架；Windows 来自 CIM Win32_Process，Linux 来自 ps ppid 列）、
  `procs[].gpuUtilPct`（pmon 每进程 GPU 利用率，辅助证据，仅活动进程有值）、`procs[].gpuMemMiB`（预留恒 null，
  本机 compute-apps 受 WDDM 限制全 [N/A] 不启用）、`experiment.procGroup[]`（实验进程组 pid 集合）、
  `experiment.groupStats`（实验组聚合：cpuPct/memMiB/memberCount/alive/gpuUtilPct）、`snapshot.system`（非实验组统计：
  cpuPct/memMiB/gpuUtilPct/topN[5]）、`alerts[].evidence.procs[]`（进程级证据）、`history[].groupCpu/groupMem`（实验组曲线）。
- **`sources.procs` 枚举扩展**：`'ps' | 'tasklist' | 'ps+pmon' | 'tasklist+pmon' | 'pmon'`（pmon 可用时标注）。
- **语义澄清**：`procs[].gpu`（v1.1 遗留字段）定稿 = GPU 利用率 %（与 gpuUtilPct 同值）。
- **告警规则（Phase C，归属仲裁）**：oom 三分支（实验组活跃 → critical / 实验组不活跃 → 降级 warn「疑似他人占用」/ 无实验 → other-occupancy info）；io-bottleneck 以实验组 CPU 判据为主、Windows 降级整机并标注；thermal 消息携带实验组活跃度上下文。
- **设计文档**：`docs/research/14-process-tracking-design.md`（§5 分阶段清单）。
