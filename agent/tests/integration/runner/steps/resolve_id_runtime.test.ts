import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    readResultPipe,
    runStepList,
    runSteps,
    setRunStepsDeps,
} from '../../../../src/runner/run_steps';
import { loadRunnerConfig } from '../../../../src/config/loader';
import { completeRunStepsDeps } from '../../../helpers/run_steps_workspace';
import type { Checkpoint } from '../../../../src/runner/checkpoint';
import type { RunStepsDeps } from '../../../../src/runner/run_steps';
import type { StepResolve, StepUnion } from '../../../../src/runner/steps/types';
import {executeBrowserCheckpoint} from '../../../../src/runner/steps/executors/checkpoint';

const createRuntime = () => ({
    ensureActivePage: async () => ({
        workspaceName: 'ws-1',
        tabName: 'tk-1',
        page: { url: () => 'https://example.test/page' },
        traceCtx: { cache: {} },
        traceTools: {},
    }),
});

const createDeps = (executors: Record<string, (step: StepUnion) => Promise<any>>): RunStepsDeps => completeRunStepsDeps({
    runtime: createRuntime() as any,
    config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
    pluginHost: {
        getExecutors: () => executors,
    } as any,
});

test('runStepList injects runtime step.resolve from args.resolveId', async () => {
    const observed: StepUnion[] = [];
    const { checkpoint, pipe } = await runStepList(
        'ws-1',
        [
            {
                id: 'click-1',
                name: 'browser.click',
                args: { resolveId: 'resolveSubmit' },
            } as StepUnion,
        ],
        createDeps({
            'browser.click': async (step) => {
                observed.push(step);
                return { stepId: step.id, ok: true };
            },
        }),
        {
            stopOnError: true,
            stepResolves: {
                resolveSubmit: {
                    hint: { raw: { selector: '#submit' } },
                    policy: { requireVisible: true },
                },
            },
        },
    );

    assert.equal(checkpoint.status, 'completed');
    assert.equal(pipe.items[0]?.ok, true);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].resolve?.hint?.raw?.selector, '#submit');
    assert.equal(observed[0].resolve?.policy?.requireVisible, true);
    assert.equal((observed[0].args as { resolveId?: string }).resolveId, undefined);
});

test('runStepList returns ERR_BAD_ARGS for missing or conflicting resolve sources', async () => {
    const deps = createDeps({
        'browser.click': async (step) => ({ stepId: step.id, ok: true }),
        'browser.goto': async (step) => ({ stepId: step.id, ok: true }),
    });

    const missing = await runStepList(
        'ws-1',
        [{ id: 'click-missing', name: 'browser.click', args: { resolveId: 'missing' } } as StepUnion],
        deps,
        { stopOnError: true, stepResolves: {} },
    );
    assert.equal(missing.checkpoint.status, 'failed');
    assert.equal(missing.pipe.items[0]?.error?.code, 'ERR_BAD_ARGS');

    const conflict = await runStepList(
        'ws-1',
        [
            {
                id: 'click-conflict',
                name: 'browser.click',
                args: { resolveId: 'resolveSubmit' },
                resolve: { hint: { raw: { selector: '#submit' } } },
            } as StepUnion,
        ],
        deps,
        {
            stopOnError: true,
            stepResolves: {
                resolveSubmit: { hint: { raw: { selector: '#submit' } } },
            },
        },
    );
    assert.equal(conflict.checkpoint.status, 'failed');
    assert.equal(conflict.pipe.items[0]?.error?.code, 'ERR_BAD_ARGS');

    const unsupported = await runStepList(
        'ws-1',
        [{ id: 'goto-bad', name: 'browser.goto', args: { url: 'https://example.test', resolveId: 'resolveSubmit' } } as any],
        deps,
        {
            stopOnError: true,
            stepResolves: {
                resolveSubmit: { hint: { raw: { selector: '#submit' } } },
            },
        },
    );
    assert.equal(unsupported.checkpoint.status, 'failed');
    assert.equal(unsupported.pipe.items[0]?.error?.code, 'ERR_BAD_ARGS');
});

