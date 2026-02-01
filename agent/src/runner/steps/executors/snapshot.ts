/**
 * browser.snapshot Step 执行器：获取页面信息与 A11y 树。
 */

import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';

export const executeBrowserSnapshot = async (
    step: Step<'browser.snapshot'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const info = await binding.traceTools['trace.page.getInfo']();
    if (!info.ok) {
        return { stepId: step.id, ok: false, error: info.error };
    }
    const includeA11y = step.args.includeA11y !== false;
    let a11y: string | undefined;
    if (includeA11y) {
        const snapshot = await binding.traceTools['trace.page.snapshotA11y']();
        if (!snapshot.ok) {
            return { stepId: step.id, ok: false, error: snapshot.error };
        }
        a11y = snapshot.data || '';
    }
    return {
        stepId: step.id,
        ok: true,
        data: { url: info.data?.url, title: info.data?.title, a11y },
    };
};
