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
let POLL_MS_CUR = POLL_MS // 2026-08-22（P1 设置面）：当前生效轮询周期——由快照 thresholds.pollMs 驱动
const POLL_MS_MIN = 1000
const POLL_MS_MAX = 60000
const KEEPALIVE_MS = 30000 // D-B2：better-sidebar visible=false → 30s 低频保活（badge 更新）
const BACKOFFS = [5000, 10000, 30000] // T2-3：失败指数退避 5s→10s→30s 封顶
const THRESH_KEYS = ['utilWarn', 'memWarn', 'tempWarn', 'pollMs', 'procTopN', 'wGpu', 'wCpu', 'wMem']
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
  /** 2026-08-20（A2 多轨）：全部 running 实验（experiment 保留为主实验） */
  experiments?: ExperimentView[]
  /** 2026-08-22（P1 实验历史）：已结束实验（done/crashed/aborted）——复盘展示 */
  ended?: EndedView[]
  /** 2026-08-22（P1 设置面）：当前生效阈值（轮询周期由 pollMs 驱动） */
  thresholds?: { utilWarn: number; memWarn: number; tempWarn: number; pollMs: number; procTopN?: number; wGpu?: number; wCpu?: number; wMem?: number }
  /** 2026-08-22（P1 设置面）：监控引擎启停状态 */
  enabled?: boolean
  /** 2026-08-20（标签分组）：用户标签规则命中聚合 */
  tags?: TagGroupView[]
  alerts: AlertView[]
  alertsCriticalCount: number
  experiment: { runId: string; state: string; cmd?: string | null; pid?: number | null } | null
  callCount: number
  ui: { betterSidebarVisible: boolean }
  error?: boolean
  degraded?: { gpu?: string; reason?: string }
}
/** 2026-08-22（P1 实验历史）：已结束实验摘要（与 host EndedRunSnapshot 对齐） */
interface EndedView {
  runId: string
  state: 'done' | 'crashed' | 'aborted'
  cmd: string | null
  cmdFeature: string | null
  startTs: number
  endTs: number | null
  summary?: {
    gpuUtilMax: number | null
    gpuUtilAvg: number | null
    memPeak: number | null
    durationSec: number
    dataPartial: boolean
    groupCpuMax?: number | null
    groupMemPeakMiB?: number | null
    otherMemPeakMiB?: number | null
  } | null
}
interface ExperimentView {
  runId: string
  state: string
  cmd?: string | null
  pid?: number | null
  startTs: number
  groupStats?: { cpuPct?: number | null; memMiB?: number | null; memberCount?: number } | null
}
interface TagGroupView {
  rule: { id: string; label: string; patterns: string[]; kind: string; color?: string }
  pids: number[]
  procs: { pid: number; cmd: string | null; cpuPct?: number | null; memMiB?: number | null; gpuUtilPct?: number | null }[]
  gpuUtilPct?: number | null
  cpuPct?: number | null
  memMiB?: number | null
  runIds?: string[]
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
    // 2026-08-22（P1 设置面）：轮询周期由 host 生效阈值 pollMs 驱动（范围校验），
    // 消除「client 硬编码 5000 / pollMs 死配置」——面板设置、lab_ctl set-threshold 均可实时生效
    const p = (snap as SnapView).thresholds && (snap as SnapView).thresholds!.pollMs
    if (typeof p === 'number' && isFinite(p) && p >= POLL_MS_MIN && p <= POLL_MS_MAX) POLL_MS_CUR = p
  } else {
    lastOk = false
    if (backoffIdx < BACKOFFS.length - 1) backoffIdx += 1
  }
  return snap
}

/** 下一次轮询等待间隔：成功用 pollMs（阈值驱动），失败用退避档位；hidden=true 用 30s 保活（D-B2）。 */
function nextWaitMs(hidden: boolean): number {
  if (hidden) return KEEPALIVE_MS
  return lastOk ? POLL_MS_CUR : BACKOFFS[backoffIdx]
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

/** 面板状态行一行摘要（紧凑 `·` 分隔，不含 tab 标题前缀；O(1) 读 last）。 */
function summaryLine(s: SnapView): string {
  const g = s.gpu && s.gpu[0]
  const parts: string[] = []
  if (g && s.gpuState !== 'unavailable') {
    parts.push('GPU ' + g.utilPct + '%')
  } else if (s.gpuState === 'unavailable') {
    parts.push('GPU 无')
  }
  if (s.cpu && typeof s.cpu.percent === 'number') parts.push('CPU ' + Math.round(s.cpu.percent) + '%')
  const mem = s.mem && s.mem.totalMiB ? Math.round(((s.mem.totalMiB - (s.mem.availableMiB ?? 0)) / s.mem.totalMiB) * 100) : null
  if (mem !== null) parts.push('内存 ' + mem + '%')
  if (s.alertsCriticalCount) parts.push(s.alertsCriticalCount + '告警')
  return parts.length ? parts.join(' · ') : '监控'
}

/** 2026-08-20（A2 多轨）：实验状态块——主实验 + 并行实验列表（每行 runId/状态/时长/pid/cmd） */
function expBlock(s: SnapView | null, onDetail: (d: DetailData) => void): React.ReactElement | null {
  if (!s) return null
  const main = s.experiment
  const all = Array.isArray(s.experiments) && s.experiments.length ? s.experiments : main ? [main] : []
  if (!all.length && !main) return null
  const rows: React.ReactElement[] = []
  const seen = new Set<string>()
  // 主实验优先展示（标注「主」），并行实验依次列出
  const ordered: { runId: string; state: string; cmd?: string | null; pid?: number | null; startTs?: number }[] = []
  if (main) ordered.push(main)
  for (const e of all) {
    if (e.runId === (main && main.runId)) continue
    ordered.push(e)
  }
  for (const e of ordered) {
    if (seen.has(e.runId)) continue
    seen.add(e.runId)
    const mins = e.startTs ? Math.max(0, Math.round((Date.now() - e.startTs) / 60000)) : null
    const isMain = main && e.runId === main.runId
    const gs = (e as { groupStats?: { cpuPct?: number | null; memMiB?: number | null; memberCount?: number } | null }).groupStats
    rows.push(
      React.createElement('div', {
        key: e.runId,
        onClick: () => onDetail(runDetailData(e, 'running')),
        title: '点击查看完整命令',
        style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', cursor: 'pointer' },
      },
        React.createElement('span', {
          style: {
            width: 8, height: 8, borderRadius: 4,
            background: e.state === 'alerting' ? C.error : e.state === 'running' ? C.success : C.warn,
          },
        }),
        React.createElement('span', { style: { fontWeight: 600, fontSize: 12 } },
          (isMain ? '实验 ' : '  ') + (e.runId || '-')),
        React.createElement('span', { style: { fontSize: 11, color: C.label2 } },
          '[' + (e.state || '-') + ']'),
        mins !== null
          ? React.createElement('span', { style: { fontSize: 11, color: C.label2 } }, mins + 'min')
          : null,
        e.pid
          ? React.createElement('span', { style: { fontSize: 11, color: C.label2 } }, 'pid ' + e.pid)
          : null,
        e.cmd
          ? React.createElement('span', { style: { fontSize: 11, color: C.label2, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              e.cmd)
          : null,
        gs && typeof gs.cpuPct === 'number'
          ? React.createElement('span', { style: { fontSize: 11, color: utilColor(gs.cpuPct) } }, 'CPU ' + Math.round(gs.cpuPct) + '%')
          : null,
        gs && typeof gs.memMiB === 'number'
          ? React.createElement('span', { style: { fontSize: 11, color: C.label2 } }, fmtGiB(gs.memMiB) + 'G')
          : null,
        React.createElement('span', { style: { color: C.label2, fontSize: 11, marginLeft: 2 } }, '›'),
      ),
    )
  }
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, ...rows)
}

/**
 * 2026-08-22（P1 实验历史）：已结束实验复盘列表（done/crashed/aborted）——折叠展示，
 * 每行 runId + 状态徽标 + 时长 + GPU 峰值摘要（util 峰值/均值、显存峰值、组 CPU 峰值）。
 * 数据来自 host ended[]（state-machine history 投影，最新在前，上限 20）。
 */
function EndedBlock(props: { ended: EndedView[]; onDetail: (d: DetailData) => void }): React.ReactElement | null {
  const [open, setOpen] = React.useState(false)
  const ended = props.ended || []
  if (!ended.length) return null
  const rows = ended.map((e) => {
    const s = e.summary
    const mins = e.endTs ? Math.max(0, Math.round((e.endTs - e.startTs) / 60000)) : null
    const dur = s && typeof s.durationSec === 'number' ? (s.durationSec < 60 ? s.durationSec + 's' : Math.round(s.durationSec / 60) + 'min') : (mins !== null ? mins + 'min' : '-')
    const color = e.state === 'done' ? C.success : e.state === 'crashed' ? C.error : C.label2
    // 指标 stat：小标签在上 + 主值在下（栅格单元），替代原先挤一行的「GPU峰值/均值/显存峰值/组CPU峰值」
    const stat = (label: string, val: number | string | null | undefined, valColor?: string) => (val === null || val === undefined)
      ? null
      : React.createElement('div', { key: label, style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
          React.createElement('span', { style: { fontSize: 10, color: C.label2 } }, label),
          React.createElement('span', { style: { fontSize: 11, fontWeight: 600, color: (valColor || C.label) } }, String(val)),
        )
    return React.createElement('div', {
      key: e.runId,
      onClick: () => props.onDetail(runDetailData(e, 'ended')),
      title: '点击查看完整命令',
      style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', background: C.layer1, border: '1px solid ' + C.border, borderRadius: 8, cursor: 'pointer' },
    },
      // 标题行：状态点 + runId + 状态徽标 + 时长
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11 } },
        React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 } }),
        React.createElement('span', { style: { fontWeight: 600, fontSize: 11 } }, e.runId),
        React.createElement('span', { style: { fontSize: 10, padding: '0 4px', borderRadius: 3, border: '1px solid ' + color, color: color } },
          e.state === 'done' ? '完成' : e.state === 'crashed' ? '崩溃' : '中止'),
        React.createElement('span', { style: { color: C.label2 } }, dur),
      ),
      // 指标栅格：2 列自适应（auto-fit），每字段「标签/值」上下排
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: '4px 10px' } },
        stat('GPU峰值', s && typeof s.gpuUtilMax === 'number' ? s.gpuUtilMax + '%' : null, s && typeof s.gpuUtilMax === 'number' ? utilColor(s.gpuUtilMax) : undefined),
        stat('GPU均值', s && typeof s.gpuUtilAvg === 'number' ? s.gpuUtilAvg + '%' : null),
        stat('显存峰值', s && typeof s.memPeak === 'number' ? fmtGiB(s.memPeak) + 'G' : null),
        stat('组CPU峰值', s && typeof s.groupCpuMax === 'number' ? Math.round(s.groupCpuMax) + '%' : null, s && typeof s.groupCpuMax === 'number' ? utilColor(s.groupCpuMax) : undefined),
      ),
      // cmd 全宽行（点击查看完整命令）
      e.cmd
        ? React.createElement('div', { style: { fontSize: 11, color: C.label2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 } }, e.cmd)
        : null,
    )
  })
  return React.createElement('div', { key: 'ended', style: { marginTop: 2 } },
    React.createElement('div', {
      onClick: () => setOpen((v) => !v),
      style: { sectionTitle, cursor: 'pointer' },
    },
      (open ? '▼ ' : '▸ ') + '实验历史（' + ended.length + '）'),
    open ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, ...rows) : null,
  )
}

