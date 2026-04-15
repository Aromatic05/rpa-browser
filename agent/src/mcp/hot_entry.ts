import type { McpToolDeps } from './tool_handlers';
import { getToolHandlers, getToolSpecs, resolveEnabledToolNames } from './tool_registry';
import type { McpToolRuntime } from './server';

export const createMcpToolRuntime = (deps: McpToolDeps): McpToolRuntime => {
    const enabledTools = resolveEnabledToolNames();
    return {
        handlers: getToolHandlers(deps, { enabledTools }),
        tools: getToolSpecs({ enabledTools }),
    };
};

export default createMcpToolRuntime;
