import { createLogger, type Logger } from '../shared/logger.js';
import type { Action } from '../shared/types.js';
import { ACTION_TYPES } from '../actions/action_types.js';
import { MSG } from '../shared/protocol.js';
import type { WsClient } from '../actions/ws_client.js';
import { createRouterState } from './state.js';
import { createLifecycleRuntime } from './life.js';
import { dispatchActionRequest } from '../actions/dispatcher.js';
import { projectInboundAction } from './projection.js';

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

const isFailedReply = (action: Action | null | undefined): boolean => {
    if (!action) {return false;}
    return action.type.endsWith('.failed');
};

const payloadOf = (action: Action | null | undefined): Record<string, unknown> => {
    if (!action) {return {};}
    return (action.payload ?? {}) as Record<string, unknown>;
};

const WORKSPACE_SCOPED_ACTION_PREFIXES = [
    'tab.',
    'record.',
    'play.',
    'dsl.',
    'checkpoint.',
    'entity_rules.',
    'task.run.',
];

const shouldAttachWorkspaceFromSender = (action: Record<string, unknown>): boolean => {
    const actionType = action.type;
    return typeof actionType === 'string'
        && WORKSPACE_SCOPED_ACTION_PREFIXES.some((prefix) => actionType.startsWith(prefix));
};

const shouldRefreshAfterContentAction = (action: Record<string, unknown>): boolean => {
    const actionType = action.type;
    return typeof actionType === 'string'
        && actionType === ACTION_TYPES.RECORD_SAVE;
};

