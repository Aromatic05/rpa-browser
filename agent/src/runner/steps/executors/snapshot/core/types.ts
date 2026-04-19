export type RawData = {
    domTree: unknown;
    a11yTree: unknown;
    runtimeStateMap?: RuntimeStateMap;
    runtimeStateCleanup?: (() => Promise<void>) | undefined;
};

export type RuntimeState = {
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

export type RuntimeStateMap = Record<string, RuntimeState | undefined>;

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

export type EntityKeyHintSource =
    | 'group_header'
    | 'group_slot'
    | 'region_header'
    | 'region_structure';

export type EntityKeyHint = {
    slot: number;
    name?: string;
    source: EntityKeyHintSource;
    confidence: number;
    headerNodeId?: string;
    sampleValues?: string[];
};

export type RegionEntity = {
    id: string;
    type: 'region';
    kind: RegionKind;
    nodeId: string;
    name?: string;
    businessTag?: string;
    source?: 'auto' | 'overlay_add';
    bbox?: BBox;
    keyHint?: EntityKeyHint;
};

export type GroupEntity = {
    id: string;
    type: 'group';
    kind: GroupKind;
    containerId: string;
    name?: string;
    businessTag?: string;
    source?: 'auto' | 'overlay_add';
    itemIds: string[];
    keySlot: number;
    keyHint?: EntityKeyHint;
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

export type SnapshotFilter = {
    role?: string | string[];
    text?: string;
    interactive?: boolean;
};

export type SnapshotDiffSkippedReason =
    | 'navigation'
    | 'no_baseline'
    | 'contain_unavailable'
    | 'too_broad';

export type SnapshotMeta = {
    mode: 'full' | 'diff';
    snapshotId: string;
    pageIdentity: SnapshotPageIdentity;
    contain?: string;
    depth?: number;
    filterSignature?: string;
    truncated?: boolean;
    baseSnapshotId?: string;
    diffRootId?: string;
    changedNodeCount?: number;
    diffSkipped?: SnapshotDiffSkippedReason;
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
    snapshotMeta?: SnapshotMeta;
};

export type SnapshotDiffBaselineKey = {
    contain: string;
    depth: number;
    filterSignature: string;
};

export type SnapshotDiffBaselineEntry = {
    snapshotId: string;
    root: UnifiedNode;
    createdAt: number;
    pageIdentity: SnapshotPageIdentity;
};

export type SnapshotOverlayAddEntity = {
    nodeId: string;
    kind: EntityKind;
    name?: string;
    businessTag?: string;
};

export type SnapshotOverlayDeleteEntity = {
    nodeId: string;
    kind?: EntityKind;
    businessTag?: string;
};

export type SnapshotOverlays = {
    renamedNodes: Record<string, string>;
    addedEntities: SnapshotOverlayAddEntity[];
    deletedEntities: SnapshotOverlayDeleteEntity[];
};

export type FinalEntityRecord = {
    id: string;
    entityId?: string;
    nodeId: string;
    kind: EntityKind;
    type: 'region' | 'group';
    name?: string;
    businessTag?: string;
    source: 'auto' | 'overlay_add';
    itemIds?: string[];
    keySlot?: number;
};

export type FinalEntityView = {
    entities: FinalEntityRecord[];
    byNodeId: Record<string, FinalEntityRecord[] | undefined>;
};

export type SnapshotPageIdentity = {
    workspaceId: string;
    tabId: string;
    tabToken: string;
    url: string;
};

export type SnapshotSessionEntry = {
    pageIdentity: SnapshotPageIdentity;
    baseSnapshot?: SnapshotResult;
    finalSnapshot?: SnapshotResult;
    finalEntityView?: FinalEntityView;
    diffBaselines?: Record<string, SnapshotDiffBaselineEntry>;
    overlays: SnapshotOverlays;
    lastRefreshAt?: number;
    lastDirtyAt?: number;
    dirty: boolean;
    staleReason?: string;
    version?: number;
    refreshInFlight?: Promise<SnapshotResult>;
};

export type SnapshotSessionStore = {
    version: number;
    entries: Record<string, SnapshotSessionEntry>;
};
