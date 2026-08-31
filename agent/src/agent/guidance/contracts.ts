import type {
    AssetValidationEvidence,
    DependencyHealth,
    LibraryAssetId,
    LibraryBodyLoadResult,
    LibraryAssetKind,
} from '../library/contracts';

export type CatalogAssetKind = LibraryAssetKind;

export type CatalogCounts =
    | Readonly<{kind: 'automation'; references: number}>
    | Readonly<{kind: 'procedure'; inputs: number; outputs: number}>
    | Readonly<{kind: 'recovery'; triggerRules: number; maxAttempts?: number}>
    | Readonly<{kind: 'demonstration'; steps: number}>
    | Readonly<{kind: 'page_knowledge'; entities: number; fields: number; actions: number}>;

export type CatalogDependency = Readonly<{
    kind: 'procedure' | 'recovery' | 'page_knowledge';
    name: string;
}>;

export type CatalogEntry = Readonly<{
    name: string;
    kind: CatalogAssetKind;
    meaning: string;
    applicability?: Readonly<{kind: string; urlPattern?: string}>;
    dependencies: readonly CatalogDependency[];
    health: DependencyHealth;
    counts: CatalogCounts;
}>;

export type CatalogListOptions = Readonly<{
    kind?: CatalogAssetKind;
    limit?: number;
}>;

export type CatalogLoadResult = LibraryBodyLoadResult;

export type GuidanceCatalog = Readonly<{
    list(options?: CatalogListOptions): Promise<readonly CatalogEntry[]>;
    entry(id: LibraryAssetId): Promise<CatalogEntry | null>;
    loadBody(id: LibraryAssetId): Promise<CatalogLoadResult>;
    validate(id: LibraryAssetId): Promise<AssetValidationEvidence>;
    health(id: LibraryAssetId): Promise<DependencyHealth>;
}>;