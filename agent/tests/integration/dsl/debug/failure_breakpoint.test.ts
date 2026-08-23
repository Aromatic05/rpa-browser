import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugController} from '../../../../src/dsl/debug/controller';
import {runDsl} from '../../../../src/dsl/runtime/run_dsl';
import {DslRuntimeError} from '../../../../src/dsl/diagnostics/errors';
import type {DslProgram} from '../../../../src/dsl/ast/types';
import type {RunStepsDeps} from '../../../../src/runner/run_steps';

const deps = {} as RunStepsDeps;

test('failure breakpoint suspends after a failed browser step before the DSL error escapes', async () => {
    const controller = createDslDebugController({breakOnFailure: true});
    const calls: string[] = [];
    const program: DslProgram = {
        body: [{
            kind: 'act',
            action: 'click',
            target: {kind: 'ref', ref: 'input.target'},
        }],
    };
    let settled = false;
    const run = runDsl(program, {
        workspaceName: 'ws-1',
        deps,
        input: {target: {nodeId: 'missing-button'}},
        debugPort: controller.port,
        stepExecutionPort: {
            execute: async (step) => {
                calls.push(step.name);
                return {
                    stepId: step.id,
                    ok: false,
                    error: {
                        code: 'ERR_NOT_FOUND',
                        message: 'button disappeared',
                        details: {candidateCount: 0},
                    },
                };
            },
        },
    }).finally(() => {settled = true;});

    const paused = await controller.waitForPause();
    assert.equal(paused.reason, 'failure');
    if (paused.reason !== 'failure') {throw new Error('expected failure pause');}
    assert.equal(paused.failure.kind, 'step');
    if (paused.failure.kind !== 'step') {throw new Error('expected step failure');}
    assert.equal(settled, false);
    assert.equal(paused.location.path, 'body.0');
    assert.deepEqual(paused.failure, {
        kind: 'step',
        stepId: paused.failure.stepId,
        stepName: 'browser.click',
        classification: 'effect',
        args: {nodeId: 'missing-button'},
        code: 'ERR_NOT_FOUND',
        message: 'button disappeared',
        details: {candidateCount: 0},
    });
    assert.deepEqual(calls, ['browser.click']);

    controller.continue(paused.continuationId);
    await assert.rejects(run, (error: unknown) =>
        error instanceof DslRuntimeError
        && error.code === 'ERR_NOT_FOUND'
        && error.message === 'button disappeared');
    assert.deepEqual(calls, ['browser.click']);
});

test('failure breakpoint is opt-in and does not change ordinary runtime failures', async () => {
    const controller = createDslDebugController();
    const run = runDsl({body: [{
        kind: 'act',
        action: 'click',
        target: {kind: 'ref', ref: 'input.target'},
    }]}, {
        workspaceName: 'ws-1',
        deps,
        input: {target: {nodeId: 'missing-button'}},
        debugPort: controller.port,
        stepExecutionPort: {
            execute: async (step) => ({
                stepId: step.id,
                ok: false,
                error: {code: 'ERR_NOT_FOUND', message: 'missing'},
            }),
        },
    });

    await assert.rejects(run, (error: unknown) =>
        error instanceof DslRuntimeError && error.code === 'ERR_NOT_FOUND');
});

test('failure breakpoint also guards failed legacy checkpoint steps', async () => {
    const controller = createDslDebugController({breakOnFailure: true});
    let clickCalls = 0;
    const run = runDsl({body: [{kind: 'checkpoint', id: 'repair'}]}, {
        workspaceName: 'ws-1',
        deps,
        debugPort: controller.port,
        checkpointProvider: {
            getCheckpoint: (id) => id === 'repair' ? {
                id: 'repair',
                kind: 'procedure',
                content: [{type: 'act', step: {name: 'browser.click', args: {selector: '#missing'}}}],
            } : null,
        },
        stepExecutionPort: {
            execute: async (step) => {
                clickCalls += 1;
                return {
                    stepId: step.id,
                    ok: false,
                    error: {code: 'ERR_NOT_FOUND', message: 'checkpoint target missing'},
                };
            },
        },
    });

    const paused = await controller.waitForPause();
    assert.equal(paused.reason, 'failure');
    if (paused.reason !== 'failure') {throw new Error('expected failure pause');}
    assert.equal(paused.failure.kind, 'step');
    if (paused.failure.kind !== 'step') {throw new Error('expected step failure');}
    assert.equal(paused.location.path, 'body.0');
    assert.equal(paused.failure.stepName, 'browser.click');
    assert.equal(paused.failure.classification, 'effect');
    assert.equal(paused.failure.code, 'ERR_NOT_FOUND');
    assert.equal(clickCalls, 1);

    controller.continue(paused.continuationId);
    await assert.rejects(run, (error: unknown) =>
        error instanceof DslRuntimeError && error.code === 'ERR_NOT_FOUND');
    assert.equal(clickCalls, 1);
});

test('failure descriptor distinguishes read failures from World effects', async () => {
    const controller = createDslDebugController({breakOnFailure: true});
    const run = runDsl({body: [{
        kind: 'let',
        name: 'rows',
        expr: {
            kind: 'query',
            op: 'entity',
            businessTag: 'orders.main',
            payload: 'table.currentRows',
        },
    }]}, {
        workspaceName: 'ws-1',
        deps,
        debugPort: controller.port,
        stepExecutionPort: {
            execute: async (step) => ({
                stepId: step.id,
                ok: false,
                error: {code: 'ERR_QUERY', message: 'query failed'},
            }),
        },
    });

    const paused = await controller.waitForPause();
    assert.equal(paused.reason, 'failure');
    if (paused.reason !== 'failure') {throw new Error('expected failure pause');}
    assert.equal(paused.failure.kind, 'step');
    if (paused.failure.kind !== 'step') {throw new Error('expected step failure');}
    assert.equal(paused.failure.stepName, 'browser.query');
    assert.equal(paused.failure.classification, 'read');

    controller.continue(paused.continuationId);
    await assert.rejects(run, (error: unknown) =>
        error instanceof DslRuntimeError && error.code === 'ERR_QUERY');
});
