import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';

export const executeBrowserQuery = async (
    step: Step<'browser.query'>,
    _deps: RunStepsDeps,
    _workspaceId: string,
): Promise<StepResult> => {
    return {
        stepId: step.id,
        ok: false,
        error: {
            code: 'ERR_NOT_IMPLEMENTED',
            message: 'browser.query is not implemented yet',
        },
    };
};
