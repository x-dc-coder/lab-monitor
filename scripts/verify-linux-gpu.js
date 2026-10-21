#!/usr/bin/env node
/**
 * verify-linux-gpu.js — #22 LinuxBackend 整卡 GPU 采集与降级验证
 * 覆盖：
 * 1. 有 GPU 模拟（7 列 CSV 解析、多卡解析、快慢通道解耦）
 * 2. 无 GPU / 纯 Linux 降级（degraded.gpu 标记、不抛错、跳过 pmon）
 * 3. TTL 缓存复用（短时间内不重复 fork）
 */
import { LinuxBackend } from '../lib/types/sampler/backend-linux.js';

let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) console.log('  ✓', name);
  else {
    fail++;
    console.error('  ✗', name, detail !== undefined ? detail : '');
  }
};

// 1. 测试有 GPU（两张卡，含单位后缀与 \r）
const mockGpuRunner = {
  calls: [],
  async exec(cmd) {
    this.calls.push(cmd);
    if (cmd.includes('/proc/version')) {
      return { code: 0, stdout: 'Linux version 6.8.0-generic', stderr: '' };
    }
    if (cmd.includes('/proc/meminfo')) {
      return { code: 0, stdout: 'MemTotal: 16384000 kB\nMemAvailable: 8192000 kB\n', stderr: '' };
    }
    if (cmd.includes('/proc/stat')) {
      return { code: 0, stdout: 'cpu  1000 200 300 5000 100 0 0 0 0 0\n', stderr: '' };
    }
    if (cmd.includes('ps -eo')) {
      return { code: 0, stdout: '  101     1  1.5  204800  120  python train.py\n', stderr: '' };
    }
    if (cmd.includes('driver_version,count')) {
      return { code: 0, stdout: '535.129.03, 2\n', stderr: '' };
    }
    if (cmd.includes('--query-gpu=index,name')) {
      return {
        code: 0,
        stdout:
          '0, NVIDIA GeForce RTX 3090, 85 %, 22000 MiB, 24576 MiB, 68, 280.5 W\r\n' +
          '1, NVIDIA GeForce RTX 3090, 10 %, 1024 MiB, 24576 MiB, 42, 35.0 W\r\n',
        stderr: '',
      };
    }
    if (cmd.includes('pmon')) {
      return {
        code: 0,
        stdout: '# pid type sm mem enc dec command\n  101 C 85 40 0 0 python\n',
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  },
};

const linuxWithGpu = new LinuxBackend(mockGpuRunner);
const probeWithGpu = await linuxWithGpu.probe();
ok(probeWithGpu.ok === true, 'LinuxBackend probe 成功');
ok(probeWithGpu.detail?.gpu?.available === true, 'probe 识别 GPU 可用');
ok(probeWithGpu.detail?.gpu?.count === 2, 'probe 识别 GPU 卡数为 2');

const snap1 = await linuxWithGpu.snapshot();
ok(snap1.platform === 'linux', '快照平台为 linux');
ok(snap1.sources.gpu === 'linux-smi', 'sources.gpu 标为 linux-smi');
ok(Array.isArray(snap1.gpu) && snap1.gpu.length === 2, '整卡 GPU 列表长度为 2');
ok(snap1.gpu[0].name === 'NVIDIA GeForce RTX 3090', 'GPU0 名称正确');
ok(snap1.gpu[0].utilPct === 85 && snap1.gpu[0].memUsedMiB === 22000, 'GPU0 util/mem 正确');
ok(snap1.gpu[1].utilPct === 10 && snap1.gpu[1].powerW === 35, 'GPU1 util/power 正确');
ok(snap1.procs[0]?.gpuUtilPct === 85, 'pmon 进程 GPU 利用率成功合入 procs');
ok(snap1.degraded === undefined, '正常模式无 degraded 字段');

// 验证 TTL 缓存（第二次采集在 500ms 内不重复调用 query-gpu）
const queryCallsBefore = mockGpuRunner.calls.filter((c) => c.includes('--query-gpu=index')).length;
await linuxWithGpu.snapshot();
const queryCallsAfter = mockGpuRunner.calls.filter((c) => c.includes('--query-gpu=index')).length;
ok(queryCallsBefore === queryCallsAfter, '500ms TTL 内快照复用 GPU 查询缓存');

await linuxWithGpu.close();

// 2. 测试纯 Linux / 无 GPU 环境（模拟树莓派或无 NVIDIA 卡）
const mockNoGpuRunner = {
  calls: [],
  async exec(cmd) {
    this.calls.push(cmd);
    if (cmd.includes('/proc/version')) {
      return { code: 0, stdout: 'Linux version 6.12.75+rpt-rpi-2712 aarch64', stderr: '' };
    }
    if (cmd.includes('/proc/meminfo')) {
      return { code: 0, stdout: 'MemTotal: 8063000 kB\nMemAvailable: 7402000 kB\n', stderr: '' };
    }
    if (cmd.includes('/proc/stat')) {
      return { code: 0, stdout: 'cpu  500 100 200 4000 50 0 0 0 0 0\n', stderr: '' };
    }
    if (cmd.includes('ps -eo')) {
      return { code: 0, stdout: '  201     1  0.2  10240  50  node server.js\n', stderr: '' };
    }
    if (cmd.includes('nvidia-smi')) {
      return { code: 127, stdout: '', stderr: 'nvidia-smi: command not found' };
    }
    return { code: 0, stdout: '', stderr: '' };
  },
};

const linuxNoGpu = new LinuxBackend(mockNoGpuRunner);
const probeNoGpu = await linuxNoGpu.probe();
ok(probeNoGpu.ok === true, '无 GPU 纯 Linux 下 probe 依然通过');
ok(probeNoGpu.detail?.gpu?.available === false, '无 GPU probe detail.gpu.available 为 false');

const snapNoGpu = await linuxNoGpu.snapshot();
ok(snapNoGpu.gpu === undefined, '无 GPU 时快照 gpu 字段为 undefined');
ok(snapNoGpu.sources.gpu === undefined, '无 GPU 时 sources.gpu 未定义');
ok(snapNoGpu.degraded?.gpu !== undefined, '无 GPU 时 degraded.gpu 标注降级原因');
ok(snapNoGpu.mem.totalMiB > 0, '无 GPU 时内存通道不受影响');
ok(snapNoGpu.procs.length === 1, '无 GPU 时进程通道不受影响');
const pmonCalls = mockNoGpuRunner.calls.filter((c) => c.includes('pmon'));
ok(pmonCalls.length === 0, '无 GPU 环境直接跳过 pmon 避免 2 秒无用等待');

await linuxNoGpu.close();

console.log(fail ? '❌ ' + fail + ' 个断言失败' : '✅ verify-linux-gpu 全部通过（共 18 项断言）');
process.exit(fail ? 1 : 0);
