import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {getToolSpecs, type ToolSpec} from '../../interface/mcp/tool_registry';
import type {McpToolHandler} from '../../interface/mcp/contracts';
import type {WorkspaceMcpToolDeps} from '../../automation/runtime/mcp/tool_handlers';
import {getToolHandlers} from '../../automation/runtime/mcp/tool_registry';
import type {AgentWorldRevision} from '../trace/collector';
import {resolveAgentBrowserReadToolNames, resolveAgentBrowserToolNames} from './policy';

const stringify = (value: unknown): string => {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

const toolError = (name: string, result: Awaited<ReturnType<McpToolHandler>>): Error =>
    new Error(stringify({
        tool: name,
        error: result.error ?? {code: 'ERR_TOOL_FAILED', message: `${name} failed`},
        results: result.results,
    }));

export const createAgentToolsFromHandlers = (
    specs: readonly ToolSpec[],
    handlers: Readonly<Record<string, McpToolHandler>>,
): AgentTool[] => specs.map((spec) => {
    const handler = handlers[spec.name];
    return {
        name: spec.name,
        label: spec.name,
        description: spec.description,
        parameters: Type.Unsafe(spec.inputSchema),
        execute: async (_toolCallId, params) => {
            const result = await handler(params);
            if (!result.ok) {throw toolError(spec.name, result);}
            return {
                content: [{type: 'text' as const, text: stringify(result)}],
                details: result,
            };
        },
    };
});

export const createWorkspaceAgentTools = (deps: WorkspaceMcpToolDeps): AgentTool[] => {
    const enabledTools = resolveAgentBrowserToolNames();
    return createAgentToolsFromHandlers(
        getToolSpecs({enabledTools}),
        getToolHandlers(deps, {enabledTools}),
    );
};

export const createWorkspaceAgentReadTools = (deps: WorkspaceMcpToolDeps): AgentTool[] => {
    const enabledTools = resolveAgentBrowserReadToolNames();
    return createAgentToolsFromHandlers(
        getToolSpecs({enabledTools}),
        getToolHandlers(deps, {enabledTools}),
    ).map((tool) => {
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
