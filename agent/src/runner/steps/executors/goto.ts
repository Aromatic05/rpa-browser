/**
 * browser.goto Step 执行器：仅调用 trace.page.goto。
 */

import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';

export const executeBrowserGoto = async (
    step: Step<'browser.goto'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const timeout =
        step.args.timeout ?? deps.config.waitPolicy.navigationTimeoutMs;
    const result = await binding.traceTools['trace.page.goto']({
        url: step.args.url,
        timeout,
    });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: result.error };
    }
    return { stepId: step.id, ok: true };
};
