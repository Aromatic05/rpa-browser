import type { Action } from './action_protocol';
import { ActionError, unsupportedActionFailure } from './results';
import { handleRuntimeControlAction } from '../runtime/control';
import { ERROR_CODES } from './results';

export type GatewayDeps = {
    workspaceRegistry: any;
    log: (...args: unknown[]) => void;
    emit?: (action: Action) => void;
};

export const routeControlAction = async (deps: GatewayDeps, action: Action): Promise<Action> => {
    if (action.workspaceName) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'control gateway does not accept workspace action');
    }
    if (action.type === 'tab.list' || action.type === 'tab.create' || action.type === 'tab.close' || action.type === 'tab.setActive') {
        return unsupportedActionFailure(action);
    }

    const result = await handleRuntimeControlAction({
        action,
        workspaceRegistry: deps.workspaceRegistry,
    });

    for (const event of result.events) {
        deps.emit?.(event);
    }
    return result.reply;
};
