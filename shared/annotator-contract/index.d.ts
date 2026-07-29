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
    domain?: 'form' | 'table' | 'node';
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
    page?: {kind: 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv'; urlPattern?: string};
    match: {version: 2; rules: Array<Record<string, unknown>>};
    annotation: {version: 2; bindings: Array<Record<string, unknown>>};
};
export type AnnotatorOpenPayload = {profileName?: string; tabName?: string};
export type AnnotatorPickPayload = {point: AnnotatorPoint; tabName?: string};
export type AnnotatorRecognizePayload = {profileName?: string; refresh?: boolean; tabName?: string};
export type AnnotatorVisualizePayload = {profileName?: string; tabName?: string};
export type AnnotatorSemanticInput =
    | {kind: 'entity'; businessTag: string; displayName?: string; entityKind?: 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv'}
    | {kind: 'field'; fieldKey: string; displayName?: string}
    | {kind: 'action'; actionIntent: string; displayName?: string}
    | {kind: 'column'; fieldKey: string; displayName?: string; columnKind?: 'text' | 'number' | 'date' | 'status'}
    | {kind: 'primary-key'; fieldKey: string}
    | {kind: 'table-action'; actionIntent: string; displayName?: string};
export type AnnotatorApplyPayload = {draft: AnnotatorDraft; targetId: string; semantic: AnnotatorSemanticInput; tabName?: string};
export type AnnotatorCheckPayload = {draft: AnnotatorDraft; tabName?: string};
export type AnnotatorSavePayload = {draft: AnnotatorDraft; tabName?: string};
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
    domain?: 'form' | 'table' | 'node';
    diagnostics: AnnotatorDiagnostic[];
    bindingIds: string[];
    suggestionIds: string[];
};
export type AnnotatorApplyReply = {
    draft: AnnotatorDraft;
    projection: AnnotatorProjection;
    validation: AnnotatorValidation;
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
