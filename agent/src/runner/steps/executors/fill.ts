import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { normalizeTarget, mapTraceError, matchesA11yHint } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { scoreA11yConfidence } from '../helpers/confidence';
import { resolveTargetNodeId } from '../helpers/resolve_target';
import { describeSelector } from '../helpers/selector';

const ensureVisible = async (
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['ensureActivePage']>>,
    nodeId: string,
    timeout?: number,
) => {
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ a11yNodeId: nodeId });
    if (!scroll.ok) return scroll;
    return binding.traceTools['trace.locator.waitForVisible']({ a11yNodeId: nodeId, timeout });
};

export const executeBrowserFill = async (
    step: Step<'browser.fill'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const target = normalizeTarget(step.args);
    if (target?.selector) {
        const described = await describeSelector(binding.page, target.selector);
        if (!described.ok) {
            return { stepId: step.id, ok: false, error: described.error };
        }
        if (!matchesA11yHint(described.data, target.a11yHint)) {
            const confidence = scoreA11yConfidence(
                described.data,
                target.a11yHint,
                deps.config.confidencePolicy,
                true,
            );
            if (!confidence.ok) {
                // TODO: fallback to fuzzy a11y search when selector exists but hint mismatches.
                return {
                    stepId: step.id,
                    ok: false,
                    error: {
                        code: 'ERR_NOT_FOUND',
                        message: 'selector matched element but a11y hint mismatch',
                        details: {
                            selector: target.selector,
                            hint: target.a11yHint,
                            candidate: described.data,
                            confidence: confidence.details,
                        },
                    },
                };
            }
        }
        const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
        const visible = await binding.traceTools['trace.locator.waitForVisible']({
            selector: target.selector,
            timeout,
        });
        if (!visible.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
        }
        const scrolled = await binding.traceTools['trace.locator.scrollIntoView']({
            selector: target.selector,
        });
        if (!scrolled.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(scrolled.error) };
        }
        const focus = await binding.traceTools['trace.locator.focus']({
            selector: target.selector,
        });
        if (!focus.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(focus.error) };
        }
        const fill = await binding.traceTools['trace.locator.fill']({
            selector: target.selector,
            value: step.args.value,
        });
        if (!fill.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(fill.error) };
        }
        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.typeDelayMsRange.min,
                deps.config.humanPolicy.typeDelayMsRange.max,
            );
            if (delayMs > 0) await waitForHumanDelay(binding.page, delayMs);
        }
        return { stepId: step.id, ok: true };
    }
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
    const fill = await binding.traceTools['trace.locator.fill']({
        a11yNodeId: resolved.nodeId,
        value: step.args.value,
    });
    if (!fill.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(fill.error) };
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
