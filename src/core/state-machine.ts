/**
 * state-machine（实验生命周期：idle/running/done/crashed/alerting/aborted）—— §4
 * 迁移自 host/index.js §4，逻辑等价（含 v1.4.3 / v1.4.5 会话内验收实证修正）
 */
import { CRASH_PS_GAP, DONE_GRACE_TICKS, RING_MAX_MS, cmdFingerprint, makeRunId, normalizeCmdForMatch } from './constants.js'
import type { Ring } from './ring.js'
import type { Alert, ExperimentSnapshot, RunRecord } from './types.js'

interface PsProc {
  pid: number
  cmd: string
}

interface StateMachineDeps {
  ring?: Ring
  emitLab(type: string, data: Record<string, unknown>): void
  emitAlert(alert: Omit<Alert, 'ts' | 'runId'> & { runId?: string | null }, runId?: string | null): void
}

export interface StateMachine {
  start(cmdStr: string, feature: string): RunRecord
  associatePid(pid: number): void
  markResult(paired: boolean): void
  tick(aliveProcs: PsProc[]): void
  tickGrace(run: RunRecord): void
  setAlerting(on: boolean): void
  snapshot(): ExperimentSnapshot | null
  cur(): RunRecord | null
  history: RunRecord[]
}

/** ps 行解析（Linux/WSL 实验进程视角；与采样 procs 通道解耦） */
export function parsePs(out: { code: number; stdout: string } | null): PsProc[] {
  const procs: PsProc[] = []
  if (!out || out.code !== 0 || !out.stdout) return procs
  const lines = out.stdout.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const mm = line.match(/^(\d+)\s+(\S.*)$/)
    if (mm) procs.push({ pid: parseInt(mm[1], 10), cmd: mm[2] })
  }
  return procs
}

/** 候选进程存活检测（归一化对比；pyc: 前缀仅标记形态，匹配时剥离） */
export function findAliveProc(run: RunRecord, procs: PsProc[]): PsProc | null {
  if (!procs || !procs.length) return null
  const fp = run.fingerprint
  for (let i = 0; i < procs.length; i++) {
    const p = procs[i]
    if (run.pid && p.pid === run.pid) return p
    if (p.cmd && fp) {
      const c = normalizeCmdForMatch(p.cmd)
      const mfp = fp.indexOf('pyc:') === 0 ? fp.slice(4) : fp
      if (c.indexOf(mfp) !== -1) return p
    }
  }
  return null
}

