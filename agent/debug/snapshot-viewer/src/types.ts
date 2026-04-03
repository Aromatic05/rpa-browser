export type SourceKind = 'domTree' | 'a11yTree' | 'unifiedGraph';

export type TreeNodeLike = {
  id: string;
  role?: string;
  tag?: string;
  name?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  children: TreeNodeLike[];
};

export type DataPack = {
  domTree: unknown;
  a11yTree: unknown;
  unifiedGraph: unknown;
};

export type SnapshotApiResponse = {
  ok: boolean;
  data?: {
    url: string;
    domTree: unknown;
    a11yTree: unknown;
    unifiedGraph: unknown;
  };
  error?: string;
};
