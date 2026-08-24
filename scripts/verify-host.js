#!/usr/bin/env node
// ============================================================================
// verify-host.js —— Host 半核心引擎逻辑自测（D-A/D-C/D-D CI 式回归，零真实采样）
// 运行：node scripts/verify-host.js
// 说明：
//   - V2：直接 import lib/types/index.js（tsc 编译产物，与 src/index.ts 等价）
//   - mock cordis ctx（fake shell/timer/systemPrompt/settings/webServer/tools）+ 虚拟时钟
//   - 断言 P0（HTTP 快照/兜底数据面）、P1（生命周期/状态机/结果配对）、P2（告警/阈值）、
//     工具、prompt 注入、ui.betterSidebarVisible 探测
//   - 真实采样通道由 scripts/verify-sampler.js 另行覆盖（本测试保持确定性、快速）
// ============================================================================
'use strict'
import { apply, name, inject } from '../lib/types/index.js'

let failures = 0
function assert(cond, name, extra) {
  if (cond) { console.log('  ✓', name) }
  else { failures += 1; console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

// ── 虚拟时钟（host 内 Date.now 依赖，驱动 ps 5s 周期确定性） ──────────────
let VIRT = Date.now()
const REAL_DATE_NOW = Date.now
Date.now = () => VIRT
function advance(ms) { VIRT += ms }

// ── 可变的 fake 采样数据 ───────────────────────────────────────────────────
const FAKE = {
  version: 'Linux version 6.6.87.2-microsoft-standard-WSL2',
  // V2 QUERY_ARGS 格式：index,name,utilization.gpu(%),memory.used(MiB),memory.total(MiB),temperature.gpu(C),power.draw(W)
  gpuCsv: '0, NVIDIA GeForce RTX 5060 Ti, 92, 19200, 24576, 80, 350.00',
  // CIM：首行 cpuLoad;totalKB;freeKB + 每进程 pid;ppid;name（1.2 进程树）
  cimLine: '92;30480;12560\n1234;1;python.exe\n5678;1234;python.exe\n9999;1;chrome.exe',
  tasklist: '"python.exe","1234","Console","1","12,345 K"\n"python.exe","5678","Console","1","8,000 K"\n"chrome.exe","9999","Console","1","20,000 K"',
  pmon: '', // 1.2：pmon -c 3 输出（空 = 无活动进程，gpuUtilPct 不填）
  // 状态机进程表（实验进程视角；1.2 格式 pid ppid pcpu rssKB args；含非实验进程供 system 差集）
  psLines: ['8888 1 0.5 300000 node server.js', '7777 1 0.2 200000 /usr/lib/firefox/firefox'],
  aionui: undefined, // { rightPanel: 'aionui-panel' } 触发互斥
}

function fakeShellResult(text, code) {
  return { exitCode: code !== undefined ? code : 0, stdout: { text: text || '', truncated: false }, stderr: { text: '', truncated: false } }
}

// ── mock cordis ctx / services ─────────────────────────────────────────────
function makeCtx() {
  const intervals = []
  const timeouts = []
  const events = {}       // name -> [listener]
  const teardowns = []
  const promptState = { variables: {}, sections: [] }
  // 2026-08-20（P2 2'）：内存 settings 服务——支持 register/update/watch（持久化断言）
  // documents = 磁盘文档（跨「DSH 重启」保留的用户层）；namespaces = 本进程注册表。
  // register 读取 documents 初始化 user；update 双向写（reg.user + documents）。
  const settingsMock = {
    available: true, // M4 重探测试：false → ctx.get('settings') 返回 undefined（服务未就绪）
    documents: {}, // ns -> user 层（模拟 DSH settings 的磁盘持久化文档）
    namespaces: {}, // ns -> { schema, user, resolved }
    get(ns) {
      if (ns === 'aionui-panel') return FAKE.aionui
      const reg = this.namespaces[ns]
      return reg ? reg.resolved : undefined
    },
    on(name, fn) { (events[name] = events[name] || []).push(fn); return () => {} },
    register(ns, schema, opts) {
      if (this.namespaces[ns]) throw new Error('settings namespace "' + ns + '" is already registered')
      const user = this.documents[ns] !== undefined ? this.documents[ns] : undefined
      // schema 是 callable（schemastery Schema 实例）：schema(mergeLayers(base, section))
      const reg = { schema, user, resolved: schema(user) }
      this.namespaces[ns] = reg
      return {
        get: () => reg.resolved,
        watch: (cb) => { reg.watchCb = cb; return () => { reg.watchCb = null } },
        update: (patch) => {
          reg.user = { ...(reg.user || {}), ...patch }
          reg.resolved = schema(reg.user)
          this.documents[ns] = { ...reg.user }
          if (reg.watchCb) reg.watchCb(reg.resolved, undefined)
          return reg.resolved
        },
      }
    },
  }
  const promptService = {
    variable(name, provider) { promptState.variables[name] = provider; return () => {} },
    section(s) { promptState.sections.push(s); return () => {} },
  }
  const shell = {
    // v1.4.2：真实 shell 服务要求先 resolve() 再 run/start（dsh-bash-sandbox 契约），
    // 假 shell 同步补上：填充 command/workdir/timeoutMs/sandboxPolicy
    resolve(request) {
      return {
        command: request.command,
        workdir: request.workdir || '/tmp',
        timeoutMs: request.timeoutMs || 15000,
        stdoutMaxBytes: 65536,
        sandboxPolicy: { mode: 'danger-full-access' },
      }
    },
    async run(request) {
      const cmd = request.command || ''
      if (cmd.includes('pmon')) return fakeShellResult(FAKE.pmon + '\r')
      if (cmd.includes('nvidia-smi') && cmd.includes('driver_version')) return fakeShellResult('596.49, 1\r')
      if (cmd.includes('nvidia-smi')) return fakeShellResult(FAKE.gpuCsv + '\r')
      if (cmd.includes('powershell') && cmd.includes('chcp')) return fakeShellResult(FAKE.cimLine)
      if (cmd.includes('tasklist')) return fakeShellResult(FAKE.tasklist + '\n')
      if (cmd.includes('/proc/version')) return fakeShellResult(FAKE.version)
      if (cmd.includes('/proc/meminfo')) return fakeShellResult('MemTotal: 14310572 kB\nMemAvailable: 6448384 kB\nMemFree: 5000000 kB')
      if (cmd.includes('/proc/stat')) return fakeShellResult('cpu  100 0 100 100000 0 0 0 0 0 0')
      if (cmd.includes('ps -eo')) return fakeShellResult(FAKE.psLines.join('\n'))
      return { exitCode: 127, stdout: { text: '', truncated: false }, stderr: { text: 'cannot match: ' + cmd.slice(0, 60), truncated: false } }
    },
    start() {
      // 模拟真实 dmon 流：前 2 次读有行，之后 EOF（断流 → 后端指数退避重启 → query-fallback）
      const handle = { exitCode: null, reads: 0 }
      handle.readOutput = () => {
        handle.reads += 1
        if (handle.exitCode === null && handle.reads <= 2) {
          return { delta: '# gpu  pwr gtemp mtemp sm  mem enc dec  clocks\n  0  350   80    -   92   30    -    -  2100    -\n', lossy: false }
        }
        handle.exitCode = -1 // EOF → done() 真 → 后端走退避重启
        return { delta: '', lossy: false }
      }
      handle.kill = () => { handle.exitCode = -1; return true }
      return handle
    },
  }
  const ctx = {
    shell,
    get(name) {
      // 2026-08-20（M4 重探测试）：settingsAvailable=false 模拟 settings 服务晚于 apply 就绪
      if (name === 'settings') return settingsMock.available === false ? undefined : settingsMock
      if (name === 'systemPrompt') return promptService
      return undefined
    },
    on(name, fn) {
      ;(events[name] = events[name] || []).push(fn)
      return () => { const arr = events[name]; if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1) } }
    },
    interval(fn, ms) { const rec = { fn, ms, disposed: false }; intervals.push(rec); return () => { rec.disposed = true } },
    timeout(fn, ms) { const t = setTimeout(fn, ms); timeouts.push(t); return () => { clearTimeout(t) } },
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); timeouts.push(t); return () => { clearTimeout(t) } },
    effect(fn, label) { const d = fn() || (() => {}); teardowns.push(d); return d },
  }
  return { ctx, intervals, events, teardowns, promptState, timeouts, settingsMock, promptService }
}

