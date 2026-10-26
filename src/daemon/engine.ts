/**
 * daemon 引擎：采样循环 + ring（K13 procs 压缩）+ 状态机 + 平衡引擎 + 阈值/规则/历史。
 * 组合既有 createBackend / createRing / createStateMachine / createBalancer —— 不复制 DSH 侧代码。
 * 引擎不 import node:http、不 import dsh/*。
 */
import { createBackend, probeBackend, SshRunner, LinuxBackend, type BackendMode } from '../sampler/index.js'
import type { ProcSample, Runner, SamplerBackend, Snapshot as RawSnapshot } from '../sampler/backend-interface.js'
import { createRing } from '../core/ring.js'
import { createStateMachine, parsePs } from '../core/state-machine.js'
import { createBalancer, createThresholds } from '../core/balancer.js'
import { aggregateProcStats } from '../core/proc-aggregator.js'
import { MAX_PARALLEL_RUNS, PS_INTERVAL_MS, THRESHOLD_DEFAULTS, makeTagId, normalizeCmdForMatch } from '../core/constants.js'
import type { EndedRunSnapshot, GroupStats, MonitorSnapshot, SamplePoint, SystemStats, TagGroup, TagRule, TrackRule } from '../core/types.js'
import type { DaemonConfig } from './config-store.js'
import type { SinkRegistry } from './sinks/registry.js'
import type { RunDataView, MetricsWindow } from './sinks/spi.js'

const RING_MAX_POINTS = 1000
const RING_MAX_MS = 30 * 60 * 1000
const RECENT_WINDOW_MAX = 5
const RING_PROCS_KEEP = 6 // K13：仅最近 6 点保留进程表
const HISTORY_MAX = 20

export interface LabEvent {
  type: string
  ts: number
  runId: string | null
  data: Record<string, unknown>
}

export type EngineListener = (ev: LabEvent) => void

/** 同一 (rule, 归一化命令) 两次收养的最短间隔（长于 ps 周期 5s，避免每个 tick 都 start）。 */
export const ADOPT_COOLDOWN_MS = 60_000

export type AdoptionDecision = 'adopt' | 'at-cap' | 'cooldown'

/**
 * 收养是否允许调用 machine.start。
 * at-cap：已达 MAX_PARALLEL_RUNS 时 start 会把最旧 running 归档 aborted，这里直接拒绝。
 * cooldown：lastAdoptAt 起 cooldownMs 内不再收养同一键。
 */
export function decideAdoption(input: {
  runningCount: number
  maxParallel: number
  lastAdoptAt: number | null
  now: number
  cooldownMs?: number
}): AdoptionDecision {
  const cd = input.cooldownMs ?? ADOPT_COOLDOWN_MS
  if (input.lastAdoptAt != null && input.now - input.lastAdoptAt < cd) return 'cooldown'
  if (input.runningCount >= input.maxParallel) return 'at-cap'
  return 'adopt'
}

export interface EngineDeps {
  cfg: DaemonConfig
  runner: Runner
  sinks?: SinkRegistry | null
  /** 配置落盘（config-store 原子写）；engine 只调用，不碰文件 */
  persist: () => void
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void
  /** 测试注入采样后端（verify-daemon）；正式启动不传，由 startBackend 创建 */
  backend?: SamplerBackend
}

function toSamplePoint(snap: RawSnapshot): SamplePoint {
  const m = snap.mem
  const total: number | null = m ? m.totalMiB : null
  const avail: number | null = m ? m.availableMiB : null
  const memUsed: number | null = total != null ? total - (avail == null ? 0 : avail) : null
  return {
    ts: snap.ts,
    gpu: snap.gpu || [],
    gpuState: snap.gpu && snap.gpu.length ? 'ok' : (snap.sources && snap.sources.gpu === 'unavailable' ? 'unavailable' : 'ok'),
    cpuPct: snap.cpu ? snap.cpu.percent : null,
    cores: snap.cpu && snap.cpu.cores !== undefined ? snap.cpu.cores : null,
    memUsedMiB: memUsed,
    memTotalMiB: total,
    procs: snap.procs || [],
    group: null,
    system: null,
    experimentActive: false,
    degraded: snap.degraded || null,
  }
}

/** 递归 JSON 清洗（与 src/index.ts 同语义：非有限数 → null、-0 → 0、环 → null） */
export function sanitizeJson<T>(value: T, depth = 0, seen?: WeakSet<object>): T {
  if (depth > 12) return null as T
  if (value === undefined) return null as T
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return (value === 0 ? 0 : value) as T
    return null as T
  }
  if (Array.isArray(value)) {
    const src = value
    if (!seen) seen = new WeakSet()
    if (seen.has(src)) return null as T
    seen.add(src)
    const out: unknown[] = new Array(src.length)
    for (let i = 0; i < src.length; i++) out[i] = sanitizeJson(src[i], depth + 1, seen)
    seen.delete(src)
    return out as T
  }
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    if (!seen) seen = new WeakSet()
    if (seen.has(src)) return null as T
    seen.add(src)
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src)) out[k] = sanitizeJson(src[k], depth + 1, seen)
    seen.delete(src)
    return out as T
  }
  return value
}

