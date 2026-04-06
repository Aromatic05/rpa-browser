import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { normalizeTarget, mapTraceError } from '../helpers/target';
import { resolveTargetNodeId, type ResolvedLocatorTarget } from '../helpers/resolve_target';

const pickDelayMs = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    if (max <= min) return Math.max(0, min);
    return Math.floor(min + Math.random() * (max - min + 1));
};

const ensureVisible = async (
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['ensureActivePage']>>,
    target: ResolvedLocatorTarget,
    timeout?: number,
) => {
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({
        a11yNodeId: target.a11yNodeId,
        selector: target.selector,
        role: target.role,
        name: target.name,
    });
    if (!scroll.ok) return scroll;
    return binding.traceTools['trace.locator.waitForVisible']({
        a11yNodeId: target.a11yNodeId,
        selector: target.selector,
        role: target.role,
        name: target.name,
        timeout,
    });
};

export const executeBrowserType = async (
    step: Step<'browser.type'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const target = normalizeTarget(step.args);
    const resolved = await resolveTargetNodeId(binding, target);
    if (!resolved.ok) return { stepId: step.id, ok: false, error: resolved.error };

    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
    const visible = await ensureVisible(binding, resolved.target, timeout);
    if (!visible.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
    }
    const focus = await binding.traceTools['trace.locator.focus']({
        a11yNodeId: resolved.target.a11yNodeId,
        selector: resolved.target.selector,
        role: resolved.target.role,
        name: resolved.target.name,
    });
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
        a11yNodeId: resolved.target.a11yNodeId,
        selector: resolved.target.selector,
        role: resolved.target.role,
        name: resolved.target.name,
        text: step.args.text,
        delayMs,
    });
    if (!typed.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(typed.error) };
    }
    return { stepId: step.id, ok: true };
};
