// ============================================================================
// Lab Monitor Client 半（MVP 单文件）—— D-B1 + D-B2
// ============================================================================
// 职责：① 数据消费者（host.call 轮询 → 模块级 last 快照，出口共享）
//       ② conversation.view 默认出口（★P0 主 UI，零第三方依赖）
//       ③ better-sidebar 适配器（★最后增量 D-B2：双检查 + 重探 + visible 保活）
// 契约：lab-protocol/1.1（docs/03-protocol.md §2.1 labMonitor.snapshot）
// 纪律：
//   - T1-3：单文件、无 import/export、纯 JS 无 JSX（React.createElement）
//   - 依赖声明：只 inject:['timer']（平台内置恒存在）；better-sidebar 绝不进
//     inject（t2b 结论①：硬依赖会在服务缺席时使整个 client 半 waiting、默认
//     出口 ② 失效）——适配器内 ctx.get('betterSidebar') 判空可选消费（docs/05 §1）
//   - 形态：本文件即 cordis_define 的 code.client 函数体（顶层 return 插件对象；
//     符号面 React/host/console 由运行时注入）
//   - 禁用 window.setInterval（guard 遮蔽浏览器 timer 全局），一律 ctx.setInterval
//   - 不做：webServer 自托管面板（v2 前置）、slots 之外的其他平台耦合
// ============================================================================

const { useState, useEffect } = React

// ----------------------------------------------------------------------------
// ① 数据消费者（出口共享唯一取数通道）
// ----------------------------------------------------------------------------
var POLL_MS = 5000             // 默认 5s 节流（conversation.view 无 visible 语义 → 常驻 5s）
var KEEPALIVE_MS = 30000       // D-B2：better-sidebar visible=false → 30s 低频保活（badge 更新）
var BACKOFFS = [5000, 10000, 30000]   // T2-3：失败指数退避 5s→10s→30s 封顶
var THRESH_KEYS = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs']

var ctxRef = null               // apply 传入的 ctx（timer 服务等），组件内使用
var last = null                 // 模块级最近快照（label thunk / 组件只读源）
var lastFetchAt = 0             // 最近一次成功拉取时间
var backoffIdx = 0              // 退避档位索引（0=5s 1=10s 2=30s）
var lastOk = false              // 上次拉取是否成功
var carriedThresholds = null    // D-B2：better-sidebar pluginToggles 值（阈值同步面，M3）

/** 从 pluginPrefs 提取阈值子集（host last-write-wins，携带=建议更新）。 */
function extractThresholds(prefs) {
  var out = {}
  var has = false
  for (var i = 0; i < THRESH_KEYS.length; i++) {
    var k = THRESH_KEYS[i]
    var v = prefs && prefs[k]
    if (typeof v === 'number' && isFinite(v)) { out[k] = v; has = true }
  }
  return has ? out : null
}

/** 拉取一次快照：成功更新 last 并复位退避；失败升级退避、保留旧 last（T2-3）。永不抛出。 */
async function refresh() {
  try {
    var req = {}
    if (carriedThresholds) {
      var t = extractThresholds(carriedThresholds)
      if (t) req.thresholds = t
    }
    var snap = await host.call('labMonitor.snapshot', req)   // 阈值事实来源在 host（M3 last-write-wins）
    last = snap
    lastFetchAt = Date.now()
    lastOk = true
    backoffIdx = 0
    return snap
  } catch (e) {
    console.error('[lab-monitor] snapshot 拉取失败:', e && e.message ? e.message : e)
    lastOk = false
    if (backoffIdx < BACKOFFS.length - 1) backoffIdx += 1
    return { error: true, ts: Date.now() }
  }
}

/** 下一次轮询等待间隔：成功用 pollMs，失败用退避档位；hidden=true 用 30s 保活（D-B2）。 */
function nextWaitMs(hidden) {
  if (hidden) return KEEPALIVE_MS
  return lastOk ? POLL_MS : BACKOFFS[backoffIdx]
}

