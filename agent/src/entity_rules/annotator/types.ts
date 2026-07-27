import type { EntityKind } from '../../runner/steps/executors/snapshot/core/types';
import type {
    EntityRuleExpect as RuleExpect,
    EntityRuleMatch,
    EntityRuleSource,
} from '../../runner/steps/executors/snapshot/entity_rules/types';

export type { EntityKind };
export type EntityRuleExpect = RuleExpect;

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

export type PreservedPathKind = 'value';

export type PreservedSubPath = {
    subPath: Array<string | number>;
    kind: PreservedPathKind;
};

export type PreservedLocatorRule = {
    preservedKey: string;
    originalRuleId: string;
    source: EntityRuleSource;
    expect: EntityRuleExpect;
    within?: string;
    match: EntityRuleMatch;
};

export type PreservedRuleRef = {
    canvasAnnotationId: string;
    refPath: string[];
    preservedKey: string;
};

export type PreservedArtifactData = {
    matchRaw: unknown;
    annotationRaw: unknown;
    preservedByCanvasId: Record<string, PreservedSubPath[]>;
    ruleIdToCanvasId: Record<string, string>;
    locatorRules: PreservedLocatorRule[];
    ruleRefs: PreservedRuleRef[];
};

export type CanvasDraft = {
    version: number;
    profileName: string;
    page: CanvasPageDraft;
    entities: CanvasEntityDraft[];
    preserved: PreservedArtifactData;
};

export type CompileResult =
    | {
        ok: true;
        artifact: import('../../workflow/entity_rules').WorkflowEntityRules;
        ruleIdByAnnotationId: Record<string, string>;
        ruleIdByEntityId: Record<string, string>;
    }
    | { ok: false; errors: string[] };

export type CanvasValidationResult =
    | { ok: true }
    | { ok: false; errors: string[] };
