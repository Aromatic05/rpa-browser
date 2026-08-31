import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { mapTraceError } from '../helpers/target';

export const executeBrowserReadNetwork = async (
    step: Step<'browser.read_network'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const result = await binding.traceTools['trace.page.readNetwork']({
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
