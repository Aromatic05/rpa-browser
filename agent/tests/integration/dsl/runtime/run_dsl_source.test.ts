import test from 'node:test';
import assert from 'node:assert/strict';
import { runDslSource } from '../../../../src/dsl/runtime';
import { DslValidationError } from '../../../../src/dsl/diagnostics/errors';
import type { DslCheckpointProvider } from '../../../../src/dsl/emit';
import type { RunStepsDeps } from '../../../../src/runner/run_steps';
import type { Checkpoint } from '../../../../src/runner/checkpoint';
import type { StepUnion } from '../../../../src/runner/steps/types';
import { completeRunStepsDeps } from '../../../helpers/run_steps_workspace';

const createDeps = (calls: Array<Record<string, unknown>>): RunStepsDeps =>
    completeRunStepsDeps({
        runtime: {
            ensureActivePage: async () => ({
                workspaceName: 'ws-dsl-source',
                tabName: 'tk-dsl-source',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.query': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args });
                        return {
                            stepId: step.id,
                            ok: true,
                            data: { kind: 'nodeId', nodeId: 'buyer-input' },
                        };
                    },
                    'browser.fill': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args });
                        return { stepId: step.id, ok: true, data: { filled: true } };
                    },
                }) as any,
        } as any,
    });

test('runDslSource executes parse normalize validate and run', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const checkpoint: Checkpoint = {
        id: 'ensure_logged_in',
        kind: 'procedure',
        output: {
            loginState: { ref: 'input.username' },
        },
    };
    const checkpointProvider: DslCheckpointProvider = {
        getCheckpoint: (id) => (id === checkpoint.id ? checkpoint : null),
    };

    const result = await runDslSource(
        `
use checkpoint "ensure_logged_in" with {
  username: input.username
}

let buyer = query entity.target "order.form" {
  kind: "form.field"
  fieldKey: "buyer"
}

for user in input.users:
  if user.enabled:
    fill buyer with user.name
        `,
        {
            workspaceName: 'ws-dsl-source',
            deps: createDeps(calls),
            checkpointProvider,
            input: {
                username: 'root',
                users: [
                    { name: 'alice', enabled: true },
                    { name: 'bob', enabled: false },
                ],
            },
        },
    );

    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.scope.output, {});
    assert.equal(calls.length, 2);
});

test('runDslSource throws DslValidationError with diagnostics', async () => {
    await assert.rejects(
        () =>
            runDslSource(
                `
click buyer
                `,
                {
                    workspaceName: 'ws-dsl-source',
                    deps: createDeps([]),
                    input: {},
                },
            ),
        (error: unknown) =>
            error instanceof DslValidationError &&
            error.diagnostics.length > 0 &&
            error.diagnostics[0].code === 'ERR_DSL_VAR_NOT_DEFINED',
    );
});

test('runDslSource unwraps production browser.query envelopes before using query values and targets', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await runDslSource(
        `
let buyer = query entity.target "order.form" {
  kind: "form.field"
  fieldKey: "buyer"
}
let rows = query table "order.list" currentRows
fill buyer with rows.0.name
        `,
        {
            workspaceName: 'ws-dsl-source',
            deps: completeRunStepsDeps({
                runtime: {
                    ensureActivePage: async () => ({
                        workspaceName: 'ws-dsl-source', tabName: 'tk-dsl-source', traceCtx: { cache: {} },
                    }),
                },
                config: {} as any,
                pluginHost: {
                    getExecutors: () => ({
                        'browser.query': async (step: StepUnion) => {
                            calls.push({ name: step.name, args: step.args });
                            return (step.args as { op: string }).op === 'entity.target'
                                ? { stepId: step.id, ok: true, data: { kind: 'nodeId', nodeId: 'buyer-input' } }
                                : { stepId: step.id, ok: true, data: { kind: 'value', value: [{ name: 'alice' }] } };
                        },
                        'browser.fill': async (step: StepUnion) => {
                            calls.push({ name: step.name, args: step.args });
                            return { stepId: step.id, ok: true, data: { filled: true } };
                        },
                    }) as any,
                } as any,
            }),
            input: {},
        },
    );

    assert.deepEqual(result.scope.vars.rows, [{ name: 'alice' }]);
    assert.deepEqual(calls.at(-1)?.args, { nodeId: 'buyer-input', value: 'alice' });
});
