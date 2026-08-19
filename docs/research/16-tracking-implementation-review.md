# 16 进程级跟踪实现审查报告（设计者质检）

> 状态：审查完成（2026-08-20，tracking-designer）。审查对象：tracking-engineer 的 t6 实现
> （Phase A/B/C，基于设计文档 docs/research/14-process-tracking-design.md 402 行二版）。
> 方法：逐文件对照设计 §2/§3/§5 验收清单 + 协议兼容检查 + verify.sh 全量回归。
> 纪律：只审查不代改；偏差项报告队长裁决。

## 0. 结论摘要

- **总体符合度高**：Phase A/B/C 核心逻辑与设计一致，协议 1.2 纯增量落地，verify.sh **全绿**
  （exit 0，含 typecheck/构建/目录/契约/verify-host 47+ 断言/mock-test/sampler 实测）。
- **偏差 1 项（中危）**：进程组聚合输入用 WSL ps 表（Linux pid 空间），偏离设计「backend procs
  合并表（tasklist+pmon，Windows pid）」——导致 system.topN 不含 Windows 侧占卡进程、
  gpuUtilPct 恒 null，防误报「他人占卡」上下文在 WSL 真实场景失真。
- **偏差 3 项（低危/提示）**：verify.sh 契约断言脆弱（grep 1.1 靠变更记录侥幸过）、mock-test
  未扩展 1.2 断言、主进程 pid 精确匹配优先于 cmd 校验（R3 语义不完全对齐）。

---

## 1. 符合项核对（对照设计 §5 验收清单）

### Phase A：进程级采集（backend）

| 设计项 | 实现 | 判定 |
|---|---|---|
| A1 pmon 每进程 GPU 利用率（辅助） | `pmon -c 3 -s u` 多帧窗口，`-` 视 0，同 pid 多帧取 **max**（Windows/Linux 双实现）；失败降级空 Map 不拖垮整卡 | ✅ |
| A2 每进程 GPU 显存预留不启用 | `gpuMemMiB` 字段声明但**不采集不填充**（恒 null）；backend 无 compute-apps 调用 | ✅ |
| A3 procs CPU/内存主通道 | Linux `ps -eo pid,ppid,pcpu,rss,args`（rss kB→MiB 补 memMiB）；Windows tasklist memMiB 保留 | ✅ |
| A4 PPID 进程树 | Windows CIM Win32_Process 追加 `pid;ppid;name` 输出（并入 PS_SYSMEM 同 TTL 5s）；Linux ps ppid 列 | ✅ |
| 合并器 + sources 标注 | backend-windows 按 pid 归并 ppid/pmon；sources `tasklist+pmon`/`ps+pmon`/`pmon` | ✅（见偏差 1） |

### Phase B：实验进程组统计（core）

| 设计项 | 实现 | 判定 |
|---|---|---|
| procGroup: Set\<number\> + associateProc | state-machine 扩展，associatePid 委托 associateProc；主 pid 兼容保留 | ✅ |
| 进程树 BFS 扩张 | tick 内 ppid 递归至不动点，主进程消失时以指纹匹配成员为根；子进程延迟 ≤1 周期（R4） | ✅ |
| proc-aggregator 拆分聚合 | groupStats{cpuPct/memMiB/memberCount/alive, gpuUtilPct?, gpuMemMiB 恒 null, members≤20} + system{cpuPct/memMiB/topN≤5}；无实验 system 仍输出（runActive=false → group null，system=全表） | ✅ |
| summary 扩展 | groupCpuMax/groupMemPeakMiB/otherMemPeakMiB（5s 粒度峰值） | ✅ |
| SamplePoint/快照接线 | index.ts ps 周期挂聚合 + 最近点回退 lastGroupStats + experimentActive 实时判定 | ✅ |

### Phase C：告警规则重写（balancer）

