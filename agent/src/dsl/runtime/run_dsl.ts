import type { RunStepsDeps, StepResult as TaskStepResult } from '../../runner/run_steps';
import type { StepResult as ExecutorStepResult, StepUnion } from '../../runner/steps/types';
import { runDslCheckpointCall, type DslCheckpointProvider } from '../emit/checkpoint_call';
import { buildClickStep, buildFillStep, buildQueryStep } from '../emit/step_builder';
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

    await taskRunner.start();
    try {
        await executeStatements(program.body, scope, ctx, taskRunner);
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
): Promise<void> => {
    for (const stmt of body) {
        await executeStmt(stmt, scope, ctx, taskRunner);
    }
};

const executeStmt = async (
    stmt: DslStmt,
    scope: DslScope,
    ctx: RunDslContext,
    taskRunner: ReturnType<typeof createDslTaskRunner>,
): Promise<void> => {
    switch (stmt.kind) {
        case 'let': {
            if (stmt.expr.kind === 'query') {
                const step = buildQueryStep(stmt.expr);
                const result = await emitStepAndWait(step, taskRunner);
                setDslValue(scope, `vars.${stmt.name}`, result);
                return;
            }
            setDslValue(scope, `vars.${stmt.name}`, resolveDslValue(stmt.expr, scope));
            return;
        }
        case 'act': {
            const target = resolveDslValue(stmt.target, scope);
            const step =
                stmt.action === 'fill'
                    ? buildFillStep(target, resolveDslValue(stmt.value, scope))
                    : buildClickStep(target);
            await emitStepAndWait(step, taskRunner);
            return;
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
            }
            return;
        }
        case 'if': {
            const branch = resolveDslValue(stmt.condition, scope) ? stmt.then : stmt.else || [];
            await executeStatements(branch, scope, ctx, taskRunner);
            return;
        }
        case 'for': {
            const iterable = resolveDslValue(stmt.iterable, scope);
            if (!Array.isArray(iterable)) {
                throw new DslRuntimeError('DSL for iterable must resolve to an array', 'ERR_DSL_BAD_ITERABLE');
            }
            for (const item of iterable) {
                setDslValue(scope, `vars.${stmt.item}`, item);
                await executeStatements(stmt.body, scope, ctx, taskRunner);
            }
            return;
        }
    }
};

const emitStepAndWait = async (
    step: StepUnion,
    taskRunner: ReturnType<typeof createDslTaskRunner>,
): Promise<unknown> => {
    const result = await taskRunner.runStep(step);
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
