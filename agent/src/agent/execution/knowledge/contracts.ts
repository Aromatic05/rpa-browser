import type {
    AssetCapabilities,
    DependencyHealth,
    Library,
    LibraryAssetKind,
    LibraryAssetReference,
    PageKnowledgeSummary,
    RecoverySummary,
} from '../../library/contracts';
import type {EntityRuleExportEntry, EntityRuleExportResolution, WorkflowEntityRules} from '../../../automation/workflow';
import type {EffectReversibility} from '../../../program/effects/contracts';

/**
 * Narrow read-only port over the workspace Entity Rules surface. It exposes
 * ONLY the two lookups Knowledge inspect genuinely calls - nothing else. No
 * provider status, availability, or identity is fabricated; implementations
 * resolve the real, committed workspace provider at call time.
 */
export type KnowledgeEntityRulesPort = Readonly<{
    getProfile: (profileName: string) => WorkflowEntityRules | null;
    resolveExports: (profileName: string) => EntityRuleExportResolution;
}>;

export type KnowledgeSeamDeps = Readonly<{
    library: Library;
    entityRules: KnowledgeEntityRulesPort;
}>;

export const KNOWLEDGE_CATALOG_LIMIT_DEFAULT = 20;
export const KNOWLEDGE_CATALOG_LIMIT_MAX = 50;
export const KNOWLEDGE_INSPECT_MAX_ENTITIES = 50;

export type KnowledgeCatalogQuery = Readonly<{
    kind?: LibraryAssetKind;
    filter?: string;
    limit?: number;
}>;

export type KnowledgeBase = Readonly<{
    id: Readonly<{kind: LibraryAssetKind; name: string}>;
    title: string;
    meaning: string;
    health: DependencyHealth;
    capabilities: AssetCapabilities;
}>;

export type KnowledgeCatalogEntry =
    | (KnowledgeBase & Readonly<{kind: 'automation'; purpose: string}>)
    | (KnowledgeBase & Readonly<{kind: 'procedure'; inputs: readonly string[]; outputs: readonly string[]}>)
    | (KnowledgeBase & Readonly<{kind: 'recovery'; triggerSummary: RecoverySummary['triggerSummary']; policySummary: RecoverySummary['policySummary']}>)
    | (KnowledgeBase & Readonly<{kind: 'demonstration'; pageScope: readonly string[]; stepCount: number; replayable: boolean}>)
    | (KnowledgeBase & Readonly<{kind: 'page_knowledge'; applicability: PageKnowledgeSummary['applicability']; entityCount: number; fieldCount: number; actionCount: number; rowActionCount: number; primaryKey?: string; safety: PageKnowledgeSummary['safety']}>);

export type KnowledgeCatalogResult = Readonly<{
    count: number;
    truncated: boolean;
    entries: readonly KnowledgeCatalogEntry[];
}>;

export type KnowledgeInspectKind = Extract<LibraryAssetKind, 'procedure' | 'page_knowledge' | 'recovery' | 'demonstration' | 'automation'>;

export type KnowledgeInspectInput = Readonly<{
    kind: KnowledgeInspectKind;
    name: string;
    includeBody?: boolean;
}>;

export type ProcedureKnowledgeInspect = Readonly<{
    status: 'loaded';
    kind: 'procedure';
    name: string;
    meaning: string;
    inputs: readonly string[];
    outputs: readonly string[];
    health: DependencyHealth;
    capabilities: AssetCapabilities;
    dependencies: readonly LibraryAssetReference[];
    body?: string;
}>;

export type PageKnowledgeEntityField = Readonly<{
    fieldKey: string;
    name?: string;
    targetKind: string;
    reversibility: EffectReversibility;
}>;

export type PageKnowledgeEntityAction = Readonly<{
    actionIntent: string;
    name?: string;
    targetKind: string;
    reversibility: EffectReversibility;
}>;

export type PageKnowledgeEntityRowAction = Readonly<{
    actionIntent: string;
    name?: string;
    reversibility: EffectReversibility;
}>;

export type PageKnowledgeEntity = Readonly<{
    entityKey: string;
    businessTag: string;
    kind: EntityRuleExportEntry['kind'];
    label?: string;
    fields: readonly PageKnowledgeEntityField[];
    actions: readonly PageKnowledgeEntityAction[];
    rowActions: readonly PageKnowledgeEntityRowAction[];
    columns: readonly string[];
    supportedQueries: readonly string[];
    primaryKey?: Readonly<{fieldKey: string}>;
}>;

export type PageKnowledgeInspect = Readonly<{
    status: 'loaded';
    kind: 'page_knowledge';
    name: string;
    meaning: string;
    health: DependencyHealth;
    capabilities: AssetCapabilities;
    applicability: PageKnowledgeSummary['applicability'];
    entities: readonly PageKnowledgeEntity[];
}>;

export type KnowledgeInvalidInspect = Readonly<{
    status: 'invalid';
    kind: 'page_knowledge';
    name: string;
    meaning: string;
    health: DependencyHealth;
    diagnostics: readonly Readonly<{code: string; message: string}>[];
}>;

export type KnowledgeCatalogOnlyInspect = KnowledgeCatalogEntry & Readonly<{
    status: 'catalog_only';
    note: string;
}>;

export type KnowledgeUnsupportedInspect = Readonly<{
    status: 'unsupported';
    kind: 'automation';
    name: string;
}>;

export type KnowledgeNotFoundInspect = Readonly<{
    status: 'not_found';
    kind: KnowledgeInspectKind;
    name: string;
}>;

export type KnowledgeInspectResult =
    | ProcedureKnowledgeInspect
    | PageKnowledgeInspect
    | KnowledgeInvalidInspect
    | KnowledgeCatalogOnlyInspect
    | KnowledgeUnsupportedInspect
    | KnowledgeNotFoundInspect;

export type KnowledgeSeam = Readonly<{
    catalog: (query: KnowledgeCatalogQuery) => Promise<KnowledgeCatalogResult>;
    inspect: (input: KnowledgeInspectInput) => Promise<KnowledgeInspectResult>;
}>;