# 21 T2 调研报告：告警分级与实验类型识别现状（设计输入）

> 状态：**调研报告**（2026-08-23，Issue #5 综合设计 T2 输入）。
> 范围：lab-monitor 现有「告警分级 / 实验跟踪 / 状态机」事实 + 「实验类型识别方案」设计输入。
> 方法：源码逐文件核对（balancer / state-machine / constants / types / index / client / proc-aggregator / sampler）+ 现网数据实证（`~/.dsh/settings.yaml` lab-monitor 段 history）+ docs/research 系列 + git log + GitHub issue #5。
> 供：designer（综合方案）、reviewer（评审）、researcher-agent-model（T1 通信/权限调研交叉引用）。

---

## 0. 核心结论（≤1000 字）

1. **告警分级只有「level 一维」**：`critical / warn / info` 三档，辅以离散 confidence（critical=0.85、warn/info=0.7、外部 push 默认 0.9——balancer.ts:374/407）。**没有「严重度 × 紧迫性 × 持续时间」多维模型**：持续时间只用作固定 10s 防抖（`MIN_HITS=5`，balancer.ts:252），不发生升级（持续恶化不会从 warn 升 critical）；5 分钟防重（`MIN_INTERVAL_MS`，balancer.ts:253）+ 24h TTL（balancer.ts:255）+ 20 条上限（constants.ts:16）。告警消费者共 5 类：UI badge（`alertsCriticalCount`）、面板 AlertList（`snapshotAlerts`）、`lab_status`/`lab_advice` 工具（advice Top5）、promptLine 注入（默认关）、`emitLab('lab/alert')` 事件（**现状仅 console.log，无人消费——正是 Issue #5 方案 F 的接入点**，docs/research/20 §4）。**扩展空间充分**：`Alert.level` 类型留有 `| string` 逃逸口（types.ts:108），可加子级/权重/趋势字段而不破坏消费端。
2. **实验识别现状 = 仅「训练命令形态」粗判**：`TRAIN_PATTERNS` 5 条（constants.ts:35-41）→ `cmdFeature` 5 个取值（'python train*.py'/'python -c'/'python -m'/'torchrun'/'deepspeed'）+ null。**冒烟/回归/全量/长短/GPU计算/GPU训练 完全无法区分**——没有任何 type 字段。现网实证（settings.yaml history 20 条）：**大量误报**——grep 命令、`gh issue create` heredoc、docx 检查 `python -c` 一行脚本全部被记为「实验」（cmdFeature=torchrun/python -c），且多为 8~18s 短命。`/torchrun\b/i` 裸词正则 + `python -c/-m` 全匹配是误报主因。
3. **识别信号真实可用**：命令全文（含脚本名/参数）→ 关键字+脚本名分类（冒烟/回归，需正则细化）；`cmdFeature` → 训练器家族（torchrun/deepspeed/train*.py=训练倾向）；进程数/时长/资源画像（groupStats、sampleStats、summary）→ 运行时确认；`ended[].summary.durationSec` → 历史时长分布（学习层）；**exit code 现状不可得**（markResult 只收 paired 布尔，state-machine.ts:217-229），需扩展才能用。另有两条现成捷径：`tags` 规则（用户已用「py实验」标签，kind=experiment）和 `Alert.runId`（告警已按实验归属，index.ts:417-418）。
4. **识别方案应三层**：自动层（关键字/脚本名/训练器正则，只做正向命中、未命中=未分类，防误报优先）；配置层（experimentTypes 规则：pattern→类型→通知策略覆盖，复用 tags 的 regex 规则形态；默认值/预期时长/通知档位）；学习层（按 cmdFingerprint 存历史时长分布与资源画像，二次出现自动归类，首见用默认策略）。配置放包外（settings 命名空间 lab-monitor 增键，schema 在插件内）——与 thresholds/watchProcs/tags/history 同模式。
5. **接线缺口（实现层要点）**：`setAlerting()` 定义但**从未被调用**（grep 全仓仅 state-machine 内部），实验快照 state 恒为 'running'（alerting 投影死代码，state-machine.ts:293-311）——「实验处于告警中」这一状态现实上不存在，综合设计若要「实验级告警状态」需先接线 balancer→setAlerting。

