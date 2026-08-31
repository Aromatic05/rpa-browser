import test from 'node:test';
import assert from 'node:assert/strict';
import {describeWorldView} from '../../../../../src/agent/worldview/descriptor';
import type {WorldView, WorldViewDescriptor} from '../../../../../src/agent/worldview/contracts';
import type {PageSnapshotSessionEntry} from '../../../../../src/automation/snapshot';
import type {WorldViewDiffResult} from '../../../../../src/agent/worldview/diff';
import type {SnapshotProjectionDiffResult} from '../../../../../src/automation/snapshot/projection';
import {createDebugTransaction} from '../../../../../src/agent/debug/transaction/state';
import type {DebugSavepoint} from '../../../../../src/agent/debug/transaction/contracts';
import type {DebugRollbackResult} from '../../../../../src/agent/debug/transaction/contracts';
import type {DebugEffectRecord} from '../../../../../src/agent/debug/effects/contracts';
import type {
    DslEffectDescriptor,
    DslFailureDescriptor,
} from '../../../../../src/automation/dsl/debug/contracts';
import type {PausedDslDebugExecution} from '../../../../../src/agent/debug/execution/contracts';
import type {RecoveryOption} from '../../../../../src/agent/debug/recovery/contracts';
import {
    assessFailureRecovery,
    recommendRecoveryAfterRollback,
} from '../../../../../src/agent/debug/recovery/options';

const view: WorldView = Object.freeze({
    workspaceName: 'ws-recovery-options',
    tabName: 'main',
    pageUrl: '/orders',
    revision: Object.freeze({pageEpoch: 'epoch-1', captureRevision: 1}),
    entry: Object.freeze({}) as unknown as PageSnapshotSessionEntry,
});

const world: WorldViewDescriptor = describeWorldView(view);

const emptyResidualDiff = (): WorldViewDiffResult => Object.freeze({
    ok: true,
    worldBefore: world,
    worldAfter: world,
    diff: Object.freeze({mode: 'diff'} as SnapshotProjectionDiffResult),
});

const anchor = (id: string, effectSequence: number): DebugSavepoint =>
    createDebugTransaction(view).internalSavepoint(view, effectSequence);

const readFailure = (code = 'ERR_NOT_FOUND'): DslFailureDescriptor => Object.freeze({
    kind: 'step',
    stepId: 'step-read',
    stepName: 'browser.query',
    classification: 'read',
    args: {expr: 'table.rowCount'},
    code,
    message: 'no match',
});

const clickFailure = (code = 'ERR_CLICK'): DslFailureDescriptor => Object.freeze({
    kind: 'step',
    stepId: 'step-click',
    stepName: 'browser.click',
    classification: 'effect',
    args: {nodeId: 'submit'},
    code,
    message: 'click failed',
});

const invariantFailure = (): DslFailureDescriptor => Object.freeze({
    kind: 'invariant',
    code: 'ERR_DSL_ENSURE_FAILED',
    message: 'ensure failed',
    details: Object.freeze({
        expected: true,
        actual: false,
        condition: Object.freeze({op: 'eq', args: []}),
    }),
});

const failurePause = (
    failure: DslFailureDescriptor,
    options: {anchor?: DebugSavepoint} = {},
): Extract<PausedDslDebugExecution, {reason: 'failure'}> => Object.freeze({
    continuationId: 'cont-failure-1',
    reason: 'failure',
    location: Object.freeze({
        programId: 'main',
        path: 'body.0',
        kind: 'output',
        loops: [],
        callStack: [],
    }),
    scope: Object.freeze({input: Object.freeze({}), vars: Object.freeze({}), output: Object.freeze({})}),
    world,
    failure,
    ...(options.anchor ? {rollbackAnchor: options.anchor} : {}),
});

const effectRecord = (
    sequence: number,
    reversibility: 'unknown' | 'reversible' | 'compensatable' | 'irreversible',
    options: Partial<DebugEffectRecord> = {},
): DebugEffectRecord => {
    const effect: DslEffectDescriptor = Object.freeze({
        stepId: `step-${sequence}`,
        stepName: 'browser.fill',
        args: {nodeId: 'buyer-input'},
        semantics: Object.freeze({reversibility}),
    });
    return Object.freeze({
        sequence,
        location: Object.freeze({
            programId: 'main',
            path: `body.${sequence - 1}`,
            kind: 'output',
            loops: [],
            callStack: [],
        }),
        effect,
        outcome: Object.freeze({status: 'succeeded'}),
        worldBefore: world,
        worldAfter: world,
        ...options,
    });
};

const compensatedRecord = (sequence: number, compensates: number): DebugEffectRecord =>
    effectRecord(sequence, 'unknown', {compensates: {effectSequence: compensates}});

const optionOf = <Kind extends RecoveryOption['kind']>(
    options: readonly RecoveryOption[],
    kind: Kind,
): Extract<RecoveryOption, {kind: Kind}> | undefined =>
    options.find((candidate): candidate is Extract<RecoveryOption, {kind: Kind}> => candidate.kind === kind);

