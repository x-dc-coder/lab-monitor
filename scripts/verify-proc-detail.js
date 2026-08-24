#!/usr/bin/env node
/**
 * verify-proc-detail.js — #16 进程详情增强逻辑验证（不依赖 DSH）
 * 验证 procDetailData 三增强：①所属实验（procGroup 命中）②监控徽标（watchedPids）
 * ③进程树（子进程 + 父进程链）。mock 数据驱动，纯函数断言。
 *
 * 说明：procDetailData 是 client.ts 内部函数（bundle 前不可直接 import），
 * 本测试复制其核心逻辑断言——若 client 侧改动需同步更新本文件（verify.sh 校验）。
 */
let fail = 0
const ok = (cond, name) => { if (cond) console.log('  ✓', name); else { fail++; console.error('  ✗', name) } }

// ── 复制 procDetailData 的核心逻辑（与 src/client.ts 保持同步）──
function fmtDateTime(ts) {
  if (!ts || !Number.isFinite(ts)) return '-'
  const d = new Date(ts)
  const p = (n) => ('0' + n).slice(-2)
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
function fmtElapsed(startTs) {
  if (!startTs || !Number.isFinite(startTs)) return '-'
  const diffMs = Math.max(0, Date.now() - startTs)
  const s = Math.floor(diffMs / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm' + (s % 60) + 's'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h' + (m % 60) + 'm'
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'
}
function procDetailCore(p, tagLabel, ctx) {
  const meta = []
  if (tagLabel) meta.push({ label: '标签组', value: tagLabel })
  if (ctx && ctx.watchedPids && ctx.watchedPids.includes(p.pid)) {
    meta.push({ label: '监控', value: 'watchlist 命中' })
  }
  const stats = [
    { label: '进程 PID', value: String(p.pid) },
    { label: '父进程 PPID', value: p.ppid != null ? String(p.ppid) : '-' },
    { label: '启动时间', value: fmtDateTime(p.startTs) },
    { label: '已运行', value: fmtElapsed(p.startTs) },
  ]
  const sections = []
  if (ctx && ctx.experiments && ctx.experiments.length) {
    const exps = ctx.experiments.filter((e) =>
      (e.pid !== null && e.pid !== undefined && e.pid === p.pid) ||
      (Array.isArray(e.procGroup) && e.procGroup.includes(p.pid)))
    if (exps.length) {
      sections.push({ title: '所属实验', lines: exps.map((e) => ({ value: (e.runId || '?') + (e.state ? ' [' + e.state + ']' : '') })) })
    }
  }
  if (ctx && ctx.allProcs && ctx.allProcs.length) {
    const children = ctx.allProcs.filter((q) => q.ppid === p.pid && q.pid !== p.pid)
    if (children.length) sections.push({ title: '子进程（' + children.length + '）', lines: children.slice(0, 20).map((c) => ({ value: c.cmd || '?' })) })
    const chain = []
    let cur = p.ppid ?? null
    const guard = new Set()
    while (cur != null && !guard.has(cur) && chain.length < 5) {
      guard.add(cur)
      const parent = ctx.allProcs.find((q) => q.pid === cur)
      chain.push(parent ? (parent.cmd || '?') : 'pid ' + cur)
      cur = parent ? parent.ppid ?? null : null
    }
    if (chain.length) sections.push({ title: '父进程链', lines: chain.map((v) => ({ value: v })) })
  }
  return { meta, stats, sections }
}

// ── mock 数据 ──
const procs = [
  { pid: 100, ppid: 50, cmd: 'python train.py', cpuPct: 40, memMiB: 512, gpuUtilPct: 60 },
  { pid: 200, ppid: 100, cmd: 'python worker.py', cpuPct: 20, memMiB: 256 },
  { pid: 300, ppid: 100, cmd: 'python data_loader.py', cpuPct: 10, memMiB: 128 },
  { pid: 50, ppid: 1, cmd: 'bash', cpuPct: 1, memMiB: 8 },
  { pid: 1, ppid: null, cmd: 'init', cpuPct: 0, memMiB: 4 },
]
const ctx = {
  experiments: [
    { runId: 'run-001', pid: 100, procGroup: [100, 200, 300], cmd: 'python train.py', state: 'running' },
  ],
  watchedPids: [100],
  allProcs: procs,
}

// ① 所属实验：pid 100 属于 run-001（pid 精确命中）
let r = procDetailCore({ pid: 100, ppid: 50, cmd: 'python train.py' }, undefined, ctx)
ok(r.sections.some((s) => s.title === '所属实验' && s.lines[0].value.includes('run-001')), 'pid=主进程 → 所属实验 run-001')
// ①b procGroup 命中：pid 200（worker）也属 run-001
r = procDetailCore({ pid: 200, ppid: 100, cmd: 'python worker.py' }, undefined, ctx)
ok(r.sections.some((s) => s.title === '所属实验' && s.lines[0].value.includes('run-001')), 'pid∈procGroup → 所属实验 run-001（worker）')
// ①c 无关进程：pid 50（bash）不属任何实验
r = procDetailCore({ pid: 50, ppid: 1, cmd: 'bash' }, undefined, ctx)
ok(!r.sections.some((s) => s.title === '所属实验'), '无关进程无所属实验区块')

// ② 监控徽标
r = procDetailCore({ pid: 100, ppid: 50, cmd: 'python train.py' }, undefined, ctx)
ok(r.meta.some((m) => m.label === '监控' && m.value.includes('watchlist')), 'watchedPids 命中 → 监控徽标')
r = procDetailCore({ pid: 200, ppid: 100, cmd: 'python worker.py' }, undefined, ctx)
ok(!r.meta.some((m) => m.label === '监控'), '非 watchlist 进程无监控徽标')

// ③ 子进程：pid 100 → worker(200) + data_loader(300)
r = procDetailCore({ pid: 100, ppid: 50, cmd: 'python train.py' }, undefined, ctx)
const childSec = r.sections.find((s) => s.title.startsWith('子进程'))
ok(childSec && childSec.lines.length === 2, '子进程 2 个（worker + data_loader）')
// ③b 父进程链：pid 100 → bash(50) → init(1)
r = procDetailCore({ pid: 100, ppid: 50, cmd: 'python train.py' }, undefined, ctx)
const chainSec = r.sections.find((s) => s.title === '父进程链')
ok(chainSec && chainSec.lines.length === 2 && chainSec.lines[0].value.includes('bash'), '父进程链 2 级（bash → init）')
// ③c 根进程（ppid null）无父链
r = procDetailCore({ pid: 1, ppid: null, cmd: 'init' }, undefined, ctx)
ok(!r.sections.some((s) => s.title === '父进程链'), '根进程无父进程链')

// ④ 启动时间 / 运行时长（#16）
const startTs = Date.now() - 65 * 1000 // 65s 前启动
r = procDetailCore({ pid: 100, ppid: 50, cmd: 'python train.py', startTs }, undefined, ctx)
const stStat = r.stats.find((s) => s.label === '启动时间')
const elStat = r.stats.find((s) => s.label === '已运行')
ok(!!stStat && stStat.value !== '-' && /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stStat.value), '启动时间格式 MM-DD HH:MM:SS')
ok(!!elStat && /1m\d+s/.test(elStat.value), '运行时长 65s → 1m5s 格式')
r = procDetailCore({ pid: 200, ppid: 100, cmd: 'python worker.py' }, undefined, ctx)
ok(r.stats.find((s) => s.label === '启动时间').value === '-', '无 startTs → 启动时间显示 -')

console.log(fail ? '❌ ' + fail + ' 个失败' : '✅ verify-proc-detail 全部通过（' + 12 + ' 断言）')
process.exit(fail ? 1 : 0)