| 设计项 | 实现 | 判定 |
|---|---|---|
| oom 归属仲裁三分支 | 整卡 ≥memWarn → G 活跃（groupActive：CPU≥30 / mem≥2048MiB / pmon≥30）critical；G 不活跃 → 降级 warn「疑似他人负载」；无实验 → other-occupancy | ✅ |
| 上下文标注 | msg 含「整卡 X%（X/XG）达阈值；实验组 CPU/内存；系统其他 N 进程占卡」 | ✅（见偏差 1） |
| io-bottleneck 重写 | G.cpuPct≥90 && 整卡 util<30 主判；G.cpuPct 不可得（Windows）降级整机 + 标注；**无实验不触发**（防他人 CPU 负载误报） | ✅ |
| thermal 重写 | 整卡物理量 + G 活跃度上下文（「若实验活跃度低则非实验负载引起」） | ✅ |
| imbalance 保持 | 多卡间无进程边界，保持整卡 | ✅ |
| other-occupancy 新增 | info 级独立提示 + Top 进程 evidence（无实验且整卡 ≥memWarn 时） | ✅ |
| Alert.evidence + actions 动态化 | evidence{procs[]}（组内优先 + 其他补充，≤5）；actions 按证据细化（如「检查 pid X (cmd) 等其他进程占卡」）；lab_advice/lab_ctl 均携带 | ✅ |

### 协议兼容（lab-protocol/1.1 → 1.2）

| 设计项 | 实现 | 判定 |
|---|---|---|
| 纯增量（只加字段不改语义） | docs/03-protocol.md 头部 `lab-protocol/1.2` + §1.2 变更记录（147 行）；procs[].ppid/gpuUtilPct、experiment.procGroup/groupStats、snapshot.system、alerts[].evidence、history groupCpu/groupMem 全部新增 | ✅ |
| gpu 遗留字段语义定稿 | 文档注明「gpu = GPU 利用率 %，与 gpuUtilPct 同值，兼容保留」 | ✅ |
| 既有断言未破坏 | verify-host/mock-test 全过（含 1.1 全部断言） | ✅ |

### 风险对策落地（设计 §6）

| 风险 | 落地 | 判定 |
|---|---|---|
| R2 pmon 单帧低估 | `-c 3` 多帧 + 同 pid 取 max（Windows 189 行/Linux 注释同语义） | ✅ |
| R3 pid 变化/复用 | 僵尸进程 `<defunct>` 排除；memberMatches cmd 指纹校验；主进程 pid 变化重关联（run.pid=main.pid） | ✅（见偏差 4） |
| R9 Windows G.cpuPct 不可得 | io-bottleneck 降级整机 CPU + 标注；oom 仲裁用 memMiB/存在性代替 CPU 活跃度 | ✅ |

### 回归结果（verify.sh）

```
[1] typecheck + 构建     ✓
[2] 目录完整性           ✓
[3] 契约静态核对         ✓
[4] verify-host ALL PASS ✓（含 1.2 断言：system 差集/procGroup 扩张/groupStats 求和/oom 三分支 evidence）
[5] mock-test ALL PASS   ✓
[6] verify-sampler 通过  ✓
[7] e2e 跳过（默认）     ——
==== verify.sh 全部通过（exit 0）====
```

---

## 2. 偏差项（含严重度与修复建议）

### 偏差 1【中危】聚合输入 pid 空间不完整——「他人占卡」上下文在 WSL 场景失真

- **位置**：`src/index.ts` 269-295 行（ps 周期聚合）；设计对照 §2.2「输入：增强后 procs 表」。
- **现象**：`aggregateProcStats` 的输入用 **WSL ps 表**（`ps -eo pid,ppid,pcpu,rss,args`，Linux
  pid 空间），而非 backend 合并表（tasklist+pmon，Windows pid 空间）。aggProcs 映射时**未携带
  gpuUtilPct**（279-285 行无此字段）。
- **后果**：
  1. `system.topN` 只含 WSL 内进程（bash/python 等），**不含 Windows 侧占卡进程**
     （chrome/WeChat/llama-server）——本机即 WSL 场景，oom 仲裁 msg 中「系统其他 N 进程占卡」
     与 other-occupancy 的 Top 证据失真，防误报核心上下文丢失；
  2. `groupStats.gpuUtilPct` / `system.gpuUtilPct` **恒 null**——pmon 辅助证据未接入聚合
     （backend 采集了但上层没用上）；
  3. verify-host 之所以通过，是因为其 mock ps 表恰好是同一 pid 空间（8888 等 WSL 视角），
     掩盖了真实场景缺口。
- **合理性说明**：实现者注释「WSL：Linux pid 空间；backend procs 表是 Windows tasklist pid，
  不可做组差集」——实验进程在 WSL 内，**G 用 ps 表正确**；问题只在 system 侧。
