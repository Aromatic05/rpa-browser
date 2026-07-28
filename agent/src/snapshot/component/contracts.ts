import type {
    Evidence,
    GeometryRecord,
    ObservationNodeId,
} from '../observation/contracts';

export type ComponentLocation = {
    selectionScopeNodeId?: ObservationNodeId;
    hostNodeId?: ObservationNodeId;
    structuralRootNodeId: ObservationNodeId;
};

export type GeometryFragment = {
    nodeId: ObservationNodeId;
    records: readonly GeometryRecord[];
};

export type SemanticSuggestion = {
    kind: 'action-intent' | 'component-kind';
    value: string;
    source: 'inferred';
    evidence: Evidence[];
};
