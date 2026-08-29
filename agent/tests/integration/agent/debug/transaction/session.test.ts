import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import type {RunStepsDeps} from '../../../../../src/automation/runner/run_steps';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const createViews = async (): Promise<[WorldView, WorldView]> => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const fixture = createV2BusinessPage();
    const first = await store.ensureFresh({pageKey, pageUrl: '/orders', capture: async () => fixture.capture});
    const secondCapture = structuredClone(fixture.capture);
    secondCapture.control.observation.identity.captureRevision = 2;
    const second = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        reason: 'explicit',
        capture: async () => secondCapture,
    });
    const toView = (entry: typeof first): WorldView => Object.freeze({
        workspaceName: 'ws-transaction',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    return [toView(first), toView(second)];
};

test('retained execution transaction spans effects and exposes savepoint-relative state', async () => {
    const [first, second] = await createViews();
    let current = first;
    let clickCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: `
            click input.target
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-transaction',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'submit'}, done: true},
            stepExecutionPort: {
                execute: async (step) => {
                    clickCalls += 1;
                    current = second;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => current},
        debug: {breakBeforeEffects: true, breakpoints: ['body.1']},
    });

    const effectPause = await execution.waitForPause();
    assert.equal(effectPause.reason, 'effect');
    assert.ok(effectPause.rollbackAnchor);
    const automaticRollbackAnchor = effectPause.rollbackAnchor;
    assert.equal(automaticRollbackAnchor.effectSequence, 0);
    assert.deepEqual(automaticRollbackAnchor.world.revision, first.revision);
    assert.deepEqual(execution.transaction(effectPause.continuationId).savepoints, []);
    const automaticExecutionSavepoint = execution.executionSavepoint(
        effectPause.continuationId,
        automaticRollbackAnchor.id,
    );
    assert.equal(automaticExecutionSavepoint?.reason, 'statement');
    assert.equal(automaticExecutionSavepoint?.location.path, 'body.0');
    const savepoint = execution.savepoint(effectPause.continuationId, 'before-submit');
    assert.equal(savepoint.id, automaticRollbackAnchor.id);
    const before = execution.transaction(effectPause.continuationId);
    assert.equal(before.effectCount, 0);
    assert.deepEqual(before.baseline.revision, first.revision);
    assert.deepEqual(savepoint.world.revision, first.revision);
    assert.equal(savepoint.effectSequence, 0);
    const executionSavepoint = execution.executionSavepoint(effectPause.continuationId, savepoint.id);
    assert.equal(executionSavepoint?.reason, 'statement');
    assert.equal(executionSavepoint?.location.programId, 'main');
    assert.equal(executionSavepoint?.location.path, 'body.0');
    assert.equal(executionSavepoint?.historySequence, 0);
    assert.deepEqual(executionSavepoint?.world.revision, first.revision);
    assert.deepEqual(executionSavepoint?.scope.input, {target: {nodeId: 'submit'}, done: true});

    const next = await execution.advance(effectPause.continuationId, 'continue');
    assert.equal(next.status, 'paused');
    if (next.status !== 'paused') {throw new Error('expected statement pause');}
    assert.equal(clickCalls, 1);

    const after = execution.transaction(next.pause.continuationId);
    assert.equal(after.effectCount, 1);
    assert.deepEqual(after.baseline.revision, first.revision);
    assert.deepEqual(after.current.revision, second.revision);
    assert.equal(after.savepoints[0].id, savepoint.id);

    const delta = execution.transactionDiff(next.pause.continuationId);
    assert.equal(delta.ok, true);
    if (delta.ok) {
        assert.deepEqual(delta.worldBefore.revision, first.revision);
        assert.deepEqual(delta.worldAfter.revision, second.revision);
    }

    await execution.advance(next.pause.continuationId, 'continue');
});

test('effect failure inherits the hidden pre-effect rollback anchor as a guarded rewind point', async () => {
    const [first, second] = await createViews();
    let current = first;
    const execution = createDslDebugExecutionSession({
        source: 'click input.target',
        context: {
            workspaceName: 'ws-transaction-failure-anchor',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'submit'}},
            stepExecutionPort: {
                execute: async (step) => {
                    current = second;
                    return {
                        stepId: step.id,
                        ok: false,
                        error: {code: 'ERR_NOT_FOUND', message: 'target disappeared'},
                    };
                },
            },
        },
        worldViewSource: {pin: async () => current},
        debug: {breakBeforeEffects: true, breakOnFailure: true},
    });

    const before = await execution.waitForPause();
    assert.equal(before.reason, 'effect');
    assert.ok(before.rollbackAnchor);
    const anchor = before.rollbackAnchor;
    const failed = await execution.advance(before.continuationId, 'continue');
    assert.equal(failed.status, 'paused');
    if (failed.status !== 'paused') {throw new Error('expected failure pause');}
    assert.equal(failed.pause.reason, 'failure');
    assert.equal(failed.pause.rollbackAnchor?.id, anchor.id);
    assert.deepEqual(execution.transaction(failed.pause.continuationId).savepoints, []);
    const executionAnchor = execution.executionSavepoint(failed.pause.continuationId, anchor.id);
    assert.equal(executionAnchor?.reason, 'statement');
    assert.equal(executionAnchor?.location.path, 'body.0');

    const rollback = await execution.rollback(failed.pause.continuationId, anchor.id);
    assert.equal(rollback.status, 'blocked');
    if (rollback.status === 'blocked') {
        assert.equal(rollback.reason, 'effects_require_compensation');
        assert.equal(rollback.savepoint.id, anchor.id);
    }
    const rewind = await execution.rewind(failed.pause.continuationId, anchor.id);
    assert.equal(rewind.status, 'blocked');
    if (rewind.status === 'blocked') {
        assert.equal(rewind.reason, 'world_not_restored');
    }
    await execution.advance(failed.pause.continuationId, 'abort');
});

test('continue mode records a pure failure statement checkpoint without pausing before it', async () => {
    const [first, second] = await createViews();
    let current = first;
    const execution = createDslDebugExecutionSession({
        source: `
            click input.target
            ensure compute eq(input.actual, input.expected)
        `,
        context: {
            workspaceName: 'ws-transaction-failure-program-point',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'submit'}, actual: 1, expected: 2},
            stepExecutionPort: {
                execute: async (step) => {
                    current = second;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => current},
        debug: {breakBeforeEffects: true, breakOnFailure: true, initialMode: 'continue'},
    });

    const effect = await execution.waitForPause();
    assert.equal(effect.reason, 'effect');
    const afterEffect = await execution.advance(effect.continuationId, 'continue');
    assert.equal(afterEffect.status, 'paused');
    if (afterEffect.status !== 'paused') {throw new Error('expected invariant failure pause');}
    assert.equal(afterEffect.pause.reason, 'failure');
    assert.equal(afterEffect.pause.location.path, 'body.1');

    const plan = execution.rewindPlan(afterEffect.pause.continuationId, {path: 'body.1'});
    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') {throw new Error('expected rewind plan');}
    const exact = plan.candidates.find((candidate) => candidate.exact);
    assert.ok(exact);
    assert.equal(exact.location.path, 'body.1');
    assert.equal(exact.effectSequence, 1);

    const rewound = await execution.rewind(afterEffect.pause.continuationId, exact.savepointId);
    assert.equal(rewound.status, 'rewound');
    if (rewound.status !== 'rewound') {throw new Error('expected rewind to failed invariant');}
    assert.equal(rewound.pause.location.path, 'body.1');
    await execution.advance(rewound.pause.continuationId, 'abort');
});

test('commit moves the transaction baseline forward while preserving effect audit history', async () => {
    const [first, second] = await createViews();
    let current = first;
    const execution = createDslDebugExecutionSession({
        source: `
            click input.target
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-transaction-commit',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'submit'}, done: true},
            stepExecutionPort: {
                execute: async (step) => {
                    current = second;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => current},
        debug: {breakBeforeEffects: true, breakpoints: ['body.1']},
    });

    const effect = await execution.waitForPause();
    const oldSavepoint = execution.savepoint(effect.continuationId, 'old-baseline');
    const next = await execution.advance(effect.continuationId, 'continue');
    assert.equal(next.status, 'paused');
    if (next.status !== 'paused') {throw new Error('expected statement pause after effect');}
    assert.equal(execution.transaction(next.pause.continuationId).effectCount, 1);
    assert.equal(execution.effects(next.pause.continuationId).length, 1);

    const committed = await execution.commit(next.pause.continuationId);
    assert.equal(committed.status, 'committed');
    if (committed.status !== 'committed') {throw new Error('expected commit');}
    assert.equal(committed.previous.effectCount, 1);
    assert.deepEqual(committed.previous.baseline.revision, first.revision);
    assert.equal(committed.transaction.effectCount, 0);
    assert.deepEqual(committed.transaction.baseline.revision, second.revision);
    assert.deepEqual(committed.transaction.current.revision, second.revision);
    assert.deepEqual(committed.transaction.savepoints, []);

    assert.equal(execution.effects(next.pause.continuationId).length, 1);
    assert.equal(execution.executionSavepoint(next.pause.continuationId, oldSavepoint.id), null);
    const oldRollback = await execution.rollback(next.pause.continuationId, oldSavepoint.id);
    assert.equal(oldRollback.status, 'not_found');

    const freshSavepoint = execution.savepoint(next.pause.continuationId, 'new-baseline');
    assert.equal(freshSavepoint.effectSequence, 1);
    const after = execution.transaction(next.pause.continuationId);
    assert.equal(after.effectCount, 0);
    assert.equal(after.savepoints.length, 1);
    assert.equal(after.savepoints[0].id, freshSavepoint.id);
    await execution.advance(next.pause.continuationId, 'abort');
});

