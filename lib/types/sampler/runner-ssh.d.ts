/**
 * SshRunner: 基于 SSH ControlMaster 长连接复用的远端命令执行通道（#21）
 * 契约：实现 Runner 接口（src/sampler/backend-interface.ts）
 * 特性：
 * 1. ControlMaster 长连接复用：首连 ~300ms，后续复用 ~10ms，避免 SSH 连接风暴（AC-5）
 * 2. Base64 打包命令体：echo <b64> | base64 -d | /bin/bash，防双层 shell 转义与注入
 * 3. 故障检测与 socket 自愈：检测到 socket connection refused / broken 时自动 unlink 并重试
 * 4. 优雅生命周期管理：close() 发送 ssh -O exit 销毁 Master，防止孤儿连接泄漏
 */
import type { Runner } from './backend-interface.js';
export interface SshConfig {
    host: string;
    port?: number;
    user: string;
    keyPath?: string;
    socketPath?: string;
    connectTimeoutSec?: number;
}
export declare class SshRunner implements Runner {
    readonly config: SshConfig;
    readonly socketPath: string;
    private base;
    private closed;
    constructor(config: SshConfig, baseRunner: Runner);
    buildSshCommand(remoteCmd: string): string;
    exec(cmdStr: string): Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
    execArgs(file: string, args: string[]): Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
    execArgsEnc(file: string, args: string[], _enc: string): Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
    spawnArgs(_file: string, _args: string[]): {
        pid: number | null;
        readOutput(): string;
        done(): boolean;
        kill(): void;
    };
    sleep(ms: number): Promise<void>;
    close(): Promise<void>;
}
