import path from 'node:path';
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
import {createFileSystemSessionStorage} from './session/storage';
import {createAgentServiceSecurity} from './security';
import type {AgentServiceSecurityOptions} from './security/contracts';

export type WorkspaceAgentService = WorkspaceService & {
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
    sessions: SessionManager;
};

export type WorkspaceAgentServiceDeps = {
    workspaceName: string;
    portAllocator: PortAllocator;
    runner: AgentRunner;
    /**
     * Optional durable storage directory for session metadata and terminal reports.
     * When omitted, sessions are retained only in memory for the current process.
     */
    dataDir?: string;
    log?: (...args: unknown[]) => void;
    security?: AgentServiceSecurityOptions;
};

export const createWorkspaceAgentService = (deps: WorkspaceAgentServiceDeps): WorkspaceAgentService => {
    let status: WorkspaceServiceStatus = 'stopped';
    let port: number | null = null;
    let stopServer: (() => Promise<void>) | null = null;

    const storage = deps.dataDir
        ? createFileSystemSessionStorage({dataDir: path.resolve(deps.dataDir), log: deps.log})
        : undefined;
    const sessions = createSessionManager({runner: deps.runner, storage, log: deps.log});
    const security = createAgentServiceSecurity(deps.security);

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
                    security: security ?? undefined,
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
