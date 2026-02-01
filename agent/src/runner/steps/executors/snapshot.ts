import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';

export const executeBrowserSnapshot = async (
    step: Step<'browser.snapshot'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const includeA11y = step.args.includeA11y !== false;
    const focusOnly = step.args.focus_only === true;
    const info = await binding.traceTools['trace.page.getInfo']();
    if (!info.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(info.error) };
    }
    const snapshot = await binding.traceTools['trace.page.snapshotA11y']({
        includeA11y,
        focusOnly,
    });
    if (!snapshot.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(snapshot.error) };
    }
    return {
        stepId: step.id,
        ok: true,
        data: {
            snapshot_id: snapshot.data?.snapshotId,
            url: info.data?.url,
            title: info.data?.title,
            a11y: snapshot.data?.a11y,
        },
    };
};
