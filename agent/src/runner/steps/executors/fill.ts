/**
 * browser.fill Step 执行器：基于 a11yNodeId 聚焦并填充。
 */

import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';

export const executeBrowserFill = async (
    step: Step<'browser.fill'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    if (deps.config.humanPolicy.enabled) {
        const min = deps.config.humanPolicy.typeDelayMsRange.min;
        const max = deps.config.humanPolicy.typeDelayMsRange.max;
        const delay = Math.max(min, Math.floor(Math.random() * (max - min + 1)) + min);
        await binding.page.waitForTimeout(delay);
    }
    const focus = await binding.traceTools['trace.locator.focus']({
        a11yNodeId: step.args.a11yNodeId,
    });
    if (!focus.ok) {
        return { stepId: step.id, ok: false, error: focus.error };
    }
    const fill = await binding.traceTools['trace.locator.fill']({
        a11yNodeId: step.args.a11yNodeId,
        value: step.args.value,
    });
    if (!fill.ok) {
        return { stepId: step.id, ok: false, error: fill.error };
    }
    return { stepId: step.id, ok: true };
};
