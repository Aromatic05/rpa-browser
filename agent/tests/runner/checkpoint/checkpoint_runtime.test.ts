import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointScope, resolveCheckpointValue, runCheckpointProcedure } from '../../../src/runner/checkpoint/runtime';
import type { Checkpoint } from '../../../src/runner/checkpoint/types';

test('resolveCheckpointValue reads input/local/output refs', () => {
    const scope = createCheckpointScope({ x: 1 });
    scope.local.rows = [1, 2];
    scope.output.done = true;

    assert.equal(resolveCheckpointValue({ ref: 'input.x' }, scope).ok, true);
    assert.equal(resolveCheckpointValue({ ref: 'local.rows' }, scope).ok, true);
    assert.equal(resolveCheckpointValue({ ref: 'output.done' }, scope).ok, true);
});

test('runCheckpointProcedure fails on missing ref', async () => {
    const checkpoint: Checkpoint = {
        id: 'cp-missing',
        kind: 'procedure',
        output: {
            rowCount: { ref: 'local.rowsCount' },
        },
    };

    const result = await runCheckpointProcedure({
        checkpoint,
        stepIdPrefix: 'cp',
        executeStep: async () => ({ stepId: 'noop', ok: true }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_CHECKPOINT_REF_NOT_FOUND');
});
