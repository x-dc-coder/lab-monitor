#!/usr/bin/env node
/**
 * forward-monitor.mjs — lab-monitor → monitor.dc-sy.cn 转发器（issue #11）
 *
 * 职责：每 30s 轮询本机 lab-monitor snapshot（127.0.0.1:3080），
 *       映射为 monitor-panel ingest 白名单指标（group=lab_monitor），
 *       携带 payload 快照 POST 到 https://monitor.dc-sy.cn/api/ingest。
 *
 * 零依赖（node ≥18 fetch 内置）；失败静默重试下一轮；日志追加 forward-monitor.log。
 * token 读取：~/.config/lab-monitor-forward.env（MONITOR_INGEST_TOKEN=xxx，600 权限）
 * 启动/停止：scripts/forward-monitor.sh {start|stop|status}
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SNAPSHOT_URL = process.env.LAB_SNAPSHOT_URL || 'http://127.0.0.1:3080/lab-monitor/api/snapshot';
const INGEST_URL = process.env.LAB_INGEST_URL || 'https://monitor.dc-sy.cn/api/ingest';
const NODE_ID = process.env.LAB_NODE_ID || 'dc-desktop';
const INTERVAL_MS = 30000;
const WINDOW_MS = 30000;   // #13-2 上报窗口（与 INTERVAL 对齐）
const SAMPLE_MS = 5000;    // #13-2 窗口内采样间隔（30s 窗口 → 6 采样）

const CFG_PATH = join(homedir(), '.config', 'lab-monitor-forward.env');
const LOG_PATH = join(process.cwd(), 'forward-monitor.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { appendFileSync(LOG_PATH, line + '\n'); } catch { /* 日志失败不影响主流程 */ }
  console.log(line);
}

function loadToken() {
  if (!existsSync(CFG_PATH)) {
    log(`✗ 缺少配置 ${CFG_PATH}（须含 MONITOR_INGEST_TOKEN=xxx）`);
    process.exit(1);
  }
  const txt = readFileSync(CFG_PATH, 'utf8');
  const m = txt.match(/^\s*MONITOR_INGEST_TOKEN\s*=\s*(\S+)\s*$/m);
  if (!m) {
    log(`✗ 配置中未找到 MONITOR_INGEST_TOKEN（${CFG_PATH}）`);
    process.exit(1);
  }
  return m[1];
}

const TOKEN = loadToken();

/** 从 snapshot 提取指标数组 + payload 快照 */
function extract(snap) {
  const g = (snap.gpu && snap.gpu[0]) || {};
  const exp = snap.experiment || null; // ExperimentSnapshot | null
  const alerts = Array.isArray(snap.alerts) ? snap.alerts : [];
  // #13-1 进程级快照：全量 procs 太大（几百条），按 memMiB 取 Top N，cmd 截断
  const PROCS_TOP = 10;
  const CMD_MAX = 80;
  const procsTop = (snap.procs || [])
    .filter((p) => p && p.pid > 0)
    .sort((a, b) => (b.memMiB ?? 0) - (a.memMiB ?? 0))
    .slice(0, PROCS_TOP)
    .map((p) => ({
      pid: p.pid,
      ppid: p.ppid ?? null,
      cmd: typeof p.cmd === 'string' && p.cmd.length > CMD_MAX ? p.cmd.slice(0, CMD_MAX) + '…' : (p.cmd ?? ''),
      cpuPct: p.cpuPct ?? null,
      memMiB: p.memMiB ?? null,
    }));
  // #13-1 标签组聚合（体积小信息密度高：组内 GPU/CPU/内存聚合）
  const tags = (snap.tags || []).map((t) => ({
    label: (t.rule && t.rule.label) || t.label || '?',
    kind: (t.rule && t.rule.kind) || 'process',
    pids: Array.isArray(t.pids) ? t.pids : [],
    gpuUtilPct: t.gpuUtilPct ?? null,
    cpuPct: t.cpuPct ?? null,
    memMiB: t.memMiB ?? null,
  }));
  const cpuPct = snap.cpu && typeof snap.cpu.percent === 'number' ? snap.cpu.percent : null
  const memAvail = snap.mem && typeof snap.mem.availableMiB === 'number' ? snap.mem.availableMiB : null
  const memTotal = snap.mem && typeof snap.mem.totalMiB === 'number' ? snap.mem.totalMiB : null
  const memPct = (memAvail != null && memTotal) ? Math.round((1 - memAvail / memTotal) * 1000) / 10 : null
  const metrics = [
    ['gpu_util_percent', g.utilPct ?? null],
    ['vram_used_mib', g.memUsedMiB ?? null],
    ['vram_total_mib', g.memTotalMiB ?? null],
    ['vram_util_percent', (g.memUsedMiB != null && g.memTotalMiB)
      ? Math.round((g.memUsedMiB / g.memTotalMiB) * 1000) / 10 : null],
    ['gpu_temp_c', g.tempC ?? null],
    ['cpu_percent', cpuPct],
    ['mem_percent', memPct],
    ['mem_used_mib', memAvail != null && memTotal != null ? Math.round(memTotal - memAvail) : null],
    ['mem_total_mib', memTotal],
    ['experiment_active', exp ? 1 : 0],
    ['experiments_total', Array.isArray(snap.ended) ? snap.ended.length : 0],
    ['alerts_crit', alerts.filter((a) => a.level === 'critical').length],
    ['alerts_warn', alerts.filter((a) => a.level === 'warn').length],
    ['monitor_enabled', snap.enabled === true ? 1 : 0],
  ].filter(([, v]) => v != null).map(([name, value]) => ({ name, value }));

  const payload = {
    gpu_util_percent: g.utilPct ?? null,
    vram_used_mib: g.memUsedMiB ?? null,
    vram_total_mib: g.memTotalMiB ?? null,
    vram_util_percent: (g.memUsedMiB != null && g.memTotalMiB)
      ? Math.round((g.memUsedMiB / g.memTotalMiB) * 1000) / 10 : null,
    gpu_temp_c: g.tempC ?? null,
    cpu_percent: cpuPct,
    mem_percent: memPct,
    mem_used_mib: memAvail != null && memTotal != null ? Math.round(memTotal - memAvail) : null,
    mem_total_mib: memTotal,
    experiment_active: exp ? 1 : 0,
    experiments_total: Array.isArray(snap.ended) ? snap.ended.length : 0,
    alerts_crit: alerts.filter((a) => a.level === 'critical').length,
    alerts_warn: alerts.filter((a) => a.level === 'warn').length,
    monitor_enabled: snap.enabled === true ? 1 : 0,
    experiment: exp ? { runId: exp.runId, cmd: exp.cmd, type: exp.type, startTs: exp.startTs } : null,
    // #13-1：进程级快照 + 标签组聚合（快照性数据，进 payload 非时序指标）
    procs_top: procsTop,
    tags,
  };
  return { metrics, payload };
}

