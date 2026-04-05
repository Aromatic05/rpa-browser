import type { SnapshotResult, UnifiedNode } from './types';

export const buildSnapshot = (root: UnifiedNode): SnapshotResult => {
    return {
        root,
        nodeIndex: {},
        entityIndex: {},
        locatorIndex: {},
        bboxIndex: {},
        attrIndex: {},
        contentStore: {},
    };
};
