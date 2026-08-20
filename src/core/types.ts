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
  /** 2026-08-20：per-run 进程消失连续计数（多轨化：从 state 级移入，独立判定 crashed） */
  pidMissingStreak: number
  /** 2026-08-20（A2 多轨）：ps 周期按本 run 进程组聚合的统计（并行实验各自独立；无则上层回填主实验） */
  groupStats: GroupStats | null
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

/** 进程标签规则（2026-08-20 用户需求：手动对进程打标签分组展示；settings 持久化） */
export interface TagRule {
  /** 稳定 id（uuid，lab_ctl tag add 生成） */
  id: string
  /** 分组显示名 */
  label: string
  /** cmdline 正则列表（任一命中即归属；匹配全串，脚本形态天然覆盖——解释器进程 cmdline 含脚本路径） */
  patterns: string[]
  /** experiment=实验型（组内展示状态/时长/曲线）；process=进程型（组内只展示资源占用） */
  kind: 'experiment' | 'process'
  /** 展示色（可选，16 进制如 #3964fe） */
  color?: string
}

/** 标签组聚合（snapshot 输出：命中进程 + 聚合统计） */
export interface TagGroup {
  rule: TagRule
  pids: number[]
  procs: ProcStat[]
  gpuUtilPct?: number | null
  cpuPct?: number | null
  memMiB?: number | null
  /** 归属本组的实验 runId 列表（kind=experiment 且实验启动时命中规则；多轨下可多个） */
  runIds?: string[]
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
  /** 2026-08-20（A2 多轨）：全部 running 实验（experiment 保留为主实验=最近 start；本字段承载并行） */
  experiments?: ExperimentSnapshot[]
  /** 2026-08-20（标签分组）：用户标签规则命中聚合（按规则分组展示） */
  tags?: TagGroup[]
  alerts: Alert[]
  alertsCriticalCount: number
  experiment: ExperimentSnapshot | null
  callCount: number
  ui: { betterSidebarVisible: boolean }
  degraded?: { gpu?: string; reason?: string }
}
