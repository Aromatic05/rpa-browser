import { isInteractiveNode } from '../core/interactive';
import { cloneTreeWithRuntime, getNodeContent, normalizeText } from '../core/runtime_store';
import type {
    SnapshotDiffBaselineKey,
    SnapshotDiffSkippedReason,
    SnapshotFilter,
    SnapshotResult,
    UnifiedNode,
} from '../core/types';
import { buildEntityIndex } from '../indexes/entity';
import { buildExternalIndexes } from '../indexes/external_indexes';
import { buildLocatorIndex } from '../indexes/locator';
import { buildSnapshot } from './build_snapshot';
import { projectInteractionStateContent } from './content_tokens';

const DEFAULT_MAX_VIEW_NODE_COUNT = 1200;
const DIFF_CHANGED_NODE_BROAD_LIMIT = 200;
const DIFF_ABSOLUTE_NODE_BROAD_LIMIT = 1000;
const DIFF_COVERAGE_BROAD_LIMIT = 0.9;
const DIFF_ROOT_COVERAGE_BROAD_LIMIT = 0.65;
const DIFF_BROAD_MIN_TOTAL_NODES = 24;
const POPUP_LIKE_ROLES = new Set(['dialog', 'menu', 'listbox', 'panel']);

type SnapshotViewError = {
    code: string;
    message: string;
    details?: unknown;
};

type NormalizedSnapshotFilter = {
    roleSet: Set<string> | null;
    roleList: string[];
    textNeedle?: string;
    interactiveOnly: boolean;
};

type BuildSnapshotViewInput = {
    contain?: string;
    depth?: number;
    filter?: SnapshotFilter;
};

type BuildSnapshotViewResult =
    | {
          ok: true;
          snapshot: SnapshotResult;
          resolvedContainId: string;
          resolvedDepth: number;
          filterSignature: string;
          truncated: boolean;
      }
    | {
          ok: false;
          error: SnapshotViewError;
      };

type ComputeMinimalDiffResult =
    | {
          mode: 'diff';
          root: UnifiedNode;
          diffRootId: string;
          changedNodeCount: number;
      }
    | {
          mode: 'full';
          reason: Extract<SnapshotDiffSkippedReason, 'contain_unavailable' | 'too_broad'>;
      };

type TreeIndex = {
    rootId: string;
    nodeCount: number;
    byId: Map<string, UnifiedNode>;
    parentById: Map<string, string | null>;
};

export const buildSnapshotView = (
    snapshot: SnapshotResult,
    args: BuildSnapshotViewInput,
    options?: { maxViewNodes?: number },
): BuildSnapshotViewResult => {
    const resolvedContain = resolveContainNode(snapshot, args.contain);
    if (!resolvedContain.ok) {
        return {
            ok: false,
            error: resolvedContain.error,
        };
    }

    const resolvedDepth = resolveDepth(args.depth);
    if (!resolvedDepth.ok) {
        return {
            ok: false,
            error: resolvedDepth.error,
        };
    }

    const normalizedFilter = normalizeSnapshotFilter(args.filter);
    const filterSignature = buildFilterSignature(normalizedFilter);

    const scopedRoot = cloneTreeWithRuntime(resolvedContain.node);
    const truncated = trimTreeByDepthAndNodeLimit(
        scopedRoot,
        resolvedDepth.value,
        resolveMaxViewNodeCount(options?.maxViewNodes),
    );
    projectInteractionStateContent(scopedRoot);
    if (hasActiveFilter(normalizedFilter)) {
        applyFilterPrune(scopedRoot, normalizedFilter);
    }

    const scopedSnapshot = buildSnapshotFromViewRoot(scopedRoot, snapshot.cacheStats);
    return {
        ok: true,
        snapshot: scopedSnapshot,
        resolvedContainId: resolvedContain.node.id,
        resolvedDepth: resolvedDepth.value,
        filterSignature,
        truncated,
    };
};

