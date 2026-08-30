import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {createPausedDslDebugAgentTools} from '../../../../../src/agent/debug/execution/agent_tools';
import {tryRetainedRecovery} from '../../../../../src/agent/debug/recovery/retained_recovery';
import type {CheckpointRuntimeSnapshot} from '../../../../../src/automation/runner/checkpoint';
import type {DslCheckpointProvider} from '../../../../../src/automation/dsl/emit';
import type {DslEntityRulesResolver} from '../../../../../src/automation/dsl/link';
import type {StepExecutionPort} from '../../../../../src/automation/dsl/runtime/run_dsl';
import type {RunStepsDeps} from '../../../../../src/automation/runner/run_steps';
import type {Checkpoint} from '../../../../../src/automation/runner/checkpoint/types';
import type {StepResolve, StepUnion} from '../../../../../src/automation/runner/steps/types';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const buildView = async (): Promise<WorldView> => {
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    return Object.freeze({
        workspaceName: 'ws-retained-recovery',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

const effectResolver = (): DslEntityRulesResolver => ({
    resolveProfile: (profileName) => {
        const profile = profileName === 'orders-reversible'
            ? {
                profileName,
                businessTag: 'order.form',
                actions: [{
                    actionIntent: 'submit',
                    targetKind: 'form.action' as const,
                    effect: {reversibility: 'reversible' as const},
                }],
            }
            : profileName === 'orders-high'
                ? {
                    profileName,
                    businessTag: 'order.high',
                    actions: [{
                        actionIntent: 'submit',
                        targetKind: 'form.action' as const,
                        effect: {reversibility: 'reversible' as const},
                    }],
                }
                : profileName === 'orders-irreversible'
                    ? {
                        profileName,
                        businessTag: 'order.form.main',
                        actions: [{
                            actionIntent: 'approve',
                            targetKind: 'form.action' as const,
                            effect: {reversibility: 'irreversible' as const},
                        }],
                    }
                    : null;
        if (!profile) {return {profile: null, diagnostics: []};}
        return {
            profile: {
                profileName: profile.profileName,
                entities: [{
                    entityKey: 'orderForm',
                    businessTag: profile.businessTag,
                    kind: 'form',
                    fields: [],
                    actions: profile.actions,
                    columns: [],
                    rowActions: [],
                    supportedQueries: ['form.fields', 'form.actions'],
                }],
            },
            diagnostics: [],
        };
    },
});

const irreversibleResolver = effectResolver;

const makeRuntime = (options: {
    checkpoints: Checkpoint[];
    bodies: Record<string, string>;
    stepResolves?: Record<string, Record<string, StepResolve>>;
    entityRulesResolver?: DslEntityRulesResolver;
}): CheckpointRuntimeSnapshot => {
    const provider: DslCheckpointProvider = {
        getCheckpoint: (id) => options.checkpoints.find((checkpoint) => checkpoint.id === id) ?? null,
        getCheckpointResolves: (id) => options.stepResolves?.[id] ?? null,
        getCheckpointBody: (id) => options.bodies[id] === undefined ? null : {source: options.bodies[id], stepResolves: {}},
        listCheckpoints: () => [...options.checkpoints],
    };
    return {
        provider,
        checkpointStepResolves: options.stepResolves ?? {},
        checkpointBodies: options.bodies,
        ...(options.entityRulesResolver ? {entityRulesResolver: options.entityRulesResolver} : {}),
    };
};

const queryHarness = () => {
    let queryFailed = false;
    const clicks: string[] = [];
    const port: StepExecutionPort = {
        execute: async (step) => {
            if (step.name === 'browser.query') {
                const args = step.args as {query?: string; businessTag?: string};
                if (args.query === 'table.currentRows') {
                    if (!queryFailed) {
                        queryFailed = true;
                        return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'table not ready'}};
                    }
                    return {stepId: step.id, ok: true, data: {kind: 'value', value: [{id: 'row-1'}]}};
                }
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: args.businessTag === 'order.high' ? 'high-btn' : 'submit-btn'}};
            }
            if (step.name === 'browser.click') {
                clicks.push((step.args as {nodeId?: string}).nodeId ?? '');
                return {stepId: step.id, ok: true, data: {clicked: true}};
            }
            throw new Error(`unexpected step: ${step.name}`);
        },
    };
    return {port, clicks, isQueryFailed: () => queryFailed};
};

const CLICK_BODY = [
    'use entity_rules "orders-reversible" as orders',
    'click orders.orderForm.submit',
    'output recovered = input.done',
].join('\n');

