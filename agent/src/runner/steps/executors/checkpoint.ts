import type { Step, StepResult } from '../types';
import {
    executeStepWithRuntimeContracts,
    type RunLocalStepResults,
    type RunStepsDeps,
} from '../../run_steps';
import { listCheckpoints } from '../../checkpoint';
import { runCheckpointProcedure } from '../../checkpoint/runtime';
import type {StepResolve} from '../types';

export const executeBrowserCheckpoint = async (
    step: Step<'browser.checkpoint'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const workspace = deps.resolveWorkspace(workspaceName);
    const checkpointFacade = (workspace as Partial<typeof workspace>).checkpoint;
    const provider = checkpointFacade?.getProvider(workspace.workflow);
    const persistedCheckpoint = provider?.getCheckpoint(step.args.checkpointId) ?? null;
    const checkpoint = persistedCheckpoint
        ?? listCheckpoints().find((item) => item.id === step.args.checkpointId);
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
    const stepResolves: Record<string, StepResolve> = persistedCheckpoint
        ? provider?.getCheckpointResolves?.(step.args.checkpointId) ?? {}
        : {};
    const nestedResults: RunLocalStepResults = {};

    const output = await runCheckpointProcedure({
        checkpoint,
        input: step.args.input,
        stepIdPrefix: `checkpoint:${step.id}`,
        executeStep: async (nestedStep) => {
            const result = await executeStepWithRuntimeContracts(nestedStep, workspaceName, deps, {
                runLocalStepResults: nestedResults,
                stepResolves,
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
