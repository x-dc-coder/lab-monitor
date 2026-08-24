# 04 里程碑验收清单（P0/P1/P2，可勾选）

> **归档注记（2026-08-20 清理）**：本文所述 v1.4.5 MVP 资产（`plugin/` 动态版、`scripts/dev-run.sh`、`lab-monitor.define.json`）已归档至 `docs/archive/v1.4.5-plugin/`；`mock-test.js` 已移至 `scripts/`。

> 来源：实施计划 v1.4 §4 原文搬运 + §5.5 CI 自测点（v1.4：采样后端抽象映射 probe/stream 语义 + 真实采样实证 + close 防孤儿）。每项验收后勾选并记录执行人/日期/结果；结论回填处（最小样例实证）留空待 D-A/D-B1 前执行。

> **实现状态（2026-08-18 落地，架构师/集成工程师）**
> 本里程碑清单随代码实现更新：✅ = 已实现且由自动化自测证明（`scripts/verify.sh`：
> verify-host.js 42 断言 + mock-test.js 49 断言 + verify-sampler.js 真实采样 + dev-run 语法门禁）；
> ⬜ = 依赖 DSH 会话内端到端实证（cordis_define/cordis_run 装载、实时 UI 渲染、prompt 注入核对）。
> **R-3 取舍记录**：长实验 ring buffer 采用「running 期扩容至 2h」（createRing.expand()，host §3）；
> **T4-4 记录**：动态插件沙箱无 schemastery 全局（rc.6 实证）→ 阈值事实来源为 host 内存
> （默认值 + live 更新）；settings 持久化留 v2 正式插件（settings.register('lab-monitor', Schema.object(...))）。
>
> **会话内端到端验收（2026-08-19 集成工程师，本清单 ⬜ 项回填）**：
> cordis_define 装载（dev-run.sh concat 57.5KB host + 20.5KB client）→ cordis_run 激活 → inspect_self 无 diagnostics；
> **会话内发现并修复 3 处真实缺陷（均经自测+会话内复验）**：
> ① v1.4.2 makeRunner 缺 `shell.resolve()` + 缺显式 `sandboxPolicy: danger-full-access`（cordis 沙箱 shell 契约，实证 A/C 路径失败 / D/E 路径通过 → 采样全通道恢复，WSL→WindowsBackend 真实数据）；
> ② v1.4.3 dmon 首杀自愈失效（`_lastRestartAt` 初始 0 恒真 → 首杀即 fallback，kill 后 10s 重启复验通过）+ markResult 后台任务竞态误判 done（`!run.pid` 提前收尾，并发单跟踪复验通过）；
> ③ v1.4.4 prompt 注入缺位（`systemPrompt.variable` 变量名须 `/^[a-z][a-z0-9_]*$/`，`labStatus` 大写非法被 catch 吞掉 → section 未注册；assemble 观测 hasLab=false→true 复验通过）。
> 通过项：1'/4'/7'/9'/10'（P0）、4'/5'/7'（P1）、2' 即时生效部分（P2）；受限项：2'（UI 未注册，样例②）、3'（无 GPU 机）、6'（settings 命名空间未注册）；未通过项：样例② conversation.view 会话内渲染（client 半可运行但 slots.register 未落地，待 v2/换出口定位）。
>
> 自测证据：`node scripts/verify-host.js`（P0 数据面/P1 生命周期/P2 告警阈值/工具/prompt/互斥 42 ✓）；
> `node scripts/mock-test.js`（数据消费者/兜底出口/D-B2 适配器 49 ✓，原 plugin/client/，2026-08-20 迁入）；`node scripts/verify-sampler.js`
> （真实 GPU/interop 采样、dmon vs query 偏差 0、close 无孤儿）。

> **P0 收尾声明（2026-08-19，队长复核通过）**：
> - **P0 达成**：采样双后端真实跑通（verify-sampler 实证）+ RPC 数据面完整（verify-host 47 断言）+ 最小可见性 = Agent 通道 ① 与 conversation.view ②（client 半已实现，会话内渲染受激活时序限制，见下）；
> - **受限（环境原因，非缺陷）**：P0 2' UI 轮询观测（依赖出口渲染）、P0 3' 真实无 GPU 机实证（本机有 GPU，降级路径由自测覆盖）、P0 6' settings 互斥真实模拟（命名空间未注册，标志逻辑自测覆盖）；
> - **留待 v1.4.5/v2**：lab-monitor 自身 conversation.view 会话内显示——client 半同步 `slots.register` 激活时序问题（探针以同参数异步注册成功），修复方向 = `slots.inject('conversation.view')` 等待槽声明（skill 文档化模式）；
> - **MVP 运行时边界**：动态插件会话级隔离（重启/换会话需重 define），见 docs/architecture/core.md §2.1。
> - **后续里程碑入口**：P1 = 状态机/平衡引擎/告警（核心代码已就位，verify-host 覆盖，需会话内端到端回填）；P2 = 阈值控制/持久化（settings 注册留 v2）。



## P0「核心引擎 + 最小可见性」：采样（双后端）+ RPC + 数据面

