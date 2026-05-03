import type { ExecutionBinding } from '../../../runtime/execution/bindings';
import type { ResolveHint, ResolvePolicy, StepResolve, StepResult } from '../types';
import type { SnapshotResult } from '../executors/snapshot/core/types';
import { getNodeAttr, getNodeSemanticHints, normalizeText } from '../executors/snapshot/core/runtime_store';

export type ResolveTargetInput = {
    nodeId?: string;
    selector?: string;
    resolve?: StepResolve;
};

export type ResolvedTarget = {
    selector: string;
    resolution: {
        source: 'nodeId' | 'selector' | 'resolve';
        path: string;
        appliedPolicy?: string[];
    };
};

type ResolveResult = { ok: true; target: ResolvedTarget } | { ok: false; error: StepResult['error'] };

export const resolveTarget = async (binding: ExecutionBinding, input: ResolveTargetInput): Promise<ResolveResult> => {
    const { nodeId, selector, resolve } = input;
    const hint = resolve?.hint;
    const policy = resolve?.policy;
    if (!nodeId && !selector && !resolve) {
        return { ok: false, error: { code: 'ERR_INTERNAL', message: 'missing target input' } };
    }

    if (selector) {
        return {
            ok: true,
            target: {
                selector: withVisibilityConstraint(withHintScope(binding, hint, selector, policy), policy?.requireVisible),
                resolution: {
                    source: 'selector',
                    path: 'input.selector',
                    appliedPolicy: collectAppliedPolicy(policy, Boolean(hint?.locator?.scope?.id)),
                },
            },
        };
    }

    if (nodeId) {
        const resolved = resolveBySnapshotNodeId(binding, nodeId, hint, policy);
        if (resolved.ok) {
            return {
                ok: true,
                target: {
                    selector: resolved.selector,
                    resolution: {
                        source: 'nodeId',
                        path: resolved.path,
                        appliedPolicy: collectAppliedPolicy(policy, Boolean(hint?.locator?.scope?.id)),
                    },
                },
            };
        }
        if (!resolve) {
            return { ok: false, error: resolved.error };
        }
    }

    const byResolve = resolveByHint(binding, hint!, policy || {});
    if (byResolve.ok) {
        return {
            ok: true,
            target: {
                selector: byResolve.selector,
                resolution: {
                    source: 'resolve',
                    path: byResolve.path,
                    appliedPolicy: collectAppliedPolicy(policy, Boolean(hint?.locator?.scope?.id)),
                },
            },
        };
    }

    return { ok: false, error: byResolve.error };
};

const resolveByHint = (
    binding: ExecutionBinding,
    hint: ResolveHint,
    policy: ResolvePolicy,
): { ok: true; selector: string; path: string } | { ok: false; error: StepResult['error'] } => {
    const preferDirect = policy.preferDirect === true;

    if (preferDirect) {
        const directFirst = resolveFromHintLocator(binding, hint, policy);
        if (directFirst) {return { ok: true, selector: directFirst, path: 'resolve.hint.locator.direct' };}
    }

    const byEntity = resolveByEntityHint(binding, hint, policy);
    if (byEntity) {return { ok: true, selector: byEntity, path: 'resolve.hint.entity' };}

    if (hint.target?.nodeId) {
        const byNode = resolveBySnapshotNodeId(binding, hint.target.nodeId, hint, policy);
        if (byNode.ok) {return { ok: true, selector: byNode.selector, path: 'resolve.hint.target.nodeId' };}
    }

    const byDom = resolveByDomFingerprint(binding, hint, policy);
    if (byDom) {return { ok: true, selector: byDom, path: 'resolve.hint.target.primaryDomId' };}

    const byLocator = resolveFromHintLocator(binding, hint, policy);
    if (byLocator) {return { ok: true, selector: byLocator, path: 'resolve.hint.locator.direct' };}

    const byRaw = resolveFromHintRaw(binding, hint, policy);
    if (byRaw) {return { ok: true, selector: byRaw, path: 'resolve.hint.raw' };}

    if (policy.allowFuzzy) {
        const byFuzzy = resolveByHintFuzzy(binding, hint, policy);
        if (byFuzzy) {return { ok: true, selector: byFuzzy, path: 'resolve.hint.fuzzy' };}
    }

    return {
        ok: false,
        error: {
            code: 'ERR_NOT_FOUND',
            message: 'target hint not resolvable to selector',
            details: {
                hasTargetNodeId: Boolean(hint.target?.nodeId),
                hasPrimaryDomId: Boolean(hint.target?.primaryDomId),
                hasLocatorDirect: Boolean(hint.locator?.direct?.query),
                hasRawSelector: Boolean(hint.raw?.selector),
                hasEntityHint: Boolean(hint.entity?.businessTag || hint.entity?.fieldKey || hint.entity?.actionIntent),
            },
        },
    };
};

