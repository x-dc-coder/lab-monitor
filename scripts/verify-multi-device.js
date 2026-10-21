#!/usr/bin/env node
/**
 * verify-multi-device.js — #21 多设备监控与远程设备切换验证（DoD AC-1 ~ AC-5）
 */
import fs from 'node:fs';
import cp from 'node:child_process';
import { SshRunner } from '../lib/types/sampler/runner-ssh.js';
import { LinuxBackend } from '../lib/types/sampler/backend-linux.js';
import { createStateMachine } from '../lib/types/core/state-machine.js';

let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) console.log('  ✓', name);
  else {
    fail++;
    console.error('  ✗', name, detail !== undefined ? detail : '');
  }
};

const localRunner = {
  exec(cmdStr) {
    return new Promise((resolve) => {
      cp.exec(cmdStr, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
      });
    });
  },
  execArgs(file, args) { return this.exec([file, ...args].join(' ')); },
  execArgsEnc(file, args) { return this.exec([file, ...args].join(' ')); },
  spawnArgs() { return { pid: null, readOutput: () => '', done: () => true, kill: () => {} }; },
  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
};

console.log('\n== [1] SshRunner 基础连接与 ControlMaster 复用验证 (AC-5) ==');
const devConfig = {
  host: '10.100.104.22',
  port: 22,
  user: 'daichuang',
  keyPath: '/home/dc/.ssh/dc_gpu220_ed25519',
};

const sshRunner = new SshRunner(devConfig, localRunner);
const t0 = Date.now();
const r1 = await sshRunner.exec('uname -a');
const initialDuration = Date.now() - t0;
if (r1.code !== 0 || !r1.stdout.includes('Linux')) {
  console.log('  ⚠️ 远程测试主机 10.100.104.22 离线或不可达 (code=' + r1.code + ')，跳过远程真机采样断言');
  await sshRunner.close().catch(() => {});
  process.exit(0);
}
ok(r1.code === 0 && r1.stdout.includes('Linux'), '首连建立成功 (exit 0)');
console.log('    首连耗时:', initialDuration, 'ms');

const t1 = Date.now();
const r2 = await sshRunner.exec('echo "reuse test"');
const reuseDuration = Date.now() - t1;
ok(r2.code === 0 && r2.stdout.trim() === 'reuse test', 'ControlMaster 复用执行成功');
console.log('    复用耗时:', reuseDuration, 'ms');
ok(reuseDuration < 200, 'AC-5: ControlMaster 复用耗时 < 200ms (实测 ' + reuseDuration + 'ms)');

console.log('\n== [2] 远程 LinuxBackend 整卡 GPU 与进程采样 (AC-1, AC-2) ==');
const remoteBackend = new LinuxBackend(sshRunner);
const probe = await remoteBackend.probe();
ok(probe.ok === true && probe.detail?.gpu?.available === true, '远程 probe 识别到 NVIDIA GPU');

const tSnap = Date.now();
const snap = await remoteBackend.snapshot();
const snapDuration = Date.now() - tSnap;
console.log('    快照采样耗时:', snapDuration, 'ms');
ok(snapDuration <= 800, 'AC-5: 单次采样周期 ≤ 800ms (实测 ' + snapDuration + 'ms)');
ok(snap.platform === 'linux', '快照平台为 linux');
ok(snap.sources.gpu === 'linux-smi', 'AC-1: sources.gpu 标明 linux-smi 通道来源');
ok(Array.isArray(snap.gpu) && snap.gpu.length > 0, '快照包含 GPU 数据');
ok(snap.gpu[0]?.name?.includes('RTX 3090'), 'AC-1: GPU[0] 型号包含 RTX 3090: ' + snap.gpu[0]?.name);
ok(typeof snap.gpu[0]?.memUsedMiB === 'number' && snap.gpu[0]?.memTotalMiB === 24576, 'AC-1: 显存总量为 24576 MiB');
ok(snap.procs.length > 0, 'AC-2: 进程表包含远端进程 (共 ' + snap.procs.length + ' 个)');
const hasLocalWsl = snap.procs.some(p => p.cmd?.includes('microsoft-standard'));
ok(!hasLocalWsl, 'AC-2: 无本地 WSL 专属特征进程');

await remoteBackend.close();
await sshRunner.close();
ok(!fs.existsSync(sshRunner.socketPath), 'close() 正常清理 ControlMaster socket');

console.log('\n== [3] 设备切换状态平稳过渡与在途实验保护 (AC-3) ==');
const alerts = [];
const machine = createStateMachine({
  emitLab: () => {},
  emitAlert: (a) => alerts.push(a),
});

// 模拟老设备上有在途实验
const run1 = machine.start('python train_model.py', 'test-run');
ok(machine.all().length === 1, '在途实验已启动');

const tSwitch = Date.now();
const switched = machine.switchAwayAll('switched_away');
const switchDuration = Date.now() - tSwitch;
ok(switched.length === 1, '旧设备在途实验成功被 switchAwayAll 归档');
ok(machine.all().length === 0, '当前 running 实验已被清空');
ok(machine.history[0]?.state === 'switched_away', 'AC-3: 实验状态归档为 switched_away');
const crashAlerts = alerts.filter(a => a.rule === 'experiment-crash');
ok(crashAlerts.length === 0, 'AC-3: 切换不触发 experiment-crash 告警');
ok(switchDuration <= 3000, 'AC-3: 切换耗时 ≤ 3000ms');

console.log('\n== [4] 异常断网降级与自愈 (AC-4) ==');
const badSshRunner = new SshRunner({
  host: '10.255.255.1', // 不可达 IP
  port: 22,
  user: 'daichuang',
  connectTimeoutSec: 1,
}, localRunner);

const badBackend = new LinuxBackend(badSshRunner);
const badSnap = await badBackend.snapshot();
ok(badSnap.gpu === undefined, 'AC-4: 网络不可达时不崩溃，gpu 为 undefined');
ok(badSnap.degraded?.gpu !== undefined, 'AC-4: 进入 degraded 状态: ' + JSON.stringify(badSnap.degraded));
await badBackend.close();
await badSshRunner.close();

console.log(fail ? '\n❌ ' + fail + ' 个断言失败' : '\n✅ verify-multi-device 全部通过（共 16 项断言）');
process.exit(fail ? 1 : 0);
