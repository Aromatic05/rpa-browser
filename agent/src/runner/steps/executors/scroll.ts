import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTarget } from '../helpers/resolve_target';

export const executeBrowserScroll = async (
    step: Step<'browser.scroll'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceId);
    const hasTarget = Boolean(step.args.nodeId || step.args.selector || step.args.resolveId || step.resolve);
    if (hasTarget) {
        const resolved = await resolveTarget(binding, {
            nodeId: step.args.nodeId,
            selector: step.args.selector,
            resolve: step.resolve,
        });
        if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}
        const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ selector: resolved.target.selector });
        if (!scroll.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(scroll.error) };
        }
        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.scrollDelayMsRange.min,
                deps.config.humanPolicy.scrollDelayMsRange.max,
            );
            if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
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
        if (delta <= 0) {continue;}
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
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return { stepId: step.id, ok: true };
};
