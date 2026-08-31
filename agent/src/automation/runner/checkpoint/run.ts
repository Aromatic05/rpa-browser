import { getLogger } from '../../../platform/logging/logger';
import type { CheckpointCtx } from './types';
import { runCheckpointRecovery } from './recovery';

const log = getLogger('step');

export const maybeRunCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    if (!ctx.active || !ctx.checkpoint) {return ctx;}

    const outcome = await runCheckpointRecovery({
        checkpoint: ctx.checkpoint,
        runtime: ctx.failedCtx.checkpointRuntime!,
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
        boundContent: ctx.boundContent,
        workspaceName: ctx.failedCtx.workspaceName,
        deps: ctx.failedCtx.deps,
        attempt: typeof ctx.meta?.checkpointAttempt === 'number'
            ? ctx.meta.checkpointAttempt
            : ctx.failedCtx.checkpointAttempt,
        checkpointMaxAttempts: ctx.failedCtx.checkpointMaxAttempts,
    });

    if (!outcome.runResult) {
        return ctx;
    }
    const next: CheckpointCtx = {
        ...ctx,
        active: outcome.active,
        runResult: outcome.runResult,
        ...(outcome.stopReason ? {stopReason: outcome.stopReason} : {}),
        ...(outcome.nextStatus ? {nextStatus: outcome.nextStatus} : {}),
        ...(outcome.meta ? {meta: {...(ctx.meta || {}), ...outcome.meta}} : {}),
    };
    log.info('checkpoint.run', {
        checkpointId: ctx.checkpoint.id,
        ok: outcome.runResult.ok,
        stopReason: outcome.stopReason,
        nextStatus: outcome.nextStatus,
    });
    return next;
};