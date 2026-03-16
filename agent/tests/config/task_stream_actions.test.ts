import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAction } from '../../src/actions/execute';
import { setRunStepsDeps } from '../../src/runner/run_steps';
import { loadRunnerConfig } from '../../src/runner/config/loader';
import type { StepUnion } from '../../src/runner/steps/types';

const buildCtx = () => {
    setRunStepsDeps({
        runtime: {} as any,
        config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.click': async (step: StepUnion) => ({ stepId: step.id, ok: true, data: { value: 1 } }),
                }) as any,
        } as any,
    });
    return {
        page: { url: () => 'https://example.com' } as any,
        tabToken: 'token-a',
        pageRegistry: {} as any,
        log: () => undefined,
        recordingState: {
            recordingEnabled: new Set(),
            recordings: new Map(),
            recordingManifests: new Map(),
            workspaceLatestRecording: new Map(),
            lastNavigateTs: new Map(),
            lastClickTs: new Map(),
            lastScrollY: new Map(),
            replaying: new Set(),
            replayCancel: new Set(),
        },
        replayOptions: {
            clickDelayMs: 0,
            stepDelayMs: 0,
            scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 },
        },
        navDedupeWindowMs: 1000,
    } as any;
};

test('task.run lifecycle actions', async () => {
    const ctx = buildCtx();

    const started = await executeAction(ctx, {
        v: 1,
        id: 'a1',
        type: 'task.run.start',
        payload: { workspaceId: 'ws-1' },
    });
    assert.equal(started.ok, true);
    const runId = (started as any).data.runId as string;

    const pushed = await executeAction(ctx, {
        v: 1,
        id: 'a2',
        type: 'task.run.push',
        payload: {
            runId,
            steps: [{ id: 's1', name: 'browser.click', args: { target: { selector: '#a' } } }],
        },
    });
    assert.equal(pushed.ok, true);

    const polled = await executeAction(ctx, {
        v: 1,
        id: 'a3',
        type: 'task.run.poll',
        payload: { runId },
    });
    assert.equal(polled.ok, true);
    if ((polled as any).data.items.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const polled2 = await executeAction(ctx, {
            v: 1,
            id: 'a3b',
            type: 'task.run.poll',
            payload: { runId },
        });
        assert.equal(polled2.ok, true);
        assert.equal((polled2 as any).data.items.length, 1);
    } else {
        assert.equal((polled as any).data.items.length, 1);
    }

    const checkpoint = await executeAction(ctx, {
        v: 1,
        id: 'a4',
        type: 'task.run.checkpoint',
        payload: { runId },
    });
    assert.equal(checkpoint.ok, true);

    const aborted = await executeAction(ctx, {
        v: 1,
        id: 'a5',
        type: 'task.run.halt',
        payload: { runId },
    });
    assert.equal(aborted.ok, true);
    assert.equal((aborted as any).data.checkpoint.status, 'halted');
});