function prioritizeGpuProcs(procs: ProcSample[], n: number): ProcSample[] {
  const gpuVal = (p: ProcSample): number => {
    const v = p.gpuUtilPct !== undefined && p.gpuUtilPct !== null ? p.gpuUtilPct : p.gpu
    return typeof v === 'number' && !Number.isNaN(v) ? v : -1
  }
  const gpuOnes = procs.filter((p) => gpuVal(p) >= 0)
  const gpuOff = procs.filter((p) => gpuVal(p) < 0)
  gpuOnes.sort((a, b) => gpuVal(b) - gpuVal(a))
  return [...gpuOnes, ...gpuOff].slice(0, n)
}

export function createEngine(deps: EngineDeps) {
  const cfg = deps.cfg
  const log = deps.log || (() => {})

  let enabled = true
  const listeners = new Set<EngineListener>()
  const runtimeWatch = new Set<string>()
  let lastGroupStats: GroupStats | null = null
  let lastSystemStats: SystemStats | null = null
  let callCount = 0
  let startedAt = Date.now()
  const recentWindow: SamplePoint[] = []

  const backendState: {
    backend: SamplerBackend | null
    runner: Runner
    sshRunner: SshRunner | null
    currentDevice: string
    lastSnap: RawSnapshot | null
    platform: string
    stopped: boolean
    psAt: number
  } = { backend: null, runner: deps.runner, sshRunner: null, currentDevice: cfg.currentDevice || 'local', lastSnap: null, platform: 'unknown', stopped: false, psAt: 0 }

  if (deps.backend) {
    backendState.backend = deps.backend
    // 注入后端的单测不在首拍 exec 真实 ps（收养护栏由 decideAdoption 单测覆盖）
    backendState.psAt = Date.now()
  }

  function emitLab(type: string, data: Record<string, unknown>): void {
    const ev: LabEvent = { type, ts: Date.now(), runId: typeof data.runId === 'string' ? data.runId : null, data }
    for (const l of listeners) {
      try { l(ev) } catch { /* 监听者异常不阻塞引擎 */ }
    }
    // 实验结束：历史投影 + sink 分发（隔离在 registry 内）
    if (type === 'lab/experiment-end') {
      const ended = machine.snapshot().ended
      const latest = ended.length ? ended[0] : null
      if (latest) {
        cfg.history = [latest as EndedRunSnapshot, ...cfg.history.filter((h) => h.runId !== latest.runId)].slice(0, HISTORY_MAX)
        deps.persist()
        const view: RunDataView = {
          run: latest as unknown as Record<string, unknown>,
          series: [],
          seriesAvailable: false,
          summary: {},
          tagHits: [],
        }
        if (deps.sinks) deps.sinks.dispatchExperimentEnd(view)
      }
    }
  }

  const ring = createRing(RING_MAX_POINTS, RING_MAX_MS)
  const thresholds = createThresholds()
  // 配置文件阈值 → 阈值控制器（daemon 无 settings.yaml，配置文件即基线）
  thresholds.apply({ ...THRESHOLD_DEFAULTS, ...cfg.thresholds } as never, false)

  const balancer = createBalancer({
    thresholds: () => thresholds.get(),
    thresholdOverrides: () => thresholds.getOverrides(),
    emitLab,
    escalateAfterMs: () => (cfg.escalateAfterSec > 0 ? cfg.escalateAfterSec * 1000 : 0),
  })

  const machine = createStateMachine({
    ring,
    emitLab,
    emitAlert: (alert, runId) => {
      balancer.pushExternal({ ...alert, runId: runId || null })
      emitLab('lab/alert', { level: alert.level, rule: alert.rule, msg: alert.msg, confidence: alert.confidence, actions: alert.actions, runId: runId || null })
    },
    expType: () => ({ rules: cfg.experimentTypes, learning: cfg.expTypeLearning, defaultType: cfg.expTypeDefault }),
  })
  // 历史恢复（daemon 重启不丢已归档实验记录）
  if (cfg.history.length) machine.restoreEnded(cfg.history as never)

  function watchSet(): string[] {
    return Array.from(new Set([...cfg.watchProcs, ...runtimeWatch]))
  }

  function tagMatches(rule: TagRule, cmd: string): boolean {
    if (!cmd || !Array.isArray(rule.patterns)) return false
    for (const p of rule.patterns) {
      if (!p) continue
      try {
        if (new RegExp(p, 'i').test(cmd)) return true
      } catch { /* 非法正则忽略 */ }
    }
    return false
  }

  function trackRuleMatches(rule: TrackRule, cmd: string): boolean {
    if (!cmd || !Array.isArray(rule.patterns)) return false
    for (const p of rule.patterns) {
      if (!p) continue
      try {
        if (new RegExp(p, 'i').test(cmd)) return true
      } catch { /* 非法正则忽略 */ }
    }
    return false
  }

  // ── 采样循环 ────────────────────────────────────────────────────────────
  let tickBusy = false
  let timer: ReturnType<typeof setInterval> | null = null
  const pushedPoints: SamplePoint[] = [] // K13 压缩索引：ring 内同引用

  async function sampleTick(): Promise<void> {
    if (tickBusy || !enabled || !backendState.backend) return
    tickBusy = true
    try {
      const snap = await backendState.backend.snapshot()
      if (!snap) return
      backendState.lastSnap = snap
      const pt = toSamplePoint(snap)
      ring.push(pt)
      pushedPoints.push(pt)
      if (pushedPoints.length > RING_PROCS_KEEP + 40) pushedPoints.splice(0, pushedPoints.length - (RING_PROCS_KEEP + 40))
      recentWindow.push(pt)
      while (recentWindow.length > RECENT_WINDOW_MAX) recentWindow.shift()
      // K13：除最近 RING_PROCS_KEEP 点外，更早点 procs 置空（原地——ring 持有的是同一引用）
      for (let i = 0; i < pushedPoints.length - RING_PROCS_KEEP; i++) {
        const old = pushedPoints[i]
        if (old.procs && old.procs.length) old.procs = []
      }

      const runsNow = machine.all()
      const g0 = pt.gpu && pt.gpu.length ? pt.gpu[0] : null
      for (const run of runsNow) {
        const st = run.sampleStats || (run.sampleStats = { utilSum: 0, utilN: 0, utilMax: 0, memPeakMiB: 0 })
        if (g0 && typeof g0.utilPct === 'number') {
          st.utilSum += g0.utilPct
          st.utilN += 1
          if (g0.utilPct > st.utilMax) st.utilMax = g0.utilPct
        }
        if (g0 && typeof g0.memUsedMiB === 'number' && g0.memUsedMiB > st.memPeakMiB) st.memPeakMiB = g0.memUsedMiB
      }
      // ps 周期（5s）：状态机 tick + 进程组聚合 + track 规则自动登记
      if (Date.now() - backendState.psAt >= PS_INTERVAL_MS) {
        backendState.psAt = Date.now()
        const psOut = await backendState.runner.exec('ps -eo pid=,ppid=,pcpu=,rss=,args= --no-headers 2>/dev/null')
        const procs = parsePs(psOut)
        adoptTrackedProcs(procs)
        machine.tick(procs)
        const curRun = machine.cur()
        const aggProcs: ProcSample[] = procs.map((p) => ({
          pid: p.pid,
          cmd: p.cmd ?? null,
          ppid: p.ppid ?? null,
          cpuPct: typeof p.cpuPct === 'number' ? p.cpuPct : null,
          memMiB: typeof p.memMiB === 'number' ? p.memMiB : null,
        }))
        const agg = aggregateProcStats({ procs: aggProcs, group: curRun ? curRun.procGroup : null, runActive: !!curRun })
        lastGroupStats = agg.group
        lastSystemStats = agg.system
        pt.group = agg.group
        pt.system = agg.system
        pt.experimentActive = !!curRun
        pt.experimentType = curRun ? (curRun.type ?? null) : null
        for (const r of machine.all()) {
          if (!r.procGroup || !r.procGroup.size || r.runId === (curRun ? curRun.runId : null)) continue
          const gAgg = aggregateProcStats({ procs: aggProcs, group: r.procGroup, runActive: true })
          if (gAgg.group) r.groupStats = gAgg.group
          if (r.resultSeen) machine.tickGrace(r)
        }
        if (curRun) {
          const st = curRun.sampleStats || (curRun.sampleStats = { utilSum: 0, utilN: 0, utilMax: 0, memPeakMiB: 0 })
          if (agg.group && typeof agg.group.memMiB === 'number' && agg.group.memMiB > (st.groupMemPeakMiB ?? 0)) st.groupMemPeakMiB = agg.group.memMiB
          if (agg.group && typeof agg.group.cpuPct === 'number' && agg.group.cpuPct > (st.groupCpuMax ?? 0)) st.groupCpuMax = agg.group.cpuPct
          if (agg.system && typeof agg.system.memMiB === 'number' && agg.system.memMiB > (st.otherMemPeakMiB ?? 0)) st.otherMemPeakMiB = agg.system.memMiB
        }
        for (const r of machine.all()) {
          if (r.resultSeen) machine.tickGrace(r)
        }
      }
      if (recentWindow.length) {
        const wLast = recentWindow[recentWindow.length - 1]
        wLast.group = lastGroupStats
        wLast.system = lastSystemStats
        wLast.experimentActive = !!machine.cur()
      }
      const mainRun = machine.cur()
      balancer.evaluate(recentWindow, mainRun ? mainRun.runId : null)
    } catch (e) {
      log('error', '采样 tick 错误', { error: e instanceof Error ? e.message : String(e) })
    } finally {
      tickBusy = false
    }
  }

  /** track 规则命中 → 自动登记。满员不 start（否则挤掉最旧 running）；同 (rule, normCmd) 60s 冷却。 */
  const adoptCooldown = new Map<string, number>()
  function adoptTrackedProcs(procs: ReturnType<typeof parsePs>): void {
    if (!cfg.trackRules.length) return
    const now = Date.now()
    for (const p of procs) {
      if (!p.cmd) continue
      const hit = cfg.trackRules.find((r) => trackRuleMatches(r, p.cmd))
      if (!hit) continue
      const norm = normalizeCmdForMatch(p.cmd)
      const key = hit.id + '\0' + norm
      const dupRunning = machine.all().some((r) => r.cmd && normalizeCmdForMatch(r.cmd) === norm)
      if (dupRunning) continue
      const decision = decideAdoption({
        runningCount: machine.all().length,
        maxParallel: MAX_PARALLEL_RUNS,
        lastAdoptAt: adoptCooldown.get(key) ?? null,
        now,
      })
      if (decision !== 'adopt') continue
      adoptCooldown.set(key, now)
      machine.start(p.cmd, 'explicit:' + hit.label, { agentId: null }, { explicit: true, deviceId: backendState.currentDevice })
      log('info', 'track 规则自动登记实验', { rule: hit.label, pid: p.pid })
    }
  }

  // ── 设备切换 / 后端启动 ────────────────────────────────────────────────
  async function switchDevice(targetDeviceId: string): Promise<{ ok: boolean; device: string; platform?: string; error?: string }> {
    let devConfig: DaemonConfig['devices'][number] | null = null
    if (targetDeviceId !== 'local') {
      devConfig = cfg.devices.find((d) => d.id === targetDeviceId) || null
      if (!devConfig) return { ok: false, device: cfg.currentDevice, error: '未找到设备配置: ' + targetDeviceId }
    }
    machine.switchAwayAll('switched_away')
    try {
      if (backendState.backend) await backendState.backend.close()
      if (backendState.sshRunner) {
        await backendState.sshRunner.close()
        backendState.sshRunner = null
      }
    } catch { /* 关闭失败继续切换 */ }
    backendState.lastSnap = null
    backendState.psAt = 0
    lastGroupStats = null
    lastSystemStats = null
    recentWindow.length = 0
    if (targetDeviceId === 'local' || !devConfig) {
      backendState.runner = deps.runner
      backendState.currentDevice = 'local'
      try {
        const res = await createBackend(deps.runner, cfg.backendMode as BackendMode)
        backendState.backend = res.backend
        backendState.platform = res.platform
        cfg.currentDevice = 'local'
        deps.persist()
        return { ok: true, device: 'local', platform: res.platform }
      } catch (e) {
        return { ok: false, device: 'local', error: e instanceof Error ? e.message : String(e) }
      }
    }
    const ssh = new SshRunner(devConfig, deps.runner)
    const remoteBackend = new LinuxBackend(ssh)
    const probe = await remoteBackend.probe()
    if (!probe.ok) log('warn', '远程设备 probe 失败', { device: targetDeviceId, reason: probe.reason })
    backendState.sshRunner = ssh
    backendState.runner = ssh
    backendState.backend = remoteBackend
    backendState.platform = 'linux'
    backendState.currentDevice = targetDeviceId
    cfg.currentDevice = targetDeviceId
    deps.persist()
    return { ok: true, device: targetDeviceId, platform: 'linux' }
  }

  let streamTask: Promise<void> | null = null
  async function startBackend(): Promise<void> {
    try {
      if (cfg.currentDevice && cfg.currentDevice !== 'local') {
        const sw = await switchDevice(cfg.currentDevice)
        if (sw.ok) return
        log('warn', '启动时切换到配置设备失败，回退本地', { error: sw.error })
      }
      backendState.runner = deps.runner
      backendState.currentDevice = 'local'
      const res = await createBackend(deps.runner, cfg.backendMode as BackendMode)
      backendState.backend = res.backend
      backendState.platform = res.platform
      const probe = await probeBackend(res.backend)
      log('info', '采样后端就绪', { platform: res.platform, probe: JSON.stringify(probe && probe.detail ? probe.detail : probe) })
      if (typeof res.backend.stream === 'function') {
        streamTask = (async () => {
          try {
            const stream = res.backend.stream()
            if (!stream) return
            const it = stream[Symbol.asyncIterator]()
            while (!backendState.stopped) {
              const n = await it.next()
              if (n.done) break
            }
          } catch (e) {
            log('warn', 'dmon 流退出', { error: e instanceof Error ? e.message : String(e) })
          }
        })()
      }
    } catch (e) {
      log('error', '采样后端初始化失败（降级为只读空快照）', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ── 快照 ───────────────────────────────────────────────────────────────
  function buildSnapshot(): MonitorSnapshot {
    callCount += 1
    const base = backendState.lastSnap || {
      ts: Date.now(),
      platform: 'linux',
      sources: { cpu: 'procfs', mem: 'procfs', procs: 'ps' },
      cpu: { percent: null, cores: null },
      mem: { totalMiB: null, availableMiB: null },
      procs: [],
    }
    const gpu = base.gpu || []
    const gpuState = gpu.length ? 'ok' : (base.sources && base.sources.gpu === 'unavailable' ? 'unavailable' : 'ok')
    const expView = machine.snapshot()
    const exp = expView.main
    const exps = expView.all
    if (exp) exp.groupStats = exp.groupStats || lastGroupStats
    for (const e of exps) {
      if (!e.groupStats) e.groupStats = lastGroupStats
    }
    const watchList = watchSet()
    const watchedPids: number[] = []
    const baseProcsFull = Array.isArray(base.procs) ? base.procs : []
    if (watchList.length) {
      for (const p of baseProcsFull) {
        const cmd = p.cmd || ''
        if (watchList.some((w) => cmd.toLowerCase().includes(w.toLowerCase()))) watchedPids.push(p.pid)
      }
    }
    const watchPidSet = new Set(watchedPids)
    const watchedFirst = baseProcsFull.filter((p) => watchPidSet.has(p.pid))
    const others = baseProcsFull.filter((p) => !watchPidSet.has(p.pid))
    const topN = thresholds.get().procTopN
    const procsAll = [...prioritizeGpuProcs(watchedFirst, watchedFirst.length), ...prioritizeGpuProcs(others, baseProcsFull.length)].slice(0, Math.max(topN, watchedFirst.length))
    const tagGroups: TagGroup[] = []
    if (cfg.tags.length && baseProcsFull.length) {
      for (const rule of cfg.tags) {
        const pids: number[] = []
        const members: SamplePoint['procs'] = []
        let gpuSum = 0, gpuN = 0, cpuSum = 0, cpuN = 0, memSum = 0, memN = 0
        for (const p of baseProcsFull) {
          if (!p.cmd || !tagMatches(rule, p.cmd)) continue
          pids.push(p.pid)
          members.push(p)
          if (typeof p.gpuUtilPct === 'number') { gpuSum += p.gpuUtilPct; gpuN++ }
          if (typeof p.cpuPct === 'number') { cpuSum += p.cpuPct; cpuN++ }
          if (typeof p.memMiB === 'number') { memSum += p.memMiB; memN++ }
        }
        if (!pids.length) continue
        const tg: TagGroup = {
          rule,
          pids,
          procs: members.map((m) => ({ pid: m.pid, cmd: m.cmd, cpuPct: m.cpuPct ?? null, memMiB: m.memMiB ?? null, ppid: m.ppid ?? null, gpuUtilPct: m.gpuUtilPct ?? null })),
          gpuUtilPct: gpuN ? Math.round(gpuSum / gpuN) : null,
          cpuPct: cpuN ? Math.round(cpuSum / cpuN) : null,
          memMiB: memN ? Math.round(memSum / memN) : null,
        }
        if (rule.kind === 'experiment') {
          const runIds = exps.filter((e) => e.cmd && tagMatches(rule, e.cmd)).map((e) => e.runId)
          if (runIds.length) tg.runIds = runIds
        }
        tagGroups.push(tg)
      }
    }
    const snap: MonitorSnapshot = {
      ts: Date.now(),
      platform: base.platform || 'linux',
      sources: {
        gpu: (base.sources && base.sources.gpu) || (gpu.length ? 'query' : 'unavailable'),
        cpu: (base.sources && base.sources.cpu) || 'procfs',
        mem: (base.sources && base.sources.mem) || 'procfs',
        procs: (base.sources && base.sources.procs) || 'ps',
      },
      gpu: gpu.map((g) => g),
      gpuState,
      cpu: base.cpu ? { percent: base.cpu.percent, cores: base.cpu.cores !== undefined ? base.cpu.cores : null } : { percent: null, cores: null },
      mem: base.mem ? { totalMiB: base.mem.totalMiB, availableMiB: base.mem.availableMiB } : { totalMiB: null, availableMiB: null },
      procs: procsAll,
      system: lastSystemStats,
      watchedPids,
      watchProcs: watchSet(),
      tags: tagGroups,
      alerts: balancer.snapshotAlerts(),
      alertsCriticalCount: balancer.count(),
      experiment: exp,
      experiments: exps,
      ended: expView.ended,
      thresholds: thresholds.get(),
      thresholdOverrides: thresholds.getOverrides(),
      backendMode: cfg.backendMode,
      currentDevice: backendState.currentDevice || 'local',
      devices: cfg.devices.map((d) => ({ id: d.id, label: d.label, host: d.host })),
      enabled,
      notify: {
        alertNotify: cfg.alertNotify,
        alertTargets: cfg.alertTargets,
        notifyThrottleMs: cfg.notifyThrottleMs,
        escalateAfterSec: cfg.escalateAfterSec,
        notifyTimeoutMs: cfg.notifyTimeoutMs,
        broadcast: cfg.broadcast,
        agentsAvailable: false,
        notifiedFingerprints: 0,
      },
      callCount,
      ui: { betterSidebarVisible: true },
      swanlab: {
        enabled: cfg.sinks.some((s) => s.id === 'swanlab' && s.enabled),
        apiKeyConfigured: false,
        triggerMode: 'manual',
      },
    }
    if (deps.sinks) {
      const sh = deps.sinks.health()
      if (sh.length) Object.assign(snap, { sinks: sh })
    }
    if (base.degraded) snap.degraded = base.degraded
    return sanitizeJson(snap) as MonitorSnapshot
  }

  // ── API 语义（HTTP 与 MCP 共用）────────────────────────────────────────
  function rpcSnapshot(args?: { thresholds?: Record<string, number> }): MonitorSnapshot {
    if (args && args.thresholds) thresholds.apply(args.thresholds as never, false)
    return buildSnapshot()
  }
  function rpcHistory(args?: { sinceMs?: number; bucketMs?: number }) {
    const a = args || {}
    const sinceMs = typeof a.sinceMs === 'number' ? a.sinceMs : Date.now() - RING_MAX_MS
    const bucketMs = typeof a.bucketMs === 'number' ? a.bucketMs : 10000
    return ring.history(sinceMs, bucketMs)
  }
  function rpcSetThresholds(args?: Record<string, unknown>) {
    const a = args || {}
    const applied: Record<string, number> = {}
    const keys = Object.keys(THRESHOLD_DEFAULTS)
    for (const k of keys) {
      const v = a[k]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      let n = v
      if (k === 'procTopN') n = Math.max(5, Math.min(1000, Math.round(n)))
      else if (k === 'wGpu' || k === 'wCpu' || k === 'wMem') n = Math.max(0, Math.min(20, n))
      applied[k] = n
    }
    thresholds.apply(applied as never, true)
    cfg.thresholds = { ...thresholds.get() }
    deps.persist()
    return { ok: true, applied: thresholds.get() }
  }
  function rpcControl(args?: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> {
    const action = args && typeof args.action === 'string' ? args.action : undefined
    if (action === 'switch-device' || action === 'device') {
      const target = String((args && (args.target as string)) || (args && (args.device as string)) || 'local')
      return switchDevice(target).then((res) => ({ state: 'device-switched', ...res }))
    }
    if (action === 'start') { enabled = true; emitLab('lab/status-flip', { enabled: true }) }
    else if (action === 'pause') { enabled = false; emitLab('lab/status-flip', { enabled: false }) }
    else if (action === 'resume') { enabled = true; emitLab('lab/status-flip', { enabled: true }) }
    else if (action === 'set-threshold') {
      return Promise.resolve(rpcSetThresholds(args && typeof args.thresholds === 'object' && args.thresholds ? args.thresholds as Record<string, unknown> : {})).then((r) => ({ ...r, state: 'thresholds-applied' }))
    } else if (action === 'clear-alerts') {
      const cleared = balancer.clear({ runId: args && typeof args.runId === 'string' ? args.runId : null, rule: args && typeof args.rule === 'string' ? args.rule : null })
      return { ok: true, state: 'alerts-cleared', ...cleared }
    } else if (action === 'set-notify') {
      const patch = args || {}
      if (patch.alertNotify === 'off' || patch.alertNotify === 'notice' || patch.alertNotify === 'wake') cfg.alertNotify = patch.alertNotify
      if (typeof patch.escalateAfterSec === 'number' && patch.escalateAfterSec >= 0) cfg.escalateAfterSec = patch.escalateAfterSec
      if (typeof patch.notifyThrottleMs === 'number' && patch.notifyThrottleMs > 0) cfg.notifyThrottleMs = patch.notifyThrottleMs
      deps.persist()
      return { ok: true, state: 'notify-updated', config: { alertNotify: cfg.alertNotify, escalateAfterSec: cfg.escalateAfterSec, notifyThrottleMs: cfg.notifyThrottleMs } }
    } else return { ok: false, error: '未知 action: ' + action }
    return { ok: true, state: enabled ? 'running' : 'paused' }
  }
  function rpcAdvice() {
    return balancer.advice()
  }
  function rpcWatch(a: Record<string, unknown>) {
    const op = a.op === undefined || a.op === null ? 'list' : String(a.op)
    if (op === 'list') return { ok: true, watchProcs: watchSet() }
    if (op === 'add') {
      const kw = typeof a.keyword === 'string' && a.keyword.trim() ? a.keyword.trim() : null
      if (!kw) return { ok: false, error: 'watch add 需要 keyword' }
      runtimeWatch.add(kw)
      return { ok: true, state: 'watch-added', keyword: kw, watchProcs: watchSet() }
    }
    if (op === 'remove') {
      const kw = typeof a.keyword === 'string' ? a.keyword : null
      if (!kw) return { ok: false, error: 'watch remove 需要 keyword' }
      runtimeWatch.delete(kw)
      cfg.watchProcs = cfg.watchProcs.filter((w) => w !== kw)
      deps.persist()
      return { ok: true, state: 'watch-removed', keyword: kw, watchProcs: watchSet() }
    }
    return { ok: false, error: '未知 watch 操作: ' + op }
  }
  function rpcTag(a: Record<string, unknown>) {
    const op = a.op === undefined || a.op === null ? 'list' : String(a.op)
    if (op === 'list') return { ok: true, tags: cfg.tags, matches: buildSnapshot().tags || [] }
    if (op === 'add') {
      const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim() : null
      if (!label) return { ok: false, error: 'tag add 需要 label' }
      const kind = a.kind === 'experiment' ? 'experiment' : 'process'
      const color = typeof a.color === 'string' && a.color.trim() ? a.color.trim() : undefined
      const patterns = Array.isArray(a.patterns) ? a.patterns.filter((p): p is string => typeof p === 'string' && p.trim().length > 0) : []
      if (!patterns.length) return { ok: false, error: 'tag add 需要 patterns（cmdline 正则，如 "python.*train"）' }
      const rule: TagRule = { id: makeTagId(), label, patterns, kind, color }
      cfg.tags.push(rule)
      deps.persist()
      const tg = (buildSnapshot().tags || []).find((t) => t.rule.id === rule.id)
      return { ok: true, state: 'tag-added', rule, matchedPids: tg ? tg.pids : [] }
    }
    if (op === 'remove') {
      const id = typeof a.id === 'string' && a.id ? a.id : null
      if (!id) return { ok: false, error: 'tag remove 需要 id' }
      const idx = cfg.tags.findIndex((t) => t.id === id)
      if (idx === -1) return { ok: true, state: 'tag-not-found', id }
      cfg.tags.splice(idx, 1)
      deps.persist()
      return { ok: true, state: 'tag-removed', id }
    }
    return { ok: false, error: '未知 tag 操作: ' + op }
  }
  function rpcTrack(a: Record<string, unknown>) {
    const op = a.op === undefined || a.op === null ? 'list' : String(a.op)
    if (op === 'list') {
      const procsAll = backendState.lastSnap && Array.isArray(backendState.lastSnap.procs) ? backendState.lastSnap.procs : []
      const matched = procsAll.filter((p) => p.cmd && cfg.trackRules.some((r) => trackRuleMatches(r, p.cmd))).map((p) => ({ pid: p.pid, cmd: p.cmd }))
      return { ok: true, rules: cfg.trackRules, matchedProcs: matched }
    }
    if (op === 'add') {
      const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim() : null
      if (!label) return { ok: false, error: 'track add 需要 label' }
      const color = typeof a.color === 'string' && a.color.trim() ? a.color.trim() : undefined
      const patterns = Array.isArray(a.patterns) ? a.patterns.filter((p): p is string => typeof p === 'string' && p.trim().length > 0) : []
      if (!patterns.length) return { ok: false, error: 'track add 需要 patterns（cmdline 正则，如 "python.*infer"）' }
      const rule: TrackRule = { id: makeTagId(), label, patterns, color }
      cfg.trackRules.push(rule)
      deps.persist()
      return { ok: true, state: 'track-added', rule }
    }
    if (op === 'remove') {
      const id = typeof a.id === 'string' && a.id ? a.id : null
      if (!id) return { ok: false, error: 'track remove 需要 id' }
      const idx = cfg.trackRules.findIndex((t) => t.id === id)
      if (idx === -1) return { ok: true, state: 'track-not-found', id }
      cfg.trackRules.splice(idx, 1)
      deps.persist()
      return { ok: true, state: 'track-removed', id }
    }
    return { ok: false, error: '未知 track 操作: ' + op }
  }
  function rpcHistoryManage(args: Record<string, unknown>) {
    const op = typeof args.op === 'string' ? args.op : 'list'
    if (op === 'delete') {
      const runId = typeof args.runId === 'string' && args.runId ? args.runId : ''
      if (!runId) return { ok: false, state: 'missing-runId', remaining: machine.history.length }
      if (!machine.removeRun(runId)) return { ok: false, state: 'not-found', remaining: machine.history.length }
      cfg.history = machine.history.map((r) => r as never as EndedRunSnapshot).slice(0, HISTORY_MAX)
      deps.persist()
      return { ok: true, state: 'deleted', removed: [runId], remaining: machine.history.length }
    }
    if (op === 'clear') {
      const keep = typeof args.keep === 'number' && Number.isFinite(args.keep) ? Math.max(0, Math.round(args.keep)) : 0
      const removed = machine.clearHistory(keep)
      cfg.history = machine.history.map((r) => r as never as EndedRunSnapshot).slice(0, HISTORY_MAX)
      deps.persist()
      return { ok: true, state: 'cleared', removed: removed.map((r) => r.runId), remaining: machine.history.length }
    }
    return { ok: true, state: 'list', remaining: machine.history.length }
  }

  /** 单段方法语义表（lab-protocol 路由 = 单段 method 提取） */
  function dispatch(method: string, body: unknown): unknown | Promise<unknown> {
    const a = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
    switch (method) {
      case 'snapshot': return rpcSnapshot(a as { thresholds?: Record<string, number> })
      case 'history': return rpcHistory(a as { sinceMs?: number; bucketMs?: number })
      case 'advice': return rpcAdvice()
      case 'control': return rpcControl(a)
      case 'setThresholds': return rpcSetThresholds(a)
      case 'track': return rpcTrack(a)
      case 'watch': return rpcWatch(a)
      case 'tag': return rpcTag(a)
      case 'historyManage': return rpcHistoryManage(a)
      default: return { ok: false, error: '未知方法: ' + method }
    }
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────
  function start(): void {
    startedAt = Date.now()
    backendState.stopped = false
    void startBackend()
    const sampleMs = cfg.sampleMs > 200 ? cfg.sampleMs : 500
    timer = setInterval(() => { void sampleTick() }, sampleMs)
    timer.unref?.()
  }

  function stop(): void {
    backendState.stopped = true
    if (timer) { clearInterval(timer); timer = null }
    if (streamTask) {
      const st = streamTask as Promise<void> & { return?: () => unknown }
      try { if (typeof st.return === 'function') st.return() } catch { /* 已结束 */ }
      streamTask = null
    }
    const closeAll = (async () => {
      if (backendState.sshRunner) {
        try { await backendState.sshRunner.close() } catch { /* 幂等关闭 */ }
        backendState.sshRunner = null
      }
      if (backendState.backend) {
        try { await backendState.backend.close() } catch (e) { log('warn', 'close 出错', { error: e instanceof Error ? e.message : String(e) }) }
        backendState.backend = null
      }
    })()
    return void closeAll
  }

  // metrics-forward 窗口定时器
  let windowTimer: ReturnType<typeof setInterval> | null = null
  function startWindowLoop(): void {
    const fwd = cfg.sinks.find((s) => s.kind === 'metrics-forward' && s.enabled)
    const windowMs = fwd && typeof fwd.windowMs === 'number' && fwd.windowMs > 1000 ? fwd.windowMs : 30000
    windowTimer = setInterval(() => {
      if (!deps.sinks) return
      const now = Date.now()
      const pts = ring.history(now - windowMs, 1).points
      const w: MetricsWindow = {
        startTs: now - windowMs,
        endTs: now,
        windowMs,
        points: pts.map((p) => ({ ts: p.ts, gpuUtil: p.gpuUtil, gpuMem: p.gpuMem, cpu: p.cpu, memUsed: p.memUsed })),
        latest: buildSnapshot() as unknown as Record<string, unknown>,
      }
      deps.sinks.dispatchWindow(w)
    }, windowMs)
    windowTimer.unref?.()
  }

  return {
    start,
    stop,
    startWindowLoop,
    stopWindowLoop(): void {
      if (windowTimer) { clearInterval(windowTimer); windowTimer = null }
    },
    sampleTick,
    tickOnce: sampleTick,
    buildSnapshot,
    dispatch,
    switchDevice,
    subscribe(l: EngineListener): () => void {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    isEnabled(): boolean {
      return enabled
    },
    currentDevice(): string {
      return backendState.currentDevice || 'local'
    },
    startedAtMs(): number {
      return startedAt
    },
  }
}

export type Engine = ReturnType<typeof createEngine>
