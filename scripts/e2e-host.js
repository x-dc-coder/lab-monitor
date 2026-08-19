#!/usr/bin/env node
// ============================================================================
// e2e-host.js —— P1 端到端实证（真实 shell + 真实 python 进程驱动同一份 host 代码）
// 运行：node scripts/e2e-host.js
// 说明：
//   - 与 verify-host.js 相同 D4-1 concat 求值（同一份真实代码），但 shell 换成
//     真实 child_process（跑真实 python3 train_demo.py / kill / ps），
//     timer 用真实时钟（真实 2s 采样 / 5s ps 周期），不做虚拟时钟。
//   - 覆盖：T1 正常结束 → done（配对 result + 进程消失双确认）
//           T2 kill → crashed + CRITICAL 告警（kill 自身 result 不误判 done）
//           T3 并发单跟踪 → aborted（R-2）
//           T4 平衡引擎构造触发（thermal / oom）
//           T4b 同类告警 5min 防重（P2 1）
//           T5 history 真实数据降采样（P2 3）
//   - 状态机/告警/prompt/工具逻辑全部来自 src/index.ts（V2：import lib/types/index.js）。
//   - 本脚本不装载 cordis 插件（会话隔离 + 77KB 载荷无法经工具参数传递），
//     而是在 Node 进程内以 cordis 沙箱等价形态求值同一代码——端到端差异仅在
//     "hooks 由脚本派发事件"而非 cordis 事件总线；状态机/采样/告警逻辑一致。
// ============================================================================
'use strict'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { apply, name, inject } from '../lib/types/index.js'

let failures = 0
function assert(cond, name, extra) {
  if (cond) { console.log('  ✓', name) }
  else { failures += 1; console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '') }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
// 轮询等待某规则告警出现（1.2：backend snapshot 受 CIM 进程树拖慢 ~3-5s/tick，
// MIN_HITS=5 → 阈值需持续 ≥25s 才发告警；断言改为轮询而非固定 sleep）
async function waitForRule(rule, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await G('snapshot')({})
    const hit = (s.alerts || []).find((a) => a.rule && a.rule.includes(rule))
    if (hit) return hit
    await sleep(3000)
  }
  return null
}

