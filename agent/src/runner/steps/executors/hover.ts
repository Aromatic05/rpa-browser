import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTarget } from '../helpers/resolve_target';

export const executeBrowserHover = async (
    step: Step<'browser.hover'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceName);
    const resolved = await resolveTarget(binding, {
        nodeId: step.args.nodeId,
        selector: step.args.selector,
        resolve: step.resolve,
    }, {
        deps,
        workspaceName,
        reason: 'browser.hover',
        stepId: step.id,
        stepName: step.name,
    });
    if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}

    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
    const highlightBeforeActionMs = deps.config.waitPolicy.highlightBeforeActionMs;
    let lastError: StepResult['error'] | undefined;
    for (let candidateIndex = 0; candidateIndex < resolved.target.candidates.length; candidateIndex += 1) {
        const candidate = resolved.target.candidates[candidateIndex];
        const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ selector: candidate.selector });
        if (!scroll.ok) {
            lastError = mapTraceError(scroll.error);
            continue;
        }
        const visible = await binding.traceTools['trace.locator.waitForVisible']({
            selector: candidate.selector,
            timeout,
        });
        if (!visible.ok) {
            lastError = mapTraceError(visible.error);
            continue;
        }
        const highlight = await binding.traceTools['trace.locator.highlight']({
            selector: candidate.selector,
            highlightMs: highlightBeforeActionMs,
            candidateIndex,
            stepId: step.id,
            stepName: step.name,
        });
        if (!highlight.ok) {
            lastError = mapTraceError(highlight.error);
            continue;
        }
        const hover = await binding.traceTools['trace.locator.hover']({ selector: candidate.selector });
        if (!hover.ok) {
            lastError = mapTraceError(hover.error);
            continue;
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
    return { stepId: step.id, ok: false, error: lastError || { code: 'ERR_NOT_FOUND', message: 'no hover target candidate matched' } };
};
