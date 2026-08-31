import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createDslDebugExecutionSession} from '../../../../src/agent/debug/execution/dsl_session';
import {
    exportProgramExecutionImage,
    parseProgramExecutionImage,
    rehydrateProgramExecutionImage,
} from '../../../../src/agent/continuation';
import type {WorldView} from '../../../../src/agent/worldview/contracts';
import type {DslEntityRulesProfile, DslEntityRulesResolver} from '../../../../src/automation/dsl/link';
import type {StepExecutionPort} from '../../../../src/automation/dsl/runtime/run_dsl';
import type {StepUnion} from '../../../../src/automation/runner/steps/types';
import {
    buildEntityRuleComponentSnapshots,
    captureControlSnapshot,
    PageSnapshotSessionStore,
} from '../../../../src/automation/snapshot';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const CANARY = 'durable-secret-canary-should-never-be-persisted';

const makeWorld = async (revision = 1): Promise<WorldView> => {
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => {
            const capture = structuredClone(fixture.capture);
            capture.control.observation.identity.captureRevision = revision;
            return capture;
        },
    });
    return Object.freeze({workspaceName: 'ws', tabName: 'main', pageUrl: entry.pageUrl, revision: entry.identity, entry});
};

const basicOptions = async (world: WorldView, calls: string[], source = 'click input.target') => ({
    source,
    context: {
        workspaceName: 'ws',
        deps: {runtimeOnlySecret: CANARY} as never,
        input: {target: {nodeId: 'target'}},
        stepExecutionPort: {execute: async (step: StepUnion) => {
            calls.push(step.name);
            return {stepId: step.id, ok: true as const, data: {}};
        }},
    },
    worldViewSource: {pin: async () => world},
    debug: {barrierOn: ['unknown' as const]},
});

const actionResolver = (actions: readonly string[]): DslEntityRulesResolver => {
    const profile: DslEntityRulesProfile = {
        profileName: 'durable-actions',
        entities: [{
            entityKey: 'form',
            businessTag: 'durable.form',
            kind: 'form',
            fields: [],
            actions: actions.map((actionIntent) => ({
                actionIntent,
                targetKind: 'form.action' as const,
                effect: {reversibility: actionIntent === 'commit' ? 'irreversible' as const : 'reversible' as const},
            })),
            columns: [],
            rowActions: [],
            supportedQueries: ['form.actions'],
        }],
    };
    return {
        resolveProfile: (profileName) => profileName === profile.profileName
            ? {profile, diagnostics: []}
            : {profile: null, diagnostics: []},
    };
};

const semanticHarness = async (actions: readonly string[]) => {
    const worlds = await Promise.all(Array.from({length: actions.length + 1}, (_, index) => makeWorld(index + 1)));
    let current = worlds[0];
    let effectIndex = 0;
    const effectCalls: string[] = [];
    const queryCalls: string[] = [];
    const resolver = actionResolver(actions);
    const port: StepExecutionPort = {
        execute: async (step) => {
            if (step.name === 'browser.query') {
                const args = step.args as {target?: {actionIntent?: string}};
                const actionIntent = args.target?.actionIntent ?? 'unknown';
                queryCalls.push(actionIntent);
                return {
                    stepId: step.id,
                    ok: true,
                    data: {
                        kind: 'nodeId',
                        nodeId: actionIntent,
                        meta: {pageEpoch: current.revision.pageEpoch, captureRevision: current.revision.captureRevision},
                    },
                };
            }
            if (step.name !== 'browser.click') {throw new Error(`unexpected step: ${step.name}`);}
            const nodeId = String((step.args as {nodeId?: string}).nodeId ?? '');
            effectCalls.push(nodeId);
            effectIndex += 1;
            current = worlds[effectIndex];
            return {stepId: step.id, ok: true, data: {clicked: true}};
        },
    };
    const source = [
        'use entity_rules "durable-actions" as durable',
        ...actions.map((action) => `click durable.form.${action}`),
        'output done = input.done',
    ].join('\n');
    return {
        source,
        context: {
            workspaceName: 'ws',
            deps: {runtimeOnlySecret: CANARY} as never,
            input: {done: true},
            entityRulesResolver: resolver,
            stepExecutionPort: port,
        },
        worldViewSource: {pin: async () => current},
        effectCalls,
        queryCalls,
    };
};

const requireExport = (session: ReturnType<typeof createDslDebugExecutionSession>) => {
    const exported = exportProgramExecutionImage(session);
    if (!exported.ok) {assert.fail(exported.error.message);}
    return exported.image;
};