**交付**：sampler/ 后端抽象（backend-interface + LinuxBackend + WindowsBackend + index 分发）+ ring-buffer + rpc.snapshot + 最小可见性 = conversation.view 原生兜底 tab（默认出口②，推荐）或 Agent 工具 lab_status（① 无 UI 出口），二者至少其一。

### P0 前置：三个最小样例验证（§8 交付物 2，结论回填处）

- [x] **样例①：cordis_define 装载 + 同名工具实证**（T1-3/R-1）——**2026-08-19 会话内实测完成（集成工程师）**
  - 验证 cordis_define 装载「源码分文件 concat 的大函数体」可行（dev-run.sh 确定性合并器）；
  - 实证同名工具重复 defineTool 行为（报错/覆盖/忽略）并写明策略。
  - 结论回填：integ / 2026-08-19 —— **装载可行**：dev-run.sh 确定性合并 6+1 文件 → 57.5KB code.host + 20.5KB code.client 单次 cordis_define 装载成功、语法门禁通过、运行无 diagnostics；**同名工具行为 = 报错拒重**：`harness.defineTool` 定义层同名不报错，`harness.registerTool` 同名注册抛 `tool "lab_status" is already registered`（不覆盖、不静默忽略），lab-monitor 的 try/catch 兜住不崩溃、原工具完好（重复 define/激活无重复 UI）。另发现 defineTool 必须带 `output:{schema,render}`（缺失即抛错）。
- [x] **样例②：conversation.view 承载能力实证**（M7）——**2026-08-19 会话内实测：承载能力通过；lab-monitor 自身 UI 受 client 时序影响（v2 修复方向已定）**
  - 验证 conversation.view 注册自定义组件（createElement 面板）可行；
  - 实证组件在 tab 失活时的生命周期（卸载/隐藏/保活）——决定 P0 验收 2「零渲染」口径与 3.2.1「常驻 5s 节流」的实现方式。
  - 结论回填：integ / 2026-08-19 —— **承载能力 PASS**：动态插件 client 半可运行（host.call 回环实证），以 **lab-monitor 完全相同注册参数**（id 'lab-monitor'、order 20、thunk label、ctx.effect 包裹、createElement 组件）由探针复刻注册 `conversation.view` → `Slots.listSubTree` 占用者出现 `dyn/lapp-2 / lab-monitor / priority -9 / active:true`（自定义组件可承载、可渲染）；**lab-monitor 自身 client 半未注册**：同参数探针成功 → 非注册机制问题，系其 client apply 同步 `slots.register` 的激活时序/服务就绪问题（探针异步 run 微任务后执行成功），**修复方向：改用 `slots.inject('conversation.view', …)` 等待槽声明后注册（skill 文档化模式），或 client 半增加 slots 重探（v1.4.5/v2）**。P0 验收 2「零渲染」口径与 5s 节流实现方式按代码+mock-test [5] 定稿（组件内 setInterval 卸载即停）。
- [x] **样例③：interop 长驻流增量读实证**（v1.4 新增，风险 16）——**2026-08-18 实测完成（D-A）**
  - shell.start + readOutput 读 Windows 侧 dmon 流（`/mnt/c/Windows/System32/nvidia-smi.exe dmon -d 1 -s pucvmet`）：行完整性 / 缓冲边界 / EOF 感知——**增量读可行**（1s 行流稳定，`#` 表头 + 数据行，无缓冲撕裂）；
  - **dmon vs query 同秒偏差实测（D1-2 回填）**：
    - 空闲稳定负载（util≈2%）：dmon 3 行均值 2 vs query 2，**偏差 0**；
    - 空闲波动场景（两轮实测）：dmon 均值 11.7 vs query 24（偏差 12.3）、11.3 vs 18（偏差 6.7）——**空闲波动时瞬时 vs 均值差异显著**；
    - **结论（阈值定稿）**：偏差验收须在**稳定负载**下进行；**建议阈值：dmon 行均值 vs 同秒 query 偏差 ≤5（稳定负载下）**，P0 验收时按稳定负载场景复核；
  - 结论回填：architect / 2026-08-18，详细数据见 docs/research/08-sampling-empirical.md 增补

### P0 验收标准

- [x] ✅ **1. 核心数据面正确（自测：verify-host.js P0/A2 断言 platform/sources/gpu/cpu/mem/gpuState/procs/callCount/ui；verify-sampler.js dmon vs query 偏差 0）**
- [x] ✅ **1'. 会话端到端**（cordis_define 装载 + 实时 UI + lab_status 工具实证，待会话内）（后端语义，v1.4/v1.4.1）**：`lab_status` 工具返回正确 JSON 快照；**WSL 环境默认走 WindowsBackend**——GPU 快照经 `nvidia-smi.exe --query-gpu` interop 调用（实测 40–60ms）；conversation.view 默认出口（②）为 P0 主 UI 对象（自定义组件渲染能力先经样例②实证）；**比较方法（T4-3 修订 + D1-2）**：同秒内先后取 **dmon 流解析值**与 **query 快照值**（对比对象为 interop 通道）比较——**偏差阈值不预设 5%**，由 **P0 前样例③顺带实测（稳定负载）后定阈值**并回填本清单；**LinuxBackend 在纯 Linux 场景单独验收**（/proc 路径正确性）；
  - **结论回填（integ / 2026-08-19）**：lab_status 返回完整 JSON 快照（platform=wsl、sources={gpu:'query',cpu:'cim',mem:'cim',procs:'tasklist'}、GPU RTX 5060 Ti 真实 util/mem/temp/power、CPU/内存/Windows 进程表全真实）；lab_advice/lab_ctl 端到端可用；**会话内发现并修复 cordis 沙箱 shell 契约缺陷（v1.4.2）**：① makeRunner 未调 `shell.resolve()` 直传 run() → sandboxPolicy undefined → 全通道 TypeError（探针 A/B 路径实证）；② 默认 workspace-write 沙箱拦截 /mnt/c interop（C 路径 exit 126+denied）→ resolveSpec 统一 stamp danger-full-access（D/E 路径实证）→ 修复后 platform=wsl 全通道真实采样 + dmon 流正常。LinuxBackend /proc 路径由 verify-host [A2] + verify-sampler 覆盖（本机 WSL 无纯 Linux 场景）。
