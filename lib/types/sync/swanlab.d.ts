import type { Ring } from '../core/ring.js';
import type { StateMachine } from '../core/state-machine.js';
import type { EndedRunSnapshot, RunRecord, SwanLabConfig, SwanLabStatus, SwanLabSyncConditions } from '../core/types.js';
export declare function isRunSyncing(runId: string): boolean;
export declare function acquireSyncLock(runId: string): boolean;
export declare function releaseSyncLock(runId: string): void;
/**
 * 脱敏命令行中的 token, api_key, password, secret 等敏感参数
 */
export declare function sanitizeCmd(cmd: string | null | undefined): string;
export interface MatchSyncResult {
    matched: boolean;
    reason?: string;
}
export declare function matchSyncConditions(run: RunRecord | EndedRunSnapshot, conditions?: SwanLabSyncConditions, tagHits?: string[]): MatchSyncResult;
export declare function checkSwanLabAvailable(pythonBin?: string): Promise<{
    available: boolean;
    error?: string;
}>;
export interface ExtractedMetrics {
    seriesAvailable: boolean;
    series: Array<{
        step: number;
        metrics: Record<string, number>;
    }>;
    summary: {
        gpuUtilMax: number | null;
        gpuUtilAvg: number | null;
        memPeak: number | null;
        groupCpuMax: number | null;
        durationSec: number;
    };
}
/**
 * 提取时间窗口内历史点并生成 SwanLab 标量指标
 * 若点数不足或被 Ring 覆盖，降级为 summary-only 上报，标记 seriesAvailable: false
 */
export declare function extractMetricsForRun(run: RunRecord | EndedRunSnapshot, ring?: Ring): ExtractedMetrics;
export interface SwanLabSyncOptions {
    config?: SwanLabConfig;
    stateMachine?: StateMachine;
    ring?: Ring;
    persistState?: () => Promise<void> | void;
    pythonBin?: string;
    workerScriptPath?: string;
    customLogDir?: string;
    force?: boolean;
    skipDepCheck?: boolean;
    activeTags?: string[];
}
export interface SwanLabSyncResult {
    ok: boolean;
    status?: SwanLabStatus;
    runId?: string;
    runUrl?: string;
    error?: string;
    skipped?: boolean;
}
/**
 * 触发单个实验上报 SwanLab
 */
export declare function syncRunToSwanLab(run: RunRecord | EndedRunSnapshot, options?: SwanLabSyncOptions): Promise<SwanLabSyncResult>;
export interface BatchSyncResult {
    total: number;
    synced: number;
    failed: number;
    skipped: number;
    results: Array<{
        runId: string;
        ok: boolean;
        status?: SwanLabStatus;
        error?: string;
        runUrl?: string;
    }>;
}
export declare function syncAllEligibleRuns(runs: (RunRecord | EndedRunSnapshot)[], options?: SwanLabSyncOptions): Promise<BatchSyncResult>;
