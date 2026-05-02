import type { Action } from '../shared/types.js';
import { ACTION_TYPES } from './action_types.js';
import type { RouterState } from '../background/state.js';

const toStringValue = (value: unknown): string | null =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

export const projectInboundAction = (action: Action, state: RouterState, onRefresh: () => void): void => {
    if (action.type === ACTION_TYPES.WORKSPACE_SYNC) {return;}

    if (action.type === ACTION_TYPES.WORKSPACE_LIST) {
        const data = (action.payload ?? {}) as Record<string, unknown>;
        const activeWorkspaceName = toStringValue(data.activeWorkspaceName);
        if (activeWorkspaceName) {state.setActiveWorkspaceName(activeWorkspaceName);}
        onRefresh();
        return;
    }

    if (action.type === ACTION_TYPES.TAB_BOUND || action.type === ACTION_TYPES.WORKFLOW_OPEN || action.type === `${ACTION_TYPES.WORKFLOW_OPEN}.result`) {
        const data = (action.payload ?? {}) as Record<string, unknown>;
        const workspaceName = toStringValue(data.workspaceName);
        const tabName = toStringValue(data.tabName);
        if (workspaceName && tabName) {
            const activeChromeTabNo = state.getActiveChromeTabNo();
            if (typeof activeChromeTabNo === 'number') {
                const activeTab = state.getTabState(activeChromeTabNo);
                if (activeTab?.bindingName) {
                    state.upsertBindingWorkspaceTab(activeTab.bindingName, workspaceName, tabName);
                    state.bindWorkspaceToWindowIfKnown(activeTab.bindingName);
                }
            }
            state.setActiveWorkspaceName(workspaceName);
        }
        onRefresh();
        return;
    }

    if (action.type === ACTION_TYPES.WORKSPACE_CHANGED) {
        const data = (action.payload ?? {}) as Record<string, unknown>;
        const workspaceName = toStringValue(data.workspaceName) ?? action.workspaceName ?? null;
        if (workspaceName) {
            state.setActiveWorkspaceName(workspaceName);
            const activeWindowId = state.getActiveWindowId();
            if (typeof activeWindowId === 'number' && activeWindowId !== chrome.windows.WINDOW_ID_NONE) {
                state.setWindowWorkspace(activeWindowId, workspaceName);
            }
        }
        onRefresh();
    }
};
