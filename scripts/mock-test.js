// ============================================================================
// Lab Monitor Client 半 mock 测试（零依赖，node 直跑）
// ============================================================================
// 验证：① 插件对象形态（name/inject/apply）② apply 顶部无条件首帧拉取
//       ③ slots 注册形态 ④ labelThunk 摘要格式 ⑤ MonitorPanel 渲染树
//       ⑥ 轮询节流（5s）与 T2-3 失败退避（5s→10s→30s，成功复位）
//       （V2：mock fetch 替代 host.call；import lib/types/client.js）
// 运行：node scripts/mock-test.js
// ============================================================================
'use strict'
import * as client from '../lib/types/client.js'
import React from 'react'

// ── hook 补丁（仅测试进程）：组件直接调用（非 ReactDOM 渲染）时 useState/useEffect 走 mock 容器 ──
let __hookState = []
let __hookIdx = 0
let __effectQueue = []
React.useState = function (init) {
  if (__hookIdx >= __hookState.length) __hookState.push(typeof init === 'function' ? init() : init)
  const i = __hookIdx
  __hookIdx += 1
  return [__hookState[i], (v) => { __hookState[i] = v }]
}
React.useEffect = function (fn, deps) { __effectQueue.push({ fn, deps }) }
function __resetHooks() { __hookState = []; __hookIdx = 0; __effectQueue = [] }
function __effectQueueRef() { return __effectQueue }

