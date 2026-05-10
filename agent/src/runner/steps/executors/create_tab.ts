import crypto from 'node:crypto';
import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';

export const executeBrowserCreateTab = async (
    step: Step<'browser.create_tab'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const workspace = deps.resolveWorkspace(workspaceName);
    const tabName = step.args.tabName || crypto.randomUUID();
    if (!workspace.tabs.hasTab(tabName)) {
        workspace.tabs.createMetadataTab({ tabName });
    }
    workspace.tabs.setActiveTab(tabName);
    await deps.runtime.createExecutableTab({
        workspace,
        pageRegistry: deps.pageRegistry,
        tabName,
    });
    return { stepId: step.id, ok: true, data: { tab_id: tabName } };
};
