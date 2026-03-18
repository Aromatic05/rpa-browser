import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    enqueueSteps,
    readResultPipe,
    runSteps,
    sendSignal,
    setRunStepsDeps,
} from '../../src/runner/run_steps';
import { loadRunnerConfig } from '../../src/config/loader';
import type { StepUnion } from '../../src/runner/steps/types';

const withFakeExecutors = () => {
    setRunStepsDeps({
        runtime: {} as any,
        config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.click': async (step: StepUnion) => ({ stepId: step.id, ok: true, data: { clicked: true } }),
                    'browser.goto': async (step: StepUnion) => ({ stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } }),
                }) as any,
        } as any,
    });
};

test('shared queue + result pipe', async () => {
    withFakeExecutors();
    const runId = 'run-1';
    const queue = createStepsQueue();
    const pipe = createResultPipe();
    const signals = createSignalChannel();

    const loop = runSteps({ runId, workspaceId: 'ws-1', stepsQueue: queue, resultPipe: pipe, signalChannel: signals, stopOnError: true });

    enqueueSteps(queue, [
        { id: 's1', name: 'browser.click', args: { target: { selector: '#a' } } } as StepUnion,
        { id: 's2', name: 'browser.click', args: { target: { selector: '#b' } } } as StepUnion,
    ]);
    closeStepsQueue(queue);

    const cp = await loop;
    const polled = readResultPipe(pipe);

    assert.equal(cp.status, 'completed');
    assert.equal(cp.cursor, 2);
    assert.equal(polled.items.length, 2);
    assert.equal((polled.items[0].data as any)?.clicked, true);
});

test('abort signal stops run loop', async () => {
    withFakeExecutors();
    const runId = 'run-2';
    const queue = createStepsQueue();
    const pipe = createResultPipe();
    const signals = createSignalChannel();

    const loop = runSteps({ runId, workspaceId: 'ws-1', stepsQueue: queue, resultPipe: pipe, signalChannel: signals, stopOnError: true });
    sendSignal(signals, 'halt');

    const cp = await loop;
    assert.equal(cp.status, 'halted');
    assert.equal(readResultPipe(pipe).items.length, 0);
});

test('flush signal clears not-yet-executed steps', async () => {
    withFakeExecutors();
    const runId = 'run-3';
    const queue = createStepsQueue([
        { id: 's1', name: 'browser.click', args: { target: { selector: '#a' } } } as StepUnion,
        { id: 's2', name: 'browser.click', args: { target: { selector: '#b' } } } as StepUnion,
        { id: 's3', name: 'browser.click', args: { target: { selector: '#c' } } } as StepUnion,
    ]);
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    sendSignal(signals, 'suspend');

    const loop = runSteps({ runId, workspaceId: 'ws-1', stepsQueue: queue, resultPipe: pipe, signalChannel: signals, stopOnError: true });
    sendSignal(signals, 'flush');
    sendSignal(signals, 'continue');
    closeStepsQueue(queue);

    const cp = await loop;
    const polled = readResultPipe(pipe);
    assert.equal(cp.status, 'completed');
    assert.equal(polled.items.length, 0);
});
