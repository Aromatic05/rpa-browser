import { getNodeAttr, getNodeContent, normalizeText } from '../core/runtime_store';
import type { EntityKeyHint, UnifiedNode } from '../core/types';
import type { GroupDetection } from './groups';

type NodeById = Map<string, UnifiedNode>;
type ParentById = Map<string, UnifiedNode | null>;

type HeaderPick = {
    name: string;
    nodeId?: string;
};

type SlotScore = {
    slot: number;
    score: number;
    coverage: number;
    uniq: number;
    iconRate: number;
    numericRate: number;
    actionRate: number;
    samples: string[];
};

export const deriveGroupTableKeyHint = (
    group: GroupDetection,
    nodeById: NodeById,
    parentById: ParentById,
): EntityKeyHint | undefined => {
    if (group.kind !== 'table') return undefined;

    const keySlot = group.keySlot;
    const sampleValues = collectGroupSlotSamples(group, keySlot, nodeById);
    if (sampleValues.length === 0) return undefined;

    const header =
        pickHeaderFromNearestTable(group.containerId, keySlot, nodeById, parentById) ||
        pickHeaderFromGroupSlot(group, keySlot, nodeById);
    const coverage = calcGroupSlotCoverage(group, keySlot, nodeById);
    const uniq = uniqueRatio(sampleValues);

    const confidence = clamp01(
        0.42 +
            (header ? 0.28 : 0) +
            Math.min(0.16, coverage * 0.2) +
            Math.min(0.12, uniq * 0.14),
    );

    return {
        slot: keySlot,
        name: header?.name,
        source: header ? 'group_header' : 'group_slot',
        confidence,
        headerNodeId: header?.nodeId,
        sampleValues: sampleValues.slice(0, 8),
    };
};

export const deriveRegionTableKeyHint = (
    regionNodeId: string,
    selectedGroups: GroupDetection[],
    groupKeyByContainerId: Map<string, EntityKeyHint>,
    nodeById: NodeById,
    parentById: ParentById,
): EntityKeyHint | undefined => {
    const bestGroup = findBestTableGroupUnderRegion(regionNodeId, selectedGroups, parentById);
    if (bestGroup) {
        const fromGroup = groupKeyByContainerId.get(bestGroup.containerId);
        if (fromGroup) return { ...fromGroup };
    }

    const regionNode = nodeById.get(regionNodeId);
    if (!regionNode) return undefined;
    const rows = collectTableRows(regionNode);
    if (rows.length < 2) return undefined;

    const slotScore = pickBestRegionSlot(rows);
    if (!slotScore) return undefined;

    const header = pickHeaderFromNearestTable(regionNodeId, slotScore.slot, nodeById, parentById);
    const confidence = clamp01(
        0.38 +
            (header ? 0.28 : 0) +
            Math.min(0.2, slotScore.coverage * 0.24) +
            Math.min(0.12, slotScore.uniq * 0.16) -
            slotScore.iconRate * 0.18 -
            slotScore.actionRate * 0.1,
    );

    return {
        slot: slotScore.slot,
        name: header?.name,
        source: header ? 'region_header' : 'region_structure',
        confidence,
        headerNodeId: header?.nodeId,
        sampleValues: slotScore.samples.slice(0, 8),
    };
};

const findBestTableGroupUnderRegion = (
    regionNodeId: string,
    groups: GroupDetection[],
    parentById: ParentById,
): GroupDetection | undefined => {
    return groups
        .filter((group) => group.kind === 'table' && isDescendantOrSelf(regionNodeId, group.containerId, parentById))
        .sort((left, right) => {
            const depthDelta = depthOfNode(right.containerId, parentById) - depthOfNode(left.containerId, parentById);
            if (depthDelta !== 0) return depthDelta;
            return right.itemIds.length - left.itemIds.length;
        })[0];
};

const collectGroupSlotSamples = (group: GroupDetection, slot: number, nodeById: NodeById): string[] => {
    const dedupe = new Set<string>();
    const out: string[] = [];
    for (const itemId of group.itemIds) {
        const slotNodeId = group.slotByItemId[itemId]?.[slot];
        let value = '';
        if (slotNodeId) {
            const slotNode = nodeById.get(slotNodeId);
            value = readNodeText(slotNode);
        }
        if (!value) {
            value = readNodeText(nodeById.get(itemId), 2);
        }
        const normalized = normalizeText(value);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        out.push(normalized);
    }
    return out;
};

const calcGroupSlotCoverage = (
    group: GroupDetection,
    slot: number,
    nodeById: NodeById,
): number => {
    if (group.itemIds.length === 0) return 0;
    let covered = 0;
    for (const itemId of group.itemIds) {
        const slotNodeId = group.slotByItemId[itemId]?.[slot];
        const slotNode = slotNodeId ? nodeById.get(slotNodeId) : undefined;
        const direct = readNodeText(slotNode);
        if (direct) {
            covered += 1;
            continue;
        }
        const fallback = readNodeText(nodeById.get(itemId), 1);
        if (fallback) covered += 1;
    }
    return covered / group.itemIds.length;
};

