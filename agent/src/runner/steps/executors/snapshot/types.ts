export type RawData = {
    domTree: unknown;
    a11yTree: unknown;
};

export type UnifiedNode = {
    id: string;
    role: string;
    children: UnifiedNode[];
    name?: string;
    text?: string;
    bbox?: { x: number; y: number; width: number; height: number };
    attrs?: Record<string, string>;
};

export type NodeGraph = {
    root: UnifiedNode;
};

export type NodeTier = 'A' | 'B' | 'C' | 'D';

export type SemanticNode = {
    id: string;
    role: string;
    tier: NodeTier;
    children: SemanticNode[];
    text?: string;
    name?: string;
};

export type SnapshotResult = {
    root: UnifiedNode;
};
