import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTarget } from '../helpers/resolve_target';

export const executeBrowserDragAndDrop = async (
    step: Step<'browser.drag_and_drop'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const source = await resolveTarget(binding, {
        id: step.args.source.id,
        selector: step.args.source.selector,
    });
    if (!source.ok) {return { stepId: step.id, ok: false, error: source.error };}

    if (step.args.dest_target) {
        const dest = await resolveTarget(binding, {
            id: step.args.dest_target.id,
            selector: step.args.dest_target.selector,
        });
        if (!dest.ok) {return { stepId: step.id, ok: false, error: dest.error };}
        const result = await binding.traceTools['trace.locator.dragDrop']({
            source: { selector: source.target.selector },
            dest: { selector: dest.target.selector },
        });
        if (!result.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
        }
        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.clickDelayMsRange.min,
                deps.config.humanPolicy.clickDelayMsRange.max,
            );
            if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
        }
        return { stepId: step.id, ok: true };
    }

    if (!step.args.dest_coord) {
        return { stepId: step.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'missing drag destination' } };
    }
    const result = await binding.traceTools['trace.locator.dragDrop']({
        source: { selector: source.target.selector },
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
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return { stepId: step.id, ok: true };
};