const IRREVERSIBLE_BODY = [
    'use entity_rules "orders-irreversible" as orders',
    'click orders.orderForm.approve',
    'output recovered = input.done',
].join('\n');

const UNKNOWN_BODY = [
    'let target = query entity.target "order.form" {',
    '  kind: "form.action"',
    '  actionIntent: "submit"',
    '}',
    'click target',
    'output recovered = input.done',
].join('\n');

const APPROVAL_BODY = [
    'use entity_rules "orders-reversible" as safe',
    'use entity_rules "orders-irreversible" as risky',
    'click safe.orderForm.submit',
    'click risky.orderForm.approve',
    'output recovered = input.done',
].join('\n');

const createFailurePause = async (options: {
    program: string;
    input?: Record<string, unknown>;
    port: StepExecutionPort;
    sessionEntityRulesResolver?: DslEntityRulesResolver;
    view: WorldView;
}) => {
    const session = createDslDebugExecutionSession({
        source: options.program,
        context: {
            workspaceName: 'ws-retained-recovery',
            deps: {} as RunStepsDeps,
            input: structuredClone(options.input ?? {done: true}),
            ...(options.sessionEntityRulesResolver
                ? {entityRulesResolver: options.sessionEntityRulesResolver}
                : {}),
            stepExecutionPort: options.port,
        },
        worldViewSource: {pin: async () => options.view},
        debug: {
            initialMode: 'continue',
            breakOnFailure: true,
            barrierOn: ['unknown', 'compensatable', 'irreversible'],
            barrierResumeMode: 'continue',
        },
    });
    const pause = await session.waitForPause();
    return {session, pause};
};

const runRecovery = async (options: {
    program: string;
    input?: Record<string, unknown>;
    checkpoints: Checkpoint[];
    bodies: Record<string, string>;
    port: StepExecutionPort;
    entityRulesResolver?: DslEntityRulesResolver;
    view: WorldView;
}) => {
    const resolver = options.entityRulesResolver ?? effectResolver();
    const {session, pause} = await createFailurePause({
        program: options.program,
        input: options.input,
        port: options.port,
        sessionEntityRulesResolver: resolver,
        view: options.view,
    });
    const runtime = makeRuntime({
        checkpoints: options.checkpoints,
        bodies: options.bodies,
        entityRulesResolver: resolver,
    });
    const outcome = await tryRetainedRecovery({session, pause, runtime});
    return {session, pause, outcome};
};

test('a real saved Recovery checkpoint fixes a deterministic retained failure and completes in the same transaction', async () => {
    const view = await buildView();
    const {port, clicks} = queryHarness();
    const {outcome, session} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'recovery-1',
            kind: 'recovery',
            name: 'repair order table',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
            policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'recovery-1': CLICK_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'recovered_with_retry');
    if (outcome.status !== 'recovered_with_retry') {return;}
    assert.equal(outcome.advance.status, 'completed');
    if (outcome.advance.status !== 'completed') {return;}
    assert.deepEqual(outcome.advance.output, {done: true});
    assert.deepEqual(outcome.summary, {checkpointId: 'recovery-1', checkpointName: 'repair order table', applied: true, retried: true});
    assert.deepEqual(clicks, ['submit-btn']);

    const effects = session.auditEffects();
    assert.equal(effects.length, 1);
    assert.equal(effects[0].effect.stepName, 'browser.click');
    assert.equal(effects[0].outcome.status, 'succeeded');
});

test('retained recovery honors matcher priority and stepName scoping like the ordinary runner', async () => {
    const view = await buildView();
    const {port, clicks} = queryHarness();
    const highBody = CLICK_BODY.replace('"orders-reversible"', '"orders-high"');
    const {outcome, session} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [
            {
                id: 'cp-low',
                kind: 'recovery',
                priority: 1,
                trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
                policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
                body: {language: 'dsl', source: 'body.dsl'},
            },
            {
                id: 'cp-high',
                kind: 'recovery',
                priority: 10,
                trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
                policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
                body: {language: 'dsl', source: 'body.dsl'},
            },
        ],
        bodies: {'cp-low': CLICK_BODY, 'cp-high': highBody},
        port,
        view,
    });

    assert.equal(outcome.status, 'recovered_with_retry');
    if (outcome.status !== 'recovered_with_retry') {return;}
    assert.equal(outcome.summary.checkpointId, 'cp-high');
    assert.deepEqual(clicks, ['high-btn']);
    assert.equal(session.auditEffects().length, 1);
});

