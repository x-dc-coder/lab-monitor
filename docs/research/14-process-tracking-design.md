# 14 进程级资源跟踪设计（防误报）

> 状态：设计定稿（2026-08-20，tracking-designer）。输入：src/core/state-machine.ts、src/core/balancer.ts、
> src/core/types.ts、src/sampler/*（backend-interface/backend-linux/backend-windows/windows-paths）、
> src/index.ts、src/client.ts、docs/02-data-model.md、docs/03-protocol.md、docs/research/08-sampling-empirical.md。
> 全部关键能力经本机（WSL2 + RTX 5060 Ti）实测，实证记录见 §1.3/§2.1/§6。
> 实现者：tracking-engineer（按 §5 分阶段清单落地）；本文档只设计不写实现代码。

## 0. TL;DR

- **误报根因**：balancer 的 oom/io-bottleneck/thermal/imbalance 全部基于「全系统 GPU 首卡」指标
  （`w.gpu[0]`），实验进程与系统其他进程混用同一 GPU——他人占卡被误报成实验 OOM；
  实测本机 GPU 显存占用 93%（15184/16311 MiB）但无实验进程（explorer/chrome/WeChat 等占满），
  oom 规则必然误报。
- **方案四层**：①采集层加「进程级指标通道」（pmon 每进程 GPU 利用率 + compute-apps 每进程显存
  + ps/procfs/CIM 每进程 CPU/内存 + PPID 进程树）；②统计层引入「实验进程组」（实验 pid 递归扩张
  含子进程/worker，按组 vs 非实验组拆分聚合）；③告警层规则重写为「以实验进程组自身指标为准 +
  系统其他进程占用作上下文」；④提醒层把阈值触达升级为「带进程级证据的可执行建议」。
- **实证关键**：Windows 侧 `--query-compute-apps=used_memory` **全部返回 [N/A]**（WDDM 限制，
  含真实 CUDA 进程 llama-server.exe），**每进程 GPU 显存在 Windows 不可直接获取**——必须降级
  为「实验组显存未知 + 整卡显存 + 其他进程显存占用量」组合呈现；Linux 原生侧 compute-apps 有效。
- **协议**：lab-protocol/1.1 → **1.2（向后兼容增量）**：只加字段不改语义，老 client 照常工作。
- **落地顺序**：Phase A 采集（backend）→ Phase B 统计（core）→ Phase C 告警+提醒，每阶段独立可验收。

---

## 1. 现状与误报路径分析

### 1.1 现有进程跟踪能力盘点

| 模块 | 现状 | 缺口 |
|---|---|---|
| `state-machine.ts` | 实验 pid 关联（T1-1：tools/execute 或 ps 回填）；`findAliveProc` 按 pid 精确或 cmd 指纹模糊匹配存活；`tick` 5s ps 周期判 done/crashed | **只跟踪「存活」，不跟踪「资源占用」**；单 pid 模型，无子进程/worker 组 |
| `sampler/backend-*` | procs 通道：Linux `ps -eo pid,pcpu,pmem,args`（cpuPct 有，memMiB=null）；Windows tasklist CSV（memMiB 有，cpuPct=null） | **procs[].gpu 字段已预留但从未填充**（backend-interface.ts `ProcSample.gpu?: number \| null`）；无每进程 GPU 利用率/显存 |
| `balancer.ts` | 4 条规则（oom/io-bottleneck/thermal/imbalance）防抖：阈值持续 10s + 同类 5min 最小间隔 | **规则输入全部是 `w.gpu[0]`（全系统首卡）+ 全机 cpuPct**，无进程归属概念 |
| `index.ts` 采样聚合 | `sampleStats`（utilSum/utilN/utilMax/memPeakMiB）只取 `pt.gpu[0]` 累计 | 实验摘要也是整卡口径，非实验自身 |

### 1.2 误报路径（实证确认）

当前告警判定链：`collectSnapshot → toSamplePoint → balancer.evaluate(w = 最近采样点)`，
而 `w.gpu[0]` 是**全系统 GPU 首卡**聚合指标——它同时包含实验进程、浏览器、桌面、其他用户任务的占用。

具体误报场景：

1. **oom 误报**：本机实测 `query-gpu` → `15184 MiB / 16311 MiB`（93%）`util 7%`，
   但 `experiment: null`（无实验）——显存被 explorer/chrome/WeChat/ToDesk 等桌面进程占满。
   若此刻有实验 running，`usedPct(93%) >= memWarn(95% 默认)` 未达，但若阈值调低（如 90）即误报；
   更常见：实验本身只用 4G，他人占 12G，总显存 90%+ → 误报「实验 OOM 风险」。
2. **io-bottleneck 误报**：`gpu[0].utilPct < 30 && cpuPct >= 90`——实验 GPU 利用率低但**全机**
   CPU 满载（比如用户同时在编译/跑别的 CPU 任务）→ 误报「数据加载瓶颈」，实为他人 CPU 负载。
3. **thermal 语义偏差**：温度是**整卡物理量**（无法按进程拆分），但告警消息应澄清「温度高≠实验
   引起」——需带进程上下文。

结论：**「实验进程组自身指标」与「系统其他进程指标」必须分离**，告警只以实验自身为准，
其他进程占用降级为上下文信息（且本身也是一种值得提示的信号——「他人占卡」）。

### 1.3 平台进程通道差异（实证基线）

| 通道 | Linux（原生） | WSL（本机，interop） | Windows 原生 |
|---|---|---|---|
| 进程表 | `ps -eo pid,ppid,pcpu,pmem,args`（~10ms）✅ | tasklist GBK→iconv（~230ms，TTL 5s）✅ | tasklist ✅ |
| 每进程 CPU% | ps pcpu ✅ | tasklist **无** → CIM LoadPercentage 是整机值 ✗ | typeperf/CIM |
| 每进程内存 | `/proc/<pid>/status` VmRSS ✅ | tasklist「内存使用 K」✅（含 WSL 外的 Windows 进程） | tasklist ✅ |
| 每进程 GPU 利用率 | `nvidia-smi pmon -c 1` ✅ | **pmon 跨 interop 可用（本机实测）** ✅ | pmon ✅ |
| 每进程 GPU 利用率实证 | 稳定负载精确（sm=98 vs query 99，偏差 ≤2）；**突发负载单帧低估**（`-`/0，见 R2） | 同左（Ollama llama-server 推理实测：持续负载 sm=98~99 稳定；prompt 处理间隙单帧 `-`） | 同左 |
| 每进程 GPU 显存 | `nvidia-smi --query-compute-apps=pid,used_memory` ✅ | **used_memory 全 N/A（WDDM）** ✗（含真实 CUDA 进程） | 同 WSL ✗ |
| 进程树 | ps ppid 列 ✅ | **CIM Win32_Process.ProcessId/ParentProcessId（本机实测 55884→47680）** ✅（TTL 5s 并入现有 CIM 通道） | 同 WSL ✅ |
| 整卡指标 | query-gpu ✅ | query-gpu（40-60ms，TTL 500ms）✅ | query-gpu ✅ |

> **Windows 每进程 GPU 显存 N/A 是本方案最大的平台约束**（§6.1 展开），决定了 oom 规则在
> Windows 侧只能「整卡 + 尽力归属」；Linux 原生侧可全量精确归属。

---

## 2. 方案架构（采集 / 统计 / 告警 / 提醒 四层）

```
┌─ 采集层（Phase A, backend）─────────────────────────────────────────────┐
│ 通道A1 pmon 每进程GPU利用率(sm/mem%)  通道A2 compute-apps 每进程显存MiB    │
│ 通道A3 ps/procfs|tasklist 每进程CPU/内存  通道A4 PPID 进程树（ps|CIM）      │
│        ↓ 按 pid 归并 → ProcSample 增强 { gpuUtilPct?, gpuMemMiB?, ppid?,   │
│          cpuPct?, memMiB? }（整表 ≤ 低频 5s）                              │
├─ 统计层（Phase B, core）─────────────────────────────────────────────────┐
│ 实验进程组 G = 主pid ∪ 子进程/worker（PPID 递归，新生 pid 动态纳入）        │
│ 按组聚合：G.gpuUtilPct / G.gpuMemMiB / G.cpuPct / G.memMiB                │
│ 非实验组 O = Σ(其他进程占用) + Top-N 明细                                  │
├─ 告警层（Phase C, balancer）─────────────────────────────────────────────┐
│ oom/io-bottleneck 改判「G 自身指标」；整卡/温度仅作约束与上下文；            │
│ 新增「他人占卡」提示规则；告警 msg 带拆分证据（实验 X G + 其他 Y G）          │
└─ 提醒层（Phase C, balancer/tools）───────────────────────────────────────┘
   lab_advice/lab_ctl 升级：阈值触达 → 可执行建议 + 进程级证据（pid/cmd/占用）
```

### 2.1 采集层：进程级指标通道设计

#### 通道 A1：每进程 GPU 利用率（pmon）——双平台可用 ★实证

- 命令：`nvidia-smi pmon -c 3 -s u`（`-c 3` **多帧采样窗口**；`-s u` 只取 util 列，输出更短）。
  本机实测（Ollama llama-server 推理压测，2026-08-20）：
  - **持续计算负载下精确**：pmon sm=98/97/98 与 `query-gpu utilization.gpu` 99% 同秒偏差 ≤2
    （与 08 §4.2 dmon vs query 结论一致：稳定负载偏差 0）；
  - **突发/间隙负载下单帧低估**：prompt 处理间隙单帧 `-` 或 0，而 query 显示 25%/98%——
    **必须多帧窗口**（`-c 3` 取均值或 max，见 §6 R2），单帧不可直接采信。
- 解析：跳过 `#` 注释行；`pid` 列 → `sm`（compute%）、`mem`（memory bandwidth%）；`-` 视作 0。
- 频率：**归 5s 低频**（与 procs/进程树同拍），每次采样取 `-c 3` 三帧均值/max；整卡 util
  仍走 query 高频（dmon 流覆盖）。
- 降级：pmon 失败（驱动不支持/权限）→ `procs[].gpuUtilPct = null`，整卡指标照常，sources 标注。

#### 通道 A2：每进程 GPU 显存（compute-apps）——平台分化 ★实证

- 命令：`nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader`。
- **Windows/WSL 实测：全部返回 `[N/A]`**（含真实 CUDA 进程 llama-server.exe 55884，type=C）。
  WDDM 驱动不向 nvidia-smi 暴露每进程显存。
- **Linux 原生**：同命令有效（Linux 驱动支持）。
- **Windows 降级设计**（关键，防实现者踩坑）：
  - `procs[].gpuMemMiB = null`（不可得）；
  - 实验进程组 G 显存 = **未知**，但整卡 used 可得 → 呈现「整卡 X/总 + 实验显存未知（Windows
    限制）+ 其他进程估算」；
  - 其他进程显存估算的**候选回退**（设计二选一，实现时选 A 并记录）：
    - 方案 A（推荐，零额外开销）：`其他 ≈ 整卡used - 实验组不可知` → 无法拆分，仅报整卡 + 提示
      「Windows 无法按进程拆分显存」；
    - 方案 B（尽力拆分）：周期性快照实验组**进程数 × 平均每进程显存**不可行（无数据源），
      故 **B 不可行**——Windows 侧不虚构数据，诚实标注 unavailable（符合项目「防脏数据」原则）。
- **队长预研结论（2026-08-20，与本设计一致）**：每进程显存归属在 Windows 退而求其次——
  显存总量是整卡（16311MiB），实验进程组显存**无直接来源**；更可行的防误报信号是
  **每进程 GPU 利用率（pmon）** + **每进程 CPU/内存（tasklist/ps 已有）** + **进程存在性**。
  因此 Windows 侧 oom 不依赖 G.gpuMemMiB，改走 §2.3 的「降级而非误报」判定。

#### 通道 A2b：每进程显存的实验组估算（仅 Linux 有效，Windows 跳过）

- Linux 原生：compute-apps 有效 → G.gpuMemMiB = Σ 成员，精确拆分；
- Windows：G.gpuMemMiB = null，**防误报判定改用「整卡显存 + 实验组利用率/CPU 活跃度」组合**：
  实验组 GPU 利用率低 + 整卡显存高 → 判定「疑似他人占用」（§2.3 降级逻辑）。

#### 通道 A3：每进程 CPU/内存——平台分发

- Linux：`ps -eo pid,ppid,pcpu,pmem,args`（现成，+ppid 列）；`/proc/<pid>/status` VmRSS
  → `memMiB = VmRSS/1024`（比 pmem 百分比精确；现实现 memMiB=null 可在此补齐）。
- Windows/WSL：tasklist（memMiB 已有）；cpuPct 补 **CIM Win32_Process 单进程 CPU 无瞬时值**
  （LoadPercentage 是整机）→ Windows 侧 `procs[].cpuPct` 保持 null 或低频 typeperf 扩展
  （**设计留 P2，不在本次范围**）；CPU 归属拆分在 Windows 侧不做，靠整机 + 实验组可见性兜底。

#### 通道 A4：进程树（PPID）——实验进程组扩张的骨架 ★实证

- Linux：`ps -eo pid,ppid,args` 直接有 PPID。
- Windows/WSL：**CIM Win32_Process.ProcessId/ParentProcessId（本机实测
  `55884;47680;llama-server.exe`）**，并入现有 sysMemCim 的 PowerShell 调用
  （同 TTL 5s，追加输出 `pid;ppid;name` 行列表，不新增进程）。
- 进程树算法（core 内实现，不进 backend）：
  `G = {主pid}` → 对每张 procs 表，若 `p.ppid ∈ G` 且 `p.pid ∉ G` → 加入 G，迭代至不动点。
  子进程**延迟出生**（实验 spawn worker）在下一 5s 周期自然纳入。
- 边界：PPID 丢失（进程已退出）→ 保留已纳入成员直至连续 N 周期不可见（与 crashed 判定共用
  `CRASH_PS_GAP` 语义）；pid 复用防护见 §6.3。

#### 合并策略（backend `snapshot()` 内，pid 为键）

```
procs = tasklist|ps 基表（pid → cmd/cpuPct/memMiB/ppid）
      ⊕ pmon 行（pid → gpuUtilPct）
      ⊕ compute-apps 行（pid → gpuMemMiB，Linux 有效；Windows null）
按 pid 合并成 ProcSample[]（单表，字段缺失为 null，sources 标注各通道）
```

### 2.2 统计层：实验进程组跟踪与拆分

#### 实验进程组 G（state-machine 扩展）

- 现状 `RunRecord.pid: number | null` → 扩展为 **`procGroup: Set<number> | null`**（主 pid 仍保留
  兼容 `experiment.pid` 展示）；`associatePid(pid)` 改为 `associateProc(pid)` 加入集合。
- `tick(aliveProcs)` 语义不变（**任一成员存活即视为实验存活**，避免 worker 全退主进程活的误判
  crashed；主进程退而 worker 活也判存活——组级判定），同时**输出每周期 G 的成员快照**给统计层。
- 与现有指纹匹配兼容：pid 未关联时仍可按 cmd 指纹模糊纳入候选（findAliveProc 逻辑保留）。

#### 拆分聚合（core 新增 `proc-aggregator` 模块，纯函数）

输入：增强后 procs 表 + G 集合；输出（每 5s 周期）：
`groupStats = { gpuUtilPct, gpuMemMiB|null, cpuPct, memMiB, memberCount, members:[{pid,cmd,gpuUtilPct,gpuMemMiB,cpuPct,memMiB}] }`
`otherStats = { gpuMemMiB|null（整卡-G 不可得→null）, topN:[{pid,cmd,gpuUtilPct,gpuMemMiB,cpuPct,memMiB}], total }`

聚合规则：
- GPU 利用率：G 成员 gpuUtilPct 求和（多进程共享 GPU，pmon 已按进程报）→ 上限 100 截断。
- GPU 显存：Linux 下 G 求和；Windows 下 null（见 A2）。
- CPU/内存：G 成员求和；Windows 下 cpuPct 全 null → 仅 memMiB 可拆。
- 非实验组 = 全表 − G（按 pid 差集）。

### 2.3 告警层：规则重写（防误报核心）

**防误报核心逻辑（队长预研补充，2026-08-20）——「降级而非误报」**：
告警触发时先做**归属仲裁**，再定级别：
1. experiment 存在 且 G 自身指标达标（Linux：G.gpuMemMiB% ≥ memWarn；Windows：G.gpuUtilPct
   高且整卡显存高）→ 判为实验自身风险（critical，如实告警）；
2. experiment 存在 但 G 利用率/显存占比 **低**，而系统其他进程占卡 → **降级**为
   「疑似他人占用，非实验 OOM」（warn/info + 附其他进程 Top 证据），**不误报实验 OOM**；
3. 无 experiment → other-occupancy 独立提示（info）。

| 规则 | 现状（全系统首卡） | 重写后（实验组为准 + 归属仲裁 + 上下文） |
|---|---|---|
| **oom** | `gpu[0].memUsed% ≥ memWarn && util ≥ utilWarn` | **归属仲裁优先**：① Linux：G.gpuMemMiB% ≥ memWarn → critical（实验自身 OOM 风险）；G 低而整卡高 → 降级 warn「疑似他人占用」（附其他进程 Top）；② Windows：G.gpuMemMiB 不可得 → 整卡 used% ≥ memWarn **且** G.gpuUtilPct 高 → critical；整卡高但 G.gpuUtilPct 低 → 降级 warn「疑似他人占用」；③ 上下文：`实验 X GiB + 其他 Y GiB = 总 Z/Z GiB`（Linux 精确；Windows 报总数 + 提示「实验显存不可拆」） |
| **io-bottleneck** | `gpu[0].util < 30 && 整机 cpu ≥ 90` | `G.gpuUtilPct < 30 && G.cpuPct ≥ 90`（**实验自身** CPU 满载才是数据管线瓶颈）；G.cpuPct 不可得（Windows）→ 降级整机 cpu 并标注「无法按进程拆分 CPU，基于全机判断」 |
| **thermal** | 整卡温度 ≥ tempWarn | 保持整卡（物理量不可拆），msg 改为「GPU 温度达阈值（整卡物理量；若实验利用率低则非实验负载引起）」+ 上下文 G 利用率 |
| **imbalance** | 多卡 util 差 ≥ 40 | 保持整卡（多卡间本就无进程边界），可加 G 在各卡的 util（多 GPU 分配信息） |
| **新增 other-occupancy** | 无 | G 未 running（idle）但整卡显存 ≥ memWarn → 提示「系统其他进程占用 GPU 显存 X/X GiB（Top: pid/cmd）」——把「他人占卡」从误报源变成**独立提示**（info 级，不惊扰） |

防抖保持：阈值持续 10s + 同类 5min（现有 hitByRule/lastByRule 机制不动）。

### 2.4 提醒层：Agent 可执行建议升级

现状：`Alert.actions: string[]`（静态文案，如「降低 batch size」）+ lab_advice 返回动作数组。

升级为**「证据 + 动作」两段式**（告警对象扩展，§3.2）：

- **证据段**（`evidence: { procs: [{pid, cmd, gpuUtilPct, gpuMemMiB, cpuPct, memMiB}] }`）：
  告警触发时附 **Top-5 相关进程**（实验组内优先 + 其他进程占用 Top），Agent 一眼定位「谁在占」。
- **动作段**（`actions[]` 按证据细化）：
  - oom：`降低 batch size` + `关停 pid 1234 (chrome.exe) 占用 8G`（精确到进程）；
  - other-occupancy：`当前无实验但显存被占，建议检查 pid 1234 (WeChat.exe)`；
  - io-bottleneck：`实验 CPU 满载（G.cpu 95%），增加 num_workers 或检查数据管线`；
  - thermal：`若实验利用率低（G 12%），温度高疑为其他进程/散热，检查风扇`。
- **lab_ctl set-threshold 升级**：写阈值时返回当前拆分统计（快照语义），Agent 设置前可见证据。

---

## 3. 数据模型扩展

### 3.1 ProcSample（backend-interface.ts，进程条目增强）

```ts
export interface ProcSample {
  pid: number
  cmd: string
  cpuPct?: number | null          // 现字段（Linux 有；Windows null）
  memMiB?: number | null          // 现字段（tasklist 有；Linux 由 VmRSS 补齐）
  gpu?: number | null             // 现预留字段 → 语义定稿：**GPU 利用率 %**（pmon sm 列）
  gpuUtilPct?: number | null      // 新：与 gpu 同值（显式命名，gpu 保留兼容）
  gpuMemMiB?: number | null       // 新：每进程显存（Linux 有效；Windows null=不可得）
  ppid?: number | null            // 新：父进程 id（进程树骨架）
}
```

> 注意：`gpu` 字段 v1.1 已存在于类型定义但**从未被填充**（协议未列），定稿为「GPU 利用率 %」
> 属**首次填充而非语义变更**——按 §4.1 兼容规则仍需在 1.2 变更记录中明示。

### 3.2 MonitorSnapshot（对外协议 lab-protocol/1.1 → 1.2 增量）

```jsonc
{
  // ... 1.1 全部字段不变 ...
  "procs": [ /* ProcSample 增强：+gpuUtilPct/gpuMemMiB/ppid（缺失为 null） */ ],
  "experiment": {
    "runId": "...", "state": "...", "cmd": "...", "pid": 1234, "startTs": 0,
    "procGroup": [1234, 5678],                    // 新：实验进程组 pid 集合
    "groupStats": {                               // 新：实验组聚合（5s 周期）
      "gpuUtilPct": 87, "gpuMemMiB": 12288, "cpuPct": 340, "memMiB": 6144,
      "memberCount": 2,
      "members": [ { "pid": 1234, "cmd": "python train.py", "gpuUtilPct": 87, "gpuMemMiB": 8192 } ]
    }
  },
  "system": {                                     // 新：非实验组（其他进程）统计
    "gpuMemMiB": null,                            // Windows null（不可拆）
    "gpuUtilPct": 13,                             // 其他进程 GPU 利用率合计
    "topN": [ { "pid": 20144, "cmd": "msedgewebview2.exe", "gpuUtilPct": 9, "memMiB": 512 } ],
    "memMiB": 20480
  }
}
```

### 3.3 Alert（告警对象扩展）

```jsonc
{
  "level": "critical", "rule": "oom", "msg": "实验显存 12G/16G 达阈值；其他进程另占 4G",
  "confidence": 0.9, "actions": ["降低 batch size", "关停 pid 20144 (msedgewebview2.exe) 占 2G"],
  "evidence": { "procs": [ { "pid": 1234, "cmd": "python train.py", "gpuMemMiB": 12288 } ] },
  "ts": 0, "runId": "run-..."
}
```

### 3.4 SamplePoint（ring 元素）/ RunRecord.summary

- `SamplePoint` 增加 `group?: { gpuUtilPct, gpuMemMiB, cpuPct, memMiB, memberCount }`（低频 5s 周期
  才有值，2s 采样点可 null）——供 ring 历史图按实验组曲线展示。
- `RunRecord.summary` 增加 `gpuUtilAvg/max` 保持整卡口径不变（兼容），新增
  `groupGpuMemPeakMiB?`、`otherGpuMemPeakMiB?`（实验组 vs 其他峰值，实验总结更准确）。

---

## 4. 兼容性与消费方

### 4.1 lab-protocol/1.1 → 1.2 兼容规则

- **只加字段，不改语义、不删字段**：所有 1.1 字段（含 `experiment.pid` 单值）原样保留；
  `procGroup/groupStats/system/evidence` 全部**新增**。
- `procs[].gpu` 语义定稿说明：该字段在 1.1 类型中存在但未填充（协议文档未列），1.2 首次填充为
  GPU 利用率 %——需在协议文档 1.2 变更记录中注明「从无到有，非语义变更」。
- 新增字段值可为 null（平台不可得），消费方必须容忍 null（client 已有 null 容忍先例：
  `cpu.percent: null`）。
- 版本号：docs/03-protocol.md 头部 `lab-protocol/1.1` → `1.2`，变更记录列出本文件 §3 增量。

### 4.2 UI（client）消费

- client 现有渲染全部走 1.1 字段（`gpu[0]`/`experiment`/`procs.slice(0,10)`/`alerts`/badge
  `alertsCriticalCount`）——**零改动继续工作**。
- 新增消费（Phase B/C 后，可选 UI 增强）：
  - 实验卡：`experiment.groupStats` 显示「实验组 GPU 87% · 显存 12G · 2 进程」；
  - 新增「系统其他进程」区块：`system.topN` Top-5（pid/cmd/占用）；
  - 告警行：`alert.evidence.procs` 展开进程证据（collapsible）。
- 渲染策略：新字段**渐进增强**——1.2 数据缺失（旧 host 或 null）时 UI 退化为 1.1 视图。

### 4.3 工具（lab_status / lab_advice / lab_ctl）消费

- `lab_status`：返回完整 1.2 快照（含 groupStats/system），**工具签名不变**；
  `brief:true` 单行摘要增加「实验组 G% / 其他进程占 XG」片段（防误报感知优先）。
- `lab_advice`：`advice[]` 每项增加 `evidence`（进程证据），签名不变（追加字段）。
- `lab_ctl set-threshold`：返回体增加 `system` 拆分统计快照（写前可见证据）。
- 工具描述更新（lab_status/lab_advice 的 description 提及进程级归属能力），schema 不变。

---

## 5. 分阶段落地清单（tracking-engineer 执行）

### Phase A：进程级采集（backend，只动 sampler，不影响协议语义）

- [ ] A1 pmon 通道：`nvidia-smi pmon -c 1 -s u` 解析（WindowsBackend + LinuxBackend），
      `procs[].gpuUtilPct` 填充；失败降级 null + sources 标注。
- [ ] A2 compute-apps 通道：`--query-compute-apps=pid,process_name,used_memory`；
      Windows 侧检测 N/A → 置 null（**不虚构**）；Linux 侧填充 `gpuMemMiB`。
- [ ] A3 Linux `memMiB` 补齐：`/proc/<pid>/status` VmRSS；procs 行加 `ppid`。
- [ ] A4 Windows 进程树：CIM Win32_Process 追加 pid/ppid 输出（并入 PS_SYSMEM，TTL 5s）。
- [ ] 合并器：pid 归并单表 + sources 标注（procs: 'ps+pmon' | 'tasklist+pmon' 等）。
- [ ] 验收：verify-sampler.js 扩展——pmon 行解析（含 `-` → 0）、compute-apps N/A 分支、
      ppid 出现、合并表字段齐全；真实进程（llama-server）能匹配到 gpuUtilPct。

### Phase B：实验进程组统计（core，不触发告警语义变化）

- [ ] B1 `RunRecord.procGroup: Set<number>`；`associatePid` → `associateProc`；组存活判定
      （任一成员活即活）；主 pid 兼容保留。
- [ ] B2 进程树扩张：每 5s 用 procs[].ppid 递归纳入子进程，不动点收敛；成员消失沿用
      CRASH_PS_GAP 语义。
- [ ] B3 `proc-aggregator`：G vs 非 G 拆分聚合（§2.2），挂 sampleTick ps 周期。
- [ ] B4 数据面：SamplePoint.group / MonitorSnapshot.experiment.procGroup+groupStats /
      system / summary 扩展（§3），协议文档 1.1→1.2 变更记录同步。
- [ ] 验收：verify-host.js——真实 python 实验 spawn 子进程后 groupStats.memberCount=2、
      system.topN 不含实验成员；无实验时 system 仍在（整卡维度）。

### Phase C：告警规则重写 + Agent 提醒（balancer + 工具）

- [ ] C1 oom 重写：Linux 用 G.gpuMemMiB 主判 + 上下文拆分；Windows 整卡降级判 + 提示。
- [ ] C2 io-bottleneck 重写：G.cpuPct 主判，Windows 降级整机 + 标注。
- [ ] C3 thermal msg 重写（整卡物理量 + G 利用率上下文）；imbalance 保持 + G 分卡。
- [ ] C4 新增 other-occupancy（info）规则（无实验但整卡占用 → 独立提示）。
- [ ] C5 Alert.evidence + actions 动态化（进程证据进告警）；lab_advice/lab_ctl 升级。
- [ ] 验收：e2e——他人占卡场景（造 chrome/llama-server 占用）不误报实验 oom，出
      other-occupancy；实验自身显存超阈值正确 oom 且 evidence 含实验 pid。

---

## 6. 风险与降级

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | **Windows 每进程 GPU 显存 N/A**（已实证） | oom 无法按实验组精确判定 | 双轨：Linux 精确 / Windows 整卡 + 「降级而非误报」归属仲裁（§2.3）；msg 引导人工确认；不虚构数据 |
| R2 | pmon 采样窗口抖动（进程该秒未调度显示 `-`；**实测：突发负载单帧 `-`/0 vs query 25%/98%，持续负载 sm=98 vs query 99 偏差 ≤2**） | G.gpuUtilPct 低估 | **`-c 3` 多帧窗口**取均值/max（实测 3 帧下持续负载每帧均有值、偏差 ≤2；突发负载多帧覆盖间隙）+ `-` 视 0；参考 08 §4.2 dmon vs query 结论（稳定负载偏差 0） |
| R3 | **pid 复用 + 进程重启**（**实测：Ollama 推理时 llama-server pid 55884→51968 变化**） | 进程组误纳他人 / 关联失效 | 组内成员需「cmd 指纹或 ppid 血缘」双校验：同 pid 但 cmd 不匹配 → 剔除并重新关联（状态机现有指纹逻辑复用）；pid 变化时按 cmd 指纹重新关联 |
| R4 | 子进程延迟出生（worker 在下一周期才出现） | 组统计滞后 ≤5s | 可接受（ps 周期即 5s）；文档明示统计是 5s 粒度近似 |
| R5 | CIM 追加查询成本 | 5s 周期多输出几十行 | 并入现有 PS_SYSMEM 单次调用（同 TTL），实测 CIM ~1.5s 冷启动已在 5s TTL 内摊销 |
| R6 | 新增字段使快照体积增大 | procs 全表 + 组明细 | procs 仍 slice(0,15)（1.1 行为）；groupStats/system 为聚合小对象；topN 限 5 条 |
| R7 | 兼容性回归 | 老 client/工具 | §4.1 增量规则 + Phase B/C 每步跑 verify-host/mock-test；1.1 字段零改动 |
| R8 | 无 GPU 机（gpuState=unavailable） | 进程级 GPU 通道全 null | 沿用 1.1 降级：procs/CPU/内存照常，gpu 相关 null，告警规则自动跳过（现有 ok 短路） |

## 7. 关联文档

- 数据模型/协议：docs/02-data-model.md、docs/03-protocol.md（本设计落地时同步 1.2 变更记录）
- 采样实证：docs/research/08-sampling-empirical.md（§4.2 偏差结论）
- 架构：docs/01-architecture.md；UI 消费：docs/05-ui-adapters.md
- 实现迁移：docs/research/12-v2-migration.md
