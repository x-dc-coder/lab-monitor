/**
 * Sink registry：按 config.sinks[] 实例化 + 故障隔离分发。
 * 单 sink 抛错 → 捕获记 health，绝不向上传播（采样 tick / 其他 sink 不受影响）。
 */
import { type SinkConfig } from '../config-store.js';
import type { AnySink, MetricsWindow, RunDataView, SinkHealth } from './spi.js';
export declare class SinkRegistry {
    private sinks;
    private home;
    private stateDir;
    constructor(home: string, stateDir: string, configs: SinkConfig[], extra?: AnySink[]);
    private configOf;
    /** 实验结束分发（experiment-record 类；fire-and-forget，异常吞掉记 health） */
    dispatchExperimentEnd(view: RunDataView): void;
    /** 指标窗口分发（metrics-forward 类；同样隔离） */
    dispatchWindow(w: MetricsWindow): void;
    /** 手动触发（实验记录类，如 swanlabSync 别名；同步等待结果） */
    triggerManual(id: string, run?: Record<string, unknown>): Promise<unknown>;
    health(): SinkHealth[];
    stop(): Promise<void>;
}
