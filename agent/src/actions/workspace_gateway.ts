import type { Action } from './action_protocol';
import { ActionError } from './failure';
import { ERROR_CODES } from './error_codes';
import type { RuntimeWorkspace } from '../runtime/workspace_registry';
import { handleWorkspaceControlAction } from '../runtime/workspace_control';
import type { GatewayDeps } from './control_gateway';
import { toFailedAction } from './failure';

const requireWorkspaceName = (action: Action): string => {
    const workspaceName = action.workspaceName?.trim();
    if (!workspaceName) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'workspaceName is required');
    }
    return workspaceName;
};

const resolveWorkspace = (deps: GatewayDeps, workspaceName: string): RuntimeWorkspace => {
    const workspace = deps.workspaceRegistry.getWorkspace(workspaceName);
    if (!workspace) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `workspace not found: ${workspaceName}`);
    }
    return workspace;
};

export const routeWorkspaceAction = async (deps: GatewayDeps, action: Action): Promise<Action> => {
    try {
        const workspaceName = requireWorkspaceName(action);
        const workspace = resolveWorkspace(deps, workspaceName);

        const result = await handleWorkspaceControlAction({
            action,
            workspace,
            workspaceRegistry: deps.workspaceRegistry,
        });

        for (const event of result.events) {
            deps.emit?.(event);
        }
        return result.reply;
    } catch (error) {
        return toFailedAction(action, error);
    }
};
