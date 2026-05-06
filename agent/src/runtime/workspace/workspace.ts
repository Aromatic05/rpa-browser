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
import { createWorkflowControl, type WorkflowControl } from '../../workflow/control';
import type { RecordingState } from '../../record/recording';
import type { ReplayOptions } from '../../record/replay';
import type { RunStepsDeps } from '../../runner/run_steps';
import type { RunnerConfig } from '../../config';
import type { Action } from '../../actions/action_protocol';
import type { PortAllocator } from '../service/ports';
import { createWorkspaceMcpService } from '../../mcp/service';
import { getLogger } from '../../logging/logger';

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
    workflowControl: WorkflowControl;
    router: WorkspaceRouter;
    lifecycle: {
        getRecordPlayState: () => 'idle' | 'recording' | 'playing';
        startRecording: () => void;
        stopRecording: () => void;
        startPlaying: () => void;
        stopPlaying: () => void;
    };
    createdAt: number;
    updatedAt: number;
};


export type CreateRuntimeWorkspaceDeps = {
    name: string;
    workflow: Workflow;
    pageRegistry: { getPage: (tabName: string, startUrl?: string) => Promise<Page>; touchBinding?: (bindingName: string) => void };
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
    let recordPlayState: 'idle' | 'recording' | 'playing' = 'idle';
    const tabs = createWorkspaceTabs({ getPage: deps.pageRegistry.getPage, touchBinding: deps.pageRegistry.touchBinding });
    const record = createRecordControl({
        recordingState: deps.recordingState,
        replayOptions: deps.replayOptions,
        navDedupeWindowMs: deps.navDedupeWindowMs,
        emit: deps.emit,
        log: getLogger('action'),
    });
    const dsl = createDslControl({ runStepsDeps: deps.runStepsDeps });
    const checkpoint = createCheckpointControl();
    const entityRules = createEntityRulesControl();
    const runner = createRunnerControl({ runnerConfig: deps.runnerConfig });
    const tabsControl = createTabsControl();

    const mcpService = createWorkspaceMcpService({
        workspace: { name: deps.name, tabs },
        portAllocator: deps.portAllocator,
        runStepsDeps: deps.runStepsDeps,
        config: deps.runnerConfig,
    });
    const mcp = createMcpControl(mcpService);
    const workflowControl = createWorkflowControl({ recordingState: deps.recordingState });

    const router = createWorkspaceRouter({
        tabsControl,
        recordControl: record,
        dslControl: dsl,
        checkpointControl: checkpoint,
        entityRulesControl: entityRules,
        runnerControl: runner,
        mcpControl: mcp,
        workflowControl,
    });
    const lifecycle: RuntimeWorkspace['lifecycle'] = {
        getRecordPlayState: () => recordPlayState,
        startRecording: () => {
            if (recordPlayState !== 'idle') {
                throw new Error(`invalid workspace state transition: ${recordPlayState} -> recording`);
            }
            recordPlayState = 'recording';
        },
        stopRecording: () => {
            if (recordPlayState !== 'recording') {
                throw new Error(`invalid workspace state transition: ${recordPlayState} -> idle`);
            }
            recordPlayState = 'idle';
        },
        startPlaying: () => {
            if (recordPlayState !== 'idle') {
                throw new Error(`invalid workspace state transition: ${recordPlayState} -> playing`);
            }
            recordPlayState = 'playing';
        },
        stopPlaying: () => {
            if (recordPlayState !== 'playing') {
                throw new Error(`invalid workspace state transition: ${recordPlayState} -> idle`);
            }
            recordPlayState = 'idle';
        },
    };

    return {
        name: deps.name,
        workflow: deps.workflow,
        tabs,
        record,
        dsl,
        checkpoint,
        entityRules,
        runner,
        mcp,
        workflowControl,
        router,
        lifecycle,
        createdAt: now,
        updatedAt: now,
    };
};
