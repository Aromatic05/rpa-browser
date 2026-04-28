import test from 'node:test';
import assert from 'node:assert/strict';
import { createDslTaskRunner } from '../../../src/dsl/runtime';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { StepUnion } from '../../../src/runner/steps/types';

type StubCall = {
    name: string;
    args: Record<string, unknown>;
};

const createDeps = (calls: StubCall[], opts?: { failFill?: boolean; delayMs?: number }): RunStepsDeps =>
    ({
        runtime: {
            ensureActivePage: async () => ({
                workspaceId: 'ws-dsl-task',
                tabId: 'tab-dsl-task',
                tabToken: 'tk-dsl-task',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.query': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        await delay(opts?.delayMs ?? 0);
                        return {
                            stepId: step.id,
                            ok: true,
                            data: { kind: 'nodeId', nodeId: 'buyer-input' },
                        };
                    },
                    'browser.fill': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        await delay(opts?.delayMs ?? 0);
                        if (opts?.failFill) {
                            return {
                                stepId: step.id,
                                ok: false,
                                error: {
                                    code: 'ERR_FILL_FAILED',
                                    message: 'fill failed',
                                },
                            };
                        }
                        return {
                            stepId: step.id,
                            ok: true,
                            data: { filled: true },
                        };
                    },
                }) as any,
        } as any,
    }) as RunStepsDeps;

test('task_runner runs multiple steps through one runId and preserves queue order', async () => {
    const calls: StubCall[] = [];
    const runner = createDslTaskRunner({
        workspaceId: 'ws-dsl-task',
        deps: createDeps(calls, { delayMs: 5 }),
    });

    const started = await runner.start();
    const queryResult = await runner.runStep({
        id: 'step-query',
        name: 'browser.query',
        args: {
            op: 'entity.target',
            businessTag: 'order.form',
            target: { kind: 'form.field', fieldKey: 'buyer' },
        },
    } as StepUnion);
    const fillResult = await runner.runStep({
        id: 'step-fill',
        name: 'browser.fill',
        args: {
            nodeId: 'buyer-input',
            value: 'alice',
        },
    } as StepUnion);
    await runner.close();

    assert.equal(queryResult.runId, started.runId);
    assert.equal(fillResult.runId, started.runId);
    assert.equal(calls.length, 2);
    assert.deepEqual(
        calls.map((item) => item.name),
        ['browser.query', 'browser.fill'],
    );
    assert.equal(queryResult.stepId, 'step-query');
    assert.equal(fillResult.stepId, 'step-fill');
});

test('task_runner returns failed step results without swallowing errors', async () => {
    const runner = createDslTaskRunner({
        workspaceId: 'ws-dsl-task',
        deps: createDeps([], { failFill: true }),
    });

    await runner.start();
    const result = await runner.runStep({
        id: 'step-fill-fail',
        name: 'browser.fill',
        args: {
            nodeId: 'buyer-input',
            value: 'alice',
        },
    } as StepUnion);
    await runner.close();

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_FILL_FAILED');
});

test('task_runner close waits for runSteps completion', async () => {
    const calls: StubCall[] = [];
    const runner = createDslTaskRunner({
        workspaceId: 'ws-dsl-task',
        deps: createDeps(calls),
    });

    await runner.start();
    const result = await runner.runStep({
        id: 'step-query-close',
        name: 'browser.query',
        args: {
            op: 'entity.target',
            businessTag: 'order.form',
            target: { kind: 'form.field', fieldKey: 'buyer' },
        },
    } as StepUnion);
    await runner.close();

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
});

const delay = async (ms: number): Promise<void> =>
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
