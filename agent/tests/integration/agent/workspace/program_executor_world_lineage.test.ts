import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceProgramExecutor} from '../../../../src/agent/workspace/program_executor';
import type {WorldView} from '../../../../src/agent/worldview/contracts';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps';
import type {StepUnion} from '../../../../src/automation/runner/steps/types';
import {PageSnapshotSessionStore} from '../../../../src/automation/snapshot';
import {
    createMemoryCredentialResolver,
    serializeCredentialRef,
    type CredentialResolver,
} from '../../../../src/security/credentials';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';
import type {DslDebugExecutionSession, PausedDslDebugExecution} from '../../../../src/agent/debug/execution/contracts';

type StubCall = {
    name: string;
    args: Record<string, unknown>;
};

const buildView = async (revision: {pageEpoch: string; captureRevision: number}): Promise<WorldView> => {
    const fixture = createV2BusinessPage();
    const capture = structuredClone(fixture.capture);
    capture.control.observation = {
        ...capture.control.observation,
        identity: {...revision},
    } as typeof capture.control.observation;
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => capture,
    });
    return Object.freeze({
        workspaceName: 'ws-cas',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...revision}),
        entry,
    });
};

const countingResolver = (resolvedIds: string[], underlying: CredentialResolver): CredentialResolver => ({
    resolve: async (ref) => {
        resolvedIds.push(ref.id);
        return await underlying.resolve(ref);
    },
    has: (ref) => underlying.has(ref),
    describe: (ref) => underlying.describe(ref),
});

