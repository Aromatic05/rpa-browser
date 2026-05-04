import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDsl, parseDsl, runDsl } from '../../../src/dsl';
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
                workspaceName: 'ws-dsl',
                tabName: 'tab-dsl',
                tabName: 'tk-dsl',
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
                    'browser.type': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        return { stepId: step.id, ok: true, data: { typed: true } };
                    },
                    'browser.select_option': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        return { stepId: step.id, ok: true, data: { selected: true } };
                    },
                    'browser.snapshot': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        return { stepId: step.id, ok: true, data: { snapshot: true } };
                    },
                }) as any,
        } as any,
    }) as RunStepsDeps;

test('runDsl executes type/select/snapshot as browser steps', async () => {
    const calls: StubCall[] = [];
    const program = normalizeDsl(
        parseDsl(`
            let buyer = query entity.target "order.form" {
              kind: "form.field"
              fieldKey: "buyer"
            }

            type buyer with input.text
            select buyer with input.value
            snapshot
        `),
    );

    await runDsl(program, {
        workspaceName: 'ws-dsl',
        deps: createDeps(calls),
        input: { text: 'alice', value: 'approved' },
    });

    assert.deepEqual(
        calls.map((item) => item.name),
        ['browser.query', 'browser.type', 'browser.select_option', 'browser.snapshot'],
    );
    assert.deepEqual(calls[1].args, { nodeId: 'buyer-input', text: 'alice' });
    assert.deepEqual(calls[2].args, { nodeId: 'buyer-input', values: ['approved'] });
    assert.deepEqual(calls[3].args, {});
});

test('runDsl wait delays execution and does not emit a step', async () => {
    const calls: StubCall[] = [];
    const program = normalizeDsl(
        parseDsl(`
            wait 60
            snapshot
        `),
    );

    const startedAt = Date.now();
    await runDsl(program, {
        workspaceName: 'ws-dsl',
        deps: createDeps(calls),
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'browser.snapshot');
    assert.equal(elapsed >= 40, true);
});
