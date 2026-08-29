import type {PortAllocator} from '../../automation/runtime/service/ports';
import type {
    WorkspaceService,
    WorkspaceServiceStartResult,
    WorkspaceServiceStatus,
    WorkspaceServiceStatusResult,
    WorkspaceServiceStopResult,
} from '../../automation/runtime/service/types';
import type {AgentRunRequest, AgentRunResult, AgentRunner} from '../execution/types';
import {createAgentHttpServer} from './server';
import {createSessionManager, type SessionManager} from './session/manager';

export type WorkspaceAgentService = WorkspaceService & {
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
    sessions: SessionManager;
};

export type WorkspaceAgentServiceDeps = {
    workspaceName: string;
    portAllocator: PortAllocator;
    runner: AgentRunner;
    log?: (...args: unknown[]) => void;
};

export const createWorkspaceAgentService = (deps: WorkspaceAgentServiceDeps): WorkspaceAgentService => {
    let status: WorkspaceServiceStatus = 'stopped';
    let port: number | null = null;
    let stopServer: (() => Promise<void>) | null = null;
    const sessions = createSessionManager({runner: deps.runner, log: deps.log});

    return {
        name: 'agent',
        workspaceName: deps.workspaceName,
        run: (request) => sessions.run(request),
        sessions,
        async start(): Promise<WorkspaceServiceStartResult> {
            if (status === 'running' && port !== null) {
                return {serviceName: 'agent', workspaceName: deps.workspaceName, port, status};
            }
            if (status === 'starting') {throw new Error('agent service is already starting');}
            status = 'starting';
            try {
                port = await deps.portAllocator.allocate(deps.workspaceName, 'agent');
                const server = await createAgentHttpServer({
                    manager: sessions,
                    workspaceName: deps.workspaceName,
                    port,
                    log: deps.log,
                });
                stopServer = server.stop;
                status = 'running';
                return {serviceName: 'agent', workspaceName: deps.workspaceName, port, status};
            } catch (error) {
                status = 'failed';
                if (port !== null) {
                    deps.portAllocator.release(deps.workspaceName, 'agent');
                    port = null;
                }
                throw error;
            }
        },
        async stop(): Promise<WorkspaceServiceStopResult> {
            if (status === 'stopped') {
                return {serviceName: 'agent', workspaceName: deps.workspaceName, status};
            }
            status = 'stopping';
            try {
                if (stopServer) {
                    await stopServer();
                    stopServer = null;
                }
                if (port !== null) {
                    deps.portAllocator.release(deps.workspaceName, 'agent');
                    port = null;
                }
                status = 'stopped';
                return {serviceName: 'agent', workspaceName: deps.workspaceName, status};
            } catch (error) {
                status = 'failed';
                throw error;
            }
        },
        status(): WorkspaceServiceStatusResult {
            return {serviceName: 'agent', workspaceName: deps.workspaceName, port, status};
        },
    };
};
