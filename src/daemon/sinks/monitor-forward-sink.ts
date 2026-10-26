/**
 * monitor.dc-sy.cn 转发 sink（metrics-forward 参考适配器）
 * 载荷形状移植 scripts/forward-monitor.mjs：{results:[{node_id, group:'lab_monitor', metrics, payload}]}
 * 出厂 enabled:false；禁用状态下 onWindow 永不被 registry 调用（测试不触网）。
 */
import type { MetricsWindow, SinkContext, SinkHealth, MetricsForwardSink } from './spi.js'

const PROCS_TOP = 10
const CMD_MAX = 80

export class MonitorForwardSink implements MetricsForwardSink {
  kind = 'metrics-forward' as const
  id = 'monitor-dc-sy'
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

  /** 窗口内 ring 点 → util avg/max（对齐旧转发器 6×5s 聚合语义） */
  private windowMetrics(w: MetricsWindow): { utilAvg: number | null; utilMax: number | null; gpuMemAvg: number | null; cpuAvg: number | null; memUsedAvg: number | null } {
    const utils: number[] = []
    const mems: number[] = []
    const cpus: number[] = []
    const memUsed: number[] = []
    for (const p of w.points) {
      if (typeof p.gpuUtil === 'number') utils.push(p.gpuUtil)
      if (typeof p.gpuMem === 'number') mems.push(p.gpuMem)
      if (typeof p.cpu === 'number') cpus.push(p.cpu)
      if (typeof p.memUsed === 'number') memUsed.push(p.memUsed)
    }
    const avg = (a: number[]): number | null => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null)
    return {
      utilAvg: avg(utils),
      utilMax: utils.length ? Math.max(...utils) : null,
      gpuMemAvg: avg(mems),
      cpuAvg: avg(cpus),
      memUsedAvg: avg(memUsed),
    }
  }

  async onWindow(w: MetricsWindow): Promise<void> {
    if (!this.enabled || !this.ctx) return
    const token = this.ctx.credential('MONITOR_INGEST_TOKEN')
    const url = typeof this.ctx.config.url === 'string' ? this.ctx.config.url : ''
    const nodeId = typeof this.ctx.config.nodeId === 'string' ? this.ctx.config.nodeId : 'dc-desktop'
    const group = typeof this.ctx.config.group === 'string' ? this.ctx.config.group : 'lab_monitor'
    if (!token || !url) {
      this.healthState.stats.skipped += 1
      this.ctx.log('warn', 'monitor-dc-sy skipped: missing credential or url')
      return
    }
    const snap = (w.latest || {}) as Record<string, unknown>
    const procsRaw = Array.isArray(snap.procs) ? (snap.procs as Array<Record<string, unknown>>) : []
    const procsTop = procsRaw
      .filter((p) => typeof p.pid === 'number' && (p.pid as number) > 0)
      .sort((a, b) => ((b.memMiB as number | undefined) ?? 0) - ((a.memMiB as number | undefined) ?? 0))
      .slice(0, PROCS_TOP)
      .map((p) => ({ pid: p.pid, cmd: String(p.cmd || '').slice(0, CMD_MAX), memMiB: p.memMiB ?? null, cpuPct: p.cpuPct ?? null }))
    const m = this.windowMetrics(w)
    const metrics: Record<string, number | null> = {
      gpu_util_avg: m.utilAvg,
      gpu_util_max: m.utilMax,
      gpu_mem_used_mib_avg: m.gpuMemAvg,
      cpu_pct_avg: m.cpuAvg,
      mem_used_mib_avg: m.memUsedAvg,
      monitor_enabled: 1,
      alerts_crit: Array.isArray(snap.alerts) ? (snap.alerts as unknown[]).length : 0,
    }
    const body = {
      results: [
        {
          node_id: nodeId,
          group,
          metrics,
          payload: { ts: w.endTs, windowMs: w.windowMs, procs_top: procsTop, experiment: snap.experiment ?? null, alerts: snap.alerts ?? [] },
        },
      ],
    }
    this.healthState.lastRunAt = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error('ingest http ' + res.status)
      this.healthState.state = 'ok'
      this.healthState.consecutiveFailures = 0
      this.healthState.lastError = null
      this.healthState.stats.ok += 1
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.healthState.state = 'error'
      this.healthState.lastError = msg
      this.healthState.consecutiveFailures += 1
      this.healthState.stats.failed += 1
      throw e
    }
  }

  health(): SinkHealth {
    return { ...this.healthState, stats: { ...this.healthState.stats } }
  }

  async shutdown(): Promise<void> {
    this.ctx = null
  }
}
