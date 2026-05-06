import type { ExecutionBinding } from '../../../runtime/execution/bindings';
import type { ResolveHint, ResolvePolicy, StepResolve, StepResult } from '../types';
import type { SnapshotResult } from '../executors/snapshot/core/types';
import { getNodeAttr, getNodeSemanticHints, normalizeText } from '../executors/snapshot/core/runtime_store';
import { isValidStepResolve } from '../resolve_utils';

export type ResolveTargetInput = {
    nodeId?: string;
    selector?: string;
    resolve?: StepResolve;
};

export type TargetCandidate = {
    selector: string;
    path: string;
    confidence: number;
    warnings: string[];
    source: string;
};

export type ResolveAuditAttempt = {
    path: string;
    selector: string;
    source: string;
    confidence: number;
    ok: boolean;
    stage: 'waitForVisible' | 'scrollIntoView' | 'action' | 'resolve';
    errorCode?: string;
    errorMessage?: string;
};

export type ResolvedTarget = {
    selector: string;
    candidates: TargetCandidate[];
    resolution: {
        source: 'nodeId' | 'selector' | 'resolve';
        path: string;
        appliedPolicy?: string[];
        audit: {
            stepId?: string;
            stepName?: string;
            confidence?: number;
            chosenPath?: string;
            attempts: ResolveAuditAttempt[];
            warnings: string[];
            finalSelector?: string;
            failedPath?: string;
            failedReason?: string;
        };
    };
};

type ResolveResult = { ok: true; target: ResolvedTarget } | { ok: false; error: StepResult['error'] };

type CandidateCollector = {
    push: (candidate: TargetCandidate) => void;
    list: () => TargetCandidate[];
};

export const resolveTarget = async (binding: ExecutionBinding, input: ResolveTargetInput): Promise<ResolveResult> => {
    const { nodeId, selector, resolve } = input;
    if (!nodeId && !selector && !resolve) {
        return { ok: false, error: { code: 'ERR_BAD_ARGS', message: 'missing target input' } };
    }

    const hasValidResolve = isValidStepResolve(resolve);
    const hint = resolve?.hint;
    const policy = resolve?.policy;
    const confidence = hint?.capture?.confidence ?? (hasValidResolve ? 0.6 : 0.4);
    const warnings = [...(hint?.capture?.warnings || [])];
    const collector = createCandidateCollector();

    if (nodeId) {
        addNodeIdCandidate(collector, binding, nodeId, hint, policy, confidence, warnings, 'input.nodeId', 'input');
    }

    if (hasValidResolve && hint) {
        const order = buildResolveOrder(confidence);
        for (const sourcePath of order) {
            if (sourcePath === 'resolve.hint.target.nodeId' && hint.target?.nodeId) {
                addNodeIdCandidate(collector, binding, hint.target.nodeId, hint, policy, confidence, warnings, sourcePath, 'resolve');
                continue;
            }
            if (sourcePath === 'resolve.hint.entity') {
                const byEntity = resolveByEntityHint(binding, hint, policy || {});
                if (byEntity) {
                    collector.push({ selector: byEntity, path: sourcePath, confidence, warnings, source: 'resolve.entity' });
                }
                continue;
            }
            if (sourcePath === 'resolve.hint.locator.direct.query') {
                const query = hint.locator?.direct?.query;
                if (query) {
                    collector.push({
                        selector: withVisibilityConstraint(withHintScope(binding, hint, query, policy), policy?.requireVisible),
                        path: sourcePath,
                        confidence,
                        warnings,
                        source: 'resolve.direct.query',
                    });
                }
                continue;
            }
            if (sourcePath === 'resolve.hint.locator.direct.fallback') {
                const fallback = hint.locator?.direct?.fallback;
                if (fallback) {
                    collector.push({
                        selector: withVisibilityConstraint(withHintScope(binding, hint, fallback, policy), policy?.requireVisible),
                        path: sourcePath,
                        confidence,
                        warnings,
                        source: 'resolve.direct.fallback',
                    });
                }
                continue;
            }
            if (sourcePath === 'resolve.hint.target.domId') {
                for (const candidate of buildDomIdCandidates(binding, hint, policy || {}, confidence, warnings)) {
                    collector.push(candidate);
                }
                continue;
            }
            if (sourcePath === 'resolve.hint.target.semantic') {
                for (const candidate of buildTargetSemanticCandidates(binding, hint, policy || {}, confidence, warnings)) {
                    collector.push(candidate);
                }
                continue;
            }
            if (sourcePath === 'resolve.hint.raw.css' || sourcePath === 'resolve.hint.raw.testid' || sourcePath === 'resolve.hint.raw.role_name' || sourcePath === 'resolve.hint.raw.text' || sourcePath === 'resolve.hint.raw.placeholder') {
                for (const candidate of buildRawLocatorCandidates(binding, hint, policy || {}, confidence, warnings, sourcePath)) {
                    collector.push(candidate);
                }
                continue;
            }
            if (sourcePath === 'resolve.hint.raw.selector') {
                const rawSelector = hint.raw?.selector;
                if (rawSelector) {
                    collector.push({
                        selector: withVisibilityConstraint(withHintScope(binding, hint, rawSelector, policy), policy?.requireVisible),
                        path: sourcePath,
                        confidence,
                        warnings,
                        source: 'resolve.raw.selector',
                    });
                }
                continue;
            }
            if (sourcePath === 'resolve.hint.fuzzy' && policy?.allowFuzzy) {
                const byFuzzy = resolveByHintFuzzy(binding, hint, policy || {});
                if (byFuzzy) {
                    collector.push({ selector: byFuzzy, path: sourcePath, confidence, warnings, source: 'resolve.fuzzy' });
                }
            }
        }
    }

    if (selector) {
        collector.push({
            selector: withVisibilityConstraint(withHintScope(binding, hint, selector, policy), policy?.requireVisible),
            path: 'input.selector',
            confidence: hasValidResolve ? Math.min(0.4, confidence) : 0.9,
            warnings,
            source: 'input.selector',
        });
    }

    const candidates = collector.list();
    if (candidates.length === 0) {
        return {
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'target hint not resolvable to selector',
                details: {
                    confidence,
                    warnings,
                    hasNodeId: Boolean(nodeId),
                    hasSelector: Boolean(selector),
                    hasResolve: hasValidResolve,
                },
            },
        };
    }

    const first = candidates[0];
    return {
        ok: true,
        target: {
            selector: first.selector,
            candidates,
            resolution: {
                source: hasValidResolve ? 'resolve' : (nodeId ? 'nodeId' : 'selector'),
                path: first.path,
                appliedPolicy: collectAppliedPolicy(policy, Boolean(hint?.locator?.scope?.id)),
                audit: {
                    confidence,
                    chosenPath: first.path,
                    attempts: [],
                    warnings,
                    finalSelector: first.selector,
                },
            },
        },
    };
};

