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

type TypedRuntimeMessage = {
    type: string;
    tabToken?: string;
    url?: string;
    action?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

export const createCmdRouter = (options: CmdRouterOptions): {
    handleInboundAction: (action: Action) => void;
    resolveActionTargetTabId: (action: Action) => number | null;
    handleMessage: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (payload?: unknown) => void) => boolean | undefined;
    onActivated: (info: chrome.tabs.TabActiveInfo) => void;
    onRemoved: (tabId: number) => void;
    onUpdated: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab?: chrome.tabs.Tab) => void;
    onCreated: (tab: chrome.tabs.Tab) => void;
    onAttached: (tabId: number, info: chrome.tabs.TabAttachInfo) => void;
    onFocusChanged: (windowId: number) => void;
    onWindowRemoved: (windowId: number) => void;
    onStartup: () => void;
    onInstalled: () => void;
    bootstrapState: () => Promise<void>;
} => {
    const log = options.logger ?? createLogger('sw');
    const WINDOW_NONE = chrome.windows.WINDOW_ID_NONE;
    const state = createRouterState(log);
    const toStringValue = (value: unknown): string | null =>
        typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

    const sendAction = async (action: Action): Promise<Action> => await options.wsClient.sendAction(withActionBase(action));

    const life = createLifecycleRuntime({
        state,
        sendAction,
        onRefresh: options.onRefresh,
    });

    const resolveActionTargetTabId = (action: Action) => {
        const token = action.tabToken ?? action.scope?.tabToken;
        const targetTabId = token ? state.findTabIdByToken(token) : state.getActiveTabId();
        return typeof targetTabId === 'number' ? targetTabId : null;
    };

    const handleInboundAction = (action: Action) => {
        if (action.type === ACTION_TYPES.WORKSPACE_SYNC) {return;}

        if (action.type === ACTION_TYPES.WORKSPACE_LIST) {
            const data = (action.payload ?? {}) as Record<string, unknown>;
            const activeId = toStringValue(data.activeWorkspaceId);
            if (activeId) {state.setActiveWorkspaceId(activeId);}
            options.onRefresh();
            return;
        }

        if (action.type === ACTION_TYPES.TAB_BOUND) {
            const data = (action.payload ?? {}) as Record<string, unknown>;
            const tabToken = toStringValue(data.tabToken);
            const workspaceId = toStringValue(data.workspaceId);
            const tabId = toStringValue(data.tabId);
            if (tabToken && workspaceId && tabId) {
                state.upsertTokenScope(tabToken, workspaceId, tabId);
                state.bindWorkspaceToWindowIfKnown(tabToken);
            }
            if (!state.getActiveWorkspaceId() && workspaceId) {
                state.setActiveWorkspaceId(workspaceId);
            }
            options.onRefresh();
            return;
        }

        if (action.type === ACTION_TYPES.WORKFLOW_OPEN || action.type === `${ACTION_TYPES.WORKFLOW_OPEN}.result`) {
            const data = (action.payload ?? {}) as Record<string, unknown>;
            const workspaceId = toStringValue(data.workspaceId);
            const tabToken = toStringValue(data.tabToken);
            const tabId = toStringValue(data.tabId);
            if (workspaceId && tabToken && tabId) {
                state.upsertTokenScope(tabToken, workspaceId, tabId);
                state.setActiveWorkspaceId(workspaceId);
            }
            options.onRefresh();
            return;
        }

        if (action.type === ACTION_TYPES.WORKSPACE_CHANGED) {
            const data = (action.payload ?? {}) as Record<string, unknown>;
            const workspaceId = toStringValue(data.workspaceId) ?? action.scope?.workspaceId ?? null;
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
            const error = payloadOf(reply);
            const code = typeof error.code === 'string' ? error.code : 'UNKNOWN';
            const message = typeof error.message === 'string' ? error.message : 'unknown';
            throw new Error(`bootstrap.workspace_list_failed: ${code}:${message}`);
        }
        const data = payloadOf(reply);
        const activeId = toStringValue(data.activeWorkspaceId);
        if (activeId) {state.setActiveWorkspaceId(activeId);}
    };

    const handleMessage = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (payload?: unknown) => void) => {
        if (!isRecord(message) || typeof message.type !== 'string') {return;}
        const typedMessage = message as TypedRuntimeMessage;

        if (typedMessage.type === MSG.HELLO) {
            const tabId = sender.tab?.id;
            if (typeof tabId !== 'number') {return;}
            const tabToken = typeof typedMessage.tabToken === 'string' ? typedMessage.tabToken : '';
            const windowId = typeof sender.tab?.windowId === 'number' ? sender.tab.windowId : undefined;
            const url = typeof typedMessage.url === 'string' ? typedMessage.url : sender.tab?.url ?? '';
            state.upsertTab(tabId, tabToken, url, windowId);
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

        if (typedMessage.type === MSG.ENSURE_BOUND_TOKEN) {
            (async () => {
                const tabId = sender.tab?.id;
                const windowId = sender.tab?.windowId;
                if (typeof tabId !== 'number' || typeof windowId !== 'number') {
                    sendResponse({ ok: false, error: 'sender tab unavailable' });
                    return;
                }
                const preferredToken = typeof typedMessage.tabToken === 'string' ? typedMessage.tabToken : undefined;
                const bound = await life.ensureBoundTabToken(tabId, windowId, preferredToken);
                if (!bound) {
                    sendResponse({ ok: false, error: 'bound token unavailable' });
                    return;
                }
                sendResponse({
                    ok: true,
                    tabToken: bound.tabToken,
                    workspaceId: bound.workspaceId,
                    tabId: bound.agentTabId || undefined,
                    windowId: bound.windowId,
                });
            })().catch((error: unknown) => {
                const text = error instanceof Error ? error.message : String(error);
                sendResponse({ ok: false, error: text });
            });
            return true;
        }

        if (typedMessage.type === MSG.ACTION) {
            (async () => {
                const incomingAction = (typedMessage.action ?? {}) as Action;
                const reply = await dispatchIncomingAction(incomingAction, sender, {
                    state,
                    ensureTabToken: life.ensureTabToken,
                    getActiveTabTokenForWindow: life.getActiveTabTokenForWindow,
                    sendAction,
                });
                sendResponse(reply);
            })().catch((error: unknown) => {
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
