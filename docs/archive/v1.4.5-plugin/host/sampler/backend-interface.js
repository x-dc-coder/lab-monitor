// ============================================================
// backend-interface.js —— SamplerBackend 契约（JSDoc）
// 位置：plugin/host/sampler/backend-interface.js
// concat 顺序第 1（D4-1）；本文件只声明契约文档与共享命名空间
// ============================================================
// 契约要点（详细见 docs/02-data-model.md §2 与 t10 §2）：
// 一个平台采样后端的统一契约。后端 = "一个平台的全部采样通道的组合"。
// 上层（ring/state/balancer/rpc/tools/UI）不感知平台差异，只消费规范化快照。
//
// 方法集（netdata 五方法映射）：
//   probe():    Promise<{ok, reason?, detail?}>   —— 环境探测（= Check），绝不抛错
//   snapshot(): Promise<快照>                     —— 一次性全量采样（= Collect）
//   stream():   AsyncIterable<{ts, raw}> | null   —— 长驻增量流（GPU dmon 行流）
//   close():    Promise<void>                     —— 释放资源（杀 interop 子进程，幂等）
// 字段：
//   id: 'linux' | 'wsl' | 'windows-native'
//   cacheTtlMs: 内部查询缓存 TTL（ms）
//   lastCpuTimes: CPU 差分基线 {idle, total, at}（首帧丢弃、负值截 0——psutil 算法）
//
// 快照结构（规范化，协议见 docs/03-protocol.md §2.1）：
//   { ts, platform, sources: {gpu?, cpu, mem, procs},
//     gpu?: [{id, name?, utilPct, memUsedMiB, memTotalMiB, tempC?, powerW?}],
//     cpu: {percent, cores?}, mem: {totalMiB, availableMiB},
//     procs: [{pid, cmd, cpuPct?, memMiB?}], degraded?: {gpu?, reason?} }
//
// Runner 注入（平台通道适配，解耦 shell 服务；v1.4.1 D1-1 职责分离）：
//   exec(cmdStr)                → Promise<{code, stdout, stderr}>   （shell 形式，Linux 通道）
//   execArgs(file, args)        → Promise<{code, stdout, stderr}>   （argv 形式，interop 通道）
//   execArgsEnc(file, args, enc)→ Promise<{code, stdout, stderr}>   （argv + 编码转码，GBK→UTF8）
//   spawnArgs(file, args)       → {pid, readOutput(), done(), kill()}（长驻进程，dmon 流）
//   sleep(ms)                   → Promise<void>                      （沙箱内无全局 setTimeout，统一用 runner 延迟）
//   cordis 环境由主 index.js 用 ctx.shell 适配；独立测试用 node child_process 适配
//   （scripts/verify-sampler.js 内实现）。

var LAB = LAB || {}
LAB.SamplerBackend = {
  name: 'SamplerBackend',
  methods: ['probe', 'snapshot', 'stream', 'close'],
  fields: ['id', 'cacheTtlMs', 'lastCpuTimes'],
}
