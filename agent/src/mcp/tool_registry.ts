import { createToolHandlers } from './tool_handlers';
import { toolInputJsonSchemas } from './schemas';
import type { PageRegistry } from '../runtime/page_registry';
import type { McpToolDeps, McpToolHandler } from './tool_handlers';
import type { RunnerConfig, McpToolGroup } from '../config';
import { defaultRunnerConfig } from '../config/defaults';

export type ToolSpec = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
};

export type ToolGroup = McpToolGroup;

type ToolDefinition = {
    name: string;
    description: string;
    group: ToolGroup;
};

const toolDefinitions: ToolDefinition[] = [
    { name: 'browser.create_tab', description: 'Create tab.', group: 'tab_navigation' },
    { name: 'browser.list_tabs', description: 'List tabs.', group: 'tab_navigation' },
    { name: 'browser.switch_tab', description: 'Switch tab.', group: 'tab_navigation' },
    { name: 'browser.close_tab', description: 'Close tab.', group: 'tab_navigation' },
    { name: 'browser.goto', description: 'Navigate URL.', group: 'tab_navigation' },
    { name: 'browser.go_back', description: 'Go back.', group: 'tab_navigation' },
    { name: 'browser.reload', description: 'Reload page.', group: 'tab_navigation' },
    { name: 'browser.get_page_info', description: 'Page info.', group: 'tab_navigation' },
    { name: 'browser.snapshot', description: 'Snapshot view.', group: 'structured_inspection' },
    { name: 'browser.get_content', description: 'Resolve content ref.', group: 'structured_inspection' },
    { name: 'browser.list_entities', description: 'List entities.', group: 'business_entities' },
    { name: 'browser.get_entity', description: 'Get entity.', group: 'business_entities' },
    { name: 'browser.find_entities', description: 'Find entities.', group: 'business_entities' },
    { name: 'browser.query_entity', description: 'Query business entity.', group: 'business_entities' },
    { name: 'browser.add_entity', description: 'Add entity overlay.', group: 'business_entities' },
    { name: 'browser.delete_entity', description: 'Delete entity overlay.', group: 'business_entities' },
    { name: 'browser.rename_entity', description: 'Rename entity.', group: 'business_entities' },
    { name: 'browser.click', description: 'Click target.', group: 'actions' },
    { name: 'browser.fill', description: 'Fill input.', group: 'actions' },
    { name: 'browser.type', description: 'Type text.', group: 'actions' },
    { name: 'browser.select_option', description: 'Select option.', group: 'actions' },
    { name: 'browser.batch', description: 'Batch actions.', group: 'actions' },
    { name: 'browser.hover', description: 'Hover target.', group: 'actions' },
    { name: 'browser.scroll', description: 'Scroll page/element.', group: 'actions' },
    { name: 'browser.press_key', description: 'Press key.', group: 'actions' },
    { name: 'browser.drag_and_drop', description: 'Drag and drop.', group: 'actions' },
    { name: 'browser.read_console', description: 'Read console.', group: 'debugging' },
    { name: 'browser.read_network', description: 'Read network.', group: 'debugging' },
    { name: 'browser.evaluate', description: 'Evaluate JS.', group: 'debugging' },
    { name: 'browser.take_screenshot', description: 'Take screenshot.', group: 'debugging' },
    { name: 'browser.mouse', description: 'Low-level mouse.', group: 'debugging' },
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

const pruneSchema = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        const next = value.map((item) => pruneSchema(item)).filter((item) => item !== undefined);
        return next.length > 0 ? next : undefined;
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    const obj = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
        if (key === 'additionalProperties' && child === false) {continue;}
        const pruned = pruneSchema(child);
        if (pruned === undefined) {continue;}
        if (key === 'required' && Array.isArray(pruned) && pruned.length === 0) {continue;}
        if (key === 'properties' && pruned && typeof pruned === 'object' && !Array.isArray(pruned) && Object.keys(pruned).length === 0)
            {continue;}
        next[key] = pruned;
    }
    return Object.keys(next).length > 0 ? next : undefined;
};

const compactInputSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
    const stripped = stripTabTokenSchema(schema);
    const compacted = pruneSchema(stripped);
    return (compacted && typeof compacted === 'object' ? compacted : { type: 'object' }) as Record<string, unknown>;
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

const isKnownTool = (name: string): boolean => toolDefinitions.some((tool) => tool.name === name);

const isKnownGroup = (group: string): group is ToolGroup =>
    group === 'tab_navigation' ||
    group === 'structured_inspection' ||
    group === 'business_entities' ||
    group === 'actions' ||
    group === 'debugging';

export const resolveEnabledToolNames = (policy?: Partial<RunnerConfig['mcpPolicy']>): Set<string> => {
    const resolved = {
        ...defaultRunnerConfig.mcpPolicy,
        ...(policy || {}),
    };
    const groups = (resolved.enabledToolGroups || []).filter(isKnownGroup);
    const enableTools = (resolved.enableTools || []).filter(isKnownTool);
    const disableTools = (resolved.disableTools || []).filter(isKnownTool);

    let selected = new Set(toolDefinitions.map((tool) => tool.name));

    if (groups.length > 0) {
        selected = new Set(toolDefinitions.filter((tool) => groups.includes(tool.group)).map((tool) => tool.name));
    }

    for (const name of enableTools) {
        selected.add(name);
    }
    for (const name of disableTools) {
        selected.delete(name);
    }
    return selected;
};

const selectToolDefinitions = (enabledTools?: Set<string>): ToolDefinition[] =>
    toolDefinitions.filter((tool) => !enabledTools || enabledTools.has(tool.name));

export const getToolSpecs = (options?: { enabledTools?: Set<string> }): ToolSpec[] =>
    selectToolDefinitions(options?.enabledTools).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: compactInputSchema(toolInputJsonSchemas[tool.name as keyof typeof toolInputJsonSchemas]),
    }));

export const getToolHandlers = (
    deps: McpToolDeps,
    options?: { enabledTools?: Set<string> },
): Record<string, McpToolHandler> => {
    const handlers = createToolHandlers(deps);
    if (!options?.enabledTools) {return handlers;}
    return Object.fromEntries(Object.entries(handlers).filter(([name]) => options.enabledTools!.has(name)));
};

export const executeTool = async (
    deps: ToolRegistryDeps & { config?: RunnerConfig },
    name: string,
    args: unknown,
    options?: ExecuteToolOptions,
): Promise<{ ok: boolean; results: unknown[]; trace?: unknown; error?: unknown }> => {
    const enabledTools = resolveEnabledToolNames(deps.config?.mcpPolicy);
    const handlers = getToolHandlers({ pageRegistry: deps.pageRegistry }, { enabledTools });
    const handler = handlers[name];
    if (!handler) {
        return {
            ok: false,
            results: [{ stepId: 'invalid', ok: false, error: { code: 'ERR_UNSUPPORTED', message: `unknown tool: ${name}` } }],
            error: { code: 'ERR_UNSUPPORTED', message: `unknown tool: ${name}` },
        };
    }

    const tabToken = await resolveTabToken(deps, options);
    return await handler(withTabToken(args, tabToken));
};
