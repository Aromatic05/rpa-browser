import crypto from 'node:crypto';
import { getNodeAttr, getNodeBbox, getNodeContent, normalizeText } from '../core/runtime_store';
import type {
    EntityKeyHint,
    EntityIndex,
    GroupEntity,
    NodeEntityRef,
    RegionEntity,
    UnifiedNode,
} from '../core/types';
import { buildStructureCandidates, selectStructureCandidates, type StructureCandidate } from './candidates';
import { detectGroups, type GroupDetection } from './groups';
import { detectRegionEntities, type RegionDetection } from './regions';
import { deriveGroupTableKeyHint, deriveRegionTableKeyHint } from './table_key';

type StructureDetection = {
    regions: RegionDetection[];
    groups: GroupDetection[];
    candidates: StructureCandidate[];
};

type BuildEntityIndexOptions = {
    includeDescendants?: boolean;
};

type StructureCandidateDetection = {
    regions: RegionDetection[];
    groups: GroupDetection[];
    candidates: StructureCandidate[];
};

export const detectStructureCandidates = (root: UnifiedNode): StructureCandidateDetection => {
    const regions = detectRegionEntities(root);
    const groups = detectGroups(root);
    const candidates = buildStructureCandidates(root, { regions, groups });
    return {
        regions,
        groups,
        candidates,
    };
};

const detectStructure = (root: UnifiedNode): StructureDetection => {
    const detected = detectStructureCandidates(root);
    const selected = selectStructureCandidates(root, detected.candidates);
    return {
        regions: selected.regions,
        groups: selected.groups,
        candidates: selected.candidates,
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
    const groupKeyHintByContainerId = new Map<string, EntityKeyHint>();

    for (const group of nextStructure.groups) {
        if (group.kind !== 'table') continue;
        const keyHint = deriveGroupTableKeyHint(group, nodeById, parentById);
        if (!keyHint) continue;
        groupKeyHintByContainerId.set(group.containerId, keyHint);
    }

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
            keyHint:
                region.kind === 'table'
                    ? deriveRegionTableKeyHint(
                        region.nodeId,
                        nextStructure.groups,
                        groupKeyHintByContainerId,
                        nodeById,
                        parentById,
                    )
                    : undefined,
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
            keyHint: group.kind === 'table' ? groupKeyHintByContainerId.get(group.containerId) : undefined,
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

    if (includeDescendants) {
        attachTablePaginationRefs(entityIndex, regionEntities, nodeById, parentById);
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
            const slotByNodeId = buildSlotIndexByNodeId(groupBundle.slotByItemId[itemId] || []);
            attachGroupItemDescendantRefs(entityIndex.byNodeId, group.id, itemId, itemNode, slotByNodeId);
        }
    }

    return entityIndex;
};

const buildSlotIndexByNodeId = (slotNodeIds: string[]): Map<string, number> => {
    const slotByNodeId = new Map<string, number>();
    for (let slotIndex = 0; slotIndex < slotNodeIds.length; slotIndex += 1) {
        const slotNodeId = slotNodeIds[slotIndex];
        if (!slotNodeId) continue;
        slotByNodeId.set(slotNodeId, slotIndex);
    }
    return slotByNodeId;
};

const attachGroupItemDescendantRefs = (
    byNodeId: EntityIndex['byNodeId'],
    entityId: string,
    itemId: string,
    itemNode: UnifiedNode,
    slotByNodeId: Map<string, number>,
) => {
    const stack: Array<{ node: UnifiedNode; inheritedSlotIndex: number | undefined; isRoot: boolean }> = [
        {
            node: itemNode,
            inheritedSlotIndex: slotByNodeId.get(itemNode.id),
            isRoot: true,
        },
    ];

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;

        const ownSlotIndex = slotByNodeId.get(current.node.id);
        const nextSlotIndex = ownSlotIndex === undefined ? current.inheritedSlotIndex : ownSlotIndex;

        if (!current.isRoot) {
            pushNodeRef(byNodeId, current.node.id, {
                type: 'group',
                entityId,
                role: 'descendant',
                itemId,
                slotIndex: nextSlotIndex,
            });
        }

        for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
            const child = current.node.children[index];
            stack.push({
                node: child,
                inheritedSlotIndex: nextSlotIndex,
                isRoot: false,
            });
        }
    }
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
    const stack: Array<{ node: UnifiedNode; parent: UnifiedNode | null }> = [{ node, parent }];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;

        nodeById.set(current.node.id, current.node);
        parentById.set(current.node.id, current.parent);

        for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
            const child = current.node.children[index];
            stack.push({ node: child, parent: current.node });
        }
    }
};

