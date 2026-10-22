import fs from 'node:fs';
export class SshRunner {
    config;
    socketPath;
    base;
    closed = false;
    constructor(config, baseRunner) {
        this.config = config;
        this.base = baseRunner;
        this.socketPath =
            config.socketPath ||
                `/tmp/lab_mon_ssh_${config.host}_${config.port || 22}_${config.user}.sock`;
    }
    buildSshCommand(remoteCmd) {
        const b64 = Buffer.from(remoteCmd).toString('base64');
        const timeout = this.config.connectTimeoutSec || 5;
        const parts = ['ssh'];
        if (this.config.keyPath)
            parts.push(`-i '${this.config.keyPath}'`);
        if (this.config.port)
            parts.push(`-p ${this.config.port}`);
        parts.push('-o BatchMode=yes');
        parts.push('-o StrictHostKeyChecking=no');
        parts.push(`-o ConnectTimeout=${timeout}`);
        parts.push('-o ControlMaster=auto');
        parts.push(`-o ControlPath='${this.socketPath}'`);
        parts.push('-o ControlPersist=600');
        parts.push(`'${this.config.user}@${this.config.host}'`);
        parts.push(`"echo ${b64} | base64 -d | /bin/bash"`);
        return parts.join(' ');
    }
    async exec(cmdStr) {
        if (this.closed) {
            return { code: -1, stdout: '', stderr: 'SshRunner is closed' };
        }
        try {
            const sshCmd = this.buildSshCommand(cmdStr);
            const res = await this.base.exec(sshCmd);
            // 死连接检测自愈：如果 Control socket 损坏、连接被拒或 Broken pipe，自动清理并重试一次
            if (res.code !== 0 &&
                (res.stderr.includes('Control socket connect') ||
                    res.stderr.includes('Connection refused') ||
                    res.stderr.includes('Broken pipe'))) {
                try {
                    if (fs.existsSync(this.socketPath))
                        fs.unlinkSync(this.socketPath);
                }
                catch (e) { }
                const retryCmd = this.buildSshCommand(cmdStr);
                return await this.base.exec(retryCmd);
            }
            return res;
        }
        catch (e) {
            return { code: -1, stdout: '', stderr: String(e.message || e) };
        }
    }
    async execArgs(file, args) {
        const cmd = [file, ...args].join(' ');
        return this.exec(cmd);
    }
    async execArgsEnc(file, args, _enc) {
        const cmd = [file, ...args].join(' ');
        return this.exec(cmd);
    }
    spawnArgs(_file, _args) {
        return {
            pid: null,
            readOutput() {
                return '';
            },
            done() {
                return true;
            },
            kill() { },
        };
    }
    async sleep(ms) {
        return this.base.sleep(ms);
    }
    async close() {
        this.closed = true;
        try {
            const exitCmd = `ssh -O exit -o ControlPath='${this.socketPath}' '${this.config.user}@${this.config.host}' 2>/dev/null || true`;
            await this.base.exec(exitCmd);
            if (fs.existsSync(this.socketPath)) {
                try {
                    fs.unlinkSync(this.socketPath);
                }
                catch (e) { }
            }
        }
        catch (e) { }
    }
}
