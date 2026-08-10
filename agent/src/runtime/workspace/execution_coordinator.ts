import { enterWorkspaceState, leaveWorkspaceState, type RuntimeWorkspace } from './workspace';

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

export const runWorkspaceExecution = async <T>(
    workspace: RuntimeWorkspace,
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
