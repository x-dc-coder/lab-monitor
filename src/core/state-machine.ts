/**
 * state-machine（实验生命周期：idle/running/done/crashed/alerting/aborted）—— §4
 * 迁移自 host/index.js §4，逻辑等价（含 v1.4.3 / v1.4.5 会话内验收实证修正）
 */
import { CRASH_PS_GAP, DONE_GRACE_TICKS, MAX_HISTORY, MAX_PARALLEL_RUNS, RING_MAX_MS, cmdFingerprint, makeRunId, normalizeCmdForMatch } from './constants.js'
import { classifyExpType, type ExpTypeRule } from './exp-type.js'
import type { Ring } from './ring.js'
import type { Alert, EndedRunSnapshot, ExperimentSnapshot, ExpType, RunRecord } from './types.js'

interface PsProc {
  pid: number
  cmd: string
  ppid?: number | null
  /** 1.2：Linux ps pcpu 列（Windows 侧无）——G 聚合主判据输入 */
  cpuPct?: number | null
  /** 1.2：Linux ps rss 列 → MiB（Windows 侧无）——G 聚合主判据输入 */
  memMiB?: number | null
}

interface StateMachineDeps {
  ring?: Ring
  emitLab(type: string, data: Record<string, unknown>): void
  emitAlert(alert: Omit<Alert, 'ts' | 'runId'> & { runId?: string | null }, runId?: string | null): void
  /** M2（issue#6）：实验类型识别配置（getter——start 时取最新 settings 值，避免创建时快照） */
  expType?: () => { rules?: ExpTypeRule[]; learning?: boolean; defaultType?: ExpType }
}

export interface StateMachine {
  start(cmdStr: string, feature: string, agent?: { agentId?: string | null; agentRole?: 'root' | 'subagent'; parentId?: string | null }): RunRecord
  associatePid(pid: number): void
  associateProc(pid: number): void
  markResult(paired: boolean, runId?: string | null): void
  tick(aliveProcs: PsProc[]): void
  tickGrace(run: RunRecord): void
  setAlerting(on: boolean, runId?: string | null): void
  snapshot(): { main: ExperimentSnapshot | null; all: ExperimentSnapshot[]; ended: EndedRunSnapshot[] }
  restoreEnded(snapshots: EndedRunSnapshot[]): void
  /** 2026-08-24（#10 实验历史管理）：按 runId 删除单条已结束记录 */
  removeRun(runId: string): boolean
  /** 2026-08-24（#10 实验历史管理）：清空已结束记录，保留最近 N 条（默认 0），返回被移除的 */
  clearHistory(keep?: number): RunRecord[]
  cur(): RunRecord | null
  all(): RunRecord[]
  history: RunRecord[]
}

/** ps 行解析（Linux/WSL 实验进程视角；与采样 procs 通道解耦）
 * 1.2：5 列（pid ppid pcpu rss args，rss KiB→MiB）；兼容 3 列（pid ppid args）、2 列（pid args） */
export function parsePs(out: { code: number; stdout: string } | null): PsProc[] {
  const procs: PsProc[] = []
  if (!out || out.code !== 0 || !out.stdout) return procs
  const lines = out.stdout.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const m5 = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S.*)$/)
    if (m5) {
      procs.push({
        pid: parseInt(m5[1], 10),
        ppid: parseInt(m5[2], 10),
        cpuPct: parseFloat(m5[3]),
        memMiB: Math.round(parseInt(m5[4], 10) / 1024),
        cmd: m5[5],
      })
      continue
    }
    const m3 = line.match(/^(\d+)\s+(\d+)\s+(\S.*)$/)
    if (m3) {
      procs.push({ pid: parseInt(m3[1], 10), ppid: parseInt(m3[2], 10), cmd: m3[3] })
      continue
    }
    const m2 = line.match(/^(\d+)\s+(\S.*)$/)
    if (m2) procs.push({ pid: parseInt(m2[1], 10), cmd: m2[2] })
  }
  return procs
}

