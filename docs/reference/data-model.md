# 02 数据模型（指标枚举 / 快照 / 状态机 / 阈值事实来源）

> 来源：实施计划 v1.3 §3.1 + 各评审闭合项（T1-1/T1-2/R-2/R-3/V2/M3）。本文档**先行定稿**（计划 §8 交付物 1），是 D-A/D-C 实现的数据契约。

## 1. 指标常量枚举（防脏数据）

metric 名收敛为常量表 + 白名单校验（借鉴 monitor-panel，t2 §1）：

```js
const METRICS = {
  GPU_UTIL:   'gpu.util',     // 百分比 0-100
  GPU_MEM:    'gpu.mem',      // { used, total } 字节
  GPU_TEMP:   'gpu.temp',     // 摄氏度
  GPU_POWER:  'gpu.power',    // 瓦
  CPU_PCT:    'cpu.pct',      // 百分比（多核归一）
  MEM_USED:   'mem.used',     // 字节
  MEM_TOTAL:  'mem.total',    // 字节
}
```

## 2. 快照与采样点数据模型

### 2.1 采样点（collector 输出 → ring buffer 元素）

```json
{
  "ts": 1787030000000,
  "gpu": [
    { "id": 0, "util": 92, "memUsed": 20132659200, "memTotal": 25769803776,
      "temp": 78, "power": 350, "degraded": false }
  ],
  "cpu": 340,
  "mem": { "used": 17179869184, "total": 34359738368 },
  "procs": [ { "pid": 1234, "cmd": "python train_demo.py", "gpu": 0 } ]
}
```

- `gpu[].degraded`：dmon 流中断回退 query-gpu 快照模式时为 `true`（T1-4）；
- GPU 不可用（无 nvidia-smi）：`gpu` 数组为空 + `gpuState: 'unavailable'`（P0 验收 3）。

### 2.2 ring buffer（环形缓冲）

| 项 | 规则 |
|---|---|
| 容量 | **双条件封顶**：≤1000 点 且 ≤30 分钟（2s 采样 ≈ 900 点，~2MB 上限） |
| 查询 | `history(sinceMs, bucketMs)`：按桶降采样（monitor-panel 策略）→ 图表数据（≤500 点渲染） |
| **长实验扩容（R-3）** | 实验 running 期间按需扩容（容量翻倍至 2h）**或**摘要只覆盖最近 30min 并标注「部分数据」——二选一，实现时在 docs/reference/milestones.md 记录取舍 |

## 3. 状态机转移表（state-machine.js）

### 3.1 状态与转移

```
idle ──(start 命中)──► running ──(配对 result + 进程消失)──► done
  ▲                      │  │
  └──────────────────────┤  └──(pid 消失 ≥2 ps 周期且无配对 result)──► crashed
                         └──(平衡引擎 critical)──► alerting ──(恢复)──► running
2026-08-20（A2 多轨）：running 期间新 start 命中 ──► 并行跟踪（上限 MAX_PARALLEL_RUNS=4）
  并行满 4 时 ──► 最旧 running 归档 aborted（v1 的「新 start 即归档旧 run」已废弃）
```

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `idle` | 无实验 | 初始 / 全部实验结束归档后 |
| `running` | 实验执行中 | ① start 命中（见 3.2） |
| `done` | 正常结束 | ③ 配对 result + 进程消失**双确认**（见 3.3） |
| `crashed` | 异常退出 | ④ pid 消失（连续 ≥2 个 ps 周期 = 10~15s 无存活）且无配对 result |
| `alerting` | 告警中 | 平衡引擎触发 critical 时置位，恢复后回 running |
| `aborted` | 被顶替归档 | 并行达到上限 4 时最旧 running 被新 start 顶替归档 |

### 3.2 start 判定与 pid 关联链路（T1-1）

