import type { UnifiedNode } from './types';

const DEBUG_FLAG = process.env.RPA_SNAPSHOT_DEBUG;

export const isSnapshotDebugEnabled = (): boolean => {
    return DEBUG_FLAG === '1' || DEBUG_FLAG === 'true';
};

export const snapshotDebugLog = (stage: string, payload: Record<string, unknown>) => {
    if (!isSnapshotDebugEnabled()) return;
    console.log(`[snapshot][${stage}] ${JSON.stringify(payload)}`);
};

export const countTreeNodes = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0;
    const current = node as { children?: unknown[] };
    const children = Array.isArray(current.children) ? current.children : [];
    return 1 + children.reduce((sum, child) => sum + countTreeNodes(child), 0);
};

export const summarizeTopNodes = (node: unknown, limit = 8): Array<{ id: string; role: string; childCount: number }> => {
    if (!node || typeof node !== 'object') return [];
    const current = node as { children?: UnifiedNode[] };
    const children = Array.isArray(current.children) ? current.children : [];

    return children.slice(0, limit).map((child) => ({
        id: child.id,
        role: child.role,
        childCount: child.children.length,
    }));
};
