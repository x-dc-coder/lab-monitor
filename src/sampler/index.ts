/**
 * 平台探测与分发（sampler 唯一入口）
 * v1.4.1（D1-1）职责分离：平台判定只看 /proc/version 含 microsoft → 'wsl'；
 * interop 可用性不参与平台判定，由 WindowsBackend.probe() 驱动通道级降级。
 */
import type { Runner, SamplerBackend } from './backend-interface.js'
import { LinuxBackend } from './backend-linux.js'
import { WindowsBackend } from './backend-windows.js'
import { WindowsNativeBackend } from './backend-windows-native.js'

/** 平台探测：/proc/version 含 microsoft → 'wsl'；否则纯 Linux */
export async function detectPlatform(runner: Runner): Promise<string> {
  const r = await runner.exec('cat /proc/version 2>/dev/null | head -1')
  const v = (r.stdout || '') + ' ' + (r.stderr || '')
  if (/microsoft/i.test(v)) return 'wsl'
  return 'linux'
}

/** 平台分发：返回 { backend, platform } */
export async function createBackend(runner: Runner): Promise<{ backend: SamplerBackend; platform: string }> {
  const platform = await detectPlatform(runner)
  if (platform === 'wsl') {
    return { backend: new WindowsBackend(runner), platform }
  }
  return { backend: new LinuxBackend(runner), platform }
}

/** 快照聚合：backend.snapshot() 已输出规范化结构（含 ts/platform/sources）；上层直接消费 */
export async function collectSnapshot(backend: SamplerBackend): Promise<Awaited<ReturnType<SamplerBackend['snapshot']>>> {
  return backend.snapshot()
}

/** probe 封装：后端可用性（上层启动时调用，失败只降级对应通道） */
export function probeBackend(backend: SamplerBackend): Promise<{ ok: boolean; reason?: string; detail?: Record<string, unknown> }> {
  return backend.probe()
}

// 导出后端类（外部测试/独立工具引用）
export { LinuxBackend, WindowsBackend, WindowsNativeBackend }