test('checkpoint act step injects resolve from serialized resolveId sidecar', async () => {
    const observed: StepUnion[] = [];
    let clickAttempts = 0;
    setRunStepsDeps(
        createDeps({
            'browser.click': async (step) => {
                clickAttempts += 1;
                if (step.id === 'seed-click' && clickAttempts === 1) {
                    return { stepId: step.id, ok: false, error: { code: 'ERR_NOT_FOUND', message: 'boom' } };
                }
                observed.push(step);
                return { stepId: step.id, ok: true };
            },
        }),
    );

    const queue = createStepsQueue([{ id: 'seed-click', name: 'browser.click', args: { selector: '#seed' } } as StepUnion]);
    closeStepsQueue(queue);
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const checkpoint = await runSteps({
        runId: 'run-1',
        workspaceName: 'ws-1',
        stepsQueue: queue,
        resultPipe: pipe,
        signalChannel: signals,
        stopOnError: true,
        stepResolves: {
            resolveSubmit: {
                hint: { raw: { selector: '#checkpoint-submit' } },
            },
        },
        checkpoints: [
            {
                id: 'cp-1',
                name: 'recover-click',
                trigger: { matchRules: [{ stepName: 'browser.click' }, { errorCode: 'ERR_NOT_FOUND' }] },
                content: [
                    {
                        type: 'act',
                        step: {
                            name: 'browser.click',
                            args: { resolveId: 'resolveSubmit' },
                        },
                    },
                ],
            } satisfies Checkpoint,
        ],
    });

    const results = readResultPipe(pipe).items;
    assert.equal(checkpoint.status, 'completed');
    assert.equal(results[0]?.ok, true);
    assert.equal(observed.some((step) => step.resolve?.hint?.raw?.selector === '#checkpoint-submit'), true);
});

test('a failing recovery DSL body does not enter recovery again', async () => {
    let clickAttempts = 0;
    const deps = createDeps({
        'browser.click': async (step) => {
            clickAttempts += 1;
            return {stepId: step.id, ok: false, error: {code: 'ERR_CLICK_FAILED', message: 'click failed'}};
        },
    });
    const workspace = deps.resolveWorkspace('ws-1') as any;
    workspace.workflow = {name: 'ws-1'};
    workspace.checkpoint = {
        getProvider: () => ({
            listCheckpoints: () => [{
                id: 'recovery-body', kind: 'recovery',
                trigger: {matchRules: [{errorCode: 'ERR_CLICK_FAILED'}]},
                body: {language: 'dsl', source: 'body.dsl'},
            }],
            getCheckpointResolves: () => ({}),
            getCheckpointBody: () => ({source: 'click failure.step.name', stepResolves: {}}),
        }),
    };
    const queue = createStepsQueue([{id: 'seed-click', name: 'browser.click', args: {}} as StepUnion]);
    closeStepsQueue(queue);
    const pipe = createResultPipe();
    const checkpoint = await runSteps({
        runId: 'run-recovery-body', workspaceName: 'ws-1', stepsQueue: queue,
        resultPipe: pipe, signalChannel: createSignalChannel(), stopOnError: true,
    }, deps);
    assert.equal(checkpoint.status, 'failed');
    assert.equal(clickAttempts, 2);
    assert.equal(pipe.items[0]?.error?.code, 'ERR_CLICK_FAILED');
    assert.deepEqual(pipe.items[0]?.error?.details, {
        cause: {stepId: 'seed-click', error: {code: 'ERR_CLICK_FAILED', message: 'click failed'}},
    });
});

