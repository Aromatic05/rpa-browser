import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { mapTraceError } from '../helpers/target';

export const executeBrowserListTabs = async (
    step: Step<'browser.list_tabs'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const result = await binding.traceTools['trace.page.getInfo']();
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
    }
    return {
        stepId: step.id,
        ok: true,
        data: {
            tab_id: result.data?.tabName,
            tabs: result.data?.tabs || [],
        },
    };
};