const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('first-effect barrier rehydrates with zero replay and executes exactly once after approval', async () => {
    const world = await makeWorld();
    const calls: string[] = [];
    const session = createDslDebugExecutionSession(await basicOptions(world, calls));
    const pause = await session.waitForPause();
    assert.equal(pause.reason, 'barrier');
    assert.deepEqual(calls, []);

    const image = requireExport(session);
    assert.equal(JSON.stringify(image).includes(CANARY), false);
    const restored = await rehydrateProgramExecutionImage(jsonClone(image), {
        context: (await basicOptions(world, calls)).context,
        worldViewSource: {pin: async () => world},
    });
    assert.equal(restored.ok, true);
    if (!restored.ok) {return;}
    assert.deepEqual(calls, []);

    const crossed = await restored.session.crossBarrier(restored.pause.continuationId);
    assert.equal(crossed.status, 'completed');
    assert.deepEqual(calls, ['browser.click']);
    assert.equal(restored.session.auditEffects().length, 1);
});

test('a completed reversible effect is preserved across restart and never replayed before a later barrier', async () => {
    const harness = await semanticHarness(['safe', 'commit']);
    const session = createDslDebugExecutionSession({
        source: harness.source,
        context: harness.context,
        worldViewSource: harness.worldViewSource,
        debug: {barrierOn: ['irreversible']},
    });
    const pause = await session.waitForPause();
    assert.equal(pause.reason, 'barrier');
    assert.deepEqual(harness.effectCalls, ['safe']);
    assert.deepEqual(harness.queryCalls, ['safe', 'commit']);
    assert.equal(session.auditEffects().length, 1);

    const image = requireExport(session);
    const hiddenBefore = image.transaction.savepoints.filter((entry) => !entry.visible).length;
    assert.ok(hiddenBefore > 0);
    const restored = await rehydrateProgramExecutionImage(jsonClone(image), {
        context: harness.context,
        worldViewSource: harness.worldViewSource,
    });
    assert.equal(restored.ok, true);
    if (!restored.ok) {return;}
    assert.deepEqual(harness.effectCalls, ['safe']);
    assert.equal(restored.session.auditEffects().length, 1);
    const priorDiff = restored.session.diff(restored.pause.continuationId, 1);
    assert.equal(priorDiff.ok, true, 'full pre-restart World snapshots remain usable by the debugger');
    const reexported = requireExport(restored.session);
    assert.equal(reexported.transaction.savepoints.filter((entry) => !entry.visible).length, hiddenBefore);

    const crossed = await restored.session.crossBarrier(restored.pause.continuationId);
    assert.equal(crossed.status, 'completed');
    assert.deepEqual(harness.effectCalls, ['safe', 'commit']);
    assert.deepEqual(harness.queryCalls, ['safe', 'commit', 'commit']);
    assert.equal(restored.session.auditEffects().length, 2);
});

test('effect journal outcomes and compensation links survive JSON image roundtrip', async () => {
    const harness = await semanticHarness(['safeA', 'safeB', 'commit']);
    const session = createDslDebugExecutionSession({
        source: harness.source,
        context: harness.context,
        worldViewSource: harness.worldViewSource,
        debug: {barrierOn: ['irreversible']},
    });
    const pause = await session.waitForPause();
    assert.equal(pause.reason, 'barrier');
    assert.deepEqual(harness.effectCalls, ['safeA', 'safeB']);
    const image = jsonClone(requireExport(session));
    assert.equal(image.journal.entries.length, 2);
    (image.journal.entries[1].record as {compensates?: {effectSequence: number}}).compensates = {effectSequence: 1};

    const parsed = parseProgramExecutionImage(jsonClone(image));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {return;}
    const restored = await rehydrateProgramExecutionImage(parsed.image, {
        context: harness.context,
        worldViewSource: harness.worldViewSource,
    });
    assert.equal(restored.ok, true);
    if (!restored.ok) {return;}
    const effects = restored.session.auditEffects();
    assert.equal(effects.length, 2);
    assert.equal(effects[0].outcome.status, 'succeeded');
    assert.equal(effects[1].outcome.status, 'succeeded');
    assert.deepEqual(effects[1].compensates, {effectSequence: 1});
});

test('materialized main-Program patches are visible before approval and remain effective after restore', async () => {
    const world = await makeWorld();
    const calls: string[] = [];
    const source = ['output marker = input.old', 'click input.target'].join('\n');
    const base = await basicOptions(world, calls, source);
    const context = {...base.context, input: {old: 'old', new: 'new', target: {nodeId: 'target'}}};
    const session = createDslDebugExecutionSession({
        source,
        context,
        worldViewSource: base.worldViewSource,
        debug: {initialMode: 'step', barrierOn: ['unknown']},
    });
    const statement = await session.waitForPause();
    assert.equal(statement.reason, 'statement');
    const patched = session.patchProgram(statement.continuationId, 'main', 'body.0', 'output marker = input.new');
    assert.equal(patched.status, 'patched');
    const advanced = await session.advance(statement.continuationId, 'continue');
    assert.equal(advanced.status, 'paused');
    if (advanced.status !== 'paused') {return;}
    assert.equal(advanced.pause.reason, 'barrier');
    assert.deepEqual(calls, []);

    const image = requireExport(session);
    assert.match(image.mainSource, /input\.new/u);
    const main = image.programs.find((program) => program.programId === 'main');
    assert.ok(main);
    assert.match(JSON.stringify(main.statements), /input\.new/u, 'persisted main AST matches materialized source');
    const restored = await rehydrateProgramExecutionImage(jsonClone(image), {
        context,
        worldViewSource: base.worldViewSource,
    });
    assert.equal(restored.ok, true);
    if (!restored.ok) {return;}
    assert.match(restored.session.materializeProgram('main'), /input\.new/u);
    const crossed = await restored.session.crossBarrier(restored.pause.continuationId);
    assert.equal(crossed.status, 'completed');
    if (crossed.status !== 'completed') {return;}
    assert.deepEqual(crossed.output, {marker: 'new'});
    assert.deepEqual(calls, ['browser.click']);
});