export const createCmdRouter = (options: CmdRouterOptions) => {
    const log = options.logger ?? createLogger('sw');
    const state = createRouterState(log);

    const sendAction = async (action: Action): Promise<Action> => await options.wsClient.sendAction(action);

    const life = createLifecycleRuntime({ state, sendAction, onRefresh: options.onRefresh });
    const commandCreatedTabs = new Set<number>();
    let pendingCommandOpenCount = 0;

    const resolveActionTargetTabName = (action: Action) => {
        if (!action.workspaceName) {
            const activeChromeTabNo = state.getActiveChromeTabNo();
            return typeof activeChromeTabNo === 'number' ? activeChromeTabNo : null;
        }
        if (state.getActiveWorkspaceName() !== action.workspaceName) {return null;}
        const activeChromeTabNo = state.getActiveChromeTabNo();
        return typeof activeChromeTabNo === 'number' ? activeChromeTabNo : null;
    };

    const handleInboundAction = (action: Action) => {
        projectInboundAction(action, state, options.onRefresh);
        if (action.type === ACTION_TYPES.TAB_OPEN) {
            void handleTabOpen(action);
        }
        if (action.type === ACTION_TYPES.TAB_BIND) {
            void life.handleBindCommand(action);
        }
        if (action.type === ACTION_TYPES.TAB_CLOSE) {
            void handleTabClose(action);
        }
    };

    const handleTabOpen = async (action: Action) => {
        const payload = (action.payload ?? {}) as Record<string, unknown>;
        const createId = typeof payload.createId === 'string' ? payload.createId.trim() : '';
        pendingCommandOpenCount += 1;
        try {
            const created = await chrome.tabs.create({ url: 'https://example.com', active: true });
            if (created && typeof created.id === 'number' && typeof created.windowId === 'number') {
                commandCreatedTabs.add(created.id);
                try {
                    await life.ensureOpenedAndBound(created.id, created.windowId, { createId, workspaceName: action.workspaceName });
                } finally {
                    commandCreatedTabs.delete(created.id);
                }
            }
        } finally {
            pendingCommandOpenCount = Math.max(0, pendingCommandOpenCount - 1);
        }
    };

    const handleTabClose = async (action: Action) => {
        const payload = (action.payload ?? {}) as Record<string, unknown>;
        const tabName = typeof payload.tabName === 'string' ? payload.tabName.trim() : '';
        if (!tabName) return;
        const chromeTabNo = state.findChromeTabNoByBindingName(tabName);
        if (typeof chromeTabNo !== 'number') return;
        await chrome.tabs.remove(chromeTabNo);
    };

    const bootstrapState = async () => {
        const resetReply = await sendAction({ v: 1, id: crypto.randomUUID(), type: ACTION_TYPES.WORKFLOW_RESET_DEFAULT, payload: {} });
        if (isFailedReply(resetReply)) {
            const error = payloadOf(resetReply);
            throw new Error(`bootstrap.workflow_reset_failed: ${String(error.code || 'UNKNOWN')}:${String(error.message || 'unknown')}`);
        }
        const reply = await sendAction({ v: 1, id: crypto.randomUUID(), type: ACTION_TYPES.WORKSPACE_LIST, payload: {} });
        if (isFailedReply(reply)) {
            const error = payloadOf(reply);
            throw new Error(`bootstrap.workspace_list_failed: ${String(error.code || 'UNKNOWN')}:${String(error.message || 'unknown')}`);
        }
        const data = payloadOf(reply);
        const activeWorkspaceName = typeof data.activeWorkspaceName === 'string' ? data.activeWorkspaceName : null;
        if (activeWorkspaceName) {state.setActiveWorkspaceName(activeWorkspaceName);}
        await life.bindExistingTabs();
    };

    const handleMessage = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (payload?: unknown) => void) => {
        if (!isRecord(message) || typeof message.type !== 'string') {return;}
        const typedMessage = message as TypedRuntimeMessage;

        if (typedMessage.type === MSG.HELLO) {
            const chromeTabNo = sender.tab?.id;
            if (typeof chromeTabNo !== 'number') {
                sendResponse({ ok: false, error: 'sender tab unavailable' });
                return;
            }
            const windowId = typeof sender.tab?.windowId === 'number' ? sender.tab.windowId : undefined;
            const url = typeof typedMessage.url === 'string' ? typedMessage.url : sender.tab?.url ?? '';
            (async () => {
                let bindingName = state.getTabState(chromeTabNo)?.bindingName?.trim() ?? '';
                if (!bindingName) {
                    const preferredBindingName = typeof typedMessage.tabName === 'string' ? typedMessage.tabName.trim() : '';
                    const inflight = life.getOpenedAndBoundInflight(chromeTabNo);
                    const ensured = inflight ? await inflight : await life.ensureBoundTabRef(chromeTabNo, windowId, preferredBindingName);
                    bindingName = ensured?.bindingName?.trim() ?? '';
                }
                if (bindingName) {
                    state.upsertTab(chromeTabNo, bindingName, url, windowId);
                    const mapped = state.getBindingWorkspaceTab(bindingName);
                    if (mapped && typeof windowId === 'number') {
                        state.setWindowWorkspace(windowId, mapped.workspaceName);
                        if (state.getActiveChromeTabNo() === chromeTabNo) {
                            state.setActiveWorkspaceName(mapped.workspaceName);
                        }
                    }
                    chrome.tabs.sendMessage(chromeTabNo, { type: MSG.SET_TOKEN, tabName: bindingName }, () => {
                        void chrome.runtime.lastError;
                    });
                }
                sendResponse({ ok: true, tabName: bindingName });
            })().catch((error: unknown) => {
                sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
            });
            return true;
        }

        if (typedMessage.type === MSG.ENSURE_BOUND_TOKEN) {
            (async () => {
                const chromeTabNo = sender.tab?.id;
                if (typeof chromeTabNo !== 'number') {
                    sendResponse({ ok: false, error: 'sender tab unavailable' });
                    return;
                }

                const tabState = state.getTabState(chromeTabNo);
                const bindingName = tabState?.bindingName;
                if (bindingName) {
                    const mapped = state.getBindingWorkspaceTab(bindingName);
                    if (mapped) {
                        sendResponse({
                            ok: true,
                            bindingName,
                            workspaceName: mapped.workspaceName,
                            tabName: mapped.tabName,
                            windowId: tabState.windowId,
                        });
                        return;
                    }
                }

                const inflight = life.getOpenedAndBoundInflight(chromeTabNo);
                if (inflight) {
                    const bound = await inflight;
                    if (bound) {
                        sendResponse({
                            ok: true,
                            bindingName: bound.bindingName,
                            workspaceName: bound.workspaceName,
                            tabName: bound.tabName,
                            windowId: bound.windowId,
                        });
                        return;
                    }
                }

                const preferredBindingName = typeof typedMessage.tabName === 'string' ? typedMessage.tabName.trim() : '';
                const ensured = await life.ensureBoundTabRef(chromeTabNo, sender.tab?.windowId, preferredBindingName);
                if (ensured) {
                    state.upsertBindingWorkspaceTab(ensured.bindingName, ensured.workspaceName, ensured.tabName);
                    state.upsertTab(chromeTabNo, ensured.bindingName, typedMessage.url ?? ensured.urlHint, ensured.windowId);
                    state.setWindowWorkspace(ensured.windowId, ensured.workspaceName);
                    sendResponse({
                        ok: true,
                        bindingName: ensured.bindingName,
                        workspaceName: ensured.workspaceName,
                        tabName: ensured.tabName,
                        windowId: ensured.windowId,
                    });
                    return;
                }

                sendResponse({ ok: false, error: 'not bound' });
            })().catch((error: unknown) => {
                sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
            });
            return true;
        }

        if (typedMessage.type === MSG.ACTION) {
            (async () => {
                const chromeTabNo = sender.tab?.id;
                const action = typedMessage.action as Record<string, unknown> | null | undefined;
                if (
                    isRecord(action) &&
                    typeof action.type === 'string' &&
                    action.type === ACTION_TYPES.TAB_BOUND
                ) {
                    sendResponse({
                        v: 1,
                        id: crypto.randomUUID(),
                        type: `${ACTION_TYPES.TAB_BOUND}.failed`,
                        replyTo: typeof action.id === 'string' ? action.id : '',
                        payload: { code: 'BAD_REQUEST', message: 'tab.bound from content script is not allowed' },
                        at: Date.now(),
                    } satisfies Action);
                    return;
                }
                if (typeof chromeTabNo === 'number') {
                    const tabState = state.getTabState(chromeTabNo);
                    const bindingName = tabState?.bindingName;
                    if (bindingName && isRecord(action) && shouldAttachWorkspaceFromSender(action)) {
                        const mapped = state.getBindingWorkspaceTab(bindingName);
                        if (mapped) {
                            if (!action.workspaceName || typeof action.workspaceName !== 'string') {
                                action.workspaceName = mapped.workspaceName;
                            }
                            if (isRecord(action.payload)) {
                                action.payload.tabName = bindingName;
                            }
                        }
                    }
                }
                const reply = await dispatchActionRequest(typedMessage.action, options.wsClient);
                if (isRecord(action) && shouldRefreshAfterContentAction(action)) {
                    options.onRefresh();
                }
                sendResponse(reply);
            })().catch((error: unknown) => {
                sendResponse({
                    v: 1,
                    id: crypto.randomUUID(),
                    type: 'action.dispatch.failed',
                    payload: { code: 'RUNTIME_ERROR', message: `ACTION dispatch failed: ${error instanceof Error ? error.message : String(error)}` },
                    at: Date.now(),
                } satisfies Action);
            });
            return true;
        }
    };

    return {
        handleInboundAction,
        handleTabClose,
        resolveActionTargetTabName,
        handleMessage,
        onActivated: (info: chrome.tabs.TabActiveInfo) => {
            if (pendingCommandOpenCount > 0) {return;}
            life.onActivated(info);
        },
        onRemoved: life.onRemoved,
        onUpdated: life.onUpdated,
        onCreated: (tab: chrome.tabs.Tab) => {
            if (pendingCommandOpenCount > 0) {return;}
            if (typeof tab.id === 'number' && commandCreatedTabs.has(tab.id)) {return;}
            life.onCreated(tab);
        },
        onAttached: life.onAttached,
        onFocusChanged: life.onFocusChanged,
        onWindowRemoved: life.onWindowRemoved,
        onStartup: life.onStartup,
        onInstalled: life.onInstalled,
        bootstrapState,
    };
};
