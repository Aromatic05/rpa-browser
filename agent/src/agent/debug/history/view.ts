import type {DebugProgramView} from '../program/view';
import type {
    DebugExecutionHistory,
    DebugProgramPointState,
    DebugStatementExecutionRecord,
} from './contracts';

export const buildDebugExecutionHistory = (
    program: DebugProgramView,
    records: readonly DebugStatementExecutionRecord[],
    currentPath?: string,
): DebugExecutionHistory => {
    const executions = new Map<string, number>();
    records.forEach((record) => {
        executions.set(record.location.path, (executions.get(record.location.path) ?? 0) + 1);
    });
    const points = program.statements.map<DebugProgramPointState>((entry) => {
        const count = executions.get(entry.path) ?? 0;
        return Object.freeze({
            path: entry.path,
            state: entry.path === currentPath
                ? 'current' as const
                : count > 0
                    ? 'executed' as const
                    : 'unexecuted' as const,
            executions: count,
        });
    });
    return Object.freeze({
        programId: program.programId,
        records: Object.freeze(records.map((record) => structuredClone(record))),
        points: Object.freeze(points),
    });
};
