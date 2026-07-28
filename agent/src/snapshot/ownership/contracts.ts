import type {
    AnalysisDiagnostic,
    Evidence,
} from '../observation/contracts';

export type OwnershipEndpoint =
    | { kind: 'node'; id: string }
    | { kind: 'control'; id: string }
    | { kind: 'form-field'; id: string }
    | { kind: 'form-group'; id: string }
    | { kind: 'form-action'; id: string }
    | { kind: 'form'; id: string }
    | { kind: 'table-row'; id: string }
    | { kind: 'table-column'; id: string }
    | { kind: 'table'; id: string };

export type OwnershipEdge = {
    owner: OwnershipEndpoint;
    member: OwnershipEndpoint;
    role: string;
    evidence: Evidence[];
};

export type OwnershipValidation = {
    ok: boolean;
    diagnostics: readonly AnalysisDiagnostic[];
};

export type OwnershipIndex = {
    edges: OwnershipEdge[];
    byOwner: Readonly<Record<string, readonly number[]>>;
    byMember: Readonly<Record<string, readonly number[]>>;
    diagnostics: readonly AnalysisDiagnostic[];
    validation: OwnershipValidation;
};
