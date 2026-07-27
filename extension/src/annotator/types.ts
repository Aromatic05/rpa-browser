export type RegionKind = 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar';
export type GroupKind = 'table' | 'kv' | 'list';
export type EntityKind = RegionKind | GroupKind;

export type EntityRuleExpect = 'unique' | 'one_or_more';
export type EntityRuleSource = 'region' | 'group' | 'node';

export type AnnotationOrigin = 'inferred' | 'confirmed' | 'manual';
export type AnnotationDisposition = 'active' | 'ignored';

export type PersistentTargetDraft = {
    kind?: EntityKind;
    nameContains?: string;
    idEquals?: string;
    nameEquals?: string;
    roleEquals?: string;
    classContains?: string;
    textContains?: string;
    ariaContains?: string;
    keyHint?: {
        headerContainsAll?: string[];
        primaryKeyCandidatesContains?: string[];
    };
    relation?: 'pagination';
};

export type CanvasPageDraft = {
    kind: EntityKind;
    urlPattern?: string;
};

export type CanvasColumnActionDraft = {
    id: string;
    actionIntent: string;
    text?: string;
    target: PersistentTargetDraft;
    origin: AnnotationOrigin;
    disposition: AnnotationDisposition;
};

export type CanvasColumnDraft = {
    id: string;
    fieldKey: string;
    name?: string;
    kind?: 'text' | 'number' | 'date' | 'status' | 'action_column';
    actions: CanvasColumnActionDraft[];
    origin: AnnotationOrigin;
    disposition: AnnotationDisposition;
};

export type CanvasAnnotationType = 'field' | 'action' | 'pagination';

export type CanvasAnnotationDraft = {
    id: string;
    type: CanvasAnnotationType;
    name?: string;
    businessKey: string;
    target: PersistentTargetDraft;
    expect?: EntityRuleExpect;
    origin: AnnotationOrigin;
    disposition: AnnotationDisposition;
};

export type CanvasPrimaryKeyDraft = {
    fieldKey: string;
    columns?: string[];
};

export type CanvasPaginationDraft = {
    actionIntent: string;
    pageTarget: PersistentTargetDraft;
    itemTarget?: PersistentTargetDraft;
};

export type CanvasEntitySource = 'region' | 'group' | 'node';

export type CanvasEntityDraft = {
    id: string;
    source: CanvasEntitySource;
    kind: EntityKind;
    name: string;
    businessTag: string;
    target: PersistentTargetDraft;
    expect?: EntityRuleExpect;
    annotations: CanvasAnnotationDraft[];
    primaryKey?: CanvasPrimaryKeyDraft;
    columns: CanvasColumnDraft[];
    pagination?: CanvasPaginationDraft;
    origin: AnnotationOrigin;
};

export type CanvasDraft = {
    version: number;
    profileName: string;
    page: CanvasPageDraft;
    entities: CanvasEntityDraft[];
    preserved: unknown;
};

export type VisualTargetRole = 'entity' | 'field' | 'action' | 'column' | 'pagination';

export type VisualTargetRef = {
    entityId: string;
    nodeId: string;
    kind?: EntityKind;
    role: VisualTargetRole;
    fieldKey?: string;
    actionIntent?: string;
    canvasAnnotationId?: string;
    bbox?: PickRect;
    matchedNodeBoxes?: PickRect[];
};

export type CheckStatus = 'unique' | 'multiple' | 'missing' | 'invalid';

export type CheckResultByAnnotation = {
    canvasAnnotationId: string;
    status: CheckStatus;
    matchCount: number;
    expected: EntityRuleExpect;
    message: string;
    nodeIds: string[];
};

export type PickPoint = { x: number; y: number };
export type PickRect = { x: number; y: number; width: number; height: number };

export type PickAncestorFingerprint = {
    tagName: string;
    classTokens: string[];
    role?: string;
    text?: string;
    ariaLabel?: string;
};

export type PickFingerprint = {
    point: PickPoint;
    selectorCandidates: string[];
    role?: string;
    text?: string;
    ariaLabel?: string;
    tagName: string;
    classTokens: string[];
    rect: PickRect;
    ancestors: PickAncestorFingerprint[];
};

export type PickCandidateLevel = 'control' | 'field' | 'row' | 'group' | 'region' | 'unknown';

export type PickCandidateEntityRef = {
    entityId: string;
    nodeId: string;
    kind: EntityKind;
    type: 'region' | 'group' | 'node';
};

export type PickPurpose = 'entity' | 'annotation';

export type PickCandidate = {
    level: PickCandidateLevel;
    nodeId: string;
    kind?: EntityKind;
    role?: string;
    text?: string;
    fieldKey?: string;
    actionIntent?: string;
    entityRef?: PickCandidateEntityRef;
    enclosingEntityNodeId?: string;
    score: number;
    matchCount?: number;
    matchedNodeIds?: string[];
    stabilityHint?: 'stable' | 'fragile';
    proposedTargets?: PersistentTargetDraft[];
    expect?: EntityRuleExpect;
};

export type PickResolution = {
    nodeId: string | null;
    reason: 'bbox' | 'fallback' | 'none';
    matchedNodeIds: string[];
};

export type RecognizedItem = {
    entityId: string;
    kind: EntityKind;
    name?: string;
    fieldCount: number;
    columnCount: number;
    actionCount: number;
    origin: 'inferred' | 'existing';
};

export type PageIdentity = {
    workspaceName: string;
    tabName: string;
    url: string;
};

export type AnnotatorOpenResult = {
    workspaceName: string;
    tabName: string;
    url: string;
    pageKind: EntityKind;
    profileName: string | null;
    canvasDraft: CanvasDraft | null;
    artifactRevision: string | null;
    visualTargetRefs: VisualTargetRef[];
};

export type AnnotatorPickResult = {
    candidateChain: PickCandidate[];
    matchedNodeIds: string[];
    resolution: PickResolution;
};

export type AnnotatorRecognizeResult = {
    canvasDraft: CanvasDraft;
    recognized: RecognizedItem[];
};

export type AnnotatorCheckResult = {
    results: CheckResultByAnnotation[];
    stale: boolean;
};

export type AnnotatorSaveResult = {
    profileName: string;
    artifactRevision: string;
    saved: true;
};
