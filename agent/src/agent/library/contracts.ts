export type LibraryAssetKind =
    | 'automation'
    | 'procedure'
    | 'recovery'
    | 'demonstration'
    | 'page_knowledge';

export const LIBRARY_ASSET_KINDS: readonly LibraryAssetKind[] = Object.freeze([
    'automation',
    'procedure',
    'recovery',
    'demonstration',
    'page_knowledge',
]);

export type LibraryAssetId = Readonly<{
    kind: LibraryAssetKind;
    name: string;
}>;

export type DependencyHealth = 'ready' | 'needs_review' | 'broken' | 'unknown';

export type AssetCapabilities = Readonly<{
    runtimeApplied: boolean;
    callableFromDsl: boolean;
    agentDiscovery: boolean;
    runnerRecovery: boolean;
    agentRecovery: boolean;
    replayable: boolean;
    modelLoadSeam: boolean;
}>;

export type LibraryAssetReference = Readonly<{
    kind: 'procedure' | 'recovery' | 'page_knowledge';
    name: string;
}>;

export type LibraryAssetSummaryBase = Readonly<{
    name: string;
    title: string;
    updatedAt: number;
    revision: string;
    dependencies: readonly LibraryAssetReference[];
    health: DependencyHealth;
    capabilities: AssetCapabilities;
}>;

export type AutomationSummary = LibraryAssetSummaryBase & Readonly<{
    kind: 'automation';
    purpose: string;
}>;

export type ProcedureSummary = LibraryAssetSummaryBase & Readonly<{
    kind: 'procedure';
    meaning: string;
    inputs: readonly string[];
    outputs: readonly string[];
}>;

export type RecoverySummary = LibraryAssetSummaryBase & Readonly<{
    kind: 'recovery';
    meaning: string;
    triggerSummary: Readonly<{
        rules: readonly string[];
        entityRules: boolean;
    }>;
    policySummary: Readonly<{
        maxAttempts?: number;
        retryOriginal: boolean;
    }>;
}>;

export type DemonstrationSummary = LibraryAssetSummaryBase & Readonly<{
    kind: 'demonstration';
    meaning: string;
    pageScope: readonly string[];
    stepCount: number;
    replayable: boolean;
}>;

export type PageKnowledgeSummary = LibraryAssetSummaryBase & Readonly<{
    kind: 'page_knowledge';
    meaning: string;
    applicability: Readonly<{kind: string; urlPattern?: string}>;
    entityCount: number;
    fieldCount: number;
    actionCount: number;
    rowActionCount: number;
    primaryKey?: string;
    safety: Readonly<{
        reversible: number;
        compensatable: number;
        irreversible: number;
        unknown: number;
    }>;
}>;

export type LibraryAssetSummary =
    | AutomationSummary
    | ProcedureSummary
    | RecoverySummary
    | DemonstrationSummary
    | PageKnowledgeSummary;

export type LibraryAssetEvidenceDependency = Readonly<{
    kind: 'procedure' | 'recovery' | 'page_knowledge';
    name: string;
    revision: string | null;
}>;

export type AssetValidationEvidence = Readonly<{
    assetKind: LibraryAssetKind;
    assetName: string;
    assetRevision: string | null;
    outcome: 'ready' | 'broken';
    dependencies: readonly LibraryAssetEvidenceDependency[];
    summary: Readonly<{
        codes: readonly string[];
        message: string;
    }>;
    validatedAt: number;
}>;

export type LibraryListOptions = Readonly<{
    kind?: LibraryAssetKind;
    limit?: number;
}>;

export type LibraryBodyLoadResult =
    | Readonly<{
        status: 'loaded';
        kind: 'automation';
        name: string;
        source: string;
        revision: string;
    }>
    | Readonly<{
        status: 'loaded';
        kind: 'procedure';
        name: string;
        body: string;
        revision: string;
    }>
    | Readonly<{
        status: 'loaded';
        kind: 'demonstration';
        name: string;
        steps: readonly unknown[];
        revision: string;
    }>
    | Readonly<{status: 'not_found'; kind: LibraryAssetKind; name: string}>
    | Readonly<{status: 'unsupported'; kind: 'recovery' | 'page_knowledge'; name: string}>;

export type Library = Readonly<{
    list(options?: LibraryListOptions): Promise<readonly LibraryAssetSummary[]>;
    summary(id: LibraryAssetId): Promise<LibraryAssetSummary | null>;
    loadBody(id: LibraryAssetId): Promise<LibraryBodyLoadResult>;
    validate(id: LibraryAssetId): Promise<AssetValidationEvidence>;
    health(id: LibraryAssetId): Promise<DependencyHealth>;
}>;