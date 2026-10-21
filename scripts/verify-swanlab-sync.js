#!/usr/bin/env node
// ============================================================================
// verify-swanlab-sync.js —— SwanLab 按需同步方案全链路自动化测试
// ----------------------------------------------------------------------------
// 覆盖：
//   1. 命令行正则脱敏（--token, --api-key, --password, -p, 环境变量, URL 凭据）
//   2. 门控条件断言（allowedStates, minDurationSec, includeTypes, requireTags）
//   3. 指标模型与 Ring 降级（summary 一等公民、点数不足降级 summary-only、命名空间）
//   4. 内存级并发锁（per-run 同步锁、防重触发）
//   5. 状态机与持久化闭环（4态转换、toEndedSnapshot、restoreEnded 承接）
//   6. 运行时依赖预检（缺失 swanlab 标记 failed 且不死循环）
//   7. Mock Worker 端到端同步（幂等命名、结果回填、临时目录与文件自动清理）
//   8. 凭据隔离与 HTTP 门禁（apiKey 不外泄、POST 校验、CSRF 校验、参数非空校验）
// ============================================================================
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  sanitizeCmd,
  matchSyncConditions,
  extractMetricsForRun,
  acquireSyncLock,
  releaseSyncLock,
  checkSwanLabAvailable,
  syncRunToSwanLab,
  syncAllEligibleRuns,
} from '../lib/types/sync/swanlab.js'
import { createRing } from '../lib/types/core/ring.js'
import { createStateMachine } from '../lib/types/core/state-machine.js'
import { apply } from '../lib/index.js'

let pass = 0
let fail = 0

function t(name, fn) {
  try {
    fn()
    pass += 1
    console.log('  ✓ ' + name)
  } catch (e) {
    fail += 1
    console.log('  ✗ ' + name + ' — ' + (e.stack || e.message))
  }
}

async function at(name, fn) {
  try {
    await fn()
    pass += 1
    console.log('  ✓ ' + name)
  } catch (e) {
    fail += 1
    console.log('  ✗ ' + name + ' — ' + (e.stack || e.message))
  }
}

console.log('[1] 命令行正则脱敏（sanitizeCmd）')
t('脱敏 --token 及其值', () => {
  const cmd = 'python train.py --token my_secret_token --batch 32'
  assert.equal(sanitizeCmd(cmd), 'python train.py --token *** --batch 32')
})

t('脱敏 --token=value 格式', () => {
  const cmd = 'python train.py --token=secret123 --lr 0.01'
  assert.equal(sanitizeCmd(cmd), 'python train.py --token=*** --lr 0.01')
})

t('脱敏 --api-key 与 --api_key', () => {
  const cmd1 = 'python run.py --api-key sk-abc123456789'
  assert.equal(sanitizeCmd(cmd1), 'python run.py --api-key ***')
  const cmd2 = 'python run.py --api_key=sk-abc123456789'
  assert.equal(sanitizeCmd(cmd2), 'python run.py --api_key=***')
})

t('脱敏密码参数 --password 和 -p', () => {
  const cmd1 = 'python test.py --password my_pass_word'
  assert.equal(sanitizeCmd(cmd1), 'python test.py --password ***')
  const cmd2 = 'python test.py -p supersecret'
  assert.equal(sanitizeCmd(cmd2), 'python test.py -p ***')
})

t('脱敏环境变量与 key=value 形态', () => {
  const cmd = 'WANDB_API_KEY=xyz987 SWANLAB_API_KEY="secret" python train.py'
  const sanitized = sanitizeCmd(cmd)
  assert.ok(!sanitized.includes('xyz987'), 'WANDB_API_KEY 应该被脱敏')
  assert.ok(!sanitized.includes('secret'), 'SWANLAB_API_KEY 应该被脱敏')
  assert.ok(sanitized.includes('WANDB_API_KEY=***'))
})

t('脱敏 URL 内嵌的用户名密码', () => {
  const cmd = 'git clone https://user:pass123@github.com/repo.git'
  assert.equal(sanitizeCmd(cmd), 'git clone https://***:***@github.com/repo.git')
})

t('脱敏 Bearer 头部凭据', () => {
  const cmd = 'curl -H "Authorization: Bearer token-abc.def-123"'
  assert.equal(sanitizeCmd(cmd), 'curl -H "Authorization: Bearer ***"')
})

t('非敏感参数与常规训练参数保持完整', () => {
  const cmd = 'python train.py --batch-size 64 --epochs 100 --model-name resnet50'
  assert.equal(sanitizeCmd(cmd), cmd)
})

