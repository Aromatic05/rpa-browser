import type { Step, StepResult } from '../types';
import type { RunStepsDeps, RunStepsExecutionContext } from '../../run_steps_types';
import { recordedActionTarget } from '../helpers/recorded_action_target';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { executeAtomicType } from '../../../snapshot';

const pickDelayMs = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {return 0;}
    if (max <= min) {return Math.max(0, min);}
    return Math.floor(min + Math.random() * (max - min + 1));
};

export const executeBrowserType = async (
    step: Step<'browser.type'>,
    deps: RunStepsDeps,
    workspaceName: string,
    context?: RunStepsExecutionContext,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const target = recordedActionTarget(step, context);
    const result = await executeAtomicType(binding.page, target, step.args.text, {
        timeoutMs: deps.config.waitPolicy.visibleTimeoutMs,
        delayMs: deps.config.humanPolicy.enabled
            ? pickDelayMs(
                deps.config.humanPolicy.typeDelayMsRange.min,
                deps.config.humanPolicy.typeDelayMsRange.max,
            )
            : undefined,
    });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: { code: result.code, message: result.message, details: result.details } };
    }
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
