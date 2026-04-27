import { getLogger } from '../../logging/logger';
import type { CheckpointCtx } from './types';

const log = getLogger('step');

export const maybeRetryOriginalStep = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    if (!ctx.active || !ctx.runResult?.ok) {return ctx;}
    if (ctx.checkpoint?.policy?.retryOriginal === false) {
        return {
            ...ctx,
            stopReason: 'checkpoint_completed',
        };
    }

    const retryResult = await ctx.failedCtx.executeStep(ctx.failedCtx.step);
    log.info('checkpoint.retry', {
        stepId: ctx.failedCtx.step.id,
        stepName: ctx.failedCtx.step.name,
        ok: retryResult.ok,
        code: retryResult.error?.code,
    });
    return {
        ...ctx,
        retryResult,
        stopReason: retryResult.ok ? 'checkpoint_completed' : 'checkpoint_retry_failed',
    };
};

export const foldCheckpointResult = (ctx: CheckpointCtx): CheckpointCtx => {
    if (ctx.nextStatus === 'suspended') {
        const finalResult =
            ctx.runResult ||
            ({
                stepId: ctx.failedCtx.step.id,
                ok: false,
                error: { code: 'ERR_CHECKPOINT_SUSPEND', message: 'checkpoint requested suspend' },
            } as const);
        log.info('checkpoint.fold', { stepId: ctx.failedCtx.step.id, nextStatus: 'suspended' });
        return {
            ...ctx,
            finalResult,
            meta: {
                ...(ctx.meta || {}),
                foldedBy: 'suspend',
                stopReason: ctx.stopReason,
            },
        };
    }

    if (!ctx.active) {
        log.info('checkpoint.fold', { stepId: ctx.failedCtx.step.id, fallbackToRaw: true, stopReason: ctx.stopReason });
        return {
            ...ctx,
            finalResult: ctx.failedCtx.rawResult,
            meta: {
                ...(ctx.meta || {}),
                foldedBy: 'raw_result',
                stopReason: ctx.stopReason,
            },
        };
    }

    if (ctx.runResult?.ok) {
        const finalResult = ctx.retryResult || ctx.runResult;
        log.info('checkpoint.fold', {
            stepId: ctx.failedCtx.step.id,
            foldedBy: ctx.retryResult ? 'retry_result' : 'checkpoint_result',
            ok: finalResult.ok,
            stopReason: ctx.stopReason,
        });
        return {
            ...ctx,
            finalResult,
            meta: {
                ...(ctx.meta || {}),
                foldedBy: ctx.retryResult ? 'retry_result' : 'checkpoint_result',
                stopReason: ctx.stopReason,
            },
        };
    }

    log.info('checkpoint.fold', { stepId: ctx.failedCtx.step.id, foldedBy: 'raw_result', stopReason: ctx.stopReason });
    return {
        ...ctx,
        finalResult: ctx.failedCtx.rawResult,
        meta: {
            ...(ctx.meta || {}),
            foldedBy: 'raw_result',
            stopReason: ctx.stopReason,
        },
    };
};