/** 候选进程存活检测（归一化对比；pyc: 前缀仅标记形态，匹配时剥离；僵尸进程不算存活） */
export function findAliveProc(run: RunRecord, procs: PsProc[]): PsProc | null {
  if (!procs || !procs.length) return null
  const fp = run.fingerprint
  for (let i = 0; i < procs.length; i++) {
    const p = procs[i]
    if (p.cmd && p.cmd.indexOf('<defunct>') !== -1) continue // R3：僵尸进程不算存活（防 pid 漂移）
    if (run.pid && p.pid === run.pid) return p
    if (p.cmd && fp) {
      const c = normalizeCmdForMatch(p.cmd)
      const mfp = fp.indexOf('pyc:') === 0 ? fp.slice(4) : fp
      if (c.indexOf(mfp) !== -1) return p
    }
  }
  return null
}

/** 成员与 run 指纹是否匹配（R3：pid 复用防护——同 pid 但 cmd 不符 → 剔除；僵尸进程不算存活） */
function memberMatches(run: RunRecord, p: PsProc): boolean {
  if (p.cmd && p.cmd.indexOf('<defunct>') !== -1) return false
  if (run.pid && p.pid === run.pid) return true
  if (!p.cmd || !run.fingerprint) return false
  const c = normalizeCmdForMatch(p.cmd)
  const mfp = run.fingerprint.indexOf('pyc:') === 0 ? run.fingerprint.slice(4) : run.fingerprint
  return c.indexOf(mfp) !== -1
}

