import test from 'node:test';
import assert from 'node:assert/strict';
import {runDsl} from '../../../../src/program/dsl/runtime/run_dsl';
import {DslRuntimeError} from '../../../../src/program/dsl/diagnostics/errors';
import type {DslAfterEffectEvent, DslDebugPort} from '../../../../src/program/dsl/debug/contracts';
import type {RunStepsDeps} from '../../../../src/runner/run_steps';

const deps = {} as RunStepsDeps;
const debugPort = (events: DslAfterEffectEvent[]): DslDebugPort => ({
    beforeStatement: () => undefined,
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
    assert.deepEqual(events[0].effect.semantics, {reversibility: 'unknown'});
    assert.deepEqual(events[0].outcome, {status: 'succeeded'});
});

test('linked entity effects preserve explicit business semantics through execution lifecycle', async () => {
    const events: DslAfterEffectEvent[] = [];
    await runDsl({body: [{
        kind: 'linked_entity_act',
        action: 'click',
        targetQuery: {
            kind: 'query',
            op: 'entity.target',
            businessTag: 'order.form',
            profileName: 'order-page',
            payload: {kind: 'form.action', actionIntent: 'submit'},
        },
        effect: {
            reversibility: 'irreversible',
            source: {
                kind: 'entity_rules',
                profileName: 'order-page',
                entityKey: 'orderForm',
                memberKind: 'action',
                member: 'submit',
            },
        },
    }]}, {
        workspaceName: 'ws-1',
        deps,
        debugPort: debugPort(events),
        stepExecutionPort: {
            execute: async (step) => step.name === 'browser.query'
                ? {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'submit'}}
                : {stepId: step.id, ok: true, data: {clicked: true}},
        },
    });

    assert.equal(events.length, 1);
    assert.deepEqual(events[0].effect.semantics, {
        reversibility: 'irreversible',
        source: {
            kind: 'entity_rules',
            profileName: 'order-page',
            entityKey: 'orderForm',
            memberKind: 'action',
            member: 'submit',
        },
    });
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
            beforeStatement: () => undefined,
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
