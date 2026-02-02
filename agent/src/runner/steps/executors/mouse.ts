import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';

const pickDelayMs = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    if (max <= min) return Math.max(0, min);
    return Math.floor(min + Math.random() * (max - min + 1));
};

export const executeBrowserMouse = async (
    step: Step<'browser.mouse'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    if (step.args.action === 'wheel' && typeof step.args.deltaY !== 'number') {
        return { stepId: step.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'mouse wheel requires deltaY' } };
    }
    const result = await binding.traceTools['trace.mouse.action']({
        action: step.args.action,
        x: step.args.x,
        y: step.args.y,
        deltaY: step.args.deltaY,
        button: step.args.button,
    });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
    }
    if (deps.config.humanPolicy.enabled) {
        const range =
            step.args.action === 'wheel'
                ? deps.config.humanPolicy.scrollDelayMsRange
                : deps.config.humanPolicy.clickDelayMsRange;
        const delayMs = pickDelayMs(range.min, range.max);
        if (delayMs > 0) await binding.page.waitForTimeout(delayMs);
    }
    return { stepId: step.id, ok: true };
};