test('runSteps snapshots live checkpoint and workflow DSL assets before recovery', async () => {
    const liveBodies: Record<string, string> = {
        recover: 'use resolves "bundle" as target\nclick target.button\nlet nested = use checkpoint "nested"',
        nested: '',
    };
    const liveResolves: Record<string, Record<string, StepResolve>> = {recover: {}, nested: {}};
    const checkpoints: Checkpoint[] = [
        {id: 'recover', kind: 'recovery', trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]}, policy: {retryOriginal: false}, body: {language: 'dsl', source: 'body.dsl'}},
        {id: 'nested', body: {language: 'dsl', source: 'body.dsl'}},
    ];
    let bundle = {kind: 'dsl' as const, name: 'bundle', content: '', stepResolves: {button: {hint: {raw: {selector: '#snapshot'}}}}};
    const observed: StepUnion[] = [];
    let attempts = 0;
    const deps = createDeps({
        'browser.click': async (step) => {
            attempts += 1;
            if (attempts === 1) {
                liveBodies.recover = 'use resolves "bundle" as target\nclick target.missing';
                liveBodies.nested = 'click input.missing';
                bundle = {...bundle, stepResolves: {button: {hint: {raw: {selector: '#live'}}}}};
                return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'missing'}};
            }
            observed.push(step);
            return {stepId: step.id, ok: true};
        },
    });
    const workspace = deps.resolveWorkspace('ws-1') as any;
    workspace.workflow = {
        name: 'ws-1', list: () => [{kind: 'dsl', name: 'bundle'}], get: () => bundle,
    };
    workspace.checkpoint = {getProvider: () => ({
        listCheckpoints: () => checkpoints,
        getCheckpointResolves: (id: string) => liveResolves[id] || {},
        getCheckpointBody: (id: string) => liveBodies[id] === undefined ? null : {source: liveBodies[id], stepResolves: liveResolves[id] || {}},
    })};
    const queue = createStepsQueue([{id: 'seed', name: 'browser.click', args: {}} as StepUnion]);
    closeStepsQueue(queue);
    const pipe = createResultPipe();
    const completed = await runSteps({runId: 'snapshot', workspaceName: 'ws-1', stepsQueue: queue, resultPipe: pipe, signalChannel: createSignalChannel(), stopOnError: true}, deps);
    assert.equal(completed.status, 'completed', JSON.stringify(pipe.items));
    assert.equal(observed[0]?.resolve?.hint?.raw?.selector, '#snapshot');
});

test('runSteps materializes only recovery-body imports and exposes frozen recovery failure data', async () => {
    let attempts = 0;
    const seen: unknown[] = [];
    const deps = createDeps({
        'browser.click': async (step) => {
            attempts += 1;
            if (attempts === 1) {return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'missing'}};}
            seen.push(step.resolve?.hint?.raw?.selector);
            return {stepId: step.id, ok: true};
        },
    });
    const workspace = deps.resolveWorkspace('ws-1') as any;
    const checkpoint: Checkpoint = {
        id: 'recover', kind: 'recovery', trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]}, policy: {maxAttempts: 2, retryOriginal: false},
        body: {language: 'dsl', source: 'body.dsl'},
    };
    workspace.workflow = {
        name: 'ws-1',
        list: () => {throw new Error('unrelated workflow DSL enumeration must not occur');},
        get: (name: string) => name === 'bundle' ? {kind: 'dsl', name, content: '', stepResolves: {button: {hint: {raw: {selector: '#frozen'}}}}} : null,
    };
    workspace.checkpoint = {getProvider: () => ({
        listCheckpoints: () => [checkpoint],
        getCheckpointResolves: () => ({}),
        getCheckpointBody: () => ({source: 'use resolves "bundle" as target\noutput id = failure.step.id\noutput name = failure.step.name\noutput args = failure.step.args\noutput attempt = failure.attempt\noutput max = failure.maxAttempts\nclick target.button', stepResolves: {}}),
    })};
    deps.resolveEntityRulesProvider = () => ({
        workflowName: 'ws-1', availability: 'ready', listProfiles: () => {throw new Error('profile enumeration must not occur');},
        getProfile: () => null, resolveExports: () => {throw new Error('unrelated profile must not load');},
    } as any);
    const queue = createStepsQueue([{id: 'seed', name: 'browser.click', args: {selector: '#seed'}} as StepUnion]);
    closeStepsQueue(queue);
    const pipe = createResultPipe();
    const completed = await runSteps({runId: 'targeted-snapshot', workspaceName: 'ws-1', stepsQueue: queue, resultPipe: pipe, signalChannel: createSignalChannel(), stopOnError: true, checkpointMaxAttempts: 3}, deps);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(seen, ['#frozen']);
    assert.deepEqual((pipe.items[0]?.data as any).output, {
        id: 'seed', name: 'browser.click', args: {selector: '#seed'}, attempt: 1, max: 2,
    });
});

