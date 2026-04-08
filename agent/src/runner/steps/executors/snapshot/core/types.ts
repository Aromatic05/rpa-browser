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

export type RegionKind = 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar';
export type GroupKind = 'table' | 'kv' | 'list';
export type EntityKind = RegionKind | GroupKind;

export type RegionEntity = {
    id: string;
    type: 'region';
    kind: RegionKind;
    nodeId: string;
    name?: string;
    bbox?: BBox;
};

export type GroupEntity = {
    id: string;
    type: 'group';
    kind: GroupKind;
    containerId: string;
    itemIds: string[];
    keySlot: number;
};

export type EntityRecord = RegionEntity | GroupEntity;

export type NodeEntityRef = {
    type: 'region' | 'group';
    entityId: string;
    role: 'container' | 'item' | 'descendant';
    itemId?: string;
    slotIndex?: number;
};

export type EntityIndex = {
    entities: Record<string, EntityRecord>;
    byNodeId: Record<string, NodeEntityRef[] | undefined>;
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
