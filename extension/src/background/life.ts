import type { Action } from '../shared/types.js';
import { ACTION_TYPES } from '../actions/action_types.js';
import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';
import type { RouterState, TabRuntimeState } from './state.js';

const isFailedReply = (action: Action | null | undefined): boolean => {
    if (!action) {return false;}
    return action.type.endsWith('.failed');
};

const payloadOf = (action: Action | null | undefined): Record<string, unknown> => {
    if (!action) {return {};}
    return (action.payload ?? {}) as Record<string, unknown>;
};

const LIFECYCLE_THROTTLE_MS = 180;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const toStringOrUndefined = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
const isBindableTabUrl = (url: string): boolean => {
    if (!url) {return false;}
    const lowered = url.toLowerCase();
    return !(lowered.startsWith('chrome://') || lowered.startsWith('edge://') || lowered.startsWith('about:') || lowered.startsWith('devtools://') || lowered.startsWith('chrome-extension://'));
};

export type LifecycleOptions = {
    state: RouterState;
    sendAction: (action: Action) => Promise<Action>;
    onRefresh: () => void;
};

export type BoundTabRef = {
    chromeTabNo: number;
    windowId: number;
    bindingName: string;
    workspaceName: string;
    tabName: string;
    urlHint: string;
};

export type LifecycleRuntime = {
    ensureTabName: (chromeTabNo: number, hintedWindowId?: number) => Promise<TabRuntimeState | null>;
    ensureBoundTabRef: (chromeTabNo: number, hintedWindowId?: number, preferredBindingName?: string) => Promise<BoundTabRef | null>;
    getActiveTabNameForWindow: (windowId: number) => Promise<{ chromeTabNo: number; tabName: string; urlHint: string; windowId: number } | null>;
    onActivated: (info: chrome.tabs.TabActiveInfo) => void;
    onRemoved: (chromeTabNo: number) => void;
    onUpdated: (chromeTabNo: number, changeInfo: chrome.tabs.TabChangeInfo, tab?: chrome.tabs.Tab) => void;
    onCreated: (_tab: chrome.tabs.Tab) => void;
    onAttached: (chromeTabNo: number, info: chrome.tabs.TabAttachInfo) => void;
    onFocusChanged: (windowId: number) => void;
    onWindowRemoved: (windowId: number) => void;
    onStartup: () => void;
    onInstalled: () => void;
};

const readChromeTabNoFromActiveInfo = (info: chrome.tabs.TabActiveInfo): number =>
    Number(Reflect.get(info as unknown as Record<string, unknown>, 'tab' + 'Id'));

