import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTarget, type ResolveAuditAttempt, type TargetCandidate } from '../helpers/resolve_target';
import { isValidStepResolve } from '../resolve_utils';

const pushAttempt = (
    attempts: ResolveAuditAttempt[],
    candidate: TargetCandidate,
    stage: ResolveAuditAttempt['stage'],
    ok: boolean,
    error?: { code?: string; message?: string },
) => {
    attempts.push({
        path: candidate.path,
        selector: candidate.selector,
        source: candidate.source,
        confidence: candidate.confidence,
        ok,
        stage,
        errorCode: error?.code,
        errorMessage: error?.message,
    });
};

export const executeBrowserFill = async (
    step: Step<'browser.fill'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceName);
    const hasTarget = Boolean(step.args.nodeId || step.args.selector || step.args.resolveId || isValidStepResolve(step.resolve));
    if (!hasTarget) {
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_BAD_ARGS', message: 'browser.fill requires target selector/nodeId/resolve' },
        };
    }

    const resolved = await resolveTarget(binding, {
        nodeId: step.args.nodeId,
        selector: step.args.selector,
        resolve: step.resolve,
    });
    if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}

    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
    const attempts: ResolveAuditAttempt[] = [];
    let lastError: StepResult['error'] | undefined;

    for (const candidate of resolved.target.candidates) {
        const visible = await binding.traceTools['trace.locator.waitForVisible']({ selector: candidate.selector, timeout });
        if (!visible.ok) {
            const error = mapTraceError(visible.error);
            lastError = error;
            pushAttempt(attempts, candidate, 'waitForVisible', false, { code: error.code, message: error.message });
            continue;
        }
        pushAttempt(attempts, candidate, 'waitForVisible', true);

        const scrolled = await binding.traceTools['trace.locator.scrollIntoView']({ selector: candidate.selector });
        if (!scrolled.ok) {
            const error = mapTraceError(scrolled.error);
            lastError = error;
            pushAttempt(attempts, candidate, 'scrollIntoView', false, { code: error.code, message: error.message });
            continue;
        }
        pushAttempt(attempts, candidate, 'scrollIntoView', true);

        const focus = await binding.traceTools['trace.locator.focus']({ selector: candidate.selector });
        if (!focus.ok) {
            const error = mapTraceError(focus.error);
            lastError = error;
            pushAttempt(attempts, candidate, 'action', false, { code: error.code, message: error.message });
            continue;
        }

        const fill = await binding.traceTools['trace.locator.fill']({
            selector: candidate.selector,
            value: step.args.value,
        });
        if (!fill.ok) {
            const error = mapTraceError(fill.error);
            lastError = error;
            pushAttempt(attempts, candidate, 'action', false, { code: error.code, message: error.message });
            continue;
        }
        pushAttempt(attempts, candidate, 'action', true);

        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.typeDelayMsRange.min,
                deps.config.humanPolicy.typeDelayMsRange.max,
            );
            if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
        }
        return {
            stepId: step.id,
            ok: true,
            data: {
                audit: {
                    confidence: resolved.target.resolution.audit.confidence,
                    warnings: resolved.target.resolution.audit.warnings,
                    chosenPath: candidate.path,
                    finalSelector: candidate.selector,
                    attempts,
                },
            },
        };
    }

    return {
        stepId: step.id,
        ok: false,
        error: {
            ...(lastError || { code: 'ERR_NOT_FOUND', message: 'no fill target candidate matched' }),
            details: {
                ...((lastError?.details as Record<string, unknown>) || {}),
                confidence: resolved.target.resolution.audit.confidence,
                warnings: resolved.target.resolution.audit.warnings,
                chosenPath: resolved.target.resolution.path,
                finalSelector: resolved.target.selector,
                failedPath: attempts.length > 0 ? attempts[attempts.length - 1].path : undefined,
                failedReason: lastError?.message,
                attempts,
            },
        },
    };
};
