/**
 * lab-monitord 入口：装配 config-store + engine + sinks + http + mcp。
 * - 单实例：daemon.json 里的 pid 仍存活 → 记日志后 exit 0（不拉第二个采样器）；
 *   端口 EADDRINUSE 同样 exit 0。flock 硬锁由 scripts/lab-monitord.sh 承担（`flock -n` 包裹本入口）。
 * - SIGTERM/SIGINT：停引擎（关后端子进程）+ 关 sink + 关服 → exit 0。
 * - listen 成功后写 ~/.local/state/lab-monitor/daemon.json { url, pid, startedAt, protocolVersion }
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { createDaemonHttpServer, listenOn } from './http.js'
import { createEngine } from './engine.js'
import { createLocalRunner } from './runner-local.js'
import type { SamplerBackend } from '../sampler/backend-interface.js'
import { SinkRegistry } from './sinks/registry.js'
import { DAEMON_VERSION, PROTOCOL_VERSION, ensureToken, loadConfig, logLine, saveConfig, stateHome, configHome, type DaemonConfig } from './config-store.js'
import type { AnySink, RunDataView } from './sinks/spi.js'

export interface CreateDaemonOptions {
  home?: string
  stateHome?: string
  port?: number
  host?: string
  /** 测试注入 sink（如必抛错的 fake） */
  sinks?: AnySink[]
  mcpEnabled?: boolean
  mcpAllowControl?: boolean
  token?: string
  /** 测试跳过后端探测（不起采样后端，纯 HTTP/MCP 面） */
  skipBackend?: boolean
  /** 测试注入采样后端（与 skipBackend 合用：不起真实后端，但 tickOnce 会记样本） */
  testBackend?: SamplerBackend
}

export interface DaemonInstance {
  port: number
  close(): Promise<void>
  tickOnce(): Promise<void>
  dispatchExperimentEnd(view: RunDataView): void
  engine: ReturnType<typeof createEngine>
  cfg: DaemonConfig
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function createDaemon(opts: CreateDaemonOptions = {}): Promise<DaemonInstance> {
  const home = configHome(opts.home)
  const stateDir = stateHome(opts.stateHome)
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(join(home, 'credentials'), { recursive: true })

  const cfg = loadConfig(opts.home)
  const token = opts.token || ensureToken(opts.home)
  const persist = (): void => {
    try { saveConfig(cfg, opts.home) } catch (e) {
      logLine(stateDir, 'warn', 'config', 'persist failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }
  const log = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>): void => {
    logLine(stateDir, level, 'engine', msg, fields)
  }

  const sinks = new SinkRegistry(home, stateDir, cfg.sinks, opts.sinks)
  const engine = createEngine({ cfg, runner: createLocalRunner(), sinks, persist, log, backend: opts.testBackend })

  const port = opts.port !== undefined ? opts.port : (Number(process.env.LAB_MONITOR_DAEMON_PORT) > 0 ? Number(process.env.LAB_MONITOR_DAEMON_PORT) : cfg.server.port)
  const host = opts.host || cfg.server.host || '127.0.0.1'

  const server = createDaemonHttpServer({
    engine,
    token,
    maxSseClients: cfg.server.maxSseClients,
    mcpEnabled: opts.mcpEnabled !== undefined ? opts.mcpEnabled : cfg.mcp.enabled,
    mcpAllowControl: opts.mcpAllowControl !== undefined ? opts.mcpAllowControl : cfg.mcp.allowControl,
  })

  let boundPort: number
  try {
    boundPort = await listenOn(server, port, host)
  } catch (e) {
    // 端口被占 = 已有实例在跑：不抛、不拉第二个采样器
    logLine(stateDir, 'info', 'main', 'port in use, another instance likely running; exiting 0', { port, error: e instanceof Error ? e.message : String(e) })
    await sinks.stop()
    throw e
  }

  writeFileSync(join(stateDir, 'daemon.json'), JSON.stringify({
    url: 'http://127.0.0.1:' + boundPort,
    pid: process.pid,
    startedAt: Date.now(),
    protocolVersion: PROTOCOL_VERSION,
  }, null, 2) + '\n', { mode: 0o644 })

  logLine(stateDir, 'info', 'main', 'daemon listening', { port: boundPort, version: DAEMON_VERSION })

  let started = false
  const instance: DaemonInstance = {
    port: boundPort,
    engine,
    cfg,
    async close(): Promise<void> {
      if (started) {
        engine.stopWindowLoop()
        engine.stop()
      }
      await sinks.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        const f = join(stateDir, 'daemon.json')
        if (existsSync(f)) {
          const dj = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
          if (dj.pid === process.pid) writeFileSync(f, JSON.stringify({ url: null, pid: 0, startedAt: Date.now(), protocolVersion: PROTOCOL_VERSION }) + '\n')
        }
      } catch { /* 清理失败不阻塞 */ }
      logLine(stateDir, 'info', 'main', 'daemon closed', { port: boundPort })
    },
    async tickOnce(): Promise<void> {
      await engine.sampleTick()
    },
    dispatchExperimentEnd(view: RunDataView): void {
      sinks.dispatchExperimentEnd(view)
    },
  }

  if (!opts.skipBackend) {
    engine.start()
    engine.startWindowLoop()
    started = true
  }
  return instance
}

/** 常驻入口（node lib/types/daemon/main.js）；import 方仅消费 createDaemon */
export async function main(): Promise<number> {
  const stateDir = stateHome()
  // 单实例：daemon.json pid 仍存活（且非本进程）→ exit 0
  const djFile = join(stateDir, 'daemon.json')
  if (existsSync(djFile)) {
    try {
      const dj = JSON.parse(readFileSync(djFile, 'utf8')) as { pid?: number; url?: unknown }
      if (typeof dj.pid === 'number' && dj.pid > 0 && dj.pid !== process.pid && pidAlive(dj.pid) && dj.url) {
        console.log('[lab-monitord] 已有实例在运行 (pid ' + dj.pid + ')，退出 0，不启动第二个采样器')
        return 0
      }
    } catch { /* 损坏的 daemon.json 视为无实例 */ }
  }
  let exiting = false
  let instance: DaemonInstance | null = null
  const shutdown = (sig: string): void => {
    if (exiting) return
    exiting = true
    console.log('[lab-monitord] 收到 ' + sig + '，关闭后端与 sink…')
    void (async () => {
      if (instance) await instance.close()
      process.exit(0)
    })()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  try {
    instance = await createDaemon()
  } catch (e) {
    // EADDRINUSE 等绑定失败：不重复采样，退出 0（flock 层已保证互斥）
    console.log('[lab-monitord] 启动失败（端口占用？另一实例在跑）：' + (e instanceof Error ? e.message : String(e)))
    return 0
  }
  console.log('[lab-monitord] listening on http://127.0.0.1:' + instance.port)
  // 常驻：保持事件循环（server 句柄已足够；此处仅为可读性）
  await new Promise<void>(() => { /* 常驻直到信号 */ })
  return 0
}

// 直接执行（ESM canonical 判定；import 方不触发常驻 main）
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  void main().then((code) => {
    if (code !== 0) process.exit(code)
  })
}
