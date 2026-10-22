/**
 * interop 完整路径 + 编码策略常量表（来源：t10 §4 通道契约表 + 08-sampling-empirical.md 实证）
 * 1. 全部完整路径（裸名不在 WSL PATH，实证 1.4）
 * 2. 编码分通道：nvidia-smi 纯 ASCII 免处理 / PowerShell chcp+UTF8 / tasklist GBK→iconv
 * 3. 频率分级：dmon 流 1s / query 40-60ms（TTL 500ms 内复用）/ CIM·tasklist ≥5s
 */
/** 完整路径常量（实证：/mnt/c 可用，裸名不在 PATH） */
export declare const NVIDIA_SMI = "/mnt/c/Windows/System32/nvidia-smi.exe";
export declare const POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
export declare const TASKLIST = "/mnt/c/Windows/System32/tasklist.exe";
/**
 * WSL interop 路径 → 原生 Windows 路径（'/mnt/c/x/y' → 'C:\\x\\y'）；非 /mnt/ 前缀原样返回。
 * 原生 Windows（windows-native 后端）child_process 不识别 /mnt/c 形式——2026-10-22 崩溃复盘：
 * spawn('/mnt/c/.../nvidia-smi.exe') ENOENT 且未挂 error 监听 → 未捕获异常打崩 DSH 宿主。
 */
export declare function toWinPath(p: string): string;
/** 编码策略（t10 §4） */
export declare const ENC: {
    readonly SMI: "ascii";
    readonly PS: "utf8";
    readonly TASKLIST: "GBK";
};
/** 频率分级（ms）：慢通道集中化/缓存复用 */
export declare const TTL: {
    readonly QUERY: 500;
    readonly CIM: 5000;
    readonly TASKLIST: 5000;
};
/** GPU 快照（query）：实测 40-60ms；CSV noheader 行：index,name,driver,util.gpu(%),memory.used(MiB),memory.total(MiB),temp(C),power(W) */
export declare const QUERY_ARGS: string[];
/** GPU 长驻流（dmon）：1s 行流，-s pucvmet；列：pwr gtemp mtemp sm mem enc dec clocks ... */
export declare const DMON_ARGS: string[];
/** 每进程 GPU 利用率（pmon）：-c 3 多帧窗口（R2 防单帧 `-` 低估）；-s u 只取 util 列，输出更短 */
export declare const PMON_ARGS: string[];
/**
 * Windows CPU/内存/进程树（CIM，TTL 5s）：输出 "cpuLoadPct;totalMemKB;freeMemKB" 首行
 * + 每进程 "pid;ppid;name" 行（Win32_Process.ProcessId/ParentProcessId，进程树骨架，实证 55884→47680）
 */
export declare const PS_SYSMEM: string[];
/** Windows 进程表（tasklist）：CSV 含头部 */
export declare const TASKLIST_ARGS: string[];
