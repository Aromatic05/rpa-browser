import crypto from 'node:crypto';
import type { Action } from './action_protocol';
import { replyAction } from './action_protocol';
import { ActionError } from './results';
import { ERROR_CODES } from './results';
import type { RuntimeWorkspace } from '../runtime/workspace/workspace';
import type { GatewayDeps } from './control_gateway';
import { toFailedAction } from './results';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

export const routeWorkspaceAction = async (deps: GatewayDeps, action: Action): Promise<Action> => {
    try {
        const workspaceName = requireWorkspaceName(action);

        // Outbound commands: forward to Extension, no Agent state change
        if (action.type === 'tab.open') {
            const workspace = resolveWorkspace(deps, workspaceName);
            const createId = crypto.randomUUID();
            const payload = isRecord(action.payload) ? action.payload : {};
            workspace.browserSession.emit({ ...action, payload: { ...payload, createId } });
            return replyAction(action, { workspaceName, createId, source: 'tab.open' });
        }
        if (action.type === 'tab.close') {
            const workspace = resolveWorkspace(deps, workspaceName);
            const payload = isRecord(action.payload) ? action.payload : {};
            const tabName = typeof payload.tabName === 'string' ? payload.tabName.trim() : '';
            workspace.browserSession.emit(action);
            return replyAction(action, { workspaceName, tabName, source: 'tab.close' });
        }

        const workspace = resolveWorkspace(deps, workspaceName);
        const result = await workspace.router.handle(action, workspace, deps.workspaceRegistry);

        for (const event of result.events) {
            deps.emit?.(event);
        }
        return result.reply;
    } catch (error) {
        return toFailedAction(action, error);
    }
};