/**
 * 2026-08-22（P1 设置面）：面板控制区——阈值（utilWarn/memWarn/tempWarn）+ 暂停/恢复 +
 * 清除告警。conversation.view 模式下此前无任何设置/控制入口（阈值只有 lab_ctl 工具）。
 * set-threshold 走 HTTP setThresholds（即时生效 + settings 持久化）；轮询周期由快照 thresholds.pollMs 驱动。
 */
function ControlPanel(props: { snap: SnapView | null }): React.ReactElement {
  const s = props.snap
  const thr = s && s.thresholds
  const [utilWarn, setUtilWarn] = React.useState<string>(thr ? String(thr.utilWarn) : '')
  const [memWarn, setMemWarn] = React.useState<string>(thr ? String(thr.memWarn) : '')
  const [tempWarn, setTempWarn] = React.useState<string>(thr ? String(thr.tempWarn) : '')
  // 2026-08-23：进程排序配置（取前 N + CPU/GPU/内存 权重，均可调）
  const [procTopN, setProcTopN] = React.useState<string>(thr && typeof thr.procTopN === 'number' ? String(thr.procTopN) : '30')
  const [wGpu, setWGpu] = React.useState<string>(thr && typeof thr.wGpu === 'number' ? String(thr.wGpu) : '1')
  const [wCpu, setWCpu] = React.useState<string>(thr && typeof thr.wCpu === 'number' ? String(thr.wCpu) : '1')
  const [wMem, setWMem] = React.useState<string>(thr && typeof thr.wMem === 'number' ? String(thr.wMem) : '1')
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState<string | null>(null)
  const paused = s && s.enabled === false

  // 2026-08-22：外部（lab_ctl / settings.yaml）改阈值 → 快照 thresholds 变化 → 本地表单跟随
  React.useEffect(() => {
    if (thr) {
      setUtilWarn(String(thr.utilWarn))
      setMemWarn(String(thr.memWarn))
      setTempWarn(String(thr.tempWarn))
      if (typeof thr.procTopN === 'number') setProcTopN(String(thr.procTopN))
      if (typeof thr.wGpu === 'number') setWGpu(String(thr.wGpu))
      if (typeof thr.wCpu === 'number') setWCpu(String(thr.wCpu))
      if (typeof thr.wMem === 'number') setWMem(String(thr.wMem))
    }
  }, [thr && thr.utilWarn, thr && thr.memWarn, thr && thr.tempWarn, thr && thr.procTopN, thr && thr.wGpu, thr && thr.wCpu, thr && thr.wMem])

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', background: C.layer1, border: '1px solid ' + C.border, color: C.label,
    borderRadius: 4, padding: '4px 6px', fontSize: 11, textAlign: 'right',
  }
  const btnStyle: React.CSSProperties = {
    background: 'transparent', border: '1px solid ' + C.border, borderRadius: 4,
    fontSize: 11, padding: '2px 8px', cursor: 'pointer', color: C.label,
  }
  // 主操作按钮用「ink 底 + surface 字」反转色（主题无关高对比）；brand 在暗色主题为白色，配 #fff 会白底白字不可见
  const okBtn: React.CSSProperties = { ...btnStyle, background: C.label, color: C.layer1, border: 'none' }

  const setThr = () => {
    const num = (v: string): number | null => {
      const n = Number(v)
      return v.trim() !== '' && isFinite(n) ? n : null
    }
    const body: Record<string, number> = {}
    const u = num(utilWarn); const m = num(memWarn); const t = num(tempWarn)
    if (u !== null) body.utilWarn = Math.max(0, Math.min(100, u))
    if (m !== null) body.memWarn = Math.max(0, Math.min(100, m))
    if (t !== null) body.tempWarn = Math.max(0, Math.min(120, t))
    const n = num(procTopN); const g = num(wGpu); const c = num(wCpu); const mm = num(wMem)
    if (n !== null) body.procTopN = Math.max(5, Math.min(200, Math.round(n)))
    if (g !== null) body.wGpu = Math.max(0, Math.min(20, g))
    if (c !== null) body.wCpu = Math.max(0, Math.min(20, c))
    if (mm !== null) body.wMem = Math.max(0, Math.min(20, mm))
    if (!Object.keys(body).length) { setMsg('阈值格式无效'); return }
    setBusy(true); setMsg(null)
    apiCall<{ ok?: boolean; applied?: Record<string, number> }>('setThresholds', body)
      .then((r) => {
        if (r && (r as { ok?: boolean }).ok) setMsg('已生效（持久化）')
        else setMsg((r as { error?: string } | undefined)?.error || '设置失败')
      })
      .catch(() => setMsg('调用失败'))
      .finally(() => setBusy(false))
  }

  const setPaused = (pausedTo: boolean) => {
    setBusy(true); setMsg(null)
    apiCall<{ ok?: boolean; state?: string }>('control', { action: pausedTo ? 'pause' : 'resume' })
      .then((r) => { if (!r || !(r as { ok?: boolean }).ok) setMsg('操作失败') })
      .catch(() => setMsg('调用失败'))
      .finally(() => setBusy(false))
  }

  const clearAlerts = () => {
    setBusy(true); setMsg(null)
    apiCall<{ ok?: boolean; cleared?: number }>('control', { action: 'clear-alerts' })
      .then((r) => {
        const c = r && (r as { cleared?: number }).cleared
        setMsg('已清除' + (typeof c === 'number' ? ' ' + c + ' 条' : ''))
      })
      .catch(() => setMsg('调用失败'))
      .finally(() => setBusy(false))
  }

  const pollChip = thr
    ? React.createElement('span', { style: { fontSize: 11, color: C.label2, marginLeft: 'auto', padding: '1px 7px', borderRadius: 10, background: C.border } },
        '轮询 ' + Math.round(thr.pollMs / 1000) + 's')
    : null
  // 阈值字段：label 在上、input 在下（栅格列），替代原先「标签+输入」挤一行的密排
  const field = (label: string, val: string, onChange: (v: string) => void, title: string) =>
    React.createElement('div', { key: label, style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
      React.createElement('label', { style: { fontSize: 11, color: C.label2 } }, label),
      React.createElement('input', { value: val, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value), style: inputStyle, title }),
    )

  return React.createElement('div', { key: 'ctrl', style: sectionCard },
    // 头部行：chip + 运行状态 + 轮询周期（右对齐 chip）
    React.createElement('div', { style: sectionHead },
      React.createElement('span', { style: sectionChip }, '控制'),
      React.createElement('span', { style: { fontSize: 11, color: paused ? C.warn : C.success } },
        paused ? '监控已暂停' : '监控运行中'),
      pollChip,
    ),
    // 阈值分组：3 列自适应栅格，每字段「标签在上 / 输入在下」降低密度
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginTop: 8 } },
      field('GPU利用%', utilWarn, setUtilWarn, 'GPU 利用率告警阈值'),
      field('显存%', memWarn, setMemWarn, '显存占用告警阈值'),
      field('温度°C', tempWarn, setTempWarn, '温度告警阈值'),
    ),
    // 进程排序：取前 N + CPU/GPU/内存 权重（2026-08-23）
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))', gap: 10, marginTop: 8 } },
      field('取前N进程', procTopN, setProcTopN, '按加权打分取前 N 个高占用进程（5..200）'),
      field('权重GPU', wGpu, setWGpu, 'GPU 利用率权重（0..20）'),
      field('权重CPU', wCpu, setWCpu, 'CPU 利用率权重（0..20）'),
      field('权重内存', wMem, setWMem, '内存占用权重（0..20）'),
    ),
    // 操作行：保存 / 暂停/恢复 / 清除告警
    React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
      React.createElement('button', { onClick: setThr, disabled: busy, style: okBtn }, '保存'),
      React.createElement('button', { onClick: () => setPaused(!paused), disabled: busy, style: btnStyle }, paused ? '恢复' : '暂停'),
      React.createElement('button', { onClick: clearAlerts, disabled: busy, style: btnStyle },
        '清除告警' + (s && s.alertsCriticalCount ? '（' + s.alertsCriticalCount + '）' : '')),
    ),
    msg ? React.createElement('div', { style: { fontSize: 11, color: C.brand, marginTop: 8 } }, msg) : null,
  )
}

