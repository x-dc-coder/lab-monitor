import type { Runner, SamplerBackend } from '../sampler/backend-interface.js';
import type { MonitorSnapshot } from '../core/types.js';
import type { DaemonConfig } from './config-store.js';
import type { SinkRegistry } from './sinks/registry.js';
export interface LabEvent {
    type: string;
    ts: number;
    runId: string | null;
    data: Record<string, unknown>;
}
export type EngineListener = (ev: LabEvent) => void;
/** 同一 (rule, 归一化命令) 两次收养的最短间隔（长于 ps 周期 5s，避免每个 tick 都 start）。 */
export declare const ADOPT_COOLDOWN_MS = 60000;
export type AdoptionDecision = 'adopt' | 'at-cap' | 'cooldown';
/**
 * 收养是否允许调用 machine.start。
 * at-cap：已达 MAX_PARALLEL_RUNS 时 start 会把最旧 running 归档 aborted，这里直接拒绝。
 * cooldown：lastAdoptAt 起 cooldownMs 内不再收养同一键。
 */
export declare function decideAdoption(input: {
    runningCount: number;
    maxParallel: number;
    lastAdoptAt: number | null;
    now: number;
    cooldownMs?: number;
}): AdoptionDecision;
export interface EngineDeps {
    cfg: DaemonConfig;
    runner: Runner;
    sinks?: SinkRegistry | null;
    /** 配置落盘（config-store 原子写）；engine 只调用，不碰文件 */
    persist: () => void;
    log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
    /** 测试注入采样后端（verify-daemon）；正式启动不传，由 startBackend 创建 */
    backend?: SamplerBackend;
}
/** 递归 JSON 清洗（与 src/index.ts 同语义：非有限数 → null、-0 → 0、环 → null） */
export declare function sanitizeJson<T>(value: T, depth?: number, seen?: WeakSet<object>): T;
export declare function createEngine(deps: EngineDeps): {
    start: () => void;
    stop: () => void;
    startWindowLoop: () => void;
    stopWindowLoop(): void;
    sampleTick: () => Promise<void>;
    tickOnce: () => Promise<void>;
    buildSnapshot: () => MonitorSnapshot;
    dispatch: (method: string, body: unknown) => unknown | Promise<unknown>;
    switchDevice: (targetDeviceId: string) => Promise<{
        ok: boolean;
        device: string;
        platform?: string;
        error?: string;
    }>;
    subscribe(l: EngineListener): () => void;
    isEnabled(): boolean;
    currentDevice(): string;
    startedAtMs(): number;
};
export type Engine = ReturnType<typeof createEngine>;
