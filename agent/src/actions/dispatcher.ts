import type { Page } from 'playwright';
import { executeAction, type ActionContext, type ActionHandlerResult } from './execute';
import type { Action } from './action_protocol';
import type { PageRegistry } from '../runtime/page_registry';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';
import type { RunStepsDeps } from '../runner/run_steps';
import type { WorkspaceRegistry } from '../runtime/workspace_registry';

export type ActionDispatcherOptions = {
    pageRegistry: PageRegistry;
    workspaceRegistry: WorkspaceRegistry;
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

const createPageStub = (actionType: string): Page =>
    new Proxy(
        {},
        {
            get: (_target, prop) => {
                throw new Error(`action '${actionType}' accessed page.${String(prop)} without target`);
            },
        },
    ) as unknown as Page;

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

const createActionContext = (options: ActionDispatcherOptions, action: Action): ActionContext => {
    const workspace = action.workspaceName ? options.workspaceRegistry.getWorkspace(action.workspaceName) : null;
    const resolveTab = (tabName?: string) => {
        if (!workspace) {throw new Error('workspace not found');}
        return workspace.tabRegistry.resolveTab(tabName);
    };
    const resolvePage = (tabName?: string) => {
        const tab = resolveTab(tabName);
        if (!tab.page) {return createPageStub(action.type);}
        return tab.page;
    };

    const ctx: ActionContext = {
        workspaceRegistry: options.workspaceRegistry,
        workspace,
        resolveTab,
        resolvePage,
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

export const createActionDispatcher = (options: ActionDispatcherOptions): ActionDispatcher => ({
    async dispatch(action: Action): Promise<ActionHandlerResult> {
        assertNoLegacyAddressFields(action);
        if (action.workspaceName && !options.workspaceRegistry.getWorkspace(action.workspaceName)) {
            throw new Error(`workspace not found: ${action.workspaceName}`);
        }
        return await executeAction(createActionContext(options, action), action);
    },
});
