import type { Step, StepResult } from '../types';
import {
    executeStepWithRuntimeContracts,
    type RunLocalStepResults,
    type RunStepsDeps,
    type RunStepsExecutionContext,
} from '../../run_steps';
import { runCheckpointProcedure } from '../../checkpoint/runtime';
import type {StepResolve} from '../types';

export const executeBrowserCheckpoint = async (
    step: Step<'browser.checkpoint'>,
    deps: RunStepsDeps,
    workspaceName: string,
    context?: RunStepsExecutionContext,
): Promise<StepResult> => {
    const provider = context?.checkpointProvider;
    if (!provider) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_CHECKPOINT_PROVIDER_UNAVAILABLE',
                message: `checkpoint provider unavailable for step: ${step.id}`,
            },
        };
    }
    const checkpoint = provider.getCheckpoint(step.args.checkpointId);
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
    if (checkpoint.kind && checkpoint.kind !== 'procedure') {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_CHECKPOINT_NOT_CALLABLE',
                message: `checkpoint is not callable: ${step.args.checkpointId}`,
            },
        };
    }
    const stepResolves: Record<string, StepResolve> = provider.getCheckpointResolves?.(step.args.checkpointId) ?? {};
    const nestedResults: RunLocalStepResults = {};

    const output = await runCheckpointProcedure({
        checkpoint,
        input: step.args.input,
        stepIdPrefix: `checkpoint:${step.id}`,
        executeStep: async (nestedStep) => {
            const result = await executeStepWithRuntimeContracts(nestedStep, workspaceName, deps, {
                runLocalStepResults: nestedResults,
                stepResolves,
                checkpointProvider: provider,
            });
            nestedResults[result.stepId] = {
                ok: result.ok,
                data: result.data,
                error: result.error,
            };
            return result;
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