export function createStateMachine(deps: StateMachineDeps): StateMachine {
  const state: {
    /** 2026-08-20（A2 多轨）：全部 running run（Map 保持 start 顺序）；cur() 语义保留 = 最近 start 的 running */
    runs: Map<string, RunRecord>
    history: RunRecord[]
  } = {
    runs: new Map(),
    history: [],
  }

  function cur(): RunRecord | null {
    // 主实验 = 最近 start 的 running run（向后兼容 experimentActive 语义）
    let latest: RunRecord | null = null
    for (const run of state.runs.values()) {
      if (run.state === 'running' && (!latest || run.startTs >= latest.startTs)) latest = run
    }
    return latest
  }

  function all(): RunRecord[] {
    const out: RunRecord[] = []
    for (const run of state.runs.values()) {
      if (run.state === 'running') out.push(run)
    }
    return out
  }

  function buildSummary(run: RunRecord): RunRecord['summary'] {
    const s = run.sampleStats
    return {
      gpuUtilMax: s && s.utilMax,
      gpuUtilAvg: s && s.utilN ? Math.round(s.utilSum / s.utilN) : null,
      memPeak: s && s.memPeakMiB,
      groupCpuMax: s && s.groupCpuMax !== undefined ? s.groupCpuMax : null,
      groupMemPeakMiB: s && s.groupMemPeakMiB !== undefined ? s.groupMemPeakMiB : null,
      otherMemPeakMiB: s && s.otherMemPeakMiB !== undefined ? s.otherMemPeakMiB : null,
      durationSec: Math.max(0, Math.round(((run.endTs || Date.now()) - run.startTs) / 1000)),
      dataPartial: !!(deps.ring && deps.ring.size() >= 1 && ((run.endTs || Date.now()) - run.startTs) > RING_MAX_MS),
    }
  }

  function archive(run: RunRecord, endReason: string): void {
    run.endTs = Date.now()
    run.endReason = endReason
    run.state = endReason === 'aborted' ? 'aborted' : endReason === 'done' ? 'done' : 'crashed'
    run.summary = run.summary || buildSummary(run)
    state.runs.delete(run.runId)
    state.history.unshift(run)
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY
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
  // 2026-08-20（A2 多轨）：并行跟踪上限 MAX_PARALLEL_RUNS——超出时归档最旧 running 为 aborted；
  // 不再「新 start 即归档旧 run」（v1 单跟踪语义，P1 验收 7 已更新）。
  // ① start：pre-execute 命中训练命令（只记 runId/cmd 特征/startTs，无 pid，T1-1）
  // 2026-08-20（A2 多轨）：并行跟踪上限 MAX_PARALLEL_RUNS——超出时归档最旧 running 为 aborted；
  // 不再「新 start 即归档旧 run」（v1 单跟踪语义，P1 验收 7 已更新）。
  // M3（issue#7）：agent 可选参——发起实验的 agent（agentId/agentRole/parentId），通知路由用
  function start(cmdStr: string, feature: string, agent?: { agentId?: string | null; agentRole?: 'root' | 'subagent'; parentId?: string | null }): RunRecord {
    const running = all()
    if (running.length >= MAX_PARALLEL_RUNS) {
      const oldest = running.reduce((a, b) => (a.startTs <= b.startTs ? a : b))
      archive(oldest, 'aborted') // 上限触发：最旧 running 归档 aborted
    }
    // M2（issue#6）：实验类型三层识别（config→auto→learn→unknown；学习层样本 = history 同 fingerprint 时长）
    const typeInfo = deps.expType
      ? classifyExpType(cmdStr, {
          ...deps.expType(),
          history: state.history.map((r) => ({
            fingerprint: r.fingerprint,
            durationSec: (r.summary && typeof r.summary.durationSec === 'number') ? r.summary.durationSec : 0,
          })),
        })
      : { type: 'unknown' as ExpType, layer: 'unknown' as const }
    const run: RunRecord = {
      runId: makeRunId(),
      cmd: cmdStr,
      cmdFeature: feature,
      pid: null,
      procGroup: null,
      startTs: Date.now(),
      endTs: null,
      state: 'running',
      endReason: null,
      resultSeen: false,
      fingerprint: cmdFingerprint(cmdStr),
      type: typeInfo.type,
      agentId: agent?.agentId ?? null,
      agentRole: agent?.agentRole,
      parentId: agent?.parentId ?? null,
      graceTicks: 0,
      alerting: false,
      procGone: false,
      pidMissingStreak: 0,
      groupStats: null,
      sampleStats: null,
    }
    state.runs.set(run.runId, run)
    if (deps.ring) deps.ring.expand() // R-3：running 期扩容
    deps.emitLab('lab/experiment-start', { runId: run.runId, cmd: cmdStr, cmdFeature: feature, startTs: run.startTs, type: run.type, expTypeLayer: typeInfo.layer, agentId: run.agentId, agentRole: run.agentRole })
    return run
  }

  // ② pid 关联（ps 回填 / 显式注入；加入进程组；runId 可选，缺省作用于主实验）
  function associateProc(pid: number, runId?: string | null): void {
    const run = runId && state.runs.has(runId) ? state.runs.get(runId) as RunRecord : cur()
    if (run && pid) {
      if (!run.pid) run.pid = pid
      if (!run.procGroup) run.procGroup = new Set()
      run.procGroup.add(pid)
      run.pidMissingStreak = 0
    }
  }
  function associatePid(pid: number, runId?: string | null): void {
    associateProc(pid, runId)
  }

  // ③ done / crashed（T1-2 配对 + 双确认；kill 自身 result 不配对 → 忽略）
  // 2026-08-20（A2 多轨）：runId 精确归属优先；无 runId 时按 cmd 指纹匹配 running run（T1-2 复用）
  function markResult(paired: boolean, runId?: string | null): void {
    let run: RunRecord | null = null
    if (runId && state.runs.has(runId)) {
      run = state.runs.get(runId) as RunRecord
    } else if (paired) {
      // 指纹回退：交给上层按指纹找（本函数只收「已配对」信号；多轨下若调用方已锁定 runId 则直取）
      run = cur()
    }
    if (!run) return
    if (!paired) return // 不匹配的 result 忽略（ls/curl/kill 等）
    run.resultSeen = true
    if (run.procGone) conclude(run, 'done')
  }

  // ps tick：实验进程组存活检测（B2：ppid 递归扩张）+ crashed/done 双确认
  // R3：pid 变化 → 按 cmd 指纹重新关联主进程；pid 复用（cmd 不符）→ 剔除
  // 2026-08-20（A2 多轨）：遍历全部 running run，per-run 独立判定（pidMissingStreak per-run）
  function tick(aliveProcs: PsProc[]): void {
    const runs = all()
    if (!runs.length) return
    for (const run of runs) {
      tickRun(run, aliveProcs)
    }
  }

  function tickRun(run: RunRecord, aliveProcs: PsProc[]): void {
    // 主进程查找（pid 精确优先，其次指纹——v1.4.5 语义）
    const main = findAliveProc(run, aliveProcs)
    // 组扩张根：主进程优先；主进程消失但组内成员存活（worker 存活）→ 以指纹匹配成员为根
    const roots: number[] = []
    if (main) {
      roots.push(main.pid)
    } else if (run.procGroup) {
      for (const pid of run.procGroup) {
        const p = aliveProcs.find((q) => q.pid === pid)
        if (p && memberMatches(run, p)) roots.push(pid)
      }
    }
    // BFS 沿 ppid 扩张至不动点（子进程延迟出生在下一 5s 周期自然纳入，R4）
    const G = new Set<number>()
    const queue = [...roots]
    while (queue.length) {
      const pid = queue.pop() as number
      if (G.has(pid)) continue
      G.add(pid)
      for (let i = 0; i < aliveProcs.length; i++) {
        const p = aliveProcs[i]
        if (p.ppid === pid && !G.has(p.pid)) queue.push(p.pid)
      }
    }
    run.procGroup = G
    if (G.size > 0) {
      if (main) run.pid = main.pid // R3：pid 变化重关联
      else if (!run.pid) run.pid = roots[0]
      run.pidMissingStreak = 0
      run.procGone = false
      run.graceTicks = 0
      return
    }
    run.procGone = true
    if (run.resultSeen) {
      conclude(run, 'done') // done 双确认 2/2：配对 result + 进程组消失
      return
    }
    run.pidMissingStreak += 1
    if (run.pidMissingStreak >= CRASH_PS_GAP) conclude(run, 'crashed') // 进程组消失 ≥2 ps 周期
  }

  // 配对 result 后进程仍活 → 宽限 2 个 ps 周期后再判 done（异常残留）
  function tickGrace(run: RunRecord): void {
    if (!run || run.state !== 'running' || !run.resultSeen) return
    run.graceTicks += 1
    if (run.graceTicks >= DONE_GRACE_TICKS) conclude(run, 'done')
  }

  // 平衡引擎 critical 置位（alerting 状态语义；runId 可选，缺省作用于主实验）
  function setAlerting(on: boolean, runId?: string | null): void {
    const run = runId && state.runs.has(runId) ? state.runs.get(runId) as RunRecord : cur()
    if (run) run.alerting = on
  }

  function toSnapshot(run: RunRecord): ExperimentSnapshot {
    return {
      runId: run.runId,
      state: run.alerting ? 'alerting' : 'running',
      cmd: run.cmd,
      cmdFeature: run.cmdFeature,
      pid: run.pid,
      procGroup: run.procGroup ? [...run.procGroup] : null,
      groupStats: run.groupStats || null, // 2026-08-20（A2 多轨）：透传 ps 周期写入的 run 自有聚合；无则上层回填
      startTs: run.startTs,
      summary: null,
      endReason: null,
      type: run.type,
      agentId: run.agentId,
      agentRole: run.agentRole,
      parentId: run.parentId,
    }
  }

  function toEndedSnapshot(run: RunRecord): EndedRunSnapshot {
    return {
      runId: run.runId,
      state: run.state === 'done' ? 'done' : run.state === 'aborted' ? 'aborted' : 'crashed',
      cmd: run.cmd,
      cmdFeature: run.cmdFeature,
      startTs: run.startTs,
      endTs: run.endTs,
      // 2026-08-22（P1 实验历史）：archive 时已 buildSummary——摘要含 GPU 峰值/均值/
      // 显存峰值/组 CPU 峰值/时长；此处直接透出（复盘数据面，UI/Agent 可见）
      summary: run.summary || null,
      // M2（issue#6）：类型 + 指纹透出（指纹供学习层历史归类；restoreEnded 恢复）
      type: run.type,
      fingerprint: run.fingerprint,
      // M3（issue#7）：发起 agent 透出（通知路由用）
      agentId: run.agentId,
    }
  }

  // 2026-08-22（P2）：实验历史持久化恢复——settings 读回的 ended 投影重建为最小 RunRecord，
  // 追加到 history 尾部（旧数据在后的时间序；新归档 unshift 在前），保持上限 20。
  // 已结束记录不进入 runs 判定（state 非 running，tick/判定流程不会触碰）。
  function restoreEnded(snapshots: EndedRunSnapshot[]): void {
    if (!Array.isArray(snapshots) || !snapshots.length) return
    const known = new Set(state.history.map((r) => r.runId))
    for (const s of snapshots) {
      if (!s || typeof s.runId !== 'string' || known.has(s.runId)) continue
      if (state.history.length >= MAX_HISTORY) break
      known.add(s.runId)
      state.history.push({
        runId: s.runId,
        cmd: typeof s.cmd === 'string' ? s.cmd : null,
        cmdFeature: typeof s.cmdFeature === 'string' ? s.cmdFeature : null,
        pid: null,
        procGroup: null,
        startTs: typeof s.startTs === 'number' ? s.startTs : 0,
        endTs: typeof s.endTs === 'number' ? s.endTs : null,
        state: s.state === 'done' ? 'done' : s.state === 'aborted' ? 'aborted' : 'crashed',
        endReason: s.state || null,
        resultSeen: s.state === 'done',
        fingerprint: typeof s.fingerprint === 'string' ? s.fingerprint : '',
        // M2（issue#6）：历史恢复保留类型（旧数据无 type → 不猜，留 unknown 语义由上层展示）
        type: s.type,
        agentId: typeof s.agentId === 'string' ? s.agentId : null,
        graceTicks: 0,
        alerting: false,
        pidMissingStreak: 0,
        groupStats: null,
        sampleStats: null,
        summary: s.summary && typeof s.summary === 'object' ? s.summary : undefined,
      })
    }
  }

  // 2026-08-24（#10 实验历史管理）：按 runId 删除单条已结束记录（不存在返回 false）
  function removeRun(runId: string): boolean {
    const idx = state.history.findIndex((r) => r.runId === runId)
    if (idx < 0) return false
    state.history.splice(idx, 1)
    return true
  }

  // 2026-08-24（#10 实验历史管理）：清空已结束记录，保留最近 N 条（keep 钳位 0..MAX_HISTORY），
  // 返回被移除的记录（调用方用于持久化与反馈）。splice 而非 length=——避免 n>实际长度时撑出空洞
  function clearHistory(keep = 0): RunRecord[] {
    const n = Math.max(0, Math.min(MAX_HISTORY, Math.round(keep)))
    const removed = state.history.slice(n)
    state.history.splice(n)
    return removed
  }

  function snapshot(): { main: ExperimentSnapshot | null; all: ExperimentSnapshot[]; ended: EndedRunSnapshot[] } {
    const runs = all()
    // 2026-08-22（P1 实验历史）：已结束实验（done/crashed/aborted）历史投影——倒序（最新在前），
    // state-machine 内部上限 20 条；对外不再丢历史（此前只有 main/all，复盘数据面缺失）
    const ended = state.history.map(toEndedSnapshot)
    if (!runs.length) return { main: null, all: [], ended }
    // main = 最近 start 的 running（与 cur() 一致）
    const mainRun = cur() as RunRecord
    return {
      main: toSnapshot(mainRun),
      all: runs.map(toSnapshot),
      ended,
    }
  }

  return { start, associatePid, associateProc, markResult, tick, tickGrace, setAlerting, snapshot, restoreEnded, removeRun, clearHistory, cur, all, history: state.history }
}
