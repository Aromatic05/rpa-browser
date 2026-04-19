import {
    getNodeAttr,
    getNodeBbox,
    getNodeContent,
    getNodeSemanticHints,
    mergeNodeSemanticHints,
    normalizeText,
    setNodeContent,
} from '../core/runtime_store';
import type { UnifiedNode } from '../core/types';

export const compress = (node: UnifiedNode): UnifiedNode | null => {
    activeNodeProfileCache = new WeakMap<UnifiedNode, NodeStaticProfile>();
    const result = compressNode(node, true, null);
    if (result.nodes.length === 0) {
        activeNodeProfileCache = null;
        return null;
    }

    const root = result.nodes[0] || null;
    if (!root) {
        activeNodeProfileCache = null;
        return null;
    }

    applyBudgetAwarePrune(root);
    activeNodeProfileCache = null;
    return root;
};

type CompressResult = {
    nodes: UnifiedNode[];
    liftedTexts: string[];
};

type NodeStaticProfile = {
    role: string;
    tag: string;
    className: string;
    hasOnclickAttr: boolean;
    hasHrefAttr: boolean;
    hasTabindexAttr: boolean;
};

type RegionBudgetKind = 'table' | 'list' | 'form' | 'dialog' | 'toolbar' | 'panel' | 'generic';

type RegionBudgetProfile = {
    activationNodes: number;
    baseMaxNodes: number;
    growthFactor: number;
    siblingTemplateCap: number;
    minTemplateRun: number;
};

type ResolvedRegionBudget = {
    kind: RegionBudgetKind;
    maxNodes: number;
    siblingTemplateCap: number;
    minTemplateRun: number;
};

type NodeBudgetCandidate = {
    node: UnifiedNode;
    parent: UnifiedNode | null;
    depth: number;
    score: number;
};

let activeNodeProfileCache: WeakMap<UnifiedNode, NodeStaticProfile> | null = null;

const compressNode = (node: UnifiedNode, isRoot: boolean, parent: UnifiedNode | null): CompressResult => {
    const nextChildren: UnifiedNode[] = [];
    const liftedFromChildren: string[] = [];

    for (const child of node.children) {
        const childResult = compressNode(child, false, node);
        nextChildren.push(...childResult.nodes);
        liftedFromChildren.push(...childResult.liftedTexts);
    }
    node.children = nextChildren;

    if (shouldDropSubtree(node, isRoot)) {
        return { nodes: [], liftedTexts: [] };
    }

    if (isDeleteNode(node, isRoot)) {
        return {
            nodes: [],
            liftedTexts: compactLiftTexts([...liftedFromChildren, ...collectOwnLiftableTexts(node)]),
        };
    }

    if (isAtomicSemanticNode(node)) {
        truncateAtomicNode(node);
    }

    if (!isRoot && isCollapsibleShell(node, parent)) {
        const liftedTexts = compactLiftTexts([...liftedFromChildren, ...collectOwnLiftableTexts(node)]);
        if (node.children.length === 1 && hasSemanticPayload(node)) {
            mergeNodeSemanticHints(node.children[0], getNodeSemanticHints(node) || {});
        }
        return {
            nodes: node.children,
            liftedTexts,
        };
    }

    removeRedundantTextChildren(node);
    if (liftedFromChildren.length > 0 && canReceiveLiftedText(node)) {
        applyLiftedText(node, liftedFromChildren);
        return { nodes: [node], liftedTexts: [] };
    }

    return {
        nodes: [node],
        liftedTexts: compactLiftTexts(liftedFromChildren),
    };
};

const applyBudgetAwarePrune = (root: UnifiedNode) => {
    const initialCount = countNodes(root);
    const budget = resolveRegionBudget(root, initialCount);
    if (budget.siblingTemplateCap > 0 && budget.minTemplateRun > 0) {
        collapseRepeatedTemplates(root, budget);
    }
    enforceInformationBudget(root, budget.maxNodes);
};

const countNodes = (root: UnifiedNode): number => {
    let count = 0;
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;
        count += 1;
        for (let index = current.children.length - 1; index >= 0; index -= 1) {
            stack.push(current.children[index]);
        }
    }
    return count;
};

