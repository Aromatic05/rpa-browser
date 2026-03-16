import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunStepsQueueManager } from '../../src/runner/run_steps';
import { setRunStepsDeps } from '../../src/runner/run_steps';
import { loadRunnerConfig } from '../../src/runner/config/loader';
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

test('task run manager push/poll/checkpoint', async () => {
    withFakeExecutors();
    const manager = createRunStepsQueueManager();
    const run = manager.createRun({ taskId: 't1', workspaceId: 'ws-1' });

    const pushed = await manager.pushSteps({
        runId: run.runId,
        steps: [
            { step: { id: 's1', name: 'browser.click', args: { target: { selector: '#a' } } } as StepUnion },
            { step: { id: 's2', name: 'browser.click', args: { target: { selector: '#b' } } } as StepUnion },
        ],
    });

    assert.equal(pushed.ok, true);
    assert.equal(pushed.accepted, 2);
    const polled = manager.pollResults({ runId: run.runId });
    assert.equal(polled.items.length, 2);
    assert.equal(polled.items[0].outputs?.clicked, true);
    const cp = manager.checkpoint(run.runId);
    assert.equal(cp.nextSeq, 2);
    assert.equal(cp.status, 'running');
});

test('task run manager marks failed on step failure', async () => {
    withFakeExecutors();
    const manager = createRunStepsQueueManager();
    const run = manager.createRun({ taskId: 't2', workspaceId: 'ws-1' });

    const pushed = await manager.pushSteps({
        runId: run.runId,
        steps: [{ step: { id: 's3', name: 'browser.goto', args: { url: 'https://x' } } as StepUnion }],
    });

    assert.equal(pushed.ok, false);
    const cp = manager.checkpoint(run.runId);
    assert.equal(cp.status, 'failed');
    assert.equal(cp.lastError?.code, 'ERR_NOT_FOUND');
});
