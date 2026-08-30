import { getLogger } from '../../../platform/logging/logger';
import type { FailedCtx } from '../failed_ctx';
import { failureContextOf, worldProbeOf } from './match';
import { enterRecovery, executeRecovery, selectRecovery } from './recovery';
import type { CheckpointCtx, CheckpointMainOutput } from './types';

const log = getLogger('step');

export const createCheckpointCtx = (failedCtx: FailedCtx): CheckpointCtx => ({
    failedCtx,
    active: true,
    finalResult: failedCtx.rawResult,
    meta: { attempted: true },
});

export const runCheckpoint = async (failedCtx: FailedCtx): Promise<CheckpointMainOutput> => {
    const failure = failureContextOf(failedCtx);

    if (!enterRecovery({
        checkpointEnabled: failedCtx.checkpointEnabled,
        inCheckpointFlow: failedCtx.inCheckpointFlow,
        errorCode: failure.error?.code,
    }).entered) {
        log.info('checkpoint.main', {
            stepId: failedCtx.step.id,
            stepName: failedCtx.step.name,
            finalOk: false,
            stopReason: 'checkpoint_not_entered',
        });
        return {
            finalResult: failedCtx.rawResult,
            meta: { attempted: true, checkpointId: undefined, stopReason: 'checkpoint_not_entered' },
        };
    }

    const selection = await selectRecovery({
        checkpoints: failedCtx.checkpoints || [],
        failure,
        checkpointEnabled: failedCtx.checkpointEnabled,
        checkpointAttempt: failedCtx.checkpointAttempt,
        checkpointAttempts: failedCtx.checkpointAttempts,
        checkpointMaxAttempts: failedCtx.checkpointMaxAttempts,
        world: worldProbeOf(failedCtx),
    });

    if (selection.status === 'no_match') {
        log.info('checkpoint.main', {
            stepId: failedCtx.step.id,
            stepName: failedCtx.step.name,
            finalOk: false,
            stopReason: 'checkpoint_not_found',
        });
        return {
            finalResult: failedCtx.rawResult,
            meta: { attempted: true, checkpointId: undefined, stopReason: 'checkpoint_not_found' },
        };
    }

    const outcome = await executeRecovery({
        checkpoint: selection.checkpoint,
        runtime: failedCtx.checkpointRuntime!,
        failure,
        executeStep: (step, stepResolves) => failedCtx.executeStep(step, stepResolves),
        rawResult: failedCtx.rawResult,
        workspaceName: failedCtx.workspaceName,
        deps: failedCtx.deps,
        attempt: selection.attempt,
        checkpointMaxAttempts: failedCtx.checkpointMaxAttempts,
    });

    log.info('checkpoint.main', {
        stepId: failedCtx.step.id,
        stepName: failedCtx.step.name,
        finalOk: outcome.finalResult.ok,
        nextStatus: outcome.nextStatus,
        stopReason: outcome.meta.stopReason,
    });

    return {
        finalResult: outcome.finalResult,
        ...(outcome.nextStatus ? { nextStatus: outcome.nextStatus } : {}),
        meta: {
            attempted: true,
            ...outcome.meta,
        },
    };
};