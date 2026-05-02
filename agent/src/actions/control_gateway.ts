import type { Action } from './action_protocol';
import { ActionError, unsupportedActionFailure } from './failure';
import { handleRuntimeControlAction } from '../runtime/control';
import { ERROR_CODES } from './error_codes';

export type GatewayDeps = {
    workspaceRegistry: any;
    pageRegistry: any;
    recordingState: any;
    log: (...args: unknown[]) => void;
    replayOptions: any;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
    runStepsDeps?: any;
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
        pageRegistry: deps.pageRegistry,
        recordingState: deps.recordingState,
        log: deps.log,
        replayOptions: deps.replayOptions,
        navDedupeWindowMs: deps.navDedupeWindowMs,
        emit: deps.emit,
        runStepsDeps: deps.runStepsDeps,
    });

    for (const event of result.events) {
        deps.emit?.(event);
    }
    return result.reply;
};