test('retained recovery honors maxAttempts and errorCode scoping like the ordinary runner', async () => {
    const view = await buildView();
    const {port} = queryHarness();
    const {outcome} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [
            {
                id: 'cp-zero-attempts',
                kind: 'recovery',
                priority: 10,
                trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
                policy: {maxAttempts: 0, retryOriginal: true},
                input: {done: true},
                body: {language: 'dsl', source: 'body.dsl'},
            },
            {
                id: 'cp-wrong-error',
                kind: 'recovery',
                priority: 5,
                trigger: {matchRules: [{errorCode: 'ERR_TIMEOUT'}, {stepName: 'browser.query'}]},
                policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
                body: {language: 'dsl', source: 'body.dsl'},
            },
            {
                id: 'cp-match',
                kind: 'recovery',
                priority: 1,
                trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
                policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
                body: {language: 'dsl', source: 'body.dsl'},
            },
        ],
        bodies: {'cp-zero-attempts': CLICK_BODY, 'cp-wrong-error': CLICK_BODY, 'cp-match': CLICK_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'recovered_with_retry');
    if (outcome.status !== 'recovered_with_retry') {return;}
    assert.equal(outcome.summary.checkpointId, 'cp-match');
});

test('retained recovery matches an entityExists trigger from the frozen WorldView', async () => {
    const view = await buildView();
    const {port} = queryHarness();
    const {outcome} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-entity',
            kind: 'recovery',
            trigger: {matchRules: [
                {errorCode: 'ERR_NOT_FOUND'},
                {entityExists: {query: 'OrdersTable', kind: 'table', businessTag: 'order.table.main'}},
            ]},
            policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-entity': CLICK_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'recovered_with_retry');
    if (outcome.status !== 'recovered_with_retry') {return;}
    assert.equal(outcome.summary.checkpointId, 'cp-entity');
});

test('a non-matching retained recovery does nothing and leaves the original failure', async () => {
    const view = await buildView();
    const {port} = queryHarness();
    const {pause, outcome, session} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-wrong',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_TIMEOUT'}]},
            policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-wrong': CLICK_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'none');
    assert.equal(pause.reason, 'failure');
    assert.equal(session.auditEffects().length, 0);
});

test('a failing retained recovery falls back to the original debug failure', async () => {
    const view = await buildView();
    const port: StepExecutionPort = {
        execute: async (step) => {
            if (step.name === 'browser.query') {
                const args = step.args as {query?: string};
                if (args.query === 'table.currentRows') {
                    return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'table not ready'}};
                }
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'submit-btn'}};
            }
            if (step.name === 'browser.click') {
                return {stepId: step.id, ok: false, error: {code: 'ERR_CLICK_BLOCKED', message: 'click failed'}};
            }
            throw new Error(`unexpected step: ${step.name}`);
        },
    };
    const {pause, outcome, session} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-fails',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
            policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-fails': CLICK_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'recovery_failed');
    if (outcome.status !== 'recovery_failed') {return;}
    assert.equal(outcome.summary.checkpointId, 'cp-fails');
    assert.equal(outcome.summary.applied, false);
    assert.equal(pause.reason, 'failure');
    const effects = session.auditEffects();
    assert.equal(effects.length, 1);
    assert.equal(effects[0].effect.stepName, 'browser.click');
    assert.equal(effects[0].outcome.status, 'failed');
});

test('an irreversible retained recovery effect pauses for approval rather than crossing', async () => {
    const view = await buildView();
    const {port, clicks} = queryHarness();
    const resolver = irreversibleResolver();
    const {pause, outcome, session} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-irreversible',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
            policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-irreversible': IRREVERSIBLE_BODY},
        port,
        entityRulesResolver: resolver,
        view,
    });

    assert.equal(outcome.status, 'needs_approval');
    if (outcome.status !== 'needs_approval') {return;}
    assert.equal(outcome.summary.checkpointId, 'cp-irreversible');
    assert.equal(outcome.summary.applied, false);
    assert.equal(outcome.summary.blockedByApproval, true);
    assert.equal(outcome.pause.reason, 'barrier');
    assert.equal(outcome.pause.effect.stepName, 'browser.click');
    assert.equal(outcome.pause.effect.semantics.reversibility, 'irreversible');
    assert.deepEqual(clicks, []);
    assert.equal(session.auditEffects().length, 0);
    assert.equal(pause.reason, 'failure');
});

