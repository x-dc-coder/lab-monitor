// ============================================================
// backend-linux.js —— LinuxBackend：/proc + ps，零依赖
// 位置：plugin/host/sampler/backend-linux.js
// concat 顺序第 3（D4-1）；纯 Linux 场景（WSL 内核视角 /proc）
// ============================================================
// 指标来源（实证 08 §1.6）：
//   CPU: /proc/stat 两次采样差分（psutil 算法：首帧丢弃、负值截 0）
//   内存: /proc/meminfo（MemTotal/MemAvailable，kB→MiB）
//   进程: ps -eo pid,pcpu,pmem,args（低频 5s 由上层控制）

var LAB = LAB || {}

LAB.LinuxBackend = function LinuxBackend(runner) {
  this.runner = runner
  this.id = 'linux'
  this.cacheTtlMs = 1000
  this.lastCpuTimes = null // CPU 差分基线（首帧丢弃）
}

// ① 探测：/proc 可读即可用（绝不抛错）
LAB.LinuxBackend.prototype.probe = async function probe() {
  try {
    const r = await this.runner.exec('cat /proc/version 2>/dev/null | head -1')
    if (r.code !== 0) return { ok: false, reason: 'cannot read /proc/version: ' + (r.stderr || '') }
    return { ok: true, detail: { kernel: (r.stdout || '').trim().slice(0, 80) } }
  } catch (e) {
    return { ok: false, reason: 'probe exception: ' + e.message }
  }
}

// /proc/meminfo → { totalMiB, availableMiB }（kB→MiB，向下取整）
LAB.LinuxBackend.prototype._readMeminfo = async function _readMeminfo() {
  const r = await this.runner.exec('cat /proc/meminfo 2>/dev/null')
  if (r.code !== 0) return null
  const m = {}
  for (const line of (r.stdout || '').split('\n')) {
    const mm = line.match(/^(\w+):\s+(\d+)\s*kB/)
    if (mm) m[mm[1]] = parseInt(mm[2], 10)
  }
  if (!m.MemTotal) return null
  return {
    totalMiB: Math.round(m.MemTotal / 1024),
    availableMiB: m.MemAvailable ? Math.round(m.MemAvailable / 1024) : Math.round((m.MemFree || 0) / 1024),
  }
}

// /proc/stat 首行 → { idle, total, at }（jiffies 差分）
LAB.LinuxBackend.prototype._readStat = async function _readStat() {
  const r = await this.runner.exec('cat /proc/stat 2>/dev/null | head -1')
  if (r.code !== 0) return null
  const parts = (r.stdout || '').trim().split(/\s+/).slice(1).map(Number)
  if (parts.length < 4) return null
  const idle = parts[3] + (parts[4] || 0)
  const total = parts.reduce(function (a, b) { return a + b }, 0)
  return { idle: idle, total: total, at: Date.now() }
}

// CPU 差分（psutil 算法）：首帧返回 null（丢弃）；负值截 0
LAB.LinuxBackend.prototype._cpuPercent = function _cpuPercent(cur) {
  var prev = this.lastCpuTimes
  this.lastCpuTimes = cur
  if (!prev) return null
  var dTotal = cur.total - prev.total
  if (dTotal <= 0) return 0
  var dIdle = cur.idle - prev.idle
  var pct = (1 - Math.max(dIdle, 0) / dTotal) * 100
  return Math.round(Math.max(pct, 0) * 10) / 10
}

// ② 快照：全量规范化输出（协议 docs/03-protocol.md §2.1）
LAB.LinuxBackend.prototype.snapshot = async function snapshot() {
  var ts = Date.now()
  var self = this
  var results = await Promise.all([
    this._readMeminfo(),
    this._readStat(),
    this.runner.exec('ps -eo pid=,pcpu=,pmem=,args= --no-headers 2>/dev/null | head -100'),
  ])
  var mem = results[0]
  var stat = results[1]
  var psOut = results[2]
  var cpu = { percent: null, cores: null }
  if (stat) cpu.percent = this._cpuPercent(stat)
  var procs = []
  if (psOut && psOut.code === 0) {
    for (var line of (psOut.stdout || '').split('\n')) {
      var mm = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/)
      if (mm) {
        procs.push({
          pid: parseInt(mm[1], 10),
          cmd: mm[4],
          cpuPct: parseFloat(mm[2]),
          memMiB: null, // 协议预留；ps pmem 为百分比，换算需总内存，暂不提供
        })
      }
    }
  }
  return {
    ts: ts,
    platform: 'linux',
    sources: { cpu: 'procfs', mem: 'procfs', procs: 'ps' },
    cpu: cpu,
    mem: mem || { totalMiB: null, availableMiB: null },
    procs: procs,
  }
}

// ③ 流：Linux 后端无 GPU 流能力（GPU 在 Windows 侧）
LAB.LinuxBackend.prototype.stream = function stream() {
  return null
}

// ④ 关闭：清差分基线（无子进程）
LAB.LinuxBackend.prototype.close = async function close() {
  this.lastCpuTimes = null
}