let failures = 0
function assert(cond, name, extra) {
  if (cond) { console.log('  ✓', name) }
  else { failures += 1; console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

// ---------------------------------------------------------------------------
// mock host（host.call 计数 + 可切换成功/失败）
// ---------------------------------------------------------------------------
const SAMPLE_SNAPSHOT = {
  ts: 1787030000000,
  platform: 'wsl',
  sources: { gpu: 'dmon', cpu: 'cim', mem: 'cim', procs: 'tasklist' },
  gpu: [
    { id: 0, name: 'NVIDIA GeForce RTX 5060 Ti', utilPct: 92, memUsedMiB: 19200,
      memTotalMiB: 24576, tempC: 78, powerW: 350, degraded: false },
    { id: 1, name: 'NVIDIA GeForce RTX 5060 Ti', utilPct: 12, memUsedMiB: 512,
      memTotalMiB: 24576, tempC: 45, powerW: 40, degraded: false },
  ],
  gpuState: 'ok',
  cpu: { percent: 340, cores: 8 },
  mem: { totalMiB: 14310, availableMiB: 6297 },
  procs: [{ pid: 1234, cmd: 'python train_demo.py', gpu: 0 }],
  alerts: [{ level: 'critical', rule: 'oom', msg: '显存余量 <10%', confidence: 0.9,
             actions: ['降 batch size'], ts: 1787030005000, runId: null }],
  alertsCriticalCount: 1,
  experiment: { runId: 'run-20260818-001', state: 'running', cmd: 'python train_demo.py',
                pid: 1234, startTs: 1787030000000, summary: null },
  callCount: 42,
  ui: { betterSidebarVisible: true },
}

let hostCallCount = 0
let hostFails = false
let hostLastArgs = null             // D-B2：最近一次 snapshot 调用 body（阈值携带断言）
let hostSnapOverride = null         // D-B2：快照覆盖（驱动模块级 last 断言 badge/可见性）
let historyCalls = 0                // P2：history 调用计数（历史曲线）
const HOST_HISTORY = { points: [{ ts: 1, gpuUtil: 10 }, { ts: 2, gpuUtil: 20 }, { ts: 3, gpuUtil: 40 }], truncated: false }
// mock fetch：POST /lab-monitor/api/<method> → JSON；记录请求体
globalThis.fetch = async (url, opts) => {
  const u = String(url)
  hostCallCount += 1
  const method = u.split('/').pop()
  let body = null
  try { body = opts && opts.body ? JSON.parse(opts.body) : null } catch (e) { body = null }
  if (method === 'snapshot') hostLastArgs = body
  if (hostFails) throw new Error('mock host down')
  if (method === 'history') { historyCalls += 1; return { ok: true, json: async () => HOST_HISTORY } }
  return { ok: true, json: async () => (hostSnapOverride || SAMPLE_SNAPSHOT) }
}

// ---------------------------------------------------------------------------
// mock ctx / slots
// ---------------------------------------------------------------------------
let intervals = []            // { cb, delay, disposed }
let registered = null         // slots.register 记录
let effects = []              // ctx.effect 记录
const slots = {
  register(options, component) {
    registered = { options, component }
    return () => { registered = null }
  },
}
const ctx = {
  setInterval(cb, delay) {
    const rec = { cb, delay, disposed: false }
    intervals.push(rec)
    return () => { rec.disposed = true }
  },
  setTimeout(fn, ms) { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
  get(name) { return name === 'slots' ? slots : undefined },
  effect(fn) {
    const r = fn()
    effects.push(r)
    return r
  },
}

// ---------------------------------------------------------------------------
// 插件对象（V2：import lib/types/client.js）
// ---------------------------------------------------------------------------
const plugin = { name: client.name, inject: client.inject, apply: client.apply }
console.log('[1] 插件对象形态')
assert(plugin && typeof plugin === 'object', '返回对象形态（可声明 inject）')
assert(plugin.name === 'lab-monitor', 'name = lab-monitor', plugin.name)
assert(Array.isArray(plugin.inject) && plugin.inject.join() === 'timer', 'inject 仅含 timer', plugin.inject)
assert(typeof plugin.apply === 'function', 'apply 为函数')

// ---------------------------------------------------------------------------
console.log('[2] apply 顶部无条件执行：首帧拉取 + slots 注册')
plugin.apply(ctx)
assert(hostCallCount >= 1, 'apply 即触发首帧 host.call', hostCallCount)
assert(registered !== null, 'slots.register 被调用')
assert(registered.options.name === 'conversation.view', 'slot name = conversation.view', registered.options.name)
assert(registered.options.id === 'lab-monitor', 'slot id = lab-monitor', registered.options.id)
assert(registered.options.order === 20, 'order = 20', registered.options.order)
assert(typeof registered.options.label === 'function', 'label 为 thunk')
assert(typeof registered.component === 'function', '组件为函数')

// 等待首帧异步 refresh 完成
setTimeout(async () => {
  // -------------------------------------------------------------------------
  console.log('[3] labelThunk 摘要格式（lab-protocol/1.1 样例快照）')
  const label = registered.options.label()
  console.log('  label =', JSON.stringify(label))
  assert(typeof label === 'string' && label.length > 0, 'label 返回非空字符串')
  assert(label.includes('GPU0 92'), '含 GPU0 利用率', label)
  assert(label.includes('18.8/24'), '含显存占用', label)
  assert(label.includes('1告警'), '含告警计数', label)

  // -------------------------------------------------------------------------
  console.log('[4] MonitorPanel 渲染树（createElement 树结构）')
  __resetHooks()
  const tree = registered.component()
  assert(tree && tree.type === 'div', '根节点为 div', tree && tree.type)
  // 执行组件挂载副作用（模拟 React 提交阶段），取得 cleanup
  const mountCleanup = __effectQueueRef().length ? __effectQueueRef()[__effectQueueRef().length - 1].fn() : null
  assert(typeof mountCleanup === 'function', '组件 useEffect 返回 cleanup（卸载即停）')
  const texts = []
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (typeof n === 'string') { texts.push(n); return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n === 'object') walk(n.props && n.props.children)
  }
  walk(tree.props.children)
  const joined = texts.join(' ')
  assert(joined.includes('NVIDIA GeForce RTX 5060 Ti GPU0'), 'GPU0 卡渲染（名称）', joined.slice(0, 80))
  assert(joined.includes('92%'), 'GPU0 利用率 92%', joined)
  assert(joined.includes('显存 18.8/24'), 'GPU0 显存', joined)
  assert(joined.includes('78°C') && joined.includes('350W'), 'GPU0 温度/功耗', joined)
  assert(joined.includes('CPU') && joined.includes('340%'), 'CPU 卡', joined)
  assert(joined.includes('内存') && joined.includes('7.8/14'), '内存卡', joined)
  assert(joined.includes('python train_demo.py') && joined.includes('1234'), '进程表', joined)
  assert(joined.includes('CRITICAL') && joined.includes('显存余量 <10%'), '告警列表', joined)
  assert(joined.includes('降 batch size'), '告警建议动作', joined)
  assert(joined.includes('run-20260818-001') && joined.includes('running'), '实验状态行', joined)
  assert(joined.includes('[wsl·dmon]'), 'platform/sources 标注', joined)

  // -------------------------------------------------------------------------
  console.log('[5] 轮询节流与 T2-3 失败退避')
  // 组件挂载副作用已执行（[4] 中 mountCleanup）——调度器已注册首个 interval。
  // 验证 ctx.setInterval 的 delay 序列（成功路径恒为 5s）：
  const delays = intervals.map((i) => i.delay)
  console.log('  interval delays =', JSON.stringify(delays))
  assert(delays.length >= 1, '至少注册一次轮询 interval')
  assert(delays.every((d) => d === 5000), '成功路径间隔恒为 5s', delays)

  // 失败 → 退避升级：模拟 host 失败 + 触发一次 tick
  const before = hostCallCount
  hostFails = true
  const lastRec = intervals[intervals.length - 1]
  await lastRec.cb()                       // tick → refresh 失败 → schedule 用退避档
  const d2 = intervals[intervals.length - 1].delay
  assert(d2 === 10000, '首次失败退避 10s', d2)
  await intervals[intervals.length - 1].cb()
  const d3 = intervals[intervals.length - 1].delay
  assert(d3 === 30000, '二次失败退避 30s（封顶）', d3)
  // 恢复：host 成功 → 间隔回 5s
  hostFails = false
  await intervals[intervals.length - 1].cb()
  const d4 = intervals[intervals.length - 1].delay
  assert(d4 === 5000, '恢复后间隔复位 5s', d4)
  const failCalls = hostCallCount - before
  assert(failCalls === 6, '退避期间调用次数符合节奏（2 失败 + 1 恢复；每 tick=snapshot+history）', failCalls)

  // -------------------------------------------------------------------------
  console.log('[6] 组件卸载即停（零渲染口径）')
  mountCleanup()                            // 模拟组件卸载 → cleanup 清全部 interval
  const aliveIntervals = intervals.filter((i) => !i.disposed)
  assert(aliveIntervals.length === 0, '卸载后全部 interval 已 dispose（零渲染轮询）', aliveIntervals.length)

  // -------------------------------------------------------------------------
  console.log('[7] slots 缺席 → 跳过出口（核心独立兜底）')
  const ctxNoSlots = {
    setInterval: ctx.setInterval,
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
    get(name) { return undefined },
    effect(fn) { return fn() },
  }
  const intervalsBefore = intervals.length
  plugin.apply(ctxNoSlots)
  assert(hostCallCount > 0, 'slots 缺席时 apply 仍执行首帧拉取')
  assert(intervals.length === intervalsBefore, 'slots 缺席不注册轮询（无 UI）')

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  console.log('[8] D-B2 better-sidebar 适配器：双检查 + 切换 ③ 替代 ②（docs/05 §3）')
  // 新 mock ctx：slots + better-sidebar 服务（features 含 badge/pluginSettings）
  let registered3 = null
  let disposed2 = false
  let slots3 = { register(options, component) { return () => { disposed2 = true } } }
  let bs = {
    features: ['badge', 'pluginSettings'],
    registerTab(desc) { registered3 = desc; return () => {} },
  }
  let intervalsD2 = []
  let ctxD2 = {
    get(name) {
      if (name === 'slots') return slots3
      if (name === 'betterSidebar') return bs
      return undefined
    },
    setInterval(cb, delay) { const rec = { cb, delay, disposed: false }; intervalsD2.push(rec); return () => { rec.disposed = true } },
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
    effect(fn) { const r = fn(); return r || (() => {}) },
  }
  plugin.apply(ctxD2)
  assert(registered3 !== null, '③ registerTab 已被调用（better-sidebar 可用）', registered3)
  assert(registered3 && registered3.id === 'lab-monitor:gpu', '③ tab id = lab-monitor:gpu', registered3 && registered3.id)
  assert(registered3 && typeof registered3.badge === 'function', '③ badge thunk（features 门控）', typeof (registered3 && registered3.badge))
  assert(registered3 && registered3.settings && Array.isArray(registered3.settings.pluginToggles) && registered3.settings.pluginToggles.length === 4, '③ pluginToggles 4 行阈值面板', registered3 && registered3.settings && registered3.settings.pluginToggles && registered3.settings.pluginToggles.length)
  assert(registered3 && typeof registered3.component === 'function', '③ component（visible 语义）')
  assert(disposed2 === true, '③ 注册成功 → 注销 ②（互斥，③ 替代 ②）')

  // -------------------------------------------------------------------------
  console.log('[9] D-B2 visible=false 低频保活（30s）+ 阈值携带 + badge 断言')
  // 模拟 store（pluginToggles 读源，M3 阈值同步面）
  const fakeStore = {
    getSnapshot() {
      return { prefs: { pluginSettings: { 'lab-monitor:gpu': { utilWarn: 77, memWarn: 80, pollMs: 2000 } } } }
    },
  }
  __resetHooks()
  const wrapper2 = registered3.component({ visible: false, store: fakeStore })  // hidden
  assert(wrapper2 && typeof wrapper2.type === 'function', '③ 组件包装（MonitorPanel）', wrapper2 && wrapper2.type && wrapper2.type.name)
  const inner2 = wrapper2.type(props2(wrapper2))                                  // 内部面板渲染
  function props2(w) { return w.props }
  assert(inner2 && inner2.type === 'div', '③ 面板渲染树为 div（hidden 仍渲染）', inner2 && inner2.type)
  const mount2 = __effectQueueRef().length ? __effectQueueRef()[__effectQueueRef().length - 1].fn() : null
  assert(typeof mount2 === 'function', '③ 组件 useEffect cleanup')
  // 首帧新快照 → schedule → 隐藏用 30s 保活
  await new Promise((r) => setTimeout(r, 30))
  let aliveIv = intervalsD2.filter((i) => !i.disposed)
  const keepDelay = aliveIv.length ? aliveIv[aliveIv.length - 1].delay : null
  assert(keepDelay === 30000, 'visible=false → 30s 低频保活（badge 仍更新）', keepDelay)
  // 驱动 tick：读取 store pluginToggles → 携带 thresholds + 更新 last
  const driveLast = async (snap) => {
    hostSnapOverride = Object.assign({}, SAMPLE_SNAPSHOT, snap)
    hostFails = false
    const av = intervalsD2.filter((i) => !i.disposed)
    if (av.length) { try { await av[av.length - 1].cb() } catch (e) {} }
  }
  await driveLast({ alertsCriticalCount: 5 })
  assert(hostLastArgs && hostLastArgs.thresholds && hostLastArgs.thresholds.utilWarn === 77, '阈值随轮询携带（utilWarn=77）', hostLastArgs && hostLastArgs.thresholds)
  assert(historyCalls > 0, '轮询随附 labMonitor.history（P2 历史曲线数据流）', historyCalls)
  assert(registered3.badge() === 5, 'badge = CRITICAL 计数 5', registered3 && registered3.badge && registered3.badge())
  await driveLast({ alertsCriticalCount: 150 })
  assert(registered3.badge() === 99, 'badge 150 → 99 封顶', registered3.badge())
  await driveLast({ alertsCriticalCount: 0 })
  assert(registered3.badge() === null, 'badge 0 → null（隐藏）')
  if (mount2) mount2()

  // -------------------------------------------------------------------------
  console.log('[10] D-B2 双检查：ui.betterSidebarVisible=false → 保持 ②（不切 ③）')
  let registered4 = null
  let disposed4 = false
  // 先重建一个轮询组件（[9] 已卸载清空 interval），用覆盖快照驱动 last=hidden
  __resetHooks()
  const w3 = registered3.component({ visible: true, store: null })
  const inner3 = w3.type(w3.props)
  const mount3 = __effectQueueRef().length ? __effectQueueRef()[__effectQueueRef().length - 1].fn() : null
  await new Promise((r) => setTimeout(r, 20))
  hostSnapOverride = Object.assign({}, SAMPLE_SNAPSHOT, { ui: { betterSidebarVisible: false } })
  const av3 = intervalsD2.filter((i) => !i.disposed)
  if (av3.length) { try { await av3[av3.length - 1].cb() } catch (e) {} }   // last=hidden
  if (mount3) mount3()
  let bs2 = { features: ['badge'], registerTab(dsc) { registered4 = dsc; return () => {} } }
  const ctxD3 = {
    get(name) { if (name === 'slots') return { register() { return () => { disposed4 = true } } }; if (name === 'betterSidebar') return bs2; return undefined },
    setInterval(cb, delay) { const rec = { cb, delay, disposed: false }; intervalsD2.push(rec); return () => { rec.disposed = true } },
    setTimeout() { return () => {} },
    effect(fn) { const r = fn(); return r || (() => {}) },
  }
  plugin.apply(ctxD3)
  assert(registered4 === null, '可见性标志 false → registerTab 未被调用（保持 ②）', registered4)
  assert(disposed4 === false, '② 未被注销（互斥降级：aionui-panel 场景保持 conversation.view）')
  hostSnapOverride = null

  console.log('\n==== 结果:', failures === 0 ? 'ALL PASS' : failures + ' FAILED', '====')
  process.exit(failures === 0 ? 0 : 1)
}, 50)
