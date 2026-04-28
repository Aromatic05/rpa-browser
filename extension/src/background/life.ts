import type { Action } from '../shared/types.js';
import { ACTION_TYPES } from '../shared/action_types.js';
import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';
import { isFailedReply, payloadOf } from './action.js';
import type { RouterState, TabRuntimeState } from './state.js';

const LIFECYCLE_THROTTLE_MS = 180;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const toStringOrUndefined = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;

export type LifecycleOptions = {
    state: RouterState;
    sendAction: (action: Action) => Promise<Action>;
    onRefresh: () => void;
};

export type BoundTabToken = {
    tabId: number;
    windowId: number;
    tabToken: string;
    workspaceId: string;
    agentTabId: string;
    urlHint: string;
    pending?: boolean;
};

export type LifecycleRuntime = {
    ensureTabToken: (tabId: number, hintedWindowId?: number) => Promise<TabRuntimeState | null>;
    ensureBoundTabToken: (tabId: number, hintedWindowId?: number, preferredTabToken?: string) => Promise<BoundTabToken | null>;
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
    const inflightBoundByTab = new Map<number, Promise<BoundTabToken | null>>();

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
                const data = result.data;
                if (data.ok && data.tabToken) {return data;}
            } else if (result.error.code === 'NO_RECEIVER') {
                return { ok: false, error: result.error.message } as const;
            }
            if (attempt < 2) {await wait(150);}
        }
        return { ok: false, error: 'tab token request timeout' } as const;
    };

    const pushTokenToTab = async (tabId: number, tabToken: string) => {
        const result = await send.toTabTransport<{ ok: boolean }>(
            tabId,
            MSG.SET_TOKEN,
            { tabToken },
            { timeoutMs: 1200 },
        );
        return result.ok && result.data?.ok === true;
    };

    const resolveWorkspaceId = async (tabToken: string, windowId: number) => {
        const scope = options.state.getTokenScope(tabToken);
        if (scope?.workspaceId) {return scope.workspaceId;}
        const fromWindow = options.state.getWindowWorkspace(windowId);
        if (fromWindow) {return fromWindow;}
        const active = options.state.getActiveWorkspaceId();
        if (active) {return active;}

        const reply = await options.sendAction({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.WORKSPACE_LIST,
            payload: {},
            scope: {},
        });
        if (isFailedReply(reply)) {
            const error = payloadOf(reply);
            const code = typeof error.code === 'string' ? error.code : 'ERR';
            const message = typeof error.message === 'string' ? error.message : 'unknown';
            throw new Error(`workspace.list failed: ${code}:${message}`);
        }
        const payload = payloadOf(reply);
        const remoteActive = toStringOrUndefined(payload.activeWorkspaceId);
        if (!remoteActive) {
            throw new Error(`workspace mapping missing for tabToken=${tabToken}`);
        }
        options.state.setActiveWorkspaceId(remoteActive);
        options.state.setWindowWorkspace(windowId, remoteActive);
        return remoteActive;
    };

    const ensureBoundTabTokenInternal = async (
        tabId: number,
        hintedWindowId?: number,
        preferredTabToken?: string,
    ): Promise<BoundTabToken | null> => {
        let windowId = typeof hintedWindowId === 'number' ? hintedWindowId : null;
        let tab = null as chrome.tabs.Tab | null;
        if (windowId === null) {
            tab = await chrome.tabs.get(tabId);
            windowId = typeof tab.windowId === 'number' ? tab.windowId : null;
        }
        if (windowId === null) {return null;}

        const existing = options.state.getTabState(tabId);
        let tabToken = existing?.tabToken ?? '';
        let urlHint = existing?.lastUrl ?? '';

        if (preferredTabToken && !tabToken) {
            tabToken = preferredTabToken;
        }

        if (!tabToken) {
            const fromPage = await requestTokenFromTab(tabId);
            if (fromPage.ok && fromPage.tabToken) {
                tabToken = fromPage.tabToken;
                urlHint = fromPage.url ?? '';
            }
        }

        let generatedToken = false;
        if (!tabToken) {
            const init = await options.sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_INIT,
                payload: {
                    source: 'extension.sw',
                    url: tab?.url ?? '',
                    at: Date.now(),
                },
                scope: {},
            });
            if (isFailedReply(init)) {
                const error = payloadOf(init);
                const code = typeof error.code === 'string' ? error.code : 'ERR';
                const message = typeof error.message === 'string' ? error.message : 'unknown';
                throw new Error(`tab.init failed: ${code}:${message}`);
            }
            const initPayload = payloadOf(init);
            const createdToken = toStringOrUndefined(initPayload.tabToken);
            if (!createdToken) {
                throw new Error('tab.init returned empty tabToken');
            }
            tabToken = createdToken;
            generatedToken = true;
            await pushTokenToTab(tabId, tabToken).catch(() => false);
        }

        if (!urlHint) {
            if (!tab) {tab = await chrome.tabs.get(tabId);}
            urlHint = tab?.url ?? '';
        }

        options.state.upsertTab(tabId, tabToken, urlHint, windowId);

        let tokenScope = options.state.getTokenScope(tabToken);
        if (!tokenScope) {
            const workspaceId = await resolveWorkspaceId(tabToken, windowId);
            options.state.setWindowWorkspace(windowId, workspaceId);
            if (!tab) {tab = await chrome.tabs.get(tabId);}
            const opened = await options.sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_OPENED,
                tabToken,
                scope: { tabToken, workspaceId },
                payload: {
                    source: 'extension.sw',
                    url: urlHint,
                    title: tab?.title,
                    at: Date.now(),
                    windowId,
                    workspaceId,
                },
            });
            if (isFailedReply(opened)) {
                const error = payloadOf(opened);
                const code = typeof error.code === 'string' ? error.code : 'ERR';
                const message = typeof error.message === 'string' ? error.message : 'unknown';
                throw new Error(`tab.opened failed: ${code}:${message}`);
            }
            const openedPayload = payloadOf(opened);
            const resolvedWorkspaceId = toStringOrUndefined(openedPayload.workspaceId) ?? workspaceId;
            const resolvedAgentTabId = toStringOrUndefined(openedPayload.tabId) ?? '';
            if (!resolvedAgentTabId) {
                if (generatedToken) {
                    return {
                        tabId,
                        windowId,
                        tabToken,
                        workspaceId: resolvedWorkspaceId,
                        agentTabId: '',
                        urlHint,
                        pending: true,
                    };
                }
                throw new Error(`tab.opened missing tabId (tabId=${String(tabId)}, windowId=${String(windowId)})`);
            }
            options.state.upsertTokenScope(tabToken, resolvedWorkspaceId, resolvedAgentTabId);
            options.state.setWindowWorkspace(windowId, resolvedWorkspaceId);
            tokenScope = { workspaceId: resolvedWorkspaceId, tabId: resolvedAgentTabId };
        }

        return {
            tabId,
            windowId,
            tabToken,
            workspaceId: tokenScope.workspaceId,
            agentTabId: tokenScope.tabId,
            urlHint,
        };
    };

    const ensureBoundTabToken = async (
        tabId: number,
        hintedWindowId?: number,
        preferredTabToken?: string,
    ): Promise<BoundTabToken | null> => {
        const existing = inflightBoundByTab.get(tabId);
        if (existing) {return await existing;}
        const inflight = ensureBoundTabTokenInternal(tabId, hintedWindowId, preferredTabToken)
            .finally(() => {
                inflightBoundByTab.delete(tabId);
            });
        inflightBoundByTab.set(tabId, inflight);
        return await inflight;
    };

    const ensureTabToken = async (tabId: number, hintedWindowId?: number) => {
        const bound = await ensureBoundTabToken(tabId, hintedWindowId);
        if (!bound || bound.pending) {return null;}
        options.state.upsertTab(tabId, bound.tabToken, bound.urlHint, bound.windowId);
        return options.state.getTabState(tabId) ?? null;
    };

    const getActiveTabTokenForWindow = async (windowId: number) => {
        const tabs = await chrome.tabs.query({ active: true, windowId });
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') {return null;}
        const bound = await ensureBoundTabToken(tabId, windowId);
        if (!bound?.tabToken) {return null;}
        return { tabId, tabToken: bound.tabToken, urlHint: bound.urlHint, windowId };
    };

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
        const previousActiveTabId = options.state.getActiveTabId();
        const previousActiveWindowId = options.state.getActiveWindowId();
        options.state.setActiveTabId(info.tabId);
        options.state.setActiveWindowId(info.windowId);

        void (async () => {
            const bound = await ensureBoundTabToken(info.tabId, info.windowId);
            if (!bound?.tabToken || bound.pending) {return;}
            options.state.setActiveWorkspaceId(bound.workspaceId);
            options.state.setWindowWorkspace(info.windowId, bound.workspaceId);
            const now = Date.now();
            const key = `${String(info.windowId)}:${String(info.tabId)}:${bound.tabToken}`;
            if (options.state.shouldThrottleTabActivated(key, now, LIFECYCLE_THROTTLE_MS)) {return;}
            await emitLifecycleAction(
                ACTION_TYPES.TAB_ACTIVATED,
                { source: 'extension.sw', url: bound.urlHint || '', at: now, windowId: info.windowId },
                bound.tabToken,
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
            changeInfo.url ?? existing.lastUrl,
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
            const bound = await ensureBoundTabToken(tabId, windowId);
            if (!bound || bound.pending) {return;}
            options.onRefresh();
        })();
    };

    const onAttached = (tabId: number, info: chrome.tabs.TabAttachInfo) => {
        void (async () => {
            const bound = await ensureBoundTabToken(tabId, info.newWindowId);
            if (!bound?.tabToken || bound.pending) {return;}
            const scope = options.state.getTokenScope(bound.tabToken);
            const targetWorkspaceId = options.state.getWindowWorkspace(info.newWindowId);
            if (!scope || !targetWorkspaceId || scope.workspaceId === targetWorkspaceId) {
                if (scope) {options.state.setWindowWorkspace(info.newWindowId, scope.workspaceId);}
                return;
            }
            const result = await options.sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_REASSIGN,
                scope: { tabToken: bound.tabToken },
                payload: {
                    workspaceId: targetWorkspaceId,
                    source: 'extension.sw',
                    windowId: info.newWindowId,
                    at: Date.now(),
                },
            });
            if (!isFailedReply(result)) {
                const resultPayload = payloadOf(result);
                const workspaceId = toStringOrUndefined(resultPayload.workspaceId) ?? targetWorkspaceId;
                const targetTabId = toStringOrUndefined(resultPayload.tabId) ?? scope.tabId;
                options.state.upsertTokenScope(bound.tabToken, workspaceId, targetTabId);
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
            const key = `${String(windowId)}:${scope.workspaceId}`;
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
        ensureBoundTabToken,
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