const createHarness = async (options: {
    executorCalls: StubCall[];
    resolvedIds?: string[];
    initial: WorldView;
    advancePerEffect?: number;
    driftAtPin?: {atPin: number; view: WorldView};
}) => {
    const calls = options.executorCalls;
    const resolvedIds = options.resolvedIds ?? [];
    let current = options.initial;
    let pinCount = 0;
    let pendingAdvance = false;
    const advancePerEffect = options.advancePerEffect ?? 1;
    const pluginHost = {
        getExecutors: () => ({
            'browser.query': async (step: StepUnion) => {
                calls.push({name: step.name, args: step.args as unknown as Record<string, unknown>});
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'buyer', meta: {...current.revision}}};
            },
            'browser.fill': async (step: StepUnion) => {
                calls.push({name: step.name, args: step.args as unknown as Record<string, unknown>});
                pendingAdvance = true;
                return {stepId: step.id, ok: true, data: {filled: true}};
            },
            'browser.click': async (step: StepUnion) => {
                calls.push({name: step.name, args: step.args as unknown as Record<string, unknown>});
                pendingAdvance = true;
                return {stepId: step.id, ok: true, data: {clicked: true}};
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
    const executor = createWorkspaceProgramExecutor({
        workspaceName: 'ws-cas',
        deps,
        runWorkspaceExecution: async (_actionType, run) => await run(),
        credentialResolver: countingResolver(resolvedIds, createMemoryCredentialResolver({
            'env:FIRST': 'alpha',
            'env:SECOND': 'beta',
        })),
        worldViewSource: {
            pin: async () => {
                pinCount += 1;
                if (options.driftAtPin && pinCount >= options.driftAtPin.atPin) {
                    current = options.driftAtPin.view;
                }
                if (pendingAdvance) {
                    pendingAdvance = false;
                    current = await buildView({
                        pageEpoch: current.revision.pageEpoch,
                        captureRevision: current.revision.captureRevision + advancePerEffect,
                    });
                }
                return current;
            },
        },
    });
    return {executor, setWorld: (view: WorldView) => {current = view;}};
};

const drive = async (
    session: DslDebugExecutionSession,
    initialPause: PausedDslDebugExecution,
) => {
    let pause = initialPause;
    while (true) {
        const result = await session.crossBarrier(pause.continuationId);
        if (result.status === 'completed') {
            return {status: 'completed' as const, output: result.output};
        }
        if (result.status === 'paused') {
            if (result.pause.reason === 'failure') {
                return {status: 'failed' as const, failure: result.pause.failure};
            }
            pause = result.pause;
            continue;
        }
        return result;
    }
};

const twoFillSource = [
    'fill input.target with input.value',
    'fill input.target2 with input.value2',
    'output ok = input.value',
].join('\n');

const envelope = (nodeId: string, revision: {pageEpoch: string; captureRevision: number}) => ({
    nodeId,
    resolve: {hint: {target: {nodeId}}},
    meta: {...revision},
});

test('two fills resolved at the same observed revision each execute once without self-conflict', async () => {
    const executorCalls: StubCall[] = [];
    const first = await buildView({pageEpoch: 'epoch-a', captureRevision: 1});
    const harness = await createHarness({executorCalls, initial: first});

    const start = await harness.executor({
        source: twoFillSource,
        input: {
            target: envelope('buyer', {pageEpoch: 'epoch-a', captureRevision: 1}),
            target2: envelope('submit', {pageEpoch: 'epoch-a', captureRevision: 1}),
            value: 'A',
            value2: 'B',
        },
    });

    assert.equal(start.summary.status, 'paused');
    assert.ok(start.debug);
    const {session, pause} = start.debug;
    const driven = await drive(session, pause);
    assert.equal(driven.status, 'completed', JSON.stringify(driven));
    if (driven.status !== 'completed') {throw new Error('expected completion');}
    assert.deepEqual(driven.output, {ok: 'A'});
    assert.deepEqual(executorCalls, [
        {name: 'browser.fill', args: {nodeId: 'buyer', value: 'A'}},
        {name: 'browser.fill', args: {nodeId: 'submit', value: 'B'}},
    ], 'each fill executes exactly once, in program order');
    assert.deepEqual(session.auditEffects().map((record) => ({
        sequence: record.sequence,
        stepName: record.effect.stepName,
        status: record.outcome.status,
        worldBefore: record.worldBefore.revision,
        worldAfter: record.worldAfter.revision,
    })), [
        {
            sequence: 1,
            stepName: 'browser.fill',
            status: 'succeeded',
            worldBefore: {pageEpoch: 'epoch-a', captureRevision: 1},
            worldAfter: {pageEpoch: 'epoch-a', captureRevision: 2},
        },
        {
            sequence: 2,
            stepName: 'browser.fill',
            status: 'succeeded',
            worldBefore: {pageEpoch: 'epoch-a', captureRevision: 2},
            worldAfter: {pageEpoch: 'epoch-a', captureRevision: 3},
        },
    ], 'the retained effect journal records the exact self-write lineage');
});

test('an external DOM mutation between two fills refuses the second effect with ERR_AGENT_WORLD_CONFLICT', async () => {
    const executorCalls: StubCall[] = [];
    const resolvedIds: string[] = [];
    const first = await buildView({pageEpoch: 'epoch-a', captureRevision: 1});
    const mutated = await buildView({pageEpoch: 'epoch-a', captureRevision: 3});
    const harness = await createHarness({
        executorCalls,
        resolvedIds,
        initial: first,
        driftAtPin: {atPin: 11, view: mutated},
    });
    const ref = serializeCredentialRef({id: 'env:SECOND', kind: 'credential', provider: 'env'} as never);

    const start = await harness.executor({
        source: twoFillSource,
        input: {
            target: envelope('buyer', {pageEpoch: 'epoch-a', captureRevision: 1}),
            target2: envelope('submit', {pageEpoch: 'epoch-a', captureRevision: 1}),
            value: serializeCredentialRef({id: 'env:FIRST', kind: 'credential', provider: 'env'} as never),
            value2: ref,
        },
    });

    assert.equal(start.summary.status, 'paused');
    assert.ok(start.debug);
    const {session, pause} = start.debug;
    const driven = await drive(session, pause);
    assert.equal(driven.status, 'failed', JSON.stringify(driven));
    if (driven.status !== 'failed') {throw new Error('expected a world-conflict failure');}
    assert.equal(driven.failure.code, 'ERR_AGENT_WORLD_CONFLICT');
    assert.deepEqual(driven.failure.details, {
        expected: {pageEpoch: 'epoch-a', captureRevision: 1},
        actual: {pageEpoch: 'epoch-a', captureRevision: 3},
    });
    assert.deepEqual(
        executorCalls.map((call) => call.name),
        ['browser.fill'],
        'only the first fill may reach the browser executor',
    );
    assert.deepEqual(resolvedIds, ['env:FIRST'],
        'the conflicted second fill must never resolve its credential');
    assert.ok(!JSON.stringify(driven.failure).includes(ref), 'conflict metadata must not echo the second credential');

    const effects = session.auditEffects();
    assert.equal(effects.length, 2);
    assert.equal(effects[0].outcome.status, 'succeeded');
    assert.deepEqual(effects[0].worldBefore.revision, {pageEpoch: 'epoch-a', captureRevision: 1});
    assert.deepEqual(effects[0].worldAfter.revision, {pageEpoch: 'epoch-a', captureRevision: 2});
    assert.equal(effects[1].outcome.status, 'failed');
    assert.deepEqual(effects[1].worldBefore.revision, {pageEpoch: 'epoch-a', captureRevision: 2});
    assert.deepEqual(effects[1].worldAfter.revision, {pageEpoch: 'epoch-a', captureRevision: 3});
});

test('a navigation pageEpoch change between two fills refuses the second effect', async () => {
    const executorCalls: StubCall[] = [];
    const first = await buildView({pageEpoch: 'epoch-a', captureRevision: 1});
    const navigated = await buildView({pageEpoch: 'epoch-b', captureRevision: 1});
    const harness = await createHarness({
        executorCalls,
        initial: first,
        driftAtPin: {atPin: 11, view: navigated},
    });

    const start = await harness.executor({
        source: twoFillSource,
        input: {
            target: envelope('buyer', {pageEpoch: 'epoch-a', captureRevision: 1}),
            target2: envelope('submit', {pageEpoch: 'epoch-a', captureRevision: 1}),
            value: 'A',
            value2: 'B',
        },
    });

    assert.equal(start.summary.status, 'paused');
    assert.ok(start.debug);
    const {session, pause} = start.debug;
    const driven = await drive(session, pause);
    assert.equal(driven.status, 'failed');
    if (driven.status !== 'failed') {throw new Error('expected a world-conflict failure');}
    assert.equal(driven.failure.code, 'ERR_AGENT_WORLD_CONFLICT');
    assert.deepEqual(
        executorCalls.map((call) => call.name),
        ['browser.fill'],
        'the second fill must never reach the browser executor after navigation',
    );
    const effects = session.auditEffects();
    assert.equal(effects.length, 2);
    assert.equal(effects[1].outcome.status, 'failed');
});

test('a world beyond the proven worldAfter chain refuses the effect', async () => {
    const executorCalls: StubCall[] = [];
    const first = await buildView({pageEpoch: 'epoch-a', captureRevision: 1});
    const drifted = await buildView({pageEpoch: 'epoch-a', captureRevision: 5});
    const harness = await createHarness({
        executorCalls,
        initial: first,
        driftAtPin: {atPin: 11, view: drifted},
    });

    const start = await harness.executor({
        source: twoFillSource,
        input: {
            target: envelope('buyer', {pageEpoch: 'epoch-a', captureRevision: 1}),
            target2: envelope('submit', {pageEpoch: 'epoch-a', captureRevision: 1}),
            value: 'A',
            value2: 'B',
        },
    });

    assert.equal(start.summary.status, 'paused');
    assert.ok(start.debug);
    const {session, pause} = start.debug;
    const driven = await drive(session, pause);
    assert.equal(driven.status, 'failed');
    if (driven.status !== 'failed') {throw new Error('expected a world-conflict failure');}
    assert.equal(driven.failure.code, 'ERR_AGENT_WORLD_CONFLICT');
    assert.deepEqual(driven.failure.details, {
        expected: {pageEpoch: 'epoch-a', captureRevision: 1},
        actual: {pageEpoch: 'epoch-a', captureRevision: 5},
    });
    assert.deepEqual(
        executorCalls.map((call) => call.name),
        ['browser.fill'],
        'the unprovable second effect must never reach the browser executor',
    );
});

test('two clicks resolved at the same observed revision each execute once without self-conflict', async () => {
    const executorCalls: StubCall[] = [];
    const first = await buildView({pageEpoch: 'epoch-a', captureRevision: 1});
    const harness = await createHarness({executorCalls, initial: first});

    const start = await harness.executor({
        source: [
            'click input.target',
            'click input.target2',
            'output ok = input.ok',
        ].join('\n'),
        input: {
            target: envelope('approve', {pageEpoch: 'epoch-a', captureRevision: 1}),
            target2: envelope('submit', {pageEpoch: 'epoch-a', captureRevision: 1}),
            ok: true,
        },
    });

    assert.equal(start.summary.status, 'paused');
    assert.ok(start.debug);
    const {session, pause} = start.debug;
    const driven = await drive(session, pause);
    assert.equal(driven.status, 'completed', JSON.stringify(driven));
    if (driven.status !== 'completed') {throw new Error('expected completion');}
    assert.deepEqual(driven.output, {ok: true});
    assert.deepEqual(executorCalls, [
        {name: 'browser.click', args: {nodeId: 'approve'}},
        {name: 'browser.click', args: {nodeId: 'submit'}},
    ], 'each click executes exactly once');
});