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
import { createToolHandlers, type McpToolDeps } from './tool_handlers';
import { toolInputJsonSchemas } from './schemas';

export const createMcpServer = (deps: McpToolDeps) => {
    const server = new Server(
        { name: 'rpa-agent', version: '0.1.0' },
        { capabilities: { tools: {} } },
    );
    const handlers = createToolHandlers(deps);

    server.setRequestHandler(InitializeRequestSchema, async (request: any) => ({
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'rpa-agent', version: '0.1.0' },
    }));

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: 'browser.goto',
                description: 'Navigate the current tab to a URL.',
                inputSchema: toolInputJsonSchemas['browser.goto'],
            },
            {
                name: 'browser.go_back',
                description: 'Go back in history for the current tab.',
                inputSchema: toolInputJsonSchemas['browser.go_back'],
            },
            {
                name: 'browser.reload',
                description: 'Reload the current tab.',
                inputSchema: toolInputJsonSchemas['browser.reload'],
            },
            {
                name: 'browser.create_tab',
                description: 'Create a new tab in the current workspace.',
                inputSchema: toolInputJsonSchemas['browser.create_tab'],
            },
            {
                name: 'browser.switch_tab',
                description: 'Switch to a tab by id.',
                inputSchema: toolInputJsonSchemas['browser.switch_tab'],
            },
            {
                name: 'browser.close_tab',
                description: 'Close a tab by id or the current tab.',
                inputSchema: toolInputJsonSchemas['browser.close_tab'],
            },
            {
                name: 'browser.get_page_info',
                description: 'Return page metadata and tab list.',
                inputSchema: toolInputJsonSchemas['browser.get_page_info'],
            },
            {
                name: 'browser.snapshot',
                description: 'Return the latest structured UnifiedNode snapshot tree.',
                inputSchema: toolInputJsonSchemas['browser.snapshot'],
            },
            {
                name: 'browser.get_content',
                description: 'Resolve snapshot content by content ref.',
                inputSchema: toolInputJsonSchemas['browser.get_content'],
            },
            {
                name: 'browser.read_console',
                description: 'Read recent console entries from the active tab.',
                inputSchema: toolInputJsonSchemas['browser.read_console'],
            },
            {
                name: 'browser.read_network',
                description: 'Read recent network entries from the active tab.',
                inputSchema: toolInputJsonSchemas['browser.read_network'],
            },
            {
                name: 'browser.evaluate',
                description: 'Evaluate JavaScript expression in the page context.',
                inputSchema: toolInputJsonSchemas['browser.evaluate'],
            },
            {
                name: 'browser.take_screenshot',
                description: 'Capture a screenshot for the page or target.',
                inputSchema: toolInputJsonSchemas['browser.take_screenshot'],
            },
            {
                name: 'browser.click',
                description: 'Click an element by id or selector.',
                inputSchema: toolInputJsonSchemas['browser.click'],
            },
            {
                name: 'browser.fill',
                description: 'Fill an element by id or selector.',
                inputSchema: toolInputJsonSchemas['browser.fill'],
            },
            {
                name: 'browser.type',
                description: 'Type text into a target element.',
                inputSchema: toolInputJsonSchemas['browser.type'],
            },
            {
                name: 'browser.select_option',
                description: 'Select option values from a target element.',
                inputSchema: toolInputJsonSchemas['browser.select_option'],
            },
            {
                name: 'browser.hover',
                description: 'Hover over a target element.',
                inputSchema: toolInputJsonSchemas['browser.hover'],
            },
            {
                name: 'browser.scroll',
                description: 'Scroll the page or a target element into view.',
                inputSchema: toolInputJsonSchemas['browser.scroll'],
            },
            {
                name: 'browser.press_key',
                description: 'Press a keyboard key with optional target focus.',
                inputSchema: toolInputJsonSchemas['browser.press_key'],
            },
            {
                name: 'browser.drag_and_drop',
                description: 'Drag a source element to a destination.',
                inputSchema: toolInputJsonSchemas['browser.drag_and_drop'],
            },
            {
                name: 'browser.mouse',
                description: 'Perform a low-level mouse action.',
                inputSchema: toolInputJsonSchemas['browser.mouse'],
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
        const name = request.params.name;
        const args = request.params.arguments ?? {};
        const handler = handlers[name];
        if (!handler) {
            const error = errorResult('', ERROR_CODES.ERR_UNSUPPORTED, `unknown tool: ${name}`);
            return {
                content: [{ type: 'text', text: JSON.stringify(error) }],
                isError: true,
            };
        }
        try {
            const result = await handler(args);
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                isError: !result.ok,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const result = errorResult('', ERROR_CODES.ERR_BAD_ARGS, message);
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
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

export const startMcpServer = async (deps: McpToolDeps, options: McpHttpOptions = {}) => {
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
