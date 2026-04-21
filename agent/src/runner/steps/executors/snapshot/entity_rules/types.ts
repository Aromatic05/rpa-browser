import type {
    EntityBusinessInfo,
    EntityColumn,
    EntityIndex,
    EntityKind,
    EntityPrimaryKey,
    GroupEntity,
    NodeSemanticHints,
    RegionEntity,
} from '../core/types';

export type EntityRuleSource = 'region' | 'group' | 'node';
export type EntityRuleExpect = 'unique' | 'one_or_more';
export type EntityRuleRelation = 'pagination';

export type EntityRulePage = {
    kind: EntityKind;
    urlPattern?: string;
};

export type EntityRuleKeyHintMatch = {
    headerContainsAll?: string[];
    primaryKeyCandidatesContains?: string[];
};

export type EntityRuleMatch = {
    kind?: EntityKind;
    nameContains?: string;
    keyHint?: EntityRuleKeyHintMatch;
    relation?: EntityRuleRelation;
    classContains?: string;
    textContains?: string;
    ariaContains?: string;
};

export type EntityMatchRule = {
    ruleId: string;
    source: EntityRuleSource;
    expect: EntityRuleExpect;
    within?: string;
    match: EntityRuleMatch;
};

export type EntityRuleSet = {
    version: number;
    page: EntityRulePage;
    entities: EntityMatchRule[];
};

export type EntityColumnAnnotation = EntityColumn;
export type EntityPrimaryKeyAnnotation = EntityPrimaryKey;

export type EntityAnnotationRule = {
    ruleId: string;
    businessTag?: string;
    businessName?: string;
    primaryKey?: EntityPrimaryKeyAnnotation;
    columns?: EntityColumnAnnotation[];
    fieldKey?: string;
    actionIntent?: string;
};

export type EntityAnnotationSet = {
    version: number;
    page: EntityRulePage;
    annotations: EntityAnnotationRule[];
};

export type NodeBusinessHint = Pick<NodeSemanticHints, 'entityNodeId' | 'entityKind' | 'actionIntent'> & {
    fieldKey?: string;
};

export type RuleBindingEntityRef = {
    entityId: string;
    nodeId: string;
    kind: EntityKind;
    type: 'region' | 'group';
};

export type ResolvedRuleBinding = {
    ruleId: string;
    source: EntityRuleSource;
    expect: EntityRuleExpect;
    matchedEntityRefs: RuleBindingEntityRef[];
    matchedNodeIds: string[];
    ok: boolean;
};

export type BusinessEntityOverlay = {
    byRuleId: Record<string, ResolvedRuleBinding | undefined>;
    byEntityId: Record<string, EntityBusinessInfo | undefined>;
    nodeHintsByNodeId: Record<string, NodeBusinessHint | undefined>;
};

export type NormalizedEntityRule = EntityMatchRule & {
    order: number;
};

export type NormalizedEntityRuleBundle = {
    id: string;
    page: EntityRulePage;
    matchRules: NormalizedEntityRule[];
    annotationByRuleId: Record<string, EntityAnnotationRule | undefined>;
};

export type ValidateEntityRulesResult = {
    ok: true;
    bundle: NormalizedEntityRuleBundle;
} | {
    ok: false;
    errors: string[];
};

export type LoadEntityRulesOptions = {
    rulesRootDir?: string;
    pageUrl?: string;
    pageKind?: EntityKind;
};

export type LoadEntityRulesResult = {
    bundle?: NormalizedEntityRuleBundle;
    errors: string[];
};

export type EntityMatchContext = {
    root: {
        id: string;
        children: unknown[];
    };
    entityIndex: EntityIndex;
    nodeIndex?: Record<string, { id: string; children: unknown[] }>;
};

export type EntityCandidate =
    | {
          source: 'node';
          nodeId: string;
          kind?: EntityKind;
          name?: string;
      }
    | {
          source: 'region';
          entity: RegionEntity;
          nodeId: string;
      }
    | {
          source: 'group';
          entity: GroupEntity;
          nodeId: string;
      };
