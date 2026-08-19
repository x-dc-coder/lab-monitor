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

import { createBackend, collectSnapshot, probeBackend } from './sampler/index.js'
import type { Runner, SamplerBackend, Snapshot } from './sampler/backend-interface.js'
import { createRing } from './core/ring.js'
import { createStateMachine, parsePs } from './core/state-machine.js'
import { createBalancer, createThresholds } from './core/balancer.js'
import {
  SAMPLE_MS,
  PS_INTERVAL_MS,
  THRESHOLD_DEFAULTS,
  matchTrainFeature,
  normalizeCmdForMatch,
} from './core/constants.js'
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
    degraded: snap.degraded || null,
  } satisfies SamplePoint
}

function fmtGiBx(mib: number | null | undefined): string {
  if (mib === null || mib === undefined || Number.isNaN(mib)) return '-'
  const g = mib / 1024
  return g >= 100 ? String(Math.round(g)) : String(Math.round(g * 10) / 10)
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
      // ps 周期（5s）→ 状态机 tick
      if (Date.now() - backendState.psAt >= PS_INTERVAL_MS) {
        backendState.psAt = Date.now()
        const psOut = await runner.exec('ps -eo pid=,args= --no-headers 2>/dev/null')
        const procs = parsePs(psOut)
        machine.tick(procs)
        const curRun = machine.cur()
        if (curRun && curRun.resultSeen) machine.tickGrace(curRun)
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
      procs: (base.procs || []).slice(0, 15),
      alerts: balancer.snapshotAlerts(),
      alertsCriticalCount: balancer.count(),
      experiment: machine.snapshot(),
      callCount,
      ui: { betterSidebarVisible: uiVisible() },
    }
    if (base.degraded) snap.degraded = base.degraded
    return snap
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

  // ── RPC 方法集合（webServer HTTP 数据面）───────────────────────────────
  function rpcSnapshot(args?: { thresholds?: Partial<Record<string, number>> }) {
    if (args && args.thresholds) thresholds.apply(args.thresholds as never, false)
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
            description: '查询 Lab Monitor 实时资源快照（GPU/CPU/内存/进程/实验/告警）。返回完整 JSON 快照；brief:true 取一行摘要。',
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
              return { ok: true, advice: a.advice, generatedAt: a.generatedAt } as never
            },
          }),
        ),
      )
      disposers.push(
        toolsService.register(
          defineTool({
            name: 'lab_ctl',
            description: '控制 Lab Monitor 监控/告警引擎（start/pause/resume/set-threshold）。护栏：只控制监控引擎，绝不触碰实验进程。',
            parameters: {
              action: { type: 'string', required: true, enum: ['start', 'pause', 'resume', 'set-threshold'], description: '操作类型' },
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
            async execute(args: { action?: string; thresholds?: Record<string, unknown> }) {
              const a = args || {}
              if (a.action === 'set-threshold') {
                const thr: Record<string, number> = {}
                const keys = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs']
                for (const k of keys) {
                  const v = a.thresholds && (a.thresholds as Record<string, unknown>)[k]
                  if (typeof v === 'number' && isFinite(v)) thr[k] = v
                }
                return { ok: true, applied: rpcSetThresholds(thr).applied } as never
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
