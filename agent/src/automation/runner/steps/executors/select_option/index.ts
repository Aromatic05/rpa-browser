import { awaitPageBoundBinding } from '../../helpers/runtime_binding';
import { recordedActionTarget } from '../../helpers/recorded_action_target';
import type { Step, StepResult } from '../../types';
import type { RunStepsDeps, RunStepsExecutionContext } from '../../../run_steps';
import { executeSelectOptionOnPage } from '../../../../snapshot';

export const executeBrowserSelectOption = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
    context?: RunStepsExecutionContext,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const target = recordedActionTarget(binding.page, step, context);
    const result = await executeSelectOptionOnPage(binding.page, {
        kind: step.args.kind,
        values: step.args.values,
        nodeId: target.nodeId,
        selector: step.args.selector ?? (context?.recordingReplay && !target.nodeId ? target.selector : undefined),
    }, {
        timeoutMs: deps.config.waitPolicy.visibleTimeoutMs,
        getReplayCandidates: target.getReplayCandidates,
    });

    if (!result.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: result.code,
                message: result.message,
                details: result.details,
            },
        };
    }

    return {
        stepId: step.id,
        ok: true,
        data: {
            controlRef: result.controlRef,
            selectedValues: result.selectedValues,
            selectedLabels: result.selectedLabels,
            captureRevision: result.captureRevision,
            ...(result.replayFallback ? {resolver: 'recorded-target-fallback'} : {}),
        },
    };
};
