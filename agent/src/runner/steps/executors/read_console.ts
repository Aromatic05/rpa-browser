import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';

export const executeBrowserReadConsole = async (
    step: Step<'browser.read_console'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceName);
    const result = await binding.traceTools['trace.page.readConsole']({
        limit: step.args.limit,
    });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
    }
    return {
        stepId: step.id,
        ok: true,
        data: result.data || [],
    };
};
