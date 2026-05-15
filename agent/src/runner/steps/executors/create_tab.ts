import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';

const findNewWorkspaceTab = async (
    workspace: ReturnType<RunStepsDeps['resolveWorkspace']>,
    knownTabNames: Set<string>,
    timeoutMs: number,
): Promise<string | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const tabs = workspace.tabs.listTabs();
        const created = tabs.find((tab) => !knownTabNames.has(tab.name));
        if (created?.name) {
            return created.name;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const tabs = workspace.tabs.listTabs();
    const created = tabs.find((tab) => !knownTabNames.has(tab.name));
    return created?.name || null;
};

export const executeBrowserCreateTab = async (
    step: Step<'browser.create_tab'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const workspace = deps.resolveWorkspace(workspaceName);
    const knownTabNames = new Set(workspace.tabs.listTabs().map((tab) => tab.name));
    const activeTabName = workspace.tabs.getActiveTab()?.name;
    if (!activeTabName) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_TAB_NOT_FOUND',
                message: 'browser.create_tab requires an active tab to drive trace tab creation',
            },
        };
    }

    const boundTimeoutMs = deps.config?.waitPolicy?.pageReadyTimeoutMs || 3000;
    const activeBinding = await deps.runtime.awaitExecutableTab({
        workspace,
        pageRegistry: workspace.browserSession.pageRegistry,
        tabName: activeTabName,
        timeoutMs: boundTimeoutMs,
    });
    const traceCreate = await activeBinding.traceTools['trace.tabs.create']({ workspaceName, timeout: boundTimeoutMs });
    if (!traceCreate.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(traceCreate.error) };
    }

    const createdTabName = await findNewWorkspaceTab(workspace, knownTabNames, boundTimeoutMs);
    if (!createdTabName) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_PAGE_BINDING_TIMEOUT',
                message: 'browser.create_tab failed to discover runtime tab id',
            },
        };
    }

    // CRITICAL CONTRACT:
    // browser.create_tab returns data.tabName as the runtime-created tab identity.
    // Replay/recording must treat this field as create-result output (binding target), not input args.
    return { stepId: step.id, ok: true, data: { tabName: createdTabName } };
};
