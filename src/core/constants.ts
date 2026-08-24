/**
 * 核心常量（指标/训练关键词/采样参数）—— 迁移自 host/index.js §1
 */
import type { ExpType, NotifyLevel } from './types.js'

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
/** 2026-08-22（P2 实验历史）：已结束实验历史上限（ended[] 投影与 settings 持久化共用） */
export const MAX_HISTORY = 20

export const THRESHOLD_DEFAULTS = {
  utilWarn: 90, memWarn: 95, tempWarn: 85, pollMs: 5000,
  // 2026-08-23：进程排序（取前 N + 权重，均可调）
  procTopN: 30, wGpu: 1, wCpu: 1, wMem: 1,
}
/** #13-3 差异化阈值：全局阈值的分层覆盖（全局 → 实验类型 → 标签组）
 *  byExpType: { gpu-train: { utilWarn: 60, memWarn: 90 }, ... }
 *  byTag:     { "推理服务": { memWarn: 95 }, ... }（按主实验进程组命中的标签组） */
export interface ThresholdOverrides {
  byExpType?: Record<string, Partial<Thresholds>>
  byTag?: Record<string, Partial<Thresholds>>
}
export type Thresholds = typeof THRESHOLD_DEFAULTS
export const THRESH_KEYS = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs', 'procTopN', 'wGpu', 'wCpu', 'wMem'] as const

/**
 * 训练命令识别表（T4-1 + 2026-08-23 精度修复）
 * 误报实证（T2 §2.4，~/.dsh/settings.yaml history）：grep 模式串含 "torchrun" 被命中、
 * gh issue heredoc 含 torchrun 字样命中、python3 -c "import zipfile" 工具脚本全被记为实验。
 * 修复原则（docs/research/21-t2 §2.4 + 22-issue5 §3.3）：
 *   - torchrun/deepspeed 不再裸词匹配：要求后跟 脚本文件 或 训练器句式（-m torch.distributed 等）
 *   - python -c/-m 增加排除特征：常见工具/检查形态（import zipfile/docx 检查、打印环境等）不命中
 *   - 未命中 = null（不猜），防误报优先
 */