---

## 1. 告警分级现状全貌

### 1.1 规则明细（RULES，balancer.ts:105-250）

| rule | 声明 level | 动态 level | 触发条件（check） | 防抖/防重 | msg 形态 | confidence | actions | evidence | 归属 |
|---|---|---|---|---|---|---|---|---|---|
| `oom` | critical | **critical / warn 动态降级**（组活跃→critical；组不活跃→warn「疑似他人」） | 首卡 `memUsedPct ≥ memWarn(95)`（balancer.ts:112-114） | MIN_HITS=5（10s）/ 5min | 动态：百分比+GiB+组活跃度+N进程 / 或「活跃度低+系统其他N进程占卡」 | critical 0.85 / warn 0.7 | 降 batch size / 检查 pid | 组成员(≤3)+topN(≤2)+backend procs(≤2) | 主实验 runId |
| `io-bottleneck` | warn | — | 首卡 `utilPct < 30` **且** 实验活跃 **且**（组 `cpuPct ≥ 90` 或退化整机 `cpuPct ≥ 90` 并标注「无法按进程拆分」）（balancer.ts:149-172） | 同 | 动态：组 CPU 满载+GPU 低 / 整机退化 | 0.7 | 增加 num_workers / 检查磁盘 IO | 同上 | 主实验 runId |
| `thermal` | warn | — | 首卡 `tempC ≥ tempWarn(85)`（balancer.ts:181-191） | 同 | 动态：温度+组活跃度上下文 | 0.7 | 降功耗 / 查散热 | 同上 | 主实验 runId |
| `imbalance` | info | — | ≥2 卡且 `max(util)-min(util) ≥ 40`（balancer.ts:200-206） | 同 | 静态：'多 GPU 负载不均' | 0.7 | 调整 batch/DDP 切分 | — | 主实验 runId |
| `other-occupancy` | info | — | **无实验** + `memUsedPct ≥ memWarn`（balancer.ts:214-246） | 同 | 动态：无实验+显存占用+Top 占卡进程（GPU>0 优先，2026-08-20 归因修复） | 0.7 | 检查 pid 占卡 | 候选进程(≤5) | runId null |
| `experiment-crash` | critical（external） | — | 进程组消失 ≥2 个 ps 周期（10-15s）且无配对 result（state-machine.ts:276-282 → conclude → pushExternal） | TTL/上限同流；无 5min 防重（external 直入） | 静态+runId：'实验进程意外退出，无配对 result' | **0.9**（pushExternal 默认，balancer.ts:407） | 检查日志/最近 kill | — | crash 的 runId（state-machine.ts:154-163） |

> 附：`oom` 三分支归属仲裁（balancer.ts:105-140）：实验活跃+组活跃 → critical「实验自身」；实验活跃+组不活跃 → warn「疑似他人」；无实验 → 交给 `other-occupancy`。这是目前唯一「动态分级」实例——**分级与归属（self/other）耦合**。

### 1.2 分级形态：只有 level 一维 + 离散 confidence

- `Alert`（types.ts:107-117）：`level: 'critical'|'warn'|'info'|string`（有 string 逃逸口）、`rule`、`msg`、`confidence`、`actions`、`evidence`、`ts`、`runId`。
- confidence 由**最终 level** 决定：`level === 'critical' ? 0.85 : 0.7`（balancer.ts:374）；external 默认 0.9（balancer.ts:407）。
- **没有**「严重度 × 紧迫性 × 持续时间」多维字段：持续时间只作为**固定 10s 阈值持续门槛**（`MIN_HITS = round(10000/SAMPLE_MS)=5`，balancer.ts:252，SAMPLE_MS=2000 constants.ts:6），**不参与升级或分级**；`hitByRule` 命中计数在发出后清零（balancer.ts:368），持续恶化期间只受 5min 防重约束，**warn 永远不会自动升 critical**。

### 1.3 告警生命周期与防重

