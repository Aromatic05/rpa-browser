import type {RunStepsDeps, RunStepsExecutionContext} from '../../run_steps';
import {ensureFreshPageSession, queryPageSessionEntry} from '../../session';
import type {Step, StepResult} from '../types';

export const executeBrowserQuery = async (
    step: Step<'browser.query'>,
    deps: RunStepsDeps,
    workspaceName: string,
    context?: RunStepsExecutionContext,
): Promise<StepResult> => {
    const {entry} = await ensureFreshPageSession(
        deps,
        workspaceName,
        step.entityRules || 'op' in step.args
            ? {explicit: true, entityRules: step.entityRules, entityRulesProvider: context?.entityRulesProvider}
            : {entityRulesProvider: context?.entityRulesProvider},
    );
    const result = queryPageSessionEntry(entry, step.args);
    return result.ok
        ? {stepId: step.id, ok: true, data: result.data}
        : {stepId: step.id, ok: false, error: result.error};
};