export const computeMinimalChangedSubtree = (
    currentViewRoot: UnifiedNode,
    baselineRoot: UnifiedNode,
): ComputeMinimalDiffResult => {
    if (!currentViewRoot || !baselineRoot) {
        return { mode: 'full', reason: 'contain_unavailable' };
    }
    if (currentViewRoot.id !== baselineRoot.id) {
        return { mode: 'full', reason: 'contain_unavailable' };
    }

    const current = indexTree(currentViewRoot);
    const baseline = indexTree(baselineRoot);
    const changedNodeIds = collectChangedNodeIds(current, baseline);

    if (changedNodeIds.size === 0) {
        const rootOnly = cloneTreeWithRuntime(currentViewRoot);
        rootOnly.children = [];
        return {
            mode: 'diff',
            root: rootOnly,
            diffRootId: currentViewRoot.id,
            changedNodeCount: 0,
        };
    }

    const promotedPopupRootId = pickPopupLikeDiffRootId(changedNodeIds, current, baseline);
    const diffRootId = promotedPopupRootId || computeLowestCommonAncestorId([...changedNodeIds], current);
    const diffRoot = current.byId.get(diffRootId);
    if (!diffRoot) {
        return { mode: 'full', reason: 'contain_unavailable' };
    }

    const diffNodeCount = countSubtreeNodes(diffRoot);
    const changedNodeCount = changedNodeIds.size;
    if (isTooBroadDiff(current.nodeCount, diffNodeCount, changedNodeCount, diffRootId === current.rootId)) {
        return { mode: 'full', reason: 'too_broad' };
    }

    return {
        mode: 'diff',
        root: cloneTreeWithRuntime(diffRoot),
        diffRootId,
        changedNodeCount,
    };
};

export const buildSnapshotDiffBaselineKey = (key: SnapshotDiffBaselineKey): string => {
    const contain = normalizeText(key.contain) || 'virtual-root';
    const depth = Number.isFinite(key.depth) ? Math.trunc(key.depth) : -1;
    const filterSignature = normalizeText(key.filterSignature) || '{}';
    return JSON.stringify({ contain, depth, filterSignature });
};

const resolveContainNode = (
    snapshot: SnapshotResult,
    contain: string | undefined,
):
    | {
          ok: true;
          node: UnifiedNode;
      }
    | {
          ok: false;
          error: SnapshotViewError;
      } => {
    if (contain === undefined) {
        return { ok: true, node: snapshot.root };
    }

    const normalizedContain = normalizeText(contain);
    if (!normalizedContain) {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'snapshot contain must be a non-empty node id',
                details: { contain },
            },
        };
    }

    const node = snapshot.nodeIndex[normalizedContain];
    if (!node) {
        return {
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'snapshot contain node id not found',
                details: { contain: normalizedContain },
            },
        };
    }

    return {
        ok: true,
        node,
    };
};

const resolveDepth = (
    depth: number | undefined,
):
    | {
          ok: true;
          value: number;
      }
    | {
          ok: false;
          error: SnapshotViewError;
      } => {
    if (depth === undefined) {
        return { ok: true, value: -1 };
    }

    if (!Number.isFinite(depth) || !Number.isInteger(depth) || depth < -1) {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'snapshot depth must be an integer and greater than or equal to -1',
                details: { depth },
            },
        };
    }

    return {
        ok: true,
        value: depth,
    };
};

const normalizeSnapshotFilter = (filter: SnapshotFilter | undefined): NormalizedSnapshotFilter => {
    const roleList = normalizeRoleList(filter?.role);
    const textNeedle = normalizeText(filter?.text)?.toLowerCase();
    return {
        roleSet: roleList.length > 0 ? new Set(roleList) : null,
        roleList,
        textNeedle,
        interactiveOnly: filter?.interactive === true,
    };
};

const buildFilterSignature = (filter: NormalizedSnapshotFilter): string => {
    const normalized: {
        role?: string[];
        text?: string;
        interactive?: boolean;
    } = {};

    if (filter.roleList.length > 0) {
        normalized.role = filter.roleList;
    }
    if (filter.textNeedle) {
        normalized.text = filter.textNeedle;
    }
    if (filter.interactiveOnly) {
        normalized.interactive = true;
    }
    return JSON.stringify(normalized);
};

const hasActiveFilter = (filter: NormalizedSnapshotFilter): boolean => {
    return filter.roleList.length > 0 || Boolean(filter.textNeedle) || filter.interactiveOnly;
};

const trimTreeByDepthAndNodeLimit = (root: UnifiedNode, depth: number, maxNodes: number): boolean => {
    let nodeCount = 1;
    let truncated = false;

    const walk = (node: UnifiedNode, level: number) => {
        if (depth >= 0 && level >= depth) {
            node.children = [];
            return;
        }

        if (nodeCount >= maxNodes) {
            if (node.children.length > 0) {
                node.children = [];
                truncated = true;
            }
            return;
        }

        const originalChildren = node.children;
        const nextChildren: UnifiedNode[] = [];
        for (const child of originalChildren) {
            if (nodeCount >= maxNodes) {
                truncated = true;
                break;
            }
            nodeCount += 1;
            walk(child, level + 1);
            nextChildren.push(child);
        }

        if (nextChildren.length !== originalChildren.length) {
            truncated = true;
        }
        node.children = nextChildren;
    };

    walk(root, 0);
    return truncated;
};

