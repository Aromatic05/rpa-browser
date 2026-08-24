import type {
    ActivityFacts,
    AnalysisDiagnostic,
    Evidence,
    GeometryRecord,
    ObservationCompleteness,
    ObservationNodeId,
    RuntimeStateRecord,
    TreeScopeKind,
    TreeScopeStatus,
} from '../observation/model/contracts';
import type {PageSessionRefreshReason, PageSnapshotSessionEntry} from '../session/contracts';

export type SnapshotProjectionViewMode = 'overview' | 'interaction' | 'annotation' | 'debug' | 'full';

export type SnapshotProjectionFilter = {
    role?: string | string[];
    text?: string;
    interactive?: boolean;
};

export type SnapshotProjectionOptions = {
    mode?: SnapshotProjectionViewMode;
    contain?: string;
    depth?: number;
    filter?: SnapshotProjectionFilter;
};

export type SnapshotProjectionNode = {
    nodeId: ObservationNodeId;
    scopeId: string;
    tag: string;
    role: string;
    name?: string;
    text?: string;
    contentRef?: string;
    attributes?: Record<string, string>;
    runtimeState?: RuntimeStateRecord;
    geometry?: GeometryRecord[];
    activity: ActivityFacts;
    identity: {
        backendNodeId?: string;
        runtimeIdentityToken?: string;
    };
    controlIds: string[];
    componentIds: string[];
    children: SnapshotProjectionNode[];
};

export type SnapshotProjectionFormField = {
    id: string;
    anchorNodeId: ObservationNodeId;
    controlIds: string[];
    required?: boolean;
    status: string;
    labelNodeIds: ObservationNodeId[];
    errorNodeIds: ObservationNodeId[];
};

export type SnapshotProjectionFormAction = {
    id: string;
    nodeId: ObservationNodeId;
    controlId: string;
    structuralRole: 'submit' | 'reset' | 'button' | 'link';
};

export type SnapshotProjectionGeometry = {
    nodeId: ObservationNodeId;
    records: GeometryRecord[];
};

export type SnapshotProjectionForm = {
    id: string;
    rootNodeId: ObservationNodeId;
    hostNodeId?: ObservationNodeId;
    selectionScopeNodeId?: ObservationNodeId;
    status: string;
    boundaryKind: string;
    fields: SnapshotProjectionFormField[];
    actions: SnapshotProjectionFormAction[];
    groups: Array<{id: string; rootNodeId: ObservationNodeId; fieldIds: string[]}>;
    geometry: SnapshotProjectionGeometry[];
    validation: {ok: boolean; diagnosticCount: number};
};

export type SnapshotProjectionTableRow = {
    id: string;
    nodeId: ObservationNodeId;
    index: number;
    key?: string;
    selected?: boolean;
    expanded?: boolean;
    level?: number;
    cells: Array<{
        id: string;
        nodeId: ObservationNodeId;
        columnId: string;
        text: string;
        controlIds: string[];
    }>;
};

export type SnapshotProjectionCollectionPolicy =
    | 'full'
    | 'contain-scope'
    | 'depth-limit'
    | 'projection-filter'
    | 'feature-cover'
    | 'interaction-context'
    | 'annotation-targets'
    | 'diff';

export type SnapshotProjectionCollectionReport = {
    kind: 'nodes' | 'table-rows';
    collectionId: string;
    total: number;
    included: number;
    omitted: number;
    policy: SnapshotProjectionCollectionPolicy;
};

export type SnapshotProjectionTable = {
    id: string;
    rootNodeId: ObservationNodeId;
    hostNodeId?: ObservationNodeId;
    selectionScopeNodeId?: ObservationNodeId;
    status: string;
    columns: Array<{
        id: string;
        index: number;
        name: string;
        sourceNodeIds: ObservationNodeId[];
    }>;
    rows: SnapshotProjectionTableRow[];
    rowCollection: SnapshotProjectionCollectionReport;
    controlSlots: Array<{
        id: string;
        columnId: string;
        controlKind: string;
        occurrenceCount: number;
        controlIds: string[];
    }>;
    rowExceptions: Array<{rowId: string; controlIds: string[]}>;
    pagination?: {status: 'resolved' | 'ambiguous'; nodeIds: ObservationNodeId[]};
    geometry: SnapshotProjectionGeometry[];
    validation: {ok: boolean; diagnosticCount: number};
};

export type SnapshotProjectionSemanticBinding = {
    id: string;
    profileName: string;
    origin: string;
    disposition: string;
    status: string;
    domain: string;
    nodeIds: ObservationNodeId[];
    componentIds: string[];
    annotation: Record<string, unknown>;
};

export type SnapshotProjectionDebug = {
    completeness: ObservationCompleteness;
    scopes: Array<{
        id: string;
        kind: TreeScopeKind;
        status: TreeScopeStatus;
        parentScopeId?: string;
        hostNodeId?: ObservationNodeId;
        rootNodeId: ObservationNodeId;
        unavailableReason?: string;
        completeness: ObservationCompleteness;
    }>;
    componentEvidence: {
        forms: Array<{id: string; evidence: Evidence[]; diagnostics: AnalysisDiagnostic[]}>;
        tables: Array<{id: string; evidence: Evidence[]; diagnostics: AnalysisDiagnostic[]}>;
    };
};

export type SnapshotProjectionMeta = {
    snapshotId: string;
    pageEpoch: string;
    captureRevision: number;
    pageUrl: string;
    refreshReason: PageSessionRefreshReason;
    mode: 'full' | 'diff';
    viewMode: SnapshotProjectionViewMode;
    containNodeIds: ObservationNodeId[];
    depth: number;
    filterSignature: string;
    totalNodeCount: number;
    includedNodeCount: number;
    baseSnapshotId?: string;
    diffSkipped?: 'no_baseline' | 'navigation' | 'correlation_ambiguous';
    changedNodeCount: number;
    changedComponentIds: string[];
    removedNodeKeys: string[];
};

export type SnapshotProjection = {
    schemaVersion: 2;
    meta: SnapshotProjectionMeta;
    roots: SnapshotProjectionNode[];
    components: {
        forms: SnapshotProjectionForm[];
        tables: SnapshotProjectionTable[];
    };
    semantics: SnapshotProjectionSemanticBinding[];
    collections: SnapshotProjectionCollectionReport[];
    diagnostics: AnalysisDiagnostic[];
    debug?: SnapshotProjectionDebug;
};

export type SnapshotProjectionBuildResult =
    | {ok: true; projection: SnapshotProjection}
    | {ok: false; error: {code: 'ERR_BAD_ARGS' | 'ERR_NOT_FOUND'; message: string; details?: unknown}};

export type SnapshotProjectionDiffResult = {
    mode: 'full' | 'diff';
    projection: SnapshotProjection;
};

export type SnapshotProjectionBaseline = {
    key: string;
    projection: SnapshotProjection;
    createdAt: number;
};

export type SnapshotProjectionBaselinePort<Key extends object> = {
    read: (pageKey: Key, key: string) => SnapshotProjectionBaseline | undefined;
    write: (pageKey: Key, baseline: SnapshotProjectionBaseline) => void;
    clear: (pageKey: Key) => void;
};

export type BuildSnapshotProjectionInput = {
    entry: PageSnapshotSessionEntry;
    options?: SnapshotProjectionOptions;
};
