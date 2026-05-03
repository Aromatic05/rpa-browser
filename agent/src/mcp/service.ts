import type {
    WorkspaceService,
    WorkspaceServiceStartResult,
    WorkspaceServiceStopResult,
    WorkspaceServiceStatusResult,
} from '../runtime/service/types';
import { createWorkspaceMcpRuntime, type WorkspaceMcpRuntimeDeps } from './runtime';

export type WorkspaceMcpServiceDeps = WorkspaceMcpRuntimeDeps;

export const createWorkspaceMcpService = (deps: WorkspaceMcpServiceDeps): WorkspaceService => {
    const runtime = createWorkspaceMcpRuntime(deps);

    return {
        name: 'mcp',
        workspaceName: deps.workspace.name,

        async start(): Promise<WorkspaceServiceStartResult> {
            const result = await runtime.start();
            return {
                serviceName: 'mcp',
                workspaceName: deps.workspace.name,
                port: result.port,
                status: result.status,
            };
        },

        async stop(): Promise<WorkspaceServiceStopResult> {
            const result = await runtime.stop();
            return {
                serviceName: 'mcp',
                workspaceName: deps.workspace.name,
                status: result.status,
            };
        },

        status(): WorkspaceServiceStatusResult {
            const current = runtime.status();
            return {
                serviceName: 'mcp',
                workspaceName: deps.workspace.name,
                port: current.port,
                status: current.status,
            };
        },
    };
};
