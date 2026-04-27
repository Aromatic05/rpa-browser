import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    readResultPipe,
    runSteps,
    sendSignal,
    setRunStepsDeps,
} from '../../../src/runner/run_steps';
import { loadRunnerConfig } from '../../../src/config/loader';
import type { StepUnion } from '../../../src/runner/steps/types';
import type { Checkpoint } from '../../../src/runner/checkpoint';

const createRuntime = () => ({
    ensureActivePage: async () => ({
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        tabToken: 'tk-1',
        page: { url: () => 'https://example.test/page' },
        traceCtx: { cache: {} },
        traceTools: {
            'trace.page.getInfo': async () => ({ ok: true, data: { url: 'https://example.test/page' } }),
            'trace.page.evaluate': async () => ({ ok: true, data: true }),
        },
    }),
});

const createDeps = (executors: Record<string, (step: StepUnion) => Promise<any>>) => {
    setRunStepsDeps({
        runtime: createRuntime() as any,
        config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
        pluginHost: {
            getExecutors: () => executors,
        } as any,
    });
};

const baseStep = (): StepUnion => ({ id: 's1', name: 'browser.click', args: { target: { selector: '#x' } } }) as StepUnion;

const runOne = async (opts: {
    executors: Record<string, (step: StepUnion) => Promise<any>>;
    checkpoints?: Checkpoint[];
    onCheckpoint?: (cp: any, signals: any) => void | Promise<void>;
}) => {
    createDeps(opts.executors);
    const queue = createStepsQueue([baseStep()], { closed: true });
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const cp = await runSteps(
        {
            runId: 'run-1',
            workspaceId: 'ws-1',
            stepsQueue: queue,
            resultPipe: pipe,
            signalChannel: signals,
            stopOnError: true,
            checkpoints: opts.checkpoints,
            onCheckpoint: opts.onCheckpoint ? (next) => opts.onCheckpoint?.(next, signals) : undefined,
        },
        undefined,
    );
    return { cp, results: readResultPipe(pipe).items };
};

test('failed step without checkpoint stays failed', async () => {
    const { cp, results } = await runOne({
        executors: {
            'browser.click': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } }),
        },
    });

    assert.equal(cp.status, 'failed');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error?.code, 'ERR_NOT_FOUND');
});

test('failed step hits checkpoint, content success, original step retry succeeds', async () => {
    const calls: string[] = [];
    let clickAttempts = 0;
    const { cp, results } = await runOne({
        executors: {
            'browser.click': async (step) => {
                clickAttempts += 1;
                calls.push(`click:${clickAttempts}`);
                if (clickAttempts === 1) {
                    return { stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } };
                }
                return { stepId: step.id, ok: true, data: { retried: true } };
            },
            'browser.fill': async (step) => {
                calls.push('fill');
                return { stepId: step.id, ok: true };
            },
        },
        checkpoints: [
            {
                id: 'cp-1',
                name: 'recover-click',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-1', name: 'browser.fill', args: { target: { selector: '#x' }, value: 'fix' } } as StepUnion],
            },
        ],
    });

    assert.equal(cp.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.deepEqual(calls, ['click:1', 'fill', 'click:2']);
});

test('failed step hits checkpoint but content fails, remains failed', async () => {
    const { cp, results } = await runOne({
        executors: {
            'browser.click': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } }),
            'browser.fill': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'cp fail' } }),
        },
        checkpoints: [
            {
                id: 'cp-1',
                name: 'recover-click',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-1', name: 'browser.fill', args: { target: { selector: '#x' }, value: 'fix' } } as StepUnion],
            },
        ],
    });

    assert.equal(cp.status, 'failed');
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error?.code, 'ERR_NOT_FOUND');
});

test('failed step hits checkpoint but assert step fails, remains failed', async () => {
    const { cp, results } = await runOne({
        executors: {
            'browser.click': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } }),
            'browser.assert': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_CHECKPOINT_ASSERT_FAILED', message: 'assert fail' } }),
        },
        checkpoints: [
            {
                id: 'cp-1',
                name: 'recover-click',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-assert', name: 'browser.assert', args: { textVisible: 'x' } } as StepUnion],
            },
        ],
    });

    assert.equal(cp.status, 'failed');
    assert.equal(results[0].ok, false);
});

test('checkpoint can request suspend and runner enters suspended', async () => {
    const statuses: string[] = [];
    createDeps({
        'browser.click': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } }),
        'browser.fill': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_CHECKPOINT_SUSPEND', message: 'pause' } }),
    });

    const queue = createStepsQueue([baseStep()], { closed: true });
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const loop = runSteps({
        runId: 'run-suspend',
        workspaceId: 'ws-1',
        stepsQueue: queue,
        resultPipe: pipe,
        signalChannel: signals,
        stopOnError: true,
        checkpoints: [
            {
                id: 'cp-suspend',
                name: 'suspend-checkpoint',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-suspend', name: 'browser.fill', args: { target: { selector: '#x' }, value: 'fix' } } as StepUnion],
            },
        ],
        onCheckpoint: async (cp) => {
            statuses.push(cp.status);
            if (cp.status === 'suspended') {
                sendSignal(signals, 'halt');
            }
        },
    });

    const cp = await loop;
    const results = readResultPipe(pipe).items;

    assert.equal(statuses.includes('suspended'), true);
    assert.equal(cp.status, 'halted');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
});

test('failed step can return checkpoint result without retrying original step', async () => {
    const calls: string[] = [];
    const { cp, results } = await runOne({
        executors: {
            'browser.click': async (step) => {
                calls.push(`click:${step.id}`);
                return { stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } };
            },
            'browser.fill': async (step) => {
                calls.push(`fill:${step.id}`);
                return { stepId: step.id, ok: true, data: { patched: true } };
            },
        },
        checkpoints: [
            {
                id: 'cp-no-retry',
                name: 'recover-click-no-retry',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-1', name: 'browser.fill', args: { target: { selector: '#x' }, value: 'fix' } } as StepUnion],
                policy: {
                    retryOriginal: false,
                },
            },
        ],
    });

    assert.equal(cp.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.deepEqual(results[0].data, {
        checkpointId: 'cp-no-retry',
        checkpointName: 'recover-click-no-retry',
    });
    assert.deepEqual(calls, ['click:s1', 'fill:cp-step-1']);
});

test('failed step stops re-entering checkpoint after policy maxAttempts', async () => {
    const calls: string[] = [];
    createDeps({
        'browser.click': async (step) => {
            calls.push(`click:${step.id}`);
            return { stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } };
        },
        'browser.fill': async (step) => {
            calls.push(`fill:${step.id}`);
            return { stepId: step.id, ok: true, data: { patched: true } };
        },
    });

    const repeatedStep = baseStep();
    const queue = createStepsQueue([repeatedStep, { ...repeatedStep }], { closed: true });
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const cp = await runSteps({
        runId: 'run-max-attempts',
        workspaceId: 'ws-1',
        stepsQueue: queue,
        resultPipe: pipe,
        signalChannel: signals,
        stopOnError: false,
        checkpoints: [
            {
                id: 'cp-max-attempts',
                name: 'recover-click-once',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-1', name: 'browser.fill', args: { target: { selector: '#x' }, value: 'fix' } } as StepUnion],
                policy: {
                    maxAttempts: 1,
                    retryOriginal: false,
                },
            },
        ],
    });
    const results = readResultPipe(pipe).items;

    assert.equal(cp.status, 'completed');
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error?.code, 'ERR_NOT_FOUND');
    assert.deepEqual(calls, ['click:s1', 'fill:cp-step-1', 'click:s1']);
});
