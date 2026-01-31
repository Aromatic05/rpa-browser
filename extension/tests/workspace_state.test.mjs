import assert from 'node:assert/strict';
import {
    initState,
    applyWorkspaces,
    applyTabs,
    planNewTabScope,
    handleCloseTab,
    supportsTabGroups,
    selectWorkspace,
} from '../dist/state/workspace_state.js';

const log = (name, fn) => {
    try {
        fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

log('New Tab uses active workspace by default', () => {
    let state = initState();
    state = applyWorkspaces(state, [
        { workspaceId: 'ws-1', tabCount: 1 },
        { workspaceId: 'ws-2', tabCount: 2 },
    ]);
    const scope = planNewTabScope(state);
    assert.equal(scope.workspaceId, 'ws-1');
});

log('Closing last tab triggers workspace close + active switch', () => {
    let state = initState();
    state = applyWorkspaces(state, [
        { workspaceId: 'ws-1', tabCount: 0 },
        { workspaceId: 'ws-2', tabCount: 2 },
    ]);
    state = selectWorkspace(state, 'ws-1');
    state = handleCloseTab(state, 'ws-1', [], [
        { workspaceId: 'ws-1', tabCount: 0 },
        { workspaceId: 'ws-2', tabCount: 2 },
    ]);
    assert.equal(state.activeWorkspaceId, 'ws-2');
    assert.equal(state.workspaces.length, 1);
});

log('Switching workspace clears tabs and updates active state', () => {
    let state = initState();
    state = applyWorkspaces(state, [
        { workspaceId: 'ws-1', tabCount: 1 },
        { workspaceId: 'ws-2', tabCount: 1 },
    ]);
    state = applyTabs(state, [
        { tabId: 't1', title: 'A', url: 'a', active: true },
    ]);
    state = selectWorkspace(state, 'ws-2');
    assert.equal(state.activeWorkspaceId, 'ws-2');
    assert.equal(state.tabs.length, 0);
});

log('applyWorkspaces prefers activeWorkspaceId when provided', () => {
    let state = initState();
    state = applyWorkspaces(
        state,
        [
            { workspaceId: 'ws-1', tabCount: 1 },
            { workspaceId: 'ws-2', tabCount: 1 },
        ],
        'ws-2',
    );
    assert.equal(state.activeWorkspaceId, 'ws-2');
});

log('tabGroups API unavailable -> still works (fallback)', () => {
    assert.equal(supportsTabGroups(undefined), false);
    assert.equal(supportsTabGroups({}), false);
});
