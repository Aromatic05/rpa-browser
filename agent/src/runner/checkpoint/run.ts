import { getLogger } from '../../logging/logger';
import type { Checkpoint, CheckpointCtx } from './types';
import { runCheckpointProcedure } from './runtime';
import { runCheckpointDslBody } from './dsl_body';
import { createDslEntityRulesResolver } from '../../dsl/link';

const log = getLogger('step');

const ASSERT_STEP_NAME = 'browser.assert';

const toStepFailureReason = (stepName: string) =>
    stepName === 'browser.assert' ? 'checkpoint_assert_failed' : 'checkpoint_step_failed';

export const maybeRunCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    if (!ctx.active || !ctx.checkpoint) {return ctx;}
    const checkpointStepResolves = ctx.failedCtx.checkpointStepResolves?.[ctx.checkpoint.id];
    const executeCheckpointStep = (step: Parameters<typeof ctx.failedCtx.executeStep>[0]) =>
        ctx.failedCtx.executeStep(step, checkpointStepResolves);

    const body = ctx.failedCtx.checkpointBodies?.[ctx.checkpoint.id];
    if (ctx.checkpoint.body) {
        if (!body) {
            return {...ctx, active: false, stopReason: 'checkpoint_step_failed', runResult: {stepId: ctx.failedCtx.step.id, ok: false, error: {code: 'ERR_CHECKPOINT_BODY_MISSING', message: `checkpoint body unavailable: ${ctx.checkpoint.id}`}}};
        }
        try {
            const output = await runCheckpointDslBody({
                checkpoint: ctx.checkpoint, source: body, stepResolves: checkpointStepResolves || {}, executeStep: executeCheckpointStep,
                workspaceName: ctx.failedCtx.workspaceName, deps: ctx.failedCtx.deps,
                entityRulesResolver: (() => {
                    const provider = ctx.failedCtx.deps.resolveEntityRulesProvider?.(ctx.failedCtx.workspaceName);
                    return provider ? createDslEntityRulesResolver(provider) : undefined;
                })(),
                checkpointProvider: (() => {
                    const workspace = ctx.failedCtx.deps.resolveWorkspace(ctx.failedCtx.workspaceName);
                    return workspace.checkpoint && workspace.workflow
                        ? workspace.checkpoint.getProvider(workspace.workflow) : undefined;
                })(),
                input: {failure: {step: {name: ctx.failedCtx.step.name, args: ctx.failedCtx.step.args}, error: {code: ctx.failedCtx.rawResult.error?.code, message: ctx.failedCtx.rawResult.error?.message}, attempt: ctx.failedCtx.checkpointAttempt, maxAttempts: ctx.failedCtx.checkpointMaxAttempts, ...(ctx.failedCtx.currentUrl ? {url: ctx.failedCtx.currentUrl} : {})}},
            });
            return {...ctx, runResult: {stepId: ctx.failedCtx.step.id, ok: true, data: {checkpointId: ctx.checkpoint.id, checkpointName: ctx.checkpoint.name, output}}};
        } catch (error) {
            return {...ctx, active: false, stopReason: 'checkpoint_step_failed', runResult: {stepId: ctx.failedCtx.step.id, ok: false, error: {code: error instanceof Error && 'code' in error ? String((error as {code: unknown}).code) : 'ERR_CHECKPOINT_BODY_FAILED', message: error instanceof Error ? error.message : String(error)}}};
        }
    }

    if (ctx.checkpoint.prepare || ctx.checkpoint.output || hasActionContent(ctx.checkpoint.content)) {
        const output = await runCheckpointProcedure({
            checkpoint: ctx.checkpoint,
            stepIdPrefix: `recovery:${ctx.failedCtx.step.id}`,
            executeStep: executeCheckpointStep,
        });
        if (!output.ok) {
            log.warning('checkpoint.run', {
                checkpointId: ctx.checkpoint.id,
                ok: false,
                code: output.error?.code,
                message: output.error?.message,
                details: output.error?.details,
                stopReason: 'checkpoint_step_failed',
            });
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

    if (!ctx.boundContent) {return ctx;}

    for (const item of ctx.boundContent) {
        const result = await executeCheckpointStep(item);
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
    if (!content || content.length === 0) {return false;}
    return content.some((item: unknown) => item && typeof item === 'object' && 'type' in item);
};
