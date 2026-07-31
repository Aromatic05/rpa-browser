import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDsl, parseDsl, runDsl } from '../../../../src/dsl';
import { DslRuntimeError } from '../../../../src/dsl/diagnostics/errors';
import type { DslCheckpointProvider } from '../../../../src/dsl/emit';
import type { RunStepsDeps } from '../../../../src/runner/run_steps';
import type { Checkpoint } from '../../../../src/runner/checkpoint';
import type { StepResolve, StepUnion } from '../../../../src/runner/steps/types';
import { completeRunStepsDeps } from '../../../helpers/run_steps_workspace';

type StubCall = {
    name: string;
    args: Record<string, unknown>;
    resolve?: StepResolve;
};

const createDeps = (calls: StubCall[]): RunStepsDeps =>
    completeRunStepsDeps({
        runtime: {
            ensureActivePage: async () => ({
                workspaceName: 'ws-dsl',
                tabName: 'tk-dsl',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.query': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown>, resolve: step.resolve });
                        return {
                            stepId: step.id,
                            ok: true,
                            data: { kind: 'nodeId', nodeId: 'buyer-input' },
                        };
                    },
                    'browser.fill': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown>, resolve: step.resolve });
                        return { stepId: step.id, ok: true, data: { filled: true } };
                    },
                    'browser.click': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown>, resolve: step.resolve });
                        return { stepId: step.id, ok: true, data: { clicked: true } };
                    },
                }) as any,
        } as any,
    });

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
        workspaceName: 'ws-dsl',
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
        buyer: { nodeId: 'buyer-input' },
    });
    assert.deepEqual(calls[1].args, {
        nodeId: 'buyer-input',
        value: 'alice',
    });
    assert.deepEqual(result.scope.output, {
        loginState: 'root',
    });
});

test('runDsl checkpoint applies resolve sidecar without retaining resolveId', async () => {
    const calls: StubCall[] = [];
    const checkpoint: Checkpoint = {
        id: 'repair_session',
        kind: 'procedure',
        content: [{
            type: 'act',
            step: {
                name: 'browser.click',
                args: {resolveId: 'dismiss-button'},
            },
        }],
    };
    const resolve: StepResolve = {hint: {raw: {selector: '#dismiss'}}};
    const checkpointProvider: DslCheckpointProvider = {
        getCheckpoint: (id) => id === checkpoint.id ? checkpoint : null,
        getCheckpointResolves: (id) => id === checkpoint.id ? {'dismiss-button': resolve} : null,
    };

    await runDsl(normalizeDsl(parseDsl('use checkpoint "repair_session"')), {
        workspaceName: 'ws-dsl',
        deps: createDeps(calls),
        checkpointProvider,
    });

    const click = calls.find((item) => item.name === 'browser.click');
    assert.ok(click);
    assert.equal('resolveId' in click.args, false);
    assert.deepEqual(click.resolve, resolve);
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
                    workspaceName: 'ws-dsl',
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
