import type {
    AnalysisDiagnostic,
    Evidence,
    ObservationNodeId,
} from '../../observation/model/contracts';

export type RelationKind =
    | 'labelled-by'
    | 'label-for'
    | 'described-by'
    | 'error-message'
    | 'controls-target'
    | 'popup-owner'
    | 'owns'
    | 'form-owner'
    | 'framework-part'
    | 'visual-layer-member';

export type RelationEdge = {
    kind: RelationKind;
    sourceNodeId: ObservationNodeId;
    targetNodeIds: ObservationNodeId[];
    status: 'resolved' | 'ambiguous' | 'unresolved';
    evidence: Evidence[];
};

export type RelationIndex = {
    edges: readonly RelationEdge[];
    bySourceNodeId: Readonly<Record<ObservationNodeId, readonly number[]>>;
    byTargetNodeId: Readonly<Record<ObservationNodeId, readonly number[]>>;
    diagnostics: readonly AnalysisDiagnostic[];
};
