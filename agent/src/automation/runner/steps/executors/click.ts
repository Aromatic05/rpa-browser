import type { Step, StepResult } from '../types';
import type { RunStepsDeps, RunStepsExecutionContext } from '../../run_steps_types';
import { recordedActionTarget } from '../helpers/recorded_action_target';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { executeAtomicClick, type AtomicActionSuccess } from '../../../snapshot';

export const executeBrowserClick = async (
    step: Step<'browser.click'>,
    deps: RunStepsDeps,
    workspaceName: string,
    context?: RunStepsExecutionContext,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const target = recordedActionTarget(step, context);
    if (!target.nodeId && !target.selector && target.framePath === undefined) {
        return failed(step.id, 'ERR_BAD_ARGS', 'browser.click requires an exact nodeId or selector');
    }

    try {
        await binding.page.waitForLoadState('domcontentloaded', {
            timeout: deps.config.waitPolicy.pageReadyTimeoutMs,
        });
    } catch (error) {
        return failed(step.id, 'ERR_PAGE_NOT_READY', 'page readiness wait failed: domcontentloaded', {
            reason: error instanceof Error ? error.message : String(error),
        });
    }

    const result = await executeAtomicClick(binding.page, target, {
        timeoutMs: deps.config.waitPolicy.candidateClickTimeoutMs,
        button: step.args.options?.button,
        double: step.args.options?.double,
    });
    if (!result.ok) {return failed(step.id, result.code, result.message, result.details);}

    if (deps.config.humanPolicy.enabled) {
        const delayMs = pickDelayMs(
            deps.config.humanPolicy.clickDelayMsRange.min,
            deps.config.humanPolicy.clickDelayMsRange.max,
        );
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return success(step.id, result);
};

const success = (stepId: string, result: AtomicActionSuccess): StepResult => ({
    stepId,
    ok: true,
    data: {
        nodeId: result.nodeId,
        controlRef: result.controlRef,
        captureRevision: result.captureRevision,
        resolver: result.replayFallback ? 'recorded-target-fallback' : 'snapshot-v2-canonical-locator',
    },
});

const failed = (stepId: string, code: string, message: string, details?: unknown): StepResult => ({
    stepId,
    ok: false,
    error: { code, message, details },
});
