import { LinuxBackend } from './backend-linux.js';
import { WindowsBackend } from './backend-windows.js';
import { WindowsNativeBackend } from './backend-windows-native.js';
/** 平台探测：#15 原生 Windows（process.platform==='win32'，无 /proc）→ 'windows-native'；
 *  否则 /proc/version 含 microsoft → 'wsl'；其余 'linux' */
export async function detectPlatform(runner) {
    // 原生 Windows：node 直接跑在 Windows（无 WSL interop），process.platform 可信
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof process !== 'undefined' && process.platform === 'win32') {
        return 'windows-native';
    }
    const r = await runner.exec('cat /proc/version 2>/dev/null | head -1');
    const v = (r.stdout || '') + ' ' + (r.stderr || '');
    if (/microsoft/i.test(v))
        return 'wsl';
    return 'linux';
}
/**
 * 平台分发：返回 { backend, platform }。
 * #14 backendMode 覆盖自动判定：
 *   auto（默认）= WSL→WindowsBackend、linux→LinuxBackend（现状）
 *   windows = 强制 WindowsBackend（WSL 或纯 Linux 上都试 Windows interop，失败由 probe 降级）
 *   linux   = 强制 LinuxBackend（WSL 下监控 WSL 内 Linux 进程，实验同 pid 空间）
 *   windows-native = 原生 Windows 后端（#15；当前为桩）
 */
export async function createBackend(runner, mode = 'auto') {
    if (mode === 'linux') {
        return { backend: new LinuxBackend(runner), platform: 'linux' };
    }
    if (mode === 'windows') {
        return { backend: new WindowsBackend(runner), platform: 'wsl' };
    }
    if (mode === 'windows-native') {
        return { backend: new WindowsNativeBackend(runner), platform: 'windows-native' };
    }
    // auto：按平台自动（现状）
    const platform = await detectPlatform(runner);
    if (platform === 'windows-native') {
        return { backend: new WindowsNativeBackend(runner), platform };
    }
    if (platform === 'wsl') {
        return { backend: new WindowsBackend(runner), platform };
    }
    return { backend: new LinuxBackend(runner), platform };
}
/** 快照聚合：backend.snapshot() 已输出规范化结构（含 ts/platform/sources）；上层直接消费 */
export async function collectSnapshot(backend) {
    return backend.snapshot();
}
export { LinuxBackend } from './backend-linux.js';
export { WindowsBackend } from './backend-windows.js';
export { WindowsNativeBackend } from './backend-windows-native.js';
export { SshRunner } from './runner-ssh.js';
/** probe 封装：后端可用性（上层启动时调用，失败只降级对应通道） */
export function probeBackend(backend) {
    return backend.probe();
}
// 导出后端类（外部测试/独立工具引用）