- `MIN_INTERVAL_MS = 5min`（balancer.ts:253）：同 rule 防重；`ALERT_TTL_MS = 24h`（balancer.ts:255，2026-08-22 新增，读路径兜底过期清理）；`ALERT_MAX = 20`（constants.ts:16，截断同步扣 critical 计数，balancer.ts:306-313）；`clear(filter?)` 支持 runId/rule 定向清除（balancer.ts:315-344）。

### 1.4 alerts 流消费者清单（全部 5 类）

| 消费者 | 入口 | 数据源 | 证据 |
|---|---|---|---|
| ① UI badge / tab 摘要 | client labelThunk / summaryLine | `alertsCriticalCount`（`balancer.count()`） | index.ts:234（promptLine '告警: N条'）；client.ts:253-266 summaryLine 'N告警' |
| ② 面板告警列表 AlertList | client 轮询 snapshot | `snapshotAlerts()`（倒序 Top10） | balancer.ts:396-399；client.ts:47-55/AlertView |
| ③ `lab_advice` 工具（Agent 建议） | tools 注册 | `balancer.advice()`（Top5，含 level/rule/msg/confidence/actions/evidence） | balancer.ts:419-432；index.ts:997-1015 |
| ④ `lab_status` 工具 / HTTP snapshot | tools / webServer | 完整快照 `alerts` + `alertsCriticalCount` | index.ts:591-627/buildSnapshot |
| ⑤ `emitLab('lab/alert')` 事件 | 内部 lab 事件总线 | balancer.evaluate / pushExternal 发出 | balancer.ts:383-390；index.ts:294-306（**现状仅 console.log**，20-issue5 方案 F 在此接入 notifier） |

> 附注：promptLine 注入（`sp.variable('labstatus')`，index.ts:1105-1120）默认关（`promptInjection=false`，KV 缓存友好，issue #5 背景）。

### 1.5 「严格分级」扩展空间

- **可扩展，且无破坏**：`Alert.level` 已是 `| string`（types.ts:108）；advice/snapshot 透传整个 Alert，加字段即全链可见。
- 候选维度（供 designer）：
  1. **rule 语义权重**：per-rule 严重度权重表（如 crash=1.0、oom=0.9、thermal=0.8、io-bottleneck=0.6、other-occupancy=0.3）→ 通知档位映射；
  2. **持续恶化趋势**：`hitByRule` 已累计「连续命中数」，可扩为「超阈值时长 sustainedMs」并升级（warn 持续 >N 分钟 → 升 critical 通知）；
  3. **归属维度**（已有先例）：oom 的动态降级证明「self/other」可作为独立维度；
  4. **紧迫性**：可基于 evidence 进程活动度/趋势推导（现 `groupActive` 判据 balancer.ts:77-83 可复用）。
- 注意：5min 防重与 24h TTL 是「通知轰炸」护栏，分级扩展不得绕过（通知策略应叠加在其后）。

---

## 2. 实验跟踪现状

### 2.1 RunRecord 字段与状态机（state-machine.ts / types.ts:54-76）

| 字段 | 含义 | 值域/来源 |
|---|---|---|
| `runId` | `run-YYYYMMDD-NNN` | `makeRunId()`（constants.ts:80-87），跨重启不保证唯一前缀（日期+当日计数，P2 修复了 tag 的 id，runId 未改） |
| `cmd` | pre-execute 捕获的完整命令 | index.ts:1125-1140（bash/run_code 的 command/code） |
| `cmdFeature` | TRAIN_PATTERNS 命中名 | 5 值+null（见 2.2） |
| `pid` / `procGroup` | 主进程 / 进程组集合（ppid BFS 扩张） | state-machine.ts:242-267 |
| `startTs` / `endTs` | 生命周期 | archive() 置 endTs（state-machine.ts:138-146） |
| `state` | `running/done/crashed/aborted` | archive 语义：endReason 映射（state-machine.ts:141）；**'alerting' 仅存在于快照投影**（`run.alerting ? 'alerting' : 'running'`，state-machine.ts:301），且 `setAlerting` 无调用方 → 恒 'running'（死代码，见 0.5） |
| `endReason` | done/crashed/aborted | markResult+procGone 双确认 done；pidMissingStreak≥2 crashed；超并行上限 aborted |
| `fingerprint` | 进程关联指纹 | `cmdFingerprint()`（constants.ts:60-72） |
| `resultSeen` / `graceTicks` | done 双确认 2/2 | state-machine.ts:217-229/286-290 |
| `alerting` / `procGone` / `pidMissingStreak` | 告警态 / 存活判定 | 同上 |
| `groupStats` | 5s 周期组聚合（CPU/内存/成员数/GPU） | proc-aggregator.ts:72-107；index.ts:391-395（per-run 独立聚合） |
| `sampleStats` | GPU 峰值/均值/显存峰值/组 CPU 峰值/他占内存峰值 | index.ts:350-358/397-402 |
| `summary` | 归档摘要（超 RING_MAX_MS 标 dataPartial） | state-machine.ts:124-136 |

