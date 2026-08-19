# 14 进程级资源跟踪设计（防误报）

> 状态：设计定稿 + 队长预研补充并入（2026-08-20，tracking-designer；**二版：队长最终约束**
> ——GPU 每进程数据源不可靠，防误报以 CPU/内存/存在性为主、GPU 整卡交叉验证，每进程 GPU
> 显存为预留字段当前不启用）。输入：src/core/state-machine.ts、src/core/balancer.ts、
> src/core/types.ts、src/sampler/*（backend-interface/backend-linux/backend-windows/windows-paths）、
> src/index.ts、src/client.ts、docs/02-data-model.md、docs/03-protocol.md、docs/research/08-sampling-empirical.md。
> 全部关键能力经本机（WSL2 + RTX 5060 Ti）实测，实证记录见 §1.3/§2.1/§6。
> 实现者：tracking-engineer（按 §5 分阶段清单落地）；本文档只设计不写实现代码。

## 0. TL;DR

- **误报根因**：balancer 的 oom/io-bottleneck/thermal/imbalance 全部基于「全系统 GPU 首卡」指标
  （`w.gpu[0]`），实验进程与系统其他进程混用同一 GPU——他人占卡被误报成实验 OOM；
  实测本机 GPU 显存占用 93%（15184/16311 MiB）但无实验进程（explorer/chrome/WeChat 等占满），
  oom 规则必然误报。
- **方案四层**：①采集层加「进程级指标通道」（**主：tasklist/ps 每进程 CPU/内存 + 进程存在性 +
  PPID 进程树；辅：pmon 每进程 GPU 利用率**；compute-apps 每进程显存 **预留不启用**）；
  ②统计层引入「实验进程组」（实验 pid 递归扩张含子进程/worker，按组 vs 非实验组拆分聚合）；
  ③告警层规则重写为「**实验进程组自身 CPU/内存/存在性 + GPU 整卡指标交叉验证**为主，
  系统其他进程占用作上下文标注，归属仲裁降级（疑似他人占用→降级而非误报）」；④提醒层把阈值
  触达升级为「带进程级证据的可执行建议」。
- **实证关键（队长最终版，2026-08-20）**：
  - **GPU 每进程数据源在本机不可靠**：① `--query-compute-apps=used_memory` **全部 [N/A]**
    （WDDM 限制，含真实 CUDA 进程 llama-server.exe）→ 每进程 GPU 显存 **不可获取**，
    字段预留但当前不启用；② pmon 每进程 GPU 利用率**仅活动进程有值**（空闲态全 `-`），
    且本机 torch 无 CUDA（`torch.cuda.is_available()=False`），**无法构造真实 GPU 负载验证
    pmon 峰值行为**——Ollama llama-server 压测观察到持续负载 sm=98 vs query 99 偏差 ≤2
    可作为参考，但**不构成硬判定依据**；
  - **因此防误报主信号 = 每进程 CPU/内存（tasklist/ps 已有）+ 进程存在性 + 实验状态机**，
    GPU 整卡指标作交叉验证，每进程 GPU 利用率仅作辅助证据；
  - pid 会变化（Ollama 推理时 llama-server 55884→51968）——进程组需 cmd 指纹血缘重关联。
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
| 每进程 GPU 利用率 | `nvidia-smi pmon -c 1`（**仅活动进程有值**；空闲全 `-`；峰值行为未验证——本机 torch 无 CUDA 无法构造负载） | 同左（Ollama llama-server 压测参考：持续负载 sm=98~99 稳定；prompt 间隙单帧 `-`） | 同左 |
| 每进程 GPU 显存 | `nvidia-smi --query-compute-apps=pid,used_memory`（Linux 有效，但**本机无法验证**） | **used_memory 全 N/A（WDDM）** ✗（含真实 CUDA 进程）→ **预留字段，当前不启用** | 同 WSL ✗ |
| 进程树 | ps ppid 列 ✅ | **CIM Win32_Process.ProcessId/ParentProcessId（本机实测 55884→47680）** ✅（TTL 5s 并入现有 CIM 通道） | 同 WSL ✅ |
| 整卡指标 | query-gpu ✅ | query-gpu（40-60ms，TTL 500ms）✅ | query-gpu ✅ |

> **队长最终约束（2026-08-20）**：GPU 每进程数据源在本机**不可靠**（显存 [N/A]、利用率仅活动
> 进程有值）。**防误报设计以「tasklist/ps 每进程 CPU/内存 + 进程存在性 + 实验状态机」为主，
> GPU 整卡指标交叉验证，每进程 GPU 为辅助证据**；每进程 GPU 显存标注「受限于 [N/A]，
> 预留字段但当前不启用」。

---

## 2. 方案架构（采集 / 统计 / 告警 / 提醒 四层）

```
┌─ 采集层（Phase A, backend）─────────────────────────────────────────────┐
│ 主：通道A3 ps/procfs|tasklist 每进程CPU/内存 + 存在性                    │
│     通道A4 PPID 进程树（ps|CIM）                                          │
│ 辅：通道A1 pmon 每进程GPU利用率（仅活动进程有值，辅助证据）                │
│     通道A2 compute-apps 每进程显存 MiB（**预留字段，当前不启用**）         │
│        ↓ 按 pid 归并 → ProcSample 增强 { gpuUtilPct?, gpuMemMiB?(预留),   │
│          ppid?, cpuPct?, memMiB? }（整表 ≤ 低频 5s）                      │
├─ 统计层（Phase B, core）─────────────────────────────────────────────────┐
│ 实验进程组 G = 主pid ∪ 子进程/worker（PPID 递归，新生 pid 动态纳入）        │
│ 主聚合：G.cpuPct / G.memMiB / 存在性（memberCount/alive）                 │
│ 辅聚合：G.gpuUtilPct（pmon 辅助）/ G.gpuMemMiB（预留 null）                │
│ 非实验组 O = Σ(其他进程 CPU/内存) + Top-N 明细                             │
├─ 告警层（Phase C, balancer）─────────────────────────────────────────────┐
│ 主判据：G 自身 CPU/内存/存在性 + GPU 整卡指标交叉验证                       │
│ 上下文：整卡显存 X% 中实验进程占 Y MiB（估算）+ 其他 N 进程占卡              │
│ 归属仲裁降级：疑似他人占用 → warn 而非 critical；新增「他人占卡」提示         │
└─ 提醒层（Phase C, balancer/tools）───────────────────────────────────────┘
   lab_advice/lab_ctl 升级：阈值触达 → 可执行建议 + 进程级证据（pid/cmd/占用）
```

### 2.1 采集层：进程级指标通道设计

#### 通道 A1：每进程 GPU 利用率（pmon）——**辅助证据**（非主判据）

- 命令：`nvidia-smi pmon -c 3 -s u`（`-c 3` **多帧采样窗口**；`-s u` 只取 util 列，输出更短）。
- 本机实证（2026-08-20）：
  - **空闲态 sm 列全 `-`**（仅活动进程有值）——空闲无 GPU 负载时该通道无信息量；
  - Ollama llama-server 压测参考：持续负载 sm=98/97/98 vs query 99% 偏差 ≤2；prompt 间隙
    单帧 `-`/0 vs query 25%/98%（突发低估）；
  - **本机 torch 无 CUDA（`torch.cuda.is_available()=False`），无法构造更多真实 GPU 负载
    验证峰值行为**——该通道定位为**辅助证据**，不参与告警硬判定。
- 解析：跳过 `#` 注释行；`pid` 列 → `sm`（compute%）、`mem`（memory bandwidth%）；`-` 视作 0。
- 频率：**归 5s 低频**（与 procs/进程树同拍），每次采样取 `-c 3` 三帧均值/max；整卡 util
  仍走 query 高频（dmon 流覆盖）。
- 降级：pmon 失败（驱动不支持/权限）→ `procs[].gpuUtilPct = null`，整卡指标照常，sources 标注。

#### 通道 A2：每进程 GPU 显存（compute-apps）——**预留字段，当前不启用** ★实证

- 命令：`nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader`。
- **Windows/WSL 实测：全部返回 `[N/A]`**（含真实 CUDA 进程 llama-server.exe 55884，type=C）。
  WDDM 驱动不向 nvidia-smi 暴露每进程显存 → **受限于 [N/A]，`procs[].gpuMemMiB` 为预留字段，
  当前不启用**（不采集、不填充、不参与判定）。
- **Linux 原生**：同命令有效（Linux 驱动支持）——留待未来启用（本机为 WSL，当前亦不启用）。
- 设计说明：每进程显存是「理想值」但本机数据源不可靠；**防误报不依赖它做硬判定**，
  显存维度用「整卡 + 上下文标注」呈现（§2.3），避免虚构数据（项目「防脏数据」原则）。

#### 通道 A2b：每进程显存的实验组估算——不启用（并入上下文标注）

- 每进程 GPU 显存不可得（Windows N/A；Linux 未启用）→ **G.gpuMemMiB 恒为 null**；
- 显存维度改由**上下文标注**承担：`整卡显存 X% 中实验进程占 Y MiB（估算，不可拆）+ 系统
  其他 N 进程占卡`——Y 仅作展示性估算（如按实验进程 host 内存比例或留空），**不做判定输入**；
- 判定改用「整卡显存 + 实验组 CPU/内存活跃度」组合（§2.3 交叉验证）。

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
procs = tasklist|ps 基表（pid → cmd/cpuPct/memMiB/ppid）   ← 主通道
      ⊕ pmon 行（pid → gpuUtilPct，辅助；失败则无此列）
      ⊕ compute-apps 行（pid → gpuMemMiB，**预留不启用**，恒 null）
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
`groupStats = { cpuPct, memMiB, memberCount, alive, members:[{pid,cmd,cpuPct,memMiB}], gpuUtilPct?(辅), gpuMemMiB?(预留 null) }`
`otherStats = { cpuPct, memMiB, topN:[{pid,cmd,cpuPct,memMiB}], gpuMemMiB?(预留 null) }`

聚合规则（**主：CPU/内存/存在性；辅：GPU 每进程**）：
- **主**：CPU/内存——G 成员 cpuPct/memMiB 求和（Linux 双全；Windows cpuPct 全 null → 仅
  memMiB 可拆 + 存在性 alive/memberCount）；非实验组 = 全表 − G（pid 差集）。
- **辅**：GPU 利用率——G 成员 gpuUtilPct 求和截 100（pmon，仅活动进程有值；空闲/不可得为
  null，不参与硬判定）。
- **预留**：GPU 显存——`gpuMemMiB` 恒 null（通道 A2 不启用），仅上下文标注使用。

### 2.3 告警层：规则重写（防误报核心）

**防误报核心逻辑（队长最终约束，2026-08-20）——「CPU/内存/存在性为主 + GPU 整卡交叉验证 +
归属仲裁降级」**：

1. **主判据（实验进程组自身）**：G 的 CPU/内存/存在性（进程活着、CPU/内存有显著占用）
   + GPU 整卡指标（query-gpu）交叉验证——**不依赖不可靠的每进程 GPU 显存/利用率硬判定**；
2. **上下文标注**：整卡显存高时，msg 标注 `整卡显存 X% 中实验进程占 Y MiB（估算，不可拆）+
   系统其他 N 进程占卡，疑似他人负载`——把「他人占卡」从误报源变成可解释信息；
3. **归属仲裁降级**：实验存在但 G 活跃度低（CPU/内存占比低）而整卡显存高 → 降级 warn
   「疑似他人占用，非实验 OOM」；无实验 → other-occupancy info 独立提示。

| 规则 | 现状（全系统首卡） | 重写后（实验组 CPU/内存/存在性 + 整卡交叉 + 上下文） |
|---|---|---|
| **oom** | `gpu[0].memUsed% ≥ memWarn && util ≥ utilWarn` | **交叉验证**：整卡 used% ≥ memWarn 时查 G——① G 活跃（CPU/内存占用高 或 进程存在且 pmon 有值）→ critical「实验显存风险（整卡 X%，实验进程占 Y MiB 估算）」；② G 不活跃（低 CPU/内存、pmon 无值）→ **降级 warn**「整卡显存 X%，实验进程仅 Y MiB（估算）/活跃度低，系统其他 N 进程占卡，疑似他人负载」；③ 无实验 → other-occupancy。上下文：`实验 X GiB（估算）+ 其他 Y GiB = 总 Z/Z GiB` |
| **io-bottleneck** | `gpu[0].util < 30 && 整机 cpu ≥ 90` | `G.cpuPct ≥ 90 && 整卡 util < 30`（**实验自身 CPU 满载 + GPU 空闲**才是数据管线瓶颈）；G.cpuPct 不可得（Windows）→ 降级整机 cpu 并标注「无法按进程拆分 CPU，基于全机判断」 |
| **thermal** | 整卡温度 ≥ tempWarn | 保持整卡（物理量不可拆），msg 改为「GPU 温度达阈值（整卡物理量；若实验进程 CPU/内存活跃度低则非实验负载引起）」+ 上下文 G 活跃度 |
| **imbalance** | 多卡 util 差 ≥ 40 | 保持整卡（多卡间本就无进程边界） |
| **新增 other-occupancy** | 无 | G 未 running（idle）但整卡显存 ≥ memWarn → 提示「系统其他进程占用 GPU 显存 X/X GiB（Top: pid/cmd）」——把「他人占卡」从误报源变成**独立提示**（info 级，不惊扰） |

防抖保持：阈值持续 10s + 同类 5min（现有 hitByRule/lastByRule 机制不动）。

### 2.4 提醒层：Agent 可执行建议升级

现状：`Alert.actions: string[]`（静态文案，如「降低 batch size」）+ lab_advice 返回动作数组。

升级为**「证据 + 动作」两段式**（告警对象扩展，§3.2）：

- **证据段**（`evidence: { procs: [{pid, cmd, cpuPct, memMiB, gpuUtilPct?}] }`）：
  告警触发时附 **Top-5 相关进程**（实验组内优先 + 其他进程占用 Top），Agent 一眼定位「谁在占」；
  GPU 每进程字段仅在有值（pmon 活动进程）时附，缺失不阻塞。
- **动作段**（`actions[]` 按证据细化）：
  - oom（实验自身）：`降低 batch size` + `检查实验进程 pid 1234 (python train.py) 内存占用`；
  - oom（疑似他人）：`整卡显存高但实验进程活跃度低，建议检查 pid 20144 (msedgewebview2.exe) 等
    其他进程占卡`；
  - other-occupancy：`当前无实验但显存被占，建议检查 pid 1234 (WeChat.exe)`；
  - io-bottleneck：`实验 CPU 满载（G.cpu 95%），增加 num_workers 或检查数据管线`；
  - thermal：`若实验进程活跃度低（G CPU/内存低），温度高疑为其他进程/散热，检查风扇`。
- **lab_ctl set-threshold 升级**：写阈值时返回当前拆分统计（快照语义），Agent 设置前可见证据。

---

## 3. 数据模型扩展

### 3.1 ProcSample（backend-interface.ts，进程条目增强）

```ts
export interface ProcSample {
  pid: number
  cmd: string
  cpuPct?: number | null          // 现字段（Linux 有；Windows null）——主通道
  memMiB?: number | null          // 现字段（tasklist 有；Linux 由 VmRSS 补齐）——主通道
  ppid?: number | null            // 新：父进程 id（进程树骨架）——主通道
  gpu?: number | null             // 现预留字段 → 语义定稿：**GPU 利用率 %**（pmon sm 列，辅助）
  gpuUtilPct?: number | null      // 新：与 gpu 同值（显式命名，gpu 保留兼容；仅活动进程有值）
  gpuMemMiB?: number | null       // 新：每进程显存 —— **预留字段，当前不启用（N/A 受限，恒 null）**
}
```

> 注意：`gpu` 字段 v1.1 已存在于类型定义但**从未被填充**（协议未列），1.2 语义定稿为
> 「GPU 利用率 %（pmon，辅助证据）」——属**首次填充而非语义变更**，按 §4.1 兼容规则在
> 1.2 变更记录中明示；`gpuMemMiB` 声明为预留、当前不启用（受限于 N/A，不采集不填充）。

### 3.2 MonitorSnapshot（对外协议 lab-protocol/1.1 → 1.2 增量）

```jsonc
{
  // ... 1.1 全部字段不变 ...
  "procs": [ /* ProcSample 增强：+ppid（主）/ +gpuUtilPct（辅，仅活动进程）/ +gpuMemMiB（预留 null） */ ],
  "experiment": {
    "runId": "...", "state": "...", "cmd": "...", "pid": 1234, "startTs": 0,
    "procGroup": [1234, 5678],                    // 新：实验进程组 pid 集合（主）
    "groupStats": {                               // 新：实验组聚合（5s 周期，主=CPU/内存/存在性）
      "cpuPct": 340, "memMiB": 6144, "memberCount": 2, "alive": true,
      "gpuUtilPct": 87,                            // 辅：pmon，仅活动进程有值
      "gpuMemMiB": null,                           // 预留：恒 null（不启用）
      "members": [ { "pid": 1234, "cmd": "python train.py", "cpuPct": 340, "memMiB": 6144 } ]
    }
  },
  "system": {                                     // 新：非实验组（其他进程）统计
    "cpuPct": 120, "memMiB": 20480,               // 主：其他进程 CPU/内存合计
    "topN": [ { "pid": 20144, "cmd": "msedgewebview2.exe", "cpuPct": 12, "memMiB": 512 } ],
    "gpuMemMiB": null,                            // 预留：恒 null（不启用）
    "gpuUtilPct": 13                              // 辅：pmon 其他进程合计
  }
}
```

### 3.3 Alert（告警对象扩展）

```jsonc
{
  "level": "critical", "rule": "oom",
  "msg": "整卡显存 15G/16G 达阈值；实验进程占 12G（估算），其他 8 进程占卡 3G",
  "confidence": 0.9,
  "actions": ["降低 batch size", "检查实验进程 pid 1234 内存占用"],
  "evidence": { "procs": [ { "pid": 1234, "cmd": "python train.py", "cpuPct": 340, "memMiB": 6144 } ] },
  "ts": 0, "runId": "run-..."
}
```

### 3.4 SamplePoint（ring 元素）/ RunRecord.summary

- `SamplePoint` 增加 `group?: { cpuPct, memMiB, memberCount, alive, gpuUtilPct? }`（低频 5s 周期
  才有值，2s 采样点可 null）——供 ring 历史图按实验组 CPU/内存曲线展示；GPU 显存不进 ring。
- `RunRecord.summary` 增加 `groupCpuMax?`、`groupMemPeakMiB?`、`otherMemPeakMiB?`（实验组 vs
  其他进程峰值，实验总结更准确）；整卡口径摘要（gpuUtilAvg/max）保持不变（兼容）。

---

## 4. 兼容性与消费方

### 4.1 lab-protocol/1.1 → 1.2 兼容规则

- **只加字段，不改语义、不删字段**：所有 1.1 字段（含 `experiment.pid` 单值）原样保留；
  `procGroup/groupStats/system/evidence` 全部**新增**。
- `procs[].gpu` 语义定稿说明：该字段在 1.1 类型中存在但未填充（协议文档未列），1.2 首次填充为
  GPU 利用率 %（辅助证据）——需在协议文档 1.2 变更记录中注明「从无到有，非语义变更」；
  `gpuMemMiB` 声明为预留字段、当前不启用（受限于 N/A），消费方按 null 处理。
- 新增字段值可为 null（平台不可得），消费方必须容忍 null（client 已有 null 容忍先例：
  `cpu.percent: null`）。
- 版本号：docs/03-protocol.md 头部 `lab-protocol/1.1` → `1.2`，变更记录列出本文件 §3 增量。

### 4.2 UI（client）消费

- client 现有渲染全部走 1.1 字段（`gpu[0]`/`experiment`/`procs.slice(0,10)`/`alerts`/badge
  `alertsCriticalCount`）——**零改动继续工作**。
- 新增消费（Phase B/C 后，可选 UI 增强）：
  - 实验卡：`experiment.groupStats` 显示「实验组 CPU 340% · 内存 6G · 2 进程」（GPU 每进程
    仅活动进程有值时显示，缺失隐藏）；
  - 新增「系统其他进程」区块：`system.topN` Top-5（pid/cmd/CPU/内存）；
  - 告警行：`alert.evidence.procs` 展开进程证据（collapsible）。
- 渲染策略：新字段**渐进增强**——1.2 数据缺失（旧 host 或 null）时 UI 退化为 1.1 视图。

### 4.3 工具（lab_status / lab_advice / lab_ctl）消费

- `lab_status`：返回完整 1.2 快照（含 groupStats/system），**工具签名不变**；
  `brief:true` 单行摘要增加「实验组 CPU/内存 + 其他进程占卡提示」片段（防误报感知优先）。
- `lab_advice`：`advice[]` 每项增加 `evidence`（进程证据），签名不变（追加字段）。
- `lab_ctl set-threshold`：返回体增加 `system` 拆分统计快照（写前可见证据）。
- 工具描述更新（lab_status/lab_advice 的 description 提及进程级归属能力），schema 不变。

---

## 5. 分阶段落地清单（tracking-engineer 执行）

### Phase A：进程级采集（backend，只动 sampler，不影响协议语义）

- [ ] A1 pmon 通道（**辅助**）：`nvidia-smi pmon -c 3 -s u` 解析（WindowsBackend + LinuxBackend，
      多帧取均值/max，`-` 视 0），`procs[].gpuUtilPct` 填充；失败降级 null + sources 标注——
      **不参与告警硬判定**。
- [ ] A2 compute-apps 通道：**声明为预留、当前不启用**——`gpuMemMiB` 恒 null（N/A 受限），
      实现可跳过采集，仅在 backend 接口保留字段定义。
- [ ] A3 Linux `memMiB` 补齐：`/proc/<pid>/status` VmRSS；procs 行加 `ppid`（主通道）。
- [ ] A4 Windows 进程树：CIM Win32_Process 追加 pid/ppid 输出（并入 PS_SYSMEM，TTL 5s，主通道）。
- [ ] 合并器：pid 归并单表 + sources 标注（procs: 'ps' | 'tasklist' | 'ps+pmon' | 'tasklist+pmon'）。
- [ ] 验收：verify-sampler.js 扩展——pmon 行解析（含 `-` → 0）、ppid 出现、合并表字段齐全；
      主通道（CPU/内存/ppid）在 Windows+Linux 均可用。

### Phase B：实验进程组统计（core，不触发告警语义变化）

- [ ] B1 `RunRecord.procGroup: Set<number>`；`associatePid` → `associateProc`；组存活判定
      （任一成员活即活）；主 pid 兼容保留。
- [ ] B2 进程树扩张：每 5s 用 procs[].ppid 递归纳入子进程，不动点收敛；成员消失沿用
      CRASH_PS_GAP 语义。
- [ ] B3 `proc-aggregator`：G vs 非 G 拆分聚合（§2.2，主=CPU/内存/存在性，辅=GPU 每进程），
      挂 sampleTick ps 周期。
- [ ] B4 数据面：SamplePoint.group / MonitorSnapshot.experiment.procGroup+groupStats /
      system / summary 扩展（§3），协议文档 1.1→1.2 变更记录同步。
- [ ] 验收：verify-host.js——真实 python 实验 spawn 子进程后 groupStats.memberCount=2、
      system.topN 不含实验成员；无实验时 system 仍在（整卡维度）。

### Phase C：告警规则重写 + Agent 提醒（balancer + 工具）

- [ ] C1 oom 重写：**交叉验证 + 归属仲裁**——整卡 used% ≥ memWarn 时查 G 活跃度（CPU/内存/
      存在性），G 活跃 → critical，G 不活跃 → 降级 warn「疑似他人占用」；上下文标注
      「整卡 X% 中实验进程占 Y MiB（估算）+ 其他 N 进程占卡」。
- [ ] C2 io-bottleneck 重写：`G.cpuPct ≥ 90 && 整卡 util < 30` 主判，G.cpuPct 不可得（Windows）
      降级整机 + 标注。
- [ ] C3 thermal msg 重写（整卡物理量 + G 活跃度上下文）；imbalance 保持。
- [ ] C4 新增 other-occupancy（info）规则（无实验但整卡占用 → 独立提示）。
- [ ] C5 Alert.evidence + actions 动态化（进程证据进告警，CPU/内存为主）；lab_advice/lab_ctl 升级。
- [ ] 验收：e2e——他人占卡场景（造 chrome/llama-server 占用）**降级为「疑似他人占用」而非误报
      实验 oom**；实验自身活跃（CPU/内存高）且整卡超阈正确 oom 且 evidence 含实验 pid；
      无实验时出 other-occupancy。

---

## 6. 风险与降级

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | **Windows 每进程 GPU 显存 N/A**（已实证）→ **每进程 GPU 数据源不可靠**（显存 N/A、利用率仅活动进程有值；torch 无 CUDA 无法验证峰值） | 每进程 GPU 显存/利用率**不能作硬判定** | **每进程 GPU 显存 = 预留字段当前不启用**；防误报主信号 = 实验组 CPU/内存/存在性 + GPU 整卡交叉验证；每进程 GPU 利用率仅辅助证据（§2.3） |
| R2 | pmon 采样窗口抖动（进程该秒未调度显示 `-`；**实测：突发负载单帧 `-`/0 vs query 25%/98%，持续负载 sm=98 vs query 99 偏差 ≤2**） | G.gpuUtilPct 低估（辅助证据失真） | **`-c 3` 多帧窗口**取均值/max + `-` 视 0；因仅作辅助证据，失真不影响主判定；参考 08 §4.2 偏差结论 |
| R3 | **pid 复用 + 进程重启**（**实测：Ollama 推理时 llama-server pid 55884→51968 变化**） | 进程组误纳他人 / 关联失效 | 组内成员需「cmd 指纹或 ppid 血缘」双校验：同 pid 但 cmd 不匹配 → 剔除并重新关联（状态机现有指纹逻辑复用）；pid 变化时按 cmd 指纹重新关联 |
| R4 | 子进程延迟出生（worker 在下一周期才出现） | 组统计滞后 ≤5s | 可接受（ps 周期即 5s）；文档明示统计是 5s 粒度近似 |
| R5 | CIM 追加查询成本 | 5s 周期多输出几十行 | 并入现有 PS_SYSMEM 单次调用（同 TTL），实测 CIM ~1.5s 冷启动已在 5s TTL 内摊销 |
| R6 | 新增字段使快照体积增大 | procs 全表 + 组明细 | procs 仍 slice(0,15)（1.1 行为）；groupStats/system 为聚合小对象；topN 限 5 条 |
| R7 | 兼容性回归 | 老 client/工具 | §4.1 增量规则 + Phase B/C 每步跑 verify-host/mock-test；1.1 字段零改动 |
| R8 | 无 GPU 机（gpuState=unavailable） | 进程级 GPU 通道全 null | 沿用 1.1 降级：procs/CPU/内存照常（主通道不受影响），gpu 相关 null，告警规则自动跳过（现有 ok 短路） |
| R9 | **Windows 侧 G.cpuPct 不可得**（CIM LoadPercentage 为整机值） | 实验组 CPU 主判据缺失 | io-bottleneck 降级整机 CPU + 标注；oom 归属仲裁用「G.memMiB + 存在性」代替 CPU 活跃度；typeperf 每进程 CPU 留 P2 |

## 7. 关联文档

- 数据模型/协议：docs/02-data-model.md、docs/03-protocol.md（本设计落地时同步 1.2 变更记录）
- 采样实证：docs/research/08-sampling-empirical.md（§4.2 偏差结论）
- 架构：docs/01-architecture.md；UI 消费：docs/05-ui-adapters.md
- 实现迁移：docs/research/12-v2-migration.md
