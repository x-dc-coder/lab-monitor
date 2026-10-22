/**
 * LinuxBackend：/proc + ps，零依赖（纯 Linux 场景，WSL 内核视角 /proc）
 * 指标来源（实证 08 §1.6）：
 *   CPU: /proc/stat 两次采样差分（psutil 算法：首帧丢弃、负值截 0）
 *   内存: /proc/meminfo（MemTotal/MemAvailable，kB→MiB）
 *   进程: ps -eo pid,ppid,pcpu,rss,args（低频 5s 由上层控制；rss kB→MiB 补 memMiB，ppid 进程树骨架）
 *   GPU 整卡: nvidia-smi --query-gpu（#22 补齐：util/memUsed/memTotal/temp/power；无驱动/失败 → 降级）
 *   GPU 每进程: nvidia-smi pmon -c 3 -s u（辅助证据；慢通道 TTL 5s，无驱动/失败 → 静默空）
 */
import type { ProbeResult, Runner, SamplerBackend, Snapshot } from './backend-interface.js';
interface CpuTimes {
    idle: number;
    total: number;
    at: number;
}
export declare class LinuxBackend implements SamplerBackend {
    id: "linux";
    cacheTtlMs: number;
    lastCpuTimes: CpuTimes | null;
    private runner;
    private gpuQueryCache;
    private pmonCache;
    constructor(runner: Runner);
    private cacheGet;
    /** ① 探测：/proc 可读即可用（绝不抛错；探测 GPU 可用性） */
    probe(): Promise<ProbeResult>;
    /** /proc/meminfo → { totalMiB, availableMiB }（kB→MiB，向下取整） */
    private readMeminfo;
    /** /proc/stat 首行 → { idle, total, at }（jiffies 差分） */
    private readStat;
    /** CPU 差分（psutil 算法）：首帧返回 null（丢弃）；负值截 0 */
    private cpuPercent;
    /**
     * 解析 nvidia-smi CSV noheader 行（7 列，实测）：
     *   "0, NVIDIA GeForce RTX 3090, 7 %, 1867 MiB, 24576 MiB, 43, 20.77 W\r"
     *   → { id, name, utilPct, memUsedMiB, memTotalMiB, tempC, powerW }
     */
    private parseSmiLine;
    /**
     * GPU 快照（query，TTL 500ms 缓存）：
     * 7 列通用参数：index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw
     */
    private queryGpu;
    /**
     * 每进程 GPU 利用率（pmon，辅助证据——慢通道 TTL 5s）
     * nvidia-smi pmon -c 3 -s u 多帧窗口：跳过 # 行，列 pid/type/sm/...；`-` 视 0；同 pid 取 max。
     * 无 nvidia 驱动/失败 → 空 Map（gpuUtilPct 不填充，整卡通道不受影响）。
     */
    private queryPmon;
    /** ② 快照：全量规范化输出（协议 docs/03-protocol.md §2.1；1.2：procs +ppid/+gpuUtilPct；#22 补齐整卡 GPU） */
    snapshot(): Promise<Snapshot>;
    /** ③ 流：Linux 后端无 GPU 流能力（GPU 在 Windows 侧） */
    stream(): AsyncIterable<{
        ts: number;
        raw: string;
    }> | null;
    /** ④ 关闭：清差分基线与缓存（无子进程） */
    close(): Promise<void>;
}
export {};
