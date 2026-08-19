/**
 * WindowsNativeBackend（预留桩）—— 未来：纯 Windows 本机/远程场景
 * 同 SamplerBackend 接口；当前仅预留：probe → { ok: false }，平台扩展位（t10 §3）。
 */
import type { ProbeResult, Runner, SamplerBackend, Snapshot } from './backend-interface.js'

export class WindowsNativeBackend implements SamplerBackend {
  id = 'windows-native' as const
  cacheTtlMs = 500
  lastCpuTimes: { idle: number; total: number; at: number } | null = null

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(runner: Runner) {
    /* 预留 */
  }

  async probe(): Promise<ProbeResult> {
    return { ok: false, reason: 'WindowsNativeBackend 未实现（预留桩，未来纯 Windows/远程场景）' }
  }

  async snapshot(): Promise<Snapshot> {
    return {
      ts: Date.now(),
      platform: 'windows-native',
      sources: { gpu: 'unavailable', cpu: 'unavailable', mem: 'unavailable', procs: 'unavailable' },
      cpu: { percent: null, cores: null },
      mem: { totalMiB: null, availableMiB: null },
      procs: [],
      degraded: { reason: 'not implemented' },
    }
  }

  stream(): AsyncIterable<{ ts: number; raw: string }> | null {
    return null
  }

  async close(): Promise<void> {
    /* no-op */
  }
}
