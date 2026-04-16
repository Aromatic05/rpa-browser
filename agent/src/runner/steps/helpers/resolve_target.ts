/**
 * 统一目标解析：优先 id/selector，新协议失败时再回退旧 a11y 兼容路径。
 */

import type { PageBinding } from '../../../runtime/runtime_registry';
import type { A11yHint, Target } from '../types';
import type { StepResult } from '../types';
import type { SnapshotResult } from '../executors/snapshot/core/types';
import { getNodeAttr } from '../executors/snapshot/core/runtime_store';
import { mapTraceError } from './target';

export type ResolvedLocatorTarget = {
    selector?: string;
    role?: string;
    name?: string;
    a11yNodeId?: string;
};

type ResolveResult = { ok: true; target: ResolvedLocatorTarget } | { ok: false; error: StepResult['error'] };

const buildNotFound = (hint?: A11yHint): StepResult['error'] => ({
    code: 'ERR_NOT_FOUND',
    message: 'target not found',
    details: hint ? { hint } : undefined,
});

const buildAmbiguous = (hint: A11yHint, candidates: unknown[]): StepResult['error'] => ({
    code: 'ERR_AMBIGUOUS',
    message: 'target ambiguous',
    details: { hint, candidates },
});

export const resolveTargetNodeId = async (
    binding: PageBinding,
    target: Target | undefined,
): Promise<ResolveResult> => {
    if (!target) {
        return { ok: false, error: { code: 'ERR_INTERNAL', message: 'missing target' } };
    }

    if (target.id) {
        const resolved = resolveBySnapshotNodeId(binding, target.id);
        if (!resolved.ok) return resolved;
        return { ok: true, target: resolved.target };
    }

    if (target.selector) {
        return { ok: true, target: { selector: target.selector } };
    }

    // 旧协议兼容：a11yNodeId/a11yHint 仅在 step 层兜底，不再作为 MCP 主协议。
    if (target.a11yNodeId) {
        const resolved = await binding.traceTools['trace.a11y.resolveByNodeId']({
            a11yNodeId: target.a11yNodeId,
        });
        if (!resolved.ok) return { ok: false, error: mapTraceError(resolved.error) };
        return { ok: true, target: { a11yNodeId: target.a11yNodeId } };
    }
    if (target.a11yHint) {
        const found = await binding.traceTools['trace.a11y.findByA11yHint']({
            hint: target.a11yHint,
        });
        if (!found.ok) return { ok: false, error: mapTraceError(found.error) };
        const candidates = found.data || [];
        if (candidates.length === 0) {
            return { ok: false, error: buildNotFound(target.a11yHint) };
        }
        if (candidates.length > 1) {
            return { ok: false, error: buildAmbiguous(target.a11yHint, candidates) };
        }
        return { ok: true, target: { a11yNodeId: candidates[0].nodeId } };
    }
    return { ok: false, error: buildNotFound() };
};

