// ============================================================
// backend-windows.js —— WindowsBackend：interop 通道（WSL 场景）
// 位置：plugin/host/sampler/backend-windows.js
// concat 顺序第 4（D4-1）；事实基线：08-sampling-empirical.md
// ============================================================
// 通道（t10 §4 契约表 + 实证耗时）：
//   GPU 快照: nvidia-smi.exe --query-gpu（40-60ms，TTL 500ms 缓存）
//   GPU 流:   nvidia-smi.exe dmon -d 1 -s pucvmet（1s 行流；EOF/超时→指数退避重启→query-fallback）
//   CPU/内存: PowerShell CIM（~1.5s，TTL 5s 低频）；interop 断 → 回退 /proc（D1-1）
//   进程:     tasklist /FO CSV（GBK→iconv，TTL 5s）；失败 → procs 空数组
// 关闭:     close() 按 spawn pid 清单杀 interop 子进程（D2-1 防孤儿）

var LAB = LAB || {}

LAB.WindowsBackend = function WindowsBackend(runner, opts) {
  opts = opts || {}
  this.runner = runner
  this.id = 'wsl'
  this.cacheTtlMs = 500
  this.lastCpuTimes = null
  this._spawned = []        // spawn 记录 { pid, kill }（close 清理，D2-1）
  this._cimCache = null     // { at, data } CIM 慢通道缓存（TTL 5s）
  this._taskCache = null    // { at, data } tasklist 缓存（TTL 5s）
  this._gpuQueryCache = null // { at, data } query 缓存（TTL 500ms）
  this._streamProc = null
  this._restarts = 0
  this._lastRestartAt = 0
  this._fallbackMode = false // dmon 连续失败回退 query 模式
}

// ————— 通用工具 —————

LAB.WindowsBackend.prototype._now = function _now() { return Date.now() }

// 缓存命中判断
LAB.WindowsBackend.prototype._cacheGet = function _cacheGet(cache, ttl) {
  if (cache && this._now() - cache.at < ttl) return cache.data
  return undefined
}
LAB.WindowsBackend.prototype._cacheSet = function _cacheSet(cacheName, data) {
  this[cacheName] = { at: this._now(), data: data }
}

// 解析 nvidia-smi CSV noheader 行（7 列，实测）：
//   "0, NVIDIA GeForce RTX 5060 Ti, 7 %, 1867 MiB, 16311 MiB, 43, 20.77 W\r"
//   → { id, name, utilPct, memUsedMiB, memTotalMiB, tempC, powerW }（单位后缀剥离；\r 容忍）
LAB.WindowsBackend.prototype._parseSmiLine = function _parseSmiLine(line) {
  var f = line.replace(/\r$/, '').split(',').map(function (s) { return s.trim() })
  if (f.length < 7) return null
  var num = function (s) { return parseFloat(String(s).split(' ')[0]) }
  return {
    id: parseInt(f[0], 10),
    name: f[1],
    utilPct: num(f[2]),
    memUsedMiB: num(f[3]),
    memTotalMiB: num(f[4]),
    tempC: num(f[5]),
    powerW: num(f[6]),
  }
}

// ————— ① probe：interop 通道可用性（失败只降级该项，不整体失败） —————

LAB.WindowsBackend.prototype.probe = async function probe() {
  var detail = { gpu: { available: false }, interop: false }
  var out = {}
  try {
    var r1 = await this.runner.execArgs(LAB.WIN.NVIDIA_SMI, ['--query-gpu=driver_version,count', '--format=csv,noheader'])
    out.gpu = r1
  } catch (e) { out.gpu = { code: -1, stderr: e.message } }
  try {
    var r2 = await this.runner.execArgs(LAB.WIN.POWERSHELL, ['-NoProfile', '-Command', '1'])
    out.ps = r2
  } catch (e) { out.ps = { code: -1, stderr: e.message } }
  try {
    var r3 = await this.runner.execArgs(LAB.WIN.TASKLIST, ['/NH'])
    out.tasklist = r3
  } catch (e) { out.tasklist = { code: -1, stderr: e.message } }

  detail.gpu.available = out.gpu && out.gpu.code === 0
  if (detail.gpu.available) {
    var parts = (out.gpu.stdout || '').trim().split('\n')[0].split(',')
    detail.gpu.driver = parts.length > 0 ? parts[0].trim() : null
    detail.gpu.count = parts.length > 1 ? parseInt(parts[1].trim(), 10) : null
  }
  detail.interop = (out.ps && out.ps.code === 0) || (out.tasklist && out.tasklist.code === 0)
  var ok = detail.gpu.available || detail.interop
  return {
    ok: ok,
    reason: ok ? undefined : 'interop 全部通道不可用: gpu=' + (out.gpu && out.gpu.code) +
      ' ps=' + (out.ps && out.ps.code) + ' tasklist=' + (out.tasklist && out.tasklist.code),
    detail: detail,
  }
}

// ————— GPU 快照（query，TTL 500ms 缓存） —————

