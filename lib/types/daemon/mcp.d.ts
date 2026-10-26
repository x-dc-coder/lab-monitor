/**
 * HTTP MCP facade（/mcp，streamable HTTP JSON-RPC 子集：initialize / tools/list / tools/call）
 * 工具 = lab_status / lab_advice / lab_ctl，直调 engine.dispatch（无自环 HTTP、无 stdio 子进程）。
 * lab_ctl 受 config mcp.allowControl 门控（false 时工具调用返回 isError）。
 */
import type { Engine } from './engine.js';
/** 返回 { status, json }；status=401 由 http 层在鉴权失败时决定，这里只处理已通过鉴权的请求体 */
export declare function handleMcp(engine: Engine, allowControl: boolean, raw: unknown): {
    status: number;
    json: Record<string, unknown>;
};
