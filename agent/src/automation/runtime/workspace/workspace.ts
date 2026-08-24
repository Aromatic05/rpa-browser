import type { Workflow } from '../../workflow';
import { createWorkspaceTabs, createTabsControl, type WorkspaceTabs } from './tabs';
import { createRecordControl, type RecordControl } from '../../recording/control';
import { createDslControl, type DslControl } from '../../dsl/control';
import { createCheckpointControl, type CheckpointControl } from '../../checkpoint/control';
import { createRunnerControl, type RunnerControl } from '../../runner/control';
import { createMcpControl, type McpControl } from '../mcp/control';
import { createWorkspaceRouter, type WorkspaceRouter } from './router';
import type { RecordingState } from '../../recording/recording';
import type { ReplayOptions } from '../../recording/replay';
import type { RunStepsDeps } from '../../runner/run_steps';
import type { RunnerConfig } from '../../../platform/config';
import type { Action } from '../../../interface/actions/action_protocol';
import { ActionError, ERROR_CODES } from '../../../interface/actions/results';
import type { PortAllocator } from '../service/ports';
import { createWorkspaceMcpService } from '../mcp/service';
import { getLogger } from '../../../platform/logging/logger';
import type { ExecutionBindings } from '../execution/bindings';
import type { WorkspaceBrowserSession } from '../browser/browser_session';
import type { WorkspaceService } from '../service/types';
import type { WorkspaceAgentFactory } from './agent';
import { createEntityRulesRuntime, type EntityRulesRuntime } from '../../snapshot/rules';
import {createRunnerAnnotatorController} from '../../runner/annotator';

export type WorkspaceState = 'idle' | 'recording' | 'playing' | 'executing';

export type RuntimeWorkspace = {
    name: string;
    workflow: Workflow;
    browserSession: WorkspaceBrowserSession;
    tabs: WorkspaceTabs;
    record: RecordControl;
    dsl: DslControl;
    checkpoint: CheckpointControl;
    entityRules: EntityRulesRuntime;
    runner: RunnerControl;
    mcp: McpControl;
    agent: WorkspaceService;
    router: WorkspaceRouter;
    state: WorkspaceState;
    executionOwner: symbol | null;
    createdAt: number;
    updatedAt: number;
};

export type CreateRuntimeWorkspaceDeps = {
    name: string;
    workflow: Workflow;
    browserSession: WorkspaceBrowserSession;
    runtime: ExecutionBindings;
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
    runStepsDeps: RunStepsDeps;
    runnerConfig: RunnerConfig;
    portAllocator: PortAllocator;
    agentFactory: WorkspaceAgentFactory;
};

export const getWorkspaceState = (workspace: RuntimeWorkspace): WorkspaceState => workspace.state;

export const requireWorkspaceState = (
    workspace: RuntimeWorkspace,
    expected: WorkspaceState,
    actionType: string,
): void => {
    if (workspace.state !== expected) {
        throw new ActionError(ERROR_CODES.ERR_BAD_STATE, `${actionType} requires workspace state=${expected}, current=${workspace.state}`);
    }
};

export const enterWorkspaceState = (
    workspace: RuntimeWorkspace,
    next: WorkspaceState,
    actionType: string,
): void => {
    if (workspace.state !== 'idle') {
        throw new ActionError(ERROR_CODES.ERR_BAD_STATE, `${actionType} requires workspace state=idle, current=${workspace.state}`);
    }
    workspace.state = next;
    workspace.updatedAt = Date.now();
};

export const leaveWorkspaceState = (
    workspace: RuntimeWorkspace,
    expected: WorkspaceState,
    actionType: string,
): void => {
    if (workspace.state !== expected) {
        throw new ActionError(ERROR_CODES.ERR_BAD_STATE, `${actionType} requires workspace state=${expected}, current=${workspace.state}`);
    }
    workspace.state = 'idle';
    workspace.updatedAt = Date.now();
};

export type WorkspaceExecutionRelease = () => void;

export const acquireWorkspaceExecution = (
    workspace: RuntimeWorkspace,
    actionType: string,
): WorkspaceExecutionRelease => {
    enterWorkspaceState(workspace, 'executing', actionType);
    const owner = Symbol(actionType);
    workspace.executionOwner = owner;
    let released = false;
    return () => {
        if (released) {return;}
        released = true;
        if (workspace.executionOwner !== owner) {return;}
        workspace.executionOwner = null;
        if (workspace.state === 'executing') {
            leaveWorkspaceState(workspace, 'executing', actionType);
        }
    };
};

export const createRuntimeWorkspace = (deps: CreateRuntimeWorkspaceDeps): RuntimeWorkspace => {
    const now = Date.now();
    const pageRegistry = deps.browserSession.pageRegistry;
    const tabs = createWorkspaceTabs({
        awaitPageBinding: (tabName, timeoutMs) => pageRegistry.awaitPageBinding(tabName, { timeoutMs }),
        createPageBinding: (tabName, input) => pageRegistry.createPageBinding(tabName, input),
        touchBinding: pageRegistry.touchBinding,
    });
    const record = createRecordControl({
        recordingState: deps.recordingState,
        replayOptions: deps.replayOptions,
        navDedupeWindowMs: deps.navDedupeWindowMs,
        runtime: deps.runtime,
        pageRegistry,
        emit: deps.emit,
        log: getLogger('action'),
    });
    const dsl = createDslControl({ runStepsDeps: deps.runStepsDeps });
    const checkpoint = createCheckpointControl();
    const runOwnedWorkspaceExecution = async <T>(
        actionType: string,
        run: () => Promise<T>,
    ): Promise<T> => {
        const release = acquireWorkspaceExecution(workspace, actionType);
        try {
            return await run();
        } finally {
            release();
        }
    };
    const entityRules = createEntityRulesRuntime({
        annotator: createRunnerAnnotatorController({
            runStepsDeps: deps.runStepsDeps,
            runWorkspaceExecution: runOwnedWorkspaceExecution,
        }),
    });
    const runner = createRunnerControl({ runnerConfig: deps.runnerConfig });
    const tabsControl = createTabsControl({
        recordingState: deps.recordingState,
        navDedupeWindowMs: deps.navDedupeWindowMs,
    });

    const mcpService = createWorkspaceMcpService({
        workspace: { name: deps.name, tabs },
        portAllocator: deps.portAllocator,
        runStepsDeps: deps.runStepsDeps,
        config: deps.runnerConfig,
        runWorkspaceExecution: runOwnedWorkspaceExecution,
    });
    const mcp = createMcpControl(mcpService);
    const agentBinding = deps.agentFactory({
        workspaceName: deps.name,
        tabs,
        runStepsDeps: deps.runStepsDeps,
        runnerConfig: deps.runnerConfig,
        portAllocator: deps.portAllocator,
        runWorkspaceExecution: runOwnedWorkspaceExecution,
    });
    const agent = agentBinding.service;

    const router = createWorkspaceRouter({
        tabsControl,
        recordControl: record,
        dslControl: dsl,
        checkpointControl: checkpoint,
        entityRulesRuntime: entityRules,
        runnerControl: runner,
        mcpControl: mcp,
        agentControl: agentBinding.control,
    });

    const workspace: RuntimeWorkspace = {
        name: deps.name,
        workflow: deps.workflow,
        browserSession: deps.browserSession,
        tabs,
        record,
        dsl,
        checkpoint,
        entityRules,
        runner,
        mcp,
        agent,
        router,
        state: 'idle',
        executionOwner: null,
        createdAt: now,
        updatedAt: now,
    };
    return workspace;
};