1. **start（pre-execute 命中）**：关键词表含 `python train*.py` / `python -c` / `python3 -c` / `torchrun` / `deepspeed` / `python -m`（T4-1）→ 记 `{ runId, cmd特征, startTs, baseline }`（**此刻无 pid**，T1-1）；
2. **pid 关联（完整链路）**：
   - 首选：`tools/execute`（执行时事件）回传句柄/pid；
   - 否则：ps 快照（5s）按「cmdline 含命令特征 且 startTs 之后出现」关联回填；
   - **关联失败降级**：running 且「ps 连续 ≥3 个采样间隔（15s）观测到无候选进程 且无配对 result」→ 超时判 crashed。

### 3.3 done 判定与 tools/result 配对（T1-2）

- **配对校验**：tools/result 必须「工具名 = bash 且命令串含 runId 特征」（或平台调用 ID 配对）才接受，**不匹配的 result 忽略**（实验 running 期间 Agent 执行 ls/curl/kill 等任意工具的 result 均不触发 done）；
- **双确认**：done 需「配对命中 且 实验进程已消失」；否则按异常结束处理；
- **kill 不误判 done**：kill 实验进程走 crashed 路径——kill 自身的 result 因不配对被忽略（P1 验收 1 成立前提）；
- 规则定稿进本文件（§3.3），实现时 hooks.js/state-machine.js 按此编码。

### 3.4 多轨并行跟踪（A2，2026-08-20 实施）

- **v1（单实验跟踪）**：running 期间新 start 命中 → 旧 run 自动归档 `aborted`，**无双 running 并存**（P1 验收 7 旧语义）；
- **v2（多轨，2026-08-20）**：`state.runs: Map<runId, RunRecord>` 并行跟踪，**并行上限 `MAX_PARALLEL_RUNS=4`**——满 4 时新 start 归档**最旧** running 为 aborted；
- **per-run 独立判定**：`pidMissingStreak` 移入 RunRecord，每个 running run 各自 findAliveProc + BFS 组扩张 + done/crashed 双确认，互不干扰；
- **result 归属**：`markResult(paired, runId?)`——runId 精确归属优先；无 runId 时按 cmd 指纹匹配主实验（cur = 最近 start 的 running）；
- **主实验语义**：`cur()` 返回最近 start 的 running run（向后兼容 `experimentActive`/`experiment` 单对象字段）；
- **追踪主键**：runId（每次 start 新 runId）+ cmdline 指纹（pid 为关联结果，重启自动重关联）。

## 4. 实验记录（run 记录数组）

```json
{
  "runId": "run-20260818-001",
  "cmd": "python train_demo.py --epochs 10",
  "cmdFeature": "python train*.py",
  "pid": 1234,
  "gpuAlloc": [0],
  "startTs": 1787030000000,
  "endTs": 1787033600000,
  "endReason": "done | crashed | aborted | timeout",
  "summary": { "gpuUtilMax": 95, "gpuUtilAvg": 72, "memPeak": 21474836480, "durationSec": 3600,
               "dataPartial": true }
}
```

- `summary.dataPartial`：长实验超过 ring buffer 窗口（>30min）时标注「部分数据」（R-3）。
- **V2.8/V2.9 字段增补**（`src/core/types.ts` 事实源）：
  - `RunRecord` 增：`type?`（实验类型 8 类枚举：smoke/regression/full/short/long/gpu-calc/gpu-train/unknown，M2 start 时三层识别）、
    `agentId?`（发起 agent session.id，M3 pre-execute 读 exec.agent）、`agentRole?`（root/subagent）、`parentId?`（子代理父会话）；
  - `ExperimentSnapshot` / `EndedRunSnapshot` 同字段透出 + `EndedRunSnapshot.fingerprint?`（命令指纹，学习层历史归类/持久化恢复用）；
  - `runId` 格式：`run-YYYYMMDD-HHMMSS-NNN`（V2.9 修复，含秒级时间戳防重启重复）。

## 5. 告警分级与防抖

| 级别 | 语义 | 触发 |
|---|---|---|
| INFO | 提示 | 状态变化等 |
| WARN | 需关注 | 阈值接近 |
| CRITICAL | 必须处理 | 阈值持续超限 |

