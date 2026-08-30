import type {DslAfterStatementEvent} from '../../../automation/dsl/debug/contracts';
import type {DebugStatementExecutionRecord, DebugStatementHistoryStore} from './contracts';

export const createDebugStatementHistoryStore = (
    seed: readonly DebugStatementExecutionRecord[] = [],
): DebugStatementHistoryStore => {
    const records: DebugStatementExecutionRecord[] = Array.from(structuredClone(seed));
    let sequence = records.at(-1)?.sequence ?? 0;

    return Object.freeze({
        record: (event: DslAfterStatementEvent) => {
            sequence += 1;
            records.push(Object.freeze({
                sequence,
                location: structuredClone(event.location),
                statement: structuredClone(event.statement),
            }));
        },
        list: (programId?: string) => Object.freeze(
            records
                .filter((record) => !programId || record.location.programId === programId)
                .map((record) => structuredClone(record)),
        ),
        truncate: (targetSequence) => {
            if (!Number.isInteger(targetSequence) || targetSequence < 0 || targetSequence > sequence) {
                throw new Error(`invalid statement history sequence: ${targetSequence}`);
            }
            while (records.length > 0 && records.at(-1)!.sequence > targetSequence) {records.pop();}
            sequence = targetSequence;
        },
        exportState: () => Object.freeze(structuredClone(records)),
    });
};
