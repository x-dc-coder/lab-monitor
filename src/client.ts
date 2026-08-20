/**
 * Lab Monitor Client 半（V2 TS 化）
 * 职责：① 数据消费者（fetch 轮询 → 模块级 last 快照，出口共享）
 *       ② conversation.view 默认出口（★P0 主 UI，零第三方依赖）
 *       ③ better-sidebar 适配器（双检查 + 重探 + visible 保活）
 * 契约：lab-protocol/1.1（docs/03-protocol.md）
 *
 * 与动态版（v1.4.5）的差异：
 *   1. host.call('labMonitor.*') RPC → fetch('/lab-monitor/api/*') HTTP（webServer 路由）
 *   2. React/JSX：仍用 React.createElement（client bundle 无 JSX transform）
 *   3. inject: ['timer']；slots/betterSidebar 可选消费（ctx.get 判空）
 */
import React from 'react'

// ----------------------------------------------------------------------------
// ① 数据消费者（出口共享唯一取数通道）
// ----------------------------------------------------------------------------

const POLL_MS = 5000 // 默认 5s 节流（conversation.view 无 visible 语义 → 常驻 5s）
const KEEPALIVE_MS = 30000 // D-B2：better-sidebar visible=false → 30s 低频保活（badge 更新）
const BACKOFFS = [5000, 10000, 30000] // T2-3：失败指数退避 5s→10s→30s 封顶
const THRESH_KEYS = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs']
const API_BASE = '/lab-monitor/api'

// 快照类型（客户端视角，与 host MonitorSnapshot 对齐）
interface GpuView {
  id: string
  name?: string
  utilPct: number
  memUsedMiB: number
  memTotalMiB: number
  tempC?: number
  powerW?: number
  degraded?: boolean
}
interface ProcView {
  pid: number
  cmd: string
  cpuPct?: number | null
  memMiB?: number | null
  gpu?: number | null
  gpuUtilPct?: number | null
}
interface AlertView {
  level: string
  rule: string
  msg: string
  confidence: number
  actions: string[]
  ts: number
  runId: string | null
}
interface SnapView {
  ts: number
  platform: string
  sources: { gpu?: string; cpu: string; mem: string; procs: string }
  gpu?: GpuView[]
  gpuState: string
  cpu: { percent: number | null; cores: number | null }
  mem: { totalMiB: number | null; availableMiB: number | null }
  procs: ProcView[]
  watchedPids?: number[]
  alerts: AlertView[]
  alertsCriticalCount: number
  experiment: { runId: string; state: string; cmd?: string | null; pid?: number | null } | null
  callCount: number
  ui: { betterSidebarVisible: boolean }
  error?: boolean
  degraded?: { gpu?: string; reason?: string }
}
interface HistPoint {
  ts: number
  gpuUtil: number | null
  gpuMem: number | null
  cpu: number | null
  memUsed: number | null
}

type CtxLike = {
  get(name: string): unknown
  effect(fn: () => unknown, label?: string): void
  setTimeout(fn: () => void, ms: number): () => void
  setInterval(fn: () => void, ms: number): () => void
}

let ctxRef: CtxLike | null = null // apply 传入的 ctx（timer 服务等），组件内使用
let last: SnapView | null = null // 模块级最近快照（label thunk / 组件只读源）
let lastFetchAt = 0 // 最近一次成功拉取时间
let backoffIdx = 0 // 退避档位索引（0=5s 1=10s 2=30s）
let lastOk = false // 上次拉取是否成功
let carriedThresholds: Record<string, unknown> | null = null // D-B2：better-sidebar pluginToggles 值（阈值同步面，M3）

/** 从 pluginPrefs 提取阈值子集（host last-write-wins，携带=建议更新）。 */
function extractThresholds(prefs: Record<string, unknown> | null | undefined): Record<string, number> | null {
  const out: Record<string, number> = {}
  let has = false
  for (let i = 0; i < THRESH_KEYS.length; i++) {
    const k = THRESH_KEYS[i]
    const v = prefs && (prefs as Record<string, unknown>)[k]
    if (typeof v === 'number' && isFinite(v)) {
      out[k] = v
      has = true
    }
  }
  return has ? out : null
}

