import type { RunDataView, SinkContext, SinkHealth, ExperimentRecordSink } from './spi.js';
export declare class SwanLabSink implements ExperimentRecordSink {
    kind: "experiment-record";
    id: string;
    enabled: boolean;
    private ctx;
    private healthState;
    constructor(enabled: boolean);
    init(ctx: SinkContext): Promise<void>;
    onExperimentEnd(view: RunDataView): Promise<{
        accepted: boolean;
        reason?: string;
    }>;
    health(): SinkHealth;
    shutdown(): Promise<void>;
}
