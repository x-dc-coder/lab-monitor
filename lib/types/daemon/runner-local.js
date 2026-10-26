/**
 * 本地 Runner（child_process 实现 Runner 契约，src/sampler/backend-interface.ts）
 * - exec(cmdStr)：固定命令集（ps/nvidia-smi 探针等），经 /bin/sh -c 执行（命令串由 sampler 后端静态给出）
 * - execArgs/execArgsEnc：execFile 直执行，**绝不走 shell**
 * - spawnArgs：**不加 detached**（dmon 流子进程须随 daemon 可回收）；kill = SIGTERM → 1s 后 SIGKILL
 */
import { spawn, execFile } from 'node:child_process';
const EXEC_TIMEOUT_MS = 15000;
const MAX_BUFFER = 16 * 1024 * 1024;
function decode(buf, enc) {
    if (!enc)
        return buf.toString('utf8');
    try {
        return buf.toString(enc);
    }
    catch {
        return buf.toString('utf8');
    }
}
/** execFile 收尾（错误也 resolve，绝不 reject —— Runner 契约要求失败返回 code!=0） */
function runFile(file, args, enc) {
    return new Promise((resolve) => {
        let settled = false;
        const child = execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER, encoding: 'buffer' }, (err, stdout, stderr) => {
            if (settled)
                return;
            settled = true;
            const code = child.exitCode ?? child.signalCode ?? (err ? -1 : 0);
            resolve({ code: typeof code === 'number' ? code : -1, stdout: decode(stdout, enc), stderr: decode(stderr, enc) });
        });
        child.on('error', () => {
            if (settled)
                return;
            settled = true;
            resolve({ code: -1, stdout: '', stderr: 'spawn failed: ' + file });
        });
    });
}
export function createLocalRunner() {
    return {
        async exec(cmdStr) {
            return new Promise((resolve) => {
                let settled = false;
                const child = spawn('/bin/sh', ['-c', cmdStr], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
                const out = [];
                const err = [];
                child.stdout.on('data', (c) => out.push(c));
                child.stderr.on('data', (c) => err.push(c));
                const timer = setTimeout(() => {
                    try {
                        child.kill('SIGKILL');
                    }
                    catch { /* 已退出 */ }
                }, EXEC_TIMEOUT_MS);
                child.on('error', (e) => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    resolve({ code: -1, stdout: '', stderr: String(e && e.message ? e.message : e) });
                });
                child.on('close', (code) => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    resolve({ code: code === null ? -1 : code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
                });
            });
        },
        execArgs(file, args) {
            return runFile(file, args);
        },
        execArgsEnc(file, args, enc) {
            return runFile(file, args, enc);
        },
        spawnArgs(file, args) {
            // 不加 detached：dmon 流子进程挂在 daemon 进程组下，daemon 退出即可回收
            const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            let output = '';
            let done = false;
            child.stdout.on('data', (c) => { output += c.toString('utf8'); });
            child.on('error', () => { });
            child.on('exit', () => { done = true; });
            return {
                pid: typeof child.pid === 'number' ? child.pid : null,
                readOutput() {
                    // 排空语义：调用方（streamIterator readLine）按 `buf += readOutput()` 增量拼接；
                    // 若不排空，buf 每拍重吃全量历史 → 二次方增长直到卡死事件循环（2026-10-27 冒烟实证）
                    const s = output;
                    output = '';
                    return s;
                },
                done() {
                    return done;
                },
                kill() {
                    if (child.exitCode !== null)
                        return;
                    try {
                        child.kill('SIGTERM');
                    }
                    catch { /* 已退出 */ }
                    setTimeout(() => {
                        try {
                            if (child.exitCode === null)
                                child.kill('SIGKILL');
                        }
                        catch { /* 已退出 */ }
                    }, 1000);
                },
            };
        },
        async sleep(ms) {
            await new Promise((resolve) => setTimeout(resolve, ms));
        },
    };
}
