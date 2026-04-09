import { getNodeAttr, getNodeContent, normalizeText } from '../core/runtime_store';
import type { GroupKind, UnifiedNode } from '../core/types';

export type GroupDetection = {
    kind: GroupKind;
    containerId: string;
    itemIds: string[];
    keySlot: number;
    slotByItemId: Record<string, string[]>;
};

type NodeShape = {
    role: string;
    childRoleShape: string;
    actionShape: string;
    textBucket: string;
    interactiveBucket: string;
    signature: string;
};

type SignatureBucket = {
    shape: NodeShape;
    nodes: UnifiedNode[];
};

export const detectGroups = (root: UnifiedNode): GroupDetection[] => {
    const parentById = new Map<string, UnifiedNode | null>();
    buildParentIndex(root, null, parentById);

    const groups: GroupDetection[] = [];
    const dedup = new Set<string>();

    walk(root, (parent) => {
        if (parent.children.length < 2) return;
        if (isTooNoisyGroupContainer(parent)) return;

        const buckets = detectSiblingBuckets(parent);
        if (buckets.length === 0) return;

        for (const bucket of buckets) {
            const shrunk = shrinkGroupContainer(parent, bucket.nodes, parentById);
            if (shrunk.items.length < 2) continue;

            const slotMap = buildItemSlotMap(shrunk.items);
            const itemIds = shrunk.items.map((item) => item.id);
            const dedupKey = `${shrunk.container.id}|${itemIds.join(',')}`;
            if (dedup.has(dedupKey)) continue;
            dedup.add(dedupKey);

            const kind = classifyGroupKind(shrunk.container, shrunk.items, slotMap, parentById);
            const keySlot = kind === 'kv' ? 0 : selectKeySlot(kind, shrunk.items, slotMap);
            if (!passesGroupGate(kind, shrunk.container, shrunk.items, slotMap, keySlot, parentById)) continue;

            const slotByItemId: Record<string, string[]> = {};
            for (const [itemId, slots] of slotMap) {
                slotByItemId[itemId] = slots.map((slot) => slot.id);
            }

            groups.push({
                kind,
                containerId: shrunk.container.id,
                itemIds,
                keySlot,
                slotByItemId,
            });
        }
    });

    return pruneGroups(groups, parentById);
};

const passesGroupGate = (
    kind: GroupKind,
    container: UnifiedNode,
    items: UnifiedNode[],
    slotMap: Map<string, UnifiedNode[]>,
    keySlot: number,
    parentById: Map<string, UnifiedNode | null>,
): boolean => {
    const itemCount = items.length;
    if (itemCount < 2) return false;

    const slotCount = estimateSlotCount(items, slotMap);
    const hasTable = hasTableSemantic(container, parentById);
    const hasList = hasListSemantic(container);

    if (kind === 'table') {
        if (!hasTable && itemCount < 4) return false;
        if (hasTable && itemCount < 3) return false;
        if (slotCount < 2) return false;
        const stableRate = calcStableMultiSlotRate(items, slotMap, slotCount);
        if (!hasTable && stableRate < 0.55) return false;
        return passesKeyQuality(kind, items, slotMap, keySlot);
    }

    if (kind === 'kv') {
        if (itemCount < 3) return false;
        if (slotCount !== 2) return false;
        if (!looksLikeKv(items, slotMap)) return false;
        return passesKeyQuality(kind, items, slotMap, 0);
    }

    if (hasList) {
        if (itemCount < 3) return false;
    } else {
        if (itemCount < 5) return false;
    }
    if (slotCount <= 1 && itemCount < 6) return false;
    return passesKeyQuality(kind, items, slotMap, keySlot);
};