const applyFilterPrune = (root: UnifiedNode, filter: NormalizedSnapshotFilter) => {
    const keep = pruneByFilter(root, filter);
    if (!keep) {
        root.children = [];
    }
};

const pruneByFilter = (node: UnifiedNode, filter: NormalizedSnapshotFilter): boolean => {
    const children: UnifiedNode[] = [];
    for (const child of node.children) {
        if (pruneByFilter(child, filter)) {
            children.push(child);
        }
    }
    node.children = children;

    return isNodeMatchedByFilter(node, filter) || children.length > 0;
};

const isNodeMatchedByFilter = (node: UnifiedNode, filter: NormalizedSnapshotFilter): boolean => {
    if (filter.roleSet && !filter.roleSet.has(normalizeRole(node.role))) {
        return false;
    }

    if (filter.textNeedle) {
        const name = normalizeText(node.name)?.toLowerCase();
        const inlineContent = typeof node.content === 'string' ? normalizeText(node.content)?.toLowerCase() : undefined;
        if (!containsText(name, filter.textNeedle) && !containsText(inlineContent, filter.textNeedle)) {
            return false;
        }
    }

    if (filter.interactiveOnly && !isInteractiveNode(node)) {
        return false;
    }

    return true;
};

const containsText = (source: string | undefined, needle: string): boolean => {
    if (!source) return false;
    return source.includes(needle);
};

export const buildSnapshotFromViewRoot = (
    root: UnifiedNode,
    cacheStats: SnapshotResult['cacheStats'],
): SnapshotResult => {
    const entityIndex = buildEntityIndex(root);
    const locatorIndex = buildLocatorIndex({
        root,
        entityIndex,
    });
    const external = buildExternalIndexes(root);
    return buildSnapshot({
        root,
        nodeIndex: external.nodeIndex,
        entityIndex,
        locatorIndex,
        bboxIndex: external.bboxIndex,
        attrIndex: external.attrIndex,
        contentStore: external.contentStore,
        cacheStats,
    });
};

const indexTree = (root: UnifiedNode): TreeIndex => {
    const byId = new Map<string, UnifiedNode>();
    const parentById = new Map<string, string | null>();
    let nodeCount = 0;

    const walk = (node: UnifiedNode, parentId: string | null) => {
        nodeCount += 1;
        byId.set(node.id, node);
        parentById.set(node.id, parentId);
        for (const child of node.children) {
            walk(child, node.id);
        }
    };

    walk(root, null);
    return {
        rootId: root.id,
        nodeCount,
        byId,
        parentById,
    };
};

const collectChangedNodeIds = (current: TreeIndex, baseline: TreeIndex): Set<string> => {
    const changed = new Set<string>();

    for (const [nodeId, currentNode] of current.byId.entries()) {
        const baselineNode = baseline.byId.get(nodeId);
        if (!baselineNode) {
            changed.add(nodeId);
            continue;
        }
        if (isNodeChanged(currentNode, baselineNode)) {
            changed.add(nodeId);
        }
    }

    for (const nodeId of baseline.byId.keys()) {
        if (current.byId.has(nodeId)) continue;
        const mappedAncestor = mapRemovedNodeToCurrentAncestor(nodeId, baseline, current);
        changed.add(mappedAncestor || current.rootId);
    }

    return changed;
};

const mapRemovedNodeToCurrentAncestor = (
    nodeId: string,
    baseline: TreeIndex,
    current: TreeIndex,
): string | null => {
    let cursor = baseline.parentById.get(nodeId) || null;
    while (cursor) {
        if (current.byId.has(cursor)) {
            return cursor;
        }
        cursor = baseline.parentById.get(cursor) || null;
    }
    return null;
};

const pickPopupLikeDiffRootId = (
    changedNodeIds: Set<string>,
    current: TreeIndex,
    baseline: TreeIndex,
): string | undefined => {
    const candidates: Array<{ id: string; priority: number; depth: number; span: number }> = [];

    for (const nodeId of changedNodeIds) {
        if (nodeId === current.rootId) continue;
        const node = current.byId.get(nodeId);
        if (!node) continue;
        const role = normalizeRole(node.role);
        if (!POPUP_LIKE_ROLES.has(role)) continue;

        candidates.push({
            id: nodeId,
            priority: baseline.byId.has(nodeId) ? 1 : 0,
            depth: computeNodeDepth(nodeId, current.parentById),
            span: countSubtreeNodes(node),
        });
    }

    if (candidates.length === 0) return undefined;
    candidates.sort((left, right) => {
        if (left.priority !== right.priority) return left.priority - right.priority;
        if (left.depth !== right.depth) return left.depth - right.depth;
        if (left.span !== right.span) return left.span - right.span;
        return left.id.localeCompare(right.id);
    });
    return candidates[0]?.id;
};

