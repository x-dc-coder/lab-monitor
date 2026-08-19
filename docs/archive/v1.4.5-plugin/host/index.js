// ============================================================================
// Lab Monitor Host 半核心引擎（MVP 单文件）—— D-A/D-C/D-D
// ============================================================================
// 职责：collector / ring-buffer / state-machine / balancer / hooks / rpc /
//       tools / prompt 注入 / settings 探测（核心引擎层，独立完整零第三方）
// 契约：docs/03-protocol.md（lab-protocol/1.1）；downstream 经 dev-run.sh 与
//       sampler/ 六文件按 D4-1 顺序 concat 成单一 code.host 函数体。
// 纪律：
//   - 本文件是 code.host 函数体的「顺序敏感初始化区」最后一段；顶层函数声明
//     共享函数体作用域；禁 import/export/require；沙箱内无全局 setTimeout，
//     一切延迟走 runner.sleep / ctx.interval / ctx.timeout
//   - 依赖声明：只 inject:['timer','shell','systemPrompt']（平台内建恒存在）；
//     settings 一律 ctx.get() 可选消费（betterSidebarVisible 探测，V1 硬伤防御）
//   - harness.* / ctx.on / ctx.interval 均为 fiber 副作用，cordis_stop 自动回滚
//   - 沙箱 ctx 不暴露 ctx.emit（rc.6 实证）→ 插件内事件用内部 dispatch（emitLab），
//     v2 正式插件再对平台广播 lab/*（docs/01 §四通道 #4 演进）
// ============================================================================

// ----------------------------------------------------------------------------
// §1 常量（指标/训练关键词/采样参数）
// ----------------------------------------------------------------------------
var LAB = LAB || {}
var ctxRef = null // apply 注入的 ctx（runner.sleep 兜底 / 工具注册目标）

var SAMPLE_MS = 2000          // 采集周期（核心层固定 2s；UI 轮询见 pollMs）
var PS_INTERVAL_MS = 5000     // 进程表（ps）周期——状态机 pid 关联/crashed 判定对齐
var RING_MAX_POINTS = 1000    // 环形缓冲双条件封顶（docs/02 §2.2）
var RING_MAX_MS = 30 * 60 * 1000
var RING_EXPAND_POINTS = 2000 // R-3：实验 running 期扩容至 2h
var RING_EXPAND_MS = 2 * 60 * 60 * 1000
var ALERT_MAX = 20            // 告警列表封顶
var CRASH_PS_GAP = 2          // pid 连续消失 ≥2 个 ps 周期（10~15s）→ crashed
var DONE_GRACE_TICKS = 2      // 配对 result 后进程仍活的宽限 ps 周期 → done

var THRESHOLD_DEFAULTS = { utilWarn: 90, memWarn: 95, tempWarn: 85, pollMs: 5000 }

