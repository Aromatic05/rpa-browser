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
    tier?: NodeTier;
    entityId?: string;
    entityType?: string;
    parentEntityId?: string;
    fieldLabel?: string;
    actionIntent?: string;
    actionTargetId?: string;
    tableRole?: 'table' | 'row' | 'cell' | 'header_cell';
    formRole?: 'form' | 'field_group' | 'field' | 'submit_area';
};

export type NodeGraph = {
    root: UnifiedNode;
};

export type NodeTier = 'A' | 'B' | 'C' | 'D';

export type SnapshotResult = {
    root: UnifiedNode;
};