const resolveRegionBudget = (root: UnifiedNode, totalNodes: number): ResolvedRegionBudget => {
    const kind = classifyRegionBudgetKind(root);
    const profile = REGION_BUDGET_PROFILE[kind];
    if (!profile || totalNodes <= profile.activationNodes) {
        return {
            kind,
            maxNodes: totalNodes,
            siblingTemplateCap: 0,
            minTemplateRun: 0,
        };
    }

    const scaled = profile.baseMaxNodes + Math.floor((totalNodes - profile.activationNodes) * profile.growthFactor);
    const maxNodes = Math.max(profile.baseMaxNodes, Math.min(totalNodes, scaled));
    return {
        kind,
        maxNodes,
        siblingTemplateCap: profile.siblingTemplateCap,
        minTemplateRun: profile.minTemplateRun,
    };
};

const classifyRegionBudgetKind = (root: UnifiedNode): RegionBudgetKind => {
    const role = nodeRole(root);
    const tag = nodeTag(root);
    const cls = nodeClassName(root);

    if (TABLE_BUDGET_ROLES.has(role) || TABLE_BUDGET_TAGS.has(tag) || TABLE_BUDGET_CLASS_HINTS.some((hint) => cls.includes(hint))) {
        return 'table';
    }
    if (LIST_BUDGET_ROLES.has(role) || LIST_BUDGET_TAGS.has(tag)) {
        return 'list';
    }
    if (FORM_BUDGET_ROLES.has(role) || FORM_BUDGET_TAGS.has(tag)) {
        return 'form';
    }
    if (DIALOG_BUDGET_ROLES.has(role)) {
        return 'dialog';
    }
    if (TOOLBAR_BUDGET_ROLES.has(role) || cls.includes('toolbar')) {
        return 'toolbar';
    }
    if (PANEL_BUDGET_ROLES.has(role) || PANEL_BUDGET_CLASS_HINTS.some((hint) => cls.includes(hint))) {
        return 'panel';
    }
    return 'generic';
};

const collapseRepeatedTemplates = (root: UnifiedNode, budget: ResolvedRegionBudget) => {
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;

        collapseRepeatedTemplateChildren(current, budget);
        for (let index = current.children.length - 1; index >= 0; index -= 1) {
            stack.push(current.children[index]);
        }
    }
};

const collapseRepeatedTemplateChildren = (node: UnifiedNode, budget: ResolvedRegionBudget) => {
    if (node.children.length < budget.minTemplateRun) return;

    const indexesBySignature = new Map<string, number[]>();
    for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        const signature = buildTemplateSignature(child);
        const bucket = indexesBySignature.get(signature) || [];
        bucket.push(index);
        indexesBySignature.set(signature, bucket);
    }

    const removeIndexes = new Set<number>();
    for (const indexes of indexesBySignature.values()) {
        if (indexes.length <= budget.siblingTemplateCap) continue;
        const keepIndexes = pickTemplateSampleIndexes(node.children, indexes, budget.siblingTemplateCap);
        for (const index of indexes) {
            if (!keepIndexes.has(index)) {
                removeIndexes.add(index);
            }
        }
    }

    if (removeIndexes.size === 0) return;
    node.children = node.children.filter((_, index) => !removeIndexes.has(index));
};

const buildTemplateSignature = (node: UnifiedNode): string => {
    const role = nodeRole(node);
    const tag = nodeTag(node);
    const cls = normalizeTemplateClass(nodeClassName(node));
    const textFlag = normalizeText(node.name || getNodeContent(node)) ? 't' : '-';
    const childShape = node.children
        .slice(0, 6)
        .map((child) => `${nodeRole(child)}:${nodeTag(child)}`)
        .join('|');
    const interactiveChildCount = node.children.reduce((count, child) => count + (isInteractiveNode(child) ? 1 : 0), 0);
    return `${role}|${tag}|${cls}|${node.children.length}|${interactiveChildCount}|${textFlag}|${childShape}`;
};

const normalizeTemplateClass = (className: string): string => {
    if (!className) return '';
    return className
        .split(/\s+/)
        .filter((token) => token.length > 0)
        .slice(0, 4)
        .map((token) => token.replace(/\d+/g, '#').replace(/[_-][a-z0-9]{5,}$/i, ''))
        .join('.');
};

