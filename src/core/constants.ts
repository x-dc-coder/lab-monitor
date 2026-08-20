/**
 * 核心常量（指标/训练关键词/采样参数）—— 迁移自 host/index.js §1
 */

/** 采集周期（核心层固定 2s；UI 轮询见 pollMs） */
export const SAMPLE_MS = 2000
/** 进程表（ps）周期——状态机 pid 关联/crashed 判定对齐 */
export const PS_INTERVAL_MS = 5000
/** 环形缓冲双条件封顶（docs/02 §2.2） */
export const RING_MAX_POINTS = 1000
export const RING_MAX_MS = 30 * 60 * 1000
/** R-3：实验 running 期扩容至 2h */
export const RING_EXPAND_POINTS = 2000
export const RING_EXPAND_MS = 2 * 60 * 60 * 1000
/** 告警列表封顶 */
export const ALERT_MAX = 20
/** pid 连续消失 ≥2 个 ps 周期（10~15s）→ crashed */
export const CRASH_PS_GAP = 2
/** 配对 result 后进程仍活的宽限 ps 周期 → done */
export const DONE_GRACE_TICKS = 2
/** 2026-08-20（A2 多轨）：并行实验跟踪上限（超出时归档最旧 running 为 aborted） */
export const MAX_PARALLEL_RUNS = 4

export const THRESHOLD_DEFAULTS = { utilWarn: 90, memWarn: 95, tempWarn: 85, pollMs: 5000 }
export type Thresholds = typeof THRESHOLD_DEFAULTS
export const THRESH_KEYS = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs'] as const

/** 训练命令关键词表（T4-1：python train*.py / python -c / python3 -c / torchrun / deepspeed / python -m） */
export const TRAIN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'python train*.py', re: /(?:^|[^a-z0-9._-])(?:python3?|uv)\s+(?:\S+[\/\\])?train[^\s'" ]*\.py/i },
  { name: 'python -c', re: /(?:^|[^a-z0-9._-])python3?\s+-c\b/i },
  { name: 'python -m', re: /(?:^|[^a-z0-9._-])python3?\s+-m\b/i },
  { name: 'torchrun', re: /torchrun\b/i },
  { name: 'deepspeed', re: /deepspeed\b/i },
]

export function matchTrainFeature(cmdStr: string | null | undefined): string | null {
  if (typeof cmdStr !== 'string') return null
  for (let i = 0; i < TRAIN_PATTERNS.length; i++) {
    if (TRAIN_PATTERNS[i].re.test(cmdStr)) return TRAIN_PATTERNS[i].name
  }
  return null
}

/**
 * 命令指纹：ps 关联 / result 配对用的特征串（T1-1/T1-2）
 * v1.4.5（e2e 实证）：python -c 内联形态用「pyc: + 归一化命令从 -c 起的完整后缀前 28 字符」，
 * ps 行 indexOf 可匹配（findAliveProc 同归一化）；不可用 m[1]（分号处截断）。
 * 2026-08-20（A2 多轨修复）：28 → 48 字符——v1 单跟踪时指纹只匹配自身（长度无碍），
 * 多轨下两个相似命令（如 sleep(30) vs sleep(35)）在 28 字符处差异恰好被截掉 → 指纹相同
 * → 都关联到第一个进程（pid/procGroup 重叠，实证 run-001/run-002 共享进程组）。
 * 48 字符保留更多区分信息，且 ps cmdline 一般长于此，indexOf 匹配不受影响。
 */
export function cmdFingerprint(cmdStr: string | null | undefined): string {
  const norm = String(cmdStr || '').trim().replace(/\s+/g, ' ')
  const m = norm.match(/(?:^|[^a-z0-9._-])([a-zA-Z0-9_.\-]+\.py)\b/i)
  if (m) return m[1]
  const mc = norm.match(/-c\s+["']?([\s\S]+?)["']?\s*(?:$|;)/)
  if (/python3?\s+-c\b/.test(norm) && mc) {
    const tail = norm.slice(norm.indexOf('-c')).replace(/["']/g, '').replace(/\s+/g, ' ')
    return 'pyc:' + tail.slice(0, 48)
  }
  if (/torchrun|deepspeed/.test(norm)) return norm.split(/\s+/).slice(0, 6).join(' ').slice(0, 80)
  const tok = norm.split(/\s+/)[0] || ''
  return tok.slice(0, 40) || String(cmdStr).slice(0, 40)
}

/** ps 行归一化：与 cmdFingerprint 的归一化对齐（引号剥离、空白折叠） */
export function normalizeCmdForMatch(s: string | null | undefined): string {
  return String(s || '').replace(/["']/g, '').trim().replace(/\s+/g, ' ')
}

let RUN_ID_COUNTER = 0
export function makeRunId(): string {
  RUN_ID_COUNTER += 1
  const d = new Date()
  const y = d.getFullYear()
  const mo = ('0' + (d.getMonth() + 1)).slice(-2)
  const dd = ('0' + d.getDate()).slice(-2)
  return 'run-' + y + mo + dd + '-' + ('000' + RUN_ID_COUNTER).slice(-3)
}

let TAG_ID_COUNTER = 0
/**
 * 标签规则 id（与 runId 区分前缀；settings 持久化主键）
 * 2026-08-20（持久化修复）：id 必须跨重启唯一——之前仅日期+计数器，重启后计数器归零
 * → 新规则与磁盘已有规则 id 重复（实测 tag-20260820-001 重复两条，remove 会删错）。
 * 改为日期 + HHMMSS + 计数器（同一秒内最多 999 条，足够；重启后同秒并发概率可忽略）。
 */
export function makeTagId(): string {
  TAG_ID_COUNTER += 1
  const d = new Date()
  const y = d.getFullYear()
  const mo = ('0' + (d.getMonth() + 1)).slice(-2)
  const dd = ('0' + d.getDate()).slice(-2)
  const hh = ('0' + d.getHours()).slice(-2)
  const mm = ('0' + d.getMinutes()).slice(-2)
  const ss = ('0' + d.getSeconds()).slice(-2)
  return 'tag-' + y + mo + dd + '-' + hh + mm + ss + '-' + ('000' + TAG_ID_COUNTER).slice(-3)
}