const passesKeyQuality = (
    kind: GroupKind,
    items: UnifiedNode[],
    slotMap: Map<string, UnifiedNode[]>,
    keySlot: number,
): boolean => {
    const keyTexts: string[] = [];
    for (const item of items) {
        const slot = (slotMap.get(item.id) || [])[keySlot];
        const text = slot ? readSlotText(slot) : undefined;
        if (text) {
            keyTexts.push(text);
            continue;
        }
        const fallback = firstReadableText(item, 1);
        if (fallback) keyTexts.push(fallback);
    }

    const nonEmpty = keyTexts.filter((text) => text.trim().length > 0);
    const coverage = items.length > 0 ? nonEmpty.length / items.length : 0;
    const uniqueness = uniqueRatio(nonEmpty);

    if (kind === 'table') {
        return coverage >= 0.45 && uniqueness >= 0.35;
    }
    if (kind === 'kv') {
        return coverage >= 0.5;
    }
    return coverage >= 0.55 && uniqueness >= 0.45;
};

const pruneGroups = (groups: GroupDetection[], parentById: Map<string, UnifiedNode | null>): GroupDetection[] => {
    const bestByContainer = new Map<string, GroupDetection>();
    for (const group of groups) {
        const current = bestByContainer.get(group.containerId);
        if (!current || groupScore(group) > groupScore(current)) {
            bestByContainer.set(group.containerId, group);
        }
    }

    const sorted = [...bestByContainer.values()].sort((a, b) => groupScore(b) - groupScore(a));
    const kept: GroupDetection[] = [];
    for (const candidate of sorted) {
        let blocked = false;
        for (const existing of kept) {
            if (isAncestorNode(existing.containerId, candidate.containerId, parentById)) {
                if (overlapRatio(candidate.itemIds, existing.itemIds) >= 0.75) {
                    blocked = true;
                    break;
                }
            }
        }
        if (!blocked) {
            kept.push(candidate);
        }
    }

    return kept;
};

const groupScore = (group: GroupDetection): number => {
    const kindWeight = group.kind === 'table' ? 6 : group.kind === 'kv' ? 4 : 2;
    return group.itemIds.length * 3 + kindWeight;
};

const overlapRatio = (left: string[], right: string[]): number => {
    if (left.length === 0 || right.length === 0) return 0;
    const rightSet = new Set(right);
    let intersect = 0;
    for (const id of left) {
        if (rightSet.has(id)) intersect += 1;
    }
    return intersect / Math.min(left.length, right.length);
};

const isAncestorNode = (
    ancestorId: string,
    nodeId: string,
    parentById: Map<string, UnifiedNode | null>,
): boolean => {
    let cursor = parentById.get(nodeId) || null;
    while (cursor) {
        if (cursor.id === ancestorId) return true;
        cursor = parentById.get(cursor.id) || null;
    }
    return false;
};

const detectSiblingBuckets = (parent: UnifiedNode): SignatureBucket[] => {
    const bySignature = new Map<string, SignatureBucket>();
    const candidates = parent.children.filter((child) => isGroupCandidateChild(child));
    for (const child of candidates) {
        const shape = buildNodeShape(child);
        const bucket = bySignature.get(shape.signature) || { shape, nodes: [] };
        bucket.nodes.push(child);
        bySignature.set(shape.signature, bucket);
    }

    const strictBuckets = [...bySignature.values()]
        .filter((bucket) => bucket.nodes.length >= 2)
        .sort((a, b) => b.nodes.length - a.nodes.length);
    if (strictBuckets.length > 0) return strictBuckets;

    const fuzzyBuckets: SignatureBucket[] = [];
    const byRole = new Map<string, UnifiedNode[]>();
    for (const child of candidates) {
        const role = normalizeLower(child.role);
        const roleBucket = byRole.get(role) || [];
        roleBucket.push(child);
        byRole.set(role, roleBucket);
    }

    for (const siblings of byRole.values()) {
        if (siblings.length < 2) continue;
        const clusters: Array<{ shape: NodeShape; nodes: UnifiedNode[] }> = [];
        for (const candidate of siblings) {
            const shape = buildNodeShape(candidate);
            const cluster = clusters.find((item) => shallowSimilarity(item.shape, shape) >= 0.72);
            if (cluster) {
                cluster.nodes.push(candidate);
                continue;
            }
            clusters.push({ shape, nodes: [candidate] });
        }
        for (const cluster of clusters) {
            if (cluster.nodes.length < 2) continue;
            fuzzyBuckets.push({
                shape: cluster.shape,
                nodes: cluster.nodes,
            });
        }
    }

    return fuzzyBuckets.sort((a, b) => b.nodes.length - a.nodes.length);
};

