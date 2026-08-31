import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    readResultPipe,
    runSteps,
    sendSignal,
    setRunStepsDeps,
} from '../../../../src/automation/runner/run_steps';
import { loadRunnerConfig } from '../../../../src/platform/config/loader';
import type { StepResolve, StepUnion } from '../../../../src/automation/runner/steps/types';
import type { Checkpoint } from '../../../../src/automation/runner/checkpoint';
import { completeRunStepsDeps } from '../../../helpers/run_steps_workspace';

const createRuntime = () => ({
    ensureActivePage: async () => ({
        workspaceName: 'ws-1',
        tabName: 'tk-1',
        page: { url: () => 'https://example.test/page' },
        traceCtx: { cache: {} },
        traceTools: {
            'trace.page.getInfo': async () => ({ ok: true, data: { url: 'https://example.test/page' } }),
            'trace.page.evaluate': async () => ({ ok: true, data: true }),
        },
    }),
});

const createDeps = (executors: Record<string, (step: StepUnion) => Promise<any>>) => {
    const deps = completeRunStepsDeps({
        runtime: createRuntime() as any,
        config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
        pluginHost: {
            getExecutors: () => executors,
        } as any,
    });
    setRunStepsDeps(deps);
    return deps;
};

const baseStep = (): StepUnion => ({ id: 's1', name: 'browser.click', args: { selector: '#x' } }) as StepUnion;

const runOne = async (opts: {
    executors: Record<string, (step: StepUnion) => Promise<any>>;
    checkpoints?: Checkpoint[];
    persistedCheckpoints?: Checkpoint[];
    persistedCheckpointResolves?: Record<string, Record<string, StepResolve>>;
    checkpointMaxAttempts?: number;
    onCheckpoint?: (cp: any, signals: any) => void | Promise<void>;
}) => {
    const deps = createDeps(opts.executors);
    if (opts.persistedCheckpoints) {
        const workspace = deps.resolveWorkspace('ws-1') as any;
        workspace.checkpoint = {
            getProvider: () => ({
                getCheckpoint: (id: string) => opts.persistedCheckpoints?.find((item) => item.id === id) ?? null,
                getCheckpointResolves: (id: string) => opts.persistedCheckpointResolves?.[id] ?? null,
                listCheckpoints: () => opts.persistedCheckpoints ?? [],
            }),
        };
    }
    const queue = createStepsQueue([baseStep()], { closed: true });
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const cp = await runSteps(
        {
            runId: 'run-1',
            workspaceName: 'ws-1',
            stepsQueue: queue,
            resultPipe: pipe,
            signalChannel: signals,
            stopOnError: true,
            checkpoints: opts.checkpoints,
            checkpointMaxAttempts: opts.checkpointMaxAttempts,
            onCheckpoint: opts.onCheckpoint ? (next) => opts.onCheckpoint?.(next, signals) : undefined,
        },
        undefined,
    );
    return { cp, results: readResultPipe(pipe).items };
};

test('failed step without checkpoint stays failed', async () => {
    const { cp, results } = await runOne({
        executors: {
            'browser.click': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } }),
        },
    });

    assert.equal(cp.status, 'failed');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error?.code, 'ERR_NOT_FOUND');
});

test('invalid run recovery budgets fail before executing page side effects', async () => {
    let calls = 0;
    const {cp, results} = await runOne({
        executors: {
            'browser.click': async (step) => {
                calls += 1;
                return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'missing'}};
            },
        },
        checkpointMaxAttempts: Number.POSITIVE_INFINITY,
    });

    assert.equal(cp.status, 'failed');
    assert.equal(results.length, 0);
    assert.equal(calls, 0);
});

test('directly injected malformed checkpoints fail before executing the original step', async () => {
    let calls = 0;
    const {cp, results} = await runOne({
        executors: {
            'browser.click': async (step) => {
                calls += 1;
                return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'missing'}};
            },
        },
        checkpoints: [{
            id: 'invalid-runtime-checkpoint',
            kind: 'recovery',
            enabled: 'false',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]},
            content: [],
        } as any],
    });

    assert.equal(cp.status, 'failed');
    assert.equal(results.length, 0);
    assert.equal(calls, 0);
});

