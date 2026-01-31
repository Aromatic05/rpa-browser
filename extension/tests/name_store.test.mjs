import assert from 'node:assert/strict';
import {
    ALLOWED_GROUP_COLORS,
    ensureTabMeta,
    ensureWorkspaceMeta,
    pickRandomGroupColor,
} from '../dist/name_store.js';
import { safeGroupActiveTab } from '../dist/tab_grouping.js';

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

log('random color validity', () => {
    const color = pickRandomGroupColor(() => 0.2);
    assert.ok(ALLOWED_GROUP_COLORS.includes(color));
});

await log('tabGroups fallback when chrome API missing', async () => {
    const result = await safeGroupActiveTab(undefined, {
        title: 'Workspace 1',
        color: 'blue',
    });
    assert.equal(result.ok, false);
});

await log('tabGroups fallback when chrome API throws', async () => {
    const chromeLike = {
        tabs: {
            query: async () => [{ id: 123 }],
            group: async () => {
                throw new Error('boom');
            },
        },
        tabGroups: {
            update: async () => {},
        },
    };
    const result = await safeGroupActiveTab(chromeLike, {
        title: 'Workspace 1',
        color: 'blue',
    });
    assert.equal(result.ok, false);
});
