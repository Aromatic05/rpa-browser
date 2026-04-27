import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTarget } from '../helpers/resolve_target';

export const executeBrowserFill = async (
    step: Step<'browser.fill'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const resolved = await resolveTarget(binding, {
        id: step.args.id || step.args.target?.id,
        selector: step.args.selector || step.args.target?.selector,
        hint: step.resolve?.hint,
        policy: step.resolve?.policy,
    });
    if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}

    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;

    const visible = await binding.traceTools['trace.locator.waitForVisible']({
        selector: resolved.target.selector,
        timeout,
    });
    if (!visible.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
    }
    const scrolled = await binding.traceTools['trace.locator.scrollIntoView']({
        selector: resolved.target.selector,
    });
    if (!scrolled.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(scrolled.error) };
    }
    const focus = await binding.traceTools['trace.locator.focus']({
        selector: resolved.target.selector,
    });
    if (!focus.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(focus.error) };
    }
    const fill = await binding.traceTools['trace.locator.fill']({
        selector: resolved.target.selector,
        value: step.args.value,
    });
    if (!fill.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(fill.error) };
    }
    if (deps.config.humanPolicy.enabled) {
        const delayMs = pickDelayMs(
            deps.config.humanPolicy.typeDelayMsRange.min,
            deps.config.humanPolicy.typeDelayMsRange.max,
        );
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return { stepId: step.id, ok: true };
};
