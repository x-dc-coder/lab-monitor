/**
 * Lab Monitor Host 半（V2 正式插件入口）
 * 职责：collector / ring-buffer / state-machine / balancer / hooks / tools /
 *       prompt 注入 / settings 探测 + webServer HTTP 数据面（替代动态版 harness.handle RPC）
 * 契约：lab-protocol/1.1（docs/03-protocol.md）
 *
 * 与动态版（v1.4.5）的差异：
 *   1. harness.handle('labMonitor.*') RPC → webServer HTTP 路由 /lab-monitor/api/*
 *      （better-sidebar 同款模式；client 半 fetch 消费）
 *   2. harness.defineTool/registerTool → 官方 ctx.tools.register(defineTool(...))
 *   3. settings 持久化可用（schemastery + settings.register，P2 2' 解锁）
 *   4. inject 正式声明：shell/timer 硬依赖；tools/webServer/systemPrompt 可选消费
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Schema from '@deepseek-ai/schemastery'

import { createBackend, collectSnapshot, probeBackend } from './sampler/index.js'
import type { ProcSample, Runner, SamplerBackend, Snapshot } from './sampler/backend-interface.js'
import { createRing } from './core/ring.js'
import { createStateMachine, parsePs } from './core/state-machine.js'
import { createBalancer, createThresholds } from './core/balancer.js'
import { aggregateProcStats } from './core/proc-aggregator.js'
import type { GroupStats, SystemStats } from './core/types.js'
import {
  SAMPLE_MS,
  PS_INTERVAL_MS,
  THRESHOLD_DEFAULTS,
  matchTrainFeature,
  normalizeCmdForMatch,
} from './core/constants.js'
import type { Thresholds } from './core/constants.js'
import type { MonitorSnapshot, SamplePoint } from './core/types.js'

// ── 类型 ─────────────────────────────────────────────────────────────────────

/** host 半插件配置（schemastery schema 由外部声明；此处仅运行时默认） */
export interface LabMonitorConfig {
  /** 是否注入 labstatus 到 system prompt（默认关——KV 缓存友好；用 lab_status 工具按需查询） */
  promptInjection: boolean
  /** 采样周期 ms */
  sampleMs: number
  /** UI 轮询周期 ms */
  pollMs: number
  /**
   * 自定义监控进程关键词（2026-08-20 新增）：命中（命令名/命令行 contains）的进程在
   * 监控面板高亮 + 置顶展示，并纳入聚合统计。例：["llama-server", "vllm"]。
   * 来源：配置文件（settings.yaml 的 lab-monitor 段）静态基线 + lab_ctl watch 运行时动态合并。
   */
  watchProcs: string[]
}

/** dsh-settings 命名空间句柄（SettingsScope 子集：get/watch/update） */
interface SettingsScopeLike {
  get(): unknown
  watch?(cb: (next: unknown, prev: unknown) => void): () => void
  update?(patch: Record<string, unknown>): unknown
}

// ── runner 适配（shell 服务 → SamplerBackend 通道契约）────────────────────────

function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function makeRunner(shell: ShellExecutor, ctx: Context): Runner {
  function cmdLine(file: string, args: string[]): string {
    const parts = [shq(file)]
    for (let i = 0; i < args.length; i++) parts.push(shq(args[i]))
    return parts.join(' ')
  }
  // v1.4.2（会话内验收实证）：cordis 沙箱 shell 服务要求先 resolve() 再 run/start；
  // 监控命令集固定、无用户输入，统一显式 stamp danger-full-access（探针 D/E 路径实证通过）。
  function resolveSpec(command: string, timeoutMs?: number) {
    const spec = shell.resolve({ command, timeoutMs: timeoutMs === undefined ? 15000 : timeoutMs })
    ;(spec as { sandboxPolicy?: { mode: string } }).sandboxPolicy = { mode: 'danger-full-access' }
    return spec
  }
  return {
    async exec(cmdStr: string) {
      try {
        const r = await shell.run(resolveSpec(cmdStr))
        return {
          code: r.exitCode === null || r.exitCode === undefined ? -1 : r.exitCode,
          stdout: (r.stdout && r.stdout.text) || '',
          stderr: (r.stderr && r.stderr.text) || '',
        }
      } catch (e) {
        return { code: -1, stdout: '', stderr: String(e && (e as Error).message ? (e as Error).message : e) }
      }
    },
    execArgs(file: string, args: string[]) {
      return this.exec(cmdLine(file, args))
    },
    execArgsEnc(file: string, args: string[], enc: string) {
      return this.exec(cmdLine(file, args) + ' | iconv -f ' + shq(enc) + ' -t UTF-8')
    },
    spawnArgs(file: string, args: string[]) {
      const proc = shell.start(resolveSpec(cmdLine(file, args)))
      return {
        pid: null, // shell 服务不暴露 OS pid；孤儿清理靠 kill()（D2-1）
        readOutput() {
          try {
            const rd = proc.readOutput()
            return (rd && rd.delta) || ''
          } catch (e) {
            return ''
          }
        },
        done() {
          return proc.exitCode !== null
        },
        kill() {
          try {
            proc.kill()
          } catch (e) {
            /* ignore */
          }
        },
      }
    },
    sleep(ms: number) {
      return new Promise<void>((resolve) => {
        try {
          ctx.timeout(resolve, ms)
        } catch (e) {
          resolve()
        }
      })
    },
  }
}

