/**
 * Sink SPI（两类，非单一 webhook）：experiment-record（实验结束同步）/ metrics-forward（周期指标转发）
 * 隔离契约：sink 回调抛错由 registry 捕获 → 记 health.lastError/consecutiveFailures，
 * 绝不向上传播，绝不阻塞采样 tick 与其他 sink。
 */

export type SinkKind = 'experiment-record' | 'metrics-forward'

export interface SinkHealth {
  state: 'ok' | 'degraded' | 'disabled' | 'error'
  lastRunAt: number | null
  lastError: string | null
  consecutiveFailures: number
  nextAttemptAt: number | null
  stats: { ok: number; failed: number; skipped: number }
}

export interface SinkContext {
  log(level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>): void
  /** 本 sink 配置段（已剔除 credential* 键的浅拷贝） */
  config: Record<string, unknown>
  /** 0600 凭据文件读取（credentials/<credentialRef>.env） */
  credential(key: string): string | undefined
}

export interface RunDataView {
  run: Record<string, unknown>
  series: Array<{ step: number; metrics: Record<string, number> }>
  seriesAvailable: boolean
  summary: Record<string, number | null>
  tagHits: string[]
}

export interface MetricsWindow {
  startTs: number
  endTs: number
  windowMs: number
  points: Array<{ ts: number; gpuUtil: number | null; gpuMem: number | null; cpu: number | null; memUsed: number | null }>
  latest: Record<string, unknown>
}

export interface ExperimentRecordSink {
  kind: 'experiment-record'
  id: string
  enabled: boolean
  init(ctx: SinkContext): Promise<void>
  onExperimentEnd(view: RunDataView): Promise<{ accepted: boolean; reason?: string }>
  health(): SinkHealth
  shutdown(): Promise<void>
}

export interface MetricsForwardSink {
  kind: 'metrics-forward'
  id: string
  enabled: boolean
  init(ctx: SinkContext): Promise<void>
  onWindow(window: MetricsWindow): Promise<void>
  health(): SinkHealth
  shutdown(): Promise<void>
}

export type AnySink = ExperimentRecordSink | MetricsForwardSink
