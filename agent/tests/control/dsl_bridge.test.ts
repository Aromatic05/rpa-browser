import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runDslControl } from '../../src/control/dsl_bridge';
import type { ControlRouterContext } from '../../src/control/router';
import type { RunStepsDeps } from '../../src/runner/run_steps';
import type { StepUnion } from '../../src/runner/steps/types';

const createContext = (calls: Array<Record<string, unknown>>): ControlRouterContext => ({
    deps:
        ({
            runtime: {
                ensureActivePage: async () => ({
                    workspaceName: 'ws-dsl-control',
                    tabId: 'tab-dsl-control',
                    tabName: 'tk-dsl-control',
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
                            return {
                                stepId: step.id,
                                ok: true,
                                data: { filled: true },
                            };
                        },
                    }) as any,
            } as any,
        }) as RunStepsDeps,
});

test('dsl_bridge is wired through runDslSource', () => {
    const source = fs.readFileSync(
        path.resolve(process.cwd(), 'src/control/dsl_bridge.ts'),
        'utf8',
    );

    assert.equal(source.includes('runDslSource'), true);
});

test('dsl.run executes a simple dsl program', async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await runDslControl(
        {
            workspaceName: 'ws-dsl-control',
            source: `
let buyer = query entity.target "order.form" {
  kind: "form.field"
  fieldKey: "buyer"
}

fill buyer with input.user.name
            `,
            input: {
                user: {
                    name: 'alice',
                },
            },
        },
        createContext(calls),
    );

    assert.deepEqual((result as { diagnostics: unknown[] }).diagnostics, []);
    assert.equal(calls.length, 2);
    assert.deepEqual(
        calls.map((item) => item.name),
        ['browser.query', 'browser.fill'],
    );
});
