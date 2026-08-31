import { getLogger } from '../../../../platform/logging/logger';
import type { RunStatus } from '../../run_steps_types';
import type { RunStepsDeps } from '../../run_steps_types';
import type { StepResult, StepUnion } from '../../steps/types';
import type { SerializedStepUnion } from '../../serialization/types';
import { runCheckpointProcedure } from '../runtime';
import { runCheckpointDslBody } from '../dsl_body';
import type { Checkpoint, CheckpointStopReason } from '../types';
import { getEffectiveRecoveryMaxAttempts } from './select';
import type {
    RecoveryExecutionOptions,
    RecoveryExecutionResult,
    RecoveryFailureContext,
    RecoveryStepExecutor,
    RetryOriginalStepOptions,
    RetryOriginalStepOutcome,
    RunCheckpointRecoveryOptions,
    RunCheckpointRecoveryOutcome,
} from './types';

const log = getLogger('step');

const ASSERT_STEP_NAME = 'browser.assert';

const toStepFailureReason = (stepName: string): CheckpointStopReason =>
    stepName === ASSERT_STEP_NAME ? 'checkpoint_assert_failed' : 'checkpoint_step_failed';

const hasActionContent = (content: Checkpoint['content']) => {
    if (!content || content.length === 0) {return false;}
    return content.some((item: unknown) => item && typeof item === 'object' && 'type' in item);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value));

const freezeClone = <T>(value: T): T => {
    const clone = structuredClone(value);
    const freeze = (current: unknown): unknown => {
        if (!current || typeof current !== 'object' || Object.isFrozen(current)) {return current;}
        Object.values(current).forEach(freeze);
        return Object.freeze(current);
    };
    return freeze(clone) as T;
};

const resolvePath = (bag: Record<string, unknown>, path: string): unknown => {
    const keys = path.split('.').filter(Boolean);
    let cursor: unknown = bag;
    for (const key of keys) {
        if (!cursor || typeof cursor !== 'object' || !(key in (cursor as Record<string, unknown>))) {
            throw new Error(`missing bind variable: ${path}`);
        }
        cursor = (cursor as Record<string, unknown>)[key];
    }
    return cursor;
};

const bindString = (value: string, bag: Record<string, unknown>): unknown => {
    const fullMatch = value.match(/^\s*\{\{\s*([\w.]+)\s*\}\}\s*$/);
    if (fullMatch) {
        return resolvePath(bag, fullMatch[1]);
    }
    if (!value.includes('{{')) {
        return value;
    }
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_chunk, token: string) => {
        const resolved = resolvePath(bag, token);
        return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
};

const bindValue = (value: unknown, bag: Record<string, unknown>): unknown => {
    if (typeof value === 'string') {
        return bindString(value, bag);
    }
    if (Array.isArray(value)) {
        return value.map((item) => bindValue(item, bag));
    }
    if (value && typeof value === 'object') {
        const next: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            next[key] = bindValue(val, bag);
        }
        return next;
    }
    return value;
};

const recoveryBindBag = (failure: RecoveryFailureContext): Record<string, unknown> => ({
    run: {
        id: failure.runId,
        workspaceName: failure.workspaceName,
    },
    failed: {
        stepId: failure.stepId,
        stepName: failure.stepName,
        errorCode: failure.error?.code,
        errorMessage: failure.error?.message,
        url: failure.currentUrl,
    },
});

export const bindRecoveryContent = (
    checkpoint: Checkpoint,
    failure: RecoveryFailureContext,
): { ok: true; content: StepUnion[] } | { ok: false; error: { code: string; message: string; details?: unknown } } => {
    if (!checkpoint.content || checkpoint.content.length === 0) {
        return { ok: true, content: [] };
    }
    const hasActionModel = checkpoint.content.some((item) => typeof item === 'object' && 'type' in item);
    if (hasActionModel || checkpoint.prepare || checkpoint.output || checkpoint.kind === 'procedure') {
        return { ok: true, content: [] };
    }
    const bag = recoveryBindBag(failure);
    try {
        const boundContent = checkpoint.content.map((item) => ({
            ...item,
            args: bindValue((item as SerializedStepUnion).args, bag) as StepUnion['args'],
        })) as StepUnion[];
        return { ok: true, content: boundContent };
    } catch (error) {
        return {
            ok: false,
            error: {
                code: 'ERR_CHECKPOINT_BIND_FAILED',
                message: error instanceof Error ? error.message : 'checkpoint bind failed',
            },
        };
    }
};

const checkpointBodyFailure = (
    checkpoint: Checkpoint,
    failure: RecoveryFailureContext,
    error: { code: string; message: string; details?: unknown },
): RunCheckpointRecoveryOutcome => ({
    active: false,
    stopReason: 'checkpoint_step_failed',
    runResult: {
        stepId: failure.stepId,
        ok: false,
        error: {
            ...error,
            details: {
                ...(isRecord(error.details) ? error.details : error.details === undefined ? {} : { failureDetails: error.details }),
                cause: { stepId: failure.stepId, error: failure.error },
            },
        },
    },
    meta: { checkpointBodyFailure: true },
});