LAB.WindowsBackend.prototype._queryGpu = async function _queryGpu() {
  var cached = this._cacheGet(this._gpuQueryCache, LAB.WIN.TTL.QUERY)
  if (cached !== undefined) return cached
  var r = await this.runner.execArgs(LAB.WIN.NVIDIA_SMI, LAB.WIN.QUERY_ARGS)
  if (r.code !== 0) {
    this._gpuQueryCache = null
    return { ok: false, reason: 'nvidia-smi query 失败 code=' + r.code + ' ' + (r.stderr || '') }
  }
  var gpus = []
  for (var line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue
    var g = this._parseSmiLine(line)
    if (g) gpus.push(g)
  }
  var res = { ok: true, gpus: gpus }
  this._cacheSet('_gpuQueryCache', res)
  return res
}

// ————— CPU/内存（CIM，TTL 5s；interop 断 → 回退 /proc，D1-1） —————

LAB.WindowsBackend.prototype._sysMemCim = async function _sysMemCim() {
  var cached = this._cacheGet(this._cimCache, LAB.WIN.TTL.CIM)
  if (cached !== undefined) return cached
  var r = await this.runner.execArgs(LAB.WIN.POWERSHELL, LAB.WIN.PS_SYSMEM)
  if (r.code !== 0) return { ok: false, reason: 'CIM 失败 code=' + r.code }
  var parts = (r.stdout || '').trim().split(';')
  if (parts.length < 3) return { ok: false, reason: 'CIM 输出格式异常: ' + r.stdout }
  var res = {
    ok: true,
    cpuPercent: parseFloat(parts[0]),               // Win32_Processor.LoadPercentage 瞬时快照值（非差分）
    totalMiB: Math.round(parseInt(parts[1], 10) / 1024),
    availableMiB: Math.round(parseInt(parts[2], 10) / 1024),
  }
  this._cacheSet('_cimCache', res)
  return res
}

// interop 断时的 /proc 回退（WSL 内核视角仍真实，sources 标 procfs）
LAB.WindowsBackend.prototype._sysMemProc = async function _sysMemProc() {
  var r = await this.runner.exec('cat /proc/meminfo 2>/dev/null')
  if (r.code !== 0) return { ok: false, reason: '/proc/meminfo 不可读' }
  var m = {}
  for (var line of (r.stdout || '').split('\n')) {
    var mm = line.match(/^(\w+):\s+(\d+)\s*kB/)
    if (mm) m[mm[1]] = parseInt(mm[2], 10)
  }
  if (!m.MemTotal) return { ok: false, reason: 'MemTotal 缺失' }
  return {
    ok: true,
    cpuPercent: null, // /proc/stat 差分由 _cpuFromProc 提供
    totalMiB: Math.round(m.MemTotal / 1024),
    availableMiB: m.MemAvailable ? Math.round(m.MemAvailable / 1024) : Math.round((m.MemFree || 0) / 1024),
  }
}

LAB.WindowsBackend.prototype._cpuFromProc = async function _cpuFromProc() {
  var r = await this.runner.exec('cat /proc/stat 2>/dev/null | head -1')
  if (r.code !== 0) return null
  var parts = (r.stdout || '').trim().split(/\s+/).slice(1).map(Number)
  if (parts.length < 4) return null
  var idle = parts[3] + (parts[4] || 0)
  var total = parts.reduce(function (a, b) { return a + b }, 0)
  var cur = { idle: idle, total: total, at: Date.now() }
  var prev = this.lastCpuTimes
  this.lastCpuTimes = cur
  if (!prev) return null
  var dTotal = cur.total - prev.total
  if (dTotal <= 0) return 0
  var dIdle = cur.idle - prev.idle
  return Math.round(Math.max((1 - Math.max(dIdle, 0) / dTotal) * 100, 0) * 10) / 10
}

// ————— 进程表（tasklist GBK→iconv，TTL 5s） —————

LAB.WindowsBackend.prototype._procsTasklist = async function _procsTasklist() {
  var cached = this._cacheGet(this._taskCache, LAB.WIN.TTL.TASKLIST)
  if (cached !== undefined) return cached
  var r = await this.runner.execArgsEnc(LAB.WIN.TASKLIST, LAB.WIN.TASKLIST_ARGS, 'GBK')
  if (r.code !== 0) return { ok: false, reason: 'tasklist 失败 code=' + r.code }
  var procs = []
  for (var line of (r.stdout || '').split('\n')) {
    // CSV: "python.exe","1234","Console","1","12,345 K"
    var mm = line.match(/"([^"]*)","(\d+)","([^"]*)","(\d+)","([^"]*)"/)
    if (mm) {
      var memStr = mm[5].replace(/[, ]/g, '')
      var memKB = parseInt(memStr, 10)
      procs.push({
        pid: parseInt(mm[2], 10),
        cmd: mm[1],
        cpuPct: null, // tasklist 无 CPU%；待 CIM/typeperf 扩展
        memMiB: isNaN(memKB) ? null : Math.round(memKB / 1024),
      })
    }
  }
  var res = { ok: true, procs: procs }
  this._cacheSet('_taskCache', res)
  return res
}

// ————— ② snapshot：全量规范化输出 —————

