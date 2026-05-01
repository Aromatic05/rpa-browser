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
    const binding = await deps.runtime.resolveBinding(workspaceId);
    const source = await resolveTarget(binding, {
        nodeId: step.args.sourceNodeId,
        selector: step.args.sourceSelector,
        resolve: step.resolve,
    });
    if (!source.ok) {return { stepId: step.id, ok: false, error: source.error };}

    if (step.args.destNodeId || step.args.destSelector || step.args.destResolveId) {
        const dest = await resolveTarget(binding, {
            nodeId: step.args.destNodeId,
            selector: step.args.destSelector,
            resolve: step.resolve,
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

    if (!step.args.destCoord) {
        return { stepId: step.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'missing drag destination' } };
    }
    const result = await binding.traceTools['trace.locator.dragDrop']({
        source: { selector: source.target.selector },
        destCoord: step.args.destCoord,
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
