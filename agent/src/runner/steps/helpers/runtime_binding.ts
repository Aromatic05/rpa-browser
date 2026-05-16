import type { RunStepsDeps } from '../../run_steps';
import type { ExecutionBinding } from '../../../runtime/execution/bindings';

export const awaitPageBoundBinding = async (
    deps: RunStepsDeps,
    workspaceName: string,
    tabName?: string,
): Promise<ExecutionBinding> => {
    const workspace = deps.resolveWorkspace(workspaceName);
    const resolvedTabName = tabName || workspace.tabs.getActiveTab()?.name;
    if (!resolvedTabName) {
        throw new Error(`active tab not found: ${workspaceName}`);
    }
    await deps.runtime.awaitExecutableTab({
        workspace,
        pageRegistry: workspace.browserSession.pageRegistry,
        tabName: resolvedTabName,
        timeoutMs: deps.config.waitPolicy.pageReadyTimeoutMs,
    });
    const binding = await deps.runtime.resolveBinding(workspaceName, resolvedTabName);
    await binding.page.bringToFront().catch(() => undefined);
    return binding;
};