状态机事件（emitLab）：
- `lab/experiment-start`：`{runId, cmd, cmdFeature, startTs}`（state-machine.ts:197）
- `lab/alert`：`{level, rule, msg, confidence, actions, evidence}`（balancer.ts:383-390；index.ts:320-326）
- 无 `lab/experiment-end` 事件（done/crashed 只走 archive + 可选 emitAlert），**结束事件缺失是通知方案的一个缺口**（「实验结束/结果」目前只能轮询 snapshot.ended）。

### 2.2 TRAIN_PATTERNS / matchTrainFeature / cmdFingerprint（constants.ts:34-77）

- `TRAIN_PATTERNS`（5 条，名称即 cmdFeature 取值）：
  1. `python train*.py`：`(?:^|[^a-z0-9._-])(?:python3?|uv)\s+(?:\S+[\/\\])?train[^\s'" ]*\.py`
  2. `python -c`：`python3?\s+-c\b`
  3. `python -m`：`python3?\s+-m\b`
  4. `torchrun`：`torchrun\b`（**裸词，任何位置命中即算**——误报主因）
  5. `deepspeed`：`deepspeed\b`
- `matchTrainFeature(cmd)`：**顺序遍历首中即返** pattern.name，未命中 null（constants.ts:43-49）。
- `cmdFingerprint(cmd)`：`.py` 文件名 → `pyc:`+`-c` 后 48 字符 → torchrun/deepspeed 前 6 token(80 字符) → 首 token(40 字符)（constants.ts:60-72）。

### 2.3 实验类型识别现状边界

- **完全无法识别类型**：没有 type 字段、没有冒烟/回归/全量/长短/计算/训练概念。现有识别边界 = 2 层：
  - 层 1（自动）：`matchTrainFeature` 只回答「命令长没长训练样」（且精度差，见 2.4）；
  - 层 2（用户声明）：`tags` 规则（index.ts:261-278，TagRule types.ts:120-131）——用户可打任意标签并标 `kind: experiment/process`（实测用户已挂「py实验」标签：`pythonw.exe|python.exe`），但这是**自由文本标签，不是类型体系**。
- **误报实证**（settings.yaml lab-monitor.history，2026-08-23 现网）：20 条 ended 记录中**几乎没有真实训练**，多为：
  - `grep -rn "…torchrun\|deepspeed…" docs/…` → cmdFeature **torchrun**（run-20260823-003，状态 crashed，8s）——grep 模式串命中正则！
  - `gh issue create … --body-file`（heredoc 含 "torchrun" 字样）→ cmdFeature **torchrun**（run-20260823-002）
  - `python3 -c "import zipfile…docx 检查"` → cmdFeature **python -c**（run-20260823-022/020/019…，均为工具脚本）
  - `.venv/bin/python -c "import torch; print(…)"` → **python -c**（run-20260823-017，实为环境验证）
  - 全部 durationSec 8~18s、gpuUtilMax ≤11。
- **推论**：任何「实验类型自动识别」都必须先处理 `python -c/-m` 与 `torchrun/deepspeed` 裸词的**精度问题**（建议仅在出现训练器句式时命中：如 torchrun 后跟脚本、python -c 不含常见工具调用特征），否则类型特征的先验分布会被污染。

### 2.4 历史数据可获得性（学习层原料）

