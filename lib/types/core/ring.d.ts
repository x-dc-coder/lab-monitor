import type { SamplePoint } from './types.js';
export interface HistoryBucket {
    ts: number;
    gpuUtil: number | null;
    gpuMem: number | null;
    cpu: number | null;
    memUsed: number | null;
    /** 1.2：实验进程组 CPU（5s 周期聚合，2s 采样点 null 跳过） */
    groupCpu: number | null;
    /** 1.2：实验进程组内存 MiB */
    groupMem: number | null;
}
export interface Ring {
    push(s: SamplePoint): void;
    expand(): void;
    size(): number;
    history(sinceMs: number, bucketMs?: number): {
        points: HistoryBucket[];
        truncated: boolean;
    };
}
export declare function createRing(maxPoints: number, maxMs: number): Ring;