/** 2026-08-20（标签分组）：用户标签规则命中的分组展示——组头（label+kind+聚合）+ 命中进程行 */
function TagGroups(props: { tags: TagGroupView[]; onDetail: (d: DetailData) => void }): React.ReactElement {
  const groups = props.tags || []
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    groups.map((g) => {
      const color = g.rule && g.rule.color ? g.rule.color : C.label
      const isExp = g.rule && g.rule.kind === 'experiment'
      return React.createElement('div', {
        key: g.rule.id,
        style: sectionCard,
      },
        // 组头：标签徽章 + label + kind 徽标 + 聚合统计（2026-08-20：加「标签」胶囊徽章，
        // 与内置默认聚合组（浏览器/编辑器等）明显区分——用户反馈分不清标签分组与默认分组）
        React.createElement('div', { style: sectionHead },
          React.createElement('span', { style: { fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8, background: color, color: g.rule && g.rule.color ? '#fff' : C.layer1 } },
            '标签'),
          React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: color } }),
          React.createElement('span', { style: { fontWeight: 600, fontSize: 12 } }, g.rule.label || '未命名'),
          React.createElement('span', { style: { fontSize: 10, padding: '0 4px', borderRadius: 3, border: '1px solid ' + color, color: color } },
            isExp ? '实验' : '进程'),
          React.createElement('span', { style: { fontSize: 11, color: C.label2 } }, g.pids.length + ' 进程'),
          g.gpuUtilPct !== null && g.gpuUtilPct !== undefined
            ? React.createElement('span', { style: { fontSize: 11, color: utilColor(g.gpuUtilPct) } }, 'GPU ' + g.gpuUtilPct + '%')
            : null,
          g.cpuPct !== null && g.cpuPct !== undefined
            ? React.createElement('span', { style: { fontSize: 11, color: utilColor(g.cpuPct) } }, 'CPU ' + g.cpuPct + '%')
            : null,
          g.memMiB !== null && g.memMiB !== undefined
            ? React.createElement('span', { style: { fontSize: 11, color: C.label2 } }, fmtGiB(g.memMiB) + 'G')
            : null,
          isExp && g.runIds && g.runIds.length
            ? React.createElement('span', { style: { fontSize: 10, color: C.label2 } },
                '实验 ' + g.runIds.join(' / '))
            : null,
        ),
        // 命中进程明细（对齐栅格简表：列头 + 每行「PID / 命令 / GPU / CPU / 内存」，点行查看详情）
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 } },
          React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '52px 1fr 44px 44px 44px', gap: 6, fontSize: 10, color: C.label2, paddingBottom: 2, borderBottom: '1px solid ' + C.border } },
            React.createElement('span', null, 'PID'),
            React.createElement('span', null, '命令'),
            React.createElement('span', { style: { textAlign: 'right' } }, 'GPU'),
            React.createElement('span', { style: { textAlign: 'right' } }, 'CPU'),
            React.createElement('span', { style: { textAlign: 'right' } }, '内存'),
          ),
          g.procs.map((p) => (
            React.createElement('div', {
              key: p.pid,
              onClick: () => props.onDetail(procDetailData(p, g.rule && g.rule.label)),
              title: '点击查看进程详情',
              style: { display: 'grid', gridTemplateColumns: '52px 1fr 44px 44px 44px', gap: 6, alignItems: 'center', fontSize: 11, cursor: 'pointer' },
            },
              React.createElement('span', { style: { color: C.label2, fontVariantNumeric: 'tabular-nums' } }, String(p.pid)),
              React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.cmd || '-'),
              typeof p.gpuUtilPct === 'number'
                ? React.createElement('span', { style: { color: utilColor(p.gpuUtilPct), textAlign: 'right' } }, p.gpuUtilPct + '%')
                : React.createElement('span', null, '-'),
              typeof p.cpuPct === 'number'
                ? React.createElement('span', { style: { color: utilColor(p.cpuPct), textAlign: 'right' } }, p.cpuPct + '%')
                : React.createElement('span', null, '-'),
              React.createElement('span', { style: { color: C.label2, textAlign: 'right' } }, fmtGiB(p.memMiB) + 'G'),
            )
          )),
        ),
      )
    }),
  )
}

