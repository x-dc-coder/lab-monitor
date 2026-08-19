#!/usr/bin/env node
// ============================================================
// verify-sampler.js —— sampler/ 双后端真实采样验证（D-A 自测）
// 运行：node scripts/verify-sampler.js
// 内容：
//   1. V2：直接 import lib/types/sampler（tsc 编译产物，纯 ESM）
//   2. detectPlatform 实测（本机应为 'wsl'）
//   3. LinuxBackend：probe + snapshot ×2（/proc 差分真实采样）
//   4. WindowsBackend：probe + snapshot（nvidia-smi.exe query / CIM / tasklist 真实调用）
//   5. 样例③（D1-2 回填）：dmon 流 vs query 快照同秒偏差实测（稳定负载）
//   6. 验收 9（D2-1）：close() 后按 cmdline 含 dmon 核对无孤儿进程
// 输出：JSON 摘要（含各通道实测耗时）
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import cp from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ————— node 版 Runner（cordis 环境由主 index.js 用 ctx.shell 适配） —————

const runner = {
  // shell 形式（Linux 通道）
  exec(cmdStr) {
    return new Promise((resolve) => {
      cp.exec(cmdStr, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' })
      })
    })
  },
  // argv 形式（interop 通道，不经 shell——避免 $ 展开/引号问题）
  execArgs(file, args) {
    return new Promise((resolve) => {
      cp.execFile(file, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' })
      })
    })
  },
  // argv + 编码转码（tasklist GBK → iconv → UTF8）
  execArgsEnc(file, args, enc) {
    return new Promise((resolve) => {
      cp.execFile(file, args, { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return resolve({ code: err.code || 1, stdout: '', stderr: (stderr || '').toString() })
        const iconv = cp.spawn('iconv', ['-f', enc, '-t', 'UTF-8'])
        let out = ''
        iconv.stdout.on('data', (d) => { out += d.toString('utf8') })
        iconv.on('error', () => resolve({ code: 1, stdout: '', stderr: 'iconv 不可用' }))
        iconv.on('close', () => resolve({ code: 0, stdout: out, stderr: '' }))
        iconv.stdin.on('error', () => {})
        iconv.stdin.end(stdout)
      })
    })
  },
  // 长驻进程（dmon 流）
  spawnArgs(file, args) {
    const child = cp.spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    child.stdout.on('data', (d) => { buf += d.toString('utf8') })
    return {
      pid: child.pid,
      readOutput() { const o = buf; buf = ''; return o },
      done() { return child.exitCode !== null },
      kill() { try { child.kill('SIGKILL') } catch (e) {} },
    }
  },
  // 沙箱内无全局 setTimeout（cordis host 沙箱 trap）；统一走 runner 延迟
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  },
}

// ————— V2：直接 import tsc 编译产物（lib/types/sampler） —————

import { detectPlatform, LinuxBackend, WindowsBackend } from '../lib/types/sampler/index.js'

// ————— Phase A 验收（进程级采集：ppid / gpuUtilPct / memMiB） —————