// ----------------------------------------------------------------------------
// 工具
// ----------------------------------------------------------------------------
var C = {
  label: 'var(--dsw-alias-label-primary, #0f1115)',
  label2: 'var(--dsw-alias-label-secondary, #555b66)',
  layer1: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  border: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
  success: 'var(--dsw-alias-state-success-primary, #16a34a)',
  error: 'var(--dsw-alias-state-error-primary, #dc2626)',
  warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
  brand: 'var(--dsw-alias-brand-primary, #3964fe)',
}

function fmtGiB(mib) {
  if (mib === null || mib === undefined || Number.isNaN(mib)) return '-'
  var g = mib / 1024
  return g >= 100 ? String(Math.round(g)) : String(Math.round(g * 10) / 10)
}

function fmtTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

function utilColor(pct) {
  if (pct === null || pct === undefined) return C.label2
  if (pct >= 80) return C.error      // 三档色条：<50 绿 / 50-80 黄 / >80 红
  if (pct >= 50) return C.warn
  return C.success
}

/** 一行摘要（label thunk 与面板状态行共用）。O(1) 读 last。 */
function summaryLine(s) {
  var g = s.gpu && s.gpu[0]
  var parts = []
  if (g && s.gpuState !== 'unavailable') {
    parts.push('GPU' + g.id + ' ' + g.utilPct + '%')
    if (g.memTotalMiB) parts.push(fmtGiB(g.memUsedMiB) + '/' + fmtGiB(g.memTotalMiB) + 'G')
  } else if (s.gpuState === 'unavailable') {
    parts.push('GPU 无')
  }
  if (s.cpu && typeof s.cpu.percent === 'number') parts.push('CPU ' + Math.round(s.cpu.percent) + '%')
  if (s.alertsCriticalCount) parts.push(s.alertsCriticalCount + '告警')
  return parts.length ? '监控 ' + parts.join(' ') : '监控'
}

// ----------------------------------------------------------------------------
// ② conversation.view 默认出口（★P0 主 UI）
// ----------------------------------------------------------------------------
var rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
var cardStyle = {
  flex: '1 1 180px', minWidth: 180, padding: '10px 12px', borderRadius: 8,
  border: '1px solid ' + C.border, background: C.layer1, fontSize: 12, color: C.label,
}
var thStyle = {
  textAlign: 'left', fontWeight: 600, padding: '4px 6px',
  borderBottom: '1px solid ' + C.border, whiteSpace: 'nowrap', fontSize: 12,
}
var tdStyle = {
  padding: '4px 6px', borderBottom: '1px solid rgba(0,0,0,0.06)',
  whiteSpace: 'nowrap', fontSize: 12,
}

function gpuCard(g) {
  var pct = g.utilPct
  var barStyle = {
    height: 6, borderRadius: 3, marginTop: 6, background: 'rgba(0,0,0,0.08)',
    overflow: 'hidden',
  }
  var fillStyle = {
    height: '100%', width: Math.max(0, Math.min(100, pct)) + '%',
    background: utilColor(pct), borderRadius: 3,
  }
  return React.createElement('div', { key: g.id, style: cardStyle },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6 } },
      React.createElement('span', { style: { fontWeight: 600 } },
        (g.name ? g.name + ' ' : '') + 'GPU' + g.id),
      React.createElement('span', { style: { color: utilColor(pct), fontWeight: 600 } }, pct + '%'),
    ),
    React.createElement('div', { style: barStyle }, React.createElement('div', { style: fillStyle })),
    React.createElement('div', { style: { marginTop: 6, color: C.label2, display: 'flex', gap: 8, flexWrap: 'wrap' } },
      React.createElement('span', null, '显存 ' + fmtGiB(g.memUsedMiB) + '/' + fmtGiB(g.memTotalMiB) + 'G'),
      typeof g.tempC === 'number' ? React.createElement('span', null, g.tempC + '°C') : null,
      typeof g.powerW === 'number' ? React.createElement('span', null, Math.round(g.powerW) + 'W') : null,
      g.degraded ? React.createElement('span', { style: { color: C.warn } }, '降级') : null,
    ),
  )
}

