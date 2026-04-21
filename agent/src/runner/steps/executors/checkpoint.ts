import type { Step, StepResult, StepUnion } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { listCheckpoints } from '../../checkpoint';
import { runCheckpointProcedure } from '../../checkpoint/runtime';

export const executeBrowserCheckpoint = async (
    step: Step<'browser.checkpoint'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const checkpoint = listCheckpoints().find((item) => item.id === step.args.checkpointId);
    if (!checkpoint) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: `checkpoint not found: ${step.args.checkpointId}`,
            },
        };
    }

    const output = await runCheckpointProcedure({
        checkpoint,
        input: step.args.input,
        stepIdPrefix: `checkpoint:${step.id}`,
        executeStep: async (nestedStep) => {
            const fn = deps.pluginHost.getExecutors()[nestedStep.name];
            if (!fn) {
                return {
                    stepId: nestedStep.id,
                    ok: false,
                    error: {
                        code: 'ERR_NOT_FOUND',
                        message: `executor not found for step: ${nestedStep.name}`,
                    },
                };
            }
            return fn(nestedStep as StepUnion, deps, workspaceId);
        },
    });

    if (!output.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: output.error,
        };
    }

    return {
        stepId: step.id,
        ok: true,
        data: {
            checkpointId: checkpoint.id,
            output: output.output || {},
        },
    };
};