const pickTemplateSampleIndexes = (
    children: UnifiedNode[],
    indexes: number[],
    cap: number,
): Set<number> => {
    if (indexes.length <= cap) {
        return new Set(indexes);
    }

    const first = indexes[0];
    const last = indexes[indexes.length - 1];
    const keep = new Set<number>([first, last]);

    for (const index of indexes) {
        if (isTemplateAnchorNode(children[index])) {
            keep.add(index);
        }
    }

    if (keep.size > cap) {
        const ranked = [...keep]
            .filter((index) => index !== first && index !== last)
            .sort((left, right) => scoreNodeImportance(children[right], 1) - scoreNodeImportance(children[left], 1));
        const bounded = new Set<number>([first, last]);
        for (const index of ranked) {
            if (bounded.size >= cap) break;
            bounded.add(index);
        }
        return bounded;
    }

    if (keep.size < cap) {
        const needed = cap - keep.size;
        const sampled = sampleIndexesEvenly(indexes, needed, keep);
        for (const index of sampled) {
            keep.add(index);
        }
    }

    return keep;
};

const sampleIndexesEvenly = (indexes: number[], count: number, exclude: Set<number>): number[] => {
    if (count <= 0) return [];

    const available = indexes.filter((index) => !exclude.has(index));
    if (available.length <= count) return available;

    const sampled: number[] = [];
    const sampledSet = new Set<number>();
    for (let step = 1; step <= count; step += 1) {
        const ratio = step / (count + 1);
        const pick = available[Math.round((available.length - 1) * ratio)];
        if (pick === undefined || sampledSet.has(pick)) continue;
        sampled.push(pick);
        sampledSet.add(pick);
    }

    if (sampled.length >= count) {
        return sampled.slice(0, count);
    }

    for (const index of available) {
        if (sampledSet.has(index)) continue;
        sampled.push(index);
        sampledSet.add(index);
        if (sampled.length >= count) break;
    }
    return sampled;
};

const isTemplateAnchorNode = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return true;
    if (node.target) return true;
    if (hasSemanticPayload(node)) return true;
    if (hasInteractiveDescendant(node, 2)) return true;
    if (isTruthyAttr(getNodeAttr(node, 'aria-current'))) return true;
    if (isTruthyAttr(getNodeAttr(node, 'aria-selected'))) return true;
    if (isTruthyAttr(getNodeAttr(node, 'data-active'))) return true;
    if (isTruthyAttr(getNodeAttr(node, 'active'))) return true;
    return false;
};

const hasInteractiveDescendant = (node: UnifiedNode, maxDepth: number): boolean => {
    if (maxDepth <= 0) return false;
    const stack: Array<{ node: UnifiedNode; depth: number }> = [];
    for (const child of node.children) {
        stack.push({ node: child, depth: 1 });
    }

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;
        if (isInteractiveNode(current.node)) return true;
        if (current.depth >= maxDepth) continue;
        for (const child of current.node.children) {
            stack.push({
                node: child,
                depth: current.depth + 1,
            });
        }
    }

    return false;
};

const enforceInformationBudget = (root: UnifiedNode, maxNodes: number) => {
    const candidatesById = new Map<string, NodeBudgetCandidate>();
    let totalNodes = 0;

    const stack: Array<{ node: UnifiedNode; parent: UnifiedNode | null; depth: number }> = [
        {
            node: root,
            parent: null,
            depth: 0,
        },
    ];

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;
        totalNodes += 1;
        candidatesById.set(current.node.id, {
            node: current.node,
            parent: current.parent,
            depth: current.depth,
            score: scoreNodeImportance(current.node, current.depth),
        });
        for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
            stack.push({
                node: current.node.children[index],
                parent: current.node,
                depth: current.depth + 1,
            });
        }
    }

    if (totalNodes <= maxNodes) return;

    const alwaysKeepIds = new Set<string>();
    for (const candidate of candidatesById.values()) {
        if (shouldAlwaysKeepForBudget(candidate)) {
            alwaysKeepIds.add(candidate.node.id);
        }
    }

    const heap: NodeBudgetCandidate[] = [];
    for (const candidate of candidatesById.values()) {
        if (alwaysKeepIds.has(candidate.node.id)) continue;
        if (candidate.node.children.length > 0) continue;
        pushBudgetHeap(heap, candidate);
    }

    const removed = new Set<string>();
    while (totalNodes > maxNodes) {
        const next = popBudgetHeap(heap);
        if (!next) break;
        if (removed.has(next.node.id)) continue;
        if (alwaysKeepIds.has(next.node.id)) continue;
        if (next.node.children.length > 0) continue;
        if (!next.parent) continue;

        const childIndex = next.parent.children.findIndex((child) => child.id === next.node.id);
        if (childIndex < 0) continue;

        next.parent.children.splice(childIndex, 1);
        removed.add(next.node.id);
        totalNodes -= 1;

        const parentCandidate = candidatesById.get(next.parent.id);
        if (!parentCandidate) continue;
        if (alwaysKeepIds.has(parentCandidate.node.id)) continue;
        if (parentCandidate.node.children.length !== 0) continue;
        pushBudgetHeap(heap, parentCandidate);
    }
};

