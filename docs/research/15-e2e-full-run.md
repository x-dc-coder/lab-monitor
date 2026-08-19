# 15 Lab Monitor V2 全量 e2e 实证（T1-T5）——独立验证记录

> 状态：**执行完成（2026-08-20，tracking-engineer 独立执行）**。
> 载体：`scripts/e2e-host.js`（V2 形态：import `lib/types/index.js` 真实构建产物；
> 真实 child_process + 真实 python 进程 + 真实 nvidia-smi.exe + 真实时钟）。
> 执行：`cd /home/dc/projects/lab-monitor && timeout 400 node scripts/e2e-host.js`，
> 完整输出存档 `/tmp/e2e-full.log`（未 grep，全量 76 行）。
> 环境：WSL2，GPU probe 真实可用（driver 596.49 / 1 GPU / 38°C / 8% util / 15199MiB used）。

## 0. 结论速览

**e2e T1-T5 全量通过（ALL PASS，0 断言失败）**。插件状态机/告警/防重/历史全链路真实进程实证工作正常。
唯一异常是**测试脚本自身的收尾缺陷**（引用未定义变量 `log`）导致进程退出码为 1（非插件问题），
详见 §2。另记录 2 个测试观测伪影（§3），均不影响通过结论。

## 1. T1-T5 逐项结果

| # | 场景 | 关键断言 | 实测 | 结果 |
|---|---|---|---|---|
| T1 | 正常结束 → done | pre-execute → running；pid 回填；done 双确认；零告警 | experiment=null、alertsCriticalCount=**0**；pid 关联 106123 = 真实 python3 存活进程 | ✅ PASS |
| T2 | kill → crashed + CRITICAL | crashed 判定 + critical/experiment-crash | `{level:critical, rule:experiment-crash, confidence:0.9}`；critical=1 | ✅ PASS |
| T3 | 并发单跟踪 → aborted | 仅 B running（train_demo2），无双 running | experiment.cmd=train_demo2.py；A（run-003）被 archive aborted（run-004 取代） | ✅ PASS |
| T4 | 平衡引擎构造触发 | thermal（tempWarn=1 持续 10s）→ 告警 | `{level:warn, rule:thermal, confidence:0.7, actions:[...]}` | ✅ PASS |
| T4 | oom 构造触发 | memWarn=5 + utilWarn=1 → 告警 | `{level:critical, rule:oom, confidence:0.85}` | ✅ PASS |
| T4b | 同类告警 5min 防重 | thermal 告警数不增 | before=1 → after=1（lastByRule 防重生效） | ✅ PASS |
| T5 | history 真实数据（P2 3） | 降采样桶 ≥1、≤500、含 GPU util 聚合 | 56 桶（≤500）、gpuUtil 数值聚合（ring 真实采样） | ✅ PASS |

装载段亦全过：name=lab-monitor / 4 RPC（snapshot/history/setThresholds/control）/ lab_status 工具 /
pre-execute 与 result 监听器 / platform=wsl / sources.gpu=query / gpu[] 真实解析。

日志确认的关键事件链（完整见 /tmp/e2e-full.log）：

```
T1  run-20260820-001  python3 -c '...sleep(20)'        → done（配对 result + 进程消失双确认），0 CRITICAL
T2  run-20260820-002  python3 /tmp/train_demo.py +kill  → critical/experiment-crash（confidence 0.9）
T3  run-20260820-003  train_demo.py（被 run-004 取代，archive aborted）
    run-20260820-004  train_demo2.py                    → 仅 B running
T4  warn/thermal（0.7）+ critical/oom（0.85）构造触发；阈值已复位（85/95/90）
T4b thermal 告警 1→1 不增（5min 防重）
T5  56 个降采样桶，含 GPU util 聚合
```

## 2. ⚠️ 唯一异常：exit code 1 = 测试脚本缺陷（非插件 bug）

- **现象**：末行已打印 `==== e2e 结果（P1+P2）: ALL PASS ====`，随后进程仍以退出码 1 结束。
- **根因**：`e2e-host.js:290` `console.log('（日志条数:', log.length, ...)` —— 脚本全文从未定义
  `log` 变量（V1 遗留的占位引用，无 `let log = ...`），此处抛 `ReferenceError: log is not defined`，
  进入 `.catch` → `process.exit(1)`。第 291 行 `process.exit(failures === 0 ? 0 : 1)` 因上一行抛错
  从未执行（否则本次应为 exit 0）。
- **判定**：**测试脚本缺陷**，与插件无关——所有断言 0 失败，ALL PASS 已打印。
- **修复建议**（不代改，交队长）：删除第 290 行或改为不引用未定义变量
  （如 `（断言全部通过）` 或引用真实变量 `snap.alertsCriticalCount`）；同时建议把 290 行的
  console.log 移到 `process.exit` 之前的结构改为先 exit 后收尾，避免同类抛错吞掉退出码语义。

## 3. 观测伪影记录（不影响通过结论）

1. **T3 `aAlive=false` 信息行**：脚本注释称「A 进程仍存活但未被跟踪」期望 true，实测 false。
   根因：RPC snapshot 的 `procs` 为 `(base.procs || []).slice(0, 15)`（ps 列表截断前 15 条），
   A（pid 106706）大概率在前 15 条之外 → 观测不到 ≠ 进程已死（A 为 sleep 300 进程，14s 内不会自灭；
   插件 pre-execute 也不杀旧进程，仅 archive aborted）。该行**无断言**，R-2 判定依据是
   「仅 B running + 无双 running」断言，已通过。建议后续将 e2e 对 aborted 的验证改为
   history/实验记录面直接断言 `reason=aborted`（P2 history 增强补实验记录面后）。
2. **T5 `含 GPU 数据: false` 信息行**：脚本用 `p.gpuUtilN > 0` 检查，真实字段名为 `gpuUtil`
   （下方断言 `typeof p.gpuUtil === 'number'` 通过）。信息行字段名笔误，无断言影响。

## 4. 关于 T4 段出现的第二条 experiment-crash 告警（正确行为，非误报）

- T3 清理段对 B 进程（run-004 的 python）做**无配对 kill**（`process.kill(cpB.pid)`），
  与 T2 完全同机理：无配对 result + 进程消失 2 个 ps 周期 → 判 crashed 并告警。告警出现在 T4
  等待窗口内属时间线正常（kill 后 10~15s 判定），**是插件正确检测，非误报**。
- 被 aborted 的 A（run-003）进程随后被杀**不产生**任何告警（aborted 归档后 tick 不再跟踪，
  `conclude()` 只对 running 生效）——符合设计。

## 5. 结论

- **插件全链路工作**：T1-T5 全量断言 0 失败（ALL PASS），V2 正式插件（lib/types 构建产物）
  的状态机（running/done/crashed/aborted）、pid 指纹关联（v1.4.5 修复生效）、
  告警分级/置信度/动作、5min 防重、history 降采样均实证正常。
- **遗留动作（非阻塞）**：① 修复 `e2e-host.js:290` 未定义 `log`（脚本收尾缺陷，exit code 语义）；
  ② T3 aborted 的直接断言待 history 实验记录面就绪后补强；③ T5 信息行字段名笔误 `gpuUtilN`→`gpuUtil`。
- 环境清理：执行后 `ps aux | grep train_demo` 无残留进程。

## 附：执行环境

- 命令：`cd /home/dc/projects/lab-monitor && timeout 400 node scripts/e2e-host.js`（全程约 3 分钟，未超时）
- 全量输出：`/tmp/e2e-full.log`
- 插件代码：`lib/types/index.js`（2026-08-20 02:52 构建，V2 迁移后产物）
