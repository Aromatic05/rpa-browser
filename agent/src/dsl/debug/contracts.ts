import type {DslStmt} from '../ast/types';

export type DslLoopFrame = Readonly<{
    path: string;
    iteration: number;
}>;

export type DslStatementLocation = Readonly<{
    programId: string;
    path: string;
    kind: DslStmt['kind'];
    loops: readonly DslLoopFrame[];
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

export type DslDebugPort = {
    beforeStatement: (event: DslBeforeStatementEvent) => void | Promise<void>;
};

export type PausedDslExecution = Readonly<{
    continuationId: string;
    reason: 'statement';
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
}>;

export type DslDebugController = {
    readonly port: DslDebugPort;
    waitForPause: () => Promise<PausedDslExecution>;
    continue: (continuationId: string) => void;
    step: (continuationId: string) => void;
};
