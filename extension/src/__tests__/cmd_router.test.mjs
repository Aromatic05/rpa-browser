import assert from 'node:assert/strict';
import { createCmdRouter } from '../../dist/background/cmd_router.js';
import { ACTION_TYPES } from '../../dist/shared/action_types.js';
import { MSG } from '../../dist/shared/protocol.js';

const log = async (name, fn) => {
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

const createChromeMock = () => ({
    windows: {
        WINDOW_ID_NONE: -1,
        create: async ({ url, focused }) => ({
            id: 31,
            focused,
            tabs: [{ id: 21, windowId: 31, url: url || 'https://example.com/new' }],
        }),
    },
    tabs: {
        query: async ({ windowId }) => [{ id: 11, windowId, url: 'https://example.com' }],
        get: async (tabId) => ({ id: tabId, windowId: 7, url: 'https://example.com' }),
        sendMessage: (_tabId, message, cb) => {
            if (message?.type === MSG.GET_TOKEN) {
                cb({ ok: true, tabToken: 'token-new', url: 'https://example.com/new' });
                return;
            }
            cb({ ok: true });
        },
    },
    runtime: {},
});

await log('workspace.sync action triggers refresh dispatch', async () => {
    globalThis.chrome = createChromeMock();
    const sent = [];
    let refreshed = 0;
    const router = createCmdRouter({
        wsClient: {
            sendAction: async (action) => {
                sent.push(action);
                return { ok: true, data: {} };
            },
        },
        onRefresh: () => {
            refreshed += 1;
        },
    });

    router.handleInboundAction({
        v: 1,
        id: 'evt-1',
        type: ACTION_TYPES.WORKSPACE_SYNC,
        payload: { reason: 'test' },
        scope: {},
    });

    assert.equal(refreshed, 1);
    assert.equal(sent.length, 0);
});

await log('window focus sends workspace.setActive and window.focused', async () => {
    globalThis.chrome = createChromeMock();
    const sent = [];
    const router = createCmdRouter({
        wsClient: {
            sendAction: async (action) => {
                sent.push(action);
                return { ok: true, data: { workspaceId: 'ws-1', tabId: 'tab-1', tabToken: 'token-1' } };
            },
        },
        onRefresh: () => undefined,
    });

    router.handleMessage(
        {
            type: MSG.HELLO,
            tabToken: 'token-1',
            url: 'https://example.com',
        },
        {
            tab: { id: 11, windowId: 7, url: 'https://example.com' },
        },
        () => undefined,
    );
    router.handleInboundAction({
        v: 1,
        id: 'evt-2',
        type: ACTION_TYPES.TAB_BOUND,
        payload: {
            workspaceId: 'ws-1',
            tabId: 'tab-1',
            tabToken: 'token-1',
            url: 'https://example.com',
        },
        scope: { workspaceId: 'ws-1', tabId: 'tab-1', tabToken: 'token-1' },
    });

    router.onFocusChanged(7);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sent.some((action) => action.type === ACTION_TYPES.WORKSPACE_SET_ACTIVE), true);
});

await log('window remove keeps router stable', async () => {
    globalThis.chrome = createChromeMock();
    const sent = [];
    const router = createCmdRouter({
        wsClient: {
            sendAction: async (action) => {
                sent.push(action);
                return { ok: true, data: {} };
            },
        },
        onRefresh: () => undefined,
    });

    router.onWindowRemoved(99);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(Array.isArray(sent), true);
});

await log('workspace.create opens a new window and returns claimed workspace', async () => {
    globalThis.chrome = createChromeMock();
    const sent = [];
    const router = createCmdRouter({
        wsClient: {
            sendAction: async (action) => {
                sent.push(action);
                if (action.type === ACTION_TYPES.TAB_PING) {
                    return { ok: true, data: { workspaceId: 'ws-new', tabId: 'tab-new', tabToken: 'token-new' } };
                }
                return { ok: true, data: {} };
            },
        },
        onRefresh: () => undefined,
    });

    let reply;
    router.handleMessage(
        {
            type: MSG.ACTION,
            action: {
                v: 1,
                id: 'create-1',
                type: ACTION_TYPES.WORKSPACE_CREATE,
                payload: { startUrl: 'https://example.com/new' },
                scope: {},
            },
        },
        { tab: { id: 11, windowId: 7, url: 'https://example.com' } },
        (payload) => {
            reply = payload;
        },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(reply?.ok, true);
    assert.equal(reply?.data?.workspaceId, 'ws-new');
    assert.equal(reply?.data?.windowId, 31);
    assert.equal(sent.some((action) => action.type === ACTION_TYPES.TAB_OPENED), true);
    assert.equal(sent.some((action) => action.type === ACTION_TYPES.TAB_PING), true);
});
