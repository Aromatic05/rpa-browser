import type { Action } from '../shared/types.js';
import { ACTION_TYPES } from '../actions/action_types.js';
import type { RouterState } from '../background/state.js';

export const projectInboundAction = (action: Action, state: RouterState, onRefresh: () => void): void => {
    if (action.type === ACTION_TYPES.WORKSPACE_SYNC) {return;}

    if (action.type === ACTION_TYPES.WORKSPACE_LIST) {
        onRefresh();
        return;
    }

    if (action.type === ACTION_TYPES.TAB_BOUND || action.type === ACTION_TYPES.WORKFLOW_OPEN || action.type === `${ACTION_TYPES.WORKFLOW_OPEN}.result`) {
        const data = (action.payload ?? {}) as Record<string, unknown>;
        const tabName = typeof data.tabName === 'string' ? data.tabName : null;
        if (tabName && action.workspaceName) {
            state.upsertBindingWorkspaceTab(tabName, action.workspaceName, tabName);
        }
        onRefresh();
        return;
    }

    if (action.type === ACTION_TYPES.WORKSPACE_CHANGED) {
        onRefresh();
    }
};