- **防抖**：阈值需**持续 10s** 才触发（Prometheus `for:`）；同类告警**最小间隔 5 分钟**（W&B wait_duration）；
- 告警对象：`{ level, rule, msg, confidence, actions[], ts, runId? }`；
- host 预算 `alertsCriticalCount`（CRITICAL 计数，badge 直读，99+ 封顶由 UI 层处理）。
- **V2.8/M1 扩展字段**（全部可选，旧消费者零感知）：`severity(1-5)`（rule 权重表静态映射）、`urgency(1-3)`（基准+rising+1）、
  `trend('rising'|'steady'|'falling')`（sustainedMs 窗口判定）、`sustainedMs`（2s×命中数累计）、`resource('gpu-util'|'vram'|'temp'|'cpu'|'mem'|'io'|'process')`、
  `origin('self'|'other'|'system')`（归属：实验自身/他人/系统级）、`notifyLevel('off'|'notice'|'wake')`（策略引擎输出回写）、
  `escalate`（warn 持续超 `escalateAfterSec` → 通知按 critical，不改 level 本身）。

## 6. 阈值事实来源（V2 闭合，M3 仲裁）

- **事实来源 = host 侧 `settings` 服务**：默认值与持久化都在核心层（t2 §2 实证），**不依赖任何第三方持久化**（better-sidebar 缺席/无 UI 出口时阈值照常配置与持久化）；
- better-sidebar 的 pluginSettings **仅作出口层 UI 编辑同步面**（读后携带、host 为准回写）；
- **last-write-wins 仲裁（M3，host 生效时间戳版）**：
  - host 侧记录「生效阈值 + 生效时间戳」；
  - `lab_ctl set-threshold` / `labMonitor.setThresholds` 直连写入 → **即时生效并更新时间戳**；
  - snapshot 请求携带的 `thresholds` 到达时**晚于生效时间戳才覆盖**（比纯按到达顺序更可测）；
  - balancer 一律用 host 持有值。
- 阈值默认值：`utilWarn=90`、`memWarn=95`、`tempWarn=85`、`pollMs=5000`（可配）。

## 6.1 差异化阈值分层覆盖（#13-3，2026-08-24）

- **结构**：`thresholdOverrides = { byExpType: {<类型>: {utilWarn?, memWarn?, tempWarn?}}, byTag: {<标签label>: {...}} }`
  - 持久化：`settings.yaml` → `lab-monitor.thresholdOverrides`；设置入口：client 设置页 JSON 编辑 / `lab_ctl set-threshold` 带 `thresholdOverrides`
- **覆盖链**（`resolveThresholds(w, thr, overrides)`，balancer evaluate 入口解析）：
  1. 全局阈值（`thr`，host 持有值）
  2. 主实验类型命中 `byExpType[w.experimentType]` → 覆盖（仅覆盖存在的键）
  3. 主实验 cmd 命中标签组的 `byTag[label]` → 再覆盖（标签组后级覆盖类型级）
- **采样点注入**：`SamplePoint.experimentType`（主实验类型）+ `SamplePoint.tagHits`（命中标签 label 列表）；非 ps 周期 tick 由 `machine.cur()` 实时回填
- **默认**：`overrides = {}`（空 = 不覆盖，等效全局阈值）；阈值数值由用户配置拍板（issue #13 讨论中）

## 7. 关联文档

- 模块职责：`docs/architecture/core.md`
- RPC/工具/事件契约：`docs/reference/protocol.md`
- 验收清单（状态机/阈值相关验收）：`docs/reference/milestones.md` P1 验收 1/2/7、P2 验收 1/2

---

## V2（正式插件形态，2026-08-20）

- 本文件内容在 V2 保持不变（数据模型/协议/验收语义与形态无关）。
- V2 差异：client 数据面由 `host.call('labMonitor.*')` 改为 **HTTP `/lab-monitor/api/*`**（协议字段不变）；工具注册走官方 `ctx.tools.register(defineTool(...))`；prompt 注入默认关闭（KV 缓存友好，`lab_status` 工具替代）。
- 完整迁移设计：`docs/research/12-v2-migration.md`；架构差异：`docs/architecture/core.md` §8-11。
