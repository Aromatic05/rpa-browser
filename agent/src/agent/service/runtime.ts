import path from 'node:path';
import type {PortAllocator} from '../../automation/runtime/service/ports';
import type {
    WorkspaceService,
    WorkspaceServiceStartResult,
    WorkspaceServiceStatus,
    WorkspaceServiceStatusResult,
    WorkspaceServiceStopResult,
} from '../../automation/runtime/service/types';
import type {AgentExecutionMode, AgentRunRequest, AgentRunResult, AgentRunner} from '../execution/types';
import type {AgentProgramSaver} from '../execution/program/persistence';
import type {AgentModelSettings} from '../model/settings';
import type {LibraryAssetSummary} from '../library/contracts';
import {createProductController, type ProductController} from '../product';
import {createAgentHttpServer} from './server';
import {createSessionManager, type ContinuationRestorer, type SessionManager} from './session/manager';
import {createFileSystemSessionStorage} from './session/storage';
import type {SessionInteractionPolicy} from './session/types';
import type {SessionRetentionPolicy} from './session/store';
import {createAgentServiceSecurity} from './security';
import type {AgentServiceSecurityOptions} from './security/contracts';

export type WorkspaceAgentService = WorkspaceService & {
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
    sessions: SessionManager;
    /** The one ProductController this service owns; the HTTP server and the
     *  `agent.product` Action plane both operate on this exact instance. */
    product: ProductController;
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
    /**
     * Optional explicit HTTP binding for the workspace agent server.
     * When absent the server's per-value defaults apply.
     */
    host?: string;
    agentPath?: string;
    healthPath?: string;
    /**
     * Fixed listen port; when present and nonzero the service binds this exact
     * port without consulting the port allocator and never claims an allocator
     * reservation.
     */
    fixedPort?: number;
    /**
     * Optional retention policy applied once when the service is created so
     * durable sessions and reports older than the configured budget are pruned.
     */
    retention?: SessionRetentionPolicy;
    interaction?: SessionInteractionPolicy;
    /** Real committed Library summaries for the product Library projection
     *  (`GET /agent/product/library`). When absent the projection is
     *  explicitly unavailable rather than fabricated. */
    productLibrary?: () => Promise<ReadonlyArray<LibraryAssetSummary>>;
    /** Persists a completed product Task's retained Program into this
     * workspace's DSL library. */
    productSaveAutomation?: AgentProgramSaver;
    /** Static defaults retained for embedded/test compositions. */
    productDefaults?: Readonly<{provider: string; model: string; executionMode?: AgentExecutionMode}>;
    /** Process-level dynamic model setup shared by all workspace services. */
    productModelSettings?: AgentModelSettings;
    continuationRestorer?: ContinuationRestorer;
};

export const createWorkspaceAgentService = (deps: WorkspaceAgentServiceDeps): WorkspaceAgentService => {
    let status: WorkspaceServiceStatus = 'stopped';
    let port: number | null = null;
    let portReserved = false;
    let stopServer: (() => Promise<void>) | null = null;

    const storage = deps.dataDir
        ? createFileSystemSessionStorage({dataDir: path.resolve(deps.dataDir), log: deps.log})
        : undefined;
    const sessions = createSessionManager({
        runner: deps.runner,
        storage,
        log: deps.log,
        interactionPolicy: deps.interaction,
        continuationRestorer: deps.continuationRestorer,
    });
    const security = createAgentServiceSecurity(deps.security);
    if (deps.retention) {
        sessions.prune(deps.retention);
    }
    const product = createProductController({
        manager: sessions,
        workspace: deps.workspaceName,
        ...(deps.productDefaults === undefined ? {} : {defaults: deps.productDefaults}),
        ...(deps.productModelSettings === undefined ? {} : {modelSettings: deps.productModelSettings}),
        ...(deps.productLibrary === undefined ? {} : {library: deps.productLibrary}),
        ...(deps.productSaveAutomation === undefined ? {} : {saveAutomation: deps.productSaveAutomation}),
    });

    return {
        name: 'agent',
        workspaceName: deps.workspaceName,
        run: (request) => sessions.run(request),
        sessions,
        product,
        async start(): Promise<WorkspaceServiceStartResult> {
            if (status === 'running' && port !== null) {
                return {serviceName: 'agent', workspaceName: deps.workspaceName, port, status};
            }
            if (status === 'starting') {throw new Error('agent service is already starting');}
            status = 'starting';
            try {
                await sessions.ready();
                if (deps.fixedPort !== undefined && deps.fixedPort > 0) {
                    port = deps.fixedPort;
                    portReserved = false;
                } else {
                    port = await deps.portAllocator.allocate(deps.workspaceName, 'agent');
                    portReserved = true;
                }
                const server = await createAgentHttpServer({
                    manager: sessions,
                    product,
                    workspaceName: deps.workspaceName,
                    port,
                    host: deps.host,
                    agentPath: deps.agentPath,
                    healthPath: deps.healthPath,
                    log: deps.log,
                    security: security ?? undefined,
                });
                stopServer = server.stop;
                status = 'running';
                return {serviceName: 'agent', workspaceName: deps.workspaceName, port, status};
            } catch (error) {
                status = 'failed';
                if (port !== null) {
                    if (portReserved) {
                        deps.portAllocator.release(deps.workspaceName, 'agent');
                    }
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
                    if (portReserved) {
                        deps.portAllocator.release(deps.workspaceName, 'agent');
                    }
                    port = null;
                    portReserved = false;
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
