import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { normalizeTarget, mapTraceError } from '../helpers/target';
import { resolveTargetNodeId } from '../helpers/resolve_target';

const pickDelayMs = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    if (max <= min) return Math.max(0, min);
    return Math.floor(min + Math.random() * (max - min + 1));
};

const ensureVisible = async (
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['ensureActivePage']>>,
    nodeId: string,
    timeout?: number,
) => {
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ a11yNodeId: nodeId });
    if (!scroll.ok) return scroll;
    return binding.traceTools['trace.locator.waitForVisible']({ a11yNodeId: nodeId, timeout });
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
    const visible = await ensureVisible(binding, resolved.nodeId, timeout);
    if (!visible.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
    }
    const focus = await binding.traceTools['trace.locator.focus']({ a11yNodeId: resolved.nodeId });
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
        a11yNodeId: resolved.nodeId,
        text: step.args.text,
        delayMs,
    });
    if (!typed.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(typed.error) };
    }
    return { stepId: step.id, ok: true };
};
