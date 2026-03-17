import assert from 'node:assert/strict';
import {
    ensureTabMeta,
    ensureWorkspaceMeta,
} from '../../dist/services/name_store.js';

const log = (name, fn) => {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            return result.then(
                () => console.log(`ok - ${name}`),
                (error) => {
                    console.error(`fail - ${name}`);
                    throw error;
                },
            );
        }
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

const createStorage = () => {
    const state = {};
    return {
        get: async (key) => ({ [key]: state[key] }),
        set: async (value) => {
            Object.assign(state, value);
        },
    };
};

await log('displayName allocation for workspaces and tabs', async () => {
    const storage = createStorage();
    const ws1 = await ensureWorkspaceMeta('ws-1', storage);
    const ws2 = await ensureWorkspaceMeta('ws-2', storage);
    assert.equal(ws1.displayName, 'Workspace 1');
    assert.equal(ws2.displayName, 'Workspace 2');

    const tab1 = await ensureTabMeta('ws-1', 'tab-1', storage);
    const tab2 = await ensureTabMeta('ws-1', 'tab-2', storage);
    assert.equal(tab1.displayName, 'Tab 1');
    assert.equal(tab2.displayName, 'Tab 2');
});
