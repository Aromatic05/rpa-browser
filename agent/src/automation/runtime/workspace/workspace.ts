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
import type { PortAllocator } from '../service/ports';
import { createWorkspaceMcpService } from '../mcp/service';
import { getLogger } from '../../../platform/logging/logger';
import type { ExecutionBindings } from '../execution/bindings';
import type { WorkspaceBrowserSession } from '../browser/browser_session';
import type { WorkspaceService } from '../service/types';
import type { WorkspaceAgentFactory } from './agent';
import { createEntityRulesRuntime, type EntityRulesRuntime } from '../../snapshot/rules';
import {createRunnerAnnotatorController} from '../../runner/annotator';
import { runWorkspaceExecution, type WorkspaceExecutionLease } from './execution_coordinator';

export type WorkspaceState = 'idle' | 'recording' | 'playing' | 'executing';

export {
    acquireWorkspaceExecution,
    assertWorkspaceExecutionReplaceable,
    enterWorkspaceState,
    getWorkspaceExecutionLease,
    getWorkspaceState,
    leaveWorkspaceState,
    pauseWorkspaceExecution,
    requireWorkspaceState,
    resumeWorkspaceExecution,
    runWorkspaceExecution,
    workspaceExecutionOwnerKind,
    type WorkspaceExecutionIntent,
    type WorkspaceExecutionLease,
    type WorkspaceExecutionOwnerInput,
    type WorkspaceExecutionOwnerKind,
    type WorkspaceExecutionRelease,
} from './execution_coordinator';

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
    executionLease: WorkspaceExecutionLease | null;
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
        acquirePlayback: () => agentBinding.acquirePlayback ? agentBinding.acquirePlayback() : () => undefined,
        log: getLogger('action'),
    });
    const dsl = createDslControl({ runStepsDeps: deps.runStepsDeps });
    const checkpoint = createCheckpointControl();
    const runOwnedWorkspaceExecution = <T>(
        actionType: string,
        run: () => Promise<T>,
    ): Promise<T> => runWorkspaceExecution(workspace, actionType, run);
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
        playbackView: record.playbackView,
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
        executionLease: null,
        createdAt: now,
        updatedAt: now,
    };
    return workspace;
};