const resolveByEntityHint = (binding: ExecutionBinding, hint: ResolveHint, policy: ResolvePolicy): string | undefined => {
    const entityHint = hint.entity;
    if (!entityHint) {return undefined;}

    const businessTag = normalizeTag(entityHint.businessTag);
    const fieldKey = normalizeTag(entityHint.fieldKey);
    const actionIntent = normalizeTag(entityHint.actionIntent);
    if (!businessTag && !fieldKey && !actionIntent) {return undefined;}

    const snapshot = getSnapshot(binding);
    if (!snapshot) {return undefined;}

    const parentById = buildNodeParentById(snapshot.root);
    const scopeNodeIds = businessTag
        ? collectEntityScopeNodeIds(snapshot, businessTag)
        : undefined;

    const matchedNodeIds: string[] = [];
    for (const [nodeId, node] of Object.entries(snapshot.nodeIndex)) {
        if (scopeNodeIds && scopeNodeIds.size > 0 && !isInAnyScope(nodeId, scopeNodeIds, parentById)) {
            continue;
        }

        const semantic = getNodeSemanticHints(node);
        const attr = snapshot.attrIndex[nodeId];
        const nodeFieldKey = normalizeTag(semantic?.fieldKey || attr.fieldKey);
        const nodeActionIntent = normalizeTag(semantic?.actionIntent || attr.actionIntent);

        if (fieldKey && fieldKey !== nodeFieldKey) {continue;}
        if (actionIntent && actionIntent !== nodeActionIntent) {continue;}

        matchedNodeIds.push(nodeId);
    }

    if (matchedNodeIds.length > 0) {
        const resolved = resolveBySnapshotNodeId(binding, matchedNodeIds[0], hint, policy);
        return resolved.ok ? resolved.selector : undefined;
    }

    if (scopeNodeIds && scopeNodeIds.size > 0) {
        const candidate = Array.from(scopeNodeIds).sort((left, right) => left.localeCompare(right))[0];
        if (candidate) {
            const resolved = resolveBySnapshotNodeId(binding, candidate, hint, policy);
            return resolved.ok ? resolved.selector : undefined;
        }
    }

    return undefined;
};

const collectEntityScopeNodeIds = (snapshot: SnapshotResult, businessTag: string): Set<string> => {
    const out = new Set<string>();
    const ruleOverlay = snapshot.ruleEntityOverlay || snapshot.businessEntityOverlay;
    for (const entity of Object.values(snapshot.entityIndex.entities)) {
        const overlayTag = normalizeTag(ruleOverlay?.byEntityId[entity.id]?.businessTag);
        const entityTag = normalizeTag(entity.businessTag);
        if (businessTag !== overlayTag && businessTag !== entityTag) {continue;}
        if (entity.type === 'region') {
            out.add(entity.nodeId);
            continue;
        }
        out.add(entity.containerId);
    }
    return out;
};

