#!/usr/bin/env node
/**
 * verify-daemon.js — lab-monitord 独立验证（无 DSH、无长跑）
 *
 * Given/When/Then 断言集：
 *  1. config 默认值与 THRESHOLD_DEFAULTS（src/core/constants.ts）一致
 *  2. POST 无 bearer → 403；GET snapshot → 200（临时服务器，ephemeral port）
 *  3. 注入抛错的 sink 不影响采样 tick（隔离性）
 *  4. MCP initialize + tools/list 返回 lab_status/lab_advice/lab_ctl
 *  5. flock/单实例：second start（同 home + 同端口被占）→ 拒绝启动不产生第二个采样器
 *
 * 环境约束：一律用 ephemeral port（listen(0)），绝不碰 8730；finally 中关服。
 * 运行前置：pnpm build（import 的是 lib/types 下的 tsc 产物）。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
process.env.LAB_MONITOR_HOME = mkdtempSync(join(tmpdir(), 'lab-mon-verify-cfg-'))
process.env.LAB_MONITOR_STATE_HOME = mkdtempSync(join(tmpdir(), 'lab-mon-verify-state-'))

let passed = 0
let failed = 0
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name) }
  else { failed++; console.log('FAIL  ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')) }
}

const { THRESHOLD_DEFAULTS, MAX_PARALLEL_RUNS } = await import(repo + '/lib/types/core/constants.js')
const { loadConfig, ensureToken } = await import(repo + '/lib/types/daemon/config-store.js')
const { createDaemon } = await import(repo + '/lib/types/daemon/main.js')
const { decideAdoption, ADOPT_COOLDOWN_MS } = await import(repo + '/lib/types/daemon/engine.js')

const home = process.env.LAB_MONITOR_HOME
const stateHome = process.env.LAB_MONITOR_STATE_HOME

async function main() {
  // ── 1. Given 默认配置加载 When 读取阈值 Then 与 THRESHOLD_DEFAULTS 全等 ──
  const cfg = loadConfig(home)
  const keys = Object.keys(THRESHOLD_DEFAULTS)
  for (const k of keys) {
    check('thresholds.' + k + ' === ' + THRESHOLD_DEFAULTS[k], cfg.thresholds[k] === THRESHOLD_DEFAULTS[k], cfg.thresholds[k])
  }

  // token 生成：0600、非空
  const token = ensureToken(home)
  const st = (await import('node:fs')).statSync(join(home, 'token'))
  check('token file created with mode 0600', (st.mode & 0o777) === 0o600, st.mode & 0o777)
  check('token non-empty hex', typeof token === 'string' && token.length >= 32, token && token.length)

  // 收养：纯函数（不读进程表）。满员必须拒绝；冷却至少 60s，未过期不得 adopt。
  check('ADOPT_COOLDOWN_MS >= 60000', ADOPT_COOLDOWN_MS >= 60000, ADOPT_COOLDOWN_MS)
  check('adoption refused at MAX_PARALLEL_RUNS', decideAdoption({ runningCount: MAX_PARALLEL_RUNS, maxParallel: MAX_PARALLEL_RUNS, lastAdoptAt: null, now: 1_000_000 }) === 'at-cap')
  check('adoption allowed one under cap', decideAdoption({ runningCount: MAX_PARALLEL_RUNS - 1, maxParallel: MAX_PARALLEL_RUNS, lastAdoptAt: null, now: 1_000_000 }) === 'adopt')
  check('adoption cooldown blocks re-adopt', decideAdoption({ runningCount: 0, maxParallel: MAX_PARALLEL_RUNS, lastAdoptAt: 1_000_000, now: 1_000_000 + ADOPT_COOLDOWN_MS - 1 }) === 'cooldown')
  check('adoption allowed once cooldown elapsed', decideAdoption({ runningCount: 0, maxParallel: MAX_PARALLEL_RUNS, lastAdoptAt: 1_000_000, now: 1_000_000 + ADOPT_COOLDOWN_MS }) === 'adopt')

  // ── 2. HTTP 面（ephemeral port）────────────────────────────────────────
  // health() 只回放 onExperimentEnd 写入的内部计数。框架若跳过 sink，calls/failed 保持 0，断言失败。
  const sinkState = { calls: 0, lastError: null, failed: 0 }
  const throwingSink = {
    kind: 'experiment-record',
    id: 'boom',
    enabled: true,
    async init() {},
    onExperimentEnd() {
      sinkState.calls += 1
      sinkState.failed += 1
      sinkState.lastError = 'sink boom (intentional)'
      throw new Error('sink boom (intentional)')
    },
    health() {
      return {
        state: sinkState.failed > 0 ? 'error' : 'ok',
        lastRunAt: sinkState.calls ? Date.now() : null,
        lastError: sinkState.lastError,
        consecutiveFailures: sinkState.failed,
        nextAttemptAt: null,
        stats: { ok: 0, failed: sinkState.failed, skipped: 0 },
      }
    },
    async shutdown() {},
  }
  // skipBackend：不起真实采样后端。testBackend 让 tickOnce 把样本推进 ring（证明第二次采样被记下）。
  let sampleSeq = 0
  const testBackend = {
    id: 'stub',
    cacheTtlMs: 0,
    lastCpuTimes: null,
    async probe() { return { ok: true } },
    async snapshot() {
      sampleSeq += 1
      return {
        ts: 1700000000000 + sampleSeq * 10000,
        platform: 'linux',
        sources: { cpu: 'stub', mem: 'stub', procs: 'stub' },
        cpu: { percent: 3, cores: 2 },
        mem: { totalMiB: 2048, availableMiB: 1024 },
        gpu: [],
        procs: [],
      }
    },
    stream() { return null },
    async close() {},
  }
  const daemon = await createDaemon({ home, stateHome, port: 0, sinks: [throwingSink], skipBackend: true, testBackend })
  const port = daemon.port
  check('ephemeral port bound (never 8730)', Number.isInteger(port) && port > 0 && port !== 8730, port)
  const base = 'http://127.0.0.1:' + port

  try {
    // Given daemon up When GET /health Then ok:true + protocolVersion
    const h = await (await fetch(base + '/health')).json()
    check('GET /health ok', h && h.ok === true && typeof h.uptimeMs === 'number' && !!h.protocolVersion, h)

    // Given daemon up When GET snapshot (no token) Then 200 + required fields
    const snap = await (await fetch(base + '/lab-monitor/api/snapshot')).json()
    for (const k of ['ts', 'platform', 'gpu', 'cpu', 'mem', 'procs', 'experiment', 'experiments', 'alerts', 'enabled']) {
      check('snapshot has ' + k, Object.prototype.hasOwnProperty.call(snap, k))
    }
    check('snapshot enabled boolean', typeof snap.enabled === 'boolean')

    // Given POST without bearer When POST control Then 403
    const r403 = await fetch(base + '/lab-monitor/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) })
    check('POST without bearer -> 403', r403.status === 403, r403.status)

    // Given wrong bearer When POST Then 403
    const rBad = await fetch(base + '/lab-monitor/api/control', { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{"action":"pause"}' })
    check('POST with wrong bearer -> 403', rBad.status === 403, rBad.status)

    // Given valid bearer When POST control pause Then 200 and snapshot.enabled=false
    const rPause = await fetch(base + '/lab-monitor/api/control', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) })
    const pauseBody = await rPause.json()
    check('POST control pause -> 200', rPause.status === 200 && pauseBody.ok === true, pauseBody)
    const snap2 = await (await fetch(base + '/lab-monitor/api/snapshot')).json()
    check('paused snapshot enabled=false', snap2.enabled === false)

    // resume + set-threshold
    const rResume = await fetch(base + '/lab-monitor/api/control', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) })
    check('POST control resume -> 200', rResume.status === 200)
    const rSt = await fetch(base + '/lab-monitor/api/control', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set-threshold', thresholds: { memWarn: 91 } }) })
    const stBody = await rSt.json()
    check('POST control set-threshold -> 200 applied', rSt.status === 200 && stBody.ok === true, stBody)
    const snap3 = await (await fetch(base + '/lab-monitor/api/snapshot')).json()
    check('applied threshold visible in snapshot', snap3.thresholds && snap3.thresholds.memWarn === 91, snap3.thresholds)

    // body limit: > 1MiB -> 413
    const big = 'x'.repeat(1024 * 1024 + 16)
    const r413 = await fetch(base + '/lab-monitor/api/control', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause', pad: big }) })
    check('oversized POST body -> 413', r413.status === 413, r413.status)

    // SSE: no token -> 401
    const sseNo = await fetch(base + '/lab-monitor/events')
    check('SSE without token -> 401', sseNo.status === 401, sseNo.status)
    const sseOk = await fetch(base + '/lab-monitor/events', { headers: { Authorization: 'Bearer ' + token } })
    check('SSE with token -> 200 text/event-stream', sseOk.status === 200 && String(sseOk.headers.get('content-type') || '').includes('text/event-stream'), sseOk.status)
    await sseOk.body.cancel()

    // daemon.json written (asserted before the second instance test mutates it)
    const dj = JSON.parse(readFileSync(join(stateHome, 'daemon.json'), 'utf8'))
    check('daemon.json written', dj && dj.pid === process.pid && dj.url === base && typeof dj.startedAt === 'number', dj)

    // ── 3. 抛错 sink 不拒绝采样 tick ──
    // Given a sink whose onExperimentEnd throws When dispatchExperimentEnd + tick Then no rejection, engine still samples
    let threw = false
    try {
      await daemon.dispatchExperimentEnd({ run: { runId: 'run-test-001', state: 'done' }, series: [], summary: {}, tagHits: [] })
      await new Promise((r) => setImmediate(r))
      await daemon.tickOnce()
    } catch (e) {
      threw = true
      console.log('  unexpected:', e && e.message)
    }
    check('throwing sink does not reject tick', !threw)
    const snapAfter = await (await fetch(base + '/lab-monitor/api/snapshot')).json()
    const sinkHealth = (snapAfter.sinks || []).find((s) => s.id === 'boom')
    check(
      'framework invoked throwing sink (health derived from call, not hardcoded)',
      sinkState.calls >= 1 && sinkHealth && sinkHealth.lastError === sinkState.lastError && sinkHealth.stats && sinkHealth.stats.failed >= 1,
      { calls: sinkState.calls, sinkHealth },
    )
    const histLen = async () => {
      const h = await daemon.engine.dispatch('history', { sinceMs: 0, bucketMs: 1 })
      return h && Array.isArray(h.points) ? h.points.length : -1
    }
    const beforeN = await histLen()
    await daemon.tickOnce()
    await daemon.tickOnce()
    const afterN = await histLen()
    check('second sample recorded after sink failure', afterN >= beforeN + 2, { beforeN, afterN, sampleSeq })

    // ── 4. MCP ──
    const mcpPost = async (body) => {
      const r = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: r.status, json: await r.json() }
    }
    const mcpNoAuth = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' })
    check('MCP without token -> 401', mcpNoAuth.status === 401, mcpNoAuth.status)
    const init = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'verify', version: '0' } } })
    check('MCP initialize -> protocolVersion', init.status === 200 && init.json.result && typeof init.json.result.protocolVersion === 'string', init.json)
    const list = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const names = (list.json.result && list.json.result.tools ? list.json.result.tools : []).map((t) => t.name).sort()
    check('MCP tools/list has the three tools', JSON.stringify(names) === JSON.stringify(['lab_advice', 'lab_ctl', 'lab_status']), names)
    const call = await mcpPost({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lab_status', arguments: { brief: true } } })
    check('MCP tools/call lab_status works', call.status === 200 && call.json.result && !call.json.result.isError, call.json)

    // allowControl=false -> lab_ctl refused (separate daemon instance on another ephemeral port)
    const daemon2 = await createDaemon({ home, stateHome, port: 0, mcpAllowControl: false, skipBackend: true })
    try {
      const b2 = 'http://127.0.0.1:' + daemon2.port
      const ctl = await fetch(b2 + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'lab_ctl', arguments: { action: 'pause' } } }) })
      const cj = await ctl.json()
      check('MCP lab_ctl refused when allowControl=false', cj.result && cj.result.isError === true, cj)
    } finally { await daemon2.close() }

    // ── 5. 单实例：同 home + 端口被占 → createDaemon 拒绝 ──
    // Given port already bound by daemon When second createDaemon same port Then rejects, first still healthy
    let dupRejected = false
    try {
      await createDaemon({ home, stateHome, port, sinks: [] })
    } catch (e) {
      dupRejected = true
    }
    check('second start on same port rejected', dupRejected)
    const h2 = await (await fetch(base + '/health')).json()
    check('first instance still healthy after dup attempt', h2 && h2.ok === true)

    // script-level flock: second `run` via flock must exit 0 with lock held by first instance
    // Given lock held by an external flock process When `lab-monitord.sh run` Then exits 0 without starting
    const lockFile = join(stateHome, 'daemon.lock')
    writeFileSync(lockFile, '')
    const holder = spawn('bash', ['-c', 'flock -n "$1" sleep 6', '_', lockFile], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 400)) // let flock acquire
    check('flock holder acquired lock', holder.exitCode === null)
    const sh = spawn('bash', [join(repo, 'scripts', 'lab-monitord.sh'), 'run', '--lock-file', lockFile, '--entry', join(repo, 'lib', 'types', 'daemon', 'main.js')], { stdio: ['ignore', 'pipe', 'pipe'] })
    let shOut = ''
    sh.stdout.on('data', (d) => { shOut += String(d) })
    sh.stderr.on('data', (d) => { shOut += String(d) })
    const shCode = await new Promise((resolve) => {
      const t = setTimeout(() => { try { sh.kill('SIGKILL') } catch {} ; resolve(-1) }, 8000)
      sh.on('exit', (c) => { clearTimeout(t); resolve(c) })
    })
    try { holder.kill('SIGKILL') } catch {}
    check('second run under held flock exits 0 without starting', shCode === 0 && shOut.includes('lock held'), { code: shCode, out: shOut.trim().slice(0, 200) })
  } finally {
    await daemon.close()
    try { rmSync(home, { recursive: true, force: true }) } catch {}
    try { rmSync(stateHome, { recursive: true, force: true }) } catch {}
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  if (failed > 0) process.exit(1)
}

main().then(
  () => process.exit(failed > 0 ? 1 : 0),
  (e) => { console.error('verify-daemon fatal:', e); process.exit(1) },
)
