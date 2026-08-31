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
    afterQuery?: (view: WorldView) => WorldView;
    driftAtPin?: {atPin: number; view: WorldView};
}) => {
    const calls = options.executorCalls;
    const resolvedIds = options.resolvedIds ?? [];
    let current = options.initial;
    let pinCount = 0;
    const pluginHost = {
        getExecutors: () => ({
            'browser.query': async (step: StepUnion) => {
                calls.push({name: step.name, args: step.args as unknown as Record<string, unknown>});
                const meta = {...current.revision};
                if (options.afterQuery) {current = options.afterQuery(current);}
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'buyer', meta}};
            },
            'browser.fill': async (step: StepUnion) => {
                calls.push({name: step.name, args: step.args as unknown as Record<string, unknown>});
                return {stepId: step.id, ok: true, data: {filled: true}};
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
        credentialResolver: countingResolver(resolvedIds, createMemoryCredentialResolver({})),
        worldViewSource: {
            pin: async () => {
                pinCount += 1;
                if (options.driftAtPin && pinCount >= options.driftAtPin.atPin) {
                    current = options.driftAtPin.view;
                }
                return current;
            },
        },
    });
    return {executor, setWorld: (view: WorldView) => {current = view;}};
};

test('ordinary query let to act forwards the pinned world revision and a drift blocks the effect', async () => {
    const executorCalls: StubCall[] = [];
    const resolvedIds: string[] = [];
    const first = await buildView({pageEpoch: 'epoch-a', captureRevision: 1});
    const second = await buildView({pageEpoch: 'epoch-a', captureRevision: 2});
    const harness = await createHarness({
        executorCalls,
        resolvedIds,
        initial: first,
        afterQuery: () => second,
    });

    const start = await harness.executor({
        source: `
            let field = query entity.target "order.form" {
              kind: "form.field"
              fieldKey: "buyer"
            }
            fill field with input.value
        `,
        input: {value: 'alice'},
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;
    assert.equal(pause.reason, 'barrier');
    if (pause.reason !== 'barrier') {throw new Error('expected a barrier pause');}

    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'paused');
    if (crossed.status !== 'paused') {throw new Error('expected a failure pause');}
    assert.equal(crossed.pause.reason, 'failure');
    if (crossed.pause.reason !== 'failure') {throw new Error('expected failure pause');}
    assert.equal(crossed.pause.failure.code, 'ERR_AGENT_WORLD_CONFLICT');
    assert.deepEqual(crossed.pause.failure.details, {
        expected: {pageEpoch: 'epoch-a', captureRevision: 1},
        actual: {pageEpoch: 'epoch-a', captureRevision: 2},
    });
    assert.deepEqual(
        executorCalls.map((call) => call.name),
        ['browser.query'],
        'the effect must never reach the browser executor',
    );
    assert.deepEqual(resolvedIds, [], 'the credential resolver must never run for a world-conflicted effect');

    await session.advance(crossed.pause.continuationId, 'abort');
});

test('a pageEpoch drift between query and transact conflicts', async () => {
    const executorCalls: StubCall[] = [];
    const first = await buildView({pageEpoch: 'epoch-a', captureRevision: 1});
    const second = await buildView({pageEpoch: 'epoch-b', captureRevision: 1});
    const harness = await createHarness({executorCalls, initial: first, afterQuery: () => second});

    const start = await harness.executor({
        source: `
            let field = query entity.target "order.form" {
              kind: "form.field"
              fieldKey: "buyer"
            }
            fill field with input.value
        `,
        input: {value: 'alice'},
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;
    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'paused');
    if (crossed.status !== 'paused' || crossed.pause.reason !== 'failure') {
        throw new Error('expected a world-conflict failure');
    }
    assert.equal(crossed.pause.failure.code, 'ERR_AGENT_WORLD_CONFLICT');
    assert.deepEqual(
        executorCalls.map((call) => call.name),
        ['browser.query'],
    );
    await session.advance(crossed.pause.continuationId, 'abort');
});

test('a captureRevision drift between query and transact conflicts', async () => {
    const executorCalls: StubCall[] = [];
    const first = await buildView({pageEpoch: 'epoch-a', captureRevision: 1});
    const second = await buildView({pageEpoch: 'epoch-a', captureRevision: 7});
    const harness = await createHarness({executorCalls, initial: first, afterQuery: () => second});

    const start = await harness.executor({
        source: `
            let field = query entity.target "order.form" {
              kind: "form.field"
              fieldKey: "buyer"
            }
            fill field with input.value
        `,
        input: {value: 'alice'},
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;
    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'paused');
    if (crossed.status !== 'paused' || crossed.pause.reason !== 'failure') {
        throw new Error('expected a world-conflict failure');
    }
    assert.equal(crossed.pause.failure.code, 'ERR_AGENT_WORLD_CONFLICT');
    assert.deepEqual(
        executorCalls.map((call) => call.name),
        ['browser.query'],
    );
    await session.advance(crossed.pause.continuationId, 'abort');
});

test('a no-conflict query-derived effect succeeds exactly once', async () => {
    const executorCalls: StubCall[] = [];
    const first = await buildView({pageEpoch: 'epoch-a', captureRevision: 1});
    const harness = await createHarness({executorCalls, initial: first});

    const start = await harness.executor({
        source: `
            let field = query entity.target "order.form" {
              kind: "form.field"
              fieldKey: "buyer"
            }
            fill field with input.value
        `,
        input: {value: 'alice'},
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;
    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'completed');
    assert.deepEqual(executorCalls, [
        {name: 'browser.query', args: {op: 'entity.target', businessTag: 'order.form', target: {kind: 'form.field', fieldKey: 'buyer'}}},
        {name: 'browser.fill', args: {nodeId: 'buyer', value: 'alice'}},
    ]);
});

test('a Program-input capture_resolve target envelope carries the revision into the effect precondition', async () => {
    const executorCalls: StubCall[] = [];
    const resolvedIds: string[] = [];
    const first = await buildView({pageEpoch: 'epoch-c', captureRevision: 3});
    const second = await buildView({pageEpoch: 'epoch-c', captureRevision: 4});
    const harness = await createHarness({
        executorCalls,
        resolvedIds,
        initial: first,
        driftAtPin: {atPin: 5, view: second},
    });
    const ref = serializeCredentialRef({id: 'env:API_TOKEN', kind: 'token', provider: 'env'} as never);

    const start = await harness.executor({
        source: 'fill input.target with input.value',
        input: {
            target: {
                nodeId: 'buyer',
                resolve: {hint: {target: {nodeId: 'buyer'}}},
                meta: {pageEpoch: 'epoch-c', captureRevision: 3},
            },
            value: ref,
        },
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;
    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'paused');
    if (crossed.status !== 'paused' || crossed.pause.reason !== 'failure') {
        throw new Error('expected a world-conflict failure');
    }
    assert.equal(crossed.pause.failure.code, 'ERR_AGENT_WORLD_CONFLICT');
    assert.deepEqual(crossed.pause.failure.details, {
        expected: {pageEpoch: 'epoch-c', captureRevision: 3},
        actual: {pageEpoch: 'epoch-c', captureRevision: 4},
    });
    assert.deepEqual(resolvedIds, [], 'the credential resolver must never resolve a conflicted step');
    assert.deepEqual(executorCalls, [], 'no browser step may run');
    assert.ok(!JSON.stringify(crossed.pause.failure).includes(ref), 'conflict failure metadata must not echo the step args');

    await session.advance(crossed.pause.continuationId, 'abort');
});

test('existing direct nodeId targets without metadata remain backward compatible even across world drift', async () => {
    const executorCalls: StubCall[] = [];
    const first = await buildView({pageEpoch: 'epoch-a', captureRevision: 1});
    const second = await buildView({pageEpoch: 'epoch-b', captureRevision: 99});
    const harness = await createHarness({executorCalls, initial: first, afterQuery: () => second});

    const start = await harness.executor({
        source: 'fill input.target with input.value',
        input: {target: {nodeId: 'buyer'}, value: 'alice'},
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;
    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'completed');
    assert.deepEqual(executorCalls, [
        {name: 'browser.fill', args: {nodeId: 'buyer', value: 'alice'}},
    ]);
});

test('scalar input targets remain backward compatible', async () => {
    const executorCalls: StubCall[] = [];
    const first = await buildView({pageEpoch: 'epoch-a', captureRevision: 1});
    const second = await buildView({pageEpoch: 'epoch-b', captureRevision: 99});
    const harness = await createHarness({executorCalls, initial: first, afterQuery: () => second});

    const start = await harness.executor({
        source: 'fill input.target with input.value',
        input: {target: 'buyer', value: 'alice'},
    });

    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    if (!debug) {throw new Error('expected a retained debug session');}
    const {session, pause} = debug;
    const crossed = await session.crossBarrier(pause.continuationId);
    assert.equal(crossed.status, 'completed');
    assert.deepEqual(executorCalls, [
        {name: 'browser.fill', args: {nodeId: 'buyer', value: 'alice'}},
    ]);
});