const shrinkGroupContainer = (
    initialContainer: UnifiedNode,
    initialItems: UnifiedNode[],
    parentById: Map<string, UnifiedNode | null>,
): { container: UnifiedNode; items: UnifiedNode[] } => {
    let container = initialContainer;
    let items = initialItems;

    for (let i = 0; i < 2; i += 1) {
        if (!isWrapperContainer(container)) break;
        const dominantChild = pickDominantChild(container, items, parentById);
        if (!dominantChild) break;

        const nextBuckets = detectSiblingBuckets(dominantChild);
        const largest = nextBuckets[0];
        if (!largest || largest.nodes.length < 2) break;

        container = dominantChild;
        items = largest.nodes;
    }

    return { container, items };
};

const pickDominantChild = (
    container: UnifiedNode,
    items: UnifiedNode[],
    parentById: Map<string, UnifiedNode | null>,
): UnifiedNode | undefined => {
    if (container.children.length === 0) return undefined;
    const topById = new Map<string, number>();
    for (const item of items) {
        const top = findTopChild(container, item, parentById);
        if (!top) return undefined;
        topById.set(top.id, (topById.get(top.id) || 0) + 1);
    }

    const sorted = [...topById.entries()].sort((a, b) => b[1] - a[1]);
    const first = sorted[0];
    const second = sorted[1];
    if (!first) return undefined;
    if ((second?.[1] || 0) > 0) return undefined;
    if (first[1] !== items.length) return undefined;

    const target = container.children.find((child) => child.id === first[0]);
    if (!target || target.children.length === 0) return undefined;
    return target;
};

const findTopChild = (
    container: UnifiedNode,
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
): UnifiedNode | undefined => {
    let cursor: UnifiedNode | null = node;
    let parent = parentById.get(cursor.id) || null;
    while (cursor && parent && parent.id !== container.id) {
        cursor = parent;
        parent = parentById.get(cursor.id) || null;
    }
    if (!cursor || !parent || parent.id !== container.id) return undefined;
    return cursor;
};

const buildItemSlotMap = (items: UnifiedNode[]): Map<string, UnifiedNode[]> => {
    const map = new Map<string, UnifiedNode[]>();
    for (const item of items) {
        map.set(item.id, extractSlots(item));
    }
    return map;
};

const classifyGroupKind = (
    container: UnifiedNode,
    items: UnifiedNode[],
    slotMap: Map<string, UnifiedNode[]>,
    parentById: Map<string, UnifiedNode | null>,
): GroupKind => {
    const slotCount = estimateSlotCount(items, slotMap);
    const hasTableSignal = hasTableSemantic(container, parentById) || items.some((item) => isRowLikeNode(item));
    const stableMultiSlotRate = calcStableMultiSlotRate(items, slotMap, slotCount);

    if (hasTableSignal || (slotCount >= 3 && stableMultiSlotRate >= 0.6)) {
        return 'table';
    }
    if (slotCount === 2 && looksLikeKv(items, slotMap)) {
        return 'kv';
    }
    return 'list';
};

const estimateSlotCount = (items: UnifiedNode[], slotMap: Map<string, UnifiedNode[]>): number => {
    const counts = items
        .map((item) => slotMap.get(item.id)?.length || 0)
        .filter((count) => count > 0)
        .sort((a, b) => a - b);
    if (counts.length === 0) return 1;
    return counts[Math.floor(counts.length / 2)] || 1;
};

