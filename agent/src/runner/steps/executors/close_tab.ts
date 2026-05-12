import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { ACTION_TYPES } from '../../../actions/action_types';
import crypto from 'node:crypto';

export const executeBrowserCloseTab = async (
    step: Step<'browser.close_tab'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const tabName = step.args.tabName;
    if (!tabName) {
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_BAD_ARGS', message: 'browser.close_tab requires tabName' },
        };
    }
    const closed = await deps.dispatchAction({
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.TAB_CLOSED,
        workspaceName,
        payload: {
            source: 'agent.step',
            tabName,
            at: Date.now(),
        },
        at: Date.now(),
    });
    if (closed.type.endsWith('.failed')) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: String((closed.payload as { code?: unknown })?.code || 'ERR_TAB_CLOSED'),
                message: String((closed.payload as { message?: unknown })?.message || 'tab.closed failed'),
            },
        };
    }
    return { stepId: step.id, ok: true };
};
