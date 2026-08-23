import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import type {WorldView, WorldViewSource} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/snapshot';
import type {RunStepsDeps} from '../../../../../src/runner/run_steps';
import type {StepUnion} from '../../../../../src/runner/steps/types';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const deps = {} as RunStepsDeps;

const createViews = async (): Promise<[WorldView, WorldView]> => {
    const pageKey = {};
    const store = new PageSnapshotSessionStore<object>();
    const fixture = createV2BusinessPage();
    const firstEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const secondCapture = structuredClone(fixture.capture);
    secondCapture.control.observation.identity.captureRevision = 2;
    const secondEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        reason: 'explicit',
        capture: async () => secondCapture,
    });
    const toView = (entry: typeof firstEntry): WorldView => Object.freeze({
        workspaceName: 'ws-1',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    return [toView(firstEntry), toView(secondEntry)];
};

test('paused DSL execution binds one pinned WorldView to each retained continuation', async () => {
    const [firstView, secondView] = await createViews();
    let live = firstView;
    const source: WorldViewSource = {
        pin: async () => live,
    };
    let snapshotCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: `
            snapshot
            output result = input.value
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {value: 9},
            stepExecutionPort: {
                execute: async (step: StepUnion) => {
                    if (step.name === 'browser.snapshot') {
                        snapshotCalls += 1;
                        live = secondView;
                    }
                    return {stepId: step.id, ok: true, data: {}};
                },
            },
        },
        worldViewSource: source,
        debug: {initialMode: 'step'},
    });

    const first = await execution.waitForPause();
    assert.equal(first.location.path, 'body.0');
    assert.equal(first.world.revision.captureRevision, 1);
    assert.deepEqual(first.scope.output, {});

    const rows = execution.query(first.continuationId, {
        op: 'entity',
        businessTag: 'order.table.main',
        query: 'table.rowCount',
    });
    assert.equal(rows.ok, true);
    assert.equal(rows.world.revision.captureRevision, 1);

    const stepResult = await execution.advance(first.continuationId, 'step');
    assert.equal(stepResult.status, 'paused');
    if (stepResult.status !== 'paused') {throw new Error('expected second pause');}
    const second = stepResult.pause;
    assert.equal(snapshotCalls, 1);
    assert.equal(second.location.path, 'body.1');
    assert.equal(second.world.revision.captureRevision, 2);

    assert.throws(
        () => execution.query(first.continuationId, {from: 'snapshot'}),
        /continuation is not active/,
    );

    const completed = await execution.advance(second.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    if (completed.status !== 'completed') {throw new Error('expected completion');}
    assert.deepEqual(completed.output, {result: 9});
    assert.equal(snapshotCalls, 1);
});

test('paused DSL execution exposes pure compute against explicit pause-local scope values', async () => {
    const [view] = await createViews();
    const execution = createDslDebugExecutionSession({
        source: 'output result = input.value',
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {value: 4},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const paused = await execution.waitForPause();
    const computed = execution.compute(paused.continuationId, {
        op: 'eq',
        args: [
            {ref: {path: 'input.value'}},
            {literal: 4},
        ],
    }, {input: paused.scope.input});

    assert.equal(computed.ok, true);
    if (computed.ok) {assert.equal(computed.value, true);}
    assert.deepEqual(computed.world.revision, paused.world.revision);

    const completed = await execution.advance(paused.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
});

test('paused DSL execution exposes the pending browser effect before mutation', async () => {
    const [view] = await createViews();
    const calls: string[] = [];
    const execution = createDslDebugExecutionSession({
        source: `
            let target = query entity.target "orders.main" {
              kind: "table.module_action"
              actionIntent: "approve"
            }
            click target
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            stepExecutionPort: {
                execute: async (step) => {
                    calls.push(step.name);
                    if (step.name === 'browser.query') {
                        return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'approve-button'}};
                    }
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakBeforeEffects: true},
    });

    const paused = await execution.waitForPause();
    assert.equal(paused.reason, 'effect');
    if (paused.reason !== 'effect') {throw new Error('expected effect pause');}
    assert.equal(paused.location.path, 'body.1');
    assert.equal(paused.effect.stepName, 'browser.click');
    assert.deepEqual(paused.effect.args, {nodeId: 'approve-button'});
    assert.deepEqual(calls, ['browser.query']);

    const completed = await execution.advance(paused.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    assert.deepEqual(calls, ['browser.query', 'browser.click']);
});

