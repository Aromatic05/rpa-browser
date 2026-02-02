import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { normalizeTarget, mapTraceError } from '../helpers/target';
import { resolveTargetNodeId } from '../helpers/resolve_target';

const pickDelayMs = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    if (max <= min) return Math.max(0, min);
    return Math.floor(min + Math.random() * (max - min + 1));
};

export const executeBrowserDragAndDrop = async (
    step: Step<'browser.drag_and_drop'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const sourceTarget = normalizeTarget({ target: step.args.source });
    const source = await resolveTargetNodeId(binding, sourceTarget);
    if (!source.ok) return { stepId: step.id, ok: false, error: source.error };

    if (step.args.dest_target) {
        const destTarget = normalizeTarget({ target: step.args.dest_target });
        const dest = await resolveTargetNodeId(binding, destTarget);
        if (!dest.ok) return { stepId: step.id, ok: false, error: dest.error };
        const result = await binding.traceTools['trace.locator.dragDrop']({
            sourceNodeId: source.nodeId,
            destNodeId: dest.nodeId,
        });
        if (!result.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
        }
        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.clickDelayMsRange.min,
                deps.config.humanPolicy.clickDelayMsRange.max,
            );
            if (delayMs > 0) await binding.page.waitForTimeout(delayMs);
        }
        return { stepId: step.id, ok: true };
    }

    if (!step.args.dest_coord) {
        return { stepId: step.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'missing drag destination' } };
    }
    const result = await binding.traceTools['trace.locator.dragDrop']({
        sourceNodeId: source.nodeId,
        destCoord: step.args.dest_coord,
    });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
    }
    if (deps.config.humanPolicy.enabled) {
        const delayMs = pickDelayMs(
            deps.config.humanPolicy.clickDelayMsRange.min,
            deps.config.humanPolicy.clickDelayMsRange.max,
        );
        if (delayMs > 0) await binding.page.waitForTimeout(delayMs);
    }
    return { stepId: step.id, ok: true };
};
