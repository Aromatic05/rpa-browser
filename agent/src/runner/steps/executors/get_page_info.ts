import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';

export const executeBrowserGetPageInfo = async (
    step: Step<'browser.get_page_info'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const result = await binding.traceTools['trace.page.getInfo']();
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
    }
    return {
        stepId: step.id,
        ok: true,
        data: {
            url: result.data?.url,
            title: result.data?.title,
            tab_id: result.data?.tabId,
            tabs: result.data?.tabs,
        },
    };
};
