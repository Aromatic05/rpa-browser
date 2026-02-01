import type { Step, StepResult } from './types';
import type { RunStepsDeps } from '../run_steps';
import { normalizeTarget, mapTraceError } from '../helpers/target';
import { resolveTargetNodeId } from '../helpers/resolve_target';

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
        return { stepId: step.id, ok: true };
    }
    const amount = step.args.amount ?? 600;
    const direction = step.args.direction ?? 'down';
    const scrolled = await binding.traceTools['trace.page.scrollBy']({ direction, amount });
    if (!scrolled.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(scrolled.error) };
    }
    return { stepId: step.id, ok: true };
};