/** HTTP 调用 host API（替代动态版 host.call）。永不抛出。 */
async function apiCall<T>(method: string, body?: Record<string, unknown>): Promise<T | { error: true; ts: number }> {
  try {
    const res = await fetch(API_BASE + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return (await res.json()) as T
  } catch (e) {
    console.error('[lab-monitor] ' + method + ' 调用失败:', e && (e as Error).message ? (e as Error).message : e)
    return { error: true, ts: Date.now() }
  }
}

/** 拉取一次快照：成功更新 last 并复位退避；失败升级退避、保留旧 last（T2-3）。永不抛出。 */
async function refresh(): Promise<SnapView | { error: true; ts: number }> {
  const req: Record<string, unknown> = {}
  if (carriedThresholds) {
    const t = extractThresholds(carriedThresholds)
    if (t) req.thresholds = t
  }
  const snap = await apiCall<SnapView>('snapshot', req) // 阈值事实来源在 host（M3 last-write-wins）
  if (snap && !(snap as { error?: boolean }).error) {
    last = snap as SnapView
    lastFetchAt = Date.now()
    lastOk = true
    backoffIdx = 0
  } else {
    lastOk = false
    if (backoffIdx < BACKOFFS.length - 1) backoffIdx += 1
  }
  return snap
}

/** 下一次轮询等待间隔：成功用 pollMs，失败用退避档位；hidden=true 用 30s 保活（D-B2）。 */
function nextWaitMs(hidden: boolean): number {
  if (hidden) return KEEPALIVE_MS
  return lastOk ? POLL_MS : BACKOFFS[backoffIdx]
}

/** 拉取历史曲线（P2；失败静默保留旧值）。 */
async function fetchHistory(): Promise<HistPoint[] | null> {
  const h = await apiCall<{ points: HistPoint[] }>('history', { sinceMs: HIST_SINCE_MS, bucketMs: HIST_BUCKET_MS })
  if (h && !(h as { error?: boolean }).error && Array.isArray((h as { points: HistPoint[] }).points)) {
    return (h as { points: HistPoint[] }).points
  }
  return null
}

// ----------------------------------------------------------------------------
// 工具
// ----------------------------------------------------------------------------

const C = {
  label: 'var(--dsw-alias-label-primary, #0f1115)',
  label2: 'var(--dsw-alias-label-secondary, #555b66)',
  layer1: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  border: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
  success: 'var(--dsw-alias-state-success-primary, #16a34a)',
  error: 'var(--dsw-alias-state-error-primary, #dc2626)',
  warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
  brand: 'var(--dsw-alias-brand-primary, #3964fe)',
}

function fmtGiB(mib: number | null | undefined): string {
  if (mib === null || mib === undefined || Number.isNaN(mib)) return '-'
  const g = mib / 1024
  if (g < 0.1) return '<0.1' // 2026-08-20：小内存进程不再显示 0G（18-known-issues 反馈，截图 0G 误读）
  return g >= 100 ? String(Math.round(g)) : String(Math.round(g * 10) / 10)
}

function fmtTime(ts: number): string {
  try {
    const d = new Date(ts)
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2)
  } catch (e) {
    return ''
  }
}

function utilColor(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return C.label2
  if (pct >= 80) return C.error // 三档色条：<50 绿 / 50-80 黄 / >80 红
  if (pct >= 50) return C.warn
  return C.success
}

