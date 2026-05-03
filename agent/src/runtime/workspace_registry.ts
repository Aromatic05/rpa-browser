import type { Page } from 'playwright';
import { createWorkspaceTabs, type WorkspaceTabs } from './workspace/tabs';
import type { Workflow } from '../workflow';
import { createWorkspaceControl, type WorkspaceControl } from './workspace_control';
import { createWorkflowControl, type WorkflowControl } from '../workflow/control';
import { createRecordControl, type RecordControl } from '../record/control';
import { createDslControl, type DslControl } from '../dsl/control';
import { createRunnerControl, type RunnerControl } from '../runner/control';
import { createCheckpointControl, type CheckpointControl } from '../checkpoint/control';
import { createEntityRulesControl, type EntityRulesControl } from '../entity_rules/control';
import { createMcpControl, type McpControl } from '../mcp/control';
import { createWorkspaceMcpService } from '../mcp/service';
import type { WorkspaceService, WorkspaceServiceName, WorkspaceServiceStartResult, WorkspaceServiceStopResult, WorkspaceServiceStatusResult } from './service/types';
import type { PortAllocator } from './service/ports';

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
            if (!service) {
                return { serviceName, workspaceName, port: null, status: 'stopped' as const };
            }
            return service.status();
        },
    };
};
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../record/replay';
import type { RunStepsDeps } from '../runner/run_steps';
import type { RunnerConfig } from '../config';
import type { Action } from '../actions/action_protocol';

export type RuntimeWorkspaceControls = {
    workspace: WorkspaceControl;
    workflow: WorkflowControl;
    record: RecordControl;
    dsl: DslControl;
    checkpoint: CheckpointControl;
    entityRules: EntityRulesControl;
    runner: RunnerControl;
    mcp: McpControl;
};

export type RuntimeWorkspace = {
    name: string;
    workflow: Workflow;
    runner: unknown;
    tabRegistry: WorkspaceTabs;
    controls: RuntimeWorkspaceControls;
    serviceLifecycle: ServiceLifecycle;
    getPage: (tabName: string, startUrl?: string) => Promise<Page>;
    createdAt: number;
    updatedAt: number;
};

export type WorkspaceRegistry = {
    createWorkspace: (workspaceName: string, workflow: Workflow) => RuntimeWorkspace;
    hasWorkspace: (workspaceName: string) => boolean;
    getWorkspace: (workspaceName: string) => RuntimeWorkspace | null;
    listWorkspaces: () => RuntimeWorkspace[];
    removeWorkspace: (workspaceName: string) => RuntimeWorkspace | null;
    renameWorkspace: (fromName: string, toName: string, workflow: Workflow) => RuntimeWorkspace;
    setActiveWorkspace: (workspaceName: string) => void;
    getActiveWorkspace: () => RuntimeWorkspace | null;
};

export type WorkspaceRuntimeDeps = {
    pageRegistry: {
        getPage: (tabName: string, startUrl?: string) => Promise<Page>;
    };
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
    runStepsDeps: RunStepsDeps;
    runnerConfig: RunnerConfig;
    portAllocator: PortAllocator;
};

const createWorkspaceControls = (deps: WorkspaceRuntimeDeps, lifecycle: ServiceLifecycle): RuntimeWorkspaceControls => {
    const workflow = createWorkflowControl({ recordingState: deps.recordingState });
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
    const workspace = createWorkspaceControl({
        pageRegistry: deps.pageRegistry,
        workflowControl: workflow,
        recordControl: record,
        dslControl: dsl,
        checkpointControl: checkpoint,
        entityRulesControl: entityRules,
        runnerControl: runner,
    });
    const mcp = createMcpControl(() => lifecycle);
    return { workspace, workflow, record, dsl, checkpoint, entityRules, runner, mcp };
};

export const createWorkspaceRegistry = (runtimeDeps: WorkspaceRuntimeDeps): WorkspaceRegistry => {
    const workspaces = new Map<string, RuntimeWorkspace>();
    let activeWorkspaceName: string | null = null;

    const createWorkspace = (workspaceName: string, workflow: Workflow) => {
        if (workflow.name !== workspaceName) {
            throw new Error(`workspace/workflow name mismatch: workspace=${workspaceName} workflow=${workflow.name}`);
        }
        if (workspaces.has(workspaceName)) {
            return workspaces.get(workspaceName)!;
        }
        const now = Date.now();
        const serviceLifecycle = createServiceLifecycle(workspaceName);
        const controls = createWorkspaceControls(runtimeDeps, serviceLifecycle);
        const workspace: RuntimeWorkspace = {
            name: workspaceName,
            workflow,
            runner: null,
            tabRegistry: createWorkspaceTabs({ getPage: runtimeDeps.pageRegistry.getPage }),
            controls,
            serviceLifecycle,
            getPage: (tabName: string, startUrl?: string) => runtimeDeps.pageRegistry.getPage(tabName, startUrl),
            createdAt: now,
            updatedAt: now,
        };
        const mcpService = createWorkspaceMcpService({
            workspace,
            portAllocator: runtimeDeps.portAllocator,
            runStepsDeps: runtimeDeps.runStepsDeps,
            config: runtimeDeps.runnerConfig,
        });
        serviceLifecycle.register(mcpService);
        workspaces.set(workspaceName, workspace);
        if (!activeWorkspaceName) {
            activeWorkspaceName = workspaceName;
        }
        return workspace;
    };

    const renameWorkspace = (fromName: string, toName: string, workflow: Workflow): RuntimeWorkspace => {
        if (workflow.name !== toName) {
            throw new Error(`workspace/workflow name mismatch after rename: workspace=${toName} workflow=${workflow.name}`);
        }
        const existing = workspaces.get(fromName);
        if (!existing) {
            return createWorkspace(toName, workflow);
        }
        if (workspaces.has(toName)) {
            throw new Error(`workspace already exists: ${toName}`);
        }
        workspaces.delete(fromName);
        const renamed: RuntimeWorkspace = {
            ...existing,
            name: toName,
            workflow,
            updatedAt: Date.now(),
        };
        workspaces.set(toName, renamed);
        if (activeWorkspaceName === fromName) {
            activeWorkspaceName = toName;
        }
        return renamed;
    };

    return {
        createWorkspace,
        hasWorkspace: (workspaceName) => workspaces.has(workspaceName),
        getWorkspace: (workspaceName) => workspaces.get(workspaceName) || null,
        listWorkspaces: () => Array.from(workspaces.values()),
        removeWorkspace: (workspaceName) => {
            const workspace = workspaces.get(workspaceName) || null;
            if (!workspace) {return null;}
            workspaces.delete(workspaceName);
            if (activeWorkspaceName === workspaceName) {
                activeWorkspaceName = workspaces.keys().next().value ?? null;
            }
            return workspace;
        },
        renameWorkspace,
        setActiveWorkspace: (workspaceName) => {
            if (workspaces.has(workspaceName)) {
                activeWorkspaceName = workspaceName;
            }
        },
        getActiveWorkspace: () => (activeWorkspaceName ? workspaces.get(activeWorkspaceName) || null : null),
    };
};
