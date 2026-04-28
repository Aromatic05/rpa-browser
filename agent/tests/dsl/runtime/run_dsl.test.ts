import test from 'node:test';
import assert from 'node:assert/strict';
import { runDsl, parseDsl, normalizeDsl } from '../../../src/dsl';
import { setCheckpoints } from '../../../src/runner/checkpoint';
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
                        const args = step.args as { op?: string; target?: { kind?: string } };
                        if (args.op === 'entity.target' && args.target?.kind === 'form.field') {
                            return {
                                stepId: step.id,
                                ok: true,
                                data: { kind: 'nodeId', nodeId: 'buyer-input' },
                            };
                        }
                        return {
                            stepId: step.id,
                            ok: true,
                            data: { kind: 'nodeId', nodeId: 'submit-btn' },
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

test('runDsl executes sequential query fill and checkpoint calls', async () => {
    const checkpoints: Checkpoint[] = [
        {
            id: 'ensure_logged_in',
            output: {
                loginState: { ref: 'input.username' },
            },
        },
    ];
    setCheckpoints(checkpoints);

    const calls: StubCall[] = [];
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
        input: {
            username: 'root',
            user: { name: 'alice' },
        },
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, 'browser.query');
    assert.equal(calls[1].name, 'browser.fill');
    assert.deepEqual(calls[1].args, {
        nodeId: 'buyer-input',
        value: 'alice',
    });
    assert.deepEqual(result.scope.output, {
        loginState: 'root',
    });
});

test('runDsl throws UnsupportedError for reserved control flow nodes', async () => {
    await assert.rejects(
        () =>
            runDsl(
                {
                    body: [
                        {
                            kind: 'if',
                            condition: { kind: 'ref', ref: 'input.enabled' },
                            then: [],
                        },
                    ],
                },
                {
                    workspaceId: 'ws-dsl',
                    deps: createDeps([]),
                    input: {},
                },
            ),
        /not implemented yet/,
    );
});