test('an unknown retained Recovery effect pauses before execution while reversible knowledge proceeds automatically', async () => {
    const view = await buildView();
    const {port, clicks} = queryHarness();
    const {outcome, session} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-unknown',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
            policy: {maxAttempts: 1, retryOriginal: true},
            input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-unknown': UNKNOWN_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'needs_approval');
    if (outcome.status !== 'needs_approval') {return;}
    assert.equal(outcome.pause.reason, 'barrier');
    assert.equal(outcome.pause.effect.semantics.reversibility, 'unknown');
    assert.deepEqual(clicks, [], 'unknown recovery effect is not executed before approval');
    assert.equal(session.auditEffects().length, 0);
});

test('maxAttempts=1 cannot run the same retained recovery twice after failure/re-entry', async () => {
    const view = await buildView();
    const clicks: string[] = [];
    const port: StepExecutionPort = {
        execute: async (step) => {
            if (step.name === 'browser.query') {
                const args = step.args as {query?: string};
                if (args.query === 'table.currentRows') {
                    return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'table never ready'}};
                }
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'submit-btn'}};
            }
            if (step.name === 'browser.click') {
                clicks.push((step.args as {nodeId?: string}).nodeId ?? '');
                return {stepId: step.id, ok: true, data: {clicked: true}};
            }
            throw new Error(`unexpected step: ${step.name}`);
        },
    };
    const {pause, outcome} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-once',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
            policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-once': CLICK_BODY},
        port,
        view,
    });

    assert.equal(clicks.length, 1, 'maxAttempts=1 runs the recovery exactly once after re-entry');
    assert.equal(outcome.status, 'recovered');
    if (outcome.status !== 'recovered') {return;}
    assert.equal(outcome.summary.checkpointId, 'cp-once');
    assert.equal(outcome.summary.applied, true);
    assert.equal(outcome.pause.reason, 'failure');
});

test('a successful no-retry Recovery skips the failed statement and completes in the same transaction', async () => {
    const view = await buildView();
    const clicks: string[] = [];
    const tableQueries: number[] = [];
    const port: StepExecutionPort = {
        execute: async (step) => {
            if (step.name === 'browser.query') {
                const args = step.args as {query?: string};
                if (args.query === 'table.currentRows') {
                    tableQueries.push(1);
                    return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'table not ready'}};
                }
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'fix-btn'}};
            }
            if (step.name === 'browser.click') {
                clicks.push((step.args as {nodeId?: string}).nodeId ?? '');
                return {stepId: step.id, ok: true, data: {clicked: true}};
            }
            throw new Error(`unexpected step: ${step.name}`);
        },
    };
    const {pause, outcome, session} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-no-retry',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
            policy: {maxAttempts: 1, retryOriginal: false},
                input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-no-retry': CLICK_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'recovered_with_retry');
    if (outcome.status !== 'recovered_with_retry') {return;}
    assert.equal(outcome.advance.status, 'completed');
    if (outcome.advance.status !== 'completed') {return;}
    assert.deepEqual(outcome.advance.output, {done: true});
    assert.deepEqual(outcome.summary, {
        checkpointId: 'cp-no-retry',
        applied: true,
        retried: false,
    });
    assert.deepEqual(clicks, ['fix-btn'], 'the recovery handled the failed step');
    assert.equal(tableQueries.length, 1, 'the failed read is never re-executed (skipped)');
    assert.equal(session.auditEffects().length, 1);
});

