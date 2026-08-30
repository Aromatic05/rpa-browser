import test from 'node:test';
import assert from 'node:assert/strict';
import {maybePickCheckpoint} from '../../../../src/automation/runner/checkpoint/match';
import {selectRecovery} from '../../../../src/automation/runner/checkpoint/recovery';
import type {RecoveryWorldProbe} from '../../../../src/automation/runner/checkpoint/recovery/types';
import type {FailedCtx} from '../../../../src/automation/runner/failed_ctx';
import type {Checkpoint} from '../../../../src/automation/runner/checkpoint/types';
import type {StepUnion} from '../../../../src/automation/runner/steps/types';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    readResultPipe,
    runSteps,
} from '../../../../src/automation/runner/run_steps';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';

const failure = {
    runId: 'run-1',
    workspaceName: 'ws-1',
    stepId: 's1',
    stepName: 'browser.click',
    args: {selector: '#x'},
    error: {code: 'ERR_NOT_FOUND', message: 'boom'},
    currentUrl: 'https://example.test/path',
};

const world: RecoveryWorldProbe = {
    currentUrl: async () => 'https://example.test/path',
    textVisible: async () => false,
    entityExists: async () => false,
};

const checkpoints = (): Checkpoint[] => [
    {
        id: 'cp-low',
        kind: 'recovery',
        name: 'low',
        priority: 1,
        trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.click'}]},
        policy: {maxAttempts: 1, retryOriginal: true},
        content: [{id: 'low-repair', name: 'browser.fill', args: {selector: '#low', value: 'x'}} as StepUnion],
    },
    {
        id: 'cp-high',
        kind: 'recovery',
        name: 'high',
        priority: 10,
        trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.click'}]},
        policy: {maxAttempts: 1, retryOriginal: true},
        content: [{id: 'high-repair', name: 'browser.fill', args: {selector: '#high', value: 'x'}} as StepUnion],
    },
];

const createFailedCtx = (input: {checkpoints: Checkpoint[]; checkpointMaxAttempts?: number; checkpointAttempts?: Record<string, number>}): FailedCtx => ({
    runId: 'run-1',
    workspaceName: 'ws-1',
    stepIndex: 0,
    step: {id: 's1', name: 'browser.click', args: {selector: '#x'}} as StepUnion,
    rawResult: {stepId: 's1', ok: false, error: {code: 'ERR_NOT_FOUND', message: 'boom'}},
    stopOnError: true,
    checkpointEnabled: true,
    checkpointAttempt: 0,
    checkpointAttempts: input.checkpointAttempts,
    checkpointMaxAttempts: input.checkpointMaxAttempts ?? 2,
    inCheckpointFlow: false,
    deps: {
        runtime: {
            awaitExecutableTab: async () => ({
                traceTools: {
                    'trace.page.getInfo': async () => ({ok: true, data: {url: 'https://example.test/path'}}),
                    'trace.page.evaluate': async () => ({ok: true, data: true}),
                },
            }),
        },
        config: {waitPolicy: {pageReadyTimeoutMs: 1000}} as any,
    } as any,
    executeStep: async (step) => ({stepId: step.id, ok: true}),
    checkpoints: input.checkpoints,
    currentUrl: 'https://example.test/path',
});

test('shared selectRecovery picks the same checkpoint as the ordinary maybePickCheckpoint pipeline', async () => {
    const selection = await selectRecovery({
        checkpoints: checkpoints(),
        failure,
        checkpointEnabled: true,
        checkpointAttempt: 0,
        checkpointMaxAttempts: 2,
        world,
    });
    assert.equal(selection.status, 'matched');
    if (selection.status !== 'matched') {return;}
    assert.equal(selection.checkpoint.id, 'cp-high');

    const ctx = {failedCtx: createFailedCtx({checkpoints: checkpoints()}), active: true, finalResult: {} as never} as any;
    const picked = await maybePickCheckpoint(ctx);
    assert.equal(picked.active, true);
    assert.equal(picked.checkpoint?.id, 'cp-high');
});