/** 2026-08-20（标签管理 UI）：全量标签规则管理——列表（含未命中进程的规则）+ 添加表单 + 删除。
 * 数据来自 host tag API（rpcTag list 返回全量 tagSet()）；add/remove 后重拉 + 快照随轮询刷新。 */
function TagManager(props: { tags: TagGroupView[] }): React.ReactElement {
  const [rules, setRules] = React.useState<{ id: string; label: string; patterns: string[]; kind: string; color?: string }[] | null>(null)
  const [label, setLabel] = React.useState('')
  const [patterns, setPatterns] = React.useState('')
  const [kind, setKind] = React.useState('process')
  const [color, setColor] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState<string | null>(null)

  // 2026-08-20：不用 useCallback（mock-test 的 hook 容器未 mock useCallback；且组件每次 poll 重建，
  // useCallback 收益有限）——普通函数 + useEffect 挂载时拉一次规则列表。
  function refreshRules() {
    apiCall<{ ok?: boolean; tags?: { id: string; label: string; patterns: string[]; kind: string; color?: string }[] }>('tag', { tag: { op: 'list' } })
      .then((r) => {
        if (r && (r as { ok?: boolean }).ok && Array.isArray((r as { tags?: unknown[] }).tags)) setRules((r as { tags: { id: string; label: string; patterns: string[]; kind: string; color?: string }[] }).tags)
      })
      .catch(() => {})
  }
  React.useEffect(() => { refreshRules() }, [])

  function act(body: Record<string, unknown>) {
    setBusy(true)
    setMsg(null)
    apiCall<{ ok?: boolean; error?: string }>('tag', { tag: body })
      .then((r) => {
        if (r && (r as { ok?: boolean }).ok === true) { refreshRules() }
        else setMsg((r as { error?: string } | undefined)?.error || '操作失败')
      })
      .catch(() => setMsg('调用失败'))
      .finally(() => setBusy(false))
  }

  const add = () => {
    const ls = label.trim()
    const ps = patterns.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
    if (!ls) { setMsg('需要标签名'); return }
    if (!ps.length) { setMsg('需要至少一个匹配模式（正则）'); return }
    const body: Record<string, unknown> = { op: 'add', label: ls, patterns: ps, kind }
    if (color.trim()) body.color = color.trim()
    act(body)
    setLabel(''); setPatterns('')
  }

  // 无标签规则时显示引导；有规则时折叠式管理
  const hasRules = Array.isArray(rules) && rules.length > 0
  return React.createElement('div', { style: sectionCard },
    React.createElement('div', { style: sectionHead },
      React.createElement('span', { style: sectionChip }, '标签管理'),
      React.createElement('span', { style: { fontSize: 11, color: C.label2 } },
        hasRules ? rules.length + ' 条规则' : '无规则——添加后按命令匹配分组展示'),
    ),
    // 规则列表（每条：色点 + label + kind + patterns + 删除）
    hasRules
      ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 } },
          (rules as { id: string; label: string; patterns: string[]; kind: string; color?: string }[]).map((r) => {
            const c = r.color || C.label
            return React.createElement('div', { key: r.id, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 } },
              React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: c, flexShrink: 0 } }),
              React.createElement('span', { style: { fontWeight: 600 } }, r.label),
              React.createElement('span', { style: { fontSize: 10, padding: '0 4px', borderRadius: 3, border: '1px solid ' + C.border, color: C.label2 } },
                r.kind === 'experiment' ? '实验' : '进程'),
              React.createElement('span', { style: { color: C.label2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } },
                r.patterns.join(' | ')),
              React.createElement('button', {
                onClick: () => act({ op: 'remove', id: r.id }),
                style: { background: 'transparent', border: '1px solid ' + C.border, color: C.error, borderRadius: 4, fontSize: 10, padding: '1px 6px', cursor: 'pointer' },
              }, '删除'),
            )
          }),
        )
      : null,
    // 添加表单
    React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: hasRules ? 8 : 6 } },
      React.createElement('input', {
        value: label, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value),
        placeholder: '标签名', style: { flex: '0 1 110px', background: C.layer1, border: '1px solid ' + C.border, color: C.label, borderRadius: 4, padding: '3px 6px', fontSize: 11 },
      }),
      React.createElement('input', {
        value: patterns, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setPatterns(e.target.value),
        placeholder: '正则，如 explorer\\.exe|Taskmgr\\.exe', style: { flex: '1 1 200px', background: C.layer1, border: '1px solid ' + C.border, color: C.label, borderRadius: 4, padding: '3px 6px', fontSize: 11 },
      }),
      React.createElement('select', {
        value: kind, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setKind(e.target.value),
        style: { background: C.layer1, border: '1px solid ' + C.border, color: C.label, borderRadius: 4, padding: '3px 4px', fontSize: 11 },
      },
        React.createElement('option', { value: 'process' }, '进程'),
        React.createElement('option', { value: 'experiment' }, '实验'),
      ),
      React.createElement('input', {
        value: color, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setColor(e.target.value),
        placeholder: '#颜色', style: { width: 64, background: C.layer1, border: '1px solid ' + C.border, color: C.label, borderRadius: 4, padding: '3px 6px', fontSize: 11 },
      }),
      React.createElement('button', {
        onClick: add, disabled: busy,
        style: { background: C.label, color: C.layer1, border: 'none', borderRadius: 4, fontSize: 11, padding: '3px 10px', cursor: 'pointer' },
      }, '添加'),
    ),
    msg ? React.createElement('div', { style: { fontSize: 11, color: C.error, marginTop: 4 } }, msg) : null,
  )
}

// ----------------------------------------------------------------------------
// ② conversation.view 默认出口（★P0 主 UI）
// ----------------------------------------------------------------------------