- **settings.yaml history**：已持久化 20 条 ended（含完整 summary：durationSec/gpuUtilMax/gpuUtilAvg/memPeak/groupCpuMax/groupMemPeakMiB/otherMemPeakMiB），重启 restoreEnded 恢复（index.ts:330-357/714-719）——**这就是学习层的现成语料**（虽当前全是误报样本，精修识别后即有效）。
- **docs/research 实验例子**：10-p1-e2e-test.md T1 用 `python3 -c 'import time; time.sleep(20)'`（→done）；demo 原为 sleep 300；15-e2e-full-run.md T1-T5 全过；14-process-tracking-design.md 有 `python train.py` 示例（设计文档非真实）。README 无分类概念。
- **git log**：无 smoke/regression/full 相关提交；最近相关是 A2「多轨+标签分组」（5995af9）与 P2「实验历史持久化」（260a7bf）——**类型分类是全新领域，无历史包袱**。

---

## 3. 实验类型识别的信号盘点

### 3.1 信号 → 可推断类型 → 可靠性（信号-类型表）

| # | 信号（数据面位置） | 可推断类型 | 可靠性 | 判定方式 |
|---|---|---|---|---|
| S1 | 命令全文（`run.cmd`，pre-execute 捕获） | 冒烟/回归/训练/计算（关键词） | **高（命中即准）**，召回依赖命名约定 | 正则：`smoke\|冒烟\|--smoke\|test_smoke`、`regression\|回归\|run_regression`、`train.py\|--epochs\|--batch` |
| S2 | 脚本文件名（`fingerprint` 的 `.py` 段，constants.ts:62） | 冒烟/回归/全量/训练 | 高（命名约定好的仓库） | `smoke_*.py`/`run_regression.py`/`train_*.py`/`test_*.py` |
| S3 | cmdFeature（5 值） | **训练器家族**（torchrun/deepspeed/train*.py=训练倾向；python -c/-m=无法定） | 中（现网误报多，需精度修复） | 仅作「训练候选」门控，不作最终类型 |
| S4 | 进程数（`groupStats.memberCount` / `procGroup.size`） | 训练（多 worker）vs 计算/脚本（单进程） | 中高 | torchrun 多进程=训练；1 进程+短时=工具/冒烟 |
| S5 | 时长（`startTs→endTs` / `summary.durationSec`，ended 已有） | 短任务 vs 长任务 | **首见不可知**；二次后高 | 历史分布（p50/p90）分类；首见用默认值 |
| S6 | 资源画像（`groupStats.cpuPct/gpuUtilPct`、`sampleStats.utilMax/avg`、`summary`） | 训练（GPU 持续高位）vs 计算（突发）vs IO-bound（io-bottleneck 告警） | 中（需运行一段才收敛） | 运行期确认型信号，补充 S1/S3 |
| S7 | `Alert.runId`（告警已按实验归属） | 训练特征（oom/io-bottleneck 与类型相关性） | 中 | 与类型规则联合：训练型长任务更关心 io-bottleneck |
| S8 | 状态翻转节奏（history：done/crashed 序列、时长短、频次） | 冒烟批次 / 回归批次 | 中 | 同一 fingerprint 多次短 done → 工具/冒烟批次 |
| S9 | exit code | 成功/失败区分（崩溃重试 vs 正常短任务） | **现状不可得**（markResult 仅 paired 布尔，state-machine.ts:217-229） | **需扩展**：tools/result 解析 exitCode（index.ts:1143-1173 目前丢弃） |
| S10 | 用户标签（`tags` 规则命中，kind=experiment/process） | 任意用户声明类型 | 高（用户权威） | 类型规则优先用户标签 |

### 3.2 自动 vs 配置 vs 学习（三层归属）

| 层 | 内容 | 信号 |
|---|---|---|
| **自动层（确定性高，零配置）** | 冒烟/回归/训练关键字与脚本名正则；训练器家族门控（S1/S2/S3）；进程数辅助（S4）；「未命中=未分类」保守策略 | S1-S4 |
| **配置层（用户意图）** | 1) 未分类实验的默认策略（时长档、通知档位）；2) `experimentTypes` 规则：pattern→类型→通知策略覆盖（alertNotify/targets/预期时长）；3) 阈值（短任务 <5min 等可配）；4) 用户标签可直接声明类型（S10） | S10 + 配置 |
| **学习层（运行时）** | 按 `fingerprint`（脚本名）累积历史时长分布与资源画像（S5/S6/S8）——首见用默认策略，第二次起按历史归类；告警后可回写确认 | S5/S6/S8 |

