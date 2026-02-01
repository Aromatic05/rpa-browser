/**
 * browser.click Step 执行器：基于 a11yNodeId 进行可见性检查与点击。
 */

import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';

export const executeBrowserClick = async (
    step: Step<'browser.click'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const wait = await binding.traceTools['trace.locator.waitForVisible']({
        a11yNodeId: step.args.a11yNodeId,
        timeout: step.args.timeout,
    });
    if (!wait.ok) {
        return { stepId: step.id, ok: false, error: wait.error };
    }
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({
        a11yNodeId: step.args.a11yNodeId,
    });
    if (!scroll.ok) {
        return { stepId: step.id, ok: false, error: scroll.error };
    }
    const click = await binding.traceTools['trace.locator.click']({
        a11yNodeId: step.args.a11yNodeId,
        timeout: step.args.timeout,
    });
    if (!click.ok) {
        return { stepId: step.id, ok: false, error: click.error };
    }
    return { stepId: step.id, ok: true };
};
