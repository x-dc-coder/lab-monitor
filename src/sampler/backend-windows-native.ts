/**
 * WindowsNativeBackend —— 原生 Windows 场景（DSH 直接跑在 Windows，无 WSL interop）
 *
 * 实现方式（#15，2026-08-24）：**委托复用 WindowsBackend 全部通道逻辑**
 * （tasklist GBK→iconv / PowerShell CIM / nvidia-smi query+dmon / pmon），
 * 唯一差异是命令执行方式——原生 Windows 用 child_process 直接本地执行，
 * 不经 WSL interop（WSL 下 runner.exec 走 wsl.exe 桥，Windows 原生不需要）。
 *
 * 前置：detectPlatform 增加 process.platform==='win32' → 'windows-native'；
 *       createBackend mode='windows-native' 或 auto+win32 时实例化本类。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import type { ProbeResult, Runner, SamplerBackend, Snapshot } from './backend-interface.js'
import { WindowsBackend } from './backend-windows.js'

/** 原生 Windows 本地执行 runner：直接 spawn 命令（不经 WSL interop） */
function localWinRunner(): Runner {
  const enc = (buf: Buffer): string => {
    // tasklist GBK 输出 → UTF-8（iconv 等价；无 iconv 依赖，TextDecoder gbk 原生支持）
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch (e) {
      return buf.toString('utf8')
    }
  }
  return {
    async exec(cmd: string) {
      try {
        const out = execFileSync('cmd.exe', ['/c', cmd], { encoding: 'buffer', timeout: 8000 })
        return { code: 0, stdout: out.toString('utf8'), stderr: '' }
      } catch (e) {
        const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer }
        return { code: err.status ?? 1, stdout: (err.stdout || '').toString('utf8'), stderr: (err.stderr || '').toString('utf8') }
      }
    },
    async execArgs(cmd: string, args: string[]) {
      try {
        const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000 })
        return { code: 0, stdout: out, stderr: '' }
      } catch (e) {
        const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer }
        return { code: err.status ?? 1, stdout: (err.stdout || '').toString('utf8'), stderr: (err.stderr || '').toString('utf8') }
      }
    },
    async execArgsEnc(cmd: string, args: string[], fromEncoding?: string) {
      try {
        const out = spawnSync(cmd, args, { encoding: 'buffer', timeout: 10000 })
        const raw = out.stdout || Buffer.alloc(0)
        const text = fromEncoding === 'GBK' ? enc(raw) : raw.toString('utf8')
        return { code: out.status ?? (out.error ? 1 : 0), stdout: text, stderr: (out.stderr || '').toString('utf8') }
      } catch (e) {
        return { code: 1, stdout: '', stderr: String(e) }
      }
    },
    // dmon 长驻流：spawn 子进程，增量读 stdout（对齐 WSL runner 的 spawnArgs 语义）
    spawnArgs(file: string, args: string[]) {
      let acc = ''
      const child = spawn(file, args, { windowsHide: true })
      child.stdout.on('data', (d: Buffer) => { acc += d.toString('utf8') })
      child.stderr.on('data', () => { /* 忽略 stderr */ })
      return {
        pid: child.pid ?? null,
        readOutput(): string {
          const s = acc
          acc = ''
          return s
        },
        done(): boolean {
          return child.exitCode !== null || child.signalCode !== null
        },
        kill(): void {
          try { child.kill() } catch (e) { /* 已退出 */ }
        },
      }
    },
    async sleep(ms: number): Promise<void> {
      await new Promise((r) => setTimeout(r, ms))
    },
  }
}

export class WindowsNativeBackend implements SamplerBackend {
  id = 'windows-native' as const
  cacheTtlMs = 500
  lastCpuTimes: { idle: number; total: number; at: number } | null = null

  private delegate: WindowsBackend

  constructor(_runner: Runner) {
    // #15：委托 WindowsBackend + 本地执行 runner（不经 WSL interop）
    this.delegate = new WindowsBackend(localWinRunner())
  }

  async probe(): Promise<ProbeResult> {
    return this.delegate.probe()
  }

  async snapshot(): Promise<Snapshot> {
    const snap = await this.delegate.snapshot()
    // 平台标注：原生 Windows（底层 WindowsBackend 标注 wsl，此处修正）
    return { ...snap, platform: 'windows-native' as const }
  }

  stream(): AsyncIterable<{ ts: number; raw: string }> | null {
    return this.delegate.stream()
  }

  async close(): Promise<void> {
    await this.delegate.close()
  }
}
