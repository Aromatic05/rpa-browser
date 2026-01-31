/**
 * 状态模型：只做纯逻辑计算，不依赖 chrome API。
 *
 * 维护要点：
 * - 任何“外部数据刷新”都在调用方完成，本模块只负责计算新状态。
 * - activeWorkspaceId/activeTabId 的选择规则集中在这里，便于测试。
 */

export type WorkspaceItem = {
    workspaceId: string;
    tabCount: number;
    activeTabId?: string;
    status?: 'idle' | 'running' | 'error';
    displayName?: string;
};

export type TabItem = {
    tabId: string;
    title?: string;
    url?: string;
    active: boolean;
    displayName?: string;
};

export type PanelState = {
    activeWorkspaceId: string | null;
    activeTabId: string | null;
    workspaces: WorkspaceItem[];
    tabs: TabItem[];
    logs: string[];
};

export const initState = (): PanelState => ({
    activeWorkspaceId: null,
    activeTabId: null,
    workspaces: [],
    tabs: [],
    logs: [],
});

export const applyWorkspaces = (
    state: PanelState,
    workspaces: WorkspaceItem[],
    preferredActiveId?: string | null,
): PanelState => {
    const next = { ...state, workspaces: [...workspaces] };
    if (preferredActiveId && workspaces.find((w) => w.workspaceId === preferredActiveId)) {
        next.activeWorkspaceId = preferredActiveId;
    } else if (
        !next.activeWorkspaceId ||
        !workspaces.find((w) => w.workspaceId === next.activeWorkspaceId)
    ) {
        next.activeWorkspaceId = workspaces[0]?.workspaceId || null;
    }
    return next;
};

export const applyTabs = (state: PanelState, tabs: TabItem[]): PanelState => {
    const next = { ...state, tabs: [...tabs] };
    const active = tabs.find((t) => t.active);
    next.activeTabId = active?.tabId || null;
    return next;
};

export const selectWorkspace = (state: PanelState, workspaceId: string): PanelState => ({
    ...state,
    activeWorkspaceId: workspaceId,
    activeTabId: null,
    tabs: [],
});

export const selectTab = (state: PanelState, tabId: string): PanelState => ({
    ...state,
    activeTabId: tabId,
});

export const planNewTabScope = (state: PanelState) => ({
    workspaceId: state.activeWorkspaceId || undefined,
});

export const handleCloseTab = (
    state: PanelState,
    workspaceId: string,
    remainingTabs: TabItem[],
    allWorkspaces: WorkspaceItem[],
): PanelState => {
    let next = applyTabs({ ...state }, remainingTabs);
    const stillHasTabs = remainingTabs.length > 0;
    if (!stillHasTabs) {
        const filtered = allWorkspaces.filter((w) => w.workspaceId !== workspaceId && w.tabCount > 0);
        next = applyWorkspaces(next, filtered);
        next.activeWorkspaceId = filtered[0]?.workspaceId || null;
        next.tabs = [];
        next.activeTabId = null;
    }
    return next;
};

export const supportsTabGroups = (chromeLike: any) =>
    Boolean(chromeLike?.tabGroups && chromeLike?.tabs && typeof chromeLike.tabs.group === 'function');