const checkpointFailureScope = (
    checkpoint: Checkpoint,
    failure: RecoveryFailureContext,
    attempt: number,
    checkpointMaxAttempts: number,
): Record<string, unknown> => ({
    step: freezeClone({ id: failure.stepId, name: failure.stepName, args: failure.args }),
    error: { code: failure.error?.code, message: failure.error?.message },
    attempt: attempt + 1,
    maxAttempts: getEffectiveRecoveryMaxAttempts(checkpoint, checkpointMaxAttempts),
    ...(failure.currentUrl ? { url: failure.currentUrl } : {}),
});

export const runCheckpointRecovery = async (options: RunCheckpointRecoveryOptions & {
    workspaceName: string;
    deps: RunStepsDeps;
    attempt: number;
    checkpointMaxAttempts: number;
}): Promise<RunCheckpointRecoveryOutcome> => {
    const { checkpoint, failure } = options;
    const checkpointStepResolves = options.runtime?.checkpointStepResolves
        ? options.runtime.checkpointStepResolves[checkpoint.id]
        : undefined;
    const executeCheckpointStep: RecoveryStepExecutor = (step, stepResolves) =>
        options.executeStep(step, stepResolves ?? checkpointStepResolves);

    const body = options.runtime?.checkpointBodies
        ? options.runtime.checkpointBodies[checkpoint.id]
        : undefined;
    if (checkpoint.body) {
        if (!body) {
            return checkpointBodyFailure(checkpoint, failure, { code: 'ERR_CHECKPOINT_BODY_MISSING', message: `checkpoint body unavailable: ${checkpoint.id}` });
        }
        try {
            const output = await runCheckpointDslBody({
                checkpoint,
                source: body,
                stepResolves: checkpointStepResolves || {},
                executeStep: executeCheckpointStep,
                workspaceName: options.workspaceName,
                deps: options.deps,
                entityRulesResolver: options.runtime?.entityRulesResolver,
                resolveResolver: options.runtime?.resolveResolver,
                checkpointProvider: options.runtime?.provider,
                failure: checkpointFailureScope(checkpoint, failure, options.attempt, options.checkpointMaxAttempts),
                ...(options.debugPort ? { debugPort: options.debugPort } : {}),
            });
            return {
                active: true,
                stopReason: 'checkpoint_completed',
                runResult: {
                    stepId: failure.stepId,
                    ok: true,
                    data: { checkpointId: checkpoint.id, checkpointName: checkpoint.name, output },
                },
            };
        } catch (error) {
            const existingDetails = error && typeof error === 'object' && 'details' in error
                ? (error as {details?: unknown}).details
                : undefined;
            const bodyFailure = checkpointBodyFailure(checkpoint, failure, {
                code: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'ERR_CHECKPOINT_BODY_FAILED',
                message: error instanceof Error ? error.message : String(error),
                details: isRecord(existingDetails) ? existingDetails : {},
            });
            return {
                ...bodyFailure,
                meta: {...(bodyFailure.meta || {}), bodyError: error},
            };
        }
    }

    if (checkpoint.prepare || checkpoint.output || hasActionContent(checkpoint.content)) {
        const output = await runCheckpointProcedure({
            checkpoint,
            stepIdPrefix: `recovery:${failure.stepId}`,
            executeStep: executeCheckpointStep,
        });
        if (!output.ok) {
            log.warning('recovery.run', {
                checkpointId: checkpoint.id,
                ok: false,
                code: output.error?.code,
                message: output.error?.message,
                stopReason: 'checkpoint_step_failed',
            });
            return {
                active: false,
                stopReason: 'checkpoint_step_failed',
                runResult: { stepId: failure.stepId, ok: false, error: output.error },
            };
        }
        return {
            active: true,
            stopReason: 'checkpoint_completed',
            runResult: {
                stepId: failure.stepId,
                ok: true,
                data: { checkpointId: checkpoint.id, checkpointName: checkpoint.name, output: output.output || {} },
            },
        };
    }

    let boundContent = options.boundContent;
    if (boundContent === undefined) {
        const bound = bindRecoveryContent(checkpoint, failure);
        if (!bound.ok) {
            return {
                active: false,
                stopReason: 'checkpoint_bind_failed',
                runResult: { stepId: failure.stepId, ok: false, error: bound.error },
            };
        }
        boundContent = bound.content;
    }

    for (const item of boundContent) {
        const result = await executeCheckpointStep(item);
        if (!result.ok) {
            const stopReason = toStepFailureReason(item.name);
            const nextStatus = result.error?.code === 'ERR_CHECKPOINT_SUSPEND' ? 'suspended' : undefined;
            log.warning('recovery.run', {
                checkpointId: checkpoint.id,
                checkpointStepId: item.id,
                checkpointStepName: item.name,
                ok: false,
                code: result.error?.code,
                stopReason,
                nextStatus,
            });
            return {
                active: false,
                stopReason,
                runResult: {
                    ...result,
                    error: {
                        ...(result.error || { code: 'ERR_CHECKPOINT_STEP_FAILED', message: 'checkpoint step failed' }),
                        code: item.name === ASSERT_STEP_NAME
                            ? 'ERR_CHECKPOINT_ASSERT_FAILED'
                            : (result.error?.code ?? 'ERR_CHECKPOINT_STEP_FAILED'),
                    },
                },
                nextStatus,
            };
        }
    }

    log.info('recovery.run', { checkpointId: checkpoint.id, ok: true });
    return {
        active: true,
        stopReason: 'checkpoint_completed',
        runResult: { stepId: failure.stepId, ok: true, data: { checkpointId: checkpoint.id, checkpointName: checkpoint.name } },
    };
};

