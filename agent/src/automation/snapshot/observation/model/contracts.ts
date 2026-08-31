export type PageEpochId = string;
export type CaptureRevision = number;
export type TreeScopeId = string;
export type ObservationNodeId = string;
export type CaptureNodeId = string;

export type ObservationIdentity = {
    pageEpoch: PageEpochId;
    captureRevision: CaptureRevision;
};

export type ObservationAnchor = {
    pageEpoch: PageEpochId;
    captureRevision: CaptureRevision;
    nodeId: ObservationNodeId;
    backendNodeId?: string;
    runtimeIdentityToken?: string;
};

export type AnchorResolution =
    | {
        status: 'resolved';
        nodeId: ObservationNodeId;
        evidence: Evidence[];
    }
    | {
        status: 'stale';
        evidence: Evidence[];
    }
    | {
        status: 'ambiguous';
        candidateNodeIds: ObservationNodeId[];
        evidence: Evidence[];
    };

export type ObservationSourceStatus = 'complete' | 'partial' | 'unavailable';

export type ObservationCompleteness = {
    dom: ObservationSourceStatus;
    a11y: ObservationSourceStatus;
    runtime: ObservationSourceStatus;
    geometry: ObservationSourceStatus;
};

export type TreeScopeKind = 'document' | 'iframe' | 'open-shadow-root';
export type TreeScopeStatus = 'captured' | 'unavailable';

export type Rect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type RectTransform = {
    scaleX: number;
    scaleY: number;
    translateX: number;
    translateY: number;
};

export type TreeScope = {
    id: TreeScopeId;
    kind: TreeScopeKind;
    parentScopeId?: TreeScopeId;
    hostNodeId?: ObservationNodeId;
    rootNodeId: ObservationNodeId;
    status: TreeScopeStatus;
    unavailableReason?: string;
    transformToParent?: RectTransform;
    completeness: ObservationCompleteness;
};

export type ScopeForest = {
    scopes: Readonly<Record<TreeScopeId, TreeScope>>;
    rootScopeIds: readonly TreeScopeId[];
};

export type ActivityFacts = {
    hiddenByStyle: boolean;
    inert: boolean;
    ariaExposed?: boolean;
    selfHasBox: boolean;
    subtreeActive: boolean;
    rendered: boolean;
};

export type GeometrySource = 'dom-snapshot' | 'live-dom' | 'cdp';
export type GeometrySpace = 'scope-viewport' | 'top-css-viewport';

export type GeometryRecord = {
    rect: Rect;
    space: GeometrySpace;
    scopeId: TreeScopeId;
    captureRevision: CaptureRevision;
    source: GeometrySource;
    frameTransform?: RectTransform;
};

export type AccessibilityRecord = {
    axNodeId: string;
    backendNodeId?: string;
    role?: string;
    name?: string;
    description?: string;
    value?: string;
    checked?: string;
    selected?: string;
    expanded?: string;
    pressed?: string;
    disabled?: string;
    readonly?: string;
    invalid?: string;
    focused?: string;
};

export type RuntimeStateRecord = {
    stateId: string;
    tag?: string;
    type?: string;
    role?: string;
    value?: string;
    checked?: string;
    selected?: string;
    ariaChecked?: string;
    ariaSelected?: string;
    ariaExpanded?: string;
    ariaPressed?: string;
    disabled?: string;
    readonly?: string;
    invalid?: string;
    focused?: string;
    popupSelectedText?: string;
    ariaValueText?: string;
    ariaLabelledBy?: string;
    ariaDescribedBy?: string;
    contentEditableText?: string;
};

export type DomIdentityRecord = {
    captureId: CaptureNodeId;
    backendNodeId?: string;
    runtimeIdentityToken?: string;
};

export type ObservationNode = {
    id: ObservationNodeId;
    scopeId: TreeScopeId;
    tag: string;
};

export type LayerRecord = {
    scopeId: TreeScopeId;
};

export type EvidenceStrength = 'exact' | 'strong' | 'weak';
export type EvidenceSource = 'platform' | 'dom' | 'a11y' | 'runtime' | 'adapter' | 'geometry';

export type Evidence = {
    code: string;
    strength: EvidenceStrength;
    source: EvidenceSource;
    nodeIds: ObservationNodeId[];
    detail?: Record<string, unknown>;
};

export type AssemblyStatus = 'complete' | 'partial' | 'ambiguous' | 'rejected';

export type AnalysisDiagnostic = {
    code: string;
    severity: 'info' | 'warning' | 'error';
    stage: string;
    status?: AssemblyStatus;
    nodeIds: ObservationNodeId[];
    evidence: Evidence[];
    message: string;
};

export type Resolution<T> =
    | { status: 'resolved'; value: T; evidence: Evidence[] }
    | { status: 'missing'; evidence: Evidence[] }
    | { status: 'ambiguous'; candidates: T[]; evidence: Evidence[] };

export type PageObservation = {
    identity: ObservationIdentity;
    scopes: ScopeForest;
    completeness: ObservationCompleteness;
    nodes: Readonly<Record<ObservationNodeId, ObservationNode>>;
    parents: Readonly<Record<ObservationNodeId, ObservationNodeId | undefined>>;
    children: Readonly<Record<ObservationNodeId, readonly ObservationNodeId[]>>;
    documentOrder: Readonly<Record<ObservationNodeId, number>>;
    attributes: Readonly<Record<ObservationNodeId, Readonly<Record<string, string>>>>;
    text: Readonly<Record<ObservationNodeId, string | undefined>>;
    accessibility: Readonly<Record<ObservationNodeId, AccessibilityRecord | undefined>>;
    runtimeState: Readonly<Record<ObservationNodeId, RuntimeStateRecord | undefined>>;
    geometry: Readonly<Record<ObservationNodeId, readonly GeometryRecord[]>>;
    activity: Readonly<Record<ObservationNodeId, ActivityFacts>>;
    domIdentity: Readonly<Record<ObservationNodeId, DomIdentityRecord>>;
    layers: Readonly<Record<ObservationNodeId, LayerRecord>>;
    captureIdToNodeId: Readonly<Record<CaptureNodeId, ObservationNodeId>>;
    diagnostics: readonly AnalysisDiagnostic[];
};


export type ObservationPassCounter = {
    nodeVisits: number;
    edgeVisits: number;
};

export type LocatorScopePath = Array<
    | { kind: 'frame'; hostNodeId: ObservationNodeId }
    | { kind: 'shadow'; hostNodeId: ObservationNodeId }
>;
