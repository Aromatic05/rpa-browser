import test from 'node:test';
import assert from 'node:assert/strict';
import {describeWorldView} from '../../../../../src/agent/worldview/descriptor';
import type {WorldView, WorldViewDescriptor} from '../../../../../src/agent/worldview/contracts';
import type {PageSnapshotSessionEntry} from '../../../../../src/automation/snapshot';
import type {DebugSavepoint} from '../../../../../src/agent/debug/transaction/contracts';
import type {DslFailureDescriptor} from '../../../../../src/automation/dsl/debug/contracts';
import type {PausedDslDebugExecution} from '../../../../../src/agent/debug/execution/contracts';
import type {RecoveryOption} from '../../../../../src/agent/debug/recovery/contracts';
import {createRecoveryBudgetStore, DEFAULT_RECOVERY_BUDGET_LIMITS} from '../../../../../src/agent/debug/recovery/budget';
import {recoveryBudgetKey} from '../../../../../src/agent/debug/recovery/key';
import {assessFailureRecovery} from '../../../../../src/agent/debug/recovery/options';

const worldView = (pageEpoch: string): WorldView => Object.freeze({
    workspaceName: 'ws-recovery-budget',
    tabName: 'main',
    pageUrl: '/orders',
    revision: Object.freeze({pageEpoch, captureRevision: 1}),
    entry: Object.freeze({}) as unknown as PageSnapshotSessionEntry,
});

const world = (pageEpoch: string): WorldViewDescriptor => describeWorldView(worldView(pageEpoch));

const readFailure = (path: string): DslFailureDescriptor => Object.freeze({
    kind: 'step',
    stepId: 'step-read',
    stepName: 'browser.query',
    classification: 'read',
    args: {expr: 'table.rowCount'},
    code: 'ERR_NOT_FOUND',
    message: 'no match',
});

const failurePauseAt = (
    failure: DslFailureDescriptor,
    path: string,
    options: {anchor?: DebugSavepoint; pageEpoch?: string} = {},
): Extract<PausedDslDebugExecution, {reason: 'failure'}> => Object.freeze({
    continuationId: `cont-${path}`,
    reason: 'failure',
    location: Object.freeze({
        programId: 'main',
        path,
        kind: 'output',
        loops: [],
        callStack: [],
    }),
    scope: Object.freeze({input: Object.freeze({}), vars: Object.freeze({}), output: Object.freeze({})}),
    world: world(options.pageEpoch ?? 'epoch-1'),
    failure,
    ...(options.anchor ? {rollbackAnchor: options.anchor} : {}),
});

const anchor = (id: string, effectSequence: number): DebugSavepoint => Object.freeze({
    id,
    effectSequence,
    world: world('epoch-1'),
});

const optionOf = <Kind extends RecoveryOption['kind']>(
    options: readonly RecoveryOption[],
    kind: Kind,
): Extract<RecoveryOption, {kind: Kind}> | undefined =>
    options.find((candidate): candidate is Extract<RecoveryOption, {kind: Kind}> => candidate.kind === kind);

test('budget store starts with explicit per-action limits and records deterministically', () => {
    const store = createRecoveryBudgetStore();
    assert.deepEqual(DEFAULT_RECOVERY_BUDGET_LIMITS, {retry: 2, repair: 1, rollback: 1});
    const view = store.view('k1');
    assert.deepEqual(view, {key: 'k1', retry: 0, repair: 0, rollback: 0});
    assert.equal(store.remaining('k1', 'retry'), 2);
    assert.equal(store.record('k1', 'retry').retry, 1);
    assert.equal(store.remaining('k1', 'retry'), 1);
    assert.equal(store.view('k1').retry, 1);
});

test('retry budget exhaustion on a read failure yields the deterministic terminal reason', () => {
    const pause = failurePauseAt(readFailure('body.0'), 'body.0');
    const key = recoveryBudgetKey(pause, 'retry');
    assert.equal(typeof key, 'string');
    const store = createRecoveryBudgetStore();

    const first = assessFailureRecovery(pause, {budget: store, budgetKey: key});
    assert.equal(optionOf(first.options, 'retry')?.eligible, true);
    assert.equal(first.terminalReason, undefined);

    store.record(key!, 'retry');
    store.record(key!, 'retry');

    const exhausted = assessFailureRecovery(pause, {budget: store, budgetKey: key});
    assert.equal(optionOf(exhausted.options, 'retry')?.eligible, false);
    if (optionOf(exhausted.options, 'retry')) {
        assert.equal(optionOf(exhausted.options, 'retry')?.block?.code, 'budget_exhausted');
    }
    assert.equal(exhausted.terminalReason?.code, 'TERMINAL_RECOVERY_BUDGET_EXHAUSTED');
});

