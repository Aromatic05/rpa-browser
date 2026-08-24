import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps_types';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { executeAtomicHover } from '../../../snapshot';

export const executeBrowserHover = async (
    step: Step<'browser.hover'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const result = await executeAtomicHover(binding.page, {
        nodeId: step.args.nodeId ?? step.resolve?.hint?.target?.nodeId,
        selector: step.args.selector ?? step.resolve?.hint?.locator?.direct?.query,
    }, {
        timeoutMs: deps.config.waitPolicy.visibleTimeoutMs,
    });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: { code: result.code, message: result.message, details: result.details } };
    }
    if (deps.config.humanPolicy.enabled) {
        const delayMs = pickDelayMs(
            deps.config.humanPolicy.clickDelayMsRange.min,
            deps.config.humanPolicy.clickDelayMsRange.max,
        );
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return {
        stepId: step.id,
        ok: true,
        data: {
            nodeId: result.nodeId,
            controlRef: result.controlRef,
            captureRevision: result.captureRevision,
            resolver: 'snapshot-v2-canonical-locator',
        },
    };
};