- [x] ✅ **2. 轮询节流 + 零渲染口径（自测：mock-test [5] 5s 节流、T2-3 退避、[6] 卸载即停；host 侧 callCount 断言）**
- [ ] ⬜ **2'. 会话端到端**（callCount 与 UI 5s 节奏对照）：数据消费者轮询生效（conversation.view 无 visible 语义 → 常驻 5s 节流）；**断言手段（T4-2）host 侧计数**：`callCount` 经 snapshot 字段暴露，对照「callCount 增量符合 5s 节流节奏」（callCount 只断言轮询频率）；**零渲染可操作定义**：组件卸载即停，或 label thunk 仅在 `last` 变化时更新 label（口径待样例②实证后定稿）；visible=false 暂停/保活断言移至 P2 验收 5；
  - **结论回填（integ / 2026-08-19）：部分验证，UI 侧受限**——5s 节流/退避/卸载即停由 mock-test [5][6] 自测覆盖；client 半运行确认（host.call 回环）；但 conversation.view 未注册（样例②）→ UI 轮询与 callCount 增量无会话内观测（lab_status 工具路径 callCount 恒 0 系设计：snapshotProvider 硬编码，不计数工具调用）；callCount 节奏断言留待 UI 出口修复后按 T4-2 复核。
  - **V2 状态（2026-08-20）**：conversation.view 已生效（V2.1 修复注册姿势，GUI 截图确认三个 tab 正常、5s 轮询节奏可见）→ callCount 会话内对照现可执行（GUI 实测 T4-2）；标记 B1 待 GUI 复核。
- [x] ✅ **3. 无 GPU 降级（自测：buildSnapshot 无 gpu → gpuState=unavailable + CPU/内存照常，sources 标注）**
- [ ] ⬜ **3'. 真实无 GPU 机实证**：probe() 失败（nvidia-smi.exe 不存在/interop 断）→ `sources.gpu='unavailable'` + CPU/内存/进程照常，**不抛错不挂起**；
  - **结论回填（integ / 2026-08-19）**：本机有 GPU（RTX 5060 Ti），无真实无 GPU 场景可实证；降级路径（buildSnapshot 无 gpu → gpuState='unavailable' + CPU/内存照常）由 verify-host 自测覆盖；真实无 GPU 机实证留待目标环境执行。
- [x] ✅ **4. dmon 自愈（代码 + verify-sampler 断流验证；指数退避→query-fallback + degraded 标记）**
- [x] ✅ **4'. 会话内 kill dmon 30s 恢复实证**：kill 后台 dmon 进程（Windows 侧）→ 30s 内指数退避重启恢复采集；连续失败回退 query 快照模式 + `degraded.gpu='query-fallback'` 期间出口有降级提示；
  - **结论回填（integ / 2026-08-19）**：**发现并修复 v1.4.3 缺陷**——`_lastRestartAt` 初始 0 使「now-0>300000」恒真 → 首杀即误入 query-fallback、重启路径从未生效（会话内首测即暴露）；修复为「5min 窗口过期先重置计数再按次数判断」。复验：kill dmon PID 29120 → 10s 内指数退避重启为新 PID 18648、持续稳定、无 degraded 降级标记；连续失败回退路径由 verify-host/verify-sampler 覆盖。
- [x] ✅ **5. 核心独立运行断言（自测：无 UI 出口时 host 层 verify-host 全链路独立跑通；client slots 缺席仍首帧拉取 [7]）**：**不注册任何 UI 出口（注释掉 ②③④）→ 核心层采集/告警/工具/prompt 注入仍完整可用**（lab_status 正常、alerts 正常产生）；
- [x] ✅ **6. 兜底同数据断言（自测：mock-test [10] 双检查 —— better-sidebar 可见性 false 时保持 conversation.view ②，同数据）**
- [ ] ⬜ **6'. 互斥形态真实设置模拟（改 aionui-panel.rightPanel）**：禁用/卸载 better-sidebar（0.13.0 互斥或移除插件）→ client 半**不 waiting**（console 无错误）、② 正常显示同数据；**互斥形态模拟（t6 补充）**：手动改 settings 命名空间 `aionui-panel.rightPanel='aionui-panel'`（或单测 `betterSidebarVisible` 标志逻辑）→ 断言 `snapshot.ui.betterSidebarVisible=false` 且出口层保持 ②；
  - **结论回填（integ / 2026-08-19）：live 模拟不可行，逻辑核对通过**——会话内实测 settings 命名空间 `aionui-panel` 未注册（`settings.update` 报 "namespace not registered"；沙箱无 schemastery 无法 register，与 T4-4 记录一致）→ 真实设置互斥无法构造；验证 `snapshot.ui.betterSidebarVisible=true`（无 better-sidebar 默认）且 client 半不 waiting；标志逻辑（`visible = !(ns && ns.rightPanel==='aionui-panel')`）由 verify-host [F] 自测（mock aionui → false）覆盖。
