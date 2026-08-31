import type {CheckpointRuntimeSnapshot} from '../../../automation/runner/checkpoint/runtime_snapshot';
import type {
    DslDebugAdvanceResult,
    DslDebugExecutionSession,
    PausedDslDebugExecution,
} from '../execution/contracts';
import type {RetainedRecoverySummary} from './types';

export type RetainedRecoveryOutcome =
    | Readonly<{status: 'none'}>
    | Readonly<{status: 'recovered'; pause: PausedDslDebugExecution; summary: RetainedRecoverySummary}>
    | Readonly<{
        status: 'recovered_with_retry';
        pause: PausedDslDebugExecution;
        advance: DslDebugAdvanceResult;
        summary: RetainedRecoverySummary;
    }>
    | Readonly<{status: 'recovery_failed'; pause: PausedDslDebugExecution; summary: RetainedRecoverySummary}>
    | Readonly<{
        status: 'needs_approval';
        pause: Extract<PausedDslDebugExecution, {reason: 'barrier'}>;
        summary: RetainedRecoverySummary;
    }>;

export type RetainedRecoveryInput = {
    session: DslDebugExecutionSession;
    pause: PausedDslDebugExecution;
    runtime: CheckpointRuntimeSnapshot;
    checkpointMaxAttempts?: number;
};

const noSummary = (
    checkpointId?: string,
    checkpointName?: string,
): RetainedRecoverySummary | null => {
    if (!checkpointId) {return null;}
    return Object.freeze({
        checkpointId,
        ...(checkpointName ? {checkpointName} : {}),
        applied: false,
    });
};

const recoveredSummary = (
    checkpointId: string,
    checkpointName: string | undefined,
    retried: boolean,
): RetainedRecoverySummary => Object.freeze({
    checkpointId,
    ...(checkpointName ? {checkpointName} : {}),
    applied: true,
    retried,
});

/**
 * Deterministically apply a human-taught Workflow Recovery checkpoint to a
 * retained Agent failure pause, BEFORE the model invents a repair. The recovery
 * runs inside the same retained transaction (same journaled StepExecutionPort);
 * a second Program/runSteps transaction is never started. maxAttempts is durable
 * across recovery re-entries: a failed retry re-enters selection at the same
 * failure point with the incremented per-checkpoint attempt count, mirroring the
 * ordinary runner. If the recovery cannot be proven safe/applicable the original
 * failure pause is returned unchanged and the existing debug recovery options
 * stay intact.
 */
export const tryRetainedRecovery = async (
    input: RetainedRecoveryInput,
): Promise<RetainedRecoveryOutcome> => {
    let pause = input.pause;
    let applied: RetainedRecoverySummary | null = null;

    while (pause.reason === 'failure') {
        const result = await input.session.runRecovery(pause.continuationId, {
            runtime: input.runtime,
            ...(input.checkpointMaxAttempts === undefined
                ? {}
                : {checkpointMaxAttempts: input.checkpointMaxAttempts}),
        });

        if (result.status === 'no_recovery') {
            return applied ? {status: 'recovered', pause, summary: applied} : {status: 'none'};
        }
        if (result.status === 'failed') {
            const summary = noSummary(result.checkpointId);
            return summary
                ? {status: 'recovery_failed', pause, summary}
                : applied
                    ? {status: 'recovered', pause, summary: applied}
                    : {status: 'none'};
        }
        if (result.status === 'needs_approval') {
            return {
                status: 'needs_approval',
                pause: result.barrier,
                summary: Object.freeze({
                    checkpointId: result.checkpointId,
                    applied: false,
                    blockedByApproval: true,
                }),
            };
        }

        const summary = recoveredSummary(result.checkpointId, result.checkpointName, result.retried);
        if (result.advance) {
            if (result.advance.status === 'paused' && result.advance.pause.reason === 'failure') {
                applied = summary;
                pause = result.advance.pause;
                continue;
            }
            return {status: 'recovered_with_retry', pause, advance: result.advance, summary};
        }
        return {status: 'recovered', pause, summary};
    }

    return applied ? {status: 'recovered', pause, summary: applied} : {status: 'none'};
};