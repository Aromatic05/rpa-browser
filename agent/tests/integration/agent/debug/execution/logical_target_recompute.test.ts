import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {createPausedDslDebugAgentTools} from '../../../../../src/agent/debug/execution/agent_tools';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import type {DslEntityRulesResolver} from '../../../../../src/automation/dsl/link';
import type {StepExecutionPort} from '../../../../../src/automation/dsl/runtime/run_dsl';
import type {RunStepsDeps} from '../../../../../src/automation/runner/run_steps';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const source = `
use entity_rules "orders-form" as orders
click orders.orderForm.submit
output done = input.done
`;

const resolver = (irreversible: boolean): DslEntityRulesResolver => ({
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
                        ...(irreversible ? {effect: {reversibility: 'irreversible' as const}} : {}),
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
    secondCapture.control.observation.identity.captureRevision = 2;
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
        workspaceName: 'ws-logical-target',
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

const runCase = async (barrier: boolean): Promise<void> => {
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
            workspaceName: 'ws-logical-target',
            deps: {} as RunStepsDeps,
            input: {done: true},
            entityRulesResolver: resolver(barrier),
            stepExecutionPort: port,
        },
        worldViewSource: {pin: async () => current},
        debug: {
            ...(barrier ? {barrierOn: ['irreversible' as const]} : {breakBeforeEffects: true}),
            breakpoints: ['body.1'],
        },
    });

    const first = await execution.waitForPause();
    assert.equal(first.reason, barrier ? 'barrier' : 'effect');
    if (first.reason !== 'effect' && first.reason !== 'barrier') {throw new Error('expected effect pause');}
    assert.equal((first.effect.args as any).nodeId, views.oldTarget);
    assert.deepEqual(first.effect.logicalTarget, {
        kind: 'query',
        query: {
            op: 'entity.target',
            businessTag: 'order.form.main',
            target: {kind: 'form.action', actionIntent: 'submit'},
        },
    });

    current = views.second;
    const conflict = barrier
        ? await execution.crossBarrier(first.continuationId)
        : await execution.advance(first.continuationId, 'continue');
    assert.equal(conflict.status, 'conflict');
    assert.deepEqual(clickTargets, []);

    const refreshed = await execution.refresh(first.continuationId);
    assert.equal(refreshed.world.revision.captureRevision, 2);
    const stale = barrier
        ? await execution.crossBarrier(first.continuationId)
        : await execution.advance(first.continuationId, 'continue');
    assert.equal(stale.status, 'recompute_required');
    if (stale.status !== 'recompute_required') {throw new Error('expected recompute_required');}
    assert.equal(stale.target.resolvedAt.revision.captureRevision, 1);
    assert.equal(stale.target.current.revision.captureRevision, 2);
    assert.deepEqual(clickTargets, []);

    const recomputed = execution.recomputeEffect(first.continuationId);
    assert.equal(recomputed.status, 'recomputed');
    if (recomputed.status !== 'recomputed') {throw new Error('expected recomputed effect');}
    assert.equal((recomputed.pause.effect.args as any).nodeId, views.newTarget);
    assert.equal(queryCalls, 1);

    const advanced = barrier
        ? await execution.crossBarrier(first.continuationId)
        : await execution.advance(first.continuationId, 'continue');
    assert.equal(advanced.status, 'paused');
    if (advanced.status !== 'paused') {throw new Error('expected output breakpoint');}
    assert.deepEqual(clickTargets, [views.newTarget]);
    assert.equal(queryCalls, 1);
    const effects = execution.effects(advanced.pause.continuationId);
    assert.equal(effects.length, 1);
    assert.equal((effects[0].effect.args as any).nodeId, views.newTarget);
    assert.deepEqual(effects[0].effect.logicalTarget, {
        ...first.effect.logicalTarget,
        resolvedAt: {pageEpoch: 'v2-business', captureRevision: 2},
    }, 'recompute refreshes the expected revision from the pinned world, never retaining the stale observed revision');

    await execution.advance(advanced.pause.continuationId, 'continue');
};

