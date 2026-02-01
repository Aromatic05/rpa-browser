import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
                description: 'Return page metadata or run an a11y scan.',
                inputSchema: toolInputJsonSchemas['browser.snapshot'],
            },
            {
                name: 'browser.take_screenshot',
                description: 'Capture a screenshot for the page or target.',
                inputSchema: toolInputJsonSchemas['browser.take_screenshot'],
            },
            {
                name: 'browser.click',
                description: 'Click an element using an a11y node id.',
                inputSchema: toolInputJsonSchemas['browser.click'],
            },
            {
                name: 'browser.fill',
                description: 'Fill an element using an a11y node id.',
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

export const startMcpServer = async (deps: McpToolDeps) => {
    const server = createMcpServer(deps);
    server.onerror = (error: unknown) => {
        deps.log('mcp error', error);
    };
    const transport = new StdioServerTransport();
    await server.connect(transport);
};