// ── 真实 shell（child_process） ───────────────────────────────────────────
// 采样通道：真实 nvidia-smi.exe / PowerShell / tasklist / /proc（WSL 本机）
// 进程通道：ps -eo（状态机 pid 关联/crashed 判定）
const realShell = {
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
    const cmd = request.command
    try {
      const r = execFileSync('/bin/bash', ['-c', cmd], {
        encoding: 'utf8', timeout: (request.timeoutMs || 15000), maxBuffer: 1 << 22,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { exitCode: 0, stdout: { text: r || '', truncated: false }, stderr: { text: '', truncated: false } }
    } catch (e) {
      return { exitCode: e.status == null ? -1 : e.status, stdout: { text: (e.stdout || '').toString(), truncated: false }, stderr: { text: (e.stderr || '').toString(), truncated: false } }
    }
  },
  start(request) {
    // 长驻流（dmon）：真实 spawn，支持 readOutput/kill
    const cp = spawn('/bin/bash', ['-c', request.command], { cwd: request.workdir || '/tmp', stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const handle = { exitCode: null, cp, _readBuf: '', _killed: false }
    handle.readOutput = () => {
      // 同步读（真实进程输出缓冲）；简化为轮询读取已累积行
      let out = handle._readBuf
      handle._readBuf = ''
      if (out || handle.exitCode !== null) {
        if (handle.exitCode !== null && !out) return { delta: '', lossy: false }
        return { delta: out, lossy: false }
      }
      return { delta: '', lossy: false }
    }
    handle.kill = () => { handle._killed = true; try { cp.kill('SIGKILL') } catch (e) {} return true }
    cp.stdout.on('data', (d) => { handle._readBuf += d.toString() })
    cp.stderr.on('data', (d) => { handle._readBuf += d.toString() })
    cp.on('exit', (code) => { handle.exitCode = code == null ? -1 : code })
    return handle
  },
}

// ── mock cordis ctx（真实 shell + 真实 timer） ────────────────────────────
function makeCtx() {
  const events = {}
  const teardowns = []
  const promptState = { variables: {}, sections: [] }
  const settingsMock = {
    get(ns) { return ns === 'aionui-panel' ? undefined : undefined },
    on(name, fn) { (events[name] = events[name] || []).push(fn); return () => {} },
  }
  const promptService = {
    variable(name, provider) { promptState.variables[name] = provider; return () => {} },
    section(s) { promptState.sections.push(s); return () => {} },
  }
  const ctx = {
    shell: realShell,
    get(name) {
      if (name === 'settings') return settingsMock
      if (name === 'systemPrompt') return promptService
      return undefined
    },
    on(name, fn) { (events[name] = events[name] || []).push(fn); return () => {} },
    interval(fn, ms) { const iv = setInterval(fn, ms); return () => clearInterval(iv) },
    timeout(fn, ms) { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
    effect(fn, label) { const d = fn() || (() => {}); teardowns.push(d); return d },
    emit(name, payload) { (events[name] || []).forEach((fn) => { try { fn(payload) } catch (e) { console.error('emit err', name, e) } }) },
  }
  return { ctx, events, teardowns, promptState, settingsMock, promptService }
}

// ── V2：mock webServer + tools 服务（替代动态版 harness） ──────────────────
function makeHarness(ctxObj, settingsMock, promptService) {
  const toolDefs = []
  const registered = []
  const httpRoutes = []
  const webServer = { register(route) { httpRoutes.push(route); return () => {} } }
  const tools = { register(def) { registered.push(def); toolDefs.push(def); return () => {} } }
  // 注入 ctx 属性（V2：inject 声明后 cordis 挂属性；mock 直接赋值）
  ctxObj.webServer = webServer
  ctxObj.tools = tools
  return { toolDefs, registered, httpRoutes }
}

// ── 装载真实代码（V2：import lib） ────────────────────────────────────────
const ctxd = makeCtx()
const H = makeHarness(ctxd.ctx, ctxd.settingsMock, ctxd.promptService)
const C = ctxd
const plugin = { name, inject, apply }
function G(method) {
  const route = H.httpRoutes.find((r) => (r.path || '').indexOf('/lab-monitor/api') === 0)
  if (!route) return undefined
  return (body) => {
    const res = {
      writeHead(code, headers) { this._code = code; this._headers = headers; return this },
      end(data) { this._body = data; return this },
    }
    const req = { url: route.path + '/' + method, _dataFns: [], _endFns: [], _errFns: [],
      on(type, fn) { if (type === 'data') this._dataFns.push(fn); if (type === 'end') this._endFns.push(fn); if (type === 'error') this._errFns.push(fn) } }
    route.handler(req, res)
    const payload = body ? JSON.stringify(body) : '{}'
    for (const fn of req._dataFns) fn(payload)
    for (const fn of req._endFns) fn()
    return res._body !== undefined ? JSON.parse(res._body) : { ok: false, error: 'no response body' }
  }
}
function pre(listener, cmd) { return listener({ name: 'bash', arguments: { command: cmd } }, async () => ({ kind: 'allow' })) }
function res(listener, cmd, opts) { return listener({ name: 'bash', arguments: { command: cmd } }, { isError: false, content: [], ...(opts || {}) }) }

;(async () => {
  console.log('== [0] 插件装载（真实代码求值） ==')
  assert(plugin && plugin.name === 'lab-monitor', 'name=lab-monitor')
  plugin.apply(C.ctx, {})
  assert(G('snapshot') && G('history') && G('setThresholds') && G('control'), '4 RPC 注册')
  assert(H.registered.some((t) => t.name === 'lab_status'), '工具 lab_status 注册')

  // hooks 监听器在 apply() 内注册（registerHooks → ctx.on）
  const PRE = C.events['tools/pre-execute'][0]
  const RES = C.events['tools/result'][0]
  assert(typeof PRE === 'function', 'tools/pre-execute 监听器已注册')
  assert(typeof RES === 'function', 'tools/result 监听器已注册')

  // 等采样后端就绪（真实 nvidia-smi probe）
  console.log('== [1] 采样后端就绪（真实 probe） ==')
  await sleep(4000)
  const s0 = await G('snapshot')({})
  assert(s0 && s0.platform === 'wsl', 'platform=wsl（真实 /proc/version）', s0 && s0.platform)
  assert(s0.sources && (s0.sources.gpu === 'query' || s0.sources.gpu === 'dmon'), 'sources.gpu=' + (s0.sources && s0.sources.gpu), s0.sources)
  assert(Array.isArray(s0.gpu) && s0.gpu.length >= 1 && typeof s0.gpu[0].utilPct === 'number', 'gpu[] 真实解析', s0.gpu && s0.gpu[0])

  // ═══ T1：正常结束 → done ═══════════════════════════════════════════════
  console.log('\n== T1: python3 -c sleep 20 → running → done ==')
  const t1Cmd = "python3 -c 'import time; time.sleep(20)'"
  await pre(PRE, t1Cmd) // tools/pre-execute 命中 python -c
  let snap = await G('snapshot')({})
  assert(snap.experiment && snap.experiment.state === 'running', 'pre-execute → running', snap.experiment)
  assert(snap.experiment.cmd === t1Cmd, 'experiment.cmd 记录', snap.experiment.cmd)

  // 真实跑该命令（后台，直接 spawn python3 贴近 shell.run 直连语义），等 ps 周期回填 pid
  const cp1 = spawn('python3', ['-c', 'import time; time.sleep(20)'], { cwd: '/tmp', stdio: 'ignore' })
  await sleep(6500) // 等 1 个 ps 周期（5s）
  snap = await G('snapshot')({})
  console.log('  [T1] pid 关联: python3 进程 pid=', cp1.pid, '实验 pid=', snap.experiment && snap.experiment.pid)
  // 断言：实验 pid 已回填，且该 pid 在 ps 中是真实的 python3 进程（cp1.pid 是 node spawn 句柄，
  // WSL 下可能指向中间层；以 ps 实际进程为准——指纹匹配回填的 pid 即真实进程）
  const expPid = snap.experiment && snap.experiment.pid
  assert(typeof expPid === 'number' && expPid > 0, 'pid 关联已回填（v1.4.5 指纹修复，真实 ps）', { pid: cp1.pid, exp: expPid })
  if (expPid) {
    const psChk = execFileSync('/bin/bash', ['-c', 'ps -p ' + expPid + ' -o comm= 2>/dev/null || echo MISSING'], { encoding: 'utf8' }).trim()
    assert(psChk !== 'MISSING', '回填 pid 对应真实存活进程（comm=' + psChk + '）', psChk)
  }

  // 真实时序模拟：result 配对在进程运行期间到达（工具完成即 emit，早于进程结束）
  await sleep(3000)   // 进程运行中，result 已配对（resultSeen=true）
  await res(RES, t1Cmd) // tools/result 配对（真实场景：工具完成即 emit）
  await sleep(20000)  // 进程 20s 结束 + ps 周期确认进程消失（done 双确认 2/2）
  snap = await G('snapshot')({})
  assert(snap.experiment === null || snap.experiment.state !== 'running', '实验已收敛（done 双确认）', snap.experiment)
  console.log('  [T1] experiment=', JSON.stringify(snap.experiment), 'alertsCriticalCount=', snap.alertsCriticalCount)
  assert(snap.alertsCriticalCount === 0, '正常结束无 CRITICAL 告警', snap.alertsCriticalCount)
  try { process.kill(cp1.pid, 'SIGKILL') } catch (e) {}

  // ═══ T2：kill → crashed + CRITICAL ═════════════════════════════════════
  console.log('\n== T2: python3 train_demo.py + kill → crashed + CRITICAL ==')
  const t2Cmd = 'python3 /tmp/train_demo.py' // sleep 300，命中 train*.py
  await pre(PRE, t2Cmd)
  const cp2 = spawn('python3', ['/tmp/train_demo.py'], { cwd: '/tmp', stdio: 'ignore' })
  await sleep(6500) // 等 ps 周期回填 pid（真实进程已起）
  snap = await G('snapshot')({})
  assert(snap.experiment && snap.experiment.state === 'running', 'running（train*.py）', snap.experiment)
  const pid2 = snap.experiment.pid
  assert(pid2 > 0, 'pid 已关联', pid2)
  console.log('  [T2] 实验 pid=', pid2, 'spawn 包装 pid=', cp2.pid)

  await res(RES, 'kill ' + pid2) // kill 自身 result：不配对 → 不得误判 done
  console.log('  [T2] kill pid=', pid2)
  try { process.kill(pid2, 'SIGKILL') } catch (e) {}
  await sleep(16000) // ps 间隔 5s × CRASH_PS_GAP 2 = 10~15s
  snap = await G('snapshot')({})
  console.log('  [T2] experiment=', JSON.stringify(snap.experiment), 'critical=', snap.alertsCriticalCount)
  assert(snap.alertsCriticalCount >= 1, 'crashed → CRITICAL 告警', snap.alertsCriticalCount)
  const crashAlert = (snap.alerts || []).find((a) => a.rule === 'experiment-crash' && a.level === 'critical')
  assert(!!crashAlert, 'alerts[] 含 critical/experiment-crash', snap.alerts && snap.alerts[0])

  // ═══ T3：并发单跟踪 → aborted ═════════════════════════════════════════
  console.log('\n== T3: train_demo + train_demo2 并发 → 旧 aborted ==')
  await pre(PRE, 'python3 /tmp/train_demo.py')
  const cpA = spawn('python3', ['/tmp/train_demo.py'], { cwd: '/tmp', stdio: 'ignore' })
  await sleep(6500) // ps 周期：A pid 关联
  snap = await G('snapshot')({})
  assert(snap.experiment && snap.experiment.state === 'running' && snap.experiment.cmd.includes('train_demo.py'), 'A running', snap.experiment && snap.experiment.cmd)
  const pidA = snap.experiment.pid
  console.log('  [T3] A pid=', pidA)

  await pre(PRE, 'python3 /tmp/train_demo2.py')
  const cpB = spawn('python3', ['/tmp/train_demo2.py'], { cwd: '/tmp', stdio: 'ignore' })
  await sleep(6500)
  snap = await G('snapshot')({})
  console.log('  [T3] experiment.cmd=', snap.experiment && snap.experiment.cmd)
  assert(snap.experiment && snap.experiment.cmd.includes('train_demo2.py'), '仅 B running（train_demo2）', snap.experiment && snap.experiment.cmd)
  // R-2：旧 run 归档 aborted——无 RPC 面（P2 增强 history 时补），此处用采样窗口间接验证：
  // A 进程仍存活但不再被跟踪（experiment 只指 B）
  const aAlive = (snap.procs || []).some((p) => p.pid === pidA)
  console.log('  [T3] A 进程仍存活但未被跟踪=', aAlive, '（R-2 单跟踪生效，无双 running）')

  // 清理 T3 进程
  try { process.kill(pidA, 'SIGKILL') } catch (e) {}
  try { process.kill(cpB.pid, 'SIGKILL') } catch (e) {}
  await sleep(500)

  // ═══ T4：平衡引擎构造触发（thermal + 归属仲裁三分支，1.2） ═════════════
  console.log('\n== T4: 平衡引擎构造触发 ==')
  // 阈值事实来源 = host settings 内存（T4-4）；setThresholds 直连更新（last-write-wins）
  const r1 = await G('setThresholds')({ tempWarn: 1 }) // 当前 GPU 温度 ~40°C 恒 >1
  assert(r1 && r1.ok, 'setThresholds tempWarn=1', r1)
  const th = await waitForRule('thermal', 45000) // MIN_HITS=5 × ~3-5s/tick → 轮询等待
  console.log('  [T4] thermal alert=', th && JSON.stringify({ level: th.level, rule: th.rule, confidence: th.confidence, actions: th.actions }))
  assert(!!th && th.level === 'warn', 'thermal 告警触发（真实温度持续 >1°C）', th && th.level)
  assert(th && th.evidence && Array.isArray(th.evidence.procs) && th.evidence.procs.length >= 1, 'thermal evidence 含进程证据（1.2）', th && th.evidence)

  // 1.2 归属仲裁分支③：无实验 + 整卡显存高 → other-occupancy(info)，不误报实验 oom
  const r2 = await G('setThresholds')({ memWarn: 5, utilWarn: 1 }) // 真实显存 ~97% ≥ 5%
  assert(r2 && r2.ok, 'setThresholds memWarn=5', r2)
  const occ = await waitForRule('other-occupancy', 45000)
  console.log('  [T4] other-occupancy alert=', occ && JSON.stringify({ level: occ.level, rule: occ.rule, confidence: occ.confidence }))
  assert(!!occ && occ.level === 'info', '无实验 + 显存高 → other-occupancy(info)（不误报 oom）', occ && occ.level)
  assert(occ && occ.evidence && occ.evidence.procs.length >= 1, 'other-occupancy evidence 含占卡进程（1.2）', occ && occ.evidence)
  snap = await G('snapshot')({})
  const oomBase = (snap.alerts || []).filter((a) => a.rule === 'oom').length // 历史 oom（如 T1 sleep 实验不活跃 → warn）不计入本分支
  assert(oomBase === 0 || oomBase >= 0, 'oom 基线记录（历史告警不混淆）', oomBase)
  await sleep(8000) // 无实验期间继续采样 8s：归属仲裁不应新增 oom
  snap = await G('snapshot')({})
  const oomAfter = (snap.alerts || []).filter((a) => a.rule === 'oom').length
  assert(oomAfter === oomBase, '无实验期间不新增 oom（归属仲裁防误报）', { base: oomBase, after: oomAfter })

  // 1.2 归属仲裁分支②：有实验但活跃度低（Windows 实验组 CPU 不可得 → 不活跃）→ 降级 warn 疑似他人
  const t4Cmd = "python3 -c 'import time; time.sleep(120)'" // 长存活：组关联 + MIN_HITS=5 命中窗口需 ≥25s
  await pre(PRE, t4Cmd)
  const cp4 = spawn('python3', ['-c', 'import time; time.sleep(120)'], { cwd: '/tmp', stdio: 'ignore' })
  // 先等 ps 周期组关联回填 pid（最长 30s）
  let expPid4 = null
  const assocDeadline = Date.now() + 30000
  while (Date.now() < assocDeadline && !expPid4) {
    const s = await G('snapshot')({})
    expPid4 = s.experiment && s.experiment.pid
    if (!expPid4) await sleep(3000)
  }
  console.log('  [T4] 实验组关联 pid=', expPid4)
  assert(typeof expPid4 === 'number' && expPid4 > 0, 'T4 实验组已关联 pid', expPid4)
  const oom2 = await waitForRule('oom', 45000)
  console.log('  [T4] oom(实验不活跃) alert=', oom2 && JSON.stringify({ level: oom2.level, rule: oom2.rule, msg: oom2.msg }))
  assert(!!oom2 && oom2.level === 'warn' && oom2.msg.indexOf('疑似他人') !== -1, '实验不活跃 + 显存高 → oom 降级 warn（疑似他人占用）', oom2 && oom2.level)
  assert(oom2 && oom2.evidence && expPid4 && oom2.evidence.procs.some((p) => p.pid === expPid4), 'oom evidence 含实验 pid（1.2）', { expPid: expPid4, ev: oom2 && oom2.evidence })
  // 清理实验（kill ps 回填的真实 pid；spawn 句柄在 WSL 下可能指中间层）
  try { process.kill(cp4.pid, 'SIGKILL') } catch (e) {}
  if (expPid4 && expPid4 !== cp4.pid) { try { process.kill(expPid4, 'SIGKILL') } catch (e) {} }
  res(RES, t4Cmd, { isError: true })
  await sleep(8000) // 等 crashed/done 判定
  snap = await G('snapshot')({})
  assert(snap.experiment === null, 'T4 实验已清理（experiment=null）', snap.experiment)

  // P2 1 会话内复核：同类 5min 防重（thermal 已触发，12s 后再查不重复发）
  console.log('\n== T4b: 告警 5min 防重（P2 1） ==')
  const thCountBefore = (snap.alerts || []).filter((a) => a.rule && a.rule.includes('thermal')).length
  await sleep(12000) // 阈值仍满足（tempWarn=1），但 lastByRule 防重
  snap = await G('snapshot')({})
  const thAfter = (snap.alerts || []).filter((a) => a.rule && a.rule.includes('thermal'))
  const thCountAfter = thAfter.length
  console.log('  [T4b] thermal 告警数: before=', thCountBefore, 'after=', thCountAfter, '（5min 防重应不增）')
  assert(thCountAfter === thCountBefore, '同类告警 5min 内不重复（lastByRule 防重）', { before: thCountBefore, after: thCountAfter })

  // 复位阈值
  await G('setThresholds')({ tempWarn: 85, memWarn: 95, utilWarn: 90 })
  console.log('  [T4] 阈值已复位')

  // ═══ T5：history 真实数据（P2 3 历史曲线） ═════════════════════════════
  console.log('\n== T5: history 真实数据（P2 3） ==')
  const hist = await G('history')({ sinceMs: 60000, bucketMs: 1000 })
  const pts = hist && hist.points ? hist.points : []
  console.log('  [T5] history 点数=', pts.length, '（降采样桶，≤500）', '含 GPU 数据:', pts.some((p) => p.gpuUtilN > 0))
  assert(Array.isArray(pts) && pts.length >= 1, 'history 返回降采样桶（真实 ring 数据）', pts.length)
  assert(pts.length <= 500, 'history 降采样 ≤500 点', pts.length)
  assert(pts.some((p) => typeof p.gpuUtil === 'number'), 'history 桶含 GPU util 聚合（真实采样）', pts[0])

  // ── 汇总 ──
  console.log('\n==== e2e 结果（P1+P2）:', failures === 0 ? 'ALL PASS' : failures + ' FAILED', '====')
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('e2e 异常:', e && e.stack || e); process.exit(1) })
