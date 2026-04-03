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
