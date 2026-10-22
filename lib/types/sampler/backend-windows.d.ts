/**
 * WindowsBackend：interop 通道（WSL 场景）
 * 通道（t10 §4 契约表 + 实证耗时）：
 *   GPU 快照: nvidia-smi.exe --query-gpu（40-60ms，TTL 500ms 缓存）
 *   GPU 流:   nvidia-smi.exe dmon -d 1 -s pucvmet（1s 行流；EOF/超时→指数退避重启→query-fallback）
 *   CPU/内存: PowerShell CIM（~1.5s，TTL 5s 低频）；interop 断 → 回退 /proc（D1-1）
 *   进程:     tasklist /FO CSV（GBK→iconv，TTL 5s）；失败 → procs 空数组
 * 关闭:     close() 按 spawn pid 清单杀 interop 子进程（D2-1 防孤儿）
 */
import type { ProbeResult, Runner, SamplerBackend, Snapshot } from './backend-interface.js';
export declare class WindowsBackend implements SamplerBackend {
    id: "wsl";
    cacheTtlMs: number;
    lastCpuTimes: {
        idle: number;
        total: number;
        at: number;
    } | null;
    private runner;
    private spawned;
    private cimCache;
    private taskCache;
    private gpuQueryCache;
    private pmonCache;
    private restarts;
    private lastRestartAt;
    private fallbackMode;
    private closed;
    constructor(runner: Runner);
    private now;
    /** 缓存命中判断 */
    private cacheGet;
    private cacheSet;
    /**
     * 解析 nvidia-smi CSV noheader 行（7 列，实测）：
     *   "0, NVIDIA GeForce RTX 5060 Ti, 7 %, 1867 MiB, 16311 MiB, 43, 20.77 W\r"
     *   → { id, name, utilPct, memUsedMiB, memTotalMiB, tempC, powerW }（单位后缀剥离；\r 容忍）
     * 2026-08-20：数值字段安全解析——nvidia-smi 在异常/驱动降级时会输出 "N/A"，parseFloat 得
     * NaN 后直达工具输出破坏 lossless JSON 校验；非有限数一律视为 0（该通道不可用降级语义）。
     */
    private parseSmiLine;
    /** ① probe：interop 通道可用性（失败只降级该项，不整体失败） */
    probe(): Promise<ProbeResult>;
    /** GPU 快照（query，TTL 500ms 缓存） */
    private queryGpu;
    /**
     * CPU/内存/进程树（CIM，TTL 5s；interop 断 → 回退 /proc，D1-1）
     * 输出：首行 "cpuLoad;totalKB;freeKB"，随后每进程 "pid;ppid;name" 行 → ppidMap（进程树骨架，A4）
     */
    private sysMemCim;
    /**
     * 每进程 GPU 利用率（pmon，TTL 5s 低频，辅助证据——A1）
     * `nvidia-smi pmon -c 3 -s u` 多帧窗口：跳过 # 注释行，列 pid/type/sm/mem/enc/dec/command；
     * sm（compute%）`-` 视 0；同 pid 多帧取 max（R2：防单帧 `-` 低估）。
     * 失败/驱动不支持 → { ok:false }，上层 gpuUtilPct 留空（整卡指标不受影响）。
     * 2026-08-20 修复：新版 pmon 表头为 `gpu pid type sm mem enc dec jpg ofa command`（9 列，
     * 首列 gpu 索引 + jpg/ofa 列），旧版为 `pid type sm mem enc dec command`（6 列）。解析
     * 不再按固定列序，改为**按表头列名映射索引**——兼容两种格式，避免把 gpu 索引当 pid、
     * 把 type（C+G）当 sm 导致全部行被过滤（GPU 占用列恒 '-' 的根因）。
     */
    private queryPmon;
    /** interop 断时的 /proc 回退（WSL 内核视角仍真实，sources 标 procfs） */
    private sysMemProc;
    private cpuFromProc;
    /** 进程表（tasklist GBK→iconv，TTL 5s） */
    private procsTasklist;
    /** ② snapshot：全量规范化输出 */
    snapshot(): Promise<Snapshot>;
    /**
     * 剔除采样自曝进程（重名进程优化 ③）：
     * 1. 采样工具自身：tasklist.exe（快照窗口自采）/ nvidia-smi.exe（含 dmon 长驻流，每帧必现）
     * 2. 它们的控制台宿主 conhost.exe（ppid 指向采样工具）——用户程序的 conhost 保留
     * 匹配按 Windows 侧映像名，大小写不敏感（tasklist 输出实测小写）。
     */
    private purgeSamplerSelf;
    /** ③ stream：dmon 长驻流（指数退避重启 → query-fallback） */
    stream(): AsyncIterable<{
        ts: number;
        raw: string;
    }> | null;
    private streamIterator;
    /** ④ close：杀 interop 子进程（D2-1 防孤儿），幂等 */
    close(): Promise<void>;
}
