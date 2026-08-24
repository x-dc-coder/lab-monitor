/**
 * balancer（纯代码平衡引擎：诊断 + 归属仲裁 + 分级防抖）—— §5
 * 1.2（进程级跟踪 Phase C）：
 *   - 规则输入从「全系统首卡」升级为「实验进程组 G 自身 + GPU 整卡交叉验证 + 归属仲裁」
 *   - oom 三分支：G 活跃 → critical；G 不活跃 → 降级 warn「疑似他人占用」；无实验 → other-occupancy
 *   - io-bottleneck：实验组 CPU 满载 + GPU 空闲为主判；G.cpuPct 不可得（Windows）降级整机
 *   - thermal：整卡物理量 + G 活跃度上下文
 *   - Alert.evidence：进程级证据（CPU/内存为主，GPU 每进程辅助）
 * + thresholds（host 内存事实来源；M3 last-write-wins）—— §6
 */
import { ALERT_MAX, SAMPLE_MS, THRESHOLD_DEFAULTS } from './constants.js'
import type { Alert, ProcStat, SamplePoint } from './types.js'
import type { ThresholdOverrides, Thresholds } from './constants.js'

// ── §6 阈值 ──────────────────────────────────────────────────────────────────

export interface ThresholdCtrl {
  get(): Thresholds
  effectiveTimestamp(): number
  apply(patch: Partial<Thresholds>, isDirect: boolean): boolean
  /** #13-3 差异化阈值：设置分层覆盖（实验类型 / 标签组级） */
  setOverrides(overrides: ThresholdOverrides | null | undefined): void
  getOverrides(): ThresholdOverrides
}