const pickHeaderFromGroupSlot = (
    group: GroupDetection,
    slot: number,
    nodeById: NodeById,
): HeaderPick | undefined => {
    const scoreByHeader = new Map<string, { count: number; raw: string; nodeId?: string }>();
    for (const itemId of group.itemIds.slice(0, 10)) {
        const slotNodeId = group.slotByItemId[itemId]?.[slot];
        if (!slotNodeId) continue;
        const slotNode = nodeById.get(slotNodeId);
        if (!slotNode || !isHeaderLikeNode(slotNode)) continue;
        const text = normalizeText(readNodeText(slotNode, 1));
        if (!text) continue;
        const key = text.toLowerCase();
        const current = scoreByHeader.get(key) || { count: 0, raw: text, nodeId: slotNode.id };
        current.count += 1;
        if (!current.nodeId) current.nodeId = slotNode.id;
        scoreByHeader.set(key, current);
    }

    const sorted = [...scoreByHeader.values()].sort((a, b) => b.count - a.count);
    const top = sorted[0];
    if (!top) return undefined;
    return {
        name: top.raw,
        nodeId: top.nodeId,
    };
};

const pickHeaderFromNearestTable = (
    startNodeId: string,
    slot: number,
    nodeById: NodeById,
    parentById: ParentById,
): HeaderPick | undefined => {
    const tableNode = findNearestTableNode(startNodeId, nodeById, parentById);
    if (!tableNode) return undefined;

    const explicit = pickHeaderFromThead(tableNode, slot);
    if (explicit) return explicit;

    return pickHeaderFromHeaderLikeRow(tableNode, slot);
};

const pickHeaderFromThead = (tableNode: UnifiedNode, slot: number): HeaderPick | undefined => {
    const thead = findDescendant(tableNode, (node) => isTheadNode(node), 3);
    if (!thead) return undefined;
    const row = findDescendant(thead, (node) => isRowNode(node), 2);
    if (!row) return undefined;
    const cells = row.children.filter((child) => isCellNode(child));
    const target = cells[slot];
    if (!target) return undefined;
    const text = normalizeText(readNodeText(target, 2));
    if (!text) return undefined;
    return {
        name: text,
        nodeId: target.id,
    };
};

const pickHeaderFromHeaderLikeRow = (tableNode: UnifiedNode, slot: number): HeaderPick | undefined => {
    const rows = collectTableRows(tableNode).slice(0, 6);
    for (const row of rows) {
        const cells = row.children.filter((child) => isCellNode(child));
        if (cells.length <= slot) continue;
        const headerLikeCells = cells.filter((cell) => isHeaderLikeNode(cell));
        if (headerLikeCells.length < Math.max(1, Math.floor(cells.length / 2))) continue;
        const target = cells[slot];
        const text = normalizeText(readNodeText(target, 2));
        if (!text) continue;
        return {
            name: text,
            nodeId: target.id,
        };
    }
    return undefined;
};

const pickBestRegionSlot = (rows: UnifiedNode[]): SlotScore | undefined => {
    const rowCells = rows
        .map((row) => row.children.filter((child) => isCellNode(child)))
        .filter((cells) => cells.length > 1);
    if (rowCells.length < 2) return undefined;

    const maxSlot = Math.max(...rowCells.map((cells) => cells.length), 0) - 1;
    if (maxSlot < 0) return undefined;

    let best: SlotScore | undefined;
    for (let slot = 0; slot <= maxSlot; slot += 1) {
        const values: string[] = [];
        for (const cells of rowCells) {
            const cell = cells[slot];
            if (!cell) continue;
            const text = normalizeText(readNodeText(cell, 2));
            if (text) values.push(text);
        }
        if (values.length === 0) continue;

        const coverage = values.length / rowCells.length;
        const uniq = uniqueRatio(values);
        const iconRate = values.filter((value) => isIconLikeText(value)).length / values.length;
        const numericRate = values.filter((value) => isNumericLikeText(value)).length / values.length;
        const actionRate = values.filter((value) => isActionText(value)).length / values.length;
        const score =
            coverage * 0.42 +
            uniq * 0.52 -
            iconRate * 0.72 -
            numericRate * 0.28 -
            actionRate * 0.38;

        const samples = dedupeTexts(values).slice(0, 8);
        const candidate: SlotScore = {
            slot,
            score,
            coverage,
            uniq,
            iconRate,
            numericRate,
            actionRate,
            samples,
        };
        if (!best || candidate.score > best.score) {
            best = candidate;
        }
    }
    return best;
};

const collectTableRows = (root: UnifiedNode): UnifiedNode[] => {
    const rows: UnifiedNode[] = [];
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node: root, depth: 0 }];
    while (queue.length > 0 && rows.length < 120) {
        const current = queue.shift();
        if (!current) break;
        if (isRowNode(current.node)) {
            rows.push(current.node);
            continue;
        }
        if (current.depth >= 8) continue;
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return rows;
};

