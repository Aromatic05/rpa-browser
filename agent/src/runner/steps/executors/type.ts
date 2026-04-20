import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { resolveTarget } from '../helpers/resolve_target';

const pickDelayMs = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    if (max <= min) return Math.max(0, min);
    return Math.floor(min + Math.random() * (max - min + 1));
};

export const executeBrowserType = async (
    step: Step<'browser.type'>,
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
    if (!resolved.ok) return { stepId: step.id, ok: false, error: resolved.error };

    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ selector: resolved.target.selector });
    if (!scroll.ok) return { stepId: step.id, ok: false, error: mapTraceError(scroll.error) };

    const visible = await binding.traceTools['trace.locator.waitForVisible']({ selector: resolved.target.selector, timeout });
    if (!visible.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
    }
    const focus = await binding.traceTools['trace.locator.focus']({ selector: resolved.target.selector });
    if (!focus.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(focus.error) };
    }
    const delayMs =
        typeof step.args.delay_ms === 'number'
            ? step.args.delay_ms
            : deps.config.humanPolicy.enabled
              ? pickDelayMs(
                    deps.config.humanPolicy.typeDelayMsRange.min,
                    deps.config.humanPolicy.typeDelayMsRange.max,
                )
              : undefined;
    const typed = await binding.traceTools['trace.locator.type']({
        selector: resolved.target.selector,
        text: step.args.text,
        delayMs,
    });
    if (!typed.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(typed.error) };
    }
    return { stepId: step.id, ok: true };
};
