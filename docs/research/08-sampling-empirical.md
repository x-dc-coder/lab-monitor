# Lab Monitor 采样实证记录（2026-08-18 本机实测）

> **归档注记（2026-08-20 清理）**：本文所述 v1.4.5 MVP 资产（`plugin/` 动态版、`scripts/dev-run.sh`）已归档至 `docs/archive/v1.4.5-plugin/`。

> 目的：用户指出采样层从未真实跑通。本条记录本机（WSL2 Ubuntu 22.04 + Windows 11）实测结果，作为计划 v1.4 采集器设计的**事实基线**。

## 0. 环境

| 项 | 值 |
|---|---|
| 主机 | WSL2 Ubuntu 22.04.5（`wsl.exe --version` 2.6.3）+ Windows 11 |
| GPU | **NVIDIA GeForce RTX 5060 Ti**（驱动 596.49，Windows 侧） |
| WSL 视角内存 | MemTotal 14.3GB（.wslconfig 限制） |
| Windows 视角内存 | 31.7GB（Win32_OperatingSystem 实测） |
| WSLInterop | enabled（binfmt_misc WSLInterop 注册正常） |

## 1. 关键实证结论（推翻了计划 v1.3 假设）

### 1.1 ⚠️ WSL 内没有 nvidia-smi 命令
```
$ which nvidia-smi → command not found
$ ls /usr/lib/wsl/lib/ → 只有 libcuda.so/libd3d12.so 等，无 nvidia-smi
$ ls /dev/nvidia* → 无设备（GPU-PV 虚拟化直通，非传统 /dev/nvidiactl 形态）
```
**计划 v1.3 假设"WSL 内 `nvidia-smi --query-gpu` / `dmon` 可用"在本机不成立。**

### 1.2 ✅ GPU 采样必须走 Windows 侧 exe（interop 直调）
```
$ /mnt/c/Windows/System32/nvidia-smi.exe --query-gpu=... --format=csv,noheader
0, NVIDIA GeForce RTX 5060 Ti, 596.49, 20, 1764, 16311, 41, 14.38
耗时：首次 ~72ms，缓存后稳定 40–60ms
```
- 完整字段可用：util.gpu / util.memory / memory.used / memory.total / temp / power.draw / clocks
- compute-apps（进程级 GPU 归属）待验证（当前无 GPU 进程）

### 1.3 ✅ dmon 长驻流可跨 interop 使用（Windows 侧进程）
```
$ timeout 3 /mnt/c/Windows/System32/nvidia-smi.exe dmon -d 1 -s pucvmet
每秒一行：pwr/gtemp/mtemp/sm/mem/enc/dec/clocks/fb 等，exit 0
```
- 计划"shell.start 长驻 + readOutput 增量读"模式**可行**，但采集的是 Windows 进程输出，需经 interop 管道（与纯 Linux 长驻进程行为有差异，需在动态插件中实证稳定增量读）

### 1.4 ⚠️ cmd.exe / powershell.exe 裸名不在 WSL PATH
```
$ which cmd.exe / powershell.exe / nvidia-smi.exe → 全部 command not found
（WSL interop binfmt 正常，但 appendWindowsPath 未注入 /mnt/c 到 PATH）
```
- **必须用完整路径**调用 Windows 工具：
  - `/mnt/c/Windows/System32/nvidia-smi.exe`
  - `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`
  - `/mnt/c/Windows/System32/tasklist.exe`

### 1.5 ✅ Windows 系统指标通道（PowerShell CIM）
```
$ /mnt/c/.../powershell.exe -NoProfile -Command 'chcp 65001|Out-Null; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ...'
cpu=8 memTotalGB=31.7 memFreeGB=11.8    （耗时 ~1.5s 含 chcp 开销；纯 CIM 应 <1s）
```
- **编码坑（wsl-windows-bridge 已记录，实测确认）**：PowerShell 需 `chcp 65001` + `OutputEncoding=UTF8`，否则中文乱码；bash 侧传参必须**单引号**防 `$` 展开
- tasklist.exe 输出 GBK → `iconv -f GBK -t UTF-8` 转码后可解析（CSV）

### 1.6 ✅ Linux 侧 /proc 原生采样（WSL 内核视角）
```
/proc/meminfo: MemTotal 14310572 kB / MemAvailable 6448384 kB / SwapTotal 4GB
/proc/stat CPU: 两次采样差分可算利用率（idle 差 16193 ticks/1s）
```
- WSL 内存视图（14.3GB）≠ Windows 内存视图（31.7GB）——**platform 维度必须进数据模型**

## 2. 对采集器设计的直接影响（v1.4 输入）

| 计划 v1.3 假设 | 实测事实 | v1.4 修正 |
|---|---|---|
| WSL 内 `nvidia-smi` 命令 | 不存在 | **GPU 采样走 Windows interop**：`/mnt/c/Windows/System32/nvidia-smi.exe` |
| WSL 内 `dmon` 长驻流 | 命令不存在 | **Windows 侧 dmon 进程**经 interop 管道增量读（需动态插件实证） |
| 单平台（Linux） | WSL+Windows 双视图、内存不一致 | **SamplerBackend 抽象**：LinuxBackend（/proc+ps）+ WindowsBackend（nvidia-smi.exe+CIM/tasklist） |
| 工具调用无路径问题 | cmd/powershell 裸名不在 PATH | **完整路径常量表**（interop 路径配置） |
| 编码无问题 | GBK/UTF8 混用 | **输出规范**：nvidia-smi 纯 ASCII 免处理；PowerShell chcp 65001；tasklist iconv 转码 |