const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const cardStyle: React.CSSProperties = {
  flex: '1 1 190px', minWidth: 190, padding: '12px 14px', borderRadius: 10,
  border: '1px solid ' + C.border, background: C.layer1, fontSize: 12, color: C.label,
}
/** 统一的区块小标题（层级/字号/间距单一来源）——让「趋势/进程/告警」等区块观感一致 */
const sectionTitle: React.CSSProperties = {
  fontWeight: 600, fontSize: 12, color: C.label, marginBottom: 6, letterSpacing: 0.2,
}
/** 统一的「section 容器」：控制/标签管理/标签 三张描边卡共用同一视觉语言 */
const sectionCard: React.CSSProperties = {
  border: '1px solid ' + C.border, borderRadius: 10, padding: '10px 12px',
  background: C.layer1, marginTop: 0,
}
/** section 容器头部行：chip + 描述 左对齐，可右对齐的次要信息用 marginLeft:auto */
const sectionHead: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
/** 统一的小型状态 chip（theme 无关反转色：暗色=白底深字，亮色=深底白字） */
const sectionChip: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8, background: C.label, color: C.layer1,
}
/** 指标卡标题行：左标题 + 右主数值（基线对齐） */
const cardHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }
/** 指标卡主数值：统一放大字号建立层级（大数字=hero 值） */
const cardValue: React.CSSProperties = { color: C.label, fontWeight: 700, fontSize: 16, fontVariantNumeric: 'tabular-nums' }
/** 指标卡进度条（GPU/CPU/内存 共用的状态色 bar，高度一致） */
function pctBar(pct: number | null | undefined, height = 8): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, pct === null || pct === undefined ? 0 : pct))
  return React.createElement('div', {
    key: 'bar', style: { height, borderRadius: height / 2, marginTop: 8, background: C.border, overflow: 'hidden' },
  },
    React.createElement('div', { style: { height: '100%', width: clamped + '%', background: utilColor(pct), borderRadius: height / 2 } }),
  )
}
/** 指标卡细节行：次要信息（显存/温度/核数/已用等） */
const cardMeta: React.CSSProperties = { marginTop: 8, color: C.label2, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11 }
const thStyle: React.CSSProperties = {
  textAlign: 'left', fontWeight: 600, padding: '4px 6px',
  borderBottom: '1px solid ' + C.border, whiteSpace: 'nowrap', fontSize: 12,
}
const tdStyle: React.CSSProperties = {
  padding: '4px 6px', borderBottom: '1px solid rgba(0,0,0,0.06)',
  whiteSpace: 'nowrap', fontSize: 12,
}

/** GPU 短名：去 vendor 前缀取紧凑型号 + GPU 编号（"NVIDIA GeForce RTX 5060 Ti" → "RTX 5060 Ti · GPU0"）。 */
function gpuShortName(g: GpuView): string {
  const full = (g.name || '').trim()
  const short = full.replace(/^(nvidia\s+)?(geforce\s+)?(amd\s+)?(radeon\s+)?(intel\s+)?(arc\s+)?(titan\s+)?/i, '').trim()
  return (short ? short + ' · ' : '') + 'GPU' + g.id
}

