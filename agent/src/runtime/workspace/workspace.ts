import type { Page } from 'playwright';
import type { Workflow } from '../../workflow';
import { createWorkspaceTabs, createTabsControl, type WorkspaceTabs } from './tabs';
import { createRecordControl, type RecordControl } from '../../record/control';
import { createDslControl, type DslControl } from '../../dsl/control';
import { createCheckpointControl, type CheckpointControl } from '../../checkpoint/control';
import { createEntityRulesControl, type EntityRulesControl } from '../../entity_rules/control';
import { createRunnerControl, type RunnerControl } from '../../runner/control';
import { createMcpControl, type McpControl } from '../../mcp/control';
import { createWorkspaceRouter, type WorkspaceRouter } from './router';
import type { RecordingState } from '../../record/recording';
import type { ReplayOptions } from '../../record/replay';
import type { RunStepsDeps } from '../../runner/run_steps';
import type { RunnerConfig } from '../../config';
import type { Action } from '../../actions/action_protocol';
import type { PortAllocator } from '../service/ports';
import { createWorkspaceMcpService } from '../../mcp/service';

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
    router: WorkspaceRouter;
    createdAt: number;
    updatedAt: number;
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
    const tabsControl = createTabsControl();

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
        router: null as unknown as WorkspaceRouter,
        createdAt: now,
        updatedAt: now,
    };

    const mcpService = createWorkspaceMcpService({
        workspace,
        portAllocator: deps.portAllocator,
        runStepsDeps: deps.runStepsDeps,
        config: deps.runnerConfig,
    });
    const mcp = createMcpControl(mcpService);
    workspace.mcp = mcp;

    workspace.router = createWorkspaceRouter({
        tabsControl,
        recordControl: record,
        dslControl: dsl,
        checkpointControl: checkpoint,
        entityRulesControl: entityRules,
        runnerControl: runner,
        mcpControl: mcp,
    });

    return workspace;
};
