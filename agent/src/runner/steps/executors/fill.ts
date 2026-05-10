import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
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
    const binding = await awaitPageBoundBinding(deps, workspaceName);
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
    }, {
        deps,
        workspaceName,
        reason: 'browser.fill',
        stepId: step.id,
        stepName: step.name,
    });
    if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}

    const timeout = deps.config.waitPolicy.visibleTimeoutMs;
    const highlightBeforeActionMs = deps.config.waitPolicy.highlightBeforeActionMs;
    const attempts: ResolveAuditAttempt[] = [];
    let lastError: StepResult['error'] | undefined;

    for (let candidateIndex = 0; candidateIndex < resolved.target.candidates.length; candidateIndex += 1) {
        const candidate = resolved.target.candidates[candidateIndex];
        const visible = await binding.traceTools['trace.locator.waitForVisible']({ selector: candidate.selector, timeout });
        if (!visible.ok) {
            const error = mapTraceError(visible.error) || { code: 'ERR_INTERNAL', message: 'trace error' };
            lastError = error;
            pushAttempt(attempts, candidate, 'waitForVisible', false, { code: error.code, message: error.message });
            continue;
        }
        pushAttempt(attempts, candidate, 'waitForVisible', true);

        const scrolled = await binding.traceTools['trace.locator.scrollIntoView']({ selector: candidate.selector });
        if (!scrolled.ok) {
            const error = mapTraceError(scrolled.error) || { code: 'ERR_INTERNAL', message: 'trace error' };
            lastError = error;
            pushAttempt(attempts, candidate, 'scrollIntoView', false, { code: error.code, message: error.message });
            continue;
        }
        pushAttempt(attempts, candidate, 'scrollIntoView', true);

        const highlight = await binding.traceTools['trace.locator.highlight']({
            selector: candidate.selector,
            highlightMs: highlightBeforeActionMs,
            candidateIndex,
            stepId: step.id,
            stepName: step.name,
        });
        if (!highlight.ok) {
            const error = mapTraceError(highlight.error) || { code: 'ERR_INTERNAL', message: 'trace error' };
            lastError = error;
            pushAttempt(attempts, candidate, 'highlight', false, { code: error.code, message: error.message });
            continue;
        }
        pushAttempt(attempts, candidate, 'highlight', true);

        const focus = await binding.traceTools['trace.locator.focus']({ selector: candidate.selector });
        if (!focus.ok) {
            const error = mapTraceError(focus.error) || { code: 'ERR_INTERNAL', message: 'trace error' };
            lastError = error;
            pushAttempt(attempts, candidate, 'action', false, { code: error.code, message: error.message });
            continue;
        }

        const fill = await binding.traceTools['trace.locator.fill']({
            selector: candidate.selector,
            value: step.args.value,
        });
        if (!fill.ok) {
            const error = mapTraceError(fill.error) || { code: 'ERR_INTERNAL', message: 'trace error' };
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
                    snapshotRequired: resolved.target.resolution.audit.snapshotRequired,
                    snapshotRefreshed: resolved.target.resolution.audit.snapshotRefreshed,
                    snapshotRefreshReason: resolved.target.resolution.audit.snapshotRefreshReason,
                    snapshotId: resolved.target.resolution.audit.snapshotId,
                    snapshotUrl: resolved.target.resolution.audit.snapshotUrl,
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
                snapshotRequired: resolved.target.resolution.audit.snapshotRequired,
                snapshotRefreshed: resolved.target.resolution.audit.snapshotRefreshed,
                snapshotRefreshReason: resolved.target.resolution.audit.snapshotRefreshReason,
                snapshotId: resolved.target.resolution.audit.snapshotId,
                snapshotUrl: resolved.target.resolution.audit.snapshotUrl,
                chosenPath: resolved.target.resolution.path,
                finalSelector: resolved.target.selector,
                failedPath: attempts.length > 0 ? attempts[attempts.length - 1].path : undefined,
                failedReason: lastError?.message,
                attempts,
            },
        },
    };
};