export function createStateMachine(deps: StateMachineDeps): StateMachine {
  const state: {
    cur: RunRecord | null
    history: RunRecord[]
    pidMissingStreak: number
  } = {
    cur: null,
    history: [],
    pidMissingStreak: 0,
  }

  function cur(): RunRecord | null {
    return state.cur && state.cur.state === 'running' ? state.cur : null
  }

  function buildSummary(run: RunRecord): RunRecord['summary'] {
    const s = run.sampleStats
    return {
      gpuUtilMax: s && s.utilMax,
      gpuUtilAvg: s && s.utilN ? Math.round(s.utilSum / s.utilN) : null,
      memPeak: s && s.memPeakMiB,
      durationSec: Math.max(0, Math.round(((run.endTs || Date.now()) - run.startTs) / 1000)),
      dataPartial: !!(deps.ring && deps.ring.size() >= 1 && ((run.endTs || Date.now()) - run.startTs) > RING_MAX_MS),
    }
  }

  function archive(run: RunRecord, endReason: string): void {
    run.endTs = Date.now()
    run.endReason = endReason
    run.state = endReason === 'aborted' ? 'aborted' : endReason === 'done' ? 'done' : 'crashed'
    run.summary = run.summary || buildSummary(run)
    state.history.unshift(run)
    if (state.history.length > 20) state.history.length = 20
    if (state.cur === run) state.cur = null
    state.pidMissingStreak = 0
  }

  function conclude(run: RunRecord, reason: 'done' | 'crashed'): void {
    if (!run || run.state !== 'running') return
    if (reason === 'done') {
      archive(run, 'done')
    } else if (reason === 'crashed') {
      archive(run, 'crashed')
      deps.emitAlert(
        {
          level: 'critical',
          rule: 'experiment-crash',
          msg: '实验进程意外退出，无配对 result（可能被 kill 或崩溃）',
          confidence: 0.9,
          actions: ['检查日志/最近 kill 操作'],
        },
        run.runId,
      )
    }
  }

  // ① start：pre-execute 命中训练命令（只记 runId/cmd 特征/startTs，无 pid，T1-1）
  function start(cmdStr: string, feature: string): RunRecord {
    const existing = cur()
    if (existing) archive(existing, 'aborted') // R-2：running 中新 start → 旧 run 归档 aborted
    const run: RunRecord = {
      runId: makeRunId(),
      cmd: cmdStr,
      cmdFeature: feature,
      pid: null,
      startTs: Date.now(),
      endTs: null,
      state: 'running',
      endReason: null,
      resultSeen: false,
      fingerprint: cmdFingerprint(cmdStr),
      graceTicks: 0,
      alerting: false,
      sampleStats: null,
    }
    state.cur = run
    state.pidMissingStreak = 0
    if (deps.ring) deps.ring.expand() // R-3：running 期扩容
    deps.emitLab('lab/experiment-start', { runId: run.runId, cmd: cmdStr, cmdFeature: feature, startTs: run.startTs })
    return run
  }

  // ② pid 关联（ps 回填）
  function associatePid(pid: number): void {
    const run = cur()
    if (run && pid) {
      run.pid = pid
      state.pidMissingStreak = 0
    }
  }

  // ③ done / crashed（T1-2 配对 + 双确认；kill 自身 result 不配对 → 忽略）
  function markResult(paired: boolean): void {
    const run = cur()
    if (!run) return
    if (!paired) return // 不匹配的 result 忽略（ls/curl/kill 等）
    run.resultSeen = true
    if (run.procGone) conclude(run, 'done')
  }

  // ps tick：候选进程存活检测 + crashed/done 双确认
  function tick(aliveProcs: PsProc[]): void {
    const run = cur()
    if (!run) {
      state.pidMissingStreak = 0
      return
    }
    const alive = findAliveProc(run, aliveProcs)
    if (alive) {
      if (!run.pid) run.pid = alive.pid
      state.pidMissingStreak = 0
      run.procGone = false
      run.graceTicks = 0
      return
    }
    run.procGone = true
    if (run.resultSeen) {
      conclude(run, 'done') // done 双确认 2/2：配对 result + 进程消失
      return
    }
    state.pidMissingStreak += 1
    if (state.pidMissingStreak >= CRASH_PS_GAP) conclude(run, 'crashed') // pid 消失 ≥2 ps 周期
  }

  // 配对 result 后进程仍活 → 宽限 2 个 ps 周期后再判 done（异常残留）
  function tickGrace(run: RunRecord): void {
    if (!run || run.state !== 'running' || !run.resultSeen) return
    run.graceTicks += 1
    if (run.graceTicks >= DONE_GRACE_TICKS) conclude(run, 'done')
  }

  // 平衡引擎 critical 置位（alerting 状态语义）
  function setAlerting(on: boolean): void {
    const run = cur()
    if (run) run.alerting = on
  }

  function snapshot(): ExperimentSnapshot | null {
    const run = state.cur && state.cur.state === 'running' ? state.cur : null
    if (!run) return null
    return {
      runId: run.runId,
      state: run.alerting ? 'alerting' : 'running',
      cmd: run.cmd,
      cmdFeature: run.cmdFeature,
      pid: run.pid,
      startTs: run.startTs,
      summary: null,
      endReason: null,
    }
  }

  return { start, associatePid, markResult, tick, tickGrace, setAlerting, snapshot, cur, history: state.history }
}
