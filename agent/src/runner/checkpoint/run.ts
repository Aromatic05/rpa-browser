import { getLogger } from '../../logging/logger';
import type { Checkpoint, CheckpointCtx } from './types';
import { runCheckpointProcedure } from './runtime';
import { runCheckpointDslBody } from './dsl_body';
import { getEffectiveCheckpointMaxAttempts } from './match';

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
            return checkpointBodyFailure(ctx, {code: 'ERR_CHECKPOINT_BODY_MISSING', message: `checkpoint body unavailable: ${ctx.checkpoint.id}`});
        }
        try {
            const output = await runCheckpointDslBody({
                checkpoint: ctx.checkpoint, source: body, stepResolves: checkpointStepResolves || {}, executeStep: executeCheckpointStep,
                workspaceName: ctx.failedCtx.workspaceName, deps: ctx.failedCtx.deps,
                entityRulesResolver: ctx.failedCtx.checkpointRuntime?.entityRulesResolver,
                resolveResolver: ctx.failedCtx.checkpointRuntime?.resolveResolver,
                checkpointProvider: ctx.failedCtx.checkpointRuntime?.provider,
                failure: checkpointFailureScope(ctx),
            });
            return {...ctx, runResult: {stepId: ctx.failedCtx.step.id, ok: true, data: {checkpointId: ctx.checkpoint.id, checkpointName: ctx.checkpoint.name, output}}};
        } catch (error) {
            return checkpointBodyFailure(ctx, {
                code: error instanceof Error && 'code' in error ? String((error as {code: unknown}).code) : 'ERR_CHECKPOINT_BODY_FAILED',
                message: error instanceof Error ? error.message : String(error),
                ...((error && typeof error === 'object' && 'diagnostics' in error)
                    ? {details: {diagnostics: error.diagnostics}}
                    : {}),
            });
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

const checkpointBodyFailure = (ctx: CheckpointCtx, error: {code: string; message: string; details?: unknown}): CheckpointCtx => ({
    ...ctx,
    active: false as const,
    stopReason: 'checkpoint_step_failed' as const,
    runResult: {
        stepId: ctx.failedCtx.step.id,
        ok: false,
        error: {
            ...error,
            details: {
                ...(isRecord(error.details) ? error.details : error.details === undefined ? {} : {failureDetails: error.details}),
                cause: {stepId: ctx.failedCtx.step.id, error: ctx.failedCtx.rawResult.error},
            },
        },
    },
    meta: {...(ctx.meta || {}), checkpointBodyFailure: true},
});

const checkpointFailureScope = (ctx: CheckpointCtx): Record<string, unknown> => ({
    step: freezeClone({id: ctx.failedCtx.step.id, name: ctx.failedCtx.step.name, args: ctx.failedCtx.step.args}),
    error: {code: ctx.failedCtx.rawResult.error?.code, message: ctx.failedCtx.rawResult.error?.message},
    attempt: selectedCheckpointAttempt(ctx) + 1,
    maxAttempts: getEffectiveCheckpointMaxAttempts(ctx.checkpoint!, ctx.failedCtx.checkpointMaxAttempts),
    ...(ctx.failedCtx.currentUrl ? {url: ctx.failedCtx.currentUrl} : {}),
});

const selectedCheckpointAttempt = (ctx: CheckpointCtx): number =>
    typeof ctx.meta?.checkpointAttempt === 'number'
        ? ctx.meta.checkpointAttempt
        : ctx.failedCtx.checkpointAttempt;

const freezeClone = <T>(value: T): T => {
    const clone = structuredClone(value);
    const freeze = (current: unknown): unknown => {
        if (!current || typeof current !== 'object' || Object.isFrozen(current)) {return current;}
        Object.values(current).forEach(freeze);
        return Object.freeze(current);
    };
    return freeze(clone) as T;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value));

const hasActionContent = (content: Checkpoint['content']) => {
    if (!content || content.length === 0) {return false;}
    return content.some((item: unknown) => item && typeof item === 'object' && 'type' in item);
};