/** 一次采样：拉 snapshot 并提取指标 + payload */
async function sampleOnce() {
  let snap;
  try {
    const r = await fetch(SNAPSHOT_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
    snap = await r.json();
  } catch (e) {
    log(`⚠ 拉取 snapshot 失败（DSH 未起?）: ${e.message}`);
    return null;
  }
  return extract(snap);
}

/** 一轮上报：#13-2 窗口聚合——WINDOW_MS 内 SAMPLE_MS 间隔采样 N 次，
 *  GPU 利用率取 avg（gpu_util_percent）+ max（gpu_util_max）双值，其余字段取最后一次采样。 */
async function oneRound() {
  const samples = [];
  const n = Math.max(1, Math.round(WINDOW_MS / SAMPLE_MS));
  for (let i = 0; i < n; i++) {
    const s = await sampleOnce();
    if (s) samples.push(s);
    if (i < n - 1) await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }
  if (samples.length === 0) {
    log(`✗ 本轮无采样（DSH 未起），跳过上报`);
    return;
  }

  // 聚合：GPU util avg/max；其余字段用最后一次采样
  const last = samples[samples.length - 1];
  const utils = samples.map((s) => s.metrics.find((m) => m.name === 'gpu_util_percent')?.value)
    .filter((v) => typeof v === 'number');
  const utilAvg = utils.length ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length * 10) / 10 : null;
  const utilMax = utils.length ? Math.max(...utils) : null;

  const metrics = last.metrics
    .filter((m) => m.name !== 'gpu_util_percent')
    .concat(utilAvg != null ? [{ name: 'gpu_util_percent', value: utilAvg }] : [])
    .concat(utilMax != null ? [{ name: 'gpu_util_max', value: utilMax }] : []);

  const payload = { ...last.payload, gpu_util_percent: utilAvg, gpu_util_max: utilMax };

  const body = JSON.stringify({
    results: [{ node_id: NODE_ID, group: 'lab_monitor', metrics, payload }],
  });
  try {
    const r = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`ingest HTTP ${r.status}`);
    const j = await r.json().catch(() => ({}));
    const accepted = (j.data && j.data.accepted) ?? '?';
    log(`✓ 上报成功 accepted=${accepted} gpu=${utilAvg ?? '—'}% (max ${utilMax ?? '—'}%) exp=${payload.experiment_active} (${samples.length} 采样)`);
  } catch (e) {
    log(`✗ 上报失败: ${e.message}`);
  }
}

log(`转发器启动: ${SNAPSHOT_URL} → ${INGEST_URL} (node=${NODE_ID}, 每 ${INTERVAL_MS / 1000}s)`);
oneRound();
setInterval(oneRound, INTERVAL_MS);
