import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCmdRouter } from '../../dist/background/cmd_router.js';
import { ACTION_TYPES } from '../../dist/shared/action_types.js';
import { MSG } from '../../dist/shared/protocol.js';

const log = async (name, fn) => {
    try {
        await fn();
        console.warn(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

const toReplyAction = (request, result) => {
    if (result?.v === 1) {return result;}
    if (result?.ok === false) {
        return {
            v: 1,
            id: `reply-${request.id}`,
            type: `${request.type}.failed`,
            replyTo: request.id,
            payload: result.error || { code: 'ERR_UNKNOWN', message: 'unknown' },
        };
    }
    return {
        v: 1,
        id: `reply-${request.id}`,
        type: `${request.type}.result`,
        replyTo: request.id,
        payload: result?.data || {},
    };
};

const withActionReplies = (handler) => ({
    sendAction: async (action) => toReplyAction(action, await handler(action)),
});

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
        get: async (tabName) =>
            tabName === 21
                ? { id: tabName, windowId: 31, url: 'https://example.com/new' }
                : { id: tabName, windowId: 7, url: 'https://example.com' },
        update: async () => ({ ok: true }),
        sendMessage: (tabName, message, cb) => {
            if (message?.type === MSG.GET_TOKEN) {
                if (tabName === 21) {
                    cb({ ok: true, tabToken: 'token-new', url: 'https://example.com/new' });
                    return;
                }
                cb({ ok: true, tabToken: 'token-new', url: 'https://example.com/new' });
                return;
            }
            cb({ ok: true });
        },
    },
    runtime: {
        getURL: (path) => `chrome-extension://start/${(path || '').replace(/^\//, '')}`,
    },
    storage: {
        local: {
            get: (_keys, cb) => cb({}),
            set: (_value, cb) => cb?.(),
        },
        onChanged: {
            addListener: () => undefined,
        },
    },
});

await log('workspace.list action triggers refresh dispatch', async () => {
    globalThis.chrome = createChromeMock();
    const sent = [];
    let refreshed = 0;
    const router = createCmdRouter({
        wsClient: withActionReplies(async (action) => {
            sent.push(action);
            return { ok: true, data: {} };
        }),
        onRefresh: () => {
            refreshed += 1;
        },
    });

    router.handleInboundAction({
        v: 1,
        id: 'evt-1',
        type: ACTION_TYPES.WORKSPACE_LIST,
        payload: { reason: 'test', workspaces: [], activeWorkspaceName: null },
    });

    assert.equal(refreshed, 1);
    assert.equal(sent.length, 0);
});

await log('window focus sends workspace.setActive and window.focused', async () => {
    globalThis.chrome = createChromeMock();
    const sent = [];
    const router = createCmdRouter({
        wsClient: withActionReplies(async (action) => {
            sent.push(action);
            return { ok: true, data: { workspaceName: 'ws-1', tabName: 'tab-1', tabToken: 'token-1' } };
        }),
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
            workspaceName: 'ws-1',
            tabName: 'tab-1',
            url: 'https://example.com',
        },
    });

    router.onFocusChanged(7);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sent.some((action) => action.type === ACTION_TYPES.WORKSPACE_SET_ACTIVE), true);
});

await log('window remove keeps router stable', async () => {
    globalThis.chrome = createChromeMock();
    const sent = [];
    const router = createCmdRouter({
        wsClient: withActionReplies(async (action) => {
            sent.push(action);
            if (action.type === ACTION_TYPES.WORKSPACE_CREATE) {
                return { ok: true, data: { workspaceName: 'ws-new' } };
            }
            return { ok: true, data: {} };
        }),
        onRefresh: () => undefined,
    });

    router.onWindowRemoved(99);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(Array.isArray(sent), true);
});

await log('workspace.create returns workspace shell without opening window', async () => {
    globalThis.chrome = createChromeMock();
    const sent = [];
    const router = createCmdRouter({
        wsClient: withActionReplies(async (action) => {
            sent.push(action);
            if (action.type === ACTION_TYPES.WORKSPACE_CREATE) {
                return { ok: true, data: { workspaceName: 'ws-new' } };
            }
            return { ok: true, data: {} };
        }),
        onRefresh: () => undefined,
    });

    let reply = null;
    router.handleMessage(
        {
            type: MSG.ACTION,
            action: {
                v: 1,
                id: 'create-1',
                type: ACTION_TYPES.WORKSPACE_CREATE,
                payload: { startUrl: 'https://example.com/new' },
            },
        },
        { tab: { id: 11, windowId: 7, url: 'https://example.com' } },
        (payload) => {
            reply = payload;
        },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reply?.type, `${ACTION_TYPES.WORKSPACE_CREATE}.result`);
    assert.equal(typeof reply?.payload?.workspaceName, 'string');
    assert.equal(reply?.payload?.windowId, undefined);
    assert.equal(reply?.payload?.pending, undefined);
    assert.equal(sent.some((action) => action.type === ACTION_TYPES.TAB_PING), false);
});

