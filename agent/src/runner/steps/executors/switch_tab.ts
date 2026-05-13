import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';

export const executeBrowserSwitchTab = async (
    step: Step<'browser.switch_tab'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const tabName = step.args.tabName;
    if (!tabName) {
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_BAD_ARGS', message: 'browser.switch_tab requires tabName' },
        };
    }
    const workspace = deps.resolveWorkspace(workspaceName);
    workspace.tabs.setActiveTab(tabName);
    return { stepId: step.id, ok: true };
};
