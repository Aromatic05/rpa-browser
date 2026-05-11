import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';

export const executeBrowserCloseTab = async (
    step: Step<'browser.close_tab'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const tabName = step.args.tabName;
    if (!tabName) {
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_BAD_ARGS', message: 'browser.close_tab requires tabName' },
        };
    }
    const workspace = deps.resolveWorkspace(workspaceName);
    await deps.pageRegistry.closePage(tabName);
    await workspace.tabs.closeTab(tabName);
    return { stepId: step.id, ok: true };
};
