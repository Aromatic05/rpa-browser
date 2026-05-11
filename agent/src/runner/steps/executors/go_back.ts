import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { mapTraceError } from '../helpers/target';

export const executeBrowserGoBack = async (
    step: Step<'browser.go_back'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const result = await binding.traceTools['trace.page.goBack']({ timeout: deps.config.waitPolicy.navigationTimeoutMs });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
    }
    return { stepId: step.id, ok: true };
};
