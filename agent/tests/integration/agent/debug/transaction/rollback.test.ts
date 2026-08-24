import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import type {RunStepsDeps} from '../../../../../src/automation/runner/run_steps';
import type {StepExecutionPort} from '../../../../../src/program/dsl/runtime/run_dsl';
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
        workspaceName: 'ws-rollback',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    return [toView(first), toView(second)];
};

test('rollback is a no-op restore when savepoint World and effect position are unchanged', async () => {
    const [view] = await createViews();
    const execution = createDslDebugExecutionSession({
        source: 'output result = input.value',
        context: {
            workspaceName: 'ws-rollback',
            deps: {} as RunStepsDeps,
            input: {value: 1},
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const paused = await execution.waitForPause();
    const savepoint = execution.savepoint(paused.continuationId, 'stable');
    const rollback = await execution.rollback(paused.continuationId, savepoint.id);

    assert.deepEqual(rollback, {
        status: 'restored',
        mode: 'noop',
        savepoint,
        world: paused.world,
    });
    assert.equal(execution.transaction(paused.continuationId).effectCount, 0);

    await execution.advance(paused.continuationId, 'continue');
});

test('rollback blocks instead of pretending to restore an executed World effect', async () => {
    const [first, second] = await createViews();
    let current = first;
    let clickCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: `
            click input.target
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-rollback',
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

    const beforeEffect = await execution.waitForPause();
    const savepoint = execution.savepoint(beforeEffect.continuationId, 'before-click');
    const next = await execution.advance(beforeEffect.continuationId, 'continue');
    assert.equal(next.status, 'paused');
    if (next.status !== 'paused') {throw new Error('expected pause after effect');}

    const rollback = await execution.rollback(next.pause.continuationId, savepoint.id);
    assert.equal(rollback.status, 'blocked');
    if (rollback.status !== 'blocked') {throw new Error('expected blocked rollback');}
    assert.equal(rollback.reason, 'effects_require_compensation');
    assert.equal(rollback.effects.length, 1);
    assert.equal(rollback.effects[0].effect.stepName, 'browser.click');
    assert.equal(rollback.diff.ok, true);
    if (rollback.diff.ok) {
        assert.deepEqual(rollback.diff.worldBefore.revision, first.revision);
        assert.deepEqual(rollback.diff.worldAfter.revision, second.revision);
    }
    assert.equal(clickCalls, 1);
    assert.equal(execution.transaction(next.pause.continuationId).effectCount, 1);

    await execution.advance(next.pause.continuationId, 'abort');
});

test('rollback returns not-found without changing the retained continuation', async () => {
    const [view] = await createViews();
    const execution = createDslDebugExecutionSession({
        source: 'output result = input.value',
        context: {
            workspaceName: 'ws-rollback',
            deps: {} as RunStepsDeps,
            input: {value: 1},
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const paused = await execution.waitForPause();
    const rollback = await execution.rollback(paused.continuationId, 'missing');
    assert.deepEqual(rollback, {
        status: 'not_found',
        error: {code: 'ERR_NOT_FOUND', message: 'transaction savepoint not found: missing'},
    });
    assert.deepEqual(execution.transaction(paused.continuationId).current, paused.world);
    await execution.advance(paused.continuationId, 'abort');
});

test('physical rollback refuses unsupported click compensation before executing anything else', async () => {
    const [first, second] = await createViews();
    let current = first;
    let calls = 0;
    const port: StepExecutionPort = {
        execute: async (step) => {
            calls += 1;
            current = second;
            return {stepId: step.id, ok: true, data: {clicked: true}};
        },
    };
    const execution = createDslDebugExecutionSession({
        source: `
            click input.target
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-rollback',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'submit'}, done: true},
            stepExecutionPort: port,
        },
        compensationPort: port,
        worldViewSource: {pin: async () => current},
        debug: {breakBeforeEffects: true, breakpoints: ['body.1']},
    });

    const beforeEffect = await execution.waitForPause();
    const savepoint = execution.savepoint(beforeEffect.continuationId, 'before-click');
    const next = await execution.advance(beforeEffect.continuationId, 'continue');
    assert.equal(next.status, 'paused');
    if (next.status !== 'paused') {throw new Error('expected pause after click');}

    const rollback = await execution.rollback(next.pause.continuationId, savepoint.id, {strategy: 'physical'});
    assert.equal(rollback.status, 'blocked');
    if (rollback.status !== 'blocked') {throw new Error('expected blocked rollback');}
    assert.equal(rollback.reason, 'compensation_unavailable');
    assert.equal(rollback.plans?.[0]?.status, 'unavailable');
    assert.equal(calls, 1);

    await execution.advance(next.pause.continuationId, 'abort');
});
