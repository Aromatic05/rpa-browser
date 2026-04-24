import type { RunStatus, RunStepsDeps } from '../run_steps_types';
import type { FailedCtx } from '../failed_ctx';
import type { StepArgsMap, StepName, StepResult, StepUnion } from '../steps/types';
import type { EntityKind } from '../steps/executors/snapshot/core/types';

export type MatchRule =
    | { errorCode: string }
    | { stepName: StepName }
    | { urlIncludes: string }
    | { textVisible: string }
    | { entityExists: { query: string; kind?: EntityKind | EntityKind[]; businessTag?: string | string[] } };

export type Checkpoint = {
    id: string;
    kind?: 'procedure' | 'recovery' | 'guard';
    name?: string;
    input?: Record<string, unknown>;
    prepare?: CheckpointAction[];
    content?: Array<StepUnion | CheckpointAction>;
    output?: Record<string, CheckpointValue>;
    policy?: {
        trigger?: {
            matchRules?: MatchRule[];
        };
        maxAttempts?: number;
    };
    matchRules?: MatchRule[];
    enabled?: boolean;
    priority?: number;
    maxAttempts?: number;
};

export type CheckpointValue = unknown;

export type CheckpointActionBase = {
    saveAs?: string;
};

export type CheckpointAction =
    | (CheckpointActionBase & {
          type: 'snapshot';
          args?: StepArgsMap['browser.snapshot'];
      })
    | (CheckpointActionBase & {
          type: 'query';
          args: StepArgsMap['browser.query'];
      })
    | (CheckpointActionBase & {
          type: 'compute';
          args: StepArgsMap['browser.compute'];
      })
    | (CheckpointActionBase & {
          type: 'act';
          step: {
              name: Exclude<StepName, 'browser.checkpoint'>;
              args: unknown;
          };
      })
    | (CheckpointActionBase & {
          type: 'wait';
          args: {
              ms: number;
          };
      });

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

export type CheckpointScope = {
    input: Record<string, unknown>;
    local: Record<string, unknown>;
    output: Record<string, unknown>;
};

export type CheckpointProcedureOutput = {
    ok: boolean;
    output?: Record<string, unknown>;
    local?: Record<string, unknown>;
    error?: StepResult['error'];
};
