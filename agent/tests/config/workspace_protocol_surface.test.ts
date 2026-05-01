import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceHandlers } from '../../src/actions/workspace';

const createCtx = () => ({
    page: { url: () => 'https://example.com' },
    tabToken: 'token-1',
    pageRegistry: {
        listWorkspaces: () => [
            {
                workspaceId: 'ws-1',
                activeTabId: 'tab-1',
                tabCount: 2,
                createdAt: 1,
                updatedAt: 2,
            },
        ],
        getActiveWorkspace: () => ({ workspaceId: 'ws-1' }),
        listTabs: async (_workspaceName: string) => [
            {
                tabId: 'tab-1',
                url: 'https://example.com',
                title: 'Example',
                active: true,
                createdAt: 3,
                updatedAt: 4,
            },
        ],
    },
    log: () => undefined,
    recordingState: {
        recordingEnabled: new Set<string>(),
        recordings: new Map(),
        recordingEnhancements: new Map(),
        workspaceLatestRecording: new Map(),
        recordingManifests: new Map(),
        replaying: new Set<string>(),
    },
    replayOptions: { clickDelayMs: 0, stepDelayMs: 0, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
    navDedupeWindowMs: 0,
    emit: () => undefined,
});

test('workspace.list only exposes workspaceName contract fields', async () => {
    const handler = workspaceHandlers['workspace.list'];
    const reply = await handler(createCtx() as any, { v: 1, id: 'a1', type: 'workspace.list', payload: {} } as any);
    const payload = reply.payload as any;
    assert.equal(payload.activeWorkspaceName, 'ws-1');
    assert.deepEqual(payload.workspaces[0], {
        workspaceName: 'ws-1',
        activeTabName: 'tab-1',
        tabCount: 2,
        createdAt: 1,
        updatedAt: 2,
    });
    assert.equal('workspaceId' in payload.workspaces[0], false);
    assert.equal('activeTabId' in payload.workspaces[0], false);
});

test('tab.list only exposes tabName contract fields and requires workspaceName', async () => {
    const handler = workspaceHandlers['tab.list'];

    const ok = await handler(createCtx() as any, {
        v: 1,
        id: 'a2',
        type: 'tab.list',
        workspaceName: 'ws-1',
        payload: {},
    } as any);
    const okPayload = ok.payload as any;
    assert.equal(okPayload.workspaceName, 'ws-1');
    assert.deepEqual(okPayload.tabs[0], {
        tabName: 'tab-1',
        url: 'https://example.com',
        title: 'Example',
        active: true,
        createdAt: 3,
        updatedAt: 4,
    });
    assert.equal('tabId' in okPayload.tabs[0], false);

    const failed = await handler(createCtx() as any, { v: 1, id: 'a3', type: 'tab.list', payload: {} } as any);
    assert.equal(failed.type, 'tab.list.failed');
    assert.match(String((failed.payload as any)?.message ?? ''), /workspace not found/);
});
