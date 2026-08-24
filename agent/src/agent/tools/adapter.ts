import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {
    getToolHandlers,
    getToolSpecs,
    type ToolSpec,
} from '../../interface/mcp/tool_registry';
import type {McpToolHandler, WorkspaceMcpToolDeps} from '../../interface/mcp/tool_handlers';
import type {AgentWorldRevision} from '../trace/collector';
import {resolveAgentBrowserToolNames} from './policy';

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
