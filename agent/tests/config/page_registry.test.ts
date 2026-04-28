import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageRegistry } from '../../src/runtime/page_registry';

const createMockPage = (url: string) =>
    ({
        isClosed: () => false,
        on: () => {},
        url: () => url,
        title: async () => '',
    }) as any;

test('bindPage requires explicit workspace binding', async () => {
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
        getContext: async () =>
            ({
                pages: () => [],
                newPage: async () => createMockPage('about:blank'),
            }) as any,
    });

    await pageRegistry.bindPage(createMockPage('https://example.com/a'), 'token-a');
    assert.equal(pageRegistry.listWorkspaces().length, 0);

    await pageRegistry.bindPage(createMockPage('https://example.com/b'), 'token-b');
    assert.equal(pageRegistry.listWorkspaces().length, 0);

    const wsA = pageRegistry.createWorkspaceShell('ws-a');
    const wsB = pageRegistry.createWorkspaceShell('ws-b');
    const claimedA = pageRegistry.bindTokenToWorkspace('token-a', wsA.workspaceId);
    const claimedB = pageRegistry.bindTokenToWorkspace('token-b', wsB.workspaceId);
    assert.ok(claimedA);
    assert.ok(claimedB);
    assert.notEqual(claimedA?.workspaceId, claimedB?.workspaceId);
});

test('touchTabToken updates tab timestamp for existing token', async () => {
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
        getContext: async () =>
            ({
                pages: () => [],
                newPage: async () => createMockPage('about:blank'),
            }) as any,
    });

    await pageRegistry.bindPage(createMockPage('https://example.com/a'), 'token-touch');
    const ws = pageRegistry.createWorkspaceShell('ws-touch');
    const claimed = pageRegistry.bindTokenToWorkspace('token-touch', ws.workspaceId);
    assert.ok(claimed);
    const scope = pageRegistry.resolveScopeFromToken('token-touch');
    const before = await pageRegistry.listTabs(scope.workspaceId);
    const prevUpdatedAt = before.find((item) => item.tabId === scope.tabId)?.updatedAt || 0;

    const now = prevUpdatedAt + 5000;
    const touched = pageRegistry.touchTabToken('token-touch', now);
    const after = await pageRegistry.listTabs(scope.workspaceId);
    const nextUpdatedAt = after.find((item) => item.tabId === scope.tabId)?.updatedAt || 0;

    assert.ok(touched);
    assert.equal(touched?.workspaceId, scope.workspaceId);
    assert.equal(touched?.tabId, scope.tabId);
    assert.equal(nextUpdatedAt, now);
});

test('pending token claim is consumed by bindPage and binds token to workspace', async () => {
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
        getContext: async () =>
            ({
                pages: () => [],
                newPage: async () => createMockPage('about:blank'),
            }) as any,
    });

    pageRegistry.createWorkspaceShell('ws-claim');
    pageRegistry.createPendingTokenClaim({
        tabToken: 'token-claim',
        workspaceId: 'ws-claim',
        source: 'test',
        url: 'chrome-extension://start/newtab.html',
        createdAt: Date.now(),
    });

    await pageRegistry.bindPage(createMockPage('chrome-extension://start/newtab.html'), 'token-claim');
    const scope = pageRegistry.resolveScopeFromToken('token-claim');
    assert.equal(scope.workspaceId, 'ws-claim');
});