console.log('\n[2] 门控条件断言（matchSyncConditions）')
const baseRun = {
  runId: 'run-test-01',
  cmd: 'python train.py',
  cmdFeature: 'python train*.py',
  startTs: 1000000,
  endTs: 1060000, // 60s
  state: 'done',
  type: 'gpu-train',
  summary: {
    durationSec: 60,
    gpuUtilMax: 90,
    gpuUtilAvg: 75,
    memPeak: 8192,
    groupCpuMax: 120,
    dataPartial: false,
  },
}

t('空门控条件默认通过', () => {
  assert.deepEqual(matchSyncConditions(baseRun, {}), { matched: true })
})

t('allowedStates 匹配与拒绝', () => {
  const cond = { allowedStates: ['done', 'crashed'] }
  assert.equal(matchSyncConditions(baseRun, cond).matched, true)
  const abortedRun = { ...baseRun, state: 'aborted' }
  const res = matchSyncConditions(abortedRun, cond)
  assert.equal(res.matched, false)
  assert.ok(res.reason.includes('allowedStates'))
})

t('minDurationSec 时长门控', () => {
  const cond = { minDurationSec: 30 }
  assert.equal(matchSyncConditions(baseRun, cond).matched, true)
  const shortRun = { ...baseRun, summary: { ...baseRun.summary, durationSec: 15 } }
  const res = matchSyncConditions(shortRun, cond)
  assert.equal(res.matched, false)
  assert.ok(res.reason.includes('minDurationSec'))
})

t('includeTypes 实验类型门控', () => {
  const cond = { includeTypes: ['gpu-train', 'full'] }
  assert.equal(matchSyncConditions(baseRun, cond).matched, true)
  const otherTypeRun = { ...baseRun, type: 'smoke' }
  const res = matchSyncConditions(otherTypeRun, cond)
  assert.equal(res.matched, false)
  assert.ok(res.reason.includes('includeTypes'))
})

t('requireTags 标签匹配与拒绝', () => {
  const cond = { requireTags: ['train', 'resnet'] }
  assert.equal(matchSyncConditions(baseRun, cond, ['train', 'baseline']).matched, true)
  const res = matchSyncConditions(baseRun, cond, ['unrelated'])
  assert.equal(res.matched, false)
  assert.ok(res.reason.includes('requireTags'))
})

console.log('\n[3] 指标模型与 Ring 降级（extractMetricsForRun）')
t('无 Ring 或 dataPartial 自动降级为 summary-only 上报', () => {
  const res = extractMetricsForRun(baseRun, null)
  assert.equal(res.seriesAvailable, false)
  assert.deepEqual(res.series, [])
  assert.equal(res.summary.gpuUtilMax, 90)
  assert.equal(res.summary.durationSec, 60)

  const partialRun = { ...baseRun, summary: { ...baseRun.summary, dataPartial: true } }
  const ring = createRing(100, 600000)
  assert.equal(extractMetricsForRun(partialRun, ring).seriesAvailable, false)
})

t('点数不足（<2 点）降级为 summary-only 上报', () => {
  const ring = createRing(100, 600000)
  ring.push({
    ts: 1010000,
    gpu: [{ id: 0, utilPct: 80, memUsedMiB: 4096, memTotalMiB: 8192 }],
    gpuState: 'ok',
    cpuPct: 50,
    cores: 8,
    memUsedMiB: 4096,
    memTotalMiB: 16384,
    procs: [],
  })
  const res = extractMetricsForRun(baseRun, ring)
  assert.equal(res.seriesAvailable, false)
  assert.equal(res.summary.durationSec, 60)
})

t('点数充足时提取标量指标，并统一命名空间与 step 换算', () => {
  const ring = createRing(100, 600000)
  const t0 = baseRun.startTs
  // 插入 3 个点，间隔 10s
  for (let i = 0; i < 3; i++) {
    ring.push({
      ts: t0 + i * 10000,
      gpu: [{ id: 0, utilPct: 70 + i * 5, memUsedMiB: 4000 + i * 100, memTotalMiB: 8192 }],
      gpuState: 'ok',
      cpuPct: 30 + i * 10,
      cores: 8,
      memUsedMiB: 3000 + i * 100,
      memTotalMiB: 16384,
      procs: [],
      group: { cpuPct: 20 + i * 5, memMiB: 1000, memberCount: 1, alive: true, members: [] },
    })
  }

  const res = extractMetricsForRun(baseRun, ring)
  assert.equal(res.seriesAvailable, true)
  assert.equal(res.series.length, 3)
  assert.equal(res.series[0].step, 0)
  assert.equal(res.series[1].step, 1)
  assert.equal(res.series[2].step, 2)

  // 命名空间检查
  const m0 = res.series[0].metrics
  assert.equal(m0['lab-monitor/gpu.util'], 70)
  assert.equal(m0['lab-monitor/gpu.mem'], 4000)
  assert.equal(m0['lab-monitor/cpu.util'], 30)
  assert.equal(m0['lab-monitor/group.cpu'], 20)
  assert.equal(m0['lab-monitor/group.mem'], 1000)
})