const calcStableMultiSlotRate = (items: UnifiedNode[], slotMap: Map<string, UnifiedNode[]>, slotCount: number): number => {
    if (slotCount <= 1) return 0;
    let matched = 0;
    for (const item of items) {
        const count = slotMap.get(item.id)?.length || 0;
        if (count >= Math.max(2, slotCount - 1)) {
            matched += 1;
        }
    }
    return items.length === 0 ? 0 : matched / items.length;
};

const looksLikeKv = (items: UnifiedNode[], slotMap: Map<string, UnifiedNode[]>): boolean => {
    let labelHit = 0;
    let valueHit = 0;
    let samples = 0;

    for (const item of items) {
        const slots = slotMap.get(item.id) || [];
        const keySlot = slots[0];
        const valueSlot = slots[1];
        if (!keySlot || !valueSlot) continue;
        samples += 1;
        const keyText = readSlotText(keySlot);
        if (keyText && isKvLabelLikeText(keyText)) {
            labelHit += 1;
        }
        const valueText = readSlotText(valueSlot);
        if (valueText || hasInteractiveSignal(valueSlot, 1)) {
            valueHit += 1;
        }
    }

    if (samples === 0) return false;
    return labelHit / samples >= 0.55 && valueHit / samples >= 0.55;
};

const selectKeySlot = (kind: 'table' | 'list', items: UnifiedNode[], slotMap: Map<string, UnifiedNode[]>): number => {
    const slotCount = Math.max(...items.map((item) => slotMap.get(item.id)?.length || 0), 1);
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
        const sampleNodes: UnifiedNode[] = [];
        const sampleTexts: string[] = [];
        for (const item of items) {
            const slot = (slotMap.get(item.id) || [])[slotIndex];
            if (!slot) continue;
            sampleNodes.push(slot);
            const text = readSlotText(slot);
            if (text) sampleTexts.push(text);
        }

        if (sampleTexts.length < 2) continue;
        const score =
            uniqueRatio(sampleTexts) * 3 +
            averageTextQuality(sampleTexts) +
            semanticBonus(kind, sampleNodes, sampleTexts) -
            actionPenalty(sampleNodes, sampleTexts) * 1.4 -
            volatilityPenalty(sampleTexts) * 1.1 -
            sparsePenalty(sampleNodes.length, items.length);

        if (score > bestScore) {
            bestScore = score;
            bestIndex = slotIndex;
        }
    }

    return bestIndex;
};

const uniqueRatio = (texts: string[]): number => {
    const normalized = texts.map((text) => text.toLowerCase());
    const unique = new Set(normalized);
    return texts.length === 0 ? 0 : unique.size / texts.length;
};

const averageTextQuality = (texts: string[]): number => {
    if (texts.length === 0) return 0;
    let total = 0;
    for (const text of texts) {
        total += textQuality(text);
    }
    return total / texts.length;
};

const textQuality = (text: string): number => {
    const value = text.trim();
    if (value.length < 2 || value.length > 64) return 0;
    if (!HAS_TEXT_PATTERN.test(value)) return 0;
    if (/^[\d\s\-:/.%]+$/.test(value)) return 0.15;
    if (/[A-Za-z\u4E00-\u9FFF]/.test(value)) return 1;
    return 0.5;
};

const semanticBonus = (kind: 'table' | 'list', nodes: UnifiedNode[], texts: string[]): number => {
    let bonus = 0;
    for (const node of nodes) {
        const role = normalizeLower(node.role);
        const cls = normalizeLower(getNodeAttr(node, 'class'));
        const id = normalizeLower(getNodeAttr(node, 'id'));
        const title = normalizeLower(getNodeAttr(node, 'title'));
        const attrs = `${cls} ${id} ${title}`;

        if (kind === 'table') {
            if (attrs.includes('name') || attrs.includes('title') || attrs.includes('code') || attrs.includes('id')) {
                bonus += 0.15;
            }
            if (role === 'rowheader' || role === 'columnheader' || role === 'heading') {
                bonus += 0.2;
            }
        } else {
            if (role === 'heading' || role === 'link' || role === 'label') {
                bonus += 0.2;
            }
            if (attrs.includes('title') || attrs.includes('name') || attrs.includes('subject')) {
                bonus += 0.15;
            }
        }
    }

    for (const text of texts) {
        const lower = text.toLowerCase();
        if (kind === 'table' && SEMANTIC_KEYWORDS.some((keyword) => lower.includes(keyword))) {
            bonus += 0.1;
        }
        if (kind === 'list' && LIST_TITLE_KEYWORDS.some((keyword) => lower.includes(keyword))) {
            bonus += 0.08;
        }
    }

    return Math.min(bonus, 1.2);
};

