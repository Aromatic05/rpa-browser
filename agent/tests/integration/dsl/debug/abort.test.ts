import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugController} from '../../../../src/automation/dsl/debug/controller';
import {DslDebugAbortError} from '../../../../src/automation/dsl/debug/errors';
import {runDsl} from '../../../../src/automation/dsl/runtime/run_dsl';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps';

const deps = {} as RunStepsDeps;

test('debug abort terminates a retained effect continuation before the browser mutation executes', async () => {
    const controller = createDslDebugController({breakBeforeEffects: true});
    let clickCalls = 0;
    const run = runDsl({body: [{
        kind: 'act',
        action: 'click',
        target: {kind: 'ref', ref: 'input.target'},
    }]}, {
        workspaceName: 'ws-1',
        deps,
        input: {target: {nodeId: 'dangerous-button'}},
        debugPort: controller.port,
        stepExecutionPort: {
            execute: async (step) => {
                clickCalls += 1;
                return {stepId: step.id, ok: true, data: {clicked: true}};
            },
        },
    });

    const paused = await controller.waitForPause();
    assert.equal(paused.reason, 'effect');
    assert.equal(clickCalls, 0);

    controller.abort(paused.continuationId);
    await assert.rejects(run, (error: unknown) =>
        error instanceof DslDebugAbortError
        && error.continuationId === paused.continuationId);
    assert.equal(clickCalls, 0);
});

test('debug abort before a statement prevents that statement and all later statements', async () => {
    const controller = createDslDebugController({initialMode: 'step'});
    const run = runDsl({body: [
        {kind: 'output', name: 'first', expr: {kind: 'ref', ref: 'input.value'}},
        {kind: 'output', name: 'second', expr: {kind: 'ref', ref: 'input.value'}},
    ]}, {
        workspaceName: 'ws-1',
        deps,
        input: {value: 1},
        debugPort: controller.port,
        stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
    });

    const paused = await controller.waitForPause();
    assert.equal(paused.location.path, 'body.0');
    controller.abort(paused.continuationId);
    await assert.rejects(run, DslDebugAbortError);
    assert.deepEqual(paused.scope.output, {});
});