test('budget is scoped per failure point and per World epoch so independent runs never pollute each other', () => {
    const store = createRecoveryBudgetStore();
    const pauseA = failurePauseAt(readFailure('body.0'), 'body.0');
    const pauseB = failurePauseAt(readFailure('body.1'), 'body.1');
    const pauseC = failurePauseAt(readFailure('body.0'), 'body.0', {pageEpoch: 'epoch-2'});

    store.record(recoveryBudgetKey(pauseA, 'retry')!, 'retry');
    store.record(recoveryBudgetKey(pauseA, 'retry')!, 'retry');

    const exhausted = assessFailureRecovery(pauseA, {budget: store, budgetKey: recoveryBudgetKey(pauseA, 'retry')});
    assert.equal(optionOf(exhausted.options, 'retry')?.eligible, false);

    const fresh = assessFailureRecovery(pauseB, {budget: store, budgetKey: recoveryBudgetKey(pauseB, 'retry')});
    assert.equal(optionOf(fresh.options, 'retry')?.eligible, true);

    const freshEpoch = assessFailureRecovery(pauseC, {budget: store, budgetKey: recoveryBudgetKey(pauseC, 'retry')});
    assert.equal(optionOf(freshEpoch.options, 'retry')?.eligible, true);
});

test('repair budget blocks an infinite patch+rewind loop at an invariant failure point', () => {
    const invariant: DslFailureDescriptor = Object.freeze({
        kind: 'invariant',
        code: 'ERR_DSL_ENSURE_FAILED',
        message: 'ensure failed',
        details: Object.freeze({expected: true, actual: false, condition: {}}),
    });
    const pause = failurePauseAt(invariant, 'body.0');
    const key = recoveryBudgetKey(pause, 'repair')!;
    const store = createRecoveryBudgetStore();

    assert.equal(assessFailureRecovery(pause, {budget: store, budgetKey: key}).terminalReason, undefined);

    store.record(key, 'repair');

    const exhausted = assessFailureRecovery(pause, {budget: store, budgetKey: key});
    assert.equal(optionOf(exhausted.options, 'repair')?.eligible, false);
    if (optionOf(exhausted.options, 'repair')) {
        assert.equal(optionOf(exhausted.options, 'repair')?.block?.code, 'budget_exhausted');
    }
    assert.equal(exhausted.terminalReason?.code, 'TERMINAL_RECOVERY_BUDGET_EXHAUSTED');
});

test('rollback budget is keyed to the anchor and blocks repeated undo plus verified rewind', () => {
    const clickFailure = (): DslFailureDescriptor => Object.freeze({
        kind: 'step',
        stepId: 'step-click',
        stepName: 'browser.click',
        classification: 'effect',
        args: {nodeId: 'submit'},
        code: 'ERR_CLICK',
        message: 'click failed',
    });
    const a = anchor('anchor-a', 0);
    const pause = failurePauseAt(clickFailure(), 'body.0', {anchor: a});
    const key = recoveryBudgetKey(pause, 'rollback')!;
    assert.equal(key, 'anchor:anchor-a');
    const store = createRecoveryBudgetStore();

    assert.equal(assessFailureRecovery(pause, {budget: store, budgetKey: key}).terminalReason, undefined);

    store.record(key, 'rollback');

    const exhausted = assessFailureRecovery(pause, {budget: store, budgetKey: key});
    assert.equal(optionOf(exhausted.options, 'rollback')?.eligible, false);
    assert.equal(optionOf(exhausted.options, 'rollback')?.block?.code, 'budget_exhausted');
    assert.equal(optionOf(exhausted.options, 'rewind')?.eligible, false);
    assert.equal(exhausted.terminalReason?.code, 'TERMINAL_RECOVERY_BUDGET_EXHAUSTED');
});