const actionPenalty = (nodes: UnifiedNode[], texts: string[]): number => {
    if (nodes.length === 0) return 0;
    let hit = 0;
    for (const node of nodes) {
        if (isActionLikeNode(node)) {
            hit += 1;
            continue;
        }
        const text = readSlotText(node);
        if (text && isActionWordText(text)) {
            hit += 1;
        }
    }
    for (const text of texts) {
        if (isActionWordText(text)) hit += 0.5;
    }
    return Math.min(hit / nodes.length, 1);
};

const volatilityPenalty = (texts: string[]): number => {
    if (texts.length === 0) return 0;
    let volatileCount = 0;
    for (const text of texts) {
        if (isVolatileText(text)) volatileCount += 1;
    }
    return volatileCount / texts.length;
};

const sparsePenalty = (samples: number, total: number): number => {
    if (total <= 0) return 0;
    const coverage = samples / total;
    if (coverage >= 0.75) return 0;
    if (coverage >= 0.5) return 0.2;
    return 0.45;
};

const buildNodeShape = (node: UnifiedNode): NodeShape => {
    const role = normalizeLower(node.role);
    const childRoleShape = node.children
        .slice(0, 6)
        .map((child) => normalizeLower(child.role))
        .join(',');
    const actionShape = collectShallowActionTokens(node).slice(0, 3).join(',');
    const textBucket = bucketizeCount(countShallowTextSignal(node));
    const interactiveBucket = bucketizeCount(countShallowInteractiveSignal(node));
    const signature = `${role}|${childRoleShape}|${actionShape}|${textBucket}|${interactiveBucket}`;
    return {
        role,
        childRoleShape,
        actionShape,
        textBucket,
        interactiveBucket,
        signature,
    };
};

const shallowSimilarity = (left: NodeShape, right: NodeShape): number => {
    if (left.role !== right.role) return 0;
    const leftTokens = new Set<string>([
        left.role,
        ...splitShapeTokens(left.childRoleShape),
        ...splitShapeTokens(left.actionShape),
        left.textBucket,
        left.interactiveBucket,
    ]);
    const rightTokens = new Set<string>([
        right.role,
        ...splitShapeTokens(right.childRoleShape),
        ...splitShapeTokens(right.actionShape),
        right.textBucket,
        right.interactiveBucket,
    ]);

    let intersect = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) intersect += 1;
    }
    const union = new Set<string>([...leftTokens, ...rightTokens]).size;
    if (union === 0) return 0;
    return intersect / union;
};

const splitShapeTokens = (value: string): string[] => value.split(',').filter((item) => Boolean(item));

const collectShallowActionTokens = (node: UnifiedNode): string[] => {
    const dedup = new Set<string>();
    const targets = [node, ...node.children];
    for (const candidate of targets) {
        if (!isActionLikeNode(candidate)) continue;
        const text = readSlotText(candidate);
        if (text) {
            const matched = ACTION_WORDS.find((word) => text.toLowerCase().includes(word));
            if (matched) {
                dedup.add(matched);
                continue;
            }
        }
        dedup.add(normalizeLower(candidate.role) || 'action');
    }
    return [...dedup];
};

const countShallowTextSignal = (node: UnifiedNode): number => {
    let count = 0;
    const texts = [readSlotText(node), ...node.children.map((child) => readSlotText(child))];
    for (const text of texts) {
        if (!text) continue;
        count += 1;
    }
    return count;
};

