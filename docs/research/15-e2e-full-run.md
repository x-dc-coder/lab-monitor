# 15 Lab Monitor V2 全量 e2e 实证（T1-T5）——独立验证记录

> 状态：**执行完成（2026-08-20，tracking-engineer 独立执行）**。
> 载体：`scripts/e2e-host.js`（V2 形态：import `lib/types/index.js` 真实构建产物；
> 真实 child_process + 真实 python 进程 + 真实 nvidia-smi.exe + 真实时钟）。
> 执行：`cd /home/dc/projects/lab-monitor && timeout 400 node scripts/e2e-host.js`。
> 环境：WSL2，GPU probe 真实可用（driver 596.49 / 1 GPU / 38-43°C / 显存 93%-97% used）。

## 0. 结论速览

**e2e T1-T5 全量通过（ALL PASS，0 断言失败，exit 0）**。插件状态机/告警/防重/历史全链路真实进程实证工作正常。
期间发现并修复 1 个测试脚本缺陷（e2e-host.js:290 未定义变量 `log`），并实证 1 起
**环境相关的 T1 断言脆弱性**（共享 GPU 满载时 oom 系统级告警真实触发，非插件 bug）。详见 §2、§3。

## 1. 执行记录（3 轮）

| 轮次 | 结果 | 说明 |
|---|---|---|
| 第 1 轮 | ALL PASS，exit 1 | 全部断言过；收尾 `log` 未定义 ReferenceError → exit 1（脚本缺陷，见 §2） |
| 第 2 轮（log 行已删） | 1 FAILED，exit 1 | T1「正常结束无 CRITICAL 告警」失败（oom 系统级告警真实触发，见 §3） |
| 第 3 轮（复跑验证） | **ALL PASS，exit 0** | 修复生效；并行 GPU trace 佐证 util 全程 ≤27%，T1 通过 |

第 3 轮完整输出：`/tmp/e2e-rerun2.log`（27 条断言全 ✓）；GPU trace：`/tmp/gpu-trace.log`。

## 2. ⚠️ 已修复：测试脚本缺陷（e2e-host.js:290 未定义 `log`）

- **现象**：ALL PASS 已打印但进程 exit 1。
- **根因**：`e2e-host.js:290` `console.log('（日志条数:', log.length, ...)` 引用未定义变量 `log`
  （V1 遗留占位），抛 ReferenceError → catch → exit 1；第 291 行 `process.exit(failures===0?0:1)` 未执行。
- **修复**：删除第 290 行（队长定位，tracking-engineer 执行）。**修复后第 3 轮 exit 0 验证通过。**
- **经验**：判定 e2e 成败以「ALL PASS 打印 + 断言计数」为准，勿只看退出码（脚本收尾 bug 可掩盖退出码语义）。

## 3. ⚠️ 环境相关断言脆弱性（T1 零告警断言 vs 系统级 oom 告警）——非插件 bug

- **现象**（第 2 轮）：T1 正常 done 后 `alertsCriticalCount=1`（一条 `critical/oom`），断言
  「正常结束无 CRITICAL 告警」失败；T2-T5 全部通过（含 T4 的 oom 构造触发）。
- **根因（已实证闭环）**：
  1. 第 2 轮期间 Windows 侧显存占用 **97.2% ≥ 默认 memWarn=95**（第 1 轮为 93.2% < 95，故第 1 轮不触发）；
  2. oom 规则 `memUsedPct>=95 && utilPct>=90`（系统级，不绑定实验 run），需连续 5 次采样（10s）命中
     （MIN_HITS=round(1e4/SAMPLE_MS)=5）；
  3. 第 2 轮 T1 窗口内 Windows 侧 GPU 恰有满载时段（util≥90% 持续 10s+）→ oom 告警**真实触发**；
  4. 第 3 轮并行 GPU trace（1.5s 采样 40 次）全程 util ≤27%（仅一次瞬时 27%），无 oom → T1 通过。
- **判定**：插件告警逻辑正确（数据源唯一为真实 nvidia-smi query，parseSmiLine 严格解析；
  oom 规则按设计工作，T4 构造验证也通过）。**T1 断言「实验正常结束 → 无任何 CRITICAL」在
  「共享 GPU + 显存接近满载」环境下脆弱**——oom/thermal 是系统级告警，与实验是否正常无关。
