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

test('bindPage keeps token orphan until explicit claim', async () => {
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

    const claimedA = pageRegistry.claimOrphanToken('token-a');
    const claimedB = pageRegistry.claimOrphanToken('token-b');
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
    const claimed = pageRegistry.claimOrphanToken('token-touch');
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
