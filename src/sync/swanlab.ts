/**
 * SwanLab 按需同步模块（写入通道、脱敏、Ring 降级、门控与并发锁）
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ring } from '../core/ring.js'
import type { StateMachine } from '../core/state-machine.js'
import type { EndedRunSnapshot, RunRecord, SwanLabConfig, SwanLabStatus, SwanLabSyncConditions } from '../core/types.js'

// ── 内存级并发锁（per-run）──────────────────────────────────────────────────
const activeSyncLocks = new Set<string>()

export function isRunSyncing(runId: string): boolean {
  return activeSyncLocks.has(runId)
}

export function acquireSyncLock(runId: string): boolean {
  if (activeSyncLocks.has(runId)) return false
  activeSyncLocks.add(runId)
  return true
}

export function releaseSyncLock(runId: string): void {
  activeSyncLocks.delete(runId)
}

// ── 命令行敏感信息正则脱敏 ───────────────────────────────────────────────────

/**
 * 脱敏命令行中的 token, api_key, password, secret 等敏感参数
 */
export function sanitizeCmd(cmd: string | null | undefined): string {
  if (!cmd || typeof cmd !== 'string') return ''
  let sanitized = cmd

  // 1. URL 认证信息: http(s)://user:pass@host
  sanitized = sanitized.replace(/(https?:\/\/)[^:\s]+:[^@\s]+@/gi, '$1***:***@')

  // 2. Bearer token
  sanitized = sanitized.replace(/\b(bearer\s+)[a-zA-Z0-9_\-\.]+/gi, '$1***')

  // 3. 命令行参数: --token=xxx, --api-key xxx, -p xxx
  sanitized = sanitized.replace(
    /(--(?:token|api[-_]?key|apikey|secret(?:[-_]?key)?|password|auth[-_]?token|access[-_]?token))([=\s])(["']?)[^"'\s]+\3/gi,
    '$1$2***',
  )

  // 4. 短密码参数: -p password
  sanitized = sanitized.replace(/(-p\s+)(["']?)[^"'\s]+\2/gi, '$1***')

  // 5. 环境变量或 key=value: KEY=xxx, "token": "xxx"
  sanitized = sanitized.replace(
    /\b([a-zA-Z0-9_-]*(?:token|api[-_]?key|secret|password)[a-zA-Z0-9_-]*)\s*(=|:\s*)(["']?)[^"'\s]+\3/gi,
    '$1$2***',
  )

  return sanitized
}

// ── 门控条件匹配 ─────────────────────────────────────────────────────────────

export interface MatchSyncResult {
  matched: boolean
  reason?: string
}

export function matchSyncConditions(
  run: RunRecord | EndedRunSnapshot,
  conditions?: SwanLabSyncConditions,
  tagHits?: string[],
): MatchSyncResult {
  if (!conditions) return { matched: true }

  // 1. allowedStates（如 ['done', 'crashed']）
  if (conditions.allowedStates && conditions.allowedStates.length > 0) {
    if (!conditions.allowedStates.includes(run.state as never)) {
      return {
        matched: false,
        reason: `run state "${run.state}" is not in allowedStates [${conditions.allowedStates.join(', ')}]`,
      }
    }
  }

  // 2. minDurationSec 最小实验时长
  if (typeof conditions.minDurationSec === 'number' && conditions.minDurationSec > 0) {
    const durSec =
      run.summary && typeof run.summary.durationSec === 'number'
        ? run.summary.durationSec
        : run.endTs
          ? Math.max(0, Math.round((run.endTs - run.startTs) / 1000))
          : 0
    if (durSec < conditions.minDurationSec) {
      return {
        matched: false,
        reason: `run duration (${durSec}s) is less than minDurationSec (${conditions.minDurationSec}s)`,
      }
    }
  }

  // 3. includeTypes 实验类型过滤
  if (conditions.includeTypes && conditions.includeTypes.length > 0) {
    const runType = run.type || 'unknown'
    if (!conditions.includeTypes.includes(runType as never)) {
      return {
        matched: false,
        reason: `run type "${runType}" is not in includeTypes [${conditions.includeTypes.join(', ')}]`,
      }
    }
  }

  // 4. requireTags 标签要求
  if (conditions.requireTags && conditions.requireTags.length > 0) {
    const hits = tagHits || []
    const hasTag = conditions.requireTags.some((t) => hits.includes(t))
    if (!hasTag) {
      return {
        matched: false,
        reason: `run tags [${hits.join(', ')}] do not match requireTags [${conditions.requireTags.join(', ')}]`,
      }
    }
  }

  return { matched: true }
}

// ── Python swanlab 运行时依赖预检 ─────────────────────────────────────────────

export async function checkSwanLabAvailable(
  pythonBin: string = 'python3',
): Promise<{ available: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(pythonBin, ['-c', 'import swanlab'], { timeout: 10000 }, (error, _stdout, stderr) => {
      if (error) {
        const msg = (stderr || error.message || '').trim()
        resolve({
          available: false,
          error: `SwanLab dependency check failed: Python package "swanlab" is not installed. Please install it with "pip install swanlab". (${msg})`,
        })
      } else {
        resolve({ available: true })
      }
    })
  })
}

// ── 指标抽取与 Ring 降级 ─────────────────────────────────────────────────────

export interface ExtractedMetrics {
  seriesAvailable: boolean
  series: Array<{ step: number; metrics: Record<string, number> }>
  summary: {
    gpuUtilMax: number | null
    gpuUtilAvg: number | null
    memPeak: number | null
    groupCpuMax: number | null
    durationSec: number
  }
}

/**
 * 提取时间窗口内历史点并生成 SwanLab 标量指标
 * 若点数不足或被 Ring 覆盖，降级为 summary-only 上报，标记 seriesAvailable: false
 */
export function extractMetricsForRun(
  run: RunRecord | EndedRunSnapshot,
  ring?: Ring,
): ExtractedMetrics {
  const s = run.summary
  const durationSec =
    s && typeof s.durationSec === 'number'
      ? s.durationSec
      : run.endTs
        ? Math.max(0, Math.round((run.endTs - run.startTs) / 1000))
        : 0

  const summary = {
    gpuUtilMax: s && typeof s.gpuUtilMax === 'number' ? s.gpuUtilMax : null,
    gpuUtilAvg: s && typeof s.gpuUtilAvg === 'number' ? s.gpuUtilAvg : null,
    memPeak: s && typeof s.memPeak === 'number' ? s.memPeak : null,
    groupCpuMax: s && typeof s.groupCpuMax === 'number' ? s.groupCpuMax : null,
    durationSec,
  }

  // Ring 降级检查
  if (!ring || ring.size() === 0 || s?.dataPartial === true) {
    return {
      seriesAvailable: false,
      series: [],
      summary,
    }
  }

  // 提取历史桶点（周期 10000ms）
  const hist = ring.history(run.startTs, 10000)
  const endTs = run.endTs || Date.now()
  const pts = (hist.points || []).filter((p) => p.ts >= run.startTs && p.ts <= endTs + 10000)

  // 点数过少时降级为 summary-only 上报
  if (pts.length < 2) {
    return {
      seriesAvailable: false,
      series: [],
      summary,
    }
  }

  const series: Array<{ step: number; metrics: Record<string, number> }> = []
  for (const p of pts) {
    const step = Math.round((p.ts - run.startTs) / 10000)
    const metrics: Record<string, number> = {}

    if (typeof p.gpuUtil === 'number') metrics['lab-monitor/gpu.util'] = p.gpuUtil
    if (typeof p.gpuMem === 'number') metrics['lab-monitor/gpu.mem'] = p.gpuMem
    if (typeof p.cpu === 'number') metrics['lab-monitor/cpu.util'] = p.cpu
    if (typeof p.memUsed === 'number') metrics['lab-monitor/mem.used'] = p.memUsed
    if (typeof p.groupCpu === 'number') metrics['lab-monitor/group.cpu'] = p.groupCpu
    if (typeof p.groupMem === 'number') metrics['lab-monitor/group.mem'] = p.groupMem

    if (Object.keys(metrics).length > 0) {
      series.push({ step, metrics })
    }
  }

  if (series.length === 0) {
    return {
      seriesAvailable: false,
      series: [],
      summary,
    }
  }

  return {
    seriesAvailable: true,
    series,
    summary,
  }
}

// ── 嵌入式 Python Worker 源码备用（防止脚本缺失）─────────────────────────────
const EMBEDDED_WORKER_SCRIPT = `#!/usr/bin/env python3
import sys, os, json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Missing input payload file"}))
        sys.exit(1)
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Failed to parse payload: {e}"}))
        sys.exit(1)
    try:
        import swanlab
    except ImportError as e:
        print(json.dumps({"success": False, "error": f"swanlab is not installed: {e}"}))
        sys.exit(1)

    api_key = data.get("apiKey")
    project = data.get("project") or "lab-monitor"
    workspace = data.get("workspace")
    log_dir = data.get("logDir")
    mode = data.get("mode") or ("cloud" if api_key else "local")
    experiment_name = data.get("experimentName")
    description = data.get("description")
    config = data.get("config") or {}
    series_available = bool(data.get("seriesAvailable"))
    series = data.get("series") or []
    summary = data.get("summary") or {}

    if api_key:
        try:
            swanlab.login(api_key=api_key, save=False)
        except Exception as e:
            print(json.dumps({"success": False, "error": f"SwanLab login failed: {e}"}))
            sys.exit(1)

    init_kwargs = {
        "project": project,
        "name": experiment_name,
        "description": description,
        "config": config,
    }
    if log_dir:
        init_kwargs["log_dir"] = log_dir
    if workspace:
        init_kwargs["workspace"] = workspace
    if mode in ("local", "offline", "disabled"):
        init_kwargs["mode"] = mode

    run = None
    try:
        run = swanlab.init(**init_kwargs)
        if series_available and isinstance(series, list):
            for item in series:
                step = item.get("step")
                metrics = item.get("metrics")
                if metrics and isinstance(metrics, dict):
                    if step is not None:
                        swanlab.log(metrics, step=int(step))
                    else:
                        swanlab.log(metrics)

        summary_metrics = {}
        if summary.get("gpuUtilMax") is not None:
            summary_metrics["lab-monitor/summary.gpu_util_max"] = summary["gpuUtilMax"]
        if summary.get("gpuUtilAvg") is not None:
            summary_metrics["lab-monitor/summary.gpu_util_avg"] = summary["gpuUtilAvg"]
        if summary.get("memPeak") is not None:
            summary_metrics["lab-monitor/summary.mem_peak"] = summary["memPeak"]
        if summary.get("groupCpuMax") is not None:
            summary_metrics["lab-monitor/summary.group_cpu_max"] = summary["groupCpuMax"]
        if summary.get("durationSec") is not None:
            summary_metrics["lab-monitor/summary.duration_sec"] = summary["durationSec"]

        if summary_metrics:
            swanlab.log(summary_metrics)

        run_id = getattr(run, "id", None)
        run_url = None
        try:
            run_url = getattr(run, "url", None) or getattr(run, "public_url", None)
        except Exception:
            pass
        if not run_url and run_id and workspace:
            run_url = f"https://swanlab.cn/@{workspace}/{project}/runs/{run_id}"

        swanlab.finish()
        print(json.dumps({"success": True, "runId": run_id, "runUrl": run_url}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
`

async function resolveWorkerScript(customPath?: string): Promise<{ scriptPath: string; isTemp: boolean }> {
  if (customPath && fs.existsSync(customPath)) {
    return { scriptPath: customPath, isTemp: false }
  }

  // 查找项目内置 scripts/swanlab-sync-worker.py
  try {
    const curFile = fileURLToPath(import.meta.url)
    const curDir = path.dirname(curFile)
    const candidates = [
      path.resolve(curDir, '../../scripts/swanlab-sync-worker.py'),
      path.resolve(curDir, '../scripts/swanlab-sync-worker.py'),
      path.resolve(process.cwd(), 'scripts/swanlab-sync-worker.py'),
    ]
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return { scriptPath: cand, isTemp: false }
      }
    }
  } catch (_e) {
    // import.meta.url 可能在特定环境受限
  }

  // 若无独立文件，写出临时 worker 脚本
  const tempScript = path.join(os.tmpdir(), `swanlab_worker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`)
  await fs.promises.writeFile(tempScript, EMBEDDED_WORKER_SCRIPT, { mode: 0o755 })
  return { scriptPath: tempScript, isTemp: true }
}

// ── 同步选项与执行 ───────────────────────────────────────────────────────────

export interface SwanLabSyncOptions {
  config?: SwanLabConfig
  stateMachine?: StateMachine
  ring?: Ring
  persistState?: () => Promise<void> | void
  pythonBin?: string
  workerScriptPath?: string
  customLogDir?: string
  force?: boolean
  skipDepCheck?: boolean
  activeTags?: string[]
}

export interface SwanLabSyncResult {
  ok: boolean
  status?: SwanLabStatus
  runId?: string
  runUrl?: string
  error?: string
  skipped?: boolean
}

/**
 * 触发单个实验上报 SwanLab
 */
export async function syncRunToSwanLab(
  run: RunRecord | EndedRunSnapshot,
  options: SwanLabSyncOptions = {},
): Promise<SwanLabSyncResult> {
  const runId = run.runId

  // 1. 并发锁控制
  if (!acquireSyncLock(runId)) {
    return {
      ok: false,
      status: 'syncing',
      error: `Sync already in progress for run ${runId}`,
      skipped: true,
    }
  }

  let tempPayloadPath: string | null = null
  let tempWorkerPath: string | null = null
  const tempLogDir = path.join(
    options.customLogDir || os.tmpdir(),
    `swanlog_${runId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  )

  try {
    // 2. 门控校验（非 force 模式下）
    if (!options.force) {
      const match = matchSyncConditions(run, options.config?.conditions, options.activeTags)
      if (!match.matched) {
        return {
          ok: false,
          error: match.reason,
          skipped: true,
        }
      }
    }

    // 3. 状态标记为 syncing
    options.stateMachine?.markSwanLabSynced(runId, {
      status: 'syncing',
      attemptTs: Date.now(),
    })

    // 4. 依赖预检
    const pythonBin = options.pythonBin || 'python3'
    if (!options.skipDepCheck) {
      const dep = await checkSwanLabAvailable(pythonBin)
      if (!dep.available) {
        const errMsg = dep.error || 'swanlab not installed'
        options.stateMachine?.markSwanLabSynced(runId, {
          status: 'failed',
          attemptTs: Date.now(),
          error: errMsg,
        })
        if (options.persistState) await options.persistState()
        return { ok: false, status: 'failed', error: errMsg }
      }
    }

    // 5. 指标抽取（Ring 降级）
    const { seriesAvailable, series, summary } = extractMetricsForRun(run, options.ring)

    // 6. 构造幂等实验名称: [lab-monitor] <fingerprint>-<startTs>
    const experimentName = `[lab-monitor] ${run.fingerprint || 'run'}-${run.startTs}`
    const sanitizedCmd = sanitizeCmd(run.cmd)

    const payload = {
      apiKey: options.config?.apiKey || process.env.SWANLAB_API_KEY || '',
      project: options.config?.project || 'lab-monitor',
      workspace: options.config?.workspace,
      logDir: tempLogDir,
      mode: (options.config?.apiKey || process.env.SWANLAB_API_KEY) ? 'cloud' : 'local',
      experimentName,
      description: `lab-monitor auto-synced run ${runId} (type: ${run.type || 'unknown'}, state: ${run.state})`,
      config: {
        runId,
        deviceId: run.deviceId || 'local',
        cmd: sanitizedCmd,
        state: run.state,
        type: run.type || 'unknown',
        startTs: run.startTs,
        endTs: run.endTs,
        durationSec: summary.durationSec,
        seriesAvailable,
      },
      seriesAvailable,
      series,
      summary,
    }

    // 写入独立临时文件
    tempPayloadPath = path.join(
      os.tmpdir(),
      `swanlab_payload_${runId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`,
    )
    await fs.promises.writeFile(tempPayloadPath, JSON.stringify(payload), 'utf-8')

    // 准备 worker 脚本
    const workerInfo = await resolveWorkerScript(options.workerScriptPath)
    if (workerInfo.isTemp) tempWorkerPath = workerInfo.scriptPath

    // 7. 调用 python worker 执行上报（超时 60s）
    const execResult = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        pythonBin,
        [workerInfo.scriptPath, tempPayloadPath!],
        { timeout: 60000 },
        (error, stdout, stderr) => {
          resolve({
            code: error ? (typeof (error as never as { code?: number }).code === 'number' ? (error as never as { code?: number }).code! : 1) : 0,
            stdout: stdout || '',
            stderr: stderr || '',
          })
        },
      )
    })

    let parsedOut: { success?: boolean; runId?: string; runUrl?: string; error?: string } = {}
    try {
      parsedOut = JSON.parse(execResult.stdout.trim())
    } catch (_e) {
      parsedOut = {
        success: false,
        error: execResult.stderr.trim() || execResult.stdout.trim() || `Worker exited with code ${execResult.code}`,
      }
    }

    if (parsedOut.success) {
      options.stateMachine?.markSwanLabSynced(runId, {
        status: 'synced',
        runId: parsedOut.runId,
        runUrl: parsedOut.runUrl,
        syncTs: Date.now(),
        error: undefined,
      })
      if (options.persistState) await options.persistState()
      return {
        ok: true,
        status: 'synced',
        runId: parsedOut.runId,
        runUrl: parsedOut.runUrl,
      }
    } else {
      const errMsg = parsedOut.error || 'SwanLab sync failed'
      options.stateMachine?.markSwanLabSynced(runId, {
        status: 'failed',
        attemptTs: Date.now(),
        error: errMsg,
      })
      if (options.persistState) await options.persistState()
      return {
        ok: false,
        status: 'failed',
        error: errMsg,
      }
    }
  } catch (err) {
    const errMsg = (err as Error).message || String(err)
    options.stateMachine?.markSwanLabSynced(runId, {
      status: 'failed',
      attemptTs: Date.now(),
      error: errMsg,
    })
    if (options.persistState) await options.persistState()
    return {
      ok: false,
      status: 'failed',
      error: errMsg,
    }
  } finally {
    // 8. 资源清理与锁释放（绝对清理临时日志与文件，绝不污染工作区）
    releaseSyncLock(runId)
    if (tempPayloadPath) {
      await fs.promises.rm(tempPayloadPath, { force: true }).catch(() => {})
    }
    if (tempWorkerPath) {
      await fs.promises.rm(tempWorkerPath, { force: true }).catch(() => {})
    }
    await fs.promises.rm(tempLogDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── 批量同步（串行队列）─────────────────────────────────────────────────────

export interface BatchSyncResult {
  total: number
  synced: number
  failed: number
  skipped: number
  results: Array<{ runId: string; ok: boolean; status?: SwanLabStatus; error?: string; runUrl?: string }>
}

export async function syncAllEligibleRuns(
  runs: (RunRecord | EndedRunSnapshot)[],
  options: SwanLabSyncOptions = {},
): Promise<BatchSyncResult> {
  const results: BatchSyncResult['results'] = []
  let synced = 0
  let failed = 0
  let skipped = 0

  for (const r of runs) {
    // 已经成功同步且非强制跳过
    if (!options.force && r.swanlab?.status === 'synced') {
      skipped += 1
      continue
    }

    const res = await syncRunToSwanLab(r, options)
    if (res.skipped) {
      skipped += 1
    } else if (res.ok) {
      synced += 1
    } else {
      failed += 1
    }

    results.push({
      runId: r.runId,
      ok: res.ok,
      status: res.status,
      error: res.error,
      runUrl: res.runUrl,
    })
  }

  return {
    total: runs.length,
    synced,
    failed,
    skipped,
    results,
  }
}