const shouldAlwaysKeepForBudget = (candidate: NodeBudgetCandidate): boolean => {
    if (candidate.depth <= 1) return true;
    if (candidate.score >= IMPORTANCE_HARD_KEEP_SCORE) return true;

    const role = nodeRole(candidate.node);
    if (BUDGET_CRITICAL_ROLES.has(role)) return true;
    if (isInteractiveNode(candidate.node)) return true;
    if (candidate.node.target) return true;
    if (hasSemanticPayload(candidate.node)) return true;
    if (isTemplateAnchorNode(candidate.node) && candidate.depth <= 3) return true;
    return false;
};

const scoreNodeImportance = (node: UnifiedNode, depth: number): number => {
    let score = 0;
    if (isInteractiveNode(node)) score += 3;
    if (node.target) score += 2;
    if (hasSemanticPayload(node)) score += 2.6;
    if (PRESERVE_ROLES.has(nodeRole(node))) score += 1.4;
    if (BUDGET_CRITICAL_ROLES.has(nodeRole(node))) score += 1.1;

    const name = normalizeText(node.name);
    const content = normalizeText(getNodeContent(node));
    if (name) score += 1.2;
    if (content) score += Math.min(1.2, content.length / 48);

    if (node.tier === 'A') score += 1.8;
    else if (node.tier === 'B') score += 1;
    else if (node.tier === 'C') score += 0.35;
    else if (node.tier === 'D') score -= 1;

    if (isNodeHiddenFromView(node)) score -= 4;
    if (isPseudoNode(node)) score -= 2;
    if (isDecorativeNoise(node)) score -= 1.8;
    if (isWrapperRoleOrTag(node) && !hasVisibleSemanticPayload(node)) score -= 1;

    const depthPenalty = Math.max(0, depth - 8) * 0.18;
    score -= depthPenalty;
    return score;
};

const pushBudgetHeap = (heap: NodeBudgetCandidate[], candidate: NodeBudgetCandidate) => {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index > 0) {
        const parentIndex = Math.floor((index - 1) / 2);
        if (!isHigherPrunePriority(heap[index], heap[parentIndex])) break;
        const tmp = heap[index];
        heap[index] = heap[parentIndex];
        heap[parentIndex] = tmp;
        index = parentIndex;
    }
};

const popBudgetHeap = (heap: NodeBudgetCandidate[]): NodeBudgetCandidate | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length === 0 || !last) {
        return top;
    }

    heap[0] = last;
    let index = 0;
    while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;

        if (left < heap.length && isHigherPrunePriority(heap[left], heap[smallest])) {
            smallest = left;
        }
        if (right < heap.length && isHigherPrunePriority(heap[right], heap[smallest])) {
            smallest = right;
        }
        if (smallest === index) break;

        const tmp = heap[index];
        heap[index] = heap[smallest];
        heap[smallest] = tmp;
        index = smallest;
    }

    return top;
};

const isHigherPrunePriority = (left: NodeBudgetCandidate, right: NodeBudgetCandidate): boolean => {
    if (left.score !== right.score) return left.score < right.score;
    if (left.depth !== right.depth) return left.depth > right.depth;
    return left.node.id < right.node.id;
};