const attachTablePaginationRefs = (
    entityIndex: EntityIndex,
    regions: RegionEntity[],
    nodeById: Map<string, UnifiedNode>,
    parentById: Map<string, UnifiedNode | null>,
) => {
    const tableRegions = regions.filter((region) => region.kind === 'table');
    if (tableRegions.length === 0) return;

    const paginationNodeIdsCache = new Map<string, string[]>();
    const depthCache = new Map<string, number>();
    const paginationNodeAssignment = new Map<string, PaginationAssignment>();
    const regionsByContainerId = new Map<string, RegionEntity[]>();
    for (const region of tableRegions) {
        const container = findTablePaginationContainer(region.nodeId, nodeById, parentById, paginationNodeIdsCache);
        if (!container) continue;
        const bucket = regionsByContainerId.get(container.id) || [];
        bucket.push(region);
        regionsByContainerId.set(container.id, bucket);
    }

    for (const [containerId, containerRegions] of regionsByContainerId.entries()) {
        const container = nodeById.get(containerId);
        if (!container || containerRegions.length === 0) continue;
        const paginationNodeIds = collectPaginationNodeIds(container, paginationNodeIdsCache);
        if (paginationNodeIds.length === 0) continue;

        let primaryRegion: RegionEntity | undefined;
        let primaryRegionDepth = Number.NEGATIVE_INFINITY;
        for (const region of containerRegions) {
            const depth = depthOfNode(region.nodeId, parentById, depthCache);
            if (depth > primaryRegionDepth) {
                primaryRegionDepth = depth;
                primaryRegion = region;
            }
        }
        if (!primaryRegion) continue;
        const regionDepth = primaryRegionDepth;

        for (const nodeId of paginationNodeIds) {
            const current = paginationNodeAssignment.get(nodeId);
            if (!current || regionDepth > current.depth) {
                paginationNodeAssignment.set(nodeId, {
                    entityId: primaryRegion.id,
                    depth: regionDepth,
                });
            }
        }
    }

    for (const [nodeId, assignment] of paginationNodeAssignment.entries()) {
        pushNodeRef(entityIndex.byNodeId, nodeId, {
            type: 'region',
            entityId: assignment.entityId,
            role: 'descendant',
        });
    }
};

type PaginationAssignment = {
    entityId: string;
    depth: number;
};

const findTablePaginationContainer = (
    nodeId: string,
    nodeById: Map<string, UnifiedNode>,
    parentById: Map<string, UnifiedNode | null>,
    paginationNodeIdsCache: Map<string, string[]>,
): UnifiedNode | null => {
    let cursor = nodeById.get(nodeId) || null;
    for (let depth = 0; cursor && depth < 7; depth += 1) {
        const paginationNodeIds = collectPaginationNodeIds(cursor, paginationNodeIdsCache);
        if (paginationNodeIds.length > 0) {
            return cursor;
        }
        cursor = parentById.get(cursor.id) || null;
    }
    return null;
};

const collectPaginationNodeIds = (root: UnifiedNode, cache: Map<string, string[]>): string[] => {
    const cached = cache.get(root.id);
    if (cached) return cached;

    const ids = new Set<string>();
    const stack: Array<{ node: UnifiedNode; inPaginationSubtree: boolean }> = [
        {
            node: root,
            inPaginationSubtree: false,
        },
    ];

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;

        const nextInPaginationSubtree = current.inPaginationSubtree || isPaginationLikeNode(current.node);
        if (nextInPaginationSubtree) {
            ids.add(current.node.id);
        }

        for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
            stack.push({
                node: current.node.children[index],
                inPaginationSubtree: nextInPaginationSubtree,
            });
        }
    }

    const result = Array.from(ids);
    cache.set(root.id, result);
    return result;
};

const depthOfNode = (
    nodeId: string,
    parentById: Map<string, UnifiedNode | null>,
    depthCache: Map<string, number>,
): number => {
    const cached = depthCache.get(nodeId);
    if (cached !== undefined) return cached;

    const chain: string[] = [];
    let cursor: string | undefined = nodeId;

    while (cursor) {
        const hit = depthCache.get(cursor);
        if (hit !== undefined) {
            let depth = hit;
            for (let index = chain.length - 1; index >= 0; index -= 1) {
                depth += 1;
                depthCache.set(chain[index], depth);
            }
            return depthCache.get(nodeId) || 0;
        }

        chain.push(cursor);
        const parent: UnifiedNode | null = parentById.get(cursor) || null;
        if (!parent) {
            let depth = 0;
            for (let index = chain.length - 1; index >= 0; index -= 1) {
                depthCache.set(chain[index], depth);
                depth += 1;
            }
            return depthCache.get(nodeId) || 0;
        }
        cursor = parent.id;
    }

    return 0;
};

const isPaginationLikeNode = (node: UnifiedNode): boolean => {
    const cls = normalizeLower(getNodeAttr(node, 'class'));
    if (!cls) return false;
    if (!PAGINATION_CLASS_HINTS.some((hint) => cls.includes(hint))) return false;

    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (PAGINATION_ROLES.has(role)) return true;
    if (PAGINATION_TAGS.has(tag)) return true;
    return role === 'button' || role === 'link' || tag === 'button' || tag === 'a';
};

const normalizeLower = (value: string | undefined): string => (value || '').trim().toLowerCase();

const PAGINATION_CLASS_HINTS = ['pagination', 'pager'];
const PAGINATION_ROLES = new Set(['list', 'navigation', 'button', 'link']);
const PAGINATION_TAGS = new Set(['ul', 'ol', 'nav', 'li', 'button', 'a']);
