import type { SemanticSuggestion } from '../../components/shared/contracts';
import type {
    AnalysisDiagnostic,
    Evidence,
    ObservationNodeId,
} from '../../observation/model/contracts';
import type {
    EntityRuleQueryDomain,
    EntityRuleQueryExecutionResult,
    QueryPlanSnapshots,
    QueryPlanTargetKind,
} from '../query/contracts';

export type SemanticBindingDomain = EntityRuleQueryDomain | 'node';
export type SemanticBindingOrigin = 'inferred' | 'confirmed' | 'manual';
export type SemanticBindingDisposition = 'active' | 'ignored';
export type SemanticBindingStatus = 'active' | 'invalidated';

export type SemanticAnnotationRecord = {
    ruleId: string;
    origin?: SemanticBindingOrigin;
    disposition?: SemanticBindingDisposition;
    [key: string]: unknown;
};

export type SemanticBindingTarget = {
    componentIds: string[];
    nodeIds: ObservationNodeId[];
    fieldIds: string[];
    actionIds: string[];
    rowIds: string[];
    columnIds: string[];
};

export type SemanticBusinessBinding = {
    id: string;
    profileName: string;
    ruleId: string;
    planStepId: string;
    domain: SemanticBindingDomain;
    targetKind: Exclude<QueryPlanTargetKind, 'query-plan'>;
    origin: SemanticBindingOrigin;
    disposition: SemanticBindingDisposition;
    status: SemanticBindingStatus;
    annotation: SemanticAnnotationRecord;
    target: SemanticBindingTarget;
};

export type SemanticBindingDiagnostic = AnalysisDiagnostic & {
    bindingId?: string;
    ruleId?: string;
};

export type SemanticBindings = {
    byId: Readonly<Record<string, SemanticBusinessBinding>>;
    forms: Readonly<Record<string, SemanticBusinessBinding | undefined>>;
    tables: Readonly<Record<string, SemanticBusinessBinding | undefined>>;
    nodes: Readonly<Record<ObservationNodeId, readonly SemanticBusinessBinding[] | undefined>>;
    fields: Readonly<Record<string, readonly SemanticBusinessBinding[] | undefined>>;
    actions: Readonly<Record<string, readonly SemanticBusinessBinding[] | undefined>>;
    rows: Readonly<Record<string, readonly SemanticBusinessBinding[] | undefined>>;
    columns: Readonly<Record<string, readonly SemanticBusinessBinding[] | undefined>>;
    diagnostics: readonly SemanticBindingDiagnostic[];
};

export type SemanticSuggestionRecord = {
    id: string;
    domain: EntityRuleQueryDomain;
    targetKind: 'form-component' | 'table-component' | 'form-action';
    componentId: string;
    nodeId?: ObservationNodeId;
    memberId?: string;
    kind: SemanticSuggestion['kind'];
    value: string;
    source: 'inferred';
    evidence: Evidence[];
};

export type SemanticSuggestions = {
    items: readonly SemanticSuggestionRecord[];
    diagnostics: readonly SemanticBindingDiagnostic[];
};

export type SemanticLayer = {
    bindings: SemanticBindings;
    suggestions: SemanticSuggestions;
};

export type BuildSemanticLayerInput = {
    execution: EntityRuleQueryExecutionResult;
    annotations: readonly SemanticAnnotationRecord[];
    snapshots: QueryPlanSnapshots;
};

export type SemanticBindingMergeStats = {
    added: number;
    refreshed: number;
    preserved: number;
    invalidated: number;
};

export type SemanticBindingMergeResult = {
    bindings: SemanticBindings;
    stats: SemanticBindingMergeStats;
};