test('failed step loads persisted checkpoints when request does not override candidates', async () => {
    let clickAttempts = 0;
    const {cp, results} = await runOne({
        executors: {
            'browser.click': async (step) => {
                clickAttempts += 1;
                return clickAttempts === 1
                    ? {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'boom'}}
                    : {stepId: step.id, ok: true};
            },
            'browser.fill': async (step) => ({stepId: step.id, ok: true}),
        },
        persistedCheckpoints: [{
            id: 'persisted-recovery',
            name: 'persisted recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]},
            content: [{id: 'repair', name: 'browser.fill', args: {selector: '#repair', value: 'done'}} as StepUnion],
        }],
    });
    assert.equal(cp.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.equal(clickAttempts, 2);
});

test('retrying the original step re-enters recovery until the selected checkpoint budget succeeds', async () => {
    let clickAttempts = 0;
    let recoveryAttempts = 0;
    const {cp, results} = await runOne({
        executors: {
            'browser.click': async (step) => {
                clickAttempts += 1;
                return clickAttempts >= 3
                    ? {stepId: step.id, ok: true, data: {attempt: clickAttempts}}
                    : {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: `missing-${clickAttempts}`}};
            },
            'browser.fill': async (step) => {
                recoveryAttempts += 1;
                return {stepId: step.id, ok: true};
            },
        },
        checkpoints: [{
            id: 'retry-twice',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]},
            content: [{id: 'repair', name: 'browser.fill', args: {selector: '#repair', value: 'done'}} as StepUnion],
            policy: {maxAttempts: 2, retryOriginal: true},
        }],
    });

    assert.equal(cp.status, 'completed');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.deepEqual(results[0].data, {attempt: 3});
    assert.equal(clickAttempts, 3);
    assert.equal(recoveryAttempts, 2);
});

test('an explicit run cap limits a larger checkpoint recovery budget', async () => {
    let clickAttempts = 0;
    let recoveryAttempts = 0;
    const {cp, results} = await runOne({
        executors: {
            'browser.click': async (step) => {
                clickAttempts += 1;
                return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'still missing'}};
            },
            'browser.fill': async (step) => {
                recoveryAttempts += 1;
                return {stepId: step.id, ok: true};
            },
        },
        checkpoints: [{
            id: 'capped-recovery',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]},
            content: [{id: 'repair', name: 'browser.fill', args: {selector: '#repair', value: 'done'}} as StepUnion],
            policy: {maxAttempts: 3, retryOriginal: true},
        }],
        checkpointMaxAttempts: 1,
    });

    assert.equal(cp.status, 'failed');
    assert.equal(results[0].ok, false);
    assert.equal(clickAttempts, 2);
    assert.equal(recoveryAttempts, 1);
});

