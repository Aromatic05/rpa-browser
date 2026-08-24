import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../../src/agent/debug/execution/dsl_session';
import type {WorldView} from '../../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../../src/automation/snapshot';
import type {RuntimeStateRecord} from '../../../../../../src/automation/snapshot/observation/model/contracts';
import type {RunStepsDeps} from '../../../../../../src/automation/runner/run_steps';
import type {StepExecutionPort} from '../../../../../../src/automation/dsl/runtime/run_dsl';
import {createV2BusinessPage} from '../../../../../helpers/v2_business_page';

const withRuntimeValue = (view: WorldView, nodeId: string, value: string, captureRevision: number): WorldView => {
    const entry = structuredClone(view.entry);
    const runtimeState = entry.capture.control.observation.runtimeState as unknown as Record<
        string,
        RuntimeStateRecord | undefined
    >;
    runtimeState[nodeId] = {stateId: `state:${nodeId}`, value};
    const identity = entry.capture.control.observation.identity as unknown as {captureRevision: number};
    identity.captureRevision = captureRevision;
    return Object.freeze({
        ...view,
        revision: Object.freeze({...view.revision, captureRevision}),
        entry,
    });
};

const createViews = async (): Promise<[WorldView, WorldView, WorldView]> => {
    const store = new PageSnapshotSessionStore<object>();
    const fixture = createV2BusinessPage();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const base: WorldView = Object.freeze({
        workspaceName: 'ws-compensation',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    return [
        withRuntimeValue(base, 'buyer-input', 'old value', 1),
        withRuntimeValue(base, 'buyer-input', 'new value', 2),
        withRuntimeValue(base, 'buyer-input', 'old value', 3),
    ];
};

test('physical fill compensation executes as a journaled World effect without claiming semantic restore', async () => {
    const [before, afterFill, afterCompensation] = await createViews();
    let current = before;
    const values: string[] = [];
    const port: StepExecutionPort = {
        execute: async (step) => {
            if (step.name !== 'browser.fill') {throw new Error(`unexpected step: ${step.name}`);}
            values.push(step.args.value);
            current = step.args.value === 'new value' ? afterFill : afterCompensation;
            return {stepId: step.id, ok: true, data: {filled: true}};
        },
    };
    const execution = createDslDebugExecutionSession({
        source: `
            fill input.target with input.value
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-compensation',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'buyer-input'}, value: 'new value', done: true},
            stepExecutionPort: port,
        },
        compensationPort: port,
        worldViewSource: {pin: async () => current},
        debug: {breakBeforeEffects: true, breakpoints: ['body.1']},
    });

    const beforeEffect = await execution.waitForPause();
    const savepoint = execution.savepoint(beforeEffect.continuationId, 'before-fill');
    const next = await execution.advance(beforeEffect.continuationId, 'continue');
    assert.equal(next.status, 'paused');
    if (next.status !== 'paused') {throw new Error('expected pause after fill');}
    assert.deepEqual(values, ['new value']);

    const rollback = await execution.rollback(next.pause.continuationId, savepoint.id, {strategy: 'physical'});
    assert.equal(rollback.status, 'compensated');
    if (rollback.status !== 'compensated') {throw new Error('expected compensated rollback');}
    assert.equal(rollback.semanticRisk, 'unknown');
    assert.equal(rollback.mode, 'physical');
    assert.equal(rollback.compensations.length, 1);
    assert.equal(rollback.compensations[0].compensates?.effectSequence, 1);
    assert.deepEqual(rollback.compensations[0].effect.args, {nodeId: 'buyer-input', value: 'old value'});
    assert.deepEqual(rollback.world.revision, afterCompensation.revision);
    assert.equal(rollback.residualDiff.ok, true);
    assert.deepEqual(values, ['new value', 'old value']);

    const effects = execution.effects(next.pause.continuationId);
    assert.equal(effects.length, 2);
    assert.equal(effects[0].effect.stepName, 'browser.fill');
    assert.equal(effects[0].compensates, undefined);
    assert.deepEqual(effects[1].compensates, {effectSequence: 1});
    assert.equal(execution.transaction(next.pause.continuationId).effectCount, 2);

    await execution.advance(next.pause.continuationId, 'abort');
});

test('physical rollback stays blocked when no explicit compensation executor is configured', async () => {
    const [before, afterFill] = await createViews();
    let current = before;
    const execution = createDslDebugExecutionSession({
        source: `
            fill input.target with input.value
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-compensation',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'buyer-input'}, value: 'new value', done: true},
            stepExecutionPort: {
                execute: async (step) => {
                    current = afterFill;
                    return {stepId: step.id, ok: true, data: {filled: true}};
                },
            },
        },
        worldViewSource: {pin: async () => current},
        debug: {breakBeforeEffects: true, breakpoints: ['body.1']},
    });

    const beforeEffect = await execution.waitForPause();
    const savepoint = execution.savepoint(beforeEffect.continuationId, 'before-fill');
    const next = await execution.advance(beforeEffect.continuationId, 'continue');
    assert.equal(next.status, 'paused');
    if (next.status !== 'paused') {throw new Error('expected pause after fill');}

    const rollback = await execution.rollback(next.pause.continuationId, savepoint.id, {strategy: 'physical'});
    assert.equal(rollback.status, 'blocked');
    if (rollback.status !== 'blocked') {throw new Error('expected blocked rollback');}
    assert.equal(rollback.reason, 'compensation_executor_unavailable');
    assert.equal(execution.effects(next.pause.continuationId).length, 1);

    await execution.advance(next.pause.continuationId, 'abort');
});

test('failed physical compensation is journaled and returns partial instead of restored', async () => {
    const [before, afterFill, afterCompensation] = await createViews();
    let current = before;
    const values: string[] = [];
    let compensationAttempts = 0;
    const programPort: StepExecutionPort = {
        execute: async (step) => {
            if (step.name !== 'browser.fill') {throw new Error(`unexpected step: ${step.name}`);}
            values.push(step.args.value);
            current = afterFill;
            return {stepId: step.id, ok: true, data: {filled: true}};
        },
    };
    const compensationPort: StepExecutionPort = {
        execute: async (step) => {
            if (step.name !== 'browser.fill') {throw new Error(`unexpected step: ${step.name}`);}
            values.push(step.args.value);
            current = afterCompensation;
            compensationAttempts += 1;
            if (compensationAttempts > 1) {
                return {stepId: step.id, ok: true, data: {filled: true}};
            }
            return {
                stepId: step.id,
                ok: false,
                error: {code: 'ERR_COMPENSATION_FAILED', message: 'restore rejected'},
            };
        },
    };
    const execution = createDslDebugExecutionSession({
        source: `
            fill input.target with input.value
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-compensation',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'buyer-input'}, value: 'new value', done: true},
            stepExecutionPort: programPort,
        },
        compensationPort,
        worldViewSource: {pin: async () => current},
        debug: {breakBeforeEffects: true, breakpoints: ['body.1']},
    });

    const beforeEffect = await execution.waitForPause();
    const savepoint = execution.savepoint(beforeEffect.continuationId, 'before-fill');
    const next = await execution.advance(beforeEffect.continuationId, 'continue');
    assert.equal(next.status, 'paused');
    if (next.status !== 'paused') {throw new Error('expected pause after fill');}

    const rollback = await execution.rollback(next.pause.continuationId, savepoint.id, {strategy: 'physical'});
    assert.equal(rollback.status, 'partial');
    if (rollback.status !== 'partial') {throw new Error('expected partial rollback');}
    assert.equal(rollback.semanticRisk, 'unknown');
    assert.equal(rollback.failure.code, 'ERR_COMPENSATION_FAILED');
    assert.equal(rollback.compensations.length, 1);
    assert.deepEqual(rollback.compensations[0].outcome, {
        status: 'failed',
        error: {code: 'ERR_COMPENSATION_FAILED', message: 'restore rejected'},
    });
    assert.deepEqual(values, ['new value', 'old value']);
    assert.equal(execution.effects(next.pause.continuationId).length, 2);

    const retry = await execution.rollback(next.pause.continuationId, savepoint.id, {strategy: 'physical'});
    assert.equal(retry.status, 'compensated');
    if (retry.status !== 'compensated') {throw new Error('expected compensation retry to succeed');}
    assert.equal(retry.compensations.length, 1);
    assert.equal(retry.compensations[0].outcome.status, 'succeeded');
    assert.deepEqual(retry.compensations[0].compensates, {effectSequence: 1});
    assert.deepEqual(values, ['new value', 'old value', 'old value']);
    assert.equal(execution.effects(next.pause.continuationId).length, 3);

    await execution.advance(next.pause.continuationId, 'abort');
});

test('partial multi-effect rollback retries only uncompensated effects in LIFO order', async () => {
    const [before] = await createViews();
    const afterFirst = withRuntimeValue(before, 'buyer-input', 'middle value', 2);
    const afterSecond = withRuntimeValue(before, 'buyer-input', 'new value', 3);
    const afterSecondCompensation = withRuntimeValue(before, 'buyer-input', 'middle value', 4);
    const afterFirstCompensation = withRuntimeValue(before, 'buyer-input', 'old value', 5);
    let current = before;
    const programValues: string[] = [];
    const compensationValues: string[] = [];
    let oldValueAttempts = 0;
    const programPort: StepExecutionPort = {
        execute: async (step) => {
            if (step.name !== 'browser.fill') {throw new Error(`unexpected step: ${step.name}`);}
            programValues.push(step.args.value);
            current = step.args.value === 'middle value' ? afterFirst : afterSecond;
            return {stepId: step.id, ok: true, data: {filled: true}};
        },
    };
    const compensationPort: StepExecutionPort = {
        execute: async (step) => {
            if (step.name !== 'browser.fill') {throw new Error(`unexpected step: ${step.name}`);}
            compensationValues.push(step.args.value);
            if (step.args.value === 'middle value') {
                current = afterSecondCompensation;
                return {stepId: step.id, ok: true, data: {filled: true}};
            }
            oldValueAttempts += 1;
            if (oldValueAttempts === 1) {
                current = afterSecondCompensation;
                return {
                    stepId: step.id,
                    ok: false,
                    error: {code: 'ERR_COMPENSATION_FAILED', message: 'old value restore rejected'},
                };
            }
            current = afterFirstCompensation;
            return {stepId: step.id, ok: true, data: {filled: true}};
        },
    };
    const execution = createDslDebugExecutionSession({
        source: `
            fill input.target with input.first
            fill input.target with input.second
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-compensation',
            deps: {} as RunStepsDeps,
            input: {
                target: {nodeId: 'buyer-input'},
                first: 'middle value',
                second: 'new value',
                done: true,
            },
            stepExecutionPort: programPort,
        },
        compensationPort,
        worldViewSource: {pin: async () => current},
        debug: {breakBeforeEffects: true, breakpoints: ['body.2']},
    });

    const beforeFirst = await execution.waitForPause();
    const savepoint = execution.savepoint(beforeFirst.continuationId, 'before-fills');
    const beforeSecond = await execution.advance(beforeFirst.continuationId, 'continue');
    assert.equal(beforeSecond.status, 'paused');
    if (beforeSecond.status !== 'paused') {throw new Error('expected pause before second fill');}
    const afterEffects = await execution.advance(beforeSecond.pause.continuationId, 'continue');
    assert.equal(afterEffects.status, 'paused');
    if (afterEffects.status !== 'paused') {throw new Error('expected pause after fills');}
    assert.deepEqual(programValues, ['middle value', 'new value']);

    const firstRollback = await execution.rollback(
        afterEffects.pause.continuationId,
        savepoint.id,
        {strategy: 'physical'},
    );
    assert.equal(firstRollback.status, 'partial');
    if (firstRollback.status !== 'partial') {throw new Error('expected partial rollback');}
    assert.equal(firstRollback.compensations.length, 2);
    assert.deepEqual(
        firstRollback.compensations.map((record) => ({
            for: record.compensates?.effectSequence,
            status: record.outcome.status,
        })),
        [
            {for: 2, status: 'succeeded'},
            {for: 1, status: 'failed'},
        ],
    );
    assert.deepEqual(compensationValues, ['middle value', 'old value']);

    const retry = await execution.rollback(
        afterEffects.pause.continuationId,
        savepoint.id,
        {strategy: 'physical'},
    );
    assert.equal(retry.status, 'compensated');
    if (retry.status !== 'compensated') {throw new Error('expected retry compensation');}
    assert.deepEqual(retry.compensations.map((record) => record.compensates?.effectSequence), [1]);
    assert.deepEqual(compensationValues, ['middle value', 'old value', 'old value']);
    assert.deepEqual(retry.world.revision, afterFirstCompensation.revision);

    await execution.advance(afterEffects.pause.continuationId, 'abort');
});
