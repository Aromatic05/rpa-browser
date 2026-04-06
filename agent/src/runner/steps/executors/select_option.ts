import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { normalizeTarget, mapTraceError, matchesA11yHint } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { scoreA11yConfidence } from '../helpers/confidence';
import { describeSelector } from '../helpers/selector';
import { resolveTargetNodeId, type ResolvedLocatorTarget } from '../helpers/resolve_target';

const ensureVisible = async (
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['ensureActivePage']>>,
    target: ResolvedLocatorTarget,
    timeout?: number,
) => {
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({
        a11yNodeId: target.a11yNodeId,
        selector: target.selector,
        role: target.role,
        name: target.name,
    });
    if (!scroll.ok) return scroll;
    return binding.traceTools['trace.locator.waitForVisible']({
        a11yNodeId: target.a11yNodeId,
        selector: target.selector,
        role: target.role,
        name: target.name,
        timeout,
    });
};

export const executeBrowserSelectOption = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const ensureSelected = (selected: string[] | undefined, expected: string[], details: Record<string, unknown>) => {
        const actual = Array.isArray(selected) ? selected : [];
        const missing = expected.filter((value) => !actual.includes(value));
        if (missing.length === 0) return null;
        return {
            stepId: step.id,
            ok: false as const,
            error: {
                code: 'ERR_ASSERTION_FAILED',
                message: 'select_option did not select expected value(s)',
                details: {
                    ...details,
                    expected,
                    selected: actual,
                    missing,
                },
            },
        };
    };
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const target = normalizeTarget(step.args);
    const resolved = await resolveTargetNodeId(binding, target);
    if (!resolved.ok) return { stepId: step.id, ok: false, error: resolved.error };

    if (resolved.target.selector && target?.a11yHint) {
        const described = await describeSelector(binding.page, resolved.target.selector);
        if (!described.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(described.error) };
        }
        if (!matchesA11yHint(described.data, target.a11yHint)) {
            const confidence = scoreA11yConfidence(
                described.data,
                target.a11yHint,
                deps.config.confidencePolicy,
                true,
            );
            if (!confidence.ok) {
                return {
                    stepId: step.id,
                    ok: false,
                    error: {
                        code: 'ERR_NOT_FOUND',
                        message: 'selector matched element but a11y hint mismatch',
                        details: {
                            selector: resolved.target.selector,
                            hint: target.a11yHint,
                            candidate: described.data,
                            confidence: confidence.details,
                        },
                    },
                };
            }
        }
        const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
        const select = await binding.traceTools['trace.locator.selectOption']({
            selector: resolved.target.selector,
            role: resolved.target.role,
            name: resolved.target.name,
            values: step.args.values,
            timeout,
        });
        if (!select.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(select.error) };
        }
        const mismatch = ensureSelected(select.data?.selected, step.args.values, {
            selector: resolved.target.selector,
            a11yHint: target.a11yHint,
        });
        if (mismatch) return mismatch;
        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.typeDelayMsRange.min,
                deps.config.humanPolicy.typeDelayMsRange.max,
            );
            if (delayMs > 0) await waitForHumanDelay(binding.page, delayMs);
        }
        return { stepId: step.id, ok: true };
    }

    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
    const visible = await ensureVisible(binding, resolved.target, timeout);
    if (!visible.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
    }
    const select = await binding.traceTools['trace.locator.selectOption']({
        a11yNodeId: resolved.target.a11yNodeId,
        selector: resolved.target.selector,
        role: resolved.target.role,
        name: resolved.target.name,
        values: step.args.values,
        timeout,
    });
    if (!select.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(select.error) };
    }
    const mismatch = ensureSelected(select.data?.selected, step.args.values, {
        target: resolved.target,
        a11yHint: target?.a11yHint,
    });
    if (mismatch) return mismatch;
    if (deps.config.humanPolicy.enabled) {
        const delayMs = pickDelayMs(
            deps.config.humanPolicy.typeDelayMsRange.min,
            deps.config.humanPolicy.typeDelayMsRange.max,
        );
        if (delayMs > 0) await waitForHumanDelay(binding.page, delayMs);
    }
    return { stepId: step.id, ok: true };
};
