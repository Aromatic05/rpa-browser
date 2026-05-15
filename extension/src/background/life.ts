import type { Action } from '../shared/types.js';
import { ACTION_TYPES } from '../actions/action_types.js';
import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';
import type { RouterState, TabRuntimeState } from './state.js';

const LIFECYCLE_THROTTLE_MS = 180;

export type LifecycleOptions = {
    state: RouterState;
    sendAction: (action: Action) => Promise<Action>;
    sessionWorkspaceName: string;
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
    handleBindCommand: (action: Action) => Promise<void>;
    ensureOpenedAndBound: (
        chromeTabNo: number,
        windowId: number,
        options?: { createId?: string },
    ) => Promise<BoundTabRef | null>;
    getOpenedAndBoundInflight: (chromeTabNo: number) => Promise<BoundTabRef | null> | null;
    bindExistingTabs: () => Promise<void>;
};

const readChromeTabNoFromActiveInfo = (info: chrome.tabs.TabActiveInfo): number =>
    Number(Reflect.get(info as unknown as Record<string, unknown>, 'tab' + 'Id'));

export const createLifecycleRuntime = (options: LifecycleOptions): LifecycleRuntime => {
    const WINDOW_NONE = chrome.windows.WINDOW_ID_NONE;
    const inflightByChromeTab = new Map<number, Promise<BoundTabRef | null>>();
    const isBindingNameOwnedByAnotherTab = (chromeTabNo: number, bindingName: string) => {
        const owner = options.state.findChromeTabNoByBindingName(bindingName);
        return typeof owner === 'number' && owner !== chromeTabNo;
    };

    const emitLifecycleAction = async (type: 'tab.activated' | 'tab.closed', payload: Record<string, unknown>) => {
        await options.sendAction({ v: 1, id: crypto.randomUUID(), type, workspaceName: options.sessionWorkspaceName, payload });
    };

    const emitActivatedIfActive = async (input: {
        chromeTabNo: number;
        windowId: number;
        tabName: string;
        workspaceName: string;
        urlHint: string;
    }) => {
        let activeTab: chrome.tabs.Tab | undefined;
        try {
            const activeTabs = await chrome.tabs.query({ active: true, windowId: input.windowId });
            activeTab = activeTabs[0];
        } catch {
            return;
        }
        if (typeof activeTab?.id !== 'number' || activeTab.id !== input.chromeTabNo) {return;}
        const now = Date.now();
        const key = `${String(input.windowId)}:${String(input.chromeTabNo)}:${input.tabName}`;
        if (options.state.shouldThrottleTabActivated(key, now, LIFECYCLE_THROTTLE_MS)) {return;}
        await emitLifecycleAction(
            ACTION_TYPES.TAB_ACTIVATED,
            {
                source: 'extension.sw',
                tabName: input.tabName,
                tabRef: input.tabName,
                url: input.urlHint || '',
                at: now,
                windowId: input.windowId,
            },
        );
    };


    const pushBindingNameToTab = async (chromeTabNo: number, bindingName: string) => {
        const result = await send.toTabTransport<{ ok: boolean }>(chromeTabNo, MSG.SET_TOKEN, { tabName: bindingName }, { timeoutMs: 1200 });
        return result.ok && result.data?.ok === true;
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

        if (!bindingName && preferredBindingName) {
            const ownedByOther = isBindingNameOwnedByAnotherTab(chromeTabNo, preferredBindingName);
            if (!ownedByOther) {
                bindingName = preferredBindingName;
            }
        }
        if (!urlHint) {
            if (!tab) {tab = await chrome.tabs.get(chromeTabNo);}
            urlHint = tab?.url ?? '';
        }

        if (bindingName) {
            const mapped = options.state.getBindingWorkspaceTab(bindingName);
            if (mapped) {
                return { chromeTabNo, windowId, bindingName, workspaceName: options.sessionWorkspaceName, tabName: mapped.tabName, urlHint };
            }
        }

        // No binding exists — no fallback generation.
        return null;
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
            const now = Date.now();
            const key = `${String(info.windowId)}:${String(chromeTabNo)}:${bound.bindingName}`;
            if (options.state.shouldThrottleTabActivated(key, now, LIFECYCLE_THROTTLE_MS)) {return;}
            await emitLifecycleAction(
                ACTION_TYPES.TAB_ACTIVATED,
                {
                    source: 'extension.sw',
                    tabName: bound.bindingName,
                    tabRef: bound.bindingName,
                    url: bound.urlHint || '',
                    at: now,
                    windowId: info.windowId,
                },
            );
        })();

        if (previousActiveChromeTabNo === chromeTabNo && previousActiveWindowId === info.windowId) {return;}
        options.onRefresh();
    };

    const onRemoved = (chromeTabNo: number) => {
        const removed = options.state.removeTab(chromeTabNo);
        if (options.state.getActiveChromeTabNo() === chromeTabNo) {options.state.setActiveChromeTabNo(null);}
        if (removed?.bindingName) {
            void emitLifecycleAction(
                ACTION_TYPES.TAB_CLOSED,
                {
                    source: 'extension.sw',
                    tabName: removed.bindingName,
                    tabRef: removed.bindingName,
                    at: Date.now(),
                    windowId: removed.windowId,
                },
            );
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

    const onCreated = (tab: chrome.tabs.Tab) => {
        const chromeTabNo = typeof tab.id === 'number' ? tab.id : null;
        const windowId = typeof tab.windowId === 'number' ? tab.windowId : null;
        if (chromeTabNo === null || windowId === null) {return;}

        void (async () => {
            await ensureOpenedAndBound(chromeTabNo, windowId);
            options.onRefresh();
        })();
    };

    const onAttached = (chromeTabNo: number, info: chrome.tabs.TabAttachInfo) => {
        void (async () => {
            await ensureBoundTabRef(chromeTabNo, info.newWindowId);
            options.onRefresh();
        })();
    };

    const onFocusChanged = (windowId: number) => {
        if (windowId === WINDOW_NONE) {return;}
        options.state.setActiveWindowId(windowId);
        void (async () => {
            const active = await getActiveTabNameForWindow(windowId);
            if (!active) {return;}
            const now = Date.now();
            const key = `${String(windowId)}:${options.sessionWorkspaceName}`;
            if (options.state.shouldThrottleWorkspaceActivated(key, now, LIFECYCLE_THROTTLE_MS)) {
                options.onRefresh();
                return;
            }
            options.onRefresh();
        })();
    };

    const onWindowRemoved = (windowId: number) => {
        void windowId;
        options.onRefresh();
    };

    const inflightOpenedAndBound = new Map<number, Promise<BoundTabRef | null>>();

    const ensureOpenedAndBound = async (
        chromeTabNo: number,
        windowId: number,
        openedOptions?: { createId?: string },
    ): Promise<BoundTabRef | null> => {
        const existing = options.state.getTabState(chromeTabNo);
        if (existing?.bindingName) {
            const mapped = options.state.getBindingWorkspaceTab(existing.bindingName);
            if (mapped) {
                return { chromeTabNo, windowId, bindingName: existing.bindingName, workspaceName: options.sessionWorkspaceName, tabName: mapped.tabName, urlHint: existing.lastUrl ?? '' };
            }
        }
        const inflight = inflightOpenedAndBound.get(chromeTabNo);
        if (inflight) { return await inflight; }

        const promise = (async (): Promise<BoundTabRef | null> => {
            let tab: chrome.tabs.Tab;
            try { tab = await chrome.tabs.get(chromeTabNo); } catch { return null; }
            if (typeof tab.windowId !== 'number') { return null; }
            const actualWindowId = tab.windowId;

            const workspaceName = options.sessionWorkspaceName;

            const reply = await options.sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_OPENED,
                workspaceName,
                payload: {
                    source: 'extension.sw',
                    createId: openedOptions?.createId || '',
                    chromeTabNo,
                    windowId: actualWindowId,
                    urlHint: typeof tab.url === 'string' ? tab.url : '',
                    titleHint: typeof tab.title === 'string' ? tab.title : '',
                    openedAt: Date.now(),
                },
            });

            const replyPayload = (reply.payload ?? {}) as Record<string, unknown>;
            const tabName = typeof replyPayload.tabName === 'string' ? replyPayload.tabName.trim() : '';
            if (!tabName) { return null; }

            options.state.upsertBindingWorkspaceTab(tabName, workspaceName, tabName);
            options.state.upsertTab(chromeTabNo, tabName, typeof tab.url === 'string' ? tab.url : '', actualWindowId);

            await options.sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_BOUND,
                workspaceName,
                payload: { tabName, chromeTabNo, windowId: actualWindowId, boundAt: Date.now() },
            });
            await emitActivatedIfActive({
                chromeTabNo,
                windowId: actualWindowId,
                tabName,
                workspaceName,
                urlHint: typeof tab.url === 'string' ? tab.url : '',
            });

            void pushBindingNameToTab(chromeTabNo, tabName);

            return { chromeTabNo, windowId: actualWindowId, bindingName: tabName, workspaceName, tabName, urlHint: typeof tab.url === 'string' ? tab.url : '' };
        })();

        inflightOpenedAndBound.set(chromeTabNo, promise);
        promise.finally(() => { inflightOpenedAndBound.delete(chromeTabNo); });
        return await promise;
    };

    const handleBindCommand = async (action: Action) => {
        const payload = (action.payload ?? {}) as Record<string, unknown>;
        const tabName = typeof payload.tabName === 'string' ? payload.tabName.trim() : '';
        const chromeTabNo = typeof payload.chromeTabNo === 'number' ? payload.chromeTabNo : null;
        const windowId = typeof payload.windowId === 'number' ? payload.windowId : null;
        if (!tabName || chromeTabNo === null || windowId === null) { return; }
        // Skip if already bound (ensureOpenedAndBound won the race)
        if (options.state.getTabState(chromeTabNo)?.bindingName) { return; }

        options.state.upsertBindingWorkspaceTab(tabName, options.sessionWorkspaceName, tabName);
        options.state.upsertTab(chromeTabNo, tabName, '', windowId);

        await options.sendAction({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.TAB_BOUND,
            workspaceName: options.sessionWorkspaceName,
            payload: {
                tabName,
                chromeTabNo,
                windowId,
                boundAt: Date.now(),
            },
        });

        void pushBindingNameToTab(chromeTabNo, tabName);
    };

    const bindExistingTabs = async () => {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (typeof tab.id === 'number' && typeof tab.windowId === 'number') {
                void ensureOpenedAndBound(tab.id, tab.windowId);
            }
        }
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
        handleBindCommand,
        ensureOpenedAndBound,
        getOpenedAndBoundInflight: (chromeTabNo: number) => inflightOpenedAndBound.get(chromeTabNo) ?? null,
        bindExistingTabs,
    };
};