test('runSteps does not parse an unreferenced preloaded procedure body during recovery snapshot', async () => {
    let attempts = 0;
    const queue = createStepsQueue([{id: 'seed', name: 'browser.click', args: {}} as StepUnion]);
    closeStepsQueue(queue);
    const checkpoint = await runSteps({
        runId: 'unreferenced-procedure', workspaceName: 'ws-1',
        stepsQueue: queue,
        resultPipe: createResultPipe(), signalChannel: createSignalChannel(), stopOnError: true,
        checkpoints: [
            {id: 'recover', kind: 'recovery', trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]}, policy: {retryOriginal: false}, body: {language: 'dsl', source: 'body.dsl'}},
            {id: 'unreferenced', kind: 'procedure', body: {language: 'dsl', source: 'body.dsl'}},
        ],
        checkpointBodies: {recover: 'wait 1', unreferenced: 'this is invalid DSL'},
    }, createDeps({
        'browser.click': async (step) => {
            attempts += 1;
            return attempts === 1
                ? {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'missing'}}
                : {stepId: step.id, ok: true};
        },
    }));
    assert.equal(checkpoint.status, 'completed');
    assert.equal(attempts, 1);
});

test('runSteps traverses and freezes a referenced preloaded nested procedure body', async () => {
    let attempts = 0;
    let selector = '#frozen';
    const observed: string[] = [];
    const deps = createDeps({
        'browser.click': async (step) => {
            attempts += 1;
            if (attempts === 1) {
                selector = '#live';
                return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'missing'}};
            }
            observed.push(String(step.resolve?.hint?.raw?.selector));
            return {stepId: step.id, ok: true};
        },
    });
    const workspace = deps.resolveWorkspace('ws-1') as any;
    workspace.workflow = {
        name: 'ws-1', list: () => [],
        get: (name: string) => name === 'bundle'
            ? {kind: 'dsl', name, content: '', stepResolves: {button: {hint: {raw: {selector}}}}}
            : null,
    };
    const queue = createStepsQueue([{id: 'seed', name: 'browser.click', args: {}} as StepUnion]);
    closeStepsQueue(queue);
    const checkpoint = await runSteps({
        runId: 'preloaded-nested', workspaceName: 'ws-1', stepsQueue: queue,
        resultPipe: createResultPipe(), signalChannel: createSignalChannel(), stopOnError: true,
        checkpoints: [
            {id: 'recover', kind: 'recovery', trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]}, policy: {retryOriginal: false}, body: {language: 'dsl', source: 'body.dsl'}},
            {id: 'nested', kind: 'procedure', body: {language: 'dsl', source: 'body.dsl'}},
        ],
        checkpointBodies: {
            recover: 'let value = use checkpoint "nested"',
            nested: 'use resolves "bundle" as target\nclick target.button',
        },
    }, deps);
    assert.equal(checkpoint.status, 'completed');
    assert.deepEqual(observed, ['#frozen']);
});

