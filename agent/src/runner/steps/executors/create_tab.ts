import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { ACTION_TYPES } from '../../../actions/action_types';
import crypto from 'node:crypto';

export const executeBrowserCreateTab = async (
    step: Step<'browser.create_tab'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const workspace = deps.resolveWorkspace(workspaceName);
    const tabName = step.args.tabName;
    if (!tabName) {
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_BAD_ARGS', message: 'browser.create_tab requires tabName' },
        };
    }
    const isNewTab = !workspace.tabs.hasTab(tabName);
    if (isNewTab) {
        const opened = await deps.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.TAB_OPENED,
            workspaceName,
            payload: {
                source: 'agent.step',
                tabName,
                url: '',
                at: Date.now(),
            },
            at: Date.now(),
        });
        if (opened.type.endsWith('.failed')) {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: String((opened.payload as { code?: unknown })?.code || 'ERR_TAB_OPENED'),
                    message: String((opened.payload as { message?: unknown })?.message || 'tab.opened failed'),
                },
            };
        }
    }
    workspace.tabs.setActiveTab(tabName);
    await deps.runtime.createExecutableTab({
        workspace,
        pageRegistry: deps.pageRegistry,
        tabName,
    });
    return { stepId: step.id, ok: true, data: { tab_id: tabName } };
};
