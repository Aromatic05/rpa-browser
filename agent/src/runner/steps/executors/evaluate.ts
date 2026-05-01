import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';

export const executeBrowserEvaluate = async (
    step: Step<'browser.evaluate'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceId);
    const result = await binding.traceTools['trace.page.evaluate']({
        expression: step.args.expression,
        arg: step.args.arg,
    });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
    }
    return {
        stepId: step.id,
        ok: true,
        data: result.data,
    };
};
