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
    },
    tabs: {
        query: async ({ windowId }) => [{ id: 11, windowId, url: 'https://example.com' }],
        get: async (tabId) => ({ id: tabId, windowId: 7, url: 'https://example.com' }),
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
    assert.equal(sent.some((action) => action.type === ACTION_TYPES.WINDOW_FOCUSED), true);
});

await log('window remove emits window.closed action', async () => {
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

    assert.equal(sent.length > 0, true);
    assert.equal(sent[0].type, ACTION_TYPES.WINDOW_CLOSED);
});
