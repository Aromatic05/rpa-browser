import type {ComputeEvalScope} from '../../../program/compute/evaluate';
import type {RunDslSourceResult} from '../../../automation/dsl/runtime/run_dsl_source';
import type {
    DslEffectDescriptor,
    DslExecutionFrameSnapshot,
    DslFailureDescriptor,
    DslScopeSnapshot,
    DslStatementLocation,
} from '../../../automation/dsl/debug/contracts';
import type {StepName, StepResult} from '../../../automation/runner/steps/types';
import type {CheckpointRuntimeSnapshot} from '../../../automation/runner/checkpoint/runtime_snapshot';
import type {ComputeExpr} from '../../../program/compute/types';
import type {QueryIR} from '../../../program/query/contracts';
import type {DslStmt} from '../../../program/dsl/ast/types';
import type {DebugComputeResult, DebugQueryReadResult} from '../query/contracts';
import type {QueryIRExecutionError} from '../../../automation/runner/session/query_ir';
import type {DebugEffectDiffResult, DebugEffectRecord} from '../effects/contracts';
import type {WorldViewDescriptor} from '../../worldview/contracts';
import type {WorldCatalog} from '../../worldview/catalog';
import type {WorldViewDiffResult} from '../../worldview/diff';
import type {DebugValueExplanation, DebugValueRecomputeResult} from '../provenance/contracts';
import type {DebugProgramView} from '../program/view';
import type {DebugProgramPatch} from '../program/patches';
import type {DebugExecutionHistory} from '../history/contracts';
import type {
    DebugRollbackOptions,
    DebugRollbackResult,
    DebugSavepoint,
    DebugTransactionSnapshot,
} from '../transaction/contracts';
import type {ProgramExecutionImageExportResult} from '../../continuation/contracts';

type PausedDslDebugExecutionBase = Readonly<{
    continuationId: string;
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
    world: WorldViewDescriptor;
    rollbackAnchor?: DebugSavepoint;
}>;

export type PausedDslDebugExecution =
    | (PausedDslDebugExecutionBase & Readonly<{reason: 'statement'; statement: DslStmt}>)
    | (PausedDslDebugExecutionBase & Readonly<{reason: 'effect'; effect: DslEffectDescriptor}>)
    | (PausedDslDebugExecutionBase & Readonly<{reason: 'barrier'; effect: DslEffectDescriptor}>)
    | (PausedDslDebugExecutionBase & Readonly<{reason: 'failure'; failure: DslFailureDescriptor}>);

export type DslDebugTerminalFailure = Readonly<{
    code: string;
    message: string;
    details?: unknown;
    stepId?: string;
    stepName?: StepName;
    args?: unknown;
}>;

export type DslDebugWorldConflict = Readonly<{
    expected: WorldViewDescriptor;
    actual: WorldViewDescriptor;
}>;

export type DslDebugAdvanceResult =
    | Readonly<{status: 'paused'; pause: PausedDslDebugExecution}>
    | Readonly<{status: 'barrier'; pause: Extract<PausedDslDebugExecution, {reason: 'barrier'}>}>
    | Readonly<{status: 'conflict'; conflict: DslDebugWorldConflict}>
    | Readonly<{
        status: 'recompute_required';
        pause: Extract<PausedDslDebugExecution, {reason: 'effect' | 'barrier'}>;
        target: Readonly<{
            resolvedAt: WorldViewDescriptor;
            current: WorldViewDescriptor;
        }>;
    }>
    | Readonly<{status: 'completed'; output: Readonly<Record<string, unknown>>}>
    | Readonly<{status: 'failed'; failure: DslDebugTerminalFailure}>
    | Readonly<{
        status: 'aborted';
        at: Readonly<{
            reason: PausedDslDebugExecution['reason'];
            location: DslStatementLocation;
        }>;
    }>;


export type DebugExecutionSavepoint = Readonly<{
    savepoint: DebugSavepoint;
    reason: PausedDslDebugExecution['reason'];
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
    frames: readonly DslExecutionFrameSnapshot[];
    historySequence: number;
    world: WorldViewDescriptor;
}>;

export type DslDebugRewindCandidate = Readonly<{
    savepointId: string;
    origin: 'automatic' | 'explicit';
    name?: string;
    location: DslStatementLocation;
    checkpointStack: readonly Readonly<{checkpointId: string; invocationId: string}>[];
    effectSequence: number;
    world: WorldViewDescriptor;
    exact: boolean;
    replayStatements: number;
}>;