/** 一行摘要（label thunk 与面板状态行共用）。O(1) 读 last。 */
function summaryLine(s: SnapView): string {
  const g = s.gpu && s.gpu[0]
  const parts: string[] = []
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

const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const cardStyle: React.CSSProperties = {
  flex: '1 1 180px', minWidth: 180, padding: '10px 12px', borderRadius: 8,
  border: '1px solid ' + C.border, background: C.layer1, fontSize: 12, color: C.label,
}
const thStyle: React.CSSProperties = {
  textAlign: 'left', fontWeight: 600, padding: '4px 6px',
  borderBottom: '1px solid ' + C.border, whiteSpace: 'nowrap', fontSize: 12,
}
const tdStyle: React.CSSProperties = {
  padding: '4px 6px', borderBottom: '1px solid rgba(0,0,0,0.06)',
  whiteSpace: 'nowrap', fontSize: 12,
}

function gpuCard(g: GpuView) {
  const pct = g.utilPct
  const barStyle: React.CSSProperties = {
    height: 6, borderRadius: 3, marginTop: 6, background: 'rgba(0,0,0,0.08)',
    overflow: 'hidden',
  }
  const fillStyle: React.CSSProperties = {
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

function cpuCard(s: SnapView | null) {
  const pct = s && s.cpu ? s.cpu.percent : null
  return React.createElement('div', { key: 'cpu', style: cardStyle },
    React.createElement('div', { style: { fontWeight: 600 } }, 'CPU'),
    React.createElement('div', { style: { marginTop: 6, color: utilColor(pct), fontWeight: 600 } },
      pct === null ? '-' : Math.round(pct) + '%'),
    React.createElement('div', { style: { marginTop: 6, color: C.label2 } },
      s && s.cpu && s.cpu.cores ? '核数 ' + s.cpu.cores : ''),
  )
}

function memCard(s: SnapView | null) {
  const mem = s && s.mem
  const pct = mem && mem.totalMiB ? ((mem.totalMiB - (mem.availableMiB ?? 0)) / mem.totalMiB) * 100 : null
  return React.createElement('div', { key: 'mem', style: cardStyle },
    React.createElement('div', { style: { fontWeight: 600 } }, '内存'),
    React.createElement('div', { style: { marginTop: 6, color: utilColor(pct), fontWeight: 600 } },
      pct === null ? '-' : Math.round(pct) + '%'),
    React.createElement('div', { style: { marginTop: 6, color: C.label2 } },
      mem && mem.totalMiB ? fmtGiB(mem.totalMiB - (mem.availableMiB ?? 0)) + '/' + fmtGiB(mem.totalMiB) + 'G' : ''),
  )
}

// 常见默认进程聚合组（2026-08-20：避免列表被系统进程刷屏；折叠展示 + 统计行）
const DEFAULT_PROC_GROUPS: { key: string; label: string; match: (cmd: string) => boolean }[] = [
  { key: 'browser', label: '浏览器', match: (c) => /chrome|msedge|firefox|WeChatAppEx/i.test(c) },
  { key: 'ide', label: '编辑器/终端', match: (c) => /Code\.exe|WindowsTerminal|ShellHost|coodesker|explorer/i.test(c) },
  { key: 'docker', label: 'Docker/WSL', match: (c) => /Docker|docker|wsl/i.test(c) },
  { key: 'system', label: '系统进程', match: (c) => /System|Registry|smss|csrss|wininit|services|lsass|dwm|SearchHost|StartMenu|LockApp|TextInputHost|ApplicationFrame/i.test(c) },
  { key: 'other-app', label: '其他应用', match: (c) => /Weixin|QQ|ToDesk|TaiShanNet|llama-server/i.test(c) },
]

/** GPU 利用率取值：优先 gpuUtilPct（backend 填充），回退 v1.1 遗留 gpu 字段 */
function procGpu(p: ProcView): number | null {
  if (p.gpuUtilPct !== undefined && p.gpuUtilPct !== null && !Number.isNaN(p.gpuUtilPct)) return p.gpuUtilPct
  if (p.gpu !== undefined && p.gpu !== null && !Number.isNaN(p.gpu)) return p.gpu
  return null
}

/**
 * 进程表组件（2026-08-20 增强）：
 * - watched 置顶高亮（watchProcs 命中）
 * - 默认进程聚合组折叠展示，标题行可点击展开/收起成员（18-known-issues 问题 2b 落地）
 */
function ProcsTable(props: { snap: SnapView | null }) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})
  const s = props.snap
  const procs = (s && Array.isArray(s.procs) ? s.procs : []).slice(0, 15)
  if (!procs.length || !s) return null
  const watched = new Set<number>(Array.isArray(s.watchedPids) ? s.watchedPids : [])
  const watchedRows = procs.filter((p) => watched.has(p.pid))
  const rest = procs.filter((p) => !watched.has(p.pid))
  // 聚合组（标题行 + 组内成员；展开后渲染全部成员行）
  const groupRows: { key: string; label: string; members: ProcView[] }[] = []
  for (const g of DEFAULT_PROC_GROUPS) {
    const members = rest.filter((p) => g.match(p.cmd || ''))
    if (!members.length) continue
    groupRows.push({ key: g.key, label: g.label, members })
    for (const m of members) rest.splice(rest.indexOf(m), 1)
  }
  const otherRows = rest

  const row = (p: ProcView, extraStyle?: Record<string, string>) =>
    React.createElement('tr', { key: 'p' + p.pid, style: extraStyle },
      React.createElement('td', { style: tdStyle }, String(p.pid)),
      React.createElement('td', { style: { ...tdStyle, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' } }, p.cmd || ''),
      React.createElement('td', { style: tdStyle }, procGpu(p) !== null ? String(Math.round(procGpu(p) as number)) : '-'),
      React.createElement('td', { style: tdStyle }, p.cpuPct !== undefined && p.cpuPct !== null ? String(Math.round(p.cpuPct)) : '-'),
      React.createElement('td', { style: tdStyle }, p.memMiB !== undefined && p.memMiB !== null ? fmtGiB(p.memMiB) + 'G' : '-'),
    )
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = { ...prev }
      if (next[key]) delete next[key]
      else next[key] = true
      return next
    })
  const tbodyRows: unknown[] = []
  // watched 置顶（独立高亮行）
  for (const p of watchedRows) tbodyRows.push(row(p, { background: 'rgba(57,100,254,0.06)' }))
  // 聚合组：标题行（点击展开/收起）+ 展开时全部成员行
  for (const g of groupRows) {
    const open = !!expanded[g.key]
    tbodyRows.push(React.createElement('tr', {
      key: 'grp-' + g.label,
      onClick: () => toggle(g.key),
      style: { cursor: 'pointer' },
    },
      React.createElement('td', { colSpan: 5, style: { ...tdStyle, color: C.label2, fontSize: 11 } },
        (open ? '▼ ' : '▸ ') + g.label + '（' + g.members.length + '）' +
        (open ? '' : ' ' + g.members.slice(0, 3).map((m) => m.cmd || '').join(' / '))),
    ))
    if (open) {
      for (const m of g.members) tbodyRows.push(row(m, { background: 'rgba(0,0,0,0.02)' }))
    }
  }
  // 其余普通进程（非默认组）：加「其他进程」标题行分隔，避免与上方聚合组混淆
  // （2026-08-20 截图核验：O+Connect 紧贴「其他应用」组被误读为组内第 4 项）
  if (otherRows.length) {
    tbodyRows.push(React.createElement('tr', { key: 'grp-other' },
      React.createElement('td', { colSpan: 5, style: { ...tdStyle, color: C.label2, fontSize: 11, borderTop: '1px solid ' + C.border, paddingTop: 6, marginTop: 6 } },
        '其他进程（' + otherRows.length + '）'),
    ))
    for (const p of otherRows) tbodyRows.push(row(p, { background: 'rgba(0,0,0,0.02)' }))
  }
  return React.createElement('div', { key: 'procs', style: { marginTop: 10 } },
    React.createElement('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 4 } },
      '进程' + (s && s.sources && s.sources.procs ? '（' + s.sources.procs + '）' : '') +
      (watchedRows.length ? ' · 监控 ' + watchedRows.length : '')),
    React.createElement('div', { style: { overflowX: 'auto' } },
      React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%' } },
        React.createElement('thead', null,
          React.createElement('tr', null,
            React.createElement('th', { style: thStyle }, 'PID'),
            React.createElement('th', { style: thStyle }, '命令'),
            React.createElement('th', { style: thStyle }, 'GPU%'),
            React.createElement('th', { style: thStyle }, 'CPU%'),
            React.createElement('th', { style: thStyle }, '内存'),
          ),
        ),
        React.createElement('tbody', null, ...(tbodyRows as React.ReactElement[])),
      ),
    ),
  )
}

