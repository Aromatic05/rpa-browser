import type {
    ActivityFacts,
    AnalysisDiagnostic,
    ObservationNodeId,
    RuntimeStateRecord,
} from '../observation/model/contracts';
import type {PageSessionRefreshReason, PageSnapshotSessionEntry} from '../session/contracts';

export type SnapshotProjectionFilter = {
    role?: string | string[];
    text?: string;
    interactive?: boolean;
};

export type SnapshotProjectionOptions = {
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
    attributes?: Record<string, string>;
    runtimeState?: RuntimeStateRecord;
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

export type SnapshotProjectionCollectionReport = {
    kind: 'nodes' | 'table-rows';
    collectionId: string;
    total: number;
    included: number;
    omitted: number;
    policy: 'full' | 'contain-scope' | 'depth-limit' | 'projection-filter' | 'diff';
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

export type SnapshotProjectionMeta = {
    snapshotId: string;
    pageEpoch: string;
    captureRevision: number;
    pageUrl: string;
    refreshReason: PageSessionRefreshReason;
    mode: 'full' | 'diff';
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
