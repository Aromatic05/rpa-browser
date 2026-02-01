import type { Step, StepResult } from './types';
import type { RunStepsDeps } from '../run_steps';
import { mapTraceError } from '../helpers/target';

export const executeBrowserReload = async (
    step: Step<'browser.reload'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const result = await binding.traceTools['trace.page.reload']({ timeout: step.args.timeout });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
    }
    return { stepId: step.id, ok: true };
};
