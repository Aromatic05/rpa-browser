import type {WorldRevision, WorldView} from '../../worldview/contracts';
import type {ExpectedWorldPrecondition} from '../../../automation/dsl/runtime';
import type {StepResult, StepUnion} from '../../../automation/runner/steps/types';
import type {DebugEffectRecord} from './contracts';

/**
 * Transaction-local world lineage.
 *
 * An effect may carry an expected-world precondition whose revision predates
 * the current world because this same transaction already journaled its own
 * writes. The world may only advance across those self-writes when the current
 * world is exactly the verified worldAfter chain of the retained journal, so
 * external mutation or navigation between effects still refuses the mutation.
 */

export type WorldLineageVerification =
    | Readonly<{ok: true; proven: WorldRevision}>
    | Readonly<{ok: false; reason: 'page_epoch_changed' | 'revision_moved_backward' | 'unproven'}>;

const sameRevision = (left: WorldRevision, right: WorldRevision): boolean =>
    left.pageEpoch === right.pageEpoch && left.captureRevision === right.captureRevision;

export const proveTransactionLocalWorldLineage = (
    expected: WorldRevision,
    actual: WorldView,
    records: readonly DebugEffectRecord[],
): WorldLineageVerification => {
    const actualRevision = actual.revision;
    if (actualRevision.pageEpoch !== expected.pageEpoch) {
        return {ok: false, reason: 'page_epoch_changed'};
    }
    if (actualRevision.captureRevision < expected.captureRevision) {
        return {ok: false, reason: 'revision_moved_backward'};
    }
    if (actualRevision.captureRevision === expected.captureRevision) {
        return {ok: true, proven: expected};
    }

    const compensated = new Set<number>();
    for (const record of records) {
        if (record.compensates) {compensated.add(record.compensates.effectSequence);}
    }

    let current: WorldRevision = expected;
    for (const record of records) {
        if (record.compensates || compensated.has(record.sequence)) {continue;}
        if (record.outcome.status !== 'succeeded') {continue;}
        if (record.worldAfter.revision.pageEpoch !== current.pageEpoch) {continue;}
        if (!sameRevision(record.worldBefore.revision, current)) {continue;}
        current = record.worldAfter.revision;
    }

    return sameRevision(current, actualRevision)
        ? {ok: true, proven: current}
        : {ok: false, reason: 'unproven'};
};

export const worldConflictStepResult = (
    step: StepUnion,
    precondition: ExpectedWorldPrecondition,
    actual: WorldRevision,
): StepResult => ({
    stepId: step.id,
    ok: false as const,
    error: {
        code: 'ERR_AGENT_WORLD_CONFLICT' as const,
        message: 'workspace world moved past the expected observation revision; refusing to mutate',
        details: {expected: {...precondition.revision}, actual: {...actual}},
    },
});