function cpuCard(s) {
  var pct = s && s.cpu ? s.cpu.percent : null
  return React.createElement('div', { key: 'cpu', style: cardStyle },
    React.createElement('div', { style: { fontWeight: 600 } }, 'CPU'),
    React.createElement('div', { style: { marginTop: 6, color: utilColor(pct), fontWeight: 600 } },
      pct === null ? '-' : Math.round(pct) + '%'),
    React.createElement('div', { style: { marginTop: 6, color: C.label2 } },
      s && s.cpu && s.cpu.cores ? '核数 ' + s.cpu.cores : ''),
  )
}

function memCard(s) {
  var mem = s && s.mem
  var pct = mem && mem.totalMiB ? (mem.totalMiB - mem.availableMiB) / mem.totalMiB * 100 : null
  return React.createElement('div', { key: 'mem', style: cardStyle },
    React.createElement('div', { style: { fontWeight: 600 } }, '内存'),
    React.createElement('div', { style: { marginTop: 6, color: utilColor(pct), fontWeight: 600 } },
      pct === null ? '-' : Math.round(pct) + '%'),
    React.createElement('div', { style: { marginTop: 6, color: C.label2 } },
      mem ? '可用 ' + fmtGiB(mem.availableMiB) + '/' + fmtGiB(mem.totalMiB) + 'G' : ''),
  )
}

function alertRow(a) {
  var color = a.level === 'critical' ? C.error : a.level === 'warn' ? C.warn : C.label2
  return React.createElement('div', { key: a.ts + '-' + a.rule, style: { padding: '4px 0', fontSize: 12 } },
    React.createElement('span', { style: { color: color, fontWeight: 600, marginRight: 6 } },
      (a.level || 'info').toUpperCase()),
    React.createElement('span', { style: { color: C.label } }, a.msg || a.rule || ''),
    a.confidence !== null && a.confidence !== undefined
      ? React.createElement('span', { style: { color: C.label2, marginLeft: 6 } }, '置信 ' + Math.round(a.confidence * 100) + '%')
      : null,
    Array.isArray(a.actions) && a.actions.length
      ? React.createElement('span', { style: { color: C.brand, marginLeft: 6 } }, '建议: ' + a.actions.join(' / '))
      : null,
  )
}

function procsTable(s) {
  var procs = (s && Array.isArray(s.procs) ? s.procs : []).slice(0, 10)
  if (!procs.length) return null
  return React.createElement('div', { key: 'procs', style: { marginTop: 10 } },
    React.createElement('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 4 } },
      'GPU 进程' + (s.sources && s.sources.procs ? '（' + s.sources.procs + '）' : '')),
    React.createElement('div', { style: { overflowX: 'auto' } },
      React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%' } },
        React.createElement('thead', null,
          React.createElement('tr', null,
            React.createElement('th', { style: thStyle }, 'PID'),
            React.createElement('th', { style: thStyle }, '命令'),
            React.createElement('th', { style: thStyle }, 'GPU'),
          ),
        ),
        React.createElement('tbody', null,
          procs.map(function (p) {
            return React.createElement('tr', { key: p.pid },
              React.createElement('td', { style: tdStyle }, String(p.pid)),
              React.createElement('td', { style: tdStyle, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }, p.cmd || ''),
              React.createElement('td', { style: tdStyle }, p.gpu !== undefined && p.gpu !== null ? String(p.gpu) : '-'),
            )
          }),
        ),
      ),
    ),
  )
}

