import test from 'node:test';
import assert from 'node:assert/strict';
import { createDslTaskRunner } from '../../../../src/dsl/runtime';
import {
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    runSteps,
    type Checkpoint,
    type RunStepsDeps,
} from '../../../../src/runner/run_steps';
import type { StepUnion } from '../../../../src/runner/steps/types';
import { completeRunStepsDeps } from '../../../helpers/run_steps_workspace';

type StubCall = {
    name: string;
    args: Record<string, unknown>;
};

const createDeps = (calls: StubCall[], opts?: { failFill?: boolean; delayMs?: number }): RunStepsDeps =>
    completeRunStepsDeps({
        runtime: {
            ensureActivePage: async () => ({
                workspaceName: 'ws-dsl-task',
                tabName: 'tk-dsl-task',
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
    }, { workspaceName: 'ws-dsl-task' });

test('task_runner runs multiple steps through one runId and preserves queue order', async () => {
    const calls: StubCall[] = [];
    const runner = createDslTaskRunner({
        workspaceName: 'ws-dsl-task',
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

test('task_runner matches results by stepId across consecutive steps', async () => {
    const calls: StubCall[] = [];
    const runner = createDslTaskRunner({
        workspaceName: 'ws-dsl-task',
        deps: createDeps(calls, { delayMs: 1 }),
    });

    await runner.start();
    const first = await runner.runStep({
        id: 'step-query-a',
        name: 'browser.query',
        args: {
            op: 'entity.target',
            businessTag: 'order.form',
            target: { kind: 'form.field', fieldKey: 'buyer' },
        },
    } as StepUnion);
    const second = await runner.runStep({
        id: 'step-query-b',
        name: 'browser.query',
        args: {
            op: 'entity.target',
            businessTag: 'order.form',
            target: { kind: 'form.field', fieldKey: 'seller' },
        },
    } as StepUnion);
    await runner.close();

    assert.equal(first.stepId, 'step-query-a');
    assert.equal(second.stepId, 'step-query-b');
    assert.equal(calls.length, 2);
});

test('task_runner returns failed step results without swallowing errors', async () => {
    const runner = createDslTaskRunner({
        workspaceName: 'ws-dsl-task',
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
        workspaceName: 'ws-dsl-task',
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

test('task_runner cancel and close terminalize a suspended runner', async () => {
    const runner = createDslTaskRunner({
        workspaceName: 'ws-dsl-task',
        deps: createDeps([]),
    });

    await runner.start();
    await runner.suspend();
    await Promise.race([
        runner.cancel(),
        delay(100).then(() => { throw new Error('cancel hung while suspended'); }),
    ]);
    await runner.close();
});

test('task_runner converts an executor throw into a failed terminal step result', async () => {
    const runner = createDslTaskRunner({
        workspaceName: 'ws-dsl-task',
        deps: completeRunStepsDeps({
            runtime: {
                ensureActivePage: async () => ({
                    workspaceName: 'ws-dsl-task', tabName: 'tk-dsl-task', traceCtx: { cache: {} },
                }),
            },
            config: {} as any,
            pluginHost: {
                getExecutors: () => ({
                    'browser.query': async () => { throw new Error('executor exploded'); },
                }) as any,
            } as any,
        }, { workspaceName: 'ws-dsl-task' }),
    });

    const result = await runner.runStep({
        id: 'step-query-throw',
        name: 'browser.query',
        args: { op: 'entity', businessTag: 'order.list', query: 'table.currentRows' },
    } as StepUnion);
    await runner.close();

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_RUNNER_UNEXPECTED');
    assert.match(result.error?.message || '', /executor exploded/);
});

test('runSteps publishes a failed terminal checkpoint when an executor throws', async () => {
    const step = {
        id: 'step-query-terminal',
        name: 'browser.query',
        args: { op: 'entity', businessTag: 'order.list', query: 'table.currentRows' },
    } as StepUnion;
    const queue = createStepsQueue([step], { closed: true });
    const pipe = createResultPipe();
    const checkpoints: Checkpoint[] = [];
    const checkpoint = await runSteps({
        runId: 'run-terminal',
        workspaceName: 'ws-dsl-task',
        stepsQueue: queue,
        resultPipe: pipe,
        signalChannel: createSignalChannel(),
        onCheckpoint: async (value) => { checkpoints.push(value); },
    }, completeRunStepsDeps({
        config: {} as any,
        pluginHost: {
            getExecutors: () => ({
                'browser.query': async () => { throw new Error('executor exploded'); },
            }) as any,
        } as any,
    }, { workspaceName: 'ws-dsl-task' }));

    assert.equal(checkpoint.status, 'failed');
    assert.equal(checkpoints.at(-1)?.status, 'failed');
    assert.equal(pipe.closed, true);
    assert.equal(pipe.items.at(-1)?.error?.code, 'ERR_RUNNER_UNEXPECTED');
});

const delay = async (ms: number): Promise<void> =>
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
