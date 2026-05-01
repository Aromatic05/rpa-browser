import { createTabRegistry, type TabRegistry } from './tab_registry';

export type RuntimeWorkspace = {
    name: string;
    workflow: unknown;
    runner: unknown;
    tabRegistry: TabRegistry;
    createdAt: number;
    updatedAt: number;
};

export type WorkspaceRegistry = {
    createWorkspace: (workspaceName: string) => RuntimeWorkspace;
    hasWorkspace: (workspaceName: string) => boolean;
    getWorkspace: (workspaceName: string) => RuntimeWorkspace | null;
    listWorkspaces: () => RuntimeWorkspace[];
    removeWorkspace: (workspaceName: string) => RuntimeWorkspace | null;
    setActiveWorkspace: (workspaceName: string) => void;
    getActiveWorkspace: () => RuntimeWorkspace | null;
};

export const createWorkspaceRegistry = (): WorkspaceRegistry => {
    const workspaces = new Map<string, RuntimeWorkspace>();
    let activeWorkspaceName: string | null = null;

    const createWorkspace = (workspaceName: string) => {
        if (workspaces.has(workspaceName)) {
            return workspaces.get(workspaceName)!;
        }
        const now = Date.now();
        const workspace: RuntimeWorkspace = {
            name: workspaceName,
            workflow: null,
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
        setActiveWorkspace: (workspaceName) => {
            if (workspaces.has(workspaceName)) {
                activeWorkspaceName = workspaceName;
            }
        },
        getActiveWorkspace: () => (activeWorkspaceName ? workspaces.get(activeWorkspaceName) || null : null),
    };
};
