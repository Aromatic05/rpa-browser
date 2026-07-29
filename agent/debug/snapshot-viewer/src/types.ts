export type ProjectionGeometryRecord = {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace?: string;
  source?: string;
};

export type ProjectionNode = {
  nodeId: string;
  scopeId: string;
  tag: string;
  role: string;
  name?: string;
  text?: string;
  contentRef?: string;
  attributes?: Record<string, string>;
  runtimeState?: Record<string, unknown>;
  geometry?: ProjectionGeometryRecord[];
  activity: Record<string, unknown>;
  identity: {backendNodeId?: string; runtimeIdentityToken?: string};
  controlIds: string[];
  componentIds: string[];
  children: ProjectionNode[];
};

export type ProjectionForm = {
  id: string;
  rootNodeId: string;
  hostNodeId?: string;
  selectionScopeNodeId?: string;
  status: string;
  boundaryKind: string;
  fields: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
  geometry: Array<Record<string, unknown>>;
  validation: {ok: boolean; diagnosticCount: number};
};

export type ProjectionTable = {
  id: string;
  rootNodeId: string;
  hostNodeId?: string;
  selectionScopeNodeId?: string;
  status: string;
  columns: Array<Record<string, unknown>>;
  rows: Array<Record<string, unknown>>;
  rowCollection: Record<string, unknown>;
  controlSlots: Array<Record<string, unknown>>;
  rowExceptions: Array<Record<string, unknown>>;
  pagination?: Record<string, unknown>;
  geometry: Array<Record<string, unknown>>;
  validation: {ok: boolean; diagnosticCount: number};
};

export type ProjectionSemanticBinding = {
  id: string;
  profileName: string;
  origin: string;
  disposition: string;
  status: string;
  domain: 'form' | 'table' | 'node';
  nodeIds: string[];
  componentIds: string[];
  annotation: Record<string, unknown>;
};

export type ProjectionDiagnostic = {
  code: string;
  severity: string;
  stage: string;
  status: string;
  message: string;
  nodeIds?: string[];
};

export type SnapshotProjection = {
  schemaVersion: 2;
  meta: {
    snapshotId: string;
    pageEpoch: string;
    captureRevision: number;
    pageUrl: string;
    refreshReason: string;
    mode: 'full' | 'diff';
    viewMode: string;
    containNodeIds: string[];
    depth: number;
    filterSignature: string;
    totalNodeCount: number;
    includedNodeCount: number;
    baseSnapshotId?: string;
    diffSkipped?: string;
    changedNodeCount: number;
    changedComponentIds: string[];
    removedNodeKeys: string[];
  };
  roots: ProjectionNode[];
  components: {forms: ProjectionForm[]; tables: ProjectionTable[]};
  semantics: ProjectionSemanticBinding[];
  collections: Array<Record<string, unknown>>;
  diagnostics: ProjectionDiagnostic[];
  debug?: Record<string, unknown>;
};

export type SnapshotApiResponse = {
  ok: boolean;
  data?: {url: string; projection: SnapshotProjection};
  error?: string;
};

export type CaptureListItem = {
  id: string;
  label: string;
  capturedAt: string;
  sourceUrl?: string;
  finalUrl?: string;
  title?: string;
  hasRaw: boolean;
  hasSnapshot: boolean;
};

export type CaptureEnvelope = {
  id: string;
  label: string;
  capturedAt: string;
  sourceUrl?: string;
  finalUrl?: string;
  title?: string;
  raw?: unknown;
  snapshot?: unknown;
  meta?: Record<string, unknown>;
};

export type CaptureListApiResponse = {
  ok: boolean;
  data?: {storeDir: string; items: CaptureListItem[]};
  error?: string;
};

export type CaptureItemApiResponse = {
  ok: boolean;
  data?: CaptureEnvelope;
  error?: string;
};
