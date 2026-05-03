import type { Page } from 'playwright';
import type { Workflow } from '../../workflow';
import { createWorkspaceTabs, type WorkspaceTabs } from './tabs';
import { createRecordControl, type RecordControl } from '../../record/control';
import { createDslControl, type DslControl } from '../../dsl/control';
import { createCheckpointControl, type CheckpointControl } from '../../checkpoint/control';
import { createEntityRulesControl, type EntityRulesControl } from '../../entity_rules/control';
import { createRunnerControl, type RunnerControl } from '../../runner/control';
import { createMcpControl, type McpControl } from '../../mcp/control';
import type { RecordingState } from '../../record/recording';
import type { ReplayOptions } from '../../record/replay';
import type { RunStepsDeps } from '../../runner/run_steps';
import type { RunnerConfig } from '../../config';
import type { Action } from '../../actions/action_protocol';
import type { PortAllocator } from '../service/ports';
import { createWorkspaceMcpService } from '../../mcp/service';
import type { WorkspaceService, WorkspaceServiceName, WorkspaceServiceStartResult, WorkspaceServiceStopResult, WorkspaceServiceStatusResult } from '../service/types';

export type RuntimeWorkspace = {
    name: string;
    workflow: Workflow;
    tabs: WorkspaceTabs;
    record: RecordControl;
    dsl: DslControl;
    checkpoint: CheckpointControl;
    entityRules: EntityRulesControl;
    runner: RunnerControl;
    mcp: McpControl;
    createdAt: number;
    updatedAt: number;
};

type ServiceLifecycle = {
    register: (service: WorkspaceService) => void;
    start: (serviceName: WorkspaceServiceName) => Promise<WorkspaceServiceStartResult>;
    stop: (serviceName: WorkspaceServiceName) => Promise<WorkspaceServiceStopResult>;
    status: (serviceName: WorkspaceServiceName) => WorkspaceServiceStatusResult;
};

const createServiceLifecycle = (workspaceName: string): ServiceLifecycle => {
    const services = new Map<WorkspaceServiceName, WorkspaceService>();
    return {
        register(service) { services.set(service.name, service); },
        async start(serviceName) {
            const service = services.get(serviceName);
            if (!service) { throw new Error(`service not registered: ${serviceName}`); }
            return await service.start();
        },
        async stop(serviceName) {
            const service = services.get(serviceName);
            if (!service) { throw new Error(`service not registered: ${serviceName}`); }
            return await service.stop();
        },
        status(serviceName) {
            const service = services.get(serviceName);
            if (!service) { return { serviceName, workspaceName, port: null, status: 'stopped' as const }; }
            return service.status();
        },
    };
};

export type CreateRuntimeWorkspaceDeps = {
    name: string;
    workflow: Workflow;
    pageRegistry: { getPage: (tabName: string, startUrl?: string) => Promise<Page> };
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
    runStepsDeps: RunStepsDeps;
    runnerConfig: RunnerConfig;
    portAllocator: PortAllocator;
};

export const createRuntimeWorkspace = (deps: CreateRuntimeWorkspaceDeps): RuntimeWorkspace => {
    const now = Date.now();
    const tabs = createWorkspaceTabs({ getPage: deps.pageRegistry.getPage });
    const record = createRecordControl({
        recordingState: deps.recordingState,
        replayOptions: deps.replayOptions,
        navDedupeWindowMs: deps.navDedupeWindowMs,
        emit: deps.emit,
    });
    const dsl = createDslControl({ runStepsDeps: deps.runStepsDeps });
    const checkpoint = createCheckpointControl();
    const entityRules = createEntityRulesControl();
    const runner = createRunnerControl({ runnerConfig: deps.runnerConfig });

    const workspace: RuntimeWorkspace = {
        name: deps.name,
        workflow: deps.workflow,
        tabs,
        record,
        dsl,
        checkpoint,
        entityRules,
        runner,
        mcp: null as unknown as McpControl,
        createdAt: now,
        updatedAt: now,
    };

    const lifecycle = createServiceLifecycle(deps.name);
    const mcp = createMcpControl(() => lifecycle);
    const mcpService = createWorkspaceMcpService({
        workspace: workspace as any,
        portAllocator: deps.portAllocator,
        runStepsDeps: deps.runStepsDeps,
        config: deps.runnerConfig,
    });
    lifecycle.register(mcpService);
    (workspace as any).mcp = mcp;

    return workspace;
};