test('read failure with no anchor: retry eligible, no undo available, no terminal reason', () => {
    const assessment = assessFailureRecovery(failurePause(readFailure()));
    assert.equal(assessment.failureClass, 'read');
    assert.equal(assessment.effectRisk, 'none');
    assert.equal(assessment.terminalReason, undefined);
    assert.equal(optionOf(assessment.options, 'retry')?.eligible, true);
    assert.equal(optionOf(assessment.options, 'repair')?.eligible, true);
    assert.equal(optionOf(assessment.options, 'rollback')?.eligible, false);
    assert.equal(optionOf(assessment.options, 'rollback')?.block?.code, 'no_recovery_point');
    assert.equal(optionOf(assessment.options, 'rewind')?.eligible, false);
    assert.equal(
        optionOf(assessment.options, 'terminate')?.note,
        'terminate the retained failure only when recovery is unwarranted',
    );
});

test('read failure after executed effects: retry stays safe, verified rewind allowed for reversible effects', () => {
    const a = anchor('a1', 1);
    const journal = [
        effectRecord(1, 'reversible'),
        effectRecord(2, 'reversible'),
    ];
    const assessment = assessFailureRecovery(failurePause(readFailure(), {anchor: a}), {effects: journal});
    assert.equal(assessment.effectRisk, 'reversible');
    assert.equal(assessment.executedEffects.length, 1);
    assert.equal(optionOf(assessment.options, 'retry')?.eligible, true);
    assert.equal(optionOf(assessment.options, 'rollback')?.eligible, true);
    assert.equal(optionOf(assessment.options, 'rollback')?.strategy, 'physical');
    assert.equal(optionOf(assessment.options, 'rewind')?.eligible, true);
    assert.equal(assessment.terminalReason, undefined);
});

test('invariant failure: blind retry blocked, repair eligible, no terminal reason yet', () => {
    const assessment = assessFailureRecovery(failurePause(invariantFailure()));
    assert.equal(assessment.failureClass, 'invariant');
    assert.equal(optionOf(assessment.options, 'retry')?.eligible, false);
    assert.equal(optionOf(assessment.options, 'retry')?.block?.code, 'effects_not_verified');
    assert.equal(optionOf(assessment.options, 'repair')?.eligible, true);
    assert.equal(assessment.terminalReason, undefined);
});

test('world-effect failure with irreversible effect: every recovery blocked with the irreversible terminal reason', () => {
    const a = anchor('a1', 1);
    const journal = [effectRecord(2, 'irreversible')];
    const assessment = assessFailureRecovery(failurePause(clickFailure(), {anchor: a}), {effects: journal});
    assert.equal(assessment.failureClass, 'world_effect');
    assert.equal(assessment.effectRisk, 'irreversible');
    assert.equal(optionOf(assessment.options, 'retry')?.eligible, false);
    assert.equal(optionOf(assessment.options, 'retry')?.block?.code, 'effects_not_verified');
    assert.equal(optionOf(assessment.options, 'rollback')?.eligible, false);
    assert.equal(optionOf(assessment.options, 'rollback')?.block?.code, 'irreversible_effects');
    assert.equal(optionOf(assessment.options, 'rewind')?.eligible, false);
    assert.equal(optionOf(assessment.options, 'rewind')?.block?.code, 'irreversible_effects');
    assert.equal(assessment.terminalReason?.code, 'TERMINAL_IRREVERSIBLE_EFFECTS');
});

test('unknown effect: physical rollback eligible but rewind stays blocked from Program replay', () => {
    const a = anchor('a1', 1);
    const journal = [effectRecord(2, 'unknown')];
    const assessment = assessFailureRecovery(failurePause(clickFailure(), {anchor: a}), {effects: journal});
    assert.equal(assessment.effectRisk, 'unknown');
    assert.equal(optionOf(assessment.options, 'rollback')?.eligible, true);
    assert.equal(optionOf(assessment.options, 'rewind')?.eligible, false);
    assert.equal(optionOf(assessment.options, 'rewind')?.block?.code, 'effects_not_verified');
    assert.equal(assessment.terminalReason?.code, 'TERMINAL_VERIFIED_RESTORE_IMPOSSIBLE');
});

test('compensatable effect: rewind remains blocked even though rollback can compensate', () => {
    const a = anchor('a1', 1);
    const journal = [effectRecord(2, 'compensatable')];
    const assessment = assessFailureRecovery(failurePause(clickFailure(), {anchor: a}), {effects: journal});
    assert.equal(optionOf(assessment.options, 'rollback')?.eligible, true);
    assert.equal(optionOf(assessment.options, 'rewind')?.eligible, false);
    assert.equal(optionOf(assessment.options, 'rewind')?.block?.code, 'effects_not_verified');
    assert.equal(assessment.terminalReason?.code, 'TERMINAL_VERIFIED_RESTORE_IMPOSSIBLE');
});

