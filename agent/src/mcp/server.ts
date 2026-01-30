import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ERROR_CODES } from '../runner/error_codes';
import { errorResult } from '../runner/results';
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
                name: 'browser.snapshot',
                description: 'Return page metadata or run an a11y scan.',
                inputSchema: toolInputJsonSchemas['browser.snapshot'],
            },
            {
                name: 'browser.click',
                description: 'Click an element using a resolver-compatible target.',
                inputSchema: toolInputJsonSchemas['browser.click'],
            },
            {
                name: 'browser.type',
                description: 'Type text into an element using a resolver-compatible target.',
                inputSchema: toolInputJsonSchemas['browser.type'],
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

export const startMcpServer = async (deps: McpToolDeps) => {
    const server = createMcpServer(deps);
    server.onerror = (error: unknown) => {
        deps.log('mcp error', error);
    };
    const transport = new StdioServerTransport();
    await server.connect(transport);
};