// ── 快照构建 ─────────────────────────────────────────────────────────────────

type RawSnapshot = Snapshot

function toSamplePoint(snap: RawSnapshot): SamplePoint {
  const m = snap.mem
  const total: number | null = m ? m.totalMiB : null
  const avail: number | null = m ? m.availableMiB : null
  const memUsed: number | null = total != null ? total - (avail == null ? 0 : avail) : null
  return {
    ts: snap.ts,
    gpu: snap.gpu || [],
    gpuState: snap.gpu && snap.gpu.length ? 'ok' : (snap.sources && snap.sources.gpu === 'unavailable' ? 'unavailable' : 'ok'),
    cpuPct: snap.cpu ? snap.cpu.percent : null,
    cores: snap.cpu && snap.cpu.cores !== undefined ? snap.cpu.cores : null,
    memUsedMiB: memUsed,
    memTotalMiB: total,
    procs: snap.procs || [],
    group: null, // ps 5s 周期回填（B3 聚合）
    system: null,
    experimentActive: false,
    degraded: snap.degraded || null,
  } satisfies SamplePoint
}

function fmtGiBx(mib: number | null | undefined): string {
  if (mib === null || mib === undefined || Number.isNaN(mib)) return '-'
  const g = mib / 1024
  return g >= 100 ? String(Math.round(g)) : String(Math.round(g * 10) / 10)
}

/**
 * 递归 JSON 清洗（2026-08-20 修复：lab_status/lab_advice 报 `value is not lossless JSON`）。
 * dsh-tools 工具注册表对返回值做 lossless JSON 校验（NaN/Infinity/undefined/BigInt/-0/循环
 * 一律拒绝，见 dsh-tools lib/index.js `isJsonValue`）。采样/解析层偶发非有限数（nvidia-smi
 * 的 "N/A"、CIM 空字段等）会直达工具输出 → 完整版 lab_status/lab_advice 调用失败（brief 文本
 * 模式不受影响）。本函数在对外输出边界递归清洗：非有限数 → null、undefined → null、-0 → 0；
 * 返回**新对象**（复制语义，不污染 balancer/backend 内部共享引用）。
 */
function sanitizeJson<T>(value: T, depth = 0, seen?: WeakSet<object>): T {
  if (depth > 12) return null as unknown as T // 深度截断返回 null，而非原对象（深层非法值/环不泄漏）
  if (value === undefined) return null as unknown as T
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return (value === 0 ? 0 : value) as T // -0 → +0（lossless 语义）
    return null as unknown as T
  }
  if (Array.isArray(value)) {
    const src = value as unknown[]
    if (!seen) seen = new WeakSet()
    if (seen.has(src)) return null as unknown as T // 环引用 → null
    seen.add(src)
    const out: unknown[] = new Array(src.length)
    for (let i = 0; i < src.length; i++) out[i] = sanitizeJson(src[i], depth + 1, seen)
    seen.delete(src) // 共享引用（DAG）允许重复复制
    return out as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    if (!seen) seen = new WeakSet()
    if (seen.has(src)) return null as unknown as T
    seen.add(src)
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src)) out[k] = sanitizeJson(src[k], depth + 1, seen)
    seen.delete(src)
    return out as unknown as T
  }
  return value // string / boolean / null
}

function promptLine(snap: MonitorSnapshot): string {
  const g = snap.gpu && snap.gpu.length ? snap.gpu[0] : null
  const parts: string[] = []
  if (g && snap.gpuState !== 'unavailable') {
    const mem = g.memTotalMiB ? fmtGiBx(g.memUsedMiB) + '/' + fmtGiBx(g.memTotalMiB) + 'G' : ''
    parts.push('GPU' + g.id + ' ' + (g.utilPct !== null ? g.utilPct + '%' : '-') + (mem ? ' · ' + mem : ''))
  } else {
    parts.push('GPU 无')
  }
  if (snap.cpu && typeof snap.cpu.percent === 'number') parts.push('CPU ' + Math.round(snap.cpu.percent) + '%')
  if (snap.experiment) {
    const mins = Math.max(0, Math.round((Date.now() - snap.experiment.startTs) / 60000))
    parts.push('实验 ' + snap.experiment.runId + ' (' + snap.experiment.state + ' ' + mins + 'min)')
    const gs = snap.experiment.groupStats
    if (gs) {
      parts.push('实验组 ' + (gs.cpuPct ?? '-') + '%CPU/' + fmtGiBx(gs.memMiB) + 'G · ' + gs.memberCount + ' 进程')
    }
  }
  if (snap.system && snap.system.topN.length) {
    parts.push('他占 ' + (snap.system.topN[0].cmd || '?') + ' ' + fmtGiBx(snap.system.topN[0].memMiB) + 'G')
  }
  parts.push('告警: ' + (snap.alertsCriticalCount ? snap.alertsCriticalCount + '条' : '无'))
  return '[Lab Monitor] ' + parts.join(' · ')
}

