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
const isBindableTabUrl = (url: string): boolean => {
    if (!url) {return false;}
    const lowered = url.toLowerCase();
    if (lowered.startsWith('chrome://')) {return false;}
    if (lowered.startsWith('edge://')) {return false;}
    if (lowered.startsWith('about:')) {return false;}
    if (lowered.startsWith('devtools://')) {return false;}
    if (lowered.startsWith('chrome-extension://')) {return false;}
    return true;
};

export type LifecycleOptions = {
    state: RouterState;
    sendAction: (action: Action) => Promise<Action>;
    onRefresh: () => void;
};

export type BoundTabToken = {
    tabId: number;
    windowId: number;
    tabName: string;
    workspaceName: string;
    agentTabName: string;
    urlHint: string;
};

export type LifecycleRuntime = {
    ensureTabToken: (tabId: number, hintedWindowId?: number) => Promise<TabRuntimeState | null>;
    ensureBoundTabToken: (tabId: number, hintedWindowId?: number, preferredTabToken?: string) => Promise<BoundTabToken | null>;
    getActiveTabTokenForWindow: (windowId: number) => Promise<{ tabId: number; tabName: string; urlHint: string; windowId: number } | null>;
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
        workspaceName?: string,
    ) => {
        await options.sendAction({
            v: 1,
            id: crypto.randomUUID(),
            type,
            workspaceName,
            payload,
        });
    };

    const requestTokenFromTab = async (tabId: number) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const result = await send.toTabTransport<{ ok: boolean; tabName?: string; url?: string }>(
                tabId,
                MSG.GET_TOKEN,
                undefined,
                { timeoutMs: 1500 },
            );
            if (result.ok) {
                const data = result.data;
                if (data.ok && data.tabName) {return data;}
            } else if (result.error.code === 'NO_RECEIVER') {
                return { ok: false, error: result.error.message } as const;
            }
            if (attempt < 2) {await wait(150);}
        }
        return { ok: false, error: 'tab token request timeout' } as const;
    };

    const pushTokenToTab = async (tabId: number, tabName: string) => {
        const result = await send.toTabTransport<{ ok: boolean }>(tabId, MSG.SET_TOKEN, { tabName }, { timeoutMs: 1200 });
        return result.ok && result.data?.ok === true;
    };

    const resolveWorkspaceName = async (tabName: string, windowId: number) => {
        const scope = options.state.getTokenScope(tabName);
        if (scope?.workspaceName) {return scope.workspaceName;}
        const fromWindow = options.state.getWindowWorkspace(windowId);
        if (fromWindow) {return fromWindow;}
        const active = options.state.getActiveWorkspaceName();
        if (active) {return active;}

        const reply = await options.sendAction({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.WORKSPACE_LIST,
            payload: {},
        });
        if (isFailedReply(reply)) {
            const error = payloadOf(reply);
            const code = typeof error.code === 'string' ? error.code : 'ERR';
            const message = typeof error.message === 'string' ? error.message : 'unknown';
            throw new Error(`workspace.list failed: ${code}:${message}`);
        }
        const payload = payloadOf(reply);
        const remoteActive = toStringOrUndefined(payload.activeWorkspaceName);
        if (!remoteActive) {
            throw new Error(`workspace mapping missing for tabName=${tabName}`);
        }
        options.state.setActiveWorkspaceName(remoteActive);
        options.state.setWindowWorkspace(windowId, remoteActive);
        return remoteActive;
    };

    const bindOpenedStrict = async (params: {
        tabId: number;
        windowId: number;
        tabName: string;
        workspaceName: string;
        urlHint: string;
        title?: string;
    }) => {
        let currentWorkspaceName = params.workspaceName;
        for (let i = 0; i < 6; i += 1) {
            const opened = await options.sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_OPENED,
                workspaceName: currentWorkspaceName,
                payload: {
                    source: 'extension.sw',
                    url: params.urlHint,
                    title: params.title,
                    at: Date.now(),
                    windowId: params.windowId,
                    tabName: params.tabName,
                },
            });
            if (isFailedReply(opened)) {
                const error = payloadOf(opened);
                const code = typeof error.code === 'string' ? error.code : 'ERR';
                const message = typeof error.message === 'string' ? error.message : 'unknown';
                throw new Error(`tab.opened failed: ${code}:${message}`);
            }
            const payload = payloadOf(opened);
            currentWorkspaceName = toStringOrUndefined(payload.workspaceName) ?? currentWorkspaceName;
            const agentTabName = toStringOrUndefined(payload.tabName) ?? '';
            if (agentTabName) {
                return { workspaceName: currentWorkspaceName, tabId: agentTabName };
            }
            await wait(80);
        }
        throw new Error(`tab.opened missing tabId (tabId=${String(params.tabId)}, windowId=${String(params.windowId)})`);
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
        let tabName = existing?.tabName ?? '';
        let urlHint = existing?.lastUrl ?? '';

        if (!tabName && preferredTabToken) {
            tabName = preferredTabToken;
        }

        if (!tabName) {
            const fromPage = await requestTokenFromTab(tabId);
            if (fromPage.ok && fromPage.tabName) {
                tabName = fromPage.tabName;
                urlHint = fromPage.url ?? '';
            }
        }

        if (!urlHint) {
            if (!tab) {tab = await chrome.tabs.get(tabId);}
            urlHint = tab?.url ?? '';
        }

        if (!isBindableTabUrl(urlHint)) {
            return null;
        }

        if (!tabName) {
            const init = await options.sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_INIT,
                payload: { source: 'extension.sw', url: urlHint, at: Date.now() },
            });
            if (isFailedReply(init)) {
                const error = payloadOf(init);
                const code = typeof error.code === 'string' ? error.code : 'ERR';
                const message = typeof error.message === 'string' ? error.message : 'unknown';
                throw new Error(`tab.init failed: ${code}:${message}`);
            }
            const initPayload = payloadOf(init);
            const createdToken = toStringOrUndefined(initPayload.tabName);
            if (!createdToken) {
                throw new Error('tab.init returned empty tabName');
            }
            tabName = createdToken;
            await pushTokenToTab(tabId, tabName).catch(() => false);
        }

        options.state.upsertTab(tabId, tabName, urlHint, windowId);

        let scope = options.state.getTokenScope(tabName);
        if (!scope) {
            const workspaceName = await resolveWorkspaceName(tabName, windowId);
            options.state.setWindowWorkspace(windowId, workspaceName);
            if (!tab) {tab = await chrome.tabs.get(tabId);}
            const rebound = await bindOpenedStrict({
                tabId,
                windowId,
                tabName,
                workspaceName,
                urlHint,
                title: tab?.title,
            });
            options.state.upsertTokenScope(tabName, rebound.workspaceName, rebound.tabId);
            options.state.setWindowWorkspace(windowId, rebound.workspaceName);
            scope = { workspaceName: rebound.workspaceName, tabId: rebound.tabId };
        }

        return {
            tabId,
            windowId,
            tabName,
            workspaceName: scope.workspaceName,
            agentTabName: scope.tabId,
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
        const inflight = ensureBoundTabTokenInternal(tabId, hintedWindowId, preferredTabToken).finally(() => {
            inflightBoundByTab.delete(tabId);
        });
        inflightBoundByTab.set(tabId, inflight);
        return await inflight;
    };

    const ensureTabToken = async (tabId: number, hintedWindowId?: number) => {
        const bound = await ensureBoundTabToken(tabId, hintedWindowId);
        if (!bound) {return null;}
        options.state.upsertTab(tabId, bound.tabName, bound.urlHint, bound.windowId);
        return options.state.getTabState(tabId) ?? null;
    };

    const getActiveTabTokenForWindow = async (windowId: number) => {
        const tabs = await chrome.tabs.query({ active: true, windowId });
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') {return null;}
        const bound = await ensureBoundTabToken(tabId, windowId);
        if (!bound?.tabName) {return null;}
        return { tabId, tabName: bound.tabName, urlHint: bound.urlHint, windowId };
    };

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
        const previousActiveTabName = options.state.getActiveTabName();
        const previousActiveWindowId = options.state.getActiveWindowId();
        options.state.setActiveTabName(info.tabId);
        options.state.setActiveWindowId(info.windowId);

        void (async () => {
            const bound = await ensureBoundTabToken(info.tabId, info.windowId);
            if (!bound?.tabName) {return;}
            options.state.setActiveWorkspaceName(bound.workspaceName);
            options.state.setWindowWorkspace(info.windowId, bound.workspaceName);
            const now = Date.now();
            const key = `${String(info.windowId)}:${String(info.tabId)}:${bound.tabName}`;
            if (options.state.shouldThrottleTabActivated(key, now, LIFECYCLE_THROTTLE_MS)) {return;}
            await emitLifecycleAction(
                ACTION_TYPES.TAB_ACTIVATED,
                { source: 'extension.sw', url: bound.urlHint || '', at: now, windowId: info.windowId },
                bound.workspaceName,
            );
        })();

        if (previousActiveTabName === info.tabId && previousActiveWindowId === info.windowId) {return;}
        options.onRefresh();
    };

    const onRemoved = (tabId: number) => {
        const removed = options.state.removeTab(tabId);
        if (options.state.getActiveTabName() === tabId) {options.state.setActiveTabName(null);}
        if (removed?.tabName) {
            const removedScope = options.state.getTokenScope(removed.tabName);
            void emitLifecycleAction(
                ACTION_TYPES.TAB_CLOSED,
                { source: 'extension.sw', at: Date.now(), windowId: removed.windowId },
                removedScope?.workspaceName,
            );
            options.state.removeTokenScope(removed.tabName);
        }
        options.onRefresh();
    };

    const onUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab?: chrome.tabs.Tab) => {
        if (!changeInfo.url && typeof tab?.windowId !== 'number') {return;}
        const existing = options.state.getTabState(tabId);
        if (!existing?.tabName) {return;}
        options.state.upsertTab(tabId, existing.tabName, changeInfo.url ?? existing.lastUrl, typeof tab?.windowId === 'number' ? tab.windowId : undefined);
    };

    const onCreated = (_tab: chrome.tabs.Tab) => {
        // no-op: creation phase does not emit lifecycle actions.
    };

    const onAttached = (tabId: number, info: chrome.tabs.TabAttachInfo) => {
        void (async () => {
            const bound = await ensureBoundTabToken(tabId, info.newWindowId);
            if (!bound?.tabName) {return;}
            const scope = options.state.getTokenScope(bound.tabName);
            const targetWorkspaceName = options.state.getWindowWorkspace(info.newWindowId);
            if (!scope || !targetWorkspaceName || scope.workspaceName === targetWorkspaceName) {
                if (scope) {options.state.setWindowWorkspace(info.newWindowId, scope.workspaceName);}
                return;
            }
            const result = await options.sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_REASSIGN,
                workspaceName: scope.workspaceName,
                payload: { workspaceName: targetWorkspaceName, tabName: bound.tabName, source: 'extension.sw', windowId: info.newWindowId, at: Date.now() },
            });
            if (!isFailedReply(result)) {
                const resultPayload = payloadOf(result);
                const workspaceName = toStringOrUndefined(resultPayload.workspaceName) ?? targetWorkspaceName;
                const targetTabName = toStringOrUndefined(resultPayload.tabName) ?? scope.tabId;
                options.state.upsertTokenScope(bound.tabName, workspaceName, targetTabName);
                options.state.setWindowWorkspace(info.newWindowId, workspaceName);
                if (options.state.getActiveWindowId() === info.newWindowId) {
                    options.state.setActiveWorkspaceName(workspaceName);
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
            const scope = options.state.getTokenScope(active.tabName);
            if (!scope) {return;}
            const now = Date.now();
            const key = `${String(windowId)}:${scope.workspaceName}`;
            if (options.state.shouldThrottleWorkspaceActivated(key, now, LIFECYCLE_THROTTLE_MS)) {
                options.onRefresh();
                return;
            }
            options.state.setActiveWorkspaceName(scope.workspaceName);
            options.state.setWindowWorkspace(windowId, scope.workspaceName);
            await options.sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.WORKSPACE_SET_ACTIVE,
                workspaceName: scope.workspaceName,
                payload: {},
            });
            options.onRefresh();
        })();
    };

    const onWindowRemoved = (windowId: number) => {
        const workspaceName = options.state.getWindowWorkspace(windowId);
        options.state.clearWindowWorkspace(windowId);
        if (workspaceName && options.state.getActiveWorkspaceName() === workspaceName) {
            options.state.setActiveWorkspaceName(null);
        }
        options.onRefresh();
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
        onStartup: () => { options.state.resetStartupState(); },
        onInstalled: () => { options.state.resetInstalledState(); },
    };
};
