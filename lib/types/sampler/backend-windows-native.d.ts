import type { ProbeResult, Runner, SamplerBackend, Snapshot } from './backend-interface.js';
export declare class WindowsNativeBackend implements SamplerBackend {
    id: "windows-native";
    cacheTtlMs: number;
    lastCpuTimes: {
        idle: number;
        total: number;
        at: number;
    } | null;
    private delegate;
    constructor(_runner: Runner);
    probe(): Promise<ProbeResult>;
    snapshot(): Promise<Snapshot>;
    stream(): AsyncIterable<{
        ts: number;
        raw: string;
    }> | null;
    close(): Promise<void>;
}
