#!/usr/bin/env node
// ============================================================================
// verify-m1.js —— M1（issue#5 告警通知）单元验证：resolveAction 全格 + metricOf 指标提取
// ----------------------------------------------------------------------------
// 运行：node scripts/verify-m1.js（verify.sh [5b] 收录）
// 覆盖（设计 docs/research/22-issue5-alert-notify-design.md §2.5 resolveAction + §1 trend）：
//   1. resolveAction 全格（3 level × 3 targetState = 9 格）—— 策略层与动作层解耦的契约
//   2. metricOf 各 rule 触发指标提取（oom/other-occupancy 显存%、thermal 温度、
//      io-bottleneck GPU util、imbalance 多卡 util 差）—— trend=falling 判定的输入
//   3. metricOf 未知 rule / 无指标样本 → null（falling 判定安全回退，不误报）
// 退出：任一失败 → 非 0
// ============================================================================
import assert from 'node:assert/strict'
import { resolveAction } from '../lib/index.js'
import { metricOf } from '../lib/types/core/balancer.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (e) { fail += 1; console.log('  ✗ ' + name + ' — ' + e.message) }
}

console.log('[M1-1] resolveAction 全格（3 level × 3 targetState = 9 格）')
// off：任何目标状态 = off（不推送）
t('off × running → off', () => assert.equal(resolveAction('off', 'running'), 'off'))
t('off × idle → off', () => assert.equal(resolveAction('off', 'idle'), 'off'))
t('off × absent → off', () => assert.equal(resolveAction('off', 'absent'), 'off'))
// notice：running → inject（next-step 不唤醒）；idle → send-nq（排队不唤醒）；absent → 升根
t('notice × running → inject', () => assert.equal(resolveAction('notice', 'running'), 'inject'))
t('notice × idle → send-nq', () => assert.equal(resolveAction('notice', 'idle'), 'send-nq'))
t('notice × absent → escalate-root', () => assert.equal(resolveAction('notice', 'absent'), 'escalate-root'))
// wake：running → steer（next-step 唤醒）；idle → followup（唤醒新回合）；absent → 升根
t('wake × running → steer', () => assert.equal(resolveAction('wake', 'running'), 'steer'))
t('wake × idle → followup', () => assert.equal(resolveAction('wake', 'idle'), 'followup'))
t('wake × absent → escalate-root', () => assert.equal(resolveAction('wake', 'absent'), 'escalate-root'))

// 语义红线（设计 §2.5 I2）：steer 对 idle 会启动新回合，故「不唤醒」绝不用 steer
t('语义红线：notice×idle 是 send-nq 而非 steer（不唤醒）', () => assert.notEqual(resolveAction('notice', 'idle'), 'steer'))
t('语义红线：wake×idle 用 followup 而非 steer（idle 用 followup 唤醒）', () => assert.equal(resolveAction('wake', 'idle'), 'followup'))

console.log('[M1-2] metricOf 各 rule 触发指标提取（trend=falling 的输入）')
// 构造样本：显存 80%、温度 90°C、GPU util 20%、双卡 90/30
const mk = (opts) => ({
  ts: 0, gpuState: 'ok',
  gpu: [{
    id: 0, utilPct: opts?.utilPct ?? 0, memUsedMiB: opts?.memUsedMiB ?? 0,
    memTotalMiB: opts?.memTotalMiB ?? 0, tempC: opts?.tempC,
  }, ...(opts?.second ? [{ id: 1, utilPct: opts.second, memUsedMiB: 0, memTotalMiB: 0 }] : [])],
  cpuPct: null, cores: null, memUsedMiB: null, memTotalMiB: null, procs: [],
})
// oom / other-occupancy → 显存利用率 %
const memMetric = metricOf('oom')
t('oom 显存利用率 %（80/100 → 80）', () => assert.equal(memMetric(mk({ memUsedMiB: 80, memTotalMiB: 100 })), 80))
t('other-occupancy 复用显存利用率', () => assert.equal(metricOf('other-occupancy')(mk({ memUsedMiB: 95, memTotalMiB: 100 })), 95))
// thermal → 温度
t('thermal 温度（90°C → 90）', () => assert.equal(metricOf('thermal')(mk({ tempC: 90 })), 90))
// io-bottleneck → GPU util
t('io-bottleneck GPU util（20% → 20）', () => assert.equal(metricOf('io-bottleneck')(mk({ utilPct: 20 })), 20))
// imbalance → 多卡 util 差
t('imbalance 多卡 util 差（90-30=60）', () => assert.equal(metricOf('imbalance')(mk({ utilPct: 90, second: 30 })), 60))
// 保守回退：无指标样本 → null（falling 判定安全回退为不误判）
t('oom 无显存总量 → null', () => assert.equal(metricOf('oom')(mk({ memUsedMiB: 10, memTotalMiB: 0 })), null))
t('unknown rule → null（不误报）', () => assert.equal(metricOf('nonexistent')(mk({})) , null))
t('thermal 无温度 → null', () => assert.equal(metricOf('thermal')(mk({})), null))

console.log(`\n==== verify-m1: ${pass} 通过 / ${fail} 失败 ====`)
if (fail > 0) process.exit(1)
