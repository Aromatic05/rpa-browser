import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { normalizeTarget, mapTraceError, matchesA11yHint } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { scoreA11yConfidence } from '../helpers/confidence';
import { resolveTargetNodeId, type ResolvedLocatorTarget } from '../helpers/resolve_target';
import { describeSelector } from '../helpers/selector';

const runWithHardTimeout = async (
    stepId: string,
    timeoutMs: number,
    task: () => Promise<StepResult>,
): Promise<StepResult> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return task();
    }
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            task(),
            new Promise<StepResult>((resolve) => {
                timer = setTimeout(() => {
                    resolve({
                        stepId,
                        ok: false,
                        error: {
                            code: 'ERR_TIMEOUT',
                            message: 'click step timeout',
                            details: { timeoutMs },
                        },
                    });
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

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

export const executeBrowserClick = async (
    step: Step<'browser.click'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const coord = step.args.coord;
    const options = step.args.options;
    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
    const hardTimeoutMs = step.args.timeout ?? deps.config.waitPolicy.interactionTimeoutMs;

    return runWithHardTimeout(step.id, hardTimeoutMs, async () => {
        if (coord) {
            if (step.args.target || step.args.id || step.args.selector || step.args.a11yNodeId || step.args.a11yHint) {
                return { stepId: step.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'coord and target are mutually exclusive' } };
            }
            const count = options?.double ? 2 : 1;
            for (let i = 0; i < count; i += 1) {
                const down = await binding.traceTools['trace.mouse.action']({
                    action: 'down',
                    x: coord.x,
                    y: coord.y,
                    button: options?.button,
                });
                if (!down.ok) return { stepId: step.id, ok: false, error: mapTraceError(down.error) };
                const up = await binding.traceTools['trace.mouse.action']({
                    action: 'up',
                    x: coord.x,
                    y: coord.y,
                    button: options?.button,
                });
                if (!up.ok) return { stepId: step.id, ok: false, error: mapTraceError(up.error) };
                if (deps.config.humanPolicy.enabled) {
                    const delayMs = pickDelayMs(
                        deps.config.humanPolicy.clickDelayMsRange.min,
                        deps.config.humanPolicy.clickDelayMsRange.max,
                    );
                    if (delayMs > 0) await waitForHumanDelay(binding.page, delayMs);
                }
            }
            return { stepId: step.id, ok: true };
        }

        const target = normalizeTarget(step.args);
        const resolved = await resolveTargetNodeId(binding, target, { stepId: step.id });
        if (!resolved.ok) return { stepId: step.id, ok: false, error: resolved.error };

        if (resolved.target.selector && target?.a11yHint) {
            const described = await describeSelector(binding.page, resolved.target.selector);
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
                                selector: resolved.target.selector,
                                hint: target.a11yHint,
                                candidate: described.data,
                                confidence: confidence.details,
                            },
                        },
                    };
                }
            }
            const visible = await binding.traceTools['trace.locator.waitForVisible']({
                selector: resolved.target.selector,
                timeout,
            });
            if (!visible.ok) {
                return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
            }
            const scrolled = await binding.traceTools['trace.locator.scrollIntoView']({
                selector: resolved.target.selector,
            });
            if (!scrolled.ok) {
                return { stepId: step.id, ok: false, error: mapTraceError(scrolled.error) };
            }
            const count = options?.double ? 2 : 1;
            for (let i = 0; i < count; i += 1) {
                const click = await binding.traceTools['trace.locator.click']({
                    selector: resolved.target.selector,
                    timeout,
                    button: options?.button,
                });
                if (!click.ok) {
                    return { stepId: step.id, ok: false, error: mapTraceError(click.error) };
                }
                if (deps.config.humanPolicy.enabled) {
                    const delayMs = pickDelayMs(
                        deps.config.humanPolicy.clickDelayMsRange.min,
                        deps.config.humanPolicy.clickDelayMsRange.max,
                    );
                    if (delayMs > 0) await waitForHumanDelay(binding.page, delayMs);
                }
            }
            return { stepId: step.id, ok: true };
        }

        const visible = await ensureVisible(binding, resolved.target, timeout);
        if (!visible.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
        }
        const count = options?.double ? 2 : 1;
        for (let i = 0; i < count; i += 1) {
            const click = await binding.traceTools['trace.locator.click']({
                a11yNodeId: resolved.target.a11yNodeId,
                selector: resolved.target.selector,
                role: resolved.target.role,
                name: resolved.target.name,
                timeout,
                button: options?.button,
            });
            if (!click.ok) {
                return { stepId: step.id, ok: false, error: mapTraceError(click.error) };
            }

            if (deps.config.humanPolicy.enabled) {
                const delayMs = pickDelayMs(
                    deps.config.humanPolicy.clickDelayMsRange.min,
                    deps.config.humanPolicy.clickDelayMsRange.max,
                );
                if (delayMs > 0) await waitForHumanDelay(binding.page, delayMs);
            }
        }
        return { stepId: step.id, ok: true };
    });
};