const buildNodeParentById = (root: SnapshotResult['root']): Map<string, string | null> => {
    const parentById = new Map<string, string | null>();
    const stack: Array<{ node: SnapshotResult['root']; parentId: string | null }> = [{ node: root, parentId: null }];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {break;}
        parentById.set(current.node.id, current.parentId);
        for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
            stack.push({ node: current.node.children[index], parentId: current.node.id });
        }
    }
    return parentById;
};

const isInAnyScope = (nodeId: string, scopeNodeIds: Set<string>, parentById: Map<string, string | null>): boolean => {
    let cursor: string | null = nodeId;
    while (cursor) {
        if (scopeNodeIds.has(cursor)) {return true;}
        cursor = parentById.get(cursor) || null;
    }
    return false;
};

const resolveBySnapshotNodeId = (
    binding: ExecutionBinding,
    nodeId: string,
    hint: ResolveHint | undefined,
    policy: ResolvePolicy | undefined,
): { ok: true; selector: string; path: string } | { ok: false; error: StepResult['error'] } => {
    const snapshot = getSnapshot(binding);
    if (!snapshot?.locatorIndex) {
        return {
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'snapshot cache missing, call browser.snapshot before targeting by nodeId',
                details: { nodeId },
            },
        };
    }

    const locator = snapshot.locatorIndex[nodeId];
    if (locator) {
        const direct = locator.direct;
        if (direct?.kind === 'css' && direct.query) {
            const scoped = applyScopeConstraint(snapshot, locator, direct.query, hint, policy);
            const path = direct.source === 'backend-path' ? 'input.nodeId.direct.backend-path' : 'input.nodeId.direct.css';
            return { ok: true, selector: withVisibilityConstraint(scoped, policy?.requireVisible), path };
        }

        if (direct?.fallback) {
            const scopedFallback = applyScopeConstraint(snapshot, locator, direct.fallback, hint, policy);
            return {
                ok: true,
                selector: withVisibilityConstraint(scopedFallback, policy?.requireVisible),
                path: 'input.nodeId.direct.fallback',
            };
        }
    }

    const structuralSelector = buildStructuralSelectorFallback(snapshot, nodeId);
    if (structuralSelector) {
        return {
            ok: true,
            selector: withVisibilityConstraint(withHintScope(binding, hint, structuralSelector, policy), policy?.requireVisible),
            path: 'input.nodeId.structural',
        };
    }

    return {
        ok: false,
        error: {
            code: 'ERR_NOT_FOUND',
            message: 'nodeId has no executable selector',
            details: { nodeId, locator },
        },
    };
};

const resolveByDomFingerprint = (binding: ExecutionBinding, hint: ResolveHint, policy: ResolvePolicy): string | undefined => {
    const snapshot = getSnapshot(binding);
    if (!snapshot || !hint.target) {return undefined;}

    const domIds = [hint.target.primaryDomId, ...(hint.target.sourceDomIds || [])].filter(Boolean) as string[];
    for (const domId of domIds) {
        const matchedNodeId = findNodeIdByDomId(snapshot, domId);
        if (!matchedNodeId) {continue;}
        const resolved = resolveBySnapshotNodeId(binding, matchedNodeId, hint, policy);
        if (resolved.ok) {return resolved.selector;}
    }

    if (!policy.allowIndexDrift) {return undefined;}
    const fuzzyNodeId = findNodeIdByFuzzyFingerprint(snapshot, hint);
    if (!fuzzyNodeId) {return undefined;}
    const fuzzy = resolveBySnapshotNodeId(binding, fuzzyNodeId, hint, policy);
    return fuzzy.ok ? fuzzy.selector : undefined;
};

const resolveByHintFuzzy = (binding: ExecutionBinding, hint: ResolveHint, policy: ResolvePolicy): string | undefined => {
    const snapshot = getSnapshot(binding);
    if (!snapshot || !hint.target) {return undefined;}
    const fuzzyNodeId = findNodeIdByFuzzyFingerprint(snapshot, hint);
    if (!fuzzyNodeId) {return undefined;}
    const resolved = resolveBySnapshotNodeId(binding, fuzzyNodeId, hint, policy);
    return resolved.ok ? resolved.selector : undefined;
};

