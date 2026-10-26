/**
 * daemon HTTP 数据面（node:http，仅绑 127.0.0.1）
 * - GET /health 不鉴权
 * - GET /lab-monitor/api/{snapshot,history,advice} 只读不鉴权（forwarder/curl SOP 零改动）
 * - GET /lab-monitor/api/{track,watch,tag} 列表只读；POST 一律须 Authorization: Bearer <token>
 * - POST body 上限 1MiB → 413
 * - GET /lab-monitor/events SSE：token 必须，连接上限 maxSseClients（默认 8），15s 心跳
 * - POST /mcp：token 必须，转发 mcp.handleMcp
 */
import { type Server } from 'node:http';
import type { Engine } from './engine.js';
export interface HttpServerOptions {
    engine: Engine;
    token: string;
    maxSseClients: number;
    mcpEnabled: boolean;
    mcpAllowControl: boolean;
    /** listen 成功后回调（main 用它写 daemon.json） */
    onListening?: (port: number) => void;
}
export declare function createDaemonHttpServer(opts: HttpServerOptions): Server;
export declare function listenOn(server: Server, port: number, host: string, onListening?: (port: number) => void): Promise<number>;
