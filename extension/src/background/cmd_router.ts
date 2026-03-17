import { createLogger } from '../shared/logger.js';
import type { Action, ActionErr, ActionOk } from '../shared/types.js';
import { ACTION_TYPES } from '../shared/action_types.js';
import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';
import type { WsClient } from './ws_client.js';

export type CmdRouterOptions = {
    wsClient: WsClient;
    onRefresh: () => void;
    logger?: (...args: unknown[]) => void;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createCmdRouter = (options: CmdRouterOptions) => {
    const log = options.logger || createLogger('sw');
    const WINDOW_NONE = chrome.windows.WINDOW_ID_NONE;

    const tabState = new Map<number, { tabToken: string; lastUrl: string; windowId: number | null; updatedAt: number }>();
    const tokenToScope = new Map<string, { workspaceId: string; tabId: string }>();
    const windowToWorkspace = new Map<number, string>();

    let activeTabId: number | null = null;
    let activeWorkspaceId: string | null = null;
    let activeWindowId: number | null = null;

    const withActionBase = (action: Action): Action => ({
        v: 1 as const,
        id: action.id || crypto.randomUUID(),
        type: action.type,
        payload: action.payload,
        scope: action.scope,
        tabToken: action.tabToken,
        at: action.at || Date.now(),
        traceId: action.traceId,
    });

    const sendAction = async (action: Action): Promise<ActionOk<any> | ActionErr> =>
        options.wsClient.sendAction(withActionBase(action));

    const emitLifecycleAction = async (
        type: 'tab.activated' | 'tab.closed',
        payload: Record<string, unknown>,
        tabToken?: string,
    ) => {
        try {
            await sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type,
                tabToken,
                scope: tabToken ? { tabToken } : {},
                payload,
            });
        } catch {
            // ignore lifecycle emit failures
        }
    };

    const upsertTab = (tabId: number, tabToken: string, url: string, windowId?: number | null) => {
        const existingWindowId = tabState.get(tabId)?.windowId ?? null;
        tabState.set(tabId, {
            tabToken,
            lastUrl: url,
            windowId: typeof windowId === 'number' ? windowId : existingWindowId,
            updatedAt: Date.now(),
        });
    };

    const findTabIdByToken = (tabToken: string) => {
        for (const [tabId, state] of tabState.entries()) {
            if (state.tabToken === tabToken) return tabId;
        }
        return null;
    };

    const requestTokenFromTab = async (tabId: number) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const result = await send.toTab<{ ok: boolean; tabToken?: string; url?: string }>(tabId, MSG.GET_TOKEN, undefined, {
                timeoutMs: 1500,
            });
            if (result.ok) {
                const data = result.data || { ok: false, error: 'no response' };
                if (data?.ok && data.tabToken) return data;
            } else if (result.error.code === 'NO_RECEIVER') {
                return { ok: false, error: result.error.message } as const;
            }
            if (attempt < 2) await wait(150);
        }
        return { ok: false, error: 'tab token request timeout' } as const;
    };

    const ensureTabToken = async (tabId: number, hintedWindowId?: number) => {
        const existing = tabState.get(tabId);
        if (existing?.tabToken) {
            if (typeof hintedWindowId === 'number') {
                upsertTab(tabId, existing.tabToken, existing.lastUrl, hintedWindowId);
            }
            return tabState.get(tabId) || null;
        }
        const response = await requestTokenFromTab(tabId);
        if (response?.ok && response.tabToken) {
            let windowId = typeof hintedWindowId === 'number' ? hintedWindowId : null;
            if (windowId == null) {
                try {
                    const tab = await chrome.tabs.get(tabId);
                    windowId = typeof tab.windowId === 'number' ? tab.windowId : null;
                } catch {
                    windowId = null;
                }
            }
            upsertTab(tabId, response.tabToken, response.url || '', windowId);
            return tabState.get(tabId) || null;
        }
        return null;
    };

    const upsertTokenScope = (tabToken: string, workspaceId: string, tabId: string) => {
        const existing = tokenToScope.get(tabToken);
        if (existing && (existing.workspaceId !== workspaceId || existing.tabId !== tabId)) {
            log('mapping.scope_replace', {
                tabToken,
                existing,
                incoming: { workspaceId, tabId },
            });
        }
        tokenToScope.set(tabToken, { workspaceId, tabId });
        return true;
    };

    const bindWorkspaceToWindowIfKnown = (tabToken: string) => {
        const scope = tokenToScope.get(tabToken);
        if (!scope) return;
        const tabId = findTabIdByToken(tabToken);
        if (tabId == null) return;
        const windowId = tabState.get(tabId)?.windowId;
        if (typeof windowId !== 'number') return;
        windowToWorkspace.set(windowId, scope.workspaceId);
    };

    const getActiveTabTokenForWindow = async (windowId: number) => {
        const tabs = await chrome.tabs.query({ active: true, windowId });
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') return null;
        const tabInfo = await ensureTabToken(tabId, windowId);
        if (!tabInfo?.tabToken) return null;
        return { tabId, tabToken: tabInfo.tabToken, urlHint: tabInfo.lastUrl, windowId };
    };

    const handleInboundAction = (action: Action) => {
        if (action.type === ACTION_TYPES.WORKSPACE_SYNC) return;

        if (action.type === ACTION_TYPES.WORKSPACE_LIST) {
            const data = (action.payload || {}) as Record<string, unknown>;
            const activeId = data.activeWorkspaceId ? String(data.activeWorkspaceId) : null;
            if (activeId) activeWorkspaceId = activeId;
            options.onRefresh();
            return;
        }

        if (action.type === ACTION_TYPES.TAB_BOUND) {
            const data = (action.payload || {}) as Record<string, unknown>;
            if (data.tabToken && data.workspaceId && data.tabId) {
                upsertTokenScope(String(data.tabToken), String(data.workspaceId), String(data.tabId));
                bindWorkspaceToWindowIfKnown(String(data.tabToken));
            }
            if (!activeWorkspaceId && data.workspaceId) {
                activeWorkspaceId = String(data.workspaceId);
            }
            options.onRefresh();
            return;
        }

        if (action.type === ACTION_TYPES.WORKSPACE_CHANGED) {
            const data = (action.payload || {}) as Record<string, unknown>;
            const workspaceId = data.workspaceId ? String(data.workspaceId) : action.scope?.workspaceId || null;
            if (workspaceId) {
                activeWorkspaceId = workspaceId;
                if (typeof activeWindowId === 'number' && activeWindowId !== WINDOW_NONE) {
                    windowToWorkspace.set(activeWindowId, workspaceId);
                }
            }
            options.onRefresh();
        }
    };

    const bootstrapState = async () => {
        try {
            const payload = await sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.WORKSPACE_LIST,
                payload: {},
                scope: {},
            });
            if (!payload?.ok) {
                log('bootstrap.workspace_list_failed', payload?.error || null);
                return;
            }
            const data = payload.data || {};
            const activeId = (data as any).activeWorkspaceId ? String((data as any).activeWorkspaceId) : null;
            if (activeId) activeWorkspaceId = activeId;
        } catch (error) {
            log('bootstrap.failed', error instanceof Error ? error.message : String(error));
        }
    };

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
        activeTabId = info.tabId;
        activeWindowId = info.windowId;
        void (async () => {
            const tabInfo = await ensureTabToken(info.tabId, info.windowId);
            if (!tabInfo?.tabToken) return;
            const scope = tokenToScope.get(tabInfo.tabToken);
            if (scope) {
                activeWorkspaceId = scope.workspaceId;
                windowToWorkspace.set(info.windowId, scope.workspaceId);
            }
            await emitLifecycleAction(
                ACTION_TYPES.TAB_ACTIVATED,
                {
                    source: 'extension.sw',
                    url: tabInfo.lastUrl || '',
                    at: Date.now(),
                    windowId: info.windowId,
                },
                tabInfo.tabToken,
            );
        })();
        options.onRefresh();
    };

    const onRemoved = (tabId: number) => {
        const removed = tabState.get(tabId);
        tabState.delete(tabId);
        if (activeTabId === tabId) activeTabId = null;
        if (removed?.tabToken) {
            void emitLifecycleAction(
                ACTION_TYPES.TAB_CLOSED,
                {
                    source: 'extension.sw',
                    at: Date.now(),
                    windowId: removed.windowId,
                },
                removed.tabToken,
            );
            tokenToScope.delete(removed.tabToken);
        }
        options.onRefresh();
    };

    const onUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab?: chrome.tabs.Tab) => {
        if (!changeInfo.url && typeof tab?.windowId !== 'number') return;
        const existing = tabState.get(tabId);
        if (!existing?.tabToken) return;
        upsertTab(
            tabId,
            existing.tabToken,
            changeInfo.url || existing.lastUrl,
            typeof tab?.windowId === 'number' ? tab.windowId : undefined,
        );
    };

    const onCreated = (tab: chrome.tabs.Tab) => {
        const tabId = tab.id;
        const windowId = tab.windowId;
        if (typeof tabId !== 'number' || typeof windowId !== 'number') {
            throw new Error('tabs.onCreated missing tab/window id');
        }
        void (async () => {
            const tabInfo = await ensureTabToken(tabId, windowId);
            if (!tabInfo?.tabToken) {
                throw new Error('tabs.onCreated tab token unavailable');
            }
            const workspaceId = windowToWorkspace.get(windowId);
            if (!workspaceId) {
                throw new Error(`tabs.onCreated workspace mapping missing for window ${windowId}`);
            }
            const result = await sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_OPENED,
                tabToken: tabInfo.tabToken,
                scope: { tabToken: tabInfo.tabToken, workspaceId },
                payload: {
                    source: 'extension.sw',
                    url: tabInfo.lastUrl || tab.url || '',
                    title: tab.title || '',
                    at: Date.now(),
                    windowId,
                    workspaceId,
                },
            });
            if (!result.ok) {
                throw new Error(`tabs.onCreated tab.opened failed: ${result.error.code}:${result.error.message}`);
            }
            const tabScopeWorkspaceId = String((result.data as any)?.workspaceId || workspaceId);
            const tabScopeTabId = String((result.data as any)?.tabId || '');
            if (!tabScopeTabId) {
                throw new Error('tabs.onCreated tab.opened missing tabId');
            }
            upsertTokenScope(tabInfo.tabToken, tabScopeWorkspaceId, tabScopeTabId);
            windowToWorkspace.set(windowId, tabScopeWorkspaceId);
            options.onRefresh();
        })();
    };

    const onAttached = (tabId: number, info: chrome.tabs.TabAttachInfo) => {
        void (async () => {
            const tabInfo = await ensureTabToken(tabId, info.newWindowId);
            if (!tabInfo?.tabToken) return;
            const scope = tokenToScope.get(tabInfo.tabToken);
            const targetWorkspaceId = windowToWorkspace.get(info.newWindowId);
            if (!scope || !targetWorkspaceId || scope.workspaceId === targetWorkspaceId) {
                if (scope) windowToWorkspace.set(info.newWindowId, scope.workspaceId);
                return;
            }
            const result = await sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_REASSIGN,
                scope: { tabToken: tabInfo.tabToken },
                payload: {
                    workspaceId: targetWorkspaceId,
                    source: 'extension.sw',
                    windowId: info.newWindowId,
                    at: Date.now(),
                },
            });
            if (result.ok) {
                const workspaceId = String((result.data as any)?.workspaceId || targetWorkspaceId);
                const targetTabId = String((result.data as any)?.tabId || scope.tabId);
                upsertTokenScope(tabInfo.tabToken, workspaceId, targetTabId);
                windowToWorkspace.set(info.newWindowId, workspaceId);
                if (activeWindowId === info.newWindowId) activeWorkspaceId = workspaceId;
            }
            options.onRefresh();
        })();
    };

    const onFocusChanged = (windowId: number) => {
        if (windowId === WINDOW_NONE) return;
        activeWindowId = windowId;
        void (async () => {
            const active = await getActiveTabTokenForWindow(windowId);
            if (!active) return;
            const scope = tokenToScope.get(active.tabToken);
            if (!scope) return;
            activeWorkspaceId = scope.workspaceId;
            windowToWorkspace.set(windowId, scope.workspaceId);
            await sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.WORKSPACE_SET_ACTIVE,
                payload: { workspaceId: scope.workspaceId },
                scope: { workspaceId: scope.workspaceId },
            });
            options.onRefresh();
        })();
    };

    const onWindowRemoved = (windowId: number) => {
        const workspaceId = windowToWorkspace.get(windowId);
        windowToWorkspace.delete(windowId);
        if (workspaceId && activeWorkspaceId === workspaceId) {
            activeWorkspaceId = null;
        }
        options.onRefresh();
    };

    const onStartup = () => {
        windowToWorkspace.clear();
    };

    const onInstalled = () => {
        windowToWorkspace.clear();
    };

    const handleMessage = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (payload?: any) => void) => {
        if (!message?.type) return;

        if (message.type === MSG.HELLO) {
            const tabId = sender.tab?.id;
            if (tabId == null) return;
            const tabToken = String(message.tabToken || '');
            const windowId = typeof sender.tab?.windowId === 'number' ? sender.tab.windowId : undefined;
            upsertTab(tabId, tabToken, message.url || sender.tab?.url || '', windowId);
            const scope = tokenToScope.get(tabToken);
            if (scope && typeof windowId === 'number') {
                windowToWorkspace.set(windowId, scope.workspaceId);
                if (activeTabId === tabId) {
                    activeWorkspaceId = scope.workspaceId;
                }
            }
            sendResponse({ ok: true });
            return;
        }

        if (message.type === MSG.ACTION) {
            (async () => {
                const action = (message.action || {}) as Action;
                if (action.type === ACTION_TYPES.WORKSPACE_CREATE) {
                    const payload = (action.payload || {}) as { startUrl?: string };
                    const startUrl = String(payload.startUrl || '').trim();
                    const createdWindow = await chrome.windows.create({
                        url: startUrl || undefined,
                        focused: true,
                    });
                    const createdTabId = createdWindow.tabs?.[0]?.id;
                    const createdWindowId = createdWindow.id;
                    if (typeof createdTabId !== 'number' || typeof createdWindowId !== 'number') {
                        sendResponse({ ok: false, error: { code: 'RUNTIME_ERROR', message: 'failed to create window' } });
                        return;
                    }
                    activeWindowId = createdWindowId;
                    const tabInfo = await ensureTabToken(createdTabId, createdWindowId);
                    if (!tabInfo?.tabToken) {
                        sendResponse({ ok: false, error: { code: 'RUNTIME_ERROR', message: 'new window tab token unavailable' } });
                        return;
                    }
                    const claimed = await sendAction({
                        v: 1,
                        id: crypto.randomUUID(),
                        type: ACTION_TYPES.TAB_PING,
                        tabToken: tabInfo.tabToken,
                        scope: { tabToken: tabInfo.tabToken },
                        payload: {
                            source: 'extension.workspace.create',
                            url: tabInfo.lastUrl || startUrl || '',
                            at: Date.now(),
                            windowId: createdWindowId,
                        },
                    });
                    if (!claimed.ok) {
                        sendResponse(claimed);
                        return;
                    }
                    const workspaceId = String((claimed.data as any)?.workspaceId || '');
                    const tabId = String((claimed.data as any)?.tabId || '');
                    if (workspaceId) {
                        activeWorkspaceId = workspaceId;
                        windowToWorkspace.set(createdWindowId, workspaceId);
                    }
                    sendResponse({
                        ok: true,
                        data: {
                            workspaceId: workspaceId || null,
                            tabId: tabId || null,
                            tabToken: tabInfo.tabToken,
                            windowId: createdWindowId,
                        },
                    });
                    options.onRefresh();
                    return;
                }
                let tabToken = (action.tabToken || action.scope?.tabToken) as string | undefined;
                const senderTabId = sender.tab?.id;
                const senderWindowId = sender.tab?.windowId;

                if (typeof senderTabId === 'number') {
                    const senderTabInfo = await ensureTabToken(senderTabId, senderWindowId);
                    if (senderTabInfo?.tabToken) tabToken = senderTabInfo.tabToken;
                }

                if (!tabToken && typeof senderWindowId === 'number') {
                    const active = await getActiveTabTokenForWindow(senderWindowId);
                    if (active) tabToken = active.tabToken;
                }

                if (!tabToken && action.type !== ACTION_TYPES.TAB_INIT) {
                    sendResponse({ ok: false, error: 'tab token unavailable' });
                    return;
                }

                const tokenScope = tabToken ? tokenToScope.get(tabToken) : undefined;
                const scope = tokenScope ? { workspaceId: tokenScope.workspaceId, tabId: tokenScope.tabId } : undefined;
                const requestedWorkspaceId = action.scope?.workspaceId;
                const requestedTabId = action.scope?.tabId;
                const hasExplicitScope = !!(requestedWorkspaceId || requestedTabId);

                const scopedScope = hasExplicitScope
                    ? {
                          ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
                          ...(requestedTabId ? { tabId: requestedTabId } : {}),
                      }
                    : scope
                      ? { workspaceId: scope.workspaceId, tabId: scope.tabId, ...(tabToken ? { tabToken } : {}) }
                      : tabToken
                        ? { tabToken }
                        : {};

                const scoped: Action = {
                    ...action,
                    v: 1,
                    id: action.id || crypto.randomUUID(),
                    at: action.at || Date.now(),
                    tabToken: hasExplicitScope ? undefined : tabToken,
                    scope: scopedScope,
                };

                if (scope?.workspaceId) activeWorkspaceId = scope.workspaceId;

                const payload = await sendAction(scoped);
                sendResponse(payload);

                const effectiveWorkspaceId = payload?.ok
                    ? (payload.data as any)?.workspaceId || scope?.workspaceId || activeWorkspaceId
                    : null;
                if (!payload?.ok || !effectiveWorkspaceId) return;

                const responseTabToken = (payload.data as any)?.tabToken as string | undefined;
                const responseTabId = (payload.data as any)?.tabId as string | undefined;
                if (responseTabToken && responseTabId) {
                    upsertTokenScope(responseTabToken, String(effectiveWorkspaceId), String(responseTabId));
                    bindWorkspaceToWindowIfKnown(responseTabToken);
                }

                if (typeof senderTabId === 'number') {
                    if (tabToken) {
                        const oldTabId = findTabIdByToken(tabToken);
                        if (oldTabId != null && oldTabId !== senderTabId) {
                            tabState.delete(oldTabId);
                        }
                    }
                    const senderUrl = sender.tab?.url || tabState.get(senderTabId)?.lastUrl || '';
                    if (tabToken) {
                        upsertTab(senderTabId, tabToken, senderUrl, senderWindowId);
                    }
                    if (typeof senderWindowId === 'number') {
                        windowToWorkspace.set(senderWindowId, String(effectiveWorkspaceId));
                    }
                }
            })().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                try {
                    sendResponse({ ok: false, error: { code: 'RUNTIME_ERROR', message: `ACTION dispatch failed: ${message}` } });
                } catch {
                    // ignore
                }
            });
            return true;
        }
    };

    return {
        handleInboundAction,
        handleMessage,
        onActivated,
        onRemoved,
        onUpdated,
        onCreated,
        onAttached,
        onFocusChanged,
        onWindowRemoved,
        onStartup,
        onInstalled,
        bootstrapState,
    };
};