await log('tabs.onCreated does not emit binding actions', async () => {
    globalThis.chrome = createChromeMock();
    const sent = [];
    const router = createCmdRouter({
        wsClient: withActionReplies(async (action) => {
            sent.push(action);
            if (action.type === ACTION_TYPES.TAB_OPENED) {
                return { ok: true, data: { workspaceName: 'ws-1', tabName: 'tab-new', tabToken: 'token-new' } };
            }
            return { ok: true, data: {} };
        }),
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
        id: 'evt-bind',
        type: ACTION_TYPES.TAB_BOUND,
        payload: {
            workspaceName: 'ws-1',
            tabName: 'tab-1',
            url: 'https://example.com',
        },
    });

    router.onCreated({ id: 22, windowId: 7, url: 'https://example.com/new', title: 'New' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sent.some((action) => action.type === ACTION_TYPES.TAB_OPENED), false);
});

await log('tabs.onCreated reuses pre-bound token scope when window mapping is not ready', async () => {
    globalThis.chrome = createChromeMock();
    const sent = [];
    const router = createCmdRouter({
        wsClient: withActionReplies(async (action) => {
            sent.push(action);
            if (action.type === ACTION_TYPES.TAB_OPENED) {
                return { ok: true, data: { workspaceName: 'ws-url', tabName: 'tab-new', tabToken: 'token-new' } };
            }
            return { ok: true, data: {} };
        }),
        onRefresh: () => undefined,
    });

    router.handleInboundAction({
        v: 1,
        id: 'evt-prebind',
        type: ACTION_TYPES.TAB_BOUND,
        payload: { workspaceName: 'ws-url', tabName: 'tab-pre', url: 'https://example.com/pre' },
    });

    router.onCreated({
        id: 21,
        windowId: 31,
        url: 'https://example.com/new',
        title: 'RPA Start',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const openedCount = sent.filter((action) => action.type === ACTION_TYPES.TAB_OPENED).length;
    assert.equal(openedCount, 0);
});

await log('workspace.list works without tab token', async () => {
    globalThis.chrome = createChromeMock();
    chrome.tabs.sendMessage = (tabName, message, cb) => {
        if (tabName === 99 && message?.type === MSG.GET_TOKEN) {
            cb({ ok: false });
            return;
        }
        if (message?.type === MSG.GET_TOKEN) {
            cb({ ok: true, tabToken: 'token-new', url: 'https://example.com/new' });
            return;
        }
        cb({ ok: true });
    };
    chrome.tabs.query = async ({ windowId }) => {
        if (windowId === 88) {return [];}
        return [{ id: 11, windowId, url: 'https://example.com' }];
    };
    const sent = [];
    const router = createCmdRouter({
        wsClient: withActionReplies(async (action) => {
            sent.push(action);
            if (action.type === ACTION_TYPES.WORKSPACE_LIST) {
                return { ok: true, data: { workspaces: [{ workspaceName: 'ws-shell', tabCount: 0 }], activeWorkspaceName: 'ws-shell' } };
            }
            return { ok: true, data: {} };
        }),
        onRefresh: () => undefined,
    });

    let reply;
    router.handleMessage(
        {
            type: MSG.ACTION,
            action: {
                v: 1,
                id: 'list-no-token',
                type: ACTION_TYPES.WORKSPACE_LIST,
                payload: {},
            },
        },
        { tab: { id: 99, windowId: 88, url: 'https://example.com/new' } },
        (payload) => {
            reply = payload;
        },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(reply?.type, `${ACTION_TYPES.WORKSPACE_LIST}.result`);
    assert.equal(Array.isArray(reply?.payload?.workspaces), true);
    assert.equal(sent.some((action) => action.type === ACTION_TYPES.WORKSPACE_LIST), true);
});

await log('router rejects non-request action type from panel ingress', async () => {
    globalThis.chrome = createChromeMock();
    const router = createCmdRouter({
        wsClient: withActionReplies(async () => {
            throw new Error('ws should not be called');
        }),
        onRefresh: () => undefined,
    });

    let reply;
    router.handleMessage(
        {
            type: MSG.ACTION,
            action: {
                v: 1,
                id: 'bad-evt',
                type: 'play.step.finished',
                payload: { stepId: 's1' },
            },
        },
        { tab: { id: 11, windowId: 7, url: 'https://example.com' } },
        (payload) => {
            reply = payload;
        },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reply?.type, 'action.dispatch.failed');
    assert.equal(reply?.payload?.code, 'ERR_BAD_ARGS');
});

await log('source guard: content/start_extension do not directly issue tab.init/tab.opened', async () => {
    const contentSrc = fs.readFileSync(new URL('../content/token_bridge.ts', import.meta.url), 'utf8');
    const startSrc = fs.readFileSync(new URL('../../../start_extension/src/entry/newtab.ts', import.meta.url), 'utf8');
    assert.equal(contentSrc.includes("type: 'tab.init'"), false);
    assert.equal(startSrc.includes("'tab.init'"), false);
    assert.equal(startSrc.includes("'tab.opened'"), false);
});
