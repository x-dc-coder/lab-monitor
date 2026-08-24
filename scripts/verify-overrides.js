#!/usr/bin/env node
/**
 * verify-overrides.js — #13-3 差异化阈值端到端逻辑验证（不依赖 DSH 运行）
 * 链路：client 设置页 JSON → control set-threshold(thresholdOverrides) →
 *       createThresholds.setOverrides → resolveThresholds 覆盖链 → 各规则阈值生效
 */
import { createThresholds, createBalancer, resolveThresholds } from '../lib/types/core/balancer.js'
import { THRESHOLD_DEFAULTS } from '../lib/types/core/constants.js'

let fail = 0
const ok = (cond, name) => { if (cond) console.log('  ✓', name); else { fail++; console.error('  ✗', name) } }

// ── 1) createThresholds 生命周期（模拟 host 侧）──
const ctrl = createThresholds()
ok(ctrl.get().utilWarn === THRESHOLD_DEFAULTS.utilWarn, '初始=全局默认')

// 模拟 lab_ctl set-threshold 写全局
ctrl.apply({ utilWarn: 80, memWarn: 80 }, true)
ok(ctrl.get().utilWarn === 80, 'apply 全局阈值生效')

// ── 2) setOverrides（模拟 client 保存 JSON）──
ctrl.setOverrides({
  byExpType: { 'gpu-train': { utilWarn: 60, memWarn: 90 }, 'gpu-calc': { utilWarn: 40 } },
  byTag: { '推理服务': { memWarn: 95 } },
})
const ov = ctrl.getOverrides()
ok(ov.byExpType['gpu-train'].utilWarn === 60, 'setOverrides 保存 byExpType')
ok(ov.byTag['推理服务'].memWarn === 95, 'setOverrides 保存 byTag')

// ── 3) resolveThresholds 覆盖链（evaluate 内部路径）──
const base = { ...ctrl.get() }
// gpu-train：util 60 / mem 90（类型覆盖）
let t = resolveThresholds({ experimentType: 'gpu-train', tagHits: null }, base, ov)
ok(t.utilWarn === 60 && t.memWarn === 90, 'gpu-train → util 60/mem 90')
// gpu-train + 推理服务标签：mem 95 覆盖 90（标签组后覆盖）
t = resolveThresholds({ experimentType: 'gpu-train', tagHits: ['推理服务'] }, base, ov)
ok(t.memWarn === 95 && t.utilWarn === 60, 'gpu-train+推理服务 → mem 95 覆盖类型级 90')
// gpu-calc：util 40，mem 保持全局 80
t = resolveThresholds({ experimentType: 'gpu-calc', tagHits: null }, base, ov)
ok(t.utilWarn === 40 && t.memWarn === 80, 'gpu-calc → util 40/mem 全局 80')
// 无实验：全局
t = resolveThresholds({ experimentType: null, tagHits: null }, base, ov)
ok(t.utilWarn === 80, '无实验 → 全局 util 80')

// ── 4) createBalancer deps 接线（模拟 index.ts 调用形态）──
const balancer = createBalancer({
  thresholds: () => ctrl.get(),
  thresholdOverrides: () => ctrl.getOverrides(),
  emitLab: () => {},
  escalateAfterMs: () => 0,
})
ok(typeof balancer.evaluate === 'function' && typeof balancer.advice === 'function', 'balancer deps 接线正常')

// ── 5) 清理后回退全局（setOverrides({}) → 覆盖清空）──
ctrl.setOverrides({})
t = resolveThresholds({ experimentType: 'gpu-train', tagHits: null }, { ...ctrl.get() }, ctrl.getOverrides())
ok(t.utilWarn === 80, '清空覆盖 → 回退全局')

console.log(fail ? '❌ ' + fail + ' 个失败' : '✅ verify-overrides 全部通过（' + 12 + ' 断言）')
process.exit(fail ? 1 : 0)