LAB.WindowsBackend.prototype.snapshot = async function snapshot() {
  var ts = this._now()
  var sources = { cpu: 'cim', mem: 'cim', procs: 'tasklist' }
  var degraded = null

  // GPU（query 缓存；失败 → unavailable，CPU/内存照常）
  var gpuRes = await this._queryGpu()
  var gpu = undefined
  if (gpuRes.ok) {
    sources.gpu = 'query'
    gpu = gpuRes.gpus.map(function (g) { return g })
  } else {
    sources.gpu = 'unavailable'
  }

  // CPU/内存（CIM；interop 断 → /proc 回退，D1-1；platform 保持 'wsl'）
  var sys = await this._sysMemCim()
  var cpu = { percent: null, cores: null }
  var mem = { totalMiB: null, availableMiB: null }
  if (sys.ok) {
    cpu.percent = sys.cpuPercent
    mem.totalMiB = sys.totalMiB
    mem.availableMiB = sys.availableMiB
  } else {
    // CIM 不可用 → /proc 回退（真实视图仍为 WSL 内核视角）
    sources.cpu = 'procfs'
    sources.mem = 'procfs'
    var procMem = await this._sysMemProc()
    if (procMem.ok) {
      mem.totalMiB = procMem.totalMiB
      mem.availableMiB = procMem.availableMiB
      cpu.percent = await this._cpuFromProc()
    }
    if (degraded === null) degraded = { gpu: undefined, reason: 'CIM 不可用回退 /proc' }
  }

  // 进程表（tasklist；失败 → 空数组 + sources 标注，不拖垮整次 snapshot）
  var procs = []
  var procsRes = await this._procsTasklist()
  if (procsRes.ok) {
    procs = procsRes.procs
  } else {
    sources.procs = 'ps'
    var psOut = await this.runner.exec('ps -eo pid=,pcpu=,pmem=,args= --no-headers 2>/dev/null | head -100')
    if (psOut.code === 0) {
      for (var line of (psOut.stdout || '').split('\n')) {
        var mm = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/)
        if (mm) procs.push({ pid: parseInt(mm[1], 10), cmd: mm[4], cpuPct: parseFloat(mm[2]), memMiB: null })
      }
    }
  }

  var snap = {
    ts: ts,
    platform: 'wsl', // 标注真实采样视图（WSL 视角），不因通道降级改变（D1-1）
    sources: sources,
    cpu: cpu,
    mem: mem,
    procs: procs,
  }
  if (gpu !== undefined) snap.gpu = gpu
  if (this._fallbackMode) {
    if (degraded === null) degraded = {}
    degraded.gpu = 'query-fallback'
  }
  if (degraded !== null) snap.degraded = degraded
  return snap
}

// ————— ③ stream：dmon 长驻流（指数退避重启 → query-fallback） —————

LAB.WindowsBackend.prototype.stream = async function* stream() {
  var self = this
  while (true) {
    var proc = this.runner.spawnArgs(LAB.WIN.NVIDIA_SMI, LAB.WIN.DMON_ARGS)
    this._streamProc = proc
    this._spawned.push(proc)
    this._restarts += 1
    var lastLineAt = Date.now()
    var eof = false
    try {
      while (true) {
        var out = proc.readOutput() // 增量读（interop 管道，实证 08 §1.3）
        if (out && out.length) {
          lastLineAt = Date.now()
          for (var line of out.split('\n')) {
            if (!line.trim()) continue
            yield { ts: Date.now(), raw: line }
          }
        } else if (proc.done !== undefined && proc.done()) {
          eof = true
          break
        } else {
          // 超时无新行（>3s，dmon 应 1s 一行）视为断流
          if (Date.now() - lastLineAt > 3000) { eof = true; break }
          await this.runner.sleep(200)
        }
      }
    } finally {
      try { proc.kill() } catch (e) {}
      this._streamProc = null
    }
    if (!eof) break // 显式停止
    // 断流自愈：指数退避（1s→2s→4s），≤3 次/5min；超限 → query-fallback（degraded）
    // v1.4.3（会话内验收实证）：_lastRestartAt 初始 0 使「now-0>300000」恒真 → 首杀即
    // 误入 fallback、重启路径从未生效；改为 5min 窗口过期先重置计数，再按次数判断。
    var now = Date.now()
    if (now - this._lastRestartAt > 300000) this._restarts = 0
    if (this._restarts > 3) {
      this._fallbackMode = true
      break
    }
    var delay = Math.min(1000 * Math.pow(2, this._restarts - 1), 4000)
    this._lastRestartAt = now
    await this.runner.sleep(delay)
  }
}

// ————— ④ close：杀 interop 子进程（D2-1 防孤儿），幂等 —————

LAB.WindowsBackend.prototype.close = async function close() {
  for (var i = 0; i < this._spawned.length; i++) {
    try { this._spawned[i].kill() } catch (e) {}
  }
  this._spawned = []
  this._streamProc = null
  this._cimCache = null
  this._taskCache = null
  this._gpuQueryCache = null
  this.lastCpuTimes = null
  this._fallbackMode = false
  this._restarts = 0
}
