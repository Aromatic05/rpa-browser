import type { Page } from 'playwright';
import { ACTION_TYPES } from './action_types';
import { executeAction, type ActionContext, type ActionHandlerResult } from './execute';
import type { Action } from './action_protocol';
import type { PageRegistry } from '../runtime/page_registry';
import type { RuntimeRegistry } from '../runtime/runtime_registry';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';
import type { RunStepsDeps } from '../runner/run_steps';

export type ActionDispatcherOptions = {
    pageRegistry: PageRegistry;
    runtime: RuntimeRegistry;
    recordingState: RecordingState;
    log: (...args: unknown[]) => void;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
    runStepsDeps?: RunStepsDeps;
};

export type ActionDispatcher = {
    dispatch(action: Action): Promise<ActionHandlerResult>;
};

const PAGELESS_ACTIONS = new Set<string>([
    ACTION_TYPES.WORKFLOW_LIST,
    ACTION_TYPES.WORKFLOW_OPEN,
    ACTION_TYPES.WORKFLOW_STATUS,
    ACTION_TYPES.WORKFLOW_RECORD_SAVE,
    ACTION_TYPES.WORKFLOW_DSL_GET,
    ACTION_TYPES.WORKFLOW_DSL_SAVE,
    ACTION_TYPES.WORKFLOW_DSL_TEST,
    ACTION_TYPES.WORKFLOW_RELEASE_RUN,
    ACTION_TYPES.WORKFLOW_INIT,
    ACTION_TYPES.WORKSPACE_LIST,
    ACTION_TYPES.WORKSPACE_CREATE,
    ACTION_TYPES.WORKSPACE_SET_ACTIVE,
    ACTION_TYPES.WORKSPACE_SAVE,
    ACTION_TYPES.TAB_INIT,
    ACTION_TYPES.TAB_LIST,
    ACTION_TYPES.TAB_CREATE,
    ACTION_TYPES.TAB_CLOSE,
    ACTION_TYPES.TAB_SET_ACTIVE,
    ACTION_TYPES.TAB_REASSIGN,
]);

const createPageStub = (actionType: string): Page =>
    new Proxy(
        {},
        {
            get: (_target, prop) => {
                throw new Error(`action '${actionType}' accessed page.${String(prop)} without target`);
            },
        },
    ) as unknown as Page;

const createActionContext = (
    options: ActionDispatcherOptions,
    page: Page,
    tabToken: string,
): ActionContext => {
    const ctx: ActionContext = {
        page,
        tabToken,
        pageRegistry: options.pageRegistry,
        log: options.log,
        recordingState: options.recordingState,
        replayOptions: options.replayOptions,
        navDedupeWindowMs: options.navDedupeWindowMs,
        emit: options.emit,
        runStepsDeps: options.runStepsDeps,
        execute: undefined,
    };
    ctx.execute = (innerAction: Action) => executeAction(ctx, innerAction);
    return ctx;
};

const assertNoLegacyAddressFields = (action: Action): void => {
    const envelope = action as Record<string, unknown>;
    if ('scope' in envelope || 'tabToken' in envelope) {
        throw new Error('legacy action address fields are not allowed');
    }
    if (action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)) {
        const payload = action.payload as Record<string, unknown>;
        if ('workspaceId' in payload || 'tabId' in payload || 'tabToken' in payload || 'scope' in payload) {
            throw new Error('legacy payload address fields are not allowed');
        }
        if (action.workspaceName && 'workspaceName' in payload) {
            throw new Error('payload must not duplicate workspaceName');
        }
    }
};

const resolveWorkspaceTarget = async (
    options: ActionDispatcherOptions,
    action: Action,
): Promise<{ page: Page; tabToken: string } | null> => {
    if (action.workspaceName) {
        const binding = await options.runtime.ensureActivePage(action.workspaceName);
        return { page: binding.page, tabToken: binding.tabToken };
    }
    return null;
};

export const createActionDispatcher = (options: ActionDispatcherOptions): ActionDispatcher => ({
    async dispatch(action: Action): Promise<ActionHandlerResult> {
        assertNoLegacyAddressFields(action);
        if (!action.workspaceName) {
            return await executeAction(createActionContext(options, createPageStub(action.type), ''), action);
        }
        const target = await resolveWorkspaceTarget(options, action);
        if (!target) {
            if (PAGELESS_ACTIONS.has(action.type)) {
                return await executeAction(createActionContext(options, createPageStub(action.type), ''), action);
            }
            throw new Error(`missing action target for ${action.type}`);
        }
        return await executeAction(createActionContext(options, target.page, target.tabToken), action);
    },
});
