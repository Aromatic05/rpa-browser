import type { RunStepsDeps, StepResult as TaskStepResult } from '../../runner/run_steps';
import type { StepResult as ExecutorStepResult, StepUnion } from '../../runner/steps/types';
import { runDslCheckpointCall, type DslCheckpointProvider } from '../emit/checkpoint_call';
import { getLogger, type Logger } from '../../logging/logger';
import { buildClickStep, buildFillStep, buildQueryStep, buildSelectStep, buildSnapshotStep, buildTypeStep } from '../emit/step_builder';
import { DslRuntimeError } from '../diagnostics/errors';
import type { DslProgram, DslStmt } from '../ast/types';
import { createDslTaskRunner } from './task_runner';
import { createDslScope, setDslValue, type DslScope } from './scope';
import { resolveDslValue } from './refs';

export type RunDslContext = {
    workspaceId: string;
    deps: RunStepsDeps;
    input?: Record<string, unknown>;
    checkpointProvider?: DslCheckpointProvider;
    logger?: Logger;
};

export type RunDslResult = {
    scope: DslScope;
};

export const runDsl = async (program: DslProgram, ctx: RunDslContext): Promise<RunDslResult> => {
    const scope = createDslScope(ctx.input);
    const taskRunner = createDslTaskRunner({
        workspaceId: ctx.workspaceId,
        deps: ctx.deps,
        stopOnError: true,
    });
    const logger = ctx.logger || getLogger('dsl');

    await taskRunner.start();
    try {
        await executeStatements(program.body, scope, ctx, taskRunner, logger);
    } finally {
        await taskRunner.close();
    }

    return { scope };
};

const executeStatements = async (
    body: DslStmt[],
    scope: DslScope,
    ctx: RunDslContext,
    taskRunner: ReturnType<typeof createDslTaskRunner>,
    logger: Logger,
): Promise<void> => {
    for (let index = 0; index < body.length; index += 1) {
        const stmt = body[index];
        safeLog(logger, 'debug', 'dsl.stmt.start', { index, kind: stmt.kind });
        try {
            await executeStmt(stmt, scope, ctx, taskRunner, logger, index);
            safeLog(logger, 'debug', 'dsl.stmt.end', { index, kind: stmt.kind });
        } catch (error) {
            safeLog(logger, 'error', 'dsl.error', { stmtIndex: index, error: toErrorLog(error) });
            throw error;
        }
    }
};

