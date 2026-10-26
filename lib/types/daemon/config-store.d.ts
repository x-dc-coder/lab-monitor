import { type ThresholdOverrides, type Thresholds } from '../core/constants.js';
import type { EndedRunSnapshot, ExpType, TagRule, TrackRule } from '../core/types.js';
import type { ExpTypeRule } from '../core/exp-type.js';
import type { BackendMode } from '../sampler/index.js';
/** 出厂配置（数值对齐 src/core/constants.ts THRESHOLD_DEFAULTS：90/95/85/5000/30/1/1/1） */
export interface SinkConfig {
    id: string;
    kind: 'experiment-record' | 'metrics-forward';
    enabled: boolean;
    [key: string]: unknown;
}
export interface DeviceEntry {
    id: string;
    label?: string;
    host: string;
    port?: number;
    user: string;
    keyPath?: string;
    pollMs?: number;
}
export interface DaemonConfig {
    schemaVersion: number;
    sampleMs: number;
    backendMode: BackendMode;
    thresholds: Thresholds;
    thresholdOverrides: ThresholdOverrides;
    watchProcs: string[];
    tags: TagRule[];
    trackRules: TrackRule[];
    history: EndedRunSnapshot[];
    alertNotify: 'off' | 'notice' | 'wake';
    alertTargets: string[];
    notifyThrottleMs: number;
    escalateAfterSec: number;
    notifyTimeoutMs: number;
    broadcast: boolean;
    experimentTypes: ExpTypeRule[];
    expTypeDefault: ExpType;
    expTypeLearning: boolean;
    subagentPolicy: 'readonly' | 'restricted' | 'full';
    devices: DeviceEntry[];
    currentDevice: string;
    server: {
        port: number;
        host: string;
        maxSseClients: number;
    };
    mcp: {
        enabled: boolean;
        allowControl: boolean;
    };
    sinks: SinkConfig[];
}
export declare const PROTOCOL_VERSION = "1.6";
export declare const DAEMON_VERSION = "2.0.0";
export declare function configHome(override?: string): string;
export declare function stateHome(override?: string): string;
/** 默认配置（THRESHOLD_DEFAULTS 对齐；sinks 两类参考适配器出厂 enabled:false） */
export declare function defaultConfig(): DaemonConfig;
/** 读取并合并默认值（浅合并 + 数组清洗；损坏文件回退默认并留 .corrupt 备份） */
export declare function loadConfig(homeOverride?: string): DaemonConfig;
/** 原子写：与 config.json 同目录的 tmp + rename（同文件系统；不用 os.tmpdir()，避免 EXDEV） */
export declare function saveConfig(cfg: DaemonConfig, homeOverride?: string): void;
/** token：首启生成 32 字节 hex，0600；已存在则读回 */
export declare function ensureToken(homeOverride?: string): string;
/** 凭据文件解析（KEY=VALUE 行；0600；不存在返回空对象） */
export declare function readCredentialFile(ref: string, homeOverride?: string): Record<string, string>;
/** 结构化日志（追加 ~/.local/state/lab-monitor/lab-monitord.log；token 不落日志） */
export declare function logLine(stateDir: string, level: 'info' | 'warn' | 'error', module: string, msg: string, fields?: Record<string, unknown>): void;
