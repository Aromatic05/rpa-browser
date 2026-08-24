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
    const savepoint = execution.savepoint(effectPause.continuationId, 'before-submit');
    const before = execution.transaction(effectPause.continuationId);
    assert.equal(before.effectCount, 0);
    assert.deepEqual(before.baseline.revision, first.revision);
    assert.deepEqual(savepoint.world.revision, first.revision);
    assert.equal(savepoint.effectSequence, 0);
    const executionSavepoint = execution.executionSavepoint(effectPause.continuationId, savepoint.id);
    assert.equal(executionSavepoint?.reason, 'effect');
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
