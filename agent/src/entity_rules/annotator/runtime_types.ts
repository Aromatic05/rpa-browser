import type { BBox, EntityKind } from '../../runner/steps/executors/snapshot/core/types';
import type { EntityRuleExpect } from '../../runner/steps/executors/snapshot/entity_rules/types';
import type { CanvasDraft, PersistentTargetDraft } from './types';

export type { EntityKind };
export type { BBox };

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

export type PickCandidateEntityRef = {
    entityId: string;
    nodeId: string;
    kind: EntityKind;
    type: 'region' | 'group' | 'node';
};

export type PickPurpose = 'entity' | 'annotation';

export type PickCandidateLevel = 'control' | 'field' | 'row' | 'group' | 'region' | 'unknown';

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

export type VisualTargetRole = 'entity' | 'field' | 'action' | 'column' | 'pagination';

export type VisualTargetRef = {
    entityId: string;
    nodeId: string;
    kind?: EntityKind;
    role: VisualTargetRole;
    fieldKey?: string;
    actionIntent?: string;
    bbox?: BBox;
    matchedNodeBoxes?: BBox[];
    canvasAnnotationId?: string;
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

export type CheckStatus = 'unique' | 'multiple' | 'missing' | 'invalid';

export type CheckResultByAnnotation = {
    canvasAnnotationId: string;
    status: CheckStatus;
    matchCount: number;
    expected: EntityRuleExpect;
    message: string;
    nodeIds: string[];
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
    entityRules: import('../../workflow/entity_rules').WorkflowEntityRules;
    artifactRevision: string;
    saved: true;
};
