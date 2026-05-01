import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTarget } from '../helpers/resolve_target';

export const executeBrowserHover = async (
    step: Step<'browser.hover'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceName);
    const resolved = await resolveTarget(binding, {
        nodeId: step.args.nodeId,
        selector: step.args.selector,
        resolve: step.resolve,
    });
    if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}

    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ selector: resolved.target.selector });
    if (!scroll.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(scroll.error) };
    }
    const visible = await binding.traceTools['trace.locator.waitForVisible']({
        selector: resolved.target.selector,
        timeout,
    });
    if (!visible.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
    }
    const hover = await binding.traceTools['trace.locator.hover']({ selector: resolved.target.selector });
    if (!hover.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(hover.error) };
    }
    if (deps.config.humanPolicy.enabled) {
        const delayMs = pickDelayMs(
            deps.config.humanPolicy.clickDelayMsRange.min,
            deps.config.humanPolicy.clickDelayMsRange.max,
        );
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return { stepId: step.id, ok: true };
};