// ── V2：mock webServer + tools 服务（替代动态版 harness） ──────────────────
// webServer 捕获 HTTP 路由；tools 捕获 defineTool 注册（工具断言）
function makeHarness(ctxObj, settingsMock, promptService) {
  const toolDefs = [] // defineTool 原始定义（execute/render 可调）
  const registered = [] // register 入参
  const httpRoutes = [] // { path, handler }
  const webServer = {
    register(route) {
      httpRoutes.push(route)
      return () => {}
    },
  }
  const tools = {
    register(def) { registered.push(def); toolDefs.push(def); return () => {} },
  }
  // 注入 ctx 属性（V2：inject 声明后 cordis 挂属性；mock 直接赋值）
  ctxObj.webServer = webServer
  ctxObj.tools = tools
  return { toolDefs, registered, httpRoutes }
}

// ── 启动（V2：import 产物直接 apply） ──────────────────────────────────────
const ctxd = makeCtx()
const H = makeHarness(ctxd.ctx, ctxd.settingsMock, ctxd.promptService)
const C = ctxd
const plugin = { name, inject, apply }

/** HTTP 数据面模拟：POST /lab-monitor/api/<method>，body JSON，返回解析结果。 */
function callApi(hh, method, body) {
  const route = hh.httpRoutes.find((r) => (r.path || '').indexOf('/lab-monitor/api') === 0)
  if (!route) return undefined
  return (payload) => {
    const res = {
      writeHead(code, headers) { this._code = code; this._headers = headers; return this },
      end(data) { this._body = data; return this },
    }
    const req = {
      url: route.path + '/' + method,
      _dataFns: [], _endFns: [], _errFns: [],
      on(type, fn) {
        if (type === 'data') this._dataFns.push(fn)
        if (type === 'end') this._endFns.push(fn)
        if (type === 'error') this._errFns.push(fn)
      },
    }
    route.handler(req, res) // 同步注册 data/end 监听（httpHandler 实现）
    const payloadStr = payload ? JSON.stringify(payload) : '{}'
    for (const fn of req._dataFns) fn(payloadStr)
    for (const fn of req._endFns) fn()
    if (res._body !== undefined) return JSON.parse(res._body)
    return { ok: false, error: 'no response body' }
  }
}
function G(method) {
  return callApi(H, method)
}

plugin.apply(C.ctx, {})

// ── 断言工具 ───────────────────────────────────────────────────────────────
async function tick(n) {
  for (let i = 0; i < (n || 1); i++) {
    advance(2000)
    const iv = C.intervals[0]
    if (iv && !iv.disposed) { try { await iv.fn() } catch (e) { console.error('tick 错误:', e) } }

  }
}

assert(G('snapshot') && G('history') && G('setThresholds') && G('control'), '4 个 harness.handle 已注册')
assert(H.registered.some((t) => t.name === 'lab_status'), '工具 lab_status 已注册')
assert(H.registered.some((t) => t.name === 'lab_advice'), '工具 lab_advice 已注册')
assert(H.registered.some((t) => t.name === 'lab_ctl'), '工具 lab_ctl 已注册')
assert(!C.promptState.variables.labstatus, 'prompt 注入默认关闭（KV 缓存友好，promptInjection=false）')
assert(!C.promptState.sections.some((s) => s.name === 'lab-monitor:status'), 'prompt section 未注入（默认关）')
assert(Array.isArray(C.events['tools/pre-execute']) && C.events['tools/pre-execute'].length >= 1, 'hooks: tools/pre-execute 已监听')
assert(Array.isArray(C.events['tools/result']) && C.events['tools/result'].length >= 1, 'hooks: tools/result 已监听')