// 训练命令关键词表（T4-1：python train*.py / python -c / python3 -c /
// torchrun / deepspeed / python -m）
var TRAIN_PATTERNS = [
  { name: 'python train*.py', re: /(?:^|[^a-z0-9._-])(?:python3?|uv)\s+(?:\S+[\/\\])?train[^\s'" ]*\.py/i },
  { name: 'python -c',       re: /(?:^|[^a-z0-9._-])python3?\s+-c\b/i },
  { name: 'python -m',       re: /(?:^|[^a-z0-9._-])python3?\s+-m\b/i },
  { name: 'torchrun',        re: /torchrun\b/i },
  { name: 'deepspeed',       re: /deepspeed\b/i },
]

function matchTrainFeature(cmdStr) {
  if (typeof cmdStr !== 'string') return null
  for (var i = 0; i < TRAIN_PATTERNS.length; i++) {
    if (TRAIN_PATTERNS[i].re.test(cmdStr)) return TRAIN_PATTERNS[i].name
  }
  return null
}

// 命令指纹：ps 关联 / result 配对用的特征串（T1-1/T1-2）
function cmdFingerprint(cmdStr) {
  var norm = String(cmdStr || '').trim().replace(/\s+/g, ' ')
  var m = norm.match(/(?:^|[^a-z0-9._-])([a-zA-Z0-9_.\-]+\.py)\b/i)
  if (m) return m[1]
  m = norm.match(/-c\s+["']?([\s\S]+?)["']?\s*(?:$|;)/)
  if (/python3?\s+-c\b/.test(norm) && m) {
    // v1.4.5（e2e 实证）：python -c 内联形态原用内容哈希（pyc:<hash>）作指纹，
    // ps 行 args 是代码原文（引号被 shell 剥离），哈希永不匹配 → pid 关联结构性失败
    // → 进程一结束即误判 crashed。改为「pyc: + 归一化命令从 -c 起的完整后缀前 28 字符」：
    // ps 行 indexOf 可匹配（findAliveProc 同归一化）；注意不可用 m[1]（分号处截断，
    // 如 'import time; time.sleep(12)' 只捕获 'import time'）。
    var tail = norm.slice(norm.indexOf('-c')).replace(/["']/g, '').replace(/\s+/g, ' ')
    return 'pyc:' + tail.slice(0, 28)
  }
  if (/torchrun|deepspeed/.test(norm)) return norm.split(/\s+/).slice(0, 6).join(' ').slice(0, 80)
  var tok = norm.split(/\s+/)[0] || ''
  return tok.slice(0, 40) || String(cmdStr).slice(0, 40)
}

// ps 行归一化：与 cmdFingerprint 的归一化对齐（引号剥离、空白折叠）
function normalizeCmdForMatch(s) {
  return String(s || '').replace(/["']/g, '').trim().replace(/\s+/g, ' ')
}

function simpleHash(s) {
  var h = 0
  for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0 }
  return Math.abs(h)
}

var RUN_ID_COUNTER = 0
function makeRunId() {
  RUN_ID_COUNTER += 1
  var d = new Date()
  var y = d.getFullYear(); var mo = ('0' + (d.getMonth() + 1)).slice(-2); var dd = ('0' + d.getDate()).slice(-2)
  return 'run-' + y + mo + dd + '-' + ('000' + RUN_ID_COUNTER).slice(-3)
}

// ----------------------------------------------------------------------------
// §2 runner 适配层（cordis：shell 服务 → SamplerBackend 通道契约）
// ----------------------------------------------------------------------------
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function makeRunner(shell) {
  function cmdLine(file, args) {
    var parts = [shq(file)]
    for (var i = 0; i < args.length; i++) parts.push(shq(args[i]))
    return parts.join(' ')
  }
  // v1.4.2（会话内验收实证）：cordis 沙箱 shell 服务（dsh-bash-sandbox）要求先 resolve()
  // 再 run/start——原始 request 直传 run() 会因 sandboxPolicy undefined 抛 TypeError
  // （全通道 code=-1，实证 A 路径）；且默认沙箱（workspace-write）拦截 /mnt/c interop
  // （实证 C 路径 exit 126 + denied）。监控命令集固定、无用户输入，统一显式 stamp
  // danger-full-access（探针 D/E 路径实证通过）。
  function resolveSpec(command, timeoutMs) {
    var spec = shell.resolve({ command: command, timeoutMs: timeoutMs === undefined ? 15000 : timeoutMs })
    spec.sandboxPolicy = { mode: 'danger-full-access' }
    return spec
  }
  return {
    async exec(cmdStr) {
      try {
        var r = await shell.run(resolveSpec(cmdStr))
        return {
          code: r.exitCode === null || r.exitCode === undefined ? -1 : r.exitCode,
          stdout: (r.stdout && r.stdout.text) || '',
          stderr: (r.stderr && r.stderr.text) || '',
        }
      } catch (e) {
        return { code: -1, stdout: '', stderr: String(e && e.message ? e.message : e) }
      }
    },
    execArgs(file, args) { return this.exec(cmdLine(file, args)) },
    execArgsEnc(file, args, enc) {
      return this.exec(cmdLine(file, args) + ' | iconv -f ' + shq(enc) + ' -t UTF-8')
    },
    spawnArgs(file, args) {
      var proc = shell.start(resolveSpec(cmdLine(file, args)))
      return {
        pid: null, // shell 服务不暴露 OS pid；孤儿清理靠 kill()（D2-1）
        readOutput() {
          try {
            var rd = proc.readOutput()
            return rd ? (rd.delta || '') : ''
          } catch (e) { return '' }
        },
        done() { return proc.exitCode !== null },
        kill() { try { proc.kill() } catch (e) {} },
      }
    },
    sleep(ms) {
      return new Promise(function (resolve) {
        try { var d = ctxRef.timeout(resolve, ms); d() } catch (e) { resolve() }
      })
    },
  }
}

// 沙箱内无全局 setTimeout：sleep 用 cordis timer（ctx.timeout 需 timer 注入）。
// apply 时用 patchRunnerSleep 覆盖为基于 ctx.timeout 的 Promise 版本。
function patchRunnerSleep(runner, ctx) {
  runner.sleep = function (ms) {
    return new Promise(function (resolve) {
      try { ctx.timeout(resolve, ms) } catch (e) { resolve() }
    })
  }
  return runner
}

// ----------------------------------------------------------------------------
// §3 ring-buffer（双条件封顶 + 查询降采样）
// ----------------------------------------------------------------------------
function createRing(maxPoints, maxMs) {
  var points = []
  var capPoints = maxPoints
  var capMs = maxMs
  return {
    push(s) {
      points.push(s)
      while (points.length > capPoints || (points.length > 1 && points[points.length - 1].ts - points[0].ts > capMs)) {
        points.shift()
      }
    },
    expand() { capPoints = RING_EXPAND_POINTS; capMs = RING_EXPAND_MS }, // R-3
    size() { return points.length },
    history(sinceMs, bucketMs) {
      bucketMs = bucketMs || 10000
      var buckets = []
      var cur = null
      for (var i = 0; i < points.length; i++) {
        var p = points[i]
        if (p.ts < sinceMs) continue
        var bk = Math.floor(p.ts / bucketMs) * bucketMs
        if (!cur || cur.bucket !== bk) {
          cur = { bucket: bk, ts: bk, gpuUtilSum: 0, gpuUtilN: 0, gpuMemSum: 0, gpuMemN: 0, cpuSum: 0, cpuN: 0, memUsedSum: 0, memUsedN: 0 }
          buckets.push(cur)
        }
        var g = p.gpu && p.gpu.length ? p.gpu[0] : null
        if (g && typeof g.utilPct === 'number') { cur.gpuUtilSum += g.utilPct; cur.gpuUtilN += 1 }
        if (g && typeof g.memUsedMiB === 'number') { cur.gpuMemSum += g.memUsedMiB; cur.gpuMemN += 1 }
        if (p.cpuPct !== null && typeof p.cpuPct === 'number') { cur.cpuSum += p.cpuPct; cur.cpuN += 1 }
        if (typeof p.memUsedMiB === 'number') { cur.memUsedSum += p.memUsedMiB; cur.memUsedN += 1 }
      }
      var out = buckets.map(function (b) {
        return {
          ts: b.ts,
          gpuUtil: b.gpuUtilN ? Math.round(b.gpuUtilSum / b.gpuUtilN) : null,
          gpuMem: b.gpuMemN ? Math.round(b.gpuMemSum / b.gpuMemN) : null,
          cpu: b.cpuN ? Math.round(b.cpuSum / b.cpuN) : null,
          memUsed: b.memUsedN ? Math.round(b.memUsedSum / b.memUsedN) : null,
        }
      })
      if (out.length > 500) out = out.slice(out.length - 500) // ≤500 点渲染（P2 验收 3）
      return { points: out, truncated: out.length >= 500 }
    },
  }
}

// ----------------------------------------------------------------------------
// §4 state-machine（实验生命周期：idle/running/done/crashed/alerting/aborted）
// ----------------------------------------------------------------------------
function createStateMachine(deps) {
  var state = {
    cur: null,           // 当前实验记录
    history: [],         // 已归档实验数组（倒序，最近在前）
    pidMissingStreak: 0, // ps 周期连续无候选进程计数（crashed 判定）
  }

  function cur() { return state.cur && state.cur.state === 'running' ? state.cur : null }

  function archive(run, endReason) {
    run.endTs = Date.now()
    run.endReason = endReason
    run.state = endReason === 'aborted' ? 'aborted' : (endReason === 'done' ? 'done' : 'crashed')
    run.summary = run.summary || buildSummary(run)
    state.history.unshift(run)
    if (state.history.length > 20) state.history.length = 20
    if (state.cur === run) state.cur = null
    state.pidMissingStreak = 0
  }

  function buildSummary(run) {
    var s = run.sampleStats
    return {
      gpuUtilMax: s && s.utilMax,
      gpuUtilAvg: s && s.utilN ? Math.round(s.utilSum / s.utilN) : null,
      memPeak: s && s.memPeakMiB,
      durationSec: Math.max(0, Math.round(((run.endTs || Date.now()) - run.startTs) / 1000)),
      dataPartial: deps.ring && deps.ring.size() >= 1 && ((run.endTs || Date.now()) - run.startTs) > RING_MAX_MS,
    }
  }

  // ① start：pre-execute 命中训练命令（只记 runId/cmd 特征/startTs，无 pid，T1-1）
  function start(cmdStr, feature) {
    var existing = cur()
    if (existing) archive(existing, 'aborted') // R-2：running 中新 start → 旧 run 归档 aborted
    var run = {
      runId: makeRunId(),
      cmd: cmdStr,
      cmdFeature: feature,
      pid: null,
      startTs: Date.now(),
      endTs: null,
      state: 'running',
      endReason: null,
      resultSeen: false,
      fingerprint: cmdFingerprint(cmdStr),
      graceTicks: 0,
      alerting: false,
      sampleStats: null,
    }
    state.cur = run
    state.pidMissingStreak = 0
    if (deps.ring) deps.ring.expand() // R-3：running 期扩容
    deps.emitLab('lab/experiment-start', { runId: run.runId, cmd: cmdStr, cmdFeature: feature, startTs: run.startTs })
    return run
  }

  // ② pid 关联（ps 回填；tools/execute 回传在 MVP 不开启，见 §7 注释）
  function associatePid(pid) {
    var run = cur()
    if (run && pid) { run.pid = pid; state.pidMissingStreak = 0 }
  }

  // ③ done / crashed（T1-2 配对 + 双确认；kill 自身 result 不配对 → 忽略）
  function markResult(paired) {
    var run = cur()
    if (!run) return
    if (!paired) return // 不匹配的 result 忽略（ls/curl/kill 等）
    run.resultSeen = true
    // v1.4.3（会话内验收实证）：去掉「pid 未关联即 done」的提前收尾——后台任务 result
    // 先于 ps 周期到达时 pid 尚未关联（5s tick 才回填），会误判 done（进程实际仍存活）；
    // done 必须经 ps tick 双确认（配对 result + 进程消失），由 tick/tickGrace 收尾。
    if (run.procGone) conclude(run, 'done')
    // 否则由 ps tick 的双确认路径/宽限路径收尾
  }

  function conclude(run, reason) {
    if (!run || run.state !== 'running') return
    if (reason === 'done') {
      archive(run, 'done')
    } else if (reason === 'crashed') {
      archive(run, 'crashed')
      deps.emitAlert({ level: 'critical', rule: 'experiment-crash', msg: '实验进程意外退出，无配对 result（可能被 kill 或崩溃）', confidence: 0.9, actions: ['检查日志/最近 kill 操作'] }, run.runId)
    }
  }

  // ps tick：候选进程存活检测 + crashed/done 双确认
  function tick(aliveProcs) {
    var run = cur()
    if (!run) { state.pidMissingStreak = 0; return }
    var alive = findAliveProc(run, aliveProcs)
    if (alive) {
      if (!run.pid) run.pid = alive.pid
      state.pidMissingStreak = 0
      run.procGone = false
      run.graceTicks = 0
      return
    }
    run.procGone = true
    if (run.resultSeen) {
      conclude(run, 'done') // done 双确认 2/2：配对 result + 进程消失
      return
    }
    state.pidMissingStreak += 1
    if (state.pidMissingStreak >= CRASH_PS_GAP) conclude(run, 'crashed') // pid 消失 ≥2 ps 周期
  }

  // 配对 result 后进程仍活 → 宽限 2 个 ps 周期后再判 done（异常残留）
  function tickGrace(run) {
    if (!run || run.state !== 'running' || !run.resultSeen) return
    run.graceTicks += 1
    if (run.graceTicks >= DONE_GRACE_TICKS) conclude(run, 'done')
  }

  // 平衡引擎 critical 置位（alerting 状态语义）
  function setAlerting(on) {
    var run = cur()
    if (run) run.alerting = on ? true : false
  }

  function snapshot() {
    var run = state.cur && state.cur.state === 'running' ? state.cur : null
    if (!run) return null
    return {
      runId: run.runId, state: run.alerting ? 'alerting' : 'running',
      cmd: run.cmd, cmdFeature: run.cmdFeature, pid: run.pid,
      startTs: run.startTs, summary: null, endReason: null,
    }
  }

  return { start: start, associatePid: associatePid, markResult: markResult, tick: tick, tickGrace: tickGrace, setAlerting: setAlerting, snapshot: snapshot, history: state.history, cur: cur }
}

function findAliveProc(run, procs) {
  if (!procs || !procs.length) return null
  var fp = run.fingerprint
  for (var i = 0; i < procs.length; i++) {
    var p = procs[i]
    if (run.pid && p.pid === run.pid) return p
    if (p.cmd && fp) {
      // v1.4.5（e2e 实证）：归一化对比（引号剥离/空白折叠）；pyc: 前缀仅标记形态，
      // ps 行无此前缀 → 匹配时剥离
      var c = normalizeCmdForMatch(p.cmd)
      var mfp = fp.indexOf('pyc:') === 0 ? fp.slice(4) : fp
      if (c.indexOf(mfp) !== -1) return p
    }
  }
  return null
}

// ps 输出解析（Linux/WSL 实验进程视角；与采样 procs 通道解耦）
function parsePs(out) {
  var procs = []
  if (!out || out.code !== 0 || !out.stdout) return procs
  var lines = out.stdout.split('\n')
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    var mm = line.match(/^(\d+)\s+(\S.*)$/)
    if (mm) procs.push({ pid: parseInt(mm[1], 10), cmd: mm[2] })
  }
  return procs
}

// ----------------------------------------------------------------------------
// §5 balancer（纯代码平衡引擎：4 类诊断 + 分级防抖）
// ----------------------------------------------------------------------------
function createBalancer(deps) {
  var alerts = []           // 最近告警（倒序，最新在前）
  var criticalCount = 0
  var hitByRule = {}        // rule -> 连续命中窗口数（阈值持续 10s = 5 个 2s 采样）
  var lastByRule = {}       // rule -> 最近一次发出时间（同类最小间隔 5 分钟）

  var RULES = [
    {
      rule: 'oom', level: 'critical',
      check: function (w, thr) {
        var g = w.gpu && w.gpu.length ? w.gpu[0] : null
        if (!g || !g.memTotalMiB) return false
        var usedPct = (g.memUsedMiB / g.memTotalMiB) * 100
        return usedPct >= thr.memWarn && g.utilPct >= thr.utilWarn
      },
      msg: '显存占用超阈值且利用率高，存在 OOM 风险',
      actions: ['降低 batch size', '关闭其他占用显存的进程'],
    },
    {
      rule: 'io-bottleneck', level: 'warn',
      check: function (w, thr) {
        var g = w.gpu && w.gpu.length ? w.gpu[0] : null
        return g && g.utilPct !== null && g.utilPct < 30 && w.cpuPct !== null && w.cpuPct >= 90
      },
      msg: 'GPU 利用率低但 CPU 满载，疑似数据加载瓶颈',
      actions: ['增加 num_workers', '检查数据管线磁盘 IO'],
    },
    {
      rule: 'thermal', level: 'warn',
      check: function (w, thr) {
        var g = w.gpu && w.gpu.length ? w.gpu[0] : null
        return g && typeof g.tempC === 'number' && g.tempC >= thr.tempWarn
      },
      msg: 'GPU 温度接近墙值，存在降频风险',
      actions: ['降低功耗目标', '检查散热/风扇'],
    },
    {
      rule: 'imbalance', level: 'info',
      check: function (w, thr) {
        if (!w.gpu || w.gpu.length < 2) return false
        var us = w.gpu.map(function (g) { return g.utilPct })
        var mx = Math.max.apply(null, us); var mn = Math.min.apply(null, us)
        return mx - mn >= 40
      },
      msg: '多 GPU 负载不均',
      actions: ['调整 batch/流水线分配', '检查 DDP 数据切分'],
    },
  ]

  var MIN_HITS = Math.max(1, Math.round(10000 / SAMPLE_MS)) // 10s for: 模式 → 5（2s 采样）
  var MIN_INTERVAL_MS = 5 * 60 * 1000

  function evaluate(windowSnaps, runId) {
    if (!windowSnaps || !windowSnaps.length) return
    var w = windowSnaps[windowSnaps.length - 1]
    var thr = deps.thresholds()
    var out = []
    for (var i = 0; i < RULES.length; i++) {
      var R = RULES[i]
      var ok = false
      try { ok = R.check(w, thr) } catch (e) {}
      if (ok) {
        hitByRule[R.rule] = (hitByRule[R.rule] || 0) + 1
      } else {
        hitByRule[R.rule] = 0
        continue
      }
      if (hitByRule[R.rule] < MIN_HITS) continue // 阈值需持续 10s
      var now = Date.now()
      if (lastByRule[R.rule] && now - lastByRule[R.rule] < MIN_INTERVAL_MS) continue // 5 分钟防重
      lastByRule[R.rule] = now
      hitByRule[R.rule] = 0
      var alert = {
        level: R.level, rule: R.rule, msg: R.msg,
        confidence: R.level === 'critical' ? 0.85 : 0.7,
        actions: R.actions, ts: now, runId: runId || null,
      }
      alerts.unshift(alert)
      if (alert.level === 'critical') criticalCount += 1
      if (alerts.length > ALERT_MAX) alerts.length = ALERT_MAX
      deps.emitLab('lab/alert', { level: alert.level, rule: alert.rule, msg: alert.msg, confidence: alert.confidence, actions: alert.actions })
      out.push(alert)
    }
    return out
  }

  function snapshotAlerts() { return alerts.slice(0, 10) }

  // 非规则告警入口（如实验 crashed）：写入告警流并计 critical
  function pushExternal(alert) {
    var a = {
      level: alert.level || 'warn',
      rule: alert.rule || 'external',
      msg: alert.msg || '',
      confidence: alert.confidence !== undefined && alert.confidence !== null ? alert.confidence : 0.9,
      actions: Array.isArray(alert.actions) ? alert.actions : [],
      ts: Date.now(),
      runId: alert.runId || null,
    }
    alerts.unshift(a)
    if (a.level === 'critical') criticalCount += 1
    if (alerts.length > ALERT_MAX) alerts.length = ALERT_MAX
    return a
  }

  function advice() {
    return { advice: alerts.slice(0, 5).map(function (a) { return { level: a.level, rule: a.rule, msg: a.msg, confidence: a.confidence, actions: a.actions } }), generatedAt: Date.now() }
  }

  return { evaluate: evaluate, snapshotAlerts: snapshotAlerts, advice: advice, count: function () { return criticalCount }, pushExternal: pushExternal }
}

// ----------------------------------------------------------------------------
// §6 阈值（host 内存事实来源；M3 last-write-wins）
// ----------------------------------------------------------------------------
function createThresholds() {
  var t = {}
  for (var k in THRESHOLD_DEFAULTS) t[k] = THRESHOLD_DEFAULTS[k]
  var appliedAt = 0
  return {
    get: function () { return { utilWarn: t.utilWarn, memWarn: t.memWarn, tempWarn: t.tempWarn, pollMs: t.pollMs } },
    effectiveTimestamp: function () { return appliedAt },
    apply: function (patch, isDirect) {
      if (!patch || typeof patch !== 'object') return false
      if (!isDirect && Date.now() < appliedAt) return false // 携带值晚于生效时间戳才覆盖（M3/R2）
      var keys = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs']
      var changed = false
      for (var n = 0; n < keys.length; n++) {
        var k = keys[n]
        if (typeof patch[k] === 'number' && isFinite(patch[k])) { t[k] = patch[k]; changed = true }
      }
      if (changed) appliedAt = Date.now()
      return changed
    },
  }
}

// ----------------------------------------------------------------------------
// §7 hooks（工具生命周期：pre-execute 开始 / result 配对结束）
// ----------------------------------------------------------------------------
function registerHooks(ctx, state, machine, balancer, enabled) {
  // ① pre-execute（waterfall，默认放行）——训练命令 → 实验开始
  ctx.on('tools/pre-execute', async function (exec, next) {
    try {
      if (enabled() && exec && (exec.name === 'bash' || exec.name === 'run_code')) {
        var args = exec.arguments
        var cmd = args ? (args.command !== undefined ? args.command : (exec.name === 'bash' ? null : args.code)) : null
        var feature = matchTrainFeature(cmd)
        if (feature) {
          var run = machine.start(cmd, feature)
          console.log('[lab-monitor] 实验开始命中:', feature, '| runId=', run.runId, '| cmd=', String(cmd).slice(0, 80))
        }
      }
    } catch (e) {
      console.error('[lab-monitor] pre-execute 处理错误:', e)
    }
    return await next()
  })
  // ② tools/result（emit）——配对校验后结束（T1-2：不匹配忽略，kill 不误判 done）
  ctx.on('tools/result', function (exec, result) {
    try {
      var run = machine.cur()
      if (!run) return
      var name = exec && exec.name
      var args = exec && exec.arguments
      var cmd = args ? (args.command !== undefined ? args.command : (name === 'bash' ? null : args.code)) : null
      // v1.4.5：配对校验剥离 pyc: 前缀 + 归一化（引号剥离），与 findAliveProc 一致
      var fp = run.fingerprint
      if (typeof fp === 'string' && fp.indexOf('pyc:') === 0) fp = fp.slice(4)
      var normCmd = typeof cmd === 'string' ? normalizeCmdForMatch(cmd) : null
      var paired = name === 'bash' && normCmd !== null && normCmd.indexOf(fp) !== -1
      if (paired) console.log('[lab-monitor] 配对 result 命中，实验结束判定进行中… runId=', run.runId)
      machine.markResult(paired)
    } catch (e) {
      console.error('[lab-monitor] result 处理错误:', e)
    }
  })
  // ③ 采样统计在 collector tick 内累积（见 §9 主流程），此处占位
}

// ----------------------------------------------------------------------------
// §8 prompt 注入（systemPrompt.variable + section，每模型步重新解析）
// ----------------------------------------------------------------------------
function makePromptProvider(snapshot) {
  return function () {
    try { return promptLine(snapshot()) } catch (e) { return '[Lab Monitor] 状态读取异常' }
  }
}

function promptLine(snap) {
  var g = snap.gpu && snap.gpu.length ? snap.gpu[0] : null
  var parts = []
  if (g && snap.gpuState !== 'unavailable') {
    var mem = g.memTotalMiB ? fmtGiBx(g.memUsedMiB) + '/' + fmtGiBx(g.memTotalMiB) + 'G' : ''
    parts.push('GPU' + g.id + ' ' + (g.utilPct !== null ? g.utilPct + '%' : '-') + (mem ? ' · ' + mem : ''))
  } else {
    parts.push('GPU 无')
  }
  if (snap.cpu && typeof snap.cpu.percent === 'number') parts.push('CPU ' + Math.round(snap.cpu.percent) + '%')
  if (snap.experiment) {
    var mins = Math.max(0, Math.round((Date.now() - snap.experiment.startTs) / 60000))
    parts.push('实验 ' + snap.experiment.runId + ' (' + snap.experiment.state + ' ' + mins + 'min)')
  }
  parts.push('告警: ' + (snap.alertsCriticalCount ? snap.alertsCriticalCount + '条' : '无'))
  return '[Lab Monitor] ' + parts.join(' · ')
}

function fmtGiBx(mib) {
  if (mib === null || mib === undefined || Number.isNaN(mib)) return '-'
  var g = mib / 1024
  return g >= 100 ? String(Math.round(g)) : String(Math.round(g * 10) / 10)
}

// ----------------------------------------------------------------------------
// §9 collector + 内部事件 + RPC + 工具
// ----------------------------------------------------------------------------

// 采样快照 → 轻量采样点（ring 元素）
function toSamplePoint(snap) {
  return {
    ts: snap.ts,
    gpu: snap.gpu || [],
    gpuState: snap.gpuState || (snap.gpu && snap.gpu.length ? 'ok' : 'unavailable'),
    cpuPct: snap.cpu ? snap.cpu.percent : null,
    cores: snap.cpu ? snap.cpu.cores : null,
    memUsedMiB: snap.mem ? (snap.mem.totalMiB - (snap.mem.availableMiB || 0)) : null,
    memTotalMiB: snap.mem ? snap.mem.totalMiB : null,
    procs: snap.procs || [],
    degraded: snap.degraded || null,
  }
}

function buildSnapshot(ctxRef2, backendState, machine, balancer, ring, thresholds, callCountOf, uiFlag) {
  var base = backendState.lastSnap || { ts: Date.now(), platform: 'linux', sources: {}, cpu: { percent: null, cores: null }, mem: { totalMiB: null, availableMiB: null }, procs: [] }
  var gpu = base.gpu || []
  var gpuState = gpu.length ? 'ok' : ((base.sources && base.sources.gpu === 'unavailable') ? 'unavailable' : (base.gpuState || 'ok'))
  var snap = {
    ts: Date.now(),
    platform: base.platform || 'linux',
    sources: {
      gpu: (base.sources && base.sources.gpu) || (gpu.length ? 'query' : 'unavailable'),
      cpu: (base.sources && base.sources.cpu) || 'procfs',
      mem: (base.sources && base.sources.mem) || 'procfs',
      procs: (base.sources && base.sources.procs) || 'ps',
    },
    gpu: gpu.map(function (g) { return g }),
    gpuState: gpuState,
    cpu: base.cpu ? { percent: base.cpu.percent, cores: base.cpu.cores !== undefined ? base.cpu.cores : null } : { percent: null, cores: null },
    mem: base.mem ? { totalMiB: base.mem.totalMiB, availableMiB: base.mem.availableMiB } : { totalMiB: null, availableMiB: null },
    procs: (base.procs || []).slice(0, 15),
    alerts: balancer.snapshotAlerts(),
    alertsCriticalCount: balancer.count(),
    experiment: machine.snapshot(),
    callCount: callCountOf(),
    ui: { betterSidebarVisible: uiFlag() },
  }
  if (base.degraded) snap.degraded = base.degraded
  return snap
}

// RPC 方法集合
function makeRpc(backendState, machine, balancer, ring, thresholds, enabled, uiFlag) {
  var callCount = 0
  return {
    snapshot: function (args) {
      callCount += 1
      var a = args || {}
      if (a.thresholds) thresholds.apply(a.thresholds, false) // 携带 = 建议更新（last-write-wins）
      return buildSnapshot(null, backendState, machine, balancer, ring, thresholds, function () { return callCount }, uiFlag)
    },
    history: function (args) {
      var a = args || {}
      var sinceMs = typeof a.sinceMs === 'number' ? a.sinceMs : Date.now() - 30 * 60 * 1000
      var bucketMs = typeof a.bucketMs === 'number' ? a.bucketMs : 10000
      return ring.history(sinceMs, bucketMs)
    },
    setThresholds: function (args) {
      var a = args || {}
      var applied = {}
      var keys = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs']
      for (var n = 0; n < keys.length; n++) {
        var k = keys[n]
        if (typeof a[k] === 'number' && isFinite(a[k])) applied[k] = a[k]
      }
      thresholds.apply(applied, true) // 直连 = 即时生效（M3）
      return { ok: true, applied: thresholds.get() }
    },
    control: function (args) {
      var a = args || {}
      var action = a.action
      if (action === 'start') enabled(true)
      else if (action === 'pause') enabled(false)
      else if (action === 'resume') enabled(true)
      else return { ok: false, error: '未知 action: ' + action }
      return { ok: true, state: enabled() ? 'running' : 'paused' }
    },
    advice: function () { return balancer.advice() },
  }
}

function renderText(args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

// Agent 工具注册（harness.defineTool + harness.registerTool）
function registerTools(rpc, snapshotProvider) {
  var toolStatus
  try {
    toolStatus = harness.defineTool({
      name: 'lab_status',
      description: '查询 Lab Monitor 实时资源快照（GPU/CPU/内存/进程/实验/告警）。返回完整 JSON 快照；brief:true 取一行摘要。',
      parameters: {
        brief: { type: 'boolean', description: '为 true 时只返回一行摘要字符串' },
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args) {
        var snap = snapshotProvider()
        if (args && args.brief === true) return promptLine(snap)
        return snap
      },
    })
    harness.registerTool(ctxRef, toolStatus)
  } catch (e) {
    console.error('[lab-monitor] lab_status 注册失败:', e)
  }
  try {
    var toolAdvice = harness.defineTool({
      name: 'lab_advice',
      description: '查询 Lab Monitor 平衡引擎当前建议（分级 + 置信度 + 可执行动作）。无告警时 advice 为空数组。',
      parameters: {},
      output: { schema: { type: 'json' }, render: renderText },
      async execute() { return rpc.advice() },
    })
    harness.registerTool(ctxRef, toolAdvice)
  } catch (e) {
    console.error('[lab-monitor] lab_advice 注册失败:', e)
  }
  try {
    var toolCtl = harness.defineTool({
      name: 'lab_ctl',
      description: '控制 Lab Monitor 监控/告警引擎（start/pause/resume/set-threshold）。护栏：只控制监控引擎，绝不触碰实验进程。',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'pause', 'resume', 'set-threshold'], description: '操作类型' },
        thresholds: { type: 'object', additionalProperties: true, properties: { utilWarn: { type: 'number', description: 'GPU 利用率告警阈值 %' }, memWarn: { type: 'number', description: '显存占用告警阈值 %' }, tempWarn: { type: 'number', description: '温度告警阈值 °C' }, pollMs: { type: 'number', description: 'UI 轮询周期 ms' } }, description: 'set-threshold 时的阈值' },
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args) {
        var a = args || {}
        if (a.action === 'set-threshold') return rpc.setThresholds(a.thresholds || {})
        return rpc.control({ action: a.action })
      },
    })
    harness.registerTool(ctxRef, toolCtl)
  } catch (e) {
    console.error('[lab-monitor] lab_ctl 注册失败:', e)
  }
}

// 设置探测：better-sidebar 可见性（aionui-panel 互斥，docs/05 §3.2）
function makeUiFlag(ctxRef2) {
  var visible = true
  function probe() {
    try {
      var settings = ctxRef2.get('settings')
      if (settings && typeof settings.get === 'function') {
        var ns = settings.get('aionui-panel')
        visible = !(ns && ns.rightPanel === 'aionui-panel')
      }
    } catch (e) { /* 服务不可用 → 默认可见 */ }
    return visible
  }
  probe()
  try {
    ctxRef2.on('settings/updated', function (ns) {
      if (ns === 'aionui-panel') probe()
    })
  } catch (e) { /* 无 settings 事件能力 → 静态值 */ }
  return function () { return visible }
}

// ----------------------------------------------------------------------------
// §10 插件对象（code.host 函数体返回值）
// ----------------------------------------------------------------------------
return {
  name: 'lab-monitor',
  // ★ 依赖声明纪律：只平台内建恒存在服务；settings 走 ctx.get 可选消费（V1 防御）
  inject: ['timer', 'shell', 'systemPrompt'],
  apply(ctx) {
    ctxRef = ctx
    // ── 状态容器（apply 内初始化，闭包共享）────────────────────────────────
    var enabled = (function () { var v = true; return function (set) { if (set !== undefined) v = !!set; return v } })()
    var backendState = { backend: null, platform: 'unknown', lastSnap: null, stopped: false, psAt: 0 }
    // 内部事件分发（沙箱无 ctx.emit，v2 升级为平台广播）
    var labListeners = []
    function emitLab(type, data) {
      var ev = { type: type, ts: Date.now(), runId: (data && data.runId) || null, data: data || {} }
      for (var i = 0; i < labListeners.length; i++) {
        try { labListeners[i](ev) } catch (e) { console.error('[lab-monitor] lab 事件监听错误:', e) }
      }
      console.log('[lab-monitor] ' + type, JSON.stringify(data || {})) // T2-4 自观测
    }
    function onLab(fn) { labListeners.push(fn); return function () { var i = labListeners.indexOf(fn); if (i >= 0) labListeners.splice(i, 1) } }

    var ring = createRing(RING_MAX_POINTS, RING_MAX_MS)
    var thresholds = createThresholds()
    var recentWindow = [] // 最近 10s 快照窗口（2s × 5）
    var balancer = createBalancer({
      thresholds: function () { return thresholds.get() },
      emitLab: emitLab,
    })
    var machine = createStateMachine({
      ring: ring,
      emitLab: emitLab,
      emitAlert: function (alert, runId) {
        // crashed 告警进入告警流（复用 balancer 计数语义）
        balancer.pushExternal({ runId: runId, level: alert.level, rule: alert.rule, msg: alert.msg, confidence: alert.confidence, actions: alert.actions })
        emitLab('lab/alert', { level: alert.level, rule: alert.rule, msg: alert.msg, confidence: alert.confidence, actions: alert.actions })
      },
    })

    // runner + 采样主流程
    var runner = makeRunner(ctx.shell)
    patchRunnerSleep(runner, ctx)

    // 采样 tick（2s 固定；ps 5s 周期）
    var tickBusy = false
    async function sampleTick() {
      if (tickBusy || !enabled() || !backendState.backend) return
      tickBusy = true
      try {
        var snap = await LAB.collectSnapshot(backendState.backend)
        if (!snap) return
        backendState.lastSnap = snap
        var pt = toSamplePoint(snap)
        ring.push(pt)
        recentWindow.push(pt)
        while (recentWindow.length > 5) recentWindow.shift() // ≤10s 窗口（2s × 5）
        var run = machine.cur()
        if (run) {
          var st = run.sampleStats || (run.sampleStats = { utilSum: 0, utilN: 0, utilMax: 0, memPeakMiB: 0 })
          var g0 = pt.gpu && pt.gpu.length ? pt.gpu[0] : null
          if (g0 && typeof g0.utilPct === 'number') { st.utilSum += g0.utilPct; st.utilN += 1; if (g0.utilPct > st.utilMax) st.utilMax = g0.utilPct }
          if (g0 && typeof g0.memUsedMiB === 'number' && g0.memUsedMiB > st.memPeakMiB) st.memPeakMiB = g0.memUsedMiB
        }
        // ps 周期（5s）→ 状态机 tick
        if (Date.now() - backendState.psAt >= PS_INTERVAL_MS) {
          backendState.psAt = Date.now()
          var psOut = await runner.exec('ps -eo pid=,args= --no-headers 2>/dev/null')
          var procs = parsePs(psOut)
          machine.tick(procs)
          if (machine.cur() && machine.cur().resultSeen) machine.tickGrace(machine.cur())
        }
        balancer.evaluate(recentWindow, run ? run.runId : null)
      } catch (e) {
        console.error('[lab-monitor] 采样 tick 错误:', e)
      } finally {
        tickBusy = false
      }
    }
    ctx.interval(sampleTick, SAMPLE_MS) // fiber 副作用，cordis_stop 自动清理

    // 后台初始化：探测 + 建后端 + dmon 流
    var streamTask = null
    async function startBackend() {
      try {
        var res = await LAB.createBackend(runner)
        backendState.backend = res.backend
        backendState.platform = res.platform
        var probe = await LAB.probeBackend(res.backend)
        console.log('[lab-monitor] 采样后端就绪 platform=', res.platform, 'probe=', JSON.stringify(probe && probe.detail ? probe.detail : probe))
        if (res.backend && typeof res.backend.stream === 'function') {
          streamTask = (async function () {
            var it = null
            try {
              var stream = res.backend.stream()
              it = stream[Symbol.asyncIterator]()
              while (!backendState.stopped) {
                var n = await it.next()
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
    ctx.effect(function () {
      return function () {
        backendState.stopped = true
        if (streamTask) { try { streamTask.return && streamTask.return() } catch (e) {} }
        if (backendState.backend) {
          try {
            backendState.backend.close().then(function () { console.log('[lab-monitor] 采样后端已关闭，无孤儿进程') }).catch(function (e) { console.error('[lab-monitor] close 出错:', e) })
          } catch (e) { console.error('[lab-monitor] close 出错:', e) }
        }
      }
    }, 'lab-monitor:collector-cleanup')

    // ── RPC（数据面）───────────────────────────────────────────────────────
    var uiFlag = makeUiFlag(ctx) // 单例：避免每次 makeUiFlag 重复注册 settings/updated 监听
    var rpc = makeRpc(backendState, machine, balancer, ring, thresholds, enabled, uiFlag)
    harness.handle('labMonitor.snapshot', function (args) { return rpc.snapshot(args) })
    harness.handle('labMonitor.history', function (args) { return rpc.history(args) })
    harness.handle('labMonitor.setThresholds', function (args) { return rpc.setThresholds(args) })
    harness.handle('labMonitor.control', function (args) { return rpc.control(args) })

    // ── Agent 工具（工具桥）────────────────────────────────────────────────
    function snapshotProvider() {
      return buildSnapshot(ctx, backendState, machine, balancer, ring, thresholds, function () { return 0 }, uiFlag)
    }
    registerTools(rpc, snapshotProvider)

    // ── prompt 注入（每模型步）─────────────────────────────────────────────
    try {
      var sp = ctx.get('systemPrompt')
      if (sp && typeof sp.variable === 'function') {
        // v1.4.4（会话内验收实证）：systemPrompt 变量名必须匹配 /^[a-z][a-z0-9_]*$/，
        // 'labStatus' 含大写 → variable() 抛错被 catch 吞掉 → section 从未注册（prompt 注入缺位）。
        // 统一小写：labStatus → labstatus。
        sp.variable('labstatus', makePromptProvider(snapshotProvider))
        sp.section({ name: 'lab-monitor:status', order: 150, text: '{{labstatus}}' })
        console.log('[lab-monitor] prompt 变量 labstatus 已注入')
      } else {
        console.warn('[lab-monitor] systemPrompt 服务不可用，跳过 prompt 注入')
      }
    } catch (e) {
      console.error('[lab-monitor] prompt 注册错误:', e)
    }

    // ── 生命周期 hooks ─────────────────────────────────────────────────────
    registerHooks(ctx, backendState, machine, balancer, enabled)

    console.log('[lab-monitor] 核心引擎已启动（采样 ' + SAMPLE_MS + 'ms / ps ' + PS_INTERVAL_MS + 'ms）')
  },
}
