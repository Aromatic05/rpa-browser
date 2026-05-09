import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { resolveTarget } from '../helpers/resolve_target';

const pickDelayMs = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {return 0;}
    if (max <= min) {return Math.max(0, min);}
    return Math.floor(min + Math.random() * (max - min + 1));
};

export const executeBrowserType = async (
    step: Step<'browser.type'>,
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
        reason: 'browser.type',
        stepId: step.id,
        stepName: step.name,
    });
    if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}

    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
    const highlightBeforeActionMs = deps.config.waitPolicy.highlightBeforeActionMs;
    let lastError: StepResult['error'] | undefined;
    const delayMs =
        typeof step.args.delay_ms === 'number'
            ? step.args.delay_ms
            : deps.config.humanPolicy.enabled
              ? pickDelayMs(
                    deps.config.humanPolicy.typeDelayMsRange.min,
                    deps.config.humanPolicy.typeDelayMsRange.max,
                )
              : undefined;
    for (let candidateIndex = 0; candidateIndex < resolved.target.candidates.length; candidateIndex += 1) {
        const candidate = resolved.target.candidates[candidateIndex];
        const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ selector: candidate.selector });
        if (!scroll.ok) {
            lastError = mapTraceError(scroll.error);
            continue;
        }
        const visible = await binding.traceTools['trace.locator.waitForVisible']({ selector: candidate.selector, timeout });
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
        const focus = await binding.traceTools['trace.locator.focus']({ selector: candidate.selector });
        if (!focus.ok) {
            lastError = mapTraceError(focus.error);
            continue;
        }
        const typed = await binding.traceTools['trace.locator.type']({
            selector: candidate.selector,
            text: step.args.text,
            delayMs,
        });
        if (!typed.ok) {
            lastError = mapTraceError(typed.error);
            continue;
        }
        return { stepId: step.id, ok: true };
    }
    return { stepId: step.id, ok: false, error: lastError || { code: 'ERR_NOT_FOUND', message: 'no type target candidate matched' } };
};