const createCandidateCollector = (): CandidateCollector => {
    const seen = new Set<string>();
    const out: TargetCandidate[] = [];
    return {
        push: (candidate) => {
            const selector = candidate.selector.trim();
            if (!selector) {return;}
            const key = selector;
            if (seen.has(key)) {return;}
            seen.add(key);
            out.push({ ...candidate, selector });
        },
        list: () => out,
    };
};

const addNodeIdCandidate = (
    collector: CandidateCollector,
    binding: ExecutionBinding,
    nodeId: string,
    hint: ResolveHint | undefined,
    policy: ResolvePolicy | undefined,
    confidence: number,
    warnings: string[],
    path: string,
    sourcePrefix: 'input' | 'resolve',
) => {
    const resolved = resolveBySnapshotNodeId(binding, nodeId, hint, policy);
    if (!resolved.ok) {return;}
    collector.push({
        selector: resolved.selector,
        path,
        confidence,
        warnings,
        source: `${sourcePrefix}.nodeId`,
    });
};

const buildResolveOrder = (confidence: number): string[] => {
    if (confidence >= 0.8) {
        return [
            'resolve.hint.target.nodeId',
            'resolve.hint.entity',
            'resolve.hint.locator.direct.query',
            'resolve.hint.locator.direct.fallback',
            'resolve.hint.target.domId',
            'resolve.hint.target.semantic',
            'resolve.hint.raw.role_name',
            'resolve.hint.raw.testid',
            'resolve.hint.raw.text',
            'resolve.hint.raw.css',
            'resolve.hint.raw.selector',
            'resolve.hint.fuzzy',
        ];
    }
    if (confidence >= 0.55) {
        return [
            'resolve.hint.target.nodeId',
            'resolve.hint.entity',
            'resolve.hint.raw.role_name',
            'resolve.hint.raw.testid',
            'resolve.hint.locator.direct.query',
            'resolve.hint.locator.direct.fallback',
            'resolve.hint.target.domId',
            'resolve.hint.target.semantic',
            'resolve.hint.raw.text',
            'resolve.hint.raw.css',
            'resolve.hint.raw.selector',
            'resolve.hint.fuzzy',
        ];
    }
    return [
        'resolve.hint.target.nodeId',
        'resolve.hint.entity',
        'resolve.hint.raw.role_name',
        'resolve.hint.raw.testid',
        'resolve.hint.raw.text',
        'resolve.hint.raw.placeholder',
            'resolve.hint.locator.direct.fallback',
            'resolve.hint.target.domId',
            'resolve.hint.target.semantic',
            'resolve.hint.fuzzy',
            'resolve.hint.raw.selector',
            'resolve.hint.raw.css',
            'resolve.hint.locator.direct.query',
    ];
};

