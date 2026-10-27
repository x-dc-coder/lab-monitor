// ============================================================
// index.js —— 平台探测与分发（sampler 唯一入口）
// 位置：plugin/host/sampler/index.js
// concat 顺序第 6（D4-1，最后）；上层只依赖本文件三个函数
// ============================================================
// v1.4.1（D1-1）职责分离：平台判定只看 /proc/version 含 microsoft → 'wsl'；
// interop 可用性不参与平台判定，由 WindowsBackend.probe() 驱动通道级降级。

var LAB = LAB || {}

// 平台探测：/proc/version 含 microsoft → 'wsl'；否则纯 Linux
LAB.detectPlatform = async function detectPlatform(runner) {
  var r = await runner.exec('cat /proc/version 2>/dev/null | head -1')
  var v = (r.stdout || '') + ' ' + (r.stderr || '')
  if (/microsoft/i.test(v)) return 'wsl'
  return 'linux'
}

// 平台分发：返回 { backend, platform }
LAB.createBackend = async function createBackend(runner) {
  var platform = await LAB.detectPlatform(runner)
  if (platform === 'wsl') {
    return { backend: new LAB.WindowsBackend(runner), platform: platform }
  }
  return { backend: new LAB.LinuxBackend(runner), platform: platform }
}

// 快照聚合：backend.snapshot() 已输出规范化结构（含 ts/platform/sources）；
// 上层（ring buffer / rpc.snapshot）直接消费，不再二次加工
LAB.collectSnapshot = async function collectSnapshot(backend) {
  return backend.snapshot()
}

// probe 封装：后端可用性（上层启动时调用，失败只降级对应通道）
LAB.probeBackend = async function probeBackend(backend) {
  return backend.probe()
}
