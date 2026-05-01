import test from 'node:test';
import assert from 'node:assert/strict';
import { runDslSource } from '../../../src/dsl/runtime';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { StepUnion } from '../../../src/runner/steps/types';

type StubCall = {
    name: string;
    args: Record<string, unknown>;
};

const createDeps = (calls: StubCall[]): RunStepsDeps =>
    ({
        runtime: {
            ensureActivePage: async () => ({
                workspaceName: 'ws-dsl-form',
                tabId: 'tab-dsl-form',
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
                        if ((step.args as any).target?.kind === 'form.field') {
                            return { stepId: step.id, ok: true, data: { kind: 'nodeId', nodeId: 'buyer-input' } };
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
    }) as RunStepsDeps;

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