test('failure pause keeps WorldView queryable and advance returns a structured failed terminal state', async () => {
    const [view] = await createViews();
    let clickCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: 'click input.target',
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {target: {nodeId: 'missing-button'}},
            stepExecutionPort: {
                execute: async (step) => {
                    clickCalls += 1;
                    return {
                        stepId: step.id,
                        ok: false,
                        error: {code: 'ERR_NOT_FOUND', message: 'missing button', details: {matches: 0}},
                    };
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakOnFailure: true},
    });

    const paused = await execution.waitForPause();
    assert.equal(paused.reason, 'failure');
    if (paused.reason !== 'failure') {throw new Error('expected failure pause');}
    assert.equal(paused.failure.code, 'ERR_NOT_FOUND');
    assert.equal(clickCalls, 1);

    const rows = execution.query(paused.continuationId, {
        op: 'entity',
        businessTag: 'order.table.main',
        query: 'table.rowCount',
    });
    assert.equal(rows.ok, true);
    assert.deepEqual(rows.world.revision, paused.world.revision);

    const terminal = await execution.advance(paused.continuationId, 'continue');
    assert.deepEqual(terminal, {
        status: 'failed',
        failure: paused.failure,
    });
    assert.equal(clickCalls, 1);
});

test('aborting an effect pause returns aborted without executing the pending browser effect', async () => {
    const [view] = await createViews();
    let clickCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: 'click input.target',
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {target: {nodeId: 'dangerous-button'}},
            stepExecutionPort: {
                execute: async (step) => {
                    clickCalls += 1;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakBeforeEffects: true},
    });

    const paused = await execution.waitForPause();
    assert.equal(paused.reason, 'effect');
    assert.deepEqual(execution.effects(paused.continuationId), []);
    const terminal = await execution.advance(paused.continuationId, 'abort');
    assert.equal(terminal.status, 'aborted');
    assert.equal(clickCalls, 0);
});

