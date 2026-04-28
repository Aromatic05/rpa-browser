import crypto from 'node:crypto';
import { runStepList, type RunStepsDeps } from '../../runner/run_steps';
import type { StepResult, StepUnion } from '../../runner/steps/types';
import { runDslCheckpointCall } from '../emit/checkpoint_call';
import { buildClickStep, buildFillStep, buildQueryStep } from '../emit/step_builder';
import { UnsupportedError } from '../diagnostics/errors';
import type { DslProgram } from '../ast/types';
import { createDslScope, setDslValue, type DslScope } from './scope';
import { resolveDslValue } from './refs';

export type RunDslContext = {
    workspaceId: string;
    deps: RunStepsDeps;
    input?: Record<string, unknown>;
};

export type RunDslResult = {
    scope: DslScope;
};

export const runDsl = async (program: DslProgram, ctx: RunDslContext): Promise<RunDslResult> => {
    const scope = createDslScope(ctx.input);
    for (const stmt of program.body) {
        switch (stmt.kind) {
            case 'let': {
                if (stmt.expr.kind === 'query') {
                    const step = buildQueryStep(stmt.expr);
                    const result = await emitStepAndWait(step, ctx);
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
                await emitStepAndWait(step, ctx);
                break;
            }
            case 'checkpoint': {
                const output = await runDslCheckpointCall({
                    stmt,
                    scope,
                    executeStep: async (step) => await executeStep(step, ctx),
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

    return { scope };
};

const emitStepAndWait = async (step: StepUnion, ctx: RunDslContext): Promise<unknown> => {
    const result = await executeStep(step, ctx);
    if (!result.ok) {
        throw new Error(result.error?.message || `DSL step failed: ${step.name}`);
    }
    return result.data;
};

const executeStep = async (step: StepUnion, ctx: RunDslContext): Promise<StepResult> => {
    const runId = `dsl:${crypto.randomUUID()}`;
    const { checkpoint, pipe } = await runStepList(ctx.workspaceId, [step], ctx.deps, {
        runId,
        stopOnError: true,
    });
    const result = pipe.items[0];
    if (!result) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_DSL_STEP_MISSING_RESULT',
                message: `runner returned no result for step: ${step.name}`,
            },
        };
    }
    if (checkpoint.status === 'failed' && result.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_DSL_RUN_FAILED',
                message: `runner failed while executing step: ${step.name}`,
            },
        };
    }
    return {
        stepId: result.stepId,
        ok: result.ok,
        data: result.data,
        error: result.error,
    };
};
