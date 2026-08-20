/**
 * 核心共享类型（SamplePoint / 实验记录 / 快照）
 */
import type { GpuSample, ProcSample } from '../sampler/backend-interface.js'

/** 进程统计条目（实验组成员 / 系统 TopN 明细） */
export interface ProcStat {
  pid: number
  cmd: string | null
  cpuPct: number | null
  memMiB: number | null
  gpuUtilPct?: number | null
}
/** 实验进程组聚合（5s 周期；主=CPU/内存/存在性，辅=GPU 每进程，预留=显存恒 null） */
export interface GroupStats {
  cpuPct: number | null
  memMiB: number | null
  memberCount: number
  alive: boolean
  gpuUtilPct?: number | null
  gpuMemMiB?: number | null // 预留字段：恒 null（Windows/WSL 受限于 [N/A]，不启用）
  members: ProcStat[]
}

/** 非实验组（系统其他进程）聚合 */
export interface SystemStats {
  cpuPct: number | null
  memMiB: number | null
  gpuUtilPct?: number | null
  gpuMemMiB?: number | null // 预留字段：恒 null（不启用）
  topN: ProcStat[]
}

/** ring 元素：采样快照 → 轻量采样点 */
export interface SamplePoint {
  ts: number
  gpu: GpuSample[]
  gpuState: string
  cpuPct: number | null
  cores: number | null
  memUsedMiB: number | null
  memTotalMiB: number | null
  procs: ProcSample[]
  /** 1.2：实验进程组聚合（ps 5s 周期才有值，2s 采样点 null） */
  group?: GroupStats | null
  /** 1.2：非实验组（系统其他进程）聚合（ps 5s 周期） */
  system?: SystemStats | null
  /** 1.2：是否有实验 running（告警归属仲裁输入） */
  experimentActive?: boolean
  degraded?: { gpu?: string; reason?: string } | null
}

/** 实验记录（state-machine） */
export interface RunRecord {
  runId: string
  cmd: string | null
  cmdFeature: string | null
  pid: number | null
  /** 1.2：实验进程组 pid 集合（主 pid ∪ 子进程/worker；ppid 递归扩张） */
  procGroup: Set<number> | null
  startTs: number
  endTs: number | null
  state: 'running' | 'done' | 'crashed' | 'aborted'
  endReason: string | null
  resultSeen: boolean
  fingerprint: string
  graceTicks: number
  alerting: boolean
  procGone?: boolean
  sampleStats: { utilSum: number; utilN: number; utilMax: number; memPeakMiB: number; groupCpuMax?: number | null; groupMemPeakMiB?: number | null; otherMemPeakMiB?: number | null } | null
  summary?: { gpuUtilMax: number | null; gpuUtilAvg: number | null; memPeak: number | null; durationSec: number; dataPartial: boolean; groupCpuMax?: number | null; groupMemPeakMiB?: number | null; otherMemPeakMiB?: number | null }
}

/** 实验状态快照（对外协议 1.2：+procGroup/+groupStats） */
export interface ExperimentSnapshot {
  runId: string
  state: string
  cmd: string | null
  cmdFeature: string | null
  pid: number | null
  /** 1.2：实验进程组 pid 集合 */
  procGroup: number[] | null
  /** 1.2：实验组聚合（最近一次 5s 周期；null=尚未聚合） */
  groupStats: GroupStats | null
  startTs: number
  summary: RunRecord['summary'] | null
  endReason: string | null
}

/** 告警（1.2：+evidence 进程证据） */
export interface Alert {
  level: 'critical' | 'warn' | 'info' | string
  rule: string
  msg: string
  confidence: number
  actions: string[]
  /** 1.2：进程级证据（触发时附 Top 相关进程，CPU/内存为主） */
  evidence?: { procs: ProcStat[] }
  ts: number
  runId: string | null
}

/** 完整对外快照（lab-protocol/1.2：+system；experiment +procGroup/+groupStats） */
export interface MonitorSnapshot {
  ts: number
  platform: string
  sources: { gpu?: string; cpu: string; mem: string; procs: string }
  gpu?: GpuSample[]
  gpuState: string
  cpu: { percent: number | null; cores: number | null }
  mem: { totalMiB: number | null; availableMiB: number | null }
  procs: ProcSample[]
  /** 1.2：非实验组（系统其他进程）统计 */
  system: SystemStats | null
  /** 2026-08-20：命中 watchProcs 关键词的进程 pid 列表（面板高亮+置顶；空=未配置/未命中） */
  watchedPids?: number[]
  alerts: Alert[]
  alertsCriticalCount: number
  experiment: ExperimentSnapshot | null
  callCount: number
  ui: { betterSidebarVisible: boolean }
  degraded?: { gpu?: string; reason?: string }
}
