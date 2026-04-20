import type { RunStatus, RunStepsDeps } from '../run_steps_types';
import type { FailedCtx } from '../failed_ctx';
import type { StepName, StepUnion, StepResult } from '../steps/types';
import type { EntityKind } from '../steps/executors/snapshot/core/types';

export type MatchRule =
    | { errorCode: string }
    | { stepName: StepName }
    | { urlIncludes: string }
    | { textVisible: string }
    | { entityExists: { query: string; kind?: EntityKind | EntityKind[]; businessTag?: string | string[] } };

export type Checkpoint = {
    id: string;
    name: string;
    matchRules: MatchRule[];
    content: StepUnion[];
    enabled?: boolean;
    priority?: number;
    maxAttempts?: number;
};

export type CheckpointStopReason =
    | 'checkpoint_not_entered'
    | 'checkpoint_not_found'
    | 'checkpoint_bind_failed'
    | 'checkpoint_step_failed'
    | 'checkpoint_assert_failed'
    | 'checkpoint_retry_failed'
    | 'checkpoint_completed';

export type CheckpointCtx = {
    failedCtx: FailedCtx;
    active: boolean;
    stopReason?: CheckpointStopReason;
    checkpoint?: Checkpoint;
    boundContent?: StepUnion[];
    runResult?: StepResult;
    retryResult?: StepResult;
    finalResult: StepResult;
    nextStatus?: RunStatus;
    meta?: Record<string, unknown>;
};

export type CheckpointMainOutput = {
    finalResult: StepResult;
    nextStatus?: RunStatus;
    meta?: Record<string, unknown>;
};

export type CheckpointMainDeps = {
    deps: RunStepsDeps;
};
