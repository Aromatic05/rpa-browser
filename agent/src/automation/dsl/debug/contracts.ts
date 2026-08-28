import type {DslComputeExpr, DslExpr, DslProgram, DslStmt, QueryExpr} from '../../../program/dsl/ast/types';
import type {StepName} from '../../runner/steps/types';
import type {BrowserOperationClassification} from '../../runner/steps/effects';
import type {EffectSemantics} from '../../../program/effects/contracts';
import type {QueryIR} from '../../../program/query/contracts';
import type {DslSourceLocation, DslSourceMap} from '../../../program/dsl/parser/source_map';

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

export type DslIfExecutionFrameSnapshot = Readonly<{
    kind: 'if';
    statementPath: string;
    parentBlockPath: string;
    statementIndex: number;
    branch: 'then' | 'else';
    parentScope: DslScopeSnapshot;
    beforeVars: readonly string[];
    loops: readonly DslLoopFrame[];
}>;

export type DslForExecutionFrameSnapshot = Readonly<{
    kind: 'for';
    statementPath: string;
    parentBlockPath: string;
    statementIndex: number;
    parentScope: DslScopeSnapshot;
    item: string;
    items: readonly unknown[];
    iteration: number;
    loops: readonly DslLoopFrame[];
}>;

export type DslCheckpointExecutionFrameSnapshot = Readonly<{
    kind: 'checkpoint';
    checkpointId: string;
    statementPath: string;
    parentBlockPath: string;
    statementIndex: number;
    parentProgramId: string;
    parentScope: DslScopeSnapshot;
    bind?: string;
    dependencies: readonly string[];
    loops: readonly DslLoopFrame[];
    callStack: readonly string[];
}>;

export type DslExecutionFrameSnapshot =
    | DslIfExecutionFrameSnapshot
    | DslForExecutionFrameSnapshot
    | DslCheckpointExecutionFrameSnapshot;

export type DslValueObservedRevision = Readonly<{
    pageEpoch: string;
    captureRevision: number;
}>;

export type DslValueProvenanceSource =
    | Readonly<{
        kind: 'query';
        expression: QueryExpr;
        query?: QueryIR;
        stepId: string;
        dependencies: readonly string[];
        observedAt?: DslValueObservedRevision;
    }>
    | Readonly<{
        kind: 'compute';
        expression: DslComputeExpr;
        dependencies: readonly string[];
    }>
    | Readonly<{
        kind: 'ref';
        ref: string;
        dependencies: readonly string[];
    }>
    | Readonly<{
        kind: 'checkpoint';
        checkpointId: string;
        dependencies: readonly string[];
    }>
    | Readonly<{
        kind: 'loop';
        expression: DslExpr;
        iteration: number;
        dependencies: readonly string[];
    }>;

export type DslValueProvenanceEvent = Readonly<{
    target: string;
    location: DslStatementLocation;
    source: DslValueProvenanceSource;
}>;

export type DslProgramEvent = Readonly<{
    programId: string;
    source: string;
    program: DslProgram;
    sourceMap: DslSourceMap;
}>;

export type DslBeforeStatementEvent = Readonly<{
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
    statement: DslStmt;
    frames: readonly DslExecutionFrameSnapshot[];
}>;

export type DslBeforeStatementResolution = Readonly<{
    statement: DslStmt;
}>;

export type DslAfterStatementEvent = Readonly<{
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
    statement: DslStmt;
}>;

export type DslEffectDescriptor = Readonly<{
    stepId: string;
    stepName: StepName;
    args: unknown;
    semantics: EffectSemantics;
    logicalTarget?: Readonly<{
        kind: 'query';
        query: QueryIR;
        resolvedAt?: DslValueObservedRevision;
    }>;
}>;

export type DslBeforeEffectResolution = Readonly<{
    effect: DslEffectDescriptor;
}>;

export type DslBeforeEffectEvent = Readonly<{
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
    effect: DslEffectDescriptor;
}>;

export type DslEffectOutcome =
    | Readonly<{status: 'succeeded'}>
    | Readonly<{
        status: 'failed';
        error: Readonly<{
            code: string;
            message: string;
            details?: unknown;
        }>;
    }>;

export type DslAfterEffectEvent = Readonly<{
    location: DslStatementLocation;
    effect: DslEffectDescriptor;
    outcome: DslEffectOutcome;
}>;

export type DslStepFailureDescriptor = Readonly<{
    kind: 'step';
    stepId: string;
    stepName: StepName;
    classification: BrowserOperationClassification;
    args: unknown;
    code: string;
    message: string;
    details?: unknown;
}>;

export type DslInvariantFailureDescriptor = Readonly<{
    kind: 'invariant';
    code: 'ERR_DSL_ENSURE_FAILED';
    message: string;
    details: Readonly<{
        expected: true;
        actual: false;
        condition: unknown;
    }>;
}>;

export type DslFailureDescriptor = DslStepFailureDescriptor | DslInvariantFailureDescriptor;

export type DslFailureEvent = Readonly<{
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
    failure: DslFailureDescriptor;
}>;

export type DslDebugPort = {
    beforeStatement: (
        event: DslBeforeStatementEvent,
    ) => DslBeforeStatementResolution | undefined | Promise<DslBeforeStatementResolution | undefined>;
    afterStatement?: (event: DslAfterStatementEvent) => void | Promise<void>;
    beforeEffect?: (
        event: DslBeforeEffectEvent,
    ) => DslBeforeEffectResolution | undefined | Promise<DslBeforeEffectResolution | undefined>;
    afterEffect?: (event: DslAfterEffectEvent) => void | Promise<void>;
    onFailure?: (event: DslFailureEvent) => void | Promise<void>;
    onValue?: (event: DslValueProvenanceEvent) => void | Promise<void>;
    onProgram?: (event: DslProgramEvent) => void | Promise<void>;
};

type PausedDslExecutionBase = Readonly<{
    continuationId: string;
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
}>;

export type PausedDslExecution =
    | (PausedDslExecutionBase & Readonly<{
        reason: 'statement';
        statement: DslStmt;
        frames: readonly DslExecutionFrameSnapshot[];
    }>)
    | (PausedDslExecutionBase & Readonly<{reason: 'effect'; effect: DslEffectDescriptor}>)
    | (PausedDslExecutionBase & Readonly<{reason: 'barrier'; effect: DslEffectDescriptor}>)
    | (PausedDslExecutionBase & Readonly<{reason: 'failure'; failure: DslFailureDescriptor}>);

export type DslDebugController = {
    readonly port: DslDebugPort;
    waitForPause: () => Promise<PausedDslExecution>;
    continue: (continuationId: string) => void;
    step: (continuationId: string) => void;
    patchStatement: (continuationId: string, statement: DslStmt) => void;
    crossBarrier: (continuationId: string) => void;
    abort: (continuationId: string) => void;
};
