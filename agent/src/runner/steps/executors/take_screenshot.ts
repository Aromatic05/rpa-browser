import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError, normalizeTarget } from '../helpers/target';
import { resolveTargetNodeId } from '../helpers/resolve_target';

export const executeBrowserTakeScreenshot = async (
    step: Step<'browser.take_screenshot'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const target = normalizeTarget(step.args);
    let nodeId: string | undefined;
    if (target) {
        const resolved = await resolveTargetNodeId(binding, target);
        if (!resolved.ok) return { stepId: step.id, ok: false, error: resolved.error };
        nodeId = resolved.nodeId;
    }
    const shot = await binding.traceTools['trace.page.screenshot']({
        fullPage: step.args.full_page,
        a11yNodeId: nodeId,
    });
    if (!shot.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(shot.error) };
    }
    return {
        stepId: step.id,
        ok: true,
        data: { mime: 'image/png', base64: shot.data },
    };
};
