import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTarget } from '../helpers/resolve_target';

const runWithHardTimeout = async (
    stepId: string,
    timeoutMs: number,
    task: () => Promise<StepResult>,
): Promise<StepResult> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return await task();
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
        if (timer) {clearTimeout(timer);}
    }
};

const runSelectorClick = async (input: {
    selector: string;
    step: Step<'browser.click'>;
    deps: RunStepsDeps;
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['ensureActivePage']>>;
    timeout: number;
}): Promise<StepResult> => {
    const { selector, step, deps, binding, timeout } = input;
    const visible = await binding.traceTools['trace.locator.waitForVisible']({ selector, timeout });
    if (!visible.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
    }

    const scrolled = await binding.traceTools['trace.locator.scrollIntoView']({ selector });
    if (!scrolled.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(scrolled.error) };
    }

    const count = step.args.options?.double ? 2 : 1;
    for (let i = 0; i < count; i += 1) {
        const click = await binding.traceTools['trace.locator.click']({
            selector,
            timeout,
            button: step.args.options?.button,
        });
        if (!click.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(click.error) };
        }

        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.clickDelayMsRange.min,
                deps.config.humanPolicy.clickDelayMsRange.max,
            );
            if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
        }
    }
    return { stepId: step.id, ok: true };
};

export const executeBrowserClick = async (
    step: Step<'browser.click'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const coord = step.args.coord;
    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
    const hardTimeoutMs = step.args.timeout ?? deps.config.waitPolicy.interactionTimeoutMs;

    return await runWithHardTimeout(step.id, hardTimeoutMs, async () => {
        if (coord) {
            if (step.args.nodeId || step.args.selector || step.args.resolveId || step.resolve) {
                return { stepId: step.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'coord and target are mutually exclusive' } };
            }
            const count = step.args.options?.double ? 2 : 1;
            for (let i = 0; i < count; i += 1) {
                const down = await binding.traceTools['trace.mouse.action']({
                    action: 'down',
                    x: coord.x,
                    y: coord.y,
                    button: step.args.options?.button,
                });
                if (!down.ok) {return { stepId: step.id, ok: false, error: mapTraceError(down.error) };}
                const up = await binding.traceTools['trace.mouse.action']({
                    action: 'up',
                    x: coord.x,
                    y: coord.y,
                    button: step.args.options?.button,
                });
                if (!up.ok) {return { stepId: step.id, ok: false, error: mapTraceError(up.error) };}
                if (deps.config.humanPolicy.enabled) {
                    const delayMs = pickDelayMs(
                        deps.config.humanPolicy.clickDelayMsRange.min,
                        deps.config.humanPolicy.clickDelayMsRange.max,
                    );
                    if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
                }
            }
            return { stepId: step.id, ok: true };
        }

        const resolved = await resolveTarget(binding, {
            nodeId: step.args.nodeId,
            selector: step.args.selector,
            resolve: step.resolve,
        });
        if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}

        return await runSelectorClick({
            selector: resolved.target.selector,
            step,
            deps,
            binding,
            timeout,
        });
    });
};