const buildDomIdCandidates = (
    binding: ExecutionBinding,
    hint: ResolveHint,
    policy: ResolvePolicy,
    confidence: number,
    warnings: string[],
): TargetCandidate[] => {
    const snapshot = getSnapshot(binding);
    if (!snapshot || !hint.target) {return [];}
    const domIds = [hint.target.primaryDomId, ...(hint.target.sourceDomIds || [])].filter(Boolean) as string[];
    const out: TargetCandidate[] = [];
    for (const domId of domIds) {
        const matchedNodeId = findNodeIdByDomId(snapshot, domId);
        if (!matchedNodeId) {continue;}
        const resolved = resolveBySnapshotNodeId(binding, matchedNodeId, hint, policy);
        if (!resolved.ok) {continue;}
        out.push({
            selector: resolved.selector,
            path: 'resolve.hint.target.domId',
            confidence,
            warnings,
            source: 'resolve.domId',
        });
    }
    return out;
};

const buildRawLocatorCandidates = (
    binding: ExecutionBinding,
    hint: ResolveHint,
    policy: ResolvePolicy,
    confidence: number,
    warnings: string[],
    targetPath: string,
): TargetCandidate[] => {
    const out: TargetCandidate[] = [];
    for (const candidate of hint.raw?.locatorCandidates || []) {
        if (targetPath === 'resolve.hint.raw.css' && candidate.kind === 'css' && candidate.selector) {
            out.push({
                selector: withVisibilityConstraint(withHintScope(binding, hint, candidate.selector, policy), policy.requireVisible),
                path: targetPath,
                confidence,
                warnings,
                source: 'resolve.raw.css',
            });
        }
        if (targetPath === 'resolve.hint.raw.testid' && candidate.kind === 'testid' && candidate.testId) {
            out.push({
                selector: withVisibilityConstraint(withHintScope(binding, hint, `[data-testid="${escapeCssText(candidate.testId)}"]`, policy), policy.requireVisible),
                path: targetPath,
                confidence,
                warnings,
                source: 'resolve.raw.testid',
            });
        }
        if (targetPath === 'resolve.hint.raw.placeholder' && candidate.kind === 'placeholder' && candidate.text) {
            out.push({
                selector: withVisibilityConstraint(withHintScope(binding, hint, `[placeholder="${escapeCssText(candidate.text)}"]`, policy), policy.requireVisible),
                path: targetPath,
                confidence,
                warnings,
                source: 'resolve.raw.placeholder',
            });
        }
        if (targetPath === 'resolve.hint.raw.role_name' && candidate.kind === 'role') {
            out.push(...buildNodeCandidatesFromRoleName(binding, hint, policy, confidence, warnings, candidate.role, candidate.name, Boolean(candidate.exact)));
        }
        if (targetPath === 'resolve.hint.raw.text' && (candidate.kind === 'text' || candidate.kind === 'label') && candidate.text) {
            out.push(...buildNodeCandidatesFromText(binding, hint, policy, confidence, warnings, candidate.text, Boolean(candidate.exact)));
        }
    }
    return out;
};

const buildTargetSemanticCandidates = (
    binding: ExecutionBinding,
    hint: ResolveHint,
    policy: ResolvePolicy,
    confidence: number,
    warnings: string[],
): TargetCandidate[] => {
    const snapshot = getSnapshot(binding);
    if (!snapshot || !hint.target) {return [];}
    const targetRole = normalizeTag(hint.target.role);
    const targetName = normalizeTag(hint.target.name);
    const targetText = normalizeTag(hint.target.text);
    const targetTag = normalizeTag(hint.target.tag);
    if (!targetRole && !targetName && !targetText && !targetTag) {return [];}

    const out: TargetCandidate[] = [];
    for (const [nodeId, node] of Object.entries(snapshot.nodeIndex)) {
        const attrs = snapshot.attrIndex[nodeId] || {};
        const role = normalizeTag(node.role);
        const name = normalizeTag(node.name);
        const text = normalizeTag(normalizeNodeText(snapshot, nodeId));
        const tag = normalizeTag((attrs.tag || attrs.tagName || ''));
        if (targetRole && role && targetRole !== role) {continue;}
        if (targetTag && tag && targetTag !== tag) {continue;}
        if (targetName && name && !name.includes(targetName)) {continue;}
        if (targetText && text && !text.includes(targetText)) {continue;}
        const resolved = resolveBySnapshotNodeId(binding, nodeId, hint, policy);
        if (!resolved.ok) {continue;}
        out.push({
            selector: resolved.selector,
            path: 'resolve.hint.target.semantic',
            confidence,
            warnings,
            source: 'resolve.target.semantic',
        });
    }
    return out;
};

