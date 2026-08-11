import { acquireWorkspaceExecution, type RuntimeWorkspace } from './workspace';

export { acquireWorkspaceExecution } from './workspace';
export type { WorkspaceExecutionRelease } from './workspace';

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
