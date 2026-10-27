// ============================================================
// backend-windows-native.js —— WindowsNativeBackend（预留桩）
// 位置：plugin/host/sampler/backend-windows-native.js
// concat 顺序第 5（D4-1）；未来：纯 Windows 本机/远程场景
// ============================================================
// 同 SamplerBackend 接口（probe/snapshot/stream/close + cacheTtlMs + lastCpuTimes）；
// 当前仅预留桩：probe → { ok: false }，平台扩展位（t10 §3）。

var LAB = LAB || {}

LAB.WindowsNativeBackend = function WindowsNativeBackend(runner) {
  this.runner = runner
  this.id = 'windows-native'
  this.cacheTtlMs = 500
  this.lastCpuTimes = null
}

LAB.WindowsNativeBackend.prototype.probe = async function probe() {
  return { ok: false, reason: 'WindowsNativeBackend 未实现（预留桩，未来纯 Windows/远程场景）' }
}

LAB.WindowsNativeBackend.prototype.snapshot = async function snapshot() {
  return {
    ts: Date.now(),
    platform: 'windows-native',
    sources: { gpu: 'unavailable', cpu: null, mem: null, procs: null },
    cpu: { percent: null, cores: null },
    mem: { totalMiB: null, availableMiB: null },
    procs: [],
    degraded: { reason: 'not implemented' },
  }
}

LAB.WindowsNativeBackend.prototype.stream = function stream() { return null }

LAB.WindowsNativeBackend.prototype.close = async function close() {}