test('an explicit timeout recovery can repair and retry the failed step', async () => {
    let clickAttempts = 0;
    let recoveryAttempts = 0;
    const {cp, results} = await runOne({
        executors: {
            'browser.click': async (step) => {
                clickAttempts += 1;
                return clickAttempts === 1
                    ? {stepId: step.id, ok: false, error: {code: 'ERR_TIMEOUT', message: 'network timeout'}}
                    : {stepId: step.id, ok: true};
            },
            'browser.fill': async (step) => {
                recoveryAttempts += 1;
                return {stepId: step.id, ok: true};
            },
        },
        checkpoints: [{
            id: 'timeout-recovery',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_TIMEOUT'}]},
            content: [{id: 'repair-network', name: 'browser.fill', args: {selector: '#network', value: 'ready'}} as StepUnion],
            policy: {maxAttempts: 1, retryOriginal: true},
        }],
    });

    assert.equal(cp.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.equal(clickAttempts, 2);
    assert.equal(recoveryAttempts, 1);
});

test('empty checkpoint triggers never become implicit catch-all recovery', async () => {
    for (const checkpoint of [
        {
            id: 'legacy-procedure',
            content: [{id: 'repair', name: 'browser.fill', args: {selector: '#repair', value: 'done'}} as StepUnion],
            trigger: {matchRules: []},
            policy: {retryOriginal: false},
        },
        {
            id: 'invalid-recovery',
            kind: 'recovery' as const,
            content: [{id: 'repair', name: 'browser.fill', args: {selector: '#repair', value: 'done'}} as StepUnion],
            trigger: {matchRules: []},
            policy: {retryOriginal: false},
        },
    ]) {
        let recoveryCalls = 0;
        const {cp, results} = await runOne({
            executors: {
                'browser.click': async (step) => ({
                    stepId: step.id,
                    ok: false,
                    error: {code: 'ERR_NOT_FOUND', message: 'missing'},
                }),
                'browser.fill': async (step) => {
                    recoveryCalls += 1;
                    return {stepId: step.id, ok: true};
                },
            },
            checkpoints: [checkpoint],
        });

        assert.equal(cp.status, 'failed');
        if (checkpoint.kind === 'recovery') {
            assert.equal(results.length, 0);
        } else {
            assert.equal(results[0].ok, false);
        }
        assert.equal(recoveryCalls, 0);
    }
});

test('persisted recovery uses its own resolve sidecar', async () => {
    let clickAttempts = 0;
    let observedResolveSelector: string | undefined;
    const {cp, results} = await runOne({
        executors: {
            'browser.click': async (step) => {
                clickAttempts += 1;
                return clickAttempts === 1
                    ? {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'boom'}}
                    : {stepId: step.id, ok: true};
            },
            'browser.fill': async (step) => {
                observedResolveSelector = step.resolve?.hint?.raw?.selector;
                return {stepId: step.id, ok: true};
            },
        },
        persistedCheckpoints: [{
            id: 'persisted-recovery',
            kind: 'recovery',
            name: 'persisted recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]},
            content: [{
                id: 'repair',
                name: 'browser.fill',
                args: {resolveId: 'repair-target', value: 'done'},
            } as StepUnion],
        }],
        persistedCheckpointResolves: {
            'persisted-recovery': {
                'repair-target': {hint: {raw: {selector: '#repair'}}},
            },
        },
    });
    assert.equal(cp.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.equal(clickAttempts, 2);
    assert.equal(observedResolveSelector, '#repair');
});

test('failed step hits checkpoint, content success, original step retry succeeds', async () => {
    const calls: string[] = [];
    let clickAttempts = 0;
    const { cp, results } = await runOne({
        executors: {
            'browser.click': async (step) => {
                clickAttempts += 1;
                calls.push(`click:${clickAttempts}`);
                if (clickAttempts === 1) {
                    return { stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } };
                }
                return { stepId: step.id, ok: true, data: { retried: true } };
            },
            'browser.fill': async (step) => {
                calls.push('fill');
                return { stepId: step.id, ok: true };
            },
        },
        checkpoints: [
            {
                id: 'cp-1',
                name: 'recover-click',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-1', name: 'browser.fill', args: { selector: '#x', value: 'fix' } } as StepUnion],
            },
        ],
    });

    assert.equal(cp.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.deepEqual(calls, ['click:1', 'fill', 'click:2']);
});

test('failed step hits checkpoint but content fails, remains failed', async () => {
    const { cp, results } = await runOne({
        executors: {
            'browser.click': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } }),
            'browser.fill': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'cp fail' } }),
        },
        checkpoints: [
            {
                id: 'cp-1',
                name: 'recover-click',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-1', name: 'browser.fill', args: { selector: '#x', value: 'fix' } } as StepUnion],
            },
        ],
    });

    assert.equal(cp.status, 'failed');
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error?.code, 'ERR_NOT_FOUND');
});

