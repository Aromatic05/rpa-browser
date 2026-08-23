import test from 'node:test';
import assert from 'node:assert/strict';
import {runDsl} from '../../../../src/dsl/runtime/run_dsl';
import {DslRuntimeError} from '../../../../src/dsl/diagnostics/errors';
import type {DslAfterEffectEvent, DslDebugPort} from '../../../../src/dsl/debug/contracts';
import type {RunStepsDeps} from '../../../../src/runner/run_steps';

const deps = {} as RunStepsDeps;
const debugPort = (events: DslAfterEffectEvent[]): DslDebugPort => ({
    beforeStatement: () => {},
    afterEffect: (event) => {events.push(event);},
});

test('afterEffect reports only executed World effects and excludes read steps', async () => {
    const events: DslAfterEffectEvent[] = [];
    await runDsl({body: [
        {kind: 'act', action: 'snapshot'},
        {kind: 'act', action: 'click', target: {kind: 'ref', ref: 'input.target'}},
    ]}, {
        workspaceName: 'ws-1',
        deps,
        input: {target: {nodeId: 'submit'}},
        debugPort: debugPort(events),
        stepExecutionPort: {
            execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
        },
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].location.path, 'body.1');
    assert.equal(events[0].effect.stepName, 'browser.click');
    assert.deepEqual(events[0].effect.args, {nodeId: 'submit'});
    assert.deepEqual(events[0].outcome, {status: 'succeeded'});
});

test('failed effect result is emitted before the failure notification', async () => {
    const order: string[] = [];
    const run = runDsl({body: [{
        kind: 'act',
        action: 'click',
        target: {kind: 'ref', ref: 'input.target'},
    }]}, {
        workspaceName: 'ws-1',
        deps,
        input: {target: {nodeId: 'missing'}},
        debugPort: {
            beforeStatement: () => {},
            afterEffect: (event) => {
                order.push(`effect:${event.outcome.status}`);
                assert.deepEqual(event.outcome, {
                    status: 'failed',
                    error: {code: 'ERR_NOT_FOUND', message: 'missing', details: {matches: 0}},
                });
            },
            onFailure: () => {order.push('failure');},
        },
        stepExecutionPort: {
            execute: async (step) => ({
                stepId: step.id,
                ok: false,
                error: {code: 'ERR_NOT_FOUND', message: 'missing', details: {matches: 0}},
            }),
        },
    });

    await assert.rejects(run, DslRuntimeError);
    assert.deepEqual(order, ['effect:failed', 'failure']);
});

test('legacy checkpoint action effects emit the same afterEffect lifecycle', async () => {
    const events: DslAfterEffectEvent[] = [];
    await runDsl({body: [{kind: 'checkpoint', id: 'repair'}]}, {
        workspaceName: 'ws-1',
        deps,
        debugPort: debugPort(events),
        checkpointProvider: {
            getCheckpoint: (id) => id === 'repair' ? {
                id: 'repair',
                kind: 'procedure',
                content: [{type: 'act', step: {name: 'browser.click', args: {selector: '#dismiss'}}}],
            } : null,
        },
        stepExecutionPort: {
            execute: async (step) => ({stepId: step.id, ok: true, data: {clicked: true}}),
        },
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].location.path, 'body.0');
    assert.equal(events[0].effect.stepName, 'browser.click');
    assert.deepEqual(events[0].outcome, {status: 'succeeded'});
});