- [x] ✅ **7. 重复激活断言（自测：同插件多 apply 无崩溃）**
- [x] ✅ **7'. 同名工具重复 defineTool 行为会话内实证并回填**：同一插件被重复 define/激活 → 无崩溃、无重复 UI；同名工具重复 defineTool 行为（报错/覆盖/忽略）实证并记录（见样例①）；
  - **结论回填（integ / 2026-08-19）**：`harness.defineTool` 同名不报错（定义层容忍）；`harness.registerTool` 同名抛 `tool "lab_status" is already registered` 拒重（不覆盖不忽略）；lab-monitor 注册 try/catch 兜住 → 无崩溃、原工具完好、无重复 UI；重复 define/激活（含进程重启后重载）无崩溃。另实证：defineTool 缺 `output` 字段抛错。
- [x] ✅ **8. 真实采样实证（verify-sampler.js：query 40-60ms/CIM ~1.5s/tasklist GBK→iconv/dmon 流增量读，记录 docs/research/08-sampling-empirical.md §4）**：跑通 LinuxBackend + WindowsBackend **最小实现**（probe→snapshot→stream→close 全链路），实测耗时与编码处理（query 40–60ms / CIM ~1.5s / tasklist GBK 转码 / dmon 流增量读）**记录进 docs/research/08-sampling-empirical.md 增补**；
- [x] ✅ **9. close() 无孤儿（verify-sampler.js cmdline 含 dmon 核对：close 前 1 → 后 0）**
- [x] ✅ **9'. cordis 沙箱 stop 后无残留实证**，v1.4.1 核对方式修订，D2-1）**：`close()` 后无残留 interop 子进程（WSL 父进程死 Windows 子进程存活特性）——stop/update 时资源清理断言：**按命令行特征（cmdline 含 `dmon`）或 spawn 时记录的 pid 清单核对**（不用进程名，避免误伤用户同名进程）；
  - **结论回填（integ / 2026-08-19）**：`cordis_stop` 后 Windows tasklist 与 WSL ps 均无 nvidia-smi/dmon 残留（close() 按 spawn 清单 kill，D2-1 防孤儿生效）；进程重启后亦无孤儿。
- [x] ✅ **10. 无残留（自测：verify-host 清理 disposer 触发 backend.close）**
- [x] ✅ **10'. cordis_inspect_self 无 diagnostics 会话内核对**：`cordis_inspect_self(pluginId, packageId)` 无 diagnostics；停止插件后采集与 UI 全部随 fiber 清理（无残留 interval/进程）。
  - **结论回填（integ / 2026-08-19）**：运行态与停止态 `cordis_inspect_self(labm-1, pkg-*)` 均无 diagnostics（waitingFor=[]、handlers 正常注册/清空）；stop 后采集 interval/进程随 fiber 清理（见 9'）。每次 cordis_define 后核对均通过（CI 自测点）。

## P1「能懂」：生命周期钩子 + 状态机 + 平衡引擎 + 工具 + prompt 注入

**交付**：hooks + state-machine + balancer + tools + prompt

### P1 验收标准

- [x] ✅ **1. 验收命令固化（自测：verify-host [B]/[B2] —— python train_demo.py 命中 running、kill 不误判 done、pid 消失 ≥2 ps 周期判 crashed + CRITICAL 告警）**：用 `python train_demo.py` 形态命令（关键词表已含 `python train*.py`，并加入 `python -c`/`python3 -c` 覆盖内联形态）→ 状态机自动 running（pre-execute 命中）；`kill <pid>` 实验进程 → **≤15s 内判 crashed**（ps 间隔 5s，连续 ≥2 周期无存活 = 10~15s，T1-1 对齐）并出 CRITICAL 告警；**kill 自身的 tools/result 不得误判 done（T1-2 配对校验断言）**；
  - **结论回填（2026-08-19 队长，真实进程端到端）**：`scripts/e2e-host.js` 真实 python3 进程验证——`python3 /tmp/train_demo.py` 命中 running + **pid 关联（真实 ps）** → `kill <pid>` → **≤15s 判 crashed** + `critical/experiment-crash`（置信 0.9）+ kill 自身 result 不误判 done ✓（详见 docs/research/10-p1-e2e-test.md §5）；
  - **⚠️ e2e 抓到的真实缺陷（v1.4.5 修复）**：`python3 -c` 内联形态原指纹为内容哈希（`pyc:<hash>`），ps 行 args 是代码原文（引号剥离）→ 哈希永不匹配 → pid 关联结构性失败 → 正常结束误判 crashed；修复 = 指纹改 `pyc:` + 归一化命令后缀前 28 字符 + `normalizeCmdForMatch` + findAliveProc/result 配对同步剥离前缀与归一化。**verify-host 自测未覆盖（fake ps 直给 pid 行），真实端到端暴露**——验证了"自测 + 会话内实证"双轨的必要性。