/**
 * 告警列表组件（2026-08-20 增强，18-known-issues 问题 3 落地）：
 * - 同 rule 合并计数（host 对同类告警按周期重复入列 → 显示 ×N 去冗余）
 * - 超长 msg 截断 120 字 + ellipsis（完整文本 title 提示）
 * - 默认显示前 2 条 + 「还有 N 条」点击展开
 */
function AlertList(props: { alerts: AlertView[] }) {
  const [showAll, setShowAll] = React.useState(false)
  const alerts = props.alerts
  if (!alerts.length) return null
  const merged: { level: string; rule: string; msg: string; confidence: number; actions: string[]; ts: number; count: number }[] = []
  const byRule: Record<string, number> = {}
  for (const a of alerts) {
    const idx = byRule[a.rule]
    if (idx !== undefined) {
      merged[idx].count += 1
      continue
    }
    byRule[a.rule] = merged.length
    merged.push({ level: a.level, rule: a.rule, msg: a.msg, confidence: a.confidence, actions: a.actions, ts: a.ts, count: 1 })
  }
  const visible = showAll ? merged : merged.slice(0, 2)
  const clip = (m: string) => (m.length > 120 ? m.slice(0, 120) + '…' : m)
  const items = visible.map((a) => {
    const color = a.level === 'critical' ? C.error : a.level === 'warn' ? C.warn : C.label2
    const full = clip(a.msg || a.rule || '')
    return React.createElement('div', { key: a.rule + '-' + a.ts, style: { padding: '4px 0', fontSize: 12 } },
      React.createElement('span', { style: { color, fontWeight: 600, marginRight: 6 } }, (a.level || 'info').toUpperCase()),
      React.createElement('span', { style: { color: C.label, wordBreak: 'break-all' }, title: (a.msg || a.rule || '').length > 120 ? a.msg : undefined }, full),
      a.count > 1 ? React.createElement('span', { style: { color: C.label2, marginLeft: 6 } }, '×' + a.count) : null,
      a.confidence !== null && a.confidence !== undefined
        ? React.createElement('span', { style: { color: C.label2, marginLeft: 6 } }, '置信 ' + Math.round(a.confidence * 100) + '%')
        : null,
      Array.isArray(a.actions) && a.actions.length
        ? React.createElement('span', { style: { color: C.brand, marginLeft: 6 } }, '建议: ' + a.actions.join(' / '))
        : null,
    )
  })
  const rest = merged.length - visible.length
  return React.createElement('div', { key: 'alerts', style: { marginTop: 10 } },
    React.createElement('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 4 } }, '告警'),
    ...items,
    rest > 0
      ? React.createElement('div', {
          key: 'alerts-more',
          onClick: () => setShowAll(true),
          style: { fontSize: 11, color: C.brand, cursor: 'pointer', padding: '4px 0' },
        }, '还有 ' + rest + ' 条（点击展开全部）')
      : null,
  )
}

/** P2 历史曲线：SVG 折线（GPU 利用率 %），O(最小) 点渲染，零第三方依赖。
 * 2026-08-20（2nd）：Y 轴动态区间 + 最小跨度 10——GPU 空闲（全 0%）时折线不再贴底不可见；
 * 折线加粗 2px + 浅色基线 + 量程标注。 */
function MiniTrend(props: { points: HistPoint[] }) {
  const points = props.points
  const W = 640, H = 56, PAD = 4
  const vals = points.map((pt) => pt.gpuUtil).filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))
  // 2026-08-20 修复：数据不足时渲染明确占位文案（此前返回空 div = 视觉"空白"，无任何反馈）
  if (vals.length < 2) {
    return React.createElement('div', { key: 'trend', style: { fontSize: 11, color: C.label2, marginTop: 6 } },
      React.createElement('span', { style: { marginRight: 6, fontWeight: 600, color: C.label } }, 'GPU 利用率趋势'),
      React.createElement('div', { style: { padding: '12px 0', fontSize: 11, color: C.label2 } }, '数据积累中…（采样 2 点后出图）'),
    )
  }
  // Y 轴动态区间：下界取整到 5 的倍数（≥0），上界 = max+5；最小跨度 10（GPU 空闲 0% 可见）
  const rawMin = Math.min(...vals)
  const rawMax = Math.max(...vals)
  const yMin = Math.max(0, Math.floor(rawMin / 5) * 5)
  const yMax = Math.max(yMin + 10, Math.ceil((rawMax + 5) / 5) * 5)
  const span = (yMax - yMin) || 1
  const step = (W - PAD * 2) / Math.max(vals.length - 1, 1)
  const d: string[] = []
  for (let i = 0; i < vals.length; i++) {
    const x = Math.round(PAD + i * step)
    const y = Math.round(H - PAD - ((vals[i] - yMin) / span) * (H - PAD * 2))
    d.push((i ? 'L' : 'M') + x + ' ' + y)
  }
  const line = d.join(' ')
  const baseY = H - PAD // yMin 基线
  return React.createElement('div', { key: 'trend', style: { fontSize: 11, color: C.label2, marginTop: 6 } },
    React.createElement('span', { style: { marginRight: 6, fontWeight: 600, color: C.label } }, 'GPU 利用率趋势'),
    React.createElement('span', { style: { fontSize: 10 } }, yMin + '%–' + yMax + '%'),
    React.createElement('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: 56, style: { display: 'block', maxWidth: 640, minHeight: 56, background: C.layer1, borderRadius: 6, border: '1px solid ' + C.border } },
      React.createElement('line', { x1: PAD, y1: baseY, x2: W - PAD, y2: baseY, stroke: 'rgba(128,128,128,0.25)', strokeWidth: 1 }),
      // 2026-08-20：stroke 硬编码 #3964fe（C.brand 的 CSS 变量 fallback）——部分主题下
      // var(--dsw-alias-brand-primary) 解析异常导致折线透明不可见（18-known-issues 问题 1）
      React.createElement('polyline', { points: line, fill: 'none', stroke: '#3964fe', strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }),
    ),
  )
}

