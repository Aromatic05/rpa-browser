import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ERROR_CODES } from '../actions/results';
import { errorResult } from '../actions/results';
import type { McpToolHandler } from './tool_handlers';
import type { ToolSpec } from './tool_registry';

const isDebugMode = (): boolean => /^(1|true|on)$/i.test((process.env.RPA_MCP_DEBUG ?? '').trim());
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const compactError = (raw: unknown): { code: string; message: string; details?: unknown } => {
    const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const code = typeof value.code === 'string' && value.code.length > 0 ? value.code : ERROR_CODES.ERR_BAD_ARGS;
    const message = typeof value.message === 'string' && value.message.length > 0 ? value.message : 'tool execution failed';
    if (isDebugMode() && value.details !== undefined) {
        return { code, message, details: value.details };
    }
    return { code, message };
};

const compactToolResult = (
    name: string,
    result: { ok: boolean; results: unknown[]; error?: unknown },
): { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } } => {
    if (!result.ok) {
        const failed = result.results.find((item) => isRecord(item) && item.ok === false);
        const failedError = failed && isRecord(failed) ? failed.error : undefined;
        return { ok: false, error: compactError(result.error ?? failedError) };
    }

    if (name === 'browser.batch') {
        return { ok: true, data: result.results };
    }

    const first = result.results[0];
    if (!isRecord(first) || first.data === undefined) {
        return { ok: true };
    }
    return { ok: true, data: first.data };
};

const createMcpServer = (handlers: Record<string, McpToolHandler>, tools: ToolSpec[]): Server => {
    const server = new Server(
        { name: 'rpa-agent', version: '0.1.0' },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(InitializeRequestSchema, async (request: unknown) => {
        if (!isRecord(request)) {throw new Error('invalid initialize request');}
        const params = request.params;
        if (!isRecord(params) || typeof params.protocolVersion !== 'string') {
            throw new Error('invalid initialize request params');
        }
        return {
            protocolVersion: params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'rpa-agent', version: '0.1.0' },
        };
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request: unknown) => {
        if (!isRecord(request)) {throw new Error('invalid call_tool request');}
        const params = request.params;
        if (!isRecord(params) || typeof params.name !== 'string') {
            throw new Error('invalid call_tool request params');
        }
        const name = params.name;
        const args = (params.arguments && isRecord(params.arguments))
            ? params.arguments
            : {};
        const handler = handlers[name];
        if (!handler) {
            const error = errorResult('', ERROR_CODES.ERR_UNSUPPORTED, `unknown tool: ${name}`);
            const compact = { ok: false, error: compactError(error.error) };
            return {
                content: [{ type: 'text', text: JSON.stringify(compact) }],
                isError: true,
            };
        }
        try {
            const result = await handler(args);
            const compact = compactToolResult(name, result);
            return {
                content: [{ type: 'text', text: JSON.stringify(compact) }],
                isError: !compact.ok,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const result = errorResult('', ERROR_CODES.ERR_BAD_ARGS, message);
            const compact = { ok: false, error: compactError(result.error) };
            return {
                content: [{ type: 'text', text: JSON.stringify(compact) }],
                isError: true,
            };
        }
    });

    return server;
};

class HttpPostServerTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    private readonly pendingResponses = new Map<string, http.ServerResponse>();

    async start(): Promise<void> {
        // no-op
    }

    async close(): Promise<void> {
        for (const res of this.pendingResponses.values()) {
            if (!res.writableEnded) {
                res.statusCode = 503;
                res.end();
            }
        }
        this.pendingResponses.clear();
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!('id' in message)) {
            return;
        }
        const key = String(message.id);
        const res = this.pendingResponses.get(key);
        if (!res) {
            this.onerror?.(new Error(`MCP HTTP response has no pending request (id=${key})`));
            return;
        }
        this.pendingResponses.delete(key);
        if (!res.writableEnded) {
            writeJson(res, 200, message);
        }
    }

    async handlePostMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const payload = await readJsonBody(req);
        const messageValue = payload;
        const isRequest =
            isRecord(messageValue) &&
            'jsonrpc' in messageValue &&
            'method' in messageValue &&
            'id' in messageValue;
        const message = messageValue as JSONRPCMessage;
        if (isRequest) {
            this.pendingResponses.set(String((message as { id: unknown }).id), res);
        }
        try {
            await this.onmessage?.(message);
            if (!isRequest && !res.writableEnded) {
                res.statusCode = 202;
                res.end();
            }
        } catch (error) {
            if (isRequest) {
                this.pendingResponses.delete(String((message as { id: unknown }).id));
            }
            if (!res.writableEnded) {
                throw error;
            }
        }
    }
}

const normalizePath = (value: string): string => {
    if (!value) {return '/';}
    return value.startsWith('/') ? value : `/${value}`;
};

const writeJson = (res: http.ServerResponse, status: number, payload: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
};

const readJsonBody = async (req: http.IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<unknown>) {
        if (Buffer.isBuffer(chunk)) {
            chunks.push(chunk);
            continue;
        }
        if (chunk instanceof Uint8Array) {
            chunks.push(Buffer.from(chunk));
            continue;
        }
        if (typeof chunk === 'string') {
            chunks.push(Buffer.from(chunk));
            continue;
        }
        chunks.push(Buffer.from(String(chunk)));
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
        throw new Error('empty request body');
    }
    return JSON.parse(raw);
};

export type McpHttpServerOptions = {
    handlers: Record<string, McpToolHandler>;
    tools: ToolSpec[];
    port: number;
    host?: string;
    mcpPath?: string;
    healthPath?: string;
    log?: (...args: unknown[]) => void;
};

export const createMcpHttpServer = async (
    options: McpHttpServerOptions,
): Promise<{ server: Server; stop: () => Promise<void> }> => {
    const host = options.host || process.env.RPA_MCP_HOST || '127.0.0.1';
    const port = options.port;
    const mcpPath = normalizePath(options.mcpPath || process.env.RPA_MCP_PATH || '/mcp');
    const healthPath = normalizePath(options.healthPath || process.env.RPA_MCP_HEALTH_PATH || '/health');

    const mcpServer = createMcpServer(options.handlers, options.tools);
    mcpServer.onerror = (error: unknown) => {
        options.log?.('mcp error', error);
    };
    const transport = new HttpPostServerTransport();
    await mcpServer.connect(transport);

    const app = http.createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
            const path = url.pathname;

            if (req.method === 'GET' && path === healthPath) {
                writeJson(res, 200, {
                    ok: true,
                    transport: 'http',
                    mcpPath,
                });
                return;
            }

            if (req.method === 'POST' && path === mcpPath) {
                await transport.handlePostMessage(req, res);
                return;
            }

            writeJson(res, 404, { error: 'not found' });
        })().catch((error) => {
            options.log?.('mcp http handler error', error);
            if (!res.headersSent) {
                writeJson(res, 500, { error: 'internal error' });
            } else {
                res.end();
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        app.once('error', reject);
        app.listen(port, host, () => {
            app.off('error', reject);
            resolve();
        });
    });

    options.log?.('MCP HTTP server listening', {
        mcpUrl: `http://${host}:${port}${mcpPath}`,
        healthUrl: `http://${host}:${port}${healthPath}`,
    });

    const stop = async (): Promise<void> => {
        await transport.close();
        await mcpServer.close();
        await new Promise<void>((resolve, reject) => {
            app.close((error) => {
                if (error) {reject(error);} else {resolve();}
            });
        });
    };

    return { server: mcpServer, stop };
};

export const stopMcpHttpServer = async (stop: () => Promise<void>): Promise<void> => {
    await stop();
};
