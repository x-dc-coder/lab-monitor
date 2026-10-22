import type { Alert, ProcStat, SamplePoint } from './types.js';
import type { ThresholdOverrides, Thresholds } from './constants.js';
export interface ThresholdCtrl {
    get(): Thresholds;
    effectiveTimestamp(): number;
    apply(patch: Partial<Thresholds>, isDirect: boolean): boolean;
    /** #13-3 差异化阈值：设置分层覆盖（实验类型 / 标签组级） */
    setOverrides(overrides: ThresholdOverrides | null | undefined): void;
    getOverrides(): ThresholdOverrides;
}
export declare function createThresholds(): ThresholdCtrl;
/** #13-3 差异化阈值：解析当前生效阈值——覆盖链 全局 → 实验类型 → 标签组（后级覆盖前级同名键） */
export declare function resolveThresholds(w: {
    experimentType?: string | null;
    tagHits?: string[] | null;
}, thr: Thresholds, overrides: ThresholdOverrides): Thresholds;
/** M1（issue#5 §1.4 trend=falling）：提取 rule 的触发指标（窗口首尾对比用）——
 *  返回 null 表示该 rule 无单体指标（如 imbalance 多卡差、io 无单体）→ 不做回落判断（视为 steady）。
 *  metric 值越大 = 越严重；末值 < 首值×0.9 → falling（缓解中）。 */
export declare function metricOf(rule: string): (w: SamplePoint) => number | null;
/** 清除过滤器（2026-08-22：lab_ctl clear-alerts 支持按 runId / rule 定向清除） */
export interface AlertClearFilter {
    runId?: string | null;
    rule?: string | null;
}
interface BalancerDeps {
    thresholds(): Thresholds;
    /** #13-3 差异化阈值：分层覆盖配置（createThresholds.getOverrides） */
    thresholdOverrides(): ThresholdOverrides;
    emitLab(type: string, data: Record<string, unknown>): void;
    /** M1（issue#5 升级规则）：warn 持续超该时长 → notify 视为 critical；≤0 = 关闭 */
    escalateAfterMs(): number;
}
export interface AdviceResult {
    advice: {
        level: string;
        rule: string;
        msg: string;
        confidence: number;
        actions: string[];
        evidence?: {
            procs: ProcStat[];
        };
        runId?: string | null;
        severity?: 1 | 2 | 3 | 4 | 5;
        urgency?: 1 | 2 | 3;
        trend?: 'rising' | 'steady' | 'falling';
        sustainedMs?: number;
        resource?: string;
        origin?: 'self' | 'other' | 'system';
        notifyLevel?: 'off' | 'notice' | 'wake';
        escalate?: boolean;
    }[];
    generatedAt: number;
}
export interface Balancer {
    evaluate(windowSnaps: SamplePoint[], runId: string | null): Alert[];
    snapshotAlerts(): Alert[];
    advice(): AdviceResult;
    count(): number;
    pushExternal(alert: Omit<Alert, 'ts'>): Alert;
    clear(filter?: AlertClearFilter): {
        cleared: number;
        remaining: number;
        criticalCount: number;
    };
    /** M1（issue#5 §1.2）：策略引擎回写告警的 notifyLevel（runId+rule 命中的最新一条；null 匹配无 runId 告警） */
    setNotifyLevel(runId: string | null, rule: string, level: 'off' | 'notice' | 'wake'): number;
}
export declare function createBalancer(deps: BalancerDeps): Balancer;
export {};