export const TRAIN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'python train*.py', re: /(?:^|[^a-z0-9._-])(?:python3?|uv)\s+(?:\S+[\/\\])?train[^\s'" ]*\.py/i },
  // torchrun/deepspeed 句式化：后跟脚本文件（torchrun --nproc_per_node=8 train.py / torchrun train.py）
  // 或 torch.distributed 启动句式（-m torch.distributed.run）；排除 grep/heredoc/注释中的裸词
  {
    name: 'torchrun',
    re: /(?:^|[^a-z0-9._-])torchrun\b(?:\s+--?[a-z0-9_=-]+)*\s+(?:\S+[\/\\])?[a-zA-Z0-9_.-]+\.(?:py|sh)\b|(?:^|[^a-z0-9._-])torchrun\b[\s\S]*?-m\s+torch\.distributed\b/i,
  },
  {
    name: 'deepspeed',
    re: /(?:^|[^a-z0-9._-])deepspeed\b(?:\s+--?[a-z0-9_=-]+)*\s+(?:\S+[\/\\])?[a-zA-Z0-9_.-]+\.(?:py|sh)\b/i,
  },
  // python -m：排除常见工具形态（uv/pip/venv/ensurepip/zipfile/torch 环境检查等价物）
  // —— 优先匹配明确的模块训练入口（torch.distributed / accelerate / deepspeed 式）
  {
    name: 'python -m',
    re: /(?:^|[^a-z0-9._-])(?:python3?|uv)\s+-m\s+(?:torch\.distributed|accelerate|deepspeed)\b/i,
  },
  // python -c：不再全匹配；仅当内联代码含明确训练特征（train/backward/epochs/torch.distributed/nn.Module）
  // 时命中；排除 import zipfile/docx 检查、print 环境、单行脚本等工具调用（T2 §2.4 实证）。
  // 修正（2026-08-23）：① 关键词组不用尾部 \b——backward( 后跟 ; 无词边界会失配，改为光文字匹配；
  // ② \b 放键内——train 用 \btrain(?![a-z_]) 命中 train_epoch/train.py 又不误吃 training。
  {
    name: 'python -c',
    re: /(?:^|[^a-z0-9._-])python3?\s+-c\s+["'][\s\S]{0,400}?(?:torch\.distributed|nn\.Module|backward|epochs?|\btrain(?![a-z_])|\btraining\b)/i,
  },
]

export function matchTrainFeature(cmdStr: string | null | undefined): string | null {
  if (typeof cmdStr !== 'string') return null
  for (let i = 0; i < TRAIN_PATTERNS.length; i++) {
    if (TRAIN_PATTERNS[i].re.test(cmdStr)) return TRAIN_PATTERNS[i].name
  }
  return null
}

/**
 * M2（issue#6，docs/research/22 §3.3）：实验类型自动层识别正则（保守，未命中不猜）。
 * 判定顺序（classifyExpType）：smoke/regression/full 明确形态 → gpu-train（matchTrainFeature 门控）
 * → gpu-calc（推理/渲染/仿真，非 train）→ long（serve/batch 类长驻）。gpu-train 不在本表，
 * 由 TRAIN_PATTERNS（2026-08-23 精度修复，11/11 验证）门控，避免与 calc 关键字冲突。
 */
export const EXP_TYPE_PATTERNS: { type: ExpType; re: RegExp }[] = [
  { type: 'smoke', re: /\b(smoke|冒烟|--smoke|test_smoke|smoke_test)\b/i },
  { type: 'regression', re: /\b(regression|回归|run_regression|regress)\b/i },
  { type: 'full', re: /\b(full|全量|run_all|--full|e2e_all)\b/i },
  // gpu-calc：推理/渲染/仿真（脚本名形态 infer*.py / render*.py / sim*.py + 中文关键词）；
  // 裸词 \binfer\b 匹配不到 infer_model.py（后跟 _ 是词字符，无词边界），需脚本名形态
  { type: 'gpu-calc', re: /\b(?:infer|inference|render|sim|simulate)[\w-]*\.py\b|(?:推理|渲染)/i },
  // long：脚本名形态（serve_*.py / batch_*.py / daemon/watch 类）——不用裸词 batch（--batch 32 参数
  // 在训练命令中常见，会抢先于 train 门控误判，实证 deepspeed train_llm.py --batch 8 → 应为 gpu-train）
  { type: 'long', re: /\b(?:serve|batch|daemon|watch)[\w-]*\.py\b/i },
]

/**
 * M2（issue#6，docs/research/22 §3.4）：类型 × notifyLevel 出厂默认矩阵。
 * 语义：类型矩阵 = 配置（experimentTypes 可覆盖），本表只是出厂建议值，不硬编码代码分支。
 * unknown 走全局 fallback（critical→notice 起点，不给类型特权）。
 */
export const EXP_TYPE_DEFAULT_NOTIFY: Record<ExpType, { critical: NotifyLevel; warn: NotifyLevel }> = {
  smoke: { critical: 'notice', warn: 'off' },
  regression: { critical: 'notice', warn: 'off' },
  full: { critical: 'wake', warn: 'notice' },
  short: { critical: 'wake', warn: 'notice' },
  long: { critical: 'wake', warn: 'notice' },
  'gpu-calc': { critical: 'wake', warn: 'notice' },
  'gpu-train': { critical: 'wake', warn: 'wake' },
  unknown: { critical: 'notice', warn: 'notice' },
}
/** M2：学习层长任务归类阈值——同 fingerprint 历史时长 p90 ≥ 3600s → long（docs/research/22 §3.2 S5） */
export const LONG_LEARN_SEC = 3600

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
/**
 * runId（settings 持久化主键 / 告警 runId 关联 / history 去重）
 * 2026-08-24（实测修复）：原实现仅日期+计数器，重启后计数器归零 → 同日重启多次会与
 * settings 恢复的旧记录 runId 重复（实测 run-20260824-001 出现两条：恢复的历史 + 新 run）。
 * 仿 makeTagId 修复：日期 + HHMMSS + 计数器（同一秒内最多 999 条，重启后同秒并发概率可忽略）。
 */
export function makeRunId(): string {
  RUN_ID_COUNTER += 1
  const d = new Date()
  const y = d.getFullYear()
  const mo = ('0' + (d.getMonth() + 1)).slice(-2)
  const dd = ('0' + d.getDate()).slice(-2)
  const hh = ('0' + d.getHours()).slice(-2)
  const mm = ('0' + d.getMinutes()).slice(-2)
  const ss = ('0' + d.getSeconds()).slice(-2)
  return 'run-' + y + mo + dd + '-' + hh + mm + ss + '-' + ('000' + RUN_ID_COUNTER).slice(-3)
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