console.log('\n[4] 内存级并发锁（acquireSyncLock / releaseSyncLock）')
t('同一 runId 并发加锁互斥，释放后可重新加锁', () => {
  const runId = 'lock-test-run-001'
  assert.equal(acquireSyncLock(runId), true)
  assert.equal(acquireSyncLock(runId), false, '重复加锁必须被拒绝')
  releaseSyncLock(runId)
  assert.equal(acquireSyncLock(runId), true, '释放后可重新加锁')
  releaseSyncLock(runId)
})

console.log('\n[5] 状态机与持久化闭环（state-machine & swanlab 字段）')
t('状态机 markSwanLabSynced、toEndedSnapshot、restoreEnded 完整传递', () => {
  const sm = createStateMachine({
    emitLab() {},
    emitAlert() {},
  })

  const r = sm.start('python train_sm.py', 'python train*.py')
  sm.markResult(true, r.runId)
  sm.tick([]) // 驱动结束

  // 1. 更新为 syncing 态
  const attemptTs = Date.now()
  assert.equal(sm.markSwanLabSynced(r.runId, { status: 'syncing', attemptTs }), true)
  let snap = sm.snapshot()
  let endedRun = snap.ended.find((e) => e.runId === r.runId)
  assert.ok(endedRun)
  assert.equal(endedRun.swanlab.status, 'syncing')
  assert.equal(endedRun.swanlab.attemptTs, attemptTs)

  // 2. 更新为 synced 态
  const syncTs = Date.now() + 100
  sm.markSwanLabSynced(r.runId, {
    status: 'synced',
    runId: 'swan-run-999',
    runUrl: 'https://swanlab.cn/@test/runs/swan-run-999',
    syncTs,
  })
  snap = sm.snapshot()
  endedRun = snap.ended.find((e) => e.runId === r.runId)
  assert.equal(endedRun.swanlab.status, 'synced')
  assert.equal(endedRun.swanlab.runId, 'swan-run-999')
  assert.equal(endedRun.swanlab.runUrl, 'https://swanlab.cn/@test/runs/swan-run-999')
  assert.equal(endedRun.swanlab.syncTs, syncTs)

  // 3. restoreEnded 还原重建
  const sm2 = createStateMachine({
    emitLab() {},
    emitAlert() {},
  })
  sm2.restoreEnded(snap.ended)
  const snap2 = sm2.snapshot()
  const restored = snap2.ended.find((e) => e.runId === r.runId)
  assert.ok(restored, '已结束实验应被正确恢复')
  assert.deepEqual(restored.swanlab, endedRun.swanlab, 'swanlab 状态对象应在恢复后完整保留')
})

console.log('\n[6] 运行时依赖预检（checkSwanLabAvailable）')
await at('非 swanlab 环境明确标记失败，不挂起也不吞异常', async () => {
  // 使用当前默认 python3（未安装 swanlab）测试
  const res = await checkSwanLabAvailable('python3')
  assert.equal(res.available, false)
  assert.ok(res.error.includes('is not installed'))
  assert.ok(res.error.includes('pip install swanlab'))
})

