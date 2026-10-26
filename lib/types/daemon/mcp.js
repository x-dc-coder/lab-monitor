import { sanitizeJson } from './engine.js';
const TOOLS = [
    {
        name: 'lab_status',
        description: 'lab-monitor 实时快照（GPU/CPU/内存/进程/实验/告警）；brief=true 时返回一行摘要',
        inputSchema: { type: 'object', properties: { brief: { type: 'boolean', description: '一行摘要模式' } } },
    },
    {
        name: 'lab_advice',
        description: '平衡引擎告警建议（分级/证据/动作）；无告警时 advice 为空数组',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'lab_ctl',
        description: '控制/配置：start/pause/resume/set-threshold/watch/tag/clear-alerts/track/switch-device',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string' },
                thresholds: { type: 'object' },
                keywords: { type: 'array', items: { type: 'string' } },
                tag: { type: 'object' },
                track: { type: 'object' },
                device: { type: 'string' },
                rule: { type: 'string' },
            },
        },
    },
];
function textResult(v, isError = false) {
    const out = {
        content: [{ type: 'text', text: JSON.stringify(sanitizeJson(v)) }],
    };
    if (isError)
        out.isError = true;
    return out;
}
function briefLine(snap) {
    const g = Array.isArray(snap.gpu) && snap.gpu.length ? snap.gpu[0] : null;
    const parts = [];
    if (g)
        parts.push('GPU' + String(g.id) + ' ' + String(g.utilPct) + '%');
    const cpu = snap.cpu;
    if (cpu && typeof cpu.percent === 'number')
        parts.push('CPU ' + Math.round(cpu.percent) + '%');
    parts.push('告警: ' + (snap.alertsCriticalCount ? String(snap.alertsCriticalCount) + '条' : '无'));
    return '[Lab Monitor] ' + parts.join(' · ');
}
/** 返回 { status, json }；status=401 由 http 层在鉴权失败时决定，这里只处理已通过鉴权的请求体 */
export function handleMcp(engine, allowControl, raw) {
    const req = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
    const id = req.id === undefined ? null : req.id;
    const reply = (result) => ({
        status: 200,
        json: { jsonrpc: '2.0', id, result },
    });
    const replyError = (code, message) => ({
        status: 200,
        json: { jsonrpc: '2.0', id, error: { code, message } },
    });
    switch (req.method) {
        case 'initialize':
            return reply({
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'lab-monitord', version: '2.0.0' },
            });
        case 'notifications/initialized':
            return { status: 202, json: {} };
        case 'tools/list':
            return reply({ tools: TOOLS });
        case 'tools/call': {
            const params = req.params || {};
            const name = typeof params.name === 'string' ? params.name : '';
            const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {});
            if (name === 'lab_status') {
                const snap = engine.buildSnapshot();
                if (args.brief === true)
                    return reply(textResult({ brief: briefLine(snap), ts: snap.ts }));
                return reply(textResult(snap));
            }
            if (name === 'lab_advice') {
                return reply(textResult(engine.dispatch('advice', {})));
            }
            if (name === 'lab_ctl') {
                if (!allowControl) {
                    return reply(textResult({ ok: false, error: 'lab_ctl 拒绝：mcp.allowControl=false（只读 MCP 门控）' }, true));
                }
                return reply(textResult(engine.dispatch('control', args)));
            }
            return replyError(-32602, 'unknown tool: ' + name);
        }
        case 'ping':
            return reply({});
        default:
            return replyError(-32601, 'method not found: ' + String(req.method));
    }
}
