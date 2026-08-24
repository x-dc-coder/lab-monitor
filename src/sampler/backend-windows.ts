/**
 * WindowsBackend：interop 通道（WSL 场景）
 * 通道（t10 §4 契约表 + 实证耗时）：
 *   GPU 快照: nvidia-smi.exe --query-gpu（40-60ms，TTL 500ms 缓存）
 *   GPU 流:   nvidia-smi.exe dmon -d 1 -s pucvmet（1s 行流；EOF/超时→指数退避重启→query-fallback）
 *   CPU/内存: PowerShell CIM（~1.5s，TTL 5s 低频）；interop 断 → 回退 /proc（D1-1）
 *   进程:     tasklist /FO CSV（GBK→iconv，TTL 5s）；失败 → procs 空数组
 * 关闭:     close() 按 spawn pid 清单杀 interop 子进程（D2-1 防孤儿）
 */
import type { GpuSample, ProcSample, ProbeResult, Runner, SamplerBackend, Snapshot } from './backend-interface.js'
import * as WIN from './windows-paths.js'

interface CacheEntry<T> {
  at: number
  data: T
}

export class WindowsBackend implements SamplerBackend {
  id = 'wsl' as const
  cacheTtlMs = 500
  lastCpuTimes: { idle: number; total: number; at: number } | null = null

  private runner: Runner
  private spawned: { kill(): void }[] = [] // spawn 记录（close 清理，D2-1）
  private cimCache: CacheEntry<{ ok: boolean; cpuPercent: number | null; totalMiB: number; availableMiB: number; ppidMap: Record<number, number>; reason?: string }> | null = null
  private taskCache: CacheEntry<{ ok: boolean; procs: ProcSample[]; reason?: string }> | null = null
  private gpuQueryCache: CacheEntry<{ ok: boolean; gpus: GpuSample[]; reason?: string }> | null = null
  private pmonCache: CacheEntry<{ ok: boolean; byPid: Map<number, number>; reason?: string }> | null = null
  private restarts = 0
  private lastRestartAt = 0
  private fallbackMode = false // dmon 连续失败回退 query 模式
  private closed = false // close() 后禁止流重启 spawn（D2-1 防孤儿根治）

  constructor(runner: Runner) {
    this.runner = runner
  }

  private now(): number {
    return Date.now()
  }

  /** 缓存命中判断 */
  private cacheGet<T>(cache: CacheEntry<T> | null, ttl: number): T | undefined {
    if (cache && this.now() - cache.at < ttl) return cache.data
    return undefined
  }

  private cacheSet<T>(slot: '_cimCache' | '_taskCache' | '_gpuQueryCache' | '_pmonCache', data: T): void {
    ;(this as unknown as Record<string, CacheEntry<T> | null>)[slot] = { at: this.now(), data }
  }

  /**
   * 解析 nvidia-smi CSV noheader 行（7 列，实测）：
   *   "0, NVIDIA GeForce RTX 5060 Ti, 7 %, 1867 MiB, 16311 MiB, 43, 20.77 W\r"
   *   → { id, name, utilPct, memUsedMiB, memTotalMiB, tempC, powerW }（单位后缀剥离；\r 容忍）
   * 2026-08-20：数值字段安全解析——nvidia-smi 在异常/驱动降级时会输出 "N/A"，parseFloat 得
   * NaN 后直达工具输出破坏 lossless JSON 校验；非有限数一律视为 0（该通道不可用降级语义）。
   */
  private parseSmiLine(line: string): GpuSample | null {
    const f = line.replace(/\r$/, '').split(',').map((s) => s.trim())
    if (f.length < 7) return null
    const num = (s: string): number => {
      const n = parseFloat(String(s).split(' ')[0])
      return Number.isFinite(n) ? n : 0
    }
    return {
      id: String(parseInt(f[0], 10)),
      name: f[1],
      utilPct: num(f[2]),
      memUsedMiB: num(f[3]),
      memTotalMiB: num(f[4]),
      tempC: num(f[5]),
      powerW: num(f[6]),
    }
  }

