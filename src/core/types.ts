/**
 * 核心共享类型（SamplePoint / 实验记录 / 快照）
 */
import type { GpuSample, ProcSample } from '../sampler/backend-interface.js'

/** 进程统计条目（实验组成员 / 系统 TopN 明细） */
export interface ProcStat {
  pid: number
  ppid?: number | null   // #16：父进程 pid（进程详情展示）
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
  /** #13-3 差异化阈值：当前主实验类型（gpu-train/gpu-calc/long/...；无实验=undefined） */
  experimentType?: string | null
  /** #13-3 差异化阈值：主实验 cmd 命中的标签组 label 列表（byTag 覆盖键） */
  tagHits?: string[] | null
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
  /** M2（issue#6）：实验类型（8 类枚举；start 时识别，unknown=未命中不猜） */
  type?: ExpType
  /** M3（issue#7）：发起实验的 agent（pre-execute 读 exec.agent；无=旧宿主/外部，路由回退 roots()） */
  agentId?: string | null
  agentRole?: 'root' | 'subagent'
  parentId?: string | null
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

/** 实验状态快照（对外协议 1.2：+procGroup/+groupStats；M2：+type 实验类型） */
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
  /** M2（issue#6）：实验类型（unknown=未识别） */
  type?: ExpType
  /** M3（issue#7）：发起 agent（通知路由用） */
  agentId?: string | null
  agentRole?: 'root' | 'subagent'
  parentId?: string | null
}

/** 已结束实验记录（对外协议：experiment 历史复盘；state-machine history 摘要投影，倒序=最新在前） */
export interface EndedRunSnapshot {
  runId: string
  state: 'done' | 'crashed' | 'aborted'
  cmd: string | null
  cmdFeature: string | null
  startTs: number
  endTs: number | null
  /** 复盘中可展示的峰值摘要（GPU 峰值/均值、显存峰值、组 CPU 峰值、时长；null=无采样数据） */
  summary: RunRecord['summary'] | null
  /** M2（issue#6）：实验类型 + 命令指纹（指纹供学习层历史时长归类；restoreEnded 补存） */
  type?: ExpType
  fingerprint?: string
  /** M3（issue#7）：发起 agent（通知路由用） */
  agentId?: string | null
}

/** M2（issue#6）：实验类型 8 类枚举（unknown=未识别，保守默认不猜） */
export type ExpType = 'smoke' | 'regression' | 'full' | 'short' | 'long' | 'gpu-calc' | 'gpu-train' | 'unknown'
/** M2（issue#6）：通知档位（策略引擎输出，design docs/research/22 §2） */
export type NotifyLevel = 'off' | 'notice' | 'wake'

/** 告警（1.2：+evidence 进程证据；M1 issue#5：+severity/urgency/trend/sustainedMs 等多维扩展字段） */
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
  // ── M1（issue#5 严格分级，docs/research/22 §1.2；全部可选防破坏，旧数据零感知）──
  /** 严重度 1-5（rule 权重表静态映射：crash=5、oom=4、thermal=4、io=3、imbalance=2、other=2）——M1 必填 */
  severity?: 1 | 2 | 3 | 4 | 5
  /** 紧迫性 1-3（rule 基准 + trend 推导：crash=3、oom/thermal=2、其余=1；rising→+1）——M1 必填 */
  urgency?: 1 | 2 | 3
  /** 趋势：rising/steady/falling（由窗口内连续命中累计推导） */
  trend?: 'rising' | 'steady' | 'falling'
  /** 超阈值持续时长 ms（由 hitByRule 命中计数 × SAMPLE_MS 累计；替代固定 10s 防抖的累计值）——M1 必填 */
  sustainedMs?: number
  /** 资源类别：gpu-util/vram/temp/cpu/mem/io/process */
  resource?: 'gpu-util' | 'vram' | 'temp' | 'cpu' | 'mem' | 'io' | 'process'
  /** 归属：self=实验自身 / other=疑似他人 / system=无实验系统级 */
  origin?: 'self' | 'other' | 'system'
  /** 策略引擎输出档位（写回，UI/审计可见）：off/notice/wake */
  notifyLevel?: 'off' | 'notice' | 'wake'
  /** 是否已发生 warn→critical 通知升级（escalateAfterSec 触发；不改 level 本身） */
  escalate?: boolean
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
  /** 2026-08-23（监控目标 UI）：当前生效 watchProcs 关键词（client 设置页展示） */
  watchProcs?: string[]
  /** 2026-08-20（A2 多轨）：全部 running 实验（experiment 保留为主实验=最近 start；本字段承载并行） */
  experiments?: ExperimentSnapshot[]
  /** 2026-08-22（P1 实验历史）：已结束实验（done/crashed/aborted）历史，最新在前——复盘数据面 */
  ended?: EndedRunSnapshot[]
  /** 2026-08-22（P1 设置面）：当前生效阈值（client 轮询周期由 thresholds.pollMs 驱动，消除死配置；2026-08-23 含进程排序配置） */
  thresholds?: { utilWarn: number; memWarn: number; tempWarn: number; pollMs: number; procTopN?: number; wGpu?: number; wCpu?: number; wMem?: number }
  /** #13-3 差异化阈值：分层覆盖透出（client 设置页可读可编辑） */
  thresholdOverrides?: {
    byExpType?: Record<string, { utilWarn?: number; memWarn?: number; tempWarn?: number }>
    byTag?: Record<string, { utilWarn?: number; memWarn?: number; tempWarn?: number }>
  }
  /** 2026-08-22（P1 设置面）：监控引擎启停状态（start/pause/resume 的真实反映——UI 控制区显示） */
  enabled?: boolean
  /** M1（issue#5）：当前生效通知策略（client 设置页展示 + lab_status 可见） */
  notify?: {
    alertNotify: 'off' | 'notice' | 'wake'
    alertTargets: string[]
    notifyThrottleMs: number
    escalateAfterSec: number
    notifyTimeoutMs: number
    broadcast: boolean
    agentsAvailable: boolean
    notifiedFingerprints: number
  }
  /** 2026-08-20（标签分组）：用户标签规则命中聚合（按规则分组展示） */
  tags?: TagGroup[]
  alerts: Alert[]
  alertsCriticalCount: number
  experiment: ExperimentSnapshot | null
  callCount: number
  ui: { betterSidebarVisible: boolean }
  degraded?: { gpu?: string; reason?: string }
}
