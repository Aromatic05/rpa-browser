/**
 * browser.click Step 执行器：基于 a11yNodeId 进行可见性检查与点击。
 */

import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { findA11yNodeId } from '../helpers/a11y_hint';

export const executeBrowserClick = async (
    step: Step<'browser.click'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    let a11yNodeId = step.args.a11yNodeId;
    if (!a11yNodeId && step.args.a11yHint) {
        const deadline = Date.now() + (step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs);
        while (!a11yNodeId && Date.now() <= deadline) {
            const snapshot = await binding.traceTools['trace.page.snapshotA11y']();
            if (!snapshot.ok) {
                return { stepId: step.id, ok: false, error: snapshot.error };
            }
            const tree = JSON.parse(snapshot.data || '{}');
            a11yNodeId = findA11yNodeId(tree, step.args.a11yHint) || undefined;
            if (!a11yNodeId) {
                await binding.page.waitForTimeout(120);
            }
        }
    }
    if (!a11yNodeId) {
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_NOT_FOUND', message: 'a11y node not resolved' },
        };
    }
    if (deps.config.humanPolicy.enabled) {
        const min = deps.config.humanPolicy.clickDelayMsRange.min;
        const max = deps.config.humanPolicy.clickDelayMsRange.max;
        const delay = Math.max(min, Math.floor(Math.random() * (max - min + 1)) + min);
        await binding.page.waitForTimeout(delay);
    }
    const wait = await binding.traceTools['trace.locator.waitForVisible']({
        a11yNodeId,
        timeout: step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs,
    });
    if (!wait.ok) {
        return { stepId: step.id, ok: false, error: wait.error };
    }
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({
        a11yNodeId,
    });
    if (!scroll.ok) {
        return { stepId: step.id, ok: false, error: scroll.error };
    }
    const click = await binding.traceTools['trace.locator.click']({
        a11yNodeId,
        timeout: step.args.timeout,
    });
    if (!click.ok) {
        return { stepId: step.id, ok: false, error: click.error };
    }
    return { stepId: step.id, ok: true };
};
