import type { RunStepsDeps, StepResult as TaskStepResult } from '../../runner/run_steps';
import type { StepResult as ExecutorStepResult, StepUnion } from '../../runner/steps/types';
import { runDslCheckpointCall, type DslCheckpointProvider } from '../emit/checkpoint_call';
import { buildClickStep, buildFillStep, buildQueryStep } from '../emit/step_builder';
import { DslRuntimeError, UnsupportedError } from '../diagnostics/errors';
import type { DslProgram } from '../ast/types';
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
        for (const stmt of program.body) {
            switch (stmt.kind) {
                case 'let': {
                    if (stmt.expr.kind === 'query') {
                        const step = buildQueryStep(stmt.expr);
                        const result = await emitStepAndWait(step, taskRunner);
                        setDslValue(scope, `vars.${stmt.name}`, result);
                        break;
                    }
                    setDslValue(scope, `vars.${stmt.name}`, resolveDslValue(stmt.expr, scope));
                    break;
                }
                case 'act': {
                    const target = resolveDslValue(stmt.target, scope);
                    const step =
                        stmt.action === 'fill'
                            ? buildFillStep(target, resolveDslValue(stmt.value, scope))
                            : buildClickStep(target);
                    await emitStepAndWait(step, taskRunner);
                    break;
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
                    break;
                }
                case 'if':
                    throw new UnsupportedError('DSL if is not implemented yet');
                case 'for':
                    throw new UnsupportedError('DSL for is not implemented yet');
            }
        }
    } finally {
        await taskRunner.close();
    }

    return { scope };
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