---

## 4. 通知策略的配置面设计输入

### 4.1 现状承载能力

- **插件配置**（`LabMonitorConfig`，index.ts:42-61）：仅 `promptInjection/sampleMs/pollMs/watchProcs/tags` 5 键；`alertNotify/alertTargets` 尚未实现（20-issue5 §4.2 提案）。
- **settings 命名空间 lab-monitor 已持久化键**（index.ts:672-703）：`thresholds`（8 值）、`watchProcs`、`tags`、`history`——schema 在插件内（Schema.object），**用户值放包外 `$DSH_HOME/settings.yaml`**（docs/usage/usage.md:95-98：四键持久化、运行时双向同步；行级 config 可走 profile/`$DSH_HOME/cordis.patch.yml` 的 lab-monitor 行 config 字段）。现网 settings.yaml 实证：lab-monitor 段含 thresholds/watchProcs/tags/history（`~/.dsh/settings.yaml:88-`）。
- **设置页控件**（client.ts，settings.section「监控设置」）：
  - WatchManager：watchProcs 增删（client.ts:1167-1213）——**模式参考：关键词 chips 管理**；
  - ControlPanel：阈值保存 / 暂停恢复 / 清除告警（client.ts:392-517）；
  - TagManager：标签规则列表+添加表单（label/patterns/kind/color）+删除（client.ts:589-688）——**模式参考：pattern 正则规则管理**。
- **配置存放原则**（task 约束）：用户配置放包外（settings.yaml），插件只提供 schema（settings.register 模式）——新增键沿用。

### 4.2 配置结构建议（供 designer 收敛）

```yaml
# $DSH_HOME/settings.yaml → lab-monitor:
lab-monitor:
  # —— 20-issue5 已有提案：告警通知通道 ——
  alertNotify: notice        # off | notice | wake（默认 notice；wake=critical 唤醒）
  alertTargets: []           # 空 = 全部 roots（主代理）；可列子代理 id
  # —— 本次新增：实验类型 × 通知策略（experimentTypes）——
  experimentTypes:
    - id: type-smoke-001
      type: smoke            # smoke | regression | full | short | long | training | compute | custom...
      patterns: ['smoke', 'test_smoke', '--smoke']   # cmdline 正则（复用 TagRule.patterns 语义）
      notify: { critical: 'wake', warn: 'notice' }   # 类型级档位覆盖（缺省继承全局 alertNotify）
      targets: []            # 类型级通知目标（缺省走 alertTargets）
      expectedMaxSec: 300    # 学习层基线：超时未结束 → 怀疑卡死/全量
    - id: type-reg-002
      type: regression
      patterns: ['regression', 'run_regression']
      notify: { critical: 'notice', warn: 'off' }
  # —— 可选：学习层开关与默认档 ——
  expTypeLearning: true      # 按 fingerprint 学历史时长/画像
  expTypeDefault: short      # 未识别类型的默认策略
```

要点：
1. **复用 `tags` 的规则形态**（id/patterns/正则匹配、settings 持久化、UI 管理器），降低实现与心智成本；类型体系由 `type` 枚举+自定义承接。
2. **通知档位分层**：全局 `alertNotify`（默认）→ 类型级 `notify` 覆盖 → 级别级（critical/warn/info）细分——与「严格分级」结论（§1.5）对齐：level 决定基础档位，rule/type 权重可抬升或降档。
3. **学习层数据**已具备：history 持久化 + summary.durationSec；仅需在恢复时按 fingerprint 建索引（当前 restoreEnded 丢了 fingerprint 字段——state-machine.ts:348 `fingerprint: ''`，**需补存**才能做脚本级学习）。
4. schema 放插件（settings.register 扩展 persistSchema 加 `experimentTypes` 键，index.ts:672-703 模式）；UI 新增「类型规则管理」卡（复用 TagManager 结构）。

---

## 5. 实验类型识别分层方案建议（结论）