console.log('\n[7] Mock Worker 同步流程（syncRunToSwanLab 与自动清理）')
await at('Mock Worker 成功同步：结果回填、幂等命名与临时目录完全清理', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swanlab_test_'))
  const mockWorkerScript = path.join(tempDir, 'mock-worker.js')

  // 编写一个 Node.js 脚本模拟 python worker 的行为
  fs.writeFileSync(
    mockWorkerScript,
    `
    const fs = require('fs');
    const payloadFile = process.argv[2];
    const data = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));

    // 检查幂等名称格式 [lab-monitor] <fingerprint>-<startTs>
    if (!data.experimentName.startsWith('[lab-monitor]')) {
      console.log(JSON.stringify({ success: false, error: 'Bad exp name' }));
      process.exit(1);
    }

    // 模拟成功返回
    console.log(JSON.stringify({
      success: true,
      runId: 'mock_run_' + data.config.runId,
      runUrl: 'https://swanlab.cn/@user/lab-monitor/runs/mock_run_' + data.config.runId
    }));
  `,
  )

  const sm = createStateMachine({ emitLab() {}, emitAlert() {} })
  const r = sm.start('python train_mock.py', 'python train*.py')
  sm.markResult(true, r.runId)
  sm.tick([])

  let persisted = false
  const res = await syncRunToSwanLab(r, {
    config: { enabled: true, apiKey: 'test-key', project: 'test-proj', triggerMode: 'manual' },
    stateMachine: sm,
    pythonBin: 'node',
    workerScriptPath: mockWorkerScript,
    customLogDir: tempDir,
    persistState: () => {
      persisted = true
    },
    force: true,
    skipDepCheck: true,
  })

  assert.equal(res.ok, true)
  assert.equal(res.status, 'synced')
  assert.ok(res.runUrl.includes('mock_run_'))
  assert.equal(persisted, true, '同步完成后必须调用 persistState')

  const snap = sm.snapshot()
  const ended = snap.ended.find((e) => e.runId === r.runId)
  assert.equal(ended.swanlab.status, 'synced')

  // 验证临时文件与 swanlog 临时目录是否已被清理
  const remainingFiles = fs.readdirSync(tempDir)
  const leftoverSwanlogs = remainingFiles.filter((f) => f.startsWith('swanlog_') || f.startsWith('swanlab_payload_'))
  assert.equal(leftoverSwanlogs.length, 0, '临时日志与 payload 文件必须在执行后彻底清理')

  // 清理测试目录
  fs.rmSync(tempDir, { recursive: true, force: true })
})

await at('Mock Worker 失败上报：状态转 failed 并记录 error 信息', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swanlab_test_fail_'))
  const mockFailScript = path.join(tempDir, 'mock-fail-worker.js')

  fs.writeFileSync(
    mockFailScript,
    `
    console.log(JSON.stringify({
      success: false,
      error: 'Invalid API Key or Network Timeout'
    }));
    process.exit(1);
  `,
  )

  const sm = createStateMachine({ emitLab() {}, emitAlert() {} })
  const r = sm.start('python train_fail.py', 'python train*.py')
  sm.markResult(true, r.runId)
  sm.tick([])

  const res = await syncRunToSwanLab(r, {
    config: { enabled: true, triggerMode: 'manual' },
    stateMachine: sm,
    pythonBin: 'node',
    workerScriptPath: mockFailScript,
    customLogDir: tempDir,
    force: true,
    skipDepCheck: true,
  })

  assert.equal(res.ok, false)
  assert.equal(res.status, 'failed')
  assert.ok(res.error.includes('Invalid API Key'))

  const snap = sm.snapshot()
  const ended = snap.ended.find((e) => e.runId === r.runId)
  assert.equal(ended.swanlab.status, 'failed')
  assert.equal(ended.swanlab.error, 'Invalid API Key or Network Timeout')

  fs.rmSync(tempDir, { recursive: true, force: true })
})

await at('批量同步（syncAllEligibleRuns）串行队列与已同步跳过', async () => {
  let executedCount = 0
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swanlab_test_batch_'))
  const mockBatchScript = path.join(tempDir, 'mock-batch-worker.js')
  fs.writeFileSync(
    mockBatchScript,
    `
    console.log(JSON.stringify({ success: true, runId: 'batch_run' }));
  `,
  )

  const runs = [
    { ...baseRun, runId: 'batch-1', swanlab: { status: 'synced' } }, // 已同步应跳过
    { ...baseRun, runId: 'batch-2', swanlab: { status: 'pending' } }, // 应执行
    { ...baseRun, runId: 'batch-3', swanlab: undefined }, // 应执行
  ]

  const batchRes = await syncAllEligibleRuns(runs, {
    pythonBin: 'node',
    workerScriptPath: mockBatchScript,
    customLogDir: tempDir,
    force: false,
    skipDepCheck: true,
  })

  assert.equal(batchRes.total, 3)
  assert.equal(batchRes.skipped, 1, '已同步记录应被跳过')
  assert.equal(batchRes.synced, 2, '其余记录应完成同步')

  fs.rmSync(tempDir, { recursive: true, force: true })
})