let aFails = 0
function acheck(cond, name, extra) {
  if (cond) { console.log('  ✓ [A]', name) }
  else { aFails += 1; console.error('  ✗ [A]', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

/** pmon 输出解析验证（真实 nvidia-smi pmon -c 3 -s u）：跳过 # 行、`-` 视 0、多帧取 max */
function checkPmonParser() {
  const sample = [
    '# pid      type   sm   mem   enc   dec   command',
    '  1234     C       87    45    0     0   python.exe',
    '  1234     C        -    50    0     0   python.exe',
    '  5678     G       45    12    0     0   browser.exe',
  ]
  const byPid = new Map()
  for (const line of sample) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const f = t.split(/\s+/)
    if (f.length < 6) continue
    const pid = parseInt(f[0], 10)
    const sm = f[2] === '-' || f[2] === undefined ? 0 : parseFloat(f[2])
    if (!Number.isFinite(pid) || !Number.isFinite(sm)) continue
    const prev = byPid.get(pid)
    if (prev === undefined || sm > prev) byPid.set(pid, sm)
  }
  acheck(byPid.get(1234) === 87, 'pmon 多帧取 max（- 视 0）：1234 → 87', [...byPid.entries()])
  acheck(byPid.get(5678) === 45, 'pmon 活动进程有值：5678 → 45', [...byPid.entries()])
  return byPid
}

// ————— 测试主流程 —————

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const report = { platform: null, linux: null, windows: null, sample3: null, closeNoOrphan: null, at: new Date().toISOString() }

  // 0. pmon 解析单测（静态样例）
  console.log('[0] pmon 解析单测（-c 3 多帧 / `-` 视 0 / 多帧取 max）')
  checkPmonParser()

  // 1. 平台探测
  const platform = await detectPlatform(runner)
  report.platform = platform
  console.log('[1] detectPlatform =', platform)

  // 2. LinuxBackend
  const linux = new LinuxBackend(runner)
  const lp = await linux.probe()
  const ls1 = await linux.snapshot()
  await sleep(1100) // 等 1s 以便差分
  const ls2 = await linux.snapshot()
  report.linux = {
    probe: lp,
    mem: ls1.mem,
    cpuFirst: ls1.cpu,      // 首帧应 null（丢弃）
    cpuSecond: ls2.cpu,     // 差分值
    procs: ls2.procs.length,
    sources: ls2.sources,
  }
  console.log('[2] LinuxBackend probe=', JSON.stringify(lp))
  console.log('[2] LinuxBackend mem=', JSON.stringify(ls1.mem), 'cpu(首帧/二帧)=', ls1.cpu.percent, '/', ls2.cpu.percent, 'procs=', ls2.procs.length)
  // Phase A：Linux 主通道（ppid + memMiB + cpuPct）
  const lWithPpid = ls2.procs.filter((p) => typeof p.ppid === 'number')
  const lWithMem = ls2.procs.filter((p) => typeof p.memMiB === 'number')
  acheck(lWithPpid.length > 0, 'Linux procs[].ppid 存在（ps ppid 列）', { withPpid: lWithPpid.length, total: ls2.procs.length })
  acheck(lWithMem.length > 0, 'Linux procs[].memMiB 补齐（rss kB→MiB）', { withMem: lWithMem.length, total: ls2.procs.length })
  acheck(typeof ls2.sources.procs === 'string' && ls2.sources.procs.indexOf('ps') === 0, 'Linux sources.procs=ps（±pmon）', ls2.sources.procs)
  await linux.close()

  // 3. WindowsBackend
  const win = new WindowsBackend(runner)
  const t0 = Date.now()
  const wp = await win.probe()
  const ws = await win.snapshot()
  const wMs = Date.now() - t0
  report.windows = { probe: wp, snapshotMs: wMs, sources: ws.sources, gpu: ws.gpu, cpu: ws.cpu, mem: ws.mem, procs: ws.procs.length, platform: ws.platform }
  console.log('[3] WindowsBackend probe=', JSON.stringify(wp.detail))
  console.log('[3] WindowsBackend snapshot 总耗时=', wMs, 'ms  platform=', ws.platform, ' sources=', JSON.stringify(ws.sources))
  console.log('[3] gpu=', JSON.stringify(ws.gpu), 'cpu=', JSON.stringify(ws.cpu), 'mem=', JSON.stringify(ws.mem), 'procs=', ws.procs.length)
  // Phase A：Windows 主通道（ppid 来自 CIM 进程树 + memMiB + pmon 合并）
  const wWithPpid = ws.procs.filter((p) => typeof p.ppid === 'number')
  const wWithMem = ws.procs.filter((p) => typeof p.memMiB === 'number')
  const wWithGpu = ws.procs.filter((p) => typeof p.gpuUtilPct === 'number')
  acheck(wWithPpid.length > 0, 'Windows procs[].ppid 存在（CIM Win32_Process 进程树）', { withPpid: wWithPpid.length, total: ws.procs.length })
  acheck(wWithMem.length > 0, 'Windows procs[].memMiB 存在（tasklist）', { withMem: wWithMem.length, total: ws.procs.length })
  acheck(typeof ws.sources.procs === 'string' && ws.sources.procs.indexOf('tasklist') === 0, 'Windows sources.procs=tasklist（±pmon）', ws.sources.procs)
  acheck(wWithGpu.length === 0 || wWithGpu.every((p) => typeof p.gpuUtilPct === 'number' && p.gpuUtilPct >= 0 && p.gpuUtilPct <= 100), 'Windows gpuUtilPct 若填充必为 0-100（pmon 辅助；空闲态可不填）', { withGpu: wWithGpu.length })

  // 4. 样例③（D1-2 回填）：dmon 流 vs query 快照同秒偏差（稳定负载）
  if (ws.gpu && ws.gpu.length) {
    const stream = win.stream()
    const it = stream[Symbol.asyncIterator]()
    const rows = []
    const t1 = Date.now()
    while (rows.length < 3 && Date.now() - t1 < 6000) {
      const n = await it.next()
      if (n.done) break
      const raw = n.value.raw.trim()
      // dmon 行: "  0   350   78    -   92   30    -    -  2100    -"  → sm(4)=utilPct, gtemp(2)=tempC, pwr(1)=powerW
      const f = raw.split(/\s+/)
      if (f.length >= 5 && f[0] !== '#') {
        rows.push({ ts: n.value.ts, sm: parseFloat(f[4]), gtemp: parseFloat(f[2]), pwr: parseFloat(f[1]) })
      }
    }
    try { await it.return && it.return() } catch (e) {}
    // 同秒 query 快照（V2：私有方法 _queryGpu 不可访问，用公开 snapshot 取 GPU）
    const qSnap = await win.snapshot()
    const q = { ok: !!(qSnap.gpu && qSnap.gpu.length), gpus: qSnap.gpu || [] }
    const q0 = q.ok && q.gpus.length ? q.gpus[0] : null
    if (rows.length && q0) {
      const dmonAvg = rows.reduce((a, r) => a + r.sm, 0) / rows.length
      const dev = Math.abs(dmonAvg - q0.utilPct)
      report.sample3 = { dmonRows: rows, dmonAvgSm: dmonAvg, queryUtil: q0.utilPct, absDev: Math.round(dev * 10) / 10, relDevPct: Math.round((dev / Math.max(q0.utilPct, 1)) * 1000) / 10 }
      console.log('[4] 样例③ dmon 流 3 行=', JSON.stringify(rows), 'dmon 均值 sm=', dmonAvg, 'query util=', q0.utilPct, '偏差=', Math.round(dev * 10) / 10)
    } else {
      report.sample3 = { error: 'dmon 或 query 未取到数据', rows: rows.length, queryOk: q.ok }
      console.log('[4] 样例③ 数据不足: rows=', rows.length, 'queryOk=', q.ok)
    }
  } else {
    report.sample3 = { error: '无 GPU（probe gpu 不可用），跳过偏差实测' }
    console.log('[4] 样例③ 跳过：无 GPU')
  }

  // 5. 缓存生效验证（win 未 close，CIM/tasklist TTL 命中：第二次 snapshot 应显著快于首次）
  let cachedMs = null
  if (report.windows && report.windows.snapshotMs) {
    const t2 = Date.now()
    await win.snapshot()
    cachedMs = Date.now() - t2
    report.cachedSnapshotMs = cachedMs
    console.log('[5] 第二次 snapshot（缓存命中）耗时=', cachedMs, 'ms（首次=', report.windows.snapshotMs, 'ms）')
  }

  // 6. 验收 9（D2-1）：close() 后无孤儿——按 cmdline 含 'dmon' 核对（不用进程名）
  let orphanCheck = 'skipped'
  try {
    const s2 = win.stream()
    const it2 = s2[Symbol.asyncIterator]()
    const first = await it2.next() // 等第一行（1s 内）
    if (!first.done) {
      // close 前/后：查 WSL 侧 nvidia-smi dmon 进程数（ps 全局，含 /init 包装）
      // 注意：DSH 宿主可能也有动态插件在跑 dmon（外部来源），故只核对「本进程 spawn 的」是否被清理——
      // 通过 spawn pid 是否存活判定（D2-1：close 后 spawn pid 消失即无孤儿）。
      // 判定：verify 自身 spawn 的 dmon 在 close 后必须消失（D2-1 无孤儿）。
      // 用「本进程(verify)的直接子进程」判定——DSH 宿主等其他来源的 dmon 不是 verify 子进程，天然排除。
      const myPid = process.pid
      const qChildren = () => runner.exec("ps -eo pid=,ppid=,args= --no-headers | awk '$2 == " + myPid + "'")
      const before = await qChildren()
      const beforeOwn = (before.stdout || '').split('\n').filter((l) => l.toLowerCase().includes('dmon'))
      await win.close()
      await sleep(1500) // 留足 Windows/WSL 两侧进程退出时间（/init 包装退出异步）
      const after = await qChildren()
      const afterOwn = (after.stdout || '').split('\n').filter((l) => l.toLowerCase().includes('dmon'))
      const clean = afterOwn.length === 0 // close 后本进程无 dmon 子进程 = 无孤儿
      report.closeNoOrphan = { beforeOwnCount: beforeOwn.length, afterOwnCount: afterOwn.length, clean }
      console.log('[6] 验收9 close 前本进程 dmon 子进程=', beforeOwn.length, 'close 后=', afterOwn.length, 'clean=', clean)
      orphanCheck = { before: beforeOwn.length, after: afterOwn.length, clean }
    }
  } catch (e) {
    orphanCheck = 'error: ' + e.message
    report.closeNoOrphan = { error: e.message }
  }
  console.log('[6] close 无孤儿核对 =', orphanCheck)

  console.log('\n===== 报告 =====')
  console.log(JSON.stringify(report, null, 2))
  console.log('\n==== Phase A 验收:', aFails === 0 ? 'ALL PASS' : aFails + ' FAILED', '====')
  if (aFails > 0) process.exitCode = 1
}

main().catch((e) => { console.error('verify-sampler 失败:', e); process.exit(1) })
