/**
 * 核心共享类型（SamplePoint / 实验记录 / 快照）
 */
import type { GpuSample, ProcSample } from '../sampler/backend-interface.js'

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
  degraded?: { gpu?: string; reason?: string } | null
}

/** 实验记录（state-machine） */
export interface RunRecord {
  runId: string
  cmd: string | null
  cmdFeature: string | null
  pid: number | null
  startTs: number
  endTs: number | null
  state: 'running' | 'done' | 'crashed' | 'aborted'
  endReason: string | null
  resultSeen: boolean
  fingerprint: string
  graceTicks: number
  alerting: boolean
  procGone?: boolean
  sampleStats: { utilSum: number; utilN: number; utilMax: number; memPeakMiB: number } | null
  summary?: { gpuUtilMax: number | null; gpuUtilAvg: number | null; memPeak: number | null; durationSec: number; dataPartial: boolean }
}

/** 实验状态快照（对外协议） */
export interface ExperimentSnapshot {
  runId: string
  state: string
  cmd: string | null
  cmdFeature: string | null
  pid: number | null
  startTs: number
  summary: RunRecord['summary'] | null
  endReason: string | null
}

/** 告警 */
export interface Alert {
  level: 'critical' | 'warn' | 'info' | string
  rule: string
  msg: string
  confidence: number
  actions: string[]
  ts: number
  runId: string | null
}

/** 完整对外快照（lab-protocol/1.1） */
export interface MonitorSnapshot {
  ts: number
  platform: string
  sources: { gpu?: string; cpu: string; mem: string; procs: string }
  gpu?: GpuSample[]
  gpuState: string
  cpu: { percent: number | null; cores: number | null }
  mem: { totalMiB: number | null; availableMiB: number | null }
  procs: ProcSample[]
  alerts: Alert[]
  alertsCriticalCount: number
  experiment: ExperimentSnapshot | null
  callCount: number
  ui: { betterSidebarVisible: boolean }
  degraded?: { gpu?: string; reason?: string }
}
