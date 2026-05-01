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

export type RouterState = {
    upsertTab: (chromeTabNo: number, bindingName: string, url: string, windowId?: number | null) => void;
    removeTab: (chromeTabNo: number) => TabRuntimeState | undefined;
    findChromeTabNoByBindingName: (bindingName: string) => number | null;
    getTabState: (chromeTabNo: number) => TabRuntimeState | undefined;
    getBindingWorkspaceTab: (bindingName: string) => BindingWorkspaceTab | undefined;
    upsertBindingWorkspaceTab: (bindingName: string, workspaceName: string, tabName: string) => void;
    removeBindingWorkspaceTab: (bindingName: string) => void;
    getWindowWorkspace: (windowId: number) => string | undefined;
    setWindowWorkspace: (windowId: number, workspaceName: string) => void;
    clearWindowWorkspace: (windowId: number) => void;
    clearWindowMappings: () => void;
    getActiveChromeTabNo: () => number | null;
    setActiveChromeTabNo: (chromeTabNo: number | null) => void;
    getActiveWorkspaceName: () => string | null;
    setActiveWorkspaceName: (workspaceName: string | null) => void;
    getActiveWindowId: () => number | null;
    setActiveWindowId: (windowId: number | null) => void;
    bindWorkspaceToWindowIfKnown: (bindingName: string) => void;
    shouldThrottleTabActivated: (key: string, now: number, thresholdMs: number) => boolean;
    shouldThrottleWorkspaceActivated: (key: string, now: number, thresholdMs: number) => boolean;
    resetStartupState: () => void;
    resetInstalledState: () => void;
};

export const createRouterState = (logger?: Logger): RouterState => {
    const tabState = new Map<number, TabRuntimeState>();
    const bindingNameToWorkspaceTab = new Map<string, BindingWorkspaceTab>();
    const windowToWorkspaceName = new Map<number, string>();

    let activeChromeTabNo: number | null = null;
    let activeWorkspaceName: string | null = null;
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

    const bindWorkspaceToWindowIfKnown = (bindingName: string) => {
        const mapped = bindingNameToWorkspaceTab.get(bindingName);
        if (!mapped) {return;}
        const chromeTabNo = findChromeTabNoByBindingName(bindingName);
        if (chromeTabNo === null) {return;}
        const windowId = tabState.get(chromeTabNo)?.windowId;
        if (typeof windowId !== 'number') {return;}
        windowToWorkspaceName.set(windowId, mapped.workspaceName);
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

    const clearWindowMappings = () => {
        windowToWorkspaceName.clear();
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
        getWindowWorkspace: (windowId: number) => windowToWorkspaceName.get(windowId),
        setWindowWorkspace: (windowId: number, workspaceName: string) => {
            windowToWorkspaceName.set(windowId, workspaceName);
        },
        clearWindowWorkspace: (windowId: number) => {
            windowToWorkspaceName.delete(windowId);
        },
        clearWindowMappings,
        getActiveChromeTabNo: () => activeChromeTabNo,
        setActiveChromeTabNo: (chromeTabNo: number | null) => {
            activeChromeTabNo = chromeTabNo;
        },
        getActiveWorkspaceName: () => activeWorkspaceName,
        setActiveWorkspaceName: (workspaceName: string | null) => {
            activeWorkspaceName = workspaceName;
        },
        getActiveWindowId: () => activeWindowId,
        setActiveWindowId: (windowId: number | null) => {
            activeWindowId = windowId;
        },
        bindWorkspaceToWindowIfKnown,
        shouldThrottleTabActivated,
        shouldThrottleWorkspaceActivated,
        resetStartupState: () => {
            clearWindowMappings();
        },
        resetInstalledState: () => {
            clearWindowMappings();
        },
    };
};
