#!/usr/bin/env node
/**
 * verify-win-native.js — 原生 Windows 后端（windows-native）安全修复验证
 * 2026-10-22 崩溃复盘：DSH 桌面端（原生 Windows）启用插件即整体崩溃——
 *   spawn('/mnt/c/.../nvidia-smi.exe') ENOENT（WSL interop 路径跑在原生 Windows）
 *   且 spawn 未挂 error 监听 → Node 未捕获异常打崩宿主。
 * 本脚本跨平台（WSL/Linux 上即可跑）验证：
 *   ① toWinPath 路径翻译
 *   ② probe 全通道结构化降级（Windows 命令不存在 → ok:false + reason，不抛异常）
 *   ③ snapshot 结构化降级（platform 正确标注 windows-native）
 *   ④ dmon 流 spawn 持续失败 → restarts 计数生效 → ≤3 轮退避后 fallbackMode 收敛
 *      （金丝雀：若 spawn error 监听回归缺失，未捕获异常会直接崩掉本进程 → 本脚本非零退出）
 */
import { WindowsNativeBackend } from '../lib/types/sampler/backend-windows-native.js'
import { toWinPath } from '../lib/types/sampler/windows-paths.js'

let fail = 0
const ok = (cond, name) => { if (cond) console.log('  ✓', name); else { fail++; console.error('  ✗', name) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── ① toWinPath ──────────────────────────────────────────────────────────────
ok(toWinPath('/mnt/c/Windows/System32/nvidia-smi.exe') === 'C:\\Windows\\System32\\nvidia-smi.exe',
  'toWinPath /mnt/c/... → C:\\...（系统盘）')
ok(toWinPath('/mnt/d/data/train/model.py') === 'D:\\data\\train\\model.py',
  'toWinPath /mnt/d/... → D:\\...（非系统盘）')
ok(toWinPath('/mnt/e/x') === 'E:\\x', 'toWinPath 单段路径 → E:\\x')
ok(toWinPath('/home/dc/x') === '/home/dc/x', 'toWinPath 非 /mnt/ 前缀原样返回')
ok(toWinPath('C:\\already\\win') === 'C:\\already\\win', 'toWinPath 已是 Windows 形式原样返回')
ok(toWinPath('/mnt/c') === '/mnt/c', 'toWinPath /mnt/c（无尾段）原样返回')

// ── ② ③ WindowsNativeBackend 全通道结构化降级 ────────────────────────────────
const backend = new WindowsNativeBackend(null) // runner 参数被忽略（内部 localWinRunner）

const probe = await backend.probe()
ok(probe && typeof probe.ok === 'boolean', 'probe → 结构化 ProbeResult（不抛异常）')
if (process.platform !== 'win32') {
  // WSL/Linux 上翻译出的 C:\... 不存在 → 三通道全降级
  ok(probe.ok === false, '非 Windows 平台 probe.ok=false（优雅降级）')
  ok(typeof probe.reason === 'string' && probe.reason.length > 0, 'probe.reason 可读：' + String(probe.reason).slice(0, 70))
}

const snap = await backend.snapshot()
ok(snap && typeof snap === 'object', 'snapshot → 结构化对象（不抛异常）')
ok(snap.platform === 'windows-native', 'snapshot.platform 标注 windows-native')

// ── ④ dmon 流 spawn 失败 → 有限退避收敛 ─────────────────────────────────────
// restarts 修复前：计数器从不自增 → 每 ~500ms 无限重试；修复后：1s/2s/4s 三轮退避 → fallbackMode → 流结束
const t0 = Date.now()
const stream = backend.stream()
const it = stream[Symbol.asyncIterator]()
const race = await Promise.race([
  (async () => { await it.next() })().then(() => 'done').catch(() => 'error'),
  sleep(20000).then(() => 'timeout'),
])
const elapsed = Date.now() - t0
ok(race === 'done', 'dmon 流 spawn 失败 → 有限退避后流收敛（' + (elapsed / 1000).toFixed(1) + 's）')
ok(elapsed < 20000, '流收敛耗时 < 20s（退避上限内，非无限重试）')
try { await it.return?.() } catch (e) { /* ignore */ }
await backend.close()

console.log(fail ? '❌ ' + fail + ' 个失败' : '✅ verify-win-native 全部通过')
process.exit(fail ? 1 : 0)
