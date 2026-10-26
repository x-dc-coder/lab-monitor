import { createEngine } from './engine.js';
import type { SamplerBackend } from '../sampler/backend-interface.js';
import { type DaemonConfig } from './config-store.js';
import type { AnySink, RunDataView } from './sinks/spi.js';
export interface CreateDaemonOptions {
    home?: string;
    stateHome?: string;
    port?: number;
    host?: string;
    /** 测试注入 sink（如必抛错的 fake） */
    sinks?: AnySink[];
    mcpEnabled?: boolean;
    mcpAllowControl?: boolean;
    token?: string;
    /** 测试跳过后端探测（不起采样后端，纯 HTTP/MCP 面） */
    skipBackend?: boolean;
    /** 测试注入采样后端（与 skipBackend 合用：不起真实后端，但 tickOnce 会记样本） */
    testBackend?: SamplerBackend;
}
export interface DaemonInstance {
    port: number;
    close(): Promise<void>;
    tickOnce(): Promise<void>;
    dispatchExperimentEnd(view: RunDataView): void;
    engine: ReturnType<typeof createEngine>;
    cfg: DaemonConfig;
}
export declare function createDaemon(opts?: CreateDaemonOptions): Promise<DaemonInstance>;
/** 常驻入口（node lib/types/daemon/main.js）；import 方仅消费 createDaemon */
export declare function main(): Promise<number>;