function gpuCard(g: GpuView) {
  const pct = g.utilPct
  return React.createElement('div', { key: g.id, style: cardStyle },
    React.createElement('div', { style: cardHead },
      React.createElement('span', { style: { fontWeight: 600, color: C.label } },
        gpuShortName(g)),
      React.createElement('span', { style: { ...cardValue, color: utilColor(pct) } }, pct + '%'),
    ),
    pctBar(pct),
    React.createElement('div', { style: cardMeta },
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
    React.createElement('div', { style: cardHead },
      React.createElement('span', { style: { fontWeight: 600, color: C.label } }, 'CPU'),
      React.createElement('span', { style: { ...cardValue, color: utilColor(pct) } }, pct === null ? '-' : Math.round(pct) + '%'),
    ),
    pctBar(pct),
    React.createElement('div', { style: cardMeta },
      React.createElement('span', null, s && s.cpu && s.cpu.cores ? '核数 ' + s.cpu.cores : '—'),
    ),
  )
}

function memCard(s: SnapView | null) {
  const mem = s && s.mem
  const pct = mem && mem.totalMiB ? ((mem.totalMiB - (mem.availableMiB ?? 0)) / mem.totalMiB) * 100 : null
  return React.createElement('div', { key: 'mem', style: cardStyle },
    React.createElement('div', { style: cardHead },
      React.createElement('span', { style: { fontWeight: 600, color: C.label } }, '内存'),
      React.createElement('span', { style: { ...cardValue, color: utilColor(pct) } }, pct === null ? '-' : Math.round(pct) + '%'),
    ),
    pctBar(pct),
    React.createElement('div', { style: cardMeta },
      React.createElement('span', null, mem && mem.totalMiB ? fmtGiB(mem.totalMiB - (mem.availableMiB ?? 0)) + '/' + fmtGiB(mem.totalMiB) + 'G' : '—'),
    ),
  )
}

// 常见默认进程聚合组（2026-08-20：避免列表被系统进程刷屏；折叠展示 + 统计行）
const DEFAULT_PROC_GROUPS: { key: string; label: string; match: (cmd: string) => boolean }[] = [
  { key: 'browser', label: '浏览器', match: (c) => /chrome|msedge|firefox|WeChatAppEx/i.test(c) },
  { key: 'ide', label: '编辑器/终端', match: (c) => /Code\.exe|WindowsTerminal|ShellHost|coodesker|explorer/i.test(c) },
  { key: 'docker', label: 'Docker/WSL', match: (c) => /Docker|docker|wsl/i.test(c) },
  { key: 'system', label: '系统进程', match: (c) => /System|Registry|smss|csrss|wininit|services|lsass|dwm|SearchHost|StartMenu|LockApp|TextInputHost|ApplicationFrame/i.test(c) },
  { key: 'vm', label: '虚拟机', match: (c) => /vmmem|vmwp|vmms|VmCompute|HvHost|vmware|VirtualBox|VBoxHeadless|qemu|VGAuth/i.test(c) },
  { key: 'other-app', label: '常用应用', match: (c) => /Weixin|QQ|ToDesk|TaiShanNet|llama-server/i.test(c) },
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
function ProcsTable(props: { snap: SnapView | null; onDetail: (d: DetailData) => void }) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})
  const s = props.snap
  const all = (s && Array.isArray(s.procs)) ? s.procs : []
  if (!all.length || !s) return null
  const watched = new Set<number>(Array.isArray(s.watchedPids) ? s.watchedPids : [])
  // 进程排序配置：从快照 thresholds 读 取前N + CPU/GPU/内存 权重（默认 30 / 1:1:1，设置页可调）
  const thr = (s && s.thresholds) as { procTopN?: number; wGpu?: number; wCpu?: number; wMem?: number } | undefined
  const procTopN = (thr && typeof thr.procTopN === 'number') ? Math.max(5, Math.round(thr.procTopN)) : 30
  const wGpu = (thr && typeof thr.wGpu === 'number') ? thr.wGpu : 1
  const wCpu = (thr && typeof thr.wCpu === 'number') ? thr.wCpu : 1
  const wMem = (thr && typeof thr.wMem === 'number') ? thr.wMem : 1
  // 加权打分：GPU/CPU/内存（0-100 归一化）× 权重（权重可调，默认均衡）
  const memTotal = s.mem && s.mem.totalMiB
  const score = (p: ProcView): number => {
    const gpu = procGpu(p) || 0
    const cpu = p.cpuPct || 0
    const memPct = (memTotal && p.memMiB) ? (p.memMiB / memTotal) * 100 : 0
    return wGpu * gpu + wCpu * cpu + wMem * memPct
  }
  const watchedRows = all.filter((p) => watched.has(p.pid))
  const total = all.length
  // ① 先按加权打分选前 N 个高占用（watch 置顶已含，N 在设置页可调）→ ② 再对它们分组展示
  const top = all.filter((p) => !watched.has(p.pid)).slice().sort((a, b) => score(b) - score(a)).slice(0, Math.max(1, procTopN - watchedRows.length))
  const groupRows: { key: string; label: string; members: ProcView[] }[] = []
  const remaining = top.slice()
  for (const g of DEFAULT_PROC_GROUPS) {
    const members = remaining.filter((p) => g.match(p.cmd || ''))
    if (!members.length) continue
    groupRows.push({ key: g.key, label: g.label, members })
    for (const m of members) remaining.splice(remaining.indexOf(m), 1)
  }
  const otherRows = remaining
  // 组按总占用排序（与打分一致），最重的组排最前
  const groupScore = (members: ProcView[]): number => members.reduce((a, p) => a + score(p), 0)
  groupRows.sort((a, b) => groupScore(b.members) - groupScore(a.members))
  // 组资源聚合：只显示非零项，做成彩色徽标（GPU/CPU 按利用率着色、内存灰）——干净且一眼定位吃哪类资源
  const aggTokens = (members: ProcView[]): React.ReactElement[] => {
    const gpu = Math.round(members.reduce((a, p) => a + (procGpu(p) || 0), 0))
    const cpu = Math.round(members.reduce((a, p) => a + (p.cpuPct || 0), 0))
    const mem = members.reduce((a, p) => a + (p.memMiB || 0), 0)
    const out: React.ReactElement[] = []
    const tok = { marginLeft: 8, fontWeight: 600 } as React.CSSProperties
    if (gpu > 0) out.push(React.createElement('span', { key: 'gpu', style: { ...tok, color: utilColor(gpu) } }, 'GPU ' + gpu + '%'))
    if (cpu > 0) out.push(React.createElement('span', { key: 'cpu', style: { ...tok, color: utilColor(cpu) } }, 'CPU ' + cpu + '%'))
    if (mem > 0) out.push(React.createElement('span', { key: 'mem', style: { ...tok, color: C.label2 } }, '内存 ' + fmtGiB(mem) + 'G'))
    return out
  }
  const row = (p: ProcView, kind?: 'watch' | 'group') => {
    const gpu = procGpu(p) || 0
    const cpu = p.cpuPct || 0
    const hot = gpu >= 80 || cpu >= 80
    const bg = kind === 'watch' ? 'rgba(57,100,254,0.06)' : hot ? 'rgba(220,38,38,0.07)' : (kind === 'group' ? 'rgba(0,0,0,0.02)' : undefined)
    return React.createElement('tr', {
      key: 'p' + p.pid,
      onClick: () => props.onDetail(procDetailData(p)),
      title: '点击查看进程详情',
      style: { background: bg, cursor: 'pointer' },
    },
      React.createElement('td', { style: tdStyle }, String(p.pid)),
      React.createElement('td', { style: { ...tdStyle, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' } }, p.cmd || ''),
      React.createElement('td', { style: { ...tdStyle, color: gpu >= 80 ? C.error : undefined } }, procGpu(p) !== null ? String(Math.round(procGpu(p) as number)) : '-'),
      React.createElement('td', { style: { ...tdStyle, color: cpu >= 80 ? C.error : undefined } }, p.cpuPct !== undefined && p.cpuPct !== null ? String(Math.round(p.cpuPct)) : '-'),
      React.createElement('td', { style: tdStyle }, p.memMiB !== undefined && p.memMiB !== null ? fmtGiB(p.memMiB) + 'G' : '-'),
    )
  }
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = { ...prev }
      if (next[key]) delete next[key]
      else next[key] = true
      return next
    })
  const tbodyRows: unknown[] = []
  // watched 置顶（独立高亮行）
  for (const p of watchedRows) tbodyRows.push(row(p, 'watch'))
  // 聚合组：标题行（点击展开/收起，含资源聚合）+ 展开时全部成员行
  for (const g of groupRows) {
    const open = !!expanded[g.key]
    tbodyRows.push(React.createElement('tr', {
      key: 'grp-' + g.label,
      onClick: () => toggle(g.key),
      style: { cursor: 'pointer' },
    },
      React.createElement('td', { colSpan: 5, style: { ...tdStyle, color: C.label2, fontSize: 11 } },
        React.createElement('span', { key: 'label' },
          (open ? '▼ ' : '▸ ') + g.label + '（' + g.members.length + '）'),
        ...aggTokens(g.members),
        (open ? null : React.createElement('span', { key: 'prev', style: { marginLeft: 8, color: C.label2 } },
          g.members.slice(0, 3).map((m) => m.cmd || '').join(' / '))),
      ),
    ))
    if (open) {
      for (const m of g.members.slice(0, 30)) tbodyRows.push(row(m, 'group'))
      if (g.members.length > 30) tbodyRows.push(React.createElement('tr', { key: 'more-' + g.key },
        React.createElement('td', { colSpan: 5, style: { ...tdStyle, color: C.label2, fontSize: 10, padding: '2px 6px' } },
          '… 还有 ' + (g.members.length - 30) + ' 个成员')),
      )
    }
  }
  // 其余普通进程（非默认组）：做成**可折叠**组（默认收起，点击展开），与默认聚合组一致，避免刷屏
  if (otherRows.length) {
    const open = !!expanded['other']
    tbodyRows.push(React.createElement('tr', {
      key: 'grp-other',
      onClick: () => toggle('other'),
      style: { cursor: 'pointer' },
    },
      React.createElement('td', { colSpan: 5, style: { ...tdStyle, color: C.label2, fontSize: 11, borderTop: '1px solid ' + C.border, paddingTop: 6, marginTop: 6 } },
        React.createElement('span', { key: 'label' },
          (open ? '▼ ' : '▸ ') + '其他进程（' + otherRows.length + '）'),
        ...aggTokens(otherRows),
        (open ? null : React.createElement('span', { key: 'prev', style: { marginLeft: 8, color: C.label2 } },
          otherRows.slice(0, 3).map((m) => m.cmd || '').join(' / '))),
      ),
    ))
    if (open) {
      for (const p of otherRows.slice(0, 30)) tbodyRows.push(row(p, 'group'))
      if (otherRows.length > 30) tbodyRows.push(React.createElement('tr', { key: 'more-other' },
        React.createElement('td', { colSpan: 5, style: { ...tdStyle, color: C.label2, fontSize: 10, padding: '2px 6px' } },
          '… 还有 ' + (otherRows.length - 30) + ' 个成员')),
      )
    }
  }
  return React.createElement('div', { key: 'procs', style: { marginTop: 4 } },
    React.createElement('div', { style: sectionTitle, title: '按加权打分（GPU/CPU/内存 权重可调）取前 ' + procTopN + ' 个高占用进程，再分组' },
      '进程' + (s && s.sources && s.sources.procs ? '（' + s.sources.procs + '）' : '') + ' · 共 ' + total +
      (total > procTopN ? ' · 显示前' + procTopN : '') +
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
  return React.createElement('div', { key: 'alerts', style: { marginTop: 4 } },
    React.createElement('div', { style: sectionTitle },
      '告警' + (merged.length ? '（' + merged.length + '）' : '')),
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
    return React.createElement('div', { key: 'trend', style: { marginTop: 2 } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
        React.createElement('span', { style: sectionTitle }, 'GPU 利用率趋势'),
      ),
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
  return React.createElement('div', { key: 'trend', style: { marginTop: 2 } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
      React.createElement('span', { style: sectionTitle }, 'GPU 利用率趋势'),
      React.createElement('span', { style: { fontSize: 11, color: C.label2 } }, yMin + '%–' + yMax + '%'),
    ),
    React.createElement('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: 56, style: { display: 'block', maxWidth: 640, minHeight: 56, background: C.layer1, borderRadius: 6, border: '1px solid ' + C.border } },
      React.createElement('line', { x1: PAD, y1: baseY, x2: W - PAD, y2: baseY, stroke: 'rgba(128,128,128,0.25)', strokeWidth: 1 }),
      // 2026-08-20 截图核验真根因：此前用 polyline 元素 + path 格式 points（"M4 52 L12 50"），
      // polyline 只接受坐标对（"4,52 12,50"）→ 非法属性被浏览器忽略 → 折线永不渲染。
      // 改用 path 元素（d 属性原生支持 M/L）；stroke 硬编码 #3964fe（不依赖 CSS 变量）。
      React.createElement('path', { d: line, fill: 'none', stroke: '#3964fe', strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }),
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
// ----------------------------------------------------------------------------
// 详情展示页（长命令/路径 → 点击查看完整信息，信息密度合理）
// ----------------------------------------------------------------------------
interface DetailStat { label: string; value: string; color?: string }
interface DetailMeta { label: string; value: string }
interface DetailData {
  title: string
  sub?: string
  cmd?: string | null
  stats: DetailStat[]
  meta?: DetailMeta[]
}

/** 详情用的进程形状：兼容 ProcView（cmd: string）与标签组进程（cmd: string|null）两种来源。 */
type ProcLike = { pid: number; cmd?: string | null; cpuPct?: number | null; memMiB?: number | null; gpuUtilPct?: number | null; gpu?: number | null }

/** 进程详情数据（供 ProcsTable / TagGroups 点击查看）。 */
function procDetailData(p: ProcLike, tagLabel?: string): DetailData {
  const gpu = (p.gpuUtilPct !== undefined && p.gpuUtilPct !== null && !Number.isNaN(p.gpuUtilPct))
    ? p.gpuUtilPct
    : (p.gpu !== undefined && p.gpu !== null && !Number.isNaN(p.gpu) ? p.gpu : null)
  const stats: DetailStat[] = [
    { label: '进程 PID', value: String(p.pid) },
    { label: 'GPU 占用', value: gpu !== null ? Math.round(gpu) + '%' : '-', color: utilColor(gpu) },
    { label: 'CPU 占用', value: p.cpuPct !== null && p.cpuPct !== undefined ? Math.round(p.cpuPct) + '%' : '-', color: utilColor(p.cpuPct) },
    { label: '内存', value: fmtGiB(p.memMiB) + 'G' },
  ]
  return { title: '进程详情', sub: p.cmd || '未命名进程', cmd: p.cmd || null, stats, meta: tagLabel ? [{ label: '标签组', value: tagLabel }] : [] }
}

/** 实验/复盘详情数据（供 expBlock / EndedBlock 点击查看）。 */
function runDetailData(e: { runId: string; state: string; cmd?: string | null; startTs?: number; summary?: EndedView['summary'] }, kind: 'running' | 'ended'): DetailData {
  const s = e.summary || null
  const mins = e.startTs ? Math.max(0, Math.round((Date.now() - e.startTs) / 60000)) : null
  const dur = s && typeof s.durationSec === 'number'
    ? (s.durationSec < 60 ? s.durationSec + 's' : Math.round(s.durationSec / 60) + 'min')
    : (mins !== null ? mins + 'min' : '-')
  const stats: DetailStat[] = [
    { label: '状态', value: e.state || '-' },
    { label: '运行时长', value: dur },
    { label: 'GPU 峰值', value: s && typeof s.gpuUtilMax === 'number' ? s.gpuUtilMax + '%' : '-', color: s && typeof s.gpuUtilMax === 'number' ? utilColor(s.gpuUtilMax) : undefined },
    { label: 'GPU 均值', value: s && typeof s.gpuUtilAvg === 'number' ? s.gpuUtilAvg + '%' : '-' },
    { label: '显存峰值', value: s && typeof s.memPeak === 'number' ? fmtGiB(s.memPeak) + 'G' : '-' },
    { label: '组 CPU 峰值', value: s && typeof s.groupCpuMax === 'number' ? Math.round(s.groupCpuMax) + '%' : '-', color: s && typeof s.groupCpuMax === 'number' ? utilColor(s.groupCpuMax) : undefined },
  ]
  return { title: kind === 'ended' ? '实验复盘' : '实验详情', sub: e.runId, cmd: e.cmd || null, stats }
}

/** 全屏详情浮层：标题 + 指标栅格 + 元信息 + 完整命令（信息密度合理，零第三方依赖）。 */
function DetailOverlay(props: { detail: DetailData | null; onClose: () => void }): React.ReactElement | null {
  const d = props.detail
  if (!d) return null
  const cmdText = d.cmd && d.cmd.trim() ? d.cmd.trim() : null
  const closeBtn = { background: 'transparent', border: '1px solid ' + C.border, borderRadius: 6, color: C.label, fontSize: 12, padding: '2px 10px', cursor: 'pointer' }
  return React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '24px 16px', overflow: 'auto', background: 'rgba(0,0,0,0.45)' } },
    React.createElement('div', { onClick: props.onClose, style: { position: 'fixed', inset: 0 } }),
    React.createElement('div', { style: { position: 'relative', width: '100%', maxWidth: 640, background: C.layer1, color: C.label, border: '1px solid ' + C.border, borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.4)', padding: '16px 18px' } },
      // 标题行
      React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 } },
        React.createElement('span', { style: { fontWeight: 700, fontSize: 15 } }, d.title),
        d.sub ? React.createElement('span', { style: { fontSize: 12, color: C.label2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, d.sub) : null,
        React.createElement('button', { onClick: props.onClose, style: closeBtn }, '关闭'),
      ),
      // 指标栅格
      d.stats.length
        ? React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px 12px' } },
            d.stats.map((st) => React.createElement('div', { key: st.label, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              React.createElement('span', { style: { fontSize: 11, color: C.label2 } }, st.label),
              React.createElement('span', { style: { fontSize: 16, fontWeight: 700, color: st.color || C.label, fontVariantNumeric: 'tabular-nums' } }, st.value),
            )),
          )
        : null,
      // 元信息
      d.meta && d.meta.length
        ? React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 } },
            d.meta.map((m) => React.createElement('span', { key: m.label, style: { fontSize: 11, color: C.label2, padding: '2px 8px', borderRadius: 8, background: C.border } }, m.label + ': ' + m.value)))
        : null,
      // 完整命令
      cmdText
        ? React.createElement('div', { style: { marginTop: 14, borderTop: '1px solid ' + C.border, paddingTop: 12 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
              React.createElement('span', { style: { fontSize: 11, fontWeight: 700, color: C.label } }, '命令 / 脚本'),
              React.createElement('button', {
                onClick: () => { try { void navigator.clipboard.writeText(cmdText) } catch (e) { /* clip 不可用静默 */ } },
                style: { ...closeBtn, marginLeft: 'auto', fontSize: 11 },
              }, '复制'),
            ),
            React.createElement('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, lineHeight: 1.5, background: C.border, padding: '8px 10px', borderRadius: 6, color: C.label, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', maxHeight: 320, overflow: 'auto' } }, cmdText),
          )
        : null,
    ),
  )
}

