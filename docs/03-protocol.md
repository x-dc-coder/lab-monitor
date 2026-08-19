# 03 协议契约（host.call RPC / Agent 工具 / 事件信封）

> 来源：实施计划 v1.3 §3.1（rpc.js/tools.js）+ M3 + t6 + **v1.4（采样后端抽象：platform/sources 字段）**。**本文件为冻结版契约**（计划 §8 交付物 2）——D-A（采样器）与 D-B1（出口层）并行开发共同依赖，变更须经计划修订流程。

## 1. 版本与变更规则

- 契约版本：`lab-protocol/1.1`（v1.4：+platform/sources，指标命名规范化 utilPct/memUsedMiB/tempC/powerW，mem 单位改 MiB）；
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

- `thresholds` **可选**；携带值视作「**建议更新**」——仅当到达时间晚于 host 生效时间戳才覆盖（M3，见 docs/02-data-model.md §6）；不携带则 host 用当前持有值。

**响应**（字段全部必填，值为 null 时表示不可用；v1.4：新增 `platform`/`sources`，指标命名规范化，mem 单位 MiB）：

```json
{
  "ts": 1787030000000,
  "platform": "wsl",
  "sources": { "gpu": "dmon", "cpu": "cim", "mem": "cim", "procs": "tasklist" },
  "gpu": [
    { "id": 0, "name": "NVIDIA GeForce RTX 5060 Ti", "utilPct": 92, "memUsedMiB": 19200,
      "memTotalMiB": 24576, "tempC": 78, "powerW": 350, "degraded": false }
  ],
  "gpuState": "ok | unavailable",
  "cpu": { "percent": 340, "cores": 8 },
  "mem": { "totalMiB": 14310, "availableMiB": 6297 },
  "procs": [ { "pid": 1234, "cmd": "python train_demo.py", "gpu": 0 } ],
  "alerts": [ { "level": "critical", "rule": "oom", "msg": "显存余量 <10%",
                "confidence": 0.9, "actions": ["降 batch size"], "ts": 1787030005000, "runId": null } ],
  "alertsCriticalCount": 1,
  "experiment": { "runId": "run-20260818-001", "state": "running", "cmd": "python train_demo.py",
                  "pid": 1234, "startTs": 1787030000000, "summary": null },
  "callCount": 42,
  "ui": { "betterSidebarVisible": true }
}
```

| 字段 | 说明 |
|---|---|
| `ts` | 快照生成时间（epoch ms） |
| `platform` | **`'linux' \| 'wsl' \| 'windows-native'`（v1.4）**——采样视角平台；**WSL 与 Windows 内存视图语义不同**（WSL 14.3GB vs Windows 31.7GB，实证 docs/research/08-sampling-empirical.md），消费方必须据此解释 mem 字段 |
| `sources` | **（v1.4）各指标来源通道**：`gpu: 'dmon'\|'query'\|'unavailable'`、`cpu/mem: 'procfs'\|'cim'`、`procs: 'ps'\|'tasklist'`——差分 vs 瞬时语义标注 |
| `gpu[]` | 每卡 { id, name?, utilPct, memUsedMiB, memTotalMiB, tempC?, powerW? }——**指标命名规范化（v1.4）**，通道差异封死在 sampler 后端内；`degraded`（T1-4 dmon 降级标记）随 gpu[] 携带 |
| `gpuState` | `'ok'` / `'unavailable'`（probe 失败 / 无 nvidia-smi.exe） |
| `cpu` | { percent, cores? }（多核归一，差分或 CIM 瞬时由 sources 标注）；`mem` { totalMiB, availableMiB }（**单位 MiB，v1.4**） |
| `procs[]` | 进程表（ps 或 tasklist，5s 快照） |
| `alerts[]` | 最近告警列表（含分级/规则/建议动作） |
| `alertsCriticalCount` | **host 预算的 CRITICAL 计数**（badge 直读，T2-2） |
| `experiment` | 当前实验（状态机输出；idle 时为 null） |
| `callCount` | **host 侧 RPC 调用计数器**（P0 验收 2 断言手段，T4-2） |
| `ui.betterSidebarVisible` | **host 半经 `settings.describe` 探测 aionui-panel 互斥标志**（`aionui-panel.rightPanel === 'aionui-panel'` → false；t6 §3.2 判据）+ 监听 `settings/updated` 实时刷新；出口适配层据此决定 ②/③ 切换（t6 §4 规避方案 1/2） |

### 2.2 `labMonitor.history` —— 降采样历史

- 请求：`{ sinceMs: number, bucketMs: number }`
- 响应：`{ points: [{ ts, gpuUtil, gpuMem, cpu, memUsed }], truncated: boolean }`（≤500 点）

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
  `"GPU0 92% · 20.1/24G · CPU 340% · 实验 run-... (running 12min) · 告警: 无"`

### 3.2 `lab_advice` —— 平衡引擎建议

- 输入：`{}`
- 输出：`{ advice: [{ level, rule, msg, confidence, actions[] }], generatedAt }`（无告警时 `advice: []`）

### 3.3 `lab_ctl` —— 启停/阈值控制（可选，护栏 T2-5）

- 输入：`{ action: 'start'|'pause'|'resume'|'set-threshold', thresholds? }`
- 输出：`{ ok, state? , applied? }`
- 护栏：仅监控/告警引擎启停，**绝不碰实验进程**；写操作工具描述明示风险；pause 类限 UI 或 approval/request 确认。

## 4. `lab/*` 事件信封（ctx.emit / ctx.on，同会话插件行订阅）

统一信封（t1 启示 6）：

```json
{
  "type": "lab/experiment-start | lab/experiment-end | lab/alert",
  "ts": 1787030000000,
  "runId": "run-20260818-001",
  "data": {}
}
```

| 事件 | data 内容 |
|---|---|
| `lab/experiment-start` | `{ cmd, cmdFeature, startTs }`（无 pid，T1-1） |
| `lab/experiment-end` | `{ endReason: 'done'\|'crashed'\|'aborted'\|'timeout', summary }` |
| `lab/alert` | `{ level, rule, msg, confidence, actions[] }` |

## 5. 出口层消费约束

- 出口适配器只消费 §2 RPC 与 §4 事件（核心↔出口解耦契约，docs/01-architecture.md §4）；
- badge/title/label thunk 只读**模块级 `last` 快照**（O(1)），禁止在 thunk 内发 host.call（t5 结论②3）。

## 6. 关联文档

- 字段语义与仲裁规则：`docs/02-data-model.md`
- 出口层消费姿势：`docs/05-ui-adapters.md`
- 架构总览：`docs/01-architecture.md`

---

## V2（正式插件形态，2026-08-20）

- 本文件内容在 V2 保持不变（数据模型/协议/验收语义与形态无关）。
- V2 差异：client 数据面由 `host.call('labMonitor.*')` 改为 **HTTP `/lab-monitor/api/*`**（协议字段不变）；工具注册走官方 `ctx.tools.register(defineTool(...))`；prompt 注入默认关闭（KV 缓存友好，`lab_status` 工具替代）。
- 完整迁移设计：`docs/research/12-v2-migration.md`；架构差异：`docs/01-architecture.md` §8-11。
