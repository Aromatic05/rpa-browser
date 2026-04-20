import test from 'node:test';
import assert from 'node:assert/strict';
import { maybeEnterCheckpoint, maybePickCheckpoint, setCheckpoints } from '../../../src/runner/checkpoint/match';
import { maybeBindCheckpoint } from '../../../src/runner/checkpoint/bind';
import { maybeRunCheckpoint } from '../../../src/runner/checkpoint/run';
import { foldCheckpointResult } from '../../../src/runner/checkpoint/fold';
import type { CheckpointCtx } from '../../../src/runner/checkpoint/types';
import type { FailedCtx } from '../../../src/runner/failed_ctx';
import type { StepResult, StepUnion } from '../../../src/runner/steps/types';

const rawFailure: StepResult = {
    stepId: 's1',
    ok: false,
    error: { code: 'ERR_NOT_FOUND', message: 'boom' },
};

const createFailedCtx = (overrides?: Partial<FailedCtx>): FailedCtx => ({
    runId: 'run-1',
    workspaceId: 'ws-1',
    stepIndex: 0,
    step: { id: 's1', name: 'browser.click', args: { target: { selector: '#x' } } } as StepUnion,
    rawResult: rawFailure,
    stopOnError: true,
    checkpointEnabled: true,
    checkpointAttempt: 0,
    checkpointMaxAttempts: 2,
    inCheckpointFlow: false,
    deps: {
        runtime: {
            ensureActivePage: async () => ({
                traceTools: {
                    'trace.page.getInfo': async () => ({ ok: true, data: { url: 'https://example.test/path' } }),
                    'trace.page.evaluate': async () => ({ ok: true, data: true }),
                },
            }),
        },
        pluginHost: {} as any,
        config: {} as any,
    } as any,
    executeStep: async (step) => ({ stepId: step.id, ok: true }),
    checkpoints: undefined,
    currentUrl: 'https://example.test/path',
    ...overrides,
});

const createCtx = (overrides?: Partial<CheckpointCtx>): CheckpointCtx => {
    const failedCtx = createFailedCtx();
    return {
        failedCtx,
        active: true,
        finalResult: failedCtx.rawResult,
        ...overrides,
    };
};

test('maybeEnterCheckpoint: disabled -> not entered', async () => {
    const ctx = createCtx({ failedCtx: createFailedCtx({ checkpointEnabled: false }) });
    const result = await maybeEnterCheckpoint(ctx);
    assert.equal(result.active, false);
    assert.equal(result.stopReason, 'checkpoint_not_entered');
});

test('maybeEnterCheckpoint: transient error does not enter', async () => {
    const ctx = createCtx({
        failedCtx: createFailedCtx({
            rawResult: { stepId: 's1', ok: false, error: { code: 'ERR_TIMEOUT', message: 'timeout' } },
        }),
    });
    const result = await maybeEnterCheckpoint(ctx);
    assert.equal(result.active, false);
    assert.equal(result.stopReason, 'checkpoint_not_entered');
});

test('maybeEnterCheckpoint: fatal error does not enter', async () => {
    const ctx = createCtx({
        failedCtx: createFailedCtx({
            rawResult: { stepId: 's1', ok: false, error: { code: 'ERR_INTERNAL', message: 'fatal' } },
        }),
    });
    const result = await maybeEnterCheckpoint(ctx);
    assert.equal(result.active, false);
    assert.equal(result.stopReason, 'checkpoint_not_entered');
});

test('maybeEnterCheckpoint: normal failure enters', async () => {
    const result = await maybeEnterCheckpoint(createCtx());
    assert.equal(result.active, true);
});

test('maybePickCheckpoint: no candidates', async () => {
    setCheckpoints([]);
    const result = await maybePickCheckpoint(createCtx());
    assert.equal(result.active, false);
    assert.equal(result.stopReason, 'checkpoint_not_found');
});

test('maybePickCheckpoint: candidates but no match', async () => {
    setCheckpoints([
        {
            id: 'cp-1',
            name: 'cp',
            matchRules: [{ errorCode: 'ERR_TIMEOUT' }],
            content: [],
        },
    ]);
    const result = await maybePickCheckpoint(createCtx());
    assert.equal(result.active, false);
    assert.equal(result.stopReason, 'checkpoint_not_found');
});

test('maybePickCheckpoint: single matched checkpoint', async () => {
    setCheckpoints([
        {
            id: 'cp-1',
            name: 'cp',
            matchRules: [{ errorCode: 'ERR_NOT_FOUND' }, { stepName: 'browser.click' }],
            content: [],
        },
    ]);
    const result = await maybePickCheckpoint(createCtx());
    assert.equal(result.active, true);
    assert.equal(result.checkpoint?.id, 'cp-1');
});

test('maybePickCheckpoint: priority wins', async () => {
    setCheckpoints([
        {
            id: 'cp-low',
            name: 'low',
            priority: 1,
            matchRules: [{ errorCode: 'ERR_NOT_FOUND' }],
            content: [],
        },
        {
            id: 'cp-high',
            name: 'high',
            priority: 10,
            matchRules: [{ errorCode: 'ERR_NOT_FOUND' }],
            content: [],
        },
    ]);
    const result = await maybePickCheckpoint(createCtx());
    assert.equal(result.checkpoint?.id, 'cp-high');
});

