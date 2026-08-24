import type {ComputeEvalScope} from '../../../compute/evaluate';
import type {RunDslSourceResult} from '../../../dsl/runtime/run_dsl_source';
import type {
    DslEffectDescriptor,
    DslFailureDescriptor,
    DslScopeSnapshot,
    DslStatementLocation,
} from '../../../dsl/debug/contracts';
import type {StepName} from '../../../runner/steps/types';
import type {ComputeExpr} from '../../../compute/types';
import type {QueryIR} from '../../../query/contracts';
import type {DebugComputeResult, DebugQueryReadResult} from '../query/contracts';
import type {QueryIRExecutionError} from '../../../runner/session/query_ir';
import type {DebugEffectDiffResult, DebugEffectRecord} from '../effects/contracts';
import type {WorldViewDescriptor} from '../../worldview/contracts';
import type {WorldCatalog} from '../../worldview/catalog';
import type {WorldViewDiffResult} from '../../worldview/diff';
import type {DebugValueExplanation, DebugValueRecomputeResult} from '../provenance/contracts';
import type {
    DebugRollbackOptions,
    DebugRollbackResult,
    DebugSavepoint,
    DebugTransactionSnapshot,
} from '../transaction/contracts';

type PausedDslDebugExecutionBase = Readonly<{
    continuationId: string;
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
    world: WorldViewDescriptor;
}>;

export type PausedDslDebugExecution =
    | (PausedDslDebugExecutionBase & Readonly<{reason: 'statement'}>)
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

export type DslDebugExecutionSession = {
    waitForPause: () => Promise<PausedDslDebugExecution>;
    query: (continuationId: string, ir: QueryIR) => DebugQueryReadResult;
    compute: (
        continuationId: string,
        expr: ComputeExpr,
        scope?: ComputeEvalScope,
    ) => DebugComputeResult;
    catalog: (continuationId: string) => WorldCatalog;
    effects: (continuationId: string) => readonly DebugEffectRecord[];
    explain: (continuationId: string, path: string) => DebugValueExplanation;
    recompute: (continuationId: string, path: string) => DebugValueRecomputeResult;
    diff: (continuationId: string, effectSequence: number) => DebugEffectDiffResult;
    transaction: (continuationId: string) => DebugTransactionSnapshot;
    savepoint: (continuationId: string, name?: string) => DebugSavepoint;
    transactionDiff: (continuationId: string) => WorldViewDiffResult;
    rollback: (
        continuationId: string,
        savepointId: string,
        options?: DebugRollbackOptions,
    ) => Promise<DebugRollbackResult>;
    refresh: (continuationId: string) => Promise<PausedDslDebugExecution>;
    recomputeEffect: (continuationId: string) => DslDebugRecomputeEffectResult;
    crossBarrier: (continuationId: string) => Promise<DslDebugAdvanceResult>;
    advance: (continuationId: string, mode: 'continue' | 'step' | 'abort') => Promise<DslDebugAdvanceResult>;
    waitForCompletion: () => Promise<RunDslSourceResult>;
};
