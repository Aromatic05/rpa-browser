import { createRuntimeWorkspace, type RuntimeWorkspace, type CreateRuntimeWorkspaceDeps } from './workspace';
import type { Workflow } from '../../workflow';
import type { RecordingState } from '../../record/recording';
import type { ReplayOptions } from '../../record/replay';
import type { RunStepsDeps } from '../../runner/run_steps';
import type { RunnerConfig } from '../../config';
import type { Action } from '../../actions/action_protocol';
import type { PortAllocator } from '../service/ports';
import type { ExecutionBindings } from '../execution/bindings';
import { createWorkspaceBrowserSession, type CreateWorkspaceBrowserSessionOptions } from '../browser/browser_session';

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
    tabNameKey: string;
    extensionPaths: string[];
    userDataRoot: string;
    runtime: ExecutionBindings;
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
    runStepsDeps: RunStepsDeps;
    runnerConfig: RunnerConfig;
    portAllocator: PortAllocator;
    dispatchAction: CreateWorkspaceBrowserSessionOptions['dispatchAction'];
    onPageBound?: CreateWorkspaceBrowserSessionOptions['onPageBound'];
    onBindingClosed?: CreateWorkspaceBrowserSessionOptions['onBindingClosed'];
    onWsError?: CreateWorkspaceBrowserSessionOptions['onError'];
    onWsListening?: CreateWorkspaceBrowserSessionOptions['onListening'];
    wsTap?: CreateWorkspaceBrowserSessionOptions['wsTap'];
};

export const createWorkspaceRegistry = (runtimeDeps: WorkspaceRuntimeDeps): WorkspaceRegistry => {
    const workspaces = new Map<string, RuntimeWorkspace>();
    let activeWorkspaceName: string | null = null;
    let registry: WorkspaceRegistry;

    const createWorkspace = (workspaceName: string, workflow: Workflow) => {
        if (workflow.name !== workspaceName) {
            throw new Error(`workspace/workflow name mismatch: workspace=${workspaceName} workflow=${workflow.name}`);
        }
        if (workspaces.has(workspaceName)) {
            return workspaces.get(workspaceName)!;
        }
        const browserSession = createWorkspaceBrowserSession({
            workspaceName,
            tabNameKey: runtimeDeps.tabNameKey,
            extensionPaths: runtimeDeps.extensionPaths,
            userDataRoot: runtimeDeps.userDataRoot,
            workspaceRegistry: registry,
            portAllocator: runtimeDeps.portAllocator,
            dispatchAction: runtimeDeps.dispatchAction,
            onPageBound: runtimeDeps.onPageBound,
            onBindingClosed: runtimeDeps.onBindingClosed,
            onError: runtimeDeps.onWsError,
            onListening: runtimeDeps.onWsListening,
            wsTap: runtimeDeps.wsTap,
        });
        const workspace = createRuntimeWorkspace({
            name: workspaceName,
            workflow,
            browserSession,
            runtime: runtimeDeps.runtime,
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

    registry = {
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
    return registry;
};
