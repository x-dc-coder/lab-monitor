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
  const metrics = [
    ['gpu_util_percent', g.utilPct ?? null],
    ['vram_used_mib', g.memUsedMiB ?? null],
    ['vram_total_mib', g.memTotalMiB ?? null],
    ['vram_util_percent', (g.memUsedMiB != null && g.memTotalMiB)
      ? Math.round((g.memUsedMiB / g.memTotalMiB) * 1000) / 10 : null],
    ['gpu_temp_c', g.tempC ?? null],
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
    experiment_active: exp ? 1 : 0,
    experiments_total: Array.isArray(snap.ended) ? snap.ended.length : 0,
    alerts_crit: alerts.filter((a) => a.level === 'critical').length,
    alerts_warn: alerts.filter((a) => a.level === 'warn').length,
    monitor_enabled: snap.enabled === true ? 1 : 0,
    experiment: exp ? { runId: exp.runId, cmd: exp.cmd, type: exp.type, startTs: exp.startTs } : null,
  };
  return { metrics, payload };
}

async function oneRound() {
  let snap;
  try {
    const r = await fetch(SNAPSHOT_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
    snap = await r.json();
  } catch (e) {
    log(`⚠ 拉取 snapshot 失败（DSH 未起?）: ${e.message}`);
    return;
  }

  const { metrics, payload } = extract(snap);
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
    log(`✓ 上报成功 accepted=${accepted} gpu=${payload.gpu_util_percent}% exp=${payload.experiment_active}`);
  } catch (e) {
    log(`✗ 上报失败: ${e.message}`);
  }
}

log(`转发器启动: ${SNAPSHOT_URL} → ${INGEST_URL} (node=${NODE_ID}, 每 ${INTERVAL_MS / 1000}s)`);
oneRound();
setInterval(oneRound, INTERVAL_MS);