test('maybeBindCheckpoint: binds variables', async () => {
    const ctx = createCtx({
        checkpoint: {
            id: 'cp-1',
            name: 'cp',
            matchRules: [{ errorCode: 'ERR_NOT_FOUND' }],
            content: [
                {
                    id: 'content-1',
                    name: 'browser.assert',
                    args: { textVisible: '{{failed.errorCode}}' },
                } as StepUnion,
            ],
        },
    });
    const result = await maybeBindCheckpoint(ctx);
    assert.equal(result.active, true);
    assert.equal((result.boundContent?.[0] as any)?.args?.textVisible, 'ERR_NOT_FOUND');
});

test('maybeBindCheckpoint: missing variable fails', async () => {
    const ctx = createCtx({
        checkpoint: {
            id: 'cp-1',
            name: 'cp',
            matchRules: [{ errorCode: 'ERR_NOT_FOUND' }],
            content: [
                {
                    id: 'content-1',
                    name: 'browser.assert',
                    args: { textVisible: '{{failed.nope}}' },
                } as StepUnion,
            ],
        },
    });
    const result = await maybeBindCheckpoint(ctx);
    assert.equal(result.active, false);
    assert.equal(result.stopReason, 'checkpoint_bind_failed');
    assert.equal(result.runResult?.error?.code, 'ERR_CHECKPOINT_BIND_FAILED');
});

test('maybeRunCheckpoint: content steps all success', async () => {
    const ctx = createCtx({
        checkpoint: { id: 'cp', name: 'cp', matchRules: [], content: [] },
        boundContent: [{ id: 'content-1', name: 'browser.click', args: { target: { selector: '#x' } } } as StepUnion],
    });
    const result = await maybeRunCheckpoint(ctx);
    assert.equal(result.runResult?.ok, true);
});

test('maybeRunCheckpoint: assert step success', async () => {
    const ctx = createCtx({
        checkpoint: { id: 'cp', name: 'cp', matchRules: [], content: [] },
        boundContent: [{ id: 'assert-1', name: 'browser.assert', args: { textVisible: 'ok' } } as StepUnion],
    });
    const result = await maybeRunCheckpoint(ctx);
    assert.equal(result.runResult?.ok, true);
});

test('maybeRunCheckpoint: assert step failure stops immediately', async () => {
    const ctx = createCtx({
        failedCtx: createFailedCtx({
            executeStep: async (step) => {
                if (step.name === 'browser.assert') {
                    return { stepId: step.id, ok: false, error: { code: 'ERR_X', message: 'assert failed' } };
                }
                return { stepId: step.id, ok: true };
            },
        }),
        checkpoint: { id: 'cp', name: 'cp', matchRules: [], content: [] },
        boundContent: [{ id: 'assert-1', name: 'browser.assert', args: { textVisible: 'bad' } } as StepUnion],
    });
    const result = await maybeRunCheckpoint(ctx);
    assert.equal(result.active, false);
    assert.equal(result.stopReason, 'checkpoint_assert_failed');
    assert.equal(result.runResult?.error?.code, 'ERR_CHECKPOINT_ASSERT_FAILED');
});

test('maybeRunCheckpoint: normal step failure stops checkpoint', async () => {
    const ctx = createCtx({
        failedCtx: createFailedCtx({
            executeStep: async () => ({ stepId: 'content-1', ok: false, error: { code: 'ERR_NOT_FOUND', message: 'fail' } }),
        }),
        checkpoint: { id: 'cp', name: 'cp', matchRules: [], content: [] },
        boundContent: [{ id: 'content-1', name: 'browser.fill', args: { value: 'x', target: { selector: '#a' } } } as StepUnion],
    });
    const result = await maybeRunCheckpoint(ctx);
    assert.equal(result.active, false);
    assert.equal(result.stopReason, 'checkpoint_step_failed');
    assert.equal(result.runResult?.ok, false);
});

test('foldCheckpointResult: not entered falls back rawResult', () => {
    const ctx = createCtx({ active: false, stopReason: 'checkpoint_not_entered' });
    const folded = foldCheckpointResult(ctx);
    assert.equal(folded.finalResult, ctx.failedCtx.rawResult);
});

test('foldCheckpointResult: checkpoint success uses retryResult', () => {
    const ctx = createCtx({
        active: true,
        runResult: { stepId: 's1', ok: true },
        retryResult: { stepId: 's1', ok: true, data: { retried: true } },
    });
    const folded = foldCheckpointResult(ctx);
    assert.equal(folded.finalResult.ok, true);
    assert.deepEqual(folded.finalResult.data, { retried: true });
});

test('foldCheckpointResult: suspend path', () => {
    const ctx = createCtx({
        active: false,
        nextStatus: 'suspended',
        runResult: {
            stepId: 's1',
            ok: false,
            error: { code: 'ERR_CHECKPOINT_SUSPEND', message: 'suspend' },
        },
    });
    const folded = foldCheckpointResult(ctx);
    assert.equal(folded.nextStatus, 'suspended');
    assert.equal(folded.finalResult.error?.code, 'ERR_CHECKPOINT_SUSPEND');
});