const HIST_SINCE_MS = 30 * 60 * 1000 // 曲线窗口（≥30 分钟，P2 验收 3）
const HIST_BUCKET_MS = 20000

/**
 * 面板组件（② 与 ③ 共用渲染）。
 * - 轮询仅存在于组件生命周期内：卸载即停（零渲染口径，P0 验收 2）；
 * - props.visible === false（better-sidebar tab 隐藏，D-B2）→ 30s 低频保活，badge 仍更新；
 * - props.store（better-sidebar store）→ 读取 pluginToggles 阈值并携带（M3 阈值同步面）。
 */
function MonitorPanel(props: { visible?: boolean; store?: unknown }) {
  const hidden = props && props.visible === false // 显式 false = tab 隐藏 → 30s 保活；undefined/true = 5s
  const store = props && props.store
  const [snap, setSnap] = React.useState<SnapView | null>(last && !(last as { error?: boolean }).error ? last : null)
  const [hist, setHist] = React.useState<HistPoint[] | null>(null) // 历史曲线点（history API 降采样 ≤500 点）

  React.useEffect(() => {
    let alive = true
    let dispose: (() => void) | null = null
    const tick = async () => {
      // D-B2 阈值同步面：从 sidebar 读 pluginToggles（若面板激活中）
      if (store && (store as { getSnapshot?: () => { prefs?: { pluginSettings?: Record<string, unknown> } } }).getSnapshot) {
        try {
          const snapPrefs = (store as { getSnapshot: () => { prefs?: { pluginSettings?: Record<string, unknown> } } }).getSnapshot().prefs
          const v = snapPrefs && snapPrefs.pluginSettings && snapPrefs.pluginSettings[SIDEBAR_TAB_ID]
          carriedThresholds = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
        } catch (e) {
          /* 读不到保持旧值 */
        }
      }
      // 2026-08-20（18 问题 4）：快照与历史**同 tick 并行拉取**（此前先 refresh 再 fetchHistory
      // 串行 → 两处数据时刻不同步，展示数字滞后最多一个轮询周期）
      const [s, h] = await Promise.all([refresh(), fetchHistory()])
      if (!alive) return
      setSnap(s && !(s as { error?: boolean }).error ? (s as SnapView) : null)
      if (alive && h && h.length) setHist(h)
      schedule()
    }
    const schedule = () => {
      if (!alive) return
      if (dispose) {
        dispose()
        dispose = null
      }
      dispose = ctxRef ? ctxRef.setInterval(tick, nextWaitMs(!!hidden)) : null // 常驻 5s / 隐藏 30s 保活（D-B2）
    }
    let didInit = false
    const init = () => {
      if (didInit) return
      didInit = true
      // 首帧并行拉取：快照（缓存优先）+ 历史曲线（2026-08-20 修复：此前首帧不拉历史，
      // 面板刚打开时 hist=null → 趋势卡片不渲染，直到第一个 tick（5s）后才出现）
      if (last && !(last as { error?: boolean }).error && Date.now() - lastFetchAt < (hidden ? KEEPALIVE_MS : POLL_MS)) {
        setSnap(last)
      } else {
        refresh().then((s) => {
          if (!alive) return
          setSnap(s && !(s as { error?: boolean }).error ? (s as SnapView) : null)
        })
      }
      fetchHistory().then((h) => {
        if (alive && h && h.length) setHist(h)
      }).catch(() => { /* 静默：首帧历史失败不阻塞面板 */ })
      schedule()
    }
    init()
    return () => {
      alive = false
      if (dispose) dispose()
    } // 卸载 → 清 interval = 零渲染轮询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, store])

  const connecting = !snap
  const s = snap
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
        connecting ? '连接中断，重试中…' : summaryLine(s as SnapView)),
      React.createElement('span', { style: { fontSize: 11, color: C.label2 }, title: '数据由 host 采样生成（快照时刻）' },
        s && s.ts ? '数据 ' + fmtTime(s.ts) : (lastFetchAt ? '更新于 ' + fmtTime(lastFetchAt) : '')),
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
    React.createElement(ProcsTable, { snap: s, key: 'procs' }),
    // ── 告警列表（同 rule 合并计数 + 截断 + 可展开）──────────────────────────
    s && Array.isArray(s.alerts) && s.alerts.length
      ? React.createElement(AlertList, { alerts: s.alerts, key: 'alerts' })
      : null,
  )
}