test('a no-retry Recovery skips a failed statement nested in an if block and unwinds to the parent', async () => {
    const view = await buildView();
    const clicks: string[] = [];
    let tableQueries = 0;
    const port: StepExecutionPort = {
        execute: async (step) => {
            if (step.name === 'browser.query') {
                const args = step.args as {query?: string};
                if (args.query === 'table.currentRows') {
                    tableQueries += 1;
                    return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'nested table not ready'}};
                }
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'fix-btn'}};
            }
            if (step.name === 'browser.click') {
                clicks.push((step.args as {nodeId?: string}).nodeId ?? '');
                return {stepId: step.id, ok: true, data: {clicked: true}};
            }
            throw new Error(`unexpected step: ${step.name}`);
        },
    };
    const {outcome} = await runRecovery({
        program: [
            'if input.run:',
            '  let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        input: {run: true, done: true},
        checkpoints: [{
            id: 'cp-if-no-retry',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
            policy: {maxAttempts: 1, retryOriginal: false},
            input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-if-no-retry': CLICK_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'recovered_with_retry');
    if (outcome.status !== 'recovered_with_retry') {return;}
    assert.equal(outcome.advance.status, 'completed');
    if (outcome.advance.status !== 'completed') {return;}
    assert.deepEqual(outcome.advance.output, {done: true});
    assert.equal(tableQueries, 1, 'the failed nested statement is skipped, not replayed');
    assert.deepEqual(clicks, ['fix-btn']);
});

test('a no-retry Recovery skips a failed statement nested in a for body and unwinds the loop frame', async () => {
    const view = await buildView();
    const clicks: string[] = [];
    let tableQueries = 0;
    const port: StepExecutionPort = {
        execute: async (step) => {
            if (step.name === 'browser.query') {
                const args = step.args as {query?: string};
                if (args.query === 'table.currentRows') {
                    tableQueries += 1;
                    return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'loop table not ready'}};
                }
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'fix-btn'}};
            }
            if (step.name === 'browser.click') {
                clicks.push((step.args as {nodeId?: string}).nodeId ?? '');
                return {stepId: step.id, ok: true, data: {clicked: true}};
            }
            throw new Error(`unexpected step: ${step.name}`);
        },
    };
    const {outcome} = await runRecovery({
        program: [
            'for item in input.items:',
            '  let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        input: {items: ['only'], done: true},
        checkpoints: [{
            id: 'cp-for-no-retry',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
            policy: {maxAttempts: 1, retryOriginal: false},
            input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-for-no-retry': CLICK_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'recovered_with_retry');
    if (outcome.status !== 'recovered_with_retry') {return;}
    assert.equal(outcome.advance.status, 'completed');
    if (outcome.advance.status !== 'completed') {return;}
    assert.deepEqual(outcome.advance.output, {done: true});
    assert.equal(tableQueries, 1, 'the failed loop statement is skipped, not replayed');
    assert.deepEqual(clicks, ['fix-btn']);
});

test('an approved irreversible Recovery barrier resumes the same body without duplicating prior effects', async () => {
    const view = await buildView();
    let queryFailed = false;
    const clicks: string[] = [];
    const port: StepExecutionPort = {
        execute: async (step) => {
            if (step.name === 'browser.query') {
                const args = step.args as {query?: string; businessTag?: string};
                if (args.query === 'table.currentRows') {
                    if (!queryFailed) {
                        queryFailed = true;
                        return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'table not ready'}};
                    }
                    return {stepId: step.id, ok: true, data: {kind: 'value', value: [{id: 'row-1'}]}};
                }
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: args.businessTag === 'order.form.main' ? 'approve-btn' : 'submit-btn'}};
            }
            if (step.name === 'browser.click') {
                clicks.push((step.args as {nodeId?: string}).nodeId ?? '');
                return {stepId: step.id, ok: true, data: {clicked: true}};
            }
            throw new Error(`unexpected step: ${step.name}`);
        },
    };
    const {session, pause, outcome} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-approval',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
            policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-approval': APPROVAL_BODY},
        port,
        entityRulesResolver: irreversibleResolver(),
        view,
    });

    assert.equal(outcome.status, 'needs_approval');
    if (outcome.status !== 'needs_approval') {return;}
    assert.equal(outcome.pause.reason, 'barrier');
    assert.equal(outcome.pause.effect.semantics.reversibility, 'irreversible');
    assert.deepEqual(clicks, ['submit-btn'], 'the reversible effect before the barrier ran once, the irreversible one is not crossed');
    assert.equal(session.auditEffects().length, 1);
    assert.equal(pause.reason, 'failure');

    const approved = await session.crossBarrier(outcome.pause.continuationId);
    assert.equal(approved.status, 'completed');
    if (approved.status !== 'completed') {return;}
    assert.deepEqual(approved.output, {done: true});
    assert.deepEqual(clicks, ['submit-btn', 'approve-btn'], 'the irreversible effect is crossed exactly once after approval');
    assert.equal(session.auditEffects().length, 2);
    assert.equal(session.auditEffects()[0].effect.stepName, 'browser.click');
    assert.equal(session.auditEffects()[1].effect.stepName, 'browser.click');
});

