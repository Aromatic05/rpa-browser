import test from 'node:test';
import assert from 'node:assert/strict';
import {
    runDsl,
    runDslSource,
    type ExpectedWorldPrecondition,
    type StepExecutionPort,
} from '../../../../src/automation/dsl/runtime';
import {normalizeDsl, parseDsl} from '../../../../src/automation/dsl';
import type {DslEntityRulesResolver} from '../../../../src/automation/dsl/link';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps';

type PortCall = {
    name: string;
    precondition?: ExpectedWorldPrecondition;
};

const createPort = (calls: PortCall[]): StepExecutionPort => ({
    execute: async (step, precondition) => {
        calls.push({name: step.name, precondition});
        if (step.name === 'browser.query') {
            return {
                stepId: step.id,
                ok: true,
                data: {
                    kind: 'nodeId',
                    nodeId: 'buyer-input',
                    meta: {pageEpoch: 'epoch-1', captureRevision: 7, controlKind: 'custom_select'},
                },
            };
        }
        return {stepId: step.id, ok: true, data: {}};
    },
});

const entityRulesResolver = (): DslEntityRulesResolver => ({
    resolveProfile: (profileName) => profileName === 'orders-form'
        ? {
            profile: {
                profileName: 'orders-form',
                entities: [{
                    entityKey: 'orderForm',
                    businessTag: 'order.form.main',
                    kind: 'form',
                    fields: [],
                    actions: [{actionIntent: 'submit', targetKind: 'form.action'}],
                    columns: [],
                    rowActions: [],
                    supportedQueries: ['form.fields', 'form.actions'],
                }],
            },
            diagnostics: [],
        }
        : {profile: null, diagnostics: []},
});

test('a query let followed by an ordinary act forwards the observed world revision as the effect precondition', async () => {
    const calls: PortCall[] = [];
    const program = normalizeDsl(parseDsl(`
        let field = query entity.target "order.form" {
          kind: "form.field"
          fieldKey: "buyer"
        }
        fill field with input.value
    `));
    await runDsl(program, {
        workspaceName: 'ws-cas',
        deps: {} as RunStepsDeps,
        input: {value: 'alice'},
        stepExecutionPort: createPort(calls),
    });

    assert.deepEqual(
        calls.map((call) => call.name),
        ['browser.query', 'browser.fill'],
    );
    assert.equal(calls[0].precondition, undefined, 'the query read carries no effect precondition');
    assert.deepEqual(calls[1].precondition, {
        kind: 'expected-world',
        revision: {pageEpoch: 'epoch-1', captureRevision: 7},
    });
});

test('an ordinary act on a Program-input target envelope forwards the envelope revision as the effect precondition', async () => {
    const calls: PortCall[] = [];
    const program = normalizeDsl(parseDsl('fill input.target with input.value'));
    await runDsl(program, {
        workspaceName: 'ws-cas',
        deps: {} as RunStepsDeps,
        input: {
            target: {
                nodeId: 'buyer-input',
                resolve: {hint: {target: {nodeId: 'buyer-input'}}},
                meta: {pageEpoch: 'epoch-9', captureRevision: 2},
            },
            value: 'alice',
        },
        stepExecutionPort: createPort(calls),
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].precondition, {
        kind: 'expected-world',
        revision: {pageEpoch: 'epoch-9', captureRevision: 2},
    });
});

test('a direct scalar nodeId target carries no effect precondition', async () => {
    const calls: PortCall[] = [];
    const program = normalizeDsl(parseDsl('fill input.target with input.value'));
    await runDsl(program, {
        workspaceName: 'ws-cas',
        deps: {} as RunStepsDeps,
        input: {target: 'buyer-input', value: 'alice'},
        stepExecutionPort: createPort(calls),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].precondition, undefined);
});

test('a linked_entity_act carries logicalTarget.resolvedAt as the effect precondition', async () => {
    const calls: PortCall[] = [];
    await runDslSource(`
        use entity_rules "orders-form" as orders
        click orders.orderForm.submit
    `, {
        workspaceName: 'ws-cas',
        deps: {} as RunStepsDeps,
        input: {},
        entityRulesResolver: entityRulesResolver(),
        stepExecutionPort: createPort(calls),
    });

    assert.deepEqual(
        calls.map((call) => call.name),
        ['browser.query', 'browser.click'],
    );
    assert.equal(calls[0].precondition, undefined);
    assert.deepEqual(calls[1].precondition, {
        kind: 'expected-world',
        revision: {pageEpoch: 'epoch-1', captureRevision: 7},
    });
});