/** P2 历史曲线：SVG 折线（GPU 利用率 %），O(最小) 点渲染，零第三方依赖。 */
function MiniTrend(props) {
  var points = props.points
  var W = 640, H = 56, PAD = 4
  var vals = points.map(function (pt) { return pt.gpuUtil }).filter(function (v) { return typeof v === 'number' && !Number.isNaN(v) })
  if (vals.length < 2) return React.createElement('div', { key: 'trend' })
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals)
  var span = (max - min) || 1
  var step = (W - PAD * 2) / Math.max(vals.length - 1, 1)
  var d = []
  for (var i = 0; i < vals.length; i++) {
    var x = Math.round(PAD + i * step)
    var y = Math.round(H - PAD - ((vals[i] - min) / span) * (H - PAD * 2))
    d.push((i ? 'L' : 'M') + x + ' ' + y)
  }
  var line = d.join(' ')
  return React.createElement('div', { key: 'trend', style: { fontSize: 11, color: C.label2, marginTop: 6 } },
    React.createElement('span', { style: { marginRight: 6, fontWeight: 600, color: C.label } }, 'GPU 利用率趋势'),
    React.createElement('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: 56, style: { display: 'block', maxWidth: 640, background: C.layer1, borderRadius: 6, border: '1px solid ' + C.border } },
      React.createElement('polyline', { points: line, fill: 'none', stroke: C.brand, strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round' }),
    ),
  )
}

/**
 * 面板组件（② 与 ③ 共用渲染）。
 * - 轮询仅存在于组件生命周期内：卸载即停（零渲染口径，P0 验收 2）；
 * - props.visible === false（better-sidebar tab 隐藏，D-B2）→ 30s 低频保活，badge 仍更新；
 * - props.store（better-sidebar store）→ 读取 pluginToggles 阈值并携带（M3 阈值同步面）。
 */
var HIST_SINCE_MS = 30 * 60 * 1000   // 曲线窗口（≥30 分钟，P2 验收 3）
var HIST_BUCKET_MS = 20000

function MonitorPanel(props) {
  var hidden = !!(props && props.visible === false)   // 显式 false = tab 隐藏 → 30s 保活；undefined/true = 5s
  var store = props && props.store
  var [snap, setSnap] = useState(last && !last.error ? last : null)
  var [hist, setHist] = useState(null)   // 历史曲线点（history RPC 降采样 ≤500 点）

  useEffect(function () {
    var alive = true
    var dispose = null
    var tick = async function () {
      // D-B2 阈值同步面：从 sidebar 读 pluginToggles（若面板激活中）
      if (store && store.getSnapshot) {
        try {
          var snapPrefs = store.getSnapshot().prefs
          carriedThresholds = (snapPrefs && snapPrefs.pluginSettings && snapPrefs.pluginSettings[SIDEBAR_TAB_ID]) || null
        } catch (e) { /* 读不到保持旧值 */ }
      }
      var s = await refresh()
      if (!alive) return
      setSnap(s && !s.error ? s : null)
      // P2 历史曲线：低频随轮询拉取（进程内 RPC 开销可忽略；失败静默保留旧曲线）
      try {
        var h = await host.call('labMonitor.history', { sinceMs: HIST_SINCE_MS, bucketMs: HIST_BUCKET_MS })
        if (alive && h && Array.isArray(h.points) && h.points.length) setHist(h.points)
      } catch (e) { /* 静默 */ }
      schedule()
    }
    var schedule = function () {
      if (!alive) return
      if (dispose) { dispose(); dispose = null }
      dispose = ctxRef.setInterval(tick, nextWaitMs(hidden))   // 常驻 5s / 隐藏 30s 保活（D-B2）
    }
    var didInit = false
    var init = function () {
      if (didInit) return
      didInit = true
      if (last && !last.error && Date.now() - lastFetchAt < (hidden ? KEEPALIVE_MS : POLL_MS)) {
        setSnap(last)
        schedule()
      } else {
        refresh().then(function (s) {
          if (!alive) return
          setSnap(s && !s.error ? s : null)
          schedule()
        })
      }
    }
    init()
    return function () { alive = false; if (dispose) dispose() }   // 卸载 → 清 interval = 零渲染轮询
  }, [hidden])

  var connecting = !snap
  var s = snap
  return React.createElement('div', {
    style: {
      display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
      fontSize: 13, color: C.label, minWidth: 320, boxSizing: 'border-box',
    },
  },
    // ── 状态行 ─────────────────────────────────────────────────────────────
    React.createElement('div', { style: rowStyle },
      React.createElement('span', {
        style: { width: 8, height: 8, borderRadius: 4, background: connecting ? C.error : C.success },
      }),
      React.createElement('span', { style: { fontWeight: 600 } },
        connecting ? '连接中断，重试中…' : summaryLine(s)),
      React.createElement('span', { style: { fontSize: 11, color: C.label2 } },
        lastFetchAt ? '更新于 ' + fmtTime(lastFetchAt) : ''),
      s && s.platform
        ? React.createElement('span', { style: { fontSize: 11, color: C.label2 } },
            '[' + s.platform + (s.sources && s.sources.gpu ? '·' + s.sources.gpu : '') + ']')
        : null,
    ),
    // ── 历史曲线（GPU 利用率，SVG 自绘零依赖）──────────────────────────────
    hist && hist.length > 1
      ? React.createElement(MiniTrend, { points: hist, key: 'trend' })
      : null,
    // ── 指标卡（GPU / CPU / 内存）───────────────────────────────────────────
    React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      s && Array.isArray(s.gpu) && s.gpu.length ? s.gpu.map(gpuCard) : null,
      cpuCard(s),
      memCard(s),
    ),
    // ── 实验状态 ────────────────────────────────────────────────────────────
    s && s.experiment
      ? React.createElement('div', { style: { fontSize: 12, color: C.label2 } },
          '实验 ' + (s.experiment.runId || '-') + ' [' + (s.experiment.state || '-') + ']' +
          (s.experiment.cmd ? ' · ' + s.experiment.cmd : '') +
          (s.experiment.pid ? ' · pid ' + s.experiment.pid : ''))
      : null,
    // ── 进程表 ──────────────────────────────────────────────────────────────
    procsTable(s),
    // ── 告警列表 ────────────────────────────────────────────────────────────
    s && Array.isArray(s.alerts) && s.alerts.length
      ? React.createElement('div', { style: { marginTop: 10 } },
          React.createElement('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 4 } }, '告警'),
          s.alerts.slice(0, 5).map(alertRow))
      : null,
  )
}

/** 出口 label thunk：O(1) 读 last，输出一行摘要；R-4 try/catch。 */
function labelThunk() {
  try {
    if (!last) return '监控'
    if (last.error) return '监控 · 重试中'
    return summaryLine(last)
  } catch (e) {
    console.error('[lab-monitor] label thunk 错误:', e)
    return '监控'
  }
}

// ----------------------------------------------------------------------------
// ③ better-sidebar 适配器（★最后增量 D-B2；docs/05 §3）
// ----------------------------------------------------------------------------
var SIDEBAR_TAB_ID = 'lab-monitor:gpu'

/** badge：CRITICAL 告警计数（=>99 封顶为 99），只读模块级 last；R-4 try/catch。 */
function sidebarBadge() {
  try {
    if (!last || last.error) return null
    var c = last.alertsCriticalCount || 0
    return c ? (c > 99 ? 99 : c) : null
  } catch (e) {
    console.error('[lab-monitor] badge thunk 错误:', e)
    return null
  }
}

/** ③ 注册（双检查通过后调用）：注册后注销 ②（互斥，③ 为增强替代）。 */
function registerSidebarAdapter(ctx, disposeViewRef) {
  var bs = null
  // 重探：ctx.get 是即时查询，apply 可能早于 better-sidebar 服务发布（M4）
  var attempts = 0
  var MAX_ATTEMPTS = 3
  var tryProbe = function () {
    try {
      var visible = !(last && last.ui && last.ui.betterSidebarVisible === false)   // 双检查 2/2
      if (!visible) {
        console.warn('[lab-monitor] better-sidebar 被禁用（ui.betterSidebarVisible=false），保持 conversation.view')
        return
      }
      if (bs === null) bs = ctx.get('betterSidebar')
      if (!bs) {
        attempts += 1
        if (attempts < MAX_ATTEMPTS && typeof ctx.setTimeout === 'function') ctx.setTimeout(tryProbe, 2000)
        return
      }
      // 服务在 + 可见 → 注册 ③（替代 ②）
      ctx.effect(function () {
        var dispose3 = null
        try {
          var desc = {
            id: SIDEBAR_TAB_ID,
            title: function () { return 'GPU 监控' },
            order: 90,
            single: true,
          }
          var features = bs.features || []
          if (features.indexOf('badge') !== -1) desc.badge = sidebarBadge
          if (features.indexOf('pluginSettings') !== -1) {
            desc.settings = {
              pluginToggles: [
                { key: 'utilWarn', title: 'GPU 利用率阈值', type: 'number', min: 0, max: 100, unit: '%' },
                { key: 'memWarn', title: '显存占用阈值', type: 'number', min: 0, max: 100, unit: '%' },
                { key: 'tempWarn', title: '温度阈值', type: 'number', min: 0, max: 120, unit: '°C' },
                { key: 'pollMs', title: '轮询周期', type: 'number', min: 1000, max: 60000, unit: 'ms' },
              ],
            }
          }
          desc.component = function (props) {
            return React.createElement(MonitorPanel, { visible: props.visible, store: props.store })
          }
          dispose3 = bs.registerTab(desc)
          // ③ 注册成功 → 注销 ②（互斥降级矩阵生效）
          var dv = typeof disposeViewRef === 'function' ? disposeViewRef() : null
          if (dv) { try { dv() } catch (e) { console.error('[lab-monitor] 注销 conversation.view 出口出错:', e) } }
          console.log('[lab-monitor] better-sidebar 出口③已注册，已切换到增强 Tab')
          return dispose3
        } catch (e) {
          console.error('[lab-monitor] better-sidebar registerTab 失败，保持 conversation.view:', e)
          return dispose3 || null
        }
      })
    } catch (e) {
      console.error('[lab-monitor] better-sidebar 探测错误:', e)
    }
  }
  tryProbe()
}

// ----------------------------------------------------------------------------
// 插件对象（cordis_define code.client 函数体返回值）
// ----------------------------------------------------------------------------
return {
  name: 'lab-monitor',
  // ★ 依赖声明纪律：只 timer（平台内置恒存在）；better-sidebar 绝不进 inject
  inject: ['timer'],
  apply(ctx) {
    ctxRef = ctx
    // ① 数据消费者：apply 顶部无条件执行——首帧拉取（失败静默，轮询退避由组件调度接管）
    refresh()
    // ② conversation.view 默认出口（★默认兜底；slots 是可选服务，ctx.get 判空）
    var disposeView = null
    var slots = ctx.get('slots')
    if (slots !== undefined) {
      try {
        ctx.effect(function () {
          disposeView = slots.register(
            { name: 'conversation.view', id: 'lab-monitor', order: 20, label: labelThunk },
            MonitorPanel,
          )
          return disposeView
        })
      } catch (e) {
        console.error('[lab-monitor] conversation.view 注册失败:', e)
      }
    } else {
      console.warn('[lab-monitor] slots 服务缺席，跳过 conversation.view 出口（Agent 通道① 兜底）')
    }
    // ③ better-sidebar 适配器（最后增量；双检查 + 重探，失败保持 ②）
    registerSidebarAdapter(ctx, function () { return disposeView })
  },
}
