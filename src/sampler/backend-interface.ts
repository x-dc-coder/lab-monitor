/**
 * SamplerBackend 契约（V2 TS 化）
 * 一个平台采样后端的统一契约：后端 = "一个平台的全部采样通道的组合"。
 * 上层（ring/state/balancer/rpc/tools/UI）不感知平台差异，只消费规范化快照。
 * 方法集（netdata 五方法映射）：
 *   probe()    Promise<{ok, reason?, detail?}>  —— 环境探测（= Check），绝不抛错
 *   snapshot() Promise<快照>                    —— 一次性全量采样（= Collect）
 *   stream()   AsyncIterable<{ts, raw}> | null  —— 长驻增量流（GPU dmon 行流）
 *   close()    Promise<void>                    —— 释放资源（杀 interop 子进程，幂等）
 */

/** runner 通道适配（解耦 shell 服务；v1.4.1 D1-1 职责分离） */
export interface Runner {
  exec(cmdStr: string): Promise<{ code: number; stdout: string; stderr: string }>
  execArgs(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  execArgsEnc(file: string, args: string[], enc: string): Promise<{ code: number; stdout: string; stderr: string }>
  spawnArgs(file: string, args: string[]): {
    pid: number | null
    readOutput(): string
    done(): boolean
    kill(): void
  }
  sleep(ms: number): Promise<void>
}

/** GPU 指标（规范化） */
export interface GpuSample {
  id: string
  name?: string
  utilPct: number
  memUsedMiB: number
  memTotalMiB: number
  tempC?: number
  powerW?: number
  degraded?: boolean
}

/** 进程条目（lab-protocol/1.2：+ppid/+gpuUtilPct/+gpuMemMiB 预留） */
export interface ProcSample {
  pid: number
  cmd: string
  cpuPct?: number | null
  memMiB?: number | null
  /** 每进程 GPU 利用率 %（pmon sm 列，辅助证据；仅活动进程有值，`-` 视 0） */
  gpuUtilPct?: number | null
  /** 父进程 id（进程树骨架；Windows 来自 CIM，Linux 来自 ps ppid 列） */
  ppid?: number | null
  /** 每进程显存 MiB —— 预留字段，当前不启用（Windows/WSL 受限于 [N/A]，恒 null） */
  gpuMemMiB?: number | null
  /** v1.1 遗留字段：语义定稿为 GPU 利用率 %（与 gpuUtilPct 同值，兼容保留） */
  gpu?: number | null
}

/** 规范化快照（协议 docs/03-protocol.md §2.1） */
export interface Snapshot {
  ts: number
  platform: 'linux' | 'wsl' | 'windows-native' | string
  sources: { gpu?: string; cpu: string; mem: string; procs: string }
  gpu?: GpuSample[]
  cpu: { percent: number | null; cores?: number | null }
  mem: { totalMiB: number | null; availableMiB: number | null }
  procs: ProcSample[]
  degraded?: { gpu?: string; reason?: string }
}

/** 探测结果 */
export interface ProbeResult {
  ok: boolean
  reason?: string
  detail?: Record<string, unknown>
}

/** 采样后端统一契约 */
export interface SamplerBackend {
  id: 'linux' | 'wsl' | 'windows-native' | string
  cacheTtlMs: number
  lastCpuTimes: { idle: number; total: number; at: number } | null
  probe(): Promise<ProbeResult>
  snapshot(): Promise<Snapshot>
  stream(): AsyncIterable<{ ts: number; raw: string }> | null
  close(): Promise<void>
}