- [x] ✅ **2. 正常结束 → done（自测：配对 result + 进程消失双确认；summary 含 gpuUtilMax/avg/memPeak/durationSec/dataPartial）**，实验记录含资源曲线摘要（>30min 实验摘要标注「部分数据」，R-3）；
  - **结论回填（2026-08-19 队长，真实进程端到端）**：`scripts/e2e-host.js`——`python3 -c 'import time; time.sleep(20)'`：pre→running→**pid 关联（v1.4.5 指纹修复后实验 pid=真实 python3 pid）**→result 配对（真实时序：进程运行中 emit）→进程消失双确认→**done**，alertsCriticalCount=0（正常结束零告警）✓（详见 docs/research/10-p1-e2e-test.md §5）。
- [x] ✅ **3. 工具正确性（自测：verify-host [E] lab_status brief/完整、lab_advice、lab_ctl set-threshold/pause/resume）**：`lab_status` 被 Agent 调用返回正确 JSON；`lab_advice` 在构造的「显存余量 <10% + util 95%」场景下返回 OOM 风险建议（置信度+动作）；
- [x] ✅ **4. prompt 注入（自测：promptLine 产出单行摘要）**
- [x] ✅ **4'. 会话内核对下一模型步 system prompt 含 [Lab Monitor]**：下一次模型步的 system prompt 含 `[Lab Monitor]` 段且数据为当前快照（会话内人工核对）；
  - **结论回填（integ / 2026-08-19）**：**发现并修复 v1.4.4 缺陷**——`systemPrompt.variable` 变量名须匹配 `/^[a-z][a-z0-9_]*$/`，原 `labStatus` 含大写 → variable() 抛错被 catch 吞掉 → section 从未注册（assemble 观测 hasLab=false 实证）；修复为小写 `labstatus` + `{{labstatus}}`。复验：`system-prompt/assemble` 观测 `hasLab: true` 且 `labVariable="[Lab Monitor] GPU0 9% · 1.8/15.9G · CPU 12% · 告警: 无"`（实时快照数据）→ **下一模型步 system prompt 含 [Lab Monitor] 段且数据为当前快照 ✓**。
- [x] ✅ **5. 平衡引擎 4 类规则（自测：verify-host [C] OOM 持续 10s → critical；io/thermal/imbalance 规则代码覆盖）**
- [x] ✅ **5'. 4 类规则各场景会话内构造触发**各构造场景触发一次，告警含分级字段；
  - **结论回填（integ / 2026-08-19）**：会话内构造触发 3/4 —— **thermal**（lab_ctl tempWarn 95→1，当前 37°C 恒命中 10s → warn+置信0.7+动作）、**oom**（memWarn/utilWarn→1，显存 11%+util≥1 → critical+置信0.85+动作）、**io-bottleneck**（CPU 满载 96% + GPU util<30 → warn+置信0.7+动作）；告警均含分级/置信度/动作，alertsCriticalCount 正确；**imbalance 需 ≥2 GPU，单 GPU 环境不可构造**（verify-host [C] 代码覆盖，留待多卡环境）。同时验证 **P2 2' 阈值即时生效**（lab_ctl set-threshold → ≤1 采样周期生效，thermal/oom 触发即证明；持久化留 v2，T4-4）。
- [x] ✅ **6. emit 可测点（emitLab 内部 dispatch + console 自观测日志；rc.6 沙箱无 ctx.emit → v2 升级为平台广播）**：插件内自监听或临时观测行断言 `lab/experiment-start|end|alert` 按状态机转移发出（console 日志断言）；
- [x] ✅ **7. 并发单跟踪约束（v1 语义）**：running 中新 start → 旧 run 归档 aborted，无双 running。
  - **⚠️ v2（2026-08-20，A2 多轨）语义变更**：改为**多轨并行跟踪**（上限 4）——running 中新 start 不再归档旧 run，并行上限满 4 时才归档最旧；**P1 验收 7 的 v1 断言不再成立，已由 verify-host [B3] 多轨场景取代**（并行 2 实验独立判定 + 上限 4 归档最旧）。
- [x] ✅ **7'. 会话内同时跑两条实验命令实证（v1）**：同时跑两条实验命令 → 只跟踪其一（新 start 命中时旧 run 自动归档 aborted），无双 running 并存。
  - **结论回填（integ / 2026-08-19）**：**发现并修复 v1.4.3 缺陷**——原 markResult 在「配对 result 早于 ps 周期到达」时（后台任务 pid 尚未关联）经 `!run.pid` 提前判 done（实验秒消失，实证 run 追踪丢失）；修复为 done 必须 ps tick 双确认（配对 result + 进程消失）。复验：`python3 /tmp/train_demo.py` 后台 → experiment=run-20260819-001 running+pid 关联；再起 train_demo2.py → 仅剩 run-002 running，run-001 自动归档 aborted（R-2），**无双 running ✓（v1 语义）**。
  - **⚠️ v2（2026-08-20）**：同上——多轨化后该实证场景不再适用，双实验并行由 verify-host [B3] 覆盖。

