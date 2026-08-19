/**
 * balancer（纯代码平衡引擎：4 类诊断 + 分级防抖）—— §5
 * + thresholds（host 内存事实来源；M3 last-write-wins）—— §6
 */
import { ALERT_MAX, SAMPLE_MS, THRESHOLD_DEFAULTS } from './constants.js'
import type { Alert, SamplePoint } from './types.js'
import type { Thresholds } from './constants.js'

// ── §6 阈值 ──────────────────────────────────────────────────────────────────

export interface ThresholdCtrl {
  get(): Thresholds
  effectiveTimestamp(): number
  apply(patch: Partial<Thresholds>, isDirect: boolean): boolean
}

export function createThresholds(): ThresholdCtrl {
  const t: Thresholds = { ...THRESHOLD_DEFAULTS }
  let appliedAt = 0
  return {
    get(): Thresholds {
      return { utilWarn: t.utilWarn, memWarn: t.memWarn, tempWarn: t.tempWarn, pollMs: t.pollMs }
    },
    effectiveTimestamp(): number {
      return appliedAt
    },
    apply(patch: Partial<Thresholds> | null | undefined, isDirect: boolean): boolean {
      if (!patch || typeof patch !== 'object') return false
      if (!isDirect && Date.now() < appliedAt) return false // 携带值晚于生效时间戳才覆盖（M3/R2）
      const keys = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs'] as const
      let changed = false
      for (let n = 0; n < keys.length; n++) {
        const k = keys[n]
        if (typeof patch[k] === 'number' && isFinite(patch[k] as number)) {
          t[k] = patch[k] as number
          changed = true
        }
      }
      if (changed) appliedAt = Date.now()
      return changed
    },
  }
}

// ── §5 balancer ──────────────────────────────────────────────────────────────

interface Rule {
  rule: string
  level: 'critical' | 'warn' | 'info'
  check(w: SamplePoint, thr: Thresholds): boolean
  msg: string
  actions: string[]
}

const RULES: Rule[] = [
  {
    rule: 'oom',
    level: 'critical',
    check(w, thr) {
      const g = w.gpu && w.gpu.length ? w.gpu[0] : null
      if (!g || !g.memTotalMiB) return false
      const usedPct = (g.memUsedMiB / g.memTotalMiB) * 100
      return usedPct >= thr.memWarn && g.utilPct >= thr.utilWarn
    },
    msg: '显存占用超阈值且利用率高，存在 OOM 风险',
    actions: ['降低 batch size', '关闭其他占用显存的进程'],
  },
  {
    rule: 'io-bottleneck',
    level: 'warn',
    check(w, thr) {
      const g = w.gpu && w.gpu.length ? w.gpu[0] : null
      return !!(g && g.utilPct !== null && g.utilPct < 30 && w.cpuPct !== null && w.cpuPct >= 90)
    },
    msg: 'GPU 利用率低但 CPU 满载，疑似数据加载瓶颈',
    actions: ['增加 num_workers', '检查数据管线磁盘 IO'],
  },
  {
    rule: 'thermal',
    level: 'warn',
    check(w, thr) {
      const g = w.gpu && w.gpu.length ? w.gpu[0] : null
      return !!(g && typeof g.tempC === 'number' && g.tempC >= thr.tempWarn)
    },
    msg: 'GPU 温度接近墙值，存在降频风险',
    actions: ['降低功耗目标', '检查散热/风扇'],
  },
  {
    rule: 'imbalance',
    level: 'info',
    check(w) {
      if (!w.gpu || w.gpu.length < 2) return false
      const us = w.gpu.map((g) => g.utilPct)
      const mx = Math.max(...us)
      const mn = Math.min(...us)
      return mx - mn >= 40
    },
    msg: '多 GPU 负载不均',
    actions: ['调整 batch/流水线分配', '检查 DDP 数据切分'],
  },
]