const countShallowInteractiveSignal = (node: UnifiedNode): number => {
    let count = hasInteractiveSignal(node, 0) ? 1 : 0;
    for (const child of node.children) {
        if (hasInteractiveSignal(child, 0)) count += 1;
    }
    return count;
};

const bucketizeCount = (count: number): string => {
    if (count <= 0) return '0';
    if (count === 1) return '1';
    if (count <= 3) return '2-3';
    return '4+';
};

const extractSlots = (rawItem: UnifiedNode): UnifiedNode[] => {
    let item = rawItem;
    for (let i = 0; i < 2; i += 1) {
        if (!isWrapperItem(item)) break;
        if (item.children.length !== 1) break;
        const next = item.children[0];
        if (!next) break;
        item = next;
    }

    if (item.children.length === 0) return [item];
    const candidates = item.children.filter((child) => !isNoiseNode(child));
    if (candidates.length === 0) return [item];
    return candidates.slice(0, 8);
};

const readSlotText = (node: UnifiedNode): string | undefined => {
    const direct = [
        node.name,
        getNodeContent(node),
        getNodeAttr(node, 'aria-label'),
        getNodeAttr(node, 'title'),
        getNodeAttr(node, 'placeholder'),
    ]
        .map((value) => normalizeText(value))
        .find((value): value is string => Boolean(value));
    if (direct) return direct;
    return firstReadableText(node, 2);
};

const firstReadableText = (node: UnifiedNode, depthLimit: number): string | undefined => {
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;

        const text = normalizeText(current.node.name || getNodeContent(current.node));
        if (text && text.length <= 64) return text;

        if (current.depth >= depthLimit) continue;
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return undefined;
};

const hasTableSemantic = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>): boolean => {
    let cursor: UnifiedNode | null = node;
    for (let depth = 0; cursor && depth <= 2; depth += 1) {
        const role = normalizeLower(cursor.role);
        const tag = normalizeLower(getNodeAttr(cursor, 'tag') || getNodeAttr(cursor, 'tagName'));
        const cls = normalizeLower(getNodeAttr(cursor, 'class'));
        if (TABLE_ROLES.has(role) || TABLE_TAGS.has(tag) || TABLE_KEYWORDS.some((keyword) => cls.includes(keyword))) {
            return true;
        }
        cursor = parentById.get(cursor.id) || null;
    }
    return false;
};

const hasListSemantic = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const cls = normalizeLower(getNodeAttr(node, 'class'));
    if (LIST_ROLES.has(role) || LIST_TAGS.has(tag)) return true;
    if (cls.includes('list') || cls.includes('menu')) return true;
    return false;
};

const isRowLikeNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (role === 'row' || role === 'listitem') return true;
    if (tag === 'tr' || tag === 'li') return true;
    return false;
};

const isKvLabelLikeText = (text: string): boolean => {
    const value = text.trim();
    if (!value) return false;
    if (isActionWordText(value)) return false;
    if (value.length > 32) return false;
    if (value.includes(':') || value.includes('：')) return true;
    if (VOLATILE_PATTERN.test(value)) return false;
    return /[A-Za-z\u4E00-\u9FFF]/.test(value);
};

const isActionLikeNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (ACTION_ROLES.has(role) || ACTION_TAGS.has(tag)) return true;
    if (getNodeAttr(node, 'onclick')) return true;
    return false;
};

const hasInteractiveSignal = (node: UnifiedNode, depthLimit: number): boolean => {
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        if (isInteractiveNode(current.node)) return true;
        if (current.depth >= depthLimit) continue;
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return false;
};

const isInteractiveNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (INTERACTIVE_ROLES.has(role) || INTERACTIVE_TAGS.has(tag)) return true;
    if (node.target) return true;
    if (getNodeAttr(node, 'href') || getNodeAttr(node, 'tabindex') || getNodeAttr(node, 'onclick')) return true;
    return false;
};