test('failed step hits checkpoint but assert step fails, remains failed', async () => {
    const { cp, results } = await runOne({
        executors: {
            'browser.click': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } }),
            'browser.assert': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_CHECKPOINT_ASSERT_FAILED', message: 'assert fail' } }),
        },
        checkpoints: [
            {
                id: 'cp-1',
                name: 'recover-click',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-assert', name: 'browser.assert', args: { textVisible: 'x' } } as StepUnion],
            },
        ],
    });

    assert.equal(cp.status, 'failed');
    assert.equal(results[0].ok, false);
});

test('checkpoint can request suspend and runner enters suspended', async () => {
    const statuses: string[] = [];
    createDeps({
        'browser.click': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } }),
        'browser.fill': async (step) => ({ stepId: step.id, ok: false, error: { code: 'ERR_CHECKPOINT_SUSPEND', message: 'pause' } }),
    });

    const queue = createStepsQueue([baseStep()], { closed: true });
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const loop = runSteps({
        runId: 'run-suspend',
        workspaceName: 'ws-1',
        stepsQueue: queue,
        resultPipe: pipe,
        signalChannel: signals,
        stopOnError: true,
        checkpoints: [
            {
                id: 'cp-suspend',
                name: 'suspend-checkpoint',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-suspend', name: 'browser.fill', args: { selector: '#x', value: 'fix' } } as StepUnion],
            },
        ],
        onCheckpoint: async (cp) => {
            statuses.push(cp.status);
            if (cp.status === 'suspended') {
                sendSignal(signals, 'halt');
            }
        },
    });

    const cp = await loop;
    const results = readResultPipe(pipe).items;

    assert.equal(statuses.includes('suspended'), true);
    assert.equal(cp.status, 'halted');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
});

test('failed step can return checkpoint result without retrying original step', async () => {
    const calls: string[] = [];
    const { cp, results } = await runOne({
        executors: {
            'browser.click': async (step) => {
                calls.push(`click:${step.id}`);
                return { stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } };
            },
            'browser.fill': async (step) => {
                calls.push(`fill:${step.id}`);
                return { stepId: step.id, ok: true, data: { patched: true } };
            },
        },
        checkpoints: [
            {
                id: 'cp-no-retry',
                name: 'recover-click-no-retry',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-1', name: 'browser.fill', args: { selector: '#x', value: 'fix' } } as StepUnion],
                policy: {
                    retryOriginal: false,
                },
            },
        ],
    });

    assert.equal(cp.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.deepEqual(results[0].data, {
        checkpointId: 'cp-no-retry',
        checkpointName: 'recover-click-no-retry',
    });
    assert.deepEqual(calls, ['click:s1', 'fill:cp-step-1']);
});

test('checkpoint attempt budgets are isolated per queued step occurrence', async () => {
    const calls: string[] = [];
    createDeps({
        'browser.click': async (step) => {
            calls.push(`click:${step.id}`);
            return { stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } };
        },
        'browser.fill': async (step) => {
            calls.push(`fill:${step.id}`);
            return { stepId: step.id, ok: true, data: { patched: true } };
        },
    });

    const repeatedStep = baseStep();
    const queue = createStepsQueue([repeatedStep, { ...repeatedStep }], { closed: true });
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const cp = await runSteps({
        runId: 'run-max-attempts',
        workspaceName: 'ws-1',
        stepsQueue: queue,
        resultPipe: pipe,
        signalChannel: signals,
        stopOnError: false,
        checkpoints: [
            {
                id: 'cp-max-attempts',
                name: 'recover-click-once',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [{ id: 'cp-step-1', name: 'browser.fill', args: { selector: '#x', value: 'fix' } } as StepUnion],
                policy: {
                    maxAttempts: 1,
                    retryOriginal: false,
                },
            },
        ],
    });
    const results = readResultPipe(pipe).items;

    assert.equal(cp.status, 'completed');
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, true);
    assert.deepEqual(calls, ['click:s1', 'fill:cp-step-1', 'click:s1', 'fill:cp-step-1']);
});
