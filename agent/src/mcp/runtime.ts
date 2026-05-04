import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { WorkspaceServiceStatus } from '../runtime/service/types';
import type { PortAllocator } from '../runtime/service/ports';
import type { WorkspaceTabs } from '../runtime/workspace/tabs';
import type { RunStepsDeps } from '../runner/run_steps_types';
import type { RunnerConfig } from '../config';
import { createWorkspaceToolHandlers } from './tool_handlers';
import { resolveEnabledToolNames, getToolSpecs } from './tool_registry';
import { createMcpHttpServer, stopMcpHttpServer } from './server_runtime';
import type { McpToolHandler } from './tool_handlers';

export type WorkspaceMcpRuntime = {
    start: () => Promise<{ port: number; status: WorkspaceServiceStatus }>;
    stop: () => Promise<{ status: WorkspaceServiceStatus }>;
    status: () => { port: number | null; status: WorkspaceServiceStatus };
};

export type WorkspaceMcpRuntimeDeps = {
    workspace: { name: string; tabs: WorkspaceTabs };
    portAllocator: PortAllocator;
    runStepsDeps?: RunStepsDeps;
    config?: RunnerConfig;
    log?: (...args: unknown[]) => void;
};

const SERVICE_NAME = 'mcp';

export const createWorkspaceMcpRuntime = (deps: WorkspaceMcpRuntimeDeps): WorkspaceMcpRuntime => {
    let currentStatus: WorkspaceServiceStatus = 'stopped';
    let server: Server | null = null;
    let allocatedPort: number | null = null;
    let serverStop: (() => Promise<void>) | null = null;

    const resolveHandlers = (): Record<string, McpToolHandler> => {
        const handlers = createWorkspaceToolHandlers({
            workspace: deps.workspace,
            runStepsDeps: deps.runStepsDeps,
            config: deps.config,
            log: deps.log,
            getPage: (tabName: string, startUrl?: string) => deps.workspace.tabs.ensurePage(tabName, startUrl),
        });
        const enabledTools = resolveEnabledToolNames(deps.config?.mcpPolicy);
        if (!enabledTools) {return handlers;}
        return Object.fromEntries(
            Object.entries(handlers).filter(([name]) => enabledTools.has(name)),
        );
    };

    const resolveTools = () => {
        const enabledTools = resolveEnabledToolNames(deps.config?.mcpPolicy);
        return getToolSpecs({ enabledTools });
    };

    return {
        async start() {
            if (currentStatus === 'running' && allocatedPort !== null) {
                return { port: allocatedPort, status: currentStatus };
            }
            if (currentStatus === 'starting') {
                throw new Error('mcp service is already starting');
            }

            currentStatus = 'starting';
            try {
                const port = await deps.portAllocator.allocate(deps.workspace.name, SERVICE_NAME);
                allocatedPort = port;

                const handlers = resolveHandlers();
                const tools = resolveTools();
                const { server: mcpServer, stop } = await createMcpHttpServer({
                    handlers,
                    tools,
                    port,
                    log: deps.log,
                });
                server = mcpServer;
                serverStop = stop;
                currentStatus = 'running';
                deps.log?.('workspace mcp server started', {
                    workspaceName: deps.workspace.name,
                    port,
                });
                return { port, status: currentStatus };
            } catch (error) {
                currentStatus = 'failed';
                if (allocatedPort !== null) {
                    deps.portAllocator.release(deps.workspace.name, SERVICE_NAME);
                    allocatedPort = null;
                }
                throw error;
            }
        },

        async stop() {
            if (currentStatus === 'stopped') {
                return { status: currentStatus };
            }
            currentStatus = 'stopping';
            try {
                if (serverStop) {
                    await serverStop();
                    serverStop = null;
                }
                server = null;
                if (allocatedPort !== null) {
                    deps.portAllocator.release(deps.workspace.name, SERVICE_NAME);
                    allocatedPort = null;
                }
                currentStatus = 'stopped';
                deps.log?.('workspace mcp server stopped', {
                    workspaceName: deps.workspace.name,
                });
                return { status: currentStatus };
            } catch (error) {
                currentStatus = 'failed';
                throw error;
            }
        },

        status() {
            return { port: allocatedPort, status: currentStatus };
        },
    };
};
