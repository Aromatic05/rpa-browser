import type { WorkspaceServiceStatus } from '../service/types';
import type { PortAllocator } from '../service/ports';
import type { WorkspaceTabs } from '../workspace/tabs';
import type { RunStepsDeps } from '../../runner/run_steps_types';
import type { RunnerConfig } from '../../../platform/config';
import { createWorkspaceToolHandlers } from './tool_handlers';
import { resolveEnabledToolNames, getToolSpecs } from '../../../interface/mcp/tool_registry';
import { createMcpHttpServer } from '../../../interface/mcp/server_runtime';
import type { McpToolHandler } from '../../../interface/mcp/contracts';

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
    runWorkspaceExecution?: <T>(actionType: string, run: () => Promise<T>) => Promise<T>;
};

const SERVICE_NAME = 'mcp';

export const createWorkspaceMcpRuntime = (deps: WorkspaceMcpRuntimeDeps): WorkspaceMcpRuntime => {
    let currentStatus: WorkspaceServiceStatus = 'stopped';
    let allocatedPort: number | null = null;
    let serverStop: (() => Promise<void>) | null = null;

    const resolveHandlers = (): Record<string, McpToolHandler> => {
        const handlers = createWorkspaceToolHandlers({
            workspace: deps.workspace,
            runStepsDeps: deps.runStepsDeps,
            config: deps.config,
            log: deps.log,
            runWorkspaceExecution: deps.runWorkspaceExecution,
            awaitTabPage: (tabName: string, timeoutMs: number) => deps.workspace.tabs.awaitTabPage(tabName, timeoutMs),
        });
        const enabledTools = resolveEnabledToolNames(deps.config?.mcpPolicy);
        return Object.fromEntries(
            Object.entries(handlers).filter(([name]) => enabledTools.has(name)),
        );
    };

    const resolveTools = (): ReturnType<typeof getToolSpecs> => {
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
                const { stop } = await createMcpHttpServer({
                    handlers,
                    tools,
                    port,
                    log: deps.log,
                });
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
