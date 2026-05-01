import type { RunStepsDeps } from './run_steps_types';
import type { Checkpoint } from './checkpoint/types';
import type { StepResult, StepUnion } from './steps/types';

export type FailedCtx = {
    runId: string;
    workspaceName: string;
    stepIndex: number;
    step: StepUnion;
    rawResult: StepResult;
    stopOnError: boolean;
    checkpointEnabled: boolean;
    checkpointAttempt: number;
    checkpointMaxAttempts: number;
    inCheckpointFlow: boolean;
    deps: RunStepsDeps;
    executeStep: (step: StepUnion) => Promise<StepResult>;
    checkpoints?: Checkpoint[];
    currentUrl?: string;
};

export const getFailedCtx = async (input: {
    runId: string;
    workspaceName: string;
    stepIndex: number;
    step: StepUnion;
    rawResult: StepResult;
    stopOnError: boolean;
    checkpointEnabled: boolean;
    checkpointAttempt: number;
    checkpointMaxAttempts: number;
    inCheckpointFlow: boolean;
    deps: RunStepsDeps;
    executeStep: (step: StepUnion) => Promise<StepResult>;
    checkpoints?: Checkpoint[];
}): Promise<FailedCtx> => {
    let currentUrl: string | undefined;
    try {
        const binding = await input.deps.runtime.resolveBinding(input.workspaceName);
        const info = await binding.traceTools['trace.page.getInfo']();
        if (info.ok) {
            currentUrl = info.data?.url;
        }
    } catch {
        // best effort only
    }

    return {
        runId: input.runId,
        workspaceName: input.workspaceName,
        stepIndex: input.stepIndex,
        step: input.step,
        rawResult: input.rawResult,
        stopOnError: input.stopOnError,
        checkpointEnabled: input.checkpointEnabled,
        checkpointAttempt: input.checkpointAttempt,
        checkpointMaxAttempts: input.checkpointMaxAttempts,
        inCheckpointFlow: input.inCheckpointFlow,
        deps: input.deps,
        executeStep: input.executeStep,
        checkpoints: input.checkpoints,
        currentUrl,
    };
};
