export type AnnotatorPoint = {x: number; y: number};
export type AnnotatorRect = {x: number; y: number; width: number; height: number};
export type AnnotatorAnchor = {
    pageEpoch: string;
    captureRevision: number;
    nodeId: string;
    backendNodeId?: string;
    runtimeIdentityToken?: string;
};
export type AnnotatorSelection =
    | {status: 'none'}
    | {status: 'resolved'; anchor: AnnotatorAnchor; nodeId: string}
    | {status: 'ambiguous'; anchor: AnnotatorAnchor; candidateNodeIds: string[]}
    | {status: 'stale'; anchor: AnnotatorAnchor};
export type AnnotatorTargetKind =
    | 'selection-scope'
    | 'host'
    | 'structural-root'
    | 'field'
    | 'action'
    | 'row'
    | 'column'
    | 'control'
    | 'semantic-binding';
export type AnnotatorTarget = {
    id: string;
    kind: AnnotatorTargetKind;
    domain?: 'form' | 'table';
    componentId?: string;
    memberId?: string;
    nodeIds: string[];
    geometry: AnnotatorRect[];
    status?: string;
    label?: string;
};
export type AnnotatorComponent = {
    id: string;
    domain: 'form' | 'table';
    status: string;
    selectionScopeNodeId?: string;
    hostNodeId?: string;
    structuralRootNodeId: string;
    fieldIds: string[];
    actionIds: string[];
    rowIds: string[];
    columnIds: string[];
};
export type AnnotatorSemanticBinding = {
    id: string;
    profileName: string;
    ruleId: string;
    origin: 'inferred' | 'confirmed' | 'manual';
    disposition: 'active' | 'ignored';
    status: 'active' | 'invalidated';
    nodeIds: string[];
    componentIds: string[];
    annotation: Record<string, unknown>;
};
export type AnnotatorProjection = {
    schemaVersion: 1;
    identity: {pageEpoch: string; captureRevision: number};
    pageUrl: string;
    selection: AnnotatorSelection;
    components: AnnotatorComponent[];
    targets: AnnotatorTarget[];
    semanticBindings: AnnotatorSemanticBinding[];
    suggestions: Array<{
        id: string;
        kind: string;
        value: string;
        componentId: string;
        nodeId?: string;
        memberId?: string;
    }>;
    diagnostics: Array<{code: string; severity: string; message: string; nodeIds: string[]}>;
};
export type AnnotatorDraft = {
    profileName: string;
    match: {version: 2; rules: Array<Record<string, unknown>>};
    annotation: {version: 2; bindings: Array<Record<string, unknown>>};
};
export type AnnotatorOpenPayload = {profileName?: string};
export type AnnotatorPickPayload = {point: AnnotatorPoint};
export type AnnotatorRecognizePayload = {profileName?: string; refresh?: boolean};
export type AnnotatorVisualizePayload = {profileName?: string};
export type AnnotatorCheckPayload = {draft: AnnotatorDraft};
export type AnnotatorSavePayload = {draft: AnnotatorDraft};
export type AnnotatorProjectionReply = {
    projection: AnnotatorProjection;
    profile?: unknown;
    validation?: AnnotatorValidation;
};
export type AnnotatorPickReply = {
    projection: AnnotatorProjection;
    picked: {status: 'resolved'; nodeId: string; anchor: AnnotatorAnchor}
        | {status: 'ambiguous'; candidateNodeIds: string[]}
        | {status: 'not_found'};
};
export type AnnotatorDiagnostic = {
    code: string;
    severity: string;
    message: string;
    nodeIds: string[];
    ruleId?: string;
    planStepId?: string;
};
export type AnnotatorValidation = {
    ok: boolean;
    domain?: 'form' | 'table';
    diagnostics: AnnotatorDiagnostic[];
    bindingIds: string[];
    suggestionIds: string[];
};
export type AnnotatorCheckReply = {
    projection: AnnotatorProjection;
    validation: AnnotatorValidation;
};
export type AnnotatorSaveReply = {
    projection: AnnotatorProjection;
    validation: AnnotatorValidation;
    profile: unknown;
};