const buildNodeCandidatesFromRoleName = (
    binding: ExecutionBinding,
    hint: ResolveHint,
    policy: ResolvePolicy,
    confidence: number,
    warnings: string[],
    roleValue?: string,
    nameValue?: string,
    exact?: boolean,
): TargetCandidate[] => {
    const snapshot = getSnapshot(binding);
    if (!snapshot) {return [];}
    const role = normalizeTag(roleValue);
    const name = normalizeTag(nameValue);
    if (!role && !name) {return [];}

    const out: TargetCandidate[] = [];
    const scopeNodeId = hint.locator?.scope?.id ? resolveScopeNodeId(snapshot, hint.locator.scope.id) : undefined;
    const parentById = scopeNodeId ? buildNodeParentById(snapshot.root) : undefined;
    for (const [nodeId, node] of Object.entries(snapshot.nodeIndex)) {
        if (scopeNodeId && parentById && !isInAnyScope(nodeId, new Set([scopeNodeId]), parentById)) {continue;}
        const nodeRole = normalizeTag(node.role);
        const nodeName = normalizeTag(node.name || normalizeNodeText(snapshot, nodeId));
        if (role && nodeRole !== role) {continue;}
        if (name && (exact ? nodeName !== name : !nodeName.includes(name))) {continue;}
        const resolved = resolveBySnapshotNodeId(binding, nodeId, hint, policy);
        if (!resolved.ok) {continue;}
        out.push({
            selector: resolved.selector,
            path: 'resolve.hint.raw.role_name',
            confidence,
            warnings,
            source: 'resolve.raw.role_name',
        });
    }
    return out;
};

const buildNodeCandidatesFromText = (
    binding: ExecutionBinding,
    hint: ResolveHint,
    policy: ResolvePolicy,
    confidence: number,
    warnings: string[],
    textValue: string,
    exact: boolean,
): TargetCandidate[] => {
    const snapshot = getSnapshot(binding);
    if (!snapshot) {return [];}
    const text = normalizeTag(textValue);
    if (!text) {return [];}
    const out: TargetCandidate[] = [];
    const scopeNodeId = hint.locator?.scope?.id ? resolveScopeNodeId(snapshot, hint.locator.scope.id) : undefined;
    const parentById = scopeNodeId ? buildNodeParentById(snapshot.root) : undefined;
    for (const [nodeId] of Object.entries(snapshot.nodeIndex)) {
        if (scopeNodeId && parentById && !isInAnyScope(nodeId, new Set([scopeNodeId]), parentById)) {continue;}
        const nodeText = normalizeTag(normalizeNodeText(snapshot, nodeId));
        if (!nodeText) {continue;}
        if (exact ? nodeText !== text : !nodeText.includes(text)) {continue;}
        const resolved = resolveBySnapshotNodeId(binding, nodeId, hint, policy);
        if (!resolved.ok) {continue;}
        out.push({
            selector: resolved.selector,
            path: 'resolve.hint.raw.text',
            confidence,
            warnings,
            source: 'resolve.raw.text',
        });
    }
    return out;
};

const normalizeNodeText = (snapshot: SnapshotResult, nodeId: string): string => {
    const node = snapshot.nodeIndex[nodeId];
    if (!node) {return '';}
    if (typeof node.content === 'string') {return node.content;}
    if (node.content && typeof node.content === 'object' && node.content.ref) {
        return snapshot.contentStore[node.content.ref] || '';
    }
    return node.name || '';
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
        const nodeFieldKey = normalizeTag(semantic?.fieldKey || attr?.fieldKey);
        const nodeActionIntent = normalizeTag(semantic?.actionIntent || attr?.actionIntent);

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

const resolveByHintFuzzy = (binding: ExecutionBinding, hint: ResolveHint, policy: ResolvePolicy): string | undefined => {
    const snapshot = getSnapshot(binding);
    if (!snapshot || !hint.target) {return undefined;}
    const fuzzyNodeId = findNodeIdByFuzzyFingerprint(snapshot, hint);
    if (!fuzzyNodeId) {return undefined;}
    const resolved = resolveBySnapshotNodeId(binding, fuzzyNodeId, hint, policy);
    return resolved.ok ? resolved.selector : undefined;
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
