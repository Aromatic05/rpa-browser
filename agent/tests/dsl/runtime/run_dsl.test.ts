import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDsl, parseDsl, runDsl } from '../../../src/dsl';
import { DslRuntimeError } from '../../../src/dsl/diagnostics/errors';
import type { DslCheckpointProvider } from '../../../src/dsl/emit';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { Checkpoint } from '../../../src/runner/checkpoint';
import type { StepUnion } from '../../../src/runner/steps/types';

type StubCall = {
    name: string;
    args: Record<string, unknown>;
};

const createDeps = (calls: StubCall[]): RunStepsDeps =>
    ({
        runtime: {
            ensureActivePage: async () => ({
                workspaceId: 'ws-dsl',
                tabId: 'tab-dsl',
                tabToken: 'tk-dsl',
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
                            data: { kind: 'nodeId', nodeId: 'buyer-input' },
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

test('runDsl executes query then fill through one task stream and writes vars/output', async () => {
    const calls: StubCall[] = [];
    const checkpoint: Checkpoint = {
        id: 'ensure_logged_in',
        output: {
            loginState: { ref: 'input.username' },
        },
    };
    const checkpointProvider: DslCheckpointProvider = {
        getCheckpoint: (id) => (id === checkpoint.id ? checkpoint : null),
    };

    const program = normalizeDsl(
        parseDsl(`
            use checkpoint "ensure_logged_in" with {
              username: input.username
            }

            let buyer = query entity.target "order.form" {
              kind: "form.field"
              fieldKey: "buyer"
            }

            fill buyer with input.user.name
        `),
    );

    const result = await runDsl(program, {
        workspaceId: 'ws-dsl',
        deps: createDeps(calls),
        checkpointProvider,
        input: {
            username: 'root',
            user: { name: 'alice' },
        },
    });

    assert.deepEqual(
        calls.map((item) => item.name),
        ['browser.query', 'browser.fill'],
    );
    assert.deepEqual(result.scope.vars, {
        buyer: { kind: 'nodeId', nodeId: 'buyer-input' },
    });
    assert.deepEqual(calls[1].args, {
        nodeId: 'buyer-input',
        value: 'alice',
    });
    assert.deepEqual(result.scope.output, {
        loginState: 'root',
    });
});

test('runDsl wraps failed act steps as DslRuntimeError', async () => {
    const deps = createDeps([]);
    deps.pluginHost = {
        getExecutors: () =>
            ({
                'browser.query': async (step: StepUnion) => ({
                    stepId: step.id,
                    ok: true,
                    data: { kind: 'nodeId', nodeId: 'buyer-input' },
                }),
                'browser.fill': async (step: StepUnion) => ({
                    stepId: step.id,
                    ok: false,
                    error: {
                        code: 'ERR_FILL_FAILED',
                        message: 'fill failed',
                    },
                }),
            }) as any,
    } as any;

    await assert.rejects(
        () =>
            runDsl(
                normalizeDsl(
                    parseDsl(`
                        let buyer = query entity.target "order.form" {
                          kind: "form.field"
                          fieldKey: "buyer"
                        }

                        fill buyer with input.user.name
                    `),
                ),
                {
                    workspaceId: 'ws-dsl',
                    deps,
                    input: { user: { name: 'alice' } },
                },
            ),
        (error: unknown) =>
            error instanceof DslRuntimeError &&
            error.code === 'ERR_FILL_FAILED' &&
            error.message === 'fill failed',
    );
});