test('rehydration rejects changed World revision before executing anything', async () => {
    const world = await makeWorld(1);
    const calls: string[] = [];
    const session = createDslDebugExecutionSession(await basicOptions(world, calls));
    await session.waitForPause();
    const image = requireExport(session);
    const changed = await makeWorld(2);
    const conflict = await rehydrateProgramExecutionImage(image, {
        context: (await basicOptions(changed, calls)).context,
        worldViewSource: {pin: async () => changed},
    });
    assert.equal(conflict.ok, false);
    if (conflict.ok) {return;}
    assert.equal(conflict.error.code, 'ERR_CONTINUATION_WORLD_CONFLICT');
    assert.deepEqual(calls, []);
});

test('strict image parsing rejects unknown version and corrupt nested durable state', async () => {
    const world = await makeWorld();
    const session = createDslDebugExecutionSession(await basicOptions(world, []));
    await session.waitForPause();
    const image = requireExport(session);
    const mutations: Array<[string, (value: any) => void]> = [
        ['unknown version', (value) => {value.version = 999;}],
        ['unknown debug option', (value) => {value.debug.internalMode = true;}],
        ['invalid active frame', (value) => {value.active.frames = [{}];}],
        ['invalid statement frame', (value) => {value.active.statementEvent.frames = [{}];}],
        ['invalid journal entry', (value) => {value.journal.entries = [{}];}],
        ['invalid transaction savepoint', (value) => {value.transaction.savepoints = [{}];}],
        ['invalid execution savepoint', (value) => {value.executionSavepoints = [{}];}],
        ['invalid provenance', (value) => {value.provenance = [{}];}],
        ['invalid history', (value) => {value.statementHistory = [{}];}],
        ['invalid program view', (value) => {value.programs = [{}];}],
        ['invalid recovery attempts', (value) => {value.recoveryAttempts = {point: {checkpoint: -1}};}],
    ];
    for (const [name, mutate] of mutations) {
        const corrupted = jsonClone(image) as any;
        mutate(corrupted);
        const parsed = parseProgramExecutionImage(corrupted);
        assert.equal(parsed.ok, false, `${name} must fail closed`);
        if (!parsed.ok) {assert.equal(parsed.error.code, 'ERR_CONTINUATION_INVALID');}
    }
});


test('durable image built from a real sensitive page contains no captured credential plaintext', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent(`
            <!doctype html><html><body>
              <input id="username" name="username" value="alice">
              <input id="password" name="password" type="password" autocomplete="current-password" value="password-durable-canary">
              <input id="api-key" name="apiKey" value="api-key-durable-canary">
              <input id="otp" autocomplete="one-time-code" value="987654">
            </body></html>
        `);
        await page.locator('#password').fill('runtime-password-durable-canary');
        const store = new PageSnapshotSessionStore<object>();
        const pageKey = {};
        const entry = await store.ensureFresh({
            pageKey,
            pageUrl: page.url(),
            capture: async () => {
                const control = await captureControlSnapshot(page);
                const components = buildEntityRuleComponentSnapshots(control);
                return {control, form: components.form, table: components.table};
            },
        });
        const world: WorldView = Object.freeze({
            workspaceName: 'ws',
            tabName: 'main',
            pageUrl: entry.pageUrl,
            revision: Object.freeze({...entry.identity}),
            entry,
        });
        const session = createDslDebugExecutionSession(await basicOptions(world, []));
        await session.waitForPause();
        const serialized = JSON.stringify(requireExport(session));
        assert.match(serialized, /alice/u, 'ordinary form state remains available to the transaction image');
        for (const secret of [
            'password-durable-canary',
            'runtime-password-durable-canary',
            'api-key-durable-canary',
            '987654',
        ]) {
            assert.equal(serialized.includes(secret), false, `durable image must not contain ${secret}`);
        }
        assert.match(serialized, /\[redacted\]/u);
    } finally {
        await browser.close();
    }
});

test('non-barrier execution states are not exported as durable v1 continuations', async () => {
    const world = await makeWorld();
    const statementSession = createDslDebugExecutionSession({
        ...(await basicOptions(world, [])),
        debug: {initialMode: 'step', barrierOn: ['unknown']},
    });
    const statement = await statementSession.waitForPause();
    assert.equal(statement.reason, 'statement');
    const unsupported = exportProgramExecutionImage(statementSession);
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) {assert.equal(unsupported.error.code, 'ERR_CONTINUATION_UNSUPPORTED');}
});
