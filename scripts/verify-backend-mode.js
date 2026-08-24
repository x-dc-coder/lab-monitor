#!/usr/bin/env node
/**
 * verify-backend-mode.js — #14 监控目标切换逻辑验证（不依赖 DSH）
 * 验证 createBackend 四态分发：auto(WSL→windows) / auto(linux→linux) / 强制 windows / 强制 linux
 */
import { createBackend } from '../lib/types/sampler/index.js'

let fail = 0
const ok = (cond, name) => { if (cond) console.log('  ✓', name); else { fail++; console.error('  ✗', name) } }

// mock runner：/proc/version 可注入（模拟 WSL / 纯 Linux）
function makeRunner(version) {
  return {
    async exec(cmd) {
      if (cmd.includes('/proc/version')) return { code: 0, stdout: version, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

// ① auto + WSL /proc → WindowsBackend
let r = await createBackend(makeRunner('Linux version 6.6.87.2-microsoft-standard-WSL2'), 'auto')
ok(r.platform === 'wsl' && r.backend.id === 'wsl', 'auto+WSL → windows backend')

// ② auto + 纯 Linux /proc → LinuxBackend
r = await createBackend(makeRunner('Linux version 6.8.0-45-generic'), 'auto')
ok(r.platform === 'linux' && r.backend.id === 'linux', 'auto+纯Linux → linux backend')

// ③ 强制 linux（即使 WSL /proc）→ LinuxBackend
r = await createBackend(makeRunner('Linux version 6.6.87.2-microsoft-standard-WSL2'), 'linux')
ok(r.platform === 'linux' && r.backend.id === 'linux', '强制 linux（WSL 下）→ linux backend')

// ④ 强制 windows（即使纯 Linux /proc）→ WindowsBackend（probe 会降级，分发仍 windows）
r = await createBackend(makeRunner('Linux version 6.8.0-45-generic'), 'windows')
ok(r.platform === 'wsl' && r.backend.id === 'wsl', '强制 windows（纯Linux下）→ windows backend')

// ⑤ 强制 windows-native → 桩 backend（#15 未实现前）
r = await createBackend(makeRunner('Linux version 6.8.0-45-generic'), 'windows-native')
ok(r.platform === 'windows-native' && r.backend.id === 'windows-native', 'windows-native → 委托 backend（#15 实现）')

// ⑥ 默认参数 = auto
r = await createBackend(makeRunner('Linux version 6.6.87.2-microsoft-standard-WSL2'))
ok(r.platform === 'wsl' && r.backend.id === 'wsl', '默认参数=auto → WSL windows backend')

// ⑦ #15：强制 windows-native → 委托实现（probe 走 WindowsBackend 通道，失败降级而非 not implemented）
r = await createBackend(makeRunner('Linux version 6.8.0-45-generic'), 'windows-native')
ok(r.platform === 'windows-native' && r.backend.id === 'windows-native', 'windows-native → 委托 WindowsBackend（非桩）')
const probeNative = await r.backend.probe()
// probe 返回结构化结果（不抛异常、非 not implemented 桩）；本机 WSL 可访问 Windows 命令 → ok
ok(probeNative && typeof probeNative.ok === 'boolean' && probeNative.reason !== 'WindowsNativeBackend 未实现',
  'windows-native probe → 结构化结果（委托 WindowsBackend，非桩）')

console.log(fail ? '❌ ' + fail + ' 个失败' : '✅ verify-backend-mode 全部通过（' + 8 + ' 断言）')
process.exit(fail ? 1 : 0)