- **修复建议（交队长裁决）**：system 聚合改用 backend procs 全表（tasklist+pmon，Windows pid；
  实验进程不在 Windows pid 空间，天然无差集冲突），G 聚合保留 WSL ps 表——即
  `aggregateProcStats` 接受双输入（group 用 ps 表、system 用 backend 表），或 index 层对
  system 单独调一次以 backend procs 为输入的聚合。severity 中危：防误报上下文证据失效但不影响
  G 活跃度主判据与告警级别正确性。

### 偏差 2【低危】verify.sh [3] 契约断言脆弱（grep 1.1 侥幸通过）

- **位置**：`scripts/verify.sh` [3] `grep -q "lab-protocol/1.1" docs/03-protocol.md`。
- **现象**：协议头已升级为 `lab-protocol/1.2`，该 grep 靠 §1.2 变更记录第 147 行
  「lab-protocol/1.1 → 1.2」字样**侥幸匹配**；若未来清理变更记录即误报失败。
- **建议**：改为 `grep -q "lab-protocol/1.2" docs/03-protocol.md`（协议头为权威）。

### 偏差 3【低危】mock-test.js 未扩展 1.2 断言

- **位置**：`scripts/mock-test.js`（client HTTP 数据面回归）。
- **现象**：无 system/groupStats/evidence/procGroup 相关断言（grep 无命中）；client 对新增
  字段的消费路径（渲染/兼容 null）未覆盖。
- **影响**：兼容性未破坏（1.1 断言全过），但 1.2 字段的 client 侧消费回归缺口。
- **建议**：mock-test 增加 1 个快照含 system/groupStats 的断言（字段存在 + null 容忍）。

### 偏差 4【提示】主进程 pid 精确匹配优先于 cmd 校验（R3 语义不完全对齐）

- **位置**：`src/core/state-machine.ts` findAliveProc（75 行）/ memberMatches（88 行）
  `if (run.pid && p.pid === run.pid) return true` 无条件放行。
- **现象**：与设计 R3「同 pid 但 cmd 不匹配 → 剔除」不完全一致——主 pid 被复用且 cmd 不符时
  可能误判存活。
- **缓解**：僵尸进程已排除（`<defunct>`）+ crashed 判定有 CRASH_PS_GAP（≥2 周期）缓冲 + 主进程
  每 5s 重关联（pid 变化时 run.pid=main.pid 覆盖）——实际风险低。
- **建议**：可接受；后续如需收紧，主进程精确匹配后追加一次 cmd 指纹二次校验（与 memberMatches
  同逻辑）。

---

## 3. 与设计文档 §5 验收清单的逐项结论

| 验收项 | 结论 |
|---|---|
| A1 pmon 行解析（`-`→0、多帧） | ✅ 通过（verify-sampler + 代码核对） |
| A2 compute-apps 预留不启用 | ✅ 通过（字段声明、不采集） |
| A3 ppid/memMiB 主通道 | ✅ 通过（ps 5 列 + VmRSS） |
| A4 CIM ppid | ✅ 通过（verify-host 断言 procs[].ppid=1） |
| B1 procGroup + 组存活 | ✅ 通过（verify-host procGroup 含主/子） |
| B2 ppid 递归扩张 | ✅ 通过（verify-host memberCount=2） |
| B3 G vs 非G 拆分 | ⚠️ 部分通过（差集正确但 pid 空间不完整，见偏差 1） |
| B4 数据面 + 协议 1.2 | ✅ 通过 |
| C1 oom 归属仲裁三分支 | ✅ 通过（verify-host 三分支断言） |
| C2 io-bottleneck | ✅ 通过 |
| C3 thermal | ✅ 通过 |
| C4 other-occupancy | ✅ 通过（verify-host evidence 断言） |
| C5 evidence + 工具升级 | ✅ 通过（lab_advice/lab_ctl 均携带 system/evidence） |
| 协议 1.1→1.2 纯增量 | ✅ 通过 |
| 既有断言未破坏 | ✅ 通过（verify.sh 全绿） |

## 4. 关联文档

- 设计基线：`docs/research/14-process-tracking-design.md`（§2/§3/§5/§6）
- 协议：`docs/03-protocol.md`（1.2 变更记录 §1.2）
- 实现：`src/sampler/backend-{windows,linux}.ts`、`src/core/{proc-aggregator,state-machine,balancer,types}.ts`、`src/index.ts`
- 回归：`scripts/verify.sh` / `verify-host.js` / `mock-test.js` / `verify-sampler.js`
