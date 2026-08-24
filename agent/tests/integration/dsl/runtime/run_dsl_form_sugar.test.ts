import test from 'node:test';
import assert from 'node:assert/strict';
import { runDslSource } from '../../../../src/automation/dsl/runtime';
import type { RunStepsDeps } from '../../../../src/automation/runner/run_steps';
import type { StepUnion } from '../../../../src/automation/runner/steps/types';
import { completeRunStepsDeps } from '../../../helpers/run_steps_workspace';

type StubCall = {
    name: string;
    args: Record<string, unknown>;
};

const createDeps = (calls: StubCall[]): RunStepsDeps =>
    completeRunStepsDeps({
        runtime: {
            ensureActivePage: async () => ({
                workspaceName: 'ws-dsl-form',
                tabName: 'tk-dsl-form',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.query': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        const targetKind = (step.args as any).target?.kind;
                        if (targetKind === 'form.field') {
                            return { stepId: step.id, ok: true, data: { kind: 'nodeId', nodeId: 'buyer-input' } };
                        }
                        if (targetKind === 'table.filter') {
                            return { stepId: step.id, ok: true, data: { kind: 'nodeId', nodeId: 'order-filter' } };
                        }
                        if (targetKind === 'table.module_action') {
                            return { stepId: step.id, ok: true, data: { kind: 'nodeId', nodeId: 'table-search' } };
                        }
                        return { stepId: step.id, ok: true, data: { kind: 'nodeId', nodeId: 'submit-btn' } };
                    },
                    'browser.fill': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        return { stepId: step.id, ok: true, data: { filled: true } };
                    },
                    'browser.click': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        return { stepId: step.id, ok: true, data: { clicked: true } };
                    },
                }) as any,
        } as any,
    });

test('runDslSource executes fill form sugar via query then fill', async () => {
    const calls: StubCall[] = [];
    await runDslSource(
        `
fill form "order.form" field "buyer" with input.user.name
        `,
        {
            workspaceName: 'ws-dsl-form',
            deps: createDeps(calls),
            input: {
                user: { name: 'alice' },
            },
        },
    );

    assert.deepEqual(calls.map((item) => item.name), ['browser.query', 'browser.fill']);
    assert.deepEqual(calls[0].args, {
        op: 'entity.target',
        businessTag: 'order.form',
        target: { kind: 'form.field', fieldKey: 'buyer' },
    });
    assert.deepEqual(calls[1].args, {
        nodeId: 'buyer-input',
        value: 'alice',
    });
});

test('runDslSource executes click form sugar via query then click', async () => {
    const calls: StubCall[] = [];
    await runDslSource(
        `
click form "order.form" action "submit"
        `,
        {
            workspaceName: 'ws-dsl-form',
            deps: createDeps(calls),
            input: {},
        },
    );

    assert.deepEqual(calls.map((item) => item.name), ['browser.query', 'browser.click']);
    assert.deepEqual(calls[0].args, {
        op: 'entity.target',
        businessTag: 'order.form',
        target: { kind: 'form.action', actionIntent: 'submit' },
    });
    assert.deepEqual(calls[1].args, {
        nodeId: 'submit-btn',
    });
});


test('runDslSource executes table filter and module action sugar', async () => {
    const calls: StubCall[] = [];
    await runDslSource(
        `
fill table "orders.table" filter "订单编号" with input.orderNo
click table "orders.table" action "search"
        `,
        {
            workspaceName: 'ws-dsl-form',
            deps: createDeps(calls),
            input: {orderNo: 'U2021062310545'},
        },
    );

    assert.deepEqual(calls.map((item) => item.name), [
        'browser.query', 'browser.fill', 'browser.query', 'browser.click',
    ]);
    assert.deepEqual(calls[0].args, {
        op: 'entity.target',
        businessTag: 'orders.table',
        target: {kind: 'table.filter', fieldKey: '订单编号'},
    });
    assert.deepEqual(calls[1].args, {
        nodeId: 'order-filter',
        value: 'U2021062310545',
    });
    assert.deepEqual(calls[2].args, {
        op: 'entity.target',
        businessTag: 'orders.table',
        target: {kind: 'table.module_action', actionIntent: 'search'},
    });
    assert.deepEqual(calls[3].args, {nodeId: 'table-search'});
});
