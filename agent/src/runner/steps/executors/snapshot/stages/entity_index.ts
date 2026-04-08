import crypto from 'node:crypto';
import { getNodeBbox, getNodeContent, normalizeText } from '../core/runtime_store';
import type {
    EntityIndex,
    GroupEntity,
    NodeEntityRef,
    RegionEntity,
    UnifiedNode,
} from '../core/types';
import { detectGroups, type GroupDetection } from './groups';
import { detectRegionEntities, type RegionDetection } from './regions';

export type StructureDetection = {
    regions: RegionDetection[];
    groups: GroupDetection[];
};

export type BuildEntityIndexOptions = {
    includeDescendants?: boolean;
};

export const detectStructure = (root: UnifiedNode): StructureDetection => {
    return {
        regions: detectRegionEntities(root),
        groups: detectGroups(root),
    };
};

export const buildStructureEntityIndex = (
    root: UnifiedNode,
    structure?: StructureDetection,
    options?: BuildEntityIndexOptions,
): EntityIndex => {
    const includeDescendants = options?.includeDescendants !== false;
    const nodeById = new Map<string, UnifiedNode>();
    const parentById = new Map<string, UnifiedNode | null>();
    indexTree(root, null, nodeById, parentById);

    const nextStructure = structure || detectStructure(root);
    const entityIndex: EntityIndex = {
        entities: {},
        byNodeId: {},
    };
    const usedEntityIds = new Set<string>();
    const regionEntities: RegionEntity[] = [];
    const groupEntities: Array<{ entity: GroupEntity; slotByItemId: Record<string, string[]> }> = [];

    for (const region of nextStructure.regions) {
        const node = nodeById.get(region.nodeId);
        if (!node) continue;

        const id = ensureUniqueEntityId(
            usedEntityIds,
            makeEntityId('region', region.kind, `${region.nodeId}|${region.name || ''}`),
        );
        const regionEntity: RegionEntity = {
            id,
            type: 'region',
            kind: region.kind,
            nodeId: region.nodeId,
            name: region.name || normalizeText(node.name || getNodeContent(node)),
            bbox: getNodeBbox(node),
        };
        regionEntities.push(regionEntity);
        entityIndex.entities[id] = regionEntity;
    }

    for (const group of nextStructure.groups) {
        if (!nodeById.has(group.containerId)) continue;
        const itemIds = group.itemIds.filter((itemId) => nodeById.has(itemId));
        if (itemIds.length < 2) continue;

        const id = ensureUniqueEntityId(
            usedEntityIds,
            makeEntityId('group', group.kind, `${group.containerId}|${itemIds.join(',')}|${group.keySlot}`),
        );
        const entity: GroupEntity = {
            id,
            type: 'group',
            kind: group.kind,
            containerId: group.containerId,
            itemIds,
            keySlot: group.keySlot,
        };
        groupEntities.push({
            entity,
            slotByItemId: group.slotByItemId,
        });
        entityIndex.entities[id] = entity;
    }

    for (const region of regionEntities) {
        pushNodeRef(entityIndex.byNodeId, region.nodeId, {
            type: 'region',
            entityId: region.id,
            role: 'container',
        });
    }

    for (const groupBundle of groupEntities) {
        const group = groupBundle.entity;
        pushNodeRef(entityIndex.byNodeId, group.containerId, {
            type: 'group',
            entityId: group.id,
            role: 'container',
        });

        for (const itemId of group.itemIds) {
            const itemNode = nodeById.get(itemId);
            if (!itemNode) continue;

            pushNodeRef(entityIndex.byNodeId, itemId, {
                type: 'group',
                entityId: group.id,
                role: 'item',
                itemId,
            });

            if (!includeDescendants) continue;
            const slotByNodeId = new Map<string, number>();
            const slotNodeIds = groupBundle.slotByItemId[itemId] || [];
            for (let slotIndex = 0; slotIndex < slotNodeIds.length; slotIndex += 1) {
                const slotNodeId = slotNodeIds[slotIndex];
                if (!slotNodeId) continue;
                slotByNodeId.set(slotNodeId, slotIndex);
            }

            walkDescendants(itemNode, (descendant) => {
                if (descendant.id === itemId) return;
                pushNodeRef(entityIndex.byNodeId, descendant.id, {
                    type: 'group',
                    entityId: group.id,
                    role: 'descendant',
                    itemId,
                    slotIndex: resolveSlotIndex(descendant.id, itemId, slotByNodeId, parentById),
                });
            });
        }
    }

    return entityIndex;
};

const resolveSlotIndex = (
    nodeId: string,
    itemId: string,
    slotByNodeId: Map<string, number>,
    parentById: Map<string, UnifiedNode | null>,
): number | undefined => {
    let cursorId: string | undefined = nodeId;
    while (cursorId && cursorId !== itemId) {
        const slotIndex = slotByNodeId.get(cursorId);
        if (slotIndex !== undefined) return slotIndex;
        const parentNode: UnifiedNode | null = parentById.get(cursorId) || null;
        cursorId = parentNode ? parentNode.id : undefined;
    }
    return undefined;
};

const pushNodeRef = (
    byNodeId: EntityIndex['byNodeId'],
    nodeId: string,
    ref: NodeEntityRef,
) => {
    const current = byNodeId[nodeId] || [];
    if (current.some((item) => isSameRef(item, ref))) {
        byNodeId[nodeId] = current;
        return;
    }
    current.push(ref);
    byNodeId[nodeId] = current;
};

const isSameRef = (left: NodeEntityRef, right: NodeEntityRef): boolean => {
    return (
        left.type === right.type &&
        left.entityId === right.entityId &&
        left.role === right.role &&
        left.itemId === right.itemId &&
        left.slotIndex === right.slotIndex
    );
};

const ensureUniqueEntityId = (used: Set<string>, candidate: string): string => {
    if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
    }
    let index = 2;
    while (used.has(`${candidate}_${index}`)) {
        index += 1;
    }
    const next = `${candidate}_${index}`;
    used.add(next);
    return next;
};

const makeEntityId = (type: 'region' | 'group', kind: string, seed: string): string => {
    const hash = crypto.createHash('sha1').update(`${type}|${kind}|${seed}`).digest('hex').slice(0, 12);
    return `ent_${type}_${kind}_${hash}`;
};

const indexTree = (
    node: UnifiedNode,
    parent: UnifiedNode | null,
    nodeById: Map<string, UnifiedNode>,
    parentById: Map<string, UnifiedNode | null>,
) => {
    nodeById.set(node.id, node);
    parentById.set(node.id, parent);
    for (const child of node.children) {
        indexTree(child, node, nodeById, parentById);
    }
};

const walkDescendants = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walkDescendants(child, visitor);
    }
};
