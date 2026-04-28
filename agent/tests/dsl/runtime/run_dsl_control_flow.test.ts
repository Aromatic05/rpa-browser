import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDsl, parseDsl, runDsl } from '../../../src/dsl';
import { DslRuntimeError } from '../../../src/dsl/diagnostics/errors';
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
                workspaceId: 'ws-dsl-cf',
                tabId: 'tab-dsl-cf',
                tabToken: 'tk-dsl-cf',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.query': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        const args = step.args as { op?: string; businessTag?: string; query?: string; target?: { fieldKey?: string } };
                        if (args.op === 'entity') {
                            return {
                                stepId: step.id,
                                ok: true,
                                data: true,
                            };
                        }
                        return {
                            stepId: step.id,
                            ok: true,
                            data: { kind: 'nodeId', nodeId: `${args.target?.fieldKey || 'buyer'}-input` },
                        };
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

test('runDsl executes for body over input users and uses row.name', async () => {
    const calls: StubCall[] = [];
    const program = normalizeDsl(
        parseDsl(`
let buyer = query entity.target "order.form" {
  kind: "form.field"
  fieldKey: "buyer"
}

for user in input.users:
  fill buyer with user.name
        `),
    );

    const result = await runDsl(program, {
        workspaceId: 'ws-dsl-cf',
        deps: createDeps(calls),
        input: {
            users: [{ name: 'alice' }, { name: 'bob' }],
        },
    });

    assert.deepEqual(
        calls.filter((item) => item.name === 'browser.fill').map((item) => item.args.value),
        ['alice', 'bob'],
    );
    assert.deepEqual(result.scope.vars.user, { name: 'bob' });
});

test('runDsl throws when for iterable is not an array', async () => {
    await assert.rejects(
        () =>
            runDsl(
                normalizeDsl(
                    parseDsl(`
for user in input.user:
  click submit
                    `),
                ),
                {
                    workspaceId: 'ws-dsl-cf',
                    deps: createDeps([]),
                    input: { user: { name: 'alice' } },
                },
            ),
        (error: unknown) => error instanceof DslRuntimeError && error.code === 'ERR_DSL_BAD_ITERABLE',
    );
});

test('runDsl executes if then and else branches dynamically', async () => {
    const trueCalls: StubCall[] = [];
    const falseCalls: StubCall[] = [];
    const program = normalizeDsl(
        parseDsl(`
if input.enabled:
  click input.submit
else:
  click input.cancel
        `),
    );

    await runDsl(program, {
        workspaceId: 'ws-dsl-cf',
        deps: createDeps(trueCalls),
        input: { enabled: true, submit: 'submit-btn', cancel: 'cancel-btn' },
    });
    await runDsl(program, {
        workspaceId: 'ws-dsl-cf',
        deps: createDeps(falseCalls),
        input: { enabled: false, submit: 'submit-btn', cancel: 'cancel-btn' },
    });

    assert.deepEqual(trueCalls[0].args, { nodeId: 'submit-btn' });
    assert.deepEqual(falseCalls[0].args, { nodeId: 'cancel-btn' });
});

test('runDsl can branch on query results and handle nested for/if', async () => {
    const calls: StubCall[] = [];
    const program = normalizeDsl({
        body: [
            {
                kind: 'let',
                name: 'buyer',
                expr: {
                    kind: 'query',
                    op: 'entity.target',
                    businessTag: 'order.form',
                    payload: { kind: 'form.field', fieldKey: 'buyer' },
                },
            },
            {
                kind: 'let',
                name: 'enabled',
                expr: {
                    kind: 'query',
                    op: 'entity',
                    businessTag: 'order.form',
                    payload: 'form.fields',
                },
            },
            {
                kind: 'for',
                item: 'user',
                iterable: { kind: 'ref', ref: 'input.users' },
                body: [
                    {
                        kind: 'if',
                        condition: { kind: 'ref', ref: 'user.enabled' },
                        then: [
                            {
                                kind: 'if',
                                condition: { kind: 'ref', ref: 'enabled' },
                                then: [
                                    {
                                        kind: 'act',
                                        action: 'fill',
                                        target: { kind: 'ref', ref: 'buyer' },
                                        value: { kind: 'ref', ref: 'user.name' },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    });

    await runDsl(program, {
        workspaceId: 'ws-dsl-cf',
        deps: createDeps(calls),
        input: {
            users: [
                { name: 'alice', enabled: true },
                { name: 'bob', enabled: false },
                { name: 'cara', enabled: true },
            ],
        },
    });

    assert.deepEqual(
        calls.filter((item) => item.name === 'browser.fill').map((item) => item.args.value),
        ['alice', 'cara'],
    );
});
