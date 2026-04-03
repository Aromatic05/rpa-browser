export type SourceKind = 'unifiedGraph';

export type TreeNodeLike = {
  id: string;
  role?: string;
  tag?: string;
  name?: string;
  content?: string;
  text?: string;
  target?: {
    ref?: string;
    kind?: string;
  };
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  attrs?: Record<string, unknown>;
  children: TreeNodeLike[];
};

export type DataPack = {
  unifiedGraph: unknown;
};

export type SnapshotApiResponse = {
  ok: boolean;
  data?: {
    url: string;
    unifiedGraph: unknown;
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
