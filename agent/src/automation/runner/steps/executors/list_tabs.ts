import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';

export const executeBrowserListTabs = async (
    step: Step<'browser.list_tabs'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const workspace = deps.resolveWorkspace(workspaceName);
    const activeTabName = workspace.tabs.getActiveTab()?.name;
    return {
        stepId: step.id,
        ok: true,
        data: {
            tab_id: activeTabName,
            tabs: workspace.tabs.listTabs().filter((tab) => tab.page && !tab.page.isClosed()).map((tab) => ({
                tabName: tab.name,
                url: tab.url,
                title: tab.title,
                active: tab.name === activeTabName,
            })),
        },
    };
};
