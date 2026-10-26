/**
 * daemon 配置存储（config-store）
 * - 唯一配置文件：~/.config/lab-monitor/config.json（daemon 是唯一写者；原子写 = tmp + rename）
 * - 凭据：~/.config/lab-monitor/credentials/<ref>.env（0600；apiKey 等秘密只在这里，绝不进 config.json）
 * - token：~/.config/lab-monitor/token（0600；首启生成；永不打日志）
 * 路径可用 LAB_MONITOR_HOME / LAB_MONITOR_STATE_HOME 重定向（测试用）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { THRESHOLD_DEFAULTS } from '../core/constants.js';
export const PROTOCOL_VERSION = '1.6';
export const DAEMON_VERSION = '2.0.0';
export function configHome(override) {
    return override || process.env.LAB_MONITOR_HOME || join(homedir(), '.config', 'lab-monitor');
}
export function stateHome(override) {
    return override || process.env.LAB_MONITOR_STATE_HOME || join(homedir(), '.local', 'state', 'lab-monitor');
}
function strArr(v) {
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}
/** 默认配置（THRESHOLD_DEFAULTS 对齐；sinks 两类参考适配器出厂 enabled:false） */
export function defaultConfig() {
    return {
        schemaVersion: 1,
        sampleMs: 2000,
        backendMode: 'auto',
        thresholds: { ...THRESHOLD_DEFAULTS },
        thresholdOverrides: {},
        watchProcs: [],
        tags: [],
        trackRules: [],
        history: [],
        alertNotify: 'notice',
        alertTargets: [],
        notifyThrottleMs: 60000,
        escalateAfterSec: 600,
        notifyTimeoutMs: 600000,
        broadcast: false,
        experimentTypes: [],
        expTypeDefault: 'unknown',
        expTypeLearning: true,
        subagentPolicy: 'readonly',
        devices: [],
        currentDevice: 'local',
        server: { port: 8730, host: '127.0.0.1', maxSseClients: 8 },
        mcp: { enabled: true, allowControl: true },
        sinks: [
            { id: 'swanlab', kind: 'experiment-record', enabled: false, project: 'lab-monitor', workspace: '', credentialRef: 'swanlab', triggerMode: 'manual' },
            { id: 'monitor-dc-sy', kind: 'metrics-forward', enabled: false, url: 'https://monitor.dc-sy.cn/api/ingest', nodeId: 'dc-desktop', group: 'lab_monitor', windowMs: 30000, credentialRef: 'monitor-ingest' },
        ],
    };
}
/** 读取并合并默认值（浅合并 + 数组清洗；损坏文件回退默认并留 .corrupt 备份） */
export function loadConfig(homeOverride) {
    const home = configHome(homeOverride);
    const file = join(home, 'config.json');
    const base = defaultConfig();
    if (!existsSync(file))
        return base;
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        try {
            renameSync(file, file + '.corrupt');
        }
        catch { /* 备份失败不阻塞 */ }
        return base;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return base;
    const src = raw;
    const out = base;
    if (typeof src.sampleMs === 'number' && src.sampleMs > 0)
        out.sampleMs = src.sampleMs;
    if (src.backendMode === 'windows' || src.backendMode === 'linux' || src.backendMode === 'windows-native')
        out.backendMode = src.backendMode;
    if (src.thresholds && typeof src.thresholds === 'object' && !Array.isArray(src.thresholds)) {
        const t = src.thresholds;
        for (const k of Object.keys(THRESHOLD_DEFAULTS)) {
            const v = t[k];
            if (typeof v === 'number' && Number.isFinite(v))
                out.thresholds[k] = v;
        }
    }
    if (src.thresholdOverrides && typeof src.thresholdOverrides === 'object' && !Array.isArray(src.thresholdOverrides)) {
        out.thresholdOverrides = src.thresholdOverrides;
    }
    out.watchProcs = strArr(src.watchProcs);
    if (Array.isArray(src.tags))
        out.tags = src.tags;
    if (Array.isArray(src.trackRules))
        out.trackRules = src.trackRules;
    if (Array.isArray(src.history))
        out.history = src.history;
    if (src.alertNotify === 'off' || src.alertNotify === 'notice' || src.alertNotify === 'wake')
        out.alertNotify = src.alertNotify;
    out.alertTargets = strArr(src.alertTargets);
    if (typeof src.notifyThrottleMs === 'number' && src.notifyThrottleMs > 0)
        out.notifyThrottleMs = src.notifyThrottleMs;
    if (typeof src.escalateAfterSec === 'number' && src.escalateAfterSec > 0)
        out.escalateAfterSec = src.escalateAfterSec;
    if (typeof src.notifyTimeoutMs === 'number' && src.notifyTimeoutMs > 0)
        out.notifyTimeoutMs = src.notifyTimeoutMs;
    if (typeof src.broadcast === 'boolean')
        out.broadcast = src.broadcast;
    if (Array.isArray(src.experimentTypes))
        out.experimentTypes = src.experimentTypes;
    if (typeof src.expTypeDefault === 'string')
        out.expTypeDefault = src.expTypeDefault;
    if (typeof src.expTypeLearning === 'boolean')
        out.expTypeLearning = src.expTypeLearning;
    if (src.subagentPolicy === 'readonly' || src.subagentPolicy === 'restricted' || src.subagentPolicy === 'full')
        out.subagentPolicy = src.subagentPolicy;
    if (Array.isArray(src.devices))
        out.devices = src.devices;
    if (typeof src.currentDevice === 'string')
        out.currentDevice = src.currentDevice;
    if (src.server && typeof src.server === 'object' && !Array.isArray(src.server)) {
        const s = src.server;
        if (typeof s.port === 'number' && s.port > 0 && s.port < 65536)
            out.server.port = s.port;
        if (typeof s.host === 'string' && s.host)
            out.server.host = s.host;
        if (typeof s.maxSseClients === 'number' && s.maxSseClients > 0)
            out.server.maxSseClients = Math.round(s.maxSseClients);
    }
    if (src.mcp && typeof src.mcp === 'object' && !Array.isArray(src.mcp)) {
        const m = src.mcp;
        if (typeof m.enabled === 'boolean')
            out.mcp.enabled = m.enabled;
        if (typeof m.allowControl === 'boolean')
            out.mcp.allowControl = m.allowControl;
    }
    if (Array.isArray(src.sinks))
        out.sinks = src.sinks;
    return out;
}
/** 原子写：与 config.json 同目录的 tmp + rename（同文件系统；不用 os.tmpdir()，避免 EXDEV） */
export function saveConfig(cfg, homeOverride) {
    const home = configHome(homeOverride);
    mkdirSync(home, { recursive: true });
    const file = join(home, 'config.json');
    const tmp = join(home, '.config.json.tmp');
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    try {
        chmodSync(tmp, 0o600);
    }
    catch { /* 已 0600 */ }
    renameSync(tmp, file);
    try {
        chmodSync(file, 0o600);
    }
    catch { /* rename 后补一次 */ }
}
/** token：首启生成 32 字节 hex，0600；已存在则读回 */
export function ensureToken(homeOverride) {
    const home = configHome(homeOverride);
    mkdirSync(home, { recursive: true });
    const file = join(home, 'token');
    if (existsSync(file)) {
        const t = readFileSync(file, 'utf8').trim();
        if (t)
            return t;
    }
    const t = randomBytes(32).toString('hex');
    writeFileSync(file, t + '\n', { mode: 0o600 });
    try {
        chmodSync(file, 0o600);
    }
    catch { /* 已 0600 */ }
    return t;
}
/** 凭据文件解析（KEY=VALUE 行；0600；不存在返回空对象） */
export function readCredentialFile(ref, homeOverride) {
    const home = configHome(homeOverride);
    const file = join(home, 'credentials', ref + '.env');
    const out = {};
    if (!existsSync(file))
        return out;
    try {
        const lines = readFileSync(file, 'utf8').split('\n');
        for (const line of lines) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S.*?)\s*$/);
            if (m)
                out[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    }
    catch { /* 读失败 = 空凭据 */ }
    return out;
}
/** 结构化日志（追加 ~/.local/state/lab-monitor/lab-monitord.log；token 不落日志） */
export function logLine(stateDir, level, module, msg, fields) {
    const line = JSON.stringify({ ts: Date.now(), level, module, msg, fields: fields || {} });
    try {
        appendFileSync(join(stateDir, 'lab-monitord.log'), line + '\n');
    }
    catch { /* 日志失败不影响主流程 */ }
    try {
        const s = statSync(join(stateDir, 'lab-monitord.log'));
        if (s.size > 10 * 1024 * 1024)
            renameSync(join(stateDir, 'lab-monitord.log'), join(stateDir, 'lab-monitord.log.1'));
    }
    catch { /* 轮转失败忽略 */ }
}
