import type { SnapshotResult, UnifiedNode } from './types';

type BuildSnapshotInput = {
    root: UnifiedNode;
    nodeIndex?: SnapshotResult['nodeIndex'];
    entityIndex?: SnapshotResult['entityIndex'];
    locatorIndex?: SnapshotResult['locatorIndex'];
    bboxIndex?: SnapshotResult['bboxIndex'];
    attrIndex?: SnapshotResult['attrIndex'];
    contentStore?: SnapshotResult['contentStore'];
    cacheStats?: SnapshotResult['cacheStats'];
};

export const buildSnapshot = (input: UnifiedNode | BuildSnapshotInput): SnapshotResult => {
    const payload = isUnifiedNode(input) ? { root: input } : input;
    return {
        root: payload.root,
        nodeIndex: payload.nodeIndex || {},
        entityIndex: payload.entityIndex || {},
        locatorIndex: payload.locatorIndex || {},
        bboxIndex: payload.bboxIndex || {},
        attrIndex: payload.attrIndex || {},
        contentStore: payload.contentStore || {},
        cacheStats: payload.cacheStats,
    };
};

const isUnifiedNode = (value: UnifiedNode | BuildSnapshotInput): value is UnifiedNode => {
    return (
        typeof value === 'object' &&
        value !== null &&
        'children' in value &&
        Array.isArray((value as UnifiedNode).children) &&
        !('root' in value)
    );
};