const resolveFromHintLocator = (binding: ExecutionBinding, hint: ResolveHint, policy: ResolvePolicy): string | undefined => {
    const direct = hint.locator?.direct;
    if (!direct) {return undefined;}

    if (direct.kind === 'css' && direct.query) {
        return withVisibilityConstraint(withHintScope(binding, hint, direct.query, policy), policy.requireVisible);
    }

    if (direct.fallback) {
        return withVisibilityConstraint(withHintScope(binding, hint, direct.fallback, policy), policy.requireVisible);
    }

    return undefined;
};

const resolveFromHintRaw = (binding: ExecutionBinding, hint: ResolveHint, policy: ResolvePolicy): string | undefined => {
    if (hint.raw?.selector) {
        return withVisibilityConstraint(withHintScope(binding, hint, hint.raw.selector, policy), policy.requireVisible);
    }

    for (const candidate of hint.raw?.locatorCandidates || []) {
        if (candidate.kind === 'css' && candidate.selector) {
            return withVisibilityConstraint(withHintScope(binding, hint, candidate.selector, policy), policy.requireVisible);
        }
        if (candidate.kind === 'testid' && candidate.testId) {
            return withVisibilityConstraint(
                withHintScope(binding, hint, `[data-testid="${escapeCssText(candidate.testId)}"]`, policy),
                policy.requireVisible,
            );
        }
    }

    return undefined;
};

const getSnapshot = (binding: ExecutionBinding): SnapshotResult | undefined => {
    const cache = binding.traceCtx.cache as { latestSnapshot?: unknown };
    return cache.latestSnapshot as SnapshotResult | undefined;
};

const withHintScope = (binding: ExecutionBinding, hint: ResolveHint | undefined, selector: string, policy: ResolvePolicy | undefined): string => {
    if (!selector) {return selector;}
    if (!policy?.preferScoped) {return selector;}
    if (!hint?.locator?.scope?.id) {return selector;}

    const snapshot = getSnapshot(binding);
    if (!snapshot) {return selector;}

    const scopeNodeId = resolveScopeNodeId(snapshot, hint.locator.scope.id);
    if (!scopeNodeId) {return selector;}
    const scopeSelector = buildStructuralSelectorFallback(snapshot, scopeNodeId);
    if (!scopeSelector) {return selector;}

    const trimmed = selector.trim();
    if (!trimmed || trimmed.startsWith('xpath=') || trimmed.startsWith('text=')) {return selector;}
    if (isAbsoluteDomSelector(trimmed)) {return selector;}
    return `${scopeSelector} ${trimmed}`;
};

const applyScopeConstraint = (
    snapshot: SnapshotResult,
    locator: SnapshotResult['locatorIndex'][string],
    selector: string,
    hint: ResolveHint | undefined,
    policy: ResolvePolicy | undefined,
): string => {
    if (!selector) {return selector;}
    const preferScoped = policy?.preferScoped === true || locator.policy?.preferScopedSearch === true;
    if (!preferScoped) {return selector;}

    const scopeId = hint?.locator?.scope?.id || locator.scope?.id;
    if (!scopeId) {return selector;}

    const scopeNodeId = resolveScopeNodeId(snapshot, scopeId);
    if (!scopeNodeId) {return selector;}

    const scopeSelector = buildStructuralSelectorFallback(snapshot, scopeNodeId);
    if (!scopeSelector) {return selector;}

    const trimmed = selector.trim();
    if (!trimmed || trimmed.startsWith('xpath=') || trimmed.startsWith('text=')) {return selector;}
    if (isAbsoluteDomSelector(trimmed)) {return selector;}

    return `${scopeSelector} ${trimmed}`;
};

