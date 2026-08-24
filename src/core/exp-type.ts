/**
 * M2（issue#6，docs/research/22 §3.2）：实验类型三层识别
 * 层序（命中即返回）：配置层（用户意图）→ 自动层（保守正则）→ 学习层（fingerprint 历史时长）→ 兜底 defaultType
 * 原则：未命中=unknown 不猜（防误报优先）；类型矩阵是配置（experimentTypes），不硬编码代码分支。
 */
import { EXP_TYPE_PATTERNS, LONG_LEARN_SEC, cmdFingerprint, matchTrainFeature } from './constants.js'
import type { ExpType, NotifyLevel } from './types.js'

/** 配置层规则（experimentTypes[]，复用 TagRule 形态：pattern→type→notify 覆盖） */
export interface ExpTypeRule {
  type: ExpType
  patterns: string[]
  notify?: { critical?: NotifyLevel; warn?: NotifyLevel }
  expectedMaxSec?: number
}

/** 学习层样本（fingerprint → 历史时长，供 p90 归类） */
export interface ExpTypeLearnSample {
  fingerprint: string
  durationSec: number
}

export interface ExpTypeResult {
  type: ExpType
  /** 识别层：config=用户规则 / auto=自动正则 / learn=历史时长 / unknown=兜底未识别 */
  layer: 'config' | 'auto' | 'learn' | 'unknown'
}

export interface ExpTypeOptions {
  /** 配置层规则（settings experimentTypes；优先级最高） */
  rules?: ExpTypeRule[]
  /** 学习层历史样本（state-machine history：fingerprint + summary.durationSec） */
  history?: ExpTypeLearnSample[]
  /** 是否启用学习层（settings expTypeLearning，默认 true） */
  learning?: boolean
  /** 兜底类型（settings expTypeDefault，默认 unknown） */
  defaultType?: ExpType
}

/** 类型中文标签（UI/日志展示） */
export const EXP_TYPE_LABELS: Record<ExpType, string> = {
  smoke: '冒烟', regression: '回归', full: '全量', short: '短任务',
  long: '长任务', 'gpu-calc': 'GPU计算', 'gpu-train': 'GPU训练', unknown: '未知',
}

/** 8 类枚举集合（配置校验用） */
export const EXP_TYPES: ExpType[] = ['smoke', 'regression', 'full', 'short', 'long', 'gpu-calc', 'gpu-train', 'unknown']
export const EXP_TYPES_SET: ReadonlySet<string> = new Set(EXP_TYPES)

export function classifyExpType(cmdStr: string | null | undefined, opts?: ExpTypeOptions): ExpTypeResult {
  const c = String(cmdStr || '').trim()
  if (!c) return { type: 'unknown', layer: 'unknown' }

  // 1. 配置层（用户意图，最高优先；无效正则跳过不炸）
  const rules = opts?.rules
  if (rules && rules.length) {
    for (const r of rules) {
      if (!r || typeof r.type !== 'string' || !Array.isArray(r.patterns)) continue
      for (const p of r.patterns) {
        if (typeof p !== 'string' || !p) continue
        try {
          if (new RegExp(p, 'i').test(c)) return { type: r.type, layer: 'config' }
        } catch {
          /* 无效正则忽略 */
        }
      }
    }
  }

  // 2. 自动层（保守正则；gpu-train 由 TRAIN_PATTERNS 门控，2026-08-23 精度修复 11/11）
  for (const { type, re } of EXP_TYPE_PATTERNS) {
    if (re.test(c)) return { type, layer: 'auto' }
  }
  if (matchTrainFeature(c)) return { type: 'gpu-train', layer: 'auto' }

  // 3. 学习层（fingerprint 历史时长 p90 ≥ LONG_LEARN_SEC → long；<2 次样本不归类，防单次噪声）
  if (opts?.learning !== false && opts?.history && opts.history.length) {
    const fp = cmdFingerprint(c)
    const durs = opts.history
      .filter((h) => h && h.fingerprint === fp && typeof h.durationSec === 'number' && h.durationSec > 0)
      .map((h) => h.durationSec)
      .sort((a, b) => a - b)
    if (durs.length >= 2) {
      const p90 = durs[Math.min(durs.length - 1, Math.floor(durs.length * 0.9))]
      if (p90 >= LONG_LEARN_SEC) return { type: 'long', layer: 'learn' }
    }
  }

  // 4. 兜底（默认 unknown，不猜）
  return { type: opts?.defaultType || 'unknown', layer: 'unknown' }
}
