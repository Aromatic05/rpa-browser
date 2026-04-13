import { normalizeText } from './runtime_store';
import type { FinalEntityRecord, SnapshotResult } from './types';

export type EntityOutputRecord = {
    id: string;
    entity_id?: string;
    node_id: string;
    type: 'region' | 'group';
    kind: string;
    name?: string;
    business_tag?: string;
    source: 'auto' | 'overlay_add';
    item_ids?: string[];
    key_slot?: number;
};

export const toEntityOutputRecord = (entity: FinalEntityRecord): EntityOutputRecord => ({
    id: entity.id,
    entity_id: entity.entityId,
    node_id: entity.nodeId,
    type: entity.type,
    kind: entity.kind,
    name: entity.name,
    business_tag: entity.businessTag,
    source: entity.source,
    item_ids: entity.itemIds,
    key_slot: entity.keySlot,
});

export const buildNodeSummary = (snapshot: SnapshotResult, nodeId: string) => {
    const node = snapshot.nodeIndex[nodeId];
    if (!node) return null;
    return {
        node_id: nodeId,
        role: node.role,
        name: normalizeText(node.name),
        bbox: snapshot.bboxIndex[nodeId],
    };
};