const resolveScopeNodeId = (snapshot: SnapshotResult, scopeId: string): string | undefined => {
    if (Object.prototype.hasOwnProperty.call(snapshot.nodeIndex, scopeId)) {return scopeId;}

    if (!Object.prototype.hasOwnProperty.call(snapshot.entityIndex.entities, scopeId)) {return undefined;}
    const entity = snapshot.entityIndex.entities[scopeId];
    if (entity.type === 'region') {return entity.nodeId;}
    return entity.containerId;
};

const findNodeIdByDomId = (snapshot: SnapshotResult, domId: string): string | undefined => {
    for (const [nodeId, node] of Object.entries(snapshot.nodeIndex)) {
        const backendDomId = (getNodeAttr(node, 'backendDOMNodeId') || '').trim();
        if (backendDomId && backendDomId === domId) {
            return nodeId;
        }
    }
    return undefined;
};

const findNodeIdByFuzzyFingerprint = (snapshot: SnapshotResult, hint: ResolveHint): string | undefined => {
    const expectedRole = normalizeTag(hint.target?.role);
    const expectedName = normalizeTag(hint.target?.name);
    const expectedTag = normalizeTag(hint.target?.tag);
    const expectedText = normalizeTag(hint.target?.text);

    for (const [nodeId, node] of Object.entries(snapshot.nodeIndex)) {
        const attrs = snapshot.attrIndex[nodeId] || {};
        const role = normalizeTag(node.role);
        const name = normalizeTag(node.name);
        const text = normalizeTag(typeof node.content === 'string' ? node.content : undefined);
        const tag = normalizeTag((attrs.tag || attrs.tagName || ''));

        if (expectedRole && role && expectedRole !== role) {continue;}
        if (expectedTag && tag && expectedTag !== tag) {continue;}
        if (expectedName && name && !name.includes(expectedName)) {continue;}
        if (expectedText && text && !text.includes(expectedText)) {continue;}
        return nodeId;
    }

    return undefined;
};

const collectAppliedPolicy = (policy: ResolvePolicy | undefined, hasScope: boolean): string[] | undefined => {
    if (!policy) {return undefined;}
    const applied: string[] = [];
    if (policy.preferDirect) {applied.push('preferDirect');}
    if (policy.preferScoped && hasScope) {applied.push('preferScoped');}
    if (policy.requireVisible) {applied.push('requireVisible');}
    if (policy.allowFuzzy) {applied.push('allowFuzzy');}
    if (policy.allowIndexDrift) {applied.push('allowIndexDrift');}
    return applied.length > 0 ? applied : undefined;
};

const buildStructuralSelectorFallback = (snapshot: SnapshotResult, nodeId: string): string | undefined => {
    const parentById = new Map<string, string | null>();
    buildParentById(snapshot.root, null, parentById);

    const startNodeId = snapshot.root.id;
    const chain = buildIdChain(parentById, startNodeId, nodeId);
    if (chain.length === 0) {return undefined;}

    const segments: string[] = [];
    for (const currentId of chain) {
        const node = snapshot.nodeIndex[currentId];
        if (!isStructuralDomNode(node)) {continue;}

        const stable = buildStableSegment(node);
        if (stable) {
            segments.push(stable);
            continue;
        }

        const parentId = parentById.get(currentId);
        if (!parentId) {continue;}
        const parent = snapshot.nodeIndex[parentId];

        const tag = resolveElementTag(node);
        if (tag) {
            const index = nthOfTypeIndex(parent.children, currentId, tag, snapshot);
            if (index) {
                segments.push(`${tag}:nth-of-type(${index})`);
                continue;
            }
        }
        const nthChild = nthChildIndex(parent.children, currentId);
        if (!nthChild) {continue;}
        segments.push(`*:nth-child(${nthChild})`);
    }

    if (segments.length === 0) {return undefined;}
    return trimLeadingWildcardSegments(segments).join(' > ');
};

const buildParentById = (node: SnapshotResult['root'], parentId: string | null, parentById: Map<string, string | null>) => {
    parentById.set(node.id, parentId);
    for (const child of node.children) {
        buildParentById(child, node.id, parentById);
    }
};

