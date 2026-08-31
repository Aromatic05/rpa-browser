import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import type {DslEntityRulesResolver} from '../../../../../src/automation/dsl/link';
import type {ExpectedWorldPrecondition, StepExecutionPort} from '../../../../../src/automation/dsl/runtime/run_dsl';
import type {RunStepsDeps} from '../../../../../src/automation/runner/run_steps';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const source = `
use entity_rules "orders-form" as orders
click orders.orderForm.submit
output done = input.done
`;

const resolver = (): DslEntityRulesResolver => ({
    resolveProfile: (profileName) => profileName === 'orders-form'
        ? {
            profile: {
                profileName: 'orders-form',
                entities: [{
                    entityKey: 'orderForm',
                    businessTag: 'order.form.main',
                    kind: 'form',
                    fields: [],
                    actions: [{
                        actionIntent: 'submit',
                        targetKind: 'form.action',
                        effect: {reversibility: 'irreversible' as const},
                    }],
                    columns: [],
                    rowActions: [],
                    supportedQueries: ['form.fields', 'form.actions'],
                }],
            },
            diagnostics: [],
        }
        : {profile: null, diagnostics: []},
});

const createViews = async (): Promise<{
    first: WorldView;
    second: WorldView;
    oldTarget: string;
    newTarget: string;
}> => {
    const fixture = createV2BusinessPage();
    const firstCapture = structuredClone(fixture.capture);
    const secondCapture = structuredClone(fixture.capture);
    secondCapture.control.observation = {
        ...secondCapture.control.observation,
        identity: {pageEpoch: 'v2-business', captureRevision: 2},
    } as typeof secondCapture.control.observation;
    const formProfile = secondCapture.entityRules?.profiles['orders-form'];
    assert.ok(formProfile);
    const root = Object.values(formProfile.semanticBindings.byId)
        .find((binding) => binding.annotation.businessTag === 'order.form.main');
    assert.ok(root);
    const actions = root.annotation.formActions as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(actions), true);
    root.annotation.formActions = actions.map((action) => action.actionIntent === 'submit'
        ? {...action, nodeId: fixture.nodeIds.buyer}
        : action);

    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const firstEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        capture: async () => firstCapture,
    });
    const secondEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        reason: 'explicit',
        capture: async () => secondCapture,
    });
    const view = (entry: typeof firstEntry): WorldView => Object.freeze({
        workspaceName: 'ws-cas',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    return {
        first: view(firstEntry),
        second: view(secondEntry),
        oldTarget: fixture.nodeIds.submit,
        newTarget: fixture.nodeIds.buyer,
    };
};

const matches = (precondition: ExpectedWorldPrecondition, view: WorldView): boolean =>
    precondition.revision.pageEpoch === view.revision.pageEpoch
    && precondition.revision.captureRevision === view.revision.captureRevision;

test('recompute refreshes the logical effect revision and the same retained transaction succeeds exactly once', async () => {
    const views = await createViews();
    let current = views.first;
    let queryCalls = 0;
    const clickTargets: string[] = [];
    const clickPreconditions: Array<ExpectedWorldPrecondition | undefined> = [];
    const port: StepExecutionPort = {
        execute: async (step, precondition) => {
            if (step.name === 'browser.query') {
                queryCalls += 1;
                const nodeId = current.revision.captureRevision === 2 ? views.newTarget : views.oldTarget;
                return {
                    stepId: step.id,
                    ok: true,
                    data: {
                        kind: 'nodeId',
                        nodeId,
                        meta: {pageEpoch: current.revision.pageEpoch, captureRevision: current.revision.captureRevision},
                    },
                };
            }
            if (step.name === 'browser.click') {
                clickPreconditions.push(precondition);
                if (precondition && !matches(precondition, current)) {
                    return {
                        stepId: step.id,
                        ok: false,
                        error: {code: 'ERR_AGENT_WORLD_CONFLICT', message: 'world moved past the expected observation'},
                    };
                }
                clickTargets.push(step.args.nodeId ?? '');
                return {stepId: step.id, ok: true, data: {clicked: true}};
            }
            throw new Error(`unexpected step: ${step.name}`);
        },
    };
    const execution = createDslDebugExecutionSession({
        source,
        context: {
            workspaceName: 'ws-cas',
            deps: {} as RunStepsDeps,
            input: {done: true},
            entityRulesResolver: resolver(),
            stepExecutionPort: port,
        },
        worldViewSource: {pin: async () => current},
        debug: {barrierOn: ['irreversible'], breakpoints: ['body.1']},
    });

    const first = await execution.waitForPause();
    assert.equal(first.reason, 'barrier');
    if (first.reason !== 'barrier') {throw new Error('expected a barrier pause');}
    assert.deepEqual(first.effect.logicalTarget?.resolvedAt, {
        pageEpoch: 'v2-business',
        captureRevision: 1,
    });

    current = views.second;
    const conflict = await execution.crossBarrier(first.continuationId);
    assert.equal(conflict.status, 'conflict');
    assert.deepEqual(clickTargets, []);

    const refreshed = await execution.refresh(first.continuationId);
    assert.equal(refreshed.world.revision.captureRevision, 2);
    const stale = await execution.crossBarrier(first.continuationId);
    assert.equal(stale.status, 'recompute_required');
    if (stale.status !== 'recompute_required') {throw new Error('expected recompute_required');}
    assert.deepEqual(stale.target.resolvedAt.revision, {pageEpoch: 'v2-business', captureRevision: 1});
    assert.deepEqual(stale.target.current.revision, {pageEpoch: 'v2-business', captureRevision: 2});

    const recomputed = execution.recomputeEffect(first.continuationId);
    assert.equal(recomputed.status, 'recomputed');
    if (recomputed.status !== 'recomputed') {throw new Error('expected a recomputed effect');}
    assert.deepEqual(recomputed.pause.effect.logicalTarget?.resolvedAt, {
        pageEpoch: 'v2-business',
        captureRevision: 2,
    });
    assert.equal(queryCalls, 1, 'recompute re-resolves the stored query against the pinned world, not the browser');

    const advanced = await execution.crossBarrier(first.continuationId);
    assert.equal(advanced.status, 'paused');
    if (advanced.status !== 'paused') {throw new Error('expected an output breakpoint');}
    assert.deepEqual(clickTargets, [views.newTarget], 'the recomputed effect executes exactly once');
    assert.deepEqual(clickPreconditions, [{kind: 'expected-world', revision: {pageEpoch: 'v2-business', captureRevision: 2}}]);
    assert.equal(queryCalls, 1, 'no second browser query after recompute');

    const effects = execution.effects(advanced.pause.continuationId);
    assert.equal(effects.length, 1);
    assert.deepEqual(effects[0].effect.logicalTarget?.resolvedAt, {
        pageEpoch: 'v2-business',
        captureRevision: 2,
    });

    await execution.advance(advanced.pause.continuationId, 'continue');
});

test('recompute derives the current revision even when the original browser query omitted meta', async () => {
    const views = await createViews();
    let current = views.first;
    let queryCalls = 0;
    const clickTargets: string[] = [];
    const port: StepExecutionPort = {
        execute: async (step) => {
            if (step.name === 'browser.query') {
                queryCalls += 1;
                return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: views.oldTarget}};
            }
            if (step.name === 'browser.click') {
                clickTargets.push(step.args.nodeId ?? '');
                return {stepId: step.id, ok: true, data: {clicked: true}};
            }
            throw new Error(`unexpected step: ${step.name}`);
        },
    };
    const execution = createDslDebugExecutionSession({
        source,
        context: {
            workspaceName: 'ws-cas',
            deps: {} as RunStepsDeps,
            input: {done: true},
            entityRulesResolver: resolver(),
            stepExecutionPort: port,
        },
        worldViewSource: {pin: async () => current},
        debug: {barrierOn: ['irreversible'], breakpoints: ['body.1']},
    });

    const first = await execution.waitForPause();
    assert.equal(first.reason, 'barrier');
    if (first.reason !== 'barrier') {throw new Error('expected a barrier pause');}
    assert.equal(first.effect.logicalTarget?.resolvedAt, undefined, 'no meta means no original resolvedAt');

    current = views.second;
    const conflict = await execution.crossBarrier(first.continuationId);
    assert.equal(conflict.status, 'conflict');
    await execution.refresh(first.continuationId);
    const stale = await execution.crossBarrier(first.continuationId);
    assert.equal(stale.status, 'recompute_required');

    const recomputed = execution.recomputeEffect(first.continuationId);
    assert.equal(recomputed.status, 'recomputed');
    if (recomputed.status !== 'recomputed') {throw new Error('expected a recomputed effect');}
    assert.deepEqual(recomputed.pause.effect.logicalTarget?.resolvedAt, {
        pageEpoch: 'v2-business',
        captureRevision: 2,
    }, 'recompute must derive the fresh world revision from the pinned entry, never a stale one');

    const advanced = await execution.crossBarrier(first.continuationId);
    assert.equal(advanced.status, 'paused');
    if (advanced.status !== 'paused') {throw new Error('expected an output breakpoint');}
    assert.deepEqual(clickTargets, [views.newTarget], 'recompute rebinds to the second view target');
    await execution.advance(advanced.pause.continuationId, 'continue');
});