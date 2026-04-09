export type SourceKind = 'unifiedGraph';

export type Content = string | { ref: string };

export type TreeNodeLike = {
  id: string;
  role?: string;
  name?: string;
  content?: Content;
  target?: {
    ref?: string;
    kind?: string;
  };
  children: TreeNodeLike[];
};

export type RegionEntityLike = {
  id: string;
  type: 'region';
  kind: string;
  nodeId: string;
  name?: string;
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type GroupEntityLike = {
  id: string;
  type: 'group';
  kind: string;
  containerId: string;
  itemIds: string[];
  keySlot: number;
};

export type EntityRecordLike = RegionEntityLike | GroupEntityLike;

export type NodeEntityRefLike = {
  type: 'region' | 'group';
  entityId: string;
  role: 'container' | 'item' | 'descendant';
  itemId?: string;
  slotIndex?: number;
};

export type EntityIndexLike = {
  entities: Record<string, EntityRecordLike>;
  byNodeId: Record<string, NodeEntityRefLike[] | undefined>;
};

export type LocatorLike = {
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

export type SnapshotGraphLike = {
  root: TreeNodeLike;
  nodeIndex?: Record<string, TreeNodeLike>;
  entityIndex?: EntityIndexLike;
  locatorIndex?: Record<string, LocatorLike>;
  bboxIndex?: Record<string, { x: number; y: number; width: number; height: number }>;
  attrIndex?: Record<string, Record<string, unknown>>;
  contentStore?: Record<string, string>;
  cacheStats?: {
    bucketTotal: number;
    bucketHit: number;
    bucketMiss: number;
  };
};

export type DataPack = {
  snapshot: SnapshotGraphLike | null;
};

export type SnapshotApiResponse = {
  ok: boolean;
  data?: {
    url: string;
    unifiedGraph: SnapshotGraphLike | TreeNodeLike | unknown;
  };
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
  raw?: {
    domTree?: unknown;
    a11yTree?: unknown;
  };
  snapshot?: unknown;
  meta?: Record<string, unknown>;
};

export type CaptureListApiResponse = {
  ok: boolean;
  data?: {
    storeDir: string;
    items: CaptureListItem[];
  };
  error?: string;
};

export type CaptureItemApiResponse = {
  ok: boolean;
  data?: CaptureEnvelope;
  error?: string;
};
