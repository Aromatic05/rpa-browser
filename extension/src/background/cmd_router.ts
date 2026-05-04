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

export const createCmdRouter = (options: CmdRouterOptions) => {
    const log = options.logger ?? createLogger('sw');
    const state = createRouterState(log);

    const sendAction = async (action: Action): Promise<Action> => await options.wsClient.sendAction(action);

    const life = createLifecycleRuntime({ state, sendAction, onRefresh: options.onRefresh });

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
    };

    const bootstrapState = async () => {
        const reply = await sendAction({ v: 1, id: crypto.randomUUID(), type: ACTION_TYPES.WORKSPACE_LIST, payload: {} });
        if (isFailedReply(reply)) {
            const error = payloadOf(reply);
            throw new Error(`bootstrap.workspace_list_failed: ${String(error.code || 'UNKNOWN')}:${String(error.message || 'unknown')}`);
        }
        const data = payloadOf(reply);
        const activeWorkspaceName = typeof data.activeWorkspaceName === 'string' ? data.activeWorkspaceName : null;
        if (activeWorkspaceName) {state.setActiveWorkspaceName(activeWorkspaceName);}
    };

    const handleMessage = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (payload?: unknown) => void) => {
        if (!isRecord(message) || typeof message.type !== 'string') {return;}
        const typedMessage = message as TypedRuntimeMessage;

        if (typedMessage.type === MSG.HELLO) {
            const chromeTabNo = sender.tab?.id;
            if (typeof chromeTabNo !== 'number') {return;}
            const bindingName = typeof typedMessage.tabName === 'string' ? typedMessage.tabName : '';
            const windowId = typeof sender.tab?.windowId === 'number' ? sender.tab.windowId : undefined;
            const url = typeof typedMessage.url === 'string' ? typedMessage.url : sender.tab?.url ?? '';
            state.upsertTab(chromeTabNo, bindingName, url, windowId);
            const mapped = state.getBindingWorkspaceTab(bindingName);
            if (mapped && typeof windowId === 'number') {
                state.setWindowWorkspace(windowId, mapped.workspaceName);
                if (state.getActiveChromeTabNo() === chromeTabNo) {
                    state.setActiveWorkspaceName(mapped.workspaceName);
                }
            }
            sendResponse({ ok: true });
            return;
        }

        if (typedMessage.type === MSG.ENSURE_BOUND_TOKEN) {
            (async () => {
                const chromeTabNo = sender.tab?.id;
                const windowId = sender.tab?.windowId;
                if (typeof chromeTabNo !== 'number' || typeof windowId !== 'number') {
                    sendResponse({ ok: false, error: 'sender tab unavailable' });
                    return;
                }
                const preferredBindingName = typeof typedMessage.tabName === 'string' ? typedMessage.tabName : undefined;
                const bound = await life.ensureBoundTabRef(chromeTabNo, windowId, preferredBindingName);
                if (!bound) {
                    sendResponse({ ok: false, error: 'binding unavailable' });
                    return;
                }
                sendResponse({
                    ok: true,
                    bindingName: bound.bindingName,
                    workspaceName: bound.workspaceName,
                    tabName: bound.tabName,
                    windowId: bound.windowId,
                });
            })().catch((error: unknown) => {
                sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
            });
            return true;
        }

        if (typedMessage.type === MSG.ACTION) {
            (async () => {
                const reply = await dispatchActionRequest(typedMessage.action, options.wsClient);
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
