/**
 * monitor.dc-sy.cn 转发 sink（metrics-forward 参考适配器）
 * 载荷形状移植 scripts/forward-monitor.mjs：{results:[{node_id, group:'lab_monitor', metrics, payload}]}
 * 出厂 enabled:false；禁用状态下 onWindow 永不被 registry 调用（测试不触网）。
 */
import type { MetricsWindow, SinkContext, SinkHealth, MetricsForwardSink } from './spi.js';
export declare class MonitorForwardSink implements MetricsForwardSink {
    kind: "metrics-forward";
    id: string;
    enabled: boolean;
    private ctx;
    private healthState;
    constructor(enabled: boolean);
    init(ctx: SinkContext): Promise<void>;
    /** 窗口内 ring 点 → util avg/max（对齐旧转发器 6×5s 聚合语义） */
    private windowMetrics;
    onWindow(w: MetricsWindow): Promise<void>;
    health(): SinkHealth;
    shutdown(): Promise<void>;
}