test('retained entityExists honors the trigger entityRules control conservatively', async () => {
    const view = await buildView();
    const {port} = queryHarness();
    const {outcome} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-entity-explicit',
            kind: 'recovery',
            trigger: {
                matchRules: [
                    {errorCode: 'ERR_NOT_FOUND'},
                    {entityExists: {query: 'OrdersTable', kind: 'table', businessTag: 'order.table.main'}},
                ],
                entityRules: {selection: 'explicit', profiles: ['orders-table'], strict: true},
            },
            policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-entity-explicit': CLICK_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'recovered_with_retry');
    if (outcome.status !== 'recovered_with_retry') {return;}
    assert.equal(outcome.summary.checkpointId, 'cp-entity-explicit');
});

test('retained entityExists never matches an entity from a different explicitly requested profile', async () => {
    const view = await buildView();
    const {port} = queryHarness();
    const {pause, outcome, session} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-cross-profile',
            kind: 'recovery',
            trigger: {
                matchRules: [
                    {errorCode: 'ERR_NOT_FOUND'},
                    {entityExists: {query: 'OrdersForm', kind: 'form', businessTag: 'order.form.main'}},
                ],
                entityRules: {selection: 'explicit', profiles: ['orders-table'], strict: true},
            },
            policy: {maxAttempts: 1, retryOriginal: true},
            input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-cross-profile': CLICK_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'none', 'orders-form must not satisfy an orders-table-only trigger');
    assert.equal(pause.reason, 'failure');
    assert.equal(session.auditEffects().length, 0);
});

test('retained entityExists no-matches when the requested rule profile is absent from the frozen view', async () => {
    const view = await buildView();
    const {port} = queryHarness();
    const {pause, outcome, session} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-entity-missing-profile',
            kind: 'recovery',
            trigger: {
                matchRules: [
                    {errorCode: 'ERR_NOT_FOUND'},
                    {entityExists: {query: 'OrdersTable', kind: 'table', businessTag: 'order.table.main'}},
                ],
                entityRules: {selection: 'explicit', profiles: ['orders-table', 'missing-profile'], strict: true},
            },
            policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-entity-missing-profile': CLICK_BODY},
        port,
        view,
    });

    assert.equal(outcome.status, 'none');
    assert.equal(pause.reason, 'failure');
    assert.equal(session.auditEffects().length, 0);
});

test('the product approval fast-path (debug.cross_barrier) resumes an irreversible Recovery barrier in the same transaction', async () => {
    const view = await buildView();
    let queryFailed = false;
    const clicks: string[] = [];
    const port: StepExecutionPort = {
        execute: async (step) => {
            if (step.name === 'browser.query') {
                const args = step.args as {query?: string; businessTag?: string};
                if (args.query === 'table.currentRows') {
                    if (!queryFailed) {
                        queryFailed = true;
                        return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'table not ready'}};
                    }
                    return {stepId: step.id, ok: true, data: {kind: 'value', value: [{id: 'row-1'}]}};
                }
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: args.businessTag === 'order.form.main' ? 'approve-btn' : 'submit-btn'}};
            }
            if (step.name === 'browser.click') {
                clicks.push((step.args as {nodeId?: string}).nodeId ?? '');
                return {stepId: step.id, ok: true, data: {clicked: true}};
            }
            throw new Error(`unexpected step: ${step.name}`);
        },
    };
    const {session, outcome} = await runRecovery({
        program: [
            'let rows = query table "order.list" currentRows',
            'output done = input.done',
        ].join('\n'),
        checkpoints: [{
            id: 'cp-approval-fastpath',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
            policy: {maxAttempts: 1, retryOriginal: true},
                input: {done: true},
            body: {language: 'dsl', source: 'body.dsl'},
        }],
        bodies: {'cp-approval-fastpath': APPROVAL_BODY},
        port,
        entityRulesResolver: irreversibleResolver(),
        view,
    });

    assert.equal(outcome.status, 'needs_approval');
    if (outcome.status !== 'needs_approval') {return;}

    const tools = createPausedDslDebugAgentTools(session, outcome.pause);
    const crossBarrier = tools.tools.find((tool) => tool.name === 'debug.cross_barrier');
    assert.ok(crossBarrier, 'the approval fast-path exposes debug.cross_barrier for the recovery barrier');
    const approved = await crossBarrier!.execute('hitl-approval', {});
    const details = approved.details as {status: string; output?: Record<string, unknown>};

    assert.equal(details.status, 'completed');
    if (details.status !== 'completed') {return;}
    assert.deepEqual(details.output, {done: true});
    assert.deepEqual(clicks, ['submit-btn', 'approve-btn'], 'prior recovery effect is not duplicated; the irreversible effect is crossed once after approval');
    assert.equal(session.auditEffects().length, 2);
});