import type {McpToolHandler, McpToolResult} from '../../../interface/mcp/contracts';
import {resolveEnabledToolNames} from '../../../interface/mcp/tool_registry';
import {createWorkspaceToolHandlers, type WorkspaceMcpToolDeps} from './tool_handlers';

export const getToolHandlers = (
    deps: WorkspaceMcpToolDeps,
    options?: {enabledTools?: Set<string>},
): Record<string, McpToolHandler> => {
    const handlers = createWorkspaceToolHandlers(deps);
    const enabledTools = options?.enabledTools;
    if (!enabledTools) {return handlers;}
    return Object.fromEntries(Object.entries(handlers).filter(([name]) => enabledTools.has(name)));
};

export const executeTool = async (
    deps: WorkspaceMcpToolDeps,
    name: string,
    args: unknown,
): Promise<McpToolResult> => {
    const enabledTools = resolveEnabledToolNames(deps.config?.mcpPolicy);
    const handlers = getToolHandlers(deps, {enabledTools});
    if (!Object.hasOwn(handlers, name)) {
        const error = {code: 'ERR_UNSUPPORTED', message: `unknown tool: ${name}`};
        return {ok: false, results: [{stepId: 'invalid', ok: false, error}], error};
    }
    return await handlers[name](args);
};