test('commit refuses stale World state without moving the transaction baseline', async () => {
    const [first, second] = await createViews();
    let current = first;
    const execution = createDslDebugExecutionSession({
        source: 'output done = input.done',
        context: {
            workspaceName: 'ws-transaction-commit-conflict',
            deps: {} as RunStepsDeps,
            input: {done: true},
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => current},
        debug: {initialMode: 'step'},
    });

    const pause = await execution.waitForPause();
    const before = execution.transaction(pause.continuationId);
    current = second;
    const committed = await execution.commit(pause.continuationId);
    assert.equal(committed.status, 'conflict');
    if (committed.status === 'conflict') {
        assert.deepEqual(committed.conflict.expected.revision, first.revision);
        assert.deepEqual(committed.conflict.actual.revision, second.revision);
    }
    const after = execution.transaction(pause.continuationId);
    assert.equal(after.id, before.id);
    assert.deepEqual(after.baseline.revision, first.revision);
    await execution.advance(pause.continuationId, 'abort');
});

test('commit is unavailable at a failure pause', async () => {
    const [view] = await createViews();
    const execution = createDslDebugExecutionSession({
        source: 'ensure compute eq(input.actual, input.expected)',
        context: {
            workspaceName: 'ws-transaction-commit-failure',
            deps: {} as RunStepsDeps,
            input: {actual: 1, expected: 2},
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {breakOnFailure: true},
    });

    const pause = await execution.waitForPause();
    assert.equal(pause.reason, 'failure');
    const committed = await execution.commit(pause.continuationId);
    assert.equal(committed.status, 'unavailable');
    if (committed.status === 'unavailable') {assert.equal(committed.reason, 'failure_pause');}
    await execution.advance(pause.continuationId, 'abort');
});
