import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';

export const executeBrowserCreateTab = async (
    step: Step<'browser.create_tab'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceName);
    const result = await binding.traceTools['trace.tabs.create']({
        workspaceName,
        url: step.args.url,
    });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
    }
    const tabName = result.data?.tabName;
    if (!tabName) {
        return { stepId: step.id, ok: false, error: { code: 'ERR_ASSERTION_FAILED', message: 'create_tab missing tabName' } };
    }
    const workspace = deps.resolveWorkspace(workspaceName);
    await deps.runtime.ensureExecutableTab({
        workspace,
        pageRegistry: deps.pageRegistry,
        tabName,
        urlHint: step.args.url,
    });
    return { stepId: step.id, ok: true, data: { tab_id: tabName } };
};
