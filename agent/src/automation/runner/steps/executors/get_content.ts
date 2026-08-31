import type {Step, StepResult} from '../types';
import type {RunStepsDeps, RunStepsExecutionContext} from '../../run_steps';
import {ensureFreshPageSession} from '../../session/capture';
import {resolveSnapshotContentRef} from '../../../snapshot/projection';

export const executeBrowserGetContent = async (
    step: Step<'browser.get_content'>,
    deps: RunStepsDeps,
    workspaceName: string,
    context?: RunStepsExecutionContext,
): Promise<StepResult> => {
    const {entry} = await ensureFreshPageSession(deps, workspaceName, {entityRulesProvider: context?.entityRulesProvider});
    const resolved = resolveSnapshotContentRef(entry, step.args.ref);
    if (!resolved.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: {code: resolved.code, message: resolved.message, details: {ref: step.args.ref}},
        };
    }
    return {
        stepId: step.id,
        ok: true,
        data: {ref: step.args.ref, nodeId: resolved.nodeId, content: resolved.content},
    };
};
