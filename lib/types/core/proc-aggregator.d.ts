/**
 * proc-aggregator（实验进程组 vs 非实验组拆分聚合）—— 设计文档 14 §2.2（Phase B3）
 * 纯函数：输入增强后 procs 表（pid/cmd/cpuPct/memMiB/ppid/gpuUtilPct）+ 实验进程组集合；
 * 输出 groupStats（主=CPU/内存/存在性，辅=GPU 每进程，预留=显存恒 null）+ systemStats。
 * 5s 粒度近似（R4：子进程延迟出生/成员消失延迟 ≤1 ps 周期）。
 */
import type { ProcSample } from '../sampler/backend-interface.js';
import type { GroupStats, SystemStats } from './types.js';
export interface AggregatorInput {
    procs: ProcSample[];
    /** 实验进程组 pid 集合（state-machine 每 5s 周期输出）；null/空 = 无实验 */
    group: Set<number> | null;
    runActive: boolean;
}
/** 拆分聚合：G（实验进程组） vs 非 G（系统其他进程） */
export declare function aggregateProcStats(input: AggregatorInput): {
    group: GroupStats | null;
    system: SystemStats | null;
};
