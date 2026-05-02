import { createTabRegistry, type TabRegistry } from './tab_registry';
import type { Workflow } from '../workflow';

export type RuntimeWorkspace = {
    name: string;
    workflow: Workflow;
    runner: unknown;
    tabRegistry: TabRegistry;
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

export const createWorkspaceRegistry = (): WorkspaceRegistry => {
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
        const workspace: RuntimeWorkspace = {
            name: workspaceName,
            workflow,
            runner: null,
            tabRegistry: createTabRegistry(),
            createdAt: now,
            updatedAt: now,
        };
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
