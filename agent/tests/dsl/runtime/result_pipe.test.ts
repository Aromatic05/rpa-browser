import test from 'node:test';
import assert from 'node:assert/strict';
import { createResultPipe, pushResultPipe, readResultPipe, waitForResultPipe } from '../../../src/runner/run_steps';

test('waitForResultPipe resolves after push', async () => {
    const pipe = createResultPipe();
    let resolved = false;

    const wait = waitForResultPipe(pipe).then(() => {
        resolved = true;
    });

    await Promise.resolve();
    assert.equal(resolved, false);

    pushResultPipe(pipe, {
        runId: 'run-1',
        cursor: 0,
        stepId: 'step-1',
        ok: true,
        data: { value: 1 },
        ts: Date.now(),
    });

    await wait;
    assert.equal(resolved, true);
});

test('waitForResultPipe wakes multiple waiters', async () => {
    const pipe = createResultPipe();
    const awakened: string[] = [];

    const waitA = waitForResultPipe(pipe).then(() => {
        awakened.push('a');
    });
    const waitB = waitForResultPipe(pipe).then(() => {
        awakened.push('b');
    });

    pushResultPipe(pipe, {
        runId: 'run-1',
        cursor: 0,
        stepId: 'step-1',
        ok: true,
        ts: Date.now(),
    });

    await Promise.all([waitA, waitB]);
    assert.deepEqual(awakened.sort(), ['a', 'b']);
});

test('result pipe keeps all pushed events in order', async () => {
    const pipe = createResultPipe();

    pushResultPipe(pipe, {
        runId: 'run-1',
        cursor: 0,
        stepId: 'step-1',
        ok: true,
        ts: Date.now(),
    });
    pushResultPipe(pipe, {
        runId: 'run-1',
        cursor: 1,
        stepId: 'step-2',
        ok: true,
        ts: Date.now(),
    });

    const { items, nextCursor } = readResultPipe(pipe, 0, 10);
    assert.equal(nextCursor, 2);
    assert.deepEqual(
        items.map((item) => item.stepId),
        ['step-1', 'step-2'],
    );
});
