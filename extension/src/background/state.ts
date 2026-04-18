import type { Logger } from '../shared/logger.js';

export type TabRuntimeState = {
    tabToken: string;
    lastUrl: string;
    windowId: number | null;
    updatedAt: number;
};

type TokenScope = {
    workspaceId: string;
    tabId: string;
};

export type RouterState = {
    upsertTab: (tabId: number, tabToken: string, url: string, windowId?: number | null) => void;
    removeTab: (tabId: number) => TabRuntimeState | undefined;
    findTabIdByToken: (tabToken: string) => number | null;
    getTabState: (tabId: number) => TabRuntimeState | undefined;
    getTokenScope: (tabToken: string) => TokenScope | undefined;
    upsertTokenScope: (tabToken: string, workspaceId: string, tabId: string) => void;
    removeTokenScope: (tabToken: string) => void;
    getWindowWorkspace: (windowId: number) => string | undefined;
    setWindowWorkspace: (windowId: number, workspaceId: string) => void;
    clearWindowWorkspace: (windowId: number) => void;
    clearWindowMappings: () => void;
    getActiveTabId: () => number | null;
    setActiveTabId: (tabId: number | null) => void;
    getActiveWorkspaceId: () => string | null;
    setActiveWorkspaceId: (workspaceId: string | null) => void;
    getActiveWindowId: () => number | null;
    setActiveWindowId: (windowId: number | null) => void;
    bindWorkspaceToWindowIfKnown: (tabToken: string) => void;
    shouldThrottleTabActivated: (key: string, now: number, thresholdMs: number) => boolean;
    shouldThrottleWorkspaceActivated: (key: string, now: number, thresholdMs: number) => boolean;
    resetStartupState: () => void;
    resetInstalledState: () => void;
};

export const createRouterState = (logger?: Logger): RouterState => {
    const tabState = new Map<number, TabRuntimeState>();
    const tokenToScope = new Map<string, TokenScope>();
    const windowToWorkspace = new Map<number, string>();

    let activeTabId: number | null = null;
    let activeWorkspaceId: string | null = null;
    let activeWindowId: number | null = null;
    let lastTabActivatedKey = '';
    let lastTabActivatedAt = 0;
    let lastWorkspaceSetActiveKey = '';
    let lastWorkspaceSetActiveAt = 0;

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

    const upsertTokenScope = (tabToken: string, workspaceId: string, tabId: string) => {
        const existing = tokenToScope.get(tabToken);
        if (existing && (existing.workspaceId !== workspaceId || existing.tabId !== tabId)) {
            logger?.debug('mapping.scope_replace', {
                tabToken,
                existing,
                incoming: { workspaceId, tabId },
            });
        }
        tokenToScope.set(tabToken, { workspaceId, tabId });
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
        findTabIdByToken,
        getTabState: (tabId: number) => tabState.get(tabId),
        getTokenScope: (tabToken: string) => tokenToScope.get(tabToken),
        upsertTokenScope,
        removeTokenScope: (tabToken: string) => {
            tokenToScope.delete(tabToken);
        },
        getWindowWorkspace: (windowId: number) => windowToWorkspace.get(windowId),
        setWindowWorkspace: (windowId: number, workspaceId: string) => {
            windowToWorkspace.set(windowId, workspaceId);
        },
        clearWindowWorkspace: (windowId: number) => {
            windowToWorkspace.delete(windowId);
        },
        clearWindowMappings,
        getActiveTabId: () => activeTabId,
        setActiveTabId: (tabId: number | null) => {
            activeTabId = tabId;
        },
        getActiveWorkspaceId: () => activeWorkspaceId,
        setActiveWorkspaceId: (workspaceId: string | null) => {
            activeWorkspaceId = workspaceId;
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
