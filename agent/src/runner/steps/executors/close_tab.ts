import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';

export const executeBrowserCloseTab = async (
    step: Step<'browser.close_tab'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceId);
    const tabId = step.args.tabId || step.args.tabRef;
    if (!tabId) {
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_BAD_ARGS', message: 'browser.close_tab requires tabId or tabRef' },
        };
    }
    const result = await binding.traceTools['trace.tabs.close']({
        workspaceId,
        tabId,
    });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
    }
    return { stepId: step.id, ok: true };
};