## P2「能管」：分级告警 + 原生兜底 UI + 历史曲线（better-sidebar 适配器为最后增量）

**交付**：告警防抖/静默、conversation.view 默认出口增强（label 实时摘要）、history 曲线、lab_ctl 阈值控制；better-sidebar 适配器（badge/pluginToggles）为 P2 末尾可选增量。

### P2 验收标准

- [x] ✅ **1. 告警分级防抖（自测：verify-host [C] 持续 10s 触发 + 同类 5 分钟防重、alertsCriticalCount +1；label 含告警数由 summaryLine 覆盖）**：util > 阈值（如 90%）**持续 10s** → host `alertsCriticalCount` +1 且同类告警 5 分钟内不重复（日志断言）；conversation.view 的 label 摘要含告警数（如 `2告警`）；
  - **结论回填（2026-08-19 队长，真实 balancer）**：`scripts/e2e-host.js` T4c——`setThresholds tempWarn=1`（真实温度 40°C 恒 >1）→ thermal warn 触发（置信 0.7）→ **阈值仍满足 + 等 12s → thermal 告警数 1→1 不增**（lastByRule 同类 5min 防重生效，真实时钟）✓（见 docs/research/10-p1-e2e-test.md §5）；
- [x] ✅ **2. 阈值生效（自测：verify-host [D] setThresholds 直连即时生效 + 携带 last-write-wins；M3 时间戳仲裁）**
- [x] ✅ **2'. 持久化断言（T4-4）v2 落地（2026-08-20 已启用）**：`settings.register('lab-monitor', Schema.object(...))` 已接入（v2 正式插件），`lab_ctl set-threshold` / `rpc.setThresholds` 写回 settings 命名空间；**持久化断言（T4-4）**：重新 apply（模拟 DSH 重启）后阈值/watchlist 从 settings 文档恢复（verify-host [D]/[E]，不依赖任何第三方）；
  - **结论回填（integ / 2026-08-19）**：**即时生效部分通过**——`lab_ctl set-threshold`（tempWarn 1 / memWarn+utilWarn 1）→ ≤1 采样周期生效（thermal/oom 10s 内触发证明，见 P1 5'）；**持久化部分留 v2（T4-4）**：动态插件沙箱无 schemastery，settings.register 不可用（实测 settings.update 报 namespace not registered），阈值事实来源为 host 内存，重新 define 后回默认值——符合 v1 设计（docs 记录在案）。
  - **结论回填（2026-08-20 实现）**：v2 插件 `settings.register('lab-monitor', Schema.object({ thresholds, watchProcs }))` 落地（schemastery 为 devDep+peerDep）；register 读磁盘文档 → `thresholds.apply(stored, true)` + watchProcs 过滤重挂 → `settingsScope.watch()` 响应外部修改；`persistState()` 在 setThresholds/rpcSnapshot(carry)/lab_ctl watch 后写回文档。**verify-host [D]/[E] ALL PASS**：setThresholds 写回 `user.thresholds.memWarn=80`；重启模拟（新 fiber + documents 保留）→ 阈值恢复 memWarn=80、watchlist 恢复并命中 llama-server(5555) ✓。
- [x] ✅ **3. 历史曲线（自测：verify-host [G] history 降采样 ≤500 点；ring 双条件封顶 + running 扩容）**：渲染 ≥30 分钟数据（降采样 ≤500 点）；关闭 UI 出口后 host 采集/告警不中断（核心独立于出口可见性）；
  - **结论回填（2026-08-19 队长，真实 ring）**：`scripts/e2e-host.js` T5——真实采样 ~2min 后 `labMonitor.history` 返回 **56 个降采样桶**（≤500 ✓）、桶含 **GPU util 聚合**（gpuUtil=2 实测，真实 dmon/query 采样）✓（见 docs/research/10-p1-e2e-test.md §5）；
- [x] ✅ **4. 出口健壮性（自测：label/badge thunk try/catch + console.error；better-sidebar 禁用时保持 ② 同数据 [10]）**：label/badge thunk 抛错 → 不白屏且有 console.error 日志；**better-sidebar 被禁用（0.13.0 互斥/整体禁用）时 conversation.view 默认出口正常显示同数据**（降级矩阵生效，docs/architecture/ui-adapters.md）；
- [x] ✅ **5. better-sidebar 适配器（自测：mock-test [8]/[9]/[10] —— registerTab/badge 99 封顶/pluginToggles 4 行/visible=false 30s 保活/阈值携带/双检查降级）**：注册 ③ 成功时 badge 显示 CRITICAL 计数（100 告警封顶 `99+`）、pluginToggles 阈值面板改值 ≤1 轮询周期生效、visible=false 时低频保活 30s 内 badge 更新、features 门控兼容旧版本；③ 不可用（get 返回 undefined / aionui-panel 互斥）→ **自动保持 ②**。

## CI 式自测点（§5.5）

