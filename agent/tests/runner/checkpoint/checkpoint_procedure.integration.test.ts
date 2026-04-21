import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    readResultPipe,
    runSteps,
} from '../../../src/runner/run_steps';
import type { Checkpoint } from '../../../src/runner/checkpoint';
import { executeBrowserCheckpoint } from '../../../src/runner/steps/executors/checkpoint';
import type { StepUnion } from '../../../src/runner/steps/types';

const createDeps = () => ({
    runtime: {
        ensureActivePage: async () => ({
            workspaceId: 'ws-1',
            tabId: 'tab-1',
            tabToken: 'tk-1',
            traceCtx: { cache: {} },
        }),
    } as any,
    config: {} as any,
    pluginHost: {
        getExecutors: () =>
            ({
                'browser.checkpoint': executeBrowserCheckpoint,
                'browser.get_page_info': async (step: StepUnion) => ({
                    stepId: step.id,
                    ok: true,
                    data: { url: 'https://example.test/table' },
                }),
            }) as any,
    } as any,
});

const runWithCheckpoints = async (step: StepUnion, checkpoints: Checkpoint[]) => {
    const queue = createStepsQueue([step]);
    closeStepsQueue(queue);
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const checkpoint = await runSteps(
        {
            runId: 'run-1',
            workspaceId: 'ws-1',
            stepsQueue: queue,
            resultPipe: pipe,
            signalChannel: signals,
            checkpoints,
            stopOnError: true,
        },
        createDeps() as any,
    );
    return {
        checkpoint,
        results: readResultPipe(pipe).items,
    };
};

test('browser.checkpoint executes prepare/content/output with runtime scopes', async () => {
    const step: StepUnion = {
        id: 'cp-step-1',
        name: 'browser.checkpoint',
        args: {
            checkpointId: 'cp-procedure',
            input: {
                expectedHost: 'example.test',
            },
        },
    } as StepUnion;
    const checkpoints: Checkpoint[] = [
        {
            id: 'cp-procedure',
            kind: 'procedure',
            prepare: [{ type: 'wait', args: { ms: 0 } }],
            content: [
                {
                    type: 'act',
                    step: {
                        name: 'browser.get_page_info',
                        args: {},
                    },
                    saveAs: 'pageInfo',
                },
            ],
            output: {
                pageUrl: { ref: 'local.pageInfo.url' },
                expectedHost: { ref: 'input.expectedHost' },
            },
        },
    ];

    const { checkpoint, results } = await runWithCheckpoints(step, checkpoints);
    assert.equal(checkpoint.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.equal((results[0].data as any).output.pageUrl, 'https://example.test/table');
    assert.equal((results[0].data as any).output.expectedHost, 'example.test');
});

test('browser.checkpoint fails on missing ref and invalid output path', async () => {
    const step: StepUnion = {
        id: 'cp-step-2',
        name: 'browser.checkpoint',
        args: {
            checkpointId: 'cp-invalid',
        },
    } as StepUnion;
    const checkpoints: Checkpoint[] = [
        {
            id: 'cp-invalid',
            kind: 'procedure',
            content: [],
            output: {
                'bad.path': { ref: 'local.not_found' },
            },
        },
    ];

    const { checkpoint, results } = await runWithCheckpoints(step, checkpoints);
    assert.equal(checkpoint.status, 'failed');
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error?.code, 'ERR_CHECKPOINT_OUTPUT_PATH_INVALID');
});
