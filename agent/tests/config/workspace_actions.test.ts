import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceHandlers } from '../../src/actions/workspace';

test('tab.opened activates resolved workspace/tab and logs payload', async () => {
    const logs: unknown[][] = [];
    const activated: Array<{ ws?: string; tab?: string }> = [];
    const ctx: any = {
        tabToken: 'token-1',
        page: {
            url: () => 'chrome-extension://start_extension/newtab.html',
        },
        log: (...args: unknown[]) => logs.push(args),
        pageRegistry: {
            resolveScopeFromToken: (token: string) => {
                assert.equal(token, 'token-1');
                return { workspaceId: 'ws-1', tabId: 'tab-1' };
            },
            setActiveWorkspace: (workspaceId: string) => activated.push({ ws: workspaceId }),
            setActiveTab: (workspaceId: string, tabId: string) => activated.push({ ws: workspaceId, tab: tabId }),
        },
    };

    const action: any = {
        v: 1,
        id: 'a1',
        type: 'tab.opened',
        payload: {
            source: 'start_extension',
            url: 'chrome://newtab/',
            title: 'New Tab',
            at: 123,
        },
    };

    const result = await workspaceHandlers['tab.opened'](ctx, action);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.workspaceId, 'ws-1');
    assert.equal(result.data.tabId, 'tab-1');
    assert.equal(result.data.tabToken, 'token-1');
    assert.equal(result.data.source, 'start_extension');

    assert.deepEqual(activated, [{ ws: 'ws-1' }, { ws: 'ws-1', tab: 'tab-1' }]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'tab.opened');
    assert.deepEqual(logs[0][1], {
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        tabToken: 'token-1',
        pageUrl: 'chrome-extension://start_extension/newtab.html',
        source: 'start_extension',
        reportedUrl: 'chrome://newtab/',
        reportedTitle: 'New Tab',
        reportedAt: 123,
    });
});