// ----------------------------------------------------------------------------
// 设置面板（控制阈值/启停/清告警 + 标签管理 —— 从主面板迁到 DSH 设置页二次处理）
// ----------------------------------------------------------------------------
/** settings.section 组件：自行轮询快照（阈值事实来源 在 host），渲染控制 + 标签管理。 */
function SettingsPanel(): React.ReactElement {
  const [snap, setSnap] = React.useState<SnapView | null>(last && !(last as { error?: boolean }).error ? last : null)
  React.useEffect(() => {
    let alive = true
    const tick = () => { void refresh().then((s) => { if (alive) setSnap(s && !(s as { error?: boolean }).error ? (s as SnapView) : null) }) }
    void refresh().then((s) => { if (alive) setSnap(s && !(s as { error?: boolean }).error ? (s as SnapView) : null) })
    const dispose = ctxRef ? ctxRef.setInterval(tick, POLL_MS_CUR) : null
    return () => { alive = false; if (dispose) dispose() }
  }, [])
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    React.createElement('div', { key: 'intro', style: { fontSize: 12, color: C.label2 } },
      'Lab Monitor 的设置与标签规则：阈值立即生效并持久化（settings.yaml），标签按命令正则分组展示。'),
    React.createElement(ControlPanel, { snap }),
    React.createElement(TagManager, { tags: (snap && Array.isArray(snap.tags) ? snap.tags : []) as TagGroupView[] }),
  )
}