  /** ① probe：interop 通道可用性（失败只降级该项，不整体失败） */
  async probe(): Promise<ProbeResult> {
    const detail: Record<string, unknown> = { gpu: { available: false }, interop: false }
    const out: Record<string, { code: number; stdout?: string; stderr?: string }> = {}
    try {
      const r1 = await this.runner.execArgs(WIN.NVIDIA_SMI, ['--query-gpu=driver_version,count', '--format=csv,noheader'])
      out.gpu = r1
    } catch (e) {
      out.gpu = { code: -1, stderr: (e as Error).message }
    }
    try {
      const r2 = await this.runner.execArgs(WIN.POWERSHELL, ['-NoProfile', '-Command', '1'])
      out.ps = r2
    } catch (e) {
      out.ps = { code: -1, stderr: (e as Error).message }
    }
    try {
      const r3 = await this.runner.execArgs(WIN.TASKLIST, ['/NH'])
      out.tasklist = r3
    } catch (e) {
      out.tasklist = { code: -1, stderr: (e as Error).message }
    }

    const gpuDetail = detail.gpu as { available: boolean; driver?: string | null; count?: number | null }
    gpuDetail.available = !!out.gpu && out.gpu.code === 0
    if (gpuDetail.available) {
      const parts = (out.gpu.stdout || '').trim().split('\n')[0].split(',')
      gpuDetail.driver = parts.length > 0 ? parts[0].trim() : null
      gpuDetail.count = parts.length > 1 ? parseInt(parts[1].trim(), 10) : null
    }
    detail.interop = (!!out.ps && out.ps.code === 0) || (!!out.tasklist && out.tasklist.code === 0)
    const ok = gpuDetail.available || (detail.interop as boolean)
    return {
      ok,
      reason: ok ? undefined : 'interop 全部通道不可用: gpu=' + (out.gpu && out.gpu.code) +
        ' ps=' + (out.ps && out.ps.code) + ' tasklist=' + (out.tasklist && out.tasklist.code),
      detail,
    }
  }

  /** GPU 快照（query，TTL 500ms 缓存） */
  private async queryGpu(): Promise<{ ok: boolean; gpus: GpuSample[]; reason?: string }> {
    const cached = this.cacheGet(this.gpuQueryCache, WIN.TTL.QUERY)
    if (cached !== undefined) return cached
    const r = await this.runner.execArgs(WIN.NVIDIA_SMI, WIN.QUERY_ARGS)
    if (r.code !== 0) {
      this.gpuQueryCache = null
      return { ok: false, gpus: [], reason: 'nvidia-smi query 失败 code=' + r.code + ' ' + (r.stderr || '') }
    }
    const gpus: GpuSample[] = []
    for (const line of (r.stdout || '').split('\n')) {
      if (!line.trim()) continue
      const g = this.parseSmiLine(line)
      if (g) gpus.push(g)
    }
    const res = { ok: true, gpus }
    this.cacheSet('_gpuQueryCache', res)
    return res
  }

