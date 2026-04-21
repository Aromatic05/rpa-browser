import { getLogger } from '../../logging/logger';
import type { Checkpoint, CheckpointCtx } from './types';
import { runCheckpointProcedure } from './runtime';

const log = getLogger('step');

const ASSERT_STEP_NAME = 'browser.assert';

const toStepFailureReason = (stepName: string) =>
    stepName === 'browser.assert' ? 'checkpoint_assert_failed' : 'checkpoint_step_failed';

export const maybeRunCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    if (!ctx.active || !ctx.checkpoint) return ctx;

    if (ctx.checkpoint.prepare || ctx.checkpoint.output || hasActionContent(ctx.checkpoint.content)) {
        const output = await runCheckpointProcedure({
            checkpoint: ctx.checkpoint,
            stepIdPrefix: `recovery:${ctx.failedCtx.step.id}`,
            executeStep: ctx.failedCtx.executeStep,
        });
        if (!output.ok) {
            return {
                ...ctx,
                active: false,
                stopReason: 'checkpoint_step_failed',
                runResult: {
                    stepId: ctx.failedCtx.step.id,
                    ok: false,
                    error: output.error,
                },
            };
        }
        return {
            ...ctx,
            runResult: {
                stepId: ctx.failedCtx.step.id,
                ok: true,
                data: {
                    checkpointId: ctx.checkpoint.id,
                    checkpointName: ctx.checkpoint.name,
                    output: output.output || {},
                },
            },
        };
    }

    if (!ctx.boundContent) return ctx;

    for (const item of ctx.boundContent) {
        const result = await ctx.failedCtx.executeStep(item);
        if (!result.ok) {
            const stopReason = toStepFailureReason(item.name);
            const nextStatus = result.error?.code === 'ERR_CHECKPOINT_SUSPEND' ? 'suspended' : undefined;
            log.warning('checkpoint.run', {
                checkpointId: ctx.checkpoint.id,
                checkpointStepId: item.id,
                checkpointStepName: item.name,
                ok: false,
                code: result.error?.code,
                stopReason,
                nextStatus,
            });
            return {
                ...ctx,
                active: false,
                stopReason,
                runResult: {
                    ...result,
                    error: {
                        ...(result.error || { code: 'ERR_CHECKPOINT_STEP_FAILED', message: 'checkpoint step failed' }),
                        code:
                            (item.name as string) === ASSERT_STEP_NAME
                                ? 'ERR_CHECKPOINT_ASSERT_FAILED'
                                : (result.error?.code ?? 'ERR_CHECKPOINT_STEP_FAILED'),
                    },
                },
                nextStatus,
            };
        }
    }

    const runResult = {
        stepId: ctx.failedCtx.step.id,
        ok: true,
        data: { checkpointId: ctx.checkpoint.id, checkpointName: ctx.checkpoint.name },
    };
    log.info('checkpoint.run', { checkpointId: ctx.checkpoint.id, ok: true });
    return { ...ctx, runResult };
};

const hasActionContent = (content: Checkpoint['content']) => {
    if (!content || content.length === 0) return false;
    return content.some((item: unknown) => item && typeof item === 'object' && 'type' in item);
};
