import { type ExpTypeRule } from './exp-type.js';
import type { Ring } from './ring.js';
import type { Alert, EndedRunSnapshot, ExperimentSnapshot, ExpType, RunRecord, SwanLabRunInfo, SwanLabStatus } from './types.js';
interface PsProc {
    pid: number;
    cmd: string;
    ppid?: number | null;
    /** 1.2：Linux ps pcpu 列（Windows 侧无）——G 聚合主判据输入 */
    cpuPct?: number | null;
    /** 1.2：Linux ps rss 列 → MiB（Windows 侧无）——G 聚合主判据输入 */
    memMiB?: number | null;
}
interface StateMachineDeps {
    ring?: Ring;
    emitLab(type: string, data: Record<string, unknown>): void;
    emitAlert(alert: Omit<Alert, 'ts' | 'runId'> & {
        runId?: string | null;
    }, runId?: string | null): void;
    /** M2（issue#6）：实验类型识别配置（getter——start 时取最新 settings 值，避免创建时快照） */
    expType?: () => {
        rules?: ExpTypeRule[];
        learning?: boolean;
        defaultType?: ExpType;
    };
}
export interface StateMachine {
    start(cmdStr: string, feature: string, agent?: {
        agentId?: string | null;
        agentRole?: 'root' | 'subagent';
        parentId?: string | null;
    }, opts?: {
        explicit?: boolean;
        deviceId?: string;
    }): RunRecord;
    associatePid(pid: number): void;
    associateProc(pid: number): void;
    markResult(paired: boolean, runId?: string | null): void;
    tick(aliveProcs: PsProc[]): void;
    tickGrace(run: RunRecord): void;
    setAlerting(on: boolean, runId?: string | null): void;
    snapshot(): {
        main: ExperimentSnapshot | null;
        all: ExperimentSnapshot[];
        ended: EndedRunSnapshot[];
    };
    restoreEnded(snapshots: EndedRunSnapshot[]): void;
    /** SwanLab 同步状态推进（4 态：pending/syncing/synced/failed） */
    markSwanLabSynced(runId: string, info: Partial<SwanLabRunInfo> & {
        status?: SwanLabStatus;
    }): boolean;
    /** 2026-08-24（#10 实验历史管理）：按 runId 删除单条已结束记录 */
    removeRun(runId: string): boolean;
    /** 2026-08-24（#10 实验历史管理）：清空已结束记录，保留最近 N 条（默认 0），返回被移除的 */
    clearHistory(keep?: number): RunRecord[];
    /** #21 多设备切换：平稳归档全部在途实验（避免触发 experiment-crash） */
    switchAwayAll(reason?: string): RunRecord[];
    cur(): RunRecord | null;
    all(): RunRecord[];
    history: RunRecord[];
}
/** ps 行解析（Linux/WSL 实验进程视角；与采样 procs 通道解耦）
 * 1.2：5 列（pid ppid pcpu rss args，rss KiB→MiB）；兼容 3 列（pid ppid args）、2 列（pid args） */
export declare function parsePs(out: {
    code: number;
    stdout: string;
} | null): PsProc[];
/** 候选进程存活检测（归一化对比；pyc: 前缀仅标记形态，匹配时剥离；僵尸进程不算存活） */
export declare function findAliveProc(run: RunRecord, procs: PsProc[]): PsProc | null;
export declare function createStateMachine(deps: StateMachineDeps): StateMachine;
export {};
