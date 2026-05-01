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
    tabName?: string;
    url?: string;
    action?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

export const createCmdRouter = (options: CmdRouterOptions): {
    handleInboundAction: (action: Action) => void;
    resolveActionTargetTabName: (action: Action) => number | null;
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

    const resolveActionTargetTabName = (action: Action) => {
        if (!action.workspaceName) {
            const activeTabName = state.getActiveTabName();
            return typeof activeTabName === 'number' ? activeTabName : null;
        }
        if (state.getActiveWorkspaceName() !== action.workspaceName) {return null;}
        const activeTabName = state.getActiveTabName();
        return typeof activeTabName === 'number' ? activeTabName : null;
    };

    const handleInboundAction = (action: Action) => {
        if (action.type === ACTION_TYPES.WORKSPACE_SYNC) {return;}

        if (action.type === ACTION_TYPES.WORKSPACE_LIST) {
            const data = (action.payload ?? {}) as Record<string, unknown>;
            const activeId = toStringValue(data.activeWorkspaceName);
            if (activeId) {state.setActiveWorkspaceName(activeId);}
            options.onRefresh();
            return;
        }

        if (action.type === ACTION_TYPES.TAB_BOUND) {
            const data = (action.payload ?? {}) as Record<string, unknown>;
            const workspaceName = toStringValue(data.workspaceName);
            const tabName = toStringValue(data.tabName);
            if (workspaceName && tabName) {
                const activeTabName = state.getActiveTabName();
                if (typeof activeTabName === 'number') {
                    const activeTab = state.getTabState(activeTabName);
                    if (activeTab?.tabName) {
                        state.upsertTokenScope(activeTab.tabName, workspaceName, tabName);
                        state.bindWorkspaceToWindowIfKnown(activeTab.tabName);
                    }
                }
            }
            if (!state.getActiveWorkspaceName() && workspaceName) {
                state.setActiveWorkspaceName(workspaceName);
            }
            options.onRefresh();
            return;
        }

        if (action.type === ACTION_TYPES.WORKFLOW_OPEN || action.type === `${ACTION_TYPES.WORKFLOW_OPEN}.result`) {
            const data = (action.payload ?? {}) as Record<string, unknown>;
            const workspaceName = toStringValue(data.workspaceName);
            const tabName = toStringValue(data.tabName);
            if (workspaceName && tabName) {
                const activeTabName = state.getActiveTabName();
                if (typeof activeTabName === 'number') {
                    const activeTab = state.getTabState(activeTabName);
                    if (activeTab?.tabName) {
                        state.upsertTokenScope(activeTab.tabName, workspaceName, tabName);
                        state.bindWorkspaceToWindowIfKnown(activeTab.tabName);
                    }
                }
                state.setActiveWorkspaceName(workspaceName);
            }
            options.onRefresh();
            return;
        }

        if (action.type === ACTION_TYPES.WORKSPACE_CHANGED) {
            const data = (action.payload ?? {}) as Record<string, unknown>;
            const workspaceName = toStringValue(data.workspaceName) ?? action.workspaceName ?? null;
            if (workspaceName) {
                state.setActiveWorkspaceName(workspaceName);
                const activeWindowId = state.getActiveWindowId();
                if (typeof activeWindowId === 'number' && activeWindowId !== WINDOW_NONE) {
                    state.setWindowWorkspace(activeWindowId, workspaceName);
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
        });
        if (isFailedReply(reply)) {
            const error = payloadOf(reply);
            const code = typeof error.code === 'string' ? error.code : 'UNKNOWN';
            const message = typeof error.message === 'string' ? error.message : 'unknown';
            throw new Error(`bootstrap.workspace_list_failed: ${code}:${message}`);
        }
        const data = payloadOf(reply);
        const activeId = toStringValue(data.activeWorkspaceName);
        if (activeId) {state.setActiveWorkspaceName(activeId);}
    };

    const handleMessage = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (payload?: unknown) => void) => {
        if (!isRecord(message) || typeof message.type !== 'string') {return;}
        const typedMessage = message as TypedRuntimeMessage;

        if (typedMessage.type === MSG.HELLO) {
            const tabId = sender.tab?.id;
            if (typeof tabId !== 'number') {return;}
            const tabName = typeof typedMessage.tabName === 'string' ? typedMessage.tabName : '';
            const windowId = typeof sender.tab?.windowId === 'number' ? sender.tab.windowId : undefined;
            const url = typeof typedMessage.url === 'string' ? typedMessage.url : sender.tab?.url ?? '';
            state.upsertTab(tabId, tabName, url, windowId);
            const scope = state.getTokenScope(tabName);
            if (scope && typeof windowId === 'number') {
                state.setWindowWorkspace(windowId, scope.workspaceName);
                if (state.getActiveTabName() === tabId) {
                    state.setActiveWorkspaceName(scope.workspaceName);
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
                const preferredToken = typeof typedMessage.tabName === 'string' ? typedMessage.tabName : undefined;
                const bound = await life.ensureBoundTabName(tabId, windowId, preferredToken);
                if (!bound) {
                    sendResponse({ ok: false, error: 'bound token unavailable' });
                    return;
                }
                sendResponse({
                    ok: true,
                    tabName: bound.tabName,
                    workspaceName: bound.workspaceName,
                    tabId: bound.agentTabName || undefined,
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
                    ensureTabName: life.ensureTabName,
                    getActiveTabNameForWindow: life.getActiveTabNameForWindow,
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
        resolveActionTargetTabName,
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
