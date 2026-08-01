import type { RunStepsDeps, StepResult as TaskStepResult } from '../../runner/run_steps';
import type { BrowserQueryResult, StepResolve, StepResult as ExecutorStepResult, StepUnion } from '../../runner/steps/types';
import { runDslCheckpointCall, type DslCheckpointProvider } from '../emit/checkpoint_call';
import { getLogger, type Logger } from '../../logging/logger';
import { buildClickStep, buildFillStep, buildQueryStep, buildSelectStep, buildSnapshotStep, buildTypeStep } from '../emit/step_builder';
import { DslRuntimeError } from '../diagnostics/errors';
import type { DslProgram, DslStmt } from '../ast/types';
import { collectDefinitelyAssignedVariables } from '../analysis/definite_assignment';
import { createDslTaskRunner } from './task_runner';
import {
    createChildDslScope,
    createDslScope,
    promoteDslVariables,
    setDslValue,
    type DslScope,
} from './scope';
import { resolveDslValue } from './refs';
import { adaptDslQueryResult } from './value_adapter';
import type { DslEntityRulesResolver } from '../link';
import type { DslResolveResolver } from '../link';
import { injectStepResolve } from '../../runner/step_resolve';

export type RunDslContext = {
    workspaceName: string;
    deps: RunStepsDeps;
    input?: Record<string, unknown>;
    failure?: Record<string, unknown>;
    checkpointProvider?: DslCheckpointProvider;
    logger?: Logger;
    entityRulesResolver?: DslEntityRulesResolver;
    resolveResolver?: DslResolveResolver;
    stepResolves?: Record<string, StepResolve>;
    stepExecutionPort?: StepExecutionPort;
    checkpointCallStack?: string[];
};

export type StepExecutionPort = { execute(step: StepUnion): Promise<ExecutorStepResult> };

export type RunDslResult = {
    scope: DslScope;
};

export const runDsl = async (program: DslProgram, ctx: RunDslContext): Promise<RunDslResult> => {
    const scope = createDslScope(ctx.input, ctx.failure);
    const taskRunner = ctx.stepExecutionPort ? undefined : createDslTaskRunner({
        workspaceName: ctx.workspaceName, deps: ctx.deps, stopOnError: true,
    });
    const rawPort: StepExecutionPort = ctx.stepExecutionPort || {execute: async (step) => toExecutorStepResult(await taskRunner!.runStep(step))};
    const port: StepExecutionPort = {
        execute: async (step) => {
            const runtimeStep = injectStepResolve(step, ctx.stepResolves);
            if (!runtimeStep.ok) {return {stepId: step.id, ok: false, error: runtimeStep.error};}
            return await rawPort.execute(runtimeStep.step);
        },
    };
    const logger = ctx.logger || getLogger('dsl');

    await taskRunner?.start();
    try {
        await executeStatements(program.body, scope, ctx, port, logger);
    } finally {
        await taskRunner?.close();
    }

    return { scope };
};