  /**
   * CPU/内存/进程树（CIM，TTL 5s；interop 断 → 回退 /proc，D1-1）
   * 输出：首行 "cpuLoad;totalKB;freeKB"，随后每进程 "pid;ppid;name" 行 → ppidMap（进程树骨架，A4）
   */
  private async sysMemCim(): Promise<{ ok: boolean; cpuPercent: number | null; totalMiB: number; availableMiB: number; ppidMap: Record<number, number>; reason?: string }> {
    const cached = this.cacheGet(this.cimCache, WIN.TTL.CIM)
    if (cached !== undefined) return cached
    const r = await this.runner.execArgs(WIN.POWERSHELL, WIN.PS_SYSMEM)
    if (r.code !== 0) return { ok: false, cpuPercent: null, totalMiB: 0, availableMiB: 0, ppidMap: {}, reason: 'CIM 失败 code=' + r.code }
    const lines = (r.stdout || '').trim().split('\n')
    const parts = lines.length ? lines[0].trim().split(';') : []
    if (parts.length < 3) return { ok: false, cpuPercent: null, totalMiB: 0, availableMiB: 0, ppidMap: {}, reason: 'CIM 输出格式异常: ' + r.stdout }
    const ppidMap: Record<number, number> = {}
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].trim().split(';')
      if (f.length >= 3) {
        const pid = parseInt(f[0], 10)
        const ppid = parseInt(f[1], 10)
        if (Number.isFinite(pid) && Number.isFinite(ppid)) ppidMap[pid] = ppid
      }
    }
    const res = {
      ok: true,
      // 2026-08-20：CIM 字段安全解析（LoadPercentage 可为 "N/A"/空 → NaN；不可用回 null）
      cpuPercent: (() => {
        const n = parseFloat(parts[0])
        return Number.isFinite(n) ? n : null
      })(),
      totalMiB: (() => {
        const n = parseInt(parts[1], 10)
        return Number.isFinite(n) ? Math.round(n / 1024) : 0
      })(),
      availableMiB: (() => {
        const n = parseInt(parts[2], 10)
        return Number.isFinite(n) ? Math.round(n / 1024) : 0
      })(),
      ppidMap,
    }
    this.cacheSet('_cimCache', res)
    return res
  }

  /**
   * 每进程 GPU 利用率（pmon，TTL 5s 低频，辅助证据——A1）
   * `nvidia-smi pmon -c 3 -s u` 多帧窗口：跳过 # 注释行，列 pid/type/sm/mem/enc/dec/command；
   * sm（compute%）`-` 视 0；同 pid 多帧取 max（R2：防单帧 `-` 低估）。
   * 失败/驱动不支持 → { ok:false }，上层 gpuUtilPct 留空（整卡指标不受影响）。
   * 2026-08-20 修复：新版 pmon 表头为 `gpu pid type sm mem enc dec jpg ofa command`（9 列，
   * 首列 gpu 索引 + jpg/ofa 列），旧版为 `pid type sm mem enc dec command`（6 列）。解析
   * 不再按固定列序，改为**按表头列名映射索引**——兼容两种格式，避免把 gpu 索引当 pid、
   * 把 type（C+G）当 sm 导致全部行被过滤（GPU 占用列恒 '-' 的根因）。
   */
  private async queryPmon(): Promise<{ ok: boolean; byPid: Map<number, number>; reason?: string }> {
    const cached = this.cacheGet(this.pmonCache, WIN.TTL.CIM)
    if (cached !== undefined) return cached
    const r = await this.runner.execArgs(WIN.NVIDIA_SMI, WIN.PMON_ARGS)
    if (r.code !== 0) {
      this.pmonCache = null
      return { ok: false, byPid: new Map(), reason: 'pmon 失败 code=' + r.code + ' ' + (r.stderr || '') }
    }
    const byPid = new Map<number, number>()
    // 表头列名 → 列索引（# gpu pid type sm mem enc dec jpg ofa command / # pid type sm mem enc dec command）
    let colIdx: Record<string, number> | null = null
    for (const line of (r.stdout || '').split('\n')) {
      const t = line.trim()
      if (!t) continue
      if (t.startsWith('#')) {
        // 表头行：`# gpu pid type sm ... command`（去掉 # 前缀与第二行 `# Idx # C/G % ...`）
        const names = t.replace(/^#+\s*/, '').split(/\s+/)
        if (names.includes('pid') && names.includes('sm')) {
          colIdx = {}
          for (let i = 0; i < names.length; i++) colIdx[names[i]] = i
        }
        continue
      }
      if (!colIdx || colIdx.pid === undefined || colIdx.sm === undefined) continue
      const f = t.split(/\s+/)
      if (f.length <= Math.max(colIdx.pid, colIdx.sm)) continue
      const pid = parseInt(f[colIdx.pid], 10)
      const smRaw = f[colIdx.sm]
      const sm = smRaw === '-' || smRaw === '' || smRaw === undefined ? 0 : parseFloat(smRaw)
      if (!Number.isFinite(pid) || !Number.isFinite(sm)) continue
      const prev = byPid.get(pid)
      if (prev === undefined || sm > prev) byPid.set(pid, sm)
    }
    const res = { ok: true, byPid }
    this.cacheSet('_pmonCache', res)
    return res
  }

  /** interop 断时的 /proc 回退（WSL 内核视角仍真实，sources 标 procfs） */
  private async sysMemProc(): Promise<{ ok: boolean; totalMiB: number; availableMiB: number; reason?: string }> {
    const r = await this.runner.exec('cat /proc/meminfo 2>/dev/null')
    if (r.code !== 0) return { ok: false, totalMiB: 0, availableMiB: 0, reason: '/proc/meminfo 不可读' }
    const m: Record<string, number> = {}
    for (const line of (r.stdout || '').split('\n')) {
      const mm = line.match(/^(\w+):\s+(\d+)\s*kB/)
      if (mm) m[mm[1]] = parseInt(mm[2], 10)
    }
    if (!m.MemTotal) return { ok: false, totalMiB: 0, availableMiB: 0, reason: 'MemTotal 缺失' }
    return {
      ok: true,
      totalMiB: Math.round(m.MemTotal / 1024),
      availableMiB: m.MemAvailable ? Math.round(m.MemAvailable / 1024) : Math.round((m.MemFree || 0) / 1024),
    }
  }

  private async cpuFromProc(): Promise<number | null> {
    const r = await this.runner.exec('cat /proc/stat 2>/dev/null | head -1')
    if (r.code !== 0) return null
    const parts = (r.stdout || '').trim().split(/\s+/).slice(1).map(Number)
    if (parts.length < 4) return null
    const idle = parts[3] + (parts[4] || 0)
    const total = parts.reduce((a: number, b: number) => a + b, 0)
    const cur = { idle, total, at: Date.now() }
    const prev = this.lastCpuTimes
    this.lastCpuTimes = cur
    if (!prev) return null
    const dTotal = cur.total - prev.total
    if (dTotal <= 0) return 0
    const dIdle = cur.idle - prev.idle
    return Math.round(Math.max((1 - Math.max(dIdle, 0) / dTotal) * 100, 0) * 10) / 10
  }

  /** 进程表（tasklist GBK→iconv，TTL 5s） */
  private async procsTasklist(): Promise<{ ok: boolean; procs: ProcSample[]; reason?: string }> {
    const cached = this.cacheGet(this.taskCache, WIN.TTL.TASKLIST)
    if (cached !== undefined) return cached
    const r = await this.runner.execArgsEnc(WIN.TASKLIST, WIN.TASKLIST_ARGS, 'GBK')
    if (r.code !== 0) return { ok: false, procs: [], reason: 'tasklist 失败 code=' + r.code }
    const procs: ProcSample[] = []
    for (const line of (r.stdout || '').split('\n')) {
      // CSV: "python.exe","1234","Console","1","12,345 K"
      const mm = line.match(/"([^"]*)","(\d+)","([^"]*)","(\d+)","([^"]*)"/)
      if (mm) {
        const memStr = mm[5].replace(/[, ]/g, '')
        const memKB = parseInt(memStr, 10)
        procs.push({
          pid: parseInt(mm[2], 10),
          cmd: mm[1],
          cpuPct: null, // tasklist 无 CPU%；待 CIM/typeperf 扩展
          memMiB: isNaN(memKB) ? null : Math.round(memKB / 1024),
        })
      }
    }
    const res = { ok: true, procs }
    this.cacheSet('_taskCache', res)
    return res
  }

  /** ② snapshot：全量规范化输出 */
  async snapshot(): Promise<Snapshot> {
    const ts = this.now()
    const sources: Snapshot['sources'] = { cpu: 'cim', mem: 'cim', procs: 'tasklist' }
    let degraded: Snapshot['degraded'] | null = null

    // GPU（query 缓存；失败 → unavailable，CPU/内存照常）
    const gpuRes = await this.queryGpu()
    let gpu: GpuSample[] | undefined
    if (gpuRes.ok) {
      sources.gpu = 'query'
      gpu = gpuRes.gpus.map((g) => g)
    } else {
      sources.gpu = 'unavailable'
    }

    // CPU/内存（CIM；interop 断 → /proc 回退，D1-1；platform 保持 'wsl'）
    const sys = await this.sysMemCim()
    const cpu = { percent: null as number | null, cores: null as number | null }
    const mem = { totalMiB: null as number | null, availableMiB: null as number | null }
    if (sys.ok) {
      cpu.percent = sys.cpuPercent
      mem.totalMiB = sys.totalMiB
      mem.availableMiB = sys.availableMiB
    } else {
      // CIM 不可用 → /proc 回退（真实视图仍为 WSL 内核视角）
      sources.cpu = 'procfs'
      sources.mem = 'procfs'
      const procMem = await this.sysMemProc()
      if (procMem.ok) {
        mem.totalMiB = procMem.totalMiB
        mem.availableMiB = procMem.availableMiB
        cpu.percent = await this.cpuFromProc()
      }
      if (degraded === null) degraded = { reason: 'CIM 不可用回退 /proc' }
    }

    // 进程表（tasklist；失败 → ps 回退，不拖垮整次 snapshot）
    let procs: ProcSample[] = []
    const procsRes = await this.procsTasklist()
    if (procsRes.ok) {
      procs = procsRes.procs
    } else {
      sources.procs = 'ps'
      const psOut = await this.runner.exec('ps -eo pid=,ppid=,pcpu=,rss=,args= --no-headers 2>/dev/null | head -100')
      if (psOut.code === 0) {
        for (const line of (psOut.stdout || '').split('\n')) {
          const mm = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/)
          if (mm) procs.push({ pid: parseInt(mm[1], 10), ppid: parseInt(mm[2], 10), cmd: mm[5], cpuPct: parseFloat(mm[3]), memMiB: Math.round(parseInt(mm[4], 10) / 1024) })
        }
      }
    }

    // 合并器（A1/A4）：CIM ppid 进程树 + pmon 每进程 GPU 利用率按 pid 归并；sources 标注
    const pmon = await this.queryPmon()
    if (pmon.ok) {
      sources.procs = (sources.procs === 'tasklist' ? 'tasklist' : 'ps') + '+pmon'
      if (procs.length === 0 && pmon.byPid.size > 0) sources.procs = 'pmon'
    }
    if (sys.ok && Object.keys(sys.ppidMap).length > 0) {
      for (let i = 0; i < procs.length; i++) {
        const pp = sys.ppidMap[procs[i].pid]
        if (pp !== undefined) procs[i].ppid = pp
      }
    }
    if (pmon.byPid.size > 0) {
      for (let i = 0; i < procs.length; i++) {
        const sm = pmon.byPid.get(procs[i].pid)
        if (sm !== undefined) {
          procs[i].gpuUtilPct = sm
          procs[i].gpu = sm // v1.1 遗留字段：语义定稿 = GPU 利用率 %（1.2 首次填充）
        }
      }
    }

    // 净化：剔除采样自曝进程（tasklist/nvidia-smi 采样工具自身 + 它们的 conhost 宿主）
    // 2026-08-24（重名进程优化 ③）：tasklist 快照窗口会采到自身；nvidia-smi 含 dmon 长驻流
    // 每帧必现；它们的控制台宿主 conhost 一并剔除（ppid 指向采样工具）。用户手动运行的
    // conhost.exe 不受影响（ppid 指向用户程序）。
    procs = this.purgeSamplerSelf(procs)

    const snap: Snapshot = {
      ts,
      platform: 'wsl', // 标注真实采样视图（WSL 视角），不因通道降级改变（D1-1）
      sources,
      cpu,
      mem,
      procs,
    }
    if (gpu !== undefined) snap.gpu = gpu
    if (this.fallbackMode) {
      if (degraded === null) degraded = {}
      degraded.gpu = 'query-fallback'
    }
    if (degraded !== null) snap.degraded = degraded
    return snap
  }

  /**
   * 剔除采样自曝进程（重名进程优化 ③）：
   * 1. 采样工具自身：tasklist.exe（快照窗口自采）/ nvidia-smi.exe（含 dmon 长驻流，每帧必现）
   * 2. 它们的控制台宿主 conhost.exe（ppid 指向采样工具）——用户程序的 conhost 保留
   * 匹配按 Windows 侧映像名，大小写不敏感（tasklist 输出实测小写）。
   */
  private purgeSamplerSelf(procs: ProcSample[]): ProcSample[] {
    const SELF = new Set(['tasklist.exe', 'nvidia-smi.exe'])
    const selfPids = new Set<number>()
    for (const p of procs) {
      const name = (p.cmd || '').trim().toLowerCase()
      if (SELF.has(name)) selfPids.add(p.pid)
    }
    if (selfPids.size === 0) return procs
    return procs.filter((p) => {
      if (selfPids.has(p.pid)) return false
      if ((p.cmd || '').trim().toLowerCase() === 'conhost.exe' && p.ppid !== undefined && p.ppid !== null && selfPids.has(p.ppid)) return false
      return true
    })
  }

  /** ③ stream：dmon 长驻流（指数退避重启 → query-fallback） */
  stream(): AsyncIterable<{ ts: number; raw: string }> | null {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return self.streamIterator()
      },
    }
  }

  private async *streamIterator(): AsyncGenerator<{ ts: number; raw: string }> {
    // 长驻循环：spawn dmon → 读行流 → EOF/断流 → 指数退避重启 → 超限 fallback
    while (true) {
      if (this.closed) break // close() 后禁止重启 spawn（D2-1 根治）
      let proc: { pid: number | null; readOutput(): string; done(): boolean; kill(): void } | null = null
      try {
        proc = this.runner.spawnArgs(WIN.NVIDIA_SMI, WIN.DMON_ARGS)
        this.spawned.push(proc)
      } catch (e) {
        this.fallbackMode = true
        break
      }
      let eof = false
      let buf = ''
      const readLine = (): string | null => {
        const delta = proc ? proc.readOutput() : ''
        buf += delta
        const nl = buf.indexOf('\n')
        if (nl < 0) return null
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        return line
      }
      while (true) {
        if (proc && proc.done()) {
          eof = true
          break
        }
        const line = readLine()
        if (line !== null && line.trim()) {
          yield { ts: Date.now(), raw: line }
          continue
        }
        if (proc && proc.done()) {
          eof = true
          break
        }
        // 无行且未退出：等一拍再读（流式；1s 行频由 dmon -d 1 保证）
        await this.runner.sleep(200)
      }
      // 清理本周期 spawn（close 幂等）
      if (proc) {
        const idx = this.spawned.indexOf(proc)
        if (idx >= 0) this.spawned.splice(idx, 1)
        try {
          proc.kill()
        } catch (e) { /* ignore */ }

      }
      if (!eof) break // 显式停止
      // 断流自愈：指数退避（1s→2s→4s），≤3 次/5min；超限 → query-fallback（degraded）
      // v1.4.3（会话内验收实证）：_lastRestartAt 初始 0 使「now-0>300000」恒真 → 首杀即
      // 误入 fallback、重启路径从未生效；改为 5min 窗口过期先重置计数，再按次数判断。
      if (this.closed) break // close() 后不再退避重启
      const now = Date.now()
      if (now - this.lastRestartAt > 300000) this.restarts = 0
      if (this.restarts > 3) {
        this.fallbackMode = true
        break
      }
      const delay = Math.min(1000 * Math.pow(2, this.restarts - 1), 4000)
      this.lastRestartAt = now
      await this.runner.sleep(delay)
    }
  }

  /** ④ close：杀 interop 子进程（D2-1 防孤儿），幂等 */
  async close(): Promise<void> {
    this.closed = true
    for (let i = 0; i < this.spawned.length; i++) {
      try {
        this.spawned[i].kill()
      } catch (e) { /* ignore */ }
    }
    this.spawned = []

    this.cimCache = null
    this.taskCache = null
    this.gpuQueryCache = null
    this.pmonCache = null
    this.lastCpuTimes = null
    this.fallbackMode = false
    this.restarts = 0
  }
}