const resolveBySnapshotNodeId = (
    binding: PageBinding,
    nodeId: string,
): { ok: true; target: ResolvedLocatorTarget } | { ok: false; error: StepResult['error'] } => {
    const cache = binding.traceCtx.cache as { latestSnapshot?: unknown };
    const snapshot = cache.latestSnapshot as SnapshotResult | undefined;
    if (!snapshot || !snapshot.locatorIndex) {
        return {
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'snapshot cache missing, call browser.snapshot before targeting by id',
                details: { id: nodeId },
            },
        };
    }

    const locator = snapshot.locatorIndex[nodeId];
    if (!locator) {
        return {
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'node id not found in snapshot locator index',
                details: { id: nodeId },
            },
        };
    }

    const direct = locator.direct;
    if (direct?.kind === 'css' && direct.query) {
        const directSelector = applyScopeConstraint(snapshot, locator, direct.query);
        if (direct.source === 'backend-path') {
            return { ok: true, target: { selector: withVisibilityConstraint(directSelector, locator.policy?.requireVisible) } };
        }
        const structuralSelector = buildStructuralSelectorFallback(snapshot, nodeId);
        if (structuralSelector && shouldPreferStructuralSelector(direct.source, structuralSelector)) {
            return { ok: true, target: { selector: withVisibilityConstraint(structuralSelector, locator.policy?.requireVisible) } };
        }
        return { ok: true, target: { selector: withVisibilityConstraint(directSelector, locator.policy?.requireVisible) } };
    }
    if (direct?.kind === 'role' && direct.query) {
        const parsed = parseRoleQuery(direct.query);
        if (parsed) {
            return {
                ok: true,
                target: {
                    ...parsed,
                    selector: direct.fallback
                        ? withVisibilityConstraint(
                              applyScopeConstraint(snapshot, locator, direct.fallback),
                              locator.policy?.requireVisible,
                          )
                        : undefined,
                },
            };
        }
        if (direct.fallback) {
            return {
                ok: true,
                target: {
                    selector: withVisibilityConstraint(
                        applyScopeConstraint(snapshot, locator, direct.fallback),
                        locator.policy?.requireVisible,
                    ),
                },
            };
        }
    }
    if (direct?.fallback) {
        return {
            ok: true,
            target: {
                selector: withVisibilityConstraint(
                    applyScopeConstraint(snapshot, locator, direct.fallback),
                    locator.policy?.requireVisible,
                ),
            },
        };
    }
    const structuralSelector = buildStructuralSelectorFallback(snapshot, nodeId);
    if (structuralSelector) {
        return { ok: true, target: { selector: withVisibilityConstraint(structuralSelector, locator.policy?.requireVisible) } };
    }

    return {
        ok: false,
        error: {
            code: 'ERR_NOT_FOUND',
            message: 'node id has no executable direct locator',
            details: { id: nodeId, locator },
        },
    };
};

const shouldPreferStructuralSelector = (directSource: string | undefined, structuralSelector: string | undefined): boolean => {
    if (!structuralSelector) return false;
    return directSource === 'aria-label';
};

const applyScopeConstraint = (snapshot: SnapshotResult, locator: SnapshotResult['locatorIndex'][string], selector: string): string => {
    if (!selector) return selector;
    if (!locator.policy?.preferScopedSearch || !locator.scope?.id) return selector;

    const scopeNodeId = resolveScopeNodeId(snapshot, locator.scope.id);
    if (!scopeNodeId) return selector;

    const scopeSelector = buildStructuralSelectorFallback(snapshot, scopeNodeId);
    if (!scopeSelector) return selector;

    const trimmed = selector.trim();
    if (!trimmed || trimmed.startsWith('xpath=') || trimmed.startsWith('text=')) return selector;
    if (isAbsoluteDomSelector(trimmed)) return selector;

    return `${scopeSelector} ${trimmed}`;
};

const resolveScopeNodeId = (snapshot: SnapshotResult, scopeId: string): string | undefined => {
    if (snapshot.nodeIndex?.[scopeId]) return scopeId;

    const entity = snapshot.entityIndex?.entities?.[scopeId];
    if (!entity) return undefined;
    if (entity.type === 'region') return entity.nodeId;
    return entity.containerId;
};

const parseRoleQuery = (query: string): ResolvedLocatorTarget | null => {
    const index = query.indexOf(':');
    if (index <= 0) return null;
    const role = query.slice(0, index).trim();
    const name = query.slice(index + 1).trim();
    if (!role) return null;
    return { role, name: name || undefined };
};

const buildStructuralSelectorFallback = (
    snapshot: SnapshotResult,
    nodeId: string,
): string | undefined => {
    const targetNode = snapshot.nodeIndex?.[nodeId];
    if (!targetNode || !snapshot.root) return undefined;

    const parentById = new Map<string, string | null>();
    buildParentById(snapshot.root, null, parentById);

    const startNodeId = snapshot.root.id;

    const chain = buildIdChain(parentById, startNodeId, nodeId);
    if (chain.length === 0) return undefined;

    const segments: string[] = [];
    for (const currentId of chain) {
        const node = snapshot.nodeIndex[currentId];
        if (!node) continue;
        if (!isStructuralDomNode(node)) continue;

        const stable = buildStableSegment(node);
        if (stable) {
            segments.push(stable);
            continue;
        }

        const parentId = parentById.get(currentId);
        if (!parentId) continue;
        const parent = snapshot.nodeIndex[parentId];
        if (!parent) continue;

        const tag = resolveElementTag(node);
        if (tag) {
            const index = nthOfTypeIndex(parent.children, currentId, tag, snapshot);
            if (index) {
                segments.push(`${tag}:nth-of-type(${index})`);
                continue;
            }
        }
        const nthChild = nthChildIndex(parent.children, currentId);
        if (!nthChild) continue;
        segments.push(`*:nth-child(${nthChild})`);
    }

    if (segments.length === 0) return undefined;
    // Use strict parent-child chain so dynamic pages do not collapse different controls
    // into one broad descendant selector (a common source of ERR_AMBIGUOUS).
    return trimLeadingWildcardSegments(segments).join(' > ');
};