export const retryOriginalStep = async (options: RetryOriginalStepOptions): Promise<RetryOriginalStepOutcome> => {
    if (options.checkpoint.policy?.retryOriginal === false) {
        return { stopReason: 'checkpoint_completed' };
    }
    if (!options.failure.step) {
        return { stopReason: 'checkpoint_completed' };
    }
    const retryResult = await options.executeStep(options.failure.step);
    log.info('recovery.retry', {
        stepId: options.failure.stepId,
        stepName: options.failure.stepName,
        ok: retryResult.ok,
        code: retryResult.error?.code,
    });
    return { retryResult, stopReason: retryResult.ok ? 'checkpoint_completed' : 'checkpoint_retry_failed' };
};

export const foldRecoveryResult = (input: {
    active: boolean;
    checkpoint?: Checkpoint;
    runResult?: StepResult;
    retryResult?: StepResult;
    rawResult: StepResult;
    meta?: Record<string, unknown>;
    nextStatus?: RunStatus;
}): RecoveryExecutionResult => {
    if (input.nextStatus === 'suspended') {
        const finalResult =
            input.runResult ||
            ({
                stepId: input.rawResult.stepId,
                ok: false,
                error: { code: 'ERR_CHECKPOINT_SUSPEND', message: 'checkpoint requested suspend' },
            } as const);
        return {
            finalResult,
            nextStatus: 'suspended',
            meta: { ...(input.meta || {}), foldedBy: 'suspend', stopReason: input.meta?.stopReason },
        };
    }

    if (!input.active) {
        if (input.meta?.checkpointBodyFailure && input.runResult) {
            return {
                finalResult: input.runResult,
                meta: { ...input.meta, foldedBy: 'checkpoint_body_failure', stopReason: input.meta.stopReason },
            };
        }
        return {
            finalResult: input.rawResult,
            meta: { ...(input.meta || {}), foldedBy: 'raw_result', stopReason: input.meta?.stopReason },
        };
    }

    if (input.runResult?.ok) {
        const finalResult = input.retryResult ?? input.runResult;
        return {
            finalResult,
            meta: {
                ...(input.meta || {}),
                foldedBy: input.retryResult ? 'retry_result' : 'checkpoint_result',
                stopReason: input.meta?.stopReason,
            },
        };
    }

    return {
        finalResult: input.rawResult,
        meta: { ...(input.meta || {}), foldedBy: 'raw_result', stopReason: input.meta?.stopReason },
    };
};

export const executeRecovery = async (options: RecoveryExecutionOptions & {
    rawResult: StepResult;
    workspaceName: string;
    deps: RunStepsDeps;
    attempt: number;
    checkpointMaxAttempts: number;
}): Promise<RecoveryExecutionResult> => {
    const runOutcome = await runCheckpointRecovery({
        checkpoint: options.checkpoint,
        runtime: options.runtime,
        failure: options.failure,
        executeStep: options.executeStep,
        debugPort: options.debugPort,
        workspaceName: options.workspaceName,
        deps: options.deps,
        attempt: options.attempt,
        checkpointMaxAttempts: options.checkpointMaxAttempts,
    });

    let retryResult: StepResult | undefined;
    let stopReason: CheckpointStopReason | undefined = runOutcome.stopReason;
    if (runOutcome.active && runOutcome.runResult?.ok) {
        const retry = await retryOriginalStep({
            checkpoint: options.checkpoint,
            failure: options.failure,
            executeStep: options.executeStep,
        });
        if (retry.retryResult) {
            retryResult = retry.retryResult;
        }
        stopReason = retry.stopReason;
    }

    const meta = {
        ...(runOutcome.meta || {}),
        checkpointId: options.checkpoint.id,
        checkpointAttempt: options.attempt,
        stopReason,
    };
    return foldRecoveryResult({
        active: runOutcome.active,
        checkpoint: options.checkpoint,
        runResult: runOutcome.runResult,
        retryResult,
        rawResult: options.rawResult,
        meta,
        nextStatus: runOutcome.nextStatus,
    });
};