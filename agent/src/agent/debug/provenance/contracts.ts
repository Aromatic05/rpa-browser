import type {DslValueProvenanceEvent} from '../../../program/dsl/debug/contracts';

export type DebugValueExplanation = Readonly<{
    programId: string;
    path: string;
    origin: 'derived' | 'input' | 'failure' | 'untracked';
    provenance?: DslValueProvenanceEvent;
    dependencies: readonly DebugValueExplanation[];
}>;

export type DebugValueProvenanceStore = {
    record: (event: DslValueProvenanceEvent) => void;
    explain: (programId: string, path: string) => DebugValueExplanation;
};

export type DebugValueRecomputeResult =
    | Readonly<{
        status: 'recomputed';
        programId: string;
        path: string;
        currentValue: unknown;
        candidateValue: unknown;
        changed: boolean;
        explanation: DebugValueExplanation;
    }>
    | Readonly<{
        status: 'unavailable';
        programId: string;
        path: string;
        reason: 'untracked' | 'unsupported_source' | 'unsupported_query' | 'cycle' | 'missing_scope_value';
        sourceKind?: DslValueProvenanceEvent['source']['kind'];
        explanation: DebugValueExplanation;
    }>
    | Readonly<{
        status: 'failed';
        programId: string;
        path: string;
        error: Readonly<{code: string; message: string; details?: unknown}>;
        explanation: DebugValueExplanation;
    }>;
