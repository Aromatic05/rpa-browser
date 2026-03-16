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

test('tab.activated activates resolved workspace/tab and logs payload', async () => {
    const logs: unknown[][] = [];
    const activated: Array<{ ws?: string; tab?: string }> = [];
    const ctx: any = {
        tabToken: 'token-2',
        page: {
            url: () => 'https://example.com/current',
        },
        log: (...args: unknown[]) => logs.push(args),
        pageRegistry: {
            resolveScopeFromToken: () => ({ workspaceId: 'ws-2', tabId: 'tab-9' }),
            setActiveWorkspace: (workspaceId: string) => activated.push({ ws: workspaceId }),
            setActiveTab: (workspaceId: string, tabId: string) => activated.push({ ws: workspaceId, tab: tabId }),
        },
    };
    const action: any = {
        v: 1,
        id: 'a2',
        type: 'tab.activated',
        payload: { source: 'extension.sw', url: 'https://example.com', at: 456 },
    };

    const result = await workspaceHandlers['tab.activated'](ctx, action);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(activated, [{ ws: 'ws-2' }, { ws: 'ws-2', tab: 'tab-9' }]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'tab.activated');
});

test('tab.closed returns stale response when token scope is missing', async () => {
    const logs: unknown[][] = [];
    const ctx: any = {
        tabToken: 'missing-token',
        page: { url: () => 'about:blank' },
        log: (...args: unknown[]) => logs.push(args),
        pageRegistry: {
            resolveScopeFromToken: () => {
                throw new Error('not found');
            },
        },
    };
    const action: any = {
        v: 1,
        id: 'a3',
        type: 'tab.closed',
        payload: { source: 'extension.sw', at: 789 },
    };

    const result = await workspaceHandlers['tab.closed'](ctx, action);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.stale, true);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'tab.closed');
});