test('shared selectRecovery and the ordinary pipeline both block an exhausted maxAttempts checkpoint', async () => {
    const exhausted: Checkpoint[] = [
        {
            id: 'cp-exhausted',
            kind: 'recovery',
            priority: 10,
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.click'}]},
            policy: {maxAttempts: 1, retryOriginal: true},
            content: [],
        },
        {
            id: 'cp-fallback',
            kind: 'recovery',
            priority: 1,
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.click'}]},
            policy: {maxAttempts: 1, retryOriginal: true},
            content: [],
        },
    ];
    const selection = await selectRecovery({
        checkpoints: exhausted,
        failure,
        checkpointEnabled: true,
        checkpointAttempt: 0,
        checkpointAttempts: {'cp-exhausted': 1},
        checkpointMaxAttempts: 2,
        world,
    });
    assert.equal(selection.status, 'matched');
    if (selection.status !== 'matched') {return;}
    assert.equal(selection.checkpoint.id, 'cp-fallback');

    const ctx = {
        failedCtx: createFailedCtx({checkpoints: exhausted, checkpointAttempts: {'cp-exhausted': 1}}),
        active: true,
        finalResult: {} as never,
    } as any;
    const picked = await maybePickCheckpoint(ctx);
    assert.equal(picked.checkpoint?.id, 'cp-fallback');
});

test('a maxAttempts policy of zero excludes a checkpoint in both selection paths', async () => {
    const zero: Checkpoint[] = [{
        id: 'cp-zero',
        kind: 'recovery',
        priority: 10,
        trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.click'}]},
        policy: {maxAttempts: 0, retryOriginal: true},
        content: [],
    }];
    const selection = await selectRecovery({
        checkpoints: zero,
        failure,
        checkpointEnabled: true,
        checkpointAttempt: 0,
        checkpointMaxAttempts: Number.MAX_SAFE_INTEGER,
        world,
    });
    assert.equal(selection.status, 'no_match');

    const ctx = {failedCtx: createFailedCtx({checkpoints: zero, checkpointMaxAttempts: Number.MAX_SAFE_INTEGER}), active: true, finalResult: {} as never} as any;
    const picked = await maybePickCheckpoint(ctx);
    assert.equal(picked.active, false);
    assert.equal(picked.stopReason, 'checkpoint_not_found');
});

test('ordinary runSteps executes a body.dsl recovery checkpoint through the shared executor', async () => {
    let snapshotCalls = 0;
    let clickAttempts = 0;
    const deps = completeRunStepsDeps({
        config: {} as any,
        pluginHost: {
            getExecutors: () => ({
                'browser.click': async (step: StepUnion) => {
                    clickAttempts += 1;
                    return clickAttempts === 1
                        ? {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'boom'}}
                        : {stepId: step.id, ok: true};
                },
                'browser.snapshot': async (step: StepUnion) => {
                    snapshotCalls += 1;
                    return {stepId: step.id, ok: true};
                },
            }) as any,
        } as any,
    });
    const queue = createStepsQueue([{id: 's1', name: 'browser.click', args: {selector: '#x'}} as StepUnion], {closed: true});
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const checkpoint = await runSteps({
        runId: 'run-1',
        workspaceName: 'ws-1',
        stepsQueue: queue,
        resultPipe: pipe,
        signalChannel: signals,
        stopOnError: true,
        checkpoints: [{
            id: 'cp-body',
            kind: 'recovery',
            name: 'body recovery',
            input: {done: true},
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]},
            policy: {maxAttempts: 1, retryOriginal: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        checkpointBodies: {'cp-body': 'snapshot\noutput recovered = input.done'},
        checkpointStepResolves: {},
    }, deps);
    const results = readResultPipe(pipe).items;

    assert.equal(checkpoint.status, 'completed');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(clickAttempts, 2);
    assert.equal(snapshotCalls, 1);
});