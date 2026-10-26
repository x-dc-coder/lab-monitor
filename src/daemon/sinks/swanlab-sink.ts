/**
 * SwanLab sink（experiment-record 参考适配器）
 * enabled 且凭据文件存在 SWANLAB_API_KEY 时，实验结束委托 src/sync/swanlab.ts 的既有同步助手。
 * apiKey 只从 0600 凭据文件读入内存，绝不写入 config.json / 日志。
 */
import { syncRunToSwanLab } from '../../sync/swanlab.js'
import type { RunDataView, SinkContext, SinkHealth, ExperimentRecordSink } from './spi.js'

export class SwanLabSink implements ExperimentRecordSink {
  kind = 'experiment-record' as const
  id = 'swanlab'
  enabled: boolean
  private ctx: SinkContext | null = null
  private healthState: SinkHealth = {
    state: 'disabled',
    lastRunAt: null,
    lastError: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
    stats: { ok: 0, failed: 0, skipped: 0 },
  }

  constructor(enabled: boolean) {
    this.enabled = enabled
    if (!enabled) this.healthState.state = 'disabled'
  }

  async init(ctx: SinkContext): Promise<void> {
    this.ctx = ctx
  }

  async onExperimentEnd(view: RunDataView): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.enabled || !this.ctx) return { accepted: false, reason: 'disabled' }
    const apiKey = this.ctx.credential('SWANLAB_API_KEY')
    if (!apiKey) {
      this.healthState.stats.skipped += 1
      return { accepted: false, reason: 'credential SWANLAB_API_KEY missing' }
    }
    const project = typeof this.ctx.config.project === 'string' ? this.ctx.config.project : 'lab-monitor'
    const workspace = typeof this.ctx.config.workspace === 'string' ? this.ctx.config.workspace : ''
    this.healthState.lastRunAt = Date.now()
    try {
      const r = await syncRunToSwanLab(view.run as never, {
        config: { enabled: true, apiKey, project, workspace, triggerMode: 'auto' },
        force: false,
        skipDepCheck: false,
      })
      if (r.ok) {
        this.healthState.state = 'ok'
        this.healthState.consecutiveFailures = 0
        this.healthState.lastError = null
        this.healthState.stats.ok += 1
        return { accepted: true }
      }
      if (r.skipped) {
        this.healthState.stats.skipped += 1
        return { accepted: false, reason: r.error }
      }
      throw new Error(r.error || 'swanlab sync failed')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.healthState.state = 'error'
      this.healthState.lastError = msg
      this.healthState.consecutiveFailures += 1
      this.healthState.stats.failed += 1
      throw e // registry 统一捕获，不影响采样
    }
  }

  health(): SinkHealth {
    return { ...this.healthState, stats: { ...this.healthState.stats } }
  }

  async shutdown(): Promise<void> {
    this.ctx = null
  }
}