```
                 ┌────────────────────────────────────────────────┐
                 │            实验类型识别（三层）                  │
  pre-execute 命中 TRAIN_PATTERNS / 类型正则 ──────────────────────►
                 │                                                │
  自动层          │  S1 关键字/S2 脚本名/S3 训练器门控/S4 进程数     │
  （零配置）       │  ⇒ type ∈ {smoke, regression, training, ...}  │
                 │  未命中 → unclassified（保守，不猜）             │
  配置层          │  用户 experimentTypes 规则（pattern→type）      │
  （用户意图）     │  + 默认策略（expTypeDefault）+ 用户标签声明      │
  学习层          │  fingerprint 历史时长/画像分布                  │
  （运行时）       │  首见=默认策略；二次=历史归类；结束后回写        │
                 └────────────────────────────────────────────────┘
                          ▼
              类型 × 告警级别 × 通知档位矩阵
              （critical/warn/info × type-notify 覆盖 × 全局默认）
                          ▼
              通知目标选择：主代理 roots / 子代理 / alertTargets
              （T1 输出权限与路由；T3 评审）
```

实现顺序建议：先修 TRAIN_PATTERNS 精度（误报污染一切）→ 加实验类型字段（RunRecord.type + snapshot 透出）→ 类型规则配置面（复用 tags 模式）→ 通知档位矩阵（配合 20-issue5 方案 F 的 alertNotifier）→ 学习层（补 fingerprint 持久化）。

---

## 6. 证据清单（文件:行号）

| 事实 | 证据位置 |
|---|---|
| RULES 5 条 + oom 动态降级 | src/core/balancer.ts:105-250 |
| MIN_HITS=5(10s) / MIN_INTERVAL=5min / TTL 24h | src/core/balancer.ts:252-255 |
| confidence 映射（critical 0.85 / 其余 0.7）；external 0.9 | src/core/balancer.ts:374, 407 |
| 告警消费：advice Top5 / snapshot Top10 / count badge / emitLab | src/core/balancer.ts:383-399, 419-432 |
| lab/alert 事件载荷 | src/core/balancer.ts:383-390；src/index.ts:320-326 |
| lab/experiment-start 事件 | src/core/state-machine.ts:197 |
| RunRecord 字段 | src/core/types.ts:54-76 |
| Alert 类型（level 含 string 逃逸口） | src/core/types.ts:107-117 |
| TRAIN_PATTERNS / matchTrainFeature / cmdFingerprint | src/core/constants.ts:34-77 |
| makeRunId / 并行上限 4 / 历史上限 20 | src/core/constants.ts:22-24, 80-87 |
| 状态机状态与归档语义（done/crashed/aborted；alerting 投影） | src/core/state-machine.ts:138-146, 293-311, 313-325 |
| setAlerting 无调用方（死代码） | src/core/state-machine.ts:293-296（grep 全仓仅定义处） |
| markResult 仅 paired 布尔（无 exit code） | src/core/state-machine.ts:217-229；src/index.ts:1143-1173 |
| 实验识别入口 pre-execute / result 配对 | src/index.ts:1125-1141, 1143-1174 |
| 告警归属主实验 runId | src/index.ts:417-418 |
| settings 持久化 4 键 + 重启恢复 | src/index.ts:656-746, 751-784 |
| 设置页控件（WatchManager/ControlPanel/TagManager） | src/client.ts:392-517, 589-688, 1167-1235 |
| settings.yaml 现网实证（误报 history） | ~/.dsh/settings.yaml:88-430（lab-monitor 段） |
| 误报案例：grep 'torchrun' → cmdFeature=torchrun | ~/.dsh/settings.yaml run-20260823-003/002 |
| e2e 实验样例（sleep 20/300） | docs/research/10-p1-e2e-test.md:27,71 |
| 20-issue5 方案 F（alertNotify/alertTargets 提案） | docs/research/20-issue5-alert-feedback-design.md §4 |
| issue #5 原始需求（KV 缓存背景） | GitHub x-dc-coder/lab-monitor#5（OPEN） |
| 实验类型分类在仓库中无任何现存概念 | README.md / docs/usage/usage.md / git log（grep smoke/regression/冒烟 无实现） |