test('runSteps snapshots imports for queued procedure calls without parsing unrelated bodies', async () => {
    const observed: StepUnion[] = [];
    const deps = createDeps({
        'browser.checkpoint': executeBrowserCheckpoint as any,
        'browser.query': async (step) => ({stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'query-button'}}),
        'browser.click': async (step) => {
            observed.push(structuredClone(step));
            return {stepId: step.id, ok: true};
        },
    });
    deps.resolveEntityRulesProvider = () => ({
        workflowName: 'ws-1', availability: 'ready', listProfiles: () => ['orders'], getProfile: (name: string) => name === 'orders' ? {} as any : null,
        resolveExports: (name: string) => name === 'orders' ? {
            index: {
                profileName: 'orders',
                entities: [{
                    profileName: 'orders', entityKey: 'ordersQuery', businessTag: 'orders.query', kind: 'form',
                    fields: [], actions: [{actionIntent: 'query', targetKind: 'form.action'}], columns: [], rowActions: [],
                    supportedQueries: ['form.fields', 'form.actions'], members: [{kind: 'action', symbol: 'query'}],
                }],
                resolve: () => undefined,
            },
            diagnostics: [],
        } : {index: null, diagnostics: [{code: 'entity_rule_exports.profile_not_found', message: `missing: ${name}`}]},
    } as any);
    const queue = createStepsQueue([{
        id: 'call-procedure', name: 'browser.checkpoint', args: {checkpointId: 'called-procedure'},
    } as StepUnion]);
    closeStepsQueue(queue);
    const pipe = createResultPipe();
    const completed = await runSteps({
        runId: 'queued-procedure', workspaceName: 'ws-1', stepsQueue: queue,
        resultPipe: pipe, signalChannel: createSignalChannel(), stopOnError: true,
        checkpoints: [
            {id: 'called-procedure', kind: 'procedure', body: {language: 'dsl', source: 'body.dsl'}},
            {id: 'unrelated-procedure', kind: 'procedure', body: {language: 'dsl', source: 'body.dsl'}},
        ],
        checkpointBodies: {
            'called-procedure': 'use entity_rules "orders" as entity\nclick entity.ordersQuery.query',
            'unrelated-procedure': 'this is invalid DSL',
        },
    }, deps);

    assert.equal(completed.status, 'completed', JSON.stringify(pipe.items));
    assert.deepEqual(observed.map((step) => step.args), [{nodeId: 'query-button'}]);
});

test('runSteps executes an injected checkpoint DSL body without a checkpoint provider', async () => {
    const observed: StepUnion[] = [];
    let attempts = 0;
    const queue = createStepsQueue([{id: 'seed', name: 'browser.click', args: {selector: '#seed'}} as StepUnion]);
    closeStepsQueue(queue);
    const checkpoint = await runSteps({
        runId: 'injected-body', workspaceName: 'ws-1', stepsQueue: queue,
        resultPipe: createResultPipe(), signalChannel: createSignalChannel(), stopOnError: true,
        checkpoints: [{
            id: 'recover', kind: 'recovery', body: {language: 'dsl', source: 'body.dsl'},
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]}, policy: {retryOriginal: false},
        }],
        checkpointBodies: {recover: 'use resolves "recover" as target\nclick target.button'},
        checkpointStepResolves: {recover: {button: {hint: {raw: {selector: '#recover'}}}}},
    }, createDeps({
        'browser.click': async (step) => {
            attempts += 1;
            if (attempts === 1) {return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'missing'}};}
            observed.push(step);
            return {stepId: step.id, ok: true};
        },
    }));
    assert.equal(checkpoint.status, 'completed');
    assert.equal(observed[0].resolve?.hint?.raw?.selector, '#recover');
    assert.equal((observed[0].args as {resolveId?: string}).resolveId, undefined);
});

test('run steps request accepts stepResolves typing contract', () => {
    const typed: { stepResolves?: Record<string, StepResolve> } = {
        stepResolves: {
            resolveSubmit: { hint: { raw: { selector: '#submit' } } },
        },
    };
    assert.equal(typed.stepResolves?.resolveSubmit?.hint?.raw?.selector, '#submit');
});
