import type { Logger } from '../shared/logger.js';

export type TabRuntimeState = {
    tabName: string;
    lastUrl: string;
    windowId: number | null;
    updatedAt: number;
};

type TokenScope = {
    workspaceName: string;
    tabId: string;
};

export type RouterState = {
    upsertTab: (tabId: number, tabName: string, url: string, windowId?: number | null) => void;
    removeTab: (tabId: number) => TabRuntimeState | undefined;
    findTabNameByToken: (tabName: string) => number | null;
    getTabState: (tabId: number) => TabRuntimeState | undefined;
    getTokenScope: (tabName: string) => TokenScope | undefined;
    upsertTokenScope: (tabName: string, workspaceName: string, tabId: string) => void;
    removeTokenScope: (tabName: string) => void;
    getWindowWorkspace: (windowId: number) => string | undefined;
    setWindowWorkspace: (windowId: number, workspaceName: string) => void;
    clearWindowWorkspace: (windowId: number) => void;
    clearWindowMappings: () => void;
    getActiveTabName: () => number | null;
    setActiveTabName: (tabId: number | null) => void;
    getActiveWorkspaceName: () => string | null;
    setActiveWorkspaceName: (workspaceName: string | null) => void;
    getActiveWindowId: () => number | null;
    setActiveWindowId: (windowId: number | null) => void;
    bindWorkspaceToWindowIfKnown: (tabName: string) => void;
    shouldThrottleTabActivated: (key: string, now: number, thresholdMs: number) => boolean;
    shouldThrottleWorkspaceActivated: (key: string, now: number, thresholdMs: number) => boolean;
    resetStartupState: () => void;
    resetInstalledState: () => void;
};

export const createRouterState = (logger?: Logger): RouterState => {
    const tabState = new Map<number, TabRuntimeState>();
    const tabNameToScope = new Map<string, TokenScope>();
    const windowToWorkspace = new Map<number, string>();

    let activeTabName: number | null = null;
    let activeWorkspaceName: string | null = null;
    let activeWindowId: number | null = null;
    let lastTabActivatedKey = '';
    let lastTabActivatedAt = 0;
    let lastWorkspaceSetActiveKey = '';
    let lastWorkspaceSetActiveAt = 0;

    const upsertTab = (tabId: number, tabName: string, url: string, windowId?: number | null) => {
        const existingWindowId = tabState.get(tabId)?.windowId ?? null;
        tabState.set(tabId, {
            tabName,
            lastUrl: url,
            windowId: typeof windowId === 'number' ? windowId : existingWindowId,
            updatedAt: Date.now(),
        });
    };

    const findTabNameByToken = (tabName: string) => {
        for (const [tabId, state] of tabState.entries()) {
            if (state.tabName === tabName) {return tabId;}
        }
        return null;
    };

    const upsertTokenScope = (tabName: string, workspaceName: string, tabId: string) => {
        const existing = tabNameToScope.get(tabName);
        if (existing && (existing.workspaceName !== workspaceName || existing.tabId !== tabId)) {
            logger?.debug('mapping.scope_replace', {
                tabName,
                existing,
                incoming: { workspaceName, tabId },
            });
        }
        tabNameToScope.set(tabName, { workspaceName, tabId });
    };

    const bindWorkspaceToWindowIfKnown = (tabName: string) => {
        const scope = tabNameToScope.get(tabName);
        if (!scope) {return;}
        const tabId = findTabNameByToken(tabName);
        if (tabId === null) {return;}
        const windowId = tabState.get(tabId)?.windowId;
        if (typeof windowId !== 'number') {return;}
        windowToWorkspace.set(windowId, scope.workspaceName);
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
        windowToWorkspace.clear();
    };

    return {
        upsertTab,
        removeTab: (tabId: number) => {
            const removed = tabState.get(tabId);
            tabState.delete(tabId);
            return removed;
        },
        findTabNameByToken,
        getTabState: (tabId: number) => tabState.get(tabId),
        getTokenScope: (tabName: string) => tabNameToScope.get(tabName),
        upsertTokenScope,
        removeTokenScope: (tabName: string) => {
            tabNameToScope.delete(tabName);
        },
        getWindowWorkspace: (windowId: number) => windowToWorkspace.get(windowId),
        setWindowWorkspace: (windowId: number, workspaceName: string) => {
            windowToWorkspace.set(windowId, workspaceName);
        },
        clearWindowWorkspace: (windowId: number) => {
            windowToWorkspace.delete(windowId);
        },
        clearWindowMappings,
        getActiveTabName: () => activeTabName,
        setActiveTabName: (tabId: number | null) => {
            activeTabName = tabId;
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