export type DslDebugRewindPlanResult =
    | Readonly<{
        status: 'ready';
        target: Readonly<{programId: string; path: string; executions: number}>;
        candidates: readonly DslDebugRewindCandidate[];
    }>
    | Readonly<{
        status: 'no_savepoint';
        target: Readonly<{programId: string; path: string; executions: number}>;
        candidates: readonly DslDebugRewindCandidate[];
    }>
    | Readonly<{
        status: 'unknown_program' | 'unknown_path';
        target: Readonly<{programId: string; path: string}>;
    }>
    | Readonly<{
        status: 'unsupported_target';
        reason: 'not_main_top_level';
        target: Readonly<{programId: string; path: string; executions: number}>;
    }>;

/**
 * Retained-agent recovery of a human-taught Workflow Recovery checkpoint. The
 * recovery runs inside the SAME retained transaction using the same journaled
 * StepExecutionPort; a second Program/runSteps transaction is never started.
 * Selection and execution share the automation runner checkpoint recovery
 * service, so matcher priority/maxAttempts/trigger/entity-rules semantics match
 * the ordinary runner.
 */
export type DslDebugRecoveryRunOptions = Readonly<{
    runtime: CheckpointRuntimeSnapshot;
    checkpointMaxAttempts?: number;
}>;

export type DslDebugRecoveryRunResult =
    | Readonly<{status: 'no_recovery'}>
    | Readonly<{
        status: 'recovered';
        checkpointId: string;
        checkpointName?: string;
        retried: boolean;
        advance?: DslDebugAdvanceResult;
    }>
    | Readonly<{status: 'failed'; checkpointId?: string; result?: StepResult}>
    | Readonly<{
        status: 'needs_approval';
        checkpointId: string;
        barrier: Extract<PausedDslDebugExecution, {reason: 'barrier'}>;
    }>;


export type DslDebugCommitResult =
    | Readonly<{
        status: 'committed';
        previous: DebugTransactionSnapshot;
        transaction: DebugTransactionSnapshot;
        world: WorldViewDescriptor;
    }>
    | Readonly<{
        status: 'conflict';
        conflict: DslDebugWorldConflict;
    }>
    | Readonly<{
        status: 'unavailable';
        reason: 'failure_pause';
        pause: PausedDslDebugExecution;
    }>;

export type DslDebugRewindResult =
    | Readonly<{
        status: 'rewound';
        savepoint: DebugExecutionSavepoint;
        pause: Extract<PausedDslDebugExecution, {reason: 'statement'}>;
    }>
    | Readonly<{
        status: 'not_found';
        error: Readonly<{code: 'ERR_NOT_FOUND'; message: string}>;
    }>
    | Readonly<{
        status: 'unsupported_target';
        reason: 'not_statement_savepoint' | 'not_main_top_level';
        savepoint: DebugExecutionSavepoint;
    }>
    | Readonly<{
        status: 'blocked';
        reason: 'world_not_restored';
        savepoint: DebugExecutionSavepoint;
        rollback: DebugRollbackResult;
    }>
    | Readonly<{
        status: 'conflict';
        savepoint: DebugExecutionSavepoint;
        pause: Extract<PausedDslDebugExecution, {reason: 'statement'}>;
        conflict: DslDebugWorldConflict;
    }>;

export type DslDebugRecomputeEffectResult =
    | Readonly<{
        status: 'recomputed';
        pause: Extract<PausedDslDebugExecution, {reason: 'effect' | 'barrier'}>;
    }>
    | Readonly<{
        status: 'unavailable';
        reason: 'not_effect_pause' | 'no_logical_target' | 'unsupported_effect';
        pause: PausedDslDebugExecution;
    }>
    | Readonly<{
        status: 'failed';
        error: QueryIRExecutionError;
        pause: Extract<PausedDslDebugExecution, {reason: 'effect' | 'barrier'}>;
    }>;


export type DslDebugPatchProgramResult =
    | Readonly<{status: 'patched'; patch: DebugProgramPatch; target: Readonly<{programId: string; path: string; state: 'current' | 'future'}>; pause: PausedDslDebugExecution}>
    | Readonly<{status: 'rewind_required'; patch: DebugProgramPatch; target: Readonly<{programId: string; path: string; executions: number}>; rewind: DslDebugRewindPlanResult; pause: PausedDslDebugExecution}>
    | Readonly<{status: 'unknown_program' | 'unknown_path'; target: Readonly<{programId: string; path: string}>; pause: PausedDslDebugExecution}>
    | Readonly<{status: 'invalid'; error: Readonly<{code: 'ERR_DSL_PATCH_INVALID' | 'ERR_DSL_PATCH_UNSUPPORTED'; message: string; diagnostics?: readonly unknown[]}>; pause: PausedDslDebugExecution}>;

