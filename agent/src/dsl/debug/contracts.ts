import type {DslStmt} from '../ast/types';
import type {StepName} from '../../runner/steps/types';
import type {BrowserOperationClassification} from '../../runner/steps/effects';
import type {DslSourceLocation} from '../parser/source_map';

export type DslLoopFrame = Readonly<{
    path: string;
    iteration: number;
}>;

export type DslStatementLocation = Readonly<{
    programId: string;
    path: string;
    kind: DslStmt['kind'];
    loops: readonly DslLoopFrame[];
    source?: DslSourceLocation;
    callStack: readonly string[];
}>;

export type DslScopeSnapshot = Readonly<{
    input: Readonly<Record<string, unknown>>;
    failure?: Readonly<Record<string, unknown>>;
    vars: Readonly<Record<string, unknown>>;
    output: Readonly<Record<string, unknown>>;
}>;

export type DslBeforeStatementEvent = Readonly<{
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
}>;

export type DslEffectDescriptor = Readonly<{
    stepId: string;
    stepName: StepName;
    args: unknown;
}>;

export type DslBeforeEffectEvent = Readonly<{
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
    effect: DslEffectDescriptor;
}>;

export type DslFailureDescriptor = Readonly<{
    stepId: string;
    stepName: StepName;
    classification: BrowserOperationClassification;
    args: unknown;
    code: string;
    message: string;
    details?: unknown;
}>;

export type DslFailureEvent = Readonly<{
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
    failure: DslFailureDescriptor;
}>;

export type DslDebugPort = {
    beforeStatement: (event: DslBeforeStatementEvent) => void | Promise<void>;
    beforeEffect?: (event: DslBeforeEffectEvent) => void | Promise<void>;
    onFailure?: (event: DslFailureEvent) => void | Promise<void>;
};

type PausedDslExecutionBase = Readonly<{
    continuationId: string;
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
}>;

export type PausedDslExecution =
    | (PausedDslExecutionBase & Readonly<{reason: 'statement'}>)
    | (PausedDslExecutionBase & Readonly<{reason: 'effect'; effect: DslEffectDescriptor}>)
    | (PausedDslExecutionBase & Readonly<{reason: 'failure'; failure: DslFailureDescriptor}>);

export type DslDebugController = {
    readonly port: DslDebugPort;
    waitForPause: () => Promise<PausedDslExecution>;
    continue: (continuationId: string) => void;
    step: (continuationId: string) => void;
    abort: (continuationId: string) => void;
};
