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

const createBindingWithBusinessEntity = (businessTag: string) => {
    const workspaceId = 'ws-1';
    const tabId = 'tab-1';
    const tabToken = 'tab-token-1';
    const url = 'https://example.test/orders';
    const snapshot = {
        root: { id: 'root', role: 'root', children: [] },
        nodeIndex: {},
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex: {},
        bboxIndex: {},
        attrIndex: {},
        contentStore: {},
    } as any;

    return {
        workspaceId,
        tabId,
        tabToken,
        page: { url: () => url },
        traceTools: {
            'trace.page.getInfo': async () => ({ ok: true, data: { url } }),
            'trace.page.evaluate': async () => ({ ok: true, data: true }),
        },
        traceCtx: {
            cache: {
                snapshotSessionStore: {
                    version: 1,
                    entries: {
                        [`${workspaceId}:${tabToken}`]: {
                            pageIdentity: { workspaceId, tabId, tabToken, url },
                            baseSnapshot: snapshot,
                            finalSnapshot: snapshot,
                            finalEntityView: {
                                entities: [
                                    {
                                        id: 'final_ent_1',
                                        entityId: 'ent_1',
                                        nodeId: 'node_1',
                                        kind: 'table',
                                        type: 'region',
                                        name: 'Order Table',
                                        businessTag,
                                        source: 'auto',
                                    },
                                ],
                                byNodeId: {
                                    node_1: [
                                        {
                                            id: 'final_ent_1',
                                            entityId: 'ent_1',
                                            nodeId: 'node_1',
                                            kind: 'table',
                                            type: 'region',
                                            name: 'Order Table',
                                            businessTag,
                                            source: 'auto',
                                        },
                                    ],
                                },
                                bindingIndex: {
                                    fieldsByEntity: {},
                                    actionsByEntity: {},
                                    columnsByEntity: {},
                                },
                            },
                            overlays: { renamedNodes: {}, addedEntities: [], deletedEntities: [] },
                            diffBaselines: {},
                            dirty: false,
                            lastRefreshAt: Date.now(),
                            version: 1,
                        },
                    },
                },
            },
        },
    } as any;
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
            trigger: { matchRules: [{ errorCode: 'ERR_TIMEOUT' }] },
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
            trigger: { matchRules: [{ errorCode: 'ERR_NOT_FOUND' }, { stepName: 'browser.click' }] },
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
            trigger: { matchRules: [{ errorCode: 'ERR_NOT_FOUND' }] },
            content: [],
        },
        {
            id: 'cp-high',
            name: 'high',
            priority: 10,
            trigger: { matchRules: [{ errorCode: 'ERR_NOT_FOUND' }] },
            content: [],
        },
    ]);
    const result = await maybePickCheckpoint(createCtx());
    assert.equal(result.checkpoint?.id, 'cp-high');
});

test('maybePickCheckpoint: checkpoint policy maxAttempts blocks re-entry', async () => {
    setCheckpoints([
        {
            id: 'cp-limited',
            name: 'limited',
            trigger: { matchRules: [{ errorCode: 'ERR_NOT_FOUND' }] },
            policy: {
                maxAttempts: 1,
            },
            content: [],
        },
    ]);
    const result = await maybePickCheckpoint(
        createCtx({
            failedCtx: createFailedCtx({
                checkpointAttempt: 1,
                checkpointMaxAttempts: 3,
            }),
        }),
    );
    assert.equal(result.active, false);
    assert.equal(result.stopReason, 'checkpoint_not_found');
});

test('maybePickCheckpoint: entityExists matches by businessTag', async () => {
    setCheckpoints([
        {
            id: 'cp-entity-tag',
            name: 'entity-tag',
            trigger: { matchRules: [
                {
                    entityExists: {
                        query: 'Order',
                        kind: 'table',
                        businessTag: 'order.list.main',
                    },
                },
            ] },
            content: [],
        },
    ]);
    const binding = createBindingWithBusinessEntity('order.list.main');
    const result = await maybePickCheckpoint(
        createCtx({
            failedCtx: createFailedCtx({
                deps: {
                    runtime: {
                        ensureActivePage: async () => binding,
                    },
                    pluginHost: {} as any,
                    config: {} as any,
                } as any,
            }),
        }),
    );
    assert.equal(result.active, true);
    assert.equal(result.checkpoint?.id, 'cp-entity-tag');
});

test('maybeBindCheckpoint: binds variables', async () => {
    const ctx = createCtx({
        checkpoint: {
            id: 'cp-1',
            name: 'cp',
            trigger: { matchRules: [{ errorCode: 'ERR_NOT_FOUND' }] },
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
            trigger: { matchRules: [{ errorCode: 'ERR_NOT_FOUND' }] },
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
        checkpoint: { id: 'cp', name: 'cp', trigger: { matchRules: [] }, content: [] },
        boundContent: [{ id: 'content-1', name: 'browser.click', args: { target: { selector: '#x' } } } as StepUnion],
    });
    const result = await maybeRunCheckpoint(ctx);
    assert.equal(result.runResult?.ok, true);
});

test('maybeRunCheckpoint: assert step success', async () => {
    const ctx = createCtx({
        checkpoint: { id: 'cp', name: 'cp', trigger: { matchRules: [] }, content: [] },
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
        checkpoint: { id: 'cp', name: 'cp', trigger: { matchRules: [] }, content: [] },
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
        checkpoint: { id: 'cp', name: 'cp', trigger: { matchRules: [] }, content: [] },
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

test('foldCheckpointResult: checkpoint success can return checkpoint result without retry', () => {
    const ctx = createCtx({
        active: true,
        checkpoint: {
            id: 'cp-1',
            name: 'cp-1',
            trigger: { matchRules: [] },
            policy: {
                retryOriginal: false,
            },
            content: [],
        },
        runResult: {
            stepId: 's1',
            ok: true,
            data: {
                checkpointId: 'cp-1',
                output: {
                    clicked: true,
                },
            },
        },
    });
    const folded = foldCheckpointResult(ctx);
    assert.equal(folded.finalResult.ok, true);
    assert.deepEqual(folded.finalResult.data, {
        checkpointId: 'cp-1',
        output: {
            clicked: true,
        },
    });
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