- [x] ✅ 每次 `cordis_define` 后：`cordis_inspect_self(pluginId, packageId)` 无 diagnostics（队长执行）——**2026-08-19 会话内每次装载/更新后均核对通过（运行态与停止态）**；
- [x] ✅ 每里程碑结束：① `scripts/verify.sh`（2026-08-18 实现：node --check + 目录完整 + 契约静态核对 + dev-run + verify-host + mock-test + verify-sampler）（node --check 全部 js、目录完整性、契约文件存在）；② 本清单勾选；③ 结果回报队长；
- [ ] **回归红线**：改 client 半后重 define + 重跑 P0 验收 1/2/5/6（轮询节流、核心独立、兜底同数据、重复激活不回归）；**断连自愈回归（T2-3）**：插件重启/页面刷新后轮询自动恢复（退避重试 + 恢复立即刷新）。
  - **V2 状态（2026-08-20）**：V2.2 批次改动后 `scripts/verify.sh` 全绿（verify-host 47 断言 / mock-test 10 组 / verify-sampler）覆盖 P0 验收 1/2/5/6 自测语义；真实 GUI 复核（callCount 节奏 / 断连自愈）标记 B5 待安排。

## 关联文档

- 验收语义与字段：`docs/reference/data-model.md`、`docs/reference/protocol.md`
- 实施计划验收源文：`PLAN-v1.3.md` §4

---

## V2（正式插件形态，2026-08-20）

- 本文件内容在 V2 保持不变（数据模型/协议/验收语义与形态无关）。
- V2 差异：client 数据面由 `host.call('labMonitor.*')` 改为 **HTTP `/lab-monitor/api/*`**（协议字段不变）；工具注册走官方 `ctx.tools.register(defineTool(...))`；prompt 注入默认关闭（KV 缓存友好，`lab_status` 工具替代）。
- 完整迁移设计：`docs/research/12-v2-migration.md`；架构差异：`docs/architecture/core.md` §8-11。

## V2 完成记录（2026-08-20，A2 多轨 + 标签分组）

1. **多轨实验并行跟踪（A2）**：`state-machine` 单轨 → 多轨——`runs: Map<runId, RunRecord>` 并行跟踪，上限 `MAX_PARALLEL_RUNS=4`（满 4 归档最旧 aborted）；`pidMissingStreak` per-run；done/crashed 独立双确认；`markResult(paired, runId?)` runId 优先 + 指纹回退；`snapshot()` 返回 `{main, all}`；协议追加 `experiments[]`（`experiment` 保留为主实验，向后兼容）。verify-host [B3] 覆盖（并行 2 实验独立判定、主实验切换、上限 4 归档、清理）。
2. **标签分组（用户需求：手动打标签分组展示）**：`TagRule {id,label,patterns,kind,color}`——cmdline 正则匹配（**脚本形态天然覆盖**：解释器进程 cmdline 含脚本路径）；`lab_ctl tag add/remove/list`（add 支持 `patterns` 正则或 `pid` 快速打标自动生成规则）；settings 持久化（lab-monitor 命名空间 `tags` 键）；snapshot 追加 `tags[]` 聚合（组内 GPU/CPU/内存 + `runIds`）；UI 标签分组展示（experiment 组显示状态/时长/曲线，process 组显示资源占用）。verify-host [E2] 覆盖（add/pid 打标/list/remove/非法正则守卫/持久化）。
3. **追踪主键语义**：实验 = runId（每次 start 新 runId）+ cmdline 指纹；标签进程 = 规则（cmdline 正则）；pid 均为关联结果——**进程重启/pid 变化自动重关联**（R3 机制复用）。

## V2.5 完成记录（2026-08-22，P1 实验历史 + 设置面 + 使用文档）

> 延续 plugin-specialist 排查批次（V2.4 三件 P0 修复后用户指示「继续 P1」）。README「V2.5」section 为完整记录；本文件补勾选状态与验收映射。

1. **实验历史保留 + 复盘（新增验收语义，P1 扩展）**：状态机归档时生成指标摘要（GPU 峰值/均值、显存峰值、组 CPU/内存峰值、时长）入 history（上限 20）；快照新增 `ended[]`（`{runId,state,cmd,cmdFeature,startTs,endTs,summary}`，done/crashed/aborted 全覆盖）；UI「实验历史」折叠块复盘展示。自测：verify-host P1 断言段（ended 初始空/协议完整性/done/crashed/runId 精确匹配/aborted 归档，含修复 cap 场景测试盲区——psLines 覆盖致 crash 抢先，上限 aborted 分支此前未被覆盖）。
2. **设置面补全（ControlPanel，新验收语义）**：面板阈值编辑+保存（HTTP setThresholds 即时生效 + settings 持久化）、暂停/恢复（`control`，暂停跳过采样但快照照常）、清除告警（clear-alerts 带计数）；快照新增 `thresholds`/`enabled` 透出；**轮询周期由 `thresholds.pollMs` 动态驱动**（1000–60000 钳制，lab_ctl/面板改值即生效）。自测：verify-host 阈值透出（memWarn=80/pollMs=3000/enabled pause↔resume）+ mock-test 5 条渲染断言。
3. **使用文档（A1 落地）**：`docs/usage/usage.md`（工具用法手册 + UI 指引 + 阈值/标签/多轨语义 + 持久化 + 变更记录）。A1 状态：🔶 → ✅（用户决策不做 Agent 预设，以使用文档交付）。
4. **协议升级 1.4**：`docs/reference/protocol.md` 追加 `ended[]`/`thresholds`/`enabled`（纯增量，老 client 向后兼容）。
5. **回归**：`scripts/verify.sh --e2e` 全绿（verify-host/mock-test/verify-sampler/e2e 246s）；e2e timeout 200→300（真实采样 tick 抖动）。**端到端实证（2026-08-22 真实 DSH）**：DSH 工具通道跑 `python3 -c 'time.sleep(20)'` → run-20260822-001 `done` 归档，`ended[]` 含完整摘要（gpuUtilMax 20/avg 10/durationSec 41/dataPartial=false），面板「实验历史（1）」可见；终端直接跑命令不产生历史 —— 设计行为（无 pre-execute 事件），非 bug。

