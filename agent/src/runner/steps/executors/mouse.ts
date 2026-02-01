import type { Step, StepResult } from './types';
import type { RunStepsDeps } from '../run_steps';
import { mapTraceError } from '../helpers/target';

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
    return { stepId: step.id, ok: true };
};