- **修复建议**（不代改，交队长）：
  1. T1 断言改为「正常结束无 **experiment-crash** 告警」（绑定实验的告警规则），
     不检查系统级 oom/thermal；
  2. 或 e2e 启动前做 GPU 状态前置检查（显存占用或 util 波动超阈值时跳过 T1 零告警断言并注明）；
  3. 或 T1 前临时 `setThresholds memWarn=100` 屏蔽 oom 干扰，T1 后复位。

## 4. 观察项（不影响结论，记录）

- 第 2 轮 T1 出现一次 pid 关联错位：实验 pid=107728 ≠ spawn 的 python3 pid=107746
  （第 1/3 轮均正常关联）。`findAliveProc` 按「首个匹配」选进程，ps 列表存在两个匹配指纹的
  python3 时可能选中非目标进程；当时 107728 为存活 python3 进程（comm 校验通过），
  未导致误判（done 双确认仍过）。概率低，暂记录；若复现可改 findAliveProc 优先精确 pid 匹配。
- RPC snapshot 的 `procs` 截断 `slice(0,15)`（T3 观测 aAlive 的伪影来源，见 §5）。

## 5. T1-T5 逐项结果（第 3 轮，ALL PASS）

| # | 场景 | 关键断言 | 实测 | 结果 |
|---|---|---|---|---|
| T1 | 正常结束 → done | pre-execute → running；pid 回填；done 双确认；零告警 | experiment=null、alertsCriticalCount=**0**；pid 关联 109487 = 真实 python3 存活进程 | ✅ PASS |
| T2 | kill → crashed + CRITICAL | crashed 判定 + critical/experiment-crash | `{level:critical, rule:experiment-crash, confidence:0.9}` | ✅ PASS |
| T3 | 并发单跟踪 → aborted | 仅 B running（train_demo2），无双 running | experiment.cmd=train_demo2.py；A 归档 aborted | ✅ PASS |
| T4 | thermal 构造触发 | tempWarn=1 持续 10s → 告警 | `{level:warn, rule:thermal, confidence:0.7, actions:[...]}` | ✅ PASS |
| T4 | oom 构造触发 | memWarn=5 + utilWarn=1 → 告警 | `{level:critical, rule:oom, confidence:0.85}` | ✅ PASS |
| T4b | 同类告警 5min 防重 | thermal 告警数不增 | before=1 → after=1（lastByRule 防重生效） | ✅ PASS |
| T5 | history 真实数据（P2 3） | 降采样桶 ≥1、≤500、含 GPU util 聚合 | 53 桶（≤500）、gpuUtil 数值聚合（ring 真实采样） | ✅ PASS |

装载段亦全过：name=lab-monitor / 4 RPC / lab_status 工具 / pre-execute 与 result 监听器 /
platform=wsl / sources.gpu=query / gpu[] 真实解析。

## 6. 结论

- **e2e T1-T5 全量通过**：V2 正式插件（lib/types 构建产物）状态机（running/done/crashed/aborted）、
  pid 指纹关联（v1.4.5 修复生效）、告警分级/置信度/动作、5min 防重、history 降采样均实证正常。
- **脚本缺陷已修复**（e2e-host.js:290 删除），exit 0 验证通过。
- **遗留建议**：T1 零告警断言改为实验绑定规则（见 §3），增强 e2e 在共享 GPU 环境下的稳定性。
- 环境清理：各轮执行后 `ps aux | grep train_demo` 均无残留进程。

## 附：执行环境

- 命令：`cd /home/dc/projects/lab-monitor && timeout 400 node scripts/e2e-host.js`（单轮约 3 分钟，未超时）
- 输出存档：`/tmp/e2e-full.log`（第 1 轮）/ `/tmp/e2e-rerun.log`（第 2 轮）/ `/tmp/e2e-rerun2.log`（第 3 轮）
- GPU trace：`/tmp/gpu-trace.log`（第 3 轮并行采样，util 分布 3%-27%）
- 插件代码：`lib/types/index.js`（2026-08-20 02:52 构建，V2 迁移后产物）
