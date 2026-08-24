# AGENTS.md — Lab Monitor 项目内 Agent 操作指引

> 作用域：本文件由 DSH 在**会话工作目录位于本仓库内**时自动加载（dsh-agent-instructions）。
> 读者：在本仓库内开发/验证/维护 lab-monitor 的 Agent。
> 若你在**其他工作区**使用 lab-monitor 插件跑实验，工具用法见 `lab_ctl`/`lab_status` 的 schema 描述，
> 或全局 `~/.dsh/AGENTS.md` 中的 lab-monitor 速查段（如已粘贴）。
> 详细文档入口：`docs/README.md`（索引）→ `docs/usage/usage.md`（人读完整手册）。

## 1. 项目一句话

lab-monitor 是 DSH 的科研实验监控插件（V2 正式插件）：采样 GPU/CPU/内存/进程（WSL-Windows 双后端）→
状态机跟踪训练实验（多轨 ≤4）→ 平衡引擎分级告警 → 通知引擎按「有效级别 × 实验类型 × 发起 agent」路由投递。

## 2. 工具契约速查（DSH 会话内可用）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `lab_status` | 实时快照 | `brief:true` → 一行摘要（`[Lab Monitor] GPU0 6% · …`） |
| `lab_advice` | 平衡引擎建议 | 无参；无告警时 `advice: []` |
| `lab_ctl` | 控制/配置 | `action` 枚举：`start/pause/resume/set-threshold/watch/tag/clear-alerts/set-notify/history-manage` |
| `lab_status_ro` | 子代理只读查询 | registerContinuableSetup 注入；子代理不可用 `lab_ctl`（guard，subagentPolicy 默认 readonly） |

`lab_ctl` 常用示例：
```text
lab_ctl set-threshold thresholds={memWarn: 90}
lab_ctl watch keywords=["llama-server","vllm"]
lab_ctl tag tag={op:"add", label:"py实验", patterns:["python.*train"], kind:"experiment"}
lab_ctl set-notify alertNotify=wake escalateAfterSec=900
lab_ctl history-manage op=clear keep=5
lab_ctl clear-alerts rule=experiment-crash
```

## 3. 实验识别规则（重要：避免误触发）

`tools/pre-execute` 命中以下形态会**记为实验**（TRAIN_PATTERNS，2026-08-23 精度修复 11/11）：
- `python3?|uv` + `train*.py`（如 `python3 train.py --batch 32`）
- `torchrun` + 脚本文件或 `-m torch.distributed` 句式（**不裸词匹配**——`grep -rn "torchrun"` 不触发）
- `deepspeed` + 脚本文件
- `python -m torch.distributed|accelerate|deepspeed`
- `python -c` 内联代码含训练特征：`torch.distributed|nn.Module|backward|epochs?|train(?!ing)`（`import zipfile` 等工具脚本不触发）

实验类型（M2 三层识别）：配置规则 > 自动正则（smoke/regression/full/gpu-calc/long/gpu-train）> fingerprint 历史时长
（≥1h → long）> unknown 不猜。`lab_status` 快照的 `experiment.type` / `ended[].type` 可见。

**验证跑实验**：`python3 -c "import torch; import torch.nn as nn; m=nn.Linear(2,2); loss=torch.tensor(1.0); loss.backward(); print('ok')"`
（含 backward 特征 → 记为 gpu-train 实验）→ 等 ~10s → `lab_status` 查 `ended` 最新条 `type=gpu-train`。

## 4. 告警语义速查

- **规则**：`oom`（显存超 memWarn）/ `thermal`（温度）/ `io-bottleneck` / `imbalance`（低利用率）/
  `other-occupancy`（无实验占卡）/ `experiment-crash`（进程消失无配对）。
- **扩展字段**：`severity(1-5)` / `urgency(1-3)` / `trend(rising|steady|falling)` / `sustainedMs` / `resource` / `origin(self|other|system)`。
- **通知档位**：`off`（仅 UI 可见，不投递）/ `notice`（推送不唤醒）/ `wake`（唤醒 Agent）。
- **类型矩阵要点**（EXP_TYPE_DEFAULT_NOTIFY，配置可覆盖）：`gpu-train` critical/warn 均 `wake`；`smoke` warn `off`；
  `full/long` critical `wake`；`unknown` 走全局 fallback（`alertNotify` 默认 notice）。
- **路由**（M3）：告警 runId → 发起 agent（子代理 → 发起者 + 根祖先 notice；crashed → 根 wake 接管；
  absent → 立即升根 roots()）。
- **消息链兜底**：子代理异常结算（subagent/end stopReason∈{max-tokens,error,cancelled} 且有在途实验）→ 升根；
  wake 投递后 `notifyTimeoutMs`（默认 10min）内未领取（无 inbox/claimed）→ 超时升根。**静默处理 ≠ 链断裂**（不做"无活动即转发"）。

## 5. 配置键速查（settings.yaml `lab-monitor` 段）

| 键 | 默认 | 说明 |
|---|---|---|
| `thresholds.{utilWarn,memWarn,tempWarn,pollMs,procTopN(5..1000),wGpu,wCpu,wMem}` | 80/80/50/5000/400/1/1/1 | 检测阈值 + 进程排序 |
| `watchProcs` | `[]` | watchlist 关键词 |
| `tags` | `[]` | 标签规则（`{id,label,patterns,kind,color}`） |
| `history` | `[]` | 实验历史（含 `type/fingerprint` 投影） |
| `alertNotify/alertTargets/notifyThrottleMs/escalateAfterSec/notifyTimeoutMs/broadcast` | notice/[]/60000/600/600000/false | 通知策略（M1） |
| `experimentTypes/expTypeDefault/expTypeLearning` | []/unknown/true | 实验类型配置（M2） |
| `subagentPolicy` | readonly | 子代理权限：readonly/restricted/full（M3） |

配置**一律在包外**（settings.yaml），改代码内配置需走插件自身逻辑；行级配置见 profile `cordis.patch.yml`。

## 6. 验证清单（改代码后必跑）

```bash
cd /home/dc/projects/lab-monitor
pnpm typecheck        # tsc --noEmit
pnpm build            # tsc + tsdown → lib/
bash scripts/verify.sh  # 七组：typecheck/构建/目录/契约/verify-host/mock-test/verify-m1/verify-sampler
```

- 改 client 半后必须重跑 verify.sh（回归红线 B5）。
- 运行时验证（host 改动需用户重启 DSH 生效）：`curl -s http://127.0.0.1:3080/lab-monitor/api/snapshot`
  （HTTP 数据面，localhost only）。

## 7. HTTP 数据面

`POST /lab-monitor/api/{snapshot|history|setThresholds|control|advice|tag|watch|historyManage}`
（webServer 注册时；无鉴权，当前 localhost only——Tailscale 实测不可达）。

## 8. 文档导航

- **索引**：`docs/README.md`
- **架构**：`docs/architecture/core.md`（引擎/出口/V2/M1-M3）、`docs/architecture/alert-notify.md`（告警架构）、
  `docs/architecture/ui-adapters.md`（UI 出口）
- **参考**：`docs/reference/data-model.md`、`docs/reference/protocol.md`、`docs/reference/milestones.md`
- **使用**：`docs/usage/usage.md`（完整手册 + 变更记录）
- **设计调研**：`docs/research/`（00-24/26/27；关键：`22-issue5-alert-notify-design.md` 综合设计）
- **历史计划**：`docs/plan/`（PLAN-v1.1/1.3/1.4.5 归档）
