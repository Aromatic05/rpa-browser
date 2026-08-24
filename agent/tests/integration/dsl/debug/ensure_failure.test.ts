import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugController} from '../../../../src/program/dsl/debug/controller';
import {runDslSource} from '../../../../src/program/dsl/runtime';
import {DslRuntimeError} from '../../../../src/program/dsl/diagnostics/errors';
import type {RunStepsDeps} from '../../../../src/runner/run_steps';

const deps = {} as RunStepsDeps;

test('ensure failure pauses as an invariant counterexample before later effects', async () => {
    const controller = createDslDebugController({breakOnFailure: true});
    let clickCalls = 0;
    const run = runDslSource(`
        ensure compute eq(input.actual, input.expected)
        click input.target
    `, {
        workspaceName: 'ws-ensure',
        deps,
        input: {actual: 1, expected: 2, target: {nodeId: 'submit'}},
        debugPort: controller.port,
        stepExecutionPort: {
            execute: async (step) => {
                clickCalls += 1;
                return {stepId: step.id, ok: true, data: {}};
            },
        },
    });

    const paused = await controller.waitForPause();
    assert.equal(paused.reason, 'failure');
    if (paused.reason !== 'failure') {throw new Error('expected failure pause');}
    assert.equal(paused.location.kind, 'ensure');
    assert.equal(paused.location.path, 'body.0');
    assert.deepEqual(paused.failure, {
        kind: 'invariant',
        code: 'ERR_DSL_ENSURE_FAILED',
        message: 'DSL ensure failed',
        details: {
            expected: true,
            actual: false,
            condition: {
                kind: 'compute',
                expr: {
                    op: 'eq',
                    args: [
                        {ref: {path: 'input.actual'}},
                        {ref: {path: 'input.expected'}},
                    ],
                },
            },
        },
    });
    assert.equal(clickCalls, 0);

    controller.continue(paused.continuationId);
    await assert.rejects(run, (error: unknown) =>
        error instanceof DslRuntimeError && error.code === 'ERR_DSL_ENSURE_FAILED');
    assert.equal(clickCalls, 0);
});
