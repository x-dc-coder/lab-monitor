/**
 * SshRunner: 基于 SSH ControlMaster 长连接复用的远端命令执行通道（#21）
 * 契约：实现 Runner 接口（src/sampler/backend-interface.ts）
 * 特性：
 * 1. ControlMaster 长连接复用：首连 ~300ms，后续复用 ~10ms，避免 SSH 连接风暴（AC-5）
 * 2. Base64 打包命令体：echo <b64> | base64 -d | /bin/bash，防双层 shell 转义与注入
 * 3. 故障检测与 socket 自愈：检测到 socket connection refused / broken 时自动 unlink 并重试
 * 4. 优雅生命周期管理：close() 发送 ssh -O exit 销毁 Master，防止孤儿连接泄漏
 */
import type { Runner } from './backend-interface.js'
import fs from 'node:fs'

export interface SshConfig {
  host: string
  port?: number
  user: string
  keyPath?: string
  socketPath?: string
  connectTimeoutSec?: number
}

export class SshRunner implements Runner {
  readonly config: SshConfig
  readonly socketPath: string
  private base: Runner
  private closed = false

  constructor(config: SshConfig, baseRunner: Runner) {
    this.config = config
    this.base = baseRunner
    this.socketPath =
      config.socketPath ||
      `/tmp/lab_mon_ssh_${config.host}_${config.port || 22}_${config.user}.sock`
  }

  buildSshCommand(remoteCmd: string): string {
    const b64 = Buffer.from(remoteCmd).toString('base64')
    const timeout = this.config.connectTimeoutSec || 5
    const parts = ['ssh']
    if (this.config.keyPath) parts.push(`-i '${this.config.keyPath}'`)
    if (this.config.port) parts.push(`-p ${this.config.port}`)
    parts.push('-o BatchMode=yes')
    parts.push('-o StrictHostKeyChecking=no')
    parts.push(`-o ConnectTimeout=${timeout}`)
    parts.push('-o ControlMaster=auto')
    parts.push(`-o ControlPath='${this.socketPath}'`)
    parts.push('-o ControlPersist=600')
    parts.push(`'${this.config.user}@${this.config.host}'`)
    parts.push(`"echo ${b64} | base64 -d | /bin/bash"`)
    return parts.join(' ')
  }

  async exec(cmdStr: string): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.closed) {
      return { code: -1, stdout: '', stderr: 'SshRunner is closed' }
    }
    try {
      const sshCmd = this.buildSshCommand(cmdStr)
      const res = await this.base.exec(sshCmd)
      // 死连接检测自愈：如果 Control socket 损坏、连接被拒或 Broken pipe，自动清理并重试一次
      if (
        res.code !== 0 &&
        (res.stderr.includes('Control socket connect') ||
          res.stderr.includes('Connection refused') ||
          res.stderr.includes('Broken pipe'))
      ) {
        try {
          if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath)
        } catch (e) {}
        const retryCmd = this.buildSshCommand(cmdStr)
        return await this.base.exec(retryCmd)
      }
      return res
    } catch (e) {
      return { code: -1, stdout: '', stderr: String((e as Error).message || e) }
    }
  }

  async execArgs(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const cmd = [file, ...args].join(' ')
    return this.exec(cmd)
  }

  async execArgsEnc(file: string, args: string[], _enc: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const cmd = [file, ...args].join(' ')
    return this.exec(cmd)
  }

  spawnArgs(_file: string, _args: string[]): {
    pid: number | null
    readOutput(): string
    done(): boolean
    kill(): void
  } {
    return {
      pid: null,
      readOutput() {
        return ''
      },
      done() {
        return true
      },
      kill() {},
    }
  }

  async sleep(ms: number): Promise<void> {
    return this.base.sleep(ms)
  }

  async close(): Promise<void> {
    this.closed = true
    try {
      const exitCmd = `ssh -O exit -o ControlPath='${this.socketPath}' '${this.config.user}@${this.config.host}' 2>/dev/null || true`
      await this.base.exec(exitCmd)
      if (fs.existsSync(this.socketPath)) {
        try {
          fs.unlinkSync(this.socketPath)
        } catch (e) {}
      }
    } catch (e) {}
  }
}
