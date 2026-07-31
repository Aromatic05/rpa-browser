import { enterWorkspaceState, leaveWorkspaceState, type RuntimeWorkspace } from './workspace';

export const runWorkspaceExecution = async <T>(
    workspace: RuntimeWorkspace,
    actionType: string,
    run: () => Promise<T>,
): Promise<T> => {
    enterWorkspaceState(workspace, 'executing', actionType);
    try {
        return await run();
    } finally {
        if (workspace.state === 'executing') {
            leaveWorkspaceState(workspace, 'executing', actionType);
        }
    }
};