const isWrapperContainer = (node: UnifiedNode): boolean => {
    if (node.children.length === 0) return false;
    if (normalizeText(node.name || getNodeContent(node))) return false;
    if (hasInteractiveSignal(node, 0)) return false;
    const role = normalizeLower(node.role);
    return WRAPPER_ROLES.has(role);
};

const isWrapperItem = (node: UnifiedNode): boolean => {
    if (node.children.length === 0) return false;
    if (normalizeText(node.name || getNodeContent(node))) return false;
    if (hasInteractiveSignal(node, 0)) return false;
    return WRAPPER_ROLES.has(normalizeLower(node.role));
};

const isTooNoisyGroupContainer = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    if (role === 'none' || role === 'presentation') return true;
    if (node.children.length < 2) return true;
    return false;
};

const isGroupCandidateChild = (node: UnifiedNode): boolean => {
    if (isNoiseNode(node)) return false;
    if (hasInteractiveSignal(node, 1)) return true;
    if (readSlotText(node)) return true;
    if (node.children.length >= 1) return true;
    return false;
};

const isNoiseNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (NOISE_ROLES.has(role) || NOISE_TAGS.has(tag)) return true;
    if (node.children.length === 0 && !readSlotText(node) && !hasInteractiveSignal(node, 0)) return true;
    return false;
};

const isActionWordText = (text: string): boolean => {
    const lower = text.toLowerCase();
    return ACTION_WORDS.some((word) => lower.includes(word));
};

const isVolatileText = (text: string): boolean => {
    const lower = text.toLowerCase();
    if (VOLATILE_PATTERN.test(lower)) return true;
    if (VOLATILE_KEYWORDS.some((word) => lower.includes(word))) return true;
    return false;
};

const buildParentIndex = (node: UnifiedNode, parent: UnifiedNode | null, parentById: Map<string, UnifiedNode | null>) => {
    parentById.set(node.id, parent);
    for (const child of node.children) {
        buildParentIndex(child, node, parentById);
    }
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const normalizeLower = (value: string | undefined): string => (value || '').trim().toLowerCase();

const HAS_TEXT_PATTERN = /[A-Za-z0-9\u4E00-\u9FFF]/;
const VOLATILE_PATTERN = /(^\d+$)|(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(\d{1,2}:\d{2})|(%$)|(^[#№]?\d+)/;
const VOLATILE_KEYWORDS = ['today', 'yesterday', 'now', 'pending', 'failed', 'success', '状态', '时间', '数量', '总数', 'percent'];
const TABLE_KEYWORDS = ['table', 'grid', 'datatable', 'data-table'];
const SEMANTIC_KEYWORDS = ['name', 'title', '编号', '名称', 'id', 'code'];
const LIST_TITLE_KEYWORDS = ['title', 'name', 'subject', '标题', '名称'];
const ACTION_WORDS = [
    'edit',
    'delete',
    'remove',
    'more',
    'view',
    'detail',
    'submit',
    'save',
    'open',
    '修改',
    '删除',
    '更多',
    '详情',
    '查看',
    '编辑',
];
const WRAPPER_ROLES = new Set(['generic', 'group', 'presentation', 'none', 'paragraph', 'text', 'div', 'span']);
const NOISE_ROLES = new Set(['none', 'presentation', 'separator']);
const NOISE_TAGS = new Set(['script', 'style', 'path']);
const TABLE_ROLES = new Set(['table', 'grid', 'treegrid', 'rowgroup']);
const TABLE_TAGS = new Set(['table', 'tbody', 'thead', 'tr']);
const LIST_ROLES = new Set(['list', 'listbox', 'menu', 'tablist']);
const LIST_TAGS = new Set(['ul', 'ol', 'menu']);
const ACTION_ROLES = new Set(['button', 'link', 'menuitem', 'tab']);
const ACTION_TAGS = new Set(['button', 'a']);
const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'menuitem',
    'tab',
    'textbox',
    'input',
    'textarea',
    'select',
    'checkbox',
    'radio',
    'combobox',
]);
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select']);
