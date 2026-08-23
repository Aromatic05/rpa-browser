import type {ComputeEvalScope} from '../../../runner/compute/evaluate';
import type {RunDslSourceResult} from '../../../dsl/runtime/run_dsl_source';
import type {
    DslEffectDescriptor,
    DslFailureDescriptor,
    DslScopeSnapshot,
    DslStatementLocation,
} from '../../../dsl/debug/contracts';
import type {ComputeExpr, StepArgsMap} from '../../../runner/steps/types';
import type {DebugComputeResult, DebugQueryReadResult} from '../query/contracts';
import type {DebugEffectRecord} from '../effects/contracts';
import type {WorldViewDescriptor} from '../../worldview/contracts';

type PausedDslDebugExecutionBase = Readonly<{
    continuationId: string;
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
    world: WorldViewDescriptor;
}>;

export type PausedDslDebugExecution =
    | (PausedDslDebugExecutionBase & Readonly<{reason: 'statement'}>)
    | (PausedDslDebugExecutionBase & Readonly<{reason: 'effect'; effect: DslEffectDescriptor}>)
    | (PausedDslDebugExecutionBase & Readonly<{reason: 'failure'; failure: DslFailureDescriptor}>);

export type DslDebugTerminalFailure = Readonly<{
    code: string;
    message: string;
    details?: unknown;
    stepId?: string;
    stepName?: DslFailureDescriptor['stepName'];
    args?: unknown;
}>;

export type DslDebugWorldConflict = Readonly<{
    expected: WorldViewDescriptor;
    actual: WorldViewDescriptor;
}>;

export type DslDebugAdvanceResult =
    | Readonly<{status: 'paused'; pause: PausedDslDebugExecution}>
    | Readonly<{status: 'conflict'; conflict: DslDebugWorldConflict}>
    | Readonly<{status: 'completed'; output: Readonly<Record<string, unknown>>}>
    | Readonly<{status: 'failed'; failure: DslDebugTerminalFailure}>
    | Readonly<{
        status: 'aborted';
        at: Readonly<{
            reason: PausedDslDebugExecution['reason'];
            location: DslStatementLocation;
        }>;
    }>;

export type DslDebugExecutionSession = {
    waitForPause: () => Promise<PausedDslDebugExecution>;
    query: (continuationId: string, args: StepArgsMap['browser.query']) => DebugQueryReadResult;
    compute: (
        continuationId: string,
        expr: ComputeExpr,
        scope?: ComputeEvalScope,
    ) => DebugComputeResult;
    effects: (continuationId: string) => readonly DebugEffectRecord[];
    refresh: (continuationId: string) => Promise<PausedDslDebugExecution>;
    advance: (continuationId: string, mode: 'continue' | 'step' | 'abort') => Promise<DslDebugAdvanceResult>;
    waitForCompletion: () => Promise<RunDslSourceResult>;
};
