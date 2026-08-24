import type {DslStmt} from '../../../program/dsl/ast/types';
import type {DslAfterStatementEvent, DslStatementLocation} from '../../../automation/dsl/debug/contracts';

export type DebugStatementExecutionRecord = Readonly<{
    sequence: number;
    location: DslStatementLocation;
    statement: DslStmt;
}>;

export type DebugProgramPointState = Readonly<{
    path: string;
    state: 'current' | 'executed' | 'unexecuted';
    executions: number;
}>;

export type DebugExecutionHistory = Readonly<{
    programId: string;
    records: readonly DebugStatementExecutionRecord[];
    points: readonly DebugProgramPointState[];
}>;

export type DebugStatementHistoryStore = Readonly<{
    record: (event: DslAfterStatementEvent) => void;
    list: (programId?: string) => readonly DebugStatementExecutionRecord[];
    truncate: (sequence: number) => void;
}>;
