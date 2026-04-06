import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { normalizeTarget, mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTargetNodeId, type ResolvedLocatorTarget } from '../helpers/resolve_target';

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

export const executeBrowserPressKey = async (
    step: Step<'browser.press_key'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const target = normalizeTarget(step.args);
    if (target) {
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
    }
    const pressed = await binding.traceTools['trace.keyboard.press']({ key: step.args.key });
    if (!pressed.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(pressed.error) };
    }
    if (deps.config.humanPolicy.enabled) {
        const delayMs = pickDelayMs(
            deps.config.humanPolicy.typeDelayMsRange.min,
            deps.config.humanPolicy.typeDelayMsRange.max,
        );
        if (delayMs > 0) await waitForHumanDelay(binding.page, delayMs);
    }
    return { stepId: step.id, ok: true };
};
