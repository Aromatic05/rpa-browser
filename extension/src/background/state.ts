import type { Logger } from '../shared/logger.js';

export type TabRuntimeState = {
    bindingName: string;
    lastUrl: string;
    windowId: number | null;
    updatedAt: number;
};

type BindingWorkspaceTab = {
    workspaceName: string;
    tabName: string;
};

export type RouterStateSnapshot = {
    tabs: Array<{chromeTabNo: number} & TabRuntimeState>;
    bindings: Array<{bindingName: string} & BindingWorkspaceTab>;
    activeChromeTabNo: number | null;
    activeWindowId: number | null;
};

export type RouterState = {
    upsertTab: (chromeTabNo: number, bindingName: string, url: string, windowId?: number | null) => void;
    removeTab: (chromeTabNo: number) => TabRuntimeState | undefined;
    findChromeTabNoByBindingName: (bindingName: string) => number | null;
    getTabState: (chromeTabNo: number) => TabRuntimeState | undefined;
    getBindingWorkspaceTab: (bindingName: string) => BindingWorkspaceTab | undefined;
    upsertBindingWorkspaceTab: (bindingName: string, workspaceName: string, tabName: string) => void;
    removeBindingWorkspaceTab: (bindingName: string) => void;
    getActiveChromeTabNo: () => number | null;
    setActiveChromeTabNo: (chromeTabNo: number | null) => void;
    getActiveWindowId: () => number | null;
    setActiveWindowId: (windowId: number | null) => void;
    shouldThrottleTabActivated: (key: string, now: number, thresholdMs: number) => boolean;
    shouldThrottleWorkspaceActivated: (key: string, now: number, thresholdMs: number) => boolean;
    resetStartupState: () => void;
    resetInstalledState: () => void;
    snapshot: () => RouterStateSnapshot;
    restore: (snapshot: RouterStateSnapshot) => void;
};

export const createRouterState = (logger?: Logger): RouterState => {
    const tabState = new Map<number, TabRuntimeState>();
    const bindingNameToWorkspaceTab = new Map<string, BindingWorkspaceTab>();

    let activeChromeTabNo: number | null = null;
    let activeWindowId: number | null = null;
    let lastTabActivatedKey = '';
    let lastTabActivatedAt = 0;
    let lastWorkspaceSetActiveKey = '';
    let lastWorkspaceSetActiveAt = 0;

    const upsertTab = (chromeTabNo: number, bindingName: string, url: string, windowId?: number | null) => {
        const existingWindowId = tabState.get(chromeTabNo)?.windowId ?? null;
        tabState.set(chromeTabNo, {
            bindingName,
            lastUrl: url,
            windowId: typeof windowId === 'number' ? windowId : existingWindowId,
            updatedAt: Date.now(),
        });
    };

    const findChromeTabNoByBindingName = (bindingName: string) => {
        for (const [chromeTabNo, state] of tabState.entries()) {
            if (state.bindingName === bindingName) {return chromeTabNo;}
        }
        return null;
    };

    const upsertBindingWorkspaceTab = (bindingName: string, workspaceName: string, tabName: string) => {
        const existing = bindingNameToWorkspaceTab.get(bindingName);
        if (existing && (existing.workspaceName !== workspaceName || existing.tabName !== tabName)) {
            logger?.debug('mapping.replace', {
                bindingName,
                existing,
                incoming: { workspaceName, tabName },
            });
        }
        bindingNameToWorkspaceTab.set(bindingName, { workspaceName, tabName });
    };

    const shouldThrottleTabActivated = (key: string, now: number, thresholdMs: number) => {
        const duplicated = key === lastTabActivatedKey && now - lastTabActivatedAt < thresholdMs;
        if (!duplicated) {
            lastTabActivatedKey = key;
            lastTabActivatedAt = now;
        }
        return duplicated;
    };

    const shouldThrottleWorkspaceActivated = (key: string, now: number, thresholdMs: number) => {
        const duplicated = key === lastWorkspaceSetActiveKey && now - lastWorkspaceSetActiveAt < thresholdMs;
        if (!duplicated) {
            lastWorkspaceSetActiveKey = key;
            lastWorkspaceSetActiveAt = now;
        }
        return duplicated;
    };

    return {
        upsertTab,
        removeTab: (chromeTabNo: number) => {
            const removed = tabState.get(chromeTabNo);
            tabState.delete(chromeTabNo);
            return removed;
        },
        findChromeTabNoByBindingName,
        getTabState: (chromeTabNo: number) => tabState.get(chromeTabNo),
        getBindingWorkspaceTab: (bindingName: string) => bindingNameToWorkspaceTab.get(bindingName),
        upsertBindingWorkspaceTab,
        removeBindingWorkspaceTab: (bindingName: string) => {
            bindingNameToWorkspaceTab.delete(bindingName);
        },
        getActiveChromeTabNo: () => activeChromeTabNo,
        setActiveChromeTabNo: (chromeTabNo: number | null) => {
            activeChromeTabNo = chromeTabNo;
        },
        getActiveWindowId: () => activeWindowId,
        setActiveWindowId: (windowId: number | null) => {
            activeWindowId = windowId;
        },
        shouldThrottleTabActivated,
        shouldThrottleWorkspaceActivated,
        resetStartupState: () => undefined,
        resetInstalledState: () => undefined,
        snapshot: () => ({
            tabs: [...tabState.entries()].map(([chromeTabNo, state]) => ({chromeTabNo, ...state})),
            bindings: [...bindingNameToWorkspaceTab.entries()].map(([bindingName, mapping]) => ({bindingName, ...mapping})),
            activeChromeTabNo,
            activeWindowId,
        }),
        restore: (snapshot: RouterStateSnapshot) => {
            tabState.clear();
            bindingNameToWorkspaceTab.clear();
            for (const tab of snapshot.tabs) {
                if (!Number.isInteger(tab.chromeTabNo) || !tab.bindingName) {continue;}
                tabState.set(tab.chromeTabNo, {
                    bindingName: tab.bindingName,
                    lastUrl: tab.lastUrl || '',
                    windowId: typeof tab.windowId === 'number' ? tab.windowId : null,
                    updatedAt: typeof tab.updatedAt === 'number' ? tab.updatedAt : Date.now(),
                });
            }
            for (const binding of snapshot.bindings) {
                if (!binding.bindingName || !binding.workspaceName || !binding.tabName) {continue;}
                bindingNameToWorkspaceTab.set(binding.bindingName, {
                    workspaceName: binding.workspaceName,
                    tabName: binding.tabName,
                });
            }
            activeChromeTabNo = typeof snapshot.activeChromeTabNo === 'number'
                ? snapshot.activeChromeTabNo
                : null;
            activeWindowId = typeof snapshot.activeWindowId === 'number'
                ? snapshot.activeWindowId
                : null;
            lastTabActivatedKey = '';
            lastTabActivatedAt = 0;
            lastWorkspaceSetActiveKey = '';
            lastWorkspaceSetActiveAt = 0;
        },
    };
};
