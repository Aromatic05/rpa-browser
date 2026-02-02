import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { normalizeTarget, mapTraceError } from '../helpers/target';
import { resolveTargetNodeId } from '../helpers/resolve_target';

const pickDelayMs = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    if (max <= min) return Math.max(0, min);
    return Math.floor(min + Math.random() * (max - min + 1));
};

const ensureVisible = async (
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['ensureActivePage']>>,
    nodeId: string,
    timeout?: number,
) => {
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ a11yNodeId: nodeId });
    if (!scroll.ok) return scroll;
    return binding.traceTools['trace.locator.waitForVisible']({ a11yNodeId: nodeId, timeout });
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

    if (coord) {
        if (step.args.target || step.args.a11yNodeId || step.args.a11yHint) {
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
                // console.log('Click delay ms:', delayMs);
                if (delayMs > 0) await binding.page.waitForTimeout(delayMs);
            }
        }
        return { stepId: step.id, ok: true };
    }

    const target = normalizeTarget(step.args);
    const resolved = await resolveTargetNodeId(binding, target);
    if (!resolved.ok) return { stepId: step.id, ok: false, error: resolved.error };

    const visible = await ensureVisible(binding, resolved.nodeId, timeout);
    if (!visible.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
    }
    const count = options?.double ? 2 : 1;
    for (let i = 0; i < count; i += 1) {
        const click = await binding.traceTools['trace.locator.click']({
            a11yNodeId: resolved.nodeId,
            timeout,
            button: options?.button,
        });
        if (!click.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(click.error) };
        }

        // console.log("Human Policy Enabled" , deps.config.humanPolicy.enabled);
        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.clickDelayMsRange.min,
                deps.config.humanPolicy.clickDelayMsRange.max,
            );
            // console.log('Click delay ms:', delayMs);
            if (delayMs > 0) await binding.page.waitForTimeout(delayMs);
        }
    }
    return { stepId: step.id, ok: true };
};
