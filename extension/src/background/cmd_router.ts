import { createLogger, type Logger } from '../shared/logger.js';
import type { Action } from '../shared/types.js';
import { ACTION_TYPES } from '../shared/action_types.js';
import { MSG } from '../shared/protocol.js';
import type { WsClient } from './ws_client.js';
import { createRouterState } from './state.js';
import { dispatchIncomingAction, isFailedReply, payloadOf, withActionBase } from './action.js';
import { createLifecycleRuntime } from './life.js';

export type CmdRouterOptions = {
    wsClient: WsClient;
    onRefresh: () => void;
    logger?: Logger;
};

export const createCmdRouter = (options: CmdRouterOptions) => {
    const log = options.logger || createLogger('sw');
    const WINDOW_NONE = chrome.windows.WINDOW_ID_NONE;
    const state = createRouterState(log);

    const sendAction = async (action: Action): Promise<Action> => await options.wsClient.sendAction(withActionBase(action));

    const life = createLifecycleRuntime({
        state,
        sendAction,
        onRefresh: options.onRefresh,
    });

    const resolveActionTargetTabId = (action: Action) => {
        const token = action.tabToken || action.scope?.tabToken;
        const targetTabId = token ? state.findTabIdByToken(token) : state.getActiveTabId();
        return typeof targetTabId === 'number' ? targetTabId : null;
    };

    const handleInboundAction = (action: Action) => {
        if (action.type === ACTION_TYPES.WORKSPACE_SYNC) {return;}

        if (action.type === ACTION_TYPES.WORKSPACE_LIST) {
            const data = (action.payload || {}) as Record<string, unknown>;
            const activeId = data.activeWorkspaceId ? String(data.activeWorkspaceId) : null;
            if (activeId) {state.setActiveWorkspaceId(activeId);}
            options.onRefresh();
            return;
        }

        if (action.type === ACTION_TYPES.TAB_BOUND) {
            const data = (action.payload || {}) as Record<string, unknown>;
            if (data.tabToken && data.workspaceId && data.tabId) {
                state.upsertTokenScope(String(data.tabToken), String(data.workspaceId), String(data.tabId));
                state.bindWorkspaceToWindowIfKnown(String(data.tabToken));
            }
            if (!state.getActiveWorkspaceId() && data.workspaceId) {
                state.setActiveWorkspaceId(String(data.workspaceId));
            }
            options.onRefresh();
            return;
        }

        if (action.type === ACTION_TYPES.WORKSPACE_CHANGED) {
            const data = (action.payload || {}) as Record<string, unknown>;
            const workspaceId = data.workspaceId ? String(data.workspaceId) : action.scope?.workspaceId || null;
            if (workspaceId) {
                state.setActiveWorkspaceId(workspaceId);
                const activeWindowId = state.getActiveWindowId();
                if (typeof activeWindowId === 'number' && activeWindowId !== WINDOW_NONE) {
                    state.setWindowWorkspace(activeWindowId, workspaceId);
                }
            }
            options.onRefresh();
        }
    };

    const bootstrapState = async () => {
        const reply = await sendAction({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.WORKSPACE_LIST,
            payload: {},
            scope: {},
        });
        if (isFailedReply(reply)) {
            const error = payloadOf<{ code?: string; message?: string }>(reply);
            throw new Error(`bootstrap.workspace_list_failed: ${error?.code || 'UNKNOWN'}:${error?.message || 'unknown'}`);
        }
        const data = payloadOf(reply);
        const activeId = (data as any).activeWorkspaceId ? String((data as any).activeWorkspaceId) : null;
        if (activeId) {state.setActiveWorkspaceId(activeId);}
    };

    const handleMessage = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (payload?: any) => void) => {
        if (!message?.type) {return;}

        if (message.type === MSG.HELLO) {
            const tabId = sender.tab?.id;
            if (tabId == null) {return;}
            const tabToken = String(message.tabToken || '');
            const windowId = typeof sender.tab?.windowId === 'number' ? sender.tab.windowId : undefined;
            state.upsertTab(tabId, tabToken, message.url || sender.tab?.url || '', windowId);
            const scope = state.getTokenScope(tabToken);
            if (scope && typeof windowId === 'number') {
                state.setWindowWorkspace(windowId, scope.workspaceId);
                if (state.getActiveTabId() === tabId) {
                    state.setActiveWorkspaceId(scope.workspaceId);
                }
            }
            sendResponse({ ok: true });
            return;
        }

        if (message.type === MSG.ACTION) {
            (async () => {
                const reply = await dispatchIncomingAction((message.action || {}) as Action, sender, {
                    state,
                    ensureTabToken: life.ensureTabToken,
                    getActiveTabTokenForWindow: life.getActiveTabTokenForWindow,
                    sendAction,
                });
                sendResponse(reply);
            })().catch((error) => {
                const text = error instanceof Error ? error.message : String(error);
                sendResponse({
                    v: 1,
                    id: crypto.randomUUID(),
                    type: 'action.dispatch.failed',
                    payload: { code: 'RUNTIME_ERROR', message: `ACTION dispatch failed: ${text}` },
                    at: Date.now(),
                } satisfies Action);
            });
            return true;
        }
    };

    return {
        handleInboundAction,
        resolveActionTargetTabId,
        handleMessage,
        onActivated: life.onActivated,
        onRemoved: life.onRemoved,
        onUpdated: life.onUpdated,
        onCreated: life.onCreated,
        onAttached: life.onAttached,
        onFocusChanged: life.onFocusChanged,
        onWindowRemoved: life.onWindowRemoved,
        onStartup: life.onStartup,
        onInstalled: life.onInstalled,
        bootstrapState,
    };
};
