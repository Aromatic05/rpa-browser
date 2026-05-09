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

export const executeBrowserScroll = async (
    step: Step<'browser.scroll'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceName);
    const hasTarget = Boolean(step.args.nodeId || step.args.selector || step.args.resolveId || isValidStepResolve(step.resolve));
    if (hasTarget) {
        const resolved = await resolveTarget(binding, {
            nodeId: step.args.nodeId,
            selector: step.args.selector,
            resolve: step.resolve,
        }, {
            deps,
            workspaceName,
            reason: 'browser.scroll',
            stepId: step.id,
            stepName: step.name,
        });
        if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}

        const highlightBeforeActionMs = deps.config.waitPolicy.highlightBeforeActionMs;
        const attempts: ResolveAuditAttempt[] = [];
        let lastError: StepResult['error'] | undefined;
        for (let candidateIndex = 0; candidateIndex < resolved.target.candidates.length; candidateIndex += 1) {
            const candidate = resolved.target.candidates[candidateIndex];
            const highlight = await binding.traceTools['trace.locator.highlight']({
                selector: candidate.selector,
                highlightMs: highlightBeforeActionMs,
                candidateIndex,
                stepId: step.id,
                stepName: step.name,
            });
            if (!highlight.ok) {
                const error = mapTraceError(highlight.error);
                lastError = error;
                pushAttempt(attempts, candidate, 'highlight', false, { code: error.code, message: error.message });
                continue;
            }
            pushAttempt(attempts, candidate, 'highlight', true);
            const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ selector: candidate.selector });
            if (!scroll.ok) {
                const error = mapTraceError(scroll.error);
                lastError = error;
                pushAttempt(attempts, candidate, 'scrollIntoView', false, { code: error.code, message: error.message });
                continue;
            }
            pushAttempt(attempts, candidate, 'scrollIntoView', true);
            if (deps.config.humanPolicy.enabled) {
                const delayMs = pickDelayMs(
                    deps.config.humanPolicy.scrollDelayMsRange.min,
                    deps.config.humanPolicy.scrollDelayMsRange.max,
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
                ...(lastError || { code: 'ERR_NOT_FOUND', message: 'no scroll target candidate matched' }),
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
    }

    const amount = step.args.amount ?? 600;
    const direction = step.args.direction ?? 'down';
    const total = Math.max(0, Math.abs(amount));
    const steps = Math.min(14, Math.max(6, Math.ceil(total / 250)));
    const perStep = steps > 0 ? Math.floor(total / steps) : total;
    let remaining = total;
    for (let i = 0; i < steps; i += 1) {
        const delta = i === steps - 1 ? remaining : perStep;
        remaining -= delta;
        if (delta <= 0) {continue;}
        const scrolled = await binding.traceTools['trace.page.scrollBy']({ direction, amount: delta });
        if (!scrolled.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(scrolled.error) };
        }
        const delayMs = deps.config.humanPolicy.enabled
            ? pickDelayMs(
                  deps.config.humanPolicy.scrollDelayMsRange.min,
                  deps.config.humanPolicy.scrollDelayMsRange.max,
              )
            : 16;
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return { stepId: step.id, ok: true };
};
