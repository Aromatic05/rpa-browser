export type RawData = {
    domTree: unknown;
    a11yTree: unknown;
};

export type BBox = { x: number; y: number; width: number; height: number };

export type Content =
    | string
    | { ref: string };

export type UnifiedNode = {
    id: string;
    role: string;
    children: UnifiedNode[];
    name?: string;
    content?: Content;
    target?: {
        ref: string;
        kind?: 'url' | 'hash' | 'mailto' | 'tel' | 'javascript' | 'download' | 'unknown';
    };
    tier?: NodeTier;
};

export type NodeGraph = {
    root: UnifiedNode;
};

export type NodeTier = 'A' | 'B' | 'C' | 'D';

export type EntityKind = 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar';

export type Entity = {
    id: string;
    kind: EntityKind;
    nodeId: string;
    name?: string;
    bbox?: BBox;
    childNodeIds?: string[];
};

export type Locator = {
    origin: {
        primaryDomId: string;
        sourceDomIds?: string[];
    };
    direct?: {
        kind: string;
        query: string;
        source: string;
        fallback?: string;
    };
    scope?: {
        id: string;
        kind: string;
    };
    policy?: {
        preferDirect?: boolean;
        preferScopedSearch?: boolean;
        requireVisible?: boolean;
        allowIndexDrift?: boolean;
        allowFuzzy?: boolean;
    };
};

export type NodeIndex = Record<string, UnifiedNode>;
export type EntityIndex = Record<string, Entity>;
export type LocatorIndex = Record<string, Locator>;
export type BBoxIndex = Record<string, BBox>;
export type AttrIndex = Record<string, Record<string, string>>;
export type ContentStore = Record<string, string>;

export type NodeSemanticHints = {
    entityNodeId?: string;
    entityKind?: EntityKind;
    fieldLabel?: string;
    actionIntent?: string;
    actionTargetNodeId?: string;
};

export type SnapshotCacheStats = {
    bucketTotal: number;
    bucketHit: number;
    bucketMiss: number;
};

export type SnapshotResult = {
    root: UnifiedNode;
    nodeIndex: NodeIndex;
    entityIndex: EntityIndex;
    locatorIndex: LocatorIndex;
    bboxIndex: BBoxIndex;
    attrIndex: AttrIndex;
    contentStore: ContentStore;
    cacheStats?: SnapshotCacheStats;
};
