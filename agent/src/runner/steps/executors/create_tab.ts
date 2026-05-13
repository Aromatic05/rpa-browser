import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';

const waitForWorkspaceTab = async (
    deps: RunStepsDeps,
    workspaceName: string,
    tabName: string,
    timeoutMs: number,
): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const workspace = deps.resolveWorkspace(workspaceName);
        if (workspace.tabs.hasTab(tabName)) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const workspace = deps.resolveWorkspace(workspaceName);
    return workspace.tabs.hasTab(tabName);
};

export const executeBrowserCreateTab = async (
    step: Step<'browser.create_tab'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const workspace = deps.resolveWorkspace(workspaceName);
    const page = await deps.pageRegistry.createPage();
    const bindingName = await deps.pageRegistry.bindPage(page);
    if (!bindingName) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_PAGE_BINDING_TIMEOUT',
                message: 'browser.create_tab failed to discover runtime tab id',
            },
        };
    }

    const boundTimeoutMs = deps.config?.waitPolicy?.pageReadyTimeoutMs || 3000;
    const existsAfterBound = workspace.tabs.hasTab(bindingName)
        || await waitForWorkspaceTab(deps, workspaceName, bindingName, boundTimeoutMs);
    if (!existsAfterBound) {
        workspace.tabs.createTab({ tabName: bindingName });
    }

    workspace.tabs.setActiveTab(bindingName);
    await deps.runtime.awaitExecutableTab({
        workspace,
        pageRegistry: deps.pageRegistry,
        tabName: bindingName,
        timeoutMs: boundTimeoutMs,
    });

    return { stepId: step.id, ok: true, data: { tab_id: bindingName } };
};