test('refresh requires logical target recompute before a paused effect can execute', async () => {
    await runCase(false);
});

test('refresh requires logical target recompute before crossing an irreversible barrier', async () => {
    await runCase(true);
});

test('Agent tools refresh, recompute and cross a stale logical barrier without a second browser query', async () => {
    const views = await createViews();
    let current = views.first;
    let queryCalls = 0;
    const clickTargets: string[] = [];
    const execution = createDslDebugExecutionSession({
        source,
        context: {
            workspaceName: 'ws-logical-target',
            deps: {} as RunStepsDeps,
            input: {done: true},
            entityRulesResolver: resolver(true),
            stepExecutionPort: {
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
            },
        },
        worldViewSource: {pin: async () => current},
        debug: {barrierOn: ['irreversible'], breakpoints: ['body.1']},
    });
    const first = await execution.waitForPause();
    assert.equal(first.reason, 'barrier');
    const tools = createPausedDslDebugAgentTools(execution, first);
    const tool = (name: string) => tools.tools.find((candidate) => candidate.name === name)!;

    current = views.second;
    const conflict = await tool('debug.cross_barrier').execute('cross-conflict', {});
    assert.equal((conflict.details as any).status, 'conflict');
    const refreshed = await tool('debug.refresh').execute('refresh', {});
    assert.equal((refreshed.details as any).pause.world.revision.captureRevision, 2);
    const stale = await tool('debug.cross_barrier').execute('cross-stale', {});
    assert.equal((stale.details as any).status, 'recompute_required');
    assert.deepEqual(clickTargets, []);

    const rebound = await tool('debug.recompute_effect').execute('recompute', {});
    assert.equal((rebound.details as any).status, 'recomputed');
    assert.equal((rebound.details as any).pause.effect.args.nodeId, views.newTarget);
    assert.equal(queryCalls, 1);

    const crossed = await tool('debug.cross_barrier').execute('cross', {});
    assert.equal((crossed.details as any).status, 'paused');
    assert.deepEqual(clickTargets, [views.newTarget]);
    assert.equal(queryCalls, 1);

    await tool('debug.continue').execute('continue', {});
});

test('query revision prevents executing a target that went stale before the effect pause was observed', async () => {
    const views = await createViews();
    let current = views.first;
    const clickTargets: string[] = [];
    const execution = createDslDebugExecutionSession({
        source,
        context: {
            workspaceName: 'ws-logical-target',
            deps: {} as RunStepsDeps,
            input: {done: true},
            entityRulesResolver: resolver(false),
            stepExecutionPort: {
                execute: async (step) => {
                    if (step.name === 'browser.query') {
                        current = views.second;
                        return {
                            stepId: step.id,
                            ok: true,
                            data: {
                                kind: 'nodeId',
                                nodeId: views.oldTarget,
                                meta: {pageEpoch: 'v2-business', captureRevision: 1},
                            },
                        };
                    }
                    if (step.name === 'browser.click') {
                        clickTargets.push(step.args.nodeId ?? '');
                        return {stepId: step.id, ok: true, data: {clicked: true}};
                    }
                    throw new Error(`unexpected step: ${step.name}`);
                },
            },
        },
        worldViewSource: {pin: async () => current},
        debug: {breakBeforeEffects: true, breakpoints: ['body.1']},
    });

    const pause = await execution.waitForPause();
    assert.equal(pause.reason, 'effect');
    if (pause.reason !== 'effect') {throw new Error('expected effect pause');}
    assert.equal(pause.world.revision.captureRevision, 2);
    assert.deepEqual(pause.effect.logicalTarget?.resolvedAt, {
        pageEpoch: 'v2-business',
        captureRevision: 1,
    });

    const stale = await execution.advance(pause.continuationId, 'continue');
    assert.equal(stale.status, 'recompute_required');
    assert.deepEqual(clickTargets, []);
    await execution.advance(pause.continuationId, 'abort');
});
