import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForSnapshotReady } from '../executors/snapshot/stages/collect';

test('waitForSnapshotReady uses lightweight settle for interaction mode', async () => {
    const states: Array<'domcontentloaded' | 'networkidle'> = [];
    let evaluateCount = 0;
    const page = {
        waitForLoadState: async (state: 'domcontentloaded' | 'networkidle') => {
            states.push(state);
        },
        evaluate: async () => {
            evaluateCount += 1;
        },
    };

    await waitForSnapshotReady(page as any, 'interaction');

    assert.deepEqual(states, []);
    assert.equal(evaluateCount, 1);
});

test('waitForSnapshotReady keeps full load-state wait for navigation mode', async () => {
    const states: Array<'domcontentloaded' | 'networkidle'> = [];
    let evaluateCount = 0;
    const page = {
        waitForLoadState: async (state: 'domcontentloaded' | 'networkidle') => {
            states.push(state);
        },
        evaluate: async () => {
            evaluateCount += 1;
        },
    };

    await waitForSnapshotReady(page as any, 'navigation');

    assert.deepEqual(states, ['domcontentloaded', 'networkidle']);
    assert.equal(evaluateCount, 2);
});