const shouldDropSubtree = (node: UnifiedNode, isRoot: boolean): boolean => {
    const tag = nodeTag(node);
    const role = nodeRole(node);
    // head 分支必须强制裁掉，即使它正好是当前 region 根。
    if (FORCE_DROP_SUBTREE_TAGS.has(tag) || FORCE_DROP_SUBTREE_ROLES.has(role)) return true;

    if (isRoot) return false;
    if (isNodeHiddenFromView(node)) return true;
    if (isProtectedNode(node)) return false;

    if (DROP_SUBTREE_TAGS.has(tag) || DROP_SUBTREE_ROLES.has(role)) return true;
    if (VECTOR_SUBTREE_TAGS.has(tag) && !isMeaningfulImageNode(node)) return true;
    return false;
};

const isDeleteNode = (node: UnifiedNode, isRoot: boolean): boolean => {
    if (isRoot) return false;
    if (isNodeHiddenFromView(node)) return true;
    if (isProtectedNode(node)) return false;
    if (node.tier === 'D') return true;
    if (isPseudoNode(node)) return true;

    const tag = nodeTag(node);
    if (DELETE_TAGS.has(tag)) return true;
    if (isDecorativeNoise(node)) return true;
    if (isMeaninglessEmptyShell(node)) return true;
    return false;
};

const isCollapsibleShell = (node: UnifiedNode, parent: UnifiedNode | null): boolean => {
    if (isProtectedNode(node)) return false;
    if (!isWrapperRoleOrTag(node)) return false;
    if (node.children.length === 0) return false;

    const ownTexts = collectOwnLiftableTexts(node);
    if (ownTexts.length > 0 && !(parent && canReceiveLiftedText(parent))) return false;
    return true;
};

const isAtomicSemanticNode = (node: UnifiedNode): boolean => {
    const role = nodeRole(node);
    const tag = nodeTag(node);
    if (!ATOMIC_ROLES.has(role) && !ATOMIC_TAGS.has(tag)) return false;
    if (node.name || getNodeContent(node) || node.target) return true;
    return isInteractiveNode(node);
};

const truncateAtomicNode = (node: UnifiedNode) => {
    const droppedTexts: Array<string | undefined> = [];
    for (const child of node.children) {
        collectDescendantLiftableTexts(child, droppedTexts);
    }
    node.children = [];
    if (droppedTexts.length > 0 && canReceiveLiftedText(node)) {
        applyLiftedText(node, compactLiftTexts(droppedTexts));
    }
};

const removeRedundantTextChildren = (node: UnifiedNode) => {
    const parentText = normalizeText(node.name || getNodeContent(node));
    const nextChildren: UnifiedNode[] = [];
    for (const child of node.children) {
        const childText = normalizeText(child.name || getNodeContent(child));
        if (!childText) {
            nextChildren.push(child);
            continue;
        }
        if (parentText && isInlineTextShell(child) && isNearDuplicateText(parentText, childText)) {
            continue;
        }
        nextChildren.push(child);
    }
    node.children = nextChildren;
};

const applyLiftedText = (node: UnifiedNode, rawTexts: string[]) => {
    const candidates = compactLiftTexts(rawTexts);
    if (candidates.length === 0) return;

    if (!node.name && shouldAttachName(node)) {
        const primary = candidates[0];
        if (primary) {
            node.name = primary;
        }
    }

    let mergedContent = normalizeText(getNodeContent(node));
    for (const picked of candidates) {
        if (!picked) continue;
        if (!mergedContent) {
            mergedContent = picked;
            continue;
        }
        if (mergedContent.includes(picked) || isNearDuplicateText(mergedContent, picked)) {
            continue;
        }
        mergedContent = `${mergedContent} ${picked}`.trim();
    }

    if (mergedContent) {
        setNodeContent(node, mergedContent);
    }
};

const shouldAttachName = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return true;
    return NAME_RECEIVER_ROLES.has(nodeRole(node));
};

const canReceiveLiftedText = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return true;
    if (hasSemanticPayload(node)) return true;
    return TEXT_RECEIVER_ROLES.has(nodeRole(node));
};

const hasSemanticPayload = (node: UnifiedNode): boolean => {
    const hints = getNodeSemanticHints(node);
    if (!hints) return false;
    return Boolean(hints.entityNodeId || hints.fieldLabel || hints.actionIntent || hints.actionTargetNodeId);
};