## 3. 采样通道实测表（v1.4 验收基线）

| 通道 | 命令/路径 | 实测耗时 | 状态 |
|---|---|---|---|
| GPU 快照 | `/mnt/c/Windows/System32/nvidia-smi.exe --query-gpu=...` | 40–60ms | ✅ 稳定 |
| GPU 流 | `...nvidia-smi.exe dmon -d 1 -s pucvmet` | 1s 行流 | ✅ 可用（动态插件增量读待实证） |
| Windows CPU/内存 | `powershell.exe -Command 'chcp 65001...; Get-CimInstance ...'` | ~1.5s（含 chcp） | ✅ 可用 |
| Windows 进程 | `/mnt/c/Windows/System32/tasklist.exe /FO CSV` | ~230ms | ✅ 可用（GBK 转码） |
| Linux CPU | `/proc/stat` 两次差分 | ~0ms | ✅ 原生 |
| Linux 内存 | `/proc/meminfo` | ~0ms | ✅ 原生 |
| Linux 进程 | `ps -eo pid,pcpu,pmem,cmd` | ~10ms | ✅ 原生 |

---

## 4. D-A sampler 实现实测增补（2026-08-18，architect）

> 依据：`plugin/host/sampler/` 六文件 + `scripts/verify-sampler.js`（node 直接运行，非 cordis 环境；runner 用 node child_process 适配，cordis 环境由主 index.js 用 ctx.shell 适配）。

### 4.1 本次实测结果（真实执行）

| 项 | 结果 |
|---|---|
| `detectPlatform()` | `'wsl'`（/proc/version 含 microsoft-standard-WSL2）✅ |
| LinuxBackend.probe | ok（内核 6.6.87.2-microsoft-standard-WSL2）✅ |
| LinuxBackend.snapshot | mem 13975/5817 MiB；CPU 差分首帧 null→二帧 1.1%；procs 26 ✅ |
| WindowsBackend.probe | gpu available（driver 596.49, count 1）、interop true ✅ |
| WindowsBackend.snapshot（首次冷启动） | **2403ms**（query ~40ms + CIM ~1.5s + tasklist ~230ms + 各自首建） |
| WindowsBackend.snapshot（缓存命中） | **0ms**（CIM/tasklist TTL 5s + query TTL 500ms 全命中）✅ |
| GPU 快照解析 | 7 列 CSV：`0, NVIDIA GeForce RTX 5060 Ti, 1 %, 1773 MiB, 16311 MiB, 41, 7.07 W`（**CRLF 行尾需容忍**；util/mem/temp/power 单位后缀剥离）✅ |
| CPU（CIM） | Win32_Processor.LoadPercentage 瞬时值（非差分，sources 标注 cim） |
| 内存（CIM） | 32485 MiB ≈ Windows 视角 31.7GB（与 /proc 13975 MiB 双视图并存，platform='wsl' 标注）✅ |
| 进程表（tasklist） | 403 进程；**GBK→iconv 转码后 CSV 解析**（memMiB 从 "12,345 K" 提取）✅ |
| 编码处理 | nvidia-smi ASCII 免处理 / PowerShell chcp 65001+UTF8 / tasklist iconv——全部验证 ✅ |

### 4.2 样例③：dmon 流 vs query 快照同秒偏差（D1-2 回填）

| 场景 | dmon 3 行 sm 值 | dmon 均值 | query util | 偏差 |
|---|---|---|---|---|
| 空闲稳定负载（本轮） | 2 / 2 / 2 | 2 | 2 | **0** |
| 空闲波动（前轮 1） | 7 / 4 / 24 | 11.7 | 24 | 12.3 |
| 空闲波动（前轮 2） | 9 / 7 / 18 | 11.3 | 18 | 6.7 |

**结论**：空闲时 GPU util 波动大（4%~24%），dmon 行均值 vs query 瞬时不可比；**稳定负载下偏差 0**。验收阈值定稿：**稳定负载下 dmon 行均值 vs 同秒 query 偏差 ≤5**（P0 验收按此复核）。

### 4.3 验收 9：close() 无孤儿（D2-1 cmdline 核对）

- dmon 流运行中：Windows 侧 `nvidia-smi.exe dmon ...` 进程数 = **1**（PowerShell `@(Get-CimInstance Win32_Process ... | Where CommandLine -match 'dmon').Count` 核对）；
- `close()` 后：**0** ✅（spawn pid 记录 + SIGKILL WSL 侧包装进程 → Windows 侧进程随之退出，无孤儿）。

### 4.4 踩坑记录（实现注意）

1. **nvidia-smi query 输出 7 列**（index,name,util,memUsed,memTotal,temp,power——无 driver 列），行尾 `\r\n`——解析须按 7 列 + `\r` 容忍；
2. **PowerShell `(...).Count` 空输出怪癖**：`(Get-CimInstance ...).Count` 返回空串，须用 `@(...).Count` 数组强制；
3. **PowerShell -Filter 单引号**：`-Filter "Name='nvidia-smi.exe'"` 在 execFile argv 直传下可用（不经 shell 无转义问题）；
4. **CIM 首建 ~1.5s**：snapshot 冷启动 2.4s 主要开销在 CIM——频率分级（TTL 5s）后热路径 0ms 验证有效；
5. **interop 长驻流**：dmon 增量读（readOutput）无缓冲撕裂，1s 行流稳定——风险 16 实证解除（待 cordis shell.start 环境复核）。