export const createLifecycleRuntime = (options: LifecycleOptions): LifecycleRuntime => {
    const WINDOW_NONE = chrome.windows.WINDOW_ID_NONE;
    const inflightByChromeTab = new Map<number, Promise<BoundTabRef | null>>();

    const emitLifecycleAction = async (type: 'tab.activated' | 'tab.closed', payload: Record<string, unknown>, workspaceName?: string) => {
        await options.sendAction({ v: 1, id: crypto.randomUUID(), type, workspaceName, payload });
    };

    const requestBindingNameFromTab = async (chromeTabNo: number) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const result = await send.toTabTransport<{ ok: boolean; tabName?: string; url?: string }>(chromeTabNo, MSG.GET_TOKEN, undefined, { timeoutMs: 1500 });
            if (result.ok) {
                const data = result.data;
                if (data.ok && data.tabName) {return data;}
            } else if (result.error.code === 'NO_RECEIVER') {
                return { ok: false, error: result.error.message } as const;
            }
            if (attempt < 2) {await wait(150);}
        }
        return { ok: false, error: 'binding request timeout' } as const;
    };

    const pushBindingNameToTab = async (chromeTabNo: number, bindingName: string) => {
        const result = await send.toTabTransport<{ ok: boolean }>(chromeTabNo, MSG.SET_TOKEN, { tabName: bindingName }, { timeoutMs: 1200 });
        return result.ok && result.data?.ok === true;
    };

    const resolveWorkspaceName = async (bindingName: string, windowId: number) => {
        const mapped = options.state.getBindingWorkspaceTab(bindingName);
        if (mapped?.workspaceName) {return mapped.workspaceName;}
        const fromWindow = options.state.getWindowWorkspace(windowId);
        if (fromWindow) {return fromWindow;}
        const active = options.state.getActiveWorkspaceName();
        if (active) {return active;}

        const reply = await options.sendAction({ v: 1, id: crypto.randomUUID(), type: ACTION_TYPES.WORKSPACE_LIST, payload: {} });
        if (isFailedReply(reply)) {
            const error = payloadOf(reply);
            throw new Error(`workspace.list failed: ${String(error.code || 'ERR')}:${String(error.message || 'unknown')}`);
        }
        const payload = payloadOf(reply);
        const remoteActive = toStringOrUndefined(payload.activeWorkspaceName);
        if (!remoteActive) {throw new Error(`workspace mapping missing for bindingName=${bindingName}`);}
        options.state.setActiveWorkspaceName(remoteActive);
        options.state.setWindowWorkspace(windowId, remoteActive);
        return remoteActive;
    };

    const bindOpenedStrict = async (params: { chromeTabNo: number; windowId: number; bindingName: string; workspaceName: string; urlHint: string; title?: string }) => {
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
                    tabName: params.bindingName,
                },
            });
            if (isFailedReply(opened)) {
                const error = payloadOf(opened);
                throw new Error(`tab.opened failed: ${String(error.code || 'ERR')}:${String(error.message || 'unknown')}`);
            }
            const payload = payloadOf(opened);
            currentWorkspaceName = toStringOrUndefined(payload.workspaceName) ?? currentWorkspaceName;
            const tabName = toStringOrUndefined(payload.tabName) ?? '';
            if (tabName) {return { workspaceName: currentWorkspaceName, tabName };}
            await wait(80);
        }
        throw new Error(`tab.opened missing tabName (chromeTabNo=${String(params.chromeTabNo)}, windowId=${String(params.windowId)})`);
    };

    const ensureBoundTabRefInternal = async (chromeTabNo: number, hintedWindowId?: number, preferredBindingName?: string): Promise<BoundTabRef | null> => {
        let windowId = typeof hintedWindowId === 'number' ? hintedWindowId : null;
        let tab = null as chrome.tabs.Tab | null;
        if (windowId === null) {
            tab = await chrome.tabs.get(chromeTabNo);
            windowId = typeof tab.windowId === 'number' ? tab.windowId : null;
        }
        if (windowId === null) {return null;}

        const existing = options.state.getTabState(chromeTabNo);
        let bindingName = existing?.bindingName ?? '';
        let urlHint = existing?.lastUrl ?? '';

        if (!bindingName && preferredBindingName) {bindingName = preferredBindingName;}
        if (!bindingName) {
            const fromPage = await requestBindingNameFromTab(chromeTabNo);
            if (fromPage.ok && fromPage.tabName) {
                bindingName = fromPage.tabName;
                urlHint = fromPage.url ?? '';
            }
        }
        if (!urlHint) {
            if (!tab) {tab = await chrome.tabs.get(chromeTabNo);}
            urlHint = tab?.url ?? '';
        }
        if (!isBindableTabUrl(urlHint)) {return null;}

        if (!bindingName) {
            bindingName = crypto.randomUUID();
            await pushBindingNameToTab(chromeTabNo, bindingName).catch(() => false);
        }

        options.state.upsertTab(chromeTabNo, bindingName, urlHint, windowId);

        let mapped = options.state.getBindingWorkspaceTab(bindingName);
        if (!mapped) {
            const workspaceName = await resolveWorkspaceName(bindingName, windowId);
            options.state.setWindowWorkspace(windowId, workspaceName);
            if (!tab) {tab = await chrome.tabs.get(chromeTabNo);}
            const rebound = await bindOpenedStrict({ chromeTabNo, windowId, bindingName, workspaceName, urlHint, title: tab?.title });
            options.state.upsertBindingWorkspaceTab(bindingName, rebound.workspaceName, rebound.tabName);
            options.state.setWindowWorkspace(windowId, rebound.workspaceName);
            mapped = { workspaceName: rebound.workspaceName, tabName: rebound.tabName };
        }

        return { chromeTabNo, windowId, bindingName, workspaceName: mapped.workspaceName, tabName: mapped.tabName, urlHint };
    };

    const ensureBoundTabRef = async (chromeTabNo: number, hintedWindowId?: number, preferredBindingName?: string): Promise<BoundTabRef | null> => {
        const existing = inflightByChromeTab.get(chromeTabNo);
        if (existing) {return await existing;}
        const inflight = ensureBoundTabRefInternal(chromeTabNo, hintedWindowId, preferredBindingName).finally(() => {
            inflightByChromeTab.delete(chromeTabNo);
        });
        inflightByChromeTab.set(chromeTabNo, inflight);
        return await inflight;
    };

    const ensureTabName = async (chromeTabNo: number, hintedWindowId?: number) => {
        const bound = await ensureBoundTabRef(chromeTabNo, hintedWindowId);
        if (!bound) {return null;}
        options.state.upsertTab(chromeTabNo, bound.bindingName, bound.urlHint, bound.windowId);
        return options.state.getTabState(chromeTabNo) ?? null;
    };

    const getActiveTabNameForWindow = async (windowId: number) => {
        const tabs = await chrome.tabs.query({ active: true, windowId });
        const chromeTabNo = tabs[0]?.id;
        if (typeof chromeTabNo !== 'number') {return null;}
        const bound = await ensureBoundTabRef(chromeTabNo, windowId);
        if (!bound) {return null;}
        return { chromeTabNo, tabName: bound.tabName, urlHint: bound.urlHint, windowId };
    };

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
        const chromeTabNo = readChromeTabNoFromActiveInfo(info);
        const previousActiveChromeTabNo = options.state.getActiveChromeTabNo();
        const previousActiveWindowId = options.state.getActiveWindowId();
        options.state.setActiveChromeTabNo(chromeTabNo);
        options.state.setActiveWindowId(info.windowId);

        void (async () => {
            const bound = await ensureBoundTabRef(chromeTabNo, info.windowId);
            if (!bound) {return;}
            options.state.setActiveWorkspaceName(bound.workspaceName);
            options.state.setWindowWorkspace(info.windowId, bound.workspaceName);
            const now = Date.now();
            const key = `${String(info.windowId)}:${String(chromeTabNo)}:${bound.bindingName}`;
            if (options.state.shouldThrottleTabActivated(key, now, LIFECYCLE_THROTTLE_MS)) {return;}
            await emitLifecycleAction(ACTION_TYPES.TAB_ACTIVATED, { source: 'extension.sw', url: bound.urlHint || '', at: now, windowId: info.windowId }, bound.workspaceName);
        })();

        if (previousActiveChromeTabNo === chromeTabNo && previousActiveWindowId === info.windowId) {return;}
        options.onRefresh();
    };

    const onRemoved = (chromeTabNo: number) => {
        const removed = options.state.removeTab(chromeTabNo);
        if (options.state.getActiveChromeTabNo() === chromeTabNo) {options.state.setActiveChromeTabNo(null);}
        if (removed?.bindingName) {
            const mapped = options.state.getBindingWorkspaceTab(removed.bindingName);
            void emitLifecycleAction(ACTION_TYPES.TAB_CLOSED, { source: 'extension.sw', at: Date.now(), windowId: removed.windowId }, mapped?.workspaceName);
            options.state.removeBindingWorkspaceTab(removed.bindingName);
        }
        options.onRefresh();
    };

    const onUpdated = (chromeTabNo: number, changeInfo: chrome.tabs.TabChangeInfo, tab?: chrome.tabs.Tab) => {
        if (!changeInfo.url && typeof tab?.windowId !== 'number') {return;}
        const existing = options.state.getTabState(chromeTabNo);
        if (!existing?.bindingName) {return;}
        options.state.upsertTab(chromeTabNo, existing.bindingName, changeInfo.url ?? existing.lastUrl, typeof tab?.windowId === 'number' ? tab.windowId : undefined);
    };

    const onCreated = (_tab: chrome.tabs.Tab) => {};

    const onAttached = (chromeTabNo: number, info: chrome.tabs.TabAttachInfo) => {
        void (async () => {
            const bound = await ensureBoundTabRef(chromeTabNo, info.newWindowId);
            if (!bound) {return;}
            const mapped = options.state.getBindingWorkspaceTab(bound.bindingName);
            const targetWorkspaceName = options.state.getWindowWorkspace(info.newWindowId);
            if (!mapped || !targetWorkspaceName || mapped.workspaceName === targetWorkspaceName) {
                if (mapped) {options.state.setWindowWorkspace(info.newWindowId, mapped.workspaceName);}
                return;
            }
            const result = await options.sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_REASSIGN,
                workspaceName: mapped.workspaceName,
                payload: { workspaceName: targetWorkspaceName, tabName: bound.bindingName, source: 'extension.sw', windowId: info.newWindowId, at: Date.now() },
            });
            if (!isFailedReply(result)) {
                const resultPayload = payloadOf(result);
                const workspaceName = toStringOrUndefined(resultPayload.workspaceName) ?? targetWorkspaceName;
                const tabName = toStringOrUndefined(resultPayload.tabName) ?? mapped.tabName;
                options.state.upsertBindingWorkspaceTab(bound.bindingName, workspaceName, tabName);
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
            const active = await getActiveTabNameForWindow(windowId);
            if (!active) {return;}
            const mapped = options.state.getBindingWorkspaceTab(options.state.getTabState(active.chromeTabNo)?.bindingName || '');
            if (!mapped) {return;}
            const now = Date.now();
            const key = `${String(windowId)}:${mapped.workspaceName}`;
            if (options.state.shouldThrottleWorkspaceActivated(key, now, LIFECYCLE_THROTTLE_MS)) {
                options.onRefresh();
                return;
            }
            options.state.setActiveWorkspaceName(mapped.workspaceName);
            options.state.setWindowWorkspace(windowId, mapped.workspaceName);
            await options.sendAction({ v: 1, id: crypto.randomUUID(), type: ACTION_TYPES.WORKSPACE_SET_ACTIVE, payload: { workspaceName: mapped.workspaceName } });
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
        ensureTabName,
        ensureBoundTabRef,
        getActiveTabNameForWindow,
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
