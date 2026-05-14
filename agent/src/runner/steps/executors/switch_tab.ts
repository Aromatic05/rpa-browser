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
    if (!workspace.tabs.hasTab(tabName)) {
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_TAB_NOT_FOUND', message: `browser.switch_tab target tab not found: ${tabName}` },
        };
    }
    const timeoutMs = deps.config?.waitPolicy?.pageReadyTimeoutMs || 3000;
    const binding = await deps.runtime.awaitExecutableTab({
        workspace,
        pageRegistry: deps.pageRegistry,
        tabName,
        timeoutMs,
    });
    await binding.page.bringToFront();
    workspace.tabs.setActiveTab(tabName);
    return { stepId: step.id, ok: true };
};
