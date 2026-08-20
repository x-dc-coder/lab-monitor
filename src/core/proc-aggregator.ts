/**
 * proc-aggregator（实验进程组 vs 非实验组拆分聚合）—— 设计文档 14 §2.2（Phase B3）
 * 纯函数：输入增强后 procs 表（pid/cmd/cpuPct/memMiB/ppid/gpuUtilPct）+ 实验进程组集合；
 * 输出 groupStats（主=CPU/内存/存在性，辅=GPU 每进程，预留=显存恒 null）+ systemStats。
 * 5s 粒度近似（R4：子进程延迟出生/成员消失延迟 ≤1 ps 周期）。
 */
import type { ProcSample } from '../sampler/backend-interface.js'
import type { GroupStats, ProcStat, SystemStats } from './types.js'

export interface AggregatorInput {
  procs: ProcSample[]
  /** 实验进程组 pid 集合（state-machine 每 5s 周期输出）；null/空 = 无实验 */
  group: Set<number> | null
  runActive: boolean
}

const TOP_N = 5

/** ProcSample → ProcStat（GPU 每进程仅在有值（pmon 活动进程）时附） */
function toProcStat(p: ProcSample): ProcStat {
  return {
    pid: p.pid,
    cmd: p.cmd ?? null,
    cpuPct: typeof p.cpuPct === 'number' ? p.cpuPct : null,
    memMiB: typeof p.memMiB === 'number' ? p.memMiB : null,
    gpuUtilPct: typeof p.gpuUtilPct === 'number' ? p.gpuUtilPct : null,
  }
}

/** 数值求和（2026-08-20：`Number.isFinite` 取代 `typeof number`——NaN 也会通过 typeof 检查并
 * 污染聚合结果，直达工具输出破坏 lossless JSON 校验）。 */
function sumCpu(ps: ProcStat[]): number | null {
  let s = 0
  let n = 0
  for (let i = 0; i < ps.length; i++) {
    const v = ps[i].cpuPct
    if (typeof v === 'number' && Number.isFinite(v)) {
      s += v
      n += 1
    }
  }
  return n ? Math.round(s * 10) / 10 : null
}

function sumMem(ps: ProcStat[]): number | null {
  let s = 0
  let n = 0
  for (let i = 0; i < ps.length; i++) {
    const v = ps[i].memMiB
    if (typeof v === 'number' && Number.isFinite(v)) {
      s += v
      n += 1
    }
  }
  return n ? Math.round(s) : null
}

function sumGpu(ps: ProcStat[]): number | null {
  let s = 0
  let n = 0
  for (let i = 0; i < ps.length; i++) {
    const v = ps[i].gpuUtilPct
    if (typeof v === 'number' && Number.isFinite(v)) {
      s += v
      n += 1
    }
  }
  return n ? Math.min(Math.round(s * 10) / 10, 100) : null
}

/** 拆分聚合：G（实验进程组） vs 非 G（系统其他进程） */
export function aggregateProcStats(input: AggregatorInput): { group: GroupStats | null; system: SystemStats | null } {
  const groupSet = input.runActive && input.group ? input.group : null
  const members: ProcStat[] = []
  const others: ProcStat[] = []
  for (let i = 0; i < input.procs.length; i++) {
    const p = input.procs[i]
    const stat = toProcStat(p)
    if (groupSet && groupSet.has(p.pid)) members.push(stat)
    else others.push(stat)
  }

  let group: GroupStats | null = null
  if (groupSet) {
    group = {
      cpuPct: sumCpu(members),
      memMiB: sumMem(members),
      memberCount: members.length,
      alive: members.length > 0,
      gpuUtilPct: sumGpu(members),
      gpuMemMiB: null, // 预留字段：恒 null（Windows/WSL 受限于 [N/A]，不启用）
      members: members.slice(0, 20), // 组明细封顶（R6：快照体积）
    }
  }

  // 非实验组：全表 − G（pid 差集）；无实验时 = 全表
  others.sort((a, b) => (b.memMiB ?? 0) - (a.memMiB ?? 0) || (b.cpuPct ?? 0) - (a.cpuPct ?? 0))
  const system: SystemStats = {
    cpuPct: sumCpu(others),
    memMiB: sumMem(others),
    gpuUtilPct: sumGpu(others),
    gpuMemMiB: null, // 预留字段：恒 null（不启用）
    topN: others.slice(0, TOP_N),
  }

  return { group, system }
}
