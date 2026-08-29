import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceProgramExecutor} from '../../../../src/agent/workspace/program_executor';
import type {WorldView} from '../../../../src/agent/worldview/contracts';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps';
import type {StepUnion} from '../../../../src/automation/runner/steps/types';
import {PageSnapshotSessionStore} from '../../../../src/automation/snapshot';
import {
    createCredentialRef,
    createMemoryCredentialResolver,
    serializeCredentialRef,
    type CredentialResolver,
} from '../../../../src/security/credentials';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const CANARY = 'tok_canary_3f9a2c_d0e1f2';

const apiTokenRef = () => createCredentialRef({id: 'env:API_TOKEN', kind: 'token', provider: 'env'});
const missingRef = () => createCredentialRef({id: 'env:MISSING', kind: 'token', provider: 'env'});

const resolvable = () => createMemoryCredentialResolver({'env:API_TOKEN': CANARY});

const countingResolver = (resolvedIds: string[]): CredentialResolver => ({
    ...resolvable(),
    resolve: async (ref) => {
        resolvedIds.push(ref.id);
        return await resolvable().resolve(ref);
    },
    has: (ref) => resolvable().has(ref),
    describe: (ref) => resolvable().describe(ref),
});

type StubCall = {
    name: string;
    args: Record<string, unknown>;
};

const createStubWorldView = async (
    runtimeState?: Record<string, {value?: string; contentEditableText?: string}>,
): Promise<WorldView> => {
    const fixture = createV2BusinessPage();
    const capture = runtimeState
        ? structuredClone(fixture.capture)
        : fixture.capture;
    if (runtimeState) {
        const observation = capture.control.observation as unknown as {runtimeState: Record<string, unknown>};
        observation.runtimeState = {...observation.runtimeState, ...runtimeState};
    }
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => capture,
    });
    return Object.freeze({
        workspaceName: 'ws-cred',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

const createHarness = async (options: {
    executorCalls: StubCall[];
    credentialResolver?: CredentialResolver;
    runtimeState?: Record<string, {value?: string; contentEditableText?: string}>;
}) => {
    const calls = options.executorCalls;
    const pluginHost = {
        getExecutors: () => ({
            'browser.fill': async (step: StepUnion) => {
                calls.push({name: step.name, args: step.args as unknown as Record<string, unknown>});
                return {stepId: step.id, ok: true, data: {filled: true}};
            },
            'browser.query': async (step: StepUnion) => {
                calls.push({name: step.name, args: step.args as unknown as Record<string, unknown>});
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'buyer', meta: {}}};
            },
        }) as unknown as RunStepsDeps['pluginHost']['getExecutors'],
    };
    const deps = completeRunStepsDeps({pluginHost} as any);
    const emptyProvider = {
        getCheckpoint: () => null,
        getCheckpointResolves: () => null,
        getCheckpointBody: () => null,
        listCheckpoints: () => [],
    };
    deps.resolveWorkspace = (name: string) => ({
        name,
        workflow: {name},
        checkpoint: {getProvider: () => emptyProvider},
        entityRules: {getProvider: () => null},
        tabs: {getActiveTab: () => ({name: 'tab-1', page: {url: () => '/orders'}})},
        browserSession: {pageRegistry: {}},
    }) as unknown as RunStepsDeps['resolveWorkspace'] extends (name: string) => infer W ? W : never;
    const worldView = await createStubWorldView(options.runtimeState);
    const executor = createWorkspaceProgramExecutor({
        workspaceName: 'ws-cred',
        deps,
        runWorkspaceExecution: async (_actionType, run) => await run(),
        credentialResolver: options.credentialResolver,
        worldViewSource: {pin: async () => worldView},
    });
    return {
        executor,
        refString: () => serializeCredentialRef(apiTokenRef()),
    };
};

test('the canary secret reaches the workspace mutation executor exactly once and never enters retained program state', async () => {
    const executorCalls: StubCall[] = [];
    const resolvedIds: string[] = [];
    const harness = await createHarness({
        executorCalls,
        credentialResolver: countingResolver(resolvedIds),
    });
    const refString = harness.refString();

    const start = await harness.executor({
        source: 'fill input.target with input.value',
        input: {target: {nodeId: 'buyer'}, value: refString},
    });

    assert.equal(start.summary.status, 'paused');
    assert.deepEqual(resolvedIds, [], 'no credential may be resolved before the mutation boundary');
    assert.ok(!JSON.stringify(start.summary).includes(CANARY));
    assert.deepEqual(start.summary.input, {target: {nodeId: 'buyer'}, value: refString});

    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;
    assert.equal(pause.reason, 'barrier');
    assert.ok(!JSON.stringify(pause).includes(CANARY), 'paused debug scope must stay reference-only');
    if (pause.reason !== 'barrier') {throw new Error('expected barrier pause');}
    assert.equal(pause.scope.input.value as string, refString);
    assert.equal((pause.effect.args as {value?: string}).value, refString);

    assert.ok(!JSON.stringify(session.auditEffects()).includes(CANARY));
    assert.ok(!JSON.stringify(session.history(pause.continuationId)).includes(CANARY));
    assert.ok(!session.materializeProgram().includes(CANARY));
    assert.ok(!JSON.stringify(session.explain(pause.continuationId, 'input.value')).includes(CANARY));

    const anchor = pause.rollbackAnchor;
    if (anchor) {
        const savepoint = session.executionSavepoint(pause.continuationId, anchor.id);
        assert.ok(savepoint, 'expected an execution savepoint at the effect barrier');
        if (savepoint) {
            assert.ok(!JSON.stringify(savepoint).includes(CANARY), 'savepoint scope must stay reference-only');
        }
    }
    assert.ok(!JSON.stringify(session.transaction(pause.continuationId)).includes(CANARY));

    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'completed');
    assert.deepEqual(resolvedIds, ['env:API_TOKEN']);
    assert.equal(executorCalls.length, 1);
    assert.deepEqual(executorCalls[0], {name: 'browser.fill', args: {nodeId: 'buyer', value: CANARY}});
});

