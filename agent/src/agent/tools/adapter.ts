import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {getToolSpecs, type ToolSpec} from '../../interface/mcp/tool_registry';
import type {McpToolHandler} from '../../interface/mcp/contracts';
import type {WorkspaceMcpToolDeps} from '../../automation/runtime/mcp/tool_handlers';
import {getToolHandlers} from '../../automation/runtime/mcp/tool_registry';
import type {AgentWorldRevision} from '../trace/collector';
import {resolveAgentBrowserReadToolNames, resolveAgentBrowserToolNames} from './policy';
import {
    serializeAgentToolError,
    serializeAgentToolResult,
    type ToolResultSizePolicy,
} from './context/limit';

export type AgentToolsAdapterOptions = {
    resultSizePolicy?: ToolResultSizePolicy;
};

const toolError = (
    name: string,
    result: Awaited<ReturnType<McpToolHandler>>,
    policy?: ToolResultSizePolicy,
): Error => new Error(serializeAgentToolError(name, {
    tool: name,
    error: result.error ?? {code: 'ERR_TOOL_FAILED', message: `${name} failed`},
    results: result.results,
}, policy));

export const createAgentToolsFromHandlers = (
    specs: readonly ToolSpec[],
    handlers: Readonly<Record<string, McpToolHandler>>,
    options: AgentToolsAdapterOptions = {},
): AgentTool[] => specs.map((spec) => {
    const handler = handlers[spec.name];
    return {
        name: spec.name,
        label: spec.name,
        description: spec.description,
        parameters: Type.Unsafe(spec.inputSchema),
        execute: async (_toolCallId, params) => {
            const result = await handler(params);
            if (!result.ok) {throw toolError(spec.name, result, options.resultSizePolicy);}
            const content = serializeAgentToolResult(spec.name, result, options.resultSizePolicy);
            return {
                content: [{type: 'text' as const, text: content.text}],
                details: result,
            };
        },
    };
});

export const createWorkspaceAgentTools = (
    deps: WorkspaceMcpToolDeps,
    options: AgentToolsAdapterOptions = {},
): AgentTool[] => {
    const enabledTools = resolveAgentBrowserToolNames();
    return createAgentToolsFromHandlers(
        getToolSpecs({enabledTools}),
        getToolHandlers(deps, {enabledTools}),
        options,
    );
};

export const createWorkspaceAgentReadTools = (
    deps: WorkspaceMcpToolDeps,
    options: AgentToolsAdapterOptions = {},
): AgentTool[] => {
    const enabledTools = resolveAgentBrowserReadToolNames();
    return createAgentToolsFromHandlers(
        getToolSpecs({enabledTools}),
        getToolHandlers(deps, {enabledTools}),
        options,
    ).map((tool) => {
        if (tool.name === 'browser.snapshot') {
            return {
                ...tool,
                description: 'Primary first inspection for the active page. Use this to understand visible DOM/ARIA structure and identify candidate targets before resolving them.',
            };
        }
        if (tool.name === 'browser.get_page_info') {
            return {
                ...tool,
                description: 'Read page-level metadata only when URL/title/viewport details are specifically needed and not already clear from inspection. Do not call this routinely after browser.snapshot for an ordinary form task.',
            };
        }
        if (tool.name === 'browser.list_tabs') {
            return {
                ...tool,
                description: 'List tabs only when the task is genuinely multi-tab or the active tab is ambiguous. For ordinary current-page tasks, inspect the active page directly with browser.snapshot.',
            };
        }
        if (tool.name === 'browser.query') {
            return {
                ...tool,
                description: 'Query Snapshot V2 business entities using the canonical business query schema. This is not a generic DOM/ARIA selector lookup. Do not guess a businessTag; use it only when inspection already exposes a real business entity/tag.',
            };
        }
        if (tool.name === 'browser.capture_resolve') {
            return {
                ...tool,
                description: 'Resolve an observed DOM/ARIA target into a stable StepResolve draft. For ordinary form controls without business annotations, call this after browser.snapshot using the observed nodeId/role/name and pass the resolved target into program input.',
            };
        }
        return tool;
    });
};

export const readWorkspaceWorldRevision = (deps: WorkspaceMcpToolDeps): AgentWorldRevision | null => {
    const page = deps.workspace.tabs.getActiveTab()?.page;
    if (!page || !deps.runStepsDeps) {return null;}
    const entry = deps.runStepsDeps.pageSession.read(page);
    if (!entry) {return null;}
    return {
        pageEpoch: entry.identity.pageEpoch,
        captureRevision: entry.identity.captureRevision,
        freshness: deps.runStepsDeps.pageSession.readFreshness(page, page.url()).status,
    };
};