const buildIdChain = (parentById: Map<string, string | null>, startId: string, targetId: string): string[] => {
    if (startId === targetId) {return [targetId];}
    const reversed: string[] = [];
    let cursor = targetId;
    while (cursor) {
        reversed.push(cursor);
        if (cursor === startId) {break;}
        cursor = parentById.get(cursor) || '';
    }
    if (reversed[reversed.length - 1] !== startId) {return [];}
    return reversed.reverse();
};

const buildStableSegment = (node: SnapshotResult['root']): string | undefined => {
    const testId = getNodeAttr(node, 'data-testid') || getNodeAttr(node, 'data-test-id');
    if (testId) {return `[data-testid="${escapeCssText(testId)}"]`;}

    const id = getNodeAttr(node, 'id');
    if (id) {return `#${escapeCssIdentifier(id)}`;}

    const tag = resolveElementTag(node);
    if (!tag) {return undefined;}

    const name = getNodeAttr(node, 'name');
    if (name) {return `${tag}[name="${escapeCssText(name)}"]`;}

    const placeholder = getNodeAttr(node, 'placeholder');
    if (placeholder) {return `${tag}[placeholder="${escapeCssText(placeholder)}"]`;}

    return undefined;
};

const resolveElementTag = (node: SnapshotResult['root']): string | undefined => {
    const rawTag = normalizeTag(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (rawTag && !rawTag.startsWith('::')) {return rawTag;}

    const role = normalizeTag(node.role);
    if (role === 'body') {return 'body';}
    if (role === 'main') {return 'main';}
    if (role === 'banner') {return 'header';}
    if (role === 'contentinfo') {return 'footer';}
    if (role === 'complementary') {return 'aside';}
    if (role === 'region') {return 'section';}
    if (role === 'textbox') {return 'input';}
    if (role === 'button') {return 'button';}
    if (role === 'link') {return 'a';}
    if (role === 'select') {return 'select';}
    return undefined;
};

const nthOfTypeIndex = (
    siblings: SnapshotResult['root']['children'],
    currentId: string,
    tag: string,
    snapshot: SnapshotResult,
): number | undefined => {
    let index = 0;
    for (const sibling of siblings) {
        const siblingNode = snapshot.nodeIndex[sibling.id];
        if (resolveElementTag(siblingNode) !== tag) {continue;}
        index += 1;
        if (sibling.id === currentId) {return index;}
    }
    return undefined;
};

const nthChildIndex = (siblings: SnapshotResult['root']['children'], currentId: string): number | undefined => {
    const idx = siblings.findIndex((sibling) => sibling.id === currentId);
    if (idx < 0) {return undefined;}
    return idx + 1;
};

const trimLeadingWildcardSegments = (segments: string[]): string[] => {
    let start = 0;
    while (start < segments.length - 1 && /^\*:nth-child\(\d+\)$/.test(segments[start] || '')) {
        start += 1;
    }
    return segments.slice(start);
};

const isStructuralDomNode = (node: SnapshotResult['root']): boolean => {
    const tag = normalizeTag(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (tag && !tag.startsWith('::')) {return true;}
    const domId = (getNodeAttr(node, 'backendDOMNodeId') || '').trim();
    if (domId) {return true;}
    return normalizeTag(node.role) === 'body';
};

const withVisibilityConstraint = (selector: string, requireVisible: boolean | undefined): string => {
    if (!requireVisible) {return selector;}
    const trimmed = selector.trim();
    if (!trimmed || trimmed.includes(':visible')) {return selector;}
    return `${trimmed}:visible`;
};

const isAbsoluteDomSelector = (selector: string): boolean => {
    const normalized = selector.trim().toLowerCase();
    return normalized.startsWith('html') || normalized.startsWith('body') || normalized.startsWith(':root');
};

const normalizeTag = (value: string | undefined): string => normalizeText(value)?.toLowerCase() || '';
const escapeCssText = (value: string): string => value.replace(/"/g, '\\"');
const escapeCssIdentifier = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '\\$&');
