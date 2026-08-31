import test from 'node:test';
import assert from 'node:assert/strict';
import {describeWorldView} from '../../../../../src/agent/worldview/descriptor';
import type {WorldView, WorldViewDescriptor} from '../../../../../src/agent/worldview/contracts';
import type {PageSnapshotSessionEntry} from '../../../../../src/automation/snapshot';
import type {DslEffectDescriptor, DslFailureDescriptor} from '../../../../../src/automation/dsl/debug/contracts';
import type {PausedDslDebugExecution} from '../../../../../src/agent/debug/execution/contracts';
import type {QueryIR} from '../../../../../src/program/query/contracts';
import {createRecoveryBudgetStore} from '../../../../../src/agent/debug/recovery/budget';
import {recoveryBudgetKey} from '../../../../../src/agent/debug/recovery/key';
import {
    nextActionGuidanceForBarrier,
    nextActionGuidanceForFailure,
    renderBarrierRecoveryGuidance,
    renderFailureRecoveryGuidance,
} from '../../../../../src/agent/debug/recovery/guidance';

const view: WorldView = Object.freeze({
    workspaceName: 'ws-recovery-guidance',
    tabName: 'main',
    pageUrl: '/orders',
    revision: Object.freeze({pageEpoch: 'epoch-1', captureRevision: 1}),
    entry: Object.freeze({}) as unknown as PageSnapshotSessionEntry,
});

const world: WorldViewDescriptor = describeWorldView(view);

const readFailure = (): DslFailureDescriptor => Object.freeze({
    kind: 'step',
    stepId: 'step-read',
    stepName: 'browser.query',
    classification: 'read',
    args: {expr: 'table.rowCount'},
    code: 'ERR_NOT_FOUND',
    message: 'no match',
});

const clickFailure = (): DslFailureDescriptor => Object.freeze({
    kind: 'step',
    stepId: 'step-click',
    stepName: 'browser.click',
    classification: 'effect',
    args: {nodeId: 'submit'},
    code: 'ERR_CLICK',
    message: 'click failed',
});

const failurePause = (
    failure: DslFailureDescriptor,
    path = 'body.0',
): Extract<PausedDslDebugExecution, {reason: 'failure'}> => Object.freeze({
    continuationId: 'cont-guidance',
    reason: 'failure',
    location: Object.freeze({
        programId: 'main',
        path,
        kind: 'output',
        loops: [],
        callStack: [],
    }),
    scope: Object.freeze({input: Object.freeze({}), vars: Object.freeze({}), output: Object.freeze({})}),
    world,
    failure,
});

const queryIr: QueryIR = Object.freeze({
    op: 'entity.target',
    businessTag: 'order.form.main',
    target: Object.freeze({kind: 'form.action', actionIntent: 'submit'}),
});

const barrierPause = (
    reversibility: 'unknown' | 'reversible' | 'compensatable' | 'irreversible',
    logicalTarget = false,
): Extract<PausedDslDebugExecution, {reason: 'barrier'}> => {
    const effect: DslEffectDescriptor = Object.freeze({
        stepId: 'step-barrier',
        stepName: 'browser.fill',
        args: {nodeId: 'buyer-input'},
        semantics: Object.freeze({reversibility}),
        ...(logicalTarget ? {logicalTarget: Object.freeze({
            kind: 'query' as const,
            query: queryIr,
        })} : {}),
    });
    return Object.freeze({
        continuationId: 'cont-barrier',
        reason: 'barrier',
        location: Object.freeze({
            programId: 'main',
            path: 'body.1',
            kind: 'output',
            loops: [],
            callStack: [],
        }),
        scope: Object.freeze({input: Object.freeze({}), vars: Object.freeze({}), output: Object.freeze({})}),
        world,
        effect,
    });
};

test('read failure guidance recommends retrying in place with a clear heading', () => {
    const guidance = nextActionGuidanceForFailure(failurePause(readFailure()));
    assert.match(guidance.heading, /class=read, executed-effect-none/);
    assert.match(guidance.heading, /main@body\.0/);
    assert.equal(guidance.terminalReason, undefined);
    assert.equal(guidance.recommendation.includes('Preferred:'), true);
    assert.equal(guidance.steps.some((step) => step.includes('Rewind to the statement savepoint from debug.rewind_plan')), true);
    assert.equal(guidance.steps.some((step) => step.includes('retry is safe')), true);
});

test('exhausted retry budget yields a deterministic terminal reason and a terminate step', () => {
    const pause = failurePause(readFailure());
    const store = createRecoveryBudgetStore();
    const key = recoveryBudgetKey(pause, 'retry')!;
    store.record(key, 'retry');
    store.record(key, 'retry');

    const guidance = nextActionGuidanceForFailure(pause, {budget: store, budgetKey: key});
    assert.equal(guidance.terminalReason?.code, 'TERMINAL_RECOVERY_BUDGET_EXHAUSTED');
    assert.match(guidance.recommendation, /^Terminate: TERMINAL_RECOVERY_BUDGET_EXHAUSTED/);
    assert.equal(guidance.steps.some((step) => step.includes('Call debug.continue')), true);
});

test('irreversible world-effect failure renders the deterministic terminal reason verbatim', () => {
    const anchor = Object.freeze({id: 'anchor-a', effectSequence: 0, world});
    const pause: Extract<PausedDslDebugExecution, {reason: 'failure'}> = Object.freeze({
        ...failurePause(clickFailure()),
        rollbackAnchor: anchor,
    });
    const guidance = nextActionGuidanceForFailure(pause, {
        effects: [Object.freeze({
            sequence: 1,
            location: pause.location,
            effect: Object.freeze({
                stepId: 'step-1',
                stepName: 'browser.click',
                args: {nodeId: 'submit'},
                semantics: Object.freeze({reversibility: 'irreversible'}),
            }),
            outcome: Object.freeze({status: 'succeeded'}),
            worldBefore: world,
            worldAfter: world,
        })],
    });
    const rendered = renderFailureRecoveryGuidance(guidance);
    assert.match(rendered, /TERMINAL: TERMINAL_IRREVERSIBLE_EFFECTS/);
    assert.match(rendered, /class=world_effect, executed-effect-irreversible/);
});

test('guidance rendering is deterministic for equal pauses', () => {
    const a = nextActionGuidanceForFailure(failurePause(readFailure()));
    const b = nextActionGuidanceForFailure(failurePause(readFailure()));
    assert.equal(renderFailureRecoveryGuidance(a), renderFailureRecoveryGuidance(b));
});

test('barrier guidance authorizes one effect and forbids repeating it', () => {
    const guidance = nextActionGuidanceForBarrier(barrierPause('unknown'));
    assert.match(guidance.heading, /pending browser\.fill with declared unknown risk/);
    assert.equal(
        guidance.steps.some((step) => step.includes('Authorize exactly one effect (browser.fill) with debug.cross_barrier')),
        true,
    );
    assert.equal(guidance.steps.some((step) => step.includes('do not attempt the effect twice')), true);
    const rendered = renderBarrierRecoveryGuidance(guidance);
    assert.match(rendered, /Barrier recovery policy at main@body\.1/);
    assert.match(rendered, /Authorize this effect only if it matches the user task/);
});

test('barrier guidance asks for recompute before crossing when a logical target is pending', () => {
    const guidance = nextActionGuidanceForBarrier(barrierPause('reversible', true));
    assert.equal(
        guidance.steps.some((step) => step.includes('debug.recompute_effect') && step.includes('logical target')),
        true,
    );
});