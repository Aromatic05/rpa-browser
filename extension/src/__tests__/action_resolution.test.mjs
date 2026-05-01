import assert from 'node:assert/strict';
import { resolveIncomingAction } from '../../dist/background/action.js';

const mkDeps = () => ({
    state: {
        getTokenScope: () => undefined,
        setActiveWorkspaceId: () => undefined,
    },
    ensureTabToken: async () => null,
    getActiveTabTokenForWindow: async () => null,
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

await log('workflow.init resolves as pageless without tabToken', async () => {
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

await log('non pageless action still fails when tabToken unavailable', async () => {
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