const findNearestTableNode = (
    startNodeId: string,
    nodeById: NodeById,
    parentById: ParentById,
): UnifiedNode | undefined => {
    let cursor = nodeById.get(startNodeId);
    while (cursor) {
        if (isTableNode(cursor)) return cursor;
        cursor = parentById.get(cursor.id) || undefined;
    }
    return undefined;
};

const isDescendantOrSelf = (
    ancestorId: string,
    nodeId: string,
    parentById: ParentById,
): boolean => {
    let cursor: string | undefined = nodeId;
    while (cursor) {
        if (cursor === ancestorId) return true;
        const parentNode: UnifiedNode | null = parentById.get(cursor) || null;
        cursor = parentNode ? parentNode.id : undefined;
    }
    return false;
};

const depthOfNode = (nodeId: string, parentById: ParentById): number => {
    let depth = 0;
    let cursor: string | undefined = nodeId;
    while (cursor) {
        const parentNode: UnifiedNode | null = parentById.get(cursor) || null;
        if (!parentNode) break;
        depth += 1;
        cursor = parentNode.id;
    }
    return depth;
};

const findDescendant = (
    root: UnifiedNode,
    predicate: (node: UnifiedNode) => boolean,
    depthLimit: number,
): UnifiedNode | undefined => {
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node: root, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        if (current.depth > depthLimit) continue;
        if (current.node !== root && predicate(current.node)) return current.node;
        if (current.depth >= depthLimit) continue;
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return undefined;
};

const isTableNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return role === 'table' || role === 'grid' || role === 'treegrid' || tag === 'table';
};

const isTheadNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return role === 'thead' || tag === 'thead';
};

const isRowNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return role === 'row' || tag === 'tr';
};

const isCellNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return role === 'cell' || role === 'gridcell' || role === 'columnheader' || role === 'rowheader' || tag === 'td' || tag === 'th';
};

const isHeaderLikeNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const cls = normalizeLower(getNodeAttr(node, 'class'));
    if (role === 'columnheader' || role === 'rowheader' || role === 'heading') return true;
    if (tag === 'th') return true;
    if (cls.includes('header') || cls.includes('column-title') || cls.includes('thead')) return true;
    return false;
};

const readNodeText = (node: UnifiedNode | undefined, depthLimit = 1): string => {
    if (!node) return '';
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        const direct = normalizeText(
            current.node.name ||
                getNodeContent(current.node) ||
                getNodeAttr(current.node, 'aria-label') ||
                getNodeAttr(current.node, 'title') ||
                getNodeAttr(current.node, 'placeholder') ||
                getNodeAttr(current.node, 'value'),
        );
        if (direct) return direct;
        if (current.depth >= depthLimit) continue;
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return '';
};

const dedupeTexts = (values: string[]): string[] => {
    const dedupe = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const normalized = normalizeText(value);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        out.push(normalized);
    }
    return out;
};

const uniqueRatio = (values: string[]): number => {
    if (values.length === 0) return 0;
    const unique = new Set(values.map((value) => value.toLowerCase()));
    return unique.size / values.length;
};

const isIconLikeText = (value: string): boolean => {
    const text = normalizeText(value);
    if (!text) return false;
    const lowered = text.toLowerCase();
    if (ICON_TERMS.has(lowered)) return true;
    if (!ICON_PATTERN.test(lowered)) return false;
    const parts = lowered.split(/[-_]/).filter(Boolean);
    if (parts.length === 0 || parts.length > 4) return false;
    return parts.some((part) => ICON_TERMS.has(part));
};

const isNumericLikeText = (value: string): boolean => {
    const text = normalizeText(value);
    if (!text) return false;
    return NUMERIC_PATTERN.test(text);
};

const isActionText = (value: string): boolean => {
    const text = normalizeText(value);
    if (!text) return false;
    const lowered = text.toLowerCase();
    return ACTION_WORDS.some((word) => lowered.includes(word));
};

const clamp01 = (value: number): number => {
    if (Number.isNaN(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
};

const normalizeLower = (value: string | undefined): string => (value || '').trim().toLowerCase();

const ICON_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+){0,3}$/;
const NUMERIC_PATTERN = /^[\d\s\-:/.%]+$/;
const ICON_TERMS = new Set([
    'icon',
    'caret',
    'arrow',
    'up',
    'down',
    'left',
    'right',
    'circle',
    'square',
    'pushpin',
    'pin',
    'close',
    'check',
    'plus',
    'minus',
    'search',
    'info',
]);
const ACTION_WORDS = [
    'edit',
    'delete',
    'remove',
    'view',
    'detail',
    'details',
    'more',
    'open',
    'save',
    'submit',
    '操作',
    '编辑',
    '删除',
    '查看',
    '详情',
    '更多',
];
