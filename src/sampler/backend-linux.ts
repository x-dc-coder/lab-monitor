/**
 * LinuxBackend：/proc + ps，零依赖（纯 Linux 场景，WSL 内核视角 /proc）
 * 指标来源（实证 08 §1.6）：
 *   CPU: /proc/stat 两次采样差分（psutil 算法：首帧丢弃、负值截 0）
 *   内存: /proc/meminfo（MemTotal/MemAvailable，kB→MiB）
 *   进程: ps -eo pid,pcpu,pmem,args（低频 5s 由上层控制）
 */
import type { ProcSample, ProbeResult, Runner, SamplerBackend, Snapshot } from './backend-interface.js'

interface CpuTimes {
  idle: number
  total: number
  at: number
}

export class LinuxBackend implements SamplerBackend {
  id = 'linux' as const
  cacheTtlMs = 1000
  lastCpuTimes: CpuTimes | null = null
  private runner: Runner

  constructor(runner: Runner) {
    this.runner = runner
  }

  /** ① 探测：/proc 可读即可用（绝不抛错） */
  async probe(): Promise<ProbeResult> {
    try {
      const r = await this.runner.exec('cat /proc/version 2>/dev/null | head -1')
      if (r.code !== 0) return { ok: false, reason: 'cannot read /proc/version: ' + (r.stderr || '') }
      return { ok: true, detail: { kernel: (r.stdout || '').trim().slice(0, 80) } }
    } catch (e) {
      return { ok: false, reason: 'probe exception: ' + (e as Error).message }
    }
  }

  /** /proc/meminfo → { totalMiB, availableMiB }（kB→MiB，向下取整） */
  private async readMeminfo(): Promise<{ totalMiB: number; availableMiB: number } | null> {
    const r = await this.runner.exec('cat /proc/meminfo 2>/dev/null')
    if (r.code !== 0) return null
    const m: Record<string, number> = {}
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

  /** /proc/stat 首行 → { idle, total, at }（jiffies 差分） */
  private async readStat(): Promise<CpuTimes | null> {
    const r = await this.runner.exec('cat /proc/stat 2>/dev/null | head -1')
    if (r.code !== 0) return null
    const parts = (r.stdout || '').trim().split(/\s+/).slice(1).map(Number)
    if (parts.length < 4) return null
    const idle = parts[3] + (parts[4] || 0)
    const total = parts.reduce((a: number, b: number) => a + b, 0)
    return { idle, total, at: Date.now() }
  }

  /** CPU 差分（psutil 算法）：首帧返回 null（丢弃）；负值截 0 */
  private cpuPercent(cur: CpuTimes): number | null {
    const prev = this.lastCpuTimes
    this.lastCpuTimes = cur
    if (!prev) return null
    const dTotal = cur.total - prev.total
    if (dTotal <= 0) return 0
    const dIdle = cur.idle - prev.idle
    const pct = (1 - Math.max(dIdle, 0) / dTotal) * 100
    return Math.round(Math.max(pct, 0) * 10) / 10
  }

  /** ② 快照：全量规范化输出（协议 docs/03-protocol.md §2.1） */
  async snapshot(): Promise<Snapshot> {
    const ts = Date.now()
    const [mem, stat, psOut] = await Promise.all([
      this.readMeminfo(),
      this.readStat(),
      this.runner.exec('ps -eo pid=,pcpu=,pmem=,args= --no-headers 2>/dev/null | head -100'),
    ])
    const cpu = { percent: null as number | null, cores: null as number | null }
    if (stat) cpu.percent = this.cpuPercent(stat)
    const procs: ProcSample[] = []
    if (psOut && psOut.code === 0) {
      for (const line of (psOut.stdout || '').split('\n')) {
        const mm = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/)
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
      ts,
      platform: 'linux',
      sources: { cpu: 'procfs', mem: 'procfs', procs: 'ps' },
      cpu,
      mem: mem || { totalMiB: null, availableMiB: null },
      procs,
    }
  }

  /** ③ 流：Linux 后端无 GPU 流能力（GPU 在 Windows 侧） */
  stream(): AsyncIterable<{ ts: number; raw: string }> | null {
    return null
  }

  /** ④ 关闭：清差分基线（无子进程） */
  async close(): Promise<void> {
    this.lastCpuTimes = null
  }
}