/** 出口 label thunk：O(1) 读 last，输出一行摘要；R-4 try/catch。 */
function labelThunk(): string {
  try {
    if (!last) return '监控'
    if ((last as { error?: boolean }).error) return '监控 · 重试中'
    return summaryLine(last)
  } catch (e) {
    console.error('[lab-monitor] label thunk 错误:', e)
    return '监控'
  }
}

// ----------------------------------------------------------------------------
// ③ better-sidebar 适配器（★最后增量 D-B2；docs/05 §3）
// ----------------------------------------------------------------------------

const SIDEBAR_TAB_ID = 'lab-monitor:gpu'

/** badge：CRITICAL 告警计数（=>99 封顶为 99），只读模块级 last；R-4 try/catch。 */
function sidebarBadge(): number | null {
  try {
    if (!last || (last as { error?: boolean }).error) return null
    const c = last.alertsCriticalCount || 0
    return c ? (c > 99 ? 99 : c) : null
  } catch (e) {
    console.error('[lab-monitor] badge thunk 错误:', e)
    return null
  }
}

/** ③ 注册（双检查通过后调用）：注册后注销 ②（互斥，③ 为增强替代）。 */
function registerSidebarAdapter(ctx: CtxLike, disposeViewRef: () => (() => void) | null) {
  let bs: unknown = null
  // 重探：ctx.get 是即时查询，apply 可能早于 better-sidebar 服务发布（M4）
  // 1.2 修复（t1 诊断）：better-sidebar 是大 bundle，apply 可能 >6s；3 次重探不足 → 10 次（20s 窗口）
  let attempts = 0
  const MAX_ATTEMPTS = 10
  const tryProbe = () => {
    try {
      const visible = !(last && last.ui && last.ui.betterSidebarVisible === false) // 双检查 2/2
      if (!visible) {
        console.warn('[lab-monitor] better-sidebar 被禁用（ui.betterSidebarVisible=false），保持 conversation.view')
        return
      }
      if (bs === null) bs = ctx.get('betterSidebar')
      if (!bs) {
        attempts += 1
        if (attempts < MAX_ATTEMPTS) ctx.setTimeout(tryProbe, 2000)
        else console.warn(`[lab-monitor] ${MAX_ATTEMPTS} 次重探（${MAX_ATTEMPTS * 2}s）未获 betterSidebar 服务，保持 conversation.view 兜底（检查 better-sidebar 是否启用/加载）`)
        return
      }
      // 服务在 + 可见 → 注册 ③（替代 ②）
      ctx.effect(() => {
        let dispose3: (() => void) | null = null
        try {
          const desc: Record<string, unknown> = {
            id: SIDEBAR_TAB_ID,
            title: () => 'GPU 监控',
            order: 90,
            single: true,
          }
          const features = (bs as { features?: string[] }).features || []
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
          desc.component = (props: { visible?: boolean; store?: unknown }) => {
            return React.createElement(MonitorPanel, { visible: props.visible, store: props.store })
          }
          dispose3 = (bs as { registerTab(desc: unknown): () => void }).registerTab(desc)
          // ③ 注册成功 → 注销 ②（互斥降级矩阵生效）
          const dv = disposeViewRef()
          if (dv) {
            try {
              dv()
            } catch (e) {
              console.error('[lab-monitor] 注销 conversation.view 出口出错:', e)
            }
          }
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
// 插件对象
// ----------------------------------------------------------------------------

export const name = 'lab-monitor'

/** 依赖声明：只 timer（平台内置恒存在）；better-sidebar 绝不进 inject（t2b 结论①） */
export const inject = ['timer']

export function apply(ctx: CtxLike) {
  ctxRef = ctx
  // ① 数据消费者：apply 顶部无条件执行——首帧拉取（失败静默，轮询退避由组件调度接管）
  void refresh()
  // ② conversation.view 默认出口（★默认兜底；slots 是可选服务，ctx.get 判空）
  // 2026-08-20 修复（plugin-specialist 诊断）：官方 slots 契约要求先
  // slots.inject('conversation.view', () => slots.register(...)) 包裹——
  // inject 订阅该 slot 的声明（ui-conversation 的 children 表），声明就绪后
  // 才执行注册；裸调 slots.register 会抛
  // `slot "conversation.view" is not declared (a parent entry's children table must declare it)`，
  // 导致兜底出口注册失败、UI 完全不显示（chrome console 实测证据）。
  let disposeView: (() => void) | null = null
  const slots = ctx.get('slots')
  if (slots !== undefined) {
    try {
      const slotsSvc = slots as {
        inject(key: string, cb: () => () => void): () => void
        register(desc: unknown, comp: unknown): () => void
      }
      disposeView = slotsSvc.inject('conversation.view', () =>
        slotsSvc.register(
          { name: 'conversation.view', id: 'lab-monitor', order: 20, label: labelThunk },
          MonitorPanel,
        ),
      )
    } catch (e) {
      console.error('[lab-monitor] conversation.view 注册失败:', e)
    }
  } else {
    console.warn('[lab-monitor] slots 服务缺席，跳过 conversation.view 出口（Agent 通道① 兜底）')
  }
  // ③ better-sidebar 适配器（最后增量；双检查 + 重探，失败保持 ②）
  registerSidebarAdapter(ctx, () => disposeView)
}