test('an unresolvable ref blocks the mutation before the browser step', async () => {
    const executorCalls: StubCall[] = [];
    const harness = await createHarness({
        executorCalls,
        credentialResolver: createMemoryCredentialResolver({}),
    });

    const start = await harness.executor({
        source: 'fill input.target with input.token',
        input: {target: {nodeId: 'buyer'}, token: serializeCredentialRef(missingRef())},
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;
    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'paused');
    if (crossed.status !== 'paused') {throw new Error('expected a failure pause');}
    assert.equal(crossed.pause.reason, 'failure');
    if (crossed.pause.reason !== 'failure') {throw new Error('expected failure pause');}
    assert.equal(crossed.pause.failure.code, 'ERR_SECURITY_CREDENTIAL_NOT_FOUND');
    assert.ok(!JSON.stringify(crossed.pause).includes(CANARY));
    assert.deepEqual(executorCalls, [], 'the browser step must never run for an unresolvable ref');

    await session.advance(crossed.pause.continuationId, 'abort');
    assert.deepEqual(executorCalls, [], 'aborting must not replay the blocked step');
});

test('an unresolvable ref mid-program never repeats earlier side effects', async () => {
    const executorCalls: StubCall[] = [];
    const harness = await createHarness({executorCalls, credentialResolver: resolvable()});

    const start = await harness.executor({
        source: `
            fill input.a with input.username
            fill input.b with input.token
        `,
        input: {
            a: {nodeId: 'buyer'},
            username: 'alice',
            b: {nodeId: 'submit'},
            token: serializeCredentialRef(missingRef()),
        },
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;

    let current = pause;
    let failure: Extract<typeof pause, {reason: 'failure'}> | null = null;
    for (let index = 0; index < 3; index += 1) {
        const crossed = await session.crossBarrier(current.continuationId);
        if (crossed.status === 'paused') {
            if (crossed.pause.reason === 'failure') {
                failure = crossed.pause as Extract<typeof pause, {reason: 'failure'}>;
                break;
            }
            current = crossed.pause;
            continue;
        }
        if (crossed.status === 'completed' || crossed.status === 'failed') {break;}
        throw new Error(`unexpected advance status: ${crossed.status}`);
    }

    assert.ok(failure, 'expected the second statement to fail on its unresolvable ref');
    if (!failure) {throw new Error('missing failure pause');}
    assert.equal(failure.failure.code, 'ERR_SECURITY_CREDENTIAL_NOT_FOUND');
    assert.deepEqual(executorCalls, [{
        name: 'browser.fill',
        args: {nodeId: 'buyer', value: 'alice'},
    }], 'only the resolvable first effect may reach the mutation executor');
    assert.ok(!JSON.stringify(executorCalls).includes(CANARY));
    assert.ok(!JSON.stringify(session.history(failure.continuationId)).includes(CANARY));
    assert.ok(!JSON.stringify(session.auditEffects()).includes(CANARY));

    await session.advance(failure.continuationId, 'abort');
    assert.equal(executorCalls.length, 1, 'aborting after the failure must not replay earlier effects');
});

test('ordinary scalar input passes through the workspace executor unchanged and never touches the resolver', async () => {
    const executorCalls: StubCall[] = [];
    const resolver: CredentialResolver = {
        resolve: async () => {throw new Error('resolve must not be called for scalar input');},
        has: () => {throw new Error('has must not be called for scalar input');},
        describe: () => '',
    };
    const harness = await createHarness({executorCalls, credentialResolver: resolver});

    const start = await harness.executor({
        source: 'fill input.target with input.username',
        input: {target: {nodeId: 'buyer'}, username: 'alice', retries: 3, enabled: true, flags: [null, 'x']},
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;
    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'completed');
    assert.deepEqual(executorCalls, [{name: 'browser.fill', args: {nodeId: 'buyer', value: 'alice'}}]);
    assert.deepEqual(start.summary.input, {
        target: {nodeId: 'buyer'},
        username: 'alice',
        retries: 3,
        enabled: true,
        flags: [null, 'x'],
    });
});

test('physical rollback compensates from world state and never replays the resolved secret', async () => {
    const executorCalls: StubCall[] = [];
    const resolvedIds: string[] = [];
    const harness = await createHarness({
        executorCalls,
        credentialResolver: countingResolver(resolvedIds),
        runtimeState: {buyer: {value: 'welcome-back'}},
    });

    const start = await harness.executor({
        source: `
            fill input.target with input.value
            ensure compute eq(input.a, input.b)
        `,
        input: {
            target: {nodeId: 'buyer'},
            value: harness.refString(),
            a: 1,
            b: 2,
        },
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;

    const explicit = session.savepoint(pause.continuationId);
    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'paused');
    if (crossed.status !== 'paused' || crossed.pause.reason !== 'failure') {
        throw new Error('expected the ensure invariant to fail after the fill');
    }
    assert.equal(crossed.pause.failure.code, 'ERR_DSL_ENSURE_FAILED');

    const rollback = await session.rollback(crossed.pause.continuationId, explicit.id, {strategy: 'physical'});
    assert.equal(rollback.status, 'compensated');
    assert.ok(!JSON.stringify(rollback).includes(CANARY), 'rollback must not echo the resolved secret');
    assert.deepEqual(resolvedIds, ['env:API_TOKEN'], 'only the original step boundary may resolve the secret; compensation never resolves');
    assert.equal(executorCalls.length, 2, 'the prior effect plus its compensation must both reach the executor');
    assert.deepEqual(executorCalls[0], {
        name: 'browser.fill',
        args: {nodeId: 'buyer', value: CANARY},
    });
    assert.deepEqual(executorCalls[1], {
        name: 'browser.fill',
        args: {nodeId: 'buyer', value: 'welcome-back'},
    });
    assert.ok(!JSON.stringify(executorCalls[1]).includes(CANARY), 'compensation must come from world state, never the secret');
    assert.ok(!JSON.stringify(session.auditEffects()).includes(CANARY), 'plaintext must never enter the compensation journal');

    await session.advance(crossed.pause.continuationId, 'abort');
});

test('rewind restores a reference-only scope and patching never materializes plaintext', async () => {
    const executorCalls: StubCall[] = [];
    const harness = await createHarness({executorCalls, credentialResolver: resolvable()});
    const refString = harness.refString();

    const start = await harness.executor({
        source: 'fill input.target with input.value',
        input: {target: {nodeId: 'buyer'}, value: refString},
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;

    const plan = session.rewindPlan(pause.continuationId);
    if (plan.status !== 'ready') {throw new Error(`rewind plan was not ready: ${plan.status}`);}
    const candidate = plan.candidates.find((entry) => entry.exact) ?? plan.candidates[0];
    assert.ok(candidate, 'expected a rewind candidate at the pending statement');

    const rewound = await session.rewind(pause.continuationId, candidate.savepointId, {strategy: 'physical'});
    assert.equal(rewound.status, 'rewound');
    assert.ok(!JSON.stringify(rewound.savepoint).includes(CANARY), 'rewind savepoint must stay reference-only');
    assert.ok(!JSON.stringify(rewound.pause).includes(CANARY), 'rewound pause scope must stay reference-only');
    if (rewound.status !== 'rewound') {throw new Error('unexpected rewind result');}
    assert.equal(rewound.pause.reason, 'statement');
    assert.equal(rewound.pause.scope.input.value as string, refString);
    assert.equal(executorCalls.length, 0, 'rewinding an unexecuted effect must not resolve or replay anything');

    const patched = session.patchStatement(rewound.pause.continuationId, 'wait 0');
    assert.equal(patched.status, 'patched');
    assert.ok(!session.materializeProgram().includes(CANARY), 'patched materialized source must never contain the secret');
    assert.ok(!session.materializeProgram().includes(refString), 'patched materialized source must never contain the opaque refs from scope');

    const continued = await session.advance(rewound.pause.continuationId, 'continue');
    assert.equal(continued.status, 'completed');
    assert.equal(executorCalls.length, 0, 'the patched statement must not re-run any earlier mutation');
});

test('without a wired resolver the boundary denies a credential ref before any browser step', async () => {
    const executorCalls: StubCall[] = [];
    const harness = await createHarness({executorCalls});

    const start = await harness.executor({
        source: 'fill input.target with input.token',
        input: {target: {nodeId: 'buyer'}, token: serializeCredentialRef(missingRef())},
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;
    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'paused');
    if (crossed.status !== 'paused' || crossed.pause.reason !== 'failure') {
        throw new Error('expected a failure pause at the denied step');
    }
    assert.equal(crossed.pause.failure.code, 'ERR_SECURITY_CREDENTIAL_UNRESOLVABLE');
    assert.deepEqual(executorCalls, [], 'the browser step must never run for a denied credential');
    assert.ok(!JSON.stringify(crossed.pause).includes(CANARY));
});