const MIN_HITS = Math.max(1, Math.round(10000 / SAMPLE_MS)) // 10s 阈值持续 → 5（2s 采样）
const MIN_INTERVAL_MS = 5 * 60 * 1000

interface BalancerDeps {
  thresholds(): Thresholds
  emitLab(type: string, data: Record<string, unknown>): void
}

export interface AdviceResult {
  advice: { level: string; rule: string; msg: string; confidence: number; actions: string[] }[]
  generatedAt: number
}

export interface Balancer {
  evaluate(windowSnaps: SamplePoint[], runId: string | null): Alert[]
  snapshotAlerts(): Alert[]
  advice(): AdviceResult
  count(): number
  pushExternal(alert: Omit<Alert, 'ts'>): Alert
}

export function createBalancer(deps: BalancerDeps): Balancer {
  const alerts: Alert[] = [] // 最近告警（倒序，最新在前）
  let criticalCount = 0
  const hitByRule: Record<string, number> = {} // rule → 连续命中窗口数（阈值持续 10s = 5 个 2s 采样）
  const lastByRule: Record<string, number> = {} // rule → 最近一次发出时间（同类最小间隔 5 分钟）

  function evaluate(windowSnaps: SamplePoint[], runId: string | null): Alert[] {
    if (!windowSnaps || !windowSnaps.length) return []
    const w = windowSnaps[windowSnaps.length - 1]
    const thr = deps.thresholds()
    const out: Alert[] = []
    for (let i = 0; i < RULES.length; i++) {
      const R = RULES[i]
      let ok = false
      try {
        ok = R.check(w, thr)
      } catch (e) {
        /* ignore */
      }
      if (ok) {
        hitByRule[R.rule] = (hitByRule[R.rule] || 0) + 1
      } else {
        hitByRule[R.rule] = 0
        continue
      }
      if (hitByRule[R.rule] < MIN_HITS) continue // 阈值需持续 10s
      const now = Date.now()
      if (lastByRule[R.rule] && now - lastByRule[R.rule] < MIN_INTERVAL_MS) continue // 5 分钟防重
      lastByRule[R.rule] = now
      hitByRule[R.rule] = 0
      const alert: Alert = {
        level: R.level,
        rule: R.rule,
        msg: R.msg,
        confidence: R.level === 'critical' ? 0.85 : 0.7,
        actions: R.actions,
        ts: now,
        runId: runId || null,
      }
      alerts.unshift(alert)
      if (alert.level === 'critical') criticalCount += 1
      if (alerts.length > ALERT_MAX) alerts.length = ALERT_MAX
      deps.emitLab('lab/alert', {
        level: alert.level,
        rule: alert.rule,
        msg: alert.msg,
        confidence: alert.confidence,
        actions: alert.actions,
      })
      out.push(alert)
    }
    return out
  }

  function snapshotAlerts(): Alert[] {
    return alerts.slice(0, 10)
  }

  // 非规则告警入口（如实验 crashed）：写入告警流并计 critical
  function pushExternal(alert: Omit<Alert, 'ts'>): Alert {
    const a: Alert = {
      level: alert.level || 'warn',
      rule: alert.rule || 'external',
      msg: alert.msg || '',
      confidence: alert.confidence !== undefined && alert.confidence !== null ? alert.confidence : 0.9,
      actions: Array.isArray(alert.actions) ? alert.actions : [],
      ts: Date.now(),
      runId: alert.runId || null,
    }
    alerts.unshift(a)
    if (a.level === 'critical') criticalCount += 1
    if (alerts.length > ALERT_MAX) alerts.length = ALERT_MAX
    return a
  }

  function advice(): AdviceResult {
    return {
      advice: alerts.slice(0, 5).map((a) => ({
        level: a.level,
        rule: a.rule,
        msg: a.msg,
        confidence: a.confidence,
        actions: a.actions,
      })),
      generatedAt: Date.now(),
    }
  }

  return {
    evaluate,
    snapshotAlerts,
    advice,
    count: () => criticalCount,
    pushExternal,
  }
}