const executeStmt = async (
    stmt: DslStmt,
    scope: DslScope,
    ctx: RunDslContext,
    taskRunner: ReturnType<typeof createDslTaskRunner>,
    logger: Logger,
    stmtIndex: number,
): Promise<void> => {
    switch (stmt.kind) {
        case 'let': {
            if (stmt.expr.kind === 'query') {
                const step = buildQueryStep(stmt.expr);
                const result = await emitStepAndWait(step, taskRunner, logger, stmtIndex);
                setDslValue(scope, `vars.${stmt.name}`, result);
                safeLog(logger, 'debug', 'dsl.scope.write', { key: `vars.${stmt.name}`, valuePreview: previewValue(result) });
                return;
            }
            if (stmt.expr.kind === 'querySugar') {
                throw new DslRuntimeError(
                    'querySugar must be expanded before runtime',
                    'ERR_DSL_NOT_NORMALIZED',
                );
            }
            const value = resolveDslValue(stmt.expr, scope);
            setDslValue(scope, `vars.${stmt.name}`, value);
            safeLog(logger, 'debug', 'dsl.scope.write', { key: `vars.${stmt.name}`, valuePreview: previewValue(value) });
            return;
        }
        case 'act': {
            if (stmt.action === 'wait') {
                await sleep(stmt.durationMs || 0);
                return;
            }
            if (stmt.action === 'snapshot') {
                await emitStepAndWait(buildSnapshotStep(), taskRunner, logger, stmtIndex);
                return;
            }
            if (!stmt.target) {
                throw new DslRuntimeError(`DSL action ${stmt.action} requires target`, 'ERR_DSL_BAD_ACT_ARGS');
            }
            const target = resolveDslValue(stmt.target, scope);
            if (stmt.action === 'click') {
                await emitStepAndWait(buildClickStep(target), taskRunner, logger, stmtIndex);
                return;
            }
            const value = resolveDslValue(stmt.value, scope);
            const step =
                stmt.action === 'fill'
                    ? buildFillStep(target, value)
                    : stmt.action === 'type'
                      ? buildTypeStep(target, value)
                      : buildSelectStep(target, value);
            await emitStepAndWait(step, taskRunner, logger, stmtIndex);
            return;
        }
        case 'form_act': {
            throw new DslRuntimeError('form_act must be expanded before runtime', 'ERR_DSL_NOT_NORMALIZED');
        }
        case 'checkpoint': {
            const output = await runDslCheckpointCall({
                stmt,
                scope,
                checkpointProvider: ctx.checkpointProvider,
                executeStep: async (step) => toExecutorStepResult(await taskRunner.runStep(step)),
            });
            for (const [key, value] of Object.entries(output)) {
                setDslValue(scope, `output.${key}`, value);
                safeLog(logger, 'debug', 'dsl.scope.write', { key: `output.${key}`, valuePreview: previewValue(value) });
            }
            return;
        }
        case 'if': {
            const branch = resolveDslValue(stmt.condition, scope) ? stmt.then : stmt.else || [];
            await executeStatements(branch, scope, ctx, taskRunner, logger);
            return;
        }
        case 'for': {
            const iterable = resolveDslValue(stmt.iterable, scope);
            if (!Array.isArray(iterable)) {
                throw new DslRuntimeError('DSL for iterable must resolve to an array', 'ERR_DSL_BAD_ITERABLE');
            }
            for (const item of iterable) {
                setDslValue(scope, `vars.${stmt.item}`, item);
                safeLog(logger, 'debug', 'dsl.scope.write', { key: `vars.${stmt.item}`, valuePreview: previewValue(item) });
                await executeStatements(stmt.body, scope, ctx, taskRunner, logger);
            }
            return;
        }
    }
};

const emitStepAndWait = async (
    step: StepUnion,
    taskRunner: ReturnType<typeof createDslTaskRunner>,
    logger: Logger,
    stmtIndex: number,
): Promise<unknown> => {
    safeLog(logger, 'debug', 'dsl.step.emit', {
        stmtIndex,
        stepId: step.id,
        stepName: step.name,
    });
    const result = await taskRunner.runStep(step);
    safeLog(logger, 'debug', 'dsl.step.result', {
        stmtIndex,
        stepId: step.id,
        ok: result.ok,
    });
    if (!result.ok) {
        throw new DslRuntimeError(
            result.error?.message || `DSL step failed: ${step.name}`,
            result.error?.code || 'ERR_DSL_STEP_FAILED',
        );
    }
    return result.data;
};

const toExecutorStepResult = (result: TaskStepResult): ExecutorStepResult => {
    return {
        stepId: result.stepId,
        ok: result.ok,
        data: result.data,
        error: result.error,
    };
};

const sleep = async (durationMs: number): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
};

const previewValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
        return value.length > 100 ? `${value.slice(0, 100)}...` : value;
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    return {
        type: Array.isArray(value) ? 'array' : 'object',
        keys: Object.keys(value as Record<string, unknown>),
    };
};

const toErrorLog = (error: unknown): unknown => {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
        };
    }
    return error;
};

const safeLog = (logger: Logger, level: 'debug' | 'error', event: string, payload: Record<string, unknown>): void => {
    try {
        if (level === 'debug') {
            logger.debug(event, payload);
            return;
        }
        logger.error(event, payload);
    } catch {}
};
