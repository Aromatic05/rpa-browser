import { getLogger } from '../../logging/logger';
import type { FailedCtx } from '../failed_ctx';
import { maybeBindCheckpoint } from './bind';
import { foldCheckpointResult, maybeRetryOriginalStep } from './fold';
import { maybeEnterCheckpoint, maybePickCheckpoint } from './match';
import { maybeRunCheckpoint } from './run';
import type { CheckpointCtx, CheckpointMainOutput } from './types';

const log = getLogger('step');

export const createCheckpointCtx = (failedCtx: FailedCtx): CheckpointCtx => ({
    failedCtx,
    active: true,
    finalResult: failedCtx.rawResult,
    meta: { attempted: true },
});

export const runCheckpoint = async (failedCtx: FailedCtx): Promise<CheckpointMainOutput> => {
    let ctx = createCheckpointCtx(failedCtx);
    ctx = await maybeEnterCheckpoint(ctx);
    ctx = await maybePickCheckpoint(ctx);
    ctx = await maybeBindCheckpoint(ctx);
    ctx = await maybeRunCheckpoint(ctx);
    ctx = await maybeRetryOriginalStep(ctx);
    ctx = foldCheckpointResult(ctx);

    log.info('checkpoint.main', {
        stepId: failedCtx.step.id,
        stepName: failedCtx.step.name,
        finalOk: ctx.finalResult.ok,
        nextStatus: ctx.nextStatus,
        stopReason: ctx.stopReason,
    });

    return {
        finalResult: ctx.finalResult,
        nextStatus: ctx.nextStatus,
        meta: {
            ...(ctx.meta || {}),
            checkpointId: ctx.checkpoint?.id,
            stopReason: ctx.stopReason,
        },
    };
};
