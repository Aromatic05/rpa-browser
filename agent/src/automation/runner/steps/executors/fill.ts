import type { Page } from 'playwright';
import type { Step, StepResult } from '../types';
import type { RunStepsDeps, RunStepsExecutionContext } from '../../run_steps_types';
import { recordedActionTarget } from '../helpers/recorded_action_target';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { executeAtomicFill } from '../../../snapshot';

export const executeBrowserFill = async (
    step: Step<'browser.fill'>,
    deps: RunStepsDeps,
    workspaceName: string,
    context?: RunStepsExecutionContext,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const target = recordedActionTarget(binding.page, step, context);
    const result = await executeAtomicFill(binding.page, target, step.args.value, {
        timeoutMs: deps.config.waitPolicy.visibleTimeoutMs,
    });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: { code: result.code, message: result.message, details: result.details } };
    }
    await humanDelay(binding.page, deps);
    return {
        stepId: step.id,
        ok: true,
        data: {
            nodeId: result.nodeId,
            controlRef: result.controlRef,
            captureRevision: result.captureRevision,
            resolver: result.replayFallback ? 'recorded-target-fallback' : 'snapshot-v2-canonical-locator',
        },
    };
};

const humanDelay = async (page: Page, deps: RunStepsDeps): Promise<void> => {
    if (!deps.config.humanPolicy.enabled) {return;}
    const delayMs = pickDelayMs(
        deps.config.humanPolicy.typeDelayMsRange.min,
        deps.config.humanPolicy.typeDelayMsRange.max,
    );
    if (delayMs > 0) {await waitForHumanDelay(page, delayMs);}
};
