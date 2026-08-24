# 10 Lab Monitor P1 端到端测试方案与记录（P1「能懂」会话内实证）

> **归档注记（2026-08-20 清理）**：本文所述 v1.4.5 MVP 资产（`plugin/` 动态版、`scripts/dev-run.sh`）已归档至 `docs/archive/v1.4.5-plugin/`。

> 状态：**执行完成（2026-08-19，队长执行）**。执行载体：`scripts/e2e-host.js`——与 verify-host 相同的
> D4-1 concat 真实代码求值，但 shell 换真实 child_process（真实 python3 进程 / 真实 kill / 真实 ps），
> timer 用真实时钟。**端到端差异仅在 hooks 由脚本派发事件而非 cordis 事件总线；状态机/采样/告警逻辑
> 与 cordis 会话内完全一致（同一份 plugin/host/index.js 代码）**。
> 目的：补齐 P1 验收 1/2 的**会话内端到端实证**——状态机真实生命周期
> （pre-execute 命中 → running → pid 关联 → 正常 done / kill → crashed + CRITICAL 告警），
> 并复核 7'（并发单跟踪）与 5'（平衡引擎构造触发）。
> 前置事实：P1 4'（prompt 注入）、5'（thermal/oom/io 构造）、7'（并发 aborted）已由集成工程师
> 于 2026-08-19 会话内回填（见 docs/reference/milestones.md）。

## 0. 执行环境与观测手段

- 插件：`labm-1`（v1.4.4）running，`cordis_inspect_self(labm-1, pkg-*)` 无 diagnostics；
- 观测手段 A（工具）：Agent 调 `lab_status` → JSON 快照 `experiment` 字段（running/done/crashed/aborted）；
- 观测手段 B（告警）：`lab_status` → `alerts[]` 与 `alertsCriticalCount`；
- 观测手段 C（钩子日志）：GUI 会话终端/日志中 `[lab-monitor]` console 行（emit 自观测，P1 6）；
- 命令命中判定（T4-1 关键词表）：`python3 /tmp/train_demo.py`（含 train*.py ✓）。

## 1. T1：正常结束 → done（P1 2 会话内实证）

**步骤**：
1. 后台起短训练：`bash -c "python3 /tmp/train_demo.py &"` 或直接执行 `python3 /tmp/train_demo.py`
   （demo 现为 sleep 300，为测正常结束需**短版**：临时改成 `time.sleep(15)` 或直接跑 `python3 -c "import time; time.sleep(12)"`
   —— `python3 -c` 命中「python -c」模式，fingerprint=pyc:hash，T1-1 链路②）；
2. 立即（<5s）调 `lab_status` → 断言 `experiment.state === 'running'`、`experiment.cmd` 记录、`pid` 非空（ps 关联）；
3. 等 12~20s（进程结束）→ 再调 `lab_status` → 断言 `experiment` 状态收敛：**done**（配对 result + 进程消失双确认），
   history 中出现该 run 的 summary（gpuUtilMax/avg/memPeak/durationSec/dataPartial）。

**预期**：`running → done` 全链路 ≤ 20s；`alertsCriticalCount` 不增（正常结束无告警）。

## 2. T2：kill → crashed + CRITICAL（P1 1 会话内实证）

**步骤**：
1. 起长训练：`python3 /tmp/train_demo.py`（sleep 300，命中 train*.py）；
2. 调 `lab_status` → 断言 running + pid（记下 pid）；
3. `kill <pid>`（Agent bash 执行；kill 自身 tools/result **不得配对** → 不误判 done，T1-2）；
4. 等 12~16s（ps 间隔 5s × CRASH_PS_GAP 2 = 10~15s）→ 调 `lab_status` →
   断言：`experiment.state === 'crashed'`（或收敛为 null + history 该 run reason=crashed）+
   `alerts[]` 含 `{level:'critical', rule:'experiment-crash'}` + `alertsCriticalCount >= 1`。

**预期**：kill 后 **≤15s** 判 crashed 并出 CRITICAL 告警；**不误判 done**（kill 自身 result 被配对校验拒绝）。

## 3. T3：并发单跟踪 → aborted（P1 7' 复核）

**步骤**：
1. 起 A：`python3 /tmp/train_demo.py &`（train_demo.py）→ running（run-XXX 关联）；
2. 立即起 B：`python3 /tmp/train_demo2.py &` → 断言：**仅 B running**（run-YYY），A 自动归档 aborted（R-2）；
3. `lab_status` → `experiment.cmd` 为 train_demo2.py；history 中 run-XXX reason=aborted。

**预期**：无双 running 并存；旧 run aborted 归档。

## 4. T4：平衡引擎构造触发（P1 5' 补充：thermal + oom 复核）

