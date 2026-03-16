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

test('bindPage appends new token to active workspace instead of creating a new workspace', async () => {
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
        getContext: async () =>
            ({
                pages: () => [],
                newPage: async () => createMockPage('about:blank'),
            }) as any,
    });

    await pageRegistry.bindPage(createMockPage('https://example.com/a'), 'token-a');
    const before = pageRegistry.listWorkspaces();
    assert.equal(before.length, 1);
    const activeWorkspaceId = before[0].workspaceId;

    await pageRegistry.bindPage(createMockPage('https://example.com/b'), 'token-b');
    const after = pageRegistry.listWorkspaces();

    assert.equal(after.length, 1);
    const scopeA = pageRegistry.resolveScopeFromToken('token-a');
    const scopeB = pageRegistry.resolveScopeFromToken('token-b');
    assert.equal(scopeA.workspaceId, activeWorkspaceId);
    assert.equal(scopeB.workspaceId, activeWorkspaceId);
    assert.notEqual(scopeA.tabId, scopeB.tabId);
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
