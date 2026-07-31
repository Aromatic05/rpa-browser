import type {
    AnalysisDiagnostic,
    Evidence,
    ObservationCompleteness,
    ObservationIdentity,
    ObservationNodeId,
    PageObservation,
    TreeScopeId,
} from '../model/contracts';
import type { RelationIndex } from '../../indexes/relation/contracts';

export type CandidateKind = 'form' | 'table' | 'dialog' | 'list' | 'toolbar' | 'part';

export type CandidateClassification =
    | 'structural'
    | 'host'
    | 'part'
    | 'latent'
    | 'rejected'
    | 'ambiguous';

export type CandidateEvidence = {
    anchorNodeId: ObservationNodeId;
    scopeId: TreeScopeId;
    kind?: CandidateKind;
    classification: CandidateClassification;
    evidence: Evidence[];
};

export type QuotientNode = {
    nodeId: ObservationNodeId;
    projectionParentId?: ObservationNodeId;
    collapsedAncestorIds: ObservationNodeId[];
};

export type StructuralQuotientView = {
    scopeId: TreeScopeId;
    candidateAnchorNodeId: ObservationNodeId;
    nodes: readonly QuotientNode[];
};

export type InvariantValidationResult = {
    ok: boolean;
    diagnostics: readonly AnalysisDiagnostic[];
};

export type PassResult<T> = {
    value: T;
    diagnostics: readonly AnalysisDiagnostic[];
    validation: InvariantValidationResult;
};

export type ObservationPassMetrics = {
    nodeVisits: number;
    edgeVisits: number;
    durationMs: number;
};

export type ObservationReport = {
    identity: ObservationIdentity;
    completeness: ObservationCompleteness;
    scope: {
        totalCount: number;
        capturedCount: number;
        unavailableCount: number;
        capturedWithoutCandidateCount: number;
        nodeCountByScope: Readonly<Record<TreeScopeId, number>>;
    };
    joins: {
        a11yResolved: number;
        a11yMissing: number;
        a11yAmbiguous: number;
        runtimeResolved: number;
        runtimeMissing: number;
        runtimeAmbiguous: number;
    };
    relations: {
        edgeCount: number;
        resolvedCount: number;
        unresolvedCount: number;
        ambiguousCount: number;
    };
    activity: {
        zeroBoxCount: number;
        zeroBoxWithActiveDescendants: number;
        controllerMismatchCount: number;
    };
    candidates: Readonly<Record<CandidateClassification, number>>;
    quotient: {
        viewCount: number;
        maxSize: number;
        p50Size: number;
        p95Size: number;
        maxCollapsedDepth: number;
        maxProjectionParentFanOut: number;
        orphanCount: number;
    };
    passes: Readonly<Record<string, ObservationPassMetrics>>;
};

export type PageObservationAnalysis = {
    observation: PageObservation;
    relations: RelationIndex;
    candidates: readonly CandidateEvidence[];
    quotients: readonly StructuralQuotientView[];
    diagnostics: readonly AnalysisDiagnostic[];
    validation: InvariantValidationResult;
    report: ObservationReport;
};