**步骤**（lab_ctl 工具或 rpc.setThresholds）：
1. thermal：`lab_ctl set-threshold tempWarn=1`（当前 37°C 恒 >1）→ 等 12s（阈值持续 10s）→
   `lab_status` → alerts[] 含 `{level:'warn', rule:'thermal-wall'}`（或对应 rule 名）；
2. oom：`lab_ctl set-threshold memWarn=5`（显存余量 <5%？——注意当前余量 88%，需构造：memWarn 改大如 95）
   → 等 12s → alerts[] 含 `{level:'critical', rule:'oom-risk'}`（或对应 rule 名）；
3. 复位：`lab_ctl set-threshold tempWarn=85 memWarn=95`（恢复默认）。

**预期**：告警含分级/置信度/动作字段；alertsCriticalCount 对 critical 计数正确；≤1 采样周期（2s）生效（P2 2' 即时生效复核）。

## 5. 执行记录（2026-08-19 队长执行，e2e-host.js ALL PASS）

| # | 场景 | 命令 | 观测结果 | 通过 |
|---|---|---|---|---|
| T1 | 正常 done | `python3 -c 'import time; time.sleep(20)'` | pre→running→**pid 关联（实验 pid=真实进程 pid）**→result 配对→进程消失双确认→done；alertsCriticalCount=0（无告警） | ✅ |
| T2 | kill→crashed | `python3 /tmp/train_demo.py` + `kill` | running+pid 关联→kill→**≤15s 判 crashed** + `critical/experiment-crash` 告警（confidence 0.9） | ✅ |
| T3 | 并发 aborted | train_demo + train_demo2 | 仅 B running（无双 running）；A 不再被跟踪（R-2 单跟踪） | ✅ |
| T4 | thermal 触发 | `setThresholds tempWarn=1` | **warn/thermal** 告警（置信 0.7 + 动作），真实温度持续 >1°C 10s | ✅ |
| T4b | oom 触发 | `setThresholds memWarn=5 utilWarn=1` | **critical/oom** 告警（置信 0.85 + 动作），显存 11%>=5% 且 util>=1% | ✅ |
| T4c | **5min 防重（P2 1）** | 阈值仍满足 + 等 12s | thermal 告警数 **1→1 不增**（lastByRule 同类 5min 防重） | ✅ |
| T5 | **history 真实数据（P2 3）** | `labMonitor.history`（真实 ring 已采样 ~2min） | 56 个降采样桶（≤500）、含 GPU util 聚合（gpuUtil=2 实测） | ✅ |

### 5.1 ⚠️ e2e 抓到的真实缺陷（v1.4.5 修复，verify-host 自测未覆盖）

**缺陷 1（T1 暴露）：`python3 -c` 内联形态 pid 关联结构性失败 → 正常结束误判 crashed**

- 根因：`cmdFingerprint` 对 `python -c` 用**内容哈希**（`pyc:<hash>`）作指纹；ps 行 args 是代码原文
  （引号被 shell 剥离），哈希永不匹配 → `findAliveProc` 永远找不到进程 → pid 关联失败 →
  进程一结束（无 pid 关联 + 无配对 result）即经 `pidMissingStreak>=2` 判 **crashed** 并误发 CRITICAL 告警。
- verify-host 未覆盖原因：fake ps 直接给了 pid 行（`FAKE.psLines` 预设 `1234 python train_demo.py`），
  跳过指纹匹配路径；且 fake 场景未用 `python -c` 形态。
- 修复（plugin/host/index.js）：
  1. `cmdFingerprint`：`pyc:` 前缀后接**归一化命令从 `-c` 起的完整后缀前 28 字符**
     （`pyc:-c import time; time.sleep(1`），非哈希——ps 行 indexOf 可匹配；
  2. 新增 `normalizeCmdForMatch`（引号剥离 + 空白折叠）；
  3. `findAliveProc`：归一化对比 + **剥离 pyc: 前缀**；
  4. result 配对校验：同样剥离 pyc: 前缀 + 归一化（否则带引号 cmd 不配对）。

**缺陷 2（T4 暴露）：oom 构造阈值语义**——oom 规则是 `usedPct>=memWarn && utilPct>=utilWarn`
（占用百分比双条件），非"余量"；构造需 `memWarn=5 utilWarn=1`（空闲 GPU util≈2%）。
非代码缺陷，测试参数修正。

**改进点（非缺陷，记录）**：实验归档 aborted/done 无 RPC 数据面（history 为 ring 曲线，
machine.history 未暴露）——P2 增强 history RPC 时补充实验记录面（P1 6 emit 只覆盖 start/alert）。

### 5.2 执行后动作

1. ✅ 回填 docs/reference/milestones.md P1 1'/2' 会话内实证结论（见 §6）；
2. ✅ 本文件补执行记录（本节）；
3. ✅ verify.sh 回归全绿（改动无副作用）；e2e-host.js 保留为可选 CI（真实进程 60s，默认不并入 verify.sh）。