const buildParentById = (node: SnapshotResult['root'], parentId: string | null, parentById: Map<string, string | null>) => {
    parentById.set(node.id, parentId);
    for (const child of node.children) {
        buildParentById(child, node.id, parentById);
    }
};

const buildIdChain = (parentById: Map<string, string | null>, startId: string, targetId: string): string[] => {
    if (startId === targetId) return [targetId];
    const reversed: string[] = [];
    let cursor = targetId;
    while (cursor) {
        reversed.push(cursor);
        if (cursor === startId) break;
        cursor = parentById.get(cursor) || '';
    }
    if (reversed[reversed.length - 1] !== startId) return [];
    return reversed.reverse();
};

const buildStableSegment = (node: SnapshotResult['root']): string | undefined => {
    const testId = getNodeAttr(node, 'data-testid') || getNodeAttr(node, 'data-test-id');
    if (testId) return `[data-testid="${escapeCssText(testId)}"]`;

    const id = getNodeAttr(node, 'id');
    if (id) return `#${escapeCssIdentifier(id)}`;

    const tag = resolveElementTag(node);
    if (tag) {
        const name = getNodeAttr(node, 'name');
        if (name) return `${tag}[name="${escapeCssText(name)}"]`;

        const placeholder = getNodeAttr(node, 'placeholder');
        if (placeholder) return `${tag}[placeholder="${escapeCssText(placeholder)}"]`;
    }
    return undefined;
};

const resolveElementTag = (node: SnapshotResult['root']): string | undefined => {
    const rawTag = normalizeTag(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (rawTag && !rawTag.startsWith('::')) return rawTag;

    const role = normalizeTag(node.role);
    if (role === 'body') return 'body';
    if (role === 'main') return 'main';
    if (role === 'banner') return 'header';
    if (role === 'contentinfo') return 'footer';
    if (role === 'complementary') return 'aside';
    if (role === 'region') return 'section';
    if (role === 'textbox') return 'input';
    if (role === 'button') return 'button';
    if (role === 'link') return 'a';
    if (role === 'select') return 'select';
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
        if (!siblingNode) continue;
        if (resolveElementTag(siblingNode) !== tag) continue;
        index += 1;
        if (sibling.id === currentId) return index;
    }
    return undefined;
};

const nthChildIndex = (siblings: SnapshotResult['root']['children'], currentId: string): number | undefined => {
    const idx = siblings.findIndex((sibling) => sibling.id === currentId);
    if (idx < 0) return undefined;
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
    if (tag && !tag.startsWith('::')) return true;
    const domId = (getNodeAttr(node, 'backendDOMNodeId') || '').trim();
    if (domId) return true;
    const role = normalizeTag(node.role);
    return role === 'body';
};

const normalizeTag = (value: string | undefined): string => (value || '').trim().toLowerCase();
const escapeCssText = (value: string): string => value.replace(/"/g, '\\"');
const escapeCssIdentifier = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '\\$&');

const withVisibilityConstraint = (selector: string, requireVisible: boolean | undefined): string => {
    if (!requireVisible) return selector;
    const trimmed = selector.trim();
    if (!trimmed || trimmed.includes(':visible')) return selector;
    return `${trimmed}:visible`;
};

const isAbsoluteDomSelector = (selector: string): boolean => {
    const normalized = selector.trim().toLowerCase();
    return normalized.startsWith('html') || normalized.startsWith('body') || normalized.startsWith(':root');
};