const isProtectedNode = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return true;
    if (node.target) return true;
    if (hasSemanticPayload(node)) return true;
    if (PRESERVE_ROLES.has(nodeRole(node))) return true;
    if (isMeaningfulImageNode(node)) return true;
    return false;
};

const isInteractiveNode = (node: UnifiedNode): boolean => {
    const profile = getNodeStaticProfile(node);
    const role = profile.role;
    const tag = profile.tag;
    if (INTERACTIVE_ROLES.has(role) || INTERACTIVE_TAGS.has(tag)) return true;
    if (node.target) return true;
    if (profile.hasOnclickAttr || profile.hasHrefAttr || profile.hasTabindexAttr) return true;
    return false;
};

const isMeaningfulImageNode = (node: UnifiedNode): boolean => {
    const role = nodeRole(node);
    const tag = nodeTag(node);
    if (role !== 'image' && role !== 'img' && tag !== 'img') return false;
    if (normalizeText(node.name) || normalizeText(getNodeContent(node))) return true;
    if (normalizeText(getNodeAttr(node, 'alt')) || normalizeText(getNodeAttr(node, 'src'))) return true;
    return false;
};

const isNodeHiddenFromView = (node: UnifiedNode): boolean => {
    if (isTruthyAttr(getNodeAttr(node, 'hidden'))) return true;
    if (isTruthyAttr(getNodeAttr(node, 'inert'))) return true;
    if (isTruthyAttr(getNodeAttr(node, 'aria-hidden'))) return true;

    const style = normalizeText(getNodeAttr(node, 'style'))?.toLowerCase() || '';
    if (HIDDEN_STYLE_PATTERN.test(style)) return true;

    const cls = nodeClassName(node);
    if (cls && HIDDEN_CLASS_PATTERN.test(cls)) return true;

    const bbox = getNodeBbox(node);
    if (bbox && (bbox.width <= 0 || bbox.height <= 0) && !hasVisibleSemanticPayload(node)) {
        return true;
    }

    return false;
};

const hasVisibleSemanticPayload = (node: UnifiedNode): boolean => {
    if (normalizeText(node.name) || normalizeText(getNodeContent(node))) return true;
    if (node.target) return true;
    if (hasSemanticPayload(node)) return true;
    if (isInteractiveNode(node)) return true;
    if (isMeaningfulImageNode(node)) return true;
    return false;
};

const isTruthyAttr = (raw: string | undefined): boolean => {
    const value = normalizeText(raw)?.toLowerCase();
    if (!value) return false;
    return value === 'true' || value === '1' || value === 'yes' || value === 'hidden';
};

const isDecorativeNoise = (node: UnifiedNode): boolean => {
    if (node.children.length > 0) return false;
    if (node.name || getNodeContent(node)) return false;
    if (node.target) return false;

    const role = nodeRole(node);
    const tag = nodeTag(node);
    const cls = nodeClassName(node);
    if (DECORATIVE_ROLES.has(role) || DECORATIVE_TAGS.has(tag)) return true;
    if (cls && DECORATIVE_CLASS_PATTERN.test(cls)) return true;
    return false;
};

const isMeaninglessEmptyShell = (node: UnifiedNode): boolean => {
    if (node.children.length > 0) return false;
    if (node.name || getNodeContent(node)) return false;
    if (node.target) return false;
    return isWrapperRoleOrTag(node);
};

const isPseudoNode = (node: UnifiedNode): boolean => {
    const role = nodeRole(node);
    const tag = nodeTag(node);
    return PSEUDO_ROLES.has(role) || PSEUDO_TAGS.has(tag);
};

const isInlineTextShell = (node: UnifiedNode): boolean => {
    const role = nodeRole(node);
    const tag = nodeTag(node);
    return INLINE_TEXT_SHELL_ROLES.has(role) || INLINE_TEXT_SHELL_TAGS.has(tag);
};

const isWrapperRoleOrTag = (node: UnifiedNode): boolean => {
    const role = nodeRole(node);
    const tag = nodeTag(node);
    return WRAPPER_ROLES.has(role) || WRAPPER_TAGS.has(tag);
};

const collectOwnLiftableTexts = (node: UnifiedNode): string[] => {
    return compactLiftTexts([node.name, getNodeContent(node)]);
};

