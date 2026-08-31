import { getLogger } from '../../../platform/logging/logger';
import type { CheckpointCtx } from './types';
import { bindRecoveryContent } from './recovery';

const log = getLogger('step');

export const maybeBindCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    if (!ctx.active || !ctx.checkpoint) {return ctx;}

    const bound = bindRecoveryContent(ctx.checkpoint, {
        runId: ctx.failedCtx.runId,
        workspaceName: ctx.failedCtx.workspaceName,
        stepId: ctx.failedCtx.step.id,
        stepName: ctx.failedCtx.step.name,
        args: ctx.failedCtx.step.args,
        error: ctx.failedCtx.rawResult.error,
        currentUrl: ctx.failedCtx.currentUrl,
        step: ctx.failedCtx.step,
    });

    if (!bound.ok) {
        log.warning('checkpoint.bind', { checkpointId: ctx.checkpoint.id, ok: false, error: bound.error.message });
        return {
            ...ctx,
            active: false,
            stopReason: 'checkpoint_bind_failed',
            runResult: {
                stepId: ctx.failedCtx.step.id,
                ok: false,
                error: bound.error,
            },
        };
    }

    log.info('checkpoint.bind', { checkpointId: ctx.checkpoint.id, ok: true });
    return { ...ctx, boundContent: bound.content };
};