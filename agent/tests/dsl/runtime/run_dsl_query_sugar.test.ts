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
                workspaceId: 'ws-dsl-query-sugar',
                tabId: 'tab-dsl-query-sugar',
                tabToken: 'tk-dsl-query-sugar',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.query': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        return {
                            stepId: step.id,
                            ok: true,
                            data: [{ id: 'row-1', enabled: true, name: 'alice' }],
                        };
                    },
                }) as any,
        } as any,
    }) as RunStepsDeps;

test('runDslSource executes query table sugar and writes vars', async () => {
    const calls: StubCall[] = [];
    const result = await runDslSource(
        `
let rows = query table "order.list" currentRows
        `,
        {
            workspaceId: 'ws-dsl-query-sugar',
            deps: createDeps(calls),
            input: {},
        },
    );

    assert.deepEqual(calls.map((item) => item.name), ['browser.query']);
    assert.deepEqual(calls[0].args, {
        op: 'entity',
        businessTag: 'order.list',
        query: 'table.currentRows',
    });
    assert.deepEqual(result.scope.vars.rows, [{ id: 'row-1', enabled: true, name: 'alice' }]);
});

test('runDslSource keeps hasNextPage query sugar as-is', async () => {
    const calls: StubCall[] = [];
    await runDslSource(
        `
let hasNext = query table "order.list" hasNextPage
        `,
        {
            workspaceId: 'ws-dsl-query-sugar',
            deps: createDeps(calls),
            input: {},
        },
    );

    assert.deepEqual(calls.map((item) => item.name), ['browser.query']);
    assert.deepEqual(calls[0].args, {
        op: 'entity',
        businessTag: 'order.list',
        query: 'table.hasNextPage',
    });
});
