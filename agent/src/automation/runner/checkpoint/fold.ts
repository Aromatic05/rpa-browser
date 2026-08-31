import { getLogger } from '../../../platform/logging/logger';
import type { CheckpointCtx } from './types';
import { foldRecoveryResult, retryOriginalStep } from './recovery';

const log = getLogger('step');

export const maybeRetryOriginalStep = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    if (!ctx.active || !ctx.runResult?.ok) {return ctx;}

    const retry = await retryOriginalStep({
        checkpoint: ctx.checkpoint!,
        failure: {
            runId: ctx.failedCtx.runId,
            workspaceName: ctx.failedCtx.workspaceName,
            stepId: ctx.failedCtx.step.id,
            stepName: ctx.failedCtx.step.name,
            args: ctx.failedCtx.step.args,
            error: ctx.failedCtx.rawResult.error,
            currentUrl: ctx.failedCtx.currentUrl,
            step: ctx.failedCtx.step,
        },
        executeStep: (step, stepResolves) => ctx.failedCtx.executeStep(step, stepResolves),
    });

    log.info('checkpoint.retry', {
        stepId: ctx.failedCtx.step.id,
        stepName: ctx.failedCtx.step.name,
        ok: retry.retryResult?.ok,
        code: retry.retryResult?.error?.code,
    });
    return {
        ...ctx,
        ...(retry.retryResult ? {retryResult: retry.retryResult} : {}),
        stopReason: retry.stopReason,
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

    const folded = foldRecoveryResult({
        active: ctx.active,
        checkpoint: ctx.checkpoint,
        runResult: ctx.runResult,
        retryResult: ctx.retryResult,
        rawResult: ctx.failedCtx.rawResult,
        meta: ctx.meta,
        nextStatus: ctx.nextStatus,
    });

    log.info('checkpoint.fold', {
        stepId: ctx.failedCtx.step.id,
        foldedBy: folded.meta.foldedBy,
        ok: folded.finalResult.ok,
        stopReason: folded.meta.stopReason,
    });
    return {
        ...ctx,
        finalResult: folded.finalResult,
        meta: folded.meta,
    };
};