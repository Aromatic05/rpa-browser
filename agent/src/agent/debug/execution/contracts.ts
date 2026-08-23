import type {ComputeEvalScope} from '../../../runner/compute/evaluate';
import type {RunDslSourceResult} from '../../../dsl/runtime/run_dsl_source';
import type {DslScopeSnapshot, DslStatementLocation} from '../../../dsl/debug/contracts';
import type {ComputeExpr, StepArgsMap} from '../../../runner/steps/types';
import type {DebugComputeResult, DebugQueryReadResult} from '../query/contracts';
import type {WorldViewDescriptor} from '../../worldview/contracts';

export type PausedDslDebugExecution = Readonly<{
    continuationId: string;
    reason: 'statement';
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
    world: WorldViewDescriptor;
}>;

export type DslDebugAdvanceResult =
    | Readonly<{status: 'paused'; pause: PausedDslDebugExecution}>
    | Readonly<{status: 'completed'; output: Readonly<Record<string, unknown>>}>;

export type DslDebugExecutionSession = {
    waitForPause: () => Promise<PausedDslDebugExecution>;
    query: (continuationId: string, args: StepArgsMap['browser.query']) => DebugQueryReadResult;
    compute: (
        continuationId: string,
        expr: ComputeExpr,
        scope?: ComputeEvalScope,
    ) => DebugComputeResult;
    continue: (continuationId: string) => void;
    step: (continuationId: string) => void;
    advance: (continuationId: string, mode: 'continue' | 'step') => Promise<DslDebugAdvanceResult>;
    waitForCompletion: () => Promise<RunDslSourceResult>;
};
