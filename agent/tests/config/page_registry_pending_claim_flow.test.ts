import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageRegistry } from '../../src/runtime/page_registry';
import { workspaceHandlers } from '../../src/actions/workspace';

const createMockPage = (url: string) =>
    ({
        isClosed: () => false,
        on: () => {},
        url: () => url,
        title: async () => 'Start',
    }) as any;

test('tab.init pending claim is consumed by bindPage and tab.opened resolves without ERR_BAD_ARGS', async () => {
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
        getContext: async () =>
            ({
                pages: () => [],
                newPage: async () => createMockPage('about:blank'),
            }) as any,
    });

    pageRegistry.createWorkspaceShell('ws-flow');

    const initReply = await workspaceHandlers['tab.init'](
        {
            pageRegistry,
            page: createMockPage('chrome-extension://start/newtab.html'),
        } as any,
        {
            v: 1,
            id: 'init-1',
            type: 'tab.init',
            scope: { workspaceId: 'ws-flow' },
            payload: {
                source: 'start_extension',
                url: 'chrome-extension://start/newtab.html',
                at: Date.now(),
            },
        } as any,
    );

    assert.equal(initReply.type, 'tab.init.result');
    const tabToken = (initReply.payload as any)?.tabToken as string;
    assert.equal(typeof tabToken, 'string');
    assert.equal(tabToken.length > 10, true);

    const page = createMockPage('chrome-extension://start/newtab.html');
    await pageRegistry.bindPage(page, tabToken);

    const scope = pageRegistry.resolveScopeFromToken(tabToken);
    assert.equal(scope.workspaceId, 'ws-flow');

    const openedReply = await workspaceHandlers['tab.opened'](
        {
            tabToken,
            pageRegistry,
            page,
            log: () => {},
        } as any,
        {
            v: 1,
            id: 'opened-1',
            type: 'tab.opened',
            scope: { tabToken, workspaceId: 'ws-flow' },
            payload: {
                source: 'start_extension',
                url: 'chrome-extension://start/newtab.html',
                title: 'RPA Start',
                at: Date.now(),
                workspaceId: 'ws-flow',
            },
        } as any,
    );

    assert.equal(openedReply.type, 'tab.opened.result');
    assert.equal((openedReply.payload as any).workspaceId, 'ws-flow');
});
