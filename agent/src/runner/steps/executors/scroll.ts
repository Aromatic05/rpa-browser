import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { normalizeTarget, mapTraceError } from '../helpers/target';
import { resolveTargetNodeId } from '../helpers/resolve_target';

const pickDelayMs = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    if (max <= min) return Math.max(0, min);
    return Math.floor(min + Math.random() * (max - min + 1));
};

export const executeBrowserScroll = async (
    step: Step<'browser.scroll'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const target = normalizeTarget(step.args);
    if (target) {
        const resolved = await resolveTargetNodeId(binding, target);
        if (!resolved.ok) return { stepId: step.id, ok: false, error: resolved.error };
        const scroll = await binding.traceTools['trace.locator.scrollIntoView']({
            a11yNodeId: resolved.nodeId,
        });
        if (!scroll.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(scroll.error) };
        }
        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.scrollDelayMsRange.min,
                deps.config.humanPolicy.scrollDelayMsRange.max,
            );
            if (delayMs > 0) await binding.page.waitForTimeout(delayMs);
        }
        return { stepId: step.id, ok: true };
    }
    const amount = step.args.amount ?? 600;
    const direction = step.args.direction ?? 'down';
    const total = Math.max(0, Math.abs(amount));
    const steps = Math.min(14, Math.max(6, Math.ceil(total / 250)));
    const perStep = steps > 0 ? Math.floor(total / steps) : total;
    let remaining = total;
    for (let i = 0; i < steps; i += 1) {
        const delta = i === steps - 1 ? remaining : perStep;
        remaining -= delta;
        if (delta <= 0) continue;
        const scrolled = await binding.traceTools['trace.page.scrollBy']({ direction, amount: delta });
        if (!scrolled.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(scrolled.error) };
        }
        const delayMs = deps.config.humanPolicy.enabled
            ? pickDelayMs(
                  deps.config.humanPolicy.scrollDelayMsRange.min,
                  deps.config.humanPolicy.scrollDelayMsRange.max,
              )
            : 16;
        if (delayMs > 0) await binding.page.waitForTimeout(delayMs);
    }
    return { stepId: step.id, ok: true };
};
