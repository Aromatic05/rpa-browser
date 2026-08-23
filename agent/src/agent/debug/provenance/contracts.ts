import type {DslValueProvenanceEvent} from '../../../dsl/debug/contracts';

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
