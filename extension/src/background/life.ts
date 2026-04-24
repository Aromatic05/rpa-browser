import type { Action } from '../shared/types.js';
import { ACTION_TYPES } from '../shared/action_types.js';
import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';
import { isFailedReply, payloadOf } from './action.js';
import type { RouterState, TabRuntimeState } from './state.js';

const LIFECYCLE_THROTTLE_MS = 180;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type LifecycleOptions = {
    state: RouterState;
    sendAction: (action: Action) => Promise<Action>;
    onRefresh: () => void;
};

export type LifecycleRuntime = {
    ensureTabToken: (tabId: number, hintedWindowId?: number) => Promise<TabRuntimeState | null>;
    getActiveTabTokenForWindow: (windowId: number) => Promise<{ tabId: number; tabToken: string; urlHint: string; windowId: number } | null>;
    onActivated: (info: chrome.tabs.TabActiveInfo) => void;
    onRemoved: (tabId: number) => void;
    onUpdated: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab?: chrome.tabs.Tab) => void;
    onCreated: (tab: chrome.tabs.Tab) => void;
    onAttached: (tabId: number, info: chrome.tabs.TabAttachInfo) => void;
    onFocusChanged: (windowId: number) => void;
    onWindowRemoved: (windowId: number) => void;
    onStartup: () => void;
    onInstalled: () => void;
};

