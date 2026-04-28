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

const resolvePageTarget = async (
    options: ActionDispatcherOptions,
    action: Action,
): Promise<{ page: Page; tabToken: string } | null> => {
    const tabToken = action.tabToken || action.scope?.tabToken;
    if (typeof tabToken === 'string' && tabToken.length > 0) {
        const page = await options.pageRegistry.getPage(tabToken);
        options.runtime.bindPage(page, tabToken);
        return { page, tabToken };
    }

    const workspaceId = action.scope?.workspaceId || options.pageRegistry.getActiveWorkspace()?.workspaceId;
    if (workspaceId) {
        const binding = await options.runtime.ensureActivePage(workspaceId);
        options.pageRegistry.setActiveWorkspace(binding.workspaceId);
        options.pageRegistry.setActiveTab(binding.workspaceId, binding.tabId);
        return { page: binding.page, tabToken: binding.tabToken };
    }

    return null;
};

export const createActionDispatcher = (options: ActionDispatcherOptions): ActionDispatcher => ({
    async dispatch(action: Action): Promise<ActionHandlerResult> {
        const target = await resolvePageTarget(options, action);
        if (!target && PAGELESS_ACTIONS.has(action.type)) {
            return await executeAction(createActionContext(options, createPageStub(action.type), ''), action);
        }
        if (!target) {
            throw new Error(`missing action target for ${action.type}`);
        }
        return await executeAction(createActionContext(options, target.page, target.tabToken), action);
    },
});
