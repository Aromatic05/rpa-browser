import crypto from 'node:crypto';
import type { RunStepsDeps } from '../../run_steps_types';
import type { ExecutionBinding } from '../../../runtime/execution/bindings';
import type { RuntimeWorkspace } from '../../../runtime/workspace/workspace';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const findLiveTab = (workspace: RuntimeWorkspace) => {
    const active = workspace.tabs.getActiveTab();
    if (active?.page && !active.page.isClosed()) {return active;}
    return workspace.tabs.listTabs().find((tab) => tab.page && !tab.page.isClosed()) || null;
};

const waitForLiveTab = async (workspace: RuntimeWorkspace, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const tab = findLiveTab(workspace);
        if (tab) {return tab;}
        await sleep(50);
    }
    return findLiveTab(workspace);
};

export const ensureWorkspaceActiveTab = async (
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<string> => {
    const workspace = deps.resolveWorkspace(workspaceName);
    const existing = findLiveTab(workspace);
    if (existing) {
        if (workspace.tabs.getActiveTab()?.name !== existing.name) {
            workspace.tabs.setActiveTab(existing.name);
        }
        return existing.name;
    }

    await workspace.browserSession.start();
    const bootstrapTimeoutMs = Math.max(deps.config.waitPolicy.pageReadyTimeoutMs, 3000);
    const startupTab = await waitForLiveTab(workspace, bootstrapTimeoutMs);
    if (startupTab) {
        if (workspace.tabs.getActiveTab()?.name !== startupTab.name) {
            workspace.tabs.setActiveTab(startupTab.name);
        }
        return startupTab.name;
    }

    const tabName = crypto.randomUUID();
    await deps.runtime.createExecutableTab({
        workspace,
        pageRegistry: workspace.browserSession.pageRegistry,
        tabName,
        startUrl: 'about:blank',
    });
    return tabName;
};

export const awaitPageBoundBinding = async (
    deps: RunStepsDeps,
    workspaceName: string,
    tabName?: string,
): Promise<ExecutionBinding> => {
    const workspace = deps.resolveWorkspace(workspaceName);
    const resolvedTabName = tabName || await ensureWorkspaceActiveTab(deps, workspaceName);
    await deps.runtime.awaitExecutableTab({
        workspace,
        pageRegistry: workspace.browserSession.pageRegistry,
        tabName: resolvedTabName,
        timeoutMs: deps.config.waitPolicy.pageReadyTimeoutMs,
    });
    const binding = await deps.runtime.resolveBinding(workspaceName, resolvedTabName);
    return binding;
};
