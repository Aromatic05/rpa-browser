import {evaluateComputeExpression, type ComputeEvalScope} from '../../../program/compute/evaluate';
import type {RunLocalStepResults, RunStepsDeps} from '../../run_steps';
import {awaitPageBoundBinding} from '../helpers/runtime_binding';
import type {Step, StepResult} from '../types';

export const executeBrowserCompute = async (
    step: Step<'browser.compute'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const cache = binding.traceCtx.cache as {computeScope?: unknown; runnerStepResults?: unknown};
    const scope: ComputeEvalScope = {
        ...readEvalScope(cache.computeScope),
        steps: readRunLocalStepResults(cache.runnerStepResults),
    };

    try {
        return {
            stepId: step.id,
            ok: true,
            data: {value: evaluateComputeExpression(step.args.expr, scope)},
        };
    } catch (error) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: error instanceof Error ? error.message : 'invalid compute expression',
            },
        };
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const readRunLocalStepResults = (value: unknown): RunLocalStepResults | undefined => {
    if (!isRecord(value)) {return undefined;}
    const results: RunLocalStepResults = {};
    for (const [stepId, rawResult] of Object.entries(value)) {
        if (!isRecord(rawResult) || typeof rawResult.ok !== 'boolean') {continue;}
        results[stepId] = {
            ok: rawResult.ok,
            data: rawResult.data,
            error: rawResult.error,
        };
    }
    return results;
};

const readEvalScope = (value: unknown): ComputeEvalScope => {
    if (!isRecord(value)) {return {};}
    return {
        input: isRecord(value.input) ? value.input : undefined,
        local: isRecord(value.local) ? value.local : undefined,
        output: isRecord(value.output) ? value.output : undefined,
    };
};
