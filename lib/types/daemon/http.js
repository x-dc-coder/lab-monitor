/**
 * daemon HTTP 数据面（node:http，仅绑 127.0.0.1）
 * - GET /health 不鉴权
 * - GET /lab-monitor/api/{snapshot,history,advice} 只读不鉴权（forwarder/curl SOP 零改动）
 * - GET /lab-monitor/api/{track,watch,tag} 列表只读；POST 一律须 Authorization: Bearer <token>
 * - POST body 上限 1MiB → 413
 * - GET /lab-monitor/events SSE：token 必须，连接上限 maxSseClients（默认 8），15s 心跳
 * - POST /mcp：token 必须，转发 mcp.handleMcp
 */
import { createServer } from 'node:http';
import { handleMcp } from './mcp.js';
import { DAEMON_VERSION, PROTOCOL_VERSION } from './config-store.js';
const MAX_BODY_BYTES = 1 << 20;
const SSE_HEARTBEAT_MS = 15000;
const READ_ONLY_GET = new Set(['snapshot', 'history', 'advice', 'track', 'watch', 'tag']);
function timingSafeEq(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
export function createDaemonHttpServer(opts) {
    const { engine, token } = opts;
    const sseClients = new Set();
    const replayBuffer = [];
    const REPLAY_MAX = 20;
    engine.subscribe((ev) => {
        replayBuffer.push(ev);
        if (replayBuffer.length > REPLAY_MAX)
            replayBuffer.shift();
        const frame = 'event: ' + ev.type.replace(/^lab\//, '') + '\ndata: ' + JSON.stringify(ev.data) + '\n\n';
        for (const res of sseClients) {
            try {
                res.write(frame);
            }
            catch { /* 断连由 close 处理 */ }
        }
    });
    let heartbeat = null;
    const server = createServer((req, res) => {
        void handle(req, res);
    });
    function bearerOf(req) {
        const h = req.headers.authorization;
        if (typeof h !== 'string')
            return null;
        const m = h.match(/^Bearer\s+(\S+)\s*$/i);
        return m ? m[1] : null;
    }
    function authOk(req) {
        const b = bearerOf(req);
        return !!b && timingSafeEq(b, token);
    }
    function finish(res, code, payload) {
        if (res.writableEnded)
            return;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    }
    function readBody(req, res, cb) {
        const cl = Number(req.headers['content-length']);
        if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
            finish(res, 413, { ok: false, error: 'payload too large (>' + MAX_BODY_BYTES + 'B)' });
            req.destroy();
            return;
        }
        let body = '';
        let tooLarge = false;
        req.on('data', (chunk) => {
            if (tooLarge)
                return;
            body += chunk.toString('utf8');
            if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
                tooLarge = true;
                finish(res, 413, { ok: false, error: 'payload too large (>' + MAX_BODY_BYTES + 'B)' });
                req.destroy();
            }
        });
        req.on('end', () => {
            if (tooLarge)
                return;
            try {
                cb(body ? JSON.parse(body) : {});
            }
            catch (e) {
                finish(res, 400, { ok: false, error: e instanceof Error ? e.message : 'bad json' });
            }
        });
        req.on('error', () => {
            if (!tooLarge)
                finish(res, 400, { ok: false, error: 'request error' });
        });
    }
    function sseHandler(req, res) {
        if (!authOk(req)) {
            finish(res, 401, { ok: false, error: 'unauthorized: bearer token required' });
            return;
        }
        if (sseClients.size >= opts.maxSseClients) {
            finish(res, 503, { ok: false, error: 'sse client limit reached' });
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        res.write(':connected\n\n');
        for (const ev of replayBuffer) {
            res.write('event: ' + ev.type.replace(/^lab\//, '') + '\ndata: ' + JSON.stringify(ev.data) + '\n\n');
        }
        sseClients.add(res);
        if (!heartbeat) {
            heartbeat = setInterval(() => {
                for (const c of sseClients) {
                    try {
                        c.write(':heartbeat ' + Date.now() + '\n\n');
                    }
                    catch { /* 断连清理 */ }
                }
            }, SSE_HEARTBEAT_MS);
            heartbeat.unref?.();
        }
        req.on('close', () => {
            sseClients.delete(res);
            if (!sseClients.size && heartbeat) {
                clearInterval(heartbeat);
                heartbeat = null;
            }
        });
    }
    async function handle(req, res) {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const path = url.pathname;
        if (path === '/health') {
            finish(res, 200, {
                ok: true,
                version: DAEMON_VERSION,
                uptimeMs: Date.now() - engine.startedAtMs(),
                currentDevice: engine.currentDevice(),
                protocolVersion: PROTOCOL_VERSION,
                // 迁移未做：没有 admin/import-settings，configFresh 保持 true（尚未做过 settings 迁移）
                configFresh: true,
            });
            return;
        }
        if (path === '/lab-monitor/events') {
            sseHandler(req, res);
            return;
        }
        if (path === '/mcp') {
            if (!opts.mcpEnabled) {
                finish(res, 404, { ok: false, error: 'mcp disabled' });
                return;
            }
            if (!authOk(req)) {
                finish(res, 401, { ok: false, error: 'unauthorized: bearer token required' });
                return;
            }
            if (req.method !== 'POST') {
                finish(res, 405, { ok: false, error: 'POST required' });
                return;
            }
            readBody(req, res, (body) => {
                const r = handleMcp(engine, opts.mcpAllowControl, body);
                if (r.status === 202) {
                    res.writeHead(202).end();
                    return;
                }
                finish(res, r.status, r.json);
            });
            return;
        }
        if (path.startsWith('/lab-monitor/api/')) {
            const method = path.slice('/lab-monitor/api/'.length);
            if (!method || method.includes('/')) {
                finish(res, 404, { ok: false, error: '未知方法: ' + method });
                return;
            }
            if (req.method === 'GET') {
                if (!READ_ONLY_GET.has(method)) {
                    finish(res, 405, { ok: false, error: 'method not allowed for GET: ' + method });
                    return;
                }
                const out = engine.dispatch(method, {});
                void Promise.resolve(out).then((r) => finish(res, 200, r)).catch((e) => finish(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }));
                return;
            }
            if (req.method !== 'POST') {
                finish(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            // 写通道：bearer 必须（浏览器跨站 fetch 无法携带自定义 Authorization 而不触发预检，本服务不响应预检）
            if (!authOk(req)) {
                finish(res, 403, { ok: false, error: 'forbidden: bearer token required for POST' });
                return;
            }
            readBody(req, res, (body) => {
                try {
                    const out = engine.dispatch(method, body);
                    void Promise.resolve(out)
                        .then((r) => finish(res, 200, r))
                        .catch((e) => finish(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }));
                }
                catch (e) {
                    finish(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
                }
            });
            return;
        }
        finish(res, 404, { ok: false, error: 'not found' });
    }
    // 优雅关闭：停心跳、断 SSE
    const origClose = server.close.bind(server);
    server.close = ((cb) => {
        if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
        }
        for (const c of sseClients) {
            try {
                c.end();
            }
            catch { /* 已断 */ }
        }
        sseClients.clear();
        return origClose(cb);
    });
    return server;
}
export function listenOn(server, port, host, onListening) {
    return new Promise((resolve, reject) => {
        const onError = (e) => {
            server.off('listening', onOk);
            reject(e);
        };
        const onOk = () => {
            const addr = server.address();
            const p = addr && typeof addr === 'object' ? addr.port : port;
            server.off('error', onError);
            onListening?.(p);
            resolve(p);
        };
        server.once('error', onError);
        server.once('listening', onOk);
        server.listen(port, host);
    });
}