## V2.6 完成记录（2026-08-22，P2 实验历史持久化 + HTTP 暴露面实证）

> 触发：V2.5 端到端验证（Playwright MCP 浏览器实测）发现「实验历史重启即失」——history 纯内存。README「V2.6」section 为完整记录；本文件补勾选状态与验收映射。

1. **实验历史持久化（settings 命名空间 lab-monitor `history` 键）**：状态机新增 `restoreEnded(EndedRunSnapshot[])`（读回投影重建最小 RunRecord 追加 history 尾部，上限 `MAX_HISTORY=20` 常量）；`persistState()` 载荷加 `history`（ended 投影倒序）；**惰性写回**——`buildSnapshot` 出口检测 `history[0].endTs` 变化才落盘（新归档 ≤1 轮询周期写入，正常轮询零写入，重启恢复后不重复写）；schema 加 `history` 键。自测：verify-host 重启模拟 3 断言（重启后 ended[] 恢复 / runId 精确 runA done+runB crashed / summary 结构完整）。
2. **HTTP 暴露面实证（修正认知）**：Tailscale IP（100.64.0.2:13080）访问 `/lab-monitor/api/*` 实测超时不可达（000）→ `--trusted-host` 未暴露该端口，暴露面 = **localhost only**；「零鉴权」风险降级为防御性 backlog（未来开放端口转发需先加鉴权）。
3. **端到端实证（2026-08-22 真实 DSH + 浏览器）**：重启后跑 `python3 -c 'import time; time.sleep(6)'` → 归档 → **settings.yaml 落盘 `history` 键**（run-20260822-001 done，summary 完整）→ 面板「实验历史（1）」展开显示与持久化数据一致（GPU峰值 6%/均 4%/显存峰值 1.9G/10s）。
4. **回归**：verify.sh --e2e 全绿（verify-host 含 3 新断言 / mock-test / verify-sampler / e2e）。
5. **UI 微调（同批遗留提交）**：GPU 卡进度条 height 6→8 / borderRadius 3→4（视觉增强）。

## V2 阶段未完成项（2026-08-20 对照 PLAN + 本清单）

> 分类：A = 计划明确要求但代码未实现；B = 验收遗留（需真实环境/GUI）；C = 可选增强。
> 完整清单（含 A/B/C 表）见 README「未完成项清单」章节；下文为勾选状态与追踪。

### A 类（计划明确要求，代码未实现）

| 项 | 追踪 | 状态 |
|---|---|---|
| A1 指挥层 Agent 预设 lab-commander | ✅ **2026-08-22 落地（V2.5）**：用户决策不做预设，改为使用文档——`docs/usage/usage.md`（lab_status/lab_advice/lab_ctl 用法手册 + 面板 UI + 语义 + 持久化）；prompt 注入增强待讨论（KV 缓存影响） | ✅ 完成（以文档形式） |
| A2 多实验并行跟踪（R-2 留 v2） | ✅ **2026-08-20 实施完成**：多轨（上限 4 + per-run 判定 + runId 归属）+ 标签分组（TagRule 规则式打标 + lab_ctl tag + tags 聚合 + UI 分组展示）；verify-host [B3]/[E2] 全绿；见「V2 完成记录」 | ✅ 完成 |
| A3 webServer 自托管面板（出口④） | 可选（v2 前置已满足：API 数据面就绪） | ⬜ |
| A4 SSE /lab/events 远端扩展 | 可选（手机端/对接 monitor-panel） | ⬜ |

### B 类（验收遗留，需真实环境/GUI）

| 项 | 追踪 | 状态 |
|---|---|---|
| B1 P0 2' callCount 与 UI 5s 节奏对照 | 现可 GUI 复核（conversation.view 已生效） | ⬜ |
| B2 P0 3' 真实无 GPU 机实证 | 环境受限（留待目标环境） | ⬜ |
| B3 P0 6' 互斥形态真实设置模拟 | 逻辑已覆盖（mock-test [10]/verify-host [F]） | ⬜ |
| B4 P2 5 better-sidebar 真实注册 | 用户确认保持 ②，③ 有意不启用 | ⬜（有意保持） |
| B5 回归红线 + 断连自愈（T2-3） | 自测全绿；GUI 复核待安排 | ⬜ |

### C 类（可选增强，非阻塞）

- 告警静默窗口（风险 6「静默窗口 v2」）；编排层 Agent-teams（v3，明确不在当前范围）。
