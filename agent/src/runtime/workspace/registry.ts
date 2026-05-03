import { createRuntimeWorkspace, type RuntimeWorkspace, type CreateRuntimeWorkspaceDeps } from './workspace';
import type { Workflow } from '../../workflow';
import type { WorkflowControl } from '../../workflow/control';
import type { RecordControl } from '../../record/control';
import type { DslControl } from '../../dsl/control';
import type { CheckpointControl } from '../../checkpoint/control';
import type { EntityRulesControl } from '../../entity_rules/control';
import type { RunnerControl } from '../../runner/control';
import type { McpControl } from '../../mcp/control';
import type { RecordingState } from '../../record/recording';
import type { ReplayOptions } from '../../record/replay';
import type { RunStepsDeps } from '../../runner/run_steps';
import type { RunnerConfig } from '../../config';
import type { Action } from '../../actions/action_protocol';
import type { PortAllocator } from '../service/ports';

export type { RuntimeWorkspace };

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
        getPage: (tabName: string, startUrl?: string) => Promise<import('playwright').Page>;
    };
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
    runStepsDeps: RunStepsDeps;
    runnerConfig: RunnerConfig;
    portAllocator: PortAllocator;
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
        const workspace = createRuntimeWorkspace({
            name: workspaceName,
            workflow,
            pageRegistry: runtimeDeps.pageRegistry,
            recordingState: runtimeDeps.recordingState,
            replayOptions: runtimeDeps.replayOptions,
            navDedupeWindowMs: runtimeDeps.navDedupeWindowMs,
            emit: runtimeDeps.emit,
            runStepsDeps: runtimeDeps.runStepsDeps,
            runnerConfig: runtimeDeps.runnerConfig,
            portAllocator: runtimeDeps.portAllocator,
        });
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
