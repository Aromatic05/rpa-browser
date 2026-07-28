import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps_types';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveAtomicActionTarget } from '../../../snapshot';

export const executeBrowserScroll = async (
    step: Step<'browser.scroll'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const target = {
        nodeId: step.args.nodeId ?? step.resolve?.hint?.target?.nodeId,
        selector: step.args.selector ?? step.resolve?.hint?.locator?.direct?.query,
    };
    if (target.nodeId || target.selector) {
        const resolved = await resolveAtomicActionTarget(binding.page, target);
        if (!resolved.ok) {
            return { stepId: step.id, ok: false, error: {
                code: resolved.error.code,
                message: resolved.error.message,
                details: resolved.error.details,
            } };
        }
        try {
            await resolved.target.locator.scrollIntoViewIfNeeded({
                timeout: deps.config.waitPolicy.visibleTimeoutMs,
            });
        } catch (error) {
            return { stepId: step.id, ok: false, error: {
                code: /timeout/i.test(String(error)) ? 'ERR_TIMEOUT' : 'ERR_INTERNAL',
                message: error instanceof Error ? error.message : String(error),
            } };
        }
        await humanDelay(binding.page, deps);
        return {
            stepId: step.id,
            ok: true,
            data: {
                nodeId: resolved.target.nodeId,
                controlRef: resolved.target.control?.ref,
                captureRevision: resolved.target.snapshot.observation.identity.captureRevision,
                resolver: 'snapshot-v2-canonical-locator',
            },
        };
    }

    const amount = Math.max(0, Math.abs(step.args.amount ?? 600));
    const direction = step.args.direction ?? 'down';
    const sign = direction === 'up' ? -1 : 1;
    const steps = Math.min(14, Math.max(1, Math.ceil(amount / 250)));
    let remaining = amount;
    for (let index = 0; index < steps; index += 1) {
        const delta = index === steps - 1 ? remaining : Math.floor(amount / steps);
        remaining -= delta;
        if (delta <= 0) {continue;}
        await binding.page.evaluate((value) => window.scrollBy(0, value), sign * delta);
        const delayMs = deps.config.humanPolicy.enabled
            ? pickDelayMs(
                deps.config.humanPolicy.scrollDelayMsRange.min,
                deps.config.humanPolicy.scrollDelayMsRange.max,
            )
            : 16;
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return { stepId: step.id, ok: true, data: { resolver: 'page-scroll' } };
};

const humanDelay = async (page: import('playwright').Page, deps: RunStepsDeps) => {
    if (!deps.config.humanPolicy.enabled) {return;}
    const delayMs = pickDelayMs(
        deps.config.humanPolicy.scrollDelayMsRange.min,
        deps.config.humanPolicy.scrollDelayMsRange.max,
    );
    if (delayMs > 0) {await waitForHumanDelay(page, delayMs);}
};