test('reversible effect: rollback and verified rewind both eligible with no terminal reason', () => {
    const a = anchor('a1', 1);
    const journal = [effectRecord(2, 'reversible')];
    const assessment = assessFailureRecovery(failurePause(clickFailure(), {anchor: a}), {effects: journal});
    assert.equal(assessment.effectRisk, 'reversible');
    assert.equal(optionOf(assessment.options, 'rollback')?.eligible, true);
    assert.equal(optionOf(assessment.options, 'rewind')?.eligible, true);
    assert.equal(assessment.terminalReason, undefined);
});

test('world-effect failure before any anchor: no undo point, deterministic no-recovery-point reason', () => {
    const assessment = assessFailureRecovery(failurePause(clickFailure()));
    assert.equal(optionOf(assessment.options, 'rollback')?.eligible, false);
    assert.equal(optionOf(assessment.options, 'rollback')?.block?.code, 'no_recovery_point');
    assert.equal(assessment.terminalReason?.code, 'TERMINAL_NO_RECOVERY_POINT');
});

test('already-compensated journal: another rollback is a noop and never repeats compensation', () => {
    const a = anchor('a1', 0);
    const journal = [
        effectRecord(1, 'reversible'),
        compensatedRecord(2, 1),
    ];
    const assessment = assessFailureRecovery(failurePause(clickFailure(), {anchor: a}), {effects: journal});
    assert.equal(assessment.effectRisk, 'reversible');
    assert.equal(assessment.executedEffects.length, 1);
    assert.equal(optionOf(assessment.options, 'rollback')?.eligible, true);
    assert.equal(
        optionOf(assessment.options, 'rollback')?.note,
        'executed effects are already compensated; rollback would resolve as a noop and will not repeat compensation',
    );
    assert.equal(optionOf(assessment.options, 'rewind')?.eligible, true);
});

test('recovered rollback that is restored/noop allows proceeding', () => {
    const a = anchor('a1', 1);
    const result: DebugRollbackResult = Object.freeze({
        status: 'restored',
        mode: 'noop',
        savepoint: a,
        world,
    });
    const recovery = recommendRecoveryAfterRollback(result);
    assert.equal(recovery.verdict, 'proceed');
    assert.equal('terminalReason' in recovery, false);
});

test('verified physical restore allows rewinding to a statement savepoint', () => {
    const a = anchor('a1', 1);
    const result: DebugRollbackResult = Object.freeze({
        status: 'restored',
        mode: 'physical_verified',
        semanticRisk: 'reversible',
        savepoint: a,
        compensations: [effectRecord(2, 'reversible')],
        world,
        residualDiff: emptyResidualDiff(),
    });
    const recovery = recommendRecoveryAfterRollback(result);
    assert.equal(recovery.verdict, 'rewind_safe');
});

test('compensated rollback blocks rewind with a deterministic verified-restore-impossible reason', () => {
    const a = anchor('a1', 1);
    const result: DebugRollbackResult = Object.freeze({
        status: 'compensated',
        mode: 'physical',
        semanticRisk: 'compensatable',
        savepoint: a,
        compensations: [effectRecord(2, 'compensatable')],
        world,
        residualDiff: emptyResidualDiff(),
    });
    const recovery = recommendRecoveryAfterRollback(result);
    assert.equal(recovery.verdict, 'blocked');
    if (recovery.verdict === 'blocked') {
        assert.equal(recovery.terminalReason?.code, 'TERMINAL_VERIFIED_RESTORE_IMPOSSIBLE');
    }
});

test('failed compensation yields the deterministic compensation-failed terminal reason', () => {
    const a = anchor('a1', 1);
    const result: DebugRollbackResult = Object.freeze({
        status: 'partial',
        mode: 'physical',
        semanticRisk: 'unknown',
        savepoint: a,
        compensations: [],
        failure: Object.freeze({
            code: 'ERR_COMPENSATION_EXECUTION',
            message: 'browser.fill compensation rejected',
        }),
        world,
        residualDiff: emptyResidualDiff(),
    });
    const recovery = recommendRecoveryAfterRollback(result);
    assert.equal(recovery.verdict, 'blocked');
    if (recovery.verdict === 'blocked') {
        assert.equal(recovery.terminalReason?.code, 'TERMINAL_COMPENSATION_FAILED');
    }
});

test('world drift after rollback requires refresh before any further recovery', () => {
    const a = anchor('a1', 1);
    const result: DebugRollbackResult = Object.freeze({
        status: 'blocked',
        reason: 'world_drift',
        savepoint: a,
        world,
        effects: [],
        diff: emptyResidualDiff(),
    });
    const recovery = recommendRecoveryAfterRollback(result);
    assert.equal(recovery.verdict, 'refresh_required');
});

test('missing rollback anchor after rollback reports no recovery point', () => {
    const result: DebugRollbackResult = Object.freeze({
        status: 'not_found',
        error: Object.freeze({code: 'ERR_NOT_FOUND', message: 'transaction savepoint not found: missing'}),
    });
    const recovery = recommendRecoveryAfterRollback(result);
    assert.equal(recovery.verdict, 'blocked');
    if (recovery.verdict === 'blocked') {
        assert.equal(recovery.block.code, 'no_recovery_point');
    }
});