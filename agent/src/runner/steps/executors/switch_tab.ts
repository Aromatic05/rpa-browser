import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';

export const executeBrowserSwitchTab = async (
    step: Step<'browser.switch_tab'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const tabName = step.args.tabName || step.args.tabRef;
    if (!tabName) {
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_BAD_ARGS', message: 'browser.switch_tab requires tabName or tabRef' },
        };
    }
    const workspace = deps.resolveWorkspace(workspaceName);
    const binding = await deps.runtime.ensureExecutableTab({
        workspace,
        pageRegistry: deps.pageRegistry,
        tabName,
        urlHint: step.args.tabUrl,
    });
    const result = await binding.traceTools['trace.tabs.switch']({
        workspaceName,
        tabName,
    });
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(result.error) };
    }
    await deps.runtime.resolveBinding(workspaceName, tabName);
    return { stepId: step.id, ok: true };
};