// ── 插件对象 ─────────────────────────────────────────────────────────────────

export const name = 'lab-monitor'

/** 依赖声明：shell/timer/webServer/tools 硬依赖（与官方 better-sidebar 一致，inject 后属性直访）；settings/systemPrompt 可选 */
export const inject = ['shell', 'timer', 'webServer', 'tools']

export function apply(ctx: Context, config: Partial<LabMonitorConfig> = {}) {
  const cfg: LabMonitorConfig = {
    promptInjection: config.promptInjection ?? false,
    sampleMs: config.sampleMs ?? SAMPLE_MS,
    pollMs: config.pollMs ?? THRESHOLD_DEFAULTS.pollMs,
    watchProcs: Array.isArray(config.watchProcs) ? config.watchProcs.slice() : [],
  }

  // ── 运行时 watchlist（2026-08-20：用户配置静态基线 ∪ lab_ctl watch 动态注册）──
  // 动态注册仅存于本 fiber 生命周期（DSH 重启即还原）；持久化由 settings 段承担
  const runtimeWatch = new Set<string>()
  function watchSet(): string[] {
    return Array.from(new Set([...cfg.watchProcs, ...runtimeWatch]))
  }

  // ── 状态容器（apply 内初始化，闭包共享）────────────────────────────────
  let enabled = true
  const backendState: {
    backend: SamplerBackend | null
    platform: string
    lastSnap: RawSnapshot | null
    stopped: boolean
    psAt: number
  } = { backend: null, platform: 'unknown', lastSnap: null, stopped: false, psAt: 0 }
  // 最近一次 5s 周期聚合（Phase B3；snapshot RPC 在两次周期之间时取最近值，5s 粒度近似）
  let lastGroupStats: GroupStats | null = null
  let lastSystemStats: SystemStats | null = null

  // 内部事件分发
  const labListeners: ((ev: { type: string; ts: number; runId: string | null; data: Record<string, unknown> }) => void)[] = []
  function emitLab(type: string, data: Record<string, unknown>) {
    const runIdVal = (data && data.runId) || null
    const ev = { type, ts: Date.now(), runId: typeof runIdVal === 'string' ? runIdVal : null, data: data || {} }
    for (let i = 0; i < labListeners.length; i++) {
      try {
        labListeners[i](ev)
      } catch (e) {
        console.error('[lab-monitor] lab 事件监听错误:', e)
      }
    }
    console.log('[lab-monitor] ' + type, JSON.stringify(data || {}))
  }

  const ring = createRing(1000, 30 * 60 * 1000)
  const thresholds = createThresholds()
  const recentWindow: SamplePoint[] = [] // 最近 10s 快照窗口（2s × 5）
  const balancer = createBalancer({
    thresholds: () => thresholds.get(),
    emitLab,
  })
  const machine = createStateMachine({
    ring,
    emitLab,
    emitAlert: (alert, runId) => {
      balancer.pushExternal({ ...alert, runId: runId || null })
      emitLab('lab/alert', {
        level: alert.level,
        rule: alert.rule,
        msg: alert.msg,
        confidence: alert.confidence,
        actions: alert.actions,
      })
    },
  })

  // runner + 采样主流程
  const runner = makeRunner(ctx.shell, ctx)

  // 采样 tick（2s 固定；ps 5s 周期）
  let tickBusy = false
  async function sampleTick() {
    if (tickBusy || !enabled || !backendState.backend) return
    tickBusy = true
    try {
      const snap = await collectSnapshot(backendState.backend)
      if (!snap) return
      backendState.lastSnap = snap
      const pt = toSamplePoint(snap)
      ring.push(pt)
      recentWindow.push(pt)
      while (recentWindow.length > 5) recentWindow.shift() // ≤10s 窗口（2s × 5）
      const run = machine.cur()
      if (run) {
        const st = run.sampleStats || (run.sampleStats = { utilSum: 0, utilN: 0, utilMax: 0, memPeakMiB: 0 })
        const g0 = pt.gpu && pt.gpu.length ? pt.gpu[0] : null
        if (g0 && typeof g0.utilPct === 'number') {
          st.utilSum += g0.utilPct
          st.utilN += 1
          if (g0.utilPct > st.utilMax) st.utilMax = g0.utilPct
        }
        if (g0 && typeof g0.memUsedMiB === 'number' && g0.memUsedMiB > st.memPeakMiB) st.memPeakMiB = g0.memUsedMiB
      }
      // ps 周期（5s）→ 状态机 tick + 进程组聚合（Phase B2/B3）
      if (Date.now() - backendState.psAt >= PS_INTERVAL_MS) {
        backendState.psAt = Date.now()
        // 1.2：5 列增强表（pid ppid pcpu rss args）——状态机组集合与聚合输入同源
        // （WSL：Linux pid 空间；backend procs 表是 Windows tasklist pid，不可做组差集）
        const psOut = await runner.exec('ps -eo pid=,ppid=,pcpu=,rss=,args= --no-headers 2>/dev/null')
        const procs = parsePs(psOut)
        machine.tick(procs)
        const curRun = machine.cur()
        // B3：实验进程组 vs 非实验组拆分聚合（挂 ps 周期；输入 = 同源 ps 增强表）
        const aggProcs: ProcSample[] = procs.map((p) => ({
          pid: p.pid,
          cmd: p.cmd ?? null,
          ppid: p.ppid ?? null,
          cpuPct: typeof p.cpuPct === 'number' ? p.cpuPct : null,
          memMiB: typeof p.memMiB === 'number' ? p.memMiB : null,
        }))
        const agg = aggregateProcStats({
          procs: aggProcs,
          group: curRun ? curRun.procGroup : null,
          runActive: !!curRun,
        })
        lastGroupStats = agg.group
        lastSystemStats = agg.system
        pt.group = agg.group
        pt.system = agg.system
        pt.experimentActive = !!curRun
        // summary 扩展（1.2）：实验组 vs 其他进程峰值（5s 粒度）
        if (curRun) {
          const st = curRun.sampleStats || (curRun.sampleStats = { utilSum: 0, utilN: 0, utilMax: 0, memPeakMiB: 0 })
          if (agg.group && typeof agg.group.memMiB === 'number' && agg.group.memMiB > (st.groupMemPeakMiB ?? 0)) st.groupMemPeakMiB = agg.group.memMiB
          if (agg.group && typeof agg.group.cpuPct === 'number' && agg.group.cpuPct > (st.groupCpuMax ?? 0)) st.groupCpuMax = agg.group.cpuPct
          if (agg.system && typeof agg.system.memMiB === 'number' && agg.system.memMiB > (st.otherMemPeakMiB ?? 0)) st.otherMemPeakMiB = agg.system.memMiB
        }
        if (curRun && curRun.resultSeen) machine.tickGrace(curRun)
      }
      // evaluate 前 refresh 最近点：group/system 只在 ps 周期 tick 写入，
      // 非 ps 周期 tick 的点回退最近一次 5s 聚合；experimentActive 实时判定（事件驱动 start/end）
      if (recentWindow.length) {
        const wLast = recentWindow[recentWindow.length - 1]
        wLast.group = lastGroupStats
        wLast.system = lastSystemStats
        wLast.experimentActive = !!machine.cur()
      }
      balancer.evaluate(recentWindow, run ? run.runId : null)
    } catch (e) {
      console.error('[lab-monitor] 采样 tick 错误:', e)
    } finally {
      tickBusy = false
    }
  }
  ctx.interval(sampleTick, cfg.sampleMs)

  // 后台初始化：探测 + 建后端 + dmon 流
  let streamTask: Promise<void> | null = null
  async function startBackend() {
    try {
      const res = await createBackend(runner)
      backendState.backend = res.backend
      backendState.platform = res.platform
      const probe = await probeBackend(res.backend)
      console.log('[lab-monitor] 采样后端就绪 platform=', res.platform, 'probe=', JSON.stringify(probe && probe.detail ? probe.detail : probe))
      if (res.backend && typeof res.backend.stream === 'function') {
        streamTask = (async () => {
          try {
            const stream = res.backend.stream()
            if (!stream) return
            const it = stream[Symbol.asyncIterator]()
            while (!backendState.stopped) {
              const n = await it.next()
              if (n.done) break
            }
          } catch (e) {
            console.error('[lab-monitor] dmon 流退出:', e)
          }
        })()
      }
    } catch (e) {
      console.error('[lab-monitor] 采样后端初始化失败（降级为只读空快照）:', e)
    }
  }
  void startBackend()

  // 清理（fiber 内 disposer 语义）
  ctx.effect(
    () => {
      return () => {
        backendState.stopped = true
        if (streamTask) {
          try {
            const st = streamTask as Promise<void> & { return?: () => unknown }
            if (typeof st.return === 'function') st.return()
          } catch (e) {
            /* ignore */
          }
        }
        if (backendState.backend) {
          try {
            backendState.backend
              .close()
              .then(() => console.log('[lab-monitor] 采样后端已关闭，无孤儿进程'))
              .catch((e) => console.error('[lab-monitor] close 出错:', e))
          } catch (e) {
            console.error('[lab-monitor] close 出错:', e)
          }
        }
      }
    },
    'lab-monitor:collector-cleanup',
  )

  // ── 快照构建（对外协议）────────────────────────────────────────────────
  let callCount = 0
  /**
   * GPU 活动进程优先排序（2026-08-20 修复：tasklist 输出按 pid 序，前 15 行全是系统进程，
   * 真实 GPU 活动进程（chrome/explorer/llama-server…）排在数百行之后被 slice(0,15) 截断，
   * 导致 GPU% 列恒 '-'。改为：有 gpu 值（或 gpuUtilPct）的进程置顶、按利用率降序，再补足到 N）。
   */
  function prioritizeGpuProcs(procs: ProcSample[], n: number): ProcSample[] {
    const gpuVal = (p: ProcSample): number => {
      const v = p.gpuUtilPct !== undefined && p.gpuUtilPct !== null ? p.gpuUtilPct : p.gpu
      return typeof v === 'number' && !Number.isNaN(v) ? v : -1
    }
    const gpuOnes = procs.filter((p) => gpuVal(p) >= 0)
    const gpuOff = procs.filter((p) => gpuVal(p) < 0)
    gpuOnes.sort((a, b) => gpuVal(b) - gpuVal(a))
    return [...gpuOnes, ...gpuOff].slice(0, n)
  }
  function buildSnapshot(): MonitorSnapshot {
    callCount += 1
    const base = backendState.lastSnap || {
      ts: Date.now(),
      platform: 'linux',
      sources: { cpu: 'procfs', mem: 'procfs', procs: 'ps' },
      cpu: { percent: null, cores: null },
      mem: { totalMiB: null, availableMiB: null },
      procs: [],
    }
    const gpu = base.gpu || []
    const gpuState = gpu.length ? 'ok' : (base.sources && base.sources.gpu === 'unavailable' ? 'unavailable' : 'ok')
    const exp = machine.snapshot()
    // 1.2：实验进程组统计回填（最近一次 5s 聚合；快照 RPC 与 ps 周期解耦）
    if (exp) {
      exp.groupStats = lastGroupStats
    }
    // 2026-08-20：watchProcs 命中标记（进程名 contains 关键词，大小写不敏感）
    const watchList = watchSet()
    const watchedPids: number[] = []
    if (watchList.length && Array.isArray(base.procs)) {
      for (let i = 0; i < base.procs.length; i++) {
        const cmd = base.procs[i].cmd || ''
        for (let j = 0; j < watchList.length; j++) {
          if (cmd.toLowerCase().includes(watchList[j].toLowerCase())) {
            watchedPids.push(base.procs[i].pid)
            break
          }
        }
      }
    }
    const snap: MonitorSnapshot = {
      ts: Date.now(),
      platform: base.platform || 'linux',
      sources: {
        gpu: (base.sources && base.sources.gpu) || (gpu.length ? 'query' : 'unavailable'),
        cpu: (base.sources && base.sources.cpu) || 'procfs',
        mem: (base.sources && base.sources.mem) || 'procfs',
        procs: (base.sources && base.sources.procs) || 'ps',
      },
      gpu: gpu.map((g) => g),
      gpuState,
      cpu: base.cpu ? { percent: base.cpu.percent, cores: base.cpu.cores !== undefined ? base.cpu.cores : null } : { percent: null, cores: null },
      mem: base.mem ? { totalMiB: base.mem.totalMiB, availableMiB: base.mem.availableMiB } : { totalMiB: null, availableMiB: null },
      procs: prioritizeGpuProcs(base.procs || [], 15),
      system: lastSystemStats,
      watchedPids,
      alerts: balancer.snapshotAlerts(),
      alertsCriticalCount: balancer.count(),
      experiment: exp,
      callCount,
      ui: { betterSidebarVisible: uiVisible() },
    }
    if (base.degraded) snap.degraded = base.degraded
    // 2026-08-20：对外输出统一 lossless 清洗（NaN/Infinity/undefined → null；-0 → 0）
    return sanitizeJson(snap) as MonitorSnapshot
  }

  // 设置探测：better-sidebar 可见性（aionui-panel 互斥，docs/05 §3.2）
  let uiVisibleVal = true
  function uiVisible(): boolean {
    return uiVisibleVal
  }
  try {
    const settings = ctx.get('settings') as unknown as {
      get(ns: string): unknown
      on?(event: string, fn: (ns: string) => void): void
    } | undefined
    if (settings && typeof settings.get === 'function') {
      const ns = settings.get('aionui-panel') as { rightPanel?: string } | null
      uiVisibleVal = !(ns && ns.rightPanel === 'aionui-panel')
      if (typeof settings.on === 'function') {
        settings.on('settings/updated', (ns2: string) => {
          if (ns2 === 'aionui-panel') {
            const v = settings.get('aionui-panel') as { rightPanel?: string } | null
            uiVisibleVal = !(v && v.rightPanel === 'aionui-panel')
          }
        })
      }
    }
  } catch (e) {
    /* 服务不可用 → 默认可见 */
  }

  // ── 阈值/watchProcs 持久化（2026-08-20：P2 2' 落地——settings.register + update）──
  // 命名空间 lab-monitor：{ thresholds: {utilWarn,memWarn,tempWarn,pollMs}, watchProcs: string[] }
  // 语义：settings 为唯一事实来源（schema 默认值 ∪ 用户 settings.yaml 覆盖）→ 初始化内存态；
  // 内存态变更（lab_ctl set-threshold / watch / 请求携带覆盖）→ update 写回持久化。
  let settingsScope: SettingsScopeLike | null = null
  try {
    const settingsSvc = ctx.get('settings') as unknown as {
      register?(ns: string, schema: unknown, opts?: { base?: unknown; applies?: string }): SettingsScopeLike
    } | undefined
    if (settingsSvc && typeof settingsSvc.register === 'function') {
      const persistSchema = Schema.object({
        thresholds: Schema.object({
          utilWarn: Schema.number().default(THRESHOLD_DEFAULTS.utilWarn),
          memWarn: Schema.number().default(THRESHOLD_DEFAULTS.memWarn),
          tempWarn: Schema.number().default(THRESHOLD_DEFAULTS.tempWarn),
          pollMs: Schema.number().default(THRESHOLD_DEFAULTS.pollMs),
        }),
        watchProcs: Schema.array(Schema.string()).default([]),
      })
      settingsScope = settingsSvc.register('lab-monitor', persistSchema, { applies: 'live' })
      // 读回持久化基线（重启后 lab_ctl 改的阈值 / watch 动态注册不再丢失）
      const stored = settingsScope.get() as { thresholds?: Partial<Thresholds>; watchProcs?: string[] } | null
      if (stored && stored.thresholds) thresholds.apply(stored.thresholds as never, true)
      if (stored && Array.isArray(stored.watchProcs)) {
        cfg.watchProcs = stored.watchProcs.filter((k): k is string => typeof k === 'string' && k.length > 0)
      }
      // 外部修改（用户手改 settings.yaml / 其他配置面）实时生效
      if (typeof settingsScope.watch === 'function') {
        settingsScope.watch((next) => {
          const v = next as { thresholds?: Partial<Thresholds>; watchProcs?: string[] } | null
          if (v && v.thresholds) thresholds.apply(v.thresholds as never, true)
          if (v && Array.isArray(v.watchProcs)) {
            cfg.watchProcs = v.watchProcs.filter((k): k is string => typeof k === 'string' && k.length > 0)
          }
        })
      }
      console.log('[lab-monitor] 阈值/watchlist 持久化已启用（settings 命名空间 lab-monitor）')
    }
  } catch (e) {
    console.warn('[lab-monitor] settings 持久化不可用，回退内存模式（阈值/watchlist 重启即还原）:', (e as Error).message)
  }

  // 写入辅助：内存态变更 → 持久化（失败静默降级内存，不影响运行）
  function persistState() {
    if (!settingsScope || typeof settingsScope.update !== 'function') return
    try {
      settingsScope.update({ thresholds: thresholds.get(), watchProcs: watchSet() })
    } catch (e) {
      console.warn('[lab-monitor] 设置持久化写入失败（保留内存值）:', (e as Error).message)
    }
  }

  // ── RPC 方法集合（webServer HTTP 数据面）───────────────────────────────
  function rpcSnapshot(args?: { thresholds?: Partial<Record<string, number>> }) {
    if (args && args.thresholds) {
      // M3：携带值视作「建议更新」，晚于生效时间戳才覆盖；覆盖成功即持久化
      if (thresholds.apply(args.thresholds as never, false)) persistState()
    }
    return buildSnapshot()
  }
  function rpcHistory(args?: { sinceMs?: number; bucketMs?: number }) {
    const a = args || {}
    const sinceMs = typeof a.sinceMs === 'number' ? a.sinceMs : Date.now() - 30 * 60 * 1000
    const bucketMs = typeof a.bucketMs === 'number' ? a.bucketMs : 10000
    return ring.history(sinceMs, bucketMs)
  }
  function rpcSetThresholds(args?: Record<string, number>) {
    const a = args || {}
    const applied: Record<string, number> = {}
    const keys = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs']
    for (let n = 0; n < keys.length; n++) {
      const k = keys[n]
      if (typeof a[k] === 'number' && isFinite(a[k])) applied[k] = a[k]
    }
    thresholds.apply(applied, true) // 直连 = 即时生效（M3）
    persistState() // 2026-08-20：P2 2' —— 阈值写回 settings 持久化（重启不丢失）
    return { ok: true, applied: thresholds.get() }
  }
  function rpcControl(args?: { action?: string }) {
    const action = args && args.action
    if (action === 'start') enabled = true
    else if (action === 'pause') enabled = false
    else if (action === 'resume') enabled = true
    else return { ok: false, error: '未知 action: ' + action }
    return { ok: true, state: enabled ? 'running' : 'paused' }
  }
  function rpcAdvice() {
    return balancer.advice()
  }

  // ── webServer HTTP 路由（替代动态版 harness.handle RPC）───────────────
  const API_BASE = '/lab-monitor/api'
  const apiHandlers: Record<string, (body: Record<string, unknown>) => unknown> = {
    snapshot: (body) => rpcSnapshot({ thresholds: body.thresholds as Partial<Record<string, number>> | undefined }),
    history: (body) => rpcHistory({ sinceMs: body.sinceMs as number | undefined, bucketMs: body.bucketMs as number | undefined }),
    setThresholds: (body) => rpcSetThresholds(body as Record<string, number>),
    control: (body) => rpcControl({ action: body.action as string | undefined }),
    advice: () => rpcAdvice(),
  }

  function httpHandler(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || '/', 'http://localhost')
    if (!url.pathname.startsWith(API_BASE + '/')) {
      res.writeHead(404).end('not found')
      return
    }
    const method = url.pathname.slice(API_BASE.length + 1)
    const handler = apiHandlers[method]
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: '未知方法: ' + method }))
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      try {
        const parsed: Record<string, unknown> = body ? JSON.parse(body) : {}
        const result = handler(parsed)
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: (e as Error).message }))
      }
    })
    req.on('error', () => {
      res.writeHead(400).end()
    })
  }

  const webServer = ctx.webServer as unknown as {
    register(route: { kind: 'http'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
  }
  try {
    const disposer = webServer.register({
      kind: 'http',
      path: API_BASE,
      handler: httpHandler,
    })
    ctx.effect(() => disposer)
  } catch (e) {
    console.error('[lab-monitor] webServer 路由注册失败:', e)
  }

  // ── Agent 工具（工具桥）────────────────────────────────────────────────
  function renderText(value: unknown): ContentBlock[] {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  }

  const toolsService = ctx.tools as unknown as { register(def: unknown): () => void }
  try {
    const disposers: (() => void)[] = []
      disposers.push(
        toolsService.register(
          defineTool({
            name: 'lab_status',
            description: '查询 Lab Monitor 实时资源快照（GPU/CPU/内存/进程/实验/告警/watchlist）。返回完整 JSON 快照；brief:true 取一行摘要。',
            parameters: {
              brief: { type: 'boolean', description: '为 true 时只返回一行摘要字符串' },
            },
            output: {
              schema: { type: 'json' },
              render: (args: { brief?: boolean }, value: unknown) => {
                const snap = value as MonitorSnapshot
                return renderText(args && args.brief === true ? promptLine(snap) : value)
              },
            },
            async execute(args: { brief?: boolean }) {
              const snap = buildSnapshot()
              // 2026-08-20：附加 watchlist（Agent 可见当前监控注册配置）
              ;(snap as unknown as { watchlist: string[] }).watchlist = watchSet()
              if (args && args.brief === true) return { ok: true, line: promptLine(snap) } as never
              return snap as never
            },
          }),
        ),
      )
      disposers.push(
        toolsService.register(
          defineTool({
            name: 'lab_advice',
            description: '查询 Lab Monitor 平衡引擎当前建议（分级 + 置信度 + 可执行动作）。无告警时 advice 为空数组。',
            parameters: {},
            output: {
              schema: { type: 'json' },
              render: (_args: Record<string, unknown>, value: unknown) => renderText(value),
            },
            async execute() {
              const a = rpcAdvice()
              // 2026-08-20：advice 携带 evidence（共享 balancer 内部引用）——复制清洗防
              // NaN/undefined 破坏 lossless JSON 校验，且不污染内部告警流
              return sanitizeJson({ ok: true, advice: a.advice, generatedAt: a.generatedAt }) as never
            },
          }),
        ),
      )
      disposers.push(
        toolsService.register(
          defineTool({
            name: 'lab_ctl',
            description: '控制 Lab Monitor 监控/告警引擎（start/pause/resume/set-threshold/watch）。护栏：只控制监控引擎，绝不触碰实验进程。',
            parameters: {
              action: { type: 'string', required: true, enum: ['start', 'pause', 'resume', 'set-threshold', 'watch'], description: '操作类型' },
              keywords: {
                type: 'array',
                items: { type: 'string' },
                description: 'watch 时的进程名关键词列表（如 ["llama-server","vllm"]）；空数组=清空动态注册',
              },
              thresholds: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  utilWarn: { type: 'number', description: 'GPU 利用率告警阈值 %' },
                  memWarn: { type: 'number', description: '显存占用告警阈值 %' },
                  tempWarn: { type: 'number', description: '温度告警阈值 °C' },
                  pollMs: { type: 'number', description: 'UI 轮询周期 ms' },
                },
                description: 'set-threshold 时的阈值',
              },
            },
            output: {
              schema: { type: 'json' },
              render: (_args: Record<string, unknown>, value: unknown) => renderText(value),
            },
            async execute(args: { action?: string; keywords?: string[]; thresholds?: Record<string, unknown> }) {
              const a = args || {}
              if (a.action === 'watch') {
                const kws = Array.isArray(a.keywords) ? a.keywords.filter((k) => typeof k === 'string' && k.trim()) : []
                runtimeWatch.clear()
                for (const k of kws) runtimeWatch.add(k.trim())
                persistState() // 2026-08-20：动态 watchlist 写回 settings 持久化（重启不丢失）
                // 命中预览：立即返回当前快照中命中 watchlist 的进程（Agent 可见证据）
                const wp = buildSnapshot().watchedPids || []
                return { ok: true, state: 'watchlist-updated', keywords: watchSet(), matchedPids: wp } as never
              }
              if (a.action === 'set-threshold') {
                const thr: Record<string, number> = {}
                const keys = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs']
                for (const k of keys) {
                  const v = a.thresholds && (a.thresholds as Record<string, unknown>)[k]
                  if (typeof v === 'number' && isFinite(v)) thr[k] = v
                }
                // 1.2：写阈值时返回当前拆分统计（快照语义，Agent 设置前可见证据）
                return sanitizeJson({ ok: true, applied: rpcSetThresholds(thr).applied, system: lastSystemStats }) as never
              }
              return { ok: true, state: rpcControl({ action: a.action }).state } as never
            },
          }),
        ),
      )
      ctx.effect(() => () => disposers.forEach((d) => d()))
    } catch (e) {
      console.error('[lab-monitor] 工具注册失败:', e)
    }

  // ── prompt 注入（KV 缓存友好：默认关闭，仅 cfg.promptInjection 开启）───
  try {
    const sp = ctx.get('systemPrompt' as never) as unknown as {
      variable(name: string, provider: () => string): void
      section(decl: { name: string; order: number; text: string }): void
    } | undefined
    if (sp && cfg.promptInjection) {
      sp.variable('labstatus', () => promptLine(buildSnapshot()))
      sp.section({ name: 'lab-monitor:status', order: 150, text: '{{labstatus}}' })
      console.log('[lab-monitor] prompt 变量 labstatus 已注入（promptInjection=true）')
    } else if (sp && typeof sp.variable === 'function') {
      console.log('[lab-monitor] prompt 注入已关闭（KV 缓存友好默认），使用 lab_status 工具按需查询')
    }
  } catch (e) {
    console.error('[lab-monitor] prompt 注册错误:', e)
  }

  // ── 生命周期 hooks ─────────────────────────────────────────────────────
  // ① pre-execute（waterfall，默认放行）——训练命令 → 实验开始
  // 注：exec 实参为 ToolExecution（arguments: unknown），用宽松结构接收
  const preExecHandler = async (exec: { name?: string; arguments?: Record<string, unknown> }, next: () => Promise<{ kind: string }>) => {
    try {
      if (enabled && exec && (exec.name === 'bash' || exec.name === 'run_code')) {
        const args = exec.arguments
        const cmd = args ? (args.command !== undefined ? String(args.command) : exec.name === 'bash' ? null : String(args.code ?? '')) : null
        const feature = matchTrainFeature(cmd || null)
        if (feature) {
          const run = machine.start(cmd || '', feature)
          console.log('[lab-monitor] 实验开始命中:', feature, '| runId=', run.runId, '| cmd=', String(cmd).slice(0, 80))
        }
      }
    } catch (e) {
      console.error('[lab-monitor] pre-execute 处理错误:', e)
    }
    return await next()
  }
  ctx.on('tools/pre-execute', preExecHandler as never)
  // ② tools/result（emit）——配对校验后结束（T1-2：不匹配忽略，kill 不误判 done）
  const resultHandler = (exec: { name?: string; arguments?: Record<string, unknown> }, result: unknown) => {
    try {
      const run = machine.cur()
      if (!run) return
      const name = exec && exec.name
      const args = exec && exec.arguments
      const cmd = args ? (args.command !== undefined ? String(args.command) : name === 'bash' ? null : String(args.code ?? '')) : null
      // v1.4.5：配对校验剥离 pyc: 前缀 + 归一化（引号剥离），与 findAliveProc 一致
      let fp = run.fingerprint
      if (typeof fp === 'string' && fp.indexOf('pyc:') === 0) fp = fp.slice(4)
      const normCmd = typeof cmd === 'string' ? normalizeCmdForMatch(cmd) : null
      const paired = name === 'bash' && normCmd !== null && normCmd.indexOf(fp) !== -1
      if (paired) console.log('[lab-monitor] 配对 result 命中，实验结束判定进行中… runId=', run.runId)
      machine.markResult(paired)
    } catch (e) {
      console.error('[lab-monitor] result 处理错误:', e)
    }
  }
  ctx.on('tools/result', resultHandler as never)

  console.log('[lab-monitor] 核心引擎已启动（采样 ' + cfg.sampleMs + 'ms / ps ' + PS_INTERVAL_MS + 'ms）')
}
