import type { ExpType, NotifyLevel } from './types.js';
/** 配置层规则（experimentTypes[]，复用 TagRule 形态：pattern→type→notify 覆盖） */
export interface ExpTypeRule {
    type: ExpType;
    patterns: string[];
    notify?: {
        critical?: NotifyLevel;
        warn?: NotifyLevel;
    };
    expectedMaxSec?: number;
}
/** 学习层样本（fingerprint → 历史时长，供 p90 归类） */
export interface ExpTypeLearnSample {
    fingerprint: string;
    durationSec: number;
}
export interface ExpTypeResult {
    type: ExpType;
    /** 识别层：config=用户规则 / auto=自动正则 / learn=历史时长 / unknown=兜底未识别 */
    layer: 'config' | 'auto' | 'learn' | 'unknown';
}
export interface ExpTypeOptions {
    /** 配置层规则（settings experimentTypes；优先级最高） */
    rules?: ExpTypeRule[];
    /** 学习层历史样本（state-machine history：fingerprint + summary.durationSec） */
    history?: ExpTypeLearnSample[];
    /** 是否启用学习层（settings expTypeLearning，默认 true） */
    learning?: boolean;
    /** 兜底类型（settings expTypeDefault，默认 unknown） */
    defaultType?: ExpType;
}
/** 类型中文标签（UI/日志展示） */
export declare const EXP_TYPE_LABELS: Record<ExpType, string>;
/** 8 类枚举集合（配置校验用） */
export declare const EXP_TYPES: ExpType[];
export declare const EXP_TYPES_SET: ReadonlySet<string>;
export declare function classifyExpType(cmdStr: string | null | undefined, opts?: ExpTypeOptions): ExpTypeResult;
