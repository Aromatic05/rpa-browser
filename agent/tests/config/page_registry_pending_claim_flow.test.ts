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
        tabNameKey: '__rpa_tab_token',
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
            scope: { workspaceName: 'ws-flow' },
            payload: {
                source: 'start_extension',
                url: 'chrome-extension://start/newtab.html',
                at: Date.now(),
            },
        } as any,
    );

    assert.equal(initReply.type, 'tab.init.result');
    const tabName = (initReply.payload as any)?.tabName as string;
    assert.equal(typeof tabName, 'string');
    assert.equal(tabName.length > 10, true);

    const page = createMockPage('chrome-extension://start/newtab.html');
    await pageRegistry.bindPage(page, tabName);

    const scope = pageRegistry.resolveTabBinding(tabName);
    assert.equal(scope.workspaceName, 'ws-flow');

    const openedReply = await workspaceHandlers['tab.opened'](
        {
            tabName,
            pageRegistry,
            page,
            log: () => {},
        } as any,
        {
            v: 1,
            id: 'opened-1',
            type: 'tab.opened',
            scope: { tabName, workspaceName: 'ws-flow' },
            payload: {
                source: 'start_extension',
                url: 'chrome-extension://start/newtab.html',
                title: 'RPA Start',
                at: Date.now(),
                workspaceName: 'ws-flow',
            },
        } as any,
    );

    assert.equal(openedReply.type, 'tab.opened.result');
    assert.equal((openedReply.payload as any).workspaceName, 'ws-flow');
});