const collectDescendantLiftableTexts = (node: UnifiedNode, sink: Array<string | undefined>) => {
    sink.push(node.name, getNodeContent(node));
    for (const child of node.children) {
        collectDescendantLiftableTexts(child, sink);
    }
};

const compactLiftTexts = (values: Array<string | undefined>): string[] => {
    const dedup: string[] = [];
    for (const value of values) {
        const normalized = normalizeText(value);
        if (!normalized) continue;
        if (!isLightweightText(normalized)) continue;
        if (dedup.some((item) => isNearDuplicateText(item, normalized))) continue;
        dedup.push(normalized);
    }
    return dedup;
};

const isNearDuplicateText = (leftRaw: string | undefined, rightRaw: string | undefined): boolean => {
    const left = normalizeText(leftRaw);
    const right = normalizeText(rightRaw);
    if (!left || !right) return false;
    if (left === right) return true;

    const leftCanonical = canonicalizeText(left);
    const rightCanonical = canonicalizeText(right);
    if (!leftCanonical || !rightCanonical) return false;
    if (leftCanonical === rightCanonical) return true;

    const shorter = leftCanonical.length <= rightCanonical.length ? leftCanonical : rightCanonical;
    const longer = shorter === leftCanonical ? rightCanonical : leftCanonical;
    if (shorter.length < 4) return false;
    if (!longer.includes(shorter)) return false;
    const ratio = shorter.length / longer.length;
    return ratio >= 0.78;
};

const canonicalizeText = (value: string): string => {
    return value
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '')
        .trim();
};

const isLightweightText = (value: string): boolean => {
    if (value.length > 64) return false;
    const tokens = value.split(' ').filter((token) => token.length > 0);
    if (tokens.length > 10) return false;
    if (!HAS_TEXT_CHAR_PATTERN.test(value)) return false;
    return true;
};

const nodeRole = (node: UnifiedNode): string => getNodeStaticProfile(node).role;

const nodeTag = (node: UnifiedNode): string => getNodeStaticProfile(node).tag;

const nodeClassName = (node: UnifiedNode): string => getNodeStaticProfile(node).className;

