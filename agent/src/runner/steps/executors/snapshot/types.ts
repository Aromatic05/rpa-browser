export type RawData = {
    domTree: unknown;
    a11yTree: unknown;
};

export type UnifiedNode = {
    id: string;
    role: string;
    children: UnifiedNode[];
    name?: string;
    content?: string;
    target?: {
        ref: string;
        kind?: 'url' | 'hash' | 'mailto' | 'tel' | 'javascript' | 'download' | 'unknown';
    };
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
    content?: string;
    name?: string;
    target?: UnifiedNode['target'];
};

export type SnapshotResult = {
    root: UnifiedNode;
};
