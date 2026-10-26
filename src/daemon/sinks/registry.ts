/**
 * Sink registry：按 config.sinks[] 实例化 + 故障隔离分发。
 * 单 sink 抛错 → 捕获记 health，绝不向上传播（采样 tick / 其他 sink 不受影响）。
 */
import { readCredentialFile, type SinkConfig } from '../config-store.js'
import { SwanLabSink } from './swanlab-sink.js'
import { MonitorForwardSink } from './monitor-forward-sink.js'
import type { AnySink, MetricsWindow, RunDataView, SinkContext, SinkHealth } from './spi.js'

function makeContext(cfg: SinkConfig, home: string, stateDir: string): SinkContext {
  const clean: Record<string, unknown> = { ...cfg }
  delete clean.credentialRef
  delete clean.credentialFile
  return {
    log: (level, msg, fields) => {
      const line = JSON.stringify({ ts: Date.now(), level, module: 'sink:' + cfg.id, msg, fields: fields || {} })
      console.log('[lab-monitor] ' + line)
      void stateDir
    },
    config: clean,
    credential: (key: string): string | undefined => {
      const ref = typeof cfg.credentialRef === 'string' ? cfg.credentialRef : cfg.id
      const env = readCredentialFile(ref, home)
      return env[key]
    },
  }
}

export class SinkRegistry {
  private sinks: AnySink[] = []
  private home: string
  private stateDir: string

  constructor(home: string, stateDir: string, configs: SinkConfig[], extra?: AnySink[]) {
    this.home = home
    this.stateDir = stateDir
    for (const cfg of configs) {
      if (cfg.id === 'swanlab' && cfg.kind === 'experiment-record') {
        this.sinks.push(new SwanLabSink(cfg.enabled === true))
      } else if (cfg.id === 'monitor-dc-sy' && cfg.kind === 'metrics-forward') {
        this.sinks.push(new MonitorForwardSink(cfg.enabled === true))
      }
    }
    // 测试注入的 sink（verify-daemon.js 用；不走 config）
    if (extra) this.sinks.push(...extra)
    for (const s of this.sinks) {
      void s.init(makeContext(this.configOf(s), this.home, this.stateDir)).catch((e) => {
        console.warn('[lab-monitor] sink ' + s.id + ' init 失败（不影响采样）:', e instanceof Error ? e.message : e)
      })
    }
  }

  private configOf(s: AnySink): SinkConfig {
    return { id: s.id, kind: s.kind, enabled: s.enabled }
  }

  /** 实验结束分发（experiment-record 类；fire-and-forget，异常吞掉记 health） */
  dispatchExperimentEnd(view: RunDataView): void {
    for (const s of this.sinks) {
      if (s.kind !== 'experiment-record' || !s.enabled) continue
      // 同步抛错也隔离：统一走微任务，异常吞掉记 health（不阻塞采样 tick / 其他 sink）
      void Promise.resolve()
        .then(() => s.onExperimentEnd(view))
        .catch((e) => {
          console.warn('[lab-monitor] sink ' + s.id + ' onExperimentEnd 失败（不影响采样）:', e instanceof Error ? e.message : e)
        })
    }
  }

  /** 指标窗口分发（metrics-forward 类；同样隔离） */
  dispatchWindow(w: MetricsWindow): void {
    for (const s of this.sinks) {
      if (s.kind !== 'metrics-forward' || !s.enabled) continue
      void Promise.resolve()
        .then(() => s.onWindow(w))
        .catch((e) => {
          console.warn('[lab-monitor] sink ' + s.id + ' onWindow 失败（不影响采样）:', e instanceof Error ? e.message : e)
        })
    }
  }

  /** 手动触发（实验记录类，如 swanlabSync 别名；同步等待结果） */
  async triggerManual(id: string, run?: Record<string, unknown>): Promise<unknown> {
    const s = this.sinks.find((x) => x.id === id && x.kind === 'experiment-record')
    if (!s || s.kind !== 'experiment-record') return { ok: false, error: 'sink not found: ' + id }
    if (!s.enabled) return { ok: false, error: 'sink disabled: ' + id }
    try {
      return await s.onExperimentEnd({ run: run || {}, series: [], seriesAvailable: false, summary: {}, tagHits: [] })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  health(): SinkHealth[] {
    return this.sinks.map((s) => ({ id: s.id, kind: s.kind, ...s.health() }))
  }

  async stop(): Promise<void> {
    for (const s of this.sinks) {
      try { await s.shutdown() } catch { /* 关闭失败不阻塞退出 */ }
    }
    this.sinks = []
  }
}