test('effect journal records only executed effects with before and after World revisions', async () => {
    const [firstView, secondView] = await createViews();
    let revision = 1;
    const execution = createDslDebugExecutionSession({
        source: `
            snapshot
            click input.target
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {target: {nodeId: 'submit'}, done: true},
            stepExecutionPort: {
                execute: async (step) => {
                    if (step.name === 'browser.click') {revision = 2;}
                    return {stepId: step.id, ok: true, data: {}};
                },
            },
        },
        worldViewSource: {pin: async () => revision === 1 ? firstView : secondView},
        debug: {breakBeforeEffects: true},
    });

    const beforeEffect = await execution.waitForPause();
    assert.equal(beforeEffect.reason, 'effect');
    assert.deepEqual(execution.effects(beforeEffect.continuationId), []);

    const stepped = await execution.advance(beforeEffect.continuationId, 'step');
    assert.equal(stepped.status, 'paused');
    if (stepped.status !== 'paused') {throw new Error('expected pause after effect');}
    const effects = execution.effects(stepped.pause.continuationId);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].sequence, 1);
    assert.equal(effects[0].location.path, 'body.1');
    assert.equal(effects[0].effect.stepName, 'browser.click');
    assert.deepEqual(effects[0].effect.args, {nodeId: 'submit'});
    assert.deepEqual(effects[0].outcome, {status: 'succeeded'});
    assert.equal(effects[0].worldBefore.revision.captureRevision, 1);
    assert.equal(effects[0].worldAfter.revision.captureRevision, 2);
    assert.equal(Object.isFrozen(effects[0]), true);

    const completed = await execution.advance(stepped.pause.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
});

test('failed effects enter the journal before the failure pause', async () => {
    const [firstView, secondView] = await createViews();
    let revision = 1;
    const execution = createDslDebugExecutionSession({
        source: 'click input.target',
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {target: {nodeId: 'missing'}},
            stepExecutionPort: {
                execute: async (step) => {
                    revision = 2;
                    return {
                        stepId: step.id,
                        ok: false,
                        error: {code: 'ERR_NOT_FOUND', message: 'missing', details: {matches: 0}},
                    };
                },
            },
        },
        worldViewSource: {pin: async () => revision === 1 ? firstView : secondView},
        debug: {breakOnFailure: true},
    });

    const paused = await execution.waitForPause();
    assert.equal(paused.reason, 'failure');
    const effects = execution.effects(paused.continuationId);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].effect.stepName, 'browser.click');
    assert.deepEqual(effects[0].outcome, {
        status: 'failed',
        error: {code: 'ERR_NOT_FOUND', message: 'missing', details: {matches: 0}},
    });
    assert.equal(effects[0].worldBefore.revision.captureRevision, 1);
    assert.equal(effects[0].worldAfter.revision.captureRevision, 2);

    await execution.advance(paused.continuationId, 'continue');
});
test('advance keeps a stale continuation frozen until explicit World refresh', async () => {
    const [firstView, secondView] = await createViews();
    let live = firstView;
    const execution = createDslDebugExecutionSession({
        source: 'output result = input.value',
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {value: 11},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => live},
        debug: {initialMode: 'step'},
    });

    const paused = await execution.waitForPause();
    assert.equal(paused.world.revision.captureRevision, 1);
    live = secondView;

    const conflict = await execution.advance(paused.continuationId, 'continue');
    assert.equal(conflict.status, 'conflict');
    if (conflict.status !== 'conflict') {throw new Error('expected World conflict');}
    assert.equal(conflict.conflict.expected.revision.captureRevision, 1);
    assert.equal(conflict.conflict.actual.revision.captureRevision, 2);

    const stillPinned = execution.query(paused.continuationId, {
        op: 'entity',
        businessTag: 'order.table.main',
        query: 'table.rowCount',
    });
    assert.equal(stillPinned.world.revision.captureRevision, 1);

    const refreshed = await execution.refresh(paused.continuationId);
    assert.equal(refreshed.continuationId, paused.continuationId);
    assert.equal(refreshed.location.path, paused.location.path);
    assert.equal(refreshed.world.revision.captureRevision, 2);

    const completed = await execution.advance(paused.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    if (completed.status !== 'completed') {throw new Error('expected completion');}
    assert.deepEqual(completed.output, {result: 11});
});

test('effect OCC conflicts before mutation and journal starts from the refreshed World', async () => {
    const [firstView, secondView] = await createViews();
    let live = firstView;
    let clickCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: `
            click input.target
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {target: {nodeId: 'submit'}, done: true},
            stepExecutionPort: {
                execute: async (step) => {
                    clickCalls += 1;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => live},
        debug: {breakBeforeEffects: true},
    });

    const paused = await execution.waitForPause();
    assert.equal(paused.reason, 'effect');
    assert.equal(paused.world.revision.captureRevision, 1);
    live = secondView;

    const conflict = await execution.advance(paused.continuationId, 'step');
    assert.equal(conflict.status, 'conflict');
    assert.equal(clickCalls, 0);
    assert.deepEqual(execution.effects(paused.continuationId), []);

    const refreshed = await execution.refresh(paused.continuationId);
    assert.equal(refreshed.world.revision.captureRevision, 2);
    const stepped = await execution.advance(paused.continuationId, 'step');
    assert.equal(stepped.status, 'paused');
    if (stepped.status !== 'paused') {throw new Error('expected next statement pause');}
    assert.equal(clickCalls, 1);

    const effects = execution.effects(stepped.pause.continuationId);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].worldBefore.revision.captureRevision, 2);
    assert.equal(effects[0].worldAfter.revision.captureRevision, 2);

    const completed = await execution.advance(stepped.pause.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
});
test('effect delta is materialized on demand from retained WorldViews', async () => {
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const beforeEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const changedCapture = structuredClone(fixture.capture);
    changedCapture.control.observation.identity.captureRevision = 2;
    (changedCapture.control.observation.text as Record<string, string | undefined>)[fixture.nodeIds.panel] = 'effect updated panel';
    const afterEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        reason: 'explicit',
        capture: async () => changedCapture,
    });
    const toView = (entry: typeof beforeEntry): WorldView => Object.freeze({
        workspaceName: 'ws-1',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    const beforeView = toView(beforeEntry);
    const afterView = toView(afterEntry);
    let live = beforeView;

    const execution = createDslDebugExecutionSession({
        source: `
            click input.target
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {target: {nodeId: 'submit'}, done: true},
            stepExecutionPort: {
                execute: async (step) => {
                    live = afterView;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => live},
        debug: {breakBeforeEffects: true},
    });

    const effectPause = await execution.waitForPause();
    const stepped = await execution.advance(effectPause.continuationId, 'step');
    assert.equal(stepped.status, 'paused');
    if (stepped.status !== 'paused') {throw new Error('expected statement pause');}

    const delta = execution.diff(stepped.pause.continuationId, 1);
    assert.equal(delta.ok, true);
    if (!delta.ok) {throw new Error('expected effect delta');}
    assert.equal(delta.effectSequence, 1);
    assert.equal(delta.diff.mode, 'diff');
    assert.equal(delta.diff.projection.meta.changedNodeCount, 1);

    const missing = execution.diff(stepped.pause.continuationId, 2);
    assert.deepEqual(missing, {
        ok: false,
        error: {code: 'ERR_NOT_FOUND', message: 'effect journal entry not found: 2'},
    });

    await execution.advance(stepped.pause.continuationId, 'abort');
});