function MonitorPanel(props: { visible?: boolean; store?: unknown }) {
  const hidden = props && props.visible === false // 显式 false = tab 隐藏 → 30s 保活；undefined/true = 5s
  const store = props && props.store
  const [snap, setSnap] = React.useState<SnapView | null>(last && !(last as { error?: boolean }).error ? last : null)
  const [hist, setHist] = React.useState<HistPoint[] | null>(null) // 历史曲线点（history API 降采样 ≤500 点）
  const [detail, setDetail] = React.useState<DetailData | null>(null) // 详情展示页（点击查看）

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
      display: 'flex', flexDirection: 'column', gap: 12, padding: 14,
      fontSize: 13, color: C.label, minWidth: 320, boxSizing: 'border-box',
    },
  },
    // ── 状态行 ─────────────────────────────────────────────────────────────
    React.createElement('div', { style: { ...rowStyle, gap: 8 } },
      React.createElement('span', {
        style: { width: 9, height: 9, borderRadius: 5, background: connecting ? C.error : C.success, flexShrink: 0 },
      }),
      React.createElement('span', { style: { fontWeight: 700 } },
        connecting ? '连接中断，重试中…' : summaryLine(s as SnapView)),
      React.createElement('span', { style: { fontSize: 11, color: C.label2 }, title: '数据由 host 采样生成（快照时刻）' },
        s && s.ts ? '数据 ' + fmtTime(s.ts) : (lastFetchAt ? '更新于 ' + fmtTime(lastFetchAt) : '')),
      s && s.platform
        ? React.createElement('span', { style: { fontSize: 11, color: C.label2, padding: '1px 7px', borderRadius: 10, background: C.border } },
            s.platform + (s.sources && s.sources.gpu ? '·' + s.sources.gpu : ''))
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
    // ── 实验状态（2026-08-20 多轨：主实验 + 并行实验列表）────────────────────
    expBlock(s, setDetail),
    // ── 实验历史（2026-08-22 P1：已结束实验复盘，折叠展示 GPU 峰值摘要）────────
    s && Array.isArray(s.ended) && s.ended.length
      ? React.createElement(EndedBlock, { ended: s.ended, key: 'ended', onDetail: setDetail })
      : null,
    // ── 标签（2026-08-20：命中分组展示；管理区已迁到 DSH 设置页）──────────────
    s && Array.isArray(s.tags) && s.tags.length
      ? React.createElement(TagGroups, { tags: s.tags, key: 'tags', onDetail: setDetail })
      : null,
    // ── 进程表 ──────────────────────────────────────────────────────────────
    React.createElement(ProcsTable, { snap: s, key: 'procs', onDetail: setDetail }),
    // ── 告警列表（同 rule 合并计数 + 截断 + 可展开）──────────────────────────
    s && Array.isArray(s.alerts) && s.alerts.length
      ? React.createElement(AlertList, { alerts: s.alerts, key: 'alerts' })
      : null,
    // ── 详情展示页（点击命令/进程查看，全屏浮层）─────────────────────────────
    React.createElement(DetailOverlay, { detail, onClose: () => setDetail(null), key: 'detail' }),
  )
}

/** 出口 label thunk：O(1) 读 last，输出一行摘要；R-4 try/catch。 */
/** 出口 tab 标题（O(1) 读 last）：简洁名 + 关键告警计数，不再堆状态串。 */
function labelThunk(): string {
  try {
    if (!last) return 'GPU 监控'
    const c = (last as SnapView).alertsCriticalCount || 0
    return c ? 'GPU 监控（' + c + '）' : 'GPU 监控'
  } catch (e) {
    console.error('[lab-monitor] label thunk 错误:', e)
    return 'GPU 监控'
  }
}

// ----------------------------------------------------------------------------
// ③ better-sidebar 适配器（★最后增量 D-B2；docs/05 §3）
// ----------------------------------------------------------------------------

const SIDEBAR_TAB_ID = 'lab-monitor:gpu'

/** better-sidebar tab 图标：内联仪表盘/Gauge SVG（16px 描边 line-icon，与其它 tab 风格一致，零第三方依赖）。
 *  结构：外圈 270° 表盘弧 + 内圈刻度带 + 3 处刻度 + 指针 + 中心枢轴；内容占满 16px 盒（与默认 16px outline 图标匹配）。 */
function gpuTabIcon(size: number): React.ReactElement {
  const s = size || 16
  return React.createElement('svg', {
    width: s, height: s, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
  },
    // 外圈表盘弧（270°，底部开口，填充整盒）
    React.createElement('path', { d: 'M2 13.6 A7.3 7.3 0 1 1 14 13.6' }),
    // 内圈刻度带（同心 270° 弧）
    React.createElement('path', { d: 'M3.4 12.2 A6.1 6.1 0 1 1 12.6 12.2' }),
    // 刻度：顶部 + 左右 45°
    React.createElement('path', { d: 'M8 1.5 L8 3.1' }),
    React.createElement('path', { d: 'M13.16 4.28 L12.45 4.98' }),
    React.createElement('path', { d: 'M2.84 4.28 L3.55 4.98' }),
    // 指针（底中 → 右上）
    React.createElement('path', { d: 'M8 12.9 L11.4 6.3' }),
    // 中心枢轴点
    React.createElement('circle', { cx: 8, cy: 12.9, r: 1, fill: 'currentColor', stroke: 'none' }),
  )
}

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
      if (bs === null) {
        // cordis 服务可经 ctx.get 取；个别 client 组合里 provided 服务也以 ctx.betterSidebar 属性暴露（office 插件即此用法）。双通道取值。
        try { bs = ctx.get('betterSidebar') } catch (e) { bs = null }
        if (!bs) { try { bs = (ctx as unknown as { betterSidebar?: unknown }).betterSidebar } catch (e) { bs = null } }
      }
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
            icon: gpuTabIcon,
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
          // 默认打开：让 monitor 成为 better-sidebar 默认 tab（single:true 自带 dedupeKey，不会重复建/聚焦已开）
          try {
            const open = (bs as { openTab?: (seed: { type: string }) => void }).openTab
            if (open) open({ type: SIDEBAR_TAB_ID })
          } catch (e) {
            console.warn('[lab-monitor] 自动打开 GPU 监控 tab 失败（不影响注册）:', e)
          }
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
      // ②b settings.section：控制（阈值/启停/清告警）+ 标签管理 迁到 DSH 设置页二次处理
      try {
        slotsSvc.inject('settings.section', () =>
          slotsSvc.register(
            { name: 'settings.section', id: 'lab-monitor', order: 20, label: () => '监控设置' },
            SettingsPanel,
          ),
        )
      } catch (e) {
        console.error('[lab-monitor] settings.section 注册失败:', e)
      }
    } catch (e) {
      console.error('[lab-monitor] conversation.view 注册失败:', e)
    }
  } else {
    console.warn('[lab-monitor] slots 服务缺席，跳过 conversation.view 出口（Agent 通道① 兜底）')
  }
  // ③ better-sidebar 适配器（最后增量；双检查 + 重探，失败保持 ②）
  registerSidebarAdapter(ctx, () => disposeView)
}
