import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import crypto from 'node:crypto';
import { ACTION_TYPES } from '../../../actions/action_types';

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
        pageRegistry: workspace.browserSession.pageRegistry,
        tabName,
        timeoutMs,
    });
    await binding.page.bringToFront();
    workspace.tabs.setActiveTab(tabName);
    const activated = await deps.dispatchAction({
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.TAB_SET_ACTIVE,
        workspaceName,
        payload: { tabName, source: 'browser.switch_tab' },
        at: Date.now(),
    });
    if (activated.type.endsWith('.failed')) {
        const payload = activated.payload as { message?: unknown } | undefined;
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_TAB_SET_ACTIVE_FAILED', message: String(payload?.message || 'tab.setActive failed') },
        };
    }
    return { stepId: step.id, ok: true };
};