export const createLifecycleRuntime = (options: LifecycleOptions): LifecycleRuntime => {
    const WINDOW_NONE = chrome.windows.WINDOW_ID_NONE;

    const emitLifecycleAction = async (
        type: 'tab.activated' | 'tab.closed',
        payload: Record<string, unknown>,
        tabToken?: string,
    ) => {
        await options.sendAction({
            v: 1,
            id: crypto.randomUUID(),
            type,
            tabToken,
            scope: tabToken ? { tabToken } : {},
            payload,
        });
    };

    const requestTokenFromTab = async (tabId: number) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const result = await send.toTabTransport<{ ok: boolean; tabToken?: string; url?: string }>(
                tabId,
                MSG.GET_TOKEN,
                undefined,
                { timeoutMs: 1500 },
            );
            if (result.ok) {
                const data = result.data || { ok: false, error: 'no response' };
                if (data?.ok && data.tabToken) {return data;}
            } else if (result.error.code === 'NO_RECEIVER') {
                return { ok: false, error: result.error.message } as const;
            }
            if (attempt < 2) {await wait(150);}
        }
        return { ok: false, error: 'tab token request timeout' } as const;
    };

    const ensureTabToken = async (tabId: number, hintedWindowId?: number) => {
        const existing = options.state.getTabState(tabId);
        if (existing?.tabToken) {
            if (typeof hintedWindowId === 'number') {
                options.state.upsertTab(tabId, existing.tabToken, existing.lastUrl, hintedWindowId);
            }
            return options.state.getTabState(tabId) || null;
        }
        const response = await requestTokenFromTab(tabId);
        if (response?.ok && response.tabToken) {
            let windowId = typeof hintedWindowId === 'number' ? hintedWindowId : null;
            if (windowId == null) {
                const tab = await chrome.tabs.get(tabId);
                windowId = typeof tab.windowId === 'number' ? tab.windowId : null;
            }
            options.state.upsertTab(tabId, response.tabToken, response.url || '', windowId);
            return options.state.getTabState(tabId) || null;
        }
        return null;
    };

    const getActiveTabTokenForWindow = async (windowId: number) => {
        const tabs = await chrome.tabs.query({ active: true, windowId });
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') {return null;}
        const tabInfo = await ensureTabToken(tabId, windowId);
        if (!tabInfo?.tabToken) {return null;}
        return { tabId, tabToken: tabInfo.tabToken, urlHint: tabInfo.lastUrl, windowId };
    };

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
        const previousActiveTabId = options.state.getActiveTabId();
        const previousActiveWindowId = options.state.getActiveWindowId();
        options.state.setActiveTabId(info.tabId);
        options.state.setActiveWindowId(info.windowId);

        void (async () => {
            const tabInfo = await ensureTabToken(info.tabId, info.windowId);
            if (!tabInfo?.tabToken) {return;}
            const scope = options.state.getTokenScope(tabInfo.tabToken);
            if (scope) {
                options.state.setActiveWorkspaceId(scope.workspaceId);
                options.state.setWindowWorkspace(info.windowId, scope.workspaceId);
            }
            const now = Date.now();
            const key = `${info.windowId}:${info.tabId}:${tabInfo.tabToken}`;
            if (options.state.shouldThrottleTabActivated(key, now, LIFECYCLE_THROTTLE_MS)) {return;}
            await emitLifecycleAction(
                ACTION_TYPES.TAB_ACTIVATED,
                { source: 'extension.sw', url: tabInfo.lastUrl || '', at: now, windowId: info.windowId },
                tabInfo.tabToken,
            );
        })();

        if (previousActiveTabId === info.tabId && previousActiveWindowId === info.windowId) {return;}
        options.onRefresh();
    };

    const onRemoved = (tabId: number) => {
        const removed = options.state.removeTab(tabId);
        if (options.state.getActiveTabId() === tabId) {options.state.setActiveTabId(null);}
        if (removed?.tabToken) {
            void emitLifecycleAction(
                ACTION_TYPES.TAB_CLOSED,
                { source: 'extension.sw', at: Date.now(), windowId: removed.windowId },
                removed.tabToken,
            );
            options.state.removeTokenScope(removed.tabToken);
        }
        options.onRefresh();
    };

    const onUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab?: chrome.tabs.Tab) => {
        if (!changeInfo.url && typeof tab?.windowId !== 'number') {return;}
        const existing = options.state.getTabState(tabId);
        if (!existing?.tabToken) {return;}
        options.state.upsertTab(
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
                throw new Error(`tabs.onCreated tab token unavailable (tabId=${tabId}, windowId=${windowId})`);
            }
            const boundScope = options.state.getTokenScope(tabInfo.tabToken);
            const workspaceId = boundScope?.workspaceId || options.state.getWindowWorkspace(windowId) || '';
            if (!workspaceId) {
                throw new Error(
                    `tabs.onCreated workspace mapping missing (tabId=${tabId}, windowId=${windowId}, token=${tabInfo.tabToken})`,
                );
            }
            options.state.setWindowWorkspace(windowId, workspaceId);
            const result = await options.sendAction({
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
            if (isFailedReply(result)) {
                const error = payloadOf<{ code?: string; message?: string }>(result);
                throw new Error(`tabs.onCreated tab.opened failed: ${error.code || 'ERR'}:${error.message || 'unknown'}`);
            }
            const resultPayload = payloadOf(result);
            const tabScopeWorkspaceId = String((resultPayload as any)?.workspaceId || workspaceId);
            const tabScopeTabId = String((resultPayload as any)?.tabId || '');
            if (!tabScopeTabId) {
                throw new Error(`tabs.onCreated tab.opened missing tabId (tabId=${tabId}, windowId=${windowId})`);
            }
            options.state.upsertTokenScope(tabInfo.tabToken, tabScopeWorkspaceId, tabScopeTabId);
            options.state.setWindowWorkspace(windowId, tabScopeWorkspaceId);
            options.onRefresh();
        })();
    };

    const onAttached = (tabId: number, info: chrome.tabs.TabAttachInfo) => {
        void (async () => {
            const tabInfo = await ensureTabToken(tabId, info.newWindowId);
            if (!tabInfo?.tabToken) {return;}
            const scope = options.state.getTokenScope(tabInfo.tabToken);
            const targetWorkspaceId = options.state.getWindowWorkspace(info.newWindowId);
            if (!scope || !targetWorkspaceId || scope.workspaceId === targetWorkspaceId) {
                if (scope) {options.state.setWindowWorkspace(info.newWindowId, scope.workspaceId);}
                return;
            }
            const result = await options.sendAction({
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
            if (!isFailedReply(result)) {
                const resultPayload = payloadOf(result);
                const workspaceId = String((resultPayload as any)?.workspaceId || targetWorkspaceId);
                const targetTabId = String((resultPayload as any)?.tabId || scope.tabId);
                options.state.upsertTokenScope(tabInfo.tabToken, workspaceId, targetTabId);
                options.state.setWindowWorkspace(info.newWindowId, workspaceId);
                if (options.state.getActiveWindowId() === info.newWindowId) {
                    options.state.setActiveWorkspaceId(workspaceId);
                }
            }
            options.onRefresh();
        })();
    };

    const onFocusChanged = (windowId: number) => {
        if (windowId === WINDOW_NONE) {return;}
        options.state.setActiveWindowId(windowId);
        void (async () => {
            const active = await getActiveTabTokenForWindow(windowId);
            if (!active) {return;}
            const scope = options.state.getTokenScope(active.tabToken);
            if (!scope) {return;}
            const now = Date.now();
            const key = `${windowId}:${scope.workspaceId}`;
            if (options.state.shouldThrottleWorkspaceActivated(key, now, LIFECYCLE_THROTTLE_MS)) {
                options.onRefresh();
                return;
            }
            options.state.setActiveWorkspaceId(scope.workspaceId);
            options.state.setWindowWorkspace(windowId, scope.workspaceId);
            await options.sendAction({
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
        const workspaceId = options.state.getWindowWorkspace(windowId);
        options.state.clearWindowWorkspace(windowId);
        if (workspaceId && options.state.getActiveWorkspaceId() === workspaceId) {
            options.state.setActiveWorkspaceId(null);
        }
        options.onRefresh();
    };

    const onStartup = () => {
        options.state.resetStartupState();
    };

    const onInstalled = () => {
        options.state.resetInstalledState();
    };

    return {
        ensureTabToken,
        getActiveTabTokenForWindow,
        onActivated,
        onRemoved,
        onUpdated,
        onCreated,
        onAttached,
        onFocusChanged,
        onWindowRemoved,
        onStartup,
        onInstalled,
    };
};