export type DslDebugUnpatchProgramResult = Readonly<{status: 'removed' | 'not_found'; patch?: DebugProgramPatch; target: Readonly<{programId: string; path: string}>; pause: PausedDslDebugExecution}>;

export type DslDebugPatchStatementResult =
    | Readonly<{
        status: 'patched';
        pause: Extract<PausedDslDebugExecution, {reason: 'statement'}>;
    }>
    | Readonly<{
        status: 'unavailable';
        reason: 'not_statement_pause';
        pause: PausedDslDebugExecution;
    }>
    | Readonly<{
        status: 'rewind_required';
        target: Readonly<{programId: string; path: string; executions: number}>;
        rewind: DslDebugRewindPlanResult;
        pause: PausedDslDebugExecution;
    }>
    | Readonly<{
        status: 'not_current';
        target: Readonly<{programId: string; path: string; executions: 0}>;
        pause: PausedDslDebugExecution;
    }>
    | Readonly<{
        status: 'unknown_program' | 'unknown_path';
        target: Readonly<{programId: string; path: string}>;
        pause: PausedDslDebugExecution;
    }>
    | Readonly<{
        status: 'invalid';
        error: Readonly<{
            code: 'ERR_DSL_PATCH_INVALID' | 'ERR_DSL_PATCH_UNSUPPORTED';
            message: string;
            diagnostics?: readonly unknown[];
        }>;
        pause: Extract<PausedDslDebugExecution, {reason: 'statement'}>;
    }>;

export type DslDebugExecutionSession = {
    waitForPause: () => Promise<PausedDslDebugExecution>;
    runRecovery: (
        continuationId: string,
        options: DslDebugRecoveryRunOptions,
    ) => Promise<DslDebugRecoveryRunResult>;
    query: (continuationId: string, ir: QueryIR) => DebugQueryReadResult;
    compute: (
        continuationId: string,
        expr: ComputeExpr,
        scope?: ComputeEvalScope,
    ) => DebugComputeResult;
    catalog: (continuationId: string) => WorldCatalog;
    program: (continuationId: string, programId?: string) => DebugProgramView;
    materializeProgram: (programId?: string) => string;
    history: (continuationId: string, programId?: string) => DebugExecutionHistory;
    patches: (continuationId: string, programId?: string) => readonly DebugProgramPatch[];
    auditEffects: () => readonly DebugEffectRecord[];
    exportProgramExecutionImage: () => ProgramExecutionImageExportResult;
    effects: (continuationId: string) => readonly DebugEffectRecord[];
    explain: (continuationId: string, path: string) => DebugValueExplanation;
    recompute: (continuationId: string, path: string) => DebugValueRecomputeResult;
    diff: (continuationId: string, effectSequence: number) => DebugEffectDiffResult;
    transaction: (continuationId: string) => DebugTransactionSnapshot;
    commit: (continuationId: string) => Promise<DslDebugCommitResult>;
    savepoint: (continuationId: string, name?: string) => DebugSavepoint;
    executionSavepoint: (continuationId: string, savepointId: string) => DebugExecutionSavepoint | null;
    transactionDiff: (continuationId: string) => WorldViewDiffResult;
    rollback: (
        continuationId: string,
        savepointId: string,
        options?: DebugRollbackOptions,
    ) => Promise<DebugRollbackResult>;
    rewindPlan: (
        continuationId: string,
        target?: Readonly<{programId?: string; path?: string}>,
    ) => DslDebugRewindPlanResult;
    rewind: (continuationId: string, savepointId: string, options?: DebugRollbackOptions) => Promise<DslDebugRewindResult>;
    refresh: (continuationId: string) => Promise<PausedDslDebugExecution>;
    patchStatement: (
        continuationId: string,
        source: string,
        target?: Readonly<{programId?: string; path?: string}>,
    ) => DslDebugPatchStatementResult;
    patchProgram: (continuationId: string, programId: string, path: string, source: string) => DslDebugPatchProgramResult;
    unpatchProgram: (continuationId: string, programId: string, path: string) => DslDebugUnpatchProgramResult;
    recomputeEffect: (continuationId: string) => DslDebugRecomputeEffectResult;
    crossBarrier: (continuationId: string) => Promise<DslDebugAdvanceResult>;
    advance: (continuationId: string, mode: 'continue' | 'step' | 'abort') => Promise<DslDebugAdvanceResult>;
    waitForCompletion: () => Promise<RunDslSourceResult>;
};
