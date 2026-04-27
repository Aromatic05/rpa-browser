import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    readResultPipe,
    runStepList,
    runSteps,
    setRunStepsDeps,
} from '../../../src/runner/run_steps';
import { loadRunnerConfig } from '../../../src/config/loader';
import type { Checkpoint } from '../../../src/runner/checkpoint';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { StepResolve, StepUnion } from '../../../src/runner/steps/types';

const createRuntime = () => ({
    ensureActivePage: async () => ({
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        tabToken: 'tk-1',
        page: { url: () => 'https://example.test/page' },
        traceCtx: { cache: {} },
        traceTools: {},
    }),
});

const createDeps = (executors: Record<string, (step: StepUnion) => Promise<any>>): RunStepsDeps => ({
    runtime: createRuntime() as any,
    config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
    pluginHost: {
        getExecutors: () => executors,
    } as any,
});

test('runStepList injects runtime step.resolve from args.resolveId', async () => {
    const observed: StepUnion[] = [];
    const { checkpoint, pipe } = await runStepList(
        'ws-1',
        [
            {
                id: 'click-1',
                name: 'browser.click',
                args: { resolveId: 'resolveSubmit' },
            } as StepUnion,
        ],
        createDeps({
            'browser.click': async (step) => {
                observed.push(step);
                return { stepId: step.id, ok: true };
            },
        }),
        {
            stopOnError: true,
            stepResolves: {
                resolveSubmit: {
                    hint: { raw: { selector: '#submit' } },
                    policy: { requireVisible: true },
                },
            },
        },
    );

    assert.equal(checkpoint.status, 'completed');
    assert.equal(pipe.items[0]?.ok, true);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].resolve?.hint?.raw?.selector, '#submit');
    assert.equal(observed[0].resolve?.policy?.requireVisible, true);
    assert.equal((observed[0].args as { resolveId?: string }).resolveId, 'resolveSubmit');
});

test('runStepList returns ERR_BAD_ARGS for missing or conflicting resolve sources', async () => {
    const deps = createDeps({
        'browser.click': async (step) => ({ stepId: step.id, ok: true }),
        'browser.goto': async (step) => ({ stepId: step.id, ok: true }),
    });

    const missing = await runStepList(
        'ws-1',
        [{ id: 'click-missing', name: 'browser.click', args: { resolveId: 'missing' } } as StepUnion],
        deps,
        { stopOnError: true, stepResolves: {} },
    );
    assert.equal(missing.checkpoint.status, 'failed');
    assert.equal(missing.pipe.items[0]?.error?.code, 'ERR_BAD_ARGS');

    const conflict = await runStepList(
        'ws-1',
        [
            {
                id: 'click-conflict',
                name: 'browser.click',
                args: { resolveId: 'resolveSubmit' },
                resolve: { hint: { raw: { selector: '#submit' } } },
            } as StepUnion,
        ],
        deps,
        {
            stopOnError: true,
            stepResolves: {
                resolveSubmit: { hint: { raw: { selector: '#submit' } } },
            },
        },
    );
    assert.equal(conflict.checkpoint.status, 'failed');
    assert.equal(conflict.pipe.items[0]?.error?.code, 'ERR_BAD_ARGS');

    const unsupported = await runStepList(
        'ws-1',
        [{ id: 'goto-bad', name: 'browser.goto', args: { url: 'https://example.test', resolveId: 'resolveSubmit' } } as any],
        deps,
        {
            stopOnError: true,
            stepResolves: {
                resolveSubmit: { hint: { raw: { selector: '#submit' } } },
            },
        },
    );
    assert.equal(unsupported.checkpoint.status, 'failed');
    assert.equal(unsupported.pipe.items[0]?.error?.code, 'ERR_BAD_ARGS');
});

test('checkpoint act step injects resolve from serialized resolveId sidecar', async () => {
    const observed: StepUnion[] = [];
    let clickAttempts = 0;
    setRunStepsDeps(
        createDeps({
            'browser.click': async (step) => {
                clickAttempts += 1;
                if (step.id === 'seed-click' && clickAttempts === 1) {
                    return { stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } };
                }
                observed.push(step);
                return { stepId: step.id, ok: true };
            },
        }),
    );

    const queue = createStepsQueue([{ id: 'seed-click', name: 'browser.click', args: { selector: '#seed' } } as StepUnion]);
    closeStepsQueue(queue);
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const checkpoint = await runSteps({
        runId: 'run-1',
        workspaceId: 'ws-1',
        stepsQueue: queue,
        resultPipe: pipe,
        signalChannel: signals,
        stopOnError: true,
        stepResolves: {
            resolveSubmit: {
                hint: { raw: { selector: '#checkpoint-submit' } },
            },
        },
        checkpoints: [
            {
                id: 'cp-1',
                name: 'recover-click',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [
                    {
                        type: 'act',
                        step: {
                            name: 'browser.click',
                            args: {},
                            resolveId: 'resolveSubmit',
                        },
                    },
                ],
            } satisfies Checkpoint,
        ],
    });

    const results = readResultPipe(pipe).items;
    assert.equal(checkpoint.status, 'completed');
    assert.equal(results[0]?.ok, true);
    assert.equal(observed.some((step) => step.resolve?.hint?.raw?.selector === '#checkpoint-submit'), true);
});

test('run steps request accepts stepResolves typing contract', () => {
    const typed: { stepResolves?: Record<string, StepResolve> } = {
        stepResolves: {
            resolveSubmit: { hint: { raw: { selector: '#submit' } } },
        },
    };
    assert.equal(typed.stepResolves?.resolveSubmit?.hint?.raw?.selector, '#submit');
});
