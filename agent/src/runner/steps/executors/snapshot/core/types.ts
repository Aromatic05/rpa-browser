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
    fieldKey?: string;
    fieldRole?: 'control' | 'label' | 'option' | 'message';
    controlKind?: string;
    actionIntent?: string;
    actionRole?: string;
    actionTargetNodeId?: string;
};

export type EntityColumnAction = {
    actionIntent: string;
    text?: string;
};

export type EntityColumn = {
    fieldKey: string;
    name?: string;
    kind?: 'text' | 'number' | 'date' | 'status' | 'action_column';
    actions?: EntityColumnAction[];
    source?: 'annotation' | 'table_meta';
    columnIndex?: number;
    headerNodeId?: string;
};

export type EntityPrimaryKey = {
    fieldKey: string;
    columns?: string[];
    source?: 'annotation' | 'table_meta';
};

export type EntityFormField = {
    fieldKey: string;
    name?: string;
    kind?: 'input' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'date';
    controlRuleId?: string;
    labelRuleId?: string;
    optionSource?: {
        kind: 'inline' | 'popup';
        optionRuleId?: string;
    };
    controlNodeId?: string;
    labelNodeId?: string;
};

export type EntityFormAction = {
    actionIntent: string;
    text?: string;
    nodeRuleId?: string;
    nodeId?: string;
};

export type TablePaginationActionBinding = {
    actionIntent: string;
    nodeRuleId: string;
    nodeId?: string;
    disabledRuleId?: string;
    disabledNodeId?: string;
};

export type TablePaginationBinding = {
    nextAction?: TablePaginationActionBinding;
};

export type EntityRuleDiagnosticLevel = 'info' | 'warning' | 'error';

export type EntityRuleDiagnosticCode =
    | 'RULE_MATCHED_ZERO'
    | 'RULE_MATCHED_MULTIPLE'
    | 'ANNOTATION_RULE_REF_NOT_FOUND'
    | 'FIELD_CONTROL_UNRESOLVED'
    | 'FIELD_LABEL_UNRESOLVED'
    | 'FORM_ACTION_UNRESOLVED'
    | 'OPTION_RULE_UNRESOLVED'
    | 'TABLE_COLUMN_HEADER_UNRESOLVED'
    | 'TABLE_ACTION_COLUMN_UNRESOLVED'
    | 'TABLE_PAGINATION_NEXT_UNRESOLVED'
    | 'TABLE_PAGINATION_NEXT_AMBIGUOUS'
    | 'TABLE_ROW_NOT_FOUND'
    | 'TABLE_ROW_ACTION_NOT_FOUND';

export type EntityRuleDiagnostic = {
    code: EntityRuleDiagnosticCode;
    level: EntityRuleDiagnosticLevel;
    message: string;
    profile?: string;
    ruleId?: string;
    annotationId?: string;
    entityId?: string;
    businessTag?: string;
    fieldKey?: string;
    actionIntent?: string;
    columnName?: string;
    nodeIds?: string[];
    details?: Record<string, unknown>;
};

export type EntityTableMeta = {
    rowCount: number;
    columnCount: number;
    headers: string[];
    rowNodeIds: string[];
    cellNodeIdsByRowNodeId: Record<string, string[] | undefined>;
    columnCellNodeIdsByHeader: Record<string, string[] | undefined>;
    primaryKeyCandidates: Array<{
        columns: string[];
        unique: boolean;
        duplicateCount: number;
    }>;
    recommendedPrimaryKey?: string[];
};

export type EntityBusinessInfo = {
    businessTag?: string;
    businessName?: string;
    primaryKey?: EntityPrimaryKey;
    columns?: EntityColumn[];
    formFields?: EntityFormField[];
    formActions?: EntityFormAction[];
    pagination?: TablePaginationBinding;
    tableMeta?: EntityTableMeta;
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
    ruleEntityOverlay?: {
        byRuleId: Record<string, unknown>;
        byEntityId: Record<string, EntityBusinessInfo | undefined>;
        nodeHintsByNodeId: Record<string, NodeSemanticHints | undefined>;
        diagnostics?: EntityRuleDiagnostic[];
    };
    /**
     * @deprecated Use `ruleEntityOverlay` instead.
     */
    businessEntityOverlay?: {
        byRuleId: Record<string, unknown>;
        byEntityId: Record<string, EntityBusinessInfo | undefined>;
        nodeHintsByNodeId: Record<string, NodeSemanticHints | undefined>;
        diagnostics?: EntityRuleDiagnostic[];
    };
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

export type SnapshotManualOverlayPatch = {
    renamedNodes: Record<string, string>;
    addedEntities: SnapshotOverlayAddEntity[];
    deletedEntities: SnapshotOverlayDeleteEntity[];
};
export type SnapshotOverlays = SnapshotManualOverlayPatch;

export type FinalEntityRecord = {
    id: string;
    entityId?: string;
    nodeId: string;
    kind: EntityKind;
    type: 'region' | 'group';
    name?: string;
    businessTag?: string;
    businessName?: string;
    primaryKey?: EntityPrimaryKey;
    columns?: EntityColumn[];
    formFields?: EntityFormField[];
    formActions?: EntityFormAction[];
    pagination?: TablePaginationBinding;
    tableMeta?: EntityTableMeta;
    source: 'auto' | 'overlay_add';
    itemIds?: string[];
    keySlot?: number;
};

export type FieldBinding = {
    fieldKey: string;
    name?: string;
    controlNodeId?: string;
    labelNodeId?: string;
    kind?: string;
};

export type ActionBinding = {
    actionIntent: string;
    nodeId?: string;
    text?: string;
};

export type ColumnBinding = {
    fieldKey: string;
    name?: string;
    kind?: string;
    columnIndex?: number;
    headerNodeId?: string;
};

export type BusinessBindingIndex = {
    fieldsByEntity: Record<string, Record<string, FieldBinding | undefined> | undefined>;
    actionsByEntity: Record<string, Record<string, ActionBinding | undefined> | undefined>;
    columnsByEntity: Record<string, Record<string, ColumnBinding | undefined> | undefined>;
};

export type FinalEntityView = {
    entities: FinalEntityRecord[];
    byNodeId: Record<string, FinalEntityRecord[] | undefined>;
    bindingIndex: BusinessBindingIndex;
    diagnostics?: EntityRuleDiagnostic[];
};

export type SnapshotPageIdentity = {
    workspaceName: string;
    tabName: string;
    tabName: string;
    url: string;
};

export type SnapshotSessionEntry = {
    pageIdentity: SnapshotPageIdentity;
    baseSnapshot?: SnapshotResult;
    finalSnapshot?: SnapshotResult;
    finalEntityView?: FinalEntityView;
    diffBaselines?: Record<string, SnapshotDiffBaselineEntry>;
    overlays: SnapshotManualOverlayPatch;
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
