import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTarget, type ResolveAuditAttempt, type TargetCandidate } from '../helpers/resolve_target';
import { isValidStepResolve } from '../resolve_utils';

const runWithHardTimeout = async (
    stepId: string,
    timeoutMs: number,
    task: () => Promise<StepResult>,
): Promise<StepResult> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return await task();
    }
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            task(),
            new Promise<StepResult>((resolve) => {
                timer = setTimeout(() => {
                    resolve({
                        stepId,
                        ok: false,
                        error: {
                            code: 'ERR_TIMEOUT',
                            message: 'click step timeout',
                            details: { timeoutMs },
                        },
                    });
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) {clearTimeout(timer);}
    }
};

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

export const executeBrowserClick = async (
    step: Step<'browser.click'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceName);
    const coord = step.args.coord;
    const visibleTimeoutMs = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
    const pageReadyTimeoutMs = deps.config.waitPolicy.pageReadyTimeoutMs;
    const candidateClickTimeoutMs = deps.config.waitPolicy.candidateClickTimeoutMs;
    const hardTimeoutMs = step.args.timeout ?? deps.config.waitPolicy.interactionTimeoutMs;

    return await runWithHardTimeout(step.id, hardTimeoutMs, async () => {
        if (coord) {
            if (step.args.nodeId || step.args.selector || step.args.resolveId || step.resolve) {
                return { stepId: step.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'coord and target are mutually exclusive' } };
            }
            const count = step.args.options?.double ? 2 : 1;
            for (let i = 0; i < count; i += 1) {
                const down = await binding.traceTools['trace.mouse.action']({
                    action: 'down',
                    x: coord.x,
                    y: coord.y,
                    button: step.args.options?.button,
                });
                if (!down.ok) {return { stepId: step.id, ok: false, error: mapTraceError(down.error) };}
                const up = await binding.traceTools['trace.mouse.action']({
                    action: 'up',
                    x: coord.x,
                    y: coord.y,
                    button: step.args.options?.button,
                });
                if (!up.ok) {return { stepId: step.id, ok: false, error: mapTraceError(up.error) };}
                if (deps.config.humanPolicy.enabled) {
                    const delayMs = pickDelayMs(
                        deps.config.humanPolicy.clickDelayMsRange.min,
                        deps.config.humanPolicy.clickDelayMsRange.max,
                    );
                    if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
                }
            }
            return { stepId: step.id, ok: true };
        }

        const hasTarget = Boolean(step.args.nodeId || step.args.selector || step.args.resolveId || isValidStepResolve(step.resolve));
        if (!hasTarget) {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: 'ERR_BAD_ARGS',
                    message: 'browser.click requires coord or target selector/nodeId/resolve',
                },
            };
        }

        const resolved = await resolveTarget(binding, {
            nodeId: step.args.nodeId,
            selector: step.args.selector,
            resolve: step.resolve,
        }, {
            deps,
            workspaceName,
            reason: 'browser.click',
            stepId: step.id,
            stepName: step.name,
        });
        if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}

        const attempts: ResolveAuditAttempt[] = [];
        let lastError: StepResult['error'] | undefined;
        const pageReadyTargetState: 'domcontentloaded' | 'load' = 'domcontentloaded';
        const pageReadyStartAt = Date.now();
        try {
            await binding.page.waitForLoadState(pageReadyTargetState, { timeout: pageReadyTimeoutMs });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: 'ERR_PAGE_NOT_READY',
                    message: `page readiness wait failed: ${pageReadyTargetState}`,
                    details: {
                        targetLoadState: pageReadyTargetState,
                        pageReadyTimeoutMs,
                        pageReadyWaitMs: Date.now() - pageReadyStartAt,
                        reason,
                    },
                },
            };
        }
        const pageReadyWaitMs = Date.now() - pageReadyStartAt;
        const loadStateBeforeClick = await binding.page.evaluate(() => {
            const state = document.readyState;
            return state === 'complete' ? 'load' : 'domcontentloaded';
        }) as 'domcontentloaded' | 'load';

        for (let candidateIndex = 0; candidateIndex < resolved.target.candidates.length; candidateIndex += 1) {
            const candidate = resolved.target.candidates[candidateIndex];
            const visible = await binding.traceTools['trace.locator.waitForVisible']({ selector: candidate.selector, timeout: visibleTimeoutMs });
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

            const count = step.args.options?.double ? 2 : 1;
            let actionError: StepResult['error'] | undefined;
            for (let i = 0; i < count; i += 1) {
                const click = await binding.traceTools['trace.locator.click']({
                    selector: candidate.selector,
                    timeout: candidateClickTimeoutMs,
                    button: step.args.options?.button,
                    candidateIndex,
                    candidateTimeoutMs: candidateClickTimeoutMs,
                    loadStateBeforeClick,
                    pageReadyWaitMs,
                });
                if (!click.ok) {
                    const error = mapTraceError(click.error) || { code: 'ERR_INTERNAL', message: 'trace error' };
                    actionError = error;
                    pushAttempt(attempts, candidate, 'action', false, { code: error.code, message: error.message });
                    break;
                }
                pushAttempt(attempts, candidate, 'action', true);
                if (deps.config.humanPolicy.enabled) {
                    const delayMs = pickDelayMs(
                        deps.config.humanPolicy.clickDelayMsRange.min,
                        deps.config.humanPolicy.clickDelayMsRange.max,
                    );
                    if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
                }
            }
            if (actionError) {
                lastError = actionError;
                continue;
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
                ...(lastError || { code: 'ERR_NOT_FOUND', message: 'no target candidate matched' }),
                    details: {
                    ...((lastError?.details as Record<string, unknown>) || {}),
                    pageReadyWaitMs,
                    loadStateBeforeClick,
                    candidateClickTimeoutMs,
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
    });
};
