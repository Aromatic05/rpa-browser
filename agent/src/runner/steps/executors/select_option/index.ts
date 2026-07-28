import { awaitPageBoundBinding } from '../../helpers/runtime_binding';
import type { Step, StepResult } from '../../types';
import type { RunStepsDeps } from '../../../run_steps';
import { executeSelectOptionOnPage } from '../../../../snapshot';

export const executeBrowserSelectOption = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const result = await executeSelectOptionOnPage(binding.page, {
        kind: step.args.kind,
        values: step.args.values,
        nodeId: step.args.nodeId ?? step.resolve?.hint?.target?.nodeId,
        selector: step.args.selector,
    }, {
        timeoutMs: deps.config.waitPolicy.visibleTimeoutMs,
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
        },
    };
};