const getNodeStaticProfile = (node: UnifiedNode): NodeStaticProfile => {
    if (!activeNodeProfileCache) {
        activeNodeProfileCache = new WeakMap<UnifiedNode, NodeStaticProfile>();
    }

    const cached = activeNodeProfileCache.get(node);
    if (cached) return cached;

    const profile: NodeStaticProfile = {
        role: normalizeRole(node.role),
        tag: normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName') || getNodeAttr(node, 'nodeName')),
        className: normalizeRole(getNodeAttr(node, 'class')),
        hasOnclickAttr: Boolean(getNodeAttr(node, 'onclick')),
        hasHrefAttr: Boolean(getNodeAttr(node, 'href')),
        hasTabindexAttr: Boolean(getNodeAttr(node, 'tabindex')),
    };
    activeNodeProfileCache.set(node, profile);
    return profile;
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();

const DELETE_TAGS = new Set(['script', 'style', 'svg', 'path']);
const DECORATIVE_TAGS = new Set(['i']);
const DECORATIVE_ROLES = new Set(['none', 'presentation']);
const WRAPPER_ROLES = new Set(['generic', 'group', 'none', 'presentation', 'text', 'paragraph', 'div', 'span']);
const WRAPPER_TAGS = new Set(['div', 'span', 'p']);
const INLINE_TEXT_SHELL_ROLES = new Set(['generic', 'text', 'paragraph', 'span', 'div']);
const INLINE_TEXT_SHELL_TAGS = new Set(['span', 'strong', 'em', 'b', 'i']);
const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'input',
    'textarea',
    'select',
    'checkbox',
    'radio',
    'switch',
    'combobox',
    'menuitem',
    'option',
    'tab',
]);
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select', 'option']);
const ATOMIC_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'switch',
    'combobox',
    'menuitem',
    'tab',
    'heading',
    'image',
    'img',
]);
const ATOMIC_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select', 'img']);
const PRESERVE_ROLES = new Set([
    'root',
    'html',
    'body',
    'main',
    'navigation',
    'banner',
    'contentinfo',
    'complementary',
    'region',
    'form',
    'dialog',
    'alertdialog',
    'table',
    'list',
    'toolbar',
]);
const NAME_RECEIVER_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option']);
const TEXT_RECEIVER_ROLES = new Set([
    ...NAME_RECEIVER_ROLES,
    'heading',
    'label',
    'cell',
    'gridcell',
    'columnheader',
    'rowheader',
    'dialog',
]);
const DROP_SUBTREE_TAGS = new Set(['meta', 'link', 'script', 'style', 'noscript', 'template', 'source', 'track']);
const FORCE_DROP_SUBTREE_TAGS = new Set(['head']);
const FORCE_DROP_SUBTREE_ROLES = new Set(['head']);
const DROP_SUBTREE_ROLES = new Set(['doc-subtitle', 'doc-tip', 'doc-endnote']);
const PSEUDO_ROLES = new Set(['::before', '::after', 'before', 'after']);
const PSEUDO_TAGS = new Set(['::before', '::after']);
const VECTOR_SUBTREE_TAGS = new Set(['svg', 'path', 'g', 'defs', 'symbol', 'use', 'clippath']);
const TABLE_BUDGET_ROLES = new Set(['table', 'grid', 'treegrid', 'rowgroup']);
const TABLE_BUDGET_TAGS = new Set(['table', 'tbody', 'thead']);
const TABLE_BUDGET_CLASS_HINTS = ['table', 'grid', 'datatable', 'data-table'];
const LIST_BUDGET_ROLES = new Set(['list', 'listbox', 'menu', 'tablist']);
const LIST_BUDGET_TAGS = new Set(['ul', 'ol', 'menu']);
const FORM_BUDGET_ROLES = new Set(['form']);
const FORM_BUDGET_TAGS = new Set(['form']);
const DIALOG_BUDGET_ROLES = new Set(['dialog', 'alertdialog']);
const TOOLBAR_BUDGET_ROLES = new Set(['toolbar']);
const PANEL_BUDGET_ROLES = new Set(['region', 'complementary', 'contentinfo', 'main']);
const PANEL_BUDGET_CLASS_HINTS = ['panel', 'card', 'layout'];
const BUDGET_CRITICAL_ROLES = new Set([
    'table',
    'list',
    'row',
    'columnheader',
    'rowheader',
    'form',
    'dialog',
    'toolbar',
    'heading',
    'label',
]);
const REGION_BUDGET_PROFILE: Record<RegionBudgetKind, RegionBudgetProfile> = {
    table: {
        activationNodes: 150,
        baseMaxNodes: 320,
        growthFactor: 0.11,
        siblingTemplateCap: 12,
        minTemplateRun: 16,
    },
    list: {
        activationNodes: 120,
        baseMaxNodes: 220,
        growthFactor: 0.09,
        siblingTemplateCap: 10,
        minTemplateRun: 14,
    },
    form: {
        activationNodes: 130,
        baseMaxNodes: 280,
        growthFactor: 0.09,
        siblingTemplateCap: 10,
        minTemplateRun: 14,
    },
    dialog: {
        activationNodes: 100,
        baseMaxNodes: 200,
        growthFactor: 0.07,
        siblingTemplateCap: 10,
        minTemplateRun: 12,
    },
    toolbar: {
        activationNodes: 70,
        baseMaxNodes: 100,
        growthFactor: 0.04,
        siblingTemplateCap: 8,
        minTemplateRun: 10,
    },
    panel: {
        activationNodes: 120,
        baseMaxNodes: 240,
        growthFactor: 0.08,
        siblingTemplateCap: 10,
        minTemplateRun: 14,
    },
    generic: {
        activationNodes: 150,
        baseMaxNodes: 220,
        growthFactor: 0.07,
        siblingTemplateCap: 10,
        minTemplateRun: 14,
    },
};
const IMPORTANCE_HARD_KEEP_SCORE = 6.6;
const DECORATIVE_CLASS_PATTERN = /\b(icon|spinner|loading|skeleton|divider)\b/i;
const HIDDEN_CLASS_PATTERN = /\b(hidden|is-hidden|u-hidden|visually-hidden|sr-only|d-none)\b/i;
const HIDDEN_STYLE_PATTERN =
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?|content-visibility\s*:\s*hidden)\b/i;
const HAS_TEXT_CHAR_PATTERN = /[\p{L}\p{N}]/u;