const executeStatements = async (
    body: DslStmt[],
    scope: DslScope,
    ctx: RunDslContext,
    port: StepExecutionPort,
    logger: Logger,
): Promise<void> => {
    for (let index = 0; index < body.length; index += 1) {
        const stmt = body[index];
        safeLog(logger, 'debug', 'dsl.stmt.start', { index, kind: stmt.kind });
        try {
            await executeStmt(stmt, scope, ctx, port, logger, index);
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
    port: StepExecutionPort,
    logger: Logger,
    stmtIndex: number,
): Promise<void> => {
    switch (stmt.kind) {
        case 'let': {
            if (stmt.expr.kind === 'query') {
                const step = buildQueryStep(stmt.expr, (ref) => resolveDslValue(ref, scope));
                const result = await emitStepAndWait(step, port, logger, stmtIndex);
                const value = adaptDslQueryResult(result as BrowserQueryResult);
                setDslValue(scope, `vars.${stmt.name}`, value);
                safeLog(logger, 'debug', 'dsl.scope.write', { key: `vars.${stmt.name}`, valuePreview: previewValue(value) });
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
        case 'output': {
            const value = resolveDslValue(stmt.expr, scope);
            setDslValue(scope, `output.${stmt.name}`, value);
            return;
        }
        case 'act': {
            if (stmt.action === 'wait') {
                await sleep(stmt.durationMs || 0);
                return;
            }
            if (stmt.action === 'snapshot') {
                await emitStepAndWait(buildSnapshotStep(), port, logger, stmtIndex);
                return;
            }
            if (!stmt.target) {
                throw new DslRuntimeError(`DSL action ${stmt.action} requires target`, 'ERR_DSL_BAD_ACT_ARGS');
            }
            const target = resolveDslValue(stmt.target, scope);
            if (stmt.action === 'click') {
                await emitStepAndWait(buildClickStep(target, stmt.profileName), port, logger, stmtIndex);
                return;
            }
            const value = resolveDslValue(stmt.value, scope);
            const step =
                stmt.action === 'fill'
                    ? buildFillStep(target, value, stmt.profileName)
                    : stmt.action === 'type'
                      ? buildTypeStep(target, value, stmt.profileName)
                      : buildSelectStep(target, value, stmt.profileName);
            await emitStepAndWait(step, port, logger, stmtIndex);
            return;
        }
        case 'linked_entity_act': {
            const queryStep = buildQueryStep(stmt.targetQuery, (ref) => resolveDslValue(ref, scope));
            const queryResult = await emitStepAndWait(queryStep, port, logger, stmtIndex);
            const target = adaptDslQueryResult(
                queryResult as BrowserQueryResult,
            );
            const profileName = stmt.targetQuery.profileName;
            if (stmt.action === 'click') {
                await emitStepAndWait(buildClickStep(target, profileName), port, logger, stmtIndex);
                return;
            }
            const value = resolveDslValue(stmt.value, scope);
            const step = stmt.action === 'fill'
                ? buildFillStep(target, value, profileName)
                : stmt.action === 'type'
                    ? buildTypeStep(target, value, profileName)
                    : buildSelectStep(target, value, profileName);
            await emitStepAndWait(step, port, logger, stmtIndex);
            return;
        }
        case 'resolve_act': {
            if (!stmt.resolveId) {
                throw new DslRuntimeError('resolve action must be linked before runtime', 'ERR_DSL_NOT_LINKED');
            }
            const target = {resolveId: stmt.resolveId};
            safeLog(logger, 'debug', 'dsl.resolve.action', {
                alias: stmt.target.alias,
                bundleName: stmt.target.bundleName,
                symbol: stmt.target.symbol,
                resolveId: stmt.resolveId,
            });
            if (stmt.action === 'click') {
                await emitStepAndWait(buildClickStep(target), port, logger, stmtIndex);
                return;
            }
            const value = resolveDslValue(stmt.value, scope);
            const step = stmt.action === 'fill'
                ? buildFillStep(target, value)
                : stmt.action === 'type'
                    ? buildTypeStep(target, value)
                    : buildSelectStep(target, value);
            await emitStepAndWait(step, port, logger, stmtIndex);
            return;
        }
        case 'form_act':
        case 'table_act': {
            throw new DslRuntimeError(`${stmt.kind} must be expanded before runtime`, 'ERR_DSL_NOT_NORMALIZED');
        }
        case 'entity_act': {
            throw new DslRuntimeError('entity_act must be linked before runtime', 'ERR_DSL_NOT_LINKED');
        }
        case 'checkpoint': {
            const output = await runDslCheckpointCall({
                stmt,
                scope,
                checkpointProvider: ctx.checkpointProvider,
                executeStep: (step) => port.execute(step),
                workspaceName: ctx.workspaceName,
                deps: ctx.deps,
                entityRulesResolver: ctx.entityRulesResolver,
                resolveResolver: ctx.resolveResolver,
                callStack: ctx.checkpointCallStack,
            });
            if (stmt.bind) {
                setDslValue(scope, `vars.${stmt.bind}`, output);
            }
            return;
        }
        case 'if': {
            const branch = resolveDslValue(stmt.condition, scope) ? stmt.then : stmt.else || [];
            const before = new Set(Object.keys(scope.vars));
            const child = createChildDslScope(scope);
            await executeStatements(branch, child, ctx, port, logger);
            const after = collectDefinitelyAssignedVariables([stmt], before);
            promoteDslVariables(scope, child, [...after].filter((name) => !before.has(name)));
            return;
        }
        case 'for': {
            const iterable = resolveDslValue(stmt.iterable, scope);
            if (!Array.isArray(iterable)) {
                throw new DslRuntimeError('DSL for iterable must resolve to an array', 'ERR_DSL_BAD_ITERABLE');
            }
            for (const item of iterable) {
                const child = createChildDslScope(scope);
                setDslValue(child, `vars.${stmt.item}`, item);
                safeLog(logger, 'debug', 'dsl.scope.write', { key: `vars.${stmt.item}`, valuePreview: previewValue(item) });
                await executeStatements(stmt.body, child, ctx, port, logger);
            }
            return;
        }
    }
};

const emitStepAndWait = async (
    step: StepUnion,
    port: StepExecutionPort,
    logger: Logger,
    stmtIndex: number,
): Promise<unknown> => {
    safeLog(logger, 'debug', 'dsl.step.emit', {
        stmtIndex,
        stepId: step.id,
        stepName: step.name,
    });
    const result = await port.execute(step);
    safeLog(logger, 'debug', 'dsl.step.result', {
        stmtIndex,
        stepId: step.id,
        ok: result.ok,
    });
    if (!result.ok) {
        throw new DslRuntimeError(
            result.error?.message || `DSL step failed: ${step.name}`,
            result.error?.code || 'ERR_DSL_STEP_FAILED',
            result.error?.details,
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
        return {type: 'string', length: value.length};
    }
    if (value === null || value === undefined) {
        return {type: value === null ? 'null' : 'undefined'};
    }
    if (typeof value !== 'object') {
        return {type: typeof value};
    }
    return {
        type: Array.isArray(value) ? 'array' : 'object',
        ...(Array.isArray(value) ? {length: value.length} : {keys: Object.keys(value)}),
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
    } catch {
        // Logging must never affect DSL execution.
    }
};
