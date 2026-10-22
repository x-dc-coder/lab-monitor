/**
 * 平台探测与分发（sampler 唯一入口）
 * v1.4.1（D1-1）职责分离：平台判定只看 /proc/version 含 microsoft → 'wsl'；
 * interop 可用性不参与平台判定，由 WindowsBackend.probe() 驱动通道级降级。
 * #14（2026-08-24）：backendMode 配置——WSL 下可强制切换监控目标（windows/linux）。
 */
import type { Runner, SamplerBackend } from './backend-interface.js';
/** #14 监控目标模式：auto=按平台自动（WSL→windows）；windows/linux=强制指定 */
export type BackendMode = 'auto' | 'windows' | 'linux' | 'windows-native';
/** 平台探测：#15 原生 Windows（process.platform==='win32'，无 /proc）→ 'windows-native'；
 *  否则 /proc/version 含 microsoft → 'wsl'；其余 'linux' */
export declare function detectPlatform(runner: Runner): Promise<string>;
/**
 * 平台分发：返回 { backend, platform }。
 * #14 backendMode 覆盖自动判定：
 *   auto（默认）= WSL→WindowsBackend、linux→LinuxBackend（现状）
 *   windows = 强制 WindowsBackend（WSL 或纯 Linux 上都试 Windows interop，失败由 probe 降级）
 *   linux   = 强制 LinuxBackend（WSL 下监控 WSL 内 Linux 进程，实验同 pid 空间）
 *   windows-native = 原生 Windows 后端（#15；当前为桩）
 */
export declare function createBackend(runner: Runner, mode?: BackendMode): Promise<{
    backend: SamplerBackend;
    platform: string;
}>;
/** 快照聚合：backend.snapshot() 已输出规范化结构（含 ts/platform/sources）；上层直接消费 */
export declare function collectSnapshot(backend: SamplerBackend): Promise<Awaited<ReturnType<SamplerBackend['snapshot']>>>;
export { LinuxBackend } from './backend-linux.js';
export { WindowsBackend } from './backend-windows.js';
export { WindowsNativeBackend } from './backend-windows-native.js';
export { SshRunner, type SshConfig } from './runner-ssh.js';
/** probe 封装：后端可用性（上层启动时调用，失败只降级对应通道） */
export declare function probeBackend(backend: SamplerBackend): Promise<{
    ok: boolean;
    reason?: string;
    detail?: Record<string, unknown>;
}>;
