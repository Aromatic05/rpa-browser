import type { RunStatus } from '../../run_steps_types';
import type { StepEntityRulesControl } from '../../../snapshot/rules/model';
import type { CheckpointRuntimeSnapshot } from '../runtime_snapshot';
import type { Checkpoint, CheckpointStopReason } from '../types';
import type { EntityKind, StepResolve, StepResult, StepUnion } from '../../steps/types';
import type { DslDebugPort } from '../../../dsl/debug/contracts';

/**
 * Structured failed-step context consumed by the shared recovery selection and
 * execution service. Both the ordinary runner (from FailedCtx) and the retained
 * Agent path (from a paused DSL failure) build one of these, so the same
 * matcher/execution semantics apply.
 */
export type RecoveryFailureContext = {
    runId: string;
    workspaceName: string;
    stepId: string;
    stepName: string;
    args?: unknown;
    error?: Readonly<{ code?: string; message?: string; details?: unknown }>;
    currentUrl?: string;
    /** Full step required only when the original step must be retried. */
    step?: StepUnion;
};

/**
 * Page/world query capability used to evaluate urlIncludes/textVisible/
 * entityExists trigger rules. The ordinary runner backs it with the executable
 * page binding; the retained Agent path backs it with the frozen WorldView.
 */
export type RecoveryWorldProbe = {
    currentUrl: () => Promise<string | undefined>;
    textVisible: (needle: string) => Promise<boolean>;
    entityExists: (
        args: { query: string; kind?: EntityKind | EntityKind[]; businessTag?: string | string[] },
        entityRules?: StepEntityRulesControl,
    ) => Promise<boolean>;
};

export type RecoverySelectionInput = {
    checkpoints: readonly Checkpoint[];
    failure: RecoveryFailureContext;
    checkpointEnabled: boolean;
    checkpointAttempt: number;
    checkpointAttempts?: Readonly<Record<string, number>>;
    checkpointMaxAttempts: number;
    world: RecoveryWorldProbe;
};

export type RecoverySelection =
    | { status: 'matched'; checkpoint: Checkpoint; attempt: number }
    | { status: 'no_match' };

export type RecoveryStepExecutor = (
    step: StepUnion,
    stepResolves?: Record<string, StepResolve>,
) => Promise<StepResult>;

export type RunCheckpointRecoveryOptions = {
    checkpoint: Checkpoint;
    /** Optional for legacy pipeline unit coverage; the retained Agent always supplies it. */
    runtime?: CheckpointRuntimeSnapshot;
    failure: RecoveryFailureContext;
    executeStep: RecoveryStepExecutor;
    /** Pre-bound legacy content steps (ordinary runner pipeline); otherwise bound internally. */
    boundContent?: StepUnion[];
    /** Optional DSL debug port forwarded to a body.dsl run (retained Agent path). */
    debugPort?: DslDebugPort;
};

export type RunCheckpointRecoveryOutcome = {
    active: boolean;
    stopReason?: CheckpointStopReason;
    runResult?: StepResult;
    nextStatus?: RunStatus;
    meta?: Record<string, unknown>;
};

export type RetryOriginalStepOptions = {
    checkpoint: Checkpoint;
    failure: RecoveryFailureContext;
    executeStep: RecoveryStepExecutor;
};

export type RetryOriginalStepOutcome = {
    retryResult?: StepResult;
    stopReason: CheckpointStopReason;
};

export type RecoveryExecutionOptions = {
    checkpoint: Checkpoint;
    /** Optional for legacy pipeline unit coverage; the retained Agent always supplies it. */
    runtime?: CheckpointRuntimeSnapshot;
    failure: RecoveryFailureContext;
    executeStep: RecoveryStepExecutor;
    debugPort?: DslDebugPort;
};

export type RecoveryExecutionResult = {
    finalResult: StepResult;
    nextStatus?: RunStatus;
    meta: Record<string, unknown>;
};