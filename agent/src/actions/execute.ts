import type { Page } from 'playwright';
import { ERROR_CODES, type ErrorCode } from './error_codes';
import type { Action } from './action_protocol';
import { failedAction } from './action_protocol';
import { actionHandlers } from './legacy_handlers';
import type { PageRegistry } from '../runtime/page_registry';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';
import type { RunStepsDeps } from '../runner/run_steps';
import type { RuntimeWorkspace, WorkspaceRegistry } from '../runtime/workspace_registry';
import type { RuntimeTab } from '../runtime/tab_registry';

export type ActionContext = {
    workspaceRegistry: WorkspaceRegistry;
    workspace: RuntimeWorkspace | null;
    resolveTab: (tabName?: string) => RuntimeTab;
    resolvePage: (tabName?: string) => Page;
    pageRegistry: PageRegistry;
    log: (...args: unknown[]) => void;
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
    execute?: (action: Action) => Promise<ActionHandlerResult>;
    runStepsDeps?: RunStepsDeps;
};

export type ActionHandlerResult = Action;
export type ActionHandler = (ctx: ActionContext, action: Action) => Promise<ActionHandlerResult>;

export class ActionError extends Error {
    code: ErrorCode;
    details?: unknown;

    constructor(code: ErrorCode, message: string, details?: unknown) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

const mapError = (action: Action, error: unknown): ActionHandlerResult => {
    if (error instanceof ActionError) {
        return failedAction(action, error.code, error.message, error.details);
    }
    if (error instanceof Error) {
        if (error.name === 'TimeoutError') {
            return failedAction(action, ERROR_CODES.ERR_TIMEOUT, error.message);
        }
        return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, error.message);
    }
    return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, String(error));
};

export const executeAction = async (ctx: ActionContext, action: Action): Promise<ActionHandlerResult> => {
    const handler = actionHandlers[action.type];
    if (!handler) {
        return failedAction(action, ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    }
    ctx.log('execute', {
        type: action.type,
        id: action.id,
        workspaceName: action.workspaceName || null,
        hasWorkspaceContext: Boolean(ctx.workspace),
    });
    try {
        return await handler(ctx, action);
    } catch (error) {
        return mapError(action, error);
    }
};