// 等后端就绪（WindowsBackend 探测 + snapshot 一次）
;(async () => {
  await new Promise((r) => setTimeout(r, 200))
  await tick(1)
  await new Promise((r) => setTimeout(r, 200))
  await tick(1) // 首 tick：建 ring + snapshot
  await new Promise((r) => setTimeout(r, 200))
  await tick(1) // 兜底：确保 lastSnap 已填充
  await new Promise((r) => setTimeout(r, 50))

  console.log('\n[A2] RPC snapshot 数据面（lab-protocol/1.1）')
  let snap = await G('snapshot')({})
  assert(snap && typeof snap === 'object', 'snapshot 返回对象')
  assert(snap.platform === 'wsl', 'platform=wsl（fake /proc/version）', snap.platform)
  assert(snap.sources && snap.sources.gpu === 'query', 'sources.gpu=query', snap.sources)
  assert(Array.isArray(snap.gpu) && snap.gpu.length === 1 && snap.gpu[0].utilPct === 92, 'gpu[0].utilPct=92', snap.gpu && snap.gpu[0])
  assert(snap.gpu[0].memUsedMiB === 19200 && snap.gpu[0].memTotalMiB === 24576, '显存 19200/24576 MiB', snap.gpu[0])
  assert(snap.cpu && typeof snap.cpu.percent === 'number', 'cpu.percent 存在', snap.cpu)
  assert(snap.mem && snap.mem.totalMiB === 30, 'mem.totalMiB=30（30480KB/1024 → round）', snap.mem)
  assert(snap.gpuState === 'ok', 'gpuState=ok', snap.gpuState)
  assert(snap.experiment === null, '无实验时 experiment=null', snap.experiment)
  assert(snap.alertsCriticalCount === 0, 'alertsCriticalCount=0', snap.alertsCriticalCount)
  assert(snap.callCount === 1, 'callCount=1（T4-2 断言手段）', snap.callCount)
  assert(snap.ui && snap.ui.betterSidebarVisible === true, 'ui.betterSidebarVisible=true（无互斥）', snap.ui)
  assert(snap.procs && snap.procs.length >= 1, 'procs 来自 tasklist', snap.procs.length)
  assert(snap.system && Array.isArray(snap.system.topN), '1.2 system 存在（无实验时 topN 数组）', snap.system)
  assert(snap.system && snap.system.topN.some((p) => p.pid === 8888), 'system.topN 含 node(8888)（非实验进程明细）', snap.system && snap.system.topN)
  // 2026-08-22（P1）：实验历史/阈值/启停协议字段透出
  assert(Array.isArray(snap.ended) && snap.ended.length === 0, 'P1 协议：ended[] 存在且初始为空', snap.ended && snap.ended.length)
  assert(snap.thresholds && ['utilWarn', 'memWarn', 'tempWarn', 'pollMs'].every((k) => typeof snap.thresholds[k] === 'number'),
    'P1 协议：thresholds{utilWarn,memWarn,tempWarn,pollMs} 数字透出', snap.thresholds)
  assert(snap.enabled === true, 'P1 协议：enabled=true（默认运行）', snap.enabled)
  const wPpid = snap.procs.find((p) => p.pid === 1234)
  assert(wPpid && wPpid.ppid === 1, 'procs[].ppid 合并（CIM 进程树）', wPpid)

  console.log('\n[B] 生命周期：pre-execute → running → pid 关联 → done（T1-1/T1-2）')
  const pre = C.events['tools/pre-execute'][0]
  await pre({ name: 'bash', arguments: { command: 'python train_demo.py --epochs 10' } }, async () => ({ kind: 'allow' }))
  snap = await G('snapshot')({})
  assert(snap.experiment && snap.experiment.state === 'running', '训练命令命中 → running', snap.experiment)
  assert(snap.experiment.cmd === 'python train_demo.py --epochs 10', 'experiment.cmd 记录', snap.experiment.cmd)

  // pid 关联：ps 出现候选进程（1.2：5 列 pid ppid pcpu rssKB args）
  FAKE.psLines = ['1234 1 55.0 12000 python train_demo.py --epochs 10', '8888 1 0.5 300000 node server.js', '7777 1 0.2 200000 /usr/lib/firefox/firefox']
  await tick(3) // 15s 虚拟 → ps 周期触发 ≥1
  snap = await G('snapshot')({})
  assert(snap.experiment && snap.experiment.pid === 1234, 'ps 关联回填 pid=1234', snap.experiment && snap.experiment.pid)
  assert(snap.experiment && Array.isArray(snap.experiment.procGroup) && snap.experiment.procGroup.includes(1234), 'procGroup 含主进程 1234', snap.experiment && snap.experiment.procGroup)

  // 1.2 进程组扩张：子进程（ppid=主）→ procGroup + groupStats（B2/B3；聚合输入 = ps 表同源）
  FAKE.psLines = ['1234 1 55.0 12000 python train_demo.py --epochs 10', '5678 1234 30.0 8000 python train_demo.py --epochs 10', '8888 1 0.5 300000 node server.js', '7777 1 0.2 200000 /usr/lib/firefox/firefox']
  await tick(3) // 下一个 ps 周期 → 组扩张
  snap = await G('snapshot')({})
  assert(snap.experiment && Array.isArray(snap.experiment.procGroup) && snap.experiment.procGroup.includes(5678), 'procGroup 含子进程 5678（ppid 递归扩张）', snap.experiment && snap.experiment.procGroup)
  assert(snap.experiment && snap.experiment.groupStats && snap.experiment.groupStats.memberCount === 2, 'groupStats.memberCount=2（ps 主+子）', snap.experiment && snap.experiment.groupStats)
  assert(snap.experiment && snap.experiment.groupStats && snap.experiment.groupStats.cpuPct === 85, 'groupStats.cpuPct=85（55+30 求和）', snap.experiment && snap.experiment.groupStats && snap.experiment.groupStats.cpuPct)
  assert(snap.experiment && snap.experiment.groupStats && snap.experiment.groupStats.members.every((m) => m.pid !== 8888), 'groupStats.members 不含非实验进程(8888)', snap.experiment && snap.experiment.groupStats && snap.experiment.groupStats.members)
  assert(snap.system && snap.system.topN.some((p) => p.pid === 8888), 'system.topN 含 node(8888)', snap.system && snap.system.topN)
  assert(snap.system && snap.system.topN.every((p) => p.pid !== 1234 && p.pid !== 5678), 'system.topN 不含实验成员（pid 差集）', snap.system && snap.system.topN)

  // done 双确认：配对 result + 进程消失
  const res = C.events['tools/result'][0]
  FAKE.psLines = []
  res({ name: 'bash', arguments: { command: 'python train_demo.py --epochs 10' } }, { isError: false, content: [] })
  await tick(3) // 6s 虚拟 → 触发下一 ps 周期（5s）确认进程消失
  snap = await G('snapshot')({})
  assert(snap.experiment === null, '配对 result + 进程消失 → 实验结束（experiment=null）', snap.experiment)
  // 2026-08-22（P1）：done 归档进 ended[]
  assert(snap.ended && snap.ended.some((e) => e.state === 'done' && e.cmd.indexOf('train_demo') !== -1
    && typeof e.startTs === 'number' && typeof e.endTs === 'number'),
    'P1 ended：done 实验已归档（state=done + cmd + startTs/endTs）', snap.ended && snap.ended[0])
  assert(snap.ended && snap.ended.every((e) => 'runId' in e && 'cmdFeature' in e && 'summary' in e),
    'P1 ended：每条含 runId/cmdFeature/summary 字段（协议完整性）', snap.ended && snap.ended[0])

  console.log('\n[B2] crashed：kill 实验进程走 crashed，kill 自身 result 不误判 done')
  await pre({ name: 'bash', arguments: { command: 'python train_demo.py --epochs 10' } }, async () => ({ kind: 'allow' }))
  FAKE.psLines = ['4321 python train_demo.py --epochs 10']
  await tick(3)
  res({ name: 'bash', arguments: { command: 'kill 4321' } }, { isError: false, content: [] }) // kill 不配对 → 忽略
  FAKE.psLines = []
  await tick(3) // 6s 虚拟 → ps 周期 1：无候选（streak 1）
  await tick(3) // ps 周期 2：无候选 → crashed
  snap = await G('snapshot')({})
  assert(snap.experiment === null, 'pid 消失 ≥2 ps 周期 → crashed（experiment=null）', snap.experiment)
  assert(snap.alertsCriticalCount >= 1, 'crashed 触发 critical 告警（alertsCriticalCount>=1）', snap.alertsCriticalCount)
  assert(Array.isArray(snap.alerts) && snap.alerts.some((a) => a.rule === 'experiment-crash'), '告警列表含 experiment-crash', snap.alerts && snap.alerts[0])
  // 2026-08-22（P1）：crashed 归档进 ended[]（与 [B] done 并存，state 区分）
  assert(snap.ended && snap.ended.filter((e) => e.state === 'crashed' && e.cmd.indexOf('train_demo') !== -1).length >= 1,
    'P1 ended：crashed 实验已归档（state=crashed）', snap.ended && snap.ended.map((e) => e.state))

  console.log('\n[B3] 多轨并行（A2：并行跟踪上限 4 + 各自独立判定）')
  // 实验 A start → pid 关联 101
  await pre({ name: 'bash', arguments: { command: 'python train_a.py --epochs 5' } }, async () => ({ kind: 'allow' }))
  FAKE.psLines = ['101 1 20.0 12000 python train_a.py --epochs 5', '8888 1 0.5 300000 node server.js']
  await tick(3)
  snap = await G('snapshot')({})
  assert(snap.experiment && snap.experiment.runId, '实验 A running（主实验）', snap.experiment && snap.experiment.runId)
  const runA = snap.experiment.runId
  // 实验 B start（新命令）→ 并行，不再归档 A
  await pre({ name: 'bash', arguments: { command: 'python train_b.py --epochs 5' } }, async () => ({ kind: 'allow' }))
  FAKE.psLines = ['101 1 20.0 12000 python train_a.py --epochs 5', '102 1 15.0 10000 python train_b.py --epochs 5', '8888 1 0.5 300000 node server.js']
  await tick(3)
  snap = await G('snapshot')({})
  assert(Array.isArray(snap.experiments) && snap.experiments.length === 2, '多轨：experiments 数组含 2 个并行实验', snap.experiments && snap.experiments.length)
  assert(snap.experiment && snap.experiment.runId !== runA, '主实验切换为最近 start（实验 B）', snap.experiment && snap.experiment.runId)
  assert(snap.experiments.some((e) => e.runId === runA), 'experiments 仍含实验 A（不再 aborted）', snap.experiments && snap.experiments.map((e) => e.runId))
  const runB = snap.experiment.runId
  // 实验 B 进程消失 ≥2 ps 周期 → B crashed，A 不受影响
  FAKE.psLines = ['101 1 20.0 12000 python train_a.py --epochs 5', '8888 1 0.5 300000 node server.js']
  await tick(3) // ps 周期 1：B streak 1
  await tick(3) // ps 周期 2：B streak 2 → crashed
  snap = await G('snapshot')({})
  assert(Array.isArray(snap.experiments) && snap.experiments.length === 1 && snap.experiments[0].runId === runA,
    'B crashed 后 experiments 只剩 A（独立判定）', snap.experiments && snap.experiments.map((e) => e.runId))
  assert(snap.experiment && snap.experiment.runId === runA, '主实验回到 A', snap.experiment && snap.experiment.runId)
  // A done：配对 result + 进程消失
  FAKE.psLines = []
  res({ name: 'bash', arguments: { command: 'python train_a.py --epochs 5' } }, { isError: false, content: [] })
  await tick(3)
  snap = await G('snapshot')({})
  assert(snap.experiment === null && (!Array.isArray(snap.experiments) || snap.experiments.length === 0), 'A done → 无 running 实验', snap.experiment)
  // 2026-08-22（P1）：多轨归档——runA done + runB crashed 均进 ended（runId 精确匹配）
  assert(snap.ended && snap.ended.some((e) => e.runId === runA && e.state === 'done'),
    'P1 ended：runA done 已归档（runId 精确）', snap.ended && snap.ended.map((e) => e.runId + ':' + e.state))
  assert(snap.ended && snap.ended.some((e) => e.runId === runB && e.state === 'crashed'),
    'P1 ended：runB crashed 已归档（runId 精确）', snap.ended && snap.ended.map((e) => e.runId + ':' + e.state))
  // 上限 4：连续 start 5 个 → 最旧 aborted，保持 ≤4 并行
  const runIds5 = []
  const capPids = [] // 2026-08-22（P1 修复测试盲区）：累积全部实验进程——否则被覆盖的旧 pid 消失 → crashed 抢先，aborted 分支永不触发
  for (let i = 1; i <= 5; i++) {
    await pre({ name: 'bash', arguments: { command: 'python train_cap' + i + '.py --epochs 1' } }, async () => ({ kind: 'allow' }))
    capPids.push(String(1000 + i) + ' 1 10.0 9000 python train_cap' + i + '.py --epochs 1')
    FAKE.psLines = capPids.concat(['8888 1 0.5 300000 node server.js'])
    await tick(3)
    snap = await G('snapshot')({})
    if (snap.experiment) runIds5.push(snap.experiment.runId)
  }
  assert(runIds5.length === 5, '5 次 start 均返回 running 记录（第 5 次触发上限归档）', runIds5.length)
  snap = await G('snapshot')({})
  assert(Array.isArray(snap.experiments) && snap.experiments.length <= 4, '并行上限 4：experiments ≤ 4', snap.experiments && snap.experiments.length)
  // 2026-08-22（P1）：上限触发的 aborted 也归档进 ended[]
  assert(snap.ended && snap.ended.some((e) => e.state === 'aborted'),
    'P1 ended：并行上限触发 → 最旧实验 aborted 归档', snap.ended && snap.ended.map((e) => e.runId + ':' + e.state))
  // 清理：全部结束（供后续场景干净起点）
  FAKE.psLines = []
  for (const rid of runIds5) {
    // 各实验按 cmd 配对 result（runId 归属链路：markResult 无 runId 时指纹匹配主实验）
    res({ name: 'bash', arguments: { command: '' } }, { isError: false, content: [] })
  }
  await tick(6)
  snap = await G('snapshot')({})
  assert(snap.experiment === null, '多轨场景清理完毕（无 running）', snap.experiment)

  console.log('\n[C] 平衡引擎 1.2：归属仲裁三分支（防误报核心）')
  // 分支③：无实验 + 整卡显存高 → other-occupancy(info)，不误报实验 oom
  FAKE.gpuCsv = '0, NVIDIA GeForce RTX 5060 Ti, 95 %, 24000 MiB, 24576 MiB, 81, 350.00 W' // mem 97.6% ≥ memWarn 95
  FAKE.psLines = ['8888 1 0.5 300000 node server.js', '7777 1 0.2 200000 /usr/lib/firefox/firefox']
  const c0 = (await G('snapshot')({})).alertsCriticalCount // [C] 入口（含 [B2] crashed 累计）
  await tick(5) // 连续 5 个 2s 窗口 = 10s 持续
  snap = await G('snapshot')({})
  const occ = snap.alerts.find((a) => a.rule === 'other-occupancy')
  assert(!!occ && occ.level === 'info', '无实验 + 整卡高 → other-occupancy(info)（不误报实验 oom）', occ)
  assert(!snap.alerts.some((a) => a.rule === 'oom'), '无实验时不触发 oom 规则', snap.alerts && snap.alerts[0])
  assert(snap.alertsCriticalCount === c0, 'other-occupancy 不新增 critical（计数不变）', c0 + '→' + snap.alertsCriticalCount)
  assert(occ && occ.evidence && occ.evidence.procs.some((p) => p.pid === 1234 || p.pid === 9999), 'other-occupancy evidence 含 Windows 侧进程(tasklist 1234/9999)', occ && occ.evidence)
  // 2026-08-20（归因修复）：evidence 不得含 WSL CPU Top 的 node（8888）——避免 dsh web 式误报（CPU 高 ≠ 占显存）
  assert(occ && occ.evidence && !occ.evidence.procs.some((p) => p.pid === 8888), 'other-occupancy evidence 不含 WSL node(8888)（防 CPU-top 误判占卡）', occ && occ.evidence)

  // 分支①：实验活跃（组 CPU 95 ≥30）+ 整卡高 → oom critical + evidence 含实验 pid
  await pre({ name: 'bash', arguments: { command: 'python train_demo.py --epochs 10' } }, async () => ({ kind: 'allow' }))
  FAKE.psLines = ['1234 1 95.0 3000000 python train_demo.py --epochs 10', '8888 1 0.5 300000 node server.js', '7777 1 0.2 200000 /usr/lib/firefox/firefox']
  await tick(3) // ps 周期：组关联（cpuPct 95 ≥ 30 → 活跃）
  await tick(5) // 10s 持续命中
  snap = await G('snapshot')({})
  const oom1 = snap.alerts.find((a) => a.rule === 'oom')
  assert(!!oom1 && oom1.level === 'critical', '实验活跃 + 整卡高 → oom critical', oom1 && oom1.level)
  assert(oom1 && Array.isArray(oom1.actions) && oom1.actions.length >= 1, 'oom 建议动作', oom1 && oom1.actions)
  assert(oom1 && oom1.evidence && oom1.evidence.procs.some((p) => p.pid === 1234), 'oom evidence 含实验 pid 1234', oom1 && oom1.evidence)
  const countAfterFirst = snap.alertsCriticalCount
  await tick(6) // 继续命中 → 同类 5 分钟防重（计数不变）
  snap = await G('snapshot')({})
  assert(snap.alertsCriticalCount === countAfterFirst, '同类告警 5 分钟防重（计数不变）', countAfterFirst + '→' + snap.alertsCriticalCount)

  // 分支②：实验不活跃（组 CPU 0.5 <30、内存 120MiB <2048）+ 整卡高 → 降级 warn（疑似他人占用）
  advance(5 * 60 * 1000 + 100) // 跳过 5min 防重窗口
  FAKE.psLines = ['1234 1 0.5 120 python train_demo.py --epochs 10', '8888 1 0.5 300000 node server.js', '7777 1 0.2 200000 /usr/lib/firefox/firefox']
  await tick(5)
  snap = await G('snapshot')({})
  const oom2 = snap.alerts.find((a) => a.rule === 'oom')
  assert(!!oom2 && oom2.level === 'warn', '实验不活跃 + 整卡高 → 降级 warn（疑似他人占用）', oom2 && oom2.level)
  assert(!!oom2 && oom2.msg.indexOf('疑似他人') !== -1, 'warn msg 标注疑似他人负载', oom2 && oom2.msg)

  // C2：io-bottleneck——实验组 CPU 满载 + GPU 低（主判据分支）
  FAKE.gpuCsv = '0, NVIDIA GeForce RTX 5060 Ti, 5 %, 19200 MiB, 24576 MiB, 80, 350.00 W' // util 5 < 30；显存 78% < memWarn 95 → oom 不干扰
  FAKE.psLines = ['1234 1 95.0 3000000 python train_demo.py --epochs 10', '8888 1 0.5 300000 node server.js', '7777 1 0.2 200000 /usr/lib/firefox/firefox']
  advance(6000) // 强制下一 ps 周期在本次 tick(5) 首拍发生 → 5 次命中 ≥ MIN_HITS
  await tick(5)
  snap = await G('snapshot')({})
  const io = snap.alerts.find((a) => a.rule === 'io-bottleneck')
  assert(!!io && io.level === 'warn' && io.msg.indexOf('实验进程组 CPU 95%') !== -1, 'io-bottleneck（实验组 CPU 满载 + GPU 低）', io && io.msg)

  // C3：thermal——整卡物理量 + G 活跃度上下文
  FAKE.gpuCsv = '0, NVIDIA GeForce RTX 5060 Ti, 5 %, 19200 MiB, 24576 MiB, 86, 350.00 W' // temp 86 ≥ tempWarn 85
  await tick(5)
  snap = await G('snapshot')({})
  const th = snap.alerts.find((a) => a.rule === 'thermal')
  assert(!!th && th.level === 'warn' && th.msg.indexOf('实验进程组') !== -1, 'thermal msg 含实验进程组上下文', th && th.msg)

  // 结束实验（配对 result + 进程消失 → done），复位 GPU
  const res2 = C.events['tools/result'][0]
  FAKE.psLines = ['8888 1 0.5 300000 node server.js', '7777 1 0.2 200000 /usr/lib/firefox/firefox']
  res2({ name: 'bash', arguments: { command: 'python train_demo.py --epochs 10' } }, { isError: false, content: [] })
  await tick(3)
  FAKE.gpuCsv = '0, NVIDIA GeForce RTX 5060 Ti, 92 %, 19200 MiB, 24576 MiB, 80, 350.00 W'

  console.log('\n[C2] 告警生命周期（2026-08-22 P0：TTL 过期 + clear-alerts 全清/定向清除）')
  // 前置：当前告警含 [C] 生成的 other-occupancy/oom/io/thermal（最近一条是 thermal）
  const tCtlC2 = H.toolDefs.find((t) => t.name === 'lab_ctl') // tCtl 正式定义在 [E]；此处同源取句柄
  // ① TTL：推进 24h+ → 读取触发 prune → 旧告警全部过期、criticalCount 回落
  advance(24 * 60 * 60 * 1000 + 1000)
  snap = await G('snapshot')({})
  assert(Array.isArray(snap.alerts) && snap.alerts.length === 0, 'TTL 24h：旧告警全部过期（alerts 空）', snap.alerts && snap.alerts.length)
  assert(snap.alertsCriticalCount === 0, 'TTL 24h：criticalCount 回落为 0', snap.alertsCriticalCount)
  // ② 再造一条 oom（实验活跃 + 整卡高）→ 验证 clear-alerts
  await pre({ name: 'bash', arguments: { command: 'python train_demo.py --epochs 10' } }, async () => ({ kind: 'allow' }))
  FAKE.psLines = ['1234 1 95.0 3000000 python train_demo.py --epochs 10', '8888 1 0.5 300000 node server.js']
  FAKE.gpuCsv = '0, NVIDIA GeForce RTX 5060 Ti, 95 %, 24000 MiB, 24576 MiB, 81, 350.00 W'
  await tick(3) // ps 周期：组关联
  await tick(5) // 10s 持续 → oom critical
  snap = await G('snapshot')({})
  const oomC2 = snap.alerts.find((a) => a.rule === 'oom')
  assert(!!oomC2 && oomC2.level === 'critical', 'TTL 过期后仍能触发 oom critical', oomC2 && oomC2.level)
  const oomRunId = oomC2 && oomC2.runId
  // ③ 定向清除（rule / runId 两条路径走同一 clear() 过滤）
  const vClrRule = await tCtlC2.execute({ action: 'clear-alerts', rule: 'oom' })
  assert(vClrRule && vClrRule.ok === true && vClrRule.state === 'alerts-cleared', 'lab_ctl clear-alerts(rule=oom) → alerts-cleared', vClrRule && vClrRule.state)
  snap = await G('snapshot')({})
  assert(!snap.alerts.some((a) => a.rule === 'oom'), 'rule=oom 定向清除后无 oom 告警', snap.alerts && snap.alerts.map((a) => a.rule))
  // 再造一条 oom（需跳过 5min 防重窗口）
  advance(5 * 60 * 1000 + 100)
  await tick(5)
  snap = await G('snapshot')({})
  const oomC2b = snap.alerts.find((a) => a.rule === 'oom')
  assert(!!oomC2b && oomC2b.level === 'critical', '再造 oom（跳过防重）', oomC2b && oomC2b.level)
  const vClrRun = await tCtlC2.execute({ action: 'clear-alerts', runId: oomC2b && oomC2b.runId })
  assert(vClrRun && vClrRun.ok === true && vClrRun.cleared >= 1, 'clear-alerts(runId) 定向清除命中', vClrRun && vClrRun.cleared)
  // ④ 全清：alerts 空 + criticalCount 0
  const vClrAll = await tCtlC2.execute({ action: 'clear-alerts' })
  assert(vClrAll && vClrAll.ok === true && typeof vClrAll.cleared === 'number' && vClrAll.criticalCount === 0,
    'clear-alerts 全清 → cleared 数值 + criticalCount=0', vClrAll)
  snap = await G('snapshot')({})
  assert(snap.alertsCriticalCount === 0 && snap.alerts.length === 0, '全清后 badge/告警均为 0', snap.alertsCriticalCount + '/' + snap.alerts.length)
  // 清理实验（配对 result + 进程消失 → done），复位场景
  FAKE.gpuCsv = '0, NVIDIA GeForce RTX 5060 Ti, 92 %, 19200 MiB, 24576 MiB, 80, 350.00 W'
  FAKE.psLines = ['8888 1 0.5 300000 node server.js', '7777 1 0.2 200000 /usr/lib/firefox/firefox']
  const resC2 = C.events['tools/result'][0]
  resC2({ name: 'bash', arguments: { command: 'python train_demo.py --epochs 10' } }, { isError: false, content: [] })
  await tick(3)
  snap = await G('snapshot')({})
  assert(snap.experiment === null, 'C2 场景实验清理完毕', snap.experiment)

  console.log('\n[B3b] 相似命令指纹分离（2026-08-20 多轨修复：pyc: 截断 28→48 防指纹相同；2026-08-23 适配 TRAIN_PATTERNS 精度修复）')
  // python -c 内联形态：x=30 vs x=35（含训练特征 backward( 使命中 TRAIN_PATTERNS python -c 正则）——
  // 两命令在 48 字符截断内仅有 30 vs 35 差异 → v1 的 28 字符截断会使指纹相同 → 都关联第一进程
  await pre({ name: 'bash', arguments: { command: 'python3 -c "import torch;loss.backward();train_epoch=30" && echo "RUN-A"' } }, async () => ({ kind: 'allow' }))
  await pre({ name: 'bash', arguments: { command: 'python3 -c "import torch;loss.backward();train_epoch=35" && echo "RUN-B"' } }, async () => ({ kind: 'allow' }))
  FAKE.psLines = [
    '53299 1 0.0 3000 bash -c python3 -c "import torch;loss.backward();train_epoch=30" && echo "RUN-A"',
    '53300 53299 0.0 8000 python3 -c import torch;loss.backward();train_epoch=30',
    '53301 1 0.0 3000 bash -c python3 -c "import torch;loss.backward();train_epoch=35" && echo "RUN-B"',
    '53302 53301 0.0 8000 python3 -c import torch;loss.backward();train_epoch=35',
    '8888 1 0.5 300000 node server.js',
  ]
  await tick(3)
  snap = await G('snapshot')({})
  assert(Array.isArray(snap.experiments) && snap.experiments.length === 2, '相似命令双实验并行', snap.experiments && snap.experiments.length)
  const eA = snap.experiments.find((e) => e.cmd && e.cmd.indexOf('train_epoch=30') !== -1)
  const eB = snap.experiments.find((e) => e.cmd && e.cmd.indexOf('train_epoch=35') !== -1)
  assert(eA && eB && eA.pid !== eB.pid, '相似命令 pid 分离（train_epoch=30≠train_epoch=35）', (eA && eA.pid) + ' vs ' + (eB && eB.pid))
  assert(eA && Array.isArray(eA.procGroup) && eA.procGroup.indexOf(53299) !== -1 && eA.procGroup.indexOf(53301) === -1,
    'run-A procGroup 只含自身进程（不含 B 的 53301）', eA && eA.procGroup)
  assert(eB && Array.isArray(eB.procGroup) && eB.procGroup.indexOf(53301) !== -1 && eB.procGroup.indexOf(53299) === -1,
    'run-B procGroup 只含自身进程（不含 A 的 53299）', eB && eB.procGroup)
  // 清理：全部结束
  FAKE.psLines = []
  await tick(6)
  snap = await G('snapshot')({})
  assert(snap.experiment === null, '相似命令场景清理完毕', snap.experiment)

  console.log('\n[B3c] 并行实验 groupStats 各自独立 + A 先 result 配对（2026-08-20 修复）')
  // groupStats 独立：A/B 并行，各自进程组聚合，不得共享主实验聚合
  await pre({ name: 'bash', arguments: { command: 'python train_x.py --epochs 5' } }, async () => ({ kind: 'allow' }))
  await pre({ name: 'bash', arguments: { command: 'python train_y.py --epochs 5' } }, async () => ({ kind: 'allow' }))
  FAKE.psLines = [
    '201 1 20.0 12000 python train_x.py --epochs 5',
    '202 1 15.0 10000 python train_y.py --epochs 5',
    '8888 1 0.5 300000 node server.js',
  ]
  await tick(3)
  snap = await G('snapshot')({})
  assert(Array.isArray(snap.experiments) && snap.experiments.length === 2, 'B3c：双实验并行', snap.experiments && snap.experiments.length)
  const ex = snap.experiments.find((e) => e.cmd && e.cmd.indexOf('train_x') !== -1)
  const ey = snap.experiments.find((e) => e.cmd && e.cmd.indexOf('train_y') !== -1)
  assert(ex && ey && ex.groupStats && ey.groupStats, '并行实验各有 groupStats', !!(ex && ex.groupStats) + '/' + !!(ey && ey.groupStats))
  assert(ex && ey && ex.groupStats && ey.groupStats && ex.groupStats.members && ey.groupStats.members &&
    ex.groupStats.members.some((m) => m.pid === 201) && !ex.groupStats.members.some((m) => m.pid === 202) &&
    ey.groupStats.members.some((m) => m.pid === 202) && !ey.groupStats.members.some((m) => m.pid === 201),
    'groupStats 各自独立（A 只含 201，B 只含 202）',
    (ex && ex.groupStats && ex.groupStats.members || []).map((m) => m.pid) + ' / ' + (ey && ey.groupStats && ey.groupStats.members || []).map((m) => m.pid))
  // A 先 result（进程消失 + result）→ A done；B 仍 running
  const resA = C.events['tools/result'][0]
  FAKE.psLines = ['202 1 15.0 10000 python train_y.py --epochs 5', '8888 1 0.5 300000 node server.js']
  resA({ name: 'bash', arguments: { command: 'python train_x.py --epochs 5' } }, { isError: false, content: [] })
  await tick(3)
  await tick(3)
  snap = await G('snapshot')({})
  const exAfter = snap.experiments || []
  assert(exAfter.length === 1 && exAfter[0].cmd && exAfter[0].cmd.indexOf('train_y') !== -1,
    'A 先 result → A done 移除，B 保留（多轨配对命中 A 而非 B）', exAfter.map((e) => e.cmd))
  assert(snap.experiment && snap.experiment.cmd && snap.experiment.cmd.indexOf('train_y') !== -1, '主实验仍为 B', snap.experiment && snap.experiment.cmd)
  // 清理
  FAKE.psLines = []
  const resB = C.events['tools/result'][0]
  resB({ name: 'bash', arguments: { command: 'python train_y.py --epochs 5' } }, { isError: false, content: [] })
  await tick(6)
  snap = await G('snapshot')({})
  assert(snap.experiment === null, 'B3c 清理完毕', snap.experiment)

  console.log('\n[D] 阈值：直连即时生效 + 携带 last-write-wins（M3）')
  let rt = await G('setThresholds')({ memWarn: 50 })
  assert(rt.ok && rt.applied.memWarn === 50, 'setThresholds 直连 → memWarn=50', rt.applied)
  advance(10)
  snap = await G('snapshot')({ thresholds: { memWarn: 80 } })
  rt = await G('setThresholds')({})
  assert(rt.applied.memWarn === 80, '直连后携带（新时间戳）→ 覆盖为 80', rt.applied)
  // 2026-08-22（P1 设置面）：生效阈值透出到快照
  assert(snap.thresholds && snap.thresholds.memWarn === 80, 'P1 阈值透出：snapshot.thresholds.memWarn=80（rpcSnapshot 内嵌 apply）', snap.thresholds)

  // 2026-08-20（P2 2'）：阈值持久化——setThresholds 写回 settings 命名空间 lab-monitor
  const lmNs = C.settingsMock.namespaces['lab-monitor']
  assert(!!lmNs, 'settings 命名空间 lab-monitor 已注册（settings.register 落地）')
  assert(lmNs && lmNs.user && lmNs.user.thresholds && lmNs.user.thresholds.memWarn === 80,
    'setThresholds 写回 settings.user.thresholds（memWarn=80）', lmNs && lmNs.user && lmNs.user.thresholds)

  console.log('\n[E3] M4 settings 服务延迟就绪 → 重探后持久化启用（2026-08-20 实测修复）')
  // 场景：settings 服务晚于插件 apply（ctx.get('settings') 首次 undefined）→ 500ms 重探
  const ctxdM4 = makeCtx()
  ctxdM4.settingsMock.available = false // 服务未就绪
  const HM4 = makeHarness(ctxdM4.ctx, ctxdM4.settingsMock, ctxdM4.promptService)
  plugin.apply(ctxdM4.ctx, {})
  assert(!ctxdM4.settingsMock.namespaces['lab-monitor'], '服务未就绪 → 首次 register 未执行', !!ctxdM4.settingsMock.namespaces['lab-monitor'])
  // 模拟服务 600ms 后就绪（首次探针 500ms 触发时已可用）
  setTimeout(() => { ctxdM4.settingsMock.available = true }, 600)
  await new Promise((r) => setTimeout(r, 1400)) // 等待重探（500ms×2）
  assert(!!ctxdM4.settingsMock.namespaces['lab-monitor'], '重探后 settings 命名空间 lab-monitor 注册成功', !!ctxdM4.settingsMock.namespaces['lab-monitor'])
  // 重探后持久化可用：tag add 写回
  const tCtlM4 = HM4.toolDefs.find((t) => t.name === 'lab_ctl')
  const vTagM4 = await tCtlM4.execute({ action: 'tag', tag: { op: 'add', label: 'M4重探', patterns: ['never-match'], kind: 'process' } })
  assert(vTagM4 && vTagM4.ok === true, '重探后 lab_ctl tag add 可用', vTagM4 && vTagM4.ok)
  assert(ctxdM4.settingsMock.documents['lab-monitor'] && Array.isArray(ctxdM4.settingsMock.documents['lab-monitor'].tags) && ctxdM4.settingsMock.documents['lab-monitor'].tags.length >= 1,
    '重探后 tag 写回 settings documents（持久化链路通）', ctxdM4.settingsMock.documents['lab-monitor'] && ctxdM4.settingsMock.documents['lab-monitor'].tags && ctxdM4.settingsMock.documents['lab-monitor'].tags.length)

  console.log('\n[E] 工具执行 + prompt 注入')
  const tStatus = H.toolDefs.find((t) => t.name === 'lab_status')
  const vBrief = await tStatus.execute({ brief: true })
  assert(vBrief && vBrief.ok === true && typeof vBrief.line === 'string' && vBrief.line.indexOf('[Lab Monitor]') === 0, 'lab_status brief → {ok,line} 一行摘要', vBrief)
  const vFull = await tStatus.execute({})
  assert(vFull && typeof vFull.gpu !== 'undefined' && vFull.experiment !== undefined, 'lab_status 完整快照', Object.keys(vFull).slice(0, 5))
  const tCtl = H.toolDefs.find((t) => t.name === 'lab_ctl')
  const vSet = await tCtl.execute({ action: 'set-threshold', thresholds: { pollMs: 3000 } })
  assert(vSet.ok && vSet.applied.pollMs === 3000, 'lab_ctl set-threshold → pollMs=3000', vSet)
  const snapE = await G('snapshot')({})
  assert(snapE.thresholds && snapE.thresholds.pollMs === 3000, 'P1 阈值透出：pollMs=3000 进 snapshot.thresholds', snapE.thresholds && snapE.thresholds.pollMs)
  // #13-3 差异化阈值：lab_ctl set-threshold 带 thresholdOverrides → 快照透出 + 持久化
  const vOv = await tCtl.execute({
    action: 'set-threshold',
    thresholdOverrides: { byExpType: { 'gpu-train': { utilWarn: 60, memWarn: 90 } }, byTag: { '推理服务': { memWarn: 95 } } },
  })
  assert(vOv.ok && vOv.overrides && vOv.overrides.byExpType['gpu-train'].utilWarn === 60,
    '#13-3 set-threshold 写 thresholdOverrides 生效（gpu-train util=60）', vOv.overrides)
  const snapOv = await G('snapshot')({})
  assert(snapOv.thresholdOverrides && snapOv.thresholdOverrides.byExpType['gpu-train'].memWarn === 90,
    '#13-3 快照透出 thresholdOverrides（gpu-train mem=90）', snapOv.thresholdOverrides)
  assert(lmNs && lmNs.user && lmNs.user.thresholdOverrides && lmNs.user.thresholdOverrides.byTag['推理服务'].memWarn === 95,
    '#13-3 overrides 持久化写回 settings.user.thresholdOverrides（byTag 推理服务 mem=95）',
    lmNs && lmNs.user && lmNs.user.thresholdOverrides)
  // 清空覆盖 → 回退（快照透出空对象）
  const vOvClear = await tCtl.execute({ action: 'set-threshold', thresholdOverrides: { byExpType: {}, byTag: {} } })
  assert(vOvClear.ok && Object.keys(vOvClear.overrides.byExpType).length === 0 && Object.keys(vOvClear.overrides.byTag).length === 0,
    '#13-3 清空 overrides → 空对象', vOvClear.overrides)
  const vPause = await tCtl.execute({ action: 'pause' })
  assert(vPause.ok && vPause.state === 'paused', 'lab_ctl pause → paused', vPause)
  const snapP = await G('snapshot')({})
  assert(snapP.enabled === false, 'P1 启停透出：pause → snapshot.enabled=false', snapP.enabled)
  const tAdvice = H.toolDefs.find((t) => t.name === 'lab_advice')
  const vAdvice = await tAdvice.execute({})
  assert(vAdvice && Array.isArray(vAdvice.advice), 'lab_advice → { advice: [] }', vAdvice)

  // 2026-08-20（#1）：lossless JSON 清洗断言——nvidia-smi/CIM 输出 "N/A"（解析得 NaN）场景，
  // 快照与 lab_status 完整输出必须全 lossless（无 NaN/Infinity/undefined，dsh-tools 校验边界）
  const checkLossless = (v, path) => {
    if (v === null) return null
    if (v === undefined) return 'undefined@' + path
    if (typeof v === 'number') return Number.isFinite(v) ? null : 'non-finite@' + path + '=' + v
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const e = checkLossless(v[i], path + '[' + i + ']')
        if (e) return e
      }
      return null
    }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const e = checkLossless(v[k], path + '.' + k)
        if (e) return e
      }
      return null
    }
    return null
  }
  FAKE.gpuCsv = '0, NVIDIA GeForce RTX 5060 Ti, N/A, N/A, N/A, N/A, N/A'
  FAKE.cimLine = 'N/A;N/A;N/A\n1234;1;python.exe'
  // 恢复采样（上方 vPause 已 pause → enabled=false，tick 会跳过采样）+ 过期
  // GPU 查询缓存(500ms)/CIM 缓存(5s)：advance 6000 + tick 内 2000 = 8000ms > 5s TTL
  await tCtl.execute({ action: 'resume' })
  advance(6000)
  await tick(1)
  const snapNa = await G('snapshot')({})
  const bad = checkLossless(snapNa, 'snap')
  assert(bad === null, 'N/A 采样场景快照全 lossless（无 NaN/Infinity/undefined）', bad)
  assert(snapNa.gpu && snapNa.gpu[0] && snapNa.gpu[0].utilPct === 0, 'nvidia-smi N/A → utilPct=0（安全降级）', snapNa.gpu && snapNa.gpu[0])
  assert(snapNa.enabled === true, 'P1 启停透出：resume → snapshot.enabled=true', snapNa.enabled)
  assert(snapNa.cpu && snapNa.cpu.percent === null, 'CIM N/A → cpu.percent=null（安全降级）', snapNa.cpu)
  const vFullNa = await tStatus.execute({})
  assert(checkLossless(vFullNa, 'vFullNa') === null, 'lab_status 完整输出 N/A 场景全 lossless', checkLossless(vFullNa, 'vFullNa'))
  const vAdvNa = await tAdvice.execute({})
  assert(checkLossless(vAdvNa, 'vAdvNa') === null, 'lab_advice N/A 场景全 lossless', checkLossless(vAdvNa, 'vAdvNa'))
  // codex 审查：lab_ctl set-threshold 返回值（含 lastSystemStats）也必须 lossless
  const vCtlNa = await tCtl.execute({ action: 'set-threshold', thresholds: {} })
  assert(checkLossless(vCtlNa, 'vCtlNa') === null, 'lab_ctl set-threshold N/A 场景全 lossless', checkLossless(vCtlNa, 'vCtlNa'))
  // 复位正常数据
  FAKE.gpuCsv = '0, NVIDIA GeForce RTX 5060 Ti, 92 %, 19200 MiB, 24576 MiB, 80, 350.00 W'
  FAKE.cimLine = '92;30480;12560\n1234;1;python.exe\n5678;1234;python.exe\n9999;1;chrome.exe'
  await tick(1)

  // 2026-08-20（P2 2'）：watch 动态注册持久化 + 「DSH 重启」读回断言
  const vWatch = await tCtl.execute({ action: 'watch', keywords: ['llama-server', 'vllm'] })
  assert(vWatch && vWatch.ok === true && Array.isArray(vWatch.matchedPids), 'lab_ctl watch → matchedPids 数组', vWatch)
  assert(lmNs && lmNs.user && Array.isArray(lmNs.user.watchProcs) && lmNs.user.watchProcs.indexOf('llama-server') !== -1,
    'lab_ctl watch 写回 settings.user.watchProcs', lmNs && lmNs.user && lmNs.user.watchProcs)

  // 2026-08-20（A2 标签分组）：lab_ctl tag —— add（正则）/ add（pid 快速打标）/ list / remove + 快照 tags 聚合
  console.log('\n[E2] 标签分组（A2：规则式打标签 → 分组聚合展示）')
  FAKE.tasklist = '"python.exe","1234","Console","1","12,345 K"\n"llama-server.exe","5555","Console","1","50,000 K"\n"chrome.exe","9999","Console","1","20,000 K"'
  await tick(1)
  const vTag1 = await tCtl.execute({ action: 'tag', tag: { op: 'add', label: '推理服务', patterns: ['llama-server'], kind: 'process', color: '#16a34a' } })
  assert(vTag1 && vTag1.ok === true && vTag1.rule && vTag1.rule.id, 'lab_ctl tag add（正则）→ rule 生成', vTag1 && vTag1.rule)
  assert(Array.isArray(vTag1.matchedPids) && vTag1.matchedPids.indexOf(5555) !== -1, 'tag add 命中 llama-server(5555)', vTag1.matchedPids)
  // pid 快速打标：从当前进程表取 pid 1234（python.exe）生成规则
  const vTag2 = await tCtl.execute({ action: 'tag', tag: { op: 'add', label: '训练脚本', pid: 1234, kind: 'experiment' } })
  assert(vTag2 && vTag2.ok === true && Array.isArray(vTag2.rule.patterns) && vTag2.rule.patterns.length === 1,
    'tag add（pid 快速打标）→ 自动生成 cmdline 规则', vTag2 && vTag2.rule && vTag2.rule.patterns)
  assert(vTag2.matchedPids.indexOf(1234) !== -1, 'pid 打标立即命中原进程', vTag2.matchedPids)
  // 快照 tags 聚合
  snap = await G('snapshot')({})
  assert(Array.isArray(snap.tags) && snap.tags.length >= 2, '快照 tags 含 ≥2 个标签组', snap.tags && snap.tags.length)
  const tgSvc = snap.tags.find((t) => t.rule && t.rule.label === '推理服务')
  assert(tgSvc && tgSvc.pids.indexOf(5555) !== -1, '推理服务组含 llama-server(5555)', tgSvc && tgSvc.pids)
  assert(tgSvc && typeof tgSvc.memMiB === 'number' && tgSvc.memMiB > 0, '推理服务组聚合 memMiB 存在（tasklist 无 CPU% 属正常）', tgSvc && tgSvc.memMiB)
  const tgExp = snap.tags.find((t) => t.rule && t.rule.label === '训练脚本')
  assert(tgExp && tgExp.rule.kind === 'experiment', '训练脚本组 kind=experiment', tgExp && tgExp.rule && tgExp.rule.kind)
  // 持久化写回 settings
  assert(lmNs && lmNs.user && Array.isArray(lmNs.user.tags) && lmNs.user.tags.length >= 2,
    'lab_ctl tag 写回 settings.user.tags', lmNs && lmNs.user && lmNs.user.tags && lmNs.user.tags.length)
  // list + remove
  const vTagList = await tCtl.execute({ action: 'tag', tag: { op: 'list' } })
  assert(vTagList && vTagList.ok === true && Array.isArray(vTagList.tags) && vTagList.tags.length >= 2, 'lab_ctl tag list', vTagList && vTagList.tags && vTagList.tags.length)
  const firstId = vTag1.rule.id
  const vTagRm = await tCtl.execute({ action: 'tag', tag: { op: 'remove', id: firstId } })
  assert(vTagRm && vTagRm.ok === true && vTagRm.state === 'tag-removed', 'lab_ctl tag remove', vTagRm)
  const vTagList2 = await tCtl.execute({ action: 'tag', tag: { op: 'list' } })
  assert(vTagList2 && vTagList2.tags.every((t) => t.id !== firstId), 'remove 后规则不存在', vTagList2 && vTagList2.tags && vTagList2.tags.map((t) => t.id))
  // 非法输入守卫
  const vTagBad = await tCtl.execute({ action: 'tag', tag: { op: 'add', label: '坏规则', patterns: ['['] } })
  assert(vTagBad && vTagBad.ok === false, '非法正则 tag add 拒绝', vTagBad)
  // 重启模拟：新 fiber 重新 apply，settings 磁盘文档（documents）保留 → 阈值/watchlist 自动恢复
  const ctxd3 = makeCtx()
  // 只预置持久化文档层（user 层数据）；namespaces 留空让新实例 register 时从 documents 重建
  ctxd3.settingsMock.documents['lab-monitor'] = JSON.parse(JSON.stringify(lmNs.user))
  const H3 = makeHarness(ctxd3.ctx, ctxd3.settingsMock, ctxd3.promptService)
  plugin.apply(ctxd3.ctx, {})
  await new Promise((r) => setTimeout(r, 300)) // 后端探测 + 首帧采样
  const rt3 = await callApi(H3, 'setThresholds')({})
  assert(rt3 && rt3.applied && rt3.applied.memWarn === 80, '重启后阈值从 settings 文档恢复（memWarn=80）', rt3 && rt3.applied)
  FAKE.tasklist = '"python.exe","1234","Console","1","12,345 K"\n"llama-server.exe","5555","Console","1","50,000 K"\n"chrome.exe","9999","Console","1","20,000 K"'
  for (let i = 0; i < 2; i++) {
    advance(2000)
    const iv3 = ctxd3.intervals[0]
    if (iv3 && !iv3.disposed) { try { await iv3.fn() } catch (e) { console.error('tick3 错误:', e) } }
  }
  const snapR = await callApi(H3, 'snapshot')({})
  assert(Array.isArray(snapR.watchedPids) && snapR.watchedPids.indexOf(5555) !== -1,
    '重启后 watchlist 恢复并命中 llama-server(5555)', snapR.watchedPids)
  // 2026-08-22（P2 实验历史持久化）：重启（新 fiber + documents 保留）→ ended[] 从 settings 恢复
  assert(Array.isArray(snapR.ended) && snapR.ended.length >= 1,
    'P2 重启后 ended[] 从 settings 恢复（history 持久化）', snapR.ended && snapR.ended.length)
  const endedR = snapR.ended || []
  assert(endedR.some((e) => e.runId === runA && e.state === 'done') && endedR.some((e) => e.runId === runB && e.state === 'crashed'),
    'P2 恢复记录含 runA(done)/runB(crashed)（runId 精确）', endedR.map((e) => e.runId + ':' + e.state))
  assert(endedR.every((e) => e.summary === null || typeof e.summary.gpuUtilMax === 'number'),
    'P2 恢复记录 summary 结构完整（null 或含 gpuUtilMax）', endedR.slice(0, 3).map((e) => e.summary))
  assert(Array.isArray(snapR.procs) && snapR.procs.length > 0 && snapR.procs[0].pid === 5555,
    'watch 命中进程置顶可见（P0 修复：不再被 15 行截断切掉）', snapR.procs && snapR.procs.slice(0, 3).map((p) => p.pid))
  FAKE.tasklist = '"python.exe","1234","Console","1","12,345 K"\n"python.exe","5678","Console","1","8,000 K"\n"chrome.exe","9999","Console","1","20,000 K"'
  // promptInjection=true 时注入生效（KV 缓存默认关；此处显式验证开启路径）
  const cfg2 = { promptInjection: true }
  const ctxd2 = makeCtx()
  const H2 = makeHarness(ctxd2.ctx, ctxd2.settingsMock, ctxd2.promptService)
  const plugin2 = { name, inject, apply }
  plugin2.apply(ctxd2.ctx, cfg2)
  const line = ctxd2.promptState.variables.labstatus()
  assert(typeof line === 'string' && line.indexOf('[Lab Monitor]') === 0, '提示词注入行（promptInjection=true 开启验证）', line)

  console.log('\n[F] resume + ui.betterSidebarVisible 探测（0.13.0 互斥）')
  const vResume = await tCtl.execute({ action: 'resume' })
  assert(vResume.state === 'running', 'lab_ctl resume → running', vResume)
  FAKE.aionui = { rightPanel: 'aionui-panel' }
  if (C.events['settings/updated'] && C.events['settings/updated'].length) C.events['settings/updated'].forEach((fn) => fn('aionui-panel', FAKE.aionui, undefined, 'provider'))
  snap = await G('snapshot')({})
  assert(snap.ui && snap.ui.betterSidebarVisible === false, 'aionui-panel 互斥 → betterSidebarVisible=false', snap.ui)

  console.log('\n[G] history 降采样（P2 验收 3）')
  const hist = await G('history')({ sinceMs: 0, bucketMs: 10000 })
  assert(hist && Array.isArray(hist.points) && hist.points.length >= 1, 'history 返回降采样点', hist.points.length)

  // 清理：触发 fiber disposer + 显式退出（停掉 dmon 后台流模拟）
  try { C.teardowns.forEach((d) => { if (typeof d === 'function') d() }) } catch (e) { console.error('teardown 错误:', e) }

  console.log('\n==== 结果:', failures === 0 ? 'ALL PASS' : failures + ' FAILED', '====')
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('verify-host 失败:', e && e.stack || e); process.exit(1) })
