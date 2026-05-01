import assert from 'node:assert/strict';
import { applyReplyProjection, resolveIncomingAction } from '../../dist/background/action.js';

const mkDeps = () => ({
    state: {
        getTokenScope: () => undefined,
        setActiveWorkspaceName: () => undefined,
    },
    ensureTabName: async () => null,
    getActiveTabNameForWindow: async () => null,
});

const mkSender = () => ({
    tab: {
        id: 123,
        windowId: 456,
    },
});

const log = async (name, fn) => {
    try {
        await fn();
        console.warn(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

await log('workflow.init resolves as pageless without tabName', async () => {
    const result = await resolveIncomingAction(
        {
            v: 1,
            id: 'req-1',
            type: 'workflow.init',
            payload: { scene: 'demo-scene' },
        },
        mkSender(),
        mkDeps(),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.scoped.type, 'workflow.init');
    }
});

await log('non pageless action still fails when tabName unavailable', async () => {
    const result = await resolveIncomingAction(
        {
            v: 1,
            id: 'req-2',
            type: 'play.start',
            payload: {},
        },
        mkSender(),
        mkDeps(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.reply.type, 'play.start.failed');
        assert.equal(result.reply.payload.message, 'workspaceName unavailable');
    }
});

await log('applyReplyProjection maps scope using local sender token, not response payload tabName', async () => {
    const calls = [];
    const state = {
        upsertTokenScope: (token, workspaceName, tabName) => {
            calls.push({ token, workspaceName, tabName });
        },
        bindWorkspaceToWindowIfKnown: () => undefined,
        setWindowWorkspace: () => undefined,
        getTabState: (tabId) => (tabId === 123 ? { tabName: 'token-local', lastUrl: 'https://example.com' } : undefined),
    };

    applyReplyProjection(
        {
            scoped: { v: 1, id: 'req-3', type: 'tab.setActive', workspaceName: 'ws-1', payload: {} },
            senderTabName: 123,
            senderWindowId: 456,
            resolvedWorkspaceName: 'ws-1',
        },
        {
            v: 1,
            id: 'rep-3',
            type: 'tab.setActive.result',
            replyTo: 'req-3',
            payload: { workspaceName: 'ws-1', tabName: 'tab-1' },
        },
        mkSender(),
        state,
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { token: 'token-local', workspaceName: 'ws-1', tabName: 'tab-1' });
});