console.log('\n[8] 凭据隔离与 HTTP 安全门禁断言')
await at('MonitorSnapshot 仅暴露 apiKeyConfigured，严禁暴露明文 apiKey', async () => {
  // 构建 mock context 触发 apply
  let registeredRoutes = {}
  let registeredTools = {}
  const mockCtx = {
    get() {
      return undefined
    },
    effect() {},
    on() {},
    interval() {
      return () => {}
    },
    setTimeout(fn) {
      return setTimeout(fn, 0)
    },
    webServer: {
      register(route) {
        registeredRoutes[route.path] = route.handler
        return () => {}
      },
    },
    tools: {
      register(tool) {
        registeredTools[tool.name] = tool
        return () => {}
      },
    },
  }

  apply(mockCtx, {
    swanlab: {
      enabled: true,
      apiKey: 'SUPER_SECRET_SWANLAB_KEY_12345',
      project: 'my-proj',
    },
  })

  // 1. 验证 lab_status 工具快照中的 swanlab 字段
  const statusTool = registeredTools['lab_status']
  assert.ok(statusTool, 'lab_status 工具应已注册')
  const snap = await statusTool.execute({})
  assert.ok(snap.swanlab)
  assert.equal(snap.swanlab.apiKeyConfigured, true)
  assert.equal(snap.swanlab.apiKey, undefined, '快照中严禁出现 apiKey 明文字段')
  assert.ok(!JSON.stringify(snap).includes('SUPER_SECRET_SWANLAB_KEY_12345'), '完整快照 JSON 严禁包含明文 Key')

  // 2. 验证 HTTP 数据面 /lab-monitor/api 接口门禁
  const httpHandler = registeredRoutes['/lab-monitor/api']
  assert.ok(httpHandler, 'HTTP 路由处理器应已注册')

  // 模拟 GET 请求调用 swanlabSync（必须被拒 405）
  let resStatus = 0
  let resBody = ''
  const mockRes405 = {
    writeHead(code) {
      resStatus = code
      return {
        end(data) {
          resBody = data
        },
      }
    },
  }
  httpHandler({ url: '/lab-monitor/api/swanlabSync', method: 'GET', headers: {} }, mockRes405)
  assert.equal(resStatus, 405, 'GET 方法请求 swanlabSync 必须被 405 拒绝')

  // 模拟非法 Origin 跨站 POST 请求（必须被 CSRF 校验拒 403）
  let resStatusCsrf = 0
  const mockResCsrf = {
    writeHead(code) {
      resStatusCsrf = code
      return { end() {} }
    },
  }
  httpHandler(
    {
      url: '/lab-monitor/api/swanlabSync',
      method: 'POST',
      headers: { origin: 'http://malicious-site.com' },
      on() {},
    },
    mockResCsrf,
  )
  assert.equal(resStatusCsrf, 403, '非回环 Origin POST 请求必须被 403 拒绝')

  // 模拟合法 Origin 但空参数 POST 请求（必须被拒 400 防盲触发）
  let resStatusEmpty = 0
  let resBodyEmpty = ''
  let dataCb, endCb
  const mockReqEmpty = {
    url: '/lab-monitor/api/swanlabSync',
    method: 'POST',
    headers: { origin: 'http://localhost:3000' },
    on(event, cb) {
      if (event === 'data') dataCb = cb
      if (event === 'end') endCb = cb
    },
  }
  const mockResEmpty = {
    writeHead(code) {
      resStatusEmpty = code
      return {
        end(data) {
          resBodyEmpty = data
        },
      }
    },
  }
  httpHandler(mockReqEmpty, mockResEmpty)
  // 发送空 body
  if (dataCb) dataCb(Buffer.from(''))
  if (endCb) endCb()
  assert.equal(resStatusEmpty, 400, '空参数 POST 请求必须被 400 拒绝')
  assert.ok(resBodyEmpty.includes('missing parameters'), '应提示缺失参数')

  // 3. 验证 lab_ctl 包含 sync-swanlab 动作
  const ctlTool = registeredTools['lab_ctl']
  assert.ok(ctlTool, 'lab_ctl 工具应已注册')
  const actionEnum = ctlTool.parameters.properties?.action?.enum || ctlTool.parameters.action?.enum
  assert.ok(actionEnum.includes('sync-swanlab'), 'lab_ctl action 必须包含 sync-swanlab')
})

console.log(`\n==== verify-swanlab-sync: ${pass} 通过 / ${fail} 失败 ====`)
if (fail > 0) process.exit(1)
