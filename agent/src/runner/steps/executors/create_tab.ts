import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { ACTION_TYPES } from '../../../actions/action_types';
import crypto from 'node:crypto';
import { mapTraceError } from '../helpers/target';

const findNewWorkspaceTab = async (
    deps: RunStepsDeps,
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

    const opened = await deps.dispatchAction({
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.TAB_OPEN,
        workspaceName,
        payload: {
            source: 'agent.step',
            at: Date.now(),
        },
        at: Date.now(),
    });
    if (opened.type.endsWith('.failed')) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: String((opened.payload as { code?: unknown })?.code || 'ERR_TAB_OPEN'),
                message: String((opened.payload as { message?: unknown })?.message || 'tab.open failed'),
            },
        };
    }

    const boundTimeoutMs = deps.config?.waitPolicy?.pageReadyTimeoutMs || 3000;
    const bindingName = await findNewWorkspaceTab(deps, workspace, knownTabNames, boundTimeoutMs);
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

    const binding = await deps.runtime.awaitExecutableTab({
        workspace,
        pageRegistry: deps.pageRegistry,
        tabName: bindingName,
        timeoutMs: boundTimeoutMs,
    });
    const traceCreate = await binding.traceTools['trace.tabs.create']({ workspaceName });
    if (!traceCreate.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(traceCreate.error) };
    }

    return { stepId: step.id, ok: true, data: { tab_id: bindingName } };
};
