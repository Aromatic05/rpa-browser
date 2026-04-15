import { createToolHandlers, type McpToolDeps } from './tool_handlers';
import { getToolSpecs } from './tool_registry';
import type { McpToolRuntime } from './server';

export const createMcpToolRuntime = (deps: McpToolDeps): McpToolRuntime => ({
    handlers: createToolHandlers(deps),
    tools: getToolSpecs(),
});

export default createMcpToolRuntime;
