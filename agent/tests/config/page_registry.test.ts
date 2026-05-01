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
        tabNameKey: '__rpa_tab_token',
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
    const claimedA = pageRegistry.bindTokenToWorkspace('token-a', wsA.workspaceName);
    const claimedB = pageRegistry.bindTokenToWorkspace('token-b', wsB.workspaceName);
    assert.ok(claimedA);
    assert.ok(claimedB);
    assert.notEqual(claimedA?.workspaceName, claimedB?.workspaceName);
});

test('touchTabName updates tab timestamp for existing token', async () => {
    const pageRegistry = createPageRegistry({
        tabNameKey: '__rpa_tab_token',
        getContext: async () =>
            ({
                pages: () => [],
                newPage: async () => createMockPage('about:blank'),
            }) as any,
    });

    await pageRegistry.bindPage(createMockPage('https://example.com/a'), 'token-touch');
    const ws = pageRegistry.createWorkspaceShell('ws-touch');
    const claimed = pageRegistry.bindTokenToWorkspace('token-touch', ws.workspaceName);
    assert.ok(claimed);
    const scope = pageRegistry.resolveTabBinding('token-touch');
    const before = await pageRegistry.listTabs(scope.workspaceName);
    const prevUpdatedAt = before.find((item) => item.tabName === scope.tabName)?.updatedAt || 0;

    const now = prevUpdatedAt + 5000;
    const touched = pageRegistry.touchTabName('token-touch', now);
    const after = await pageRegistry.listTabs(scope.workspaceName);
    const nextUpdatedAt = after.find((item) => item.tabName === scope.tabName)?.updatedAt || 0;

    assert.ok(touched);
    assert.equal(touched?.workspaceName, scope.workspaceName);
    assert.equal(touched?.tabName, scope.tabName);
    assert.equal(nextUpdatedAt, now);
});

test('pending token claim is consumed by bindPage and binds token to workspace', async () => {
    const pageRegistry = createPageRegistry({
        tabNameKey: '__rpa_tab_token',
        getContext: async () =>
            ({
                pages: () => [],
                newPage: async () => createMockPage('about:blank'),
            }) as any,
    });

    pageRegistry.createWorkspaceShell('ws-claim');
    pageRegistry.createPendingTokenClaim({
        tabName: 'token-claim',
        workspaceName: 'ws-claim',
        source: 'test',
        url: 'chrome-extension://start/newtab.html',
        createdAt: Date.now(),
    });

    await pageRegistry.bindPage(createMockPage('chrome-extension://start/newtab.html'), 'token-claim');
    const scope = pageRegistry.resolveTabBinding('token-claim');
    assert.equal(scope.workspaceName, 'ws-claim');
});
