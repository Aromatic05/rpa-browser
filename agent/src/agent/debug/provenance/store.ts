import type {DslValueProvenanceEvent} from '../../../program/dsl/debug/contracts';
import type {DebugValueExplanation, DebugValueProvenanceStore} from './contracts';

const keyOf = (programId: string, path: string): string => `${programId}\u0000${path}`;

export const createDebugValueProvenanceStore = (): DebugValueProvenanceStore => {
    const records = new Map<string, DslValueProvenanceEvent>();

    const explain = (
        programId: string,
        path: string,
        visiting = new Set<string>(),
    ): DebugValueExplanation => {
        if (path.startsWith('input.')) {
            return Object.freeze({programId, path, origin: 'input' as const, dependencies: Object.freeze([])});
        }
        if (path.startsWith('failure.')) {
            return Object.freeze({programId, path, origin: 'failure' as const, dependencies: Object.freeze([])});
        }
        const key = keyOf(programId, path);
        const provenance = records.get(key);
        if (!provenance || visiting.has(key)) {
            return Object.freeze({programId, path, origin: 'untracked' as const, dependencies: Object.freeze([])});
        }
        const next = new Set(visiting);
        next.add(key);
        return Object.freeze({
            programId,
            path,
            origin: 'derived' as const,
            provenance: structuredClone(provenance),
            dependencies: Object.freeze(
                provenance.source.dependencies.map((dependency) => explain(programId, dependency, next)),
            ),
        });
    };

    return {
        record: (event) => {
            records.set(keyOf(event.location.programId, event.target), structuredClone(event));
        },
        explain: (programId, path) => explain(programId, path),
    };
};
