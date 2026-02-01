import assert from 'node:assert/strict';
import { createRecordStore } from '../../dist/record/record_store.js';

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
    const store = {};
    return {
        get: async (key) => (typeof key === 'string' ? { [key]: store[key] } : {}),
        set: async (payload) => {
            Object.assign(store, payload);
        },
    };
};

await log('record store append/get/clear', async () => {
    const storage = createStorage();
    const recordStore = createRecordStore(storage);
    await recordStore.appendStep('ws1', {
        id: '1',
        name: 'browser.goto',
        args: { url: 'https://example.com' },
        meta: { ts: 1, tabToken: 't', source: 'record' },
    });
    const steps = await recordStore.getSteps('ws1');
    assert.equal(steps.length, 1);
    await recordStore.clearSteps('ws1');
    const cleared = await recordStore.getSteps('ws1');
    assert.equal(cleared.length, 0);
});