export function createThresholds(): ThresholdCtrl {
  const t: Thresholds = { ...THRESHOLD_DEFAULTS }
  let overrides: ThresholdOverrides = {}
  let appliedAt = 0
  return {
    get(): Thresholds {
      return { utilWarn: t.utilWarn, memWarn: t.memWarn, tempWarn: t.tempWarn, pollMs: t.pollMs, procTopN: t.procTopN, wGpu: t.wGpu, wCpu: t.wCpu, wMem: t.wMem }
    },
    effectiveTimestamp(): number {
      return appliedAt
    },
    apply(patch: Partial<Thresholds> | null | undefined, isDirect: boolean): boolean {
      if (!patch || typeof patch !== 'object') return false
      if (!isDirect && Date.now() < appliedAt) return false // 携带值晚于生效时间戳才覆盖（M3/R2）
      const keys = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs', 'procTopN', 'wGpu', 'wCpu', 'wMem'] as const
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
    setOverrides(o: ThresholdOverrides | null | undefined): void {
      overrides = (o && typeof o === 'object') ? o : {}
    },
    getOverrides(): ThresholdOverrides {
      return overrides
    },
  }
}

/** #13-3 差异化阈值：解析当前生效阈值——覆盖链 全局 → 实验类型 → 标签组（后级覆盖前级同名键） */
export function resolveThresholds(
  w: { experimentType?: string | null; tagHits?: string[] | null },
  thr: Thresholds,
  overrides: ThresholdOverrides,
): Thresholds {
  const ov = { ...thr }
  const byExp = overrides.byExpType || {}
  const byTag = overrides.byTag || {}
  // 1) 实验类型级
  if (w.experimentType && byExp[w.experimentType]) {
    Object.assign(ov, byExp[w.experimentType])
  }
  // 2) 标签组级（主实验进程组命中的标签，按序覆盖——后命中的标签后覆盖）
  if (w.tagHits && w.tagHits.length) {
    for (const label of w.tagHits) {
      if (byTag[label]) Object.assign(ov, byTag[label])
    }
  }
  return ov
}

// ── §5 balancer（1.2：归属仲裁） ─────────────────────────────────────────────

/** 规则检查结果（ok + 动态 level/msg/actions/evidence） */
interface RuleCheckResult {
  ok: boolean
  level?: 'critical' | 'warn' | 'info'
  msg?: string
  actions?: string[]
  evidence?: { procs: ProcStat[] }
}

interface Rule {
  rule: string
  level: 'critical' | 'warn' | 'info'
  check(w: SamplePoint, thr: Thresholds): RuleCheckResult
  msg: string
  actions: string[]
  // ── M1（issue#5 严格分级，docs/research/22 §1.3 rule 语义权重表）──
  /** 严重度 1-5（静态来源） */
  severity: 1 | 2 | 3 | 4 | 5
  /** 紧迫性基准 1-3（trend=rising 时 +1 由 evaluate 推导） */
  urgencyBase: 1 | 2 | 3
  /** 资源类别 */
  resource: 'gpu-util' | 'vram' | 'temp' | 'cpu' | 'mem' | 'io' | 'process'
  /** 归属默认值 */
  origin: 'self' | 'other' | 'system'
}

function fmtGiB(mib: number): string {
  if (!Number.isFinite(mib)) return '0'
  const g = mib / 1024
  return g >= 100 ? String(Math.round(g)) : String(Math.round(g * 10) / 10)
}

/** 实验组活跃度判据（CPU/内存/存在性为主，pmon 为辅——设计 §2.3 队长约束） */
function groupActive(gs: SamplePoint['group']): boolean {
  if (!gs || gs.memberCount <= 0) return false
  if (gs.cpuPct !== null && gs.cpuPct >= 30) return true
  if (gs.memMiB !== null && gs.memMiB >= 2048) return true
  if (gs.gpuUtilPct !== null && gs.gpuUtilPct !== undefined && gs.gpuUtilPct >= 30) return true
  return false
}

/** M1（issue#5 §1.4 trend=falling）：提取 rule 的触发指标（窗口首尾对比用）——
 *  返回 null 表示该 rule 无单体指标（如 imbalance 多卡差、io 无单体）→ 不做回落判断（视为 steady）。
 *  metric 值越大 = 越严重；末值 < 首值×0.9 → falling（缓解中）。 */
export function metricOf(rule: string): (w: SamplePoint) => number | null {
  const gpuOf = (w: SamplePoint) => (w.gpu && w.gpu.length ? w.gpu[0] : null)
  switch (rule) {
    case 'oom':
    case 'other-occupancy': {
      // 显存利用率 %（首卡）
      return (w) => {
        const g = gpuOf(w)
        if (!g || !g.memTotalMiB) return null
        return (g.memUsedMiB / g.memTotalMiB) * 100
      }
    }
    case 'thermal':
      return (w) => { const g = gpuOf(w); return g && typeof g.tempC === 'number' ? g.tempC : null }
    case 'imbalance': {
      // 多卡 util 差（max-min）——单体即负载不均度
      return (w) => {
        if (!w.gpu || w.gpu.length < 2) return null
        const us = w.gpu.map((g) => g.utilPct)
        return Math.max(...us) - Math.min(...us)
      }
    }
    case 'io-bottleneck':
      return (w) => { const g = gpuOf(w); return g ? g.utilPct : null }
    default:
      return () => null
  }
}

/** 进程证据（告警触发时附 Top 相关进程；实验组内优先，系统其他补充）
 * 1.2 增强：WSL 双 pid 空间下，SamplePoint.procs 是 backend procs（tasklist，Windows 侧）——
 * 补充 Windows 侧 GPU 占卡进程（llama-server.exe/vmmemWSL 等）到 evidence，弥补 system.topN 的 Linux 侧局限 */
function evidenceOf(w: SamplePoint, preferGroup: boolean): { procs: ProcStat[] } | undefined {
  const list: ProcStat[] = []
  if (preferGroup && w.group && w.group.members.length) list.push(...w.group.members.slice(0, 3))
  if (w.system && w.system.topN.length) list.push(...w.system.topN.slice(0, preferGroup ? 2 : 5))
  // 补充：backend procs（tasklist）按内存 Top——WSL 下即系统其他进程（GPU 占卡者多为 Windows 侧）
  const gp = w.group ? w.group.members : []
  const others = (w.procs || [])
    .filter((p) => !gp.some((m) => m.pid === p.pid))
    .sort((a, b) => (b.memMiB ?? 0) - (a.memMiB ?? 0))
    .slice(0, preferGroup ? 2 : 3)
  for (let i = 0; i < others.length; i++) {
    const p = others[i]
    list.push({ pid: p.pid, cmd: p.cmd ?? null, cpuPct: typeof p.cpuPct === 'number' ? p.cpuPct : null, memMiB: typeof p.memMiB === 'number' ? p.memMiB : null, gpuUtilPct: typeof p.gpuUtilPct === 'number' ? p.gpuUtilPct : null })
  }
  return list.length ? { procs: list.slice(0, 5) } : undefined
}

const RULES: Rule[] = [
  {
    // C1：oom 归属仲裁三分支——G 活跃 critical / G 不活跃降级 warn（疑似他人）/ 无实验交给 other-occupancy
    rule: 'oom',
    level: 'critical',
    check(w, thr) {
      const g = w.gpu && w.gpu.length ? w.gpu[0] : null
      if (!g || !g.memTotalMiB) return { ok: false }
      const usedPct = (g.memUsedMiB / g.memTotalMiB) * 100
      if (usedPct < thr.memWarn) return { ok: false }
      const gs = w.group
      const expActive = !!w.experimentActive
      const memStr = fmtGiB(g.memUsedMiB) + '/' + fmtGiB(g.memTotalMiB)
      const otherN = w.system && w.system.topN ? w.system.topN.length : 0
      const otherTop = w.system && w.system.topN[0] ? w.system.topN[0] : null
      if (expActive && gs && gs.memberCount > 0) {
        const active = groupActive(gs)
        const ev = evidenceOf(w, true)
        if (active) {
          return {
            ok: true,
            level: 'critical',
            msg: `整卡显存 ${Math.round(usedPct)}%（${memStr}G）达阈值；实验进程组活跃（${gs.memberCount} 进程，CPU ${gs.cpuPct ?? '-'}%，内存 ${gs.memMiB ?? '-'}MiB）`,
            actions: ['降低 batch size', '检查实验进程内存占用'],
            evidence: ev,
          }
        }
        return {
          ok: true,
          level: 'warn',
          msg: `整卡显存 ${Math.round(usedPct)}%（${memStr}G）达阈值但实验进程活跃度低（CPU ${gs.cpuPct ?? '-'}%，内存 ${gs.memMiB ?? '-'}MiB），系统其他 ${otherN} 进程占卡，疑似他人负载`,
          actions: [otherTop ? `检查 pid ${otherTop.pid} (${otherTop.cmd || '?'}) 等其他进程占卡` : '检查系统其他进程占卡'],
          evidence: ev,
        }
      }
      return { ok: false } // 无实验 → other-occupancy 独立规则
    },
    msg: '显存占用超阈值且利用率高，存在 OOM 风险',
    actions: ['降低 batch size', '关闭其他占用显存的进程'],
    severity: 4,
    urgencyBase: 2,
    resource: 'vram',
    origin: 'self', // oom 动态降级分支（组不活跃）时 evaluate 会改写为 'other'
  },
  {
    // C2：io-bottleneck——实验组 CPU 满载 + GPU 空闲为主判；G.cpuPct 不可得（Windows）降级整机 + 标注；无实验不触发
    rule: 'io-bottleneck',
    level: 'warn',
    check(w, thr) {
      const g = w.gpu && w.gpu.length ? w.gpu[0] : null
      if (!g || g.utilPct === null || g.utilPct >= 30) return { ok: false }
      if (!w.experimentActive) return { ok: false } // 无实验：整机 CPU 满载不是数据管线瓶颈（防他人负载误报）
      const gs = w.group
      if (gs && gs.cpuPct !== null) {
        if (gs.cpuPct < 90) return { ok: false }
        return {
          ok: true,
          msg: `实验进程组 CPU ${gs.cpuPct}% 满载且 GPU 利用率 ${g.utilPct}% 低，疑似数据管线瓶颈`,
          actions: ['增加 num_workers', '检查数据管线磁盘 IO'],
          evidence: evidenceOf(w, true),
        }
      }
      // G.cpuPct 不可得（Windows tasklist 无 CPU%）→ 降级整机 + 标注
      if (w.cpuPct !== null && w.cpuPct >= 90) {
        return {
          ok: true,
          msg: `GPU 利用率 ${g.utilPct}% 低但全机 CPU ${w.cpuPct}% 满载（无法按进程拆分 CPU，基于全机判断）`,
          actions: ['增加 num_workers', '检查数据管线磁盘 IO'],
          evidence: evidenceOf(w, false),
        }
      }
      return { ok: false }
    },
    msg: 'GPU 利用率低但 CPU 满载，疑似数据加载瓶颈',
    actions: ['增加 num_workers', '检查数据管线磁盘 IO'],
    severity: 3,
    urgencyBase: 2,
    resource: 'io',
    origin: 'self',
  },
  {
    // C3：thermal——整卡物理量 + G 活跃度上下文（msg 动态）
    rule: 'thermal',
    level: 'warn',
    check(w, thr) {
      const g = w.gpu && w.gpu.length ? w.gpu[0] : null
      if (!g || typeof g.tempC !== 'number' || g.tempC < thr.tempWarn) return { ok: false }
      const gs = w.group
      const act = gs ? `实验进程组活跃度 CPU ${gs.cpuPct ?? '-'}%/内存 ${gs.memMiB ?? '-'}MiB` : '无实验'
      return {
        ok: true,
        msg: `GPU 温度 ${g.tempC}°C 达阈值（整卡物理量；${act}——若实验进程活跃度低则非实验负载引起）`,
        actions: ['降低功耗目标', '检查散热/风扇'],
        evidence: evidenceOf(w, true),
      }
    },
    msg: 'GPU 温度接近墙值，存在降频风险',
    actions: ['降低功耗目标', '检查散热/风扇'],
    severity: 4,
    urgencyBase: 2,
    resource: 'temp',
    origin: 'self',
  },
  {
    // imbalance：多卡间无进程边界，保持整卡（1.2 不变）
    rule: 'imbalance',
    level: 'info',
    check(w) {
      if (!w.gpu || w.gpu.length < 2) return { ok: false }
      const us = w.gpu.map((g) => g.utilPct)
      const mx = Math.max(...us)
      const mn = Math.min(...us)
      return { ok: mx - mn >= 40 }
    },
    msg: '多 GPU 负载不均',
    actions: ['调整 batch/流水线分配', '检查 DDP 数据切分'],
    severity: 2,
    urgencyBase: 1,
    resource: 'gpu-util',
    origin: 'self',
  },
  {
    // C4：other-occupancy（info）——无实验但整卡显存占用高 → 独立提示（把「他人占卡」从误报源变可解释信息）
    rule: 'other-occupancy',
    level: 'info',
    check(w, thr) {
      const g = w.gpu && w.gpu.length ? w.gpu[0] : null
      if (!g || !g.memTotalMiB) return { ok: false }
      const usedPct = (g.memUsedMiB / g.memTotalMiB) * 100
      if (usedPct < thr.memWarn || w.experimentActive) return { ok: false }
      // 2026-08-20（归因修复）：显存占卡的候选进程 = Windows 侧 backend procs（tasklist+pmon）
      // 按 GPU 利用率 >0 优先、其次内存 Top——**不再用 system.topN（WSL CPU 排行）**：
      // 实测 topN 把 CPU 最高的 dsh web(node) 误判为占卡 15.2G（node 进程根本不占显存）。
      // 真实占卡者（llama-server.exe/vmmemWSL/WSL GPU 直通进程）均落在 tasklist 侧，
      // 其显存池映射为 vmmemWSL 或 GPU 活跃进程，mem/gpu 维度可覆盖。
      const gp = w.group ? w.group.members : []
      const gpuCandidates = (w.procs || [])
        .filter((p) => !gp.some((m) => m.pid === p.pid) && typeof p.gpuUtilPct === 'number' && p.gpuUtilPct > 0)
        .sort((a, b) => (b.gpuUtilPct ?? 0) - (a.gpuUtilPct ?? 0))
      const memCandidates = (w.procs || [])
        .filter((p) => !gp.some((m) => m.pid === p.pid) && !(typeof p.gpuUtilPct === 'number' && p.gpuUtilPct > 0))
        .sort((a, b) => (b.memMiB ?? 0) - (a.memMiB ?? 0))
      const top = [...gpuCandidates, ...memCandidates].slice(0, 3)
      const topStat: ProcStat[] = top.map((p) => ({
        pid: p.pid,
        cmd: p.cmd ?? null,
        cpuPct: typeof p.cpuPct === 'number' ? p.cpuPct : null,
        memMiB: typeof p.memMiB === 'number' ? p.memMiB : null,
        gpuUtilPct: typeof p.gpuUtilPct === 'number' ? p.gpuUtilPct : null,
      }))
      const topStr = topStat.length ? '（Top: ' + topStat.map((p) => p.pid + ' ' + (p.cmd || '?')).join(', ') + '）' : ''
      return {
        ok: true,
        msg: `当前无实验但 GPU 显存占用 ${Math.round(usedPct)}%（${fmtGiB(g.memUsedMiB)}/${fmtGiB(g.memTotalMiB)}G），系统其他进程占卡${topStr}`,
        actions: [topStat[0] ? `检查 pid ${topStat[0].pid} (${topStat[0].cmd || '?'}) 等占卡进程` : '检查系统其他进程占卡'],
        evidence: { procs: topStat.slice(0, 5) },
      }
    },
    msg: '当前无实验但 GPU 显存被系统其他进程占用',
    actions: ['检查系统其他进程占卡'],
    severity: 2,
    urgencyBase: 1,
    resource: 'vram',
    origin: 'other',
  },
]

const MIN_HITS = Math.max(1, Math.round(10000 / SAMPLE_MS)) // 10s 阈值持续 → 5（2s 采样）
const MIN_INTERVAL_MS = 5 * 60 * 1000
/** 告警 TTL（2026-08-22：告警生命周期——超过 24h 的旧告警自动过期，不再永久堆积污染 badge/advice） */
const ALERT_TTL_MS = 24 * 60 * 60 * 1000
/** M1（issue#5）：trend 由持续时长映射——≥30s 视为 steady（持续），<30s 视为 rising（刚过防抖线） */
const TREND_STEADY_MS = 30 * 1000

/** 清除过滤器（2026-08-22：lab_ctl clear-alerts 支持按 runId / rule 定向清除） */
export interface AlertClearFilter {
  runId?: string | null
  rule?: string | null
}

interface BalancerDeps {
  thresholds(): Thresholds
  /** #13-3 差异化阈值：分层覆盖配置（createThresholds.getOverrides） */
  thresholdOverrides(): ThresholdOverrides
  emitLab(type: string, data: Record<string, unknown>): void
  /** M1（issue#5 升级规则）：warn 持续超该时长 → notify 视为 critical；≤0 = 关闭 */
  escalateAfterMs(): number
}

export interface AdviceResult {
  advice: {
    level: string
    rule: string
    msg: string
    confidence: number
    actions: string[]
    evidence?: { procs: ProcStat[] }
    runId?: string | null
    // M1（issue#5）：分级扩展字段（可选，兼容旧数据）
    severity?: 1 | 2 | 3 | 4 | 5
    urgency?: 1 | 2 | 3
    trend?: 'rising' | 'steady' | 'falling'
    sustainedMs?: number
    resource?: string
    origin?: 'self' | 'other' | 'system'
    notifyLevel?: 'off' | 'notice' | 'wake'
    escalate?: boolean
  }[]
  generatedAt: number
}

export interface Balancer {
  evaluate(windowSnaps: SamplePoint[], runId: string | null): Alert[]
  snapshotAlerts(): Alert[]
  advice(): AdviceResult
  count(): number
  pushExternal(alert: Omit<Alert, 'ts'>): Alert
  clear(filter?: AlertClearFilter): { cleared: number; remaining: number; criticalCount: number }
  /** M1（issue#5 §1.2）：策略引擎回写告警的 notifyLevel（runId+rule 命中的最新一条；null 匹配无 runId 告警） */
  setNotifyLevel(runId: string | null, rule: string, level: 'off' | 'notice' | 'wake'): number
}

export function createBalancer(deps: BalancerDeps): Balancer {
  const alerts: Alert[] = [] // 最近告警（倒序，最新在前）
  let criticalCount = 0
  const hitByRule: Record<string, number> = {} // rule → 连续命中窗口数（阈值持续 10s = 5 个 2s 采样）
  const lastByRule: Record<string, number> = {} // rule → 最近一次发出时间（同类最小间隔 5 分钟）

  /** 2026-08-22：过期清理——alerts 倒序存放（unshift 最新到头、尾部最旧），
   * 尾部连续超过 TTL 的旧告警弹出，同步扣减 criticalCount（count 只统计未过期告警）。
   * O(1) 均摊（通常尾部 0~1 条过期）。 */
  function pruneExpired(): { removed: number } {
    if (!alerts.length) return { removed: 0 }
    const now = Date.now()
    let removed = 0
    while (alerts.length) {
      const last = alerts[alerts.length - 1]
      if (now - last.ts <= ALERT_TTL_MS) break
      alerts.pop()
      if (last.level === 'critical') criticalCount = Math.max(0, criticalCount - 1)
      removed += 1
    }
    return { removed }
  }

  /** 2026-08-22：容量截断（alerts.length > ALERT_MAX 时丢最旧）——同步扣减被截 critical 计数 */
  function truncate() {
    if (alerts.length <= ALERT_MAX) return
    const dropped = alerts.slice(ALERT_MAX)
    for (let i = 0; i < dropped.length; i++) {
      if (dropped[i].level === 'critical') criticalCount = Math.max(0, criticalCount - 1)
    }
    alerts.length = ALERT_MAX
  }

  function clear(filter?: AlertClearFilter | null): { cleared: number; remaining: number; criticalCount: number } {
    pruneExpired()
    let cleared = 0
    if (filter && (filter.runId || filter.rule)) {
      // 定向清除：按 runId / rule 过滤，其余保留；只扣减被清 critical 计数
      const keep: Alert[] = []
      let removedCritical = 0
      for (let i = 0; i < alerts.length; i++) {
        const a = alerts[i]
        const hit = (filter.runId && a.runId === filter.runId) || (filter.rule && a.rule === filter.rule)
        if (hit) {
          cleared += 1
          if (a.level === 'critical') removedCritical += 1
        } else {
          keep.push(a)
        }
      }
      if (cleared) {
        alerts.length = 0
        for (let i = 0; i < keep.length; i++) alerts.push(keep[i])
        criticalCount = Math.max(0, criticalCount - removedCritical)
      }
    } else {
      // 全清：告警列表 + critical 计数归零
      cleared = alerts.length
      alerts.length = 0
      criticalCount = 0
    }
    return { cleared, remaining: alerts.length, criticalCount }
  }

  // M1（issue#5 §1.2）：策略引擎回写告警的 notifyLevel——按 runId（null 匹配无 runId 的告警）+ rule
  // 命中 alerts 最新一条（倒序首租）；返回写入条数（0 = 未命中，允许调用方决定是否回退写批内第一告警）。
  function setNotifyLevel(runId: string | null, rule: string, level: 'off' | 'notice' | 'wake'): number {
    let written = 0
    for (let i = 0; i < alerts.length; i++) {
      const a = alerts[i]
      if (a.rule !== rule) continue
      if (a.runId !== runId) continue // runId 精确匹配；null 匹配无 runId 的告警（other-occupancy/系统级）
      a.notifyLevel = level
      written += 1
      break // 只写最新一条（同 rule+runId 的多条防重后通常唯一）
    }
    return written
  }

  function evaluate(windowSnaps: SamplePoint[], runId: string | null): Alert[] {
    if (!windowSnaps || !windowSnaps.length) return []
    const w = windowSnaps[windowSnaps.length - 1]
    // #13-3 差异化阈值：全局 → 实验类型 → 标签组 覆盖链（无覆盖时等效全局）
    const thr = resolveThresholds(w, deps.thresholds(), deps.thresholdOverrides())
    const out: Alert[] = []
    for (let i = 0; i < RULES.length; i++) {
      const R = RULES[i]
      let res: RuleCheckResult = { ok: false }
      try {
        res = R.check(w, thr)
      } catch (e) {
        /* ignore */
      }
      if (!res.ok) {
        hitByRule[R.rule] = 0
        continue
      }
      hitByRule[R.rule] = (hitByRule[R.rule] || 0) + 1
      // ── M1（issue#5 严格分级）：从命中累计推导持续时长与趋势 ──
      // sustainedMs：超阈值已持续时长（2s × 命中数；含本次）。hitByRule 在发出后清零，
      // 因此告警的 sustainedMs 表达「本次持续段」的长度——刚过 10s 防抖 = 短，持续很久 = 长。
      const hitCount = hitByRule[R.rule]
      const sustainedMs = hitCount * SAMPLE_MS
      // trend 三态（M1 收尾 2026-08-23 落地，设计 §1.4 分级规则 3）：
      //   rising  = 刚过防抖线（<30s 持续）且窗口内指标未明显回落 —— 更紧迫（urgency+1）
      //   steady  = 已持续 ≥30s 或窗口内指标持平 —— 维持基准
      //   falling = 窗口首尾该 rule 触发指标明显回落（末值 < 首值×0.9）——「缓解中，不打扰」→ effectiveLevel 降为 info
      const wFirst = windowSnaps && windowSnaps.length ? windowSnaps[0] : w
      const wLast = w
      const metric = metricOf(R.rule) // 该 rule 的触发指标提取函数（窗口首/尾）
      const mFirst = metric(wFirst)
      const mLast = metric(wLast)
      const falling = (typeof mFirst === 'number' && typeof mLast === 'number' && mFirst > 0 && mLast < mFirst * 0.9)
      const trend: 'rising' | 'steady' | 'falling' = falling ? 'falling' : sustainedMs < TREND_STEADY_MS ? 'rising' : 'steady'
      if (hitCount < MIN_HITS) continue // 阈值需持续 10s
      const now = Date.now()
      if (lastByRule[R.rule] && now - lastByRule[R.rule] < MIN_INTERVAL_MS) continue // 5 分钟防重
      lastByRule[R.rule] = now
      hitByRule[R.rule] = 0
      const level = res.level || R.level
      // ── M1 escalate：warn 持续超 escalateAfterMs → 通知视为 critical（不改 level 本身）──
      // escalateAfterMs ≤ 0 = 关闭升级
      const escalate = level === 'warn' && deps.escalateAfterMs() > 0 && sustainedMs >= deps.escalateAfterMs()
      // oom 动态降级（组不活跃 → warn「疑似他人」）：res.level=warn 即表示动态降级 → origin='other'
      const origin: 'self' | 'other' | 'system' =
        R.origin === 'other' ? 'other' : (level === 'warn' && R.rule === 'oom' && res.level === 'warn') ? 'other' : R.origin
      const alert: Alert = {
        level,
        rule: R.rule,
        msg: res.msg || R.msg,
        confidence: level === 'critical' ? 0.85 : 0.7,
        actions: res.actions || R.actions,
        evidence: res.evidence,
        ts: now,
        runId: runId || null,
        // ── M1 扩展字段（severity/urgency/sustainedMs 必填；trend 两态简化）──
        severity: R.severity,
        urgency: Math.min(3, R.urgencyBase + (trend === 'rising' ? 1 : 0)) as 1 | 2 | 3,
        trend,
        sustainedMs,
        resource: R.resource,
        origin,
        notifyLevel: undefined, // 策略引擎（index.ts notifyAlerts）回填
        escalate: escalate || undefined,
      }
      alerts.unshift(alert)
      if (alert.level === 'critical') criticalCount += 1
      truncate() // 2026-08-22：容量截断同步扣减被截 critical 计数（此前 count 只增不减）
      deps.emitLab('lab/alert', {
        level: alert.level,
        rule: alert.rule,
        msg: alert.msg,
        confidence: alert.confidence,
        actions: alert.actions,
        evidence: alert.evidence,
        // M1（issue#5）：扩展字段随事件载荷透传（策略引擎与外部监听可用）
        severity: alert.severity,
        urgency: alert.urgency,
        trend: alert.trend,
        sustainedMs: alert.sustainedMs,
        resource: alert.resource,
        origin: alert.origin,
        escalate: alert.escalate,
      })
      out.push(alert)
    }
    return out
  }

  function snapshotAlerts(): Alert[] {
    pruneExpired() // 2026-08-22：pause 状态下 evaluate 不跑，读取时兜底过期清理
    return alerts.slice(0, 10)
  }

  // 非规则告警入口（如实验 crashed）：写入告警流并计 critical
  function pushExternal(alert: Omit<Alert, 'ts'>): Alert {
    // M1（issue#5）：传入的扩展字段透传；缺失时用 external/crash 默认元数据
    // （crash：severity 5 / urgency 3 / resource process / origin self / trend steady）
    const isCrash = alert.rule === 'experiment-crash' || (alert.msg || '').indexOf('意外退出') !== -1
    const a: Alert = {
      level: alert.level || 'warn',
      rule: alert.rule || 'external',
      msg: alert.msg || '',
      confidence: alert.confidence !== undefined && alert.confidence !== null ? alert.confidence : 0.9,
      actions: Array.isArray(alert.actions) ? alert.actions : [],
      evidence: alert.evidence,
      ts: Date.now(),
      runId: alert.runId || null,
      severity: alert.severity ?? (isCrash ? 5 : 3),
      urgency: alert.urgency ?? (isCrash ? 3 : 2),
      trend: alert.trend ?? 'steady',
      sustainedMs: alert.sustainedMs ?? 0,
      resource: alert.resource ?? 'process',
      origin: alert.origin ?? 'self',
      notifyLevel: alert.notifyLevel,
      escalate: alert.escalate,
    }
    alerts.unshift(a)
    if (a.level === 'critical') criticalCount += 1
    truncate() // 2026-08-22：容量截断同步扣减（此前 count 只增不减）
    return a
  }

  function advice(): AdviceResult {
    pruneExpired() // 2026-08-22：advice 不携带已过期告警（旧 crash 不再污染 Agent 建议）
    return {
      advice: alerts.slice(0, 5).map((a) => ({
        level: a.level,
        rule: a.rule,
        msg: a.msg,
        confidence: a.confidence,
        actions: a.actions,
        evidence: a.evidence,
        runId: a.runId,
        // M1（issue#5）：扩展字段透传（lab_advice 工具可见分级信息）
        severity: a.severity,
        urgency: a.urgency,
        trend: a.trend,
        sustainedMs: a.sustainedMs,
        resource: a.resource,
        origin: a.origin,
        notifyLevel: a.notifyLevel,
        escalate: a.escalate,
      })),
      generatedAt: Date.now(),
    }
  }

  return {
    evaluate,
    snapshotAlerts,
    advice,
    count: () => {
      pruneExpired() // 2026-08-22：badge 计数只统计未过期告警
      return criticalCount
    },
    pushExternal,
    clear,
    setNotifyLevel,
  }
}
