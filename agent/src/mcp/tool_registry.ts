import { createToolHandlers } from './tool_handlers';
import { toolInputJsonSchemas } from './schemas';
import type { PageRegistry } from '../runtime/page_registry';

export type ToolSpec = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
};

const toolDescriptions: Array<{ name: string; description: string }> = [
    { name: 'browser.goto', description: 'Navigate the current tab to a URL.' },
    { name: 'browser.go_back', description: 'Go back in history for the current tab.' },
    { name: 'browser.reload', description: 'Reload the current tab.' },
    { name: 'browser.create_tab', description: 'Create a new tab in the current workspace.' },
    { name: 'browser.switch_tab', description: 'Switch to a tab by id.' },
    { name: 'browser.close_tab', description: 'Close a tab by id or the current tab.' },
    { name: 'browser.get_page_info', description: 'Return page metadata and tab list.' },
    { name: 'browser.snapshot', description: 'Return a structured UnifiedNode snapshot tree, with optional contain/depth/filter/diff view.' },
    { name: 'browser.list_entities', description: 'List entities from the final snapshot entity view.' },
    { name: 'browser.get_entity', description: 'Get entity information by snapshot nodeId.' },
    { name: 'browser.find_entities', description: 'Find entities by query, kind, and business tag.' },
    { name: 'browser.add_entity', description: 'Add an overlay entity on a snapshot node.' },
    { name: 'browser.delete_entity', description: 'Suppress entity interpretation on a snapshot node.' },
    { name: 'browser.rename_entity', description: 'Rename a snapshot node by nodeId.' },
    { name: 'browser.get_content', description: 'Resolve snapshot content by content ref.' },
    { name: 'browser.read_console', description: 'Read recent console entries from the active tab.' },
    { name: 'browser.read_network', description: 'Read recent network entries from the active tab.' },
    { name: 'browser.evaluate', description: 'Evaluate JavaScript expression in the page context.' },
    { name: 'browser.take_screenshot', description: 'Capture a screenshot for the page or target.' },
    { name: 'browser.click', description: 'Click an element by id or selector.' },
    { name: 'browser.fill', description: 'Fill an element by id or selector.' },
    { name: 'browser.type', description: 'Type text into a target element.' },
    { name: 'browser.select_option', description: 'Select option values from a target element.' },
    { name: 'browser.hover', description: 'Hover over a target element.' },
    { name: 'browser.scroll', description: 'Scroll the page or a target element into view.' },
    { name: 'browser.press_key', description: 'Press a keyboard key with optional target focus.' },
    { name: 'browser.drag_and_drop', description: 'Drag a source element to a destination.' },
    { name: 'browser.mouse', description: 'Perform a low-level mouse action.' },
];

export type ToolRegistryDeps = {
    pageRegistry: PageRegistry;
    getActiveTabToken: () => Promise<string>;
};

export type ExecuteToolOptions = {
    tabTokenOverride?: string;
};

const resolveTabToken = async (deps: ToolRegistryDeps, options?: ExecuteToolOptions) =>
    options?.tabTokenOverride || (await deps.getActiveTabToken());

const stripTabTokenSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
    const required = Array.isArray(schema.required)
        ? schema.required.filter((item) => item !== 'tabToken')
        : undefined;
    const properties =
        schema.properties && typeof schema.properties === 'object'
            ? Object.fromEntries(
                  Object.entries(schema.properties as Record<string, unknown>).filter(([key]) => key !== 'tabToken'),
              )
            : undefined;

    return {
        ...schema,
        ...(required ? { required } : {}),
        ...(properties ? { properties } : {}),
    };
};

const withTabToken = (args: unknown, tabToken: string): unknown => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { tabToken };
    }
    const rec = args as Record<string, unknown>;
    if (typeof rec.tabToken === 'string' && rec.tabToken.length > 0) {
        return args;
    }
    return { ...rec, tabToken };
};

export const getToolSpecs = (): ToolSpec[] =>
    toolDescriptions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: stripTabTokenSchema(toolInputJsonSchemas[tool.name as keyof typeof toolInputJsonSchemas]),
    }));

export const executeTool = async (
    deps: ToolRegistryDeps,
    name: string,
    args: unknown,
    options?: ExecuteToolOptions,
): Promise<{ ok: boolean; results: unknown[]; trace?: unknown; error?: unknown }> => {
    const handlers = createToolHandlers({ pageRegistry: deps.pageRegistry });
    const handler = handlers[name];
    if (!handler) {
        return {
            ok: false,
            results: [{ stepId: 'invalid', ok: false, error: { code: 'ERR_UNSUPPORTED', message: `unknown tool: ${name}` } }],
            error: { code: 'ERR_UNSUPPORTED', message: `unknown tool: ${name}` },
        };
    }

    const tabToken = await resolveTabToken(deps, options);
    return handler(withTabToken(args, tabToken));
};