const computeNodeDepth = (nodeId: string, parentById: Map<string, string | null>): number => {
    let depth = 0;
    let cursor = parentById.get(nodeId) || null;
    while (cursor) {
        depth += 1;
        cursor = parentById.get(cursor) || null;
    }
    return depth;
};

const isNodeChanged = (current: UnifiedNode, baseline: UnifiedNode): boolean => {
    if (normalizeRole(current.role) !== normalizeRole(baseline.role)) return true;
    if ((normalizeText(current.name) || '') !== (normalizeText(baseline.name) || '')) return true;
    if (readComparableContent(current) !== readComparableContent(baseline)) return true;
    if (readComparableTarget(current) !== readComparableTarget(baseline)) return true;
    if (!isSameChildIdSet(current.children, baseline.children)) return true;
    return false;
};

const readComparableContent = (node: UnifiedNode): string => {
    const runtimeContent = normalizeText(getNodeContent(node));
    if (runtimeContent) return runtimeContent;
    if (typeof node.content === 'string') {
        return normalizeText(node.content) || '';
    }
    return '';
};

const readComparableTarget = (node: UnifiedNode): string => {
    if (!node.target) return '';
    const ref = normalizeText(node.target.ref) || '';
    const kind = normalizeText(node.target.kind) || '';
    return `${kind}:${ref}`;
};

const isSameChildIdSet = (left: UnifiedNode[], right: UnifiedNode[]): boolean => {
    if (left.length !== right.length) {
        return false;
    }
    const leftIds = new Set(left.map((node) => node.id));
    if (leftIds.size !== right.length) {
        return false;
    }
    for (const node of right) {
        if (!leftIds.has(node.id)) {
            return false;
        }
    }
    return true;
};

const computeLowestCommonAncestorId = (nodeIds: string[], index: TreeIndex): string => {
    const paths = nodeIds
        .map((nodeId) => buildPathToRoot(nodeId, index.parentById))
        .filter((path) => path.length > 0);

    if (paths.length === 0) {
        return index.rootId;
    }

    let lca = index.rootId;
    for (let cursor = 0; cursor < paths[0].length; cursor += 1) {
        const candidate = paths[0][cursor];
        if (!candidate) break;
        if (paths.every((path) => path[cursor] === candidate)) {
            lca = candidate;
            continue;
        }
        break;
    }
    return lca;
};

const buildPathToRoot = (nodeId: string, parentById: Map<string, string | null>): string[] => {
    const reversed: string[] = [];
    let cursor: string | null = nodeId;
    while (cursor) {
        reversed.push(cursor);
        cursor = parentById.get(cursor) || null;
    }
    return reversed.reverse();
};

const isTooBroadDiff = (
    totalNodeCount: number,
    diffNodeCount: number,
    changedNodeCount: number,
    lcaIsRoot: boolean,
): boolean => {
    if (changedNodeCount >= DIFF_CHANGED_NODE_BROAD_LIMIT) {
        return true;
    }
    if (diffNodeCount >= DIFF_ABSOLUTE_NODE_BROAD_LIMIT) {
        return true;
    }
    if (totalNodeCount < DIFF_BROAD_MIN_TOTAL_NODES) {
        return false;
    }

    const coverage = diffNodeCount / Math.max(totalNodeCount, 1);
    if (coverage >= DIFF_COVERAGE_BROAD_LIMIT) {
        return true;
    }
    if (lcaIsRoot && coverage >= DIFF_ROOT_COVERAGE_BROAD_LIMIT) {
        return true;
    }

    return false;
};

const countSubtreeNodes = (root: UnifiedNode): number => {
    let count = 1;
    for (const child of root.children) {
        count += countSubtreeNodes(child);
    }
    return count;
};

const normalizeRoleList = (role: string | string[] | undefined): string[] => {
    if (role === undefined) return [];
    const values = Array.isArray(role) ? role : [role];
    const normalized = values
        .map((item) => normalizeRole(item))
        .filter((item) => item.length > 0);
    return [...new Set(normalized)].sort();
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();

const resolveMaxViewNodeCount = (maxViewNodes: number | undefined): number => {
    if (typeof maxViewNodes === 'number' && Number.isFinite(maxViewNodes) && maxViewNodes > 0) {
        return Math.max(1, Math.floor(maxViewNodes));
    }

    const raw = process.env.RPA_SNAPSHOT_VIEW_MAX_NODES;
    if (raw) {
        const fromEnv = Number(raw);
        if (Number.isFinite(fromEnv) && fromEnv > 0) {
            return Math.max(1, Math.floor(fromEnv));
        }
    }

    return DEFAULT_MAX_VIEW_NODE_COUNT;
};
