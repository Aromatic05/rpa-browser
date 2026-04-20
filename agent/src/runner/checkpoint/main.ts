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
    meta: { attempted: false },
});

export const runCheckpoint = async (failedCtx: FailedCtx): Promise<CheckpointMainOutput> => {
    let ctx = createCheckpointCtx(failedCtx);
    log.info('checkpoint.enter', { stepId: failedCtx.step.id, stepName: failedCtx.step.name });
    ctx = await maybeEnterCheckpoint(ctx);
    ctx = await maybePickCheckpoint(ctx);
    ctx = await maybeBindCheckpoint(ctx);
    ctx = await maybeRunCheckpoint(ctx);
    ctx = await maybeRetryOriginalStep(ctx);
    ctx = foldCheckpointResult(ctx);
    return { finalResult: ctx.finalResult, nextStatus: ctx.nextStatus, meta: ctx.meta };
};
