import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ERROR_CODES } from '../actions/error_codes';
import { errorResult } from '../actions/results';
import type { McpToolDeps, McpToolHandler } from './tool_handlers';
import { getToolHandlers, getToolSpecs, resolveEnabledToolNames, type ToolSpec } from './tool_registry';

export type McpToolRuntime = {
    handlers: Record<string, McpToolHandler>;
    tools: ToolSpec[];
};

export type McpServerDeps = McpToolDeps & {
    resolveToolRuntime?: () => McpToolRuntime;
};

const createDefaultRuntime = (deps: McpToolDeps): McpToolRuntime => {
    const enabledTools = resolveEnabledToolNames(deps.config?.mcpPolicy);
    return {
        handlers: getToolHandlers(deps, { enabledTools }),
        tools: getToolSpecs({ enabledTools }),
    };
};

const isDebugMode = (): boolean => /^(1|true|on)$/i.test(String(process.env.RPA_MCP_DEBUG || '').trim());

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
        const failed = (result.results || []).find((item) => (item as { ok?: boolean })?.ok === false) as
            | { error?: unknown }
            | undefined;
        return { ok: false, error: compactError(result.error || failed?.error) };
    }

    if (name === 'browser.batch') {
        return { ok: true, data: result.results };
    }

    const first = (result.results || [])[0] as { data?: unknown } | undefined;
    if (!first || first.data === undefined) {
        return { ok: true };
    }
    return { ok: true, data: first.data };
};

export const createMcpServer = (deps: McpServerDeps) => {
    const server = new Server(
        { name: 'rpa-agent', version: '0.1.0' },
        { capabilities: { tools: {} } },
    );
    const fallbackRuntime = createDefaultRuntime(deps);
    const resolveRuntime = (): McpToolRuntime => {
        try {
            return deps.resolveToolRuntime?.() || fallbackRuntime;
        } catch (error) {
            deps.log?.('mcp resolve tool runtime failed; fallback to static runtime', error);
            return fallbackRuntime;
        }
    };

    server.setRequestHandler(InitializeRequestSchema, async (request: any) => ({
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'rpa-agent', version: '0.1.0' },
    }));

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: resolveRuntime().tools,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
        const name = request.params.name;
        const args = request.params.arguments ?? {};
        const handler = resolveRuntime().handlers[name];
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

type McpHttpOptions = {
    host?: string;
    port?: number;
    mcpPath?: string;
    healthPath?: string;
};

const normalizePath = (value: string): string => {
    if (!value) return '/';
    return value.startsWith('/') ? value : `/${value}`;
};

const writeJson = (res: http.ServerResponse, status: number, payload: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
};

const readJsonBody = async (req: http.IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
        throw new Error('empty request body');
    }
    return JSON.parse(raw);
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
        // This transport only supports replying to request/response messages.
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
        const message = payload as JSONRPCMessage;
        const isRequest = Boolean(
            message &&
                typeof message === 'object' &&
                'jsonrpc' in message &&
                'method' in message &&
                'id' in message,
        );
        if (isRequest) {
            this.pendingResponses.set(String((message as { id: unknown }).id), res);
        }
        try {
            await this.onmessage?.(message);
            if (!isRequest && !res.writableEnded) {
                // notifications do not expect a response body
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

export const startMcpServer = async (deps: McpServerDeps, options: McpHttpOptions = {}) => {
    const host = options.host || process.env.RPA_MCP_HOST || '127.0.0.1';
    const port = options.port ?? Number(process.env.RPA_MCP_PORT || 17654);
    const mcpPath = normalizePath(options.mcpPath || process.env.RPA_MCP_PATH || '/mcp');
    const healthPath = normalizePath(options.healthPath || process.env.RPA_MCP_HEALTH_PATH || '/health');
    const server = createMcpServer(deps);
    server.onerror = (error: unknown) => {
        deps.log?.('mcp error', error);
    };
    const transport = new HttpPostServerTransport();
    await server.connect(transport);

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
            deps.log?.('mcp http handler error', error);
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

    deps.log?.('MCP HTTP server listening', {
        mcpUrl: `http://${host}:${port}${mcpPath}`,
        healthUrl: `http://${host}:${port}${healthPath}`,
    });
};
